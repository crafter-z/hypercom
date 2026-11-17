//! Fair, cancellable admission control for plugin file I/O.
//!
//! A permit has two lifetimes: `finish_io` releases the in-flight I/O slot,
//! while dropping the permit releases the retained memory/byte reservation.
//! The optional `acquire_with_cost` API separates those memory bytes from the
//! bandwidth cost used by the background token buckets.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::{watch, Notify};

const DEFAULT_GLOBAL_CONCURRENCY: usize = 4;
const DEFAULT_PLUGIN_CONCURRENCY: usize = 2;
const DEFAULT_SESSION_CONCURRENCY: usize = 2;
const DEFAULT_BACKGROUND_CONCURRENCY: usize = 3;
const DEFAULT_GLOBAL_BYTES: usize = 64 * 1024 * 1024;
const DEFAULT_PLUGIN_BYTES: usize = 32 * 1024 * 1024;
const DEFAULT_QUEUE_CAPACITY: usize = 64;
const DEFAULT_BACKGROUND_RATE: u64 = 8 * 1024 * 1024;
const DEFAULT_BACKGROUND_BURST: usize = 8 * 1024 * 1024;
const DEFAULT_AGING_MILLIS: u64 = 250;
const DEFAULT_INTERACTIVE_WEIGHT: usize = 3;
const DEFAULT_INTERACTIVE_RESERVE: usize = 1;

/// Identity used for accounting. Plugin bytes are aggregated across sessions.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct IoOwner {
    pub plugin_id: String,
    pub session_id: String,
}

/// Interactive traffic receives the reserved global capacity.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IoPriority {
    Interactive,
    #[default]
    Background,
}

/// Scheduler limits.
///
/// A zero byte limit disables that byte budget. A zero concurrency limit admits
/// no requests. An individual request with `bytes == 0` bypasses byte budgets,
/// preserving the legacy metadata/streaming behavior.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IoLimits {
    pub global_concurrency: usize,
    pub per_plugin_concurrency: usize,
    pub per_session_concurrency: usize,
    pub background_global_concurrency: usize,
    pub global_bytes: usize,
    pub plugin_bytes: usize,
    pub max_queue: usize,
    pub background_rate_bytes_per_sec: u64,
    pub background_burst_bytes: usize,
    pub plugin_background_rate_bytes_per_sec: u64,
    pub plugin_background_burst_bytes: usize,
    pub session_background_rate_bytes_per_sec: u64,
    pub session_background_burst_bytes: usize,
    pub aging_millis: u64,
    pub interactive_weight: usize,
    pub interactive_reserved_capacity: usize,
}

impl Default for IoLimits {
    fn default() -> Self {
        Self {
            global_concurrency: DEFAULT_GLOBAL_CONCURRENCY,
            per_plugin_concurrency: DEFAULT_PLUGIN_CONCURRENCY,
            per_session_concurrency: DEFAULT_SESSION_CONCURRENCY,
            background_global_concurrency: DEFAULT_BACKGROUND_CONCURRENCY,
            global_bytes: DEFAULT_GLOBAL_BYTES,
            plugin_bytes: DEFAULT_PLUGIN_BYTES,
            max_queue: DEFAULT_QUEUE_CAPACITY,
            background_rate_bytes_per_sec: DEFAULT_BACKGROUND_RATE,
            background_burst_bytes: DEFAULT_BACKGROUND_BURST,
            plugin_background_rate_bytes_per_sec: DEFAULT_BACKGROUND_RATE,
            plugin_background_burst_bytes: DEFAULT_BACKGROUND_BURST,
            session_background_rate_bytes_per_sec: DEFAULT_BACKGROUND_RATE,
            session_background_burst_bytes: DEFAULT_BACKGROUND_BURST,
            aging_millis: DEFAULT_AGING_MILLIS,
            interactive_weight: DEFAULT_INTERACTIVE_WEIGHT,
            interactive_reserved_capacity: DEFAULT_INTERACTIVE_RESERVE,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SessionKey {
    plugin_id: String,
    session_id: String,
}

impl From<&IoOwner> for SessionKey {
    fn from(owner: &IoOwner) -> Self {
        Self {
            plugin_id: owner.plugin_id.clone(),
            session_id: owner.session_id.clone(),
        }
    }
}

struct QueuedRequest {
    id: u64,
    owner: IoOwner,
    memory_bytes: usize,
    io_cost: usize,
    priority: IoPriority,
    enqueued_at: Instant,
    cancel: watch::Receiver<bool>,
}

struct TokenBucket {
    tokens: f64,
    last_refill: Instant,
}

impl TokenBucket {
    fn new(burst: usize) -> Self {
        Self {
            tokens: burst as f64,
            last_refill: Instant::now(),
        }
    }

    fn refill(&mut self, rate: u64, capacity: usize, now: Instant) {
        if rate == 0 {
            self.tokens = f64::INFINITY;
            self.last_refill = now;
            return;
        }
        let elapsed = now
            .checked_duration_since(self.last_refill)
            .unwrap_or_default();
        let added = elapsed.as_secs_f64() * rate as f64;
        if added > 0.0 {
            self.tokens = (self.tokens + added).min(capacity as f64);
            self.last_refill = now;
        }
    }
}

struct SchedulerState {
    queue: VecDeque<QueuedRequest>,
    next_id: u64,
    active_global: usize,
    active_background: usize,
    plugin_active: HashMap<String, usize>,
    session_active: HashMap<SessionKey, usize>,
    plugin_background_active: HashMap<String, usize>,
    session_background_active: HashMap<SessionKey, usize>,
    global_bytes: usize,
    plugin_bytes: HashMap<String, usize>,
    session_bytes: HashMap<SessionKey, usize>,
    global_bucket: TokenBucket,
    plugin_buckets: HashMap<String, TokenBucket>,
    session_buckets: HashMap<SessionKey, TokenBucket>,
    last_granted_owner: Option<SessionKey>,
    interactive_streak: usize,
}

impl SchedulerState {
    fn new(limits: &IoLimits) -> Self {
        Self {
            queue: VecDeque::new(),
            next_id: 1,
            active_global: 0,
            active_background: 0,
            plugin_active: HashMap::new(),
            session_active: HashMap::new(),
            plugin_background_active: HashMap::new(),
            session_background_active: HashMap::new(),
            global_bytes: 0,
            plugin_bytes: HashMap::new(),
            session_bytes: HashMap::new(),
            global_bucket: TokenBucket::new(limits.background_burst_bytes),
            plugin_buckets: HashMap::new(),
            session_buckets: HashMap::new(),
            last_granted_owner: None,
            interactive_streak: 0,
        }
    }
}

/// Shared scheduler. Only short synchronous counter/queue sections are locked;
/// no mutex guard is held over an await.
pub struct IoScheduler {
    limits: IoLimits,
    state: Mutex<SchedulerState>,
    wake: Notify,
}

impl Default for IoScheduler {
    fn default() -> Self {
        Self::new(IoLimits::default())
    }
}

impl IoScheduler {
    pub fn new(limits: IoLimits) -> Self {
        Self {
            state: Mutex::new(SchedulerState::new(&limits)),
            limits,
            wake: Notify::new(),
        }
    }

    /// Compatibility API: memory reservation and bandwidth cost are identical.
    pub async fn acquire(
        self: &Arc<Self>,
        owner: IoOwner,
        bytes: usize,
        priority: IoPriority,
        cancel: watch::Receiver<bool>,
    ) -> Result<IoPermit, String> {
        self.acquire_with_cost(owner, bytes, bytes, priority, cancel)
            .await
    }

    /// Acquire with separate retained-memory and background bandwidth costs.
    ///
    /// `memory_bytes` participates in global/plugin byte budgets and remains
    /// reserved until the permit is dropped. `io_cost` is charged immediately
    /// to background token buckets and is normally the payload size. This lets
    /// a filesystem batch reserve `2 * payload + metadata` without requiring a
    /// token burst larger than the actual I/O payload.
    pub async fn acquire_with_cost(
        self: &Arc<Self>,
        owner: IoOwner,
        memory_bytes: usize,
        io_cost: usize,
        priority: IoPriority,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<IoPermit, String> {
        if request_cancelled(&cancel) {
            return Err("插件 I/O 请求已取消".to_string());
        }
        self.validate_request(memory_bytes)?;

        let (id, queue_overflow) = {
            let mut state = self.lock_state();
            if !state.queue.is_empty() && state.queue.len() >= self.limits.max_queue {
                return Err("插件 I/O 排队已满".to_string());
            }
            if state.queue.is_empty() && state.active_global == 0 {
                // Keep the bounded last-owner history while an in-flight permit
                // still exists; otherwise a same-plugin waiter can jump ahead
                // of a different plugin that is already queued.
                state.last_granted_owner = None;
            }
            let id = state.next_id;
            state.next_id = state.next_id.wrapping_add(1).max(1);
            state.queue.push_back(QueuedRequest {
                id,
                owner,
                memory_bytes,
                io_cost,
                priority,
                enqueued_at: Instant::now(),
                cancel: cancel.clone(),
            });
            (id, state.queue.len() > self.limits.max_queue)
        };

        let mut waiter = WaiterGuard {
            scheduler: Arc::clone(self),
            id,
            armed: true,
        };
        self.wake.notify_waiters();

        if queue_overflow {
            // max_queue == 0: admit only if this request is immediately
            // eligible; otherwise it is a bounded non-queueing try operation.
            let can_try_now = {
                let mut state = self.lock_state();
                self.remove_cancelled_waiters(&mut state);
                let now = Instant::now();
                self.refill_background_tokens(&mut state, now);
                self.selected_index(&state, now)
                    .is_some_and(|index| state.queue[index].id == id)
            };
            if !can_try_now {
                return Err("插件 I/O 排队已满".to_string());
            }
        }

        loop {
            let notified = self.wake.notified();
            let (granted, wait_for) = {
                let mut state = self.lock_state();
                self.remove_cancelled_waiters(&mut state);
                if request_cancelled(&cancel) {
                    (None, None)
                } else {
                    let now = Instant::now();
                    self.refill_background_tokens(&mut state, now);
                    let selected = self.selected_index(&state, now);
                    if selected.is_some_and(|index| state.queue[index].id == id) {
                        let request = state
                            .queue
                            .remove(selected.expect("selected index was checked"))
                            .expect("selected queue entry");
                        self.reserve(&mut state, &request);
                        (Some(request), None)
                    } else {
                        (None, self.next_token_wait(&state, now))
                    }
                }
            };
            if let Some(request) = granted {
                waiter.armed = false;
                return Ok(IoPermit {
                    scheduler: Arc::clone(self),
                    owner: request.owner,
                    memory_bytes: request.memory_bytes,
                    priority: request.priority,
                    io_active: true,
                });
            }
            if request_cancelled(&cancel) {
                return Err("插件 I/O 请求已取消".to_string());
            }

            tokio::select! {
                biased;
                cancelled = wait_for_cancel(&mut cancel) => {
                    if cancelled {
                        return Err("插件 I/O 请求已取消".to_string());
                    }
                }
                _ = notified => {}
                _ = sleep_for(wait_for) => {}
            }
        }
    }

    fn validate_request(&self, memory_bytes: usize) -> Result<(), String> {
        if self.limits.global_concurrency == 0
            || self.limits.per_plugin_concurrency == 0
            || self.limits.per_session_concurrency == 0
        {
            return Err("插件 I/O 并发额度为零".to_string());
        }
        if memory_bytes != 0 {
            if self.limits.global_bytes != 0 && memory_bytes > self.limits.global_bytes {
                return Err("插件 I/O 请求超过全局字节额度".to_string());
            }
            if self.limits.plugin_bytes != 0 && memory_bytes > self.limits.plugin_bytes {
                return Err("插件 I/O 请求超过插件字节额度".to_string());
            }
        }
        Ok(())
    }

    fn lock_state(&self) -> MutexGuard<'_, SchedulerState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn remove_cancelled_waiters(&self, state: &mut SchedulerState) {
        let mut index = 0;
        let mut changed = false;
        while index < state.queue.len() {
            if request_cancelled(&state.queue[index].cancel) {
                state.queue.remove(index);
                changed = true;
            } else {
                index += 1;
            }
        }
        if changed {
            self.cleanup_token_buckets(state);
            self.wake.notify_waiters();
        }
    }

    fn refill_background_tokens(&self, state: &mut SchedulerState, now: Instant) {
        // Materialize buckets only for queued background owners. This permits
        // requests larger than burst to accumulate a finite virtual burst.
        let queued_background_owners: Vec<(String, SessionKey)> = state
            .queue
            .iter()
            .filter(|request| request.priority == IoPriority::Background)
            .map(|request| {
                (
                    request.owner.plugin_id.clone(),
                    SessionKey::from(&request.owner),
                )
            })
            .collect();
        for (plugin, session) in queued_background_owners {
            state
                .plugin_buckets
                .entry(plugin)
                .or_insert_with(|| TokenBucket::new(self.limits.plugin_background_burst_bytes));
            state
                .session_buckets
                .entry(session)
                .or_insert_with(|| TokenBucket::new(self.limits.session_background_burst_bytes));
        }
        let global_max = state
            .queue
            .iter()
            .filter(|request| request.priority == IoPriority::Background)
            .map(|request| request.io_cost)
            .max()
            .unwrap_or(0);
        state.global_bucket.refill(
            self.limits.background_rate_bytes_per_sec,
            self.limits.background_burst_bytes.max(global_max),
            now,
        );

        let plugin_keys: Vec<String> = state.plugin_buckets.keys().cloned().collect();
        for plugin in plugin_keys {
            let queued_max = state
                .queue
                .iter()
                .filter(|request| {
                    request.priority == IoPriority::Background && request.owner.plugin_id == plugin
                })
                .map(|request| request.io_cost)
                .max()
                .unwrap_or(0);
            if let Some(bucket) = state.plugin_buckets.get_mut(&plugin) {
                bucket.refill(
                    self.limits.plugin_background_rate_bytes_per_sec,
                    self.limits.plugin_background_burst_bytes.max(queued_max),
                    now,
                );
            }
        }
        let session_keys: Vec<SessionKey> = state.session_buckets.keys().cloned().collect();
        for session in session_keys {
            let queued_max = state
                .queue
                .iter()
                .filter(|request| {
                    request.priority == IoPriority::Background
                        && SessionKey::from(&request.owner) == session
                })
                .map(|request| request.io_cost)
                .max()
                .unwrap_or(0);
            if let Some(bucket) = state.session_buckets.get_mut(&session) {
                bucket.refill(
                    self.limits.session_background_rate_bytes_per_sec,
                    self.limits.session_background_burst_bytes.max(queued_max),
                    now,
                );
            }
        }
    }

    fn selected_index(&self, state: &SchedulerState, now: Instant) -> Option<usize> {
        let has_interactive = state
            .queue
            .iter()
            .any(|request| request.priority == IoPriority::Interactive);
        let has_background = state
            .queue
            .iter()
            .any(|request| request.priority == IoPriority::Background);
        if !has_interactive && !has_background {
            return None;
        }
        let background_aged = state.queue.iter().any(|request| {
            request.priority == IoPriority::Background
                && now
                    .checked_duration_since(request.enqueued_at)
                    .unwrap_or_default()
                    >= Duration::from_millis(self.limits.aging_millis)
        });
        let prefer_background = !has_interactive
            || background_aged
            || (has_background
                && state.interactive_streak >= self.limits.interactive_weight.max(1));
        let first = if prefer_background {
            IoPriority::Background
        } else {
            IoPriority::Interactive
        };
        let second = if first == IoPriority::Background {
            IoPriority::Interactive
        } else {
            IoPriority::Background
        };
        self.select_priority(state, first)
            .or_else(|| self.select_priority(state, second))
    }

    fn select_priority(&self, state: &SchedulerState, priority: IoPriority) -> Option<usize> {
        let candidates: Vec<usize> = state
            .queue
            .iter()
            .enumerate()
            .filter_map(|(index, request)| {
                (request.priority == priority && self.can_reserve(state, request)).then_some(index)
            })
            .collect();
        if candidates.is_empty() {
            return None;
        }
        if let Some(last_owner) = &state.last_granted_owner {
            // Hierarchical fairness: first rotate across plugins, then across
            // sessions within the last plugin, and only then fall back to FIFO.
            candidates
                .iter()
                .copied()
                .find(|index| state.queue[*index].owner.plugin_id != last_owner.plugin_id)
                .or_else(|| {
                    candidates.iter().copied().find(|index| {
                        let owner = &state.queue[*index].owner;
                        owner.plugin_id == last_owner.plugin_id
                            && owner.session_id != last_owner.session_id
                    })
                })
                .or_else(|| candidates.first().copied())
        } else {
            candidates.first().copied()
        }
    }

    fn can_reserve(&self, state: &SchedulerState, request: &QueuedRequest) -> bool {
        self.can_reserve_limits(state, request)
            && (request.priority != IoPriority::Background
                || self.background_tokens_available(state, request))
    }

    fn can_reserve_limits(&self, state: &SchedulerState, request: &QueuedRequest) -> bool {
        if state.active_global >= self.limits.global_concurrency {
            return false;
        }
        if state
            .plugin_active
            .get(&request.owner.plugin_id)
            .copied()
            .unwrap_or(0)
            >= self.limits.per_plugin_concurrency
        {
            return false;
        }
        let session_key = SessionKey::from(&request.owner);
        if state.session_active.get(&session_key).copied().unwrap_or(0)
            >= self.limits.per_session_concurrency
        {
            return false;
        }
        if request.memory_bytes != 0 {
            if self.limits.global_bytes != 0
                && state.global_bytes.saturating_add(request.memory_bytes)
                    > self.limits.global_bytes
            {
                return false;
            }
            if self.limits.plugin_bytes != 0
                && state
                    .plugin_bytes
                    .get(&request.owner.plugin_id)
                    .copied()
                    .unwrap_or(0)
                    .saturating_add(request.memory_bytes)
                    > self.limits.plugin_bytes
            {
                return false;
            }
        }
        if request.priority == IoPriority::Background {
            if state.active_background >= self.limits.background_global_concurrency {
                return false;
            }
            let reserve = self
                .limits
                .interactive_reserved_capacity
                .min(self.limits.global_concurrency);
            if state.active_global >= self.limits.global_concurrency.saturating_sub(reserve) {
                return false;
            }
        }
        true
    }

    fn background_tokens_available(&self, state: &SchedulerState, request: &QueuedRequest) -> bool {
        if request.io_cost == 0 {
            return true;
        }
        if self.limits.background_rate_bytes_per_sec != 0
            && state.global_bucket.tokens < request.io_cost as f64
        {
            return false;
        }
        if self.limits.plugin_background_rate_bytes_per_sec != 0 {
            let tokens = state
                .plugin_buckets
                .get(&request.owner.plugin_id)
                .map(|bucket| bucket.tokens)
                .unwrap_or(self.limits.plugin_background_burst_bytes as f64);
            if tokens < request.io_cost as f64 {
                return false;
            }
        }
        if self.limits.session_background_rate_bytes_per_sec != 0 {
            let key = SessionKey::from(&request.owner);
            let tokens = state
                .session_buckets
                .get(&key)
                .map(|bucket| bucket.tokens)
                .unwrap_or(self.limits.session_background_burst_bytes as f64);
            if tokens < request.io_cost as f64 {
                return false;
            }
        }
        true
    }

    fn next_token_wait(&self, state: &SchedulerState, now: Instant) -> Option<Duration> {
        let mut wait: Option<Duration> = None;
        for request in &state.queue {
            if request.priority != IoPriority::Background
                || !self.can_reserve_limits(state, request)
            {
                continue;
            }
            if request.io_cost == 0 {
                continue;
            }
            let mut missing = None;
            if self.limits.background_rate_bytes_per_sec != 0 {
                let value = request.io_cost as f64 - state.global_bucket.tokens;
                if value > 0.0 {
                    missing = Some((value, self.limits.background_rate_bytes_per_sec));
                }
            }
            if self.limits.plugin_background_rate_bytes_per_sec != 0 {
                let tokens = state
                    .plugin_buckets
                    .get(&request.owner.plugin_id)
                    .map(|bucket| bucket.tokens)
                    .unwrap_or(self.limits.plugin_background_burst_bytes as f64);
                let value = request.io_cost as f64 - tokens;
                if value > 0.0 {
                    missing = Some(select_token_wait(
                        missing,
                        value,
                        self.limits.plugin_background_rate_bytes_per_sec,
                    ));
                }
            }
            if self.limits.session_background_rate_bytes_per_sec != 0 {
                let key = SessionKey::from(&request.owner);
                let tokens = state
                    .session_buckets
                    .get(&key)
                    .map(|bucket| bucket.tokens)
                    .unwrap_or(self.limits.session_background_burst_bytes as f64);
                let value = request.io_cost as f64 - tokens;
                if value > 0.0 {
                    missing = Some(select_token_wait(
                        missing,
                        value,
                        self.limits.session_background_rate_bytes_per_sec,
                    ));
                }
            }
            if let Some((missing, rate)) = missing {
                let duration = Duration::from_secs_f64((missing / rate as f64).max(0.000_001));
                let duration = now
                    .checked_add(duration)
                    .and_then(|deadline| deadline.checked_duration_since(now))
                    .unwrap_or(duration);
                wait = Some(wait.map_or(duration, |current| current.min(duration)));
            }
        }
        wait
    }

    fn reserve(&self, state: &mut SchedulerState, request: &QueuedRequest) {
        state.active_global += 1;
        *state
            .plugin_active
            .entry(request.owner.plugin_id.clone())
            .or_default() += 1;
        *state
            .session_active
            .entry(SessionKey::from(&request.owner))
            .or_default() += 1;
        if request.memory_bytes != 0 {
            state.global_bytes = state.global_bytes.saturating_add(request.memory_bytes);
            let current = state
                .plugin_bytes
                .get(&request.owner.plugin_id)
                .copied()
                .unwrap_or(0);
            state.plugin_bytes.insert(
                request.owner.plugin_id.clone(),
                current.saturating_add(request.memory_bytes),
            );
            let session_key = SessionKey::from(&request.owner);
            let current_session = state.session_bytes.get(&session_key).copied().unwrap_or(0);
            state.session_bytes.insert(
                session_key,
                current_session.saturating_add(request.memory_bytes),
            );
        }
        if request.priority == IoPriority::Background {
            state.active_background += 1;
            *state
                .plugin_background_active
                .entry(request.owner.plugin_id.clone())
                .or_default() += 1;
            *state
                .session_background_active
                .entry(SessionKey::from(&request.owner))
                .or_default() += 1;
            self.charge_tokens(state, request);
            state.interactive_streak = 0;
        } else {
            state.interactive_streak = state.interactive_streak.saturating_add(1);
        }
        state.last_granted_owner = Some(SessionKey::from(&request.owner));
    }

    fn charge_tokens(&self, state: &mut SchedulerState, request: &QueuedRequest) {
        if request.io_cost == 0 {
            return;
        }
        if self.limits.background_rate_bytes_per_sec != 0 {
            state.global_bucket.tokens =
                (state.global_bucket.tokens - request.io_cost as f64).max(0.0);
        }
        if self.limits.plugin_background_rate_bytes_per_sec != 0 {
            let bucket = state
                .plugin_buckets
                .entry(request.owner.plugin_id.clone())
                .or_insert_with(|| TokenBucket::new(self.limits.plugin_background_burst_bytes));
            bucket.tokens = (bucket.tokens - request.io_cost as f64).max(0.0);
        }
        if self.limits.session_background_rate_bytes_per_sec != 0 {
            let key = SessionKey::from(&request.owner);
            let bucket = state
                .session_buckets
                .entry(key)
                .or_insert_with(|| TokenBucket::new(self.limits.session_background_burst_bytes));
            bucket.tokens = (bucket.tokens - request.io_cost as f64).max(0.0);
        }
    }

    fn finish_io(&self, owner: &IoOwner, priority: IoPriority) {
        let mut state = self.lock_state();
        state.active_global = state.active_global.saturating_sub(1);
        decrement_map(&mut state.plugin_active, &owner.plugin_id);
        decrement_map(&mut state.session_active, &SessionKey::from(owner));
        if priority == IoPriority::Background {
            state.active_background = state.active_background.saturating_sub(1);
            decrement_map(&mut state.plugin_background_active, &owner.plugin_id);
            decrement_map(
                &mut state.session_background_active,
                &SessionKey::from(owner),
            );
            self.cleanup_token_buckets(&mut state);
        }
        drop(state);
        self.wake.notify_waiters();
    }

    fn release(&self, owner: &IoOwner, memory_bytes: usize, priority: IoPriority, io_active: bool) {
        let mut state = self.lock_state();
        if io_active {
            state.active_global = state.active_global.saturating_sub(1);
            decrement_map(&mut state.plugin_active, &owner.plugin_id);
            decrement_map(&mut state.session_active, &SessionKey::from(owner));
            if priority == IoPriority::Background {
                state.active_background = state.active_background.saturating_sub(1);
                decrement_map(&mut state.plugin_background_active, &owner.plugin_id);
                decrement_map(
                    &mut state.session_background_active,
                    &SessionKey::from(owner),
                );
            }
        }
        if memory_bytes != 0 {
            state.global_bytes = state.global_bytes.saturating_sub(memory_bytes);
            decrement_bytes_map(&mut state.plugin_bytes, &owner.plugin_id, memory_bytes);
            decrement_session_bytes_map(
                &mut state.session_bytes,
                &SessionKey::from(owner),
                memory_bytes,
            );
        }
        self.cleanup_token_buckets(&mut state);
        drop(state);
        self.wake.notify_waiters();
    }

    fn cleanup_token_buckets(&self, state: &mut SchedulerState) {
        // Refill before deciding whether an idle bucket is reclaimable. A
        // partially depleted bucket is a real per-plugin/session debt record;
        // deleting it would let the next serial request recreate a full burst.
        self.refill_background_tokens(state, Instant::now());
        let active_plugins: HashSet<String> = state
            .plugin_background_active
            .iter()
            .filter_map(|(plugin, count)| (*count > 0).then_some(plugin.clone()))
            .collect();
        let queued_plugins: HashSet<String> = state
            .queue
            .iter()
            .filter(|request| request.priority == IoPriority::Background)
            .map(|request| request.owner.plugin_id.clone())
            .collect();
        let leased_plugins: HashSet<String> = state.plugin_bytes.keys().cloned().collect();
        let plugin_rate = self.limits.plugin_background_rate_bytes_per_sec;
        let plugin_burst = self.limits.plugin_background_burst_bytes as f64;
        state.plugin_buckets.retain(|plugin, bucket| {
            let busy = active_plugins.contains(plugin)
                || queued_plugins.contains(plugin)
                || leased_plugins.contains(plugin);
            let full = plugin_rate == 0 || bucket.tokens >= plugin_burst;
            busy || !full
        });

        let active_sessions: HashSet<SessionKey> = state
            .session_background_active
            .iter()
            .filter_map(|(session, count)| (*count > 0).then_some(session.clone()))
            .collect();
        let queued_sessions: HashSet<SessionKey> = state
            .queue
            .iter()
            .filter(|request| request.priority == IoPriority::Background)
            .map(|request| SessionKey::from(&request.owner))
            .collect();
        let leased_sessions: HashSet<SessionKey> = state.session_bytes.keys().cloned().collect();
        let session_rate = self.limits.session_background_rate_bytes_per_sec;
        let session_burst = self.limits.session_background_burst_bytes as f64;
        state.session_buckets.retain(|session, bucket| {
            let busy = active_sessions.contains(session)
                || queued_sessions.contains(session)
                || leased_sessions.contains(session);
            let full = session_rate == 0 || bucket.tokens >= session_burst;
            busy || !full
        });
    }

    fn remove_waiter(&self, id: u64) {
        let mut state = self.lock_state();
        if let Some(index) = state.queue.iter().position(|request| request.id == id) {
            state.queue.remove(index);
            self.cleanup_token_buckets(&mut state);
            drop(state);
            self.wake.notify_waiters();
        }
    }
}

fn select_token_wait(current: Option<(f64, u64)>, missing: f64, rate: u64) -> (f64, u64) {
    match current {
        Some((current_missing, current_rate))
            if current_missing / current_rate as f64 <= missing / rate as f64 =>
        {
            (current_missing, current_rate)
        }
        _ => (missing, rate),
    }
}

fn decrement_map<K>(map: &mut HashMap<K, usize>, key: &K)
where
    K: Eq + std::hash::Hash + Clone,
{
    if let Some(value) = map.get_mut(key) {
        *value = value.saturating_sub(1);
        if *value == 0 {
            map.remove(key);
        }
    }
}

fn decrement_bytes_map(map: &mut HashMap<String, usize>, key: &str, amount: usize) {
    if let Some(value) = map.get_mut(key) {
        *value = value.saturating_sub(amount);
        if *value == 0 {
            map.remove(key);
        }
    }
}

fn decrement_session_bytes_map(
    map: &mut HashMap<SessionKey, usize>,
    key: &SessionKey,
    amount: usize,
) {
    if let Some(value) = map.get_mut(key) {
        *value = value.saturating_sub(amount);
        if *value == 0 {
            map.remove(key);
        }
    }
}

fn request_cancelled(cancel: &watch::Receiver<bool>) -> bool {
    *cancel.borrow()
}

async fn wait_for_cancel(cancel: &mut watch::Receiver<bool>) -> bool {
    if *cancel.borrow() {
        return true;
    }
    match cancel.changed().await {
        Ok(()) => *cancel.borrow(),
        // A dropped sender is not an explicit cancellation. Keep waiting for
        // scheduler capacity; callers that need cancellation send true first.
        Err(_) => std::future::pending::<bool>().await,
    }
}

async fn sleep_for(duration: Option<Duration>) {
    match duration {
        Some(duration) => tokio::time::sleep(duration).await,
        None => std::future::pending::<()>().await,
    }
}

struct WaiterGuard {
    scheduler: Arc<IoScheduler>,
    id: u64,
    armed: bool,
}

impl Drop for WaiterGuard {
    fn drop(&mut self) {
        if self.armed {
            self.scheduler.remove_waiter(self.id);
        }
    }
}

/// Permit returned by [`IoScheduler::acquire`] and `acquire_with_cost`.
pub struct IoPermit {
    scheduler: Arc<IoScheduler>,
    owner: IoOwner,
    memory_bytes: usize,
    priority: IoPriority,
    io_active: bool,
}

impl IoPermit {
    /// Release actual I/O concurrency while retaining memory bytes until Drop.
    pub fn finish_io(&mut self) {
        if self.io_active {
            self.scheduler.finish_io(&self.owner, self.priority);
            self.io_active = false;
        }
    }
}

impl Drop for IoPermit {
    fn drop(&mut self) {
        self.scheduler.release(
            &self.owner,
            self.memory_bytes,
            self.priority,
            self.io_active,
        );
        self.io_active = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner(plugin_id: &str, session_id: &str) -> IoOwner {
        IoOwner {
            plugin_id: plugin_id.to_string(),
            session_id: session_id.to_string(),
        }
    }

    fn no_cancel() -> watch::Receiver<bool> {
        // The sender may be dropped: only an explicit true value is a cancel.
        let (_tx, rx) = watch::channel(false);
        rx
    }

    #[test]
    fn token_bucket_refills_with_deterministic_clock() {
        let mut bucket = TokenBucket::new(1);
        let start = bucket.last_refill;
        bucket.refill(2, 8, start + Duration::from_secs(3));
        assert_eq!(bucket.tokens, 7.0);
        bucket.refill(2, 8, start + Duration::from_secs(10));
        assert_eq!(bucket.tokens, 8.0);
    }

    #[test]
    fn idle_debt_survives_and_full_buckets_are_reclaimed() {
        let scheduler = IoScheduler::new(IoLimits {
            background_rate_bytes_per_sec: 0,
            plugin_background_rate_bytes_per_sec: 1,
            plugin_background_burst_bytes: 4,
            session_background_rate_bytes_per_sec: 1,
            session_background_burst_bytes: 4,
            ..Default::default()
        });
        let plugin = "plugin-debt".to_string();
        let session = SessionKey {
            plugin_id: plugin.clone(),
            session_id: "old-session".to_string(),
        };
        let now = Instant::now();
        let mut state = scheduler.lock_state();
        state.plugin_buckets.insert(
            plugin.clone(),
            TokenBucket {
                tokens: 0.0,
                last_refill: now,
            },
        );
        state.session_buckets.insert(
            session.clone(),
            TokenBucket {
                tokens: 0.0,
                last_refill: now,
            },
        );
        scheduler.cleanup_token_buckets(&mut state);
        assert!(state.plugin_buckets.contains_key(&plugin));
        assert!(state.session_buckets.contains_key(&session));
        state.plugin_buckets.get_mut(&plugin).unwrap().tokens = 4.0;
        state.session_buckets.get_mut(&session).unwrap().tokens = 4.0;
        scheduler.cleanup_token_buckets(&mut state);
        assert!(!state.plugin_buckets.contains_key(&plugin));
        assert!(!state.session_buckets.contains_key(&session));
    }

    #[test]
    fn plugin_debt_is_aggregated_across_sessions() {
        let scheduler = IoScheduler::new(IoLimits {
            background_rate_bytes_per_sec: 0,
            plugin_background_rate_bytes_per_sec: 1,
            plugin_background_burst_bytes: 8,
            session_background_rate_bytes_per_sec: 1,
            session_background_burst_bytes: 8,
            ..Default::default()
        });
        let plugin = "aggregate-plugin".to_string();
        let old_session = SessionKey {
            plugin_id: plugin.clone(),
            session_id: "old".to_string(),
        };
        let mut state = scheduler.lock_state();
        state
            .plugin_buckets
            .insert(plugin.clone(), TokenBucket::new(8));
        state.plugin_buckets.get_mut(&plugin).unwrap().tokens = 0.0;
        state
            .session_buckets
            .insert(old_session.clone(), TokenBucket::new(8));
        state.session_buckets.get_mut(&old_session).unwrap().tokens = 0.0;
        // A new session cannot erase the old plugin aggregate debt.
        let new_session = SessionKey {
            plugin_id: plugin.clone(),
            session_id: "new".to_string(),
        };
        state
            .session_buckets
            .insert(new_session.clone(), TokenBucket::new(8));
        scheduler.cleanup_token_buckets(&mut state);
        assert!(state.plugin_buckets.contains_key(&plugin));
        assert!(state.session_buckets.contains_key(&old_session));
        assert!(!state.session_buckets.contains_key(&new_session));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn serial_background_drop_keeps_plugin_debt() {
        let scheduler = Arc::new(IoScheduler::new(IoLimits {
            global_concurrency: 4,
            per_plugin_concurrency: 4,
            per_session_concurrency: 4,
            background_global_concurrency: 3,
            background_rate_bytes_per_sec: 0,
            background_burst_bytes: 8,
            plugin_background_rate_bytes_per_sec: 1,
            plugin_background_burst_bytes: 8,
            session_background_rate_bytes_per_sec: 1,
            session_background_burst_bytes: 8,
            ..Default::default()
        }));
        let permit = scheduler
            .acquire_with_cost(
                owner("serial-plugin", "first-session"),
                0,
                8,
                IoPriority::Background,
                no_cancel(),
            )
            .await
            .unwrap();
        drop(permit);
        {
            let state = scheduler.lock_state();
            // Drop performs a real-clock refill; fractional bytes are valid.
            assert!(state.plugin_buckets["serial-plugin"].tokens < 8.0);
        }
        let queued = {
            let scheduler = Arc::clone(&scheduler);
            tokio::spawn(async move {
                scheduler
                    .acquire_with_cost(
                        owner("serial-plugin", "reopened-session"),
                        1,
                        8,
                        IoPriority::Background,
                        no_cancel(),
                    )
                    .await
            })
        };
        tokio::task::yield_now().await;
        assert!(!queued.is_finished());
        queued.abort();
        let _ = queued.await;
    }

    #[tokio::test(flavor = "current_thread")]

    async fn defaults_and_legacy_zero_bytes() {
        let limits = IoLimits::default();
        assert_eq!(limits.global_concurrency, 4);
        assert_eq!(limits.per_plugin_concurrency, 2);
        assert_eq!(limits.per_session_concurrency, 2);
        assert_eq!(limits.background_global_concurrency, 3);
        assert_eq!(limits.global_bytes, 64 * 1024 * 1024);
        assert_eq!(limits.plugin_bytes, 32 * 1024 * 1024);

        let scheduler = Arc::new(IoScheduler::new(IoLimits {
            global_concurrency: 2,
            per_plugin_concurrency: 2,
            per_session_concurrency: 2,
            global_bytes: 1,
            plugin_bytes: 1,
            ..limits
        }));
        let first = scheduler
            .acquire(
                owner("p", "legacy"),
                0,
                IoPriority::Interactive,
                no_cancel(),
            )
            .await
            .expect("legacy request should bypass byte budgets");
        let second = scheduler
            .acquire(
                owner("p", "legacy"),
                0,
                IoPriority::Interactive,
                no_cancel(),
            )
            .await
            .expect("second legacy request should use the second slot");
        drop(first);
        drop(second);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn separate_memory_and_io_costs() {
        let scheduler = Arc::new(IoScheduler::new(IoLimits {
            global_concurrency: 2,
            per_plugin_concurrency: 2,
            per_session_concurrency: 2,
            global_bytes: 10,
            plugin_bytes: 10,
            background_rate_bytes_per_sec: 0,
            plugin_background_rate_bytes_per_sec: 0,
            session_background_rate_bytes_per_sec: 0,
            ..Default::default()
        }));
        let first = scheduler
            .acquire_with_cost(owner("p", "s"), 8, 1, IoPriority::Interactive, no_cancel())
            .await
            .unwrap();
        let blocked = {
            let scheduler = Arc::clone(&scheduler);
            tokio::spawn(async move {
                scheduler
                    .acquire_with_cost(owner("p", "s"), 3, 1, IoPriority::Interactive, no_cancel())
                    .await
            })
        };
        tokio::task::yield_now().await;
        assert!(!blocked.is_finished());
        drop(first);
        let second = blocked
            .await
            .unwrap()
            .expect("memory release should wake waiter");
        drop(second);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn finish_releases_concurrency_but_drop_releases_bytes() {
        let scheduler = Arc::new(IoScheduler::new(IoLimits {
            global_concurrency: 2,
            per_plugin_concurrency: 2,
            per_session_concurrency: 2,
            background_global_concurrency: 1,
            background_rate_bytes_per_sec: 0,
            plugin_background_rate_bytes_per_sec: 0,
            session_background_rate_bytes_per_sec: 0,
            global_bytes: 10,
            plugin_bytes: 10,
            ..Default::default()
        }));
        let mut first = scheduler
            .acquire(owner("p", "s"), 8, IoPriority::Interactive, no_cancel())
            .await
            .unwrap();
        first.finish_io();
        let mut second = scheduler
            .acquire(owner("p", "s"), 2, IoPriority::Interactive, no_cancel())
            .await
            .unwrap();
        second.finish_io();
        let blocked = {
            let scheduler = Arc::clone(&scheduler);
            tokio::spawn(async move {
                scheduler
                    .acquire(owner("p", "s"), 1, IoPriority::Interactive, no_cancel())
                    .await
            })
        };
        tokio::task::yield_now().await;
        assert!(!blocked.is_finished());
        drop(first);
        let permit = blocked
            .await
            .unwrap()
            .expect("byte release should wake the waiter");
        drop(second);
        drop(permit);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancelled_waiter_and_dropped_future_do_not_leak_queue() {
        let scheduler = Arc::new(IoScheduler::new(IoLimits {
            global_concurrency: 1,
            per_plugin_concurrency: 1,
            per_session_concurrency: 1,
            background_global_concurrency: 1,
            background_rate_bytes_per_sec: 0,
            plugin_background_rate_bytes_per_sec: 0,
            session_background_rate_bytes_per_sec: 0,
            max_queue: 4,
            ..Default::default()
        }));
        let first = scheduler
            .acquire(owner("p", "s"), 0, IoPriority::Interactive, no_cancel())
            .await
            .unwrap();
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let waiting = {
            let scheduler = Arc::clone(&scheduler);
            tokio::spawn(async move {
                scheduler
                    .acquire(owner("p", "queued"), 0, IoPriority::Interactive, cancel_rx)
                    .await
            })
        };
        tokio::task::yield_now().await;
        cancel_tx.send(true).unwrap();
        assert!(waiting.await.unwrap().is_err());
        drop(first);

        let leaked_future = {
            let scheduler = Arc::clone(&scheduler);
            tokio::spawn(async move {
                scheduler
                    .acquire(
                        owner("p", "dropped"),
                        0,
                        IoPriority::Interactive,
                        no_cancel(),
                    )
                    .await
            })
        };
        tokio::task::yield_now().await;
        leaked_future.abort();
        let _ = leaked_future.await;
        let permit = scheduler
            .acquire(owner("p", "after"), 0, IoPriority::Interactive, no_cancel())
            .await
            .expect("aborted acquire must be removed");
        drop(permit);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn background_keeps_reserved_interactive_capacity() {
        let scheduler = Arc::new(IoScheduler::new(IoLimits {
            global_concurrency: 2,
            per_plugin_concurrency: 4,
            per_session_concurrency: 4,
            background_global_concurrency: 2,
            interactive_reserved_capacity: 1,
            background_rate_bytes_per_sec: 0,
            plugin_background_rate_bytes_per_sec: 0,
            session_background_rate_bytes_per_sec: 0,
            ..Default::default()
        }));
        let background = scheduler
            .acquire(owner("p", "bg"), 0, IoPriority::Background, no_cancel())
            .await
            .unwrap();
        let queued_background = {
            let scheduler = Arc::clone(&scheduler);
            tokio::spawn(async move {
                scheduler
                    .acquire(owner("p", "bg-2"), 0, IoPriority::Background, no_cancel())
                    .await
            })
        };
        tokio::task::yield_now().await;
        assert!(!queued_background.is_finished());
        let interactive = scheduler
            .acquire(
                owner("p", "interactive"),
                0,
                IoPriority::Interactive,
                no_cancel(),
            )
            .await
            .expect("interactive should use the reserved slot");
        drop(background);
        drop(interactive);
        let queued = queued_background.await.unwrap().unwrap();
        drop(queued);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn queue_round_robin_avoids_owner_flooding() {
        let scheduler = Arc::new(IoScheduler::new(IoLimits {
            global_concurrency: 1,
            per_plugin_concurrency: 8,
            per_session_concurrency: 8,
            background_global_concurrency: 1,
            interactive_reserved_capacity: 0,
            background_rate_bytes_per_sec: 0,
            plugin_background_rate_bytes_per_sec: 0,
            session_background_rate_bytes_per_sec: 0,
            ..Default::default()
        }));
        let first = scheduler
            .acquire(owner("a", "first"), 0, IoPriority::Interactive, no_cancel())
            .await
            .unwrap();
        let (a_tx, a_rx) = tokio::sync::oneshot::channel();
        let (b_tx, b_rx) = tokio::sync::oneshot::channel();
        let a = {
            let scheduler = Arc::clone(&scheduler);
            tokio::spawn(async move {
                let permit = scheduler
                    .acquire(
                        owner("a", "second"),
                        0,
                        IoPriority::Interactive,
                        no_cancel(),
                    )
                    .await
                    .unwrap();
                let _ = a_tx.send(());
                permit
            })
        };
        tokio::task::yield_now().await;
        let b = {
            let scheduler = Arc::clone(&scheduler);
            tokio::spawn(async move {
                let permit = scheduler
                    .acquire(owner("b", "first"), 0, IoPriority::Interactive, no_cancel())
                    .await
                    .unwrap();
                let _ = b_tx.send(());
                permit
            })
        };
        tokio::task::yield_now().await;
        drop(first);
        tokio::time::timeout(Duration::from_secs(5), b_rx)
            .await
            .expect("different plugin should be scheduled within deadline")
            .expect("different plugin completion signal");
        assert!(!a.is_finished());
        drop(b.await.unwrap());
        let permit_a = tokio::time::timeout(Duration::from_secs(5), a)
            .await
            .expect("same-plugin waiter should proceed after B release")
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), a_rx)
            .await
            .expect("same-plugin completion signal")
            .expect("A completion signal");
        drop(permit_a);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn same_plugin_rotates_sessions_before_fifo() {
        let scheduler = Arc::new(IoScheduler::new(IoLimits {
            global_concurrency: 1,
            per_plugin_concurrency: 8,
            per_session_concurrency: 8,
            interactive_reserved_capacity: 0,
            background_rate_bytes_per_sec: 0,
            plugin_background_rate_bytes_per_sec: 0,
            session_background_rate_bytes_per_sec: 0,
            ..Default::default()
        }));
        let first = scheduler
            .acquire(
                owner("same-plugin", "first"),
                0,
                IoPriority::Interactive,
                no_cancel(),
            )
            .await
            .unwrap();
        let (second_tx, second_rx) = tokio::sync::oneshot::channel();
        let (third_tx, third_rx) = tokio::sync::oneshot::channel();
        let second = {
            let scheduler = Arc::clone(&scheduler);
            tokio::spawn(async move {
                let permit = scheduler
                    .acquire(
                        owner("same-plugin", "second"),
                        0,
                        IoPriority::Interactive,
                        no_cancel(),
                    )
                    .await
                    .unwrap();
                let _ = second_tx.send(());
                permit
            })
        };
        tokio::task::yield_now().await;
        let third = {
            let scheduler = Arc::clone(&scheduler);
            tokio::spawn(async move {
                let permit = scheduler
                    .acquire(
                        owner("same-plugin", "third"),
                        0,
                        IoPriority::Interactive,
                        no_cancel(),
                    )
                    .await
                    .unwrap();
                let _ = third_tx.send(());
                permit
            })
        };
        tokio::task::yield_now().await;
        drop(first);
        tokio::time::timeout(Duration::from_secs(5), second_rx)
            .await
            .expect("next session should be scheduled")
            .expect("second session completion signal");
        assert!(!third.is_finished());
        let second_permit = second.await.unwrap();
        drop(second_permit);
        tokio::time::timeout(Duration::from_secs(5), third_rx)
            .await
            .expect("third session should be scheduled")
            .expect("third session completion signal");
        drop(third.await.unwrap());
    }
}
