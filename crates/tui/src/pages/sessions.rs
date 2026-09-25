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

use crate::{app::App, view::safe};
use maka_protocol::session::{
    SessionCatalogProjection, SessionCatalogQueryInput, SessionCatalogQueryResult, SessionStatus,
};
use ratatui::text::Line;

#[derive(Default)]
pub struct Sessions {
    pending_only: bool,
    pub items: Vec<SessionCatalogProjection>,
    pub selected: Option<String>,
    revision: Option<String>,
    cursor: Option<String>,
    next_cursor: Option<String>,
    pub loading: bool,
    pub loaded: bool,
    requested: bool,
    pub error: Option<String>,
    pub changed: bool,
    pub detail: Detail,
    detail_generation: u64,
    detail_requested: bool,
    detail_inflight: bool,
    discard_page: bool,
    /// Pages the reader asked to keep loaded ("load more") in the listed
    /// catalog. Revision changes refetch the same depth from the start.
    depth: usize,
    /// Pages of the current load cycle. They replace `items` only once the
    /// depth is reached, so a refresh never shrinks the list meanwhile.
    staged: Option<(Vec<SessionCatalogProjection>, usize)>,
}

#[derive(Default)]
pub enum Detail {
    #[default]
    Empty,
    Loading {
        id: String,
    },
    Ready(Box<SessionCatalogProjection>),
    Missing {
        id: String,
    },
    Failed {
        id: String,
        error: String,
    },
}
impl Detail {
    fn id(&self) -> Option<&str> {
        match self {
            Self::Empty => None,
            Self::Loading { id } | Self::Missing { id } | Self::Failed { id, .. } => Some(id),
            Self::Ready(item) => Some(&item.id),
        }
    }
}
#[derive(Clone)]
pub struct DetailRequest {
    pub id: String,
    generation: u64,
}

impl Sessions {
    pub fn retire(&mut self, id: &str) {
        self.items.retain(|item| item.id != id);
        self.cursor = None;
        self.staged = None;
        if self.selected.as_deref() == Some(id) {
            self.selected = None;
        }
        self.discard_page |= self.loading;
        self.refresh();
        if self.detail.id() == Some(id) {
            self.detail_generation += 1;
            self.detail_requested = false;
            self.detail = Detail::Missing { id: id.into() };
        }
    }
    pub fn inbox() -> Self {
        Self {
            pending_only: true,
            ..Self::default()
        }
    }
    pub fn refresh(&mut self) {
        self.changed = false;
        self.requested = true;
    }
    pub fn restart(&mut self) {
        if self.loading {
            return;
        }
        self.cursor = None;
        self.staged = None;
        self.refresh();
    }
    pub fn can_refresh_detail(&self) -> bool {
        !self.detail_inflight && self.detail.id().is_some()
    }
    pub fn invalidate(&mut self, id: &str) {
        self.refresh();
        if self.detail.id() == Some(id) {
            self.refresh_detail();
        }
    }
    pub fn invalidate_all(&mut self) {
        self.refresh();
        if self.detail.id().is_some() {
            self.refresh_detail();
        }
    }
    pub fn updated(&mut self, item: Box<SessionCatalogProjection>) {
        self.invalidate(&item.id);
        if let Some(current) = self.items.iter_mut().find(|current| current.id == item.id)
            && current.revision <= item.revision
        {
            *current = (*item).clone();
        }
        if self.detail.id() == Some(&item.id)
            && !matches!(&self.detail, Detail::Ready(current) if current.revision > item.revision)
        {
            self.detail = Detail::Ready(item);
        }
    }
    /// Keep one more page of the listed catalog.
    pub fn more(&mut self) {
        if self.loading {
            return;
        }
        if let Some(cursor) = self.next_cursor.clone() {
            self.depth = self.depth.max(1) + 1;
            self.staged = Some((self.items.clone(), self.depth - 1));
            self.cursor = Some(cursor);
            self.requested = true;
        }
    }
    pub fn can_more(&self) -> bool {
        !self.loading && self.next_cursor.is_some()
    }
    pub fn has_more(&self) -> bool {
        self.next_cursor.is_some()
    }
    pub fn query(&mut self) -> Option<SessionCatalogQueryInput> {
        if self.loading || !self.requested {
            return None;
        }
        self.requested = false;
        self.loading = true;
        self.error = None;
        Some(match (&self.revision, &self.cursor) {
            (Some(revision), Some(cursor)) if self.pending_only => {
                SessionCatalogQueryInput::PendingContinue {
                    revision: revision.clone(),
                    cursor: cursor.clone(),
                }
            }
            _ if self.pending_only => SessionCatalogQueryInput::PendingStart,
            (Some(revision), Some(cursor)) => SessionCatalogQueryInput::ListContinue {
                revision: revision.clone(),
                cursor: cursor.clone(),
            },
            _ => SessionCatalogQueryInput::ListStart,
        })
    }
    pub fn complete(&mut self, result: Result<SessionCatalogQueryResult, String>) {
        self.loading = false;
        if std::mem::take(&mut self.discard_page) {
            return;
        }
        match result {
            Ok(SessionCatalogQueryResult::Page {
                revision,
                sessions,
                next_cursor,
            }) => {
                let (mut items, pages) = self.staged.take().unwrap_or_default();
                for session in sessions {
                    if !items.iter().any(|item| item.id == session.id) {
                        items.push(session);
                    }
                }
                self.revision = Some(revision);
                if pages + 1 < self.depth.max(1)
                    && let Some(cursor) = next_cursor
                {
                    self.staged = Some((items, pages + 1));
                    self.cursor = Some(cursor);
                    self.requested = true;
                    return;
                }
                if !self.loaded {
                    self.selected = items.first().map(|item| item.id.clone());
                } else if !items
                    .iter()
                    .any(|item| Some(&item.id) == self.selected.as_ref())
                {
                    self.selected = None;
                }
                self.items = items;
                self.next_cursor = next_cursor;
                // The next refresh starts over and refetches this depth.
                self.cursor = None;
                self.loaded = true;
            }
            Ok(SessionCatalogQueryResult::RevisionChanged { .. }) => {
                self.cursor = None;
                self.staged = None;
                self.changed = true;
                self.requested = true; // One fresh list_start; the client rejects revision_changed for it.
            }
            Err(error) => {
                self.cursor = None;
                self.staged = None;
                self.error = Some(error);
            }
            _ => unreachable!("client checks catalog reply variants"),
        }
    }
    pub fn open(&mut self, id: &str) {
        if self.detail.id() == Some(id) {
            return;
        }
        self.detail = Detail::Loading { id: id.into() };
        self.refresh_detail();
    }
    pub fn refresh_detail(&mut self) {
        self.detail_generation += 1;
        self.detail_requested = true;
    }
    pub fn detail_query(&mut self) -> Option<DetailRequest> {
        if self.detail_inflight || !self.detail_requested {
            return None;
        }
        let id = self.detail.id()?.to_owned();
        self.detail_requested = false;
        self.detail_inflight = true;
        Some(DetailRequest {
            id,
            generation: self.detail_generation,
        })
    }
    pub fn complete_detail(
        &mut self,
        request: DetailRequest,
        result: Result<Option<Box<SessionCatalogProjection>>, String>,
    ) {
        self.detail_inflight = false;
        if request.generation != self.detail_generation || self.detail.id() != Some(&request.id) {
            return;
        }
        self.detail = match result {
            Ok(Some(item)) => Detail::Ready(item),
            Ok(None) => Detail::Missing { id: request.id },
            Err(error) => Detail::Failed {
                id: request.id,
                error,
            },
        };
    }
}

pub fn detail_lines(app: &App) -> Vec<Line<'static>> {
    let i18n = &app.i18n;
    match &app.sessions.detail {
        Detail::Empty | Detail::Loading { .. } => vec![Line::raw(i18n.text("sessions-loading"))],
        Detail::Missing { id } => {
            vec![Line::raw(i18n.text("session-missing")), Line::raw(safe(id))]
        }
        Detail::Failed { error, .. } => vec![
            Line::raw(i18n.text("sessions-failed")),
            Line::raw(safe(error)),
        ],
        Detail::Ready(item) => vec![
            Line::raw(safe(&item.name)),
            Line::raw(""),
            Line::raw(i18n.format("session-id", &[("value", &safe(&item.id))])),
            Line::raw(i18n.text(status_key(item.status))),
            Line::raw(i18n.format(
                "session-workspace",
                &[("value", &safe(&item.workspace.host_cwd))],
            )),
            Line::raw(i18n.format("session-model", &[("value", &safe(&item.model))])),
            Line::raw(""),
            Line::raw(safe(item.last_message_preview.as_deref().unwrap_or(""))),
        ],
    }
}

fn status_key(status: SessionStatus) -> &'static str {
    match status {
        SessionStatus::Active => "session-active",
        SessionStatus::Running => "session-running",
        SessionStatus::WaitingForUser => "session-waiting",
        SessionStatus::Blocked => "session-blocked",
        SessionStatus::Aborted => "session-aborted",
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{
        app::{Action, ConnectionState, Focus},
        navigation::Route,
    };
    pub(crate) fn item(id: &str) -> SessionCatalogProjection {
        maka_protocol::session::decode_session_catalog_projection(&serde_json::json!({
            "id":id,"revision":1,"workspace":{"target":{"kind":"host_path","path":"/work"},"hostCwd":"/work"},
            "createdAt":0,"activityAt":1,"name":id,"isFlagged":false,"isArchived":false,
            "labels":[],"labelsTruncated":false,"hasUnread":false,"status":"active","backend":"ai-sdk",
            "llmConnectionId":null,"llmConnectionSlug":"default","connectionLocked":false,"model":"model",
            "sandboxMode":"workspace-write","approvalPolicy":{"kind":"on-request"},"collaborationMode":"agent","orchestrationMode":"default"
        })).unwrap()
    }
    #[test]
    fn notices_during_catalog_load_are_not_lost_and_revision_change_restarts_once() {
        for mut state in [Sessions::default(), Sessions::inbox()] {
            let start = if state.pending_only {
                SessionCatalogQueryInput::PendingStart
            } else {
                SessionCatalogQueryInput::ListStart
            };
            state.refresh();
            assert_eq!(state.query(), Some(start.clone()));
            state.invalidate("A");
            assert!(state.query().is_none());
            state.complete(Ok(SessionCatalogQueryResult::Page {
                revision: "one".into(),
                sessions: vec![item("A")],
                next_cursor: Some("cursor".into()),
            }));
            assert!(
                state.query().is_some(),
                "in-flight invalidation schedules another query"
            );
            state.complete(Ok(SessionCatalogQueryResult::Page {
                revision: "one".into(),
                sessions: vec![item("A")],
                next_cursor: Some("cursor".into()),
            }));
            state.more();
            let continuation = state.query().unwrap();
            assert_eq!(
                matches!(
                    continuation,
                    SessionCatalogQueryInput::PendingContinue { .. }
                ),
                state.pending_only
            );
            state.complete(Ok(SessionCatalogQueryResult::RevisionChanged {
                expected_revision: "one".into(),
                actual_revision: "two".into(),
            }));
            assert_eq!(state.query(), Some(start.clone()));
            assert!(state.changed);
            state.complete(Err("offline".into()));
            assert!(state.query().is_none(), "failed reads do not spin");
            state.restart();
            assert_eq!(state.query(), Some(start.clone()));
            state.complete(Ok(SessionCatalogQueryResult::Page {
                revision: "two".into(),
                sessions: vec![item("C")],
                next_cursor: Some("next".into()),
            }));
            assert_eq!(
                state.items[0].id, "A",
                "keep old rows until the remembered depth is refreshed"
            );
            assert!(state.query().is_some());
            state.complete(Ok(SessionCatalogQueryResult::Page {
                revision: "two".into(),
                sessions: vec![item("D")],
                next_cursor: None,
            }));
            assert_eq!(
                state
                    .items
                    .iter()
                    .map(|item| item.id.as_str())
                    .collect::<Vec<_>>(),
                ["C", "D"]
            );
            assert!(!state.can_more());
            state.restart();
            assert_eq!(state.query(), Some(start.clone()));
            state.complete(Ok(SessionCatalogQueryResult::Page {
                revision: "three".into(),
                sessions: vec![item("E")],
                next_cursor: Some("next".into()),
            }));
            assert!(state.query().is_some());
            state.complete(Err("offline during the second page".into()));
            state.restart();
            assert_eq!(state.query(), Some(start));
            state.complete(Ok(SessionCatalogQueryResult::Page {
                revision: "four".into(),
                sessions: vec![item("F")],
                next_cursor: None,
            }));
            assert_eq!(
                state
                    .items
                    .iter()
                    .map(|item| item.id.as_str())
                    .collect::<Vec<_>>(),
                ["F"],
                "a retry cannot carry staged rows from the failed revision"
            );
        }
    }

    #[test]
    fn late_a_result_cannot_overwrite_b_or_a_reopened_after_b() {
        let mut state = Sessions::default();
        state.open("A");
        let old = state.detail_query().unwrap();
        state.open("B");
        state.open("A");
        assert!(
            state.detail_query().is_none(),
            "only one detail request can be in flight"
        );
        state.complete_detail(old, Ok(None));
        assert!(matches!(state.detail, Detail::Loading { .. }));
        let current = state.detail_query().unwrap();
        state.complete_detail(current, Ok(None));
        assert!(matches!(state.detail, Detail::Missing { ref id } if id == "A"));
        let mut acknowledged = item("A");
        acknowledged.revision = 9;
        acknowledged.is_archived = true;
        state.updated(Box::new(acknowledged));
        state.updated(Box::new(item("A"))); // A late mutation ack cannot roll back the visible revision.
        assert!(
            matches!(&state.detail, Detail::Ready(item) if item.revision == 9 && item.is_archived)
        );
        let old_detail = state.detail_query().unwrap();
        state.query().unwrap();
        state.retire("A");
        state.complete_detail(old_detail, Ok(Some(Box::new(item("A")))));
        state.complete(Ok(SessionCatalogQueryResult::Page {
            revision: "old".into(),
            sessions: vec![item("A")],
            next_cursor: None,
        }));
        assert!(matches!(&state.detail, Detail::Missing { id } if id == "A"));
        assert!(
            state.items.is_empty(),
            "pre-removal reads cannot resurrect a retired row"
        );
        assert!(state.detail_query().is_none());
        assert!(state.query().is_some(), "catalog refresh remains scheduled");
    }

    #[test]
    fn catalog_selection_tracks_identity_across_reorder_and_clears_on_removal() {
        let mut state = Sessions::default();
        let page = |ids: &[&str]| {
            Ok(SessionCatalogQueryResult::Page {
                revision: format!("sha256:{}", "a".repeat(64)),
                sessions: ids.iter().map(|id| item(id)).collect(),
                next_cursor: None,
            })
        };
        state.complete(page(&["A", "B"]));
        state.selected = Some("B".into());
        assert_eq!(state.selected.as_deref(), Some("B"));
        state.complete(page(&["B", "A"]));
        assert_eq!(state.selected.as_deref(), Some("B"));
        state.open("B");
        state.complete(page(&["A"]));
        assert_eq!(state.selected, None);
        assert_eq!(
            state.detail.id(),
            Some("B"),
            "removing a row must not retarget the open route"
        );
        let mut app = App::new(
            "/unused".into(),
            crate::i18n::I18n::new(
                crate::LocalePreference::Explicit(crate::Locale::En),
                crate::Locale::En,
            ),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Session("draft".into())));
        app.drafts.get_mut("draft").unwrap().insert("Keep typing");
        app.apply(Action::ToggleFullscreen);
        app.inbox.complete(page(&["A", "B"]));
        assert_eq!(app.focus, Focus::Composer);
        assert!(app.page_actions().contains(&Action::Inbox));
        assert!(!app.interactions.visible);
        app.apply(Action::Inbox);
        assert_eq!(app.focus, Focus::Composer);
        assert!(app.sidebar.drawer && app.sidebar.pending_only);
        assert_eq!(app.navigation.current(), Route::Session("draft".into()));
        let mut screen =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 24)).unwrap();
        screen
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        let row = app.layer.rect("sidebar/list/rows/session-A").unwrap();
        app.layer.focus_path("sidebar/list/rows/session-A");
        app.inbox.refresh();
        assert!(app.inbox.query().is_some());
        screen
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        assert_eq!(
            app.layer.rect("sidebar/list/rows/session-A").unwrap(),
            row,
            "background refresh must not move visible rows under the pointer"
        );
        app.inbox.complete(page(&["B"]));
        let key = |code| {
            crossterm::event::Event::Key(crossterm::event::KeyEvent::new(
                code,
                crossterm::event::KeyModifiers::NONE,
            ))
        };
        app.input(key(crossterm::event::KeyCode::Enter));
        assert_eq!(
            app.navigation.current(),
            Route::Session("draft".into()),
            "resolved A cannot silently activate B"
        );
        screen
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        app.input(key(crossterm::event::KeyCode::Down));
        app.input(key(crossterm::event::KeyCode::Enter));
        assert_eq!(app.navigation.current(), Route::Session("B".into()));
        assert!(
            !app.management_commands().is_empty(),
            "catalog identity enables commands while session detail is loading"
        );
        assert_eq!(app.drafts["draft"].text(), "Keep typing");
    }
}
