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

//! Bot mode: one persistent Session per installation. The model reaches its user
//! only through `SendUser`; recorded messages form a Host-owned outbox kept apart
//! from Run state, so a crash neither loses nor repeats a delivered message.
use super::*;
use maka_agent_facts::{
    tool_call::ToolRejection,
    tool_output::{DurableToolProjection, ToolOutput, ToolSuccess},
    tools::*,
};
use maka_capabilities::storage::{Data, Mutation, Namespace, Store, StoreError};
use sha2::{Digest, Sha256};
use std::sync::{OnceLock, Weak};

pub(super) const SEND_USER: &str = "SendUser";
/// Agent-native coordination tools a Bot Session may use. Workspace service tools
/// (files, processes, browser, web) and MCP tools are never granted: hands-on work
/// is delegated to WorkHub workers, which keep their own permissions.
pub(super) const ALLOWED_TOOLS: &[&str] = &[
    SEND_USER,
    "ScheduledTask",
    "GoalStatus",
    "Recall",
    "RecallMaterial",
    "RecallMore",
    "todo_read",
    "todo_write",
    "workhub_tasks",
    "Skill",
    "SkillSearch",
];
/// Shortest interval schedule that may wake the Bot Session.
pub(super) const MIN_INTERVAL_SECONDS: u32 = 300;
const MAX_MESSAGES: usize = 100;
const MAX_CHARACTERS: usize = 48_000;
const MAX_MESSAGE_ID: usize = 200;
/// Calls retained for idempotency and reads; older calls are dropped oldest first.
const RETAINED_CALLS: usize = 1_000;
const PAGE: usize = 100;
const RECORD_KEY: &str = "bot";
const OUTBOX_KEY: &str = "outbox";

/// True when the Session's immutable tool allow-list grants `SendUser`, which only
/// [`Owner::open_bot`] can set.
pub(super) fn is_bot(allowed_tools: Option<&[String]>) -> bool {
    allowed_tools.is_some_and(|tools| tools.iter().any(|name| name == SEND_USER))
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    session_id: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Outbox {
    session_id: Option<String>,
    through: u64,
    calls: Vec<Call>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Call {
    message_id: String,
    fingerprint: String,
    messages: Vec<BotMessage>,
}

pub(super) enum Appended {
    Recorded(usize),
    Duplicate(usize),
}

pub(super) struct Bot {
    storage: Arc<maka_host_runtime::storage::Storage>,
    owner: OnceLock<Weak<Owner>>,
    changed: tokio::sync::watch::Sender<()>,
}
impl Bot {
    pub fn new(store: Arc<RootStore>, prefix: String) -> Self {
        Self {
            storage: Arc::new(maka_host_runtime::storage::Storage::new(
                store,
                prefix,
                Namespace::new("maka.bot", maka_plugin_core::scope::Scope::Profile)
                    .expect("bot namespace"),
            )),
            owner: OnceLock::new(),
            changed: tokio::sync::watch::channel(()).0,
        }
    }
    pub fn bind(&self, owner: &Arc<Owner>) {
        self.owner
            .set(Arc::downgrade(owner))
            .expect("bot bound once");
    }
    pub async fn finish(&self) -> Result<(), String> {
        self.storage.finish().await
    }
    pub fn tools(self: &Arc<Self>) -> Vec<ToolRegistration> {
        vec![ToolRegistration {
            definition: ToolDefinition {
                provider: None,
                name: SEND_USER.into(),
                description: "Send messages to your user. This is the only way the user sees anything from you; ordinary replies stay internal. Send only when something is worth the user's attention, and send nothing otherwise. Reuse the same messageId when retrying the same content.".into(),
                input_schema: serde_json::to_value(schemars::schema_for!(SendUserInput))
                    .expect("SendUser schema"),
                output_schema: None,
                freeform: None,
            },
            nesting: ToolNesting::DirectOnly,
            semantics: ToolSemantics::ExclusiveStep,
            handler: ToolHandler::Prepared(self.clone()),
        }]
    }
    async fn read<T: serde::de::DeserializeOwned>(
        &self,
        key: &str,
    ) -> Result<(Option<u64>, Option<T>), StoreError> {
        let record = self.storage.read(key.into()).await?;
        let revision = record.as_ref().map(|record| record.revision);
        let value = match record.and_then(|record| record.data.value().cloned()) {
            Some(value) => Some(
                serde_json::from_value(value)
                    .map_err(|error| StoreError::Unavailable(error.to_string()))?,
            ),
            None => None,
        };
        Ok((revision, value))
    }
    async fn write<T: Serialize>(
        &self,
        key: &str,
        expected: Option<u64>,
        value: &T,
    ) -> Result<(), StoreError> {
        self.storage
            .batch(vec![Mutation {
                key: key.into(),
                expected_revision: expected,
                data: Data::Present(
                    serde_json::to_value(value)
                        .map_err(|error| StoreError::Unavailable(error.to_string()))?,
                ),
            }])
            .await?;
        Ok(())
    }
    pub(super) async fn session(&self) -> Result<Option<String>, StoreError> {
        Ok(self
            .read::<Record>(RECORD_KEY)
            .await?
            .1
            .map(|record| record.session_id))
    }
    /// Append one `SendUser` call. A retried call with the same id and content is a
    /// duplicate; the same id with different content is rejected.
    pub(super) async fn append(
        &self,
        session: &str,
        message_id: &str,
        fingerprint: &str,
        texts: &[String],
        at: i64,
    ) -> Result<Appended, ToolError> {
        for _ in 0..8 {
            let (revision, outbox) = self.read::<Outbox>(OUTBOX_KEY).await.map_err(storage)?;
            let mut outbox = outbox.unwrap_or_default();
            if outbox.session_id.as_deref().is_some_and(|id| id != session) {
                // A replaced Bot Session starts a fresh outbox.
                outbox = Outbox::default();
            }
            if let Some(call) = outbox
                .calls
                .iter()
                .find(|call| call.message_id == message_id)
            {
                return if call.fingerprint == fingerprint {
                    Ok(Appended::Duplicate(call.messages.len()))
                } else {
                    Err(ToolError::Failed(
                        "messageId was already used with different content; choose a new messageId"
                            .into(),
                    ))
                };
            }
            let messages = texts
                .iter()
                .enumerate()
                .map(|(index, text)| BotMessage {
                    sequence: outbox.through + index as u64 + 1,
                    message_id: message_id.into(),
                    index: index as u32,
                    text: text.clone(),
                    at,
                })
                .collect::<Vec<_>>();
            outbox.through += messages.len() as u64;
            outbox.session_id = Some(session.into());
            outbox.calls.push(Call {
                message_id: message_id.into(),
                fingerprint: fingerprint.into(),
                messages,
            });
            let excess = outbox.calls.len().saturating_sub(RETAINED_CALLS);
            outbox.calls.drain(..excess);
            match self.write(OUTBOX_KEY, revision, &outbox).await {
                Ok(()) => {
                    self.changed.send_replace(());
                    return Ok(Appended::Recorded(texts.len()));
                }
                Err(StoreError::Conflict { .. }) => continue,
                Err(error) => return Err(storage(error)),
            }
        }
        Err(ToolError::Failed(
            "outbox is busy; retry with the same messageId".into(),
        ))
    }
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SendUserInput {
    /// Idempotency key you choose for this call; reuse it only to retry the same content.
    #[schemars(length(min = 1, max = 200))]
    message_id: String,
    /// One or more messages, shown to the user in order.
    #[schemars(length(min = 1, max = 100))]
    messages: Vec<SendUserMessage>,
}
#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct SendUserMessage {
    /// Markdown text shown to the user.
    #[schemars(length(min = 1))]
    text: String,
}

impl ToolPreparer for Bot {
    fn names(&self) -> Vec<String> {
        vec![SEND_USER.into()]
    }
    fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> PreparationFuture {
        let owner = self.owner.get().and_then(Weak::upgrade);
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(ToolRejection::Cancelled);
            }
            if name != SEND_USER {
                return Err(ToolRejection::Unavailable);
            }
            let owner = owner.ok_or(ToolRejection::Unavailable)?;
            let input: SendUserInput = serde_json::from_value(input).map_err(invalid)?;
            let message_id = input.message_id.trim().to_owned();
            if message_id.is_empty() || message_id.chars().count() > MAX_MESSAGE_ID {
                return Err(invalid("messageId must contain 1 to 200 characters"));
            }
            if input.messages.is_empty() || input.messages.len() > MAX_MESSAGES {
                return Err(invalid("messages must contain 1 to 100 items"));
            }
            if input
                .messages
                .iter()
                .any(|message| message.text.trim().is_empty())
            {
                return Err(invalid("every message needs non-empty text"));
            }
            let total: usize = input
                .messages
                .iter()
                .map(|message| message.text.chars().count())
                .sum();
            if total > MAX_CHARACTERS {
                return Err(invalid("messages exceed 48000 characters in total"));
            }
            let texts: Vec<String> = input
                .messages
                .into_iter()
                .map(|message| message.text)
                .collect();
            let fingerprint =
                hex::encode(Sha256::digest(serde_json::to_vec(&texts).map_err(invalid)?));
            owner
                .check_bot_invocation(&context)
                .await
                .map_err(|message| ToolRejection::PreparationFailed { message })?;
            Ok(PreparedEffect::new(move |cancellation| {
                Box::pin(async move {
                    if cancellation.is_cancelled() {
                        return Err(ToolError::Failed("SendUser call cancelled".into()));
                    }
                    let runs = owner.runs.lock().await;
                    if runs.closing {
                        return Err(ToolError::Failed("SendUser unavailable".into()));
                    }
                    let captured = owner.clone();
                    let job = owner.workers.spawn(async move {
                        captured
                            .check_bot_invocation(&context)
                            .await
                            .map_err(ToolError::Failed)?;
                        let appended = captured
                            .bot
                            .append(
                                &context.invocation.session_id,
                                &message_id,
                                &fingerprint,
                                &texts,
                                now() as i64,
                            )
                            .await?;
                        let (count, duplicate) = match appended {
                            Appended::Recorded(count) => (count, false),
                            Appended::Duplicate(count) => (count, true),
                        };
                        let text = if duplicate {
                            format!("Already sent: {count} message(s) with messageId {message_id}. Nothing was sent again.")
                        } else {
                            format!("Sent {count} message(s) to the user.")
                        };
                        Ok(ToolSuccess::projected(
                            ToolOutput::Json(serde_json::json!({
                                "messageId": message_id,
                                "count": count,
                                "duplicate": duplicate,
                            })),
                            DurableToolProjection::Text { text },
                        ))
                    });
                    drop(runs);
                    job.await
                        .map_err(|error| ToolError::OutcomeUnknown(error.to_string()))?
                })
            }))
        })
    }
}

impl Owner {
    async fn check_bot_invocation(&self, context: &ToolCallContext) -> Result<(), String> {
        let session_id = &context.invocation.session_id;
        let session = self.session(session_id).await?;
        if !self.settings.bot
            || session.archived
            || !is_bot(session.configuration.tools.as_deref())
            || self
                .bot
                .session()
                .await
                .map_err(|error| error.to_string())?
                .as_deref()
                != Some(session_id.as_str())
        {
            return Err("bot_unavailable".into());
        }
        let boundary = self
            .store
            .session(session_id)
            .await
            .map_err(|error| error.to_string())?
            .invocation_boundary(session_id, &context.invocation.invocation_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("bot_invocation_unavailable")?
            .0;
        if boundary.invocation != context.invocation
            || matches!(
                boundary.state,
                maka_event_log::turns::InvocationState::Ended { .. }
            )
        {
            return Err("bot_invocation_closed".into());
        }
        Ok(())
    }
    /// Return the installation's Bot Session, creating it on first use or after the
    /// previous one was archived.
    pub async fn open_bot(
        self: &Arc<Self>,
        input: BotOpen,
        operation: &maka_plugin_core::operation::RecoveryRef,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<BotOpened, String> {
        if !self.settings.bot {
            return Ok(BotOpened::Rejected {
                reason: BotRejection::Disabled,
            });
        }
        let (revision, record) = self
            .bot
            .read::<Record>(RECORD_KEY)
            .await
            .map_err(|error| error.to_string())?;
        if let Some(record) = &record
            && let Ok(session) = self.session(&record.session_id).await
            && !session.archived
        {
            return Ok(BotOpened::Opened {
                session_id: record.session_id.clone(),
                created: false,
            });
        }
        let tools: Vec<String> = ALLOWED_TOOLS
            .iter()
            .filter(|name| self.tools.contains(name))
            .map(|name| (*name).to_owned())
            .collect();
        let create = Create {
            automatic_title: false,
            tools: Some(tools),
            title: input.title.unwrap_or_else(|| "Bot".into()),
            labels: vec![],
            workspace: input.workspace,
        };
        let operation = operation.clone();
        let created = self
            .resource_work(scope, move |owner, scope| {
                Box::pin(async move { owner.create_inner(create, &operation, &scope, true).await })
            })
            .await?;
        let session_id = match created {
            Created::Created { session } => session.id,
            Created::Rejected { .. } => {
                return Ok(BotOpened::Rejected {
                    reason: BotRejection::CreationRejected,
                });
            }
        };
        match self
            .bot
            .write(
                RECORD_KEY,
                revision,
                &Record {
                    session_id: session_id.clone(),
                },
            )
            .await
        {
            Ok(()) => {}
            Err(StoreError::Conflict { .. }) => {
                // A concurrent open won; return its Session.
                if let Some(existing) = self
                    .bot
                    .session()
                    .await
                    .map_err(|error| error.to_string())?
                {
                    return Ok(BotOpened::Opened {
                        session_id: existing,
                        created: false,
                    });
                }
                return Err("bot_record_conflict".into());
            }
            Err(error) => return Err(error.to_string()),
        }
        self.bot.changed.send_replace(());
        Ok(BotOpened::Opened {
            session_id,
            created: true,
        })
    }
    pub fn bot_changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.bot.changed.subscribe()
    }
    pub async fn bot_outbox(&self, input: &BotOutboxRead) -> Result<BotOutbox, String> {
        let session_id = self
            .bot
            .session()
            .await
            .map_err(|error| error.to_string())?;
        let outbox = self
            .bot
            .read::<Outbox>(OUTBOX_KEY)
            .await
            .map_err(|error| error.to_string())?
            .1
            .filter(|outbox| outbox.session_id == session_id)
            .unwrap_or_default();
        let mut messages: Vec<BotMessage> = outbox
            .calls
            .into_iter()
            .flat_map(|call| call.messages)
            .filter(|message| message.sequence > input.after)
            .collect();
        messages.sort_by_key(|message| message.sequence);
        let truncated = messages.len() > PAGE;
        if truncated {
            messages.drain(..messages.len() - PAGE);
        }
        Ok(BotOutbox {
            enabled: self.settings.bot,
            session_id,
            through: outbox.through,
            messages,
            truncated,
        })
    }
}

fn invalid(error: impl std::fmt::Display) -> ToolRejection {
    ToolRejection::InvalidInput {
        message: error.to_string(),
    }
}
fn storage(error: StoreError) -> ToolError {
    match error {
        StoreError::OutcomeUnknown(message) => ToolError::OutcomeUnknown(message),
        other => ToolError::Failed(other.to_string()),
    }
}
