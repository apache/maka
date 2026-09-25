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

mod presentation;
mod reads;

use super::*;
use crate::i18n::{I18n, Locale, LocalePreference};
use maka_client::{ClientError, RequestFailure};
use maka_protocol::plugin::{Cleanup, Convergence, Durability, EntryPhase, Phase};
use ratatui::{Terminal, backend::TestBackend};
use serde_json::json;

fn entry() -> EntryProjection {
    EntryProjection {
        base_generation: 7,
        id: "board".into(),
        root_id: Scope::Profile,
        parent_id: None,
        package_id: Some("example.board".into()),
        config: json!({"label":"old"}),
        local_disabled: false,
        disabled: false,
        inject: Default::default(),
        isolate: Default::default(),
        intercept: Default::default(),
        required_services: Some(vec!["clock".into()]),
        status: EntryPhase::Active,
        generation: Some(2),
        waiting_for: vec![],
        effects: vec![],
        children: vec![],
        diagnostic: None,
    }
}
fn snapshot() -> Snapshot {
    Snapshot {
        status: Status {
            phase: Phase::Ready,
            authority_epoch: 7,
            convergence: Convergence::Converged,
            installed_package_count: 1,
            layered_package_count: 0,
            desired_entry_count: 1,
            live_entry_count: 1,
            failure_count: 0,
            fence_diagnostic: None,
        },
        packages: vec![PackageProjection {
            base_generation: 7,
            extension_id: "example.board".into(),
            content_digest: format!("sha256-{}", "a".repeat(64)),
            display_name: "Board package".into(),
            description: None,
            dependencies: vec![],
            structural_dependencies: vec![],
            required_by: vec![],
            has_runtime: true,
            has_client: false,
            has_composition: false,
        }],
        entries: vec![entry()],
    }
}
fn app(place: Place) -> App {
    let mut app = App::new(
        "/unused".into(),
        I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
    );
    app.connection = ConnectionState::Connected {
        root_id: "root".into(),
        epoch: "epoch".into(),
    };
    app.apply(Action::Visit(Route::Plugins(place)));
    let read = app.plugins_request().unwrap();
    app.plugins_completed(read, Ok(Output::Snapshot(snapshot())));
    draw(&mut app, 100, 35);
    app
}
fn draw(app: &mut App, width: u16, height: u16) {
    Terminal::new(TestBackend::new(width, height))
        .unwrap()
        .draw(|frame| crate::view::draw(frame, app))
        .unwrap();
}
fn review(app: &mut App, change: Change) -> Uuid {
    draw(app, 100, 35);
    app.apply(Action::Plugins(Command::Review(app.plugins.token, change)));
    let Some(Confirmation::Write(request)) = &app.plugins.confirmation else {
        panic!("review must freeze a write")
    };
    let token = request.token;
    // An unpainted confirmation never dispatches.
    assert!(!app.enabled(&Action::Plugins(Command::Confirm(token))));
    draw(app, 100, 35);
    token
}
fn confirm(app: &mut App, change: Change) -> Request {
    let token = review(app, change);
    app.apply(Action::Plugins(Command::Confirm(token)));
    app.plugins_request().unwrap()
}
fn receipt() -> Receipt {
    Receipt {
        authority_epoch: 8,
        durability: Durability::Committed,
        convergence: Convergence::Converged,
        cleanup: Cleanup::Complete,
        failures: vec![],
    }
}

#[test]
fn frozen_confirmation_and_checkpoint_gate_keep_original_payload_and_generation() {
    let key = EntryKey::of(&entry());
    let mut app = app(Place::Configure(key));
    let token = review(&mut app, Change::Configure);
    app.plugins.draft_mut().unwrap().fields[1] = drafts::editor(r#"{"secret":"later"}"#, 1024);
    app.apply(Action::Plugins(Command::Confirm(token)));
    let request = app.plugins_request().unwrap();
    let io::Mutation::Apply(apply) = request.mutation().unwrap() else {
        panic!()
    };
    assert_eq!(apply.base_generation, Some(7));
    let maka_plugins::composition::Operation::Update { patch, .. } = &apply.operations[0] else {
        panic!()
    };
    assert_eq!(patch.config, Some(json!({"label":"old"})));
    assert!(!app.plugins_after_checkpoint(&request, &Err("disk full".into())));
    assert!(app.plugins.pending.is_none());
    assert!(app.plugins.unknown.is_empty());
    assert!(
        app.plugins.draft().unwrap().fields[1]
            .text()
            .contains("later")
    );
}

#[test]
fn opaque_payload_is_withheld_and_restore_never_dispatches_original() {
    let key = EntryKey::of(&entry());
    let mut app = app(Place::Configure(key));
    let draft = app.plugins.draft_mut().unwrap();
    draft.fields[1] = drafts::editor(r#"{"apiKey":"never-save-plugin-secret"}"#, 1024);
    draft.dirty[1] = true;
    let request = confirm(&mut app, Change::Configure);
    let saved = app.plugins.checkpoint();
    saved.validate("root").unwrap();
    assert!(saved.validate("other").is_err());
    let encoded = serde_json::to_string(&saved).unwrap();
    assert!(!encoded.contains("never-save-plugin-secret"));
    assert!(encoded.contains(&request.token.to_string()));
    let mut restored = State::default();
    restored.restore(serde_json::from_str(&encoded).unwrap());
    assert_eq!(restored.unknown.len(), 1);
    assert!(restored.pending.is_none());
    assert!(restored.queued.is_none());
    assert!(restored.drafts.is_empty());
}

#[test]
fn unknown_identity_survives_refresh_and_late_root_or_epoch_replies_are_ignored() {
    let mut app = app(Place::Entry(EntryKey::of(&entry())));
    let request = confirm(&mut app, Change::Disable);
    assert!(app.plugins_after_checkpoint(&request, &Ok(())));
    app.plugins.disconnect();
    assert_eq!(app.plugins.unknown.len(), 1);
    app.connection = ConnectionState::Connected {
        root_id: "root".into(),
        epoch: "replacement".into(),
    };
    let read = app.plugins_request().unwrap();
    app.plugins_completed(request.clone(), Ok(Output::Receipt(receipt())));
    assert!(app.plugins.receipt.is_none());
    assert!(app.plugins.pending.is_some());
    app.plugins_completed(read, Ok(Output::Snapshot(snapshot())));
    assert_eq!(app.plugins.unknown.len(), 1);
    app.connection = ConnectionState::Connected {
        root_id: "foreign".into(),
        epoch: "epoch".into(),
    };
    assert!(!app.plugins_after_checkpoint(&request, &Ok(())));
    app.plugins_completed(request, Err(RequestFailure::Unknown(ClientError::Timeout)));
    assert_eq!(app.plugins.unknown.len(), 1);
}

#[test]
fn conflict_preserves_mine_until_explicit_review_adopts_current_base() {
    let key = EntryKey::of(&entry());
    let mut app = app(Place::Configure(key));
    let draft = app.plugins.draft_mut().unwrap();
    draft.fields[1] = drafts::editor(r#"{"label":"mine"}"#, 1024);
    draft.dirty[1] = true;
    app.plugins
        .snapshot
        .as_mut()
        .unwrap()
        .status
        .authority_epoch = 8;
    app.plugins.snapshot.as_mut().unwrap().entries[0].base_generation = 8;
    app.plugins.snapshot.as_mut().unwrap().entries[0].config = json!({"label":"current"});
    draw(&mut app, 100, 35);
    app.apply(Action::Plugins(Command::Review(
        app.plugins.token,
        Change::Configure,
    )));
    assert!(app.plugins.confirmation.is_none());
    assert_eq!(app.plugins.draft().unwrap().base, 7);
    app.apply(Action::Plugins(Command::Rebase(app.plugins.token)));
    let Some(Confirmation::Rebase { token, .. }) = &app.plugins.confirmation else {
        panic!()
    };
    let token = *token;
    draw(&mut app, 100, 35);
    app.apply(Action::Plugins(Command::ConfirmRebase(token)));
    assert_eq!(app.plugins.draft().unwrap().base, 8);
    assert_eq!(
        app.plugins.draft().unwrap().fields[1].text(),
        r#"{"label":"mine"}"#
    );
    assert!(app.plugins.queued.is_none());
    let request = confirm(&mut app, Change::Configure);
    assert_eq!(request.intent().unwrap().2, 8);
}

#[test]
fn shell_history_retains_draft_focus_and_small_geometry_cannot_confirm() {
    let key = EntryKey::of(&entry());
    let place = Place::Configure(key);
    let mut app = app(place.clone());
    app.plugins.draft_mut().unwrap().fields[1] = drafts::editor(r#"{"label":"kept"}"#, 1024);
    app.plugins.draft_mut().unwrap().dirty[1] = true;
    app.plugins
        .surface
        .focus("plugins/scroll/body/field-1".into());
    app.apply(Action::Visit(Route::Settings));
    app.apply(Action::Back);
    draw(&mut app, 55, 20);
    assert_eq!(app.navigation.current(), Route::Plugins(place));
    assert!(
        app.plugins.draft().unwrap().fields[1]
            .text()
            .contains("kept")
    );
    assert_eq!(
        app.plugins.surface.focused(),
        Some("plugins/scroll/body/field-1")
    );
    let token = review(&mut app, Change::Configure);
    draw(&mut app, 20, 8);
    assert!(!app.enabled(&Action::Plugins(Command::Confirm(token))));
    app.apply(Action::Plugins(Command::Confirm(token)));
    assert!(app.plugins.queued.is_none());
}

#[test]
fn desired_disable_and_typed_routing_are_independent_of_effective_state() {
    let mut app = app(Place::Entry(EntryKey::of(&entry())));
    app.plugins.snapshot.as_mut().unwrap().entries[0].disabled = true;
    let request = confirm(&mut app, Change::Disable);
    let io::Mutation::Apply(apply) = request.mutation().unwrap() else {
        panic!()
    };
    let maka_plugins::composition::Operation::Update { patch, .. } = &apply.operations[0] else {
        panic!()
    };
    assert_eq!(patch.disabled, Some(true));
    app.plugins_after_checkpoint(&request, &Err("stop before sending".into()));
    app.apply(Action::Visit(Route::Plugins(Place::Services(
        EntryKey::of(&entry()),
    ))));
    app.plugins.draft_mut().unwrap().fields[2] = drafts::editor(
        r#"{"inject":["clock"],"isolate":{"clock":false},"intercept":{}}"#,
        1024,
    );
    draw(&mut app, 100, 35);
    app.apply(Action::Plugins(Command::Review(
        app.plugins.token,
        Change::Services,
    )));
    assert!(app.plugins.confirmation.is_none());
    app.plugins.draft_mut().unwrap().fields[2] = drafts::editor(
        r#"{"inject":["clock"],"isolate":{"clock":"team"},"intercept":{}}"#,
        1024,
    );
    let _ = confirm(&mut app, Change::Services);
}

#[test]
fn saving_config_preserves_a_separate_services_draft_and_quit_requires_a_visible_choice() {
    let key = EntryKey::of(&entry());
    let mut app = app(Place::Configure(key.clone()));
    let draft = app.plugins.draft_mut().unwrap();
    draft.fields[1] = drafts::editor(r#"{"label":"saved"}"#, 1024);
    draft.fields[2] = drafts::editor(
        r#"{"inject":["clock"],"isolate":{"clock":"kept"},"intercept":{}}"#,
        1024,
    );
    draft.dirty = [false, true, true];
    let request = confirm(&mut app, Change::Configure);
    assert!(app.plugins_after_checkpoint(&request, &Ok(())));
    app.plugins_completed(request, Ok(Output::Receipt(receipt())));
    assert_eq!(app.plugins.draft().unwrap().dirty, [false, false, true]);
    assert!(
        app.plugins.draft().unwrap().fields[2]
            .text()
            .contains("kept")
    );
    assert!(app.apply(Action::Detach).is_none());
    let Some(Confirmation::Exit { token, .. }) = app.plugins.confirmation else {
        panic!()
    };
    assert!(!app.enabled(&Action::Plugins(Command::ConfirmExit(token))));
    draw(&mut app, 100, 35);
    assert_eq!(
        app.apply(Action::Plugins(Command::ConfirmExit(token))),
        Some(Action::Detach)
    );
}

#[test]
fn package_preview_freezes_source_and_installed_digest_preconditions() {
    let mut app = app(Place::Install);
    app.plugins.path = drafts::editor("/host/reviewed.maka", 4096);
    let package = snapshot().packages[0].clone();
    app.plugins.preview = Some(PackagePreview {
        source_path: "/host/reviewed.maka".into(),
        package: package.clone(),
        expected: maka_protocol::plugin::PackagePrecondition {
            base_generation: 7,
            content_digest: None,
        },
    });
    let token = review(&mut app, Change::Install);
    app.plugins.path = drafts::editor("/host/replaced.maka", 4096);
    app.apply(Action::Plugins(Command::Confirm(token)));
    let request = app.plugins_request().unwrap();
    let io::Mutation::Install(input) = request.mutation().unwrap() else {
        panic!()
    };
    assert_eq!(input.source_path, "/host/reviewed.maka");
    assert_eq!(input.source_digest.as_ref(), Some(&package.content_digest));
    assert_eq!(input.expected.as_ref().unwrap().base_generation, 7);
    assert!(input.expected.as_ref().unwrap().content_digest.is_none());
    let saved = serde_json::to_string(&app.plugins.checkpoint()).unwrap();
    assert!(!saved.contains("/host/"));
    assert!(saved.contains(&package.content_digest));
}

#[test]
fn navigating_to_install_keeps_the_ready_snapshot_and_accepts_immediate_pointer_paste() {
    use crossterm::event::{Event, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
    let mut app = app(Place::Overview);
    app.apply(Action::Visit(Route::Plugins(Place::Install)));
    assert!(
        app.plugins_request().is_none(),
        "a child address uses the displayed snapshot until an explicit refresh"
    );
    draw(&mut app, 100, 35);
    app.focus = crate::app::Focus::Navigation;
    let area = app
        .plugins
        .surface
        .rect("plugins/scroll/body/field-0")
        .unwrap();
    app.input(Event::Mouse(MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: area.x + 1,
        row: area.y + 1,
        modifiers: KeyModifiers::NONE,
    }));
    app.input(Event::Paste("/host/example.maka".into()));
    assert_eq!(app.plugins.path.text(), "/host/example.maka");
    app.apply(Action::Plugins(Command::Preview));
    assert!(app.plugins_request().is_some());
}

#[test]
fn every_overlay_quit_key_uses_the_visible_plugin_draft_exit_guard() {
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
    for overlay in [
        Action::Palette,
        Action::Help,
        Action::Plugins(Command::Review(Uuid::nil(), Change::Configure)),
    ] {
        let mut app = app(Place::Configure(EntryKey::of(&entry())));
        app.plugins.draft_mut().unwrap().dirty[1] = true;
        match overlay {
            Action::Plugins(_) => {
                review(&mut app, Change::Configure);
            }
            action => {
                app.apply(action);
            }
        }
        draw(&mut app, 100, 35);
        let (_, effect) = app.input(Event::Key(KeyEvent::new(
            KeyCode::Char('q'),
            KeyModifiers::CONTROL,
        )));
        assert!(
            effect.is_none(),
            "an overlay must not return an unreviewed Quit effect"
        );
        let Some(Confirmation::Exit { token, .. }) = app.plugins.confirmation else {
            panic!("exit review")
        };
        assert!(!app.enabled(&Action::Plugins(Command::ConfirmExit(token))));
        draw(&mut app, 100, 35);
        app.layer.focus_path("footer/confirm");
        draw(&mut app, 100, 35);
        let (_, effect) = app.input(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        assert_eq!(
            effect,
            Some(Action::Quit),
            "confirmed exit must reach the shell exactly once"
        );
    }
}

#[test]
fn rebase_reviews_all_dirty_fields_and_refreshes_every_clean_field_from_the_same_base() {
    for routing_dirty in [true, false] {
        let mut app = app(Place::Configure(EntryKey::of(&entry())));
        app.plugins.draft_mut().unwrap().dirty = [false, true, routing_dirty];
        app.plugins.draft_mut().unwrap().fields[2] = drafts::editor(
            r#"{"inject":[],"isolate":{"clock":"mine-route"},"intercept":{}}"#,
            4096,
        );
        let snapshot = app.plugins.snapshot.as_mut().unwrap();
        snapshot.status.authority_epoch = 8;
        snapshot.entries[0].base_generation = 8;
        snapshot.entries[0].isolate.insert(
            "clock".into(),
            maka_plugins::composition::Isolation::Named("current-route".into()),
        );
        app.apply(Action::Plugins(Command::Rebase(app.plugins.token)));
        let Some(Confirmation::Rebase { token, .. }) = &app.plugins.confirmation else {
            panic!()
        };
        let token = *token;
        let mut terminal = Terminal::new(TestBackend::new(100, 100)).unwrap();
        terminal
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        let rendered: String = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(
            rendered.contains("current-route"),
            "new routing base must be reviewable from the config form"
        );
        if routing_dirty {
            assert!(
                rendered.contains("mine-route"),
                "all retained dirty routing must be in the same review"
            );
        }

        app.apply(Action::Plugins(Command::ConfirmRebase(token)));
        let draft = app.plugins.draft().unwrap();
        assert_eq!(draft.base, 8);
        assert!(draft.fields[2].text().contains(if routing_dirty {
            "mine-route"
        } else {
            "current-route"
        }));
        assert_eq!(
            draft.original.as_ref().unwrap().isolate.get("clock"),
            Some(&maka_plugins::composition::Isolation::Named(
                "current-route".into()
            ))
        );
    }
}

#[test]
fn legal_config_loads_completely_when_pretty_json_exceeds_the_editor_capacity() {
    let mut value = json!(vec![json!({"key":0}); 2000]);
    for _ in 0..60 {
        value = json!([value]);
    }
    assert!(serde_json::to_string_pretty(&value).unwrap().len() > drafts::EDITOR_BYTES);
    assert!(serde_json::to_vec(&value).unwrap().len() < 64 * 1024);
    for value in [value, json!({"large":"x".repeat(60*1024)})] {
        let mut app = app(Place::Configure(EntryKey::of(&entry())));
        app.plugins.snapshot.as_mut().unwrap().entries[0].config = value.clone();
        app.plugins.discard_draft();
        let draft = app.plugins.draft().unwrap();
        assert!(draft.fields[1].error.is_none());
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(draft.fields[1].text()).unwrap(),
            value
        );
        assert_eq!(draft.patch(Change::Configure).unwrap().config, Some(value));
    }
    let mut app = app(Place::Configure(EntryKey::of(&entry())));
    app.plugins.draft_mut().unwrap().fields[1] = drafts::editor(
        &format!("{}null", " ".repeat(150 * 1024)),
        drafts::EDITOR_BYTES,
    );
    assert_eq!(
        app.plugins
            .draft()
            .unwrap()
            .patch(Change::Configure)
            .unwrap()
            .config,
        Some(serde_json::Value::Null)
    );
    app.plugins.draft_mut().unwrap().fields[1] = drafts::editor(
        &json!("x".repeat(64 * 1024)).to_string(),
        drafts::EDITOR_BYTES,
    );
    assert_eq!(
        app.plugins
            .draft()
            .unwrap()
            .patch(Change::Configure)
            .unwrap_err(),
        "plugins-config-too-large"
    );
    app.plugins.draft_mut().unwrap().fields[1] =
        drafts::editor(&"x".repeat(drafts::EDITOR_BYTES + 1), drafts::EDITOR_BYTES);
    assert!(app.plugins.draft().unwrap().fields[1].error.is_some());
    assert_eq!(
        app.plugins
            .draft()
            .unwrap()
            .patch(Change::Configure)
            .unwrap_err(),
        "plugins-field-limit"
    );
    let mut terminal = Terminal::new(TestBackend::new(100, 35)).unwrap();
    terminal
        .draw(|frame| crate::view::draw(frame, &mut app))
        .unwrap();
    let rendered: String = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect();
    assert!(rendered.contains("Field exceeds the size limit."));
}

#[test]
fn dirty_plugin_exit_takes_over_apps_consent_without_authorizing_or_replacing_it() {
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
    use maka_plugins::{
        authorization::{Capability, Request as Proposal, Target},
        terminal_ui::view::Reply,
    };
    let mut app = crate::apps::tests::app();
    app.plugins.snapshot = Some(snapshot());
    app.plugins.place = Place::Configure(EntryKey::of(&entry()));
    app.plugins.ensure_draft();
    app.plugins.draft_mut().unwrap().dirty[1] = true;
    draw(&mut app, 100, 40);
    app.apps_action(crate::apps::tests::save());
    let request = crate::apps::tests::next(&mut app).unwrap();
    let proposal = Proposal {
        operation_id: Uuid::new_v4(),
        title: "Notify".into(),
        target: Target::Profile,
        capabilities: [Capability::Notifications].into(),
    };
    app.apps_complete(
        request,
        Ok(crate::apps::Output::Reply(Reply::Consent {
            request: proposal,
        })),
    );
    let screen = crate::apps::tests::draw(&mut app, 100, 40);
    assert!(screen.contains("Send notifications"));
    let approve = crate::apps::tests::command(crate::apps::Command::ApproveConsent);
    assert!(app.apps_enabled(&approve));
    app.apply(Action::Plugins(Command::Review(
        app.plugins.token,
        Change::Configure,
    )));
    assert!(
        !app.plugins.confirm_visible(),
        "ordinary native writes cannot replace an unrelated consent"
    );
    let (_, effect) = app.input(Event::Key(KeyEvent::new(
        KeyCode::Char('q'),
        KeyModifiers::CONTROL,
    )));
    assert!(effect.is_none());
    let screen = crate::apps::tests::draw(&mut app, 100, 40);
    assert!(screen.contains("Leave unsaved drafts?"));
    assert!(app.apps.consent_visible());
    assert!(!app.apps_enabled(&approve));
    assert!(crate::apps::tests::next(&mut app).is_none());
    app.input(Event::Key(KeyEvent::new(
        KeyCode::Enter,
        KeyModifiers::NONE,
    ))); // Cancel exit, never authorize.
    assert!(app.apps.consent_visible());
    assert!(crate::apps::tests::next(&mut app).is_none());
    let screen = crate::apps::tests::draw(&mut app, 100, 40);
    assert!(screen.contains("Send notifications"));
}

#[test]
fn platform_notices_preserve_frozen_confirmation_dirty_base_and_pending_read_invalidation() {
    let mut app = app(Place::Configure(EntryKey::of(&entry())));
    let draft = app.plugins.draft_mut().unwrap();
    draft.fields[1] = drafts::editor(r#"{"label":"mine"}"#, 1024);
    draft.dirty[1] = true;
    let token = review(&mut app, Change::Configure);
    app.plugins.changed();
    assert!(
        app.plugins_request().is_none(),
        "a notice cannot replace a frozen review"
    );
    let Some(Confirmation::Write(frozen)) = &app.plugins.confirmation else {
        panic!()
    };
    assert_eq!(frozen.token, token);
    assert_eq!(frozen.intent().unwrap().2, 7);
    app.apply(Action::Plugins(Command::Cancel));
    let first = app.plugins_request().unwrap();
    assert!(!first.needs_checkpoint());
    app.plugins.changed(); // Arrives after this read began and must not be consumed by it.
    let mut newer = snapshot();
    newer.status.authority_epoch = 8;
    for package in &mut newer.packages {
        package.base_generation = 8;
    }
    newer.entries[0].base_generation = 8;
    newer.entries[0].status = EntryPhase::Loading;
    newer.entries[0].config = json!({"label":"current"});
    app.plugins_completed(first, Ok(Output::Snapshot(newer.clone())));
    assert_eq!(app.plugins.draft().unwrap().base, 7);
    assert!(
        app.plugins.draft().unwrap().fields[1]
            .text()
            .contains("mine")
    );
    let second = app
        .plugins_request()
        .expect("notice during read schedules a follow-up read");
    assert!(!second.needs_checkpoint());
    let mut original_receipt = receipt();
    original_receipt.convergence = Convergence::Diverged;
    app.plugins.receipt = Some(original_receipt);
    newer.entries[0].status = EntryPhase::Active;
    app.plugins_completed(second, Ok(Output::Snapshot(newer)));
    assert!(matches!(
        app.plugins.snapshot.as_ref().unwrap().entries[0].status,
        EntryPhase::Active
    ));
    assert_eq!(app.plugins.draft().unwrap().base, 7);
    assert!(
        app.plugins.draft().unwrap().fields[1]
            .text()
            .contains("mine")
    );
    assert_eq!(
        app.plugins.receipt.as_ref().unwrap().convergence,
        Convergence::Diverged,
        "a current fact is not a replacement original receipt"
    );
    assert!(
        app.plugins_request().is_none(),
        "notices do not start a permanent poll"
    );
}

#[test]
fn standalone_actions_keep_one_row_and_mouse_rebase_opens_the_reviewed_current_value() {
    use crossterm::event::{Event, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
    let key = EntryKey::of(&entry());
    let mut app = app(Place::Entry(key.clone()));
    for (width, height) in [(100, 35), (55, 24)] {
        draw(&mut app, width, height);
        for path in [
            "plugins/scroll/body/config-row/config",
            "plugins/scroll/body/services-row/services",
        ] {
            let area = app.plugins.surface.rect(path).unwrap();
            assert_eq!(
                area.height, 1,
                "a button's fixed width must not become column height"
            );
            assert!(area.width > 0);
        }
    }
    app.apply(Action::Visit(Route::Plugins(Place::Configure(key))));
    app.plugins.draft_mut().unwrap().dirty[1] = true;
    app.plugins
        .snapshot
        .as_mut()
        .unwrap()
        .status
        .authority_epoch = 8;
    let entry = &mut app.plugins.snapshot.as_mut().unwrap().entries[0];
    entry.base_generation = 8;
    entry.config = json!({"label":"current pointer review"});
    draw(&mut app, 100, 48);
    let area = app
        .plugins
        .surface
        .rect("plugins/scroll/body/rebase-row/rebase")
        .unwrap();
    assert_eq!(area.height, 1);
    let save = app
        .plugins
        .surface
        .rect("plugins/scroll/body/save-actions/save")
        .unwrap();
    assert_eq!(
        save.height, 1,
        "save remains reachable below the review action"
    );
    app.input(Event::Mouse(MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: area.x + 1,
        row: area.y,
        modifiers: KeyModifiers::NONE,
    }));
    let Some(Confirmation::Rebase {
        current: Some(current),
        base,
        ..
    }) = &app.plugins.confirmation
    else {
        panic!("mouse review must open its sheet")
    };
    assert_eq!(*base, 8);
    assert_eq!(current.config, json!({"label":"current pointer review"}));
}
