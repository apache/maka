//! The message channel between an embedding app and the app one of its
//! surfaces runs (`nsh/host`): the embedding app's launch parameters, its
//! events to the app and the app's calls and posts to it, as JSON values.
//!
//! The pieces every side shares live here: the names' rules, the limits,
//! [`HostBridge`] (what the app's module reaches of the embedding app; the
//! engine's `HostChannel` implements it) and [`HostInbox`] (the events kept
//! until a listener is there). The engine (`nsh_engine::HostChannel`) owns
//! the embedding app's side, `nsh-js` (`host_channel.rs`) the app's.

use std::{collections::VecDeque, time::Duration};

use crate::{
    JsonValue,
    element::{JsError, codes},
};

/// Events kept at most for listeners not there yet: by an engine, until
/// the app listens to their names, and by the embedding app's channel,
/// while no app runs. Past it the oldest goes (logged).
pub const MAX_QUEUED_EVENTS: usize = 256;

/// Calls of one app waiting for the embedding app's answers at once; one
/// more rejects ([`too_many_calls`]).
pub const MAX_PENDING_CALLS: usize = 1024;

/// The longest name of an event, a call or a post, in bytes.
pub const MAX_NAME_LEN: usize = 256;

/// Checks the name of an event, a call or a post: one to
/// [`MAX_NAME_LEN`] bytes. The error says what is wrong.
pub fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("a message name is not empty".into());
    }
    if name.len() > MAX_NAME_LEN {
        return Err(format!(
            "a message name has at most {MAX_NAME_LEN} bytes (this one has {})",
            name.len()
        ));
    }
    Ok(())
}

/// What a call rejects with when the platform has no host
/// ([`codes::UNAVAILABLE`]).
pub fn no_host() -> JsError {
    JsError::Error("nsh/host: this platform has no host".into()).with_code(codes::UNAVAILABLE)
}

/// What a call rejects with when the embedding app answered with error
/// `message` (its handler failed, or it handles no such name): the host's
/// message, [`codes::HOST_ERROR`].
pub fn host_error(message: &str) -> JsError {
    JsError::Error(message.to_owned()).with_code(codes::HOST_ERROR)
}

/// What a call or post of `name`, which no host function may have
/// ([`crate::access::valid_host_name`]), fails with: a `TypeError`.
pub fn invalid_name(name: &str) -> JsError {
    JsError::Type(format!(
        "nsh/host: invalid function name {name:?} ({})",
        crate::access::HOST_NAME_CHARS
    ))
}

/// What a call or post of `name` fails with when `capabilities.host` does
/// not grant it ([`JsError::access_denied`], permission `"host"`).
pub fn not_granted(name: &str) -> JsError {
    JsError::access_denied(
        format!("nsh/host: `{name}` is not granted: add it to capabilities.host in nsh.json"),
        "host",
        name,
    )
}

/// Checks a call or post of `name` against the host names' rules and the
/// app's `access`, before it crosses into the embedding app's code.
pub fn check_call(access: &crate::access::Access, name: &str) -> Result<(), JsError> {
    if !crate::access::valid_host_name(name) {
        return Err(invalid_name(name));
    }
    if !access.allows_host(name) {
        return Err(not_granted(name));
    }
    Ok(())
}

/// What a call of `name` rejects with when the embedding app did not answer
/// within `timeout` ([`codes::TIMED_OUT`]).
pub fn timed_out(name: &str, timeout: Duration) -> JsError {
    JsError::Error(format!(
        "nsh/host: {name} timed out after {} ms",
        timeout.as_millis()
    ))
    .with_code(codes::TIMED_OUT)
}

/// What a call of `name` rejects with while [`MAX_PENDING_CALLS`] calls
/// wait already ([`codes::QUOTA_EXCEEDED`]).
pub fn too_many_calls(name: &str) -> JsError {
    JsError::Error(format!(
        "host.call(\"{name}\"): {MAX_PENDING_CALLS} calls already wait for the embedding app's answers"
    ))
    .with_code(codes::QUOTA_EXCEEDED)
}

/// What an app's `nsh/host` reaches of the embedding app, on the engine
/// thread: the launch parameters, and where its calls and posts go. The
/// engine implements it over the embedding app's channel; the answer to a
/// call comes back to the VM later, by its id.
pub trait HostBridge {
    /// Whether the native embedding app configured this channel. A false
    /// value leaves calls to the platform transport (including the web).
    fn available(&self) -> bool {
        true
    }

    /// The launch parameters the embedding app set before the app started
    /// (a JSON object; `{}` without any).
    fn params(&self) -> JsonValue;

    /// Hands call `id` (`host.call(name, data)`) to the embedding app's
    /// handler of `name`. `Err` with the reason when there is none: the
    /// call fails at once. Otherwise its answer comes back by `id`, once.
    fn call(&self, id: u64, name: &str, data: JsonValue) -> Result<(), String>;

    /// Hands a post (`host.post(name, data)`) to the embedding app's
    /// handler of `name`; without one it is dropped.
    fn post(&self, name: &str, data: JsonValue);
}

/// Events kept for listeners not there yet, oldest first, at most
/// [`MAX_QUEUED_EVENTS`].
#[derive(Debug, Default)]
#[non_exhaustive]
pub struct HostInbox {
    events: VecDeque<(String, JsonValue)>,
}

impl HostInbox {
    /// Keeps event `name` with `data`; when full, the oldest event goes
    /// first and is returned.
    pub fn push(&mut self, name: String, data: JsonValue) -> Option<(String, JsonValue)> {
        let dropped = (self.events.len() >= MAX_QUEUED_EVENTS)
            .then(|| self.events.pop_front())
            .flatten();
        self.events.push_back((name, data));
        dropped
    }

    /// Whether an event named `name` is kept.
    pub fn has(&self, name: &str) -> bool {
        self.events.iter().any(|(n, _)| n == name)
    }

    /// Takes the oldest event named `name`, leaving every other event in
    /// its original order.
    pub fn pop(&mut self, name: &str) -> Option<JsonValue> {
        let index = self.events.iter().position(|(n, _)| n == name)?;
        self.events.remove(index).map(|(_, data)| data)
    }

    /// Takes the events named `name`, in the order they came.
    pub fn take(&mut self, name: &str) -> Vec<JsonValue> {
        let mut taken = Vec::new();
        self.events.retain_mut(|(n, data)| {
            if n == name {
                taken.push(std::mem::take(data));
                false
            } else {
                true
            }
        });
        taken
    }

    /// Takes every event, in the order they came.
    pub fn take_all(&mut self) -> Vec<(String, JsonValue)> {
        self.events.drain(..).collect()
    }

    /// How many events are kept.
    pub fn len(&self) -> usize {
        self.events.len()
    }

    /// Whether no event is kept.
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn names_are_checked() {
        assert!(check_name("user.changed").is_ok());
        assert!(check_name("").is_err());
        assert!(check_name(&"x".repeat(MAX_NAME_LEN)).is_ok());
        assert!(check_name(&"x".repeat(MAX_NAME_LEN + 1)).is_err());
    }

    #[test]
    fn the_inbox_keeps_events_by_name_in_order() {
        let mut inbox = HostInbox::default();
        inbox.push("a".into(), json!(1));
        inbox.push("b".into(), json!(2));
        inbox.push("a".into(), json!(3));
        assert!(inbox.has("a"));
        assert_eq!(inbox.take("a"), vec![json!(1), json!(3)]);
        assert!(!inbox.has("a"));
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox.take_all(), vec![("b".to_owned(), json!(2))]);
        assert!(inbox.is_empty());
    }

    #[test]
    fn popping_one_event_preserves_the_age_of_the_rest() {
        let mut inbox = HostInbox::default();
        inbox.push("a".into(), json!(1));
        inbox.push("b".into(), json!(2));
        inbox.push("a".into(), json!(3));
        assert_eq!(inbox.pop("missing"), None);
        assert_eq!(inbox.pop("a"), Some(json!(1)));
        assert_eq!(inbox.len(), 2);
        assert_eq!(
            inbox.take_all(),
            vec![("b".to_owned(), json!(2)), ("a".to_owned(), json!(3))]
        );
    }

    #[test]
    fn a_full_inbox_drops_the_oldest() {
        let mut inbox = HostInbox::default();
        for i in 0..MAX_QUEUED_EVENTS {
            assert_eq!(inbox.push("e".into(), json!(i)), None);
        }
        assert_eq!(
            inbox.push("e".into(), json!("last")),
            Some(("e".to_owned(), json!(0)))
        );
        let kept = inbox.take("e");
        assert_eq!(kept.len(), MAX_QUEUED_EVENTS);
        assert_eq!(kept[0], json!(1));
        assert_eq!(kept[MAX_QUEUED_EVENTS - 1], json!("last"));
    }
}
