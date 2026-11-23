//! Shared timing for the headless driver and native test agents.

use std::time::Duration;

pub(crate) const LANDING: Duration = Duration::from_millis(100);

/// How a drag moves (`nsh/test`'s `DragOptions`): [`crate::Headless::drag`]
/// and [`crate::Headless::drag_and_hold`], and the agents' `Native::drag`
/// and `Native::drag_and_hold`.
///
/// ```
/// # use std::time::Duration;
/// let options = nsh_testing::DragOptions::default().hold(Duration::from_millis(600));
/// ```
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct DragOptions {
    /// How long the pointer rests where it lands before it moves, in all:
    /// 100 ms when `None`. A hold past a press's `delayLongPress` delivers
    /// the long press before movement.
    pub hold: Option<Duration>,
}

impl DragOptions {
    /// Sets the total rest before the pointer begins moving.
    pub fn hold(mut self, hold: Duration) -> Self {
        self.hold = Some(hold);
        self
    }

    /// The hold in milliseconds, as `TestStep::Drag` and step names carry it.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn hold_ms(self) -> Option<f64> {
        self.hold.map(|hold| hold.as_nanos() as f64 / 1_000_000.0)
    }

    /// The options a test's `hold` in milliseconds asks for.
    #[cfg(any(feature = "js", feature = "agent"))]
    pub(crate) fn from_ms(hold: Option<f64>) -> Result<Self, String> {
        let hold = hold
            .map(|ms| {
                Duration::try_from_secs_f64(ms / 1000.0)
                    .map_err(|_| format!("a drag hold is milliseconds, zero or more, not {ms}"))
            })
            .transpose()?;
        Ok(Self { hold })
    }
}
