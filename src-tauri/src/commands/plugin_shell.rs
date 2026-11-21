//! Native plugin `shell.execute` command.
//!
//! Admission is deliberately separate from process execution: a short-lived plugin IO
//! gate protects the authorization/spawn boundary, while the registry cancellation token
//! remains live for the whole child process.  We never use `wait_with_output`; the Child
//! handle is kept until timeout/cancellation/stream failure has killed and waited it.

use std::collections::HashMap;
use std::future::{pending, Future};
use std::process::{ExitStatus, Stdio};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{State, WebviewWindow};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::watch;

use super::CommandError;
use crate::plugin;
use crate::AppState;

#[path = "plugin_shell_tasks.rs"]
mod tasks;
pub use tasks::*;

/// Wire request for native process execution. Unknown fields are rejected so a caller
/// cannot accidentally believe an unimplemented process option was applied.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginShellRequest {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// Environment entries override inherited variables; absent entries inherit unchanged.
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    /// Optional UTF-8 stdin; omitted means a closed/null stdin pipe.
    #[serde(default)]
    pub stdin: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginShellResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

struct ShellEntry {
    plugin_id: String,
    cancel_tx: watch::Sender<bool>,
}

/// Process admission registry.  The map only holds cancellation metadata; Child and
/// pipe handles stay owned by the executing command so cancellation can kill+wait them
/// without sharing a Child mutex across unrelated lifecycle calls.
pub struct PluginShellRegistry {
    entries: Mutex<HashMap<u64, Arc<ShellEntry>>>,
    next_id: AtomicU64,
    process_sessions: tasks::ProcessSessions,
}

impl PluginShellRegistry {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            process_sessions: tasks::ProcessSessions::default(),
        }
    }

    fn admit(&self, plugin_id: &str, _generation: &str) -> Result<Arc<ShellEntry>, CommandError> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|error| CommandError::Lock(error.to_string()))?;
        let (cancel_tx, _) = watch::channel(false);
        let entry = Arc::new(ShellEntry {
            plugin_id: plugin_id.to_owned(),
            cancel_tx,
        });
        let mut id = self.next_id.fetch_add(1, Ordering::Relaxed);
        // The counter is practically impossible to wrap, but do not overwrite a live
        // entry if a test or a long-running process ever reaches the boundary.
        while entries.contains_key(&id) {
            id = self.next_id.fetch_add(1, Ordering::Relaxed);
        }
        entries.insert(id, entry.clone());
        Ok(entry)
    }

    fn remove_if_matches(&self, entry: &Arc<ShellEntry>) {
        if let Ok(mut entries) = self.entries.lock() {
            let id = entries
                .iter()
                .find_map(|(id, current)| Arc::ptr_eq(current, entry).then_some(*id));
            if let Some(id) = id {
                entries.remove(&id);
            }
        }
    }

    /// Cancel all queued/running executions for one plugin.  This is called while the
    /// plugin IO gate is held by disable/revoke/uninstall/reload/replace operations.
    /// Entries stay registered until the command's AdmissionGuard has killed/waited
    /// its Child (or observed the queued cancellation), so a lifecycle transition
    /// cannot race a still-live execution during registry cleanup.
    pub fn cancel_plugin(&self, plugin_id: &str) {
        self.process_sessions.retire(Some(plugin_id));
        if let Ok(entries) = self.entries.lock() {
            for entry in entries
                .values()
                .filter(|entry| entry.plugin_id == plugin_id)
            {
                entry.cancel_tx.send_replace(true);
            }
        }
    }

    /// Configuration restore can alter every plugin identity/permission at once.
    pub fn cancel_all(&self) {
        self.process_sessions.retire(None);
        if let Ok(entries) = self.entries.lock() {
            for entry in entries.values() {
                entry.cancel_tx.send_replace(true);
            }
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries
            .lock()
            .map(|entries| entries.len())
            .unwrap_or(usize::MAX)
    }
}

struct AdmissionGuard<'a> {
    registry: &'a PluginShellRegistry,
    entry: Arc<ShellEntry>,
}

impl Drop for AdmissionGuard<'_> {
    fn drop(&mut self) {
        self.registry.remove_if_matches(&self.entry);
    }
}

fn validate_generation(expected_generation: &str) -> Result<(), CommandError> {
    if expected_generation.is_empty() {
        Err(CommandError::Other(
            "插件安装版本已变化，请重新检查插件后操作".into(),
        ))
    } else {
        Ok(())
    }
}

fn validate_program(value: &str) -> Result<(), CommandError> {
    if value.is_empty() {
        return Err(CommandError::Other("shell.execute program 不能为空".into()));
    }
    if value.contains('\0') {
        return Err(CommandError::Other(
            "shell.execute program 不得含 NUL".into(),
        ));
    }
    Ok(())
}

fn validate_request(request: &PluginShellRequest) -> Result<Option<Instant>, CommandError> {
    validate_program(&request.program)?;
    for argument in &request.args {
        if argument.contains('\0') {
            return Err(CommandError::Other("shell.execute 参数不得含 NUL".into()));
        }
    }
    for (name, value) in &request.env {
        if name.is_empty() || name.contains('=') || name.contains('\0') || value.contains('\0') {
            return Err(CommandError::Other(
                "shell.execute 环境变量名不得为空、含 = 或 NUL，值不得含 NUL".into(),
            ));
        }
    }
    if let Some(cwd) = request.cwd.as_deref() {
        if cwd.contains('\0') {
            return Err(CommandError::Other("shell.execute cwd 不得含 NUL".into()));
        }
    }
    match request.timeout_ms {
        None | Some(0) => Ok(None),
        Some(milliseconds) => Instant::now()
            .checked_add(Duration::from_millis(milliseconds))
            .map(Some)
            .ok_or_else(|| CommandError::Other("shell.execute timeout 超出本机可表示范围".into())),
    }
}

fn require_shell_access(
    state: &AppState,
    plugin_id: &str,
    expected_generation: &str,
) -> Result<(), CommandError> {
    validate_generation(expected_generation)?;
    let manager = state
        .config_manager
        .lock()
        .map_err(|error| CommandError::Lock(error.to_string()))?;
    let entry = manager
        .get_config()
        .entities
        .plugin_configs
        .iter()
        .find(|entry| entry.id == plugin_id)
        .ok_or_else(|| CommandError::Other(format!("插件未安装: {plugin_id}")))?;
    if entry.install_generation != expected_generation {
        return Err(CommandError::Other(
            "插件安装版本已变化，请重新检查插件后操作".into(),
        ));
    }
    if !entry.enabled {
        return Err(CommandError::Other(format!("插件未启用: {plugin_id}")));
    }
    if !entry
        .granted_permissions
        .iter()
        .any(|permission| permission == "shell:execute")
    {
        return Err(CommandError::Other(format!(
            "插件未授予 shell:execute 权限: {plugin_id}"
        )));
    }
    Ok(())
}

fn spawn_child(request: &PluginShellRequest) -> Result<Child, CommandError> {
    spawn_child_with_output(request, Stdio::piped(), Stdio::piped())
}

fn spawn_child_with_output(
    request: &PluginShellRequest,
    stdout: Stdio,
    stderr: Stdio,
) -> Result<Child, CommandError> {
    let mut command = Command::new(&request.program);
    command
        .args(&request.args)
        .stdin(if request.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(stdout)
        .stderr(stderr);
    if let Some(cwd) = request.cwd.as_deref() {
        command.current_dir(cwd);
    }
    command.envs(&request.env);
    command.kill_on_drop(true);
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
        .spawn()
        .map_err(|error| CommandError::Io(format!("启动 shell.execute 程序失败: {error}")))
}

#[derive(Debug)]
enum ReaderFailure {
    Io(&'static str, String),
}

async fn read_output<R: AsyncRead + Unpin>(
    mut reader: R,
    stream: &'static str,
) -> Result<Vec<u8>, ReaderFailure> {
    let mut output = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        let read = reader
            .read(&mut chunk)
            .await
            .map_err(|error| ReaderFailure::Io(stream, error.to_string()))?;
        if read == 0 {
            return Ok(output);
        }
        output.extend_from_slice(&chunk[..read]);
    }
}

async fn wait_cancel(rx: &mut watch::Receiver<bool>) {
    if *rx.borrow() {
        return;
    }
    let _ = rx.changed().await;
}

async fn kill_and_wait(child: &mut Child) -> Result<(), CommandError> {
    // Ignore kill's NotFound/race error: wait still reaps the direct child and is the
    // important handle-lifetime guarantee.  Any wait error remains observable.
    let _ = child.kill().await;
    child
        .wait()
        .await
        .map(|_| ())
        .map_err(|error| CommandError::Io(format!("等待 shell.execute 子进程结束失败: {error}")))
}

#[derive(Debug)]
struct ProcessOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

async fn write_stdin(mut input: tokio::process::ChildStdin, bytes: Vec<u8>) -> Result<(), String> {
    if let Err(error) = input.write_all(&bytes).await {
        // A child is allowed to close stdin before consuming all supplied text.
        // Treat BrokenPipe as normal early termination; report all other IO errors.
        if error.kind() != std::io::ErrorKind::BrokenPipe {
            return Err(error.to_string());
        }
    }
    if let Err(error) = input.shutdown().await {
        if error.kind() != std::io::ErrorKind::BrokenPipe {
            return Err(error.to_string());
        }
    }
    Ok(())
}

enum ExecutionStop<T> {
    Cancelled,
    TimedOut,
    Finished(Result<(ExitStatus, T, ()), ReaderFailure>),
}

#[derive(Debug)]
enum ProcessFailure {
    Cancelled,
    TimedOut,
    Io(CommandError),
}

async fn finish_process<T, F, R>(
    mut child: Child,
    timeout_deadline: Option<Instant>,
    cancelled: impl Future<Output = ()>,
    stdin_text: Option<String>,
    read_pipes: F,
) -> Result<(ExitStatus, T), ProcessFailure>
where
    F: FnOnce(Option<tokio::process::ChildStdout>, Option<tokio::process::ChildStderr>) -> R,
    R: Future<Output = Result<T, ReaderFailure>>,
{
    let readers = read_pipes(child.stdout.take(), child.stderr.take());
    let stdin_pipe = child.stdin.take();
    let stdin_bytes = stdin_text.map(String::into_bytes);

    // Drop pipe futures before borrowing Child again to kill and reap it. A
    // blocked writer or output sink must never keep cancellation from advancing.
    let stop = {
        let execution = async {
            let wait = async {
                child
                    .wait()
                    .await
                    .map_err(|error| ReaderFailure::Io("子进程", error.to_string()))
            };
            let input = async move {
                match (stdin_pipe, stdin_bytes) {
                    (Some(pipe), Some(bytes)) => write_stdin(pipe, bytes)
                        .await
                        .map_err(|error| ReaderFailure::Io("stdin", error)),
                    _ => Ok(()),
                }
            };
            tokio::try_join!(wait, readers, input)
        };
        let timeout = async {
            if let Some(deadline) = timeout_deadline {
                tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
            } else {
                pending::<()>().await;
            }
        };
        tokio::select! {
            biased;
            _ = cancelled => ExecutionStop::Cancelled,
            _ = timeout => ExecutionStop::TimedOut,
            result = execution => ExecutionStop::Finished(result),
        }
    };

    let failure = match stop {
        ExecutionStop::Cancelled => ProcessFailure::Cancelled,
        ExecutionStop::TimedOut => ProcessFailure::TimedOut,
        ExecutionStop::Finished(Ok((status, output, ()))) => return Ok((status, output)),
        ExecutionStop::Finished(Err(ReaderFailure::Io(stream, message))) => ProcessFailure::Io(
            CommandError::Io(format!("shell.execute {stream} IO 失败: {message}")),
        ),
    };
    kill_and_wait(&mut child)
        .await
        .map_err(ProcessFailure::Io)?;
    Err(failure)
}

async fn run_child(
    child: Child,
    timeout_deadline: Option<Instant>,
    cancel_rx: &mut watch::Receiver<bool>,
    stdin_text: Option<String>,
) -> Result<ProcessOutput, CommandError> {
    let (status, (stdout, stderr)) = finish_process(
        child,
        timeout_deadline,
        wait_cancel(cancel_rx),
        stdin_text,
        |stdout, stderr| async move {
            let stdout = stdout.ok_or_else(|| ReaderFailure::Io("stdout", "pipe 不可用".into()))?;
            let stderr = stderr.ok_or_else(|| ReaderFailure::Io("stderr", "pipe 不可用".into()))?;
            tokio::try_join!(read_output(stdout, "stdout"), read_output(stderr, "stderr"))
        },
    )
    .await
    .map_err(|failure| match failure {
        ProcessFailure::Cancelled => CommandError::Other("插件 shell 执行已取消".into()),
        ProcessFailure::TimedOut => CommandError::Other("插件 shell 执行超时".into()),
        ProcessFailure::Io(error) => error,
    })?;
    Ok(ProcessOutput {
        status,
        stdout,
        stderr,
    })
}

#[tauri::command]
pub async fn plugin_shell_execute(
    plugin_id: String,
    expected_generation: String,
    request: PluginShellRequest,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginShellResult, CommandError> {
    super::plugin::require_main_window(&window)?;
    plugin::validate_plugin_id(&plugin_id).map_err(CommandError::Other)?;
    let timeout_deadline = validate_request(&request)?;
    validate_generation(&expected_generation)?;

    // Register before waiting for plugin_io. Lifecycle operations hold the same gate
    // while cancelling, so a reload/disable already in progress can cancel a queued
    // shell request instead of allowing it to spawn after the lifecycle transition.
    let entry = state.plugin_shell.admit(&plugin_id, &expected_generation)?;
    let _admission = AdmissionGuard {
        registry: &state.plugin_shell,
        entry: entry.clone(),
    };
    let mut cancel_rx = entry.cancel_tx.subscribe();
    let gate_future = super::plugin::acquire_plugin_io(&state);
    tokio::pin!(gate_future);
    let plugin_io = tokio::select! {
        biased;
        _ = wait_cancel(&mut cancel_rx) => {
            return Err(CommandError::Other("插件 shell 执行已取消".into()));
        }
        gate = &mut gate_future => gate?,
    };
    if *cancel_rx.borrow() {
        drop(plugin_io);
        return Err(CommandError::Other("插件 shell 执行已取消".into()));
    }
    // Authorization and actual spawn are both inside the short gate section.
    require_shell_access(&state, &plugin_id, &expected_generation)?;
    if *cancel_rx.borrow() {
        drop(plugin_io);
        return Err(CommandError::Other("插件 shell 执行已取消".into()));
    }
    let child = spawn_child(&request)?;
    drop(plugin_io);

    let output = run_child(
        child,
        timeout_deadline,
        &mut cancel_rx,
        request.stdin.clone(),
    )
    .await?;
    if *cancel_rx.borrow() {
        return Err(CommandError::Other("插件 shell 执行已取消".into()));
    }
    // Never deliver output from a process whose plugin was disabled/revoked/reloaded
    // while it was running.  This also rechecks generation and grant state.
    require_shell_access(&state, &plugin_id, &expected_generation)?;
    if *cancel_rx.borrow() {
        return Err(CommandError::Other("插件 shell 执行已取消".into()));
    }
    Ok(PluginShellResult {
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_request() -> PluginShellRequest {
        PluginShellRequest {
            program: "tool".into(),
            args: vec!["--flag".into()],
            cwd: None,
            env: HashMap::new(),
            stdin: None,
            timeout_ms: None,
        }
    }

    #[test]
    fn request_shape_nul_timeout_and_unknown_fields_are_strict() {
        let request: PluginShellRequest = serde_json::from_value(serde_json::json!({
            "program": "relative/tool", "args": ["--x"], "env": {"X": "Y"},
            "stdin": "input", "timeoutMs": 1
        }))
        .unwrap();
        assert_eq!(request.timeout_ms, Some(1));
        assert_eq!(request.stdin.as_deref(), Some("input"));
        assert!(validate_request(&PluginShellRequest {
            stdin: Some("a\0b".into()),
            ..valid_request()
        })
        .is_ok());
        assert!(
            serde_json::from_value::<PluginShellRequest>(serde_json::json!({
                "program": "tool", "shell": true
            }))
            .is_err()
        );
        assert!(validate_request(&PluginShellRequest {
            program: "tool\0".into(),
            ..valid_request()
        })
        .is_err());
        assert!(validate_request(&PluginShellRequest {
            program: "tool".into(),
            env: HashMap::from([(String::new(), "x".into())]),
            ..valid_request()
        })
        .is_err());
        assert!(validate_request(&PluginShellRequest {
            program: "tool".into(),
            timeout_ms: Some(0),
            ..valid_request()
        })
        .unwrap()
        .is_none());
        assert!(validate_request(&PluginShellRequest {
            program: "relative/tool".into(),
            cwd: Some("relative/cwd".into()),
            ..valid_request()
        })
        .is_ok());
    }

    #[test]
    fn program_is_native_shape_only_and_registry_cancel_retains_entry() {
        assert!(validate_program("tool").is_ok());
        assert!(validate_program("relative/tool").is_ok());
        assert!(validate_program("./tool").is_ok());
        assert!(validate_program("tool.cmd").is_ok());
        let registry = PluginShellRegistry::new();
        let entry = registry.admit("com.example.test", "g").unwrap();
        let receiver = entry.cancel_tx.subscribe();
        registry.cancel_plugin("com.example.test");
        assert!(*receiver.borrow());
        assert_eq!(registry.len(), 1);
        registry.remove_if_matches(&entry);
        assert_eq!(registry.len(), 0);
    }

    async fn test_child(
        program: &str,
        args: &[&str],
        timeout: Option<Duration>,
    ) -> Result<ProcessOutput, CommandError> {
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let child = command.spawn().unwrap();
        let (_cancel_tx, mut cancel_rx) = watch::channel(false);
        let deadline = timeout.and_then(|duration| Instant::now().checked_add(duration));
        run_child(child, deadline, &mut cancel_rx, None).await
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn actual_process_captures_both_streams_and_exit_code() {
        let output = test_child(
            "sh",
            &["-c", "printf out; printf err >&2; exit 7"],
            Some(Duration::from_secs(2)),
        )
        .await
        .unwrap();
        assert_eq!(output.status.code(), Some(7));
        assert_eq!(output.stdout, b"out");
        assert_eq!(output.stderr, b"err");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn env_is_inherited_and_stdin_is_written_concurrently() {
        let request = PluginShellRequest {
            program: "sh".into(),
            args: vec!["-c".into(), "printf '%s' \"$TEST_SHELL_ENV\"; cat".into()],
            cwd: None,
            env: HashMap::from([("TEST_SHELL_ENV".into(), "env:".into())]),
            stdin: Some("input".into()),
            timeout_ms: None,
        };
        let child = spawn_child(&request).unwrap();
        let (_cancel_tx, mut cancel_rx) = watch::channel(false);
        let output = run_child(child, None, &mut cancel_rx, request.stdin.clone())
            .await
            .unwrap();
        assert_eq!(output.stdout, b"env:input");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn actual_process_captures_both_streams_and_exit_code() {
        let output = test_child(
            "cmd",
            &["/C", "<nul set /p=out & <nul set /p=err 1>&2 & exit /B 7"],
            Some(Duration::from_secs(2)),
        )
        .await
        .unwrap();
        assert_eq!(output.status.code(), Some(7));
        assert!(output.stdout.starts_with(b"out"));
        assert!(output.stderr.starts_with(b"err"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_env_is_inherited_and_stdin_is_written_concurrently() {
        let request = PluginShellRequest {
            program: "powershell.exe".into(),
            args: vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "[Console]::Out.Write($env:TEST_SHELL_ENV + [Console]::In.ReadToEnd())".into(),
            ],
            cwd: None,
            env: HashMap::from([("TEST_SHELL_ENV".into(), "env:".into())]),
            stdin: Some("input".into()),
            timeout_ms: Some(10_000),
        };
        let child = spawn_child(&request).unwrap();
        let (_cancel_tx, mut cancel_rx) = watch::channel(false);
        let deadline = Instant::now().checked_add(Duration::from_secs(10));
        let output = run_child(child, deadline, &mut cancel_rx, request.stdin.clone())
            .await
            .unwrap();
        assert_eq!(output.stdout, b"env:input");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_kills_and_waits_direct_child() {
        let error = test_child("sh", &["-c", "sleep 10"], Some(Duration::from_millis(25)))
            .await
            .unwrap_err();
        assert!(matches!(error, CommandError::Other(message) if message.contains("超时")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_kills_direct_child() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 10"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = command.spawn().unwrap();
        let (cancel_tx, mut cancel_rx) = watch::channel(false);
        let deadline = Instant::now().checked_add(Duration::from_secs(5));
        let task =
            tokio::spawn(async move { run_child(child, deadline, &mut cancel_rx, None).await });
        tokio::time::sleep(Duration::from_millis(25)).await;
        cancel_tx.send_replace(true);
        let error = task.await.unwrap().unwrap_err();
        assert!(matches!(error, CommandError::Other(message) if message.contains("取消")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn output_is_not_business_capped() {
        let output = test_child(
            "sh",
            &["-c", "head -c 4194305 /dev/zero"],
            Some(Duration::from_secs(3)),
        )
        .await
        .unwrap();
        assert_eq!(output.stdout.len(), 4 * 1024 * 1024 + 1);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_timeout_kills_and_waits_direct_child() {
        let error = test_child(
            "powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 10",
            ],
            Some(Duration::from_millis(25)),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, CommandError::Other(message) if message.contains("超时")));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_cancellation_kills_direct_child() {
        let mut command = Command::new("powershell.exe");
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 10",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let child = command.spawn().unwrap();
        let (cancel_tx, mut cancel_rx) = watch::channel(false);
        let deadline = Instant::now().checked_add(Duration::from_secs(5));
        let task =
            tokio::spawn(async move { run_child(child, deadline, &mut cancel_rx, None).await });
        tokio::time::sleep(Duration::from_millis(25)).await;
        cancel_tx.send_replace(true);
        let error = task.await.unwrap().unwrap_err();
        assert!(matches!(error, CommandError::Other(message) if message.contains("取消")));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_output_is_not_business_capped() {
        let output = test_child(
            "powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::Out.Write('x' * 4194305)",
            ],
            Some(Duration::from_secs(10)),
        )
        .await
        .unwrap();
        assert_eq!(output.stdout.len(), 4 * 1024 * 1024 + 1);
    }
}
