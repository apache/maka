//! Code shared by `nsh-platform-macos` and `nsh-platform-ios` (and their
//! release runners: `unified_log`): both build on the same Apple frameworks
//! for these. A crate of its own so each backend builds from its published
//! package (a `#[path]` into a sibling crate does not ship with it).
#![cfg(any(target_os = "macos", target_os = "ios"))]

pub mod audio;
pub mod notifications;
pub mod speech;
// The logger NSH's release runners and its iOS SDK install, no API of apps':
// hidden from the docs, so it stays out of what NSH keeps compatible.
#[doc(hidden)]
pub mod unified_log;
pub mod web_evaluation;
pub mod web_scheme;
