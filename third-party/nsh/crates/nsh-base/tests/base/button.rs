//! `Button`: `hitSlop` widens where presses count past its bounds, as a
//! view's does: the platforms get it on the button's pressable view, it
//! follows a binding, and a button without one gets none. The mouse over
//! it reaches the view that placed it, as over any component.

use std::sync::{Arc, Mutex};

use nsh_base::button;
use nsh_core::{
    EdgeInsets, MountBatch, MountItem, NodeId, Size, element::Root, platform::Os, prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// Every batch's items.
type Seen = Arc<Mutex<Vec<MountItem>>>;

fn start<C: Component<Props = ()>>() -> (Headless, Seen) {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::of::<C>())
    };
    // A desktop: the mouse hovers.
    config.environment.os = Os::MacOs;
    let mut app = Headless::start(config).unwrap();
    let seen = Seen::default();
    let log = seen.clone();
    app.observe(move |_: &str, batch: &MountBatch| {
        log.lock().unwrap().extend(batch.items.iter().cloned());
    });
    app.first_render().unwrap();
    (app, seen)
}

/// The hit slop the platforms last got for view `id` (none: zero).
fn hit_slop(seen: &Seen, id: NodeId) -> EdgeInsets {
    seen.lock()
        .unwrap()
        .iter()
        .filter_map(|item| match item {
            MountItem::ViewProps { id: of, props } if *of == id => Some(props.hit_slop),
            _ => None,
        })
        .next_back()
        .unwrap_or_default()
}

/// A small close button with a slop on every side, a button whose slop the
/// app widens, and a button with none.
#[component]
fn Buttons() -> impl IntoElement {
    let presses = signal(0u32);
    let wide = signal(false);
    view()
        .child(
            button()
                .hit_slop(EdgeInsets::all(px(12.0)))
                .accessibility_label("Close")
                .on_press(move || presses.update(|n| *n += 1))
                .child(text("×")),
        )
        .child(
            button()
                .hit_slop(Prop::bind(move || match wide.get() {
                    true => EdgeInsets {
                        top: px(4.0),
                        left: px(2.0),
                        ..EdgeInsets::default()
                    },
                    false => EdgeInsets::default(),
                }))
                .child(text("Grows")),
        )
        .child(
            button()
                .on_press(move || wide.set(true))
                .child(text("Widen")),
        )
        .child(text(move || format!("presses:{}", presses.get())))
}

fn target(app: &Headless, selector: &str) -> NodeId {
    app.screen()
        .press_target(selector)
        .unwrap()
        .unwrap_or_else(|| panic!("no pressable {selector}"))
}

#[test]
fn hit_slop_reaches_the_pressable_view() {
    let (mut app, seen) = start::<Buttons>();
    let close = target(&app, "label:Close");
    assert_eq!(hit_slop(&seen, close), EdgeInsets::all(px(12.0)));
    // The slop changes nothing of what a press does.
    app.press("label:Close").unwrap();
    app.wait_for("text:presses:1").unwrap();
}

#[test]
fn hit_slop_follows_a_binding_and_is_none_by_default() {
    let (mut app, seen) = start::<Buttons>();
    let grows = target(&app, "text:Grows");
    let widen = target(&app, "text:Widen");
    assert_eq!(hit_slop(&seen, grows), EdgeInsets::default());
    app.press("text:Widen").unwrap();
    let expected = EdgeInsets {
        top: px(4.0),
        left: px(2.0),
        ..EdgeInsets::default()
    };
    assert_eq!(hit_slop(&seen, grows), expected);
    // A button without `hitSlop` never gets one.
    assert_eq!(hit_slop(&seen, widen), EdgeInsets::default());
}

/// Two buttons whose mouse the view placing them hears, each with where
/// it is in the button and in the root view; the text logs it in order.
#[component]
fn Hovered() -> impl IntoElement {
    let log = signal(Vec::<String>::new());
    let say = move |s: String| log.update(|l| l.push(s));
    let reporting = move |name: &'static str| {
        button()
            .on_mouse_enter(move |e: &MouseEvent| {
                say(format!(
                    "{name} enter {},{}",
                    e.position.y.0, e.page_position.y.0
                ))
            })
            .on_mouse_move(move |e: &MouseEvent| say(format!("{name} move {}", e.position.y.0)))
            .on_mouse_leave(move |_: &MouseEvent| say(format!("{name} leave")))
            .child(text(name))
    };
    view()
        .child(reporting("A"))
        .child(reporting("B"))
        .child(text(move || log.with(|l| format!("log:{}", l.join(";")))))
}

#[test]
fn the_view_placing_it_hears_the_mouse_come_move_and_leave() {
    let (mut app, _) = start::<Hovered>();
    app.hover("text:A").unwrap();
    app.wait_for("text:log:A enter 8.5,8.5;A move 8.5").unwrap();
    app.hover("text:B").unwrap();
    app.wait_for("text:log:A enter 8.5,8.5;A move 8.5;A leave;B enter 8.5,25.5;B move 8.5")
        .unwrap();
}
