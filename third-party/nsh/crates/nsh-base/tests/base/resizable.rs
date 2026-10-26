//! `ResizablePanelGroup`: dragging a handle resizes the panels on either
//! side within their ranges and reports the sizes once, when it ends; a
//! panel hidden gives its space back, and the group's panels keep their
//! proportions when it resizes.

use nsh_base::{
    HandleEdge, ResizeHandleState, h_resizable, resizable_panel, resize_handle, v_resizable,
};
use nsh_core::{
    Bounds, Size,
    element::Root,
    geometry::{Along, Axis, point},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// The sizes, rounded, as the app shows them.
fn shown(sizes: &[Points]) -> String {
    sizes
        .iter()
        .map(|s| format!("{}", s.0.round()))
        .collect::<Vec<_>>()
        .join(", ")
}

/// A panel's content, filling it, telling `width` how wide it is laid out.
fn content(width: Signal<f32>, axis: Axis) -> View {
    view()
        .flex_1()
        .on_layout(move |frame: &Bounds<Points>| width.set(frame.size.along(axis).0.round()))
}

/// Three panels side by side in a group 400 wide: a sidebar of 150
/// (100 to 200), a flexible middle and a third the app shows and hides;
/// what the group and the sidebar report.
#[component]
fn Columns() -> impl IntoElement {
    let widths = [signal(0.0_f32), signal(0.0), signal(0.0)];
    let reported = signal(String::from("none"));
    let sidebar = signal(String::from("none"));
    let third = signal(false);
    let [a, b, c] = widths;
    view()
        .child(
            view().w(px(400.0)).h(px(100.0)).child(
                h_resizable()
                    .handle_class("w-px")
                    .on_resize(move |sizes: &Vec<Points>| reported.set(shown(sizes)))
                    .child(
                        resizable_panel()
                            .size(px(150.0))
                            .size_range(px(100.0)..px(200.0))
                            .on_resize(move |size: &Points| sidebar.set(shown(&[*size])))
                            .child(content(a, Axis::Horizontal)),
                    )
                    .child(resizable_panel().child(content(b, Axis::Horizontal)))
                    .child(
                        resizable_panel()
                            .visible(move || third.get())
                            .size(px(100.0))
                            .child(content(c, Axis::Horizontal)),
                    ),
            ),
        )
        .child(text(move || {
            format!("Widths {} {} {}", a.get(), b.get(), c.get())
        }))
        .child(text(move || format!("Reported {}", reported.get())))
        .child(text(move || format!("Sidebar {}", sidebar.get())))
        .child(
            view()
                .test_id("third")
                .h(px(20.0))
                .on_press(move || third.set(!third.get_untracked())),
        )
}

/// `C` on a headless surface 400 wide.
fn start<C: Component>() -> Headless
where
    C::Props: Default,
{
    Headless::start(EngineConfig {
        viewport: Size::new(px(400.0), px(844.0)),
        ..EngineConfig::new(Root::of::<C>())
    })
    .expect("the engine starts")
}

#[test]
fn a_drag_resizes_the_panels_and_reports_once_it_ends() {
    let mut app = start::<Columns>();
    // The sidebar keeps its size, the middle takes the rest.
    app.wait_for("Widths 150 250 0").unwrap();
    assert!(app.shows("Reported none"));
    // One handle: the third panel is hidden.
    assert_eq!(app.screen().count("role:adjustable").unwrap(), 1);

    app.drag("role:adjustable", point(px(30.0), px(5.0)))
        .unwrap();
    app.wait_for("Widths 180 220 0").unwrap();
    app.wait_for("Reported 180, 220").unwrap();
    app.wait_for("Sidebar 180").unwrap();

    // Past its maximum, it stops at 200; the handle follows the boundary.
    app.drag("role:adjustable", point(px(60.0), px(0.0)))
        .unwrap();
    app.wait_for("Widths 200 200 0").unwrap();
    app.wait_for("Reported 200, 200").unwrap();

    // Below its minimum, it stops at 100.
    app.drag("role:adjustable", point(px(-150.0), px(0.0)))
        .unwrap();
    app.wait_for("Widths 100 300 0").unwrap();
    app.wait_for("Reported 100, 300").unwrap();
    app.wait_for("Sidebar 100").unwrap();
}

#[test]
fn a_panel_shown_takes_its_space_from_the_others_and_gives_it_back() {
    let mut app = start::<Columns>();
    app.wait_for("Widths 150 250 0").unwrap();

    app.press("id:third").unwrap();
    // Its 100 come from the middle, which has no size of its own.
    app.wait_for("Widths 150 150 100").unwrap();
    assert_eq!(app.screen().count("role:adjustable").unwrap(), 2);

    // The second handle moves the space between the middle and the third.
    app.drag("role:adjustable >> nth=1", point(px(-40.0), px(0.0)))
        .unwrap();
    app.wait_for("Widths 150 110 140").unwrap();
    app.wait_for("Reported 150, 110, 140").unwrap();

    app.press("id:third").unwrap();
    // Its space goes back to the middle.
    app.wait_for("Widths 150 250 0").unwrap();
    assert_eq!(app.screen().count("role:adjustable").unwrap(), 1);
}

#[test]
fn panels_that_all_have_a_size_share_a_wider_group_in_proportion() {
    let mut app = start::<Proportions>();
    app.wait_for("Widths 100 300").unwrap();
    app.set_viewport(Size::new(px(800.0), px(844.0))).unwrap();
    // 1 : 3 of the new width.
    app.wait_for("Widths 200 600").unwrap();
    // And back.
    app.set_viewport(Size::new(px(400.0), px(844.0))).unwrap();
    app.wait_for("Widths 100 300").unwrap();
}

/// Two panels filling the window's width, both with a size: 100 and 300.
#[component]
fn Proportions() -> impl IntoElement {
    let (a, b) = (signal(0.0_f32), signal(0.0_f32));
    view()
        .child(
            view().h(px(100.0)).child(
                h_resizable()
                    .child(
                        resizable_panel()
                            .size(px(100.0))
                            .child(content(a, Axis::Horizontal)),
                    )
                    .child(
                        resizable_panel()
                            .size(px(300.0))
                            .child(content(b, Axis::Horizontal)),
                    ),
            ),
        )
        .child(text(move || format!("Widths {} {}", a.get(), b.get())))
}

/// A sidebar of 220 beside a panel taking the rest, filling the window's
/// width; how many times the group reported.
#[component]
fn Shrinking() -> impl IntoElement {
    let (a, b) = (signal(0.0_f32), signal(0.0_f32));
    let resizes = signal(0);
    view()
        .child(
            view().h(px(100.0)).child(
                h_resizable()
                    .on_resize(move |_: &Vec<Points>| resizes.set(resizes.get_untracked() + 1))
                    .child(
                        resizable_panel()
                            .size(px(220.0))
                            .child(content(a, Axis::Horizontal)),
                    )
                    .child(resizable_panel().child(content(b, Axis::Horizontal))),
            ),
        )
        .child(text(move || format!("Widths {} {}", a.get(), b.get())))
        .child(text(move || format!("Resizes {}", resizes.get())))
}

#[test]
fn a_group_too_small_shrinks_a_panel_until_there_is_room_again() {
    let mut app = start::<Shrinking>();
    app.wait_for("Widths 220 180").unwrap();
    // 250 wide: the other panel stays at its minimum (100), the sidebar
    // gives way.
    app.set_viewport(Size::new(px(250.0), px(844.0))).unwrap();
    app.wait_for("Widths 150 100").unwrap();
    // Room again: the sidebar is back at its size, the other takes the
    // rest; the group's size is no drag, so nothing is reported.
    app.set_viewport(Size::new(px(900.0), px(844.0))).unwrap();
    app.wait_for("Widths 220 680").unwrap();
    assert!(app.shows("Resizes 0"));
}

/// Two panels stacked in a group 300 high.
#[component]
fn Rows() -> impl IntoElement {
    let (a, b) = (signal(0.0_f32), signal(0.0_f32));
    let reported = signal(String::from("none"));
    view()
        .child(
            view().w(px(200.0)).h(px(300.0)).child(
                v_resizable()
                    .on_resize(move |sizes: &Vec<Points>| reported.set(shown(sizes)))
                    .child(resizable_panel().child(content(a, Axis::Vertical)))
                    .child(resizable_panel().child(content(b, Axis::Vertical))),
            ),
        )
        .child(text(move || format!("Heights {} {}", a.get(), b.get())))
        .child(text(move || format!("Reported {}", reported.get())))
}

#[test]
fn a_vertical_group_shares_its_height_and_resizes_up_and_down() {
    let mut app = start::<Rows>();
    // Neither has a size: flex shares the height.
    app.wait_for("Heights 150 150").unwrap();
    app.drag("role:adjustable", point(px(0.0), px(50.0)))
        .unwrap();
    app.wait_for("Heights 200 100").unwrap();
    app.wait_for("Reported 200, 100").unwrap();
}

#[test]
fn a_panel_shown_again_comes_back_at_its_size() {
    let mut app = start::<Columns>();
    app.wait_for("Widths 150 250 0").unwrap();
    app.press("id:third").unwrap();
    app.wait_for("Widths 150 150 100").unwrap();
    app.drag("role:adjustable >> nth=1", point(px(-40.0), px(0.0)))
        .unwrap();
    app.wait_for("Widths 150 110 140").unwrap();
    app.press("id:third").unwrap();
    app.wait_for("Widths 150 250 0").unwrap();
    // The 140 the user gave it.
    app.press("id:third").unwrap();
    app.wait_for("Widths 150 110 140").unwrap();
}

/// A sidebar whose size the app owns, set from outside as well as by
/// drags (what `onResize` reports, passed back), fixed or not.
#[component]
fn Controlled() -> impl IntoElement {
    let (a, b) = (signal(0.0_f32), signal(0.0_f32));
    let size = signal(120.0_f32);
    let resizes = signal(0);
    view()
        .child(
            view().h(px(100.0)).child(
                h_resizable()
                    .on_resize(move |_: &Vec<Points>| resizes.set(resizes.get_untracked() + 1))
                    .child(
                        resizable_panel()
                            .size(move || Some(px(size.get())))
                            .fixed(true)
                            .on_resize(move |s: &Points| size.set(s.0))
                            .child(content(a, Axis::Horizontal)),
                    )
                    .child(resizable_panel().child(content(b, Axis::Horizontal))),
            ),
        )
        .child(text(move || format!("Widths {} {}", a.get(), b.get())))
        .child(text(move || format!("Resizes {}", resizes.get())))
        .child(
            view()
                .test_id("wider")
                .h(px(20.0))
                .on_press(move || size.set(250.0)),
        )
}

#[test]
fn a_new_size_from_the_app_resizes_the_panel_without_a_report() {
    let mut app = start::<Controlled>();
    app.wait_for("Widths 120 280").unwrap();
    app.press("id:wider").unwrap();
    app.wait_for("Widths 250 150").unwrap();
    assert!(app.shows("Resizes 0"));
    // A drag reports, and the size passed back changes nothing more.
    app.drag("role:adjustable", point(px(-50.0), px(0.0)))
        .unwrap();
    app.wait_for("Widths 200 200").unwrap();
    app.wait_for("Resizes 1").unwrap();
    // Fixed: the window growing goes to the other panel.
    app.set_viewport(Size::new(px(600.0), px(844.0))).unwrap();
    app.wait_for("Widths 200 400").unwrap();
}

/// A sidebar whose trailing edge is a `ResizeHandle`: its width follows
/// the drag's offset; the states the handle went through.
#[component]
fn Sidebar() -> impl IntoElement {
    let width = signal(200.0_f32);
    let from = stored(200.0_f32);
    let states = signal(Vec::<ResizeHandleState>::new());
    view()
        .child(
            view()
                .h(px(100.0))
                .w(move || px(width.get()))
                .overflow_hidden()
                .child(
                    resize_handle()
                        .edge(HandleEdge::Trailing)
                        .accessibility_label("Sidebar edge")
                        .on_drag_start(move || {
                            from.replace(width.get_untracked());
                        })
                        .on_drag_move(move |by: &Points| width.set(from.get() + by.0))
                        .on_state_change(move |state: &ResizeHandleState| {
                            states.update(|s| s.push(*state))
                        }),
                ),
        )
        .child(text(move || format!("Width {}", width.get())))
        .child(text(move || format!("States {:?}", states.get())))
}

#[test]
fn a_resize_handle_reports_the_drag_of_the_edge_it_hugs() {
    let mut app = start::<Sidebar>();
    app.wait_for("Width 200").unwrap();
    app.drag("label:Sidebar edge", point(px(40.0), px(0.0)))
        .unwrap();
    app.wait_for("Width 240").unwrap();
    app.wait_for("States [Pressed, Dragging, Idle]").unwrap();
    // Hugging the edge: the band is inside the sidebar, at its end.
    app.drag("label:Sidebar edge", point(px(-60.0), px(0.0)))
        .unwrap();
    app.wait_for("Width 180").unwrap();
}

/// Two panels without a size, of contents of different widths, in a
/// group 400 wide.
#[component]
fn Uneven() -> impl IntoElement {
    let (a, b) = (signal(0.0_f32), signal(0.0_f32));
    let wide = |width: Signal<f32>, content: f32| content_of(width).child(view().w(px(content)));
    view()
        .child(
            view().h(px(100.0)).child(
                h_resizable()
                    .child(resizable_panel().child(wide(a, 160.0)))
                    .child(resizable_panel().child(wide(b, 80.0))),
            ),
        )
        .child(text(move || format!("Widths {} {}", a.get(), b.get())))
}

/// [`content`] laid out as a row, for content of a width of its own.
fn content_of(width: Signal<f32>) -> View {
    content(width, Axis::Horizontal).flex_row()
}

#[test]
fn panels_without_a_size_share_evenly_whatever_their_content() {
    let mut app = start::<Uneven>();
    app.wait_for("Widths 200 200").unwrap();
}

#[test]
fn a_screen_reader_adjusts_a_handle_a_step_at_a_time() {
    use std::sync::{Arc, Mutex};

    use nsh_core::{AccessibilityRole, EventKind, EventPayload, MountItem, NodeId, PayloadValue};

    // The handle as the platform gets it: its node, actions and value.
    #[derive(Default)]
    struct Handle {
        id: Option<NodeId>,
        actions: Vec<String>,
        now: Option<f32>,
        min: Option<f32>,
        max: Option<f32>,
    }
    let seen = Arc::new(Mutex::new(Handle::default()));
    let mut app = start::<Columns>();
    {
        let seen = seen.clone();
        app.observe(move |_, batch| {
            for item in &batch.items {
                if let MountItem::ViewProps { id, props } = item
                    && props.accessibility.role == AccessibilityRole::Adjustable
                {
                    let mut seen = seen.lock().unwrap();
                    seen.id = Some(*id);
                    seen.actions = props
                        .accessibility
                        .actions
                        .iter()
                        .map(|a| a.name.to_string())
                        .collect();
                    let value = props.accessibility.value.as_ref();
                    seen.now = value.and_then(|v| v.now);
                    seen.min = value.and_then(|v| v.min);
                    seen.max = value.and_then(|v| v.max);
                }
            }
        });
    }
    app.wait_for("Widths 150 250 0").unwrap();
    let id = {
        let seen = seen.lock().unwrap();
        assert_eq!(seen.actions, ["increment", "decrement"]);
        assert_eq!(
            (seen.now, seen.min, seen.max),
            (Some(150.0), Some(100.0), Some(200.0))
        );
        seen.id.expect("the handle is mounted")
    };
    let act = |app: &mut Headless, name: &str| {
        let payload = EventPayload::Map(vec![("actionName", PayloadValue::Str(name.to_owned()))]);
        app.engine()
            .control()
            .dispatch_event(id, EventKind::AccessibilityAction, payload);
    };

    // A step of 10, reported as a drag's end.
    act(&mut app, "increment");
    app.wait_for("Widths 160 240 0").unwrap();
    app.wait_for("Reported 160, 240").unwrap();
    app.wait_for("Sidebar 160").unwrap();
    assert_eq!(seen.lock().unwrap().now, Some(160.0));

    act(&mut app, "decrement");
    act(&mut app, "decrement");
    app.wait_for("Widths 140 260 0").unwrap();
    app.wait_for("Reported 140, 260").unwrap();
}

/// Two panels of the default minimum (100) and a sized one in a group
/// 150 wide, too short for their minimums.
#[component]
fn Cramped() -> impl IntoElement {
    let (a, b) = (signal(0.0_f32), signal(0.0_f32));
    view()
        .child(
            view().w(px(150.0)).h(px(100.0)).child(
                h_resizable()
                    .child(
                        resizable_panel()
                            .size(px(120.0))
                            .child(content(a, Axis::Horizontal)),
                    )
                    .child(resizable_panel().child(content(b, Axis::Horizontal))),
            ),
        )
        .child(text(move || format!("Widths {} {}", a.get(), b.get())))
}

#[test]
fn panels_in_a_group_too_short_for_their_minimums_share_it() {
    let mut app = start::<Cramped>();
    // 200 of minimums in 150: each may go down to 75, and the sidebar
    // gives way to the other's.
    app.wait_for("Widths 75 75").unwrap();
}
