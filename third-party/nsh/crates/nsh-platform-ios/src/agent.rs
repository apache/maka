//! The platform's part of `nsh test --target ios` (`nsh_testing::agent`):
//! where a node's view is in the window, and what a user's fingers and
//! keyboard do there, as IOHID events UIKit takes as the system's
//! ([`crate::synth`]): the touches go through hit testing, gesture
//! recognizers, scroll views and text inputs as real ones do. The agent
//! calls from a thread of its own; each call does its work on the main
//! queue (`exec_sync`) and returns once the input is handed over.

use std::{
    cell::RefCell,
    rc::Weak,
    sync::Mutex,
    time::{Duration, Instant},
};

use dispatch2::DispatchQueue;
use nsh_core::{
    NodeId,
    geometry::{Bounds, Point, Points, Size, point},
};
use nsh_testing::{
    DragOptions,
    agent::{Key, Native, SystemName},
};
use objc2::{Message, msg_send, rc::Retained};
use objc2_core_foundation::{CGFloat, CGPoint, CGRect};
use objc2_foundation::NSObjectProtocol;
use objc2_ui_kit::{UILabel, UIView, UIWindow};
use rustc_hash::FxHashMap;

use crate::{
    synth::{self, Phase},
    view::Inner,
};

/// A tap's hold, as a quick tap's.
const TAP: Duration = Duration::from_millis(60);
/// The time between typed keys.
const KEY: Duration = Duration::from_millis(80);
/// How long a typed key may take to land in the input before the next one
/// is typed anyway.
const KEY_LANDS: Duration = Duration::from_millis(600);
/// A finger's moves, a display frame apart.
const FRAME: Duration = Duration::from_millis(16);
/// How far a finger moves in one frame on average, in points: a quick
/// swipe's 2500 pt/s, so a gesture takes few frames, each a trip to the
/// main thread.
const MOVE_STEP: f64 = 40.0;
/// How long a finger rests before it lifts at the end of a scroll or of a
/// held drag, so the scroll view or gesture keeps no velocity (no fling
/// after it).
const REST: Duration = Duration::from_millis(120);
/// How far a resting finger trembles along its way, in points: the
/// scroll view or gesture moves with it, and so measures it at rest.
const TREMBLE: f64 = 0.25;

thread_local! {
    /// The views agents act on, by key (main thread).
    static VIEWS: RefCell<FxHashMap<u64, Weak<Inner>>> = RefCell::default();
}

/// The view `key` names to agents from now on (on the main thread).
pub(crate) fn register(key: u64, view: Weak<Inner>) {
    VIEWS.with(|v| v.borrow_mut().insert(key, view));
}

/// The view the agent acts on, by key (its calls must be `Send`).
pub(crate) struct IosNative {
    key: u64,
    /// The way the finger `dragAndHold` left down last moved (a unit
    /// vector), which it trembles along while it rests there.
    held: Mutex<Option<(f64, f64)>>,
}

impl IosNative {
    pub(crate) fn new(key: u64) -> Self {
        IosNative {
            key,
            held: Mutex::new(None),
        }
    }

    /// `f` with the view and its window on the main queue, waited for;
    /// `None` once either is gone.
    fn on_main<R: Send>(&self, f: impl FnOnce(&Inner, &UIWindow) -> R + Send) -> Option<R> {
        let key = self.key;
        let mut out = None;
        let slot = &mut out;
        DispatchQueue::main().exec_sync(move || {
            let Some(view) = VIEWS.with(|v| v.borrow().get(&key).and_then(Weak::upgrade)) else {
                return;
            };
            let Some(window) = view.container.window() else {
                return;
            };
            *slot = Some(f(&view, &window));
        });
        out
    }

    fn finger(&self, x: f64, y: f64, phase: Phase) {
        self.on_main(move |_, window| synth::touch(window, x, y, phase));
    }

    fn try_finger(&self, x: f64, y: f64, phase: Phase) -> Result<(), String> {
        match self.on_main(move |_, window| synth::touch(window, x, y, phase)) {
            Some(true) => Ok(()),
            Some(false) => Err("iOS could not synthesize the test touch".into()),
            None => Err("the window is gone".into()),
        }
    }

    /// The same touch stays down across the initial rest and every move.
    fn drag_finger(
        &self,
        from: Point<Points>,
        to: Point<Points>,
        options: DragOptions,
        held: bool,
    ) -> Result<(), String> {
        let xy = |p: Point<Points>| (f64::from(p.x.0), f64::from(p.y.0));
        let (x, y) = xy(from);
        self.try_finger(x, y, Phase::Down)?;
        std::thread::sleep(options.hold.unwrap_or(nsh_testing::agent::LANDING));
        for at in nsh_testing::agent::drag_path(from, to) {
            std::thread::sleep(nsh_testing::agent::FRAME);
            let (x, y) = xy(at);
            if let Err(error) = self.try_finger(x, y, Phase::Move) {
                let _ = self.try_finger(x, y, Phase::Up);
                return Err(error);
            }
        }
        let (x, y) = xy(to);
        if held {
            let (dx, dy) = (x - f64::from(from.x.0), y - f64::from(from.y.0));
            let length = dx.hypot(dy).max(1.0);
            *self.held.lock().unwrap() = Some((dx / length, dy / length));
        } else {
            self.try_finger(x, y, Phase::Up)?;
        }
        Ok(())
    }

    /// A finger resting at `at` for `rest`, along the way `way` (a unit
    /// vector) it came. A resting finger reports where it is every frame,
    /// trembling a fraction of a point back and forth along its way, as a
    /// real one does. Gesture recognizers and scroll views take a finger's
    /// speed from the moves that move it, and reports at the same spot
    /// change nothing: without them a finger lifts with the speed it had
    /// before it stopped (a scroll flings past its end, a back swipe
    /// held short of halfway completes). Each tremble moves it, at almost
    /// no speed, so it lifts at rest.
    fn rest(&self, at: (f64, f64), way: (f64, f64), rest: Duration) -> Result<(), String> {
        let (tx, ty) = (way.0 * TREMBLE, way.1 * TREMBLE);
        // It rests at `at` last.
        let resting = Instant::now();
        let mut back = true;
        while resting.elapsed() < rest || !back {
            std::thread::sleep(FRAME);
            let (x, y) = if back { (at.0 - tx, at.1 - ty) } else { at };
            self.try_finger(x, y, Phase::Move)?;
            back = !back;
        }
        Ok(())
    }

    /// A finger down at `from`, moving to `to` a frame at a time, easing
    /// out, resting, then lifting (a scroll, a swipe).
    fn swipe(&self, from: (f64, f64), to: (f64, f64), rest: Duration) {
        let (dx, dy) = (to.0 - from.0, to.1 - from.1);
        let n = ((dx.abs().max(dy.abs()) / MOVE_STEP).ceil() as u32).max(1);
        self.finger(from.0, from.1, Phase::Down);
        for i in 1..=n {
            std::thread::sleep(FRAME);
            // Easing out, as a finger that stops slows down first: the
            // scroll view sees no speed left when it lifts.
            let t = 1.0 - (1.0 - f64::from(i) / f64::from(n)).powi(3);
            self.finger(from.0 + dx * t, from.1 + dy * t, Phase::Move);
        }
        // It lifts at rest, with no speed left: no fling past the end of
        // the scroll.
        let length = dx.hypot(dy).max(1.0);
        let _ = self.rest(to, (dx / length, dy / length), rest);
        self.finger(to.0, to.1, Phase::Up);
    }

    /// Waits for the system menus to go after a tap that `done` them.
    fn menu_closed(&self, done: &str) -> Result<(), String> {
        let since = Instant::now();
        while self
            .on_main(|_, window| !system_menus(window).is_empty())
            .unwrap_or(false)
        {
            if since.elapsed() > SYSTEM_MOVES {
                return Err(format!(
                    "the menu stays open after it was {done} (a disabled item?)"
                ));
            }
            std::thread::sleep(FRAME * 4);
        }
        Ok(())
    }

    fn tap(&self, x: f64, y: f64, hold: Duration) {
        self.finger(x, y, Phase::Down);
        std::thread::sleep(hold);
        self.finger(x, y, Phase::Up);
        // Touches made in process leave the first responder where it was
        // (UI test tools give it as KIF does): a tap that lands in a text
        // input focuses it, as a finger's does.
        self.on_main(move |_, window| synth::focus_input_at(window, x, y));
    }
}

/// How long a menu takes to open a submenu or to close, or a screen to
/// finish its push or pop, at most.
const SYSTEM_MOVES: Duration = Duration::from_secs(2);

/// The middle of `view` in `window`'s points.
fn middle(view: &UIView, window: &UIWindow) -> (f64, f64) {
    let r = view.convertRect_toView(view.bounds(), Some(window));
    (
        r.origin.x + r.size.width / 2.0,
        r.origin.y + r.size.height / 2.0,
    )
}

/// The windows of `window`'s scene, the menus' included (UIKit may show a
/// menu in a window of its own), in drawing order.
fn scene_windows(window: &UIWindow) -> Vec<Retained<UIWindow>> {
    let Some(scene) = window.windowScene() else {
        return vec![window.retain()];
    };
    // SAFETY: UIWindowScene's `windows`, an array of its windows.
    let windows: Retained<objc2_foundation::NSArray<UIWindow>> =
        unsafe { msg_send![&scene, windows] };
    let mut windows = windows.to_vec();
    windows.retain(|w| !w.isHidden());
    windows.sort_by(|a, b| a.windowLevel().total_cmp(&b.windowLevel()));
    windows
}

/// The menus the system shows over `window` (a menu button's, a context
/// menu's, a bar button's): UIKit's context menu container views, which it
/// draws them in.
fn system_menus(window: &UIWindow) -> Vec<Retained<UIView>> {
    fn walk(view: &UIView, out: &mut Vec<Retained<UIView>>) {
        if view.isHidden() || view.alpha() < 0.01 {
            return;
        }
        if crate::navigation::class_named(view, "ContextMenuContainerView") {
            out.push(view.retain());
            return;
        }
        for sub in view.subviews().iter() {
            walk(&sub, out);
        }
    }
    let mut out = Vec::new();
    for w in scene_windows(window) {
        walk(&w, &mut out);
    }
    out
}

/// The labels showing in `view`'s subtree, in drawing order.
fn labels(view: &UIView, out: &mut Vec<Retained<UILabel>>) {
    if view.isHidden() || view.alpha() < 0.01 {
        return;
    }
    if let Some(label) = view.downcast_ref::<UILabel>() {
        if label
            .text()
            .is_some_and(|t| !t.to_string().trim().is_empty())
        {
            out.push(label.retain());
        }
        return;
    }
    for sub in view.subviews().iter() {
        labels(&sub, out);
    }
}

/// What the open system menus show, in drawing order.
fn menu_labels(window: &UIWindow) -> Vec<Retained<UILabel>> {
    let mut out = Vec::new();
    for menu in system_menus(window) {
        labels(&menu, &mut out);
    }
    out
}

/// Where the open system menu's item titled `title` is (the front one so
/// titled), or what the menu shows instead.
fn menu_item_point(window: &UIWindow, title: &str) -> Result<(f64, f64), Vec<String>> {
    let shown = menu_labels(window);
    let text = |l: &UILabel| l.text().map(|t| t.to_string()).unwrap_or_default();
    match shown.iter().rev().find(|l| text(l).trim() == title) {
        Some(label) => Ok(middle(label, window)),
        None => {
            let mut titles: Vec<String> = shown.iter().map(|l| text(l).trim().to_owned()).collect();
            titles.dedup();
            Err(titles)
        }
    }
}

/// A point in `window` away from the open menus' items, where a tap closes
/// them: the window's corner farthest from them.
fn outside_menus(window: &UIWindow) -> (f64, f64) {
    let size = window.bounds().size;
    let shown = menu_labels(window);
    let points: Vec<(f64, f64)> = shown.iter().map(|l| middle(l, window)).collect();
    // Below the status bar and above the home indicator.
    let corners = [
        (12.0, 80.0),
        (size.width - 12.0, 80.0),
        (12.0, size.height - 40.0),
        (size.width - 12.0, size.height - 40.0),
    ];
    let nearest = |c: &(f64, f64)| {
        points
            .iter()
            .map(|p| (p.0 - c.0).hypot(p.1 - c.1))
            .fold(f64::INFINITY, f64::min)
    };
    corners
        .into_iter()
        .max_by(|a, b| nearest(a).total_cmp(&nearest(b)))
        .unwrap_or((12.0, 80.0))
}

/// A control UIKit draws over the app's content (a `MenuButton`'s
/// `UIButton`): in the view the test id names (`testID` is a view's
/// accessibility identifier), or labelled so itself.
fn system_button(
    window: &UIWindow,
    name: &crate::navigation::BarName<'_>,
) -> Option<Retained<UIView>> {
    use crate::navigation::BarName;
    fn shows(view: &UIView) -> bool {
        !view.isHidden() && view.alpha() > 0.01
    }
    fn control(view: &UIView) -> Option<Retained<UIView>> {
        if !shows(view) {
            return None;
        }
        if view.isKindOfClass(<objc2_ui_kit::UIControl as objc2::ClassType>::class()) {
            return Some(view.retain());
        }
        view.subviews().iter().find_map(|v| control(&v))
    }
    fn walk(view: &UIView, name: &BarName<'_>) -> Option<Retained<UIView>> {
        if !shows(view) {
            return None;
        }
        // SAFETY: UIView's `accessibilityIdentifier` and
        // `accessibilityLabel` getters, optional strings.
        let (id, label): (
            Option<Retained<objc2_foundation::NSString>>,
            Option<Retained<objc2_foundation::NSString>>,
        ) = unsafe {
            (
                msg_send![view, accessibilityIdentifier],
                msg_send![view, accessibilityLabel],
            )
        };
        let found = match name {
            BarName::Id(want) => id
                .is_some_and(|id| id.to_string() == *want)
                .then(|| view.subviews().iter().find_map(|v| control(&v)))
                .flatten(),
            BarName::Label(want) => (view
                .isKindOfClass(<objc2_ui_kit::UIControl as objc2::ClassType>::class())
                && label.is_some_and(|l| l.to_string().trim() == *want))
            .then(|| view.retain()),
        };
        found.or_else(|| view.subviews().iter().find_map(|v| walk(&v, name)))
    }
    walk(window, name)
}

/// What kind of bar `view` is, as a failure names it, when it is one
/// that UIKit draws over a screen's content (a navigation bar, a tab bar, a
/// toolbar): content scrolls under it, and a press there reaches it.
fn bar_kind(view: &UIView) -> Option<&'static str> {
    if view.isKindOfClass(<objc2_ui_kit::UINavigationBar as objc2::ClassType>::class()) {
        Some("the navigation bar")
    } else if view.isKindOfClass(<objc2_ui_kit::UITabBar as objc2::ClassType>::class()) {
        Some("the tab bar")
    } else if objc2::runtime::AnyClass::get(c"UIToolbar").is_some_and(|c| view.isKindOfClass(c)) {
        Some("the toolbar")
    } else {
        None
    }
}

/// The bar ([`bar_kind`]) that `view` is in, or is, and its kind.
fn system_bar(view: &UIView) -> Option<(Retained<UIView>, &'static str)> {
    let mut at = Some(view.retain());
    while let Some(v) = at {
        if let Some(kind) = bar_kind(&v) {
            return Some((v, kind));
        }
        at = v.superview();
    }
    None
}

/// Whether `view` is in the edit menu UIKit shows for a selection
/// (`UIEditMenuInteraction`'s; its views are private, found by name).
fn in_edit_menu(view: &UIView) -> bool {
    let mut at = Some(view.retain());
    while let Some(v) = at {
        if crate::navigation::class_named(&v, "EditMenuContainerView") {
            return true;
        }
        at = v.superview();
    }
    false
}

/// The bars ([`bar_kind`]) showing in `view`'s subtree.
fn shown_bars(view: &UIView, out: &mut Vec<Retained<UIView>>) {
    if view.isHidden() || view.alpha() < 0.01 {
        return;
    }
    if bar_kind(view).is_some() {
        out.push(view.retain());
        return;
    }
    for sub in view.subviews().iter() {
        shown_bars(&sub, out);
    }
}

/// How far the bars UIKit draws over `scroll` (`rect`, in `window`'s
/// points) reach into it from its top and from its bottom: a navigation
/// bar over its top (the status bar above it included), a tab bar or a
/// toolbar over its bottom. Only the part of a bar that takes a press
/// there counts (a bar behind a sheet does not); `skip` says which bars
/// do not count at all.
fn bars_over(
    window: &UIWindow,
    rect: CGRect,
    skip: impl Fn(&UIView) -> bool,
) -> (CGFloat, CGFloat) {
    let mut bars = Vec::new();
    shown_bars(window, &mut bars);
    let (min_x, max_x) = (rect.origin.x, rect.origin.x + rect.size.width);
    let (min_y, max_y) = (rect.origin.y, rect.origin.y + rect.size.height);
    let (mut top, mut bottom): (CGFloat, CGFloat) = (0.0, 0.0);
    for bar in bars.iter().filter(|b| !skip(b)) {
        let b = bar.convertRect_toView(bar.bounds(), Some(window));
        let (from_x, to_x) = (
            b.origin.x.max(min_x),
            (b.origin.x + b.size.width).min(max_x),
        );
        let (from_y, to_y) = (
            b.origin.y.max(min_y),
            (b.origin.y + b.size.height).min(max_y),
        );
        if from_x >= to_x || from_y >= to_y {
            continue;
        }
        let probe = CGPoint::new((from_x + to_x) / 2.0, (from_y + to_y) / 2.0);
        if !window
            .hitTest_withEvent(probe, None)
            .is_some_and(|hit| hit.isDescendantOfView(bar))
        {
            continue;
        }
        if b.origin.y + b.size.height / 2.0 < min_y + rect.size.height / 2.0 {
            top = top.max(b.origin.y + b.size.height - min_y);
        } else {
            bottom = bottom.max(max_y - b.origin.y);
        }
    }
    (top, bottom)
}

/// `rect` of `view` in `window`'s points, if the view shows.
fn bounds_in(view: &UIView, rect: CGRect, window: &UIWindow) -> Option<Bounds<Points>> {
    if view.window().is_none() || view.isHidden() {
        return None;
    }
    let r = view.convertRect_toView(rect, Some(window));
    Some(Bounds::new(
        point(Points(r.origin.x as f32), Points(r.origin.y as f32)),
        Size::new(Points(r.size.width as f32), Points(r.size.height as f32)),
    ))
}

impl Native for IosNative {
    fn bounds(&self, id: NodeId) -> Option<Bounds<Points>> {
        self.on_main(move |view, window| {
            let ui = view.with_mounter(|m| m.ui_view(id))??;
            bounds_in(&ui, ui.bounds(), window)
        })
        .flatten()
    }

    fn text_bounds(&self, text: NodeId, start: u32, end: u32) -> Option<Bounds<Points>> {
        self.on_main(move |view, window| {
            let text = view.with_mounter(|m| m.text_view(text))??;
            let (rect, ..) = *text.range_rects(start as usize, end as usize).first()?;
            bounds_in(&text, rect, window)
        })
        .flatten()
    }

    fn scroll_room(&self, id: NodeId, horizontal: bool) -> Option<(Points, Points)> {
        self.on_main(move |view, _| view.with_mounter(|m| m.scroll_room(id, horizontal)))
            .flatten()
            .flatten()
            .map(|(start, end)| (Points(start as f32), Points(end as f32)))
    }

    fn scroll_insets(&self, id: NodeId, horizontal: bool) -> (Points, Points) {
        self.on_main(move |view, window| {
            let (scroll, (start, end)) =
                view.with_mounter(|m| Some((m.ui_view(id)?, m.scroll_insets(id, horizontal)?)))??;
            if horizontal {
                return Some((start, end));
            }
            // NSH lays its scroll views out within the safe area and keeps
            // UIKit from adjusting their insets for the bars, but a header
            // the content scrolls under (a transparent one) still covers
            // the top: the larger of the two, so a large title's bar, which
            // UIKit does adjust the inset for, counts once.
            let rect = scroll.convertRect_toView(scroll.bounds(), Some(window));
            let (top, bottom) = bars_over(window, rect, |bar| {
                // A bar in the scroll view's own content (a nested stack's
                // header) scrolls with what it covers: scrolling brings
                // nothing out from under it, it is no edge of the scroll
                // view. One the app mounts is the app's view, the model's.
                bar.isDescendantOfView(&scroll)
                    || view.with_mounter(|m| m.in_component(bar)).unwrap_or(false)
            });
            Some((start.max(top), end.max(bottom)))
        })
        .flatten()
        .map_or((Points(0.0), Points(0.0)), |(start, end)| {
            (Points(start as f32), Points(end as f32))
        })
    }

    fn covered(&self, id: NodeId, at: Point<Points>) -> Option<String> {
        let (x, y) = (f64::from(at.x.0), f64::from(at.y.0));
        self.on_main(move |view, window| {
            let target = view.with_mounter(|m| m.ui_view(id))??;
            // Inside a bar already (a header's own view): the bar is where
            // it is pressed.
            if system_bar(&target).is_some() {
                return None;
            }
            let hit = window.hitTest_withEvent(CGPoint::new(x, y), None)?;
            // The view, one inside it (its text, a native control) or one
            // around it that takes the touch for it.
            if hit.isDescendantOfView(&target) || target.isDescendantOfView(&hit) {
                return None;
            }
            // A selection's edit menu (Copy, Select All) stays up after the
            // long press that opened it, over the app in the same window.
            if in_edit_menu(&hit) {
                return Some("the edit menu".to_owned());
            }
            // Another of the app's views is the model's to find
            // (`Scene::pick`), a `TabBar` it mounts too; only what UIKit
            // draws over the app counts.
            let (bar, kind) = system_bar(&hit)?;
            if view.with_mounter(|m| m.in_component(&bar)).unwrap_or(true) {
                return None;
            }
            Some(kind.to_owned())
        })
        .flatten()
    }

    fn viewport(&self) -> Size<Points> {
        self.on_main(|_, window| {
            let s = window.bounds().size;
            Size::new(Points(s.width as f32), Points(s.height as f32))
        })
        .unwrap_or(Size::new(Points(0.0), Points(0.0)))
    }

    fn press(&self, at: Point<Points>) {
        self.tap(f64::from(at.x.0), f64::from(at.y.0), TAP);
    }

    fn long_press(&self, at: Point<Points>, hold: Duration) {
        self.tap(f64::from(at.x.0), f64::from(at.y.0), hold);
    }

    fn scroll(&self, at: Point<Points>, delta: Point<Points>) {
        // The content moves towards its end as the finger moves the other
        // way.
        let from = (f64::from(at.x.0), f64::from(at.y.0));
        let to = (from.0 - f64::from(delta.x.0), from.1 - f64::from(delta.y.0));
        self.swipe(from, to, REST);
    }

    fn drag(
        &self,
        from: Point<Points>,
        to: Point<Points>,
        options: DragOptions,
    ) -> Result<(), String> {
        self.drag_finger(from, to, options, false)
    }

    fn drag_and_hold(
        &self,
        from: Point<Points>,
        to: Point<Points>,
        options: DragOptions,
    ) -> Result<(), String> {
        self.drag_finger(from, to, options, true)
    }

    fn drop_at(&self, at: Point<Points>) -> Result<(), String> {
        let at = (f64::from(at.x.0), f64::from(at.y.0));
        // The finger rested since the drag left it down: it lifts at rest,
        // as a real one held still does, not with the drag's speed.
        if let Some(way) = self.held.lock().unwrap().take()
            && let Err(error) = self.rest(at, way, REST)
        {
            let _ = self.try_finger(at.0, at.1, Phase::Up);
            return Err(error);
        }
        self.try_finger(at.0, at.1, Phase::Up)
    }

    fn focused(&self) -> Option<NodeId> {
        self.on_main(|_, window| crate::input::test_focused(window))
            .flatten()
    }

    fn paste(&self, content: &nsh_core::PasteEvent) -> Result<(), String> {
        let content = content.clone();
        self.on_main(move |_, window| crate::input::test_paste(window, &content))
            .unwrap_or_else(|| Err("the window is gone".into()))
    }

    fn type_text(&self, text: &str) {
        if let Err(error) = self.try_type_text(text) {
            log::warn!("test: {error}");
        }
    }

    fn try_type_text(&self, text: &str) -> Result<(), String> {
        // As the software keyboard types, a character at a time, at a
        // quick typist's pace: a controlled input's value comes back from
        // the app between keys, as it does on a device. Each key waits
        // for the one before it to land in the input: the simulator's
        // keyboard drops a key typed while it still handles the previous
        // one, the second of two equal keys most often ("hello" became
        // "HELO" in a controlled input on a slow runner).
        for ch in text.chars() {
            let before = self
                .on_main(|_, window| synth::focused_text(window))
                .flatten();
            let s = ch.to_string();
            self.on_main(move |_, window| synth::insert_text(window, &s))
                .unwrap_or_else(|| Err("the window is gone".into()))?;
            // Without a focused text there is nothing to watch: waiting
            // would only add `KEY_LANDS` to every key.
            let deadline = Instant::now() + KEY_LANDS;
            while before.is_some() {
                std::thread::sleep(KEY / 4);
                let now = self
                    .on_main(|_, window| synth::focused_text(window))
                    .flatten();
                // An input that refuses the key (`maxLength`) never changes.
                if now != before || Instant::now() >= deadline {
                    break;
                }
            }
            std::thread::sleep(KEY);
        }
        Ok(())
    }

    fn key(&self, key: Key) {
        if let Err(error) = self.try_key(key) {
            log::warn!("test: {error}");
        }
    }

    fn try_key(&self, key: Key) -> Result<(), String> {
        self.on_main(move |_, window| match key {
            // The keyboard's return key types a line break.
            Key::Return => synth::insert_text(window, "\n"),
            Key::Backspace => synth::delete_backward(window),
            Key::SelectAll => synth::select_all(window),
        })
        .unwrap_or_else(|| Err("the window is gone".into()))
    }

    fn press_keys(&self, keys: &str) -> Result<(), String> {
        use nsh_core::keymap::Keystroke;
        let stroke =
            Keystroke::parse(keys, nsh_core::platform::Os::Ios).map_err(|e| e.to_string())?;
        let usage = stroke
            .key
            .hid_usage()
            .ok_or_else(|| format!("a hardware keyboard has no key {keys:?}"))?;
        let m = stroke.modifiers;
        let modifiers: Vec<u16> = [
            (m.ctrl, synth::CONTROL),
            (m.alt, synth::OPTION),
            (m.shift, synth::SHIFT),
            (m.cmd, synth::COMMAND),
        ]
        .into_iter()
        .filter_map(|(on, usage)| on.then_some(usage))
        .collect();
        // As a hand presses a shortcut: the modifiers down first, the key
        // pressed and released, then the modifiers released.
        let held = modifiers.clone();
        self.on_main(move |_, window| {
            for usage in held {
                synth::key(window, usage, true);
            }
            synth::key(window, usage, true)
        })
        .filter(|sent| *sent)
        .ok_or_else(|| "the simulator takes no keyboard events".to_owned())?;
        std::thread::sleep(TAP);
        self.on_main(move |_, window| {
            synth::key(window, usage, false);
            for usage in modifiers.into_iter().rev() {
                synth::key(window, usage, false);
            }
        });
        Ok(())
    }

    fn input_text(&self, id: NodeId) -> Option<String> {
        self.on_main(move |view, _| view.with_mounter(|m| m.input_text(id)).flatten())
            .flatten()
    }

    fn back(&self) -> Result<(), String> {
        // What a user does: a sheet is swiped down; while the app listens
        // to going back (a menu's or popover's `onCancel`, over the whole
        // screen), VoiceOver's escape gesture reaches the surface, as the
        // headless driver's back reaches the core; a pushed screen goes
        // with the header's back button.
        enum Gesture {
            Tap(f64, f64),
            Swipe((f64, f64), (f64, f64)),
            Escaped,
        }
        // A push or pop still animating leaves its back button showing,
        // and a sheet takes no swipe until it ends: as a user waits.
        let since = Instant::now();
        while since.elapsed() < SYSTEM_MOVES
            && self
                .on_main(|_, window| crate::navigation::navigation_transitioning(window))
                .unwrap_or(false)
        {
            std::thread::sleep(FRAME * 2);
        }
        let gesture = self
            .on_main(|view, window| {
                let size = window.bounds().size;
                if let Some(sheet) = crate::navigation::presented_sheet(window) {
                    // A screen pushed in the sheet goes with its header's
                    // back button; the sheet's first one with a swipe down.
                    if let Some(button) = crate::navigation::back_button(&sheet) {
                        let (x, y) = middle(&button, window);
                        return Ok(Gesture::Tap(x, y));
                    }
                    let top = sheet
                        .convertRect_toView(sheet.bounds(), Some(window))
                        .origin
                        .y;
                    let x = size.width / 2.0;
                    return Ok(Gesture::Swipe(
                        (x, top + 20.0),
                        (x, top + size.height * 0.6),
                    ));
                }
                // Taken out first: the escape reads the mounter too.
                let root = view
                    .with_mounter(|m| m.ui_view(nsh_core::ROOT_ID))
                    .flatten();
                // SAFETY: a UIAccessibilityAction method every view has.
                if root.is_some_and(|r| unsafe { msg_send![&r, accessibilityPerformEscape] }) {
                    return Ok(Gesture::Escaped);
                }
                let button = crate::navigation::back_button(window)
                    .ok_or("the screen shows no back button to go back with")?;
                let (x, y) = middle(&button, window);
                Ok(Gesture::Tap(x, y))
            })
            .unwrap_or_else(|| Err("the window is gone".to_owned()))?;
        match gesture {
            Gesture::Tap(x, y) => self.tap(x, y, TAP),
            Gesture::Swipe(from, to) => self.swipe(from, to, Duration::ZERO),
            Gesture::Escaped => {}
        }
        Ok(())
    }

    fn system_control(&self, name: SystemName<'_>) -> Option<Bounds<Points>> {
        use crate::navigation::BarName;
        let name = match name {
            SystemName::TestId(id) => BarName::Id(id),
            SystemName::Label(label) => BarName::Label(label),
            _ => return None,
        };
        self.on_main(move |_, window| {
            let button = crate::navigation::bar_button(window, &name)
                .or_else(|| system_button(window, &name))?;
            bounds_in(&button, button.bounds(), window)
        })
        .flatten()
    }

    fn system_menu_open(&self) -> bool {
        self.on_main(|_, window| !system_menus(window).is_empty())
            .unwrap_or(false)
    }

    fn choose_menu_item(&self, path: &[String]) -> Result<(), String> {
        for (i, title) in path.iter().enumerate() {
            let title = title.clone();
            // A submenu's items show once it opens.
            let since = Instant::now();
            let (x, y) = loop {
                let found = self
                    .on_main({
                        let title = title.clone();
                        move |_, window| menu_item_point(window, &title)
                    })
                    .ok_or("the window is gone")?;
                match found {
                    Ok(at) => break at,
                    Err(_) if since.elapsed() < SYSTEM_MOVES => std::thread::sleep(FRAME * 4),
                    Err(shown) => {
                        return Err(format!(
                            "the menu has no item {title:?}; it shows: {}",
                            shown.join(", ")
                        ));
                    }
                }
            };
            if i > 0 {
                // Let the submenu settle where it opens before the tap.
                std::thread::sleep(Duration::from_millis(300));
            }
            self.tap(x, y, TAP);
        }
        self.menu_closed("chosen")
    }

    fn close_menu(&self) -> Result<(), String> {
        let (x, y) = self
            .on_main(|_, window| outside_menus(window))
            .ok_or("the window is gone")?;
        self.tap(x, y, TAP);
        self.menu_closed("closed")
    }

    fn answer_dialog(&self, button: Option<&str>) -> Result<(), String> {
        let button = button.map(str::to_owned);
        let (x, y) = self
            .on_main(move |_, window| crate::system::dialog_point(window, button.as_deref()))
            .unwrap_or_else(|| Err("the window is gone".into()))?;
        self.tap(x, y, TAP);
        Ok(())
    }

    fn animating(&self) -> bool {
        self.on_main(|view, window| {
            view.with_mounter(|m| m.animating()).unwrap_or(false) || synth::animating(window)
        })
        .unwrap_or(false)
    }

    fn screenshot(&self) -> Result<Vec<u8>, String> {
        self.on_main(|_, window| synth::screenshot(window))
            .unwrap_or_else(|| Err("the window is gone".into()))
    }

    fn resize(&self, _: Points, _: Points) -> Result<(), String> {
        Err("a simulator's screen keeps its device's size".into())
    }

    fn set_dark(&self, _: bool) -> Result<(), String> {
        // The system's appearance is the simulator's, which `nsh test`
        // switches (`simctl ui appearance`).
        Err("the simulator's settings switch its appearance".into())
    }

    fn quit(&self) {
        // The test's side ends the app (`simctl terminate`).
    }
}
