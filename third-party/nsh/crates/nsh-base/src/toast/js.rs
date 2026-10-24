//! The TS face of the toast primitives: `ToastMotion` and `ToastOptions` as
//! plain objects (milliseconds and points), and `ToastManager` as a class
//! over `ToastManager<string, unknown>` whose clock is the engine's.

use std::time::Duration;

use nsh_core::{
    JsonValue, Points,
    time::now,
    ui::{JsHost, JsIn, JsOwned, JsValue, PropError, TsTypes, prelude::*},
};

use super::{ToastMotion as Motion, ToastOptions as Options, ToastTransitionStatus};

/// Milliseconds as a duration (none for a negative or not finite number).
fn ms(n: f64) -> Option<Duration> {
    (n.is_finite() && n >= 0.0).then(|| Duration::from_secs_f64(n / 1000.0))
}

/// Motion tokens of a toast stack and its manager (`ToastMotion.sonner()`
/// by default; omitted fields keep Sonner's).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct ToastMotion {
    /// Milliseconds: the time scale of the stack's motion (the manager's
    /// deadline for a toast to be present, the stack's spring response).
    duration: Option<f64>,
    /// Milliseconds an ending toast stays mounted.
    exit_duration: Option<f64>,
    /// The visible distance between collapsed layers.
    collapsed_peek: Option<Points>,
    /// The distance between expanded items.
    expanded_gap: Option<Points>,
    /// The fraction of the width each collapsed layer loses.
    collapsed_scale_step: Option<f64>,
    /// How many layers show while the stack is collapsed.
    collapsed_visible: Option<usize>,
}

impl From<ToastMotion> for Motion {
    fn from(m: ToastMotion) -> Self {
        let d = Motion::sonner();
        Motion {
            duration: m.duration.and_then(ms).unwrap_or(d.duration),
            exit_duration: m.exit_duration.and_then(ms).unwrap_or(d.exit_duration),
            collapsed_peek: m.collapsed_peek.unwrap_or(d.collapsed_peek),
            expanded_gap: m.expanded_gap.unwrap_or(d.expanded_gap),
            collapsed_scale_step: m
                .collapsed_scale_step
                .map_or(d.collapsed_scale_step, |s| s as f32),
            collapsed_visible: m.collapsed_visible.unwrap_or(d.collapsed_visible),
        }
    }
}

impl From<Motion> for ToastMotion {
    fn from(m: Motion) -> Self {
        Self {
            duration: Some(m.duration.as_secs_f64() * 1000.0),
            exit_duration: Some(m.exit_duration.as_secs_f64() * 1000.0),
            collapsed_peek: Some(m.collapsed_peek),
            expanded_gap: Some(m.expanded_gap),
            collapsed_scale_step: Some(f64::from(m.collapsed_scale_step)),
            collapsed_visible: Some(m.collapsed_visible),
        }
    }
}

/// TS: a `ToastMotion` object.
impl JsValue for Motion {
    fn ts_type(types: &mut TsTypes) -> String {
        ToastMotion::ts_type(types)
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if value.is_nullish() {
            return Ok(Motion::sonner());
        }
        ToastMotion::from_js(value).map(Into::into)
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        ToastMotion::from(*self).to_js(host)
    }
}

/// Options of a toast entering a `ToastManager`.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct ToastOptions {
    /// Milliseconds it is present before it is dismissed by itself;
    /// `null`, `Infinity` or left out: never.
    timeout: Option<f64>,
}

/// A mounted toast of a `ToastManager`.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct ToastEntry {
    /// Its id.
    id: String,
    /// The app's value.
    value: JsonValue,
    /// Its lifecycle phase.
    status: ToastTransitionStatus,
}

/// What a `ToastManager`'s `advance` changed.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct ToastAdvance {
    /// A mounted toast changed phase or membership.
    changed: bool,
    /// The toasts whose enter transition completed.
    presented: Vec<String>,
    /// The toasts that began their exit transition (their timeout ran out).
    ending: Vec<String>,
    /// The toasts removed after their exit transition.
    removed: Vec<ToastEntry>,
}

/// Ordered toast storage, lifecycle, auto-hide, limits and exit
/// coordination, headless, as `gpui-base`'s `ToastManager`: the app keeps
/// its toasts here, renders `visible(limit)` as `Toast`s in a
/// `ToastStack` with their `status`, and calls `advance` on a timer while
/// any is mounted (`paused` while the stack is expanded). Its clock is the
/// engine's.
#[class]
#[derive(Debug)]
pub(crate) struct ToastManager {
    inner: super::ToastManager<String, JsonValue>,
}

fn entry((id, value, status): (&String, &JsonValue, ToastTransitionStatus)) -> ToastEntry {
    ToastEntry {
        id: id.clone(),
        value: value.clone(),
        status,
    }
}

#[class]
impl ToastManager {
    /// A manager whose enter and exit take `motion`'s durations (Sonner's
    /// without one).
    pub(crate) fn new(motion: Option<Motion>) -> Self {
        Self {
            inner: super::ToastManager::new(motion.unwrap_or_default()),
        }
    }

    /// Adds the newest toast, replacing one with the same `id`, whose value
    /// it returns.
    pub(crate) fn push(
        &mut self,
        id: String,
        value: JsonValue,
        options: Option<ToastOptions>,
    ) -> Option<JsonValue> {
        let timeout = options.and_then(|o| o.timeout).and_then(ms);
        self.inner.push(id, value, Options::timeout(timeout), now())
    }

    /// Begins a toast's exit transition; whether its state changed.
    pub(crate) fn dismiss(&mut self, id: String) -> bool {
        self.inner.dismiss(&id, now())
    }

    /// Begins the exit transition of every toast that is not ending; their
    /// ids.
    pub(crate) fn dismiss_all(&mut self) -> Vec<String> {
        self.inner.dismiss_all(now())
    }

    /// Advances the lifecycle to now; present toasts' timeouts stand still
    /// while `paused`.
    pub(crate) fn advance(&mut self, paused: Option<bool>) -> ToastAdvance {
        let a = self.inner.advance(now(), paused.unwrap_or(false));
        ToastAdvance {
            changed: a.changed,
            presented: a.presented,
            ending: a.ending,
            removed: a
                .removed
                .into_iter()
                .map(|(id, value)| ToastEntry {
                    id,
                    value,
                    status: ToastTransitionStatus::Ending,
                })
                .collect(),
        }
    }

    /// The mounted toasts, oldest first.
    pub(crate) fn entries(&self) -> Vec<ToastEntry> {
        self.inner.iter().map(entry).collect()
    }

    /// The newest `limit` toasts that are not ending, and the ending ones,
    /// oldest first.
    pub(crate) fn visible(&self, limit: usize) -> Vec<ToastEntry> {
        self.inner.visible(limit).map(entry).collect()
    }

    /// A mounted toast's value.
    pub(crate) fn get(&self, id: String) -> Option<JsonValue> {
        self.inner.get(&id).cloned()
    }

    /// The number of mounted toasts, ending ones included.
    pub(crate) fn len(&self) -> usize {
        self.inner.len()
    }

    /// No toast is mounted.
    pub(crate) fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }
}
