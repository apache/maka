//! The native animation graph on the main thread ([`Animator`]): the display link
//! ticks it, drags and scroll offsets update it, and bound properties are
//! written into the views' [`crate::view::ViewState::anim`].

use std::ops::{Deref, DerefMut};

use nsh_core::{
    Points,
    animation::{AnimValues, Animator},
    canvas::Damage,
    geometry::Point,
};

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
            |id| mounter.views.get(&id),
            |view, values, canvas| {
                let update = {
                    let mut s = view.state_mut();
                    let update = Update::between(&s.anim, &values);
                    s.anim = values;
                    update
                };
                match update {
                    Update::None => {}
                    Update::Move { redraw } | Update::Restyle { redraw } => {
                        if matches!(update, Update::Move { .. }) {
                            view.moved();
                        } else {
                            view.restyle();
                        }
                        if redraw {
                            view.redraw();
                        }
                        crate::text_input::animated(view);
                    }
                }
                if !canvas.is_empty() {
                    crate::shader::set_args(view, canvas);
                    let damage = crate::canvas::set_args(view, canvas);
                    if damage != Damage::None {
                        mounter.draw_when_shown(view, damage);
                    }
                }
            },
        );
    }
}

/// What a view does with new animated values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Update {
    /// They did not change.
    None,
    /// The transform changed: the view is placed again (with its opacity)
    /// and decorated again.
    Move { redraw: bool },
    /// Opacity, background or border changed: its layers take them.
    Restyle { redraw: bool },
}

impl Update {
    /// Only the text color reaches what a view draws (`redraw`). A fade or
    /// a background tween must not draw a canvas or text again each frame:
    /// a canvas painted that often moves onto Core Animation's drawing
    /// threads (`canvas.rs`), which holds tens of megabytes of graphics
    /// memory for the process.
    fn between(old: &AnimValues, new: &AnimValues) -> Update {
        let redraw = old.color != new.color;
        if old.transform != new.transform {
            Update::Move { redraw }
        } else if old != new {
            Update::Restyle { redraw }
        } else {
            Update::None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nsh_core::Color;

    /// `AnimValues` is non-exhaustive: built from the default here.
    fn values(f: impl FnOnce(&mut AnimValues)) -> AnimValues {
        let mut v = AnimValues::default();
        f(&mut v);
        v
    }

    #[test]
    fn a_fade_restyles_without_drawing_again() {
        let old = AnimValues::default();
        let faded = values(|v| v.opacity = Some(0.6));
        assert_eq!(
            Update::between(&old, &faded),
            Update::Restyle { redraw: false }
        );
        let tinted = values(|v| {
            v.opacity = Some(0.6);
            v.background = Some(Color(0xff0000ff));
            v.border_color = Some(Color(0x00ff00ff));
        });
        assert_eq!(
            Update::between(&faded, &tinted),
            Update::Restyle { redraw: false }
        );
        assert_eq!(Update::between(&tinted, &tinted), Update::None);
    }

    #[test]
    fn a_text_color_draws_again() {
        let old = AnimValues::default();
        let recolored = values(|v| v.color = Some(Color(0x336699ff)));
        assert_eq!(
            Update::between(&old, &recolored),
            Update::Restyle { redraw: true }
        );
        let moved = values(|v| {
            v.color = Some(Color(0x336699ff));
            v.transform[0] = Some(4.0);
        });
        assert_eq!(
            Update::between(&recolored, &moved),
            Update::Move { redraw: false }
        );
        let both = values(|v| {
            v.color = Some(Color(0x000000ff));
            v.transform[0] = Some(4.0);
        });
        assert_eq!(
            Update::between(&recolored, &both),
            Update::Move { redraw: true }
        );
    }
}
