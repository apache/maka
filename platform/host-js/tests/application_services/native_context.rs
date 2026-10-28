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
use maka_agent_facts::configuration::policy::Personalization;
use maka_config::ConfigurationStore;
use maka_event_log::{
    root::{RootNamespaces, RootOwner},
    root_store::RootStore,
};
use maka_plugin_core::deployment::DeploymentRef;
use std::sync::Mutex;

fn namespaces(dir: &tempfile::TempDir) -> RootNamespaces {
    RootNamespaces {
        ownership: dir.path().join("owners"),
        control: dir.path().join("control"),
    }
}

#[tokio::test]
async fn ephemeral_native_context_has_actual_activation_and_no_fallback_store() {
    let provider = native_package();
    let expected_package = provider.application_ref();
    let mut native = NativeRegistry::default();
    let observed = Arc::new(Mutex::new(None));
    let capture = observed.clone();
    native
        .insert(
            "native.echo".into(),
            Arc::new(move |context, configuration| {
                assert_eq!(configuration, json!({}));
                assert_eq!(context.package(), &expected_package);
                assert!(context.persistence().is_none());
                *capture.lock().unwrap() = Some(context.activation().clone());
                Box::pin(async {
                    NativeActivation {
                        exports: Err("this service requires an owned application Root".into()),
                        owner: native_owner(|| Box::pin(async { Ok(()) })),
                    }
                })
            }),
        )
        .unwrap();
    let consumer = consumer();
    let issuer = Issuer::default();
    let app = Application::start(
        input(&provider, &consumer),
        vec![provider, consumer],
        native,
        issuer.clone(),
        Arc::new(Grant(issuer)),
        Some(maka_host_js::factory(Limits::default())),
    )
    .unwrap();
    assert!(
        app.ready()
            .await
            .unwrap_err()
            .contains("requires an owned application Root")
    );
    assert_eq!(
        observed.lock().unwrap().as_ref().unwrap().instance(),
        &id(1)
    );
    app.shutdown().await.unwrap();
}

struct Fact {
    source: DeploymentRef,
    activation: maka_plugin_core::runtime::Activation,
    marker: String,
    profile: String,
}

#[tokio::test]
async fn native_context_uses_actual_root_and_stable_instances_across_deployments_and_restarts() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let dir = tempfile::tempdir().unwrap();
        let namespaces = namespaces(&dir);
        let mut stores = Vec::new();
        let facts = Arc::new(Mutex::new(Vec::<Fact>::new()));
        let mut native = NativeRegistry::default();
        let capture = facts.clone();
        native
            .insert(
                "native.echo".into(),
                Arc::new(move |context, _| {
                    let capture = capture.clone();
                    Box::pin(async move {
                        let persistence = context.persistence().unwrap();
                        let store = persistence.store();
                        let root = store.owned_root().unwrap();
                        assert_eq!(root.root_id(), persistence.source().state_domain);
                        let marker = store
                            .get_session::<String>("root-marker")
                            .await
                            .unwrap()
                            .unwrap()
                            .configuration;
                        let configuration =
                            Arc::new(ConfigurationStore::for_root(root).await.unwrap());
                        let profile = configuration
                            .runtime_policy()
                            .await
                            .unwrap()
                            .policy
                            .personalization
                            .display_name;
                        capture.lock().unwrap().push(Fact {
                            source: persistence.source().clone(),
                            activation: context.activation().clone(),
                            marker,
                            profile,
                        });
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "echo".into(),
                                Published {
                                    contract: contract(MethodMode::Query),
                                    value: Arc::new(Echo {
                                        calls: Arc::new(AtomicUsize::new(0)),
                                    })
                                        as Arc<dyn Handler>,
                                },
                            )])),
                            owner: native_owner(move || {
                                let configuration = configuration.clone();
                                Box::pin(async move {
                                    configuration.shutdown().await.map_err(|e| e.to_string())
                                })
                            }),
                        }
                    })
                }),
            )
            .unwrap();
        let mut applications = Vec::new();
        let mut expected = Vec::new();
        for root_index in 0..2 {
            let root = dir.path().join(format!("root-{root_index}"));
            let owner = Arc::new(RootOwner::create(&root, &namespaces).unwrap());
            let store = Arc::new(RootStore::open(owner).await.unwrap());
            let marker = format!("Root {root_index}");
            store
                .create_session("root-marker", "create-marker", &marker, 1)
                .await
                .unwrap();
            let config = ConfigurationStore::for_root(store.owned_root().unwrap())
                .await
                .unwrap();
            config
                .set_personalization(
                    0,
                    Personalization {
                        display_name: marker.clone(),
                    },
                )
                .await
                .unwrap();
            config.close().await.unwrap();
            for _ in 0..2 {
                let provider = native_package();
                let consumer = consumer();
                let deployment = Uuid::new_v4();
                let mut desired = input(&provider, &consumer);
                desired
                    .instances
                    .insert("second-provider".into(), node(&provider, 5, true));
                let source = store
                    .commit_application(
                        deployment,
                        0,
                        desired.clone(),
                        vec![],
                        vec![provider.clone(), consumer.clone()],
                    )
                    .await
                    .unwrap();
                let issuer = Issuer::default();
                let app = Application::start_from_store(
                    store.clone(),
                    deployment,
                    native.clone(),
                    issuer.clone(),
                    Arc::new(Grant(issuer)),
                    Some(maka_host_js::factory(Limits::default())),
                )
                .await
                .unwrap();
                app.ready().await.unwrap();
                expected.push((source.clone(), marker.clone()));
                if root_index == 0 && applications.is_empty() {
                    // A new immutable package revision must retain both instance data
                    // identities, while initialization gets the new exact source.
                    let old_activation = app.client().activation(&id(1)).unwrap();
                    app.shutdown().await.unwrap();
                    let provider = package(
                        "native",
                        entry(
                            true,
                            Implementation::Native {
                                implementation: "native.echo".into(),
                            },
                            MethodMode::Query,
                        ),
                        Some("// new immutable bytes".into()),
                    );
                    desired.instances.get_mut("provider").unwrap().package =
                        provider.application_ref().into();
                    desired
                        .instances
                        .get_mut("second-provider")
                        .unwrap()
                        .package = provider.application_ref().into();
                    let next = store
                        .commit_application(
                            deployment,
                            1,
                            desired,
                            vec![],
                            vec![provider, consumer],
                        )
                        .await
                        .unwrap();
                    let issuer = Issuer::default();
                    let restarted = Application::start_from_store(
                        store.clone(),
                        deployment,
                        native.clone(),
                        issuer.clone(),
                        Arc::new(Grant(issuer)),
                        Some(maka_host_js::factory(Limits::default())),
                    )
                    .await
                    .unwrap();
                    restarted.ready().await.unwrap();
                    let new_activation = restarted.client().activation(&id(1)).unwrap();
                    assert_eq!(old_activation.instance(), new_activation.instance());
                    assert_ne!(old_activation.epoch(), new_activation.epoch());
                    expected.push((next, marker.clone()));
                    applications.push(restarted);
                } else {
                    applications.push(app);
                }
            }
            stores.push((root, store));
        }
        {
            let facts = facts.lock().unwrap();
            assert_eq!(facts.len(), expected.len() * 2);
            for (source, marker) in &expected {
                let actual: Vec<_> = facts.iter().filter(|fact| &fact.source == source).collect();
                assert_eq!(actual.len(), 2);
                assert!(
                    actual
                        .iter()
                        .any(|fact| fact.activation.instance() == &id(1))
                );
                assert!(
                    actual
                        .iter()
                        .any(|fact| fact.activation.instance() == &id(5))
                );
                for fact in actual {
                    assert_eq!(&fact.marker, marker);
                    assert_eq!(&fact.profile, marker);
                }
            }
            assert_ne!(expected[0].0.state_domain, expected[3].0.state_domain);
            assert_ne!(expected[0].0.deployment, expected[2].0.deployment);
            assert_eq!(expected[0].0.deployment, expected[1].0.deployment);
            assert_eq!(expected[0].0.state_domain, expected[1].0.state_domain);
            assert_eq!(expected[0].0.revision, 1);
            assert_eq!(expected[1].0.revision, 2);
        }
        for app in applications {
            app.shutdown().await.unwrap();
        }
        for (root, store) in stores {
            Arc::try_unwrap(store).ok().unwrap().close().await.unwrap();
            assert!(RootOwner::open(&root, &namespaces).is_ok());
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn retired_native_initializer_keeps_original_store_until_actual_configuration_close() {
    let dir = tempfile::tempdir().unwrap();
    let namespaces = namespaces(&dir);
    let root = dir.path().join("root");
    let store = Arc::new(
        setup(RootStore::open(Arc::new(
            RootOwner::create(&root, &namespaces).unwrap(),
        )))
        .await
        .unwrap(),
    );
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
                vec![provider, consumer],
            )
            .await
            .unwrap();
        let started = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let closing = Arc::new(Semaphore::new(0));
        let close_release = Arc::new(Semaphore::new(0));
        let configuration = Arc::new(Mutex::new(None));
        let mut native = NativeRegistry::default();
        let a = started.clone();
        let b = release.clone();
        let c = closing.clone();
        let d = close_release.clone();
        let observed = configuration.clone();
        let captured_source = original.clone();
        native
            .insert(
                "native.echo".into(),
                Arc::new(move |context, _| {
                    let a = a.clone();
                    let b = b.clone();
                    let c = c.clone();
                    let d = d.clone();
                    let observed = observed.clone();
                    let captured_source = captured_source.clone();
                    Box::pin(async move {
                        let persistence = context.persistence().unwrap();
                        assert_eq!(persistence.source(), &captured_source);
                        let store = persistence.store().clone();
                        let config = Arc::new(
                            ConfigurationStore::for_root(store.owned_root().unwrap())
                                .await
                                .unwrap(),
                        );
                        *observed.lock().unwrap() = Some(config.clone());
                        a.add_permits(1);
                        permit(&b).await;
                        // Retirement and a newer desired source cannot redirect this initializer.
                        assert_eq!(persistence.source(), &captured_source);
                        assert_eq!(
                            store
                                .load_application(deployment)
                                .await
                                .unwrap()
                                .unwrap()
                                .source()
                                .reference
                                .revision,
                            2
                        );
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "echo".into(),
                                Published {
                                    contract: contract(MethodMode::Query),
                                    value: Arc::new(Echo {
                                        calls: Arc::new(AtomicUsize::new(0)),
                                    })
                                        as Arc<dyn Handler>,
                                },
                            )])),
                            owner: native_owner(move || {
                                let c = c.clone();
                                let d = d.clone();
                                let config = config.clone();
                                let store = store.clone();
                                Box::pin(async move {
                                    c.add_permits(1);
                                    permit(&d).await;
                                    config.shutdown().await.map_err(|e| e.to_string())?;
                                    drop(store);
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
            Arc::new(Grant(issuer)),
            Some(maka_host_js::factory(Limits::default())),
        )
        .await
        .unwrap();
        permit(&started).await;
        let client = app.client();
        let activation = client.activation(&id(1)).unwrap();
        client.retire(activation.clone()).await.unwrap();
        assert_eq!(
            client
                .snapshot()
                .instances
                .iter()
                .find(|s| s.activation == activation)
                .unwrap()
                .resources,
            1
        );
        store
            .commit_application(
                deployment,
                1,
                Input {
                    ui: None,
                    instances: BTreeMap::new(),
                },
                vec![],
                vec![],
            )
            .await
            .unwrap();
        drop(app);
        drop(client);
        drop(store);
        assert_eq!(
            RootOwner::open(&root, &namespaces).err().unwrap().kind(),
            std::io::ErrorKind::WouldBlock
        );
        release.add_permits(1);
        permit(&closing).await;
        assert_eq!(
            RootOwner::open(&root, &namespaces).err().unwrap().kind(),
            std::io::ErrorKind::WouldBlock
        );
        let config = configuration.lock().unwrap().as_ref().unwrap().clone();
        assert!(config.runtime_policy().await.is_ok());
        close_release.add_permits(1);
        let reopened = loop {
            match RootOwner::open(&root, &namespaces) {
                Ok(owner) => break owner,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    tokio::task::yield_now().await
                }
                Err(error) => panic!("{error}"),
            }
        };
        assert!(config.runtime_policy().await.is_err());
        drop(reopened);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn context_store_stays_fenced_after_initializer_panic_or_failed_native_close() {
    for panic in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let namespaces = namespaces(&dir);
        let root = dir.path().join("root");
        let store = Arc::new(
            setup(RootStore::open(Arc::new(
                RootOwner::create(&root, &namespaces).unwrap(),
            )))
            .await
            .unwrap(),
        );
        tokio::time::timeout(Duration::from_secs(20), async {
            let provider = native_package();
            let consumer = consumer();
            let deployment = Uuid::new_v4();
            let source = store
                .commit_application(
                    deployment,
                    0,
                    input(&provider, &consumer),
                    vec![],
                    vec![provider, consumer],
                )
                .await
                .unwrap();
            let observed = Arc::new(Mutex::new(None));
            let capture = observed.clone();
            let mut native = NativeRegistry::default();
            native
                .insert(
                    "native.echo".into(),
                    Arc::new(move |context, _| {
                        let capture = capture.clone();
                        let source = source.clone();
                        Box::pin(async move {
                            let persistence = context.persistence().unwrap();
                            assert_eq!(persistence.source(), &source);
                            let config = Arc::new(
                                ConfigurationStore::for_root(
                                    persistence.store().owned_root().unwrap(),
                                )
                                .await
                                .unwrap(),
                            );
                            assert!(config.runtime_policy().await.is_ok());
                            *capture.lock().unwrap() = Some(Arc::downgrade(&config));
                            assert!(
                                !panic,
                                "initializer panic after acquiring actual native store"
                            );
                            NativeActivation {
                                exports: Err("exports rejected".into()),
                                owner: native_owner(move || {
                                    let config = config.clone();
                                    Box::pin(async move {
                                        assert!(config.runtime_policy().await.is_ok());
                                        Err("native store cleanup unconfirmed".into())
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
                Arc::new(Grant(issuer)),
                Some(maka_host_js::factory(Limits::default())),
            )
            .await
            .unwrap();
            assert!(app.ready().await.is_err());
            let client = app.client();
            let activation = client.activation(&id(1)).unwrap();
            assert!(app.shutdown().await.is_err());
            let state = client
                .snapshot()
                .instances
                .into_iter()
                .find(|s| s.activation == activation)
                .unwrap();
            assert_eq!(state.phase, Phase::Retiring);
            assert_eq!(state.resources, 1);
            if !panic {
                assert!(
                    observed
                        .lock()
                        .unwrap()
                        .as_ref()
                        .unwrap()
                        .upgrade()
                        .is_some()
                );
            }
            drop(app);
            drop(client);
            drop(store);
            assert_eq!(
                RootOwner::open(&root, &namespaces).err().unwrap().kind(),
                std::io::ErrorKind::WouldBlock
            );
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn unmanaged_event_log_cannot_supply_an_owned_native_root() {
    let dir = tempfile::tempdir().unwrap();
    let store = maka_event_log::EventLog::open(&dir.path().join("standalone.sqlite"))
        .await
        .unwrap();
    assert!(
        store
            .owned_root()
            .err()
            .unwrap()
            .to_string()
            .contains("requires an owned State Root")
    );
    store.close().await.unwrap();
}
