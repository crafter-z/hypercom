/**
 * Tauri 命令层 (Command Layer)
 * 前端通过 invoke 调用的 Rust 函数按领域拆分在本目录子模块中。
 */
mod config;
mod file;
mod log;
mod popout;
mod serial;
mod simulation;
mod storage;
mod system_cmds;

pub use config::*;
pub use file::*;
pub use log::*;
pub use popout::*;
pub use serial::*;
pub use simulation::*;
pub use storage::*;
pub use system_cmds::*;

#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error("Serial error: {0}")]
    Serial(String),
    #[error("Config error: {0}")]
    Config(String),
    #[error("Log error: {0}")]
    Log(String),
    #[error("System error: {0}")]
    System(String),
    #[error("Lock error: {0}")]
    Lock(String),
    #[error("IO error: {0}")]
    Io(String),
    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.to_string().as_ref())
    }
}
