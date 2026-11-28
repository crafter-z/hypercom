//! Versioned HyperCom control protocol wire types, length-prefixed JSON
//! framing helpers, and `PortRef` routing helpers.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::{error::Error, fmt, io};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
pub const DEFAULT_ENDPOINT: &str = "default";

pub const MAX_WRITE_BYTES: usize = 64 * 1024;
pub const MAX_EXPECT_BYTES: usize = 4096;
pub const MAX_EXPECT_MS: u64 = 60_000;
pub const MAX_POLL_MS: u64 = 1000;
pub const MAX_ARTIFACT_CHUNK_BYTES: usize = 512 * 1024;

const REMOTE_PREFIX: &str = "remote::";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostError {
    pub code: String,
    pub message: String,
}

impl HostError {
    pub fn new(code: impl Into<String>, message: impl fmt::Display) -> Self {
        Self {
            code: code.into(),
            message: message.to_string(),
        }
    }
}

impl fmt::Display for HostError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl Error for HostError {}

/// Length-prefixed (4-byte big-endian `u32`) JSON frame codec over async streams.
#[derive(Debug, Clone, Copy, Default)]
pub struct FrameEnvelope;

impl FrameEnvelope {
    pub fn encode<T: Serialize>(value: &T) -> io::Result<Vec<u8>> {
        let payload = serde_json::to_vec(value).map_err(io::Error::other)?;
        if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid HyperCom frame length",
            ));
        }
        let mut framed = Vec::with_capacity(4 + payload.len());
        framed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        framed.extend_from_slice(&payload);
        Ok(framed)
    }

    pub fn decode<T: DeserializeOwned>(framed: &[u8]) -> io::Result<T> {
        if framed.len() < 4 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "truncated HyperCom frame header",
            ));
        }
        let len = u32::from_be_bytes([framed[0], framed[1], framed[2], framed[3]]) as usize;
        if len == 0 || len > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid HyperCom frame length",
            ));
        }
        let payload = &framed[4..];
        if payload.len() != len {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "HyperCom frame length mismatch",
            ));
        }
        serde_json::from_slice(payload).map_err(io::Error::other)
    }

    pub async fn read<R: AsyncRead + Unpin, T: DeserializeOwned>(stream: &mut R) -> io::Result<T> {
        read_json_frame(stream).await
    }

    pub async fn write<W: AsyncWrite + Unpin, T: Serialize>(
        stream: &mut W,
        value: &T,
    ) -> io::Result<()> {
        write_json_frame(stream, value).await
    }
}

pub async fn read_limited_frame<R: AsyncRead + Unpin>(
    stream: &mut R,
    maximum: usize,
) -> io::Result<Vec<u8>> {
    let size = stream.read_u32().await? as usize;
    if size == 0 || size > maximum {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid HyperCom frame length",
        ));
    }
    let mut bytes = vec![0u8; size];
    stream.read_exact(&mut bytes).await?;
    Ok(bytes)
}

pub async fn read_frame<R: AsyncRead + Unpin>(stream: &mut R) -> io::Result<Vec<u8>> {
    read_limited_frame(stream, MAX_FRAME_BYTES).await
}

pub async fn write_frame<W: AsyncWrite + Unpin>(stream: &mut W, bytes: &[u8]) -> io::Result<()> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid HyperCom frame length",
        ));
    }
    stream.write_u32(bytes.len() as u32).await?;
    stream.write_all(bytes).await?;
    stream.flush().await
}

pub async fn read_json_frame<R: AsyncRead + Unpin, T: DeserializeOwned>(
    stream: &mut R,
) -> io::Result<T> {
    let bytes = read_frame(stream).await?;
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}

pub async fn write_json_frame<W: AsyncWrite + Unpin, T: Serialize>(
    stream: &mut W,
    value: &T,
) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    write_frame(stream, &bytes).await
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialParamsDto {
    pub baud_rate: u32,
    pub data_bits: u8,
    pub parity: String,
    pub stop_bits: String,
    pub handshake: String,
    pub dtr: bool,
    pub rts: bool,
}

impl Default for SerialParamsDto {
    fn default() -> Self {
        Self {
            baud_rate: 115_200,
            data_bits: 8,
            parity: "none".to_string(),
            stop_bits: "one".to_string(),
            handshake: "none".to_string(),
            dtr: false,
            rts: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoanInfoDto {
    pub lease_id: String,
    pub port_id: String,
    pub holder: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub acquired_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<i64>,
    pub generation: u64,
    pub auto_reopen: bool,
    pub connection_bound: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortSnapshotDto {
    pub id: String,
    pub name: String,
    pub port_type: String,
    pub status: String,
    pub generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baud_rate: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manufacturer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loan: Option<LoanInfoDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialRecoveryDto {
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamEventDto {
    pub seq: u64,
    pub port_id: String,
    pub generation: u64,
    pub timestamp_ms: i64,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_base64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loan: Option<LoanInfoDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPageDto {
    pub host_id: String,
    pub port_id: String,
    pub generation: u64,
    pub latest_seq: u64,
    pub next_seq: u64,
    pub gap: bool,
    pub events: Vec<StreamEventDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ExpectSpec {
    Line { text: String },
    Text { text: String },
    Bytes { data_base64: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestOutcomeDto {
    pub bytes_written: usize,
    pub matched: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_base64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginToolDescriptorDto {
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_label: Option<String>,
    pub plugin_id: String,
    pub plugin_name: String,
    pub install_generation: String,
    pub tool: String,
    pub description: String,
    pub access: String,
    pub mode: String,
    pub port_scoped: bool,
    pub accepts_artifacts: bool,
    pub input_schema: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginJobEventDto {
    pub seq: u64,
    pub timestamp_ms: i64,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginJobStatusDto {
    pub job_id: String,
    pub host: String,
    pub plugin_id: String,
    pub tool: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<HostError>,
    pub latest_seq: u64,
    pub next_seq: u64,
    #[serde(default)]
    pub events: Vec<PluginJobEventDto>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginToolInvokeResultDto {
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<PluginJobStatusDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactInfoDto {
    pub artifact_id: String,
    pub name: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePluginViewEntryDto {
    pub plugin_id: String,
    pub plugin_name: String,
    pub install_generation: String,
    pub view_id: String,
    pub label: String,
    pub mode: String,
    pub placements: Vec<String>,
    pub port_binding: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteViewAssetDto {
    pub rel_path: String,
    pub mime: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteViewSessionDto {
    pub remote_instance_id: String,
    pub document_id: String,
    pub plugin_id: String,
    pub plugin_name: String,
    pub install_generation: String,
    pub view_id: String,
    pub label: String,
    pub entry: String,
    pub styles: Vec<String>,
    pub assets: Vec<RemoteViewAssetDto>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteViewEventDto {
    pub seq: u64,
    pub kind: String,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteViewEventPageDto {
    pub remote_instance_id: String,
    pub latest_seq: u64,
    pub next_seq: u64,
    pub closed: bool,
    pub events: Vec<RemoteViewEventDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyEnvelope {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<HostError>,
}

impl ReplyEnvelope {
    pub fn ok(result: Value) -> Self {
        Self {
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(error: HostError) -> Self {
        Self {
            ok: false,
            result: None,
            error: Some(error),
        }
    }

    pub fn into_result(self) -> Result<Value, HostError> {
        if self.ok {
            Ok(self.result.unwrap_or(Value::Null))
        } else {
            Err(self.error.unwrap_or_else(|| {
                HostError::new("protocol_mismatch", "missing error payload in reply")
            }))
        }
    }
}

impl From<Result<Value, HostError>> for ReplyEnvelope {
    fn from(outcome: Result<Value, HostError>) -> Self {
        match outcome {
            Ok(value) => Self::ok(value),
            Err(err) => Self::err(err),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ControlCommand {
    Hello,
    HostInfo,
    Ports,
    Status {
        port_id: String,
    },
    Open {
        port_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        params: Option<SerialParamsDto>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        host_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_generation: Option<u64>,
    },
    Close {
        port_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        host_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_generation: Option<u64>,
    },
    SetParams {
        port_id: String,
        params: SerialParamsDto,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_generation: Option<u64>,
    },
    SetFlowControl {
        port_id: String,
        dtr: bool,
        rts: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_generation: Option<u64>,
    },
    Send {
        port_id: String,
        data_base64: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_generation: Option<u64>,
    },
    Request {
        port_id: String,
        data_base64: String,
        expect: ExpectSpec,
        timeout_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_generation: Option<u64>,
    },
    PollEvents {
        port_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after_seq: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recent: Option<usize>,
        #[serde(default)]
        wait_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<usize>,
    },
    AddNote {
        port_id: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
    },
    AcquireLoan {
        port_id: String,
        holder: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ttl_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        auto_reopen: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connection_bound: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_generation: Option<u64>,
    },
    HeartbeatLoan {
        lease_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        extend_ttl_ms: Option<u64>,
    },
    ReleaseLoan {
        lease_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reopen_override: Option<bool>,
    },
    ReclaimLoan {
        port_id: String,
    },
    ListLoans,
    RemoteStatus,
    RemoteStart {
        listen: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        advertise: Option<String>,
    },
    RemoteStop,
    RemoteCreateInvite {
        label: String,
        ports: Vec<String>,
        role: String,
        #[serde(default)]
        allow_loan: bool,
        #[serde(default)]
        device_plugins: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ttl_secs: Option<u64>,
    },
    RemoteListClients,
    RemoteRevokeClient {
        client_id: String,
    },
    Pair {
        server_id: String,
        code: String,
    },
    Authenticate {
        server_id: String,
        client_id: String,
        token: String,
    },
    ListPluginTools,
    InvokePluginTool {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<String>,
        plugin_id: String,
        tool: String,
        #[serde(default)]
        args: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        artifacts: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
    },
    PollPluginJob {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<String>,
        job_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after_seq: Option<u64>,
        #[serde(default)]
        wait_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<usize>,
    },
    CancelPluginJob {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<String>,
        job_id: String,
    },
    ArtifactBegin {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<String>,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        total_bytes: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ttl_ms: Option<u64>,
    },
    ArtifactChunk {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<String>,
        upload_id: String,
        offset: u64,
        data_base64: String,
    },
    ArtifactCommit {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<String>,
        upload_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_sha256: Option<String>,
    },
    ArtifactAbort {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<String>,
        upload_id: String,
    },
    ListRemotePluginViews,
    OpenRemotePluginView {
        plugin_id: String,
        view_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bound_port_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        params: Option<Value>,
    },
    SendRemotePluginViewInput {
        remote_instance_id: String,
        kind: String,
        #[serde(default)]
        payload: Value,
    },
    PollRemotePluginViewEvents {
        remote_instance_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after_seq: Option<u64>,
        #[serde(default)]
        wait_ms: u64,
    },
    CloseRemotePluginView {
        remote_instance_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortRef<'a> {
    Local(&'a str),
    Remote {
        profile_id: &'a str,
        port_id: &'a str,
    },
}

impl<'a> PortRef<'a> {
    pub fn parse(raw: &'a str) -> Result<Self, HostError> {
        if raw.is_empty() {
            return Err(HostError::new(
                "invalid_request",
                "port reference cannot be empty",
            ));
        }
        if let Some(rest) = raw.strip_prefix(REMOTE_PREFIX) {
            let Some((profile_id, port_id)) = rest.split_once("::") else {
                return Err(HostError::new(
                    "invalid_request",
                    "remote port reference must use format remote::<profileId>::<portId>",
                ));
            };
            validate_remote_parts(profile_id, port_id)?;
            Ok(Self::Remote {
                profile_id,
                port_id,
            })
        } else {
            Ok(Self::Local(raw))
        }
    }

    pub fn format_remote(profile_id: &str, port_id: &str) -> Result<String, HostError> {
        validate_remote_parts(profile_id, port_id)?;
        Ok(format!("{REMOTE_PREFIX}{profile_id}::{port_id}"))
    }

    pub fn is_remote(&self) -> bool {
        matches!(self, Self::Remote { .. })
    }

    pub fn is_remote_str(raw: &str) -> bool {
        raw.starts_with(REMOTE_PREFIX)
    }

    pub fn port_id(&self) -> &'a str {
        match self {
            Self::Local(port_id) => port_id,
            Self::Remote { port_id, .. } => port_id,
        }
    }

    pub fn profile_id(&self) -> Option<&'a str> {
        match self {
            Self::Local(_) => None,
            Self::Remote { profile_id, .. } => Some(profile_id),
        }
    }
}

fn validate_remote_parts(profile_id: &str, port_id: &str) -> Result<(), HostError> {
    if profile_id.is_empty() || profile_id.contains("::") {
        return Err(HostError::new(
            "invalid_request",
            "remote profileId must be non-empty and cannot contain '::'",
        ));
    }
    if port_id.is_empty() {
        return Err(HostError::new(
            "invalid_request",
            "remote portId cannot be empty",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[test]
    fn port_ref_parses_local_and_remote_and_rejects_malformed() {
        assert_eq!(PortRef::parse("COM3").unwrap(), PortRef::Local("COM3"));
        assert!(!PortRef::parse("COM3").unwrap().is_remote());

        let remote = PortRef::parse("remote::lab-bench::/dev/ttyUSB0").unwrap();
        assert_eq!(
            remote,
            PortRef::Remote {
                profile_id: "lab-bench",
                port_id: "/dev/ttyUSB0",
            }
        );
        assert!(remote.is_remote());
        assert_eq!(remote.profile_id(), Some("lab-bench"));
        assert_eq!(remote.port_id(), "/dev/ttyUSB0");

        assert_eq!(
            PortRef::format_remote("lab-bench", "COM7").unwrap(),
            "remote::lab-bench::COM7"
        );
        assert!(PortRef::format_remote("", "COM7").is_err());
        assert!(PortRef::format_remote("a::b", "COM7").is_err());
        assert!(PortRef::format_remote("lab", "").is_err());

        for bad in [
            "",
            "remote::",
            "remote::only-profile",
            "remote::::COM1",
            "remote::lab::",
        ] {
            assert!(PortRef::parse(bad).is_err(), "expected error for {bad:?}");
        }
    }

    #[tokio::test]
    async fn frame_roundtrip_and_bounds() {
        let (mut client, mut server) = duplex(64 * 1024);
        let cmd = ControlCommand::Send {
            port_id: "COM3".into(),
            data_base64: "SGVsbG8=".into(),
            source: Some("cli".into()),
            expected_generation: Some(2),
        };
        FrameEnvelope::write(&mut client, &cmd).await.unwrap();
        let decoded: ControlCommand = FrameEnvelope::read(&mut server).await.unwrap();
        assert_eq!(decoded, cmd);

        let encoded = FrameEnvelope::encode(&cmd).unwrap();
        let decoded_sync: ControlCommand = FrameEnvelope::decode(&encoded).unwrap();
        assert_eq!(decoded_sync, cmd);

        // Empty frame rejected on write
        assert_eq!(
            write_frame(&mut client, &[]).await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );

        // Oversized frame rejected on write
        let too_big = vec![0u8; MAX_FRAME_BYTES + 1];
        assert_eq!(
            write_frame(&mut client, &too_big).await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );

        // Zero-length or oversized frame header rejected on read
        client
            .write_all(&0u32.to_be_bytes())
            .await
            .unwrap();
        assert_eq!(
            read_frame(&mut server).await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );

        client
            .write_all(&((MAX_FRAME_BYTES as u32) + 1).to_be_bytes())
            .await
            .unwrap();
        assert_eq!(
            read_frame(&mut server).await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn control_command_and_reply_envelope_serde() {
        let cmd = ControlCommand::RemoteCreateInvite {
            label: "workstation".into(),
            ports: vec!["COM3".into()],
            role: "control".into(),
            allow_loan: true,
            device_plugins: true,
            ttl_secs: Some(300),
        };
        let json = serde_json::to_value(&cmd).unwrap();
        assert_eq!(json["op"], "remote_create_invite");
        assert_eq!(json["allowLoan"], true);
        assert_eq!(json["devicePlugins"], true);
        assert_eq!(json["ttlSecs"], 300);
        assert_eq!(
            serde_json::from_value::<ControlCommand>(json).unwrap(),
            cmd
        );

        let legacy_invite_cmd: ControlCommand = serde_json::from_str(
            r#"{"op":"remote_create_invite","label":"legacy","ports":["COM3"],"role":"observe"}"#,
        )
        .unwrap();
        assert_eq!(
            legacy_invite_cmd,
            ControlCommand::RemoteCreateInvite {
                label: "legacy".into(),
                ports: vec!["COM3".into()],
                role: "observe".into(),
                allow_loan: false,
                device_plugins: false,
                ttl_secs: None,
            }
        );

        let ok = ReplyEnvelope::ok(serde_json::json!({"ok": true}));
        assert!(ok.clone().into_result().is_ok());

        let err = ReplyEnvelope::err(HostError::new("forbidden", "no access"));
        let host_err = err.into_result().unwrap_err();
        assert_eq!(host_err.code, "forbidden");
    }

    #[test]
    fn plugin_tool_artifact_and_remote_view_commands_serde() {
        let commands = vec![
            ControlCommand::ListPluginTools,
            ControlCommand::InvokePluginTool {
                target: Some("remote::bench::COM3".into()),
                plugin_id: "stm32-flasher".into(),
                tool: "flash".into(),
                args: serde_json::json!({"verify": true}),
                artifacts: Some(vec!["art-1".into()]),
                timeout_ms: Some(30_000),
            },
            ControlCommand::InvokePluginTool {
                target: None,
                plugin_id: "diag".into(),
                tool: "info".into(),
                args: Value::Null,
                artifacts: None,
                timeout_ms: None,
            },
            ControlCommand::PollPluginJob {
                target: Some("bench".into()),
                job_id: "job-1".into(),
                after_seq: Some(4),
                wait_ms: 500,
                limit: Some(100),
            },
            ControlCommand::CancelPluginJob {
                target: None,
                job_id: "job-1".into(),
            },
            ControlCommand::ArtifactBegin {
                target: Some("bench".into()),
                name: "firmware.bin".into(),
                total_bytes: Some(1024 * 1024),
                ttl_ms: Some(60_000),
            },
            ControlCommand::ArtifactChunk {
                target: Some("bench".into()),
                upload_id: "up-1".into(),
                offset: 524_288,
                data_base64: "AQID".into(),
            },
            ControlCommand::ArtifactCommit {
                target: None,
                upload_id: "up-1".into(),
                expected_sha256: Some("deadbeef".into()),
            },
            ControlCommand::ArtifactAbort {
                target: None,
                upload_id: "up-1".into(),
            },
            ControlCommand::ListRemotePluginViews,
            ControlCommand::OpenRemotePluginView {
                plugin_id: "scope".into(),
                view_id: "waveform".into(),
                bound_port_id: Some("COM7".into()),
                params: Some(serde_json::json!({"rate": 1000})),
            },
            ControlCommand::SendRemotePluginViewInput {
                remote_instance_id: "inst-1".into(),
                kind: "state".into(),
                payload: serde_json::json!({"paused": false}),
            },
            ControlCommand::PollRemotePluginViewEvents {
                remote_instance_id: "inst-1".into(),
                after_seq: Some(2),
                wait_ms: 250,
            },
            ControlCommand::CloseRemotePluginView {
                remote_instance_id: "inst-1".into(),
            },
        ];

        for cmd in commands {
            let encoded = FrameEnvelope::encode(&cmd).unwrap();
            let decoded: ControlCommand = FrameEnvelope::decode(&encoded).unwrap();
            assert_eq!(decoded, cmd);
        }

        // Verify defaults when optional fields are omitted
        let minimal_invoke: ControlCommand = serde_json::from_str(
            r#"{"op":"invoke_plugin_tool","pluginId":"p","tool":"t"}"#,
        )
        .unwrap();
        assert_eq!(
            minimal_invoke,
            ControlCommand::InvokePluginTool {
                target: None,
                plugin_id: "p".into(),
                tool: "t".into(),
                args: Value::Null,
                artifacts: None,
                timeout_ms: None,
            }
        );

        let minimal_input: ControlCommand = serde_json::from_str(
            r#"{"op":"send_remote_plugin_view_input","remoteInstanceId":"r1","kind":"state"}"#,
        )
        .unwrap();
        assert_eq!(
            minimal_input,
            ControlCommand::SendRemotePluginViewInput {
                remote_instance_id: "r1".into(),
                kind: "state".into(),
                payload: Value::Null,
            }
        );
    }

    #[test]
    fn plugin_tool_artifact_and_remote_view_dtos_serde() {
        let descriptor = PluginToolDescriptorDto {
            host: "remote::lab".into(),
            host_label: Some("Lab Bench".into()),
            plugin_id: "flasher".into(),
            plugin_name: "Flasher".into(),
            install_generation: "gen-1".into(),
            tool: "program".into(),
            description: "Program MCU".into(),
            access: "control".into(),
            mode: "job".into(),
            port_scoped: true,
            accepts_artifacts: true,
            input_schema: serde_json::json!({"type": "object"}),
        };
        let descriptor_json = serde_json::to_value(&descriptor).unwrap();
        assert_eq!(descriptor_json["hostLabel"], "Lab Bench");
        assert_eq!(descriptor_json["installGeneration"], "gen-1");
        assert_eq!(descriptor_json["portScoped"], true);
        assert_eq!(descriptor_json["acceptsArtifacts"], true);
        assert_eq!(
            serde_json::from_value::<PluginToolDescriptorDto>(descriptor_json).unwrap(),
            descriptor
        );

        let job_event = PluginJobEventDto {
            seq: 1,
            timestamp_ms: 1_700_000_000_000,
            kind: "progress".into(),
            message: Some("erasing".into()),
            stream: Some("stdout".into()),
            progress: Some(0.5),
            data: Some(serde_json::json!({"sector": 3})),
        };
        let job_status = PluginJobStatusDto {
            job_id: "job-42".into(),
            host: "local".into(),
            plugin_id: "flasher".into(),
            tool: "program".into(),
            state: "running".into(),
            result: None,
            error: Some(HostError::new("warn", "retry")),
            latest_seq: 1,
            next_seq: 2,
            events: vec![job_event],
        };
        let invoke_result = PluginToolInvokeResultDto {
            mode: "job".into(),
            result: Some(serde_json::json!({"started": true})),
            job_id: Some("job-42".into()),
            status: Some(job_status.clone()),
        };
        let invoke_json = serde_json::to_value(&invoke_result).unwrap();
        assert_eq!(
            serde_json::from_value::<PluginToolInvokeResultDto>(invoke_json).unwrap(),
            invoke_result
        );

        let artifact = ArtifactInfoDto {
            artifact_id: "art-1".into(),
            name: "app.bin".into(),
            size_bytes: 2_097_152,
            sha256: "0123456789abcdef".into(),
            expires_at_ms: 1_700_000_060_000,
        };
        assert_eq!(
            serde_json::from_value::<ArtifactInfoDto>(serde_json::to_value(&artifact).unwrap())
                .unwrap(),
            artifact
        );
        assert_eq!(MAX_ARTIFACT_CHUNK_BYTES, 512 * 1024);

        let view_entry = RemotePluginViewEntryDto {
            plugin_id: "scope".into(),
            plugin_name: "Scope".into(),
            install_generation: "gen-2".into(),
            view_id: "main".into(),
            label: "Live Scope".into(),
            mode: "panel".into(),
            placements: vec!["tab".into(), "sidebar".into()],
            port_binding: "required".into(),
        };
        assert_eq!(
            serde_json::from_value::<RemotePluginViewEntryDto>(
                serde_json::to_value(&view_entry).unwrap()
            )
            .unwrap(),
            view_entry
        );

        let session = RemoteViewSessionDto {
            remote_instance_id: "inst-9".into(),
            document_id: "doc-9".into(),
            plugin_id: "scope".into(),
            plugin_name: "Scope".into(),
            install_generation: "gen-2".into(),
            view_id: "main".into(),
            label: "Live Scope".into(),
            entry: "index.js".into(),
            styles: vec!["style.css".into()],
            assets: vec![RemoteViewAssetDto {
                rel_path: "index.js".into(),
                mime: "application/javascript".into(),
                data_base64: "Y29uc29sZS5sb2coMSk=".into(),
            }],
        };
        assert_eq!(
            serde_json::from_value::<RemoteViewSessionDto>(
                serde_json::to_value(&session).unwrap()
            )
            .unwrap(),
            session
        );

        let event_page = RemoteViewEventPageDto {
            remote_instance_id: "inst-9".into(),
            latest_seq: 10,
            next_seq: 11,
            closed: false,
            events: vec![RemoteViewEventDto {
                seq: 10,
                kind: "pick-artifact".into(),
                payload: serde_json::json!({"accept": [".bin"]}),
            }],
        };
        assert_eq!(
            serde_json::from_value::<RemoteViewEventPageDto>(
                serde_json::to_value(&event_page).unwrap()
            )
            .unwrap(),
            event_page
        );
    }
}
