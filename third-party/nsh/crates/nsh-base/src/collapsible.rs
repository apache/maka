//! `Collapsible`: a region whose content is shown or left out, with no look
//! of its own, revealed by a clipped height that springs open and shut when
//! the app asks (`reveal`, `gpui-base`'s `Collapsible::reveal` /
//! `MotionReveal`).

use std::time::Duration;

use nsh_core::{
    element::{LayoutCurve, LayoutTransition},
    prelude::*,
};

/// How long a reveal takes, in milliseconds: as long as `gpui-component`'s
/// `spring_control` (critically damped, a 180 ms response, settled within a
/// thousandth: `theme/motion.rs`) takes, which is where a critically damped
/// layout spring fitted into this duration comes within a thousandth of its
/// end too (`nsh_core::transition`). `9.233 / (2π / 0.18 s)`.
const REVEAL_MS: f32 = 265.0;

/// The reveal: the frames that the region's change moves in the commit
/// that opens or closes it (its own, its content's, and what follows it)
/// spring to their new places, critically damped (a height should not
/// overshoot, as `gpui-base`'s `Spring::with_damping` says); the rest of
/// that commit (a list updating elsewhere) changes at once. Views inserted
/// and removed in it are not animated: the content shows at once, clipped
/// by the region growing around it.
const REVEAL: LayoutTransition =
    LayoutTransition::new(LayoutCurve::Spring { damping: 1.0 }, REVEAL_MS);

/// The props of [`Collapsible`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct CollapsibleProps {
    /// Expanded: the `content` is in the tree. The app owns the value: its
    /// trigger (a child: a view with `role="button"` and `onPress`) flips
    /// it, and the collapsible
    /// shows the value the app passes.
    #[prop(default)]
    pub open: Prop<bool>,
    /// Opens and closes with a reveal (`gpui-base`'s `Collapsible::reveal`,
    /// `MotionReveal`): the `content` sits in a region that clips it, whose
    /// height springs from zero to the content's own as `open` turns on
    /// and back as it turns off, and what follows the collapsible moves
    /// with it; the content stays in the tree until the region has closed.
    /// Off by default (the content comes and goes at once), and with
    /// reduced motion. The region is there while closed too, zero high: a
    /// `gap` of the collapsible's separates it from the children.
    #[prop(default)]
    pub reveal: Prop<bool>,
    /// What expands: placed after the children while `open`, out of the
    /// tree otherwise. It is made once and kept, so what is inside keeps
    /// its state (an input's text, a scroll position) from one opening to
    /// the next.
    pub content: Prop<Option<Slot>>,
    /// What shows either way: a header, the trigger that flips `open`, a
    /// summary.
    pub children: Prop<Children>,
}

/// A region whose content expands and collapses (a "show more", a section of
/// settings, details under a summary). It renders its children always and its
/// `content` after them only while `open`, and holds nothing else: no
/// trigger, chevron or label of its own. With `reveal` the content opens and
/// closes with a clipped height that springs, run natively as a layout
/// animation of the frames the region moves in the commit that changes
/// `open` (`ElementRef::animate_layout`), so no JS runs while it moves. The
/// trigger is one of the app's children that flips `open` (a view with
/// `role="button"`), and the app says the expanded state to screen readers
/// there (`accessibilityState={{ expanded: open }}` on the view that takes
/// the press). The app's `class` and `style` lay out and style the region.
#[component]
pub fn Collapsible(props: CollapsibleProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let (open, reveal) = (props.open, props.reveal);
    let region = element_ref();
    let mounted = follow_open(open.into_reactive(), reveal.into_reactive(), region);
    let content = move || props.content.place(|content| content);
    view().child(props.children).child(
        when(reveal, move || {
            view()
                .element_ref(&region)
                .overflow_hidden()
                .style_with(move |s| if open.get() { s } else { s.h(px(0.0)) })
                .child(when(mounted, content))
        })
        .otherwise(move || when(open, content)),
    )
}

/// Follows `open` for a region whose content comes and goes, revealed while
/// `reveal` holds and motion is not reduced: each change of `open` animates
/// the frames `region` moves in the commit that makes it ([`REVEAL`]), and
/// the signal returned says whether the content is in the tree. It turns
/// on with `open`, and off with it, or once the region has closed after a
/// reveal. The region's clip (zero high while closed) is the caller's:
/// `Collapsible`'s and `AccordionPanel`'s.
pub(crate) fn follow_open(
    open: Reactive<bool>,
    reveal: Reactive<bool>,
    region: ElementRef,
) -> Signal<bool> {
    let initial = untracked(|| open.get());
    // The content is in the tree: while open, and while a reveal closes.
    let mounted = signal(initial);
    let shown = stored(initial);
    // Each change of `open` ends what a closing reveal waits for.
    let generation = stored(0u64);
    effect(move || {
        let open = open.get();
        untracked(|| {
            if shown.replace(open) == open {
                return;
            }
            let current = generation.get().wrapping_add(1);
            generation.replace(current);
            let animated = reveal.get() && !reduce_motion();
            if animated {
                region.animate_layout(REVEAL);
            }
            if open || !animated {
                mounted.set(open);
                return;
            }
            // Out once the region has closed. The platform runs the reveal
            // and reports no end, so its time is the end.
            set_timeout(Duration::from_millis(REVEAL_MS as u64), move || {
                if generation.get() == current {
                    mounted.set(false);
                }
            });
        });
    });
    mounted
}
