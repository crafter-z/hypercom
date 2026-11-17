//! Minimal console client for the opt-in loopback automation endpoint.
//!
//! This binary intentionally does not open a serial port. It connects to a
//! running HyperCom host, performs the versioned handshake, and calls only the
//! advertised domain methods. Control/serial writes remain unavailable until
//! the host routes every local writer through the native arbiter.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

const PROTOCOL_VERSION: u32 = 1;
const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 39_071;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Request<'a> {
    protocol_version: u32,
    request_id: String,
    method: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<Target<'a>>,
    params: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Target<'a> {
    host_id: &'a str,
    native_port_id: &'a str,
}

#[derive(Debug, Deserialize)]
struct Response {
    status: String,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<WireError>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireError {
    code: Value,
    message: String,
    #[serde(default)]
    retryable: bool,
    #[serde(default)]
    stage: Option<String>,
    #[serde(default)]
    operation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Options {
    host: String,
    port: u16,
    command: Command,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    Status,
    PortsList,
    Monitor { port: String },
    Send { port: String, payload: SendPayload },
    Help,
    Version,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SendPayload {
    Text { value: String, ending: String },
    Hex { value: String, ending: String },
}

fn usage() -> &'static str {
    "hypercom-cli [--host HOST] [--port PORT] <status|ports list|monitor|send>\n\n  status                         show the running host\n  ports list                     list native ports\n  monitor --port PORT            subscribe (requires a future event capability)\n  send --port PORT --text TEXT   send (requires a future control capability)\n  send --port PORT --hex HEX     send strict hexadecimal bytes\n  --help                         show this help\n  --version                      show the CLI version"
}

fn next_value<I>(args: &mut I, option: &str) -> Result<String, String>
where
    I: Iterator<Item = String>,
{
    args.next()
        .ok_or_else(|| format!("missing value for {option}"))
}

fn valid_hex(value: &str) -> bool {
    let compact: String = value.chars().filter(|ch| !ch.is_whitespace()).collect();
    !compact.is_empty()
        && compact.len().is_multiple_of(2)
        && compact.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn parse_args<I>(mut args: I) -> Result<Options, String>
where
    I: Iterator<Item = String>,
{
    let mut host = DEFAULT_HOST.to_owned();
    let mut port = DEFAULT_PORT;
    let mut positional = Vec::new();
    let mut port_id = None;
    let mut text = None;
    let mut hex = None;
    let mut ending = "none".to_owned();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                return Ok(Options {
                    host,
                    port,
                    command: Command::Help,
                })
            }
            "--version" | "-V" => {
                return Ok(Options {
                    host,
                    port,
                    command: Command::Version,
                })
            }
            "--host" => host = next_value(&mut args, "--host")?,
            "--port-number" | "--tcp-port" => {
                port = next_value(&mut args, "--tcp-port")?
                    .parse()
                    .map_err(|_| "invalid TCP port".to_owned())?;
            }
            "--port" => port_id = Some(next_value(&mut args, "--port")?),
            "--text" => text = Some(next_value(&mut args, "--text")?),
            "--hex" => hex = Some(next_value(&mut args, "--hex")?),
            "--ending" => ending = next_value(&mut args, "--ending")?,
            _ if arg.starts_with('-') => return Err(format!("unknown option: {arg}")),
            _ => positional.push(arg),
        }
    }
    match positional.as_slice() {
        [command] if command == "status" => Ok(Options {
            host,
            port,
            command: Command::Status,
        }),
        [command, subcommand] if command == "ports" && subcommand == "list" => Ok(Options {
            host,
            port,
            command: Command::PortsList,
        }),
        [command] if command == "monitor" => Ok(Options {
            host,
            port,
            command: Command::Monitor {
                port: port_id.ok_or("monitor requires --port")?,
            },
        }),
        [command] if command == "send" => {
            let target_port = port_id.ok_or("send requires --port")?;
            if !matches!(ending.as_str(), "none" | "cr" | "lf" | "crlf") {
                return Err("--ending must be none, cr, lf, or crlf".to_owned());
            }
            match (text, hex) {
                (Some(value), None) => Ok(Options {
                    host,
                    port,
                    command: Command::Send {
                        port: target_port,
                        payload: SendPayload::Text { value, ending },
                    },
                }),
                (None, Some(value)) if valid_hex(&value) => Ok(Options {
                    host,
                    port,
                    command: Command::Send {
                        port: target_port,
                        payload: SendPayload::Hex { value, ending },
                    },
                }),
                (None, Some(_)) => {
                    Err("HEX input must contain an even number of hexadecimal digits".to_owned())
                }
                (Some(_), Some(_)) => Err("--text and --hex are mutually exclusive".to_owned()),
                (None, None) => Err("send requires exactly one of --text or --hex".to_owned()),
            }
        }
        [] => Err("missing command (use --help)".to_owned()),
        _ => Err("unknown command or subcommand (use --help)".to_owned()),
    }
}

fn request(request_id: &str, method: &str, target: Option<Target<'_>>, params: Value) -> String {
    serde_json::to_string(&Request {
        protocol_version: PROTOCOL_VERSION,
        request_id: request_id.to_owned(),
        method,
        target,
        params,
    })
    .expect("request serialization cannot fail")
}

fn call(
    stream: &mut TcpStream,
    request_id: &str,
    method: &str,
    target: Option<Target<'_>>,
    params: Value,
) -> Result<Response, String> {
    let line = request(request_id, method, target, params);
    stream
        .write_all(line.as_bytes())
        .map_err(|error| error.to_string())?;
    stream.write_all(b"\n").map_err(|error| error.to_string())?;
    stream.flush().map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
    let mut response = String::new();
    reader
        .read_line(&mut response)
        .map_err(|error| error.to_string())?;
    if response.is_empty() {
        return Err("host closed the automation connection".to_owned());
    }
    serde_json::from_str(response.trim_end())
        .map_err(|error| format!("invalid host response: {error}"))
}

fn error_json(code: &str, message: impl Into<String>) -> Value {
    json!({ "schemaVersion": 1, "ok": false, "error": { "code": code, "message": message.into() } })
}

fn connect(host: &str, port: u16) -> Result<TcpStream, String> {
    let address = (host, port)
        .to_socket_addrs()
        .map_err(|error| error.to_string())?
        .next()
        .ok_or("host address did not resolve")?;
    let stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|error| format!("HOST_UNAVAILABLE: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    Ok(stream)
}

fn execute(options: Options) -> Value {
    let command = options.command.clone();
    match command {
        Command::Help => json!({ "schemaVersion": 1, "ok": true, "help": usage() }),
        Command::Version => {
            json!({ "schemaVersion": 1, "ok": true, "version": env!("CARGO_PKG_VERSION") })
        }
        Command::Monitor { .. } => error_json(
            "UNSUPPORTED_CAPABILITY",
            "event monitoring is not enabled by this host adapter",
        ),
        Command::Send { .. } => error_json(
            "UNSUPPORTED_CAPABILITY",
            "serial control is not enabled by this host adapter",
        ),
        Command::Status | Command::PortsList => {
            let mut stream = match connect(&options.host, options.port) {
                Ok(stream) => stream,
                Err(error) => return error_json("HOST_UNAVAILABLE", error),
            };
            let handshake = match call(&mut stream, "handshake", "handshake", None, json!({})) {
                Ok(response) => response,
                Err(error) => return error_json("HOST_UNAVAILABLE", error),
            };
            if handshake.status != "ok" {
                return serde_json::to_value(handshake.error)
                    .unwrap_or_else(|_| error_json("HOST_UNAVAILABLE", "handshake failed"));
            }
            let (method, params) = match options.command {
                Command::Status => ("host.status", json!({})),
                Command::PortsList => ("ports.list", json!({})),
                _ => unreachable!(),
            };
            match call(&mut stream, "request-1", method, None, params) {
                Ok(response) if response.status == "ok" => {
                    json!({ "schemaVersion": 1, "ok": true, "result": response.result })
                }
                Ok(response) => json!({ "schemaVersion": 1, "ok": false, "error": response.error }),
                Err(error) => error_json("HOST_UNAVAILABLE", error),
            }
        }
    }
}

pub fn run<I>(args: I) -> i32
where
    I: Iterator<Item = String>,
{
    let options = match parse_args(args) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{error}");
            println!("{}", error_json("INVALID_ARGUMENT", error));
            return 2;
        }
    };
    let result = execute(options);
    let failed = result.get("ok").and_then(Value::as_bool) == Some(false);
    println!(
        "{}",
        serde_json::to_string(&result).expect("CLI output serialization cannot fail")
    );
    if failed {
        1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status_and_ports() {
        assert_eq!(
            parse_args(["status".into()].into_iter()).unwrap().command,
            Command::Status
        );
        assert_eq!(
            parse_args(["ports".into(), "list".into()].into_iter())
                .unwrap()
                .command,
            Command::PortsList
        );
    }

    #[test]
    fn validates_hex_and_input_exclusivity() {
        assert!(parse_args(
            [
                "send".into(),
                "--port".into(),
                "COM3".into(),
                "--hex".into(),
                "AA 0f".into()
            ]
            .into_iter()
        )
        .is_ok());
        assert!(parse_args(
            [
                "send".into(),
                "--port".into(),
                "COM3".into(),
                "--hex".into(),
                "A".into()
            ]
            .into_iter()
        )
        .is_err());
        assert!(parse_args(
            [
                "send".into(),
                "--port".into(),
                "COM3".into(),
                "--text".into(),
                "x".into(),
                "--hex".into(),
                "AA".into()
            ]
            .into_iter()
        )
        .is_err());
    }

    #[test]
    fn monitor_and_send_are_explicitly_not_faked() {
        let monitor = execute(
            parse_args(["monitor".into(), "--port".into(), "COM3".into()].into_iter()).unwrap(),
        );
        assert_eq!(monitor["error"]["code"], "UNSUPPORTED_CAPABILITY");
        let send = execute(
            parse_args(
                [
                    "send".into(),
                    "--port".into(),
                    "COM3".into(),
                    "--text".into(),
                    "x".into(),
                ]
                .into_iter(),
            )
            .unwrap(),
        );
        assert_eq!(send["error"]["code"], "UNSUPPORTED_CAPABILITY");
    }
}
