//! Pinned TLS 1.3 transport over TCP using SHA-256 certificate pinning and
//! ALPN (`hypercom-control/1`).

use crate::{
    auth::{digest, Authority},
    protocol::HostError,
};
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms},
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime},
    ClientConfig, DigitallySignedStruct, ServerConfig, SignatureScheme,
};
use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::net::TcpStream;
use tokio_rustls::{client::TlsStream, TlsAcceptor, TlsConnector};

pub const CONTROL_ALPN: &[u8] = b"hypercom-control/1";
const TLS_TIMEOUT: Duration = Duration::from_secs(5);

pub fn build_tls_acceptor(authority: &Authority) -> anyhow::Result<TlsAcceptor> {
    let (cert, key) = authority.material();
    build_tls_acceptor_from_der(cert, key)
}

pub fn build_tls_acceptor_from_der(
    cert_der: &[u8],
    key_der: &[u8],
) -> anyhow::Result<TlsAcceptor> {
    let provider = rustls::crypto::ring::default_provider();
    let mut config = ServerConfig::builder_with_provider(Arc::new(provider))
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert_der.to_vec())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_der.to_vec())),
        )?;
    config.alpn_protocols = vec![CONTROL_ALPN.to_vec()];
    config.send_tls13_tickets = 0;
    config.max_early_data_size = 0;
    Ok(TlsAcceptor::from(Arc::new(config)))
}

enum Endpoint {
    Ip(SocketAddr),
    Dns(String, u16),
}

impl Endpoint {
    fn parse(value: &str) -> Result<Self, HostError> {
        let bad = || {
            HostError::new(
                "invalid_request",
                "remote endpoint must be a concrete IP-or-DNS:port (bracket an IPv6 address)",
            )
        };
        if let Ok(addr) = value.parse::<SocketAddr>() {
            return if addr.port() > 0 && !addr.ip().is_unspecified() && !addr.ip().is_multicast() {
                Ok(Self::Ip(addr))
            } else {
                Err(bad())
            };
        }
        let (host, port) = value.rsplit_once(':').ok_or_else(bad)?;
        let dns = host.strip_suffix('.').unwrap_or(host);
        if dns.len() > 253
            || !dns.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && label.as_bytes()[0].is_ascii_alphanumeric()
                    && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                    && label
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
            || !port.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(bad());
        }
        let port = port
            .parse::<u16>()
            .ok()
            .filter(|port| *port > 0)
            .ok_or_else(bad)?;
        ServerName::try_from(host.to_owned()).map_err(|_| bad())?;
        Ok(Self::Dns(host.to_owned(), port))
    }

    fn server_name(&self) -> ServerName<'static> {
        match self {
            Self::Ip(addr) => ServerName::IpAddress(addr.ip().into()),
            Self::Dns(name, _) => {
                ServerName::try_from(name.to_owned()).expect("validated DNS host")
            }
        }
    }

    async fn connect(&self) -> std::io::Result<TcpStream> {
        match self {
            Self::Ip(addr) => TcpStream::connect(addr).await,
            Self::Dns(host, port) => TcpStream::connect((host.as_str(), *port)).await,
        }
    }
}

pub fn validate_remote_endpoint(value: &str) -> Result<(), HostError> {
    Endpoint::parse(value).map(|_| ())
}

pub fn decode_sha256_pin(pin: &str) -> Result<[u8; 32], HostError> {
    let invalid = || {
        HostError::new(
            "invalid_request",
            "TLS pin must be exactly 64 hexadecimal characters",
        )
    };
    if pin.len() != 64 || !pin.as_bytes().iter().all(u8::is_ascii_hexdigit) {
        return Err(invalid());
    }
    let mut bytes = [0u8; 32];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&pin[2 * i..2 * i + 2], 16).map_err(|_| invalid())?;
    }
    Ok(bytes)
}

#[derive(Debug)]
struct ExactPin {
    expected: [u8; 32],
    mismatched: Arc<AtomicBool>,
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for ExactPin {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        // The out-of-band TLS certificate pin supplies identity rather than a
        // DNS name or CA. CertificateVerify still proves possession of the
        // leaf private key.
        if !bool::from(digest(end_entity.as_ref()).ct_eq(&self.expected)) {
            self.mismatched.store(true, Ordering::Release);
            return Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::ApplicationVerificationFailure,
            ));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signed: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, signed, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signed: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, signed, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

pub async fn connect_pinned_tls(addr: &str, pin: &str) -> Result<TlsStream<TcpStream>, HostError> {
    let addr = Endpoint::parse(addr)?;
    let expected = decode_sha256_pin(pin)?;
    let provider = rustls::crypto::ring::default_provider();
    let mismatched = Arc::new(AtomicBool::new(false));
    let verifier = ExactPin {
        expected,
        mismatched: mismatched.clone(),
        algorithms: provider.signature_verification_algorithms,
    };
    let mut config = ClientConfig::builder_with_provider(Arc::new(provider))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|_| HostError::new("protocol_mismatch", "TLS 1.3 unavailable"))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    config.alpn_protocols = vec![CONTROL_ALPN.to_vec()];
    config.enable_early_data = false;
    config.resumption = rustls::client::Resumption::disabled();
    let server = addr.server_name();
    let handshake = tokio::time::timeout(TLS_TIMEOUT, async {
        let stream = addr.connect().await?;
        stream.set_nodelay(true)?;
        TlsConnector::from(Arc::new(config))
            .connect(server, stream)
            .await
    })
    .await;
    match handshake {
        Ok(Ok(stream)) if stream.get_ref().1.alpn_protocol() == Some(CONTROL_ALPN) => Ok(stream),
        Ok(Ok(_)) => Err(HostError::new(
            "protocol_mismatch",
            "listener does not speak HyperCom control TLS ALPN",
        )),
        _ if mismatched.load(Ordering::Acquire) => Err(HostError::new(
            "pin_mismatch",
            "remote Host TLS certificate does not match the trusted pin",
        )),
        _ => Err(HostError::new(
            "host_unavailable",
            "could not establish a TLS connection to the remote Host",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[tokio::test]
    async fn loopback_tls13_pinning_accepts_valid_pin_and_rejects_wrong_pin() {
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec!["hypercom-host.local".to_string()]).unwrap();
        let cert_der = cert.der().as_ref().to_vec();
        let key_der = signing_key.serialize_der();
        let valid_pin: String = digest(&cert_der)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let acceptor = build_tls_acceptor_from_der(&cert_der, &key_der).unwrap();

        let server_task = tokio::spawn(async move {
            for _ in 0..2 {
                let (tcp, _) = listener.accept().await.unwrap();
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    if let Ok(mut tls) = acceptor.accept(tcp).await {
                        assert_eq!(tls.get_ref().1.alpn_protocol(), Some(CONTROL_ALPN));
                        let mut buf = [0u8; 4];
                        if tls.read_exact(&mut buf).await.is_ok() {
                            let _ = tls.write_all(&buf).await;
                            let _ = tls.flush().await;
                        }
                    }
                });
            }
        });

        let mut ok_stream = connect_pinned_tls(&addr.to_string(), &valid_pin)
            .await
            .unwrap();
        assert_eq!(ok_stream.get_ref().1.alpn_protocol(), Some(CONTROL_ALPN));
        ok_stream.write_all(b"ping").await.unwrap();
        ok_stream.flush().await.unwrap();
        let mut echoed = [0u8; 4];
        ok_stream.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"ping");

        let wrong_pin = "00".repeat(32);
        let err = connect_pinned_tls(&addr.to_string(), &wrong_pin)
            .await
            .unwrap_err();
        assert_eq!(err.code, "pin_mismatch");

        let _ = server_task.await;
    }
}
