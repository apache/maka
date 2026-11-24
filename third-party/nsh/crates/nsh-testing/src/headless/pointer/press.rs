//! Press ownership and the long-press deadline of a synthesized finger.

use std::time::Duration;

use nsh_core::{EventKind, EventPayload, geometry::point};

use super::{Finger, Headless};

impl Headless {
    /// The press under the finger goes in (`onPressDown`).
    pub(super) fn press_in(&mut self, finger: &mut Finger) {
        let Some(press) = &mut finger.press else {
            return;
        };
        let Some(kind) = press.press_in() else {
            return;
        };
        // Where the drag starts, in the pressed view, with the keys held:
        // a press that selects or drags from there reads them.
        let node = press.node;
        let at = self
            .screen
            .bounds_in_root(node)
            .map(|b| point(finger.start.x - b.origin.x, finger.start.y - b.origin.y));
        let payload = self.press_payload(node, at);
        self.send(node, kind, payload);
    }

    pub(super) fn long_press_due(&mut self, finger: &mut Finger) {
        let Some(at) = finger.long_at else { return };
        if finger.press.is_none() {
            finger.long_at = None;
            return;
        }
        if self.clock.now() < at {
            return;
        }
        finger.long_at = None;
        // UIKit presses in at the long deadline even inside a scroll's delayed press.
        self.press_in(finger);
        let Some(press) = &mut finger.press else {
            return;
        };
        if press.long {
            return;
        }
        press.long = true;
        let node = press.target(EventKind::LongPress);
        let at = self
            .screen
            .bounds_in_root(node)
            .map(|b| point(finger.start.x - b.origin.x, finger.start.y - b.origin.y));
        let payload = self.press_payload(node, at);
        self.send(node, EventKind::LongPress, payload);
    }

    pub(in crate::headless) fn tick_held_press(&mut self) {
        if let Some(mut finger) = self.finger.take() {
            self.long_press_due(&mut finger);
            self.finger = Some(finger);
        }
    }

    pub(in crate::headless) fn held_press_timeout(&self) -> Option<Duration> {
        self.finger
            .as_ref()?
            .long_at
            .map(|at| at.saturating_duration_since(self.clock.now()))
    }

    /// The finger moved away from its press: it ends without a press.
    pub(super) fn cancel_press(&mut self, finger: &mut Finger) {
        if let Some(mut press) = finger.press.take() {
            for kind in press.press_out(false) {
                self.send(press.target(kind), kind, EventPayload::None);
            }
        }
    }
}
