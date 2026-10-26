//! The native animation graph on the main thread ([`Animator`]): the frame ticker
//! ticks it, drags and scroll offsets update it, and bound properties are
//! written into the views' [`crate::view::ViewState::anim`].

use std::ops::{Deref, DerefMut};

use nsh_core::{Points, animation::Animator, geometry::Point};

use crate::mount::Mounter;

/// The surface's [`Animator`], writing into this backend's views.
#[derive(Default)]
pub(crate) struct UiAnimation(Animator);

impl Deref for UiAnimation {
    type Target = Animator;

    fn deref(&self) -> &Animator {
        &self.0
    }
}

impl DerefMut for UiAnimation {
    fn deref_mut(&mut self) -> &mut Animator {
        &mut self.0
    }
}

impl UiAnimation {
    /// A scroll view moved: feeds its scroll value.
    pub(crate) fn scrolled(&mut self, id: u32, x: f32, y: f32) -> bool {
        self.0.scrolled(id, Point::new(Points(x), Points(y)))
    }

    /// Scroll view `id` came to rest: true if a snapping value settles.
    pub(crate) fn scroll_ended(&mut self, id: u32) -> bool {
        self.0.scroll_ended(id)
    }

    /// The drag moved by `(tx, ty)` points since it began.
    pub(crate) fn pan_moved(&mut self, id: u32, tx: f32, ty: f32) {
        self.0.pan_moved(id, Point::new(Points(tx), Points(ty)));
    }

    /// Hands `set` the bound native component props that moved, for the
    /// views `has` says hold a made component (the others get theirs once
    /// they do).
    pub(crate) fn write_components(
        &mut self,
        has: impl Fn(u32) -> bool,
        mut set: impl FnMut(u32, &str, nsh_core::animation::AnimatedPropValue),
    ) {
        self.0.write_components(
            |id| has(id).then_some(id),
            |id, name, value| set(id, name, value),
        );
    }

    /// Writes every bound property's current value into its view.
    pub(crate) fn write(&mut self, mounter: &Mounter) {
        self.0.write(
            |id| mounter.views.get(id),
            |view, values, canvas| {
                let view = &view;
                let moved = {
                    let mut s = view.state_mut();
                    let moved = s.anim.transform != values.transform;
                    let changed = moved || s.anim != values;
                    s.anim = values;
                    changed.then_some(moved)
                };
                match moved {
                    Some(true) => view.moved(),
                    Some(false) => view.changed(),
                    None => {}
                }
                if moved.is_some() {
                    crate::text_input::animated(view);
                }
                for &(k, value) in canvas {
                    crate::canvas::set_arg(view, k, value);
                }
            },
        );
    }
}
