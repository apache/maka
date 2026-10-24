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

#[path = "reconciliation.rs"]
mod reconciliation;

use super::Application;
use super::{support, timer};
use maka_event_log::{
    RootStore,
    root::{RootNamespaces, RootOwner},
};
use maka_plugin_core::composition::PresentationTarget;
use maka_ui_runtime::{NativeCapability, NativeExport, NativeRegistry};
use serde_json::json;
use std::{cell::Cell, collections::BTreeMap, rc::Rc, sync::Arc, time::Duration};
use uuid::Uuid;

fn namespaces(dir: &std::path::Path) -> RootNamespaces {
    RootNamespaces {
        ownership: dir.join("owners"),
        control: dir.join("control"),
    }
}
fn store(timer: &tokio::runtime::Runtime, dir: &std::path::Path) -> Arc<RootStore> {
    let owner = Arc::new(RootOwner::create(&dir.join("root"), &namespaces(dir)).unwrap());
    Arc::new(timer.block_on(RootStore::open(owner)).unwrap())
}
fn start(timer: &tokio::runtime::Runtime, store: Arc<RootStore>, id: Uuid) -> Application {
    let source = timer
        .block_on(store.load_application(id))
        .unwrap()
        .unwrap()
        .into_parts()
        .0
        .reference;
    timer
        .block_on(Application::start_from_store(
            store,
            source,
            PresentationTarget::Tui,
            timer.handle().clone(),
            maka_ui_js::execution(Default::default()),
            crate::support::scene::registry(PresentationTarget::Tui),
            vec![],
        ))
        .unwrap()
}

#[test]
fn persisted_execution_keeps_original_bytes_source_and_root_until_mount_cleanup() {
    let timer = timer();
    let dir = tempfile::tempdir().unwrap();
    let store = store(&timer, dir.path());
    let id = Uuid::new_v4();
    let (input, packages) =
        support::fixture("return frame({count:state.count+1,revision:state.revision+1});");
    let source = timer
        .block_on(store.commit_application(id, 0, input, vec![], packages))
        .unwrap();
    let mut app = start(&timer, store.clone(), id);
    let mount = app.mount_launch(json!({"count":3})).unwrap();
    let (input, packages) =
        support::fixture("return frame({count:state.count+100,revision:state.revision+1});");
    let desired = timer
        .block_on(store.commit_application(id, 1, input, vec![], packages))
        .unwrap();
    assert_ne!(source, desired);
    assert_eq!(app.source(), Some(&source));
    app.dispatch(&mount, 0, "inc", json!({})).unwrap();
    assert_eq!(app.frame(&mount).unwrap().state["count"], 4);
    drop(store);
    let root = dir.path().join("root");
    let ns = namespaces(dir.path());
    assert_eq!(
        RootOwner::open(&root, &ns).err().unwrap().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert!(app.shutdown().is_err());
    assert!(app.is_retiring(&mount));
    assert_eq!(app.source(), Some(&source));
    assert!(RootOwner::open(&root, &ns).is_err());
    app.close(&mount, Ok(())).unwrap();
    app.shutdown().unwrap();
    assert_eq!(app.source(), Some(&source));
    // UI acknowledgement is separate from the independent SQL owner's close.
    let reopened = timer
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    match RootOwner::open(&root, &ns) {
                        Ok(owner) => break owner,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            tokio::task::yield_now().await
                        }
                        Err(e) => panic!("{e}"),
                    }
                }
            })
            .await
        })
        .unwrap();
    let stored = timer.block_on(RootStore::open(Arc::new(reopened))).unwrap();
    assert_eq!(
        timer
            .block_on(stored.load_application(id))
            .unwrap()
            .unwrap()
            .source()
            .reference,
        desired
    );
    timer.block_on(stored.close()).unwrap();
}

#[test]
fn failed_native_close_keeps_persisted_root_custody_until_confirmed_recovery() {
    let timer = timer();
    let dir = tempfile::tempdir().unwrap();
    let store = store(&timer, dir.path());
    let id = Uuid::new_v4();
    let (input, packages) = support::fixture("");
    timer
        .block_on(store.commit_application(id, 0, input, vec![], packages))
        .unwrap();
    let mut app = start(&timer, store, id);
    let mount = app.mount_launch(json!({})).unwrap();
    app.retire(&mount).unwrap();
    assert!(
        app.close(&mount, Err("platform close unknown".into()))
            .is_err()
    );
    assert!(app.shutdown().is_err());
    assert!(app.frame(&mount).is_ok());
    assert_eq!(
        RootOwner::open(&dir.path().join("root"), &namespaces(dir.path()))
            .err()
            .unwrap()
            .kind(),
        std::io::ErrorKind::WouldBlock
    );
    app.close(&mount, Ok(())).unwrap();
    app.shutdown().unwrap();
}

#[test]
fn missing_or_wrong_selected_presentation_never_activates_native_code() {
    let timer = timer();
    let dir = tempfile::tempdir().unwrap();
    let store = store(&timer, dir.path());
    let id = Uuid::new_v4();
    let (input, packages) = support::fixture("");
    let source = timer
        .block_on(store.commit_application(id, 0, input, vec![], packages))
        .unwrap();
    let (mut host_input, packages) = support::fixture("");
    host_input.environment = maka_plugin_core::composition::Environment {
        location: maka_plugin_core::composition::ExecutionLocation::Host,
        presentation: None,
    };
    host_input.instances.retain(|name, _| name == "surface");
    host_input.launch = None;
    let surface = packages
        .into_iter()
        .find(|package| package.manifest().id == "native.surface")
        .unwrap();
    let mut declaration = surface
        .manifest()
        .application
        .as_ref()
        .unwrap()
        .declaration()
        .clone();
    let entry = declaration
        .entries
        .remove(&maka_plugin_core::package::EntryTarget::Tui)
        .unwrap();
    declaration
        .entries
        .insert(maka_plugin_core::package::EntryTarget::Host, entry);
    let host_surface = support::package("native.surface", declaration, None);
    host_input.instances.get_mut("surface").unwrap().package =
        host_surface.application_ref().into();
    let host_source = timer
        .block_on(store.commit_application(
            Uuid::new_v4(),
            0,
            host_input,
            vec![],
            vec![host_surface],
        ))
        .unwrap();
    let calls = Rc::new(Cell::new(0));
    for selected in [
        maka_plugin_core::deployment::DeploymentRef {
            deployment: Uuid::new_v4(),
            ..source
        },
        host_source,
    ] {
        let observed = calls.clone();
        let mut native = NativeRegistry::<()>::default()
            .with_scene_compiler(
                support::scene::language(PresentationTarget::Tui),
                support::scene::prepare,
                support::scene::finish::<()>,
            )
            .unwrap();
        native
            .register("maka.ui.surface.tui", move |_, _values| {
                observed.set(observed.get() + 1);
                Ok(BTreeMap::from([(
                    "Surface".into(),
                    NativeExport {
                        contract: maka_ui_runtime::surface_contract(PresentationTarget::Tui),
                        value: NativeCapability::Surface(PresentationTarget::Tui),
                    },
                )]))
            })
            .unwrap();
        assert!(
            timer
                .block_on(Application::start_from_store(
                    store.clone(),
                    selected,
                    PresentationTarget::Tui,
                    timer.handle().clone(),
                    maka_ui_js::execution(Default::default()),
                    native,
                    vec![]
                ))
                .is_err()
        );
        assert_eq!(calls.get(), 0);
    }
    timer
        .block_on(Arc::try_unwrap(store).ok().unwrap().close())
        .unwrap();
}

#[test]
fn unavailable_native_implementation_is_rejected_before_an_earlier_factory_executes() {
    use maka_plugin_core::package::{EntryTarget, Implementation};
    let timer = timer();
    let dir = tempfile::tempdir().unwrap();
    let store = store(&timer, dir.path());
    let id = Uuid::new_v4();
    let (mut input, mut packages) = support::fixture("");
    let mut declaration = packages[0]
        .manifest()
        .application
        .as_ref()
        .unwrap()
        .declaration()
        .clone();
    declaration
        .entries
        .get_mut(&EntryTarget::Tui)
        .unwrap()
        .implementation = Implementation::Native {
        implementation: "missing.surface".into(),
    };
    let missing = support::package("missing.surface", declaration, None);
    let mut later = support::node(&missing, 100);
    later.disabled = true;
    input.instances.insert("z-missing".into(), later);
    packages.push(missing);
    // Disabled entries do not require implementation availability.
    let source = timer
        .block_on(store.commit_application(id, 0, input.clone(), vec![], packages.clone()))
        .unwrap();
    let mut app = start(&timer, store.clone(), id);
    assert_eq!(app.source(), Some(&source));
    app.shutdown().unwrap();
    input.instances.get_mut("z-missing").unwrap().disabled = false;
    let desired = timer
        .block_on(store.commit_application(id, 1, input, vec![], packages))
        .unwrap();
    let calls = Rc::new(Cell::new(0));
    let observed = calls.clone();
    let mut native = NativeRegistry::<()>::default()
        .with_scene_compiler(
            support::scene::language(PresentationTarget::Tui),
            support::scene::prepare,
            support::scene::finish::<()>,
        )
        .unwrap();
    native
        .register("maka.ui.surface.tui", move |_, _values| {
            observed.set(observed.get() + 1);
            Ok(BTreeMap::from([(
                "Surface".into(),
                NativeExport {
                    contract: maka_ui_runtime::surface_contract(PresentationTarget::Tui),
                    value: NativeCapability::Surface(PresentationTarget::Tui),
                },
            )]))
        })
        .unwrap();
    let result = timer.block_on(Application::start_from_store(
        store.clone(),
        desired,
        PresentationTarget::Tui,
        timer.handle().clone(),
        maka_ui_js::execution(Default::default()),
        native,
        vec![],
    ));
    assert!(
        matches!(result, Err(maka_ui_runtime::Error::Invalid(ref text)) if text.contains("missing.surface"))
    );
    assert_eq!(calls.get(), 0);
    timer
        .block_on(Arc::try_unwrap(store).ok().unwrap().close())
        .unwrap();
}

#[test]
fn bootstrap_recovery_survives_primary_activation_or_mount_failure() {
    for stage in ["activation", "mount"] {
        let timer = timer();
        let (mut input, mut packages) =
            support::fixture("return frame({...state,revision:state.revision+1});");
        let index = packages
            .iter()
            .position(|p| p.manifest().id == "dynamic.app")
            .unwrap();
        let original = packages.remove(index);
        let source = std::str::from_utf8(original.file("index.mjs").unwrap()).unwrap();
        let needle = if stage == "activation" {
            "export function activate(configuration) {"
        } else {
            "mount(props){"
        };
        assert!(source.contains(needle));
        let broken = support::package(
            "dynamic.app",
            original
                .manifest()
                .application
                .as_ref()
                .unwrap()
                .declaration()
                .clone(),
            Some(source.replace(
                needle,
                &format!("{needle}throw new Error('primary {stage} failure');"),
            )),
        );
        input.instances.get_mut("app").unwrap().package = broken.application_ref().into();
        packages.push(broken);
        support::add_recovery(&mut input, &mut packages);
        let dir = tempfile::tempdir().unwrap();
        let store = store(&timer, dir.path());
        let id = Uuid::new_v4();
        let committed = timer
            .block_on(store.commit_application(id, 0, input, vec![], packages))
            .unwrap();
        let mut app = start(&timer, store.clone(), id);
        assert_eq!(
            app.deployment_status().effective,
            if stage == "activation" {
                None
            } else {
                Some(committed)
            }
        );
        let root = app.mount_bootstrap(json!({})).unwrap();
        assert_eq!(
            app.root_kind(&root).unwrap(),
            maka_plugin_core::composition::RootKind::Recovery
        );
        assert!(app.deployment_status().error.is_some());
        assert!(
            !app.can_recover(&root),
            "failure in recovery must not recursively mount another root"
        );
        assert!(!app.can_resume_launch(&root));
        app.dispatch(&root, 0, "inc", json!({})).unwrap();
        assert_eq!(app.frame(&root).unwrap().state["count"], 1);
        app.retire(&root).unwrap();
        for mount in app.retiring_mounts() {
            app.close(&mount, Ok(())).unwrap();
        }
        app.shutdown().unwrap();
        drop(app);
        timer
            .block_on(Arc::try_unwrap(store).ok().unwrap().close())
            .unwrap();
    }
}
