/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

use super::*;
use crate::{app::Action, apps::Key};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use maka_protocol::subscription::{decode_observation_frame, decode_session_observation_snapshot};
use std::time::{Duration, Instant};

pub(super) fn inspectors(count: usize) -> (App, Vec<Key>) {
    let mut app = crate::apps::tests::app();
    app.chrome.motion = true;
    app.chrome.window_focused = true;
    let mut keys = vec![];
    for index in 0..count {
        let mut panel = app.apps.directory[0].clone();
        panel.method = format!("budget-panel-{index}");
        panel.descriptor.placement = Placement::Panel;
        keys.push(Key::of(&panel, Some("session")).unwrap());
        app.apps.directory.push(panel);
    }
    app.apply(Action::Visit(Route::Session("session".into())));
    app.navigate(crate::navigation::Intent::Inspector(true));
    let reads = app.apps_requests();
    assert_eq!(reads.len(), count);
    for read in reads {
        assert!(matches!(
            &read.work,
            Work::Call {
                input: maka_plugins::terminal_ui::view::Request::Read { .. },
                ..
            }
        ));
        app.apps_complete(
            read,
            Ok(Output::Reply(Reply::View {
                view: crate::apps::tests::form(),
            })),
        );
    }
    assert!(
        app.apps_requests().is_empty(),
        "all panels are ready before input"
    );
    app.chat.select(&app.navigation.current());
    app.chat.snapshot = Some(decode_session_observation_snapshot(&json!({
        "schemaVersion":5,"session":{"sessionId":"session","metadataRevision":1,"status":"active","createdAt":0,"isArchived":false},
        "projectionRevision":1,"rootTurn":null,"goal":null,
        "queue":{"hostEpoch":"epoch","queueRevision":0,"steering":[],"followup":[]},"interactions":{"pending":[]}
    })).unwrap());
    app.chat.subscription = Some("sub".into());
    app.chat.fixture_rows(Default::default());
    draw(&mut app);
    let path = app
        .apps
        .inspector_wells
        .iter()
        .find(|well| well.key == keys[0] && well.field == "name")
        .unwrap()
        .path
        .clone();
    app.apps.inspector.focus(path);
    app.focus = Focus::Inspector;
    (app, keys)
}

fn draw(app: &mut App) {
    crate::apps::tests::draw(app, 170, 40);
}

fn field(app: &App, key: &Key) -> serde_json::Value {
    serde_json::to_value(
        app.apps
            .checkpoints(app.checkpoint_root())
            .into_iter()
            .find(|checkpoint| checkpoint.address() == key)
            .unwrap(),
    )
    .unwrap()
}

fn delta(app: &mut App, index: u64, sequence: u64, offset: u64, text: &str, complete: bool) {
    let mut delta = json!({
        "kind":"thinking","turnId":"turn","runId":"run",
        "messageId":format!("live-{index}"),"startOffset":offset,"text":text
    });
    if complete {
        delta["complete"] = json!(true);
    }
    app.chat.accept(decode_observation_frame(&json!({
        "kind":"subscription.session_delta","hostEpoch":"epoch","subscriptionId":"sub","sequence":sequence,"sessionId":"session",
        "delta":delta
    })).unwrap()).unwrap();
}

#[test]
fn deferred_native_reading_growth_invalidates_field_admission_but_stable_paints_do_not() {
    for live in [false, true] {
        let (mut app, keys) = inspectors(1);
        let key = &keys[0];
        // Retaining a clean form costs its whole checkpoint, not just the new
        // characters. Establish this owner before constraining its growth.
        app.input(Event::Paste("warm".into()));
        assert_eq!(field(&app, key)["drafts"]["name"], "My noteswarm");
        leave_capacity(&mut app, 1024);
        draw(&mut app);
        assert_eq!(app.focus, Focus::Inspector);
        app.input(Event::Paste("a".into()));
        assert_eq!(field(&app, key)["drafts"]["name"], "My noteswarma");
        let checks = App::admission_checks();
        for _ in 0..3 {
            draw(&mut app);
            app.input(Event::Key(KeyEvent::new(
                KeyCode::Right,
                KeyModifiers::NONE,
            )));
        }
        assert_eq!(App::admission_checks(), checks);
        let reading = app.chat.view.reading_changes();
        if live {
            for index in 0..80 {
                delta(&mut app, index, index + 1, 0, "step", false);
            }
            // Hold the real cadence deterministically; no wall-clock sleeps.
            app.chat
                .fixture_cadence(Some(Instant::now() + Duration::from_secs(60)));
            draw(&mut app);
            assert_eq!(app.chat.view.reading_changes(), reading);
        } else {
            app.chat.fixture_rows((1..=80).map(|sequence| (sequence, json!({
                "type":"user","id":format!("row-{sequence}"),"turnId":"turn","text":"New durable row"
            }))).collect());
        }
        // State::start can capture before the deferred draw: current saved
        // metadata still fits and its cache is warm, despite newly received data.
        assert_eq!(field(&app, key)["drafts"]["name"], "My noteswarma");
        let mut pending = Snapshot::capture(&app, app.checkpoint_root());
        assert!(super::super::super::super::store::encode(&pending).is_ok());
        app.calibrate_checkpoint(&mut pending);
        let checks = App::admission_checks();
        let original = field(&app, key);
        if live {
            app.chat.fixture_cadence(None);
        }
        draw(&mut app);
        assert_ne!(app.chat.view.reading_changes(), reading);
        assert!(
            super::super::super::super::store::encode(&Snapshot::capture(
                &app,
                app.checkpoint_root()
            ))
            .is_err()
        );
        app.input(Event::Paste("must be refused".into()));
        assert_eq!(
            field(&app, key),
            original,
            "text and cursor remain unchanged"
        );
        assert_eq!(App::admission_checks(), checks + 1);
        let reading = app.chat.view.reading_changes();
        if live {
            // A body append changes neither the folded identities nor membership.
            delta(&mut app, 0, 81, 4, " appended", true);
        }
        for _ in 0..3 {
            draw(&mut app);
            app.input(Event::Paste("still refused".into()));
            assert_eq!(app.chat.view.reading_changes(), reading);
            assert_eq!(App::admission_checks(), checks + 1);
            assert_eq!(field(&app, key), original);
        }
        // Once capacity is available, Undo reaches the preceding accepted edit;
        // no refused event was added to the real Editor journal.
        let location = app.navigation.location().clone();
        app.navigation = Navigation::default();
        app.navigation.visit(location);
        app.checkpoint_changed(Impact::Other);
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Char('z'),
            KeyModifiers::CONTROL,
        )));
        assert_eq!(field(&app, key)["drafts"]["name"], "My noteswarm");
    }
}
