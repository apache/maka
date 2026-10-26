//! `DockArea`: a layout renders as splits of tab groups and docks; a press
//! on a tab selects it, a drag of a tab moves it (into a group, beside
//! it, into a tab bar), a split's handle resizes it, and the ref's methods
//! close panels, toggle docks and zoom; a locked area moves nothing, and
//! at compact width the center shows one group with every panel's tab.
//! The app controls the layout: what it shows is what the area reported.

use nsh_base::dock::{
    DockArea, DockAreaApi, DockAreaEvent, DockAreaLayout, DockLayout, DockNode, DockPanel,
    DockPlacement, DockRegion, DockTab, PanelId, dock_area,
};
use nsh_core::{
    Size,
    element::Root,
    geometry::{Axis, point},
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// A layout as text: a split is `h(..)` / `v(..)` of its children, each
/// with its slot size when it has one (`:300`), a tab group `[a *b]`, the
/// displayed tab starred.
fn node_text(node: &DockNode) -> String {
    match node {
        DockNode::Split {
            axis,
            children,
            sizes,
            ..
        } => {
            let children: Vec<String> = children
                .iter()
                .zip(sizes.iter().chain(std::iter::repeat(&None)))
                .map(|(child, size)| match size {
                    Some(size) => format!("{}:{}", node_text(child), size.0.round()),
                    None => node_text(child),
                })
                .collect();
            let axis = if *axis == Axis::Horizontal { "h" } else { "v" };
            format!("{axis}({})", children.join(" "))
        }
        DockNode::Tabs {
            panels,
            active_index,
            ..
        } => {
            let tabs: Vec<String> = panels
                .iter()
                .enumerate()
                .map(|(ix, p)| match ix == *active_index {
                    true => format!("*{p}"),
                    false => p.to_string(),
                })
                .collect();
            format!("[{}]", tabs.join(" "))
        }
    }
}

fn layout_text(layout: &DockAreaLayout) -> String {
    let mut out = format!("Layout {}", node_text(&layout.center));
    for (name, region) in [("left", &layout.left), ("bottom", &layout.bottom)] {
        if let Some(region) = region {
            let open = if region.open.unwrap_or(true) {
                "open"
            } else {
                "closed"
            };
            let size = region.size.map_or(0.0, |s| s.0.round());
            out += &format!(" {name} {} {open} {size}", node_text(&region.layout));
        }
    }
    out
}

/// Two groups side by side (`a b`, 400 wide, and `c`).
fn two_groups() -> DockAreaLayout {
    DockAreaLayout::new(
        DockLayout::h_split()
            .child(DockLayout::tabs().panel("a").panel("b"), Some(px(400.0)))
            .child(DockLayout::tabs().panel("c"), None),
    )
}

/// The same with a left dock of `files`.
/// Files on the left and a terminal at the bottom, both open.
fn with_two_docks() -> DockAreaLayout {
    with_files().with_dock(
        DockPlacement::Bottom,
        DockRegion::new(DockLayout::tabs().panel("terminal")),
    )
}

fn with_files() -> DockAreaLayout {
    two_groups().with_dock(
        DockPlacement::Left,
        DockRegion::new(DockLayout::tabs().panel("files")),
    )
}

#[derive(Clone, PartialEq, Props)]
struct WorkspaceProps {
    layout: DockAreaLayout,
    /// The area's box's width (default: 800, narrower with the window).
    width: Option<f32>,
    /// The area's box's height (default: 600).
    height: Option<f32>,
    /// The area's `compact`.
    compact: Option<bool>,
}

/// A dock area of 800 × 600 at the top left (as narrow as the window when
/// it is narrower, or the props' frame), its tabs 80 × 24 in rows; what
/// each panel's content is laid out at;
/// the app keeps the layout it reports, shows it, the events it heard,
/// and has buttons for the ref's methods.
#[component]
fn Workspace(props: WorkspaceProps) -> impl IntoElement {
    let layout = signal(props.layout.clone());
    let removed = signal(String::from("none"));
    let active = signal(Vec::<String>::new());
    let docks = signal(Vec::<String>::new());
    let sizes = signal(std::collections::BTreeMap::<String, (f32, f32)>::new());
    let (width, height, compact) = (props.width, props.height, props.compact);
    let zoom = signal(String::from("none"));
    let locked = signal(false);
    let area = component_ref::<DockArea>();
    let api = move |f: &dyn Fn(&DockAreaApi)| {
        if let Some(api) = area.api::<DockAreaApi>() {
            f(&api);
        }
    };
    let button = move |id: &str, f: Box<dyn Fn(&DockAreaApi)>| {
        view()
            .test_id(id)
            .w(px(20.0))
            .h(px(20.0))
            .on_press(move || api(&*f))
    };
    view()
        .child(
            view()
                .w(move || match width {
                    Some(w) => px(w),
                    None => window().width.min(px(800.0)),
                })
                .h(px(height.unwrap_or(600.0)))
                .child(
                    dock_area()
                        .layout(move || layout.get())
                        .locked(move || locked.get())
                        .compact(compact)
                        .tab_bar_class("flex-row h-6")
                        .render_tab(|tab: &DockTab| {
                            view()
                                .test_id(&format!("tab-{}", tab.panel))
                                .w(px(80.0))
                                .h(px(24.0))
                                .child(text(format!("Tab {}", tab.panel)))
                        })
                        .render_panel(move |panel: &DockPanel| {
                            let id = panel.id.to_string();
                            view()
                                .flex_1()
                                .child(text(format!("Panel {id}")))
                                .on_layout(move |f: &nsh_core::Bounds<Points>| {
                                    let size = (f.size.width.0.round(), f.size.height.0.round());
                                    sizes.update(|m| {
                                        m.insert(id.clone(), size);
                                    })
                                })
                        })
                        .render_empty(|placement: &DockPlacement| {
                            text(format!("Empty {placement:?}"))
                        })
                        .on_layout_change(move |next: &DockAreaLayout| layout.set(next.clone()))
                        .on_panel_remove(move |panel: &PanelId| removed.set(panel.to_string()))
                        .on_dock_open_change(move |event: &DockAreaEvent| {
                            if let DockAreaEvent::DockOpenChange(placement, open) = event {
                                let sign = if *open { "+" } else { "-" };
                                docks.update(|log| log.push(format!("{placement:?}{sign}")));
                            }
                        })
                        .on_panel_active_change(move |event: &DockAreaEvent| {
                            if let DockAreaEvent::PanelActiveChange(panel, on) = event {
                                let sign = if *on { "+" } else { "-" };
                                active.update(|log| log.push(format!("{panel}{sign}")));
                            }
                        })
                        .on_zoom_change(move |panel: &Option<PanelId>| {
                            zoom.set(panel.as_ref().map_or("out".into(), |p| p.to_string()))
                        })
                        .component_ref(&area)
                        .size_full(),
                ),
        )
        .child(text(move || layout_text(&layout.get())))
        .child(text(move || format!("Removed {}", removed.get())))
        .child(text(move || format!("Active {}", active.get().join(" "))))
        .child(text(move || format!("Docks {}", docks.get().join(" "))))
        .child(text(move || {
            let sizes = sizes.get();
            let parts: Vec<String> = sizes
                .iter()
                .map(|(id, (w, h))| format!("{id}={w}x{h}"))
                .collect();
            format!("Sizes {}", parts.join(" "))
        }))
        .child(text(move || format!("Zoom {}", zoom.get())))
        .child(
            view()
                .flex_row()
                .child(button("close-c", Box::new(|a| a.close_panel("c".into()))))
                .child(button("close-a", Box::new(|a| a.close_panel("a".into()))))
                .child(button(
                    "toggle-left",
                    Box::new(|a| a.toggle_dock(DockPlacement::Left)),
                ))
                .child(button(
                    "toggle-bottom",
                    Box::new(|a| a.toggle_dock(DockPlacement::Bottom)),
                ))
                .child(button(
                    "zoom-a",
                    Box::new(|a| {
                        let group = a.group_of("a".into());
                        a.toggle_zoom(group);
                    }),
                ))
                .child(button("unzoom", Box::new(|a| a.toggle_zoom(None))))
                .child(button(
                    "remove-all",
                    Box::new(|a| {
                        for panel in ["a", "b", "c"] {
                            a.remove_panel(panel.into());
                        }
                    }),
                ))
                .child(
                    view()
                        .test_id("lock")
                        .w(px(20.0))
                        .h(px(20.0))
                        .on_press(move || locked.set(true)),
                ),
        )
}

/// The workspace of `layout` on a desktop's headless surface, `width`
/// wide.
fn start(layout: DockAreaLayout, width: f32) -> Headless {
    start_in(layout, width, None, None)
}

/// The same with the area in a box of `frame`.
fn start_in(
    layout: DockAreaLayout,
    width: f32,
    frame: Option<(f32, f32)>,
    compact: Option<bool>,
) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(width), px(900.0)),
        ..EngineConfig::new(Root::new::<Workspace>(move || WorkspaceProps {
            layout: layout.clone(),
            width: frame.map(|f| f.0),
            height: frame.map(|f| f.1),
            compact,
        }))
    };
    config.environment.os = Os::MacOs;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("Tab a").unwrap();
    app
}

/// The workspace of `layout`, `width` wide, on a manual clock (time moves
/// only when the test moves it, as `nsh/test`'s `clock: {}`).
fn start_manual(layout: DockAreaLayout, width: f32) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(width), px(900.0)),
        clock: nsh_engine::Clock::manual(std::time::SystemTime::now()),
        ..EngineConfig::new(Root::new::<Workspace>(move || WorkspaceProps {
            layout: layout.clone(),
            width: None,
            height: None,
            compact: None,
        }))
    };
    config.environment.os = Os::MacOs;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("Tab a").unwrap();
    app
}

#[test]
fn a_layout_shows_each_group_s_tabs_and_displayed_panel() {
    let app = start(two_groups(), 1000.0);
    for shown in ["Tab a", "Tab b", "Tab c", "Panel a", "Panel c"] {
        assert!(app.shows(shown), "{shown} shows");
    }
    // The other panel of a group is placed, hidden.
    assert!(!app.shows("Panel b"));
    assert_eq!(app.screen().count("role:tab").unwrap(), 3);
    assert_eq!(app.screen().count("role:tablist").unwrap(), 2);
}

#[test]
fn a_press_on_a_tab_selects_it() {
    let mut app = start(two_groups(), 1000.0);
    app.press("id:tab-b").unwrap();
    app.wait_for("Layout h([a *b]:400 [*c])").unwrap();
    app.wait_for("Panel b").unwrap();
    assert!(!app.shows("Panel a"));
}

#[test]
fn closing_a_panel_removes_it_unless_it_is_the_last_of_its_group_alone() {
    let mut app = start(two_groups(), 1000.0);
    app.press("id:close-c").unwrap();
    app.wait_for("Layout h([*a b]:400)").unwrap();
    app.wait_for("Removed c").unwrap();
    // `a b` is alone now: closing `a` leaves `b`.
    app.press("id:close-a").unwrap();
    app.wait_for("Layout h([*b]:400)").unwrap();
    app.wait_for("Removed a").unwrap();
    // `b` is the last panel: it stays.
    app.press("id:tab-b").unwrap();
    app.wait(std::time::Duration::from_millis(100)).unwrap();
    assert!(app.shows("Layout h([*b]:400)"));
}

#[test]
fn dragging_a_tab_to_the_edge_of_a_group_splits_it() {
    let mut app = start(two_groups(), 1000.0);
    // From the middle of tab a (40, 12) to the right of c's content.
    app.drag("id:tab-a", point(px(720.0), px(288.0))).unwrap();
    app.wait_for("Layout h([*b]:400 [*c] [*a])").unwrap();
    // Moved, not removed.
    assert!(app.shows("Removed none"));
    assert!(app.shows("Panel a"));
}

#[test]
fn dragging_a_tab_into_the_middle_of_a_group_merges_it() {
    let mut app = start(two_groups(), 1000.0);
    app.drag("id:tab-a", point(px(560.0), px(288.0))).unwrap();
    app.wait_for("Layout h([*b]:400 [c *a])").unwrap();
}

#[test]
fn dragging_a_tab_onto_a_tab_bar_inserts_it_at_the_slot() {
    let mut app = start(two_groups(), 1000.0);
    // Past the middle of c's tab (440): after it.
    app.drag("id:tab-a", point(px(450.0), px(0.0))).unwrap();
    app.wait_for("Layout h([*b]:400 [c *a])").unwrap();
    // Before it.
    app.drag("id:tab-b", point(px(380.0), px(0.0))).unwrap();
    app.wait_for("Layout h([*b c a])").unwrap();
}

#[test]
fn a_locked_area_moves_nothing() {
    let mut app = start(two_groups(), 1000.0);
    app.press("id:lock").unwrap();
    app.drag("id:tab-a", point(px(560.0), px(288.0))).unwrap();
    app.wait(std::time::Duration::from_millis(200)).unwrap();
    assert!(app.shows("Layout h([*a b]:400 [*c])"));
    app.press("id:close-c").unwrap();
    app.wait(std::time::Duration::from_millis(100)).unwrap();
    assert!(app.shows("Removed none"));
}

#[test]
fn dragging_a_split_s_handle_resizes_it() {
    let mut app = start(two_groups(), 1000.0);
    app.drag("role:adjustable", point(px(100.0), px(0.0)))
        .unwrap();
    app.wait_for("Layout h([*a b]:500 [*c]:300)").unwrap();
}

#[test]
fn a_dock_opens_and_closes_and_keeps_its_panels() {
    let mut app = start(with_files(), 1000.0);
    app.wait_for("Panel files").unwrap();
    app.press("id:toggle-left").unwrap();
    app.wait_for("Layout h([*a b]:400 [*c]) left [*files] closed 200")
        .unwrap();
    app.wait_for_gone("Panel files", std::time::Duration::from_secs(5))
        .unwrap();
    app.press("id:toggle-left").unwrap();
    app.wait_for("Layout h([*a b]:400 [*c]) left [*files] open 200")
        .unwrap();
    app.wait_for("Panel files").unwrap();
}

#[test]
fn a_zoomed_group_fills_the_area() {
    let mut app = start(two_groups(), 1000.0);
    app.press("id:zoom-a").unwrap();
    app.wait_for("Zoom a").unwrap();
    app.wait_for_gone("Tab c", std::time::Duration::from_secs(5))
        .unwrap();
    assert!(app.shows("Panel a"));
    app.press("id:unzoom").unwrap();
    app.wait_for("Zoom out").unwrap();
    app.wait_for("Tab c").unwrap();
    assert!(app.shows("Panel a"));
}

#[test]
fn at_compact_width_the_center_shows_one_group_with_every_tab() {
    let mut app = start(with_files(), 400.0);
    for shown in ["Tab a", "Tab b", "Tab c", "Panel a"] {
        assert!(app.shows(shown), "{shown} shows");
    }
    assert!(!app.shows("Panel c"));
    // The left dock is open in the layout, and presented only when asked:
    // the drawer is the compact presentation's, the layout stays.
    assert!(!app.shows("Panel files"));
    // Told so against the layout's `open`.
    app.wait_for("Docks Left-").unwrap();
    app.press("id:toggle-left").unwrap();
    app.wait_for("Panel files").unwrap();
    app.wait_for("Docks Left- Left+").unwrap();
    // The layout as the app wrote it (no size given): nothing reported.
    assert!(app.shows("Layout h([*a b]:400 [*c]) left [*files] open 0"));
    app.press("id:toggle-left").unwrap();
    app.wait_for_gone("Panel files", std::time::Duration::from_secs(5))
        .unwrap();
    app.wait_for("Docks Left- Left+ Left-").unwrap();
    // The layout as the app wrote it: no size given, none reported.
    assert!(app.shows("Layout h([*a b]:400 [*c]) left [*files] open 0"));
    // A tab of the other group shows that group.
    app.press("id:tab-c").unwrap();
    app.wait_for("Panel c").unwrap();
    assert!(!app.shows("Panel a"));
}

#[test]
fn at_compact_width_one_dock_is_presented_at_a_time() {
    let mut app = start(with_two_docks(), 400.0);
    assert!(!app.shows("Panel files"));
    assert!(!app.shows("Panel terminal"));
    app.press("id:toggle-left").unwrap();
    app.wait_for("Panel files").unwrap();
    // Presenting the bottom dock dismisses the drawer.
    app.press("id:toggle-bottom").unwrap();
    app.wait_for("Panel terminal").unwrap();
    app.wait_for_gone("Panel files", std::time::Duration::from_secs(5))
        .unwrap();
    app.wait_for("Docks Left- Bottom- Left+ Left- Bottom+")
        .unwrap();
}

#[test]
fn a_window_narrowed_and_widened_again_shows_the_layout_s_docks() {
    let mut app = start(with_files(), 1000.0);
    app.wait_for("Panel files").unwrap();
    // Compact: nothing presented, the layout untouched.
    app.set_viewport(Size::new(px(400.0), px(900.0))).unwrap();
    app.wait_for_gone("Panel files", std::time::Duration::from_secs(5))
        .unwrap();
    app.wait_for("Docks Left-").unwrap();
    // The layout as the app wrote it: no size given, none reported.
    assert!(app.shows("Layout h([*a b]:400 [*c]) left [*files] open 0"));
    // Wide again: the dock shows as the layout says.
    app.set_viewport(Size::new(px(1000.0), px(900.0))).unwrap();
    app.wait_for("Panel files").unwrap();
    app.wait_for("Docks Left- Left+").unwrap();
}

#[test]
fn a_panel_hears_each_change_of_being_displayed() {
    let mut app = start(two_groups(), 1000.0);
    app.wait_for("Active a+ c+").unwrap();
    app.press("id:tab-b").unwrap();
    app.wait_for("Active a+ c+ a- b+").unwrap();
}

#[test]
fn a_tab_dragged_into_a_dock_moves_there() {
    let mut app = start(with_files(), 1000.0);
    // The dock is 200 wide: c's tab is at 600 to 680.
    app.drag("id:tab-c", point(px(-540.0), px(288.0))).unwrap();
    app.wait_for("Layout h([*a b]:400) left [files *c] open 200")
        .unwrap();
    assert!(app.shows("Removed none"));
    assert!(app.shows("Panel c"));
}

#[test]
fn dragging_a_dock_s_handle_resizes_it_and_past_its_minimum_closes_it() {
    let mut app = start(with_files(), 1000.0);
    // The dock's handle comes first, then the split's.
    app.drag("role:adjustable >> nth=0", point(px(50.0), px(0.0)))
        .unwrap();
    app.wait_for("Layout h([*a b]:400 [*c]) left [*files] open 250")
        .unwrap();
    // Not below its minimum, 100.
    app.drag("role:adjustable >> nth=0", point(px(-180.0), px(0.0)))
        .unwrap();
    app.wait_for("Layout h([*a b]:400 [*c]) left [*files] open 100")
        .unwrap();
    // Nearer closed than its minimum: it closes and keeps its size.
    app.drag("role:adjustable >> nth=0", point(px(-60.0), px(0.0)))
        .unwrap();
    app.wait_for("Layout h([*a b]:400 [*c]) left [*files] closed 100")
        .unwrap();
}

#[test]
fn at_compact_width_a_drag_reorders_the_tabs() {
    let mut app = start(two_groups(), 400.0);
    // The strip lists a, b and c, 80 wide each: c before a.
    app.drag("id:tab-c", point(px(-170.0), px(0.0))).unwrap();
    app.wait_for("Layout h([*c a b]:400)").unwrap();
    assert!(app.shows("Panel c"));
}

#[test]
fn an_empty_center_shows_what_the_app_renders_for_it() {
    let mut app = start(two_groups(), 1000.0);
    assert!(!app.shows("Empty Center"));
    app.press("id:remove-all").unwrap();
    app.wait_for("Empty Center").unwrap();
    app.wait_for("Layout h()").unwrap();
}

/// The sizes the panels' content was laid out at, from `Sizes …`.
fn sizes(app: &Headless) -> std::collections::BTreeMap<String, (f32, f32)> {
    let line = app
        .screen()
        .texts()
        .into_iter()
        .find(|t| t.starts_with("Sizes"))
        .unwrap_or_default()
        .to_owned();
    line.split_whitespace()
        .skip(1)
        .filter_map(|part| {
            let (id, size) = part.split_once('=')?;
            let (w, h) = size.split_once('x')?;
            Some((id.to_owned(), (w.parse().ok()?, h.parse().ok()?)))
        })
        .collect()
}

#[test]
fn an_area_smaller_than_its_layout_stays_within_its_bounds() {
    // Docks of 200 on the left and at the bottom, in a box of 345 × 385
    // in a wide window (the full presentation: `compact` off).
    let mut app = start_in(with_two_docks(), 1000.0, Some((345.0, 385.0)), Some(false));
    app.wait_for("Panel terminal").unwrap();
    app.wait(std::time::Duration::from_millis(100)).unwrap();
    let sizes = sizes(&app);
    let (files, a, c, terminal) = (sizes["files"], sizes["a"], sizes["c"], sizes["terminal"]);
    for (id, (w, h)) in [("files", files), ("a", a), ("c", c), ("terminal", terminal)] {
        assert!(w > 0.0 && h > 0.0, "{id} is laid out: {sizes:?}");
    }
    // Side by side: the dock and the two groups within 345.
    assert!(files.0 + a.0 + c.0 <= 345.0, "{sizes:?}");
    // Stacked: a group over the bottom dock, two tab bars of 24, within 385.
    assert!(a.1 + terminal.1 + 48.0 <= 385.0, "{sizes:?}");
    assert!(files.1 + 24.0 <= 385.0, "{sizes:?}");
}

#[test]
fn a_narrow_area_in_a_wide_window_is_compact() {
    let app = start_in(two_groups(), 1000.0, Some((345.0, 385.0)), None);
    // One tab bar listing every center panel, one group shown.
    assert_eq!(app.screen().count("role:tablist").unwrap(), 1);
    assert!(app.shows("Tab c"));
    assert!(app.shows("Panel a"));
    assert!(!app.shows("Panel c"));
}

#[test]
fn a_compact_drawer_is_dismissed_on_a_manual_clock() {
    // Its slide-out ends it, not a timer of the app's clock.
    let mut app = start_manual(with_files(), 400.0);
    app.press("id:toggle-left").unwrap();
    app.wait_for("Panel files").unwrap();
    app.press("id:toggle-left").unwrap();
    app.wait_for_gone("Panel files", std::time::Duration::from_secs(5))
        .unwrap();
    app.wait_for("Docks Left- Left+ Left-").unwrap();
}

/// The workspace of `layout` on a phone-width browser page (the web in the
/// phone idiom), driven by a mouse or a finger.
fn start_web_phone(layout: DockAreaLayout) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(400.0), px(900.0)),
        ..EngineConfig::new(Root::new::<Workspace>(move || WorkspaceProps {
            layout: layout.clone(),
            width: None,
            height: None,
            compact: None,
        }))
    };
    config.environment.os = Os::Web;
    config.environment.idiom = Idiom::Phone;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("Tab a").unwrap();
    app
}

#[test]
fn a_finger_s_drag_waits_for_a_long_press_and_a_pointer_s_does_not() {
    let mut app = start_web_phone(two_groups());
    // A finger: no hover before it, so the swipe drags nothing.
    app.drag("id:tab-c", point(px(-170.0), px(0.0))).unwrap();
    app.wait(std::time::Duration::from_millis(200)).unwrap();
    assert!(app.shows("Layout h([*a b]:400 [*c])"));
    // A mouse hovers the tab before it presses it: it drags at once.
    app.hover("id:tab-c").unwrap();
    app.drag("id:tab-c", point(px(-170.0), px(0.0))).unwrap();
    app.wait_for("Layout h([*c a b]:400)").unwrap();
}
