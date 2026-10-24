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
use maka_event_log::{
    root::{RootNamespaces, RootOwner},
    root_store::RootStore,
};

#[tokio::test]
async fn stored_source_and_lease_survive_abandoned_query_resources_and_native_close() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let dir = tempfile::tempdir().unwrap();
        let namespaces = RootNamespaces {
            ownership: dir.path().join("owners"),
            control: dir.path().join("control"),
        };
        let root = dir.path().join("root");
        let owner = Arc::new(RootOwner::create(&root, &namespaces).unwrap());
        let store = Arc::new(RootStore::open(owner.clone()).await.unwrap());
        drop(owner);
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
        let mut native = NativeRegistry::default();
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
        assert_eq!(app.source(), Some(&source));
        app.ready().await.unwrap();
        let client = app.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let observer = client
            .start(
                binding,
                "echo".into(),
                json!("held"),
                scope(&issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        permit(&started).await;
        // A newer desired source can collect DB package bytes. Already accepted
        // execution still owns its original bytes and storage domain.
        let empty = Input {
            environment: Environment {
                location: ExecutionLocation::Host,
                presentation: None,
            },
            instances: BTreeMap::new(),
            recovery: None,
            launch: None,
        };
        store
            .commit_application(deployment, 1, empty, vec![], vec![])
            .await
            .unwrap();
        drop(observer);
        drop(app);
        drop(client);
        drop(store);
        assert_eq!(
            RootOwner::open(&root, &namespaces).err().unwrap().kind(),
            std::io::ErrorKind::WouldBlock
        );
        release.add_permits(1);
        permit(&resource_started).await;
        assert_eq!(
            RootOwner::open(&root, &namespaces).err().unwrap().kind(),
            std::io::ErrorKind::WouldBlock
        );
        resource_release.add_permits(1);
        permit(&close_started).await;
        assert_eq!(
            RootOwner::open(&root, &namespaces).err().unwrap().kind(),
            std::io::ErrorKind::WouldBlock
        );
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
        let store = RootStore::open(Arc::new(reopened)).await.unwrap();
        let loaded = store.load_application(deployment).await.unwrap().unwrap();
        let (loaded_source, _, _, _) = loaded.into_parts();
        assert_eq!(loaded_source.reference.state_domain, source.state_domain);
        assert_eq!(loaded_source.reference.revision, 2);
        store.close().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn persisted_preflight_error_runs_no_native_effect_and_releases_storage() {
    let dir = tempfile::tempdir().unwrap();
    let namespaces = RootNamespaces {
        ownership: dir.path().join("owners"),
        control: dir.path().join("control"),
    };
    let root = dir.path().join("root");
    let owner = Arc::new(RootOwner::create(&root, &namespaces).unwrap());
    let store = Arc::new(RootStore::open(owner).await.unwrap());
    let provider = native_package();
    let consumer = consumer();
    let deployment = Uuid::new_v4();
    store
        .commit_application(
            deployment,
            0,
            input(&provider, &consumer),
            vec![],
            vec![provider, consumer],
        )
        .await
        .unwrap();
    let issuer = Issuer::default();
    let result = Application::start_from_store(
        store.clone(),
        deployment,
        NativeRegistry::default(),
        issuer.clone(),
        Arc::new(Grant(issuer)),
        Some(maka_host_js::factory(Limits::default())),
    )
    .await;
    assert!(
        result
            .err()
            .unwrap()
            .contains("native implementation unavailable")
    );
    Arc::try_unwrap(store).ok().unwrap().close().await.unwrap();
    assert!(RootOwner::open(&root, &namespaces).is_ok());
}

#[tokio::test]
async fn stored_failed_native_cleanup_keeps_the_actual_state_root_lease() {
    let dir = tempfile::tempdir().unwrap();
    let namespaces = RootNamespaces {
        ownership: dir.path().join("owners"),
        control: dir.path().join("control"),
    };
    let root = dir.path().join("root");
    let owner = Arc::new(RootOwner::create(&root, &namespaces).unwrap());
    let store = Arc::new(RootStore::open(owner).await.unwrap());
    let provider = native_package();
    let consumer = consumer();
    let deployment = Uuid::new_v4();
    store
        .commit_application(
            deployment,
            0,
            input(&provider, &consumer),
            vec![],
            vec![provider, consumer],
        )
        .await
        .unwrap();
    let mut native = NativeRegistry::default();
    native
        .insert(
            "native.echo".into(),
            Arc::new(|_, _| {
                Box::pin(async {
                    NativeActivation {
                        exports: Err("exports rejected".into()),
                        owner: native_owner(|| {
                            Box::pin(async { Err("native cleanup unconfirmed".into()) })
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
    assert!(
        app.shutdown()
            .await
            .unwrap_err()
            .contains("cleanup unconfirmed")
    );
    drop(app);
    drop(store);
    tokio::task::yield_now().await;
    assert_eq!(
        RootOwner::open(&root, &namespaces).err().unwrap().kind(),
        std::io::ErrorKind::WouldBlock
    );
}
