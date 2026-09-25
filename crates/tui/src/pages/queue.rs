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
    app::{Action, App, ConnectionState, Focus},
    editor::Editor,
    navigation::Route,
    ui::Surface,
};
use maka_client::{Client, ClientError, RequestFailure};
use maka_protocol::{
    Operation,
    message::{MutationResult, Output},
    subscription::SteeringState,
    turn::MessageContent,
};
use ratatui::layout::Rect;
use serde_json::{Value, json};

pub(crate) mod edit;
mod input;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub root: String,
    pub epoch: String,
    pub session: String,
    pub entry: String,
    pub revision: u64,
}
impl Target {
    pub(crate) fn surface_key(&self) -> String {
        format!(
            "{}:{}:{}:{}",
            self.session.len(),
            self.session,
            self.entry.len(),
            self.entry
        )
    }

    pub(crate) fn control_key(&self, control: &str) -> String {
        format!("queue/entries/{}/{control}", self.surface_key())
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Steering,
    InFlight,
    Followup,
}
impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Steering => "queue-steering",
            Self::InFlight => "queue-in-flight",
            Self::Followup => "queue-followup",
        }
    }
}
pub struct Row {
    pub target: Target,
    pub content: MessageContent,
    pub kind: Kind,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Focus,
    Select(Target),
    Edit(Target),
    Retract(Target),
    Promote(Target),
    Reorder(Target, bool),
    Save,
    Close,
}
impl Command {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Focus | Self::Select(_) => "queue-focus",
            Self::Edit(_) => "queue-edit",
            Self::Retract(_) => "queue-retract",
            Self::Promote(_) => "queue-promote",
            Self::Reorder(_, true) => "queue-down",
            Self::Reorder(_, false) => "queue-up",
            Self::Save => "queue-save",
            Self::Close => "queue-close",
        }
    }
}
pub struct Edit {
    pub target: Target,
    pub editor: Editor,
}
#[derive(Clone)]
pub struct Ticket {
    pub id: String,
    pub target: Target,
    pub operation: Operation,
    pub input: Value,
}
#[derive(Default)]
pub struct Queue {
    pub selected: Option<String>,
    pub area: Option<Rect>,
    pub surface: Surface<Command>,
    pub edit: Option<Edit>,
    pending: Option<Ticket>,
    awaiting: Option<(Target, u64)>,
    pub error: Option<(Target, &'static str, String)>,
}
impl Queue {
    pub fn abandon(&mut self) {
        if let Some(ticket) = self.pending.take() {
            self.error = Some((ticket.target, "queue-unknown", String::new()));
        }
    }
}

impl App {
    pub fn queue_rows(&self) -> Vec<Row> {
        let Route::Session(session) = self.navigation.current() else {
            return vec![];
        };
        let ConnectionState::Connected { root_id, epoch } = &self.connection else {
            return vec![];
        };
        let Some(snapshot) = &self.chat.snapshot else {
            return vec![];
        };
        if self.chat.error.is_some()
            || self.chat.session.as_ref() != Some(&session)
            || snapshot.session.session_id != session
            || snapshot.queue.host_epoch != *epoch
        {
            return vec![];
        }
        let queue = &snapshot.queue;
        queue
            .steering
            .iter()
            .map(|row| {
                (
                    &row.message,
                    if row.state == SteeringState::InFlight {
                        Kind::InFlight
                    } else {
                        Kind::Steering
                    },
                )
            })
            .chain(
                queue
                    .followup
                    .iter()
                    .map(|row| (&row.message, Kind::Followup)),
            )
            .map(|(message, kind)| Row {
                target: Target {
                    root: root_id.clone(),
                    epoch: epoch.clone(),
                    session: session.clone(),
                    entry: message.entry_id.clone(),
                    revision: queue.queue_revision,
                },
                content: message.content.clone(),
                kind,
            })
            .collect()
    }
    pub fn queue_selected(&self) -> Option<Row> {
        self.queue_rows()
            .into_iter()
            .find(|row| Some(&row.target.entry) == self.queue.selected.as_ref())
    }
    fn queue_row(&self, target: &Target) -> Option<Row> {
        self.queue_rows()
            .into_iter()
            .find(|row| &row.target == target)
    }
    fn queue_busy(&self) -> bool {
        self.queue.pending.is_some() || self.queue.awaiting.as_ref().is_some_and(|(target, revision)| {
            matches!(&self.connection, ConnectionState::Connected { root_id, epoch } if root_id == &target.root && epoch == &target.epoch)
                && self.chat.snapshot.as_ref().is_some_and(|snapshot| snapshot.session.session_id == target.session && snapshot.queue.queue_revision < *revision)
        })
    }
    pub fn queue_enabled(&self, command: &Command) -> bool {
        match command {
            Command::Focus => !self.queue_rows().is_empty(),
            Command::Select(target) => self.queue_row(target).is_some(),
            Command::Close => self.queue.edit.is_some(),
            Command::Save => self.queue.edit.as_ref().is_some_and(|edit| {
                !self.queue_busy()
                    && !edit.editor.text().trim().is_empty()
                    && edit.editor.error.is_none()
                    && self
                        .queue_row(&edit.target)
                        .is_some_and(|row| row.kind != Kind::InFlight)
            }),
            Command::Edit(target)
            | Command::Retract(target)
            | Command::Promote(target)
            | Command::Reorder(target, _) => {
                if self.queue_busy() {
                    return false;
                }
                let Some(row) = self.queue_row(target) else {
                    return false;
                };
                row.kind != Kind::InFlight
                    && match command {
                        Command::Promote(_) => {
                            row.kind == Kind::Followup && self.stop_target().is_some()
                        }
                        Command::Reorder(_, down) => self.queue_reorder(target, *down).is_some(),
                        _ => true,
                    }
            }
        }
    }
    pub fn queue_move(&mut self, down: bool) {
        let rows = self.queue_rows();
        let index = rows
            .iter()
            .position(|row| Some(&row.target.entry) == self.queue.selected.as_ref());
        if rows.is_empty() || (self.focus == Focus::Queue && index.is_none()) {
            self.focus = Focus::Composer;
            self.queue.selected = None;
            return;
        }
        let index = index.unwrap_or(rows.len() - 1);
        let next = if down {
            (index + 1).min(rows.len() - 1)
        } else {
            index.saturating_sub(1)
        };
        self.queue.selected = Some(rows[next].target.entry.clone());
        self.focus = Focus::Queue;
        self.queue
            .surface
            .focus_within(rows[next].target.control_key("preview"));
    }
    pub fn queue_action(&mut self, command: Command) -> Option<Action> {
        match command {
            Command::Focus => {
                if let Some(row) = self.queue_rows().last() {
                    self.queue.selected = Some(row.target.entry.clone());
                    self.queue
                        .surface
                        .focus_within(row.target.control_key("preview"));
                    self.focus = Focus::Queue;
                }
            }
            Command::Select(target) => {
                self.queue
                    .surface
                    .focus_within(target.control_key("preview"));
                self.queue.selected = Some(target.entry);
                self.focus = Focus::Queue;
            }
            Command::Edit(target) => {
                if let Some(row) = self.queue_row(&target) {
                    let mut editor = Editor::bounded(48 * 1024, "queue-too-large");
                    editor.insert(&row.content.text);
                    self.queue.edit = Some(Edit { target, editor });
                    self.queue.error = None;
                    self.invalidate_editor_geometry();
                    self.hover = None;
                }
            }
            Command::Close => {
                self.queue.edit = None;
                self.focus = Focus::Queue;
                self.invalidate_editor_geometry();
            }
            _ => return Some(Action::Queue(command)),
        }
        None
    }
    fn queue_reorder(&self, target: &Target, down: bool) -> Option<Vec<String>> {
        let rows = self.queue_rows();
        let lane = rows.iter().find(|row| &row.target == target)?.kind;
        if lane == Kind::InFlight {
            return None;
        }
        let mut ids: Vec<_> = rows
            .into_iter()
            .filter(|row| row.kind == lane)
            .map(|row| row.target.entry)
            .collect();
        let index = ids.iter().position(|id| id == &target.entry)?;
        let next = if down {
            index.checked_add(1)?
        } else {
            index.checked_sub(1)?
        };
        if next >= ids.len() {
            return None;
        }
        ids.swap(index, next);
        Some(ids)
    }
    pub fn queue_request(&mut self, command: Command) -> Option<Ticket> {
        if !self.queue_enabled(&command) {
            return None;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (target, operation, extra) = match command {
            Command::Retract(target) => (
                target,
                Operation::QueueEntryRetract,
                json!({"retractId":id}),
            ),
            Command::Promote(target) => (
                target,
                Operation::QueueEntryPromote,
                json!({"promoteId":id}),
            ),
            Command::Reorder(target, down) => {
                let ids = self.queue_reorder(&target, down)?;
                (
                    target,
                    Operation::QueueEntriesReorder,
                    json!({"reorderId":id,"entryIds":ids}),
                )
            }
            Command::Save => {
                let edit = self.queue.edit.as_ref()?;
                (
                    edit.target.clone(),
                    Operation::QueueEntryUpdate,
                    json!({"updateId":id,"expectedQueueRevision":edit.target.revision,"text":edit.editor.text()}),
                )
            }
            _ => return None,
        };
        let mut input = json!({"originHostEpoch":target.epoch,"sessionId":target.session});
        if operation != Operation::QueueEntriesReorder {
            input["entryId"] = json!(target.entry);
        }
        input.as_object_mut()?.extend(extra.as_object()?.clone());
        let ticket = Ticket {
            id,
            target,
            operation,
            input,
        };
        self.queue.pending = Some(ticket.clone());
        self.queue.error = None;
        Some(ticket)
    }
    pub fn queue_completed(
        &mut self,
        ticket: Ticket,
        result: Result<MutationResult, RequestFailure>,
    ) {
        if self.queue.pending.as_ref().map(|pending| &pending.id) != Some(&ticket.id) {
            return;
        }
        self.queue.pending = None;
        match result {
            Ok(result) => {
                self.queue.awaiting = Some((ticket.target.clone(), result.queue_revision));
                if ticket.operation == Operation::QueueEntryUpdate
                    && self.queue.edit.as_ref().is_some_and(|edit| {
                        edit.target == ticket.target
                            && Some(edit.editor.text()) == ticket.input["text"].as_str()
                    })
                {
                    self.queue.edit = None;
                    self.focus = Focus::Queue;
                }
            }
            Err(error) => {
                let key = if matches!(error, RequestFailure::Unknown(_)) {
                    "queue-unknown"
                } else {
                    "queue-failed"
                };
                self.queue.error = Some((ticket.target, key, error.to_string()));
            }
        }
    }
}

pub async fn execute(client: &Client, ticket: &Ticket) -> Result<MutationResult, RequestFailure> {
    if client.identity.root_id != ticket.target.root
        || client.identity.host_epoch != ticket.target.epoch
    {
        return Err(RequestFailure::Rejected(ClientError::Protocol(
            "Queue target connection changed".into(),
        )));
    }
    let result = client
        .request(ticket.operation, ticket.input.clone())
        .await?;
    if let Ok(Output::Mutation(result)) =
        maka_protocol::message::decode_output(ticket.operation, &result)
    {
        return Ok(result);
    }
    client.disconnect();
    Err(RequestFailure::Unknown(ClientError::Protocol(
        "Invalid queue mutation receipt".into(),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Locale, LocalePreference, i18n::I18n};
    use crossterm::event::{
        Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    };
    use ratatui::{Terminal, backend::TestBackend};

    fn fixture(locale: Locale) -> App {
        let mut app = App::new(
            "/fixture".into(),
            I18n::new(LocalePreference::Explicit(locale), locale),
        );
        app.apply(Action::Visit(Route::Session("chat".into())));
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.chat.select(&Route::Session("chat".into()));
        let row = |id: &str, placement: &str, state: &str| json!({"entryId":id,"messageId":id,"content":{"text":format!("{id} 中文🦀")},"placement":placement,"state":state});
        app.chat.snapshot = Some(maka_protocol::subscription::decode_session_observation_snapshot(&json!({
            "schemaVersion":5,"session":{"sessionId":"chat","metadataRevision":1,"status":"running","createdAt":0,"isArchived":false},
            "projectionRevision":1,"rootTurn":{"sessionId":"chat","turnId":"turn","runId":"run","status":"running"},"goal":null,
            "queue":{"hostEpoch":"epoch","queueRevision":7,"steering":[row("s1","current_turn","queued"),row("s2","current_turn","in_flight")],
                "followup":[row("f1","next_turn","queued"),row("f2","next_turn","queued"),row("f3","next_turn","queued")]},"interactions":{"pending":[]}
        })).unwrap());
        app
    }
    fn key(app: &mut App, code: KeyCode, modifiers: KeyModifiers) -> Option<Action> {
        app.input(Event::Key(KeyEvent::new(code, modifiers))).1
    }
    fn mouse(app: &mut App, area: Rect, kind: MouseEventKind) -> Option<Action> {
        app.input(Event::Mouse(MouseEvent {
            kind,
            column: area.x,
            row: area.y,
            modifiers: KeyModifiers::NONE,
        }))
        .1
    }

    #[test]
    fn queue_surface_keeps_hover_actions_stable_and_activates_the_exact_presented_target() {
        let mut app = fixture(Locale::En);
        let mut terminal = Terminal::new(TestBackend::new(120, 30)).unwrap();
        terminal
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        let target = app.queue_rows()[2].target.clone();
        let preview = app
            .queue
            .surface
            .rect(&target.control_key("preview"))
            .unwrap();
        assert!(!preview.is_empty());
        assert!(!app.hits.iter().any(|hit| matches!(
            hit.action,
            Action::Queue(
                Command::Select(_)
                    | Command::Edit(_)
                    | Command::Retract(_)
                    | Command::Promote(_)
                    | Command::Reorder(_, _)
            )
        )));
        mouse(&mut app, preview, MouseEventKind::Moved);
        terminal
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        let edit = app.queue.surface.rect(&target.control_key("edit")).unwrap();
        let up = app.queue.surface.rect(&target.control_key("up")).unwrap();
        assert!(!edit.is_empty());
        assert!(!app.queue_enabled(&Command::Reorder(target.clone(), false)));
        for _ in 0..2 {
            mouse(&mut app, up, MouseEventKind::Moved);
            terminal
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            assert_eq!(
                app.queue.surface.rect(&target.control_key("edit")),
                Some(edit)
            );
            assert_eq!(
                app.queue.surface.hovered().unwrap().key,
                target.control_key("up")
            );
        }
        assert!(mouse(&mut app, up, MouseEventKind::Down(MouseButton::Left)).is_none());
        assert!(app.queue.pending.is_none());
        assert!(app.queue.selected.is_none());

        // Geometry still carries the last presented revision, even if a newer
        // projection has already arrived before the redraw.
        app.chat.snapshot.as_mut().unwrap().queue.queue_revision += 1;
        mouse(&mut app, edit, MouseEventKind::Down(MouseButton::Left));
        assert!(app.queue.edit.is_none());
        terminal
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        let current = app.queue_rows()[2].target.clone();
        assert_eq!(target.control_key("edit"), current.control_key("edit"));
        mouse(&mut app, edit, MouseEventKind::Down(MouseButton::Left));
        assert_eq!(app.queue.edit.as_ref().unwrap().target, current);
        assert!(
            app.queue.selected.is_none(),
            "a sibling action is not row selection"
        );
        assert!(
            app.queue.pending.is_none(),
            "presentation does not create a mutation ticket"
        );
    }

    #[test]
    fn queue_scroll_and_consumed_selection_do_not_change_mutation_targets() {
        let mut app = fixture(Locale::En);
        let mut terminal = Terminal::new(TestBackend::new(120, 30)).unwrap();
        terminal
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        let target = app.queue_rows().last().unwrap().target.clone();
        assert!(
            app.queue
                .surface
                .rect(&target.control_key("preview"))
                .unwrap()
                .is_empty()
        );
        let area = app.queue.area.unwrap();
        mouse(&mut app, area, MouseEventKind::ScrollDown);
        terminal
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        assert!(
            !app.queue
                .surface
                .rect(&target.control_key("preview"))
                .unwrap()
                .is_empty()
        );
        assert!(app.queue.selected.is_none());
        app.apply(Action::Queue(Command::Focus));
        assert_eq!(app.queue.selected.as_deref(), Some("f3"));
        app.chat.snapshot.as_mut().unwrap().queue.followup.pop();
        app.chat.snapshot.as_mut().unwrap().queue.queue_revision += 1;
        key(&mut app, KeyCode::Up, KeyModifiers::NONE);
        assert_eq!(app.focus, Focus::Composer);
        assert!(app.queue.selected.is_none());
        assert!(app.queue.edit.is_none());
        assert!(app.queue.pending.is_none());
        app.input(Event::Resize(20, 5));
        assert!(
            app.queue
                .surface
                .rect(&target.control_key("preview"))
                .is_none()
        );
        assert!(
            app.queue_surface_input(&Event::Mouse(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: area.x,
                row: area.y,
                modifiers: KeyModifiers::NONE,
            }))
            .is_none()
        );
    }

    #[test]
    fn queue_mutations_bind_revision_scope_and_preserve_drafts_across_conflicts_and_unknown_results()
     {
        let mut app = fixture(Locale::En);
        app.input(Event::Paste("unsent draft".into()));
        let ordinary = app.submission().unwrap();
        assert_eq!(
            ordinary.input().placement,
            maka_protocol::message::Placement::NextTurn
        );
        app.sending.clear();
        let steering = app
            .submission_for(maka_protocol::message::Placement::CurrentTurn)
            .unwrap();
        assert_eq!(
            steering.input().placement,
            maka_protocol::message::Placement::CurrentTurn
        );
        app.sending.clear();
        let rows = app.queue_rows();
        assert!(!app.queue_enabled(&Command::Retract(rows[1].target.clone())));
        assert!(!app.queue_enabled(&Command::Edit(rows[1].target.clone())));
        let target = rows[2].target.clone();
        let reorder = app
            .queue_request(Command::Reorder(target.clone(), true))
            .unwrap();
        assert_eq!(reorder.input["entryIds"], json!(["f2", "f1", "f3"]));
        assert!(
            app.queue_request(Command::Retract(target.clone()))
                .is_none()
        );
        app.queue_completed(reorder.clone(), Ok(MutationResult { queue_revision: 8 }));
        assert!(
            !app.queue_enabled(&Command::Edit(target.clone())),
            "ack waits for projection"
        );
        assert_eq!(
            app.queue_rows()[2].target.entry,
            "f1",
            "no optimistic business queue"
        );
        app.chat.snapshot.as_mut().unwrap().queue.queue_revision = 8;
        let target = app.queue_rows()[2].target.clone();
        app.apply(Action::Queue(Command::Edit(target.clone())));
        app.queue.edit.as_mut().unwrap().editor.insert(" edited");
        let ticket = app.queue_request(Command::Save).unwrap();
        assert_eq!(ticket.input["expectedQueueRevision"], 8);
        assert_eq!(ticket.input["entryId"], "f1");
        assert_eq!(ticket.input["text"], "f1 中文🦀 edited");
        app.queue_completed(
            ticket.clone(),
            Err(RequestFailure::Unknown(ClientError::Timeout)),
        );
        assert!(app.queue.pending.is_none());
        assert!(app.queue_edit_status().unwrap().contains("unknown"));
        assert_eq!(
            app.queue.edit.as_ref().unwrap().editor.text(),
            "f1 中文🦀 edited"
        );
        assert_eq!(app.drafts["chat"].text(), "unsent draft");
        app.chat.snapshot.as_mut().unwrap().queue.queue_revision = 9;
        assert!(
            app.queue_request(Command::Save).is_none(),
            "never rebase over another writer"
        );
        app.apply(Action::Queue(Command::Close));
        let target = app.queue_rows()[2].target.clone();
        let pending = app.queue_request(Command::Promote(target.clone())).unwrap();
        app.queue.abandon();
        app.queue_completed(pending, Ok(MutationResult { queue_revision: 10 }));
        assert_eq!(app.queue.error.as_ref().unwrap().1, "queue-unknown");
        app.connection = ConnectionState::Connected {
            root_id: "other".into(),
            epoch: "epoch".into(),
        };
        assert!(!app.queue_enabled(&Command::Retract(target)));
        assert_eq!(app.drafts["chat"].text(), "unsent draft");
    }

    #[test]
    fn compact_queue_and_modal_share_mouse_keyboard_geometry_without_composer_input_leaks() {
        for locale in Locale::ALL {
            for (width, height) in [(30, 10), (80, 24), (120, 40)] {
                for ascii in [false, true] {
                    let mut app = fixture(locale);
                    app.chrome.ascii = ascii;
                    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
                    terminal
                        .draw(|frame| crate::view::draw(frame, &mut app))
                        .unwrap();
                    assert!(app.queue.area.unwrap().height <= 3);
                    key(&mut app, KeyCode::Up, KeyModifiers::NONE);
                    assert_eq!(app.focus, Focus::Queue);
                    assert_eq!(app.queue.selected.as_deref(), Some("f3"));
                    terminal
                        .draw(|frame| crate::view::draw(frame, &mut app))
                        .unwrap();
                    let target = app.queue_selected().unwrap().target;
                    let preview = app
                        .queue
                        .surface
                        .rect(&target.control_key("preview"))
                        .unwrap();
                    assert!(!preview.is_empty());
                    app.input(Event::Mouse(MouseEvent {
                        kind: MouseEventKind::Down(MouseButton::Left),
                        column: preview.x,
                        row: preview.y,
                        modifiers: KeyModifiers::NONE,
                    }));
                    key(&mut app, KeyCode::Char('e'), KeyModifiers::NONE);
                    terminal
                        .draw(|frame| crate::view::draw(frame, &mut app))
                        .unwrap();
                    app.input(Event::Paste("\nchanged 中文🦀".into()));
                    assert_eq!(app.drafts["chat"].text(), "");
                    if width < 34 {
                        // Too narrow for the sheet: nothing is editable or
                        // submittable until it fits.
                        assert_eq!(app.queue.edit.as_ref().unwrap().editor.text(), "f3 中文🦀");
                        assert!(key(&mut app, KeyCode::Char('s'), KeyModifiers::CONTROL).is_none());
                        key(&mut app, KeyCode::Esc, KeyModifiers::NONE);
                        assert!(app.queue.edit.is_none());
                        continue;
                    }
                    assert_eq!(
                        app.queue.edit.as_ref().unwrap().editor.text(),
                        "f3 中文🦀\nchanged 中文🦀"
                    );
                    // Enter breaks the line rather than saving.
                    assert!(key(&mut app, KeyCode::Enter, KeyModifiers::NONE).is_none());
                    key(&mut app, KeyCode::Backspace, KeyModifiers::NONE);
                    // The row between the title and the field.
                    let field = app.layer.slot("message").unwrap();
                    assert!(
                        app.input(Event::Mouse(MouseEvent {
                            kind: MouseEventKind::Down(MouseButton::Left),
                            column: field.x,
                            row: field.y - 1,
                            modifiers: KeyModifiers::NONE
                        }))
                        .1
                        .is_none()
                    );
                    assert!(app.queue.edit.is_some(), "a press inside keeps the sheet");
                    assert_eq!(
                        key(&mut app, KeyCode::Char('s'), KeyModifiers::CONTROL),
                        Some(Action::Queue(Command::Save))
                    );
                    app.input(Event::Resize(20, 5));
                    assert!(
                        key(&mut app, KeyCode::Char('s'), KeyModifiers::CONTROL).is_none(),
                        "hidden modal cannot submit"
                    );
                    terminal
                        .draw(|frame| crate::view::draw(frame, &mut app))
                        .unwrap();
                    app.chat.snapshot.as_mut().unwrap().queue.followup.pop();
                    app.chat.snapshot.as_mut().unwrap().queue.queue_revision += 1;
                    assert!(key(&mut app, KeyCode::Char('s'), KeyModifiers::CONTROL).is_none());
                    assert!(
                        app.queue.edit.is_some(),
                        "consumed message does not discard edits or resend"
                    );
                    app.input(Event::Mouse(MouseEvent {
                        kind: MouseEventKind::Down(MouseButton::Left),
                        column: 0,
                        row: 0,
                        modifiers: KeyModifiers::NONE,
                    }));
                    assert!(app.queue.edit.is_none());
                    terminal
                        .draw(|frame| crate::view::draw(frame, &mut app))
                        .unwrap();
                    assert_eq!(
                        app.focus,
                        Focus::Composer,
                        "retired selection must not move to a different entry"
                    );
                    let queue = &mut app.chat.snapshot.as_mut().unwrap().queue;
                    queue.steering.clear();
                    queue.followup.clear();
                    terminal
                        .draw(|frame| crate::view::draw(frame, &mut app))
                        .unwrap();
                    assert!(app.queue.area.is_none());
                }
            }
        }
    }
}
