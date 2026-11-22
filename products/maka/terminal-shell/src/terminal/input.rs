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

use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
use std::collections::VecDeque;

// Yield the input lock between read slices; this is not a queue limit.
pub(super) const READ_BATCH: usize = 128;

#[derive(Default)]
pub(super) struct Inbox {
    events: VecDeque<Event>,
    pub resize: Option<(u16, u16)>,
    pub graphics: super::graphics::Probe,
    pub cancel_pointer: bool,
    pub error: Option<String>,
    pub quit: bool,
    pub pixel_probe: super::pixels::Probe,
    pub pixels: Option<super::pixels::Inbox>,
    pub trace: Option<super::frame_trace::Trace>,
}

impl Inbox {
    pub fn push_terminal(&mut self, event: termina::Event) {
        if matches!(event, termina::Event::MouseLeave) {
            self.lose_pointer();
        } else if let Some(event) = super::adapter::event(event) {
            self.push(event);
        }
    }

    pub fn push(&mut self, event: Event) {
        if let Event::Key(key) = event
            && key.kind != KeyEventKind::Release
            && key.modifiers.contains(KeyModifiers::CONTROL)
            && key.code == KeyCode::Char('q')
        {
            self.quit = true;
            return;
        }
        if let Event::Resize(columns, rows) = event {
            self.graphics.resize();
            self.resize = Some((columns, rows));
            // Coordinates read before resize no longer describe the viewport.
            self.lose_pointer();
            return;
        }
        if self.error.is_none() {
            self.events.push_back(event);
        }
    }

    fn lose_pointer(&mut self) {
        self.cancel_pointer = true;
        self.events
            .retain(|event| !matches!(event, Event::Mouse(_)));
    }

    pub fn pop_batch(&mut self) -> Vec<Event> {
        self.events.drain(..).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyEvent, MouseButton, MouseEvent, MouseEventKind};

    fn key(character: char) -> Event {
        Event::Key(KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE))
    }

    fn mouse(kind: MouseEventKind) -> Event {
        Event::Mouse(MouseEvent {
            kind,
            column: 1,
            row: 1,
            modifiers: KeyModifiers::NONE,
        })
    }

    #[test]
    fn keyboard_bursts_keep_their_order_without_blocking_resize_or_cancel() {
        let mut inbox = Inbox::default();
        let text = "a你b界".repeat(1024);
        for character in text.chars() {
            inbox.push(key(character));
        }
        inbox.push(Event::Resize(20, 4));
        inbox.push(Event::Resize(80, 20));
        inbox.push(Event::Key(KeyEvent::new(
            KeyCode::Char('q'),
            KeyModifiers::CONTROL,
        )));
        assert_eq!(inbox.resize, Some((80, 20)));
        assert!(inbox.cancel_pointer);
        assert!(inbox.quit);
        assert_eq!(inbox.pop_batch(), text.chars().map(key).collect::<Vec<_>>());
    }

    #[test]
    fn complete_large_paste_keeps_literal_unicode_in_one_ordered_event() {
        let mut inbox = Inbox::default();
        let text = "你好\nworld\t😀".repeat(32768);
        let expected = vec![key('a'), Event::Paste(text), key('b')];
        for event in expected.iter().cloned() {
            inbox.push(event);
        }
        assert_eq!(inbox.pop_batch(), expected);
    }

    #[test]
    fn pointer_and_key_bursts_keep_every_physical_event_in_order() {
        let mut inbox = Inbox::default();
        let expected = vec![
            mouse(MouseEventKind::Moved),
            mouse(MouseEventKind::Down(MouseButton::Left)),
            mouse(MouseEventKind::Drag(MouseButton::Left)),
            mouse(MouseEventKind::Up(MouseButton::Left)),
            mouse(MouseEventKind::ScrollDown),
            key('x'),
            mouse(MouseEventKind::Moved),
        ];
        for event in expected.iter().cloned() {
            inbox.push(event);
        }
        assert_eq!(inbox.pop_batch(), expected);
    }

    #[test]
    fn physical_leave_retires_old_mouse_events_without_losing_keyboard_or_paste() {
        use termina::event as tm;

        let mut inbox = Inbox::default();
        inbox.push(key('a'));
        inbox.push(mouse(MouseEventKind::Down(MouseButton::Left)));
        inbox.push(Event::Paste("你好 draft".into()));
        inbox.push(mouse(MouseEventKind::Up(MouseButton::Left)));
        inbox.push_terminal(termina::Event::MouseLeave);
        assert!(inbox.cancel_pointer);
        assert_eq!(inbox.resize, None, "leave does not resize or change focus");
        assert_eq!(
            inbox.pop_batch(),
            vec![key('a'), Event::Paste("你好 draft".into())]
        );

        let activation = super::super::activation::Activation::default();
        let mut reported = activation.subscribe();
        assert!(!activation.foreground(), "startup has no focus evidence");
        let pointer = |kind| {
            termina::Event::SgrMouse(tm::SgrMouseEvent {
                kind,
                x: 1,
                y: 1,
                modifiers: tm::Modifiers::NONE,
            })
        };
        let mut release = tm::KeyEvent::new(tm::KeyCode::Char('a'), tm::Modifiers::NONE);
        release.kind = tm::KeyEventKind::Release;
        for (event, expected) in [
            (termina::Event::FocusIn, true),
            (termina::Event::MouseLeave, true),
            (termina::Event::FocusOut, false),
            (pointer(tm::MouseEventKind::Moved), false),
            (pointer(tm::MouseEventKind::ScrollDown), false),
            (termina::Event::Key(release), false),
            (
                pointer(tm::MouseEventKind::Down(tm::MouseButton::Left)),
                true,
            ),
            (termina::Event::FocusOut, false),
            (
                termina::Event::Key(tm::KeyEvent::new(
                    tm::KeyCode::Char('a'),
                    tm::Modifiers::NONE,
                )),
                true,
            ),
            (termina::Event::FocusOut, false),
        ] {
            activation.observe(&event);
            // The getter revokes foreground before any queued UI callback.
            assert_eq!(activation.foreground(), expected, "{event:?}");
            assert_eq!(*reported.borrow_and_update(), expected, "{event:?}");
        }
        assert!(!reported.has_changed().unwrap());
    }

    #[test]
    fn resize_retires_old_coordinates_and_keeps_new_viewport_input() {
        let mut inbox = Inbox::default();
        inbox.push(mouse(MouseEventKind::Down(MouseButton::Left)));
        inbox.push(key('a'));
        inbox.push(Event::Resize(80, 20));
        inbox.push(mouse(MouseEventKind::Down(MouseButton::Left)));
        inbox.push(mouse(MouseEventKind::Up(MouseButton::Left)));
        assert_eq!(inbox.resize, Some((80, 20)));
        assert!(inbox.cancel_pointer);
        assert_eq!(
            inbox.pop_batch(),
            vec![
                key('a'),
                mouse(MouseEventKind::Down(MouseButton::Left)),
                mouse(MouseEventKind::Up(MouseButton::Left)),
            ]
        );
    }
}
