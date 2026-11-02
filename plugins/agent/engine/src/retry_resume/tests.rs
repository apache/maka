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
use maka_agent_facts::{
    composition::{SourceKind, SourceRevision},
    event::{Fact, Invocation},
    model::{ModelEvent, ModelFinishReason},
};
use maka_agent_ports::model::{
    Binding, Context, Error, Lifetime, ProviderAdapter, Request, Session,
};
use maka_tools::{CodeExecutor, ToolCatalog};
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
    let seeded = crate::retry_fixture::seed_due_model_retry(
        &original_engine,
        store.clone(),
        crate::RunInput {
            model_source: input.model_source.clone(),
            model_revision: input.model_revision.clone(),
            provider_id: input.provider_id.clone(),
            invocation: input.invocation.clone(),
            context: input.context.clone(),
            request_fingerprint: input.request_fingerprint.clone(),
            provider: input.provider.clone(),
            provider_options: input.provider_options.clone(),
            native_activation_basis: input.native_activation_basis.clone(),
            main_output_limit: input.main_output_limit,
            supports_vision: input.supports_vision,
            configuration: input.configuration.clone(),
            work: crate::RunWork::Message {
                message: "original input".into(),
                source_messages: vec![],
                tools: ToolCatalog::default(),
            },
        },
    )
    .await
    .unwrap();
    let expected = seeded.input_digest;
    let parked = seeded.checkpoint;
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
