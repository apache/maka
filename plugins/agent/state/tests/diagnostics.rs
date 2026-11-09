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

mod support;

use maka_agent_facts::{
    accounting::Outcome,
    diagnostics::{DiagnosticDetail, ExecutionFailureReason, TitleFailureCause},
    durable::*,
    event::ModelInterruption,
    model::{ModelUsage, error::ModelFailureCause},
};
use maka_agent_state::{Change, diagnostics::DiagnosticPage};
use maka_event_log::{
    StoreError,
    writeback::{Notification, Prepared, Statement},
};
use rusqlite::{Connection, params};
use serde_json::json;
use std::io::Write;

const BUDGET: usize = 48 * 1024;

#[tokio::test]
async fn late_title_and_interruption_keep_real_causes_and_frozen_byte_cursors() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let state = support::state(&root);
    let run = support::admit(&state, "session", "original-turn", "question").await;
    let (step, request, contents) = support::request(vec![]);
    let attempt = ModelAttemptId::new();
    support::append(
        &state,
        run,
        vec![
            Fact::StepPrepared {
                step,
                request: request.reference().clone(),
                adjudications: vec![],
            },
            Fact::ModelAttemptPrepared { attempt, step },
            Fact::ModelAttemptAdmitted {
                attempt,
                upstream: json!({"original":true}),
            },
            Fact::ModelInterrupted {
                attempt,
                diagnostic: "TimedOut HTTP 429 PRIVATE_PROVIDER_TEXT".into(),
            },
            Fact::RunTerminated {
                terminal: Terminal::Failed,
                diagnostic: Some("PRIVATE_RUN_TEXT".into()),
            },
        ],
        contents,
    )
    .await;
    let title = Change::new(
        Fact::SessionTitleFailed {
            cause: TitleFailureCause::Model {
                cause: ModelFailureCause::Http { status: 503 },
            },
        },
        UnixMillis(1),
    );
    state
        .observe(run, vec![title.clone()], vec![])
        .await
        .unwrap();
    let diagnostics = state
        .diagnostics(support::owner(), "session".into())
        .unwrap();
    let full = diagnostics.page(None, None, 128, BUDGET).await.unwrap();
    assert_eq!(full.entries.len(), 3);
    assert_eq!(full.entries[0].event_id, title.id);
    assert_eq!(full.entries[0].recorded_at, title.at);
    assert!(
        matches!(&full.entries[0].detail,DiagnosticDetail::SessionTitle{execution,cause:TitleFailureCause::Model{cause:ModelFailureCause::Http{status:503}}}
        if execution.run_id==run && execution.turn_id=="original-turn" && execution.session_id=="session")
    );
    assert!(matches!(
        &full.entries[2].detail,
        DiagnosticDetail::Execution {
            reason: ExecutionFailureReason::ModelInterrupted,
            model_failure: None,
            ..
        }
    ));
    assert!(
        !String::from_utf8(serde_json::to_vec(&full).unwrap())
            .unwrap()
            .contains("PRIVATE_")
    );
    let head = diagnostics.head().await.unwrap();
    assert_eq!(head.through, full.through);
    assert_eq!(head.latest, Some(full.entries[0].sequence));

    let one = DiagnosticPage {
        through: full.through,
        next_before: Some(full.entries[0].sequence),
        entries: vec![full.entries[0].clone()],
    };
    let budget = full
        .entries
        .iter()
        .flat_map(|entry| {
            [None, Some(entry.sequence)].map(|next_before| {
                serde_json::to_vec(&DiagnosticPage {
                    through: full.through,
                    next_before,
                    entries: vec![entry.clone()],
                })
                .unwrap()
                .len()
            })
        })
        .max()
        .unwrap()
        + 16;
    let first = diagnostics.page(None, None, 128, budget).await.unwrap();
    assert_eq!(first.entries, one.entries);
    assert_eq!(first.next_before, Some(first.entries[0].sequence));
    assert!(serde_json::to_vec(&first).unwrap().len() <= budget);
    let later = Change::new(
        Fact::SessionTitleFailed {
            cause: TitleFailureCause::EmptyOutput,
        },
        UnixMillis(0),
    );
    state
        .observe(run, vec![later.clone()], vec![])
        .await
        .unwrap();
    let mut entries = first.entries;
    let mut before = first.next_before;
    while let Some(cursor) = before {
        let page = diagnostics
            .page(Some(full.through), Some(cursor), 128, budget)
            .await
            .unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() <= budget);
        before = page.next_before;
        entries.extend(page.entries);
    }
    assert_eq!(entries, full.entries);
    let latest = diagnostics.page(None, None, 1, BUDGET).await.unwrap();
    assert_eq!(latest.entries[0].event_id, later.id);
    assert!(latest.through > full.through);
    root.close().await.unwrap();
}

#[tokio::test]
async fn closures_use_original_step_and_outcome_without_parsing_private_protocol() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let state = support::state(&root);
    let mut expected = Vec::new();
    for (index, outcome) in [
        Outcome::Error,
        Outcome::Aborted,
        Outcome::Unknown,
        Outcome::Success,
    ]
    .into_iter()
    .enumerate()
    {
        let run = support::admit(&state, "session", &format!("turn-{index}"), "question").await;
        let (step, request, contents) = support::request(vec![]);
        let attempt = ModelAttemptId::new();
        support::append(&state,run,vec![
            Fact::StepPrepared{step,request:request.reference().clone(),adjudications:vec![]},
            Fact::ModelAttemptPrepared{attempt,step},
            Fact::ModelAttemptAdmitted{attempt,upstream:json!({"original":true})},
            Fact::ModelClosed{attempt,outcome,diagnostic:None,usage:ModelUsage::default(),protocol:json!({"private":"PRIVATE_PROTOCOL".repeat(8192),"diagnostic":"TimedOut"})},
        ],contents).await;
        expected.push((run, step, attempt, outcome));
    }
    let diagnostics = state
        .diagnostics(support::owner(), "session".into())
        .unwrap();
    let page = diagnostics.page(None, None, 128, BUDGET).await.unwrap();
    assert_eq!(page.entries.len(), 3);
    for (run, step, attempt, outcome) in expected {
        let found = page.entries.iter().find(|entry| match &entry.detail {
            DiagnosticDetail::Execution { execution, .. }
            | DiagnosticDetail::ModelStep { execution, .. }
            | DiagnosticDetail::SessionTitle { execution, .. } => execution.run_id == run,
        });
        match outcome {
            Outcome::Success => assert!(found.is_none()),
            Outcome::Unknown => assert!(matches!(
                &found.unwrap().detail,
                DiagnosticDetail::Execution {
                    reason: ExecutionFailureReason::OutcomeUnknown,
                    model_failure: None,
                    ..
                }
            )),
            Outcome::Error | Outcome::Aborted => {
                let status = if outcome == Outcome::Error {
                    ModelInterruption::Failed
                } else {
                    ModelInterruption::Cancelled
                };
                assert!(
                    matches!(&found.unwrap().detail,DiagnosticDetail::ModelStep{step_id,attempt_id,status:actual,model_failure:None,..} if *step_id==step && *attempt_id==attempt && *actual==status)
                );
            }
        }
    }
    assert!(
        !String::from_utf8(serde_json::to_vec(&page).unwrap())
            .unwrap()
            .contains("PRIVATE_PROTOCOL")
    );
    diagnostics.rebuild().await.unwrap();
    assert_eq!(
        diagnostics.page(None, None, 128, BUDGET).await.unwrap(),
        page
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn bootstrap_repairs_missing_and_valid_lag_once_without_new_canonical_facts() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    let state = support::state(&root);
    let mut runs = Vec::new();
    for session in ["missing", "covered"] {
        support::create(&root, session).await;
        let run = support::admit(&state, session, "turn", "question").await;
        support::append(
            &state,
            run,
            vec![Fact::SessionTitleFailed {
                cause: TitleFailureCause::InvalidOutput,
            }],
            vec![],
        )
        .await;
        runs.push(run);
    }
    let diagnostics = state
        .diagnostics(support::owner(), "missing".into())
        .unwrap();
    let expected = diagnostics.page(None, None, 32, BUDGET).await.unwrap();
    let original = state.history(runs[0], 0, 128).await.unwrap();
    root.data_writer()
        .unwrap()
        .write(Fault::Missing(runs[0]))
        .await
        .unwrap();
    assert!(
        matches!(diagnostics.head().await,Err(StoreError::InvalidTransition(reason)) if reason=="diagnostic index requires rebuild")
    );
    state.ensure_diagnostics(support::owner()).await.unwrap();
    assert_eq!(
        diagnostics.page(None, None, 32, BUDGET).await.unwrap(),
        expected
    );
    assert_eq!(state.history(runs[0], 0, 128).await.unwrap(), original);
    root.data_writer()
        .unwrap()
        .write(Fault::Lag(runs[0]))
        .await
        .unwrap();
    state.ensure_diagnostics(support::owner()).await.unwrap();
    assert_eq!(
        diagnostics.page(None, None, 32, BUDGET).await.unwrap(),
        expected
    );
    let mut changes = state.subscribe().unwrap();
    changes.borrow_and_update();
    state.ensure_diagnostics(support::owner()).await.unwrap();
    assert!(!changes.has_changed().unwrap());
    assert_eq!(
        state
            .diagnostics(support::owner(), "covered".into())
            .unwrap()
            .page(None, None, 32, BUDGET)
            .await
            .unwrap()
            .entries
            .len(),
        1
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn bootstrap_does_not_turn_corrupt_source_or_foreign_coverage_into_complete() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let state = support::state(&root);
    let run = support::admit(&state, "session", "turn", "question").await;
    support::append(
        &state,
        run,
        vec![Fact::SessionTitleFailed {
            cause: TitleFailureCause::Preparation,
        }],
        vec![],
    )
    .await;
    let foreign = support::admit(&state, "session", "foreign-turn", "other question").await;
    let baseline = state
        .diagnostics(support::owner(), "session".into())
        .unwrap()
        .page(None, None, 32, BUDGET)
        .await
        .unwrap();
    assert_eq!(baseline.entries.len(), 1);
    root.data_writer()
        .unwrap()
        .write(Fault::Foreign { run, foreign })
        .await
        .unwrap();
    assert!(state.ensure_diagnostics(support::owner()).await.is_err());
    let diagnostics = state
        .diagnostics(support::owner(), "session".into())
        .unwrap();
    assert!(diagnostics.head().await.is_err());
    root.data_writer()
        .unwrap()
        .write(Fault::Missing(run))
        .await
        .unwrap();
    root.data_writer()
        .unwrap()
        .write(Fault::Corrupt(run))
        .await
        .unwrap();
    let error = state
        .ensure_diagnostics(support::owner())
        .await
        .unwrap_err();
    assert!(
        matches!(error.underlying(),StoreError::InvalidTransition(reason) if reason.contains("canonical fact content hash differs")),
        "{error}"
    );
    assert!(diagnostics.head().await.is_err());
    let error = diagnostics.rebuild().await.unwrap_err();
    assert!(
        matches!(error.underlying(),StoreError::InvalidTransition(reason) if reason.contains("canonical fact content hash differs")),
        "{error}"
    );
    assert!(diagnostics.head().await.is_err());
    root.close().await.unwrap();
}

// Intentional store damage models an old empty derived migration and corrupt
// original evidence. It never fabricates an execution receipt or dispatches work.
enum Fault {
    Missing(RunId),
    Lag(RunId),
    Corrupt(RunId),
    Foreign { run: RunId, foreign: RunId },
    LegacyModelProjection { run: RunId, attempt: ModelAttemptId },
}
impl Statement for Fault {
    type Value = ();
    type Output = ();
    fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
        match self {
            Self::Missing(run) => {
                c.execute(
                    "DELETE FROM agent_diagnostic_coverage WHERE run=?",
                    [run.to_string()],
                )?;
                c.execute(
                    "DELETE FROM agent_diagnostics WHERE run=?",
                    [run.to_string()],
                )?;
            }
            Self::Lag(run) => {
                c.execute("UPDATE agent_diagnostic_coverage SET revision=1,sequence=(SELECT sequence FROM agent_facts WHERE run=?1 AND revision=1) WHERE run=?1",[run.to_string()])?;
                c.execute(
                    "DELETE FROM agent_diagnostics WHERE run=?",
                    [run.to_string()],
                )?;
            }
            Self::Corrupt(run) => {
                let (row, original):(i64,Vec<u8>)=c.query_row("SELECT f.body_content_id,b.payload FROM agent_facts f JOIN contents b ON b.id=f.body_content_id WHERE f.run=? ORDER BY f.revision DESC LIMIT 1",[run.to_string()],|row|Ok((row.get(0)?,row.get(1)?)))?;
                let record: RecordedFact = serde_json::from_slice(&original)?;
                assert_eq!(record.run, run);
                let mut damaged = original.clone();
                let needle = format!("\"at\":{}", record.at.0);
                let at = damaged
                    .windows(needle.len())
                    .position(|bytes| bytes == needle.as_bytes())
                    .expect("actual original fact timestamp")
                    + needle.len()
                    - 1;
                damaged[at] = if damaged[at] == b'0' { b'1' } else { b'0' };
                let changed: RecordedFact = serde_json::from_slice(&damaged)?;
                assert_eq!(
                    (
                        changed.run,
                        changed.id,
                        changed.revision,
                        changed.schema_version
                    ),
                    (
                        record.run,
                        record.id,
                        record.revision,
                        record.schema_version
                    )
                );
                assert_eq!(damaged.len(), original.len());
                assert_ne!(damaged, original);
                // Physical corruption in this fresh fixture bypasses SQL UPDATE, not the immutable trigger contract.
                let mut blob = c.blob_open("main", "contents", "payload", row, false)?;
                blob.write_all(&damaged)?;
            }
            Self::Foreign { run, foreign } => {
                c.execute("UPDATE agent_diagnostic_coverage SET sequence=(SELECT sequence FROM agent_facts WHERE run=?2 AND revision=1) WHERE run=?1",params![run.to_string(),foreign.to_string()])?;
            }
            Self::LegacyModelProjection { run, attempt } => {
                c.execute(
                    "UPDATE agent_runs SET schema_version=1 WHERE run=?",
                    [run.to_string()],
                )?;
                c.execute(
                    "UPDATE agent_attempts SET pending=1 WHERE run=? AND key=?",
                    params![run.to_string(), attempt.to_string()],
                )?;
            }
        }
        Ok(Prepared {
            value: (),
            changed: true,
            notification: Notification::METADATA,
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}

struct ModelCache(RunId, ModelAttemptId);
impl maka_event_log::connection::Query for ModelCache {
    type Output = (u32, bool);
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        Ok(c.query_row(
            "SELECT r.schema_version,a.pending FROM agent_runs r JOIN agent_attempts a ON a.run=r.run WHERE r.run=? AND a.key=?",
            params![self.0.to_string(), self.1.to_string()], |row| Ok((row.get(0)?, row.get(1)?)),
        )?)
    }
}

#[tokio::test]
async fn model_cleanup_ack_reconciles_pending_waits_and_gates_ordinary_completion() {
    use maka_agent_state::ContentBlob;
    use maka_plugin_core::operation::OperationCleanup;

    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let state = support::state(&root);
    for interrupted in [false, true] {
        let turn = if interrupted { "interrupted" } else { "closed" };
        let child = support::admit(
            &state,
            "session",
            &format!("child-{turn}"),
            "child question",
        )
        .await;
        let run = support::admit(&state, "session", turn, "parent question").await;
        let claim = state.claim(run).await.unwrap();
        let view = state.frontier(run).await.unwrap();
        let (step, request, contents) = support::request(vec![]);
        let attempt = ModelAttemptId::new();
        let closure = if interrupted {
            Fact::ModelInterrupted {
                attempt,
                diagnostic: "original model transport ended".into(),
            }
        } else {
            Fact::ModelClosed {
                attempt,
                outcome: Outcome::Success,
                diagnostic: None,
                usage: ModelUsage::default(),
                protocol: json!({"original":"closed"}),
            }
        };
        state
            .append(
                &claim,
                (&view).into(),
                vec![
                    Change::new(
                        Fact::StepPrepared {
                            step,
                            request: request.reference().clone(),
                            adjudications: vec![],
                        },
                        UnixMillis(2),
                    ),
                    Change::new(Fact::ModelAttemptPrepared { attempt, step }, UnixMillis(2)),
                    Change::new(
                        Fact::ModelAttemptAdmitted {
                            attempt,
                            upstream: json!({"original":true}),
                        },
                        UnixMillis(2),
                    ),
                    Change::new(closure, UnixMillis(3)),
                ],
                contents,
            )
            .await
            .unwrap();
        let cleanup_wait = WaitId::new();
        let child_wait = WaitId::new();
        let due = UnixMillis(50);
        let registered = Change::new(
            Fact::WaitRegistered {
                wait: cleanup_wait,
                reason: WaitReason::Model { attempt },
                due_at: None,
            },
            UnixMillis(3),
        );
        let view = state.frontier(run).await.unwrap();
        state
            .append(
                &claim,
                (&view).into(),
                vec![
                    registered.clone(),
                    Change::new(
                        Fact::WaitRegistered {
                            wait: child_wait,
                            reason: WaitReason::Child { run: child },
                            due_at: Some(due),
                        },
                        UnixMillis(3),
                    ),
                ],
                vec![],
            )
            .await
            .unwrap();
        let original_wait = state.fact(run, registered.id).await.unwrap().unwrap();
        assert!(
            !state
                .ready_runs(support::owner(), due, None, 32)
                .await
                .unwrap()
                .iter()
                .any(|ready| ready.run == run)
        );
        assert_eq!(state.next_due_wait(support::owner()).await.unwrap(), None);
        let before = state.frontier(run).await.unwrap();
        assert!(before.tools.is_empty());
        assert_eq!(
            before.attempts[&attempt].cleanup,
            OperationCleanup::Unconfirmed
        );
        let rejected = state
            .append(
                &claim,
                (&before).into(),
                vec![Change::new(
                    Fact::RunTerminated {
                        terminal: Terminal::Completed,
                        diagnostic: None,
                    },
                    UnixMillis(4),
                )],
                vec![],
            )
            .await;
        assert!(
            matches!(rejected, Err(StoreError::InvalidTransition(reason))
            if reason == "successful completion requires actual model cleanup acknowledgements")
        );
        assert_eq!(state.frontier(run).await.unwrap().revision, before.revision);

        let acknowledged = Change::new(
            Fact::ModelCleanupObserved {
                attempt,
                cleanup: OperationCleanup::Confirmed,
            },
            UnixMillis(5),
        );
        state
            .observe(run, vec![acknowledged.clone()], vec![])
            .await
            .unwrap();
        assert_eq!(
            state.fact(run, registered.id).await.unwrap(),
            Some(original_wait)
        );
        let reconciliable = state.frontier(run).await.unwrap();
        assert!(reconciliable.waits[&cleanup_wait].satisfied.is_none());
        assert!(reconciliable.waits[&cleanup_wait].cancelled.is_none());
        assert_eq!(
            reconciliable.attempts[&attempt].cleanup,
            OperationCleanup::Confirmed
        );
        assert!(
            state
                .ready_runs(support::owner(), due, None, 32)
                .await
                .unwrap()
                .iter()
                .any(|ready| ready.run == run)
        );
        assert_eq!(
            state.next_due_wait(support::owner()).await.unwrap(),
            Some(due)
        );
        support::complete(&state, child).await;
        let evidence =
            ContentBlob::json(&json!({"modelCleanupFact":acknowledged.id,"completedChild":child}))
                .unwrap();
        state
            .append(
                &claim,
                (&reconciliable).into(),
                vec![
                    Change::new(
                        Fact::WaitSatisfied {
                            wait: cleanup_wait,
                            evidence: evidence.reference().clone(),
                        },
                        UnixMillis(6),
                    ),
                    Change::new(
                        Fact::WaitSatisfied {
                            wait: child_wait,
                            evidence: evidence.reference().clone(),
                        },
                        UnixMillis(6),
                    ),
                    Change::new(
                        Fact::RunTerminated {
                            terminal: Terminal::Completed,
                            diagnostic: None,
                        },
                        UnixMillis(6),
                    ),
                ],
                vec![evidence.clone()],
            )
            .await
            .unwrap();
        assert_eq!(
            state.frontier(run).await.unwrap().terminal,
            Some(Terminal::Completed)
        );
        assert_eq!(
            state
                .content(run, evidence.reference().clone())
                .await
                .unwrap(),
            serde_json::to_vec(&json!({"modelCleanupFact":acknowledged.id,"completedChild":child}))
                .unwrap()
        );
        assert!(
            !root
                .data_writer()
                .unwrap()
                .query(ModelCache(run, attempt))
                .await
                .unwrap()
                .1
        );
        assert_eq!(state.next_due_wait(support::owner()).await.unwrap(), None);
    }

    let run = support::admit(&state, "session", "unadmitted", "cancelled before sending").await;
    let (step, request, contents) = support::request(vec![]);
    let attempt = ModelAttemptId::new();
    support::append(
        &state,
        run,
        vec![
            Fact::StepPrepared {
                step,
                request: request.reference().clone(),
                adjudications: vec![],
            },
            Fact::ModelAttemptPrepared { attempt, step },
            Fact::ModelClosed {
                attempt,
                outcome: Outcome::Aborted,
                diagnostic: Some("cancelled before model admission".into()),
                usage: ModelUsage::default(),
                protocol: json!({}),
            },
            Fact::RunTerminated {
                terminal: Terminal::Completed,
                diagnostic: None,
            },
        ],
        contents,
    )
    .await;
    let view = state.frontier(run).await.unwrap();
    assert!(view.attempts[&attempt].admission.is_none());
    assert_eq!(
        view.attempts[&attempt].cleanup,
        OperationCleanup::Unconfirmed
    );
    assert_eq!(view.terminal, Some(Terminal::Completed));
    assert!(
        !root
            .data_writer()
            .unwrap()
            .query(ModelCache(run, attempt))
            .await
            .unwrap()
            .1
    );
    assert!(
        state
            .session_quiescence(support::owner(), "session".into())
            .await
            .unwrap()
            .is_quiescent()
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn cold_diagnostic_ensure_repairs_legacy_model_headers_without_rewriting_evidence() {
    use maka_agent_state::Head;
    use maka_plugin_core::operation::OperationCleanup;

    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    let state = support::state(&root);
    let mut frozen = Vec::new();
    for admitted in [true, false] {
        let session = if admitted {
            "interrupted-cancelled"
        } else {
            "unadmitted-failed"
        };
        support::create(&root, session).await;
        let run = support::admit(&state, session, "original-turn", "original question").await;
        let (step, request, contents) = support::request(vec![]);
        let request_ref = request.reference().clone();
        let attempt = ModelAttemptId::new();
        let mut facts = vec![
            Fact::StepPrepared {
                step,
                request: request_ref.clone(),
                adjudications: vec![],
            },
            Fact::ModelAttemptPrepared { attempt, step },
        ];
        if admitted {
            facts.extend([
                Fact::ModelAttemptAdmitted {
                    attempt,
                    upstream: json!({"original":true}),
                },
                Fact::ModelInterrupted {
                    attempt,
                    diagnostic: "original transport interruption".into(),
                },
                Fact::RunTerminated {
                    terminal: Terminal::Cancelled,
                    diagnostic: Some("logical cancellation before physical ACK".into()),
                },
            ]);
        } else {
            facts.extend([
                Fact::ModelClosed {
                    attempt,
                    outcome: Outcome::Aborted,
                    diagnostic: Some("never admitted to the model".into()),
                    usage: ModelUsage::default(),
                    protocol: json!({"original":"unadmitted"}),
                },
                Fact::RunTerminated {
                    terminal: Terminal::Failed,
                    diagnostic: Some("preparation ended without admission".into()),
                },
            ]);
        }
        support::append(&state, run, facts, contents).await;
        if admitted {
            assert!(
                !state
                    .session_quiescence(support::owner(), session.into())
                    .await
                    .unwrap()
                    .is_quiescent()
            );
            state
                .observe(
                    run,
                    vec![Change::new(
                        Fact::ModelCleanupObserved {
                            attempt,
                            cleanup: OperationCleanup::Confirmed,
                        },
                        UnixMillis(4),
                    )],
                    vec![],
                )
                .await
                .unwrap();
        }
        let view = state.frontier(run).await.unwrap();
        if admitted {
            assert!(view.attempts[&attempt].closed.is_none());
            assert!(view.attempts[&attempt].interrupted.is_some());
            assert_eq!(view.attempts[&attempt].cleanup, OperationCleanup::Confirmed);
        } else {
            assert!(view.attempts[&attempt].admission.is_none());
            assert!(view.attempts[&attempt].closed.is_some());
        }
        assert!(
            state
                .session_quiescence(support::owner(), session.into())
                .await
                .unwrap()
                .is_quiescent()
        );
        assert!(
            !root
                .data_writer()
                .unwrap()
                .query(ModelCache(run, attempt))
                .await
                .unwrap()
                .1
        );
        let history = state.history(run, 0, 128).await.unwrap();
        assert!(
            history
                .iter()
                .all(|fact| fact.schema_version == SCHEMA_VERSION)
        );
        let Fact::RunAdmitted { spec } = &history[0].fact else {
            panic!("original RunSpec fact required")
        };
        let spec = spec.clone();
        let spec_bytes = state.content(run, spec.clone()).await.unwrap();
        let request_bytes = state.content(run, request_ref.clone()).await.unwrap();
        frozen.push((
            session.to_owned(),
            run,
            attempt,
            Head::from(&view),
            history,
            spec,
            spec_bytes,
            request_ref,
            request_bytes,
        ));
    }
    for (_, run, attempt, _, _, _, _, _, _) in &frozen {
        root.data_writer()
            .unwrap()
            .write(Fault::LegacyModelProjection {
                run: *run,
                attempt: *attempt,
            })
            .await
            .unwrap();
        assert_eq!(
            root.data_writer()
                .unwrap()
                .query(ModelCache(*run, *attempt))
                .await
                .unwrap(),
            (1, true)
        );
    }
    root.close().await.unwrap();

    let root = support::open(directory.path(), true).await;
    let state = support::state(&root);
    for (_, run, attempt, _, _, _, _, _, _) in &frozen {
        assert_eq!(
            root.data_writer()
                .unwrap()
                .query(ModelCache(*run, *attempt))
                .await
                .unwrap(),
            (1, true)
        );
    }
    state.ensure_diagnostics(support::owner()).await.unwrap();
    for (session, run, attempt, head, history, spec, spec_bytes, request, request_bytes) in &frozen
    {
        assert_eq!(
            root.data_writer()
                .unwrap()
                .query(ModelCache(*run, *attempt))
                .await
                .unwrap(),
            (2, false)
        );
        let view = state.frontier(*run).await.unwrap();
        assert_eq!(Head::from(&view), *head);
        assert_eq!(state.history(*run, 0, 128).await.unwrap(), *history);
        assert_eq!(
            state.content(*run, spec.clone()).await.unwrap(),
            *spec_bytes
        );
        assert_eq!(
            state.content(*run, request.clone()).await.unwrap(),
            *request_bytes
        );
        assert_eq!(view.spec.schema_version, SCHEMA_VERSION);
        assert!(
            state
                .session_quiescence(support::owner(), session.clone())
                .await
                .unwrap()
                .is_quiescent()
        );
    }
    let mut changes = state.subscribe().unwrap();
    changes.borrow_and_update();
    state.ensure_diagnostics(support::owner()).await.unwrap();
    assert!(!changes.has_changed().unwrap());
    for (_, run, _, _, history, _, _, _, _) in frozen {
        assert_eq!(state.history(run, 0, 128).await.unwrap(), history);
    }
    root.close().await.unwrap();
}
