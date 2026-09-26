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
use ratatui::{Terminal, backend::TestBackend};

#[derive(Clone, Copy)]
pub(super) enum Host {
    Inspector,
    Settings,
    Page,
}

impl Host {
    pub(super) fn draw(self, app: &mut App, key: &Key) -> Buffer {
        let mut terminal = Terminal::new(TestBackend::new(100, 64)).unwrap();
        terminal
            .draw(|frame| {
                let area = frame.area();
                match self {
                    Self::Inspector => {
                        app.apps.inspector_visible = true;
                        panels::draw_inspector(frame, app, area, "session");
                    }
                    Self::Settings => crate::pages::settings::draw(frame, app, area),
                    Self::Page => page::draw(frame, app, area, key),
                }
            })
            .unwrap();
        terminal.backend().buffer().clone()
    }
    pub(super) fn viewport(self, app: &App, key: &Key, path: &str) -> Rect {
        match self {
            Self::Inspector => app.apps.inspector.viewport(path),
            Self::Settings => app.settings.surface.viewport(path),
            Self::Page => app.apps.instances[key].surface.viewport(path),
        }
        .unwrap_or_else(|| panic!("missing viewport {path}"))
    }
    pub(super) fn mouse(self, app: &mut App, key: &Key, kind: MouseEventKind, area: Rect) {
        let event = Event::Mouse(MouseEvent {
            kind,
            column: area.x,
            row: area.y,
            modifiers: KeyModifiers::NONE,
        });
        let action = match self {
            Self::Inspector => {
                app.inspector_input(&event);
                return;
            }
            Self::Settings => {
                app.settings
                    .surface
                    .input(&event)
                    .map(Action::Settings)
                    .message
            }
            Self::Page => {
                app.apps
                    .instances
                    .get_mut(key)
                    .unwrap()
                    .surface
                    .input(&event)
                    .map(Action::Apps)
                    .message
            }
        };
        if let Some(action) = action {
            app.apply(action);
        }
    }
    pub(super) fn wheel(self, app: &mut App, key: &Key, path: &str, ticks: usize) {
        for _ in 0..ticks {
            let area = self.viewport(app, key, path);
            self.mouse(app, key, MouseEventKind::ScrollDown, area);
            self.draw(app, key);
        }
    }
}
