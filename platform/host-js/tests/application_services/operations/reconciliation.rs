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

fn js_provider(label: &str) -> Package {
    package(
        "installed-service",
        entry(
            true,
            Implementation::JavaScript {
                module: "host.mjs".into(),
                realm: Realm::Dedicated,
            },
            MethodMode::Query,
        ),
        Some(format!(
            r#"
        export const service = {{ echo(input) {{ return '{label}:' + input; }} }};
        export function activate() {{ return {{echo:{{contract:{},service:['service']}}}}; }}
    "#,
            serde_json::to_string(&contract(MethodMode::Query)).unwrap()
        )),
    )
}

#[tokio::test]
async fn live_adoption_preserves_original_mutation_preparation_and_unchanged_activations() {
    for automatic in [false, true] {
        let (dir, _namespaces, store) = store().await;
        tokio::time::timeout(Duration::from_secs(20), async {
            let issuer = Issuer::default();
            let calls = Arc::new(AtomicUsize::new(0));
            let (app, deployment) = launch(
                store.clone(),
                &issuer,
                Arc::new(AtomicBool::new(true)),
                Arc::new(Echo {
                    calls: calls.clone(),
                }),
            )
            .await;
            let original = app.source().unwrap().clone();
            let client = app.client();
            let consumer_activation = client.activation(&id(2)).unwrap();
            let provider_activation = client.activation(&id(1)).unwrap();
            let binding = client
                .bind(consumer_activation.clone(), "echo".into())
                .await
                .unwrap()
                .remove(0);
            let prepared = client
                .prepare_mutation(
                    binding.clone(),
                    "echo".into(),
                    json!("prepared"),
                    scope(&issuer, true),
                    Uuid::new_v4(),
                    Attachments::new().into(),
                )
                .await
                .unwrap();
            let reference = prepared.reference().clone();
            let recorded = store
                .record_application_intent(
                    original.clone(),
                    id(2),
                    reference.clone(),
                    serde_json::Value::Null,
                )
                .await
                .unwrap();
            let (provider, consumer) = mutation_packages();
            let addition = js_provider("installed");
            let mut desired = input(&provider, &consumer);
            desired
                .instances
                .insert("addition".into(), node(&addition, 4, true));
            let next = store
                .commit_application(
                    deployment,
                    1,
                    desired,
                    vec![],
                    vec![provider, consumer, addition],
                )
                .await
                .unwrap();
            if automatic {
                while client.snapshot().desired != Some(next.clone()) {
                    tokio::task::yield_now().await;
                }
            } else {
                app.adopt_committed(next.clone()).await.unwrap();
            }
            app.ready().await.unwrap();
            assert_eq!(client.snapshot().desired, Some(next.clone()));
            assert_eq!(client.snapshot().effective, Some(next.clone()));
            assert_eq!(client.activation(&id(2)).unwrap(), consumer_activation);
            assert_eq!(client.activation(&id(1)).unwrap(), provider_activation);
            let reply = client
                .mutate(prepared, recorded)
                .await
                .unwrap()
                .result()
                .await;
            assert_eq!(reply.reference, reference);
            assert!(matches!(
                reply.receipt,
                Receipt::Recorded {
                    outcome: OperationOutcome::Returned { .. },
                    ..
                }
            ));
            // Running activations retain checked origin evidence. Corrupting package
            // payloads prevents any fresh full source load, without changing that evidence.
            let connection = rusqlite::Connection::open(
                dir.path()
                    .join("root")
                    .join(maka_event_log::root::ROOT_DATABASE),
            )
            .unwrap();
            connection
                .execute("UPDATE application_package_files SET payload = X'00'", [])
                .unwrap();
            drop(connection);
            assert!(store.load_application_at(&original).await.is_err());
            let prepared = client
                .prepare_mutation(
                    binding,
                    "echo".into(),
                    json!("new call"),
                    scope(&issuer, true),
                    Uuid::new_v4(),
                    Attachments::new().into(),
                )
                .await
                .unwrap();
            let second = client.mutate_owned(prepared).await.unwrap().result().await;
            assert!(matches!(
                second.receipt,
                Receipt::Recorded {
                    outcome: OperationOutcome::Returned { .. },
                    ..
                }
            ));
            assert_eq!(second.reference.source, original);
            assert_eq!(calls.load(Ordering::SeqCst), 2);
            assert!(app.adopt_committed(original).await.is_err());
            assert_eq!(client.snapshot().desired, Some(next));
            app.shutdown().await.unwrap();
            drop((app, client));
            close(store).await;
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn live_installed_replacement_waits_for_original_call_resources_and_native_close() {
    let (_dir, _namespaces, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let provider = native_package();
        let consumer = consumer();
        let deployment = Uuid::new_v4();
        let original = store
            .commit_application(
                deployment,
                0,
                input(&provider, &consumer),
                vec![],
                vec![provider.clone(), consumer.clone()],
            )
            .await
            .unwrap();
        let started = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let resource_started = Arc::new(Semaphore::new(0));
        let resource_release = Arc::new(Semaphore::new(0));
        let close_started = Arc::new(Semaphore::new(0));
        let close_release = Arc::new(Semaphore::new(0));
        let query: Arc<dyn Handler> = Arc::new(Held {
            started: started.clone(),
            release: release.clone(),
            resource_started: resource_started.clone(),
            resource_release: resource_release.clone(),
        });
        let mut native = observer_registry(NativeRegistry::default());
        let closing = close_started.clone();
        let closed = close_release.clone();
        native
            .insert(
                "native.echo".into(),
                Arc::new(move |_, _| {
                    let query = query.clone();
                    let closing = closing.clone();
                    let closed = closed.clone();
                    Box::pin(async move {
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "echo".into(),
                                Published {
                                    contract: contract(MethodMode::Query),
                                    value: query,
                                },
                            )])),
                            owner: native_owner(move || {
                                let closing = closing.clone();
                                let closed = closed.clone();
                                Box::pin(async move {
                                    closing.add_permits(1);
                                    permit(&closed).await;
                                    Ok(())
                                })
                            }),
                        }
                    })
                }),
            )
            .unwrap();
        let issuer = Issuer::default();
        let app = Application::start_from_store(
            store.clone(),
            deployment,
            native,
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            Some(maka_host_js::factory(Limits::default())),
        )
        .await
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let old_activation = client.activation(&id(1)).unwrap();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let observer = client
            .start(
                binding.clone(),
                "echo".into(),
                json!("old"),
                scope(&issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        permit(&started).await;
        // Store validation is generic; executor-specific preflight must preserve the live plan.
        let missing = package(
            "missing",
            entry(
                true,
                Implementation::Native {
                    implementation: "unavailable".into(),
                },
                MethodMode::Query,
            ),
            None,
        );
        let invalid = store
            .commit_application(
                deployment,
                1,
                input(&missing, &consumer),
                vec![],
                vec![missing, consumer.clone()],
            )
            .await
            .unwrap();
        assert!(app.adopt_committed(invalid).await.is_err());
        assert_eq!(client.snapshot().desired, Some(original.clone()));
        assert_eq!(client.activation(&id(1)).unwrap(), old_activation);
        let replacement = js_provider("intermediate");
        let next = store
            .commit_application(
                deployment,
                2,
                input(&replacement, &consumer),
                vec![],
                vec![replacement, consumer.clone()],
            )
            .await
            .unwrap();
        app.adopt_committed(next.clone()).await.unwrap();
        let snapshot = client.snapshot();
        assert_eq!(snapshot.desired, Some(next));
        assert_eq!(snapshot.effective, Some(original.clone()));
        assert!(snapshot.starting);
        assert!(
            snapshot
                .instances
                .iter()
                .any(|s| s.activation == old_activation
                    && s.phase == Phase::Retiring
                    && s.calls == 1)
        );
        assert!(
            client
                .start(
                    binding.clone(),
                    "echo".into(),
                    json!("retired"),
                    scope(&issuer, true),
                    Attachments::new().into()
                )
                .await
                .is_err()
        );
        release.add_permits(1);
        permit(&resource_started).await;
        assert_eq!(close_started.available_permits(), 0);
        resource_release.add_permits(1);
        assert_eq!(observer.result().await.unwrap(), json!("old"));
        permit(&close_started).await;
        assert_eq!(client.activation(&id(1)).unwrap(), old_activation);
        // A newer committed candidate supersedes pending replacement without bypassing its fence.
        let latest_provider = js_provider("latest");
        let latest = store
            .commit_application(
                deployment,
                3,
                input(&latest_provider, &consumer),
                vec![],
                vec![latest_provider, consumer],
            )
            .await
            .unwrap();
        app.adopt_committed(latest.clone()).await.unwrap();
        assert!(client.snapshot().starting);
        assert_eq!(client.snapshot().effective, Some(original));
        close_release.add_permits(1);
        app.ready().await.unwrap();
        assert_eq!(client.snapshot().effective, Some(latest));
        assert_ne!(client.activation(&id(1)).unwrap(), old_activation);
        assert!(
            client
                .start(
                    binding,
                    "echo".into(),
                    json!("old handle"),
                    scope(&issuer, true),
                    Attachments::new().into()
                )
                .await
                .is_err()
        );
        let fresh = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        assert_eq!(
            client
                .start(
                    fresh,
                    "echo".into(),
                    json!("input"),
                    scope(&issuer, true),
                    Attachments::new().into()
                )
                .await
                .unwrap()
                .result()
                .await
                .unwrap(),
            json!("latest:input")
        );
        app.shutdown().await.unwrap();
        drop((app, client));
        close(store).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn failed_live_initializer_preserves_healthy_instances_and_later_revision_can_converge() {
    let (_dir, _namespaces, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        const INITIALIZER_SECRET: &str = "SECRET_REAL_JS_INITIALIZER_EXCEPTION";
        let (mut capture, _log_guard) = log_capture();
        let provider = native_package();
        let consumer = consumer();
        let deployment = Uuid::new_v4();
        let composition = |provider: &Package| {
            let mut desired = input(provider, &consumer);
            desired
                .instances
                .insert("healthy".into(), node(&native_package(), 4, true));
            let mut reader = node(&consumer, 5, false);
            reader.bindings.insert(
                "echo".into(),
                vec![Target::Instance {
                    path: vec!["healthy".into()],
                    export: "echo".into(),
                }],
            );
            desired.instances.insert("reader".into(), reader);
            desired
        };
        let original = store
            .commit_application(
                deployment,
                0,
                composition(&provider),
                vec![],
                vec![provider.clone(), consumer.clone()],
            )
            .await
            .unwrap();
        let issuer = Issuer::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let app = Application::start_from_store(
            store.clone(),
            deployment,
            registry(Arc::new(Echo {
                calls: calls.clone(),
            })),
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            Some(maka_host_js::factory(Limits::default())),
        )
        .await
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let healthy = client.activation(&id(4)).unwrap();
        let reader = client.activation(&id(5)).unwrap();
        let binding = client
            .bind(reader.clone(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let failing = package(
            "installed-service",
            entry(
                true,
                Implementation::JavaScript {
                    module: "host.mjs".into(),
                    realm: Realm::Dedicated,
                },
                MethodMode::Query,
            ),
            Some(format!(
                "export function activate(){{ throw Error('{INITIALIZER_SECRET}'); }}"
            )),
        );
        let failed_source = store
            .commit_application(
                deployment,
                1,
                composition(&failing),
                vec![],
                vec![failing, provider.clone(), consumer.clone()],
            )
            .await
            .unwrap();
        app.adopt_committed(failed_source.clone()).await.unwrap();
        assert!(app.ready().await.unwrap_err().contains(INITIALIZER_SECRET));
        let failed_activation = client
            .activation(&id(1))
            .ok()
            .map(|activation| activation.epoch());
        let failed_identity = failed_source.clone();
        assert!(!client.snapshot().closing);
        assert_eq!(client.snapshot().desired, Some(failed_source));
        assert_eq!(client.snapshot().effective, Some(original));
        assert_eq!(client.activation(&id(4)).unwrap(), healthy);
        assert_eq!(client.activation(&id(5)).unwrap(), reader);
        assert_eq!(
            client
                .start(
                    binding,
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
        let replacement = js_provider("recovered");
        let next = store
            .commit_application(
                deployment,
                2,
                composition(&replacement),
                vec![],
                vec![replacement, provider, consumer],
            )
            .await
            .unwrap();
        app.adopt_committed(next.clone()).await.unwrap();
        app.ready().await.unwrap();
        assert_eq!(client.snapshot().effective, Some(next));
        assert!(client.snapshot().startup_error.is_none());
        assert_eq!(client.activation(&id(4)).unwrap(), healthy);
        let fresh = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        assert_eq!(
            client
                .start(
                    fresh,
                    "echo".into(),
                    json!("input"),
                    scope(&issuer, true),
                    Attachments::new().into()
                )
                .await
                .unwrap()
                .result()
                .await
                .unwrap(),
            json!("recovered:input")
        );
        app.shutdown().await.unwrap();
        drop((app, client));
        close(store).await;
        let log = log_text(&mut capture);
        let event = log
            .lines()
            .find(|line| {
                line.contains("stage=\"initialize\"")
                    && line.contains("cause=\"initializer_failed\"")
            })
            .expect("actual JavaScript initializer failure must retain a safe Host cause");
        assert!(event.contains("WARN"));
        assert!(event.contains("state_domain=") && event.contains(&failed_identity.state_domain));
        for identity in [
            format!("instance_id={:?}", id(1)),
            format!("deployment_id={}", failed_identity.deployment),
            format!("source_revision={}", failed_identity.revision),
        ] {
            assert!(
                event.contains(&identity),
                "initializer evidence must identify the actual failed target/source: {event}"
            );
        }
        let logged_activation = event
            .split_whitespace()
            .find_map(|field| field.strip_prefix("activation_id="))
            .and_then(|epoch| Uuid::parse_str(epoch).ok())
            .expect("begun initializer must retain its activation epoch");
        assert!(!logged_activation.is_nil());
        if let Some(activation) = failed_activation {
            assert_eq!(logged_activation, activation);
        }
        assert!(
            !log.contains(INITIALIZER_SECRET),
            "JavaScript exception payload must not enter the Host log"
        );
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn retirement_does_not_wait_for_a_blocked_actual_source_sql_load() {
    use sqlx::{Connection, Executor, SqliteConnection, sqlite::SqliteConnectOptions};
    let (dir, _ns, store) = store().await;
    tokio::time::timeout(Duration::from_secs(10), async {
        let issuer = Issuer::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let (app, _) = launch(
            store.clone(),
            &issuer,
            Arc::new(AtomicBool::new(true)),
            Arc::new(Echo {
                calls: calls.clone(),
            }),
        )
        .await;
        let client = app.client();
        let activation = client.activation(&id(2)).unwrap();
        let binding = client
            .bind(activation.clone(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let mut blocker = SqliteConnection::connect_with(
            &SqliteConnectOptions::new().filename(
                dir.path()
                    .join("root")
                    .join(maka_event_log::root::ROOT_DATABASE),
            ),
        )
        .await
        .unwrap();
        blocker.execute("BEGIN IMMEDIATE").await.unwrap();
        let (provider, consumer) = mutation_packages();
        let mut writer = Box::pin(store.commit_application(
            Uuid::new_v4(),
            0,
            input(&provider, &consumer),
            vec![],
            vec![provider, consumer],
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut writer)
                .await
                .is_err()
        );
        let mut uncommitted = app.source().unwrap().clone();
        uncommitted.revision += 1;
        let loading_source = uncommitted.clone();
        let mut load = Box::pin(app.adopt_committed(uncommitted));
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut load)
                .await
                .is_err()
        );
        while client.snapshot().loading != Some(loading_source.clone()) {
            tokio::task::yield_now().await;
        }
        tokio::time::timeout(Duration::from_secs(2), client.retire(activation))
            .await
            .unwrap()
            .unwrap();
        assert!(
            client
                .prepare_mutation(
                    binding,
                    "echo".into(),
                    json!("retired"),
                    scope(&issuer, true),
                    Uuid::new_v4(),
                    Attachments::new().into()
                )
                .await
                .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut load)
                .await
                .is_err()
        );
        blocker.execute("ROLLBACK").await.unwrap();
        writer.await.unwrap();
        assert!(load.await.is_err());
        blocker.close().await.unwrap();
        app.shutdown().await.unwrap();
        drop((app, client));
        close(store).await;
    })
    .await
    .unwrap();
}
