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

#[test]
fn candidate_navigation_uses_the_store_encoded_limit_without_changing_current_state() {
    let mut app = crate::apps::tests::app();
    let original = serde_json::to_vec(&app.navigation).unwrap();
    let candidate = oversized();
    let mut snapshot = Snapshot::capture(&app, app.checkpoint_root());
    snapshot.navigation = candidate.clone();
    assert!(super::super::super::store::encode(&snapshot).is_err());
    assert!(!app.admit_state(Some((&candidate, true, None)), 0));
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
fn rejected_growth_does_not_repeat_whole_snapshot_checks_for_local_input_or_polling() {
    use crate::apps::{Command, Intent};
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
    let mut app = crate::apps::tests::app();
    app.apps_action(crate::apps::tests::command(Command::View(Intent::Toggle(
        "enabled".into(),
    ))));
    app.navigation = oversized();
    app.navigation.visit(Route::App(crate::apps::tests::key()));
    assert!(!app.admit_state(None, 0));
    crate::apps::tests::draw(&mut app, 90, 28);
    let before = App::admission_checks();
    app.input(Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)));
    app.input(Event::Key(KeyEvent::new(
        KeyCode::Left,
        KeyModifiers::SHIFT,
    )));
    app.input(Event::Paste("local".into()));
    for _ in 0..3 {
        assert!(app.apps_requests().is_empty());
    }
    assert_eq!(App::admission_checks(), before);
    let checkpoint = serde_json::to_value(app.apps.checkpoints("root")).unwrap();
    assert!(
        checkpoint[0]["drafts"]["name"]
            .as_str()
            .unwrap()
            .contains("local")
    );
}
