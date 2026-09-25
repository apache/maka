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

use super::{
    Command, Error, Phase, Request, Settlement, Snapshot, invalid, repository::Repository,
};
use maka_plugins::{
    authorization::{Capability, Id, Target},
    background::BackgroundWork,
    execution::{CommandError, Commands, Observation, Progress},
    host::Services,
};
use maka_runtime::event::{Invocation, InvocationOutcome};
use sha2::{Digest, Sha256};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;

pub(super) struct Owner {
    pub storage: Arc<dyn maka_plugins::storage::Store>,
    pub executions: Arc<dyn maka_plugins::execution::Access>,
    authorizations: Arc<dyn maka_plugins::authorization::Access>,
    entry: String,
    gate: Mutex<()>,
    pending: AtomicBool,
    wake: Notify,
    pub(super) revisions: tokio::sync::watch::Sender<()>,
}

impl BackgroundWork for Owner {
    fn is_pending(&self) -> bool {
        self.pending.load(Ordering::Acquire)
    }
    fn wake(&self) {
        self.wake.notify_one();
    }
}

impl Owner {
    pub fn new(host: Services, entry: String) -> Arc<Self> {
        Arc::new(Self {
            storage: host.storage,
            executions: host.executions,
            authorizations: host.authorizations,
            entry,
            gate: Mutex::new(()),
            pending: AtomicBool::new(true),
            wake: Notify::new(),
            revisions: tokio::sync::watch::channel(()).0,
        })
    }

    pub fn repository(&self, session: &str) -> Result<Repository, Error> {
        Repository::new(self.storage.clone(), &self.entry, session)
    }

    pub fn changed(&self) {
        self.pending.store(true, Ordering::Release);
        self.wake.notify_one();
        self.revisions.send_replace(());
    }

    pub async fn grant(&self, grant: Id, session: &str) -> Result<(), Error> {
        let owned = self.authorizations.open(grant).await?;
        let valid = owned.grant.request.target
            == Target::Session {
                session_id: session.into(),
            }
            && owned
                .grant
                .request
                .capabilities
                .contains(&Capability::Executions);
        owned.call.finish().await?;
        if valid {
            Ok(())
        } else {
            Err(invalid(
                "Plan requires explicit execution consent for this Session",
            ))
        }
    }

    pub async fn apply(&self, session: &str, request: &Request) -> Result<Snapshot, Error> {
        let _gate = self.gate.lock().await;
        let result = self.repository(session)?.apply(request, now()?).await?;
        self.changed();
        Ok(result)
    }

    async fn advance(
        &self,
        session: &str,
        snapshot: &Snapshot,
        command: Command,
    ) -> Result<Snapshot, Error> {
        let operation_id = identity(&("observe", snapshot.revision, &command))?;
        self.apply(
            session,
            &Request {
                operation_id,
                expected_revision: snapshot.revision,
                command,
            },
        )
        .await
    }

    /// Check the real current invocation and this plugin's original receipt.
    /// A Session ID or a model-supplied execution ID grants no progress authority.
    pub async fn active(
        &self,
        commands: &dyn Commands,
        invocation: &Invocation,
    ) -> Result<(Snapshot, maka_plugins::execution::Receipt), Error> {
        let session = &invocation.session_id;
        let snapshot = self.repository(session)?.current().await?;
        let execution = snapshot
            .execution
            .as_ref()
            .ok_or_else(|| invalid("No Plan execution"))?;
        if !matches!(
            execution.phase,
            Phase::AwaitingAdmission | Phase::Active { .. }
        ) {
            return Err(Error::Conflict);
        }
        let observation = commands
            .query(execution.request.operation_id.clone())
            .await?;
        let activity = commands.activity(session.clone()).await?;
        if observation.receipt.invocation.turn_id != invocation.turn_id
            || observation.receipt.invocation.session_id != *session
            || !matches!(
                observation.progress,
                Progress::Running | Progress::WaitingForUser
            )
            || !activity
                .execution
                .is_some_and(|current| current.invocation == *invocation)
        {
            return Err(Error::Conflict);
        }
        let snapshot = self.accept(session, &observation.receipt).await?;
        Ok((snapshot, observation.receipt))
    }

    async fn accept(
        &self,
        session: &str,
        receipt: &maka_plugins::execution::Receipt,
    ) -> Result<Snapshot, Error> {
        let _gate = self.gate.lock().await;
        let repo = self.repository(session)?;
        let snapshot = repo.current().await?;
        let execution = snapshot.execution.as_ref().ok_or(Error::Conflict)?;
        match &execution.phase {
            Phase::AwaitingAdmission => {
                let command = Command::Accept {
                    execution_id: execution.id.clone(),
                    receipt: receipt.clone(),
                };
                repo.apply(
                    &Request {
                        operation_id: identity(&("accept", snapshot.revision, &command))?,
                        expected_revision: snapshot.revision,
                        command,
                    },
                    now()?,
                )
                .await
            }
            Phase::Active { receipt: current } if current == receipt => Ok(snapshot),
            _ => Err(Error::Conflict),
        }
    }

    pub async fn run(self: Arc<Self>, stop: CancellationToken) -> Result<(), String> {
        loop {
            if stop.is_cancelled() {
                return Ok(());
            }
            let sessions = self
                .repository_sessions()
                .await
                .map_err(|error| error.to_string())?;
            let mut pending = false;
            for session in sessions {
                let result = tokio::select! {
                    biased;
                    _ = stop.cancelled() => return Ok(()),
                    result = self.reconcile(&session) => result,
                };
                // A revoked grant or an unavailable Host cannot justify keeping it
                // awake. Durable intent remains for explicit renewal and recovery.
                pending |= result.unwrap_or(false);
            }
            self.pending.store(pending, Ordering::Release);
            tokio::select! {
                biased;
                _ = stop.cancelled() => return Ok(()),
                _ = self.wake.notified() => {},
                _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {},
            }
        }
    }

    async fn repository_sessions(&self) -> Result<Vec<String>, Error> {
        Repository::sessions(self.storage.as_ref(), &self.entry).await
    }

    async fn reconcile(&self, session: &str) -> Result<bool, Error> {
        let snapshot = self.repository(session)?.current().await?;
        let Some(execution) = snapshot.execution.as_ref() else {
            return Ok(false);
        };
        if !matches!(
            execution.phase,
            Phase::AwaitingAdmission | Phase::Active { .. }
        ) {
            return Ok(false);
        }
        let commands = self.executions.restore(execution.grant).await?;
        match commands.query(execution.request.operation_id.clone()).await {
            Ok(observation) => self.observe(session, commands.as_ref(), observation).await,
            Err(CommandError::NotFound) if matches!(execution.phase, Phase::AwaitingAdmission) => {
                if execution.cancellation.is_some() {
                    // An earlier dispatch may still arrive. Cancellation never
                    // resubmits it, changes its ID, or assumes absence is proof.
                    return Ok(false);
                }
                let first_dispatch = !execution.dispatched;
                if first_dispatch {
                    self.advance(
                        session,
                        &snapshot,
                        Command::Dispatch {
                            execution_id: execution.id.clone(),
                        },
                    )
                    .await?;
                }
                match commands.submit(execution.request.clone()).await {
                    Ok(_) => {
                        let observation = commands
                            .query(execution.request.operation_id.clone())
                            .await?;
                        self.observe(session, commands.as_ref(), observation).await
                    }
                    Err(CommandError::Busy | CommandError::Draining) if first_dispatch => {
                        let current = self.repository(session)?.current().await?;
                        self.advance(
                            session,
                            &current,
                            Command::Defer {
                                execution_id: execution.id.clone(),
                            },
                        )
                        .await?;
                        Ok(true)
                    }
                    Err(
                        error @ (CommandError::Denied
                        | CommandError::Revoked
                        | CommandError::Invalid(_)
                        | CommandError::Conflict
                        | CommandError::Unavailable(_)),
                    ) if first_dispatch => {
                        let current = self.repository(session)?.current().await?;
                        self.advance(
                            session,
                            &current,
                            Command::Reject {
                                execution_id: execution.id.clone(),
                                request_digest: execution.request.digest().map_err(invalid)?,
                                reason: bounded(&error.to_string()),
                            },
                        )
                        .await?;
                        Ok(false)
                    }
                    Err(error) => Err(error.into()),
                }
            }
            Err(error) => Err(error.into()),
        }
    }

    async fn observe(
        &self,
        session: &str,
        commands: &dyn Commands,
        mut observation: Observation,
    ) -> Result<bool, Error> {
        let mut snapshot = self.repository(session)?.current().await?;
        let Some(execution) = snapshot.execution.as_ref() else {
            return Ok(false);
        };
        if !matches!(
            execution.phase,
            Phase::AwaitingAdmission | Phase::Active { .. }
        ) || execution.request.digest().map_err(invalid)? != observation.receipt.content_digest
        {
            return Ok(false);
        }
        if matches!(execution.phase, Phase::AwaitingAdmission) {
            snapshot = self
                .advance(
                    session,
                    &snapshot,
                    Command::Accept {
                        execution_id: execution.id.clone(),
                        receipt: observation.receipt.clone(),
                    },
                )
                .await?;
        }
        let execution = snapshot.execution.as_ref().ok_or(Error::Conflict)?;
        if execution.cancellation.is_some()
            && !matches!(observation.progress, Progress::Ended { .. })
        {
            observation = commands
                .cancel(execution.request.operation_id.clone())
                .await?;
        }
        let Progress::Ended { outcome } = observation.progress else {
            // Host owns accepted work. A sealed handoff never becomes a fresh
            // submission here; resume it through the public Session controls.
            return Ok(false);
        };
        let outcome = match outcome {
            InvocationOutcome::Completed => Settlement::Completed,
            InvocationOutcome::Failed { class, message } => Settlement::Interrupted {
                reason: bounded(&message.unwrap_or(class)),
            },
            InvocationOutcome::Cancelled { source } => Settlement::Interrupted {
                reason: bounded(&format!("Host execution cancelled: {source}")),
            },
            _ => return Err(invalid("Unexpected Plan execution outcome")),
        };
        self.advance(
            session,
            &snapshot,
            Command::Settle {
                execution_id: execution.id.clone(),
                invocation: observation.receipt.invocation,
                outcome,
            },
        )
        .await?;
        Ok(false)
    }
}

pub(super) fn identity(value: &impl serde::Serialize) -> Result<String, Error> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).map_err(invalid)?)
    ))
}

pub(super) fn now() -> Result<u64, Error> {
    u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(invalid)?
            .as_millis(),
    )
    .map_err(invalid)
}

fn bounded(value: &str) -> String {
    let value = value.replace('\0', "");
    let mut end = value.len().min(1024);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    let value = value[..end].trim();
    if value.is_empty() {
        "Host execution interrupted".into()
    } else {
        value.into()
    }
}
