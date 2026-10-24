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

use super::*;
use maka_event_log::sessions::{SessionMutation, SessionRemovalResult, SessionRetirement};

impl Owner {
    pub async fn change_session(
        self: &Arc<Self>,
        input: ChangeSession,
    ) -> Result<SessionChanged, String> {
        let runs = self.runs.lock().await;
        if runs.closing {
            return Ok(SessionChanged::Rejected {
                reason: Rejection::Closed,
            });
        }
        if !self.owns(&input.session_id) {
            return Ok(SessionChanged::Rejected {
                reason: Rejection::SessionUnavailable,
            });
        }
        // Retry observes the durable deletion fence even after catalog removal.
        if matches!(input.action, SessionAction::Remove)
            && self
                .store
                .session_retirement(&input.session_id)
                .await
                .map_err(|_| "agent_session_unavailable")?
                .is_some_and(SessionRetirement::removes)
        {
            self.finish_removed_session(input.session_id.clone());
            return Ok(SessionChanged::Removed {
                session_id: input.session_id,
            });
        }
        let Some(session) = self
            .store
            .get_session::<StoredSessionConfiguration>(&input.session_id)
            .await
            .map_err(|_| "agent_session_unavailable")?
        else {
            return Ok(SessionChanged::Rejected {
                reason: Rejection::SessionUnavailable,
            });
        };
        if session.revision != input.expected_revision {
            return Ok(SessionChanged::RevisionConflict {
                expected: input.expected_revision,
                actual: session.revision,
            });
        }
        // Managed tasks retain their owner's lifecycle authority.
        if self
            .store
            .session(&input.session_id)
            .await
            .map_err(|error| error.to_string())?
            .session_manager(&input.session_id)
            .await
            .map_err(|_| "agent_session_unavailable")?
            .is_some()
        {
            return Ok(SessionChanged::Rejected {
                reason: Rejection::SessionUnavailable,
            });
        }
        if runs.controls.contains_key(&input.session_id)
            || !self
                .store
                .session(&input.session_id)
                .await
                .map_err(|error| error.to_string())?
                .message_queue(&input.session_id)
                .await
                .map_err(|_| "agent_queue_unavailable")?
                .entries
                .is_empty()
            || self.graph_selected(&input.session_id).await?
            || !matches!(
                crate::service::summary(self, resolve_session(session)?).activity,
                SessionActivity::Idle
            )
        {
            return Ok(SessionChanged::Rejected {
                reason: Rejection::Busy,
            });
        }
        if matches!(input.action, SessionAction::Archive) {
            self.titles
                .cancel_and_wait(&input.session_id)
                .await
                .map_err(|_| "agent_session_change_unknown")?;
        }
        match input.action {
            SessionAction::Remove => {
                match self
                    .store
                    .begin_session_removal(&input.session_id, input.expected_revision)
                    .await
                    .map_err(|_| "agent_session_change_unknown")?
                {
                    SessionRemovalResult::RevisionConflict { expected, actual } => {
                        Ok(SessionChanged::RevisionConflict { expected, actual })
                    }
                    SessionRemovalResult::Accepted(_) => {
                        // Delete the conversation only. User workspace files and
                        // independent copies are intentionally retained.
                        self.finish_removed_session(input.session_id.clone());
                        Ok(SessionChanged::Removed {
                            session_id: input.session_id,
                        })
                    }
                }
            }
            SessionAction::Archive | SessionAction::Restore => {
                match self
                    .store
                    .change_session_archived::<StoredSessionConfiguration>(
                        &input.session_id,
                        Some(input.expected_revision),
                        matches!(input.action, SessionAction::Archive),
                        now(),
                    )
                    .await
                {
                    Ok(SessionMutation::Committed(session)) => Ok(SessionChanged::Changed {
                        session: Box::new(crate::service::summary(self, resolve_session(session)?)),
                    }),
                    Ok(SessionMutation::RevisionConflict { expected, actual }) => {
                        Ok(SessionChanged::RevisionConflict { expected, actual })
                    }
                    Err(maka_event_log::StoreError::SessionBusy) => Ok(SessionChanged::Rejected {
                        reason: Rejection::Busy,
                    }),
                    Err(_) => Err("agent_session_change_unknown".into()),
                }
            }
        }
    }

    fn finish_removed_session(self: &Arc<Self>, session: String) {
        let owner = self.clone();
        self.workers.spawn(async move {
            loop {
                if owner.stop.is_cancelled() {
                    return;
                }
                match owner.store.session_retirement(&session).await {
                    Ok(Some(SessionRetirement::Removed)) | Ok(None) => return,
                    Ok(Some(SessionRetirement::Removing)) => {}
                    _ => return,
                }
                if !matches!(
                    owner.store.session_retirement_ready(&session).await,
                    Ok(true)
                ) {
                    tokio::select! {
                        _ = owner.stop.cancelled() => return,
                        _ = tokio::time::sleep(Duration::from_millis(200)) => continue,
                    }
                }
                if owner.engine.release_session_state(&session).is_err() {
                    tokio::select! {
                        _ = owner.stop.cancelled() => return,
                        _ = tokio::time::sleep(Duration::from_secs(1)) => continue,
                    }
                }
                // The original deletion fence is restart recovery. Never undo it
                // or acknowledge cleanup if durable owners are still unsettled.
                if matches!(
                    owner.store.finish_session_retirement(&session).await,
                    Ok(SessionRetirement::Removed)
                ) {
                    return;
                }
                tokio::select! {
                    _ = owner.stop.cancelled() => return,
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {},
                }
            }
        });
    }

    pub(super) fn recover_removed_sessions(self: &Arc<Self>) {
        let owner = self.clone();
        self.workers.spawn(async move {
            let mut after = None;
            loop {
                if owner.stop.is_cancelled() {
                    return;
                }
                let Ok(sessions) = owner
                    .store
                    .pending_session_retirements(after.as_deref())
                    .await
                else {
                    return;
                };
                if sessions.is_empty() {
                    return;
                }
                for session in &sessions {
                    if owner.owns(session) {
                        owner.finish_removed_session(session.clone());
                    }
                }
                after = sessions.last().cloned();
            }
        });
    }
}
