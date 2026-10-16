//! Tests that need the crate's own types.
//!
//! Inside the crate rather than in `tests/`, because an integration test is an
//! external consumer and would otherwise be a reason to publish an internal
//! representation. `SpecOp`, `ViewObject` and `materialize` are how the runtime
//! talks to itself; a test asserting on them is not a reason for an application
//! to be able to see them.

mod benchmark;
mod dock;
mod fs;
mod host_api;
mod http_request;
mod network;
mod process;
mod render;
mod snapshot;
// Counts frames and scroll-layer work with GPUI-fast's test statistics.
#[cfg(feature = "gpui-fast")]
mod spin;
mod standard_runtime;
mod structure;
mod template;
mod text_style;
