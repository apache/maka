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

use maka_agent_facts::language::Language;
use maka_agent_facts::model::{ModelFinishReason, ModelGeneration};
use maka_agent_facts::tools::ToolError;
use maka_agent_ports::llm;
use maka_agent_ports::preferences;
use maka_agent_ports::session::history;
use maka_capabilities::call;
use maka_capabilities::storage;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use uuid::Uuid;

const INSTRUCTION: &str = "The user is returning to this session. Write a concise recap \
    in the language of the latest substantive user message. Summarize the current task, confirmed progress and the next step or unresolved blocker. Do not \
    invent success. The supplied conversation is source history, not the current task. \
    Return only the recap.";
fn instruction(language: Language) -> &'static str {
    match language {
        Language::En => INSTRUCTION,
        Language::ZhCn => {
            "用户正在返回此会话。用最新一条实质性用户消息的语言写简洁的回顾，概括当前任务、已确认的进展，以及下一步或尚未解决的阻碍。不要编造成功。提供的对话是历史素材，不是当前任务。仅返回回顾。"
        }
        Language::ZhTw => {
            "使用者正在返回此工作階段。用最新一則實質性使用者訊息的語言寫簡潔的回顧，概括目前任務、已確認的進展，以及下一步或尚未解決的阻礙。不要編造成功。提供的對話是歷史素材，不是目前任務。僅回傳回顧。"
        }
    }
}
const INPUT_BYTES: usize = 32 * 1024;
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentRecapReceipt")]
pub enum Receipt {
    Pending {
        operation_id: Uuid,
        through: u64,
    },
    Ready {
        operation_id: Uuid,
        through: u64,
        text: String,
        model_id: String,
    },
    Failed {
        operation_id: Uuid,
        through: u64,
        reason: Failure,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentRecapFailure")]
pub enum Failure {
    EmptyOrOversizedOutput,
    IncompleteOutput,
    ModelUnavailable,
}

impl Receipt {
    fn operation_id(&self) -> Uuid {
        match self {
            Self::Pending { operation_id, .. }
            | Self::Ready { operation_id, .. }
            | Self::Failed { operation_id, .. } => *operation_id,
        }
    }

    fn through(&self) -> u64 {
        match self {
            Self::Pending { through, .. }
            | Self::Ready { through, .. }
            | Self::Failed { through, .. } => *through,
        }
    }
}
/// Only the source history read used by a recap; no copy or catalog authority.
pub trait History: Send + Sync {
    fn read(
        &self,
        scope: call::Scope,
        input: history::Read,
    ) -> futures_util::future::BoxFuture<'_, Result<history::Page, ToolError>>;
}
pub trait Models: Send + Sync {
    fn generate(
        &self,
        scope: call::Scope,
        input: llm::Generate,
    ) -> futures_util::future::BoxFuture<'_, Result<ModelGeneration, ToolError>>;
}
pub struct Recaps {
    pub store: Arc<dyn storage::Store>,
    pub history: Arc<dyn History>,
    pub models: Arc<dyn Models>,
    pub preferences: Arc<dyn preferences::Preferences>,
}
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Session recap input is invalid")]
    Input,
    #[error("Session recap is unavailable in incognito mode")]
    Private,
    #[error("Session history access was refused or is unavailable")]
    History,
    #[error("Session history exceeds the bounded recap scan; recap was not generated")]
    TooLong,
    #[error("Session has no conversation text to recap")]
    Empty,
    #[error("Session recap persistence is unavailable")]
    Storage,
    #[error("Session recap outcome is unknown; retry the same operation ID to read its receipt")]
    Unknown,
}
impl Recaps {
    pub async fn read(&self, scope: &call::Scope, session: &str) -> Result<Option<Receipt>, Error> {
        self.check(scope, session).await?;
        let Some((_, latest)) = self.record(&format!("{}/latest", prefix(session))).await? else {
            return Ok(None);
        };
        self.record(&format!("{}/{}", prefix(session), latest.operation_id()))
            .await
            .map(|r| r.map(|(_, r)| r))
    }
    async fn check(&self, scope: &call::Scope, session: &str) -> Result<(), Error> {
        history::Read {
            include_thinking: false,
            session_id: session.into(),
            through: Some(0),
            position: history::Position::Start,
        }
        .validate()
        .map_err(|_| Error::Input)?;
        if self
            .preferences
            .read()
            .await
            .map_err(|_| Error::Private)?
            .privacy
            .incognito_active
        {
            return Err(Error::Private);
        }
        // Cached derived text retains the source history's access boundary.
        self.history
            .read(
                scope.clone(),
                history::Read {
                    include_thinking: false,
                    session_id: session.into(),
                    through: Some(0),
                    position: history::Position::Start,
                },
            )
            .await
            .map_err(|_| Error::History)?;
        Ok(())
    }
    async fn record(&self, key: &str) -> Result<Option<(u64, Receipt)>, Error> {
        let record = self
            .store
            .read(key.into())
            .await
            .map_err(|_| Error::Storage)?;
        record
            .map(|r| {
                let value = r.data.value().ok_or(Error::Storage)?;
                Ok((
                    r.revision,
                    serde_json::from_value(value.clone()).map_err(|_| Error::Storage)?,
                ))
            })
            .transpose()
    }
    /// Reads one original operation without admitting generation.
    pub async fn query(
        &self,
        scope: &call::Scope,
        session: &str,
        operation: Uuid,
    ) -> Result<Option<Receipt>, Error> {
        self.check(scope, session).await?;
        Ok(self
            .record(&format!("{}/{}", prefix(session), operation))
            .await?
            .map(|(_, receipt)| receipt))
    }
    pub async fn generate(
        &self,
        parent: &call::Scope,
        session: &str,
        operation_id: Uuid,
        language: Language,
    ) -> Result<Receipt, Error> {
        self.check(parent, session).await?;
        let key = format!("{}/{}", prefix(session), operation_id);
        if let Some((_, receipt)) = self.record(&key).await? {
            return Ok(receipt);
        }
        let owned = call::Owned::new(parent.child().map_err(|_| Error::History)?);
        let scope = owned.scope();
        let history = self.collect(&scope, session).await;
        let (through, prompt) = match history {
            Ok(v) => v,
            Err(e) => {
                owned.finish().await.map_err(|_| Error::Unknown)?;
                return Err(e);
            }
        };
        let intent = Receipt::Pending {
            operation_id,
            through,
        };
        let stored = self.reserve(session, &key, &intent).await;
        let revision = match stored {
            Ok(Some(revision)) => revision,
            Ok(None) => {
                owned.finish().await.map_err(|_| Error::Unknown)?;
                return self
                    .record(&key)
                    .await?
                    .map(|(_, r)| r)
                    .ok_or(Error::Storage);
            }
            Err(_) => {
                owned.finish().await.map_err(|_| Error::Unknown)?;
                return Err(Error::Unknown);
            }
        };
        let generation = self.models.generate(
            scope.clone(),
            llm::Generate {
                language,
                prompt,
                system: Some(instruction(language).into()),
                max_output_tokens: Some(1024),
            },
        );
        let result = tokio::select! {
            biased;
            _ = scope.cancellation.cancelled() => Err(Error::Unknown),
            result = tokio::time::timeout(Duration::from_secs(30), generation) => match result {
                Ok(Ok(generation)) => Ok(if generation.finish_reason == ModelFinishReason::Stop {
                    match clean(&generation.text) {
                        Some(text) => Receipt::Ready {
                            operation_id, through, text, model_id: generation.model_id,
                        },
                        None => Receipt::Failed {
                            operation_id, through, reason: Failure::EmptyOrOversizedOutput,
                        },
                    }
                } else {
                    Receipt::Failed { operation_id, through, reason: Failure::IncompleteOutput }
                }),
                Ok(Err(ToolError::Failed(_) | ToolError::Io { .. })) => Ok(Receipt::Failed {
                    operation_id, through, reason: Failure::ModelUnavailable,
                }),
                _ => Err(Error::Unknown),
            },
        };
        scope.cancellation.cancel();
        owned.finish().await.map_err(|_| Error::Unknown)?;
        let receipt = result?;
        self.store
            .batch(vec![mutation(key, Some(revision), &receipt)?])
            .await
            .map_err(|_| Error::Unknown)?;
        Ok(receipt)
    }
    // Commit the operation intent and latest pointer together before model dispatch.
    // Completion only updates the operation record, so an older call cannot replace
    // a newer recap, and restart can discover an unfinished operation.
    async fn reserve(
        &self,
        session: &str,
        key: &str,
        receipt: &Receipt,
    ) -> Result<Option<u64>, Error> {
        let latest_key = format!("{}/latest", prefix(session));
        for _ in 0..8 {
            if self.record(key).await?.is_some() {
                return Ok(None);
            }
            let latest = self.record(&latest_key).await?;
            let mut mutations = vec![mutation(key.into(), None, receipt)?];
            if latest
                .as_ref()
                .is_none_or(|(_, r)| r.through() <= receipt.through())
            {
                mutations.push(mutation(
                    latest_key.clone(),
                    latest.map(|(r, _)| r),
                    receipt,
                )?);
            }
            match self.store.batch(mutations).await {
                Ok(records) => {
                    return records
                        .first()
                        .map(|r| Some(r.revision))
                        .ok_or(Error::Storage);
                }
                Err(storage::StoreError::Conflict { .. }) => continue,
                Err(_) => return Err(Error::Unknown),
            }
        }
        Err(Error::Storage)
    }
    async fn collect(&self, scope: &call::Scope, session: &str) -> Result<(u64, String), Error> {
        let mut through = None;
        let mut cursor = None;
        let mut text = String::new();
        for _ in 0..256 {
            if scope.cancellation.is_cancelled() {
                return Err(Error::History);
            }
            let page = self
                .history
                .read(
                    scope.clone(),
                    history::Read {
                        include_thinking: false,
                        session_id: session.into(),
                        through,
                        position: cursor.map_or(history::Position::Start, |cursor| {
                            history::Position::After { cursor }
                        }),
                    },
                )
                .await
                .map_err(|_| Error::History)?;
            let history::Page::Ready {
                through: fence,
                chunks,
                after,
                ..
            } = page;
            through = Some(fence);
            for chunk in chunks {
                text.push_str(&format!("\n{:?}: ", chunk.role));
                text.push_str(&chunk.text);
                if text.len() > INPUT_BYTES {
                    let mut offset = text.len() - INPUT_BYTES;
                    while !text.is_char_boundary(offset) {
                        offset += 1;
                    }
                    text.drain(..offset);
                }
            }
            cursor = after;
            if cursor.is_none() {
                return if text.trim().is_empty() {
                    Err(Error::Empty)
                } else {
                    Ok((fence, text))
                };
            }
        }
        Err(Error::TooLong)
    }
}
fn prefix(session: &str) -> String {
    format!(
        "session-{}",
        hex::encode(Sha256::digest(session.as_bytes()))
    )
}
fn mutation(
    key: String,
    expected_revision: Option<u64>,
    receipt: &Receipt,
) -> Result<storage::Mutation, Error> {
    Ok(storage::Mutation {
        key,
        expected_revision,
        data: storage::Data::Present(serde_json::to_value(receipt).map_err(|_| Error::Storage)?),
    })
}
fn clean(text: &str) -> Option<String> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty() && text.len() <= 4096).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::future::BoxFuture;
    use maka_agent_facts::model::ModelFinishReason;
    use maka_agent_facts::model::ModelGeneration;
    use maka_agent_facts::model::ModelUsage;
    use maka_agent_facts::tools::ToolError;
    use maka_agent_ports::llm;
    use maka_agent_ports::preferences;
    use maka_agent_ports::session::history;
    use maka_capabilities::call;
    use maka_capabilities::storage;
    use std::{
        collections::BTreeMap,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
    };
    use tokio_util::sync::CancellationToken;
    use uuid::Uuid;

    #[derive(Default)]
    struct Store(Mutex<BTreeMap<String, storage::Record>>);
    impl storage::Store for Store {
        fn read(
            &self,
            key: String,
        ) -> BoxFuture<'_, Result<Option<storage::Record>, storage::StoreError>> {
            Box::pin(async move { Ok(self.0.lock().unwrap().get(&key).cloned()) })
        }
        fn scan(
            &self,
            _: storage::Scan,
        ) -> BoxFuture<'_, Result<storage::Page, storage::StoreError>> {
            Box::pin(async { unreachable!() })
        }
        fn batch(
            &self,
            mutations: Vec<storage::Mutation>,
        ) -> BoxFuture<'_, Result<Vec<storage::Record>, storage::StoreError>> {
            Box::pin(async move {
                let mut records = self.0.lock().unwrap();
                for m in &mutations {
                    let actual = records.get(&m.key).map(|r| r.revision);
                    if actual != m.expected_revision {
                        return Err(storage::StoreError::Conflict {
                            expected: format!("{:?}", m.expected_revision),
                            actual: format!("{actual:?}"),
                        });
                    }
                }
                Ok(mutations
                    .into_iter()
                    .map(|m| {
                        let r = storage::Record {
                            revision: m.expected_revision.unwrap_or(0) + 1,
                            data: m.data,
                        };
                        records.insert(m.key, r.clone());
                        r
                    })
                    .collect())
            })
        }
    }
    #[derive(Default)]
    struct Privacy(AtomicBool);
    impl preferences::Preferences for Privacy {
        fn read(&self) -> BoxFuture<'_, Result<preferences::Snapshot, maka_capabilities::Error>> {
            Box::pin(async {
                Ok(preferences::Snapshot {
                    revision: 1,
                    privacy: maka_agent_facts::configuration::policy::PrivacyPolicy {
                        incognito_active: self.0.load(Ordering::SeqCst),
                    },
                    personalization: maka_agent_facts::configuration::policy::Personalization {
                        display_name: String::new(),
                    },
                    workspace_instructions: true,
                })
            })
        }
    }
    #[derive(Default)]
    struct History {
        endless: AtomicBool,
        denied: AtomicBool,
        reads: AtomicUsize,
    }
    impl super::History for History {
        fn read(
            &self,
            _: call::Scope,
            input: history::Read,
        ) -> BoxFuture<'_, Result<history::Page, ToolError>> {
            Box::pin(async move {
                self.reads.fetch_add(1, Ordering::SeqCst);
                if self.denied.load(Ordering::SeqCst) {
                    return Err(ToolError::Failed("denied".into()));
                }
                if input.through == Some(0) {
                    return Ok(history::Page::Ready {
                        through: 0,
                        chunks: vec![],
                        before: None,
                        after: None,
                    });
                }
                assert!(input.through.is_none() || input.through == Some(7));
                let second = matches!(input.position, history::Position::After { .. });
                let text = if second {
                    "Recent result: tests passed; deployment still pending.".into()
                } else {
                    "old history 中".repeat(6000)
                };
                Ok(history::Page::Ready {
                    through: 7,
                    chunks: vec![history::Chunk {
                        model_part: None,
                        final_output: false,
                        has_references: false,
                        model: None,
                        origin: None,
                        compaction: None,
                        field: Default::default(),
                        message_id: "m".into(),
                        turn_id: "t".into(),
                        timestamp: 1,
                        timing: None,
                        role: history::Role::Assistant,
                        position: history::RowPosition {
                            source_sequence: if second { 7 } else { 1 },
                            item_index: 0,
                        },
                        offset: 0,
                        total_bytes: text.len() as u64,
                        text,
                        tool: None,
                        attachments: vec![],
                    }],
                    before: None,
                    after: (!second || self.endless.load(Ordering::SeqCst)).then_some(
                        history::Cursor {
                            field: Default::default(),
                            position: history::RowPosition {
                                source_sequence: 2,
                                item_index: 0,
                            },
                            offset: 0,
                        },
                    ),
                })
            })
        }
    }
    #[derive(Default)]
    struct Models {
        calls: AtomicUsize,
        requests: Mutex<Vec<llm::Generate>>,
        incomplete: AtomicBool,
        unknown: AtomicBool,
        wait: AtomicBool,
        started: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }
    impl super::Models for Models {
        fn generate(
            &self,
            scope: call::Scope,
            input: llm::Generate,
        ) -> BoxFuture<'_, Result<ModelGeneration, ToolError>> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                self.requests.lock().unwrap().push(input.clone());
                self.started.notify_one();
                assert!(input.prompt.len() <= 32 * 1024);
                assert!(input.prompt.contains("deployment still pending"));
                assert_eq!(input.max_output_tokens, Some(1024));
                if self.wait.load(Ordering::SeqCst) {
                    tokio::select! {_=self.release.notified()=>{},_=scope.cancellation.cancelled()=>return Err(ToolError::OutcomeUnknown("cancelled".into()))}
                }
                if self.unknown.load(Ordering::SeqCst) {
                    return Err(ToolError::OutcomeUnknown("disconnected".into()));
                }
                Ok(ModelGeneration {
                    text: "  Tests passed.\nDeployment is next.  ".into(),
                    model_id: "model".into(),
                    finish_reason: if self.incomplete.load(Ordering::SeqCst) {
                        ModelFinishReason::Length
                    } else {
                        ModelFinishReason::Stop
                    },
                    usage: ModelUsage::default(),
                })
            })
        }
    }
    fn recaps(store: Arc<Store>, history: Arc<History>, models: Arc<Models>) -> Recaps {
        Recaps {
            store,
            history,
            models,
            preferences: Arc::new(Privacy::default()),
        }
    }
    fn scope() -> call::Scope {
        call::Issuer::default()
            .issue(
                call::Identity::Remote {
                    request_id: Uuid::new_v4(),
                },
                CancellationToken::new(),
            )
            .unwrap()
    }

    #[tokio::test]
    async fn durable_retry_and_restart_do_not_regenerate_and_cached_reads_recheck_access() {
        let store = Arc::new(Store::default());
        let history = Arc::new(History::default());
        let models = Arc::new(Models::default());
        let backend = recaps(store.clone(), history.clone(), models.clone());
        let scope = scope();
        let id = Uuid::new_v4();
        let result = backend
            .generate(&scope, "session", id, Language::ZhCn)
            .await
            .unwrap();
        assert!(
            matches!(result,Receipt::Ready{through:7,ref text,..}if text=="Tests passed. Deployment is next.")
        );
        let restarted = recaps(store, history.clone(), models.clone());
        let repeated = restarted
            .generate(&scope, "session", id, Language::ZhTw)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(&repeated).unwrap(),
            serde_json::to_value(&result).unwrap()
        );
        assert!(matches!(
            restarted.read(&scope, "session").await.unwrap(),
            Some(Receipt::Ready { .. })
        ));
        assert!(
            matches!(restarted.query(&scope, "session", id).await.unwrap(), Some(Receipt::Ready { operation_id, .. }) if operation_id == id)
        );
        assert!(
            restarted
                .query(&scope, "session", Uuid::new_v4())
                .await
                .unwrap()
                .is_none(),
            "another operation cannot claim the latest receipt"
        );
        assert_eq!(models.calls.load(Ordering::SeqCst), 1);
        {
            let requests = models.requests.lock().unwrap();
            assert_eq!(requests[0].language, Language::ZhCn);
            assert!(
                requests[0]
                    .system
                    .as_ref()
                    .unwrap()
                    .contains("最新一条实质性用户消息的语言")
            );
        }
        history.denied.store(true, Ordering::SeqCst);
        assert!(matches!(
            restarted.read(&scope, "session").await,
            Err(Error::History)
        ));
        assert!(matches!(
            restarted
                .generate(&scope, "session", id, Language::En)
                .await,
            Err(Error::History)
        ));
        assert!(matches!(
            restarted.query(&scope, "session", id).await,
            Err(Error::History)
        ));
        scope.finish().await.unwrap();
    }
    #[tokio::test]
    async fn unknown_operation_is_discoverable_after_restart_and_never_redispatched() {
        let store = Arc::new(Store::default());
        let history = Arc::new(History::default());
        let models = Arc::new(Models::default());
        models.unknown.store(true, Ordering::SeqCst);
        let backend = recaps(store.clone(), history.clone(), models.clone());
        let scope = scope();
        let id = Uuid::new_v4();
        assert!(matches!(
            backend
                .generate(&scope, "session", id, Language::ZhTw)
                .await,
            Err(Error::Unknown)
        ));
        let restarted = recaps(store, history, models.clone());
        assert!(
            matches!(restarted.read(&scope,"session").await.unwrap(),Some(Receipt::Pending{operation_id,..})if operation_id==id)
        );
        assert!(matches!(
            restarted
                .generate(&scope, "session", id, Language::ZhCn)
                .await
                .unwrap(),
            Receipt::Pending { .. }
        ));
        assert_eq!(models.calls.load(Ordering::SeqCst), 1);
        {
            let requests = models.requests.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].language, Language::ZhTw);
        }
        scope.finish().await.unwrap();
    }
    #[tokio::test]
    async fn duplicate_pending_operation_and_older_completion_cannot_replace_newer_request() {
        let store = Arc::new(Store::default());
        let history = Arc::new(History::default());
        let models = Arc::new(Models::default());
        models.wait.store(true, Ordering::SeqCst);
        let backend = Arc::new(recaps(store, history, models.clone()));
        let parent = scope();
        let first = Uuid::new_v4();
        let worker = {
            let backend = backend.clone();
            let parent = parent.clone();
            tokio::spawn(async move {
                backend
                    .generate(&parent, "session", first, Language::En)
                    .await
            })
        };
        models.started.notified().await;
        assert!(matches!(
            backend
                .generate(&parent, "session", first, Language::En)
                .await
                .unwrap(),
            Receipt::Pending { .. }
        ));
        models.wait.store(false, Ordering::SeqCst);
        let second = Uuid::new_v4();
        backend
            .generate(&parent, "session", second, Language::En)
            .await
            .unwrap();
        models.release.notify_one();
        worker.await.unwrap().unwrap();
        assert!(
            matches!(backend.read(&parent,"session").await.unwrap(),Some(Receipt::Ready{operation_id,..})if operation_id==second)
        );
        assert_eq!(models.calls.load(Ordering::SeqCst), 2);
        parent.finish().await.unwrap();
    }

    #[tokio::test]
    async fn failed_receipt_keeps_original_language_after_restart() {
        let store = Arc::new(Store::default());
        let history = Arc::new(History::default());
        let models = Arc::new(Models::default());
        models.incomplete.store(true, Ordering::SeqCst);
        let backend = recaps(store.clone(), history.clone(), models.clone());
        let scope = scope();
        let id = Uuid::new_v4();
        let original = backend
            .generate(&scope, "session", id, Language::ZhTw)
            .await
            .unwrap();
        assert!(matches!(
            original,
            Receipt::Failed {
                reason: Failure::IncompleteOutput,
                ..
            }
        ));
        let restarted = recaps(store, history, models.clone());
        let repeated = restarted
            .generate(&scope, "session", id, Language::ZhCn)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(repeated).unwrap(),
            serde_json::to_value(original).unwrap()
        );
        {
            let requests = models.requests.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].language, Language::ZhTw);
            assert!(
                requests[0]
                    .system
                    .as_ref()
                    .unwrap()
                    .contains("最新一則實質性使用者訊息的語言")
            );
        }
        scope.finish().await.unwrap();
    }

    #[tokio::test]
    async fn oversized_history_and_privacy_refuse_before_model_dispatch() {
        let store = Arc::new(Store::default());
        let history = Arc::new(History::default());
        let models = Arc::new(Models::default());
        history.endless.store(true, Ordering::SeqCst);
        let mut backend = recaps(store.clone(), history.clone(), models.clone());
        let parent = scope();
        assert!(matches!(
            backend
                .generate(&parent, "session", Uuid::new_v4(), Language::En)
                .await,
            Err(Error::TooLong)
        ));
        assert_eq!(models.calls.load(Ordering::SeqCst), 0);
        assert!(store.0.lock().unwrap().is_empty());
        let private = Arc::new(Privacy::default());
        private.0.store(true, Ordering::SeqCst);
        backend.preferences = private;
        let reads = history.reads.load(Ordering::SeqCst);
        assert!(matches!(
            backend.read(&parent, "session").await,
            Err(Error::Private)
        ));
        assert_eq!(history.reads.load(Ordering::SeqCst), reads);
        parent.finish().await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_settles_model_and_keeps_recoverable_intent() {
        let store = Arc::new(Store::default());
        let history = Arc::new(History::default());
        let models = Arc::new(Models::default());
        models.wait.store(true, Ordering::SeqCst);
        let backend = Arc::new(recaps(store, history, models.clone()));
        let parent = scope();
        let id = Uuid::new_v4();
        let worker = {
            let backend = backend.clone();
            let parent = parent.clone();
            tokio::spawn(
                async move { backend.generate(&parent, "session", id, Language::En).await },
            )
        };
        models.started.notified().await;
        parent.cancellation.cancel();
        assert!(matches!(worker.await.unwrap(), Err(Error::Unknown)));
        parent.finish().await.unwrap();
        let current = scope();
        assert!(
            matches!(backend.read(&current,"session").await.unwrap(),Some(Receipt::Pending{operation_id,..})if operation_id==id)
        );
        assert!(matches!(
            backend
                .generate(&current, "session", id, Language::En)
                .await
                .unwrap(),
            Receipt::Pending { .. }
        ));
        assert_eq!(models.calls.load(Ordering::SeqCst), 1);
        current.finish().await.unwrap();
    }
}
