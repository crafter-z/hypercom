//! Transport-independent automation domain and the opt-in local adapter.
//!
//! The core and wire transport are intentionally separate: callers must establish
//! identity, permissions, lease/fence and operation semantics in the embedding host.
pub mod core;
pub(crate) mod identity;
pub(crate) mod port_watch;
pub mod runtime;
pub mod transport;
pub mod wire;
