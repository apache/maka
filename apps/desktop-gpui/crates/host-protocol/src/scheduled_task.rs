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

//! `scheduled-task.query` and `scheduled-task.mutate`: the Host's one
//! catalog of scheduled tasks (定时任务), read in pages, and the changes a
//! client makes to it.
//!
//! Source: `packages/runtime-host/src/protocol/scheduled-task.ts`
//! (`SCHEDULED_TASK_OPERATION_SPECS`, `decodeScheduledTaskQueryInput`,
//! `decodeScheduledTaskQueryResult`, `decodeScheduledTaskMutateInput`,
//! `decodeScheduledTaskMutateResult`, `decodeScheduledTask`,
//! `decodeSchedule`, `decodeEffect`, `decodeExecution`, `decodeCreatedBy`,
//! `decodeRun`) and the domain types in `packages/core/src/scheduled-task.ts`.
//!
//! The catalog is read in pages of at most [`SCHEDULED_TASK_PAGE_MAX_ITEMS`]
//! tasks; a continuation names the first page's revision and answers
//! `revision_changed` when the catalog moved in between. Every change is a
//! `scheduled-task.changed` push ([`crate::ChangeNotice::ScheduledTaskChanged`]).
//! Queries fail with `host_not_ready`, `host_draining`,
//! `operation_unavailable`, `invalid_request`, `persistence_failed`, or
//! `internal_failure` (`QUERY_ERRORS`); a mutation also with `not_found`
//! and `operation_conflict` (`MUTATION_ERRORS`). `trigger_now` on a
//! notification task answers `operation_conflict` while no client
//! provides the native delivery service (Maka Desktop does): the fire
//! waits for one.
//!
//! Timestamps are milliseconds since the Unix epoch.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    CollaborationMode, Nullable, Operation, OrchestrationMode, PermissionMode, ThinkingLevel,
};

/// `SCHEDULED_TASK_PAGE_MAX_ITEMS`: tasks per page.
pub const SCHEDULED_TASK_PAGE_MAX_ITEMS: usize = 64;
/// `SCHEDULED_TASK_CATALOG_MAX_ITEMS`: tasks in the whole catalog; a create
/// past it is refused.
pub const SCHEDULED_TASK_CATALOG_MAX_ITEMS: usize = 256;
/// `SCHEDULED_TASK_TITLE_MAX_CHARS` (in `@maka/core/scheduled-task`).
pub const SCHEDULED_TASK_TITLE_MAX_CHARS: usize = 120;
/// `SCHEDULED_TASK_INTENT_MAX_CHARS`: the notes, or an Agent task's prompt.
pub const SCHEDULED_TASK_INTENT_MAX_CHARS: usize = 8_000;
/// `SCHEDULED_TASK_CRON_MAX_CHARS`.
pub const SCHEDULED_TASK_CRON_MAX_CHARS: usize = 80;
/// `SCHEDULED_TASK_CHAT_ID_MAX_CHARS`.
pub const SCHEDULED_TASK_CHAT_ID_MAX_CHARS: usize = 160;
/// `SCHEDULED_TASK_RUN_HISTORY_LIMIT`: runs a task keeps, newest first.
pub const SCHEDULED_TASK_RUN_HISTORY_LIMIT: usize = 20;
/// `SCHEDULED_TASK_MAX_DELAY_MS`: how far ahead a fire or a snooze may be.
pub const SCHEDULED_TASK_MAX_DELAY_MS: u64 = 366 * 24 * 60 * 60 * 1000;

wire_enum! {
    /// `ScheduledTaskStatus` (`SCHEDULED_TASK_STATUSES`).
    pub enum ScheduledTaskStatus {
        /// On, waiting for `nextFireAt`.
        Active = "active",
        Paused = "paused",
        /// Fired its last time (a one-time task, or `maxFires` reached).
        Completed = "completed",
        /// Reached `expiresAt`.
        Expired = "expired",
    }
}

wire_enum! {
    /// `ScheduledTaskRunOutcome` (`SCHEDULED_TASK_RUN_OUTCOMES`).
    pub enum ScheduledTaskRunOutcome {
        /// Delivered, or the Agent run was admitted.
        Ok = "ok",
        Failed = "failed",
        /// Skipped on purpose (incognito mode, a platform that cannot
        /// deliver).
        Blocked = "blocked",
    }
}

wire_enum! {
    /// `ScheduledTaskCreatedByKind`.
    pub enum ScheduledTaskCreatorKind {
        User = "user",
        /// A task an Agent created from a Session (`sessionId` names it).
        Agent = "agent",
        System = "system",
    }
}

wire_enum! {
    /// The calendar recurrences of a `calendar` schedule.
    pub enum ScheduledTaskCalendarRecurrence {
        Daily = "daily",
        Weekly = "weekly",
        Monthly = "monthly",
    }
}

wire_enum! {
    /// `BotDeliveryProvider` (`BOT_DELIVERY_PROVIDERS` in
    /// `@maka/core/bot-chat-settings`): the bot platforms a scheduled task
    /// can deliver to. Feishu and WeCom are bot platforms but not delivery
    /// targets.
    pub enum ScheduledTaskBotPlatform {
        Telegram = "telegram",
        Wechat = "wechat",
        Discord = "discord",
        Dingtalk = "dingtalk",
        Qq = "qq",
        Slack = "slack",
    }
}

impl ScheduledTaskBotPlatform {
    /// `BOT_DELIVERY_PROVIDERS`, in Desktop's order.
    pub const DELIVERY: [Self; 6] =
        [Self::Telegram, Self::Wechat, Self::Discord, Self::Dingtalk, Self::Qq, Self::Slack];
}

wire_enum! {
    /// `ToolMode` (`@maka/core/tool-mode`): how an Agent task's run calls
    /// tools. A template without one uses `direct`.
    pub enum ToolMode {
        Direct = "direct",
        CodeMode = "code_mode",
    }
}

wire_tag! {
    /// `ScheduledTask.intent.kind`: always `text`.
    IntentKind = "text"
}

/// `ScheduledTask.intent`: the notes of a reminder, the prompt of an Agent
/// task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ScheduledTaskIntent {
    kind: IntentKind,
    pub body: String,
}

impl ScheduledTaskIntent {
    pub fn new(body: impl Into<String>) -> Self {
        Self { kind: IntentKind, body: body.into() }
    }
}

/// `ScheduledTaskSchedule` (`decodeSchedule`): when a task fires.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ScheduledTaskSchedule {
    /// Once, at `run_at`.
    #[serde(rename_all = "camelCase")]
    Once { run_at: u64 },
    /// Every `every_seconds` (10 s to 366 days) from `start_at`. Only an
    /// Agent creates these; a person's form cannot.
    #[serde(rename_all = "camelCase")]
    Interval { every_seconds: u64, start_at: u64 },
    /// Every day, week, or month at `anchor_at`'s local time (and weekday,
    /// or day of the month, clamped to the month's last day).
    #[serde(rename_all = "camelCase")]
    Calendar { recurrence: ScheduledTaskCalendarRecurrence, anchor_at: u64 },
    /// A five-field cron expression in the Host's local time zone, not
    /// before `start_at`.
    #[serde(rename_all = "camelCase")]
    Cron { expression: String, start_at: u64 },
    /// A schedule kind this client does not recognize. The payload is
    /// dropped; the task is never sent back with it.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// A notification's channel (`decodeEffect`, `kind: "notify"`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "channel", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ScheduledTaskNotify {
    /// A notification on this machine, which Maka Desktop's native effect
    /// service shows.
    Local,
    /// A message to a bot chat, which Maka Desktop's bot registry sends.
    #[serde(rename_all = "camelCase")]
    Bot { platform: ScheduledTaskBotPlatform, chat_id: String },
}

/// `ScheduledTaskEffect` (`decodeEffect`): what happens when a task fires.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum ScheduledTaskEffect {
    /// A notification, delivered by a client's native effect service.
    Notify(ScheduledTaskNotify),
    /// A new Agent task, run with the settings frozen at creation.
    AgentRun { execution: Box<ScheduledTaskExecutionTemplate> },
    /// The creating Session continues.
    #[serde(rename_all = "camelCase")]
    SessionResume { session_id: String },
    /// An effect kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

impl ScheduledTaskEffect {
    /// A notification on this machine.
    pub fn local() -> Self {
        Self::Notify(ScheduledTaskNotify::Local)
    }

    /// A message to `chat_id` on `platform`.
    pub fn bot(platform: ScheduledTaskBotPlatform, chat_id: impl Into<String>) -> Self {
        Self::Notify(ScheduledTaskNotify::Bot { platform, chat_id: chat_id.into() })
    }

    /// Whether the effect starts or continues an Agent task (Desktop's
    /// "Agent scheduled task"), rather than notifying.
    pub fn is_agent(&self) -> bool {
        matches!(self, Self::AgentRun { .. } | Self::SessionResume { .. })
    }
}

/// `ScheduledTaskExecutionTemplate` (`decodeExecution`): an Agent task's
/// run settings, frozen when it was created.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ScheduledTaskExecutionTemplate {
    /// Absent on templates older than Code Mode: `direct`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_mode: Option<ToolMode>,
    pub cwd: String,
    /// Absent, `null`, or the project the run goes into. A create or update
    /// without one submits a Host path (`scheduledTaskMutationUsesHostPath`).
    #[serde(default, skip_serializing_if = "Nullable::is_absent")]
    pub project_id: Nullable<String>,
    /// The Connection entity. Absent only on legacy slug-only templates,
    /// which the Host no longer runs and a change may not submit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llm_connection_id: Option<String>,
    pub llm_connection_slug: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<ThinkingLevel>,
    pub permission_mode: PermissionMode,
    pub collaboration_mode: CollaborationMode,
    pub orchestration_mode: OrchestrationMode,
    /// `backend` left the template (#3306); templates frozen by older
    /// builds still carry it. Read and never sent, as the TypeScript
    /// decoder drops it.
    #[serde(default, skip_serializing)]
    backend: Option<Value>,
}

/// `ScheduledTaskCreatedBy` (`decodeCreatedBy`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ScheduledTaskCreatedBy {
    pub kind: ScheduledTaskCreatorKind,
    /// The Session that created it, for an Agent's task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// `ScheduledTaskRun` (`decodeRun`): one fire, as the task's history keeps
/// it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ScheduledTaskRun {
    pub id: String,
    pub at: u64,
    pub outcome: ScheduledTaskRunOutcome,
    /// The Host's words for what happened (at most 1024 characters; the
    /// Host writes them in Chinese).
    pub message: String,
    /// The Session an Agent task's run went into.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

/// `ScheduledTask` (`decodeScheduledTask`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ScheduledTask {
    pub id: String,
    pub title: String,
    pub intent: ScheduledTaskIntent,
    pub schedule: ScheduledTaskSchedule,
    pub effect: ScheduledTaskEffect,
    pub status: ScheduledTaskStatus,
    pub next_fire_at: Option<u64>,
    pub last_fire_at: Option<u64>,
    pub fire_count: u64,
    pub max_fires: Option<u64>,
    pub expires_at: Option<u64>,
    pub created_by: ScheduledTaskCreatedBy,
    pub created_at: u64,
    pub updated_at: u64,
    /// Newest first, at most [`SCHEDULED_TASK_RUN_HISTORY_LIMIT`].
    pub runs: Vec<ScheduledTaskRun>,
    pub last_error: Option<String>,
}

/// `ScheduledTaskQueryInput` (`decodeScheduledTaskQueryInput`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ScheduledTaskQueryInput {
    /// A page of the catalog: the first without a cursor, a continuation
    /// with both the cursor and the first page's revision (the Host refuses
    /// one without the other). See [`Self::first_page`] and
    /// [`Self::page_after`].
    #[serde(rename_all = "camelCase")]
    List {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cursor: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_revision: Option<u64>,
    },
    /// One task by id.
    #[serde(rename_all = "camelCase")]
    Get { task_id: String },
}

impl ScheduledTaskQueryInput {
    /// The catalog's first page.
    pub fn first_page() -> Self {
        Self::List { cursor: None, expected_revision: None }
    }

    /// The page after `cursor` of the listing at `revision`.
    pub fn page_after(cursor: impl Into<String>, revision: u64) -> Self {
        Self::List { cursor: Some(cursor.into()), expected_revision: Some(revision) }
    }

    pub fn get(task_id: impl Into<String>) -> Self {
        Self::Get { task_id: task_id.into() }
    }
}

/// `ScheduledTaskQueryResult` (`decodeScheduledTaskQueryResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ScheduledTaskQueryResult {
    /// At most [`SCHEDULED_TASK_PAGE_MAX_ITEMS`] tasks, in creation order;
    /// `next_cursor` is a decimal offset.
    #[serde(rename_all = "camelCase")]
    Page { revision: u64, tasks: Vec<ScheduledTask>, next_cursor: Option<String> },
    /// The catalog moved between pages: read again from the first.
    RevisionChanged { expected: u64, actual: u64 },
    /// The task asked for, `None` when there is none.
    Task { task: Option<Box<ScheduledTask>> },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// The `create` payload (`decodeCreateInput`): `CreateScheduledTaskInput`
/// without `createdBy`, which the Host sets to the user.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ScheduledTaskDraft {
    pub title: String,
    /// The notes; may be empty for a notification.
    pub intent_body: String,
    pub schedule: ScheduledTaskSchedule,
    pub effect: ScheduledTaskEffect,
    #[serde(default, skip_serializing_if = "Nullable::is_absent")]
    pub max_fires: Nullable<u64>,
    #[serde(default, skip_serializing_if = "Nullable::is_absent")]
    pub expires_at: Nullable<u64>,
}

impl ScheduledTaskDraft {
    pub fn new(
        title: impl Into<String>,
        intent_body: impl Into<String>,
        schedule: ScheduledTaskSchedule,
        effect: ScheduledTaskEffect,
    ) -> Self {
        Self {
            title: title.into(),
            intent_body: intent_body.into(),
            schedule,
            effect,
            max_fires: Nullable::Absent,
            expires_at: Nullable::Absent,
        }
    }
}

/// The `update` patch (`decodeUpdateInput`, `UpdateScheduledTaskInput`):
/// the fields to change, at least one.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ScheduledTaskPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent_body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<ScheduledTaskSchedule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect: Option<ScheduledTaskEffect>,
    #[serde(default, skip_serializing_if = "Nullable::is_absent")]
    pub max_fires: Nullable<u64>,
    #[serde(default, skip_serializing_if = "Nullable::is_absent")]
    pub expires_at: Nullable<u64>,
}

impl ScheduledTaskPatch {
    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    pub fn intent_body(mut self, body: impl Into<String>) -> Self {
        self.intent_body = Some(body.into());
        self
    }

    pub fn schedule(mut self, schedule: ScheduledTaskSchedule) -> Self {
        self.schedule = Some(schedule);
        self
    }

    pub fn effect(mut self, effect: ScheduledTaskEffect) -> Self {
        self.effect = Some(effect);
        self
    }
}

/// `ScheduledTaskMutateInput` (`decodeScheduledTaskMutateInput`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ScheduledTaskMutateInput {
    Create {
        input: ScheduledTaskDraft,
    },
    #[serde(rename_all = "camelCase")]
    Update {
        task_id: String,
        patch: ScheduledTaskPatch,
    },
    /// Turn an active task off; a fire waiting for a delivery service is
    /// dropped.
    #[serde(rename_all = "camelCase")]
    Pause {
        task_id: String,
    },
    /// Turn a paused task on again (refused once its fires are spent).
    #[serde(rename_all = "camelCase")]
    Resume {
        task_id: String,
    },
    /// Forget the task's runs and last error.
    #[serde(rename_all = "camelCase")]
    ClearHistory {
        task_id: String,
    },
    /// Fire an active task now; its schedule is unchanged.
    #[serde(rename_all = "camelCase")]
    TriggerNow {
        task_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Delete {
        task_id: String,
    },
    /// Move the next fire `delay_ms` later (at most
    /// [`SCHEDULED_TASK_MAX_DELAY_MS`], never 0).
    #[serde(rename_all = "camelCase")]
    Snooze {
        task_id: String,
        delay_ms: u64,
    },
}

/// `ScheduledTaskMutateResult` (`decodeScheduledTaskMutateResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ScheduledTaskMutateResult {
    /// The task as it now stands.
    Task { task: Box<ScheduledTask> },
    #[serde(rename_all = "camelCase")]
    Deleted { task_id: String },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `scheduled-task.query` (mode `query`).
#[derive(Debug)]
pub enum ScheduledTaskQuery {}

impl Operation for ScheduledTaskQuery {
    const NAME: &'static str = "scheduled-task.query";
    type Input = ScheduledTaskQueryInput;
    type Output = ScheduledTaskQueryResult;
}

/// `scheduled-task.mutate` (mode `command`).
#[derive(Debug)]
pub enum ScheduledTaskMutate {}

impl Operation for ScheduledTaskMutate {
    const NAME: &'static str = "scheduled-task.mutate";
    type Input = ScheduledTaskMutateInput;
    type Output = ScheduledTaskMutateResult;
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    // The shapes below are the ones
    // packages/runtime-host/src/__tests__/scheduled-task-protocol.test.ts
    // decodes (`scheduledTask`, `agentRunEffect`, the create and update
    // frames).

    /// `scheduledTask(id)` of the TypeScript test.
    fn scheduled_task(id: &str) -> Value {
        json!({
            "id": id, "title": id, "intent": {"kind": "text", "body": ""},
            "schedule": {"kind": "once", "runAt": 1},
            "effect": {"kind": "notify", "channel": "local"},
            "status": "active", "nextFireAt": 1, "lastFireAt": null, "fireCount": 0,
            "maxFires": null, "expiresAt": null, "createdBy": {"kind": "user"},
            "createdAt": 1, "updatedAt": 1, "runs": [], "lastError": null
        })
    }

    /// `agentRunEffect('project-1')`.
    fn agent_run_effect() -> Value {
        json!({"kind": "agent_run", "execution": {
            "cwd": "/workspace", "projectId": "project-1",
            "llmConnectionId": "connection-openai", "llmConnectionSlug": "openai",
            "model": "gpt-5", "permissionMode": "ask", "collaborationMode": "agent",
            "orchestrationMode": "default"
        }})
    }

    fn round_trip<T: Serialize + serde::de::DeserializeOwned>(wire: &Value) -> T {
        let decoded: T = serde_json::from_value(wire.clone()).expect("decode");
        assert_eq!(&serde_json::to_value(&decoded).expect("encode"), wire);
        decoded
    }

    #[test]
    fn a_page_of_tasks_decodes_every_effect_and_schedule() {
        let mut agent = scheduled_task("agent-task");
        agent["effect"] = agent_run_effect();
        agent["effect"]["execution"]["toolMode"] = json!("code_mode");
        agent["createdBy"] = json!({"kind": "agent", "sessionId": "session-1"});
        agent["schedule"] = json!({"kind": "interval", "everySeconds": 600, "startAt": 5});
        let mut bot = scheduled_task("bot");
        bot["effect"] = json!({"kind": "notify", "channel": "bot", "platform": "telegram",
                               "chatId": "42"});
        bot["schedule"] = json!({"kind": "cron", "expression": "0 9 * * 1-5", "startAt": 3});
        bot["runs"] = json!([
            {"id": "r2", "at": 9, "outcome": "failed", "message": "Native delivery outcome is unknown"},
            {"id": "r1", "at": 7, "outcome": "ok", "message": "已投递到 Telegram。"}
        ]);
        bot["lastError"] = json!("Native delivery outcome is unknown");
        let mut resume = scheduled_task("resume");
        resume["effect"] = json!({"kind": "session_resume", "sessionId": "session-2"});
        resume["schedule"] = json!({"kind": "calendar", "recurrence": "weekly", "anchorAt": 2});
        resume["runs"] = json!([{"id": "r3", "at": 4, "outcome": "ok",
                                 "message": "已在原任务中继续执行。", "sessionId": "session-2",
                                 "runId": "run-1"}]);
        let page = json!({"kind": "page", "revision": 1,
                          "tasks": [scheduled_task("notification"), agent, bot, resume],
                          "nextCursor": "4"});
        let ScheduledTaskQueryResult::Page { revision, tasks, next_cursor } = round_trip(&page)
        else {
            panic!("a page");
        };
        assert_eq!((revision, next_cursor.as_deref()), (1, Some("4")));
        assert_eq!(tasks[0].effect, ScheduledTaskEffect::local());
        assert_eq!(tasks[0].schedule, ScheduledTaskSchedule::Once { run_at: 1 });
        let ScheduledTaskEffect::AgentRun { execution } = &tasks[1].effect else {
            panic!("an Agent run");
        };
        assert_eq!(execution.tool_mode, Some(ToolMode::CodeMode));
        assert_eq!(execution.project_id, Nullable::Value("project-1".into()));
        assert!(tasks[1].effect.is_agent());
        assert_eq!(tasks[1].created_by.session_id.as_deref(), Some("session-1"));
        assert_eq!(
            tasks[2].effect,
            ScheduledTaskEffect::bot(ScheduledTaskBotPlatform::Telegram, "42")
        );
        assert_eq!(tasks[2].runs[0].outcome, ScheduledTaskRunOutcome::Failed);
        assert_eq!(
            tasks[3].schedule,
            ScheduledTaskSchedule::Calendar {
                recurrence: ScheduledTaskCalendarRecurrence::Weekly,
                anchor_at: 2
            }
        );
        assert_eq!(tasks[3].runs[0].session_id.as_deref(), Some("session-2"));
    }

    #[test]
    fn a_legacy_template_keeps_its_shape_and_drops_its_backend() {
        // `toolMode` and `llmConnectionId` absent; `backend` from an older
        // build is read and never sent.
        let mut legacy = agent_run_effect();
        let execution = legacy["execution"].as_object_mut().expect("execution");
        execution.remove("llmConnectionId");
        let mut with_backend = legacy.clone();
        with_backend["execution"]["backend"] = json!("fake");
        let effect: ScheduledTaskEffect = serde_json::from_value(with_backend).expect("decode");
        assert_eq!(serde_json::to_value(&effect).expect("encode"), legacy);
        let ScheduledTaskEffect::AgentRun { execution } = round_trip(&legacy) else {
            panic!("an Agent run");
        };
        assert_eq!((execution.tool_mode, execution.llm_connection_id), (None, None));
        // `projectId: null` stays null.
        let mut host_path = agent_run_effect();
        host_path["execution"]["projectId"] = Value::Null;
        let ScheduledTaskEffect::AgentRun { execution } = round_trip(&host_path) else {
            panic!("an Agent run");
        };
        assert_eq!(execution.project_id, Nullable::Null);
    }

    #[test]
    fn kinds_this_client_does_not_know_are_kept_apart() {
        let mut task = scheduled_task("t");
        task["schedule"] = json!({"kind": "lunar", "phase": "full"});
        task["effect"] = json!({"kind": "webhook", "url": "https://example.com"});
        let task: ScheduledTask = serde_json::from_value(task).expect("decode");
        assert_eq!(task.schedule, ScheduledTaskSchedule::Unknown);
        assert_eq!(task.effect, ScheduledTaskEffect::Unknown);
        let bot: ScheduledTaskEffect = serde_json::from_value(
            json!({"kind": "notify", "channel": "bot", "platform": "feishu", "chatId": "1"}),
        )
        .expect("decode");
        assert_eq!(
            bot,
            ScheduledTaskEffect::bot(ScheduledTaskBotPlatform::Other("feishu".into()), "1")
        );
        let status: ScheduledTaskStatus =
            serde_json::from_value(json!("archived")).expect("decode");
        assert_eq!(status, ScheduledTaskStatus::Other("archived".into()));
        assert_eq!(
            serde_json::from_value::<ScheduledTaskQueryResult>(json!({"kind": "gone"}))
                .expect("decode"),
            ScheduledTaskQueryResult::Unknown
        );
        // A task without a nullable field it must carry is not one.
        let mut missing = scheduled_task("t");
        missing.as_object_mut().expect("object").remove("fireCount");
        assert!(serde_json::from_value::<ScheduledTask>(missing).is_err());
    }

    #[test]
    fn queries_encode_the_first_page_a_continuation_and_a_get() {
        assert_eq!(
            serde_json::to_value(ScheduledTaskQueryInput::first_page()).expect("encode"),
            json!({"kind": "list"})
        );
        assert_eq!(
            serde_json::to_value(ScheduledTaskQueryInput::page_after("64", 3)).expect("encode"),
            json!({"kind": "list", "cursor": "64", "expectedRevision": 3})
        );
        assert_eq!(
            serde_json::to_value(ScheduledTaskQueryInput::get("task-1")).expect("encode"),
            json!({"kind": "get", "taskId": "task-1"})
        );
        let changed = json!({"kind": "revision_changed", "expected": 3, "actual": 4});
        assert_eq!(
            round_trip::<ScheduledTaskQueryResult>(&changed),
            ScheduledTaskQueryResult::RevisionChanged { expected: 3, actual: 4 }
        );
        let found = json!({"kind": "task", "task": scheduled_task("task-1")});
        let ScheduledTaskQueryResult::Task { task: Some(task) } = round_trip(&found) else {
            panic!("a task");
        };
        assert_eq!(task.id, "task-1");
        let none = json!({"kind": "task", "task": null});
        assert_eq!(
            round_trip::<ScheduledTaskQueryResult>(&none),
            ScheduledTaskQueryResult::Task { task: None }
        );
    }

    #[test]
    fn every_mutation_encodes_as_the_host_decodes_it() {
        let draft = ScheduledTaskDraft::new(
            "Inspect workspace",
            "Summarize the workspace.",
            ScheduledTaskSchedule::Once { run_at: 1 },
            ScheduledTaskEffect::local(),
        );
        let task_id = || "task-1".to_owned();
        let cases = [
            (
                ScheduledTaskMutateInput::Create { input: draft },
                json!({"kind": "create", "input": {"title": "Inspect workspace",
                       "intentBody": "Summarize the workspace.",
                       "schedule": {"kind": "once", "runAt": 1},
                       "effect": {"kind": "notify", "channel": "local"}}}),
            ),
            (
                ScheduledTaskMutateInput::Update {
                    task_id: task_id(),
                    patch: ScheduledTaskPatch::default()
                        .title("Weekly review")
                        .schedule(ScheduledTaskSchedule::Cron {
                            expression: "0 20 * * 0".into(),
                            start_at: 5,
                        })
                        .effect(ScheduledTaskEffect::bot(ScheduledTaskBotPlatform::Slack, "C1")),
                },
                json!({"kind": "update", "taskId": "task-1", "patch": {
                       "title": "Weekly review",
                       "schedule": {"kind": "cron", "expression": "0 20 * * 0", "startAt": 5},
                       "effect": {"kind": "notify", "channel": "bot", "platform": "slack",
                                  "chatId": "C1"}}}),
            ),
            (
                ScheduledTaskMutateInput::Pause { task_id: task_id() },
                json!({"kind": "pause", "taskId": "task-1"}),
            ),
            (
                ScheduledTaskMutateInput::Resume { task_id: task_id() },
                json!({"kind": "resume", "taskId": "task-1"}),
            ),
            (
                ScheduledTaskMutateInput::ClearHistory { task_id: task_id() },
                json!({"kind": "clear_history", "taskId": "task-1"}),
            ),
            (
                ScheduledTaskMutateInput::TriggerNow { task_id: task_id() },
                json!({"kind": "trigger_now", "taskId": "task-1"}),
            ),
            (
                ScheduledTaskMutateInput::Delete { task_id: task_id() },
                json!({"kind": "delete", "taskId": "task-1"}),
            ),
            (
                ScheduledTaskMutateInput::Snooze { task_id: task_id(), delay_ms: 600_000 },
                json!({"kind": "snooze", "taskId": "task-1", "delayMs": 600_000}),
            ),
        ];
        for (input, wire) in cases {
            assert_eq!(serde_json::to_value(&input).expect("encode"), wire);
            round_trip::<ScheduledTaskMutateInput>(&wire);
        }
        // The TypeScript test's Agent create and update frames.
        round_trip::<ScheduledTaskMutateInput>(&json!({"kind": "create", "input": {
            "title": "Inspect workspace", "intentBody": "Summarize the workspace.",
            "schedule": {"kind": "once", "runAt": 1}, "effect": agent_run_effect()}}));
        round_trip::<ScheduledTaskMutateInput>(
            &json!({"kind": "update", "taskId": "task-1", "patch": {"effect": agent_run_effect()}}),
        );
    }

    #[test]
    fn mutation_results_decode() {
        let committed = json!({"kind": "task", "task": scheduled_task("task-1")});
        let ScheduledTaskMutateResult::Task { task } = round_trip(&committed) else {
            panic!("a task");
        };
        assert_eq!(task.status, ScheduledTaskStatus::Active);
        let deleted = json!({"kind": "deleted", "taskId": "task-1"});
        assert_eq!(
            round_trip::<ScheduledTaskMutateResult>(&deleted),
            ScheduledTaskMutateResult::Deleted { task_id: "task-1".into() }
        );
    }
}
