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

//! Scenario tests on frames built in code.
//!
//! The dev State Root's model connection could not answer when the fixtures
//! were recorded, so the text, permission, and mid-stream stop flows have no
//! recording yet. These tests build those frames from the shapes the TS
//! decoders accept (`packages/runtime-host/src/protocol/session-continuity.ts`
//! and friends). Replace them with replays once
//! `scripts/capture-fixtures.sh --sequences` records the real sequences.

use base64::Engine as _;
use host_protocol::{
    HostFrame, InteractionSnapshot, ProviderRetryPhase, ProviderRetryReason, PushFrame,
    SessionFrame, SessionTranscriptPage, SubscriptionOpenResult,
};
use serde_json::{Value, json};
use transcript_model::{
    Change, InteractionState, ItemKey, ReopenReason, Resolution, ToolStatus, Transcript, TurnItem,
    TurnViewStatus,
};

const EPOCH: &str = "epoch-1";
const SUBSCRIPTION: &str = "sub-1";
const SESSION: &str = "s1";
const TURN: &str = "t1";
const RUN: &str = "run-1";

/// Builds frames with consecutive sequences.
struct Host {
    sequence: u64,
    revision: u64,
}

impl Host {
    fn new() -> Self {
        Self { sequence: 1, revision: 1 }
    }

    fn frame(&mut self, kind: &str, fields: Value) -> SessionFrame {
        let mut value = json!({
            "kind": kind, "hostEpoch": EPOCH, "subscriptionId": SUBSCRIPTION,
            "sequence": self.sequence
        });
        for (key, field) in fields.as_object().expect("object") {
            value[key] = field.clone();
        }
        self.sequence += 1;
        serde_json::from_value(value).expect("frame decodes")
    }

    fn projection(&mut self, root: Value, pending: Vec<Value>) -> SessionFrame {
        self.revision += 1;
        let snapshot = snapshot(self.revision, root, pending);
        self.frame("subscription.session_projection", json!({"snapshot": snapshot}))
    }

    fn delta(&mut self, message: &str, start: u64, text: &str, flags: Value) -> SessionFrame {
        let mut delta = json!({
            "kind": "text", "turnId": TURN, "runId": RUN, "messageId": message,
            "startOffset": start, "text": text
        });
        for (key, flag) in flags.as_object().expect("object") {
            delta[key] = flag.clone();
        }
        self.frame("subscription.session_delta", json!({"sessionId": SESSION, "delta": delta}))
    }

    fn event(&mut self, event: Value) -> SessionFrame {
        self.frame(
            "subscription.session_event",
            json!({"sessionId": SESSION, "runId": RUN, "event": event}),
        )
    }

    fn advanced(&mut self, through: u64) -> SessionFrame {
        self.frame(
            "subscription.transcript_advanced",
            json!({"sessionId": SESSION, "throughSequence": through}),
        )
    }
}

fn snapshot(revision: u64, root: Value, pending: Vec<Value>) -> Value {
    json!({
        "schemaVersion": 5,
        "session": {"sessionId": SESSION, "metadataRevision": 1, "status": "running",
                    "createdAt": 1, "isArchived": false},
        "projectionRevision": revision,
        "rootTurn": root,
        "goal": null,
        "queue": {"hostEpoch": EPOCH, "queueRevision": 0, "steering": [], "followup": []},
        "interactions": {"pending": pending}
    })
}

fn root(status: &str) -> Value {
    let mut root = json!({"sessionId": SESSION, "turnId": TURN, "runId": RUN, "status": status});
    match status {
        "completed" => root["terminalEventId"] = json!("end"),
        "cancelled" => {
            root["terminalEventId"] = json!("end");
            root["abortSource"] = json!("renderer.stop_button");
        }
        _ => {}
    }
    root
}

fn open() -> Transcript {
    let open: SubscriptionOpenResult = serde_json::from_value(json!({
        "hostEpoch": EPOCH,
        "subscriptionId": SUBSCRIPTION,
        "nextSequence": 1,
        "snapshot": snapshot(1, Value::Null, vec![]),
        "activeAssistantStreams": [],
        "transcript": {"durable": {
            "kind": "page", "sessionId": SESSION, "direction": "older", "throughSequence": null,
            "rawBytes": 0, "fragments": [], "nextCursor": null, "endsAtTurnBoundary": true
        }}
    }))
    .expect("open result");
    Transcript::bootstrap(&open).expect("bootstrap")
}

/// A `newer` page through `through` holding `rows` as whole fragments.
fn page(through: u64, rows: &[(u64, Value)]) -> SessionTranscriptPage {
    let mut raw = 0;
    let fragments: Vec<Value> = rows
        .iter()
        .map(|(sequence, row)| {
            let bytes = serde_json::to_vec(row).expect("row");
            raw += bytes.len();
            json!({
                "sequence": sequence, "byteOffset": 0, "totalBytes": bytes.len(),
                "payloadDigest": null,
                "data": base64::engine::general_purpose::STANDARD.encode(&bytes)
            })
        })
        .collect();
    serde_json::from_value(json!({
        "kind": "page", "sessionId": SESSION, "direction": "newer", "throughSequence": through,
        "rawBytes": raw, "fragments": fragments, "nextCursor": null, "endsAtTurnBoundary": true
    }))
    .expect("page")
}

fn user_row() -> Value {
    json!({"type": "user", "id": TURN, "turnId": TURN, "ts": 10, "text": "hi"})
}

/// Admitted → prompt row durable → running, as the recorded sequences show.
fn start_turn(transcript: &mut Transcript, host: &mut Host) {
    transcript.apply(&host.projection(root("admitted"), vec![]));
    transcript.apply(&host.advanced(23));
    transcript.apply_transcript_page(&page(23, &[(16, user_row())]));
    transcript.apply(&host.projection(root("running"), vec![]));
}

fn text_of(transcript: &Transcript, message: &str) -> transcript_model::TextItem {
    let turn = transcript.turn(TURN).expect("turn");
    match turn.item(&ItemKey::Text(message.into())) {
        Some(TurnItem::Text(text)) => text.clone(),
        other => panic!("expected text {message}, got {other:?}"),
    }
}

fn keys(transcript: &Transcript) -> Vec<String> {
    transcript.turn(TURN).expect("turn").items.iter().map(|item| item.key().to_string()).collect()
}

fn key(kind: fn(String) -> ItemKey, id: &str) -> ItemKey {
    kind(id.to_owned())
}

/// The running root with a provider retry (`TurnProviderRetry`).
fn retrying(retry: Value) -> Value {
    let mut root = root("running");
    root["providerRetry"] = retry;
    root
}

#[test]
fn the_live_turn_carries_its_provider_retry_until_the_host_clears_it() {
    let mut transcript = open();
    let mut host = Host::new();
    start_turn(&mut transcript, &mut host);
    let retry = |transcript: &Transcript| transcript.turn(TURN)?.provider_retry.clone();
    assert_eq!(retry(&transcript), None);

    let changes = transcript.apply(&host.projection(
        retrying(json!({"phase": "scheduled", "attempt": 2, "maxAttempts": 5,
                        "delayMs": 4000, "reason": "network", "ts": 1_790_000_000_000u64})),
        vec![],
    ));
    assert!(changes.contains(&Change::TurnUpdated { turn_id: TURN.into() }), "{changes:?}");
    let scheduled = retry(&transcript).expect("scheduled");
    assert_eq!(scheduled.phase, ProviderRetryPhase::Scheduled);
    assert_eq!(scheduled.reason, ProviderRetryReason::Network);
    assert_eq!(scheduled.delay_ms, Some(4000));

    transcript.apply(&host.projection(
        retrying(json!({"phase": "started", "attempt": 2, "maxAttempts": 5,
                        "reason": "network"})),
        vec![],
    ));
    assert_eq!(retry(&transcript).expect("started").phase, ProviderRetryPhase::Started);

    // The attempt answered: the Host's next projection has no retry.
    let changes = transcript.apply(&host.projection(root("running"), vec![]));
    assert!(changes.contains(&Change::TurnUpdated { turn_id: TURN.into() }), "{changes:?}");
    assert_eq!(retry(&transcript), None);
}

#[test]
fn streamed_text_appends_and_hands_off_to_the_durable_row() {
    let mut transcript = open();
    let mut host = Host::new();
    start_turn(&mut transcript, &mut host);
    let turn = || TURN.to_owned();

    assert_eq!(
        transcript.apply(&host.delta("m1", 0, "Hello", json!({}))),
        [Change::ItemAdded { turn_id: turn(), key: key(ItemKey::Text, "m1"), index: 1 }]
    );
    assert_eq!(
        transcript.apply(&host.delta("m1", 5, ", wor", json!({}))),
        [Change::ItemTextAppended { turn_id: turn(), key: key(ItemKey::Text, "m1") }]
    );
    // A replayed, overlapping delta contributes only its unseen tail.
    assert_eq!(
        transcript.apply(&host.delta("m1", 3, "lo, world", json!({}))),
        [Change::ItemTextAppended { turn_id: turn(), key: key(ItemKey::Text, "m1") }]
    );
    assert!(text_of(&transcript, "m1").streaming);
    // An empty completion closes the stream without resending the text.
    assert_eq!(
        transcript.apply(&host.delta("m1", 12, "", json!({"complete": true}))),
        [Change::ItemUpdated { turn_id: turn(), key: key(ItemKey::Text, "m1") }]
    );
    let text = text_of(&transcript, "m1");
    assert_eq!((text.text.as_str(), text.streaming, text.ts), ("Hello, world", false, None));

    assert_eq!(
        transcript.apply(&host.advanced(40)),
        [Change::TranscriptBehind { through_sequence: 40 }]
    );
    let changes = transcript.apply_transcript_page(&page(
        40,
        &[
            (
                32,
                json!({"type": "assistant", "id": "m1", "turnId": TURN, "ts": 20,
                        "text": "Hello, world", "contentOrder": ["text"], "modelId": "m"}),
            ),
            (
                40,
                json!({"type": "turn_state", "id": "end", "turnId": TURN, "ts": 21,
                        "status": "completed"}),
            ),
        ],
    ));
    // The durable row takes over the same key; only its timestamp is new.
    assert_eq!(
        changes,
        [
            Change::ItemUpdated { turn_id: turn(), key: key(ItemKey::Text, "m1") },
            Change::TurnUpdated { turn_id: turn() },
        ]
    );
    assert_eq!(text_of(&transcript, "m1").ts, Some(20));
    assert_eq!(
        transcript.apply(&host.projection(root("completed"), vec![])),
        [
            Change::SessionStateChanged,
            Change::TurnFinished { turn_id: turn(), status: TurnViewStatus::Completed },
        ]
    );
    assert_eq!(keys(&transcript), ["user:t1", "text:m1"]);
    assert_eq!(transcript.turn(TURN).expect("turn").model_id.as_deref(), Some("m"));
}

fn permission_snapshot(status: &str, outcome: Value) -> Value {
    json!({
        "schemaVersion": 1, "interactionId": "i1", "sessionId": SESSION, "turnId": TURN,
        "runId": RUN, "revision": if status == "pending" { 1 } else { 2 },
        "request": {"kind": "permission", "toolUseId": "c1", "prompt": {
            "kind": "tool_permission", "toolName": "Bash", "category": "shell_unsafe",
            "reason": "shell_dangerous", "review": {"kind": "command", "command": "ls"},
            "rememberForTurnAllowed": true
        }},
        "status": status,
        "outcome": outcome
    })
}

#[test]
fn a_permission_prompt_sits_after_its_tool_and_resolves() {
    let mut transcript = open();
    let mut host = Host::new();
    start_turn(&mut transcript, &mut host);
    let turn = || TURN.to_owned();
    let tool = || key(ItemKey::Tool, "c1");
    let prompt = || key(ItemKey::Interaction, "i1");

    assert_eq!(
        transcript.apply(&host.event(json!({
            "type": "tool_start", "id": "e1", "turnId": TURN, "ts": 11, "toolUseId": "c1",
            "toolName": "Bash", "activityKind": "command", "argsPreview": {"command": "ls"},
            "stepId": "s1"
        }))),
        [Change::ItemAdded { turn_id: turn(), key: tool(), index: 1 }]
    );
    let pending = permission_snapshot("pending", Value::Null);
    assert_eq!(
        transcript.apply(&host.projection(root("waiting_for_user"), vec![pending])),
        [
            Change::SessionStateChanged,
            Change::ItemAdded { turn_id: turn(), key: prompt(), index: 2 },
            Change::TurnUpdated { turn_id: turn() },
        ]
    );
    let view = transcript.turn(TURN).expect("turn");
    assert_eq!(view.status, TurnViewStatus::WaitingForUser);
    let Some(TurnItem::Interaction(item)) = view.item(&prompt()) else { panic!("prompt item") };
    assert!(item.is_pending());
    assert_eq!(item.tool_name.as_deref(), Some("Bash"));
    assert_eq!(transcript.pending_interactions().len(), 1);

    // The `interaction.answer` result arrives before the next projection.
    let answered: InteractionSnapshot = serde_json::from_value(permission_snapshot(
        "answered",
        json!({"kind": "permission_answer", "reviewer": "user", "committedAt": 12,
               "decision": "allow", "rememberForTurn": false}),
    ))
    .expect("answered");
    assert_eq!(
        transcript.apply_interaction(&answered),
        [Change::ItemUpdated { turn_id: turn(), key: prompt() }]
    );
    assert_eq!(
        transcript.apply(&host.projection(root("running"), vec![])),
        [Change::SessionStateChanged, Change::TurnUpdated { turn_id: turn() }]
    );
    assert_eq!(
        transcript.apply(&host.event(json!({
            "type": "tool_result", "id": "e2", "turnId": TURN, "ts": 13, "toolUseId": "c1",
            "status": "completed", "durationMs": 4
        }))),
        [Change::ItemUpdated { turn_id: turn(), key: tool() }]
    );
    assert_eq!(
        transcript.apply(&host.delta("m2", 0, "Three entries.", json!({"complete": true}))),
        [Change::ItemAdded { turn_id: turn(), key: key(ItemKey::Text, "m2"), index: 3 }]
    );

    transcript.apply(&host.advanced(80));
    let changes = transcript.apply_transcript_page(&page(
        80,
        &[
            (
                24,
                json!({"type": "tool_call", "id": "c1", "turnId": TURN, "ts": 11,
                        "toolName": "Bash", "activityKind": "command",
                        "args": {"command": "ls"}, "stepId": "s1"}),
            ),
            (
                32,
                json!({"type": "permission_decision", "id": "i1", "turnId": TURN, "ts": 12,
                        "toolUseId": "c1", "toolName": "Bash", "decision": "allow",
                        "rememberForTurn": false, "reviewer": "user"}),
            ),
            (
                40,
                json!({"type": "tool_result", "id": "r1", "turnId": TURN, "ts": 13,
                        "toolUseId": "c1", "isError": false,
                        "content": {"kind": "text", "text": "a\nb\nc"}, "durationMs": 4}),
            ),
            (
                48,
                json!({"type": "assistant", "id": "s1", "turnId": TURN, "ts": 14, "text": "",
                        "contentOrder": ["tools"], "modelId": "m"}),
            ),
            (
                56,
                json!({"type": "assistant", "id": "m2", "turnId": TURN, "ts": 15,
                        "text": "Three entries.", "contentOrder": ["text"], "modelId": "m"}),
            ),
            (
                64,
                json!({"type": "turn_state", "id": "end", "turnId": TURN, "ts": 16,
                        "status": "completed"}),
            ),
        ],
    ));
    assert_eq!(
        changes,
        [
            Change::ItemUpdated { turn_id: turn(), key: tool() },
            Change::ItemUpdated { turn_id: turn(), key: key(ItemKey::Text, "m2") },
            Change::TurnUpdated { turn_id: turn() },
        ]
    );
    transcript.apply(&host.projection(root("completed"), vec![]));

    assert_eq!(keys(&transcript), ["user:t1", "tool:c1", "interaction:i1", "text:m2"]);
    let view = transcript.turn(TURN).expect("turn");
    let Some(TurnItem::Tool(tool)) = view.item(&tool()) else { panic!("tool") };
    assert_eq!(tool.status, ToolStatus::Completed);
    assert_eq!(tool.args, Some(json!({"command": "ls"})));
    assert_eq!(tool.result_text(), Some("a\nb\nc"));
    let Some(TurnItem::Interaction(item)) = view.item(&prompt()) else { panic!("prompt") };
    assert!(item.request.is_some(), "the live request is kept after the durable row lands");
    assert_eq!(
        item.state,
        InteractionState::Resolved(Resolution::Permission {
            decision: host_protocol::PermissionDecision::Allow,
            remember_for_turn: false
        })
    );
}

#[test]
fn a_prompt_that_leaves_without_an_answer_reads_unknown() {
    let mut transcript = open();
    let mut host = Host::new();
    start_turn(&mut transcript, &mut host);
    let pending = permission_snapshot("pending", Value::Null);
    transcript.apply(&host.projection(root("waiting_for_user"), vec![pending]));
    transcript.apply(&host.projection(root("cancelled"), vec![]));
    let view = transcript.turn(TURN).expect("turn");
    let Some(TurnItem::Interaction(item)) = view.item(&key(ItemKey::Interaction, "i1")) else {
        panic!("prompt")
    };
    assert_eq!(item.state, InteractionState::Resolved(Resolution::Unknown));
    assert_eq!(view.status, TurnViewStatus::Cancelled);
}

fn sandbox_snapshot(status: &str, outcome: Value) -> Value {
    json!({
        "schemaVersion": 1, "interactionId": "b1", "sessionId": SESSION, "turnId": TURN,
        "runId": RUN, "revision": if status == "pending" { 1 } else { 2 },
        "request": {"kind": "sandbox_boundary",
                    "expansion": {"filesystem": {"entries": [
                        {"path": "/Users/me/Documents", "access": "read", "scope": "subtree"}
                    ]}},
                    "justification": "List the documents folder."},
        "status": status,
        "outcome": outcome
    })
}

#[test]
fn a_sandbox_boundary_prompt_resolves_with_its_decision_and_status() {
    let mut transcript = open();
    let mut host = Host::new();
    start_turn(&mut transcript, &mut host);
    let prompt = || key(ItemKey::Interaction, "b1");
    let pending = sandbox_snapshot("pending", Value::Null);
    transcript.apply(&host.projection(root("waiting_for_user"), vec![pending]));
    // It names no Tool, so it sits at the end of the Turn.
    assert_eq!(keys(&transcript), ["user:t1", "interaction:b1"]);

    // The next projection may drop the prompt before the answer arrives.
    transcript.apply(&host.projection(root("running"), vec![]));
    let state = |transcript: &Transcript| match transcript.turn(TURN).expect("turn").item(&prompt())
    {
        Some(TurnItem::Interaction(item)) => item.state.clone(),
        other => panic!("expected the prompt, got {other:?}"),
    };
    assert_eq!(state(&transcript), InteractionState::Resolved(Resolution::Unknown));

    let answered: InteractionSnapshot = serde_json::from_value(sandbox_snapshot(
        "answered",
        json!({"kind": "sandbox_boundary_decision", "decision": "allow", "status": "conflict",
               "committedAt": 12}),
    ))
    .expect("answered");
    assert_eq!(
        transcript.apply_interaction(&answered),
        [Change::ItemUpdated { turn_id: TURN.to_owned(), key: prompt() }]
    );
    assert_eq!(
        state(&transcript),
        InteractionState::Resolved(Resolution::SandboxBoundary {
            decision: host_protocol::PermissionDecision::Allow,
            status: host_protocol::SandboxBoundaryStatus::Conflict,
        })
    );
}

#[test]
fn stopping_mid_stream_closes_the_open_stream_and_keeps_the_interruption() {
    let mut transcript = open();
    let mut host = Host::new();
    start_turn(&mut transcript, &mut host);
    let turn = || TURN.to_owned();
    transcript.apply(&host.delta("m1", 0, "1\n2\n", json!({})));
    transcript.apply(&host.delta("m1", 4, "3\n", json!({})));
    // The stop settles the root Turn while the stream is still open.
    assert_eq!(
        transcript.apply(&host.projection(root("cancelled"), vec![])),
        [
            Change::SessionStateChanged,
            Change::ItemUpdated { turn_id: turn(), key: key(ItemKey::Text, "m1") },
            Change::TurnFinished { turn_id: turn(), status: TurnViewStatus::Cancelled },
        ]
    );
    let text = text_of(&transcript, "m1");
    assert_eq!((text.text.as_str(), text.streaming), ("1\n2\n3\n", false));

    transcript.apply(&host.advanced(40));
    transcript.apply_transcript_page(&page(
        40,
        &[
            (
                24,
                json!({"type": "assistant", "id": "m1", "turnId": TURN, "ts": 20,
                        "text": "1\n2\n3\n", "interrupted": true, "contentOrder": ["text"],
                        "modelId": "m"}),
            ),
            (
                32,
                json!({"type": "turn_state", "id": "end", "turnId": TURN, "ts": 21,
                        "status": "aborted", "abortSource": "renderer.stop_button"}),
            ),
        ],
    ));
    let text = text_of(&transcript, "m1");
    assert!(text.interrupted, "the durable row marks the interruption");
    assert_eq!(keys(&transcript), ["user:t1", "text:m1"]);
}

#[test]
fn an_interrupted_completion_marks_the_live_text() {
    let mut transcript = open();
    let mut host = Host::new();
    start_turn(&mut transcript, &mut host);
    transcript.apply(&host.delta("m1", 0, "partial", json!({})));
    transcript.apply(&host.delta("m1", 7, "", json!({"complete": true, "interrupted": true})));
    let text = text_of(&transcript, "m1");
    assert!(text.interrupted && !text.streaming);
    assert_eq!(text.text, "partial");
}

#[test]
fn offsets_are_utf16_units() {
    let mut transcript = open();
    let mut host = Host::new();
    start_turn(&mut transcript, &mut host);
    transcript.apply(&host.delta("m1", 0, "你好😀", json!({})));
    // "你好😀" is four UTF-16 units; a replay from unit 2 overlaps the emoji.
    transcript.apply(&host.delta("m1", 2, "😀！", json!({})));
    assert_eq!(text_of(&transcript, "m1").text, "你好😀！");
}

#[test]
fn a_sequence_gap_asks_for_a_reopen_and_freezes_the_transcript() {
    let mut transcript = open();
    let mut host = Host::new();
    start_turn(&mut transcript, &mut host);
    host.sequence += 1; // one frame lost
    let changes = transcript.apply(&host.delta("m1", 0, "x", json!({})));
    assert_eq!(
        changes,
        [Change::NeedsReopen { reason: ReopenReason::SequenceGap { expected: 4, received: 5 } }]
    );
    assert!(transcript.apply(&host.delta("m1", 1, "y", json!({}))).is_empty());
    assert!(transcript.needs_reopen().is_some());
    assert_eq!(transcript.transcript_request(), None);
    assert!(transcript.turn(TURN).expect("turn").item(&key(ItemKey::Text, "m1")).is_none());
}

#[test]
fn a_new_host_epoch_asks_for_a_reopen() {
    let mut transcript = open();
    let mut host = Host::new();
    let mut frame = serde_json::to_value(host.projection(root("admitted"), vec![])).expect("json");
    frame["hostEpoch"] = json!("epoch-2");
    let frame: SessionFrame = serde_json::from_value(frame).expect("frame");
    assert_eq!(
        transcript.apply(&frame),
        [Change::NeedsReopen { reason: ReopenReason::HostEpochChanged }]
    );
}

#[test]
fn a_conflicting_delta_asks_for_a_reopen() {
    let mut transcript = open();
    let mut host = Host::new();
    start_turn(&mut transcript, &mut host);
    transcript.apply(&host.delta("m1", 0, "abc", json!({})));
    let changes = transcript.apply(&host.delta("m1", 1, "Xc", json!({})));
    assert!(matches!(
        changes.as_slice(),
        [Change::NeedsReopen { reason: ReopenReason::StreamDiverged(_) }]
    ));
}

#[test]
fn a_stale_projection_asks_for_a_reopen() {
    let mut transcript = open();
    let mut host = Host::new();
    transcript.apply(&host.projection(root("admitted"), vec![]));
    host.revision -= 1;
    let changes = transcript.apply(&host.projection(root("running"), vec![]));
    assert_eq!(changes, [Change::NeedsReopen { reason: ReopenReason::ProjectionRevisionStale }]);
}

#[test]
fn a_malformed_frame_asks_for_a_reopen() {
    let mut transcript = open();
    let raw =
        json!({"kind": "subscription.session_delta", "subscriptionId": SUBSCRIPTION, "seq": 1});
    let HostFrame::Push(PushFrame::Subscription(frame)) = HostFrame::decode(raw).expect("routes")
    else {
        panic!("expected a subscription frame");
    };
    let changes = transcript.apply_frame(&frame);
    assert!(matches!(
        changes.as_slice(),
        [Change::NeedsReopen { reason: ReopenReason::MalformedFrame(_) }]
    ));
}

#[test]
fn the_catch_up_read_matches_the_desktop_replica() {
    let mut transcript = open();
    let mut host = Host::new();
    assert_eq!(transcript.transcript_request(), None);
    transcript.apply(&host.advanced(23));
    let first = transcript.transcript_request().expect("behind");
    assert_eq!((first.through_sequence, first.anchor_sequence), (Some(23), None));
    transcript.apply_transcript_page(&page(23, &[(16, user_row())]));
    transcript.apply(&host.advanced(31));
    let second = transcript.transcript_request().expect("behind again");
    assert_eq!((second.through_sequence, second.anchor_sequence), (Some(31), Some(23)));
}

#[test]
fn reopening_mid_stream_resumes_the_open_stream_from_offset_zero() {
    let prompt = serde_json::to_vec(&user_row()).expect("row");
    let open: SubscriptionOpenResult = serde_json::from_value(json!({
        "hostEpoch": EPOCH,
        "subscriptionId": SUBSCRIPTION,
        "nextSequence": 9,
        "snapshot": snapshot(5, root("running"), vec![]),
        "activeAssistantStreams": [
            {"kind": "thinking", "turnId": TURN, "messageId": "m1"},
            {"kind": "text", "turnId": TURN, "messageId": "m1"}
        ],
        "transcript": {"durable": {
            "kind": "page", "sessionId": SESSION, "direction": "older", "throughSequence": 16,
            "rawBytes": prompt.len(), "nextCursor": null, "endsAtTurnBoundary": false,
            "fragments": [{"sequence": 16, "byteOffset": 0, "totalBytes": prompt.len(),
                           "payloadDigest": null,
                           "data": base64::engine::general_purpose::STANDARD.encode(&prompt)}]
        }}
    }))
    .expect("open result");
    let mut transcript = Transcript::bootstrap(&open).expect("bootstrap");
    assert_eq!(keys(&transcript), ["user:t1"]);
    assert_eq!(transcript.turn(TURN).expect("turn").status, TurnViewStatus::Running);
    let mut host = Host { sequence: 9, revision: 5 };
    transcript.apply(&host.delta("m1", 0, "Hello", json!({})));
    assert_eq!(text_of(&transcript, "m1").text, "Hello");
    // The thinking stream of the same message left no phantom text stream.
    let changes = transcript.apply(&host.projection(root("completed"), vec![]));
    assert!(
        changes
            .contains(&Change::ItemUpdated { turn_id: TURN.into(), key: key(ItemKey::Text, "m1") })
    );
    assert_eq!(text_of(&transcript, "m1").text, "Hello");
}

#[test]
fn an_unknown_frame_kind_is_skipped_in_order() {
    let mut transcript = open();
    let mut host = Host::new();
    assert!(transcript.apply(&host.frame("subscription.future_kind", json!({"x": 1}))).is_empty());
    assert_eq!(transcript.next_sequence(), 2);
    let unordered: SessionFrame = serde_json::from_value(json!({
        "kind": "subscription.future_unordered", "hostEpoch": EPOCH, "subscriptionId": SUBSCRIPTION
    }))
    .expect("frame");
    assert!(transcript.apply(&unordered).is_empty());
    assert!(transcript.needs_reopen().is_none());
}

/// An `older` page of `rows` (newest first on the wire), each whole.
fn older_page(rows: &[(u64, Value)], next: Option<&str>, boundary: bool) -> Value {
    let mut raw = 0;
    let fragments: Vec<Value> = rows
        .iter()
        .rev()
        .map(|(sequence, row)| {
            let bytes = serde_json::to_vec(row).expect("row");
            raw += bytes.len();
            json!({
                "sequence": sequence, "byteOffset": 0, "totalBytes": bytes.len(),
                "payloadDigest": null,
                "data": base64::engine::general_purpose::STANDARD.encode(&bytes)
            })
        })
        .collect();
    json!({
        "kind": "page", "sessionId": SESSION, "direction": "older", "throughSequence": 48,
        "rawBytes": raw, "fragments": fragments, "nextCursor": next,
        "endsAtTurnBoundary": boundary
    })
}

fn turn_rows(turn: &str, first: u64) -> Vec<(u64, Value)> {
    vec![
        (first, json!({"type": "user", "id": turn, "turnId": turn, "ts": first, "text": turn})),
        (
            first + 8,
            json!({"type": "turn_state", "id": format!("{turn}-end"), "turnId": turn,
                   "ts": first + 8, "status": "completed"}),
        ),
    ]
}

/// Opened with a tail that holds Turn `t3` and a cursor to older history.
fn open_with_older_history() -> Transcript {
    let mut open: Value = serde_json::from_value(json!({
        "hostEpoch": EPOCH,
        "subscriptionId": SUBSCRIPTION,
        "nextSequence": 1,
        "snapshot": snapshot(1, Value::Null, vec![]),
        "activeAssistantStreams": [],
        "transcript": {"durable": older_page(&turn_rows("t3", 40), Some("c1"), true)}
    }))
    .expect("open");
    open["transcript"]["durable"]["throughSequence"] = json!(48);
    Transcript::bootstrap(&serde_json::from_value(open).expect("open result")).expect("bootstrap")
}

fn turn_ids(transcript: &Transcript) -> Vec<&str> {
    transcript.turns().iter().map(|turn| turn.turn_id.as_str()).collect()
}

#[test]
fn older_pages_prepend_whole_turns_at_the_tail_watermark() {
    let mut transcript = open_with_older_history();
    let mut host = Host::new();
    assert_eq!(turn_ids(&transcript), ["t3"]);
    // New rows move the watermark; older reads stay bound to the tail's.
    transcript.apply(&host.advanced(60));
    let request = transcript.older_request(1024).expect("older history");
    assert_eq!(
        (request.through_sequence, request.cursor.as_deref(), request.max_bytes),
        (Some(48), Some("c1"), 1024)
    );
    assert_eq!(request.anchor_sequence, None);

    // A page that stops inside Turn t2 shows nothing yet and asks for more.
    let rows = turn_rows("t2", 24);
    let page: SessionTranscriptPage =
        serde_json::from_value(older_page(&rows[1..], Some("c2"), false)).expect("page");
    assert_eq!(transcript.apply_transcript_page(&page), []);
    assert!(transcript.older_read_incomplete());
    assert_eq!(turn_ids(&transcript), ["t3"]);
    assert_eq!(transcript.older_request(1024).and_then(|r| r.cursor).as_deref(), Some("c2"));

    // The next page reaches t2's prompt and the start of t1; both go first.
    let mut rows = turn_rows("t1", 8);
    rows.push(turn_rows("t2", 24)[0].clone());
    let page: SessionTranscriptPage =
        serde_json::from_value(older_page(&rows, None, true)).expect("page");
    assert_eq!(
        transcript.apply_transcript_page(&page),
        [
            Change::TurnAdded { turn_id: "t1".into(), index: 0 },
            Change::TurnAdded { turn_id: "t2".into(), index: 1 },
        ]
    );
    assert_eq!(turn_ids(&transcript), ["t1", "t2", "t3"]);
    let t2 = transcript.turn("t2").expect("t2");
    assert_eq!(t2.status, TurnViewStatus::Completed);
    assert!(matches!(&t2.items[0], TurnItem::User(user) if user.text() == "t2"));
    assert!(transcript.reached_first_row());
    assert_eq!(transcript.older_request(1024), None);
    // A late page after the start is stale.
    assert_eq!(transcript.apply_transcript_page(&page), []);
}

/// A search result names a message by its id and by its index in the
/// Session: the id finds its item once its row is held; the index only
/// once the first row is held, since the rows' sequences are not indexes.
#[test]
fn a_message_is_found_by_id_once_held_and_by_index_from_the_start() {
    let mut transcript = open_with_older_history();
    assert_eq!(transcript.item_of_message("t3"), Some(("t3".into(), ItemKey::User("t3".into()))));
    assert_eq!(transcript.item_of_message("t1"), None, "not read yet");
    assert_eq!(transcript.item_of_message("t3-end"), None, "a Turn's state shows no item");
    assert_eq!(transcript.message_id_at(0), None, "the start is not held");

    let mut rows = turn_rows("t1", 8);
    rows.extend([
        (
            17,
            json!({"type": "assistant", "id": "t1-a", "turnId": "t1", "ts": 9,
                   "text": "Done.", "contentOrder": ["tools", "text"], "modelId": "m"}),
        ),
        (
            18,
            json!({"type": "tool_call", "id": "t1-c", "turnId": "t1", "ts": 9,
                   "toolName": "Bash", "args": {"command": "ls"}, "stepId": "t1-a"}),
        ),
        (
            19,
            json!({"type": "tool_result", "id": "t1-r", "turnId": "t1", "ts": 9,
                   "toolUseId": "t1-c", "isError": false,
                   "content": {"kind": "text", "text": "a.txt"}}),
        ),
    ]);
    rows.sort_by_key(|(sequence, _)| *sequence);
    let page: SessionTranscriptPage =
        serde_json::from_value(older_page(&rows, None, true)).expect("page");
    transcript.apply_transcript_page(&page);
    let t1 = |key| Some(("t1".to_owned(), key));
    assert_eq!(transcript.item_of_message("t1"), t1(ItemKey::User("t1".into())));
    assert_eq!(transcript.item_of_message("t1-a"), t1(ItemKey::Text("t1-a".into())));
    assert_eq!(transcript.item_of_message("t1-c"), t1(ItemKey::Tool("t1-c".into())));
    assert_eq!(transcript.item_of_message("t1-r"), t1(ItemKey::Tool("t1-c".into())), "its call");
    // Sequences 8, 16, 17, 18, 19, then t3's 40 and 48.
    let ids: Vec<_> = (0..8).map(|index| transcript.message_id_at(index)).collect();
    assert_eq!(
        ids,
        [
            Some("t1"),
            Some("t1-end"),
            Some("t1-a"),
            Some("t1-c"),
            Some("t1-r"),
            Some("t3"),
            Some("t3-end"),
            None
        ]
    );
}

/// A turn too large for the 16 KiB tail: the tail holds its reply, and the
/// older page that brings the rest, a code cell's `Write` among it, makes
/// its edits worth reading again, though no newer row arrived and no turn
/// was added (F29: the card of a Code Mode turn whose cells wrote seven
/// files never showed, its edits read once from the tail alone).
#[test]
fn older_rows_of_a_turn_already_shown_move_its_edits_key() {
    use transcript_model::edits::{EditsKey, session_edits};
    let nested = |row: Value| {
        let mut row = row;
        row["origin"] = json!("code_mode");
        row["modelVisibility"] = json!("hidden");
        row["parentToolCallId"] = json!("call_e1");
        row["parentOperationId"] = json!("op1");
        row
    };
    let rows = [
        (40, json!({"type": "user", "id": "t3", "turnId": "t3", "ts": 40, "text": "Notes"})),
        (
            41,
            json!({"type": "tool_call", "id": "call_e1", "turnId": "t3", "ts": 41,
                   "toolName": "exec", "stepId": "s1", "origin": "provider",
                   "modelVisibility": "visible", "args": {"code": "await tools.Write(…)"}}),
        ),
        (
            42,
            nested(json!({"type": "tool_call", "id": "call_e1:nested:u1", "turnId": "t3",
                          "ts": 42, "toolName": "Write", "stepId": "call_e1:nested",
                          "args": {"path": "notes.md", "content": "hi\n"}})),
        ),
        (
            43,
            nested(json!({"type": "tool_result", "id": "op2_response", "turnId": "t3", "ts": 43,
                          "toolUseId": "call_e1:nested:u1", "isError": false,
                          "content": {"kind": "file_diff", "paths": ["/w/notes.md"],
                                      "diff": "--- /dev/null\n+++ b//w/notes.md\n@@ -0,0 +1 @@\n+hi"}})),
        ),
        (
            44,
            json!({"type": "tool_result", "id": "op1_response", "turnId": "t3", "ts": 44,
                   "toolUseId": "call_e1", "isError": false, "origin": "provider",
                   "modelVisibility": "visible",
                   "content": {"kind": "json", "value": {"ok": true}}}),
        ),
        (
            45,
            json!({"type": "assistant", "id": "s2", "turnId": "t3", "ts": 45, "text": "Done.",
                   "modelId": "m"}),
        ),
        (
            48,
            json!({"type": "turn_state", "id": "t3-end", "turnId": "t3", "ts": 48,
                   "status": "completed"}),
        ),
    ];
    let mut open: Value = json!({
        "hostEpoch": EPOCH, "subscriptionId": SUBSCRIPTION, "nextSequence": 1,
        "snapshot": snapshot(1, Value::Null, vec![]), "activeAssistantStreams": [],
        "transcript": {"durable": older_page(&rows[4..], Some("c1"), false)}
    });
    open["transcript"]["durable"]["throughSequence"] = json!(48);
    let mut transcript = Transcript::bootstrap(&serde_json::from_value(open).expect("open result"))
        .expect("bootstrap");
    assert_eq!(turn_ids(&transcript), ["t3"], "the turn shows from its reply");
    let key = EditsKey::of(&transcript);
    assert_eq!(session_edits(&transcript), []);

    let page: SessionTranscriptPage =
        serde_json::from_value(older_page(&rows[..4], None, true)).expect("page");
    transcript.apply_transcript_page(&page);
    assert_eq!(turn_ids(&transcript), ["t3"]);
    assert_ne!(EditsKey::of(&transcript), key, "the turn has rows it had not");
    let edits = session_edits(&transcript);
    let paths: Vec<(&str, &str)> = edits
        .iter()
        .flat_map(|turn| &turn.edits)
        .map(|edit| (edit.tool_use_id.as_str(), edit.path.as_str()))
        .collect();
    assert_eq!(paths, [("call_e1:nested:u1", "/w/notes.md")]);
}

/// Turn `turn`'s rows from `first`: its prompt, a step that says what it
/// will do, an `Edit` of `path`, the reply, and its end.
fn edit_turn_rows(turn: &str, first: u64, path: &str) -> Vec<(u64, Value)> {
    let (step, call) = (format!("{turn}-s1"), format!("{turn}-c1"));
    let diff = format!("--- a/{path}\n+++ b/{path}\n@@ -1 +1 @@\n-a\n+b");
    vec![
        (first, json!({"type": "user", "id": turn, "turnId": turn, "ts": first, "text": turn})),
        (
            first + 1,
            json!({"type": "assistant", "id": step, "turnId": turn, "ts": first + 1,
                   "text": "Editing.", "contentOrder": ["text", "tools"], "modelId": "m"}),
        ),
        (
            first + 2,
            json!({"type": "tool_call", "id": call, "turnId": turn, "ts": first + 2,
                   "toolName": "Edit", "args": {"path": path}, "stepId": step}),
        ),
        (
            first + 3,
            json!({"type": "tool_result", "id": format!("{call}-r"), "turnId": turn,
                   "ts": first + 3, "toolUseId": call, "isError": false,
                   "content": {"kind": "file_diff", "paths": [path], "diff": diff}}),
        ),
        (
            first + 4,
            json!({"type": "assistant", "id": format!("{turn}-s2"), "turnId": turn,
                   "ts": first + 4, "text": "Done.", "modelId": "m"}),
        ),
        (
            first + 5,
            json!({"type": "turn_state", "id": format!("{turn}-end"), "turnId": turn,
                   "ts": first + 5, "status": "completed"}),
        ),
    ]
}

fn edited_turns(transcript: &Transcript) -> Vec<String> {
    transcript_model::edits::session_edits(transcript)
        .into_iter()
        .map(|turn| turn.turn_id)
        .collect()
}

/// A turn larger than the tail: the tail stops inside it, so it shows
/// without its start and none of its edits count, not even the one in the
/// tail, until the older pages that reach its start are prepended. A turn
/// whose first row comes after the tail is whole at once (F30: the card
/// counted half a turn).
#[test]
fn a_turn_the_tail_cut_counts_no_edits_until_its_start_is_held() {
    use transcript_model::edits::EditsKey;
    let rows = edit_turn_rows("t3", 40, "/w/a.py");
    // The tail starts at the Edit; the prompt and the first step are older.
    let mut open: Value = json!({
        "hostEpoch": EPOCH, "subscriptionId": SUBSCRIPTION, "nextSequence": 1,
        "snapshot": snapshot(1, Value::Null, vec![]), "activeAssistantStreams": [],
        "transcript": {"durable": older_page(&rows[2..], Some("c1"), false)}
    });
    open["transcript"]["durable"]["throughSequence"] = json!(48);
    let mut transcript = Transcript::bootstrap(&serde_json::from_value(open).expect("open result"))
        .expect("bootstrap");
    assert!(transcript.has_partial_turn());
    assert!(!transcript.has_turn_start("t3"));
    assert_eq!(edited_turns(&transcript), Vec::<String>::new(), "its Edit is in the tail");

    let mut host = Host::new();
    transcript.apply(&host.advanced(60));
    transcript.apply_transcript_page(&page(60, &edit_turn_rows("t4", 50, "/w/b.py")));
    assert!(transcript.has_turn_start("t4"), "a turn after the tail starts in it");
    assert_eq!(edited_turns(&transcript), ["t4"]);
    let key = EditsKey::of(&transcript);

    // A page that stops inside t3 holds its rows back: nothing changes.
    let page_inside: SessionTranscriptPage =
        serde_json::from_value(older_page(&rows[1..2], Some("c2"), false)).expect("page");
    transcript.apply_transcript_page(&page_inside);
    assert!(!transcript.has_turn_start("t3"));
    assert_eq!(EditsKey::of(&transcript), key);

    // The page that reaches its prompt, and the whole turn t2 before it.
    let mut older = turn_rows("t2", 24);
    older.push(rows[0].clone());
    let start: SessionTranscriptPage =
        serde_json::from_value(older_page(&older, Some("c3"), true)).expect("page");
    transcript.apply_transcript_page(&start);
    assert!(!transcript.has_partial_turn());
    assert!(transcript.has_turn_start("t3"));
    assert_ne!(EditsKey::of(&transcript), key);
    assert_eq!(edited_turns(&transcript), ["t3", "t4"]);

    // A tail that ends between turns cuts none.
    assert!(!open_with_older_history().has_partial_turn());
}

#[test]
fn a_broken_older_page_asks_for_a_reopen() {
    // Another Session's page.
    let mut transcript = open_with_older_history();
    let mut other = older_page(&turn_rows("t2", 24), None, true);
    other["sessionId"] = json!("s2");
    let other: SessionTranscriptPage = serde_json::from_value(other).expect("page");
    assert!(matches!(
        transcript.apply_transcript_page(&other)[..],
        [Change::NeedsReopen { reason: ReopenReason::CorrelationChanged }]
    ));
    assert_eq!(
        transcript.older_request(1024),
        None,
        "a transcript that needs a reopen reads no more"
    );

    // The first row cut off with no cursor to finish it.
    let mut transcript = open_with_older_history();
    let mut cut = older_page(&turn_rows("t2", 24), None, true);
    let fragment = &mut cut["fragments"][1];
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(fragment["data"].as_str().expect("data"))
        .expect("base64");
    fragment["byteOffset"] = json!(4);
    fragment["data"] = json!(base64::engine::general_purpose::STANDARD.encode(&bytes[4..]));
    cut["rawBytes"] = json!(cut["rawBytes"].as_u64().expect("raw") - 4);
    let cut: SessionTranscriptPage = serde_json::from_value(cut).expect("page");
    assert!(matches!(
        transcript.apply_transcript_page(&cut)[..],
        [Change::NeedsReopen { reason: ReopenReason::TranscriptCorrupt(_) }]
    ));
}

fn thinking_of(transcript: &Transcript, message: &str) -> transcript_model::ThinkingItem {
    let turn = transcript.turn(TURN).expect("turn");
    match turn.item(&ItemKey::Thinking(message.into())) {
        Some(TurnItem::Thinking(thinking)) => thinking.clone(),
        other => panic!("expected reasoning {message}, got {other:?}"),
    }
}

#[test]
fn reasoning_streams_beside_the_text_and_hands_off_to_the_durable_row() {
    let mut transcript = open();
    let mut host = Host::new();
    start_turn(&mut transcript, &mut host);
    let turn = || TURN.to_owned();
    let thinking = |flags: Value| {
        let mut flags = flags;
        flags["kind"] = json!("thinking");
        flags
    };

    assert_eq!(
        transcript.apply(&host.delta("m1", 0, "Let me ", thinking(json!({})))),
        [Change::ItemAdded { turn_id: turn(), key: key(ItemKey::Thinking, "m1"), index: 1 }]
    );
    assert_eq!(
        transcript.apply(&host.delta("m1", 7, "think.", thinking(json!({})))),
        [Change::ItemTextAppended { turn_id: turn(), key: key(ItemKey::Thinking, "m1") }]
    );
    // The text of the same message streams on its own offsets.
    assert_eq!(
        transcript.apply(&host.delta("m1", 0, "Answer.", json!({}))),
        [Change::ItemAdded { turn_id: turn(), key: key(ItemKey::Text, "m1"), index: 2 }]
    );
    let reasoning = thinking_of(&transcript, "m1");
    assert_eq!((reasoning.text.as_str(), reasoning.streaming), ("Let me think.", true));
    assert_eq!(text_of(&transcript, "m1").text, "Answer.", "reasoning stays out of the text");
    assert_eq!(
        transcript.apply(&host.delta("m1", 13, "", thinking(json!({"complete": true})))),
        [Change::ItemUpdated { turn_id: turn(), key: key(ItemKey::Thinking, "m1") }]
    );
    assert!(!thinking_of(&transcript, "m1").streaming);
    assert!(text_of(&transcript, "m1").streaming);
    transcript.apply(&host.delta("m1", 7, "", json!({"complete": true})));

    transcript.apply(&host.advanced(40));
    transcript.apply_transcript_page(&page(
        40,
        &[(
            32,
            json!({"type": "assistant", "id": "m1", "turnId": TURN, "ts": 20, "text": "Answer.",
                   "thinking": {"text": "Let me think."}, "contentOrder": ["thinking", "text"],
                   "modelId": "m"}),
        )],
    ));
    assert_eq!(keys(&transcript), ["user:t1", "thinking:m1", "text:m1"]);
    assert_eq!(text_of(&transcript, "m1").ts, Some(20), "the durable row took over");
    let reasoning = thinking_of(&transcript, "m1");
    assert_eq!((reasoning.text.as_str(), reasoning.streaming), ("Let me think.", false));
}

#[test]
fn a_stop_closes_open_reasoning_and_a_reopen_resumes_it() {
    let mut transcript = open();
    let mut host = Host::new();
    start_turn(&mut transcript, &mut host);
    transcript.apply(&host.delta("m1", 0, "Hmm", json!({"kind": "thinking"})));
    transcript.apply(&host.projection(root("cancelled"), vec![]));
    let reasoning = thinking_of(&transcript, "m1");
    assert_eq!((reasoning.text.as_str(), reasoning.streaming), ("Hmm", false));

    // Reopened while the reasoning streams: what is known shows at once.
    let open: SubscriptionOpenResult = serde_json::from_value(json!({
        "hostEpoch": EPOCH, "subscriptionId": SUBSCRIPTION, "nextSequence": 1,
        "snapshot": snapshot(1, root("running"), vec![]),
        "activeAssistantStreams": [{"kind": "thinking", "turnId": TURN, "messageId": "m2"}],
        "transcript": {"durable": {
            "kind": "page", "sessionId": SESSION, "direction": "older", "throughSequence": null,
            "rawBytes": 0, "fragments": [], "nextCursor": null, "endsAtTurnBoundary": true
        }}
    }))
    .expect("open result");
    let mut transcript = Transcript::bootstrap(&open).expect("bootstrap");
    let mut host = Host::new();
    // The Host resends the open stream from offset 0 after ready.
    transcript.apply(&host.delta("m2", 0, "Still thinking", json!({"kind": "thinking"})));
    assert_eq!(thinking_of(&transcript, "m2").text, "Still thinking");
    assert!(thinking_of(&transcript, "m2").streaming);
}

/// Adversarial review 2026-09-26: the TS client fails a transcript read whose
/// page returns the cursor it was read with ("Session transcript cursor did
/// not advance", `#loadTranscriptSource` and `decodeTranscriptPage` in
/// packages/runtime-host/src/client/session-subscription.ts). Here such a
/// page is taken as progress: the next request names the same cursor, and
/// because the transcript still reports itself behind (catch-up) or
/// incomplete (older history), the conversation issues it at once, so a Host
/// that repeats a cursor gets the same read forever. Such a page now asks
/// for a reopen.
#[test]
fn a_page_that_repeats_its_cursor_asks_for_a_reopen() {
    // Older history: a page that stops inside Turn t2, then one that repeats
    // its cursor.
    let mut transcript = open_with_older_history();
    let rows = turn_rows("t2", 24);
    let partial: SessionTranscriptPage =
        serde_json::from_value(older_page(&rows[1..], Some("c2"), false)).expect("page");
    transcript.apply_transcript_page(&partial);
    assert!(transcript.older_read_incomplete());
    let stuck: SessionTranscriptPage =
        serde_json::from_value(older_page(&[], Some("c2"), false)).expect("page");
    let changes = transcript.apply_transcript_page(&stuck);
    assert!(
        matches!(changes[..], [Change::NeedsReopen { .. }]),
        "older: {changes:?}, next request {:?}",
        transcript.older_request(1024).and_then(|request| request.cursor)
    );

    // Catch-up: a newer page with a cursor, then one that repeats it.
    let mut transcript = open();
    let mut host = Host::new();
    transcript.apply(&host.advanced(23));
    let mut first = serde_json::to_value(page(23, &[(16, user_row())])).expect("page");
    first["nextCursor"] = json!("n1");
    transcript.apply_transcript_page(&serde_json::from_value(first).expect("page"));
    let mut repeat = serde_json::to_value(page(23, &[])).expect("page");
    repeat["nextCursor"] = json!("n1");
    let changes = transcript.apply_transcript_page(&serde_json::from_value(repeat).expect("page"));
    assert!(
        matches!(changes[..], [Change::NeedsReopen { .. }]),
        "catch-up: {changes:?}, next request {:?}",
        transcript.transcript_request().and_then(|request| request.cursor)
    );
}

fn tool_of(transcript: &Transcript, id: &str) -> transcript_model::ToolItem {
    match transcript.turn(TURN).expect("turn").item(&ItemKey::Tool(id.into())) {
        Some(TurnItem::Tool(tool)) => tool.clone(),
        other => panic!("expected Tool {id}, got {other:?}"),
    }
}

/// A code cell (`exec`) whose script reads a file, in the shape a real Host
/// gives it at epoch 197 (recorded against a scripted model, with made-up
/// content here): the `Read` the script makes is a call of its own, with the
/// id `<exec id>:nested:<uuid>` in the step `<exec id>:nested`. Live, the
/// `exec` start carries no arguments and the `Read` start only its path, in
/// `shellRunRef`; results carry no content; and the Host announces the
/// durable rows that hold the arguments and results only once the turn ends.
#[test]
fn a_read_inside_a_code_cell_names_its_file_live_and_gets_its_result_at_turn_end() {
    const EXEC: &str = "call_e1";
    const READ: &str = "call_e1:nested:u1";
    let mut transcript = open();
    let mut host = Host::new();
    start_turn(&mut transcript, &mut host);
    transcript.apply(&host.event(json!({
        "type": "tool_start", "id": "op1_call", "turnId": TURN, "ts": 11, "toolUseId": EXEC,
        "toolName": "exec", "operationId": "op1", "stepId": "s1"
    })));
    transcript.apply(&host.event(json!({
        "type": "tool_start", "id": "op2_call", "turnId": TURN, "ts": 12, "toolUseId": READ,
        "toolName": "Read", "operationId": "op2", "activityKind": "read",
        "stepId": "call_e1:nested", "shellRunRef": "~/notes/SKILL.md"
    })));
    for (id, operation, ts) in [(READ, "op2", 13), (EXEC, "op1", 14)] {
        transcript.apply(&host.event(json!({
            "type": "tool_result", "id": format!("{operation}_response"), "turnId": TURN,
            "ts": ts, "toolUseId": id, "operationId": operation, "status": "completed",
            "durationMs": 4
        })));
    }
    assert_eq!(keys(&transcript), ["user:t1", "tool:call_e1", "tool:call_e1:nested:u1"]);
    let read = tool_of(&transcript, READ);
    assert_eq!(read.status, ToolStatus::Completed);
    assert_eq!(read.display_args(), Some(&json!({"path": "~/notes/SKILL.md"})));
    assert_eq!(read.result, None, "a live result carries no content");
    let exec = tool_of(&transcript, EXEC);
    assert_eq!(
        (exec.status, exec.display_args(), exec.result.as_ref()),
        (ToolStatus::Completed, None, None)
    );

    // The turn ends, and only then does the Host announce its rows.
    let code = "const note = await tools.Read({path: \"~/notes/SKILL.md\"});\nreturn note";
    let file = json!({"content": "line one\n", "next": null, "offset": 0, "returnedLines": 1,
                      "totalLines": 1});
    let nested = |row: Value| {
        let mut row = row;
        row["origin"] = json!("code_mode");
        row["modelVisibility"] = json!("hidden");
        row["parentToolCallId"] = json!(EXEC);
        row["parentOperationId"] = json!("op1");
        row
    };
    transcript.apply(&host.projection(root("completed"), vec![]));
    transcript.apply(&host.advanced(119));
    transcript.apply_transcript_page(&page(
        119,
        &[
            (
                32,
                json!({"type": "assistant", "id": "s1", "turnId": TURN, "ts": 10, "text": "",
                       "thinking": {"text": "Read the note."}, "modelId": "m"}),
            ),
            (
                40,
                json!({"type": "tool_call", "id": EXEC, "turnId": TURN, "ts": 11,
                       "toolName": "exec", "stepId": "s1", "origin": "provider",
                       "modelVisibility": "visible", "args": {"code": code}}),
            ),
            (
                56,
                nested(json!({"type": "tool_call", "id": READ, "turnId": TURN, "ts": 12,
                              "toolName": "Read", "activityKind": "read",
                              "stepId": "call_e1:nested",
                              "args": {"path": "~/notes/SKILL.md"}})),
            ),
            (
                72,
                nested(json!({"type": "tool_result", "id": "op2_response", "turnId": TURN,
                              "ts": 13, "toolUseId": READ, "isError": false, "durationMs": 4,
                              "content": {"kind": "json", "value": file}})),
            ),
            (
                80,
                json!({"type": "tool_result", "id": "op1_response", "turnId": TURN, "ts": 14,
                       "toolUseId": EXEC, "isError": false, "durationMs": 4,
                       "origin": "provider", "modelVisibility": "visible",
                       "content": {"kind": "json", "value": {
                           "ok": true, "toolCalls": [{"index": 1, "name": "Read"}],
                           "value": file}}}),
            ),
            (
                96,
                json!({"type": "assistant", "id": "s2", "turnId": TURN, "ts": 15,
                       "text": "The note has one line.", "modelId": "m"}),
            ),
            (
                112,
                json!({"type": "turn_state", "id": "end", "turnId": TURN, "ts": 16,
                       "status": "completed"}),
            ),
        ],
    ));
    assert_eq!(
        keys(&transcript),
        ["user:t1", "thinking:s1", "tool:call_e1", "tool:call_e1:nested:u1", "text:s2"]
    );
    let read = tool_of(&transcript, READ);
    assert_eq!(read.args, Some(json!({"path": "~/notes/SKILL.md"})));
    assert_eq!(read.result, Some(json!({"kind": "json", "value": file})));
    let exec = tool_of(&transcript, EXEC);
    assert_eq!(exec.args, Some(json!({"code": code})));
    assert_eq!(
        exec.result.as_ref().and_then(|result| result.pointer("/value/ok")),
        Some(&json!(true))
    );
}
