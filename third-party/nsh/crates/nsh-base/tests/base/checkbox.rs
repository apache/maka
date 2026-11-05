//! `Checkbox`: `hitSlop` widens where presses count past its bounds, as a
//! view's does: the platforms get it on the checkbox's pressable view, it
//! follows a binding, and a checkbox without one gets none.

use std::sync::{Arc, Mutex};

use nsh_base::checkbox;
use nsh_core::{EdgeInsets, MountBatch, MountItem, NodeId, Size, element::Root, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// Every batch's items.
type Seen = Arc<Mutex<Vec<MountItem>>>;

fn start<C: Component<Props = ()>>() -> (Headless, Seen) {
    let config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::of::<C>())
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
