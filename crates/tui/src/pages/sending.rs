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

use crate::app::App;

use maka_client::{ClientError, RequestFailure};
use maka_protocol::{
    OperationErrorCode,
    message::{ExecutionResolution, Placement, SubmitInput, SubmitResult},
    turn::{MessageContent, TurnOrchestration},
};

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Submission {
    pub root_id: String,
    pub origin_epoch: String,
    pub session: String,
    pub id: String,
    pub content: MessageContent,
    pub placement: Placement,
    pub input_selections: std::collections::BTreeMap<String, Vec<String>>,
    pub turn_orchestration: Option<TurnOrchestration>,
}
pub enum Delivery {
    Pending,
    Retrying,
    Accepted,
    Failed(String),
    Unknown(Option<String>),
    Checking,
    Cancelled,
    NotAdmitted,
}
impl Delivery {
    pub fn unresolved(&self) -> bool {
        matches!(self, Self::Unknown(_) | Self::Checking | Self::Retrying)
    }
    pub fn blocks_send(&self) -> bool {
        matches!(self, Self::Pending) || self.unresolved()
    }
}
pub struct Sending {
    pub request: Submission,
    pub delivery: Delivery,
}
impl Submission {
    pub fn input(&self) -> SubmitInput {
        SubmitInput {
            origin_host_epoch: self.origin_epoch.clone(),
            session_id: self.session.clone(),
            message_id: self.id.clone(),
            content: self.content.clone(),
            placement: self.placement,
            input_selections: self.input_selections.clone(),
            turn_orchestration: self.turn_orchestration.clone(),
        }
    }
}
impl App {
    pub fn abandon_checkpoint(&mut self, request: &Submission) {
        if let Some(sent) = self.sending.get_mut(&request.session)
            && sent.request == *request
            && matches!(sent.delivery, Delivery::Pending | Delivery::Retrying)
        {
            sent.delivery = Delivery::Unknown(None);
        }
    }
    /// A disk acknowledgement never grants permission to dispatch an obsolete attempt.
    pub fn after_checkpoint(&mut self, request: &Submission, result: &Result<(), String>) -> bool {
        let Some(sent) = self.sending.get_mut(&request.session) else {
            return false;
        };
        if sent.request != *request
            || !matches!(sent.delivery, Delivery::Pending | Delivery::Retrying)
        {
            return false;
        }
        if result.is_ok()
            && matches!(&self.connection,
            crate::app::ConnectionState::Connected {root_id, epoch}
                if root_id == &request.root_id && epoch == &request.origin_epoch)
        {
            return true;
        }
        sent.delivery = Delivery::Unknown(result.as_ref().err().cloned());
        false
    }
    pub fn abandon_pending_submissions(&mut self) {
        for sent in self.sending.values_mut() {
            if matches!(
                sent.delivery,
                Delivery::Pending | Delivery::Checking | Delivery::Retrying
            ) {
                sent.delivery = Delivery::Unknown(None);
            }
        }
    }
    pub fn submission(&mut self) -> Option<Submission> {
        self.submission_for(Placement::NextTurn)
    }
    pub fn submission_for(&mut self, placement: Placement) -> Option<Submission> {
        let crate::app::ConnectionState::Connected { root_id, epoch } = &self.connection else {
            return None;
        };
        let crate::navigation::Route::Session(session) = self.navigation.current() else {
            return None;
        };
        if self
            .sending
            .get(&session)
            .is_some_and(|sent| sent.delivery.blocks_send())
        {
            return None;
        }
        let text = self.drafts.get(&session)?.text().to_owned();
        if !self.attachments.ready(&session)
            || (text.trim().is_empty()
                && !self.attachments.has(&session)
                && !self.has_directories(&session)
                && !self.has_skills(&session))
        {
            return None;
        }
        let input_selections = crate::pages::skills::selections(
            self.skills
                .saved
                .get(&session)
                .map(Vec::as_slice)
                .unwrap_or_default(),
        );
        if !input_selections.is_empty() && self.stop_target().is_some() {
            return None;
        }
        let placement = if input_selections.is_empty() {
            placement
        } else {
            Placement::CurrentTurn
        };
        let request = Submission {
            root_id: root_id.clone(),
            origin_epoch: epoch.clone(),
            session: session.clone(),
            id: uuid::Uuid::new_v4().to_string(),
            content: MessageContent {
                text,
                display_text: None,
                attachments: self.attachments.references(&session),
                directory_references: self
                    .directories
                    .get(&session)
                    .filter(|v| !v.is_empty())
                    .cloned(),
                quotes: None,
                inline_references: None,
            },
            placement,
            input_selections,
            turn_orchestration: None,
        };
        self.sending.insert(
            session,
            Sending {
                request: request.clone(),
                delivery: Delivery::Pending,
            },
        );
        // Sending is an explicit request to continue here, unlike passive
        // background output. Do this now, not on a delayed acknowledgement
        // that could interrupt a newer reading/navigation action.
        self.chat.view.search = None;
        self.chat.view.text_selection.clear();
        self.chat.latest();
        self.chrome.details = false;
        self.focus = crate::app::Focus::Composer;
        Some(request)
    }
    pub fn submitted(&mut self, request: Submission, result: Result<SubmitResult, RequestFailure>) {
        let Some(sent) = self.sending.get_mut(&request.session) else {
            return;
        };
        if sent.request != request {
            return;
        }
        let retrying = matches!(sent.delivery, Delivery::Retrying);
        sent.delivery = match result {
            // A rejected replay does not disprove the first attempt. Never
            // unlock a fresh message ID on the strength of that later failure.
            Ok(SubmitResult::Blocked { message, .. }) if retrying => {
                Delivery::Unknown(Some(message))
            }
            Err(error) if retrying => Delivery::Unknown(Some(error.to_string())),
            Ok(SubmitResult::Blocked { message, .. }) => Delivery::Failed(message),
            Ok(_) => {
                if let Some(editor) = self.drafts.get_mut(&request.session) {
                    editor.clear_if_unchanged(&request.content.text);
                }
                self.attachments
                    .clear_sent(&request.session, &request.content.attachments);
                if self.directories.get(&request.session)
                    == request.content.directory_references.as_ref()
                {
                    self.directories.remove(&request.session);
                }
                if self
                    .skills
                    .saved
                    .get(&request.session)
                    .is_some_and(|items| {
                        crate::pages::skills::selections(items) == request.input_selections
                    })
                {
                    self.skills.saved.remove(&request.session);
                }
                Delivery::Accepted
            }
            Err(error @ RequestFailure::Unknown(_)) => Delivery::Unknown(Some(error.to_string())),
            Err(RequestFailure::Rejected(ClientError::Rejected(error)))
                if error.code == OperationErrorCode::OutcomeUnknown =>
            {
                Delivery::Unknown(Some(error.to_string()))
            }
            Err(error) => Delivery::Failed(error.to_string()),
        };
    }

    pub fn retry_submission(&mut self) -> Option<Submission> {
        if !self.enabled(&crate::app::Action::RetrySubmission) {
            return None;
        }
        let crate::navigation::Route::Session(id) = self.navigation.current() else {
            return None;
        };
        let sent = self.sending.get_mut(&id)?;
        sent.delivery = Delivery::Retrying;
        Some(sent.request.clone())
    }

    pub fn reconciliation(&mut self) -> Option<Submission> {
        if !self.enabled(&crate::app::Action::ReconcileSubmission) {
            return None;
        }
        let crate::navigation::Route::Session(id) = self.navigation.current() else {
            return None;
        };
        let sent = self.sending.get_mut(&id)?;
        sent.delivery = Delivery::Checking;
        Some(sent.request.clone())
    }

    pub fn reconciled(
        &mut self,
        request: Submission,
        result: Result<Option<ExecutionResolution>, RequestFailure>,
    ) {
        let Some(sent) = self.sending.get_mut(&request.session) else {
            return;
        };
        if sent.request != request || !matches!(sent.delivery, Delivery::Checking) {
            return;
        }
        sent.delivery = match result {
            Ok(Some(ExecutionResolution::Pending { .. } | ExecutionResolution::Owned { .. })) => {
                if let Some(editor) = self.drafts.get_mut(&request.session) {
                    editor.clear_if_unchanged(&request.content.text);
                }
                self.attachments
                    .clear_sent(&request.session, &request.content.attachments);
                if self.directories.get(&request.session)
                    == request.content.directory_references.as_ref()
                {
                    self.directories.remove(&request.session);
                }
                if self
                    .skills
                    .saved
                    .get(&request.session)
                    .is_some_and(|items| {
                        crate::pages::skills::selections(items) == request.input_selections
                    })
                {
                    self.skills.saved.remove(&request.session);
                }
                Delivery::Accepted
            }
            // A cancelled admission cannot subsequently execute. Keep the draft for explicit send.
            Ok(Some(ExecutionResolution::Cancelled { .. })) => Delivery::Cancelled,
            Ok(Some(ExecutionResolution::NotAdmitted { .. })) => Delivery::NotAdmitted,
            Ok(None) => Delivery::Unknown(None),
            Err(error) => Delivery::Unknown(Some(error.to_string())),
        };
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
    #[test]
    fn explicit_send_follows_tail_but_late_ack_does_not_interrupt_new_reading() {
        use ratatui::{Terminal, backend::TestBackend};
        use serde_json::json;
        let mut app = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Session("a".into())));
        app.chat.select(&Route::Session("a".into()));
        let rows = (1..30).map(|i| (i, json!({"id":format!("m{i}"),"turnId":"old","type":"user","text":format!("Old message {i}")}))).collect();
        app.chat.view.sync(&rows, &[], 0, &app.i18n, false);
        let mut terminal = Terminal::new(TestBackend::new(60, 10)).unwrap();
        terminal
            .draw(|f| {
                app.chat.view.draw(f, f.area(), false).unwrap();
            })
            .unwrap();
        for placement in [Placement::NextTurn, Placement::CurrentTurn] {
            app.chat.view.scroll(true, 10);
            assert!(!app.chat.view.following());
            assert!(
                app.submission_for(placement).is_none(),
                "empty draft does not move the reader"
            );
            assert!(!app.chat.view.following());
            app.drafts.get_mut("a").unwrap().insert("new message");
            let request = app.submission_for(placement).unwrap();
            assert!(app.chat.view.following());
            assert_eq!(app.focus, crate::app::Focus::Composer);
            assert_eq!(app.drafts["a"].text(), "new message");
            terminal
                .draw(|f| {
                    app.chat.view.draw(f, f.area(), false).unwrap();
                })
                .unwrap();
            app.chat.view.scroll(true, 5);
            assert!(!app.chat.view.following());
            app.submitted(
                request,
                Ok(SubmitResult::Blocked {
                    message: "rejected".into(),
                    preparation: vec![],
                }),
            );
            assert!(
                !app.chat.view.following(),
                "a late reply does not override the user"
            );
            assert_eq!(app.drafts["a"].text(), "new message");
            app.drafts
                .get_mut("a")
                .unwrap()
                .clear_if_unchanged("new message");
        }
    }
    #[test]
    fn explicit_retry_keeps_original_epoch_identity_and_content_without_unlocking_on_rejection() {
        for locale in Locale::ALL {
            let mut app = App::new(
                "/unused".into(),
                I18n::new(LocalePreference::Explicit(locale), locale),
            );
            app.connection = ConnectionState::Connected {
                root_id: "root".into(),
                epoch: "epoch".into(),
            };
            app.apply(Action::Visit(Route::Session("a".into())));
            app.drafts.get_mut("a").unwrap().insert("original 中文🦀");
            let original = app.submission_for(Placement::CurrentTurn).unwrap();
            assert_eq!(original.input().origin_host_epoch, "epoch");
            assert!(app.retry_submission().is_none());
            app.submitted(
                original.clone(),
                Err(RequestFailure::Unknown(ClientError::Timeout)),
            );
            app.drafts.get_mut("a").unwrap().insert(" plus new edits");
            assert!(
                app.commands()
                    .iter()
                    .any(|(action, _)| action == &Action::RetrySubmission)
            );
            let index = app
                .commands()
                .iter()
                .position(|(action, _)| action == &Action::RetrySubmission)
                .unwrap();
            app.apply(Action::Palette);
            app.palette = Some(index);
            let mut terminal =
                ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 24)).unwrap();
            terminal
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            let stable = app.commands();
            let connected = std::mem::replace(
                &mut app.connection,
                ConnectionState::Failed("offline".into()),
            );
            assert_eq!(
                app.commands(),
                stable,
                "background changes must not move palette rows"
            );
            assert!(!app.enabled(&Action::RetrySubmission));
            terminal
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            app.connection = connected;
            terminal
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            let row = format!("list/rows/{index}");
            app.layer.reveal(&row);
            terminal
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            let hit = app.layer.rect(&row).unwrap();
            let click = crossterm::event::Event::Mouse(crossterm::event::MouseEvent {
                kind: crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left),
                column: hit.x,
                row: hit.y,
                modifiers: crossterm::event::KeyModifiers::NONE,
            });
            assert_eq!(app.input(click).1, Some(Action::RetrySubmission));
            assert!(app.palette.is_none());
            let retry = app.retry_submission().unwrap();
            assert_eq!(retry.input(), original.input());
            assert!(app.retry_submission().is_none());
            assert!(app.submission().is_none());
            assert!(app.reconciliation().is_none());
            app.submitted(
                retry,
                Ok(SubmitResult::Blocked {
                    message: "later rejection".into(),
                    preparation: vec![],
                }),
            );
            assert!(matches!(app.sending["a"].delivery, Delivery::Unknown(_)));
            assert!(app.submission().is_none());
            app.apply(Action::Palette);
            app.palette = Some(index);
            terminal
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            assert_eq!(
                app.input(crossterm::event::Event::Key(
                    crossterm::event::KeyEvent::new(
                        crossterm::event::KeyCode::Enter,
                        crossterm::event::KeyModifiers::NONE,
                    )
                ))
                .1,
                Some(Action::RetrySubmission)
            );
            let retry = app.retry_submission().unwrap();
            app.submitted(
                retry,
                Err(RequestFailure::Rejected(ClientError::Protocol(
                    "later rejection".into(),
                ))),
            );
            assert!(app.submission().is_none());
            app.connection = ConnectionState::Connected {
                root_id: "root".into(),
                epoch: "new-epoch".into(),
            };
            assert!(app.retry_submission().is_none());
            assert!(app.enabled(&Action::ReconcileSubmission));
            assert_eq!(app.sending["a"].request.input().origin_host_epoch, "epoch");
            app.connection = ConnectionState::Connected {
                root_id: "other-root".into(),
                epoch: "epoch".into(),
            };
            assert!(app.retry_submission().is_none());
            assert!(app.reconciliation().is_none());
            app.connection = ConnectionState::Connected {
                root_id: "root".into(),
                epoch: "epoch".into(),
            };
            let retry = app.retry_submission().unwrap();
            app.submitted(
                retry,
                Ok(SubmitResult::Steering {
                    preparation: vec![],
                    queue_revision: Some(1),
                }),
            );
            assert_eq!(app.drafts["a"].text(), "original 中文🦀 plus new edits");
            assert!(app.enabled(&Action::SendMessage));
            assert!(!app.enabled(&Action::RetrySubmission));
        }
    }
    #[test]
    fn reconciliation_preserves_uncertain_drafts_and_recovers_only_authoritative_outcomes() {
        use crossterm::event::{
            Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
        };
        let mut app = App::new(
            "/tmp/test".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Session("a".into())));
        app.drafts.get_mut("a").unwrap().insert("draft");
        let original = app.submission().unwrap();
        app.submitted(
            original.clone(),
            Err(RequestFailure::Unknown(ClientError::Timeout)),
        );
        assert_eq!(app.page_actions()[0], Action::ReconcileSubmission);
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 24)).unwrap();
        terminal
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        let hit = app
            .hits
            .iter()
            .find(|hit| hit.action == Action::ReconcileSubmission)
            .unwrap();
        let click = Event::Mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: hit.area.x,
            row: hit.area.y,
            modifiers: KeyModifiers::NONE,
        });
        assert_eq!(app.input(click).1, Some(Action::ReconcileSubmission));
        assert_eq!(
            app.input(Event::Key(KeyEvent::new(
                KeyCode::Char('r'),
                KeyModifiers::CONTROL
            )))
            .1,
            Some(Action::ReconcileSubmission)
        );
        let checking = app.reconciliation().unwrap();
        assert!(app.reconciliation().is_none());
        assert!(app.submission().is_none());
        app.reconciled(checking, Ok(None));
        assert!(!app.enabled(&Action::SendMessage));
        assert_eq!(app.drafts["a"].text(), "draft");
        assert!(matches!(app.sending["a"].delivery, Delivery::Unknown(None)));
        let checking = app.reconciliation().unwrap();
        app.reconciled(checking, Err(RequestFailure::Unknown(ClientError::Timeout)));
        assert!(app.enabled(&Action::ReconcileSubmission));

        // Reconnect to the same Root after a Host restart can read the durable receipt.
        let stale = app.reconciliation().unwrap();
        app.abandon_pending_submissions();
        app.reconciled(
            stale,
            Ok(Some(ExecutionResolution::Pending {
                message_id: original.id.clone(),
            })),
        );
        assert!(!app.enabled(&Action::SendMessage));
        app.connection = ConnectionState::Connected {
            root_id: "other".into(),
            epoch: "new".into(),
        };
        assert!(app.reconciliation().is_none());
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "new".into(),
        };
        let checking = app.reconciliation().unwrap();
        app.drafts.get_mut("a").unwrap().insert(" plus edits");
        app.apply(Action::Visit(Route::Session("b".into())));
        app.reconciled(
            checking,
            Ok(Some(ExecutionResolution::Owned {
                message_id: original.id,
                turn_id: "turn".into(),
                run_id: "run".into(),
            })),
        );
        assert_eq!(app.drafts["a"].text(), "draft plus edits");
        app.apply(Action::Visit(Route::Session("a".into())));
        assert!(app.enabled(&Action::SendMessage));
        for state in ["not_admitted", "cancelled", "pending"] {
            let request = app.submission().unwrap();
            app.abandon_pending_submissions();
            let checking = app.reconciliation().unwrap();
            let resolution = match state {
                "not_admitted" => ExecutionResolution::NotAdmitted {
                    message_id: request.id,
                },
                "cancelled" => ExecutionResolution::Cancelled {
                    message_id: request.id,
                },
                _ => ExecutionResolution::Pending {
                    message_id: request.id,
                },
            };
            app.reconciled(checking, Ok(Some(resolution)));
            assert_eq!(
                app.drafts["a"].text(),
                if state == "pending" {
                    ""
                } else {
                    "draft plus edits"
                }
            );
            assert_eq!(app.page_actions()[0], Action::SendMessage);
        }
    }
    #[test]
    fn send_ack_keeps_new_edits_and_unknown_outcomes_never_enable_duplicate_send() {
        let mut app = App::new(
            "/tmp/test".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Session("a".into())));
        app.drafts.get_mut("a").unwrap().insert("first");
        let request = app.submission().unwrap();
        assert!(!app.enabled(&Action::SendMessage));
        app.drafts.get_mut("a").unwrap().insert(" plus edits");
        app.submitted(
            request,
            Ok(SubmitResult::TurnStarted {
                turn_id: "turn".into(),
                preparation: vec![],
            }),
        );
        assert_eq!(app.drafts["a"].text(), "first plus edits");
        let request = app.submission().unwrap();
        app.apply(Action::Visit(Route::Session("b".into())));
        app.submitted(request, Err(RequestFailure::Unknown(ClientError::Timeout)));
        app.apply(Action::Visit(Route::Session("a".into())));
        assert!(!app.enabled(&Action::SendMessage));
        assert!(app.submission().is_none());
        assert_eq!(app.drafts["a"].text(), "first plus edits");
        // A definite rejection allows correction; an acknowledgement clears only the sent revision.
        app.sending.clear();
        let request = app.submission().unwrap();
        app.submitted(
            request,
            Ok(SubmitResult::Blocked {
                message: "blocked".into(),
                preparation: vec![],
            }),
        );
        assert!(app.enabled(&Action::SendMessage));
        let request = app.submission().unwrap();
        app.submitted(
            request,
            Ok(SubmitResult::Followup {
                preparation: vec![],
                queue_revision: Some(1),
            }),
        );
        assert_eq!(app.drafts["a"].text(), "");
    }
}
