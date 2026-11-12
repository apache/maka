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
use maka_event_log::{
    StoreError,
    root_store::DataChange,
    writeback::{Prepared, Statement},
};
use maka_plugin_core::storage::{Mutation, Record};
use maka_sandbox::workspace::BindingRef;

pub(super) enum Purpose {
    Session,
    Bot {
        guard: Arc<tokio::sync::OwnedMutexGuard<()>>,
        mutations: Vec<Mutation>,
    },
}

pub(super) enum PreparedCreation {
    Rejected(Rejection),
    Ready(DataChange),
}
impl PreparedCreation {
    pub(super) fn into_session(self) -> NativeMutation<Created> {
        match self {
            Self::Rejected(reason) => NativeMutation::Returned(Created::Rejected { reason }),
            Self::Ready(change) => NativeMutation::Computed { change },
        }
    }
    pub(super) fn into_bot(self) -> NativeMutation<BotOpened> {
        match self {
            Self::Rejected(_) => NativeMutation::Returned(BotOpened::Rejected {
                reason: BotRejection::CreationRejected,
            }),
            Self::Ready(change) => NativeMutation::Computed { change },
        }
    }
}

impl Owner {
    #[expect(
        clippy::too_many_arguments,
        reason = "Creation atomically binds the original operation, workspace, caller fence, purpose and configuration"
    )]
    pub(super) async fn prepare_created_session<F>(
        &self,
        id: &str,
        operation: &maka_plugin_core::operation::RecoveryRef,
        workspace: &Workspace,
        project: Option<maka_event_log::root_store::ProjectWorkspacePlan>,
        scope: &maka_capabilities::call::Scope,
        caller: Option<maka_agent_state::CallerFence>,
        purpose: Purpose,
        preset: Option<presets::CreationFence>,
        configuration: F,
    ) -> Result<PreparedCreation, String>
    where
        F: FnOnce(BindingRef) -> StoredSessionConfiguration + std::marker::Send + 'static,
    {
        let (guard, mutations) = match purpose {
            Purpose::Session => (None, self.prepare_bot_watch(scope, id).await?),
            Purpose::Bot { guard, mutations } => (Some(guard), mutations),
        };
        let writer = match scope.identity.agent() {
            Some(execution) => {
                let custody = scope.work_custody().ok_or("agent_work_custody_required")?;
                self.store
                    .data_writer_for_work(custody.as_ref(), &execution.session_id)
            }
            None => self.store.data_writer(),
        }
        .map_err(|error| error.to_string())?;
        let creation = self
            .store
            .prepare_session_creation(
                maka_event_log::root_store::SessionCreationRequest {
                    id,
                    fingerprint: &operation.fingerprint,
                    owner_scope: &self.prefix,
                    workspace,
                    project,
                    now: now(),
                },
                &writer,
                move |binding| Ok(serde_json::to_value(configuration(binding))?),
            )
            .await
            .map_err(|error| error.to_string())?;
        let planned = self
            .canonical_catalog()?
            .planned_empty(id)
            .map_err(|error| error.to_string())?;
        let source = self.data_source.clone();
        let change = writer
            .prepare_result(|accepted| {
                let extra = if mutations.is_empty() {
                    None
                } else {
                    Some(self.bot.prepare_creation_storage(mutations, &accepted)?)
                };
                Ok(Creation {
                    creation,
                    preset,
                    extra,
                    planned,
                    source,
                    guard,
                    caller,
                    bot: self.bot.clone(),
                })
            })
            .map_err(|error| error.to_string())?;
        Ok(PreparedCreation::Ready(change))
    }
}

struct Creation<S, B> {
    creation: S,
    preset: Option<presets::CreationFence>,
    extra: Option<(Option<usize>, B)>,
    planned: maka_agent_state::session_catalog::PlannedCatalog,
    source: DataSource,
    guard: Option<Arc<tokio::sync::OwnedMutexGuard<()>>>,
    caller: Option<maka_agent_state::CallerFence>,
    bot: Arc<bot::Bot>,
}

#[derive(Serialize)]
#[serde(transparent)]
struct CreationResult<T, E> {
    reply: Value,
    #[serde(skip)]
    success: Option<CreationCommit<T, E>>,
}
struct CreationCommit<T, E> {
    inner: T,
    extra: Option<E>,
    bot: Arc<bot::Bot>,
    registration: Option<bot::Registration>,
}
fn creation_reply(is_bot: bool, reason: Rejection) -> Result<Value, StoreError> {
    Ok(if is_bot {
        serde_json::to_value(BotOpened::Rejected {
            reason: BotRejection::CreationRejected,
        })?
    } else {
        serde_json::to_value(Created::Rejected { reason })?
    })
}
impl<S, B> Statement for Creation<S, B>
where
    S: Statement<Value = SessionRecord, Output = SessionRecord>,
    B: Statement<Value = Vec<Record>, Output = Vec<Record>>,
{
    type Value = CreationResult<S::Value, B::Value>;
    type Output = (Value, Option<(S::Output, Option<B::Output>)>);
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD || B::PREPARE_OFF_THREAD;

    fn retain(&self) -> Vec<Arc<dyn std::marker::Send + Sync>> {
        let mut retained = self.creation.retain();
        if let Some((_, extra)) = &self.extra {
            retained.extend(extra.retain());
        }
        if let Some(guard) = &self.guard {
            retained.push(guard.clone());
        }
        retained
    }
    fn prepare(self) -> Result<Self, StoreError> {
        Ok(Self {
            creation: self.creation.prepare()?,
            extra: self
                .extra
                .map(|(index, statement)| statement.prepare().map(|statement| (index, statement)))
                .transpose()?,
            ..self
        })
    }
    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<Prepared<Self::Value>, StoreError> {
        let is_bot = self.guard.is_some();
        if let Some(fence) = &self.preset
            && let Some(reason) = fence.check(connection)?
        {
            return Ok(Prepared {
                value: CreationResult {
                    reply: creation_reply(is_bot, reason)?,
                    success: None,
                },
                changed: false,
                notification: maka_event_log::writeback::Notification::NONE,
            });
        }
        if let Some(caller) = &self.caller {
            let reason = match caller.status(connection)? {
                maka_agent_state::CallerStatus::Current => None,
                maka_agent_state::CallerStatus::Unavailable => Some(Rejection::SessionUnavailable),
                maka_agent_state::CallerStatus::AuthorizationChanged => {
                    Some(Rejection::WorkspaceUnavailable)
                }
            };
            if let Some(reason) = reason {
                return Ok(Prepared {
                    value: CreationResult {
                        reply: creation_reply(is_bot, reason)?,
                        success: None,
                    },
                    changed: false,
                    notification: maka_event_log::writeback::Notification::NONE,
                });
            }
        }
        let written = creation_sql(
            connection,
            || {
                let creation = self.creation.execute(connection)?;
                let mut changed = creation.changed;
                let mut notification = creation.notification;
                let mut registration = None;
                let mut extra_value = None;
                if let Some((index, extra)) = self.extra {
                    let extra = extra.execute(connection)?;
                    changed |= extra.changed;
                    notification = notification.combine(extra.notification);
                    if let Some(index) = index {
                        registration =
                            Some(bot::Registration::from_record(extra.value[index].clone())?);
                    }
                    extra_value = Some(extra.value);
                }
                let record = self.planned.record(creation.value.clone())?;
                let reply = if is_bot {
                    serde_json::to_value(BotOpened::Opened {
                        session_id: record.metadata.id,
                        created: true,
                    })?
                } else {
                    let session = crate::service::summary_for(&self.source, record).map_err(
                        |diagnostic| StoreError::StatementRejected {
                            cause: Arc::new(StoreError::InvalidTransition(diagnostic.clone())),
                            diagnostic,
                        },
                    )?;
                    serde_json::to_value(Created::Created {
                        session: Box::new(session),
                    })?
                };
                Ok(Prepared {
                    value: CreationResult {
                        reply,
                        success: Some(CreationCommit {
                            inner: creation.value,
                            extra: extra_value,
                            bot: self.bot,
                            registration,
                        }),
                    },
                    changed,
                    notification,
                })
            },
            creation_rejection,
        )?;
        match written {
            Ok(success) => Ok(success),
            Err(reason) => Ok(Prepared {
                value: CreationResult {
                    reply: creation_reply(is_bot, reason)?,
                    success: None,
                },
                changed: false,
                notification: maka_event_log::writeback::Notification::NONE,
            }),
        }
    }
    fn committed(value: Self::Value) -> Self::Output {
        let converted = value.success.map(|success| {
            let inner = S::committed(success.inner);
            let extra = success.extra.map(B::committed);
            if let Some(registration) = success.registration {
                success.bot.observe(registration);
            }
            (inner, extra)
        });
        (value.reply, converted)
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(error.underlying(), StoreError::StatementRejected { .. })
            || S::isolated_rejection(error)
            || B::isolated_rejection(error)
    }
}

// These publications may have written metadata before a business CAS rejects.
// Only a successful local rollback permits returning that typed rejection.
pub(in crate::owner) fn creation_sql<T, R>(
    connection: &rusqlite::Connection,
    execute: impl FnOnce() -> Result<Prepared<T>, StoreError>,
    rejected: impl FnOnce(&StoreError) -> Option<R>,
) -> Result<Result<Prepared<T>, R>, StoreError> {
    connection.execute_batch("SAVEPOINT agent_creation_publication")?;
    match execute() {
        Ok(value) => {
            connection.execute_batch("RELEASE agent_creation_publication")?;
            Ok(Ok(value))
        }
        Err(cause) => match rejected(&cause) {
            Some(rejection) => {
                connection.execute_batch("ROLLBACK TO agent_creation_publication; RELEASE agent_creation_publication")
                    .map_err(|cleanup| StoreError::RollbackFailed { cause: Arc::new(cause), cleanup })?;
                Ok(Err(rejection))
            }
            None => Err(cause),
        },
    }
}
pub(in crate::owner) fn rejection_cause(error: &StoreError) -> &StoreError {
    match error {
        StoreError::Shared(cause) | StoreError::StatementRejected { cause, .. } => {
            rejection_cause(cause)
        }
        error => error,
    }
}
pub(in crate::owner) fn creation_rejection(error: &StoreError) -> Option<Rejection> {
    use maka_event_log::root_store::CreationRejection;
    match rejection_cause(error) {
        StoreError::Project(_) => Some(Rejection::WorkspaceUnavailable),
        StoreError::SessionNotFound
        | StoreError::SessionRetired
        | StoreError::SessionConflict
        | StoreError::SessionCreationRejected(
            CreationRejection::MissingDependency
            | CreationRejection::Retired
            | CreationRejection::IdentityConflict
            | CreationRejection::SourceRevisionConflict { .. },
        ) => Some(Rejection::SessionUnavailable),
        StoreError::SessionCreationRejected(
            CreationRejection::MissingWorkspaceBinding | CreationRejection::StaleWorkspaceBinding,
        ) => Some(Rejection::WorkspaceUnavailable),
        StoreError::SessionBusy
        | StoreError::RevisionConflict { .. }
        | StoreError::SessionRevisionConflict { .. }
        | StoreError::EventConflict => Some(Rejection::Busy),
        StoreError::InvalidTransition(reason)
            if matches!(
                reason.as_str(),
                "prepared workspace binding changed" | "prepared project identity changed"
            ) =>
        {
            Some(Rejection::WorkspaceUnavailable)
        }
        _ => None,
    }
}
