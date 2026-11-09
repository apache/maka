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
                        compaction: None,
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
                    method: maka_plugin_core::http::Method::Get,
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
    finish: bool,
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
            if mode.finish {
                context
                    .events
                    .emit(
                        ModelEvent::Finished {
                            compaction: None,
                            reason: maka_agent_facts::model::ModelFinishReason::Stop,
                            usage: Default::default(),
                            provider_options: None,
                        }
                        .into(),
                    )
                    .await?;
            }
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
    for finish in [false, true] {
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
                        finish,
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
                if finish {
                    assert!(matches!(
                        stream.next().await.unwrap().unwrap().event,
                        ModelEvent::Finished { .. }
                    ));
                }
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
                    "cleanup receipt must remain independent from cancellation and model finish"
                );
            }
        }
    }
}

use maka_model::{StreamCleanupError, StreamCleanupStage};
use std::sync::{
    Weak,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

#[derive(Default)]
struct DelayedCleanup {
    authority_revoked: AtomicBool,
    authorization_failure: Mutex<Option<Error>>,
    auth_resolves: AtomicUsize,
    auth_cleanup_unconfirmed: AtomicBool,
    sized_reads: AtomicUsize,
    release_adapter: CancellationToken,
    opens: AtomicUsize,
    requests: AtomicUsize,
    adapter_future_dropped: AtomicBool,
    source_close_started: CancellationToken,
    release_source_close: CancellationToken,
    source_close_calls: AtomicUsize,
    source_close_completed: AtomicBool,
    source_dropped: AtomicBool,
    frozen_opens: AtomicUsize,
}
struct DelayedAdapter(Arc<DelayedCleanup>);
struct OriginalAdapterFuture(Arc<DelayedCleanup>);
impl Drop for OriginalAdapterFuture {
    fn drop(&mut self) {
        self.0.adapter_future_dropped.store(true, Ordering::SeqCst);
    }
}
impl ProviderAdapter for DelayedAdapter {
    fn open(
        &self,
        _: Lifetime,
        _: CancellationToken,
    ) -> BoxFuture<'_, Result<Arc<dyn Session>, Error>> {
        self.0.opens.fetch_add(1, Ordering::SeqCst);
        let session = DelayedAdapter(self.0.clone());
        Box::pin(async move { Ok(Arc::new(session) as Arc<dyn Session>) })
    }
}
impl Session for DelayedAdapter {
    fn stream(&self, _: Request, context: Context) -> BoxFuture<'static, Result<(), Error>> {
        self.0.requests.fetch_add(1, Ordering::SeqCst);
        let original = OriginalAdapterFuture(self.0.clone());
        Box::pin(async move {
            let _original = original;
            context
                .events
                .emit(
                    ModelEvent::ResponseMetadata {
                        id: Some("original-delayed-adapter".into()),
                        model: None,
                        timestamp: None,
                    }
                    .into(),
                )
                .await?;
            // Cancellation cannot drop this original physical operation's future.
            _original.0.release_adapter.cancelled().await;
            Err(Error::Adapter("late original adapter outcome".into()))
        })
    }
}
fn delayed_cleanup_binding(control: Arc<DelayedCleanup>) -> Binding {
    let source = binding(CancellationToken::new(), Arc::default(), "delayed-cleanup")
        .source()
        .clone();
    Binding::new(Arc::new(DelayedAdapter(control)), source)
}
struct DelayedSource {
    control: Arc<DelayedCleanup>,
    fail_close: bool,
}
impl Drop for DelayedSource {
    fn drop(&mut self) {
        self.control.source_dropped.store(true, Ordering::SeqCst);
    }
}
impl maka_capabilities::http::UploadCleanup for DelayedSource {
    fn close(&self) -> BoxFuture<'_, Result<(), maka_capabilities::http::Error>> {
        Box::pin(async move {
            self.control
                .source_close_calls
                .fetch_add(1, Ordering::SeqCst);
            self.control.source_close_started.cancel();
            self.control.release_source_close.cancelled().await;
            if self.fail_close {
                Err(maka_capabilities::http::Error::Failed(
                    "original source close failed".into(),
                ))
            } else {
                self.control
                    .source_close_completed
                    .store(true, Ordering::SeqCst);
                Ok(())
            }
        })
    }
}
impl FrozenPrompt for DelayedSource {
    fn authorize(&self, cancellation: CancellationToken) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let mut failure = self.control.authorization_failure.lock().unwrap();
            if self.control.authority_revoked.load(Ordering::SeqCst) {
                failure.get_or_insert_with(|| {
                    Error::LocalAuthorization("original fixture authorization revoked".into())
                });
            }
            match failure.as_ref() {
                Some(error) => Err(error.clone()),
                None => Ok(()),
            }
        })
    }
    fn authorization_failure(&self) -> Option<Error> {
        self.control.authorization_failure.lock().unwrap().clone()
    }
    fn open(&self, _: CancellationToken) -> BoxFuture<'_, Result<MaterializedPrompt, Error>> {
        self.control.frozen_opens.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            Err(Error::Adapter(
                "unsupported: fixture has no frozen history to reopen".into(),
            ))
        })
    }
}
fn delayed_source(
    control: Arc<DelayedCleanup>,
    fail_close: bool,
) -> (RequestSource, Weak<DelayedSource>) {
    let source = Arc::new(DelayedSource {
        control,
        fail_close,
    });
    let original = Arc::downgrade(&source);
    (
        RequestSource {
            cleanup: source.clone(),
            frozen: source,
        },
        original,
    )
}

struct PreworkerAuth(Arc<DelayedCleanup>);
impl maka_model::AuthResolver for PreworkerAuth {
    fn resolve(&self) -> BoxFuture<'_, Result<maka_model::ProviderAuth, Error>> {
        self.0.auth_resolves.fetch_add(1, Ordering::SeqCst);
        let cleanup_unconfirmed = self.0.auth_cleanup_unconfirmed.load(Ordering::SeqCst);
        Box::pin(async move {
            if cleanup_unconfirmed {
                return Err(Error::CleanupUnconfirmed);
            }
            Ok(maka_model::ProviderAuth::ApiKey(
                "original fixture credential".into(),
            ))
        })
    }
}
struct RevokeWhileCounting {
    control: Arc<DelayedCleanup>,
    frozen: Arc<dyn FrozenPrompt>,
}
impl maka_agent_facts::model::prompt_source::PromptSource for RevokeWhileCounting {
    fn open(&self) -> Box<dyn maka_agent_facts::model::prompt_source::PromptCursor> {
        Box::new(RevokeWhileCounting {
            control: self.control.clone(),
            frozen: self.frozen.clone(),
        })
    }
}
impl maka_agent_facts::model::prompt_source::PromptCursor for RevokeWhileCounting {
    fn next(&mut self) -> maka_agent_facts::model::prompt_source::Next<'_> {
        Box::pin(async move {
            self.control.sized_reads.fetch_add(1, Ordering::SeqCst);
            self.control.authority_revoked.store(true, Ordering::SeqCst);
            assert!(matches!(
                self.frozen.authorize(CancellationToken::new()).await,
                Err(Error::LocalAuthorization(_))
            ));
            Err(Error::Adapter(
                "opaque request-length source read failed".into(),
            ))
        })
    }
}

#[tokio::test]
async fn preworker_refusal_closes_original_source_once_and_failed_close_returns_owned_material() {
    use maka_model::StreamOpeningError;
    for (during_count, fail_close) in [(false, false), (true, false), (true, true)] {
        let control = Arc::new(DelayedCleanup::default());
        control.release_source_close.cancel();
        control
            .authority_revoked
            .store(!during_count, Ordering::SeqCst);
        let (source, original) = delayed_source(control.clone(), fail_close);
        let frozen = source.frozen.clone();
        let cleanup = source.cleanup.clone();
        let mut input = request(
            ProviderKind::OpenaiChatCompletions,
            "http://unused.example/v1".into(),
        );
        input.provider.auth = maka_model::ProviderAuth::Bound {
            identity: "fixture-private-route".into(),
            resolver: Arc::new(PreworkerAuth(control.clone())),
        };
        if during_count {
            input.provider.image_input = Some(maka_agent_facts::configuration::ImageInput {
                request_bytes: Some(u64::MAX),
                ..Default::default()
            });
            input.prompt = maka_agent_facts::model::prompt_source::Prompt::new(
                Arc::new(RevokeWhileCounting {
                    control: control.clone(),
                    frozen: frozen.clone(),
                }),
                "original fixture source",
                1,
                Default::default(),
            )
            .with_normalization(ProviderKind::OpenaiChatCompletions);
        }
        let executor = ModelExecutor::new(Duration::from_secs(60)).unwrap();
        let error = match executor
            .stream_with_source(
                input,
                CancellationToken::new(),
                None,
                delayed_cleanup_binding(control.clone()),
                Some(source),
            )
            .await
        {
            Ok(_) => panic!("preworker refusal cannot open an adapter stream"),
            Err(error) => error,
        };
        let first = control
            .authorization_failure
            .lock()
            .unwrap()
            .clone()
            .unwrap();
        assert!(matches!(first, Error::LocalAuthorization(_)));
        assert!(first.failure_cause().is_none());
        control.authority_revoked.store(false, Ordering::SeqCst);
        assert_eq!(
            serde_json::to_value(
                frozen
                    .authorize(CancellationToken::new())
                    .await
                    .unwrap_err()
            )
            .unwrap(),
            serde_json::to_value(&first).unwrap()
        );
        match error {
            StreamOpeningError::Preparation(error) => {
                assert!(!fail_close);
                assert!(matches!(error, Error::LocalAuthorization(_)));
                assert!(error.failure_cause().is_none());
                assert_eq!(
                    serde_json::to_value(error).unwrap(),
                    serde_json::to_value(first).unwrap()
                );
                assert!(control.source_close_completed.load(Ordering::SeqCst));
            }
            StreamOpeningError::Cleanup(error) => {
                assert!(fail_close);
                let StreamCleanupError::Unobservable {
                    stage: StreamCleanupStage::Source,
                    cause,
                    original: Some(cause_before_close),
                    material: Some(material),
                } = &error
                else {
                    panic!(
                        "unconfirmed opening retains the original material and both actual causes"
                    )
                };
                assert!(Arc::ptr_eq(&material.frozen, &frozen));
                assert!(Arc::ptr_eq(&material.cleanup, &cleanup));
                assert_eq!(
                    serde_json::to_value(cause_before_close.as_ref()).unwrap(),
                    serde_json::to_value(first).unwrap()
                );
                assert!(
                    matches!(cause.downcast_ref::<maka_capabilities::http::Error>(),Some(maka_capabilities::http::Error::Failed(message)) if message=="original source close failed")
                );
                assert!(!control.source_close_completed.load(Ordering::SeqCst));
                assert!(original.upgrade().is_some());
                drop(frozen);
                drop(cleanup);
                assert!(
                    original.upgrade().is_some(),
                    "the actual opening error, not caller clones, owns the failed source"
                );
                drop(error);
                assert!(original.upgrade().is_none());
            }
        }
        assert_eq!(control.source_close_calls.load(Ordering::SeqCst), 1);
        assert_eq!(control.opens.load(Ordering::SeqCst), 0);
        assert_eq!(control.requests.load(Ordering::SeqCst), 0);
        assert_eq!(control.frozen_opens.load(Ordering::SeqCst), 0);
        assert_eq!(
            control.auth_resolves.load(Ordering::SeqCst),
            usize::from(during_count)
        );
        assert_eq!(
            control.sized_reads.load(Ordering::SeqCst),
            usize::from(during_count)
        );
    }

    let control = Arc::new(DelayedCleanup::default());
    control
        .auth_cleanup_unconfirmed
        .store(true, Ordering::SeqCst);
    control.release_source_close.cancel();
    let (source, original) = delayed_source(control.clone(), false);
    let frozen = source.frozen.clone();
    let cleanup = source.cleanup.clone();
    let mut input = request(
        ProviderKind::OpenaiChatCompletions,
        "http://unused.example/v1".into(),
    );
    input.provider.auth = maka_model::ProviderAuth::Bound {
        identity: "fixture-private-route".into(),
        resolver: Arc::new(PreworkerAuth(control.clone())),
    };
    let executor = ModelExecutor::new(Duration::from_secs(60)).unwrap();
    let error = match executor
        .stream_with_source(
            input,
            CancellationToken::new(),
            None,
            delayed_cleanup_binding(control.clone()),
            Some(source),
        )
        .await
    {
        Err(StreamOpeningError::Cleanup(error)) => error,
        _ => panic!(
            "unknown physical preparation must retain the original source without closing it"
        ),
    };
    let StreamCleanupError::Unobservable {
        stage: StreamCleanupStage::Adapter,
        cause,
        original: None,
        material: Some(material),
    } = &error
    else {
        panic!("unknown authentication has its actual Adapter-stage cause and original material");
    };
    assert!(matches!(
        cause.downcast_ref::<Error>(),
        Some(Error::CleanupUnconfirmed)
    ));
    assert!(Arc::ptr_eq(&material.frozen, &frozen));
    assert!(Arc::ptr_eq(&material.cleanup, &cleanup));
    assert_eq!(control.source_close_calls.load(Ordering::SeqCst), 0);
    assert!(!control.source_close_started.is_cancelled());
    assert!(!control.source_close_completed.load(Ordering::SeqCst));
    assert_eq!(control.auth_resolves.load(Ordering::SeqCst), 1);
    assert_eq!(control.sized_reads.load(Ordering::SeqCst), 0);
    assert_eq!(control.opens.load(Ordering::SeqCst), 0);
    assert_eq!(control.requests.load(Ordering::SeqCst), 0);
    assert_eq!(control.frozen_opens.load(Ordering::SeqCst), 0);
    drop(frozen);
    drop(cleanup);
    assert!(
        original.upgrade().is_some(),
        "the actual unknown opening error owns the source"
    );
    assert!(!control.source_dropped.load(Ordering::SeqCst));
    drop(error);
    assert!(original.upgrade().is_none());
    assert!(control.source_dropped.load(Ordering::SeqCst));
}

#[tokio::test(start_paused = true)]
async fn pending_cleanup_observer_tracks_original_adapter_then_source_close() {
    for timed_out in [false, true] {
        let control = Arc::new(DelayedCleanup::default());
        let (source, material) = delayed_source(control.clone(), false);
        let executor = ModelExecutor::new(Duration::from_secs(60)).unwrap();
        let cancellation = CancellationToken::new();
        let mut stream = executor
            .stream_with_source(
                request(
                    ProviderKind::OpenaiChatCompletions,
                    "http://unused.example/v1".into(),
                ),
                cancellation.clone(),
                None,
                delayed_cleanup_binding(control.clone()),
                Some(source),
            )
            .await
            .unwrap();
        let observer = stream.cleanup_observer();
        let original_observer = observer.clone();
        assert!(matches!(
            stream.next().await.unwrap().unwrap().event,
            ModelEvent::ResponseMetadata { .. }
        ));
        if timed_out {
            tokio::time::advance(Duration::from_secs(60)).await;
        } else {
            cancellation.cancel();
        }
        let first = stream.next().await.unwrap().unwrap_err();
        assert!(matches!(
            (&first, timed_out),
            (Error::TimedOut, true) | (Error::Cancelled, false)
        ));
        assert!(!observer.status().unwrap());
        assert!(!control.adapter_future_dropped.load(Ordering::SeqCst));

        let mut cleanup = Box::pin(stream.cancel_and_wait());
        assert!(futures_util::poll!(&mut cleanup).is_pending());
        tokio::time::advance(Duration::from_secs(6)).await;
        let pending = cleanup.as_mut().await.unwrap_err();
        drop(cleanup);
        assert!(
            matches!(&pending, StreamCleanupError::Pending { cause: Some(cause), .. }
            if matches!((cause.as_ref(), timed_out), (Error::TimedOut, true) | (Error::Cancelled, false)))
        );
        let pending_observer = pending
            .observer()
            .expect("original worker remains observable");
        assert!(!observer.status().unwrap());
        assert!(!pending_observer.status().unwrap());
        assert!(!control.adapter_future_dropped.load(Ordering::SeqCst));
        assert_eq!(control.source_close_calls.load(Ordering::SeqCst), 0);
        assert!(material.upgrade().is_some());

        control.release_adapter.cancel();
        control.source_close_started.cancelled().await;
        assert!(control.adapter_future_dropped.load(Ordering::SeqCst));
        assert_eq!(control.source_close_calls.load(Ordering::SeqCst), 1);
        assert!(!control.source_close_completed.load(Ordering::SeqCst));
        assert!(!original_observer.status().unwrap());
        assert!(!pending_observer.status().unwrap());
        assert!(futures_util::poll!(Box::pin(observer.wait())).is_pending());
        assert!(material.upgrade().is_some());

        control.release_source_close.cancel();
        let (original, after_pending) =
            tokio::join!(original_observer.wait(), pending_observer.wait());
        original.unwrap();
        after_pending.unwrap();
        assert!(observer.status().unwrap());
        assert!(pending_observer.status().unwrap());
        assert!(control.source_close_completed.load(Ordering::SeqCst));
        assert!(control.source_dropped.load(Ordering::SeqCst));
        assert!(material.upgrade().is_none());
        assert!(
            matches!(&pending, StreamCleanupError::Pending { cause: Some(cause), .. }
            if matches!((cause.as_ref(), timed_out), (Error::TimedOut, true) | (Error::Cancelled, false)))
        );
        assert_eq!(control.opens.load(Ordering::SeqCst), 1);
        assert_eq!(control.requests.load(Ordering::SeqCst), 1);
        assert_eq!(control.source_close_calls.load(Ordering::SeqCst), 1);
        assert_eq!(control.frozen_opens.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test(start_paused = true)]
async fn failed_source_close_is_unobservable_and_retains_original_material_and_cause() {
    let control = Arc::new(DelayedCleanup::default());
    let (source, material) = delayed_source(control.clone(), true);
    let executor = ModelExecutor::new(Duration::from_secs(60)).unwrap();
    let cancellation = CancellationToken::new();
    let mut stream = executor
        .stream_with_source(
            request(
                ProviderKind::OpenaiChatCompletions,
                "http://unused.example/v1".into(),
            ),
            cancellation.clone(),
            None,
            delayed_cleanup_binding(control.clone()),
            Some(source),
        )
        .await
        .unwrap();
    let observer = stream.cleanup_observer();
    let original_observer = observer.clone();
    assert!(matches!(
        stream.next().await.unwrap().unwrap().event,
        ModelEvent::ResponseMetadata { .. }
    ));
    cancellation.cancel();
    assert!(matches!(
        stream.next().await.unwrap(),
        Err(Error::Cancelled)
    ));
    let mut cleanup = Box::pin(stream.cancel_and_wait());
    assert!(futures_util::poll!(&mut cleanup).is_pending());
    control.release_adapter.cancel();
    control.source_close_started.cancelled().await;
    assert!(!observer.status().unwrap());
    assert!(control.adapter_future_dropped.load(Ordering::SeqCst));
    control.release_source_close.cancel();
    let error = cleanup.as_mut().await.unwrap_err();
    drop(cleanup);
    assert!(matches!(&error, StreamCleanupError::Unobservable {
        stage: StreamCleanupStage::Source, cause, original: Some(original), material: Some(_),
    } if cause.to_string().contains("original source close failed") && matches!(original.as_ref(), Error::Cancelled)));
    assert!(error.observer().is_none());
    for observed in [observer.wait().await, original_observer.wait().await] {
        assert!(matches!(
            observed,
            Err(StreamCleanupError::Unobservable {
                stage: StreamCleanupStage::Source,
                ..
            })
        ));
    }
    assert!(matches!(
        observer.status(),
        Err(StreamCleanupError::Unobservable {
            stage: StreamCleanupStage::Source,
            ..
        })
    ));
    assert!(!control.source_close_completed.load(Ordering::SeqCst));
    assert!(!control.source_dropped.load(Ordering::SeqCst));
    drop(observer);
    drop(original_observer);
    let retained = material
        .upgrade()
        .expect("typed failure must hold the actual original source");
    let StreamCleanupError::Unobservable {
        material: Some(original),
        ..
    } = &error
    else {
        unreachable!()
    };
    let frozen: Arc<dyn FrozenPrompt> = retained;
    assert!(Arc::ptr_eq(&original.frozen, &frozen));
    assert_eq!(control.opens.load(Ordering::SeqCst), 1);
    assert_eq!(control.requests.load(Ordering::SeqCst), 1);
    assert_eq!(control.source_close_calls.load(Ordering::SeqCst), 1);
    assert_eq!(control.frozen_opens.load(Ordering::SeqCst), 0);
}
