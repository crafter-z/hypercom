//! Pull-based stdout/stderr for explicitly started Worker shell tasks. Each pipe
//! has its own bounded queue and one reader; cancellation is independent of both.
use super::{
    finish_process, plugin, require_shell_access, spawn_child_with_output, validate_request,
    wait_cancel, AppState, AsyncRead, AsyncReadExt, Child, CommandError, HashMap, Instant, Mutex,
    PluginShellRequest, ProcessFailure, ReaderFailure, Serialize, State, Stdio, WebviewWindow,
};
use base64::Engine as _;
use serde::Deserialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::{mpsc, watch, Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

// Transport reservations, not command/output quotas. Legacy execute does not
// spend these slots; a retired-but-still-reaping process retains its reservation.
const MAX_PROCESS_SESSIONS: usize = 128;
const MAX_SHELL_TASKS: usize = 64;
const MAX_TASKS_PER_SESSION: usize = 8;
const CHUNK_BYTES: usize = 16 * 1024;
const BUFFER_CHUNKS: usize = 2;

type OutputChunk = Box<[u8]>;
type OutputTx = mpsc::Sender<OutputChunk>;

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum OutputMode {
    #[default]
    Pipe,
    Discard,
}
impl OutputMode {
    fn stdio(self) -> Stdio {
        match self {
            Self::Pipe => Stdio::piped(),
            Self::Discard => Stdio::null(),
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginShellOutputOptions {
    stdout: OutputMode,
    stderr: OutputMode,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginShellStream {
    Stdout,
    Stderr,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ProcessPhase {
    Running,
    Cancelling,
    Exited,
    Cancelled,
    TimedOut,
    Failed,
}
impl ProcessPhase {
    fn terminal(self) -> bool {
        !matches!(self, Self::Running | Self::Cancelling)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginShellTaskStatus {
    state: ProcessPhase,
    exit_code: Option<i32>,
    error: Option<String>,
}
impl PluginShellTaskStatus {
    fn new(state: ProcessPhase) -> Self {
        Self {
            state,
            exit_code: None,
            error: None,
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PluginShellRead {
    Chunk { base64: String },
    Eof,
}

struct ProcessTask {
    stdout: AsyncMutex<mpsc::Receiver<OutputChunk>>,
    stderr: AsyncMutex<mpsc::Receiver<OutputChunk>>,
    cancel: watch::Sender<bool>,
    status: watch::Sender<PluginShellTaskStatus>,
    waiter: AsyncMutex<()>,
    released: AtomicBool,
    _permit: OwnedSemaphorePermit,
}
impl ProcessTask {
    fn snapshot(&self) -> PluginShellTaskStatus {
        self.status.borrow().clone()
    }

    fn request_cancel(&self) -> PluginShellTaskStatus {
        let requested = self.status.send_if_modified(|status| {
            if status.state != ProcessPhase::Running {
                return false;
            }
            status.state = ProcessPhase::Cancelling;
            true
        });
        if requested || self.snapshot().state == ProcessPhase::Cancelling {
            self.cancel.send_replace(true);
        }
        self.snapshot()
    }

    fn require_retained(&self) -> Result<(), CommandError> {
        if self.released.load(Ordering::Acquire) {
            return Err(inactive_task());
        }
        Ok(())
    }

    async fn read(
        &self,
        session: &ProcessSession,
        stream: PluginShellStream,
    ) -> Result<Option<OutputChunk>, CommandError> {
        let receiver = match stream {
            PluginShellStream::Stdout => &self.stdout,
            PluginShellStream::Stderr => &self.stderr,
        };
        let mut receiver = receiver
            .try_lock()
            .map_err(|_| other("当前 shell 输出流已有读取请求"))?;
        let mut retired = session.retired.subscribe();
        let mut cancelled = self.cancel.subscribe();
        tokio::select! {
            biased;
            _ = wait_cancel(&mut retired) => Err(inactive_session()),
            _ = wait_cancel(&mut cancelled) => Ok(None),
            chunk = receiver.recv() => Ok(chunk),
        }
    }

    async fn wait(&self, session: &ProcessSession) -> Result<PluginShellTaskStatus, CommandError> {
        let _waiter = self
            .waiter
            .try_lock()
            .map_err(|_| other("该 shell 任务已有等待请求"))?;
        let mut retired = session.retired.subscribe();
        let mut status = self.status.subscribe();
        tokio::select! {
            biased;
            _ = wait_cancel(&mut retired) => Err(inactive_session()),
            result = status.wait_for(|status| status.state.terminal()) => {
                result.map(|current| current.clone()).map_err(|_| inactive_task())
            }
        }
    }
}

struct SessionTasks {
    tasks: HashMap<Uuid, Arc<ProcessTask>>,
    retired: bool,
}
struct ProcessSession {
    plugin_id: String,
    generation: String,
    inner: Mutex<SessionTasks>,
    retired: watch::Sender<bool>,
}
impl ProcessSession {
    fn owns(&self, plugin_id: &str, generation: &str) -> bool {
        self.plugin_id == plugin_id && self.generation == generation
    }

    fn require_live(&self) -> Result<(), CommandError> {
        if *self.retired.borrow() {
            return Err(inactive_session());
        }
        Ok(())
    }

    fn retire(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            // The same short lock surrounds spawn; a retired token cannot spawn
            // later even if a queued start previously acquired the session Arc.
            inner.retired = true;
            self.retired.send_replace(true);
            inner.tasks.clear();
        }
    }

    fn admit(self: &Arc<Self>, slots: &Arc<Semaphore>) -> Result<Admission, CommandError> {
        let mut inner = self.inner.lock().map_err(lock_error)?;
        if inner.retired {
            return Err(inactive_session());
        }
        if inner.tasks.len() >= MAX_TASKS_PER_SESSION {
            return Err(other("该 Worker 的 shell 流任务槽已满"));
        }
        let permit = slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| other("shell 流任务槽已满"))?;
        let (stdout_tx, stdout) = mpsc::channel(BUFFER_CHUNKS);
        let (stderr_tx, stderr) = mpsc::channel(BUFFER_CHUNKS);
        let (cancel, _) = watch::channel(false);
        let (status, _) = watch::channel(PluginShellTaskStatus::new(ProcessPhase::Running));
        let task = Arc::new(ProcessTask {
            stdout: AsyncMutex::new(stdout),
            stderr: AsyncMutex::new(stderr),
            cancel,
            status,
            waiter: AsyncMutex::new(()),
            released: AtomicBool::new(false),
            _permit: permit,
        });
        let id = unused_id(&inner.tasks);
        inner.tasks.insert(id, task.clone());
        Ok(Admission {
            session: self.clone(),
            id,
            task,
            pipes: Some((stdout_tx, stderr_tx)),
        })
    }

    fn spawn(
        &self,
        request: &PluginShellRequest,
        options: PluginShellOutputOptions,
    ) -> Result<Child, CommandError> {
        let inner = self.inner.lock().map_err(lock_error)?;
        if inner.retired {
            return Err(inactive_session());
        }
        spawn_child_with_output(request, options.stdout.stdio(), options.stderr.stdio())
    }

    fn lookup(&self, id: Uuid) -> Result<Option<Arc<ProcessTask>>, CommandError> {
        let inner = self.inner.lock().map_err(lock_error)?;
        if inner.retired {
            return Err(inactive_session());
        }
        Ok(inner.tasks.get(&id).cloned())
    }

    fn remove(&self, id: Uuid) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.tasks.remove(&id);
        }
    }

    fn release(&self, id: Uuid) -> Result<(), CommandError> {
        if let Some(task) = self.lookup(id)? {
            task.released.store(true, Ordering::Release);
            if task.request_cancel().state.terminal() {
                self.remove(id);
            }
            // For a still-running task, the runner keeps its global reservation
            // through reaping, and removes the released entry on termination.
        }
        Ok(())
    }
}

pub(super) struct ProcessSessions {
    sessions: Mutex<HashMap<Uuid, Arc<ProcessSession>>>,
    slots: Arc<Semaphore>,
}
impl Default for ProcessSessions {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(MAX_SHELL_TASKS)),
        }
    }
}
impl ProcessSessions {
    fn open(&self, plugin_id: String, generation: String) -> Result<Uuid, CommandError> {
        let mut sessions = self.sessions.lock().map_err(lock_error)?;
        if sessions.len() >= MAX_PROCESS_SESSIONS {
            return Err(other("shell 流会话槽已满"));
        }
        let id = unused_id(&sessions);
        let (retired, _) = watch::channel(false);
        sessions.insert(
            id,
            Arc::new(ProcessSession {
                plugin_id,
                generation,
                retired,
                inner: Mutex::new(SessionTasks {
                    tasks: HashMap::new(),
                    retired: false,
                }),
            }),
        );
        Ok(id)
    }

    fn lookup(
        &self,
        id: Uuid,
        plugin_id: &str,
        generation: &str,
    ) -> Result<Arc<ProcessSession>, CommandError> {
        let sessions = self.sessions.lock().map_err(lock_error)?;
        sessions
            .get(&id)
            .filter(|session| session.owns(plugin_id, generation))
            .cloned()
            .ok_or_else(inactive_session)
    }

    fn close(&self, id: Uuid, plugin_id: &str, generation: &str) -> Result<(), CommandError> {
        let mut sessions = self.sessions.lock().map_err(lock_error)?;
        if let Some(session) = sessions.get(&id) {
            if !session.owns(plugin_id, generation) {
                return Err(inactive_session());
            }
            session.retire();
            sessions.remove(&id);
        }
        Ok(())
    }

    pub(super) fn retire(&self, plugin_id: Option<&str>) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.retain(|_, session| {
                if plugin_id.is_none_or(|id| id == session.plugin_id) {
                    session.retire();
                    false
                } else {
                    true
                }
            });
        }
    }
}

fn other(message: &str) -> CommandError {
    CommandError::Other(message.into())
}
fn lock_error<T>(error: std::sync::PoisonError<T>) -> CommandError {
    CommandError::Lock(error.to_string())
}
fn inactive_session() -> CommandError {
    other("PLUGIN_SHELL_SESSION_INACTIVE: shell 流会话已失效")
}
fn inactive_task() -> CommandError {
    other("shell 流任务已失效")
}
fn parse_id(id: &str) -> Result<Uuid, CommandError> {
    Uuid::parse_str(id).map_err(|_| other("shell 流会话或任务标识无效"))
}
fn unused_id<T>(entries: &HashMap<Uuid, T>) -> Uuid {
    loop {
        let id = Uuid::new_v4();
        if !entries.contains_key(&id) {
            return id;
        }
    }
}

struct Admission {
    session: Arc<ProcessSession>,
    id: Uuid,
    task: Arc<ProcessTask>,
    pipes: Option<(OutputTx, OutputTx)>,
}
impl Admission {
    fn run(
        mut self,
        child: Child,
        deadline: Option<Instant>,
        stdin: Option<String>,
    ) -> impl std::future::Future<Output = ()> {
        let pipes = self
            .pipes
            .take()
            .expect("process pipes are transferred once");
        run_task(
            self.session.clone(),
            self.id,
            self.task.clone(),
            child,
            deadline,
            stdin,
            pipes,
        )
    }
}
impl Drop for Admission {
    fn drop(&mut self) {
        // Start failure or a cancelled command before spawn: no abandoned task.
        if self.pipes.is_some() {
            self.session.remove(self.id);
        }
    }
}

async fn push_pipe<R: AsyncRead + Unpin>(
    reader: Option<R>,
    name: &'static str,
    tx: OutputTx,
) -> Result<(), ReaderFailure> {
    let Some(mut pipe) = reader else {
        return Ok(());
    }; // intentionally discarded stdio
    let mut bytes = [0; CHUNK_BYTES];
    loop {
        // No more than BUFFER_CHUNKS buffered packets per pipe. Waiting for
        // capacity backpressures the OS pipe instead of gathering whole output.
        let slot = tx
            .reserve()
            .await
            .map_err(|_| ReaderFailure::Io(name, "输出接收端已关闭".into()))?;
        let count = pipe
            .read(&mut bytes)
            .await
            .map_err(|error| ReaderFailure::Io(name, error.to_string()))?;
        if count == 0 {
            return Ok(());
        }
        slot.send(bytes[..count].into());
    }
}

async fn run_task(
    session: Arc<ProcessSession>,
    id: Uuid,
    task: Arc<ProcessTask>,
    child: Child,
    deadline: Option<Instant>,
    stdin: Option<String>,
    pipes: (OutputTx, OutputTx),
) {
    let (stdout, stderr) = pipes;
    let mut retired = session.retired.subscribe();
    let mut cancelled = task.cancel.subscribe();
    let stop = async {
        tokio::select! {
            _ = wait_cancel(&mut retired) => (),
            _ = wait_cancel(&mut cancelled) => (),
        }
    };
    let result = finish_process(child, deadline, stop, stdin, |out, err| async move {
        tokio::try_join!(
            push_pipe(out, "stdout", stdout),
            push_pipe(err, "stderr", stderr)
        )
    })
    .await;
    let terminal = match result {
        Ok((exit, ((), ()))) => PluginShellTaskStatus {
            exit_code: exit.code(),
            ..PluginShellTaskStatus::new(ProcessPhase::Exited)
        },
        Err(ProcessFailure::Cancelled) => PluginShellTaskStatus::new(ProcessPhase::Cancelled),
        Err(ProcessFailure::TimedOut) => PluginShellTaskStatus::new(ProcessPhase::TimedOut),
        Err(ProcessFailure::Io(error)) => PluginShellTaskStatus {
            error: Some(error.to_string()),
            ..PluginShellTaskStatus::new(ProcessPhase::Failed)
        },
    };
    task.status.send_modify(|status| {
        *status =
            if status.state == ProcessPhase::Cancelling && terminal.state != ProcessPhase::Failed {
                PluginShellTaskStatus::new(ProcessPhase::Cancelled)
            } else {
                terminal
            };
    });
    if task.released.load(Ordering::Acquire) {
        session.remove(id);
    }
}

fn authority(
    window: &WebviewWindow,
    state: &AppState,
    plugin_id: &str,
    generation: &str,
    session_id: &str,
) -> Result<Arc<ProcessSession>, CommandError> {
    super::super::plugin::require_main_window(window)?;
    require_shell_access(state, plugin_id, generation)?;
    state
        .plugin_shell
        .process_sessions
        .lookup(parse_id(session_id)?, plugin_id, generation)
}

#[tauri::command]
pub async fn plugin_shell_open_session(
    plugin_id: String,
    expected_generation: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    super::super::plugin::require_main_window(&window)?;
    plugin::validate_plugin_id(&plugin_id).map_err(CommandError::Other)?;
    let _gate = super::super::plugin::acquire_plugin_io(&state).await?;
    require_shell_access(&state, &plugin_id, &expected_generation)?;
    state
        .plugin_shell
        .process_sessions
        .open(plugin_id, expected_generation)
        .map(|id| id.to_string())
}

#[tauri::command]
pub async fn plugin_shell_start(
    plugin_id: String,
    expected_generation: String,
    session_id: String,
    request: PluginShellRequest,
    options: Option<PluginShellOutputOptions>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    let session = authority(
        &window,
        &state,
        &plugin_id,
        &expected_generation,
        &session_id,
    )?;
    let deadline = validate_request(&request)?;
    let admission = session.admit(&state.plugin_shell.process_sessions.slots)?;
    let task_id = admission.id;
    let mut retired = session.retired.subscribe();
    let gate = tokio::select! {
        biased;
        _ = wait_cancel(&mut retired) => return Err(inactive_session()),
        gate = super::super::plugin::acquire_plugin_io(&state) => gate?,
    };
    require_shell_access(&state, &plugin_id, &expected_generation)?;
    if deadline.is_some_and(|deadline| deadline <= Instant::now()) {
        return Err(other("插件 shell 启动前已超时"));
    }
    let child = session.spawn(&request, options.unwrap_or_default())?;
    drop(gate);
    tauri::async_runtime::spawn(admission.run(child, deadline, request.stdin));
    session.require_live()?;
    Ok(task_id.to_string())
}

#[tauri::command]
pub async fn plugin_shell_read(
    plugin_id: String,
    expected_generation: String,
    session_id: String,
    task_id: String,
    stream: PluginShellStream,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginShellRead, CommandError> {
    let session = authority(
        &window,
        &state,
        &plugin_id,
        &expected_generation,
        &session_id,
    )?;
    let task = session
        .lookup(parse_id(&task_id)?)?
        .ok_or_else(inactive_task)?;
    task.require_retained()?;
    let output = match task.read(&session, stream).await? {
        Some(bytes) => PluginShellRead::Chunk {
            base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        },
        None => PluginShellRead::Eof,
    };
    require_shell_access(&state, &plugin_id, &expected_generation)?;
    session.require_live()?;
    task.require_retained()?;
    if matches!(task.snapshot().state, ProcessPhase::Cancelling | ProcessPhase::Cancelled) {
        return Ok(PluginShellRead::Eof);
    }
    Ok(output)
}

#[tauri::command]
pub async fn plugin_shell_status(
    plugin_id: String,
    expected_generation: String,
    session_id: String,
    task_id: String,
    wait: bool,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginShellTaskStatus, CommandError> {
    let session = authority(
        &window,
        &state,
        &plugin_id,
        &expected_generation,
        &session_id,
    )?;
    let task = session
        .lookup(parse_id(&task_id)?)?
        .ok_or_else(inactive_task)?;
    task.require_retained()?;
    let current = if wait {
        task.wait(&session).await?
    } else {
        task.snapshot()
    };
    require_shell_access(&state, &plugin_id, &expected_generation)?;
    session.require_live()?;
    task.require_retained()?;
    Ok(current)
}

#[tauri::command]
pub fn plugin_shell_cancel(
    plugin_id: String,
    expected_generation: String,
    session_id: String,
    task_id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginShellTaskStatus, CommandError> {
    let session = authority(
        &window,
        &state,
        &plugin_id,
        &expected_generation,
        &session_id,
    )?;
    let task = session
        .lookup(parse_id(&task_id)?)?
        .ok_or_else(inactive_task)?;
    task.require_retained()?;
    let current = task.request_cancel();
    session.require_live()?;
    Ok(current)
}

#[tauri::command]
pub fn plugin_shell_release(
    plugin_id: String,
    expected_generation: String,
    session_id: String,
    task_id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let session = authority(
        &window,
        &state,
        &plugin_id,
        &expected_generation,
        &session_id,
    )?;
    session.release(parse_id(&task_id)?)
}

#[tauri::command]
pub fn plugin_shell_close_session(
    plugin_id: String,
    expected_generation: String,
    session_id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    // Cleanup can still reclaim an owned token after loss of authorization;
    // this operation never delivers status, output, or any fresh capability.
    super::super::plugin::require_main_window(&window)?;
    state.plugin_shell.process_sessions.close(
        parse_id(&session_id)?,
        &plugin_id,
        &expected_generation,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::PluginShellRegistry;
    use std::time::Duration;

    const PLUGIN: &str = "com.example.shell";
    const GEN: &str = "generation-a";
    const TEST_LIMIT: Duration = Duration::from_secs(10);

    #[cfg(windows)]
    fn local_program(unix: &str, windows: &str) -> PluginShellRequest {
        let _ = unix;
        request(
            "powershell.exe",
            &["-NoProfile", "-NonInteractive", "-Command", windows],
        )
    }
    #[cfg(not(windows))]
    fn local_program(unix: &str, windows: &str) -> PluginShellRequest {
        let _ = windows;
        request("sh", &["-c", unix])
    }
    fn request(program: &str, args: &[&str]) -> PluginShellRequest {
        PluginShellRequest {
            program: program.into(),
            args: args.iter().map(|arg| (*arg).into()).collect(),
            cwd: None,
            env: HashMap::new(),
            stdin: None,
            timeout_ms: None,
        }
    }
    fn new_session(registry: &ProcessSessions, id: &str) -> (Uuid, Arc<ProcessSession>) {
        let token = registry.open(id.to_string(), GEN.to_string()).unwrap();
        (token, registry.lookup(token, id, GEN).unwrap())
    }
    fn start(
        registry: &ProcessSessions,
        session: &Arc<ProcessSession>,
        request: PluginShellRequest,
        output: PluginShellOutputOptions,
        deadline: Option<Instant>,
    ) -> (Uuid, Arc<ProcessTask>, tokio::task::JoinHandle<()>) {
        let admission = session.admit(&registry.slots).unwrap();
        let (id, task) = (admission.id, admission.task.clone());
        let child = session.spawn(&request, output).unwrap();
        (
            id,
            task,
            tokio::spawn(admission.run(child, deadline, request.stdin)),
        )
    }
    async fn read_all(
        task: &ProcessTask,
        session: &ProcessSession,
        stream: PluginShellStream,
    ) -> Vec<u8> {
        let mut output = Vec::new();
        while let Some(bytes) = task.read(session, stream).await.unwrap() {
            output.extend_from_slice(&bytes);
        }
        output
    }

    #[tokio::test]
    async fn streaming_delivers_both_pipes_before_exit_and_only_cancels_target() {
        tokio::time::timeout(TEST_LIMIT, async {
            let registry = ProcessSessions::default();
            let (_, session) = new_session(&registry, PLUGIN);
            let continuous = local_program(
                "printf 'first-out'; printf 'first-err' >&2; while :; do :; done",
                "[Console]::Out.Write('first-out'); [Console]::Error.Write('first-err'); while ($true) { Start-Sleep -Milliseconds 40 }",
            );
            let (_, first, first_runner) = start(&registry, &session, continuous.clone(), Default::default(), None);
            let (_, second, second_runner) = start(&registry, &session, continuous, Default::default(), None);
            let (out, err) = tokio::join!(first.read(&session, PluginShellStream::Stdout), first.read(&session, PluginShellStream::Stderr));
            assert_eq!(&*out.unwrap().unwrap(), b"first-out");
            assert_eq!(&*err.unwrap().unwrap(), b"first-err");
            assert_eq!(first.snapshot().state, ProcessPhase::Running);
            assert!(matches!(first.request_cancel().state, ProcessPhase::Cancelling | ProcessPhase::Cancelled));
            assert_eq!(first.wait(&session).await.unwrap().state, ProcessPhase::Cancelled);
            assert_eq!(first.request_cancel().state, ProcessPhase::Cancelled);
            assert!(first.read(&session, PluginShellStream::Stdout).await.unwrap().is_none());
            assert_eq!(second.snapshot().state, ProcessPhase::Running);
            second.request_cancel();
            assert_eq!(second.wait(&session).await.unwrap().state, ProcessPhase::Cancelled);
            first_runner.await.unwrap(); second_runner.await.unwrap();
        }).await.unwrap();
    }

    #[tokio::test]
    async fn streaming_finishes_with_independent_eof_and_delivers_all_bytes_when_drained() {
        tokio::time::timeout(TEST_LIMIT, async {
            let registry = ProcessSessions::default();
            let (_, session) = new_session(&registry, PLUGIN);
            let output = local_program(
                "printf 'a'; printf 'b' >&2; printf 'c'; exit 7",
                "[Console]::Out.Write('a'); [Console]::Error.Write('b'); [Console]::Out.Write('c'); exit 7",
            );
            let (id, task, runner) = start(&registry, &session, output.clone(), Default::default(), None);
            let (stdout, stderr, final_state) = tokio::join!(
                read_all(&task, &session, PluginShellStream::Stdout),
                read_all(&task, &session, PluginShellStream::Stderr), task.wait(&session),
            );
            assert_eq!(stdout, b"ac"); assert_eq!(stderr, b"b");
            let state = final_state.unwrap();
            assert_eq!(state.state, ProcessPhase::Exited); assert_eq!(state.exit_code, Some(7));
            assert_eq!(task.request_cancel(), state);
            runner.await.unwrap();
            session.release(id).unwrap();
            assert!(session.lookup(id).unwrap().is_none());

            let options = PluginShellOutputOptions { stderr: OutputMode::Discard, ..Default::default() };
            let (_, discard, done) = start(&registry, &session, output, options, None);
            assert!(discard.read(&session, PluginShellStream::Stderr).await.unwrap().is_none());
            let (retained, status) = tokio::join!(read_all(&discard, &session, PluginShellStream::Stdout), discard.wait(&session));
            assert_eq!(retained, b"ac"); assert_eq!(status.unwrap().exit_code, Some(7));
            done.await.unwrap();
        }).await.unwrap();
    }

    #[tokio::test]
    async fn streaming_release_and_timeout_are_not_blocked_by_full_unread_pipe() {
        tokio::time::timeout(TEST_LIMIT, async {
            let registry = ProcessSessions::default();
            let (_, session) = new_session(&registry, PLUGIN);
            let loud = local_program(
                "while :; do printf '12345678901234567890123456789012345678901234567890'; done",
                "while ($true) { [Console]::Out.Write('x' * 65536) }",
            );
            let (id, task, runner) =
                start(&registry, &session, loud.clone(), Default::default(), None);
            while task.stdout.lock().await.len() < BUFFER_CHUNKS {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert_eq!(task.stdout.lock().await.len(), BUFFER_CHUNKS);
            assert_eq!(task.snapshot().state, ProcessPhase::Running);
            session.release(id).unwrap();
            assert_eq!(
                task.wait(&session).await.unwrap().state,
                ProcessPhase::Cancelled
            );
            runner.await.unwrap();
            assert!(session.lookup(id).unwrap().is_none());

            let deadline = Instant::now() + Duration::from_millis(150);
            let (_, timed, runner) = start(
                &registry,
                &session,
                loud,
                Default::default(),
                Some(deadline),
            );
            assert_eq!(
                timed.wait(&session).await.unwrap().state,
                ProcessPhase::TimedOut
            );
            runner.await.unwrap();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn streaming_lifecycle_retires_owned_handles_and_reaps_without_affecting_other_plugin() {
        tokio::time::timeout(TEST_LIMIT, async {
            let shell = PluginShellRegistry::new();
            let registry = &shell.process_sessions;
            let (old_id, old) = new_session(registry, PLUGIN);
            let (_, untouched) = new_session(registry, "com.example.other");
            assert!(registry.lookup(old_id, PLUGIN, "other-generation").is_err());
            assert!(registry.close(old_id, "com.example.other", GEN).is_err());
            let continuous = local_program(
                "while :; do :; done",
                "while ($true) { Start-Sleep -Milliseconds 40 }",
            );
            let (_, task, runner) =
                start(registry, &old, continuous.clone(), Default::default(), None);
            let queued = old.admit(&registry.slots).unwrap();
            shell.cancel_plugin(PLUGIN);
            assert!(registry.lookup(old_id, PLUGIN, GEN).is_err());
            assert!(old.spawn(&continuous, Default::default()).is_err());
            assert!(task.read(&old, PluginShellStream::Stdout).await.is_err());
            assert!(task.wait(&old).await.is_err());
            assert!(untouched.require_live().is_ok());
            runner.await.unwrap();
            assert_eq!(task.snapshot().state, ProcessPhase::Cancelled);
            drop(task);
            drop(queued);
            assert_eq!(registry.slots.available_permits(), MAX_SHELL_TASKS);
            let (fresh_id, fresh) = new_session(registry, PLUGIN);
            assert_ne!(fresh_id, old_id);
            registry.close(old_id, PLUGIN, GEN).unwrap();
            assert!(fresh.require_live().is_ok());
            shell.cancel_all();
            assert!(fresh.require_live().is_err());
            assert!(untouched.require_live().is_err());
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn streaming_spawn_failure_and_unstarted_admission_release_slots() {
        let registry = ProcessSessions::default();
        let (_, session) = new_session(&registry, PLUGIN);
        let missing = request("__hypercom_intentionally_missing_shell_fixture__", &[]);
        let admission = session.admit(&registry.slots).unwrap();
        let id = admission.id;
        assert!(matches!(
            session.spawn(&missing, Default::default()),
            Err(CommandError::Io(_))
        ));
        drop(admission);
        assert!(session.lookup(id).unwrap().is_none());
        assert_eq!(registry.slots.available_permits(), MAX_SHELL_TASKS);
        let bounded: Vec<_> = (0..MAX_TASKS_PER_SESSION)
            .map(|_| session.admit(&registry.slots).unwrap())
            .collect();
        assert!(session.admit(&registry.slots).is_err());
        drop(bounded);
        assert_eq!(registry.slots.available_permits(), MAX_SHELL_TASKS);
    }
}
