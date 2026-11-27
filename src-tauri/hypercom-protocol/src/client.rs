//! Async and synchronous control clients for local IPC and pinned TLS 1.3
//! remote endpoints.

use crate::{
    auth::{RemoteInvite, RemoteProfile},
    ipc::{self, BoxedStream},
    protocol::{
        read_frame, write_frame, ControlCommand, HostError, ReplyEnvelope, MAX_EXPECT_MS,
        MAX_FRAME_BYTES, PROTOCOL_VERSION,
    },
    tls,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::{borrow::Borrow, time::Duration};
use tokio::runtime::{Builder, Runtime};
use zeroize::{Zeroize, Zeroizing};

const LOCAL_CONNECT_TIMEOUT: Duration = Duration::from_millis(750);
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const CALL_TIMEOUT: Duration = Duration::from_millis(MAX_EXPECT_MS + 10_000);

/// Asynchronous control client usable inside an existing Tokio runtime (e.g.
/// Tauri commands or async daemon bridges).
pub struct AsyncControlClient {
    stream: Option<BoxedStream>,
    host_id: String,
    hello: Value,
}

impl AsyncControlClient {
    pub async fn connect_local(endpoint_name: &str) -> Result<Self, HostError> {
        ipc::validate_endpoint_name(endpoint_name)?;
        let mut pipe = tokio::time::timeout(
            LOCAL_CONNECT_TIMEOUT,
            ipc::connect_local_stream(endpoint_name),
        )
        .await
        .map_err(|err| HostError::new("host_unavailable", err))?
        .map_err(|err| HostError::new("host_unavailable", err))?;

        let envelope = tokio::time::timeout(
            IO_TIMEOUT,
            call_command_frame(&mut pipe, &ControlCommand::Hello),
        )
        .await
        .map_err(|err| HostError::new("protocol_mismatch", err))?
        .map_err(|err| HostError::new("protocol_mismatch", err))?;

        let hello = envelope.into_result()?;
        let host_id = validate_hello(&hello)?;
        Ok(Self {
            stream: Some(pipe),
            host_id,
            hello,
        })
    }

    pub async fn connect_default() -> Result<Self, HostError> {
        Self::connect_local(crate::protocol::DEFAULT_ENDPOINT).await
    }

    /// Exchange a one-time invitation only after authenticating the pinned TLS 1.3 peer.
    pub async fn pair_remote(invite: &RemoteInvite) -> Result<RemoteProfile, HostError> {
        let mut stream: BoxedStream =
            Box::new(tls::connect_pinned_tls(&invite.endpoint, &invite.certificate_sha256).await?);
        let value = remote_auth_call(
            &mut stream,
            json!({
                "op": "pair",
                "serverId": invite.server_id,
                "code": invite.code,
            }),
            true,
        )
        .await?;
        let mut profile: RemoteProfile = serde_json::from_value(value)
            .map_err(|_| HostError::new("protocol_mismatch", "invalid pairing response"))?;
        if profile.server_id != invite.server_id
            || !profile
                .certificate_sha256
                .eq_ignore_ascii_case(&invite.certificate_sha256)
        {
            return Err(HostError::new(
                "pin_mismatch",
                "pairing response does not match the trusted Host identity",
            ));
        }
        // Keep the exact endpoint that completed pin-verified TLS.
        profile.endpoint.clone_from(&invite.endpoint);
        Ok(profile)
    }

    /// Connect using a previously paired profile; never auto-repairs a pin.
    pub async fn connect_remote(profile: &RemoteProfile) -> Result<Self, HostError> {
        let mut stream: BoxedStream =
            Box::new(tls::connect_pinned_tls(&profile.endpoint, &profile.certificate_sha256).await?);
        let session = remote_auth_call(
            &mut stream,
            json!({
                "op": "authenticate",
                "serverId": profile.server_id,
                "clientId": profile.client_id,
                "token": profile.token,
            }),
            false,
        )
        .await?;
        if session["serverId"] != profile.server_id {
            return Err(HostError::new(
                "pin_mismatch",
                "remote Host identity has changed; re-pair explicitly",
            ));
        }
        if session["clientId"] != profile.client_id {
            return Err(HostError::new(
                "protocol_mismatch",
                "invalid remote session clientId",
            ));
        }
        let host_id = validate_hello(&session)?;
        Ok(Self {
            stream: Some(stream),
            host_id,
            hello: session,
        })
    }

    pub fn host_id(&self) -> &str {
        &self.host_id
    }

    pub fn hello_info(&self) -> &Value {
        &self.hello
    }

    pub async fn call(&mut self, cmd: impl Borrow<ControlCommand>) -> Result<Value, HostError> {
        let value = serde_json::to_value(cmd.borrow())
            .map_err(|err| HostError::new("invalid_request", err))?;
        self.call_raw(value).await
    }

    pub async fn call_typed<T: DeserializeOwned>(
        &mut self,
        cmd: impl Borrow<ControlCommand>,
    ) -> Result<T, HostError> {
        let value = self.call(cmd).await?;
        serde_json::from_value(value).map_err(|err| {
            HostError::new(
                "protocol_mismatch",
                format!("unexpected Host response shape: {err}"),
            )
        })
    }

    pub async fn call_raw(&mut self, value: Value) -> Result<Value, HostError> {
        let bytes =
            serde_json::to_vec(&value).map_err(|err| HostError::new("invalid_request", err))?;
        if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
            return Err(HostError::new(
                "invalid_request",
                "message exceeds Host frame size",
            ));
        }
        let pipe = self.stream.as_mut().ok_or_else(|| {
            HostError::new(
                "host_unavailable",
                "connection retired; reconnect explicitly",
            )
        })?;
        let outcome = tokio::time::timeout(CALL_TIMEOUT, async {
            write_frame(pipe, &bytes).await?;
            read_reply(pipe).await
        })
        .await;

        match outcome {
            Ok(Ok(reply)) => reply.into_result(),
            Ok(Err(error)) => {
                self.stream.take();
                Err(HostError::new(
                    "outcome_unknown",
                    format!("Host reply lost or invalid; resynchronize before retry: {error}"),
                ))
            }
            Err(error) => {
                self.stream.take();
                Err(HostError::new(
                    "outcome_unknown",
                    format!("Host reply timed out; resynchronize before retry: {error}"),
                ))
            }
        }
    }
}

/// Synchronous control client for CLI / blocking contexts. Owns a single-threaded
/// Tokio runtime; do not drop or call from inside an async runtime worker.
pub struct ControlClient {
    runtime: Runtime,
    inner: AsyncControlClient,
}

impl ControlClient {
    pub fn connect_local(endpoint_name: &str) -> Result<Self, HostError> {
        let runtime = client_runtime()?;
        let inner = runtime.block_on(AsyncControlClient::connect_local(endpoint_name))?;
        Ok(Self { runtime, inner })
    }

    pub fn connect_default() -> Result<Self, HostError> {
        Self::connect_local(crate::protocol::DEFAULT_ENDPOINT)
    }

    pub fn pair_remote(invite: &RemoteInvite) -> Result<RemoteProfile, HostError> {
        let runtime = client_runtime()?;
        runtime.block_on(AsyncControlClient::pair_remote(invite))
    }

    pub fn connect_remote(profile: &RemoteProfile) -> Result<Self, HostError> {
        let runtime = client_runtime()?;
        let inner = runtime.block_on(AsyncControlClient::connect_remote(profile))?;
        Ok(Self { runtime, inner })
    }

    pub fn host_id(&self) -> &str {
        self.inner.host_id()
    }

    pub fn hello_info(&self) -> &Value {
        self.inner.hello_info()
    }

    pub fn call(&mut self, cmd: impl Borrow<ControlCommand>) -> Result<Value, HostError> {
        self.runtime.block_on(self.inner.call(cmd))
    }

    pub fn call_typed<T: DeserializeOwned>(
        &mut self,
        cmd: impl Borrow<ControlCommand>,
    ) -> Result<T, HostError> {
        self.runtime.block_on(self.inner.call_typed(cmd))
    }

    pub fn call_raw(&mut self, value: Value) -> Result<Value, HostError> {
        self.runtime.block_on(self.inner.call_raw(value))
    }
}

fn client_runtime() -> Result<Runtime, HostError> {
    Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| HostError::new("host_unavailable", error))
}

fn validate_hello(hello: &Value) -> Result<String, HostError> {
    let protocol_ok =
        hello.get("protocol").and_then(Value::as_u64) == Some(u64::from(PROTOCOL_VERSION));
    let host_id = hello
        .get("hostId")
        .and_then(Value::as_str)
        .filter(|id| uuid::Uuid::parse_str(id).is_ok());
    match (protocol_ok, host_id) {
        (true, Some(id)) => Ok(id.to_owned()),
        _ => Err(HostError::new(
            "protocol_mismatch",
            "peer is not the expected HyperCom control protocol",
        )),
    }
}

async fn remote_auth_call(
    stream: &mut BoxedStream,
    mut request: Value,
    pairing: bool,
) -> Result<Value, HostError> {
    let payload = Zeroizing::new(
        serde_json::to_vec(&request)
            .map_err(|_| HostError::new("invalid_request", "could not encode authentication"))?,
    );
    for field in ["token", "code"] {
        if let Some(Value::String(secret)) = request.get_mut(field) {
            secret.zeroize();
        }
    }
    let reply = tokio::time::timeout(IO_TIMEOUT, async {
        write_frame(stream, &payload).await?;
        read_reply(stream).await
    })
    .await
    .map_err(|_| auth_io_error(pairing))?
    .map_err(|_| auth_io_error(pairing))?;

    reply.into_result()
}

fn auth_io_error(pairing: bool) -> HostError {
    if pairing {
        HostError::new(
            "outcome_unknown",
            "pairing reply lost; request a fresh invitation",
        )
    } else {
        HostError::new("host_unavailable", "remote authentication exchange failed")
    }
}

async fn call_command_frame(
    stream: &mut BoxedStream,
    command: &ControlCommand,
) -> std::io::Result<ReplyEnvelope> {
    let bytes = serde_json::to_vec(command).map_err(std::io::Error::other)?;
    write_frame(stream, &bytes).await?;
    read_reply(stream).await
}

async fn read_reply(stream: &mut BoxedStream) -> std::io::Result<ReplyEnvelope> {
    let bytes = Zeroizing::new(read_frame(stream).await?);
    serde_json::from_slice(&bytes).map_err(std::io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        auth::{Authority, RemotePermissions, RemoteRole},
        ipc::LocalListener,
        protocol::{read_json_frame, write_json_frame},
    };
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn async_client_connects_local_and_calls_command() {
        let endpoint = format!("hc-cli-{}", &uuid::Uuid::new_v4().simple().to_string()[..16]);
        let mut local_listener = LocalListener::bind(&endpoint).unwrap();
        let host_id = uuid::Uuid::new_v4().to_string();
        let server_host_id = host_id.clone();

        let local_server = tokio::spawn(async move {
            let mut stream = local_listener.accept().await.unwrap().unwrap();
            let hello: ControlCommand = read_json_frame(&mut stream).await.unwrap();
            assert_eq!(hello, ControlCommand::Hello);
            write_json_frame(
                &mut stream,
                &ReplyEnvelope::ok(json!({
                    "protocol": PROTOCOL_VERSION,
                    "hostId": server_host_id,
                })),
            )
            .await
            .unwrap();

            let cmd: ControlCommand = read_json_frame(&mut stream).await.unwrap();
            assert_eq!(cmd, ControlCommand::Ports);
            write_json_frame(&mut stream, &ReplyEnvelope::ok(json!([])))
                .await
                .unwrap();
        });

        let mut local = AsyncControlClient::connect_local(&endpoint).await.unwrap();
        assert_eq!(local.host_id(), host_id);
        let ports = local.call(ControlCommand::Ports).await.unwrap();
        assert_eq!(ports, json!([]));
        local_server.await.unwrap();
    }

    #[tokio::test]
    async fn async_client_pairs_and_connects_remote_over_tls() {
        let dir = std::env::temp_dir().join(format!("hc-cli-tls-{}", uuid::Uuid::new_v4()));
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = tcp.local_addr().unwrap();
        let authority = std::sync::Arc::new(Authority::open(&dir, addr.to_string()).unwrap());
        let invite = authority
            .invite(
                "cli-test".into(),
                RemotePermissions {
                    role: RemoteRole::Control,
                    ports: vec!["COM1".into()],
                    allow_loan: true,
                    automation: false,
                    device_plugins: false,
                    device_tools: false,
                },
                None,
            )
            .unwrap();
        let acceptor = tls::build_tls_acceptor(&authority).unwrap();
        let remote_host_id = uuid::Uuid::new_v4().to_string();

        let tls_server = tokio::spawn(async move {
            // 1. Pair connection
            let (sock1, _) = tcp.accept().await.unwrap();
            let mut tls1 = acceptor.accept(sock1).await.unwrap();
            let pair_cmd: ControlCommand = read_json_frame(&mut tls1).await.unwrap();
            match pair_cmd {
                ControlCommand::Pair { server_id, code } => {
                    assert_eq!(server_id, authority.server_id());
                    let profile = authority.pair(&code).unwrap();
                    write_json_frame(&mut tls1, &ReplyEnvelope::ok(json!(profile)))
                        .await
                        .unwrap();
                }
                other => panic!("unexpected command: {other:?}"),
            }

            // 2. Authenticate + command connection
            let (sock2, _) = tcp.accept().await.unwrap();
            let mut tls2 = acceptor.accept(sock2).await.unwrap();
            let auth_cmd: ControlCommand = read_json_frame(&mut tls2).await.unwrap();
            match auth_cmd {
                ControlCommand::Authenticate {
                    server_id,
                    client_id,
                    token,
                } => {
                    assert_eq!(server_id, authority.server_id());
                    let peer = authority.authenticate(&client_id, &token).unwrap();
                    write_json_frame(
                        &mut tls2,
                        &ReplyEnvelope::ok(json!({
                            "protocol": PROTOCOL_VERSION,
                            "hostId": remote_host_id,
                            "serverId": authority.server_id(),
                            "clientId": peer.id(),
                        })),
                    )
                    .await
                    .unwrap();
                }
                other => panic!("unexpected command: {other:?}"),
            }
            let next: ControlCommand = read_json_frame(&mut tls2).await.unwrap();
            assert_eq!(next, ControlCommand::ListLoans);
            write_json_frame(&mut tls2, &ReplyEnvelope::ok(json!([])))
                .await
                .unwrap();
        });

        let profile = AsyncControlClient::pair_remote(&invite).await.unwrap();
        let mut remote = AsyncControlClient::connect_remote(&profile).await.unwrap();
        let loans = remote.call(ControlCommand::ListLoans).await.unwrap();
        assert_eq!(loans, json!([]));

        tls_server.await.unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
