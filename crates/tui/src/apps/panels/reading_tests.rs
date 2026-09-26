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
use crate::apps::{Output, tests::app};
use crossterm::event::{KeyModifiers, MouseButton, MouseEvent};
use maka_plugins::terminal_ui::{
    Text, VERSION,
    view::{Reply, Tone, View, build::*},
};
use ratatui::{Terminal, backend::TestBackend, buffer::Buffer};
use serde_json::json;

fn reading(label: &str, count: usize, rows: u16) -> View {
    let mut content: Vec<_> = (0..count)
        .map(|index| {
            text(
                index.to_string(),
                format!("{label} row {index:02}"),
                Tone::Normal,
            )
        })
        .collect();
    content.push(link("next", "Continue reading", json!({"page":"b"})).into());
    let view = View {
        version: VERSION,
        title: label.into(),
        revision: label.into(),
        fields: vec![],
        actions: vec![],
        root: scroll("root", rows, stack("body", content)),
    };
    view.validate().unwrap();
    view
}

fn settle(app: &mut App) {
    for request in app.apps_requests() {
        let key = request.key.as_ref().unwrap();
        let view = if key.method == "sibling" {
            reading("Sibling", 30, 8)
        } else if key.route.is_null() {
            reading("First", 75, 28)
        } else {
            reading("Second", 40, 28)
        };
        app.apps_complete(request, Ok(Output::Reply(Reply::View { view })));
    }
}

fn draw(app: &mut App) -> Buffer {
    let mut terminal = Terminal::new(TestBackend::new(40, 40)).unwrap();
    app.apps.inspector_visible = true;
    terminal
        .draw(|frame| {
            let area = frame.area();
            draw_inspector(frame, app, area, "session");
        })
        .unwrap();
    terminal.backend().buffer().clone()
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

fn mouse(app: &mut App, kind: MouseEventKind, column: u16, row: u16) {
    let _ = app.inspector_input(&Event::Mouse(MouseEvent {
        kind,
        column,
        row,
        modifiers: KeyModifiers::NONE,
    }));
}

fn wheel(app: &mut App, path: &str, ticks: usize) {
    for _ in 0..ticks {
        let area = app.apps.inspector.viewport(path).unwrap();
        mouse(app, MouseEventKind::ScrollDown, area.x, area.y);
        draw(app);
    }
}

#[test]
fn panel_routes_own_reading_positions_without_moving_siblings_or_outer_scroll() {
    let mut app = app();
    for (order, method) in ["sibling", "reader"].into_iter().enumerate() {
        let mut entry = app.apps.directory[0].clone();
        entry.method = method.into();
        entry.target.registration = uuid::Uuid::new_v4();
        entry.descriptor.placement = Placement::Panel;
        entry.descriptor.order = order as u16;
        entry.descriptor.title = Text::plain(method);
        app.apps.directory.push(entry);
    }
    app.apply(Action::Visit(Route::Session("session".into())));
    app.navigate(crate::navigation::Intent::Inspector(true));
    settle(&mut app);
    app.focus = Focus::Inspector;
    draw(&mut app);
    let sibling = format!("{BODY}/example.notes:sibling/content/root");
    let reader = format!("{BODY}/example.notes:reader/content/root");
    wheel(&mut app, &sibling, 2);
    // Move the outer inspector too, without touching either inner scroll.
    mouse(&mut app, MouseEventKind::ScrollDown, 39, 20);
    draw(&mut app);
    wheel(&mut app, &reader, 30);
    let before = draw(&mut app);
    let sibling_area = app.apps.inspector.viewport(&sibling).unwrap();
    let reader_area = app.apps.inspector.viewport(&reader).unwrap();
    let sibling_text = text_at(&before, sibling_area);
    let first_text = text_at(&before, reader_area);
    assert!(sibling_text.contains("Sibling row 06"), "{sibling_text}");
    assert!(first_text.contains("Continue reading"), "{first_text}");
    let next = app
        .apps
        .inspector
        .rect(&format!("{reader}/body/next"))
        .unwrap();
    mouse(
        &mut app,
        MouseEventKind::Down(MouseButton::Left),
        next.x,
        next.y,
    );
    mouse(
        &mut app,
        MouseEventKind::Up(MouseButton::Left),
        next.x,
        next.y,
    );
    settle(&mut app);
    let second = draw(&mut app);
    assert_eq!(app.apps.inspector.viewport(&reader), Some(reader_area));
    assert_eq!(text_at(&second, sibling_area), sibling_text);
    let initial = text_at(&second, reader_area);
    assert!(
        initial.contains("Second row 00"),
        "a new route must start at its own beginning:\n{initial}"
    );
    wheel(&mut app, &reader, 3);
    let second_text = text_at(&draw(&mut app), reader_area);
    assert_ne!(second_text, initial);
    app.apply(Action::Back);
    settle(&mut app);
    let back = draw(&mut app);
    assert_eq!(app.apps.inspector.viewport(&reader), Some(reader_area));
    assert_eq!(text_at(&back, reader_area), first_text);
    assert_eq!(text_at(&back, sibling_area), sibling_text);
    app.apply(Action::Forward);
    settle(&mut app);
    let forward = draw(&mut app);
    assert_eq!(text_at(&forward, reader_area), second_text);
    assert_eq!(text_at(&forward, sibling_area), sibling_text);
}
