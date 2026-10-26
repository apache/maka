//! Everything gpui-fast adds to the Windows platform lives under this module.
//!
//! The rest of this crate is kept as close to upstream GPUI (Zed's
//! `crates/gpui_windows`) as possible, so that pulling in upstream changes
//! stays a matter of merging rather than of rewriting. Upstream files only
//! *call into* this module: a field holding this module's state, a line
//! forwarding a call to it. The logic itself is written here, one file per
//! topic.

pub(crate) mod class_names;
pub(crate) mod composition;
pub(crate) mod device_wake;
pub(crate) mod draw_state;
pub(crate) mod frame;
pub(crate) mod frame_schedule;
pub(crate) mod globals;
pub(crate) mod layers;
#[cfg(test)]
pub(crate) mod native_tests;
pub(crate) mod rounded_clip;
