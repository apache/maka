//! The core's side of the platform services Rust components ask for
//! ([`crate::element::ambient`]'s functions) beyond commands for the
//! platform: display frames and the layout direction.
//!
//! The surface's direction follows the user's language: its root's
//! (`Prop::LayoutDirection` on the root, which JS sets from the language),
//! else the platform's. In a Rust app the core sets the root's direction
//! from the platform's language from the start, and again whenever the
//! language changes. A view's `direction` style sets its own subtree's.

use super::Core;
use crate::{Op, Prop, ROOT_ID, TextEngine, element::AnswerSlot, time::Instant};

/// What the core keeps for the services.
#[derive(Default)]
pub(super) struct Services {
    /// The tasks waiting for the next display frame.
    frames: Vec<AnswerSlot<Instant>>,
    /// The core sets the root's direction from the language (a Rust app).
    owns_direction: bool,
}

impl<M: TextEngine> Core<M> {
    /// Whether a component waits for a display frame: ask the platform for
    /// one, then call [`Self::run_frame`] when it begins.
    pub fn wants_frame(&self) -> bool {
        // A slot only the core holds is a task that is gone.
        self.components
            .services
            .frames
            .iter()
            .any(|slot| std::rc::Rc::strong_count(slot) > 1)
    }

    /// A display frame began at `at`: the tasks waiting for it go on (at
    /// the next [`Self::run_component_tasks`]).
    pub fn run_frame(&mut self, at: Instant) {
        for slot in std::mem::take(&mut self.components.services.frames) {
            slot.borrow_mut().deliver(at);
        }
    }

    pub(super) fn wait_frame(&mut self, slot: AnswerSlot<Instant>) {
        self.components.services.frames.push(slot);
    }

    /// The direction components read, the platform's language being
    /// `platform`; in a Rust app the root follows it.
    pub(super) fn surface_rtl(&mut self, platform: bool) -> bool {
        if self.components.services.owns_direction {
            self.set_root_direction(platform);
            platform
        } else {
            self.nodes[self.root as usize].direction.unwrap_or(platform)
        }
    }

    /// A Rust app: the core sets the surface's direction (no JS does).
    pub(super) fn own_direction(&mut self) {
        self.components.services.owns_direction = true;
        let rtl = self.components.environment.rtl;
        self.set_root_direction(rtl);
    }

    fn set_root_direction(&mut self, rtl: bool) {
        let _ = self.apply_op(Op::SetProp {
            id: ROOT_ID,
            prop: Prop::LayoutDirection(rtl),
        });
    }

    /// The root's direction changed: what read it
    /// runs again.
    pub(super) fn root_direction_changed(&mut self, rtl: bool) {
        if self.components.environment.rtl != rtl {
            let environment = crate::element::Environment {
                rtl,
                ..self.components.environment
            };
            self.apply_environment(environment);
        }
    }
}
