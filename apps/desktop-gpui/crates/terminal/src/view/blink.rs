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

//! The cursor's blink. It blinks when its style asks to (the program's
//! choice through DECSCUSR, or else the app's setting, which the emulator
//! resolves into [`crate::TerminalCursor::blinking`]), at a steady rate, and
//! holds still for a moment after input and output so typing never loses
//! it. It does not blink without focus (it is hollow then), in an inactive
//! window, over an exited picture, or when the system asks for reduced
//! motion.

use std::time::Duration;

use alacritty_terminal::vte::ansi::CursorShape;
use gpui_kit::{App, Context, Task};

use super::TerminalView;

/// How long each phase of the blink lasts, shown and hidden.
pub(crate) const BLINK_INTERVAL: Duration = Duration::from_millis(500);
/// How long the cursor holds still after input or output.
pub(crate) const BLINK_PAUSE: Duration = Duration::from_millis(500);

/// The blink's state. The timer toggles `visible` while `blinking`; every
/// pause or change bumps `epoch`, which stops an older timer.
pub(crate) struct CursorBlink {
    visible: bool,
    blinking: bool,
    epoch: u64,
    _timer: Option<Task<()>>,
}

impl Default for CursorBlink {
    fn default() -> Self {
        Self { visible: true, blinking: false, epoch: 0, _timer: None }
    }
}

impl CursorBlink {
    /// Whether the cursor shows in this phase of the blink.
    pub(crate) fn is_visible(&self) -> bool {
        self.visible
    }

    /// Whether the blink runs.
    #[cfg(test)]
    pub(crate) fn is_blinking(&self) -> bool {
        self.blinking
    }
}

impl TerminalView {
    /// Whether the active terminal's cursor should blink now.
    fn wants_blink(&self, cx: &App) -> bool {
        if !self.focused || !self.window_active || cx.reduce_motion() {
            return false;
        }
        self.active_terminal(cx).is_some_and(|terminal| {
            let terminal = terminal.read(cx);
            let cursor = terminal.content().cursor;
            !terminal.is_exited() && cursor.blinking && cursor.shape != CursorShape::Hidden
        })
    }

    /// Starts or stops the blink to match the cursor's style, the focus and
    /// the window. A cursor that stops blinking shows.
    pub(super) fn sync_blink(&mut self, cx: &mut Context<Self>) {
        let wanted = self.wants_blink(cx);
        if wanted == self.blink.blinking {
            return;
        }
        self.blink.blinking = wanted;
        self.blink.visible = true;
        self.blink.epoch += 1;
        self.blink._timer = None;
        if wanted {
            self.schedule_blink(BLINK_INTERVAL, cx);
        }
        cx.notify();
    }

    /// Input or output: the cursor shows and holds still for
    /// [`BLINK_PAUSE`], then blinks again.
    pub(super) fn hold_blink(&mut self, cx: &mut Context<Self>) {
        if !self.blink.blinking {
            return;
        }
        self.blink.epoch += 1;
        if !std::mem::replace(&mut self.blink.visible, true) {
            cx.notify();
        }
        self.schedule_blink(BLINK_PAUSE, cx);
    }

    /// Toggles the cursor after `delay`, then every [`BLINK_INTERVAL`],
    /// until the epoch moves on.
    fn schedule_blink(&mut self, delay: Duration, cx: &mut Context<Self>) {
        let epoch = self.blink.epoch;
        self.blink._timer = Some(cx.spawn(async move |this, cx| {
            let mut delay = delay;
            loop {
                cx.background_executor().timer(delay).await;
                let going = this.update(cx, |this, cx| {
                    if this.blink.epoch != epoch || !this.blink.blinking {
                        return false;
                    }
                    if cx.reduce_motion() {
                        this.blink.blinking = false;
                        this.blink.visible = true;
                        cx.notify();
                        return false;
                    }
                    this.blink.visible = !this.blink.visible;
                    cx.notify();
                    true
                });
                if !matches!(going, Ok(true)) {
                    return;
                }
                delay = BLINK_INTERVAL;
            }
        }));
    }
}
