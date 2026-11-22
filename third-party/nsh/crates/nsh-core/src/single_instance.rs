//! One instance of the app (`nsh.json` `"singleInstance": true`, desktops):
//! a second launch of the app hands its command line to the running
//! instance and exits before it opens a window or starts an engine.
//!
//! The release runner checks for a running instance as it starts, keyed on
//! the app's id (Windows: a named mutex and `WM_COPYDATA`; Linux:
//! GApplication's D-Bus uniqueness). The running instance's platform
//! reports the launch as the root's
//! [`EventKind::SecondInstance`](crate::EventKind::SecondInstance); the
//! core holds launches until the app listens
//! ([`crate::element::next_second_instance`]), at most [`MAX_PENDING`]. The
//! running instance's main window is brought forward; what else the launch
//! means (a path on the command line, say) is the app's.
//!
//! macOS runs one instance of an app bundle already (Launch Services
//! activates the running one), so nothing is reported there; files and
//! links come through `UrlScheme` as always. iOS, Android and the web have
//! no second launch.

use crate::{EventPayload, JsonValue};

/// The most launches kept while no listener takes them: past it the oldest
/// goes.
pub const MAX_PENDING: usize = 16;

/// A later launch of the app (TS: `Application.on("secondInstance", ...)`,
/// Rust: [`next_second_instance`](crate::element::next_second_instance)).
/// Anyone can start the app with any arguments: they are untrusted input.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct SecondInstance {
    /// Its command line's arguments, the program's path not included.
    pub args: Vec<String>,
    /// The directory it was started in, which relative paths among
    /// [`args`](Self::args) are relative to; empty when unknown.
    pub cwd: String,
}

impl SecondInstance {
    /// A launch with `args` started in `cwd`.
    pub fn new(args: Vec<String>, cwd: impl Into<String>) -> Self {
        Self {
            args,
            cwd: cwd.into(),
        }
    }

    /// The payload of [`EventKind::SecondInstance`](crate::EventKind::SecondInstance)
    /// carrying it.
    pub fn to_payload(&self) -> EventPayload {
        EventPayload::Json(self.to_json())
    }

    /// As JSON: `{ "args": [...], "cwd": "..." }`, the form a second
    /// process hands the first.
    pub fn to_json(&self) -> JsonValue {
        serde_json::json!({ "args": self.args, "cwd": self.cwd })
    }

    /// The launch [`Self::to_json`] wrote; `None` for anything else.
    pub fn from_json(value: &JsonValue) -> Option<Self> {
        let args = value
            .get("args")?
            .as_array()?
            .iter()
            .map(|arg| arg.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()?;
        let cwd = value
            .get("cwd")
            .and_then(JsonValue::as_str)
            .unwrap_or_default();
        Some(Self::new(args, cwd))
    }

    /// The launch a payload of
    /// [`EventKind::SecondInstance`](crate::EventKind::SecondInstance) carries.
    pub fn from_payload(payload: &EventPayload) -> Option<Self> {
        match payload {
            EventPayload::Json(value) => Self::from_json(value),
            _ => None,
        }
    }

    /// This process's launch: its arguments after the program and its
    /// working directory.
    pub fn current() -> Self {
        Self::new(
            std::env::args().skip(1).collect(),
            std::env::current_dir()
                .map(|dir| dir.to_string_lossy().into_owned())
                .unwrap_or_default(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_launch_goes_through_its_payload() {
        let launch = SecondInstance::new(vec!["--open".into(), "a b.txt".into()], "/home/u");
        assert_eq!(
            SecondInstance::from_payload(&launch.to_payload()),
            Some(launch.clone())
        );
        assert_eq!(
            launch.to_json(),
            serde_json::json!({ "args": ["--open", "a b.txt"], "cwd": "/home/u" })
        );
    }

    #[test]
    fn other_payloads_are_no_launch() {
        assert_eq!(SecondInstance::from_payload(&EventPayload::None), None);
        assert_eq!(
            SecondInstance::from_json(&serde_json::json!({ "args": [1] })),
            None
        );
        assert_eq!(
            SecondInstance::from_json(&serde_json::json!({ "args": [] })),
            Some(SecondInstance::default())
        );
    }
}
