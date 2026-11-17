//! Stand-alone `hypercom-cli` client for the explicitly enabled local automation host.
//!
//! This module deliberately does not open or emulate a serial port.  It connects to
//! the host's loopback JSON-lines endpoint and reports the host's authoritative result.
//! A missing endpoint, a dropped connection, and an unknown write outcome are errors;
//! this client never blindly retries a request which may have reached the device.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fmt;
use std::io::{self, Read};
use std::net::ToSocketAddrs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::time::timeout;

pub const CLI_VERSION: &str = env!("CARGO_PKG_VERSION");
/// The host adapter intentionally binds loopback only.  The port is configurable so
/// a host can choose an ephemeral/managed port without requiring a new CLI build.
pub const DEFAULT_ENDPOINT: &str = "127.0.0.1:39071";
pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 64 * 1024;

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Local,
    Alias(String),
}

impl Target {
    fn parse(value: &str) -> Result<Self, CliError> {
        if value == "local" {
            return Ok(Self::Local);
        }
        if value.is_empty()
            || value.len() > 128
            || value.chars().any(|c| c.is_control() || c.is_whitespace())
        {
            return Err(CliError::usage("target must be local or a non-empty alias"));
        }
        Ok(Self::Alias(value.to_owned()))
    }

    #[allow(dead_code)]
    fn host_id(&self) -> &str {
        match self {
            Self::Local => "local",
            Self::Alias(value) => value,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputMode {
    Json,
    Ndjson,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LineEnding {
    None,
    Lf,
    Cr,
    Crlf,
}

impl LineEnding {
    fn parse(value: &str) -> Result<Self, CliError> {
        match value.to_ascii_lowercase().as_str() {
            "none" => Ok(Self::None),
            "lf" | "\\n" => Ok(Self::Lf),
            "cr" | "\\r" => Ok(Self::Cr),
            "crlf" | "\\r\\n" => Ok(Self::Crlf),
            _ => Err(CliError::usage("ending must be one of none, lf, cr, crlf")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendInput {
    Text(String),
    Hex(Vec<u8>),
    Stdin,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendOptions {
    pub port: String,
    pub input: SendInput,
    pub ending: LineEnding,
    pub lease_id: Option<String>,
    pub fence: Option<u64>,
    pub connection_generation: Option<u64>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Status {
        timeout_ms: Option<u64>,
    },
    PortsList {
        timeout_ms: Option<u64>,
    },
    Monitor {
        port: Option<String>,
        watch: bool,
        timeout_ms: Option<u64>,
    },
    Send(SendOptions),
    ControlAcquire {
        port: String,
        connection_generation: Option<u64>,
        ttl_ms: u64,
        timeout_ms: Option<u64>,
    },
    ControlRelease {
        port: String,
        lease_id: String,
        fence: u64,
        connection_generation: Option<u64>,
        timeout_ms: Option<u64>,
    },
    OperationGet {
        request_id: String,
        timeout_ms: Option<u64>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cli {
    pub target: Target,
    pub endpoint: String,
    pub output: OutputMode,
    pub command: Command,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseAction {
    Run(Cli),
    Help,
    Version,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
#[repr(u8)]
pub enum ExitCode {
    Ok = 0,
    Usage = 2,
    Unavailable = 3,
    Protocol = 4,
    Remote = 5,
    Cancelled = 6,
    Unknown = 7,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliError {
    pub code: String,
    pub message: String,
    pub exit_code: ExitCode,
    pub request_id: Option<String>,
}

impl CliError {
    fn usage(message: impl Into<String>) -> Self {
        Self {
            code: "INVALID_ARGUMENT".into(),
            message: message.into(),
            exit_code: ExitCode::Usage,
            request_id: None,
        }
    }

    fn protocol(message: impl Into<String>) -> Self {
        Self {
            code: "PROTOCOL_ERROR".into(),
            message: message.into(),
            exit_code: ExitCode::Protocol,
            request_id: None,
        }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: "HOST_UNAVAILABLE".into(),
            message: message.into(),
            exit_code: ExitCode::Unavailable,
            request_id: None,
        }
    }

    fn remote(
        code: impl Into<String>,
        message: impl Into<String>,
        request_id: Option<String>,
    ) -> Self {
        let code = code.into();
        let exit_code = if code == "OUTCOME_UNKNOWN" {
            ExitCode::Unknown
        } else {
            ExitCode::Remote
        };
        Self {
            code,
            message: message.into(),
            exit_code,
            request_id,
        }
    }

    fn unsupported(message: impl Into<String>) -> Self {
        Self::remote("UNSUPPORTED_CAPABILITY", message, None)
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CliError {}

fn parse_u64(value: &str, name: &str) -> Result<u64, CliError> {
    value
        .parse::<u64>()
        .map_err(|_| CliError::usage(format!("{name} must be an unsigned integer")))
}

fn take_value(args: &[String], index: &mut usize, option: &str) -> Result<String, CliError> {
    *index += 1;
    args.get(*index)
        .cloned()
        .ok_or_else(|| CliError::usage(format!("{option} requires a value")))
}

fn set_timeout(slot: &mut Option<u64>, value: String) -> Result<(), CliError> {
    let parsed = parse_u64(&value, "timeout")?;
    if parsed == 0 {
        return Err(CliError::usage("timeout must be greater than zero"));
    }
    *slot = Some(parsed);
    Ok(())
}

fn parse_common(
    args: &[String],
    index: &mut usize,
    target: &mut Target,
    endpoint: &mut String,
    output: &mut OutputMode,
) -> Result<bool, CliError> {
    let arg = &args[*index];
    match arg.as_str() {
        "--target" => *target = Target::parse(&take_value(args, index, "--target")?)?,
        "--endpoint" => *endpoint = take_value(args, index, "--endpoint")?,
        "--json" => *output = OutputMode::Json,
        "--format" => {
            let value = take_value(args, index, "--format")?;
            *output = match value.as_str() {
                "json" => OutputMode::Json,
                "ndjson" => OutputMode::Ndjson,
                _ => return Err(CliError::usage("format must be json or ndjson")),
            };
        }
        _ => return Ok(false),
    }
    Ok(true)
}

/// Parse the CLI without touching the network, filesystem, or serial subsystem.
pub fn parse_args<I>(iter: I) -> Result<ParseAction, CliError>
where
    I: IntoIterator<Item = String>,
{
    let args: Vec<String> = iter.into_iter().collect();
    if args.is_empty() {
        return Err(CliError::usage(
            "a command is required; use --help for usage",
        ));
    }
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        return Ok(ParseAction::Help);
    }
    if args.iter().any(|arg| arg == "--version" || arg == "-V") {
        return Ok(ParseAction::Version);
    }

    let mut target = Target::Local;
    let mut endpoint = std::env::var("HYPERCOM_AUTOMATION_ENDPOINT")
        .unwrap_or_else(|_| DEFAULT_ENDPOINT.to_owned());
    let mut output = OutputMode::Json;
    let mut index = 0;
    while index < args.len() {
        if !parse_common(&args, &mut index, &mut target, &mut endpoint, &mut output)? {
            break;
        }
        index += 1;
    }
    let command_name = args
        .get(index)
        .ok_or_else(|| CliError::usage("a command is required; use --help for usage"))?
        .as_str();
    index += 1;

    let command = match command_name {
        "status" => parse_status(&args, &mut index, &mut target, &mut endpoint, &mut output)?,
        "ports" => parse_ports(&args, &mut index, &mut target, &mut endpoint, &mut output)?,
        "monitor" | "watch" => parse_monitor(
            &args,
            &mut index,
            &mut target,
            &mut endpoint,
            &mut output,
            command_name == "watch",
        )?,
        "send" => parse_send(&args, &mut index, &mut target, &mut endpoint, &mut output)?,
        "control" => parse_control(&args, &mut index, &mut target, &mut endpoint, &mut output)?,
        "operation" => parse_operation(&args, &mut index, &mut target, &mut endpoint, &mut output)?,
        _ => return Err(CliError::usage(format!("unknown command: {command_name}"))),
    };
    if index != args.len() {
        return Err(CliError::usage(format!(
            "unexpected argument: {}",
            args[index]
        )));
    }
    Ok(ParseAction::Run(Cli {
        target,
        endpoint,
        output,
        command,
    }))
}

fn parse_status(
    args: &[String],
    index: &mut usize,
    target: &mut Target,
    endpoint: &mut String,
    output: &mut OutputMode,
) -> Result<Command, CliError> {
    let timeout = parse_trailing(args, index, target, endpoint, output)?;
    Ok(Command::Status {
        timeout_ms: timeout,
    })
}

fn parse_ports(
    args: &[String],
    index: &mut usize,
    target: &mut Target,
    endpoint: &mut String,
    output: &mut OutputMode,
) -> Result<Command, CliError> {
    let sub = args.get(*index).map(String::as_str);
    if sub != Some("list") {
        return Err(CliError::usage("ports requires the list subcommand"));
    }
    *index += 1;
    let timeout = parse_trailing(args, index, target, endpoint, output)?;
    Ok(Command::PortsList {
        timeout_ms: timeout,
    })
}

fn parse_monitor(
    args: &[String],
    index: &mut usize,
    target: &mut Target,
    endpoint: &mut String,
    output: &mut OutputMode,
    watch: bool,
) -> Result<Command, CliError> {
    let mut port = None;
    let mut timeout = None;
    while *index < args.len() {
        if parse_common(args, index, target, endpoint, output)? {
            *index += 1;
            continue;
        }
        match args[*index].as_str() {
            "--port" => port = Some(take_value(args, index, "--port")?),
            "--timeout-ms" => set_timeout(&mut timeout, take_value(args, index, "--timeout-ms")?)?,
            "--timeout" => set_timeout(&mut timeout, take_value(args, index, "--timeout")?)?,
            _ => {
                return Err(CliError::usage(format!(
                    "unexpected argument: {}",
                    args[*index]
                )))
            }
        }
        *index += 1;
    }
    *output = OutputMode::Ndjson;
    Ok(Command::Monitor {
        port,
        watch,
        timeout_ms: timeout,
    })
}

fn parse_send(
    args: &[String],
    index: &mut usize,
    target: &mut Target,
    endpoint: &mut String,
    output: &mut OutputMode,
) -> Result<Command, CliError> {
    let mut port = None;
    let mut input = None;
    let mut ending = LineEnding::None;
    let mut lease_id = None;
    let mut fence = None;
    let mut connection_generation = None;
    let mut timeout = None;
    while *index < args.len() {
        if parse_common(args, index, target, endpoint, output)? {
            *index += 1;
            continue;
        }
        match args[*index].as_str() {
            "--port" => port = Some(take_value(args, index, "--port")?),
            "--text" => {
                if input.is_some() {
                    return Err(CliError::usage(
                        "--text, --hex, and --stdin are mutually exclusive",
                    ));
                }
                input = Some(SendInput::Text(take_value(args, index, "--text")?));
            }
            "--hex" => {
                if input.is_some() {
                    return Err(CliError::usage(
                        "--text, --hex, and --stdin are mutually exclusive",
                    ));
                }
                let value = take_value(args, index, "--hex")?;
                input = Some(SendInput::Hex(parse_hex(&value)?));
            }
            "--stdin" => {
                if input.is_some() {
                    return Err(CliError::usage(
                        "--text, --hex, and --stdin are mutually exclusive",
                    ));
                }
                input = Some(SendInput::Stdin);
            }
            "--ending" | "--line-ending" => {
                ending = LineEnding::parse(&take_value(args, index, "--ending")?)?
            }
            "--lease-id" => lease_id = Some(take_value(args, index, "--lease-id")?),
            "--fence" => fence = Some(parse_u64(&take_value(args, index, "--fence")?, "fence")?),
            "--connection-generation" => {
                connection_generation = Some(parse_u64(
                    &take_value(args, index, "--connection-generation")?,
                    "connection-generation",
                )?)
            }
            "--timeout-ms" | "--timeout" => {
                set_timeout(&mut timeout, take_value(args, index, "--timeout")?)?
            }
            _ => {
                return Err(CliError::usage(format!(
                    "unexpected argument: {}",
                    args[*index]
                )))
            }
        }
        *index += 1;
    }
    let port = port.ok_or_else(|| CliError::usage("send requires --port"))?;
    let input = input
        .ok_or_else(|| CliError::usage("send requires exactly one of --text, --hex, or --stdin"))?;
    if fence.is_some() != lease_id.is_some() {
        return Err(CliError::usage(
            "--lease-id and --fence must be supplied together",
        ));
    }
    Ok(Command::Send(SendOptions {
        port,
        input,
        ending,
        lease_id,
        fence,
        connection_generation,
        timeout_ms: timeout,
    }))
}

fn parse_control(
    args: &[String],
    index: &mut usize,
    target: &mut Target,
    endpoint: &mut String,
    output: &mut OutputMode,
) -> Result<Command, CliError> {
    let action = args
        .get(*index)
        .map(String::as_str)
        .ok_or_else(|| CliError::usage("control requires acquire or release"))?;
    *index += 1;
    let mut port = None;
    let mut lease_id = None;
    let mut fence = None;
    let mut connection_generation = None;
    let mut ttl_ms = 3_000;
    let mut timeout = None;
    // control parser: ttl is consumed below
    while *index < args.len() {
        if parse_common(args, index, target, endpoint, output)? {
            *index += 1;
            continue;
        }
        match args[*index].as_str() {
            "--port" => port = Some(take_value(args, index, "--port")?),
            "--lease-id" => lease_id = Some(take_value(args, index, "--lease-id")?),
            "--fence" => fence = Some(parse_u64(&take_value(args, index, "--fence")?, "fence")?),
            "--connection-generation" => {
                connection_generation = Some(parse_u64(
                    &take_value(args, index, "--connection-generation")?,
                    "connection-generation",
                )?)
            }
            "--ttl-ms" => {
                ttl_ms = parse_u64(&take_value(args, index, "--ttl-ms")?, "ttl-ms")?;
                if !(1..=60_000).contains(&ttl_ms) {
                    return Err(CliError::usage("ttl-ms must be between 1 and 60000"));
                }
            }
            "--timeout-ms" | "--timeout" => {
                set_timeout(&mut timeout, take_value(args, index, "--timeout")?)?
            }
            _ => {
                return Err(CliError::usage(format!(
                    "unexpected argument: {}",
                    args[*index]
                )))
            }
        }
        *index += 1;
    }
    let port = port.ok_or_else(|| CliError::usage("control requires --port"))?;
    match action {
        "acquire" => Ok(Command::ControlAcquire {
            port,
            connection_generation,
            ttl_ms,
            timeout_ms: timeout,
        }),
        "release" => Ok(Command::ControlRelease {
            port,
            lease_id: lease_id
                .ok_or_else(|| CliError::usage("control release requires --lease-id"))?,
            fence: fence.ok_or_else(|| CliError::usage("control release requires --fence"))?,
            connection_generation,
            timeout_ms: timeout,
        }),
        _ => Err(CliError::usage("control requires acquire or release")),
    }
}

fn parse_operation(
    args: &[String],
    index: &mut usize,
    target: &mut Target,
    endpoint: &mut String,
    output: &mut OutputMode,
) -> Result<Command, CliError> {
    if args.get(*index).map(String::as_str) != Some("get") {
        return Err(CliError::usage("operation requires the get subcommand"));
    }
    *index += 1;
    let mut request_id = None;
    let mut timeout = None;
    while *index < args.len() {
        if parse_common(args, index, target, endpoint, output)? {
            *index += 1;
            continue;
        }
        match args[*index].as_str() {
            "--request-id" => request_id = Some(take_value(args, index, "--request-id")?),
            "--timeout-ms" | "--timeout" => {
                set_timeout(&mut timeout, take_value(args, index, "--timeout")?)?
            }
            _ => {
                return Err(CliError::usage(format!(
                    "unexpected argument: {}",
                    args[*index]
                )))
            }
        }
        *index += 1;
    }
    Ok(Command::OperationGet {
        request_id: request_id
            .ok_or_else(|| CliError::usage("operation get requires --request-id"))?,
        timeout_ms: timeout,
    })
}

fn parse_trailing(
    args: &[String],
    index: &mut usize,
    target: &mut Target,
    endpoint: &mut String,
    output: &mut OutputMode,
) -> Result<Option<u64>, CliError> {
    let mut timeout = None;
    while *index < args.len() {
        if parse_common(args, index, target, endpoint, output)? {
            *index += 1;
            continue;
        }
        match args[*index].as_str() {
            "--timeout-ms" | "--timeout" => {
                set_timeout(&mut timeout, take_value(args, index, "--timeout")?)?
            }
            _ => {
                return Err(CliError::usage(format!(
                    "unexpected argument: {}",
                    args[*index]
                )))
            }
        }
        *index += 1;
    }
    Ok(timeout)
}

/// Strict HEX parser: whitespace is ignored, but every remaining character must be
/// hexadecimal and the number of nibbles must be even.  Empty input is valid (the
/// host decides whether a zero-byte write is meaningful), and no nibble is padded.
pub fn parse_hex(value: &str) -> Result<Vec<u8>, CliError> {
    let chars: Vec<(usize, u8)> = value
        .bytes()
        .enumerate()
        .filter(|(_, byte)| !byte.is_ascii_whitespace())
        .collect();
    if !chars.len().is_multiple_of(2) {
        return Err(CliError::usage(
            "HEX input must contain an even number of digits",
        ));
    }
    fn nibble(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }
    let mut result = Vec::with_capacity(chars.len() / 2);
    for pair in chars.chunks(2) {
        let hi = nibble(pair[0].1).ok_or_else(|| {
            CliError::usage(format!("invalid HEX character at byte {}", pair[0].0))
        })?;
        let lo = nibble(pair[1].1).ok_or_else(|| {
            CliError::usage(format!("invalid HEX character at byte {}", pair[1].0))
        })?;
        result.push((hi << 4) | lo);
    }
    Ok(result)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireTarget {
    host_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_port_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WirePrecondition {
    #[serde(skip_serializing_if = "Option::is_none")]
    server_epoch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    connection_generation: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireControl {
    lease_id: String,
    fence: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireRequest {
    protocol_version: u32,
    request_id: String,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<WireTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    precondition: Option<WirePrecondition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    control: Option<WireControl>,
    #[serde(skip_serializing_if = "Option::is_none")]
    timeout_ms: Option<u64>,
    params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum WireResponse {
    Ok {
        protocol_version: u32,
        server_epoch: String,
        request_id: String,
        result: Value,
    },
    Error {
        protocol_version: u32,
        server_epoch: String,
        request_id: Option<String>,
        error: WireError,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireError {
    code: String,
    message: String,
    retryable: bool,
    #[serde(default)]
    operation_id: Option<String>,
}

#[derive(Debug, Clone)]
struct HandshakeInfo {
    server_epoch: String,
    /// Host identity is learned from host.status before mutating requests.
    host_id: Option<String>,
    capabilities: Vec<String>,
    max_frame_bytes: usize,
}

fn next_request_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!(
        "cli-{}-{}-{}",
        std::process::id(),
        millis,
        REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn encode_request(request: &WireRequest, max_frame_bytes: usize) -> Result<Vec<u8>, CliError> {
    let mut encoded = serde_json::to_vec(request)
        .map_err(|e| CliError::protocol(format!("encode request: {e}")))?;
    // LF is framing, and is not counted by the service's configured frame limit.
    if encoded.len() > max_frame_bytes {
        return Err(CliError::protocol("request exceeds endpoint frame limit"));
    }
    encoded.push(b'\n');
    Ok(encoded)
}

pub struct WireClient {
    reader: BufReader<OwnedReadHalf>,
    writer: OwnedWriteHalf,
    handshake: HandshakeInfo,
}

impl WireClient {
    pub async fn connect(endpoint: &str) -> Result<Self, CliError> {
        let endpoint = endpoint.trim();
        if endpoint.is_empty() {
            return Err(CliError::usage("endpoint cannot be empty"));
        }
        // Resolve first to reject accidental non-loopback defaults. Alias targets
        // select a host identity; this first slice still connects to local loopback.
        let mut addrs = endpoint.to_socket_addrs().map_err(|e| {
            CliError::unavailable(format!("cannot resolve endpoint {endpoint}: {e}"))
        })?;
        let addr = addrs
            .next()
            .ok_or_else(|| CliError::unavailable("endpoint has no address"))?;
        let stream = TcpStream::connect(addr).await.map_err(|e| {
            CliError::unavailable(format!(
                "automation endpoint unavailable at {endpoint}: {e}"
            ))
        })?;
        let (read_half, write_half) = stream.into_split();
        let mut client = Self {
            reader: BufReader::new(read_half),
            writer: write_half,
            handshake: HandshakeInfo {
                server_epoch: String::new(),
                host_id: None,
                capabilities: Vec::new(),
                max_frame_bytes: MAX_FRAME_BYTES,
            },
        };
        let request_id = next_request_id();
        let request = WireRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.clone(),
            method: "handshake".into(),
            target: None,
            precondition: None,
            control: None,
            timeout_ms: Some(3_000),
            params: Value::Null,
        };
        let response = client.exchange(&request, false, Some(3_000)).await?;
        match response {
            WireResponse::Ok {
                protocol_version,
                server_epoch,
                request_id: got_id,
                result,
            } => {
                if protocol_version != PROTOCOL_VERSION {
                    return Err(CliError::protocol("unsupported endpoint protocol version"));
                }
                if got_id != request_id {
                    return Err(CliError::protocol("handshake response requestId mismatch"));
                }
                let capabilities = result
                    .get("capabilities")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                let max_frame_bytes = result
                    .get("maxFrameBytes")
                    .and_then(Value::as_u64)
                    .unwrap_or(MAX_FRAME_BYTES as u64)
                    as usize;
                if max_frame_bytes == 0 || max_frame_bytes > MAX_FRAME_BYTES {
                    return Err(CliError::protocol(
                        "endpoint advertised invalid maxFrameBytes",
                    ));
                }
                client.handshake = HandshakeInfo {
                    server_epoch,
                    host_id: None,
                    capabilities,
                    max_frame_bytes,
                };
                Ok(client)
            }
            WireResponse::Error { error, .. } => Err(CliError::remote(
                error.code,
                error.message,
                Some(request_id),
            )),
        }
    }

    async fn read_response(&mut self, wait_ms: Option<u64>) -> Result<WireResponse, CliError> {
        let mut frame = Vec::new();
        let read = async {
            self.reader
                .read_until(b'\n', &mut frame)
                .await
                .map_err(|e| CliError::unavailable(format!("read automation response: {e}")))
        };
        let count = match wait_ms {
            Some(ms) => timeout(Duration::from_millis(ms), read)
                .await
                .map_err(|_| {
                    CliError::remote(
                        "DEADLINE_EXCEEDED",
                        "timed out waiting for endpoint response",
                        None,
                    )
                })??,
            None => read.await?,
        };
        if count == 0 {
            return Err(CliError::unavailable(
                "automation endpoint disconnected before response",
            ));
        }
        if frame.last() == Some(&b'\n') {
            frame.pop();
        }
        if frame.last() == Some(&b'\r') {
            frame.pop();
        }
        if frame.len() > self.handshake.max_frame_bytes {
            return Err(CliError::protocol("endpoint response exceeds frame limit"));
        }
        serde_json::from_slice(&frame)
            .map_err(|e| CliError::protocol(format!("invalid endpoint response: {e}")))
    }

    async fn exchange(
        &mut self,
        request: &WireRequest,
        side_effect: bool,
        wait_ms: Option<u64>,
    ) -> Result<WireResponse, CliError> {
        let frame = encode_request(request, self.handshake.max_frame_bytes)?;
        self.writer.write_all(&frame).await.map_err(|e| {
            if side_effect {
                CliError::remote(
                    "OUTCOME_UNKNOWN",
                    format!("request may have reached host; write failed: {e}"),
                    Some(request.request_id.clone()),
                )
            } else {
                CliError::unavailable(format!("write automation request: {e}"))
            }
        })?;
        self.writer.flush().await.map_err(|e| {
            if side_effect {
                CliError::remote(
                    "OUTCOME_UNKNOWN",
                    format!("request may have reached host; flush failed: {e}"),
                    Some(request.request_id.clone()),
                )
            } else {
                CliError::unavailable(format!("flush automation request: {e}"))
            }
        })?;
        match self.read_response(wait_ms).await {
            Ok(response) => Ok(response),
            Err(error) if side_effect && error.code == "HOST_UNAVAILABLE" => Err(CliError::remote(
                "OUTCOME_UNKNOWN",
                error.message,
                Some(request.request_id.clone()),
            )),
            Err(error) => Err(error),
        }
    }

    fn target(&self, target: &Target, port: Option<&str>) -> Option<WireTarget> {
        let host_id = match target {
            Target::Local => self.handshake.host_id.as_deref().unwrap_or("local"),
            Target::Alias(alias) => alias,
        };
        Some(WireTarget {
            host_id: host_id.to_owned(),
            native_port_id: port.map(str::to_owned),
        })
    }

    #[allow(dead_code)]
    async fn resolve_local_identity(&mut self, target: &Target) -> Result<(), CliError> {
        if !matches!(target, Target::Local) || self.handshake.host_id.is_some() {
            return Ok(());
        }
        let (_, status) = self
            .call(
                target,
                "host.status",
                None,
                Value::Null,
                None,
                None,
                None,
                false,
            )
            .await?;
        let host_id = status
            .get("hostId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| CliError::protocol("host.status did not return hostId"))?;
        self.handshake.host_id = Some(host_id.to_owned());
        Ok(())
    }

    #[allow(dead_code)]
    async fn resolve_generation(
        &mut self,
        target: &Target,
        port: &str,
        generation: Option<u64>,
        timeout_ms: Option<u64>,
    ) -> Result<u64, CliError> {
        self.resolve_local_identity(target).await?;
        if let Some(generation) = generation {
            return Ok(generation);
        }
        let (_, listing) = self
            .call(
                target,
                "ports.list",
                None,
                Value::Null,
                None,
                None,
                timeout_ms,
                false,
            )
            .await?;
        let items = listing
            .get("ports")
            .and_then(Value::as_array)
            .ok_or_else(|| CliError::protocol("ports.list did not return ports"))?;
        let item = items.iter().find(|item| {
            item.get("name").and_then(Value::as_str) == Some(port)
                || item
                    .get("target")
                    .and_then(|target| target.get("nativePortId"))
                    .and_then(Value::as_str)
                    == Some(port)
        });
        let value = item
            .and_then(|item| item.get("connectionGeneration"))
            .ok_or_else(|| {
                CliError::remote(
                    "PORT_NOT_FOUND",
                    format!("port {port} was not listed"),
                    None,
                )
            })?;
        match value {
            Value::String(value) => value
                .parse::<u64>()
                .map_err(|_| CliError::protocol("port connectionGeneration is not decimal")),
            Value::Number(value) => value
                .as_u64()
                .ok_or_else(|| CliError::protocol("port connectionGeneration is not unsigned")),
            _ => Err(CliError::protocol(
                "port connectionGeneration has invalid type",
            )),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn call(
        &mut self,
        target: &Target,
        method: &str,
        port: Option<&str>,
        params: Value,
        control: Option<WireControl>,
        connection_generation: Option<u64>,
        timeout_ms: Option<u64>,
        side_effect: bool,
    ) -> Result<(String, Value), CliError> {
        if method != "host.status"
            && method != "ports.list"
            && !self
                .handshake
                .capabilities
                .iter()
                .any(|item| item == method)
        {
            return Err(CliError::unsupported(format!(
                "endpoint does not advertise {method}"
            )));
        }
        let id = next_request_id();
        let request = WireRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: id.clone(),
            method: method.to_owned(),
            target: if matches!(method, "host.status" | "ports.list" | "operations.get") {
                None
            } else {
                self.target(target, port)
            },
            precondition: Some(WirePrecondition {
                server_epoch: Some(self.handshake.server_epoch.clone()),
                connection_generation: connection_generation.map(|value| value.to_string()),
            }),
            control,
            timeout_ms,
            params,
        };
        let response = self.exchange(&request, side_effect, timeout_ms).await?;
        match response {
            WireResponse::Ok {
                protocol_version,
                request_id,
                result,
                ..
            } => {
                if protocol_version != PROTOCOL_VERSION || request_id != id {
                    return Err(CliError::protocol(
                        "response envelope does not match request",
                    ));
                }
                if method == "host.status" {
                    if let Some(host_id) = result.get("hostId").and_then(Value::as_str) {
                        self.handshake.host_id = Some(host_id.to_owned());
                    }
                }
                Ok((id, result))
            }
            WireResponse::Error {
                protocol_version,
                request_id,
                error,
                ..
            } => {
                if protocol_version != PROTOCOL_VERSION {
                    return Err(CliError::protocol("unsupported endpoint protocol version"));
                }
                if request_id.as_deref() != Some(id.as_str()) && request_id.is_some() {
                    return Err(CliError::protocol(
                        "error response requestId does not match request",
                    ));
                }
                Err(CliError::remote(
                    error.code,
                    error.message,
                    request_id.or(Some(id)),
                ))
            }
        }
    }

    pub async fn execute(&mut self, cli: &Cli) -> Result<Vec<Value>, CliError> {
        match &cli.command {
            Command::Status { timeout_ms } => Ok(vec![
                self.call(
                    &cli.target,
                    "host.status",
                    None,
                    Value::Null,
                    None,
                    None,
                    *timeout_ms,
                    false,
                )
                .await?
                .1,
            ]),
            Command::PortsList { timeout_ms } => Ok(vec![
                self.call(
                    &cli.target,
                    "ports.list",
                    None,
                    Value::Null,
                    None,
                    None,
                    *timeout_ms,
                    false,
                )
                .await?
                .1,
            ]),
            Command::Monitor { .. } => Err(CliError::unsupported(
                "monitor/watch is not enabled by this host adapter",
            )),
            Command::ControlAcquire {
                port,
                connection_generation,
                ttl_ms,
                timeout_ms,
            } => Ok(vec![
                self.call(
                    &cli.target,
                    "control.acquire",
                    Some(port),
                    json!({"ttlMs": ttl_ms}),
                    None,
                    *connection_generation,
                    *timeout_ms,
                    true,
                )
                .await?
                .1,
            ]),
            Command::ControlRelease {
                port,
                lease_id,
                fence,
                connection_generation,
                timeout_ms,
            } => {
                let control = WireControl {
                    lease_id: lease_id.clone(),
                    fence: fence.to_string(),
                };
                Ok(vec![
                    self.call(
                        &cli.target,
                        "control.release",
                        Some(port),
                        Value::Null,
                        Some(control),
                        *connection_generation,
                        *timeout_ms,
                        true,
                    )
                    .await?
                    .1,
                ])
            }
            Command::OperationGet {
                request_id,
                timeout_ms,
            } => Ok(vec![
                self.call(
                    &cli.target,
                    "operations.get",
                    None,
                    json!({"requestId": request_id}),
                    None,
                    None,
                    *timeout_ms,
                    false,
                )
                .await?
                .1,
            ]),
            Command::Send(options) => {
                let params = match &options.input {
                    SendInput::Text(text) => json!({
                        "data": text,
                        "isHex": false,
                        "appendLineEnding": line_ending_wire(options.ending),
                    }),
                    SendInput::Hex(bytes) => json!({
                        "data": hex_encode(bytes),
                        "isHex": true,
                        // The host codec intentionally ignores line endings for HEX.
                        "appendLineEnding": "None",
                    }),
                    SendInput::Stdin => {
                        let mut bytes = Vec::new();
                        io::stdin()
                            .read_to_end(&mut bytes)
                            .map_err(|e| CliError::usage(format!("read stdin: {e}")))?;
                        json!({
                            "dataBase64": base64_encode(&bytes),
                            "isHex": false,
                            "appendLineEnding": line_ending_wire(options.ending),
                        })
                    }
                };
                let control =
                    options
                        .lease_id
                        .as_ref()
                        .zip(options.fence)
                        .map(|(lease_id, fence)| WireControl {
                            lease_id: lease_id.clone(),
                            fence: fence.to_string(),
                        });
                Ok(vec![
                    self.call(
                        &cli.target,
                        "serial.send",
                        Some(&options.port),
                        params,
                        control,
                        options.connection_generation,
                        options.timeout_ms,
                        true,
                    )
                    .await?
                    .1,
                ])
            }
        }
    }

    pub async fn execute_stream(&mut self, cli: &Cli) -> Result<(), CliError> {
        let Command::Monitor {
            port, timeout_ms, ..
        } = &cli.command
        else {
            return Ok(());
        };
        let (request_id, _) = self
            .call(
                &cli.target,
                "events.subscribe",
                port.as_deref(),
                json!({"portId": port}),
                None,
                None,
                *timeout_ms,
                false,
            )
            .await?;
        loop {
            let response = self.read_response(*timeout_ms).await?;
            let value =
                serde_json::to_value(response).map_err(|e| CliError::protocol(e.to_string()))?;
            println!(
                "{}",
                serde_json::to_string(&json!({"requestId": request_id, "event": value})).unwrap()
            );
        }
    }
}

fn line_ending_wire(ending: LineEnding) -> &'static str {
    match ending {
        LineEnding::None => "None",
        LineEnding::Lf => "\\n",
        LineEnding::Cr => "\\r",
        LineEnding::Crlf => "\\r\\n",
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().saturating_add(2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = *chunk.get(1).unwrap_or(&0);
        let c = *chunk.get(2).unwrap_or(&0);
        output.push(ALPHABET[(a >> 2) as usize] as char);
        output.push(ALPHABET[(((a & 0x03) << 4) | (b >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[(((b & 0x0f) << 2) | (c >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[(c & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

pub const HELP: &str = "hypercom-cli (client only)\n\nUsage: hypercom-cli [--target local|ALIAS] [--endpoint HOST:PORT] COMMAND\n\nCommands:\n  status\n  ports list\n  monitor|watch [--port PORT]   (streaming NDJSON; host capability required)\n  send --port PORT (--text TEXT | --hex HEX | --stdin) [--ending none|lf|cr|crlf]\n  control acquire --port PORT\n  control release --port PORT --lease-id ID --fence N\n  operation get --request-id ID\n\nThe CLI only connects to a host automation endpoint; it is not a standalone serial driver.\n";

fn error_json(error: &CliError) -> Value {
    let mut value =
        json!({ "ok": false, "error": { "code": error.code, "message": error.message } });
    if let Some(request_id) = &error.request_id {
        value["requestId"] = json!(request_id);
    }
    value
}

fn print_error(error: &CliError) -> ExitCode {
    eprintln!("hypercom-cli: {error}");
    println!(
        "{}",
        serde_json::to_string(&error_json(error)).unwrap_or_else(|_| "{\"ok\":false}".into())
    );
    error.exit_code
}

pub fn run<I>(iter: I) -> i32
where
    I: IntoIterator<Item = String>,
{
    match parse_args(iter) {
        Ok(ParseAction::Help) => {
            print!("{HELP}");
            0
        }
        Ok(ParseAction::Version) => {
            println!("hypercom-cli {CLI_VERSION}");
            0
        }
        Ok(ParseAction::Run(cli)) => {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    return print_error(&CliError::unavailable(format!(
                        "runtime unavailable: {error}"
                    ))) as i32
                }
            };
            runtime.block_on(async move {
                let mut client = match WireClient::connect(&cli.endpoint).await {
                    Ok(client) => client,
                    Err(error) => return print_error(&error) as i32,
                };
                if matches!(&cli.command, Command::Monitor { .. }) {
                    match client.execute_stream(&cli).await {
                        Ok(()) => 0,
                        Err(error) => print_error(&error) as i32,
                    }
                } else {
                    match client.execute(&cli).await {
                        Ok(results) => {
                            for result in results {
                                println!(
                                    "{}",
                                    serde_json::to_string(&json!({"ok": true, "result": result}))
                                        .unwrap()
                                );
                            }
                            0
                        }
                        Err(error) => print_error(&error) as i32,
                    }
                }
            })
        }
        Err(error) => print_error(&error) as i32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).into()).collect()
    }

    #[test]
    fn parses_target_and_status() {
        let ParseAction::Run(cli) = parse_args(args(&["--target", "lab", "status"])).unwrap()
        else {
            panic!()
        };
        assert_eq!(cli.target, Target::Alias("lab".into()));
        assert_eq!(cli.endpoint, DEFAULT_ENDPOINT);
        assert!(matches!(cli.command, Command::Status { .. }));
    }

    #[test]
    fn send_inputs_are_mutually_exclusive_and_ending_is_explicit() {
        let ParseAction::Run(cli) = parse_args(args(&[
            "send", "--port", "COM3", "--text", "x", "--ending", "crlf",
        ]))
        .unwrap() else {
            panic!()
        };
        let Command::Send(options) = cli.command else {
            panic!()
        };
        assert_eq!(options.ending, LineEnding::Crlf);
        assert_eq!(options.input, SendInput::Text("x".into()));
        assert!(parse_args(args(&[
            "send", "--port", "COM3", "--text", "x", "--hex", "00"
        ]))
        .is_err());
    }

    #[test]
    fn hex_requires_even_valid_digits_without_padding() {
        assert_eq!(parse_hex("48 65 6c").unwrap(), b"Hel");
        assert!(parse_hex("4").is_err());
        assert!(parse_hex("GG").is_err());
        assert_eq!(parse_hex("").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn parses_control_and_operation_commands() {
        let ParseAction::Run(cli) = parse_args(args(&[
            "control",
            "release",
            "--port",
            "COM3",
            "--lease-id",
            "l",
            "--fence",
            "9",
        ]))
        .unwrap() else {
            panic!()
        };
        assert!(matches!(
            cli.command,
            Command::ControlRelease { fence: 9, .. }
        ));
        let ParseAction::Run(cli) =
            parse_args(args(&["operation", "get", "--request-id", "r"])).unwrap()
        else {
            panic!()
        };
        assert!(
            matches!(cli.command, Command::OperationGet { request_id, .. } if request_id == "r")
        );
    }

    #[test]
    fn request_shape_uses_nested_fields_and_decimal_fence() {
        let request = WireRequest {
            protocol_version: 1,
            request_id: "r".into(),
            method: "serial.send".into(),
            target: Some(WireTarget {
                host_id: "local".into(),
                native_port_id: Some("COM3".into()),
            }),
            precondition: Some(WirePrecondition {
                server_epoch: Some("e".into()),
                connection_generation: Some("7".into()),
            }),
            control: Some(WireControl {
                lease_id: "l".into(),
                fence: "18446744073709551615".into(),
            }),
            timeout_ms: Some(3000),
            params: json!({"dataBase64":"AA=="}),
        };
        let encoded =
            String::from_utf8(encode_request(&request, MAX_FRAME_BYTES).unwrap()).unwrap();
        assert!(encoded.ends_with("\n"));
        assert!(encoded.contains("\"connectionGeneration\":\"7\""));
        assert!(encoded.contains("\"fence\":\"18446744073709551615\""));
    }

    #[test]
    fn help_and_version_are_parse_actions() {
        assert_eq!(parse_args(args(&["--help"])).unwrap(), ParseAction::Help);
        assert_eq!(
            parse_args(args(&["--version"])).unwrap(),
            ParseAction::Version
        );
    }
}
