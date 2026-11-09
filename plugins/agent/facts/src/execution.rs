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

use maka_sandbox::workspace::{WorkspaceIdentity, WorkspaceOrigin};
pub use maka_sandbox::{Approval as ApprovalPolicy, Mode as SandboxMode};
use serde::{Deserialize, Serialize};

#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum CollaborationMode {
    /// Durable sessions and invocations still carry this field. Planning mode no
    /// longer exists, so a record written in it continues as an ordinary session.
    #[default]
    #[serde(alias = "plan")]
    Agent,
}

/// A native tool surface selected by the Host, independent of plugin tool names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToolProfile {
    #[serde(rename = "headless-coding-v1")]
    HeadlessCodingV1,
}

mod behavior;
pub use behavior::BehaviorId;
mod tool_policy;
pub use tool_policy::{CodeLanguage, EditingTools};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    Ultra,
}

impl ThinkingLevel {
    /// Display order; support still comes from the selected model's declaration.
    pub const ALL: [Self; 8] = [
        Self::Off,
        Self::Minimal,
        Self::Low,
        Self::Medium,
        Self::High,
        Self::Xhigh,
        Self::Max,
        Self::Ultra,
    ];
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolMode {
    #[default]
    Direct,
    CodeMode,
}

/// Public model identity. Credentials and provider handles never belong here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ModelBinding {
    pub connection_id: String,
    pub connection_slug: String,
    pub model: String,
}

/// Actual Host-composed instructions admitted with this execution, not a
/// pointer to mutable root settings or a replacement for conversation history.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemPrompt {
    pub text: String,
    pub policy_revision: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<crate::composition::SourceRevision>,
}

impl SystemPrompt {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.text.trim().is_empty()
            || self.policy_revision > crate::configuration::validation::MAX_SAFE_INTEGER
        {
            return Err("invalid system prompt");
        }
        Ok(())
    }
}

/// Immutable admission context, committed in the opening before dispatch.
/// Later Session mutations must not reinterpret relative paths or grants.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunConfiguration {
    /// Frozen effective instructions for automatic and manual context compaction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction_prompt: Option<String>,
    /// Frozen file-editing policy. Older invocations retain their original unfiltered tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editing_tools: Option<EditingTools>,
    /// Frozen discovery policy for this execution, including continuations.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub tool_discovery: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_composition: Option<ToolComposition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<SystemPrompt>,
    pub cwd: String,
    /// Captured from the workspace marker, never reconstructed from a later path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_identity: Option<WorkspaceIdentity>,
    /// Frozen shared-workspace authority; None only for non-Session execution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_binding: Option<maka_sandbox::workspace::BindingStamp>,
    pub workspace_origin: WorkspaceOrigin,
    pub sandbox_mode: SandboxMode,
    pub approval_policy: ApprovalPolicy,
    /// Identifies the admitted boundary even when a later configuration returns
    /// to the same modes and paths. Equality of values does not restore a grant.
    pub boundary_revision: u64,
    pub collaboration_mode: CollaborationMode,
    pub orchestration_mode: BehaviorId,
    pub tool_mode: ToolMode,
    /// Frozen Code Mode interpreter. Historical invocations used JavaScript.
    #[serde(default, skip_serializing_if = "CodeLanguage::is_javascript")]
    pub code_language: CodeLanguage,
    /// None means there was no Session-owned model binding (e.g. local Code).
    pub model: Option<ModelBinding>,
    pub thinking_level: Option<ThinkingLevel>,
    #[serde(default, skip_serializing_if = "crate::language::Language::is_english")]
    pub language: crate::language::Language,
}

/// Admission evidence for Host-owned handlers whose behavior is not in schema.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolComposition {
    pub clients: crate::capability::ClientComposition,
    #[serde(default)]
    pub native_tools: NativeToolSet,
    #[serde(default)]
    pub editing_tools: EditingTools,
    /// Frozen Client capabilities usable by Host services, not advertised to the model.
    #[serde(default, skip_serializing_if = "std::collections::BTreeSet::is_empty")]
    pub private_clients: std::collections::BTreeSet<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_tools: Option<std::collections::BTreeSet<String>>,
}

/// Host-owned handlers retain their access boundary across recovery. A plugin
/// may narrow the baseline, but cannot replace a core handler with its own.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeToolSet {
    #[default]
    Workspace,
    Attachments,
}

#[cfg(test)]
mod tests {
    use super::CollaborationMode;

    #[test]
    fn a_record_written_in_planning_mode_reads_as_agent() {
        assert_eq!(
            serde_json::from_str::<CollaborationMode>(r#""plan""#).unwrap(),
            CollaborationMode::Agent
        );
    }
}
