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

use super::super::tests::{app, click, command, draw, instance, instance_mut, key, next};
use super::super::*;
use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use maka_plugins::terminal_ui::{
    VERSION,
    view::{self as wire, build::*},
};
use serde_json::json;

const CARD: &str = "app/body/frame/content/root/leading/list/groups/todo/a";
const TARGET: &str = "app/body/frame/content/root/leading/list/groups/done";
const FILTER: &str = "app/body/frame/content/root/leading/list/filter";
fn view(panels: bool) -> wire::View {
    wire::View {
        version: VERSION,
        title: "Tasks".into(),
        revision: "one".into(),
        fields: ["item", "group", "before"]
            .into_iter()
            .map(|id| line(id, "", 128))
            .collect(),
        actions: vec![wire::Action {
            fields: vec!["item".into(), "group".into(), "before".into()],
            recovery: Some(json!({"operation":"move-one"})),
            ..action("move", "Move")
        }],
        root: wire::Node::Collection {
            key: "root".into(),
            ratio: 60,
            initial: None,
            filter: Some(wire::CollectionFilter {
                label: "Filter".into(),
                placeholder: "Filter cards".into(),
            }),
            groups: ["todo", "done"]
                .into_iter()
                .map(|id| wire::CollectionGroup {
                    key: id.into(),
                    label: id.into(),
                })
                .collect(),
            items: [("a", "Alpha 中文"), ("b", "Beta")]
                .into_iter()
                .map(|(id, title)| wire::CollectionItem {
                    key: id.into(),
                    group: "todo".into(),
                    title: title.into(),
                    summary: String::new(),
                    panel: panels.then(|| Box::new(slot("panel", "details", json!({"card":id})))),
                })
                .collect(),
            movement: Some(Box::new(wire::CollectionMovement {
                action: "move".into(),
                item_field: "item".into(),
                group_field: "group".into(),
                before_field: "before".into(),
            })),
        },
    }
}
fn mouse(app: &mut App, kind: MouseEventKind, x: u16, y: u16) {
    app.input(Event::Mouse(MouseEvent {
        kind,
        column: x,
        row: y,
        modifiers: KeyModifiers::NONE,
    }));
}
#[test]
fn collection_preview_stays_local_during_read_and_one_commit_survives_its_late_reply() {
    let mut app = app();
    instance_mut(&mut app).install(view(false));
    draw(&mut app, 170, 35);
    app.apps_action(command(Command::Refresh));
    let pending = next(&mut app).unwrap();
    click(&mut app, FILTER);
    app.input(Event::Paste("中文".into()));
    let filtered = draw(&mut app, 170, 35);
    assert!(
        filtered.contains("Alpha") && !filtered.contains("Beta"),
        "{filtered}"
    );
    assert_eq!(
        instance(&app)
            .collections
            .get("root")
            .visible()
            .iter()
            .map(|item| item.key.as_str())
            .collect::<Vec<_>>(),
        ["a"]
    );
    assert!(next(&mut app).is_none());
    app.input(Event::Key(KeyEvent::new(
        KeyCode::Char('a'),
        KeyModifiers::CONTROL,
    )));
    app.input(Event::Key(KeyEvent::new(
        KeyCode::Backspace,
        KeyModifiers::NONE,
    )));
    draw(&mut app, 170, 35);
    let card = instance(&app).surface.rect(CARD).unwrap();
    let target = instance(&app).surface.rect(TARGET).unwrap();
    mouse(
        &mut app,
        MouseEventKind::Down(MouseButton::Left),
        card.x + 1,
        card.y,
    );
    mouse(
        &mut app,
        MouseEventKind::Drag(MouseButton::Left),
        target.x + 1,
        target.y,
    );
    draw(&mut app, 170, 35);
    assert!(next(&mut app).is_none(), "preview never requests the Host");
    app.input(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
    assert!(next(&mut app).is_none());
    draw(&mut app, 170, 35);
    mouse(
        &mut app,
        MouseEventKind::Down(MouseButton::Left),
        card.x + 1,
        card.y,
    );
    mouse(
        &mut app,
        MouseEventKind::Drag(MouseButton::Left),
        target.x + 1,
        target.y,
    );
    mouse(
        &mut app,
        MouseEventKind::Up(MouseButton::Left),
        target.x + 1,
        target.y,
    );
    let write = next(&mut app).unwrap();
    assert!(
        matches!(&write.work, Work::Call { input: Input::Submit { action, revision, fields, .. }, .. } if action == "move" && revision == "one" && fields["item"] == "a" && fields["group"] == "done" && fields["before"] == "")
    );
    let frozen = instance(&app).unresolved.as_ref().unwrap().input.clone();
    app.apps_complete(
        pending,
        Ok(Output::Reply(Reply::View { view: view(false) })),
    );
    mouse(
        &mut app,
        MouseEventKind::Up(MouseButton::Left),
        target.x + 1,
        target.y,
    );
    assert!(next(&mut app).is_none());
    assert_eq!(instance(&app).unresolved.as_ref().unwrap().input, frozen);
    app.apps_complete(write, Err(io::Failure { unknown: true }));
    assert!(
        next(&mut app).is_none(),
        "unknown writes are never replayed by a read or redraw"
    );
    draw(&mut app, 60, 35);
    assert_eq!(instance(&app).unresolved.as_ref().unwrap().input, frozen);
}
#[test]
fn only_selected_details_mount_and_navigated_dirty_children_return_to_their_exact_identity() {
    let mut app = app();
    instance_mut(&mut app).install(view(true));
    let mut filler = app.apps.directory[0].clone();
    filler.method = "detail".into();
    filler.descriptor.placement = Placement::Slot {
        name: "details".into(),
    };
    app.apps.directory.push(filler);
    app.mount_app_views();
    assert!(
        app.apps_requests().is_empty(),
        "hidden card documents are not opened"
    );
    draw(&mut app, 170, 40);
    click(&mut app, CARD);
    let mut requests = app.apps_requests();
    assert_eq!(requests.len(), 1);
    let request = requests.pop().unwrap();
    let child = request.key.clone().unwrap();
    assert_eq!(child.origin, json!({"card":"a"}));
    app.apps_complete(
        request,
        Ok(Output::Reply(Reply::View {
            view: super::super::tests::form(),
        })),
    );
    app.apps_action(Message::Instance(
        child.clone(),
        Command::View(Intent::Navigate(json!({"nested":"editor"}))),
    ));
    let requests = app.apps_requests();
    // Explicit embedded navigation refreshes the clean root through the normal
    // global navigation lifecycle, and opens only the requested child route.
    assert_eq!(requests.len(), 2);
    let nested = child.at(json!({"nested":"editor"}));
    assert!(
        requests
            .iter()
            .any(|request| request.key.as_ref() == Some(&key()))
    );
    assert!(
        requests
            .iter()
            .any(|request| request.key.as_ref() == Some(&nested))
    );
    for request in requests {
        let updated = if request.key.as_ref() == Some(&key()) {
            view(true)
        } else {
            super::super::tests::form()
        };
        app.apps_complete(request, Ok(Output::Reply(Reply::View { view: updated })));
    }
    app.apps_action(Message::Instance(
        nested.clone(),
        Command::View(Intent::Toggle("enabled".into())),
    ));
    assert_eq!(app.apps.instances[&nested].drafts["enabled"], false);
    instance(&app).collections.get("root").select("b");
    app.apps_action(command(Command::View(Intent::Select("root".into()))));
    assert!(!app.app_selected(&nested));
    assert!(app.navigation.location().contains(&nested));
    let mut requests = app.apps_requests();
    assert_eq!(requests.len(), 1);
    let request = requests.pop().unwrap();
    assert_eq!(request.key.as_ref().unwrap().origin, json!({"card":"b"}));
    app.apps_complete(
        request,
        Ok(Output::Reply(Reply::View {
            view: super::super::tests::form(),
        })),
    );
    instance(&app).collections.get("root").select("a");
    app.apps_action(command(Command::View(Intent::Select("root".into()))));
    assert!(app.app_selected(&nested));
    assert!(app.apps_requests().is_empty());
    draw(&mut app, 60, 40);
    draw(&mut app, 170, 40);
    assert_eq!(app.apps.instances[&nested].drafts["enabled"], false);
    assert_eq!(app.navigation.location().selected(&child), Some(&nested));
    assert_eq!(app.navigation.current(), Route::App(key()));
    // Retaining a hidden draft does not authorize a removed contribution.
    app.apps.directory.retain(|entry| entry.method != "detail");
    app.apps.bind();
    app.mount_app_views();
    assert!(!app.navigation.location().contains(&nested));
    assert!(!app.app_selected(&nested));
    assert_eq!(app.apps.instances[&nested].drafts["enabled"], false);
    assert!(app.apps_requests().is_empty());
}
