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
use maka_agent_state::SessionQuiescenceGuard;
use maka_event_log::{
    StoreError,
    sessions::SessionRetirement,
    writeback::{Notification, Prepared, Statement},
};
use maka_plugin_core::operation::RecoveryRef;

impl Owner {
    pub async fn change_session(
        self: &Arc<Self>,
        input: ChangeSession,
        _operation: &RecoveryRef,
    ) -> Result<NativeMutation<SessionChanged>, String> {
        let _producer = if matches!(input.action, SessionAction::Restore) {
            Some(self.producer_gate.lock().await)
        } else {
            None
        };
        if !self.owns(&input.session_id) {
            return Ok(session_rejected(Rejection::SessionUnavailable));
        }
        let ordered = Arc::new(self.runs.ordered(&input.session_id).await);
        {
            let runs = self.runs.state().await;
            if runs.closing || self.stop.is_cancelled() {
                return Ok(session_rejected(Rejection::Closed));
            }
            if runs.busy(&input.session_id) || self.mcp_projects.has_any_client(&input.session_id) {
                return Ok(session_rejected(Rejection::Busy));
            }
        }
        if matches!(input.action, SessionAction::Remove)
            && self
                .store
                .session_retirement(&input.session_id)
                .await
                .map_err(|error| error.to_string())?
                .is_some_and(SessionRetirement::removes)
        {
            self.finish_removed_session(
                input.session_id.clone(),
                &tokio::runtime::Handle::current(),
            );
            return Ok(NativeMutation::Returned(SessionChanged::Removed {
                session_id: input.session_id,
            }));
        }
        let guard = self
            .durable
            .quiescence_guard(self.run_owner(), input.session_id.clone())
            .map_err(|error| error.to_string())?;
        if !guard
            .observe()
            .await
            .map_err(|error| error.to_string())?
            .is_quiescent()
        {
            return Ok(session_rejected(Rejection::Busy));
        }
        let Some(mut record) = self
            .canonical_catalog()?
            .record(&input.session_id)
            .await
            .map_err(|error| error.to_string())?
        else {
            return Ok(session_rejected(Rejection::SessionUnavailable));
        };
        if record.metadata.revision != input.expected_revision {
            return Ok(NativeMutation::Returned(SessionChanged::RevisionConflict {
                expected: input.expected_revision,
                actual: record.metadata.revision,
            }));
        }
        if !matches!(input.action, SessionAction::Restore) {
            self.titles
                .cancel_and_wait(&input.session_id)
                .await
                .map_err(|()| "agent_session_change_unknown".to_owned())?;
        }
        if record.metadata.archived && matches!(input.action, SessionAction::Restore) {
            self.retire_caller_completions(&input.session_id).await?;
        }
        let writer = guard.data_writer().clone();
        let cleanup = matches!(input.action, SessionAction::Remove).then(|| {
            (
                self.clone(),
                input.session_id.clone(),
                tokio::runtime::Handle::current(),
            )
        });
        let statement = SessionLifecycle {
            guard,
            ordered,
            cleanup,
        };
        match input.action {
            SessionAction::Remove => match self
                .store
                .prepare_session_removal(
                    &input.session_id,
                    input.expected_revision,
                    &writer,
                    statement,
                )
                .await
            {
                Ok((_, change)) => Ok(NativeMutation::Commit {
                    value: SessionChanged::Removed {
                        session_id: input.session_id,
                    },
                    change,
                }),
                Err(error) => session_change_error(error),
            },
            SessionAction::Archive | SessionAction::Restore => match self
                .store
                .prepare_session_archived::<serde_json::Value, _>(
                    &input.session_id,
                    input.expected_revision,
                    matches!(input.action, SessionAction::Archive),
                    now(),
                    &writer,
                    statement,
                )
                .await
            {
                Ok((metadata, change)) => {
                    record.metadata = metadata;
                    Ok(NativeMutation::Commit {
                        value: SessionChanged::Changed {
                            session: Box::new(crate::service::summary(self, record)?),
                        },
                        change,
                    })
                }
                Err(error) => session_change_error(error),
            },
        }
    }

    fn finish_removed_session(self: &Arc<Self>, session: String, runtime: &tokio::runtime::Handle) {
        let owner = self.clone();
        self.workers.spawn_on(async move {
            if let Err(error) = owner.finish_removed_session_inner(&session).await {
                tracing::error!(%session, %error, "Original session retirement remains unsettled");
            }
        }, runtime);
    }
    async fn finish_removed_session_inner(&self, session: &str) -> Result<(), String> {
        let mut changed = self.store.subscribe_changes();
        let guard = self
            .durable
            .quiescence_guard(self.run_owner(), session.into())
            .map_err(|error| error.to_string())?;
        loop {
            changed.borrow_and_update();
            if self.stop.is_cancelled() {
                return Ok(());
            }
            match self
                .store
                .session_retirement(session)
                .await
                .map_err(|error| error.to_string())?
            {
                Some(SessionRetirement::Removed) | None => return Ok(()),
                Some(SessionRetirement::Removing) => {}
                _ => return Err("agent_session_retirement_changed".into()),
            }
            if guard
                .observe()
                .await
                .map_err(|error| error.to_string())?
                .is_quiescent()
            {
                tokio::select! {
                    _ = self.stop.cancelled() => return Ok(()),
                    result = self.store.wait_session_retirement_work(session) => result.map_err(|error| error.to_string())?,
                }
                if !guard
                    .observe()
                    .await
                    .map_err(|error| error.to_string())?
                    .is_quiescent()
                {
                    continue;
                }
                if self
                    .store
                    .session_retirement_ready(session)
                    .await
                    .map_err(|error| error.to_string())?
                {
                    self.executors
                        .remove_sessions(&[session.to_owned()])
                        .await?;
                    match self.store.finish_session_retirement(session).await {
                        Ok(SessionRetirement::Removed) => return Ok(()),
                        Ok(SessionRetirement::Removing) | Err(StoreError::SessionBusy) => {}
                        Ok(_) => return Err("agent_session_retirement_changed".into()),
                        Err(error) => return Err(error.to_string()),
                    }
                }
            }
            tokio::select! {
                _ = self.stop.cancelled() => return Ok(()),
                result = changed.changed() => result.map_err(|error| error.to_string())?,
            }
        }
    }
    pub(super) fn recover_removed_sessions(self: &Arc<Self>) {
        let owner = self.clone();
        self.workers.spawn(async move {
            let mut after = None;
            loop {
                if owner.stop.is_cancelled() {
                    return;
                }
                let sessions = match owner
                    .store
                    .pending_session_retirements(after.as_deref())
                    .await
                {
                    Ok(sessions) => sessions,
                    Err(error) => {
                        tracing::error!(%error, "Session retirement recovery is unavailable");
                        return;
                    }
                };
                if sessions.is_empty() {
                    return;
                }
                for session in &sessions {
                    if owner.owns(session) {
                        owner.finish_removed_session(
                            session.clone(),
                            &tokio::runtime::Handle::current(),
                        );
                    }
                }
                after = sessions.last().cloned();
            }
        });
    }
}
struct SessionLifecycle {
    guard: SessionQuiescenceGuard,
    ordered: Arc<runs::Ordered>,
    cleanup: Option<(Arc<Owner>, String, tokio::runtime::Handle)>,
}
impl Statement for SessionLifecycle {
    type Value = Option<(Arc<Owner>, String, tokio::runtime::Handle)>;
    type Output = ();
    fn retain(&self) -> Vec<Arc<dyn std::marker::Send + Sync>> {
        vec![self.ordered.clone()]
    }
    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<Prepared<Self::Value>, StoreError> {
        let (changed, notification) = if let Some((owner, _, _)) = &self.cleanup {
            let released = owner.durable.artifacts().retire_session_in_transaction(
                connection,
                &self.guard,
                &owner.store,
            )?;
            (released.changed, released.notification)
        } else {
            self.guard.validate(connection)?;
            (false, Notification::NONE)
        };
        Ok(Prepared {
            value: self.cleanup,
            changed,
            notification,
        })
    }
    fn committed(cleanup: Self::Value) {
        if let Some((owner, session, runtime)) = cleanup {
            owner.finish_removed_session(session, &runtime);
        }
    }
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}
fn session_rejected(reason: Rejection) -> NativeMutation<SessionChanged> {
    NativeMutation::Returned(SessionChanged::Rejected { reason })
}
fn session_change_error(error: StoreError) -> Result<NativeMutation<SessionChanged>, String> {
    Ok(match error {
        StoreError::SessionRevisionConflict { expected, actual } => {
            NativeMutation::Returned(SessionChanged::RevisionConflict { expected, actual })
        }
        StoreError::SessionBusy => session_rejected(Rejection::Busy),
        StoreError::SessionNotFound | StoreError::SessionRetired => {
            session_rejected(Rejection::SessionUnavailable)
        }
        error => return Err(format!("agent_session_change_unknown: {error}")),
    })
}
