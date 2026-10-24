//! Animated changes of views: `LayoutAnimation` (frames, insertions,
//! removals), style `transition`s and keyframe `animation`s (`spin`,
//! `ping`, `pulse`, `bounce`), run on the display link. How they animate
//! is [`nsh_core::transition`]'s; this module decides which views
//! animate and runs their frames.
//!
//! A view that animates gets a [`Live`] in [`ViewState::live`] and a frame
//! callback ([`Surface::add_frame_callback`]) that runs until nothing is
//! left to animate; other views carry nothing and cost nothing.
//!
//! Frames and styles are animated by writing the in-between values into
//! the view's state (`frame`, `style`) on every frame while [`Live`] keeps
//! the targets: everything that places and decorates the view reads the
//! current value without knowing about transitions, and a change that
//! arrives mid-animation (the mounter replaces the state with the new
//! target and hands the replaced value over as `old`) starts from where
//! the view is, as UIKit's `beginFromCurrentState`. Native animation
//! values ([`ViewState::anim`]) still override the style.
//!
//! Appearing / disappearing views and keyframes do not touch the style:
//! they multiply the opacity ([`Live::opacity`]) and add a transform before
//! the style's ([`Live::extra`], [`apply_extra`]), which [`ViewState`]
//! applies. A view animating out cannot be targeted ([`Live::dying`]).
//!
//! [`ViewState`]: crate::view::ViewState
//! [`ViewState::live`]: crate::view::ViewState::live
//! [`ViewState::anim`]: crate::view::ViewState::anim

use std::rc::Rc;

pub(crate) use nsh_core::transition::Live;
use nsh_core::{
    Bounds, LayoutAnimation, Matrix, Points, TransformKind, ViewKind, ViewStyle,
    transition::{self, Extra},
};

use crate::{surface::Surface, view::NshView};

/// `E · m`: `extra` (scale, then rotation, then the shift), then `m` (row
/// vectors, in the view's local space about its transform origin).
pub(crate) fn apply_extra(extra: Extra, m: Matrix, height: f32) -> Matrix {
    let mut e = Matrix::IDENTITY;
    if extra.scale != 1.0 {
        e = e.mul(&Matrix::of(TransformKind::Scale, extra.scale as f64));
    }
    if extra.rotate.0 != 0.0 {
        e = e.mul(&Matrix::of(
            TransformKind::Rotate,
            extra.rotate.to_degrees() as f64,
        ));
    }
    if extra.shift_y.0 != 0.0 {
        let dy = (extra.shift_y.0 * height) as f64;
        e = e.mul(&Matrix::of(TransformKind::TranslateY, dy));
    }
    e.mul(&m)
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

/// Runs `f` on the view's [`Live`] (made if needed) and makes sure a frame
/// callback runs while something animates.
fn animate(surface: &Rc<Surface>, view: &NshView, f: impl FnOnce(&mut Live)) {
    let start = {
        let mut s = view.state_mut();
        let live = s.live.get_or_insert_with(Box::default);
        f(live);
        if live.ticking() {
            // The callback drops it once idle.
            false
        } else if live.idle() {
            s.live = None;
            false
        } else {
            live.set_ticking(true);
            true
        }
    };
    if start {
        let view = view.clone();
        surface.add_frame_callback(move |_, now| tick(&view, now * 1000.0));
    }
}

/// `view` was inserted into its parent.
pub(crate) fn inserted(surface: &Rc<Surface>, view: &NshView, animation: Option<&LayoutAnimation>) {
    if view.state().live.as_ref().is_some_and(|l| l.dying()) {
        // Back (or moved) before its removal finished animating.
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
    if !view.has_parent() || reduce_motion(surface) || navigated(view) {
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
    // The old frame shows until the first frame of the animation.
    let to = std::mem::replace(&mut view.state_mut().frame, old);
    animate(surface, view, |live| live.move_frame(old, to, t));
    view.moved();
}

/// `view`'s style changed from `old` (the new one is in its state).
pub(crate) fn style_changed(surface: &Rc<Surface>, view: &NshView, old: &ViewStyle) {
    let reduce = reduce_motion(surface);
    // The old values show until the first frame of a transition.
    let restyle = transition::restyle(old, &mut view.state_mut().style, reduce);
    let Some(restyle) = restyle else {
        if let Some(live) = view.state_mut().live.as_deref_mut() {
            live.stop_style();
        }
        return;
    };
    animate(surface, view, |live| live.restyle(restyle));
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

/// One display frame (`now` in ms) of `view`'s animations: whether it
/// wants the next one.
fn tick(view: &NshView, now: f64) -> bool {
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
        let step = live.step(now, &mut s.frame, &mut s.style);
        if !live.idle() {
            s.live = Some(live);
        }
        step
    };

    if step.removed {
        view.unparent();
        return false;
    }
    view.moved();
    if step.restyled {
        // Text and canvas drawings may use the style (tint).
        view.redraw();
    }
    !step.finished
}
