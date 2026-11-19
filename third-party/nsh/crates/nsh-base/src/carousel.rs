//! `Carousel` and its parts: slides shown one place at a time, with no look
//! of their own (`gpui-component`'s `Carousel`, `CarouselContent`,
//! `CarouselItem`, `CarouselPrevious`, `CarouselNext`,
//! `CarouselPagination` and `CarouselPaginationItem`; `gpui-base` has
//! none).
//!
//! The root holds which slide shows (the app's `index`, else its own from
//! `defaultIndex`) and hands it to its parts through context. The content
//! is a native scroll view: fingers, the wheel and the touchpad move it on
//! the platform's main thread, in the same frame as the pointer, and it
//! snaps to the slides' starts (`snapToOffsets`, one slide per fling). The
//! slides report where they are laid out, so the snap points are the
//! slides' own, whatever their width (several per view, gaps, a peek of
//! the next one). When the scroll view comes to rest the carousel reports
//! the slide it rests on, which shows until the app has answered: an app
//! that passes `index` and keeps another slide gets it back, the content
//! springing back to it ([`after_answer`]). A discrete change (previous,
//! next, a pagination item, a key, the app's `index`) scrolls it there
//! natively, animated unless the user asked for reduced motion.
//!
//! `onFocus` / `onBlur` are the focus coming into the carousel's view and
//! leaving it (`ElementRef::on_focus_in` / `on_focus_out`, the core's
//! `focus-within`): its controls, its pagination items and whatever the app
//! made focusable in the slides are inside it, so a move between them is
//! none.
//!
//! A looping carousel wraps seamlessly, as `gpui-component`'s runway does:
//! the content gets a runway of one period (the slides and the gap after
//! the last) before and after the slides, and each slide is drawn in the
//! period nearest the viewport's center, a translation the animation graph
//! computes from the scroll offset (`scroll_value`) on the platform's own
//! frames. Each slide is there once, for screen readers too. The snap
//! points repeat over three periods, so a swipe crosses the seam; once a
//! scroll rests outside the middle period the offset moves back into it
//! by one period without animation, which changes nothing on screen.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};

use nsh_core::{
    AccessibilityState,
    element::{LayoutTransition, OrderWatch, Spring, Style, watch_order},
    geometry::Axis,
    prelude::*,
};

use crate::keys::bind_while_directed;

/// How far apart two offsets may be and still be one snap point: layout's
/// rounding, and a scroll view resting within a point of its target.
const EPSILON: f32 = 0.5;

/// How long after an animated scroll across the seam the offset moves back
/// into the middle period, when the platform reported no rest before (iOS
/// reports none for a scroll it was asked for): longer than the platforms'
/// animated scrolls (UIKit's, about 300 ms; the desktops' 300 ms).
const RECENTER_MS: u64 = 600;

/// What a slide's translation reads while the loop is not seamless (not
/// laid out yet, or the slides span too little): an offset and a period so
/// large that the nearest period is always the slide's own.
const STILL_SHIFT: f32 = 1.0e6;
const STILL_PERIOD: f32 = 1.0e7;

/// The pagination indicator's travel to another item: `gpui-component`'s
/// `spring_move` (a 280 ms response, a damping ratio of 0.85), as `Tabs`'
/// indicator.
fn indicator_motion() -> LayoutTransition {
    LayoutTransition::spring(Spring::new(280.0).damping_ratio(0.85))
}

/// How many scrolls replaced before they arrived are remembered: a rest a
/// platform reported for one is on its way for a frame or two only (see
/// [`Inner::superseded`]).
const SUPERSEDED: usize = 3;

/// What the arrow keys and Home / End do while the carousel has the focus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Previous,
    Next,
    First,
    Last,
}

/// The keys of a horizontal carousel (`gpui-component`'s: Left and Right
/// on its axis, traded in a right-to-left layout, Home and End).
const HORIZONTAL_KEYS: &[(&str, bool, Step)] = &[
    ("left", true, Step::Previous),
    ("right", true, Step::Next),
    ("home", false, Step::First),
    ("end", false, Step::Last),
];

/// The keys of a vertical carousel: Up and Down on its axis.
const VERTICAL_KEYS: &[(&str, bool, Step)] = &[
    ("up", true, Step::Previous),
    ("down", true, Step::Next),
    ("home", false, Step::First),
    ("end", false, Step::Last),
];

/// A slide of the content, as it registered.
struct Slide {
    key: u64,
    /// Its view, for the slides' order in the tree.
    node: ElementRef,
    /// Where it is laid out along the axis in the scroll view's content
    /// (its start and its length), once laid out.
    frame: Option<(f32, f32)>,
    /// What its translation adds to the scroll offset, while the carousel
    /// loops: half the viewport less its center, plus half a period.
    shift: Option<AnimatedValue>,
    /// What `shift` was last set to.
    sent: Cell<f32>,
}

/// Where the slides rest, from their layout.
#[derive(Debug, Clone, Default, PartialEq)]
struct Track {
    /// Each slide's snap offset, in the slides' order along the axis: where
    /// it starts less where the first one does (held to the scroll range
    /// unless the loop is seamless). Empty until every slide is laid out.
    snaps: Vec<f32>,
    /// The period of a seamless loop: from the first slide's start to the
    /// last one's end, and the gap after it. `None` while the carousel does
    /// not loop seamlessly.
    period: Option<f32>,
    /// The length of a runway, the period less the gap the content puts
    /// before the first slide.
    runway: Option<f32>,
    /// Where the first slide starts and the viewport, for the slides'
    /// translations.
    first: f32,
    viewport: f32,
}

impl Track {
    /// The slides are where their rests are: while the loop is seamless,
    /// once its runway is in the layout before the first slide (a scroll
    /// sent earlier would be held to the shorter content).
    fn ready(&self) -> bool {
        self.period.is_none_or(|p| self.first + EPSILON >= p)
    }

    /// Slide `index`'s rest offset in the middle period.
    fn rest(&self, index: usize) -> Option<f32> {
        Some(self.snaps.get(index)? + self.period.unwrap_or(0.0))
    }

    /// The snap point nearest `offset` in any period: its slide, where it
    /// is, and its period (-1, 0 or 1 around the middle one; 0 when not
    /// seamless).
    fn nearest(&self, offset: f32) -> Option<(usize, f32, i32)> {
        let cycles: &[i32] = if self.period.is_some() {
            &[-1, 0, 1]
        } else {
            &[0]
        };
        let period = self.period.unwrap_or(0.0);
        let mut best: Option<(usize, f32, i32)> = None;
        for &k in cycles {
            for (i, s) in self.snaps.iter().enumerate() {
                let at = s + period * (k + 1) as f32;
                if best.is_none_or(|(_, b, _)| (at - offset).abs() < (b - offset).abs()) {
                    best = Some((i, at, k));
                }
            }
        }
        best.map(|(i, at, k)| (first_at(&self.snaps, i), at, k))
    }
}

/// What the layout reported of the content, kept until the track takes it
/// as a whole: a layout pass reports each slide's frame in a call of its
/// own, and a track made between them would mix the old frames with the
/// new (one jump to a wrong offset, then another back).
#[derive(Default)]
struct Geometry {
    /// The end of the scroll range and the viewport, once reported.
    max: Cell<Option<f32>>,
    viewport: Cell<Option<f32>>,
    /// Something was reported since the track was last made.
    unsettled: Cell<bool>,
}

/// What the parts of a [`Carousel`] share.
#[derive(Clone)]
struct Ctl(Rc<Inner>);

struct Inner {
    axis: Axis,
    /// It loops (read when the carousel is made).
    looping: bool,
    /// The slides, in the tree's order (`order`): components render in the
    /// order the core makes them, so a slide inserted before the others,
    /// or moved by a keyed list, registers out of place.
    slides: Rc<RefCell<Vec<Slide>>>,
    order: OrderWatch,
    next_key: Cell<u64>,
    /// Bumped as slides come and go.
    changed: Signal<u64>,
    /// How many slides there are.
    count: Memo<usize>,
    track: Memo<Track>,
    /// What the layout reported (the scroll range, the viewport) and
    /// whether it reported anything the track has not taken yet.
    geometry: Rc<Geometry>,
    /// Bumped once the layout's reports are all in: the track is made
    /// again from them (`Ctl::settle`).
    settled: Signal<u64>,
    /// Bumped to settle on the next turn what no last slide's report
    /// settled (`Ctl::settle_later`).
    fallback: Signal<u64>,
    /// The scroll offset, on the platform's frames, and the period the
    /// slides' translations read: while looping only.
    offset: Option<AnimatedValue>,
    period: Option<AnimatedValue>,
    controlled: Prop<Option<u32>>,
    /// The index while the app passes none.
    own: Signal<usize>,
    /// Where the user's swipe came to rest while the app has not answered
    /// it yet: shown until the app's next `index`, or until the app has
    /// handled the change and kept its own (`Ctl::let_go_after_answer`).
    pending: Signal<Option<usize>>,
    /// The app handled a swipe's change while the user dragged again: the
    /// swipe's slide is let go of where that drag rests, not under the
    /// finger.
    answered_in_drag: Cell<bool>,
    /// The slide shown.
    shown: Memo<usize>,
    /// The carousel's own view, which takes the keyboard focus from a
    /// control turning disabled.
    root: ElementRef,
    /// The scroll view.
    scroller: ElementRef,
    /// Where the scroll view rests, or was last sent.
    at: Cell<f32>,
    /// Where the animated scroll the carousel sent last is going, until it
    /// rests there: the desktops report a rest when it arrives.
    in_flight: Cell<Option<f32>>,
    /// Where scrolls replaced before they arrived were going (the newest
    /// last, [`SUPERSEDED`] at most). A platform may have reported one's
    /// rest just before the next scroll reached it: that rest is on its
    /// way, and is no slide the user chose.
    superseded: RefCell<Vec<f32>>,
    /// The index the content last scrolled to, and the loop's period then.
    placed: Cell<Option<usize>>,
    placed_period: Cell<Option<f32>>,
    /// Which way a control or a key asked to go around the ends (forward:
    /// past the last), until the scroll to the slide asked for.
    wrap: Cell<Option<bool>>,
    /// Bumped by each scroll the carousel sends: a pending re-center
    /// stands only while no later scroll was sent.
    generation: Cell<u64>,
    /// The user scrolls it, from the drag's start to the rest.
    dragging: Signal<bool>,
    /// How many of the carousel's views have the keyboard focus (the root,
    /// its controls, its pagination items): the keys are bound while one
    /// has it.
    focused: Signal<u32>,
    /// The carousel's owner: a swipe's slide is let go of under it.
    owner: Owner,
    cx: Scope<CarouselEvent>,
}

impl Ctl {
    fn new(
        axis: Axis,
        looping: bool,
        controlled: Prop<Option<u32>>,
        initial: usize,
        cx: Scope<CarouselEvent>,
    ) -> Self {
        let slides = Rc::new(RefCell::new(Vec::<Slide>::new()));
        let changed = signal(0u64);
        let geometry = Rc::new(Geometry::default());
        let settled = signal(0u64);
        let track = {
            let (slides, geometry) = (slides.clone(), geometry.clone());
            computed(move || {
                settled.get();
                let (max, viewport) = (geometry.max.get(), geometry.viewport.get());
                let slides = slides.borrow();
                let mut frames: Vec<(f32, f32)> = slides.iter().filter_map(|s| s.frame).collect();
                if frames.is_empty() || frames.len() != slides.len() {
                    return Track::default();
                }
                frames.sort_by(|a, b| a.0.total_cmp(&b.0));
                let first = frames[0].0;
                let (last_start, last_len) = frames[frames.len() - 1];
                let gap = frames
                    .get(1)
                    .map_or(0.0, |second| (second.0 - first - frames[0].1).max(0.0));
                let period = last_start + last_len - first + gap;
                let widest = frames.iter().map(|f| f.1).fold(0.0, f32::max);
                // A seamless loop shows each slide once: the slides span
                // the viewport and one more slide at least.
                let seamless = looping
                    && frames.len() > 1
                    && viewport.is_some_and(|v| period + EPSILON >= v + widest);
                let snaps = frames
                    .iter()
                    .map(|(start, _)| {
                        let offset = (start - first).max(0.0);
                        match max {
                            Some(max) if !seamless => offset.min(max),
                            _ => offset,
                        }
                    })
                    .collect();
                Track {
                    snaps,
                    period: seamless.then_some(period),
                    runway: seamless.then_some(period - gap),
                    first,
                    viewport: viewport.unwrap_or(0.0),
                }
            })
        };
        let count = {
            let slides = slides.clone();
            computed(move || {
                changed.get();
                slides.borrow().len()
            })
        };
        let own = signal(initial);
        let pending = signal(None::<usize>);
        let shown = computed(move || {
            let wanted = pending
                .get()
                .or_else(|| controlled.get().map(|i| i as usize))
                .unwrap_or_else(|| own.get());
            wanted.min(count.get().saturating_sub(1))
        });
        // The app's next `index` ends the wait for its answer.
        effect(move || {
            controlled.get();
            untracked(|| pending.set(None));
        });
        // The slides in the tree's order, as they come and as the app moves
        // them, before the layout reports their frames (the core looks at
        // the end of the round that made or moved them).
        let order = {
            let (listed, sorted) = (slides.clone(), slides.clone());
            watch_order(
                move || listed.borrow().iter().map(|s| s.node).collect(),
                move |order| {
                    let mut slides = sorted.borrow_mut();
                    let mut taken: Vec<Option<Slide>> = slides.drain(..).map(Some).collect();
                    slides.extend(order.iter().filter_map(|&i| taken[i].take()));
                },
            )
        };
        let ctl = Self(Rc::new(Inner {
            axis,
            looping,
            slides,
            order,
            next_key: Cell::new(1),
            changed,
            count,
            track,
            geometry,
            settled,
            fallback: signal(0),
            offset: looping.then(|| animated_value(0.0)),
            period: looping.then(|| animated_value(STILL_PERIOD)),
            controlled,
            own,
            pending,
            answered_in_drag: Cell::new(false),
            shown,
            root: element_ref(),
            scroller: element_ref(),
            at: Cell::new(0.0),
            in_flight: Cell::new(None),
            superseded: RefCell::new(Vec::new()),
            placed: Cell::new(None),
            placed_period: Cell::new(None),
            wrap: Cell::new(None),
            generation: Cell::new(0),
            dragging: signal(false),
            focused: signal(0),
            owner: Owner::current(),
            cx,
        }));
        if looping {
            ctl.follow_track();
        }
        {
            // What no last slide's report settled settles on the next turn
            // (a pass that left the last slide where it was); each request
            // replaces the one before.
            let ctl = ctl.clone();
            effect(move || {
                if ctl.0.fallback.get() == 0 {
                    return;
                }
                let ctl = ctl.clone();
                untracked(|| set_timeout(Duration::ZERO, move || ctl.settle()));
            });
        }
        ctl
    }

    /// Makes the track again from what the layout reported, once.
    fn settle(&self) {
        if self.0.geometry.unsettled.replace(false) {
            self.0.settled.update(|n| *n += 1);
        }
    }

    /// The layout reported something: settled when the last slide reports,
    /// else on the next turn.
    fn settle_later(&self) {
        self.0.geometry.unsettled.set(true);
        if let Some(n) = self.0.fallback.try_get() {
            self.0.fallback.try_set(n + 1);
        }
    }

    /// Keeps the slides' translations on the track: each slide's shift and
    /// the period are set as the layout changes, never made again.
    fn follow_track(&self) {
        let ctl = self.clone();
        effect(move || {
            ctl.0.settled.get();
            let track = ctl.0.track.get();
            untracked(|| {
                let period = track.period;
                if let Some(value) = ctl.0.period {
                    value.set(period.unwrap_or(STILL_PERIOD));
                }
                for slide in ctl.0.slides.borrow().iter() {
                    let (Some(shift), Some((start, len))) = (slide.shift, slide.frame) else {
                        continue;
                    };
                    let to = match period {
                        Some(p) => track.viewport / 2.0 - (start + len / 2.0) + p / 2.0,
                        None => STILL_SHIFT,
                    };
                    if (slide.sent.replace(to) - to).abs() > f32::EPSILON {
                        shift.set(to);
                    }
                }
            });
        });
    }

    /// How many slides there are (tracked).
    fn count(&self) -> usize {
        self.0.count.get()
    }

    /// The slide shown (tracked).
    fn shown(&self) -> usize {
        self.0.shown.get()
    }

    /// Adds the slide whose view is `node`, which the carousel forgets when
    /// the current owner (the slide's component) ends: its key, and, while
    /// the carousel loops, the translation that draws it in the period
    /// nearest the viewport's center (made once: the layout sets its
    /// inputs).
    fn register(&self, node: ElementRef) -> (u64, Option<AnimatedNode>) {
        let key = self.0.next_key.get();
        self.0.next_key.set(key + 1);
        let (shift, translation) = match (self.0.offset, self.0.period) {
            (Some(offset), Some(period)) => {
                let shift = animated_value(STILL_SHIFT);
                // t = y - (y mod P), y = offset + shift: the whole periods
                // between the slide and the viewport's center, rounded.
                let y = offset.add(&shift);
                let translation = y.sub(&y.modulo(&period));
                (Some(shift), Some(translation))
            }
            _ => (None, None),
        };
        self.0.slides.borrow_mut().push(Slide {
            key,
            node,
            frame: None,
            shift,
            sent: Cell::new(STILL_SHIFT),
        });
        self.0.changed.update(|n| *n += 1);
        self.0.order.invalidate();
        let ctl = self.clone();
        cleanup(move || {
            ctl.0.slides.borrow_mut().retain(|s| s.key != key);
            // The carousel may be ending too: its signals may be gone.
            if let Some(n) = ctl.0.changed.try_get() {
                ctl.0.changed.try_set(n + 1);
            }
            ctl.settle_later();
        });
        (key, translation)
    }

    /// Slide `key` was laid out at `frame` in the content. A layout pass
    /// reports the slides in the tree's order (the core emits frames depth
    /// first, children in order), which `slides` keeps (put in order at the
    /// end of the round that made or moved one, before its frames come), so
    /// the last slide's report is the end of the pass: the track is made
    /// from all of it then, once. A pass that leaves the last slide where
    /// it was settles on the next turn (`settle_later`).
    fn place(&self, key: u64, frame: &Bounds<Points>) {
        let at = match self.0.axis {
            Axis::Horizontal => (frame.origin.x.0, frame.size.width.0),
            Axis::Vertical => (frame.origin.y.0, frame.size.height.0),
        };
        let (moved, last) = {
            let mut slides = self.0.slides.borrow_mut();
            let last = slides.last().is_some_and(|s| s.key == key);
            let moved = match slides.iter_mut().find(|s| s.key == key) {
                Some(slide)
                    if slide.frame.is_none_or(|f| {
                        (f.0 - at.0).abs() > f32::EPSILON || (f.1 - at.1).abs() > f32::EPSILON
                    }) =>
                {
                    slide.frame = Some(at);
                    true
                }
                _ => false,
            };
            (moved, last)
        };
        if moved {
            self.settle_later();
        }
        if last {
            self.settle();
        }
    }

    /// The scroll view reported its content and viewport.
    fn measured(&self, e: &ScrollEvent) {
        let (content, viewport) = match self.0.axis {
            Axis::Horizontal => (e.content_size.width.0, e.size.width.0),
            Axis::Vertical => (e.content_size.height.0, e.size.height.0),
        };
        // Reported in the commit that laid the content out, before the
        // slides' frames: the last of those settles it.
        let geometry = &self.0.geometry;
        let max = Some((content - viewport).max(0.0));
        let max_changed = geometry.max.replace(max) != max;
        let viewport_changed = geometry.viewport.replace(Some(viewport)) != Some(viewport);
        if max_changed || viewport_changed {
            self.settle_later();
        }
    }

    /// The slide `from` moves to (tracked): the next or the previous one
    /// with a snap point of its own (slides that rest where another does,
    /// at the end of the range, are one stop: the first of them), around
    /// the ends while looping; `None` at an end.
    fn step(&self, from: usize, forward: bool) -> Option<usize> {
        let count = self.count();
        if count == 0 {
            return None;
        }
        let looping = self.0.looping;
        self.0.track.with(|track| {
            let snaps = &track.snaps;
            if snaps.len() != count {
                // Not laid out yet: one slide at a time.
                let wrap = looping && count > 1;
                return if forward {
                    (from + 1 < count).then_some(from + 1).or(wrap.then_some(0))
                } else {
                    from.checked_sub(1).or(wrap.then_some(count - 1))
                };
            }
            let at = snaps[from.min(count - 1)];
            let wrap = looping && snaps.iter().any(|s| (s - snaps[0]).abs() > EPSILON);
            if forward {
                snaps
                    .iter()
                    .position(|s| *s > at + EPSILON)
                    .or(wrap.then_some(0))
            } else {
                snaps
                    .iter()
                    .rposition(|s| *s < at - EPSILON)
                    .or(wrap.then_some(count - 1))
                    .map(|j| first_at(snaps, j))
            }
        })
    }

    /// The last stop: the first of the slides that rest where the last one
    /// does.
    fn last(&self) -> Option<usize> {
        let count = self.count();
        if count == 0 {
            return None;
        }
        self.0.track.with(|track| {
            Some(if track.snaps.len() == count {
                first_at(&track.snaps, count - 1)
            } else {
                count - 1
            })
        })
    }

    /// The user asked for slide `index` (a control, a key, a pagination
    /// item): it shows at once without an `index` of the app's, else when
    /// the app passes it.
    fn go(&self, index: usize) {
        if index == self.0.shown.get_untracked() {
            return;
        }
        if self.0.controlled.get_untracked().is_none() {
            self.0.own.set(index);
        }
        self.0.cx.emit(CarouselEvent::Change(index as u32));
    }

    /// A control or a key moved one stop `forward` or back.
    fn go_step(&self, forward: bool) {
        let from = self.0.shown.get_untracked();
        let Some(to) = untracked(|| self.step(from, forward)) else {
            return;
        };
        let wrapped = if forward { to <= from } else { to >= from };
        self.0.wrap.set(wrapped.then_some(forward));
        self.go(to);
    }

    /// The user scrolled it: the drag started. It stops the scroll the
    /// carousel sent, and what rests the platform reports from now on are
    /// the user's.
    fn drag_started(&self) {
        self.0.in_flight.set(None);
        self.0.superseded.borrow_mut().clear();
        if !self.0.dragging.get_untracked() {
            self.0.dragging.set(true);
            self.0.cx.emit(CarouselEvent::DragStart);
        }
    }

    /// Whether a rest at `offset` is that of a scroll the carousel sent and
    /// then replaced, reported before the next scroll reached the platform
    /// (previous, then next while the first still arrives): no slide of
    /// the user's, the scroll in flight goes on. Any other rest ends the
    /// wait: the scroll in flight arrived, or the user moved the content
    /// (a mouse wheel reports no drag).
    fn superseded_rest(&self, offset: f32) -> bool {
        let near = |at: f32| (at - offset).abs() <= EPSILON;
        let arrived = self.0.in_flight.get().is_some_and(near);
        if !arrived && self.0.superseded.borrow().iter().any(|&at| near(at)) {
            return true;
        }
        self.0.in_flight.set(None);
        self.0.superseded.borrow_mut().clear();
        false
    }

    /// The scroll came to rest at `offset`: back in the middle period, on a
    /// slide, which shows, and the app hears of it. With an `index` of the
    /// app's, the slide shows until the app has answered.
    fn settled(&self, offset: f32) {
        if self.superseded_rest(offset) {
            return;
        }
        self.0.at.set(offset);
        if self.0.dragging.get_untracked() {
            self.0.dragging.set(false);
            self.0.cx.emit(CarouselEvent::DragEnd);
        }
        let track = self.0.track.get_untracked();
        let Some((index, target, cycle)) = track.nearest(offset) else {
            return;
        };
        if (target - offset).abs() > EPSILON {
            // A rest between snap points (a platform that does not snap a
            // gesture) lands on the slide; back in the middle afterwards.
            self.scroll_to(target, !reduce_motion());
            self.recenter_later();
        } else if cycle != 0 {
            self.recenter();
        }
        // The content rests on it, whichever slide shows next.
        self.0.placed.set(Some(index));
        let controlled = self.0.controlled.get_untracked();
        if self.0.answered_in_drag.take() {
            // The app answered the last swipe while this drag went on: its
            // `index` shows unless this rest asks for another.
            let count = self.0.count.get_untracked();
            let kept = controlled.map(|c| (c as usize).min(count.saturating_sub(1)));
            if kept == Some(index) {
                self.0.pending.set(None);
                return;
            }
        } else if index == self.0.shown.get_untracked() {
            return;
        }
        if controlled.is_some() {
            self.0.pending.set(Some(index));
        } else {
            self.0.own.set(index);
        }
        self.0.cx.emit(CarouselEvent::Change(index as u32));
        if controlled.is_some() {
            self.let_go_after_answer();
        }
    }

    /// Lets go of the swipe's slide once the app has handled its change
    /// ([`after_answer`]): an app that followed it shows it as its `index`
    /// already, one that kept another gets that one back, the content
    /// springing back to it, animated (a release, as the snap is). Not
    /// under a finger that dragged again meanwhile: where that drag rests.
    fn let_go_after_answer(&self) {
        let ctl = self.clone();
        self.0.owner.run(|| {
            after_answer(move || {
                if ctl.0.dragging.get_untracked() {
                    ctl.0.answered_in_drag.set(true);
                } else {
                    ctl.0.pending.set(None);
                }
            });
        });
    }

    /// Moves the offset back into the middle period, without animation:
    /// every slide is drawn in the period nearest the viewport's center, so
    /// nothing moves on screen.
    fn recenter(&self) {
        let track = self.0.track.get_untracked();
        let (Some(period), Some((_, _, cycle))) = (track.period, track.nearest(self.0.at.get()))
        else {
            return;
        };
        if cycle != 0 {
            self.scroll_to(self.0.at.get() - period * cycle as f32, false);
        }
    }

    /// [`Self::recenter`] once the scroll just sent has ended, unless the
    /// user or another scroll moved it meanwhile.
    fn recenter_later(&self) {
        let generation = self.0.generation.get();
        let ctl = self.clone();
        set_timeout(Duration::from_millis(RECENTER_MS), move || {
            if ctl.0.generation.get() == generation && !ctl.0.dragging.get_untracked() {
                ctl.recenter();
            }
        });
    }

    /// Scrolls the content to `offset`, unless it rests there.
    fn scroll_to(&self, offset: f32, animated: bool) {
        if (self.0.at.get() - offset).abs() <= EPSILON {
            return;
        }
        self.0.at.set(offset);
        self.0.generation.set(self.0.generation.get() + 1);
        // An animated scroll is in flight until it rests; one sent at once
        // reports no rest. Either replaces the scroll in flight.
        let replaced = self
            .0
            .in_flight
            .replace(animated.then_some(offset))
            .filter(|&at| (at - offset).abs() > EPSILON);
        if let Some(at) = replaced {
            let mut superseded = self.0.superseded.borrow_mut();
            superseded.push(at);
            if superseded.len() > SUPERSEDED {
                superseded.remove(0);
            }
        }
        let to = match self.0.axis {
            Axis::Horizontal => point(px(offset), px(0.0)),
            Axis::Vertical => point(px(0.0), px(offset)),
        };
        self.0.scroller.scroll_to(to, animated);
    }

    /// Scrolls to slide `index` (from `from`, the slide placed before, in
    /// a loop of the same period while `same_loop`): across the seam to the
    /// next or the previous period when it goes around the ends, animated.
    fn scroll_to_slide(&self, track: &Track, from: Option<usize>, same_loop: bool, index: usize) {
        let Some(rest) = track.rest(index) else {
            return;
        };
        let moved = from.is_some_and(|f| f != index);
        let animated = moved && !reduce_motion();
        let wrap = self.0.wrap.take();
        let Some(period) = track.period else {
            self.scroll_to(rest, animated);
            return;
        };
        if !animated {
            // On the slide in another period (a swipe that rested across
            // the seam): its re-center moves it, without a jump of this.
            let d = (self.0.at.get() - rest).rem_euclid(period);
            let there = d <= EPSILON || period - d <= EPSILON;
            if !(same_loop && !moved && from.is_some() && there) {
                self.scroll_to(rest, false);
            }
            return;
        }
        let from = from.unwrap_or(index);
        let count = track.snaps.len();
        let last = first_at(&track.snaps, count - 1);
        let forward = from == last && index == 0 && (count > 2 || wrap == Some(true));
        let back = from == 0 && index == last && (count > 2 || wrap == Some(false));
        let turn = i32::from(forward) - i32::from(back);
        // From the period the content is in (one beside the middle while a
        // swipe across the seam has not re-centered yet), so the scroll
        // starts where the content is; from the middle one when the slide
        // would be past the runways.
        let mut cycle = track.nearest(self.0.at.get()).map_or(0, |(_, _, k)| k);
        if (cycle + turn).abs() > 1 {
            self.recenter();
            cycle = 0;
        }
        self.scroll_to(rest + period * (cycle + turn) as f32, true);
        if cycle + turn != 0 {
            self.recenter_later();
        }
    }

    /// A key while the carousel has the focus.
    fn key(&self, step: Step) {
        match step {
            Step::Previous => self.go_step(false),
            Step::Next => self.go_step(true),
            Step::First => {
                if untracked(|| self.count()) > 0 {
                    self.go(0);
                }
            }
            Step::Last => {
                if let Some(last) = untracked(|| self.last()) {
                    self.go(last);
                }
            }
        }
    }

    /// Tracks whether a part (a control, a pagination item) has the
    /// keyboard focus, and gives the focus to the carousel when the part
    /// turns `disabled` while it has it (next on the last slide): the
    /// platform would move it out of the carousel (macOS to the window),
    /// which would end the keys and report `onBlur`. The returned flag is
    /// the part's to set from its focus and blur.
    fn keep_focus(&self, disabled: Memo<bool>) -> Signal<bool> {
        let focused = signal(false);
        let root = self.0.root;
        effect(move || {
            if disabled.get() && untracked(|| focused.get()) {
                root.focus();
            }
        });
        focused
    }

    /// One of its views (its own, a control, a pagination item) took the
    /// keyboard focus: the keys are bound.
    fn focus_in(&self) {
        if let Some(n) = self.0.focused.try_get() {
            self.0.focused.try_set(n + 1);
        }
    }

    /// One of its views lost the keyboard focus.
    fn focus_out(&self) {
        if let Some(n) = self.0.focused.try_get() {
            self.0.focused.try_set(n.saturating_sub(1));
        }
    }

    /// The content's scroll view: snapping to the slides, scrolled to the
    /// slide shown, reporting where the user's scroll rests.
    fn content(&self, scroll: Scroll) -> Scroll {
        let scroller = self.0.scroller;
        {
            let ctl = self.clone();
            watch_scroll(move || scroller.node(), move |e| ctl.measured(e));
        }
        {
            // Scrolls to the slide shown as it changes (animated) and as the
            // slides move (at once: a resize keeps the slide in place).
            let ctl = self.clone();
            effect(move || {
                let index = ctl.shown();
                let track = ctl.0.track.get();
                if track.rest(index).is_none() || !track.ready() {
                    return;
                }
                untracked(|| {
                    let from = ctl.0.placed.replace(Some(index));
                    let same_loop = ctl.0.placed_period.replace(track.period) == track.period;
                    ctl.scroll_to_slide(&track, from, same_loop, index);
                });
            });
        }
        let track = self.0.track;
        let (start, end) = (self.clone(), self.clone());
        let axis = self.0.axis;
        let scroll = match self.0.offset {
            Some(offset) => scroll.scroll_value(&offset),
            None => scroll,
        };
        scroll
            .element_ref(&scroller)
            .snap_offsets(move || {
                let mut offsets: Vec<Points> = Vec::new();
                track.with(|track| {
                    // Three periods while the loop is seamless, so a swipe
                    // crosses the seam.
                    let cycles = if track.period.is_some() { 3 } else { 1 };
                    let period = track.period.unwrap_or(0.0);
                    for k in 0..cycles {
                        for s in &track.snaps {
                            let at = s + period * k as f32;
                            if offsets
                                .last()
                                .is_none_or(|o: &Points| (o.0 - at).abs() > EPSILON)
                            {
                                offsets.push(px(at));
                            }
                        }
                    }
                });
                offsets
            })
            // One slide per fling, as `gpui-component`'s release settles on
            // the nearest item past the drag.
            .disable_interval_momentum(true)
            .on_scroll_drag_start(move |_: &Point<Points>| start.drag_started())
            .on_scroll_end(move |offset: &Point<Points>| {
                end.settled(match axis {
                    Axis::Horizontal => offset.x.0,
                    Axis::Vertical => offset.y.0,
                });
            })
    }

    /// A runway of the content, before or after the slides: as long as a
    /// period less the gap while the loop is seamless, else out of the
    /// layout. Hidden from screen readers and the pointer.
    fn runway(&self) -> View {
        let (track, axis) = (self.0.track, self.0.axis);
        view()
            .flex_none()
            .pointer_events(PointerEvents::None)
            .accessibility_elements_hidden(true)
            .style_with(move |s| match track.with(|t| t.runway) {
                Some(len) => match axis {
                    Axis::Horizontal => s.w(px(len)),
                    Axis::Vertical => s.h(px(len)),
                },
                None => s.hidden(),
            })
    }
}

/// The first of the slides whose snap point is slide `index`'s.
fn first_at(snaps: &[f32], index: usize) -> usize {
    let at = snaps[index];
    snaps
        .iter()
        .position(|s| (s - at).abs() <= EPSILON)
        .unwrap_or(index)
}

/// What the parts of a [`Carousel`] find of it through context.
#[derive(Clone)]
struct CarouselContext(Ctl);

/// The props of [`Carousel`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct CarouselProps {
    /// The slide shown, from 0 (`gpui-component`'s selected index; held to
    /// the slides there are). The app owns it: a swipe, a control or a key
    /// reports the next one with `onChange`, and the carousel scrolls to
    /// the `index` the app passes back, animated. A swipe shows the slide
    /// it rests on until the app has answered its `onChange`: an app that
    /// keeps its `index` gets its slide back, the content springing back to
    /// it, animated. With several slides
    /// per view it names the slide in the first place (those that rest
    /// with the last one show the same place). Without it the carousel
    /// keeps its own, from `defaultIndex`.
    pub index: Prop<Option<u32>>,
    /// The slide shown at first, while `index` is not set (default `0`).
    #[prop(default)]
    pub default_index: Prop<u32>,
    /// The direction the slides follow each other (default
    /// `"horizontal"`); a vertical carousel's arrow keys are Up and Down.
    /// Read when the carousel is made.
    #[prop(default = Axis::Horizontal)]
    pub axis: Prop<Axis>,
    /// The slides go around (`gpui-component`'s `looping`): past the last
    /// comes the first, and before the first the last, seamlessly, for a
    /// swipe, previous, next and the keys alike, and the app's `index`
    /// going from the last slide to the first or back. Seamless while the
    /// slides span the viewport and one slide more; with fewer, previous,
    /// next and the keys go around by scrolling back across the slides.
    /// Read when the carousel is made.
    #[prop(default)]
    pub looping: Prop<bool>,
    /// What screen readers call the carousel (a region): what its slides
    /// are (`"Featured products"`).
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The [`CarouselContent`] with the slides, the controls
    /// ([`CarouselPrevious`], [`CarouselNext`], [`CarouselPagination`]) and
    /// whatever else the app lays out around them.
    pub children: Prop<Children>,
}

/// The events of a [`Carousel`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum CarouselEvent {
    /// The user moved to another slide: a swipe, the wheel or the touchpad
    /// came to rest on it, or a control, a pagination item or a key asked
    /// for it. Set `index` to follow it. A new `index` of the app's reports
    /// nothing.
    #[args(index)]
    Change(u32),
    /// The user started dragging the content (a finger, the touchpad).
    DragStart,
    /// The content the user dragged came to rest.
    DragEnd,
    /// The keyboard focus came into the carousel from elsewhere: to its own
    /// view, its previous or next control, a pagination item or a focusable
    /// view of the app's in a slide. A move between them reports nothing.
    Focus,
    /// The keyboard focus left the carousel: its own view, its controls,
    /// its pagination items and the slides' content.
    Blur,
}

/// Slides shown one place at a time (a product's photos, the steps of an
/// onboarding, a row of cards), moved by swiping, the wheel or the
/// touchpad, the previous and next controls, the pagination and the
/// keyboard. It holds which slide shows and has no look: its `class` and
/// `style` lay out the [`CarouselContent`] and the controls the app places
/// in it. Screen readers hear a region named by `accessibilityLabel`, its
/// slides as groups.
///
/// Swipes are the platform's own scrolling: the slides follow the finger
/// in the same frame and snap to the nearest slide on release, one slide
/// per fling; the carousel reports the slide with `onChange` when the
/// content comes to rest. Previous, next, the pagination, the keys and the
/// app's `index` scroll the content natively, animated (at once with
/// reduced motion). Slides that move on by themselves are the app's: a
/// timer that sets `index`, waiting while `onDragStart` / `onDragEnd`,
/// `onFocus` / `onBlur` (the keyboard focus in the carousel: on it, a
/// control, a pagination item or the slides' content) and the pointer over
/// a view around it say the user is at it.
///
/// The keyboard, as `gpui-component`'s: the carousel is a stop of the
/// keyboard focus where views are (macOS, the web), and while it, one of
/// its controls or a pagination item has the focus, Left and Right (Up
/// and Down when vertical) move to the previous and next slide (in a
/// right-to-left layout, where the slides run from the right, Right and
/// Left) and Home and End to the first and last. A control that turns disabled with the
/// focus (next on the last slide) hands it to the carousel.
#[component]
pub fn Carousel(props: CarouselProps, cx: Scope<CarouselEvent>) -> impl IntoElement {
    let axis = untracked(|| props.axis.get());
    let looping = untracked(|| props.looping.get());
    let initial = untracked(|| props.default_index.get()) as usize;
    let ctl = Ctl::new(axis, looping, props.index, initial, cx);
    provide_context(CarouselContext(ctl.clone()));
    let keys = match axis {
        Axis::Horizontal => HORIZONTAL_KEYS,
        Axis::Vertical => VERTICAL_KEYS,
    };
    {
        let (focused, ctl) = (ctl.0.focused, ctl.clone());
        bind_while_directed(move || focused.get() > 0, keys, move |step| ctl.key(step));
    }
    let root = ctl.0.root;
    {
        // The focus coming into the carousel's view or what is inside it,
        // and leaving: the controls, the pagination and the slides' content
        // alike, a move between them none.
        let (into, out) = (ctl.0.cx, ctl.0.cx);
        root.on_focus_in(move || into.emit(CarouselEvent::Focus));
        root.on_focus_out(move || out.emit(CarouselEvent::Blur));
    }
    let (focus, blur) = (ctl.clone(), ctl);
    view()
        .element_ref(&root)
        .role(AccessibilityRole::Region)
        .optional_label(props.accessibility_label)
        .focusable(true)
        .on_focus(move || focus.focus_in())
        .on_blur(move || blur.focus_out())
        .child(props.children)
}

/// The props of [`CarouselContent`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct CarouselContentProps {
    /// The [`CarouselItem`]s, each a child of the content.
    pub children: Prop<Children>,
}

/// The viewport the slides scroll in: a native scroll view along the
/// carousel's axis, with no scroll bar, that snaps to the slides' starts.
/// Its `class` and `style` size it and lay the slides out as a track: a
/// `gap` between them, padding that shows a peek of the slides beside the
/// one in view. Each slide's width (its height, vertical) is its own
/// class's: `w-full` for one slide per view, `basis-1/3` for three. A slide
/// rests where the first one does, so a padding before the first is kept
/// before each; at the end of the range the slides that cannot reach that
/// place rest with the last (unless the carousel loops seamlessly).
#[component]
pub fn CarouselContent(props: CarouselContentProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let ctl = use_context::<CarouselContext>().map(|CarouselContext(ctl)| ctl);
    let horizontal = ctl.as_ref().is_none_or(|c| c.0.axis == Axis::Horizontal);
    let runways = ctl.as_ref().filter(|c| c.0.looping).cloned();
    scroll()
        .when(horizontal, |s| s.horizontal())
        .scrollbar(false)
        .when_some(ctl, |s, ctl| ctl.content(s))
        .when_some(runways.clone(), |s, ctl| s.child(ctl.runway()))
        .child(props.children)
        .when_some(runways, |s, ctl| s.child(ctl.runway()))
}

/// The props of [`CarouselItem`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct CarouselItemProps {
    /// What screen readers call the slide (a group): its place among the
    /// others and what it shows (`"2 of 5: Ocean view"`).
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The slide's content.
    pub children: Prop<Children>,
}

/// One slide, a child of the [`CarouselContent`]: a group for screen
/// readers. Its `class` and `style` size it along the axis (`w-full`,
/// `basis-1/3`) and style it; where it is laid out is a snap point of the
/// content, and its place among the slides along the axis is its index. In
/// a carousel that loops it is drawn in the period nearest the viewport's
/// center (a translation of its own, which the app's `transform` must not
/// set).
#[component]
pub fn CarouselItem(props: CarouselItemProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let ctl = use_context::<CarouselContext>().map(|CarouselContext(ctl)| ctl);
    let node = element_ref();
    view()
        .element_ref(&node)
        .role(AccessibilityRole::Group)
        .optional_label(props.accessibility_label)
        .when_some(ctl, |v, ctl| {
            let (key, translation) = ctl.register(node);
            let axis = ctl.0.axis;
            let v = match translation {
                Some(t) if axis == Axis::Horizontal => v.bind_translate_x(&t),
                Some(t) => v.bind_translate_y(&t),
                None => v,
            };
            v.on_layout(move |frame: &Bounds<Points>| ctl.place(key, frame))
        })
        .child(props.children)
}

/// The props of [`CarouselPrevious`] and [`CarouselNext`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct CarouselControlProps {
    /// What screen readers say: the control's name, when its children have
    /// no text that says it (an arrow icon).
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The content: the app's icon or label.
    pub children: Prop<Children>,
}

/// A button that moves to the previous slide, in the [`Carousel`];
/// disabled on the first unless the carousel loops. Its look and place are
/// the app's: `class` and `style` (beside the content, or `absolute` over
/// its edge), `hover:`, `active:`, `focus-visible:` and `disabled:`; its children
/// are the icon.
#[component]
pub fn CarouselPrevious(props: CarouselControlProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    control(props, false)
}

/// A button that moves to the next slide, in the [`Carousel`]; disabled on
/// the last unless the carousel loops. Its look and place are the app's, as
/// [`CarouselPrevious`]'s.
#[component]
pub fn CarouselNext(props: CarouselControlProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    control(props, true)
}

/// A previous or next control.
fn control(props: CarouselControlProps, forward: bool) -> View {
    let ctl = use_context::<CarouselContext>().map(|CarouselContext(ctl)| ctl);
    let none = {
        let ctl = ctl.clone();
        computed(move || {
            ctl.as_ref()
                .is_none_or(|c| c.step(c.shown(), forward).is_none())
        })
    };
    let base = view()
        .role(AccessibilityRole::Button)
        .optional_label(props.accessibility_label)
        .disabled(move || none.get());
    match ctl {
        Some(ctl) => {
            let focused = ctl.keep_focus(none);
            let (press, focus, blur) = (ctl.clone(), ctl.clone(), ctl);
            base.on_press(move || press.go_step(forward))
                .on_focus(move || {
                    focused.set(true);
                    focus.focus_in();
                })
                .on_blur(move || {
                    focused.set(false);
                    blur.focus_out();
                })
        }
        None => base,
    }
    .child(props.children)
}

/// A pagination item, as it registered with its pagination.
struct PaginationEntry {
    key: u64,
    /// The slide it shows.
    index: Prop<u32>,
    node: ElementRef,
}

/// What a [`CarouselPaginationItem`] finds of its [`CarouselPagination`]
/// through context: the items, for the indicator to follow.
#[derive(Clone)]
struct PaginationContext {
    items: Rc<RefCell<Vec<PaginationEntry>>>,
    next_key: Rc<Cell<u64>>,
    changed: Signal<u64>,
}

/// The props of [`CarouselPagination`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct CarouselPaginationProps {
    /// What screen readers call the group of pagination items
    /// (`"Choose a slide"`).
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The Tailwind classes of the indicator, a view on the item of the
    /// slide shown (a pill behind the dots, an underline): its look and its
    /// place across the row (`inset-y-0`, `bottom-0 h-0.5`). Along the row
    /// it spans that item, and travels to the next one natively, as
    /// `Tabs`' indicator does. With neither this nor `indicatorStyle`, the
    /// pagination has no indicator (the items' `selected:` styles show the
    /// slide).
    pub indicator_class: Prop<Option<SharedString>>,
    /// The style of the indicator, over `indicatorClass`.
    #[prop(default)]
    pub indicator_style: Prop<Style>,
    /// The [`CarouselPaginationItem`]s, and whatever the app lays out
    /// between them.
    pub children: Prop<Children>,
}

/// The pagination of a [`Carousel`]: a group of [`CarouselPaginationItem`]s
/// (dots, thumbnails, numbers), one per slide, and an optional indicator
/// that follows the item of the slide shown natively. Its layout and look
/// are the app's `class` and `style` (`flex-row gap-2`).
#[component]
pub fn CarouselPagination(props: CarouselPaginationProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let pagination = PaginationContext {
        items: Rc::new(RefCell::new(Vec::new())),
        next_key: Rc::new(Cell::new(1)),
        changed: signal(0),
    };
    provide_context(pagination.clone());
    let ctl = use_context::<CarouselContext>().map(|CarouselContext(ctl)| ctl);
    let (class, style) = (props.indicator_class, props.indicator_style);
    let styled = move || class.with(Option::is_some) || style.with(|s| *s != Style::default());
    let current = {
        let PaginationContext { items, changed, .. } = pagination;
        computed(move || {
            changed.get();
            let shown = ctl.as_ref()?.shown();
            items
                .borrow()
                .iter()
                .find(|item| item.index.get() as usize == shown)
                .map(|item| item.node)
        })
    };
    view()
        .role(AccessibilityRole::Group)
        .optional_label(props.accessibility_label)
        .child(when(styled, move || {
            view()
                .absolute()
                .pointer_events(PointerEvents::None)
                .accessibility_elements_hidden(true)
                .follow(move || current.get())
                .style_when(move || current.get().is_none(), |s| s.hidden())
                .follow_transition(move || (!reduce_motion()).then_some(indicator_motion()))
                .app_class(class)
                .inline_style(style)
        }))
        .child(props.children)
}

/// The props of [`CarouselPaginationItem`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct CarouselPaginationItemProps {
    /// The slide it shows, from 0. An index past the last slide is
    /// disabled.
    pub index: Prop<u32>,
    /// The style while its slide shows, as `selected:` classes.
    #[prop(default)]
    pub selected_style: Prop<Style>,
    /// What screen readers say: which slide it shows (`"Slide 3"`), when
    /// its children have no text that says it (a dot).
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The content: the app's dot, thumbnail or number.
    pub children: Prop<Children>,
}

/// One item of a [`CarouselPagination`]: a button that moves to its slide,
/// selected while that slide shows (screen readers say so, `selected:`
/// styles apply, and `group-selected:` classes under `group` in its
/// `class`). A change of slide updates the two items it concerns only. Its
/// look is the app's: `class`, `style`, `selectedStyle`, `hover:`,
/// `active:`, `focus-visible:`; its children are the dot or the thumbnail.
#[component]
pub fn CarouselPaginationItem(
    props: CarouselPaginationItemProps,
    _cx: Scope<NoEvent>,
) -> impl IntoElement {
    let ctl = use_context::<CarouselContext>().map(|CarouselContext(ctl)| ctl);
    let node = element_ref();
    if let Some(pagination) = use_context::<PaginationContext>() {
        let key = pagination.next_key.get();
        pagination.next_key.set(key + 1);
        pagination.items.borrow_mut().push(PaginationEntry {
            key,
            index: props.index,
            node,
        });
        pagination.changed.update(|n| *n += 1);
        let PaginationContext { items, changed, .. } = pagination;
        cleanup(move || {
            items.borrow_mut().retain(|item| item.key != key);
            if let Some(n) = changed.try_get() {
                changed.try_set(n + 1);
            }
        });
    }
    let index = props.index;
    let (selected, disabled) = {
        let (a, b) = (ctl.clone(), ctl.clone());
        (
            computed(move || {
                a.as_ref()
                    .is_some_and(|c| c.shown() == index.get() as usize)
            }),
            computed(move || b.as_ref().is_none_or(|c| index.get() as usize >= c.count())),
        )
    };
    let base = view()
        .element_ref(&node)
        .role(AccessibilityRole::Button)
        .optional_label(props.accessibility_label)
        .disabled(move || disabled.get())
        .accessibility_state(move || AccessibilityState {
            selected: selected.get(),
            ..AccessibilityState::default()
        })
        .selected_style(props.selected_style);
    match ctl {
        Some(ctl) => {
            // Its slide may go while it has the focus.
            let focused = ctl.keep_focus(disabled);
            let (press, focus, blur) = (ctl.clone(), ctl.clone(), ctl);
            base.on_press(move || press.go(index.get_untracked() as usize))
                .on_focus(move || {
                    focused.set(true);
                    focus.focus_in();
                })
                .on_blur(move || {
                    focused.set(false);
                    blur.focus_out();
                })
        }
        None => base,
    }
    .child(props.children)
}
