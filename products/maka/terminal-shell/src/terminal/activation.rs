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

use termina::{
    Event,
    event::{KeyEventKind, MouseEventKind},
};
use tokio::sync::watch;

/// The last foreground evidence from this terminal's sole input reader.
/// Unknown starts false; native field focus is not evidence of activation.
#[derive(Clone)]
pub(crate) struct Activation(watch::Sender<bool>);

impl Default for Activation {
    fn default() -> Self {
        Self(watch::channel(false).0)
    }
}

impl Activation {
    pub(super) fn observe(&self, event: &Event) {
        let active = match event {
            Event::FocusIn => true,
            Event::FocusOut => false,
            // Enabling focus tracking need not report the initial state.
            // A key press or button down is direct activity in this terminal;
            // hover, wheel and key releases can arrive without activation.
            Event::Key(key) if key.kind != KeyEventKind::Release => true,
            Event::Mouse(mouse) if matches!(mouse.kind, MouseEventKind::Down(_)) => true,
            Event::SgrMouse(mouse) if matches!(mouse.kind, MouseEventKind::Down(_)) => true,
            _ => return,
        };
        self.0.send_if_modified(|current| {
            if *current == active {
                return false;
            }
            *current = active;
            true
        });
    }

    pub(super) fn clear(&self) {
        self.observe(&Event::FocusOut);
    }

    #[cfg(test)]
    pub(crate) fn foreground(&self) -> bool {
        *self.0.borrow()
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<bool> {
        self.0.subscribe()
    }
}
