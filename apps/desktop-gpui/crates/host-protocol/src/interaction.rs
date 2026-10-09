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

//! Interactions: prompts a running Turn raises for the user, and their answers.
//!
//! Sources: `packages/runtime-host/src/protocol/interaction.ts`
//! (`decodeInteractionSnapshot`, `decodeSessionInteractionProjection`,
//! `INTERACTION_OPERATION_SPECS`) and `packages/core/src/interaction.ts`
//! (`decodeInteractionRequest`, `decodeInteractionAnswer`,
//! `decodeInteractionCanonicalOutcome`), with the permission prompt from
//! `decodeInteractionPermissionPrompt` in
//! `packages/core/src/interaction-permission-review.ts`.
//!
//! The MVP renders permission, question, and sandbox-boundary prompts, so
//! those are modeled in full; the sandbox-boundary expansion follows
//! `SandboxBoundaryExpansion` in `packages/core/src/sandbox-boundary.ts`.
//! Form and client-capability requests keep their payload as JSON.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Operation;

wire_enum! {
    /// `InteractionSnapshot.status`.
    pub enum InteractionStatus {
        Pending = "pending",
        Answered = "answered",
        Closed = "closed",
    }
}

wire_enum! {
    /// `decision` of a permission answer or outcome.
    pub enum PermissionDecision {
        Allow = "allow",
        Deny = "deny",
    }
}

wire_enum! {
    /// `INTERACTION_CLOSURE_REASONS` (`packages/core/src/interaction.ts`).
    pub enum InteractionClosureReason {
        TurnStopped = "turn_stopped",
        TurnTerminal = "turn_terminal",
        ProducerCancelled = "producer_cancelled",
        TimedOut = "timed_out",
        HostRestarted = "host_restarted",
        ProviderDisconnected = "provider_disconnected",
    }
}

/// `InteractionSnapshot` (`decodeInteractionSnapshot`). `revision` is 1 while
/// pending and 2 once resolved; `outcome` is `null` exactly while pending.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct InteractionSnapshot {
    /// `INTERACTION_SCHEMA_VERSION`, currently 1.
    pub schema_version: u32,
    pub interaction_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub run_id: String,
    pub revision: u32,
    pub request: InteractionRequest,
    pub status: InteractionStatus,
    /// Always sent; `null` while pending.
    pub outcome: Option<InteractionOutcome>,
}

impl InteractionSnapshot {
    /// The Tool invocation the prompt is about. A sandbox-boundary request
    /// has none; the TS projector then uses the interaction id
    /// (`projectRuntimeHostInteractionRequest` in
    /// `packages/runtime-host/src/adapter/session-projector.ts`).
    pub fn tool_use_id(&self) -> Option<&str> {
        self.request.tool_use_id()
    }
}

/// `SessionInteractionProjection`: at most 16 pending interactions of one
/// Session (`INTERACTION_MAX_PENDING_PER_SESSION`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionInteractionProjection {
    pub pending: Vec<InteractionSnapshot>,
}

wire_union! {
    /// `InteractionRequest` (`decodeInteractionRequest`).
    pub enum InteractionRequest in "kind" {
        /// A Tool call needs approval. Boxed: it is much larger than the rest.
        Permission(Box<PermissionRequest>) = "permission",
        /// The model asks the user to choose among options.
        Question(QuestionRequest) = "question",
        /// `InteractionFormRequest`, kept as JSON.
        Form(Value) = "form",
        /// The Turn asks to widen the Session's sandbox. Has no `toolUseId`.
        SandboxBoundary(SandboxBoundaryRequest) = "sandbox_boundary",
        /// `InteractionClientCapabilityRequest`, kept as JSON.
        ClientCapability(Value) = "client_capability",
    }
}

impl InteractionRequest {
    /// The `toolUseId` the request names, if any.
    pub fn tool_use_id(&self) -> Option<&str> {
        match self {
            Self::Permission(request) => Some(&request.tool_use_id),
            Self::Question(request) => Some(&request.tool_use_id),
            Self::Form(value) | Self::ClientCapability(value) | Self::Unknown(value) => {
                value.get("toolUseId").and_then(Value::as_str)
            }
            Self::SandboxBoundary(_) => None,
        }
    }
}

wire_enum! {
    /// `SandboxBoundaryAccess` (`SANDBOX_BOUNDARY_ACCESS_MODES` in
    /// `packages/core/src/sandbox-boundary.ts`). `write` includes reading.
    pub enum SandboxBoundaryAccess {
        Read = "read",
        Write = "write",
    }
}

wire_enum! {
    /// `SandboxBoundaryScope` (`SANDBOX_BOUNDARY_SCOPES`): the path alone, or
    /// the path and everything below it.
    pub enum SandboxBoundaryScope {
        Exact = "exact",
        Subtree = "subtree",
    }
}

wire_enum! {
    /// The `status` of a sandbox-boundary outcome:
    /// `SANDBOX_BOUNDARY_REQUEST_STATUSES` without `pending`, which
    /// `decodeInteractionCanonicalOutcome` rejects in an outcome. The decoder
    /// also requires `denied` exactly when the decision is `deny`.
    pub enum SandboxBoundaryStatus {
        /// Allowed and applied to the Session's sandbox.
        Approved = "approved",
        Denied = "denied",
        /// Allowed, but not applied: the Session's sandbox stopped being a
        /// managed profile, or the expansion hits one of its explicit deny
        /// rules (`settleSandboxBoundaryRequest` in
        /// `packages/storage/src/sqlite-session-metadata-store.ts`).
        Conflict = "conflict",
    }
}

/// `InteractionSandboxBoundaryRequest` (`decodeInteractionRequest`): the Turn
/// asks to widen the Session's sandbox, through the `request_sandbox_boundary`
/// Tool (`packages/runtime/src/sandbox-boundary-tool.ts`). It names no Tool
/// call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SandboxBoundaryRequest {
    pub expansion: SandboxBoundaryExpansion,
    /// The model's reason, at most 2,000 characters
    /// (`INTERACTION_SANDBOX_BOUNDARY_JUSTIFICATION_MAX_CHARS`).
    pub justification: String,
}

/// `SandboxBoundaryExpansion` (`validateSandboxBoundaryExpansion` in
/// `packages/core/src/sandbox-boundary.ts`): what the sandbox would allow in
/// addition. The Host sends at least one of the two parts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SandboxBoundaryExpansion {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filesystem: Option<SandboxBoundaryFilesystem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<SandboxBoundaryNetwork>,
}

/// `SandboxBoundaryExpansion['filesystem']`: at most 32 entries
/// (`MAX_SANDBOX_BOUNDARY_FILESYSTEM_ENTRIES`), compacted and sorted by the
/// Host (`compactSandboxBoundaryFilesystemEntries`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SandboxBoundaryFilesystem {
    pub entries: Vec<SandboxBoundaryFilesystemEntry>,
}

/// `SandboxBoundaryFilesystemEntry`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SandboxBoundaryFilesystemEntry {
    /// A normalized absolute path without a trailing slash.
    pub path: String,
    pub access: SandboxBoundaryAccess,
    pub scope: SandboxBoundaryScope,
}

/// `SandboxBoundaryExpansion['network']`. The decoder accepts only
/// `enabled: true`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SandboxBoundaryNetwork {
    pub enabled: bool,
}

/// `InteractionPermissionRequest`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct PermissionRequest {
    pub tool_use_id: String,
    pub prompt: PermissionPrompt,
}

wire_union! {
    /// `InteractionPermissionPrompt` (`decodeInteractionPermissionPrompt`).
    pub enum PermissionPrompt in "kind" {
        /// An ordinary Tool call that the permission mode asks about.
        ToolPermission(ToolPermissionPrompt) = "tool_permission",
        /// `InteractionAdditionalPermissionsPrompt`, kept as JSON.
        AdditionalPermissions(Value) = "additional_permissions",
        /// A Bash command that wants to leave the sandbox.
        SandboxEscalation(SandboxEscalationPrompt) = "sandbox_escalation",
    }
}

impl PermissionPrompt {
    /// The Tool the prompt is about, when the prompt kind is known.
    pub fn tool_name(&self) -> Option<&str> {
        match self {
            Self::ToolPermission(prompt) => Some(&prompt.tool_name),
            Self::SandboxEscalation(prompt) => Some(&prompt.tool_name),
            Self::AdditionalPermissions(value) | Self::Unknown(value) => {
                value.get("toolName").and_then(Value::as_str)
            }
        }
    }
}

/// `InteractionToolPermissionPrompt`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ToolPermissionPrompt {
    pub tool_name: String,
    /// `ToolCategory`, for example `shell_unsafe` or `file_write`.
    pub category: String,
    /// `PermissionRequest['reason']`, for example `shell_dangerous`.
    pub reason: String,
    pub review: PermissionReview,
    /// Whether "allow for the rest of this Turn" may be offered.
    pub remember_for_turn_allowed: bool,
}

/// `InteractionSandboxEscalationPrompt`. Only `allow_once` and `deny` are
/// available, so `rememberForTurn` must be `false` in the answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SandboxEscalationPrompt {
    /// Always `Bash`.
    pub tool_name: String,
    pub category: String,
    /// Always `sandbox_escalation`.
    pub reason: String,
    /// A `command` review with `cwd`.
    pub review: PermissionReview,
    /// `proactive` or `sandbox_denial`.
    pub trigger: String,
    /// `SandboxEscalationRiskSummary`.
    pub risk: Value,
    pub also_approves_tool_execution: bool,
    /// Always `["allow_once", "deny"]`.
    pub available_decisions: Vec<String>,
}

wire_union! {
    /// `InteractionPermissionReview`: what the prompt shows about the call.
    /// Texts are already sanitized for display by the Host.
    pub enum PermissionReview in "kind" {
        Command(CommandReview) = "command",
        Path(PathReview) = "path",
        Search(SearchReview) = "search",
        Web(WebReview) = "web",
        /// Arguments of a Tool without a dedicated review, as bounded JSON text.
        Tool(GenericToolReview) = "tool",
        /// `InteractionStdinReview`, kept as JSON.
        Stdin(Value) = "stdin",
        /// `InteractionBrowserReview`, kept as JSON.
        Browser(Value) = "browser",
        /// `InteractionComputerUseReview`, kept as JSON.
        ComputerUse(Value) = "computer_use",
        /// `InteractionPermissionAdditionalPermissionsReview`, kept as JSON.
        AdditionalPermissions(Value) = "additional_permissions",
    }
}

/// `InteractionCommandReview`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct CommandReview {
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// `InteractionPathReview`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct PathReview {
    /// `read`, `write`, or `edit`.
    pub operation: String,
    pub path: String,
}

/// `InteractionSearchReview`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SearchReview {
    /// `glob` or `grep`.
    pub operation: String,
    pub pattern: String,
    pub root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glob: Option<String>,
}

/// `InteractionWebReview`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct WebReview {
    /// `url` or `query`.
    pub target_kind: String,
    pub target: String,
}

/// `InteractionGenericToolReview`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct GenericToolReview {
    pub arguments: ReviewTextPreview,
}

/// A bounded text preview: `{ text, bytes, truncated }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ReviewTextPreview {
    pub text: String,
    /// Size of the full text before truncation.
    pub bytes: u64,
    pub truncated: bool,
}

/// `InteractionQuestionRequest`: one to three questions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct QuestionRequest {
    pub tool_use_id: String,
    pub questions: Vec<InteractionQuestion>,
}

/// `InteractionQuestion`: two or three options.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct InteractionQuestion {
    pub question: String,
    pub options: Vec<InteractionQuestionOption>,
}

/// `InteractionQuestionOption`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct InteractionQuestionOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

wire_union! {
    /// `InteractionCanonicalOutcome` (`decodeInteractionCanonicalOutcome`).
    pub enum InteractionOutcome in "kind" {
        PermissionAnswer(PermissionOutcome) = "permission_answer",
        QuestionAnswer(QuestionOutcome) = "question_answer",
        /// `InteractionCanonicalFormOutcome`, kept as JSON.
        FormAnswer(Value) = "form_answer",
        SandboxBoundaryDecision(SandboxBoundaryOutcome) = "sandbox_boundary_decision",
        /// `InteractionCanonicalClientCapabilityOutcome`, kept as JSON.
        ClientCapabilityDecision(Value) = "client_capability_decision",
        /// The interaction ended without an answer.
        Closure(ClosureOutcome) = "closure",
    }
}

/// `InteractionCanonicalPermissionOutcome`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct PermissionOutcome {
    /// `APPROVALS_REVIEWERS`: `user` or `auto_review`.
    pub reviewer: String,
    /// Only from `auto_review`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    /// `APPROVAL_RISK_LEVELS`: `low`, `medium`, `high`, `critical`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk_level: Option<String>,
    pub committed_at: u64,
    pub decision: PermissionDecision,
    /// Always `false` for `deny`.
    pub remember_for_turn: bool,
}

/// `InteractionCanonicalQuestionOutcome`: one answer per question, `null`
/// for a skipped question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct QuestionOutcome {
    pub answers: Vec<Option<String>>,
    pub committed_at: u64,
}

/// `InteractionCanonicalSandboxBoundaryOutcome`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SandboxBoundaryOutcome {
    pub decision: PermissionDecision,
    pub status: SandboxBoundaryStatus,
    pub committed_at: u64,
}

/// `InteractionCanonicalClosureOutcome`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ClosureOutcome {
    pub reason: InteractionClosureReason,
    pub committed_at: u64,
}

/// `InteractionAnswer` (`decodeInteractionAnswer`): what the client sends.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum InteractionAnswer {
    /// `rememberForTurn` must be `false` when denying and is honored only
    /// when the prompt allows it.
    #[serde(rename_all = "camelCase")]
    Permission {
        decision: PermissionDecision,
        remember_for_turn: bool,
    },
    /// One entry per question, `None` to skip it.
    Question {
        answers: Vec<Option<String>>,
    },
    /// `accept` with `values`, or `decline`/`cancel` without.
    Form {
        action: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        values: Option<Value>,
    },
    SandboxBoundary {
        decision: PermissionDecision,
    },
    ClientCapability {
        decision: PermissionDecision,
    },
}

impl InteractionAnswer {
    /// Allow a permission prompt once.
    pub fn allow_once() -> Self {
        Self::Permission { decision: PermissionDecision::Allow, remember_for_turn: false }
    }

    /// Deny a permission prompt.
    pub fn deny() -> Self {
        Self::Permission { decision: PermissionDecision::Deny, remember_for_turn: false }
    }
}

/// `InteractionQueryInput`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct InteractionQueryInput {
    pub session_id: String,
    pub interaction_id: String,
}

impl InteractionQueryInput {
    /// Queries `interaction_id` in `session_id`.
    pub fn new(session_id: impl Into<String>, interaction_id: impl Into<String>) -> Self {
        Self { session_id: session_id.into(), interaction_id: interaction_id.into() }
    }
}

/// `InteractionAnswerInput`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct InteractionAnswerInput {
    pub session_id: String,
    pub interaction_id: String,
    pub answer: InteractionAnswer,
}

impl InteractionAnswerInput {
    /// Answers `interaction_id` in `session_id`.
    pub fn new(
        session_id: impl Into<String>,
        interaction_id: impl Into<String>,
        answer: InteractionAnswer,
    ) -> Self {
        Self { session_id: session_id.into(), interaction_id: interaction_id.into(), answer }
    }
}

/// `interaction.query` (mode `query`).
#[derive(Debug)]
pub enum InteractionQuery {}

impl Operation for InteractionQuery {
    const NAME: &'static str = "interaction.query";
    type Input = InteractionQueryInput;
    type Output = InteractionSnapshot;
}

/// `interaction.answer` (mode `command`). Answers with the `answered`
/// snapshot (`decodeInteractionAnsweredSnapshot`); `already_resolved` when
/// another client answered first. Named for its mode because
/// [`InteractionAnswer`] is the answer payload.
#[derive(Debug)]
pub enum InteractionAnswerCommand {}

impl Operation for InteractionAnswerCommand {
    const NAME: &'static str = "interaction.answer";
    type Input = InteractionAnswerInput;
    type Output = InteractionSnapshot;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pending_permission() -> Value {
        json!({
            "schemaVersion": 1,
            "interactionId": "i1",
            "sessionId": "s1",
            "turnId": "t1",
            "runId": "r1",
            "revision": 1,
            "request": {
                "kind": "permission",
                "toolUseId": "call_1",
                "prompt": {
                    "kind": "tool_permission",
                    "toolName": "Bash",
                    "category": "shell_unsafe",
                    "reason": "shell_dangerous",
                    "review": {"kind": "command", "command": "ls", "cwd": "/w"},
                    "rememberForTurnAllowed": true
                }
            },
            "status": "pending",
            "outcome": null
        })
    }

    #[test]
    fn pending_permission_round_trips() {
        let value = pending_permission();
        let snapshot: InteractionSnapshot = serde_json::from_value(value.clone()).expect("decode");
        assert_eq!(snapshot.tool_use_id(), Some("call_1"));
        let InteractionRequest::Permission(request) = &snapshot.request else {
            panic!("expected permission");
        };
        assert_eq!(request.prompt.tool_name(), Some("Bash"));
        let PermissionPrompt::ToolPermission(prompt) = &request.prompt else {
            panic!("expected tool permission");
        };
        assert!(
            matches!(&prompt.review, PermissionReview::Command(review) if review.command == "ls")
        );
        assert_eq!(serde_json::to_value(&snapshot).expect("encode"), value);
    }

    #[test]
    fn answered_snapshot_carries_the_outcome() {
        let mut value = pending_permission();
        value["revision"] = json!(2);
        value["status"] = json!("answered");
        value["outcome"] = json!({
            "kind": "permission_answer", "reviewer": "user", "committedAt": 5,
            "decision": "allow", "rememberForTurn": false
        });
        let snapshot: InteractionSnapshot = serde_json::from_value(value.clone()).expect("decode");
        assert!(matches!(
            snapshot.outcome,
            Some(InteractionOutcome::PermissionAnswer(PermissionOutcome {
                decision: PermissionDecision::Allow,
                ..
            }))
        ));
        assert_eq!(serde_json::to_value(&snapshot).expect("encode"), value);
    }

    #[test]
    fn question_request_and_closure_decode() {
        let request: InteractionRequest = serde_json::from_value(json!({
            "kind": "question", "toolUseId": "q",
            "questions": [{"question": "Which?", "options": [{"label": "A"}, {"label": "B", "description": "b"}]}]
        }))
        .expect("decode");
        assert!(
            matches!(&request, InteractionRequest::Question(q) if q.questions[0].options.len() == 2)
        );
        let outcome: InteractionOutcome = serde_json::from_value(
            json!({"kind": "closure", "reason": "turn_stopped", "committedAt": 1}),
        )
        .expect("decode");
        assert!(matches!(
            outcome,
            InteractionOutcome::Closure(ClosureOutcome {
                reason: InteractionClosureReason::TurnStopped,
                ..
            })
        ));
    }

    #[test]
    fn sandbox_boundary_requests_and_outcomes_are_typed() {
        let value = json!({
            "kind": "sandbox_boundary",
            "expansion": {
                "filesystem": {"entries": [
                    {"path": "/etc/hosts", "access": "read", "scope": "exact"},
                    {"path": "/tmp/out", "access": "write", "scope": "subtree"}
                ]},
                "network": {"enabled": true}
            },
            "justification": "j"
        });
        let request: InteractionRequest = serde_json::from_value(value.clone()).expect("decode");
        assert_eq!(request.tool_use_id(), None);
        let InteractionRequest::SandboxBoundary(request_body) = &request else {
            panic!("expected a sandbox boundary request");
        };
        let entries = &request_body.expansion.filesystem.as_ref().expect("filesystem").entries;
        assert_eq!(entries[0].access, SandboxBoundaryAccess::Read);
        assert_eq!(entries[1].scope, SandboxBoundaryScope::Subtree);
        assert_eq!(request_body.expansion.network, Some(SandboxBoundaryNetwork { enabled: true }));
        assert_eq!(serde_json::to_value(&request).expect("encode"), value);

        let value = json!({"kind": "sandbox_boundary_decision", "decision": "allow",
                           "status": "conflict", "committedAt": 3});
        let outcome: InteractionOutcome = serde_json::from_value(value.clone()).expect("decode");
        assert_eq!(
            outcome,
            InteractionOutcome::SandboxBoundaryDecision(SandboxBoundaryOutcome {
                decision: PermissionDecision::Allow,
                status: SandboxBoundaryStatus::Conflict,
                committed_at: 3,
            })
        );
        assert_eq!(serde_json::to_value(&outcome).expect("encode"), value);
    }

    #[test]
    fn unknown_sandbox_boundary_literals_are_kept() {
        let value = json!({
            "kind": "sandbox_boundary",
            "expansion": {"filesystem": {"entries": [
                {"path": "/dev/x", "access": "execute", "scope": "glob"}
            ]}},
            "justification": ""
        });
        let request: InteractionRequest = serde_json::from_value(value.clone()).expect("decode");
        let InteractionRequest::SandboxBoundary(request_body) = &request else {
            panic!("expected a sandbox boundary request");
        };
        let entry = &request_body.expansion.filesystem.as_ref().expect("filesystem").entries[0];
        assert_eq!(entry.access, SandboxBoundaryAccess::Other("execute".into()));
        assert_eq!(entry.scope, SandboxBoundaryScope::Other("glob".into()));
        assert_eq!(serde_json::to_value(&request).expect("encode"), value);

        let status: SandboxBoundaryStatus =
            serde_json::from_value(json!("pending")).expect("decode");
        assert_eq!(status, SandboxBoundaryStatus::Other("pending".into()));
    }

    #[test]
    fn opaque_request_kinds_keep_their_payload() {
        let value = json!({"kind": "form", "toolUseId": "f1", "message": "m",
                           "requester": {"x": 1}, "fields": []});
        let request: InteractionRequest = serde_json::from_value(value.clone()).expect("decode");
        assert_eq!(request.tool_use_id(), Some("f1"));
        assert_eq!(serde_json::to_value(&request).expect("encode"), value);
    }

    #[test]
    fn answers_encode_like_the_ts_client() {
        let input = InteractionAnswerInput::new("s1", "i1", InteractionAnswer::allow_once());
        assert_eq!(
            serde_json::to_value(input).expect("encode"),
            json!({"sessionId": "s1", "interactionId": "i1",
                   "answer": {"kind": "permission", "decision": "allow", "rememberForTurn": false}})
        );
        assert_eq!(
            serde_json::to_value(InteractionAnswer::Question {
                answers: vec![Some("A".into()), None]
            })
            .expect("encode"),
            json!({"kind": "question", "answers": ["A", null]})
        );
    }
}
