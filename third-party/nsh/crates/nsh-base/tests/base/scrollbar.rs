//! `Scrollbar`: a bar of the app's own over a scroll view it names. Its
//! thumb follows the target's offset and content; a drag of it, or a
//! press on its track, scrolls the target; it shows by its mode (while
//! the target scrolls, while the pointer is over it, always) and fades by
//! its motion, as `gpui-base`'s does, and never shows while the content
//! fits.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use nsh_base::{
    ScrollbarEntrance, ScrollbarLook, ScrollbarMode, ScrollbarMotion, ScrollbarTheme, scrollbar,
    set_scrollbar_theme,
};
use nsh_core::{
    MountItem, NodeId, Size, Transform,
    animation::{AnimationOp, AnimationProp, Driver},
    element::Root,
    geometry::point,
    platform::Os,
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    mode: ScrollbarMode,
    motion: ScrollbarMotion,
    /// How tall the content is (the viewport is 200).
    content: f32,
}

/// A scroll view 300 by 200 of `content` points with its own indicator
/// off, and a bar 10 wide over its right edge, labelled `Bar` (its track
/// 200 long: the thumb is 40 long over 1000 points and travels 160; it has
/// a transition, as a thumb that widens does); the offset the scroll view
/// last reported.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let content = element_ref();
    let offset = signal(0.0_f32);
    view()
        .child(
            view()
                .relative()
                .w(px(300.0))
                .h(px(200.0))
                .child(
                    scroll()
                        .element_ref(&content)
                        .test_id("content")
                        .size_full()
                        .scrollbar(false)
                        .on_scroll(move |e: &ScrollEvent| offset.set(e.offset.y.0))
                        .child(view().w_full().h(px(props.content))),
                )
                .child(
                    scrollbar()
                        .scroll(content)
                        .mode(props.mode)
                        .motion(props.motion)
                        // Under the thumb's 40 points over 1000 (the default is 48).
                        .min_thumb_length(px(24.0))
                        .accessibility_label("Bar")
                        .absolute()
                        .top_0()
                        .right_0()
                        .bottom_0()
                        .w(px(10.0))
                        .thumb_style(|s| s.w_full().transition_all().duration(150.0)),
                ),
        )
        .child(text(move || format!("Offset {}", offset.get().round())))
}

/// What the batches showed of the bar.
#[derive(Default)]
struct Shown {
    /// The bar's node.
    bar: Option<NodeId>,
    /// Each view's bound opacity: its animation node.
    opacity: HashMap<NodeId, nsh_core::animation::NodeId>,
    /// Where each animation node was set or last sent.
    values: HashMap<nsh_core::animation::NodeId, f32>,
    /// The fades of the bar's opacity: their target and duration.
    fades: Vec<(f32, f32)>,
    /// Each batch that scrolled the target: whether it also moved a view
    /// (the thumb).
    scrolls: Vec<bool>,
    /// Whether a view that moved also had a transition.
    moved_with_transition: bool,
}

#[derive(Clone, Default)]
struct Seen(Arc<Mutex<Shown>>);

impl Seen {
    /// The bar is shown (or on its way): its opacity's target is not 0.
    fn shown(&self) -> bool {
        let seen = self.0.lock().unwrap();
        let bar = seen.bar.expect("the bar is mounted");
        let node = seen.opacity.get(&bar).expect("the bar's opacity is bound");
        seen.values.get(node).copied().unwrap_or(0.0) > 0.0
    }

    /// The fades of the bar's opacity so far, taken.
    fn fades(&self) -> Vec<(f32, f32)> {
        std::mem::take(&mut self.0.lock().unwrap().fades)
    }
}

/// The harness on a headless macOS surface (a mouse to hover with), on a
/// manual clock; what its batches show of the bar.
fn start(mode: ScrollbarMode, content: f32) -> (Headless, Seen) {
    let mut motion = ScrollbarMotion::default();
    motion.idle = 500.0;
    start_with(mode, motion, content)
}

/// [`start`] with `motion`.
fn start_with(mode: ScrollbarMode, motion: ScrollbarMotion, content: f32) -> (Headless, Seen) {
    // A manual clock: the bar hides only when the test moves it.
    let mut config = EngineConfig {
        viewport: Size::new(px(400.0), px(844.0)),
        clock: nsh_engine::Clock::manual(std::time::SystemTime::now()),
        ..EngineConfig::new(Root::new::<Harness>(move || HarnessProps {
            mode,
            motion,
            content,
        }))
    };
    config.environment.os = Os::MacOs;
    let mut app = Headless::start(config).expect("the engine starts");
    let seen = Seen::default();
    let record = seen.clone();
    app.observe(move |_, batch| {
        let mut seen = record.0.lock().unwrap();
        let scrolled = batch.items.iter().any(|item| matches!(item, MountItem::Command { .. }));
        let moved = batch.items.iter().any(|item| {
            matches!(item, MountItem::ViewStyle { style, .. } if style.transform != Transform::default())
        });
        if scrolled {
            seen.scrolls.push(moved);
        }
        if batch.items.iter().any(|item| {
            matches!(item, MountItem::ViewStyle { style, .. }
                if style.transform != Transform::default() && style.transition.is_some())
        }) {
            seen.moved_with_transition = true;
        }
        for item in &batch.items {
            match item {
                MountItem::ViewProps { id, props }
                    if props.accessibility.label.as_deref() == Some("Bar") =>
                {
                    seen.bar = Some(*id);
                }
                MountItem::AnimationBindings { id, bindings } => {
                    for (prop, node) in bindings {
                        if *prop == AnimationProp::Opacity {
                            seen.opacity.insert(*id, *node);
                        }
                    }
                }
                MountItem::Animation(AnimationOp::Set { node, value }) => {
                    seen.values.insert(*node, *value);
                }
                MountItem::Animation(AnimationOp::Start {
                    node,
                    driver: Driver::Timing { to, duration_ms, .. },
                    ..
                }) => {
                    seen.values.insert(*node, *to);
                    let bar = seen.bar.and_then(|bar| seen.opacity.get(&bar).copied());
                    if bar == Some(*node) {
                        seen.fades.push((*to, *duration_ms));
                    }
                }
                _ => {}
            }
        }
    });
    app.wait_for("text:Offset 0").unwrap();
    (app, seen)
}

/// Presses the middle of the bar and drags across its axis, which
/// scrolls nothing more: where the press went shows.
fn press_middle(app: &mut Headless) {
    app.drag("label:Bar", point(px(40.0), px(0.0))).unwrap();
}

#[test]
fn a_press_on_the_track_centers_the_thumb_there_and_a_drag_goes_on() {
    let (mut app, seen) = start(ScrollbarMode::Always, 1000.0);
    assert!(seen.shown());
    // From the middle of the track (the thumb is at 0 to 40): the thumb's
    // middle there puts its start at 80, half its travel (400), and 40
    // points down are 40 of 160 more: 200 of 800.
    app.drag("label:Bar", point(px(0.0), px(40.0))).unwrap();
    app.wait_for("text:Offset 600").unwrap();
    // Past the end: held at it.
    app.drag("label:Bar", point(px(0.0), px(400.0))).unwrap();
    app.wait_for("text:Offset 800").unwrap();
}

#[test]
fn a_drag_moves_the_thumb_in_the_batch_that_scrolls() {
    let (mut app, seen) = start(ScrollbarMode::Always, 1000.0);
    app.drag("label:Bar", point(px(0.0), px(40.0))).unwrap();
    app.wait_for("text:Offset 600").unwrap();
    // Not a frame later, when the platform reports the scroll: the thumb
    // would trail the pointer.
    let seen = seen.0.lock().unwrap();
    assert!(!seen.scrolls.is_empty());
    assert!(
        seen.scrolls.iter().all(|&moved| moved),
        "{:?}",
        seen.scrolls
    );
    // The thumb's transition (the harness's `transition_all`) does not
    // animate its place.
    assert!(!seen.moved_with_transition);
}

#[test]
fn the_thumb_follows_the_target_scrolled_elsewhere() {
    let (mut app, _) = start(ScrollbarMode::Always, 1000.0);
    app.scroll("id:content", px(400.0)).unwrap();
    app.wait_for("text:Offset 400").unwrap();
    // The thumb is at 80 to 120 now: a drag from the middle takes it, and
    // 16 points move the content 80.
    app.drag("label:Bar", point(px(0.0), px(16.0))).unwrap();
    app.wait_for("text:Offset 480").unwrap();
}

#[test]
fn while_scrolling_it_shows_and_hides_after_the_delay() {
    let (mut app, seen) = start(ScrollbarMode::Scrolling, 1000.0);
    assert!(!seen.shown());
    app.scroll("id:content", px(100.0)).unwrap();
    app.wait_for("text:Offset 100").unwrap();
    assert!(seen.shown());
    press_middle(&mut app);
    app.wait_for("text:Offset 400").unwrap();
    // A drag keeps it until the delay after it ends.
    app.fast_forward(Duration::from_millis(400)).unwrap();
    assert!(seen.shown());
    app.fast_forward(Duration::from_millis(200)).unwrap();
    assert!(!seen.shown());
}

#[test]
fn on_hover_it_shows_while_the_pointer_is_over_the_bar() {
    let (mut app, seen) = start(ScrollbarMode::Hover, 1000.0);
    assert!(!seen.shown());
    // Over the content: nothing.
    app.hover("id:content").unwrap();
    assert!(!seen.shown());
    // Over where the bar shows: it does, and stays the idle time after
    // the pointer leaves.
    app.hover("label:Bar").unwrap();
    assert!(seen.shown());
    app.hover("id:content").unwrap();
    app.fast_forward(Duration::from_millis(400)).unwrap();
    assert!(seen.shown());
    app.fast_forward(Duration::from_millis(200)).unwrap();
    assert!(!seen.shown());
}

#[test]
fn it_fades_in_and_out_by_its_motion() {
    let mut motion = ScrollbarMotion::default();
    motion.idle = 500.0;
    motion.enter = 300.0;
    motion.exit = 500.0;
    let (mut app, seen) = start_with(ScrollbarMode::Scrolling, motion, 1000.0);
    assert!(seen.fades().is_empty(), "the first state snaps");
    app.scroll("id:content", px(100.0)).unwrap();
    app.wait_for("text:Offset 100").unwrap();
    assert_eq!(seen.fades(), vec![(1.0, 300.0)]);
    app.fast_forward(Duration::from_millis(600)).unwrap();
    assert_eq!(seen.fades(), vec![(0.0, 500.0)]);
    // Brought back halfway through its exit (eased in: an eighth of the
    // way), it comes in over the share still to cover.
    app.fast_forward(Duration::from_millis(1000)).unwrap();
    app.scroll("id:content", px(100.0)).unwrap();
    app.wait_for("text:Offset 200").unwrap();
    let fades = seen.fades();
    assert_eq!(fades.len(), 1);
    assert_eq!(fades[0].0, 1.0);
    assert!(fades[0].1 > 0.0 && fades[0].1 <= 300.0, "{fades:?}");
}

#[test]
fn an_always_bar_never_fades() {
    let mut motion = ScrollbarMotion::default();
    motion.enter = 300.0;
    motion.exit = 500.0;
    motion.entrance = ScrollbarEntrance::SlideAndFade;
    let (mut app, seen) = start_with(ScrollbarMode::Always, motion, 1000.0);
    assert!(seen.shown());
    app.scroll("id:content", px(100.0)).unwrap();
    app.wait_for("text:Offset 100").unwrap();
    assert!(seen.fades().is_empty());
}

#[test]
fn it_never_shows_while_the_content_fits() {
    let (_, seen) = start(ScrollbarMode::Always, 150.0);
    assert!(!seen.shown());
}

#[derive(Clone, PartialEq, Props)]
struct BuiltInProps {
    /// A list rather than a scroll view.
    list: bool,
}

/// A scroll view (or a list of 20 rows of 50) 300 by 200 of 1000 points,
/// in an app that draws every bar: an `always` bar 10 wide over the right
/// edge, labelled `Bar`; the offset it last reported.
#[component]
fn BuiltIn(props: BuiltInProps) -> impl IntoElement {
    let mut look = ScrollbarLook::default();
    look.class = Some("absolute top-0 right-0 bottom-0 w-[10px]".into());
    look.thumb_class = Some("w-full".into());
    look.accessibility_label = Some("Bar".into());
    let mut theme = ScrollbarTheme::default();
    theme.mode = ScrollbarMode::Always;
    theme.min_thumb_length = px(24.0);
    theme.vertical = Some(look);
    set_scrollbar_theme(Some(theme));
    let offset = signal(0.0_f32);
    let on_scroll = move |e: &ScrollEvent| offset.set(e.offset.y.0);
    let view_of = if props.list {
        virtual_list(20, |_| view().h(px(50.0)))
            .test_id("content")
            .w(px(300.0))
            .h(px(200.0))
            .on_scroll(on_scroll)
            .into_element()
    } else {
        scroll()
            .test_id("content")
            .w(px(300.0))
            .h(px(200.0))
            .on_scroll(on_scroll)
            .child(view().w_full().h(px(1000.0)))
            .into_element()
    };
    view()
        .child(view_of)
        .child(text(move || format!("Offset {}", offset.get().round())))
}

/// [`BuiltIn`] headless; whether each scroll view's platform indicator
/// shows, as last sent.
fn start_built_in(list: bool) -> (Headless, Arc<Mutex<HashMap<NodeId, bool>>>) {
    let mut config = EngineConfig {
        viewport: Size::new(px(400.0), px(844.0)),
        ..EngineConfig::new(Root::new::<BuiltIn>(move || BuiltInProps { list }))
    };
    config.environment.os = Os::MacOs;
    let mut app = Headless::start(config).expect("the engine starts");
    let indicators = Arc::new(Mutex::new(HashMap::new()));
    let record = indicators.clone();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ScrollConfig {
                id,
                scrollbar_visible,
                ..
            } = item
            {
                record.lock().unwrap().insert(*id, *scrollbar_visible);
            }
        }
    });
    app.wait_for("text:Offset 0").unwrap();
    (app, indicators)
}

#[test]
fn a_built_in_bar_scrolls_its_view_in_place_of_the_indicator() {
    let (mut app, indicators) = start_built_in(false);
    // The thumb is 40 of the track's 200 and travels 160 over 800 points.
    app.drag("label:Bar", point(px(0.0), px(40.0))).unwrap();
    app.wait_for("text:Offset 600").unwrap();
    let indicators = indicators.lock().unwrap();
    assert_eq!(indicators.values().copied().collect::<Vec<_>>(), [false]);
}

#[test]
fn a_list_has_its_built_in_bar_too() {
    let (mut app, indicators) = start_built_in(true);
    app.drag("label:Bar", point(px(0.0), px(40.0))).unwrap();
    app.wait_for("text:Offset 600").unwrap();
    let indicators = indicators.lock().unwrap();
    assert_eq!(indicators.values().copied().collect::<Vec<_>>(), [false]);
}
