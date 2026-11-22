//! The app's flows, with the steps a user takes.

use std::time::Duration;

use nsh_engine::{EngineConfig, Root};
use nsh_testing::{DialogAnswer, Headless};

fn start() -> Headless {
    let mut app = Headless::start(EngineConfig::new(Root::of::<tasks_rs::App>())).unwrap();
    app.wait_for("Write the first page").unwrap();
    app
}

const GONE: Duration = Duration::from_secs(5);

#[test]
fn adds_a_task_and_a_blank_title_cannot_be_added() {
    let mut app = start();
    assert!(!app.screen().enabled("role:button[Add]").unwrap());
    app.type_text("text:New task", "Ship it").unwrap();
    app.press("role:button[Add]").unwrap();
    app.wait_for("Ship it").unwrap();
    assert_eq!(app.screen().input_text("text:New task").unwrap(), Some(""));
}

#[test]
fn a_tasks_switch_changes_the_list_behind_it() {
    let mut app = start();
    app.press("Write the first page").unwrap();
    app.wait_for("role:switch").unwrap();
    app.press("role:switch").unwrap();
    app.back().unwrap();
    app.wait_for("role:button[Write the first page Done]")
        .unwrap();
}

#[test]
fn removing_asks_first_and_only_remove_removes() {
    let mut app = start();
    app.press("Read the coding guides").unwrap();
    app.wait_for("role:button[Remove]").unwrap();

    app.on_dialog(|_| DialogAnswer::Press("Cancel".to_owned()));
    app.press("role:button[Remove]").unwrap();
    app.wait_for("role:button[Remove]").unwrap();
    assert!(app.screen().shows("Read the coding guides"));

    app.on_dialog(|dialog| {
        assert_eq!(dialog.title.as_deref(), Some("Remove this task?"));
        DialogAnswer::Press("Remove".to_owned())
    });
    app.press("role:button[Remove]").unwrap();
    app.wait_for_gone("Read the coding guides", GONE).unwrap();
    assert_eq!(app.screen().dialogs().len(), 2);
}
