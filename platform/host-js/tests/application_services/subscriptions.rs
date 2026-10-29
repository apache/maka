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
use maka_host_runtime::application::{Binding, Client};
use std::sync::Mutex;

type Callback = dyn Fn(Value, Context) -> BoxFuture<'static, Result<Value>> + Send + Sync;
struct StreamHandler(Arc<Callback>);
impl Handler for StreamHandler {
    fn call(&self, _: String, input: Value, context: Context) -> BoxFuture<'static, Result<Value>> {
        (self.0)(input, context)
    }
}
fn stream_consumer() -> Package {
    package(
        "stream.consumer",
        entry(
            false,
            Implementation::JavaScript {
                module: "host.mjs".into(),
                realm: Realm::Shared,
            },
            MethodMode::Subscription,
        ),
        Some("export function activate() { return {}; }".into()),
    )
}
async fn native_stream(
    f: impl Fn(Value, Context) -> BoxFuture<'static, Result<Value>> + Send + Sync + 'static,
) -> (Application, Client, Binding, Issuer) {
    let provider = package(
        "stream.native",
        entry(
            true,
            Implementation::Native {
                implementation: "native.echo".into(),
            },
            MethodMode::Subscription,
        ),
        None,
    );
    let consumer = stream_consumer();
    let issuer = Issuer::default();
    let app = Application::start(
        input(&provider, &consumer),
        vec![provider, consumer],
        registry_contract(
            Arc::new(StreamHandler(Arc::new(f))),
            contract(MethodMode::Subscription),
        ),
        issuer.clone(),
        Arc::new(Grant(issuer.clone())),
        Some(maka_host_js::factory(Limits::default())),
    )
    .unwrap();
    app.ready().await.unwrap();
    let client = app.client();
    let binding = client
        .bind(client.activation(&id(2)).unwrap(), "echo".into())
        .await
        .unwrap()
        .remove(0);
    (app, client, binding, issuer)
}

fn wide_item(index: usize) -> Value {
    json!(format!("{index}:{}:尾", "中🙂\"\\\n\0".repeat(8192)))
}

#[tokio::test]
async fn javascript_streams_ordered_items_and_final_result_in_both_realms() {
    tokio::time::timeout(Duration::from_secs(20), async {
        for realm in [Realm::Shared, Realm::Dedicated] {
            let source = format!(r#"
                export const service = {{ async echo(input, observation, context) {{
                    for (let i=0;i<35;i++) await context.invoke({{operation:'emit',value:input+':'+i}});
                    return input+':done';
                }} }};
                export function activate() {{ return {{echo:{{contract:{},service:['service']}}}}; }}
            "#, serde_json::to_string(&contract(MethodMode::Subscription)).unwrap());
            let provider = package("stream.javascript", entry(true, Implementation::JavaScript {
                module: "host.mjs".into(), realm,
            }, MethodMode::Subscription), Some(source));
            let consumer = stream_consumer();
            let issuer = Issuer::default();
            let app = Application::start(input(&provider,&consumer),vec![provider,consumer],NativeRegistry::default(),
                issuer.clone(),Arc::new(Grant(issuer.clone())),Some(maka_host_js::factory(Limits::default()))).unwrap();
            app.ready().await.unwrap();
            let client=app.client();
            let binding=client.bind(client.activation(&id(2)).unwrap(),"echo".into()).await.unwrap().remove(0);
            let mut stream=client.subscribe(binding,"echo".into(),wide_item(0),scope(&issuer,true),Attachments::new().into()).await.unwrap();
            for i in 0..35 {
                let expected = json!(format!("{}:{i}", wide_item(0).as_str().unwrap()));
                assert!(stream.recv().await == Some(expected), "original JavaScript item {i} changed");
            }
            assert_eq!(stream.recv().await,None);
            let completion=stream.completion().await;
            assert!(completion.result.unwrap() == json!(format!("{}:done", wide_item(0).as_str().unwrap())), "original JavaScript terminal result changed");
            completion.cleanup.unwrap();
            app.shutdown().await.unwrap();
        }
    }).await.unwrap();
}

#[tokio::test]
async fn stream_admission_preserves_mode_issuer_policy_and_revocation() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let (app, client, binding, issuer) = native_stream(move |input, _| {
            count.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { Ok(input) })
        })
        .await;
        assert!(
            client
                .start(
                    binding.clone(),
                    "echo".into(),
                    json!("x"),
                    scope(&issuer, true),
                    Attachments::new().into()
                )
                .await
                .is_err()
        );
        let revoked = scope(&issuer, true);
        revoked.cancellation.cancel();
        for denied in [
            scope(&Issuer::default(), true),
            scope(&issuer, false),
            revoked,
        ] {
            assert!(
                client
                    .subscribe(
                        binding.clone(),
                        "echo".into(),
                        json!("x"),
                        denied,
                        Attachments::new().into()
                    )
                    .await
                    .is_err()
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let mut stream = client
            .subscribe(
                binding,
                "echo".into(),
                json!("ok"),
                scope(&issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        assert_eq!(stream.recv().await, None);
        let completion = stream.completion().await;
        assert_eq!(completion.result.unwrap(), json!("ok"));
        completion.cleanup.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        app.shutdown().await.unwrap();
        let provider = native_package();
        let consumer = consumer();
        let issuer = Issuer::default();
        let app = Application::start(
            input(&provider, &consumer),
            vec![provider, consumer],
            registry(Arc::new(Echo {
                calls: calls.clone(),
            })),
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            Some(maka_host_js::factory(Limits::default())),
        )
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        assert!(
            client
                .subscribe(
                    binding,
                    "echo".into(),
                    json!("x"),
                    scope(&issuer, true),
                    Attachments::new().into()
                )
                .await
                .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn retained_context_cannot_publish_after_producer_end_or_block_eof() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let saved = Arc::new(Mutex::new(None));
        let retained = saved.clone();
        let (app, client, binding, issuer) = native_stream(move |_, context| {
            let retained = retained.clone();
            Box::pin(async move {
                context.emit(json!("before")).await?;
                *retained.lock().unwrap() = Some(context);
                Ok(json!("final"))
            })
        })
        .await;
        let mut stream = client
            .subscribe(
                binding,
                "echo".into(),
                json!("x"),
                scope(&issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        assert_eq!(stream.recv().await, Some(json!("before")));
        assert_eq!(stream.recv().await, None);
        let late = saved.lock().unwrap().as_ref().unwrap().emit(json!("after"));
        assert!(late.await.unwrap_err().contains("closed"));
        assert_eq!(stream.completion().await.result.unwrap(), json!("final"));
        // An old Context is observation/custody, not an execution owner.
        app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn large_items_preserve_schema_and_all_unpolled_emissions() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let (app, client, binding, issuer) = native_stream(|_, context| {
            Box::pin(async move {
                assert!(context.emit(json!(false)).await.is_err());
                context.emit(wide_item(0)).await?;
                let mut pending = Vec::new();
                for i in 0..33 {
                    pending.push(context.emit(json!(format!("item:{i}"))));
                }
                for emitted in pending {
                    emitted.await?;
                }
                Ok(json!("done"))
            })
        })
        .await;
        let mut stream = client
            .subscribe(
                binding,
                "echo".into(),
                json!("x"),
                scope(&issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        assert!(
            stream.recv().await == Some(wide_item(0)),
            "original native item changed"
        );
        for i in 0..33 {
            assert_eq!(stream.recv().await, Some(json!(format!("item:{i}"))));
        }
        assert_eq!(stream.recv().await, None);
        let completion = stream.completion().await;
        assert_eq!(completion.result.unwrap(), json!("done"));
        completion.cleanup.unwrap();
        app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn backpressure_completion_and_drop_cancel_only_their_subscription() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let full = Arc::new(Semaphore::new(0));
        let starts = full.clone();
        let stopped = Arc::new(Semaphore::new(0));
        let stops = stopped.clone();
        let (app, client, binding, issuer) = native_stream(move |_, context| {
            let starts = starts.clone();
            let stops = stops.clone();
            Box::pin(async move {
                for _ in 0..16 {
                    context.emit(json!("buffered")).await?;
                }
                starts.add_permits(1);
                let result = context.emit(json!("blocked")).await;
                stops.add_permits(1);
                result?;
                Ok(json!("unexpected"))
            })
        })
        .await;
        let parent = scope(&issuer, true);
        let first = client
            .subscribe(
                binding.clone(),
                "echo".into(),
                json!("x"),
                parent.clone(),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        let mut second = client
            .subscribe(
                binding,
                "echo".into(),
                json!("x"),
                parent.clone(),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        permit(&full).await;
        permit(&full).await;
        assert_eq!(stopped.available_permits(), 0);
        let completion = first.completion().await;
        assert!(completion.result.is_err());
        completion.cleanup.unwrap();
        permit(&stopped).await;
        assert!(!parent.cancellation.is_cancelled());
        assert_eq!(stopped.available_permits(), 0);
        assert_eq!(second.recv().await, Some(json!("buffered")));
        // The released queue slot proves independent reader demand.
        permit(&stopped).await;
        second.completion().await.cleanup.unwrap();
        let third = client
            .subscribe(
                client
                    .bind(client.activation(&id(2)).unwrap(), "echo".into())
                    .await
                    .unwrap()
                    .remove(0),
                "echo".into(),
                json!("x"),
                parent.clone(),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        permit(&full).await;
        drop(third);
        permit(&stopped).await;
        assert!(!parent.cancellation.is_cancelled());
        app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn eof_precedes_actual_resource_cleanup_and_never_acknowledges_it() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let release = Arc::new(Semaphore::new(0));
        let cleanup = release.clone();
        let (app, client, binding, issuer) = native_stream(move |_, context| {
            let cleanup = cleanup.clone();
            Box::pin(async move {
                let mut ticket = context.scope().resources.reserve().unwrap();
                ticket.start();
                tokio::spawn(async move {
                    permit(&cleanup).await;
                    ticket.complete(Ok(()));
                });
                context.emit(json!("visible")).await?;
                Ok(json!("done"))
            })
        })
        .await;
        let mut stream = client
            .subscribe(
                binding,
                "echo".into(),
                json!("x"),
                scope(&issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        assert_eq!(stream.recv().await, Some(json!("visible")));
        assert_eq!(stream.recv().await, None);
        let completion = stream.completion();
        tokio::pin!(completion);
        assert!(futures_util::poll!(&mut completion).is_pending());
        let status = client
            .snapshot()
            .instances
            .into_iter()
            .find(|s| s.activation.instance() == &id(1))
            .unwrap();
        assert_eq!(
            status.calls, 1,
            "EOF cannot release the original execution fence"
        );
        release.add_permits(1);
        let completion = completion.await;
        assert_eq!(completion.result.unwrap(), json!("done"));
        completion.cleanup.unwrap();
        app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn retained_polled_send_cannot_hold_eof_open_or_insert_after_close() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let retained = Arc::new(Mutex::new(None));
        let saved = retained.clone();
        let (app, client, binding, issuer) = native_stream(move |_, context| {
            let saved = saved.clone();
            Box::pin(async move {
                for i in 0..16 {
                    context.emit(json!(format!("queued:{i}"))).await?;
                }
                let mut blocked = context.emit(json!("must not appear"));
                assert!(futures_util::poll!(&mut blocked).is_pending());
                *saved.lock().unwrap() = Some(blocked);
                Ok(json!("done"))
            })
        })
        .await;
        let mut stream = client
            .subscribe(
                binding,
                "echo".into(),
                json!("x"),
                scope(&issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        for i in 0..16 {
            assert_eq!(stream.recv().await, Some(json!(format!("queued:{i}"))));
        }
        assert_eq!(stream.recv().await, None);
        let blocked = retained.lock().unwrap().take().unwrap();
        assert!(blocked.await.is_err());
        let completion = stream.completion().await;
        assert_eq!(completion.result.unwrap(), json!("done"));
        completion.cleanup.unwrap();
        app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn dropping_admission_future_revokes_queued_work_without_cancelling_parent() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let (app, client, binding, issuer) = native_stream(move |_, _| {
            count.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(json!("done")) })
        })
        .await;
        let parent = scope(&issuer, true);
        let mut pending = Box::pin(client.subscribe(
            binding,
            "echo".into(),
            json!("x"),
            parent.clone(),
            Attachments::new().into(),
        ));
        assert!(futures_util::poll!(&mut pending).is_pending());
        drop(pending);
        app.shutdown().await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!parent.cancellation.is_cancelled());
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn failed_cleanup_or_panic_closes_data_but_preserves_actual_execution_fence() {
    tokio::time::timeout(Duration::from_secs(15), async {
        for panics in [false, true] {
            let (app, client, binding, issuer) = native_stream(move |_, context| {
                Box::pin(async move {
                    context.emit(json!("visible")).await?;
                    if panics {
                        panic!("stream producer panicked");
                    }
                    let mut ticket = context.scope().resources.reserve().unwrap();
                    ticket.start();
                    ticket.complete(Err("stream cleanup unconfirmed".into()));
                    Ok(json!("done"))
                })
            })
            .await;
            let mut stream = client
                .subscribe(
                    binding,
                    "echo".into(),
                    json!("x"),
                    scope(&issuer, true),
                    Attachments::new().into(),
                )
                .await
                .unwrap();
            assert_eq!(stream.recv().await, Some(json!("visible")));
            assert_eq!(stream.recv().await, None);
            let completion = stream.completion().await;
            assert!(completion.cleanup.is_err());
            if panics {
                assert!(completion.result.is_err());
            } else {
                assert_eq!(completion.result.unwrap(), json!("done"));
            }
            assert!(app.shutdown().await.is_err());
            let status = client
                .snapshot()
                .instances
                .into_iter()
                .find(|s| s.activation.instance() == &id(1))
                .unwrap();
            assert_eq!(status.phase, Phase::Retiring);
            assert_eq!(status.calls, 1);
            assert!(!status.failures.is_empty());
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn execution_scope_cancellation_wakes_backpressure_and_revokes_new_emits() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let (app, client, binding, issuer) = native_stream(|_, context| {
            Box::pin(async move {
                for _ in 0..16 {
                    context.emit(json!("buffered")).await?;
                }
                let mut waiting = context.emit(json!("blocked"));
                assert!(futures_util::poll!(&mut waiting).is_pending());
                context.scope().cancellation.cancel();
                assert!(waiting.await.is_err());
                assert!(context.emit(json!("revoked")).await.is_err());
                Ok(json!("done"))
            })
        })
        .await;
        let parent = scope(&issuer, true);
        let mut stream = client
            .subscribe(
                binding,
                "echo".into(),
                json!("x"),
                parent.clone(),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        for _ in 0..16 {
            assert_eq!(stream.recv().await, Some(json!("buffered")));
        }
        assert_eq!(stream.recv().await, None);
        let completion = stream.completion().await;
        assert_eq!(completion.result.unwrap(), json!("done"));
        completion.cleanup.unwrap();
        assert!(!parent.cancellation.is_cancelled());
        app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn terminal_result_schema_and_query_emit_rejection_share_existing_owner() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let (app, client, binding, issuer) = native_stream(|_, context| {
            Box::pin(async move {
                context.emit(json!("valid item")).await?;
                Ok(json!(false))
            })
        })
        .await;
        let mut stream = client
            .subscribe(
                binding,
                "echo".into(),
                json!("x"),
                scope(&issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        assert_eq!(stream.recv().await, Some(json!("valid item")));
        assert_eq!(stream.recv().await, None);
        let completion = stream.completion().await;
        assert!(completion.result.is_err());
        completion.cleanup.unwrap();
        app.shutdown().await.unwrap();
        let provider = native_package();
        let consumer = consumer();
        let issuer = Issuer::default();
        let handler = StreamHandler(Arc::new(|input, context| {
            Box::pin(async move {
                assert!(
                    context
                        .emit(json!("invalid query publication"))
                        .await
                        .unwrap_err()
                        .contains("does not declare a progress stream")
                );
                Ok(input)
            })
        }));
        let app = Application::start(
            input(&provider, &consumer),
            vec![provider, consumer],
            registry(Arc::new(handler)),
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            Some(maka_host_js::factory(Limits::default())),
        )
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let completion = client
            .start(
                binding,
                "echo".into(),
                json!("query"),
                scope(&issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap()
            .completion()
            .await;
        assert_eq!(completion.result.unwrap(), json!("query"));
        completion.cleanup.unwrap();
        app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_context_subscription_drop_preserves_parent_and_tracks_actual_child_cleanup() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let leaf = package(
            "stream.leaf",
            entry(
                true,
                Implementation::Native {
                    implementation: "native.echo".into(),
                },
                MethodMode::Subscription,
            ),
            None,
        );
        let mut declaration = entry(
            true,
            Implementation::Native {
                implementation: "native.forward.stream".into(),
            },
            MethodMode::Query,
        );
        declaration.imports = entry(
            false,
            Implementation::Native {
                implementation: "unused".into(),
            },
            MethodMode::Subscription,
        )
        .imports;
        let wrapper = package("stream.wrapper", declaration, None);
        let consumer = consumer();
        let mut desired = input(&wrapper, &consumer);
        let parent = desired.instances.get_mut("provider").unwrap();
        parent.key = Uuid::from_u128(4);
        parent.bindings.insert(
            "echo".into(),
            vec![Target::Instance {
                path: vec!["leaf".into()],
                export: "echo".into(),
            }],
        );
        desired
            .instances
            .insert("leaf".into(), node(&leaf, 1, true));
        let cancelled = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let observed = Arc::new(Semaphore::new(0));
        let leaf_cancelled = cancelled.clone();
        let leaf_release = release.clone();
        let mut registry = registry_contract(
            Arc::new(StreamHandler(Arc::new(move |input, context| {
                let cancelled = leaf_cancelled.clone();
                let release = leaf_release.clone();
                Box::pin(async move {
                    context.emit(json!("first")).await?;
                    if input == "held" {
                        context.scope().cancellation.cancelled().await;
                        cancelled.add_permits(1);
                        permit(&release).await;
                    }
                    Ok(json!("complete"))
                })
            }))),
            contract(MethodMode::Subscription),
        );
        let returned = observed.clone();
        registry
            .insert(
                "native.forward.stream".into(),
                Arc::new(move |_, _| {
                    let returned = returned.clone();
                    Box::pin(async move {
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "echo".into(),
                                Published {
                                    contract: contract(MethodMode::Query),
                                    value: Arc::new(StreamHandler(Arc::new(
                                        move |input, context| {
                                            let returned = returned.clone();
                                            // Context admission enqueues synchronously, before polling.
                                            let pending = context.subscribe(
                                                "echo",
                                                0,
                                                "echo".into(),
                                                if input == "after" {
                                                    json!("held")
                                                } else {
                                                    json!("healthy")
                                                },
                                                Attachments::default(),
                                            );
                                            Box::pin(async move {
                                                let pending = pending?;
                                                if input == "before" {
                                                    drop(pending);
                                                } else {
                                                    let mut stream = pending.await?;
                                                    assert_eq!(
                                                        stream.recv().await,
                                                        Some(json!("first"))
                                                    );
                                                    drop(stream);
                                                }
                                                assert!(
                                                    !context.scope().cancellation.is_cancelled()
                                                );
                                                let mut next = context
                                                    .subscribe(
                                                        "echo",
                                                        0,
                                                        "echo".into(),
                                                        json!("healthy"),
                                                        Attachments::default(),
                                                    )?
                                                    .await?;
                                                assert_eq!(next.recv().await, Some(json!("first")));
                                                assert_eq!(next.recv().await, None);
                                                let completion = next.completion().await;
                                                completion.cleanup?;
                                                assert_eq!(completion.result?, json!("complete"));
                                                assert!(
                                                    !context.scope().cancellation.is_cancelled()
                                                );
                                                returned.add_permits(1);
                                                Ok(json!("parent returned"))
                                            })
                                        },
                                    )))
                                        as Arc<dyn Handler>,
                                },
                            )])),
                            owner: native_owner(|| Box::pin(async { Ok(()) })),
                        }
                    })
                }),
            )
            .unwrap();
        let issuer = Issuer::default();
        let app = Application::start(
            desired,
            vec![leaf, wrapper, consumer],
            registry,
            issuer.clone(),
            Arc::new(ForwardPolicy(issuer.clone())),
            Some(maka_host_js::factory(Limits::default())),
        )
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        // Wrapper admission cannot replace the original child authorization.
        assert!(
            client
                .start(
                    binding.clone(),
                    "echo".into(),
                    json!("denied"),
                    scope(&issuer, false),
                    Attachments::default().into()
                )
                .await
                .unwrap()
                .result()
                .await
                .is_err()
        );
        for mode in ["before", "after"] {
            let parent = client
                .start(
                    binding.clone(),
                    "echo".into(),
                    json!(mode),
                    scope(&issuer, true),
                    Attachments::default().into(),
                )
                .await
                .unwrap();
            permit(&observed).await;
            let completion = parent.completion();
            tokio::pin!(completion);
            if mode == "after" {
                permit(&cancelled).await;
                assert!(
                    futures_util::poll!(&mut completion).is_pending(),
                    "dropping the child does not confirm actual cleanup"
                );
                release.add_permits(1);
            }
            let completion = completion.await;
            completion.cleanup.unwrap();
            assert_eq!(completion.result.unwrap(), json!("parent returned"));
        }
        app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
