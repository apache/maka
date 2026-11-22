//! Navigation without a view tree, as the desktop backends (Windows,
//! GPUI, Linux, macOS) carry it out: how long pushes, pops and modals take
//! and where their views are at each frame, the transitions running on a
//! surface's frame clock, a stack's screens as shown (and those the user
//! popped until the app removes them), what going back acts on, and the
//! size and insets last reported for a screen or modal. The backends keep
//! their views (concealing, moving and fading them, the images or views a
//! departing screen leaves as) and call these for the decisions.

use std::time::Duration;

use crate::{
    Bounds, EdgeInsets, EventPayload, ModalAnimation, NodeId, PayloadValue, Points,
    ScreenAnimation, Size,
};

/// Push and pop.
pub const SLIDE: Duration = Duration::from_millis(300);
/// Cross-fades (and slides when the user asked for less motion).
pub const FADE: Duration = Duration::from_millis(200);
/// Modals sliding up or down.
pub const MODAL: Duration = Duration::from_millis(300);
/// How far the screen under a pushed one moves left, of the width.
const PARALLAX: f32 = 0.3;
/// How dark the screen under a pushed one gets (black's opacity), where
/// the backend dims it.
const DIM: f32 = 0.12;

/// Eases transition progress `t` (0 to 1, clamped) out, cubically.
pub fn ease(t: f64) -> f32 {
    let u = 1.0 - t.clamp(0.0, 1.0);
    (1.0 - u * u * u) as f32
}

/// How a screen comes and goes: the duration and whether it fades;
/// `None`: at once.
pub fn screen_motion(animation: ScreenAnimation, reduce_motion: bool) -> Option<(Duration, bool)> {
    match animation {
        ScreenAnimation::None => None,
        ScreenAnimation::Fade => Some((FADE, true)),
        ScreenAnimation::Default if reduce_motion => Some((FADE, true)),
        ScreenAnimation::Default => Some((SLIDE, false)),
    }
}

/// How a modal comes and goes: the duration and whether it fades;
/// `None`: at once.
pub fn modal_motion(animation: ModalAnimation, reduce_motion: bool) -> Option<(Duration, bool)> {
    match animation {
        ModalAnimation::None => None,
        ModalAnimation::Fade => Some((FADE, true)),
        ModalAnimation::Slide if reduce_motion => Some((FADE, true)),
        ModalAnimation::Slide => Some((MODAL, false)),
    }
}

/// A sliding push at eased progress `e` in a stack `width` wide: how far
/// right the entering screen is, and how far right (negative: left) the
/// one below it.
pub fn push_offsets(width: Points, e: f32) -> (Points, Points) {
    let w = width.0;
    (Points(w * (1.0 - e)), Points(-PARALLAX * w * e))
}

/// A sliding pop at eased progress `e` in a stack `width` wide: how far
/// right the leaving screen is, and how far right (negative: left) the one
/// below it.
pub fn pop_offsets(width: Points, e: f32) -> (Points, Points) {
    let w = width.0;
    (Points(w * e), Points(-PARALLAX * w * (1.0 - e)))
}

/// The opacity of the black over the screen under a pushed one, at how far
/// it is covered (`amount`, 0 to 1).
pub fn dim(amount: f32) -> f32 {
    DIM * amount
}

/// A modal sliding up at eased progress `e`: how far down it is, from
/// `distance` (its top edge to the window's bottom edge) to 0.
pub fn modal_in_offset(distance: Points, e: f32) -> Points {
    Points(distance.0 * (1.0 - e))
}

/// A modal sliding down at eased progress `e`: how far down it is, from 0
/// to `distance` (its top edge to the window's bottom edge).
pub fn modal_out_offset(distance: Points, e: f32) -> Points {
    Points(distance.0 * e)
}

/// One running transition.
struct Transition<M> {
    /// Time of its first frame (seconds, the surface's clock): a
    /// transition started in a batch begins with the frame that shows it.
    start: Option<f64>,
    duration: Duration,
    motion: M,
}

impl<M> Transition<M> {
    /// Its length in milliseconds, at least one.
    fn ms(&self) -> f64 {
        (self.duration.as_micros() as f64 / 1000.0).max(1.0)
    }

    /// Its progress at `now` (0 to 1 and beyond, not eased).
    fn progress(&self, now: f64) -> f64 {
        self.start.map_or(0.0, |s| (now - s) * 1000.0 / self.ms())
    }
}

/// What a frame does to one transition ([`Transitions::tick`]).
#[derive(Debug)]
pub enum Tick<M> {
    /// It ended: its views go where they rest.
    Ended(M),
    /// It runs on: its motion (at this index of the transitions still
    /// running) is at this eased progress.
    At(usize, f32),
}

/// The transitions running on a surface, each with a backend's motion
/// (what moves and how), timed by the surface's frame clock.
pub struct Transitions<M> {
    list: Vec<Transition<M>>,
}

impl<M> Default for Transitions<M> {
    fn default() -> Self {
        Transitions { list: Vec::new() }
    }
}

impl<M> Transitions<M> {
    /// Starts `motion`, lasting `duration` from the next frame.
    pub fn push(&mut self, duration: Duration, motion: M) {
        self.list.push(Transition {
            start: None,
            duration,
            motion,
        });
    }

    /// True when none runs (the frame callback can stop).
    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    /// The motions running, oldest first.
    pub fn iter(&self) -> impl Iterator<Item = &M> {
        self.list.iter().map(|t| &t.motion)
    }

    /// Takes out the transitions `which` selects, oldest first, to end at
    /// once.
    pub fn take(&mut self, which: impl Fn(&M) -> bool) -> Vec<M> {
        let mut taken = Vec::new();
        let mut i = 0;
        while i < self.list.len() {
            if which(&self.list[i].motion) {
                taken.push(self.list.remove(i).motion);
            } else {
                i += 1;
            }
        }
        taken
    }

    /// When the next transition ends (seconds, the clock
    /// [`Transitions::tick`] is given), or `now` when one has to be ticked
    /// to start: what a surface that draws no frames (a hidden window)
    /// ticks them at, so screens settle and report it on time without
    /// frames. `None` when none runs.
    pub fn deadline(&self, now: f64) -> Option<f64> {
        self.list
            .iter()
            .map(|t| t.start.map_or(now, |s| s + t.ms() / 1000.0))
            .reduce(f64::min)
            // A millisecond past it: a tick there finds it ended whatever
            // the rounding.
            .map(|t| t + 0.001)
    }

    /// A frame at `now` (seconds): the transitions that end are taken out,
    /// and each is reported in order, ended or at its eased progress (the
    /// indices are of those still running).
    pub fn tick(&mut self, now: f64) -> Vec<Tick<M>> {
        for t in &mut self.list {
            t.start.get_or_insert(now);
        }
        let mut ticks = Vec::with_capacity(self.list.len());
        let mut i = 0;
        while i < self.list.len() {
            let p = self.list[i].progress(now);
            if p >= 1.0 {
                ticks.push(Tick::Ended(self.list.remove(i).motion));
            } else {
                ticks.push(Tick::At(i, ease(p)));
                i += 1;
            }
        }
        ticks
    }
}

impl<M> std::ops::Index<usize> for Transitions<M> {
    type Output = M;

    fn index(&self, i: usize) -> &M {
        &self.list[i].motion
    }
}

/// A stack's screens as shown, bottom to top, apart from those the user
/// popped (natively, before the app removes them).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct Stack {
    shown: Vec<NodeId>,
    popped: Vec<NodeId>,
}

impl Stack {
    /// Its screens as shown, bottom to top.
    pub fn shown(&self) -> &[NodeId] {
        &self.shown
    }

    /// The screen on top.
    pub fn top(&self) -> Option<NodeId> {
        self.shown.last().copied()
    }

    /// The app's screens after a batch (bottom to top): those the user
    /// popped and the app has not removed yet stay out of what shows.
    /// Returns what showed before.
    pub fn reconcile(&mut self, screens: &[NodeId]) -> Vec<NodeId> {
        self.popped.retain(|id| screens.contains(id));
        let shown = screens
            .iter()
            .copied()
            .filter(|id| !self.popped.contains(id))
            .collect();
        std::mem::replace(&mut self.shown, shown)
    }

    /// The user pops the top screen, unless it is the only one: it no
    /// longer shows, and stays popped until the app removes it.
    pub fn pop(&mut self) -> Option<NodeId> {
        if self.shown.len() < 2 {
            return None;
        }
        let top = self.shown.pop()?;
        self.popped.push(top);
        Some(top)
    }

    /// True when going back acts on this stack: it has a screen to pop, or
    /// its only one hears it first (`prevents_back`: a screen's
    /// `popOnBack` is false).
    pub fn takes_back(&self, prevents_back: impl Fn(NodeId) -> bool) -> bool {
        self.shown.len() > 1 || self.top().is_some_and(prevents_back)
    }
}

/// What going back acts on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Back {
    /// This stack's top screen hears `onBackPress` (when the app listens)
    /// and pops unless its `popOnBack` is false.
    Stack(NodeId),
    /// The newest modal is asked to close.
    Modal(NodeId),
    /// The app's `onBackPress`.
    App,
}

/// What going back acts on: a stack inside the newest modal, else that
/// modal; without a modal the app's `onBackPress` when it listens
/// (`back_press`; it sends `Command::Back` when no listener takes it), else
/// the innermost stack. `back_stack` finds the stack that takes it inside
/// the given modal, or anywhere.
pub fn back_target(
    newest_modal: Option<NodeId>,
    back_press: bool,
    back_stack: impl FnOnce(Option<NodeId>) -> Option<NodeId>,
) -> Option<Back> {
    if let Some(id) = newest_modal {
        return Some(match back_stack(Some(id)) {
            Some(stack) => Back::Stack(stack),
            None => Back::Modal(id),
        });
    }
    if back_press {
        return Some(Back::App);
    }
    back_stack(None).map(Back::Stack)
}

/// Whether a stack may take going back as far as its layout goes: it and
/// every view around it (`frames`, the root's aside) have a size. The core
/// lays out `display: none` (a tab not selected) and everything in it at no
/// size, and a page of a stack so laid out at its stack's, which no
/// platform's own hidden state sees; such a stack keeps its screens while
/// another shows. Every backend with a global back asks this beside its own
/// check (the web's `stackShown` and Android's `StackBox` as well); apps
/// have no use for it.
pub fn shown_in_layout(frames: impl IntoIterator<Item = Bounds<Points>>) -> bool {
    frames.into_iter().all(|frame| !frame.is_empty())
}

/// The first of `candidates` that contains none of the others
/// (`contains(a, b)`: `b` is inside `a`): of the stacks that take going
/// back, the innermost.
pub fn innermost<T>(candidates: &[T], contains: impl Fn(&T, &T) -> bool) -> Option<&T> {
    candidates.iter().enumerate().find_map(|(i, c)| {
        let outer = candidates
            .iter()
            .enumerate()
            .any(|(j, o)| j != i && contains(c, o));
        (!outer).then_some(c)
    })
}

/// The size and insets last reported for a screen or modal (a root of its
/// own in the core), so only changes are reported.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
#[non_exhaustive]
pub struct Reported {
    last: Option<(Size<Points>, EdgeInsets)>,
}

impl Reported {
    /// The root is now `size` with `insets`: `None` when there is nothing
    /// to report (unchanged, or not laid out yet), else whether the insets
    /// changed too (the app hears `onInsets` only then).
    pub fn update(&mut self, size: Size<Points>, insets: EdgeInsets) -> Option<bool> {
        if size.width <= Points::ZERO || self.last == Some((size, insets)) {
            return None;
        }
        let insets_changed = self.last.is_none_or(|(_, i)| i != insets);
        self.last = Some((size, insets));
        Some(insets_changed)
    }
}

/// The payload of `onInsets`.
pub fn insets_payload(i: EdgeInsets) -> EventPayload {
    let n = |v: f32| PayloadValue::Number(v as f64);
    EventPayload::Map(vec![
        ("top", n(i.top.0)),
        ("right", n(i.right.0)),
        ("bottom", n(i.bottom.0)),
        ("left", n(i.left.0)),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stack_laid_out_at_no_size_takes_no_going_back() {
        let at = |w: f32, h: f32| Bounds::new(Default::default(), Size::new(Points(w), Points(h)));
        assert!(shown_in_layout([at(390.0, 844.0), at(390.0, 844.0)]));
        // `display: none`: the core lays it out at no size.
        assert!(!shown_in_layout([Bounds::default()]));
        assert!(!shown_in_layout([at(390.0, 0.0)]));
        assert!(!shown_in_layout([at(0.0, 844.0)]));
        // A stack of a fixed size in a page of a stack so laid out.
        assert!(!shown_in_layout([
            at(390.0, 300.0),
            Bounds::default(),
            at(390.0, 844.0)
        ]));
    }

    #[test]
    fn eases_out() {
        assert_eq!(ease(0.0), 0.0);
        assert_eq!(ease(1.0), 1.0);
        assert_eq!(ease(2.0), 1.0);
        assert_eq!(ease(-1.0), 0.0);
        assert!(ease(0.5) > 0.5);
        // Monotonic.
        let mut last = 0.0;
        for i in 1..=20 {
            let e = ease(i as f64 / 20.0);
            assert!(e >= last);
            last = e;
        }
    }

    #[test]
    fn transitions_progress_from_their_first_frame() {
        let t = Transition {
            start: None,
            duration: SLIDE,
            motion: (),
        };
        // Not started: at the beginning.
        assert_eq!(t.progress(5.0), 0.0);
        let t = Transition {
            start: Some(2.0),
            ..t
        };
        assert_eq!(t.progress(2.0), 0.0);
        assert!((t.progress(2.15) - 0.5).abs() < 1e-9);
        assert!(t.progress(2.3) >= 1.0 - 1e-9);
    }

    #[test]
    fn transitions_end_at_their_deadlines() {
        let mut t = Transitions::default();
        assert_eq!(t.deadline(5.0), None);
        t.push(SLIDE, 'a');
        t.push(FADE, 'b');
        // Not started: tick now.
        assert_eq!(t.deadline(5.0), Some(5.001));
        t.tick(5.0);
        let first = t.deadline(5.0).expect("two run");
        assert!((first - 5.201).abs() < 1e-9, "{first}");
        assert!(matches!(
            t.tick(first)[..],
            [Tick::At(0, _), Tick::Ended('b')]
        ));
        let last = t.deadline(first).expect("one runs");
        assert!((last - 5.301).abs() < 1e-9, "{last}");
        assert!(matches!(t.tick(last)[..], [Tick::Ended('a')]));
        assert_eq!(t.deadline(last), None);
    }

    #[test]
    fn ticks_end_transitions_in_order() {
        let mut list = Transitions::default();
        list.push(FADE, 'a');
        list.push(SLIDE, 'b');
        list.push(FADE, 'c');
        // The first frame starts them all.
        let ticks = list.tick(1.0);
        assert!(matches!(
            ticks[..],
            [Tick::At(0, _), Tick::At(1, _), Tick::At(2, _)]
        ));
        // The fades end; the slide runs on, now first.
        let ticks = list.tick(1.25);
        assert!(matches!(
            ticks[..],
            [Tick::Ended('a'), Tick::At(0, _), Tick::Ended('c')]
        ));
        assert_eq!(list[0], 'b');
        assert_eq!(list.take(|&m| m == 'b'), vec!['b']);
        assert!(list.is_empty());
    }

    #[test]
    fn motions_follow_the_animation_and_reduce_motion() {
        assert_eq!(screen_motion(ScreenAnimation::None, false), None);
        assert_eq!(
            screen_motion(ScreenAnimation::Default, false),
            Some((SLIDE, false))
        );
        assert_eq!(
            screen_motion(ScreenAnimation::Default, true),
            Some((FADE, true))
        );
        assert_eq!(
            screen_motion(ScreenAnimation::Fade, false),
            Some((FADE, true))
        );
        assert_eq!(modal_motion(ModalAnimation::None, true), None);
        assert_eq!(
            modal_motion(ModalAnimation::Slide, false),
            Some((MODAL, false))
        );
        assert_eq!(
            modal_motion(ModalAnimation::Slide, true),
            Some((FADE, true))
        );
    }

    #[test]
    fn offsets_run_from_start_to_rest() {
        let w = Points(400.0);
        let close = |(a, b): (Points, Points), (x, y): (f32, f32)| {
            assert!(
                (a.0 - x).abs() < 1e-3 && (b.0 - y).abs() < 1e-3,
                "{a:?} {b:?}"
            );
        };
        close(push_offsets(w, 0.0), (400.0, 0.0));
        close(push_offsets(w, 1.0), (0.0, -120.0));
        close(pop_offsets(w, 0.0), (0.0, -120.0));
        close(pop_offsets(w, 1.0), (400.0, 0.0));
        assert_eq!(modal_in_offset(Points(300.0), 0.0), Points(300.0));
        assert_eq!(modal_out_offset(Points(300.0), 1.0), Points(300.0));
        assert_eq!(dim(1.0), DIM);
    }

    #[test]
    fn popped_screens_stay_out_until_the_app_removes_them() {
        let mut stack = Stack::default();
        assert!(stack.reconcile(&[2, 4, 6]).is_empty());
        assert_eq!(stack.pop(), Some(6));
        assert_eq!(stack.shown(), [2, 4]);
        // The app has not removed it yet.
        assert_eq!(stack.reconcile(&[2, 4, 6]), vec![2, 4]);
        assert_eq!(stack.shown(), [2, 4]);
        // It did; pushing the same screen again shows it.
        stack.reconcile(&[2, 4]);
        stack.reconcile(&[2, 4, 6]);
        assert_eq!(stack.top(), Some(6));
        // The last screen never pops.
        stack.reconcile(&[2]);
        assert_eq!(stack.pop(), None);
        assert!(!stack.takes_back(|_| false));
        assert!(stack.takes_back(|id| id == 2));
    }

    #[test]
    fn going_back_asks_the_newest_modal_then_the_app_then_the_stacks() {
        assert_eq!(back_target(None, false, |_| None), None);
        assert_eq!(back_target(None, true, |_| Some(2)), Some(Back::App));
        assert_eq!(back_target(None, false, |_| Some(2)), Some(Back::Stack(2)));
        assert_eq!(back_target(Some(8), true, |_| None), Some(Back::Modal(8)));
        assert_eq!(
            back_target(Some(8), true, |m| m.map(|_| 10)),
            Some(Back::Stack(10))
        );
    }

    #[test]
    fn the_innermost_contains_no_other() {
        // Each number is inside the ones it starts with.
        let contains = |a: &&str, b: &&str| b.starts_with(a) && a != b;
        assert_eq!(innermost(&["1", "12", "3"], contains), Some(&"12"));
        assert_eq!(innermost::<&str>(&[], contains), None);
    }

    #[test]
    fn reports_only_changes() {
        let size = Size {
            width: Points(100.0),
            height: Points(200.0),
        };
        let insets = EdgeInsets::default();
        let mut reported = Reported::default();
        assert_eq!(reported.update(Size::default(), insets), None);
        assert_eq!(reported.update(size, insets), Some(true));
        assert_eq!(reported.update(size, insets), None);
        let taller = Size {
            height: Points(300.0),
            ..size
        };
        assert_eq!(reported.update(taller, insets), Some(false));
    }
}
