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

//! Human-symmetric Agent tool contracts for discovering, reading, creating and operating Sessions.
use super::{
    BackendPreference, ContinuationRejection, Execution, ModelSelection, QueueAction,
    QueueMutationResult, Rejection, RoomManageResult, SendDelivery, Session, SessionActivity,
    SessionKind, WorkspacePermissions,
};
use maka_agent_facts::{
    attachment::AttachmentKind,
    durable::RunId,
    execution::ThinkingLevel,
    history::HistoryRowAddress,
    interaction::InteractionRecord,
    room::{RoomAuthor, RoomDelivery, RoomDeliveryState, RoomMember, RoomReaction},
};
use maka_agent_ports::session::history::HistoryField;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

const MAX_SAFE_INT: u64 = 9_007_199_254_740_991;

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSessionSummary")]
pub struct SessionSummary {
    pub id: String,
    pub kind: SessionKind,
    pub title: String,
    pub activity: SessionActivity,
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<BackendPreference>,
    pub permissions: WorkspacePermissions,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    pub pinned: bool,
    pub archived: bool,
    #[schemars(range(max = MAX_SAFE_INT))]
    pub revision: u64,
    #[schemars(range(max = MAX_SAFE_INT))]
    pub updated_at: u64,
}

impl From<Session> for SessionSummary {
    fn from(session: Session) -> Self {
        let worktree_directory = session
            .workspace
            .worktree
            .as_ref()
            .map(|wt| wt.directory().to_string_lossy().into_owned());
        Self {
            id: session.id,
            kind: session.kind,
            title: session.title,
            activity: session.activity,
            workspace_path: session.workspace.path,
            worktree_directory,
            parent_session_id: session.parent_session_id,
            preset_name: session.applied_preset.map(|preset| preset.name),
            backend: session.backend,
            permissions: session.permissions,
            labels: session.labels,
            pinned: session.pinned,
            archived: session.archived,
            revision: session.revision,
            updated_at: session.updated_at,
        }
    }
}

#[derive(Clone, Copy, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentSessionToolScope")]
pub enum SessionToolScope {
    #[default]
    All,
    /// Direct workers created by parentSessionId (defaults to your own Session when omitted).
    Children,
    Archived,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSessionListInput")]
pub struct SessionListInput {
    #[serde(default)]
    pub kind: Option<SessionKind>,
    #[serde(default)]
    pub scope: SessionToolScope,
    /// Optional parent Session ID when scope is "children"; defaults to your own Session.
    #[serde(default)]
    pub parent_session_id: Option<String>,
    /// Case-insensitive substring matched against title or workspace path.
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub activity: Option<SessionActivity>,
    #[serde(default)]
    #[schemars(range(min = 1, max = 100))]
    pub limit: Option<usize>,
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSessionListOutput")]
pub struct SessionListOutput {
    pub sessions: Vec<SessionSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentSessionTranscriptView")]
pub enum SessionTranscriptView {
    /// Clean conversation digest: user messages, assistant replies, and compact 1-line tool outcomes.
    #[default]
    Turns,
    /// Include raw tool call/result bodies inline.
    Raw,
    /// Return only Session status, Run state, pending interactions, and queue without transcript rows.
    StatusOnly,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentSessionWindowPosition")]
pub enum SessionWindowPosition {
    #[default]
    Tail,
    Start,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentRoomAnchorMode")]
pub enum RoomAnchorMode {
    #[default]
    At,
    Before,
    After,
    Around,
}

#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSessionRowLookup")]
pub struct SessionRowLookup {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(max = MAX_SAFE_INT))]
    pub through: Option<u64>,
    pub position: HistoryRowAddress,
    #[serde(default)]
    pub field: HistoryField,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSessionReadInput")]
pub struct SessionReadInput {
    /// Target Session or Room ID. Omit to inspect your own Session.
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub view: SessionTranscriptView,
    #[serde(default)]
    pub position: Option<SessionWindowPosition>,
    /// Opaque pagination token (beforeCursor or afterCursor) from a previous SessionRead.
    #[serde(default)]
    pub cursor: Option<String>,
    /// Jump to or around a specific Room messageId.
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub anchor: Option<RoomAnchorMode>,
    /// Full-text search within a Room; returns matching posts with snippets.
    #[serde(default)]
    pub search_query: Option<String>,
    /// Exact historical row lookup emitted by Recall or Code Mode cell references.
    #[serde(default)]
    pub row: Option<SessionRowLookup>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSessionRunOverview")]
pub struct SessionRunOverview {
    pub run_id: RunId,
    pub state: String,
    pub stopped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blockers: Vec<String>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentQueuedMessageOverview")]
pub struct QueuedMessageOverview {
    pub message_id: String,
    pub text: String,
    pub editable_by_caller: bool,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentTranscriptEntry")]
pub struct AgentTranscriptEntry {
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Pass to Read({ path }) to inspect the full output of this tool call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(max = MAX_SAFE_INT))]
    pub offset: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(max = MAX_SAFE_INT))]
    pub total_bytes: Option<u64>,
    pub text: String,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentRoomAttachmentEntry")]
pub struct RoomAttachmentEntry {
    pub name: String,
    pub mime_type: String,
    #[schemars(range(max = MAX_SAFE_INT))]
    pub bytes: u64,
    pub kind: AttachmentKind,
    /// Pass directly to Read({ path }) to inspect this Room attachment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_path: Option<String>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentRoomPostEntry")]
pub struct RoomPostEntry {
    pub id: String,
    #[schemars(range(max = MAX_SAFE_INT))]
    pub sequence: u64,
    #[schemars(range(max = MAX_SAFE_INT))]
    pub at: u64,
    pub author: RoomAuthor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_name: Option<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<RoomAttachmentEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deliveries: Vec<RoomDelivery>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub delivery_states: Vec<RoomDeliveryState>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reactions: Vec<RoomReaction>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(max = MAX_SAFE_INT))]
    pub edited_at: Option<u64>,
    #[serde(default)]
    pub deleted: bool,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentRoomOverview")]
pub struct RoomOverview {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub topic: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<RoomMember>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pinned_message_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentSessionTranscript")]
pub enum SessionTranscript {
    Agent {
        items: Vec<AgentTranscriptEntry>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        before_cursor: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after_cursor: Option<String>,
    },
    Room {
        items: Vec<RoomPostEntry>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        before_cursor: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after_cursor: Option<String>,
    },
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSessionReadOutput")]
pub struct SessionReadOutput {
    pub session: SessionSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<SessionRunOverview>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_interactions: Vec<InteractionRecord>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub queued_messages: Vec<QueuedMessageOverview>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(max = MAX_SAFE_INT))]
    pub queue_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_output_preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room: Option<RoomOverview>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript: Option<SessionTranscript>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentSessionWorkspaceTarget")]
pub enum SessionWorkspaceTarget {
    /// Reuse your current Session workspace (the default when omitted).
    #[default]
    Same,
    /// Allocate an isolated Git worktree managed by Maka (defaults to your current repo when path is omitted).
    Worktree {
        #[serde(default)]
        path: Option<String>,
    },
    Directory {
        #[schemars(length(min = 1))]
        path: String,
    },
    Session {
        #[schemars(length(min = 1))]
        session_id: String,
    },
    Project {
        project_id: uuid::Uuid,
        #[schemars(length(min = 1))]
        path: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSessionForkFrom")]
pub struct SessionForkFrom {
    #[schemars(length(min = 1))]
    pub session_id: String,
    /// Optional turn boundary to fork through; defaults to the end of the source Session.
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    #[schemars(range(min = 1, max = MAX_SAFE_INT))]
    pub expected_revision: Option<u64>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSessionCreateInput")]
pub struct SessionCreateInput {
    #[schemars(length(min = 1))]
    pub title: String,
    #[serde(default)]
    pub kind: Option<SessionKind>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub workspace: Option<SessionWorkspaceTarget>,
    #[serde(default)]
    pub preset_id: Option<crate::preset::PresetId>,
    #[serde(default)]
    pub backend: Option<BackendPreference>,
    #[serde(default)]
    pub automatic_title: Option<bool>,
    #[serde(default)]
    #[schemars(extend("uniqueItems" = true))]
    pub tools: Option<Vec<String>>,
    /// Seed the new conversation from an existing Session prefix instead of starting empty.
    #[serde(default)]
    pub fork_from: Option<SessionForkFrom>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentSessionCreateOutput")]
pub enum SessionCreateOutput {
    Created { session: Box<Session> },
    Forked { session: Box<Session> },
    RevisionConflict { expected: u64, actual: u64 },
    Rejected { reason: Rejection },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentSessionNotifyMode")]
pub enum SessionNotifyMode {
    NotifyCaller,
    None,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSessionSendInput")]
pub struct SessionSendInput {
    #[schemars(length(min = 1))]
    pub session_id: String,
    pub message: String,
    /// Defaults to steer (injects cleanly at the next step boundary without aborting in-flight tools).
    /// Pass queue to wait until the current turn finishes before delivering.
    #[serde(default)]
    pub delivery: Option<SendDelivery>,
    /// For Agent callers sending to a worker Session, defaults to notify_caller. Pass none to silence.
    #[serde(default)]
    pub on_complete: Option<SessionNotifyMode>,
    #[serde(default)]
    pub backend: Option<BackendPreference>,
    #[serde(default)]
    pub expected_run_id: Option<RunId>,
    #[serde(default)]
    pub attachments: Vec<String>,
    /// Agent Session IDs to notify when posting in a Room.
    #[serde(default)]
    pub mentions: Vec<String>,
    /// Existing Room messageId being replied to.
    #[serde(default)]
    pub reply_to: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSessionStopInput")]
pub struct SessionStopInput {
    #[schemars(length(min = 1))]
    pub session_id: String,
    /// Optional exact Run ID guard; omit to stop whichever Run is currently active.
    #[serde(default)]
    pub run_id: Option<RunId>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSessionStopOutput")]
pub struct SessionStopOutput {
    pub requested: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentSessionManageAction")]
pub enum SessionManageAction {
    Update {
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        labels: Option<Vec<String>>,
        #[serde(default)]
        pinned: Option<bool>,
        #[serde(default)]
        #[schemars(range(min = 1, max = MAX_SAFE_INT))]
        expected_revision: Option<u64>,
    },
    Archive {
        #[serde(default)]
        #[schemars(range(min = 1, max = MAX_SAFE_INT))]
        expected_revision: Option<u64>,
    },
    Restore {
        #[serde(default)]
        #[schemars(range(min = 1, max = MAX_SAFE_INT))]
        expected_revision: Option<u64>,
    },
    Remove {
        #[serde(default)]
        #[schemars(range(min = 1, max = MAX_SAFE_INT))]
        expected_revision: Option<u64>,
    },
    EditQueue {
        edit: QueueAction,
        #[serde(default)]
        #[schemars(range(max = MAX_SAFE_INT))]
        expected_revision: Option<u64>,
    },
    ContinueRun {
        model: ModelSelection,
        #[serde(default)]
        thinking_level: Option<ThinkingLevel>,
        #[serde(default)]
        source_run_id: Option<RunId>,
        #[serde(default)]
        #[schemars(range(min = 1, max = MAX_SAFE_INT))]
        source_high_water: Option<u64>,
    },
    /// Update a Room's topic / shared goal statement.
    RoomTopic { topic: String },
    /// Add or remove Agent conversations in a Room's member roster.
    RoomMembers {
        #[serde(default)]
        add: Vec<String>,
        #[serde(default)]
        remove: Vec<String>,
    },
    /// Add, remove, or toggle an emoji reaction on a Room message (e.g. ✅ or 👀).
    RoomReact {
        message_id: String,
        emoji: String,
        /// Omit to toggle; true to add, false to remove.
        #[serde(default)]
        add: Option<bool>,
    },
    /// Pin or unpin an important Room message.
    RoomPin { message_id: String, pinned: bool },
    /// Edit a Room message you posted.
    RoomEdit { message_id: String, text: String },
    /// Retract (soft-delete) a Room message you posted.
    RoomDelete { message_id: String },
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSessionManageInput")]
pub struct SessionManageInput {
    #[schemars(length(min = 1))]
    pub session_id: String,
    pub action: SessionManageAction,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentSessionManageOutput")]
pub enum SessionManageOutput {
    Updated { session: Box<SessionSummary> },
    Removed { session_id: String },
    QueueEdited { result: QueueMutationResult },
    ContinuationStarted { execution: Box<Execution> },
    ContinuationRejected { reason: ContinuationRejection },
    RoomUpdated { result: RoomManageResult },
    RevisionConflict { expected: u64, actual: u64 },
    Rejected { reason: Rejection },
}
