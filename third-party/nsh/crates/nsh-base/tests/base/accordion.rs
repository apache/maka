//! `Accordion`: the app's `value` opens the items whose values it holds; a
//! trigger's press reports the next one (one open at a time, or several
//! with `multiple`); disabled items and accordions take no presses; the
//! triggers are stops of the keyboard focus in order; screen readers hear
//! a group, headings of their level, buttons that say whether their item
//! is expanded and regions hidden while closed; `keepMounted` keeps the
//! content in the tree while closed; `reveal` springs the panel open and
//! shut and keeps its content until it has closed. On macOS, where Tab
//! stops at views that take presses, and on a manual clock.

use std::sync::{Arc, Mutex};

use nsh_base::{accordion, accordion_header, accordion_item, accordion_panel, accordion_trigger};
use nsh_core::{
    AccessibilityRole, LayoutCurve, MountItem, NodeId, Size, element::Spring, platform::Os,
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    multiple: bool,
    disabled: bool,
    reveal: bool,
    keep_mounted: bool,
    /// The panels' reveal spring: the default's without one.
    spring: Option<Spring>,
    /// The values open at first.
    open: Vec<String>,
}

const ITEMS: [(&str, &str, bool); 3] = [
    ("shipping", "Shipping", false),
    ("returns", "Returns", false),
    ("billing", "Billing", true),
];

/// A button, an accordion of three items (the third disabled), each a
/// level-2 heading over a 30-point panel, and a button after it; the app's
/// value as `open:…` and the number of changes as `changes:…`.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let value = signal(
        props
            .open
            .iter()
            .map(|v| SharedString::from(v.clone()))
            .collect::<Vec<_>>(),
    );
    let changes = signal(0u32);
    let pressed = signal("none");
    let (reveal, keep_mounted, spring) = (props.reveal, props.keep_mounted, props.spring);
    let item = move |(id, title, disabled): (&'static str, &'static str, bool)| {
        accordion_item()
            .value(id)
            .disabled(disabled)
            .child(
                accordion_header()
                    .level(2)
                    .child(accordion_trigger().h(px(20.0)).child(text(title))),
            )
            .child(
                accordion_panel()
                    .reveal(reveal)
                    .reveal_spring(spring)
                    .keep_mounted(keep_mounted)
                    .accessibility_label(title)
                    .child(view().h(px(30.0)).child(text(format!("{title} details")))),
            )
    };
    view()
        .child(
            view()
                .on_press(move || pressed.set("before"))
                .child(text("Before")),
        )
        .child(
            accordion()
                .value(value)
                .multiple(props.multiple)
                .disabled(props.disabled)
                .on_change(move |next: &Vec<SharedString>| {
                    changes.update(|n| *n += 1);
                    value.set(next.clone());
                })
                .child(item(ITEMS[0]))
                .child(item(ITEMS[1]))
                .child(item(ITEMS[2])),
        )
        .child(
            view()
                .test_id("after")
                .h(px(20.0))
                .on_press(move || pressed.set("after"))
                .child(text("After")),
        )
        .child(text(move || format!("open:{}", value.get().join(","))))
        .child(text(move || format!("changes:{}", changes.get())))
        .child(text(move || format!("pressed:{}", pressed.get())))
}

/// The items of each step's batches.
type Seen = Arc<Mutex<Vec<MountItem>>>;

struct App {
    app: Headless,
    seen: Seen,
}

impl std::ops::Deref for App {
    type Target = Headless;
    fn deref(&self) -> &Headless {
        &self.app
    }
}

impl std::ops::DerefMut for App {
    fn deref_mut(&mut self) -> &mut Headless {
        &mut self.app
    }
}

impl App {
    /// The items that came since the last call.
    fn take(&self) -> Vec<MountItem> {
        std::mem::take(&mut *self.seen.lock().unwrap())
    }

    /// Presses the trigger titled `title` and returns the items that came.
    fn toggle(&mut self, title: &str) -> Vec<MountItem> {
        self.take();
        self.app.press(&format!("role:button[{title}]")).unwrap();
        self.take()
    }
}

fn start(props: HarnessProps, reduce_motion: bool) -> App {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        clock: nsh_engine::Clock::manual(std::time::SystemTime::now()),
        ..EngineConfig::new(nsh_testing::windowed_root_with::<Harness>(move || {
            props.clone()
        }))
    };
    config.environment.os = Os::MacOs;
    config.environment.reduce_motion = reduce_motion;
    let mut app = Headless::start(config).expect("the engine starts");
    let seen: Seen = Arc::default();
    let into = seen.clone();
    app.observe(move |_, batch| into.lock().unwrap().extend(batch.items.iter().cloned()));
    app.first_render().unwrap();
    app.wait_for("Shipping").unwrap();
    App { app, seen }
}

/// Whether `items` animate the commit's frames with the reveal's default
/// spring.
fn reveals(items: &[MountItem]) -> bool {
    reveals_on(items, Spring::new(180.0))
}

/// Whether `items` animate the commit's frames with `spring`.
fn reveals_on(items: &[MountItem], spring: Spring) -> bool {
    items.iter().any(|i| {
        matches!(i, MountItem::LayoutAnimation(a)
            if a.update.is_some_and(|u| u.curve == LayoutCurve::Spring(spring)))
    })
}

fn any_layout_animation(items: &[MountItem]) -> bool {
    items
        .iter()
        .any(|i| matches!(i, MountItem::LayoutAnimation(_)))
}

/// Whether `items` create views.
fn creates(items: &[MountItem]) -> bool {
    items.iter().any(|i| matches!(i, MountItem::Create { .. }))
}

#[test]
fn one_item_opens_at_a_time_and_an_open_one_closes() {
    let mut app = start(HarnessProps::default(), false);
    assert!(!app.shows("Shipping details"), "closed at first");
    app.toggle("Shipping");
    app.wait_for("text:open:shipping").unwrap();
    assert!(app.shows("Shipping details"));
    // Another item replaces it.
    app.toggle("Returns");
    app.wait_for("text:open:returns").unwrap();
    assert!(app.shows("Returns details"));
    assert!(!app.shows("Shipping details"));
    // The open item's trigger closes it.
    app.toggle("Returns");
    app.wait_for("text:open:").unwrap();
    assert!(!app.shows("Returns details"));
    app.wait_for("text:changes:3").unwrap();
}

#[test]
fn with_multiple_items_open_together() {
    let mut app = start(
        HarnessProps {
            multiple: true,
            ..HarnessProps::default()
        },
        false,
    );
    app.toggle("Returns");
    app.toggle("Shipping");
    // Joined at the end, in the order they opened.
    app.wait_for("text:open:returns,shipping").unwrap();
    assert!(app.shows("Shipping details"));
    assert!(app.shows("Returns details"));
    app.toggle("Returns");
    app.wait_for("text:open:shipping").unwrap();
    assert!(!app.shows("Returns details"));
}

#[test]
fn the_items_follow_the_apps_value() {
    // Open at first, a disabled item among them: the value is the app's.
    let app = start(
        HarnessProps {
            open: vec!["returns".into(), "billing".into()],
            ..HarnessProps::default()
        },
        false,
    );
    assert!(app.shows("Returns details"));
    assert!(app.shows("Billing details"));
    assert!(!app.shows("Shipping details"));
}

#[test]
fn disabled_items_and_accordions_take_no_presses() {
    let mut app = start(HarnessProps::default(), false);
    assert!(!app.screen().enabled("role:button[Billing]").unwrap());
    assert!(app.screen().enabled("role:button[Shipping]").unwrap());
    assert!(
        app.screen()
            .accessibility_state("role:button[Billing]")
            .unwrap()
            .disabled
    );
    assert_eq!(
        app.screen().press_target("role:button[Billing]").unwrap(),
        None
    );
    app.wait(std::time::Duration::from_millis(20)).unwrap();
    app.wait_for("text:changes:0").unwrap();

    let app = start(
        HarnessProps {
            disabled: true,
            ..HarnessProps::default()
        },
        false,
    );
    for (_, title, _) in ITEMS {
        let trigger = format!("role:button[{title}]");
        assert!(!app.screen().enabled(&trigger).unwrap(), "{title}");
    }
}

#[test]
fn screen_readers_hear_a_group_of_headings_buttons_and_regions() {
    let mut app = start(HarnessProps::default(), false);
    let screen = app.screen();
    assert_eq!(screen.count("role:group").unwrap(), 1);
    assert_eq!(screen.count("role:header").unwrap(), 3);
    assert_eq!(
        screen.accessibility_level("role:header >> nth=0").unwrap(),
        Some(2)
    );
    // Each trigger is a button inside its heading, collapsed.
    assert!(
        screen
            .matches("role:header >> role:button[Shipping]")
            .unwrap()
    );
    let state = screen.accessibility_state("role:button[Shipping]").unwrap();
    assert_eq!(state.expanded, Some(false));
    // Closed panels are out of the layout.
    assert_eq!(screen.count("role:region").unwrap(), 0);

    app.toggle("Shipping");
    app.wait_for("text:open:shipping").unwrap();
    let screen = app.screen();
    let state = screen.accessibility_state("role:button[Shipping]").unwrap();
    assert_eq!(state.expanded, Some(true));
    assert_eq!(
        screen
            .accessibility_state("role:button[Returns]")
            .unwrap()
            .expanded,
        Some(false)
    );
    // The open panel: a region named after its item.
    assert!(screen.matches("role:region[Shipping]").unwrap());
}

#[test]
fn tab_reaches_each_trigger_in_order_and_return_toggles_it() {
    let mut app = start(HarnessProps::default(), false);
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:pressed:before").unwrap();
    // The first trigger.
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:open:shipping").unwrap();
    // The second; the open panel holds no stop.
    app.press_key("tab").unwrap();
    app.press_key("space").unwrap();
    app.wait_for("text:open:returns").unwrap();
    // The disabled third is no stop: Tab goes on past the accordion.
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:pressed:after").unwrap();
    // No arrow keys between the triggers.
    app.press_key("shift+tab").unwrap();
    app.press_key("up").unwrap();
    app.wait(std::time::Duration::from_millis(20)).unwrap();
    app.wait_for("text:open:returns").unwrap();
    app.wait_for("text:changes:2").unwrap();
}

#[test]
fn kept_mounted_content_stays_in_the_tree_while_closed() {
    let mut app = start(
        HarnessProps {
            keep_mounted: true,
            ..HarnessProps::default()
        },
        false,
    );
    assert!(
        !app.shows("Shipping details"),
        "hidden with its closed panel"
    );
    // Made in the first render: opening makes nothing.
    let opened = app.toggle("Shipping");
    app.wait_for("text:open:shipping").unwrap();
    assert!(app.shows("Shipping details"));
    assert!(!creates(&opened), "{opened:#?}");
    // Closing removes nothing.
    let closed = app.toggle("Shipping");
    app.wait_for("text:open:").unwrap();
    assert!(!app.shows("Shipping details"));
    assert!(
        !closed
            .iter()
            .any(|i| matches!(i, MountItem::Remove { .. } | MountItem::Delete { .. })),
        "{closed:#?}"
    );
}

#[test]
fn without_keep_mounted_closed_content_is_made_when_it_opens() {
    let mut app = start(HarnessProps::default(), false);
    let opened = app.toggle("Shipping");
    assert!(creates(&opened), "the content comes in");
    assert!(!any_layout_animation(&opened), "no reveal");
    let closed = app.toggle("Shipping");
    assert!(
        closed
            .iter()
            .any(|i| matches!(i, MountItem::Remove { .. } | MountItem::Delete { .. })),
        "and goes: {closed:#?}"
    );
}

#[test]
fn a_reveal_springs_the_panel_and_keeps_the_content_until_it_has_closed() {
    let mut app = start(
        HarnessProps {
            reveal: true,
            ..HarnessProps::default()
        },
        false,
    );
    // Closed panels are in the layout, zero high: the triggers are 20
    // apart and the view after them is under the third.
    let opened = app.toggle("Shipping");
    assert!(reveals(&opened), "the opening commit animates its frames");
    assert!(app.shows("Shipping details"));
    // One open at a time: opening another closes the first in the same
    // reveal.
    let swapped = app.toggle("Returns");
    assert!(reveals(&swapped));
    assert!(app.shows("Returns details"));
    assert!(!app.shows("Shipping details"), "clipped as it closes");
    assert!(
        !swapped
            .iter()
            .any(|i| matches!(i, MountItem::Remove { .. } | MountItem::Delete { .. })),
        "kept while its panel closes"
    );
    app.run_for(std::time::Duration::from_millis(300)).unwrap();
    let removed = app.take();
    assert!(
        removed
            .iter()
            .any(|i| matches!(i, MountItem::Remove { .. } | MountItem::Delete { .. })),
        "out once closed: {removed:#?}"
    );
    assert!(!any_layout_animation(&removed));
}

#[test]
fn a_reveal_moves_on_the_apps_spring() {
    // Settles in about 384 ms, where the default settles in about 265.
    let spring = Spring {
        stiffness: 620.0,
        damping: 36.0,
        ..Spring::default()
    };
    let mut app = start(
        HarnessProps {
            reveal: true,
            spring: Some(spring),
            ..HarnessProps::default()
        },
        false,
    );
    let opened = app.toggle("Shipping");
    assert!(reveals_on(&opened, spring), "opens on it: {opened:#?}");
    assert!(!reveals(&opened), "not on the default");
    let closed = app.toggle("Shipping");
    assert!(reveals_on(&closed, spring), "closes on it");
    app.run_for(std::time::Duration::from_millis(300)).unwrap();
    let removes = |items: &[MountItem]| {
        items
            .iter()
            .any(|i| matches!(i, MountItem::Remove { .. } | MountItem::Delete { .. }))
    };
    let closing = app.take();
    assert!(!removes(&closing), "kept while its spring has not settled");
    app.run_for(std::time::Duration::from_millis(100)).unwrap();
    let removed = app.take();
    assert!(removes(&removed), "out once it has: {removed:#?}");
}

#[test]
fn with_reduced_motion_a_reveal_opens_and_closes_at_once() {
    let mut app = start(
        HarnessProps {
            reveal: true,
            ..HarnessProps::default()
        },
        true,
    );
    let opened = app.toggle("Shipping");
    assert!(app.shows("Shipping details"));
    assert!(!any_layout_animation(&opened));
    let closed = app.toggle("Shipping");
    assert!(!app.shows("Shipping details"));
    assert!(!any_layout_animation(&closed));
}

#[test]
fn a_kept_panel_closed_by_a_reveal_is_out_of_sight() {
    let mut app = start(
        HarnessProps {
            reveal: true,
            keep_mounted: true,
            ..HarnessProps::default()
        },
        false,
    );
    let first = app.take();
    // The panels: regions, hidden from screen readers while closed.
    let panels: Vec<NodeId> = first
        .iter()
        .filter_map(|i| match i {
            MountItem::ViewProps { id, props }
                if props.accessibility.role == AccessibilityRole::Region =>
            {
                Some(*id)
            }
            _ => None,
        })
        .collect();
    assert_eq!(panels.len(), 3);
    let shipping = panels[0];
    let invisible = |items: &[MountItem]| {
        items.iter().rev().find_map(|i| match i {
            MountItem::ViewStyle { id, style } if *id == shipping => Some(style.hidden),
            _ => None,
        })
    };
    // In the tree, zero high and `invisible()`: its content takes no
    // keyboard focus, and no text of it shows.
    assert_eq!(invisible(&first), Some(true));
    assert!(!app.shows("Shipping details"));
    assert_eq!(app.screen().count("role:region").unwrap(), 0);
    // Open: shown; closing, shown while the reveal runs; closed, out of
    // sight again, the content kept.
    let opened = app.toggle("Shipping");
    assert_eq!(invisible(&opened), Some(false));
    assert!(app.shows("Shipping details"));
    let closing = app.toggle("Shipping");
    assert_ne!(invisible(&closing), Some(true), "in sight while it closes");
    app.run_for(std::time::Duration::from_millis(300)).unwrap();
    let closed = app.take();
    assert_eq!(invisible(&closed), Some(true));
    assert!(
        !closed
            .iter()
            .any(|i| matches!(i, MountItem::Remove { .. } | MountItem::Delete { .. })),
        "kept: {closed:#?}"
    );
}

#[test]
fn closing_reveal_panel_disables_pointer_events_at_once() {
    #[derive(Clone, PartialEq, Props)]
    struct PanelProps {
        block_parent: bool,
    }

    #[component]
    fn PanelHarness(props: PanelProps) -> impl IntoElement {
        let value = signal(vec![SharedString::from("shipping")]);
        let item = accordion()
            .value(value)
            .on_change(move |next: &Vec<SharedString>| value.set(next.clone()))
            .child(
                accordion_item()
                    .value("shipping")
                    .child(
                        accordion_header()
                            .level(2)
                            .child(accordion_trigger().h(px(20.0)).child(text("Shipping"))),
                    )
                    .child(
                        accordion_panel()
                            .reveal(true)
                            .accessibility_label("Shipping")
                            .child(
                                view()
                                    .test_id("shipping-action")
                                    .h(px(30.0))
                                    .on_press(|| {})
                                    .child(text("Action")),
                            ),
                    ),
            );
        if props.block_parent {
            view()
                .relative()
                .h(px(60.0))
                .child(view().test_id("behind").absolute().inset_0())
                .child(
                    view()
                        .test_id("blocked-outer")
                        .pointer_events(PointerEvents::None)
                        .child(item),
                )
                .into_element()
        } else {
            view().child(item).into_element()
        }
    }

    let config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        clock: nsh_engine::Clock::manual(std::time::SystemTime::now()),
        ..EngineConfig::new(nsh_testing::windowed_root_with::<PanelHarness>(|| {
            PanelProps {
                block_parent: false,
            }
        }))
    };
    let mut app = Headless::start(config).expect("engine starts");
    let seen: Seen = Arc::default();
    let into = seen.clone();
    app.observe(move |_, batch| into.lock().unwrap().extend(batch.items.iter().cloned()));
    app.first_render().unwrap();
    app.wait_for("Action").unwrap();
    let first = std::mem::take(&mut *seen.lock().unwrap());
    let panel = first
        .iter()
        .find_map(|i| match i {
            MountItem::ViewProps { id, props }
                if props.accessibility.role == AccessibilityRole::Region =>
            {
                Some(*id)
            }
            _ => None,
        })
        .expect("panel region");
    assert!(
        app.screen()
            .press_target("id:shipping-action")
            .unwrap()
            .is_some()
    );

    // Close via trigger press; before the 180ms reveal finishes, the panel
    // immediately disables pointer targeting and hides from accessibility.
    app.press("role:button[Shipping]").unwrap();
    let closing = std::mem::take(&mut *seen.lock().unwrap());
    let closed_props = closing
        .iter()
        .rev()
        .find_map(|i| match i {
            MountItem::ViewProps { id, props } if *id == panel => {
                Some((props.accessibility.hidden, props.pointer_events))
            }
            _ => None,
        })
        .expect("updated panel props");
    assert_eq!(closed_props, (true, PointerEvents::None));
    assert_eq!(
        app.screen().press_target("id:shipping-action").unwrap(),
        None
    );

    // An open panel inside a `PointerEvents::None` ancestor inherits `None`.
    let blocked_config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(nsh_testing::windowed_root_with::<PanelHarness>(|| {
            PanelProps { block_parent: true }
        }))
    };
    let mut blocked = Headless::start(blocked_config).expect("engine starts");
    blocked.first_render().unwrap();
    blocked.wait_for("Action").unwrap();
    assert!(
        blocked.press("id:shipping-action").is_err(),
        "open panel must not receive pointer hits under a PointerEvents::None ancestor"
    );
}
