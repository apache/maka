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

use maka_event_log::{EventLog, StoreError};
use serde_json::json;

#[tokio::test]
async fn execution_receipts_commit_with_work_and_survive_delivery_restarts_and_lost_replies() {
    use futures_util::FutureExt;
    use maka_agent_facts::event::EventWrite;
    use maka_agent_facts::event::Fact;
    use maka_agent_facts::event::InvocationInput;
    use maka_agent_facts::event::InvocationOutcome;
    use maka_agent_facts::event::RuntimeEvent;
    use maka_agent_ports::execution::Submit;
    use maka_capabilities::storage::Namespace;
    use maka_plugin_core::scope::Scope;

    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("receipts.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    let namespace = Namespace::new("graph", Scope::Profile).unwrap();
    let request = Submit {
        orchestration_mode: None,
        operation_id: "graph-1:node-a:attempt-1".into(),
        session_id: "session".into(),
        content: "Implement the node".into(),
    };
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TRIGGER reject_receipt BEFORE INSERT ON plugin_execution_receipts
         BEGIN SELECT RAISE(ABORT, 'receipt fault'); END;",
    )
    .unwrap();
    assert!(
        log.admit_plugin_execution(&namespace, request.clone(), pending(&request))
            .await
            .is_err()
    );
    assert!(log.pending_messages("session").await.unwrap().is_empty());
    assert!(
        log.plugin_execution_receipt(&namespace, &request.operation())
            .await
            .unwrap()
            .is_none()
    );
    db.execute_batch("DROP TRIGGER reject_receipt").unwrap();

    // Lose the receipt waiter after the SQL owner has accepted the command.
    assert!(
        log.admit_plugin_execution(&namespace, request.clone(), pending(&request))
            .now_or_never()
            .is_none()
    );
    let receipt = log
        .admit_plugin_execution(&namespace, request.clone(), pending(&request))
        .await
        .unwrap();
    assert_eq!(log.pending_messages("session").await.unwrap().len(), 1);
    let admission = log.pending_messages("session").await.unwrap().remove(0);
    assert_eq!(admission.invocation, receipt.invocation);
    let writes = [
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: admission.source.message.content.clone(),
                request_fingerprint: None,
                source_messages: vec![admission.source],
            },
        },
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ]
    .into_iter()
    .map(|fact| EventWrite::plain(RuntimeEvent::new(receipt.invocation.clone(), fact)).unwrap())
    .collect::<Vec<_>>();
    log.append_batch(&writes[..1]).await.unwrap();
    use maka_agent_facts::interaction::InteractionOutcome;
    use maka_agent_facts::interaction::InteractionQuestion;
    use maka_agent_facts::interaction::InteractionRecord;
    use maka_agent_facts::interaction::InteractionRequest;
    use maka_agent_facts::interaction::QuestionOption;
    let mut question = InteractionRecord {
        session_id: receipt.invocation.session_id.clone(),
        turn_id: receipt.invocation.turn_id.clone(),
        run_id: receipt.invocation.run_id.clone(),
        request_id: "question-one".into(),
        created_at: 1,
        request: InteractionRequest::Question {
            tool_use_id: "question-tool".into(),
            questions: vec![InteractionQuestion {
                question: "Continue?".into(),
                options: vec![
                    QuestionOption {
                        label: "Yes".into(),
                        description: None,
                    },
                    QuestionOption {
                        label: "No".into(),
                        description: None,
                    },
                ],
            }],
        },
        outcome: None,
    };
    log.establish_interaction(&question).await.unwrap();
    let first = log
        .plugin_execution_progress(&namespace, &request.operation())
        .await
        .unwrap()
        .unwrap();
    assert!(first.attention_id.is_some());
    log.create_session("unrelated", "create-unrelated", &json!({}), 2)
        .await
        .unwrap();
    assert_eq!(
        first.attention_id,
        log.plugin_execution_progress(&namespace, &request.operation())
            .await
            .unwrap()
            .unwrap()
            .attention_id
    );
    log.commit_interaction_outcome(
        &question.request_id,
        InteractionOutcome::QuestionAnswer {
            answers: vec![Some("Yes".into())],
            committed_at: 3,
        },
    )
    .await
    .unwrap();
    assert!(
        log.plugin_execution_progress(&namespace, &request.operation())
            .await
            .unwrap()
            .unwrap()
            .attention_id
            .is_none()
    );
    question.request_id = "question-two".into();
    question.created_at = 4;
    log.establish_interaction(&question).await.unwrap();
    let second = log
        .plugin_execution_progress(&namespace, &request.operation())
        .await
        .unwrap()
        .unwrap();
    assert!(second.attention_id.is_some());
    assert_ne!(first.attention_id, second.attention_id);
    log.commit_interaction_outcome(
        &question.request_id,
        InteractionOutcome::QuestionAnswer {
            answers: vec![Some("Yes".into())],
            committed_at: 5,
        },
    )
    .await
    .unwrap();
    log.append_batch(&writes[1..]).await.unwrap();
    assert!(log.pending_messages("session").await.unwrap().is_empty());
    log.close().await.unwrap();

    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.admit_plugin_execution(&namespace, request.clone(), pending(&request))
            .await
            .unwrap(),
        receipt
    );
    assert!(log.pending_messages("session").await.unwrap().is_empty());
    let mut changed = request.clone();
    changed.orchestration_mode =
        Some(maka_agent_facts::execution::BehaviorId::try_from("swarm".to_owned()).unwrap());
    assert!(matches!(
        log.admit_plugin_execution(&namespace, changed.clone(), pending(&changed))
            .await,
        Err(StoreError::EventConflict)
    ));
    let mut changed = request.clone();
    changed.content = "Different work".into();
    assert!(matches!(
        log.admit_plugin_execution(&namespace, changed.clone(), pending(&changed))
            .await,
        Err(StoreError::EventConflict)
    ));
    let separate = Namespace::new("schedule", Scope::Profile).unwrap();
    let other = log
        .admit_plugin_execution(&separate, request.clone(), pending(&request))
        .await
        .unwrap();
    assert_ne!(other.invocation, receipt.invocation);
    log.close().await.unwrap();
}

fn pending(
    request: &maka_agent_ports::execution::Submit,
) -> maka_event_log::message_admissions::PendingMessageAdmission {
    use maka_agent_facts::event::Invocation;
    use maka_agent_facts::input::DeliveredMessage;
    use maka_agent_facts::message::*;
    let mode = request.orchestration_mode.clone();
    maka_event_log::message_admissions::PendingMessageAdmission {
        execution: maka_event_log::message_admissions::PendingExecution {
            owner: "maka-runtime-host".into(),
            basis: serde_json::Value::Null,
        },
        invocation: Invocation {
            session_id: request.session_id.clone(),
            turn_id: uuid::Uuid::new_v4().to_string(),
            run_id: uuid::Uuid::new_v4().to_string(),
            invocation_id: uuid::Uuid::new_v4().to_string(),
        },
        steering_invocation: None,
        source: RootSourceMessage {
            unprepared_content: request.content.clone(),
            message: DeliveredMessage {
                origin: None,
                message_id: uuid::Uuid::new_v4().to_string(),
                submitted_content_digest: request.content.content_digest().unwrap(),
                content: request.content.clone(),
            },
            submitted_placement: if mode.is_some() {
                Placement::CurrentTurn
            } else {
                Placement::NextTurn
            },
            disposition: MessageDisposition::TurnStarted,
            submitted_intent: mode.map(|mode| SubmittedTurnIntent {
                input_selections: Default::default(),
                input_selection_sources: Default::default(),
                turn_orchestration: Some(TurnOrchestration {
                    mode,
                    source: TurnOrchestrationSource::HostApi,
                }),
            }),
        },
        required_tools: Default::default(),
        admitted_at: 1,
    }
}

#[tokio::test]
async fn data_batches_are_namespaced_atomic_and_preserve_tombstone_revisions() {
    use maka_capabilities::storage::Data;
    use maka_capabilities::storage::Mutation;
    use maka_capabilities::storage::Namespace;
    use maka_capabilities::storage::Scan;
    use maka_plugin_core::scope::Scope;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("data.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let namespace = Namespace::new("graph", Scope::Profile).unwrap();
    let mutation = |key: &str, revision, data| Mutation {
        key: key.into(),
        expected_revision: revision,
        data,
    };
    log.plugin_data_batch(
        &namespace,
        vec![mutation("state", None, Data::Present(json!(null)))],
    )
    .await
    .unwrap();
    let stored = log.plugin_data(&namespace, "state").await.unwrap().unwrap();
    assert_eq!(stored.revision, 1);
    assert_eq!(stored.data, Data::Present(json!(null)));
    let rejected = log
        .plugin_data_batch(
            &namespace,
            vec![
                mutation("new", None, Data::Present(json!(1))),
                mutation("state", None, Data::Deleted),
            ],
        )
        .await;
    assert!(matches!(rejected, Err(StoreError::RevisionConflict { .. })));
    assert!(log.plugin_data(&namespace, "new").await.unwrap().is_none());
    log.plugin_data_batch(&namespace, vec![mutation("state", Some(1), Data::Deleted)])
        .await
        .unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let deleted = log.plugin_data(&namespace, "state").await.unwrap().unwrap();
    assert_eq!(deleted.revision, 2);
    assert_eq!(deleted.data, Data::Deleted);
    let page = log
        .plugin_data_scan(&namespace, Scan::default())
        .await
        .unwrap();
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].record, deleted);
    assert!(page.next_after.is_none());
    assert!(
        log.plugin_data_batch(
            &namespace,
            vec![mutation("state", None, Data::Present(json!(2)))]
        )
        .await
        .is_err()
    );
    let separate = Namespace::new("graph", Scope::Session("other".into())).unwrap();
    assert!(log.plugin_data(&separate, "state").await.unwrap().is_none());
    assert!(
        log.plugin_data_scan(&separate, Scan::default())
            .await
            .unwrap()
            .entries
            .is_empty()
    );
    let mut records = (0..66)
        .map(|n| mutation(&format!("r%_/{n:03}"), None, Data::Present(json!(n))))
        .collect::<Vec<_>>();
    records.push(mutation(
        "rax/not-selected",
        None,
        Data::Present(json!(false)),
    ));
    log.plugin_data_batch(&namespace, records).await.unwrap();
    let page = log
        .plugin_data_scan(
            &namespace,
            Scan {
                prefix: "r%_/".into(),
                after: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(page.entries.len(), 64);
    assert_eq!(page.next_after.as_deref(), Some("r%_/063"));
    let tail = log
        .plugin_data_scan(
            &namespace,
            Scan {
                prefix: "r%_/".into(),
                after: page.next_after,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        tail.entries
            .iter()
            .map(|entry| entry.key.as_str())
            .collect::<Vec<_>>(),
        ["r%_/064", "r%_/065"]
    );
    assert!(tail.next_after.is_none());
    log.plugin_data_batch(
        &namespace,
        (0..3)
            .map(|n| {
                mutation(
                    &format!("large/{n}"),
                    None,
                    Data::Present(json!("x".repeat(900_000))),
                )
            })
            .collect(),
    )
    .await
    .unwrap();
    let page = log
        .plugin_data_scan(
            &namespace,
            Scan {
                prefix: "large/".into(),
                after: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        page.entries.len(),
        2,
        "byte budget also bounds decoded rows"
    );
    assert_eq!(page.next_after.as_deref(), Some("large/1"));
    let tail = log
        .plugin_data_scan(
            &namespace,
            Scan {
                prefix: "large/".into(),
                after: page.next_after,
            },
        )
        .await
        .unwrap();
    assert_eq!(tail.entries.len(), 1);
    assert!(
        matches!(&tail.entries[0].record.data, Data::Present(value) if value.as_str().unwrap().len() == 900_000)
    );
    assert!(tail.next_after.is_none());
    log.plugin_data_batch(
        &namespace,
        vec![mutation("state", Some(2), Data::Present(json!(3)))],
    )
    .await
    .unwrap();
    log.close().await.unwrap();
}

mod session_receipts;
