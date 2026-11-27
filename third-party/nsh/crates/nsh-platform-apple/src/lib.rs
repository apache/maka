//! Code shared by `nsh-platform-macos` and `nsh-platform-ios` (and their
//! release runners: `unified_log`): both build on the same Apple frameworks
//! for these. A crate of its own so each backend builds from its published
//! package (a `#[path]` into a sibling crate does not ship with it).
#![cfg(any(target_os = "macos", target_os = "ios"))]

pub mod audio;
pub mod canvas_image;
// CoreText attribute keys, RTL decoration spans and truncated-line alignment
// shared by `nsh-platform-macos` and `nsh-platform-ios`, no API of apps':
// hidden from the docs, so it stays out of what NSH keeps compatible.
#[doc(hidden)]
pub mod core_text;
pub mod handoff;
// Which images of a decoded file the macOS and iOS backends show, no API of
// apps': hidden from the docs, so it stays out of what NSH keeps compatible.
#[doc(hidden)]
pub mod image_source;
// The path monitor and the cellular data permission behind `network()`,
// read by the backends' environments, no API of apps': hidden from the
// docs, so it stays out of what NSH keeps compatible.
#[doc(hidden)]
pub mod network;
pub mod notifications;
// Whether a view shows through the ancestors that clip it, for the backends'
// view trees, no API of apps': hidden from the docs, so it stays out of what
// NSH keeps compatible.
#[doc(hidden)]
pub mod sight;
// How drawn text splits into screen reader elements on macOS and iOS, no API
// of apps': hidden from the docs, so it stays out of what NSH keeps compatible.
#[doc(hidden)]
pub mod text_access;
// The logger NSH's release runners and its iOS SDK install, no API of apps':
// hidden from the docs, so it stays out of what NSH keeps compatible.
#[doc(hidden)]
pub mod unified_log;
// The `WKDownload` transport iOS and macOS share, no API of apps': hidden
// from the docs, so it stays out of what NSH keeps compatible.
#[doc(hidden)]
pub mod web_download;
pub mod web_evaluation;
pub mod web_scheme;
