//! `Share`'s fake (`"nsh-extra/share"`) in headless apps: no share sheet
//! until the test answers, then every share answered as it said, and what
//! the app shared listed.

use nsh_core::{JsonValue, prelude::*};
use nsh_engine::EngineConfig;
use nsh_extra::share::{self, ShareRequest};
use nsh_testing::Headless;
use serde_json::json;

const FAKE: &str = "nsh-extra/share";

/// Shares a link when pressed and shows how the share ended.
#[component]
fn Sharing() -> impl IntoElement {
    let result = signal(String::from("nothing"));
    let share_link = move |_: &()| {
        drop(spawn(async move {
            let request = ShareRequest::new()
                .title("Docs")
                .url("https://example.com/docs");
            result.set(match share::show(request).await {
                Ok(outcome) => match outcome.target {
                    Some(target) => format!("{} {target}", outcome.action.as_str()),
                    None => outcome.action.as_str().to_owned(),
                },
                Err(error) => error.code.unwrap_or_default(),
            });
        }));
    };
    view()
        .child(text(move || result.get()))
        .child(text("Share").on_press(share_link))
}

fn start() -> Headless {
    let config = EngineConfig {
        ui_sets: vec![nsh_extra::registry()],
        ..EngineConfig::new(nsh_testing::windowed_root::<Sharing>())
    };
    let mut app = Headless::start(config).expect("the engine starts");
    app.first_render().expect("the app renders");
    app
}

#[test]
fn a_test_answers_the_share_sheet() {
    let mut app = start();
    // No share sheet until the test answers.
    app.press("Share").unwrap();
    app.wait_for("text:ERR_FEATURE_UNAVAILABLE_ON_PLATFORM")
        .unwrap();
    assert_eq!(app.call_fake(FAKE, "shares", &[]).unwrap(), json!([]));

    app.call_fake(
        FAKE,
        "answer",
        &[json!({ "action": "shared", "target": "mail" })],
    )
    .unwrap();
    app.press("Share").unwrap();
    app.wait_for("text:shared mail").unwrap();
    app.call_fake(FAKE, "answer", &[json!({ "action": "dismissed" })])
        .unwrap();
    app.press("Share").unwrap();
    app.wait_for("text:dismissed").unwrap();
    let shared = json!({
        "title": "Docs",
        "text": null,
        "url": "https://example.com/docs",
        "files": [],
        // The share names no `anchor`.
        "anchored": false,
    });
    assert_eq!(
        app.call_fake(FAKE, "shares", &[]).unwrap(),
        json!([shared, shared])
    );
}

#[test]
fn a_share_left_open_is_dismissed_by_the_next() {
    let mut app = start();
    app.call_fake(FAKE, "hold", &[]).unwrap();
    app.press("Share").unwrap();
    app.wait_for("text:nothing").unwrap();
    // The next share reaches the platform, and the first ends as
    // dismissed.
    app.press("Share").unwrap();
    app.wait_for("text:dismissed").unwrap();
    let shares = app.call_fake(FAKE, "shares", &[]).unwrap();
    assert_eq!(shares.as_array().map(Vec::len), Some(2));
}

#[test]
fn the_fake_refuses_what_it_does_not_know() {
    let mut app = start();
    for answer in [
        JsonValue::Null,
        json!({ "action": "maybe" }),
        json!({ "action": "shared", "target": 1 }),
    ] {
        assert!(
            app.call_fake(FAKE, "answer", std::slice::from_ref(&answer))
                .is_err(),
            "{answer}"
        );
    }
    assert!(app.call_fake(FAKE, "open", &[]).is_err());
}
