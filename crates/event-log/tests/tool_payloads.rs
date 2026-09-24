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

use maka_event_log::{EventLog, artifacts::ArtifactDeletion};
use maka_runtime::{
    capability::{CallResult, ContentBlock},
    event::{
        EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent, ToolOutcome,
    },
    tool_call::ToolCallIdentity,
    tool_output::{DurableToolProjection, ToolOutput, ToolSuccess},
};
use serde_json::json;
use std::time::{Duration, UNIX_EPOCH};

fn invocation() -> Invocation {
    Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    }
}

fn plain(fact: Fact) -> EventWrite {
    EventWrite::plain(RuntimeEvent::new(invocation(), fact)).unwrap()
}

fn dispatch(operation: &str) -> EventWrite {
    plain(Fact::ToolDispatched {
        operation_id: operation.into(),
        call: ToolCallIdentity::standalone(format!("{operation}-call")),
        name: "Read".into(),
        input: json!({}),
    })
}

fn success(operation: &str, output: &ToolOutput) -> EventWrite {
    EventWrite::tool_success(
        format!("{operation}-result"),
        UNIX_EPOCH + Duration::from_secs(1),
        invocation(),
        operation.into(),
        output.clone().into(),
    )
    .unwrap()
    .0
}

async fn open(path: &std::path::Path) -> EventLog {
    let log = EventLog::open(path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    log.append(&plain(Fact::InvocationOpened {
        configuration: None,
        input: InvocationInput::Code {
            source: "fixture".into(),
        },
    }))
    .await
    .unwrap();
    log
}

#[tokio::test]
async fn large_raw_reopens_exactly_without_entering_the_compact_prefix() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = open(&path).await;
    let output = ToolOutput::Text("🦊\u{0001}".repeat(1024 * 1024 / 5));
    let operation = "large";
    let outcome = success(operation, &output);
    assert!(matches!(
        &outcome.event().fact,
        Fact::ToolSettled {
            outcome: ToolOutcome::Succeeded {
                model_projection: DurableToolProjection::Failure,
                ..
            },
            ..
        }
    ));
    log.append_batch(&[dispatch(operation), outcome.clone()])
        .await
        .unwrap();
    let prefix = log.prefix(100, 8192).await.unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.resolve_tool_result("session", &outcome.event().id)
            .await
            .unwrap(),
        output
    );
    assert_eq!(log.prefix(100, 8192).await.unwrap().digest, prefix.digest);
    let commits = log.subscribe_commits();
    log.append(&outcome).await.unwrap();
    assert!(!commits.has_changed().unwrap());
    log.close().await.unwrap();
}

#[tokio::test]
async fn raw_media_and_t2_rollback_together_then_replay_after_sealing() {
    for workspace_snapshot in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let log = open(&path).await;
        log.append(&dispatch("image")).await.unwrap();
        let output = ToolOutput::Mcp(CallResult {
            content: vec![ContentBlock::Image {
                data: "iVBORw0KGgo=".into(),
                mime_type: "image/png".into(),
            }],
            structured_content: None,
        });
        let pending = if workspace_snapshot {
            ToolSuccess::image(b"\x89PNG\r\n\x1a\n".to_vec(), "image/png".into()).unwrap()
        } else {
            output.into()
        };
        let (outcome, output) = EventWrite::tool_success(
            "image-result".into(),
            UNIX_EPOCH + Duration::from_secs(1),
            invocation(),
            "image".into(),
            pending,
        )
        .unwrap();
        if workspace_snapshot {
            assert!(matches!(output, ToolOutput::Image(_)));
        }
        let media_id = &outcome.projection_artifacts()[0].artifact().id;
        let invalid = plain(Fact::ToolSettled {
            operation_id: "undispatched".into(),
            outcome: ToolOutcome::Failed {
                message: "rollback preceding successful result".into(),
            },
        });
        let commits = log.subscribe_commits();
        assert!(log.append_batch(&[outcome.clone(), invalid]).await.is_err());
        assert!(!commits.has_changed().unwrap());
        let inspect = rusqlite::Connection::open(&path).unwrap();
        for table in ["tool_result_payloads", "artifacts"] {
            assert_eq!(
                inspect
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        assert_eq!(log.prefix(10, 8192).await.unwrap().events.len(), 2);
        let sequence = log.append(&outcome).await.unwrap();
        assert_eq!(
            log.delete_user_artifact("session", media_id).await.unwrap(),
            ArtifactDeletion::Protected
        );
        log.append(&plain(Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        }))
        .await
        .unwrap();
        log.close().await.unwrap();
        let log = EventLog::open(&path).await.unwrap();
        let commits = log.subscribe_commits();
        assert_eq!(log.append(&outcome).await.unwrap(), sequence);
        assert!(!commits.has_changed().unwrap());
        assert_eq!(
            log.resolve_tool_result("session", &outcome.event().id)
                .await
                .unwrap(),
            output
        );
        assert_eq!(
            log.read_artifact_chunk("session", media_id, 0, 32)
                .await
                .unwrap()
                .unwrap()
                .bytes,
            b"\x89PNG\r\n\x1a\n"
        );
        assert!(
            log.resolve_tool_result("foreign", &outcome.event().id)
                .await
                .is_err()
        );
        let changed = EventWrite::tool_success(
            outcome.event().id.clone(),
            outcome.event().recorded_at,
            invocation(),
            "image".into(),
            ToolSuccess::image(b"changed!".to_vec(), "image/png".into()).unwrap(),
        )
        .unwrap()
        .0;
        assert!(log.append(&changed).await.is_err());
        let mut foreign = invocation();
        foreign.session_id = "foreign".into();
        let conflict = EventWrite::tool_success(
            outcome.event().id.clone(),
            outcome.event().recorded_at,
            foreign,
            "image".into(),
            output.clone().into(),
        )
        .unwrap()
        .0;
        assert!(log.append(&conflict).await.is_err());
        assert!(log.append(&success("new", &output)).await.is_err());
        // Missing media cannot be repaired by declaring an exact event replay successful.
        inspect
            .execute("DELETE FROM artifacts WHERE id = ?", [media_id])
            .unwrap();
        assert!(log.append(&outcome).await.is_err());
        log.close().await.unwrap();
    }
}

#[tokio::test]
async fn session_binding_missing_payload_and_corrupt_raw_fail_closed() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = open(&path).await;
    let outcome = success("raw", &json!({"answer":42}).into());
    log.append_batch(&[dispatch("raw"), outcome.clone()])
        .await
        .unwrap();
    assert!(
        log.resolve_tool_result("other", &outcome.event().id)
            .await
            .is_err()
    );
    let inspect = rusqlite::Connection::open(&path).unwrap();
    let original = outcome.raw_payload().unwrap();
    let mut corrupt = original.to_vec();
    let index = corrupt.iter().position(|b| *b == b'4').unwrap();
    corrupt[index] = b'5';
    inspect
        .execute(
            "UPDATE tool_result_payloads SET payload = ? WHERE event_id = ?",
            rusqlite::params![corrupt, outcome.event().id],
        )
        .unwrap();
    // Prefix checks physical binding; selected hydration verifies content hashes.
    assert!(log.prefix(10, 8192).await.is_ok());
    assert!(
        log.resolve_tool_result("session", &outcome.event().id)
            .await
            .is_err()
    );
    assert!(log.append(&outcome).await.is_err());
    inspect
        .execute(
            "UPDATE tool_result_payloads SET payload = x'00' WHERE event_id = ?",
            [&outcome.event().id],
        )
        .unwrap();
    assert!(log.prefix(10, 8192).await.is_err());
    assert!(
        log.resolve_tool_result("session", &outcome.event().id)
            .await
            .is_err()
    );
    inspect
        .execute(
            "DELETE FROM tool_result_payloads WHERE event_id = ?",
            [&outcome.event().id],
        )
        .unwrap();
    assert!(log.prefix(10, 8192).await.is_err());
    assert!(
        log.invocation_recovery(&invocation(), 10, 8192)
            .await
            .is_err()
    );
    // Damaged payload authority stays local. Another Session can append and
    // inspect its own recovery scope without hydrating the broken history.
    let other = Invocation {
        session_id: "other".into(),
        turn_id: "other".into(),
        run_id: "other".into(),
        invocation_id: "other".into(),
    };
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            other.clone(),
            Fact::InvocationOpened {
                configuration: None,
                input: maka_runtime::input::InvocationInput::Code {
                    source: "independent".into(),
                },
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
    assert!(
        log.invocation_recovery(&other, 1, 1024)
            .await
            .unwrap()
            .uncertain_operations
            .is_empty()
    );
    assert!(
        log.resolve_tool_result("session", &outcome.event().id)
            .await
            .is_err()
    );
    assert!(log.append(&outcome).await.is_err());
    log.close().await.unwrap();
}
