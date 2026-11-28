//! Local IPC and Remote TLS 1.3 transport listeners for `ControlHub`.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinSet;
use uuid::Uuid;

use hypercom_protocol::{
    build_tls_acceptor, read_frame, validate_remote_endpoint, write_frame, Authority, BoxedStream,
    ControlCommand, HostError, LocalListener, Peer, RemoteStatusDto, ReplyEnvelope, CONTROL_ALPN,
    PROTOCOL_VERSION,
};

use super::{Actor, ControlHub, RemoteServerHandle};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

struct ClientCountGuard(Arc<AtomicUsize>);

impl Drop for ClientCountGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

struct LocalClientCountGuard<'a>(&'a ControlHub);

impl Drop for LocalClientCountGuard<'_> {
    fn drop(&mut self) {
        self.0.local_clients.fetch_sub(1, Ordering::AcqRel);
    }
}

impl ControlHub {
    pub fn start_local_server(self: &Arc<Self>) {
        let hub = Arc::clone(self);
        let mut shutdown_rx = self.shutdown_tx.subscribe();
        tauri::async_runtime::spawn(async move {
            let mut listener = match LocalListener::bind(&hub.endpoint_name) {
                Ok(listener) => listener,
                Err(err) => {
                    log::warn!(
                        "Local control IPC listener '{}' failed to bind ({}); continuing without local IPC",
                        hub.endpoint_name,
                        err
                    );
                    hub.local_running.store(false, Ordering::Release);
                    return;
                }
            };
            hub.local_running.store(true, Ordering::Release);
            log::info!("Local control IPC listening on '{}'", hub.endpoint_name);

            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        match accepted {
                            Ok(Some(stream)) => {
                                let conn_hub = Arc::clone(&hub);
                                tauri::async_runtime::spawn(async move {
                                    conn_hub.serve_local_connection(stream).await;
                                });
                            }
                            Ok(None) => {}
                            Err(err) => {
                                log::warn!("Local control IPC accept error: {err}");
                                tokio::time::sleep(Duration::from_millis(50)).await;
                            }
                        }
                    }
                    _ = shutdown_rx.changed() => {
                        if *shutdown_rx.borrow() {
                            break;
                        }
                    }
                }
            }
            hub.local_running.store(false, Ordering::Release);
        });
    }

    async fn serve_local_connection(self: Arc<Self>, mut stream: BoxedStream) {
        self.local_clients.fetch_add(1, Ordering::AcqRel);
        let _count_guard = LocalClientCountGuard(&self);
        let conn_owner = format!("ipc:{}", Uuid::new_v4());
        let mut shutdown_rx = self.shutdown_tx.subscribe();

        loop {
            let frame_bytes = tokio::select! {
                res = read_frame(&mut stream) => match res {
                    Ok(bytes) => bytes,
                    Err(_) => break,
                },
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        break;
                    }
                    continue;
                }
            };

            let reply = match serde_json::from_slice::<ControlCommand>(&frame_bytes) {
                Ok(cmd) => {
                    let actor = Actor::Local {
                        conn_owner: conn_owner.clone(),
                    };
                    ReplyEnvelope::from(self.dispatch_command(cmd, actor).await)
                }
                Err(err) => ReplyEnvelope::err(HostError::new(
                    "invalid_request",
                    format!("invalid control command: {err}"),
                )),
            };

            let reply_bytes = match serde_json::to_vec(&reply) {
                Ok(bytes) => bytes,
                Err(err) => {
                    log::error!("Failed to serialize local control reply: {err}");
                    break;
                }
            };
            if write_frame(&mut stream, &reply_bytes).await.is_err() {
                break;
            }
        }

        self.lease_registry
            .release_by_owner(Some(&self.event_hub), &conn_owner)
            .await;
        self.release_remote_leases_by_owner(&conn_owner).await;
    }

    pub async fn start_remote(
        self: &Arc<Self>,
        listen: String,
        advertise: Option<String>,
    ) -> Result<RemoteStatusDto, HostError> {
        let listen_trimmed = listen.trim().to_string();
        let requested_listen: SocketAddr = listen_trimmed.parse().map_err(|_| {
            HostError::new(
                "invalid_request",
                "listen address must be a valid IP:port (for example 127.0.0.1:8443 or 0.0.0.0:8443)",
            )
        })?;

        {
            let guard = self.remote_state.lock().await;
            if guard.is_some() {
                return Err(HostError::new(
                    "host_busy",
                    "remote TLS host is already running; stop it before restarting",
                ));
            }
        }

        let listener = TcpListener::bind(requested_listen).await.map_err(|err| {
            HostError::new(
                "host_unavailable",
                format!("failed to bind remote TLS listener on {requested_listen}: {err}"),
            )
        })?;
        let bound_addr = listener.local_addr().map_err(|err| {
            HostError::new(
                "host_unavailable",
                format!("failed to read bound remote listener address: {err}"),
            )
        })?;

        let advertise_addr = resolve_advertise_addr(bound_addr, advertise)?;
        validate_remote_endpoint(&advertise_addr)?;

        let authority = self
            .get_or_open_authority(Some(advertise_addr.clone()))
            .await?;
        let acceptor = build_tls_acceptor(&authority).map_err(|err| {
            HostError::new(
                "host_unavailable",
                format!("failed to build TLS 1.3 acceptor: {err}"),
            )
        })?;

        let status = RemoteStatusDto {
            enabled: true,
            endpoint: advertise_addr.clone(),
            server_id: authority.server_id().to_string(),
            certificate_sha256: authority.certificate_sha256().to_string(),
        };

        let (stop_tx, mut stop_rx) = watch::channel(false);
        let remote_clients = Arc::new(AtomicUsize::new(0));

        let hub = Arc::clone(self);
        let auth_clone = Arc::clone(&authority);
        let clients_clone = Arc::clone(&remote_clients);
        let mut shutdown_rx = self.shutdown_tx.subscribe();

        let task = tokio::spawn(async move {
            let mut conns = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        match accepted {
                            Ok((tcp, peer_addr)) => {
                                let _ = tcp.set_nodelay(true);
                                let conn_hub = Arc::clone(&hub);
                                let conn_auth = Arc::clone(&auth_clone);
                                let conn_acceptor = acceptor.clone();
                                let conn_clients = Arc::clone(&clients_clone);
                                let conn_stop = stop_rx.clone();
                                conns.spawn(async move {
                                    let Ok(Ok(tls)) = tokio::time::timeout(
                                        HANDSHAKE_TIMEOUT,
                                        conn_acceptor.accept(tcp),
                                    )
                                    .await
                                    else {
                                        return;
                                    };
                                    if tls.get_ref().1.alpn_protocol() != Some(CONTROL_ALPN) {
                                        return;
                                    }
                                    serve_remote_stream(
                                        conn_hub,
                                        conn_auth,
                                        tls,
                                        peer_addr,
                                        conn_clients,
                                        conn_stop,
                                    )
                                    .await;
                                });
                            }
                            Err(err) => {
                                log::warn!("Remote TLS accept error: {err}");
                                tokio::time::sleep(Duration::from_millis(50)).await;
                            }
                        }
                    }
                    Some(_) = conns.join_next(), if !conns.is_empty() => {}
                    _ = stop_rx.changed() => {
                        if *stop_rx.borrow() {
                            break;
                        }
                    }
                    _ = shutdown_rx.changed() => {
                        if *shutdown_rx.borrow() {
                            break;
                        }
                    }
                }
            }
            drop(listener);
            while conns.join_next().await.is_some() {}
        });

        let mut guard = self.remote_state.lock().await;
        if guard.is_some() {
            stop_tx.send_replace(true);
            let _ = task.await;
            return Err(HostError::new(
                "host_busy",
                "remote TLS host is already running",
            ));
        }
        *guard = Some(RemoteServerHandle {
            listen_addr: bound_addr.to_string(),
            advertise_addr,
            authority,
            remote_clients,
            stop_tx,
            task,
        });
        log::info!("Remote TLS 1.3 host listening on {}", status.endpoint);
        Ok(status)
    }

    pub async fn stop_remote(&self) -> Result<(), HostError> {
        let handle = {
            let mut guard = self.remote_state.lock().await;
            guard.take()
        };
        if let Some(handle) = handle {
            log::info!("Stopping remote TLS 1.3 host ({})", handle.listen_addr);
            handle.stop_tx.send_replace(true);
            let _ = handle.task.await;
        }
        Ok(())
    }
}

fn resolve_advertise_addr(
    bound: SocketAddr,
    advertise: Option<String>,
) -> Result<String, HostError> {
    if let Some(raw) = advertise {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let ip = if bound.ip().is_unspecified() {
        match bound {
            SocketAddr::V4(_) => IpAddr::V4(Ipv4Addr::LOCALHOST),
            SocketAddr::V6(_) => IpAddr::V6(Ipv6Addr::LOCALHOST),
        }
    } else {
        bound.ip()
    };
    Ok(SocketAddr::new(ip, bound.port()).to_string())
}

async fn serve_remote_stream<S: AsyncRead + AsyncWrite + Unpin>(
    hub: Arc<ControlHub>,
    authority: Arc<Authority>,
    mut tls: S,
    peer_addr: SocketAddr,
    clients: Arc<AtomicUsize>,
    mut stop_rx: watch::Receiver<bool>,
) {
    let first_frame = match tokio::time::timeout(HANDSHAKE_TIMEOUT, read_frame(&mut tls)).await {
        Ok(Ok(bytes)) => bytes,
        _ => return,
    };
    let first_cmd = match serde_json::from_slice::<ControlCommand>(&first_frame) {
        Ok(cmd) => cmd,
        Err(err) => {
            let _ = send_reply(
                &mut tls,
                &ReplyEnvelope::err(HostError::new(
                    "invalid_request",
                    format!("invalid remote handshake frame: {err}"),
                )),
            )
            .await;
            return;
        }
    };

    let peer: Arc<Peer> = match first_cmd {
        ControlCommand::Pair { server_id, code } => {
            let reply = if server_id != authority.server_id() {
                ReplyEnvelope::err(HostError::new(
                    "pin_mismatch",
                    "remote Host serverId does not match invitation",
                ))
            } else {
                match authority.pair(&code) {
                    Ok(profile) => match serde_json::to_value(profile) {
                        Ok(val) => ReplyEnvelope::ok(val),
                        Err(err) => ReplyEnvelope::err(HostError::new("host_unavailable", err)),
                    },
                    Err(err) => ReplyEnvelope::err(err),
                }
            };
            let _ = send_reply(&mut tls, &reply).await;
            return;
        }
        ControlCommand::Authenticate {
            server_id,
            client_id,
            token,
        } => {
            if server_id != authority.server_id() {
                let _ = send_reply(
                    &mut tls,
                    &ReplyEnvelope::err(HostError::new(
                        "pin_mismatch",
                        "remote Host serverId does not match profile",
                    )),
                )
                .await;
                return;
            }
            match authority.authenticate(&client_id, &token) {
                Ok(peer) => {
                    let reply = ReplyEnvelope::ok(json!({
                        "protocol": PROTOCOL_VERSION,
                        "hostId": hub.host_id(),
                        "serverId": authority.server_id(),
                        "clientId": peer.id(),
                        "features": {
                            "portLease": true,
                            "remoteTls": true,
                            "notes": true,
                            "pluginTools": true,
                            "artifacts": true,
                            "remotePluginViews": true,
                        }
                    }));
                    if send_reply(&mut tls, &reply).await.is_err() {
                        return;
                    }
                    peer
                }
                Err(err) => {
                    let _ = send_reply(&mut tls, &ReplyEnvelope::err(err)).await;
                    return;
                }
            }
        }
        _ => {
            let _ = send_reply(
                &mut tls,
                &ReplyEnvelope::err(HostError::new(
                    "unauthorized",
                    "first remote command must be pair or authenticate",
                )),
            )
            .await;
            return;
        }
    };

    clients.fetch_add(1, Ordering::AcqRel);
    let _client_guard = ClientCountGuard(clients);
    let conn_owner = format!("remote:{}:{}", peer.id(), Uuid::new_v4());
    let mut revoked_rx = peer.revoked();
    let mut shutdown_rx = hub.shutdown_tx.subscribe();
    log::info!(
        "Remote client '{}' ({}) authenticated from {}",
        peer.label(),
        peer.id(),
        peer_addr
    );

    loop {
        if peer.is_revoked() || *stop_rx.borrow() || *shutdown_rx.borrow() {
            break;
        }

        let frame_bytes = tokio::select! {
            res = read_frame(&mut tls) => match res {
                Ok(bytes) => bytes,
                Err(_) => break,
            },
            _ = revoked_rx.changed() => {
                if *revoked_rx.borrow() {
                    log::info!("Terminating revoked remote client '{}' ({})", peer.label(), peer.id());
                    break;
                }
                continue;
            }
            _ = stop_rx.changed() => {
                if *stop_rx.borrow() {
                    break;
                }
                continue;
            }
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    break;
                }
                continue;
            }
        };

        if let Err(err) = peer.require_active() {
            let _ = send_reply(&mut tls, &ReplyEnvelope::err(err)).await;
            break;
        }

        let reply = match serde_json::from_slice::<ControlCommand>(&frame_bytes) {
            Ok(cmd) => {
                let actor = Actor::Remote {
                    peer: Arc::clone(&peer),
                    conn_owner: conn_owner.clone(),
                };
                ReplyEnvelope::from(hub.dispatch_remote_command(cmd, actor).await)
            }
            Err(err) => ReplyEnvelope::err(HostError::new(
                "invalid_request",
                format!("invalid control command: {err}"),
            )),
        };

        if send_reply(&mut tls, &reply).await.is_err() {
            break;
        }
    }

    hub.lease_registry
        .release_by_owner(Some(&hub.event_hub), &conn_owner)
        .await;
    let app = hub.app_handle();
    hub.plugin_bridge
        .close_remote_views_by_owner(app.as_ref(), &conn_owner);
}

async fn send_reply<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    reply: &ReplyEnvelope,
) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(reply).map_err(std::io::Error::other)?;
    write_frame(stream, &bytes).await
}

#[cfg(test)]
mod pure_tests {
    use super::resolve_advertise_addr;
    use std::net::SocketAddr;

    #[test]
    fn advertise_addr_substitutes_unspecified_bind_ip_or_keeps_override() {
        let v4_any: SocketAddr = "0.0.0.0:9443".parse().unwrap();
        assert_eq!(
            resolve_advertise_addr(v4_any, None).unwrap(),
            "127.0.0.1:9443"
        );
        let v6_any: SocketAddr = "[::]:9443".parse().unwrap();
        assert_eq!(resolve_advertise_addr(v6_any, None).unwrap(), "[::1]:9443");
        assert_eq!(
            resolve_advertise_addr(v4_any, Some("192.168.1.50:9443".into())).unwrap(),
            "192.168.1.50:9443"
        );
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;
    use crate::logger::LogManager;
    use crate::serial::{PortLeaseRegistry, SerialEventHub, SerialManager};
    use hypercom_protocol::{AsyncControlClient, RemoteRole};
    use std::sync::Mutex;

    fn test_hub_with_endpoint(endpoint: String) -> Arc<ControlHub> {
        let dir = std::env::temp_dir().join(format!("hc-srv-test-{}", Uuid::new_v4()));
        let mut hub = ControlHub::new(
            Arc::new(Mutex::new(SerialManager::new())),
            Arc::new(SerialEventHub::new()),
            Arc::new(PortLeaseRegistry::new()),
            Arc::new(LogManager::new()),
            dir,
        );
        hub.endpoint_name = endpoint;
        Arc::new(hub)
    }

    #[tokio::test]
    async fn local_ipc_server_roundtrips_commands_and_releases_connection_bound_loans_on_drop() {
        let endpoint = format!("hc-hub-{}", &Uuid::new_v4().simple().to_string()[..16]);
        let hub = test_hub_with_endpoint(endpoint.clone());
        hub.start_local_server();
        tokio::time::timeout(Duration::from_secs(2), async {
            while !hub.local_running.load(Ordering::Acquire) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("local IPC server must report running");
        assert!(hub.local_running.load(Ordering::Acquire));

        let mut client = AsyncControlClient::connect_local(&endpoint).await.unwrap();
        assert_eq!(client.host_id(), hub.host_id());

        let loan_val = client
            .call(ControlCommand::AcquireLoan {
                port_id: "COM42".into(),
                holder: "test-cli".into(),
                reason: Some("flash".into()),
                ttl_ms: Some(30_000),
                auto_reopen: Some(false),
                connection_bound: Some(true),
                expected_generation: None,
            })
            .await
            .unwrap();
        assert_eq!(loan_val["portId"], "COM42");
        assert!(hub.lease_registry.get_for_port("COM42").is_some());

        // Drop IPC client without calling ReleaseLoan; server must auto-release on disconnect.
        drop(client);
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if hub.lease_registry.get_for_port("COM42").is_none() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("connection-bound loan must be released on IPC drop");

        hub.shutdown().await;
        let _ = std::fs::remove_dir_all(hub.state_dir());
    }

    #[tokio::test]
    async fn remote_tls_host_pairs_enforces_scope_and_drops_revoked_peer() {
        let endpoint = format!("hc-rem-{}", &Uuid::new_v4().simple().to_string()[..16]);
        let hub = test_hub_with_endpoint(endpoint);
        let status = hub
            .start_remote("127.0.0.1:0".into(), None)
            .await
            .unwrap();
        assert!(status.enabled);

        let invite = hub
            .create_invite(
                "bench-client".into(),
                vec!["COM7".into()],
                RemoteRole::Write,
                false,
                false,
                Some(60_000),
            )
            .await
            .unwrap();
        let profile = AsyncControlClient::pair_remote(&invite).await.unwrap();
        let mut remote = AsyncControlClient::connect_remote(&profile).await.unwrap();
        assert_eq!(remote.host_id(), hub.host_id());

        // Write role cannot acquire loan or write to COM8
        let err = remote
            .call(ControlCommand::AddNote {
                port_id: "COM8".into(),
                text: "blocked".into(),
                source: None,
            })
            .await
            .unwrap_err();
        assert_eq!(err.code, "forbidden");

        let note = remote
            .call(ControlCommand::AddNote {
                port_id: "COM7".into(),
                text: "allowed".into(),
                source: None,
            })
            .await
            .unwrap();
        assert_eq!(note["text"], "allowed");

        // Revoking online peer closes its connection immediately.
        let revoked = hub.revoke_client(&profile.client_id).await.unwrap();
        assert!(revoked.revoked);

        tokio::time::sleep(Duration::from_millis(50)).await;
        let after_revoke = remote
            .call(ControlCommand::AddNote {
                port_id: "COM7".into(),
                text: "after-revoke".into(),
                source: None,
            })
            .await;
        assert!(after_revoke.is_err());

        hub.shutdown().await;
        let _ = std::fs::remove_dir_all(hub.state_dir());
    }
}
