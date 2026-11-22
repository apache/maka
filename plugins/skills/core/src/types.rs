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

type Result<T> = std::result::Result<T, &'static str>;
use serde::{Deserialize, Serialize};
mod receipt;
mod validation;
pub use receipt::{SkillFailedReceipt, SkillInvocationReceipt, SkillLoadedReceipt};
pub use validation::SkillValidationCode;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SkillInvocationResult {
    pub loaded: Vec<LoadedSkill>,
    pub failed: Vec<SkillInvocationFailure>,
    pub receipts: Vec<SkillInvocationReceipt>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LoadedSkill {
    pub id: String,
    pub name: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
pub enum SkillInvocationFailure {
    Request(SkillRequestFailure),
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SkillRequestFailure {
    pub request: String,
    pub reason: SkillFailureReason,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkillFailureReason {
    InvalidName,
    NotFound,
    Disabled,
    HostIncompatible,
    ResolutionFailed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkillInvocationMode {
    Explicit,
    ModelTool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkillScope {
    Project,
    Workspace,
    User,
    Custom,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkillSource {
    Maka,
    Agents,
    Custom,
}

impl SkillInvocationResult {
    pub fn is_empty(&self) -> bool {
        self.loaded.is_empty() && self.failed.is_empty() && self.receipts.is_empty()
    }

    pub fn validate(&self) -> Result<()> {
        for loaded in &self.loaded {
            identity(&loaded.id, &loaded.name)?;
        }
        for failed in &self.failed {
            match failed {
                SkillInvocationFailure::Request(failure) => text(&failure.request)?,
            }
        }
        for receipt in &self.receipts {
            match receipt {
                SkillInvocationReceipt::Loaded(r) => {
                    text(&r.request)?;
                    text(&r.skill_ref)?;
                    identity(&r.id, &r.name)?;
                }
                SkillInvocationReceipt::Failed(r) => {
                    text(&r.request)?;
                }
            }
        }
        Ok(())
    }
}
fn identity(id: &str, name: &str) -> Result<()> {
    text(id)?;
    text(name)
}
fn text(value: &str) -> Result<()> {
    if value.is_empty() {
        Err("Invalid empty string")
    } else {
        Ok(())
    }
}
