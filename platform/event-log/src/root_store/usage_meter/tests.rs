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

use maka_agent_facts::context::ModelPurpose;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::RuntimeEvent;
use std::time::{Duration, UNIX_EPOCH};

pub(super) fn event(fact: Fact, micros: u64) -> EventWrite {
    let mut event = RuntimeEvent::new(
        Invocation {
            session_id: "source".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        },
        fact,
    );
    event.recorded_at = UNIX_EPOCH + Duration::from_micros(micros);
    EventWrite::plain(event).unwrap()
}

pub(super) fn request(id: &str, micros: u64) -> EventWrite {
    event(
        Fact::ModelRequested {
            context_breakdown: None,
            item_acceptance: false,
            step_id: id.into(),
            model_id: "model".into(),
            purpose: ModelPurpose::Main,
            source_scope: LogScope::Session {
                id: "source".into(),
            },
            source_high_water: 0,
            source_digest: "fixture".into(),
            input_digest: "frozen-input".into(),
            route_identity: "frozen-route".into(),
            checkpoint_event_id: None,
            context: None,
            effective_source_digest: None,
        },
        micros,
    )
}

use super::*;
use crate::{
    root::{RootNamespaces, RootOwner},
    root_store::SessionStore,
};
use maka_agent_facts::{
    event::{InvocationInput, InvocationOutcome, ModelInterruption},
    model::{ModelEvent, ModelFinishReason, ModelStep},
};
use serde_json::{Value, json};
use sqlx::{Connection, Row};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

async fn root(directory: &std::path::Path) -> RootStore {
    RootStore::open(Arc::new(
        RootOwner::create(&directory.join("root"), &namespaces(directory)).unwrap(),
    ))
    .await
    .unwrap()
}
fn namespaces(directory: &std::path::Path) -> RootNamespaces {
    RootNamespaces {
        ownership: directory.join("owners"),
        control: directory.join("control"),
    }
}
async fn session(root: &RootStore) -> SessionStore {
    let session = root
        .create_session("source", "create", &json!({}), 1)
        .await
        .unwrap();
    session
        .append(&event(
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    content: "test".into(),
                    source_messages: vec![],
                    request_fingerprint: None,
                },
            },
            0,
        ))
        .await
        .unwrap();
    session
}
fn completed(step: &str, input: Option<u64>, output: Option<u64>) -> EventWrite {
    event(
        Fact::ModelCompleted {
            step_id: step.into(),
            output: ModelStep {
                parts: vec![],
                finish_reason: ModelFinishReason::Stop,
                usage: ModelUsage {
                    input_tokens: input,
                    output_tokens: output,
                    ..Default::default()
                },
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        },
        1000,
    )
}
fn observed(step: &str, input: Option<u64>, output: Option<u64>) -> EventWrite {
    event(
        Fact::ModelObserved {
            step_id: step.into(),
            event: ModelEvent::Finished {
                reason: ModelFinishReason::Stop,
                usage: ModelUsage {
                    input_tokens: input,
                    output_tokens: output,
                    ..Default::default()
                },
                provider_options: None,
            },
        },
        500,
    )
}
fn interrupted(step: &str) -> EventWrite {
    event(
        Fact::ModelInterrupted {
            step_id: step.into(),
            status: ModelInterruption::Failed,
            model_failure: None,
            diagnostic: None,
        },
        900,
    )
}
fn totals(input: u64, input_missing: u64, output: u64, output_missing: u64) -> SessionUsageTotals {
    SessionUsageTotals {
        input: Tokens {
            known: input,
            missing: input_missing,
        },
        output: Tokens {
            known: output,
            missing: output_missing,
        },
    }
}
#[tokio::test]
async fn settlements_count_reported_missing_and_terminal_usage_once_across_rollback_retry_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let root = root(directory.path()).await;
    let session = session(&root).await;
    let log = session.owner().unwrap();
    session
        .append_batch(&[
            request("a", 1),
            observed("a", Some(100), Some(20)),
            interrupted("a"),
            request("b", 2),
            interrupted("b"),
            request("c", 3),
        ])
        .await
        .unwrap();
    assert_eq!(
        root.session_usage_totals("source").await.unwrap(),
        totals(100, 1, 20, 1)
    );
    log.connection.run(|db|Box::pin(async move {sqlx::raw_sql("CREATE TRIGGER reject_meter BEFORE UPDATE ON session_usage_totals BEGIN SELECT RAISE(ABORT,'meter write rejected'); END").execute(db).await?;Ok(())})).await.unwrap();
    let completion = completed("c", Some(0), None);
    assert!(session.append(&completion).await.is_err());
    assert_eq!(
        root.session_usage_totals("source").await.unwrap(),
        totals(100, 1, 20, 1)
    );
    log.connection
        .run(|db| {
            Box::pin(async move {
                sqlx::query("DROP TRIGGER reject_meter").execute(db).await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    session.append(&completion).await.unwrap();
    session.append(&completion).await.unwrap();
    session
        .append_batch(&[request("d", 4), observed("d", Some(7), Some(3))])
        .await
        .unwrap();
    assert_eq!(
        root.session_usage_totals("source").await.unwrap(),
        totals(100, 1, 20, 2)
    );
    let terminal = event(
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Cancelled {
                source: "fixture".into(),
            },
        },
        2000,
    );
    session.append(&terminal).await.unwrap();
    session.append(&terminal).await.unwrap();
    assert_eq!(
        root.session_usage_totals("source").await.unwrap(),
        totals(107, 1, 23, 2)
    );
    let pending: i64 = log
        .connection
        .read(|db| {
            Box::pin(async move {
                Ok(
                    sqlx::query_scalar("SELECT count(*) FROM session_usage_pending")
                        .fetch_one(db)
                        .await?,
                )
            })
        })
        .await
        .unwrap();
    assert_eq!(pending, 0);
    drop(log);
    drop(session);
    root.close().await.unwrap();
    let root = RootStore::open(Arc::new(
        RootOwner::open(
            &directory.path().join("root"),
            &namespaces(directory.path()),
        )
        .unwrap(),
    ))
    .await
    .unwrap();
    assert_eq!(
        root.session_usage_totals("source").await.unwrap(),
        totals(107, 1, 23, 2)
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn lifetime_read_and_terminal_pending_lookup_remain_indexed_after_large_history() {
    let directory = tempfile::tempdir().unwrap();
    let root = root(directory.path()).await;
    let session = session(&root).await;
    session
        .append_batch(&[request("a", 1), completed("a", Some(11), Some(13))])
        .await
        .unwrap();
    let log = session.owner().unwrap();
    log.connection.run(|db|Box::pin(async move {
        sqlx::query("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<20000) INSERT INTO event_log(event_id,kind,event_json) SELECT 'large-history-'||x,'unrelated','{}' FROM n").execute(db).await?;Ok(())
    })).await.unwrap();
    log.connection.read(|db|Box::pin(async move {
        let plans=sqlx::query("EXPLAIN QUERY PLAN SELECT input_known,input_missing,output_known,output_missing FROM session_usage_totals WHERE session_id='source'").fetch_all(&mut *db).await?;
        assert!(plans.iter().any(|row|row.get::<String,_>("detail").contains("SEARCH session_usage_totals USING INDEX")));
        let pending=sqlx::query("EXPLAIN QUERY PLAN SELECT operation_id FROM session_usage_pending WHERE invocation_id='invocation' ORDER BY request_id LIMIT 1").fetch_all(&mut *db).await?;
        assert!(pending.iter().any(|row|row.get::<String,_>("detail").contains("session_usage_pending_invocation")));
        let steps=Arc::new(AtomicUsize::new(0));let counter=steps.clone();
        db.lock_handle().await?.set_progress_handler(1,move||{counter.fetch_add(1,Ordering::SeqCst);true});
        assert_eq!(read(db,"source").await?,[11,0,13,0]);
        db.lock_handle().await?.remove_progress_handler();
        assert!(steps.load(Ordering::SeqCst)<100,"meter read scanned history: {} VM steps",steps.load(Ordering::SeqCst));
        Ok(())
    })).await.unwrap();
    assert_eq!(
        root.session_usage_totals("source").await.unwrap(),
        totals(11, 0, 13, 0)
    );
    drop(log);
    root.close().await.unwrap();
}

#[tokio::test]
async fn migration_backfills_once_and_capacity_error_does_not_rollback_canonical_settlement() {
    let directory = tempfile::tempdir().unwrap();
    let root = root(directory.path()).await;
    let session = session(&root).await;
    session
        .append_batch(&[
            request("a", 1),
            completed("a", Some(11), None),
            request("pending", 2),
        ])
        .await
        .unwrap();
    let log = session.owner().unwrap();
    log.connection.run(|db|Box::pin(async move {
        let mut tx=db.begin().await?;
        sqlx::raw_sql("DROP TABLE session_usage_pending; DROP TABLE session_usage_totals; DROP INDEX auxiliary_usage_meter_observation;").execute(&mut *tx).await?;
        sqlx::raw_sql(include_str!("../../../migrations/0049_session_usage_totals.sql")).execute(&mut *tx).await?;
        tx.commit().await?;Ok(())
    })).await.unwrap();
    assert_eq!(
        root.session_usage_totals("source").await.unwrap(),
        totals(11, 0, 0, 1)
    );
    session
        .append(&completed("pending", Some(u64::MAX), Some(3)))
        .await
        .unwrap();
    assert!(root.session_usage_totals("source").await.is_err());
    assert!(session.get::<Value>().await.unwrap().is_some());
    drop(log);
    root.close().await.unwrap();
}

#[tokio::test]
async fn session_auxiliary_counts_once_and_bundle_import_uses_the_same_settlement_meter() {
    use maka_agent_facts::{execution::*, language::Language};
    let directory = tempfile::tempdir().unwrap();
    let root = root(directory.path()).await;
    let session = root
        .create_session("source", "create", &json!({}), 1)
        .await
        .unwrap();
    let configuration = InvocationConfiguration {
        language: Language::En,
        compaction_prompt: None,
        workspace_origin: WorkspaceOrigin::Selected,
        approval_policy: ApprovalPolicy::OnRequest,
        boundary_revision: 0,
        cwd: directory.path().to_string_lossy().into_owned(),
        workspace_binding: None,
        workspace_identity: None,
        model: Some(ModelBinding {
            connection_id: "connection".into(),
            connection_slug: "frozen".into(),
            model: "model".into(),
        }),
        editing_tools: None,
        tool_discovery: false,
        tool_composition: None,
        system_prompt: None,
        thinking_level: None,
        sandbox_mode: SandboxMode::ReadOnly,
        collaboration_mode: CollaborationMode::Agent,
        orchestration_mode: BehaviorId::default(),
        tool_mode: ToolMode::Direct,
        code_language: Default::default(),
    };
    let opening = event(
        Fact::InvocationOpened {
            configuration: Some(Box::new(configuration)),
            input: InvocationInput::Message {
                content: "test".into(),
                source_messages: vec![],
                request_fingerprint: None,
            },
        },
        0,
    );
    session.append(&opening).await.unwrap();
    let source = crate::usage::AuxiliarySource::SessionTitle {
        invocation: opening.event().invocation.clone(),
    };
    let id = session
        .begin_auxiliary_model(source.clone(), Language::En, None)
        .await
        .unwrap();
    session
        .observe_auxiliary_model(
            id,
            ModelUsage {
                input_tokens: Some(5),
                output_tokens: None,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        root.session_usage_totals("source").await.unwrap(),
        totals(0, 0, 0, 0)
    );
    session
        .settle_auxiliary_model(id, crate::usage::Outcome::Error)
        .await
        .unwrap();
    assert!(
        session
            .settle_auxiliary_model(id, crate::usage::Outcome::Success)
            .await
            .is_err()
    );
    assert!(
        session
            .begin_auxiliary_model(source, Language::En, None)
            .await
            .is_err()
    );
    assert_eq!(
        root.session_usage_totals("source").await.unwrap(),
        totals(5, 0, 0, 1)
    );
    root.close().await.unwrap();

    let source = crate::EventLog::open(&directory.path().join("bundle-source.sqlite"))
        .await
        .unwrap();
    source
        .create_session("source", "create", &json!({}), 1)
        .await
        .unwrap();
    source
        .append(&event(
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    content: "test".into(),
                    source_messages: vec![],
                    request_fingerprint: None,
                },
            },
            0,
        ))
        .await
        .unwrap();
    let captured = source
        .capture_model_context("source", Some("invocation"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    source
        .append_batch(&[
            event(
                Fact::ModelRequested {
                    context_breakdown: None,
                    item_acceptance: false,
                    step_id: "imported".into(),
                    model_id: "model".into(),
                    purpose: ModelPurpose::Main,
                    source_scope: captured.source_evidence.scope,
                    source_high_water: captured.source_evidence.high_water,
                    source_digest: captured.source_evidence.digest,
                    input_digest: "fixture".into(),
                    route_identity: format!("sha256:{}", "a".repeat(64)),
                    checkpoint_event_id: captured.baseline.map(|baseline| baseline.event_id),
                    context: None,
                    effective_source_digest: Some(captured.effective_source_digest),
                },
                1,
            ),
            completed("imported", Some(9), None),
            event(
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::Completed,
                },
                2000,
            ),
        ])
        .await
        .unwrap();
    let inventory = source.preview_bundle("source").await.unwrap();
    let (bytes, _) = source
        .export_bundle("source", &inventory.subtree_digest, Vec::new())
        .await
        .unwrap();
    source.close().await.unwrap();
    let destination = tempfile::tempdir().unwrap();
    let target = self::root(destination.path()).await;
    let fingerprint = maka_agent_facts::artifact::content_digest(b"meter-import");
    for _ in 0..2 {
        let staged = crate::bundle::StagedBundle::read(bytes.as_slice())
            .await
            .unwrap();
        target
            .import_bundle(
                staged,
                &fingerprint,
                std::collections::BTreeMap::from([("source".into(), json!({}))]),
            )
            .await
            .unwrap();
        assert_eq!(
            target.session_usage_totals("source").await.unwrap(),
            totals(9, 0, 0, 1)
        );
    }
    target.close().await.unwrap();
}
