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

//! Golden fixtures captured from a real Runtime Host.
//!
//! Regenerate with `cargo run -p host-client --example capture_fixtures`
//! (see `docs/dev-host.md`). Under `cfg(test)` every response-side type
//! denies unknown fields, and each test re-encodes the decoded value and
//! compares it with the fixture, so a field the Host added, renamed, or
//! dropped fails here before it silently changes client behavior.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::{
    ArtifactBinaryPreview, ArtifactDeleteInput, ArtifactDeleteResult, ArtifactKind,
    ArtifactQueryInput, ArtifactQueryResult, ArtifactReadFailureReason, ArtifactSource,
    ArtifactTextPreview, HostOperationError, HostOperationErrorCode, PtyControl, PtyInterestInput,
    PtySize, RecallFailureReason, RecallMatchKind, RecallQueryError, RecallQueryInput,
    RecallQueryResult, RecallRole, RuntimeResourceAcquireResult, RuntimeResourceControlInput,
    RuntimeResourceControlResult, RuntimeResourceControllerInput, RuntimeResourceFailure,
    RuntimeResourceOwnership, RuntimeResourceQueryInput, RuntimeResourceQueryResult,
    RuntimeResourceReleaseResult, RuntimeResourceStartInput, RuntimeResourceStartResult,
    RuntimeResourceStopInput, RuntimeResourceStopResult, SessionDomain, ShellMode, ShellRunStatus,
};
use crate::{
    ArtifactIngestInput, ArtifactIngestResult, AssistantStreamKind, AttachmentKind,
    MessagePlacement, MessageQueueEntryState, QueueEntriesReorderInput, QueueEntryPromoteInput,
    QueueEntryRetractInput, QueueEntryUpdateInput, QueueMutationResult, SessionFrameEvent,
    StorageRef, TranscriptDirection, TurnMessageSubmitInput, TurnMessageSubmitResult,
};
use crate::{
    ChangeNotice, ClientHello, ConnectionCatalogItem, ConnectionCatalogQueryResult,
    ConnectionOnboardingRejection, ConnectionOnboardingSaveResult,
    ConnectionOnboardingVerifyResult, HandshakeResult, HostFrame, HostLifecycleMode,
    HostLifecycleState, HostRegistration, HostStatusResult, InteractionAnswer,
    InteractionAnswerInput, InteractionOutcome, InteractionRequest, InteractionSnapshot,
    InteractionStatus, Outcome, PermissionDecision, ProjectCatalogMutateResult,
    ProjectCatalogPageItem, ProjectCatalogQueryInput, ProjectCatalogQueryResult,
    ProjectCatalogView, PushFrame, RUNTIME_HOST_COMPATIBILITY_EPOCH, RemoveCatalogConnectionResult,
    ReplacementDisposition, RequestFrame, RuntimePolicyMutateResult, RuntimePolicySnapshot,
    SandboxBoundaryAccess, SandboxBoundaryOutcome, SandboxBoundaryScope, SandboxBoundaryStatus,
    SessionCatalogItem, SessionCatalogQueryResult, SessionCreateInput, SessionFrame,
    SessionRemoveInput, SessionRemovePreviewResult, SessionRemoveResult, SessionTranscriptPage,
    SessionTranscriptPageInput, SessionUpdateResult, SetDefaultConnectionTargetResult,
    StoredMessage, SubscriptionIdInput, SubscriptionIdResult, SubscriptionOpenInput,
    SubscriptionOpenResult, TurnRunStatus, TurnSnapshot, TurnStartInput, TurnStartResult,
    TurnStatus, TurnStopInput, UpdateCatalogConnectionResult, WorkspaceTarget,
};
use crate::{
    ContextDiagnosticsQueryInput, ContextDiagnosticsResult, ContextSegmentKind,
    ContextUnavailableReason, CostBasis, ExecutionInspectQueryInput, ExecutionInspectQueryResult,
    ModelCallCoverage, ModelCallKind, ModelCallStatus, SESSION_TRACE_SCHEMA_VERSION, TraceStep,
    UsageQueryInput, UsageQueryResult,
};
use crate::{
    ConversationCopyIntent, SessionCatalogQueryInput, SessionConversationCopyInput,
    SessionConversationCopyResult, SessionTurnContribution, SessionTurnsQueryInput,
    SessionTurnsQueryResult,
};

fn fixture(text: &str) -> Value {
    serde_json::from_str(text).expect("fixture is JSON")
}

/// Decodes `value` as `T` and checks that encoding it reproduces `value`.
fn round_trip<T: DeserializeOwned + Serialize>(value: &Value) -> T {
    let decoded: T = serde_json::from_value(value.clone()).expect("fixture decodes");
    let encoded = serde_json::to_value(&decoded).expect("value encodes");
    assert_eq!(&encoded, value, "re-encoding must reproduce the fixture");
    decoded
}

/// [`round_trip`] comparing numbers as numbers: the trace and the usage
/// summary hold amounts the core reads as any non-negative number (`f64`
/// here), which a JavaScript Host writes as `120` and this client as
/// `120.0`.
fn round_trip_amounts<T: DeserializeOwned + Serialize>(value: &Value) -> T {
    fn amounts(value: &Value) -> Value {
        match value {
            Value::Number(number) => number.as_f64().map_or(Value::Null, Value::from),
            Value::Array(items) => Value::Array(items.iter().map(amounts).collect()),
            Value::Object(fields) => Value::Object(
                fields.iter().map(|(key, child)| (key.clone(), amounts(child))).collect(),
            ),
            other => other.clone(),
        }
    }
    let decoded: T = serde_json::from_value(value.clone()).expect("fixture decodes");
    let encoded = serde_json::to_value(&decoded).expect("value encodes");
    assert_eq!(amounts(&encoded), amounts(value), "re-encoding must reproduce the fixture");
    decoded
}

/// Classifies a response fixture and returns its successful result.
fn response_result(text: &str, operation: &str) -> Value {
    let frame = HostFrame::decode(fixture(text)).expect("fixture classifies");
    let HostFrame::Response(response) = frame else {
        panic!("expected a response frame");
    };
    assert_eq!(response.operation, operation);
    let Outcome::Ok(result) = response.outcome else {
        panic!("expected a successful response");
    };
    result
}

#[test]
fn registration() {
    let value = fixture(include_str!("../fixtures/registration.json"));
    let bytes = serde_json::to_vec(&value).expect("encode");
    let registration = HostRegistration::decode(&bytes).expect("valid registration");
    assert_eq!(registration.lifecycle_mode, Some(HostLifecycleMode::Service));
    assert_eq!(registration.compatibility_epoch, RUNTIME_HOST_COMPATIBILITY_EPOCH);
    assert_eq!(registration.state, HostLifecycleState::Ready);
    round_trip::<HostRegistration>(&value);
}

#[test]
fn hello() {
    let value = fixture(include_str!("../fixtures/hello.json"));
    let hello = round_trip::<ClientHello>(&value);
    // The fixture is what `ClientHello::new` produced for the real Host.
    let fresh = ClientHello::new(hello.client_instance_id.clone());
    assert_eq!(fresh, hello);
}

#[test]
fn accepted() {
    let value = fixture(include_str!("../fixtures/accepted.json"));
    let frame = HostFrame::decode(value.clone()).expect("fixture classifies");
    let HostFrame::Handshake(HandshakeResult::Accepted(accepted)) = frame else {
        panic!("expected accepted");
    };
    assert_eq!(accepted.compatibility_epoch, RUNTIME_HOST_COMPATIBILITY_EPOCH);
    assert_eq!(accepted.cooperative_handoff, Some(true));
    round_trip::<HandshakeResult>(&value);
}

#[test]
fn incompatible() {
    let value = fixture(include_str!("../fixtures/incompatible.json"));
    let HandshakeResult::Incompatible(incompatible) = round_trip::<HandshakeResult>(&value) else {
        panic!("expected incompatible");
    };
    assert_eq!(incompatible.replacement, ReplacementDisposition::BlockedByResidency);
    let activity = incompatible.activity.expect("local owners receive activity");
    assert_eq!(activity.drain_residencies, Some(0));
}

#[test]
fn host_status_response() {
    let result =
        response_result(include_str!("../fixtures/host_status.response.json"), "host.status");
    let status = round_trip::<HostStatusResult>(&result);
    assert_eq!(status.state, HostLifecycleState::Ready);
    assert!(status.peer_endpoint.is_none());
}

#[test]
fn session_catalog_page_response() {
    let result = response_result(
        include_str!("../fixtures/session_catalog_query.page.response.json"),
        "session.catalog.query",
    );
    let SessionCatalogQueryResult::Page { sessions, next_cursor, .. } =
        round_trip::<SessionCatalogQueryResult>(&result)
    else {
        panic!("expected a page");
    };
    assert_eq!(next_cursor, None);
    assert!(!sessions.is_empty());
    for item in &sessions {
        let SessionCatalogItem::Session(session) = item else {
            panic!("expected a projection");
        };
        // Tasks created in a registered project name it; others, a path.
        assert!(matches!(
            session.workspace.target,
            WorkspaceTarget::HostPath { .. } | WorkspaceTarget::Project { .. }
        ));
    }
}

#[test]
fn session_catalog_get_response() {
    let result = response_result(
        include_str!("../fixtures/session_catalog_query.get.response.json"),
        "session.catalog.query",
    );
    let SessionCatalogQueryResult::Session { session } =
        round_trip::<SessionCatalogQueryResult>(&result)
    else {
        panic!("expected a session result");
    };
    assert!(session.is_some());
}

#[test]
fn session_create_response() {
    // `session.create` answers with a `SessionCatalogItem`.
    let result =
        response_result(include_str!("../fixtures/session_create.response.json"), "session.create");
    let item = round_trip::<SessionCatalogItem>(&result);
    assert!(item.id().starts_with("fixture-"));
}

#[test]
fn session_catalog_changed_push() {
    let value = fixture(include_str!("../fixtures/session_catalog_changed.push.json"));
    let frame = HostFrame::decode(value.clone()).expect("fixture classifies");
    assert!(matches!(
        frame,
        HostFrame::Push(PushFrame::Change(ChangeNotice::SessionCatalogChanged { .. }))
    ));
    round_trip::<ChangeNotice>(&value);
}

#[test]
fn connection_catalog_response() {
    let result = response_result(
        include_str!("../fixtures/connection_catalog_query.response.json"),
        "connection.catalog.query",
    );
    let ConnectionCatalogQueryResult::Page { items, default_target, .. } =
        round_trip::<ConnectionCatalogQueryResult>(&result)
    else {
        panic!("expected a page");
    };
    let target = default_target.expect("the dev root has a default model");
    let header = items
        .iter()
        .find_map(|item| match item {
            ConnectionCatalogItem::Connection(header)
                if header.connection_id == target.connection_id =>
            {
                Some(header)
            }
            _ => None,
        })
        .expect("the default target names a connection in the page");
    assert_eq!(header.connection_id, target.connection_id);
    assert!(items.iter().any(|item| matches!(
        item,
        ConnectionCatalogItem::CatalogEntry(entry) if entry.entry.id == target.model_id
    )));
    assert!(!items.iter().any(|item| matches!(item, ConnectionCatalogItem::Unknown(_))));
}

#[test]
fn connection_onboarding_responses() {
    let verified = response_result(
        include_str!("../fixtures/connection_onboarding_verify.response.json"),
        "connection.onboarding.verify",
    );
    let ConnectionOnboardingVerifyResult::Verified { models } =
        round_trip::<ConnectionOnboardingVerifyResult>(&verified)
    else {
        panic!("expected verified");
    };
    assert!(!models.is_empty(), "verification lists at least one model");
    let rejected = response_result(
        include_str!("../fixtures/connection_onboarding_verify.rejected.response.json"),
        "connection.onboarding.verify",
    );
    assert_eq!(
        round_trip::<ConnectionOnboardingVerifyResult>(&rejected),
        ConnectionOnboardingVerifyResult::Rejected {
            reason: ConnectionOnboardingRejection::SlugTaken
        }
    );
    let saved = response_result(
        include_str!("../fixtures/connection_onboarding_save.response.json"),
        "connection.onboarding.save",
    );
    let ConnectionOnboardingSaveResult::Saved { connection } =
        round_trip::<ConnectionOnboardingSaveResult>(&saved)
    else {
        panic!("expected saved");
    };
    // Since epoch 184 a connection to an arbitrary endpoint is `custom`.
    assert_eq!(connection.provider_type, "custom");
    assert!(connection.slug.starts_with("fixture-onboarding-"));
}

#[test]
fn connection_catalog_command_responses() {
    let committed = response_result(
        include_str!("../fixtures/connection_catalog_set_default_target.response.json"),
        "connection.catalog.set-default-target",
    );
    assert!(matches!(
        round_trip::<SetDefaultConnectionTargetResult>(&committed),
        SetDefaultConnectionTargetResult::Committed { .. }
    ));
    let conflict = response_result(
        include_str!("../fixtures/connection_catalog_set_default_target.conflict.response.json"),
        "connection.catalog.set-default-target",
    );
    assert!(matches!(
        round_trip::<SetDefaultConnectionTargetResult>(&conflict),
        SetDefaultConnectionTargetResult::RevisionConflict { expected_revision, actual_revision }
            if expected_revision < actual_revision
    ));
    let removed = response_result(
        include_str!("../fixtures/connection_catalog_remove.response.json"),
        "connection.catalog.remove",
    );
    assert!(matches!(
        round_trip::<RemoveCatalogConnectionResult>(&removed),
        RemoveCatalogConnectionResult::Committed { .. }
    ));
    let updated = response_result(
        include_str!("../fixtures/connection_catalog_update.response.json"),
        "connection.catalog.update",
    );
    assert!(matches!(
        round_trip::<UpdateCatalogConnectionResult>(&updated),
        UpdateCatalogConnectionResult::Committed { connection, .. } if connection.revision == 2
    ));
    let stale = response_result(
        include_str!("../fixtures/connection_catalog_update.stale.response.json"),
        "connection.catalog.update",
    );
    assert!(matches!(
        round_trip::<UpdateCatalogConnectionResult>(&stale),
        UpdateCatalogConnectionResult::ConnectionStale { expected, actual: Some(actual) }
            if expected.revision < actual.revision
    ));
}

#[test]
fn runtime_policy_responses() {
    let snapshot = response_result(
        include_str!("../fixtures/runtime_policy_query.response.json"),
        "runtime.policy.query",
    );
    let snapshot = round_trip::<RuntimePolicySnapshot>(&snapshot);
    assert_eq!(
        snapshot.policy.chat_defaults.permission_mode,
        crate::ChatDefaultPermissionMode::Bypass,
        "the Host's default for a fresh State Root"
    );
    let committed = response_result(
        include_str!("../fixtures/runtime_policy_mutate.response.json"),
        "runtime.policy.mutate",
    );
    assert_eq!(
        round_trip::<RuntimePolicyMutateResult>(&committed),
        RuntimePolicyMutateResult::Committed { revision: snapshot.revision + 1 }
    );
    let conflict = response_result(
        include_str!("../fixtures/runtime_policy_mutate.conflict.response.json"),
        "runtime.policy.mutate",
    );
    assert!(matches!(
        round_trip::<RuntimePolicyMutateResult>(&conflict),
        RuntimePolicyMutateResult::RevisionConflict { expected_revision, actual_revision }
            if expected_revision < actual_revision
    ));
}

#[test]
fn project_catalog_response() {
    let result = response_result(
        include_str!("../fixtures/project_catalog_query.response.json"),
        "project.catalog.query",
    );
    assert!(matches!(
        round_trip::<ProjectCatalogQueryResult>(&result),
        ProjectCatalogQueryResult::Page { .. }
    ));
}

#[test]
fn project_catalog_locations_and_register_responses() {
    let result = response_result(
        include_str!("../fixtures/project_catalog_query.locations.response.json"),
        "project.catalog.query",
    );
    let ProjectCatalogQueryResult::Page { view, items, .. } =
        round_trip::<ProjectCatalogQueryResult>(&result)
    else {
        panic!("expected a page");
    };
    assert_eq!(view, ProjectCatalogView::Locations);
    assert!(items.iter().any(|item| matches!(item, ProjectCatalogPageItem::Location { .. })));
    let result = response_result(
        include_str!("../fixtures/project_catalog_mutate.register.response.json"),
        "project.catalog.mutate",
    );
    let ProjectCatalogMutateResult::Project { project } =
        round_trip::<ProjectCatalogMutateResult>(&result)
    else {
        panic!("expected a project");
    };
    assert!(project.available && project.archived_at.is_none());
}

/// The task menu's commands, recorded on a scratch Session
/// (`capture_fixtures --task-actions`).
#[test]
fn task_command_responses() {
    let result = response_result(
        include_str!("../fixtures/session_metadata_update.response.json"),
        "session.metadata.update",
    );
    let SessionUpdateResult::Committed { session } = round_trip::<SessionUpdateResult>(&result)
    else {
        panic!("expected a commit");
    };
    let SessionCatalogItem::Session(session) = session else { panic!("expected a projection") };
    assert_eq!(session.name, "Fixture actions renamed");
    let result = response_result(
        include_str!("../fixtures/session_metadata_update.conflict.response.json"),
        "session.metadata.update",
    );
    assert!(matches!(
        round_trip::<SessionUpdateResult>(&result),
        SessionUpdateResult::RevisionConflict { expected_revision, actual_revision }
            if expected_revision < actual_revision
    ));
    let result = response_result(
        include_str!("../fixtures/session_lifecycle_set.response.json"),
        "session.lifecycle.set",
    );
    let SessionCatalogItem::Session(archived) = round_trip::<SessionCatalogItem>(&result) else {
        panic!("expected a projection");
    };
    assert!(archived.is_archived);
    let result = response_result(
        include_str!("../fixtures/session_remove_preview.response.json"),
        "session.remove.preview",
    );
    assert_eq!(round_trip::<SessionRemovePreviewResult>(&result).archivable_subtask_count, 0);
    let result = response_result(
        include_str!("../fixtures/session_remove.conflict.response.json"),
        "session.remove",
    );
    assert!(matches!(
        round_trip::<SessionRemoveResult>(&result),
        SessionRemoveResult::RevisionConflict { .. }
    ));
    let result =
        response_result(include_str!("../fixtures/session_remove.response.json"), "session.remove");
    let SessionRemoveResult::Removed { session_id, archived_subtask_count } =
        round_trip::<SessionRemoveResult>(&result)
    else {
        panic!("expected a removal");
    };
    assert_eq!(session_id, archived.id);
    assert_eq!(archived_subtask_count, None);
}

#[test]
fn subscription_open_response_with_transcript_tail() {
    let result = response_result(
        include_str!("../fixtures/subscription_open.response.json"),
        "subscription.open",
    );
    let open = round_trip::<SubscriptionOpenResult>(&result);
    assert_eq!(open.snapshot.queue.host_epoch, open.host_epoch);
    let root = open.snapshot.root_turn.as_ref().expect("the reopened Session ran a Turn");
    assert!(root.status.is_terminal());
    let bootstrap = open.transcript.expect("tail was requested");
    let (entries, incomplete) = bootstrap.durable.assemble().expect("fragments reassemble");
    assert_eq!(incomplete, None);
    assert!(matches!(entries.first().map(|entry| &entry.message), Some(StoredMessage::User(_))));
    assert!(entries.iter().any(|entry| matches!(
        &entry.message,
        StoredMessage::TurnState(state) if state.turn_id == root.turn_id && state.status != TurnStatus::Running
    )));
}

/// Every line of a recorded sequence decodes with the typed model: client
/// requests into their `Input`, responses into their `Output`, and every
/// subscription frame into a known [`SessionFrame`] variant, all
/// round-tripping exactly. Every request succeeds.
fn check_sequence(text: &str) -> Vec<Value> {
    check_sequence_with_failures(text, &[])
}

/// [`check_sequence`] for a recording in which the operations named in
/// `failing` may be answered with an error, which must decode as a
/// [`HostOperationError`].
fn check_sequence_with_failures(text: &str, failing: &[&str]) -> Vec<Value> {
    let lines: Vec<Value> =
        text.lines().map(|line| serde_json::from_str(line).expect("line is JSON")).collect();
    let mut operations = std::collections::HashMap::new();
    for line in &lines {
        if line.get("input").is_some() {
            let request = round_trip::<RequestFrame>(line);
            check_input(&request.operation, &request.input);
            operations.insert(request.request_id.clone(), request.operation);
            continue;
        }
        match HostFrame::decode(line.clone()).expect("host frame classifies") {
            HostFrame::Response(response) => {
                assert_eq!(operations.get(&response.request_id), Some(&response.operation));
                match response.outcome {
                    Outcome::Ok(result) => check_output(&response.operation, &result),
                    Outcome::Err(_) => {
                        assert!(
                            failing.contains(&response.operation.as_str()),
                            "{} failed in the recording",
                            response.operation
                        );
                        round_trip::<HostOperationError>(&line["error"]);
                    }
                }
            }
            HostFrame::Push(PushFrame::Subscription(frame)) => {
                let decoded = frame.decode().expect("subscription frame decodes");
                assert!(!matches!(decoded, SessionFrame::Unknown(_)), "unknown {}", frame.kind);
                round_trip::<SessionFrame>(&frame.raw);
            }
            HostFrame::Push(PushFrame::Change(_)) => {}
            other => panic!("unexpected frame in a sequence: {other:?}"),
        }
    }
    lines
}

fn check_input(operation: &str, input: &Value) {
    match operation {
        "session.create" => drop(round_trip::<SessionCreateInput>(input)),
        "subscription.open" => drop(round_trip::<SubscriptionOpenInput>(input)),
        "subscription.ready" | "subscription.close" => {
            drop(round_trip::<SubscriptionIdInput>(input))
        }
        "turn.start" => drop(round_trip::<TurnStartInput>(input)),
        "turn.stop" => drop(round_trip::<TurnStopInput>(input)),
        "session.transcript.page" => drop(round_trip::<SessionTranscriptPageInput>(input)),
        "interaction.answer" => drop(round_trip::<InteractionAnswerInput>(input)),
        "project.catalog.query" => drop(round_trip::<ProjectCatalogQueryInput>(input)),
        "turn.message.submit" => drop(round_trip::<TurnMessageSubmitInput>(input)),
        "queue.entry.update" => drop(round_trip::<QueueEntryUpdateInput>(input)),
        "queue.entries.reorder" => drop(round_trip::<QueueEntriesReorderInput>(input)),
        "queue.entry.promote" => drop(round_trip::<QueueEntryPromoteInput>(input)),
        "queue.entry.retract" => drop(round_trip::<QueueEntryRetractInput>(input)),
        "artifact.ingest" => drop(round_trip::<ArtifactIngestInput>(input)),
        "artifact.query" => drop(round_trip::<ArtifactQueryInput>(input)),
        "artifact.delete" => drop(round_trip::<ArtifactDeleteInput>(input)),
        "recall.query" => drop(round_trip::<RecallQueryInput>(input)),
        "runtime.resource.start" => drop(round_trip::<RuntimeResourceStartInput>(input)),
        "runtime.resource.query" => drop(round_trip::<RuntimeResourceQueryInput>(input)),
        "runtime.resource.controller.acquire" | "runtime.resource.controller.release" => {
            drop(round_trip::<RuntimeResourceControllerInput>(input))
        }
        "runtime.resource.controller.control" => {
            drop(round_trip::<RuntimeResourceControlInput>(input))
        }
        "runtime.resource.stop" => drop(round_trip::<RuntimeResourceStopInput>(input)),
        "subscription.pty_interest.set" => drop(round_trip::<PtyInterestInput>(input)),
        "execution.inspect.query" => drop(round_trip::<ExecutionInspectQueryInput>(input)),
        "context.diagnostics.query" => drop(round_trip::<ContextDiagnosticsQueryInput>(input)),
        "usage.query" => drop(round_trip::<UsageQueryInput>(input)),
        "session.turns.query" => drop(round_trip::<SessionTurnsQueryInput>(input)),
        "session.catalog.query" => drop(round_trip::<SessionCatalogQueryInput>(input)),
        "session.branch.create" => drop(round_trip::<SessionConversationCopyInput>(input)),
        "session.remove" => drop(round_trip::<SessionRemoveInput>(input)),
        other => panic!("sequence uses unmodeled operation {other}"),
    }
}

fn check_output(operation: &str, result: &Value) {
    match operation {
        "session.create" => drop(round_trip::<SessionCatalogItem>(result)),
        "subscription.open" => drop(round_trip::<SubscriptionOpenResult>(result)),
        "subscription.ready" | "subscription.close" | "subscription.pty_interest.set" => {
            drop(round_trip::<SubscriptionIdResult>(result))
        }
        "turn.start" => {
            assert!(matches!(
                round_trip::<TurnStartResult>(result),
                TurnStartResult::Started { .. }
            ));
        }
        "turn.stop" => drop(round_trip::<TurnSnapshot>(result)),
        "interaction.answer" => drop(round_trip::<InteractionSnapshot>(result)),
        "session.transcript.page" => {
            let page = round_trip::<SessionTranscriptPage>(result);
            // Small older pages cut rows that only the next page completes;
            // transcript-model's replay joins them.
            if page.direction == TranscriptDirection::Newer {
                let (_, incomplete) = page.assemble().expect("fragments reassemble");
                assert_eq!(incomplete, None);
            }
        }
        "turn.message.submit" => {
            assert!(!matches!(
                round_trip::<TurnMessageSubmitResult>(result),
                TurnMessageSubmitResult::Unknown
            ));
        }
        "queue.entry.update"
        | "queue.entries.reorder"
        | "queue.entry.promote"
        | "queue.entry.retract" => drop(round_trip::<QueueMutationResult>(result)),
        "artifact.ingest" => {
            assert!(!matches!(
                round_trip::<ArtifactIngestResult>(result),
                ArtifactIngestResult::Unknown
            ));
        }
        "artifact.query" => {
            assert!(!matches!(
                round_trip::<ArtifactQueryResult>(result),
                ArtifactQueryResult::Unknown
            ));
        }
        "artifact.delete" => drop(round_trip::<ArtifactDeleteResult>(result)),
        "recall.query" => drop(round_trip::<RecallQueryResult>(result)),
        "runtime.resource.start" => drop(round_trip::<RuntimeResourceStartResult>(result)),
        "runtime.resource.query" => {
            assert!(!matches!(
                round_trip::<RuntimeResourceQueryResult>(result),
                RuntimeResourceQueryResult::Unknown
            ));
        }
        "runtime.resource.controller.acquire" => {
            drop(round_trip::<RuntimeResourceAcquireResult>(result))
        }
        "runtime.resource.controller.control" => {
            drop(round_trip::<RuntimeResourceControlResult>(result))
        }
        "runtime.resource.controller.release" => {
            drop(round_trip::<RuntimeResourceReleaseResult>(result))
        }
        "runtime.resource.stop" => drop(round_trip::<RuntimeResourceStopResult>(result)),
        "execution.inspect.query" => {
            assert!(!matches!(
                round_trip_amounts::<ExecutionInspectQueryResult>(result),
                ExecutionInspectQueryResult::Unknown(_)
            ));
        }
        "context.diagnostics.query" => {
            assert!(!matches!(
                round_trip::<ContextDiagnosticsResult>(result),
                ContextDiagnosticsResult::Unknown(_)
            ));
        }
        "usage.query" => {
            assert!(!matches!(
                round_trip_amounts::<UsageQueryResult>(result),
                UsageQueryResult::Unknown
            ));
        }
        "session.turns.query" => drop(round_trip::<SessionTurnsQueryResult>(result)),
        "session.catalog.query" => {
            assert!(!matches!(
                round_trip::<SessionCatalogQueryResult>(result),
                SessionCatalogQueryResult::Unknown
            ));
        }
        "session.branch.create" => {
            assert!(!matches!(
                round_trip::<SessionConversationCopyResult>(result),
                SessionConversationCopyResult::Unknown
            ));
        }
        "session.remove" => drop(round_trip::<SessionRemoveResult>(result)),
        other => panic!("sequence answers unmodeled operation {other}"),
    }
}

fn root_statuses(lines: &[Value]) -> Vec<TurnRunStatus> {
    lines
        .iter()
        .filter(|line| line["kind"] == "subscription.session_projection")
        .filter_map(|line| {
            let snapshot = serde_json::from_value::<SessionFrame>(line.clone()).ok()?;
            let SessionFrame::Projection(frame) = snapshot else { return None };
            frame.snapshot.root_turn.map(|turn| turn.status)
        })
        .collect()
}

#[test]
fn stop_after_start_sequence() {
    let lines = check_sequence(include_str!("../fixtures/sequences/stop_after_start.jsonl"));
    let statuses = root_statuses(&lines);
    assert_eq!(statuses.first(), Some(&TurnRunStatus::Admitted));
    assert_eq!(statuses.last(), Some(&TurnRunStatus::Cancelled));
}

/// `turn.message.submit` and the `queue.*` commands as a real Host answers
/// them: a started Turn, three follow-ups, an edit, a reorder, a promote to
/// steering, a retract, the steering event, and the remaining follow-up
/// running as the next Turn.
#[test]
fn message_queue_sequence() {
    let lines = check_sequence(include_str!("../fixtures/sequences/message_queue.jsonl"));
    let dispositions: Vec<&str> = lines
        .iter()
        .filter(|line| line["operation"] == "turn.message.submit" && line.get("result").is_some())
        .filter_map(|line| line["result"]["disposition"].as_str())
        .collect();
    assert_eq!(dispositions, ["turn_started", "followup", "followup", "followup"]);
    let queues: Vec<Vec<(MessagePlacement, MessageQueueEntryState)>> = lines
        .iter()
        .filter_map(|line| match serde_json::from_value::<SessionFrame>(line.clone()).ok()? {
            SessionFrame::Projection(frame) => Some(
                frame
                    .snapshot
                    .queue
                    .entries()
                    .map(|entry| (entry.placement.clone(), entry.state.clone()))
                    .collect(),
            ),
            _ => None,
        })
        .collect();
    let promoted = (MessagePlacement::CurrentTurn, MessageQueueEntryState::Queued);
    let in_flight = (MessagePlacement::CurrentTurn, MessageQueueEntryState::InFlight);
    assert!(queues.iter().any(|queue| queue.contains(&promoted)), "promoted to steering");
    assert!(queues.iter().any(|queue| queue.contains(&in_flight)), "steering taken");
    assert!(queues.last().is_some_and(Vec::is_empty), "the queue drains");
    assert!(lines.iter().any(|line| {
        serde_json::from_value::<SessionFrame>(line.clone()).is_ok_and(|frame| {
            matches!(frame, SessionFrame::Event(event)
                if matches!(event.event, SessionFrameEvent::SteeringMessage(_)))
        })
    }));
}

#[test]
fn reasoning_sequence() {
    let lines = check_sequence(include_str!("../fixtures/sequences/reasoning.jsonl"));
    let thinking = lines
        .iter()
        .filter_map(|line| match serde_json::from_value::<SessionFrame>(line.clone()).ok()? {
            SessionFrame::Delta(frame) => Some(frame.delta.kind),
            _ => None,
        })
        .filter(|kind| *kind == AssistantStreamKind::Thinking)
        .count();
    assert!(thinking > 0);
}

/// `artifact.ingest` as a real Host answers it: an upload opened, its one
/// chunk accepted, the commit's `AttachmentRef` naming a file of the
/// Session, and an aborted upload. The `begin` the client sends is exactly
/// what [`ArtifactIngestInput::begin`] builds.
#[test]
fn attachment_ingest_sequence() {
    let lines = check_sequence(include_str!("../fixtures/sequences/attachment_ingest.jsonl"));
    let begin = lines
        .iter()
        .find(|line| line["operation"] == "artifact.ingest" && line["input"]["kind"] == "begin")
        .expect("a begin");
    let session_id = begin["input"]["sessionId"].as_str().expect("session");
    let rebuilt = ArtifactIngestInput::begin(
        session_id,
        begin["input"]["uploadId"].as_str().expect("upload"),
        "gate-note.txt",
        "application/octet-stream",
        b"The launch code for the garden gate is PAPAYA-42.\n",
    );
    assert_eq!(serde_json::to_value(rebuilt).expect("encode"), begin["input"]);
    let committed = lines
        .iter()
        .filter(|line| line["operation"] == "artifact.ingest" && line.get("result").is_some())
        .find_map(|line| match serde_json::from_value(line["result"].clone()).ok()? {
            ArtifactIngestResult::Committed { attachment, .. } => Some(attachment),
            _ => None,
        })
        .expect("a committed upload");
    assert_eq!((committed.kind, committed.bytes), (AttachmentKind::Generic, 50));
    assert!(matches!(
        committed.storage,
        StorageRef::SessionFile { session_id: ref owner, .. } if owner == session_id
    ));
}

/// The request `operation` sent, and the result or error the Host gave it,
/// in recording order.
fn exchanges<'a>(lines: &'a [Value], operation: &str) -> Vec<(&'a Value, &'a Value)> {
    let mut pending = std::collections::HashMap::new();
    let mut answered = Vec::new();
    for line in lines {
        if line["operation"] != operation {
            continue;
        }
        let id = line["requestId"].as_str().expect("request id");
        if line.get("input").is_some() {
            pending.insert(id, &line["input"]);
        } else if let Some(input) = pending.remove(id) {
            let answer = if line["ok"] == true { &line["result"] } else { &line["error"] };
            answered.push((input, answer));
        }
    }
    answered
}

/// A Host-owned terminal from start to exit, as a real Host answers the
/// Desktop's sequence (`record_terminal` in the capture tool): the login
/// shell's state, the Session's resources, PTY interest, the controller seat
/// with the prompt in its snapshot, `echo hi` and its output, a resize, a
/// second controller refused, the release, the stop, and the ended run read
/// after the `runtime_resource` domain change.
#[test]
fn terminal_sequence() {
    let lines = check_sequence_with_failures(
        include_str!("../fixtures/sequences/terminal.jsonl"),
        &["runtime.resource.controller.acquire"],
    );

    let [(start_input, start)] = exchanges(&lines, "runtime.resource.start")[..] else {
        panic!("one start");
    };
    let start_input: RuntimeResourceStartInput = round_trip(start_input);
    assert!(start_input.launch_id.starts_with(crate::DESKTOP_TERMINAL_LAUNCH_PREFIX));
    assert_eq!(start_input.command, None, "a terminal names no command");
    let started = round_trip::<RuntimeResourceStartResult>(start).resource;
    assert_eq!((&started.mode, &started.status), (&ShellMode::Pty, &ShellRunStatus::Running));
    assert!(started.pid.is_some() && started.cmd.contains("$SHELL"));
    let resource_ref = started.resource_ref.clone();

    let queries = exchanges(&lines, "runtime.resource.query");
    let RuntimeResourceQueryResult::Page { resources, next_cursor: None, .. } =
        round_trip(queries[0].1)
    else {
        panic!("the list is one page");
    };
    let [listed] = &resources[..] else { panic!("one resource") };
    assert!(listed.is_desktop_terminal());
    assert_eq!(listed.ownership, RuntimeResourceOwnership::Local);
    assert_eq!(listed.launch_id(), Some(start_input.launch_id.as_str()));
    assert_eq!(listed.result, started);

    let (interest, _) = exchanges(&lines, "subscription.pty_interest.set")[0];
    assert_eq!(round_trip::<PtyInterestInput>(interest).refs, std::slice::from_ref(&resource_ref));

    let acquires = exchanges(&lines, "runtime.resource.controller.acquire");
    let [(seat_input, seat), (_, refused)] = acquires[..] else { panic!("two acquires") };
    let controller: RuntimeResourceControllerInput = round_trip(seat_input);
    let seat: RuntimeResourceAcquireResult = round_trip(seat);
    assert_eq!(seat.next_sequence, 1);
    assert_eq!(seat.pty.size, PtySize::new(80, 24).expect("size"));
    assert!(seat.pty.buffer.contains("% "), "the snapshot replays the prompt");
    let refused: HostOperationError = round_trip(refused);
    assert_eq!(refused.code, HostOperationErrorCode::OperationConflict);
    assert_eq!(RuntimeResourceFailure::of(&refused), RuntimeResourceFailure::ControllerHeld);

    let controls: Vec<Value> = exchanges(&lines, "runtime.resource.controller.control")
        .into_iter()
        .map(|(input, _)| input.clone())
        .collect();
    let typed = PtyControl::input("echo hi\r").expect("input");
    let resized = PtyControl::resize(PtySize::new(100, 30).expect("size"));
    assert_eq!(
        controls,
        [
            serde_json::to_value(RuntimeResourceControlInput::new(&controller, 1, typed))
                .expect("encode"),
            serde_json::to_value(RuntimeResourceControlInput::new(&controller, 2, resized))
                .expect("encode"),
        ]
    );

    // Output after the snapshot carries the echo and its result, in order.
    let chunks: Vec<_> = lines
        .iter()
        .filter_map(|line| match serde_json::from_value::<SessionFrame>(line.clone()).ok()? {
            SessionFrame::RuntimeResourcePtyData(frame) => Some(frame),
            _ => None,
        })
        .collect();
    assert!(chunks.iter().all(|chunk| chunk.resource_ref == resource_ref && !chunk.reset));
    assert!(chunks.windows(2).all(|pair| pair[1].pty_sequence == pair[0].pty_sequence + 1));
    let after: String = chunks
        .iter()
        .filter(|chunk| chunk.pty_sequence > seat.pty.sequence)
        .map(|chunk| chunk.data.as_str())
        .collect();
    assert!(after.contains("\r\nhi\r\n"), "the shell ran the command: {after:?}");

    let (_, released) = exchanges(&lines, "runtime.resource.controller.release")[0];
    assert!(round_trip::<RuntimeResourceReleaseResult>(released).released);

    // The exit has no frame of its own: a domain change names the ref, and
    // `get` reads the ended run.
    let stop_at = lines
        .iter()
        .position(|line| {
            line["operation"] == "runtime.resource.stop" && line.get("input").is_some()
        })
        .expect("a stop");
    assert!(lines[stop_at..].iter().any(|line| {
        serde_json::from_value::<SessionFrame>(line.clone()).is_ok_and(|frame| {
            matches!(frame, SessionFrame::DomainChanged(change)
                if change.domain == SessionDomain::RuntimeResource
                    && change.resources.iter().flatten()
                        .any(|changed| changed.resource_ref == resource_ref))
        })
    }));
    let RuntimeResourceQueryResult::Resource { resource: Some(ended), .. } =
        round_trip(queries.last().expect("a get").1)
    else {
        panic!("the get finds the terminal");
    };
    assert!(ended.result.status.is_terminal());
    assert_eq!(ended.result.status, ShellRunStatus::Cancelled);
    assert_eq!(ended.result.exit_code, Some(130));
    assert!(ended.result.completed_at.is_some());
}

/// `recall.query` over the demo State Root's scripted Sessions: passages
/// with their anchors and neighbours, and a blank term refused as
/// `invalid_query` in an `ok: false` result, which this client's own check
/// refuses before sending.
#[test]
fn recall_sequence() {
    let lines = check_sequence(include_str!("../fixtures/sequences/recall.jsonl"));
    let [(found_input, found), (refused_input, refused)] = exchanges(&lines, "recall.query")[..]
    else {
        panic!("two searches");
    };
    let found_input: RecallQueryInput = round_trip(found_input);
    assert_eq!(found_input.validate(), Ok(()));
    let RecallQueryResult::Found { passages, .. } = round_trip(found) else {
        panic!("passages");
    };
    assert!(!passages.is_empty() && passages.len() <= usize::from(found_input.limit.unwrap_or(8)));
    for passage in &passages {
        let anchor = passage.anchor().expect("an anchor");
        assert_eq!(anchor.message_id, passage.anchor_message_id);
        assert!(passage.turn_id.is_some() && passage.score > 0.0);
        assert!(!passage.session_title.is_empty());
        assert!(passage.matched_terms.iter().all(|term| found_input.terms.contains(term)));
        assert!(passage.messages.iter().all(|message| {
            !matches!(message.role, RecallRole::Other(_))
                && !matches!(message.match_kind, RecallMatchKind::Other(_))
        }));
    }
    assert!(passages.windows(2).all(|pair| pair[0].score >= pair[1].score), "best first");

    let refused_input: RecallQueryInput = round_trip(refused_input);
    assert_eq!(refused_input.validate(), Err(RecallQueryError::BlankTerm));
    let RecallQueryResult::Failed { reason, message } = round_trip(refused) else {
        panic!("a refusal");
    };
    assert_eq!(reason, RecallFailureReason::InvalidQuery);
    assert!(!message.is_empty());
}

/// A side chat's fork of a task, as a real Host answers the requests (the
/// capture tool's `record_side_chat`, no model): the source's Turns, whose
/// latest completed one is the boundary, and its catalog revision; a fork
/// at a revision the source does not have, a conflict; at its revision,
/// committed with the side-conversation label and the source as its parent,
/// named as the source; the same request again, the same fork; an empty
/// fork; a missing source, `not_found`; then each fork removed.
#[test]
fn side_chat_sequence() {
    let lines = check_sequence_with_failures(
        include_str!("../fixtures/sequences/side_chat.jsonl"),
        &["session.branch.create"],
    );
    let turns: Vec<SessionTurnsQueryResult> = exchanges(&lines, "session.turns.query")
        .into_iter()
        .map(|(_, result)| round_trip(result))
        .collect();
    let contributions: Vec<SessionTurnContribution> =
        turns.iter().flat_map(|page| page.contributions.clone()).collect();
    let boundary = crate::latest_completed_turn(&contributions).expect("a completed turn");
    let source = turns[0].session_id.clone();
    let creates = exchanges(&lines, "session.branch.create");
    let [
        (stale_input, stale),
        (input, committed),
        (again_input, again),
        (empty_input, empty),
        (missing_input, missing),
    ] = &creates[..]
    else {
        panic!("five forks asked for: {creates:?}");
    };
    let stale_input: SessionConversationCopyInput = round_trip(stale_input);
    let input: SessionConversationCopyInput = round_trip(input);
    assert_eq!(input.source_session_id, source);
    assert_eq!(input.source_turn_id.as_deref(), Some(boundary.as_str()));
    assert_eq!(input.intent, Some(ConversationCopyIntent::SideConversation));
    let SessionConversationCopyResult::SourceRevisionConflict {
        expected_revision,
        actual_revision,
    } = round_trip(stale)
    else {
        panic!("a conflict");
    };
    assert_eq!(expected_revision, stale_input.expected_source_revision);
    assert_eq!(actual_revision, input.expected_source_revision);
    let SessionConversationCopyResult::Committed { session } = round_trip(committed) else {
        panic!("a fork");
    };
    let SessionCatalogItem::Session(fork) = session else { panic!("a projection") };
    assert_eq!(fork.id, input.target_session_id);
    assert!(crate::is_side_conversation(&fork.labels));
    assert_eq!(fork.parent_session_id.as_deref(), Some(source.as_str()));
    assert_eq!(fork.branch_of_turn_id.as_deref(), Some(boundary.as_str()));
    // The same request answers with the same fork.
    assert_eq!(round_trip::<SessionConversationCopyInput>(again_input), input);
    let SessionConversationCopyResult::Committed { session: again } = round_trip(again) else {
        panic!("the same fork");
    };
    assert_eq!(again.id(), fork.id);
    let empty_input: SessionConversationCopyInput = round_trip(empty_input);
    assert_eq!(empty_input.source_turn_id, None);
    let SessionConversationCopyResult::Committed { session: empty } = round_trip(empty) else {
        panic!("an empty fork");
    };
    let SessionCatalogItem::Session(empty) = empty else { panic!("a projection") };
    assert!(crate::is_side_conversation(&empty.labels));
    assert_eq!(empty.branch_of_turn_id, None);
    let missing_input: SessionConversationCopyInput = round_trip(missing_input);
    assert_ne!(missing_input.source_session_id, source);
    let refusal = round_trip::<HostOperationError>(missing);
    assert_eq!(refusal.code, HostOperationErrorCode::NotFound);
    let removed: Vec<SessionRemoveResult> = exchanges(&lines, "session.remove")
        .into_iter()
        .map(|(_, result)| round_trip(result))
        .collect();
    assert_eq!(removed.len(), 2);
    assert!(removed.iter().all(|result| matches!(result, SessionRemoveResult::Removed { .. })));
    let gets = exchanges(&lines, "session.catalog.query");
    let (_, last) = gets.last().expect("a last read");
    assert_eq!(
        round_trip::<SessionCatalogQueryResult>(last),
        SessionCatalogQueryResult::Session { session: None },
        "the fork is gone"
    );
}

/// The Files tool's reads of an uploaded file, as a real Host answers them:
/// the list, `get`, the text, a binary preview the Host does not offer for
/// text, one chunk holding the whole file, the delete, and the list without
/// it.
#[test]
fn artifact_files_sequence() {
    const CONTENT: &str = "Notes for the Files panel: the garden gate opens at nine.\n";
    let lines = check_sequence(include_str!("../fixtures/sequences/artifact_files.jsonl"));
    let upload_id = lines
        .iter()
        .find(|line| line["operation"] == "artifact.ingest" && line["input"]["kind"] == "begin")
        .and_then(|line| line["input"]["uploadId"].as_str())
        .expect("an upload");
    let answers: Vec<ArtifactQueryResult> = exchanges(&lines, "artifact.query")
        .into_iter()
        .map(|(_, result)| round_trip(result))
        .collect();
    let [
        ArtifactQueryResult::Page { artifacts, next_cursor: None, .. },
        ArtifactQueryResult::Artifact { artifact: Some(got), .. },
        ArtifactQueryResult::Text { preview, .. },
        ArtifactQueryResult::Binary { preview: binary, .. },
        chunk @ ArtifactQueryResult::Chunk { offset: 0, total_bytes, next_offset: None, .. },
        ArtifactQueryResult::Page { artifacts: after, .. },
    ] = &answers[..]
    else {
        panic!("list, get, text, binary, chunk, list: {answers:?}");
    };
    let [listed] = &artifacts[..] else { panic!("one file") };
    assert_eq!(listed, got.as_ref());
    assert_eq!((&listed.kind, &listed.source), (&ArtifactKind::File, &ArtifactSource::UserUpload));
    assert_eq!(listed.turn_id, upload_id, "an upload's Turn is its upload id");
    assert_eq!((listed.name.as_str(), listed.size_bytes), ("files-note.txt", 58));
    assert_eq!(listed.mime_type.as_deref(), Some("text/plain"));
    assert_eq!(preview, &ArtifactTextPreview::Text(CONTENT.into()));
    assert_eq!(
        binary,
        &ArtifactBinaryPreview::Unavailable(ArtifactReadFailureReason::UnsupportedMime)
    );
    assert_eq!(*total_bytes, 58);
    assert_eq!(chunk.chunk_bytes().as_deref(), Some(CONTENT.as_bytes()));
    assert!(after.is_empty(), "the deleted file is gone");
    let (delete, deleted) = exchanges(&lines, "artifact.delete")[0];
    assert_eq!(
        round_trip::<ArtifactDeleteInput>(delete),
        ArtifactDeleteInput::new(listed.session_id.clone(), listed.id.clone())
    );
    round_trip::<ArtifactDeleteResult>(deleted);
}

#[test]
fn long_history_sequence() {
    check_sequence(include_str!("../fixtures/sequences/long_history.jsonl"));
}

#[test]
fn failed_turn_sequence() {
    let lines = check_sequence(include_str!("../fixtures/sequences/failed_turn.jsonl"));
    assert_eq!(root_statuses(&lines).last(), Some(&TurnRunStatus::Failed));
}

/// The Trace face's reads, as the demo Host answers them (`record_inspector`
/// in the capture tool, over `target/demo-root`'s scripted Sessions): a
/// Session traced over more than one page, read with
/// `session_trace_continue` from each page's cursor; a Session whose Turn
/// called tools; and a Session that never ran. Each also answers its context
/// snapshot and its usage summary.
#[test]
fn inspector_sequence() {
    let lines = check_sequence(include_str!("../fixtures/sequences/inspector.jsonl"));
    let pages: Vec<(ExecutionInspectQueryInput, crate::SessionTracePage)> =
        exchanges(&lines, "execution.inspect.query")
            .into_iter()
            .map(|(input, result)| {
                let ExecutionInspectQueryResult::SessionTracePage(page) =
                    round_trip_amounts(result)
                else {
                    panic!("a trace page");
                };
                (round_trip(input), page)
            })
            .collect();
    let [(first_input, first), (continue_input, earlier), (_, tools), (_, idle)] = &pages[..]
    else {
        panic!("two pages of one Session, then one page of two others: {}", pages.len());
    };
    // Paging: the continuation names the first page's cursor, and answers
    // older Turns.
    let ExecutionInspectQueryInput::SessionTraceStart { session_id } = first_input else {
        panic!("a start");
    };
    assert_eq!(
        continue_input,
        &ExecutionInspectQueryInput::session_trace(session_id.clone(), first.next_cursor.clone())
    );
    assert_eq!(first.turns.len(), crate::EXECUTION_INSPECT_TRACE_PAGE_MAX_TURNS);
    assert!(first.turns.windows(2).all(|pair| pair[0].started_at <= pair[1].started_at));
    let newest_earlier = earlier.turns.last().expect("earlier turns").started_at;
    assert!(newest_earlier < first.turns[0].started_at, "a continuation reads older runs");
    assert!(earlier.next_cursor.is_some(), "the Session has more than two pages");
    for page in [first, earlier, tools, idle] {
        assert_eq!(page.schema_version, SESSION_TRACE_SCHEMA_VERSION);
        assert!(page.turns.iter().flat_map(|turn| &turn.steps).all(|step| {
            !matches!(step, TraceStep::Unknown(_))
                && !matches!(step, TraceStep::ModelCall(call)
                    if matches!(call.call_kind, ModelCallKind::Other(_))
                        || matches!(call.status, ModelCallStatus::Other(_)))
        }));
    }
    // The demo connection is unpriced: no cost anywhere, every attempt says why.
    let calls = || {
        first.turns.iter().chain(&tools.turns).flat_map(|turn| &turn.steps).filter_map(|step| {
            match step {
                TraceStep::ModelCall(call) => Some(call),
                _ => None,
            }
        })
    };
    assert!(calls().all(|call| call.cost_usd.is_none()
        && call.attempts.iter().all(|attempt| attempt.cost_basis == CostBasis::Unpriced)));
    assert_eq!(first.coverage.model_calls, ModelCallCoverage::NoKnownGap);
    assert!(tools.turns[0].steps.iter().any(|step| matches!(step, TraceStep::Tool(_))));
    assert!(idle.turns.is_empty() && idle.next_cursor.is_none());
    assert_eq!(idle.coverage.model_calls, ModelCallCoverage::NoActivity);

    let snapshots: Vec<ContextDiagnosticsResult> = exchanges(&lines, "context.diagnostics.query")
        .into_iter()
        .map(|(input, result)| {
            round_trip::<ContextDiagnosticsQueryInput>(input);
            round_trip(result)
        })
        .collect();
    let [
        ContextDiagnosticsResult::Available(paged_snapshot),
        ContextDiagnosticsResult::Available(_),
        ContextDiagnosticsResult::Unavailable(none),
    ] = &snapshots[..]
    else {
        panic!("two snapshots and an unavailable answer: {snapshots:?}");
    };
    assert_eq!(none.reason, ContextUnavailableReason::NoCompletedRequest);
    assert!(paged_snapshot.input_tokens.is_some());
    let composition = paged_snapshot.composition.as_ref().expect("a composition");
    assert!(
        composition
            .segments
            .iter()
            .all(|segment| !matches!(segment.kind, ContextSegmentKind::Other(_)))
    );

    let summaries: Vec<UsageQueryResult> = exchanges(&lines, "usage.query")
        .into_iter()
        .map(|(input, result)| {
            let input: UsageQueryInput = round_trip(input);
            assert!(matches!(input, UsageQueryInput::Summary { .. }));
            round_trip_amounts(result)
        })
        .collect();
    let [
        UsageQueryResult::Summary { summary, provenance },
        _,
        UsageQueryResult::Summary { summary: idle_summary, provenance: idle_provenance },
    ] = &summaries[..]
    else {
        panic!("three summaries: {summaries:?}");
    };
    assert!(summary.total_requests > 0 && summary.total_tokens.input > 0);
    assert_eq!(provenance.estimated_cost(summary.total_cost_usd), None, "unpriced: cost unknown");
    assert_eq!(idle_summary.total_requests, 0);
    assert_eq!(idle_provenance.coverage.attempts, 0);
}

/// HAND-BUILT, not recorded: no real Host recording of a sandbox-boundary
/// prompt exists yet (`docs/dev-host.md`, "Why the permission fixture is
/// still missing"). `fixtures/hand_built/sandbox_boundary_allow.jsonl` is
/// written from the TS decoders (`decodeInteractionRequest`,
/// `decodeInteractionCanonicalOutcome` in `packages/core/src/interaction.ts`,
/// `validateSandboxBoundaryExpansion` in `packages/core/src/sandbox-boundary.ts`)
/// with `hand-built-*` ids: a projection with the pending prompt, the
/// client's allow, the Host's answered snapshot, and the projection without
/// the prompt. Replace it with a `permission_allow` recording once one exists.
#[test]
fn hand_built_sandbox_boundary_sequence() {
    let lines = check_sequence(include_str!("../fixtures/hand_built/sandbox_boundary_allow.jsonl"));

    let SessionFrame::Projection(pending) =
        serde_json::from_value::<SessionFrame>(lines[0].clone()).expect("projection")
    else {
        panic!("expected a projection");
    };
    let prompt = &pending.snapshot.interactions.pending[0];
    assert_eq!(prompt.tool_use_id(), None, "a sandbox boundary names no Tool call");
    let InteractionRequest::SandboxBoundary(request) = &prompt.request else {
        panic!("expected a sandbox boundary request");
    };
    let entries = &request.expansion.filesystem.as_ref().expect("filesystem").entries;
    assert_eq!(
        entries
            .iter()
            .map(|entry| (entry.path.as_str(), &entry.access, &entry.scope))
            .collect::<Vec<_>>(),
        [
            ("/Users/me/Documents", &SandboxBoundaryAccess::Read, &SandboxBoundaryScope::Subtree),
            (
                "/private/tmp/report.txt",
                &SandboxBoundaryAccess::Write,
                &SandboxBoundaryScope::Exact
            ),
        ]
    );
    assert!(request.expansion.network.as_ref().is_some_and(|network| network.enabled));

    let answer = round_trip::<RequestFrame>(&lines[1]);
    let input: InteractionAnswerInput = serde_json::from_value(answer.input).expect("input");
    assert_eq!(
        input.answer,
        InteractionAnswer::SandboxBoundary { decision: PermissionDecision::Allow }
    );

    let HostFrame::Response(response) = HostFrame::decode(lines[2].clone()).expect("response")
    else {
        panic!("expected a response");
    };
    let Outcome::Ok(result) = response.outcome else { panic!("expected success") };
    let answered = round_trip::<InteractionSnapshot>(&result);
    assert_eq!(answered.status, InteractionStatus::Answered);
    assert!(matches!(
        answered.outcome,
        Some(InteractionOutcome::SandboxBoundaryDecision(SandboxBoundaryOutcome {
            decision: PermissionDecision::Allow,
            status: SandboxBoundaryStatus::Approved,
            ..
        }))
    ));
}
