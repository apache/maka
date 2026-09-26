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
use crate::ui::{Context, Surface};
use crossterm::event::{KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::{Terminal, backend::TestBackend, layout::Rect};

#[derive(Clone, Debug, PartialEq, Eq)]
enum Message {
    Select,
    Move,
}
fn model(state: &Collection) {
    state.model(
        vec!["todo".into(), "done".into()],
        vec![
            Entry {
                key: "a".into(),
                group: "todo".into(),
                title: "Alpha 中文".into(),
                summary: "First".into(),
            },
            Entry {
                key: "b".into(),
                group: "todo".into(),
                title: "Beta".into(),
                summary: "Second".into(),
            },
        ],
        None,
    );
}
fn draw(surface: &mut Surface<Message>, state: &Collection, width: u16) {
    let mut terminal = Terminal::new(TestBackend::new(width, 24)).unwrap();
    let tree = state.node(
        "root",
        &[
            ("todo".into(), "To do".into()),
            ("done".into(), "Done".into()),
        ],
        Some(("Filter", "Filter cards")),
        Message::Select,
        Some(Message::Move),
        width,
    );
    terminal
        .draw(|frame| {
            surface.render(
                frame,
                frame.area(),
                tree,
                Context {
                    colors: crate::theme::Palette::default(),
                    ascii: false,
                    focused: true,
                },
            )
        })
        .unwrap();
}
fn mouse(surface: &mut Surface<Message>, kind: MouseEventKind, rect: Rect) -> Option<Message> {
    surface
        .input(&Event::Mouse(MouseEvent {
            kind,
            column: rect.x + 1,
            row: rect.y,
            modifiers: KeyModifiers::NONE,
        }))
        .message
}
fn key(code: KeyCode) -> Event {
    Event::Key(KeyEvent::new(code, KeyModifiers::NONE))
}
#[test]
fn pointer_and_keyboard_preview_locally_then_commit_one_typed_move() {
    let state = Collection::default();
    model(&state);
    let mut surface = Surface::default();
    draw(&mut surface, &state, 90);
    assert_eq!(surface.input(&key(KeyCode::Tab)).message, None);
    assert_eq!(surface.focused(), Some("root/groups/todo/a"));
    let card = surface.rect("root/groups/todo/a").unwrap();
    let target = surface.rect("root/groups/done").unwrap();
    assert_eq!(
        mouse(&mut surface, MouseEventKind::Down(MouseButton::Left), card),
        None
    );
    assert_eq!(state.selected(), None, "pickup never reads details");
    assert_eq!(
        mouse(
            &mut surface,
            MouseEventKind::Drag(MouseButton::Left),
            target
        ),
        None
    );
    assert_eq!(state.visible()[1].group, "done");
    draw(&mut surface, &state, 90);
    assert_eq!(
        mouse(&mut surface, MouseEventKind::Up(MouseButton::Left), target),
        Some(Message::Move)
    );
    assert_eq!(
        state.take_move(),
        Some(Move {
            item: "a".into(),
            group: "done".into(),
            before: String::new()
        })
    );
    assert_eq!(state.take_move(), None);
    assert_eq!(
        mouse(&mut surface, MouseEventKind::Up(MouseButton::Left), target),
        None
    );
    draw(&mut surface, &state, 90);
    surface.focus("root/groups/todo/a".into());
    assert_eq!(surface.input(&key(KeyCode::Char(' '))).message, None);
    assert_eq!(surface.input(&key(KeyCode::Right)).message, None);
    assert_eq!(
        surface.input(&key(KeyCode::Enter)).message,
        Some(Message::Move)
    );
    assert_eq!(state.take_move().unwrap().group, "done");
    assert_eq!(
        surface.input(&key(KeyCode::Enter)).message,
        Some(Message::Select)
    );
    assert_eq!(surface.input(&key(KeyCode::Enter)).message, None);
}
#[test]
fn stale_geometry_occlusion_and_model_changes_cannot_commit_or_activate() {
    for interruption in 0..5 {
        let state = Collection::default();
        model(&state);
        let mut surface = Surface::default();
        draw(&mut surface, &state, 90);
        let card = surface.rect("root/groups/todo/a").unwrap();
        let target = surface.rect("root/groups/done").unwrap();
        mouse(&mut surface, MouseEventKind::Down(MouseButton::Left), card);
        mouse(
            &mut surface,
            MouseEventKind::Drag(MouseButton::Left),
            target,
        );
        match interruption {
            0 => {
                surface.input(&key(KeyCode::Esc));
            }
            1 => {
                surface.input(&Event::FocusLost);
            }
            2 => {
                draw(&mut surface, &state, 40);
            }
            3 => surface.occlude(card),
            _ => state.model(vec!["todo".into(), "done".into()], vec![], None),
        }
        assert_eq!(
            mouse(&mut surface, MouseEventKind::Up(MouseButton::Left), target),
            None
        );
        assert_eq!(state.take_move(), None);
        assert_eq!(state.selected(), None);
        assert!(!surface.dragging_collection());
    }
}
#[test]
fn query_selection_and_retention_are_bounded_by_the_current_model() {
    let collections = Collections::default();
    let state = collections.get("root");
    model(&state);
    state.select("a");
    state.edit(&Event::Paste("中文".into()));
    assert_eq!(state.visible().len(), 1);
    model(&state);
    assert_eq!(state.0.lock().unwrap().query.text(), "中文");
    assert_eq!(state.selected().as_deref(), Some("a"));
    state.edit(&Event::Paste("x".repeat(1000)));
    assert!(state.0.lock().unwrap().query.text().len() <= 256);
    let weak = Arc::downgrade(&state.0);
    drop(state);
    collections.retain(&[]);
    assert!(
        weak.upgrade().is_none(),
        "removed collection state and editor history are released"
    );
}
