use crate::{
    args::{
        apply_eol_bytes, normalize_handshake, normalize_parity, normalize_stop_bits,
        parse_hex_strict, Target,
    },
    plugin_cmd::{
        is_terminal_job_state, parse_plugin_tools_value, upload_artifact_streaming, ControlCaller,
    },
};
use base64::{engine::general_purpose::STANDARD, Engine};
use hypercom_protocol::{
    AsyncControlClient, ControlCommand, EventPageDto, ExpectSpec, HostError, LoanInfoDto,
    PluginJobEventDto, PluginJobStatusDto, PluginToolDescriptorDto, PluginToolInvokeResultDto,
    PortSnapshotDto, RequestOutcomeDto, SerialParamsDto, SerialRecoveryDto, StreamEventDto,
    MAX_EXPECT_BYTES, MAX_EXPECT_MS, MAX_POLL_MS, MAX_WRITE_BYTES,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::Command,
    time::Instant,
};

const MCP_PROTOCOL_VERSION: &str = "2024-11-05";
const DEFAULT_PLUGIN_JOB_WAIT_MS: u64 = 120_000;

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Option<Value>,
}

enum McpBackend {
    Live {
        target: Target,
        client: Option<AsyncControlClient>,
    },
    #[cfg(test)]
    Mock(Box<dyn FnMut(ControlCommand) -> Result<Value, HostError> + Send>),
}

#[derive(Debug, Clone)]
struct DynamicToolRoute {
    target: Option<String>,
    plugin_id: String,
    tool: String,
    #[allow(dead_code)]
    mode: String,
}

struct McpState {
    backend: McpBackend,
    dynamic_tools: HashMap<String, DynamicToolRoute>,
    dynamic_tools_loaded: bool,
}

impl McpState {
    fn new(target: Target) -> Self {
        Self {
            backend: McpBackend::Live {
                target,
                client: None,
            },
            dynamic_tools: HashMap::new(),
            dynamic_tools_loaded: false,
        }
    }

    #[cfg(test)]
    fn mock<F>(handler: F) -> Self
    where
        F: FnMut(ControlCommand) -> Result<Value, HostError> + Send + 'static,
    {
        Self {
            backend: McpBackend::Mock(Box::new(handler)),
            dynamic_tools: HashMap::new(),
            dynamic_tools_loaded: false,
        }
    }

    async fn call_host(&mut self, cmd: ControlCommand) -> Result<Value, HostError> {
        match &mut self.backend {
            McpBackend::Live { target, client } => {
                if client.is_none() {
                    *client = Some(connect_target_host(target).await?);
                }
                let res = client.as_mut().unwrap().call(&cmd).await;
                match res {
                    Ok(val) => Ok(val),
                    Err(err)
                        if err.code == "host_unavailable" || err.code == "outcome_unknown" =>
                    {
                        // Drop retired/broken connection so subsequent calls reconnect cleanly.
                        *client = None;
                        Err(err)
                    }
                    Err(err) => Err(err),
                }
            }
            #[cfg(test)]
            McpBackend::Mock(handler) => handler(cmd),
        }
    }

    async fn call_host_typed<T: serde::de::DeserializeOwned>(
        &mut self,
        cmd: ControlCommand,
    ) -> Result<T, HostError> {
        let value = self.call_host(cmd).await?;
        serde_json::from_value(value).map_err(|err| {
            HostError::new(
                "protocol_mismatch",
                format!("unexpected Host response shape: {err}"),
            )
        })
    }
}

impl ControlCaller for McpState {
    async fn call_cmd(&mut self, cmd: ControlCommand) -> Result<Value, HostError> {
        self.call_host(cmd).await
    }
}

async fn connect_target_host(target: &Target) -> Result<AsyncControlClient, HostError> {
    match target {
        Target::Local(endpoint) => AsyncControlClient::connect_local(endpoint).await,
        Target::Profile(name) => {
            let store = crate::remote_cmd::open_profile_store()
                .map_err(|f| HostError::new(f.code, f.message))?;
            let profile = store.load(name)?;
            AsyncControlClient::connect_remote(&profile).await
        }
    }
}

pub async fn run_stdio(target: Target) -> Result<(), crate::Failure> {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin);
    let mut writer = stdout;
    serve_loop(&mut reader, &mut writer, target).await
}

pub async fn serve_loop<R, W>(
    reader: &mut R,
    writer: &mut W,
    target: Target,
) -> Result<(), crate::Failure>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut state = McpState::new(target);
    serve_with_state(reader, writer, &mut state).await
}

async fn serve_with_state<R, W>(
    reader: &mut R,
    writer: &mut W,
    state: &mut McpState,
) -> Result<(), crate::Failure>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line).await?;
        if read == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(reply) = handle_raw_line(state, trimmed).await {
            let mut bytes = serde_json::to_vec(&reply)?;
            bytes.push(b'\n');
            writer.write_all(&bytes).await?;
            writer.flush().await?;
        }
    }
    Ok(())
}

async fn handle_raw_line(state: &mut McpState, raw: &str) -> Option<Value> {
    let req: JsonRpcRequest = match serde_json::from_str(raw) {
        Ok(req) => req,
        Err(err) => {
            return Some(jsonrpc_error(
                Value::Null,
                -32700,
                format!("Parse error: {err}"),
            ));
        }
    };

    let Some(id) = req.id.clone().filter(|id| !id.is_null()) else {
        // Notification (e.g. `notifications/initialized`, `notifications/cancelled`): no reply.
        return None;
    };

    if req.jsonrpc.as_deref() != Some("2.0") {
        return Some(jsonrpc_error(
            id,
            -32600,
            "Invalid Request: jsonrpc must be \"2.0\"",
        ));
    }

    let response = dispatch_request(state, id.clone(), &req.method, req.params).await;
    Some(response)
}

async fn dispatch_request(
    state: &mut McpState,
    id: Value,
    method: &str,
    params: Option<Value>,
) -> Value {
    match method {
        "initialize" => jsonrpc_ok(
            id,
            json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "hypercomctl",
                    "version": env!("CARGO_PKG_VERSION"),
                }
            }),
        ),
        "ping" => jsonrpc_ok(id, json!({})),
        "tools/list" => {
            let tools = list_all_tools(state).await;
            jsonrpc_ok(id, json!({ "tools": tools }))
        }
        "tools/call" => {
            let Some(params_obj) = params.as_ref().and_then(Value::as_object) else {
                return jsonrpc_error(id, -32602, "Invalid params: expected object");
            };
            let Some(name) = params_obj.get("name").and_then(Value::as_str) else {
                return jsonrpc_error(id, -32602, "Invalid params: missing tool name");
            };
            let args = params_obj
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            if !args.is_object() {
                return jsonrpc_error(id, -32602, "Invalid params: arguments must be an object");
            }
            if tool_exists(name) {
                let result = execute_tool(state, name, args).await;
                return jsonrpc_ok(id, result);
            }
            if !state.dynamic_tools.contains_key(name) && !state.dynamic_tools_loaded {
                let _ = refresh_dynamic_tools(state).await;
            }
            if let Some(route) = state.dynamic_tools.get(name).cloned() {
                let result = execute_dynamic_tool(state, route, args).await;
                return jsonrpc_ok(id, result);
            }
            jsonrpc_error(id, -32602, format!("Unknown tool: {name}"))
        }
        other => jsonrpc_error(id, -32601, format!("Method not found: {other}")),
    }
}

fn jsonrpc_ok(id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })
}

fn jsonrpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message.into(),
        }
    })
}

fn tool_ok(payload: Value) -> Value {
    let text = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| payload.to_string());
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": false,
    })
}

fn tool_err(code: &str, message: impl Into<String>) -> Value {
    let payload = json!({
        "error": {
            "code": code,
            "message": message.into(),
        }
    });
    let text = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| payload.to_string());
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": true,
    })
}

fn tool_err_host(err: HostError) -> Value {
    tool_err(&err.code, err.message)
}

fn tool_exists(name: &str) -> bool {
    matches!(
        name,
        "list_ports"
            | "get_port_status"
            | "open_port"
            | "close_port"
            | "read_recent_rx"
            | "send_serial"
            | "request_serial"
            | "add_terminal_note"
            | "acquire_serial_loan"
            | "heartbeat_serial_loan"
            | "release_serial_loan"
            | "list_active_leases"
            | "run_with_serial_loan"
            | "list_plugin_tools"
            | "invoke_plugin_tool"
            | "poll_plugin_job"
            | "cancel_plugin_job"
            | "upload_artifact"
    )
}

async fn execute_tool(state: &mut McpState, name: &str, args: Value) -> Value {
    match name {
        "list_ports" => match state.call_host(ControlCommand::Ports).await {
            Ok(val) => match crate::parse_ports_value(val) {
                Ok(ports) => tool_ok(json!({ "ports": ports })),
                Err(e) => tool_err(&e.code, e.message),
            },
            Err(e) => tool_err_host(e),
        },
        "get_port_status" => {
            let Some(port_id) = req_str(&args, "portId") else {
                return tool_err("invalid_request", "missing required string field `portId`");
            };
            match state
                .call_host_typed::<PortSnapshotDto>(ControlCommand::Status { port_id })
                .await
            {
                Ok(status) => tool_ok(serde_json::to_value(status).unwrap_or(Value::Null)),
                Err(e) => tool_err_host(e),
            }
        }
        "open_port" => {
            let Some(port_id) = req_str(&args, "portId") else {
                return tool_err("invalid_request", "missing required string field `portId`");
            };
            let params = match parse_mcp_serial_params(&args) {
                Ok(p) => p,
                Err(msg) => return tool_err("invalid_request", msg),
            };
            let expected_generation = opt_u64(&args, "expectedGeneration");
            match state
                .call_host_typed::<PortSnapshotDto>(ControlCommand::Open {
                    port_id,
                    params,
                    host_id: None,
                    expected_generation,
                })
                .await
            {
                Ok(status) => tool_ok(serde_json::to_value(status).unwrap_or(Value::Null)),
                Err(e) => tool_err_host(e),
            }
        }
        "close_port" => {
            let Some(port_id) = req_str(&args, "portId") else {
                return tool_err("invalid_request", "missing required string field `portId`");
            };
            let expected_generation = opt_u64(&args, "expectedGeneration");
            match state
                .call_host_typed::<PortSnapshotDto>(ControlCommand::Close {
                    port_id,
                    host_id: None,
                    expected_generation,
                })
                .await
            {
                Ok(status) => tool_ok(serde_json::to_value(status).unwrap_or(Value::Null)),
                Err(e) => tool_err_host(e),
            }
        }
        "read_recent_rx" => {
            let Some(port_id) = req_str(&args, "portId") else {
                return tool_err("invalid_request", "missing required string field `portId`");
            };
            let after_seq = opt_u64(&args, "afterSeq");
            let recent = opt_u64(&args, "recent").map(|n| n as usize);
            if after_seq.is_some() && recent.is_some() {
                return tool_err(
                    "invalid_request",
                    "`afterSeq` and `recent` are mutually exclusive",
                );
            }
            let wait_ms = opt_u64(&args, "waitMs").unwrap_or(0);
            let limit = opt_u64(&args, "limit").map(|n| n as usize);
            match state
                .call_host_typed::<EventPageDto>(ControlCommand::PollEvents {
                    port_id,
                    after_seq,
                    recent: if after_seq.is_none() && recent.is_none() {
                        Some(50)
                    } else {
                        recent
                    },
                    wait_ms,
                    limit,
                })
                .await
            {
                Ok(page) => tool_ok(format_event_page_for_mcp(&page)),
                Err(e) => tool_err_host(e),
            }
        }
        "send_serial" => {
            let Some(port_id) = req_str(&args, "portId") else {
                return tool_err("invalid_request", "missing required string field `portId`");
            };
            let bytes = match parse_mcp_tx_bytes(&args) {
                Ok(b) => b,
                Err(msg) => return tool_err("invalid_request", msg),
            };
            let source = opt_str(&args, "source").or_else(|| Some("mcp".to_owned()));
            let expected_generation = opt_u64(&args, "expectedGeneration");
            match state
                .call_host(ControlCommand::Send {
                    port_id,
                    data_base64: STANDARD.encode(&bytes),
                    source,
                    expected_generation,
                })
                .await
            {
                Ok(val) => tool_ok(val),
                Err(e) => tool_err_host(e),
            }
        }
        "request_serial" => {
            let Some(port_id) = req_str(&args, "portId") else {
                return tool_err("invalid_request", "missing required string field `portId`");
            };
            let bytes = match parse_mcp_tx_bytes(&args) {
                Ok(b) => b,
                Err(msg) => return tool_err("invalid_request", msg),
            };
            let expect = match parse_mcp_expect(&args) {
                Ok(e) => e,
                Err(msg) => return tool_err("invalid_request", msg),
            };
            let timeout_ms = opt_u64(&args, "timeoutMs").unwrap_or(3_000);
            if !(1..=MAX_EXPECT_MS).contains(&timeout_ms) {
                return tool_err(
                    "invalid_request",
                    format!("`timeoutMs` must be 1..={MAX_EXPECT_MS}"),
                );
            }
            let source = opt_str(&args, "source").or_else(|| Some("mcp".to_owned()));
            let expected_generation = opt_u64(&args, "expectedGeneration");
            match state
                .call_host_typed::<RequestOutcomeDto>(ControlCommand::Request {
                    port_id,
                    data_base64: STANDARD.encode(&bytes),
                    expect,
                    timeout_ms,
                    source,
                    expected_generation,
                })
                .await
            {
                Ok(outcome) => {
                    let mut val = serde_json::to_value(&outcome).unwrap_or(Value::Null);
                    if outcome.matched_text.is_none() {
                        if let Some(ref b64) = outcome.matched_base64 {
                            if let Ok(raw) = STANDARD.decode(b64) {
                                if let Some(obj) = val.as_object_mut() {
                                    obj.insert(
                                        "matchedText".into(),
                                        Value::String(String::from_utf8_lossy(&raw).into_owned()),
                                    );
                                }
                            }
                        }
                    }
                    if outcome.matched {
                        tool_ok(val)
                    } else {
                        let text = serde_json::to_string_pretty(&val).unwrap_or_default();
                        json!({
                            "content": [{ "type": "text", "text": text }],
                            "isError": true,
                        })
                    }
                }
                Err(e) => tool_err_host(e),
            }
        }
        "add_terminal_note" => {
            let Some(port_id) = req_str(&args, "portId") else {
                return tool_err("invalid_request", "missing required string field `portId`");
            };
            let Some(text) = req_str(&args, "text") else {
                return tool_err("invalid_request", "missing required non-empty `text`");
            };
            let source = opt_str(&args, "source").or_else(|| Some("mcp".to_owned()));
            match state
                .call_host(ControlCommand::AddNote {
                    port_id,
                    text,
                    source,
                })
                .await
            {
                Ok(val) => tool_ok(val),
                Err(e) => tool_err_host(e),
            }
        }
        "acquire_serial_loan" => {
            let Some(port_id) = req_str(&args, "portId") else {
                return tool_err("invalid_request", "missing required string field `portId`");
            };
            let holder = opt_str(&args, "holder").unwrap_or_else(|| "mcp-agent".to_owned());
            let reason = opt_str(&args, "reason");
            let ttl_ms = opt_u64(&args, "ttlMs").unwrap_or(60_000);
            let auto_reopen = opt_bool(&args, "autoReopen").unwrap_or(true);
            let expected_generation = opt_u64(&args, "expectedGeneration");
            match state
                .call_host_typed::<LoanInfoDto>(ControlCommand::AcquireLoan {
                    port_id,
                    holder,
                    reason,
                    ttl_ms: Some(ttl_ms),
                    auto_reopen: Some(auto_reopen),
                    connection_bound: Some(false),
                    expected_generation,
                })
                .await
            {
                Ok(loan) => tool_ok(serde_json::to_value(loan).unwrap_or(Value::Null)),
                Err(e) => tool_err_host(e),
            }
        }
        "heartbeat_serial_loan" => {
            let Some(lease_id) = req_str(&args, "leaseId") else {
                return tool_err("invalid_request", "missing required string field `leaseId`");
            };
            let extend_ttl_ms = opt_u64(&args, "extendTtlMs");
            match state
                .call_host_typed::<LoanInfoDto>(ControlCommand::HeartbeatLoan {
                    lease_id,
                    extend_ttl_ms,
                })
                .await
            {
                Ok(loan) => tool_ok(serde_json::to_value(loan).unwrap_or(Value::Null)),
                Err(e) => tool_err_host(e),
            }
        }
        "release_serial_loan" => {
            let Some(lease_id) = req_str(&args, "leaseId") else {
                return tool_err("invalid_request", "missing required string field `leaseId`");
            };
            let reopen_override = opt_bool(&args, "reopenOverride");
            match state
                .call_host_typed::<SerialRecoveryDto>(ControlCommand::ReleaseLoan {
                    lease_id,
                    reopen_override,
                })
                .await
            {
                Ok(recovery) => tool_ok(serde_json::to_value(recovery).unwrap_or(Value::Null)),
                Err(e) => tool_err_host(e),
            }
        }
        "list_active_leases" => {
            match state
                .call_host_typed::<Vec<LoanInfoDto>>(ControlCommand::ListLoans)
                .await
            {
                Ok(loans) => tool_ok(json!({ "loans": loans })),
                Err(e) => tool_err_host(e),
            }
        }
        "run_with_serial_loan" => run_with_serial_loan_tool(state, args).await,
        "list_plugin_tools" => match state.call_host(ControlCommand::ListPluginTools).await {
            Ok(val) => match parse_plugin_tools_value(val) {
                Ok(tools) => tool_ok(json!({ "tools": tools })),
                Err(e) => tool_err_host(e),
            },
            Err(e) => tool_err_host(e),
        },
        "invoke_plugin_tool" => invoke_plugin_tool_mcp(state, args).await,
        "poll_plugin_job" => {
            let Some(job_id) = req_str(&args, "jobId") else {
                return tool_err("invalid_request", "missing required string field `jobId`");
            };
            let target = match parse_opt_non_empty_str(&args, "target") {
                Ok(t) => t,
                Err(msg) => return tool_err("invalid_request", msg),
            };
            let after_seq = opt_u64(&args, "afterSeq");
            let wait_ms = opt_u64(&args, "waitMs").unwrap_or(0);
            let limit = match opt_positive_usize(&args, "limit") {
                Ok(l) => l,
                Err(msg) => return tool_err("invalid_request", msg),
            };
            match state
                .call_host_typed::<PluginJobStatusDto>(ControlCommand::PollPluginJob {
                    target,
                    job_id,
                    after_seq,
                    wait_ms,
                    limit,
                })
                .await
            {
                Ok(status) => tool_ok(serde_json::to_value(status).unwrap_or(Value::Null)),
                Err(e) => tool_err_host(e),
            }
        }
        "cancel_plugin_job" => {
            let Some(job_id) = req_str(&args, "jobId") else {
                return tool_err("invalid_request", "missing required string field `jobId`");
            };
            let target = match parse_opt_non_empty_str(&args, "target") {
                Ok(t) => t,
                Err(msg) => return tool_err("invalid_request", msg),
            };
            match state
                .call_host(ControlCommand::CancelPluginJob { target, job_id })
                .await
            {
                Ok(val) => tool_ok(val),
                Err(e) => tool_err_host(e),
            }
        }
        "upload_artifact" => {
            let Some(file_path) = req_str(&args, "filePath") else {
                return tool_err("invalid_request", "missing required string field `filePath`");
            };
            let target = match parse_opt_non_empty_str(&args, "target") {
                Ok(t) => t,
                Err(msg) => return tool_err("invalid_request", msg),
            };
            let name = match parse_opt_non_empty_str(&args, "name") {
                Ok(n) => n,
                Err(msg) => return tool_err("invalid_request", msg),
            };
            let ttl_ms = match opt_positive_u64(&args, "ttlMs") {
                Ok(t) => t,
                Err(msg) => return tool_err("invalid_request", msg),
            };
            match upload_artifact_streaming(state, Path::new(&file_path), target, name, ttl_ms)
                .await
            {
                Ok(info) => tool_ok(serde_json::to_value(info).unwrap_or(Value::Null)),
                Err(e) => tool_err_host(e),
            }
        }
        _ => tool_err("unknown_tool", format!("Unknown tool: {name}")),
    }
}

async fn invoke_plugin_tool_mcp(state: &mut McpState, args: Value) -> Value {
    let Some(plugin_id) = req_str(&args, "pluginId") else {
        return tool_err("invalid_request", "missing required string field `pluginId`");
    };
    let Some(tool) = req_str(&args, "tool") else {
        return tool_err("invalid_request", "missing required string field `tool`");
    };
    let target = match parse_opt_non_empty_str(&args, "target") {
        Ok(t) => t,
        Err(msg) => return tool_err("invalid_request", msg),
    };
    let tool_args = args
        .get("args")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let artifacts = match args.get("artifacts").filter(|v| !v.is_null()) {
        Some(raw) => match parse_string_array(raw, "artifacts") {
            Ok(list) if !list.is_empty() => Some(list),
            Ok(_) => None,
            Err(msg) => return tool_err("invalid_request", msg),
        },
        None => None,
    };
    let timeout_ms = match opt_positive_u64(&args, "timeoutMs") {
        Ok(t) => t,
        Err(msg) => return tool_err("invalid_request", msg),
    };
    let wait = opt_bool(&args, "wait").unwrap_or(false);

    let res: PluginToolInvokeResultDto = match state
        .call_host_typed(ControlCommand::InvokePluginTool {
            target: target.clone(),
            plugin_id,
            tool,
            args: tool_args,
            artifacts,
            timeout_ms,
        })
        .await
    {
        Ok(res) => res,
        Err(e) => return tool_err_host(e),
    };

    if res.mode != "job" {
        return tool_ok(serde_json::to_value(res).unwrap_or(Value::Null));
    }

    let Some(job_id) = res
        .job_id
        .clone()
        .or_else(|| res.status.as_ref().map(|s| s.job_id.clone()))
    else {
        return tool_err("protocol_mismatch", "job mode response missing `jobId`");
    };

    if !wait {
        return tool_ok(json!({
            "mode": "job",
            "jobId": job_id,
            "status": res.status,
        }));
    }

    let wait_budget_ms = timeout_ms.unwrap_or(DEFAULT_PLUGIN_JOB_WAIT_MS);
    let deadline = Instant::now() + Duration::from_millis(wait_budget_ms);
    let mut accumulated_events: Vec<PluginJobEventDto> = Vec::new();
    let mut cursor: Option<u64> = None;
    let mut last_status: Option<PluginJobStatusDto> = res.status;

    if let Some(status) = last_status.as_mut() {
        accumulated_events.extend(status.events.iter().cloned());
        cursor = Some(status.next_seq);
        if is_terminal_job_state(&status.state) {
            status.events = accumulated_events;
            return format_terminal_job_for_mcp(status);
        }
    }

    loop {
        let now = Instant::now();
        if now >= deadline {
            let payload = json!({
                "jobId": job_id,
                "timedOut": true,
                "status": last_status,
                "events": accumulated_events,
            });
            return tool_payload_with_error(payload, true);
        }
        let remaining_ms = u64::try_from(deadline.saturating_duration_since(now).as_millis())
            .unwrap_or(MAX_POLL_MS)
            .max(1);
        let poll_wait_ms = remaining_ms.min(MAX_POLL_MS);

        let mut status: PluginJobStatusDto = match state
            .call_host_typed(ControlCommand::PollPluginJob {
                target: target.clone(),
                job_id: job_id.clone(),
                after_seq: cursor,
                wait_ms: poll_wait_ms,
                limit: Some(100),
            })
            .await
        {
            Ok(s) => s,
            Err(e) => return tool_err_host(e),
        };

        cursor = Some(status.next_seq);
        accumulated_events.extend(status.events.iter().cloned());

        if is_terminal_job_state(&status.state) {
            status.events = accumulated_events;
            return format_terminal_job_for_mcp(&status);
        }
        last_status = Some(status);
    }
}

fn format_terminal_job_for_mcp(status: &PluginJobStatusDto) -> Value {
    let val = serde_json::to_value(status).unwrap_or(Value::Null);
    let failed = status.state != "completed";
    tool_payload_with_error(val, failed)
}

fn tool_payload_with_error(payload: Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| payload.to_string());
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error,
    })
}

async fn execute_dynamic_tool(
    state: &mut McpState,
    route: DynamicToolRoute,
    mut args: Value,
) -> Value {
    let mut artifacts: Option<Vec<String>> = None;
    if let Some(obj) = args.as_object_mut() {
        if let Some(raw_artifacts) = obj.remove("artifacts") {
            if !raw_artifacts.is_null() {
                match parse_string_array(&raw_artifacts, "artifacts") {
                    Ok(list) if !list.is_empty() => artifacts = Some(list),
                    Ok(_) => {}
                    Err(msg) => return tool_err("invalid_request", msg),
                }
            }
        }
    }

    match state
        .call_host_typed::<PluginToolInvokeResultDto>(ControlCommand::InvokePluginTool {
            target: route.target,
            plugin_id: route.plugin_id,
            tool: route.tool,
            args,
            artifacts,
            timeout_ms: None,
        })
        .await
    {
        Ok(res) => tool_ok(serde_json::to_value(res).unwrap_or(Value::Null)),
        Err(e) => tool_err_host(e),
    }
}

async fn list_all_tools(state: &mut McpState) -> Vec<Value> {
    let mut tools = tool_definitions();
    if let Ok(dynamic_defs) = refresh_dynamic_tools(state).await {
        tools.extend(dynamic_defs);
    }
    tools
}

async fn refresh_dynamic_tools(state: &mut McpState) -> Result<Vec<Value>, HostError> {
    let raw = match state.call_host(ControlCommand::ListPluginTools).await {
        Ok(val) => val,
        Err(err) => {
            state.dynamic_tools.clear();
            state.dynamic_tools_loaded = false;
            return Err(err);
        }
    };
    let descriptors = match parse_plugin_tools_value(raw) {
        Ok(list) => list,
        Err(err) => {
            state.dynamic_tools.clear();
            state.dynamic_tools_loaded = false;
            return Err(err);
        }
    };

    let mut used_names: HashSet<String> = tool_definitions()
        .into_iter()
        .filter_map(|def| def.get("name").and_then(Value::as_str).map(str::to_owned))
        .collect();

    let mut routes = HashMap::with_capacity(descriptors.len());
    let mut defs = Vec::with_capacity(descriptors.len());

    for desc in descriptors {
        let mcp_name = build_unique_mcp_tool_name(&desc, &mut used_names);
        let route_target = if desc.host == "local" || desc.host.is_empty() {
            None
        } else {
            Some(desc.host.clone())
        };
        routes.insert(
            mcp_name.clone(),
            DynamicToolRoute {
                target: route_target,
                plugin_id: desc.plugin_id.clone(),
                tool: desc.tool.clone(),
                mode: desc.mode.clone(),
            },
        );
        let description = if desc.description.is_empty() {
            format!("[{}] {} ({}, {})", desc.host, desc.plugin_name, desc.access, desc.mode)
        } else {
            format!(
                "[{}] {} ({}, {}): {}",
                desc.host, desc.plugin_name, desc.access, desc.mode, desc.description
            )
        };
        let input_schema = enrich_plugin_schema(&desc.input_schema, desc.accepts_artifacts);
        defs.push(json!({
            "name": mcp_name,
            "description": description,
            "inputSchema": input_schema,
        }));
    }

    state.dynamic_tools = routes;
    state.dynamic_tools_loaded = true;
    Ok(defs)
}

fn build_unique_mcp_tool_name(
    desc: &PluginToolDescriptorDto,
    used: &mut HashSet<String>,
) -> String {
    let prefix = if desc.host == "local" || desc.host.is_empty() {
        "plugin_".to_owned()
    } else if let Some(profile) = desc.host.strip_prefix("remote::") {
        format!("remote_{}_", sanitize_mcp_segment(profile))
    } else {
        format!("remote_{}_", sanitize_mcp_segment(&desc.host))
    };

    let plugin_seg = plugin_id_segment(&desc.plugin_id);
    let tool_seg = sanitize_mcp_segment(&desc.tool);
    let raw_base = format!("{prefix}{plugin_seg}_{tool_seg}");
    let base = truncate_mcp_name(&raw_base, 64);

    if used.insert(base.clone()) {
        return base;
    }

    for n in 2usize.. {
        let suffix = format!("_{n}");
        let max_prefix = 64usize.saturating_sub(suffix.len());
        let trimmed = truncate_mcp_name(&raw_base, max_prefix);
        let candidate = format!("{trimmed}{suffix}");
        if used.insert(candidate.clone()) {
            return candidate;
        }
    }
    unreachable!("unbounded suffix search")
}

fn plugin_id_segment(plugin_id: &str) -> String {
    let last = plugin_id
        .rsplit(['.', '/', ':'])
        .find(|s| !s.is_empty())
        .unwrap_or(plugin_id);
    sanitize_mcp_segment(last)
}

fn sanitize_mcp_segment(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_underscore = false;
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            if ch == '_' {
                if !prev_underscore && !out.is_empty() {
                    out.push('_');
                }
                prev_underscore = true;
            } else {
                out.push(ch);
                prev_underscore = false;
            }
        } else if !prev_underscore && !out.is_empty() {
            out.push('_');
            prev_underscore = true;
        }
    }
    while out.ends_with('_') {
        out.pop();
    }
    if out.is_empty() {
        "tool".to_owned()
    } else {
        out
    }
}

fn truncate_mcp_name(raw: &str, max_len: usize) -> String {
    let mut s: String = raw.chars().take(max_len).collect();
    while s.ends_with('_') && s.len() > 1 {
        s.pop();
    }
    if s.is_empty() {
        "plugin".chars().take(max_len.max(1)).collect()
    } else {
        s
    }
}

fn enrich_plugin_schema(raw_schema: &Value, accepts_artifacts: bool) -> Value {
    let mut schema = match raw_schema {
        Value::Object(map) => Value::Object(map.clone()),
        _ => json!({ "type": "object", "properties": {} }),
    };
    if let Some(obj) = schema.as_object_mut() {
        if !obj.contains_key("type") {
            obj.insert("type".into(), json!("object"));
        }
        let props = obj
            .entry("properties".to_owned())
            .or_insert_with(|| json!({}));
        if !props.is_object() {
            *props = json!({});
        }
        if accepts_artifacts {
            if let Some(props_obj) = props.as_object_mut() {
                props_obj.entry("artifacts".to_owned()).or_insert_with(|| {
                    json!({
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional list of uploaded artifact IDs from upload_artifact"
                    })
                });
            }
        }
    }
    schema
}

async fn run_with_serial_loan_tool(state: &mut McpState, args: Value) -> Value {
    let Some(port_id) = req_str(&args, "portId") else {
        return tool_err("invalid_request", "missing required string field `portId`");
    };
    let Some(program) = req_str(&args, "program") else {
        return tool_err("invalid_request", "missing required string field `program`");
    };
    let cmd_args: Vec<String> = match args.get("args") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                let Some(s) = item.as_str() else {
                    return tool_err("invalid_request", "`args` elements must be strings");
                };
                out.push(s.to_owned());
            }
            out
        }
        _ => return tool_err("invalid_request", "`args` must be an array of strings"),
    };
    let cwd = opt_str(&args, "cwd");
    let holder = opt_str(&args, "holder").unwrap_or_else(|| {
        Path::new(&program)
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(&program)
            .to_owned()
    });
    let reason = opt_str(&args, "reason");
    let ttl_ms = opt_u64(&args, "ttlMs").unwrap_or(60_000);
    let auto_reopen = opt_bool(&args, "autoReopen").unwrap_or(true);
    let timeout_ms = opt_u64(&args, "timeoutMs");
    let expected_generation = opt_u64(&args, "expectedGeneration");

    let loan = match state
        .call_host_typed::<LoanInfoDto>(ControlCommand::AcquireLoan {
            port_id: port_id.clone(),
            holder,
            reason,
            ttl_ms: Some(ttl_ms),
            auto_reopen: Some(auto_reopen),
            connection_bound: Some(true),
            expected_generation,
        })
        .await
    {
        Ok(loan) => loan,
        Err(e) => return tool_err_host(e),
    };
    let lease_id = loan.lease_id.clone();

    let mut command = Command::new(&program);
    command
        .args(&cmd_args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = &cwd {
        command.current_dir(dir);
    }

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(err) => {
            let _ = state
                .call_host(ControlCommand::ReleaseLoan {
                    lease_id,
                    reopen_override: None,
                })
                .await;
            return tool_err("spawn_failed", format!("failed to spawn `{program}`: {err}"));
        }
    };

    let stdout_handle = child.stdout.take().map(|mut pipe| {
        tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = tokio::io::AsyncReadExt::read_to_end(&mut pipe, &mut buf).await;
            buf
        })
    });
    let stderr_handle = child.stderr.take().map(|mut pipe| {
        tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = tokio::io::AsyncReadExt::read_to_end(&mut pipe, &mut buf).await;
            buf
        })
    });

    let hb_ms = (ttl_ms / 3).clamp(250, 30_000);
    let mut hb_interval = tokio::time::interval(Duration::from_millis(hb_ms));
    hb_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    hb_interval.tick().await;

    let timeout_fut = async {
        match timeout_ms {
            Some(ms) => tokio::time::sleep(Duration::from_millis(ms)).await,
            None => std::future::pending::<()>().await,
        }
    };
    tokio::pin!(timeout_fut);

    let mut timed_out = false;
    let exit_code: Option<i32> = loop {
        tokio::select! {
            status = child.wait() => {
                break status.ok().and_then(|s| s.code());
            }
            _ = hb_interval.tick() => {
                let _ = state.call_host(ControlCommand::HeartbeatLoan {
                    lease_id: lease_id.clone(),
                    extend_ttl_ms: Some(ttl_ms),
                }).await;
            }
            _ = &mut timeout_fut => {
                timed_out = true;
                let _ = child.kill().await;
                let _ = child.wait().await;
                break None;
            }
        }
    };

    let stdout_bytes = match stdout_handle {
        Some(h) => h.await.unwrap_or_default(),
        None => Vec::new(),
    };
    let stderr_bytes = match stderr_handle {
        Some(h) => h.await.unwrap_or_default(),
        None => Vec::new(),
    };

    let recovery: Result<SerialRecoveryDto, HostError> = state
        .call_host_typed(ControlCommand::ReleaseLoan {
            lease_id,
            reopen_override: None,
        })
        .await;

    let recovery_val = match &recovery {
        Ok(r) => serde_json::to_value(r).unwrap_or(Value::Null),
        Err(e) => json!({ "state": "release_error", "error": e.to_string() }),
    };

    let payload = json!({
        "portId": port_id,
        "exitCode": exit_code,
        "timedOut": timed_out,
        "stdout": String::from_utf8_lossy(&stdout_bytes),
        "stderr": String::from_utf8_lossy(&stderr_bytes),
        "serialRecovery": recovery_val,
    });

    let failed = timed_out || exit_code != Some(0);
    let text = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| payload.to_string());
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": failed,
    })
}

fn format_event_page_for_mcp(page: &EventPageDto) -> Value {
    let mut lines = Vec::new();
    let events: Vec<Value> = page
        .events
        .iter()
        .map(|ev| {
            let decoded = ev.text.clone().or_else(|| {
                ev.data_base64
                    .as_deref()
                    .and_then(|b64| STANDARD.decode(b64).ok())
                    .map(|raw| String::from_utf8_lossy(&raw).into_owned())
            });
            lines.push(format_stream_line(ev, decoded.as_deref()));
            let mut val = serde_json::to_value(ev).unwrap_or(Value::Null);
            if ev.text.is_none() {
                if let (Some(obj), Some(txt)) = (val.as_object_mut(), decoded) {
                    obj.insert("text".into(), Value::String(txt));
                }
            }
            val
        })
        .collect();

    json!({
        "hostId": page.host_id,
        "portId": page.port_id,
        "generation": page.generation,
        "latestSeq": page.latest_seq,
        "nextSeq": page.next_seq,
        "gap": page.gap,
        "formattedText": lines.join("\n"),
        "events": events,
    })
}

fn format_stream_line(ev: &StreamEventDto, decoded: Option<&str>) -> String {
    let tag = ev.kind.to_ascii_uppercase();
    let body = decoded
        .map(|s| s.trim_end_matches(['\r', '\n']).to_owned())
        .or_else(|| ev.status.clone())
        .or_else(|| {
            ev.loan
                .as_ref()
                .map(|l| format!("lease={} holder={}", l.lease_id, l.holder))
        })
        .unwrap_or_default();
    format!("[{tag} #{}] {body}", ev.seq)
}

fn parse_mcp_serial_params(args: &Value) -> Result<Option<SerialParamsDto>, String> {
    let baud = opt_u64(args, "baudRate");
    let data_bits = opt_u64(args, "dataBits");
    let parity = opt_str(args, "parity");
    let stop_bits = opt_str(args, "stopBits");
    let handshake = opt_str(args, "handshake");
    let dtr = opt_bool(args, "dtr");
    let rts = opt_bool(args, "rts");

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

    let mut params = SerialParamsDto::default();
    if let Some(b) = baud {
        if b == 0 || b > u64::from(u32::MAX) {
            return Err("`baudRate` must be 1..=u32::MAX".into());
        }
        params.baud_rate = b as u32;
    }
    if let Some(db) = data_bits {
        if !(5..=8).contains(&db) {
            return Err("`dataBits` must be 5..=8".into());
        }
        params.data_bits = db as u8;
    }
    if let Some(p) = parity {
        params.parity = normalize_parity(&p)?;
    }
    if let Some(sb) = stop_bits {
        params.stop_bits = normalize_stop_bits(&sb)?;
    }
    if let Some(hs) = handshake {
        params.handshake = normalize_handshake(&hs)?;
    }
    if let Some(v) = dtr {
        params.dtr = v;
    }
    if let Some(v) = rts {
        params.rts = v;
    }
    Ok(Some(params))
}

fn parse_mcp_tx_bytes(args: &Value) -> Result<Vec<u8>, String> {
    let text = opt_str(args, "text");
    let hex = opt_str(args, "hex");
    let eol = opt_str(args, "eol");
    let bytes = match (text, hex) {
        (Some(t), None) => apply_eol_bytes(&t, eol.as_deref())?,
        (None, Some(h)) => {
            if eol.as_deref().is_some_and(|e| e != "none") {
                return Err("`eol` cannot be combined with `hex`".into());
            }
            parse_hex_strict(&h)?
        }
        (Some(_), Some(_)) => return Err("provide only one of `text` or `hex`".into()),
        (None, None) => return Err("provide one of `text` or `hex`".into()),
    };
    if bytes.is_empty() || bytes.len() > MAX_WRITE_BYTES {
        return Err(format!("payload must contain 1..={MAX_WRITE_BYTES} bytes"));
    }
    Ok(bytes)
}

fn parse_mcp_expect(args: &Value) -> Result<ExpectSpec, String> {
    let line = opt_str(args, "expectLine");
    let text = opt_str(args, "expectText");
    let hex = opt_str(args, "expectHex");
    let (spec, len) = match (line, text, hex) {
        (Some(l), None, None) => {
            if l.contains('\n') {
                return Err("`expectLine` cannot contain newline".into());
            }
            let len = l.len();
            (ExpectSpec::Line { text: l }, len)
        }
        (None, Some(t), None) => {
            let len = t.len();
            (ExpectSpec::Text { text: t }, len)
        }
        (None, None, Some(h)) => {
            let bytes = parse_hex_strict(&h)?;
            let len = bytes.len();
            (
                ExpectSpec::Bytes {
                    data_base64: STANDARD.encode(&bytes),
                },
                len,
            )
        }
        _ => {
            return Err("provide exactly one of `expectLine`, `expectText`, or `expectHex`".into());
        }
    };
    if len == 0 || len > MAX_EXPECT_BYTES {
        return Err(format!(
            "expectation pattern must contain 1..={MAX_EXPECT_BYTES} bytes"
        ));
    }
    Ok(spec)
}

fn req_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn opt_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn opt_u64(args: &Value, key: &str) -> Option<u64> {
    args.get(key).and_then(Value::as_u64)
}

fn opt_bool(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(Value::as_bool)
}

fn parse_opt_non_empty_str(args: &Value, key: &str) -> Result<Option<String>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if !s.is_empty() => Ok(Some(s.clone())),
        Some(Value::String(_)) => Err(format!("`{key}` cannot be empty")),
        Some(_) => Err(format!("`{key}` must be a string")),
    }
}

fn opt_positive_u64(args: &Value, key: &str) -> Result<Option<u64>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => match v.as_u64() {
            Some(n) if n >= 1 => Ok(Some(n)),
            _ => Err(format!("`{key}` must be a positive integer")),
        },
    }
}

fn opt_positive_usize(args: &Value, key: &str) -> Result<Option<usize>, String> {
    opt_positive_u64(args, key)?
        .map(|n| usize::try_from(n).map_err(|_| format!("`{key}` is too large")))
        .transpose()
}

fn parse_string_array(raw: &Value, key: &str) -> Result<Vec<String>, String> {
    let Some(items) = raw.as_array() else {
        return Err(format!("`{key}` must be an array of strings"));
    };
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let Some(s) = item.as_str().filter(|s| !s.is_empty()) else {
            return Err(format!("`{key}` elements must be non-empty strings"));
        };
        out.push(s.to_owned());
    }
    Ok(out)
}

pub fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "list_ports",
            "description": "List all serial ports visible to the HyperCom host (both local ports and connected remote ports as remote::<profile>::<port>), including status, baud rate, USB metadata, and active exclusive leases.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }
        }),
        json!({
            "name": "get_port_status",
            "description": "Get detailed status for a specific serial port (including current generation and any active loan).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "portId": { "type": "string", "description": "Port identifier: a local port (e.g. COM9 or /dev/ttyUSB0) or a connected remote port (remote::<profile>::<port>) returned by list_ports" }
                },
                "required": ["portId"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "open_port",
            "description": "Open a serial port on the HyperCom host with optional baud rate and framing parameters.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "portId": { "type": "string", "description": "Port identifier: a local port (e.g. COM9) or a connected remote port (remote::<profile>::<port>) returned by list_ports" },
                    "baudRate": { "type": "integer", "minimum": 1, "description": "Baud rate (default 115200)" },
                    "dataBits": { "type": "integer", "enum": [5, 6, 7, 8], "description": "Data bits (default 8)" },
                    "parity": { "type": "string", "enum": ["none", "odd", "even"], "description": "Parity mode" },
                    "stopBits": { "type": "string", "enum": ["one", "two", "1", "2"], "description": "Stop bits" },
                    "handshake": { "type": "string", "enum": ["none", "xonxoff", "rtscts"], "description": "Flow control mode" },
                    "dtr": { "type": "boolean", "description": "DTR line initial state" },
                    "rts": { "type": "boolean", "description": "RTS line initial state" },
                    "expectedGeneration": { "type": "integer", "minimum": 0, "description": "Optional generation CAS guard" }
                },
                "required": ["portId"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "close_port",
            "description": "Close an open serial port on the HyperCom host.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "portId": { "type": "string", "description": "Port identifier: a local port (e.g. COM9) or a connected remote port (remote::<profile>::<port>) returned by list_ports" },
                    "expectedGeneration": { "type": "integer", "minimum": 0, "description": "Optional generation CAS guard" }
                },
                "required": ["portId"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "read_recent_rx",
            "description": "Fetch recent RX/TX/status/loan/note events from a port ring buffer, returning decoded UTF-8 text and nextSeq cursor.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "portId": { "type": "string", "description": "Port identifier: a local port (e.g. COM9) or a connected remote port (remote::<profile>::<port>) returned by list_ports" },
                    "recent": { "type": "integer", "minimum": 1, "description": "Number of most recent events to return (default 50 if afterSeq omitted)" },
                    "afterSeq": { "type": "integer", "minimum": 0, "description": "Resume reading events strictly after this sequence cursor" },
                    "waitMs": { "type": "integer", "minimum": 0, "description": "Long-poll wait duration in milliseconds (default 0)" },
                    "limit": { "type": "integer", "minimum": 1, "description": "Maximum events to return in one page" }
                },
                "required": ["portId"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "send_serial",
            "description": "Send UTF-8 text (with optional line ending) or strict hex bytes to an open serial port.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "portId": { "type": "string", "description": "Port identifier: a local port (e.g. COM9) or a connected remote port (remote::<profile>::<port>) returned by list_ports" },
                    "text": { "type": "string", "description": "UTF-8 text payload (mutually exclusive with hex)" },
                    "hex": { "type": "string", "description": "Hexadecimal byte string (even digits, whitespace allowed; mutually exclusive with text and eol)" },
                    "eol": { "type": "string", "enum": ["none", "lf", "cr", "crlf"], "description": "Line ending appended to text" },
                    "source": { "type": "string", "description": "Optional source label shown in HyperCom terminal" },
                    "expectedGeneration": { "type": "integer", "minimum": 0, "description": "Optional generation CAS guard" }
                },
                "required": ["portId"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "request_serial",
            "description": "Atomically pre-register an expectation pattern on the host, send a command, and wait for the matching device response.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "portId": { "type": "string", "description": "Port identifier: a local port (e.g. COM9) or a connected remote port (remote::<profile>::<port>) returned by list_ports" },
                    "text": { "type": "string", "description": "UTF-8 text payload to send" },
                    "hex": { "type": "string", "description": "Hex bytes to send" },
                    "eol": { "type": "string", "enum": ["none", "lf", "cr", "crlf"], "description": "Line ending appended to text" },
                    "expectLine": { "type": "string", "description": "Exact line match (without LF)" },
                    "expectText": { "type": "string", "description": "Literal UTF-8 substring match" },
                    "expectHex": { "type": "string", "description": "Literal hex byte sequence match" },
                    "timeoutMs": { "type": "integer", "minimum": 1, "maximum": 60000, "description": "Match timeout in milliseconds (default 3000)" },
                    "source": { "type": "string", "description": "Optional source label" },
                    "expectedGeneration": { "type": "integer", "minimum": 0, "description": "Optional generation CAS guard" }
                },
                "required": ["portId"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "add_terminal_note",
            "description": "Insert a visible NOTE line into the human operator's HyperCom terminal view for a port.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "portId": { "type": "string", "description": "Port identifier: a local port (e.g. COM9) or a connected remote port (remote::<profile>::<port>) returned by list_ports" },
                    "text": { "type": "string", "description": "Note text to display" },
                    "source": { "type": "string", "description": "Optional source label" }
                },
                "required": ["portId", "text"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "acquire_serial_loan",
            "description": "Borrow exclusive OS ownership of a serial port so HyperCom closes its handle and pauses auto-reconnect until released or TTL expires.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "portId": { "type": "string", "description": "Port identifier: a local port (e.g. COM9) or a connected remote port (remote::<profile>::<port>) returned by list_ports" },
                    "holder": { "type": "string", "description": "Human-readable holder name" },
                    "reason": { "type": "string", "description": "Reason for exclusive borrow" },
                    "ttlMs": { "type": "integer", "minimum": 1000, "description": "Lease TTL in milliseconds (default 60000)" },
                    "autoReopen": { "type": "boolean", "description": "Whether HyperCom should reopen the port when released (default true)" },
                    "expectedGeneration": { "type": "integer", "minimum": 0, "description": "Optional generation CAS guard" }
                },
                "required": ["portId"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "heartbeat_serial_loan",
            "description": "Extend the TTL of an active serial port loan lease.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "leaseId": { "type": "string", "description": "Lease ID returned by acquire_serial_loan" },
                    "extendTtlMs": { "type": "integer", "minimum": 1000, "description": "New TTL extension in milliseconds" }
                },
                "required": ["leaseId"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "release_serial_loan",
            "description": "Return a borrowed serial port lease so HyperCom can immediately reopen and resume monitoring.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "leaseId": { "type": "string", "description": "Lease ID to release" },
                    "reopenOverride": { "type": "boolean", "description": "Optionally override autoReopen behavior on release" }
                },
                "required": ["leaseId"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "list_active_leases",
            "description": "List all currently active serial port loan leases across local ports and connected remote hosts.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }
        }),
        json!({
            "name": "run_with_serial_loan",
            "description": "Borrow exclusive OS ownership of a serial port, run a local command (such as esptool.py, openocd, pyocd, or cargo flash), capture stdout/stderr/exitCode, and automatically release & reopen the port.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "portId": { "type": "string", "description": "Port identifier to borrow: a local port (e.g. COM9) or a connected remote port (remote::<profile>::<port>) returned by list_ports" },
                    "program": { "type": "string", "description": "Program executable name or path" },
                    "args": { "type": "array", "items": { "type": "string" }, "description": "Command arguments" },
                    "cwd": { "type": "string", "description": "Optional working directory" },
                    "holder": { "type": "string", "description": "Optional holder name (defaults to program basename)" },
                    "reason": { "type": "string", "description": "Optional borrow reason" },
                    "ttlMs": { "type": "integer", "minimum": 1000, "description": "Lease TTL in milliseconds (default 60000)" },
                    "autoReopen": { "type": "boolean", "description": "Reopen port after command completes (default true)" },
                    "timeoutMs": { "type": "integer", "minimum": 1, "description": "Optional child process execution timeout in milliseconds" },
                    "expectedGeneration": { "type": "integer", "minimum": 0, "description": "Optional generation CAS guard" }
                },
                "required": ["portId", "program"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "list_plugin_tools",
            "description": "Discover available plugin tools across the local HyperCom host and connected remote hosts (including access level, sync/job mode, artifact support, and input schemas).",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }
        }),
        json!({
            "name": "invoke_plugin_tool",
            "description": "Invoke a plugin tool on the local host or a connected remote host (target: 'local' or 'remote::<profile>'). Async job tools can optionally wait until completion.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pluginId": { "type": "string", "description": "Plugin identifier from list_plugin_tools" },
                    "tool": { "type": "string", "description": "Tool name within the plugin" },
                    "target": { "type": "string", "description": "Optional host target ('local' or 'remote::<profile>')" },
                    "args": { "type": "object", "description": "Tool-specific JSON arguments matching the plugin tool inputSchema" },
                    "artifacts": { "type": "array", "items": { "type": "string" }, "description": "Optional artifact IDs returned by upload_artifact" },
                    "timeoutMs": { "type": "integer", "minimum": 1, "description": "Optional invocation/wait timeout in milliseconds (wait defaults to 120000ms)" },
                    "wait": { "type": "boolean", "description": "If true and the tool returns an async job, poll until completion (default false)" }
                },
                "required": ["pluginId", "tool"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "poll_plugin_job",
            "description": "Poll the status and incremental log/progress events of an async plugin job.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "jobId": { "type": "string", "description": "Job identifier returned by invoke_plugin_tool or a dynamic job tool" },
                    "target": { "type": "string", "description": "Optional host target ('local' or 'remote::<profile>')" },
                    "afterSeq": { "type": "integer", "minimum": 0, "description": "Resume reading job events strictly after this sequence cursor" },
                    "waitMs": { "type": "integer", "minimum": 0, "description": "Optional long-poll wait duration in milliseconds (default 0)" },
                    "limit": { "type": "integer", "minimum": 1, "description": "Maximum number of events to return" }
                },
                "required": ["jobId"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "cancel_plugin_job",
            "description": "Cancel a running async plugin job.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "jobId": { "type": "string", "description": "Job identifier to cancel" },
                    "target": { "type": "string", "description": "Optional host target ('local' or 'remote::<profile>')" }
                },
                "required": ["jobId"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "upload_artifact",
            "description": "Stream a local file (such as firmware binary or configuration image) to the local or remote HyperCom host with SHA-256 verification and return an artifactId for plugin tools.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filePath": { "type": "string", "description": "Path to the local file to upload" },
                    "target": { "type": "string", "description": "Optional host target ('local' or 'remote::<profile>')" },
                    "name": { "type": "string", "description": "Optional artifact filename override (defaults to filePath basename)" },
                    "ttlMs": { "type": "integer", "minimum": 1, "description": "Optional artifact retention TTL in milliseconds" }
                },
                "required": ["filePath"],
                "additionalProperties": false
            }
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn mcp_initialize_ping_tools_list_and_errors() {
        let mut state = McpState::new(Target::Local("nonexistent".into()));

        let init = handle_raw_line(
            &mut state,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
        )
        .await
        .unwrap();
        assert_eq!(init["jsonrpc"], "2.0");
        assert_eq!(init["id"], 1);
        assert_eq!(init["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(init["result"]["serverInfo"]["name"], "hypercomctl");
        assert!(init["result"]["capabilities"]["tools"].is_object());

        // Notification produces no reply
        assert!(handle_raw_line(
            &mut state,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        )
        .await
        .is_none());

        let ping = handle_raw_line(&mut state, r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#)
            .await
            .unwrap();
        assert_eq!(ping["id"], 2);
        assert_eq!(ping["result"], json!({}));

        let list =
            handle_raw_line(&mut state, r#"{"jsonrpc":"2.0","id":3,"method":"tools/list"}"#)
                .await
                .unwrap();
        let tools = list["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 18);
        for tool in tools {
            assert!(tool["name"].as_str().is_some());
            assert!(tool["description"].as_str().is_some());
            assert_eq!(tool["inputSchema"]["type"], "object");
            assert!(tool["inputSchema"]["properties"].is_object());
        }

        // Parse error
        let bad_json = handle_raw_line(&mut state, "{not json").await.unwrap();
        assert_eq!(bad_json["error"]["code"], -32700);

        // Unknown method
        let unknown_method =
            handle_raw_line(&mut state, r#"{"jsonrpc":"2.0","id":4,"method":"nope"}"#)
                .await
                .unwrap();
        assert_eq!(unknown_method["error"]["code"], -32601);

        // Unknown tool
        let unknown_tool = handle_raw_line(
            &mut state,
            r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"bogus","arguments":{}}}"#,
        )
        .await
        .unwrap();
        assert_eq!(unknown_tool["error"]["code"], -32602);
    }

    #[tokio::test]
    async fn mcp_stdio_tools_roundtrip_and_validation() {
        let recorded = Arc::new(Mutex::new(Vec::<ControlCommand>::new()));
        let recorded_clone = recorded.clone();

        let mut state = McpState::mock(move |cmd| {
            recorded_clone.lock().unwrap().push(cmd.clone());
            match cmd {
                ControlCommand::Ports => Ok(json!([
                    {
                        "id": "COM9",
                        "name": "COM9",
                        "portType": "USB",
                        "status": "connected",
                        "generation": 3,
                        "baudRate": 115200
                    }
                ])),
                ControlCommand::PollEvents { port_id, .. } => Ok(json!({
                    "hostId": "host-1",
                    "portId": port_id,
                    "generation": 3,
                    "latestSeq": 42,
                    "nextSeq": 43,
                    "gap": false,
                    "events": [{
                        "seq": 42,
                        "portId": "COM9",
                        "generation": 3,
                        "timestampMs": 1000,
                        "kind": "rx",
                        "dataBase64": STANDARD.encode(b"BOOT OK\r\n")
                    }]
                })),
                ControlCommand::Send { .. } => Ok(json!({ "bytesWritten": 4 })),
                ControlCommand::Request { expect, .. } => match expect {
                    ExpectSpec::Line { text } if text == "TIMEOUT" => Ok(json!({
                        "bytesWritten": 4,
                        "matched": false
                    })),
                    _ => Ok(json!({
                        "bytesWritten": 4,
                        "matched": true,
                        "matchedText": "OK",
                        "seq": 44
                    })),
                },
                ControlCommand::AcquireLoan { port_id, holder, .. } => Ok(json!({
                    "leaseId": "lease-99",
                    "portId": port_id,
                    "holder": holder,
                    "acquiredAtMs": 1000,
                    "expiresAtMs": 61000,
                    "generation": 3,
                    "autoReopen": true,
                    "connectionBound": true
                })),
                ControlCommand::ReleaseLoan { .. } => Ok(json!({
                    "state": "reopened"
                })),
                other => Err(HostError::new("invalid_request", format!("unexpected {other:?}"))),
            }
        });

        let input = concat!(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_ports","arguments":{}}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_recent_rx","arguments":{"portId":"COM9"}}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"send_serial","arguments":{"portId":"COM9","hex":"0"}}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"request_serial","arguments":{"portId":"COM9","text":"AT","eol":"crlf","expectLine":"OK"}}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"request_serial","arguments":{"portId":"COM9","text":"AT","expectLine":"TIMEOUT"}}}"#,
            "\n",
        );

        let mut reader = BufReader::new(input.as_bytes());
        let mut out = Vec::new();
        serve_with_state(&mut reader, &mut out, &mut state)
            .await
            .unwrap();

        let lines: Vec<Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 6);
        assert_eq!(lines[0]["id"], 1);
        assert_eq!(lines[1]["result"]["isError"], false);
        assert!(lines[1]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("COM9"));

        // read_recent_rx decoded text & cursor
        assert_eq!(lines[2]["result"]["isError"], false);
        let rx_text = lines[2]["result"]["content"][0]["text"].as_str().unwrap();
        assert!(rx_text.contains("BOOT OK"));
        assert!(rx_text.contains("\"nextSeq\": 43"));

        // send_serial strict hex rejection returns tool error
        assert_eq!(lines[3]["result"]["isError"], true);

        // request_serial matched vs unmatched
        assert_eq!(lines[4]["result"]["isError"], false);
        assert_eq!(lines[5]["result"]["isError"], true);

        // Verify run_with_serial_loan acquires, runs local command, and releases
        let prog = if cfg!(windows) { "cmd" } else { "sh" };
        let prog_args: Value = if cfg!(windows) {
            json!(["/C", "echo", "hello-flash"])
        } else {
            json!(["-c", "echo hello-flash"])
        };
        let loan_res = execute_tool(
            &mut state,
            "run_with_serial_loan",
            json!({
                "portId": "COM9",
                "program": prog,
                "args": prog_args,
            }),
        )
        .await;
        assert_eq!(loan_res["isError"], false);
        let loan_text = loan_res["content"][0]["text"].as_str().unwrap();
        assert!(loan_text.contains("hello-flash"));
        assert!(loan_text.contains("reopened"));
    }

    fn sample_plugin_descriptors() -> Value {
        json!([
            {
                "host": "local",
                "pluginId": "com.acme.diag",
                "pluginName": "Diagnostics",
                "installGeneration": "gen-1",
                "tool": "probe",
                "description": "Probe connected device",
                "access": "observe",
                "mode": "sync",
                "portScoped": true,
                "acceptsArtifacts": false,
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "portId": { "type": "string" }
                    },
                    "required": ["portId"],
                    "additionalProperties": false
                }
            },
            {
                "host": "remote::lab-bench",
                "hostLabel": "Lab Bench",
                "pluginId": "org.vendor.stm32-flasher",
                "pluginName": "STM32 Flasher",
                "installGeneration": "gen-2",
                "tool": "flash",
                "description": "Flash firmware image",
                "access": "control",
                "mode": "job",
                "portScoped": true,
                "acceptsArtifacts": true,
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "portId": { "type": "string" },
                        "verify": { "type": "boolean" }
                    },
                    "required": ["portId"],
                    "additionalProperties": false
                }
            },
            {
                "host": "local",
                "pluginId": "com.other.diag",
                "pluginName": "Other Diag",
                "installGeneration": "gen-3",
                "tool": "probe",
                "description": "Colliding name test",
                "access": "observe",
                "mode": "sync",
                "portScoped": false,
                "acceptsArtifacts": false,
                "inputSchema": { "type": "object", "properties": {} }
            }
        ])
    }

    fn is_valid_mcp_tool_name(name: &str) -> bool {
        !name.is_empty()
            && name.len() <= 64
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    }

    #[tokio::test]
    async fn mcp_tools_list_merges_dynamic_local_and_remote_tools_and_falls_back() {
        let mut state = McpState::mock(|cmd| match cmd {
            ControlCommand::ListPluginTools => Ok(sample_plugin_descriptors()),
            other => Err(HostError::new("invalid_request", format!("unexpected {other:?}"))),
        });

        let list =
            handle_raw_line(&mut state, r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#)
                .await
                .unwrap();
        let tools = list["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 21); // 18 static + 3 dynamic

        let names: Vec<&str> = tools
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        for name in &names {
            assert!(is_valid_mcp_tool_name(name), "invalid MCP tool name: {name}");
        }
        assert!(names.contains(&"plugin_diag_probe"));
        assert!(names.contains(&"plugin_diag_probe_2"));
        assert!(names.contains(&"remote_lab-bench_stm32-flasher_flash"));

        let remote_flash = tools
            .iter()
            .find(|t| t["name"] == "remote_lab-bench_stm32-flasher_flash")
            .unwrap();
        let desc = remote_flash["description"].as_str().unwrap();
        assert!(desc.contains("[remote::lab-bench]"));
        assert!(desc.contains("STM32 Flasher"));
        assert!(desc.contains("control, job"));
        assert!(remote_flash["inputSchema"]["properties"]["artifacts"].is_object());

        // Local tool without acceptsArtifacts does not get artifacts injected
        let local_probe = tools
            .iter()
            .find(|t| t["name"] == "plugin_diag_probe")
            .unwrap();
        assert!(local_probe["inputSchema"]["properties"]["artifacts"].is_null());

        // Graceful fallback when host is unavailable
        let mut unavailable = McpState::mock(|_| {
            Err(HostError::new("host_unavailable", "host is offline"))
        });
        let fallback_list = handle_raw_line(
            &mut unavailable,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        )
        .await
        .unwrap();
        assert_eq!(
            fallback_list["result"]["tools"].as_array().unwrap().len(),
            18
        );
    }

    #[tokio::test]
    async fn mcp_plugin_static_dynamic_job_and_artifact_roundtrip() {
        let dir =
            std::env::temp_dir().join(format!("hypercomctl-mcp-art-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let fw_path = dir.join("app.bin");
        let fw_bytes = b"HYPERCOM_FIRMWARE_IMAGE_V1";
        std::fs::write(&fw_path, fw_bytes).unwrap();

        let uploaded = Arc::new(Mutex::new(Vec::<u8>::new()));
        let uploaded_clone = uploaded.clone();
        let poll_count = Arc::new(Mutex::new(0u64));
        let poll_count_clone = poll_count.clone();
        let recorded = Arc::new(Mutex::new(Vec::<ControlCommand>::new()));
        let recorded_clone = recorded.clone();

        let mut state = McpState::mock(move |cmd| {
            recorded_clone.lock().unwrap().push(cmd.clone());
            match cmd {
                ControlCommand::ListPluginTools => Ok(sample_plugin_descriptors()),
                ControlCommand::InvokePluginTool {
                    target,
                    plugin_id,
                    tool,
                    args,
                    artifacts,
                    ..
                } => {
                    if plugin_id == "com.acme.diag" && tool == "probe" {
                        assert_eq!(target, None);
                        Ok(json!({
                            "mode": "sync",
                            "result": { "chip": "STM32H7", "port": args["portId"] }
                        }))
                    } else if plugin_id == "org.vendor.stm32-flasher" && tool == "flash" {
                        assert_eq!(target.as_deref(), Some("remote::lab-bench"));
                        assert_eq!(artifacts, Some(vec!["art-77".to_owned()]));
                        Ok(json!({
                            "mode": "job",
                            "jobId": "job-flash-1",
                            "status": {
                                "jobId": "job-flash-1",
                                "host": "remote::lab-bench",
                                "pluginId": "org.vendor.stm32-flasher",
                                "tool": "flash",
                                "state": "running",
                                "latestSeq": 1,
                                "nextSeq": 2,
                                "events": [{
                                    "seq": 1,
                                    "timestampMs": 1000,
                                    "kind": "log",
                                    "message": "erasing flash"
                                }]
                            }
                        }))
                    } else if plugin_id == "fail-plugin" {
                        Ok(json!({
                            "mode": "job",
                            "jobId": "job-fail-1",
                            "status": {
                                "jobId": "job-fail-1",
                                "host": "local",
                                "pluginId": "fail-plugin",
                                "tool": "burn",
                                "state": "failed",
                                "error": { "code": "verify_failed", "message": "CRC mismatch" },
                                "latestSeq": 1,
                                "nextSeq": 2,
                                "events": []
                            }
                        }))
                    } else {
                        Err(HostError::new("invalid_request", "unknown plugin tool"))
                    }
                }
                ControlCommand::PollPluginJob {
                    target,
                    job_id,
                    after_seq,
                    ..
                } => {
                    let mut count = poll_count_clone.lock().unwrap();
                    *count += 1;
                    if *count == 1 && after_seq == Some(2) {
                        Ok(json!({
                            "jobId": job_id,
                            "host": target.unwrap_or_else(|| "local".into()),
                            "pluginId": "org.vendor.stm32-flasher",
                            "tool": "flash",
                            "state": "completed",
                            "result": { "verified": true },
                            "latestSeq": 2,
                            "nextSeq": 3,
                            "events": [{
                                "seq": 2,
                                "timestampMs": 1500,
                                "kind": "progress",
                                "progress": 1.0,
                                "message": "done"
                            }]
                        }))
                    } else {
                        Ok(json!({
                            "jobId": job_id,
                            "host": "local",
                            "pluginId": "org.vendor.stm32-flasher",
                            "tool": "flash",
                            "state": "running",
                            "latestSeq": 1,
                            "nextSeq": 2,
                            "events": []
                        }))
                    }
                }
                ControlCommand::CancelPluginJob { job_id, .. } => Ok(json!({
                    "jobId": job_id,
                    "host": "local",
                    "pluginId": "org.vendor.stm32-flasher",
                    "tool": "flash",
                    "state": "cancelled",
                    "latestSeq": 2,
                    "nextSeq": 3,
                    "events": []
                })),
                ControlCommand::ArtifactBegin { name, total_bytes, .. } => {
                    assert_eq!(name, "app.bin");
                    assert_eq!(total_bytes, Some(fw_bytes.len() as u64));
                    Ok(json!({ "uploadId": "up-mcp-1" }))
                }
                ControlCommand::ArtifactChunk { data_base64, .. } => {
                    let bytes = STANDARD.decode(data_base64).unwrap();
                    uploaded_clone.lock().unwrap().extend_from_slice(&bytes);
                    Ok(json!({ "ok": true }))
                }
                ControlCommand::ArtifactCommit { expected_sha256, .. } => {
                    let sha = expected_sha256.unwrap();
                    assert_eq!(sha.len(), 64);
                    Ok(json!({
                        "artifactId": "art-77",
                        "name": "app.bin",
                        "sizeBytes": fw_bytes.len(),
                        "sha256": sha,
                        "expiresAtMs": 1_700_000_999_000i64
                    }))
                }
                other => Err(HostError::new("invalid_request", format!("unexpected {other:?}"))),
            }
        });

        // 1. Dynamic tool call BEFORE tools/list triggers lazy ListPluginTools refresh
        let dyn_call = handle_raw_line(
            &mut state,
            r#"{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"remote_lab-bench_stm32-flasher_flash","arguments":{"portId":"COM3","verify":true,"artifacts":["art-77"]}}}"#,
        )
        .await
        .unwrap();
        assert_eq!(dyn_call["result"]["isError"], false);
        let dyn_body: Value =
            serde_json::from_str(dyn_call["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(dyn_body["mode"], "job");
        assert_eq!(dyn_body["jobId"], "job-flash-1");

        // 2. list_plugin_tools static tool
        let listed = execute_tool(&mut state, "list_plugin_tools", json!({})).await;
        assert_eq!(listed["isError"], false);
        let listed_json: Value =
            serde_json::from_str(listed["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(listed_json["tools"].as_array().unwrap().len(), 3);

        // 3. upload_artifact static tool streaming real temp file
        let upload_res = execute_tool(
            &mut state,
            "upload_artifact",
            json!({
                "filePath": fw_path.to_str().unwrap(),
                "target": "remote::lab-bench"
            }),
        )
        .await;
        assert_eq!(upload_res["isError"], false);
        assert_eq!(*uploaded.lock().unwrap(), fw_bytes);
        let art_json: Value =
            serde_json::from_str(upload_res["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(art_json["artifactId"], "art-77");

        // 4. invoke_plugin_tool sync
        let sync_res = execute_tool(
            &mut state,
            "invoke_plugin_tool",
            json!({
                "pluginId": "com.acme.diag",
                "tool": "probe",
                "args": { "portId": "COM9" }
            }),
        )
        .await;
        assert_eq!(sync_res["isError"], false);
        assert!(sync_res["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("STM32H7"));

        // 5. invoke_plugin_tool job with wait=true polls until completed and merges events
        let wait_res = execute_tool(
            &mut state,
            "invoke_plugin_tool",
            json!({
                "pluginId": "org.vendor.stm32-flasher",
                "tool": "flash",
                "target": "remote::lab-bench",
                "args": { "portId": "COM3" },
                "artifacts": ["art-77"],
                "wait": true
            }),
        )
        .await;
        assert_eq!(wait_res["isError"], false);
        let wait_json: Value =
            serde_json::from_str(wait_res["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(wait_json["state"], "completed");
        assert_eq!(wait_json["events"].as_array().unwrap().len(), 2);

        // 6. invoke_plugin_tool failed job returns isError: true
        let fail_res = execute_tool(
            &mut state,
            "invoke_plugin_tool",
            json!({
                "pluginId": "fail-plugin",
                "tool": "burn",
                "wait": true
            }),
        )
        .await;
        assert_eq!(fail_res["isError"], true);
        assert!(fail_res["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("verify_failed"));

        // 7. poll_plugin_job and cancel_plugin_job
        let poll_res = execute_tool(
            &mut state,
            "poll_plugin_job",
            json!({ "jobId": "job-flash-1", "afterSeq": 0 }),
        )
        .await;
        assert_eq!(poll_res["isError"], false);

        let cancel_res = execute_tool(
            &mut state,
            "cancel_plugin_job",
            json!({ "jobId": "job-flash-1" }),
        )
        .await;
        assert_eq!(cancel_res["isError"], false);
        assert!(cancel_res["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("cancelled"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
