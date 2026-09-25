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
use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};

fn screen(app: &mut App, width: u16, height: u16) -> String {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal
        .draw(|frame| crate::view::draw(frame, app))
        .unwrap();
    terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect()
}
fn preview(app: &mut App) {
    app.plugins.path = drafts::editor("/host/reviewed.maka", 4096);
    app.plugins.preview = Some(PackagePreview {
        source_path: "/host/reviewed.maka".into(),
        package: snapshot().packages[0].clone(),
        expected: maka_protocol::plugin::PackagePrecondition {
            base_generation: 7,
            content_digest: None,
        },
    });
}
#[test]
fn install_review_defaults_to_frozen_human_summary_and_expands_the_same_technical_record() {
    let mut app = app(Place::Install);
    preview(&mut app);
    let token = review(&mut app, Change::Install);
    app.plugins.path = drafts::editor("/host/later.maka", 4096);
    let rendered = screen(&mut app, 100, 48);
    assert!(rendered.contains("Package: example.board"));
    assert!(rendered.contains("/host/reviewed.maka"));
    for hidden in [
        "Root: root",
        "Host: epoch",
        "baseGeneration",
        "sourceDigest",
        "sha256-",
    ] {
        assert!(!rendered.contains(hidden), "{hidden} is technical detail");
    }
    app.layer.focus_path("details");
    app.input(Event::Key(KeyEvent::new(
        KeyCode::Enter,
        KeyModifiers::NONE,
    )));
    assert!(app.plugins.confirmation_details);
    let rendered = screen(&mut app, 100, 80);
    assert!(rendered.contains("Root: root"));
    assert!(rendered.contains("Host: epoch"));
    assert!(rendered.contains("sourceDigest"));
    app.apply(Action::Plugins(Command::Confirm(token)));
    let request = app.plugins_request().unwrap();
    let io::Mutation::Install(input) = request.mutation().unwrap() else {
        panic!()
    };
    assert_eq!(input.source_path, "/host/reviewed.maka");
    assert_eq!(input.expected.as_ref().unwrap().base_generation, 7);
}

#[test]
fn three_locales_keep_install_identity_and_confirm_accessible_without_default_rpc_noise() {
    for locale in [Locale::En, Locale::ZhCn, Locale::ZhTw] {
        let mut app = app(Place::Install);
        app.i18n.preference = LocalePreference::Explicit(locale);
        app.chrome.ascii = true;
        preview(&mut app);
        app.apply(Action::Plugins(Command::Review(
            app.plugins.token,
            Change::Install,
        )));
        let rendered = screen(&mut app, 52, 26);
        assert!(rendered.contains("example.board"));
        assert!(rendered.contains("/host/reviewed.maka"));
        assert!(!rendered.contains("baseGeneration"));
        assert!(
            app.layer
                .rect("footer/confirm")
                .is_some_and(|area| !area.is_empty())
        );
        assert!(
            app.layer
                .rect("details")
                .is_some_and(|area| !area.is_empty())
        );
    }
}

#[test]
fn config_and_rebase_show_proposed_values_without_hiding_other_dirty_routing() {
    let mut app = app(Place::Configure(EntryKey::of(&entry())));
    let draft = app.plugins.draft_mut().unwrap();
    draft.fields[1] = drafts::editor(r#"{"label":"frozen-value"}"#, 1024);
    draft.dirty[1] = true;
    let token = review(&mut app, Change::Configure);
    app.plugins.draft_mut().unwrap().fields[1] = drafts::editor(r#"{"label":"later-value"}"#, 1024);
    let Some(Confirmation::Write(request)) = &app.plugins.confirmation else {
        panic!()
    };
    let summary = summary::write(&app, request).unwrap();
    assert!(summary.contains("frozen-value"));
    assert!(!summary.contains("later-value"));
    assert!(!summary.contains("operations"));
    assert!(screen(&mut app, 100, 48).contains("Proposed configuration"));
    app.apply(Action::Plugins(Command::Cancel));
    draw(&mut app, 100, 48);
    app.plugins.draft_mut().unwrap().fields[2] = drafts::editor(
        r#"{"inject":[],"isolate":{"clock":"mine-route"},"intercept":{}}"#,
        1024,
    );
    app.plugins.draft_mut().unwrap().dirty[2] = true;
    app.plugins.snapshot.as_mut().unwrap().entries[0]
        .isolate
        .insert(
            "clock".into(),
            maka_plugins::composition::Isolation::Named("current-route".into()),
        );
    app.apply(Action::Plugins(Command::Rebase(app.plugins.token)));
    app.apply(Action::Plugins(Command::ConfirmationDetails(token))); // A prior Sheet cannot expand this one.
    assert!(!app.plugins.confirmation_details);
    let rendered = screen(&mut app, 100, 100);
    for value in [
        "later-value",
        "mine-route",
        "current-route",
        "Current Host value",
    ] {
        assert!(
            rendered.contains(value),
            "{value} remains part of the ordinary review"
        );
    }
    assert!(!rendered.contains("Composition generation"));
}

#[test]
fn saved_feedback_keeps_the_original_receipt_separate_from_visible_current_failure() {
    let mut app = app(Place::Overview);
    let mut original = receipt();
    original.convergence = Convergence::Diverged;
    original.failures.push(maka_protocol::plugin::Failure {
        entry_id: Some("board".into()),
        extension_id: Some("example.board".into()),
        diagnostic: "old activation problem".into(),
    });
    let encoded = serde_json::to_value(&original).unwrap();
    app.plugins.receipt = Some(original);
    app.plugins.snapshot.as_mut().unwrap().entries[0].status = EntryPhase::Failed;
    app.plugins.snapshot.as_mut().unwrap().entries[0].diagnostic =
        Some("current activation problem".into());
    let rendered = screen(&mut app, 100, 60);
    assert!(rendered.contains("Changes saved"));
    assert!(rendered.contains("current activation problem"));
    assert!(!rendered.contains("old activation problem"));
    assert!(!rendered.contains("cleanup"));
    app.apply(Action::Plugins(Command::Details));
    let rendered = screen(&mut app, 100, 90);
    assert!(rendered.contains("Original operation result"));
    assert!(rendered.contains("old activation problem"));
    assert!(rendered.contains("diverged"));
    assert_eq!(
        serde_json::to_value(app.plugins.receipt.as_ref().unwrap()).unwrap(),
        encoded
    );
    app.plugins.details = false;
    app.plugins.snapshot.as_mut().unwrap().entries[0].status = EntryPhase::Active;
    app.plugins.snapshot.as_mut().unwrap().entries[0].diagnostic = None;
    assert!(!screen(&mut app, 100, 60).contains("current activation problem"));
    assert_eq!(
        serde_json::to_value(app.plugins.receipt.as_ref().unwrap()).unwrap(),
        encoded
    );
}

#[test]
fn preview_digest_is_opt_in_and_new_places_choose_safe_focus_while_returns_restore_it() {
    let mut app = app(Place::Install);
    preview(&mut app);
    assert!(!screen(&mut app, 100, 40).contains("sha256-"));
    app.apply(Action::Plugins(Command::Details));
    assert!(screen(&mut app, 100, 40).contains("sha256-"));
    app.apply(Action::Visit(Route::Plugins(Place::Overview)));
    draw(&mut app, 100, 40);
    app.plugins
        .surface
        .focus("plugins/scroll/body/package-0".into());
    draw(&mut app, 100, 40);
    app.apply(Action::Visit(Route::Plugins(Place::Package(
        "example.board".into(),
    ))));
    draw(&mut app, 100, 40);
    assert_eq!(
        app.plugins.surface.focused(),
        Some("plugins/header/navigation/overview")
    );
    app.plugins
        .surface
        .focus("plugins/scroll/body/package-actions/restart".into());
    draw(&mut app, 100, 40);
    app.apply(Action::Visit(Route::Plugins(Place::Configure(
        EntryKey::of(&entry()),
    ))));
    draw(&mut app, 100, 40);
    assert_eq!(
        app.plugins.surface.focused(),
        Some("plugins/scroll/body/field-1")
    );
    app.apply(Action::Back);
    draw(&mut app, 100, 40);
    assert_eq!(
        app.plugins.surface.focused(),
        Some("plugins/scroll/body/package-actions/restart")
    );
}
