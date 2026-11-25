//! A toast's announcement: read once as it shows, however often the app
//! rebuilds it under another parent (a stack drawn in the topmost modal
//! while one is open), and every new toast read, whatever its status and
//! label.

use nsh_base::{ToastTransitionStatus, toast};
use nsh_core::{Command, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// A toast: its id, label and status (`None`: a toast without
/// `transitionStatus`).
type Shown = (u32, &'static str, Option<ToastTransitionStatus>);

#[component]
fn App() -> impl IntoElement {
    let in_modal = signal(false);
    let shown = signal(Vec::<Shown>::new());
    let next = stored(0u32);
    let add = move |label: &'static str, status: Option<ToastTransitionStatus>| {
        let id = next.with(|n| *n);
        next.replace(id + 1);
        shown.update(|s| s.push((id, label, status)));
    };
    // The toasts, under the parent of the layer that draws them. The root
    // layer's binding runs first, so the root's toasts are taken down
    // before the modal's are made, and made before the modal's are taken
    // down: a move each way is either order.
    let layer = move |modal: bool| {
        when(
            move || in_modal.get() == modal,
            move || {
                view()
                    .child(text(if modal { "Modal layer" } else { "Root layer" }))
                    .child(each(
                        move || shown.get(),
                        |(id, _, _): &Shown| *id,
                        |item: ReadSignal<Shown>, _| {
                            let toast = toast()
                                .accessibility_label(move || Some(item.get().1.into()))
                                .child(text(move || item.get().1));
                            match item.get_untracked().2 {
                                Some(_) => toast
                                    .transition_status(move || item.get().2.unwrap_or_default()),
                                None => toast,
                            }
                        },
                    ))
            },
        )
    };
    let button =
        |label: &'static str, press: Box<dyn Fn()>| view().on_press(press).child(text(label));
    let starting = Some(ToastTransitionStatus::Starting);
    view()
        .child(button(
            "Move",
            Box::new(move || in_modal.update(|m| *m = !*m)),
        ))
        .child(button(
            "Present",
            Box::new(move || {
                shown.update(|s| {
                    for t in s.iter_mut().filter(|t| t.2.is_some()) {
                        t.2 = Some(ToastTransitionStatus::Present);
                    }
                })
            }),
        ))
        .child(button("Add", Box::new(move || add("Saved", starting))))
        .child(button("Add bare", Box::new(move || add("Saved", None))))
        .child(button(
            "Add present",
            Box::new(move || add("Saved", Some(ToastTransitionStatus::Present))),
        ))
        .child(button(
            "Other",
            Box::new(move || add("Not saved", starting)),
        ))
        .child(button(
            "Move and add",
            Box::new(move || {
                batch(|| {
                    in_modal.update(|m| *m = !*m);
                    add("Saved", starting);
                })
            }),
        ))
        .child(layer(false))
        .child(layer(true))
}

fn start() -> Headless {
    let mut app = Headless::start(EngineConfig::new(nsh_testing::windowed_root::<App>())).unwrap();
    app.wait_for("Root layer").unwrap();
    app
}

/// What was announced so far, once the app settled.
fn announced(app: &mut Headless) -> Vec<String> {
    app.settle();
    app.screen()
        .commands()
        .iter()
        .filter_map(|(_, c)| match c {
            Command::Announce(text) => Some(text.clone()),
            _ => None,
        })
        .collect()
}

/// Moves the stack to the other layer and waits for it there.
fn move_stack(app: &mut Headless, to: &str) {
    app.press("Move").unwrap();
    app.wait_for(to).unwrap();
}

#[test]
fn a_toast_moved_to_another_parent_is_announced_once() {
    let mut app = start();
    app.press("Add").unwrap();
    assert_eq!(announced(&mut app), ["Saved"]);
    // Moved while it enters, each way.
    move_stack(&mut app, "Modal layer");
    assert_eq!(announced(&mut app), ["Saved"], "moved into the modal");
    move_stack(&mut app, "Root layer");
    assert_eq!(announced(&mut app), ["Saved"], "moved back");
    // Moved once it is present, each way.
    app.press("Present").unwrap();
    move_stack(&mut app, "Modal layer");
    move_stack(&mut app, "Root layer");
    assert_eq!(announced(&mut app), ["Saved"], "moved once present");
    // A new toast is read, one with the same words too.
    app.press("Add").unwrap();
    app.press("Other").unwrap();
    assert_eq!(announced(&mut app), ["Saved", "Saved", "Not saved"]);
    // Two with the same words moved together: neither is read again.
    move_stack(&mut app, "Modal layer");
    assert_eq!(announced(&mut app), ["Saved", "Saved", "Not saved"]);
}

#[test]
fn a_toast_added_as_the_stack_moves_is_announced() {
    let mut app = start();
    app.press("Add").unwrap();
    // The toast moves and a new one with its words comes in one update:
    // the new one is read, the moved one is not.
    app.press("Move and add").unwrap();
    app.wait_for("Modal layer").unwrap();
    assert_eq!(announced(&mut app), ["Saved", "Saved"]);
}

#[test]
fn a_toast_first_shown_present_is_announced() {
    // A toast shown first past its entrance (held back by a stack's limit,
    // in a stack mounted after the push, or with the app's own status) is
    // read as it shows.
    let mut app = start();
    app.press("Add present").unwrap();
    assert_eq!(announced(&mut app), ["Saved"]);
    move_stack(&mut app, "Modal layer");
    assert_eq!(announced(&mut app), ["Saved"]);
}

#[test]
fn toasts_without_a_status_with_the_same_label_are_each_announced() {
    let mut app = start();
    app.press("Add bare").unwrap();
    app.press("Add bare").unwrap();
    assert_eq!(announced(&mut app), ["Saved", "Saved"]);
    move_stack(&mut app, "Modal layer");
    assert_eq!(announced(&mut app), ["Saved", "Saved"]);
}

#[test]
fn a_new_toast_with_the_same_label_is_announced_while_one_enters() {
    let mut app = start();
    app.press("Add").unwrap();
    app.press("Add").unwrap();
    assert_eq!(announced(&mut app), ["Saved", "Saved"]);
}
