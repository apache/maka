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
    app::{Action, App, ConnectionState},
    navigation::Route,
};
use maka_protocol::turn::DirectoryReference;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub session: String,
    pub input: Option<String>,
}

pub fn validate(items: &[DirectoryReference], root: &str) -> Result<(), String> {
    if items.iter().any(|r| r.host_id != root) {
        return Err("Directory reference belongs to another Root".into());
    }
    maka_protocol::turn::MessageContent {
        text: String::new(),
        display_text: None,
        attachments: None,
        directory_references: Some(items.to_vec()),
        quotes: None,
        inline_references: None,
    }
    .validate_admission(true)
    .map_err(|e| e.to_string())
}

impl App {
    pub(crate) fn reference_target(&self) -> Option<Target> {
        if self.revision.visible {
            return self.revision.directory_target();
        }
        let Route::Session(session) = self.navigation.current() else {
            return None;
        };
        self.drafts.contains_key(&session).then_some(Target {
            session,
            input: None,
        })
    }
    pub(crate) fn reference_editable(&self, target: &Target) -> bool {
        let ConnectionState::Connected { root_id, .. } = &self.connection else {
            return false;
        };
        if let Some(input) = &target.input {
            self.revision.directory_root() == Some(root_id.as_str())
                && self.revision.files_editable(&target.session, input)
        } else {
            self.attachment_editable(&target.session)
        }
    }
    pub(crate) fn reference_items(&self, target: &Target) -> &[DirectoryReference] {
        if let Some(input) = &target.input {
            self.revision
                .directories(&target.session, input)
                .unwrap_or_default()
        } else {
            self.directories
                .get(&target.session)
                .map(Vec::as_slice)
                .unwrap_or_default()
        }
    }
    pub(crate) fn reference_count(&self, target: &Target) -> usize {
        if target.input.is_some() {
            self.revision.directory_count()
        } else {
            self.reference_items(target).len()
        }
    }
    pub(crate) fn reference_items_mut(
        &mut self,
        target: &Target,
    ) -> Option<&mut Vec<DirectoryReference>> {
        if let Some(input) = &target.input {
            self.revision.directories_mut(&target.session, input)
        } else {
            self.drafts
                .contains_key(&target.session)
                .then(|| self.directories.entry(target.session.clone()).or_default())
        }
    }
    pub(crate) fn has_directories(&self, session: &str) -> bool {
        self.directories
            .get(session)
            .is_some_and(|items| !items.is_empty())
    }
    pub(crate) fn open_references(&mut self) {
        let Some(target) = self.reference_target() else {
            return;
        };
        if self.reference_editable(&target) {
            self.open_directory_reference(target);
        }
    }
}

pub fn chips(
    frame: &mut ratatui::Frame<'_>,
    app: &mut App,
    area: ratatui::layout::Rect,
    session: &str,
) {
    let names = app
        .directories
        .get(session)
        .into_iter()
        .flatten()
        .map(|r| {
            r.path
                .trim_end_matches(['/', '\\'])
                .rsplit(['/', '\\'])
                .next()
                .filter(|s| !s.is_empty())
                .unwrap_or(&r.path)
        })
        .collect::<Vec<_>>()
        .join(" · ");
    crate::view::list_item(
        frame,
        app,
        area,
        &format!(
            "{} {}",
            app.chrome.symbol("▱", "/"),
            crate::view::safe(&names)
        ),
        Action::References,
        false,
    );
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{
        i18n::{I18n, Locale, LocalePreference},
        pages::manage::{Command, directory},
    };
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
    use maka_protocol::project::{DirectoryRoot, Query, QueryResult};
    use ratatui::{Terminal, backend::TestBackend};

    pub(crate) fn frame(app: &mut App, width: u16, height: u16) {
        Terminal::new(TestBackend::new(width, height))
            .unwrap()
            .draw(|f| crate::view::draw(f, app))
            .unwrap();
    }
    pub(crate) fn selection(app: &mut App) -> directory::Request {
        frame(app, 80, 26);
        let request = app.directory_request().unwrap();
        app.directory_completed(
            request,
            Ok(QueryResult::DirectoryRoots {
                roots: vec![DirectoryRoot {
                    id: "published".into(),
                    label: "Not a path".into(),
                }],
            }),
        );
        frame(app, 80, 26);
        app.apply(Action::Manage(Command::Directory(
            directory::Command::Open(0),
        )));
        let request = app.directory_request().unwrap();
        app.directory_completed(
            request,
            Ok(QueryResult::DirectoryPage {
                root_id: "published".into(),
                segments: vec![],
                entries: vec![],
                next_cursor: None,
            }),
        );
        frame(app, 80, 26);
        assert!(app.management_enabled(&Command::Save));
        app.apply(Action::Manage(Command::Save));
        assert!(
            app.management_request().is_none(),
            "a reference never registers a project"
        );
        let request = app.directory_request().unwrap();
        assert!(
            matches!(&request.query, Query::DirectoryResolve {root_id,segments} if root_id == "published" && segments.is_empty())
        );
        request
    }
    pub(crate) fn complete(app: &mut App, request: directory::Request, path: &str) {
        app.directory_completed(
            request,
            Ok(QueryResult::DirectoryPath {
                root_id: "published".into(),
                segments: vec![],
                path: path.into(),
            }),
        );
    }
    #[test]
    fn directory_picker_preserves_owner_discards_stale_reads_and_freezes_complete_submission() {
        for locale in Locale::ALL {
            let mut app = App::new(
                "/unused".into(),
                I18n::new(LocalePreference::Explicit(locale), Locale::En),
            );
            app.connection = ConnectionState::Connected {
                root_id: "root".into(),
                epoch: "epoch".into(),
            };
            app.apply(Action::Visit(Route::Session("a".into())));
            app.apply(Action::References);
            let stale = selection(&mut app);
            app.apply(Action::Manage(Command::Close));
            app.apply(Action::Visit(Route::Session("b".into())));
            app.apply(Action::References);
            complete(&mut app, stale, "/must-not-attach");
            assert!(app.directories.is_empty());
            let request = selection(&mut app);
            complete(&mut app, request, "/workspace/目录");
            assert!(!app.directory_reference_active());
            assert!(!app.has_directories("a"));
            assert_eq!(app.directories["b"][0].host_id, "root");
            for (width, height) in [(80, 26), (52, 22)] {
                frame(&mut app, width, height);
                assert!(app.hits.iter().any(|h| h.action == Action::References));
                app.apply(Action::References);
                let query = app.directory_request().unwrap();
                app.directory_completed(query, Ok(QueryResult::DirectoryRoots { roots: vec![] }));
                let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
                terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
                // The chosen reference is listed with its remove control.
                let buffer = terminal.backend().buffer();
                let listed = (0..height).any(|y| {
                    let (mut line, mut x) = (String::new(), 0);
                    while x < width {
                        let symbol = buffer[(x, y)].symbol();
                        line.push_str(symbol);
                        x += (unicode_width::UnicodeWidthStr::width(symbol) as u16).max(1);
                    }
                    line.contains("×  /workspace/目录")
                });
                assert!(listed);
                app.input(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
                assert!(!app.directory_reference_active());
            }
            assert!(
                app.enabled(&Action::SendMessage),
                "directory-only input is sendable"
            );
            let sent = app.submission().unwrap();
            assert!(sent.content.text.is_empty());
            assert_eq!(
                sent.content.directory_references.as_ref().unwrap(),
                &app.directories["b"]
            );
            assert!(!app.enabled(&Action::References));
            app.submitted(
                sent.clone(),
                Err(maka_client::RequestFailure::Unknown(
                    maka_client::ClientError::Timeout,
                )),
            );
            assert!(!app.enabled(&Action::References));
            assert_eq!(app.retry_submission().unwrap(), sent);
            app.submitted(
                sent.clone(),
                Ok(maka_protocol::message::SubmitResult::Blocked {
                    message: "uncertain".into(),
                    preparation: vec![],
                }),
            );
            assert!(
                app.has_directories("b"),
                "a rejected retry cannot erase uncertain input"
            );
            app.reconciliation().unwrap();
            app.reconciled(
                sent,
                Ok(Some(
                    maka_protocol::message::ExecutionResolution::Cancelled {
                        message_id: "cancelled".into(),
                    },
                )),
            );
            app.apply(Action::References);
            let query = app.directory_request().unwrap();
            app.directory_completed(query, Ok(QueryResult::DirectoryRoots { roots: vec![] }));
            frame(&mut app, 80, 26);
            app.apply(Action::Manage(Command::Directory(
                directory::Command::RemoveReference(0),
            )));
            app.apply(Action::Manage(Command::Close));
            assert!(!app.has_directories("b"));
            assert!(!app.enabled(&Action::SendMessage));
        }
    }
}
