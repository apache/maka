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

mod attachments;
mod directories;
mod draft;
mod editing;
mod request;
mod resources;
mod saved;
mod skills;
mod view;

use super::branch::Basis;
use crate::{
    app::{Action, App, ConnectionState},
    editor::Editor,
    navigation::Route,
};
use draft::Input;
use maka_client::RequestFailure;
use maka_protocol::{
    session::copy,
    turn::{TurnBatchStartInput, TurnQueryInput},
};
use request::Job;
pub use request::{Output, Request, execute};
pub use saved::Checkpoint;
use saved::Stage;
pub(crate) use view::{draw_field, sheet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Open(Basis),
    Resume,
    Send,
    Retry,
    Query,
    Discard,
    ConfirmDiscard,
    /// Keeps the revision after asking to discard it.
    Keep,
    Visit,
    Close,
    Select(usize),
    Display,
    Details,
    Resources,
    Attachments,
    Directories,
    Skills,
    Content,
    ToggleResource(resources::Resource),
}
impl Command {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Open(_) => "revision-title",
            Self::Resume => "revision-resume",
            Self::Send => "revision-send",
            Self::Retry => "revision-retry",
            Self::Query => "branch-query",
            Self::Discard | Self::ConfirmDiscard => "revision-discard",
            Self::Keep => "session-cancel",
            Self::Visit => "revision-open",
            Self::Close => "session-remove-close",
            Self::Select(_) => "revision-input",
            Self::Display => "revision-display",
            Self::Details => "revision-details",
            Self::Resources | Self::ToggleResource(_) => "revision-resources",
            Self::Content => "revision-content",
            Self::Attachments => "inputs-add",
            Self::Directories => "references-title",
            Self::Skills => "skills-title",
        }
    }
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Loading,
    Editing,
    Uploading,
    Busy,
    UnknownCopy,
    UnknownTurn,
    Ready,
    Done,
    Retained,
    Failed,
}
#[derive(Default)]
pub struct State {
    pub visible: bool,
    rendered: bool,
    saved: Option<Checkpoint>,
    basis: Option<Basis>,
    phase: Phase,
    pending: Option<Request>,
    requested: Option<Job>,
    sequence: u64,
    error: Option<&'static str>,
    selected: usize,
    display: bool,
    editor: Editor,
    problem: Option<Editor>,
    show_problem: bool,
    resources: resources::Browser,
    editors: std::collections::VecDeque<((usize, bool), Editor)>,
    confirm_discard: bool,
    uploading: bool,
}
impl State {
    pub fn begin_frame(&mut self) {
        self.rendered = false;
    }
    pub fn checkpoint(&self) -> Option<Checkpoint> {
        self.saved.clone().map(|mut saved| {
            saved.view = self.capture_view();
            saved
        })
    }
    pub fn restore(&mut self, saved: Checkpoint) {
        self.uploading = false;
        self.phase = match saved.stage {
            Stage::Draft => Phase::Editing,
            Stage::Attachments => Phase::Ready,
            Stage::Copy | Stage::Abandon => Phase::UnknownCopy,
            Stage::Batch => Phase::UnknownTurn,
        };
        self.clear_editors();
        self.selected = saved.view.selected;
        self.display = saved.view.display;
        self.saved = Some(saved);
        self.load_editor();
        self.visible = false;
    }
    /// The sheet reports whether it is on screen; its commands need it.
    pub(crate) fn presented(&mut self, shown: bool) {
        self.rendered = shown;
    }
    pub fn invalidate_geometry(&mut self) {
        self.rendered = false;
        self.editor.invalidate_geometry();
        if let Some(problem) = &mut self.problem {
            problem.invalidate_geometry();
        }
    }
    pub fn disconnect(&mut self) {
        self.pending = None;
        self.requested = None;
        self.uploading = false;
        self.problem = None;
        self.show_problem = false;
        self.confirm_discard = false;
        self.phase = match self.saved.as_ref().map(|saved| saved.stage) {
            Some(Stage::Draft) => Phase::Editing,
            Some(Stage::Attachments) => Phase::Ready,
            Some(Stage::Batch) => Phase::UnknownTurn,
            Some(Stage::Copy | Stage::Abandon) => Phase::UnknownCopy,
            None => Phase::Failed,
        };
    }
    fn primary(&self) -> Option<Command> {
        if self.confirm_discard {
            return Some(Command::ConfirmDiscard);
        }
        match self.phase {
            Phase::Editing | Phase::Ready => Some(Command::Send),
            Phase::UnknownCopy | Phase::UnknownTurn => Some(Command::Query),
            Phase::Done | Phase::Retained => Some(Command::Visit),
            _ => None,
        }
    }
}
impl App {
    pub fn revision_commands(&self) -> Vec<(Action, &'static str)> {
        if self.revision.saved.is_some() {
            return vec![(Action::Revision(Command::Resume), "revision-resume")];
        }
        self.branch_basis()
            .map(|basis| vec![(Action::Revision(Command::Open(basis)), "revision-title")])
            .unwrap_or_default()
    }
    pub fn revision_enabled(&self, command: &Command) -> bool {
        let state = &self.revision;
        let available =
            state.visible && state.rendered && state.pending.is_none() && state.requested.is_none();
        let same_root = state.saved.as_ref().is_some_and(|saved|
            matches!(&self.connection, ConnectionState::Connected { root_id, .. } if *root_id == saved.root));
        match command {
            Command::Open(basis) => state.saved.is_none() && !state.visible && state.pending.is_none() && state.requested.is_none()
                && self.branch_basis().as_ref() == Some(basis),
            Command::Resume => state.saved.is_some() && !state.visible,
            Command::Close => state.visible,
            Command::Send => available && same_root && !state.confirm_discard
                && matches!(state.phase, Phase::Editing | Phase::Ready)
                && state.saved.as_ref().is_some_and(|saved| saved.stage != Stage::Draft
                    || matches!(&self.connection, ConnectionState::Connected {epoch,..} if *epoch == saved.origin_epoch)),
            Command::Query => available && same_root && matches!(state.phase, Phase::UnknownCopy | Phase::UnknownTurn),
            Command::Retry => available && same_root
                && matches!(state.phase, Phase::UnknownCopy | Phase::UnknownTurn)
                && state.saved.as_ref().is_some_and(|s| s.stage != Stage::Draft),
            Command::Discard => available && state.saved.is_some() && !state.confirm_discard,
            Command::Keep => state.visible && state.confirm_discard,
            Command::ConfirmDiscard => available && state.confirm_discard
                && state.saved.as_ref().is_some_and(|s| s.stage == Stage::Draft || same_root),
            Command::Visit => available && same_root && matches!(state.phase, Phase::Done | Phase::Retained)
                && state.saved.as_ref().is_some_and(|s| {
                    (self.tabs.contains(&s.copy.target_session_id) || self.tabs.entries.len() < crate::navigation::tabs::LIMIT)
                    && (self.drafts.contains_key(&s.copy.target_session_id) || self.drafts.len() < crate::navigation::tabs::LIMIT)
                }),
            Command::Directories | Command::Skills => available && state.phase == Phase::Editing && !state.confirm_discard,
            Command::Attachments => available && !state.confirm_discard && state.saved.is_some()
                && matches!(state.phase, Phase::Editing | Phase::Uploading | Phase::Ready),
            Command::Select(index) => available && matches!(state.phase, Phase::Editing | Phase::Uploading | Phase::Ready) && !state.confirm_discard
                && state.saved.as_ref().is_some_and(|s| *index < s.inputs.len()),
            Command::Resources | Command::Content => available && state.phase == Phase::Editing && !state.confirm_discard
                && state.saved.as_ref().is_some_and(|s| !s.inputs[state.selected].resources().is_empty()),
            Command::ToggleResource(resource) => available && state.phase == Phase::Editing && state.resources.visible && !state.confirm_discard
                && !matches!(resource, resources::Resource::Inline{..})
                && state.saved.as_ref().is_some_and(|s| s.inputs[state.selected].resources().contains(resource)),
            Command::Details => available && state.problem.is_some() && !state.confirm_discard,
            Command::Display => available && state.phase == Phase::Editing && !state.confirm_discard
                && state.saved.as_ref().is_some_and(|s| s.inputs[state.selected].content.display_text.is_some()),
        }
    }
    pub fn revision_action(&mut self, command: Command) -> Option<Action> {
        if !self.revision_enabled(&command) {
            return None;
        }
        if command == Command::Skills {
            self.skills_action(crate::pages::skills::Command::Open);
            return None;
        }
        if command == Command::Directories {
            self.open_references();
            return None;
        }
        if command == Command::Attachments {
            let saved = self.revision.saved.as_ref()?;
            self.open_revision_files(
                saved.copy.target_session_id.clone(),
                saved.inputs[self.revision.selected]
                    .original
                    .message_id
                    .clone(),
            );
            return None;
        }
        if command == Command::Send
            && self
                .revision
                .saved
                .as_ref()
                .is_some_and(|s| s.stage == Stage::Attachments)
        {
            self.resume_revision_uploads();
            return None;
        }
        if command == Command::ConfirmDiscard {
            if let Some(saved) = &self.revision.saved {
                self.attachments.retire(&saved.copy.target_session_id);
            }
            self.revision.uploading = false;
        }
        let state = &mut self.revision;
        match command {
            Command::Attachments | Command::Directories | Command::Skills => unreachable!(),
            Command::Open(basis) => {
                state.clear_editors();
                state.requested = Some(Job::Load {
                    session: basis.source.clone(),
                    turn: basis.turn.clone(),
                });
                state.basis = Some(basis);
                state.phase = Phase::Loading;
                state.error = None;
                state.visible = true;
                state.selected = 0;
                state.display = false;
                state.invalidate_geometry();
            }
            Command::Resume => {
                state.visible = true;
                state.confirm_discard = false;
                state.invalidate_geometry();
            }
            Command::Close => {
                state.visible = false;
                state.confirm_discard = false;
                state.invalidate_geometry();
            }
            Command::Resources | Command::Content => {
                state.resources.visible = matches!(command, Command::Resources);
                state.show_problem = false;
                state.invalidate_geometry();
            }
            Command::ToggleResource(resource) => {
                let input = &mut state.saved.as_mut()?.inputs[state.selected];
                input.toggle(&resource);
                state.error = None;
            }
            Command::Details => {
                state.show_problem = !state.show_problem;
                state.invalidate_geometry();
            }
            Command::Select(index) => {
                state.switch_editor(index, false);
            }
            Command::Display => {
                state.switch_editor(state.selected, !state.display);
            }
            Command::Discard => {
                state.confirm_discard = true;
                state.error = None;
            }
            Command::Keep => state.confirm_discard = false,
            Command::ConfirmDiscard => {
                let saved = state.saved.as_mut()?;
                if saved.stage == Stage::Draft {
                    state.saved = None;
                    state.clear_editors();
                    state.visible = false;
                    state.phase = Phase::Failed;
                } else {
                    saved.stage = Stage::Abandon;
                    state.requested = Some(Job::Abandon(saved.copy.target_session_id.clone()));
                }
                state.confirm_discard = false;
            }
            Command::Send => {
                let saved = state.saved.as_mut()?;
                if let Some(batch) = &saved.batch {
                    state.requested = Some(Job::Start(batch.clone()));
                } else {
                    // Validate aggregate limits before creating a target.
                    // Admission validation uses original resources here; target-owned
                    // storage is resolved only after the copy has committed.
                    let messages = saved.inputs.iter().map(Input::message).collect();
                    let preview = TurnBatchStartInput {
                        session_id: saved.copy.source_session_id.clone(),
                        turn_id: saved.turn_id.clone(),
                        messages,
                        turn_orchestration: saved.inputs[0].original.turn_orchestration.clone(),
                        max_steps: None,
                    };
                    if saved.inputs.iter().any(|input| {
                        input.original.turn_orchestration != preview.turn_orchestration
                    }) || maka_protocol::turn::validate_turn_batch_draft(
                        preview,
                        &saved
                            .inputs
                            .iter()
                            .map(|i| i.files.len())
                            .collect::<Vec<_>>(),
                    )
                    .is_err()
                    {
                        state.error = Some("revision-invalid");
                        return None;
                    }
                    saved.stage = Stage::Copy;
                    state.requested = Some(Job::Copy(saved.copy.clone()));
                }
                state.error = None;
            }
            Command::Retry => {
                let saved = state.saved.as_ref()?;
                state.requested = Some(match saved.stage {
                    Stage::Copy => Job::Copy(saved.copy.clone()),
                    Stage::Batch => Job::Start(saved.batch.clone()?),
                    Stage::Abandon => Job::Abandon(saved.copy.target_session_id.clone()),
                    Stage::Draft | Stage::Attachments => return None,
                });
                state.error = None;
            }
            Command::Query => {
                let saved = state.saved.as_ref()?;
                state.requested = Some(if state.phase == Phase::UnknownTurn {
                    Job::TurnQuery(TurnQueryInput {
                        session_id: saved.copy.target_session_id.clone(),
                        turn_id: saved.turn_id.clone(),
                    })
                } else {
                    Job::CopyQuery(saved.copy.clone())
                });
                state.error = None;
            }
            Command::Visit => {
                let saved = state.saved.take()?;
                self.attachments.forget(saved.upload_ids());
                let target = saved.copy.target_session_id;
                state.clear_editors();
                state.visible = false;
                return self.apply(Action::Visit(Route::Session(target)));
            }
        }
        None
    }
    pub fn revision_request(&mut self) -> Option<Request> {
        let ConnectionState::Connected { root_id, epoch } = &self.connection else {
            return None;
        };
        let state = &mut self.revision;
        let root = state
            .saved
            .as_ref()
            .map(|s| &s.root)
            .or_else(|| state.basis.as_ref().map(|b| &b.root))?;
        if root != root_id || state.pending.is_some() || self.closing {
            return None;
        }
        let job = state.requested.take()?;
        state.problem = None;
        state.show_problem = false;
        state.sequence += 1;
        let request = Request {
            root: root_id.clone(),
            epoch: epoch.clone(),
            sequence: state.sequence,
            job,
        };
        state.pending = Some(request.clone());
        state.phase = Phase::Busy;
        Some(request)
    }
    pub fn revision_after_checkpoint(
        &mut self,
        request: &Request,
        result: &Result<(), String>,
    ) -> bool {
        let state = &mut self.revision;
        if state.pending.as_ref() != Some(request)
            || state.phase != Phase::Busy
            || !request.needs_checkpoint()
        {
            return false;
        }
        if result.is_ok()
            && !self.closing
            && matches!(&self.connection,
            ConnectionState::Connected {root_id,epoch} if *root_id == request.root && *epoch == request.epoch)
        {
            // Consume the save permission; an identical writer acknowledgement
            // cannot dispatch again. The pending request remains for its reply.
            state.phase = Phase::Loading;
            return true;
        }
        state.pending = None;
        state.requested = None;
        match &request.job {
            Job::Copy(_) => {
                state.saved.as_mut().unwrap().stage = Stage::Draft;
                state.phase = Phase::Editing;
            }
            Job::Start(_) => state.phase = Phase::Ready,
            _ => state.disconnect(),
        }
        state.error = Some("revision-save-failed");
        false
    }
    pub fn revision_completed(&mut self, request: Request, result: Result<Output, RequestFailure>) {
        let state = &mut self.revision;
        if state.pending.as_ref() != Some(&request) {
            return;
        }
        state.pending = None;
        if !matches!(&self.connection, ConnectionState::Connected {root_id,epoch} if *root_id == request.root && *epoch == request.epoch)
        {
            state.disconnect();
            return;
        }
        state.problem = None;
        state.show_problem = false;
        match result {
            Ok(Output::Sources(output)) if matches!(request.job, Job::Load { .. }) => {
                let Some(basis) = &state.basis else {
                    return;
                };
                let saved = Checkpoint {
                    root: request.root,
                    origin_epoch: request.epoch,
                    copy: copy::Input {
                        source_session_id: basis.source.clone(),
                        target_session_id: uuid::Uuid::new_v4().to_string(),
                        expected_source_revision: basis.revision,
                        purpose: copy::Purpose::Revision {
                            turn_id: basis.turn.clone(),
                        },
                    },
                    turn_id: uuid::Uuid::new_v4().to_string(),
                    inputs: output.messages.into_iter().map(Input::new).collect(),
                    stage: Stage::Draft,
                    batch: None,
                    mapped: None,
                    view: saved::View::default(),
                };
                if saved.validate(&saved.root).is_err() {
                    state.phase = Phase::Failed;
                    state.error = Some("revision-invalid");
                    return;
                }
                state.saved = Some(saved);
                state.phase = Phase::Editing;
                state.load_editor();
            }
            Ok(Output::Sources(output)) => {
                let Some(saved) = &mut state.saved else {
                    return;
                };
                if saved.stage == Stage::Abandon {
                    state.phase = Phase::UnknownCopy;
                    state.error = Some("revision-unknown");
                    return;
                }
                match draft::batch(&saved.inputs, &output, &saved.turn_id) {
                    Ok(batch) => {
                        let has_files = saved.inputs.iter().any(|input| !input.files.is_empty());
                        saved.stage = if has_files {
                            Stage::Attachments
                        } else {
                            Stage::Batch
                        };
                        if has_files {
                            saved.mapped = Some(batch.clone());
                        } else {
                            saved.batch = Some(batch.clone());
                        }
                        state.phase = Phase::Ready;
                        state.error = None;
                        if matches!(request.job, Job::Copy(_)) {
                            if has_files {
                                self.resume_revision_uploads();
                            } else {
                                state.requested = Some(Job::Start(batch));
                            }
                        }
                    }
                    Err(_) => {
                        state.phase = Phase::UnknownCopy;
                        state.error = Some("revision-changed");
                    }
                }
            }
            Ok(Output::Started) => {
                state.phase = Phase::Done;
                state.error = None;
                self.inbox.refresh();
            }
            Ok(Output::Blocked(message)) => {
                let mut problem = Editor::default();
                let message: String = message
                    .chars()
                    .map(|c| {
                        if c.is_control() && !matches!(c, '\n' | '\r' | '\t') {
                            ' '
                        } else {
                            c
                        }
                    })
                    .collect();
                problem.insert(&message);
                problem.key(crossterm::event::KeyEvent::new(
                    crossterm::event::KeyCode::Home,
                    crossterm::event::KeyModifiers::CONTROL,
                ));
                problem.clear_history();
                if !problem.text().trim().is_empty() {
                    state.problem = Some(problem);
                }
                state.phase = Phase::Ready;
                state.error = Some("revision-blocked");
            }
            Ok(Output::Retained) => {
                state.phase = Phase::Retained;
                state.error = Some("revision-retained");
            }
            Ok(Output::Abandoned) => {
                if let Some(saved) = &state.saved {
                    self.attachments.forget(saved.upload_ids());
                }
                state.saved = None;
                state.clear_editors();
                state.phase = Phase::Failed;
                state.visible = false;
            }
            Ok(Output::Conflict) => {
                state.saved.as_mut().unwrap().stage = Stage::Draft;
                state.phase = Phase::Editing;
                state.error = Some("revision-changed");
            }
            Ok(Output::Missing) => {
                state.phase = if matches!(request.job, Job::TurnQuery(_)) {
                    Phase::UnknownTurn
                } else {
                    Phase::UnknownCopy
                };
                state.error = Some("revision-unknown");
            }
            Err(_) => {
                state.phase = match request.job {
                    Job::Load { .. } => Phase::Failed,
                    Job::Start(_) | Job::TurnQuery(_) => Phase::UnknownTurn,
                    _ => Phase::UnknownCopy,
                };
                state.error = Some("revision-unknown");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{
        Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    };
    use maka_client::ClientError;
    use maka_protocol::session::sources;
    use ratatui::{Terminal, backend::TestBackend};
    use serde_json::json;

    pub(super) fn frame(app: &mut App, width: u16, height: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|f| crate::view::draw(f, app)).unwrap();
        terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect()
    }
    pub(super) fn sources(session: &str) -> sources::Output {
        sources::decode_output(&json!({"sessionId":session,"turnId":"turn","messages":[
            {"messageId":"one","content":{"text":"🦀 @a.rs first","inlineReferences":[
                {"kind":"workspace_file","value":"@a.rs","label":"a.rs","start":3}]}},
            {"messageId":"two","content":{"text":"second","attachments":[
                {"kind":"image","name":"image.png","mimeType":"image/png","bytes":42,
                "ref":{"kind":"session_file","sessionId":session,"relativePath":"image.png"}}]}}
        ]}))
        .unwrap()
    }

    #[test]
    fn revision_edits_two_inputs_checkpoints_each_write_and_recovers_only_original_identities() {
        let (mut app, basis) = super::super::branch::tests::fixture();
        app.drafts
            .get_mut("source")
            .unwrap()
            .insert("Preserved composer");
        app.apply(Action::Revision(Command::Open(basis)));
        let load = app.revision_request().unwrap();
        assert!(!load.needs_checkpoint());
        app.revision_completed(load, Ok(Output::Sources(sources("source"))));
        frame(&mut app, 80, 24);
        let footer: Vec<_> = ["footer/discard", "footer/close", "footer/primary"]
            .into_iter()
            .map(|path| app.layer.rect(path).unwrap())
            .collect();
        assert!(
            footer.iter().all(|rect| rect.y == footer[0].y),
            "Discard, Close and Run share the action row"
        );
        app.input(Event::Paste("中文".into()));
        assert_eq!(
            app.revision.saved.as_ref().unwrap().inputs[0]
                .content
                .inline_references
                .as_ref()
                .unwrap()[0]
                .start,
            5
        );
        app.apply(Action::Revision(Command::Select(1)));
        frame(&mut app, 80, 24);
        app.input(Event::Paste("edited ".into()));
        let draft = app.revision.checkpoint().unwrap();
        draft.validate("root").unwrap();
        assert_eq!(draft.inputs[1].content.text, "edited second");
        assert!(draft.validate("foreign").is_err());
        app.input(Event::Mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        }));
        assert!(!app.revision.visible);
        assert!(app.revision_request().is_none());
        app.apply(Action::Revision(Command::Resume));
        frame(&mut app, 32, 10);
        assert!(!app.revision_enabled(&Command::Send));
        frame(&mut app, 80, 24);
        app.apply(Action::Revision(Command::Send));
        let copy = app.revision_request().unwrap();
        assert!(copy.needs_checkpoint());
        let mut stale = copy.clone();
        stale.sequence += 1;
        assert!(!app.revision_after_checkpoint(&stale, &Ok(())));
        assert!(app.revision_after_checkpoint(&copy, &Ok(())));
        assert!(!app.revision_after_checkpoint(&copy, &Ok(())));
        let target = app
            .revision
            .saved
            .as_ref()
            .unwrap()
            .copy
            .target_session_id
            .clone();
        app.revision_completed(
            copy.clone(),
            Err(RequestFailure::Unknown(ClientError::Protocol(
                "lost copy reply".into(),
            ))),
        );
        let frozen_copy = app.revision.checkpoint().unwrap();
        app.revision = State::default();
        app.revision.restore(frozen_copy);
        assert!(app.revision_request().is_none());
        app.apply(Action::Revision(Command::Resume));
        frame(&mut app, 80, 24);
        app.apply(Action::Revision(Command::Query));
        let lookup = app.revision_request().unwrap();
        app.revision_completed(lookup, Ok(Output::Missing));
        frame(&mut app, 80, 24);
        app.apply(Action::Revision(Command::Retry));
        let replay = app.revision_request().unwrap();
        assert_eq!(
            replay.job, copy.job,
            "retry retains the original target and source revision"
        );
        assert!(app.revision_after_checkpoint(&replay, &Ok(())));
        app.revision_completed(replay, Ok(Output::Sources(sources(&target))));
        let start = app.revision_request().unwrap();
        let Job::Start(batch) = &start.job else {
            panic!("one atomic batch expected");
        };
        assert_eq!(batch.messages.len(), 2);
        assert_eq!(batch.messages[0].content.text, "中文🦀 @a.rs first");
        assert_eq!(batch.messages[1].content.text, "edited second");
        assert!(
            matches!(&batch.messages[1].content.attachments.as_ref().unwrap()[0].storage_ref,
            maka_protocol::turn::StorageRef::SessionFile{session_id,..} if *session_id==target)
        );
        let saved = app.revision.checkpoint().unwrap();
        saved.validate("root").unwrap();
        let mut corrupted = saved.clone();
        corrupted.batch.as_mut().unwrap().messages[1].content.text = "lost original edit".into();
        assert!(corrupted.validate("root").is_err());
        assert!(app.revision_after_checkpoint(&start, &Ok(())));
        app.apply(Action::Revision(Command::Close));
        app.apply(Action::Visit(Route::Settings));
        app.revision_completed(
            start.clone(),
            Err(RequestFailure::Unknown(ClientError::Protocol(
                "lost reply".into(),
            ))),
        );
        assert_eq!(app.navigation.current(), Route::Settings);
        app.revision = State::default();
        app.revision.restore(saved);
        assert!(!app.revision.visible);
        assert!(
            app.revision_request().is_none(),
            "restore never writes or polls"
        );
        app.apply(Action::Revision(Command::Resume));
        frame(&mut app, 80, 24);
        app.apply(Action::Revision(Command::Query));
        let query = app.revision_request().unwrap();
        app.revision_completed(query.clone(), Ok(Output::Missing));
        assert!(app.revision.saved.as_ref().unwrap().batch.is_some());
        frame(&mut app, 80, 24);
        app.apply(Action::Revision(Command::Retry));
        let retry = app.revision_request().unwrap();
        assert_eq!(retry.job, start.job);
        app.revision_completed(query, Ok(Output::Started));
        assert_eq!(app.revision.pending.as_ref(), Some(&retry));
        assert!(app.revision_after_checkpoint(&retry, &Ok(())));
        let message = format!(
            "Grant access first.\n{}\nLast requirement",
            "More information.\n".repeat(80)
        );
        app.revision_completed(retry, Ok(Output::Blocked(format!("\u{001b}{message}"))));
        let summary = frame(&mut app, 80, 24);
        assert!(summary.contains("Grant access first."));
        assert!(!summary.contains("Last requirement"));
        assert!(app.revision_enabled(&Command::Details));
        app.apply(Action::Revision(Command::Details));
        frame(&mut app, 48, 22);
        let before = serde_json::to_value(app.revision.checkpoint().unwrap()).unwrap();
        app.input(Event::Paste("must not edit the error".into()));
        assert_eq!(
            serde_json::to_value(app.revision.checkpoint().unwrap()).unwrap(),
            before
        );
        app.input(Event::Key(KeyEvent::new(
            KeyCode::End,
            KeyModifiers::CONTROL,
        )));
        let details = frame(&mut app, 48, 22);
        assert!(details.contains("Last requirement"));
        assert!(!details.contains('\u{001b}'));
        assert!(app.revision_enabled(&Command::Send));
        app.apply(Action::Revision(Command::Send));
        let retry = app.revision_request().unwrap();
        assert!(app.revision.problem.is_none() && !app.revision.show_problem);
        assert_eq!(retry.job, start.job);
        assert!(app.revision_after_checkpoint(&retry, &Ok(())));
        app.revision_completed(retry, Ok(Output::Started));
        frame(&mut app, 80, 24);
        app.apply(Action::Revision(Command::Discard));
        frame(&mut app, 80, 24);
        assert_eq!(
            app.layer.focused_path(),
            Some("footer/cancel"),
            "cancel is default for destructive confirmation"
        );
        app.apply(Action::Revision(Command::ConfirmDiscard));
        let abandon = app.revision_request().unwrap();
        assert!(app.revision_after_checkpoint(&abandon, &Ok(())));
        app.revision_completed(abandon, Ok(Output::Retained));
        frame(&mut app, 80, 24);
        app.apply(Action::Revision(Command::Visit));
        assert_eq!(app.navigation.current(), Route::Session(target));
        assert_eq!(app.drafts["source"].text(), "Preserved composer");
        assert!(app.revision.saved.is_none());

        // A local save failure must not strand an unsent draft as an unknown copy.
        let mut restored = State::default();
        restored.restore(draft);
        app.revision = restored;
        app.apply(Action::Revision(Command::Resume));
        frame(&mut app, 80, 24);
        app.apply(Action::Revision(Command::Send));
        let request = app.revision_request().unwrap();
        assert!(!app.revision_after_checkpoint(&request, &Err("disk full".into())));
        assert!(app.revision.phase == Phase::Editing);
        assert!(app.revision.saved.as_ref().unwrap().stage == Stage::Draft);
        frame(&mut app, 80, 24);
        app.input(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        assert!(!app.revision.visible);
    }
}
