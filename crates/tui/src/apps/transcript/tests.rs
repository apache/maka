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
    apps::tests::{app, draw, instance_mut, key},
    ui::transcript::selection::CopyMode,
};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use maka_plugins::terminal_ui::{VERSION, view::View};

fn resource(id: &str) -> wire::Resource {
    wire::Resource {
        id: id.into(),
        read: format!("{id}.read"),
        stream: format!("{id}.stream"),
        route: Value::Null,
    }
}
fn readers() -> App {
    let mut app = app();
    instance_mut(&mut app).view = Some(View {
        version: VERSION,
        title: "Readers".into(),
        revision: "same-business-premise".into(),
        fields: vec![],
        actions: vec![],
        root: Node::Column {
            key: "root".into(),
            gap: 1,
            children: vec![
                Node::Transcript {
                    key: "first".into(),
                    resource: resource("one"),
                },
                Node::Transcript {
                    key: "second".into(),
                    resource: resource("two"),
                },
            ],
        },
    });
    app
}
fn page(app: &mut App, token: Uuid, text: &str) {
    assert!(app.apps_transcript_delivery(transport::Delivery {
        token,
        output: transport::Output::Ready { fence: 1 }
    }));
    assert!(app.apps_transcript_delivery(transport::Delivery {
        token,
        output: transport::Output::Page {
            direction: wire::Direction::Tail,
            page: wire::Page {
                fence: 1,
                records: vec![wire::Record::Block {
                    block: wire::Block {
                        key: wire::Key {
                            turn: "shared-turn".into(),
                            message: "same-entry".into(),
                            part: wire::Part::Text
                        },
                        revision: "one".into(),
                        kind: wire::Kind::Assistant,
                        state: None,
                        content: wire::Content {
                            text: text.into(),
                            ..Default::default()
                        },
                        timestamp_ms: None,
                        affinity: None,
                    }
                }],
                timings: vec![],
                older: None,
                newer: None,
                continuation: None
            },
        }
    }));
}
#[test]
fn node_scope_isolates_identical_message_keys_and_retires_old_resource_deliveries() {
    let mut app = readers();
    let mounts = app.apps_transcript_mounts();
    assert_eq!(mounts.len(), 2);
    page(&mut app, mounts[0].token, "First reader 中文🦀");
    page(&mut app, mounts[1].token, "Second reader **distinct**");
    let screen = draw(&mut app, 100, 35);
    assert!(
        screen.contains("First reader"),
        "{screen}\n{:?}",
        app.apps
            .readers
            .mounts
            .iter()
            .map(|(key, mount)| (
                key,
                mount.source.phase(),
                mount.source.error(),
                mount.source.blocks().len(),
                mount.failed
            ))
            .collect::<Vec<_>>()
    );
    assert!(screen.contains("Second reader distinct"));
    let first = (key(), "root/first".into());
    let second = (key(), "root/second".into());
    let first_view = &app.apps.readers.mounts[&first].view;
    let second_view = &app.apps.readers.mounts[&second].view;
    assert_eq!(
        first_view.copy_text(CopyMode::Source, false).unwrap(),
        "First reader 中文🦀"
    );
    assert_eq!(
        second_view.copy_text(CopyMode::Source, false).unwrap(),
        "Second reader **distinct**"
    );
    let path = "app/body/frame/content/root/second";
    instance_mut(&mut app).surface.focus(path.into());
    assert!(
        app.app_page_input(
            &key(),
            &Event::Key(KeyEvent::new(KeyCode::Char('f'), KeyModifiers::CONTROL))
        )
        .is_some()
    );
    assert!(app.apps.readers.mounts[&first].view.search.is_none());
    assert!(app.apps.readers.mounts[&second].view.search.is_some());
    app.app_page_input(&key(), &Event::Paste("distinct".into()));
    assert_eq!(
        app.apps.readers.mounts[&second]
            .view
            .search
            .as_ref()
            .unwrap()
            .editor
            .text(),
        "distinct"
    );
    let route = instance_mut(&mut app).address.route.clone();
    app.app_page_input(
        &key(),
        &Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
    );
    assert!(app.apps.readers.mounts[&second].view.search.is_none());
    assert_eq!(
        instance_mut(&mut app).address.route,
        route,
        "Esc closes local find before leaving the route"
    );
    let Node::Column { children, .. } = &mut instance_mut(&mut app).view.as_mut().unwrap().root
    else {
        unreachable!()
    };
    let Node::Transcript { resource, .. } = &mut children[0] else {
        unreachable!()
    };
    resource.route = serde_json::json!({"other":true});
    let refreshed = app.apps_transcript_mounts();
    assert_ne!(refreshed[0].token, mounts[0].token);
    assert_eq!(
        refreshed[1].token, mounts[1].token,
        "unchanged source retains reading state"
    );
    assert!(!app.apps_transcript_delivery(transport::Delivery {
        token: mounts[0].token,
        output: transport::Output::Event(wire::Event::Invalidated)
    }));
    assert!(!app.apps.readers.mounts[&first].failed);
    assert_eq!(
        app.apps.readers.mounts[&second]
            .view
            .copy_text(CopyMode::Source, false)
            .unwrap(),
        "Second reader **distinct**"
    );
    instance_mut(&mut app).live.as_mut().unwrap().registration = Uuid::new_v4();
    let rebound = app.apps_transcript_mounts();
    assert!(
        rebound
            .iter()
            .all(|new| refreshed.iter().all(|old| new.token != old.token))
    );
    instance_mut(&mut app).blocked = true;
    assert!(
        app.apps_transcript_mounts().is_empty(),
        "kept drafts cannot open fresh resources before explicit resume"
    );
}

#[test]
fn refresh_keeps_last_good_text_until_a_complete_new_page_and_empty_replaces_it() {
    let mut app = readers();
    let token = app.apps_transcript_mounts()[0].token;
    page(&mut app, token, "Last good text");
    draw(&mut app, 100, 35);
    let identity = (key(), "root/first".into());
    assert_eq!(
        app.apps.readers.mounts[&identity]
            .view
            .copy_text(CopyMode::Source, false)
            .unwrap(),
        "Last good text"
    );
    app.apps.readers.effect(token, ReaderEffect::Refresh);
    let token = app.apps.readers.mounts[&identity].binding.token;
    assert!(app.apps_transcript_delivery(transport::Delivery {
        token,
        output: transport::Output::Failure(transport::Failure::Remote)
    }));
    let screen = draw(&mut app, 100, 35);
    assert!(screen.contains("Last good text"), "{screen}");
    assert_eq!(
        app.apps.readers.mounts[&identity]
            .view
            .copy_text(CopyMode::Source, false)
            .unwrap(),
        "Last good text"
    );
    app.apps.readers.effect(token, ReaderEffect::Refresh);
    let token = app.apps.readers.mounts[&identity].binding.token;
    app.apps_transcript_delivery(transport::Delivery {
        token,
        output: transport::Output::Ready { fence: 2 },
    });
    app.apps_transcript_delivery(transport::Delivery {
        token,
        output: transport::Output::Page {
            direction: wire::Direction::Tail,
            page: wire::Page {
                fence: 2,
                records: vec![],
                timings: vec![],
                older: None,
                newer: None,
                continuation: None,
            },
        },
    });
    let screen = draw(&mut app, 100, 35);
    assert!(!screen.contains("Last good text"));
    assert!(
        app.apps.readers.mounts[&identity]
            .view
            .copy_text(CopyMode::Source, false)
            .is_err()
    );
}

#[test]
fn losing_terminal_focus_ends_external_capture_and_keeps_the_selected_text() {
    use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};
    let mut app = readers();
    let token = app.apps_transcript_mounts()[0].token;
    page(&mut app, token, "Visible reader text");
    draw(&mut app, 100, 35);
    let area = instance_mut(&mut app)
        .surface
        .transcript_area(token)
        .unwrap();
    let mouse = |kind, column, row| {
        Event::Mouse(MouseEvent {
            kind,
            column,
            row,
            modifiers: KeyModifiers::NONE,
        })
    };
    app.input(mouse(
        MouseEventKind::Down(MouseButton::Left),
        area.x + 2,
        area.y,
    ));
    let identity = (key(), "root/first".into());
    assert!(
        app.apps.readers.mounts[&identity]
            .view
            .text_selection
            .dragging()
    );
    app.input(mouse(
        MouseEventKind::Drag(MouseButton::Left),
        area.x + 8,
        area.y,
    ));
    let selected = app.apps.readers.mounts[&identity]
        .view
        .copy_text(CopyMode::Selection, false)
        .unwrap();
    app.input(Event::FocusLost);
    assert!(
        !app.apps.readers.mounts[&identity]
            .view
            .text_selection
            .dragging()
    );
    assert_eq!(
        app.apps.readers.mounts[&identity]
            .view
            .copy_text(CopyMode::Selection, false)
            .unwrap(),
        selected
    );
    app.input(Event::FocusGained);
    app.input(mouse(
        MouseEventKind::Up(MouseButton::Left),
        area.x + 8,
        area.y,
    ));
    assert!(
        !app.apps.readers.mounts[&identity]
            .view
            .text_selection
            .dragging()
    );
}

#[test]
fn a_page_received_during_selection_stays_static_and_pauses_after_projection() {
    use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};
    use ratatui::{Terminal, backend::TestBackend};
    use std::time::Instant;

    let mut app = readers();
    let token = app.apps_transcript_mounts()[0].token;
    let identity = (key(), "root/first".into());
    page(&mut app, token, "Current visible text");
    draw(&mut app, 100, 35);
    let mut block = app.apps.readers.mounts[&identity].source.blocks()[0].clone();
    let deliver = |app: &mut App, direction, block, older, newer| {
        app.apps_transcript_delivery(transport::Delivery {
            token,
            output: transport::Output::Page {
                direction,
                page: wire::Page {
                    fence: 1,
                    records: vec![wire::Record::Block { block }],
                    timings: vec![],
                    older,
                    newer,
                    continuation: None,
                },
            },
        });
    };
    deliver(
        &mut app,
        wire::Direction::Tail,
        block.clone(),
        Some("prior".into()),
        None,
    );
    draw(&mut app, 100, 35);
    let area = instance_mut(&mut app)
        .surface
        .transcript_area(token)
        .unwrap();
    app.input(Event::Mouse(MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: area.x + 2,
        row: area.y,
        modifiers: KeyModifiers::NONE,
    }));
    assert!(
        app.apps.readers.mounts[&identity]
            .view
            .text_selection
            .dragging()
    );
    block.key.message = "older-entry".into();
    block.content.text = "Older snapshot".into();
    deliver(
        &mut app,
        wire::Direction::Older,
        block,
        None,
        Some("current".into()),
    );
    let now = Instant::now();
    let paint = |app: &mut App| {
        let mut surface = std::mem::take(&mut instance_mut(app).surface);
        let mut terminal = Terminal::new(TestBackend::new(100, 35)).unwrap();
        terminal
            .draw(|frame| {
                region::paint(
                    frame,
                    &mut app.apps.readers,
                    &mut surface,
                    ui::Context {
                        colors: Default::default(),
                        ascii: false,
                        focused: false,
                    },
                    &app.i18n,
                    Some(now),
                );
            })
            .unwrap();
        instance_mut(app).surface = surface;
    };
    paint(&mut app);
    let mount = &app.apps.readers.mounts[&identity];
    assert!(mount.dirty);
    assert_eq!(mount.edge, Some(wire::Direction::Older));
    assert_eq!(
        mount.view.copy_text(CopyMode::Source, false).unwrap(),
        "Current visible text"
    );
    app.apps
        .readers
        .mounts
        .get_mut(&identity)
        .unwrap()
        .view
        .text_selection
        .end_drag();
    paint(&mut app);
    let mount = &app.apps.readers.mounts[&identity];
    assert!(!mount.dirty && mount.edge.is_none());
    assert_eq!(
        mount.view.copy_text(CopyMode::Source, false).unwrap(),
        "Older snapshot"
    );
    assert!(
        mount.view.motion_wait().is_none(),
        "a page never becomes a live reveal"
    );
    assert!(
        !mount.view.following(),
        "the applied older page keeps its reading anchor"
    );
}

mod retained;
