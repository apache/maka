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

use crate::support::{canonical as c, native::NativeFixture};
use futures_util::future::BoxFuture;
use maka_agent_engine::{DriverExit, Engine, ModelWitness, RunError, ports::*};
use maka_agent_facts::{
    accounting::Outcome,
    context::{ModelClosureProtocol, ModelPurpose, SummaryResult, TextSummary},
    durable::*,
    history_snapshot::RequestSource,
    model::{ModelFinishReason, ModelPart, ModelToolCall, TextKind, ToolInput},
};
use maka_agent_state::{
    Admission, Change, ContentBlob,
    fold::{RunView, Tool},
};
use maka_plugin_core::operation::{OperationReply, RecoveryRef};
use serde_json::json;
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

// Preparation is observable, but this storage fixture has no capability to send
// a model request. All other ports retain the shared NoEffects boundary.
struct PreparationBoundary {
    clock: c::NoEffects,
    preparations: Mutex<Vec<Preparation>>,
}
impl DriverPorts for PreparationBoundary {
    fn external(&self) -> Option<Arc<dyn ExternalPorts>> {
        self.clock.external()
    }
    fn cells(&self) -> Option<Arc<dyn CellPorts>> {
        self.clock.cells()
    }
    fn publication(&self) -> Option<Arc<dyn ExternalPublicationPorts>> {
        self.clock.publication()
    }
    fn now(&self) -> UnixMillis {
        self.clock.now()
    }
    fn prepare_step<'a>(
        &'a self,
        _: &'a RunView,
        preparation: Preparation,
    ) -> BoxFuture<'a, Result<PreparedStep, RunError>> {
        self.preparations.lock().unwrap().push(preparation);
        Box::pin(async {
            Err(RunError::Blocked(BlockerKind::UnsupportedProtocol {
                protocol: "fixture: preparation observed without dispatch authority".into(),
                version: 1,
            }))
        })
    }
    fn assess_recovery<'a>(
        &'a self,
        view: &'a RunView,
        attempt: ModelAttemptId,
        request: RequestSpec,
    ) -> BoxFuture<'a, Result<RecoveryEvidence, RunError>> {
        self.clock.assess_recovery(view, attempt, request)
    }
    fn validate_transport_selection<'a>(
        &'a self,
        view: &'a RunView,
        attempt: ModelAttemptId,
        phase: maka_agent_facts::model::retry_transport::RetryTransportPhase,
    ) -> BoxFuture<'a, Result<(), RunError>> {
        self.clock
            .validate_transport_selection(view, attempt, phase)
    }
    fn start_model(
        &self,
        run: RunId,
        attempt: ModelAttemptId,
        request: RequestSpec,
        bytes: Vec<u8>,
        witness: ModelWitness,
    ) -> BoxFuture<'_, Result<ModelConnection, RunError>> {
        self.clock
            .start_model(run, attempt, request, bytes, witness)
    }
    fn observe_model(
        &self,
        run: RunId,
        attempt: ModelAttemptId,
        descriptor: ContentRef,
        after: u64,
        witness: ModelWitness,
    ) -> BoxFuture<'_, Result<ModelConnection, RunError>> {
        self.clock
            .observe_model(run, attempt, descriptor, after, witness)
    }
    fn decide_tool<'a>(
        &'a self,
        view: &'a RunView,
        tool: &'a Tool,
    ) -> BoxFuture<'a, Result<PreparedDecision, RunError>> {
        self.clock.decide_tool(view, tool)
    }
    fn validate_tool<'a>(
        &'a self,
        view: &'a RunView,
        tool: &'a Tool,
    ) -> BoxFuture<'a, Result<ToolValidation, RunError>> {
        self.clock.validate_tool(view, tool)
    }
    fn lookup_original(
        &self,
        run: RunId,
        key: ToolKey,
    ) -> BoxFuture<'_, Result<OriginalLookup, RunError>> {
        self.clock.lookup_original(run, key)
    }
    fn dispatch_tool(
        &self,
        run: RunId,
        tool: Tool,
    ) -> BoxFuture<'_, Result<DispatchOutcome, RunError>> {
        self.clock.dispatch_tool(run, tool)
    }
    fn observe_operation(
        &self,
        reference: RecoveryRef,
    ) -> BoxFuture<'_, Result<OperationReply, RunError>> {
        self.clock.observe_operation(reference)
    }
    fn cancel_live(&self, run: RunId) {
        self.clock.cancel_live(run)
    }
    fn cancel_model(
        &self,
        run: RunId,
        attempt: ModelAttemptId,
    ) -> BoxFuture<'_, Result<(), RunError>> {
        self.clock.cancel_model(run, attempt)
    }
}

async fn drive(f: &NativeFixture, run: RunId, at: i64) -> (DriverExit, Vec<Preparation>) {
    let ports = Arc::new(PreparationBoundary {
        clock: c::NoEffects(UnixMillis(at)),
        preparations: Mutex::new(vec![]),
    });
    let exit = Engine::new(f.state.clone())
        .drive(
            f.state.claim(run).await.unwrap(),
            ports.clone(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let preparations = std::mem::take(&mut *ports.preparations.lock().unwrap());
    (exit, preparations)
}

async fn record(
    f: &NativeFixture,
    run: RunId,
    at: i64,
    facts: Vec<Fact>,
    contents: Vec<ContentBlob>,
) {
    c::append(
        &f.state,
        run,
        facts
            .into_iter()
            .map(|fact| Change::new(fact, UnixMillis(at)))
            .collect(),
        contents,
    )
    .await
    .unwrap();
}

async fn admit(f: &NativeFixture, workspace: &Path, session: &str, turn: &str) -> RunId {
    let (spec, contents) = c::spec(f, workspace, session, turn, "original message");
    let admission = Admission::new(spec, UnixMillis(1), contents);
    let run = admission.run();
    f.state.admit(admission).await.unwrap();
    run
}

async fn request(
    f: &NativeFixture,
    run: RunId,
    purpose: ModelPurpose,
) -> (RequestSpec, Vec<ContentBlob>) {
    let view = f.state.frontier(run).await.unwrap();
    let history = f
        .state
        .session_history(view.spec.owner, view.spec.session_id);
    let cut = history.capture().await.unwrap();
    let source = ContentBlob::json(&RequestSource {
        cut: cut.clone(),
        current: cut.clone(),
        current_revision: view.revision,
    })
    .unwrap();
    let (mut request, mut contents) = c::request(StepId::new());
    request.accounting.purpose = purpose;
    request.source_capture = source.reference().clone();
    request.source_digest = cut.digest.clone();
    request.effective_source_digest = cut.digest;
    contents.push(source);
    (request, contents)
}

async fn prepare(
    f: &NativeFixture,
    run: RunId,
    request: &RequestSpec,
    mut contents: Vec<ContentBlob>,
    at: i64,
) {
    let body = ContentBlob::json(request).unwrap();
    contents.push(body.clone());
    record(
        f,
        run,
        at,
        vec![Fact::StepPrepared {
            step: request.step,
            request: body.reference().clone(),
            adjudications: vec![],
        }],
        contents,
    )
    .await;
}

async fn model(f: &NativeFixture, run: RunId, step: StepId, at: i64) -> ModelAttemptId {
    let attempt = ModelAttemptId::new();
    record(
        f,
        run,
        at,
        vec![
            Fact::ModelAttemptPrepared { attempt, step },
            Fact::ModelAttemptAdmitted {
                attempt,
                upstream: json!({"original":true}),
            },
        ],
        vec![],
    )
    .await;
    attempt
}

fn protocol(summary: Option<SummaryResult>) -> serde_json::Value {
    serde_json::to_value(ModelClosureProtocol {
        finish_reason: if matches!(&summary, Some(SummaryResult::Incomplete)) {
            ModelFinishReason::Length
        } else {
            ModelFinishReason::Stop
        },
        provider_options: None,
        response_id: None,
        model: None,
        timestamp: None,
        compaction: None,
        summary,
    })
    .unwrap()
}

async fn close_summary(
    f: &NativeFixture,
    run: RunId,
    attempt: ModelAttemptId,
    summary: SummaryResult,
    at: i64,
) {
    record(
        f,
        run,
        at,
        vec![
            Fact::ModelClosed {
                attempt,
                outcome: Outcome::Success,
                diagnostic: None,
                usage: Default::default(),
                protocol: protocol(Some(summary)),
            },
            Fact::ModelCleanupObserved {
                attempt,
                cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
            },
        ],
        vec![],
    )
    .await;
}

fn call() -> ModelPart {
    ModelPart::ToolCall {
        call: ModelToolCall {
            id: "same-call".into(),
            name: "remote-search".into(),
            input: ToolInput::Json(json!({})),
            provider_options: None,
            provider_executed: true,
        },
    }
}
fn result() -> ModelPart {
    ModelPart::ToolResult {
        id: "same-call".into(),
        name: "remote-search".into(),
        output: json!({"done":true}),
        is_error: false,
        provider_options: None,
    }
}
fn text(options: bool) -> ModelPart {
    ModelPart::Text {
        text_kind: TextKind::Text,
        text: "known partial".into(),
        provider_options: options
            .then(|| Arc::new(json!({"signature":"original opaque provider state"}))),
    }
}

async fn interrupted(
    f: &NativeFixture,
    run: RunId,
    parts: Vec<ModelPart>,
    recovery: AttemptRecovery,
    at: i64,
    mut contents: Vec<ContentBlob>,
) -> ModelAttemptId {
    let (request, request_contents) = request(f, run, ModelPurpose::Main).await;
    prepare(f, run, &request, request_contents, at).await;
    let attempt = model(f, run, request.step, at).await;
    let mut facts: Vec<_> = parts
        .into_iter()
        .enumerate()
        .map(|(index, part)| Fact::ModelObserved {
            attempt,
            index: index as u64,
            part,
            continuation: None,
        })
        .collect();
    facts.extend([
        Fact::ModelInterrupted {
            attempt,
            diagnostic: "original stream interrupted".into(),
        },
        Fact::AttemptRecoveryRecorded { attempt, recovery },
        Fact::ModelCleanupObserved {
            attempt,
            cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
        },
    ]);
    record(f, run, at, facts, std::mem::take(&mut contents)).await;
    attempt
}

#[tokio::test]
async fn active_cuts_require_settled_effects_or_explicit_retry_safety() {
    for (provider, retryable, barrier, safe) in [
        (false, false, false, false),
        (false, true, false, true),
        (false, true, true, false),
        (true, false, false, false),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let f = NativeFixture::open(directory.path(), c::configuration())
            .await
            .unwrap();
        let session = f
            .create("Active original source", directory.path(), None)
            .await
            .unwrap();
        let run = admit(&f, directory.path(), &session, "active").await;
        let proof =
            ContentBlob::json(&json!({"originalAdapterProof":"opaque, not execution authority"}))
                .unwrap();
        let recovery = if safe {
            AttemptRecovery::ProjectPrefixSafe {
                prefix: proof.reference().clone(),
                not_before: Some(UnixMillis(1000)),
            }
        } else if retryable {
            AttemptRecovery::FrozenRetrySafe {
                not_before: Some(UnixMillis(1000)),
            }
        } else {
            AttemptRecovery::Blocked {
                diagnostic: "adapter cannot prove a replay-safe continuation".into(),
            }
        };
        let attempt = interrupted(
            &f,
            run,
            vec![if provider { call() } else { text(barrier) }],
            recovery,
            2,
            vec![proof],
        )
        .await;
        let (exit, preparations) = drive(&f, run, 3).await;
        assert!(
            preparations.is_empty(),
            "unsafe or backed-off source must not dispatch fresh preparation"
        );
        assert_eq!(matches!(exit, DriverExit::Waiting { .. }), safe);
        if !safe {
            assert!(matches!(exit, DriverExit::Blocked { .. }));
        }
        let view = f.state.frontier(run).await.unwrap();
        assert!(view.baseline.is_none());
        assert_eq!(view.attempts.len(), 1);
        if provider {
            assert!(view.blockers.values().any(|b| matches!(&b.reason, BlockerKind::ProviderEffectUnknown { attempt: original, .. } if *original == attempt)));
        }
        let (next, mut contents) = request(&f, run, ModelPurpose::Summary).await;
        let body = ContentBlob::json(&next).unwrap();
        contents.push(body.clone());
        assert!(
            c::append(
                &f.state,
                run,
                vec![Change::new(
                    Fact::StepPrepared {
                        step: next.step,
                        request: body.reference().clone(),
                        adjudications: vec![]
                    },
                    UnixMillis(4)
                )],
                contents
            )
            .await
            .is_err(),
            "a raw new Step cannot bypass the original replay or provider-backoff fence"
        );
        f.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn private_summary_failure_allows_main_progress_only_without_provider_effects() {
    for provider_effect in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let f = NativeFixture::open(directory.path(), c::configuration())
            .await
            .unwrap();
        let session = f
            .create("Private Summary recovery", directory.path(), None)
            .await
            .unwrap();
        let run = admit(&f, directory.path(), &session, "active").await;
        let (main, contents) = request(&f, run, ModelPurpose::Main).await;
        prepare(&f, run, &main, contents, 2).await;
        let mut summary = main.clone();
        summary.step = StepId::new();
        summary.accounting.purpose = ModelPurpose::Summary;
        prepare(&f, run, &summary, vec![], 3).await;
        let attempt = model(&f, run, summary.step, 3).await;
        let verdict = if provider_effect {
            SummaryResult::ProviderEffectsUnknown {
                calls: ["remote".into()].into_iter().collect(),
            }
        } else {
            SummaryResult::Incomplete
        };
        close_summary(&f, run, attempt, verdict, 4).await;
        let (exit, preparations) = drive(&f, run, 5).await;
        assert!(matches!(exit, DriverExit::Blocked { .. }));
        if provider_effect {
            assert!(preparations.is_empty());
            let mut incoming = main.clone();
            incoming.step = StepId::new();
            incoming.compaction_recovery = Some(attempt);
            let body = ContentBlob::json(&incoming).unwrap();
            assert!(
                c::append(
                    &f.state,
                    run,
                    vec![Change::new(
                        Fact::StepPrepared {
                            step: incoming.step,
                            request: body.reference().clone(),
                            adjudications: vec![]
                        },
                        UnixMillis(6)
                    )],
                    vec![body]
                )
                .await
                .is_err()
            );
        } else {
            assert!(
                matches!(preparations.as_slice(), [Preparation::CompactionFallback {main: selected, summary: original}] if *selected == main.step && *original == attempt)
            );
        }
        let view = f.state.frontier(run).await.unwrap();
        assert!(
            view.tools.is_empty(),
            "private Summary classification creates no public tool T0"
        );
        assert!(view.baseline.is_none());
        let records = f.state.history(run, 0, 128).await.unwrap();
        assert!(
            !records
                .iter()
                .any(|r| matches!(&r.fact, Fact::ModelObserved { .. }))
        );
        assert_eq!(
            f.state.request(run, main.step).await.unwrap().request,
            main.request
        );
        f.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn interrupted_provider_history_preserves_known_and_unknown_outcomes_after_reopen() {
    for scenario in ["missing", "settled", "text", "other-step"] {
        let directory = tempfile::tempdir().unwrap();
        let f = NativeFixture::open(directory.path(), c::configuration())
            .await
            .unwrap();
        let session = f
            .create("Interrupted provider source", directory.path(), None)
            .await
            .unwrap();
        let run = admit(&f, directory.path(), &session, "old").await;
        if scenario == "other-step" {
            let proof = ContentBlob::json(&json!({"opaque":"original prior prefix"})).unwrap();
            interrupted(
                &f,
                run,
                vec![call(), result()],
                AttemptRecovery::ProjectPrefixSafe {
                    prefix: proof.reference().clone(),
                    not_before: Some(UnixMillis(100)),
                },
                2,
                vec![proof],
            )
            .await;
            assert!(matches!(
                drive(&f, run, 3).await.0,
                DriverExit::Waiting { .. }
            ));
            let view = f.state.frontier(run).await.unwrap();
            let waits = view
                .waits
                .iter()
                .filter(|(_, w)| w.cancelled.is_none() && w.satisfied.is_none())
                .map(|(wait, _)| Fact::WaitCancelled {
                    wait: *wait,
                    diagnostic: "original provider backoff completed".into(),
                })
                .collect();
            record(&f, run, 101, waits, vec![]).await;
        }
        let proof = ContentBlob::json(&json!({"opaque":"original current prefix"})).unwrap();
        let parts = match scenario {
            "settled" => vec![call(), result()],
            "text" => vec![text(false)],
            _ => vec![call()],
        };
        let attempt = interrupted(
            &f,
            run,
            parts,
            AttemptRecovery::ProjectPrefixSafe {
                prefix: proof.reference().clone(),
                not_before: Some(UnixMillis(1000)),
            },
            102,
            vec![proof],
        )
        .await;
        f.shutdown().await.unwrap();
        let f = NativeFixture::open(directory.path(), c::configuration())
            .await
            .unwrap();
        let known = matches!(scenario, "settled" | "text");
        let (exit, preparations) = drive(&f, run, 103).await;
        assert!(preparations.is_empty());
        assert_eq!(matches!(exit, DriverExit::Waiting { .. }), known);
        let view = f.state.frontier(run).await.unwrap();
        if !known {
            assert!(matches!(exit, DriverExit::Blocked { .. }));
            let tool = view
                .tools
                .values()
                .find(|tool| tool.key.attempt == attempt)
                .unwrap();
            assert!(tool.provider_result.is_none() && tool.accepted.is_none());
            let (summary, mut contents) = request(&f, run, ModelPurpose::Summary).await;
            let body = ContentBlob::json(&summary).unwrap();
            contents.push(body.clone());
            assert!(
                c::append(
                    &f.state,
                    run,
                    vec![Change::new(
                        Fact::StepPrepared {
                            step: summary.step,
                            request: body.reference().clone(),
                            adjudications: vec![]
                        },
                        UnixMillis(1001)
                    )],
                    contents
                )
                .await
                .is_err(),
                "an earlier settled same-call id is not this attempt's known effect"
            );
        } else {
            let waits = view
                .waits
                .iter()
                .filter(|(_, w)| w.cancelled.is_none() && w.satisfied.is_none())
                .map(|(wait, _)| Fact::WaitCancelled {
                    wait: *wait,
                    diagnostic: "original provider backoff completed".into(),
                })
                .collect();
            record(&f, run, 1001, waits, vec![]).await;
            let (summary, contents) = request(&f, run, ModelPurpose::Summary).await;
            prepare(&f, run, &summary, contents, 1001).await;
            let summary_attempt = model(&f, run, summary.step, 1001).await;
            close_summary(
                &f,
                run,
                summary_attempt,
                SummaryResult::Text {
                    summary: TextSummary {
                        text: "durable known history".into(),
                    },
                },
                1002,
            )
            .await;
            let (_, preparations) = drive(&f, run, 1003).await;
            assert!(
                matches!(preparations.as_slice(), [Preparation::AfterCompaction {attempt: original}] if *original == summary_attempt)
            );
            assert!(f.state.frontier(run).await.unwrap().baseline.is_some());
        }
        f.shutdown().await.unwrap();
    }
}

// These are canonical metadata guards. The public NativeCompaction value is
// original provider data here, never a subscription binding or replay capability.
#[tokio::test]
async fn checkpoint_metadata_authenticates_original_source_summary_native_producer_and_budget() {
    use maka_agent_facts::context::{
        CheckpointContent, CheckpointMode, CodexCompatibility, CodexRequestProvenance,
        CompactedContext, ContextCheckpoint, ModelOperation, ModelRequestContext, NativeCheckpoint,
        PreparedContextBreakdown,
    };
    use maka_agent_facts::model::{ModelUsage, NativeCompaction};
    for native in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let f = NativeFixture::open(directory.path(), c::configuration())
            .await
            .unwrap();
        let session = f
            .create("Authenticated checkpoint metadata", directory.path(), None)
            .await
            .unwrap();
        let run = admit(&f, directory.path(), &session, "summary").await;
        let (mut summary, mut contents) = request(&f, run, ModelPurpose::Summary).await;
        let producer = CodexRequestProvenance {
            connection_id: summary.accounting.binding.connection_id.clone(),
            account_id: Some("original-account".into()),
            compatibility: Some(CodexCompatibility {
                comp_hash: "3000".into(),
                fetched_at: 1,
            }),
        };
        let provenance = ContentBlob::json(&json!({
            "estimatedInputTokens": 0,
            "breakdown": PreparedContextBreakdown::default(),
            "previousCheckpointId": null,
            "modelContext": native.then(|| ModelRequestContext {
                operation: ModelOperation::CodexCompaction,
                provider_id: "chatgpt".into(),
                codex: Some(producer.clone()),
                context_window: Some(128_000),
                model_context_window: Some(128_000),
                declared_window: None,
            }),
        }))
        .unwrap();
        summary.provenance = provenance.reference().clone();
        contents.push(provenance);
        prepare(&f, run, &summary, contents, 2).await;
        let attempt = model(&f, run, summary.step, 3).await;
        let item = NativeCompaction::new(json!({"type":"compaction","id":"original-item","encrypted_content":"opaque-original","extension":{"kept":true}})).unwrap();
        let mut closure: ModelClosureProtocol = serde_json::from_value(protocol(None)).unwrap();
        closure.compaction = native.then(|| item.clone());
        closure.summary = (!native).then(|| SummaryResult::Text {
            summary: TextSummary {
                text: "original-summary-marker".into(),
            },
        });
        record(
            &f,
            run,
            4,
            vec![
                Fact::ModelClosed {
                    attempt,
                    outcome: Outcome::Success,
                    diagnostic: None,
                    usage: ModelUsage {
                        output_tokens: Some(12),
                        ..Default::default()
                    },
                    protocol: serde_json::to_value(closure).unwrap(),
                },
                Fact::ModelCleanupObserved {
                    attempt,
                    cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
                },
            ],
            vec![],
        )
        .await;
        let source: RequestSource = serde_json::from_slice(
            &f.state
                .content(run, summary.source_capture.clone())
                .await
                .unwrap(),
        )
        .unwrap();
        let material = CompactedContext {
            source_capture: summary.source_capture.clone(),
            checkpoint: ContextCheckpoint {
                mode: CheckpointMode::PreTurn,
                covered_through: source.current.through_sequence,
                source_digest: summary.source_digest.clone(),
                previous_checkpoint_id: None,
                summary: if native {
                    CheckpointContent::native(&item, 12)
                } else {
                    CheckpointContent::Text("original-summary-marker".into())
                },
                summary_step_id: summary.step,
            },
            native: native.then(|| NativeCheckpoint {
                item: item.clone(),
                producer: producer.clone(),
            }),
        };
        let before = f.state.frontier(run).await.unwrap();
        for mutation in 0..if native { 5 } else { 3 } {
            let mut forged = material.clone();
            match mutation {
                0 => {
                    forged.checkpoint.source_digest =
                        maka_agent_facts::artifact::content_digest(b"forged frozen source")
                }
                1 if native => {
                    let CheckpointContent::CodexNative {
                        estimated_tokens, ..
                    } = &mut forged.checkpoint.summary
                    else {
                        unreachable!()
                    };
                    *estimated_tokens = 0;
                }
                1 => forged.checkpoint.summary = CheckpointContent::Text("forged summary".into()),
                2 => forged.checkpoint.previous_checkpoint_id = Some(FactId::new().to_string()),
                3 => {
                    forged.native.as_mut().unwrap().producer.account_id =
                        Some("another-account".into())
                }
                _ => {
                    let CheckpointContent::CodexNative { item_digest, .. } =
                        &mut forged.checkpoint.summary
                    else {
                        unreachable!()
                    };
                    *item_digest =
                        maka_agent_facts::artifact::content_digest(b"another opaque item");
                }
            }
            let blob = ContentBlob::json(&forged).unwrap();
            assert!(
                c::append(
                    &f.state,
                    run,
                    vec![Change::new(
                        Fact::ContextCompacted {
                            baseline: blob.reference().clone()
                        },
                        UnixMillis(5)
                    )],
                    vec![blob]
                )
                .await
                .is_err()
            );
            assert_eq!(
                f.state.frontier(run).await.unwrap().revision,
                before.revision
            );
            assert!(f.state.frontier(run).await.unwrap().baseline.is_none());
        }
        let good = ContentBlob::json(&material).unwrap();
        assert!(
            c::append(
                &f.state,
                run,
                vec![
                    Change::new(
                        Fact::ContextCompacted {
                            baseline: good.reference().clone()
                        },
                        UnixMillis(5)
                    ),
                    Change::new(
                        Fact::ModelObserved {
                            attempt,
                            index: 0,
                            part: text(false),
                            continuation: None
                        },
                        UnixMillis(5)
                    ),
                ],
                vec![good.clone()]
            )
            .await
            .is_err()
        );
        assert!(
            f.state.frontier(run).await.unwrap().baseline.is_none(),
            "a later rejected fact rolls back the checkpoint and all derived metadata"
        );
        record(
            &f,
            run,
            5,
            vec![Fact::ContextCompacted {
                baseline: good.reference().clone(),
            }],
            vec![good.clone()],
        )
        .await;
        let view = f.state.frontier(run).await.unwrap();
        let history = f
            .state
            .session_history(view.spec.owner.clone(), session.clone());
        let checkpoint = f
            .state
            .history(run, 0, 128)
            .await
            .unwrap()
            .into_iter()
            .find(|r| matches!(&r.fact, Fact::ContextCompacted { .. }))
            .unwrap();
        assert_eq!(checkpoint.at, UnixMillis(5));
        let cut = history.capture().await.unwrap();
        let frozen = history
            .capture_snapshot(
                maka_agent_state::session_history::snapshot::CaptureRequest {
                    id: maka_agent_facts::history_snapshot::SnapshotId::try_from(
                        uuid::Uuid::new_v4(),
                    )
                    .unwrap(),
                    cut: cut.clone(),
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let tree = maka_agent_state::session_history::source_tree::SourceTree::live(&history, &cut)
            .await
            .unwrap();
        let matches = tree
            .find_page(
                maka_agent_state::session_history::navigation::SourceFind {
                    after: None,
                    query: "original-summary-marker".into(),
                    case_sensitive: true,
                    whole_word: false,
                    include_internal: false,
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(
            matches.matches.is_empty(),
            "an adopted summary marker is not ordinary Recall content"
        );
        let recall = f
            .state
            .recall(view.spec.owner.clone(), session.clone())
            .unwrap();
        let batch = recall
            .search(
                maka_agent_state::recall::SearchQuery {
                    terms: vec!["original-summary-marker".into()],
                    session_id: Some(session.clone()),
                    since: None,
                    until: None,
                    exclude: None,
                    limit: None,
                },
                0,
                0,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(batch.hits.is_empty());
        let frozen_tree =
            maka_agent_state::session_history::source_tree::SourceTree::snapshot(&frozen)
                .await
                .unwrap();
        let frozen_matches = frozen_tree
            .find_page(
                maka_agent_state::session_history::navigation::SourceFind {
                    after: None,
                    query: "original-summary-marker".into(),
                    case_sensitive: true,
                    whole_word: false,
                    include_internal: false,
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(frozen_matches.matches.is_empty());
        let frozen_records = frozen.history(run, 0, 128).await.unwrap();
        let adoption_sequence = frozen
            .page(0, 128)
            .await
            .unwrap()
            .items
            .iter()
            .find(|item| item.recorded.id == checkpoint.id)
            .unwrap()
            .sequence;
        assert_eq!(
            tree.source_for_path(&[], None)
                .await
                .unwrap()
                .compaction_started_at(run, summary.step, adoption_sequence)
                .await
                .unwrap(),
            UnixMillis(2)
        );
        assert_eq!(
            frozen_tree
                .source_for_path(&[], Some(frozen.id()))
                .await
                .unwrap()
                .compaction_started_at(run, summary.step, adoption_sequence)
                .await
                .unwrap(),
            UnixMillis(2)
        );
        assert!(
            frozen_records
                .iter()
                .any(|r| r.id == checkpoint.id && r.at == UnixMillis(5))
        );
        assert_eq!(
            frozen
                .with_payload(good.reference(), |reader| Ok(serde_json::from_reader::<
                    _,
                    CompactedContext,
                >(reader)?))
                .await
                .unwrap(),
            material
        );
        record(
            &f,
            run,
            6,
            vec![Fact::RunTerminated {
                terminal: Terminal::Completed,
                diagnostic: None,
            }],
            vec![],
        )
        .await;
        f.shutdown().await.unwrap();
        let f = NativeFixture::open(directory.path(), c::configuration())
            .await
            .unwrap();
        assert_eq!(
            f.state.frontier(run).await.unwrap().baseline,
            Some(good.reference().clone())
        );
        assert_eq!(
            serde_json::from_slice::<CompactedContext>(
                &f.state
                    .content(run, good.reference().clone())
                    .await
                    .unwrap()
            )
            .unwrap(),
            material
        );
        let (_, restored) = f
            .state
            .session_history(view.spec.owner, session)
            .captured_snapshot(frozen.id(), CancellationToken::new())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            restored.manifest().await.unwrap().origin,
            maka_agent_facts::history_snapshot::Origin::Canonical { cut }
        );
        f.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn summary_repair_cannot_change_its_frozen_source_or_restart_its_budget() {
    let directory = tempfile::tempdir().unwrap();
    let f = NativeFixture::open(directory.path(), c::configuration())
        .await
        .unwrap();
    let session = f
        .create("Original repair lineage", directory.path(), None)
        .await
        .unwrap();
    let run = admit(&f, directory.path(), &session, "repair").await;
    let (original, contents) = request(&f, run, ModelPurpose::Summary).await;
    prepare(&f, run, &original, contents, 2).await;
    let first = model(&f, run, original.step, 3).await;
    close_summary(&f, run, first, SummaryResult::RejectedToolContent, 4).await;
    let mut repair = original.clone();
    repair.step = StepId::new();
    repair.summary_repair_of = Some(first);
    for changed in 0..3 {
        let mut forged = repair.clone();
        match changed {
            0 => {
                forged.source_digest =
                    maka_agent_facts::artifact::content_digest(b"different source")
            }
            1 => {
                forged.effective_source_digest =
                    maka_agent_facts::artifact::content_digest(b"different effective source")
            }
            _ => forged.summary_repair_of = Some(ModelAttemptId::new()),
        }
        let body = ContentBlob::json(&forged).unwrap();
        assert!(
            c::append(
                &f.state,
                run,
                vec![Change::new(
                    Fact::StepPrepared {
                        step: forged.step,
                        request: body.reference().clone(),
                        adjudications: vec![]
                    },
                    UnixMillis(5)
                )],
                vec![body]
            )
            .await
            .is_err()
        );
    }
    prepare(&f, run, &repair, vec![], 5).await;
    let second = model(&f, run, repair.step, 6).await;
    close_summary(&f, run, second, SummaryResult::RejectedToolContent, 7).await;
    let (exit, preparations) = drive(&f, run, 8).await;
    assert!(matches!(
        exit,
        DriverExit::Terminal {
            terminal: Terminal::Failed,
            ..
        }
    ));
    assert!(
        preparations.is_empty(),
        "a repair cannot request another repair merely by completing private Summary work"
    );
    let view = f.state.frontier(run).await.unwrap();
    assert!(view.baseline.is_none());
    assert!(view.tools.is_empty());
    assert_eq!(view.attempts.len(), 2);
    assert!(
        !f.state
            .history(run, 0, 128)
            .await
            .unwrap()
            .iter()
            .any(|r| matches!(&r.fact, Fact::ModelObserved { .. }))
    );
    f.shutdown().await.unwrap();
}

#[tokio::test]
async fn frozen_metrics_keep_the_original_main_and_never_fall_back_from_a_broken_newer_trace() {
    let directory = tempfile::tempdir().unwrap();
    let f = NativeFixture::open(directory.path(), c::configuration())
        .await
        .unwrap();
    let session = f
        .create("Latest real Main", directory.path(), None)
        .await
        .unwrap();
    let run = admit(&f, directory.path(), &session, "main").await;
    let (first, contents) = request(&f, run, ModelPurpose::Main).await;
    prepare(&f, run, &first, contents, 10).await;
    let attempt = model(&f, run, first.step, 11).await;
    record(
        &f,
        run,
        12,
        vec![
            Fact::ModelClosed {
                attempt,
                outcome: Outcome::Success,
                diagnostic: None,
                usage: Default::default(),
                protocol: protocol(None),
            },
            Fact::ModelCleanupObserved {
                attempt,
                cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
            },
        ],
        vec![],
    )
    .await;
    let view = f.state.frontier(run).await.unwrap();
    let history = f.state.session_history(view.spec.owner, session);
    let cut = history.capture().await.unwrap();
    let metrics = history.metrics(&cut).await.unwrap().unwrap();
    assert_eq!(metrics.attempt, attempt);
    assert_eq!(metrics.requested_at, Some(UnixMillis(11)));
    assert_eq!(metrics.finished_at, Some(UnixMillis(12)));
    let (mut newer, mut contents) = request(&f, run, ModelPurpose::Main).await;
    let unavailable = ContentBlob::json(&json!({"breakdown":"invalid original trace"})).unwrap();
    newer.provenance = unavailable.reference().clone();
    contents.push(unavailable);
    prepare(&f, run, &newer, contents, 1).await;
    let latest = model(&f, run, newer.step, 1).await;
    record(
        &f,
        run,
        2,
        vec![
            Fact::ModelClosed {
                attempt: latest,
                outcome: Outcome::Success,
                diagnostic: None,
                usage: Default::default(),
                protocol: protocol(None),
            },
            Fact::ModelCleanupObserved {
                attempt: latest,
                cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
            },
        ],
        vec![],
    )
    .await;
    assert!(
        history
            .metrics(&history.capture().await.unwrap())
            .await
            .is_err(),
        "a canonical newer Main with unavailable proof must not silently select an older success by timestamp"
    );
    assert_eq!(history.metrics(&cut).await.unwrap().unwrap(), metrics);
    f.shutdown().await.unwrap();
}
