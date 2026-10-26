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

use super::provider_stream::request;
use futures_util::future::BoxFuture;
use maka_agent_ports::model::*;
use maka_model::{ModelExecutor, ProviderKind};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

struct Controlled {
    release: CancellationToken,
    retained: Arc<Mutex<Option<Context>>>,
}
impl ProviderAdapter for Controlled {
    fn open(
        &self,
        _: Lifetime,
        _: CancellationToken,
    ) -> BoxFuture<'_, Result<Arc<dyn Session>, Error>> {
        let session = Controlled {
            release: self.release.clone(),
            retained: self.retained.clone(),
        };
        Box::pin(async { Ok(Arc::new(session) as Arc<dyn Session>) })
    }
}
impl Session for Controlled {
    fn stream(&self, _: Request, context: Context) -> BoxFuture<'static, Result<(), Error>> {
        let release = self.release.clone();
        *self.retained.lock().unwrap() = Some(context.clone());
        Box::pin(async move {
            context
                .events
                .emit(
                    ModelEvent::ResponseMetadata {
                        id: Some("accepted".into()),
                        model: None,
                        timestamp: None,
                    }
                    .into(),
                )
                .await?;
            tokio::select! {
                _ = release.cancelled() => {}
                _ = context.cancellation.cancelled() => return Err(Error::Cancelled),
            }
            context
                .events
                .emit(
                    ModelEvent::Finished {
                        reason: maka_agent_facts::model::ModelFinishReason::Stop,
                        usage: Default::default(),
                        provider_options: None,
                    }
                    .into(),
                )
                .await
        })
    }
}
fn binding(
    release: CancellationToken,
    retained: Arc<Mutex<Option<Context>>>,
    revision: &str,
) -> Binding {
    let source = maka_agent_facts::composition::SourceRevision {
        kind: maka_agent_facts::composition::SourceKind::ModelAdapter,
        name: "chat-completions".into(),
        package_id: "fixture.adapter".into(),
        entry_id: "fixture.adapter".into(),
        activation: "fixture.activation".into(),
        revision: revision.into(),
    };
    Binding::new(Arc::new(Controlled { release, retained }), source)
}
#[tokio::test]
async fn captured_adapter_survives_executor_replacement_and_bounds_idle_work() {
    let release = CancellationToken::new();
    let retained = Arc::default();
    let original = binding(release.clone(), Arc::clone(&retained), "1");
    let executor = ModelExecutor::new(Duration::from_millis(100))
        .unwrap()
        .with_adapters(std::collections::BTreeMap::from([(
            "chat-completions".into(),
            original.clone(),
        )]));
    let input = || {
        request(
            ProviderKind::OpenaiChatCompletions,
            "http://unused.example/v1".into(),
        )
    };
    let original = executor.binding(&input().provider).unwrap();
    let source = original.source().clone();
    let mut accepted = executor
        .stream_with_adapter(input(), CancellationToken::new(), None, original.clone())
        .await
        .unwrap();
    assert!(matches!(
        accepted.next().await.unwrap().unwrap().event,
        ModelEvent::ResponseMetadata { .. }
    ));
    let executor = executor.with_adapters(std::collections::BTreeMap::from([(
        "chat-completions".into(),
        binding(CancellationToken::new(), Arc::default(), "2"),
    )]));
    let replacement = executor.binding(&input().provider).unwrap();
    assert_ne!(source.revision, replacement.source().revision);
    assert!(!original.same_registration(&replacement));
    assert_eq!(original.source(), &source);
    release.cancel();
    assert!(matches!(
        accepted.next().await.unwrap().unwrap().event,
        ModelEvent::Finished { .. }
    ));
    assert!(accepted.next().await.is_none());
    accepted
        .cancel_and_wait()
        .await
        .expect("actual stream cleanup");
    let context = retained.lock().unwrap().take().unwrap();
    assert!(matches!(
        context
            .transport
            .request(
                maka_capabilities::http::Request {
                    method: maka_capabilities::http::Method::Get,
                    url: "http://unused.example/".into(),
                    headers: vec![],
                    body: Default::default(),
                },
                CancellationToken::new()
            )
            .await,
        Err(Error::Cancelled)
    ));
    let mut stalled = executor
        .stream(input(), CancellationToken::new())
        .await
        .unwrap();
    assert!(matches!(
        stalled.next().await.unwrap().unwrap().event,
        ModelEvent::ResponseMetadata { .. }
    ));
    assert!(matches!(
        stalled.next().await.unwrap(),
        Err(Error::TimedOut)
    ));
    stalled
        .cancel_and_wait()
        .await
        .expect("actual stream cleanup");
}

#[derive(Clone, Copy)]
struct CleanupOutcome {
    unknown: bool,
    wait_cancel: bool,
}
impl ProviderAdapter for CleanupOutcome {
    fn open(
        &self,
        _: Lifetime,
        _: CancellationToken,
    ) -> BoxFuture<'_, Result<Arc<dyn Session>, Error>> {
        let session = *self;
        Box::pin(async move { Ok(Arc::new(session) as Arc<dyn Session>) })
    }
}
impl Session for CleanupOutcome {
    fn stream(&self, _: Request, context: Context) -> BoxFuture<'static, Result<(), Error>> {
        let mode = *self;
        Box::pin(async move {
            context
                .events
                .emit(
                    ModelEvent::ResponseMetadata {
                        id: Some("started".into()),
                        model: None,
                        timestamp: None,
                    }
                    .into(),
                )
                .await?;
            if mode.wait_cancel {
                context.cancellation.cancelled().await;
            }
            Err(if mode.unknown {
                Error::CleanupUnconfirmed
            } else {
                Error::Cancelled
            })
        })
    }
}

#[tokio::test]
async fn typed_cleanup_unknown_reaches_owner_for_normal_and_cancelled_completion() {
    for wait_cancel in [false, true] {
        for unknown in [false, true] {
            let input = request(
                ProviderKind::OpenaiChatCompletions,
                "http://unused.example/v1".into(),
            );
            let source = binding(CancellationToken::new(), Arc::default(), "cleanup")
                .source()
                .clone();
            let binding = Binding::new(
                Arc::new(CleanupOutcome {
                    unknown,
                    wait_cancel,
                }),
                source,
            );
            let executor = ModelExecutor::new(Duration::from_secs(2)).unwrap();
            let cancellation = CancellationToken::new();
            let mut stream = executor
                .stream_with_adapter(input, cancellation.clone(), None, binding)
                .await
                .unwrap();
            assert!(matches!(
                stream.next().await.unwrap().unwrap().event,
                ModelEvent::ResponseMetadata { .. }
            ));
            if wait_cancel {
                cancellation.cancel();
            }
            let error = stream.next().await.unwrap().unwrap_err();
            if !wait_cancel {
                assert_eq!(error.cleanup_unconfirmed(), unknown);
            }
            while stream.next().await.is_some() {}
            assert_eq!(
                stream.cancel_and_wait().await.is_err(),
                unknown,
                "cleanup receipt must be independent from the ordinary cancellation error"
            );
        }
    }
}
