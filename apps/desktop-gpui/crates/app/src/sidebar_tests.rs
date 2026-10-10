/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! UI integration tests of the sidebar column's geometry: dragging its edge
//! to resize it, collapsing it to a rail or to nothing as the window
//! narrows, and opening it over the plate, in the production window content
//! against the chrome tests' scripted Host.

use std::rc::Rc;

use gpui_kit::component::Root;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AppContext as _, ElementId, Pixels, TestAppContext, point, px, size};
use settings::{AppPreferences, NarrowSidebar, choose_narrow_sidebar};
use shared::domain_element_id;
use workspace::UnavailableProjectCatalog;

use crate::chrome_tests::{Harness, row, session};
use crate::{SidebarForm, Workbench};

fn column_width(harness: &Harness, cx: &mut TestAppContext) -> Pixels {
    harness.with_window(cx, |window, _| window.find("sidebar-column").bounds().size.width)
}

/// Drags the sidebar's edge by `by` pixels.
fn drag_edge(harness: &Harness, by: f32, cx: &mut TestAppContext) {
    harness.with_window(cx, |window, cx| {
        let start = window.find("sidebar-resize").bounds().center();
        window.drag(start, point(start.x + px(by), start.y), cx);
    });
}

fn saved_width(cx: &mut TestAppContext) -> u16 {
    cx.update(|cx| AppPreferences::current(cx).sidebar_width)
}

#[gpui_kit::test]
fn dragging_the_edge_resizes_the_sidebar_within_desktops_widths_and_keeps_it(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    assert_eq!(column_width(&harness, cx), px(256.), "the reviewed width at first");
    harness.with_window(cx, |window, _| {
        let handle = window.find("sidebar-resize");
        assert_eq!(handle.label(), Some(shared::copy::RESIZE_SIDEBAR.en()));
        let handle = handle.bounds();
        // In the canvas margin between the column and the plate, below the
        // chrome band, whose drag moves the window.
        assert_eq!(handle.size.width, px(6.));
        assert_eq!(handle.center().x, px(260.));
        let band = window.find("sidebar-chrome").bounds();
        assert!(handle.top() >= band.bottom(), "{handle:?} under {band:?}");
    });

    drag_edge(&harness, 100., cx);
    assert_eq!(column_width(&harness, cx), px(356.));
    harness.with_window(cx, |window, _| {
        let column = window.find("sidebar-column").bounds();
        assert_eq!(window.find("main-pane").bounds().left(), column.right() + px(8.));
        // The task rows and the footer take the new width.
        let task = window.find(row("s1")).bounds();
        assert_eq!(task.right(), column.right() - px(8.));
        let footer = window.find("host-status").bounds();
        assert_eq!(footer.right(), column.right());
    });
    assert_eq!(saved_width(cx), 356, "saved once the drag pauses");

    // Desktop's narrowest, short of collapsing (below 160); at the other
    // end the plate keeps the composer's width and its gutters (1200 less
    // 784 is 416, under Desktop's 480).
    drag_edge(&harness, -186., cx);
    assert_eq!(column_width(&harness, cx), px(180.));
    drag_edge(&harness, 900., cx);
    assert_eq!(column_width(&harness, cx), px(416.));

    // A double-click restores the default, which is saved too.
    harness.with_window(cx, |window, cx| window.double_click("sidebar-resize", cx));
    assert_eq!(column_width(&harness, cx), px(256.));
    assert_eq!(saved_width(cx), 256);

    // From the keyboard: Left and Right by 10, with Shift by 50, Enter
    // back to the default.
    harness.with_window(cx, |window, cx| {
        window.click("sidebar-resize", cx);
        window.press("right", cx);
    });
    assert_eq!(column_width(&harness, cx), px(266.));
    harness.with_window(cx, |window, cx| window.press("shift-left", cx));
    assert_eq!(column_width(&harness, cx), px(216.));
    harness.with_window(cx, |window, cx| window.press("enter", cx));
    assert_eq!(column_width(&harness, cx), px(256.));

    // A window opened afterwards starts at the width last saved.
    drag_edge(&harness, 44., cx);
    assert_eq!(saved_width(cx), 300);
    let host = harness.host.clone();
    let mut second = None;
    cx.open_window(size(px(1200.), px(800.)), |window, cx| {
        let view = cx
            .new(|cx| Workbench::new(host.clone(), Rc::new(UnavailableProjectCatalog), window, cx));
        second = Some(view.clone());
        Root::new(view, window, cx)
    });
    let second = second.expect("a second workbench");
    assert_eq!(second.read_with(cx, |workbench, _| workbench.sidebar_width()), 300);
}

/// Desktop's rule: dragged below 160 (20 under the narrowest width), the
/// sidebar collapses to the form the setting chooses, as the person's own
/// collapse, sliding there; dragged from the rail's edge back past the
/// narrowest width, it expands at the width dragged to.
#[gpui_kit::test]
fn dragging_the_edge_past_the_narrowest_width_collapses_the_sidebar(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    drag_edge(&harness, -96., cx);
    assert_eq!(column_width(&harness, cx), px(180.), "160 is still a width");
    assert_eq!(form(&harness, cx), SidebarForm::Expanded);

    // One pixel further, without the harness's settling, which runs the
    // clock past the slide.
    cx.update(|cx| cx.set_reduce_motion(false));
    cx.update_window(harness.window.into(), |_, window, cx| {
        window.render_frame(cx);
        let start = window.find("sidebar-resize").bounds().center();
        window.drag(start, point(start.x - px(21.), start.y), cx);
        window.render_frame(cx);
        assert!(window.find("sidebar-slot").visible(), "the column slides to the rail");
    })
    .expect("window");
    cx.run_until_parked();
    assert_eq!(form(&harness, cx), SidebarForm::Rail);
    crate::chrome_tests::settle(cx);
    assert_eq!(saved_width(cx), 180, "the width it had is kept, not the drag's");

    // A collapse of the person's: widening the window does not undo it.
    resize(&harness, 1000., cx);
    resize(&harness, 1200., cx);
    assert_eq!(form(&harness, cx), SidebarForm::Rail);

    // The rail's edge has the handle; short of the narrowest width it stays.
    harness.with_window(cx, |window, _| {
        let handle = window.find("sidebar-resize").bounds();
        let rail = window.find("sidebar-rail").bounds();
        assert_eq!(handle.center().x, rail.right() + px(4.), "in the margin after the rail");
    });
    drag_edge(&harness, 107., cx);
    assert_eq!(form(&harness, cx), SidebarForm::Rail, "179 is short of the narrowest width");
    drag_edge(&harness, 150., cx);
    assert_eq!(form(&harness, cx), SidebarForm::Expanded);
    assert_eq!(column_width(&harness, cx), px(222.), "at the width dragged to");
    assert_eq!(saved_width(cx), 222);

    // With Hide chosen it collapses to nothing.
    cx.update(|cx| choose_narrow_sidebar(NarrowSidebar::Hide, cx));
    drag_edge(&harness, -100., cx);
    assert_eq!(form(&harness, cx), SidebarForm::Hidden);
    harness.with_window(cx, |window, _| assert!(window.try_find("sidebar-resize").is_none()));
}

/// One drag can collapse the sidebar and bring it back: past the
/// narrowest width again it expands at the width the drag ends on.
#[gpui_kit::test]
fn one_drag_collapses_the_sidebar_and_brings_it_back(cx: &mut TestAppContext) {
    use gpui_kit::{MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PlatformInput};
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    let start =
        harness.with_window(cx, |window, _| window.find("sidebar-resize").bounds().center());
    let at = |x: f32| point(px(x), start.y);
    let forms = harness.with_window(cx, |window, cx| {
        let mut forms = Vec::new();
        window.dispatch_event(
            PlatformInput::MouseDown(MouseDownEvent {
                button: MouseButton::Left,
                position: start,
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            }),
            cx,
        );
        for x in [230., 150., 100., 200., 300.] {
            window.dispatch_event(
                PlatformInput::MouseMove(MouseMoveEvent {
                    position: at(x),
                    pressed_button: Some(MouseButton::Left),
                    modifiers: Default::default(),
                }),
                cx,
            );
            window.render_frame(cx);
            forms.push(harness.workbench.read(cx).sidebar_form());
        }
        window.dispatch_event(
            PlatformInput::MouseUp(MouseUpEvent {
                button: MouseButton::Left,
                position: at(300.),
                modifiers: Default::default(),
                click_count: 1,
            }),
            cx,
        );
        forms
    });
    use SidebarForm::{Expanded, Rail};
    assert_eq!(forms, [Expanded, Rail, Rail, Expanded, Expanded]);
    assert_eq!(column_width(&harness, cx), px(296.), "at the width the drag ends on");
}

/// The focused handle's keys follow the same rule: a large step from near
/// the narrowest width collapses the sidebar (Desktop's Shift+Left), the
/// handle keeps focus on the rail's edge, and there Right expands it and
/// Enter expands it at the default width.
#[gpui_kit::test]
fn the_handles_keys_collapse_and_expand_the_sidebar(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    drag_edge(&harness, -56., cx);
    assert_eq!(column_width(&harness, cx), px(200.));
    // With motion, so a frame is drawn while the column slides.
    cx.update(|cx| cx.set_reduce_motion(false));
    harness.with_window(cx, |window, cx| {
        window.click("sidebar-resize", cx);
        window.press("left", cx);
        window.press("shift-left", cx);
        window.render_frame(cx);
        assert!(window.find("sidebar-slot").visible());
    });
    assert_eq!(form(&harness, cx), SidebarForm::Rail, "190 less 50 is under 160");
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find("sidebar-resize").focused(), Some(true), "focus stays on it");
        window.press("left", cx);
    });
    assert_eq!(form(&harness, cx), SidebarForm::Rail, "nothing narrower than the rail");
    harness.with_window(cx, |window, cx| window.press("right", cx));
    assert_eq!(form(&harness, cx), SidebarForm::Expanded);
    assert_eq!(column_width(&harness, cx), px(190.), "at the width it had");

    harness.with_window(cx, |window, cx| window.press("secondary-b", cx));
    assert_eq!(form(&harness, cx), SidebarForm::Rail);
    harness.with_window(cx, |window, cx| {
        window.click("sidebar-resize", cx);
        window.press("enter", cx);
    });
    assert_eq!(form(&harness, cx), SidebarForm::Expanded);
    assert_eq!(column_width(&harness, cx), px(256.), "Enter gives the default width");
}

/// Resizes the harness's window to `width` (800 tall).
fn resize(harness: &Harness, width: f32, cx: &mut TestAppContext) {
    cx.simulate_window_resize(harness.window.into(), size(px(width), px(800.)));
    harness.with_window(cx, |_, _| {});
}

fn form(harness: &Harness, cx: &mut TestAppContext) -> SidebarForm {
    harness.workbench.read_with(cx, |workbench, _| workbench.sidebar_form())
}

fn over_plate(harness: &Harness, cx: &mut TestAppContext) -> bool {
    harness.workbench.read_with(cx, |workbench, _| workbench.sidebar_over_plate())
}

fn rail_page(key: &str) -> ElementId {
    domain_element_id("rail-page", key)
}

/// The breakpoint is the expanded sidebar (256) beside a plate as wide as
/// the composer's column and gutters (768) with the canvas margin either
/// side (16): 1040 at the default font size.
#[gpui_kit::test]
fn narrowing_past_the_breakpoint_collapses_to_the_rail_and_widening_expands_again(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    assert_eq!(form(&harness, cx), SidebarForm::Expanded);
    resize(&harness, 1039., cx);
    assert_eq!(form(&harness, cx), SidebarForm::Rail);
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("sidebar-column").is_none());
        let rail = window.find("sidebar-rail").bounds();
        assert_eq!(rail.size.width, px(72.), "the rail clears the traffic lights");
        assert_eq!(window.find("main-pane").bounds().left(), px(80.));
        // The window controls move to the plate's header, after the rail.
        let toggle = window.find("sidebar-toggle");
        assert_eq!(toggle.label(), Some(shared::copy::SIDEBAR_SHOW.en()));
        assert!(toggle.bounds().left() > px(80.));
    });
    resize(&harness, 1040., cx);
    assert_eq!(form(&harness, cx), SidebarForm::Expanded, "wide enough again");
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("sidebar-column").bounds().size.width, px(256.));
        assert!(window.try_find("sidebar-rail").is_none());
    });

    // A window that opens narrow opens with the rail.
    let narrow = Harness::open_sized(vec![session("s1", "Alpha")], size(px(1000.), px(800.)), cx);
    assert_eq!(form(&narrow, cx), SidebarForm::Rail);
}

#[gpui_kit::test]
fn a_sidebar_collapsed_by_hand_stays_collapsed_as_the_window_widens(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    harness.with_window(cx, |window, cx| window.press("secondary-b", cx));
    assert_eq!(form(&harness, cx), SidebarForm::Rail, "⌘B collapses to the chosen form");
    resize(&harness, 1000., cx);
    resize(&harness, 1200., cx);
    assert_eq!(form(&harness, cx), SidebarForm::Rail, "widening leaves it collapsed");
    harness.with_window(cx, |window, cx| window.click("sidebar-toggle", cx));
    assert_eq!(form(&harness, cx), SidebarForm::Expanded);
    // Collapsed by the window, it expands with it.
    resize(&harness, 1000., cx);
    resize(&harness, 1200., cx);
    assert_eq!(form(&harness, cx), SidebarForm::Expanded);
}

#[gpui_kit::test]
fn the_rail_holds_new_task_the_pages_search_the_host_and_settings(cx: &mut TestAppContext) {
    let harness = Harness::open_sized(vec![session("s1", "Alpha")], size(px(1000.), px(800.)), cx);
    harness.with_window(cx, |window, _| {
        let labelled = [
            ("rail-new-task".into(), shared::copy::NEW_TASK.en()),
            (rail_page("extensions"), session::SidebarPage::Extensions.title().en()),
            (rail_page("scheduled-tasks"), session::SidebarPage::ScheduledTasks.title().en()),
            ("rail-search".into(), shared::copy::search::SEARCH_ALL_TASKS.en()),
            ("rail-settings".into(), shared::copy::settings::SETTINGS.en()),
        ];
        let mut above = px(0.);
        for (id, label) in labelled {
            let button = window.find(id.clone());
            assert_eq!(button.label(), Some(label), "{id:?}");
            assert!(button.bounds().top() > above, "{id:?} in order");
            above = button.bounds().top();
        }
        let host = window.find("rail-host-status");
        assert!(host.label().expect("label").contains("Connected"), "{:?}", host.label());
        assert!(window.find("rail-host-dot").visible());
        // At the foot: the Host, then settings, on the plate's bottom inset.
        let settings = window.find("rail-settings").bounds();
        assert!(host.bounds().bottom() <= settings.top());
        assert_eq!(settings.bottom(), px(792.));
        // Not the task list or the grouping.
        for id in ["session-list", "task-grouping", "sidebar-footer"] {
            assert!(window.try_find(id).is_none(), "{id} is not in the rail");
        }
    });
    // Its page entries open their page (whose button has the selected
    // fill).
    harness.with_window(cx, |window, cx| window.click(rail_page("extensions"), cx));
    assert_eq!(
        harness.workbench.read_with(cx, |workbench, _| workbench.page()),
        Some(session::SidebarPage::Extensions)
    );
    harness.with_window(cx, |window, cx| window.click("rail-search", cx));
    assert_eq!(
        harness.workbench.read_with(cx, |workbench, _| workbench.page()),
        Some(session::SidebarPage::Search),
        "search opens the Search page"
    );
    harness.with_window(cx, |window, cx| window.click("rail-host-status", cx));
    assert!(harness.workbench.read_with(cx, |workbench, _| workbench.footer_menu_open()));
    harness.with_window(cx, |window, cx| window.press("escape", cx));
    harness.with_window(cx, |window, cx| window.click("rail-settings", cx));
    assert!(harness.workbench.read_with(cx, |workbench, _| workbench.settings_open()));
}

#[gpui_kit::test]
fn the_setting_switches_between_the_rail_and_hiding(cx: &mut TestAppContext) {
    let harness = Harness::open_sized(vec![session("s1", "Alpha")], size(px(1000.), px(800.)), cx);
    assert_eq!(form(&harness, cx), SidebarForm::Rail);
    cx.update(|cx| choose_narrow_sidebar(NarrowSidebar::Hide, cx));
    assert_eq!(form(&harness, cx), SidebarForm::Hidden);
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("sidebar-rail").is_none());
        assert!(window.try_find("sidebar-column").is_none());
        let header = window.find("main-header").bounds();
        assert_eq!(header.left(), px(8.), "the plate takes the window");
        if cfg!(target_os = "macos") {
            // The toggle stays beside the traffic lights.
            let toggle = window.find("sidebar-toggle").bounds();
            assert!(toggle.left() - header.left() >= px(70.), "toggle at {toggle:?}");
        }
    });
    cx.update(|cx| choose_narrow_sidebar(NarrowSidebar::Icons, cx));
    assert_eq!(form(&harness, cx), SidebarForm::Rail);
    // ⌘B, wide, toggles between expanded and the chosen form.
    resize(&harness, 1200., cx);
    cx.update(|cx| choose_narrow_sidebar(NarrowSidebar::Hide, cx));
    harness.with_window(cx, |window, cx| window.press("secondary-b", cx));
    assert_eq!(form(&harness, cx), SidebarForm::Hidden);
    harness.with_window(cx, |window, cx| window.press("secondary-b", cx));
    assert_eq!(form(&harness, cx), SidebarForm::Expanded);
}

#[gpui_kit::test]
fn while_narrow_the_sidebar_opens_over_the_plate_and_closes_on_escape_a_press_or_a_task(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open_sized(
        vec![session("s1", "Alpha"), session("s2", "Beta")],
        size(px(1000.), px(800.)),
        cx,
    );
    let draft = harness.draft_id(cx);
    let open = |cx: &mut TestAppContext| {
        harness.with_window(cx, |window, cx| window.press("secondary-b", cx));
        assert!(over_plate(&harness, cx), "⌘B opens it over the plate");
    };
    harness.with_window(cx, |window, cx| window.click(draft.clone(), cx));
    open(cx);
    harness.with_window(cx, |window, _| {
        let column = window.find("sidebar-column").bounds();
        assert_eq!((column.left(), column.size.width), (px(0.), px(256.)));
        assert!(window.find("sidebar-overlay").visible());
        assert_eq!(window.find("main-pane").bounds().left(), px(80.), "the plate stays put");
        assert_eq!(window.find("session-list").focused(), Some(true), "its list has focus");
        assert_eq!(window.find("sidebar-toggle").label(), Some(shared::copy::SIDEBAR_HIDE.en()));
    });
    assert_eq!(form(&harness, cx), SidebarForm::Rail, "the rail stays under it");

    harness.with_window(cx, |window, cx| window.press("escape", cx));
    assert!(!over_plate(&harness, cx), "Escape closes it");
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("sidebar-overlay").is_none());
        assert_eq!(window.find(draft.clone()).focused(), Some(true), "focus goes back");
    });

    // A press outside it.
    open(cx);
    harness.with_window(cx, |window, cx| window.click("sidebar-overlay-scrim", cx));
    assert!(!over_plate(&harness, cx), "a press outside closes it");

    // The arrows walk its list; a task chosen with the pointer closes it.
    open(cx);
    harness.with_window(cx, |window, cx| window.press("down", cx));
    assert!(over_plate(&harness, cx), "the keyboard walks the list");
    harness.with_window(cx, |window, cx| window.click(row("s2"), cx));
    assert!(!over_plate(&harness, cx), "choosing a task closes it");
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("session-title").label(), Some("Beta"));
        assert_eq!(window.find(draft.clone()).focused(), Some(true));
    });

    // ⌘B closes it too; with Hide chosen it opens over nothing.
    open(cx);
    harness.with_window(cx, |window, cx| window.press("secondary-b", cx));
    assert!(!over_plate(&harness, cx));
    cx.update(|cx| choose_narrow_sidebar(NarrowSidebar::Hide, cx));
    open(cx);
    assert_eq!(form(&harness, cx), SidebarForm::Hidden);

    // Widened while open, the sidebar takes its place beside the plate.
    resize(&harness, 1200., cx);
    assert!(!over_plate(&harness, cx));
    assert_eq!(form(&harness, cx), SidebarForm::Expanded);
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("sidebar-overlay").is_none());
        assert_eq!(window.find("main-pane").bounds().left(), px(264.));
    });
}

#[gpui_kit::test]
fn the_column_slides_between_widths_as_the_kit_sidebar_does(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha")], cx);
    cx.update(|cx| cx.set_reduce_motion(false));
    // Without the harness's settling, which runs the clock past the slide.
    let frame = |cx: &mut TestAppContext, f: &dyn Fn(&mut gpui_kit::Window, &mut gpui_kit::App)| {
        cx.update_window(harness.window.into(), |_, window, cx| {
            window.render_frame(cx);
            f(window, cx);
        })
        .expect("window");
        cx.run_until_parked();
    };
    frame(cx, &|window, cx| window.press("secondary-b", cx));
    frame(cx, &|window, _| {
        assert!(window.find("sidebar-slot").visible(), "the slot eases to the rail");
        assert!(window.find("sidebar-rail").visible(), "the rail shows at once");
    });
    // Settled after its 200 ms.
    crate::chrome_tests::settle(cx);
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("sidebar-slot").is_none());
        assert_eq!(window.find("sidebar-rail").bounds().size.width, px(72.));
    });
}

#[gpui_kit::test]
fn a_sidebar_wider_than_the_default_gives_way_to_it_before_collapsing(cx: &mut TestAppContext) {
    let harness = Harness::open_sized(vec![session("s1", "Alpha")], size(px(1600.), px(800.)), cx);
    drag_edge(&harness, 300., cx);
    assert_eq!(column_width(&harness, cx), px(480.), "Desktop's widest");
    resize(&harness, 1200., cx);
    assert_eq!(column_width(&harness, cx), px(416.), "the plate keeps the composer's width");
    resize(&harness, 1040., cx);
    assert_eq!(column_width(&harness, cx), px(256.));
    resize(&harness, 1039., cx);
    assert_eq!(form(&harness, cx), SidebarForm::Rail);
    resize(&harness, 1600., cx);
    assert_eq!(column_width(&harness, cx), px(480.), "the width it was given");
    assert_eq!(saved_width(cx), 480);
}

#[gpui_kit::test]
fn the_rails_icons_hop_as_the_pointer_enters_them(cx: &mut TestAppContext) {
    let harness = Harness::open_sized(vec![session("s1", "Alpha")], size(px(1000.), px(800.)), cx);
    cx.update(|cx| cx.set_reduce_motion(false));
    let hopping = |key: &'static str, cx: &mut TestAppContext| {
        harness.workbench.read_with(cx, |workbench, cx| workbench.rail_icon_hopping(key, cx))
    };
    for (id, key) in [
        (ElementId::from("rail-new-task"), "new-task"),
        (rail_page("extensions"), "extensions"),
        (rail_page("scheduled-tasks"), "scheduled-tasks"),
        ("rail-search".into(), "search"),
        ("rail-settings".into(), "settings"),
    ] {
        cx.update_window(harness.window.into(), |_, window, cx| {
            window.render_frame(cx);
            window.hover(id, cx);
        })
        .expect("window");
        cx.run_until_parked();
        assert!(hopping(key, cx), "{key} hops");
        cx.executor().advance_clock(shared::hop::HOP_DURATION);
        assert!(!hopping(key, cx), "{key} settles");
    }
}
