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
use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};

fn click(app: &mut App, area: ratatui::layout::Rect) {
    for kind in [
        MouseEventKind::Down(MouseButton::Left),
        MouseEventKind::Up(MouseButton::Left),
    ] {
        app.input(Event::Mouse(MouseEvent {
            kind,
            column: area.x + 1,
            row: area.y,
            modifiers: KeyModifiers::NONE,
        }));
    }
}
fn next_snapshot(generation: u64) -> Snapshot {
    let mut current = snapshot();
    current.status.authority_epoch = generation;
    current.entries[0].base_generation = generation;
    current.packages[0].base_generation = generation;
    current
}

#[test]
fn background_read_start_and_finish_keep_field_and_package_hit_positions_at_wide_and_narrow_sizes()
{
    for (width, height) in [(100, 40), (40, 30)] {
        let mut app = app(Place::Install);
        draw(&mut app, width, height);
        let token = app.plugins.token;
        let field = app
            .plugins
            .surface
            .rect("plugins/scroll/body/field-0")
            .unwrap();
        app.plugins.changed();
        let read = app.plugins_request().unwrap();
        draw(&mut app, width, height);
        assert_eq!(
            app.plugins.surface.rect("plugins/scroll/body/field-0"),
            Some(field)
        );
        assert_eq!(app.plugins.token, token);
        let mut text_area = field;
        text_area.y += 1;
        click(&mut app, text_area);
        app.input(Event::Paste("/host/kept.maka".into()));
        assert_eq!(app.plugins.path.text(), "/host/kept.maka");
        app.plugins_completed(read, Ok(Output::Snapshot(snapshot())));
        draw(&mut app, width, height);
        assert_eq!(
            app.plugins.surface.rect("plugins/scroll/body/field-0"),
            Some(field)
        );
        assert_eq!(app.plugins.token, token);
        assert_eq!(app.plugins.path.text(), "/host/kept.maka");
        app.apply(Action::Visit(Route::Plugins(Place::Overview)));
        draw(&mut app, width, height);
        let package = app
            .plugins
            .surface
            .rect("plugins/scroll/body/package-0")
            .unwrap();
        app.plugins.changed();
        let read = app.plugins_request().unwrap();
        draw(&mut app, width, height);
        assert_eq!(
            app.plugins.surface.rect("plugins/scroll/body/package-0"),
            Some(package)
        );
        click(&mut app, package);
        assert_eq!(
            app.navigation.current(),
            Route::Plugins(Place::Package("example.board".into()))
        );
        app.plugins_completed(read, Ok(Output::Snapshot(snapshot())));
        assert_eq!(
            app.navigation.current(),
            Route::Plugins(Place::Package("example.board".into()))
        );
    }
}

#[test]
fn unchanged_clean_editor_keeps_real_selection_and_error_while_changed_clean_facts_update() {
    let mut app = app(Place::Configure(EntryKey::of(&entry())));
    let mut field = app
        .plugins
        .surface
        .rect("plugins/scroll/body/field-1")
        .unwrap();
    field.y += 1;
    click(&mut app, field);
    app.input(Event::Key(KeyEvent::new(
        KeyCode::Char('a'),
        KeyModifiers::CONTROL,
    )));
    app.input(Event::Paste("x".repeat(drafts::EDITOR_BYTES + 1)));
    let cursor = app.plugins.draft().unwrap().fields[1].cursor();
    let original = app.plugins.draft().unwrap().fields[1].text().to_owned();
    assert_eq!(app.plugins.draft().unwrap().dirty, [false; 3]);
    assert!(app.plugins.draft().unwrap().fields[1].error.is_some());
    app.plugins.changed();
    let read = app.plugins_request().unwrap();
    app.plugins_completed(read, Ok(Output::Snapshot(next_snapshot(8))));
    let draft = app.plugins.draft().unwrap();
    assert_eq!(draft.base, 8);
    assert_eq!(draft.fields[1].text(), original);
    assert_eq!(draft.fields[1].cursor(), cursor);
    assert!(draft.fields[1].error.is_some());
    let mut changed = next_snapshot(9);
    changed.entries[0].config = json!({"label":"new current value"});
    app.plugins.changed();
    let read = app.plugins_request().unwrap();
    app.plugins_completed(read, Ok(Output::Snapshot(changed)));
    let draft = app.plugins.draft().unwrap();
    assert_eq!(draft.base, 9);
    assert_eq!(
        draft.patch(Change::Configure).unwrap().config,
        Some(json!({"label":"new current value"}))
    );
}

#[test]
fn review_can_freeze_during_background_read_and_late_read_cannot_replace_it_or_pending_write() {
    let mut app = app(Place::Configure(EntryKey::of(&entry())));
    app.plugins.draft_mut().unwrap().fields[1] = drafts::editor(r#"{"label":"reviewed"}"#, 1024);
    app.plugins.draft_mut().unwrap().dirty[1] = true;
    app.plugins.changed();
    let read = app.plugins_request().unwrap();
    let token = review(&mut app, Change::Configure);
    assert!(app.plugins.pending.is_none());
    app.plugins_completed(read.clone(), Ok(Output::Snapshot(next_snapshot(99))));
    let Some(Confirmation::Write(frozen)) = &app.plugins.confirmation else {
        panic!()
    };
    assert_eq!(frozen.token, token);
    assert_eq!(frozen.intent().unwrap().2, 7);
    app.apply(Action::Plugins(Command::Confirm(token)));
    let write = app.plugins_request().unwrap();
    app.plugins_completed(read, Ok(Output::Snapshot(next_snapshot(99))));
    assert_eq!(app.plugins.pending.as_ref().unwrap().token, write.token);
    assert_eq!(
        app.plugins
            .snapshot
            .as_ref()
            .unwrap()
            .status
            .authority_epoch,
        7
    );
    assert!(app.plugins_after_checkpoint(&write, &Ok(())));
    app.plugins_completed(write, Ok(Output::Receipt(receipt())));
}

#[test]
fn rebase_retires_only_a_background_read_then_queries_again_after_cancellation() {
    let mut app = app(Place::Configure(EntryKey::of(&entry())));
    app.plugins.draft_mut().unwrap().dirty[1] = true;
    app.plugins.changed();
    let read = app.plugins_request().unwrap();
    draw(&mut app, 100, 40);
    app.apply(Action::Plugins(Command::Rebase(app.plugins.token)));
    assert!(matches!(
        app.plugins.confirmation,
        Some(Confirmation::Rebase { .. })
    ));
    app.plugins_completed(read.clone(), Ok(Output::Snapshot(next_snapshot(99))));
    assert_eq!(
        app.plugins
            .snapshot
            .as_ref()
            .unwrap()
            .status
            .authority_epoch,
        7
    );
    app.apply(Action::Plugins(Command::Cancel));
    let fresh = app.plugins_request().unwrap();
    assert_ne!(fresh.token, read.token);
    assert!(fresh.background_read());
    app.plugins_completed(fresh, Ok(Output::Snapshot(next_snapshot(8))));
    assert_eq!(app.plugins.draft().unwrap().base, 7);
    assert!(app.plugins_request().is_none());
}

#[test]
fn preview_and_write_are_never_retired_as_background_reads() {
    let mut app = app(Place::Install);
    app.plugins.path = drafts::editor("/host/package", 4096);
    app.apply(Action::Plugins(Command::Preview));
    let preview = app.plugins_request().unwrap();
    assert!(!preview.background_read());
    app.plugins.defer_background_read();
    assert_eq!(app.plugins.pending.as_ref().unwrap().token, preview.token);
    app.plugins_completed(
        preview,
        Ok(Output::Preview(PackagePreview {
            source_path: "/host/package".into(),
            package: snapshot().packages[0].clone(),
            expected: maka_protocol::plugin::PackagePrecondition {
                base_generation: 7,
                content_digest: None,
            },
        })),
    );
    let write = confirm(&mut app, Change::Install);
    app.plugins.defer_background_read();
    assert_eq!(app.plugins.pending.as_ref().unwrap().token, write.token);
    assert!(app.plugins_after_checkpoint(&write, &Ok(())));
    app.plugins.defer_background_read();
    assert!(app.plugins.dispatched);
    app.plugins.disconnect();
    assert_eq!(app.plugins.unknown.len(), 1);
    app.plugins.changed();
    assert_eq!(app.plugins.unknown.len(), 1);
}
