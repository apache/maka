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

use super::Application;
use super::{support, timer};
use maka_event_log::{
    RootStore,
    applications::intents::CallerIntent,
    root::{RootNamespaces, RootOwner},
};
use maka_packages::MANIFEST_FILE;
use maka_packages::Package;
use maka_plugin_core::{
    composition::{Input, InstanceId, PresentationTarget, Target},
    contract::{
        Availability, Cardinality, Contract, Export, Import, Interface, Method, MethodMode,
        Transport,
    },
    deployment::DeploymentRef,
    operation::{RecoveryProtocol, RecoveryRef},
    package::{Declaration, EntryDeclaration, EntryTarget, Implementation},
};
use maka_ui_runtime::operations::{CALLER_HISTORY, caller_history_contract};
use serde_json::{Value, json};
use std::{collections::BTreeMap, future::Future, sync::Arc, task::Poll, time::Duration};
use uuid::Uuid;

fn identity(n: u128) -> InstanceId {
    InstanceId(vec![Uuid::from_u128(n)])
}
fn fixture() -> (Input, Vec<Package>) {
    let handler = "if(event.kind==='action')return frame({...state,outcome:event.event,revision:state.revision+1});const out=frame({...state,outcome:null,count:state.count+1,revision:state.revision+1});out.actions.push({key:'history',binding:'history',member:0,method:'page',input:event.event,resources:{}});return out;";
    let (mut input, mut packages) = support::fixture(handler);
    let index = packages
        .iter()
        .position(|package| package.manifest().id == "dynamic.app")
        .unwrap();
    let old = packages.remove(index);
    let mut declaration = old
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
        .imports
        .insert(
            "history".into(),
            Import {
                contract: caller_history_contract(),
                cardinality: Cardinality::One,
            },
        );
    let source = std::str::from_utf8(old.file("index.mjs").unwrap())
        .unwrap()
        .replace(
            "count:props.count??0,revision:0",
            "count:props.count??0,revision:0,padding:props.padding??''",
        );
    let mut files = old.files().clone();
    files.insert("index.mjs".into(), source.into_bytes());
    files.insert(
        MANIFEST_FILE.into(),
        serde_json::to_vec(
            &json!({"schemaVersion":1,"id":"dynamic.app","application":declaration}),
        )
        .unwrap(),
    );
    let package = Package::new(files).unwrap();
    input.instances.get_mut("app").unwrap().package = package.application_ref().into();
    packages.push(package);
    let history = support::package(
        "native.history",
        Declaration {
            entries: [EntryTarget::Tui]
                .into_iter()
                .map(|target| {
                    (
                        target,
                        EntryDeclaration {
                            scene: None,
                            implementation: Implementation::Native {
                                implementation: CALLER_HISTORY.into(),
                            },
                            configuration: json!({"type":"object","additionalProperties":false})
                                .into(),
                            imports: BTreeMap::new(),
                            exports: ["History", "DeploymentHistory"]
                                .into_iter()
                                .map(|name| {
                                    (
                                        name.into(),
                                        Export {
                                            contract: caller_history_contract(),
                                            availability: Availability::Required,
                                        },
                                    )
                                })
                                .collect(),
                        },
                    )
                })
                .collect(),
            composition: None,
        },
        None,
    );
    input
        .instances
        .insert("history".into(), support::node(&history, 3));
    let app = input.instances.get_mut("app").unwrap();
    app.bindings.insert(
        "history".into(),
        vec![Target::Instance {
            path: vec!["history".into()],
            export: "History".into(),
        }],
    );
    let mut other = app.clone();
    other.key = Uuid::from_u128(4);
    input.instances.insert("other".into(), other);
    packages.push(history);
    (input, packages)
}
fn reference() -> RecoveryRef {
    RecoveryRef {
        source: DeploymentRef {
            state_domain: "a".repeat(64),
            deployment: Uuid::from_u128(700),
            revision: 1,
        },
        namespace: identity(99),
        export: "Service".into(),
        method: "change".into(),
        operation: Uuid::new_v4(),
        fingerprint: format!("sha256-{}", "b".repeat(64)),
        recovery: RecoveryProtocol::JournalV1,
        contract: maka_plugin_core::operation::RecoveryContract::for_method(
            &Contract {
                name: "test.Change".into(),
                version: 1,
                transport: Transport::Remote,
                interface: Interface::Service {
                    methods: BTreeMap::from([(
                        "change".into(),
                        Method {
                            progress: None,
                            mode: MethodMode::Mutation,
                            input: json!({}).into(),
                            output: json!({}).into(),
                            resources: BTreeMap::new(),
                        },
                    )]),
                },
            },
            "change",
        )
        .unwrap(),
    }
}
fn namespaces(dir: &std::path::Path) -> RootNamespaces {
    RootNamespaces {
        ownership: dir.join("owners"),
        control: dir.join("control"),
    }
}
fn store(timer: &tokio::runtime::Runtime, dir: &std::path::Path, create: bool) -> Arc<RootStore> {
    let owner = if create {
        RootOwner::create(&dir.join("root"), &namespaces(dir))
    } else {
        RootOwner::open(&dir.join("root"), &namespaces(dir))
    }
    .unwrap();
    Arc::new(timer.block_on(RootStore::open(Arc::new(owner))).unwrap())
}
fn start(
    timer: &tokio::runtime::Runtime,
    store: Arc<RootStore>,
    deployment: Uuid,
    target: PresentationTarget,
) -> (Application, maka_plugin_core::runtime::Mount) {
    let source = timer
        .block_on(store.load_application(deployment))
        .unwrap()
        .unwrap()
        .into_parts()
        .0
        .reference;
    let mut app = timer
        .block_on(Application::start_from_store(
            store,
            source,
            target,
            timer.handle().clone(),
            maka_ui_js::execution(maka_js_runtime::plugin::Limits {
                synchronous_slice: Duration::from_millis(100),
                ..Default::default()
            }),
            crate::support::scene::registry(target),
            vec![],
        ))
        .unwrap();
    let mount = app
        .mount_launch(json!({"padding":"x".repeat(40_000)}))
        .unwrap();
    (app, mount)
}
fn request(
    app: &mut Application,
    mount: &maka_plugin_core::runtime::Mount,
    after: u64,
    limit: usize,
) -> maka_ui_runtime::actions::ActionTask {
    let revision = app.frame(mount).unwrap().revision;
    app.dispatch(mount, revision, "inc", json!({"after":after,"limit":limit}))
        .unwrap();
    app.capture_actions(mount, |_| {
        unreachable!("history has no resource attachments")
    })
    .unwrap();
    app.start_task(mount).unwrap().unwrap()
}
fn page(
    timer: &tokio::runtime::Runtime,
    app: &mut Application,
    mount: &maka_plugin_core::runtime::Mount,
    after: u64,
    limit: usize,
) -> Value {
    let task = request(app, mount, after, limit);
    let completion = timer.block_on(task.future);
    assert!(app.finish_task(task.id, completion).unwrap().is_none());
    assert_eq!(
        app.deliver_action_results(mount, |_, _, _| Ok(false))
            .unwrap(),
        1
    );
    assert!(!app.is_retiring(mount));
    app.frame(mount).unwrap().state["outcome"].clone()
}
fn close(app: &mut Application, mount: &maka_plugin_core::runtime::Mount) {
    app.retire(mount).unwrap();
    for mount in app.retiring_mounts() {
        app.close(&mount, Ok(())).unwrap();
    }
    app.shutdown().unwrap();
}

#[test]
fn explicit_deployment_history_reads_original_consumers_but_never_another_deployment() {
    let timer = timer();
    let (mut input, packages) = fixture();
    input.instances.get_mut("app").unwrap().bindings.insert(
        "history".into(),
        vec![Target::Instance {
            path: vec!["history".into()],
            export: "DeploymentHistory".into(),
        }],
    );
    let dir = tempfile::tempdir().unwrap();
    let store = store(&timer, dir.path(), true);
    let deployment = Uuid::new_v4();
    let original = timer
        .block_on(store.commit_application(deployment, 0, input.clone(), vec![], packages.clone()))
        .unwrap();
    let other_deployment = timer
        .block_on(store.commit_application(Uuid::new_v4(), 0, input, vec![], packages))
        .unwrap();
    let a = timer
        .block_on(store.record_application_intent(
            original.clone(),
            identity(2),
            reference(),
            serde_json::Value::Null,
        ))
        .unwrap()
        .intent()
        .clone();
    timer
        .block_on(store.record_application_intent(
            other_deployment,
            identity(2),
            reference(),
            serde_json::Value::Null,
        ))
        .unwrap();
    let b = timer
        .block_on(store.record_application_intent(
            original,
            identity(4),
            reference(),
            serde_json::Value::Null,
        ))
        .unwrap()
        .intent()
        .clone();
    let (mut app, mount) = start(&timer, store.clone(), deployment, PresentationTarget::Tui);
    let first = page(&timer, &mut app, &mount, 0, 1);
    assert_eq!(
        serde_json::from_value::<Vec<CallerIntent>>(first["value"].clone())
            .unwrap()
            .as_slice(),
        std::slice::from_ref(&a)
    );
    let next = page(&timer, &mut app, &mount, a.cursor, 1);
    assert_eq!(
        serde_json::from_value::<Vec<CallerIntent>>(next["value"].clone())
            .unwrap()
            .as_slice(),
        std::slice::from_ref(&b)
    );
    let end = page(&timer, &mut app, &mount, b.cursor, 128);
    assert_eq!(end["value"], json!([]));
    close(&mut app, &mount);
    timer.block_on(store.shutdown()).unwrap();
}

#[test]
fn terminal_reads_original_caller_history_after_root_reopen_and_source_replacement() {
    let timer = timer();
    let (template, packages) = fixture();
    {
        let target = PresentationTarget::Tui;
        let dir = tempfile::tempdir().unwrap();
        let store1 = store(&timer, dir.path(), true);
        let deployment = Uuid::new_v4();
        let mut input = template.clone();
        input.environment.presentation = Some(target);
        let first = timer
            .block_on(store1.commit_application(
                deployment,
                0,
                input.clone(),
                vec![],
                packages.clone(),
            ))
            .unwrap();
        let original = reference();
        let mine = timer
            .block_on(store1.record_application_intent(
                first.clone(),
                identity(2),
                original.clone(),
                json!({"format":"test.draft@1","editor":{"owner":"original","revision":7},"attachments":["unsent"]}),
            ))
            .unwrap()
            .intent()
            .clone();
        let other = timer
            .block_on(store1.record_application_intent(
                first.clone(),
                identity(4),
                reference(),
                serde_json::Value::Null,
            ))
            .unwrap()
            .intent()
            .clone();
        let (mut app, mount) = start(&timer, store1.clone(), deployment, target);
        let out = page(&timer, &mut app, &mount, 0, 128);
        assert_eq!(out["status"], "succeeded");
        let read: Vec<CallerIntent> = serde_json::from_value(out["value"].clone()).unwrap();
        assert_eq!(read.as_slice(), std::slice::from_ref(&mine));
        let revision = app.frame(&mount).unwrap().revision;
        assert!(
            app.dispatch(
                &mount,
                revision,
                "inc",
                json!({"after":0,"limit":128,"consumer":identity(4)})
            )
            .is_err()
        );
        assert_eq!(app.frame(&mount).unwrap().revision, revision);
        assert_eq!(app.pending_action_count(), 0);
        close(&mut app, &mount);
        timer.block_on(store1.shutdown()).unwrap();
        drop(store1);
        let store2 = store(&timer, dir.path(), false);
        input.launch = Some(Target::Instance {
            path: vec!["other".into()],
            export: "App".into(),
        });
        let second = timer
            .block_on(store2.commit_application(
                deployment,
                1,
                input.clone(),
                vec![],
                packages.clone(),
            ))
            .unwrap();
        assert_ne!(second, first);
        let (mut app, mount) = start(&timer, store2.clone(), deployment, target);
        let out = page(&timer, &mut app, &mount, 0, 128);
        assert_eq!(
            serde_json::from_value::<Vec<CallerIntent>>(out["value"].clone()).unwrap(),
            [other]
        );
        close(&mut app, &mount);
        input.launch = template.launch.clone();
        timer
            .block_on(store2.commit_application(deployment, 2, input, vec![], packages.clone()))
            .unwrap();
        let (mut app, mount) = start(&timer, store2.clone(), deployment, target);
        let out = page(&timer, &mut app, &mount, 0, 128);
        assert_eq!(
            serde_json::from_value::<Vec<CallerIntent>>(out["value"].clone()).unwrap(),
            [mine]
        );
        assert_eq!(
            out["value"][0]["reference"],
            serde_json::to_value(original).unwrap()
        );
        close(&mut app, &mount);
        timer.block_on(store2.shutdown()).unwrap();
    }
}

#[test]
fn history_requires_persisted_source_and_rejects_configuration_selecting_another_namespace() {
    let timer = timer();
    let (mut input, packages) = fixture();
    assert!(
        matches!(Application::<()>::new(&input,packages.clone(),timer.handle().clone(),maka_ui_js::execution(Default::default()),crate::support::scene::registry(PresentationTarget::Tui),Default::default()),Err(maka_ui_runtime::Error::Invalid(reason)) if reason.contains(CALLER_HISTORY))
    );
    // Even if a package declaration permits these keys, the actual factory
    // rejects attempts to turn caller observations into another namespace.
    let mut packages = packages;
    let i = packages
        .iter()
        .position(|p| p.manifest().id == "native.history")
        .unwrap();
    let old = packages.remove(i);
    let mut declaration = old
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
        .configuration = json!({"type":"object"}).into();
    let package = support::package("native.history", declaration, None);
    let node = input.instances.get_mut("history").unwrap();
    node.package = package.application_ref().into();
    node.configuration.values.insert(
        "consumer".into(),
        serde_json::to_value(identity(4)).unwrap(),
    );
    packages.push(package);
    let dir = tempfile::tempdir().unwrap();
    let store = store(&timer, dir.path(), true);
    let deployment = Uuid::new_v4();
    let source = timer
        .block_on(store.commit_application(deployment, 0, input, vec![], packages))
        .unwrap();
    assert!(
        matches!(timer.block_on(Application::<()>::start_from_store(store.clone(),source,PresentationTarget::Tui,timer.handle().clone(),maka_ui_js::execution(Default::default()),crate::support::scene::registry(PresentationTarget::Tui),vec![])),Err(maka_ui_runtime::Error::Invalid(reason)) if reason.contains("unknown field"))
    );
    timer.block_on(store.shutdown()).unwrap();
}

#[test]
fn accepted_history_waiting_behind_real_sql_writer_retains_root_after_surface_exit() {
    let timer = timer();
    let dir = tempfile::tempdir().unwrap();
    let store = store(&timer, dir.path(), true);
    let deployment = Uuid::new_v4();
    let (input, packages) = fixture();
    let source = timer
        .block_on(store.commit_application(deployment, 0, input.clone(), vec![], packages.clone()))
        .unwrap();
    let original = timer
        .block_on(store.record_application_intent(
            source.clone(),
            identity(2),
            reference(),
            serde_json::Value::Null,
        ))
        .unwrap()
        .intent()
        .clone();
    let (mut app, mount) = start(&timer, store.clone(), deployment, PresentationTarget::Tui);
    let weak = Arc::downgrade(&store);
    let sql: Vec<_> = std::fs::read_dir(dir.path().join("root/runtime-partitions"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "sqlite"))
        .map(|path| {
            let connection = rusqlite::Connection::open(path).unwrap();
            connection.execute_batch("BEGIN IMMEDIATE").unwrap();
            connection
        })
        .collect();
    let queued = Arc::new(tokio::sync::Semaphore::new(0));
    let observed = queued.clone();
    let writer_store = store.clone();
    let writer_source = timer
        .block_on(store.load_application_at(&source))
        .unwrap()
        .unwrap()
        .snapshot();
    let write = timer.spawn(async move {
        let future = writer_store.record_application_intent_from(
            &writer_source,
            identity(4),
            reference(),
            serde_json::Value::Null,
        );
        tokio::pin!(future);
        std::future::poll_fn(|cx| {
            let result = future.as_mut().poll(cx);
            if result.is_pending() {
                observed.add_permits(1);
            }
            result
        })
        .await
    });
    timer.block_on(async {
        tokio::time::timeout(Duration::from_secs(3), queued.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
    });
    let task = request(&mut app, &mount, 0, 128);
    let id = task.id;
    // Poll the actual History future through its enqueue, without completing it.
    let mut future = task.future;
    timer.block_on(std::future::poll_fn(|cx| match future.as_mut().poll(cx) {
        Poll::Pending => Poll::Ready(()),
        Poll::Ready(_) => panic!("history passed the blocked SQL writer"),
    }));
    app.retire(&mount).unwrap();
    for mount in app.retiring_mounts() {
        app.close(&mount, Ok(())).unwrap();
    }
    assert!(!app.can_shutdown());
    assert_eq!(app.accepted_action_count(), 1);
    drop(store);
    assert_eq!(
        RootOwner::open(&dir.path().join("root"), &namespaces(dir.path()))
            .err()
            .unwrap()
            .kind(),
        std::io::ErrorKind::WouldBlock
    );
    for connection in &sql {
        connection.execute_batch("COMMIT").unwrap();
    }
    drop(sql);
    timer.block_on(write).unwrap().unwrap();
    let completion = timer.block_on(future);
    let maka_ui_runtime::actions::TaskCompletion::Query(ref query) = completion else {
        panic!("expected history query")
    };
    assert_eq!(
        serde_json::from_value::<Vec<CallerIntent>>(query.result.as_ref().unwrap().clone())
            .unwrap(),
        [original]
    );
    assert!(query.cleanup.is_ok());
    assert!(RootOwner::open(&dir.path().join("root"), &namespaces(dir.path())).is_err());
    app.finish_task(id, completion).unwrap();
    assert_eq!(
        app.deliver_action_results(&mount, |_, _, _| Ok(false))
            .unwrap(),
        0
    );
    assert!(app.can_shutdown());
    let observer = weak.upgrade().unwrap();
    timer.block_on(observer.shutdown()).unwrap();
    drop(observer);
    app.shutdown().unwrap();
    assert!(weak.upgrade().is_none());
    assert!(RootOwner::open(&dir.path().join("root"), &namespaces(dir.path())).is_ok());
}

#[test]
fn live_adoption_keeps_queued_history_source_and_retained_history_serves_new_consumer_epochs() {
    let timer = timer();
    let (template, packages) = fixture();
    {
        let target = PresentationTarget::Tui;
        let dir = tempfile::tempdir().unwrap();
        let store = store(&timer, dir.path(), true);
        let deployment = Uuid::new_v4();
        let mut input = template.clone();
        input.environment.presentation = Some(target);
        let first = timer
            .block_on(store.commit_application(
                deployment,
                0,
                input.clone(),
                vec![],
                packages.clone(),
            ))
            .unwrap();
        let mine = timer
            .block_on(store.record_application_intent(
                first.clone(),
                identity(2),
                reference(),
                serde_json::Value::Null,
            ))
            .unwrap()
            .intent()
            .clone();
        let (mut app, root) = start(&timer, store.clone(), deployment, target);
        let history = app
            .deployment_status()
            .instances
            .into_iter()
            .find(|s| s.activation.instance() == &identity(3))
            .unwrap()
            .activation;
        app.dispatch(&root, 0, "inc", json!({"after":0,"limit":128}))
            .unwrap();
        app.capture_actions(&root, |_| unreachable!()).unwrap();
        let mut unrelated = input.clone();
        unrelated
            .instances
            .get_mut("other")
            .unwrap()
            .configuration
            .values
            .insert("unrelated".into(), json!(true));
        let next = timer
            .block_on(store.commit_application(
                deployment,
                1,
                unrelated.clone(),
                vec![],
                packages.clone(),
            ))
            .unwrap();
        timer
            .block_on(app.adopt_committed(next.clone(), vec![]))
            .unwrap();
        app.advance_deployment().unwrap();
        assert!(!app.is_retiring(&root));
        let task = app.start_task(&root).unwrap().unwrap();
        let completion = timer.block_on(task.future);
        app.finish_task(task.id, completion).unwrap();
        assert_eq!(
            app.deliver_action_results(&root, |_, _, _| Ok(false))
                .unwrap(),
            1
        );
        let read: Vec<CallerIntent> =
            serde_json::from_value(app.frame(&root).unwrap().state["outcome"]["value"].clone())
                .unwrap();
        assert_eq!(read, vec![mine.clone()]);
        assert_eq!(app.deployment_status().effective, Some(next));
        unrelated
            .instances
            .get_mut("app")
            .unwrap()
            .configuration
            .values
            .insert("new_epoch".into(), json!(true));
        let latest = timer
            .block_on(store.commit_application(deployment, 2, unrelated, vec![], packages.clone()))
            .unwrap();
        timer
            .block_on(app.adopt_committed(latest.clone(), vec![]))
            .unwrap();
        app.advance_deployment().unwrap();
        assert!(app.is_retiring(&root));
        app.close(&root, Ok(())).unwrap();
        app.advance_deployment().unwrap();
        assert_eq!(app.deployment_status().effective, Some(latest));
        assert!(
            app.deployment_status()
                .instances
                .iter()
                .any(|s| s.activation == history)
        );
        let fresh = app.mount_launch(json!({})).unwrap();
        let out = page(&timer, &mut app, &fresh, 0, 128);
        assert_eq!(out["status"], "succeeded");
        let read: Vec<CallerIntent> = serde_json::from_value(out["value"].clone()).unwrap();
        assert_eq!(read, vec![mine]);
        close(&mut app, &fresh);
        drop(app);
        timer
            .block_on(Arc::try_unwrap(store).ok().unwrap().close())
            .unwrap();
    }
}
