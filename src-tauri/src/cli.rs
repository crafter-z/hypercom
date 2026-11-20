//! Client for the opt-in experimental loopback automation host. The CLI does
//! not open serial ports, retry writes, or equate a missing reply with no effect.

use crate::wire::{
    decode_response, encode_request, valid_id, Control, ErrorCode, FrameReader, Handshake,
    Precondition, Request, Response, Target, TransportError, WireError, DEFAULT_MAX_FRAME_BYTES,
    HANDSHAKE_METHOD, MAX_FRAME_BYTES, PROTOCOL_VERSION,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fmt;
use std::io::{self, Read};
use std::net::{Ipv4Addr, SocketAddr};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::time::{timeout_at, Instant};

const DEFAULT_ENDPOINT: &str = "127.0.0.1:39071";
const DEFAULT_TIMEOUT_MS: u64 = 3_000;
const MAX_TIMEOUT_MS: u64 = 60_000;
const MAX_LEASE_MS: u64 = 5_000;
// The complete base64 request (including its target and lease) must also fit
// the negotiated frame; the input cap is independent of the peer's settings.
const MAX_STDIN_BYTES: usize = 48_000;

const HOST_STATUS: &str = "host.status";
const PORTS_LIST: &str = "ports.list";
const CONTROL_ACQUIRE: &str = "control.acquire";
const CONTROL_RELEASE: &str = "control.release";
const SERIAL_SEND: &str = "serial.send";
const OPERATIONS_GET: &str = "operations.get";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum ExitCode {
    Usage = 2,
    Unavailable = 3,
    Protocol = 4,
    Remote = 5,
    Cancelled = 6,
    Unknown = 7,
}

#[derive(Debug)]
struct CliError {
    exit_code: ExitCode,
    output: Value,
}

type CliResult<T> = Result<T, CliError>;

impl CliError {
    fn new(exit_code: ExitCode, code: &str, message: impl Into<String>) -> Self {
        Self {
            exit_code,
            output: json!({"ok": false, "error": {"code": code, "message": message.into()}}),
        }
    }

    fn usage(message: impl Into<String>) -> Self {
        Self::new(ExitCode::Usage, "INVALID_ARGUMENT", message)
    }

    fn protocol(message: impl Into<String>) -> Self {
        Self::new(ExitCode::Protocol, "PROTOCOL_ERROR", message)
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self::new(ExitCode::Unavailable, "HOST_UNAVAILABLE", message)
    }

    fn deadline(stage: &str) -> Self {
        Self::new(
            ExitCode::Unavailable,
            "DEADLINE_EXCEEDED",
            format!("command deadline expired during {stage}"),
        )
    }

    fn unsupported(message: impl Into<String>) -> Self {
        Self::new(ExitCode::Remote, "UNSUPPORTED_CAPABILITY", message)
    }

    fn wire(id: &str, error: WireError) -> Self {
        Self {
            exit_code: disposition(error.code),
            output: json!({"ok": false, "requestId": id, "error": error}),
        }
    }

    fn with_request_id(mut self, id: &str) -> Self {
        self.output["requestId"] = json!(id);
        self
    }

    fn unknown(id: &str, cause: impl fmt::Display) -> Self {
        let mut error = Self::new(
            ExitCode::Unknown,
            "OUTCOME_UNKNOWN",
            format!("send may have reached the device ({cause}); do not retry; use operation get with the original requestId"),
        ).with_request_id(id);
        error.output["error"]["retryable"] = json!(false);
        error.output["error"]["sideEffects"] = json!({"certainty": "unknown"});
        error
    }

    fn cleanup_warning(self) -> Value {
        let mut output = self.output["error"].clone();
        if let Some(id) = self.output.get("requestId") {
            output["requestId"] = id.clone();
        }
        output
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let error = &self.output["error"];
        write!(
            f,
            "{}: {}",
            error["code"].as_str().unwrap_or("CLI_ERROR"),
            error["message"]
                .as_str()
                .unwrap_or("automation command failed")
        )
    }
}

fn disposition(code: ErrorCode) -> ExitCode {
    match code {
        ErrorCode::Cancelled => ExitCode::Cancelled,
        ErrorCode::OutcomeUnknown => ExitCode::Unknown,
        _ => ExitCode::Remote,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LineEnding {
    None,
    Lf,
    Cr,
    Crlf,
}

impl LineEnding {
    fn parse(value: &str) -> CliResult<Self> {
        match value.to_ascii_lowercase().as_str() {
            "none" => Ok(Self::None),
            "lf" | "\\n" => Ok(Self::Lf),
            "cr" | "\\r" => Ok(Self::Cr),
            "crlf" | "\\r\\n" => Ok(Self::Crlf),
            _ => Err(CliError::usage("ending must be one of none, lf, cr, crlf")),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Lf => "lf",
            Self::Cr => "cr",
            Self::Crlf => "crlf",
        }
    }
}

#[derive(Debug)]
enum SendInput {
    Text(String),
    Hex(String),
    Stdin,
}

#[derive(Debug)]
struct SendOptions {
    port: String,
    input: SendInput,
    ending: LineEnding,
    generation: Option<u64>,
}

impl SendOptions {
    fn params(&self, stdin: impl Read) -> CliResult<Value> {
        Ok(match &self.input {
            SendInput::Text(text) => {
                json!({"mode": "text", "text": text, "lineEnding": self.ending.as_str()})
            }
            // Endings only apply to text. The host decodes the validated HEX.
            SendInput::Hex(hex) => json!({"mode": "hex", "hex": hex}),
            SendInput::Stdin => {
                let mut bytes = Vec::new();
                stdin
                    .take(MAX_STDIN_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|error| CliError::usage(format!("cannot read stdin: {error}")))?;
                if bytes.len() > MAX_STDIN_BYTES {
                    return Err(CliError::usage(format!(
                        "stdin exceeds {MAX_STDIN_BYTES} raw bytes"
                    )));
                }
                json!({"dataBase64": STANDARD.encode(bytes)})
            }
        })
    }
}

#[derive(Debug)]
enum Command {
    Status,
    PortsList,
    Send(SendOptions),
    OperationGet { request_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommandName {
    Status,
    PortsList,
    Send,
    OperationGet,
}

#[derive(Debug)]
struct Cli {
    endpoint: String,
    timeout_ms: u64,
    command: Command,
}

#[derive(Debug)]
enum ParseAction {
    Run(Cli),
    Help,
    Version,
}

fn take_value(args: &mut impl Iterator<Item = String>, option: &str) -> CliResult<String> {
    args.next()
        .ok_or_else(|| CliError::usage(format!("{option} requires a value")))
}

fn parse_u64(value: &str, name: &str) -> CliResult<u64> {
    if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) {
        if let Ok(value) = value.parse::<u64>() {
            return Ok(value);
        }
    }
    Err(CliError::usage(format!(
        "{name} must be an unsigned decimal integer"
    )))
}

fn normalize_hex(value: &str) -> CliResult<String> {
    let digits: String = value.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    if !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) || !digits.len().is_multiple_of(2) {
        return Err(CliError::usage(
            "HEX input must contain an even number of valid HEX digits",
        ));
    }
    Ok(digits)
}

fn parse_args(iter: impl IntoIterator<Item = String>) -> CliResult<ParseAction> {
    let mut args = iter.into_iter();
    let mut endpoint = std::env::var("HYPERCOM_AUTOMATION_ENDPOINT")
        .unwrap_or_else(|_| DEFAULT_ENDPOINT.to_owned());
    let mut command = None;
    let mut timeout_ms = DEFAULT_TIMEOUT_MS;
    let mut port = None;
    let mut input = None;
    let mut ending = LineEnding::None;
    let mut generation = None;
    let mut request_id = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => return Ok(ParseAction::Help),
            "--version" | "-V" => return Ok(ParseAction::Version),
            "--target" => {
                if take_value(&mut args, &arg)? != "local" {
                    return Err(CliError::usage(
                        "only --target local is supported; no remote alias resolution",
                    ));
                }
            }
            "--endpoint" => endpoint = take_value(&mut args, &arg)?,
            "--json" => (),
            "--format" => {
                if !matches!(take_value(&mut args, &arg)?.as_str(), "json" | "ndjson") {
                    return Err(CliError::usage("format must be json or ndjson"));
                }
            }
            "--timeout-ms" | "--timeout" => {
                timeout_ms = parse_u64(&take_value(&mut args, &arg)?, "timeout")?;
                if !(1..=MAX_TIMEOUT_MS).contains(&timeout_ms) {
                    return Err(CliError::usage(format!(
                        "timeout must be between 1 and {MAX_TIMEOUT_MS} ms"
                    )));
                }
            }
            "status" if command.is_none() => command = Some(CommandName::Status),
            "ports" if command.is_none() => {
                if args.next().as_deref() != Some("list") {
                    return Err(CliError::usage("ports requires the list subcommand"));
                }
                command = Some(CommandName::PortsList);
            }
            "send" if command.is_none() => command = Some(CommandName::Send),
            "operation" if command.is_none() => {
                if args.next().as_deref() != Some("get") {
                    return Err(CliError::usage("operation requires the get subcommand"));
                }
                command = Some(CommandName::OperationGet);
            }
            "monitor" | "watch" if command.is_none() => {
                return Err(CliError::unsupported("monitor/watch is not supported"))
            }
            "control" if command.is_none() => {
                return Err(CliError::unsupported("standalone control acquire/release is not supported; send takes its own connection-scoped lease"));
            }
            "--lease-id" | "--fence" if command == Some(CommandName::Send) => {
                return Err(CliError::usage(
                    "external leases are not supported; send takes its own connection-scoped lease",
                ));
            }
            "--port" if command == Some(CommandName::Send) => {
                port = Some(take_value(&mut args, &arg)?)
            }
            "--text" | "--hex" | "--stdin" if command == Some(CommandName::Send) => {
                if input.is_some() {
                    return Err(CliError::usage(
                        "--text, --hex, and --stdin are mutually exclusive",
                    ));
                }
                input = Some(match arg.as_str() {
                    "--text" => SendInput::Text(take_value(&mut args, &arg)?),
                    "--hex" => SendInput::Hex(normalize_hex(&take_value(&mut args, &arg)?)?),
                    _ => SendInput::Stdin,
                });
            }
            "--ending" | "--line-ending" if command == Some(CommandName::Send) => {
                ending = LineEnding::parse(&take_value(&mut args, &arg)?)?
            }
            "--connection-generation" if command == Some(CommandName::Send) => {
                generation = Some(parse_u64(
                    &take_value(&mut args, &arg)?,
                    "connection-generation",
                )?)
            }
            "--request-id" if command == Some(CommandName::OperationGet) => {
                request_id = Some(take_value(&mut args, &arg)?)
            }
            _ => return Err(CliError::usage(format!("unexpected argument: {arg}"))),
        }
    }
    let command = match command {
        Some(CommandName::Status) => Command::Status,
        Some(CommandName::PortsList) => Command::PortsList,
        Some(CommandName::Send) => {
            let port = port
                .filter(|value| !value.is_empty() && !value.chars().any(char::is_control))
                .ok_or_else(|| CliError::usage("send requires a nonempty --port"))?;
            let input = input.ok_or_else(|| {
                CliError::usage("send requires exactly one of --text, --hex, or --stdin")
            })?;
            if matches!(input, SendInput::Stdin) && ending != LineEnding::None {
                return Err(CliError::usage(
                    "--stdin sends raw bytes and cannot append a line ending",
                ));
            }
            Command::Send(SendOptions {
                port,
                input,
                ending,
                generation,
            })
        }
        Some(CommandName::OperationGet) => Command::OperationGet {
            request_id: request_id
                .filter(|value| valid_id(value))
                .ok_or_else(|| CliError::usage("operation get requires a valid --request-id"))?,
        },
        None => {
            return Err(CliError::usage(
                "a command is required; use --help for usage",
            ))
        }
    };
    Ok(ParseAction::Run(Cli {
        endpoint,
        timeout_ms,
        command,
    }))
}

fn loopback_endpoint(endpoint: &str) -> CliResult<SocketAddr> {
    // Bypass DNS: a lookup cannot outlive the deadline or reinterpret a name
    // as a non-loopback address. The current host binds IPv4 localhost.
    let address = if let Some((_, port)) = endpoint
        .rsplit_once(':')
        .filter(|(host, _)| host.eq_ignore_ascii_case("localhost"))
    {
        port.parse::<u16>()
            .ok()
            .map(|port| SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
    } else {
        endpoint.parse::<SocketAddr>().ok()
    };
    match address {
        Some(address) if address.ip().is_loopback() && address.port() != 0 => Ok(address),
        _ => Err(CliError::usage("experimental TCP requires a numeric loopback address or localhost, with a nonzero port")),
    }
}

fn request(method: &str, params: Value) -> Request {
    Request::new(format!("cli-{}", uuid::Uuid::new_v4()), method, params)
}

struct Connection {
    reader: FrameReader<OwnedReadHalf>,
    writer: OwnedWriteHalf,
    deadline: Instant,
    synchronized: bool,
}

impl Connection {
    fn remaining_ms(&self) -> Option<u64> {
        let remaining = self.deadline.checked_duration_since(Instant::now())?;
        (!remaining.is_zero()).then(|| (remaining.as_millis() as u64).max(1))
    }

    async fn exchange(
        &mut self,
        mut request: Request,
        encode_limit: usize,
        decode_limit: usize,
        expected_epoch: Option<&str>,
    ) -> CliResult<Response> {
        let id = &request.request_id;
        let remaining = self
            .remaining_ms()
            .ok_or_else(|| CliError::deadline(&request.method).with_request_id(id))?;
        request.timeout_ms = Some(remaining);
        let encoded =
            encode_request(&request, encode_limit).map_err(|error| CliError::wire(id, error))?;
        // An expired budget before attempting any write is not an unknown outcome.
        if self.remaining_ms().is_none() {
            return Err(CliError::deadline(&request.method).with_request_id(id));
        }
        self.synchronized = false;
        let exchange = async {
            self.writer
                .write_all(&encoded)
                .await
                .map_err(|error| CliError::unavailable(format!("cannot write request: {error}")))?;
            let frame = self
                .reader
                .read_frame()
                .await
                .map_err(|error| match error {
                    TransportError::Protocol(error) => CliError::protocol(error.to_string()),
                    _ => CliError::unavailable(format!("cannot read response: {error}")),
                })?
                .ok_or_else(|| {
                    CliError::unavailable("automation endpoint disconnected before response")
                })?;
            let response = decode_response(&frame, decode_limit)
                .map_err(|error| CliError::protocol(error.to_string()))?;
            if response.request_id() != Some(id.as_str()) {
                return Err(CliError::protocol(
                    "response requestId did not match the request",
                ));
            }
            if expected_epoch.is_some_and(|epoch| response.server_epoch() != epoch) {
                return Err(CliError::protocol(
                    "response serverEpoch did not match the handshake",
                ));
            }
            Ok(response)
        };
        let reply = timeout_at(self.deadline, exchange)
            .await
            .unwrap_or_else(|_| Err(CliError::deadline(&request.method)));
        match reply {
            Ok(response) => {
                self.synchronized = true;
                Ok(response)
            }
            // Never reuse a connection with an incomplete/uncorrelated reply.
            Err(error) if request.method == SERIAL_SEND => Err(CliError::unknown(id, error)),
            Err(error) => Err(error.with_request_id(id)),
        }
    }
}

struct Client {
    connection: Connection,
    handshake: Handshake,
}

impl Client {
    async fn connect(endpoint: SocketAddr, deadline: Instant) -> CliResult<Self> {
        let stream = timeout_at(deadline, TcpStream::connect(endpoint))
            .await
            .map_err(|_| CliError::deadline("connect"))?
            .map_err(|error| {
                CliError::unavailable(format!(
                    "automation endpoint unavailable at {endpoint}: {error}"
                ))
            })?;
        let (reader, writer) = stream.into_split();
        let mut connection = Connection {
            reader: FrameReader::new(reader, MAX_FRAME_BYTES)
                .map_err(|error| CliError::protocol(error.to_string()))?,
            writer,
            deadline,
            synchronized: true,
        };
        let request = request(HANDSHAKE_METHOD, json!({}));
        let id = request.request_id.clone();
        let response = connection
            .exchange(request, DEFAULT_MAX_FRAME_BYTES, MAX_FRAME_BYTES, None)
            .await?;
        match response {
            Response::Ok {
                result,
                server_epoch,
                ..
            } => {
                let handshake: Handshake = decode_payload(result, "handshake", &id)?;
                if handshake.protocol_version != PROTOCOL_VERSION
                    || handshake.server_epoch != server_epoch
                    || !(1..=MAX_FRAME_BYTES).contains(&handshake.max_frame_bytes)
                {
                    return Err(CliError::protocol(
                        "invalid handshake version, epoch, or frame limit",
                    )
                    .with_request_id(&id));
                }
                connection
                    .reader
                    .set_limit(handshake.max_frame_bytes)
                    .map_err(|error| CliError::protocol(error.to_string()).with_request_id(&id))?;
                Ok(Self {
                    connection,
                    handshake,
                })
            }
            Response::Error { error, .. } => Err(CliError::wire(&id, error)),
        }
    }

    fn require(&self, method: &str) -> CliResult<()> {
        if !self
            .handshake
            .capabilities
            .iter()
            .any(|capability| capability == method)
        {
            return Err(CliError::unsupported(format!(
                "host does not advertise {method}"
            )));
        }
        Ok(())
    }

    async fn call(&mut self, request: Request) -> CliResult<RpcResult> {
        self.require(&request.method)?;
        let id = request.request_id.clone();
        let send = request.method == SERIAL_SEND;
        let limit = self.handshake.max_frame_bytes;
        let response = self
            .connection
            .exchange(request, limit, limit, Some(&self.handshake.server_epoch))
            .await?;
        match response {
            Response::Ok { result, .. } => Ok(RpcResult { id, result }),
            Response::Error { error, .. } if send => Err(send_wire_error(&id, error)),
            Response::Error { error, .. } => Err(CliError::wire(&id, error)),
        }
    }

    fn request(
        &self,
        method: &str,
        params: Value,
        port: Option<&ResolvedPort>,
        control: Option<Control>,
    ) -> Request {
        let mut request = request(method, params);
        request.precondition = Some(Precondition {
            server_epoch: Some(self.handshake.server_epoch.clone()),
            connection_generation: port.map(|port| port.generation),
        });
        request.target = port.map(|port| port.target.clone());
        request.control = control;
        request
    }

    async fn status(&mut self) -> CliResult<RpcResult> {
        let reply = self
            .call(self.request(HOST_STATUS, json!({}), None, None))
            .await?;
        reply.identity(&self.handshake.server_epoch)?;
        Ok(reply)
    }

    async fn list_ports(&mut self) -> CliResult<(RpcResult, Ports)> {
        let reply = self
            .call(self.request(PORTS_LIST, json!({}), None, None))
            .await?;
        let ports: Ports = decode_payload(&reply.result, PORTS_LIST, &reply.id)?;
        reply.identity(&self.handshake.server_epoch)?;
        if ports.ports.iter().any(|port| {
            port.target.host_id != ports.host_id
                || port.server_epoch != self.handshake.server_epoch
                || port.target.native_port_id.is_empty()
                || (port.state == PortState::Open && port.generation == 0)
        }) {
            return Err(CliError::protocol(
                "ports.list returned inconsistent port identity or generation",
            )
            .with_request_id(&reply.id));
        }
        Ok((reply, ports))
    }

    async fn send(&mut self, options: &SendOptions, params: Value) -> CliResult<Value> {
        for method in [CONTROL_ACQUIRE, SERIAL_SEND, CONTROL_RELEASE] {
            self.require(method)?;
        }
        let status = self.status().await?;
        let host_id = status.identity(&self.handshake.server_epoch)?;
        let (listing, ports) = self.list_ports().await?;
        if ports.host_id != host_id {
            return Err(
                CliError::protocol("ports.list hostId did not match host.status")
                    .with_request_id(&listing.id),
            );
        }
        let port = ports.resolve(&options.port, options.generation, &listing.id)?;
        let ttl = self
            .connection
            .remaining_ms()
            .ok_or_else(|| CliError::deadline(CONTROL_ACQUIRE))?
            .min(MAX_LEASE_MS);
        let acquired = self
            .call(self.request(CONTROL_ACQUIRE, json!({"ttlMs": ttl}), Some(&port), None))
            .await?;
        let lease = validate_lease(acquired, &port, &self.handshake.server_epoch)?;

        let reply = self
            .call(self.request(SERIAL_SEND, params, Some(&port), Some(lease.clone())))
            .await;
        let mut output = reply
            .and_then(|reply| send_result(reply, &port, &self.handshake.server_epoch))
            .map(success);
        if self.connection.synchronized {
            // Explicit release uses the original deadline. Disconnect is the
            // fallback, not proof that in-flight native work has stopped.
            let release = self
                .call(self.request(CONTROL_RELEASE, json!({}), Some(&port), Some(lease)))
                .await
                .and_then(|reply| {
                    if reply.result.is_null() {
                        Ok(())
                    } else {
                        Err(
                            CliError::protocol("control.release returned an invalid result")
                                .with_request_id(&reply.id),
                        )
                    }
                });
            if let Err(warning) = release {
                // Never replace an already known TX outcome with a cleanup error.
                let envelope = match &mut output {
                    Ok(output) => output,
                    Err(error) => &mut error.output,
                };
                envelope["cleanupWarning"] = warning.cleanup_warning();
            }
        }
        output
    }
}

struct RpcResult {
    id: String,
    result: Value,
}

impl RpcResult {
    fn identity(&self, expected_epoch: &str) -> CliResult<&str> {
        self.result["hostId"]
            .as_str()
            .filter(|host| valid_id(host))
            .filter(|_| self.result["serverEpoch"].as_str() == Some(expected_epoch))
            .ok_or_else(|| {
                CliError::protocol("host identity or server epoch is invalid")
                    .with_request_id(&self.id)
            })
    }
}

fn decode_payload<'de, T, D>(data: D, method: &str, id: &str) -> CliResult<T>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de, Error = serde_json::Error>,
{
    T::deserialize(data).map_err(|error| {
        CliError::protocol(format!("invalid {method} result: {error}")).with_request_id(id)
    })
}

fn decimal_u64<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.len() > 1 && value.starts_with('0') {
        return Err(serde::de::Error::custom(
            "expected canonical decimal string",
        ));
    }
    parse_u64(&value, "counter").map_err(serde::de::Error::custom)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ports {
    host_id: String,
    ports: Vec<ListedPort>,
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum PortState {
    Open,
    Closed,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListedPort {
    target: Target,
    server_epoch: String,
    name: Option<String>,
    state: PortState,
    #[serde(rename = "connectionGeneration", deserialize_with = "decimal_u64")]
    generation: u64,
}

struct ResolvedPort {
    target: Target,
    generation: u64,
}

impl Ports {
    fn resolve(
        self,
        selector: &str,
        expected_generation: Option<u64>,
        id: &str,
    ) -> CliResult<ResolvedPort> {
        let mut native_matches = self
            .ports
            .iter()
            .filter(|port| port.target.native_port_id == selector);
        let first = native_matches.next();
        let (port, ambiguous) = if first.is_some() {
            (first, native_matches.next().is_some())
        } else {
            let mut matches = self
                .ports
                .iter()
                .filter(|port| port.name.as_deref() == Some(selector));
            (matches.next(), matches.next().is_some())
        };
        if ambiguous {
            return Err(CliError::usage(format!(
                "port {selector} is ambiguous; specify its nativePortId"
            ))
            .with_request_id(id));
        }
        let port = port
            .filter(|port| port.state == PortState::Open)
            .ok_or_else(|| {
                CliError::wire(
                    id,
                    WireError::new(
                        ErrorCode::PortNotFound,
                        format!("port {selector} is not listed as open"),
                    ),
                )
            })?;
        if expected_generation.is_some_and(|expected| expected != port.generation) {
            return Err(CliError::wire(
                id,
                WireError::new(
                    ErrorCode::StaleSession,
                    format!(
                        "port {selector} has live generation {}, not the requested generation",
                        port.generation
                    ),
                ),
            ));
        }
        Ok(ResolvedPort {
            target: port.target.clone(),
            generation: port.generation,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseAck {
    target: Target,
    server_epoch: String,
    #[serde(rename = "connectionGeneration", deserialize_with = "decimal_u64")]
    generation: u64,
    lease_id: String,
    #[serde(deserialize_with = "decimal_u64")]
    fence: u64,
    state: String,
}

fn validate_lease(reply: RpcResult, port: &ResolvedPort, epoch: &str) -> CliResult<Control> {
    let lease: LeaseAck = decode_payload(reply.result, CONTROL_ACQUIRE, &reply.id)?;
    if lease.target != port.target
        || lease.server_epoch != epoch
        || lease.generation != port.generation
        || lease.state != "granted"
        || !valid_id(&lease.lease_id)
        || lease.fence == 0
    {
        return Err(CliError::protocol(
            "control.acquire returned an invalid lease for this port/session",
        )
        .with_request_id(&reply.id));
    }
    Ok(Control {
        lease_id: lease.lease_id,
        fence: lease.fence,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum OperationStatus {
    Accepted,
    Queued,
    Executing,
    Succeeded,
    Failed,
    Cancelled,
    Unknown,
}

impl OperationStatus {
    fn state(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Queued => "queued",
            Self::Executing => "executing",
            Self::Succeeded => "succeeded",
            Self::Failed | Self::Unknown => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Certainty {
    Known,
    Partial,
    Unknown,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Outcome {
    certainty: Certainty,
    #[serde(deserialize_with = "decimal_u64")]
    bytes_written: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperationAck {
    operation_id: String,
    request_id: String,
    target: Target,
    server_epoch: String,
    #[serde(rename = "connectionGeneration", deserialize_with = "decimal_u64")]
    generation: u64,
    status: OperationStatus,
    state: String,
    outcome: Outcome,
    #[serde(deserialize_with = "decimal_u64")]
    requested_bytes: u64,
}

fn send_result(reply: RpcResult, port: &ResolvedPort, epoch: &str) -> CliResult<Value> {
    let op: OperationAck = decode_payload(&reply.result, SERIAL_SEND, &reply.id)
        .map_err(|error| CliError::unknown(&reply.id, error))?;
    let written = op.outcome.bytes_written;
    let certainty = op.outcome.certainty;
    if op.request_id != reply.id
        || op.server_epoch != epoch
        || op.target != port.target
        || op.generation != port.generation
        || !valid_id(&op.operation_id)
        || op.state != op.status.state()
        || written > op.requested_bytes
        || (certainty == Certainty::Partial && (written == 0 || written == op.requested_bytes))
    {
        return Err(CliError::unknown(
            &reply.id,
            "invalid operation identity or side-effect count",
        ));
    }
    if op.status == OperationStatus::Succeeded {
        return if certainty == Certainty::Known
            && written == op.requested_bytes
            && reply.result["error"].is_null()
        {
            Ok(reply.result)
        } else {
            Err(CliError::unknown(
                &reply.id,
                "host did not acknowledge the complete write",
            ))
        };
    }

    let mut error = if certainty == Certainty::Unknown
        || matches!(
            op.status,
            OperationStatus::Unknown
                | OperationStatus::Accepted
                | OperationStatus::Queued
                | OperationStatus::Executing
        ) {
        CliError::unknown(
            &reply.id,
            format_args!("host operation status: {:?}", op.status),
        )
    } else {
        let fallback = if op.status == OperationStatus::Cancelled {
            ErrorCode::Cancelled
        } else {
            ErrorCode::IoError
        };
        let mut error = reply.result["error"].clone();
        let host_code = serde_json::from_value::<ErrorCode>(error["code"].clone()).ok();
        let code = if op.status == OperationStatus::Cancelled {
            fallback
        } else {
            host_code.unwrap_or(fallback)
        };
        if code == ErrorCode::OutcomeUnknown {
            CliError::unknown(&reply.id, "host reported an unknown write outcome")
        } else {
            if !error.is_object() {
                error = json!({});
            }
            error["code"] = json!(code);
            if !error["message"].is_string() {
                error["message"] = json!(if code == ErrorCode::Cancelled {
                    "send was cancelled"
                } else {
                    "send did not complete successfully"
                });
            }
            CliError {
                exit_code: disposition(code),
                output: json!({"ok": false, "requestId": reply.id, "error": error}),
            }
        }
    };
    if error.exit_code != ExitCode::Unknown
        || (certainty == Certainty::Unknown
            && matches!(
                op.status,
                OperationStatus::Unknown | OperationStatus::Failed | OperationStatus::Cancelled
            ))
    {
        error.output["error"]["sideEffects"] = reply.result["outcome"].clone();
    }
    error.output["error"]["operationId"] = json!(op.operation_id);
    error.output["operation"] = reply.result;
    Err(error)
}

fn send_wire_error(id: &str, error: WireError) -> CliError {
    // The current host returns an operation record after native completion. A
    // correlated rejection can prove no write; generic internal/IO errors cannot.
    if matches!(
        error.code,
        ErrorCode::InvalidArgument
            | ErrorCode::UnsupportedCapability
            | ErrorCode::StaleSession
            | ErrorCode::Unauthenticated
            | ErrorCode::PermissionDenied
            | ErrorCode::HostUnavailable
            | ErrorCode::PortNotFound
            | ErrorCode::PortBusy
            | ErrorCode::ControlLost
            | ErrorCode::Cancelled
            | ErrorCode::DeadlineExceeded
            | ErrorCode::RequestLimit
    ) {
        let mut error = CliError::wire(id, error);
        error.output["error"]["sideEffects"] = json!({"certainty": "known", "bytesWritten": "0"});
        return error;
    }
    let mut output = CliError::unknown(id, &error);
    if let Some(operation_id) = &error.operation_id {
        output.output["error"]["operationId"] = json!(operation_id);
    }
    output.output["error"]["cause"] = json!(error);
    output
}

fn success(result: Value) -> Value {
    json!({"ok": true, "result": result})
}

async fn execute(cli: Cli, stdin: impl Read) -> CliResult<Value> {
    let endpoint = loopback_endpoint(&cli.endpoint)?;
    // Read finite redirected input before connecting or acquiring a lease.
    // The timeout covers the network and protocol, not the stdin producer.
    let send_params = match &cli.command {
        Command::Send(options) => Some(options.params(stdin)?),
        _ => None,
    };
    let deadline = Instant::now() + Duration::from_millis(cli.timeout_ms);
    let mut client = Client::connect(endpoint, deadline).await?;
    match cli.command {
        Command::Status => Ok(success(client.status().await?.result)),
        Command::PortsList => Ok(success(client.list_ports().await?.0.result)),
        Command::OperationGet { request_id } => {
            let reply = client
                .call(client.request(OPERATIONS_GET, json!({"requestId": request_id}), None, None))
                .await?;
            if reply.result["requestId"].as_str() != Some(&request_id)
                || reply.result["serverEpoch"].as_str() != Some(&client.handshake.server_epoch)
                || !reply.result["operationId"].as_str().is_some_and(valid_id)
            {
                return Err(CliError::protocol(
                    "operations.get returned a different or invalid operation",
                )
                .with_request_id(&reply.id));
            }
            // Query success is independent from the queried operation's status.
            Ok(success(reply.result))
        }
        Command::Send(options) => {
            client
                .send(&options, send_params.expect("send params prepared"))
                .await
        }
    }
}

const HELP: &str = "hypercom-cli (experimental loopback client)\n\n\
Usage: hypercom-cli [--target local] [--endpoint HOST:PORT] [--timeout-ms N] COMMAND\n\n\
Commands:\n  status\n  ports list\n  send --port PORT (--text TEXT | --hex HEX | --stdin) [--ending none|lf|cr|crlf]\n\
    [--connection-generation N] checks that the live generation is N.\n  operation get --request-id ID\n\n\
Endpoint: numeric loopback IP or localhost only. Default: 127.0.0.1:39071\n\
(or HYPERCOM_AUTOMATION_ENDPOINT). No remote alias resolution.\n\
Timeout: one 1..60000 ms budget for connect, handshake and protocol I/O (default 3000).\n\
Only text appends an ending; HEX ignores it. Redirected raw stdin is limited to\n\
48000 bytes (subject to frame size) and cannot append an ending.\n\
Send requires an open host port and uses one short, connection-scoped lease.\n\
Standalone control acquire/release, external leases, and monitor/watch are unsupported.\n\
A send with OUTCOME_UNKNOWN must not be replayed; query its original requestId.\n\
Commands emit one JSON line. Exit codes: 0 success, 2 usage, 3 unavailable/deadline,\n\
4 protocol, 5 host error/known write failure, 6 cancelled, 7 unknown outcome.\n";

fn print_error(error: &CliError) -> i32 {
    eprintln!("hypercom-cli: {error}");
    println!("{}", error.output);
    error.exit_code as i32
}

pub fn run(iter: impl IntoIterator<Item = String>) -> i32 {
    match parse_args(iter) {
        Ok(ParseAction::Help) => {
            print!("{HELP}");
            0
        }
        Ok(ParseAction::Version) => {
            println!("hypercom-cli {}", env!("CARGO_PKG_VERSION"));
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
                    )))
                }
            };
            match runtime.block_on(execute(cli, io::stdin().lock())) {
                Ok(output) => {
                    println!("{output}");
                    0
                }
                Err(error) => print_error(&error),
            }
        }
        Err(error) => print_error(&error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{decode_request, encode_response};
    use tokio::net::TcpListener;

    const EPOCH: &str = "epoch-test";
    const HOST: &str = "host-test";
    const GENERATION: &str = "18446744073709551615";
    const FENCE: &str = "9007199254740993";
    const PORT_ID: &str = "COM3";
    const PORT_NAME: &str = "User-facing port";

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_string()).collect()
    }

    fn parsed(items: &[&str]) -> Cli {
        let ParseAction::Run(cli) = parse_args(args(items)).unwrap() else {
            panic!("expected command");
        };
        cli
    }

    fn options(items: &[&str]) -> SendOptions {
        let Command::Send(options) = parsed(items).command else {
            panic!("expected send");
        };
        options
    }

    #[test]
    fn rejects_nonlocal_and_unimplemented_options() {
        for endpoint in [
            "10.0.0.1:1",
            "192.168.0.1:1",
            "[::]:1",
            "[::ffff:10.0.0.1]:1",
            "localhost:0",
            "example.org:1",
        ] {
            assert_eq!(
                loopback_endpoint(endpoint).unwrap_err().exit_code,
                ExitCode::Usage
            );
        }
        for endpoint in ["127.0.0.1:1", "127.2.3.4:1", "[::1]:1", "localhost:1"] {
            assert!(loopback_endpoint(endpoint).unwrap().ip().is_loopback());
        }
        assert!(matches!(
            parsed(&["--target", "local", "status"]).command,
            Command::Status
        ));
        assert_eq!(
            parse_args(args(&["--target", "lab", "status"]))
                .unwrap_err()
                .exit_code,
            ExitCode::Usage
        );
        for command in [
            &["control", "acquire"][..],
            &["control", "release"],
            &["monitor"],
            &["watch", "--port", PORT_ID],
        ] {
            assert_eq!(
                parse_args(args(command)).unwrap_err().output["error"]["code"],
                "UNSUPPORTED_CAPABILITY"
            );
        }
        assert_eq!(
            parse_args(args(&["send", "--lease-id", "external"]))
                .unwrap_err()
                .exit_code,
            ExitCode::Usage
        );
        assert_eq!(
            parse_args(args(&["status", "--timeout-ms", "60001"]))
                .unwrap_err()
                .exit_code,
            ExitCode::Usage
        );
    }

    #[test]
    fn payloads_preserve_raw_bytes_and_mode_specific_endings() {
        let stdin = options(&["send", "--port", PORT_ID, "--stdin"]);
        let params = stdin.params(&b"\x00\xff\r\n\x80"[..]).unwrap();
        assert_eq!(params, json!({"dataBase64":"AP8NCoA="}));
        assert!(stdin.params(io::repeat(0)).is_err());
        assert!(parse_args(args(&[
            "send", "--port", PORT_ID, "--stdin", "--ending", "lf"
        ]))
        .is_err());
        let hex = options(&[
            "send", "--port", PORT_ID, "--hex", " 00\tFf ", "--ending", "crlf",
        ]);
        assert_eq!(
            hex.params(io::empty()).unwrap(),
            json!({"mode":"hex","hex":"00Ff"})
        );
        for invalid in ["1", "zz", "0 1 2", "00\u{a0}"] {
            assert!(parse_args(args(&["send", "--port", PORT_ID, "--hex", invalid])).is_err());
        }
        let text = options(&[
            "send", "--port", PORT_ID, "--text", "--help", "--ending", "crlf",
        ]);
        assert_eq!(
            text.params(io::empty()).unwrap(),
            json!({"mode":"text","text":"--help","lineEnding":"crlf"})
        );
    }

    struct Peer {
        read: FrameReader<OwnedReadHalf>,
        write: OwnedWriteHalf,
    }

    impl Peer {
        async fn accept(listener: TcpListener) -> Self {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, write) = stream.into_split();
            Self {
                read: FrameReader::new(read, DEFAULT_MAX_FRAME_BYTES).unwrap(),
                write,
            }
        }

        async fn read(&mut self, method: &str) -> Request {
            let frame = self.read.read_frame().await.unwrap().unwrap();
            let request = decode_request(&frame, DEFAULT_MAX_FRAME_BYTES).unwrap();
            assert_eq!(request.method, method);
            assert!(request
                .timeout_ms
                .is_some_and(|timeout| timeout > 0 && timeout <= DEFAULT_TIMEOUT_MS));
            if method != HANDSHAKE_METHOD {
                assert_eq!(
                    request
                        .precondition
                        .as_ref()
                        .unwrap()
                        .server_epoch
                        .as_deref(),
                    Some(EPOCH)
                );
            }
            request
        }

        async fn reply(&mut self, response: Response) {
            self.write
                .write_all(&encode_response(&response, DEFAULT_MAX_FRAME_BYTES).unwrap())
                .await
                .unwrap();
        }

        async fn ok(&mut self, request: Request, result: Value) {
            self.reply(Response::ok(EPOCH, request.request_id, result))
                .await;
        }

        async fn handshake(&mut self, capabilities: &[&str]) {
            let handshake = self.read(HANDSHAKE_METHOD).await;
            self.ok(
                handshake,
                json!({"protocolVersion":PROTOCOL_VERSION,"serverEpoch":EPOCH,
                "capabilities":capabilities,"maxFrameBytes":DEFAULT_MAX_FRAME_BYTES,
                "writeQueueCapacity":32,"maxRequestsPerConnection":4096}),
            )
            .await;
        }

        async fn discover(&mut self) {
            let status = self.read(HOST_STATUS).await;
            assert!(status.target.is_none() && status.control.is_none());
            self.ok(status, json!({"hostId":HOST,"serverEpoch":EPOCH}))
                .await;
            let list = self.read(PORTS_LIST).await;
            assert!(list.target.is_none() && list.control.is_none());
            self.ok(list, ports()).await;
        }

        async fn observe_send(&mut self) -> Request {
            self.handshake(&[
                HOST_STATUS,
                PORTS_LIST,
                CONTROL_ACQUIRE,
                CONTROL_RELEASE,
                SERIAL_SEND,
            ])
            .await;
            self.discover().await;
            let acquire = self.read(CONTROL_ACQUIRE).await;
            assert_target(&acquire);
            assert!(acquire.control.is_none());
            assert!(acquire.params["ttlMs"]
                .as_u64()
                .is_some_and(|ttl| (1..=MAX_LEASE_MS).contains(&ttl)));
            self.ok(
                acquire,
                json!({"target":target(),"serverEpoch":EPOCH,"connectionGeneration":GENERATION,
                "leaseId":"lease-test","fence":FENCE,"state":"granted"}),
            )
            .await;
            let send = self.read(SERIAL_SEND).await;
            assert_target(&send);
            assert_eq!(send.control, Some(control()));
            assert_eq!(send.params, json!({"dataBase64":"AP8NCoA="}));
            send
        }

        async fn expect_disconnect(&mut self) {
            assert!(
                self.read.read_frame().await.unwrap().is_none(),
                "client sent an extra request"
            );
        }
    }

    fn target() -> Value {
        json!({"hostId":HOST,"nativePortId":PORT_ID})
    }

    fn ports() -> Value {
        json!({"hostId":HOST,"serverEpoch":EPOCH,"ports":[{"target":target(),"serverEpoch":EPOCH,
            "connectionGeneration":GENERATION,"state":"open","name":PORT_NAME}]})
    }

    fn control() -> Control {
        Control {
            lease_id: "lease-test".into(),
            fence: FENCE.parse().unwrap(),
        }
    }

    fn assert_target(request: &Request) {
        assert_eq!(serde_json::to_value(&request.target).unwrap(), target());
        assert_eq!(
            request.precondition.as_ref().unwrap().connection_generation,
            Some(u64::MAX)
        );
    }

    fn operation(
        id: &str,
        status: &str,
        state: &str,
        certainty: &str,
        written: &str,
        error: Value,
    ) -> Value {
        json!({"operationId":"op-test","requestId":id,"target":target(),"serverEpoch":EPOCH,
            "connectionGeneration":GENERATION,"status":status,"state":state,"requestedBytes":"5",
            "outcome":{"certainty":certainty,"bytesWritten":written},"error":error})
    }

    async fn listener_for(items: &[&str]) -> (TcpListener, Cli) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut cli = parsed(items);
        cli.endpoint = listener.local_addr().unwrap().to_string();
        (listener, cli)
    }

    #[tokio::test]
    async fn read_only_commands_use_no_control_methods() {
        for (args, method, result) in [
            (
                &["status"][..],
                HOST_STATUS,
                json!({"hostId":HOST,"serverEpoch":EPOCH}),
            ),
            (&["ports", "list"][..], PORTS_LIST, ports()),
        ] {
            let (listener, cli) = listener_for(args).await;
            let expected = result.clone();
            let host = tokio::spawn(async move {
                let mut peer = Peer::accept(listener).await;
                peer.handshake(&[HOST_STATUS, PORTS_LIST]).await;
                let request = peer.read(method).await;
                assert!(request.target.is_none() && request.control.is_none());
                peer.ok(request, result).await;
                peer.expect_disconnect().await;
            });
            assert_eq!(execute(cli, io::empty()).await.unwrap(), success(expected));
            host.await.unwrap();
        }
    }

    #[tokio::test]
    async fn send_resolves_and_releases_on_one_connection_for_each_acknowledged_outcome() {
        const SEND: &[&str] = &[
            "send",
            "--port",
            PORT_NAME,
            "--stdin",
            "--connection-generation",
            GENERATION,
        ];
        for (status, state, certainty, written, expected_exit, release_ok) in [
            ("succeeded", "succeeded", "known", "5", None, true),
            ("succeeded", "succeeded", "known", "5", None, false),
            (
                "failed",
                "failed",
                "known",
                "0",
                Some(ExitCode::Remote),
                true,
            ),
            (
                "failed",
                "failed",
                "partial",
                "2",
                Some(ExitCode::Remote),
                true,
            ),
            (
                "cancelled",
                "cancelled",
                "known",
                "0",
                Some(ExitCode::Cancelled),
                true,
            ),
            (
                "unknown",
                "failed",
                "unknown",
                "2",
                Some(ExitCode::Unknown),
                true,
            ),
        ] {
            let (listener, cli) = listener_for(SEND).await;
            let host = tokio::spawn(async move {
                let mut peer = Peer::accept(listener).await;
                let send = peer.observe_send().await;
                let id = send.request_id.clone();
                let error = if status == "failed" {
                    json!({"code":"IO_ERROR","message":"write failed"})
                } else {
                    Value::Null
                };
                let result = operation(&id, status, state, certainty, written, error);
                peer.ok(send, result).await;
                let release = peer.read(CONTROL_RELEASE).await;
                assert_target(&release);
                assert_eq!(release.control, Some(control()));
                assert_eq!(release.params, json!({}));
                if release_ok {
                    peer.ok(release, Value::Null).await;
                } else {
                    peer.reply(Response::error(
                        EPOCH,
                        Some(release.request_id),
                        WireError::new(ErrorCode::ControlLost, "lease expired"),
                    ))
                    .await;
                }
                peer.expect_disconnect().await;
                id
            });
            let result = execute(cli, &b"\x00\xff\r\n\x80"[..]).await;
            let id = host.await.unwrap();
            if let Some(exit) = expected_exit {
                let error = result.unwrap_err();
                assert_eq!(error.exit_code, exit);
                assert_eq!(error.output["requestId"], id);
                assert_eq!(error.output["operation"]["status"], status);
                assert_eq!(
                    error.output["error"]["sideEffects"],
                    json!({"certainty":certainty,"bytesWritten":written})
                );
            } else {
                let output = result.unwrap();
                assert_eq!(output["ok"], true);
                assert_eq!(output["result"]["requestId"], id);
                assert_eq!(output["result"]["outcome"]["bytesWritten"], "5");
                assert_eq!(output.get("cleanupWarning").is_none(), release_ok);
            }
        }
    }

    #[tokio::test]
    async fn stale_expected_generation_stops_before_acquire() {
        let (listener, cli) = listener_for(&[
            "send",
            "--port",
            PORT_ID,
            "--text",
            "AT",
            "--connection-generation",
            "7",
        ])
        .await;
        let host = tokio::spawn(async move {
            let mut peer = Peer::accept(listener).await;
            peer.handshake(&[
                HOST_STATUS,
                PORTS_LIST,
                CONTROL_ACQUIRE,
                CONTROL_RELEASE,
                SERIAL_SEND,
            ])
            .await;
            peer.discover().await;
            peer.expect_disconnect().await;
        });
        let error = execute(cli, io::empty()).await.unwrap_err();
        assert_eq!(error.output["error"]["code"], "STALE_SESSION");
        host.await.unwrap();
    }

    #[tokio::test]
    async fn missing_or_uncorrelated_send_ack_is_unknown_with_original_request_id() {
        for failure in [
            "wrong-id",
            "wrong-epoch",
            "missing-id",
            "truncated",
            "disconnect",
            "deadline",
        ] {
            let (listener, mut cli) = listener_for(&["send", "--port", PORT_ID, "--stdin"]).await;
            if failure == "deadline" {
                cli.timeout_ms = 500;
            }
            let host = tokio::spawn(async move {
                let mut peer = Peer::accept(listener).await;
                let id = peer.observe_send().await.request_id;
                let result = operation(&id, "succeeded", "succeeded", "known", "5", Value::Null);
                match failure {
                    "wrong-id" => {
                        peer.reply(Response::ok(EPOCH, "other-id".into(), result))
                            .await
                    }
                    "wrong-epoch" => {
                        peer.reply(Response::ok("other-epoch", id.clone(), result))
                            .await
                    }
                    "missing-id" => {
                        peer.reply(Response::error(
                            EPOCH,
                            None,
                            WireError::new(ErrorCode::PermissionDenied, "uncorrelated rejection"),
                        ))
                        .await
                    }
                    "truncated" => {
                        peer.write.write_all(b"{\"status\":\"ok\"").await.unwrap();
                        peer.write.shutdown().await.unwrap();
                    }
                    "disconnect" => return id,
                    "deadline" => (),
                    _ => unreachable!(),
                }
                peer.expect_disconnect().await;
                id
            });
            let error = execute(cli, &b"\x00\xff\r\n\x80"[..]).await.unwrap_err();
            let id = host.await.unwrap();
            assert_eq!(error.exit_code, ExitCode::Unknown, "{failure}");
            assert_eq!(error.output["requestId"], id);
            assert_eq!(error.output["error"]["code"], "OUTCOME_UNKNOWN");
            assert_eq!(
                error.output["error"]["sideEffects"],
                json!({"certainty":"unknown"})
            );
        }
    }

    #[tokio::test]
    async fn operation_get_returns_failed_operation_as_informational_success() {
        let (listener, cli) = listener_for(&["operation", "get", "--request-id", "original"]).await;
        let host = tokio::spawn(async move {
            let mut peer = Peer::accept(listener).await;
            peer.handshake(&[OPERATIONS_GET]).await;
            let request = peer.read(OPERATIONS_GET).await;
            assert_ne!(request.request_id, "original");
            assert_eq!(request.params, json!({"requestId":"original"}));
            let op = operation(
                "original",
                "failed",
                "failed",
                "partial",
                "2",
                json!({"code":"IO_ERROR","message":"device failed"}),
            );
            peer.ok(request, op.clone()).await;
            peer.expect_disconnect().await;
            op
        });
        let output = execute(cli, io::empty()).await.unwrap();
        assert_eq!(output, success(host.await.unwrap()));
    }
}
