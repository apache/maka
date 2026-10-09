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
    SessionRemovePreviewResult, SessionRemoveResult, SessionTranscriptPage,
    SessionTranscriptPageInput, SessionUpdateResult, SetDefaultConnectionTargetResult,
    StoredMessage, SubscriptionIdInput, SubscriptionIdResult, SubscriptionOpenInput,
    SubscriptionOpenResult, TurnRunStatus, TurnSnapshot, TurnStartInput, TurnStartResult,
    TurnStatus, TurnStopInput, UpdateCatalogConnectionResult, WorkspaceTarget,
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
/// round-tripping exactly.
fn check_sequence(text: &str) -> Vec<Value> {
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
                let Outcome::Ok(result) = response.outcome else {
                    panic!("{} failed in the recording", response.operation);
                };
                check_output(&response.operation, &result);
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
        other => panic!("sequence uses unmodeled operation {other}"),
    }
}

fn check_output(operation: &str, result: &Value) {
    match operation {
        "session.create" => drop(round_trip::<SessionCatalogItem>(result)),
        "subscription.open" => drop(round_trip::<SubscriptionOpenResult>(result)),
        "subscription.ready" | "subscription.close" => {
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

#[test]
fn long_history_sequence() {
    check_sequence(include_str!("../fixtures/sequences/long_history.jsonl"));
}

#[test]
fn failed_turn_sequence() {
    let lines = check_sequence(include_str!("../fixtures/sequences/failed_turn.jsonl"));
    assert_eq!(root_statuses(&lines).last(), Some(&TurnRunStatus::Failed));
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
