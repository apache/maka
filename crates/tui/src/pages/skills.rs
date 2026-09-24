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

mod io;
mod view;
pub use io::execute;
pub use view::chips;
pub(crate) use view::sheet;

use crate::{
    app::{Action, App, ConnectionState},
    pages::references::Target,
};
use maka_protocol::plugin::RemoteResult;
use maka_skills::api::{InvocableItem, InvocableResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PROVIDER: &str = "maka.skills";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Picked {
    pub id: String,
    pub name: String,
}

pub fn selections(items: &[Picked]) -> maka_runtime::input::Selections {
    if items.is_empty() {
        BTreeMap::new()
    } else {
        BTreeMap::from([(
            PROVIDER.into(),
            items.iter().map(|i| i.id.clone()).collect(),
        )])
    }
}
pub fn validate(items: &[Picked]) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    if items
        .iter()
        .any(|i| !seen.insert(&i.id) || i.name.len() > 4096 || i.name.chars().any(char::is_control))
    {
        return Err("Invalid saved Skills selection".into());
    }
    maka_runtime::input::validate_selections(&selections(items)).map_err(str::to_owned)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Open,
    Close,
    Refresh,
    Previous,
    Next,
    Selected,
    Toggle(usize),
}
impl Command {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Open | Self::Toggle(_) => "skills-title",
            Self::Close => "session-remove-close",
            Self::Refresh => "directory-refresh",
            Self::Previous => "directory-previous",
            Self::Next => "directory-next",
            Self::Selected => "skills-selected",
        }
    }
}
#[derive(Default)]
pub struct State {
    pub saved: BTreeMap<String, Vec<Picked>>,
    pub dialog: Option<Dialog>,
    pending: Option<Request>,
    generation: u64,
}
pub struct Dialog {
    root: String,
    epoch: String,
    target: Target,
    session: String,
    generation: u64,
    bound: Option<RemoteResult>,
    page: Option<(String, String)>,
    previous: Vec<Option<(String, String)>>,
    next: Option<(String, String)>,
    requested: bool,
    loading: bool,
    rows: Vec<InvocableItem>,
    selected_only: bool,
    pub visible: bool,
    error: Option<&'static str>,
}
#[derive(Clone, Debug)]
pub struct Request {
    root: String,
    epoch: String,
    target: Target,
    pub(crate) session: String,
    generation: u64,
    bound: Option<RemoteResult>,
    page: Option<(String, String)>,
}
impl State {
    pub fn disconnect(&mut self) {
        self.dialog = None;
        self.pending = None;
    }
    pub fn invalidate_geometry(&mut self) {
        if let Some(d) = &mut self.dialog {
            d.visible = false;
        }
    }
}
impl App {
    pub(crate) fn picked_skills(&self, target: &Target) -> &[Picked] {
        if let Some(input) = &target.input {
            self.revision
                .skills(&target.session, input)
                .unwrap_or_default()
        } else {
            self.skills
                .saved
                .get(&target.session)
                .map(Vec::as_slice)
                .unwrap_or_default()
        }
    }
    pub(crate) fn has_skills(&self, session: &str) -> bool {
        self.skills
            .saved
            .get(session)
            .is_some_and(|v| !v.is_empty())
    }
    pub(crate) fn skills_enabled(&self, command: &Command) -> bool {
        if *command == Command::Close {
            return self.skills.dialog.is_some();
        }
        if *command == Command::Open {
            return self
                .reference_target()
                .is_some_and(|t| self.reference_editable(&t));
        }
        let Some(d) = &self.skills.dialog else {
            return false;
        };
        if !d.visible || !self.skills_current(d) {
            return false;
        }
        match command {
            Command::Refresh => !d.loading,
            Command::Previous => !d.selected_only && !d.loading && !d.previous.is_empty(),
            Command::Next => {
                !d.selected_only && !d.loading && d.next.is_some() && d.previous.len() < 128
            }
            Command::Selected => true,
            Command::Toggle(index) => *index < self.skill_rows().len(),
            _ => false,
        }
    }
    fn skills_current(&self, d: &Dialog) -> bool {
        matches!(&self.connection,ConnectionState::Connected {root_id,epoch}
            if *root_id == d.root && *epoch == d.epoch)
            && self.reference_target().as_ref() == Some(&d.target)
            && self.reference_editable(&d.target)
    }
    fn skill_rows(&self) -> Vec<InvocableItem> {
        let Some(d) = &self.skills.dialog else {
            return vec![];
        };
        if d.selected_only {
            self.picked_skills(&d.target)
                .iter()
                .map(|i| InvocableItem {
                    id: i.id.clone(),
                    name: i.name.clone(),
                    description: String::new(),
                    reference: String::new(),
                })
                .collect()
        } else {
            d.rows.clone()
        }
    }
    pub(crate) fn skills_action(&mut self, command: Command) {
        if !self.skills_enabled(&command) {
            return;
        }
        if command == Command::Close {
            self.skills.dialog = None;
            return;
        }
        if command == Command::Open {
            let target = self.reference_target().unwrap();
            let ConnectionState::Connected { root_id, epoch } = &self.connection else {
                return;
            };
            let session = if target.input.is_some() {
                let Some(source) = self.revision.skills_source() else {
                    return;
                };
                source.to_owned()
            } else {
                target.session.clone()
            };
            self.skills.generation += 1;
            self.skills.dialog = Some(Dialog {
                root: root_id.clone(),
                epoch: epoch.clone(),
                target,
                session,
                generation: self.skills.generation,
                bound: None,
                page: None,
                previous: vec![],
                next: None,
                requested: true,
                loading: false,
                rows: vec![],
                selected_only: false,
                visible: false,
                error: None,
            });
            return;
        }
        if let Command::Toggle(index) = command {
            let Some(row) = self.skill_rows().get(index).cloned() else {
                return;
            };
            let target = self.skills.dialog.as_ref().unwrap().target.clone();
            let mut items = self.picked_skills(&target).to_vec();
            if let Some(index) = items.iter().position(|i| i.id == row.id) {
                items.remove(index);
            } else {
                items.push(Picked {
                    id: row.id,
                    name: row.name,
                });
            }
            let valid = validate(&items).is_ok() && self.revision.skills_fit(&target, &items);
            if valid {
                if let Some(input) = &target.input {
                    if let Some(saved) = self.revision.skills_mut(&target.session, input) {
                        *saved = items;
                    }
                } else if items.is_empty() {
                    self.skills.saved.remove(&target.session);
                } else {
                    self.skills.saved.insert(target.session, items);
                }
            }
            let dialog = self.skills.dialog.as_mut().unwrap();
            dialog.error = (!valid).then_some("skills-limit");
            return;
        }
        let d = self.skills.dialog.as_mut().unwrap();
        match command {
            Command::Selected => {
                d.selected_only = !d.selected_only;
            }
            Command::Refresh => {
                d.bound = None;
                d.page = None;
                d.previous.clear();
                d.selected_only = false;
                d.requested = true;
            }
            Command::Next => {
                d.previous.push(d.page.clone());
                d.page = d.next.clone();
                d.requested = true;
            }
            Command::Previous => {
                d.page = d.previous.pop().flatten();
                d.requested = true;
            }
            _ => {}
        }
        d.error = None;
        if d.requested {
            d.rows.clear();
            d.next = None;
        }
    }
    pub(crate) fn skills_request(&mut self) -> Option<Request> {
        if self
            .skills
            .dialog
            .as_ref()
            .is_some_and(|d| !self.skills_current(d))
        {
            self.skills.dialog = None;
        }
        if self.closing || self.skills.pending.is_some() {
            return None;
        }
        let d = self.skills.dialog.as_mut()?;
        if !d.requested {
            return None;
        }
        d.requested = false;
        d.loading = true;
        let request = Request {
            root: d.root.clone(),
            epoch: d.epoch.clone(),
            target: d.target.clone(),
            session: d.session.clone(),
            generation: d.generation,
            bound: d.bound.clone(),
            page: d.page.clone(),
        };
        self.skills.pending = Some(request.clone());
        Some(request)
    }
    pub(crate) fn skills_completed(
        &mut self,
        request: Request,
        result: Result<(RemoteResult, InvocableResult), String>,
    ) {
        if self.skills.pending.as_ref().is_none_or(|p| {
            p.generation != request.generation
                || p.root != request.root
                || p.epoch != request.epoch
                || p.page != request.page
        }) {
            return;
        }
        self.skills.pending = None;
        let valid = self.skills.dialog.as_ref().is_some_and(|d| {
            d.generation == request.generation
                && d.target == request.target
                && self.skills_current(d)
        });
        if !valid {
            return;
        }
        let d = self.skills.dialog.as_mut().unwrap();
        d.loading = false;
        match result {
            Ok((
                bound,
                InvocableResult::Page {
                    revision,
                    items,
                    next_cursor,
                },
            )) => {
                d.bound = Some(bound);
                d.rows = items;
                d.next = next_cursor.map(|cursor| (revision, cursor));
                d.error = None;
            }
            Ok((_, InvocableResult::RevisionChanged { .. })) => {
                d.rows.clear();
                d.next = None;
                d.previous.clear();
                d.error = Some("skills-changed");
            }
            Err(_) => {
                d.rows.clear();
                d.next = None;
                d.error = Some("skills-failed");
            }
        }
    }
}
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{
        i18n::{I18n, Locale, LocalePreference},
        navigation::Route,
    };
    use crossterm::event::{
        Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    };
    use ratatui::{Terminal, backend::TestBackend};

    pub(crate) fn frame(app: &mut App, width: u16, height: u16) {
        Terminal::new(TestBackend::new(width, height))
            .unwrap()
            .draw(|f| crate::view::draw(f, app))
            .unwrap();
    }
    pub(crate) fn page(app: &mut App, request: Request, count: usize, next: bool) {
        let bound=serde_json::from_value(serde_json::json!({"kind":"bound","handler":"method",
            "target":{"entryId":"maka.skills","activation":"activation","registration":"00000000-0000-4000-8000-000000000001"}})).unwrap();
        app.skills_completed(
            request,
            Ok((
                bound,
                InvocableResult::Page {
                    revision: "revision".into(),
                    next_cursor: next.then(|| "cursor".into()),
                    items: (0..count)
                        .map(|i| InvocableItem {
                            id: format!("review-{i:03}"),
                            name: format!("Review {i:03}"),
                            description: "Read carefully".into(),
                            reference: format!("project:review-{i:03}"),
                        })
                        .collect(),
                },
            )),
        );
    }
    #[test]
    fn skills_picker_fences_pages_and_input_owners_then_freezes_exact_turn_selection() {
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
            app.apply(Action::Skills(Command::Open));
            let stale = app.skills_request().unwrap();
            app.apply(Action::Skills(Command::Close));
            app.apply(Action::Visit(Route::Session("b".into())));
            app.apply(Action::Skills(Command::Open));
            assert!(
                app.skills_request().is_none(),
                "a closed dialog cannot multiply in-flight reads"
            );
            page(&mut app, stale, 1, false);
            assert!(app.skills.dialog.as_ref().unwrap().rows.is_empty());
            let request = app.skills_request().unwrap();
            assert_eq!(request.session, "b");
            page(&mut app, request, 32, true);
            for (width, height) in [(80, 28), (52, 22)] {
                frame(&mut app, width, height);
                let first = app.layer.rect("list/rows/0").unwrap();
                let mouse = |kind, column, row| {
                    Event::Mouse(MouseEvent {
                        kind,
                        column,
                        row,
                        modifiers: KeyModifiers::NONE,
                    })
                };
                let shown = |app: &App, index: usize| {
                    app.layer
                        .rect(&format!("list/rows/{index}"))
                        .is_some_and(|rect| !rect.is_empty())
                };
                app.input(mouse(MouseEventKind::ScrollDown, first.x, first.y));
                frame(&mut app, width, height);
                assert!(!shown(&app, 0), "the wheel scrolls the list");
                app.input(mouse(MouseEventKind::ScrollUp, first.x, first.y));
                frame(&mut app, width, height);
                assert!(shown(&app, 0));
                // The scrollbar sits just right of the rows.
                app.input(mouse(
                    MouseEventKind::Down(MouseButton::Left),
                    first.right(),
                    first.y,
                ));
                app.input(mouse(
                    MouseEventKind::Drag(MouseButton::Left),
                    first.right(),
                    first.y + height,
                ));
                app.input(mouse(
                    MouseEventKind::Up(MouseButton::Left),
                    first.right(),
                    first.y + height,
                ));
                frame(&mut app, width, height);
                assert!(shown(&app, 31), "dragging the thumb reaches the end");
                assert!(
                    app.skills.saved.is_empty(),
                    "dragging cannot select a skill"
                );
                app.input(Event::Resize(30, 12));
                frame(&mut app, 30, 12);
                assert!(!app.skills.dialog.as_ref().unwrap().visible);
                assert!(!app.skills_enabled(&Command::Toggle(0)));
                app.input(Event::Key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE)));
                frame(&mut app, width, height);
                app.input(Event::Key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE)));
                frame(&mut app, width, height);
            }
            let row = app.layer.rect("list/rows/0").unwrap();
            app.input(Event::Mouse(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: row.x + 5,
                row: row.y,
                modifiers: KeyModifiers::NONE,
            }));
            assert_eq!(app.skills.saved["b"][0].id, "review-000");
            assert!(!app.has_skills("a"));
            app.apply(Action::Skills(Command::Next));
            let request = app.skills_request().unwrap();
            assert!(
                request.bound.is_some(),
                "pagination keeps the original registration"
            );
            assert_eq!(request.page, Some(("revision".into(), "cursor".into())));
            app.skills_completed(
                request,
                Ok((
                    RemoteResult::Closed,
                    InvocableResult::RevisionChanged {
                        expected_revision: "revision".into(),
                        actual_revision: "changed".into(),
                    },
                )),
            );
            assert!(app.skills.dialog.as_ref().unwrap().rows.is_empty());
            assert!(
                app.skills_request().is_none(),
                "changed revision requires explicit refresh"
            );
            frame(&mut app, 80, 28);
            app.apply(Action::Skills(Command::Selected));
            frame(&mut app, 80, 28);
            assert_eq!(app.skill_rows().len(), 1);
            assert!(
                app.layer.rect("list/rows/0").is_some() && app.layer.rect("list/rows/1").is_none(),
                "only the picked skill is listed"
            );
            app.input(Event::Mouse(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: 0,
                row: 0,
                modifiers: KeyModifiers::NONE,
            }));
            assert!(
                app.skills.dialog.is_none(),
                "outside click closes only the picker"
            );
            app.chat.select(&Route::Session("b".into()));
            app.chat.snapshot = Some(maka_protocol::subscription::decode_session_observation_snapshot(&serde_json::json!({
                "schemaVersion":5,"session":{"sessionId":"b","metadataRevision":1,"status":"running","createdAt":0,"isArchived":false},
                "projectionRevision":1,"rootTurn":{"sessionId":"b","turnId":"turn","runId":"run","status":"running"},
                "goal":null,"queue":{"hostEpoch":"epoch","queueRevision":0,"steering":[],"followup":[]},"interactions":{"pending":[]}
            })).unwrap());
            assert!(!app.enabled(&Action::SendMessage));
            assert!(!app.enabled(&Action::SteerMessage));
            assert!(
                app.submission().is_none(),
                "Skills cannot silently become follow-up or steering"
            );
            assert!(app.has_skills("b"));
            app.chat.snapshot = None;
            assert!(app.enabled(&Action::SendMessage));
            let sent = app.submission().unwrap();
            assert!(sent.content.text.is_empty());
            assert_eq!(
                sent.placement,
                maka_protocol::message::Placement::CurrentTurn
            );
            assert_eq!(sent.input_selections[PROVIDER], ["review-000"]);
            sent.input().validate().unwrap();
            app.submitted(
                sent.clone(),
                Err(maka_client::RequestFailure::Unknown(
                    maka_client::ClientError::Timeout,
                )),
            );
            assert!(!app.skills_enabled(&Command::Open));
            assert_eq!(app.retry_submission().unwrap(), sent);
            app.submitted(
                sent,
                Ok(maka_protocol::message::SubmitResult::Blocked {
                    message: "still unknown".into(),
                    preparation: vec![],
                }),
            );
            assert!(
                app.has_skills("b"),
                "a rejected replay must preserve the first uncertain selection"
            );
        }
    }
}
