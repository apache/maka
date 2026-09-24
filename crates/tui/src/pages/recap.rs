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

mod view;
use crate::{
    app::{Action, App, ConnectionState},
    navigation::Route,
};
use maka_client::{Client, ClientError, RequestFailure};
use maka_protocol::plugin::{RemoteBinding, RemoteKind, RemoteRequest, RemoteResult};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
pub(crate) use view::sheet;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    root: String,
    epoch: String,
    session: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Open(Target),
    Resume,
    Read,
    Generate,
    Retry,
    Forget,
    ConfirmForget,
    /// Keeps the retry after asking to forget it.
    Keep,
    Close,
}
impl Command {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Open(_) => "recap-title",
            Self::Resume => "recap-resume",
            Self::Read => "recap-read",
            Self::Generate => "recap-generate",
            Self::Retry => "recap-retry",
            Self::Forget => "recap-forget",
            Self::ConfirmForget => "recap-confirm-forget",
            Self::Keep => "session-cancel",
            Self::Close => "session-remove-close",
        }
    }
}
/// Only unresolved operation identity is saved. Summary text remains with the plugin.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    root: String,
    session: String,
    operation: Uuid,
}
impl Checkpoint {
    pub fn validate(&self, root: &str) -> Result<(), String> {
        if self.root != root
            || self.session.is_empty()
            || self.session.len() > 256
            || self.session.chars().any(char::is_control)
        {
            return Err("Invalid recap checkpoint destination".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    target: Target,
    operation: Option<Uuid>,
    sequence: u64,
}
impl Request {
    pub fn needs_checkpoint(&self) -> bool {
        self.operation.is_some()
    }
}
#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Receipt {
    Pending {
        operation_id: Uuid,
    },
    Ready {
        operation_id: Uuid,
        text: String,
        model_id: String,
    },
    Failed {
        operation_id: Uuid,
        reason: String,
    },
}
impl Receipt {
    fn operation(&self) -> Uuid {
        match self {
            Self::Pending { operation_id }
            | Self::Ready { operation_id, .. }
            | Self::Failed { operation_id, .. } => *operation_id,
        }
    }
}
#[derive(Default)]
pub struct State {
    pub visible: bool,
    rendered: bool,
    discarding: bool,
    target: Option<Target>,
    saved: Option<Checkpoint>,
    pending: Option<Request>,
    requested: Option<Option<Uuid>>,
    sequence: u64,
    saving: bool,
    loaded: bool,
    receipt: Option<Receipt>,
    error: Option<String>,
}
impl State {
    pub fn checkpoint(&self) -> Option<Checkpoint> {
        self.saved.clone()
    }
    pub fn restore(&mut self, saved: Checkpoint) {
        self.saved = Some(saved);
    }
    pub fn invalidate_geometry(&mut self) {
        self.rendered = false;
    }
    /// The sheet reports whether it is on screen; its commands need it.
    pub(crate) fn presented(&mut self, shown: bool) {
        self.rendered = shown;
    }
    pub fn disconnect(&mut self) {
        self.pending = None;
        self.requested = None;
        self.saving = false;
        self.loaded = false;
        self.receipt = None;
        self.error = None;
    }
}
fn invalid(message: impl Into<String>) -> RequestFailure {
    RequestFailure::Unknown(ClientError::Protocol(message.into()))
}
pub async fn execute(
    client: &Client,
    request: &Request,
) -> Result<Option<Receipt>, RequestFailure> {
    let RemoteResult::Document { document } =
        client.plugin_remote(RemoteRequest::OpenDocument).await?
    else {
        return Err(invalid("Expected Remote document"));
    };
    let result = async {
        let binding = RemoteBinding::Package {
            package_id: "maka.session-recap".into(),
            method: "manage".into(),
            session_id: Some(request.target.session.clone()),
        };
        let RemoteResult::Bound {
            target,
            handler: RemoteKind::Method,
        } = client
            .plugin_remote(RemoteRequest::Bind {
                binding: binding.clone(),
            })
            .await?
        else {
            return Err(invalid("Expected recap method"));
        };
        let input = match request.operation {
            Some(id) => serde_json::json!({"kind":"generate","operationId":id}),
            None => serde_json::json!({"kind":"read"}),
        };
        let RemoteResult::Value { value } = client
            .plugin_remote(RemoteRequest::Call {
                binding,
                target,
                document,
                input,
            })
            .await?
        else {
            return Err(invalid("Expected recap response"));
        };
        #[derive(Deserialize)]
        struct Response {
            recap: Option<Receipt>,
        }
        let response: Response =
            serde_json::from_value(value).map_err(|e| invalid(e.to_string()))?;
        if request
            .operation
            .is_some_and(|id| response.recap.as_ref().is_none_or(|r| r.operation() != id))
        {
            return Err(invalid("Recap response changed operation identity"));
        }
        Ok(response.recap)
    }
    .await;
    // A request owns its Remote document even when binding or calling fails.
    let closed = client
        .plugin_remote(RemoteRequest::CloseDocument { document })
        .await;
    match result {
        Err(e) => Err(e),
        Ok(value) => {
            closed?;
            Ok(value)
        }
    }
}
impl App {
    fn recap_target(&self) -> Option<Target> {
        let ConnectionState::Connected { root_id, epoch } = &self.connection else {
            return None;
        };
        let Route::Session(session) = self.navigation.current() else {
            return None;
        };
        if self.chat.removed {
            return None;
        }
        Some(Target {
            root: root_id.clone(),
            epoch: epoch.clone(),
            session,
        })
    }
    pub fn recap_commands(&self) -> Vec<(Action, &'static str)> {
        if self.recap.saved.is_some() {
            return vec![(Action::Recap(Command::Resume), "recap-resume")];
        }
        self.recap_target()
            .map(|t| vec![(Action::Recap(Command::Open(t)), "recap-title")])
            .unwrap_or_default()
    }
    pub fn recap_enabled(&self, command: &Command) -> bool {
        let idle = self.recap.pending.is_none() && self.recap.requested.is_none();
        self.recap_offered(command)
            && (idle
                || matches!(
                    command,
                    Command::Open(_) | Command::Resume | Command::Close | Command::Keep
                ))
    }
    /// Whether the dialog offers `command`, before a request in flight is
    /// considered: its button (and the focus on it) stays while the Host is
    /// asked, and pressing it then does nothing.
    fn recap_offered(&self, command: &Command) -> bool {
        let state = &self.recap;
        let connected = matches!((&self.connection,&state.target),
            (ConnectionState::Connected {root_id,epoch},Some(target)) if *root_id==target.root && *epoch==target.epoch);
        match command {
            Command::Open(target)=> !state.visible && state.saved.is_none() && state.pending.is_none() && self.recap_target().as_ref()==Some(target),
            Command::Resume=> !state.visible && state.saved.as_ref().is_some_and(|saved| matches!(&self.connection,ConnectionState::Connected{root_id,..} if *root_id==saved.root)),
            Command::Close=>state.visible,
            Command::Keep=>state.visible && state.discarding,
            _=> state.visible && state.rendered && connected && match command {
                Command::Read=>true,
                Command::Generate=>state.loaded && state.saved.is_none(),
                Command::Retry=>state.saved.is_some(),
                Command::Forget=>state.saved.is_some() && !state.discarding,
                Command::ConfirmForget=>state.saved.is_some() && state.discarding,
                _=>false,
            },
        }
    }
    pub fn recap_action(&mut self, command: Command) -> Option<Action> {
        if !self.recap_enabled(&command) {
            return None;
        }
        let state = &mut self.recap;
        if !matches!(command, Command::Forget | Command::ConfirmForget) {
            state.discarding = false;
        }
        match command {
            Command::Forget => {
                state.discarding = true;
            }
            Command::Keep => {}
            Command::ConfirmForget => {
                state.saved = None;
                state.visible = false;
                state.discarding = false;
                state.loaded = false;
            }
            Command::Open(target) => {
                state.target = Some(target);
                state.visible = true;
                state.loaded = false;
                state.receipt = None;
                state.error = None;
                state.requested = Some(None);
                state.rendered = false;
            }
            Command::Resume => {
                let saved = state.saved.as_ref()?;
                let ConnectionState::Connected { epoch, .. } = &self.connection else {
                    return None;
                };
                state.target = Some(Target {
                    root: saved.root.clone(),
                    epoch: epoch.clone(),
                    session: saved.session.clone(),
                });
                state.visible = true;
                state.rendered = false;
                state.requested = Some(None);
            }
            Command::Close => {
                state.visible = false;
                state.rendered = false;
            }
            Command::Read => state.requested = Some(None),
            Command::Generate => {
                let target = state.target.as_ref()?;
                let operation = Uuid::new_v4();
                state.saved = Some(Checkpoint {
                    root: target.root.clone(),
                    session: target.session.clone(),
                    operation,
                });
                state.requested = Some(Some(operation));
            }
            Command::Retry => state.requested = Some(Some(state.saved.as_ref()?.operation)),
        }
        None
    }
    pub fn recap_request(&mut self) -> Option<Request> {
        let state = &mut self.recap;
        if self.closing || state.pending.is_some() {
            return None;
        }
        let target = state.target.as_ref()?;
        if !matches!(&self.connection,ConnectionState::Connected{root_id,epoch} if *root_id==target.root && *epoch==target.epoch)
        {
            return None;
        }
        let operation = state.requested.take()?;
        state.sequence += 1;
        let request = Request {
            target: target.clone(),
            operation,
            sequence: state.sequence,
        };
        state.pending = Some(request.clone());
        state.saving = request.needs_checkpoint();
        state.error = None;
        Some(request)
    }
    pub fn recap_after_checkpoint(
        &mut self,
        request: &Request,
        result: &Result<(), String>,
    ) -> bool {
        let state = &mut self.recap;
        if !state.saving || state.pending.as_ref() != Some(request) {
            return false;
        }
        state.saving = false;
        if result.is_ok()
            && !self.closing
            && matches!(&self.connection,ConnectionState::Connected{root_id,epoch} if *root_id==request.target.root && *epoch==request.target.epoch)
        {
            return true;
        }
        state.pending = None;
        // Keep the identity: an earlier retry may already have reached Host.
        state.error = Some(self.i18n.text("recap-save-failed"));
        false
    }
    pub fn recap_completed(
        &mut self,
        request: Request,
        result: Result<Option<Receipt>, RequestFailure>,
    ) {
        let state = &mut self.recap;
        if state.pending.as_ref() != Some(&request) {
            return;
        }
        state.pending = None;
        if !matches!(&self.connection,ConnectionState::Connected{root_id,epoch} if *root_id==request.target.root && *epoch==request.target.epoch)
        {
            state.loaded = false;
            return;
        }
        match result {
            Ok(receipt) => {
                if let Some(receipt) = &receipt
                    && state
                        .saved
                        .as_ref()
                        .is_some_and(|saved| saved.operation == receipt.operation())
                {
                    state.saved = None;
                }
                state.loaded = true;
                state.receipt = receipt;
                state.error = None;
            }
            Err(error) => {
                state.error = Some(error.to_string());
                state.loaded = false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{I18n, Locale, LocalePreference};
    use ratatui::{Terminal, backend::TestBackend};
    fn app() -> App {
        let mut app = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Session("source".into())));
        app
    }
    fn draw(app: &mut App, width: u16, height: u16) {
        Terminal::new(TestBackend::new(width, height))
            .unwrap()
            .draw(|f| crate::view::draw(f, app))
            .unwrap();
    }
    fn loaded(app: &mut App) {
        let action = app.recap_commands()[0].0.clone();
        app.apply(action);
        let read = app.recap_request().unwrap();
        app.recap_completed(read, Ok(None));
        draw(app, 100, 35);
    }
    #[test]
    fn unknown_result_retries_original_after_reconnect_and_rejects_late_reply() {
        let mut app = app();
        loaded(&mut app);
        app.apply(Action::Recap(Command::Generate));
        let first = app.recap_request().unwrap();
        assert!(first.needs_checkpoint());
        assert!(app.recap_after_checkpoint(&first, &Ok(())));
        assert!(
            !app.recap_after_checkpoint(&first, &Ok(())),
            "dispatch once per checkpoint"
        );
        app.recap.disconnect();
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "new".into(),
        };
        app.recap_completed(
            first.clone(),
            Ok(Some(Receipt::Ready {
                operation_id: first.operation.unwrap(),
                text: "late".into(),
                model_id: "model".into(),
            })),
        );
        assert!(app.recap.receipt.is_none());
        app.apply(Action::Recap(Command::Close));
        app.apply(Action::Recap(Command::Resume));
        let read = app.recap_request().unwrap();
        app.recap_completed(read, Ok(None));
        draw(&mut app, 100, 35);
        assert!(!app.recap_enabled(&Command::Generate));
        app.apply(Action::Recap(Command::Retry));
        let retry = app.recap_request().unwrap();
        assert_eq!(retry.operation, first.operation);
        assert_ne!(retry.target.epoch, first.target.epoch);
        assert!(app.recap_after_checkpoint(&retry, &Ok(())));
        app.recap_completed(
            retry.clone(),
            Ok(Some(Receipt::Pending {
                operation_id: retry.operation.unwrap(),
            })),
        );
        assert!(
            app.recap.checkpoint().is_none(),
            "Host receipt confirms admission even if its outcome is unknown"
        );
        assert!(
            app.recap_request().is_none(),
            "receipt never starts another generation"
        );
    }
    #[test]
    fn resize_and_failed_checkpoint_cannot_dispatch_and_foreign_checkpoint_is_rejected() {
        let mut app = app();
        loaded(&mut app);
        draw(&mut app, 30, 8);
        assert!(!app.recap_enabled(&Command::Generate));
        app.apply(Action::Recap(Command::Generate));
        assert!(app.recap_request().is_none());
        draw(&mut app, 100, 35);
        app.apply(Action::Recap(Command::Generate));
        let request = app.recap_request().unwrap();
        assert!(!app.recap_after_checkpoint(&request, &Err("disk full".into())));
        let saved = app.recap.checkpoint().unwrap();
        assert!(saved.validate("other").is_err());
        let mut reopened = State::default();
        reopened.restore(saved.clone());
        assert!(!reopened.visible);
        assert!(reopened.requested.is_none());
        assert_eq!(reopened.checkpoint(), Some(saved));
        assert!(!app.recap_enabled(&Command::Generate));
    }
    #[test]
    fn different_latest_receipt_does_not_erase_original_unknown_request() {
        let mut app = app();
        loaded(&mut app);
        app.apply(Action::Recap(Command::Generate));
        let original = app.recap_request().unwrap();
        assert!(app.recap_after_checkpoint(&original, &Ok(())));
        app.recap_completed(original.clone(), Err(invalid("lost reply")));
        draw(&mut app, 100, 35);
        app.apply(Action::Recap(Command::Read));
        let read = app.recap_request().unwrap();
        app.recap_completed(
            read,
            Ok(Some(Receipt::Ready {
                operation_id: Uuid::new_v4(),
                text: "newer from another client".into(),
                model_id: "model".into(),
            })),
        );
        assert_eq!(
            app.recap.checkpoint().unwrap().operation,
            original.operation.unwrap()
        );
        assert!(!app.recap_enabled(&Command::Generate));
    }

    #[test]
    fn abandoning_an_unavailable_retry_requires_explicit_confirmation_and_never_dispatches() {
        let mut app = app();
        loaded(&mut app);
        app.apply(Action::Recap(Command::Generate));
        let request = app.recap_request().unwrap();
        assert!(app.recap_after_checkpoint(&request, &Ok(())));
        app.recap_completed(request, Err(invalid("Session unavailable")));
        draw(&mut app, 100, 35);
        assert!(!app.recap_enabled(&Command::ConfirmForget));
        app.apply(Action::Recap(Command::Forget));
        assert!(app.recap.checkpoint().is_some());
        app.apply(Action::Recap(Command::ConfirmForget));
        assert!(app.recap.checkpoint().is_none());
        assert!(app.recap_request().is_none());
        assert!(!app.recap.visible);
    }
}
