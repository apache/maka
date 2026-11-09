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

use crate::support::{
    canonical::{append, configuration, drive, request, spec},
    native::NativeFixture,
};
use maka_agent_engine::DriverExit;
use maka_agent_facts::{accounting::Outcome, durable::*};
use maka_agent_state::{Admission, Change, ContentBlob, Store};
use maka_plugin_core::operation::OperationCleanup;
use serde_json::{Value, json};
use std::path::Path;

struct Seed {
    run: RunId,
    step: StepId,
    attempt: ModelAttemptId,
    prepared: Change,
    request: RequestSpec,
    owner: RunOwner,
}

async fn seed(
    fixture: &NativeFixture,
    workspace: &Path,
    session: &str,
    not_before: UnixMillis,
) -> Seed {
    fixture
        .root
        .create_session(session, session, &json!({}), 1)
        .await
        .unwrap();
    let (spec, contents) = spec(fixture, workspace, session, "turn", "frozen input");
    let owner = spec.owner.clone();
    let admission = Admission::new(spec, UnixMillis(1), contents);
    let run = admission.run();
    fixture.state.admit(admission).await.unwrap();
    let step = StepId::new();
    let attempt = ModelAttemptId::new();
    let (request, mut contents) = request(step);
    let blob = ContentBlob::json(&request).unwrap();
    let prepared = Change::new(
        Fact::StepPrepared {
            step,
            request: blob.reference().clone(),
            adjudications: vec![],
        },
        UnixMillis(2),
    );
    contents.push(blob);
    append(
        &fixture.state,
        run,
        vec![
            prepared.clone(),
            Change::new(Fact::ModelAttemptPrepared { attempt, step }, UnixMillis(2)),
            Change::new(
                Fact::ModelAttemptAdmitted {
                    attempt,
                    upstream: json!({"original": true}),
                },
                UnixMillis(2),
            ),
            Change::new(
                Fact::ModelInterrupted {
                    attempt,
                    diagnostic: "original rate-limit failure".into(),
                },
                UnixMillis(3),
            ),
            Change::new(
                Fact::AttemptRecoveryRecorded {
                    attempt,
                    recovery: AttemptRecovery::FrozenRetrySafe {
                        not_before: Some(not_before),
                    },
                },
                UnixMillis(3),
            ),
            Change::new(
                Fact::ModelCleanupObserved {
                    attempt,
                    cleanup: OperationCleanup::Confirmed,
                },
                UnixMillis(3),
            ),
        ],
        contents,
    )
    .await
    .unwrap();
    Seed {
        run,
        step,
        attempt,
        prepared,
        request,
        owner,
    }
}

async fn retried(state: &Store, seed: &Seed, at: UnixMillis) -> ModelAttemptId {
    let attempt = ModelAttemptId::new();
    append(
        state,
        seed.run,
        vec![
            Change::new(
                Fact::ModelAttemptPrepared {
                    attempt,
                    step: seed.step,
                },
                at,
            ),
            Change::new(
                Fact::ModelAttemptAdmitted {
                    attempt,
                    upstream: json!({"retry": true}),
                },
                at,
            ),
            Change::new(
                Fact::ModelClosed {
                    attempt,
                    outcome: Outcome::Error,
                    diagnostic: Some("retry also failed".into()),
                    usage: Default::default(),
                    protocol: json!({}),
                },
                at,
            ),
            Change::new(
                Fact::ModelCleanupObserved {
                    attempt,
                    cleanup: OperationCleanup::Confirmed,
                },
                at,
            ),
            Change::new(
                Fact::AttemptRecoveryRecorded {
                    attempt,
                    recovery: AttemptRecovery::FrozenRetrySafe { not_before: None },
                },
                at,
            ),
        ],
        vec![],
    )
    .await
    .unwrap();
    attempt
}

async fn retry_fact(state: &Store, run: RunId) -> RecordedFact {
    let facts = state.history(run, 0, 128).await.unwrap();
    let retries: Vec<_> = facts
        .into_iter()
        .filter(|recorded| matches!(recorded.fact, Fact::RetryCharged { .. }))
        .collect();
    assert_eq!(
        retries.len(),
        1,
        "one failed attempt consumes exactly one retry"
    );
    retries.into_iter().next().unwrap()
}

fn original(recorded: &RecordedFact) -> Change {
    Change {
        id: recorded.id,
        at: recorded.at,
        fact: recorded.fact.clone(),
    }
}

#[tokio::test]
async fn retry_requires_exact_consumption_and_replays_one_request() {
    let directory = tempfile::tempdir().unwrap();
    let fixture = NativeFixture::open(directory.path(), configuration())
        .await
        .unwrap();
    let seed = seed(&fixture, directory.path(), "retry", UnixMillis(1_000)).await;
    let uncharged = Change::new(
        Fact::ModelAttemptPrepared {
            attempt: ModelAttemptId::new(),
            step: seed.step,
        },
        UnixMillis(1_000),
    );
    assert!(
        append(&fixture.state, seed.run, vec![uncharged], vec![])
            .await
            .is_err(),
        "ordinary preparation cannot consume an uncharged failure"
    );
    assert!(
        append(
            &fixture.state,
            seed.run,
            vec![Change::new(
                Fact::RetryCharged {
                    attempt: ModelAttemptId::new(),
                    phase: maka_agent_facts::model::retry_transport::RetryTransportPhase::Primary,
                    due_at: UnixMillis(1_000),
                    diagnostic: "wrong failure".into(),
                },
                UnixMillis(100)
            )],
            vec![]
        )
        .await
        .is_err()
    );

    assert!(
        matches!(drive(&fixture.state, seed.run, UnixMillis(100)).await,
        DriverExit::Waiting { run, due_at: Some(UnixMillis(1_000)) } if run == seed.run)
    );
    let charged = retry_fact(&fixture.state, seed.run).await;
    assert_eq!(
        fixture
            .state
            .fact_barrier(seed.run, charged.id)
            .await
            .unwrap(),
        Some(charged.clone())
    );
    assert_eq!(
        append(&fixture.state, seed.run, vec![original(&charged)], vec![])
            .await
            .unwrap()
            .facts,
        vec![charged.clone()]
    );
    let mut wrong = original(&charged);
    let Fact::RetryCharged { due_at, .. } = &mut wrong.fact else {
        unreachable!()
    };
    due_at.0 += 1;
    assert!(
        append(&fixture.state, seed.run, vec![wrong], vec![])
            .await
            .is_err(),
        "same identity cannot change the original retry decision"
    );
    assert!(
        append(
            &fixture.state,
            seed.run,
            vec![Change::new(charged.fact.clone(), charged.at)],
            vec![]
        )
        .await
        .is_err(),
        "a new fact cannot charge the same failure twice"
    );

    // A retry consumes the original frozen Step; it cannot smuggle in different
    // input or composition under either the old FactId or a fresh FactId.
    for composition in [false, true] {
        let mut changed = seed.request.clone();
        let mut contents = vec![];
        if composition {
            changed.composition.system_prompt = Some("changed system".into());
        } else {
            let body = ContentBlob::json(
                &json!({"messages": [{"role": "user", "content": "different input"}]}),
            )
            .unwrap();
            changed.request = body.reference().clone();
            contents.push(body);
        }
        let blob = ContentBlob::json(&changed).unwrap();
        contents.push(blob.clone());
        let mut conflicting = seed.prepared.clone();
        conflicting.fact = Fact::StepPrepared {
            step: seed.step,
            request: blob.reference().clone(),
            adjudications: vec![],
        };
        assert!(
            append(
                &fixture.state,
                seed.run,
                vec![conflicting.clone()],
                contents.clone()
            )
            .await
            .is_err()
        );
        conflicting.id = FactId::new();
        assert!(
            append(&fixture.state, seed.run, vec![conflicting], contents)
                .await
                .is_err()
        );
    }
    assert_eq!(
        fixture.state.request(seed.run, seed.step).await.unwrap(),
        seed.request
    );

    let attempt = ModelAttemptId::new();
    let consumed = Change::new(
        Fact::ModelAttemptPrepared {
            attempt,
            step: seed.step,
        },
        UnixMillis(1_000),
    );
    assert_eq!(
        fixture
            .state
            .fact_barrier(seed.run, consumed.id)
            .await
            .unwrap(),
        None
    );
    let commit = append(&fixture.state, seed.run, vec![consumed.clone()], vec![])
        .await
        .unwrap();
    assert_eq!(
        fixture
            .state
            .fact_barrier(seed.run, consumed.id)
            .await
            .unwrap(),
        Some(commit.facts[0].clone())
    );
    assert_eq!(
        append(&fixture.state, seed.run, vec![consumed.clone()], vec![])
            .await
            .unwrap()
            .facts,
        commit.facts,
        "lost consumption receipts replay exactly"
    );
    append(
        &fixture.state,
        seed.run,
        vec![
            Change::new(
                Fact::ModelAttemptAdmitted {
                    attempt,
                    upstream: json!({"retry": true}),
                },
                UnixMillis(1_000),
            ),
            Change::new(
                Fact::ModelClosed {
                    attempt,
                    outcome: Outcome::Success,
                    diagnostic: None,
                    usage: Default::default(),
                    protocol: json!({"finishReason":"stop"}),
                },
                UnixMillis(1_000),
            ),
        ],
        vec![],
    )
    .await
    .unwrap();
    assert!(
        matches!(drive(&fixture.state, seed.run, UnixMillis(1_000)).await,
        DriverExit::Waiting { run, due_at: None } if run == seed.run)
    );
    let waiting = fixture.state.frontier(seed.run).await.unwrap();
    assert!(waiting.terminal.is_none());
    assert!(waiting.waits.values().any(|wait| wait.satisfied.is_none()
        && wait.cancelled.is_none()
        && wait.due_at.is_none()
        && wait.reason == (WaitReason::Model { attempt })));
    assert!(
        fixture
            .state
            .ready_runs(seed.owner.clone(), UnixMillis(1_000), None, 10)
            .await
            .unwrap()
            .is_empty()
    );
    append(
        &fixture.state,
        seed.run,
        vec![Change::new(
            Fact::ModelCleanupObserved {
                attempt,
                cleanup: OperationCleanup::Confirmed,
            },
            UnixMillis(1_000),
        )],
        vec![],
    )
    .await
    .unwrap();
    assert_eq!(
        fixture
            .state
            .ready_runs(seed.owner.clone(), UnixMillis(1_000), None, 10)
            .await
            .unwrap()
            .iter()
            .map(|run| run.run)
            .collect::<Vec<_>>(),
        vec![seed.run]
    );
    assert!(
        matches!(drive(&fixture.state, seed.run, UnixMillis(1_000)).await,
        DriverExit::Terminal { run, terminal: Terminal::Completed } if run == seed.run)
    );
    let history = fixture.state.history(seed.run, 0, 128).await.unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|r| matches!(r.fact, Fact::StepPrepared { .. }))
            .count(),
        1
    );
    assert_eq!(
        history
            .iter()
            .filter(|r| matches!(r.fact, Fact::ModelAttemptAdmitted { .. }))
            .count(),
        2
    );
    assert_eq!(
        fixture.state.runs("retry".into(), None, 10).await.unwrap(),
        vec![seed.run]
    );
    let view = fixture.state.frontier(seed.run).await.unwrap();
    assert_eq!(view.retries, 1);
    assert!(view.retry_pending.is_none());
    let archived = fixture
        .root
        .set_session_archived::<Value>("retry", true, 3)
        .await
        .unwrap();
    fixture
        .root
        .begin_session_removal("retry", archived.revision)
        .await
        .unwrap();
    assert_eq!(
        fixture
            .state
            .fact_barrier(seed.run, consumed.id)
            .await
            .unwrap(),
        Some(commit.facts[0].clone()),
        "read confirmation survives archive/removal admission controls"
    );
    assert_eq!(
        fixture.state.request(seed.run, seed.step).await.unwrap(),
        seed.request
    );
    fixture.shutdown().await.unwrap();
}

#[tokio::test]
async fn deadline_and_post_decision_budget_survive_restart_and_exact_confirmation() {
    let directory = tempfile::tempdir().unwrap();
    let deadline = UnixMillis(4_000_000_000_000);
    let fixture = NativeFixture::open(directory.path(), configuration())
        .await
        .unwrap();
    let seed = seed(&fixture, directory.path(), "future", deadline).await;
    assert!(
        matches!(drive(&fixture.state, seed.run, UnixMillis(100)).await,
        DriverExit::Waiting { due_at: Some(due), .. } if due == deadline)
    );
    let charged = retry_fact(&fixture.state, seed.run).await;
    let before = fixture.state.frontier(seed.run).await.unwrap();
    assert_eq!(before.retries, 1);
    assert_eq!(before.retry_due_at, Some(deadline));
    assert!(
        fixture
            .state
            .due_waits(UnixMillis(deadline.0 - 1), None, 10)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fixture
            .state
            .next_due_wait(seed.owner.clone())
            .await
            .unwrap(),
        Some(deadline)
    );
    assert!(
        fixture
            .state
            .ready_runs(seed.owner.clone(), UnixMillis(deadline.0 - 1), None, 10)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fixture
            .state
            .ready_runs(seed.owner.clone(), deadline, None, 10)
            .await
            .unwrap()
            .iter()
            .map(|r| r.run)
            .collect::<Vec<_>>(),
        vec![seed.run]
    );
    let due = fixture.state.due_waits(deadline, None, 10).await.unwrap();
    assert_eq!(
        due.len(),
        1,
        "crossing the cutoff cannot lose the durable wait"
    );
    assert_eq!(due[0].0, seed.run);
    assert_eq!(
        due[0].2.reason,
        WaitReason::Retry {
            attempt: seed.attempt
        }
    );
    assert_eq!(due[0].2.due_at, Some(deadline));
    let mut changed = original(&charged);
    let Fact::RetryCharged { due_at, .. } = &mut changed.fact else {
        unreachable!()
    };
    due_at.0 += 1;
    assert!(
        append(&fixture.state, seed.run, vec![changed], vec![])
            .await
            .is_err(),
        "same decision cannot resample the deadline"
    );
    assert!(
        append(
            &fixture.state,
            seed.run,
            vec![Change::new(
                Fact::ModelAttemptPrepared {
                    attempt: ModelAttemptId::new(),
                    step: seed.step,
                },
                UnixMillis(deadline.0 - 1)
            )],
            vec![]
        )
        .await
        .is_err(),
        "retry cannot consume before the captured deadline"
    );
    fixture.shutdown().await.unwrap();

    let fixture = NativeFixture::open(directory.path(), configuration())
        .await
        .unwrap();
    let saved = fixture.state.frontier(seed.run).await.unwrap();
    assert_eq!(saved.run, before.run);
    assert_eq!(saved.spec, before.spec);
    assert_eq!(
        saved.retries, 1,
        "physical restart cannot reset a post-decision retry charge"
    );
    assert_eq!(saved.retry_due_at, Some(deadline));
    assert_eq!(
        fixture
            .state
            .fact_barrier(seed.run, charged.id)
            .await
            .unwrap(),
        Some(charged.clone())
    );
    assert_eq!(
        fixture.state.request(seed.run, seed.step).await.unwrap(),
        seed.request
    );
    assert!(
        matches!(drive(&fixture.state, seed.run, UnixMillis(200)).await,
        DriverExit::Waiting { due_at: Some(due), .. } if due == deadline)
    );
    assert_eq!(
        fixture.state.frontier(seed.run).await.unwrap().revision,
        saved.revision,
        "recovery of the same future wait must not produce a busy publication loop"
    );

    let stop = Change::new(
        Fact::StopRequested {
            diagnostic: "test stop".into(),
        },
        UnixMillis(201),
    );
    let stopped = fixture
        .state
        .control(seed.run, (&saved).into(), vec![stop.clone()], vec![])
        .await
        .unwrap();
    assert_eq!(
        fixture
            .state
            .control(seed.run, stopped.head, vec![stop.clone()], vec![])
            .await
            .unwrap()
            .facts,
        stopped.facts
    );
    assert_eq!(
        fixture
            .state
            .ready_runs(seed.owner.clone(), UnixMillis(0), None, 10)
            .await
            .unwrap()
            .iter()
            .map(|r| r.run)
            .collect::<Vec<_>>(),
        vec![seed.run],
        "Stop wakes the original future wait without waiting for its deadline"
    );
    assert!(
        matches!(drive(&fixture.state, seed.run, UnixMillis(201)).await,
        DriverExit::Terminal { run, terminal: Terminal::Cancelled } if run == seed.run)
    );
    let terminal = fixture.state.frontier(seed.run).await.unwrap();
    assert_eq!(terminal.retries, 1);
    assert!(
        terminal
            .waits
            .values()
            .all(|wait| wait.cancelled.is_some() || wait.satisfied.is_some())
    );
    assert_eq!(
        fixture.state.fact_barrier(seed.run, stop.id).await.unwrap(),
        Some(stopped.facts[0].clone())
    );
    assert_eq!(
        fixture
            .state
            .control(seed.run, (&terminal).into(), vec![stop], vec![])
            .await
            .unwrap()
            .facts,
        stopped.facts,
        "lost cancellation acknowledgement confirms the original Stop after terminal settlement"
    );
    assert!(
        fixture
            .state
            .next_due_wait(seed.owner)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        fixture
            .state
            .due_waits(deadline, None, 10)
            .await
            .unwrap()
            .is_empty()
    );
    let history = fixture.state.history(seed.run, 0, 128).await.unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|r| matches!(r.fact, Fact::RunTerminated { .. }))
            .count(),
        1
    );
    assert_eq!(
        history
            .iter()
            .filter(|r| matches!(r.fact, Fact::ModelAttemptAdmitted { .. }))
            .count(),
        1
    );
    fixture.shutdown().await.unwrap();
}

#[tokio::test]
async fn newer_main_request_prevents_old_failure_from_parking() {
    let directory = tempfile::tempdir().unwrap();
    let fixture = NativeFixture::open(directory.path(), configuration())
        .await
        .unwrap();
    let seed = seed(&fixture, directory.path(), "advanced", UnixMillis(1_000)).await;
    assert!(matches!(
        drive(&fixture.state, seed.run, UnixMillis(100)).await,
        DriverExit::Waiting { .. }
    ));
    let charged = retry_fact(&fixture.state, seed.run).await;
    // The newer request is an attempt of the original immutable Step, not a
    // replacement physical Run or an independently resampled retry request.
    let newer = retried(&fixture.state, &seed, UnixMillis(1_000)).await;
    let advanced = fixture.state.frontier(seed.run).await.unwrap();
    assert_eq!(advanced.current_attempt, Some(newer));
    assert_eq!(advanced.retry_pending, Some(newer));
    assert!(
        append(
            &fixture.state,
            seed.run,
            vec![Change::new(
                Fact::RetryCharged {
                    attempt: seed.attempt,
                    phase: maka_agent_facts::model::retry_transport::RetryTransportPhase::Primary,
                    due_at: UnixMillis(1_001),
                    diagnostic: "obsolete failure".into(),
                },
                UnixMillis(1_000)
            )],
            vec![]
        )
        .await
        .is_err(),
        "a newer request prevents an old failure from acquiring another retry"
    );
    assert!(
        append(
            &fixture.state,
            seed.run,
            vec![Change::new(
                Fact::AttemptRecoveryRecorded {
                    attempt: seed.attempt,
                    recovery: AttemptRecovery::FrozenRetrySafe {
                        not_before: Some(UnixMillis(2_000))
                    },
                },
                UnixMillis(1_000)
            )],
            vec![]
        )
        .await
        .is_err(),
        "late assessment of the retired source cannot repark it"
    );
    assert_eq!(
        append(&fixture.state, seed.run, vec![original(&charged)], vec![])
            .await
            .unwrap()
            .facts,
        vec![charged.clone()]
    );
    assert_eq!(
        fixture.state.frontier(seed.run).await.unwrap().revision,
        advanced.revision,
        "original receipt replay cannot restore an obsolete retry level"
    );
    fixture.shutdown().await.unwrap();

    let fixture = NativeFixture::open(directory.path(), configuration())
        .await
        .unwrap();
    let saved = fixture.state.frontier(seed.run).await.unwrap();
    assert_eq!(saved.current_attempt, Some(newer));
    assert_eq!(saved.retries, 1);
    assert_eq!(saved.spec.budget.retries, 1);
    assert!(
        matches!(drive(&fixture.state, seed.run, UnixMillis(1_000)).await,
        DriverExit::Terminal { run, terminal: Terminal::Failed } if run == seed.run),
        "the newer failure exhausts the saved budget; neither restart nor an old failure grants a third dispatch"
    );
    let history = fixture.state.history(seed.run, 0, 128).await.unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|r| matches!(r.fact, Fact::ModelAttemptAdmitted { .. }))
            .count(),
        2
    );
    assert_eq!(
        history
            .iter()
            .filter(|r| matches!(r.fact, Fact::RetryCharged { .. }))
            .count(),
        1
    );
    assert_eq!(
        history
            .iter()
            .filter(|r| matches!(r.fact, Fact::StepPrepared { .. }))
            .count(),
        1
    );
    assert_eq!(
        fixture.state.request(seed.run, seed.step).await.unwrap(),
        seed.request
    );
    assert_eq!(
        fixture
            .state
            .runs("advanced".into(), None, 10)
            .await
            .unwrap(),
        vec![seed.run]
    );
    fixture.shutdown().await.unwrap();
}
