//! `Dialog`: screen readers hear what it is and what it is called. The
//! dialog is a dialog for assistive technologies unless the app gives it
//! another role (an alert dialog, which asks the user to confirm
//! something), and its `label` names it; its description is what it is
//! about (an alert dialog's message), read after the name.

use nsh_base::{button, dialog};
use nsh_core::{Size, element::Root, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

fn start<C: Component<Props = ()>>() -> Headless {
    let config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::of::<C>())
    };
    let mut app = Headless::start(config).unwrap();
    app.first_render().unwrap();
    app
}

/// A dialog named by its title, and an alert dialog asking to confirm.
#[component]
fn Dialogs() -> impl IntoElement {
    view()
        .child(text("Files"))
        .child(
            dialog().label("Rename file").child(
                view()
                    .child(text("Rename file"))
                    .child(button().child(text("Save"))),
            ),
        )
        .child(
            dialog()
                .role(AccessibilityRole::AlertDialog)
                .label("Delete file?")
                .child(
                    view()
                        .child(text("Delete file?"))
                        .child(button().child(text("Delete"))),
                ),
        )
}

#[test]
fn a_dialog_is_a_dialog_named_by_its_label() {
    let app = start::<Dialogs>();
    let screen = app.screen();
    assert_eq!(screen.count("role:dialog[Rename file]"), Ok(1));
    assert_eq!(screen.count("role:dialog >> role:button[Save]"), Ok(1));
}

#[test]
fn the_app_makes_a_dialog_an_alert_dialog_with_its_role() {
    let app = start::<Dialogs>();
    let screen = app.screen();
    assert_eq!(screen.count("role:alertdialog[Delete file?]"), Ok(1));
    assert_eq!(
        screen.count("role:alertdialog >> role:button[Delete]"),
        Ok(1)
    );
    // Not a dialog too.
    assert_eq!(screen.count("role:dialog"), Ok(1));
}

/// An alert dialog that tells what it is about beside its title, and a
/// view described on its own.
#[component]
fn Described() -> impl IntoElement {
    view()
        .child(
            view()
                .test_id("field")
                .label("Name")
                .accessibility_description("Letters and digits only")
                .child(text("Name")),
        )
        .child(
            dialog()
                .role(AccessibilityRole::AlertDialog)
                .label("Delete file?")
                .accessibility_description("This can't be undone.")
                .child(
                    view()
                        .child(text("Delete file?"))
                        .child(text("This can't be undone."))
                        .child(button().child(text("Delete"))),
                ),
        )
}

#[test]
fn a_dialog_hands_its_message_to_screen_readers() {
    let app = start::<Described>();
    let screen = app.screen();
    assert_eq!(
        screen.accessibility_description("role:alertdialog[Delete file?]"),
        Ok(Some("This can't be undone.".to_owned()))
    );
}

#[test]
fn any_element_takes_a_description() {
    let app = start::<Described>();
    let screen = app.screen();
    assert_eq!(
        screen.accessibility_description("id:field"),
        Ok(Some("Letters and digits only".to_owned()))
    );
}

#[test]
fn a_dialog_without_one_has_none() {
    let app = start::<Dialogs>();
    let screen = app.screen();
    assert_eq!(
        screen.accessibility_description("role:dialog[Rename file]"),
        Ok(None)
    );
}

/// A settings sheet that opens at half height with the system's grabber
/// and keeps the detent the user drags it to, and a stack inside it that
/// pushes a page.
#[component]
fn SettingsSheet() -> impl IntoElement {
    use nsh_base::{nav_page, nav_stack};
    use nsh_core::{ModalPresentation, SheetDetent};
    let detent = signal(SheetDetent::Medium);
    let changes = signal(0);
    let pushed = signal(false);
    view()
        .child(text(move || {
            format!("{:?} after {} changes", detent.get(), changes.get())
        }))
        .child(
            dialog()
                .label("Settings")
                .presentation(ModalPresentation::PageSheet)
                .detents(vec![SheetDetent::Medium, SheetDetent::Large])
                .detent(move || Some(detent.get()))
                .grabber(true)
                .on_detent_change(move |d: &SheetDetent| {
                    detent.set(*d);
                    changes.update(|n| *n += 1);
                })
                .child(
                    nav_stack()
                        .flex_1()
                        .child(
                            nav_page().key("settings").child(
                                view()
                                    .on_press(move |_: &()| pushed.set(true))
                                    .child(text("Open appearance")),
                            ),
                        )
                        .child(when(pushed, move || {
                            nav_page()
                                .key("appearance")
                                .on_dismiss(move || pushed.set(false))
                                .child(text("Appearance options"))
                        })),
                ),
        )
}

#[test]
fn a_page_sheet_opens_at_its_detent_with_the_grabber() {
    use nsh_core::SheetDetent;
    let app = start::<SettingsSheet>();
    let screen = app.screen();
    assert_eq!(
        screen.sheet_detent("role:dialog[Settings]"),
        Ok(Some(SheetDetent::Medium))
    );
    assert_eq!(screen.sheet_grabber("role:dialog[Settings]"), Ok(true));
}

#[test]
fn the_user_drags_a_page_sheet_to_another_detent() {
    use nsh_core::SheetDetent;
    let mut app = start::<SettingsSheet>();
    app.set_sheet_detent("role:dialog[Settings]", SheetDetent::Large)
        .unwrap();
    let screen = app.screen();
    assert_eq!(screen.count("text:Large after 1 changes"), Ok(1));
    assert_eq!(
        screen.sheet_detent("role:dialog[Settings]"),
        Ok(Some(SheetDetent::Large))
    );
    // Only its own detents.
    assert!(
        app.set_sheet_detent("role:dialog[Settings]", SheetDetent::Height(Points(300.0)))
            .is_err()
    );
}

#[test]
fn a_stack_in_a_page_sheet_pushes_and_goes_back() {
    let mut app = start::<SettingsSheet>();
    app.press("Open appearance").unwrap();
    assert_eq!(app.screen().count("text:Appearance options"), Ok(1));
    // Back pops the stack's page, inside the sheet, which stays.
    app.back().unwrap();
    let screen = app.screen();
    assert_eq!(screen.count("text:Appearance options"), Ok(0));
    assert_eq!(screen.count("role:dialog[Settings]"), Ok(1));
    assert_eq!(screen.count("text:Open appearance"), Ok(1));
}

/// Sheets the app does not keep at a detent: one opening at its
/// `defaultDetent`, one at its smallest, and a full-screen dialog, for
/// which detents mean nothing.
#[component]
fn OwnDetents() -> impl IntoElement {
    use nsh_core::{ModalPresentation, SheetDetent};
    let detents = || vec![SheetDetent::Fraction(Percentage(0.3)), SheetDetent::Large];
    view()
        .child(
            dialog()
                .label("Opens large")
                .presentation(ModalPresentation::PageSheet)
                .detents(detents())
                .default_detent(Some(SheetDetent::Large))
                .child(text("Large")),
        )
        .child(
            dialog()
                .label("Opens small")
                .presentation(ModalPresentation::FormSheet)
                .detents(detents())
                .child(text("Small")),
        )
        .child(
            dialog()
                .label("Full screen")
                .detents(detents())
                .child(text("Full")),
        )
}

#[test]
fn a_page_sheet_opens_at_its_default_detent_else_its_smallest() {
    use nsh_core::SheetDetent;
    let app = start::<OwnDetents>();
    let screen = app.screen();
    assert_eq!(
        screen.sheet_detent("role:dialog[Opens large]"),
        Ok(Some(SheetDetent::Large))
    );
    assert_eq!(
        screen.sheet_detent("role:dialog[Opens small]"),
        Ok(Some(SheetDetent::Fraction(Percentage(0.3))))
    );
    assert_eq!(screen.sheet_detent("role:dialog[Full screen]"), Ok(None));
    assert_eq!(screen.sheet_grabber("role:dialog[Opens large]"), Ok(false));
}
