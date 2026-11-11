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
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Execution owners supply effect validation and delivery semantics.
/// Each execution owner supplies its own effect and authority types.
pub trait TaskEffect: Clone + Serialize {
    fn validate(&self) -> Result<(), Error>;
    fn is_notification(&self) -> bool;
    fn allows_empty_intent(&self) -> bool {
        self.is_notification()
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
pub struct Task<E> {
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
pub struct Create<E> {
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
        if !self.effect.allows_empty_intent() || !self.intent_body.trim().is_empty() {
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
