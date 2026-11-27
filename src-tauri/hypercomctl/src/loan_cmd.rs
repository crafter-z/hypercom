use crate::{
    args::{Format, LoanAction},
    connect_target, write_json, Failure,
};
use hypercom_protocol::{ControlCommand, LoanInfoDto, SerialRecoveryDto};
use serde_json::json;
use std::{
    io::{self, Write},
    path::Path,
    process::Stdio,
    time::Duration,
};
use tokio::process::Command;

pub async fn execute(
    target: &crate::args::Target,
    format: Format,
    action: LoanAction,
    out: &mut impl Write,
) -> Result<i32, Failure> {
    match action {
        LoanAction::Run {
            port,
            holder,
            reason,
            ttl_ms,
            auto_reopen,
            expected_generation,
            program,
            args,
        } => {
            run_with_loan(
                target,
                format,
                port,
                holder,
                reason,
                ttl_ms,
                auto_reopen,
                expected_generation,
                program,
                args,
            )
            .await
        }
        LoanAction::Acquire {
            port,
            holder,
            reason,
            ttl_ms,
            auto_reopen,
            expected_generation,
        } => {
            let mut client = connect_target(target).await?;
            let loan: LoanInfoDto = client
                .call_typed(ControlCommand::AcquireLoan {
                    port_id: port,
                    holder: holder.unwrap_or_else(|| "hypercomctl".to_owned()),
                    reason,
                    ttl_ms: Some(ttl_ms),
                    auto_reopen: Some(auto_reopen),
                    connection_bound: Some(false),
                    expected_generation,
                })
                .await?;
            print_loan(out, format, &loan)?;
            Ok(0)
        }
        LoanAction::Heartbeat { lease_id, ttl_ms } => {
            let mut client = connect_target(target).await?;
            let loan: LoanInfoDto = client
                .call_typed(ControlCommand::HeartbeatLoan {
                    lease_id,
                    extend_ttl_ms: ttl_ms,
                })
                .await?;
            print_loan(out, format, &loan)?;
            Ok(0)
        }
        LoanAction::Release {
            lease_id,
            reopen_override,
        } => {
            let mut client = connect_target(target).await?;
            let recovery: SerialRecoveryDto = client
                .call_typed(ControlCommand::ReleaseLoan {
                    lease_id,
                    reopen_override,
                })
                .await?;
            print_recovery(out, format, &recovery)?;
            Ok(0)
        }
        LoanAction::Reclaim { port } => {
            let mut client = connect_target(target).await?;
            let value = client
                .call(ControlCommand::ReclaimLoan { port_id: port })
                .await?;
            if format == Format::Text {
                writeln!(out, "{value:#}")?;
                out.flush()?;
            } else {
                write_json(out, &value)?;
            }
            Ok(0)
        }
        LoanAction::List => {
            let mut client = connect_target(target).await?;
            let loans: Vec<LoanInfoDto> = client.call_typed(ControlCommand::ListLoans).await?;
            if format != Format::Text {
                write_json(out, &serde_json::to_value(&loans)?)?;
            } else if loans.is_empty() {
                writeln!(out, "No active serial port loans.")?;
            } else {
                for loan in &loans {
                    let exp = loan
                        .expires_at_ms
                        .map_or_else(|| "-".into(), |ms| ms.to_string());
                    writeln!(
                        out,
                        "{}\t{}\tholder={}\tgen={}\tautoReopen={}\tbound={}\texpiresAtMs={}",
                        loan.lease_id,
                        loan.port_id,
                        loan.holder,
                        loan.generation,
                        loan.auto_reopen,
                        loan.connection_bound,
                        exp
                    )?;
                }
            }
            out.flush()?;
            Ok(0)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_with_loan(
    target: &crate::args::Target,
    format: Format,
    port: String,
    holder: Option<String>,
    reason: Option<String>,
    ttl_ms: u64,
    auto_reopen: bool,
    expected_generation: Option<u64>,
    program: String,
    args: Vec<String>,
) -> Result<i32, Failure> {
    let resolved_holder = holder.unwrap_or_else(|| {
        Path::new(&program)
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(&program)
            .to_owned()
    });

    let mut client = connect_target(target).await?;
    let loan: LoanInfoDto = client
        .call_typed(ControlCommand::AcquireLoan {
            port_id: port.clone(),
            holder: resolved_holder,
            reason,
            ttl_ms: Some(ttl_ms),
            auto_reopen: Some(auto_reopen),
            connection_bound: Some(true),
            expected_generation,
        })
        .await?;
    let lease_id = loan.lease_id.clone();

    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            // Release loan immediately so HyperCom can recover the port cleanly.
            let _ = client
                .call(ControlCommand::ReleaseLoan {
                    lease_id,
                    reopen_override: None,
                })
                .await;
            return Err(Failure::new(
                "spawn_failed",
                format!("failed to start `{program}`: {err}"),
            ));
        }
    };

    let hb_ms = (ttl_ms / 3).clamp(250, 30_000);
    let mut interval = tokio::time::interval(Duration::from_millis(hb_ms));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Skip the immediate first tick.
    interval.tick().await;

    let ctrl_c = tokio::signal::ctrl_c();
    tokio::pin!(ctrl_c);

    let (exit_code, interrupted) = loop {
        tokio::select! {
            status = child.wait() => {
                let code = match status {
                    Ok(exit) => exit_status_code(exit),
                    Err(err) => {
                        report_stderr(format, json!({
                            "event": "child_wait_error",
                            "message": err.to_string(),
                        }), &format!("hypercomctl: failed waiting on child: {err}"));
                        1
                    }
                };
                break (code, false);
            }
            _ = interval.tick() => {
                if let Err(err) = client.call(ControlCommand::HeartbeatLoan {
                    lease_id: lease_id.clone(),
                    extend_ttl_ms: Some(ttl_ms),
                }).await {
                    report_stderr(format, json!({
                        "event": "loan_heartbeat_error",
                        "leaseId": lease_id,
                        "code": err.code,
                        "message": err.message,
                    }), &format!("hypercomctl: loan heartbeat warning: {err}"));
                }
            }
            _ = &mut ctrl_c => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                break (130, true);
            }
        }
    };

    match client
        .call_typed::<SerialRecoveryDto>(ControlCommand::ReleaseLoan {
            lease_id: lease_id.clone(),
            reopen_override: None,
        })
        .await
    {
        Ok(recovery) => {
            if interrupted || recovery.state == "failed" || recovery.error.is_some() || format != Format::Text {
                report_stderr(
                    format,
                    json!({
                        "event": "loan_released",
                        "portId": port,
                        "leaseId": lease_id,
                        "interrupted": interrupted,
                        "recovery": recovery,
                    }),
                    &format!(
                        "hypercomctl: released loan {lease_id} on {port} (recovery: {}{})",
                        recovery.state,
                        recovery
                            .error
                            .as_deref()
                            .map(|e| format!(", error: {e}"))
                            .unwrap_or_default()
                    ),
                );
            }
        }
        Err(err) => {
            report_stderr(
                format,
                json!({
                    "event": "loan_release_error",
                    "portId": port,
                    "leaseId": lease_id,
                    "code": err.code,
                    "message": err.message,
                }),
                &format!("hypercomctl: failed to release loan {lease_id}: {err}"),
            );
        }
    }

    Ok(exit_code)
}

fn exit_status_code(status: std::process::ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return if sig == 2 { 130 } else { 128 + sig };
        }
    }
    1
}

fn report_stderr(format: Format, json_val: serde_json::Value, text_msg: &str) {
    let mut stderr = io::stderr().lock();
    if format == Format::Text {
        let _ = writeln!(stderr, "{text_msg}");
    } else {
        let _ = writeln!(stderr, "{json_val}");
    }
}

fn print_loan(out: &mut impl Write, format: Format, loan: &LoanInfoDto) -> io::Result<()> {
    if format != Format::Text {
        return write_json(out, &serde_json::to_value(loan)?);
    }
    writeln!(out, "leaseId: {}", loan.lease_id)?;
    writeln!(out, "portId: {}", loan.port_id)?;
    writeln!(out, "holder: {}", loan.holder)?;
    if let Some(reason) = &loan.reason {
        writeln!(out, "reason: {reason}")?;
    }
    writeln!(out, "generation: {}", loan.generation)?;
    writeln!(out, "autoReopen: {}", loan.auto_reopen)?;
    writeln!(out, "connectionBound: {}", loan.connection_bound)?;
    if let Some(exp) = loan.expires_at_ms {
        writeln!(out, "expiresAtMs: {exp}")?;
    }
    out.flush()
}

fn print_recovery(
    out: &mut impl Write,
    format: Format,
    recovery: &SerialRecoveryDto,
) -> io::Result<()> {
    if format != Format::Text {
        return write_json(out, &serde_json::to_value(recovery)?);
    }
    write!(out, "recovery: {}", recovery.state)?;
    if let Some(err) = &recovery.error {
        write!(out, " ({err})")?;
    }
    writeln!(out)?;
    out.flush()
}
