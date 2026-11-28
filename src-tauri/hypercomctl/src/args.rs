use hypercom_protocol::{
    RemoteRole, SerialParamsDto, DEFAULT_ENDPOINT, MAX_EXPECT_BYTES, MAX_EXPECT_MS, MAX_WRITE_BYTES,
};
use serde_json::Value;
use std::collections::BTreeMap;

pub const USAGE: &str = "\
hypercomctl [--host NAME | --profile NAME] [--format text|json|ndjson] COMMAND

Global options:
  --host NAME              Local IPC endpoint name (default: \"default\" or $HYPERCOM_HOST_ENDPOINT)
  --profile NAME           Paired remote HyperCom profile (mutually exclusive with --host)
  --format text|json|ndjson  Output format (default: text)
  -h, --help               Show this help message
  -V, --version            Show version

Commands:
  ping | info              Check connection and show host capabilities, active loans, remote status
  ports                    List all available ports with status, baud rate, USB info, and loans
  status <PORT>            Show detailed status of one port
  open <PORT> [OPTIONS]    Open a serial port
                           [--baud 115200] [--data-bits 8] [--parity none|odd|even]
                           [--stop-bits 1|2] [--handshake none|xonxoff|rtscts]
                           [--dtr on|off] [--rts on|off] [--generation N]
  close <PORT> [--generation N]
                           Close a serial port
  set-params <PORT> [OPTIONS] [--generation N]
                           Update serial parameters (same framing/line options as open)
  flow <PORT> --dtr on|off --rts on|off [--generation N]
                           Update DTR/RTS flow control lines
  send <PORT> (--text TEXT | --hex HEX) [--eol none|lf|cr|crlf] [--source NAME] [--generation N]
                           Send bytes to an open serial port
  request <PORT> (--text TEXT | --hex HEX) [--eol none|lf|cr|crlf]
                 (--expect-line LINE | --expect-text TEXT | --expect-hex HEX)
                 [--timeout 3s] [--source NAME] [--generation N]
                           Atomically pre-register expect pattern, send, and wait for match
  tail <PORT> [--recent N | --after SEQ] [--count N] [--idle-timeout 5s] [--format text|ndjson]
                           Stream live RX/TX/status/loan/note events
  note <PORT> --text TEXT [--source NAME]
                           Insert a visible NOTE line into the HyperCom terminal
  loan <PORT> [--holder NAME] [--reason TEXT] [--ttl 60s] [--no-reopen] [--generation N] -- <CMD> [ARGS...]
                           Borrow exclusive OS port ownership for child command, then auto-reopen
  loan acquire <PORT> [--holder NAME] [--reason TEXT] [--ttl 60s] [--no-reopen] [--generation N]
  loan heartbeat <LEASE_ID> [--ttl 60s]
  loan release <LEASE_ID> [--reopen | --no-reopen]
  loan reclaim <PORT>
  loan list
  plugin list              List available local and remote plugin tools
  plugin call <PLUGIN_ID> <TOOL> [--target local|remote::<PROFILE>] [--args JSON]
              [--artifact ID]... [--timeout 30s] [--wait]
                           Invoke a plugin tool (and optionally wait for async job completion)
  plugin job <JOB_ID> [--target local|remote::<PROFILE>] [--after SEQ] [--follow]
                           Poll or follow an async plugin job
  plugin cancel <JOB_ID> [--target local|remote::<PROFILE>]
                           Cancel a running plugin job
  artifact upload <FILE_PATH> [--target local|remote::<PROFILE>] [--name NAME] [--ttl 30m]
                           Stream a local file to the host as an artifact for plugin tools
  remote status|start|stop|invite|clients|revoke|pair|profiles|check|forget
                           Manage remote TLS 1.3 host listener and paired client profiles
                           (remote invite supports [--device-plugins])
  mcp                      Run built-in JSON-RPC 2.0 stdio MCP server
";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Text,
    Json,
    Ndjson,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Local(String),
    Profile(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExpectInput {
    Line(String),
    Text(String),
    Bytes(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoanAction {
    Run {
        port: String,
        holder: Option<String>,
        reason: Option<String>,
        ttl_ms: u64,
        auto_reopen: bool,
        expected_generation: Option<u64>,
        program: String,
        args: Vec<String>,
    },
    Acquire {
        port: String,
        holder: Option<String>,
        reason: Option<String>,
        ttl_ms: u64,
        auto_reopen: bool,
        expected_generation: Option<u64>,
    },
    Heartbeat {
        lease_id: String,
        ttl_ms: Option<u64>,
    },
    Release {
        lease_id: String,
        reopen_override: Option<bool>,
    },
    Reclaim {
        port: String,
    },
    List,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteAction {
    Status,
    Start {
        listen: String,
        advertise: Option<String>,
    },
    Stop,
    Invite {
        label: String,
        ports: Vec<String>,
        role: RemoteRole,
        allow_loan: bool,
        device_plugins: bool,
        ttl_secs: Option<u64>,
    },
    Clients,
    Revoke {
        client_id: String,
    },
    Pair {
        profile: String,
        invite_file: Option<String>,
    },
    Profiles,
    Check {
        profile: String,
    },
    Forget {
        profile: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginAction {
    List,
    Call {
        plugin_id: String,
        tool: String,
        target: Option<String>,
        args: Value,
        artifacts: Vec<String>,
        timeout_ms: Option<u64>,
        wait: bool,
    },
    Job {
        job_id: String,
        target: Option<String>,
        after_seq: Option<u64>,
        follow: bool,
    },
    Cancel {
        job_id: String,
        target: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtifactAction {
    Upload {
        file_path: String,
        target: Option<String>,
        name: Option<String>,
        ttl_ms: Option<u64>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Help,
    Version,
    Ping,
    Ports,
    Status {
        port: String,
    },
    Open {
        port: String,
        params: Option<SerialParamsDto>,
        expected_generation: Option<u64>,
    },
    Close {
        port: String,
        expected_generation: Option<u64>,
    },
    SetParams {
        port: String,
        params: SerialParamsDto,
        expected_generation: Option<u64>,
    },
    Flow {
        port: String,
        dtr: bool,
        rts: bool,
        expected_generation: Option<u64>,
    },
    Send {
        port: String,
        bytes: Vec<u8>,
        source: Option<String>,
        expected_generation: Option<u64>,
    },
    Request {
        port: String,
        bytes: Vec<u8>,
        expect: ExpectInput,
        timeout_ms: u64,
        source: Option<String>,
        expected_generation: Option<u64>,
    },
    Tail {
        port: String,
        recent: Option<usize>,
        after_seq: Option<u64>,
        count: Option<u64>,
        idle_timeout_ms: Option<u64>,
    },
    Note {
        port: String,
        text: String,
        source: Option<String>,
    },
    Loan(LoanAction),
    Plugin(PluginAction),
    Artifact(ArtifactAction),
    Remote(RemoteAction),
    Mcp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cli {
    pub target: Target,
    pub format: Format,
    pub action: Action,
}

const VALUE_OPTIONS: &[&str] = &[
    "host",
    "profile",
    "format",
    "baud",
    "data-bits",
    "parity",
    "stop-bits",
    "handshake",
    "dtr",
    "rts",
    "generation",
    "text",
    "hex",
    "eol",
    "source",
    "expect-line",
    "expect-text",
    "expect-hex",
    "timeout",
    "recent",
    "after",
    "count",
    "idle-timeout",
    "holder",
    "reason",
    "ttl",
    "listen",
    "advertise",
    "label",
    "port",
    "role",
    "client-id",
    "invite-file",
    "target",
    "args",
    "artifact",
    "name",
];

const FLAG_OPTIONS: &[&str] = &[
    "no-reopen",
    "reopen",
    "allow-loan",
    "device-plugins",
    "wait",
    "follow",
];

pub fn detect_format_hint(args: &[String]) -> Format {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--" {
            break;
        }
        if arg == "--format" {
            if let Some(val) = iter.next() {
                match val.as_str() {
                    "json" => return Format::Json,
                    "ndjson" => return Format::Ndjson,
                    "text" => return Format::Text,
                    _ => {}
                }
            }
        } else if let Some(val) = arg.strip_prefix("--format=") {
            match val {
                "json" => return Format::Json,
                "ndjson" => return Format::Ndjson,
                "text" => return Format::Text,
                _ => {}
            }
        }
    }
    Format::Text
}

pub fn parse(arguments: impl IntoIterator<Item = String>) -> Result<Cli, String> {
    parse_with_env(arguments, std::env::var("HYPERCOM_HOST_ENDPOINT").ok())
}

pub fn parse_with_env(
    arguments: impl IntoIterator<Item = String>,
    env_host: Option<String>,
) -> Result<Cli, String> {
    let raw: Vec<String> = arguments.into_iter().collect();
    let mut opts: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut flags: BTreeMap<String, usize> = BTreeMap::new();
    let mut positionals: Vec<String> = Vec::new();
    let mut passthrough: Option<Vec<String>> = None;

    // Track whether --host or --profile appeared before a `remote` subcommand
    // so `remote pair --profile NAME` does not collide with global `--profile`.
    let mut seen_remote_cmd = false;
    let mut global_profile_before_remote: Option<String> = None;

    let mut iter = raw.into_iter();
    while let Some(arg) = iter.next() {
        if arg == "--" {
            passthrough = Some(iter.collect());
            break;
        }
        if arg == "--help" || arg == "-h" {
            return Ok(Cli {
                target: resolve_target(None, None, env_host.as_deref())?,
                format: Format::Text,
                action: Action::Help,
            });
        }
        if arg == "--version" || arg == "-V" {
            return Ok(Cli {
                target: resolve_target(None, None, env_host.as_deref())?,
                format: Format::Text,
                action: Action::Version,
            });
        }

        if let Some(option) = arg.strip_prefix("--") {
            let (name, inline_val) = match option.split_once('=') {
                Some((n, v)) => (n, Some(v)),
                None => (option, None),
            };
            if FLAG_OPTIONS.contains(&name) {
                if inline_val.is_some() {
                    return Err(format!("--{name} does not take a value"));
                }
                *flags.entry(name.to_owned()).or_insert(0) += 1;
                continue;
            }
            if !VALUE_OPTIONS.contains(&name) {
                return Err(format!("unknown option --{name}"));
            }
            let value = match inline_val {
                Some(v) => v.to_owned(),
                None => iter
                    .next()
                    .ok_or_else(|| format!("--{name} requires a value"))?,
            };
            if name == "profile" && !seen_remote_cmd {
                if global_profile_before_remote.is_some() {
                    return Err("duplicate option --profile".into());
                }
                global_profile_before_remote = Some(value.clone());
            }
            opts.entry(name.to_owned()).or_default().push(value);
        } else if arg.starts_with('-') {
            return Err(format!("unknown option {arg}"));
        } else {
            if positionals.is_empty() && arg == "remote" {
                seen_remote_cmd = true;
            }
            positionals.push(arg);
        }
    }

    let format = match take_single_opt(&mut opts, "format")?.as_deref() {
        None | Some("text") => Format::Text,
        Some("json") => Format::Json,
        Some("ndjson") => Format::Ndjson,
        Some(other) => return Err(format!("--format must be text, json, or ndjson (got {other})")),
    };

    let is_remote_subcmd = positionals.first().map(String::as_str) == Some("remote");
    let host_opt = take_single_opt(&mut opts, "host")?;
    let global_profile_opt = if is_remote_subcmd {
        // Only treat `--profile` appearing *before* `remote` as global target;
        // `--profile` after `remote` belongs to `pair`/`check`/`forget`.
        if let Some(ref pre) = global_profile_before_remote {
            // Remove the first `--profile` entry from opts (which was before `remote`),
            // leaving any second `--profile` (for `remote pair --profile X`) if present.
            if let Some(vec) = opts.get_mut("profile") {
                if !vec.is_empty() {
                    vec.remove(0);
                    if vec.is_empty() {
                        opts.remove("profile");
                    }
                }
            }
            Some(pre.clone())
        } else {
            None
        }
    } else {
        take_single_opt(&mut opts, "profile")?
    };

    let target = resolve_target(
        host_opt.as_deref(),
        global_profile_opt.as_deref(),
        env_host.as_deref(),
    )?;

    let pos_refs: Vec<&str> = positionals.iter().map(String::as_str).collect();

    if passthrough.is_some() && pos_refs.first().copied() != Some("loan") {
        return Err("unexpected `--` separator outside `loan <PORT> -- <CMD>`".into());
    }

    let action = match pos_refs.as_slice() {
        [] | ["help"] => Action::Help,
        ["ping"] | ["info"] => Action::Ping,
        ["ports"] => Action::Ports,
        ["status", port] => Action::Status {
            port: non_empty_port(port)?,
        },
        ["open", port] => {
            let params = parse_optional_serial_params(&mut opts)?;
            let expected_generation = take_u64_opt(&mut opts, "generation", 0, u64::MAX)?;
            Action::Open {
                port: non_empty_port(port)?,
                params,
                expected_generation,
            }
        }
        ["close", port] => Action::Close {
            port: non_empty_port(port)?,
            expected_generation: take_u64_opt(&mut opts, "generation", 0, u64::MAX)?,
        },
        ["set-params", port] => {
            let params = parse_optional_serial_params(&mut opts)?.ok_or(
                "set-params requires at least one parameter (--baud, --data-bits, --parity, --stop-bits, --handshake, --dtr, --rts)",
            )?;
            let expected_generation = take_u64_opt(&mut opts, "generation", 0, u64::MAX)?;
            Action::SetParams {
                port: non_empty_port(port)?,
                params,
                expected_generation,
            }
        }
        ["flow", port] => {
            let dtr = parse_on_off_required(&mut opts, "dtr")?;
            let rts = parse_on_off_required(&mut opts, "rts")?;
            let expected_generation = take_u64_opt(&mut opts, "generation", 0, u64::MAX)?;
            Action::Flow {
                port: non_empty_port(port)?,
                dtr,
                rts,
                expected_generation,
            }
        }
        ["send", port] => {
            let bytes = parse_tx_payload(&mut opts)?;
            let source = take_single_opt(&mut opts, "source")?;
            let expected_generation = take_u64_opt(&mut opts, "generation", 0, u64::MAX)?;
            Action::Send {
                port: non_empty_port(port)?,
                bytes,
                source,
                expected_generation,
            }
        }
        ["request", port] => {
            let bytes = parse_tx_payload(&mut opts)?;
            let expect = parse_expect(&mut opts)?;
            let timeout_ms = match take_single_opt(&mut opts, "timeout")? {
                Some(raw) => {
                    let ms = parse_duration_ms(&raw, "--timeout")?;
                    if !(1..=MAX_EXPECT_MS).contains(&ms) {
                        return Err(format!("--timeout must be between 1ms and {MAX_EXPECT_MS}ms"));
                    }
                    ms
                }
                None => 3_000,
            };
            let source = take_single_opt(&mut opts, "source")?;
            let expected_generation = take_u64_opt(&mut opts, "generation", 0, u64::MAX)?;
            Action::Request {
                port: non_empty_port(port)?,
                bytes,
                expect,
                timeout_ms,
                source,
                expected_generation,
            }
        }
        ["tail", port] => {
            let recent = take_u64_opt(&mut opts, "recent", 1, usize::MAX as u64)?
                .map(|v| v as usize);
            let after_seq = take_u64_opt(&mut opts, "after", 0, u64::MAX)?;
            if recent.is_some() && after_seq.is_some() {
                return Err("--recent and --after are mutually exclusive".into());
            }
            let count = take_u64_opt(&mut opts, "count", 1, u64::MAX)?;
            let idle_timeout_ms = take_single_opt(&mut opts, "idle-timeout")?
                .map(|raw| parse_duration_ms(&raw, "--idle-timeout"))
                .transpose()?;
            Action::Tail {
                port: non_empty_port(port)?,
                recent,
                after_seq,
                count,
                idle_timeout_ms,
            }
        }
        ["note", port] => {
            let text = take_single_opt(&mut opts, "text")?
                .ok_or_else(|| "note requires --text TEXT".to_owned())?;
            if text.is_empty() {
                return Err("--text cannot be empty for note".into());
            }
            let source = take_single_opt(&mut opts, "source")?;
            Action::Note {
                port: non_empty_port(port)?,
                text,
                source,
            }
        }
        ["loan", "help"] => Action::Help,
        ["loan", rest @ ..] => {
            let loan_action = parse_loan(rest, passthrough, &mut opts, &mut flags)?;
            Action::Loan(loan_action)
        }
        ["plugin", "help"] => Action::Help,
        ["plugin", rest @ ..] => {
            let plugin_action = parse_plugin(rest, &mut opts, &mut flags)?;
            Action::Plugin(plugin_action)
        }
        ["artifact", "help"] => Action::Help,
        ["artifact", rest @ ..] => {
            let artifact_action = parse_artifact(rest, &mut opts)?;
            Action::Artifact(artifact_action)
        }
        ["remote", "help"] => Action::Help,
        ["remote", rest @ ..] => {
            if global_profile_opt.is_some()
                && !matches!(rest, ["status"] | ["clients"])
            {
                return Err("--profile target cannot be used with this remote command".into());
            }
            let remote_action = parse_remote(rest, &mut opts, &mut flags)?;
            Action::Remote(remote_action)
        }
        ["mcp"] => Action::Mcp,
        [cmd, ..] => {
            return Err(format!("unknown command or wrong arguments for: {cmd}"));
        }
    };

    if let Some((name, _)) = opts.iter().next() {
        return Err(format!("--{name} is not valid for this command"));
    }
    if let Some((flag, _)) = flags.iter().next() {
        return Err(format!("--{flag} is not valid for this command"));
    }

    Ok(Cli {
        target,
        format,
        action,
    })
}

fn resolve_target(
    host: Option<&str>,
    profile: Option<&str>,
    env_host: Option<&str>,
) -> Result<Target, String> {
    if host.is_some() && profile.is_some() {
        return Err("--host and --profile are mutually exclusive".into());
    }
    if let Some(p) = profile {
        if p.is_empty() {
            return Err("--profile must not be empty".into());
        }
        return Ok(Target::Profile(p.to_owned()));
    }
    if let Some(h) = host {
        if h.is_empty() {
            return Err("--host must not be empty".into());
        }
        return Ok(Target::Local(h.to_owned()));
    }
    let endpoint = env_host
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_ENDPOINT);
    Ok(Target::Local(endpoint.to_owned()))
}

fn non_empty_port(port: &str) -> Result<String, String> {
    if port.is_empty() {
        return Err("port identifier cannot be empty".into());
    }
    Ok(port.to_owned())
}

fn take_single_opt(
    opts: &mut BTreeMap<String, Vec<String>>,
    name: &str,
) -> Result<Option<String>, String> {
    let Some(mut vals) = opts.remove(name) else {
        return Ok(None);
    };
    if vals.len() > 1 {
        return Err(format!("duplicate option --{name}"));
    }
    Ok(vals.pop())
}

fn take_multi_opt(opts: &mut BTreeMap<String, Vec<String>>, name: &str) -> Vec<String> {
    opts.remove(name).unwrap_or_default()
}

fn take_flag(flags: &mut BTreeMap<String, usize>, name: &str) -> Result<bool, String> {
    match flags.remove(name) {
        None => Ok(false),
        Some(1) => Ok(true),
        Some(_) => Err(format!("duplicate flag --{name}")),
    }
}

fn take_u64_opt(
    opts: &mut BTreeMap<String, Vec<String>>,
    name: &str,
    min: u64,
    max: u64,
) -> Result<Option<u64>, String> {
    take_single_opt(opts, name)?
        .map(|val| parse_integer(&val, &format!("--{name}"), min, max))
        .transpose()
}

pub fn parse_integer(raw: &str, option: &str, min: u64, max: u64) -> Result<u64, String> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("{option} expects an integer in {min}..={max}"));
    }
    raw.parse::<u64>()
        .ok()
        .filter(|n| (min..=max).contains(n))
        .ok_or_else(|| format!("{option} expects an integer in {min}..={max}"))
}

pub fn parse_duration_ms(raw: &str, option: &str) -> Result<u64, String> {
    let trimmed = raw.trim();
    let (digits, factor) = if let Some(rest) = trimmed.strip_suffix("ms") {
        (rest, 1u64)
    } else if let Some(rest) = trimmed.strip_suffix('s') {
        (rest, 1_000u64)
    } else if let Some(rest) = trimmed.strip_suffix('m') {
        (rest, 60_000u64)
    } else if let Some(rest) = trimmed.strip_suffix('h') {
        (rest, 3_600_000u64)
    } else {
        return Err(format!(
            "{option} requires a duration unit (ms, s, m, h), e.g. 500ms or 3s"
        ));
    };
    let count = parse_integer(digits, option, 1, u64::MAX / factor)?;
    Ok(count * factor)
}

fn parse_ttl_secs(raw: &str, option: &str) -> Result<u64, String> {
    let trimmed = raw.trim();
    let secs = if trimmed.bytes().all(|b| b.is_ascii_digit()) {
        parse_integer(trimmed, option, 1, 3_600)?
    } else {
        let ms = parse_duration_ms(trimmed, option)?;
        if ms % 1_000 != 0 {
            return Err(format!("{option} must be a whole number of seconds (1..=3600)"));
        }
        let s = ms / 1_000;
        if !(1..=3_600).contains(&s) {
            return Err(format!("{option} must be between 1 and 3600 seconds"));
        }
        s
    };
    Ok(secs)
}

pub fn parse_hex_strict(raw: &str) -> Result<Vec<u8>, String> {
    let cleaned: String = raw.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    if cleaned.is_empty() {
        return Err("hex payload cannot be empty".into());
    }
    if !cleaned.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("hex input contains non-hexadecimal characters".into());
    }
    if !cleaned.len().is_multiple_of(2) {
        return Err("hex input must contain an even number of hex digits (no zero-padding)".into());
    }
    let mut out = Vec::with_capacity(cleaned.len() / 2);
    let (chunks, _) = cleaned.as_bytes().as_chunks::<2>();
    for chunk in chunks {
        let s = std::str::from_utf8(chunk).expect("ascii hex");
        let byte = u8::from_str_radix(s, 16).map_err(|e| format!("invalid hex byte: {e}"))?;
        out.push(byte);
    }
    Ok(out)
}

pub fn apply_eol_bytes(text: &str, eol: Option<&str>) -> Result<Vec<u8>, String> {
    let suffix: &[u8] = match eol {
        None | Some("none") => b"",
        Some("lf") => b"\n",
        Some("cr") => b"\r",
        Some("crlf") => b"\r\n",
        Some(other) => return Err(format!("--eol must be none, lf, cr, or crlf (got {other})")),
    };
    let mut bytes = Vec::with_capacity(text.len() + suffix.len());
    bytes.extend_from_slice(text.as_bytes());
    bytes.extend_from_slice(suffix);
    Ok(bytes)
}

fn parse_tx_payload(opts: &mut BTreeMap<String, Vec<String>>) -> Result<Vec<u8>, String> {
    let text = take_single_opt(opts, "text")?;
    let hex = take_single_opt(opts, "hex")?;
    let eol = take_single_opt(opts, "eol")?;

    let bytes = match (text, hex) {
        (Some(t), None) => apply_eol_bytes(&t, eol.as_deref())?,
        (None, Some(h)) => {
            if eol.is_some() {
                return Err("--eol cannot be combined with --hex".into());
            }
            parse_hex_strict(&h)?
        }
        (Some(_), Some(_)) => return Err("--text and --hex are mutually exclusive".into()),
        (None, None) => return Err("supply exactly one of --text or --hex".into()),
    };

    if bytes.is_empty() || bytes.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "send payload must contain 1..={MAX_WRITE_BYTES} bytes"
        ));
    }
    Ok(bytes)
}

fn parse_expect(opts: &mut BTreeMap<String, Vec<String>>) -> Result<ExpectInput, String> {
    let line = take_single_opt(opts, "expect-line")?;
    let text = take_single_opt(opts, "expect-text")?;
    let hex = take_single_opt(opts, "expect-hex")?;

    let (expect, len) = match (line, text, hex) {
        (Some(l), None, None) => {
            if l.contains('\n') {
                return Err("--expect-line cannot contain a newline".into());
            }
            let len = l.len();
            (ExpectInput::Line(l), len)
        }
        (None, Some(t), None) => {
            let len = t.len();
            (ExpectInput::Text(t), len)
        }
        (None, None, Some(h)) => {
            let bytes = parse_hex_strict(&h)?;
            let len = bytes.len();
            (ExpectInput::Bytes(bytes), len)
        }
        _ => {
            return Err(
                "supply exactly one of --expect-line, --expect-text, or --expect-hex".into(),
            );
        }
    };

    if len == 0 || len > MAX_EXPECT_BYTES {
        return Err(format!(
            "expected pattern must contain 1..={MAX_EXPECT_BYTES} bytes"
        ));
    }
    Ok(expect)
}

fn parse_optional_serial_params(
    opts: &mut BTreeMap<String, Vec<String>>,
) -> Result<Option<SerialParamsDto>, String> {
    let baud = take_u64_opt(opts, "baud", 1, u64::from(u32::MAX))?;
    let data_bits = take_u64_opt(opts, "data-bits", 5, 8)?;
    let parity = take_single_opt(opts, "parity")?;
    let stop_bits = take_single_opt(opts, "stop-bits")?;
    let handshake = take_single_opt(opts, "handshake")?;
    let dtr = parse_on_off_opt(opts, "dtr")?;
    let rts = parse_on_off_opt(opts, "rts")?;

    if baud.is_none()
        && data_bits.is_none()
        && parity.is_none()
        && stop_bits.is_none()
        && handshake.is_none()
        && dtr.is_none()
        && rts.is_none()
    {
        return Ok(None);
    }

    let mut dto = SerialParamsDto::default();
    if let Some(b) = baud {
        dto.baud_rate = b as u32;
    }
    if let Some(db) = data_bits {
        dto.data_bits = db as u8;
    }
    if let Some(p) = parity {
        dto.parity = normalize_parity(&p)?;
    }
    if let Some(sb) = stop_bits {
        dto.stop_bits = normalize_stop_bits(&sb)?;
    }
    if let Some(hs) = handshake {
        dto.handshake = normalize_handshake(&hs)?;
    }
    if let Some(v) = dtr {
        dto.dtr = v;
    }
    if let Some(v) = rts {
        dto.rts = v;
    }
    Ok(Some(dto))
}

pub fn normalize_parity(raw: &str) -> Result<String, String> {
    match raw.to_ascii_lowercase().as_str() {
        "none" => Ok("none".into()),
        "odd" => Ok("odd".into()),
        "even" => Ok("even".into()),
        _ => Err(format!("--parity must be none, odd, or even (got {raw})")),
    }
}

pub fn normalize_stop_bits(raw: &str) -> Result<String, String> {
    match raw.to_ascii_lowercase().as_str() {
        "1" | "one" => Ok("one".into()),
        "2" | "two" => Ok("two".into()),
        _ => Err(format!("--stop-bits must be 1 or 2 (got {raw})")),
    }
}

pub fn normalize_handshake(raw: &str) -> Result<String, String> {
    match raw.to_ascii_lowercase().as_str() {
        "none" => Ok("none".into()),
        "xonxoff" => Ok("xonxoff".into()),
        "rtscts" => Ok("rtscts".into()),
        _ => Err(format!(
            "--handshake must be none, xonxoff, or rtscts (got {raw})"
        )),
    }
}

fn parse_on_off_opt(
    opts: &mut BTreeMap<String, Vec<String>>,
    name: &str,
) -> Result<Option<bool>, String> {
    take_single_opt(opts, name)?
        .map(|val| match val.to_ascii_lowercase().as_str() {
            "on" | "true" | "1" => Ok(true),
            "off" | "false" | "0" => Ok(false),
            _ => Err(format!("--{name} must be on or off")),
        })
        .transpose()
}

fn parse_on_off_required(
    opts: &mut BTreeMap<String, Vec<String>>,
    name: &str,
) -> Result<bool, String> {
    parse_on_off_opt(opts, name)?.ok_or_else(|| format!("--{name} on|off is required"))
}

fn parse_loan(
    rest: &[&str],
    passthrough: Option<Vec<String>>,
    opts: &mut BTreeMap<String, Vec<String>>,
    flags: &mut BTreeMap<String, usize>,
) -> Result<LoanAction, String> {
    if let Some(cmd_args) = passthrough {
        let [port] = rest else {
            return Err("usage: hypercomctl loan <PORT> [OPTIONS] -- <PROGRAM> [ARGS...]".into());
        };
        let mut iter = cmd_args.into_iter();
        let program = iter
            .next()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "missing <PROGRAM> after `--`".to_owned())?;
        let args: Vec<String> = iter.collect();
        let holder = take_single_opt(opts, "holder")?;
        let reason = take_single_opt(opts, "reason")?;
        let ttl_ms = take_single_opt(opts, "ttl")?
            .map(|v| parse_duration_ms(&v, "--ttl"))
            .transpose()?
            .unwrap_or(60_000);
        let no_reopen = take_flag(flags, "no-reopen")?;
        let expected_generation = take_u64_opt(opts, "generation", 0, u64::MAX)?;
        return Ok(LoanAction::Run {
            port: non_empty_port(port)?,
            holder,
            reason,
            ttl_ms,
            auto_reopen: !no_reopen,
            expected_generation,
            program,
            args,
        });
    }

    match rest {
        ["acquire", port] => {
            let holder = take_single_opt(opts, "holder")?;
            let reason = take_single_opt(opts, "reason")?;
            let ttl_ms = take_single_opt(opts, "ttl")?
                .map(|v| parse_duration_ms(&v, "--ttl"))
                .transpose()?
                .unwrap_or(60_000);
            let no_reopen = take_flag(flags, "no-reopen")?;
            let expected_generation = take_u64_opt(opts, "generation", 0, u64::MAX)?;
            Ok(LoanAction::Acquire {
                port: non_empty_port(port)?,
                holder,
                reason,
                ttl_ms,
                auto_reopen: !no_reopen,
                expected_generation,
            })
        }
        ["heartbeat", lease_id] => {
            let ttl_ms = take_single_opt(opts, "ttl")?
                .map(|v| parse_duration_ms(&v, "--ttl"))
                .transpose()?;
            Ok(LoanAction::Heartbeat {
                lease_id: non_empty_port(lease_id)?,
                ttl_ms,
            })
        }
        ["release", lease_id] => {
            let reopen = take_flag(flags, "reopen")?;
            let no_reopen = take_flag(flags, "no-reopen")?;
            if reopen && no_reopen {
                return Err("--reopen and --no-reopen are mutually exclusive".into());
            }
            let reopen_override = if reopen {
                Some(true)
            } else if no_reopen {
                Some(false)
            } else {
                None
            };
            Ok(LoanAction::Release {
                lease_id: non_empty_port(lease_id)?,
                reopen_override,
            })
        }
        ["reclaim", port] => Ok(LoanAction::Reclaim {
            port: non_empty_port(port)?,
        }),
        ["list"] => Ok(LoanAction::List),
        _ => Err(
            "usage: hypercomctl loan (<PORT> [OPTIONS] -- <CMD> [ARGS...] | acquire <PORT> | heartbeat <LEASE_ID> | release <LEASE_ID> | reclaim <PORT> | list)"
                .into(),
        ),
    }
}

fn parse_remote(
    rest: &[&str],
    opts: &mut BTreeMap<String, Vec<String>>,
    flags: &mut BTreeMap<String, usize>,
) -> Result<RemoteAction, String> {
    match rest {
        ["status"] => Ok(RemoteAction::Status),
        ["start"] => {
            let listen = take_single_opt(opts, "listen")?
                .ok_or_else(|| "remote start requires --listen <IP:PORT>".to_owned())?;
            let advertise = take_single_opt(opts, "advertise")?;
            Ok(RemoteAction::Start { listen, advertise })
        }
        ["stop"] => Ok(RemoteAction::Stop),
        ["invite"] => {
            let label = take_single_opt(opts, "label")?
                .ok_or_else(|| "remote invite requires --label <LABEL>".to_owned())?;
            let ports = take_multi_opt(opts, "port");
            if ports.is_empty() {
                return Err("remote invite requires at least one --port <COMx>".into());
            }
            let role = match take_single_opt(opts, "role")? {
                Some(r) => r.parse::<RemoteRole>().map_err(|e| e.message)?,
                None => RemoteRole::Observe,
            };
            let allow_loan = take_flag(flags, "allow-loan")?;
            let device_plugins = take_flag(flags, "device-plugins")?;
            let ttl_secs = take_single_opt(opts, "ttl")?
                .map(|v| parse_ttl_secs(&v, "--ttl"))
                .transpose()?;
            Ok(RemoteAction::Invite {
                label,
                ports,
                role,
                allow_loan,
                device_plugins,
                ttl_secs,
            })
        }
        ["clients"] => Ok(RemoteAction::Clients),
        ["revoke"] => {
            let client_id = take_single_opt(opts, "client-id")?
                .ok_or_else(|| "remote revoke requires --client-id <ID>".to_owned())?;
            Ok(RemoteAction::Revoke { client_id })
        }
        ["pair"] => {
            let profile = take_single_opt(opts, "profile")?
                .ok_or_else(|| "remote pair requires --profile <NAME>".to_owned())?;
            let invite_file = take_single_opt(opts, "invite-file")?;
            Ok(RemoteAction::Pair {
                profile,
                invite_file,
            })
        }
        ["profiles"] => Ok(RemoteAction::Profiles),
        ["check"] => {
            let profile = take_single_opt(opts, "profile")?
                .ok_or_else(|| "remote check requires --profile <NAME>".to_owned())?;
            Ok(RemoteAction::Check { profile })
        }
        ["forget"] => {
            let profile = take_single_opt(opts, "profile")?
                .ok_or_else(|| "remote forget requires --profile <NAME>".to_owned())?;
            Ok(RemoteAction::Forget { profile })
        }
        _ => Err(
            "usage: hypercomctl remote (status|start|stop|invite|clients|revoke|pair|profiles|check|forget)"
                .into(),
        ),
    }
}

fn non_empty_value(val: &str, label: &str) -> Result<String, String> {
    if val.is_empty() {
        return Err(format!("{label} cannot be empty"));
    }
    Ok(val.to_owned())
}

fn take_non_empty_opt(
    opts: &mut BTreeMap<String, Vec<String>>,
    name: &str,
) -> Result<Option<String>, String> {
    take_single_opt(opts, name)?
        .map(|val| non_empty_value(&val, &format!("--{name}")))
        .transpose()
}

fn parse_plugin(
    rest: &[&str],
    opts: &mut BTreeMap<String, Vec<String>>,
    flags: &mut BTreeMap<String, usize>,
) -> Result<PluginAction, String> {
    match rest {
        ["list"] => Ok(PluginAction::List),
        ["call", plugin_id, tool] => {
            let plugin_id = non_empty_value(plugin_id, "<PLUGIN_ID>")?;
            let tool = non_empty_value(tool, "<TOOL>")?;
            let target = take_non_empty_opt(opts, "target")?;
            let args = match take_single_opt(opts, "args")? {
                Some(raw) => serde_json::from_str::<Value>(&raw)
                    .map_err(|e| format!("--args must be valid JSON: {e}"))?,
                None => Value::Object(Default::default()),
            };
            let artifacts = take_multi_opt(opts, "artifact")
                .into_iter()
                .map(|id| non_empty_value(&id, "--artifact"))
                .collect::<Result<Vec<_>, _>>()?;
            let timeout_ms = take_single_opt(opts, "timeout")?
                .map(|raw| parse_duration_ms(&raw, "--timeout"))
                .transpose()?;
            let wait = take_flag(flags, "wait")?;
            Ok(PluginAction::Call {
                plugin_id,
                tool,
                target,
                args,
                artifacts,
                timeout_ms,
                wait,
            })
        }
        ["job", job_id] => {
            let job_id = non_empty_value(job_id, "<JOB_ID>")?;
            let target = take_non_empty_opt(opts, "target")?;
            let after_seq = take_u64_opt(opts, "after", 0, u64::MAX)?;
            let follow = take_flag(flags, "follow")?;
            Ok(PluginAction::Job {
                job_id,
                target,
                after_seq,
                follow,
            })
        }
        ["cancel", job_id] => {
            let job_id = non_empty_value(job_id, "<JOB_ID>")?;
            let target = take_non_empty_opt(opts, "target")?;
            Ok(PluginAction::Cancel { job_id, target })
        }
        _ => Err(
            "usage: hypercomctl plugin (list | call <PLUGIN_ID> <TOOL> | job <JOB_ID> | cancel <JOB_ID>)"
                .into(),
        ),
    }
}

fn parse_artifact(
    rest: &[&str],
    opts: &mut BTreeMap<String, Vec<String>>,
) -> Result<ArtifactAction, String> {
    match rest {
        ["upload", file_path] => {
            let file_path = non_empty_value(file_path, "<FILE_PATH>")?;
            let target = take_non_empty_opt(opts, "target")?;
            let name = take_non_empty_opt(opts, "name")?;
            let ttl_ms = take_single_opt(opts, "ttl")?
                .map(|raw| parse_duration_ms(&raw, "--ttl"))
                .transpose()?;
            Ok(ArtifactAction::Upload {
                file_path,
                target,
                name,
                ttl_ms,
            })
        }
        _ => Err("usage: hypercomctl artifact upload <FILE_PATH> [--target local|remote::<PROFILE>] [--name NAME] [--ttl 30m]".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_parse(args: &[&str]) -> Result<Cli, String> {
        parse_with_env(args.iter().map(|s| (*s).to_owned()), None)
    }

    #[test]
    fn parses_global_flags_before_and_after_subcommand_and_mutual_exclusion() {
        let a = test_parse(&["--host", "lab", "--format", "json", "ports"]).unwrap();
        assert_eq!(a.target, Target::Local("lab".into()));
        assert_eq!(a.format, Format::Json);
        assert_eq!(a.action, Action::Ports);

        let b = test_parse(&["ports", "--format=ndjson", "--profile", "bench"]).unwrap();
        assert_eq!(b.target, Target::Profile("bench".into()));
        assert_eq!(b.format, Format::Ndjson);
        assert_eq!(b.action, Action::Ports);

        let env_default = parse_with_env(
            ["ports".to_owned()],
            Some("custom-env".to_owned()),
        )
        .unwrap();
        assert_eq!(env_default.target, Target::Local("custom-env".into()));

        assert!(test_parse(&["--host", "a", "--profile", "b", "ports"]).is_err());
        assert!(test_parse(&["ports", "--host", "a", "--profile", "b"]).is_err());
        assert!(test_parse(&["--host", "", "ports"]).is_err());
        assert!(test_parse(&["--profile", "", "ports"]).is_err());
    }

    #[test]
    fn parses_all_core_serial_commands() {
        assert_eq!(test_parse(&["ping"]).unwrap().action, Action::Ping);
        assert_eq!(test_parse(&["info"]).unwrap().action, Action::Ping);
        assert_eq!(
            test_parse(&["status", "COM3"]).unwrap().action,
            Action::Status {
                port: "COM3".into()
            }
        );
        assert_eq!(
            test_parse(&[
                "open",
                "COM3",
                "--baud",
                "921600",
                "--data-bits",
                "7",
                "--parity",
                "even",
                "--stop-bits",
                "2",
                "--handshake",
                "rtscts",
                "--dtr",
                "on",
                "--rts",
                "off",
                "--generation",
                "4"
            ])
            .unwrap()
            .action,
            Action::Open {
                port: "COM3".into(),
                params: Some(SerialParamsDto {
                    baud_rate: 921_600,
                    data_bits: 7,
                    parity: "even".into(),
                    stop_bits: "two".into(),
                    handshake: "rtscts".into(),
                    dtr: true,
                    rts: false,
                }),
                expected_generation: Some(4),
            }
        );
        assert_eq!(
            test_parse(&["open", "COM3"]).unwrap().action,
            Action::Open {
                port: "COM3".into(),
                params: None,
                expected_generation: None,
            }
        );
        assert_eq!(
            test_parse(&["close", "COM3", "--generation", "2"])
                .unwrap()
                .action,
            Action::Close {
                port: "COM3".into(),
                expected_generation: Some(2),
            }
        );
        assert_eq!(
            test_parse(&["flow", "COM3", "--dtr", "on", "--rts", "off"])
                .unwrap()
                .action,
            Action::Flow {
                port: "COM3".into(),
                dtr: true,
                rts: false,
                expected_generation: None,
            }
        );
        assert_eq!(
            test_parse(&["set-params", "COM3", "--baud", "57600"])
                .unwrap()
                .action,
            Action::SetParams {
                port: "COM3".into(),
                params: SerialParamsDto {
                    baud_rate: 57_600,
                    ..SerialParamsDto::default()
                },
                expected_generation: None,
            }
        );
        assert!(test_parse(&["set-params", "COM3"]).is_err());
    }

    #[test]
    fn validates_strict_hex_and_send_request_tail_note() {
        let send_text = test_parse(&[
            "send", "COM3", "--text", "AT", "--eol", "crlf", "--source", "agent",
        ])
        .unwrap();
        assert_eq!(
            send_text.action,
            Action::Send {
                port: "COM3".into(),
                bytes: b"AT\r\n".to_vec(),
                source: Some("agent".into()),
                expected_generation: None,
            }
        );

        let send_hex = test_parse(&["send", "COM3", "--hex", "DE AD be ef"]).unwrap();
        assert_eq!(
            send_hex.action,
            Action::Send {
                port: "COM3".into(),
                bytes: vec![0xDE, 0xAD, 0xBE, 0xEF],
                source: None,
                expected_generation: None,
            }
        );

        // Strict HEX rejection cases: odd length, invalid digit, combined with --eol, empty
        for bad in [
            &["send", "COM3", "--hex", "0"][..],
            &["send", "COM3", "--hex", "ABC"][..],
            &["send", "COM3", "--hex", "ZZ"][..],
            &["send", "COM3", "--hex", "AA", "--eol", "lf"][..],
            &["send", "COM3", "--hex", "   "][..],
            &["send", "COM3", "--text", "a", "--hex", "AA"][..],
            &["send", "COM3", "--text", ""][..],
        ] {
            assert!(test_parse(bad).is_err(), "expected failure for {bad:?}");
        }

        let req = test_parse(&[
            "request",
            "COM3",
            "--text",
            "AT",
            "--eol",
            "cr",
            "--expect-line",
            "OK",
            "--timeout",
            "500ms",
        ])
        .unwrap();
        assert_eq!(
            req.action,
            Action::Request {
                port: "COM3".into(),
                bytes: b"AT\r".to_vec(),
                expect: ExpectInput::Line("OK".into()),
                timeout_ms: 500,
                source: None,
                expected_generation: None,
            }
        );

        let tail = test_parse(&[
            "tail",
            "COM3",
            "--recent",
            "20",
            "--count",
            "5",
            "--idle-timeout",
            "5s",
        ])
        .unwrap();
        assert_eq!(
            tail.action,
            Action::Tail {
                port: "COM3".into(),
                recent: Some(20),
                after_seq: None,
                count: Some(5),
                idle_timeout_ms: Some(5_000),
            }
        );
        assert!(test_parse(&["tail", "COM3", "--recent", "5", "--after", "10"]).is_err());

        assert_eq!(
            test_parse(&["note", "COM3", "--text", "Flashing firmware"])
                .unwrap()
                .action,
            Action::Note {
                port: "COM3".into(),
                text: "Flashing firmware".into(),
                source: None,
            }
        );
    }

    #[test]
    fn parses_loan_wrapper_and_two_step_commands() {
        let wrapper = test_parse(&[
            "loan",
            "COM3",
            "--holder",
            "flasher",
            "--reason",
            "update",
            "--ttl",
            "90s",
            "--no-reopen",
            "--generation",
            "7",
            "--",
            "esptool.py",
            "--port",
            "COM3",
            "--baud",
            "921600",
        ])
        .unwrap();
        assert_eq!(
            wrapper.action,
            Action::Loan(LoanAction::Run {
                port: "COM3".into(),
                holder: Some("flasher".into()),
                reason: Some("update".into()),
                ttl_ms: 90_000,
                auto_reopen: false,
                expected_generation: Some(7),
                program: "esptool.py".into(),
                args: vec![
                    "--port".into(),
                    "COM3".into(),
                    "--baud".into(),
                    "921600".into()
                ],
            })
        );

        assert!(test_parse(&["loan", "COM3", "--"]).is_err());
        assert_eq!(
            test_parse(&["loan", "acquire", "COM3", "--ttl", "30s"])
                .unwrap()
                .action,
            Action::Loan(LoanAction::Acquire {
                port: "COM3".into(),
                holder: None,
                reason: None,
                ttl_ms: 30_000,
                auto_reopen: true,
                expected_generation: None,
            })
        );
        assert_eq!(
            test_parse(&["loan", "heartbeat", "lease-1", "--ttl", "45s"])
                .unwrap()
                .action,
            Action::Loan(LoanAction::Heartbeat {
                lease_id: "lease-1".into(),
                ttl_ms: Some(45_000),
            })
        );
        assert_eq!(
            test_parse(&["loan", "release", "lease-1", "--reopen"])
                .unwrap()
                .action,
            Action::Loan(LoanAction::Release {
                lease_id: "lease-1".into(),
                reopen_override: Some(true),
            })
        );
        assert!(test_parse(&["loan", "release", "lease-1", "--reopen", "--no-reopen"]).is_err());
        assert_eq!(
            test_parse(&["loan", "reclaim", "COM3"]).unwrap().action,
            Action::Loan(LoanAction::Reclaim {
                port: "COM3".into()
            })
        );
        assert_eq!(
            test_parse(&["loan", "list"]).unwrap().action,
            Action::Loan(LoanAction::List)
        );
    }

    #[test]
    fn parses_remote_and_mcp_commands() {
        let invite = test_parse(&[
            "remote",
            "invite",
            "--label",
            "ci-runner",
            "--port",
            "COM3",
            "--port",
            "COM4",
            "--role",
            "control",
            "--allow-loan",
            "--ttl",
            "300",
        ])
        .unwrap();
        assert_eq!(
            invite.action,
            Action::Remote(RemoteAction::Invite {
                label: "ci-runner".into(),
                ports: vec!["COM3".into(), "COM4".into()],
                role: RemoteRole::Control,
                allow_loan: true,
                device_plugins: false,
                ttl_secs: Some(300),
            })
        );

        let invite_plugins = test_parse(&[
            "remote",
            "invite",
            "--label",
            "flasher",
            "--port",
            "COM3",
            "--device-plugins",
        ])
        .unwrap();
        assert_eq!(
            invite_plugins.action,
            Action::Remote(RemoteAction::Invite {
                label: "flasher".into(),
                ports: vec!["COM3".into()],
                role: RemoteRole::Observe,
                allow_loan: false,
                device_plugins: true,
                ttl_secs: None,
            })
        );

        let pair = test_parse(&[
            "--format",
            "json",
            "remote",
            "pair",
            "--profile",
            "lab-a",
            "--invite-file",
            "invite.json",
        ])
        .unwrap();
        assert_eq!(pair.format, Format::Json);
        assert_eq!(pair.target, Target::Local(DEFAULT_ENDPOINT.into()));
        assert_eq!(
            pair.action,
            Action::Remote(RemoteAction::Pair {
                profile: "lab-a".into(),
                invite_file: Some("invite.json".into()),
            })
        );

        assert_eq!(
            test_parse(&["remote", "profiles"]).unwrap().action,
            Action::Remote(RemoteAction::Profiles)
        );
        assert_eq!(
            test_parse(&["--profile", "lab-a", "mcp"]).unwrap().action,
            Action::Mcp
        );
    }

    #[test]
    fn parses_plugin_and_artifact_commands() {
        assert_eq!(
            test_parse(&["plugin", "list"]).unwrap().action,
            Action::Plugin(PluginAction::List)
        );

        let call = test_parse(&[
            "plugin",
            "call",
            "stm32-flasher",
            "flash",
            "--target",
            "remote::lab",
            "--args",
            r#"{"port":"COM3","verify":true}"#,
            "--artifact",
            "art-1",
            "--artifact",
            "art-2",
            "--timeout",
            "30s",
            "--wait",
        ])
        .unwrap();
        assert_eq!(
            call.action,
            Action::Plugin(PluginAction::Call {
                plugin_id: "stm32-flasher".into(),
                tool: "flash".into(),
                target: Some("remote::lab".into()),
                args: serde_json::json!({"port": "COM3", "verify": true}),
                artifacts: vec!["art-1".into(), "art-2".into()],
                timeout_ms: Some(30_000),
                wait: true,
            })
        );

        let call_min = test_parse(&["plugin", "call", "diag", "info"]).unwrap();
        assert_eq!(
            call_min.action,
            Action::Plugin(PluginAction::Call {
                plugin_id: "diag".into(),
                tool: "info".into(),
                target: None,
                args: serde_json::json!({}),
                artifacts: Vec::new(),
                timeout_ms: None,
                wait: false,
            })
        );

        assert!(test_parse(&["plugin", "call", "diag", "info", "--args", "{bad"]).is_err());
        assert!(test_parse(&["plugin", "call", "diag", "info", "--target", ""]).is_err());
        assert!(test_parse(&["plugin", "call", "diag", "info", "--artifact", ""]).is_err());

        let job = test_parse(&[
            "plugin",
            "job",
            "job-42",
            "--target",
            "local",
            "--after",
            "10",
            "--follow",
        ])
        .unwrap();
        assert_eq!(
            job.action,
            Action::Plugin(PluginAction::Job {
                job_id: "job-42".into(),
                target: Some("local".into()),
                after_seq: Some(10),
                follow: true,
            })
        );

        let cancel = test_parse(&["plugin", "cancel", "job-42", "--target", "remote::lab"]).unwrap();
        assert_eq!(
            cancel.action,
            Action::Plugin(PluginAction::Cancel {
                job_id: "job-42".into(),
                target: Some("remote::lab".into()),
            })
        );

        let upload = test_parse(&[
            "artifact",
            "upload",
            "./build/app.bin",
            "--target",
            "remote::lab",
            "--name",
            "app.bin",
            "--ttl",
            "30m",
        ])
        .unwrap();
        assert_eq!(
            upload.action,
            Action::Artifact(ArtifactAction::Upload {
                file_path: "./build/app.bin".into(),
                target: Some("remote::lab".into()),
                name: Some("app.bin".into()),
                ttl_ms: Some(1_800_000),
            })
        );

        assert!(test_parse(&["artifact", "upload", ""]).is_err());
        assert!(test_parse(&["artifact", "upload", "fw.bin", "--name", ""]).is_err());
    }

    #[test]
    fn duration_parsing_supports_units_and_rejects_bare_numbers() {
        assert_eq!(parse_duration_ms("500ms", "--t").unwrap(), 500);
        assert_eq!(parse_duration_ms("3s", "--t").unwrap(), 3_000);
        assert_eq!(parse_duration_ms("2m", "--t").unwrap(), 120_000);
        assert_eq!(parse_duration_ms("1h", "--t").unwrap(), 3_600_000);
        assert!(parse_duration_ms("0ms", "--t").is_err());
        assert!(parse_duration_ms("5", "--t").is_err());
        assert!(parse_duration_ms("-3s", "--t").is_err());
    }
}
