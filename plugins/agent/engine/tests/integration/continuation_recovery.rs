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
    canonical::{self, NoEffects, append, drive},
    native::NativeFixture,
};
use maka_agent_api::{Configuration, session::StoredSessionConfiguration};
use maka_agent_engine::{DriverExit, Engine};
use maka_agent_facts::{
    accounting::Outcome,
    context::ModelPurpose,
    continuation::{ContinuationClaim, REPLAY_VERSION, ReplayEvidence, RunBoundary, SessionBase},
    durable::*,
    history_snapshot::RequestSource,
    input::{DeliveredMessage, MessageInput, RunInput},
    message::{MessageDisposition, Placement, RootSourceMessage},
    model::{ModelPart, ModelToolCall},
    session::ForkPosition,
};
use maka_agent_state::{
    Admission, Change, ContentBlob, Store,
    queue::{
        self, Consume, MessageResolution, PreparedRequest, QueueCommand, QueueEdit, RequestId,
    },
    session_history::SessionHistory,
};
use maka_plugin_core::operation::OperationCleanup;
use serde_json::json;
use std::{path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const NOW: UnixMillis = UnixMillis(1_000);

fn configuration(workspace: &Path) -> Configuration {
    let mut configuration = canonical::configuration();
    configuration.workspace_roots = vec![maka_host_runtime::DirectoryRootSpec {
        label: "continuation fixture".into(),
        path: workspace.to_owned(),
    }];
    configuration
}

// This is only data from the real SDK-created Session, not a restored grant.
async fn session(fixture: &NativeFixture, workspace: &Path) -> (RunSpec, Vec<ContentBlob>) {
    let id = fixture
        .create("canonical continuation", workspace, None)
        .await
        .unwrap();
    let record = fixture
        .root
        .session(&id)
        .await
        .unwrap()
        .get::<StoredSessionConfiguration>()
        .await
        .unwrap()
        .unwrap();
    let binding = record.workspace_binding.unwrap();
    let stamp = binding.stamp();
    let resolved = record
        .configuration
        .resolve(serde_json::from_value(binding.workspace).unwrap(), stamp)
        .unwrap();
    let (mut spec, contents) = canonical::spec(
        fixture,
        Path::new(&resolved.workspace.path),
        &id,
        "template",
        "frozen input",
    );
    spec.permission_basis = resolved.permission_basis();
    (spec, contents)
}

fn session_history(fixture: &NativeFixture, spec: &RunSpec) -> SessionHistory {
    fixture
        .state
        .session_history(spec.owner.clone(), spec.session_id.clone())
}

fn source(message: &str, text: &str) -> RootSourceMessage {
    let content: MessageInput = text.into();
    RootSourceMessage {
        unprepared_content: content.clone(),
        message: DeliveredMessage {
            origin: None,
            message_id: message.into(),
            submitted_content_digest: content.content_digest().unwrap(),
            content,
        },
        submitted_placement: Placement::NextTurn,
        disposition: MessageDisposition::TurnStarted,
        submitted_intent: None,
    }
}

async fn stage_message(
    fixture: &NativeFixture,
    template: &(RunSpec, Vec<ContentBlob>),
    turn: &str,
    message: &str,
    text: &str,
) -> Admission {
    let mut spec = template.0.clone();
    spec.turn_id = turn.into();
    spec.trigger = Trigger::Message {
        message_id: message.into(),
    };
    let source = source(message, text);
    let input = ContentBlob::json(&RunInput::Message {
        content: text.into(),
        request_fingerprint: None,
        source_messages: vec![source.clone()],
    })
    .unwrap();
    let source = ContentBlob::json(&source).unwrap();
    let resources = ContentBlob::json(&json!({})).unwrap();
    spec.input = input.reference().clone();
    let mut contents = template.1.clone();
    contents.extend([input, source.clone(), resources.clone()]);
    let queue = fixture.state.queue();
    let before = queue.read(spec.session_id.clone()).await.unwrap();
    let request = RequestId(format!("request:{message}"));
    let command = QueueCommand {
        id: FactId::new(),
        at: NOW,
        expected_revision: before.revision,
        edit: QueueEdit::Enqueue {
            request: Box::new(PreparedRequest {
                id: request.clone(),
                message_id: message.into(),
                spec: spec.clone(),
                source: source.reference().clone(),
                resources: resources.reference().clone(),
                required_tools: Default::default(),
            }),
            placement: queue::Placement::Followup,
        },
    };
    let staged = queue
        .execute(spec.session_id.clone(), command, contents.clone())
        .await
        .unwrap();
    let admission = Admission::new(spec.clone(), NOW, contents).with_queue(Consume {
        session: spec.session_id,
        requests: vec![request],
        expected_revision: staged.revision,
    });
    admission
}

async fn message(
    fixture: &NativeFixture,
    template: &(RunSpec, Vec<ContentBlob>),
    turn: &str,
    id: &str,
    text: &str,
) -> Admission {
    let admission = stage_message(fixture, template, turn, id, text).await;
    fixture.state.admit(admission.clone()).await.unwrap();
    admission
}

async fn prepare_model(
    fixture: &NativeFixture,
    run: RunId,
    purpose: ModelPurpose,
) -> ModelAttemptId {
    let view = fixture.state.frontier(run).await.unwrap();
    let history = session_history(fixture, &view.spec);
    let input: RunInput = serde_json::from_slice(
        &fixture
            .state
            .content(run, view.spec.input.clone())
            .await
            .unwrap(),
    )
    .unwrap();
    let cut = match input {
        RunInput::Continuation { claim, .. } => {
            history.capture_at(claim.base.high_water).await.unwrap()
        }
        _ => history.capture_before(run).await.unwrap(),
    };
    let capture = ContentBlob::json(&RequestSource {
        cut: cut.clone(),
        current: history.capture().await.unwrap(),
        current_revision: view.revision,
    })
    .unwrap();
    let step = StepId::new();
    let attempt = ModelAttemptId::new();
    let (mut request, mut contents) = canonical::request(step);
    request.accounting.purpose = purpose;
    request.source_capture = capture.reference().clone();
    request.source_digest = cut.digest.clone();
    request.effective_source_digest = cut.digest;
    let request = ContentBlob::json(&request).unwrap();
    contents.extend([capture, request.clone()]);
    append(
        &fixture.state,
        run,
        vec![
            Change::new(
                Fact::StepPrepared {
                    step,
                    request: request.reference().clone(),
                    adjudications: vec![],
                },
                NOW,
            ),
            Change::new(Fact::ModelAttemptPrepared { attempt, step }, NOW),
            Change::new(
                Fact::ModelAttemptAdmitted {
                    attempt,
                    upstream: json!({"original": true}),
                },
                NOW,
            ),
        ],
        contents,
    )
    .await
    .unwrap();
    attempt
}

async fn close_model(state: &Store, run: RunId, attempt: ModelAttemptId, diagnostic: Option<&str>) {
    let failed = diagnostic.is_some();
    let mut facts = vec![
        Change::new(
            Fact::ModelClosed {
                attempt,
                outcome: if failed {
                    Outcome::Error
                } else {
                    Outcome::Success
                },
                diagnostic: diagnostic.map(str::to_owned),
                usage: Default::default(),
                protocol: if failed {
                    json!({})
                } else {
                    json!({"finishReason":"stop"})
                },
            },
            NOW,
        ),
        Change::new(
            Fact::ModelCleanupObserved {
                attempt,
                cleanup: OperationCleanup::Confirmed,
            },
            NOW,
        ),
    ];
    if failed {
        facts.push(Change::new(
            Fact::AttemptRecoveryRecorded {
                attempt,
                recovery: AttemptRecovery::FrozenRetrySafe { not_before: None },
            },
            NOW,
        ));
    }
    append(state, run, facts, vec![]).await.unwrap();
}

async fn complete(fixture: &NativeFixture, run: RunId) {
    let attempt = prepare_model(fixture, run, ModelPurpose::Main).await;
    close_model(&fixture.state, run, attempt, None).await;
    assert!(matches!(drive(&fixture.state, run, NOW).await,
        DriverExit::Terminal { run: actual, terminal: Terminal::Completed } if actual == run));
}

async fn claim(fixture: &NativeFixture, run: RunId, id: &str) -> ContinuationClaim {
    let view = fixture.state.frontier(run).await.unwrap();
    let facts = fixture.state.history(run, 0, 256).await.unwrap();
    let first = facts
        .iter()
        .find_map(|record| match record.fact {
            Fact::StepPrepared { step, .. } => Some(step),
            _ => None,
        })
        .unwrap();
    let request = fixture.state.request(run, first).await.unwrap();
    let capture: RequestSource = serde_json::from_slice(
        &fixture
            .state
            .content(run, request.source_capture)
            .await
            .unwrap(),
    )
    .unwrap();
    ContinuationClaim {
        id: id.into(),
        source: RunBoundary {
            execution: ExecutionIdentity {
                session_id: view.spec.session_id,
                turn_id: view.spec.turn_id,
                run_id: run,
            },
            high_water: view.revision,
            digest: maka_agent_engine::digest(&facts).unwrap(),
        },
        base: SessionBase {
            high_water: capture.cut.through_sequence,
            digest: capture.cut.digest,
        },
        replay: ReplayEvidence {
            version: REPLAY_VERSION,
            digest: request.request.digest,
            route_identity: request.recovery_contract.digest,
        },
    }
}

fn continuation(spec: &RunSpec, claim: ContinuationClaim, turn: &str) -> Admission {
    let source = claim.source.execution.run_id;
    let input = ContentBlob::json(&RunInput::Continuation {
        claim: Box::new(claim),
        request_fingerprint: maka_agent_facts::artifact::content_digest(
            b"explicit manual continuation",
        ),
    })
    .unwrap();
    let mut spec = spec.clone();
    spec.turn_id = turn.into();
    spec.trigger = Trigger::Continuation { source };
    spec.input = input.reference().clone();
    Admission::new(spec, NOW, vec![input])
}

fn change(record: &RecordedFact) -> Change {
    Change {
        id: record.id,
        at: record.at,
        fact: record.fact.clone(),
    }
}

#[tokio::test]
async fn canonical_claim_is_atomic_unique_and_preserves_the_entire_lineage_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let configuration = configuration(directory.path());
    let fixture = NativeFixture::open(directory.path(), configuration.clone())
        .await
        .unwrap();
    let template = session(&fixture, directory.path()).await;
    let prior = message(&fixture, &template, "prior", "prior-message", "prior").await;
    complete(&fixture, prior.run()).await;
    let source = message(&fixture, &template, "source", "origin-message", "source").await;
    complete(&fixture, source.run()).await;
    let original = claim(&fixture, source.run(), "claim-first").await;
    let history = session_history(&fixture, &template.0);
    let before = history.capture().await.unwrap();
    assert!(original.base.high_water > 0);
    let base = history.capture_at(original.base.high_water).await.unwrap();
    assert!(
        history
            .page(&base, 0, 256)
            .await
            .unwrap()
            .items
            .iter()
            .all(|item| item.recorded.run == prior.run())
    );
    assert_eq!(history.successor(source.run()).await.unwrap(), None);

    for mutation in 0..5 {
        let mut invalid = original.clone();
        let mut spec = template.0.clone();
        match mutation {
            0 => {
                invalid.source.digest = maka_agent_facts::artifact::content_digest(b"wrong source")
            }
            1 => invalid.base.digest = maka_agent_facts::artifact::content_digest(b"wrong base"),
            2 => invalid.source.execution.turn_id = "wrong-source-turn".into(),
            3 => spec.permission_basis.binding.id = Uuid::new_v4(),
            _ => spec.workspace.push_str("/not-the-selected-workspace"),
        }
        assert!(
            fixture
                .state
                .admit(continuation(&spec, invalid, "invalid"))
                .await
                .is_err()
        );
    }
    let mut invalid = original.clone();
    invalid.replay.version += 1;
    assert!(
        fixture
            .state
            .admit(continuation(&template.0, invalid, "invalid-version"))
            .await
            .is_err()
    );
    assert_eq!(history.capture().await.unwrap(), before);

    let first = continuation(&template.0, original.clone(), "first");
    let failing = first.clone().with_queue(Consume {
        session: template.0.session_id.clone(),
        requests: vec![RequestId("absent".into())],
        expected_revision: u64::MAX,
    });
    assert!(
        fixture.state.admit(failing).await.is_err(),
        "failed opening must roll back its continuation edge as well as the Run"
    );
    assert_eq!(history.successor(source.run()).await.unwrap(), None);
    assert!(fixture.state.find_run(first.run()).await.unwrap().is_none());
    assert_eq!(history.capture().await.unwrap(), before);
    assert!(!fixture.state.admission_recorded(&first).await.unwrap());

    let committed = fixture.state.admit(first.clone()).await.unwrap();
    assert!(fixture.state.admission_recorded(&first).await.unwrap());
    assert_eq!(
        history.successor(source.run()).await.unwrap(),
        Some(first.run())
    );
    complete(&fixture, first.run()).await;
    assert_eq!(
        fixture.state.admit(first.clone()).await.unwrap().facts,
        committed.facts,
        "exact original admission replay remains legal after sealing"
    );
    assert!(
        fixture
            .state
            .admit(continuation(&template.0, original.clone(), "duplicate"))
            .await
            .is_err()
    );
    let first_cut = history
        .fork_cut(ForkPosition::BeforeTurn {
            turn_id: "first".into(),
        })
        .await
        .unwrap();
    let through_first = history
        .fork_cut(ForkPosition::ThroughTurn {
            turn_id: "first".into(),
        })
        .await
        .unwrap();
    assert!(
        history
            .page(&first_cut, 0, 256)
            .await
            .unwrap()
            .items
            .iter()
            .all(|item| item.recorded.run != first.run())
    );
    assert!(
        history
            .page(&through_first, 0, 256)
            .await
            .unwrap()
            .items
            .iter()
            .any(|item| item.recorded.run == first.run())
    );

    let second_claim = claim(&fixture, first.run(), "claim-second").await;
    assert_eq!(
        second_claim.base, original.base,
        "manual continuation keeps the original frozen ancestry"
    );
    let second = continuation(&template.0, second_claim, "second");
    fixture.state.admit(second.clone()).await.unwrap();
    complete(&fixture, second.run()).await;
    let third_claim = claim(&fixture, second.run(), "claim-third").await;
    let unrelated = message(
        &fixture,
        &template,
        "unrelated",
        "unrelated-message",
        "unrelated",
    )
    .await;
    complete(&fixture, unrelated.run()).await;
    fixture
        .state
        .observe(
            source.run(),
            vec![Change::new(Fact::BudgetCharged { tokens: 1 }, NOW)],
            vec![],
        )
        .await
        .unwrap();
    assert!(
        fixture.state.admission_recorded(&first).await.unwrap(),
        "original confirmation never resamples a source after late evidence"
    );
    drop(history);
    fixture.shutdown().await.unwrap();

    let fixture = NativeFixture::open(directory.path(), configuration)
        .await
        .unwrap();
    let history = session_history(&fixture, &template.0);
    assert_eq!(
        history.successor(source.run()).await.unwrap(),
        Some(first.run())
    );
    assert_eq!(
        history.successor(first.run()).await.unwrap(),
        Some(second.run())
    );
    assert_eq!(
        fixture.state.admit(first.clone()).await.unwrap().facts,
        committed.facts
    );
    let third = continuation(&template.0, third_claim, "third");
    fixture.state.admit(third.clone()).await.unwrap();
    complete(&fixture, third.run()).await;
    assert_eq!(
        history.successor(second.run()).await.unwrap(),
        Some(third.run())
    );
    assert_eq!(
        fixture
            .state
            .queue()
            .resolve_message(template.0.session_id.clone(), "origin-message".into())
            .await
            .unwrap(),
        MessageResolution::Delivered {
            run: source.run(),
            shared: false
        },
        "message identity stays with its original logical Run, not an unrelated latest Turn"
    );
    let cut = history.rebuild().await.unwrap();
    assert_eq!(
        history.successor(source.run()).await.unwrap(),
        Some(first.run())
    );
    let mut users = 0;
    for item in history.page(&cut, 0, 256).await.unwrap().items {
        if matches!(item.recorded.fact, Fact::RunAdmitted { .. }) {
            let source = history.run_source(item.recorded.run).await.unwrap();
            let input: RunInput = serde_json::from_slice(
                &history
                    .content(source.run, &source.spec.input)
                    .await
                    .unwrap(),
            )
            .unwrap();
            users += usize::from(matches!(input, RunInput::Message { .. }));
        }
    }
    assert_eq!(
        users, 3,
        "explicit continuations do not fabricate user messages"
    );
    drop(history);
    fixture.shutdown().await.unwrap();
}

#[tokio::test]
async fn message_owner_rejects_new_competing_claim_and_preserves_owner_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let configuration = configuration(directory.path());
    let fixture = NativeFixture::open(directory.path(), configuration.clone())
        .await
        .unwrap();
    let template = session(&fixture, directory.path()).await;
    let source = message(&fixture, &template, "source", "origin-message", "source").await;
    complete(&fixture, source.run()).await;
    let original = claim(&fixture, source.run(), "valid-claim").await;
    let successor = continuation(&template.0, original.clone(), "successor");
    fixture.state.admit(successor.clone()).await.unwrap();
    complete(&fixture, successor.run()).await;
    let history = session_history(&fixture, &template.0);
    let before = history.capture().await.unwrap();
    let mut competing = original;
    competing.id = "competing-claim".into();
    competing.source.high_water += 1;
    assert!(
        fixture
            .state
            .admit(continuation(&template.0, competing, "competitor"))
            .await
            .is_err()
    );
    assert_eq!(history.capture().await.unwrap(), before);
    assert_eq!(
        history.successor(source.run()).await.unwrap(),
        Some(successor.run())
    );
    let owner = fixture
        .state
        .queue()
        .resolve_message(template.0.session_id.clone(), "origin-message".into())
        .await
        .unwrap();
    assert_eq!(
        owner,
        MessageResolution::Delivered {
            run: source.run(),
            shared: false
        }
    );
    drop(history);
    fixture.shutdown().await.unwrap();

    let fixture = NativeFixture::open(directory.path(), configuration)
        .await
        .unwrap();
    let history = session_history(&fixture, &template.0);
    assert_eq!(history.capture().await.unwrap(), before);
    assert_eq!(
        history.successor(source.run()).await.unwrap(),
        Some(successor.run())
    );
    assert_eq!(
        fixture
            .state
            .queue()
            .resolve_message(template.0.session_id.clone(), "origin-message".into())
            .await
            .unwrap(),
        owner
    );
    assert!(fixture.state.admission_recorded(&successor).await.unwrap());
    drop(history);
    fixture.shutdown().await.unwrap();
}

#[tokio::test]
async fn handoff_claim_preserves_turn_and_frozen_ancestry_without_releasing_reserved_identity() {
    let directory = tempfile::tempdir().unwrap();
    let configuration = configuration(directory.path());
    let fixture = NativeFixture::open(directory.path(), configuration.clone())
        .await
        .unwrap();
    let template = session(&fixture, directory.path()).await;
    let root = message(&fixture, &template, "stable-turn", "root-message", "root").await;
    let attempt = prepare_model(&fixture, root.run(), ModelPurpose::Main).await;
    close_model(&fixture.state, root.run(), attempt, None).await;
    let before = fixture.state.history(root.run(), 0, 256).await.unwrap();
    let view = fixture.state.frontier(root.run()).await.unwrap();
    let frozen = fixture
        .state
        .request(root.run(), view.current_step.unwrap())
        .await
        .unwrap();
    for _ in 0..2 {
        let retired = fixture.state.claim(root.run()).await.unwrap();
        let live = fixture.state.claim(root.run()).await.unwrap();
        assert!(fixture.state.driver_frontier(&retired).await.is_err());
        assert_eq!(
            fixture
                .state
                .driver_frontier(&live)
                .await
                .unwrap()
                .spec
                .turn_id,
            "stable-turn"
        );
        assert!(
            fixture
                .state
                .append(
                    &retired,
                    (&view).into(),
                    vec![Change::new(Fact::BudgetCharged { tokens: 99 }, NOW)],
                    vec![]
                )
                .await
                .is_err(),
            "an old physical owner cannot mutate the replacement's frontier"
        );
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert!(
            matches!(Engine::new(fixture.state.clone()).drive(live, Arc::new(NoEffects(NOW)), cancellation).await.unwrap(),
            DriverExit::Retired { run } if run == root.run())
        );
        assert_eq!(
            fixture.state.history(root.run(), 0, 256).await.unwrap(),
            before
        );
    }
    assert_eq!(
        fixture
            .state
            .runs(template.0.session_id.clone(), None, 10)
            .await
            .unwrap(),
        vec![root.run()]
    );
    assert!(
        session_history(&fixture, &template.0)
            .successor(root.run())
            .await
            .unwrap()
            .is_none(),
        "physical retirement does not reserve a logical successor"
    );
    assert_eq!(
        fixture
            .state
            .request(root.run(), view.current_step.unwrap())
            .await
            .unwrap(),
        frozen
    );
    fixture.shutdown().await.unwrap();

    let fixture = NativeFixture::open(directory.path(), configuration)
        .await
        .unwrap();
    assert_eq!(
        fixture.state.history(root.run(), 0, 256).await.unwrap(),
        before
    );
    assert_eq!(
        fixture.state.frontier(root.run()).await.unwrap().spec,
        view.spec
    );
    assert_eq!(
        fixture
            .state
            .request(root.run(), view.current_step.unwrap())
            .await
            .unwrap(),
        frozen
    );
    assert!(matches!(
        drive(&fixture.state, root.run(), NOW).await,
        DriverExit::Terminal {
            terminal: Terminal::Completed,
            ..
        }
    ));
    let inherited = claim(&fixture, root.run(), "manual").await;
    let manual = continuation(&template.0, inherited.clone(), "manual-turn");
    fixture.state.admit(manual.clone()).await.unwrap();
    complete(&fixture, manual.run()).await;
    let actual = fixture.state.frontier(manual.run()).await.unwrap();
    assert_eq!(
        actual.spec.turn_id, "manual-turn",
        "only explicit manual continuation starts a fresh logical Turn"
    );
    let prepared = fixture
        .state
        .request(manual.run(), actual.current_step.unwrap())
        .await
        .unwrap();
    let capture: RequestSource = serde_json::from_slice(
        &fixture
            .state
            .content(manual.run(), prepared.source_capture)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(capture.cut.through_sequence, inherited.base.high_water);
    assert_eq!(capture.cut.digest, inherited.base.digest);
    fixture.shutdown().await.unwrap();
}

#[tokio::test]
async fn paused_cancellation_claim_is_atomic_idempotent_and_never_cancels_an_existing_owner() {
    for already_claimed in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let configuration = configuration(directory.path());
        let fixture = NativeFixture::open(directory.path(), configuration.clone())
            .await
            .unwrap();
        let template = session(&fixture, directory.path()).await;
        let root = message(
            &fixture,
            &template,
            "source",
            "large-original-message",
            &"x".repeat(600 * 1024),
        )
        .await;
        let original = fixture.state.frontier(root.run()).await.unwrap();
        assert!(
            original.spec.input.bytes > 1024 * 1024 && original.spec.input.bytes < 8 * 1024 * 1024
        );
        let admission = fixture
            .state
            .fact_barrier(root.run(), root.fact_id())
            .await
            .unwrap()
            .unwrap();
        let history_before = fixture.state.history(root.run(), 0, 128).await.unwrap();
        let retired = fixture.state.claim(root.run()).await.unwrap();
        let live = if already_claimed {
            Some(fixture.state.claim(root.run()).await.unwrap())
        } else {
            None
        };
        let stop = Change::new(
            Fact::StopRequested {
                diagnostic: "original user Stop".into(),
            },
            NOW,
        );
        assert!(
            fixture
                .state
                .control(
                    root.run(),
                    (&original).into(),
                    vec![
                        stop.clone(),
                        Change::new(
                            Fact::RiskAdjudicated {
                                blocker: BlockerId::new(),
                                scope: RiskActionScope::RunCancellation,
                                decision: RiskDecision::CancelBlockedRun {
                                    diagnostic: "absent blocker".into()
                                },
                            },
                            NOW
                        ),
                    ],
                    vec![]
                )
                .await
                .is_err(),
            "failure after applying Stop must roll the whole transaction back"
        );
        assert_eq!(
            fixture.state.history(root.run(), 0, 128).await.unwrap(),
            history_before
        );
        let (first, retry) = tokio::join!(
            fixture
                .state
                .control(root.run(), (&original).into(), vec![stop.clone()], vec![]),
            fixture
                .state
                .control(root.run(), (&original).into(), vec![stop.clone()], vec![]),
        );
        let first = first.unwrap();
        let retry = retry.unwrap();
        assert_eq!(
            first.facts, retry.facts,
            "one exact Stop identity retains its original attribution"
        );
        let stopped = fixture.state.frontier(root.run()).await.unwrap();
        assert!(stopped.stopped);
        assert!(
            stopped.terminal.is_none(),
            "control does not fabricate the current worker's settlement"
        );
        if already_claimed {
            assert!(fixture.state.driver_frontier(&retired).await.is_err());
        }
        let live = live.unwrap_or(retired);
        assert!(
            matches!(Engine::new(fixture.state.clone()).drive(live, Arc::new(NoEffects(NOW)), CancellationToken::new()).await.unwrap(),
            DriverExit::Terminal { run, terminal: Terminal::Cancelled } if run == root.run())
        );
        let records = fixture.state.history(root.run(), 0, 128).await.unwrap();
        assert_eq!(
            records
                .iter()
                .filter(|r| matches!(r.fact, Fact::RunAdmitted { .. }))
                .count(),
            1
        );
        assert_eq!(
            records
                .iter()
                .filter(|r| matches!(r.fact, Fact::RunTerminated { .. }))
                .count(),
            1
        );
        assert_eq!(
            records
                .iter()
                .filter(|r| matches!(
                    r.fact,
                    Fact::ModelAttemptAdmitted { .. } | Fact::ToolAdmitted { .. }
                ))
                .count(),
            0
        );
        assert_eq!(
            fixture
                .state
                .fact_barrier(root.run(), root.fact_id())
                .await
                .unwrap(),
            Some(admission.clone())
        );
        assert!(
            session_history(&fixture, &template.0)
                .successor(root.run())
                .await
                .unwrap()
                .is_none()
        );
        let later = message(&fixture, &template, "later-turn", "later-message", "later").await;
        let later_before = fixture.state.frontier(later.run()).await.unwrap();
        fixture.shutdown().await.unwrap();

        let fixture = NativeFixture::open(directory.path(), configuration)
            .await
            .unwrap();
        let old = fixture.state.frontier(root.run()).await.unwrap();
        assert_eq!(
            fixture
                .state
                .control(root.run(), (&old).into(), vec![stop], vec![])
                .await
                .unwrap()
                .facts,
            first.facts
        );
        let later_after = fixture.state.frontier(later.run()).await.unwrap();
        assert_eq!(later_after.revision, later_before.revision);
        assert!(!later_after.stopped);
        assert!(
            later_after.terminal.is_none(),
            "replaying an old Turn Stop never targets today's latest Run"
        );
        assert_eq!(
            fixture
                .state
                .fact_barrier(root.run(), root.fact_id())
                .await
                .unwrap(),
            Some(admission)
        );
        complete(&fixture, later.run()).await;
        fixture.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn handoff_rejects_unresolved_provider_effects_but_accepts_effect_free_summary_failure() {
    for provider_effect in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let fixture = NativeFixture::open(directory.path(), configuration(directory.path()))
            .await
            .unwrap();
        let mut template = session(&fixture, directory.path()).await;
        template.0.budget.retries = 0;
        let prior = message(&fixture, &template, "prior", "prior-message", "prior").await;
        complete(&fixture, prior.run()).await;
        let root = message(&fixture, &template, "source", "source-message", "source").await;
        let attempt = prepare_model(
            &fixture,
            root.run(),
            if provider_effect {
                ModelPurpose::Main
            } else {
                ModelPurpose::Summary
            },
        )
        .await;
        assert!(
            append(
                &fixture.state,
                root.run(),
                vec![Change::new(
                    Fact::RunTerminated {
                        terminal: Terminal::Completed,
                        diagnostic: None,
                    },
                    NOW
                )],
                vec![]
            )
            .await
            .is_err(),
            "an open original request cannot be sealed by physical retirement"
        );
        if provider_effect {
            append(
                &fixture.state,
                root.run(),
                vec![
                    Change::new(
                        Fact::ModelObserved {
                            attempt,
                            index: 0,
                            continuation: None,
                            part: ModelPart::ToolCall {
                                call: ModelToolCall {
                                    id: "remote".into(),
                                    name: "search".into(),
                                    input: json!({}).into(),
                                    provider_options: None,
                                    provider_executed: true,
                                },
                            },
                        },
                        NOW,
                    ),
                    Change::new(
                        Fact::ModelInterrupted {
                            attempt,
                            diagnostic: "transport ended before remote result".into(),
                        },
                        NOW,
                    ),
                    Change::new(
                        Fact::AttemptRecoveryRecorded {
                            attempt,
                            recovery: AttemptRecovery::Blocked {
                                diagnostic: "original remote effect unknown".into(),
                            },
                        },
                        NOW,
                    ),
                    Change::new(
                        Fact::ModelCleanupObserved {
                            attempt,
                            cleanup: OperationCleanup::Confirmed,
                        },
                        NOW,
                    ),
                ],
                vec![],
            )
            .await
            .unwrap();
            assert!(matches!(drive(&fixture.state, root.run(), NOW).await,
                DriverExit::Blocked { blockers, .. } if blockers.iter().any(|(_, reason)|
                    matches!(reason, BlockerKind::ProviderEffectUnknown { attempt: original, call } if *original == attempt && call == "remote"))));
            let view = fixture.state.frontier(root.run()).await.unwrap();
            assert!(
                append(
                    &fixture.state,
                    root.run(),
                    vec![Change::new(
                        Fact::ModelAttemptPrepared {
                            attempt: ModelAttemptId::new(),
                            step: view.current_step.unwrap(),
                        },
                        NOW
                    )],
                    vec![]
                )
                .await
                .is_err(),
                "unknown T1 cannot authorize another generation"
            );
            assert!(
                append(
                    &fixture.state,
                    root.run(),
                    vec![Change::new(
                        Fact::RunTerminated {
                            terminal: Terminal::Failed,
                            diagnostic: None,
                        },
                        NOW
                    )],
                    vec![]
                )
                .await
                .is_err(),
                "interruption has not settled the provider effect"
            );
            let stop = Change::new(
                Fact::StopRequested {
                    diagnostic: "user Stop".into(),
                },
                NOW,
            );
            fixture
                .state
                .control(root.run(), (&view).into(), vec![stop], vec![])
                .await
                .unwrap();
            assert!(matches!(
                drive(&fixture.state, root.run(), NOW).await,
                DriverExit::Blocked { .. }
            ));
            let before = fixture.state.history(root.run(), 0, 128).await.unwrap();
            assert_eq!(
                before
                    .iter()
                    .filter(|r| matches!(r.fact, Fact::ModelAttemptAdmitted { .. }))
                    .count(),
                1
            );
            assert!(
                session_history(&fixture, &template.0)
                    .successor(root.run())
                    .await
                    .unwrap()
                    .is_none()
            );
            // Only the original admitted provider observation discharges T1;
            // neither Stop, driver replacement nor missing transport is proof.
            fixture
                .state
                .observe(
                    root.run(),
                    vec![
                        Change::new(
                            Fact::ModelObserved {
                                attempt,
                                index: 1,
                                continuation: None,
                                part: ModelPart::ToolResult {
                                    id: "remote".into(),
                                    name: "search".into(),
                                    output: json!({"settled": true}),
                                    is_error: false,
                                    provider_options: None,
                                },
                            },
                            NOW,
                        ),
                        Change::new(
                            Fact::ModelClosed {
                                attempt,
                                outcome: Outcome::Success,
                                diagnostic: None,
                                usage: Default::default(),
                                protocol: json!({"finishReason":"stop"}),
                            },
                            NOW,
                        ),
                    ],
                    vec![],
                )
                .await
                .unwrap();
            assert!(matches!(drive(&fixture.state, root.run(), NOW).await,
                DriverExit::Terminal { run, terminal: Terminal::Cancelled } if run == root.run()));
            let after = fixture.state.history(root.run(), 0, 128).await.unwrap();
            assert_eq!(
                after
                    .iter()
                    .filter(|r| matches!(r.fact, Fact::ModelAttemptAdmitted { .. }))
                    .count(),
                1
            );
            assert_eq!(
                after
                    .iter()
                    .filter(|r| matches!(r.fact, Fact::ToolAdmitted { .. }))
                    .count(),
                0
            );
            assert_eq!(
                after
                    .iter()
                    .filter(|r| matches!(r.fact, Fact::ToolResultAccepted { .. }))
                    .count(),
                1
            );
        } else {
            close_model(
                &fixture.state,
                root.run(),
                attempt,
                Some("summary failed without effects"),
            )
            .await;
            assert!(matches!(drive(&fixture.state, root.run(), NOW).await,
                DriverExit::Terminal { run, terminal: Terminal::Failed } if run == root.run()));
            assert!(
                fixture
                    .state
                    .frontier(root.run())
                    .await
                    .unwrap()
                    .tools
                    .is_empty()
            );
        }
        let later = message(
            &fixture,
            &template,
            "fresh-message",
            "fresh-message",
            "fresh",
        )
        .await;
        complete(&fixture, later.run()).await;
        assert!(
            session_history(&fixture, &template.0)
                .successor(root.run())
                .await
                .unwrap()
                .is_none(),
            "a fresh message is not a physical handoff successor"
        );
        assert_eq!(
            fixture
                .state
                .runs(template.0.session_id.clone(), None, 10)
                .await
                .unwrap()
                .len(),
            3
        );
        fixture.shutdown().await.unwrap();
    }
}

fn historical(template: &(RunSpec, Vec<ContentBlob>), turn: &str) -> Admission {
    use maka_agent_facts::history_snapshot::{Manifest, Origin, SNAPSHOT_VERSION, SnapshotId};
    let fingerprint =
        ContentBlob::json(&json!({"foreignOpening": turn, "physicalPause": true})).unwrap();
    let manifest = ContentBlob::json(&Manifest {
        version: SNAPSHOT_VERSION,
        id: SnapshotId::new(),
        origin: Origin::Imported {
            source: maka_agent_facts::import::Source {
                adapter: "fixture".into(),
                session_id: "foreign-session".into(),
            },
            fingerprint: fingerprint.reference().clone(),
        },
        inventory: None,
        objects: 0,
    })
    .unwrap();
    let input = ContentBlob::json(&RunInput::HistorySource {
        source: manifest.reference().clone(),
    })
    .unwrap();
    let mut spec = template.0.clone();
    spec.origin = RunOrigin::Imported {
        source: manifest.reference().clone(),
    };
    spec.backend = BackendSpec::Historical {};
    spec.trigger = Trigger::HistorySource;
    spec.turn_id = turn.into();
    spec.input = input.reference().clone();
    let mut contents = template.1.clone();
    contents.extend([fingerprint, manifest, input]);
    Admission::new(spec, NOW, contents)
}

#[tokio::test]
async fn foreign_openings_and_pauses_remain_evidence_without_local_recovery_or_reservations() {
    let directory = tempfile::tempdir().unwrap();
    let configuration = configuration(directory.path());
    let fixture = NativeFixture::open(directory.path(), configuration.clone())
        .await
        .unwrap();
    let paused_template = session(&fixture, directory.path()).await;
    let proof_template = session(&fixture, directory.path()).await;
    let local_template = session(&fixture, directory.path()).await;
    let paused = historical(&paused_template, "foreign-paused");
    let proof = historical(&proof_template, "foreign-proof");
    fixture.state.admit(paused.clone()).await.unwrap();
    fixture.state.admit(proof.clone()).await.unwrap();
    let local = message(&fixture, &local_template, "local", "local-message", "local").await;
    let paused_before = fixture.state.history(paused.run(), 0, 128).await.unwrap();
    let proof_before = fixture.state.history(proof.run(), 0, 128).await.unwrap();
    let owner = local_template.0.owner.clone();
    assert_eq!(
        fixture
            .state
            .ready_runs(owner.clone(), NOW, None, 10)
            .await
            .unwrap()
            .iter()
            .map(|r| r.run)
            .collect::<Vec<_>>(),
        vec![local.run()]
    );
    fixture.shutdown().await.unwrap();

    let fixture = NativeFixture::open(directory.path(), configuration)
        .await
        .unwrap();
    assert_eq!(
        fixture
            .state
            .ready_runs(owner.clone(), NOW, None, 10)
            .await
            .unwrap()
            .iter()
            .map(|r| r.run)
            .collect::<Vec<_>>(),
        vec![local.run()]
    );
    for run in [paused.run(), proof.run()] {
        assert!(
            fixture.state.claim(run).await.is_err(),
            "a foreign opening cannot be adopted by a local physical driver"
        );
        assert!(
            fixture
                .state
                .admission_recorded(if run == paused.run() { &paused } else { &proof })
                .await
                .unwrap()
        );
    }
    assert_eq!(
        fixture.state.history(paused.run(), 0, 128).await.unwrap(),
        paused_before
    );
    assert_eq!(
        fixture.state.history(proof.run(), 0, 128).await.unwrap(),
        proof_before
    );
    assert!(
        session_history(&fixture, &paused_template.0)
            .successor(paused.run())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        session_history(&fixture, &proof_template.0)
            .successor(proof.run())
            .await
            .unwrap()
            .is_none()
    );
    complete(&fixture, local.run()).await;
    let fresh = stage_message(&fixture, &proof_template, "fresh", "new-message", "fresh").await;
    let queue_before = fixture
        .state
        .queue()
        .read(proof_template.0.session_id.clone())
        .await
        .unwrap();
    let old = fixture.state.frontier(proof.run()).await.unwrap();
    let foreign_steering = fixture
        .state
        .queue()
        .execute(
            proof_template.0.session_id.clone(),
            QueueCommand {
                id: FactId::new(),
                at: NOW,
                expected_revision: queue_before.revision,
                edit: QueueEdit::Promote {
                    request: RequestId("request:new-message".into()),
                    target: queue::SteeringTarget {
                        run: proof.run(),
                        expected_head: (&old).into(),
                    },
                },
            },
            vec![],
        )
        .await;
    assert!(foreign_steering.is_err());
    assert_eq!(
        fixture
            .state
            .queue()
            .read(proof_template.0.session_id.clone())
            .await
            .unwrap(),
        queue_before,
        "a foreign interrupt cannot redirect today's queue owner"
    );
    fixture.state.admit(fresh.clone()).await.unwrap();
    assert_eq!(
        fixture
            .state
            .queue()
            .resolve_message(proof_template.0.session_id.clone(), "new-message".into())
            .await
            .unwrap(),
        MessageResolution::Delivered {
            run: fresh.run(),
            shared: false
        }
    );
    complete(&fixture, fresh.run()).await;
    let after_pause = message(
        &fixture,
        &paused_template,
        "after-pause",
        "after-pause",
        "after-pause",
    )
    .await;
    complete(&fixture, after_pause.run()).await;
    assert!(
        fixture
            .state
            .ready_runs(owner, NOW, None, 10)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fixture.state.history(paused.run(), 0, 128).await.unwrap(),
        paused_before
    );
    assert_eq!(
        fixture.state.history(proof.run(), 0, 128).await.unwrap(),
        proof_before
    );
    fixture.shutdown().await.unwrap();
}
