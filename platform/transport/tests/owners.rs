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

#[allow(dead_code)]
mod support;
use futures_util::future::BoxFuture;
use maka_event_log::{
    root::{RootNamespaces, RootOwner},
    root_store::RootStore,
};
use maka_host_runtime::application::{
    Application, Context, Handler, Invocation, NativeActivation, NativeOwner, NativeRegistry,
    Policy,
};
use maka_plugin_core::runtime::Published;
use maka_transport::Configuration;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

struct Permit;
impl Policy for Permit {
    fn admit(&self, _: Invocation<'_>) -> Result<(), String> {
        Ok(())
    }
}
struct FileOwner {
    file: Arc<Mutex<Option<std::fs::File>>>,
    closing: Arc<tokio::sync::Semaphore>,
    release: Arc<tokio::sync::Semaphore>,
}
impl Handler for FileOwner {
    fn call(&self, _: String, _: Value, _: Context) -> BoxFuture<'static, Result<Value, String>> {
        Box::pin(async { Ok(json!({"effects":0})) })
    }
}
impl NativeOwner for FileOwner {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        let file = self.file.clone();
        let closing = self.closing.clone();
        let release = self.release.clone();
        Box::pin(async move {
            closing.add_permits(1);
            release.acquire_owned().await.unwrap().forget();
            file.lock().unwrap().take();
            Ok(())
        })
    }
}
#[tokio::test]
async fn compiled_native_file_and_root_wait_for_the_original_application_and_sql_close() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("host");
    let namespaces = RootNamespaces {
        ownership: directory.path().join("owners"),
        control: directory.path().join("control"),
    };
    let original = Arc::new(RootOwner::create(&root, &namespaces).unwrap());
    let store = Arc::new(support::setup(RootStore::open(original)).await.unwrap());
    let deployment = uuid::Uuid::new_v4();
    let (input, packages) = support::native_host("native.File");
    store
        .commit_application(deployment, 0, input, vec![], packages)
        .await
        .unwrap();
    let file = Arc::new(Mutex::new(None));
    let closing = Arc::new(tokio::sync::Semaphore::new(0));
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let resource = Arc::new(FileOwner {
        file: file.clone(),
        closing: closing.clone(),
        release: release.clone(),
    });
    let path = directory.path().join("native-file");
    let mut native = NativeRegistry::default();
    native
        .insert(
            "native.File".into(),
            Arc::new(move |_, _| {
                let resource = resource.clone();
                let path = path.clone();
                Box::pin(async move {
                    // Compiled availability itself has no native resource effect.
                    *resource.file.lock().unwrap() = Some(std::fs::File::create(path).unwrap());
                    NativeActivation {
                        exports: Ok(BTreeMap::from([(
                            "Counter".into(),
                            Published {
                                contract: support::business(),
                                value: resource.clone() as Arc<dyn Handler>,
                            },
                        )])),
                        owner: resource,
                    }
                })
            }),
        )
        .unwrap();
    assert!(file.lock().unwrap().is_none());
    let application = Application::start_from_store(
        store.clone(),
        deployment,
        maka_transport::with_gateway(native).unwrap(),
        Default::default(),
        Arc::new(Permit),
        Some(maka_host_js::factory(Default::default())),
    )
    .await
    .unwrap();
    application.ready().await.unwrap();
    file.lock().unwrap().as_ref().unwrap().metadata().unwrap();
    let close = tokio::spawn(async move {
        application.shutdown().await.unwrap();
        application
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), closing.acquire_owned())
        .await
        .unwrap()
        .unwrap()
        .forget();
    assert!(!close.is_finished());
    file.lock().unwrap().as_ref().unwrap().metadata().unwrap();
    assert_eq!(
        RootOwner::open(&root, &namespaces).err().unwrap().kind(),
        std::io::ErrorKind::WouldBlock
    );
    release.add_permits(1);
    let application = close.await.unwrap();
    assert!(file.lock().unwrap().is_none());
    // Application close is not the SQL owner's independent close receipt.
    assert_eq!(
        RootOwner::open(&root, &namespaces).err().unwrap().kind(),
        std::io::ErrorKind::WouldBlock
    );
    drop(application);
    store.shutdown().await.unwrap();
    drop(store);
    drop(RootOwner::open(&root, &namespaces).unwrap());
}

#[test]
fn startup_configuration_is_closed_and_complete_before_opening_any_host() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("connections.json");
    for data in [
        br#"{"hosts":[],"approved":true}"#.as_slice(),
        br#"{"hosts":[{"name":"local","credential":"fake"}]}"#.as_slice(),
    ] {
        std::fs::write(&path, data).unwrap();
        assert!(Configuration::read(&path).is_err());
    }
    std::fs::write(&path, vec![b' '; 1_048_577]).unwrap();
    assert!(
        Configuration::read(&path).is_err(),
        "whitespace is invalid JSON regardless of length"
    );
    let mut cohost = json!({"hosts":[{
        "name":"local", "location":{"kind":"cohost"}, "deployment":uuid::Uuid::new_v4(),
        "endpoints":{"business":{"consumer":support::identity(13),"import":"business","grant":{"methods":["read"],"recovery":false}}}
    }]});
    std::fs::write(&path, serde_json::to_vec(&cohost).unwrap()).unwrap();
    Configuration::read(&path).unwrap();
    cohost["hosts"][0]["location"]["root"] = json!("/guest/cannot/select/a/root");
    std::fs::write(&path, serde_json::to_vec(&cohost).unwrap()).unwrap();
    assert!(Configuration::read(&path).is_err());
    std::fs::write(&path, br#"{"hosts":[]}"#).unwrap();
    assert!(Configuration::read(&path).unwrap().hosts.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_cohost_start_keeps_original_initializer_native_file_and_sql_until_real_close() {
    use maka_plugin_core::{
        composition::PresentationTarget,
        package::{EntryTarget, Implementation},
    };
    use maka_transport::Connections;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("cohost");
    let namespaces = RootNamespaces {
        ownership: directory.path().join("owners"),
        control: directory.path().join("control"),
    };
    let store = Arc::new(
        support::setup(RootStore::open(Arc::new(
            RootOwner::create(&root, &namespaces).unwrap(),
        )))
        .await
        .unwrap(),
    );
    let (mut input, originals) = support::host();
    let mut packages = Vec::new();
    for old in originals {
        if old.manifest().id != "local.business" {
            packages.push(old);
            continue;
        }
        let mut declaration = old
            .manifest()
            .application
            .as_ref()
            .unwrap()
            .declaration()
            .clone();
        declaration
            .entries
            .get_mut(&EntryTarget::Host)
            .unwrap()
            .implementation = Implementation::Native {
            implementation: "cohost.gated".into(),
        };
        let package = support::counter::package("local.business", declaration, None);
        input.instances.get_mut("business").unwrap().package = package.application_ref().into();
        packages.push(package);
    }
    let host = uuid::Uuid::new_v4();
    let host_source = store
        .commit_application(host, 0, input, vec![], packages)
        .await
        .unwrap();
    let (input, packages, observations) = support::ui(PresentationTarget::Tui);
    let ui = store
        .commit_application(uuid::Uuid::new_v4(), 0, input, observations, packages)
        .await
        .unwrap();
    let began = Arc::new(tokio::sync::Semaphore::new(0));
    let initialized = Arc::new(tokio::sync::Semaphore::new(0));
    let closing = Arc::new(tokio::sync::Semaphore::new(0));
    let released = Arc::new(tokio::sync::Semaphore::new(0));
    let file = Arc::new(Mutex::new(None));
    let resource = Arc::new(FileOwner {
        file: file.clone(),
        closing: closing.clone(),
        release: released.clone(),
    });
    let mut native = NativeRegistry::default();
    let expected_store = store.clone();
    let began_factory = began.clone();
    let initialized_factory = initialized.clone();
    let file_path = directory.path().join("owned-native-file");
    native
        .insert(
            "cohost.gated".into(),
            Arc::new(move |context, _| {
                let expected_store = expected_store.clone();
                let began = began_factory.clone();
                let initialized = initialized_factory.clone();
                let resource = resource.clone();
                let path = file_path.clone();
                Box::pin(async move {
                    assert!(Arc::ptr_eq(
                        context.persistence().unwrap().store(),
                        &expected_store
                    ));
                    *resource.file.lock().unwrap() = Some(std::fs::File::create(path).unwrap());
                    began.add_permits(1);
                    initialized.acquire_owned().await.unwrap().forget();
                    NativeActivation {
                        exports: Ok(BTreeMap::from([(
                            "Counter".into(),
                            Published {
                                contract: support::business(),
                                value: resource.clone() as Arc<dyn Handler>,
                            },
                        )])),
                        owner: resource,
                    }
                })
            }),
        )
        .unwrap();
    let configuration = serde_json::from_value(json!({"hosts":[{
        "name":"local", "location":{"kind":"cohost"}, "deployment":host, "endpoints":{"business":{"consumer":support::identity(13),"import":"business","grant":{"methods":["read","write"],"recovery":false}},"receipts":{"consumer":support::identity(13),"import":"receipts","grant":{"methods":["read"],"recovery":true}}}
    }]})).unwrap();
    let mut connections = Connections::prepare(
        store.clone(),
        ui.deployment,
        PresentationTarget::Tui,
        configuration,
        namespaces.clone(),
        std::path::PathBuf::from("unused-cohost-startup-helper"),
        native,
        Some(maka_host_js::factory(Default::default())),
    )
    .await
    .unwrap();
    {
        let starting = connections.start();
        tokio::pin!(starting);
        tokio::select! {
            biased;
            result = &mut starting => panic!("initializer must remain pending: {result:?}"),
            permit = began.acquire() => permit.unwrap().forget(),
        }
    }
    assert!(file.lock().unwrap().is_some());
    {
        let closed = connections.close();
        tokio::pin!(closed);
        assert!(futures_util::poll!(closed.as_mut()).is_pending());
        assert_eq!(
            store.application_head(host).await.unwrap(),
            Some(host_source)
        );
        assert_eq!(
            RootOwner::open(&root, &namespaces).err().unwrap().kind(),
            std::io::ErrorKind::WouldBlock
        );
        initialized.add_permits(1);
        tokio::time::timeout(std::time::Duration::from_secs(10), closing.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
        assert!(futures_util::poll!(closed.as_mut()).is_pending());
        file.lock().unwrap().as_ref().unwrap().metadata().unwrap();
        // Original SQL remains usable while actual native close is held. No second
        // writer or Root opens, and no aggregate UI receipt substitutes for it.
        let (input, packages) = support::host();
        store
            .commit_application(uuid::Uuid::new_v4(), 0, input, vec![], packages)
            .await
            .unwrap();
        released.add_permits(1);
        tokio::time::timeout(std::time::Duration::from_secs(10), closed)
            .await
            .unwrap()
            .unwrap();
        assert!(file.lock().unwrap().is_none());
        assert_eq!(
            RootOwner::open(&root, &namespaces).err().unwrap().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
    store.shutdown().await.unwrap();
    // SQL close does not drop the launcher's actual Store/factory handles.
    drop(connections);
    drop(store);
    drop(RootOwner::open(&root, &namespaces).unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cohost_retains_independent_receipts_when_selected_business_cannot_start() {
    use maka_plugin_core::composition::PresentationTarget;
    use maka_transport::Connections;
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("cohost");
        let namespaces = RootNamespaces {
            ownership: directory.path().join("owners"),
            control: directory.path().join("control"),
        };
        let store = Arc::new(support::setup(RootStore::open(Arc::new(RootOwner::create(&root, &namespaces).unwrap()))).await.unwrap());
        let (input, packages) = support::host_with_unavailable_business();
        let host = uuid::Uuid::new_v4();
        store.commit_application(host, 0, input, vec![], packages).await.unwrap();
        let (input, packages, observations) = support::ui(PresentationTarget::Tui);
        let ui = store.commit_application(uuid::Uuid::new_v4(), 0, input, observations, packages).await.unwrap();
        let configuration = serde_json::from_value(json!({"hosts":[{
            "name":"local", "location":{"kind":"cohost"}, "deployment":host, "endpoints":{"business":{"consumer":support::identity(13),"import":"business","grant":{"methods":["read","write"],"recovery":false}},"receipts":{"consumer":support::identity(14),"import":"receipts","grant":{"methods":["read"],"recovery":true}}}
        }]})).unwrap();
        let mut connections = Connections::prepare(store.clone(), ui.deployment, PresentationTarget::Tui,
            configuration, namespaces.clone(), std::path::PathBuf::from("unused-cohost-startup-helper"), NativeRegistry::default(),
Some(maka_host_js::factory(Default::default())),).await.unwrap();
        connections.start().await.unwrap();
        assert_eq!(connections.registrations().len(), 1);
        assert_eq!(connections.registrations()[0].target.export, "Receipts");
        assert_eq!(connections.startup_errors().len(), 1);
        assert!(connections.startup_errors()[0].contains("plugin business:"));
        assert!(connections.startup_errors()[0].contains("business initializer rejected"));
        assert_eq!(RootOwner::open(&root, &namespaces).err().unwrap().kind(), std::io::ErrorKind::WouldBlock);
        connections.close().await.unwrap();
        store.shutdown().await.unwrap();
        drop((connections, store));
        drop(RootOwner::open(&root, &namespaces).unwrap());
    }).await.unwrap();
}

#[tokio::test]
async fn loaded_ui_requires_its_live_original_root_owner() {
    use maka_plugin_core::composition::PresentationTarget;
    use maka_transport::Connections;
    let directory = tempfile::tempdir().unwrap();
    let namespaces = RootNamespaces {
        ownership: directory.path().join("owners"),
        control: directory.path().join("control"),
    };
    let path = directory.path().join("ui");
    let original = Arc::new(
        support::setup(RootStore::open(Arc::new(
            RootOwner::create(&path, &namespaces).unwrap(),
        )))
        .await
        .unwrap(),
    );
    let other = Arc::new(
        support::setup(RootStore::open(Arc::new(
            RootOwner::create(&directory.path().join("other"), &namespaces).unwrap(),
        )))
        .await
        .unwrap(),
    );
    let input = serde_json::from_value(json!({
        "environment":{"location":"ui","presentation":"tui"},"instances":{}
    }))
    .unwrap();
    let id = uuid::Uuid::new_v4();
    let reference = original
        .commit_application(id, 0, input, vec![], vec![])
        .await
        .unwrap();
    let foreign = original.load_application(id).await.unwrap().unwrap();
    let error = Connections::prepare_loaded(
        other.clone(),
        foreign,
        PresentationTarget::Tui,
        Configuration::default(),
        namespaces.clone(),
        "unused-startup-helper".into(),
        NativeRegistry::default(),
        None,
    )
    .await
    .err()
    .unwrap();
    assert!(error.contains("foreign original source Root"), "{error}");
    let expired = original.load_application(id).await.unwrap().unwrap();
    original.drain().await;
    drop(original);
    let reopened = Arc::new(
        support::setup(RootStore::open(Arc::new(
            RootOwner::open(&path, &namespaces).unwrap(),
        )))
        .await
        .unwrap(),
    );
    assert_eq!(
        reopened.owned_root().unwrap().root_id(),
        reference.state_domain
    );
    let error = Connections::prepare_loaded(
        reopened.clone(),
        expired,
        PresentationTarget::Tui,
        Configuration::default(),
        namespaces.clone(),
        "unused-startup-helper".into(),
        NativeRegistry::default(),
        None,
    )
    .await
    .err()
    .unwrap();
    assert!(error.contains("original source Root has closed"), "{error}");
    let current = reopened.load_application(id).await.unwrap().unwrap();
    let mut connections = Connections::prepare_loaded(
        reopened.clone(),
        current,
        PresentationTarget::Tui,
        Configuration::default(),
        namespaces,
        "unused-startup-helper".into(),
        NativeRegistry::default(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        connections.take_initial().unwrap().source().reference,
        reference
    );
    connections.drain().await;
    reopened.drain().await;
    other.drain().await;
}
