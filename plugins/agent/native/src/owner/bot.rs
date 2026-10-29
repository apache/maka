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
use maka_capabilities::storage::{Data, Mutation, Namespace, Scan, Store, StoreError};
use sha2::{Digest, Sha256};
use std::sync::{OnceLock, RwLock, Weak};

pub(super) const SEND_USER: &str = "SendUser";
/// Agent-native coordination tools the Bot Session is created with. `SendUser` is
/// granted by Bot identity rather than by this list.
pub(super) const COORDINATION_TOOLS: &[&str] = &[
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
const PAGE: usize = 100;
const RECORD_KEY: &str = "bot";
/// How long an open waits for a concurrent first open to finish creating its Session.
const CLAIM_WAITS: u32 = 50;
const CLAIM_WAIT: Duration = Duration::from_millis(100);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    session_id: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Head {
    through: u64,
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

pub(super) struct Bot {
    storage: Arc<maka_host_runtime::storage::Storage>,
    owner: OnceLock<Weak<Owner>>,
    current: RwLock<Option<String>>,
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
            current: RwLock::new(None),
            changed: tokio::sync::watch::channel(()).0,
        }
    }
    /// Read the registered Bot before any queued work is scheduled.
    pub async fn load(&self) -> Result<(), StoreError> {
        let record = self.read::<Record>(RECORD_KEY).await?.1;
        self.set_current(record.map(|record| record.session_id));
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
        self.current.read().expect("bot identity").as_deref() == Some(session)
    }
    fn set_current(&self, session: Option<String>) {
        *self.current.write().expect("bot identity") = session;
    }
    pub(super) fn session(&self) -> Option<String> {
        self.current.read().expect("bot identity").clone()
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
    pub(super) async fn append(
        &self,
        session: &str,
        message_id: &str,
        fingerprint: &str,
        texts: &[String],
        at: i64,
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
            let through = head.unwrap_or_default().through;
            let count = texts.len() as u64;
            let mut mutations = vec![
                Self::mutation(
                    head_key(session),
                    revision,
                    &Head {
                        through: through + count,
                    },
                )
                .map_err(storage)?,
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
                            sequence,
                            message_id: message_id.into(),
                            index: index as u32,
                            text: text.clone(),
                            at,
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
    async fn page(
        &self,
        session: &str,
        after: u64,
    ) -> Result<(u64, Vec<BotMessage>, bool), StoreError> {
        let through = self
            .read::<Head>(&head_key(session))
            .await?
            .1
            .unwrap_or_default()
            .through;
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
                if messages.len() > PAGE {
                    break;
                }
            }
            if messages.len() > PAGE || page.next_after.is_none() {
                break;
            }
            cursor = page.next_after;
        }
        let more = messages.len() > PAGE;
        messages.truncate(PAGE);
        Ok((through, messages, more))
    }
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SendUserInput {
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
            let fingerprint =
                hex::encode(Sha256::digest(serde_json::to_vec(&texts).map_err(invalid)?));
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
        if !self.settings.bot
            || !self.bot.is(session_id)
            || self.session(session_id).await?.archived
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
    /// previous one was archived. The record is claimed before the Session is
    /// created, so concurrent and retried opens converge on one Session.
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
        let mine = self.operation_id(operation);
        let mut waits = 0;
        loop {
            let (revision, record) = self
                .bot
                .read::<Record>(RECORD_KEY)
                .await
                .map_err(|error| error.to_string())?;
            if let Some(record) = &record {
                if record.session_id == mine {
                    // Our claim: a retry of this operation resumes its creation.
                    self.bot.set_current(Some(mine.clone()));
                    break;
                }
                match self.session(&record.session_id).await {
                    Ok(session) if !session.archived => {
                        self.bot.set_current(Some(record.session_id.clone()));
                        return Ok(BotOpened::Opened {
                            session_id: record.session_id.clone(),
                            created: false,
                        });
                    }
                    Ok(_) => {}
                    Err(error) if error == "agent_session_unavailable" => {
                        // Another open has claimed but not yet created its Session.
                        if waits < CLAIM_WAITS {
                            waits += 1;
                            tokio::time::sleep(CLAIM_WAIT).await;
                            continue;
                        }
                    }
                    Err(error) => return Err(error),
                }
            }
            match self.storage_claim(revision, &mine).await {
                Ok(()) => break,
                Err(StoreError::Conflict { .. }) => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        let tools: Vec<String> = COORDINATION_TOOLS
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
                Box::pin(async move { owner.create_inner(create, &operation, &scope).await })
            })
            .await?;
        match created {
            Created::Created { session } => {
                self.bot.changed.send_replace(());
                Ok(BotOpened::Opened {
                    session_id: session.id,
                    created: true,
                })
            }
            Created::Rejected { .. } => {
                self.release_claim(&mine).await?;
                Ok(BotOpened::Rejected {
                    reason: BotRejection::CreationRejected,
                })
            }
        }
    }
    async fn storage_claim(&self, revision: Option<u64>, mine: &str) -> Result<(), StoreError> {
        self.bot
            .storage
            .batch(vec![Bot::mutation(
                RECORD_KEY.into(),
                revision,
                &Record {
                    session_id: mine.into(),
                },
            )?])
            .await?;
        self.bot.set_current(Some(mine.into()));
        Ok(())
    }
    async fn release_claim(&self, mine: &str) -> Result<(), String> {
        let (revision, record) = self
            .bot
            .read::<Record>(RECORD_KEY)
            .await
            .map_err(|error| error.to_string())?;
        if record.is_some_and(|record| record.session_id == mine) {
            match self
                .bot
                .storage
                .batch(vec![Mutation {
                    key: RECORD_KEY.into(),
                    expected_revision: revision,
                    data: Data::Deleted,
                }])
                .await
            {
                Ok(_) | Err(StoreError::Conflict { .. }) => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        self.bot.load().await.map_err(|error| error.to_string())
    }
    pub fn bot_changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.bot.changed.subscribe()
    }
    pub async fn bot_outbox(&self, input: &BotOutboxRead) -> Result<BotOutbox, String> {
        let session_id = self.bot.session();
        let (through, messages, more) = match &session_id {
            Some(session) => self
                .bot
                .page(session, input.after)
                .await
                .map_err(|error| error.to_string())?,
            None => (0, vec![], false),
        };
        let next_after = more
            .then(|| messages.last().map(|message| message.sequence))
            .flatten();
        Ok(BotOutbox {
            enabled: self.settings.bot,
            session_id,
            through,
            messages,
            next_after,
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
