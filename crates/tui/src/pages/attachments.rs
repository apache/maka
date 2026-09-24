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

pub mod io;
mod view;
use crate::{
    app::{Action, App, ConnectionState},
    navigation::Route,
};
use maka_protocol::turn::AttachmentRef;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
pub use view::chips;
pub(crate) use view::size;
pub(crate) use view::{draw_field, sheet};

pub const LIMIT: usize = 8;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub name: String,
    pub mime: String,
    pub bytes: u64,
    pub digest: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Saved {
    pub id: String,
    pub path: PathBuf,
    pub manifest: Option<Manifest>,
    pub attachment: Option<AttachmentRef>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ticket {
    pub root: String,
    pub epoch: String,
    pub session: String,
    pub input: Option<String>,
    pub id: String,
    generation: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Open,
    Browse,
    Directory,
    Skills,
    Close,
    Path,
    Parent,
    EnterPath,
    Pick(usize),
    Select(usize),
    Retry,
    Remove,
    Details,
}
impl Command {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Open | Self::Select(_) => "attachments-title",
            Self::Browse => "attachments-add",
            Self::Directory => "references-title",
            Self::Skills => "skills-title",
            Self::Close => "attachments-close",
            Self::Path => "attachments-path",
            Self::Parent => "directory-parent",
            Self::EnterPath | Self::Pick(_) => "attachments-choose",
            Self::Retry => "attachments-retry",
            Self::Remove => "attachments-remove",
            Self::Details => "attachments-details",
        }
    }
}
#[derive(Default)]
pub struct Transfer {
    pub cancelled: AtomicBool,
    pub bytes: AtomicU64,
}
pub struct Prepared {
    pub manifest: Manifest,
    pub bytes: Vec<u8>,
}
pub enum Read {
    Prepared(Prepared),
    Recovered(AttachmentRef),
}
pub enum Completed {
    Browsed(io::Browse, Result<io::Listing, Failure>),
    Prepared(Ticket, Result<Read, Failure>),
    Uploaded(Ticket, Result<AttachmentRef, Failure>),
}
#[derive(Debug)]
pub enum Failure {
    Invalid,
    TooLarge,
    Changed,
    Io(String),
    Host(String),
    Checkpoint(String),
}
impl Failure {
    pub fn key(&self) -> &'static str {
        match self {
            Self::Invalid => "attachments-invalid",
            Self::TooLarge => "attachments-too-large",
            Self::Changed => "attachments-changed",
            Self::Io(_) => "attachments-read-failed",
            Self::Host(_) => "attachments-upload-failed",
            Self::Checkpoint(_) => "attachments-save-failed",
        }
    }
    fn detail(&self) -> Option<&str> {
        match self {
            Self::Io(s) | Self::Host(s) | Self::Checkpoint(s) => Some(s),
            _ => None,
        }
    }
}
#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Reading,
    Checkpoint,
    Uploading,
}
struct Active {
    ticket: Ticket,
    phase: Phase,
    prepared: Option<Prepared>,
    transfer: Arc<Transfer>,
}
#[derive(Default)]
pub struct State {
    pub saved: BTreeMap<String, Vec<Saved>>,
    queued: VecDeque<(String, Option<String>, String)>,
    errors: HashMap<String, Failure>,
    active: Option<Active>,
    pub dialog: Option<Dialog>,
    pub browser_pending: Option<io::Browse>,
    generation: u64,
}
pub struct Dialog {
    session: String,
    input: Option<String>,
    browse: bool,
    path: crate::editor::Editor,
    directory: PathBuf,
    entries: Vec<io::Entry>,
    truncated: bool,
    requested: bool,
    generation: u64,
    /// The listed file that Resume, Remove and Details act on; it follows
    /// the list's focus.
    selected: usize,
    rendered: bool,
    problem: Option<Failure>,
    details: bool,
}
impl State {
    pub fn has(&self, session: &str) -> bool {
        self.saved
            .get(session)
            .is_some_and(|items| !items.is_empty())
    }
    pub fn ready(&self, session: &str) -> bool {
        self.saved
            .get(session)
            .is_none_or(|items| items.iter().all(|item| item.attachment.is_some()))
    }
    pub fn references(&self, session: &str) -> Option<Vec<AttachmentRef>> {
        self.saved
            .get(session)
            .filter(|items| !items.is_empty())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.attachment.clone())
                    .collect()
            })
    }
    pub fn clear_sent(&mut self, session: &str, sent: &Option<Vec<AttachmentRef>>) {
        if self.references(session) == *sent {
            self.saved.remove(session);
        }
    }
    pub fn retire(&mut self, session: &str) {
        self.queued.retain(|(owner, _, _)| owner != session);
        if let Some(active) = &self.active
            && active.ticket.session == session
        {
            active.transfer.cancelled.store(true, Ordering::Relaxed);
        }
    }
    pub fn disconnect(&mut self) {
        self.queued.clear();
        if let Some(active) = &self.active {
            active.transfer.cancelled.store(true, Ordering::Relaxed);
        }
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.phase == Phase::Checkpoint)
        {
            self.active = None;
        }
    }
    pub fn uploading(&self) -> bool {
        self.active
            .as_ref()
            .is_some_and(|a| a.phase == Phase::Uploading)
    }
    pub(crate) fn failed(&self, id: &str) -> bool {
        self.errors.contains_key(id)
    }
    pub(crate) fn forget<'a>(&mut self, ids: impl Iterator<Item = &'a str>) {
        for id in ids {
            self.errors.remove(id);
        }
    }
    pub fn begin_frame(&mut self) {
        if let Some(dialog) = &mut self.dialog {
            dialog.rendered = false;
            dialog.path.invalidate_geometry();
        }
    }
    /// The sheet reports whether it is on screen; its commands need it.
    pub(crate) fn presented(&mut self, shown: bool) {
        if let Some(dialog) = &mut self.dialog {
            dialog.rendered = shown;
        }
    }
    fn status(&self, item: &Saved) -> (&'static str, Option<u64>) {
        if item.attachment.is_some() {
            return ("attachments-ready", None);
        }
        if let Some(active) = self.active.as_ref().filter(|a| a.ticket.id == item.id) {
            return match active.phase {
                Phase::Reading => ("attachments-reading", None),
                Phase::Checkpoint => ("attachments-saving", None),
                Phase::Uploading => (
                    "attachments-uploading",
                    Some(active.transfer.bytes.load(Ordering::Relaxed)),
                ),
            };
        }
        if let Some(error) = self.errors.get(&item.id) {
            return (error.key(), None);
        }
        if self.queued.iter().any(|(_, _, id)| id == &item.id) {
            ("attachments-queued", None)
        } else {
            ("attachments-paused", None)
        }
    }
}
impl App {
    pub(crate) fn attachment_files(&self, session: &str, input: Option<&str>) -> &[Saved] {
        if let Some(input) = input {
            self.revision.files(session, input).unwrap_or(&[])
        } else {
            self.attachments
                .saved
                .get(session)
                .map(Vec::as_slice)
                .unwrap_or(&[])
        }
    }
    fn attachment_files_mut(
        &mut self,
        session: &str,
        input: Option<&str>,
    ) -> Option<&mut Vec<Saved>> {
        if let Some(input) = input {
            self.revision.files_mut(session, input)
        } else {
            Some(self.attachments.saved.entry(session.into()).or_default())
        }
    }
    fn attachment_entry(&self, ticket: &Ticket) -> Option<&Saved> {
        self.attachment_files(&ticket.session, ticket.input.as_deref())
            .iter()
            .find(|f| f.id == ticket.id)
    }
    fn attachment_entry_mut(&mut self, ticket: &Ticket) -> Option<&mut Saved> {
        self.attachment_files_mut(&ticket.session, ticket.input.as_deref())?
            .iter_mut()
            .find(|f| f.id == ticket.id)
    }
    fn attachment_uploadable(&self, session: &str, input: Option<&str>) -> bool {
        if let Some(input) = input {
            matches!(&self.connection, ConnectionState::Connected { root_id, .. }
                if self.revision.uploadable(root_id, session, input))
        } else {
            self.attachment_editable(session)
        }
    }
    pub(crate) fn queue_revision_files(&mut self, session: &str, files: Vec<(String, String)>) {
        for (input, id) in files {
            if !self
                .attachments
                .queued
                .iter()
                .any(|(_, _, queued)| *queued == id)
                && self.attachments.active.as_ref().is_none_or(|active| {
                    active.ticket.id != id || active.transfer.cancelled.load(Ordering::Relaxed)
                })
            {
                self.attachments.errors.remove(&id);
                self.attachments
                    .queued
                    .push_back((session.into(), Some(input), id));
            }
        }
    }
    pub(crate) fn open_revision_files(&mut self, session: String, input: String) {
        self.open_attachment_dialog(session, Some(input));
    }
    fn open_attachment_dialog(&mut self, session: String, input: Option<String>) {
        let browse = self.attachment_files(&session, input.as_deref()).is_empty();
        self.attachments.generation += 1;
        self.attachments.dialog = Some(Dialog {
            session,
            input,
            browse,
            path: crate::editor::Editor::bounded(4096, "attachments-path-long"),
            directory: PathBuf::new(),
            entries: vec![],
            truncated: false,
            requested: true,
            generation: self.attachments.generation,
            selected: 0,
            rendered: false,
            problem: None,
            details: false,
        });
    }
    fn attachment_identity(&self, ticket: &Ticket) -> bool {
        matches!(&self.connection, ConnectionState::Connected {root_id, epoch} if *root_id == ticket.root && *epoch == ticket.epoch)
    }
    pub(crate) fn attachment_editable(&self, session: &str) -> bool {
        matches!(self.connection, ConnectionState::Connected { .. })
            && self.drafts.contains_key(session)
            && !(self.chat.session.as_deref() == Some(session) && self.chat.removed)
            && !matches!(&self.sessions.detail, crate::pages::sessions::Detail::Missing {id} if id == session)
            && !self
                .sending
                .get(session)
                .is_some_and(|sent| sent.delivery.blocks_send())
    }
    pub fn attachment_enabled(&self, command: &Command) -> bool {
        if *command == Command::Skills {
            return self.skills_enabled(&crate::pages::skills::Command::Open);
        }
        if *command == Command::Directory {
            return self.enabled(&Action::References);
        }
        if *command == Command::Close {
            return true;
        }
        let Some(dialog) = &self.attachments.dialog else {
            return matches!(command, Command::Open | Command::Browse)
                && matches!(self.navigation.current(), Route::Session(ref id) if self.drafts.contains_key(id));
        };
        if !dialog.rendered {
            return false;
        }
        let items = self.attachment_files(&dialog.session, dialog.input.as_deref());
        let count = items.len();
        let editable = if let Some(input) = &dialog.input {
            self.revision.files_editable(&dialog.session, input)
                && matches!(self.connection, ConnectionState::Connected { .. })
        } else {
            self.attachment_editable(&dialog.session)
        };
        let capacity = if let Some(input) = &dialog.input {
            self.revision.file_capacity(&dialog.session, input)
        } else {
            LIMIT
        };
        match command {
            Command::Open | Command::Close | Command::Details | Command::Select(_) => true,
            Command::Browse => editable && count < capacity,
            Command::Directory | Command::Skills => unreachable!(),
            Command::Parent | Command::Path | Command::EnterPath | Command::Pick(_) => {
                editable && count < capacity
            }
            Command::Remove => {
                dialog.selected < count
                    && (dialog.input.is_none() || editable)
                    && !self
                        .sending
                        .get(&dialog.session)
                        .is_some_and(|sent| sent.delivery.blocks_send())
            }
            Command::Retry => {
                self.attachment_uploadable(&dialog.session, dialog.input.as_deref())
                    && items.get(dialog.selected).is_some_and(|item| {
                        item.attachment.is_none()
                            && self
                                .attachments
                                .active
                                .as_ref()
                                .is_none_or(|active| active.ticket.id != item.id)
                            && !self
                                .attachments
                                .queued
                                .iter()
                                .any(|(_, _, id)| id == &item.id)
                    })
            }
        }
    }
    pub fn attachment_action(&mut self, command: Command) -> Option<Action> {
        if command == Command::Skills {
            self.attachments.dialog = None;
            self.skills_action(crate::pages::skills::Command::Open);
            return None;
        }
        if command == Command::Directory {
            self.attachments.dialog = None;
            self.open_references();
            return None;
        }
        if command == Command::Close {
            self.attachments.dialog = None;
            return None;
        }
        if self.attachments.dialog.is_none() {
            let Route::Session(session) = self.navigation.current() else {
                return None;
            };
            self.open_attachment_dialog(session, None);
            return None;
        }
        if matches!(command, Command::Retry | Command::Remove) {
            let dialog = self.attachments.dialog.as_ref()?;
            let (session, input, index) = (
                dialog.session.clone(),
                dialog.input.clone(),
                dialog.selected,
            );
            let item = self
                .attachment_files(&session, input.as_deref())
                .get(index)?
                .clone();
            self.attachments.errors.remove(&item.id);
            if command == Command::Retry {
                self.attachments.queued.push_back((session, input, item.id));
            } else {
                let items = self.attachment_files_mut(&session, input.as_deref())?;
                items.remove(index);
                let selected = index.min(items.len().saturating_sub(1));
                self.attachments.dialog.as_mut()?.selected = selected;
                self.attachments.queued.retain(|(_, _, id)| *id != item.id);
                if let Some(active) = self
                    .attachments
                    .active
                    .as_ref()
                    .filter(|a| a.ticket.id == item.id)
                {
                    active.transfer.cancelled.store(true, Ordering::Relaxed);
                    if active.phase == Phase::Checkpoint {
                        self.attachments.active = None;
                    }
                }
            }
            return None;
        }
        let dialog = self.attachments.dialog.as_mut()?;
        match command {
            Command::Open => {
                dialog.browse = false;
                dialog.selected = 0;
            }
            Command::Directory | Command::Skills => unreachable!(),
            Command::Browse => {
                dialog.browse = true;
                dialog.selected = 0;
                dialog.requested = true;
            }
            Command::Path => self.layer.focus(view::PATH),
            Command::Details => dialog.details = !dialog.details,
            Command::Parent => {
                if let Some(parent) = dialog.directory.parent() {
                    dialog.directory = parent.into();
                    dialog.requested = true;
                }
            }
            Command::EnterPath => {
                let path = PathBuf::from(dialog.path.text());
                if path.as_os_str().is_empty() {
                    return None;
                }
                dialog.directory = if path.is_absolute() {
                    path
                } else {
                    dialog.directory.join(path)
                };
                dialog.requested = true;
            }
            Command::Pick(index) => {
                let entry = dialog.entries.get(index)?;
                dialog.directory = entry.path.clone();
                dialog.requested = true;
            }
            Command::Select(index) => {
                dialog.selected = index;
                dialog.details = false;
            }
            Command::Retry | Command::Remove => unreachable!(),
            Command::Close => {}
        }
        None
    }
    pub fn attachment_browse_request(&mut self) -> Option<io::Browse> {
        if self.attachments.browser_pending.is_some() {
            return None;
        }
        let dialog = self.attachments.dialog.as_mut()?;
        if !dialog.browse || !dialog.requested {
            return None;
        }
        dialog.requested = false;
        dialog.entries.clear();
        dialog.selected = 0;
        dialog.problem = None;
        dialog.generation += 1;
        let request = io::Browse {
            generation: dialog.generation,
            session: dialog.session.clone(),
            input: dialog.input.clone(),
            path: dialog.directory.clone(),
        };
        self.attachments.browser_pending = Some(request.clone());
        Some(request)
    }
    pub fn attachment_browsed(
        &mut self,
        request: io::Browse,
        result: Result<io::Listing, Failure>,
    ) {
        if self.attachments.browser_pending.as_ref() != Some(&request) {
            return;
        }
        self.attachments.browser_pending = None;
        let valid = self.attachments.dialog.as_ref().is_some_and(|d| {
            d.generation == request.generation
                && d.session == request.session
                && d.input == request.input
                && d.browse
                && !d.requested
        });
        if !valid {
            return;
        }
        if let Ok(io::Listing::File(path)) = &result {
            let editable = if let Some(input) = &request.input {
                self.revision.files_editable(&request.session, input)
            } else {
                self.attachment_editable(&request.session)
            };
            let capacity = request.input.as_ref().map_or(LIMIT, |input| {
                self.revision.file_capacity(&request.session, input)
            });
            if !editable {
                return;
            }
            let Some(items) = self.attachment_files_mut(&request.session, request.input.as_deref())
            else {
                return;
            };
            if items.len() >= capacity {
                return;
            }
            let id = uuid::Uuid::new_v4().to_string();
            items.push(Saved {
                id: id.clone(),
                path: path.clone(),
                manifest: None,
                attachment: None,
            });
            if request.input.is_none() {
                self.attachments
                    .queued
                    .push_back((request.session, None, id));
            }
            self.attachments.dialog = None;
            return;
        }
        let dialog = self.attachments.dialog.as_mut().unwrap();
        match result {
            Ok(io::Listing::Directory {
                path,
                entries,
                truncated,
            }) => {
                dialog.directory = path.clone();
                dialog.entries = entries;
                dialog.truncated = truncated;
                dialog.path = crate::editor::Editor::bounded(4096, "attachments-path-long");
                dialog.path.insert(&path.to_string_lossy());
            }
            Ok(_) => {}
            Err(error) => dialog.problem = Some(error),
        }
    }
    pub fn attachment_read_request(&mut self) -> Option<(Ticket, Saved, Arc<Transfer>)> {
        if self.closing || self.attachments.active.is_some() {
            return None;
        }
        let ConnectionState::Connected { root_id, epoch } = &self.connection else {
            return None;
        };
        let (session, input, id) = self.attachments.queued.pop_front()?;
        self.attachments.generation += 1;
        let ticket = Ticket {
            root: root_id.clone(),
            epoch: epoch.clone(),
            session,
            input,
            id,
            generation: self.attachments.generation,
        };
        let saved = self.attachment_entry(&ticket)?.clone();
        if !self.attachment_uploadable(&ticket.session, ticket.input.as_deref()) {
            return None;
        }
        let transfer = Arc::new(Transfer::default());
        self.attachments.active = Some(Active {
            ticket: ticket.clone(),
            phase: Phase::Reading,
            prepared: None,
            transfer: transfer.clone(),
        });
        Some((ticket, saved, transfer))
    }
    pub fn attachment_prepared(
        &mut self,
        ticket: Ticket,
        result: Result<Read, Failure>,
    ) -> Option<Ticket> {
        if self
            .attachments
            .active
            .as_ref()
            .is_none_or(|a| a.ticket != ticket)
        {
            return None;
        }
        if !self.attachment_identity(&ticket)
            || self.attachment_entry(&ticket).is_none()
            || self
                .attachments
                .active
                .as_ref()
                .unwrap()
                .transfer
                .cancelled
                .load(Ordering::Relaxed)
        {
            self.attachments.active = None;
            return None;
        }
        match result {
            Ok(Read::Recovered(reference)) => {
                self.attachment_entry_mut(&ticket)?.attachment = Some(reference);
                self.attachments.active = None;
            }
            Ok(Read::Prepared(prepared)) => {
                self.attachment_entry_mut(&ticket)?.manifest = Some(prepared.manifest.clone());
                let active = self.attachments.active.as_mut()?;
                active.prepared = Some(prepared);
                active.phase = Phase::Checkpoint;
                return Some(ticket);
            }
            Err(error) => {
                self.attachments.errors.insert(ticket.id, error);
                self.attachments.active = None;
            }
        }
        None
    }
    pub fn attachment_after_checkpoint(
        &mut self,
        ticket: &Ticket,
        result: &Result<(), String>,
    ) -> Option<(Prepared, Arc<Transfer>)> {
        if self
            .attachments
            .active
            .as_ref()
            .is_none_or(|a| a.ticket != *ticket || a.phase != Phase::Checkpoint)
        {
            return None;
        }
        if !self.attachment_identity(ticket)
            || self.attachment_entry(ticket).is_none()
            || self.closing
            || self
                .attachments
                .active
                .as_ref()
                .unwrap()
                .transfer
                .cancelled
                .load(Ordering::Relaxed)
        {
            self.attachments.active = None;
            return None;
        }
        if let Err(error) = result {
            self.attachments
                .errors
                .insert(ticket.id.clone(), Failure::Checkpoint(error.clone()));
            self.attachments.active = None;
            return None;
        }
        let active = self.attachments.active.as_mut()?;
        active.phase = Phase::Uploading;
        Some((active.prepared.take()?, active.transfer.clone()))
    }
    pub fn attachment_uploaded(&mut self, ticket: Ticket, result: Result<AttachmentRef, Failure>) {
        if self
            .attachments
            .active
            .as_ref()
            .is_none_or(|a| a.ticket != ticket)
        {
            return;
        }
        let cancelled = self
            .attachments
            .active
            .as_ref()
            .unwrap()
            .transfer
            .cancelled
            .load(Ordering::Relaxed);
        self.attachments.active = None;
        if cancelled
            || !self.attachment_identity(&ticket)
            || self.attachment_entry(&ticket).is_none()
        {
            return;
        }
        match result {
            Ok(reference) => {
                self.attachment_entry_mut(&ticket).unwrap().attachment = Some(reference)
            }
            Err(error) => {
                self.attachments.errors.insert(ticket.id, error);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        i18n::{I18n, Locale, LocalePreference},
        navigation::Route,
    };
    use crossterm::event::{Event, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
    use ratatui::{Terminal, backend::TestBackend};
    fn render(app: &mut App, width: u16, height: u16) {
        Terminal::new(TestBackend::new(width, height))
            .unwrap()
            .draw(|f| crate::view::draw(f, app))
            .unwrap();
    }
    fn app() -> App {
        let mut app = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Session("a".into())));
        app
    }
    fn select(app: &mut App) -> Ticket {
        app.apply(Action::Attachment(Command::Open));
        render(app, 80, 24);
        let request = app.attachment_browse_request().unwrap();
        app.attachment_browsed(request, Ok(io::Listing::File("/local/中文.txt".into())));
        app.attachment_read_request().unwrap().0
    }
    fn prepared() -> Prepared {
        Prepared {
            manifest: Manifest {
                name: "中文.txt".into(),
                mime: "text/plain".into(),
                bytes: 1,
                digest: maka_protocol::artifact::content_digest(b"x"),
            },
            bytes: b"x".to_vec(),
        }
    }
    fn reference(ticket: &Ticket) -> AttachmentRef {
        serde_json::from_value(serde_json::json!({"kind":"other","name":"中文.txt","mimeType":"text/plain","bytes":1,
            "ref":{"kind":"session_file","sessionId":ticket.session,"relativePath":maka_protocol::artifact::upload_artifact_id(&ticket.session,&ticket.id)}})).unwrap()
    }
    #[test]
    fn attachment_lifetime_keeps_owner_checkpoint_and_submission_boundaries() {
        let mut app = app();
        let ticket = select(&mut app);
        assert!(!app.enabled(&Action::SendMessage));
        app.apply(Action::Visit(Route::Session("b".into())));
        let gate = app
            .attachment_prepared(ticket.clone(), Ok(Read::Prepared(prepared())))
            .unwrap();
        assert!(
            app.attachment_after_checkpoint(&gate, &Err("disk unavailable".into()))
                .is_none()
        );
        assert!(!app.attachments.ready("a"));
        assert!(!app.attachments.has("b"));
        app.apply(Action::Visit(Route::Session("a".into())));
        app.apply(Action::Attachment(Command::Open));
        render(&mut app, 80, 24);
        assert!(app.attachment_enabled(&Command::Retry));
        app.apply(Action::Attachment(Command::Retry));
        app.apply(Action::Attachment(Command::Close));
        let retry = app.attachment_read_request().unwrap().0;
        assert_eq!(retry.id, ticket.id);
        assert_ne!(retry, ticket);
        assert!(
            app.attachment_prepared(ticket.clone(), Ok(Read::Prepared(prepared())))
                .is_none()
        );
        app.attachment_prepared(retry.clone(), Ok(Read::Prepared(prepared())))
            .unwrap();
        assert!(app.attachment_after_checkpoint(&ticket, &Ok(())).is_none());
        let (_, transfer) = app.attachment_after_checkpoint(&retry, &Ok(())).unwrap();
        assert!(!transfer.cancelled.load(Ordering::Relaxed));
        assert!(
            app.attachment_after_checkpoint(&retry, &Ok(())).is_none(),
            "one checkpoint cannot dispatch twice"
        );
        app.attachment_uploaded(ticket, Ok(reference(&retry)));
        assert!(
            !app.attachments.ready("a"),
            "late generation cannot finish current upload"
        );
        app.attachment_uploaded(retry.clone(), Ok(reference(&retry)));
        assert!(
            app.enabled(&Action::SendMessage),
            "attachments alone are a valid message"
        );
        let request = app.submission().unwrap();
        assert!(request.content.text.is_empty());
        assert_eq!(request.content.attachments, Some(vec![reference(&retry)]));
        app.apply(Action::Attachment(Command::Open));
        render(&mut app, 80, 24);
        assert!(
            !app.attachment_enabled(&Command::Remove),
            "unconfirmed send freezes attachments"
        );
        app.apply(Action::Attachment(Command::Close));
        app.drafts.get_mut("a").unwrap().insert("new body");
        app.submitted(
            request,
            Ok(maka_protocol::message::SubmitResult::Blocked {
                message: "explicit failure".into(),
                preparation: vec![],
            }),
        );
        assert!(app.attachments.has("a"), "failure preserves full draft");
        let request = app.submission().unwrap();
        app.drafts.get_mut("a").unwrap().insert(" edited");
        app.abandon_pending_submissions();
        let checking = app.reconciliation().unwrap();
        app.reconciled(
            checking,
            Ok(Some(maka_protocol::message::ExecutionResolution::Pending {
                message_id: request.id,
            })),
        );
        assert!(!app.attachments.has("a"));
        assert_eq!(app.drafts["a"].text(), "new body edited");
    }

    #[test]
    fn picker_consumes_outside_click_and_cancellation_cannot_reattach_late_results() {
        for locale in Locale::ALL {
            let mut app = app();
            app.i18n.preference = LocalePreference::Explicit(locale);
            app.apply(Action::Attachment(Command::Open));
            render(&mut app, 80, 24);
            let stale = app.attachment_browse_request().unwrap();
            app.input(Event::Mouse(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: 0,
                row: 0,
                modifiers: KeyModifiers::NONE,
            }));
            assert!(app.attachments.dialog.is_none());
            assert_eq!(app.navigation.current(), Route::Session("a".into()));
            app.apply(Action::Attachment(Command::Open));
            render(&mut app, 30, 10);
            app.attachment_browsed(stale, Ok(io::Listing::File("/local/stale".into())));
            assert!(!app.attachments.has("a"));
            let request = app.attachment_browse_request().unwrap();
            app.attachment_browsed(request, Ok(io::Listing::File("/local/中文.txt".into())));
            let (ticket, _, transfer) = app.attachment_read_request().unwrap();
            app.attachment_prepared(ticket.clone(), Ok(Read::Prepared(prepared())));
            app.attachment_after_checkpoint(&ticket, &Ok(())).unwrap();
            app.apply(Action::Attachment(Command::Open));
            for (w, h) in [(30, 10), (80, 24), (120, 40)] {
                render(&mut app, w, h);
            }
            app.apply(Action::Attachment(Command::Remove));
            assert!(transfer.cancelled.load(Ordering::Relaxed));
            app.attachment_uploaded(ticket.clone(), Ok(reference(&ticket)));
            assert!(!app.attachments.has("a"));
            app.apply(Action::Attachment(Command::Close));
            let ticket = select(&mut app);
            app.attachments.disconnect();
            app.connection = ConnectionState::Connected {
                root_id: "root".into(),
                epoch: "other".into(),
            };
            assert!(
                app.attachment_prepared(ticket, Ok(Read::Prepared(prepared())))
                    .is_none()
            );
            assert!(
                app.attachment_read_request().is_none(),
                "reconnect never reopens local files automatically"
            );
        }
    }
}
