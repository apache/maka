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

use crossterm::event as ct;
use termina::event as tm;

/// Keep NSH's ordinary input contract while protocol replies stay with the reader.
/// Exhaustive matches make a new ordinary Termina event a compile-time decision.
pub(super) fn event(event: termina::Event) -> Option<ct::Event> {
    Some(match event {
        termina::Event::Key(key) => ct::Event::Key(ct::KeyEvent {
            code: key_code(key.code),
            modifiers: modifiers(key.modifiers),
            kind: match key.kind {
                tm::KeyEventKind::Press => ct::KeyEventKind::Press,
                tm::KeyEventKind::Release => ct::KeyEventKind::Release,
                tm::KeyEventKind::Repeat => ct::KeyEventKind::Repeat,
            },
            state: key_state(key.state, key.modifiers),
        }),
        termina::Event::Mouse(mouse) => ct::Event::Mouse(ct::MouseEvent {
            kind: match mouse.kind {
                tm::MouseEventKind::Down(button) => ct::MouseEventKind::Down(mouse_button(button)),
                tm::MouseEventKind::Up(button) => ct::MouseEventKind::Up(mouse_button(button)),
                tm::MouseEventKind::Drag(button) => ct::MouseEventKind::Drag(mouse_button(button)),
                tm::MouseEventKind::Moved => ct::MouseEventKind::Moved,
                tm::MouseEventKind::ScrollDown => ct::MouseEventKind::ScrollDown,
                tm::MouseEventKind::ScrollUp => ct::MouseEventKind::ScrollUp,
                tm::MouseEventKind::ScrollLeft => ct::MouseEventKind::ScrollLeft,
                tm::MouseEventKind::ScrollRight => ct::MouseEventKind::ScrollRight,
            },
            column: mouse.column,
            row: mouse.row,
            modifiers: modifiers(mouse.modifiers),
        }),
        termina::Event::SgrMouse(mouse) => {
            // Character input uses one-based SGR 1006 cells. Pixel input
            // keeps its signed wire coordinates outside this adapter.
            let column = u16::try_from(mouse.x).ok()?.saturating_sub(1);
            let row = u16::try_from(mouse.y).ok()?.saturating_sub(1);
            return self::event(termina::Event::Mouse(tm::MouseEvent {
                kind: mouse.kind,
                column,
                row,
                modifiers: mouse.modifiers,
            }));
        }
        termina::Event::WindowResized(size) => ct::Event::Resize(size.cols, size.rows),
        termina::Event::FocusIn => ct::Event::FocusGained,
        termina::Event::FocusOut => ct::Event::FocusLost,
        termina::Event::Paste(text) => ct::Event::Paste(text),
        termina::Event::Csi(_)
        | termina::Event::Osc(_)
        | termina::Event::Dcs(_)
        | termina::Event::Iterm2Capabilities(_)
        | termina::Event::KittyGraphicsResponse(_)
        | termina::Event::MouseLeave => return None,
    })
}

fn modifiers(modifiers: tm::Modifiers) -> ct::KeyModifiers {
    let mut result = ct::KeyModifiers::NONE;
    for (source, target) in [
        (tm::Modifiers::SHIFT, ct::KeyModifiers::SHIFT),
        (tm::Modifiers::ALT, ct::KeyModifiers::ALT),
        (tm::Modifiers::CONTROL, ct::KeyModifiers::CONTROL),
        (tm::Modifiers::SUPER, ct::KeyModifiers::SUPER),
        (tm::Modifiers::HYPER, ct::KeyModifiers::HYPER),
        (tm::Modifiers::META, ct::KeyModifiers::META),
    ] {
        if modifiers.contains(source) {
            result |= target;
        }
    }
    result
}

fn key_state(state: tm::KeyEventState, modifiers: tm::Modifiers) -> ct::KeyEventState {
    let mut result = ct::KeyEventState::NONE;
    if state.contains(tm::KeyEventState::KEYPAD) {
        result |= ct::KeyEventState::KEYPAD;
    }
    // Termina can carry locks in either field; Crossterm represents them only as key state.
    if state.contains(tm::KeyEventState::CAPS_LOCK) || modifiers.contains(tm::Modifiers::CAPS_LOCK)
    {
        result |= ct::KeyEventState::CAPS_LOCK;
    }
    if state.contains(tm::KeyEventState::NUM_LOCK) || modifiers.contains(tm::Modifiers::NUM_LOCK) {
        result |= ct::KeyEventState::NUM_LOCK;
    }
    result
}

fn mouse_button(button: tm::MouseButton) -> ct::MouseButton {
    match button {
        tm::MouseButton::Left => ct::MouseButton::Left,
        tm::MouseButton::Right => ct::MouseButton::Right,
        tm::MouseButton::Middle => ct::MouseButton::Middle,
    }
}

fn key_code(code: tm::KeyCode) -> ct::KeyCode {
    match code {
        tm::KeyCode::Char(character) => ct::KeyCode::Char(character),
        tm::KeyCode::Enter => ct::KeyCode::Enter,
        tm::KeyCode::Backspace => ct::KeyCode::Backspace,
        tm::KeyCode::Tab => ct::KeyCode::Tab,
        tm::KeyCode::Escape => ct::KeyCode::Esc,
        tm::KeyCode::Left => ct::KeyCode::Left,
        tm::KeyCode::Right => ct::KeyCode::Right,
        tm::KeyCode::Up => ct::KeyCode::Up,
        tm::KeyCode::Down => ct::KeyCode::Down,
        tm::KeyCode::Home => ct::KeyCode::Home,
        tm::KeyCode::End => ct::KeyCode::End,
        tm::KeyCode::BackTab => ct::KeyCode::BackTab,
        tm::KeyCode::PageUp => ct::KeyCode::PageUp,
        tm::KeyCode::PageDown => ct::KeyCode::PageDown,
        tm::KeyCode::Insert => ct::KeyCode::Insert,
        tm::KeyCode::Delete => ct::KeyCode::Delete,
        tm::KeyCode::KeypadBegin => ct::KeyCode::KeypadBegin,
        tm::KeyCode::CapsLock => ct::KeyCode::CapsLock,
        tm::KeyCode::ScrollLock => ct::KeyCode::ScrollLock,
        tm::KeyCode::NumLock => ct::KeyCode::NumLock,
        tm::KeyCode::PrintScreen => ct::KeyCode::PrintScreen,
        tm::KeyCode::Pause => ct::KeyCode::Pause,
        tm::KeyCode::Menu => ct::KeyCode::Menu,
        tm::KeyCode::Null => ct::KeyCode::Null,
        tm::KeyCode::Function(number) => ct::KeyCode::F(number),
        tm::KeyCode::Modifier(modifier) => ct::KeyCode::Modifier(match modifier {
            tm::ModifierKeyCode::LeftShift => ct::ModifierKeyCode::LeftShift,
            tm::ModifierKeyCode::LeftControl => ct::ModifierKeyCode::LeftControl,
            tm::ModifierKeyCode::LeftAlt => ct::ModifierKeyCode::LeftAlt,
            tm::ModifierKeyCode::LeftSuper => ct::ModifierKeyCode::LeftSuper,
            tm::ModifierKeyCode::LeftHyper => ct::ModifierKeyCode::LeftHyper,
            tm::ModifierKeyCode::LeftMeta => ct::ModifierKeyCode::LeftMeta,
            tm::ModifierKeyCode::RightShift => ct::ModifierKeyCode::RightShift,
            tm::ModifierKeyCode::RightControl => ct::ModifierKeyCode::RightControl,
            tm::ModifierKeyCode::RightAlt => ct::ModifierKeyCode::RightAlt,
            tm::ModifierKeyCode::RightSuper => ct::ModifierKeyCode::RightSuper,
            tm::ModifierKeyCode::RightHyper => ct::ModifierKeyCode::RightHyper,
            tm::ModifierKeyCode::RightMeta => ct::ModifierKeyCode::RightMeta,
            tm::ModifierKeyCode::IsoLevel3Shift => ct::ModifierKeyCode::IsoLevel3Shift,
            tm::ModifierKeyCode::IsoLevel5Shift => ct::ModifierKeyCode::IsoLevel5Shift,
        }),
        tm::KeyCode::Media(media) => ct::KeyCode::Media(match media {
            tm::MediaKeyCode::Play => ct::MediaKeyCode::Play,
            tm::MediaKeyCode::Pause => ct::MediaKeyCode::Pause,
            tm::MediaKeyCode::PlayPause => ct::MediaKeyCode::PlayPause,
            tm::MediaKeyCode::Reverse => ct::MediaKeyCode::Reverse,
            tm::MediaKeyCode::Stop => ct::MediaKeyCode::Stop,
            tm::MediaKeyCode::FastForward => ct::MediaKeyCode::FastForward,
            tm::MediaKeyCode::Rewind => ct::MediaKeyCode::Rewind,
            tm::MediaKeyCode::TrackNext => ct::MediaKeyCode::TrackNext,
            tm::MediaKeyCode::TrackPrevious => ct::MediaKeyCode::TrackPrevious,
            tm::MediaKeyCode::Record => ct::MediaKeyCode::Record,
            tm::MediaKeyCode::LowerVolume => ct::MediaKeyCode::LowerVolume,
            tm::MediaKeyCode::RaiseVolume => ct::MediaKeyCode::RaiseVolume,
            tm::MediaKeyCode::MuteVolume => ct::MediaKeyCode::MuteVolume,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interleaved_replies_do_not_change_ordinary_input_or_pasted_escape_sequences() {
        let mut parser = termina::Parser::default();
        parser
            .parse(
                "中\u{1b}[1;5A\u{1b}[?1;4c\u{1b}[<20;1;2M\u{1b}[6;16;8t\u{1b}[I\u{1b}[200~literal\u{1b}[?1;4c\n尾\u{1b}[201~\u{1b}[O".as_bytes(),
                false,
            )
            .unwrap();
        let mut actual = Vec::new();
        while let Some(parsed) = parser.pop() {
            if let Some(mapped) = event(parsed) {
                actual.push(mapped);
            }
        }
        assert_eq!(
            actual,
            vec![
                ct::Event::Key(ct::KeyEvent::new(
                    ct::KeyCode::Char('中'),
                    ct::KeyModifiers::NONE
                )),
                ct::Event::Key(ct::KeyEvent::new(
                    ct::KeyCode::Up,
                    ct::KeyModifiers::CONTROL
                )),
                ct::Event::Mouse(ct::MouseEvent {
                    kind: ct::MouseEventKind::Down(ct::MouseButton::Left),
                    column: 0,
                    row: 1,
                    modifiers: ct::KeyModifiers::SHIFT | ct::KeyModifiers::CONTROL,
                }),
                ct::Event::FocusGained,
                ct::Event::Paste("literal\u{1b}[?1;4c\n尾".to_owned()),
                ct::Event::FocusLost,
            ]
        );
    }

    #[test]
    fn key_lifecycle_and_locks_preserve_state_without_reinterpreting_bit_positions() {
        for (kind, expected) in [
            (tm::KeyEventKind::Press, ct::KeyEventKind::Press),
            (tm::KeyEventKind::Repeat, ct::KeyEventKind::Repeat),
            (tm::KeyEventKind::Release, ct::KeyEventKind::Release),
        ] {
            let Some(ct::Event::Key(mapped)) = event(termina::Event::Key(tm::KeyEvent {
                code: tm::KeyCode::Char('Ä'),
                kind,
                modifiers: tm::Modifiers::ALT | tm::Modifiers::META | tm::Modifiers::CAPS_LOCK,
                state: tm::KeyEventState::KEYPAD | tm::KeyEventState::NUM_LOCK,
            })) else {
                panic!("ordinary key must remain a key");
            };
            assert_eq!(mapped.code, ct::KeyCode::Char('Ä'));
            assert_eq!(
                mapped.modifiers,
                ct::KeyModifiers::ALT | ct::KeyModifiers::META
            );
            assert_eq!(mapped.kind, expected);
            assert_eq!(
                mapped.state,
                ct::KeyEventState::KEYPAD
                    | ct::KeyEventState::CAPS_LOCK
                    | ct::KeyEventState::NUM_LOCK
            );
        }
    }

    #[test]
    fn all_wheel_directions_and_boundary_coordinates_remain_mouse_input() {
        for (kind, expected) in [
            (tm::MouseEventKind::ScrollUp, ct::MouseEventKind::ScrollUp),
            (
                tm::MouseEventKind::ScrollDown,
                ct::MouseEventKind::ScrollDown,
            ),
            (
                tm::MouseEventKind::ScrollLeft,
                ct::MouseEventKind::ScrollLeft,
            ),
            (
                tm::MouseEventKind::ScrollRight,
                ct::MouseEventKind::ScrollRight,
            ),
        ] {
            assert_eq!(
                event(termina::Event::Mouse(tm::MouseEvent {
                    kind,
                    column: u16::MAX,
                    row: 0,
                    modifiers: tm::Modifiers::CONTROL | tm::Modifiers::SUPER,
                })),
                Some(ct::Event::Mouse(ct::MouseEvent {
                    kind: expected,
                    column: u16::MAX,
                    row: 0,
                    modifiers: ct::KeyModifiers::CONTROL | ct::KeyModifiers::SUPER,
                }))
            );
        }
    }

    #[test]
    fn raw_sgr_cell_coordinates_are_converted_once_without_wrapping() {
        let sgr = |x, y| {
            termina::Event::SgrMouse(tm::SgrMouseEvent {
                kind: tm::MouseEventKind::Down(tm::MouseButton::Left),
                x,
                y,
                modifiers: tm::Modifiers::NONE,
            })
        };
        assert_eq!(
            event(sgr(1, 1)),
            Some(ct::Event::Mouse(ct::MouseEvent {
                kind: ct::MouseEventKind::Down(ct::MouseButton::Left),
                column: 0,
                row: 0,
                modifiers: ct::KeyModifiers::NONE,
            }))
        );
        for (x, y) in [(-1, 1), (1, -1), (65536, 1), (1, 65536)] {
            assert!(event(sgr(x, y)).is_none());
        }
        assert!(event(termina::Event::MouseLeave).is_none());
    }
}
