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

use crate::{
    app::{Action, App, Focus},
    navigation::Route,
};
use crossterm::event::{Event, KeyCode, MouseButton, MouseEventKind};
use ratatui::layout::Position;

impl App {
    pub(crate) fn shell_surface_input(&mut self, event: &Event) -> Option<(bool, Option<Action>)> {
        let (outcome, focus) = match event {
            Event::Mouse(mouse) => {
                let editor = match self.navigation.current() {
                    Route::Session(ref id) => self.drafts.get(id),
                    _ => None,
                };
                let editing = editor
                    .is_some_and(|editor| editor.contains(Position::new(mouse.column, mouse.row)));
                // Every shell region sees pointer movement, even when another
                // one consumes it, so no retired hover survives across regions.
                let header = self.chrome.header.input(event);
                let footer = self.chrome.footer.input(event);
                let feedback = self.chrome.feedback.input(event);
                let composer = if editing {
                    self.chrome.composer.input(&Event::FocusLost)
                } else {
                    self.chrome.composer.input(event)
                };
                let down = mouse.kind == MouseEventKind::Down(MouseButton::Left);
                if header.consumed {
                    (header, down.then_some(Focus::Header))
                } else if footer.consumed {
                    (footer, None)
                } else if feedback.consumed {
                    (feedback, None)
                } else if composer.consumed {
                    // Stop and reconciliation do not pass through submission's
                    // editor-focus restoration. Blank/disabled input chrome
                    // must likewise leave typing in the draft. Other actions
                    // keep their existing submission or dialog focus policy.
                    let focus = if composer.message.is_none()
                        || matches!(
                            composer.message,
                            Some(Action::StopTurn(_) | Action::ReconcileSubmission)
                        ) {
                        Focus::Composer
                    } else {
                        Focus::Page
                    };
                    (composer, down.then_some(focus))
                } else {
                    return None;
                }
            }
            Event::Key(_) if self.focus == Focus::Header => (self.chrome.header.input(event), None),
            Event::Key(key)
                if matches!(self.navigation.current(), Route::Session(_))
                    && (self.focus == Focus::Page
                        || self.focus == Focus::Composer
                            && matches!(key.code, KeyCode::Tab | KeyCode::BackTab)) =>
            {
                let outcome = self.chrome.composer.input(event);
                let focus = outcome.consumed.then_some(
                    if self.chrome.composer.focused() == Some(super::EDITOR) {
                        Focus::Composer
                    } else {
                        Focus::Page
                    },
                );
                (outcome, focus)
            }
            _ => return None,
        };
        if !outcome.consumed {
            return None;
        }
        if let Some(focus) = focus {
            self.focus = focus;
        }
        let redraw = outcome.redraw || self.hover.take().is_some();
        self.hover_area = None;
        if outcome.message.as_ref().is_some_and(|action| {
            !matches!(
                action,
                Action::Back | Action::Palette | Action::ToggleDetails
            )
        }) {
            self.chat
                .search_command(crate::ui::transcript::search::Command::Close);
        }
        let action = outcome.message.and_then(|action| self.apply(action));
        Some((redraw || action.is_some(), action))
    }

    pub(crate) fn shell_advance_focus(&mut self, backwards: bool) {
        let route = self.navigation.current();
        let mut order = Vec::new();
        if !self.fullscreen() {
            order.push(Focus::Navigation);
        }
        match route {
            Route::Session(_) => {
                order.push(Focus::Composer);
                if !self.chrome.details {
                    order.push(Focus::Transcript);
                }
                if self.inspector_shown() {
                    order.push(Focus::Inspector);
                }
            }
            Route::Connections | Route::Projects => order.push(Focus::List),
            _ => order.push(Focus::Page),
        }
        order.push(Focus::Header);
        // Page identifies the ordinary controls in the same composer region.
        let current = if self.focus == Focus::Page && matches!(route, Route::Session(_)) {
            Focus::Composer
        } else {
            self.focus
        };
        let index = order
            .iter()
            .position(|focus| *focus == current)
            .unwrap_or(0);
        self.focus = order[if backwards {
            (index + order.len() - 1) % order.len()
        } else {
            (index + 1) % order.len()
        }];
        match (self.focus, route) {
            (Focus::Header, _) => self.chrome.header.enter(backwards),
            (Focus::Navigation, _) => self.sidebar.surface.enter(backwards),
            (Focus::List, Route::Connections) => self.connections.surface.enter(backwards),
            (Focus::List, Route::Projects) => self.projects.surface.enter(backwards),
            (Focus::Transcript, _) => self.chat.view.enter(),
            (Focus::Inspector, _) => self.apps.inspector.enter(backwards),
            (Focus::Composer, Route::Session(_)) => {
                self.chrome.composer.enter(backwards);
                if self
                    .chrome
                    .composer
                    .focused()
                    .is_some_and(|path| path != super::EDITOR)
                {
                    self.focus = Focus::Page;
                }
            }
            (Focus::Page, Route::Plugins(_)) => self.plugins.surface.enter(backwards),
            (Focus::Page, Route::Settings) => self.settings.surface.enter(backwards),
            (Focus::Page, Route::Workspace) => self.home.surface.enter(backwards),
            (Focus::Page, Route::Extensions | Route::App(_)) => {
                if let Some(surface) = self.apps_surface() {
                    surface.enter(backwards);
                }
            }
            _ => {}
        }
    }
}
