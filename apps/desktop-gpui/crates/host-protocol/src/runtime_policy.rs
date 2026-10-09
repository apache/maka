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

//! `runtime.policy.query` and `runtime.policy.mutate`: the Host-owned
//! runtime policy, every section of it, and every mutation that writes one.
//!
//! Source: `packages/runtime-host/src/protocol/runtime-policy.ts`
//! (`RUNTIME_POLICY_OPERATION_SPECS`, `decodeRuntimePolicySnapshot`,
//! `decodeRuntimePolicyMutation`, `decodeRuntimePolicyMutationResult`); the
//! policy itself is `RuntimePolicy` in `packages/core/src/runtime-policy.ts`,
//! decoded by `decodeCanonicalRuntimePolicy` and written by
//! `normalizeRuntimePolicyMutation` in
//! `packages/core/src/runtime-policy/policy-codec.ts`.
//!
//! `runtime.policy.mutate` fails with `host_not_ready`, `host_draining`,
//! `operation_unavailable`, `invalid_request` (a value the Host's normalizer
//! rejects), `internal_failure`, `persistence_failed`, or
//! `commit_outcome_unknown` (`MUTATION_ERRORS`); `runtime.policy.query` with
//! the first three, `internal_failure`, or `persistence_failed`
//! (`QUERY_ERRORS`). A stale `expectedRevision` is not an error: the result
//! is a `revision_conflict`.
//!
//! The network proxy's credential is written with its policy through
//! `runtime.policy.network-proxy.update`, which carries a credential vault
//! basis ([`crate::NetworkProxyUpdate`]).

use serde::{Deserialize, Serialize};

use crate::{Operation, ThinkingLevel};

/// `RuntimePolicyQueryInput`: always the empty object (`decodeEmptyInput`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
pub struct RuntimePolicyQueryInput {}

/// `RuntimePolicySnapshot` (`decodeRuntimePolicySnapshot`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct RuntimePolicySnapshot {
    /// The `expectedRevision` of a mutation.
    pub revision: u64,
    pub policy: RuntimePolicy,
}

/// `RuntimePolicy` (`normalizeRuntimePolicy`): every section is required
/// except `jev`, which a policy written before epoch 183 lacks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct RuntimePolicy {
    /// `{ enabled }`; absent means disabled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jev: Option<JevPolicy>,
    pub network_proxy: NetworkProxyPolicy,
    pub personalization: PersonalizationPolicy,
    pub memory: MemoryPolicy,
    pub workspace_instructions: WorkspaceInstructionsPolicy,
    pub privacy: PrivacyPolicy,
    pub chat_defaults: ChatDefaults,
    pub web_search: WebSearchPolicy,
    pub subagents: SubagentSettings,
    pub shell: ShellPolicy,
    pub external_agents: ExternalAgentsPolicy,
}

/// `RuntimePolicy['jev']` (`normalizeJev`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct JevPolicy {
    pub enabled: bool,
}

impl JevPolicy {
    pub fn new(enabled: bool) -> Self {
        Self { enabled }
    }
}

wire_enum! {
    /// `ProxyProtocol` (packages/core/src/settings.ts).
    pub enum ProxyProtocol {
        Http = "http",
        Https = "https",
        Socks5 = "socks5",
    }
}

/// `RuntimePolicy['networkProxy']` (`normalizeNetworkProxy`). The host must
/// not be empty while the proxy is enabled; the port is 1 to 65535. The
/// password is a credential, never part of the policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct NetworkProxyPolicy {
    pub enabled: bool,
    pub protocol: ProxyProtocol,
    pub host: String,
    pub port: u16,
    pub auth_enabled: bool,
    pub username: String,
    pub bypass_list: Vec<String>,
    /// Domains the Host always sends direct (`localhost`, private ranges).
    pub auto_bypass_domains: Vec<String>,
}

/// `RuntimePolicy['personalization']` (`normalizePersonalization`): at most
/// 256 and 4096 characters.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct PersonalizationPolicy {
    pub display_name: String,
    pub assistant_tone: String,
}

impl PersonalizationPolicy {
    pub fn new(display_name: impl Into<String>, assistant_tone: impl Into<String>) -> Self {
        Self { display_name: display_name.into(), assistant_tone: assistant_tone.into() }
    }
}

/// `RuntimePolicy['memory']` (`normalizeMemory`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct MemoryPolicy {
    pub enabled: bool,
    /// Whether the agent may read memory on its own.
    pub agent_read_enabled: bool,
}

impl MemoryPolicy {
    pub fn new(enabled: bool, agent_read_enabled: bool) -> Self {
        Self { enabled, agent_read_enabled }
    }
}

/// `RuntimePolicy['workspaceInstructions']` (`normalizeWorkspaceInstructions`):
/// whether tasks follow a project's AGENTS.md, CLAUDE.md, or GEMINI.md.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct WorkspaceInstructionsPolicy {
    pub enabled: bool,
}

impl WorkspaceInstructionsPolicy {
    pub fn new(enabled: bool) -> Self {
        Self { enabled }
    }
}

/// `RuntimePolicy['privacy']` (`normalizePrivacy`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct PrivacyPolicy {
    /// Incognito: local memory, web search, and scheduled triggers pause.
    pub incognito_active: bool,
}

impl PrivacyPolicy {
    pub fn new(incognito_active: bool) -> Self {
        Self { incognito_active }
    }
}

wire_enum! {
    /// `ChatDefaultPermissionMode` (`CHAT_DEFAULT_PERMISSION_MODES` in
    /// packages/core/src/settings.ts): the permission modes a new task can
    /// start in. `explore` (Read only) is chosen per task only.
    pub enum ChatDefaultPermissionMode {
        Ask = "ask",
        Bypass = "bypass",
    }
}

/// `RuntimePolicy['chatDefaults']` (`normalizeChatDefaults`): what a new
/// task starts with. A write sends the whole object back, so the fields
/// this client does not edit are kept as read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ChatDefaults {
    pub permission_mode: ChatDefaultPermissionMode,
    /// Deprecated in the Host (task creation ignores it); kept as read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<ThinkingLevel>,
    /// Code Mode for new tasks; the Host stores only `true` (off is absent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_mode_enabled: Option<bool>,
}

impl ChatDefaults {
    /// These defaults with another permission mode.
    pub fn with_permission_mode(mut self, permission_mode: ChatDefaultPermissionMode) -> Self {
        self.permission_mode = permission_mode;
        self
    }

    /// These defaults with Code Mode on or off, written as the Host stores
    /// it: `true`, or absent.
    pub fn with_code_mode(mut self, enabled: bool) -> Self {
        self.code_mode_enabled = enabled.then_some(true);
        self
    }
}

wire_enum! {
    /// `WebSearchProvider` (`WEB_SEARCH_PROVIDERS` in
    /// packages/core/src/web-search.ts): the model's own search, or Tavily.
    pub enum WebSearchProvider {
        Model = "model",
        Tavily = "tavily",
    }
}

/// `RuntimePolicy['webSearch']` (`normalizeWebSearch`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct WebSearchPolicy {
    pub enabled: bool,
    pub default_provider: WebSearchProvider,
}

impl WebSearchPolicy {
    pub fn new(enabled: bool, default_provider: WebSearchProvider) -> Self {
        Self { enabled, default_provider }
    }
}

wire_enum! {
    /// `SubagentProfile` (`SUBAGENT_PROFILES` in
    /// packages/core/src/subagent-settings.ts): the capability a subagent
    /// preset routes to a model.
    pub enum SubagentProfile {
        LocalRead = "local_read",
        WebResearch = "web_research",
        Implementation = "implementation",
    }
}

/// `SubagentSettings` (`normalizeSubagentSettings`): at most 64 presets.
/// On a write the Host drops a preset it cannot accept (an unsafe id, a
/// duplicate, an empty or over-long name) rather than refusing the whole
/// list, and trims the text fields.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SubagentSettings {
    pub presets: Vec<SubagentPreset>,
}

impl SubagentSettings {
    pub fn new(presets: Vec<SubagentPreset>) -> Self {
        Self { presets }
    }
}

/// `SubagentPreset`: a user-approved model route for one subagent profile.
/// The id is 1 to 128 characters of `[A-Za-z0-9._:-]`; the name 1 to 128,
/// the description at most 1000 (longer is cut).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SubagentPreset {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub profile: SubagentProfile,
    pub connection_slug: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<ThinkingLevel>,
    pub enabled: bool,
}

impl SubagentPreset {
    /// An enabled preset with no description and the model's own thinking
    /// level.
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        profile: SubagentProfile,
        connection_slug: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            description: String::new(),
            profile,
            connection_slug: connection_slug.into(),
            model: model.into(),
            thinking_level: None,
            enabled: true,
        }
    }
}

wire_enum! {
    /// `ShellPreference` (packages/core/src/settings.ts): the platform's
    /// default shell, or Git Bash on Windows.
    pub enum ShellPreference {
        Auto = "auto",
        GitBash = "git_bash",
    }
}

/// `RuntimePolicy['shell']` (`normalizeShell`): the executable is kept
/// while `auto` is chosen, and required (an absolute path to `bash.exe`)
/// for `git_bash`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ShellPolicy {
    pub preference: ShellPreference,
    pub executable: String,
}

impl ShellPolicy {
    pub fn new(preference: ShellPreference, executable: impl Into<String>) -> Self {
        Self { preference, executable: executable.into() }
    }
}

/// `RuntimePolicy['externalAgents']` (`normalizeExternalAgents`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ExternalAgentsPolicy {
    pub antigravity: AntigravityPolicy,
}

impl ExternalAgentsPolicy {
    pub fn new(antigravity: AntigravityPolicy) -> Self {
        Self { antigravity }
    }
}

/// The Antigravity ACP agent: its executable, an absolute macOS path, or
/// empty for none.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct AntigravityPolicy {
    pub executable: String,
}

impl AntigravityPolicy {
    pub fn new(executable: impl Into<String>) -> Self {
        Self { executable: executable.into() }
    }
}

/// `AgentRuntimeSettingsPatch` (`normalizeAgentRuntimeSettingsPatch`): the
/// fields to change in five sections, each left as it is when absent. What
/// the agent's own settings tools send; a settings page sends the whole
/// section instead.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct AgentRuntimeSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub personalization: Option<PersonalizationPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<MemoryPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_instructions: Option<EnabledPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub privacy: Option<PrivacyPatch>,
    /// Only `enabled`: the provider is chosen through `set_web_search`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_search: Option<EnabledPatch>,
}

/// `normalizePersonalizationPatch`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct PersonalizationPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant_tone: Option<String>,
}

/// `normalizeMemoryPatch`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct MemoryPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_read_enabled: Option<bool>,
}

/// `normalizeEnabledPatch`: workspace instructions and web search.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct EnabledPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

impl EnabledPatch {
    pub fn new(enabled: bool) -> Self {
        Self { enabled: Some(enabled) }
    }
}

/// `normalizePrivacyPatch`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct PrivacyPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub incognito_active: Option<bool>,
}

impl PrivacyPatch {
    pub fn new(incognito_active: bool) -> Self {
        Self { incognito_active: Some(incognito_active) }
    }
}

/// `RuntimePolicyMutation` (`normalizeMutationOperation`): each `set_*`
/// replaces one section with the value given, whole; the Host's normalizer
/// accepts no field it does not know, so a value read from the Host is
/// written back as read, with only what the change is about changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum RuntimePolicyMutation {
    SetJev { value: JevPolicy },
    SetNetworkProxy { value: NetworkProxyPolicy },
    SetPersonalization { value: PersonalizationPolicy },
    SetMemory { value: MemoryPolicy },
    SetWorkspaceInstructions { value: WorkspaceInstructionsPolicy },
    SetPrivacy { value: PrivacyPolicy },
    SetChatDefaults { value: ChatDefaults },
    SetWebSearch { value: WebSearchPolicy },
    SetSubagents { value: SubagentSettings },
    SetExternalAgents { value: ExternalAgentsPolicy },
    SetShell { value: ShellPolicy },
    PatchAgentSettings { value: AgentRuntimeSettingsPatch },
}

/// `MutateRuntimePolicyInput` (`normalizeRuntimePolicyMutation`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct RuntimePolicyMutateInput {
    pub expected_revision: u64,
    pub operation: RuntimePolicyMutation,
}

impl RuntimePolicyMutateInput {
    pub fn new(expected_revision: u64, operation: RuntimePolicyMutation) -> Self {
        Self { expected_revision, operation }
    }
}

/// `RuntimePolicyMutateResult` (`decodeRuntimePolicyMutationResult`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum RuntimePolicyMutateResult {
    Committed {
        revision: u64,
    },
    /// The policy changed since it was read; read it again and retry.
    #[serde(rename_all = "camelCase")]
    RevisionConflict {
        expected_revision: u64,
        actual_revision: u64,
    },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `runtime.policy.query` (mode `query`).
#[derive(Debug)]
pub enum RuntimePolicyQuery {}

impl Operation for RuntimePolicyQuery {
    const NAME: &'static str = "runtime.policy.query";
    type Input = RuntimePolicyQueryInput;
    type Output = RuntimePolicySnapshot;
}

/// `runtime.policy.mutate` (mode `command`).
#[derive(Debug)]
pub enum RuntimePolicyMutate {}

impl Operation for RuntimePolicyMutate {
    const NAME: &'static str = "runtime.policy.mutate";
    type Input = RuntimePolicyMutateInput;
    type Output = RuntimePolicyMutateResult;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    /// A policy in the shape `decodeCanonicalRuntimePolicy` accepts, with a
    /// subagent preset, Git Bash, Jev, and an authenticated proxy: every
    /// section with something other than its default in it.
    fn policy_sample() -> Value {
        json!({
            "jev": {"enabled": true},
            "networkProxy": {"enabled": true, "protocol": "socks5", "host": "proxy.lan",
                             "port": 1080, "authEnabled": true, "username": "me",
                             "bypassList": ["metaso.cn"], "autoBypassDomains": ["localhost"]},
            "personalization": {"displayName": "JK", "assistantTone": "Terse."},
            "memory": {"enabled": false, "agentReadEnabled": true},
            "workspaceInstructions": {"enabled": false},
            "privacy": {"incognitoActive": true},
            "chatDefaults": {"permissionMode": "ask", "codeModeEnabled": true,
                             "thinkingLevel": "high"},
            "webSearch": {"enabled": true, "defaultProvider": "tavily"},
            "subagents": {"presets": [{"id": "reader.1", "name": "Reader", "description": "",
                          "profile": "local_read", "connectionSlug": "ollama-local",
                          "model": "qwen2.5:7b", "thinkingLevel": "low", "enabled": true}]},
            "shell": {"preference": "git_bash", "executable": "C:\\Git\\bin\\bash.exe"},
            "externalAgents": {"antigravity": {"executable": "/Applications/Antigravity"}}
        })
    }

    #[test]
    fn every_policy_section_decodes_and_encodes_as_read() {
        let snapshot = json!({"revision": 9, "policy": policy_sample()});
        let decoded: RuntimePolicySnapshot =
            serde_json::from_value(snapshot.clone()).expect("decode");
        assert_eq!(serde_json::to_value(&decoded).expect("encode"), snapshot);
        let policy = decoded.policy;
        assert_eq!(policy.jev, Some(JevPolicy::new(true)));
        assert_eq!(policy.network_proxy.protocol, ProxyProtocol::Socks5);
        assert_eq!(policy.network_proxy.port, 1080);
        assert_eq!(policy.personalization.display_name, "JK");
        assert_eq!(policy.memory, MemoryPolicy::new(false, true));
        assert!(!policy.workspace_instructions.enabled);
        assert!(policy.privacy.incognito_active);
        assert_eq!(policy.chat_defaults.thinking_level, Some(ThinkingLevel::High));
        assert_eq!(policy.web_search.default_provider, WebSearchProvider::Tavily);
        let preset = &policy.subagents.presets[0];
        assert_eq!(preset.profile, SubagentProfile::LocalRead);
        assert_eq!(preset.connection_slug, "ollama-local");
        assert_eq!(policy.shell.preference, ShellPreference::GitBash);
        assert_eq!(policy.external_agents.antigravity.executable, "/Applications/Antigravity");

        // Without `jev` (a policy from before epoch 183) it reads as absent
        // and stays absent; a literal the client does not know is kept.
        let mut older = policy_sample();
        older.as_object_mut().expect("object").remove("jev");
        older["webSearch"]["defaultProvider"] = json!("exa");
        let decoded: RuntimePolicy = serde_json::from_value(older.clone()).expect("decode");
        assert_eq!(decoded.jev, None);
        assert_eq!(decoded.web_search.default_provider, WebSearchProvider::Other("exa".into()));
        assert_eq!(serde_json::to_value(&decoded).expect("encode"), older);
    }

    #[test]
    fn a_section_without_a_required_field_is_refused() {
        let mut broken = policy_sample();
        broken["shell"].as_object_mut().expect("object").remove("executable");
        assert!(serde_json::from_value::<RuntimePolicy>(broken).is_err());
        let mut broken = policy_sample();
        broken.as_object_mut().expect("object").remove("externalAgents");
        assert!(serde_json::from_value::<RuntimePolicy>(broken).is_err());
    }

    /// Each mutation kind encodes as `normalizeMutationOperation` reads it:
    /// `{kind, value}` with the section's camelCase fields, whole.
    #[test]
    fn every_mutation_kind_encodes_as_the_host_reads_it() {
        let policy: RuntimePolicy = serde_json::from_value(policy_sample()).expect("decode");
        let sample = policy_sample();
        let cases: Vec<(RuntimePolicyMutation, Value)> = vec![
            (
                RuntimePolicyMutation::SetJev { value: JevPolicy::new(false) },
                json!({"kind": "set_jev", "value": {"enabled": false}}),
            ),
            (
                RuntimePolicyMutation::SetNetworkProxy { value: policy.network_proxy.clone() },
                json!({"kind": "set_network_proxy", "value": sample["networkProxy"]}),
            ),
            (
                RuntimePolicyMutation::SetPersonalization {
                    value: PersonalizationPolicy::new("Ada", ""),
                },
                json!({"kind": "set_personalization",
                       "value": {"displayName": "Ada", "assistantTone": ""}}),
            ),
            (
                RuntimePolicyMutation::SetMemory { value: MemoryPolicy::new(true, false) },
                json!({"kind": "set_memory",
                       "value": {"enabled": true, "agentReadEnabled": false}}),
            ),
            (
                RuntimePolicyMutation::SetWorkspaceInstructions {
                    value: WorkspaceInstructionsPolicy::new(true),
                },
                json!({"kind": "set_workspace_instructions", "value": {"enabled": true}}),
            ),
            (
                RuntimePolicyMutation::SetPrivacy { value: PrivacyPolicy::new(false) },
                json!({"kind": "set_privacy", "value": {"incognitoActive": false}}),
            ),
            (
                RuntimePolicyMutation::SetChatDefaults {
                    value: policy
                        .chat_defaults
                        .clone()
                        .with_permission_mode(ChatDefaultPermissionMode::Bypass),
                },
                json!({"kind": "set_chat_defaults", "value": {"permissionMode": "bypass",
                       "codeModeEnabled": true, "thinkingLevel": "high"}}),
            ),
            (
                RuntimePolicyMutation::SetWebSearch {
                    value: WebSearchPolicy::new(false, WebSearchProvider::Model),
                },
                json!({"kind": "set_web_search",
                       "value": {"enabled": false, "defaultProvider": "model"}}),
            ),
            (
                RuntimePolicyMutation::SetSubagents {
                    value: SubagentSettings::new(vec![SubagentPreset::new(
                        "web",
                        "Researcher",
                        SubagentProfile::WebResearch,
                        "deepseek",
                        "deepseek-chat",
                    )]),
                },
                json!({"kind": "set_subagents", "value": {"presets": [{"id": "web",
                       "name": "Researcher", "description": "", "profile": "web_research",
                       "connectionSlug": "deepseek", "model": "deepseek-chat",
                       "enabled": true}]}}),
            ),
            (
                RuntimePolicyMutation::SetExternalAgents {
                    value: ExternalAgentsPolicy::new(AntigravityPolicy::new("")),
                },
                json!({"kind": "set_external_agents",
                       "value": {"antigravity": {"executable": ""}}}),
            ),
            (
                RuntimePolicyMutation::SetShell {
                    value: ShellPolicy::new(ShellPreference::Auto, "C:\\Git\\bin\\bash.exe"),
                },
                json!({"kind": "set_shell",
                       "value": {"preference": "auto", "executable": "C:\\Git\\bin\\bash.exe"}}),
            ),
            (
                RuntimePolicyMutation::PatchAgentSettings {
                    value: AgentRuntimeSettingsPatch {
                        privacy: Some(PrivacyPatch::new(true)),
                        web_search: Some(EnabledPatch::new(false)),
                        ..AgentRuntimeSettingsPatch::default()
                    },
                },
                json!({"kind": "patch_agent_settings", "value": {
                       "privacy": {"incognitoActive": true}, "webSearch": {"enabled": false}}}),
            ),
        ];
        for (mutation, expected) in cases {
            let input = RuntimePolicyMutateInput::new(4, mutation.clone());
            let encoded = serde_json::to_value(&input).expect("encode");
            assert_eq!(encoded, json!({"expectedRevision": 4, "operation": expected}));
            let decoded: RuntimePolicyMutateInput =
                serde_json::from_value(encoded).expect("decode");
            assert_eq!(decoded.operation, mutation);
        }
        // An empty patch is the empty object, as `exactRecord` allows.
        assert_eq!(
            serde_json::to_value(AgentRuntimeSettingsPatch::default()).expect("encode"),
            json!({})
        );
    }

    #[test]
    fn set_chat_defaults_keeps_the_fields_it_does_not_edit() {
        let read: ChatDefaults =
            serde_json::from_value(json!({"permissionMode": "bypass", "codeModeEnabled": true}))
                .expect("decode");
        let input = RuntimePolicyMutateInput::new(
            4,
            RuntimePolicyMutation::SetChatDefaults {
                value: read.with_permission_mode(ChatDefaultPermissionMode::Ask),
            },
        );
        assert_eq!(
            serde_json::to_value(input).expect("encode"),
            json!({"expectedRevision": 4, "operation": {"kind": "set_chat_defaults",
                   "value": {"permissionMode": "ask", "codeModeEnabled": true}}})
        );
        let off = ChatDefaults::with_code_mode(
            serde_json::from_value(json!({"permissionMode": "ask", "codeModeEnabled": true}))
                .expect("decode"),
            false,
        );
        assert_eq!(serde_json::to_value(off).expect("encode"), json!({"permissionMode": "ask"}));
        for (value, expected) in [
            (
                json!({"kind": "committed", "revision": 5}),
                RuntimePolicyMutateResult::Committed { revision: 5 },
            ),
            (
                json!({"kind": "revision_conflict", "expectedRevision": 4, "actualRevision": 6}),
                RuntimePolicyMutateResult::RevisionConflict {
                    expected_revision: 4,
                    actual_revision: 6,
                },
            ),
        ] {
            assert_eq!(
                serde_json::from_value::<RuntimePolicyMutateResult>(value).expect("decode"),
                expected
            );
        }
    }
}
