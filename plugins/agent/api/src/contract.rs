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

use maka_agent_facts::execution::DirectoryIdentity;
use maka_agent_facts::execution::WorkspaceIdentity;
use maka_agent_facts::history::RowPosition;
use maka_agent_ports::session::history::Cursor;
use maka_agent_ports::session::history::Role;
use maka_plugin_core::contract::{Contract, Interface, Method, MethodMode, Transport};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[path = "contract_mcp.rs"]
mod mcp;
pub use mcp::*;
#[path = "contract_context.rs"]
mod context;
pub use context::*;
#[path = "contract_files.rs"]
mod files;
pub use files::*;
#[path = "contract_fork.rs"]
mod fork;
pub use fork::*;
#[path = "contract_git.rs"]
mod git;
pub use git::*;
#[path = "contract_goal.rs"]
mod goal;
#[path = "contract_imports.rs"]
mod imports;
#[path = "contract_plan.rs"]
mod plan;
pub use goal::*;
pub use maka_agent_facts::execution::CollaborationMode;
pub use plan::*;
#[path = "contract_todo.rs"]
mod todo;
pub use todo::*;
#[path = "contract_recap.rs"]
mod recap;
pub use recap::*;
#[path = "contract_scheduler.rs"]
mod scheduler;
pub use scheduler::*;
#[path = "contract_recall.rs"]
mod recall;
pub use imports::*;
pub use recall::*;
#[path = "contract_projects.rs"]
mod projects;
pub use projects::*;
#[path = "contract_execution.rs"]
mod execution;
pub use execution::*;
#[path = "contract_compaction.rs"]
mod compaction;
pub use compaction::*;

#[path = "contract_interactions.rs"]
mod interaction;
pub use interaction::*;
#[path = "contract_permissions.rs"]
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
    /// Enable explicitly approved, bounded Goal continuation.
    #[serde(default)]
    pub goals: bool,
    /// Enable planning, reviewed approval and execution progress.
    #[serde(default)]
    pub plans: bool,
    /// Enable the session-scoped, model-maintained checklist.
    #[serde(default)]
    pub todo: bool,
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
    #[schemars(length(min = 1))]
    pub import: String,
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
    Complete,
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
    /// Treat title as a placeholder for one title derived from the first user message.
    #[serde(default)]
    pub automatic_title: bool,
    /// Immutable narrowing of this Agent's installed tools. None uses the installation;
    /// an empty list permits no model tools. External executors cannot enforce this.
    #[serde(default)]
    #[schemars(extend("uniqueItems" = true))]
    pub tools: Option<Vec<String>>,
    #[schemars(length(min = 1))]
    pub title: String,
    pub labels: Vec<String>,
    pub workspace: WorkspaceSelection,
}

#[derive(Clone, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentWorkspaceSelection")]
pub enum WorkspaceSelection {
    IsolatedGit {
        selection: DirectorySelection,
    },
    Project {
        project: ProjectRef,
        selection: DirectorySelection,
    },
    Directory {
        selection: DirectorySelection,
    },
    Session {
        #[schemars(length(min = 1))]
        session_id: String,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentDirectorySelection")]
pub struct DirectorySelection {
    #[schemars(length(min = 1))]
    pub root_id: String,
    pub segments: Vec<String>,
    #[schemars(with = "String", regex(pattern = "^sha256:[a-f0-9]{64}$"))]
    pub directory_identity: DirectoryIdentity,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentDirectories")]
pub enum Directories {
    Roots,
    Children {
        selection: DirectorySelection,
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
    pub selection: DirectorySelection,
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
    /// Changing collaboration is only allowed while the Session is idle.
    #[serde(default)]
    pub collaboration_mode: Option<CollaborationMode>,
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

/// Read-only suggestions resolved against the session's actual skill context.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSkillCandidatesRead")]
pub struct SkillCandidatesRead {
    pub session_id: String,
    pub backend: SkillCandidatesBackend,
    pub query: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentSkillCandidatesBackend")]
pub enum SkillCandidatesBackend {
    Model {
        model: ModelSelection,
        thinking_level: Option<maka_agent_facts::execution::ThinkingLevel>,
    },
    Executor {
        selection: crate::executor::Selection,
    },
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
/// The next turn's choice, independent of an already admitted execution.
/// Model revisions are resolved afresh; preferences never grant execution authority.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
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
        thinking_level: Option<maka_agent_facts::execution::ThinkingLevel>,
    },
    Executor {
        selection: crate::executor::Selection,
    },
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
    TitleInvalid,
    LabelsInvalid,
    ToolsUnavailable,
    Busy,
    WorkspaceUnavailable,
    SessionUnavailable,
    HistoryUnavailable,
    ManagedSession,
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
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSend")]
pub struct Send {
    /// IDs of immutable user uploads in this Session; metadata is resolved by the owner.
    #[serde(default)]
    pub attachments: Vec<String>,
    pub model: ModelSelection,
    /// Omission/null uses the configured model default; `off` is explicit.
    pub thinking_level: Option<maka_agent_facts::execution::ThinkingLevel>,
    #[schemars(length(min = 1))]
    pub session_id: String,

    pub message: String,
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
#[schemars(rename = "AgentExecute")]
pub struct Execute {
    /// IDs of immutable user uploads in this Session, resolved by the Agent owner.
    #[serde(default)]
    pub attachments: Vec<String>,
    #[schemars(length(min = 1))]
    pub session_id: String,

    pub message: String,
    pub executor: crate::executor::Selection,
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
    #[schemars(length(min = 1))]
    pub invocation_id: String,
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
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<SessionBranch>")]
    pub branch: Option<SessionBranch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<BackendPreference>,
    #[serde(default)]
    pub collaboration_mode: CollaborationMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    pub data_source: Box<DataSource>,
    pub permissions: WorkspacePermissions,
    pub boundary_revision: u64,
    pub binding: maka_agent_facts::workspace::BindingStamp,
    pub id: String,
    pub title: String,
    pub labels: Vec<String>,
    pub workspace: Workspace,
    pub revision: u64,
    pub updated_at: u64,
    pub archived: bool,
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
        reason: SkillInputRejection,
        skills: Option<maka_skills::SkillInvocationResult>,
    },
    Started {
        session_id: String,
        invocation_id: String,
        message_id: String,
    },
    Queued {
        session_id: String,
        message_id: String,
        revision: u64,
    },
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentSkillInputRejection")]
pub enum SkillInputRejection {
    SkillsUnavailable,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentStopped")]
pub struct Stopped {
    pub requested: bool,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentDelivery")]
pub struct Delivery {
    pub sequence: u64,
    pub invocation_id: String,
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
    /// Both external text streams share the original ExecutorStarted message.
    ExecutorStarted {
        message_id: String,
    },
    /// Canonical transcript facts changed; clients query bounded history.
    TranscriptChanged,
    StepEnded {
        step_id: String,
        /// The model/executor completed; this says nothing about tool business success.
        completed: bool,
    },
    PartStarted {
        message_id: String,
        step_id: String,
        part_id: String,
        text_kind: ContentKind,
    },
    Delta {
        step_id: String,
        part_id: String,
        text: String,
    },
    PartFinished {
        step_id: String,
        part_id: String,
    },
    /// Model input observations are display-only; they cannot authorize a tool effect.
    ToolInputStarted {
        tool_use_id: String,
        step_id: String,
        name: String,
        provider_executed: bool,
    },
    ToolInputDelta {
        tool_use_id: String,
        text: String,
    },
    /// Complete model input was observed, not authorization to execute it.
    ToolInputReady {
        tool_use_id: String,
        step_id: String,
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
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub compacting: bool,
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
    pub invocation_id: String,
    pub turn_id: String,
    pub state: RunState,
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
    pub step_id: String,
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
    Queue {
        queue: Queue,
    },
    Interactions {
        pending: PendingInteractions,
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
    Missing,
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
    /// Part of the successfully completed native Turn's final output at `through`.
    /// Includes all body parts and source citations; never a Thinking field.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub final_output: bool,
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
    pub message_id: String,
    pub turn_id: String,
    pub timestamp: u64,
    pub role: Role,
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
    #[schemars(length(min = 1))]
    pub turn_id: String,
    pub position: RowPosition,
    pub last_position: RowPosition,
    #[schemars(length(max = 96))]
    pub label: String,
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
        through: u64,
        chunks: Vec<HistoryChunk>,
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<Cursor>")]
        before: Option<Cursor>,
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<Cursor>")]
        after: Option<Cursor>,
    },
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

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentToolImageRead")]
pub struct ToolImageRead {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub through: u64,
    pub position: RowPosition,
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
                    "plan".into(),
                    method::<PlanRead, PlanView>(MethodMode::Query),
                ),
                (
                    "watchPlan".into(),
                    method::<PlanRead, PlanView>(MethodMode::Subscription),
                ),
                (
                    "planHistory".into(),
                    method::<PlanHistoryRead, PlanHistory>(MethodMode::Query),
                ),
                (
                    "planReceipt".into(),
                    method::<PlanReceiptRead, Option<PlanResult>>(MethodMode::Query),
                ),
                (
                    "changePlan".into(),
                    method::<PlanChange, PlanResult>(MethodMode::Mutation),
                ),
                (
                    "goal".into(),
                    method::<GoalRead, GoalView>(MethodMode::Query),
                ),
                (
                    "goalReceipt".into(),
                    method::<GoalReceiptRead, Option<GoalResult>>(MethodMode::Query),
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
                (
                    "directories".into(),
                    method::<Directories, DirectoryPage>(MethodMode::Query),
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
                (
                    "execute".into(),
                    method::<Execute, SendResult>(MethodMode::Mutation),
                ),
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
                (
                    "compactionPrompt".into(),
                    method::<SessionRead, CompactionPrompt>(MethodMode::Query),
                ),
                (
                    "compact".into(),
                    method::<Compact, CompactResult>(MethodMode::Mutation),
                ),
                (
                    "resume".into(),
                    method::<Resume, ResumeResult>(MethodMode::Mutation),
                ),
                ("stop".into(), method::<Stop, Stopped>(MethodMode::Mutation)),
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn history_window_contract_distinguishes_end_from_missing_boundaries() {
        let Interface::Service { methods } = contract().interface else {
            panic!("service contract");
        };
        let validator = jsonschema::validator_for(&methods["history"].output).unwrap();
        let mut page = serde_json::to_value(HistoryPage::Ready {
            through: 16,
            chunks: Vec::new(),
            before: None,
            after: Some(Cursor {
                field: Default::default(),
                position: RowPosition {
                    source_sequence: 16,
                    item_index: 0,
                },
                offset: 0,
            }),
        })
        .unwrap();
        assert!(validator.is_valid(&page));
        page["chunks"] = json!([{
            "messageId":"result", "field":"body", "turnId":"turn", "timestamp":1, "role":"tool_result",
            "position":{"sourceSequence":1,"itemIndex":0}, "offset":0, "totalBytes":0, "text":"",
            "tool":{"toolUseId":"call", "call":null, "result":{"position":{"sourceSequence":1,"itemIndex":0},"isError":true, "image":false,"settlement":null}}
        }]);
        assert!(validator.is_valid(&page));
        let tool = page["chunks"][0]
            .as_object_mut()
            .unwrap()
            .remove("tool")
            .unwrap();
        assert!(
            !validator.is_valid(&page),
            "tool facts are explicit, including null"
        );
        page["chunks"][0]["tool"] = tool;
        page["chunks"][0]["tool"]
            .as_object_mut()
            .unwrap()
            .remove("call");
        assert!(
            !validator.is_valid(&page),
            "missing call reference is not an observed absence"
        );
        page["chunks"][0]["tool"]["call"] = json!(null);
        assert!(validator.is_valid(&page));
        for field in ["before", "after"] {
            let value = page.as_object_mut().unwrap().remove(field).unwrap();
            assert!(!validator.is_valid(&page), "missing {field} is not EOF");
            page.as_object_mut().unwrap().insert(field.into(), value);
        }
        page["after"] = json!(null);
        assert!(validator.is_valid(&page));
        page["next"] = json!(null);
        assert!(
            !validator.is_valid(&page),
            "removed one-way API is rejected"
        );
    }
}
