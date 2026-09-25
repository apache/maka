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
use crate::{
    apps::{Message, Output, Work},
    navigation::{Location, Route},
};
use maka_plugins::terminal_ui::{Placement, view::Reply};
use serde_json::json;

mod native;

fn oversized() -> Navigation {
    let mut navigation = Navigation::default();
    let mut location = Location::from(Route::Settings);
    for index in 0..256 {
        let mut key = crate::apps::tests::key();
        key.session = None;
        key.placement = Placement::Settings;
        key.package = format!("example.capacity{index}");
        key.route = json!("\"".repeat(4095));
        location.embedded.push(key);
    }
    assert!(location.valid(|_| true));
    for index in 0..21 {
        location.embedded[0].route = json!(index);
        navigation.visit(location.clone());
    }
    assert!(navigation.valid(|_| true));
    navigation
}

fn leave_capacity(app: &mut App, headroom: usize) {
    let current = app.navigation.location().clone();
    app.navigation = oversized();
    app.navigation.visit(current);
    let maximum = super::super::super::store::MAX_BYTES as usize - headroom;
    let mut snapshot = Snapshot::capture(app, app.checkpoint_root());
    let mut excess = snapshot.charges(app).bytes().saturating_sub(maximum);
    let mut navigation = serde_json::to_value(&app.navigation).unwrap();
    for entry in navigation["entries"].as_array_mut().unwrap() {
        for key in entry["embedded"].as_array_mut().unwrap() {
            if let Some(text) = key["route"].as_str().map(str::to_owned) {
                let remove = excess.div_ceil(2).min(text.len());
                let replacement = &text[..text.len() - remove];
                let difference = serde_json::to_vec(&text).unwrap().len()
                    - serde_json::to_vec(replacement).unwrap().len();
                key["route"] = json!(replacement);
                excess = excess.saturating_sub(difference);
            }
        }
    }
    assert_eq!(excess, 0);
    app.navigation = serde_json::from_value(navigation).unwrap();
    let mut snapshot = Snapshot::capture(app, app.checkpoint_root());
    snapshot.validate(app.checkpoint_root()).unwrap();
    assert!(snapshot.charges(app).bytes() <= maximum);
    app.checkpoint_changed(Impact::Other);
}

#[test]
fn candidate_navigation_uses_the_store_encoded_limit_without_changing_current_state() {
    let mut app = crate::apps::tests::app();
    let original = serde_json::to_vec(&app.navigation).unwrap();
    let candidate = oversized();
    let mut snapshot = Snapshot::capture(&app, app.checkpoint_root());
    snapshot.navigation = candidate.clone();
    assert!(super::super::super::store::encode(&snapshot).is_err());
    assert!(!app.admit_state(Some((&candidate, true, None))));
    assert_eq!(serde_json::to_vec(&app.navigation).unwrap(), original);
}

#[test]
fn foreground_applied_retains_the_result_when_its_redirect_cannot_be_admitted() {
    let mut app = crate::apps::tests::app();
    app.apps_action(crate::apps::tests::save());
    let submit = crate::apps::tests::next(&mut app).unwrap();
    assert!(matches!(submit.work, Work::Call { .. }));
    // Other existing native owners may grow behind their writer gate while a
    // write is in flight. A completed write must still retain its result.
    let source = crate::apps::tests::key();
    app.navigation = oversized();
    app.navigation.visit(Route::App(source.clone()));
    let original = serde_json::to_vec(&app.navigation).unwrap();
    app.apps_complete(
        submit,
        Ok(Output::Reply(Reply::Applied {
            route: json!({"saved": 1}),
        })),
    );
    assert_eq!(serde_json::to_vec(&app.navigation).unwrap(), original);
    let checkpoints = app.apps.checkpoints("root");
    assert_eq!(checkpoints.len(), 1);
    checkpoints[0].validate("root").unwrap();
    let saved = serde_json::to_value(&checkpoints).unwrap();
    assert_eq!(saved[0]["result"]["route"], json!({"saved": 1}));
    assert!(saved[0]["view"].is_null());
    assert!(saved[0]["pending"].is_null());
    assert!(app.apps_requests().is_empty());
    app.navigation = Navigation::default();
    app.apps_action(Message::Result(source));
    assert_eq!(
        app.navigation.current(),
        Route::App(crate::apps::tests::key().at(json!({"saved": 1})))
    );
    assert!(app.apps.checkpoints("root").is_empty());
    assert!(crate::apps::tests::next(&mut app).is_some());
}

#[test]
fn background_growth_is_recalibrated_before_typing_without_rechecking_cursor_or_polling() {
    use crate::apps::{Command, Intent};
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
    let mut app = crate::apps::tests::app();
    app.apps_action(crate::apps::tests::command(Command::View(Intent::Toggle(
        "enabled".into(),
    ))));
    leave_capacity(&mut app, 1024);
    crate::apps::tests::draw(&mut app, 90, 28);
    app.input(Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)));
    app.input(Event::Paste("warm".into()));
    let before = App::admission_checks();
    app.input(Event::Key(KeyEvent::new(
        KeyCode::Left,
        KeyModifiers::SHIFT,
    )));
    assert_eq!(App::admission_checks(), before);
    let original = serde_json::to_vec(&app.apps.checkpoints("root")).unwrap();
    // The same Other boundary used by State::changed and background delivery
    // invalidates a previously warm cache before the very next field event.
    app.drafts
        .get_mut("session")
        .unwrap()
        .insert(&"x".repeat(2048));
    app.checkpoint_changed(Impact::Other);
    app.input(Event::Paste("local".into()));
    for _ in 0..3 {
        assert!(app.apps_requests().is_empty());
    }
    assert_eq!(
        App::admission_checks(),
        before + 1,
        "only the invalidated envelope is recalibrated"
    );
    assert_eq!(
        serde_json::to_vec(&app.apps.checkpoints("root")).unwrap(),
        original
    );
    app.input(Event::Paste("still refused".into()));
    assert_eq!(App::admission_checks(), before + 1);
    assert_eq!(
        serde_json::to_vec(&app.apps.checkpoints("root")).unwrap(),
        original
    );
}

#[test]
fn frozen_writes_share_remaining_bytes_and_unknown_keeps_its_result_reservation() {
    use crate::apps::{Command, Intent};
    let (mut app, keys) = native::inspectors(2);
    leave_capacity(&mut app, crate::apps::CHECKPOINT_MAX_BYTES + 8);
    // Both ready forms stay visible. Revisiting a clean standalone page would
    // intentionally queue a Read and make Submit unavailable until it completes.
    for key in keys {
        let command = Message::Instance(key, Command::View(Intent::Submit("save".into())));
        assert!(app.apps_enabled(&command));
        app.apps_action(command.clone());
        assert!(
            !app.apps_enabled(&command),
            "the actual Submit is now pending"
        );
    }
    let writes = app.apps_requests();
    assert_eq!(writes.len(), 1, "one result reservation fits; two do not");
    let write = writes.into_iter().next().unwrap();
    assert!(write.needs_checkpoint());
    let mut frozen = Snapshot::capture(&app, app.checkpoint_root());
    let charges = frozen.charges(&app);
    assert_eq!(charges.owners.len(), 1);
    assert_eq!(
        *charges.owners.values().next().unwrap(),
        crate::apps::CHECKPOINT_MAX_BYTES
    );
    assert!(super::super::super::store::fits(charges.bytes()));
    assert!(
        app.apps_requests().is_empty(),
        "refused writes are not retried by polling"
    );
    app.apps_complete(
        write.clone(),
        Err(crate::apps::io::Failure { unknown: true }),
    );
    let mut unknown = Snapshot::capture(&app, app.checkpoint_root());
    assert_eq!(unknown.charges(&app).bytes(), charges.bytes());
    let encoded = serde_json::to_value(&unknown).unwrap();
    assert!(!encoded["apps"][0]["pending"].is_null());
    // A late known receipt replaces its own frozen identity, even off screen.
    app.navigation = Navigation::default();
    app.focus = Focus::Navigation;
    app.checkpoint_changed(Impact::Other);
    app.apps_complete(
        write,
        Ok(Output::Reply(Reply::Applied {
            route: json!({"saved": true}),
        })),
    );
    let mut applied = Snapshot::capture(&app, app.checkpoint_root());
    applied.validate(app.checkpoint_root()).unwrap();
    assert!(
        *applied.charges(&app).owners.values().next().unwrap() < crate::apps::CHECKPOINT_MAX_BYTES
    );
    let encoded = serde_json::to_value(applied).unwrap();
    assert_eq!(
        encoded["apps"][0]["result"]["route"],
        json!({"saved": true})
    );
}
