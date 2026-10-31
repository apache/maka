//! `Tabs`: one stop of the keyboard focus, at the selected tab; the arrow
//! keys, Home and End move between the tabs past disabled ones, around the
//! ends, and select the tab they reach (automatic activation). On macOS,
//! where Tab stops at views that take presses.
//!
//! Its indicator: on the selected tab along the list, placed by the core
//! (no layout events, no JS), springing to the next tab natively as a
//! layout animation of its frame alone, at once with reduced motion and as
//! the list is resized; none without `indicatorClass` / `indicatorStyle`.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

use nsh_base::{tab, tabs};
use nsh_core::{
    Color, LayoutCurve, MountItem, NodeId, Size, element::Root, platform::Os, prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

const NAMES: [&str; 5] = ["One", "Two", "Three", "Four", "Five"];

fn start<C: Component<Props = ()>>() -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::of::<C>())
    };
    config.environment.os = Os::MacOs;
    let mut app = Headless::start(config).unwrap();
    app.first_render().unwrap();
    app
}

/// A button before and after a list of five tabs, the fourth disabled; the
/// second starts selected. The texts say which is selected, how many
/// presses the tabs reported, and which button Return pressed.
#[component]
fn TabsScreen() -> impl IntoElement {
    let selected = signal(1usize);
    let presses = signal(0u32);
    let pressed = signal("none");
    let section = move |i: usize| {
        tab()
            .selected(move || selected.get() == i)
            .disabled(i == 3)
            .on_press(move |_: &()| {
                presses.update(|n| *n += 1);
                selected.set(i);
            })
            .child(text(NAMES[i]))
    };
    view()
        .child(
            view()
                .on_press(move || pressed.set("before"))
                .child(text("Before")),
        )
        .child(
            // An indicator, the list's first child: the keys below move
            // between the tabs alone.
            tabs()
                .flex_row()
                .indicator_style(|s| s.bottom(px(0.0)).h(px(2.0)))
                .child(section(0))
                .child(section(1))
                .child(section(2))
                .child(section(3))
                .child(section(4)),
        )
        .child(
            view()
                .on_press(move || pressed.set("after"))
                .child(text("After")),
        )
        .child(text(move || format!("selected:{}", NAMES[selected.get()])))
        .child(text(move || format!("presses:{}", presses.get())))
        .child(text(move || format!("pressed:{}", pressed.get())))
}

#[test]
fn tab_enters_the_list_at_the_selected_tab_and_leaves_it_in_one_stop() {
    let mut app = start::<TabsScreen>();
    app.press_key("tab").unwrap();
    app.press_key("tab").unwrap();
    // Return presses the tab the focus is on: the selected one.
    app.press_key("enter").unwrap();
    app.wait_for("text:presses:1").unwrap();
    app.wait_for("text:selected:Two").unwrap();
    // One more Tab leaves the list.
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:pressed:after").unwrap();
    // Shift+Tab comes back to the selected tab, not the last one.
    app.press_key("shift+tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:presses:2").unwrap();
    app.wait_for("text:selected:Two").unwrap();
}

#[test]
fn arrows_move_and_select_wrapping_and_skipping_disabled_tabs() {
    let mut app = start::<TabsScreen>();
    app.press_key("tab").unwrap();
    app.press_key("tab").unwrap();
    app.press_key("right").unwrap();
    app.wait_for("text:selected:Three").unwrap();
    // Four is disabled: Right goes on to Five.
    app.press_key("right").unwrap();
    app.wait_for("text:selected:Five").unwrap();
    // Past the end, around to the first.
    app.press_key("right").unwrap();
    app.wait_for("text:selected:One").unwrap();
    app.press_key("left").unwrap();
    app.wait_for("text:selected:Five").unwrap();
    app.press_key("left").unwrap();
    app.wait_for("text:selected:Three").unwrap();
    // Up and Down move as Left and Right do.
    app.press_key("down").unwrap();
    app.wait_for("text:selected:Five").unwrap();
    app.press_key("up").unwrap();
    app.wait_for("text:selected:Three").unwrap();
    app.wait_for("text:presses:7").unwrap();
    // The focus moved with the selection: Return presses Three.
    app.press_key("enter").unwrap();
    app.wait_for("text:presses:8").unwrap();
    app.wait_for("text:selected:Three").unwrap();
}

#[test]
fn home_and_end_go_to_the_first_and_last_enabled_tab() {
    let mut app = start::<TabsScreen>();
    app.press_key("tab").unwrap();
    app.press_key("tab").unwrap();
    app.press_key("end").unwrap();
    app.wait_for("text:selected:Five").unwrap();
    app.press_key("home").unwrap();
    app.wait_for("text:selected:One").unwrap();
    // Home on the first tab moves nothing and reports nothing.
    app.press_key("home").unwrap();
    app.wait_for("text:presses:2").unwrap();
}

#[test]
fn the_arrows_do_nothing_while_the_focus_is_outside_the_list() {
    let mut app = start::<TabsScreen>();
    app.press_key("tab").unwrap();
    app.press_key("right").unwrap();
    app.press_key("end").unwrap();
    app.wait(std::time::Duration::from_millis(50)).unwrap();
    app.wait_for("text:selected:Two").unwrap();
    app.wait_for("text:presses:0").unwrap();
    // Leaving the list unbinds its keys again.
    app.press_key("tab").unwrap();
    app.press_key("tab").unwrap();
    app.press_key("left").unwrap();
    app.wait(std::time::Duration::from_millis(50)).unwrap();
    app.wait_for("text:selected:Two").unwrap();
    app.wait_for("text:presses:0").unwrap();
}

/// Tabs without a list are stops of their own, as before.
#[component]
fn LooseTabs() -> impl IntoElement {
    let pressed = signal("none");
    view()
        .child(
            tab()
                .on_press(move |_: &()| pressed.set("first"))
                .child(text("First")),
        )
        .child(
            tab()
                .on_press(move |_: &()| pressed.set("second"))
                .child(text("Second")),
        )
        .child(text(move || format!("pressed:{}", pressed.get())))
}

#[test]
fn a_tab_outside_a_list_is_a_stop_of_its_own() {
    let mut app = start::<LooseTabs>();
    app.press_key("tab").unwrap();
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:pressed:second").unwrap();
}

#[derive(Clone, PartialEq, Props)]
struct ManyProps {
    count: usize,
}

/// A list of `count` tabs, the first selected; no indicator.
#[component]
fn ManyTabs(props: ManyProps) -> impl IntoElement {
    let selected = signal(0usize);
    view()
        .child(tabs().flex_row().children((0..props.count).map(move |i| {
            tab()
                .selected(move || selected.get() == i)
                .on_press(move |_: &()| selected.set(i))
                .child(text(format!("{i}")))
        })))
        .child(text(move || format!("selected:{}", selected.get())))
}

/// The mount items one Right sends in a list of `count` tabs, and how
/// many of them made or removed a view.
fn items_per_key(count: usize) -> (usize, usize) {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::new::<ManyTabs>(move || ManyProps { count }))
    };
    config.environment.os = Os::MacOs;
    let mut app = Headless::start(config).unwrap();
    app.first_render().unwrap();
    let items = Arc::new(AtomicUsize::new(0));
    let made = Arc::new(AtomicUsize::new(0));
    let (seen, created) = (items.clone(), made.clone());
    app.observe(move |_, batch| {
        seen.fetch_add(batch.items.len(), Ordering::Relaxed);
        created.fetch_add(
            batch
                .items
                .iter()
                .filter(|i| matches!(i, MountItem::Create { .. } | MountItem::Delete { .. }))
                .count(),
            Ordering::Relaxed,
        );
    });
    app.press_key("tab").unwrap();
    app.press_key("right").unwrap();
    app.wait_for("text:selected:1").unwrap();
    app.idle(std::time::Duration::from_millis(50)).unwrap();
    items.store(0, Ordering::Relaxed);
    made.store(0, Ordering::Relaxed);
    app.press_key("right").unwrap();
    app.wait_for("text:selected:2").unwrap();
    app.idle(std::time::Duration::from_millis(50)).unwrap();
    (items.load(Ordering::Relaxed), made.load(Ordering::Relaxed))
}

#[test]
fn an_arrow_changes_the_tab_left_and_the_tab_reached_only() {
    let (few, made) = items_per_key(3);
    let (many, _) = items_per_key(40);
    println!("one Right: {few} mount items among 3 tabs, {many} among 40");
    assert_eq!(made, 0, "an arrow makes no view");
    assert_eq!(
        few, many,
        "the cost of an arrow does not grow with the tabs"
    );
}

/// How the indicator harness lays its list out: no indicator.
const BARE: u32 = 0;
/// A row of tabs 60, 80 and 100 wide, after a 10-point padding and 4
/// apart, with an underline 2 high at the bottom.
const UNDERLINE: u32 = 1;
/// The same row, its tabs sharing the viewport's width.
const SHARED: u32 = 2;
/// A column of tabs 30, 40 and 50 high, with a bar 3 wide at the left
/// inside margins of 2 along the column.
const COLUMN: u32 = 3;
/// The underlined row, a tab 30 wider while selected.
const GROW: u32 = 4;

#[derive(Clone, PartialEq, Props)]
struct IndicatorProps {
    shape: u32,
    /// The tabs selected at first, a bit each (the app's own `selected`
    /// per tab: none, or several).
    selected: u32,
}

/// Three tabs, those of `selected` selected, and the indicator of
/// `shape`. A press selects the tab pressed alone.
#[component]
fn IndicatorTabs(props: IndicatorProps) -> impl IntoElement {
    let shape = props.shape;
    let selected = signal(props.selected);
    let section = move |i: usize| {
        let bit = 1u32 << i;
        let t = tab()
            .selected(move || selected.get() & bit != 0)
            .on_press(move |_: &()| selected.set(bit))
            .child(text(NAMES[i]));
        match shape {
            COLUMN => t.h(px(30.0 + 10.0 * i as f32)),
            SHARED => t.flex_1().h(px(30.0)),
            GROW => t.h(px(30.0)).style_with(move |s| {
                let grown = if selected.get() & bit != 0 { 30.0 } else { 0.0 };
                s.w(px(60.0 + 20.0 * i as f32 + grown))
            }),
            _ => t.w(px(60.0 + 20.0 * i as f32)).h(px(30.0)),
        }
    };
    let list = tabs();
    let list = match shape {
        BARE => list,
        COLUMN => list.indicator_style(|s| {
            s.left(px(0.0))
                .w(px(3.0))
                .my(px(2.0))
                .bg(AdaptiveColor::from(rgb(0xff0000)))
        }),
        _ => list.indicator_style(|s| {
            s.bottom(px(0.0))
                .h(px(2.0))
                .bg(AdaptiveColor::from(rgb(0xff0000)))
        }),
    };
    let list = match shape {
        COLUMN => list.flex_col().w(px(120.0)),
        SHARED => list.flex_row(),
        _ => list.flex_row().pl(px(10.0)).gap(px(4.0)),
    };
    view()
        .pt(px(20.0))
        .child(list.child(section(0)).child(section(1)).child(section(2)))
}

/// The batches of each step, by step.
type Seen = Arc<Mutex<Vec<Vec<MountItem>>>>;

struct Indicated {
    app: Headless,
    seen: Seen,
}

impl Indicated {
    /// `shape` with the second tab selected.
    fn start(shape: u32, reduce_motion: bool) -> Self {
        Self::start_with(shape, 0b010, reduce_motion)
    }

    fn start_with(shape: u32, selected: u32, reduce_motion: bool) -> Self {
        let mut config = EngineConfig {
            viewport: Size::new(px(390.0), px(844.0)),
            ..EngineConfig::new(Root::new::<IndicatorTabs>(move || IndicatorProps {
                shape,
                selected,
            }))
        };
        config.environment.reduce_motion = reduce_motion;
        let mut app = Headless::start(config).unwrap();
        let seen: Seen = Arc::default();
        let into = seen.clone();
        app.observe(move |_, batch| into.lock().unwrap().push(batch.items.clone()));
        app.first_render().unwrap();
        app.wait_for("Three").unwrap();
        Self { app, seen }
    }

    /// The batches since the last call, taken.
    fn take(&self) -> Vec<Vec<MountItem>> {
        std::mem::take(&mut *self.seen.lock().unwrap())
    }
}

/// The indicator: the view with the app's red background.
fn indicator(batches: &[Vec<MountItem>]) -> Option<NodeId> {
    batches.iter().flatten().find_map(|i| match i {
        MountItem::ViewStyle { id, style } if style.background_color == Color(0xff00_00ff) => {
            Some(*id)
        }
        _ => None,
    })
}

/// The last frame `batches` give `id`: x, y, width, height.
fn frame_of(batches: &[Vec<MountItem>], id: NodeId) -> Option<[f32; 4]> {
    batches.iter().flatten().rev().find_map(|i| match i {
        MountItem::Frame { id: at, frame } if *at == id => Some([
            frame.origin.x.0,
            frame.origin.y.0,
            frame.size.width.0,
            frame.size.height.0,
        ]),
        _ => None,
    })
}

/// The layout animation the last frame `batches` give `id` runs with: the
/// last one before it in its batch (`None`: none, or no frame).
fn motion_of(batches: &[Vec<MountItem>], id: NodeId) -> Option<LayoutCurve> {
    let mut found = None;
    for items in batches {
        let mut current = None;
        for item in items {
            match item {
                MountItem::LayoutAnimation(a) => current = a.update.map(|u| u.curve),
                MountItem::Frame { id: at, .. } if *at == id => found = Some(current),
                _ => {}
            }
        }
    }
    found.flatten()
}

/// Every frame of `batches`, with the curve of the layout animation it runs
/// with (`None`: at once).
fn motions(batches: &[Vec<MountItem>]) -> Vec<(NodeId, Option<LayoutCurve>)> {
    let mut out = Vec::new();
    for items in batches {
        let mut current = None;
        for item in items {
            match item {
                MountItem::LayoutAnimation(a) => current = a.update.map(|u| u.curve),
                MountItem::Frame { id, .. } => out.push((*id, current)),
                _ => {}
            }
        }
    }
    out
}

/// The layout animation items of `batches`.
fn layout_animations(batches: &[Vec<MountItem>]) -> usize {
    (batches.iter().flatten())
        .filter(|i| matches!(i, MountItem::LayoutAnimation(_)))
        .count()
}

fn frames(batches: &[Vec<MountItem>]) -> Vec<NodeId> {
    (batches.iter().flatten())
        .filter_map(|i| match i {
            MountItem::Frame { id, .. } => Some(*id),
            _ => None,
        })
        .collect()
}

#[test]
fn the_indicator_spans_the_selected_tab_along_the_list() {
    let app = Indicated::start(UNDERLINE, false);
    let first = app.take();
    let id = indicator(&first).expect("an indicator");
    // Two: after the padding (10), One (60) and the gap (4); at the bottom
    // of the 30-point list, 2 high.
    assert_eq!(frame_of(&first, id), Some([74.0, 28.0, 80.0, 2.0]));
    // Placed at once, with no layout event for JS.
    assert_eq!(motion_of(&first, id), None);
    let laid = first
        .iter()
        .flatten()
        .filter(|i| matches!(i, MountItem::Frame { id: at, .. } if *at == id));
    assert_eq!(laid.count(), 1, "one frame for the indicator");
}

#[test]
fn a_selection_moves_only_the_indicator_with_a_spring() {
    let mut app = Indicated::start(UNDERLINE, false);
    let id = indicator(&app.take()).expect("an indicator");
    app.app.press("text:Three").unwrap();
    let pressed = app.take();
    // Three: 158 = 10 + 60 + 4 + 80 + 4, 100 wide.
    assert_eq!(frame_of(&pressed, id), Some([158.0, 28.0, 100.0, 2.0]));
    assert_eq!(
        motion_of(&pressed, id),
        Some(LayoutCurve::Spring { damping: 0.85 })
    );
    // Its frame alone moves, after its one layout animation; the rest is
    // the two tabs' states (selected, the focus stop).
    assert_eq!(frames(&pressed), [id]);
    let animations = pressed
        .iter()
        .flatten()
        .filter(|i| matches!(i, MountItem::LayoutAnimation(_)))
        .count();
    assert_eq!(animations, 1);
    let items: usize = pressed.iter().map(Vec::len).sum();
    assert!(items <= 8, "{items} items: {pressed:#?}");
    // And back, the same way.
    app.app.press("text:One").unwrap();
    let back = app.take();
    assert_eq!(frame_of(&back, id), Some([10.0, 28.0, 60.0, 2.0]));
    assert_eq!(
        motion_of(&back, id),
        Some(LayoutCurve::Spring { damping: 0.85 })
    );
}

#[test]
fn a_resize_moves_the_indicator_at_once_with_the_tabs() {
    let mut app = Indicated::start(SHARED, false);
    let first = app.take();
    let id = indicator(&first).expect("an indicator");
    // Two of three tabs sharing 390.
    assert_eq!(frame_of(&first, id), Some([130.0, 28.0, 130.0, 2.0]));
    app.app
        .set_viewport(Size::new(px(300.0), px(844.0)))
        .unwrap();
    let resized = app.take();
    // In the batch that moves the tabs, with no animation.
    let batch = resized
        .iter()
        .find(|b| {
            b.iter()
                .any(|i| matches!(i, MountItem::Frame { id: at, .. } if *at == id))
        })
        .expect("the indicator moves");
    assert!(
        frames(std::slice::from_ref(batch)).len() > 1,
        "the tabs move in the same batch"
    );
    assert_eq!(frame_of(&resized, id), Some([100.0, 28.0, 100.0, 2.0]));
    assert_eq!(motion_of(&resized, id), None);
    // No layout animation item at all: not even an empty one.
    assert_eq!(layout_animations(&resized), 0, "{resized:#?}");
}

#[test]
fn the_indicator_follows_a_column_inside_its_margins() {
    let mut app = Indicated::start(COLUMN, false);
    let first = app.take();
    let id = indicator(&first).expect("an indicator");
    // Two: under One (30), inside margins of 2 along the column; at the
    // left, 3 wide.
    assert_eq!(frame_of(&first, id), Some([0.0, 32.0, 3.0, 36.0]));
    app.app.press("text:Three").unwrap();
    let pressed = app.take();
    assert_eq!(frame_of(&pressed, id), Some([0.0, 72.0, 3.0, 46.0]));
}

#[test]
fn with_reduced_motion_the_indicator_jumps() {
    let mut app = Indicated::start(UNDERLINE, true);
    let id = indicator(&app.take()).expect("an indicator");
    app.app.press("text:Three").unwrap();
    let pressed = app.take();
    assert_eq!(frame_of(&pressed, id), Some([158.0, 28.0, 100.0, 2.0]));
    assert_eq!(motion_of(&pressed, id), None);
    assert!(
        !pressed
            .iter()
            .flatten()
            .any(|i| matches!(i, MountItem::LayoutAnimation(_)))
    );
}

#[test]
fn a_list_without_an_indicator_makes_none() {
    let created = |shape| {
        let app = Indicated::start(shape, false);
        let first = app.take();
        assert_eq!(indicator(&first).is_some(), shape != BARE);
        (first.iter().flatten())
            .filter(|i| matches!(i, MountItem::Create { .. }))
            .count()
    };
    assert_eq!(created(UNDERLINE), created(BARE) + 1);
    // A selection there moves no frame.
    let mut app = Indicated::start(BARE, false);
    app.take();
    app.app.press("text:Three").unwrap();
    assert!(frames(&app.take()).is_empty());
}

#[test]
fn with_no_tab_selected_the_indicator_is_hidden_and_shows_at_once() {
    let mut app = Indicated::start_with(UNDERLINE, 0, false);
    let first = app.take();
    let id = indicator(&first).expect("an indicator, hidden");
    // Hidden: no frame of its own (`display: none`).
    assert_eq!(frame_of(&first, id), Some([0.0, 0.0, 0.0, 0.0]));
    // A selection shows it on the tab at once: there is nowhere to move
    // from.
    app.app.press("text:Two").unwrap();
    let pressed = app.take();
    assert_eq!(frame_of(&pressed, id), Some([74.0, 28.0, 80.0, 2.0]));
    assert_eq!(motion_of(&pressed, id), None);
    assert_eq!(layout_animations(&pressed), 0, "{pressed:#?}");
    // From there, a selection springs it.
    app.app.press("text:Three").unwrap();
    let moved = app.take();
    assert_eq!(frame_of(&moved, id), Some([158.0, 28.0, 100.0, 2.0]));
    assert_eq!(
        motion_of(&moved, id),
        Some(LayoutCurve::Spring { damping: 0.85 })
    );
}

#[test]
fn with_several_tabs_selected_the_indicator_is_on_the_first() {
    let mut app = Indicated::start_with(UNDERLINE, 0b110, false);
    let first = app.take();
    let id = indicator(&first).expect("an indicator");
    // Two and Three: on Two.
    assert_eq!(frame_of(&first, id), Some([74.0, 28.0, 80.0, 2.0]));
    app.app.press("text:One").unwrap();
    let pressed = app.take();
    assert_eq!(frame_of(&pressed, id), Some([10.0, 28.0, 60.0, 2.0]));
    assert_eq!(
        motion_of(&pressed, id),
        Some(LayoutCurve::Spring { damping: 0.85 })
    );
}

#[test]
fn a_tab_that_grows_as_it_is_selected_takes_the_indicator_animated_once() {
    let mut app = Indicated::start(GROW, false);
    let first = app.take();
    let id = indicator(&first).expect("an indicator");
    // Two, 80 and 30 more while selected.
    assert_eq!(frame_of(&first, id), Some([74.0, 28.0, 110.0, 2.0]));
    app.app.press("text:Three").unwrap();
    let pressed = app.take();
    // Two shrinks back to 80 and Three, after it, grows to 130 in the
    // commit that selects it: the indicator lands on Three's new frame.
    assert_eq!(frame_of(&pressed, id), Some([158.0, 28.0, 130.0, 2.0]));
    let moved = motions(&pressed);
    let animated: Vec<_> = moved.iter().filter(|m| m.1.is_some()).collect();
    assert_eq!(
        animated,
        [&(id, Some(LayoutCurve::Spring { damping: 0.85 }))],
        "the indicator's frame alone springs, once; the tabs resize at once: {moved:?}"
    );
    let springs = (pressed.iter().flatten())
        .filter(|i| matches!(i, MountItem::LayoutAnimation(a) if a.update.is_some()))
        .count();
    assert_eq!(springs, 1, "{pressed:#?}");
}

#[test]
fn the_indicator_is_hidden_from_screen_readers_and_takes_no_presses() {
    let app = Indicated::start(UNDERLINE, false);
    let first = app.take();
    let id = indicator(&first).expect("an indicator");
    let props = first
        .iter()
        .flatten()
        .rev()
        .find_map(|i| match i {
            MountItem::ViewProps { id: at, props } if *at == id => Some(props.clone()),
            _ => None,
        })
        .expect("the indicator's props");
    assert!(props.accessibility.hidden, "{props:?}");
    assert_eq!(props.pointer_events, PointerEvents::None);
}
