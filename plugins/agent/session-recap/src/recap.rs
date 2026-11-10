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
use maka_agent_ports::session::history;
use maka_capabilities::call;
use maka_plugin_core::storage;
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
}
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Session recap input is invalid")]
    Input,
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
            let fence = fence.ok_or(Error::History)?;
            through = Some(fence);
            for chunk in chunks {
                text.push_str(&format!("\n{:?}", chunk.role));
                if let Some(tool) = &chunk.tool {
                    text.push_str(&format!(" [{}]", tool.tool_use_id));
                    if let Some(call) = &tool.call {
                        text.push_str(&format!(" {}", call.name));
                    }
                }
                text.push_str(": ");
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
