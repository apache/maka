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

use maka_sandbox::workspace::DirectoryIdentity;
mod mcp_management;
use HistoryRowAddress as RowPosition;
use maka_agent_ports::session::history::Cursor;
use maka_agent_ports::session::history::Role;
pub use maka_agent_ports::session::history::{HistoryOrder, HistoryRowAddress, HistoryView};
use maka_plugin_core::contract::{Contract, Interface, Method, MethodMode, Transport};
use maka_sandbox::workspace::WorkspaceIdentity;
pub use mcp_management::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

mod mcp;
pub use mcp::*;
mod context;
pub use context::*;
mod files;
pub use files::*;
mod checkpoints;
pub use checkpoints::*;
mod fork;
pub use fork::*;
mod git;
pub use git::*;
mod goal;
mod imports;
pub use goal::*;
mod todo;
pub use todo::*;
mod predictions;
pub use predictions::*;
mod recap;
pub use recap::*;
mod scheduler;
pub use scheduler::*;
mod bot;
pub use bot::*;
mod recall;
pub use imports::*;
pub use recall::*;
mod projects;
pub use projects::*;
mod execution;
pub use execution::*;
mod compaction;
pub use compaction::*;

mod interaction;
pub use interaction::*;
mod computer_apps;
pub use computer_apps::*;
mod permissions;
pub use maka_agent_facts::configuration::ModelSelection;
pub use permissions::*;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentConfiguration")]
pub struct Configuration {
    /// Explicitly trusted MCP servers. Catalogs are captured on Agent activation.
    #[serde(default)]
    pub mcp_servers: Vec<maka_agent_facts::configuration::mcp::ServerConfiguration>,
    /// Deployment locale fallback; saved Root preference takes precedence.
    #[serde(default)]
    pub locale: String,
    /// Defer optional tool schemas until the model discovers them. This affects
    /// presentation only; every call still uses its current authorized binding.
    #[serde(default)]
    pub tool_discovery: bool,
    /// Permit creation of Host-owned Git worktrees from published directories.
    #[serde(default)]
    pub isolated_workspaces: bool,
    /// Select Maka's assistant policy and workspace guidance explicitly.
    #[serde(default)]
    pub assistant: Option<AssistantConfiguration>,
    /// Enable model proposals and approved scheduled work for this Agent.
    #[serde(default)]
    pub scheduled_tasks: bool,
    /// Enable explicitly approved Goal continuation.
    #[serde(default)]
    pub goals: bool,
    /// Enable the session-scoped, model-maintained checklist.
    #[serde(default)]
    pub todo: bool,
    /// Enable the Bot mode: one persistent Session that reaches its user only
    /// through `SendUser`, with a Host-owned outbox.
    #[serde(default)]
    pub bot: bool,
    /// Generate a bounded auxiliary title for automatically named conversations.
    #[serde(default)]
    pub automatic_titles: bool,
    /// Enable explicit, bounded session recap requests and cached reads.
    #[serde(default)]
    pub recaps: bool,
    /// Explicit access to this Agent’s earlier conversations for model tools.
    #[serde(default)]
    pub recall: bool,
    /// Explicit service backends; discovery does not authorize execution.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub executors: Vec<crate::executor::ServiceExecutor>,
    #[serde(default)]
    pub external: Option<crate::executor::ExternalConfiguration>,
    /// Explicit Library import for immutable skill input preparation and metadata.
    /// This does not select model tools or confer a service grant.
    #[serde(default)]
    #[schemars(length(min = 1))]
    pub skill_library: Option<String>,
    /// Initial policy within the selected workspace capability.
    pub permissions: WorkspacePermissions,
    /// Installation-published directories, captured without creating workspace markers.
    pub workspace_roots: Vec<maka_host_runtime::DirectoryRootSpec>,
    /// Explicit read-only roots for user-selected conversation sources.
    #[serde(default)]
    pub import_roots: Vec<maka_host_runtime::DirectoryRootSpec>,
    /// Explicitly selected, frozen application service tools, alongside configured native tools.
    pub tools: Vec<ServiceTool>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentAssistantConfiguration")]
pub struct AssistantConfiguration {
    /// Select this home for global instructions and explicit AGENTS.md editing.
    #[serde(default)]
    #[schemars(length(min = 1))]
    pub home: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentServiceTool")]
pub struct ServiceTool {
    /// Allow this selected service inside Code Mode. Binding and permission
    /// checks are identical to a direct call; omitted keeps direct-only behavior.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub nestable: bool,
    /// Explicit input projection. Skill tools receive the actual Agent tool names,
    /// outside model-controlled arguments; this is compatibility data, not authority.
    #[serde(default)]
    pub input: ToolInput,
    /// Explicit versioned renderer key, frozen with the call; never inferred from its name.
    #[serde(default)]
    #[schemars(length(min = 1))]
    pub presentation: Option<String>,
    /// Display only; the selected name, contract and binding still identify execution.
    #[serde(default)]
    pub title: Option<maka_agent_facts::display::Text>,
    /// Explicit model projection; JSON data never implicitly grants image access.
    pub result: ToolResult,
    /// Additional user consent for this exact call; service grants remain independent.
    pub confirmation: ToolConfirmation,
    #[schemars(length(min = 1))]
    pub name: String,
    #[schemars(length(min = 1))]
    pub description: String,
    pub target: maka_plugin_core::contract::ServiceTarget,
    #[schemars(length(min = 1))]
    pub method: String,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentToolInput")]
pub enum ToolInput {
    #[default]
    Json,
    Skill,
    Web,
    /// Display-only command title; recorded in history, not forwarded to the process service.
    Shell,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentToolResult")]
pub enum ToolResult {
    Json,
    Image,
    /// Session-owned Computer REPL output, retained with its original receipt.
    Computer,
}

/// Bounded image bytes from a selected subscription. Complete is a producer
/// return value, never an emitted item or an executor-cleanup acknowledgement.
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentToolImageFrame")]
pub enum ImageFrame {
    Chunk {
        #[schemars(regex(pattern = "^image/(png|jpeg|gif|webp)$"))]
        mime_type: String,
        #[schemars(range(min = 1, max = 9_007_199_254_740_991u64))]
        total_bytes: usize,
        #[schemars(range(max = 9_007_199_254_740_991u64))]
        offset: usize,
        #[schemars(length(min = 1, max = 43692))]
        data: String,
    },
    Complete {
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<maka_agent_facts::tool_output::ImageDetail>,
    },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentToolConfirmation")]
pub enum ToolConfirmation {
    Required,
    Preapproved,
}
pub fn configuration_schema() -> Value {
    serde_json::to_value(schemars::schema_for!(Configuration)).expect("configuration schema")
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentList")]
pub struct List {
    pub filter: SessionFilter,
    /// Include archived conversations alongside active ones.
    #[serde(default)]
    pub include_archived: bool,
    /// Only conversations without a parent; omitted queries still include children.
    #[serde(default)]
    pub roots_only: bool,
    pub position: SessionPosition,
    #[serde(default)]
    pub scope: SessionListScope,
    /// Literal, case-sensitive title substring; an empty query matches all titles.
    #[serde(default)]
    pub title_query: String,
}
#[derive(Clone, Default, Deserialize, Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentSessionListScope")]
pub enum SessionListScope {
    #[default]
    All,
    Project {
        project_id: uuid::Uuid,
    },
    /// Direct children of an owned session, across workspaces.
    Children {
        #[schemars(length(min = 1))]
        session_id: String,
    },
    /// Resolve the exact workspace from an owned session, never a caller path.
    Workspace {
        #[schemars(length(min = 1))]
        session_id: String,
    },
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentSessionFilter")]
pub enum SessionFilter {
    All,
    Archived,
    NeedsYou,
}
#[derive(Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentSessionPosition")]
pub enum SessionPosition {
    Start,
    At {
        #[schemars(length(min = 1))]
        cursor: String,
    },
    After {
        revision: String,
        #[schemars(length(min = 1))]
        cursor: String,
    },
    Before {
        revision: String,
        #[schemars(length(min = 1))]
        cursor: String,
    },
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCreate")]
pub struct Create {
    /// Apply a preset at creation; mutually exclusive with backend.
    pub preset_id: Option<crate::preset::PresetId>,
    /// Initial next-turn preference; admission resolves it again.
    pub backend: Option<BackendPreference>,
    /// Treat title as a placeholder for one title derived from the first user message.
    #[serde(default)]
    pub automatic_title: bool,
    /// Immutable narrowing of this Agent's installed tools. None uses the installation;
    /// an empty list permits no model tools. External executors cannot enforce this.
    #[serde(default)]
    #[schemars(extend("uniqueItems" = true))]
    pub tools: Option<Vec<String>>,
    /// A concise, specific task name people can recognize in navigation; avoid generic worker numbers.
    #[schemars(length(min = 1))]
    pub title: String,
    pub labels: Vec<String>,
    pub workspace: WorkspaceSelection,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentWorkspaceSelection")]
pub enum WorkspaceSelection {
    /// A Git worktree of the directory at `path`, managed by the Host.
    IsolatedGit {
        #[schemars(length(min = 1))]
        path: String,
    },
    /// A registered Project at one of its locations.
    Project {
        project: ProjectRef,
        #[schemars(length(min = 1))]
        path: String,
    },
    /// The directory at `path`: absolute, `~` standing for the home directory,
    /// within the configured workspace locations.
    Directory {
        #[schemars(length(min = 1))]
        path: String,
    },
    Session {
        #[schemars(length(min = 1))]
        session_id: String,
    },
}

/// Read-only completion context before or after a conversation is created.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentCompletionTarget")]
pub enum CompletionTarget {
    Session {
        #[schemars(length(min = 1))]
        session_id: String,
    },
    Draft {
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<WorkspaceSelection>")]
        workspace: Option<WorkspaceSelection>,
    },
}
/// A directory on the Host: an absolute path, `~` standing for the home
/// directory, within the configured workspace locations.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentDirectoryPath")]
pub struct DirectoryPath {
    #[schemars(length(min = 1))]
    pub path: String,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentDirectories")]
pub enum Directories {
    Roots,
    /// The directories inside `path`, a page at a time; `after` is the last
    /// name of the previous page.
    Children {
        #[schemars(length(min = 1))]
        path: String,
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
        after: Option<String>,
    },
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentDirectory")]
pub struct Directory {
    pub name: String,
    pub path: String,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentDirectoryPage")]
pub enum DirectoryPage {
    Roots {
        roots: Vec<Directory>,
    },
    Children {
        directory: Directory,
        #[schemars(length(max = 32))]
        children: Vec<Directory>,
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
        after: Option<String>,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentWorkspace")]
pub struct Workspace {
    /// Native owner allocation; never accepted from a caller as workspace authority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<Box<maka_fs_tools::worktree::Binding>>,
    /// Optional membership in this Agent's canonical Project catalog.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<uuid::Uuid>,
    #[schemars(length(min = 1))]
    pub path: String,
    #[schemars(with = "String", regex(pattern = "^sha256:[a-f0-9]{64}$"))]
    pub directory_identity: DirectoryIdentity,
    #[schemars(with = "String", regex(pattern = "^workspace:v1:[A-Fa-f0-9-]{36}$"))]
    pub identity: WorkspaceIdentity,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentMetadata")]
pub struct Metadata {
    /// Omission preserves the conversation's position in the catalog.
    #[serde(default)]
    pub pinned: Option<bool>,
    /// Omission leaves the permission boundary and its approvals unchanged.
    #[serde(default)]
    pub permissions: Option<PermissionChange>,
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(range(min = 1, max = 9_007_199_254_740_991u64))]
    pub expected_revision: u64,
    #[schemars(length(min = 1))]
    pub title: String,
    pub labels: Vec<String>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentChangeSession")]
pub struct ChangeSession {
    pub session_id: String,
    pub expected_revision: u64,
    pub action: SessionAction,
}
#[derive(Clone, Copy, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentSessionAction")]
pub enum SessionAction {
    Archive,
    Restore,
    Remove,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentSessionChanged")]
pub enum SessionChanged {
    Changed {
        session: Box<Session>,
    },
    Removed {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    RevisionConflict {
        expected: u64,
        actual: u64,
    },
    Rejected {
        reason: Rejection,
    },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentGlobalInstructionSource")]
pub enum GlobalInstructionSource {
    Maka,
    Agents,
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentGlobalInstructionsView")]
pub enum GlobalInstructionsView {
    Available {
        source: GlobalInstructionSource,
        path: String,
        revision: String,
        content: String,
        exists: bool,
    },
    Unavailable,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "AgentGlobalInstructionsRead")]
pub struct GlobalInstructionsRead {}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "AgentGlobalInstructionsUpdate")]
pub struct GlobalInstructionsUpdate {
    pub source: GlobalInstructionSource,
    pub revision: String,
    pub content: String,
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentGlobalInstructionsUpdated")]
pub enum GlobalInstructionsUpdated {
    Saved,
    Changed,
    Unavailable,
}

/// Read-only suggestions resolved against the selected completion context.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSkillCandidatesRead")]
pub struct SkillCandidatesRead {
    pub target: CompletionTarget,
    pub backend: BackendPreference,
    pub query: String,
}
#[derive(Serialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "AgentSkillCandidates")]
pub struct SkillCandidates {
    pub revision: Option<String>,
    pub skills: Vec<SkillCandidate>,
}
#[derive(Serialize, JsonSchema)]
#[schemars(rename = "AgentSkillCandidate")]
pub struct SkillCandidate {
    pub reference: String,
    pub name: String,
    pub description: String,
    pub invocation: String,
}
pub use maka_agent_facts::executor::BackendPreference;
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentModelChoice")]
pub struct ModelChoice {
    pub selection: BackendPreference,
    pub source_name: String,
    pub label: String,
    pub thinking_levels: Vec<String>,
    pub default_thinking_level: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "AgentModelsCursor")]
pub struct ModelsCursor {
    pub query: String,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub offset: u64,
}
#[derive(Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentModelsRead")]
pub enum ModelsRead {
    Start {
        #[serde(default)]
        query: String,
    },
    Continue {
        revision: String,
        cursor: ModelsCursor,
    },
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentModelsPage")]
pub enum ModelsPage {
    Ready {
        revision: String,
        choices: Vec<ModelChoice>,
        complete: bool,
        next: Option<ModelsCursor>,
    },
    Changed,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "AgentModelRead")]
pub struct ModelRead {
    pub backend: BackendPreference,
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentModelResult")]
pub enum ModelResult {
    Ready { choice: ModelChoice },
    Unavailable { message: String },
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSelectBackend")]
pub struct SelectBackend {
    pub session_id: String,
    pub backend: BackendPreference,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentRejection")]
pub enum Rejection {
    PresetNotFound,
    PresetDisabled,
    PresetConflict,
    PresetModelUnavailable,
    PresetThinkingLevelUnavailable,
    PresetBackendConflict,
    PermissionChangeRequiresUser,
    TitleInvalid,
    LabelsInvalid,
    ToolsUnavailable,
    Busy,
    WorkspaceUnavailable,
    SessionUnavailable,
    HistoryUnavailable,
    Closed,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentCreated")]
pub enum Created {
    Created { session: Box<Session> },
    Rejected { reason: Rejection },
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentMetadataResult")]
pub enum MetadataResult {
    Committed { session: Box<Session> },
    RevisionConflict { expected: u64, actual: u64 },
    Rejected { reason: Rejection },
}
#[derive(Clone, Copy, Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentSendDelivery")]
pub enum SendDelivery {
    /// Deliver additional context, corrections, progress updates or guidance to ongoing work.
    /// Active model, Codex and Claude turns accept steering; agy interrupts and resumes where supported. Other executors queue.
    #[default]
    Steer,
    /// Defer this message until the current turn ends.
    Queue,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSend")]
pub struct Send {
    /// Best-effort notification to the native model caller when this message finishes,
    /// fails or is cancelled, and once per pending interaction or authority blocker
    /// that needs attention. An attention notification keeps the completion watch.
    /// When registration is confirmed, the caller can yield rather than poll.
    /// The watch and task admission commit together;
    /// check the completion field of the send receipt.
    #[serde(default)]
    pub on_complete: Option<OnComplete>,
    /// Immutable user-selected excerpts; source metadata grants no read authority.
    #[serde(default)]
    #[schemars(length(max = 16))]
    pub quotes: Vec<maka_agent_facts::input::QuoteRef>,
    /// Defaults to steer. Omit or use steer for updates to ongoing work;
    /// use queue only when this message should wait until the current turn ends.
    #[serde(default)]
    pub delivery: SendDelivery,
    /// An active send must not start new work after Stop fences its original Run.
    pub expected_run_id: Option<maka_agent_facts::durable::RunId>,
    /// IDs of immutable user uploads in this Session; metadata is resolved by the owner.
    #[serde(default)]
    pub attachments: Vec<String>,
    /// Omission uses the session’s saved next-turn preference.
    pub backend: Option<BackendPreference>,
    #[schemars(length(min = 1))]
    pub session_id: String,

    pub message: String,
}
#[derive(Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentOnComplete")]
pub enum OnComplete {
    NotifyCaller,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "AgentExecutorsRead")]
pub struct ExecutorsRead {}
#[derive(Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "AgentExecutors")]
pub struct Executors {
    pub executors: Vec<String>,
    pub setup: Vec<String>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentUploadAttachment")]
pub struct UploadAttachment {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(length(min = 1))]
    pub name: String,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub bytes: usize,
    #[schemars(regex(pattern = "^sha256:[a-f0-9]{64}$"))]
    pub digest: String,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentAttachmentUploadResult")]
pub enum AttachmentUploadResult {
    Uploaded { attachment: Attachment },
    Rejected { reason: AttachmentRejection },
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentAttachmentRejection")]
pub enum AttachmentRejection {
    InvalidFile,
    Closed,
    Archived,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentAttachment")]
pub struct Attachment {
    pub session_id: String,
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub bytes: u64,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentMarkRead")]
pub struct MarkRead {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(length(min = 1))]
    pub message_id: String,
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentMarkReadResult")]
pub enum MarkReadResult {
    Observed { session: Box<Session> },
    Rejected { reason: Rejection },
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentStop")]
pub struct Stop {
    #[schemars(length(min = 1))]
    pub session_id: String,
    pub run_id: maka_agent_facts::durable::RunId,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentWatch")]
pub struct Watch {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub after: u64,
}
/// Stable business-data origin, independent of package or activation revisions.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentDataSource")]
pub struct DataSource {
    pub state_domain: String,
    pub deployment: uuid::Uuid,
    pub namespace: maka_plugin_core::composition::InstanceId,
}
#[derive(Clone, Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSession")]
pub struct Session {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_preset: Option<crate::preset::AppliedPreset>,
    /// Session that initiated creation, independent of fork ancestry and task ownership.
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub parent_session_id: Option<String>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<SessionBranch>")]
    pub branch: Option<SessionBranch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<BackendPreference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    pub data_source: Box<DataSource>,
    pub permissions: WorkspacePermissions,
    pub boundary_revision: u64,
    pub binding: maka_sandbox::workspace::BindingStamp,
    pub id: String,
    pub title: String,
    pub labels: Vec<String>,
    pub workspace: Workspace,
    pub revision: u64,
    pub updated_at: u64,
    pub archived: bool,
    pub pinned: bool,
    pub has_unread: bool,
    /// Exact durable visible tail accepted by markRead; independent of preview clocks.
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub tail_message_id: Option<String>,
    pub activity: SessionActivity,
}
#[derive(Clone, Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentSessionActivity")]
pub enum SessionActivity {
    Idle,
    Working,
    Waiting,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSessionPage")]
pub struct SessionPage {
    pub revision: String,
    pub needs_you_count: u64,
    #[schemars(length(max = 32))]
    pub sessions: Vec<Session>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub before: Option<String>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub after: Option<String>,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentSendResult")]
pub enum SendResult {
    Rejected {
        session_id: String,
        reason: SendRejection,
        skills: Option<maka_skills::SkillInvocationResult>,
    },
    Started {
        session_id: String,
        run_id: maka_agent_facts::durable::RunId,
        message_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        completion: Option<CompletionRegistration>,
    },
    Queued {
        session_id: String,
        message_id: String,
        revision: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        completion: Option<CompletionRegistration>,
    },
    /// The caller may not send to this conversation: the Bot sends only to the
    /// workers it created. Nothing was admitted.
    NotYourWorker { session_id: String },
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentCompletionRegistration")]
pub enum CompletionRegistration {
    /// The notification watch was persisted; delivery remains best effort.
    Registered,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentSendRejection")]
pub enum SendRejection {
    ModelUnavailable,
    SkillsUnavailable,
    TurnStopped,
    OriginalOperationUnsettled,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentStopped")]
pub struct Stopped {
    /// The original operation accepted a Stop intent for the existing Run, not
    /// proof of a new state write or physical cleanup. Missing/already-terminal
    /// preparation may return false; a terminal race after acceptance stays true.
    pub requested: bool,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentDelivery")]
pub struct Delivery {
    pub sequence: u64,
    pub run_id: maka_agent_facts::durable::RunId,
    pub turn_id: String,
    pub fact: DeliveryFact,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentDeliveryFact")]
pub enum DeliveryFact {
    Opened,
    ExecutorStarted,
    /// The original native assistant message starts here, not at executor admission.
    ExecutorMessageStarted {
        message_id: String,
        step_id: maka_agent_facts::durable::StepId,
        attempt_id: maka_agent_facts::durable::ModelAttemptId,
    },
    ExecutorTextChanged {
        message_id: String,
        thinking: bool,
    },
    /// Canonical transcript facts changed; clients query bounded history.
    TranscriptChanged,
    StepEnded {
        step_id: maka_agent_facts::durable::StepId,
        attempt_id: maka_agent_facts::durable::ModelAttemptId,
        /// The model/executor completed; this says nothing about tool business success.
        completed: bool,
    },
    PartCommitted {
        step_id: maka_agent_facts::durable::StepId,
        attempt_id: maka_agent_facts::durable::ModelAttemptId,
        message_id: String,
        ordinal: u64,
    },
    Delta {
        step_id: maka_agent_facts::durable::StepId,
        attempt_id: maka_agent_facts::durable::ModelAttemptId,
        part_id: String,
        text: String,
    },
    /// Complete model input was observed, not authorization to execute it.
    ToolInputReady {
        tool_use_id: String,
        step_id: maka_agent_facts::durable::StepId,
        attempt_id: maka_agent_facts::durable::ModelAttemptId,
        name: String,
        provider_executed: bool,
    },
    /// Original Host admission, not a claim that the effect is currently using CPU.
    ToolDispatched {
        tool_use_id: String,
        name: String,
        title: Option<maka_agent_facts::display::Text>,
    },
    ToolRejected {
        tool_use_id: String,
    },
    ToolSettled {
        tool_use_id: String,
        settlement: maka_agent_facts::tool_call::ToolSettlement,
    },
    /// Provider-reported completion, distinct from a Host effect settlement.
    ProviderToolResult {
        tool_use_id: String,
        is_error: bool,
    },
    ExecutorToolStart {
        tool_use_id: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<maka_agent_facts::display::Text>,
    },
    ExecutorToolProgress {
        tool_use_id: String,
        /// The most recent at most 2048 codepoints of reported progress, not the complete result.
        text: String,
    },
    ExecutorToolResult {
        tool_use_id: String,
        is_error: bool,
    },
    Ended {
        failed: bool,
    },
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentContentKind")]
pub enum ContentKind {
    Text,
    Thinking,
}
impl From<maka_agent_facts::model::TextKind> for ContentKind {
    fn from(value: maka_agent_facts::model::TextKind) -> Self {
        match value {
            maka_agent_facts::model::TextKind::Text => Self::Text,
            maka_agent_facts::model::TextKind::Thinking => Self::Thinking,
        }
    }
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSessionRead")]
pub struct SessionRead {
    #[schemars(length(min = 1))]
    pub session_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentDiagnostics")]
pub struct Diagnostics {
    #[schemars(length(min = 1))]
    pub session_id: String,
    pub position: DiagnosticPosition,
}
#[derive(Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentDiagnosticPosition")]
pub enum DiagnosticPosition {
    Latest,
    Before {
        #[schemars(range(max = 9_007_199_254_740_991u64))]
        through: u64,
        #[schemars(range(min = 1, max = 9_007_199_254_740_991u64))]
        sequence: u64,
    },
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentDiagnostic")]
pub struct Diagnostic {
    pub sequence: u64,
    pub event_id: String,
    pub recorded_at: f64,
    pub detail: maka_agent_facts::diagnostics::DiagnosticDetail,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentDiagnosticPage")]
pub struct DiagnosticPage {
    pub through: u64,
    pub entries: Vec<Diagnostic>,
    pub next_before: Option<u64>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentDiagnosticChange")]
pub struct DiagnosticChange {
    /// Latest diagnostic event sequence, independently of transcript progress.
    pub revision: u64,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentObservation")]
pub struct Observation {
    pub session: Session,
    /// Latest successful source turn at this observation's fence, or none while busy.
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub last_completed_turn_id: Option<String>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<CompactionProgress>")]
    pub compacting: Option<CompactionProgress>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remembered_backend: Option<BackendPreference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metrics: Option<SessionMetrics>,
    pub through: u64,
    pub run: Option<Run>,
    pub parts: Vec<Part>,
    /// Replay starts for active tool display, read at the same fence as the run.
    pub tool_seeds: Vec<ToolSeed>,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCompactionProgress")]
pub struct CompactionProgress {
    pub id: String,
    /// Original compaction start in milliseconds since the Unix epoch.
    pub started_at: u64,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentToolSeed")]
pub struct ToolSeed {
    pub tool_use_id: String,
    pub start_sequence: u64,
}
/// Display-only readings from the latest completed main-model request.
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSessionMetrics")]
pub struct SessionMetrics {
    pub model_id: String,
    pub connection_id: Option<String>,
    pub context_tokens: Option<u64>,
    pub context_window: Option<u64>,
    pub approximate: bool,
    /// The context count is the last completed request's baseline; newer additions are unknown.
    pub context_last_known: bool,
    /// Provider output tokens divided by the model request's wall time.
    /// Includes reasoning and time to first token; excludes tool/user waits.
    pub output_tokens_per_second: Option<f64>,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentRun")]
pub struct Run {
    pub backend: RunBackend,
    pub run_id: maka_agent_facts::durable::RunId,
    pub turn_id: String,
    pub state: RunState,
}
/// Execution kind frozen at admission, independent of the next-turn preference.
#[derive(Clone, Copy, Debug, Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentRunBackend")]
pub enum RunBackend {
    Model,
    Executor,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentRunState")]
pub enum RunState {
    Admitted,
    Running,
    WaitingForUser,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentPart")]
pub struct Part {
    pub start_sequence: u64,
    pub message_id: String,
    pub step_id: maka_agent_facts::durable::StepId,
    pub attempt_id: maka_agent_facts::durable::ModelAttemptId,
    pub part_id: String,
    pub text_kind: ContentKind,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentDeliveryPage")]
pub enum DeliveryPage {
    Events {
        through: u64,
        next_after: u64,
        events: Vec<Delivery>,
    },
    Preview {
        page: PreviewPage,
    },
    Queue {
        queue: Queue,
    },
    Interactions {
        pending: PendingInteractions,
    },
    ComputerApps {
        apps: ComputerApps,
    },
}

/// Current display material, independent of the durable Events cursor.
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentPreviewPage")]
pub enum PreviewPage {
    Empty {
        host_epoch: String,
    },
    Cut {
        host_epoch: String,
        run_id: maka_agent_facts::durable::RunId,
        turn_id: String,
        step_id: maka_agent_facts::durable::StepId,
        attempt_id: maka_agent_facts::durable::ModelAttemptId,
        revision: u64,
        depends_on: u64,
        first: bool,
        last: bool,
        parts: Vec<PreviewPart>,
    },
}

#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentPreviewPart")]
pub struct PreviewPart {
    pub ordinal: Option<u64>,
    pub message_id: String,
    pub provider_part_id: Option<String>,
    pub started_at: f64,
    pub field: PreviewField,
    /// UTF-8 byte offset into the body, independent of JavaScript string length.
    pub offset: u64,
    pub total_bytes: u64,
    pub text: String,
}

#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentPreviewField")]
pub enum PreviewField {
    Text {
        text_kind: ContentKind,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        final_answer: bool,
    },
    ToolInput {
        tool_use_id: String,
        name: String,
        provider_executed: bool,
    },
}

#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentQueue")]
pub struct Queue {
    pub revision: u64,
    pub entries: Vec<QueueEntry>,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentQueueEntry")]
pub struct QueueEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<maka_agent_facts::message::MessageOrigin>,
    pub message_id: String,
    pub kind: QueueKind,
    #[schemars(length(max = 80))]
    pub preview: String,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentQueueKind")]
pub enum QueueKind {
    InFlight,
    Steering,
    Followup,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentQueueMessage")]
pub struct QueueMessage {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(length(min = 1))]
    pub message_id: String,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub expected_revision: u64,
}
#[derive(Clone, Copy, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentQueueMessageMissingReason")]
pub enum QueueMessageMissingReason {
    Delivered,
    Cancelled,
    Unknown,
}

#[derive(Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentQueueMessageResult")]
pub enum QueueMessageResult {
    Ready {
        revision: u64,
        has_attachments: bool,

        message: String,
    },
    RevisionConflict {
        expected: u64,
        actual: u64,
    },
    Missing {
        reason: QueueMessageMissingReason,
    },
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentQueueMutation")]
pub struct QueueMutation {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub expected_revision: u64,
    pub edit: QueueAction,
}
#[derive(Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentQueueAction")]
pub enum QueueAction {
    Retract {
        #[schemars(length(min = 1))]
        message_id: String,
    },
    Promote {
        #[schemars(length(min = 1))]
        message_id: String,
    },
    Update {
        #[schemars(length(min = 1))]
        message_id: String,

        message: String,
    },
    Reorder {
        #[schemars(length(min = 1))]
        message_ids: Vec<String>,
    },
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentQueueMutationResult")]
pub enum QueueMutationResult {
    Committed { revision: u64 },
    RevisionConflict { expected: u64, actual: u64 },
    Rejected { reason: QueueRejection },
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentQueueRejection")]
pub enum QueueRejection {
    NotYourMessage,
    Closed,
    Missing,
    InFlight,
    InvalidEdit,
    ExecutionChanged,
    NotRunning,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentHistoryAttachment")]
pub struct HistoryAttachment {
    pub name: String,
    pub mime_type: String,
    pub bytes: u64,
    pub kind: maka_agent_facts::attachment::AttachmentKind,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentHistoryChunk")]
pub struct HistoryChunk {
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<u64>")]
    pub imported_turn: Option<maka_agent_facts::history_snapshot::ImportedTurnOrdinal>,
    pub run_id: Option<maka_agent_facts::durable::RunId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_part: Option<maka_agent_ports::session::history::ModelPartIdentity>,
    /// The original user input has quotes, directory references or inline references.
    /// Present only on the first fragment; display text cannot reconstruct these references.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub has_references: bool,
    /// Bounded quote display, present only on the first message fragment.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub quotes: Vec<maka_agent_ports::session::history::HistoryQuote>,
    /// Part of the successfully completed native Turn's final output at `through`.
    /// Includes body text and source citations; never a Thinking field.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub final_output: bool,
    /// The provider identified this text as final before the Turn completed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub final_answer: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<maka_agent_ports::session::history::HistoryModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<maka_agent_facts::message::MessageOrigin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction: Option<maka_agent_ports::session::history::Compaction>,
    /// Display metadata only, on the first user-message fragment; no storage capability.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<HistoryAttachment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timing: Option<maka_agent_ports::session::history::TurnTiming>,
    pub field: maka_agent_ports::session::history::HistoryField,
    pub message_id: Option<String>,
    pub turn_id: Option<String>,
    pub timestamp: Option<u64>,
    pub role: Role,
    /// Stable display order; position remains the canonical source read address.
    pub order: HistoryOrder,
    pub position: RowPosition,
    pub offset: u64,
    pub total_bytes: u64,
    pub text: String,
    #[schemars(
        with = "maka_plugin_core::wire_schema::RequiredNullable<maka_agent_ports::session::history::Tool>"
    )]
    pub tool: Option<maka_agent_ports::session::history::Tool>,
}
#[derive(Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentHistoryRead")]
pub struct History {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub through: Option<u64>,
    pub position: HistoryPosition,
    #[serde(default)]
    pub include_thinking: bool,
    #[serde(default)]
    pub view: maka_agent_ports::session::history::HistoryView,
}
pub use maka_agent_ports::session::history::Position as HistoryPosition;
pub use maka_agent_ports::session::history::Prompt as HistoryPrompt;

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentHistoryLandmarksRead")]
pub struct HistoryLandmarksRead {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub through: u64,
}

/// Sampled canonical display positions, not a complete Turn outline or an
/// execution grant.
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentHistoryLandmarks")]
pub struct HistoryLandmarks {
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub through: u64,
    #[schemars(length(max = 64))]
    pub landmarks: Vec<HistoryLandmark>,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentHistoryLandmark")]
pub struct HistoryLandmark {
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<u64>")]
    pub imported_turn: Option<maka_agent_facts::history_snapshot::ImportedTurnOrdinal>,
    pub order: HistoryOrder,
    pub last_order: HistoryOrder,
    #[schemars(length(min = 1))]
    pub turn_id: Option<String>,
    pub position: RowPosition,
    pub last_position: RowPosition,
    #[schemars(length(max = 96))]
    pub label: String,
    /// The Host's attribution of the Turn's opening message, when it generated it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<maka_agent_facts::message::MessageOrigin>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentHistoryPromptRead")]
pub struct HistoryPromptRead {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(range(min = 1, max = 9_007_199_254_740_991u64))]
    pub through: u64,
    pub position: RowPosition,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentHistoryRequestsRead")]
pub struct HistoryRequestsRead {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(range(min = 1, max = 9_007_199_254_740_991u64))]
    pub through: u64,
    /// Any original row in the Run being inspected.
    pub position: RowPosition,
    #[serde(default)]
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub after: Option<u64>,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "AgentHistoryRequests")]
pub struct HistoryRequests {
    pub requests: Vec<HistoryRequest>,
    pub next: Option<u64>,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "AgentHistoryRequest")]
pub struct HistoryRequest {
    pub order: HistoryOrder,
    pub step_id: maka_agent_facts::durable::StepId,
    pub attempt_id: maka_agent_facts::durable::ModelAttemptId,
    pub model_id: String,
    pub purpose: maka_agent_facts::context::ModelPurpose,
    pub started_at: Option<u64>,
    pub first_token_at: Option<u64>,
    pub finished: Option<HistoryRequestFinished>,
    pub estimated_input_tokens: u64,
    pub context_window: Option<u64>,
    pub input_limit: Option<u64>,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "AgentHistoryRequestFinished")]
pub struct HistoryRequestFinished {
    pub at: u64,
    pub outcome: maka_agent_facts::accounting::Outcome,
    pub usage: maka_agent_facts::model::ModelUsage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentHistorySearch")]
pub struct HistorySearch {
    #[schemars(length(min = 1))]
    pub session_id: String,
    /// Original raw-event fence, shared with history reads.
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub through: u64,
    /// Exclusive transcript-row position; null starts a scan.
    pub after: Option<RowPosition>,
    /// Literal query; no normalization.
    #[schemars(length(min = 1))]
    pub query: String,
    /// False uses Unicode simple case folding, without locale or multi-character folding.
    pub case_sensitive: bool,
    /// Require no adjacent Unicode word character (Alphabetic, marks, decimal
    /// digits, connector punctuation or join controls); not dictionary segmentation.
    pub whole_word: bool,
    pub include_internal: bool,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentHistoryMatch")]
pub struct HistoryMatch {
    pub order: HistoryOrder,
    /// Exact canonical field to read through the source query; history body may omit it.
    pub field: maka_agent_ports::session::history::SourceField,
    /// Exact transcript row. Open with HistoryPosition::Row at the same raw-event
    /// fence: Thinking for a thinking match, Body for every other source field.
    pub position: RowPosition,
    #[schemars(length(max = 384))]
    pub preview: String,
}

#[derive(Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentHistorySearchPage")]
pub enum HistorySearchPage {
    Ready {
        through: u64,
        #[schemars(length(max = 16))]
        matches: Vec<HistoryMatch>,
        /// Continue even when this batch has no matches. Null is the end of the scan.
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<RowPosition>")]
        next_after: Option<RowPosition>,
    },
}

#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentHistoryPage")]
pub enum HistoryPage {
    Ready {
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<u64>")]
        through: Option<u64>,
        chunks: Vec<HistoryChunk>,
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<Cursor>")]
        before: Option<Cursor>,
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<Cursor>")]
        after: Option<Cursor>,
    },
}

impl From<maka_agent_ports::session::history::Page> for HistoryPage {
    fn from(value: maka_agent_ports::session::history::Page) -> Self {
        let maka_agent_ports::session::history::Page::Ready {
            through,
            chunks,
            before,
            after,
        } = value;
        HistoryPage::Ready {
            through,
            before,
            after,
            chunks: chunks
                .into_iter()
                .map(|chunk| HistoryChunk {
                    imported_turn: chunk.imported_turn,
                    run_id: chunk.run_id,
                    model_part: chunk.model_part,
                    has_references: chunk.has_references,
                    quotes: chunk.quotes,
                    final_output: chunk.final_output,
                    final_answer: chunk.final_answer,
                    model: chunk.model,
                    origin: chunk.origin,
                    compaction: chunk.compaction,
                    attachments: chunk
                        .attachments
                        .into_iter()
                        .map(|attachment| HistoryAttachment {
                            name: attachment.name,
                            mime_type: attachment.mime_type,
                            bytes: attachment.bytes,
                            kind: attachment.kind,
                        })
                        .collect(),
                    timing: chunk.timing,
                    field: chunk.field,
                    message_id: chunk.message_id,
                    turn_id: chunk.turn_id,
                    timestamp: chunk.timestamp,
                    role: chunk.role,
                    order: chunk.order,
                    position: chunk.position,
                    offset: chunk.offset,
                    total_bytes: chunk.total_bytes,
                    text: chunk.text,
                    tool: chunk.tool,
                })
                .collect(),
        }
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentHistorySourceRead")]
pub struct HistorySourceRead {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub through: u64,
    pub source: HistorySourceReference,
    pub field: maka_agent_ports::session::history::SourceField,
    /// Optional JSON keys/array indices within arguments, result or receipt.
    #[serde(default)]
    pub path: Option<Vec<maka_agent_ports::session::history::SourceSegment>>,
    pub position: maka_agent_ports::session::history::SourcePosition,
}
#[derive(Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentHistorySourceReference")]
pub enum HistorySourceReference {
    Row {
        position: RowPosition,
    },
    ToolUse {
        #[schemars(length(min = 1))]
        tool_use_id: String,
    },
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentHistorySourcePage")]
pub enum HistorySourcePage {
    Ready {
        through: u64,
        source: Box<maka_agent_ports::session::history::HistorySource>,
        /// Complete file-path evidence resolved on the Host for copying only.
        /// This is display text, never a filesystem capability or open command.
        #[serde(rename = "filePath", skip_serializing_if = "Option::is_none")]
        file_path: Option<String>,
    },
}

/// A bounded image read through an actual history source capability, without a live Root fence.
#[derive(Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentHistoryImagePage")]
pub enum HistoryImagePage {
    Ready {
        position: HistoryRowAddress,
        #[schemars(range(max = 9_007_199_254_740_991u64))]
        offset: u64,
        #[schemars(range(min = 1, max = 9_007_199_254_740_991u64))]
        total_bytes: u64,
        #[schemars(regex(pattern = "^image/(png|jpeg|gif|webp|avif)$"))]
        mime_type: String,
        #[schemars(regex(pattern = "^sha256:[a-f0-9]{64}$"))]
        digest: String,
        #[schemars(
            length(max = 43692),
            regex(pattern = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")
        )]
        data: String,
    },
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentToolImageRead")]
pub struct ToolImageRead {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub through: u64,
    pub position: RowPosition,
    /// Selects one of `HistoryToolResult.images`; absent when the content is the image.
    #[serde(default)]
    pub image: Option<u32>,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub offset: u64,
}
#[derive(Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentToolImagePage")]
pub enum ToolImagePage {
    Ready {
        through: u64,
        position: RowPosition,
        offset: u64,
        #[schemars(range(min = 1, max = 9_007_199_254_740_991u64))]
        total_bytes: u64,
        #[schemars(regex(pattern = "^image/(png|jpeg|gif|webp|avif)$"))]
        mime_type: String,
        #[schemars(regex(pattern = "^sha256:[a-f0-9]{64}$"))]
        digest: String,
        /// Standard padded Base64 of at most 32KiB of encoded image bytes.
        #[schemars(
            length(max = 43692),
            regex(pattern = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")
        )]
        data: String,
    },
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentAttachmentImageRead")]
pub struct AttachmentImageRead {
    #[schemars(length(min = 1))]
    pub session_id: String,
    pub source: AttachmentImageSource,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub offset: u64,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentAttachmentImageSource")]
pub enum AttachmentImageSource {
    Uploaded {
        #[schemars(length(min = 1))]
        id: String,
    },
    History {
        #[schemars(range(max = 9_007_199_254_740_991u64))]
        through: u64,
        position: RowPosition,
        attachment_index: u32,
    },
}
#[derive(Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentAttachmentImagePage")]
pub enum AttachmentImagePage {
    Ready {
        source: AttachmentImageSource,
        offset: u64,
        #[schemars(range(min = 1, max = 9_007_199_254_740_991u64))]
        total_bytes: u64,
        #[schemars(regex(pattern = "^image/(png|jpeg|gif|webp|avif)$"))]
        mime_type: String,
        #[schemars(regex(pattern = "^sha256:[a-f0-9]{64}$"))]
        digest: String,
        /// Standard padded Base64 of at most 32KiB of encoded image bytes.
        #[schemars(
            length(max = 43692),
            regex(pattern = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")
        )]
        data: String,
    },
}

#[derive(Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "AgentToolNames")]
pub struct ToolNames {
    pub names: Vec<String>,
}
pub fn contract() -> Contract {
    use crate::preset::*;
    fn method<I: JsonSchema, O: JsonSchema>(mode: MethodMode) -> Method {
        Method {
            progress: None,
            mode,
            input: serde_json::to_value(schemars::schema_for!(I))
                .expect("input schema")
                .into(),
            output: serde_json::to_value(schemars::schema_for!(O))
                .expect("output schema")
                .into(),
            resources: BTreeMap::new(),
        }
    }
    Contract {
        name: "maka.agent.Agent".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: BTreeMap::from([
                ("presets".into(), method::<PresetsRead, Vec<PresetSummary>>(MethodMode::Query)),
                ("preset".into(), method::<PresetRead, Option<PresetDetail>>(MethodMode::Query)),
                ("createPreset".into(), method::<PresetCreate, PresetResult>(MethodMode::Mutation)),
                ("updatePreset".into(), method::<PresetUpdate, PresetResult>(MethodMode::Mutation)),
                ("deletePreset".into(), method::<PresetDelete, PresetResult>(MethodMode::Mutation)),
                ("sessionMcp".into(), method::<SessionMcp, SessionMcpAttached>(MethodMode::Subscription)),
                ("projectMcp".into(), method::<McpRead, McpView>(MethodMode::Query)),
                ("trustProjectMcp".into(), method::<McpTrust, McpTrustResult>(MethodMode::Mutation)),
                (
                    "globalInstructions".into(),
                    method::<GlobalInstructionsRead, GlobalInstructionsView>(MethodMode::Query),
                ),
                (
                    "updateGlobalInstructions".into(),
                    method::<GlobalInstructionsUpdate, GlobalInstructionsUpdated>(
                        MethodMode::Mutation,
                    ),
                ),
                (
                    "skillCandidates".into(),
                    method::<SkillCandidatesRead, SkillCandidates>(MethodMode::Query),
                ),
                (
                    "fileCandidates".into(),
                    method::<FileCandidatesRead, Option<FileCandidates>>(MethodMode::Subscription),
                ),
                (
                    "tools".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Query,
                        input: serde_json::json!({"type":"object","properties":{},"additionalProperties":false}).into(),
                        output: schemars::schema_for!(ToolNames).into(),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "goal".into(),
                    method::<GoalRead, GoalView>(MethodMode::Query),
                ),
                (
                    "watchGoal".into(),
                    method::<GoalRead, GoalView>(MethodMode::Subscription),
                ),
                (
                    "changeGoal".into(),
                    method::<GoalChange, GoalResult>(MethodMode::Mutation),
                ),
                (
                    "checklist".into(),
                    method::<ChecklistRead, Checklist>(MethodMode::Query),
                ),
                (
                    "predictNextMessage".into(),
                    method::<PredictNextMessage, MessagePrediction>(MethodMode::Mutation),
                ),
                (
                    "recap".into(),
                    method::<RecapRead, Option<RecapReceipt>>(MethodMode::Query),
                ),
                (
                    "generateRecap".into(),
                    method::<RecapGenerate, RecapReceipt>(MethodMode::Mutation),
                ),
                (
                    "watchChecklist".into(),
                    method::<ChecklistRead, Checklist>(MethodMode::Subscription),
                ),
                (
                    "openBot".into(),
                    method::<BotOpen, BotOpened>(MethodMode::Mutation),
                ),
                (
                    "markBotRead".into(),
                    method::<BotMarkRead, BotOutbox>(MethodMode::Mutation),
                ),
                (
                    "botOutbox".into(),
                    method::<BotOutboxRead, BotOutbox>(MethodMode::Query),
                ),
                (
                    "watchBotOutbox".into(),
                    method::<BotOutboxRead, BotOutbox>(MethodMode::Subscription),
                ),
                (
                    "schedules".into(),
                    method::<ScheduleRead, Schedules>(MethodMode::Query),
                ),
                (
                    "watchSchedules".into(),
                    method::<ScheduleRead, Schedules>(MethodMode::Subscription),
                ),
                (
                    "scheduleAlerts".into(),
                    method::<ScheduleAlertsRead, ScheduleAlerts>(MethodMode::Subscription),
                ),
                (
                    "schedule".into(),
                    method::<ScheduleChange, ScheduleResult>(MethodMode::Mutation),
                ),
                (
                    "list".into(),
                    method::<List, SessionPage>(MethodMode::Query),
                ),
                (
                    "catalog".into(),
                    method::<List, SessionPage>(MethodMode::Subscription),
                ),
                (
                    "recall".into(),
                    method::<RecallQuery, RecallPage>(MethodMode::Subscription),
                ),
                (
                    "imports".into(),
                    method::<ImportsRead, ImportsPage>(MethodMode::Query),
                ),
                (
                    "import".into(),
                    method::<ImportChange, ImportResult>(MethodMode::Mutation),
                ),
                (
                    "importDirectories".into(),
                    method::<Directories, DirectoryPage>(MethodMode::Query),
                ),
                (
                    "projects".into(),
                    method::<ProjectsRead, ProjectsPage>(MethodMode::Query),
                ),
                (
                    "project".into(),
                    method::<ProjectChange, ProjectResult>(MethodMode::Mutation),
                ),
                ("mcpConfigurations".into(), method::<McpConfigurations, McpConfigurationList>(MethodMode::Query)),
                ("manageMcpServer".into(), method::<McpConfigurationChange, McpConfigurationResult>(MethodMode::Mutation)),
                (
                    "directories".into(),
                    method::<Directories, DirectoryPage>(MethodMode::Query),
                ),
                (
                    "selectWorkspace".into(),
                    method::<DirectoryPath, Option<Workspace>>(MethodMode::Mutation),
                ),
                (
                    "observe".into(),
                    method::<SessionRead, Observation>(MethodMode::Query),
                ),
                (
                    "diagnostics".into(),
                    method::<Diagnostics, DiagnosticPage>(MethodMode::Query),
                ),
                (
                    "watchDiagnostics".into(),
                    method::<SessionRead, DiagnosticChange>(MethodMode::Subscription),
                ),
                (
                    "history".into(),
                    method::<History, HistoryPage>(MethodMode::Query),
                ),
                (
                    "historyLandmarks".into(),
                    method::<HistoryLandmarksRead, HistoryLandmarks>(MethodMode::Query),
                ),
                (
                    "historyPrompt".into(),
                    method::<HistoryPromptRead, Option<HistoryPrompt>>(MethodMode::Query),
                ),
                (
                    "historyRequests".into(),
                    method::<HistoryRequestsRead, HistoryRequests>(MethodMode::Query),
                ),
                (
                    "search".into(),
                    method::<HistorySearch, HistorySearchPage>(MethodMode::Query),
                ),
                (
                    "source".into(),
                    method::<HistorySourceRead, HistorySourcePage>(MethodMode::Query),
                ),
                (
                    "toolImage".into(),
                    method::<ToolImageRead, ToolImagePage>(MethodMode::Query),
                ),
                (
                    "attachmentImage".into(),
                    method::<AttachmentImageRead, AttachmentImagePage>(MethodMode::Query),
                ),
                (
                    "create".into(),
                    method::<Create, Created>(MethodMode::Mutation),
                ),
                (
                    "previewHistoryCheckpoint".into(),
                    method::<SessionRead, HistoryCheckpointInventory>(MethodMode::Query),
                ),
                (
                    "publishCheckpoint".into(),
                    method::<CheckpointPublish, CheckpointPublication>(MethodMode::Mutation),
                ),
                (
                    "checkpointReceipt".into(),
                    method::<CheckpointReceiptRead, CheckpointReceipt>(MethodMode::Query),
                ),
                (
                    "historyCheckpointHead".into(),
                    method::<SessionRead, Option<HistoryCheckpointHead>>(MethodMode::Query),
                ),
                (
                    "readHistoryCheckpoint".into(),
                    method::<HistoryCheckpointRead, Option<HistoryCheckpointFrame>>(MethodMode::Subscription),
                ),
                ("loadHistoryCheckpoint".into(), method::<HistoryCheckpointRead, CheckpointLoad>(MethodMode::Mutation)),
                ("restoreSessionCheckpoint".into(), method::<SessionCheckpointRestore, SessionCheckpointRestored>(MethodMode::Mutation)),
                ("sessionCheckpointRestoreReceipt".into(), method::<SessionCheckpointRestoreReceiptRead, SessionCheckpointRestoreReceipt>(MethodMode::Query)),
                ("historyCheckpointLoadReceipt".into(), method::<CheckpointLoadReceiptRead, CheckpointLoadReceipt>(MethodMode::Query)),
                ("loadedHistoryCheckpointHistory".into(), method::<CheckpointHistoryRead, HistoryPage>(MethodMode::Query)),
                ("loadedHistoryCheckpointSource".into(), method::<CheckpointSourceRead, maka_agent_ports::session::history::HistorySource>(MethodMode::Query)),
                ("loadedHistoryCheckpointToolImage".into(), method::<CheckpointToolImageRead, HistoryImagePage>(MethodMode::Query)),
                ("loadedHistoryCheckpointAttachmentImage".into(), method::<CheckpointAttachmentImageRead, HistoryImagePage>(MethodMode::Query)),
                ("loadedHistoryCheckpointArtifacts".into(), method::<CheckpointArtifactsRead, CheckpointArtifacts>(MethodMode::Query)),
                ("loadedHistoryCheckpointArtifact".into(), method::<CheckpointArtifactRead, Option<CheckpointArtifactChunk>>(MethodMode::Subscription)),
                (
                    "fork".into(),
                    method::<Fork, ForkResult>(MethodMode::Mutation),
                ),
                (
                    "forkReceipt".into(),
                    method::<ForkReceipt, ForkReceiptResult>(MethodMode::Query),
                ),
                (
                    "listFiles".into(),
                    method::<FileListRead, FilePage>(MethodMode::Query),
                ),
                (
                    "watchFiles".into(),
                    method::<FileWatch, FileChange>(MethodMode::Subscription),
                ),
                (
                    "readFile".into(),
                    method::<FileRead, Option<FileReadPart>>(MethodMode::Subscription),
                ),
                (
                    "context".into(),
                    method::<ContextRead, ContextReport>(MethodMode::Query),
                ),
                (
                    "gitStatus".into(),
                    method::<SessionRead, Option<GitStatus>>(MethodMode::Query),
                ),
                (
                    "gitDiff".into(),
                    method::<GitDiffRead, Option<GitDiff>>(MethodMode::Query),
                ),
                (
                    "snapshotPatch".into(),
                    method::<ExecutionRead, PatchResult>(MethodMode::Mutation),
                ),
                (
                    "readPatch".into(),
                    method::<PatchRead, PatchPage>(MethodMode::Query),
                ),
                (
                    "metadata".into(),
                    method::<Metadata, MetadataResult>(MethodMode::Mutation),
                ),
                (
                    "changeSession".into(),
                    method::<ChangeSession, SessionChanged>(MethodMode::Mutation),
                ),
                (
                    "selectBackend".into(),
                    method::<SelectBackend, MetadataResult>(MethodMode::Mutation),
                ),
                // Authorizes the entire bounded run against the immutable selected
                // account/model. A started reply is not a terminal business verdict.
                (
                    "send".into(),
                    method::<Send, SendResult>(MethodMode::Mutation),
                ),
                ("models".into(), method::<ModelsRead, ModelsPage>(MethodMode::Query)),
                ("model".into(), method::<ModelRead, ModelResult>(MethodMode::Query)),
                ("externalAgents".into(),method::<crate::external::ExternalAgentsRead, crate::external::ExternalAgents>(MethodMode::Query)),
                ("externalUsageLimits".into(),method::<crate::external::ExternalUsageLimitsRead, crate::external::ExternalUsageLimits>(MethodMode::Query)),
                (
                    "executorSetup".into(),
                    Method {
                        mode: MethodMode::Mutation,
                        input: schemars::schema_for!(crate::executor::setup::Input).into(),
                        output: schemars::schema_for!(crate::executor::setup::Outcome).into(),
                        progress: Some(
                            schemars::schema_for!(crate::executor::setup::Progress).into(),
                        ),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "executors".into(),
                    method::<ExecutorsRead, Executors>(MethodMode::Query),
                ),
                (
                    "uploadAttachment".into(),
                    Method {
                        progress: None,
                        resources: BTreeMap::from([(
                            "file".into(),
                            maka_plugin_core::contract::binary_resource_type().required(),
                        )]),
                        ..method::<UploadAttachment, AttachmentUploadResult>(MethodMode::Mutation)
                    },
                ),
                (
                    "execution".into(),
                    method::<ExecutionRead, ExecutionResult>(MethodMode::Query),
                ),
                ("work".into(), method::<WorkRead, Work>(MethodMode::Query)),
                ("workReadiness".into(), method::<WorkRead, WorkReadiness>(MethodMode::Query)),
                (
                    "compactionPrompt".into(),
                    method::<SessionRead, CompactionPrompt>(MethodMode::Query),
                ),
                (
                    "setCompactionPrompt".into(),
                    method::<SetCompactionPrompt, MetadataResult>(MethodMode::Mutation),
                ),
                (
                    "compact".into(),
                    method::<Compact, CompactResult>(MethodMode::Mutation),
                ),
                (
                    "continuationAvailability".into(),
                    method::<ExecutionRead, ContinuationAvailability>(MethodMode::Query),
                ),
                (
                    "continueRun".into(),
                    method::<ContinueRun, ContinuationResult>(MethodMode::Mutation),
                ),
                ("stop".into(), method::<Stop, Stopped>(MethodMode::Mutation)),
                (
                    "computerApps".into(),
                    method::<SessionRead, ComputerApps>(MethodMode::Query),
                ),
                (
                    "stopComputerApp".into(),
                    method::<StopComputerApp, Stopped>(MethodMode::Mutation),
                ),
                (
                    "markRead".into(),
                    method::<MarkRead, MarkReadResult>(MethodMode::Mutation),
                ),
                (
                    "queue".into(),
                    method::<SessionRead, Queue>(MethodMode::Query),
                ),
                (
                    "queueMessage".into(),
                    method::<QueueMessage, QueueMessageResult>(MethodMode::Query),
                ),
                (
                    "editQueue".into(),
                    method::<QueueMutation, QueueMutationResult>(MethodMode::Mutation),
                ),
                (
                    "pendingInteractions".into(),
                    method::<SessionRead, PendingInteractions>(MethodMode::Query),
                ),
                (
                    "interaction".into(),
                    method::<InteractionRead, maka_agent_facts::interaction::InteractionRecord>(
                        MethodMode::Query,
                    ),
                ),
                (
                    "systemPermissionStatus".into(),
                    method::<InteractionRead, SystemPermissionStatus>(MethodMode::Query),
                ),
                (
                    "requestSystemPermission".into(),
                    method::<RequestSystemPermission, SystemPermissionStatus>(MethodMode::Mutation),
                ),
                (
                    "respond".into(),
                    method::<InteractionRespond, InteractionResult>(MethodMode::Mutation),
                ),
                (
                    "watch".into(),
                    method::<Watch, DeliveryPage>(MethodMode::Subscription),
                ),
            ]),
        },
    }
}
