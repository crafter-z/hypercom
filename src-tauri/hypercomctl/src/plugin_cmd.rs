use crate::{
    args::{ArtifactAction, Format, PluginAction, Target},
    connect_target, write_json, Failure,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use hypercom_protocol::{
    ArtifactInfoDto, AsyncControlClient, ControlCommand, HostError, PluginJobEventDto,
    PluginJobStatusDto, PluginToolDescriptorDto, PluginToolInvokeResultDto,
    MAX_ARTIFACT_CHUNK_BYTES, MAX_POLL_MS,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fmt::Write as FmtWrite,
    future::Future,
    io::{self, Write},
    path::Path,
};
use tokio::io::AsyncReadExt;

pub trait ControlCaller {
    fn call_cmd(
        &mut self,
        cmd: ControlCommand,
    ) -> impl Future<Output = Result<Value, HostError>> + Send;
}

impl ControlCaller for AsyncControlClient {
    async fn call_cmd(&mut self, cmd: ControlCommand) -> Result<Value, HostError> {
        self.call(cmd).await
    }
}

pub fn parse_plugin_tools_value(value: Value) -> Result<Vec<PluginToolDescriptorDto>, HostError> {
    if value.is_array() {
        serde_json::from_value(value).map_err(|e| {
            HostError::new(
                "protocol_mismatch",
                format!("invalid plugin tools list: {e}"),
            )
        })
    } else if let Some(arr) = value.get("tools") {
        serde_json::from_value(arr.clone()).map_err(|e| {
            HostError::new(
                "protocol_mismatch",
                format!("invalid plugin tools list: {e}"),
            )
        })
    } else {
        Err(HostError::new(
            "protocol_mismatch",
            "unexpected plugin tools response shape",
        ))
    }
}

pub fn is_terminal_job_state(state: &str) -> bool {
    matches!(state, "completed" | "failed" | "cancelled")
}

pub fn job_exit_code(state: &str) -> i32 {
    if state == "completed" {
        0
    } else {
        4
    }
}

pub async fn upload_artifact_streaming<C: ControlCaller>(
    caller: &mut C,
    file_path: &Path,
    target: Option<String>,
    name: Option<String>,
    ttl_ms: Option<u64>,
) -> Result<ArtifactInfoDto, HostError> {
    let mut file = tokio::fs::File::open(file_path).await.map_err(|err| {
        HostError::new(
            "artifact_io",
            format!("cannot open `{}`: {err}", file_path.display()),
        )
    })?;
    let meta = file.metadata().await.map_err(|err| {
        HostError::new(
            "artifact_io",
            format!("cannot stat `{}`: {err}", file_path.display()),
        )
    })?;
    if !meta.is_file() {
        return Err(HostError::new(
            "artifact_io",
            format!("`{}` is not a regular file", file_path.display()),
        ));
    }
    let total_bytes = meta.len();

    let resolved_name = match name.filter(|s| !s.is_empty()) {
        Some(n) => n,
        None => file_path
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                HostError::new(
                    "invalid_request",
                    format!("cannot derive artifact name from `{}`", file_path.display()),
                )
            })?
            .to_owned(),
    };

    let begin_val = caller
        .call_cmd(ControlCommand::ArtifactBegin {
            target: target.clone(),
            name: resolved_name,
            total_bytes: Some(total_bytes),
            ttl_ms,
        })
        .await?;

    let upload_id = begin_val
        .get("uploadId")
        .or_else(|| begin_val.get("upload_id"))
        .and_then(Value::as_str)
        .or_else(|| begin_val.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            HostError::new("protocol_mismatch", "ArtifactBegin reply missing uploadId")
        })?
        .to_owned();

    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; MAX_ARTIFACT_CHUNK_BYTES];
    let mut offset: u64 = 0;

    let stream_res: Result<(), HostError> = async {
        loop {
            let mut filled = 0usize;
            while filled < buf.len() {
                let n = file.read(&mut buf[filled..]).await.map_err(|err| {
                    HostError::new(
                        "artifact_io",
                        format!("failed reading `{}`: {err}", file_path.display()),
                    )
                })?;
                if n == 0 {
                    break;
                }
                filled += n;
            }
            if filled == 0 {
                break;
            }
            hasher.update(&buf[..filled]);
            caller
                .call_cmd(ControlCommand::ArtifactChunk {
                    target: target.clone(),
                    upload_id: upload_id.clone(),
                    offset,
                    data_base64: STANDARD.encode(&buf[..filled]),
                })
                .await?;
            offset += filled as u64;
        }
        Ok(())
    }
    .await;

    if let Err(err) = stream_res {
        let _ = caller
            .call_cmd(ControlCommand::ArtifactAbort { target, upload_id })
            .await;
        return Err(err);
    }

    let digest = hasher.finalize();
    let mut sha256_hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(&mut sha256_hex, "{byte:02x}");
    }

    let commit_val = caller
        .call_cmd(ControlCommand::ArtifactCommit {
            target,
            upload_id,
            expected_sha256: Some(sha256_hex),
        })
        .await?;
    serde_json::from_value(commit_val).map_err(|err| {
        HostError::new(
            "protocol_mismatch",
            format!("unexpected ArtifactCommit response shape: {err}"),
        )
    })
}

pub async fn execute_plugin(
    target: &Target,
    format: Format,
    action: PluginAction,
    out: &mut impl Write,
) -> Result<i32, Failure> {
    match action {
        PluginAction::List => {
            let mut client = connect_target(target).await?;
            let val = client.call(ControlCommand::ListPluginTools).await?;
            let tools = parse_plugin_tools_value(val)?;
            if format != Format::Text {
                write_json(out, &serde_json::to_value(&tools)?)?;
            } else if tools.is_empty() {
                writeln!(out, "No plugin tools available.")?;
            } else {
                print_plugin_tools_table(out, &tools)?;
            }
            out.flush()?;
            Ok(0)
        }
        PluginAction::Call {
            plugin_id,
            tool,
            target: plugin_target,
            args,
            artifacts,
            timeout_ms,
            wait,
        } => {
            let mut client = connect_target(target).await?;
            let res: PluginToolInvokeResultDto = client
                .call_typed(ControlCommand::InvokePluginTool {
                    target: plugin_target.clone(),
                    plugin_id,
                    tool,
                    args,
                    artifacts: if artifacts.is_empty() {
                        None
                    } else {
                        Some(artifacts)
                    },
                    timeout_ms,
                })
                .await?;

            if res.mode == "job" && wait {
                let job_id = res
                    .job_id
                    .clone()
                    .or_else(|| res.status.as_ref().map(|s| s.job_id.clone()))
                    .ok_or_else(|| {
                        Failure::new("protocol_mismatch", "job response missing jobId")
                    })?;
                return follow_plugin_job(
                    &mut client,
                    out,
                    format,
                    plugin_target,
                    &job_id,
                    res.status,
                    None,
                )
                .await;
            }

            if format != Format::Text {
                write_json(out, &serde_json::to_value(&res)?)?;
            } else if res.mode == "job" {
                let job_id = res
                    .job_id
                    .as_deref()
                    .or_else(|| res.status.as_ref().map(|s| s.job_id.as_str()))
                    .unwrap_or("?");
                writeln!(out, "jobId: {job_id}")?;
                if let Some(status) = &res.status {
                    print_job_status_summary(out, status)?;
                }
            } else if let Some(result) = &res.result {
                print_sync_result(out, result)?;
            } else {
                writeln!(out, "OK")?;
            }
            out.flush()?;
            Ok(0)
        }
        PluginAction::Job {
            job_id,
            target: plugin_target,
            after_seq,
            follow,
        } => {
            let mut client = connect_target(target).await?;
            if follow {
                return follow_plugin_job(
                    &mut client,
                    out,
                    format,
                    plugin_target,
                    &job_id,
                    None,
                    after_seq,
                )
                .await;
            }

            let status: PluginJobStatusDto = client
                .call_typed(ControlCommand::PollPluginJob {
                    target: plugin_target,
                    job_id,
                    after_seq,
                    wait_ms: 0,
                    limit: None,
                })
                .await?;
            if format != Format::Text {
                write_json(out, &serde_json::to_value(&status)?)?;
            } else {
                for ev in &status.events {
                    emit_job_event(out, format, ev)?;
                }
                print_job_status_summary(out, &status)?;
            }
            out.flush()?;
            Ok(0)
        }
        PluginAction::Cancel {
            job_id,
            target: plugin_target,
        } => {
            let mut client = connect_target(target).await?;
            let val = client
                .call(ControlCommand::CancelPluginJob {
                    target: plugin_target,
                    job_id: job_id.clone(),
                })
                .await?;
            if format != Format::Text {
                write_json(out, &val)?;
            } else if let Ok(status) = serde_json::from_value::<PluginJobStatusDto>(val.clone()) {
                print_job_status_summary(out, &status)?;
            } else {
                writeln!(out, "Cancelled job {job_id}: {val}")?;
            }
            out.flush()?;
            Ok(0)
        }
    }
}

pub async fn execute_artifact(
    target: &Target,
    format: Format,
    action: ArtifactAction,
    out: &mut impl Write,
) -> Result<(), Failure> {
    match action {
        ArtifactAction::Upload {
            file_path,
            target: artifact_target,
            name,
            ttl_ms,
        } => {
            let mut client = connect_target(target).await?;
            let info = upload_artifact_streaming(
                &mut client,
                Path::new(&file_path),
                artifact_target,
                name,
                ttl_ms,
            )
            .await?;
            if format != Format::Text {
                write_json(out, &serde_json::to_value(&info)?)?;
            } else {
                writeln!(out, "artifactId: {}", info.artifact_id)?;
                writeln!(out, "name: {}", info.name)?;
                writeln!(out, "sizeBytes: {}", info.size_bytes)?;
                writeln!(out, "sha256: {}", info.sha256)?;
                writeln!(out, "expiresAtMs: {}", info.expires_at_ms)?;
            }
            out.flush()?;
            Ok(())
        }
    }
}

async fn follow_plugin_job(
    client: &mut AsyncControlClient,
    out: &mut impl Write,
    format: Format,
    plugin_target: Option<String>,
    job_id: &str,
    initial_status: Option<PluginJobStatusDto>,
    after_seq: Option<u64>,
) -> Result<i32, Failure> {
    let mut accumulated_events: Vec<PluginJobEventDto> = Vec::new();
    let mut cursor = after_seq;

    if let Some(status) = initial_status {
        if format == Format::Json {
            accumulated_events.extend(status.events.clone());
        } else {
            for ev in &status.events {
                emit_job_event(out, format, ev)?;
            }
        }
        cursor = Some(status.next_seq);
        if is_terminal_job_state(&status.state) {
            return finish_job_output(out, format, status, accumulated_events);
        }
    }

    let ctrl_c = tokio::signal::ctrl_c();
    tokio::pin!(ctrl_c);

    loop {
        let status: PluginJobStatusDto = tokio::select! {
            _ = &mut ctrl_c => {
                return Ok(130);
            }
            res = client.call_typed(ControlCommand::PollPluginJob {
                target: plugin_target.clone(),
                job_id: job_id.to_owned(),
                after_seq: cursor,
                wait_ms: MAX_POLL_MS,
                limit: Some(100),
            }) => res?,
        };

        cursor = Some(status.next_seq);
        if format == Format::Json {
            accumulated_events.extend(status.events.clone());
        } else {
            for ev in &status.events {
                emit_job_event(out, format, ev)?;
            }
        }

        if is_terminal_job_state(&status.state) {
            return finish_job_output(out, format, status, accumulated_events);
        }
    }
}

fn finish_job_output(
    out: &mut impl Write,
    format: Format,
    mut status: PluginJobStatusDto,
    accumulated_events: Vec<PluginJobEventDto>,
) -> Result<i32, Failure> {
    let code = job_exit_code(&status.state);
    match format {
        Format::Json => {
            status.events = accumulated_events;
            write_json(out, &serde_json::to_value(&status)?)?;
        }
        Format::Ndjson => {
            status.events.clear();
            write_json(out, &serde_json::to_value(&status)?)?;
        }
        Format::Text => {
            print_job_status_summary(out, &status)?;
            out.flush()?;
        }
    }
    Ok(code)
}

fn emit_job_event(
    out: &mut impl Write,
    format: Format,
    ev: &PluginJobEventDto,
) -> io::Result<()> {
    if format == Format::Ndjson {
        return write_json(out, &serde_json::to_value(ev).unwrap_or(Value::Null));
    }
    if format == Format::Text {
        let tag = ev.kind.to_ascii_uppercase();
        let stream_part = ev
            .stream
            .as_deref()
            .map(|s| format!(" ({s})"))
            .unwrap_or_default();
        let progress_part = ev
            .progress
            .map(|p| {
                if (0.0..=1.0).contains(&p) {
                    format!(" {:.0}%", p * 100.0)
                } else {
                    format!(" {p}")
                }
            })
            .unwrap_or_default();
        let msg = ev.message.as_deref().unwrap_or("");
        let data_part = if let Some(data) = &ev.data {
            if msg.is_empty() {
                format!(" {data}")
            } else {
                format!(" | {data}")
            }
        } else {
            String::new()
        };
        let msg_part = if msg.is_empty() {
            String::new()
        } else {
            format!(" {}", msg.trim_end_matches(['\r', '\n']))
        };
        writeln!(
            out,
            "{} [{tag}]{stream_part}{progress_part}{msg_part}{data_part}",
            ev.timestamp_ms
        )?;
        out.flush()?;
    }
    Ok(())
}

fn print_job_status_summary(out: &mut impl Write, status: &PluginJobStatusDto) -> io::Result<()> {
    writeln!(
        out,
        "jobId: {}  state: {}  plugin: {}  tool: {}",
        status.job_id, status.state, status.plugin_id, status.tool
    )?;
    if let Some(res) = &status.result {
        write!(out, "result: ")?;
        print_sync_result(out, res)?;
    }
    if let Some(err) = &status.error {
        writeln!(out, "error: {}: {}", err.code, err.message)?;
    }
    Ok(())
}

fn print_sync_result(out: &mut impl Write, result: &Value) -> io::Result<()> {
    match result {
        Value::Null => writeln!(out, "null"),
        Value::String(s) => writeln!(out, "{s}"),
        other => {
            let pretty = serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string());
            writeln!(out, "{pretty}")
        }
    }
}

fn print_plugin_tools_table(
    out: &mut impl Write,
    tools: &[PluginToolDescriptorDto],
) -> io::Result<()> {
    let rows: Vec<[String; 6]> = tools
        .iter()
        .map(|t| {
            let desc = t
                .description
                .replace(['\r', '\n'], " ")
                .trim()
                .to_owned();
            [
                t.host.clone(),
                t.plugin_id.clone(),
                t.tool.clone(),
                t.access.clone(),
                t.mode.clone(),
                desc,
            ]
        })
        .collect();

    let headers = ["HOST", "PLUGIN_ID", "TOOL", "ACCESS", "MODE", "DESCRIPTION"];
    let mut widths = [
        headers[0].len(),
        headers[1].len(),
        headers[2].len(),
        headers[3].len(),
        headers[4].len(),
    ];
    for row in &rows {
        for (i, w) in widths.iter_mut().enumerate() {
            *w = (*w).max(row[i].len());
        }
    }

    writeln!(
        out,
        "{:<w0$}  {:<w1$}  {:<w2$}  {:<w3$}  {:<w4$}  {}",
        headers[0],
        headers[1],
        headers[2],
        headers[3],
        headers[4],
        headers[5],
        w0 = widths[0],
        w1 = widths[1],
        w2 = widths[2],
        w3 = widths[3],
        w4 = widths[4],
    )?;
    for row in &rows {
        writeln!(
            out,
            "{:<w0$}  {:<w1$}  {:<w2$}  {:<w3$}  {:<w4$}  {}",
            row[0],
            row[1],
            row[2],
            row[3],
            row[4],
            row[5],
            w0 = widths[0],
            w1 = widths[1],
            w2 = widths[2],
            w3 = widths[3],
            w4 = widths[4],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    struct MockCaller<F>(F);

    impl<F> ControlCaller for MockCaller<F>
    where
        F: FnMut(ControlCommand) -> Result<Value, HostError> + Send,
    {
        async fn call_cmd(&mut self, cmd: ControlCommand) -> Result<Value, HostError> {
            (self.0)(cmd)
        }
    }

    #[tokio::test]
    async fn upload_artifact_streaming_chunks_hashes_and_commits() {
        let dir = std::env::temp_dir().join(format!("hypercomctl-art-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file_path = dir.join("firmware.bin");

        // Create payload spanning 2+ chunks (> 512 KiB)
        let payload_len = MAX_ARTIFACT_CHUNK_BYTES + 1234;
        let payload: Vec<u8> = (0..payload_len).map(|i| (i % 251) as u8).collect();
        std::fs::write(&file_path, &payload).unwrap();

        let expected_sha = {
            let digest = Sha256::digest(&payload);
            let mut hex = String::new();
            for b in digest {
                let _ = write!(&mut hex, "{b:02x}");
            }
            hex
        };

        let received_chunks = Arc::new(Mutex::new(Vec::<u8>::new()));
        let received_clone = received_chunks.clone();
        let mut commands = Vec::new();

        let mut caller = MockCaller(|cmd: ControlCommand| {
            commands.push(cmd.clone());
            match cmd {
                ControlCommand::ArtifactBegin {
                    target,
                    name,
                    total_bytes,
                    ttl_ms,
                } => {
                    assert_eq!(target.as_deref(), Some("remote::bench"));
                    assert_eq!(name, "firmware.bin");
                    assert_eq!(total_bytes, Some(payload_len as u64));
                    assert_eq!(ttl_ms, Some(1_800_000));
                    Ok(json!({ "uploadId": "up-123" }))
                }
                ControlCommand::ArtifactChunk {
                    upload_id,
                    offset,
                    data_base64,
                    ..
                } => {
                    assert_eq!(upload_id, "up-123");
                    let bytes = STANDARD.decode(data_base64).unwrap();
                    let mut buf = received_clone.lock().unwrap();
                    assert_eq!(offset, buf.len() as u64);
                    buf.extend_from_slice(&bytes);
                    Ok(json!({ "accepted": bytes.len() }))
                }
                ControlCommand::ArtifactCommit {
                    upload_id,
                    expected_sha256,
                    ..
                } => {
                    assert_eq!(upload_id, "up-123");
                    assert_eq!(expected_sha256.as_deref(), Some(expected_sha.as_str()));
                    Ok(json!({
                        "artifactId": "art-99",
                        "name": "firmware.bin",
                        "sizeBytes": payload_len,
                        "sha256": expected_sha,
                        "expiresAtMs": 1_700_001_800_000i64
                    }))
                }
                other => panic!("unexpected command: {other:?}"),
            }
        });

        let info = upload_artifact_streaming(
            &mut caller,
            &file_path,
            Some("remote::bench".into()),
            None,
            Some(1_800_000),
        )
        .await
        .unwrap();

        assert_eq!(info.artifact_id, "art-99");
        assert_eq!(info.size_bytes, payload_len as u64);
        assert_eq!(*received_chunks.lock().unwrap(), payload);
        assert_eq!(commands.len(), 4); // Begin + 2 Chunks + Commit

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn upload_artifact_streaming_aborts_on_chunk_error() {
        let dir = std::env::temp_dir().join(format!("hypercomctl-art-err-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file_path = dir.join("bad.bin");
        std::fs::write(&file_path, b"hello").unwrap();

        let aborted = Arc::new(Mutex::new(false));
        let aborted_clone = aborted.clone();

        let mut caller = MockCaller(|cmd: ControlCommand| match cmd {
            ControlCommand::ArtifactBegin { .. } => Ok(json!({ "uploadId": "up-err" })),
            ControlCommand::ArtifactChunk { .. } => {
                Err(HostError::new("quota_exceeded", "too large"))
            }
            ControlCommand::ArtifactAbort { upload_id, .. } => {
                assert_eq!(upload_id, "up-err");
                *aborted_clone.lock().unwrap() = true;
                Ok(json!({ "aborted": true }))
            }
            other => panic!("unexpected command: {other:?}"),
        });

        let err = upload_artifact_streaming(&mut caller, &file_path, None, None, None)
            .await
            .unwrap_err();
        assert_eq!(err.code, "quota_exceeded");
        assert!(*aborted.lock().unwrap());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_plugin_tools_accepts_array_and_wrapped_object() {
        let sample = json!({
            "host": "local",
            "pluginId": "diag",
            "pluginName": "Diagnostics",
            "installGeneration": "g1",
            "tool": "ping",
            "description": "Ping device",
            "access": "observe",
            "mode": "sync",
            "portScoped": false,
            "acceptsArtifacts": false,
            "inputSchema": { "type": "object", "properties": {} }
        });
        let arr = parse_plugin_tools_value(json!([sample.clone()])).unwrap();
        assert_eq!(arr.len(), 1);
        let obj = parse_plugin_tools_value(json!({ "tools": [sample] })).unwrap();
        assert_eq!(obj.len(), 1);
        assert!(parse_plugin_tools_value(json!({ "unexpected": true })).is_err());
    }
}
