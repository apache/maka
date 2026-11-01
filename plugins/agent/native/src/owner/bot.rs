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
/// Ends the Turn and waits for events; it has no duration.
pub(super) const SLEEP: &str = "sleep";
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
    // Reading the user's conversations is open to the Bot. Tools that change or
    // message a conversation are deliberately absent until their confirmation
    // tiers and ownership checks exist.
    "SessionList",
    "SessionRead",
    "SessionHistory",
    "SessionQueue",
    "SessionWork",
    "SessionExecution",
    // Delegation: the Bot may create workers and send to or stop only the
    // conversations it created itself (checked against `parentSessionId`).
    "SessionCreate",
    "SessionSend",
    "SessionStop",
];
/// Tools that change or message conversations. A Bot's worker never holds them:
/// otherwise delegating would be a way around the Bot's own limits.
const WORKER_WITHHELD: &[&str] = &[
    "SessionCreate",
    "SessionFork",
    "SessionUpdate",
    "SessionChange",
    "SessionSend",
    "SessionStop",
    "SessionResume",
    "SessionEditQueue",
    WORKHUB,
];
const PAGE: usize = 100;
const RECORD_KEY: &str = "bot";
/// How long an open waits for a live creator in this process before asking the
/// caller to retry. A wait never authorizes taking over a live creator's claim.
const CLAIM_WAITS: u32 = 300;
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
    /// Claims whose Session creation is in progress in this process. The Root lock
    /// admits one Host per Root, so a claim absent here has no live creator.
    creating: std::sync::Mutex<std::collections::HashSet<String>>,
    changed: tokio::sync::watch::Sender<()>,
}
/// Registers a live creation for as long as it is held.
pub(super) struct Creating<'a> {
    bot: &'a Bot,
    session: String,
}
impl Drop for Creating<'_> {
    fn drop(&mut self) {
        self.bot
            .creating
            .lock()
            .expect("bot creations")
            .remove(&self.session);
    }
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
            creating: Default::default(),
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
    fn creating(&self, session: &str) -> Creating<'_> {
        self.creating
            .lock()
            .expect("bot creations")
            .insert(session.into());
        Creating {
            bot: self,
            session: session.into(),
        }
    }
    fn is_creating(&self, session: &str) -> bool {
        self.creating
            .lock()
            .expect("bot creations")
            .contains(session)
    }
    /// Test support: leave a claim as an interrupted or a live creator would.
    #[cfg(test)]
    pub(super) async fn claim_for_test(&self, session: &str, live: bool) {
        let (revision, _) = self.read::<Record>(RECORD_KEY).await.unwrap();
        self.storage
            .batch(vec![
                Self::mutation(
                    RECORD_KEY.into(),
                    revision,
                    &Record {
                        session_id: session.into(),
                    },
                )
                .unwrap(),
            ])
            .await
            .unwrap();
        self.set_current(Some(session.into()));
        if live {
            self.creating.lock().unwrap().insert(session.into());
        }
    }
    #[cfg(test)]
    pub(super) async fn release_for_test(&self, session: &str) {
        self.creating.lock().unwrap().remove(session);
        let (revision, _) = self.read::<Record>(RECORD_KEY).await.unwrap();
        self.storage
            .batch(vec![Mutation {
                key: RECORD_KEY.into(),
                expected_revision: revision,
                data: Data::Deleted,
            }])
            .await
            .unwrap();
        self.set_current(None);
    }
    fn set_current(&self, session: Option<String>) {
        *self.current.write().expect("bot identity") = session;
    }
    pub(super) fn session(&self) -> Option<String> {
        self.current.read().expect("bot identity").clone()
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
                nesting: ToolNesting::DirectOnly,
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
    pub(super) async fn append(
        &self,
        session: &str,
        turn: &str,
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
    async fn page(
        &self,
        session: &str,
        after: u64,
        limit: usize,
    ) -> Result<(u64, Vec<BotMessage>, bool), StoreError> {
        let through = self
            .read::<Head>(&head_key(session))
            .await?
            .1
            .unwrap_or_default()
            .through;
        if limit == 0 {
            return Ok((through, vec![], false));
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

/// `sleep` takes no arguments: the Bot waits for events, not for a time.
#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct SleepInput {}

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
                let _: SleepInput = serde_json::from_value(input).map_err(invalid)?;
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
                        Ok(ToolSuccess::projected(
                            ToolOutput::Json(serde_json::json!({ "sleeping": true })),
                            DurableToolProjection::Text {
                                text: "Turn ended. You will be woken by a user message, a background task result or a scheduled event.".into(),
                            },
                        ))
                    })
                }));
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
                                &context.invocation.turn_id,
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
    /// Whether a queued message is already bound for this Invocation's next step.
    /// Ordinary follow-ups are not counted: they start the next Turn on their own,
    /// and the model could not read them now.
    async fn has_steering_for(&self, context: &ToolCallContext) -> Result<bool, String> {
        let session_id = &context.invocation.session_id;
        let queue = self
            .store
            .session(session_id)
            .await
            .map_err(|error| error.to_string())?
            .message_queue(session_id)
            .await
            .map_err(|error| error.to_string())?;
        Ok(queue.entries.iter().any(|entry| {
            entry.source.disposition == maka_agent_facts::message::MessageDisposition::Steering
                && *entry.steering_target() == context.invocation
        }))
    }
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
        let creating;
        loop {
            let (revision, record) = self
                .bot
                .read::<Record>(RECORD_KEY)
                .await
                .map_err(|error| error.to_string())?;
            if let Some(record) = &record {
                if record.session_id == mine {
                    // Our claim: a retry of this operation resumes its creation.
                    creating = self.bot.creating(&mine);
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
                        // A live creator keeps its claim however long it takes; only a
                        // claim with no creator left (interrupted or from an earlier run)
                        // may be taken over.
                        if self.bot.is_creating(&record.session_id) {
                            if waits < CLAIM_WAITS {
                                waits += 1;
                                tokio::time::sleep(CLAIM_WAIT).await;
                                continue;
                            }
                            return Err("bot_open_in_progress".into());
                        }
                    }
                    Err(error) => return Err(error),
                }
            }
            // Register before the claim is visible, so no reader sees it creator-less.
            let guard = self.bot.creating(&mine);
            match self.storage_claim(revision, &mine).await {
                Ok(()) => {
                    creating = guard;
                    break;
                }
                Err(StoreError::Conflict { .. }) => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        let tools: Vec<String> = COORDINATION_TOOLS
            .iter()
            .filter(|name| self.tools.contains(name))
            .map(|name| (*name).to_owned())
            .collect();
        let workspace = match input.workspace {
            Some(workspace) => workspace,
            None => match self.default_bot_workspace().await? {
                Some(workspace) => workspace,
                None => {
                    self.release_claim(&mine).await?;
                    return Ok(BotOpened::Rejected {
                        reason: BotRejection::NoWorkspace,
                    });
                }
            },
        };
        let create = Create {
            automatic_title: false,
            tools: Some(tools),
            title: input.title.unwrap_or_else(|| "Bot".into()),
            labels: vec![],
            workspace,
        };
        let operation = operation.clone();
        let created = self
            .resource_work(scope, move |owner, scope| {
                Box::pin(async move { owner.create_inner(create, &operation, &scope).await })
            })
            .await?;
        let _creating = creating;
        match created {
            Created::Created { session } => {
                // The claim is ours while we create, but confirm before reporting.
                if let Some(registered) = self
                    .bot
                    .read::<Record>(RECORD_KEY)
                    .await
                    .map_err(|error| error.to_string())?
                    .1
                    .filter(|record| record.session_id != session.id)
                {
                    self.bot.set_current(Some(registered.session_id.clone()));
                    return Ok(BotOpened::Opened {
                        session_id: registered.session_id,
                        created: false,
                    });
                }
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
    /// The Host's first configured workspace root, as a directory selection.
    async fn default_bot_workspace(&self) -> Result<Option<WorkspaceSelection>, String> {
        let page = maka_workspace_support::query(
            self.workspace_roots.clone(),
            crate::contract::Directories::Roots,
        )
        .await?;
        Ok(match page {
            crate::contract::DirectoryPage::Roots { roots } => {
                roots
                    .into_iter()
                    .next()
                    .map(|root| WorkspaceSelection::Directory {
                        selection: root.selection,
                    })
            }
            _ => None,
        })
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
    /// The tools a Bot's worker holds: everything installed except what changes or
    /// messages conversations. A requested list can only narrow that; `None`
    /// means the request names a tool the worker may not hold.
    pub(super) fn worker_tools(&self, requested: Option<Vec<String>>) -> Option<Vec<String>> {
        let mut allowed: Vec<String> = self
            .tools
            .names()
            .into_iter()
            .filter(|name| {
                !WORKER_WITHHELD.contains(&name.as_str())
                    && name != SEND_USER
                    && name != SLEEP
                    && !crate::workhub::tasks::graph::NAMES.contains(&name.as_str())
            })
            .collect();
        allowed.sort();
        match requested {
            None => Some(allowed),
            Some(names) => names
                .iter()
                .all(|name| allowed.contains(name))
                .then_some(names),
        }
    }
    /// Whether `session` is the calling Bot or a worker it created.
    pub(super) async fn bot_owns_or_is(
        &self,
        scope: &maka_capabilities::call::Scope,
        session: &str,
    ) -> Result<bool, String> {
        let Some(source) = scope.identity.agent() else {
            return Ok(false);
        };
        if source.session_id == session {
            return Ok(self.bot.is(session));
        }
        self.bot_worker(source, session).await
    }
    async fn bot_worker(
        &self,
        source: &maka_agent_facts::event::Invocation,
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
        match scope.identity.agent() {
            Some(source) if self.bot.is(&source.session_id) => {
                self.bot_worker(source, session).await
            }
            _ => Ok(true),
        }
    }
    pub async fn bot_outbox(&self, input: &BotOutboxRead) -> Result<BotOutbox, String> {
        let session_id = self.bot.session();
        let (through, messages, more) = match &session_id {
            Some(session) => self
                .bot
                .page(session, input.after, (input.limit as usize).min(PAGE))
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

/// What the standing instructions may claim, keyed by the tools that grant it:
/// (tools, zh-CN, zh-TW, English). An ability is named only if the Bot Session
/// really holds one of its tools, so the instructions never promise a tool that
/// is not there. A `{}` in the text stands for the members actually held, so a
/// partial configuration is not credited with tools it lacks.
type Ability = (
    &'static [&'static str],
    &'static str,
    &'static str,
    &'static str,
);
const ABILITIES: &[Ability] = &[
    (
        &["ScheduledTask"],
        "ScheduledTask（安排定时唤醒，需用户批准）",
        "ScheduledTask（安排定時喚醒，需使用者核准）",
        "ScheduledTask (schedule a wake-up, which the user must approve)",
    ),
    (
        &["GoalStatus"],
        "GoalStatus（目标）",
        "GoalStatus（目標）",
        "GoalStatus (goals)",
    ),
    (
        &["Recall", "RecallMaterial", "RecallMore"],
        "Recall 系列（检索历史对话）",
        "Recall 系列（檢索歷史對話）",
        "the Recall tools (search past conversations)",
    ),
    (
        &["todo_read", "todo_write"],
        "{}（待办）",
        "{}（待辦）",
        "{} (checklist)",
    ),
    (
        &[WORKHUB],
        "workhub_tasks（把具体工作委派给后台任务）",
        "workhub_tasks（把具體工作委派給背景任務）",
        "workhub_tasks (delegate hands-on work to background tasks)",
    ),
    (
        &[
            "SessionList",
            "SessionRead",
            "SessionHistory",
            "SessionQueue",
            "SessionWork",
            "SessionExecution",
        ],
        "{}（只读地查看用户的会话）",
        "{}（唯讀地查看使用者的會話）",
        "{} (read the user's conversations, read-only)",
    ),
    (
        &["SessionCreate", "SessionSend", "SessionStop"],
        "{}（新建工作会话并派活；只能给自己创建的会话发消息或停止）",
        "{}（新建工作會話並派活；只能給自己建立的會話發訊息或停止）",
        "{} (create work conversations and hand them tasks; you may only send to or stop conversations you created)",
    ),
    (
        &["Skill", "SkillSearch"],
        "{}（查阅技能说明）",
        "{}（查閱技能說明）",
        "{} (read skill instructions)",
    ),
];
const WORKHUB: &str = "workhub_tasks";

/// The Bot's standing instructions for the tools the Session actually holds.
/// `held` is the Session's tool list; `SendUser` and `sleep` come from identity.
pub(super) fn bot_prompt(language: Language, held: &[String]) -> String {
    let has = |names: &[&str]| {
        names
            .iter()
            .any(|name| held.iter().any(|held| held == name))
    };
    let named = |pick: fn(&Ability) -> &'static str| -> Vec<String> {
        ABILITIES
            .iter()
            .filter(|ability| has(ability.0))
            .map(|ability| {
                let members: Vec<&str> = ability
                    .0
                    .iter()
                    .copied()
                    .filter(|name| held.iter().any(|held| held == name))
                    .collect();
                pick(ability).replace("{}", &members.join(" / "))
            })
            .collect()
    };
    let sessions = has(&["SessionCreate"]) && has(&["SessionSend"]);
    let (delegates, schedules, skills) = (
        has(&[WORKHUB]) || sessions,
        has(&["ScheduledTask"]),
        has(&["Skill", "SkillSearch"]),
    );
    match language {
        Language::ZhCn => {
            let mut tools = vec!["SendUser（对用户说话）".to_owned()];
            tools.extend(named(|a| a.1));
            tools.push("sleep（结束本轮并等待）".to_owned());
            let mut text = format!(
                "你是用户在 Maka 里的常驻 Bot。\n\n对话方式：用户只能看到你用 SendUser 工具发出的消息；你的普通回复和工具步骤都是内部过程，用户看不到。要回应用户，就调用 SendUser，普通文字尽量少写。不值得打扰用户的事，就什么都不发。\n\n你的真实能力只有这些工具：{}。你自己不能读写文件、运行命令、使用浏览器、访问网络或调用 MCP。",
                tools.join("、")
            );
            text.push_str(if has(&[WORKHUB]) {
                "需要动手做的事，用 workhub_tasks 委派出去，等结果回来再告诉用户；做不到又无法委派的事，如实说明。"
            } else if !delegates {
                "需要动手做的事你既做不到也无法委派，请如实告诉用户。"
            } else {
                ""
            });
            if sessions {
                text.push_str("需要动手做的事，用 SessionCreate 新建一个会话，再用 SessionSend 把任务交给它；同一件事可以并行开多个。它做完不会自动通知你，需要时用会话读取工具查看进度，不要假装它已经做完。");
            }
            if skills {
                text.push_str("技能只是说明文档，其中需要上述被禁止能力的步骤你不能自己执行，不要把技能清单当作你自己的能力介绍给用户。");
            }
            if schedules {
                text.push_str("需要以后再看的事，用 ScheduledTask 安排。");
            }
            text.push_str("\n\n结束一轮：事情都处理完、暂时没有要做的了，就单独调用一次 sleep（不要和 SendUser 放在同一步）。sleep 没有时长，之后用户的消息、后台任务的结果或到点的定时任务会再叫醒你；如果提示有消息即将到达，先处理它再 sleep。");
            text
        }
        Language::ZhTw => {
            let mut tools = vec!["SendUser（對使用者說話）".to_owned()];
            tools.extend(named(|a| a.2));
            tools.push("sleep（結束本輪並等待）".to_owned());
            let mut text = format!(
                "你是使用者在 Maka 裡的常駐 Bot。\n\n對話方式：使用者只能看到你用 SendUser 工具發出的訊息；你的一般回覆和工具步驟都是內部過程，使用者看不到。要回應使用者，就呼叫 SendUser，一般文字盡量少寫。不值得打擾使用者的事，就什麼都不發。\n\n你的真實能力只有這些工具：{}。你自己不能讀寫檔案、執行指令、使用瀏覽器、存取網路或呼叫 MCP。",
                tools.join("、")
            );
            text.push_str(if has(&[WORKHUB]) {
                "需要動手做的事，用 workhub_tasks 委派出去，等結果回來再告訴使用者；做不到又無法委派的事，如實說明。"
            } else if !delegates {
                "需要動手做的事你既做不到也無法委派，請如實告訴使用者。"
            } else {
                ""
            });
            if sessions {
                text.push_str("需要動手做的事，用 SessionCreate 新建一個會話，再用 SessionSend 把任務交給它；同一件事可以平行開多個。它做完不會自動通知你，需要時用會話讀取工具查看進度，不要假裝它已經做完。");
            }
            if skills {
                text.push_str("技能只是說明文件，其中需要上述被禁止能力的步驟你不能自己執行，不要把技能清單當作你自己的能力介紹給使用者。");
            }
            if schedules {
                text.push_str("需要之後再看的事，用 ScheduledTask 安排。");
            }
            text.push_str("\n\n結束一輪：事情都處理完、暫時沒有要做的了，就單獨呼叫一次 sleep（不要和 SendUser 放在同一步）。sleep 沒有時長，之後使用者的訊息、背景任務的結果或到點的定時任務會再叫醒你；如果提示有訊息即將到達，先處理它再 sleep。");
            text
        }
        _ => {
            let mut tools = vec!["SendUser (speak to the user)".to_owned()];
            tools.extend(named(|a| a.3));
            tools.push("sleep (end the Turn and wait)".to_owned());
            let mut text = format!(
                "You are the user's persistent Bot in Maka.\n\nHow you talk: the user sees only the messages you send with the SendUser tool; your ordinary replies and tool steps are internal and never shown. To respond to the user, call SendUser, and keep ordinary text minimal. When something does not need the user's attention, send nothing.\n\nYour real abilities are only these tools: {}. You yourself cannot read or edit files, run commands, use a browser, reach the network or call MCP tools. ",
                tools.join(", ")
            );
            text.push_str(if has(&[WORKHUB]) {
                "Delegate hands-on work with workhub_tasks and tell the user when the result comes back; if something can neither be done nor delegated, say so plainly. "
            } else if !delegates {
                "Hands-on work is something you can neither do nor delegate, so tell the user plainly. "
            } else {
                ""
            });
            if sessions {
                text.push_str("Hands-on work goes to a new conversation: create it with SessionCreate and give it the task with SessionSend; independent pieces can run in parallel. A finished worker does not notify you, so read its progress with the conversation read tools when you need it, and never claim it is done before you have seen that. ");
            }
            if skills {
                text.push_str("Skills are only documents: steps in them that need the abilities you lack are not yours to run, and the skill list is not a description of what you can do, so do not present it to the user as your abilities. ");
            }
            if schedules {
                text.push_str("Use ScheduledTask to come back to something later.");
            }
            text.push_str("\n\nEnding a Turn: when everything is handled and nothing is left to do for now, call sleep on its own, never in the same step as SendUser. sleep has no duration; a user message, a background task result or a scheduled event wakes you again. If it says a message is about to reach you, handle that message first, then sleep.");
            text
        }
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
