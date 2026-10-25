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

use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers, MouseEventKind};
use nsh_engine::HostChannel;

/// Call immediately before dispatching this input, on the UI owner. Sending
/// from the reader would reorder activity ahead of earlier queued Ctrl+C keys.
pub(super) fn activity(host: &HostChannel, event: &Event) {
    let resets = match event {
        Event::Key(key) if key.kind == KeyEventKind::Press => {
            !(key.modifiers == KeyModifiers::CONTROL && key.code == KeyCode::Char('c'))
        }
        Event::Paste(_) | Event::FocusLost => true,
        Event::Mouse(mouse) => matches!(mouse.kind, MouseEventKind::Down(_)),
        _ => false,
    };
    if resets {
        reset(host);
    }
}

pub(super) fn terminal_activity(host: &HostChannel, event: &termina::Event) {
    match event {
        termina::Event::Paste(_) => reset(host),
        termina::Event::Key(_)
        | termina::Event::Mouse(_)
        | termina::Event::SgrMouse(_)
        | termina::Event::FocusOut => {
            if let Some(event) = super::adapter::event(event.clone()) {
                activity(host, &event);
            }
        }
        _ => {}
    }
}

fn reset(host: &HostChannel) {
    let _ = host.send("terminal.activity", serde_json::Value::Null);
}
