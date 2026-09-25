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
use crate::apps::tests::{NAME, app, command, draw, form, instance, instance_mut, key, next, save};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use serde_json::json;

fn fill(app: &mut App) {
    let entry = instance(app).entry.clone().unwrap();
    for index in 0..64 {
        let key = key().at(json!({"kept": index}));
        let mut retained = Instance::new(Some(entry.clone()), key.clone());
        retained.install(form());
        match index % 3 {
            0 => {
                retained.drafts.insert("enabled".into(), json!(false));
            }
            1 => {
                retained.result = Some(key.clone());
                retained.view = None;
                retained.drafts.clear();
                retained.editors.clear();
            }
            _ => {
                retained.submit("save", "en");
                retained.unresolved = retained.frozen_pending(retained.pending.as_ref().unwrap());
                retained.pending = None;
                retained.blocked = true;
            }
        }
        if index == 30 {
            if let Control::Text { secret, .. } =
                &mut retained.view.as_mut().unwrap().fields[1].control
            {
                *secret = true;
            }
            retained.drafts.insert("enabled".into(), json!(true));
            retained
                .drafts
                .insert("name".into(), json!("memory-only secret"));
        }
        app.apps.instances.insert(key, retained);
    }
    assert_eq!(app.apps.kept_count(), 64);
}

#[test]
fn many_small_retained_owners_admit_typing_toggle_and_freeze_without_changing_others() {
    let mut app = app();
    fill(&mut app);
    let retained = serde_json::to_vec(&app.apps.checkpoints("root")).unwrap();
    let navigation = serde_json::to_vec(&app.navigation).unwrap();
    draw(&mut app, 90, 28);
    instance_mut(&mut app).surface.focus(NAME.into());
    app.input(Event::Key(KeyEvent::new(
        KeyCode::Char('a'),
        KeyModifiers::CONTROL,
    )));
    app.input(Event::Paste("accepted draft".into()));
    assert_eq!(instance(&app).editors["name"].text(), "accepted draft");
    app.apps_action(command(Command::View(Intent::Toggle("enabled".into()))));
    assert_eq!(instance(&app).drafts["enabled"], json!(false));
    let generation = instance(&app).generation;
    app.apps_action(save());
    assert!(next(&mut app).unwrap().needs_checkpoint());
    assert!(instance(&app).generation > generation);
    assert!(instance(&app).unresolved.is_some());
    assert!(instance(&app).saving);
    assert_eq!(serde_json::to_vec(&app.navigation).unwrap(), navigation);
    assert_eq!(
        serde_json::to_vec(
            &app.apps
                .checkpoints("root")
                .into_iter()
                .filter(|checkpoint| checkpoint.address() != &key())
                .collect::<Vec<_>>()
        )
        .unwrap(),
        retained
    );
}

#[test]
fn authorization_reserves_result_bytes_after_more_than_thirty_two_retained_owners() {
    use maka_plugins::authorization::{Capability, Request as Proposal, Target};
    let mut app = app();
    app.apps_action(save());
    let submit = next(&mut app).unwrap();
    app.apps_complete(
        submit,
        Ok(Output::Reply(Reply::Consent {
            request: Proposal {
                operation_id: uuid::Uuid::new_v4(),
                title: "Notify".into(),
                target: Target::Profile,
                capabilities: [Capability::Notifications].into(),
            },
        })),
    );
    fill(&mut app);
    draw(&mut app, 90, 28);
    assert!(app.apps_enabled(&command(Command::ApproveConsent)));
    let generation = instance(&app).generation;
    app.apps_action(command(Command::ApproveConsent));
    assert!(next(&mut app).unwrap().needs_checkpoint());
    assert!(instance(&app).generation > generation);
    assert!(instance(&app).unresolved.is_some());
    assert!(instance(&app).busy);
}

#[test]
fn local_growth_counts_json_escapes_and_keeps_the_existing_draft() {
    let mut app = app();
    let mut view = form();
    if let Control::Text { max_bytes, .. } = &mut view.fields[1].control {
        *max_bytes = 4096;
    }
    view.root = maka_plugins::terminal_ui::view::build::text(
        "body",
        "x".repeat(60000),
        maka_plugins::terminal_ui::view::Tone::Normal,
    );
    view.validate().unwrap();
    instance_mut(&mut app).install(view);
    assert!(app.admit_field(&key(), "name", &json!("first")));
    instance_mut(&mut app)
        .drafts
        .insert("name".into(), json!("first"));
    assert!(!app.admit_field(&key(), "name", &json!("\\\"".repeat(1800))));
    assert_eq!(instance(&app).drafts["name"], json!("first"));
}

#[test]
fn consecutive_field_edits_and_selection_only_recalculate_the_owner() {
    let mut app = app();
    fill(&mut app);
    draw(&mut app, 90, 28);
    instance_mut(&mut app).surface.focus(NAME.into());
    app.input(Event::Paste(" warm".into()));
    let before = App::admission_checks();
    for _ in 0..8 {
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Char('a'),
            KeyModifiers::NONE,
        )));
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Left,
            KeyModifiers::SHIFT,
        )));
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Right,
            KeyModifiers::NONE,
        )));
        assert!(app.apps_requests().is_empty());
    }
    assert_eq!(App::admission_checks(), before);
    assert!(instance(&app).editors["name"].text().contains("warm"));
}
