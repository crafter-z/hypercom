//! Same-OS-user local IPC transport (Named Pipes on Windows, Unix Domain Sockets
//! on Unix).

use crate::protocol::HostError;
use std::io;
use tokio::io::{AsyncRead, AsyncWrite};

#[cfg(windows)]
#[path = "ipc_windows.rs"]
mod platform;
#[cfg(unix)]
#[path = "ipc_unix.rs"]
mod platform;

pub trait IpcStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> IpcStream for T {}

pub type BoxedStream = Box<dyn IpcStream>;

pub fn validate_endpoint_name(name: &str) -> Result<(), HostError> {
    if name.is_empty()
        || name.len() > 32
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        Err(HostError::new(
            "invalid_request",
            "endpoint name must use 1–32 ASCII letters/digits/_/-",
        ))
    } else {
        Ok(())
    }
}

pub struct LocalListener {
    inner: platform::Listener,
}

impl LocalListener {
    pub fn bind(name: &str) -> io::Result<Self> {
        validate_endpoint_name(name)
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err.message))?;
        Ok(Self {
            inner: platform::Listener::bind(name)?,
        })
    }

    pub async fn accept(&mut self) -> io::Result<Option<BoxedStream>> {
        self.inner.accept().await
    }
}

pub async fn connect_local_stream(name: &str) -> io::Result<BoxedStream> {
    validate_endpoint_name(name)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err.message))?;
    platform::connect(name).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{read_frame, write_frame};

    #[test]
    fn validates_endpoint_names() {
        assert!(validate_endpoint_name("default").is_ok());
        assert!(validate_endpoint_name("lab_1-test").is_ok());
        assert!(validate_endpoint_name("").is_err());
        assert!(validate_endpoint_name(&"a".repeat(33)).is_err());
        assert!(validate_endpoint_name("bad/name").is_err());
        assert!(validate_endpoint_name("bad name").is_err());
    }

    #[tokio::test]
    async fn same_user_local_ipc_roundtrips_frames() {
        let endpoint = format!("hc-test-{}", &uuid::Uuid::new_v4().simple().to_string()[..16]);
        let mut listener = LocalListener::bind(&endpoint).unwrap();
        let server = tokio::spawn(async move {
            loop {
                if let Some(mut stream) = listener.accept().await.unwrap() {
                    let msg = read_frame(&mut stream).await.unwrap();
                    assert_eq!(msg, b"hello-ipc");
                    write_frame(&mut stream, b"pong-ipc").await.unwrap();
                    break;
                }
            }
        });

        let mut client = connect_local_stream(&endpoint).await.unwrap();
        write_frame(&mut client, b"hello-ipc").await.unwrap();
        let reply = read_frame(&mut client).await.unwrap();
        assert_eq!(reply, b"pong-ipc");
        server.await.unwrap();
    }
}
