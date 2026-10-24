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
use maka_plugin_core::{
    composition::{PresentationTarget, Target},
    contract::{
        Availability, Cardinality, Contract, Export, Import, Interface, Method, MethodMode,
        Transport,
    },
    package::{Declaration, EntryDeclaration, EntryTarget, Implementation},
    runtime::Mount,
};
use maka_ui_runtime::{
    ComponentCall, ComponentOutput, ComponentSlot, Emission, EventOrigin, Frame, NativeCapability,
    NativeComponent, NativeExport, NativeView, Surface, actions::*,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

fn service_contract(mode: Mode) -> Contract {
    Contract {
        name: "test.Stream".into(),
        version: 1,
        transport: Transport::Local,
        interface: Interface::Service {
            methods: BTreeMap::from([
                (
                    "read".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Subscription,
                        input: json!({}).into(),
                        output: if matches!(mode, Mode::WideItem | Mode::WideJavaScript) {
                            json!({"type":"string"}).into()
                        } else {
                            json!({"type":"integer"}).into()
                        },
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "panic".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Mutation,
                        input: json!({}).into(),
                        output: json!({}).into(),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "query".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Query,
                        input: json!({}).into(),
                        output: json!({"type":"integer"}).into(),
                        resources: BTreeMap::new(),
                    },
                ),
            ]),
        },
    }
}
struct Sequence(Arc<AtomicUsize>, Mode);
impl NativeService for Sequence {
    fn call(&self, _: ServiceRequest) -> ServiceFuture {
        Box::pin(async {
            ServiceCompletion {
                result: Ok(json!(0)),
                cleanup: Ok(()),
            }
        })
    }
    fn mutation(&self, _: ServiceRequest) -> Result<Arc<dyn NativeMutation>, String> {
        panic!("actual native mutation factory panic")
    }
    fn subscribe(&self, _: ServiceRequest, stop: CancellationToken) -> StreamFuture {
        self.0.fetch_add(1, Ordering::SeqCst);
        if matches!(self.1, Mode::Open) {
            return Box::pin(async move {
                stop.cancelled().await;
                StreamCompletion::Finished(ServiceCompletion {
                    result: Ok(json!(0)),
                    cleanup: Ok(()),
                })
            });
        }
        sequence(0, stop, self.1)
    }
}
fn sequence(index: usize, stop: CancellationToken, mode: Mode) -> StreamFuture {
    Box::pin(async move {
        if stop.is_cancelled() || index == 3 {
            return StreamCompletion::Finished(ServiceCompletion {
                result: Ok(if matches!(mode, Mode::WideItem | Mode::WideJavaScript) {
                    json!("done")
                } else {
                    json!(3)
                }),
                cleanup: if matches!(mode, Mode::FailedCleanup) {
                    Err("actual cleanup unknown".into())
                } else {
                    Ok(())
                },
            });
        }
        StreamCompletion::Item {
            value: match mode {
                Mode::BadItem => json!("wrong schema"),
                Mode::WideItem | Mode::WideJavaScript => wide_item(index),
                _ => json!(index),
            },
            next: sequence(index + 1, stop, mode),
        }
    })
}
#[derive(Clone, Copy)]
enum Mode {
    Causal,
    Ordered,
    Many,
    Open,
    Panic,
    BadItem,
    WideItem,
    WideJavaScript,
    FailedCleanup,
}
fn wide_item(index: usize) -> Value {
    json!(format!("{index}:{}:尾", "中🙂\"\\\n\0".repeat(8192)))
}
struct Parent(Mode);
impl NativeComponent<()> for Parent {
    fn call(
        &self,
        call: ComponentCall<'_>,
        _: &maka_ui_runtime::abi::ValueBindings,
    ) -> maka_ui_runtime::Result<ComponentOutput<NativeView<()>>> {
        let mut state = match &call {
            ComponentCall::Mount { .. } => {
                json!({"revision":0,"selector":0,"cycle":0,"queried":false})
            }
            ComponentCall::Event { state, .. } | ComponentCall::Update { state, .. } => {
                let mut next = (*state).clone();
                next["revision"] = json!(state["revision"].as_u64().unwrap() + 1);
                next
            }
        };
        if let ComponentCall::Event {
            origin, key, input, ..
        } = &call
        {
            match origin {
                EventOrigin::Raw
                    if *key == "inc"
                        && !matches!(self.0, Mode::Panic | Mode::Open | Mode::Ordered) =>
                {
                    state["selector"] = json!(1);
                    state["cycle"] = json!(state["cycle"].as_u64().unwrap() + 1);
                }
                EventOrigin::Component { .. } => state["selector"] = (*input).clone(),
                EventOrigin::Action => state["feedback"] = (*input).clone(),
                _ => {}
            }
            if matches!(self.0, Mode::Ordered) {
                let event = match origin {
                    EventOrigin::Raw => json!({"input":input}),
                    EventOrigin::Action => json!({"feedback":input}),
                    _ => unreachable!(),
                };
                state
                    .as_object_mut()
                    .unwrap()
                    .entry("delivered")
                    .or_insert_with(|| json!([]))
                    .as_array_mut()
                    .unwrap()
                    .push(event);
            }
        }
        let mut slots = Vec::new();
        if matches!(self.0, Mode::Causal) {
            slots.push(ComponentSlot {
                key: "child".into(),
                binding: "child".into(),
                member: 0,
                props: json!({"cycle":state["cycle"]}),
                on: BTreeMap::from([("change".into(), "changed".into())]),
            });
        }
        let mut output = Frame {
            revision: state["revision"].as_u64().unwrap(),
            state: state.clone(),
            surface: Some(Surface::Terminal {
                binding: "surface".into(),
            }),
            view: NativeView::new(
                Rc::new(()),
                BTreeMap::from([("inc".into(), json!({}))]),
                slots,
            )?,
        }
        .output(vec![]);
        let count = if matches!(self.0, Mode::Many | Mode::Open) {
            16
        } else {
            1
        };
        output.subscriptions = (0..count)
            .map(|i| Action {
                recovery: Value::Null,
                continuations: Vec::new(),
                key: format!("feed{i}"),
                binding: "stream".into(),
                member: 0,
                method: "read".into(),
                input: state["selector"].clone(),
                resources: BTreeMap::new(),
            })
            .collect();
        if matches!(self.0, Mode::Many)
            && matches!(
                &call,
                ComponentCall::Event {
                    origin: EventOrigin::Action,
                    ..
                }
            )
            && !state["queried"].as_bool().unwrap()
        {
            output.frame.state["queried"] = json!(true);
            output.actions.push(Action {
                recovery: Value::Null,
                continuations: Vec::new(),
                key: "probe".into(),
                binding: "stream".into(),
                member: 0,
                method: "query".into(),
                input: Value::Null,
                resources: BTreeMap::new(),
            });
        }
        if matches!(self.0, Mode::Open)
            && matches!(
                &call,
                ComponentCall::Event {
                    origin: EventOrigin::Raw,
                    ..
                }
            )
        {
            output.actions.push(Action {
                recovery: Value::Null,
                continuations: Vec::new(),
                key: "probe".into(),
                binding: "stream".into(),
                member: 0,
                method: "query".into(),
                input: Value::Null,
                resources: BTreeMap::new(),
            });
        }
        if matches!(self.0, Mode::Panic)
            && matches!(
                &call,
                ComponentCall::Event {
                    origin: EventOrigin::Raw,
                    ..
                }
            )
        {
            output.actions.push(Action {
                recovery: Value::Null,
                continuations: Vec::new(),
                key: "panic".into(),
                binding: "stream".into(),
                member: 0,
                method: "panic".into(),
                input: Value::Null,
                resources: BTreeMap::new(),
            });
        }
        Ok(output)
    }
}
struct Child;
impl NativeComponent<()> for Child {
    fn call(
        &self,
        call: ComponentCall<'_>,
        _: &maka_ui_runtime::abi::ValueBindings,
    ) -> maka_ui_runtime::Result<ComponentOutput<NativeView<()>>> {
        let (revision, cycle, emit) = match call {
            ComponentCall::Mount { props } => (0, props["cycle"].clone(), false),
            ComponentCall::Update { state, props } => (
                state["revision"].as_u64().unwrap() + 1,
                props["cycle"].clone(),
                props["cycle"] != state["cycle"],
            ),
            _ => panic!("no child raw inputs"),
        };
        let events = if emit {
            vec![Emission {
                name: "change".into(),
                value: json!(0),
            }]
        } else {
            vec![]
        };
        Ok(Frame {
            revision,
            state: json!({"revision":revision,"cycle":cycle}),
            surface: None,
            view: NativeView::new(Rc::new(()), BTreeMap::new(), vec![])?,
        }
        .output(events))
    }
}
fn component_contract(name: &str, events: BTreeMap<String, Value>) -> Contract {
    Contract {
        name: name.into(),
        version: 1,
        transport: Transport::Local,
        interface: Interface::Component {
            props: json!({"type":"object"}).into(),
            events: events
                .into_iter()
                .map(|(name, schema)| (name, schema.into()))
                .collect(),
            captures: BTreeMap::new(),
        },
    }
}
fn native_package(name: &str, implementation: &str, contract: Contract) -> maka_packages::Package {
    support::package(
        name,
        Declaration {
            entries: BTreeMap::from([(
                EntryTarget::Tui,
                EntryDeclaration {
                    scene: None,
                    implementation: Implementation::Native {
                        implementation: implementation.into(),
                    },
                    configuration: json!({"type":"object"}).into(),
                    imports: BTreeMap::new(),
                    exports: BTreeMap::from([(
                        "Export".into(),
                        Export {
                            contract,
                            availability: Availability::Required,
                        },
                    )]),
                },
            )]),
            composition: None,
        },
        None,
    )
}
fn fixture_data(
    mode: Mode,
) -> (
    maka_plugin_core::composition::Input,
    Vec<maka_packages::Package>,
    maka_ui_runtime::NativeRegistry<()>,
    Arc<AtomicUsize>,
) {
    let (mut input, mut packages) = support::fixture("");
    let original = packages.pop().unwrap();
    let mut declaration = original
        .manifest()
        .application
        .as_ref()
        .unwrap()
        .declaration()
        .clone();
    let entry = declaration.entries.get_mut(&EntryTarget::Tui).unwrap();
    let javascript = matches!(mode, Mode::WideJavaScript);
    if javascript {
        entry.implementation = Implementation::JavaScript {
            module: "index.mjs".into(),
            realm: maka_plugin_core::package::Realm::Dedicated,
        };
    } else {
        entry.scene = None;
        entry.implementation = Implementation::Native {
            implementation: "test.parent".into(),
        };
    }
    let parent_contract = entry.exports["App"].contract.clone();
    let child_contract = component_contract(
        "test.Child",
        BTreeMap::from([("change".into(), json!({"type":"integer"}))]),
    );
    for (name, contract) in [
        ("stream", service_contract(mode)),
        ("child", child_contract.clone()),
    ] {
        entry.imports.insert(
            name.into(),
            Import {
                contract,
                cardinality: Cardinality::One,
            },
        );
    }
    let source = javascript.then(|| format!(r#"
        export function activate() {{ return {{App:{{contract:{},kind:'component',component:['app']}}}}; }}
        function frame(state) {{ return {{actions:[],events:[],subscriptions:[{{key:'feed0',binding:'stream',member:0,method:'read',input:0,resources:{{}}}}],frame:{{revision:state.revision,state,surface:{{kind:'terminal',binding:'surface'}},view:{{kind:'text',key:'root',text:'stream',color:16777215}}}}}}; }}
        export const app = {{mount(){{return frame({{revision:0}});}},event(state,event){{return frame({{revision:state.revision+1,feedback:event.event}});}},update(state){{return frame({{...state,revision:state.revision+1}});}}}};
    "#, serde_json::to_string(&parent_contract).unwrap()));
    let package = support::package("native.parent", declaration, source);
    input.instances.get_mut("app").unwrap().package = package.application_ref().into();
    packages.push(package);
    let service = native_package("native.stream", "test.stream", service_contract(mode));
    let child = native_package("native.child", "test.child", child_contract.clone());
    for (name, key, package) in [("stream", 3, &service), ("child", 4, &child)] {
        input
            .instances
            .insert(name.into(), support::node(package, key));
        input.instances.get_mut("app").unwrap().bindings.insert(
            name.into(),
            vec![Target::Instance {
                path: vec![name.into()],
                export: "Export".into(),
            }],
        );
    }
    packages.extend([service, child]);
    let starts = Arc::new(AtomicUsize::new(0));
    let observed = starts.clone();
    let mut native = support::scene::registry(PresentationTarget::Tui);
    native
        .register("test.parent", move |_, _| {
            Ok(BTreeMap::from([(
                "App".into(),
                NativeExport {
                    contract: parent_contract.clone(),
                    value: NativeCapability::Component(Rc::new(Parent(mode))),
                },
            )]))
        })
        .unwrap();
    native
        .register("test.child", move |_, _| {
            Ok(BTreeMap::from([(
                "Export".into(),
                NativeExport {
                    contract: child_contract.clone(),
                    value: NativeCapability::Component(Rc::new(Child)),
                },
            )]))
        })
        .unwrap();
    native
        .register("test.stream", move |_, _| {
            Ok(BTreeMap::from([(
                "Export".into(),
                NativeExport {
                    contract: service_contract(mode),
                    value: NativeCapability::Service(Arc::new(Sequence(observed.clone(), mode))),
                },
            )]))
        })
        .unwrap();
    (input, packages, native, starts)
}
fn fixture(mode: Mode, timer: &tokio::runtime::Runtime) -> (Application, Arc<AtomicUsize>) {
    let (input, packages, native, starts) = fixture_data(mode);
    (
        Application::new(
            &input,
            packages,
            timer.handle().clone(),
            maka_ui_js::execution(Default::default()),
            native,
            Default::default(),
        )
        .unwrap(),
        starts,
    )
}

fn start(app: &mut Application, root: &Mount) -> ActionTask {
    app.capture_actions(root, |_| panic!("no resources"))
        .unwrap();
    app.start_task(root).unwrap().unwrap()
}
fn run(timer: &tokio::runtime::Runtime, task: ActionTask) -> (uuid::Uuid, TaskCompletion) {
    (
        task.id,
        timer.block_on(async {
            tokio::time::timeout(Duration::from_secs(10), task.future)
                .await
                .unwrap()
        }),
    )
}
fn finish(
    timer: &tokio::runtime::Runtime,
    app: &mut Application,
    root: &Mount,
    mut task: ActionTask,
) {
    loop {
        let (id, completion) = run(timer, task);
        let next = app.finish_task(id, completion).unwrap();
        app.deliver_action_results(root, |_, _, _| Ok(false))
            .unwrap();
        if let Some(value) = next {
            task = value
        } else {
            break;
        }
    }
}
fn close(app: &mut Application, roots: &[Mount]) {
    for root in roots {
        app.retire(root).unwrap();
    }
    for mount in app.retiring_mounts() {
        app.close(&mount, Ok(())).unwrap();
    }
    app.shutdown().unwrap();
}

#[test]
fn queued_native_and_physical_input_commit_before_ready_stream_feedback() {
    use std::{
        future::Future,
        pin::Pin,
        task::{Context, Poll, Waker},
    };

    let timer = timer();
    let (mut app, starts) = fixture(Mode::Ordered, &timer);
    let root = app.mount_launch(json!({})).unwrap();
    app.defer_native_commit();
    let deliver = |app: &mut Application| {
        maka_ui_runtime::Application::deliver_action_results(app, &root, |_, _, _| Ok(false))
            .unwrap()
    };
    let commit = |app: &mut Application| {
        app.advance_ui().unwrap();
        assert!(app.commit_ui(&root, |_, _| Ok(())).unwrap());
    };
    let (id, first) = run(&timer, start(&mut app, &root));
    let successor = app.finish_task(id, first).unwrap().unwrap();
    assert_eq!(deliver(&mut app), 1);

    // Capture both inputs while the first stream transaction still owns its
    // candidate. Their admission is not publication of either input.
    let mut publication = app
        .dispatch_observation(&root, 0, "inc", json!("native-first"))
        .unwrap();
    maka_ui_runtime::Application::dispatch(&mut app, &root, 0, "inc", json!("physical-second"))
        .unwrap();
    let mut cx = Context::from_waker(Waker::noop());
    assert!(Pin::new(&mut publication).poll(&mut cx).is_pending());
    commit(&mut app);
    assert!(Pin::new(&mut publication).poll(&mut cx).is_pending());

    // The commit ACK releases the next original service item. This is the
    // foreground boundary where feedback used to bypass already queued input.
    let (next_id, second) = run(&timer, successor);
    assert_eq!(next_id, id);
    let mut successor = app.finish_task(id, second).unwrap().unwrap();
    assert_eq!(deliver(&mut app), 0);
    assert_eq!(
        app.frame(&root).unwrap().state["delivered"],
        json!([{"feedback":{"status":"updated","value":0}}])
    );
    assert!(successor.future.as_mut().poll(&mut cx).is_pending());

    commit(&mut app);
    assert!(matches!(
        Pin::new(&mut publication).poll(&mut cx),
        Poll::Ready(Ok(()))
    ));
    assert_eq!(deliver(&mut app), 0);
    commit(&mut app);
    assert_eq!(
        app.frame(&root).unwrap().state["delivered"],
        json!([
            {"feedback":{"status":"updated","value":0}},
            {"input":"native-first"},
            {"input":"physical-second"}
        ])
    );
    assert!(
        successor.future.as_mut().poll(&mut cx).is_pending(),
        "input commits cannot acknowledge undelivered service feedback"
    );

    assert_eq!(deliver(&mut app), 1);
    commit(&mut app);
    loop {
        let (next_id, completion) = run(&timer, successor);
        assert_eq!(next_id, id);
        let next = app.finish_task(id, completion).unwrap();
        assert_eq!(deliver(&mut app), 1);
        commit(&mut app);
        match next {
            Some(task) => successor = task,
            None => break,
        }
    }
    assert_eq!(
        app.frame(&root).unwrap().state["delivered"],
        json!([
            {"feedback":{"status":"updated","value":0}},
            {"input":"native-first"},
            {"input":"physical-second"},
            {"feedback":{"status":"updated","value":1}},
            {"feedback":{"status":"updated","value":2}},
            {"feedback":{"status":"succeeded","value":3}}
        ])
    );
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(app.accepted_action_count(), 0);
    close(&mut app, &[root]);
}

#[test]
fn temporary_causal_demand_changes_do_not_restart_original_committed_execution() {
    let timer = timer();
    let (mut app, starts) = fixture(Mode::Causal, &timer);
    let root = app.mount_launch(json!({})).unwrap();
    let (id, item) = run(&timer, start(&mut app, &root));
    let next = app.finish_task(id, item).unwrap().unwrap();
    app.deliver_action_results(&root, |_, _, _| Ok(false))
        .unwrap();
    app.dispatch(
        &root,
        app.frame(&root).unwrap().revision,
        "inc",
        Value::Null,
    )
    .unwrap();
    assert_eq!(app.frame(&root).unwrap().state["selector"], 0);
    app.capture_actions(&root, |_| panic!("no recapture"))
        .unwrap();
    assert!(app.start_task(&root).unwrap().is_none());
    assert_eq!(app.accepted_action_count(), 1);
    let (next_id, item) = run(&timer, next);
    assert_eq!(next_id, id);
    assert!(matches!(
        &item,
        TaskCompletion::Subscription(StreamCompletion::Item { .. })
    ));
    let next = app.finish_task(id, item).unwrap().unwrap();
    app.deliver_action_results(&root, |_, _, _| Ok(false))
        .unwrap();
    finish(&timer, &mut app, &root, next);
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    close(&mut app, &[root]);
}
#[test]
fn open_subscriptions_do_not_block_an_independent_query() {
    use std::{future::poll_fn, task::Poll};

    let timer = timer();
    let (mut app, starts) = fixture(Mode::Open, &timer);
    let roots = (0..9)
        .map(|_| app.mount_launch(json!({})).unwrap())
        .collect::<Vec<_>>();
    let mut streams = Vec::new();
    for root in &roots {
        app.capture_actions(root, |_| panic!("no resources"))
            .unwrap();
        while let Some(task) = app.start_task(root).unwrap() {
            streams.push(task);
        }
    }
    timer.block_on(poll_fn(|cx| {
        for task in &mut streams {
            assert!(task.future.as_mut().poll(cx).is_pending());
        }
        Poll::Ready(())
    }));
    app.dispatch(&roots[0], 0, "inc", Value::Null).unwrap();
    app.capture_actions(&roots[0], |_| panic!("no resources"))
        .unwrap();
    let mut query_completed = false;
    let query_completed = timer.block_on(async {
        tokio::time::timeout(
            Duration::from_secs(2),
            poll_fn(|cx| {
                app.set_waker(cx.waker().clone());
                for root in &roots {
                    while let Some(task) = app.start_task(root).unwrap() {
                        // The independent query is enqueued after all subscription demand.
                        // Polling distinguishes actual query completion from queue admission.
                        streams.push(task);
                    }
                }
                for index in (0..streams.len()).rev() {
                    if let Poll::Ready(completion) = streams[index].future.as_mut().poll(cx) {
                        let task = streams.swap_remove(index);
                        assert!(matches!(completion, TaskCompletion::Query(_)));
                        assert!(app.finish_task(task.id, completion).unwrap().is_none());
                        query_completed = true;
                    }
                }
                if query_completed {
                    Poll::Ready(())
                } else {
                    Poll::Pending
                }
            }),
        )
        .await
        .is_ok()
    });
    if query_completed {
        assert_eq!(
            app.deliver_action_results(&roots[0], |_, _, _| Ok(false))
                .unwrap(),
            1
        );
        assert_eq!(
            app.frame(&roots[0]).unwrap().state["feedback"],
            json!({"status":"succeeded","value":0})
        );
    }
    let opened = starts.load(Ordering::SeqCst);
    for root in &roots {
        app.retire(root).unwrap();
        assert!(app.start_task(root).unwrap().is_none());
    }
    for task in streams {
        let (id, completion) = run(&timer, task);
        assert!(matches!(
            completion,
            TaskCompletion::Subscription(StreamCompletion::Finished(ServiceCompletion {
                cleanup: Ok(()),
                ..
            }))
        ));
        assert!(app.finish_task(id, completion).unwrap().is_none());
    }
    assert_eq!(app.accepted_action_count(), 0);
    close(&mut app, &roots);
    assert!(
        query_completed,
        "short query did not complete while {opened} subscriptions remained open"
    );
    assert_eq!(
        opened, 144,
        "all independent subscription demand must be admitted"
    );
}

#[test]
fn one_pending_feedback_does_not_double_charge_each_of_48_live_requests() {
    let timer = timer();
    let (mut app, starts) = fixture(Mode::Many, &timer);
    let roots = (0..3)
        .map(|_| app.mount_launch(json!({})).unwrap())
        .collect::<Vec<_>>();
    let mut successors = Vec::new();
    for root in &roots {
        app.capture_actions(root, |_| panic!("no resources"))
            .unwrap();
        while let Some(task) = app.start_task(root).unwrap() {
            let (id, item) = run(&timer, task);
            successors.push(app.finish_task(id, item).unwrap().unwrap());
        }
    }
    assert_eq!(starts.load(Ordering::SeqCst), 48);
    assert_eq!(app.pending_action_count(), 48);
    assert_eq!(
        app.deliver_action_results(&roots[0], |_, _, _| Ok(false))
            .unwrap(),
        16
    );
    assert!(!app.is_retiring(&roots[0]));
    assert_eq!(app.pending_action_count(), 49);
    let probe = start(&mut app, &roots[0]);
    let (id, result) = run(&timer, probe);
    assert!(app.finish_task(id, result).unwrap().is_none());
    app.deliver_action_results(&roots[0], |_, _, _| Ok(false))
        .unwrap();
    for root in &roots {
        app.retire(root).unwrap();
    }
    for task in successors {
        let (id, result) = run(&timer, task);
        assert!(app.finish_task(id, result).unwrap().is_none());
    }
    assert_eq!(app.accepted_action_count(), 0);
    close(&mut app, &roots);
}

#[test]
fn mutation_factory_panic_cancels_stream_waiting_ack_and_preserves_failed_preparation_fence() {
    use maka_event_log::{
        RootStore,
        root::{RootNamespaces, RootOwner},
    };
    let timer = timer();
    let dir = tempfile::tempdir().unwrap();
    let ns = RootNamespaces {
        ownership: dir.path().join("owners"),
        control: dir.path().join("control"),
    };
    let store = Arc::new(
        timer
            .block_on(RootStore::open(Arc::new(
                RootOwner::create(&dir.path().join("root"), &ns).unwrap(),
            )))
            .unwrap(),
    );
    let (input, packages, native, starts) = fixture_data(Mode::Panic);
    let source = timer
        .block_on(store.commit_application(uuid::Uuid::new_v4(), 0, input, vec![], packages))
        .unwrap();
    let mut app = timer
        .block_on(Application::start_from_store(
            store.clone(),
            source,
            PresentationTarget::Tui,
            timer.handle().clone(),
            maka_ui_js::execution(Default::default()),
            native,
            vec![],
        ))
        .unwrap();
    let root = app.mount_launch(json!({})).unwrap();
    let (id, item) = run(&timer, start(&mut app, &root));
    let next = app.finish_task(id, item).unwrap().unwrap();
    // Do not deliver/ACK the pending item. Another original service request
    // retires the native provider and dependent consumer synchronously.
    app.dispatch(&root, 0, "inc", Value::Null).unwrap();
    app.capture_actions(&root, |_| panic!("resource-free"))
        .unwrap();
    assert!(app.start_task(&root).unwrap().is_none());
    assert!(app.is_retiring(&root));
    let failures = app.failed_action_ids();
    assert_eq!(failures.len(), 1);
    let (stream_id, actual) = run(&timer, next);
    assert_eq!(stream_id, id);
    assert!(matches!(
        &actual,
        TaskCompletion::Subscription(StreamCompletion::Finished(_))
    ));
    assert!(app.finish_task(id, actual).unwrap().is_none());
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(app.accepted_action_count(), 0);
    assert!(
        !app.can_shutdown(),
        "panic preparation remains an independent real cleanup fence"
    );
    app.complete_action_cleanup(failures[0], Ok(())).unwrap();
    close(&mut app, &[root]);
    timer.block_on(store.shutdown()).unwrap();
}

#[test]
fn large_native_items_reach_native_and_javascript_components_exactly() {
    for mode in [Mode::WideItem, Mode::WideJavaScript] {
        let timer = timer();
        let (mut app, starts) = fixture(mode, &timer);
        let root = app.mount_launch(json!({})).unwrap();
        let mut task = start(&mut app, &root);
        for index in 0..3 {
            let (id, item) = run(&timer, task);
            task = app.finish_task(id, item).unwrap().unwrap();
            assert_eq!(
                app.deliver_action_results(&root, |_, _, _| Ok(false))
                    .unwrap(),
                1
            );
            assert!(
                app.frame(&root).unwrap().state["feedback"]
                    == json!({"status":"updated","value":wide_item(index)}),
                "original component item {index} changed"
            );
        }
        finish(&timer, &mut app, &root, task);
        assert_eq!(
            app.frame(&root).unwrap().state["feedback"],
            json!({"status":"succeeded","value":"done"})
        );
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(app.accepted_action_count(), 0);
        close(&mut app, &[root]);
    }
}

#[test]
fn invalid_native_items_stop_before_feedback_and_complete_original_source() {
    let timer = timer();
    let (mut app, starts) = fixture(Mode::BadItem, &timer);
    let root = app.mount_launch(json!({})).unwrap();
    let (id, item) = run(&timer, start(&mut app, &root));
    let successor = app.finish_task(id, item).unwrap().unwrap();
    assert_eq!(
        app.deliver_action_results(&root, |_, _, _| Ok(false))
            .unwrap(),
        0,
        "invalid item must never enter the component"
    );
    let (_, actual) = run(&timer, successor);
    assert!(matches!(
        &actual,
        TaskCompletion::Subscription(StreamCompletion::Finished(_))
    ));
    assert!(app.finish_task(id, actual).unwrap().is_none());
    assert_eq!(
        app.deliver_action_results(&root, |_, _, _| Ok(false))
            .unwrap(),
        1
    );
    let feedback = &app.frame(&root).unwrap().state["feedback"];
    assert_eq!(feedback["status"], "failed");
    assert!(feedback["reason"].as_str().unwrap().contains("integer"));
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(app.accepted_action_count(), 0);
    close(&mut app, &[root]);
}
#[test]
fn completed_stream_with_failed_cleanup_preserves_work_until_actual_confirmation() {
    let timer = timer();
    let (mut app, _) = fixture(Mode::FailedCleanup, &timer);
    let root = app.mount_launch(json!({})).unwrap();
    let mut task = start(&mut app, &root);
    let id = task.id;
    loop {
        let (_, completion) = run(&timer, task);
        match app.finish_task(id, completion) {
            Ok(Some(next)) => {
                app.deliver_action_results(&root, |_, _, _| Ok(false))
                    .unwrap();
                task = next;
            }
            Err(error) => {
                assert!(error.to_string().contains("actual cleanup unknown"));
                break;
            }
            Ok(None) => panic!("failed cleanup is not successful settlement"),
        }
    }
    assert!(app.is_retiring(&root));
    assert_eq!(app.accepted_action_count(), 1);
    assert_eq!(app.failed_action_ids(), vec![id]);
    for mount in app.retiring_mounts() {
        app.close(&mount, Ok(())).unwrap();
    }
    assert!(!app.can_shutdown());
    assert!(
        app.complete_action_cleanup(id, Err("still unconfirmed".into()))
            .is_err()
    );
    assert_eq!(app.accepted_action_count(), 1);
    app.complete_action_cleanup(id, Ok(())).unwrap();
    assert_eq!(app.accepted_action_count(), 0);
    app.shutdown().unwrap();
}
