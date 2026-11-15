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

use super::send::{PreparedAgentSend, PreparedSend};
use super::*;
use maka_agent_facts::{
    durable::UnixMillis,
    room::{RoomAuthor, RoomDelivery},
};
use maka_agent_state::{
    artifacts::{ArtifactStore, CopyArtifact, SessionScope},
    room::{Post, RoomStore},
};
use maka_event_log::{
    StoreError,
    writeback::{Prepared, Statement},
};

impl Owner {
    pub(super) fn message_writer(
        &self,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<maka_event_log::root_store::DataWriter, String> {
        match scope.identity.agent() {
            Some(execution) => {
                let custody = scope.work_custody().ok_or("agent_work_custody_required")?;
                self.store
                    .data_writer_for_work(custody.as_ref(), &execution.session_id)
            }
            None => self.store.data_writer(),
        }
        .map_err(|error| error.to_string())
    }

    pub(crate) fn rooms(&self) -> Result<RoomStore, String> {
        Ok(RoomStore::new(
            self.store
                .data_writer()
                .map_err(|error| error.to_string())?,
            self.run_owner(),
        ))
    }

    pub(super) async fn send_room(
        self: &Arc<Self>,
        mut input: Send,
        operation: &maka_plugin_core::operation::RecoveryRef,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<NativeMutation<SendResult>, String> {
        let session = self.scoped_session(scope, &input.session_id).await?;
        if session.archived {
            return Err("agent_session_unavailable".into());
        }
        if input.message.trim().is_empty() && input.attachments.is_empty() {
            return Err("agent_message_invalid".into());
        }
        let writer = self.message_writer(scope)?;
        let room = RoomStore::new(writer.clone(), self.run_owner());
        let message_id = format!("m_{}", self.operation_id(operation));
        let author = scope
            .identity
            .agent()
            .map_or(RoomAuthor::Human, |execution| RoomAuthor::Session {
                execution: execution.clone(),
            });
        let mut content: MessageInput = input.message.clone().into();
        content.attachments = self
            .attachment_refs(&input.session_id, input.attachments.clone(), scope)
            .await?;
        let replied = match &input.reply_to {
            Some(id) => Some(
                room.get(&input.session_id, id)
                    .await
                    .map_err(|error| error.to_string())?
                    .ok_or("agent_room_reply_unavailable")?,
            ),
            None => None,
        };
        let artifacts = ArtifactStore::new(writer.clone());
        let mut sources = Vec::new();
        for id in &input.attachments {
            sources.push(
                artifacts
                    .copy_source(
                        SessionScope {
                            owner: self.run_owner(),
                            session: input.session_id.clone(),
                        },
                        id.clone(),
                    )
                    .await
                    .map_err(|error| error.to_string())?
                    .ok_or("agent_attachment_unavailable")?,
            );
        }
        let mut forwarded = content.clone();
        if let Some(replied) = &replied {
            forwarded.quotes = Some(vec![maka_agent_facts::input::QuoteRef {
                text: replied.content.text.clone(),
                label: Some(format!(
                    "Reply to {} · {}",
                    match &replied.author {
                        RoomAuthor::Human => "Human",
                        RoomAuthor::Session { execution } => &execution.session_id,
                    },
                    replied.id
                )),
                source_turn_id: None,
                source: None,
            }]);
        }
        let origin = MessageOrigin::Room {
            session_id: input.session_id.clone(),
            message_id: message_id.clone(),
            author: author.clone(),
            reply_to: input.reply_to.clone(),
        };
        let mut seen = std::collections::HashSet::new();
        input
            .mentions
            .retain(|session| seen.insert(session.clone()));
        let mut deliveries = Vec::with_capacity(input.mentions.len());
        let mut targets = Vec::with_capacity(input.mentions.len());
        let at = now();
        for target in &input.mentions {
            let admission = async {
                let key = self.send_key(operation, target);
                let copies: Vec<_> = sources
                    .iter()
                    .enumerate()
                    .map(|(index, source)| {
                        CopyArtifact::new(
                            source.clone(),
                            SessionScope {
                                owner: self.run_owner(),
                                session: target.clone(),
                            },
                            format!("{key}_attachment_{index}"),
                            at,
                        )
                    })
                    .collect();
                let mut forwarded = forwarded.clone();
                for (attachment, copy) in forwarded.attachments.iter_mut().flatten().zip(&copies) {
                    attachment.storage_ref =
                        maka_agent_facts::attachment::StorageRef::SessionFile {
                            session_id: target.clone(),
                            relative_path: copy.artifact().id.clone(),
                        };
                }
                let admission = self
                    .prepare_agent_send(
                        Send {
                            session_id: target.clone(),
                            message: input.message.clone(),
                            attachments: Vec::new(),
                            backend: input.backend.clone(),
                            delivery: input.delivery,
                            expected_run_id: input.expected_run_id,
                            on_complete: input.on_complete,
                            mentions: Vec::new(),
                            reply_to: None,
                        },
                        forwarded,
                        Some(origin.clone()),
                        &key,
                        operation,
                        scope,
                    )
                    .await?;
                Ok((admission, copies))
            }
            .await;
            match admission {
                Ok((
                    PreparedSend::Ready {
                        value: SendResult::Queued { message_id, .. },
                        statement,
                    },
                    copies,
                )) => {
                    targets.push((
                        deliveries.len(),
                        RoomTarget {
                            admission: *statement,
                            copies,
                            artifacts: artifacts.clone(),
                            writer: writer.clone(),
                        },
                    ));
                    deliveries.push(RoomDelivery::Accepted {
                        session_id: target.clone(),
                        message_id,
                    });
                }
                Ok((PreparedSend::Returned(SendResult::Rejected { reason, .. }), _)) => deliveries
                    .push(RoomDelivery::Rejected {
                        session_id: target.clone(),
                        reason: match reason {
                            SendRejection::ModelUnavailable => "agent_model_unavailable",
                            SendRejection::SkillsUnavailable => "agent_skills_unavailable",
                            SendRejection::TurnStopped => "agent_turn_stopped",
                            SendRejection::OriginalOperationUnsettled => {
                                "agent_original_operation_unsettled"
                            }
                        }
                        .into(),
                    }),
                Ok((PreparedSend::Returned(SendResult::NotYourWorker { .. }), _)) => deliveries
                    .push(RoomDelivery::Rejected {
                        session_id: target.clone(),
                        reason: "agent_not_your_worker".into(),
                    }),
                Ok(_) => return Err("agent_room_delivery_invalid".into()),
                Err(reason) => deliveries.push(RoomDelivery::Rejected {
                    session_id: target.clone(),
                    reason,
                }),
            }
        }
        let post = Post {
            session: input.session_id,
            id: message_id,
            at: UnixMillis(at.try_into().map_err(|_| "invalid clock")?),
            author,
            content,
            reply_to: input.reply_to,
            mentions: input.mentions,
            deliveries,
        };
        let change = writer
            .prepare_result(|_| {
                Ok(RoomPost {
                    room,
                    post,
                    targets,
                })
            })
            .map_err(|error| error.to_string())?;
        Ok(NativeMutation::Computed { change })
    }
}

struct RoomPost {
    room: RoomStore,
    post: Post,
    targets: Vec<(usize, RoomTarget)>,
}

impl Statement for RoomPost {
    type Value = SendResult;
    type Output = SendResult;

    fn retain(&self) -> Vec<Arc<dyn std::marker::Send + Sync>> {
        self.targets
            .iter()
            .flat_map(|(_, statement)| statement.retain())
            .collect()
    }

    fn execute(
        mut self,
        connection: &rusqlite::Connection,
    ) -> Result<Prepared<Self::Value>, StoreError> {
        let mut notification = maka_event_log::writeback::Notification::NONE;
        let mut changed = false;
        for (index, statement) in self.targets {
            let admitted = creation::creation_sql(
                connection,
                || statement.execute(connection),
                |error| RoomTarget::isolated_rejection(error).then(|| error.to_string()),
            )?;
            match admitted {
                Ok(queued) => {
                    changed |= queued.changed;
                    notification = notification.combine(queued.notification);
                }
                Err(reason) => {
                    self.post.deliveries[index] = RoomDelivery::Rejected {
                        session_id: self.post.deliveries[index].session_id().to_owned(),
                        reason,
                    };
                }
            }
        }
        let session_id = self.post.session.clone();
        let posted = self.room.post_statement(self.post).execute(connection)?;
        Ok(Prepared {
            value: SendResult::Posted {
                session_id,
                message_id: posted.value.id,
                deliveries: posted.value.deliveries,
            },
            changed: changed || posted.changed,
            notification: notification.combine(posted.notification),
        })
    }

    fn committed(value: Self::Value) -> Self::Output {
        value
    }

    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::InvalidTransition(_) | StoreError::SessionNotFound
        )
    }
}

struct RoomTarget {
    admission: PreparedAgentSend,
    copies: Vec<CopyArtifact>,
    artifacts: ArtifactStore,
    writer: maka_event_log::root_store::DataWriter,
}

impl Statement for RoomTarget {
    type Value = maka_agent_state::queue::QueueCommit;
    type Output = Self::Value;

    fn retain(&self) -> Vec<Arc<dyn std::marker::Send + Sync>> {
        let mut retained = self.admission.retain();
        for copy in &self.copies {
            retained.extend(
                self.artifacts
                    .copy_statement(copy.clone(), &self.writer)
                    .retain(),
            );
        }
        retained
    }

    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<Prepared<Self::Value>, StoreError> {
        let mut changed = false;
        let mut notification = maka_event_log::writeback::Notification::NONE;
        for copy in self.copies {
            let copied = self
                .artifacts
                .copy_statement(copy, &self.writer)
                .execute(connection)?;
            changed |= copied.changed;
            notification = notification.combine(copied.notification);
        }
        let mut admitted = self.admission.execute(connection)?;
        admitted.changed |= changed;
        admitted.notification = admitted.notification.combine(notification);
        Ok(admitted)
    }

    fn committed(value: Self::Value) -> Self::Output {
        value
    }

    fn isolated_rejection(error: &StoreError) -> bool {
        PreparedAgentSend::isolated_rejection(error)
    }
}
