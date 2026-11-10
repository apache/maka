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

use serde::{Deserialize, Serialize};
mod output;
pub use output::Output;

/// Executor-owned model selection, independent of Host model connections.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ExecutorSettings")]
pub struct Settings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<Effort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
}
impl Settings {
    pub fn is_empty(&self) -> bool {
        self.model.is_none() && self.thinking_level.is_none() && self.runtime.is_none()
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        for value in [&self.model, &self.runtime].into_iter().flatten() {
            selector(value)?;
        }
        Ok(())
    }
}

/// Runtime-native effort, not a Host model's closed reasoning enum.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(try_from = "String", into = "String")]
#[schemars(with = "String", rename = "ExecutorEffort")]
pub struct Effort(String);
impl Effort {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl TryFrom<String> for Effort {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        selector(&value)?;
        Ok(Self(value))
    }
}
impl From<Effort> for String {
    fn from(value: Effort) -> Self {
        value.0
    }
}
fn selector(value: &str) -> Result<(), &'static str> {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        return Err("executor selector must be nonempty without control characters");
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentExecutorSelection")]
pub struct Selection {
    #[schemars(length(min = 1))]
    pub executor: String,
    pub settings: Settings,
}

/// The concrete implementation accepted for an external execution.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub executor_id: ExecutorId,
    pub package_id: String,
    pub entry_id: String,
    pub activation: String,
}

impl Binding {
    pub fn validate(&self) -> Result<(), &'static str> {
        ExecutorId::try_from(self.package_id.clone())?;
        ExecutorId::try_from(self.entry_id.clone())?;
        crate::interaction::entity_id(&self.activation)?;
        Ok(())
    }
}

/// A plugin-contributed execution backend identity, not a model or connection ID.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ExecutorId(String);

impl ExecutorId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for ExecutorId {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if !value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        {
            return Err("invalid executor ID");
        }
        Ok(Self(value))
    }
}

impl From<ExecutorId> for String {
    fn from(value: ExecutorId) -> Self {
        value.0
    }
}

/// The next turn's choice, independent of an already admitted execution.
/// Model revisions are resolved afresh; preferences never grant execution authority.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentBackendPreference")]
pub enum BackendPreference {
    Model {
        #[schemars(length(min = 1))]
        connection_id: String,
        #[schemars(length(min = 1))]
        model_id: String,
        thinking_level: Option<crate::execution::ThinkingLevel>,
    },
    Executor {
        selection: crate::executor::Selection,
    },
}

pub const NATIVE_TASK_PROTOCOL: &str = "maka.native-executor-task";

/// Native captures the concrete selected executor before dispatch. The payload
/// belongs to that adapter; this descriptor is not a live grant.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDescriptor<T> {
    pub protocol: String,
    pub source: Binding,
    pub payload: T,
}
