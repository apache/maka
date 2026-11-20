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
//! from Run state, so a crash neither loses nor repeats a recorded message.
//!
//! The registered Bot record is the only source of Bot identity. Tool grants,
//! recovery and `SendUser` all consult it, so forks and Sessions derived from the
//! Bot are ordinary Sessions.
use super::*;
use maka_agent_facts::{
    tool_call::ToolRejection,
    tool_output::{DurableToolProjection, ToolOutput, ToolSuccess},
    tools::*,
};
use maka_plugin_core::storage::{Data, Mutation, Namespace, Scan, Store, StoreError};
use sha2::{Digest, Sha256};
use std::sync::{OnceLock, RwLock, Weak};

pub(super) const SEND_USER: &str = "SendUser";
/// Ends the Turn and waits for events; it has no duration.
pub(super) const SLEEP: &str = "sleep";
/// Coordination tools admitted for the Bot, within its configured Session ceiling.
pub(super) const COORDINATION_TOOLS: &[&str] = &[
    "ScheduledTask",
    "DiscoveryMemory",
    "CreateGoal",
    "GetGoal",
    "GoalStatus",
    "Recall",
    "RecallMaterial",
    "RecallMore",
    "todo_read",
    "todo_write",
    "Skill",
    "SkillSearch",
    "ModelList",
    "SubagentPresetList",
    "SubagentPresetRead",
    "SubagentPresetCreate",
    "SubagentPresetUpdate",
    "SubagentPresetDelete",
    // Reading the user's conversations is open to the Bot. Tools that change or
    // message a conversation are deliberately absent until their confirmation
    // tiers and ownership checks exist.
    "SessionList",
    "SessionRead",
    // Delegation: the Bot may create workers and send to, respond to, or stop only
    // conversations it created itself (checked against `parentSessionId`).
    "SessionCreate",
    "SessionSend",
    "SessionRespond",
    "SessionStop",
];
const PAGE: usize = 100;
const RECORD_KEY: &str = "bot";

#[derive(Default)]
pub(super) struct Registration {
    revision: Option<u64>,
    session: Option<String>,
}
type StorageRecords = Vec<maka_plugin_core::storage::Record>;

impl Registration {
    pub(super) fn from_record(
        record: maka_plugin_core::storage::Record,
    ) -> Result<Self, maka_event_log::StoreError> {
        let current: Option<Record> = record
            .data
            .value()
            .cloned()
            .map(serde_json::from_value)
            .transpose()?;
        Ok(Self {
            revision: Some(record.revision),
            session: current.map(|record| record.session_id),
        })
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    session_id: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Head {
    through: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    discovery_link: Option<BotDiscoveryLink>,
}
/// One `SendUser` call. Calls are never evicted, so a reused `messageId` is always
/// recognized.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Call {
    message_id: String,
    fingerprint: String,
    first: u64,
    count: u64,
}

pub(super) enum Appended {
    Recorded(u64),
    Duplicate(u64),
}

/// Written with the claim of every Bot Session, so a replaced Bot is still known as
/// one. It confers no authority; only the current registration does.
fn former_key(session: &str) -> String {
    format!("former/{session}")
}
fn read_key(session: &str) -> String {
    format!("outbox/{session}/read")
}
fn head_key(session: &str) -> String {
    format!("outbox/{session}/head")
}
fn call_key(session: &str, message_id: &str) -> String {
    format!(
        "outbox/{session}/call/{}",
        hex::encode(Sha256::digest(message_id.as_bytes()))
    )
}
fn messages_prefix(session: &str) -> String {
    format!("outbox/{session}/message/")
}
fn message_key(session: &str, sequence: u64) -> String {
    format!("{}{sequence:020}", messages_prefix(session))
}

mod publication;
#[cfg(test)]
mod receipts;
mod wake;

pub(super) struct Bot {
    storage: Arc<maka_host_runtime::storage::Storage>,
    owner: OnceLock<Weak<Owner>>,
    current: RwLock<Registration>,
    creation: Arc<Mutex<()>>,
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
            current: RwLock::new(Registration::default()),
            creation: Arc::new(Mutex::new(())),
            changed: tokio::sync::watch::channel(()).0,
        }
    }
    /// Read the registered Bot before any queued work is scheduled.
    pub async fn load(&self) -> Result<(), StoreError> {
        let (revision, record) = self.read::<Record>(RECORD_KEY).await?;
        self.observe(Registration {
            revision,
            session: record.map(|record| record.session_id),
        });
        Ok(())
    }
    pub fn bind(&self, owner: &Arc<Owner>) {
        self.owner
            .set(Arc::downgrade(owner))
            .expect("bot bound once");
    }
    pub async fn finish(&self) -> Result<(), String> {
        self.storage.finish().await
    }
    /// The single decision of whether a Session is the Bot.
    pub(super) fn is(&self, session: &str) -> bool {
        self.current
            .read()
            .expect("bot identity")
            .session
            .as_deref()
            == Some(session)
    }
    async fn is_or_was(&self, session: &str) -> Result<bool, String> {
        Ok(self.is(session)
            || self
                .storage
                .read(former_key(session))
                .await
                .map_err(|error| error.to_string())?
                .is_some())
    }

    pub(super) fn prepare_creation_storage(
        &self,
        mutations: Vec<Mutation>,
        writer: &maka_event_log::root_store::DataWriter,
    ) -> Result<
        (
            Option<usize>,
            impl maka_event_log::writeback::Statement<Value = StorageRecords, Output = StorageRecords>
            + Clone
            + use<>,
        ),
        maka_event_log::StoreError,
    > {
        // Storage prefixes keys; DataBatch preserves input order through execute.
        let registration = mutations
            .iter()
            .position(|mutation| mutation.key == RECORD_KEY);
        self.storage
            .prepare_statement(mutations, writer)
            .map(|statement| (registration, statement))
    }

    pub(super) fn observe(&self, registration: Registration) {
        let mut current = self.current.write().expect("bot identity");
        if registration.revision <= current.revision {
            return;
        }
        let changed = current.session != registration.session;
        *current = registration;
        drop(current);
        if changed {
            self.changed.send_replace(());
        }
    }
    pub(super) fn session(&self) -> Option<String> {
        self.current.read().expect("bot identity").session.clone()
    }
    pub(super) async fn has_message(&self, session: &str, message: &str) -> Result<bool, String> {
        Ok(self
            .read::<Call>(&call_key(session, message))
            .await
            .map_err(|e| e.to_string())?
            .1
            .is_some_and(|call| call.message_id == message))
    }
    pub(super) async fn outbox_message(
        &self,
        session: &str,
        sequence: u64,
    ) -> Result<Option<BotMessage>, String> {
        self.read::<BotMessage>(&message_key(session, sequence))
            .await
            .map(|(_, message)| message)
            .map_err(|e| e.to_string())
    }
    async fn published_discovery(
        &self,
        session: &str,
        message: &str,
    ) -> Result<Option<DiscoveryPublication>, String> {
        let Some(call) = self
            .read::<Call>(&call_key(session, message))
            .await
            .map_err(|e| e.to_string())?
            .1
        else {
            return Ok(None);
        };
        Ok(self
            .outbox_message(session, call.first)
            .await?
            .and_then(|message| message.discovery))
    }
    pub fn tools(self: &Arc<Self>) -> Vec<ToolRegistration> {
        vec![
            ToolRegistration {
                definition: ToolDefinition {
                    provider: None,
                    name: SEND_USER.into(),
                    description: "Send messages to your user. This is the only way the user sees anything from you; ordinary replies stay internal. Send only when something is worth the user's attention, and send nothing otherwise. Reuse the same messageId when retrying the same content.".into(),
                    input_schema: serde_json::to_value(schemars::schema_for!(SendUserInput))
                        .expect("SendUser schema"),
                    output_schema: None,
                    freeform: None,
                },
                nesting: ToolNesting::Nestable,
                semantics: ToolSemantics::ExclusiveStep,
                handler: ToolHandler::Prepared(self.clone()),
            },
            ToolRegistration {
                definition: ToolDefinition {
                    provider: None,
                    name: SLEEP.into(),
                    description: "End this Turn and wait. You are woken by a user message, a finished background task or a scheduled event; there is no duration to choose, and nothing runs until one of them arrives. Call it on its own as your last action, after any SendUser, once nothing is left to do now. It is refused while a message is about to reach you in this Turn; handle that message first.".into(),
                    input_schema: serde_json::to_value(schemars::schema_for!(SleepInput))
                        .expect("sleep schema"),
                    output_schema: None,
                    freeform: None,
                },
                nesting: ToolNesting::DirectOnly,
                semantics: ToolSemantics::FinishTurn,
                handler: ToolHandler::Prepared(self.clone()),
            },
        ]
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
    fn mutation<T: Serialize>(
        key: String,
        expected: Option<u64>,
        value: &T,
    ) -> Result<Mutation, StoreError> {
        Ok(Mutation {
            key,
            expected_revision: expected,
            data: Data::Present(
                serde_json::to_value(value)
                    .map_err(|error| StoreError::Unavailable(error.to_string()))?,
            ),
        })
    }
    /// Append one `SendUser` call atomically: its call record, its messages and the
    /// advanced head commit together. A retried call with the same id and content is
    /// a duplicate; the same id with different content is refused.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn append(
        &self,
        session: &str,
        turn: &str,
        message_id: &str,
        fingerprint: &str,
        texts: &[String],
        at: i64,
        discovery: Option<DiscoveryPublication>,
    ) -> Result<Appended, ToolError> {
        loop {
            if let (_, Some(call)) = self
                .read::<Call>(&call_key(session, message_id))
                .await
                .map_err(storage)?
            {
                return if call.message_id == message_id && call.fingerprint == fingerprint {
                    Ok(Appended::Duplicate(call.count))
                } else {
                    Err(ToolError::Failed(
                        "messageId was already used with different content; choose a new messageId"
                            .into(),
                    ))
                };
            }
            let (revision, head) = self
                .read::<Head>(&head_key(session))
                .await
                .map_err(storage)?;
            let mut head = head.unwrap_or_default();
            let through = head.through;
            let count = texts.len() as u64;
            head.through += count;
            let mut mutations = vec![
                Self::mutation(head_key(session), revision, &head).map_err(storage)?,
                Self::mutation(
                    call_key(session, message_id),
                    None,
                    &Call {
                        message_id: message_id.into(),
                        fingerprint: fingerprint.into(),
                        first: through + 1,
                        count,
                    },
                )
                .map_err(storage)?,
            ];
            for (index, text) in texts.iter().enumerate() {
                let sequence = through + index as u64 + 1;
                mutations.push(
                    Self::mutation(
                        message_key(session, sequence),
                        None,
                        &BotMessage {
                            discovery: discovery.clone(),
                            sequence,
                            message_id: message_id.into(),
                            index: index as u32,
                            text: text.clone(),
                            at,
                            turn_id: Some(turn.into()),
                        },
                    )
                    .map_err(storage)?,
                );
            }
            match self.storage.batch(mutations).await {
                Ok(_) => {
                    self.changed.send_replace(());
                    return Ok(Appended::Recorded(count));
                }
                // Another call advanced the head or recorded this id; read again.
                Err(StoreError::Conflict { .. }) => continue,
                Err(error) => return Err(storage(error)),
            }
        }
    }
    /// Advance the read cursor; a stale acknowledgement leaves it where it is.
    async fn mark_read(&self, session: &str, through: u64) -> Result<(), StoreError> {
        let key = read_key(session);
        loop {
            let (revision, previous) = self.read::<Head>(&key).await?;
            if previous.unwrap_or_default().through >= through {
                return Ok(());
            }
            match self
                .storage
                .batch(vec![Self::mutation(
                    key.clone(),
                    revision,
                    &Head {
                        through,
                        ..Head::default()
                    },
                )?])
                .await
            {
                Ok(_) => {
                    self.changed.send_replace(());
                    return Ok(());
                }
                Err(StoreError::Conflict { .. }) => continue,
                Err(error) => return Err(error),
            }
        }
    }
    async fn page(
        &self,
        session: &str,
        after: u64,
        limit: usize,
    ) -> Result<(Head, Vec<BotMessage>, bool), StoreError> {
        let head = self
            .read::<Head>(&head_key(session))
            .await?
            .1
            .unwrap_or_default();
        if limit == 0 {
            return Ok((head, vec![], false));
        }
        let prefix = messages_prefix(session);
        let mut cursor = (after > 0).then(|| message_key(session, after));
        let mut messages = Vec::new();
        loop {
            let page = self
                .storage
                .scan(Scan {
                    prefix: prefix.clone(),
                    after: cursor.clone(),
                })
                .await?;
            for entry in page.entries {
                if let Some(value) = entry.record.data.value() {
                    messages.push(
                        serde_json::from_value::<BotMessage>(value.clone())
                            .map_err(|error| StoreError::Unavailable(error.to_string()))?,
                    );
                }
                if messages.len() > limit {
                    break;
                }
            }
            if messages.len() > limit || page.next_after.is_none() {
                break;
            }
            cursor = page.next_after;
        }
        let more = messages.len() > limit;
        messages.truncate(limit);
        Ok((head, messages, more))
    }
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SendUserInput {
    /// When notifying about a discovery, retain the original record and decision
    /// in this call instead of spending another model step on bookkeeping.
    discovery: Option<DiscoveryDecision>,
    /// Idempotency key you choose for this call; reuse it only to retry the same content.
    #[schemars(length(min = 1))]
    message_id: String,
    /// One or more messages, shown to the user in order.
    #[schemars(length(min = 1))]
    messages: Vec<SendUserMessage>,
}
#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct SendUserMessage {
    /// Markdown text shown to the user.
    #[schemars(length(min = 1))]
    text: String,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct DiscoveryDecision {
    record: String,
    reason: String,
}

/// `sleep` has no duration; an optional discovery decision settles with the Turn.
#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct SleepInput {
    /// Optionally record why a discovery was withheld while ending this Turn.
    discovery: Option<DiscoveryDecision>,
}

impl ToolPreparer for Bot {
    fn names(&self) -> Vec<String> {
        vec![SEND_USER.into(), SLEEP.into()]
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
            if name != SEND_USER && name != SLEEP {
                return Err(ToolRejection::Unavailable);
            }
            let owner = owner.ok_or(ToolRejection::Unavailable)?;
            if name == SLEEP {
                let input: SleepInput = serde_json::from_value(input).map_err(invalid)?;
                owner
                    .check_bot_invocation(&context)
                    .await
                    .map_err(|message| ToolRejection::PreparationFailed { message })?;
                return Ok(PreparedEffect::new(move |cancellation| {
                    Box::pin(async move {
                        if cancellation.is_cancelled() {
                            return Err(ToolError::Failed("sleep call cancelled".into()));
                        }
                        owner
                            .check_bot_invocation(&context)
                            .await
                            .map_err(ToolError::Failed)?;
                        if owner
                            .has_steering_for(&context)
                            .await
                            .map_err(ToolError::Failed)?
                        {
                            return Err(ToolError::Failed(
                                "A message is about to reach you in this Turn. Read it and handle it before you sleep.".into(),
                            ));
                        }
                        if let Some(decision) = input.discovery {
                            owner
                                .record_discovery_decision(
                                    &context,
                                    &decision.record,
                                    &decision.reason,
                                    None,
                                )
                                .await?;
                        }
                        Ok(ToolSuccess::projected(
                            ToolOutput::Json(serde_json::json!({ "sleeping": true })),
                            DurableToolProjection::Text {
                                text: "Turn ended. You will be woken by a user message, a background task result or a scheduled event.".into(),
                            },
                        ))
                    })
                })
                .presented("maka.agent.Builtin@1/sleep".into()));
            }
            let input: SendUserInput = serde_json::from_value(input).map_err(invalid)?;
            let message_id = input.message_id.trim().to_owned();
            if message_id.is_empty() {
                return Err(invalid("messageId must not be empty"));
            }
            if input.messages.is_empty() {
                return Err(invalid("messages must not be empty"));
            }
            if input
                .messages
                .iter()
                .any(|message| message.text.trim().is_empty())
            {
                return Err(invalid("every message needs non-empty text"));
            }
            let texts: Vec<String> = input
                .messages
                .into_iter()
                .map(|message| message.text)
                .collect();
            let discovery = input.discovery;
            let fingerprint = hex::encode(Sha256::digest(if discovery.is_some() {
                serde_json::to_vec(&(&texts, &discovery)).map_err(invalid)?
            } else {
                serde_json::to_vec(&texts).map_err(invalid)?
            }));
            // Checked here and again at execution: state can change in between.
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
                        let publication = if let Some(decision) = &discovery {
                            if captured.bot.has_message(&context.execution.session_id, &message_id).await.map_err(ToolError::Failed)? {
                                captured.bot.published_discovery(&context.execution.session_id, &message_id).await.map_err(ToolError::Failed)?
                            } else {
                                Some(captured.validate_discovery_decision(&context, &decision.record, &decision.reason).await?)
                            }
                        } else { None };
                        let appended = captured
                            .bot
                            .append(
                                &context.execution.session_id,
                                &context.execution.turn_id,
                                &message_id,
                                &fingerprint,
                                &texts,
                                now() as i64,
                                publication,
                            )
                            .await?;
                        let (count, duplicate) = match appended {
                            Appended::Recorded(count) => (count, false),
                            Appended::Duplicate(count) => (count, true),
                        };
                        if let Some(decision) = discovery {
                            captured.record_discovery_decision(&context, &decision.record, &decision.reason, Some(&message_id)).await
                                .map_err(|error| ToolError::OutcomeUnknown(format!("SendUser was recorded; discovery decision acknowledgement failed: {error}")))?;
                        }
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
            })
            .presented("maka.agent.Builtin@1/SendUser".into()))
        })
    }
}

impl Owner {
    /// Only steering committed for this logical Run can affect its next step.
    async fn has_steering_for(&self, context: &ToolCallContext) -> Result<bool, String> {
        let queue = self
            .durable
            .queue()
            .steering(
                context.execution.session_id.clone(),
                context.execution.run_id,
            )
            .await
            .map_err(|error| error.to_string())?;
        Ok(!queue.entries.is_empty())
    }
    pub(super) async fn check_bot_invocation(
        &self,
        context: &ToolCallContext,
    ) -> Result<(), String> {
        let execution = &context.execution;
        if self.settings.bot {
            self.bot.load().await.map_err(|error| error.to_string())?;
        }
        if !self.settings.bot
            || !self.bot.is(&execution.session_id)
            || self.session(&execution.session_id).await?.archived
        {
            return Err("bot_unavailable".into());
        }
        let view = self
            .durable
            .frontier(execution.run_id)
            .await
            .map_err(|error| error.to_string())?;
        if view.spec.session_id != execution.session_id
            || view.spec.turn_id != execution.turn_id
            || view.stopped
            || view.terminal.is_some()
        {
            return Err("bot_invocation_closed".into());
        }
        Ok(())
    }
    /// The registered Bot and its ordinary Session publish with the original receipt.
    pub async fn open_bot(
        self: &Arc<Self>,
        input: BotOpen,
        operation: &maka_plugin_core::operation::RecoveryRef,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<NativeMutation<BotOpened>, String> {
        if !self.settings.bot {
            return Ok(NativeMutation::Returned(BotOpened::Rejected {
                reason: BotRejection::Disabled,
            }));
        }
        let guard = Arc::new(self.bot.creation.clone().lock_owned().await);
        let (revision, record) = self
            .bot
            .read::<Record>(RECORD_KEY)
            .await
            .map_err(|error| error.to_string())?;
        self.bot.observe(Registration {
            revision,
            session: record.as_ref().map(|record| record.session_id.clone()),
        });
        if let Some(record) = record {
            match self.session(&record.session_id).await {
                Ok(session) if !session.archived => {
                    return Ok(NativeMutation::Returned(BotOpened::Opened {
                        session_id: record.session_id,
                        created: false,
                    }));
                }
                Ok(_) => {}
                Err(error) if error == "agent_session_unavailable" => {}
                Err(error) => return Err(error),
            }
        }
        let workspace = match input.workspace {
            Some(workspace) => workspace,
            None => match self.default_bot_workspace().await? {
                Some(workspace) => workspace,
                None => {
                    return Ok(NativeMutation::Returned(BotOpened::Rejected {
                        reason: BotRejection::NoWorkspace,
                    }));
                }
            },
        };
        let mine = self.operation_id(operation);
        let marker_key = former_key(&mine);
        let marker = self
            .bot
            .storage
            .read(marker_key.clone())
            .await
            .map_err(|error| error.to_string())?
            .map(|record| record.revision);
        let mutations = vec![
            Bot::mutation(RECORD_KEY.into(), revision, &Record { session_id: mine })
                .map_err(|error| error.to_string())?,
            Mutation {
                key: marker_key,
                expected_revision: marker,
                data: Data::Present(serde_json::json!({})),
            },
        ];
        let create = Create {
            incognito: false,
            kind: SessionKind::Agent,
            preset_id: None,
            backend: None,
            automatic_title: false,
            tools: None,
            title: input.title.unwrap_or_else(|| "Bot".into()),
            labels: vec![],
            workspace,
        };
        let operation = operation.clone();
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                owner
                    .create_inner(
                        create,
                        &operation,
                        &scope,
                        creation::Purpose::Bot { guard, mutations },
                    )
                    .await
                    .map(creation::PreparedCreation::into_bot)
            })
        })
        .await
    }
    /// The Host's first configured workspace root, as a directory selection.
    async fn default_bot_workspace(&self) -> Result<Option<WorkspaceSelection>, String> {
        let page = maka_workspace_support::query(
            self.workspace_roots.clone(),
            crate::contract::Directories::Roots,
            self.home.as_deref(),
        )
        .await?;
        Ok(match page {
            crate::contract::DirectoryPage::Roots { roots } => roots
                .into_iter()
                .next()
                .map(|root| WorkspaceSelection::Directory { path: root.path }),
            _ => None,
        })
    }
    /// The Bot uses the available coordination tools within its Session's explicit
    /// ceiling. Admitted work retains the authority captured for it.
    pub(super) fn admitted_tools(
        &self,
        session: &str,
        configured: &Option<Vec<String>>,
    ) -> Option<Vec<String>> {
        let selected = if self.settings.bot && self.bot.is(session) {
            Some(
                COORDINATION_TOOLS
                    .iter()
                    .filter(|name| {
                        self.tools.contains(name)
                            && configured
                                .as_ref()
                                .is_none_or(|allowed| allowed.iter().any(|tool| tool == *name))
                    })
                    .map(|name| (*name).to_owned())
                    .collect(),
            )
        } else {
            configured.clone()
        };
        intersect_tools(
            selected,
            self.store
                .checkpoint_execution()
                .and_then(|e| e.grant().permissions.tools.clone()),
        )
    }
    /// Append the Bot's standing instructions to the behavior frozen for a message
    /// admitted to the Bot Session. Other Sessions are unchanged.
    pub(super) fn bot_behavior(
        &self,
        session: &str,
        behavior: Option<maka_agent_facts::execution::SystemPrompt>,
        snapshot: &RuntimePolicySnapshot,
        language: Language,
        held: Option<&[String]>,
    ) -> Option<maka_agent_facts::execution::SystemPrompt> {
        if !self.settings.bot || !self.bot.is(session) {
            return behavior;
        }
        // The instructions name only what the Session really holds.
        let text = bot_prompt(language, held.unwrap_or_default());
        Some(match behavior {
            Some(mut prompt) => {
                prompt.text = format!("{}\n\n{text}", prompt.text);
                prompt
            }
            None => {
                let mut source = self.revision.clone();
                source.kind = maka_agent_facts::composition::SourceKind::PromptSection;
                maka_agent_facts::execution::SystemPrompt {
                    text,
                    policy_revision: snapshot.revision,
                    sources: vec![source],
                }
            }
        })
    }
    pub fn bot_changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.bot.changed.subscribe()
    }
    async fn bot_worker(
        &self,
        source: &maka_agent_facts::durable::ExecutionIdentity,
        session: &str,
    ) -> Result<bool, String> {
        if !self.bot.is(&source.session_id) || !self.owns(session) {
            return Ok(false);
        }
        let stored = self
            .store
            .get_session::<StoredSessionConfiguration>(session)
            .await
            .map_err(|_| "agent_store_unavailable")?;
        Ok(stored.is_some_and(|stored| {
            stored.configuration.parent_session_id.as_deref() == Some(source.session_id.as_str())
        }))
    }
    /// Controls that act on a conversation (send, stop) are limited, for the Bot,
    /// to the workers it created. Other callers are unaffected.
    pub(crate) async fn may_control(
        &self,
        scope: &maka_capabilities::call::Scope,
        session: &str,
    ) -> Result<bool, String> {
        if self.settings.bot {
            self.bot.load().await.map_err(|error| error.to_string())?;
        }
        match scope.identity.agent() {
            Some(source) if self.bot.is(&source.session_id) => {
                self.bot_worker(source, session).await
            }
            _ => Ok(true),
        }
    }
    pub async fn mark_bot_read(&self, input: BotMarkRead) -> Result<BotOutbox, String> {
        if !self.owns(&input.session_id) || !self.bot.is_or_was(&input.session_id).await? {
            return Err("bot_session_unavailable".into());
        }
        let head = self
            .bot
            .read::<Head>(&head_key(&input.session_id))
            .await
            .map_err(|error| error.to_string())?
            .1
            .unwrap_or_default()
            .through;
        if input.through > head {
            return Err("bot_read_beyond_head".into());
        }
        self.bot
            .mark_read(&input.session_id, input.through)
            .await
            .map_err(|error| error.to_string())?;
        self.bot_outbox(&BotOutboxRead {
            session_id: Some(input.session_id),
            after: 0,
            limit: 0,
        })
        .await
    }
    pub(crate) async fn has_bot_history(&self, session: &str) -> Result<bool, String> {
        self.bot.is_or_was(session).await
    }

    pub async fn bot_outbox(&self, input: &BotOutboxRead) -> Result<BotOutbox, String> {
        self.bot.load().await.map_err(|error| error.to_string())?;
        let session_id = self.bot.session();
        let target = input.session_id.clone().or_else(|| session_id.clone());
        let is_bot = match &target {
            Some(session) => self.bot.is_or_was(session).await?,
            None => false,
        };
        let (head, messages, more) = match target.as_ref().filter(|_| is_bot) {
            Some(session) => self
                .bot
                .page(session, input.after, (input.limit as usize).min(PAGE))
                .await
                .map_err(|error| error.to_string())?,
            None => (Head::default(), vec![], false),
        };
        let through = head.through;
        let next_after = more
            .then(|| messages.last().map(|message| message.sequence))
            .flatten();
        let (read_through, preview) = match target.as_ref().filter(|_| is_bot) {
            Some(session) => {
                let read = self
                    .bot
                    .read::<Head>(&read_key(session))
                    .await
                    .map_err(|error| error.to_string())?
                    .1
                    .unwrap_or_default()
                    .through
                    .min(through);
                let latest = self
                    .bot
                    .read::<BotMessage>(&message_key(session, through))
                    .await
                    .map_err(|error| error.to_string())?
                    .1;
                (
                    read,
                    latest.map_or_else(String::new, |message| preview(&message.text)),
                )
            }
            None => (0, String::new()),
        };
        Ok(BotOutbox {
            enabled: self.settings.bot,
            session_id,
            is_bot,
            read_through,
            preview,
            through,
            discovery_link: head.discovery_link,
            messages,
            next_after,
        })
    }
}

fn preview(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(160)
        .collect()
}

/// What the standing instructions may claim, keyed by the tools that grant it.
/// An ability is named only if the Bot Session really holds one of its tools,
/// so the instructions never promise a tool that is not there.
struct Ability {
    tools: &'static [&'static str],
    render: fn(Language, &str) -> String,
}

const ABILITIES: &[Ability] = &[
    Ability {
        tools: &["DiscoveryMemory"],
        render: |language, _| {
            maka_agent_facts::i18n::bot::ability_discovery_memory(language).to_owned()
        },
    },
    Ability {
        tools: &["ScheduledTask"],
        render: |language, _| {
            maka_agent_facts::i18n::bot::ability_scheduled_task(language).to_owned()
        },
    },
    Ability {
        tools: &["CreateGoal", "GetGoal", "GoalStatus"],
        render: |language, members| maka_agent_facts::i18n::bot::ability_goals(language, members),
    },
    Ability {
        tools: &["Recall", "RecallMaterial", "RecallMore"],
        render: |language, _| maka_agent_facts::i18n::bot::ability_recall(language).to_owned(),
    },
    Ability {
        tools: &["todo_read", "todo_write"],
        render: |language, members| {
            maka_agent_facts::i18n::bot::ability_checklist(language, members)
        },
    },
    Ability {
        tools: &["SessionList", "SessionRead"],
        render: |language, members| {
            maka_agent_facts::i18n::bot::ability_inspect_sessions(language, members)
        },
    },
    Ability {
        tools: &[
            "SubagentPresetList",
            "SubagentPresetRead",
            "SubagentPresetCreate",
            "SubagentPresetUpdate",
            "SubagentPresetDelete",
        ],
        render: |language, members| {
            maka_agent_facts::i18n::bot::ability_subagent_presets(language, members)
        },
    },
    Ability {
        tools: &["ModelList"],
        render: |language, members| {
            maka_agent_facts::i18n::bot::ability_model_list(language, members)
        },
    },
    Ability {
        tools: &[
            "SessionCreate",
            "SessionSend",
            "SessionRespond",
            "SessionStop",
        ],
        render: |language, members| {
            maka_agent_facts::i18n::bot::ability_session_control(language, members)
        },
    },
    Ability {
        tools: &["Skill", "SkillSearch"],
        render: |language, members| maka_agent_facts::i18n::bot::ability_skills(language, members),
    },
];

/// The Bot's standing instructions for the tools the Session actually holds.
/// `held` is the Session's tool list; `SendUser` and `sleep` come from identity.
pub(super) fn bot_prompt(language: Language, held: &[String]) -> String {
    let has = |names: &[&str]| {
        names
            .iter()
            .any(|name| held.iter().any(|held| held == name))
    };
    let mut tools = vec![maka_agent_facts::i18n::bot::ability_send_user(language).to_owned()];
    tools.extend(
        ABILITIES
            .iter()
            .filter(|ability| has(ability.tools))
            .map(|ability| {
                let members: Vec<&str> = ability
                    .tools
                    .iter()
                    .copied()
                    .filter(|name| held.iter().any(|held| held == name))
                    .collect();
                (ability.render)(language, &members.join(" / "))
            }),
    );
    tools.push(maka_agent_facts::i18n::bot::ability_sleep(language).to_owned());

    let sessions = has(&["SessionCreate"]) && has(&["SessionSend"]);
    let schedules = has(&["ScheduledTask"]);
    let skills = has(&["Skill", "SkillSearch"]);

    let tools_list = tools.join(maka_agent_facts::i18n::bot::list_separator(language));
    let mut text = maka_agent_facts::i18n::bot::prompt_intro(language, &tools_list);
    if !sessions {
        text.push_str(maka_agent_facts::i18n::bot::prompt_no_delegation(language));
    } else {
        text.push_str(maka_agent_facts::i18n::bot::prompt_delegation(language));
    }
    if skills {
        text.push_str(maka_agent_facts::i18n::bot::prompt_skills(language));
    }
    if schedules {
        text.push_str(maka_agent_facts::i18n::bot::prompt_schedules(language));
    }
    if has(&["DiscoveryMemory"]) {
        text.push_str(maka_agent_facts::i18n::bot::prompt_discovery_memory(
            language,
        ));
    }
    text.push_str(maka_agent_facts::i18n::bot::prompt_ending(language));
    text
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
