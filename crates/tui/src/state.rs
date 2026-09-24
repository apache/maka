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

mod snapshot;
mod store;

use crate::{
    app::App,
    pages::{branch, extensions, manage::oauth, recap, resume, revision, sending::Submission},
};
use maka_client::Error;
use snapshot::Snapshot;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub struct State {
    root: String,
    store: Arc<Mutex<store::Store>>,
    deadline: Option<Instant>,
    requests: Vec<Submission>,
    oauth: Option<oauth::Request>,
    branch: Option<branch::Request>,
    recap: Option<recap::Request>,
    resume: Option<resume::Request>,
    revision: Option<revision::Request>,
    extension: Option<extensions::Request>,
    attachment: Option<crate::pages::attachments::Ticket>,
    generation: u64,
    job: Option<Writing>,
}

struct Writing {
    task: tokio::task::JoinHandle<Result<(), String>>,
    requests: Vec<Submission>,
    oauth: Option<oauth::Request>,
    branch: Option<branch::Request>,
    recap: Option<recap::Request>,
    resume: Option<resume::Request>,
    revision: Option<revision::Request>,
    extension: Option<extensions::Request>,
    attachment: Option<crate::pages::attachments::Ticket>,
    generation: u64,
}

pub struct Written {
    pub result: Result<(), String>,
    pub requests: Vec<Submission>,
    pub oauth: Option<oauth::Request>,
    pub branch: Option<branch::Request>,
    pub recap: Option<recap::Request>,
    pub resume: Option<resume::Request>,
    pub revision: Option<revision::Request>,
    pub extension: Option<extensions::Request>,
    pub attachment: Option<crate::pages::attachments::Ticket>,
}
impl State {
    pub async fn open(
        root: &Path,
        profile: &str,
    ) -> Result<Option<(Self, Option<Snapshot>)>, Error> {
        let root = root.to_owned();
        let profile = profile.to_owned();
        tokio::task::spawn_blocking(move || {
            // Missing/invalid Host roots remain diagnosable in the normal UI.
            // Do not create a Host Root or a path-keyed substitute identity.
            let Ok(location) = maka_event_log::root::resolve(&root) else {
                return Ok(None);
            };
            let base = match std::env::var_os("MAKA_TUI_STATE_DIR") {
                Some(base) => PathBuf::from(base),
                None => maka_event_log::root::RootNamespaces::for_current_account()?
                    .ownership
                    .parent()
                    .ok_or("missing account directory")?
                    .join("tui"),
            };
            let (store, saved) = store::Store::open(&base, location.root_id(), &profile)?;
            Ok::<_, Error>(Some((
                Self {
                    root: store.root.clone(),
                    store: Arc::new(Mutex::new(store)),
                    deadline: None,
                    requests: Vec::new(),
                    oauth: None,
                    branch: None,
                    recap: None,
                    resume: None,
                    revision: None,
                    extension: None,
                    attachment: None,
                    generation: 0,
                    job: None,
                },
                saved,
            )))
        })
        .await?
    }
    pub fn changed(&mut self) {
        self.deadline
            .get_or_insert_with(|| Instant::now() + Duration::from_millis(500));
    }
    pub fn wait(&self) -> Option<Duration> {
        if self.job.is_some() {
            return None;
        }
        self.deadline
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
    }
    pub fn force(&mut self) {
        self.deadline = Some(Instant::now());
    }
    pub fn submit(&mut self, request: Submission) {
        // App permits at most one unresolved request per bounded draft slot.
        self.requests
            .retain(|pending| pending.session != request.session);
        self.requests.push(request);
        self.force();
    }
    pub fn cancel_requests(&mut self) -> Vec<Submission> {
        self.oauth = None;
        self.branch = None;
        self.recap = None;
        self.resume = None;
        self.revision = None;
        self.extension = None;
        self.attachment = None;
        let mut requests = std::mem::take(&mut self.requests);
        if let Some(job) = &self.job
            && job.generation == self.generation
        {
            requests.extend(job.requests.iter().cloned());
        }
        self.generation += 1;
        requests
    }
    pub fn submit_oauth(&mut self, request: oauth::Request) {
        self.oauth = Some(request);
        self.force();
    }
    pub fn submit_recap(&mut self, request: recap::Request) {
        self.recap = Some(request);
        self.force();
    }
    pub fn submit_resume(&mut self, request: resume::Request) {
        self.resume = Some(request);
        self.force();
    }
    pub fn submit_branch(&mut self, request: branch::Request) {
        self.branch = Some(request);
        self.force();
    }
    pub fn submit_attachment(&mut self, request: crate::pages::attachments::Ticket) {
        self.attachment = Some(request);
        self.force();
    }
    pub fn submit_revision(&mut self, request: revision::Request) {
        self.revision = Some(request);
        self.force();
    }
    pub fn submit_extension(&mut self, request: extensions::Request) {
        self.extension = Some(request);
        self.force();
    }
    pub fn idle(&self) -> bool {
        self.job.is_none() && self.deadline.is_none()
    }
    pub fn start(&mut self, app: &App) {
        if self.wait() != Some(Duration::ZERO) {
            return;
        }
        self.deadline = None;
        let snapshot = Snapshot::capture(app, &self.root);
        let store = self.store.clone();
        let requests = std::mem::take(&mut self.requests);
        let generation = self.generation;
        self.job = Some(Writing {
            task: tokio::task::spawn_blocking(move || {
                store
                    .lock()
                    .map_err(|_| "TUI state writer failed".to_owned())
                    .and_then(|mut store| store.save(snapshot).map_err(|e| e.to_string()))
            }),
            requests,
            oauth: self.oauth.take(),
            branch: self.branch.take(),
            recap: self.recap.take(),
            resume: self.resume.take(),
            revision: self.revision.take(),
            extension: self.extension.take(),
            attachment: self.attachment.take(),
            generation,
        });
    }
    /// Cancellation-safe: select! may stop waiting, but never detaches the writer.
    pub async fn completed(&mut self) -> Written {
        let Some(job) = &mut self.job else {
            return std::future::pending().await;
        };
        let result = (&mut job.task)
            .await
            .unwrap_or_else(|error| Err(error.to_string()));
        let job = self.job.take().expect("completed writer");
        Written {
            result,
            extension: if job.generation == self.generation {
                job.extension
            } else {
                None
            },
            attachment: if job.generation == self.generation {
                job.attachment
            } else {
                None
            },
            requests: if job.generation == self.generation {
                job.requests
            } else {
                Vec::new()
            },
            oauth: if job.generation == self.generation {
                job.oauth
            } else {
                None
            },
            revision: if job.generation == self.generation {
                job.revision
            } else {
                None
            },
            recap: if job.generation == self.generation {
                job.recap
            } else {
                None
            },
            resume: if job.generation == self.generation {
                job.resume
            } else {
                None
            },
            branch: if job.generation == self.generation {
                job.branch
            } else {
                None
            },
        }
    }
    /// Terminal EOF/signals have no interactive loop to keep responsive.
    pub async fn finish(&mut self, app: &App) -> Result<(), String> {
        self.cancel_requests();
        if self.job.is_some() {
            self.completed().await;
        }
        self.force();
        self.start(app);
        self.completed().await.result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        app::{Action, ConnectionState},
        i18n::{I18n, Locale, LocalePreference},
        navigation::Route,
    };
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};

    const ROOT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    fn fixture() -> (tempfile::TempDir, State, App) {
        let directory = tempfile::tempdir().unwrap();
        let (store, _) = store::Store::open(directory.path(), ROOT, "default").unwrap();
        let state = State {
            root: ROOT.into(),
            store: Arc::new(Mutex::new(store)),
            deadline: None,
            requests: vec![],
            oauth: None,
            branch: None,
            recap: None,
            resume: None,
            revision: None,
            extension: None,
            attachment: None,
            generation: 0,
            job: None,
        };
        let mut app = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Auto, Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: ROOT.into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Session("a".into())));
        (directory, state, app)
    }

    #[tokio::test]
    async fn attachment_checkpoint_precedes_upload_and_reopen_requires_explicit_resume() {
        use crate::pages::attachments::{Command, Manifest, Prepared, Read, io::Listing};
        use ratatui::{Terminal, backend::TestBackend};
        let (directory, mut state, mut app) = fixture();
        app.apply(Action::Attachment(Command::Open));
        Terminal::new(TestBackend::new(80, 24))
            .unwrap()
            .draw(|f| crate::view::draw(f, &mut app))
            .unwrap();
        let browse = app.attachment_browse_request().unwrap();
        app.attachment_browsed(browse, Ok(Listing::File("/local/file.txt".into())));
        let (ticket, _, _) = app.attachment_read_request().unwrap();
        let manifest = Manifest {
            name: "file.txt".into(),
            mime: "text/plain".into(),
            bytes: 1,
            digest: maka_protocol::artifact::content_digest(b"x"),
        };
        let ticket = app
            .attachment_prepared(
                ticket,
                Ok(Read::Prepared(Prepared {
                    manifest: manifest.clone(),
                    bytes: b"x".to_vec(),
                })),
            )
            .unwrap();
        let (release, blocked) = gate(&state).await;
        state.submit_attachment(ticket.clone());
        state.start(&app);
        assert!(
            tokio::time::timeout(Duration::from_millis(30), state.completed())
                .await
                .is_err()
        );
        release.send(()).unwrap();
        blocked.await.unwrap();
        let written = written(&mut state).await;
        assert_eq!(written.attachment, Some(ticket.clone()));
        assert!(written.result.is_ok());
        let saved = read(&directory);
        assert_eq!(saved["attachments"]["a"][0]["id"], ticket.id);
        assert_eq!(
            saved["attachments"]["a"][0]["manifest"],
            serde_json::to_value(&manifest).unwrap()
        );
        assert!(
            app.attachment_after_checkpoint(&ticket, &written.result)
                .is_some()
        );
        let (_, _, mut reopened) = fixture();
        serde_json::from_value::<Snapshot>(saved.clone())
            .unwrap()
            .restore(&mut reopened, false)
            .unwrap();
        assert!(reopened.attachments.dialog.is_none());
        assert!(reopened.attachment_read_request().is_none());
        assert!(!reopened.enabled(&Action::SendMessage));
        assert_eq!(reopened.attachments.saved["a"][0].id, ticket.id);
        for (pointer, value) in [
            ("/attachments/a/0/id", serde_json::json!("not-an-upload-id")),
            ("/attachments/a/0/path", serde_json::json!("relative.txt")),
            (
                "/attachments/a/0/manifest/bytes",
                serde_json::json!(50 * 1024 * 1024 + 1),
            ),
            (
                "/attachments/a/0/attachment",
                serde_json::json!({"kind":"other","name":"file.txt","mimeType":"text/plain","bytes":1,
                "ref":{"kind":"session_file","sessionId":"foreign","relativePath":"foreign"}}),
            ),
        ] {
            let mut invalid = saved.clone();
            *invalid.pointer_mut(pointer).unwrap() = value;
            assert!(
                serde_json::from_value::<Snapshot>(invalid)
                    .unwrap()
                    .validate(ROOT)
                    .is_err(),
                "{pointer}"
            );
        }
    }

    async fn gate(state: &State) -> (std::sync::mpsc::Sender<()>, tokio::task::JoinHandle<()>) {
        let store = state.store.clone();
        let (ready, started) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let task = tokio::task::spawn_blocking(move || {
            let _guard = store.lock().unwrap();
            ready.send(()).unwrap();
            let _ = wait.recv(); // Dropping the sender also releases the gate on test failure.
        });
        started.await.unwrap();
        (release, task)
    }
    async fn written(state: &mut State) -> Written {
        tokio::time::timeout(Duration::from_secs(5), state.completed())
            .await
            .unwrap()
    }
    fn read(directory: &tempfile::TempDir) -> serde_json::Value {
        serde_json::from_slice(
            &std::fs::read(directory.path().join(ROOT).join("default/state.json")).unwrap(),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn plugin_submission_requires_its_own_durable_checkpoint_and_never_replays_on_restore() {
        use crate::pages::extensions::Command;
        let (directory, mut state, _) = fixture();
        let mut app = extensions::tests::app();
        app.connection = ConnectionState::Connected {
            root_id: ROOT.into(),
            epoch: "epoch".into(),
        };
        app.extensions_action(Command::View(extensions::Intent::Toggle("enabled".into())));
        app.extensions_action(extensions::tests::save());
        let request = app.extensions_request().unwrap();
        let (release, blocked) = gate(&state).await;
        state.submit_extension(request.clone());
        state.start(&app);
        assert!(
            tokio::time::timeout(Duration::from_millis(30), state.completed())
                .await
                .is_err()
        );
        release.send(()).unwrap();
        blocked.await.unwrap();
        let completed = written(&mut state).await;
        assert!(completed.extension.is_some());
        assert!(completed.result.is_ok(), "{:?}", completed.result);
        let bytes = read(&directory);
        assert_eq!(
            bytes["extension"]["pending"]["input"]["fields"]["enabled"],
            false
        );
        let mut reopened = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Auto, Locale::En),
        );
        serde_json::from_value::<Snapshot>(bytes)
            .unwrap()
            .restore(&mut reopened, false)
            .unwrap();
        assert!(reopened.extensions_request().is_none());
        assert!(app.extensions_after_checkpoint(&request, &completed.result));
        assert!(!app.extensions_after_checkpoint(&request, &completed.result));
        app.extensions_complete(request, Err(extensions::io::Failure { unknown: true }));
        // No idempotency declaration means no unsafe retry, including after a failed query.
        assert!(!app.extensions_enabled(&Command::Retry));
        assert!(!app.extensions_enabled(&Command::Reconcile));
        app.extensions_action(Command::Discard);
        assert!(app.extensions_request().is_none());
        app.extensions_action(Command::ConfirmDiscard);
        assert!(app.extensions_request().is_some());

        for closing in [false, true] {
            let mut app = extensions::tests::app();
            app.connection = ConnectionState::Connected {
                root_id: ROOT.into(),
                epoch: "epoch".into(),
            };
            app.extensions_action(extensions::tests::save());
            let request = app.extensions_request().unwrap();
            app.closing = closing;
            assert!(!app.extensions_after_checkpoint(&request, &Err("disk failure".into())));
            assert!(app.extensions.checkpoint(ROOT).is_some());
            assert!(app.extensions_request().is_none());
        }
        let mut app = extensions::tests::app();
        app.extensions_action(extensions::tests::save());
        let request = app.extensions_request().unwrap();
        state.submit_extension(request);
        let (release, blocked) = gate(&state).await;
        state.start(&app);
        state.cancel_requests();
        app.extensions.disconnect();
        release.send(()).unwrap();
        blocked.await.unwrap();
        assert!(written(&mut state).await.extension.is_none());
    }

    #[tokio::test]
    async fn revision_writer_persists_frozen_identity_and_cancels_obsolete_save_authority() {
        use crate::pages::revision::{Checkpoint, Command};
        use serde_json::json;
        let (directory, mut state, mut app) = fixture();
        let saved: Checkpoint=serde_json::from_value(json!({
            "root":ROOT,"origin_epoch":"epoch",
            "copy":{"sourceSessionId":"a","targetSessionId":"revised","expectedSourceRevision":1,
                "purpose":{"kind":"revision","turnId":"old-turn"}},
            "turn_id":"new-turn","inputs":[
                {"original":{"messageId":"one","content":{"text":"original"}},"content":{"text":"edited"},"excluded":[],"files":[],"directories":[],"skills":[]}
            ],"stage":"draft","batch":null,"mapped":null,"view":{"selected":0,"display":false,"positions":[{"input":0,"display":false,"cursor":{"cursor":0,"anchor":null,"upstream":false}}]}
        })).unwrap();
        saved.validate(ROOT).unwrap();
        app.revision.restore(saved);
        app.apply(Action::Revision(Command::Resume));
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 24)).unwrap();
        terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        app.apply(Action::Revision(Command::Send));
        let request = app.revision_request().unwrap();
        let (release, blocked) = gate(&state).await;
        state.submit_revision(request.clone());
        state.start(&app);
        assert!(
            tokio::time::timeout(Duration::from_millis(30), state.completed())
                .await
                .is_err()
        );
        release.send(()).unwrap();
        blocked.await.unwrap();
        let written = written(&mut state).await;
        assert_eq!(written.revision, Some(request.clone()));
        assert!(written.result.is_ok());
        let bytes = read(&directory);
        assert_eq!(bytes["version"], 15);
        assert_eq!(bytes["revision"]["copy"]["targetSessionId"], "revised");
        assert_eq!(bytes["revision"]["inputs"][0]["content"]["text"], "edited");
        let mut incomplete = bytes.clone();
        incomplete["revision"]
            .as_object_mut()
            .unwrap()
            .remove("view");
        assert!(serde_json::from_value::<Snapshot>(incomplete).is_err());
        let mut reopened = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Auto, Locale::En),
        );
        serde_json::from_value::<Snapshot>(bytes)
            .unwrap()
            .restore(&mut reopened, false)
            .unwrap();
        assert!(!reopened.revision.visible);
        assert!(reopened.revision_request().is_none());
        assert!(app.revision_after_checkpoint(&request, &written.result));
        assert!(!app.revision_after_checkpoint(&request, &written.result));
        state.submit_revision(request);
        let (release, blocked) = gate(&state).await;
        state.start(&app);
        state.cancel_requests();
        app.revision.disconnect();
        release.send(()).unwrap();
        blocked.await.unwrap();
        assert!(self::written(&mut state).await.revision.is_none());
    }

    #[tokio::test]
    async fn branch_dispatch_waits_for_its_own_snapshot_and_reopen_only_recovers_identity() {
        use crate::pages::branch::Command;
        let (directory, mut state, mut app) = fixture();
        app.chat.select(&app.navigation.current());
        app.sessions.detail = crate::pages::sessions::Detail::Ready(Box::new(
            crate::pages::sessions::tests::item("a"),
        ));
        app.chat.view.sync(&std::collections::BTreeMap::from([(1,serde_json::json!({"type":"user","id":"message","turnId":"turn","text":"Branch point"}))]),&[],0,&app.i18n,false);
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 24)).unwrap();
        terminal
            .draw(|f| {
                app.chat.view.draw(f, f.area(), false).unwrap();
            })
            .unwrap();
        app.chat.view.enter();
        let open = app.branch_commands()[0].0.clone();
        app.apply(open);
        terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        app.apply(Action::Branch(Command::Confirm));
        let request = app.branch_request().unwrap();
        let (release, blocked) = gate(&state).await;
        state.submit_branch(request.clone());
        state.start(&app);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), state.completed())
                .await
                .is_err()
        );
        app.apply(Action::Branch(Command::Close));
        app.apply(Action::Visit(Route::Settings));
        state.changed();
        release.send(()).unwrap();
        blocked.await.unwrap();
        let written = written(&mut state).await;
        assert_eq!(written.branch, Some(request.clone()));
        assert!(written.result.is_ok());
        let bytes = read(&directory);
        assert_eq!(
            bytes["branch"],
            serde_json::to_value(app.branch.checkpoint()).unwrap()
        );
        assert!(app.branch_after_checkpoint(&request, &written.result));
        assert!(!app.branch_after_checkpoint(&request, &written.result));
        let mut reopened = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Auto, Locale::En),
        );
        serde_json::from_value::<Snapshot>(bytes.clone())
            .unwrap()
            .restore(&mut reopened, false)
            .unwrap();
        assert!(!reopened.branch.visible);
        assert!(reopened.branch_request().is_none());
        assert_eq!(
            serde_json::to_value(reopened.branch.checkpoint()).unwrap(),
            bytes["branch"]
        );
        let mut foreign = bytes;
        foreign["branch"]["root"] = serde_json::json!("foreign");
        assert!(
            serde_json::from_value::<Snapshot>(foreign)
                .unwrap()
                .validate(ROOT)
                .is_err()
        );
        state.submit_branch(request);
        state.force();
        state.start(&app);
        state.cancel_requests();
        app.branch.disconnect();
        assert!(
            self::written(&mut state).await.branch.is_none(),
            "cancelled IO completion cannot release a write"
        );
    }

    #[tokio::test]
    async fn slow_writer_keeps_input_live_coalesces_edits_and_never_overwrites_newer_state() {
        let (directory, mut state, mut app) = fixture();
        app.input(Event::Paste("original 中文🦀".into()));
        let request = app.submission().unwrap();
        let (release, blocked) = gate(&state).await;
        state.submit(request.clone());
        state.start(&app);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), state.completed())
                .await
                .is_err()
        );
        for _ in 0..100 {
            assert!(app.input(Event::Paste("x".into())).0);
            state.changed();
            state.start(&app);
        }
        assert!(state.requests.is_empty());
        app.apply(Action::Visit(Route::Session("b".into())));
        app.input(Event::Paste("second session".into()));
        let second = app.submission().unwrap();
        state.submit(second.clone());
        state.start(&app);
        assert_eq!(
            state.requests.len(),
            1,
            "a later send waits for the next checkpoint"
        );
        assert!(
            state.wait().is_none(),
            "no busy timer while an IO worker is blocked"
        );
        assert!(!state.idle());
        app.apply(Action::Visit(Route::Settings));
        state.changed();
        let mut screen =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 24)).unwrap();
        screen
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        assert_eq!(app.navigation.current(), Route::Settings);
        release.send(()).unwrap();
        blocked.await.unwrap();
        let first = written(&mut state).await;
        assert!(first.result.is_ok());
        assert_eq!(first.requests, vec![request.clone()]);
        assert!(app.after_checkpoint(&request, &first.result));
        assert_eq!(read(&directory)["drafts"]["a"]["text"], "original 中文🦀");
        state.force();
        state.start(&app);
        let latest = written(&mut state).await;
        assert!(latest.result.is_ok());
        assert_eq!(latest.requests, vec![second.clone()]);
        assert!(app.after_checkpoint(&second, &latest.result));
        assert_eq!(
            read(&directory)["drafts"]["a"]["text"],
            app.drafts["a"].text()
        );
        assert!(state.idle());

        // Closing is a cancellable input scope, not a blocking disk wait.
        app.closing = true;
        assert!(!app.input(Event::Paste("must not edit".into())).0);
        assert!(app.input(Event::Resize(100, 30)).0);
        app.input(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        assert!(!app.closing);
    }

    #[tokio::test]
    async fn cancelled_attempt_ack_cannot_release_a_new_retry_and_failed_checkpoint_never_dispatches()
     {
        let (directory, mut state, mut app) = fixture();
        app.input(Event::Paste("original".into()));
        let request = app.submission().unwrap();
        let (release, blocked) = gate(&state).await;
        state.submit(request.clone());
        state.start(&app);
        // Same Root and epoch after reconnect: the exact same submission may be retried.
        state.cancel_requests();
        app.abandon_pending_submissions();
        state.submit(app.retry_submission().unwrap());
        release.send(()).unwrap();
        blocked.await.unwrap();
        assert!(
            written(&mut state).await.requests.is_empty(),
            "old acknowledgement cannot dispatch the new attempt"
        );
        state.start(&app);
        let retried = written(&mut state).await;
        assert_eq!(retried.requests, vec![request.clone()]);
        assert!(app.after_checkpoint(&request, &retried.result));

        // A directory in place of the target makes atomic replacement fail on all platforms.
        let path = directory.path().join(ROOT).join("default/state.json");
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        state.submit(request.clone());
        state.start(&app);
        let failed = written(&mut state).await;
        assert!(failed.result.is_err());
        assert!(!app.after_checkpoint(&request, &failed.result));
        assert!(matches!(
            app.sending["a"].delivery,
            crate::pages::sending::Delivery::Unknown(Some(_))
        ));
        assert_eq!(app.drafts["a"].text(), "original");
        assert!(path.is_dir());
        assert!(state.idle(), "failed writes do not retry in a hot loop");
        app.retry_submission().unwrap();
        app.connection = ConnectionState::Connected {
            root_id: ROOT.into(),
            epoch: "next-epoch".into(),
        };
        assert!(
            !app.after_checkpoint(&request, &Ok(())),
            "a successful disk write cannot rebind the Host epoch"
        );
        std::fs::remove_dir(&path).unwrap();
        state.finish(&app).await.unwrap();
        assert_eq!(read(&directory)["unresolved"][0]["id"], request.id);
        assert!(state.idle());
    }

    #[tokio::test]
    async fn recap_dispatch_waits_for_saved_identity_and_restore_never_replays_it() {
        use crate::pages::recap::Command;
        let (directory, mut state, mut app) = fixture();
        app.apply(Action::Visit(Route::Session("recap-session".into())));
        let action = app.recap_commands()[0].0.clone();
        app.apply(action);
        let query = app.recap_request().unwrap();
        app.recap_completed(query, Ok(None));
        ratatui::Terminal::new(ratatui::backend::TestBackend::new(100, 35))
            .unwrap()
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        app.apply(Action::Recap(Command::Generate));
        let request = app.recap_request().unwrap();
        let checkpoint = app.recap.checkpoint().unwrap();
        state.submit_recap(request.clone());
        state.start(&app);
        let written = state.completed().await;
        assert!(written.result.is_ok());
        assert_eq!(written.recap, Some(request.clone()));
        let saved: Snapshot = serde_json::from_value(read(&directory)).unwrap();
        let mut reopened = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Auto, Locale::En),
        );
        saved.restore(&mut reopened, false).unwrap();
        assert_eq!(reopened.recap.checkpoint(), Some(checkpoint));
        assert!(reopened.recap_request().is_none());
        assert!(app.recap_after_checkpoint(&request, &written.result));
    }

    #[tokio::test]
    async fn resume_dispatch_waits_for_saved_turn_identity_and_restore_requires_explicit_retry() {
        use crate::pages::resume::{Command, Output};
        use maka_protocol::turn::TurnResumePlan;
        let (directory, mut state, mut app) = fixture();
        app.apply(app.resume_commands()[0].0.clone());
        let query = app.resume_request().unwrap();
        app.resume_completed(
            query,
            Ok(Output::Plan(TurnResumePlan::Ready {
                session_id: "a".into(),
                source_run_id: "run".into(),
                source_turn_id: "turn".into(),
                source_runtime_event_high_water: 1,
            })),
        );
        ratatui::Terminal::new(ratatui::backend::TestBackend::new(100, 35))
            .unwrap()
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        app.apply(Action::Resume(Command::Start));
        let request = app.resume_request().unwrap();
        let checkpoint = app.resume.checkpoint().unwrap();
        state.submit_resume(request.clone());
        state.start(&app);
        let written = state.completed().await;
        assert!(written.result.is_ok());
        assert_eq!(written.resume, Some(request.clone()));
        let saved: Snapshot = serde_json::from_value(read(&directory)).unwrap();
        let mut reopened = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Auto, Locale::En),
        );
        saved.restore(&mut reopened, false).unwrap();
        assert_eq!(
            serde_json::to_value(reopened.resume.checkpoint()).unwrap(),
            serde_json::to_value(Some(checkpoint)).unwrap()
        );
        assert!(reopened.resume_request().is_none());
        assert!(app.resume_after_checkpoint(&request, &written.result));
    }
}
