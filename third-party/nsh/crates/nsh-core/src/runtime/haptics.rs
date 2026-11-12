//! `nsh/mobile`'s `Haptics`: what the device plays under the user's finger
//! (iOS's feedback generators, Android's haptic feedback). Elsewhere, and
//! where the device has no haptics or the user turned them off, nothing
//! happens.

use crate::{
    Haptic, HapticImpact, HapticNotification,
    element::{ModuleCx, module},
};

/// Haptics: a selection changing, an impact, a task's outcome.
#[module]
pub(crate) struct Haptics;

#[module]
impl Haptics {
    /// Plays the haptic of a selection changing: a picker's value, a
    /// segment, a slider's step.
    pub(crate) fn selection(cx: &mut ModuleCx) {
        cx.haptic(Haptic::Selection);
    }

    /// Plays the haptic of an element colliding: `style` is its weight
    /// (`"medium"` by default).
    pub(crate) fn impact(style: Option<HapticImpact>, cx: &mut ModuleCx) {
        cx.haptic(Haptic::Impact(style.unwrap_or(HapticImpact::Medium)));
    }

    /// Plays the haptic of a task that ended: `"success"` (the default),
    /// `"warning"` or `"error"`.
    pub(crate) fn notification(kind: Option<HapticNotification>, cx: &mut ModuleCx) {
        cx.haptic(Haptic::Notification(
            kind.unwrap_or(HapticNotification::Success),
        ));
    }
}
