use std::time::{Duration, Instant};

/// 数据节流器
/// 用于控制数据发送频率，避免高频数据导致 UI 卡顿
pub struct DataThrottler {
    buffer: Vec<u8>,
    last_send: Instant,
    interval: Duration,
}

impl DataThrottler {
    /// 创建新的节流器
    /// interval: 节流间隔，默认 50ms
    pub fn new(interval_ms: u64) -> Self {
        Self {
            buffer: Vec::new(),
            last_send: Instant::now() - Duration::from_millis(interval_ms),
            interval: Duration::from_millis(interval_ms),
        }
    }

    /// 推送数据到缓冲区
    /// 如果达到节流间隔，返回缓冲的数据；否则返回 None
    pub fn push(&mut self, data: &[u8]) -> Option<Vec<u8>> {
        self.buffer.extend_from_slice(data);

        if self.last_send.elapsed() >= self.interval {
            let result = self.buffer.clone();
            self.buffer.clear();
            self.last_send = Instant::now();
            Some(result)
        } else {
            None
        }
    }

    /// 强制刷新缓冲区
    #[allow(dead_code)]
    pub fn flush(&mut self) -> Option<Vec<u8>> {
        if self.buffer.is_empty() {
            None
        } else {
            let result = self.buffer.clone();
            self.buffer.clear();
            self.last_send = Instant::now();
            Some(result)
        }
    }

    /// 清空缓冲区
    #[allow(dead_code)]
    pub fn clear(&mut self) {
        self.buffer.clear();
    }

    /// 设置节流间隔
    #[allow(dead_code)]
    pub fn set_interval(&mut self, interval_ms: u64) {
        self.interval = Duration::from_millis(interval_ms);
    }
}

impl Default for DataThrottler {
    fn default() -> Self {
        Self::new(50)
    }
}
