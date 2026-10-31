//! `RadioGroup`: one stop of the keyboard focus, at the checked radio (else
//! the first enabled one); the arrow keys move between the radios past
//! disabled ones, around the ends, and check the radio they reach. On
//! macOS, where Tab stops at views that take presses.

use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use nsh_base::{radio, radio_group};
use nsh_core::{MountItem, Size, element::Root, platform::Os, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

const PLANS: [&str; 4] = ["Free", "Plus", "Team", "Enterprise"];

fn start<C: Component<Props = ()>>() -> Headless {
    launch(Root::of::<C>())
}

fn launch(root: Root) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(root)
    };
    config.environment.os = Os::MacOs;
    let mut app = Headless::start(config).unwrap();
    app.first_render().unwrap();
    app
}

/// Four plans, the third disabled, none checked at first; a button after
/// the group. The texts say which plan is checked, how many changes the
/// radios reported, and whether the button was pressed.
#[component]
fn Plans() -> impl IntoElement {
    let plan = signal(None::<usize>);
    let changes = signal(0u32);
    let after = signal(false);
    let option = move |i: usize| {
        radio()
            .checked(move || plan.get() == Some(i))
            .disabled(i == 2)
            .on_change(move |checked: &bool| {
                assert!(*checked, "a radio asks to be checked");
                changes.update(|n| *n += 1);
                plan.set(Some(i));
            })
            .child(text(PLANS[i]))
    };
    view()
        .child(
            radio_group()
                .child(option(0))
                .child(option(1))
                .child(option(2))
                .child(option(3)),
        )
        .child(
            view()
                .on_press(move || after.set(true))
                .child(text("Continue")),
        )
        .child(text(move || {
            format!("plan:{}", plan.get().map_or("none", |i| PLANS[i]))
        }))
        .child(text(move || format!("changes:{}", changes.get())))
        .child(text(move || format!("after:{}", after.get())))
}

#[test]
fn with_none_checked_tab_enters_at_the_first_radio_and_space_checks_it() {
    let mut app = start::<Plans>();
    app.press_key("tab").unwrap();
    app.press_key("space").unwrap();
    app.wait_for("text:plan:Free").unwrap();
    app.wait_for("text:changes:1").unwrap();
    // A checked radio reports nothing.
    app.press_key("space").unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    app.wait_for("text:changes:1").unwrap();
}

#[test]
fn arrows_move_and_check_wrapping_and_skipping_disabled_radios() {
    let mut app = start::<Plans>();
    app.press_key("tab").unwrap();
    app.press_key("down").unwrap();
    app.wait_for("text:plan:Plus").unwrap();
    // Team is disabled: Down goes on to Enterprise.
    app.press_key("down").unwrap();
    app.wait_for("text:plan:Enterprise").unwrap();
    // Past the end, around to the first.
    app.press_key("right").unwrap();
    app.wait_for("text:plan:Free").unwrap();
    app.press_key("up").unwrap();
    app.wait_for("text:plan:Enterprise").unwrap();
    app.press_key("left").unwrap();
    app.wait_for("text:plan:Plus").unwrap();
    app.wait_for("text:changes:5").unwrap();
}

#[test]
fn the_group_is_one_stop_at_the_checked_radio() {
    let mut app = start::<Plans>();
    app.press_key("tab").unwrap();
    app.press_key("down").unwrap();
    app.press_key("down").unwrap();
    app.wait_for("text:plan:Enterprise").unwrap();
    // One Tab leaves the group, whatever radio the focus is on.
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:after:true").unwrap();
    // Shift+Tab comes back to the checked radio: Down from there wraps.
    app.press_key("shift+tab").unwrap();
    app.press_key("down").unwrap();
    app.wait_for("text:plan:Free").unwrap();
}

#[derive(Clone, PartialEq, Props)]
struct BoxProps {
    children: Prop<Children>,
}

/// A view of the app's own around some radios: they render after the
/// group's other children.
#[component]
fn Boxed(props: BoxProps) -> impl IntoElement {
    view().child(props.children)
}

/// The plans, the first two inside a component of the app's.
#[component]
fn BoxedPlans() -> impl IntoElement {
    let plan = signal(None::<usize>);
    let option = move |i: usize| {
        radio()
            .checked(move || plan.get() == Some(i))
            .on_change(move |_: &bool| plan.set(Some(i)))
            .child(text(PLANS[i]))
    };
    view()
        .child(
            radio_group()
                .child(boxed().child(option(0)).child(option(1)))
                .child(option(2))
                .child(option(3)),
        )
        .child(text(move || {
            format!("plan:{}", plan.get().map_or("none", |i| PLANS[i]))
        }))
}

#[test]
fn the_radios_are_in_the_order_of_the_tree_wherever_they_render() {
    let mut app = start::<BoxedPlans>();
    // The first radio of the tree, though Team and Enterprise rendered
    // first.
    app.press_key("tab").unwrap();
    app.press_key("space").unwrap();
    app.wait_for("text:plan:Free").unwrap();
    for name in ["Plus", "Team", "Enterprise", "Free"] {
        app.press_key("down").unwrap();
        app.wait_for(&format!("text:plan:{name}")).unwrap();
    }
}

#[derive(Clone, PartialEq, Props)]
struct ManyProps {
    count: usize,
}

/// A group of `count` radios.
#[component]
fn ManyRadios(props: ManyProps) -> impl IntoElement {
    let checked = signal(0usize);
    view()
        .child(radio_group().children((0..props.count).map(move |i| {
            radio()
                .checked(move || checked.get() == i)
                .on_change(move |_: &bool| checked.set(i))
                .child(text(format!("{i}")))
        })))
        .child(text(move || format!("checked:{}", checked.get())))
}

/// The mount items one Down sends in a group of `count` radios, and
/// whether any made or removed a view.
fn items_per_key(count: usize) -> (usize, usize) {
    let mut app = launch(Root::new::<ManyRadios>(move || ManyProps { count }));
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
    app.press_key("down").unwrap();
    app.wait_for("text:checked:1").unwrap();
    app.idle(Duration::from_millis(50)).unwrap();
    items.store(0, Ordering::Relaxed);
    made.store(0, Ordering::Relaxed);
    app.press_key("down").unwrap();
    app.wait_for("text:checked:2").unwrap();
    app.idle(Duration::from_millis(50)).unwrap();
    (items.load(Ordering::Relaxed), made.load(Ordering::Relaxed))
}

#[test]
fn an_arrow_changes_the_radio_left_and_the_radio_reached_only() {
    let (few, made) = items_per_key(3);
    let (many, _) = items_per_key(40);
    println!("one Down: {few} mount items among 3 radios, {many} among 40");
    assert_eq!(made, 0, "an arrow makes no view");
    assert_eq!(
        few, many,
        "the cost of an arrow does not grow with the radios"
    );
}
