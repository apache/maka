//! `Toolbar`, `ToolbarGroup` and `ToolbarSeparator`: a toolbar is one stop
//! of the keyboard focus over its `Button`s, `Toggle`s and `Link`s (in its
//! groups and in a `ToggleGroup` inside it too), at the item the focus last
//! left, else the first enabled one; its axis's arrows, Home and End move
//! the focus past disabled items, around the ends, pressing nothing; a
//! `ToggleGroup` inside it is a group of it; `disabled` disables every
//! item; what a popup an item opens shows is no part of it; a key press
//! changes the item left and the item reached, however many items there
//! are. On macOS, where Tab stops at views that take presses.

use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use nsh_base::{
    LinkOpenWith, PopoverEvent, button, link, popover, toggle, toggle_group, toolbar,
    toolbar_group, toolbar_separator,
};
use nsh_core::{Checked, MountItem, Size, element::Root, geometry::Axis, platform::Os, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

fn launch(root: Root) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(844.0)),
        ..EngineConfig::new(root)
    };
    config.environment.os = Os::MacOs;
    let mut app = Headless::start(config).unwrap();
    app.first_render().unwrap();
    app
}

fn start<C: Component<Props = ()>>() -> Headless {
    launch(Root::of::<C>())
}

/// Presses the item the keyboard focus is on (Space) and waits for the
/// text saying `name` was pressed last.
fn press_focused(app: &mut Headless, name: &str) {
    app.press_key("space").unwrap();
    app.wait_for(&format!("text:pressed:{name}")).unwrap();
}

/// A text editor's formatting bar between two buttons: a history group
/// (Undo, Redo disabled), a separator, a toggle group of marks (Italic
/// pressed), an alignment group of toggles (exactly one pressed), and a
/// help link. A switch disables the whole toolbar, another the marks. The
/// texts say what was pressed last, how many presses there were, and the
/// pressed marks and alignment.
#[component]
fn Formatting() -> impl IntoElement {
    let pressed = signal(SharedString::from("none"));
    let presses = signal(0u32);
    let marks = signal([false, true]);
    let align = signal(0usize);
    let locked = signal(false);
    let marks_locked = signal(false);
    let note = move |name: &'static str| {
        move || {
            pressed.set(name.into());
            presses.update(|n| *n += 1);
        }
    };
    let command = move |name: &'static str, disabled: bool| {
        button()
            .disabled(disabled)
            .accessibility_label(name)
            .on_press(note(name))
            .child(text(&name[..1]))
    };
    let mark = move |i: usize, name: &'static str| {
        toggle()
            .pressed(move || marks.get()[i])
            .accessibility_label(name)
            .on_change(move |next: &bool| {
                marks.update(|m| m[i] = *next);
                note(name)();
            })
            .child(text(&name[..1]))
    };
    let alignment = move |i: usize, name: &'static str| {
        toggle()
            .pressed(move || align.get() == i)
            .accessibility_label(name)
            .on_change(move |next: &bool| {
                if *next {
                    align.set(i);
                }
                note(name)();
            })
            .child(text(&name[..1]))
    };
    view()
        .child(command("Before", false))
        .child(
            toolbar()
                .accessibility_label("Formatting")
                .disabled(move || locked.get())
                .child(
                    toolbar_group()
                        .accessibility_label("History")
                        .child(command("Undo", false))
                        .child(command("Redo", true)),
                )
                .child(toolbar_separator())
                .child(
                    toggle_group()
                        .disabled(move || marks_locked.get())
                        .child(mark(0, "Bold"))
                        .child(mark(1, "Italic")),
                )
                .child(toolbar_separator())
                .child(
                    toolbar_group()
                        .accessibility_label("Alignment")
                        .child(alignment(0, "Left"))
                        .child(alignment(1, "Center"))
                        .child(alignment(2, "Right")),
                )
                .child(
                    link()
                        .href("/help")
                        .open_with(LinkOpenWith::App)
                        .on_press(note("Help"))
                        .child(text("Help")),
                ),
        )
        .child(command("After", false))
        .child(
            view()
                .on_press(move || locked.update(|l| *l = !*l))
                .child(text("Lock")),
        )
        .child(
            view()
                .on_press(move || marks_locked.update(|l| *l = !*l))
                .child(text("Lock marks")),
        )
        .child(text(move || format!("pressed:{}", pressed.get())))
        .child(text(move || format!("presses:{}", presses.get())))
        .child(text(move || {
            let m = marks.get();
            format!(
                "marks:{}{}",
                if m[0] { "B" } else { "-" },
                if m[1] { "I" } else { "-" }
            )
        }))
        .child(text(move || format!("align:{}", align.get())))
}

/// Tab from Before into the toolbar.
fn enter(app: &mut Headless) {
    app.press_key("tab").unwrap();
    app.press_key("tab").unwrap();
}

#[test]
fn the_toolbar_is_a_labelled_toolbar_of_groups_buttons_toggles_and_a_link() {
    let app = start::<Formatting>();
    let screen = app.screen();
    // One toolbar: the toggle group inside it is a group of it.
    assert_eq!(screen.count("role:toolbar"), Ok(1));
    assert_eq!(screen.count("role:toolbar[Formatting]"), Ok(1));
    assert_eq!(screen.count("role:group"), Ok(3));
    assert_eq!(screen.count("role:group[History]"), Ok(1));
    assert_eq!(screen.count("role:group[Alignment]"), Ok(1));
    // Undo, Redo, the marks and the alignments: buttons; the toggles keep
    // their pressed state.
    assert_eq!(screen.count("role:toolbar >> role:button"), Ok(7));
    assert_eq!(screen.count("role:toolbar >> role:link"), Ok(1));
    assert_eq!(
        screen
            .accessibility_state("role:button[Italic]")
            .unwrap()
            .pressed,
        Some(Checked::True)
    );
    assert!(!screen.enabled("role:button[Redo]").unwrap());
}

#[test]
fn tab_enters_at_the_first_enabled_item_and_leaves_in_one_step() {
    let mut app = start::<Formatting>();
    enter(&mut app);
    // The first item, not the pressed toggle.
    press_focused(&mut app, "Undo");
    // One Tab leaves the toolbar, whatever item the focus is on.
    app.press_key("right").unwrap();
    app.press_key("tab").unwrap();
    press_focused(&mut app, "After");
}

#[test]
fn right_and_left_move_along_a_row_past_disabled_items_and_around_the_ends() {
    let mut app = start::<Formatting>();
    enter(&mut app);
    // Undo → Bold: Redo is disabled; the toggle group's toggles are the
    // toolbar's items. Moving presses nothing.
    app.press_key("right").unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    app.wait_for("text:presses:0").unwrap();
    press_focused(&mut app, "Bold");
    app.wait_for("text:marks:BI").unwrap();
    for name in ["Italic", "Left", "Center", "Right", "Help"] {
        app.press_key("right").unwrap();
        press_focused(&mut app, name);
    }
    // Past the end, around to Undo; Left back around to Help.
    app.press_key("right").unwrap();
    press_focused(&mut app, "Undo");
    app.press_key("left").unwrap();
    press_focused(&mut app, "Help");
}

#[test]
fn up_and_down_are_left_to_the_items_of_a_row() {
    let mut app = start::<Formatting>();
    enter(&mut app);
    app.press_key("down").unwrap();
    app.press_key("up").unwrap();
    app.press_key("down").unwrap();
    press_focused(&mut app, "Undo");
}

#[test]
fn home_and_end_go_to_the_first_and_last_enabled_item() {
    let mut app = start::<Formatting>();
    enter(&mut app);
    app.press_key("end").unwrap();
    press_focused(&mut app, "Help");
    app.press_key("home").unwrap();
    press_focused(&mut app, "Undo");
}

#[test]
fn tab_comes_back_to_the_item_the_focus_left() {
    let mut app = start::<Formatting>();
    enter(&mut app);
    app.press_key("end").unwrap();
    app.press_key("left").unwrap();
    // Right, then out and back in.
    app.press_key("tab").unwrap();
    app.press_key("shift+tab").unwrap();
    press_focused(&mut app, "Right");
}

#[test]
fn a_disabled_toolbar_disables_every_item_and_is_no_stop() {
    let mut app = start::<Formatting>();
    app.press("text:Lock").unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    for item in ["Undo", "Bold", "Center"] {
        assert!(
            !app.screen()
                .enabled(&format!("role:button[{item}]"))
                .unwrap()
        );
    }
    assert!(!app.screen().enabled("role:link").unwrap());
    // Before, then past the toolbar to After.
    enter(&mut app);
    press_focused(&mut app, "After");
    // Enabled again, its items take presses.
    app.press("text:Lock").unwrap();
    app.press("role:button[Center]").unwrap();
    app.wait_for("text:align:1").unwrap();
}

#[test]
fn a_disabled_toggle_group_inside_disables_only_its_toggles() {
    let mut app = start::<Formatting>();
    app.press("text:Lock marks").unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    assert!(!app.screen().enabled("role:button[Bold]").unwrap());
    assert!(app.screen().enabled("role:button[Left]").unwrap());
    // Undo → Left: the marks are skipped.
    enter(&mut app);
    app.press_key("right").unwrap();
    press_focused(&mut app, "Left");
}

/// A vertical palette of tools: Select, Pen (disabled), Shape, Text.
#[component]
fn Palette() -> impl IntoElement {
    let pressed = signal(SharedString::from("none"));
    let tool = move |name: &'static str, disabled: bool| {
        button()
            .disabled(disabled)
            .accessibility_label(name)
            .on_press(move || pressed.set(name.into()))
            .child(text(&name[..1]))
    };
    view()
        .child(
            toolbar()
                .axis(Axis::Vertical)
                .accessibility_label("Tools")
                .child(tool("Select", false))
                .child(tool("Pen", true))
                .child(tool("Shape", false))
                .child(tool("Text", false)),
        )
        .child(text(move || format!("pressed:{}", pressed.get())))
}

#[test]
fn down_and_up_move_along_a_column_and_left_and_right_are_left_to_the_items() {
    let mut app = start::<Palette>();
    app.press_key("tab").unwrap();
    press_focused(&mut app, "Select");
    // Select → Shape: Pen is disabled.
    app.press_key("down").unwrap();
    press_focused(&mut app, "Shape");
    app.press_key("right").unwrap();
    app.press_key("left").unwrap();
    app.press_key("right").unwrap();
    press_focused(&mut app, "Shape");
    app.press_key("down").unwrap();
    press_focused(&mut app, "Text");
    // Around the end, and back.
    app.press_key("down").unwrap();
    press_focused(&mut app, "Select");
    app.press_key("up").unwrap();
    press_focused(&mut app, "Text");
    app.press_key("home").unwrap();
    press_focused(&mut app, "Select");
    app.press_key("end").unwrap();
    press_focused(&mut app, "Text");
}

/// A toolbar whose first item is a popover's trigger (a view the popover
/// gives its presses, as popups' triggers are; held open by the app) with a
/// button in it, then Bold; a button after the toolbar. The text lists
/// every item Return pressed, sorted.
#[component]
fn WithPopover() -> impl IntoElement {
    let reached = signal(Vec::<&'static str>::new());
    let note = move |name: &'static str| {
        move || {
            reached.update(|r| {
                if !r.contains(&name) {
                    r.push(name);
                    r.sort_unstable();
                }
            })
        }
    };
    view()
        .child(
            toolbar()
                .child(
                    popover()
                        .open(Some(true))
                        .on_open_change(move |e: &PopoverEvent| {
                            if let PopoverEvent::OpenChange(..) = e {
                                note("More")();
                            }
                        })
                        .trigger(view().child(text("More")))
                        .child(button().on_press(note("Apply")).child(text("Apply"))),
                )
                .child(
                    button()
                        .accessibility_label("Bold")
                        .on_press(note("Bold"))
                        .child(text("Bold")),
                ),
        )
        .child(button().on_press(note("After")).child(text("After")))
        .child(text(move || format!("reached:{}", reached.get().join(","))))
}

#[test]
fn what_a_popup_of_an_item_shows_is_no_part_of_the_toolbar() {
    let mut app = start::<WithPopover>();
    app.wait_for("Apply").unwrap();
    // Three stops, whatever their order: the toolbar (at the trigger, its
    // first item), the popover's button and After. Had Apply joined the
    // toolbar, Tab would never reach it.
    for _ in 0..3 {
        app.press_key("tab").unwrap();
        app.press_key("enter").unwrap();
    }
    app.wait_for("text:reached:After,Apply,More").unwrap();
}

#[test]
fn a_popups_trigger_is_an_item_of_the_toolbar() {
    let mut app = start::<WithPopover>();
    app.wait_for("Apply").unwrap();
    // The trigger is the stop; Right reaches Bold, Left comes back, and
    // Return on the trigger presses it (the popover asks to close).
    app.press_key("tab").unwrap();
    app.press_key("right").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:reached:Bold").unwrap();
    app.press_key("left").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:reached:Bold,More").unwrap();
}

/// A toolbar of three buttons the app keeps in a keyed list, and a view
/// that reverses it.
#[component]
fn Reordered() -> impl IntoElement {
    let names = signal(vec!["A", "B", "C"]);
    let pressed = signal("none");
    view()
        .child(toolbar().child(each(
            move || names.get(),
            |name| *name,
            move |name, _| {
                let name = name.get_untracked();
                button()
                    .accessibility_label(name)
                    .on_press(move || pressed.set(name))
                    .child(text(name))
            },
        )))
        .child(
            view()
                .on_press(move || names.update(|n| n.reverse()))
                .child(text("Reverse")),
        )
        .child(text(move || format!("pressed:{}", pressed.get())))
}

#[test]
fn the_items_follow_the_app_reordering_them() {
    let mut app = start::<Reordered>();
    app.press("text:Reverse").unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    // C first now: Tab enters there, Right reaches B.
    app.press_key("tab").unwrap();
    press_focused(&mut app, "C");
    app.press_key("right").unwrap();
    press_focused(&mut app, "B");
    app.press_key("end").unwrap();
    press_focused(&mut app, "A");
}

#[derive(Clone, PartialEq, Props)]
struct ManyProps {
    count: usize,
}

/// A toolbar of `count` buttons.
#[component]
fn Many(props: ManyProps) -> impl IntoElement {
    let pressed = signal(0usize);
    toolbar()
        .children((0..props.count).map(move |i| {
            button()
                .accessibility_label(format!("Item {i}"))
                .on_press(move || pressed.set(i))
                .child(text(format!("{i}")))
        }))
        .child(text(move || format!("pressed:{}", pressed.get())))
}

/// The mount items one Right sends in a toolbar of `count` buttons.
fn items_per_key(count: usize) -> usize {
    let mut app = launch(Root::new::<Many>(move || ManyProps { count }));
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
    app.idle(Duration::from_millis(50)).unwrap();
    items.store(0, Ordering::Relaxed);
    app.press_key("right").unwrap();
    app.idle(Duration::from_millis(50)).unwrap();
    let sent = items.load(Ordering::Relaxed);
    app.press_key("space").unwrap();
    app.wait_for("text:pressed:2").unwrap();
    assert_eq!(made.load(Ordering::Relaxed), 0, "a key press makes no view");
    sent
}

#[test]
fn a_key_press_changes_the_item_left_and_the_item_reached_only() {
    let few = items_per_key(3);
    let many = items_per_key(40);
    println!("one Right: {few} mount items among 3 buttons, {many} among 40");
    assert_eq!(
        few, many,
        "the cost of a key press does not grow with the items"
    );
    // The `focusable` of the item left and of the item reached, and the
    // command that focuses the second.
    assert!(few <= 3, "{few} mount items");
}
