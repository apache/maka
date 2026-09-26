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
use crate::app::Focus;
use crossterm::event::{Event, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use maka_plugins::terminal_ui::{
    Text, VERSION,
    view::{Reply, Tone, View, build::*},
};
use ratatui::{buffer::Buffer, layout::Rect};
use serde_json::json;

mod host;
mod keyboard;
mod lifecycle;
mod settings;
use host::Host;

fn view(title: &str, root: maka_plugins::terminal_ui::view::Node) -> View {
    let view = View {
        version: VERSION,
        title: title.into(),
        revision: title.into(),
        fields: vec![],
        actions: vec![],
        root,
    };
    view.validate().unwrap();
    view
}

fn reading(title: &str, count: usize, rows: u16) -> View {
    let mut content: Vec<_> = (0..count)
        .map(|index| {
            text(
                index.to_string(),
                format!("{title} row {index:02}"),
                Tone::Normal,
            )
        })
        .collect();
    if title != "Sibling" {
        content.push(link("next", "Continue reading", json!({"page":"b"})).into());
    }
    view(title, scroll("root", rows, stack("body", content)))
}

fn settle(app: &mut App, parent_link: bool) {
    loop {
        let requests = app.apps_requests();
        if requests.is_empty() {
            break;
        }
        for request in requests {
            let key = request.key.as_ref().unwrap();
            let view = match key.method.as_str() {
                "container" => view(
                    "Container",
                    scroll(
                        "root",
                        52,
                        stack(
                            "body",
                            vec![
                                if parent_link {
                                    link("parent", "Parent route", Value::Null).into()
                                } else {
                                    text("parent", "Parent text", Tone::Normal)
                                },
                                slot("sibling", "stable", Value::Null),
                                slot("reader", "reading", Value::Null),
                                text(
                                    "footer",
                                    (0..40)
                                        .map(|index| format!("Footer {index:02}\n"))
                                        .collect::<String>(),
                                    Tone::Normal,
                                ),
                            ],
                        ),
                    ),
                ),
                "sibling" => reading("Sibling", 30, 8),
                "reader" if key.route.is_null() => reading("First", 75, 18),
                "reader" => reading("Second", 40, 18),
                method => panic!("unexpected reader {method}"),
            };
            app.apps_complete(request, Ok(Output::Reply(Reply::View { view })));
        }
    }
}

fn text_at(buffer: &Buffer, area: Rect) -> String {
    (area.y..area.bottom())
        .map(|row| {
            (area.x..area.right())
                .map(|column| buffer[(column, row)].symbol())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn fixture(host: Host) -> (App, Key) {
    let mut app = tests::app();
    let mut entry = app.apps.directory[0].clone();
    entry.method = "container".into();
    entry.descriptor.context = match host {
        Host::Inspector => Context::Session,
        _ => Context::Application,
    };
    entry.descriptor.placement = match host {
        Host::Inspector => Placement::Panel,
        Host::Settings => Placement::Settings,
        Host::Page => Placement::Page,
    };
    entry.descriptor.title = Text::plain("Container");
    let key = Key::of(&entry, Some("session")).unwrap();
    for (method, name) in [("sibling", "stable"), ("reader", "reading")] {
        let mut filler = entry.clone();
        filler.method = method.into();
        filler.target.registration = uuid::Uuid::new_v4();
        filler.descriptor.placement = Placement::Slot { name: name.into() };
        app.apps.directory.push(filler);
    }
    app.apps.directory.push(entry);
    match host {
        Host::Inspector => {
            app.apply(Action::Visit(Route::Session("session".into())));
            app.navigate(crate::navigation::Intent::Inspector(true));
            app.focus = Focus::Inspector;
        }
        Host::Settings => {
            app.apply(Action::Visit(Route::Settings));
            app.apply(Action::Settings(crate::pages::settings::Message::Pane(
                key.clone(),
            )));
        }
        Host::Page => {
            app.apps_action(Message::Open(key.clone()));
        }
    }
    (app, key)
}

fn verify(host: Host, parent_link: bool) {
    let (mut app, key) = fixture(host);
    settle(&mut app, parent_link);
    host.draw(&mut app, &key);
    let root = match host {
        Host::Inspector => format!("inspector/body/panels/{}/content/root", key.node()),
        Host::Settings => format!("settings/pane/frame/rows/{}/content/root", key.node()),
        Host::Page => "app/body/frame/content/root".into(),
    };
    let sibling = format!("{root}/body/sibling/example.notes:sibling/body/content/root");
    let reader = format!("{root}/body/reader/example.notes:reader/body/content/root");
    host.wheel(&mut app, &key, &sibling, 2);
    // Move the parent's own viewport at its right edge, outside both children.
    let outer = host.viewport(&app, &key, &root);
    host.mouse(
        &mut app,
        &key,
        MouseEventKind::ScrollDown,
        Rect::new(outer.right() - 1, outer.y, 1, 1),
    );
    host.draw(&mut app, &key);
    host.wheel(&mut app, &key, &reader, 30);
    let before = host.draw(&mut app, &key);
    let sibling_area = host.viewport(&app, &key, &sibling);
    let reader_area = host.viewport(&app, &key, &reader);
    let sibling_text = text_at(&before, sibling_area);
    let first_text = text_at(&before, reader_area);
    assert!(sibling_text.contains("Sibling row 06"), "{sibling_text}");
    assert!(first_text.contains("Continue reading"), "{first_text}");
    let next_path = format!("{reader}/body/next");
    let next = match host {
        Host::Inspector => app.apps.inspector.rect(&next_path),
        Host::Settings => app.settings.surface.rect(&next_path),
        Host::Page => app.apps.instances[&key].surface.rect(&next_path),
    }
    .unwrap();
    for kind in [
        MouseEventKind::Down(MouseButton::Left),
        MouseEventKind::Up(MouseButton::Left),
    ] {
        host.mouse(&mut app, &key, kind, next);
    }
    settle(&mut app, parent_link);
    let second = host.draw(&mut app, &key);
    assert_eq!(host.viewport(&app, &key, &reader), reader_area);
    assert_eq!(text_at(&second, sibling_area), sibling_text);
    let initial = text_at(&second, reader_area);
    assert!(
        initial.contains("Second row 00"),
        "a new child route must start at its own beginning:\n{initial}"
    );
    host.wheel(&mut app, &key, &reader, 3);
    let second_text = text_at(&host.draw(&mut app, &key), reader_area);
    assert_ne!(second_text, initial);
    for (action, expected) in [(Action::Back, first_text), (Action::Forward, second_text)] {
        app.apply(action);
        settle(&mut app, parent_link);
        let returned = host.draw(&mut app, &key);
        assert_eq!(host.viewport(&app, &key, &reader), reader_area);
        assert_eq!(text_at(&returned, reader_area), expected);
        assert_eq!(text_at(&returned, sibling_area), sibling_text);
    }
}

#[test]
fn inspector_slot_routes_own_their_reading_positions() {
    for parent_link in [true, false] {
        verify(Host::Inspector, parent_link);
    }
}
#[test]
fn settings_slot_routes_own_their_reading_positions() {
    for parent_link in [true, false] {
        verify(Host::Settings, parent_link);
    }
}
#[test]
fn page_slot_routes_own_their_reading_positions() {
    for parent_link in [true, false] {
        verify(Host::Page, parent_link);
    }
}
