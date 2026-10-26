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

use super::probe::{Capabilities, MouseCoordinates, PixelOrigin};
use gpui::{PlatformInput, point, px};
use std::time::{Duration, Instant};
use termina::{
    Event,
    event::{KeyCode, KeyEventKind, Modifiers, MouseButton, MouseEventKind},
};

#[derive(Default)]
pub(super) struct Mapping {
    last_click: Option<(MouseButton, gpui::Point<gpui::Pixels>, Instant, usize)>,
    clicks: usize,
}

impl Mapping {
    pub fn input(&mut self, event: &Event, caps: Capabilities) -> Option<PlatformInput> {
        match event {
            Event::Key(event) => {
                let mut modifiers = modifiers(event.modifiers);
                let (key, key_char) = match event.code {
                    KeyCode::Char(character) => (
                        if character == ' ' {
                            "space".into()
                        } else {
                            character.to_lowercase().collect()
                        },
                        (!modifiers.control && !modifiers.alt && !modifiers.platform)
                            .then(|| character.to_string()),
                    ),
                    KeyCode::BackTab => {
                        modifiers.shift = true;
                        ("tab".into(), None)
                    }
                    KeyCode::Function(n) => (format!("f{n}"), None),
                    KeyCode::Enter => ("enter".into(), None),
                    KeyCode::Backspace => ("backspace".into(), None),
                    KeyCode::Tab => ("tab".into(), None),
                    KeyCode::Escape => ("escape".into(), None),
                    KeyCode::Left => ("left".into(), None),
                    KeyCode::Right => ("right".into(), None),
                    KeyCode::Up => ("up".into(), None),
                    KeyCode::Down => ("down".into(), None),
                    KeyCode::Home => ("home".into(), None),
                    KeyCode::End => ("end".into(), None),
                    KeyCode::PageUp => ("pageup".into(), None),
                    KeyCode::PageDown => ("pagedown".into(), None),
                    KeyCode::Insert => ("insert".into(), None),
                    KeyCode::Delete => ("delete".into(), None),
                    KeyCode::KeypadBegin => ("clear".into(), None),
                    KeyCode::CapsLock
                    | KeyCode::ScrollLock
                    | KeyCode::NumLock
                    | KeyCode::PrintScreen
                    | KeyCode::Pause
                    | KeyCode::Menu
                    | KeyCode::Null
                    | KeyCode::Modifier(_)
                    | KeyCode::Media(_) => return None,
                };
                let keystroke = gpui::Keystroke {
                    modifiers,
                    key,
                    key_char,
                };
                Some(match event.kind {
                    KeyEventKind::Release => PlatformInput::KeyUp(gpui::KeyUpEvent { keystroke }),
                    KeyEventKind::Press | KeyEventKind::Repeat => {
                        PlatformInput::KeyDown(gpui::KeyDownEvent {
                            keystroke,
                            is_held: event.kind == KeyEventKind::Repeat,
                            prefer_character_input: false,
                        })
                    }
                })
            }
            Event::SgrMouse(mouse) => {
                let position = mouse_position(event, caps)?;
                Some(self.mouse(mouse.kind, mouse.modifiers, position))
            }
            Event::Mouse(mouse) => {
                let position = mouse_position(event, caps)?;
                Some(self.mouse(mouse.kind, mouse.modifiers, position))
            }
            Event::MouseLeave => None,
            Event::WindowResized(_)
            | Event::FocusIn
            | Event::FocusOut
            | Event::Paste(_)
            | Event::Csi(_)
            | Event::Osc(_)
            | Event::Dcs(_)
            | Event::Iterm2Capabilities(_)
            | Event::KittyGraphicsResponse(_) => None,
        }
    }

    fn mouse(
        &mut self,
        kind: MouseEventKind,
        mods: Modifiers,
        position: gpui::Point<gpui::Pixels>,
    ) -> PlatformInput {
        let modifiers = modifiers(mods);
        match kind {
            MouseEventKind::Down(button) => {
                let now = Instant::now();
                self.clicks = self
                    .last_click
                    .filter(|(last, at, time, _)| {
                        *last == button
                            && now.duration_since(*time) < Duration::from_millis(400)
                            && f32::from((at.x - position.x).abs()) <= 4.0
                            && f32::from((at.y - position.y).abs()) <= 4.0
                    })
                    .map_or(1, |(_, _, _, clicks)| clicks % 3 + 1);
                self.last_click = Some((button, position, now, self.clicks));
                PlatformInput::MouseDown(gpui::MouseDownEvent {
                    button: mouse_button(button),
                    position,
                    modifiers,
                    click_count: self.clicks,
                    first_mouse: false,
                })
            }
            MouseEventKind::Up(button) => PlatformInput::MouseUp(gpui::MouseUpEvent {
                button: mouse_button(button),
                position,
                modifiers,
                click_count: self.clicks.max(1),
            }),
            MouseEventKind::Drag(button) => PlatformInput::MouseMove(gpui::MouseMoveEvent {
                position,
                pressed_button: Some(mouse_button(button)),
                modifiers,
            }),
            MouseEventKind::Moved => PlatformInput::MouseMove(gpui::MouseMoveEvent {
                position,
                pressed_button: None,
                modifiers,
            }),
            MouseEventKind::ScrollUp
            | MouseEventKind::ScrollDown
            | MouseEventKind::ScrollLeft
            | MouseEventKind::ScrollRight => {
                let (x, y) = match kind {
                    MouseEventKind::ScrollUp => (0.0, 3.0),
                    MouseEventKind::ScrollDown => (0.0, -3.0),
                    MouseEventKind::ScrollLeft => (3.0, 0.0),
                    MouseEventKind::ScrollRight => (-3.0, 0.0),
                    _ => unreachable!(),
                };
                PlatformInput::ScrollWheel(gpui::ScrollWheelEvent {
                    position,
                    modifiers,
                    delta: gpui::ScrollDelta::Lines(point(x, y)),
                    touch_phase: gpui::TouchPhase::Moved,
                })
            }
        }
    }
}

/// Shared by input admission and native dispatch, using actual terminal units.
pub(super) fn mouse_position(
    event: &Event,
    caps: Capabilities,
) -> Option<gpui::Point<gpui::Pixels>> {
    let position = match event {
        Event::SgrMouse(mouse) => {
            let position = match caps.mouse {
                MouseCoordinates::Pixels(origin) => {
                    let offset = match origin {
                        PixelOrigin::Zero => 0.0,
                        PixelOrigin::One => 1.0,
                    };
                    // Preserve negative release/drag coordinates outside the
                    // canvas. Wire zero is outside a one-based pixel grid.
                    point(px(mouse.x as f32 - offset), px(mouse.y as f32 - offset))
                }
                MouseCoordinates::Cells => {
                    let x = u16::try_from(mouse.x).ok()?.checked_sub(1)?;
                    let y = u16::try_from(mouse.y).ok()?.checked_sub(1)?;
                    cell_centre(x, y, caps)?
                }
            };
            Some(position)
        }
        Event::Mouse(mouse) => cell_centre(mouse.column, mouse.row, caps),
        _ => None,
    }?;
    Some(position / caps.scale_factor())
}

fn cell_centre(x: u16, y: u16, caps: Capabilities) -> Option<gpui::Point<gpui::Pixels>> {
    if caps.size.cols == 0 || caps.size.rows == 0 {
        return None;
    }
    Some(point(
        px((f32::from(x) + 0.5) * f32::from(caps.size.pixel_width?) / f32::from(caps.size.cols)),
        px((f32::from(y) + 0.5) * f32::from(caps.size.pixel_height?) / f32::from(caps.size.rows)),
    ))
}

fn mouse_button(button: MouseButton) -> gpui::MouseButton {
    match button {
        MouseButton::Left => gpui::MouseButton::Left,
        MouseButton::Right => gpui::MouseButton::Right,
        MouseButton::Middle => gpui::MouseButton::Middle,
    }
}

fn modifiers(modifiers: Modifiers) -> gpui::Modifiers {
    gpui::Modifiers {
        control: modifiers.contains(Modifiers::CONTROL),
        alt: modifiers.contains(Modifiers::ALT),
        shift: modifiers.contains(Modifiers::SHIFT),
        platform: modifiers.intersects(Modifiers::SUPER | Modifiers::META),
        function: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::num::NonZeroU32;

    #[test]
    fn pixel_zero_and_negative_release_coordinates_do_not_take_the_cell_conversion() {
        let caps = Capabilities {
            size: termina::WindowSize {
                cols: 120,
                rows: 40,
                pixel_width: Some(960),
                pixel_height: Some(640),
            },
            mouse: MouseCoordinates::Pixels(PixelOrigin::Zero),
            protocol: None,
            synchronized: false,
            sixel_geometry: Default::default(),
            ui_scale: 1.0,
        };
        let mut mapping = Mapping::default();
        let raw = |x, y| {
            Event::SgrMouse(termina::event::SgrMouseEvent {
                kind: MouseEventKind::Up(MouseButton::Left),
                x,
                y,
                modifiers: Modifiers::NONE,
            })
        };
        for (raw_x, raw_y, x, y) in [(1, 1, 0.0, 0.0), (0, 0, -1.0, -1.0), (-5, 650, -6.0, 649.0)] {
            let Some(PlatformInput::MouseUp(event)) = mapping.input(
                &raw(raw_x, raw_y),
                Capabilities {
                    mouse: MouseCoordinates::Pixels(PixelOrigin::One),
                    ..caps
                },
            ) else {
                panic!("one-based physical release is preserved");
            };
            assert_eq!(
                (f32::from(event.position.x), f32::from(event.position.y)),
                (x, y)
            );
        }
        for (x, y) in [(0, 0), (-5, 650)] {
            let Some(PlatformInput::MouseUp(event)) = mapping.input(&raw(x, y), caps) else {
                panic!("physical release is preserved");
            };
            assert_eq!(
                (f32::from(event.position.x), f32::from(event.position.y)),
                (x as f32, y as f32)
            );
        }
        let Some(PlatformInput::MouseUp(event)) = mapping.input(
            &raw(1, 1),
            Capabilities {
                mouse: MouseCoordinates::Cells,
                ..caps
            },
        ) else {
            panic!("cell release maps to its centre");
        };
        assert_eq!(
            (f32::from(event.position.x), f32::from(event.position.y)),
            (4.0, 8.0)
        );
        assert!(
            mapping
                .input(
                    &raw(0, 1),
                    Capabilities {
                        mouse: MouseCoordinates::Cells,
                        ..caps
                    }
                )
                .is_none()
        );
        let letterbox = Capabilities {
            protocol: Some(super::super::probe::Protocol::Sixel),
            sixel_geometry: super::super::probe::SixelGeometry::Finite {
                width: NonZeroU32::new(400).unwrap(),
                height: NonZeroU32::new(300).unwrap(),
            },
            ..caps
        };
        let Some(PlatformInput::MouseUp(event)) = mapping.input(
            &raw(51, 1),
            Capabilities {
                mouse: MouseCoordinates::Cells,
                ..letterbox
            },
        ) else {
            panic!("the real cell centre remains unscaled in a letterbox");
        };
        assert_eq!(
            (f32::from(event.position.x), f32::from(event.position.y)),
            (404.0, 8.0)
        );
        assert!(!letterbox.contains(event.position));
        let drag = Event::SgrMouse(termina::event::SgrMouseEvent {
            kind: MouseEventKind::Drag(MouseButton::Left),
            x: -5,
            y: 650,
            modifiers: Modifiers::NONE,
        });
        let Some(PlatformInput::MouseMove(event)) = mapping.input(&drag, letterbox) else {
            panic!("a captured drag keeps its physical position outside the canvas");
        };
        assert_eq!(event.pressed_button, Some(gpui::MouseButton::Left));
        assert_eq!(
            (f32::from(event.position.x), f32::from(event.position.y)),
            (-5.0, 650.0)
        );
    }
}

#[cfg(test)]
mod density_tests {
    use super::*;

    #[test]
    fn cell_and_both_pixel_origins_share_the_scaled_logical_canvas() {
        for cell_height in [16, 32, 35, 48] {
            let caps = Capabilities {
                size: termina::WindowSize {
                    cols: 80,
                    rows: 40,
                    pixel_width: Some(80 * cell_height / 2),
                    pixel_height: Some(40 * cell_height),
                },
                mouse: MouseCoordinates::Cells,
                protocol: None,
                synchronized: false,
                sixel_geometry: Default::default(),
                ui_scale: 1.0,
            };
            assert_eq!(caps.scale_factor(), f32::from(cell_height) / 16.0);
            assert_eq!(
                caps.logical_viewport(),
                Some(gpui::size(px(640.0), px(640.0)))
            );
            let event = |x, y| {
                Event::SgrMouse(termina::event::SgrMouseEvent {
                    kind: MouseEventKind::Down(MouseButton::Left),
                    x,
                    y,
                    modifiers: Modifiers::NONE,
                })
            };
            let position = mouse_position(&event(3, 4), caps).unwrap();
            assert_eq!(position, point(px(20.0), px(56.0)));
            for origin in [PixelOrigin::Zero, PixelOrigin::One] {
                let offset = i32::from(origin == PixelOrigin::One);
                let raw_x = f32::from(position.x) * caps.scale_factor();
                let raw_y = f32::from(position.y) * caps.scale_factor();
                // The odd-height cell has half-pixel centres; pixel protocols
                // have integer coordinates, so use a nearby exact UI point.
                let actual = mouse_position(
                    &event(raw_x as i32 + offset, raw_y as i32 + offset),
                    Capabilities {
                        mouse: MouseCoordinates::Pixels(origin),
                        ..caps
                    },
                )
                .unwrap();
                assert!((actual.x - position.x).abs() <= px(1.0 / caps.scale_factor()));
                assert!((actual.y - position.y).abs() <= px(1.0 / caps.scale_factor()));
            }
            assert!(caps.contains(position));
            assert!(!caps.contains(point(px(640.0), px(0.0))));
            let zoomed = Capabilities {
                ui_scale: 1.25,
                ..caps
            };
            assert_eq!(
                zoomed.logical_viewport(),
                Some(gpui::size(px(512.0), px(512.0)))
            );
            assert_eq!(
                mouse_position(&event(3, 4), zoomed),
                Some(point(px(16.0), px(44.8)))
            );
        }
    }
}
