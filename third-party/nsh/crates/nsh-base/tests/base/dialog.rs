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
