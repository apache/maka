//! Animated changes of views: `LayoutAnimation` (frames, insertions,
//! removals), style `transition`s and keyframe `animation`s (`spin`,
//! `ping`, `pulse`, `bounce`), run on the frame clock. How they animate
//! is [`nsh_core::transition`]'s; this module decides which views
//! animate and runs their frames.
//!
//! A view that animates gets a [`Live`] in [`ViewState::live`] and a frame
//! client ([`Surface::on_frame`]) that runs until nothing is left to
//! animate; other views carry nothing and cost nothing.
//!
//! Frames and styles are animated by writing the in-between values into
//! the view's state (`frame`, `style`) on every tick while [`Live`] keeps
//! the targets: everything that draws reads the current value without
//! knowing about transitions, and a change that arrives mid-animation
//! (the mounter replaces the state with the new target and hands the
//! replaced value over as `old`) starts from where the view is, as
//! UIKit's `beginFromCurrentState`. Native animation values
//! ([`ViewState::anim`]) still override the style.
//!
//! Appearing / disappearing views and keyframes do not touch the style:
//! they multiply the opacity ([`Live::opacity`]) and add a transform after
//! the style's ([`Live::extra`], [`apply_extra`]), which [`ViewState`]
//! applies.
//!
//! [`ViewState`]: crate::view::ViewState
//! [`ViewState::live`]: crate::view::ViewState::live
//! [`ViewState::anim`]: crate::view::ViewState::anim

use std::rc::Rc;

pub(crate) use nsh_core::transition::Live;
use nsh_core::{
    AttributedText, Bounds, LayoutAnimation, Points, ViewKind, ViewStyle,
    transition::{self, Extra},
};

use crate::{geom::Mat4, surface::Surface, view::NshView};

/// `m` followed by `extra` (in the view's local space: like `m`'s own
/// entries, it applies to points before them).
pub(crate) fn apply_extra(extra: Extra, mut m: Mat4, height: f32) -> Mat4 {
    if extra.shift_y.0 != 0.0 {
        m = m.translate(0.0, extra.shift_y.0 * height);
    }
    if extra.rotate.0 != 0.0 {
        m = m.rotate(extra.rotate.to_degrees());
    }
    if extra.scale != 1.0 {
        m = m.scale(extra.scale, extra.scale);
    }
    m
}

fn reduce_motion(surface: &Surface) -> bool {
    surface.environment.get().reduce_motion
}

/// Views whose frames, appearing and disappearing belong to navigation
/// (stacks, screens, modals, header items) or that are not drawn in their
/// parent.
fn navigated(view: &NshView) -> bool {
    matches!(
        view.kind(),
        ViewKind::Stack
            | ViewKind::Screen
            | ViewKind::Modal
            | ViewKind::HeaderItem
            | ViewKind::InputAccessory
    ) || view
        .parent_view()
        .is_some_and(|p| p.kind() == ViewKind::Stack)
}

/// Runs `f` on the view's [`Live`] (made if needed) and makes sure it
/// ticks while something animates.
fn animate(surface: &Rc<Surface>, view: &NshView, f: impl FnOnce(&mut Live)) {
    let mut s = view.state_mut();
    let live = s.live.get_or_insert_with(Box::default);
    f(live);
    if live.ticking() {
        // The tick drops it once idle.
    } else if live.idle() {
        s.live = None;
    } else {
        live.set_ticking(true);
        drop(s);
        let view = view.clone();
        surface.on_frame(move |surface, now| tick(surface, &view, now * 1000.0));
    }
}

/// `view` was inserted into its parent.
pub(crate) fn inserted(surface: &Rc<Surface>, view: &NshView, animation: Option<&LayoutAnimation>) {
    if view.state().live.is_some() {
        // Ticks stop while a view is out of the tree; going on resumes them.
        animate(surface, view, |_| {});
    }
    if view.state().live.as_ref().is_some_and(|l| l.dying()) {
        // Back (or moved) before its removal finished animating (which
        // also makes it take the pointer again).
        animate(surface, view, Live::revive);
        view.moved();
    }
    let Some(t) = animation.and_then(|a| a.create) else {
        return;
    };
    // Views moved to another place were laid out before; new ones were not.
    if view.state().frame != Bounds::default() || reduce_motion(surface) || navigated(view) {
        return;
    }
    animate(surface, view, |live| live.appear(t));
    view.moved();
}

/// `view` is removed from its parent or deleted: true if it animates out
/// (and detaches itself when done), false to detach it now.
///
/// Removed views are animated, as UIKit's backend does: a view leaving the
/// tree is removed in the commit that configured the animation, while its
/// deletion follows whenever JS releases it.
pub(crate) fn removing(
    surface: &Rc<Surface>,
    view: &NshView,
    animation: Option<&LayoutAnimation>,
) -> bool {
    let Some(t) = animation.and_then(|a| a.delete) else {
        return false;
    };
    if view.parent_view().is_none() || reduce_motion(surface) || navigated(view) {
        return false;
    }
    if view.state().live.as_ref().is_some_and(|l| l.dying()) {
        // Deleted while its removal animates.
        return true;
    }
    animate(surface, view, |live| live.disappear(t));
    true
}

/// `view` is deleted and does not animate out: its animations end with it.
/// A keyframe `animation` repeats for good, and its frame callback would
/// keep the deleted view and the display frames going.
pub(crate) fn deleted(view: &NshView) {
    view.state_mut().live = None;
}

/// The frame a running layout animation of `view` is heading to, if any.
pub(crate) fn frame_target(view: &NshView) -> Option<Bounds<Points>> {
    view.state().live.as_ref()?.frame_target()
}

/// `view`'s frame changed from `old` (the new one is in its state).
pub(crate) fn frame_changed(
    surface: &Rc<Surface>,
    view: &NshView,
    old: Bounds<Points>,
    animation: Option<&LayoutAnimation>,
) {
    // A view's first frame (from the zero rect) does not animate.
    let update = animation
        .and_then(|a| a.update)
        .filter(|_| old != Bounds::default() && !reduce_motion(surface) && !navigated(view));
    let Some(t) = update else {
        // The new frame applies at once, stopping a running animation.
        if let Some(live) = view.state_mut().live.as_deref_mut() {
            live.stop_frame();
        }
        return;
    };
    // The old frame shows until the first tick.
    let to = std::mem::replace(&mut view.state_mut().frame, old);
    animate(surface, view, |live| live.move_frame(old, to, t));
}

/// `view`'s style changed from `old` (the new one is in its state).
pub(crate) fn style_changed(surface: &Rc<Surface>, view: &NshView, old: &ViewStyle) {
    let reduce = reduce_motion(surface);
    let restyle = transition::restyle(old, &mut view.state_mut().style, reduce);
    let Some(restyle) = restyle else {
        if let Some(live) = view.state_mut().live.as_deref_mut() {
            live.stop_style();
        }
        return;
    };
    animate(surface, view, |live| live.restyle(restyle));
}

/// `view`'s text changed from `old` (the new one is in its state): its
/// color transitions as its style's `transition` says, drawn over the new
/// runs ([`Live::text_color`]) rather than typeset on every frame.
pub(crate) fn text_changed(
    surface: &Rc<Surface>,
    view: &NshView,
    old: &AttributedText,
    text: &AttributedText,
) {
    let recolor = transition::recolor(old, text, &view.state().style, reduce_motion(surface));
    if recolor.starts() {
        animate(surface, view, |live| live.recolor(recolor));
    } else if let Some(live) = view.state_mut().live.as_deref_mut() {
        live.recolor(recolor);
    }
}

/// True if an ancestor of `view` is animating out (and takes `view` with
/// it).
fn ancestor_dying(view: &NshView) -> bool {
    let mut parent = view.parent_view();
    while let Some(p) = parent {
        if p.state().live.as_ref().is_some_and(|l| l.dying()) {
            return true;
        }
        parent = p.parent_view();
    }
    false
}

/// One frame of `view`'s animations at `now` (ms): false once nothing is
/// left to animate (the frame client is dropped).
fn tick(surface: &Rc<Surface>, view: &NshView, now: f64) -> bool {
    if !view.attached() {
        // Out of the tree: a deleted subtree stops for good (dropping the
        // client releases it); a view only moved out resumes when it is
        // inserted again. Views of a subtree being built (registered, with
        // a parent, not attached yet) go on.
        let id = view.id();
        let registered = surface
            .mounter
            .try_borrow()
            .ok()
            .is_none_or(|m| m.views.get(id).as_ref() == Some(view));
        if !registered || view.parent_view().is_none() {
            if let Some(live) = view.state_mut().live.as_deref_mut() {
                live.set_ticking(false);
            }
            return false;
        }
    }
    // A view deleted inside a deleted subtree leaves with its ancestor
    // instead of fading on its own (deletions arrive in any order, so this
    // is decided once the batch is applied).
    let starting_out = view.state().live.as_ref().is_some_and(|l| l.leaving());
    let inherited = starting_out && ancestor_dying(view);

    let step = {
        let mut s = view.state_mut();
        let s = &mut *s;
        let Some(mut live) = s.live.take() else {
            return false;
        };
        if inherited {
            live.leave_with_ancestor();
        }
        // Finishing clears `ticking`: returning false drops the frame
        // client.
        let step = live.step(now, &mut s.frame, &mut s.style);
        if !live.idle() {
            s.live = Some(live);
        }
        step
    };

    if step.removed {
        // Taken out as an immediate removal would be (the mounter is
        // borrowed only while a batch is applied, which never ticks).
        match surface.mounter.try_borrow() {
            Ok(mounter) => mounter.detach(surface, view),
            Err(_) => view.unparent(),
        }
        return false;
    }
    if step.resized && view.kind() == ViewKind::Scroll {
        crate::scroll::resized(surface, view);
    }
    view.moved();
    !step.finished
}

#[cfg(test)]
mod tests {
    use nsh_core::geometry::{Percentage, deg};

    use super::*;

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-3
    }

    #[test]
    fn extra_applies_before_the_style_transform() {
        let mut extra = Extra::NONE;
        extra.scale = 2.0;
        extra.shift_y = Percentage(-0.25);
        // A style translate by (10, 0): the extra's scale and shift apply
        // to points first, then the translation.
        let m = apply_extra(extra, Mat4::new().translate(10.0, 0.0), 100.0);
        let (x, y) = m.map(1.0, 0.0).unwrap();
        assert!(close(x, 12.0) && close(y, -25.0), "{x} {y}");
        let mut spin = Extra::NONE;
        spin.rotate = deg(90.0);
        let (x, y) = apply_extra(spin, Mat4::new(), 10.0).map(1.0, 0.0).unwrap();
        assert!(close(x, 0.0) && close(y, 1.0), "{x} {y}");
        assert_eq!(apply_extra(Extra::NONE, Mat4::new(), 10.0), Mat4::new());
    }
}
