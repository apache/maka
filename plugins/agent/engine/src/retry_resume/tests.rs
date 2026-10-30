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

use super::*;
use crate::{model_attempt, steps::ModelResumePoint};
use maka_agent_facts::{
    composition::{SourceKind, SourceRevision},
    context::ModelPurpose,
    event::{EventWrite, Fact, Invocation, InvocationInput, ModelInterruption, RuntimeEvent},
    execution::ToolMode,
    handoff::CompactionBudget,
    language::Language,
    model::{
        ModelEvent, ModelFinishReason,
        error::{ModelFailureCause, ProviderFailureReason},
        retry_transport::RetryTransportPhase,
    },
    model_retry::RetryPlan,
    native_approval::{ActivationCheckpoint, ActivationSuspension},
};
use maka_agent_ports::model::{
    Binding, Context, Error, Lifetime, ProviderAdapter, Request, Session,
};
use maka_tools::{CodeExecutor, RunTools, ToolCatalog};
use serde_json::json;
use std::{
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

struct Completed(Arc<AtomicUsize>);
impl ProviderAdapter for Completed {
    fn open(
        &self,
        _: Lifetime,
        _: CancellationToken,
    ) -> BoxFuture<'_, Result<Arc<dyn Session>, Error>> {
        let session: Arc<dyn Session> = Arc::new(Completed(self.0.clone()));
        Box::pin(async move { Ok(session) })
    }
}
impl Session for Completed {
    fn stream(&self, _: Request, context: Context) -> BoxFuture<'static, Result<(), Error>> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            context
                .events
                .emit(
                    ModelEvent::Finished {
                        reason: ModelFinishReason::Stop,
                        usage: Default::default(),
                        provider_options: None,
                    }
                    .into(),
                )
                .await
        })
    }
}
fn engine(sends: Arc<AtomicUsize>) -> Engine {
    let binding = Binding::new(
        Arc::new(Completed(sends)),
        SourceRevision {
            kind: SourceKind::ModelAdapter,
            name: "fixture".into(),
            package_id: "fixture".into(),
            entry_id: "fixture".into(),
            activation: "fixture".into(),
            revision: "1".into(),
        },
    );
    Engine::new(
        maka_model::ModelExecutor::new(Duration::from_secs(30))
            .unwrap()
            .with_adapters(std::collections::BTreeMap::from([(
                "fixture".into(),
                binding,
            )])),
        CodeExecutor::new(maka_code_runtime::CellLimits::default()).unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn due_checkpoint_resumes_under_fresh_engine_and_consumes_once() {
    let (_directory, root) = crate::test_support::root().await;
    let store = crate::test_support::session(&root, "session").await;
    let sends = Arc::new(AtomicUsize::new(0));
    let original_engine = engine(sends.clone());
    let engine = &original_engine;
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let mut input = crate::frozen_request::tests::settings(invocation.clone());
    input.native_activation_basis =
        Some(Arc::new(crate::frozen_request::tests::FixtureNativeBasis {
            accepted: "basis",
            materializations: Arc::new(AtomicUsize::new(0)),
        }));
    input.provider.adapter = Some("fixture".into());
    let execution = store.execution_scope(None).await.unwrap().accept();
    let inner = RunContext::new(engine.0.clone(), execution.store().clone(), &invocation).unwrap();
    let opening = RuntimeEvent::new(
        invocation.clone(),
        Fact::InvocationOpened {
            configuration: Some(Box::new(input.configuration.clone())),
            input: InvocationInput::Message {
                source_messages: vec![],
                content: "original input".into(),
                request_fingerprint: None,
            },
        },
    );
    let opening_id = opening.id.clone();
    inner
        .log
        .append(&EventWrite::plain(opening).unwrap())
        .await
        .unwrap();
    let tools = RunTools::new(
        Language::En,
        inner.log.clone(),
        invocation.clone(),
        ToolCatalog::default(),
        ToolMode::Direct,
        CodeExecutor::new(maka_code_runtime::CellLimits::default()).unwrap(),
        engine.0.loaded("session"),
    );
    let cancellation = CancellationToken::new();
    let original_tools = tools.capture(".", cancellation.clone()).await.unwrap();
    let view = Arc::new(
        inner
            .log
            .read_model_view("session", Some("invocation"))
            .await
            .unwrap(),
    );
    let capture = model_attempt::RequestSource::from(view.as_ref());
    let surface = crate::request_composition::Surface::capture(
        &original_tools,
        &inner.shared.model,
        &input,
        &view,
        None,
    )
    .unwrap();
    let mut prompt = model_attempt::prompt(
        &inner,
        &input,
        &view,
        &cancellation,
        None,
        "invocation",
        false,
        surface.system(),
        ModelPurpose::Main,
    )
    .await
    .unwrap();
    drop(view);
    let definitions = original_tools.definitions();
    model_attempt::prepare_wire(
        &input,
        &mut prompt,
        &definitions,
        surface.max_output_tokens,
        &cancellation,
    )
    .await
    .unwrap();
    let prepared = model_attempt::prepare_request(
        &input,
        prompt.clone(),
        definitions,
        surface.max_output_tokens,
        ModelPurpose::Main,
    )
    .unwrap();
    let expected = prepared.input_digest.clone();
    let event = RuntimeEvent::new(
        invocation.clone(),
        Fact::ModelRequested {
            source_capture: capture.capture,
            item_acceptance: surface.adapter.supports_item_acceptance(),
            effective_source_digest: Some(capture.effective_digest),
            purpose: ModelPurpose::Main,
            context: None,
            context_breakdown: Some(prepared.context_breakdown),
            checkpoint_event_id: capture.checkpoint,
            step_id: "original-step".into(),
            model_id: input.provider.model.clone(),
            source_scope: capture.evidence.scope,
            source_high_water: capture.evidence.high_water,
            source_digest: capture.evidence.digest,
            input_digest: prepared.input_digest,
            route_identity: prepared.route_identity,
        },
    );
    inner
        .log
        .append(
            &EventWrite::plain(event)
                .unwrap()
                .with_composition(surface.evidence())
                .unwrap(),
        )
        .await
        .unwrap();
    drop(prepared.request);
    drop(original_tools);
    drop(surface);
    prompt.close().await.unwrap();
    drop(prompt);
    let failure = RuntimeEvent::new(
        invocation.clone(),
        Fact::ModelInterrupted {
            step_id: "original-step".into(),
            status: ModelInterruption::RetryableFailure,
            diagnostic: None,
            partial: None,
            model_failure: Some(ModelFailureCause::Provider {
                reason: ProviderFailureReason::RateLimit,
                retry_at_unix_ms: Some(1),
            }),
        },
    );
    let plan = RetryPlan {
        failure_event_id: failure.id.clone(),
        not_before_unix_ms: 1,
        failures: 1,
        transport_phase: RetryTransportPhase::Primary,
    };
    inner
        .log
        .append(&EventWrite::plain(failure).unwrap())
        .await
        .unwrap();
    let point = ModelResumePoint {
        opening_id,
        context: None,
        provider_options: json!({}),
        main_output_limit: None,
        supports_vision: false,
        tools: tools.checkpoint().unwrap(),
        compaction: CompactionBudget::Available,
        replay_base: None,
        prior_unknown: false,
        inspected_through: 0,
        main_progress: false,
        finish_turn: false,
    };
    let checkpoint = ActivationCheckpoint {
        id: "retry-checkpoint".into(),
        invocation: invocation.clone(),
        through: inner.log.committed_sequence().await.unwrap(),
        engine: serde_json::to_value(point).unwrap(),
        native_basis: input
            .native_activation_basis
            .as_ref()
            .unwrap()
            .checkpoint_value()
            .unwrap(),
        suspension: ActivationSuspension::ModelRetry { plan },
    };
    assert!(matches!(
        inner.log.park_model_retry(checkpoint).await.unwrap(),
        maka_event_log::native_approvals::ParkResult::Parked(_)
    ));
    let parked = inner
        .log
        .activation_checkpoint("session")
        .await
        .unwrap()
        .unwrap();
    tools.shutdown().await.unwrap();
    drop(tools);
    drop(inner);
    execution.finish();
    original_engine.drain().await;
    assert_eq!(
        sends.load(Ordering::SeqCst),
        0,
        "fixture never sends its historical request"
    );
    let fresh_engine = self::engine(sends.clone());
    input.provider_options = json!({"temperature": 0.75});
    let next = ResumeContinuation {
        settings: input.clone(),
        tools: ToolCatalog::default(),
    };
    let running = fresh_engine
        .start_retry_resume(
            store.clone(),
            RetryResumeInput {
                checkpoint: parked.clone(),
                permission_basis: None,
                continuation: async { Ok(next) }.boxed(),
                owner_shutdown: CancellationToken::new(),
                host_epoch: "fresh-host".into(),
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let completion = running.completion().await;
    assert!(
        completion.cleanup.is_ok(),
        "resumed physical custody drains"
    );
    assert!(matches!(completion.result, Ok(ActivationExit::Terminal(_))));
    assert_eq!(sends.load(Ordering::SeqCst), 1);
    assert!(
        store
            .activation_checkpoint("session")
            .await
            .unwrap()
            .is_none()
    );
    let prefix = store
        .scoped_prefix(
            maka_agent_facts::event::LogScope::Session {
                id: invocation.session_id.clone(),
            },
            100,
            1024 * 1024,
        )
        .await
        .unwrap();
    let requested: Vec<_> = prefix
        .events
        .iter()
        .filter_map(|stored| {
            if let Fact::ModelRequested { input_digest, .. } = &stored.event.fact {
                Some(input_digest)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(
        requested.len(),
        2,
        "one historical request and one consumed retry"
    );
    assert!(
        requested.iter().all(|digest| **digest == expected),
        "fresh settings do not alter frozen input"
    );
    assert!(
        !prefix
            .events
            .iter()
            .any(|stored| matches!(stored.event.fact, Fact::ToolDispatched { .. }))
    );
    let duplicate = fresh_engine
        .start_retry_resume(
            store,
            RetryResumeInput {
                checkpoint: parked,
                permission_basis: None,
                continuation: async {
                    Ok(ResumeContinuation {
                        settings: input,
                        tools: ToolCatalog::default(),
                    })
                }
                .boxed(),
                owner_shutdown: CancellationToken::new(),
                host_epoch: "duplicate-host".into(),
            },
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(
        duplicate,
        Err(RunError::ReconciliationRequired(_))
    ));
    assert_eq!(
        sends.load(Ordering::SeqCst),
        1,
        "stale duplicate cannot send"
    );
    fresh_engine.drain().await;
}
