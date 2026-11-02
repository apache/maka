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
