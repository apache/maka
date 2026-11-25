//! `Speech`'s fake (`"nsh-extra/speech"`) in headless apps: it stands in
//! process-wide, as the module's backend, so two apps launched with
//! registries of their own (two `#[test]`s) take turns, and each test
//! reaches its own app's sessions.

use std::{
    sync::mpsc,
    task::{Context, Poll, Waker},
    time::Duration,
};

use nsh_core::{JsonValue, prelude::*};
use nsh_engine::EngineConfig;
use nsh_extra::speech::{self, SpeechEvent, SpeechRequest};
use nsh_testing::Headless;
use serde_json::json;

const FAKE: &str = "nsh-extra/speech";

#[component]
fn Blank() -> impl IntoElement {
    view()
}

/// An app that dictates from the start: its Rust code starts a session on
/// the engine's thread and listens until it ends.
#[component]
fn Dictating() -> impl IntoElement {
    drop(spawn(async {
        let mut recognition = speech::recognize(SpeechRequest::default());
        while recognition.next().await.is_some() {}
    }));
    view()
}

/// An app with `nsh-extra` and a registry of its own, as each `#[test]` of
/// an app crate launches it.
fn start() -> Headless {
    let config = EngineConfig {
        ui_sets: vec![nsh_extra::registry()],
        ..EngineConfig::new(nsh_testing::windowed_root::<Blank>())
    };
    let mut app = Headless::start(config).expect("the engine starts");
    app.first_render().expect("the app renders");
    app
}

#[test]
fn an_app_with_other_fakes_waits_for_the_one_running() {
    let mut first = start();
    // Another test launches its app meanwhile, on its own thread.
    let (started, second_started) = mpsc::channel();
    let second = std::thread::spawn(move || {
        let mut app = start();
        started.send(()).unwrap();
        app.call_fake(FAKE, "requests", &[])
    });
    assert_eq!(
        second_started.recv_timeout(Duration::from_millis(300)),
        Err(mpsc::RecvTimeoutError::Timeout),
        "the second app started while the first runs"
    );

    // The first app dictates (its Rust code, as a press would start it):
    // its own fake hears it, the second app's never replaced it.
    let mut recognition = speech::recognize(SpeechRequest::default());
    let mut cx = Context::from_waker(Waker::noop());
    assert_eq!(
        recognition.poll_next(&mut cx),
        Poll::Ready(Some(SpeechEvent::Start))
    );
    first
        .call_fake(FAKE, "hear", &[JsonValue::from("hello")])
        .expect("the first app's test reaches its session");
    assert_eq!(
        first.call_fake(FAKE, "requests", &[]).unwrap(),
        json!([{ "lang": null, "interim": true }])
    );
    drop(recognition);
    drop(first);

    // Once the first is gone, the second starts, with nothing of the
    // first's left in its fake.
    second_started
        .recv_timeout(Duration::from_secs(10))
        .expect("the second app starts once the first is gone");
    assert_eq!(second.join().unwrap().unwrap(), json!([]));
}

#[test]
fn apps_with_the_same_fakes_run_together() {
    // One registry, as the apps one `nsh test` file opens share theirs.
    let sets = vec![nsh_extra::registry()];
    let config = || EngineConfig {
        ui_sets: sets.clone(),
        ..EngineConfig::new(nsh_testing::windowed_root::<Blank>())
    };
    let mut first = Headless::start(config()).expect("the first app starts");
    let mut recognition = speech::recognize(SpeechRequest::default());
    let mut cx = Context::from_waker(Waker::noop());
    assert_eq!(
        recognition.poll_next(&mut cx),
        Poll::Ready(Some(SpeechEvent::Start))
    );

    // The second shares the fakes the first installed: what the first
    // started stays reachable from both.
    let mut second = Headless::start(config()).expect("the second app starts at once");
    let one = json!([{ "lang": null, "interim": true }]);
    assert_eq!(second.call_fake(FAKE, "requests", &[]).unwrap(), one);
    first
        .call_fake(FAKE, "hear", &[JsonValue::from("hello")])
        .expect("the first app's session still listens");
    drop(recognition);
    drop((first, second));
}

#[test]
fn a_session_ends_when_its_app_stops() {
    // One registry: the app left running shares the fakes and sees the
    // session of the one that stops.
    let sets = vec![nsh_extra::registry()];
    let mut dictating = Headless::start(EngineConfig {
        ui_sets: sets.clone(),
        ..EngineConfig::new(nsh_testing::windowed_root::<Dictating>())
    })
    .expect("the dictating app starts");
    dictating.first_render().expect("the dictating app renders");
    let mut other = Headless::start(EngineConfig {
        ui_sets: sets.clone(),
        ..EngineConfig::new(nsh_testing::windowed_root::<Blank>())
    })
    .expect("the other app starts");
    other.first_render().expect("the other app renders");
    assert_eq!(
        other.call_fake(FAKE, "requests", &[]).unwrap(),
        json!([{ "lang": null, "interim": true }]),
        "the dictating app listens"
    );

    // Its engine stops (a view loading another app, a closed window): the
    // session ends with it, so the microphone goes off, though no engine
    // is left to tell.
    drop(dictating);
    assert_eq!(
        other.call_fake(FAKE, "hear", &[JsonValue::from("late")]),
        Err("no speech session listens".to_string())
    );
}
