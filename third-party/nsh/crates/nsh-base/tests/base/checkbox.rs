//! `Checkbox`: `hitSlop` widens where presses count past its bounds, as a
//! view's does: the platforms get it on the checkbox's pressable view, it
//! follows a binding, and a checkbox without one gets none.

use std::sync::{Arc, Mutex};

use nsh_base::checkbox;
use nsh_core::{EdgeInsets, MountBatch, MountItem, NodeId, Size, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// Every batch's items.
type Seen = Arc<Mutex<Vec<MountItem>>>;

fn start<C: Component<Props = ()>>() -> (Headless, Seen) {
    let config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(nsh_testing::windowed_root::<C>())
    };
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

fn target(app: &Headless, selector: &str) -> NodeId {
    app.screen()
        .press_target(selector)
        .unwrap()
        .unwrap_or_else(|| panic!("no pressable {selector}"))
}

/// A small checkbox with a slop on every side, a checkbox whose slop the
/// app widens, and a checkbox with none.
#[component]
fn SmallCheckboxes() -> impl IntoElement {
    let changes = signal(0u32);
    let wide = signal(false);
    view()
        .child(
            checkbox()
                .hit_slop(EdgeInsets::all(px(12.0)))
                .accessibility_label("Agree")
                .on_change(move |_: &bool| changes.update(|n| *n += 1))
                // Laid out to a size, as a view with no area takes no
                // presses.
                .child(text("Agree")),
        )
        .child(
            checkbox()
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
            checkbox()
                .on_change(move |_: &bool| wide.set(true))
                .child(text("Widen")),
        )
        .child(text(move || format!("changes:{}", changes.get())))
}

#[test]
fn hit_slop_reaches_the_pressable_view() {
    let (mut app, seen) = start::<SmallCheckboxes>();
    let small = target(&app, "label:Agree");
    assert_eq!(hit_slop(&seen, small), EdgeInsets::all(px(12.0)));
    // The slop changes nothing of what a press does.
    app.press("label:Agree").unwrap();
    app.wait_for("text:changes:1").unwrap();
}

#[test]
fn hit_slop_follows_a_binding_and_is_none_by_default() {
    let (mut app, seen) = start::<SmallCheckboxes>();
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
    // A checkbox without `hitSlop` never gets one.
    assert_eq!(hit_slop(&seen, widen), EdgeInsets::default());
}

/// A required checkbox with an error line apart from it: the error shows
/// once the app's check fails.
#[component]
fn RequiredCheckbox() -> impl IntoElement {
    let error = signal(false);
    let error_line = element_ref();
    view()
        .child(
            checkbox()
                .accessibility_label("Accept terms")
                .invalid(Prop::bind(move || error.get()))
                .accessibility_described_by(error_line)
                .child(text("Accept")),
        )
        .child(
            text(move || match error.get() {
                true => "You must accept the terms.",
                false => "",
            })
            .element_ref(&error_line),
        )
        .child(
            view()
                .on_press(move |_: &()| error.set(true))
                .child(text("Submit")),
        )
}

#[test]
fn invalid_and_its_error_line_reach_the_checkbox_screen_readers_focus() {
    let (mut app, _seen) = start::<RequiredCheckbox>();
    let screen = app.screen();
    assert!(
        !screen
            .accessibility_state("label:Accept terms")
            .unwrap()
            .invalid
    );
    let described = screen
        .accessibility_described_by("label:Accept terms")
        .unwrap();
    assert!(described.is_some(), "the error line describes the checkbox");
    app.press("text:Submit").unwrap();
    app.wait_for("text:You must accept the terms.").unwrap();
    let screen = app.screen();
    let state = screen.accessibility_state("label:Accept terms").unwrap();
    assert!(
        state.invalid,
        "screen readers hear it is invalid on the checkbox itself"
    );
    assert!(state.checked.is_some(), "and its value stays");
    assert_eq!(
        screen
            .accessibility_description("label:Accept terms")
            .unwrap()
            .as_deref(),
        Some("You must accept the terms."),
        "each time it is reached, after its name"
    );
}
