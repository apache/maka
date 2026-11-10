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

use super::{InputError, Modifiers};
use crate::terminal::{MouseEncoding, MouseTracking, TerminalInputModes, TerminalSize};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MouseButton {
    Left,
    Middle,
    Right,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScrollDirection {
    Up,
    Down,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MouseEvent {
    Click(MouseButton),
    Press(MouseButton),
    Release(MouseButton),
    Move(Option<MouseButton>),
    Scroll(ScrollDirection),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MouseAction {
    pub x: u64,
    pub y: u64,
    pub event: MouseEvent,
    pub modifiers: Modifiers,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(super) enum RawEvent {
    Click,
    Press,
    Release,
    Move,
    Scroll,
}

impl MouseAction {
    pub(super) fn new(
        event: RawEvent,
        x: u64,
        y: u64,
        button: Option<MouseButton>,
        direction: Option<ScrollDirection>,
        modifiers: Modifiers,
    ) -> Result<Self, InputError> {
        if x > 9_007_199_254_740_991 || y > 9_007_199_254_740_991 {
            return Err(InputError("mouse coordinates exceed safe integer range"));
        }
        let event = match (event, button, direction) {
            (RawEvent::Click, Some(button), None) => MouseEvent::Click(button),
            (RawEvent::Press, Some(button), None) => MouseEvent::Press(button),
            (RawEvent::Release, Some(button), None) => MouseEvent::Release(button),
            (RawEvent::Move, button, None) => MouseEvent::Move(button),
            (RawEvent::Scroll, None, Some(direction)) => MouseEvent::Scroll(direction),
            _ => return Err(InputError("mouse button or direction does not match event")),
        };
        Ok(Self {
            x,
            y,
            event,
            modifiers,
        })
    }

    pub(super) fn applicable(self, modes: TerminalInputModes, size: TerminalSize) -> bool {
        self.x < u64::from(size.cols())
            && self.y < u64::from(size.rows())
            && modes.mouse_encoding == MouseEncoding::Sgr
            && match (modes.mouse_tracking_mode, self.event) {
                (MouseTracking::None, _) => false,
                (MouseTracking::X10, MouseEvent::Press(_)) => self.modifiers.bits() == 0,
                (MouseTracking::X10, _)
                | (MouseTracking::Vt200, MouseEvent::Move(_))
                | (MouseTracking::Drag, MouseEvent::Move(None)) => false,
                _ => true,
            }
    }

    pub(super) fn encode(
        self,
        modes: TerminalInputModes,
        size: TerminalSize,
    ) -> Result<String, InputError> {
        if self.x >= u64::from(size.cols()) || self.y >= u64::from(size.rows()) {
            return Err(InputError("mouse coordinates are outside the terminal"));
        }
        if modes.mouse_encoding != MouseEncoding::Sgr {
            return Err(InputError(
                "terminal has not enabled SGR cell mouse reporting",
            ));
        }
        match (modes.mouse_tracking_mode, self.event) {
            (MouseTracking::None, _) => {
                return Err(InputError("terminal has not enabled mouse tracking"));
            }
            (MouseTracking::X10, MouseEvent::Press(_)) if self.modifiers.bits() == 0 => {}
            (MouseTracking::X10, _) => {
                return Err(InputError("X10 accepts only unmodified presses"));
            }
            (MouseTracking::Vt200, MouseEvent::Move(_))
            | (MouseTracking::Drag, MouseEvent::Move(None)) => {
                return Err(InputError(
                    "terminal mouse mode does not accept this movement",
                ));
            }
            _ => {}
        }
        Ok(self.encode_sgr())
    }

    pub(super) fn encode_sgr(self) -> String {
        let (button, offset, release) = match self.event {
            MouseEvent::Click(button) | MouseEvent::Press(button) => (Some(button), 0, false),
            MouseEvent::Release(button) => (Some(button), 0, true),
            MouseEvent::Move(button) => (button, 32, false),
            MouseEvent::Scroll(ScrollDirection::Up) => (Some(MouseButton::Left), 64, false),
            MouseEvent::Scroll(ScrollDirection::Down) => (Some(MouseButton::Middle), 64, false),
        };
        let button = match button {
            Some(MouseButton::Left) => 0,
            Some(MouseButton::Middle) => 1,
            Some(MouseButton::Right) => 2,
            None => 3,
        };
        let code = button + offset + self.modifiers.bits() * 4;
        let press = format!(
            "\x1b[<{code};{};{}{}",
            self.x + 1,
            self.y + 1,
            if release { 'm' } else { 'M' }
        );
        if matches!(self.event, MouseEvent::Click(_)) {
            format!("{press}\x1b[<{code};{};{}m", self.x + 1, self.y + 1)
        } else {
            press
        }
    }
}
