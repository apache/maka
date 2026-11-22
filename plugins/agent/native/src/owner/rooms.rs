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
    artifact::ArtifactSource,
    attachment::{AttachmentKind, AttachmentRef, StorageRef},
    durable::{RequestSpec, UnixMillis},
    input::{RunInput, SessionReferenceKind, extract_session_references},
    message::RootSourceMessage,
    read::ResourceAddress,
    room::{RoomActor, RoomAuthor, RoomDelivery, RoomMember, RoomMessage},
};
use maka_agent_state::{
    artifacts::{ArtifactStore, CopyArtifact, CopySource, SessionScope},
    room::{Post, RoomContextSnapshot, RoomStore},
};
use maka_event_log::{
    StoreError,
    writeback::{Prepared, Statement},
};
use std::collections::{HashMap, HashSet};

/// Maximum consecutive Agent-to-Agent mention hops inside a Room before requiring human input.
pub(crate) const MAX_ROOM_AGENT_HOPS: u8 = 6;
const RECENT_CONTEXT_MESSAGES: u32 = 6;

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

    pub async fn room_state(
        self: &Arc<Self>,
        input: RoomStateRead,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<RoomStateView, String> {
        self.scoped_session(scope, &input.session_id).await?;
        let state = self
            .rooms()?
            .state(&input.session_id)
            .await
            .map_err(|error| error.to_string())?;
        Ok(state.into())
    }

    pub async fn room_search(
        self: &Arc<Self>,
        input: RoomSearchRead,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<RoomSearchResult, String> {
        self.scoped_session(scope, &input.session_id).await?;
        let matches = self
            .rooms()?
            .search(&input.session_id, input.query, input.limit.unwrap_or(32))
            .await
            .map_err(|error| error.to_string())?;
        Ok(RoomSearchResult {
            items: matches
                .into_iter()
                .map(|m| RoomSearchMatchView {
                    message: m.message.into(),
                    snippet: m.snippet,
                })
                .collect(),
        })
    }

    pub async fn room_manage(
        self: &Arc<Self>,
        input: RoomManage,
        _operation: &maka_plugin_core::operation::RecoveryRef,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<NativeMutation<RoomManageResult>, String> {
        self.room_manage_mapped(input, scope, |result| result).await
    }

    pub(super) async fn room_manage_mapped<T: serde::Serialize + std::marker::Send + 'static>(
        self: &Arc<Self>,
        input: RoomManage,
        scope: &maka_capabilities::call::Scope,
        map: impl FnOnce(RoomManageResult) -> T + std::marker::Send + 'static,
    ) -> Result<NativeMutation<T>, String> {
        let session = self.scoped_session(scope, &input.session_id).await?;
        if session.archived {
            return Err("agent_session_unavailable".into());
        }
        if !self
            .rooms()?
            .exists(&input.session_id)
            .await
            .map_err(|error| error.to_string())?
        {
            return Err("agent_room_message_required".into());
        }
        let writer = self.message_writer(scope)?;
        let room = RoomStore::new(writer.clone(), self.run_owner());
        let actor = scope
            .identity
            .agent()
            .map_or(RoomActor::Human, |execution| RoomActor::Session {
                session_id: execution.session_id.clone(),
            });
        let at = UnixMillis(now().try_into().map_err(|_| "invalid clock")?);

        match input.action {
            RoomManageAction::SetTopic { topic } => {
                let statement = room.set_topic_statement(input.session_id, topic);
                let change = writer
                    .prepare_result(move |_| {
                        Ok(MapStmt(statement, move |topic| {
                            map(RoomManageResult::TopicUpdated { topic })
                        }))
                    })
                    .map_err(|error| error.to_string())?;
                Ok(NativeMutation::Computed { change })
            }
            RoomManageAction::AddMembers { member_session_ids } => {
                let mut seen = HashSet::new();
                let deduped: Vec<String> = member_session_ids
                    .into_iter()
                    .filter(|id| seen.insert(id.clone()))
                    .collect();
                for id in &deduped {
                    self.scoped_session(scope, id).await?;
                }
                let statement = room.add_members_statement(input.session_id, deduped, at);
                let change = writer
                    .prepare_result(move |_| {
                        Ok(MapStmt(statement, move |added| {
                            map(RoomManageResult::MembersAdded { added })
                        }))
                    })
                    .map_err(|error| error.to_string())?;
                Ok(NativeMutation::Computed { change })
            }
            RoomManageAction::RemoveMembers { member_session_ids } => {
                let mut seen = HashSet::new();
                let deduped: Vec<String> = member_session_ids
                    .into_iter()
                    .filter(|id| seen.insert(id.clone()))
                    .collect();
                let statement = room.remove_members_statement(input.session_id, deduped);
                let change = writer
                    .prepare_result(move |_| {
                        Ok(MapStmt(statement, move |removed| {
                            map(RoomManageResult::MembersRemoved { removed })
                        }))
                    })
                    .map_err(|error| error.to_string())?;
                Ok(NativeMutation::Computed { change })
            }
            RoomManageAction::React {
                message_id,
                emoji,
                add,
            } => {
                let msg_id_out = message_id.clone();
                let emoji_out = emoji.trim().to_owned();
                let statement =
                    room.react_statement(input.session_id, message_id, actor, emoji, add, at);
                let change = writer
                    .prepare_result(move |_| {
                        Ok(MapStmt(statement, move |present| {
                            map(RoomManageResult::ReactionUpdated {
                                message_id: msg_id_out,
                                emoji: emoji_out,
                                present,
                            })
                        }))
                    })
                    .map_err(|error| error.to_string())?;
                Ok(NativeMutation::Computed { change })
            }
            RoomManageAction::Pin { message_id } => {
                let msg_id_out = message_id.clone();
                let statement = room.pin_statement(input.session_id, message_id, true, at);
                let change = writer
                    .prepare_result(move |_| {
                        Ok(MapStmt(statement, move |pinned| {
                            map(RoomManageResult::PinUpdated {
                                message_id: msg_id_out,
                                pinned,
                            })
                        }))
                    })
                    .map_err(|error| error.to_string())?;
                Ok(NativeMutation::Computed { change })
            }
            RoomManageAction::Unpin { message_id } => {
                let msg_id_out = message_id.clone();
                let statement = room.pin_statement(input.session_id, message_id, false, at);
                let change = writer
                    .prepare_result(move |_| {
                        Ok(MapStmt(statement, move |pinned| {
                            map(RoomManageResult::PinUpdated {
                                message_id: msg_id_out,
                                pinned,
                            })
                        }))
                    })
                    .map_err(|error| error.to_string())?;
                Ok(NativeMutation::Computed { change })
            }
            RoomManageAction::EditMessage { message_id, text } => {
                let statement =
                    room.edit_message_statement(input.session_id, message_id, actor, text, at);
                let change = writer
                    .prepare_result(move |_| {
                        Ok(MapStmt(statement, move |message: RoomMessage| {
                            map(RoomManageResult::MessageUpdated {
                                message: Box::new(message.into()),
                            })
                        }))
                    })
                    .map_err(|error| error.to_string())?;
                Ok(NativeMutation::Computed { change })
            }
            RoomManageAction::DeleteMessage { message_id } => {
                let statement =
                    room.delete_message_statement(input.session_id, message_id, actor, at);
                let change = writer
                    .prepare_result(move |_| {
                        Ok(MapStmt(statement, move |message: RoomMessage| {
                            map(RoomManageResult::MessageUpdated {
                                message: Box::new(message.into()),
                            })
                        }))
                    })
                    .map_err(|error| error.to_string())?;
                Ok(NativeMutation::Computed { change })
            }
        }
    }

    async fn caller_room_hop(&self, caller_session: &str, room_id: &str) -> Option<u8> {
        let view = self.latest_session_run(caller_session).await.ok()??;
        let mut latest_hop = None;
        let record_source = |source: &RootSourceMessage, latest: &mut Option<u8>| {
            if let Some(MessageOrigin::Room {
                session_id,
                hop_count,
                ..
            }) = &source.message.origin
                && session_id == room_id
            {
                *latest = Some(hop_count.unwrap_or(0));
            }
        };
        if let Ok(raw) = self
            .durable
            .content(view.run, view.spec.input.clone())
            .await
            && let Ok(RunInput::Message {
                source_messages, ..
            }) = serde_json::from_slice::<RunInput>(&raw)
        {
            for source in &source_messages {
                record_source(source, &mut latest_hop);
            }
        }
        // Also scan steering messages consumed mid-run (chronological by StepId) so steered
        // Agent-to-Agent mentions increment the hop counter and steered human mentions reset it.
        for step_ref in view.steps.values() {
            let Ok(step_bytes) = self.durable.content(view.run, step_ref.clone()).await else {
                continue;
            };
            let Ok(step_spec) = serde_json::from_slice::<RequestSpec>(&step_bytes) else {
                continue;
            };
            for steer_ref in &step_spec.steering {
                let Ok(steer_bytes) = self.durable.content(view.run, steer_ref.clone()).await
                else {
                    continue;
                };
                if let Ok(source) = serde_json::from_slice::<RootSourceMessage>(&steer_bytes) {
                    record_source(&source, &mut latest_hop);
                }
            }
        }
        if let Some(ext_steer) = view.external.as_ref().and_then(|t| t.steering.as_ref())
            && let Ok(spec_bytes) = self
                .durable
                .content(view.run, ext_steer.descriptor.clone())
                .await
            && let Ok(spec) = serde_json::from_slice::<
                maka_agent_state::external_steering::ExternalSteeringSpec,
            >(&spec_bytes)
        {
            for src in &spec.sources {
                if let Ok(src_bytes) = self.durable.content(view.run, src.source.clone()).await
                    && let Ok(source) = serde_json::from_slice::<RootSourceMessage>(&src_bytes)
                {
                    record_source(&source, &mut latest_hop);
                }
            }
        }
        latest_hop
    }

    async fn resolve_room_attachments(
        &self,
        room_id: &str,
        ids: &[String],
        operation: &maka_plugin_core::operation::RecoveryRef,
        at: u64,
        scope: &maka_capabilities::call::Scope,
        artifacts: &ArtifactStore,
    ) -> Result<
        (
            Option<Vec<AttachmentRef>>,
            Vec<CopySource>,
            Vec<CopyArtifact>,
        ),
        String,
    > {
        if ids.is_empty() {
            return Ok((None, Vec::new(), Vec::new()));
        }
        let mut seen = std::collections::BTreeSet::new();
        let mut refs = Vec::with_capacity(ids.len());
        let mut sources = Vec::with_capacity(ids.len());
        let mut room_copies = Vec::new();
        let caller_session = scope.identity.agent().map(|e| e.session_id.as_str());
        let op_id = self.operation_id(operation);

        for (index, id) in ids.iter().enumerate() {
            if maka_agent_facts::interaction::entity_id(id).is_err() || !seen.insert(id.clone()) {
                return Err("agent_attachments_invalid".into());
            }
            // Prefer an upload already stored on the Room; for Agent callers, also accept
            // attachments from the caller's own Session and copy them into the Room.
            let room_scope = SessionScope {
                owner: self.run_owner(),
                session: room_id.to_owned(),
            };
            if let Some(source) = artifacts
                .copy_source(room_scope.clone(), id.clone())
                .await
                .map_err(|error| error.to_string())?
                .filter(|s| s.record().artifact.source == ArtifactSource::UserUpload)
            {
                let art = &source.record().artifact;
                let mime_type = art
                    .mime_type
                    .clone()
                    .ok_or("agent_attachment_unavailable")?;
                let attachment = AttachmentRef {
                    kind: AttachmentKind::from_metadata(&mime_type, &art.name),
                    name: art.name.clone(),
                    mime_type,
                    bytes: art.size_bytes,
                    storage_ref: StorageRef::SessionFile {
                        session_id: room_id.to_owned(),
                        relative_path: id.clone(),
                    },
                };
                art.validate_attachment(&attachment)
                    .map_err(|_| "agent_attachment_invalid")?;
                refs.push(attachment);
                sources.push(source);
                continue;
            }
            let Some(caller_id) = caller_session else {
                return Err("agent_attachment_unavailable".into());
            };
            let caller_scope = SessionScope {
                owner: self.run_owner(),
                session: caller_id.to_owned(),
            };
            let source = artifacts
                .copy_source(caller_scope, id.clone())
                .await
                .map_err(|error| error.to_string())?
                .filter(|s| s.record().artifact.source == ArtifactSource::UserUpload)
                .ok_or("agent_attachment_unavailable")?;
            let art = &source.record().artifact;
            let mime_type = art
                .mime_type
                .clone()
                .ok_or("agent_attachment_unavailable")?;
            let room_copy_key = format!("{op_id}_room_att_{index}");
            let copy = CopyArtifact::new(source.clone(), room_scope, room_copy_key, at);
            let attachment = AttachmentRef {
                kind: AttachmentKind::from_metadata(&mime_type, &art.name),
                name: art.name.clone(),
                mime_type,
                bytes: art.size_bytes,
                storage_ref: StorageRef::SessionFile {
                    session_id: room_id.to_owned(),
                    relative_path: copy.artifact().id.clone(),
                },
            };
            copy.artifact()
                .validate_attachment(&attachment)
                .map_err(|_| "agent_attachment_invalid")?;
            refs.push(attachment);
            sources.push(source);
            room_copies.push(copy);
        }
        Ok((Some(refs), sources, room_copies))
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
        if !input.quotes.is_empty() {
            return Err("agent_room_quotes_unsupported".into());
        }
        if input.backend.is_some() {
            return Err("agent_room_has_no_backend".into());
        }
        if input.expected_run_id.is_some() {
            return Err("agent_room_expected_run_unsupported".into());
        }
        if input.message.trim().is_empty() && input.attachments.is_empty() {
            return Err("agent_message_invalid".into());
        }
        let writer = self.message_writer(scope)?;
        let room = RoomStore::new(writer.clone(), self.run_owner());
        let message_id = format!("m_{}", self.operation_id(operation));
        let caller_agent = scope.identity.agent();
        let author = caller_agent.map_or(RoomAuthor::Human, |execution| RoomAuthor::Session {
            execution: execution.clone(),
        });

        // Merge explicit mentions with inline [@Name](maka://session/<id>) tokens from the body.
        // Plain [Name](maka://session/<id>) links and '#' room links stay navigable references without waking Agents.
        for reference in extract_session_references(&input.message) {
            if reference.kind == SessionReferenceKind::Conversation
                && reference.explicit_mention
                && reference.session_id != input.session_id
            {
                input.mentions.push(reference.session_id);
            }
        }
        let mut seen = HashSet::new();
        input
            .mentions
            .retain(|session| seen.insert(session.clone()));

        let at = now();
        let artifacts = ArtifactStore::new(writer.clone());
        let (attachment_refs, sources, room_copies) = self
            .resolve_room_attachments(
                &input.session_id,
                &input.attachments,
                operation,
                at,
                scope,
                &artifacts,
            )
            .await?;
        let mut content: MessageInput = input.message.clone().into();
        content.attachments = attachment_refs;

        let replied = match &input.reply_to {
            Some(id) => Some(
                room.get(&input.session_id, id)
                    .await
                    .map_err(|error| error.to_string())?
                    .ok_or("agent_room_reply_unavailable")?,
            ),
            None => None,
        };

        // Only inspect durable steps for Agent-to-Agent hop count when this post actually wakes recipients.
        let hop_count = if input.mentions.is_empty() {
            None
        } else {
            match caller_agent {
                None => Some(0),
                Some(execution) => Some(
                    self.caller_room_hop(&execution.session_id, &input.session_id)
                        .await
                        .map_or(1, |prev| prev.saturating_add(1)),
                ),
            }
        };
        let hop_limit_exceeded = hop_count.is_some_and(|h| h > MAX_ROOM_AGENT_HOPS);

        // Fetch compact Room context once so every mentioned Agent wakes up already oriented.
        let context_snapshot = if !input.mentions.is_empty() {
            let mut extra = input.mentions.clone();
            if let Some(exec) = caller_agent {
                extra.push(exec.session_id.clone());
            }
            if let Some(replied) = &replied
                && let RoomAuthor::Session { execution } = &replied.author
            {
                extra.push(execution.session_id.clone());
            }
            Some(
                room.context_snapshot(&input.session_id, RECENT_CONTEXT_MESSAGES, extra)
                    .await
                    .map_err(|error| error.to_string())?,
            )
        } else {
            None
        };

        let names: HashMap<&str, &RoomMember> = context_snapshot
            .as_ref()
            .map(|snap| {
                snap.members
                    .iter()
                    .map(|m| (m.session_id.as_str(), m))
                    .collect()
            })
            .unwrap_or_default();

        let mut base_forwarded = content.clone();
        base_forwarded.display_text = Some(input.message.clone());
        if let Some(replied) = &replied {
            let replied_author = match &replied.author {
                RoomAuthor::Human => "Human".to_owned(),
                RoomAuthor::Session { execution } => names
                    .get(execution.session_id.as_str())
                    .map(|m| format!("{} ({})", m.title, execution.session_id))
                    .unwrap_or_else(|| execution.session_id.clone()),
            };
            let quote_text = if replied.deleted_at.is_some() {
                "[Deleted message]".to_owned()
            } else if !replied.content.text.trim().is_empty() {
                replied.content.text.clone()
            } else if let Some(atts) = &replied.content.attachments
                && !atts.is_empty()
            {
                let att_list = atts
                    .iter()
                    .map(|a| format_room_attachment_ref(&input.session_id, a))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("[Attachments: {att_list}]")
            } else {
                String::new()
            };
            if !quote_text.is_empty() {
                base_forwarded.quotes = Some(vec![maka_agent_facts::input::QuoteRef {
                    text: quote_text,
                    label: Some(format!("Reply to {replied_author} · {}", replied.id)),
                    source_turn_id: None,
                    source_message_id: Some(replied.id.clone()),
                    source: None,
                }]);
            }
        }

        let origin = MessageOrigin::Room {
            session_id: input.session_id.clone(),
            message_id: message_id.clone(),
            author: author.clone(),
            reply_to: input.reply_to.clone(),
            mentions: input.mentions.clone(),
            hop_count,
        };
        // Room mentions default to Steer (injecting cleanly at the next step boundary without
        // aborting in-flight tool work), matching direct conversations so long-running Agents stay
        // responsive in collaborative Rooms. Callers may pass Queue to wait until the active turn ends.
        let effective_delivery = input.delivery.unwrap_or(SendDelivery::Steer);

        let mut deliveries = Vec::with_capacity(input.mentions.len());
        let mut targets = Vec::with_capacity(input.mentions.len());
        let room_title = session.configuration.title.clone();
        let room_workspace = session.configuration.workspace.path.clone();

        for target in &input.mentions {
            if caller_agent.is_some_and(|exec| exec.session_id == *target) {
                deliveries.push(RoomDelivery::Rejected {
                    session_id: target.clone(),
                    reason: "agent_room_self_mention".into(),
                });
                continue;
            }
            if hop_limit_exceeded {
                deliveries.push(RoomDelivery::Rejected {
                    session_id: target.clone(),
                    reason: "agent_room_hop_limit_reached".into(),
                });
                continue;
            }
            // Pre-flight check: reject targets whose explicit tool allowlist forbids SessionSend
            // so we don't burn tokens waking an Agent that cannot post back to the Room.
            if let Ok(target_session) = self.scoped_session(scope, target).await
                && let Some(allowed) = &target_session.configuration.tools
                && !allowed.iter().any(|t| t == "SessionSend")
            {
                deliveries.push(RoomDelivery::Rejected {
                    session_id: target.clone(),
                    reason: "agent_room_reply_tool_unavailable".into(),
                });
                continue;
            }

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
                let mut forwarded = base_forwarded.clone();
                if let Some(snap) = &context_snapshot {
                    let envelope = build_room_context_envelope(
                        &input.session_id,
                        &room_title,
                        &room_workspace,
                        snap,
                        target,
                        &input.mentions,
                        &names,
                    );
                    if !envelope.is_empty() {
                        forwarded.text = format!("{envelope}\n\n{}", forwarded.text);
                    }
                }
                for (attachment, copy) in forwarded.attachments.iter_mut().flatten().zip(&copies) {
                    attachment.storage_ref = StorageRef::SessionFile {
                        session_id: target.clone(),
                        relative_path: copy.artifact().id.clone(),
                    };
                }
                let send_for_target = |delivery| Send {
                    session_id: target.clone(),
                    message: forwarded.text.clone(),
                    attachments: Vec::new(),
                    quotes: Vec::new(),
                    backend: None,
                    delivery: Some(delivery),
                    expected_run_id: None,
                    on_complete: input.on_complete,
                    mentions: Vec::new(),
                    reply_to: None,
                };
                let mut admission = self
                    .prepare_agent_send(
                        send_for_target(effective_delivery),
                        forwarded.clone(),
                        Some(origin.clone()),
                        &key,
                        operation,
                        scope,
                    )
                    .await?;
                // If default Steer raced with the target Run completing, immediately fall back
                // to Queue so the finished Agent starts a fresh turn cleanly instead of dropping.
                if matches!(effective_delivery, SendDelivery::Steer)
                    && matches!(
                        admission,
                        PreparedSend::Returned(SendResult::Rejected {
                            reason: SendRejection::TurnStopped,
                            ..
                        })
                    )
                    && self
                        .latest_session_run(target)
                        .await
                        .ok()
                        .flatten()
                        .is_none_or(|view| view.terminal.is_some())
                {
                    admission = self
                        .prepare_agent_send(
                            send_for_target(SendDelivery::Queue),
                            forwarded,
                            Some(origin.clone()),
                            &key,
                            operation,
                            scope,
                        )
                        .await?;
                }
                Ok((admission, copies))
            }
            .await;
            match admission {
                Ok((
                    PreparedSend::Ready {
                        value: SendResult::Queued { message_id, .. },
                        mut statement,
                        ..
                    },
                    copies,
                )) => {
                    // A multi-target post settles under each target's SQL fence. Never
                    // retain one session mutex while preparing another target.
                    if input.mentions.len() > 1 {
                        statement.order = None;
                    }
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
                    room_copies,
                    artifacts,
                    writer: writer.clone(),
                    targets,
                })
            })
            .map_err(|error| error.to_string())?;
        Ok(NativeMutation::Computed { change })
    }
}

pub(crate) fn format_room_attachment_ref(room_id: &str, att: &AttachmentRef) -> String {
    let path = match &att.storage_ref {
        StorageRef::SessionFile {
            session_id,
            relative_path,
        } => ResourceAddress::SessionAttachment {
            session_id: session_id.clone(),
            attachment_id: relative_path.clone(),
        }
        .canonical_path()
        .ok(),
        _ => None,
    };
    match path {
        Some(uri) => format!(
            "{} ({}, {} B, Read path: {uri})",
            att.name, att.mime_type, att.bytes
        ),
        None => format!(
            "{} ({}, {} B in {room_id})",
            att.name, att.mime_type, att.bytes
        ),
    }
}

fn format_member_tag(member: &RoomMember, target_id: &str) -> String {
    let mut out = format!("{} ({})", member.title, member.session_id);
    if let Some(preset) = &member.preset_name {
        out.push_str(&format!(" [preset: {preset}]"));
    }
    if member.session_id == target_id {
        out.push_str(" (you)");
    } else if member.unavailable {
        out.push_str(" (removed)");
    }
    out
}

fn format_author_label(
    author: &RoomAuthor,
    target_id: &str,
    names: &HashMap<&str, &RoomMember>,
) -> String {
    match author {
        RoomAuthor::Human => "Human".to_owned(),
        RoomAuthor::Session { execution } => match names.get(execution.session_id.as_str()) {
            Some(m) => {
                if execution.session_id == target_id {
                    format!("{} (you)", m.title)
                } else {
                    format!("{} ({})", m.title, execution.session_id)
                }
            }
            None => execution.session_id.clone(),
        },
    }
}

fn truncate_inline(text: &str, max_chars: usize) -> String {
    let collapsed = text.trim();
    if collapsed.chars().count() <= max_chars {
        collapsed.to_owned()
    } else {
        let mut s: String = collapsed.chars().take(max_chars).collect();
        s.push('…');
        s
    }
}

fn build_room_context_envelope(
    room_id: &str,
    room_title: &str,
    room_workspace: &str,
    snap: &RoomContextSnapshot,
    target_id: &str,
    mentions: &[String],
    names: &HashMap<&str, &RoomMember>,
) -> String {
    let mut out = String::from("<room_context>\n");
    out.push_str(&format!("Room: {room_title} (maka://session/{room_id})\n"));
    if !room_workspace.is_empty() {
        out.push_str(&format!("Workspace: {room_workspace}\n"));
    }
    if !snap.topic.is_empty() {
        out.push_str(&format!("Topic: {}\n", snap.topic));
    }

    // Co-mentions: tell the recipient who else was addressed in this exact post to avoid duplicate work.
    let co_mentions: Vec<String> = mentions
        .iter()
        .filter(|id| id.as_str() != target_id)
        .map(|id| match names.get(id.as_str()) {
            Some(m) => format_member_tag(m, target_id),
            None => id.clone(),
        })
        .collect();
    if !co_mentions.is_empty() {
        out.push_str(&format!(
            "Also mentioned in this message: {} (coordinate rather than duplicating work)\n",
            co_mentions.join(", ")
        ));
    }

    // Active Roster summary.
    let roster: Vec<String> = snap
        .members
        .iter()
        .filter(|m| !m.unavailable)
        .take(16)
        .map(|m| format_member_tag(m, target_id))
        .collect();
    if !roster.is_empty() {
        out.push_str(&format!("Participants: {}\n", roster.join(", ")));
    }

    if !snap.pinned.is_empty() {
        out.push_str("Pinned notes:\n");
        for pin in snap.pinned.iter().take(5) {
            let author = format_author_label(&pin.author, target_id, names);
            out.push_str(&format!(
                "- [{} · {}] {}\n",
                pin.id,
                author,
                truncate_inline(&pin.content.text, 240)
            ));
        }
    }

    if !snap.recent.is_empty() {
        out.push_str("Recent messages before this mention:\n");
        for post in &snap.recent {
            format_compact_post(&mut out, room_id, post, target_id, names);
        }
        if snap.has_earlier {
            out.push_str(&format!(
                "(Earlier messages exist; call Read({{\"path\":\"maka://session/{room_id}\"}}) or SessionRead to inspect older history.)\n"
            ));
        }
    }
    out.push_str("</room_context>");
    out
}

fn format_compact_post(
    out: &mut String,
    room_id: &str,
    post: &RoomMessage,
    target_id: &str,
    names: &HashMap<&str, &RoomMember>,
) {
    let author = format_author_label(&post.author, target_id, names);
    out.push_str(&format!(
        "- [#{} · {} · {}]",
        post.sequence, post.id, author
    ));
    if let Some(reply) = &post.reply_to {
        out.push_str(&format!(" (replyTo: {reply})"));
    }
    if !post.mentions.is_empty() {
        let mnames: Vec<String> = post
            .mentions
            .iter()
            .map(|id| match names.get(id.as_str()) {
                Some(m) => format!("@{}", m.title),
                None => format!("@{id}"),
            })
            .collect();
        out.push_str(&format!(" [{}]", mnames.join(" ")));
    }
    if post.deleted_at.is_some() {
        out.push_str(": (deleted)\n");
        return;
    }
    let body = truncate_inline(&post.content.text, 400);
    if !body.is_empty() {
        out.push_str(&format!(": {body}"));
    }
    if let Some(atts) = &post.content.attachments
        && !atts.is_empty()
    {
        let att_str = atts
            .iter()
            .map(|a| format_room_attachment_ref(room_id, a))
            .collect::<Vec<_>>()
            .join("; ");
        out.push_str(&format!(" [Attachments: {att_str}]"));
    }
    out.push('\n');
}

struct MapStmt<S, F>(S, F);

impl<S, F, O> Statement for MapStmt<S, F>
where
    S: Statement,
    F: FnOnce(S::Output) -> O + std::marker::Send + 'static,
    O: std::marker::Send + 'static,
{
    type Value = O;
    type Output = O;

    fn retain(&self) -> Vec<Arc<dyn std::marker::Send + Sync>> {
        self.0.retain()
    }

    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<Prepared<Self::Value>, StoreError> {
        let prepared = self.0.execute(connection)?;
        Ok(Prepared {
            value: (self.1)(S::committed(prepared.value)),
            changed: prepared.changed,
            notification: prepared.notification,
        })
    }

    fn committed(value: Self::Value) -> Self::Output {
        value
    }

    fn isolated_rejection(error: &StoreError) -> bool {
        S::isolated_rejection(error)
    }
}

struct RoomPost {
    room: RoomStore,
    post: Post,
    room_copies: Vec<CopyArtifact>,
    artifacts: ArtifactStore,
    writer: maka_event_log::root_store::DataWriter,
    targets: Vec<(usize, RoomTarget)>,
}

impl Statement for RoomPost {
    type Value = SendResult;
    type Output = SendResult;

    fn retain(&self) -> Vec<Arc<dyn std::marker::Send + Sync>> {
        let mut retained: Vec<_> = self
            .targets
            .iter()
            .flat_map(|(_, statement)| statement.retain())
            .collect();
        for copy in &self.room_copies {
            retained.extend(
                self.artifacts
                    .copy_statement(copy.clone(), &self.writer)
                    .retain(),
            );
        }
        retained
    }

    fn execute(
        mut self,
        connection: &rusqlite::Connection,
    ) -> Result<Prepared<Self::Value>, StoreError> {
        let mut notification = maka_event_log::writeback::Notification::NONE;
        let mut changed = false;
        for copy in self.room_copies {
            let copied = self
                .artifacts
                .copy_statement(copy, &self.writer)
                .execute(connection)?;
            changed |= copied.changed;
            notification = notification.combine(copied.notification);
        }
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
        let mut admitted = self.admission.execute_for_room(connection)?;
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
