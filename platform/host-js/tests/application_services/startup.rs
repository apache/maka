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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_initial_start_keeps_independent_initializers_and_original_cleanup_custody() {
    let (directory, namespaces, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let provider = native_package();
        let consumer = consumer();
        let mut desired = input(&provider, &consumer);
        desired
            .instances
            .get_mut("provider")
            .unwrap()
            .configuration
            .values = BTreeMap::from([("fail".into(), json!(true))]);
        desired
            .instances
            .insert("healthy".into(), node(&provider, 4, true));
        let mut reader = node(&consumer, 5, false);
        reader.bindings.insert(
            "echo".into(),
            vec![Target::Instance {
                path: vec!["healthy".into()],
                export: "echo".into(),
            }],
        );
        desired.instances.insert("reader".into(), reader);
        let original = store
            .commit_application(
                Uuid::new_v4(),
                0,
                desired.clone(),
                vec![],
                vec![provider.clone(), consumer.clone()],
            )
            .await
            .unwrap();
        let healthy_started = Arc::new(Semaphore::new(0));
        let healthy_release = Arc::new(Semaphore::new(0));
        let close_started = Arc::new(Semaphore::new(0));
        let close_release = Arc::new(Semaphore::new(0));
        let attempts = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let lifetime = Arc::new(std::sync::Mutex::new(std::sync::Weak::<()>::new()));
        let mut native = NativeRegistry::default();
        let started = healthy_started.clone();
        let release = healthy_release.clone();
        let closing = close_started.clone();
        let closed = close_release.clone();
        let initialized = attempts.clone();
        let invoked = calls.clone();
        let observed = lifetime.clone();
        native
            .insert(
                "native.echo".into(),
                Arc::new(move |context, configuration| {
                    let started = started.clone();
                    let release = release.clone();
                    let closing = closing.clone();
                    let closed = closed.clone();
                    let initialized = initialized.clone();
                    let invoked = invoked.clone();
                    let observed = observed.clone();
                    Box::pin(async move {
                        if context.activation().instance() == &id(4) {
                            started.add_permits(1);
                            permit(&release).await;
                        } else {
                            initialized.fetch_add(1, Ordering::SeqCst);
                        }
                        if configuration.get("fail") == Some(&json!(true)) {
                            let resource = Arc::new(());
                            *observed.lock().unwrap() = Arc::downgrade(&resource);
                            NativeActivation {
                                exports: Err("original initializer rejected".into()),
                                owner: native_owner(move || {
                                    let closing = closing.clone();
                                    let closed = closed.clone();
                                    let resource = resource.clone();
                                    Box::pin(async move {
                                        closing.add_permits(1);
                                        permit(&closed).await;
                                        drop(resource);
                                        Ok(())
                                    })
                                }),
                            }
                        } else {
                            NativeActivation {
                                exports: Ok(BTreeMap::from([(
                                    "echo".into(),
                                    Published {
                                        contract: contract(MethodMode::Query),
                                        value: Arc::new(Echo { calls: invoked })
                                            as Arc<dyn Handler>,
                                    },
                                )])),
                                owner: native_owner(|| Box::pin(async { Ok(()) })),
                            }
                        }
                    })
                }),
            )
            .unwrap();
        let issuer = Issuer::default();
        let app = Application::start_from_store(
            store.clone(),
            original.deployment,
            native,
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            Some(maka_host_js::factory(Limits::default())),
        )
        .await
        .unwrap();
        let client = app.client();
        permit(&healthy_started).await;
        assert!(
            app.ready()
                .await
                .unwrap_err()
                .contains("original initializer rejected")
        );
        permit(&close_started).await;
        assert!(
            !client.snapshot().closing,
            "an independent startup failure must not stop the Host"
        );
        assert_eq!(client.snapshot().effective, None);
        assert_eq!(client.snapshot().desired, Some(original.clone()));
        assert!(lifetime.lock().unwrap().upgrade().is_some());
        let failed = client.activation(&id(1)).unwrap();
        for id in [id(1), id(2), id(3)] {
            assert!(client.ready_instance(&id).await.is_err());
        }
        use maka_host_runtime::application::CapturedImport;
        match client.capture_import(id(2), "echo".into()).await.unwrap() {
            CapturedImport::Unavailable {
                provider,
                export,
                contract: declared,
            } => {
                assert_eq!(provider, id(1));
                assert_eq!(export, "echo");
                assert_eq!(declared, contract(MethodMode::Query));
            }
            CapturedImport::Ready(_) => panic!("failed dependency cannot mint a binding"),
        }
        assert!(client.capture_import(id(999), "echo".into()).await.is_err());
        assert!(
            client
                .capture_import(id(2), "missing".into())
                .await
                .is_err()
        );
        healthy_release.add_permits(1);
        let reader = client.ready_instance(&id(5)).await.unwrap();
        let healthy = client.activation(&id(4)).unwrap();
        let binding = client
            .bind(reader.clone(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        assert!(
            client
                .start(
                    binding.clone(),
                    "echo".into(),
                    json!("denied"),
                    scope(&issuer, false),
                    Attachments::new().into()
                )
                .await
                .is_err()
        );
        assert_eq!(
            client
                .start(
                    binding.clone(),
                    "echo".into(),
                    json!("healthy"),
                    scope(&issuer, true),
                    Attachments::new().into()
                )
                .await
                .unwrap()
                .result()
                .await
                .unwrap(),
            json!("healthy")
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(client.activation(&id(2)).is_err());
        assert!(client.activation(&id(3)).is_err());
        app.adopt_committed(original.clone()).await.unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert!(app.ready().await.is_err());
        assert_eq!(
            RootOwner::open(&directory.path().join("root"), &namespaces)
                .err()
                .unwrap()
                .kind(),
            std::io::ErrorKind::WouldBlock
        );

        desired
            .instances
            .get_mut("provider")
            .unwrap()
            .configuration
            .values
            .clear();
        let repaired = store
            .commit_application(
                original.deployment,
                1,
                desired,
                vec![],
                vec![provider, consumer],
            )
            .await
            .unwrap();
        app.adopt_committed(repaired.clone()).await.unwrap();
        {
            let ready = app.ready();
            tokio::pin!(ready);
            assert!(futures_util::poll!(ready.as_mut()).is_pending());
            assert_eq!(client.activation(&id(1)).unwrap(), failed);
            assert_eq!(client.activation(&id(4)).unwrap(), healthy);
            assert_eq!(client.activation(&id(5)).unwrap(), reader);
            assert_eq!(attempts.load(Ordering::SeqCst), 1);
            assert_eq!(
                client
                    .start(
                        binding,
                        "echo".into(),
                        json!("during repair"),
                        scope(&issuer, true),
                        Attachments::new().into()
                    )
                    .await
                    .unwrap()
                    .result()
                    .await
                    .unwrap(),
                json!("during repair")
            );
            assert!(lifetime.lock().unwrap().upgrade().is_some());
            close_release.add_permits(1);
            ready.await.unwrap();
        }
        assert_ne!(client.activation(&id(1)).unwrap(), failed);
        assert!(matches!(
            client.capture_import(id(2), "echo".into()).await.unwrap(),
            CapturedImport::Ready(_)
        ));
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(client.activation(&id(4)).unwrap(), healthy);
        assert_eq!(client.snapshot().effective, Some(repaired));
        assert!(client.snapshot().initialization_failures.is_empty());
        assert!(client.ready_instance(&id(999)).await.is_err());
        assert!(lifetime.lock().unwrap().upgrade().is_none());
        app.shutdown().await.unwrap();
        assert!(client.ready_instance(&id(4)).await.is_err());
        drop((app, client));
        close(store).await;
        drop(RootOwner::open(&directory.path().join("root"), &namespaces).unwrap());
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn startup_shared_vm_failure_leaves_independent_domain_and_pending_native_owner_available() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let provider = package(
            "startup.shared",
            entry(
                true,
                Implementation::JavaScript {
                    module: "host.mjs".into(),
                    realm: Realm::Shared,
                },
                MethodMode::Query,
            ),
            Some(format!(
                r#"
                export const service = {{ echo(input) {{ return input; }} }};
                export function activate(config) {{
                    if(config.crash) while(true) {{}}
                    return {{echo:{{contract:{},service:['service']}}}};
                }}
            "#,
                serde_json::to_string(&contract(MethodMode::Query)).unwrap()
            )),
        );
        let consumer = consumer();
        let separate = package(
            "startup.dedicated",
            entry(
                false,
                Implementation::JavaScript {
                    module: "host.mjs".into(),
                    realm: Realm::Dedicated,
                },
                MethodMode::Query,
            ),
            Some("export function activate() { return {}; }".into()),
        );
        let native = native_package();
        let mut desired = input(&provider, &consumer);
        desired
            .instances
            .get_mut("provider")
            .unwrap()
            .configuration
            .values
            .insert("crash".into(), json!(true));
        desired
            .instances
            .insert("other".into(), node(&provider, 4, true));
        desired
            .instances
            .get_mut("b")
            .unwrap()
            .bindings
            .get_mut("echo")
            .unwrap()[0] = Target::Instance {
            path: vec!["other".into()],
            export: "echo".into(),
        };
        desired
            .instances
            .insert("healthy".into(), node(&native, 6, true));
        let mut reader = node(&separate, 7, false);
        reader.bindings.get_mut("echo").unwrap()[0] = Target::Instance {
            path: vec!["healthy".into()],
            export: "echo".into(),
        };
        desired.instances.insert("reader".into(), reader);
        let began = Arc::new(Semaphore::new(0));
        let released = Arc::new(Semaphore::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let mut registry = NativeRegistry::default();
        let started = began.clone();
        let release = released.clone();
        let invoked = calls.clone();
        registry
            .insert(
                "native.echo".into(),
                Arc::new(move |_, _| {
                    let started = started.clone();
                    let release = release.clone();
                    let invoked = invoked.clone();
                    Box::pin(async move {
                        started.add_permits(1);
                        permit(&release).await;
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "echo".into(),
                                Published {
                                    contract: contract(MethodMode::Query),
                                    value: Arc::new(Echo { calls: invoked }) as Arc<dyn Handler>,
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
            vec![provider, consumer, separate, native],
            registry,
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            Some(maka_host_js::factory(Limits {
                synchronous_slice: Duration::from_millis(200),
                ..Limits::default()
            })),
        )
        .unwrap();
        let client = app.client();
        permit(&began).await;
        assert!(app.ready().await.is_err());
        assert!(!client.snapshot().closing);
        while ![id(1), id(4)]
            .iter()
            .all(|id| client.snapshot().initialization_failures.contains(id))
        {
            tokio::task::yield_now().await;
        }
        for id in [id(1), id(2), id(3), id(4)] {
            assert!(client.ready_instance(&id).await.is_err());
        }
        released.add_permits(1);
        let reader = client.ready_instance(&id(7)).await.unwrap();
        let binding = client.bind(reader, "echo".into()).await.unwrap().remove(0);
        assert_eq!(
            client
                .start(
                    binding,
                    "echo".into(),
                    json!("independent"),
                    scope(&issuer, true),
                    Attachments::new().into()
                )
                .await
                .unwrap()
                .result()
                .await
                .unwrap(),
            json!("independent")
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(app.ready().await.is_err());
        app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
