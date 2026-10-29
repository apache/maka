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

use crate::context::selection::Selection;
use crate::{EventLog, context};
use maka_agent_facts::{
    context::{CheckpointMode, CompactOutcome, ContextCheckpoint, ModelPurpose, TextSummary},
    event::{EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent},
};
use serde_json::json;
use sqlx::Connection;

fn event(id: &str, fact: Fact) -> EventWrite {
    EventWrite::plain(RuntimeEvent::new(
        Invocation {
            session_id: "session".into(),
            turn_id: id.into(),
            run_id: id.into(),
            invocation_id: id.into(),
        },
        fact,
    ))
    .unwrap()
}

fn model_output(
    invocation: &str,
    step: &str,
    mut value: serde_json::Value,
) -> maka_agent_facts::model::recorded::ModelCompletion {
    use maka_agent_facts::model::{
        ModelPart,
        recorded::{CompletionPart, ModelPartRecord},
    };
    let parts = value["parts"]
        .as_array_mut()
        .unwrap()
        .drain(..)
        .enumerate()
        .map(|(ordinal, value)| {
            let part: ModelPart = serde_json::from_value(value).unwrap();
            let message_id = match &part {
                ModelPart::ToolCall { call } => maka_agent_facts::tool_call::tool_use_id(
                    invocation,
                    &format!("{step}:{}", call.id),
                ),
                _ => uuid::Uuid::now_v7().to_string(),
            };
            CompletionPart::Own(ModelPartRecord {
                ordinal: ordinal as u64,
                message_id,
                started_at: std::time::UNIX_EPOCH,
                provider_part_id: None,
                part: std::sync::Arc::new(part),
            })
        })
        .collect();
    value["parts"] = serde_json::json!([]);
    let mut output: maka_agent_facts::model::recorded::ModelCompletion =
        serde_json::from_value(value).unwrap();
    output.parts = parts;
    output
}

fn output_summary(output: &maka_agent_facts::model::recorded::ModelCompletion) -> TextSummary {
    use maka_agent_facts::model::recorded::CompletionPart;
    TextSummary::from_parts(
        output.finish_reason,
        output.parts.iter().map(|part| match part {
            CompletionPart::Own(record) => record.part.as_ref(),
            CompletionPart::Ref(_) => panic!("summary fixture owns its result"),
        }),
    )
    .unwrap()
}

async fn closed(log: &EventLog, id: &str) -> String {
    let opening = event(
        id,
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: vec![],
                content: "literal original question".into(),
                request_fingerprint: None,
            },
        },
    );
    let original = opening.event().id.clone();
    log.append_batch(&[
        opening,
        event(
            id,
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            },
        ),
    ])
    .await
    .unwrap();
    original
}

async fn prepared_checkpoint(log: &EventLog, id: &str) -> Vec<EventWrite> {
    log.append(&event(
        id,
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::ContextCompact {
                request_fingerprint: id.into(),
            },
        },
    ))
    .await
    .unwrap();
    let source = log
        .capture_compaction_context(
            "session",
            Some(id),
            &CheckpointMode::Standalone,
            100_000,
            64 * 1024 * 1024,
        )
        .await
        .unwrap();
    let previous = source
        .baseline
        .as_ref()
        .map(|baseline| baseline.event_id.clone());
    let output = model_output(
        id,
        id,
        json!({
        "parts":[{"kind":"text","text_kind":"text","text":"literal retained summary"}],
        "finish_reason":"stop","usage":{}}),
    );
    log.append(&event(
        id,
        Fact::ModelRequested {
            context_breakdown: None,
            item_acceptance: false,
            effective_source_digest: Some(source.effective_source_digest),
            purpose: ModelPurpose::Summary,
            context: None,
            step_id: id.into(),
            model_id: "test".into(),
            source_scope: source.source_evidence.scope,
            source_high_water: source.source_evidence.high_water,
            source_digest: source.source_evidence.digest.clone(),
            input_digest: "input".into(),
            route_identity: format!("sha256:{}", "a".repeat(64)),
            checkpoint_event_id: previous.clone(),
        },
    ))
    .await
    .unwrap();
    log.append(&event(
        id,
        Fact::ModelCompleted {
            step_id: id.into(),
            output: output.clone(),
        },
    ))
    .await
    .unwrap();
    let checkpoint = event(
        id,
        Fact::ContextCheckpointRecorded {
            checkpoint: ContextCheckpoint {
                mode: CheckpointMode::Standalone,
                covered_through: source.source_evidence.high_water,
                source_digest: source.source_evidence.digest,
                previous_checkpoint_id: previous,
                summary: output_summary(&output),
                summary_step_id: id.into(),
            },
        },
    );
    let checkpoint_id = checkpoint.event().id.clone();
    vec![
        checkpoint,
        event(
            id,
            Fact::InvocationEnded {
                outcome: InvocationOutcome::ContextCompactFinished {
                    outcome: CompactOutcome::Compacted {
                        checkpoint_id: checkpoint_id.clone(),
                    },
                },
            },
        ),
    ]
}

async fn checkpoint(log: &EventLog, id: &str) -> String {
    let pair = prepared_checkpoint(log, id).await;
    let checkpoint_id = pair[0].event().id.clone();
    log.append_batch(&pair).await.unwrap();
    checkpoint_id
}

async fn setup(path: &std::path::Path) -> (EventLog, String, String) {
    let log = EventLog::open(path).await.unwrap();
    log.create_session("session", "created", &json!({}), 1)
        .await
        .unwrap();
    let opening = closed(&log, "main").await;
    let checkpoint = checkpoint(&log, "summary").await;
    let source = log
        .capture_model_context("session", None, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(
        source.baseline.unwrap().checkpoint.summary.text,
        "literal retained summary"
    );
    (log, opening, checkpoint)
}

#[tokio::test]
async fn opening_only_then_same_invocation_progress_and_cold_reads_keep_exact_history() {
    use maka_agent_facts::{tool_call::ToolCallIdentity, tool_output::ToolSuccess};
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("opt-in.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    let opening = event(
        "active",
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: "literal tool-loop question".into(),
                source_messages: vec![],
                request_fingerprint: None,
            },
        },
    );
    log.append(&opening).await.unwrap();
    let empty = log
        .prepare_prune_candidates("session", Some("active"), 128, 1024 * 1024, None)
        .await
        .unwrap();
    assert!(empty.candidates.is_empty());
    assert!(empty.next.is_none());
    let first = log
        .capture_model_context("session", Some("active"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    assert!(first.baseline.is_none());
    assert_eq!(first.tail.len(), 1);
    let context::ContextEvent::Canonical(actual) = &first.tail[0] else {
        panic!("original opening")
    };
    assert_eq!(actual.event.id, opening.event().id);
    let Fact::InvocationOpened {
        input: InvocationInput::Message { content, .. },
        ..
    } = &actual.event.fact
    else {
        panic!("original message")
    };
    assert_eq!(content.text, "literal tool-loop question");
    let full = log
        .scoped_prefix(Selection::session("session").scope, 100, 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(first.source_evidence.digest, full.digest);
    let mut source = first;
    let mut results = Vec::new();
    for step in ["first-tool", "second-tool"] {
        log.append(&event(
            "active",
            Fact::ModelRequested {
                context_breakdown: None,
                item_acceptance: false,
                purpose: ModelPurpose::Main,
                context: None,
                step_id: step.into(),
                model_id: "test".into(),
                source_scope: source.source_evidence.scope.clone(),
                source_high_water: source.source_evidence.high_water,
                source_digest: source.source_evidence.digest.clone(),
                input_digest: "input".into(),
                route_identity: format!("sha256:{}", "a".repeat(64)),
                checkpoint_event_id: None,
                effective_source_digest: Some(source.effective_source_digest.clone()),
            },
        ))
        .await
        .unwrap();
        let output = model_output(
            "active",
            step,
            json!({"parts":[{"kind":"tool_call","call":{
            "id":step,"name":"Read","input":{"kind":"json","data":{"path":"file"}},"provider_executed":false
        }}],"finish_reason":"tool-calls","usage":{}}),
        );
        log.append(&event(
            "active",
            Fact::ModelCompleted {
                step_id: step.into(),
                output,
            },
        ))
        .await
        .unwrap();
        let operation = format!("{step}:{step}");
        log.append(&event(
            "active",
            Fact::ToolDispatched {
                presentation: None,
                title: None,
                operation_id: operation.clone(),
                call: ToolCallIdentity::provider(step.into(), step.into()),
                name: "Read".into(),
                input: json!({"path":"file"}),
            },
        ))
        .await
        .unwrap();
        let (result, _) = EventWrite::tool_success(
            format!("result-{step}"),
            std::time::SystemTime::now(),
            opening.event().invocation.clone(),
            operation,
            ToolSuccess::from(json!(format!("literal {step} output"))),
        )
        .unwrap();
        log.append(&result).await.unwrap();
        results.push(result.event().id.clone());
        source = log
            .capture_model_context("session", Some("active"), 100_000, 64 * 1024 * 1024)
            .await
            .unwrap();
        assert!(source.baseline.is_none());
        let full = log
            .scoped_prefix(Selection::session("session").scope, 100, 1024 * 1024)
            .await
            .unwrap();
        assert_eq!(source.source_evidence.digest, full.digest);
        assert!(
            source.tail.iter().any(
                |entry| matches!(entry, context::ContextEvent::Canonical(stored)
            if stored.event.id == result.event().id)
            ),
            "real tool result remains visible"
        );
    }
    let page = log
        .prepare_prune_candidates("session", Some("active"), 1, 1024 * 1024, None)
        .await
        .unwrap();
    assert_eq!(page.candidates.len(), 1);
    assert_eq!(page.candidates[0].event_id, results[0]);
    assert_eq!(page.candidates[0].tool_call_id, "first-tool");
    assert_eq!(page.candidates[0].tool_name, "Read");
    assert_eq!(
        page.candidates[0].projection,
        maka_agent_facts::tool_output::DurableToolProjection::Text {
            text: "literal first-tool output".into(),
        }
    );
    let cursor = page.next.unwrap();
    let page = log
        .prepare_prune_candidates("session", Some("active"), 1, 1024 * 1024, Some(&cursor))
        .await
        .unwrap();
    assert_eq!(page.candidates.len(), 1);
    assert_eq!(page.candidates[0].event_id, results[1]);
    assert_eq!(page.candidates[0].tool_call_id, "second-tool");
    assert_eq!(
        page.candidates[0].projection,
        maka_agent_facts::tool_output::DurableToolProjection::Text {
            text: "literal second-tool output".into(),
        }
    );
    assert!(page.next.is_none());
    log.append(&event(
        "active",
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ))
    .await
    .unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let cold = log
        .capture_model_context("session", None, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    assert!(cold.baseline.is_none());
    let warm = log
        .capture_model_context("session", None, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    let full = log
        .scoped_prefix(Selection::session("session").scope, 100, 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(cold.source_evidence.digest, full.digest);
    assert_eq!(warm.source_evidence.digest, full.digest);
    assert_eq!(warm.tail.len(), cold.tail.len());
    log.close().await.unwrap();
}

#[tokio::test]
async fn an_unsealed_checkpoint_cannot_certify_a_later_fact_in_its_own_batch() {
    let directory = tempfile::tempdir().unwrap();
    let (log, _, _) = setup(&directory.path().join("events.sqlite")).await;
    closed(&log, "second-main").await;
    let pair = prepared_checkpoint(&log, "batch-summary").await;
    log.connection.run(|connection| Box::pin(async move {
        // The plain sequence is refused by active-Session admission. These
        // actual metadata triggers exercise the supported trigger boundary:
        // hide that execution origin until the new Main has been appended.
        sqlx::query("CREATE TRIGGER hide_pending_compact AFTER INSERT ON event_log
            WHEN NEW.kind='context_checkpoint_recorded' AND NEW.invocation_id='batch-summary'
            BEGIN INSERT INTO imported_invocations(invocation_id,bundle_digest)
            VALUES('batch-summary','sha256:0000000000000000000000000000000000000000000000000000000000000000'); END")
            .execute(&mut *connection).await?;
        sqlx::query("CREATE TRIGGER restore_pending_compact AFTER INSERT ON event_log
            WHEN NEW.kind='model_requested' AND NEW.invocation_id='batch-main'
            BEGIN DELETE FROM imported_invocations WHERE invocation_id='batch-summary'; END")
            .execute(connection).await?;
        Ok(())
    })).await.unwrap();
    let (batch, full) = log
        .connection
        .run(move |connection| {
            Box::pin(async move {
                let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                let crate::append::AppendResult::Inserted(sequence) =
                    EventLog::append_in_transaction(&mut tx, &pair[0]).await?
                else {
                    panic!("the prepared checkpoint must be new")
                };
                // Obtain the real exact prefix after CP INSERT in this snapshot. The
                // following rollback restores both rowids and trigger side effects.
                let source =
                    context::evidence::selected(&mut tx, &Selection::session("session"), sequence)
                        .await?;
                let opening = event(
                    "batch-main",
                    Fact::InvocationOpened {
                        configuration: None,
                        input: InvocationInput::Message {
                            content: "next input".into(),
                            source_messages: vec![],
                            request_fingerprint: None,
                        },
                    },
                );
                let main = event(
                    "batch-main",
                    Fact::ModelRequested {
                        context_breakdown: None,
                        item_acceptance: false,
                        purpose: ModelPurpose::Main,
                        context: None,
                        step_id: "batch-main-step".into(),
                        model_id: "test".into(),
                        source_scope: source.scope,
                        source_high_water: source.high_water,
                        source_digest: source.digest,
                        input_digest: "input".into(),
                        route_identity: format!("sha256:{}", "a".repeat(64)),
                        checkpoint_event_id: Some(pair[0].event().id.clone()),
                        effective_source_digest: None,
                    },
                );
                let batch = vec![pair[0].clone(), opening, main, pair[1].clone()];
                let mut full = Ok(());
                for write in &batch[1..] {
                    if let Err(error) = EventLog::append_in_transaction(&mut tx, write).await {
                        full = Err(error.to_string());
                        break;
                    }
                }
                if full.is_ok() {
                    full = context::validate_batch(&mut tx, &batch)
                        .await
                        .map_err(|error| error.to_string());
                }
                tx.rollback().await?;
                Ok((batch, full))
            })
        })
        .await
        .unwrap();
    assert!(
        full.as_ref()
            .is_err_and(|reason| reason.contains("missing proof event")),
        "causal replay must require the Compact terminal before Main: {full:?}"
    );
    let ids: Vec<_> = batch.iter().map(|write| write.event().id.clone()).collect();
    let cached = log
        .append_batch(&batch)
        .await
        .map(|_| ())
        .map_err(|error| match error {
            maka_agent_facts::event::CommitError::Rejected(reason) => reason,
            other => other.to_string(),
        });
    let recorded: i64 = log
        .connection
        .run(move |connection| {
            Box::pin(async move {
                Ok(sqlx::query_scalar(
                    "SELECT COUNT(*) FROM event_log WHERE event_id IN (?, ?, ?, ?)",
                )
                .bind(&ids[0])
                .bind(&ids[1])
                .bind(&ids[2])
                .bind(&ids[3])
                .fetch_one(connection)
                .await?)
            })
        })
        .await
        .unwrap();
    assert_eq!(
        cached, full,
        "public cached append persisted {recorded} facts that causal full replay rejects"
    );
    assert_eq!(recorded, 0);
    log.close().await.unwrap();
}
