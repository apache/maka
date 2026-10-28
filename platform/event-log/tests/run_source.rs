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

use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::input::InvocationInput;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_event_log::{EventLog, StoreError};

fn opening(session: &str, run: &str, invocation: &str, text: &str) -> RuntimeEvent {
    RuntimeEvent::new(
        Invocation {
            session_id: session.into(),
            turn_id: "logical-turn".into(),
            run_id: run.into(),
            invocation_id: invocation.into(),
        },
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: text.into(),
                request_fingerprint: None,
                source_messages: Vec::new(),
            },
        },
    )
}

async fn append(log: &EventLog, event: RuntimeEvent) {
    log.append(&EventWrite::plain(event).unwrap())
        .await
        .unwrap();
}

#[tokio::test]
async fn exact_run_cuts_bind_identity_and_bytes_without_admitting_unproven_replay() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let first = opening("session", "source", "source-invocation", "中文 source");
    let first_json = serde_json::to_string(&first).unwrap();
    append(&log, first.clone()).await;
    let before = log
        .run_source("session", "source", None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(before.boundary.invocation, first.invocation);
    assert_eq!(before.boundary.high_water, 1);
    assert_eq!(before.opening.sequence, 1);
    assert_eq!(before.opening.event, first);
    assert_eq!(before.last.sequence, 1);
    assert_eq!(before.last.event, first);
    assert_eq!(
        before.boundary.digest,
        reference_digest(&first.invocation, &[(1, &first_json)])
    );
    // The same Run name in another Session cannot enter this source or its evidence.
    append(
        &log,
        opening("other", "source", "unrelated", &"x".repeat(16_384)),
    )
    .await;
    append(
        &log,
        RuntimeEvent::new(
            first.invocation.clone(),
            Fact::ToolDispatched {
                presentation: None,
                title: None,
                operation_id: "unsettled".into(),
                call: ToolCallIdentity::standalone("call".into()),
                name: "write".into(),
                input: serde_json::json!({}),
            },
        ),
    )
    .await;
    let active = log
        .run_source("session", "source", None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        active.boundary.high_water, 2,
        "Run ordinal, not root ledger position"
    );
    assert_eq!([active.opening.sequence, active.last.sequence], [1, 3]);
    assert_ne!(before.boundary.digest, active.boundary.digest);
    let last_json = serde_json::to_string(&active.last.event).unwrap();
    assert_eq!(
        active.boundary.digest,
        reference_digest(&first.invocation, &[(1, &first_json), (3, &last_json)])
    );
    // Reading immutable evidence does not erase an unresolved effect or declare it safe.
    assert!(matches!(
        active.last.event.fact,
        Fact::ToolDispatched { .. }
    ));

    append(
        &log,
        RuntimeEvent::new(
            first.invocation.clone(),
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Failed {
                    model_failure: None,
                    class: "outcome_unknown".into(),
                    message: None,
                },
            },
        ),
    )
    .await;
    append(
        &log,
        opening(
            "session",
            "successor",
            "successor-invocation",
            "later branch",
        ),
    )
    .await;
    let latest = log
        .run_source("session", "source", None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(latest.boundary.high_water, 3);
    assert_eq!(latest.last.sequence, 4);
    let terminal_json = serde_json::to_string(&latest.last.event).unwrap();
    assert_eq!(
        latest.boundary.digest,
        reference_digest(
            &first.invocation,
            &[(1, &first_json), (3, &last_json), (4, &terminal_json)]
        )
    );
    assert_eq!(
        log.turn_boundary("session", "logical-turn")
            .await
            .unwrap()
            .unwrap()
            .invocation
            .run_id,
        "successor"
    );
    assert_eq!(
        log.run_boundary("session", "source")
            .await
            .unwrap()
            .unwrap()
            .invocation,
        first.invocation
    );
    assert!(
        log.run_source("absent", "source", None)
            .await
            .unwrap()
            .is_none()
    );
    for invalid in [0, 4, 9_007_199_254_740_992, u64::MAX] {
        assert!(matches!(
            log.run_source("session", "source", Some(invalid)).await,
            Err(StoreError::InvalidTransition(_))
        ));
    }
    log.close().await.unwrap();

    let log = EventLog::open(&path).await.unwrap();
    let frozen = log
        .run_source("session", "source", Some(2))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frozen.boundary.digest, active.boundary.digest);
    assert_eq!(frozen.boundary.high_water, active.boundary.high_water);
    assert_eq!(frozen.opening.sequence, active.opening.sequence);
    assert_eq!(frozen.opening.event, active.opening.event);
    assert_eq!(frozen.last.sequence, active.last.sequence);
    assert_eq!(frozen.last.event, active.last.event);
    assert_eq!(
        log.run_source("session", "source", Some(1))
            .await
            .unwrap()
            .unwrap()
            .boundary
            .digest,
        before.boundary.digest
    );
    log.close().await.unwrap();

    let log = EventLog::open(&path).await.unwrap();

    // Synthetic/legacy duplicate Run identities must be unreadable, not latest-wins.
    let successor = log
        .run_boundary("session", "successor")
        .await
        .unwrap()
        .unwrap();
    append(
        &log,
        RuntimeEvent::new(
            successor.invocation,
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            },
        ),
    )
    .await;
    append(
        &log,
        opening("session", "source", "ambiguous-invocation", "alias"),
    )
    .await;
    assert!(matches!(
        log.run_boundary("session", "source").await,
        Err(StoreError::InvalidTransition(_))
    ));
    assert!(matches!(
        log.run_source("session", "source", Some(1)).await,
        Err(StoreError::InvalidTransition(_))
    ));
    log.close().await.unwrap();
}

// Independent reference framing: source count is local; positions and JSON bytes are canonical.
fn reference_digest(invocation: &Invocation, rows: &[(u64, &str)]) -> String {
    use sha2::{Digest, Sha256};
    fn framed(domain: &[u8], parts: &[&[u8]]) -> Vec<u8> {
        let mut hash = Sha256::new();
        hash.update(domain);
        for part in parts {
            hash.update((part.len() as u64).to_be_bytes());
            hash.update(part);
        }
        hash.finalize().to_vec()
    }
    let mut root = Sha256::digest(b"maka.source.empty.v1\0").to_vec();
    for (sequence, json) in rows {
        let sequence = sequence.to_be_bytes();
        let leaf = framed(b"maka.source.leaf.v1\0", &[&sequence, json.as_bytes()]);
        root = framed(b"maka.source.chain.v1\0", &[&root, &sequence, &leaf]);
    }
    let mut digest = Sha256::new();
    digest.update(b"maka.run-prefix.v1\0");
    digest.update((rows.len() as u64).to_be_bytes());
    let identity = serde_json::to_vec(invocation).unwrap();
    digest.update((identity.len() as u64).to_be_bytes());
    digest.update(identity);
    digest.update(root);
    format!("sha256:{}", hex::encode(digest.finalize()))
}

#[tokio::test]
async fn cumulative_raw_observation_bytes_do_not_limit_source_evidence() {
    use maka_agent_facts::event::{LogScope, ModelInterruption};
    use maka_agent_facts::model::{ModelEvent, TextKind};
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("large-source.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let first = opening(
        "session",
        "source",
        "source-invocation",
        "small effective input",
    );
    append(&log, first.clone()).await;
    let event = |fact| RuntimeEvent::new(first.invocation.clone(), fact);
    append(
        &log,
        event(Fact::ModelRequested {
            context_breakdown: None,
            item_acceptance: false,
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            context: None,
            checkpoint_event_id: None,
            step_id: "step".into(),
            model_id: "test".into(),
            source_scope: LogScope::Root,
            source_high_water: 0,
            source_digest: "fixture".into(),
            effective_source_digest: None,
            input_digest: "input".into(),
            route_identity: "route".into(),
        }),
    )
    .await;
    append(
        &log,
        event(Fact::ModelObserved {
            step_id: "step".into(),
            event: ModelEvent::PartStarted {
                id: "part".into(),
                text_kind: TextKind::Text,
                provider_options: None,
            },
        }),
    )
    .await;
    let mut raw_observation_bytes = 0;
    for _ in 0..9 {
        let observation = event(Fact::ModelObserved {
            step_id: "step".into(),
            event: ModelEvent::PartDelta {
                id: "part".into(),
                text: "x".into(),
                provider_options: Some(serde_json::json!({"evidence":"p".repeat(1024 * 1024)})),
            },
        });
        raw_observation_bytes += serde_json::to_vec(&observation).unwrap().len();
        append(&log, observation).await;
    }
    append(
        &log,
        event(Fact::ModelInterrupted {
            step_id: "step".into(),
            status: ModelInterruption::Cancelled,
            diagnostic: None,
            model_failure: None,
        }),
    )
    .await;
    let terminal = event(Fact::InvocationEnded {
        outcome: InvocationOutcome::Cancelled {
            source: "runtime_cancellation".into(),
        },
    });
    append(&log, terminal.clone()).await;
    assert!(raw_observation_bytes > 8 * 1024 * 1024);
    assert!(matches!(
        log.prefix(100, 8 * 1024 * 1024).await,
        Err(StoreError::PrefixTooLarge)
    ));
    let source = log
        .run_source("session", "source", None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(source.boundary.high_water, 14);
    assert_eq!((source.opening.sequence, source.last.sequence), (1, 14));
    assert_eq!(source.opening.event, first);
    assert_eq!(source.last.event, terminal);
    let effective = log
        .capture_model_context("session", None, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    let canonical: Vec<_> = effective
        .tail
        .iter()
        .map(|item| match item {
            maka_event_log::context::ContextEvent::Canonical(stored) => &stored.event,
            _ => panic!("interrupted observations must not become effective model items"),
        })
        .collect();
    assert!(serde_json::to_vec(&canonical).unwrap().len() < 4096);
    assert!(canonical.iter().any(|event| event.id == first.id));
    assert!(
        canonical
            .iter()
            .all(|event| !matches!(event.fact, Fact::ModelObserved { .. }))
    );
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let reopened = log
        .run_source("session", "source", None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reopened.boundary, source.boundary);
    assert_eq!(reopened.opening.event, first);
    assert_eq!(reopened.last.event, terminal);
    log.close().await.unwrap();
}

#[tokio::test]
async fn ordinal_fences_stay_indexed_as_a_copied_sessions_run_grows() {
    use maka_agent_facts::{
        event::{LogScope, ModelInterruption},
        model::{ModelEvent, TextKind},
        session::CopyPurpose,
    };
    use maka_event_log::sessions::SessionCopy;

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("ordinal-fences.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("parent", "parent", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let parent = opening("parent", "parent-run", "parent-invocation", "inherited");
    append(&log, parent.clone()).await;
    append(
        &log,
        RuntimeEvent::new(
            parent.invocation,
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            },
        ),
    )
    .await;
    let parent_source = log
        .run_source("parent", "parent-run", Some(2))
        .await
        .unwrap()
        .unwrap();
    let revision = log
        .get_session::<serde_json::Value>("parent")
        .await
        .unwrap()
        .unwrap()
        .revision;
    let copied = log
        .copy_session(
            SessionCopy {
                source_session_id: "parent".into(),
                target_session_id: "branch".into(),
                expected_source_revision: revision,
                purpose: CopyPurpose::Branch {
                    position: maka_agent_facts::session::ForkPosition::End,
                    side_conversation: false,
                },
            },
            &serde_json::json!({}),
            2,
        )
        .await
        .unwrap();
    assert!(matches!(
        copied,
        maka_event_log::sessions::SessionCopyResult::Committed(_)
    ));
    assert!(
        log.run_source("branch", "parent-run", Some(1))
            .await
            .unwrap()
            .is_none()
    );
    let first = opening("branch", "stream", "stream-invocation", "own run");
    let event = |fact| RuntimeEvent::new(first.invocation.clone(), fact);
    append(&log, first.clone()).await;
    append(
        &log,
        event(Fact::ModelRequested {
            context_breakdown: None,
            item_acceptance: false,
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            context: None,
            checkpoint_event_id: None,
            step_id: "step".into(),
            model_id: "test".into(),
            source_scope: LogScope::Root,
            source_high_water: 0,
            source_digest: "fixture".into(),
            effective_source_digest: None,
            input_digest: "input".into(),
            route_identity: "route".into(),
        }),
    )
    .await;
    append(
        &log,
        event(Fact::ModelObserved {
            step_id: "step".into(),
            event: ModelEvent::PartStarted {
                id: "part".into(),
                text_kind: TextKind::Text,
                provider_options: None,
            },
        }),
    )
    .await;
    append(
        &log,
        opening("other", "stream", "other-invocation", "unrelated"),
    )
    .await;

    let mut frozen: Option<maka_event_log::run_source::RunSource> = None;
    let mut lookup_steps = Vec::new();
    let mut lookup_sql = None;
    for batch in 0..32 {
        let writes: Vec<_> = (0..128)
            .map(|_| {
                EventWrite::plain(event(Fact::ModelObserved {
                    step_id: "step".into(),
                    event: ModelEvent::PartDelta {
                        id: "part".into(),
                        text: "x".into(),
                        provider_options: None,
                    },
                }))
                .unwrap()
            })
            .collect();
        let sequences = log.append_batch(&writes).await.unwrap();
        if batch != 0 && batch != 31 {
            continue;
        }
        let warm = log
            .run_source("branch", "stream", Some(100))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(warm.boundary.high_water, 100);
        assert_eq!(warm.boundary.invocation, first.invocation);
        assert!(warm.last.sequence > warm.boundary.high_water);
        if let Some(original) = &frozen {
            assert_eq!(warm.boundary, original.boundary);
            assert_eq!(warm.last.event, original.last.event);
        } else {
            assert_eq!(warm.last.sequence, sequences[96]);
            frozen = Some(warm);
        }
        let before = log.sqlite_resource_stats().await.unwrap();
        let statement = before
            .writer
            .statements
            .iter()
            .find(|statement| {
                statement.sql.as_deref().is_some_and(|sql| {
                    sql.contains("context_source_prefixes") && sql.contains("ordinal=?")
                })
            })
            .expect("actual public Run ordinal lookup is cached");
        let (id, runs, steps) = (statement.statement_id, statement.runs, statement.vm_steps);
        lookup_sql = statement.sql.clone();
        let latest_ordinal = 3 + (batch + 1) * 128;
        let latest = log
            .run_source("branch", "stream", Some(latest_ordinal))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(latest.boundary.high_water, latest_ordinal);
        assert_eq!(latest.last.sequence, *sequences.last().unwrap());
        let after = log.sqlite_resource_stats().await.unwrap();
        let statement = after
            .writer
            .statements
            .iter()
            .find(|statement| statement.statement_id == id)
            .unwrap();
        assert_eq!(statement.runs - runs, 1);
        lookup_steps.push(statement.vm_steps - steps);
    }
    assert!(
        lookup_steps[1] <= 2 * lookup_steps[0],
        "32 times more deltas must not turn an exact ordinal fence into a history scan: {lookup_steps:?}"
    );
    assert!(
        log.run_source("branch", "stream", Some(4100))
            .await
            .is_err()
    );
    append(
        &log,
        event(Fact::ModelInterrupted {
            step_id: "step".into(),
            status: ModelInterruption::Cancelled,
            diagnostic: None,
            model_failure: None,
        }),
    )
    .await;
    append(
        &log,
        event(Fact::InvocationEnded {
            outcome: InvocationOutcome::Cancelled {
                source: "runtime_cancellation".into(),
            },
        }),
    )
    .await;
    log.close().await.unwrap();

    let log = EventLog::open(&path).await.unwrap();
    let reopened = log
        .run_source("branch", "stream", Some(100))
        .await
        .unwrap()
        .unwrap();
    let frozen = frozen.unwrap();
    assert_eq!(reopened.boundary, frozen.boundary);
    assert_eq!(reopened.opening.event, first);
    assert_eq!(reopened.last.event, frozen.last.event);
    assert_eq!(
        log.run_source("parent", "parent-run", Some(2))
            .await
            .unwrap()
            .unwrap()
            .boundary,
        parent_source.boundary
    );
    log.close().await.unwrap();

    let db =
        rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let mut explain = db
        .prepare(&format!("EXPLAIN QUERY PLAN {}", lookup_sql.unwrap()))
        .unwrap();
    let plan: Vec<String> = explain
        .query_map(rusqlite::params!["stream-invocation", 100], |row| {
            row.get(3)
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(
        plan.iter()
            .any(|step| step.contains("SEARCH") && step.contains("context_source_ordinals")),
        "{plan:?}"
    );
}
