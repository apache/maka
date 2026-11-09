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

use crate::{Error, invalid, schedule::Schedule};
use maka_agent_facts::execution::BehaviorId;
use maka_agent_facts::execution::CollaborationMode;
use maka_agent_facts::execution::SandboxMode;
use maka_agent_facts::execution::ThinkingLevel;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Timing policy only needs validation and notification delivery semantics.
/// Each execution owner supplies its own effect and authority types.
pub trait TaskEffect: Clone + Serialize {
    fn validate(&self) -> Result<(), Error>;
    fn is_notification(&self) -> bool;
}
impl TaskEffect for Effect {
    fn validate(&self) -> Result<(), Error> {
        Effect::validate(self)
    }
    fn is_notification(&self) -> bool {
        matches!(self, Self::Notify(_))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Active,
    Paused,
    Completed,
    Expired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Ok,
    Failed,
    Blocked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Bot {
    Telegram,
    Feishu,
    Wecom,
    Wechat,
    Discord,
    Dingtalk,
    Qq,
    Slack,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "channel",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Notification {
    Local,
    Bot { platform: Bot, chat_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Effect {
    Notify(Notification),
    SessionResume { session_id: String },
    AgentRun { execution: ExecutionTemplate },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionTemplate {
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub llm_connection_id: String,
    pub llm_connection_slug: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<ThinkingLevel>,
    pub sandbox_mode: SandboxMode,
    pub approval_policy: maka_agent_facts::execution::ApprovalPolicy,
    pub collaboration_mode: CollaborationMode,
    pub orchestration_mode: BehaviorId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_tools: Option<std::collections::BTreeSet<String>>,
}
impl Effect {
    pub fn validate(&self) -> Result<(), Error> {
        match self {
            Self::Notify(Notification::Local) => Ok(()),
            Self::Notify(Notification::Bot { chat_id, .. }) => text(chat_id),
            Self::SessionResume { session_id } => text(session_id),
            Self::AgentRun { execution } => {
                text(&execution.cwd)?;
                for value in [
                    &execution.llm_connection_id,
                    &execution.llm_connection_slug,
                    &execution.model,
                ] {
                    text(value)?;
                }
                if let Some(project) = &execution.project_id {
                    text(project)?;
                }
                if let Some(tools) = &execution.bound_tools {
                    for tool in tools {
                        if tool.is_empty()
                            || tool.chars().any(|ch| ch.is_control() || ch.is_whitespace())
                        {
                            return Err(invalid("invalid bound tool name"));
                        }
                    }
                }
                Ok(())
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Creator {
    User,
    Agent { session_id: String },
    System,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Intent {
    Text { body: String },
}
impl Intent {
    pub fn body(&self) -> &str {
        match self {
            Self::Text { body } => body,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Run {
    pub id: String,
    pub at: i64,
    pub outcome: Outcome,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<maka_agent_facts::durable::RunId>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Task<E = Effect> {
    pub id: String,
    pub title: String,
    pub intent: Intent,
    pub schedule: Schedule,
    pub effect: E,
    pub status: Status,
    pub next_fire_at: Option<i64>,
    pub last_fire_at: Option<i64>,
    pub fire_count: u32,
    pub max_fires: Option<u32>,
    pub expires_at: Option<i64>,
    pub created_by: Creator,
    pub created_at: i64,
    pub updated_at: i64,
    pub runs: Vec<Run>,
    pub last_error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Create<E = Effect> {
    pub title: String,
    pub intent_body: String,
    pub schedule: Schedule,
    pub effect: E,
    #[serde(default)]
    pub max_fires: Option<u32>,
    #[serde(default)]
    pub expires_at: Option<i64>,
}
impl<E: TaskEffect> Create<E> {
    pub fn validate(&self, now: i64) -> Result<(), Error> {
        self.validate_fields()?;
        if self.expires_at.is_some_and(|expires| expires <= now) {
            return Err(invalid("expiry must be a future timestamp"));
        }
        if let Schedule::Once { run_at } = self.schedule
            && run_at <= now
        {
            return Err(invalid("one-shot trigger must be in the future"));
        }
        Ok(())
    }

    pub(crate) fn validate_fields(&self) -> Result<(), Error> {
        text(&self.title)?;
        if !self.effect.is_notification() {
            text(&self.intent_body)?;
        }
        self.schedule.validate()?;
        self.effect.validate()?;
        if self.max_fires.is_some_and(|max| max == 0) {
            return Err(invalid("maxFires must be positive"));
        }
        if self
            .expires_at
            .is_some_and(|expires| !(0..=(1_i64 << 53) - 1).contains(&expires))
        {
            return Err(invalid("expiry must be a valid timestamp"));
        }
        Ok(())
    }
}
pub(crate) fn text(value: &str) -> Result<(), Error> {
    if value.trim().is_empty() || value.contains('\0') {
        return Err(invalid("empty or invalid task field"));
    }
    Ok(())
}
