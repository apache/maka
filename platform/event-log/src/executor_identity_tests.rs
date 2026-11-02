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

//! Canonical executor result identities cannot alias accepted client messages.

use maka_agent_facts::{
    event::{
        CommitError, EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent,
    },
    execution::{BehaviorId, CollaborationMode, InvocationConfiguration, SandboxMode, ToolMode},
    executor::{Binding, Output},
    input::DeliveredMessage,
    message::{MessageDisposition, Placement, RootSourceMessage},
};
use maka_event_log::{
    EventLog, StoreError,
    message_admissions::{MessageSubmitReceipt, PendingExecution, PendingMessageAdmission},
};
use rusqlite::Connection;
use serde_json::{Value, json};

const CONFLICT: &str = "message identity collides with a canonical visible identity";

fn invocation(name: &str) -> Invocation {
    Invocation {
        session_id: "session".into(),
        turn_id: format!("turn-{name}"),
        run_id: format!("run-{name}"),
        invocation_id: format!("invocation-{name}"),
    }
}
fn write(invocation: &Invocation, fact: Fact) -> EventWrite {
    EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap()
}
fn opening(cwd: &std::path::Path, external: bool) -> Fact {
    Fact::InvocationOpened {
        input: InvocationInput::Message {
            content: "executor identity repro".into(),
            source_messages: vec![],
            request_fingerprint: None,
        },
        configuration: external.then(|| {
            Box::new(InvocationConfiguration {
                language: maka_agent_facts::language::Language::En,
                compaction_prompt: None,
                workspace_origin: maka_agent_facts::execution::WorkspaceOrigin::Selected,
                approval_policy: maka_agent_facts::execution::ApprovalPolicy::OnRequest,
                boundary_revision: 0,
                cwd: cwd.to_string_lossy().into_owned(),
                workspace_binding: None,
                workspace_identity: None,
                model: None,
                editing_tools: None,
                tool_discovery: false,
                tool_composition: None,
                system_prompt: None,
                thinking_level: None,
                sandbox_mode: SandboxMode::WorkspaceWrite,
                collaboration_mode: CollaborationMode::Agent,
                orchestration_mode: BehaviorId::default(),
                tool_mode: ToolMode::Direct,
                code_language: Default::default(),
            })
        }),
    }
}
fn claim(invocation: &Invocation, message_id: &str) -> EventWrite {
    write(invocation, {
        let message = DeliveredMessage {
            message_id: message_id.into(),
            content: "legal client claim".into(),
            submitted_content_digest: format!("sha256:{}", "a".repeat(64)),
            origin: None,
        };
        let mut unprepared_content = message.content.clone();
        unprepared_content.preparation.clear();
        Fact::MessageSteered {
            source: Box::new(maka_agent_facts::message::RootSourceMessage {
                message: message.clone(),
                unprepared_content,
                submitted_placement: maka_agent_facts::message::Placement::CurrentTurn,
                disposition: maka_agent_facts::message::MessageDisposition::Steering,
                submitted_intent: None,
            }),
            message: Box::new(message),
        }
    })
}
fn events(db: &Connection) -> Vec<(i64, Vec<u8>)> {
    db.prepare("SELECT sequence,CAST(event_header AS BLOB) FROM event_log ORDER BY sequence")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}
fn raw(db: &Connection) -> Vec<(String, Vec<u8>)> {
    db.prepare("SELECT event_id,payload FROM tool_result_payloads ORDER BY event_id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}
fn cached_rows(db: &Connection) -> Vec<(i64, i64, String, Vec<u8>)> {
    db.prepare("SELECT source_sequence,item_index,message_id,payload FROM temp.transcript_rows WHERE session_id='session' ORDER BY source_sequence,item_index")
        .unwrap().query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .unwrap().collect::<Result<_, _>>().unwrap()
}

fn closing(invocation: &Invocation) -> EventWrite {
    write(
        invocation,
        Fact::ExecutorCompleted {
            text: "final executor answer".into(),
        },
    )
}
async fn start_executor(
    log: &EventLog,
    cwd: &std::path::Path,
    owner: &Invocation,
    calls: &[&str],
    settled: &[&str],
) {
    log.append(&write(owner, opening(cwd, true))).await.unwrap();
    log.append(&write(
        owner,
        Fact::ExecutorStarted {
            settings: Default::default(),
            binding: Binding {
                executor_id: "example".to_owned().try_into().unwrap(),
                package_id: "example".into(),
                entry_id: "example".into(),
                activation: "activation".into(),
            },
        },
    ))
    .await
    .unwrap();
    log.append(&write(
        owner,
        Fact::ExecutorObserved {
            output: Output::OutputDelta {
                text: "partial executor answer".into(),
            },
        },
    ))
    .await
    .unwrap();
    for id in calls {
        log.append(&write(
            owner,
            Fact::ExecutorObserved {
                output: Output::ToolStart {
                    tool_call_id: (*id).into(),
                    name: "shell".into(),
                    input: json!({"command":"external observation"}),
                },
            },
        ))
        .await
        .unwrap();
    }
    for id in settled {
        log.append(&write(
            owner,
            Fact::ExecutorObserved {
                output: Output::ToolResult {
                    tool_call_id: (*id).into(),
                    text: "real external result".into(),
                    is_error: false,
                },
            },
        ))
        .await
        .unwrap();
    }
}
async fn finish_invocation(log: &EventLog, owner: &Invocation) -> u64 {
    log.append(&write(
        owner,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ))
    .await
    .unwrap()
}
async fn queued(
    log: &EventLog,
    owner: &Invocation,
    id: &str,
) -> (EventWrite, MessageSubmitReceipt) {
    let message = DeliveredMessage {
        message_id: id.into(),
        content: "queued client message".into(),
        submitted_content_digest: format!("sha256:{}", "a".repeat(64)),
        origin: None,
    };
    let source = RootSourceMessage {
        unprepared_content: message.content.clone(),
        message,
        submitted_placement: Placement::CurrentTurn,
        disposition: MessageDisposition::Steering,
        submitted_intent: None,
    };
    let admission = PendingMessageAdmission {
        execution: PendingExecution {
            owner: "maka-runtime-host".into(),
            basis: Value::Null,
        },
        invocation: owner.clone(),
        steering_invocation: None,
        source: source.clone(),
        required_tools: Default::default(),
        admitted_at: 1,
    };
    let revision = log.message_queue(&owner.session_id).await.unwrap().revision;
    let receipt = log
        .admit_queued_message("epoch", revision, admission)
        .await
        .unwrap();
    (
        write(
            owner,
            Fact::MessageSteered {
                message: Box::new(source.message.clone()),
                source: Box::new(source),
            },
        ),
        receipt,
    )
}
#[derive(Debug, PartialEq, Eq)]
struct Snapshot {
    events: Vec<(i64, Vec<u8>)>,
    raw: Vec<(String, Vec<u8>)>,
    receipts: Vec<(String, String, String, Vec<u8>)>,
    pending: Vec<(String, Vec<u8>)>,
    queue: Vec<(String, i64)>,
    rows: Vec<(i64, i64, String, Vec<u8>)>,
}
fn snapshot(db: &Connection) -> Snapshot {
    Snapshot {
        events: events(db), raw: raw(db), rows: cached_rows(db),
        receipts: db.prepare("SELECT host_epoch,session_id,message_id,CAST(receipt_json AS BLOB) FROM message_submit_receipts ORDER BY host_epoch,session_id,message_id").unwrap()
            .query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap().collect::<Result<_,_>>().unwrap(),
        pending: db.prepare("SELECT message_id,CAST(record_json AS BLOB) FROM message_admissions ORDER BY session_id,message_id").unwrap()
            .query_map([], |r| Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<Result<_,_>>().unwrap(),
        queue: db.prepare("SELECT session_id,revision FROM message_queue_state ORDER BY session_id").unwrap()
            .query_map([], |r| Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<Result<_,_>>().unwrap(),
    }
}
fn rejected(error: CommitError) {
    assert!(
        matches!(error, CommitError::Rejected(ref reason) if reason == &format!("invalid event transition: {CONFLICT}")),
        "unexpected rejection: {error}"
    );
}
fn preflight_rejected(error: StoreError) {
    assert!(
        matches!(error, StoreError::InvalidTransition(ref reason) if reason == CONFLICT),
        "unexpected preflight error: {error}"
    );
}
async fn materialize_all(log: &EventLog, through: u64) {
    crate::transcript_cache::materialize_all_rows(log, "session", through)
        .await
        .unwrap();
}

#[tokio::test]
async fn executor_tool_call_identity_is_atomic_session_scoped_and_reopens() {
    for source_first in [true, false] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("tool-identity.sqlite");
        let log = EventLog::open(&path).await.unwrap();
        log.create_session("session", "create", &json!({}), 1)
            .await
            .unwrap();
        let db = Connection::open(&path).unwrap();
        let executor = invocation("executor");
        let client = invocation("client");
        let id = maka_agent_facts::tool_call::tool_use_id(&executor.invocation_id, "pending-call");
        let (target, prefix, receipt_id, receipt, legitimate) = if source_first {
            log.append(&write(&client, opening(temp.path(), false)))
                .await
                .unwrap();
            let (delivery, receipt) = queued(&log, &client, &id).await;
            log.append(&delivery).await.unwrap();
            finish_invocation(&log, &client).await;
            start_executor(&log, temp.path(), &executor, &[], &[]).await;
            (
                write(
                    &executor,
                    Fact::ExecutorObserved {
                        output: Output::ToolStart {
                            tool_call_id: "pending-call".into(),
                            name: "shell".into(),
                            input: json!({"command":"external observation"}),
                        },
                    },
                ),
                write(
                    &executor,
                    Fact::ExecutorObserved {
                        output: Output::OutputDelta {
                            text: "must roll back".into(),
                        },
                    },
                ),
                id.clone(),
                receipt,
                None,
            )
        } else {
            start_executor(
                &log,
                temp.path(),
                &executor,
                &["pending-call"],
                &["pending-call"],
            )
            .await;
            log.append(&closing(&executor)).await.unwrap();
            finish_invocation(&log, &executor).await;
            log.append(&write(&client, opening(temp.path(), false)))
                .await
                .unwrap();
            let (legitimate, receipt) = queued(&log, &client, "receipt-control").await;
            (
                claim(&client, &id),
                legitimate.clone(),
                "receipt-control".into(),
                receipt,
                Some(legitimate),
            )
        };
        log.close().await.unwrap();
        let log = EventLog::open(&path).await.unwrap();
        assert!(
            crate::test_store::inspect_cache(&log, cached_rows)
                .await
                .is_empty()
        );
        let before = crate::test_store::inspect_cache(&log, snapshot).await;
        assert_eq!(before.receipts.len(), 1);
        if !source_first {
            preflight_rejected(
                log.validate_message_identity("session", &id)
                    .await
                    .unwrap_err(),
            );
            assert_eq!(before.pending.len(), 1);
        }
        rejected(
            log.append_batch(&[prefix, target.clone()])
                .await
                .unwrap_err(),
        );
        assert_eq!(
            crate::test_store::inspect_cache(&log, snapshot).await,
            before
        );
        rejected(log.append(&target).await.unwrap_err());
        assert_eq!(
            crate::test_store::inspect_cache(&log, snapshot).await,
            before
        );
        assert_eq!(
            log.message_submit_receipt("epoch", "session", &receipt_id)
                .await
                .unwrap(),
            Some(receipt)
        );
        let active = if let Some(legitimate) = legitimate {
            let sequence = log.append(&legitimate).await.unwrap();
            assert_eq!(log.append(&legitimate).await.unwrap(), sequence);
            client
        } else {
            for output in [
                Output::ToolStart {
                    tool_call_id: "safe-call".into(),
                    name: "shell".into(),
                    input: json!({}),
                },
                Output::ToolResult {
                    tool_call_id: "safe-call".into(),
                    text: "safe result".into(),
                    is_error: false,
                },
            ] {
                log.append(&write(&executor, Fact::ExecutorObserved { output }))
                    .await
                    .unwrap();
            }
            log.append(&closing(&executor)).await.unwrap();
            finish_invocation(&log, &executor).await;
            let tail = invocation("tail");
            log.append(&write(&tail, opening(temp.path(), false)))
                .await
                .unwrap();
            tail
        };
        // Neither a never-used generated hash nor an arbitrary legal tool_
        // spelling reserves a prefix; opening rows have NULL operation IDs.
        let unused = maka_agent_facts::tool_call::tool_use_id("unused-executor", "unused-call");
        let mut through = 0;
        for available in [unused.as_str(), "tool_not_a_generated_hash"] {
            log.validate_message_identity("session", available)
                .await
                .unwrap();
            through = log.append(&claim(&active, available)).await.unwrap();
        }
        materialize_all(&log, through).await;
        log.create_session("other", "other-create", &json!({}), 1)
            .await
            .unwrap();
        let mut other = invocation("other");
        other.session_id = "other".into();
        log.append(&write(&other, opening(temp.path(), false)))
            .await
            .unwrap();
        log.validate_message_identity("other", &id).await.unwrap();
        log.append(&claim(&other, &id)).await.unwrap();
        let committed = events(&db);
        log.close().await.unwrap();
        let log = EventLog::open(&path).await.unwrap();
        materialize_all(&log, through).await;
        assert_eq!(events(&db), committed);
        log.close().await.unwrap();
    }
}
