mod args;
mod loan_cmd;
mod mcp;
mod plugin_cmd;
mod remote_cmd;

use args::{Action, Cli, ExpectInput, Format, Target, USAGE};
use base64::{engine::general_purpose::STANDARD, Engine};
use hypercom_protocol::{
    AsyncControlClient, ControlCommand, EventPageDto, ExpectSpec, HostError, LoanInfoDto,
    PortSnapshotDto, RequestOutcomeDto, StreamEventDto,
};
use serde_json::{json, Value};
use std::{
    env,
    io::{self, Write},
    process::ExitCode,
    time::{Duration, Instant},
};

#[derive(Debug)]
pub struct Failure {
    pub code: String,
    pub message: String,
}

impl Failure {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn exit_code(&self) -> u8 {
        match self.code.as_str() {
            "usage" => 2,
            "host_unavailable" | "pin_mismatch" | "protocol_mismatch" => 3,
            "expect_timeout" | "idle_timeout" | "timeout" => 5,
            "output_error" | "broken_pipe" | "internal_error" | "outcome_unknown"
            | "profile_io" | "spawn_failed" | "artifact_io" => 1,
            _ => 4,
        }
    }

    pub fn print(&self, format: Format) {
        let mut stderr = io::stderr().lock();
        if format == Format::Text {
            let _ = writeln!(stderr, "hypercomctl: {}: {}", self.code, self.message);
        } else {
            let _ = writeln!(
                stderr,
                "{}",
                json!({
                    "code": self.code,
                    "message": self.message,
                })
            );
        }
    }
}

impl From<HostError> for Failure {
    fn from(err: HostError) -> Self {
        Self::new(err.code, err.message)
    }
}

impl From<io::Error> for Failure {
    fn from(err: io::Error) -> Self {
        Self::new(
            if err.kind() == io::ErrorKind::BrokenPipe {
                "broken_pipe"
            } else {
                "output_error"
            },
            err.to_string(),
        )
    }
}

impl From<serde_json::Error> for Failure {
    fn from(err: serde_json::Error) -> Self {
        Self::new("internal_error", err.to_string())
    }
}

pub async fn connect_target(target: &Target) -> Result<AsyncControlClient, Failure> {
    match target {
        Target::Local(endpoint) => Ok(AsyncControlClient::connect_local(endpoint).await?),
        Target::Profile(name) => {
            let profile = remote_cmd::load_stored_profile(name)?;
            Ok(AsyncControlClient::connect_remote(&profile).await?)
        }
    }
}

pub fn write_json(out: &mut impl Write, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *out, value)?;
    writeln!(out)?;
    out.flush()
}

pub fn parse_ports_value(value: Value) -> Result<Vec<PortSnapshotDto>, Failure> {
    if value.is_array() {
        serde_json::from_value(value)
            .map_err(|e| Failure::new("protocol_mismatch", format!("invalid ports list: {e}")))
    } else if let Some(arr) = value.get("ports") {
        serde_json::from_value(arr.clone())
            .map_err(|e| Failure::new("protocol_mismatch", format!("invalid ports list: {e}")))
    } else {
        Err(Failure::new(
            "protocol_mismatch",
            "unexpected ports response shape",
        ))
    }
}

async fn run(cli: Cli, out: &mut impl Write) -> Result<i32, Failure> {
    let Cli {
        target,
        format,
        action,
    } = cli;

    match action {
        Action::Help => {
            out.write_all(USAGE.as_bytes())?;
            out.flush()?;
            Ok(0)
        }
        Action::Version => {
            writeln!(out, "hypercomctl {}", env!("CARGO_PKG_VERSION"))?;
            out.flush()?;
            Ok(0)
        }
        Action::Mcp => {
            mcp::run_stdio(target).await?;
            Ok(0)
        }
        Action::Loan(loan_action) => {
            loan_cmd::execute(&target, format, loan_action, out).await
        }
        Action::Plugin(plugin_action) => {
            plugin_cmd::execute_plugin(&target, format, plugin_action, out).await
        }
        Action::Artifact(artifact_action) => {
            plugin_cmd::execute_artifact(&target, format, artifact_action, out).await?;
            Ok(0)
        }
        Action::Remote(remote_action) => {
            remote_cmd::execute(&target, format, remote_action, out).await?;
            Ok(0)
        }
        Action::Ping => {
            let mut client = connect_target(&target).await?;
            let host_id = client.host_id().to_owned();
            let hello = client.hello_info().clone();
            let info = client.call(ControlCommand::HostInfo).await?;
            let active_loans = info
                .get("activeLoans")
                .and_then(Value::as_u64)
                .or_else(|| info.get("activeLoansCount").and_then(Value::as_u64))
                .or_else(|| {
                    info.get("loans")
                        .and_then(Value::as_array)
                        .map(|a| a.len() as u64)
                });
            let active_loans = match active_loans {
                Some(n) => Some(n),
                None => client
                    .call_typed::<Vec<LoanInfoDto>>(ControlCommand::ListLoans)
                    .await
                    .ok()
                    .map(|l| l.len() as u64),
            };
            let endpoint_label = match &target {
                Target::Local(name) => name.clone(),
                Target::Profile(name) => format!("profile:{name}"),
            };

            let combined = json!({
                "ok": true,
                "hostId": host_id,
                "endpoint": info.get("endpoint").cloned().unwrap_or_else(|| json!(endpoint_label)),
                "hello": hello,
                "hostInfo": info,
                "activeLoansCount": active_loans,
            });
            if format != Format::Text {
                write_json(out, &combined)?;
            } else {
                writeln!(out, "hostId: {}", combined["hostId"].as_str().unwrap_or("?"))?;
                writeln!(
                    out,
                    "endpoint: {}",
                    combined["endpoint"].as_str().unwrap_or(&endpoint_label)
                )?;
                if let Some(features) = combined["hostInfo"]
                    .get("features")
                    .or_else(|| combined["hello"].get("features"))
                    .or_else(|| combined["hello"].get("extensions"))
                    .and_then(Value::as_array)
                {
                    let list: Vec<&str> = features.iter().filter_map(Value::as_str).collect();
                    writeln!(out, "features: {}", list.join(", "))?;
                }
                if let Some(n) = active_loans {
                    writeln!(out, "activeLoans: {n}")?;
                }
                if let Some(remote) = combined["hostInfo"]
                    .get("remote")
                    .or_else(|| combined["hostInfo"].get("remoteStatus"))
                {
                    writeln!(out, "remote: {remote}")?;
                }
                out.flush()?;
            }
            Ok(0)
        }
        Action::Ports => {
            let mut client = connect_target(&target).await?;
            let val = client.call(ControlCommand::Ports).await?;
            let ports = parse_ports_value(val)?;
            if format != Format::Text {
                write_json(out, &serde_json::to_value(&ports)?)?;
            } else if ports.is_empty() {
                writeln!(out, "No serial ports available.")?;
            } else {
                for p in &ports {
                    print_port_summary(out, p)?;
                }
            }
            out.flush()?;
            Ok(0)
        }
        Action::Status { port } => {
            let mut client = connect_target(&target).await?;
            let status: PortSnapshotDto = client
                .call_typed(ControlCommand::Status { port_id: port })
                .await?;
            if format != Format::Text {
                write_json(out, &serde_json::to_value(&status)?)?;
            } else {
                print_port_detail(out, &status)?;
            }
            out.flush()?;
            Ok(0)
        }
        Action::Open {
            port,
            params,
            expected_generation,
        } => {
            let mut client = connect_target(&target).await?;
            let status: PortSnapshotDto = client
                .call_typed(ControlCommand::Open {
                    port_id: port,
                    params,
                    host_id: None,
                    expected_generation,
                })
                .await?;
            if format != Format::Text {
                write_json(out, &serde_json::to_value(&status)?)?;
            } else {
                print_port_detail(out, &status)?;
            }
            out.flush()?;
            Ok(0)
        }
        Action::Close {
            port,
            expected_generation,
        } => {
            let mut client = connect_target(&target).await?;
            let status: PortSnapshotDto = client
                .call_typed(ControlCommand::Close {
                    port_id: port,
                    host_id: None,
                    expected_generation,
                })
                .await?;
            if format != Format::Text {
                write_json(out, &serde_json::to_value(&status)?)?;
            } else {
                print_port_detail(out, &status)?;
            }
            out.flush()?;
            Ok(0)
        }
        Action::SetParams {
            port,
            params,
            expected_generation,
        } => {
            let mut client = connect_target(&target).await?;
            let status: PortSnapshotDto = client
                .call_typed(ControlCommand::SetParams {
                    port_id: port,
                    params,
                    expected_generation,
                })
                .await?;
            if format != Format::Text {
                write_json(out, &serde_json::to_value(&status)?)?;
            } else {
                print_port_detail(out, &status)?;
            }
            out.flush()?;
            Ok(0)
        }
        Action::Flow {
            port,
            dtr,
            rts,
            expected_generation,
        } => {
            let mut client = connect_target(&target).await?;
            let status: PortSnapshotDto = client
                .call_typed(ControlCommand::SetFlowControl {
                    port_id: port,
                    dtr,
                    rts,
                    expected_generation,
                })
                .await?;
            if format != Format::Text {
                write_json(out, &serde_json::to_value(&status)?)?;
            } else {
                print_port_detail(out, &status)?;
            }
            out.flush()?;
            Ok(0)
        }
        Action::Send {
            port,
            bytes,
            source,
            expected_generation,
        } => {
            let mut client = connect_target(&target).await?;
            let res = client
                .call(ControlCommand::Send {
                    port_id: port,
                    data_base64: STANDARD.encode(&bytes),
                    source: Some(source.unwrap_or_else(|| "cli".to_owned())),
                    expected_generation,
                })
                .await?;
            if format != Format::Text {
                write_json(out, &res)?;
            } else {
                let written = res
                    .get("bytesWritten")
                    .and_then(Value::as_u64)
                    .unwrap_or(bytes.len() as u64);
                writeln!(out, "Sent {written} bytes.")?;
            }
            out.flush()?;
            Ok(0)
        }
        Action::Request {
            port,
            bytes,
            expect,
            timeout_ms,
            source,
            expected_generation,
        } => {
            let expect_spec = match expect {
                ExpectInput::Line(text) => ExpectSpec::Line { text },
                ExpectInput::Text(text) => ExpectSpec::Text { text },
                ExpectInput::Bytes(raw) => ExpectSpec::Bytes {
                    data_base64: STANDARD.encode(&raw),
                },
            };
            let mut client = connect_target(&target).await?;
            let outcome: RequestOutcomeDto = client
                .call_typed(ControlCommand::Request {
                    port_id: port,
                    data_base64: STANDARD.encode(&bytes),
                    expect: expect_spec,
                    timeout_ms,
                    source: Some(source.unwrap_or_else(|| "cli".to_owned())),
                    expected_generation,
                })
                .await?;

            if !outcome.matched {
                return Err(Failure::new(
                    "expect_timeout",
                    format!("timed out after {timeout_ms}ms waiting for expected response"),
                ));
            }

            if format != Format::Text {
                write_json(out, &serde_json::to_value(&outcome)?)?;
            } else {
                let matched = outcome.matched_text.clone().unwrap_or_else(|| {
                    outcome
                        .matched_base64
                        .as_deref()
                        .and_then(|b64| STANDARD.decode(b64).ok())
                        .map(|raw| String::from_utf8_lossy(&raw).into_owned())
                        .unwrap_or_default()
                });
                writeln!(out, "{matched}")?;
            }
            out.flush()?;
            Ok(0)
        }
        Action::Tail {
            port,
            recent,
            after_seq,
            count,
            idle_timeout_ms,
        } => {
            let mut client = connect_target(&target).await?;
            tail_events(
                &mut client,
                out,
                format,
                &port,
                recent,
                after_seq,
                count,
                idle_timeout_ms,
            )
            .await?;
            Ok(0)
        }
        Action::Note { port, text, source } => {
            let mut client = connect_target(&target).await?;
            let res = client
                .call(ControlCommand::AddNote {
                    port_id: port,
                    text,
                    source: Some(source.unwrap_or_else(|| "cli".to_owned())),
                })
                .await?;
            if format != Format::Text {
                write_json(out, &res)?;
            } else {
                writeln!(out, "Note added.")?;
            }
            out.flush()?;
            Ok(0)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn tail_events(
    client: &mut AsyncControlClient,
    out: &mut impl Write,
    format: Format,
    port: &str,
    recent: Option<usize>,
    after_seq: Option<u64>,
    mut remaining: Option<u64>,
    idle_timeout_ms: Option<u64>,
) -> Result<(), Failure> {
    let mut cursor = if let Some(seq) = after_seq {
        seq
    } else {
        let initial: EventPageDto = client
            .call_typed(ControlCommand::PollEvents {
                port_id: port.to_owned(),
                after_seq: None,
                recent: Some(recent.unwrap_or(0)),
                wait_ms: 0,
                limit: recent,
            })
            .await?;

        if recent.is_some() {
            if initial.gap {
                emit_gap_event(out, format, &initial)?;
            }
            for ev in &initial.events {
                emit_stream_event(out, format, ev)?;
                if let Some(left) = remaining.as_mut() {
                    *left -= 1;
                    if *left == 0 {
                        return Ok(());
                    }
                }
            }
        }
        initial.next_seq
    };

    let idle_limit = idle_timeout_ms.map(Duration::from_millis);
    let mut last_activity = Instant::now();
    let ctrl_c = tokio::signal::ctrl_c();
    tokio::pin!(ctrl_c);

    loop {
        let wait_ms = match idle_limit {
            Some(limit) => {
                let left = limit.saturating_sub(last_activity.elapsed());
                if left.is_zero() {
                    return Err(Failure::new(
                        "idle_timeout",
                        "no events received before idle timeout",
                    ));
                }
                u64::try_from(left.as_millis().clamp(1, 2_000)).unwrap_or(2_000)
            }
            None => 2_000,
        };

        let page: EventPageDto = tokio::select! {
            _ = &mut ctrl_c => {
                return Ok(());
            }
            res = client.call_typed(ControlCommand::PollEvents {
                port_id: port.to_owned(),
                after_seq: Some(cursor),
                recent: None,
                wait_ms,
                limit: Some(64),
            }) => res?,
        };

        cursor = page.next_seq;
        if page.gap {
            emit_gap_event(out, format, &page)?;
        }
        for ev in &page.events {
            emit_stream_event(out, format, ev)?;
            last_activity = Instant::now();
            if let Some(left) = remaining.as_mut() {
                *left -= 1;
                if *left == 0 {
                    return Ok(());
                }
            }
        }
    }
}

fn emit_gap_event(out: &mut impl Write, format: Format, page: &EventPageDto) -> io::Result<()> {
    if format == Format::Text {
        writeln!(
            out,
            "[GAP] port={} gen={} latestSeq={} nextSeq={}",
            page.port_id, page.generation, page.latest_seq, page.next_seq
        )?;
        out.flush()
    } else {
        write_json(
            out,
            &json!({
                "kind": "gap",
                "hostId": page.host_id,
                "portId": page.port_id,
                "generation": page.generation,
                "latestSeq": page.latest_seq,
                "nextSeq": page.next_seq,
            }),
        )
    }
}

fn emit_stream_event(
    out: &mut impl Write,
    format: Format,
    ev: &StreamEventDto,
) -> io::Result<()> {
    let decoded = ev.text.clone().or_else(|| {
        ev.data_base64
            .as_deref()
            .and_then(|b64| STANDARD.decode(b64).ok())
            .map(|raw| String::from_utf8_lossy(&raw).into_owned())
    });

    if format != Format::Text {
        let mut value = serde_json::to_value(ev).unwrap_or(Value::Null);
        if ev.text.is_none() {
            if let (Some(obj), Some(txt)) = (value.as_object_mut(), decoded) {
                obj.insert("text".into(), Value::String(txt));
            }
        }
        return write_json(out, &value);
    }

    let tag = ev.kind.to_ascii_uppercase();
    let source_part = ev
        .source
        .as_deref()
        .map(|s| format!(" ({s})"))
        .unwrap_or_default();

    let body = match ev.kind.as_str() {
        "status" => ev.status.clone().unwrap_or_default(),
        "loan" => ev
            .loan
            .as_ref()
            .map(|l| {
                format!(
                    "lease={} holder={} gen={} autoReopen={}",
                    l.lease_id, l.holder, l.generation, l.auto_reopen
                )
            })
            .or_else(|| ev.status.clone())
            .unwrap_or_default(),
        _ => decoded
            .map(|s| escape_control_preserving_printable(&s))
            .or_else(|| ev.status.clone())
            .unwrap_or_default(),
    };

    writeln!(out, "{} [{tag}]{source_part} {body}", ev.timestamp_ms)?;
    out.flush()
}

fn escape_control_preserving_printable(input: &str) -> String {
    let trimmed = input.trim_end_matches(['\r', '\n']);
    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        if ch.is_control() {
            for esc in ch.escape_default() {
                out.push(esc);
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn print_port_summary(out: &mut impl Write, p: &PortSnapshotDto) -> io::Result<()> {
    let baud = p
        .baud_rate
        .map_or_else(|| "-".into(), |b| format!("{b}bps"));
    let usb = match (&p.manufacturer, &p.product) {
        (Some(m), Some(prod)) => format!(" {m} / {prod}"),
        (Some(m), None) => format!(" {m}"),
        (None, Some(prod)) => format!(" {prod}"),
        (None, None) => String::new(),
    };
    let loan = p
        .loan
        .as_ref()
        .map(|l| format!(" [LOANED by {}]", l.holder))
        .unwrap_or_default();
    writeln!(
        out,
        "{}\t{}\tgen={}\t{}\t{}{}{}",
        p.id, p.status, p.generation, baud, p.port_type, usb, loan
    )
}

fn print_port_detail(out: &mut impl Write, p: &PortSnapshotDto) -> io::Result<()> {
    writeln!(out, "id: {}", p.id)?;
    writeln!(out, "name: {}", p.name)?;
    writeln!(out, "portType: {}", p.port_type)?;
    writeln!(out, "status: {}", p.status)?;
    writeln!(out, "generation: {}", p.generation)?;
    if let Some(baud) = p.baud_rate {
        writeln!(out, "baudRate: {baud}")?;
    }
    if let Some(m) = &p.manufacturer {
        writeln!(out, "manufacturer: {m}")?;
    }
    if let Some(prod) = &p.product {
        writeln!(out, "product: {prod}")?;
    }
    if let Some(loan) = &p.loan {
        writeln!(
            out,
            "loan: [LOANED by {}] leaseId={} gen={} autoReopen={} bound={}",
            loan.holder, loan.lease_id, loan.generation, loan.auto_reopen, loan.connection_bound
        )?;
        if let Some(reason) = &loan.reason {
            writeln!(out, "loanReason: {reason}")?;
        }
        if let Some(exp) = loan.expires_at_ms {
            writeln!(out, "loanExpiresAtMs: {exp}")?;
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    let raw_args: Vec<String> = match env::args_os()
        .skip(1)
        .map(|s| s.into_string())
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(args) => args,
        Err(_) => {
            Failure::new("usage", "command-line arguments must be valid UTF-8").print(Format::Text);
            return ExitCode::from(2);
        }
    };

    let format_hint = args::detect_format_hint(&raw_args);
    let cli = match args::parse(raw_args) {
        Ok(cli) => cli,
        Err(msg) => {
            Failure::new("usage", msg).print(format_hint);
            return ExitCode::from(2);
        }
    };

    let format = cli.format;
    let is_tail = matches!(cli.action, Action::Tail { .. });
    match run(cli, &mut io::stdout()).await {
        Ok(code) => {
            if let Ok(u) = u8::try_from(code) {
                ExitCode::from(u)
            } else {
                ExitCode::from(1)
            }
        }
        Err(err) if is_tail && err.code == "broken_pipe" => ExitCode::SUCCESS,
        Err(err) => {
            err.print(format);
            ExitCode::from(err.exit_code())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_codes_match_specification() {
        assert_eq!(Failure::new("output_error", "").exit_code(), 1);
        assert_eq!(Failure::new("usage", "").exit_code(), 2);
        assert_eq!(Failure::new("host_unavailable", "").exit_code(), 3);
        assert_eq!(Failure::new("pin_mismatch", "").exit_code(), 3);
        assert_eq!(Failure::new("protocol_mismatch", "").exit_code(), 3);
        assert_eq!(Failure::new("forbidden", "").exit_code(), 4);
        assert_eq!(Failure::new("stale_generation", "").exit_code(), 4);
        assert_eq!(Failure::new("port_busy", "").exit_code(), 4);
        assert_eq!(Failure::new("not_connected", "").exit_code(), 4);
        assert_eq!(Failure::new("expect_timeout", "").exit_code(), 5);
        assert_eq!(Failure::new("idle_timeout", "").exit_code(), 5);
    }

    #[test]
    fn ndjson_stream_event_includes_decoded_text_helper() {
        let ev = StreamEventDto {
            seq: 12,
            port_id: "COM3".into(),
            generation: 1,
            timestamp_ms: 1_700_000_000_000,
            kind: "rx".into(),
            data_base64: Some(STANDARD.encode(b"READY\r\n")),
            text: None,
            status: None,
            source: None,
            loan: None,
        };

        let mut ndjson = Vec::new();
        emit_stream_event(&mut ndjson, Format::Ndjson, &ev).unwrap();
        let parsed: Value = serde_json::from_slice(&ndjson).unwrap();
        assert_eq!(parsed["seq"], 12);
        assert_eq!(parsed["text"], "READY\r\n");
        assert_eq!(parsed["dataBase64"], STANDARD.encode(b"READY\r\n"));

        let mut text = Vec::new();
        emit_stream_event(&mut text, Format::Text, &ev).unwrap();
        let line = String::from_utf8(text).unwrap();
        assert!(line.contains("[RX] READY"));
        assert!(!line.contains('\r'));
    }
}
