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
use maka_capabilities::call::ReadResource;
use maka_plugin_core::{
    composition::{Input, PresentationTarget},
    contract::ResourceType,
    runtime::Mount,
};
use maka_ui_runtime::actions::*;
use maka_ui_runtime::{
    ComponentCall, ComponentOutput, Frame, NativeCapability, NativeComponent, NativeExport,
    NativeRegistry, NativeView,
};
use serde_json::{Value, json};
use std::{cell::Cell, collections::BTreeMap, rc::Rc, sync::Arc};
struct Leaf {
    captures: Rc<Cell<usize>>,
    large: bool,
}
impl NativeComponent<()> for Leaf {
    fn call(
        &self,
        call: ComponentCall<'_>,
        _values: &maka_ui_runtime::abi::ValueBindings,
    ) -> maka_ui_runtime::Result<ComponentOutput<NativeView<()>>> {
        let revision = match call {
            ComponentCall::Mount { .. } => 0,
            ComponentCall::Update { state, .. } | ComponentCall::Event { state, .. } => {
                state["revision"].as_u64().unwrap() + 1
            }
        };
        Ok(Frame {revision,state:json!({"revision":revision,"blob":if self.large {"x".repeat(1_048_430)} else {String::new()}}),surface:None,view:NativeView::new(Rc::new(()),BTreeMap::new(), vec![])? }.output(vec![]))
    }
    fn capture(&self, _: CaptureCall<'_>) -> maka_ui_runtime::Result<CapturePlan> {
        self.captures.set(self.captures.get() + 1);
        Ok(CapturePlan::Native)
    }
}
struct Text(String);
impl ReadResource for Text {
    fn resource_type(&self) -> ResourceType {
        maka_ui_runtime::text::text_resource_type()
    }
    fn bytes(&self) -> usize {
        self.0.len()
    }
    fn metadata(&self) -> Value {
        json!({"revision":3,"bytes":self.0.len()})
    }
    fn read(&self, r: std::ops::Range<usize>) -> Result<Vec<u8>, String> {
        self.0
            .get(r)
            .map(|s| s.as_bytes().to_vec())
            .ok_or("range".into())
    }
}
fn fixture(
    large: bool,
) -> (
    Input,
    Vec<maka_packages::Package>,
    NativeRegistry<()>,
    Rc<Cell<usize>>,
) {
    fixture_with_continuation(large, false)
}
fn fixture_with_continuation(
    large: bool,
    guarded: bool,
) -> (
    Input,
    Vec<maka_packages::Package>,
    NativeRegistry<()>,
    Rc<Cell<usize>>,
) {
    let (input, packages, contract) = if guarded {
        support::continuation_fixture()
    } else {
        let (input, packages) = support::resource_fixture();
        (
            input,
            packages,
            maka_ui_runtime::textarea::textarea_contract(),
        )
    };
    let calls = Rc::new(Cell::new(0));
    let observed = calls.clone();
    let mut native = crate::support::scene::registry(PresentationTarget::Tui);
    native
        .register("maka.ui.textarea", move |_, _values| {
            Ok(BTreeMap::from([(
                "Textarea".into(),
                NativeExport {
                    contract: contract.clone(),
                    value: NativeCapability::Component(Rc::new(Leaf {
                        captures: observed.clone(),
                        large,
                    })),
                },
            )]))
        })
        .unwrap();
    (input, packages, native, calls)
}
fn application(
    large: bool,
    timer: &tokio::runtime::Runtime,
) -> (Application, Mount, Rc<Cell<usize>>) {
    let (input, packages, native, calls) = fixture(large);
    let mut app = Application::new(
        &input,
        packages,
        timer.handle().clone(),
        maka_ui_js::execution(Default::default()),
        native,
        Default::default(),
    )
    .unwrap();
    let root = app.mount_launch(json!({})).unwrap();
    (app, root, calls)
}
fn capture(app: &mut Application, root: &Mount, text: &str) -> Arc<dyn ReadResource> {
    let snapshot: Arc<dyn ReadResource> = Arc::new(Text(text.into()));
    let result = snapshot.clone();
    app.capture_actions(root, |target| {
        assert_eq!(target.method(), "snapshot");
        assert_eq!(
            target.output(),
            &maka_plugin_core::contract::CaptureOutput::Resource {
                resource: maka_ui_runtime::text::text_resource_type()
            }
        );
        Ok(NativeCapture::Resource(snapshot.clone()))
    })
    .unwrap();
    result
}
fn close_all(app: &mut Application, roots: &[Mount]) {
    for r in roots {
        app.retire(r).unwrap();
    }
    for m in app.retiring_mounts() {
        app.close(&m, Ok(())).unwrap();
    }
    app.shutdown().unwrap();
}
#[test]
fn mounted_wrapper_capture_and_typed_resource_action_keep_exact_root_and_internal_result_authority()
{
    let timer = timer();
    let (mut app, a, calls) = application(false, &timer);
    let b = app.mount_launch(json!({})).unwrap();
    let inner = app
        .child_mount(app.child_mount(&a, "editor").unwrap(), "draft")
        .unwrap()
        .clone();
    app.dispatch(&a, 0, "read", json!({})).unwrap();
    assert_eq!(calls.get(), 1);
    app.capture_actions(&a, |target| {
        assert_eq!(target.mount(), &inner);
        Ok(NativeCapture::Resource(Arc::new(Text("Start".into()))))
    })
    .unwrap();
    assert!(app.start_task(&b).unwrap().is_none());
    let accepted = app.start_task(&a).unwrap().unwrap();
    let done = timer.block_on(accepted.future);
    let maka_ui_runtime::actions::TaskCompletion::Query(ref completion) = done else {
        panic!("expected query completion")
    };
    assert_eq!(completion.result.as_ref().unwrap()["text"], "Start");
    app.finish_task(accepted.id, done).unwrap();
    assert_eq!(
        app.deliver_action_results(&b, |_, _, _| Ok(false)).unwrap(),
        0
    );
    assert_eq!(app.frame(&b).unwrap().revision, 0);
    assert_eq!(
        app.deliver_action_results(&a, |_, _, _| Ok(false)).unwrap(),
        1
    );
    assert_eq!(
        app.frame(&a).unwrap().state["outcome"]["value"]["text"],
        "Start"
    );
    assert!(
        app.dispatch(
            &a,
            2,
            "read_done",
            json!({"status":"succeeded","value":{"text":"forged"}})
        )
        .is_err()
    );
    close_all(&mut app, &[a, b]);
}
#[test]
fn untrusted_metadata_or_native_plan_cannot_manufacture_resource_authority() {
    let timer = timer();
    let (mut app, root, calls) = application(false, &timer);
    assert!(
        app.dispatch(
            &root,
            0,
            "read",
            json!({"capture":{"kind":"current","owner":"forged-id"}})
        )
        .is_err()
    );
    assert_eq!(calls.get(), 0);
    assert_eq!(app.pending_action_count(), 0);
    assert_eq!(app.frame(&root).unwrap().revision, 0);
    close_all(&mut app, &[root]);
    let (input, mut packages, native, _) = fixture(false);
    let i = packages
        .iter()
        .position(|p| p.manifest().id == "dynamic.composer")
        .unwrap();
    let old = packages.remove(i);
    let source = std::str::from_utf8(old.file("index.mjs").unwrap())
        .unwrap()
        .replace(
            "return {kind:'forward',source:{child:'draft',method,input}};",
            "return {kind:'native'};",
        );
    let composer = support::package(
        "dynamic.composer",
        old.manifest()
            .application
            .as_ref()
            .unwrap()
            .declaration()
            .clone(),
        Some(source),
    );
    let mut input = input;
    input.instances.get_mut("composer").unwrap().package = composer.application_ref().into();
    packages.push(composer);
    let mut app = Application::new(
        &input,
        packages,
        timer.handle().clone(),
        maka_ui_js::execution(Default::default()),
        native,
        Default::default(),
    )
    .unwrap();
    let root = app.mount_launch(json!({})).unwrap();
    assert!(app.dispatch(&root, 0, "read", Value::Null).is_err());
    assert_eq!(app.pending_action_count(), 0);
    close_all(&mut app, &[root]);
}
#[test]
fn capture_failure_is_an_owned_not_accepted_outcome_after_scene_commit() {
    let timer = timer();
    let (mut app, root, _) = application(false, &timer);
    app.dispatch(&root, 0, "read", json!({})).unwrap();
    assert_eq!(app.frame(&root).unwrap().revision, 1);
    app.capture_actions(&root, |_| {
        Err(maka_ui_runtime::Error::Invalid("revision conflict".into()))
    })
    .unwrap();
    assert!(app.start_task(&root).unwrap().is_none());
    app.deliver_action_results(&root, |_, _, _| Ok(false))
        .unwrap();
    assert_eq!(
        app.frame(&root).unwrap().state["outcome"]["status"],
        "not_accepted"
    );
    assert!(!app.is_retiring(&root));
    close_all(&mut app, &[root]);
}
#[test]
fn source_removal_before_admission_cancels_but_accepted_snapshot_outlives_removed_subtree() {
    let timer = timer();
    for accepted_first in [false, true] {
        let (mut app, root, _) = application(false, &timer);
        app.dispatch(&root, 0, "read", Value::Null).unwrap();
        let snapshot = capture(&mut app, &root, "Start");
        let weak = Arc::downgrade(&snapshot);
        drop(snapshot);
        let accepted = if accepted_first {
            app.start_task(&root).unwrap()
        } else {
            None
        };
        app.dispatch(&root, 1, "remove", Value::Null).unwrap();
        for m in app.retiring_mounts() {
            app.close(&m, Ok(())).unwrap();
        }
        if let Some(work) = accepted {
            let done = timer.block_on(work.future);
            let maka_ui_runtime::actions::TaskCompletion::Query(ref completion) = done else {
                panic!("expected query completion")
            };
            assert_eq!(completion.result.as_ref().unwrap()["text"], "Start");
            app.finish_task(work.id, done).unwrap();
        } else {
            assert!(app.start_task(&root).unwrap().is_none());
        }
        app.deliver_action_results(&root, |_, _, _| Ok(false))
            .unwrap();
        assert_eq!(
            app.frame(&root).unwrap().state["outcome"]["status"],
            if accepted_first {
                "succeeded"
            } else {
                "not_accepted"
            }
        );
        assert!(weak.upgrade().is_none());
        close_all(&mut app, &[root]);
    }
}
#[test]
fn specific_consumer_mount_is_checked_even_when_same_provider_has_another_live_root() {
    let timer = timer();
    let (mut app, a, _) = application(false, &timer);
    let b = app.mount_launch(json!({})).unwrap();
    app.dispatch(&a, 0, "read", Value::Null).unwrap();
    capture(&mut app, &a, "Start");
    app.retire(&a).unwrap();
    assert!(app.start_task(&a).unwrap().is_none());
    assert_eq!(app.accepted_action_count(), 0);
    app.dispatch(&b, 0, "read", Value::Null).unwrap();
    capture(&mut app, &b, "Start");
    let work = app.start_task(&b).unwrap().unwrap();
    let done = timer.block_on(work.future);
    app.finish_task(work.id, done).unwrap();
    app.deliver_action_results(&b, |_, _, _| Ok(false)).unwrap();
    close_all(&mut app, &[a, b]);
}

#[test]
fn failed_or_lost_result_handlers_do_not_hold_accepted_work_or_healthy_pending_mounts() {
    let timer = timer();
    for feedback in [
        "if(event.kind==='action')throw new Error('result handler failed');",
        "if(event.kind==='action'){const out=frame(next);out.decision={preventDefault:true};return out;}",
    ] {
        let (input, mut packages, native, _) = fixture(false);
        let i = packages
            .iter()
            .position(|p| p.manifest().id == "dynamic.app")
            .unwrap();
        let old = packages.remove(i);
        let source = std::str::from_utf8(old.file("index.mjs").unwrap())
            .unwrap()
            .replace(
                "if(event.kind==='action')next.outcome=event.event;",
                feedback,
            );
        let root_pkg = support::package(
            "dynamic.app",
            old.manifest()
                .application
                .as_ref()
                .unwrap()
                .declaration()
                .clone(),
            Some(source),
        );
        let mut input = input;
        input.instances.get_mut("app").unwrap().package = root_pkg.application_ref().into();
        packages.push(root_pkg);
        let mut app = Application::new(
            &input,
            packages,
            timer.handle().clone(),
            maka_ui_js::execution(Default::default()),
            native,
            Default::default(),
        )
        .unwrap();
        let root = app.mount_launch(json!({})).unwrap();
        app.dispatch(&root, 0, "read", Value::Null).unwrap();
        capture(&mut app, &root, "Start");
        let work = app.start_task(&root).unwrap().unwrap();
        let done = timer.block_on(work.future);
        app.finish_task(work.id, done).unwrap();
        assert_eq!(app.accepted_action_count(), 0);
        assert!(
            app.deliver_action_results(&root, |_, _, _| Ok(false))
                .is_err()
        );
        assert!(app.is_retiring(&root));
        close_all(&mut app, &[root]);
    }
}

struct CompletionService {
    value: Value,
    cleanup_error: bool,
}
impl NativeService for CompletionService {
    fn call(&self, _: ServiceRequest) -> ServiceFuture {
        let value = self.value.clone();
        let failed = self.cleanup_error;
        Box::pin(async move {
            ServiceCompletion {
                result: Ok(value),
                cleanup: if failed {
                    Err("cleanup unknown".into())
                } else {
                    Ok(())
                },
            }
        })
    }
}
fn service_fixture(
    timer: &tokio::runtime::Runtime,
    value: Value,
    cleanup_error: bool,
    padding: usize,
) -> (Application, Mount) {
    let (mut input, mut packages, mut native, _) = fixture(false);
    let mut contract = maka_ui_runtime::text::reader_contract();
    let maka_plugin_core::contract::Interface::Service { methods } = &mut contract.interface else {
        unreachable!()
    };
    methods.get_mut("read").unwrap().output = json!({"type":"string"}).into();
    for name in ["dynamic.app", "native.reader"] {
        let i = packages
            .iter()
            .position(|p| p.manifest().id == name)
            .unwrap();
        let old = packages.remove(i);
        let mut declaration = old
            .manifest()
            .application
            .as_ref()
            .unwrap()
            .declaration()
            .clone();
        let entry = declaration
            .entries
            .get_mut(&maka_plugin_core::package::EntryTarget::Tui)
            .unwrap();
        let source = if name == "dynamic.app" {
            entry.imports.get_mut("reader").unwrap().contract = contract.clone();
            Some(
                std::str::from_utf8(old.file("index.mjs").unwrap())
                    .unwrap()
                    .replace(
                        "revision:0,show:true",
                        &format!("revision:0,show:true,padding:'x'.repeat({padding})"),
                    ),
            )
        } else {
            entry.exports.get_mut("Reader").unwrap().contract = contract.clone();
            entry.implementation = maka_plugin_core::package::Implementation::Native {
                implementation: "test.service".into(),
            };
            None
        };
        let package = support::package(name, declaration, source);
        input
            .instances
            .get_mut(if name == "dynamic.app" {
                "app"
            } else {
                "reader"
            })
            .unwrap()
            .package = package.application_ref().into();
        packages.push(package);
    }
    native
        .register("test.service", move |_, _values| {
            Ok(BTreeMap::from([(
                "Reader".into(),
                NativeExport {
                    contract: contract.clone(),
                    value: NativeCapability::Service(Arc::new(CompletionService {
                        value: value.clone(),
                        cleanup_error,
                    })),
                },
            )]))
        })
        .unwrap();
    let mut app = Application::new(
        &input,
        packages,
        timer.handle().clone(),
        maka_ui_js::execution(Default::default()),
        native,
        Default::default(),
    )
    .unwrap();
    let root = app.mount_launch(json!({})).unwrap();
    (app, root)
}
#[test]
fn cleanup_failure_preserves_work_and_input_until_explicit_recovery_without_replaying_outcome() {
    let timer = timer();
    let (mut app, root) = service_fixture(&timer, json!("ok"), true, 0);
    app.dispatch(&root, 0, "read", Value::Null).unwrap();
    let snapshot = capture(&mut app, &root, "Start");
    let weak = Arc::downgrade(&snapshot);
    drop(snapshot);
    let work = app.start_task(&root).unwrap().unwrap();
    let done = timer.block_on(work.future);
    assert!(app.finish_task(work.id, done).is_err());
    assert_eq!(app.accepted_action_count(), 1);
    assert!(weak.upgrade().is_some());
    assert_eq!(
        app.deliver_action_results(&root, |_, _, _| Ok(false))
            .unwrap(),
        0
    );
    assert!(
        app.is_retiring(&root),
        "cleanup failure retires service consumers"
    );
    assert!(
        app.complete_action_cleanup(work.id, Err("still unknown".into()))
            .is_err()
    );
    assert!(weak.upgrade().is_some());
    app.retire(&root).unwrap();
    for m in app.retiring_mounts() {
        app.close(&m, Ok(())).unwrap();
    }
    assert!(!app.can_shutdown());
    assert!(app.shutdown().is_err());
    app.complete_action_cleanup(work.id, Ok(())).unwrap();
    assert!(weak.upgrade().is_none());
    assert!(app.can_shutdown());
    assert_eq!(app.pending_action_count(), 0);
    app.shutdown().unwrap();
}

struct ExactFeedback;
impl NativeComponent<()> for ExactFeedback {
    fn call(
        &self,
        call: ComponentCall<'_>,
        _values: &maka_ui_runtime::abi::ValueBindings,
    ) -> maka_ui_runtime::Result<ComponentOutput<NativeView<()>>> {
        let (state, initial) = match call {
            ComponentCall::Mount { props } => {
                (json!({"revision":0,"marker":props["marker"]}), true)
            }
            ComponentCall::Event {
                state,
                input,
                origin,
                ..
            } => {
                assert!(matches!(origin, maka_ui_runtime::EventOrigin::Action));
                let mut next = state.clone();
                next["revision"] = json!(state["revision"].as_u64().unwrap() + 1);
                next["outcome"] = input.clone();
                (next, false)
            }
            ComponentCall::Update { state, .. } => {
                let mut next = state.clone();
                next["revision"] = json!(state["revision"].as_u64().unwrap() + 1);
                (next, false)
            }
        };
        // Native callbacks can use the portable tree; presentation shape does
        // not determine the actual consumer codec.
        let mut output = Frame {
            revision: state["revision"].as_u64().unwrap(),
            state,
            surface: Some(maka_ui_runtime::Surface::Terminal {
                binding: "surface".into(),
            }),
            view: crate::support::scene::view(crate::support::scene::Node::Text {
                key: "result".into(),
                text: "Result".into(),
                color: 0,
            })?,
        }
        .output(vec![]);
        if initial {
            output.actions.push(Action {
                recovery: Value::Null,
                continuations: Vec::new(),
                key: "read".into(),
                binding: "reader".into(),
                member: 0,
                method: "read".into(),
                input: Value::Null,
                resources: BTreeMap::new(),
            });
        }
        Ok(output)
    }
}

#[test]
fn actual_native_query_preserves_exact_integer_while_javascript_fails_without_retiring() {
    use maka_plugin_core::{
        composition::Target,
        contract::{
            Availability, Cardinality, Contract, Export, Import, Interface, Method, MethodMode,
            Transport,
        },
        package::{EntryTarget, Implementation},
    };
    const WIDE: u64 = 9_007_199_254_740_993;
    let timer = timer();
    for is_native in [true, false] {
        let (mut input, mut packages) = support::fixture("");
        let old = packages.pop().unwrap();
        let mut declaration = old
            .manifest()
            .application
            .as_ref()
            .unwrap()
            .declaration()
            .clone();
        let entry = declaration.entries.get_mut(&EntryTarget::Tui).unwrap();
        let component = entry.exports["App"].contract.clone();
        let contract = Contract {
            name: "test.ExactQuery".into(),
            version: 1,
            transport: Transport::Local,
            interface: Interface::Service {
                methods: BTreeMap::from([(
                    "read".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Query,
                        input: json!({"type":"null"}).into(),
                        output: json!({"type":"integer"}).into(),
                        resources: BTreeMap::new(),
                    },
                )]),
            },
        };
        entry.imports.insert(
            "reader".into(),
            Import {
                contract: contract.clone(),
                cardinality: Cardinality::One,
            },
        );
        if is_native {
            entry.scene = None;
            entry.implementation = Implementation::Native {
                implementation: "test.exact-feedback".into(),
            };
        }
        let source = format!(
            r#"
            const contract = {};
            const frame = state => ({{frame:{{revision:state.revision,state,surface:{{kind:'terminal',binding:'surface'}},view:{{kind:'text',key:'result',text:'Result',color:0}}}},events:[],actions:[]}});
            export function activate() {{ return {{App:{{contract,kind:'component',component:['app']}}}}; }}
            export const app = {{
              mount() {{ const out=frame({{revision:0}});out.actions=[{{key:'read',binding:'reader',member:0,method:'read',input:null,resources:{{}}}}];return out; }},
              update(state) {{return frame({{...state,revision:state.revision+1}});}},
              event(state,input) {{return frame({{...state,revision:state.revision+1,outcome:input.event}});}}
            }};
        "#,
            serde_json::to_string(&component).unwrap()
        );
        let root = support::package(
            "dynamic.app",
            declaration.clone(),
            (!is_native).then_some(source),
        );
        let node = input.instances.get_mut("app").unwrap();
        node.package = root.application_ref().into();
        node.bindings.insert(
            "reader".into(),
            vec![Target::Instance {
                path: vec!["reader".into()],
                export: "Reader".into(),
            }],
        );
        let entry = declaration.entries.get_mut(&EntryTarget::Tui).unwrap();
        entry.scene = None;
        entry.implementation = Implementation::Native {
            implementation: "test.exact-query".into(),
        };
        entry.imports.clear();
        entry.exports = BTreeMap::from([(
            "Reader".into(),
            Export {
                contract: contract.clone(),
                availability: Availability::Required,
            },
        )]);
        let reader = support::package("native.reader", declaration, None);
        input
            .instances
            .insert("reader".into(), support::node(&reader, 3));
        packages.extend([root, reader]);
        let mut native = crate::support::scene::registry(PresentationTarget::Tui);
        native
            .register("test.exact-feedback", move |_, _values| {
                Ok(BTreeMap::from([(
                    "App".into(),
                    NativeExport {
                        contract: component.clone(),
                        value: NativeCapability::Component(Rc::new(ExactFeedback)),
                    },
                )]))
            })
            .unwrap();
        native
            .register("test.exact-query", move |_, _values| {
                Ok(BTreeMap::from([(
                    "Reader".into(),
                    NativeExport {
                        contract: contract.clone(),
                        value: NativeCapability::Service(Arc::new(CompletionService {
                            value: json!(WIDE),
                            cleanup_error: false,
                        })),
                    },
                )]))
            })
            .unwrap();
        let mut app = Application::new(
            &input,
            packages,
            timer.handle().clone(),
            maka_ui_js::execution(Default::default()),
            native,
            Default::default(),
        )
        .unwrap();
        let mount = app
            .mount_launch(if is_native {
                json!({"marker":WIDE})
            } else {
                json!({})
            })
            .unwrap();
        app.capture_actions(&mount, |_| unreachable!("query has no resources"))
            .unwrap();
        let task = app.start_task(&mount).unwrap().unwrap();
        let completion = timer.block_on(task.future);
        assert!(app.finish_task(task.id, completion).unwrap().is_none());
        assert_eq!(
            app.deliver_action_results(&mount, |_, _, _| Ok(false))
                .unwrap(),
            1
        );
        assert!(!app.is_retiring(&mount));
        assert_eq!(app.accepted_action_count(), 0);
        let state = &app.frame(&mount).unwrap().state;
        if is_native {
            assert_eq!(state["outcome"]["status"], "succeeded");
            assert_eq!(state["outcome"]["value"].as_u64(), Some(WIDE));
            assert_eq!(state["marker"].as_u64(), Some(WIDE));
        } else {
            assert_eq!(state["outcome"]["status"], "failed");
            assert!(
                state["outcome"]["reason"]
                    .as_str()
                    .unwrap()
                    .contains("delivery failed")
            );
        }
        close_all(&mut app, &[mount]);
    }
}
type RemoteFixture = (
    Input,
    Vec<maka_packages::Package>,
    NativeRegistry<()>,
    RemoteServices,
    maka_plugin_core::plan::RemoteCapability,
);
fn remote_fixture(
    mode: maka_plugin_core::contract::MethodMode,
    cardinality: maka_plugin_core::contract::Cardinality,
    actual: bool,
) -> RemoteFixture {
    use maka_plugin_core::{
        contract::{Availability, Export, Interface, Transport},
        package::EntryTarget,
        plan::RemoteCapability,
    };
    let (mut input, mut packages, native, _) = fixture(false);
    input.instances.remove("reader");
    packages.retain(|p| p.manifest().id != "native.reader");
    let old = packages.remove(
        packages
            .iter()
            .position(|p| p.manifest().id == "dynamic.app")
            .unwrap(),
    );
    let mut contract = maka_ui_runtime::text::reader_contract();
    contract.transport = Transport::Remote;
    let Interface::Service { methods } = &mut contract.interface else {
        unreachable!()
    };
    methods.get_mut("read").unwrap().mode = mode;
    let mut declaration = old
        .manifest()
        .application
        .as_ref()
        .unwrap()
        .declaration()
        .clone();
    let import = declaration
        .entries
        .get_mut(&EntryTarget::Tui)
        .unwrap()
        .imports
        .get_mut("reader")
        .unwrap();
    import.contract = contract.clone();
    import.cardinality = cardinality;
    let package = support::package(
        "dynamic.app",
        declaration,
        Some(
            std::str::from_utf8(old.file("index.mjs").unwrap())
                .unwrap()
                .to_owned(),
        ),
    );
    let target = RemoteCapability {
        deployment: "host-a".into(),
        instance: maka_plugin_core::composition::InstanceId(vec![uuid::Uuid::from_u128(11)]),
        export: "Reader".into(),
    };
    let app = input.instances.get_mut("app").unwrap();
    app.package = package.application_ref().into();
    app.bindings.insert(
        "reader".into(),
        vec![maka_plugin_core::composition::Target::Remote {
            deployment: target.deployment.clone(),
            instance: target.instance.clone(),
            export: target.export.clone(),
        }],
    );
    packages.push(package);
    let remotes = RemoteServices {
        declarations: BTreeMap::from([(
            target.clone(),
            Export {
                contract: contract.clone(),
                availability: Availability::Required,
            },
        )]),
        registrations: if actual {
            vec![RemoteService {
                target: target.clone(),
                registration_epoch: uuid::Uuid::new_v4(),
                contract,
                implementation: Arc::new(CompletionService {
                    value: json!({"text":"Start","metadata":{}}),
                    cleanup_error: false,
                }),
            }]
        } else {
            vec![]
        },
    };
    (input, packages, native, remotes, target)
}
#[test]
fn remote_metadata_proves_compatibility_but_only_actual_endpoint_proves_readiness() {
    use maka_plugin_core::contract::{Cardinality, MethodMode};
    let timer = timer();
    let (input, packages, native, remotes, _) =
        remote_fixture(MethodMode::Query, Cardinality::One, false);
    assert!(matches!(
        Application::new(
            &input,
            packages,
            timer.handle().clone(),
            maka_ui_js::execution(Default::default()),
            native,
            remotes
        ),
        Err(maka_ui_runtime::Error::Core(
            maka_plugin_core::Error::NotReady(_)
        ))
    ));
    let (input, packages, native, remotes, _) =
        remote_fixture(MethodMode::Query, Cardinality::Optional, false);
    let mut app = Application::new(
        &input,
        packages,
        timer.handle().clone(),
        maka_ui_js::execution(Default::default()),
        native,
        remotes,
    )
    .unwrap();
    let root = app.mount_launch(json!({})).unwrap();
    close_all(&mut app, &[root]);
}
#[test]
fn remote_disconnect_retires_consumer_but_preserves_accepted_query_and_snapshot() {
    use maka_plugin_core::contract::{Cardinality, MethodMode};
    let timer = timer();
    let (input, packages, native, remotes, target) =
        remote_fixture(MethodMode::Query, Cardinality::One, true);
    let mut app = Application::new(
        &input,
        packages,
        timer.handle().clone(),
        maka_ui_js::execution(Default::default()),
        native,
        remotes,
    )
    .unwrap();
    let root = app.mount_launch(json!({})).unwrap();
    app.dispatch(&root, 0, "read", Value::Null).unwrap();
    let snapshot = capture(&mut app, &root, "Start");
    let weak = Arc::downgrade(&snapshot);
    drop(snapshot);
    let work = app.start_task(&root).unwrap().unwrap();
    let attachment = app.remote_activation(&target).unwrap();
    app.retire_remote(&attachment).unwrap();
    assert!(app.is_retiring(&root));
    assert!(app.dispatch(&root, 1, "read", Value::Null).is_err());
    for mount in app.retiring_mounts() {
        app.close(&mount, Ok(())).unwrap();
    }
    assert!(app.shutdown().is_err());
    assert!(weak.upgrade().is_some());
    let done = timer.block_on(work.future);
    let maka_ui_runtime::actions::TaskCompletion::Query(ref completion) = done else {
        panic!("expected query completion")
    };
    assert_eq!(completion.result.as_ref().unwrap()["text"], "Start");
    app.finish_task(work.id, done).unwrap();
    assert!(weak.upgrade().is_none());
    app.shutdown().unwrap();
}
#[test]
fn ui_admits_resource_mutations_and_enforces_persisted_callers_and_subscription_demand() {
    use maka_plugin_core::contract::{Cardinality, MethodMode};
    let timer = timer();
    for mode in [MethodMode::Mutation, MethodMode::Subscription] {
        let (input, packages, native, remotes, _) = remote_fixture(mode, Cardinality::One, true);
        let result = Application::new(
            &input,
            packages,
            timer.handle().clone(),
            maka_ui_js::execution(Default::default()),
            native,
            remotes,
        );
        let mut app = result.unwrap();
        let root = app.mount_launch(json!({})).unwrap();
        // A resource-capable registration still requires a persisted caller
        // for mutations and a subscription declaration for stream demand.
        let reason = app
            .dispatch(&root, 0, "read", Value::Null)
            .unwrap_err()
            .to_string();
        let expected = if mode == MethodMode::Mutation {
            "mutation requires a persisted UI source"
        } else {
            "method mode mismatch"
        };
        assert!(reason.contains(expected), "{reason}");
        assert_eq!(app.frame(&root).unwrap().revision, 0);
        assert!(!app.is_retiring(&root));
        assert_eq!(app.pending_action_count(), 0);
        close_all(&mut app, &[root]);
    }
}

#[test]
fn delayed_disconnect_token_cannot_retire_same_target_in_a_replacement_ui_kernel() {
    use maka_plugin_core::contract::{Cardinality, MethodMode};
    let timer = timer();
    let (input, packages, native, remotes, target) =
        remote_fixture(MethodMode::Query, Cardinality::One, true);
    let wire_epoch = remotes.registrations[0].registration_epoch;
    let mut old = Application::new(
        &input,
        packages,
        timer.handle().clone(),
        maka_ui_js::execution(Default::default()),
        native,
        remotes,
    )
    .unwrap();
    let old_root = old.mount_launch(json!({})).unwrap();
    let old_attachment = old.remote_activation(&target).unwrap();
    let (input, packages, native, mut remotes, _) =
        remote_fixture(MethodMode::Query, Cardinality::One, true);
    remotes.registrations[0].registration_epoch = wire_epoch;
    let mut replacement = Application::new(
        &input,
        packages,
        timer.handle().clone(),
        maka_ui_js::execution(Default::default()),
        native,
        remotes,
    )
    .unwrap();
    let root = replacement.mount_launch(json!({})).unwrap();
    assert!(replacement.retire_remote(&old_attachment).is_err());
    assert!(!replacement.is_retiring(&root));
    let actual_attachment = replacement.remote_activation(&target).unwrap();
    replacement.retire_remote(&actual_attachment).unwrap();
    assert!(replacement.is_retiring(&root));
    close_all(&mut replacement, &[root]);
    close_all(&mut old, &[old_root]);
}

fn guarded_application(timer: &tokio::runtime::Runtime) -> (Application, Mount) {
    guarded_application_with(timer, |source| source)
}
fn guarded_application_with(
    timer: &tokio::runtime::Runtime,
    change: impl FnOnce(String) -> String,
) -> (Application, Mount) {
    let (mut input, mut packages, native, _) = fixture_with_continuation(false, true);
    let index = packages
        .iter()
        .position(|p| p.manifest().id == "dynamic.app")
        .unwrap();
    let old = packages.remove(index);
    let source = change(
        std::str::from_utf8(old.file("index.mjs").unwrap())
            .unwrap()
            .to_owned(),
    );
    let package = support::package(
        "dynamic.app",
        old.manifest()
            .application
            .as_ref()
            .unwrap()
            .declaration()
            .clone(),
        Some(source),
    );
    input.instances.get_mut("app").unwrap().package = package.application_ref().into();
    packages.push(package);
    let mut app = Application::new(
        &input,
        packages,
        timer.handle().clone(),
        maka_ui_js::execution(Default::default()),
        native,
        Default::default(),
    )
    .unwrap();
    let root = app.mount_launch(json!({})).unwrap();
    (app, root)
}
fn capture_guarded(app: &mut Application, root: &Mount, bytes: usize) {
    app.capture_actions(root, |target| match target.method() {
        "snapshot" => Ok(NativeCapture::Resource(Arc::new(Text("Start".into())))),
        "reading" => Ok(NativeCapture::Continuation(ContinuationWitness::new(
            7u64, bytes,
        ))),
        _ => unreachable!(),
    })
    .unwrap();
}
fn guarded_request(app: &mut Application, root: &Mount, key: &str, bytes: usize) -> ActionTask {
    let revision = app.frame(root).unwrap().revision;
    app.dispatch(root, revision, "read", json!({"key":key}))
        .unwrap();
    capture_guarded(app, root, bytes);
    app.start_task(root).unwrap().unwrap()
}
#[test]
fn continuation_checks_precede_publication_and_preserve_business_completion() {
    let timer = timer();
    let (mut app, root) = guarded_application(&timer);
    let original = app.child_mount(&root, "editor").unwrap().clone();
    let task = guarded_request(&mut app, &root, "read_done", 8);
    let done = timer.block_on(task.future);
    let TaskCompletion::Query(ref completion) = done else {
        panic!("query")
    };
    assert_eq!(completion.result.as_ref().unwrap()["text"], "Start");
    app.finish_task(task.id, done).unwrap();
    assert_eq!(app.accepted_action_count(), 0);
    assert!(app.frame(&root).unwrap().state.get("outcome").is_none());
    let checked = Cell::new(0);
    assert_eq!(
        app.deliver_action_results(&root, |target, _, witness| {
            assert_eq!(target.method(), "reading");
            assert_eq!(witness.downcast_ref::<u64>(), Some(&7));
            checked.set(checked.get() + 1);
            Ok(false)
        })
        .unwrap(),
        1
    );
    assert_eq!(checked.get(), 1);
    assert_eq!(
        app.frame(&root).unwrap().state["outcome"]["status"],
        "stale"
    );
    assert_eq!(app.child_mount(&root, "editor").unwrap(), &original);
    assert!(!app.is_retiring(&root));
    close_all(&mut app, &[root]);
}
#[test]
fn action_keys_correlate_out_of_order_stale_feedback_and_remain_reserved_until_delivery() {
    let timer = timer();
    let (mut app, root) = guarded_application(&timer);
    let a = guarded_request(&mut app, &root, "A", 8);
    for _ in 0..2 {
        let revision = app.frame(&root).unwrap().revision;
        assert!(
            app.dispatch(&root, revision, "read", json!({"key":"A"}))
                .is_err()
        );
        assert_eq!(app.frame(&root).unwrap().revision, revision);
        assert!(!app.is_retiring(&root));
    }
    let b = guarded_request(&mut app, &root, "B", 8);
    app.finish_task(b.id, timer.block_on(b.future)).unwrap();
    let revision = app.frame(&root).unwrap().revision;
    assert!(
        app.dispatch(&root, revision, "read", json!({"key":"B"}))
            .is_err()
    );
    app.deliver_action_results(&root, |_, _, _| Ok(true))
        .unwrap();
    app.finish_task(a.id, timer.block_on(a.future)).unwrap();
    app.deliver_action_results(&root, |_, _, _| Ok(false))
        .unwrap();
    let results = &app.frame(&root).unwrap().state["results"];
    assert_eq!(results[0]["key"], "B");
    assert_eq!(results[0]["outcome"]["status"], "succeeded");
    assert_eq!(results[1]["key"], "A");
    assert_eq!(results[1]["outcome"]["status"], "stale");
    let next = guarded_request(&mut app, &root, "A", 8);
    app.finish_task(next.id, timer.block_on(next.future))
        .unwrap();
    app.deliver_action_results(&root, |_, _, _| Ok(true))
        .unwrap();
    close_all(&mut app, &[root]);
}
#[test]
fn original_continuation_edges_cannot_revive_after_source_replacement() {
    let timer = timer();
    for completed_first in [false, true] {
        let (mut app, root) = guarded_application(&timer);
        let original = app.child_mount(&root, "editor").unwrap().clone();
        let task = guarded_request(&mut app, &root, "read_done", 8);
        let mut done = Some(timer.block_on(task.future));
        if completed_first {
            app.finish_task(task.id, done.take().unwrap()).unwrap();
        }
        let revision = app.frame(&root).unwrap().revision;
        app.dispatch(&root, revision, "remove", Value::Null)
            .unwrap();
        app.dispatch(&root, revision + 1, "restore", Value::Null)
            .unwrap();
        assert_ne!(app.child_mount(&root, "editor").unwrap(), &original);
        if !completed_first {
            app.finish_task(task.id, done.take().unwrap()).unwrap();
        }
        app.deliver_action_results(&root, |_, _, _| {
            panic!("broken original edge cannot reach native validation")
        })
        .unwrap();
        assert_eq!(
            app.frame(&root).unwrap().state["outcome"]["status"],
            "stale"
        );
        assert!(!app.is_retiring(&root));
        close_all(&mut app, &[root]);
    }
}
#[test]
fn stale_continuation_does_not_confirm_failed_executor_cleanup_or_revive_consumer() {
    let timer = timer();
    let (mut app, root) = guarded_application(&timer);
    let task = guarded_request(&mut app, &root, "read_done", 8);
    let TaskCompletion::Query(mut done) = timer.block_on(task.future) else {
        panic!("query")
    };
    assert_eq!(done.result.as_ref().unwrap()["text"], "Start");
    done.cleanup = Err("actual executor close failed".into());
    assert!(
        app.finish_task(task.id, TaskCompletion::Query(done))
            .is_err()
    );
    assert_eq!(app.failed_action_ids(), vec![task.id]);
    assert!(app.is_retiring(&root));
    assert_eq!(
        app.deliver_action_results(&root, |_, _, _| panic!("retired consumer is not admitted"))
            .unwrap(),
        0
    );
    assert_eq!(app.failed_action_ids(), vec![task.id]);
    assert_eq!(app.accepted_action_count(), 1);
    app.complete_action_cleanup(task.id, Ok(())).unwrap();
    assert_eq!(app.accepted_action_count(), 0);
    close_all(&mut app, &[root]);
}

#[test]
fn completed_undelivered_witnesses_count_toward_the_same_capture_budget() {
    let timer = timer();
    let (mut app, root) = guarded_application(&timer);
    let task = guarded_request(&mut app, &root, "A", 32 * 1024 * 1024);
    app.finish_task(task.id, timer.block_on(task.future))
        .unwrap();
    let revision = app.frame(&root).unwrap().revision;
    app.dispatch(&root, revision, "read", json!({"key":"B"}))
        .unwrap();
    app.capture_actions(&root, |target| match target.method() {
        "snapshot" => Ok(NativeCapture::Resource(Arc::new(Text("Start".into())))),
        "reading" => Ok(NativeCapture::Continuation(ContinuationWitness::new(
            7u64,
            32 * 1024 * 1024,
        ))),
        _ => unreachable!(),
    })
    .unwrap();
    assert!(app.start_task(&root).unwrap().is_none());
    app.deliver_action_results(&root, |_, _, _| Ok(true))
        .unwrap();
    let results = &app.frame(&root).unwrap().state["results"];
    assert_eq!(results[0]["outcome"]["status"], "succeeded");
    assert_eq!(results[1]["outcome"]["status"], "not_accepted");
    assert!(
        results[1]["outcome"]["reason"]
            .as_str()
            .unwrap()
            .contains("resource window is busy")
    );
    let next = guarded_request(&mut app, &root, "B", 32 * 1024 * 1024);
    app.finish_task(next.id, timer.block_on(next.future))
        .unwrap();
    app.deliver_action_results(&root, |_, _, _| Ok(true))
        .unwrap();
    close_all(&mut app, &[root]);
}

#[test]
fn query_recovery_metadata_is_rejected_before_publication_or_capture() {
    let timer = timer();
    let (mut app, root) = guarded_application_with(&timer, |source| {
        source.replace(
            "return out;",
            "out.actions[0].recovery={format:'draft@1'};return out;",
        )
    });
    let before = app.frame(&root).unwrap().revision;
    assert!(
        app.dispatch(&root, before, "read", Value::Null)
            .unwrap_err()
            .to_string()
            .contains("recovery metadata requires a mutation")
    );
    assert_eq!(app.frame(&root).unwrap().revision, before);
    assert_eq!(app.pending_action_count(), 0);
    app.capture_actions(&root, |_| {
        panic!("rejected metadata cannot start a capture")
    })
    .unwrap();
    assert!(!app.is_retiring(&root));
    close_all(&mut app, &[root]);
}
#[test]
fn duplicate_action_keys_in_one_callback_do_not_publish_or_start_capture() {
    let timer = timer();
    let (mut app, root) = guarded_application_with(&timer, |source| {
        source.replace(
            "return out;",
            "out.actions.push({...out.actions[0]});return out;",
        )
    });
    let before = app.frame(&root).unwrap().revision;
    assert!(
        app.dispatch(&root, before, "read", Value::Null)
            .unwrap_err()
            .to_string()
            .contains("feedback key already in use")
    );
    assert_eq!(app.frame(&root).unwrap().revision, before);
    assert_eq!(app.pending_action_count(), 0);
    app.capture_actions(&root, |_| panic!("no capture admitted"))
        .unwrap();
    assert!(!app.is_retiring(&root));
    close_all(&mut app, &[root]);
}
#[test]
fn feedback_can_atomically_reissue_its_original_key() {
    let timer = timer();
    let (mut app, root) = guarded_application_with(&timer, |source| {
        source.replace("if(event.kind==='action'){", "if(event.kind==='action'&&!state.reissued){next.reissued=true;const out=frame(next);out.actions.push({key:event.key,binding:'reader',member:0,method:'read',input:{start:0,end:5},resources:{text:{child:'editor',method:'snapshot',input:{kind:'current'}}},continuations:[{child:'editor',method:'reading',input:null}]});return out;}if(event.kind==='action'){")
    });
    let task = guarded_request(&mut app, &root, "same_key", 8);
    app.finish_task(task.id, timer.block_on(task.future))
        .unwrap();
    assert_eq!(
        app.deliver_action_results(&root, |_, _, _| Ok(true))
            .unwrap(),
        1
    );
    assert_eq!(app.pending_action_count(), 1);
    assert_eq!(app.frame(&root).unwrap().state["reissued"], true);
    capture_guarded(&mut app, &root, 8);
    let next = app.start_task(&root).unwrap().unwrap();
    assert_ne!(task.id, next.id);
    app.finish_task(next.id, timer.block_on(next.future))
        .unwrap();
    assert_eq!(
        app.deliver_action_results(&root, |_, _, _| Ok(true))
            .unwrap(),
        1
    );
    assert_eq!(
        app.frame(&root).unwrap().state["results"][0]["key"],
        "same_key"
    );
    assert_eq!(app.pending_action_count(), 0);
    close_all(&mut app, &[root]);
}

struct RecordingSource {
    sources: Arc<std::sync::Mutex<Vec<maka_plugin_core::deployment::DeploymentRef>>>,
}
impl NativeService for RecordingSource {
    fn call(&self, request: ServiceRequest) -> ServiceFuture {
        self.sources.lock().unwrap().push(
            request
                .source
                .deployment()
                .expect("actual owned UI source")
                .clone(),
        );
        Box::pin(async {
            ServiceCompletion {
                result: Ok(json!({"text":"Start","metadata":{}})),
                cleanup: Ok(()),
            }
        })
    }
}

#[test]
fn live_remote_epoch_update_preserves_original_query_source_and_waits_for_accepted_work() {
    use maka_event_log::{
        RootStore,
        root::{RootNamespaces, RootOwner},
    };
    use maka_plugin_core::{
        contract::{Cardinality, MethodMode},
        deployment::RemoteObservation,
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
    let (input, packages, native, mut remotes, target) =
        remote_fixture(MethodMode::Query, Cardinality::One, true);
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let service: Arc<dyn NativeService> = Arc::new(RecordingSource {
        sources: seen.clone(),
    });
    let wire = remotes.registrations[0].registration_epoch;
    let contract = remotes.registrations[0].contract.clone();
    remotes.registrations[0].implementation = service.clone();
    let observations = remotes
        .declarations
        .into_iter()
        .map(|(capability, declaration)| RemoteObservation {
            capability,
            declaration,
        })
        .collect::<Vec<_>>();
    let deployment = uuid::Uuid::new_v4();
    let original = timer
        .block_on(store.commit_application(
            deployment,
            0,
            input.clone(),
            observations.clone(),
            packages.clone(),
        ))
        .unwrap();
    let mut app = timer
        .block_on(Application::start_from_store(
            store.clone(),
            original.clone(),
            PresentationTarget::Tui,
            timer.handle().clone(),
            maka_ui_js::execution(Default::default()),
            native,
            remotes.registrations,
        ))
        .unwrap();
    let root = app.mount_launch(json!({})).unwrap();
    let registration = |epoch| RemoteService {
        target: target.clone(),
        registration_epoch: epoch,
        contract: contract.clone(),
        implementation: service.clone(),
    };
    app.dispatch(&root, 0, "read", Value::Null).unwrap();
    let snapshot = capture(&mut app, &root, "Start");
    let mut desired = input.clone();
    let mut extra = desired.instances["surface"].clone();
    extra.key = uuid::Uuid::from_u128(19);
    desired.instances.insert("extra".into(), extra);
    let next = timer
        .block_on(store.commit_application(
            deployment,
            1,
            desired.clone(),
            observations.clone(),
            packages.clone(),
        ))
        .unwrap();
    timer
        .block_on(app.adopt_committed(next.clone(), vec![registration(wire)]))
        .unwrap();
    app.advance_deployment().unwrap();
    assert!(!app.is_retiring(&root));
    let task = app.start_task(&root).unwrap().unwrap();
    let done = timer.block_on(task.future);
    app.finish_task(task.id, done).unwrap();
    app.deliver_action_results(&root, |_, _, _| Ok(false))
        .unwrap();
    assert_eq!(*seen.lock().unwrap(), vec![original.clone()]);
    let rev = app.frame(&root).unwrap().revision;
    app.dispatch(&root, rev, "read", Value::Null).unwrap();
    let held = capture(&mut app, &root, "Start");
    let old_task = app.start_task(&root).unwrap().unwrap();
    let attachment = app.remote_activation(&target).unwrap();
    let latest = timer
        .block_on(store.commit_application(deployment, 2, desired, observations, packages))
        .unwrap();
    let new_wire = uuid::Uuid::new_v4();
    timer
        .block_on(app.adopt_committed(latest.clone(), vec![registration(new_wire)]))
        .unwrap();
    app.advance_deployment().unwrap();
    assert!(app.is_retiring(&root));
    assert_eq!(app.remote_activation(&target).unwrap(), attachment);
    for mount in app.retiring_mounts() {
        app.close(&mount, Ok(())).unwrap();
    }
    app.advance_deployment().unwrap();
    assert_eq!(app.remote_activation(&target).unwrap(), attachment);
    assert!(app.deployment_status().converging);
    let done = timer.block_on(old_task.future);
    app.finish_task(old_task.id, done).unwrap();
    assert_eq!(*seen.lock().unwrap(), vec![original.clone(), original]);
    app.advance_deployment().unwrap();
    assert_eq!(app.deployment_status().effective, Some(latest.clone()));
    assert_ne!(app.remote_activation(&target).unwrap(), attachment);
    let fresh = app.mount_launch(json!({})).unwrap();
    app.dispatch(&fresh, 0, "read", Value::Null).unwrap();
    let new_snapshot = capture(&mut app, &fresh, "Start");
    let task = app.start_task(&fresh).unwrap().unwrap();
    let done = timer.block_on(task.future);
    app.finish_task(task.id, done).unwrap();
    assert_eq!(seen.lock().unwrap().last(), Some(&latest));
    close_all(&mut app, &[fresh]);
    drop((app, snapshot, held, new_snapshot, service));
    timer
        .block_on(Arc::try_unwrap(store).ok().unwrap().close())
        .unwrap();
}

#[test]
fn complete_oversized_action_holds_resource_window_until_original_settlement() {
    let timer = timer();
    let (mut app, first, _) = application(false, &timer);
    let competing = app.mount_launch(json!({})).unwrap();
    let after_release = app.mount_launch(json!({})).unwrap();
    app.dispatch(&first, 0, "read", Value::Null).unwrap();
    let snapshot: Arc<dyn ReadResource> =
        Arc::new(Text(format!("Start{}", "x".repeat(64 * 1024 * 1024))));
    let weak = Arc::downgrade(&snapshot);
    let captured = app
        .capture_actions(&first, |_| Ok(NativeCapture::Resource(snapshot.clone())))
        .unwrap();
    drop(snapshot);
    let work = app.start_task(&first).unwrap();
    app.dispatch(&competing, 0, "read", Value::Null).unwrap();
    let competing_captured = app
        .capture_actions(&competing, |_| {
            Ok(NativeCapture::Resource(Arc::new(Text("Start".into()))))
        })
        .unwrap();
    let competing_rejected = app.start_task(&competing).unwrap().is_none();
    app.deliver_action_results(&competing, |_, _, _| Ok(false))
        .unwrap();
    let competing_status = app.frame(&competing).unwrap().state["outcome"]["status"].clone();
    let retained_before_settlement = weak.upgrade().is_some();
    let completed = if let Some(work) = work {
        let done = timer.block_on(work.future);
        let succeeded = matches!(&done, TaskCompletion::Query(completion) if completion.result.as_ref().is_ok_and(|value| value["text"] == "Start"));
        app.finish_task(work.id, done).unwrap();
        succeeded
    } else {
        false
    };
    app.deliver_action_results(&first, |_, _, _| Ok(false))
        .unwrap();
    let released = weak.upgrade().is_none();
    app.dispatch(&after_release, 0, "read", Value::Null)
        .unwrap();
    let recaptured = app
        .capture_actions(&after_release, |_| {
            Ok(NativeCapture::Resource(Arc::new(Text("Start".into()))))
        })
        .unwrap();
    let work = app.start_task(&after_release).unwrap();
    let read_after_release = if let Some(work) = work {
        let done = timer.block_on(work.future);
        let succeeded = matches!(&done, TaskCompletion::Query(completion) if completion.result.as_ref().is_ok_and(|value| value["text"] == "Start"));
        app.finish_task(work.id, done).unwrap();
        succeeded
    } else {
        false
    };
    app.deliver_action_results(&after_release, |_, _, _| Ok(false))
        .unwrap();
    close_all(&mut app, &[first, competing, after_release]);
    assert_eq!(
        captured, 1,
        "one complete oversized native resource must be admitted"
    );
    assert!(
        retained_before_settlement && completed,
        "the original query must retain and read its admitted resource"
    );
    assert_eq!(competing_captured, 0);
    assert!(competing_rejected);
    assert_eq!(competing_status, "not_accepted");
    assert!(
        released,
        "original resource must release after acknowledged settlement"
    );
    assert_eq!(recaptured, 1);
    assert!(read_after_release);
}

#[test]
fn one_complete_component_frame_keeps_seventeen_original_action_keys_and_sources() {
    use std::panic::{AssertUnwindSafe, catch_unwind};
    let timer = timer();
    let (mut input, mut packages, native, _) = fixture(false);
    let index = packages
        .iter()
        .position(|package| package.manifest().id == "dynamic.app")
        .unwrap();
    let original = packages.remove(index);
    let old = "out.actions.push({key:'read_done',binding:'reader',member:0,method:'read',input:{start:event.event?.start??0,end:event.event?.end??5},resources:{text:{child:'editor',method:'snapshot',input:event.event?.capture??{kind:'current'}}}});return out;";
    let source = std::str::from_utf8(original.file("index.mjs").unwrap()).unwrap();
    assert!(source.contains(old));
    let source = source.replace(old, "for(let index=0;index<17;index++)out.actions.push({key:'read_done_'+index,binding:'reader',member:0,method:'read',input:{start:index,end:index+1},resources:{text:{child:'editor',method:'snapshot',input:{kind:'current'}}}});return out;")
        .replace("if(event.kind==='action')next.outcome=event.event;", "if(event.kind==='action')next.results=[...(state.results??[]),{key:event.key,outcome:event.event}];");
    let package = support::package(
        "dynamic.app",
        original
            .manifest()
            .application
            .as_ref()
            .unwrap()
            .declaration()
            .clone(),
        Some(source),
    );
    input.instances.get_mut("app").unwrap().package = package.application_ref().into();
    packages.push(package);
    let mut app = Application::new(
        &input,
        packages,
        timer.handle().clone(),
        maka_ui_js::execution(Default::default()),
        native,
        Default::default(),
    )
    .unwrap();
    let root = app.mount_launch(json!({})).unwrap();
    let completed = catch_unwind(AssertUnwindSafe(|| -> Result<(), String> {
        app.dispatch(&root, 0, "read", Value::Null)
            .map_err(|error| error.to_string())?;
        let text = "ABCDEFGHIJKLMNOPQ";
        let snapshot: Arc<dyn ReadResource> = Arc::new(Text(text.into()));
        let weak = Arc::downgrade(&snapshot);
        let captured = app
            .capture_actions(&root, |target| {
                assert_eq!(target.method(), "snapshot");
                Ok(NativeCapture::Resource(snapshot.clone()))
            })
            .map_err(|error| error.to_string())?;
        drop(snapshot);
        assert_eq!(captured, 17);
        let mut completed = 0;
        while let Some(task) = app.start_task(&root).map_err(|error| error.to_string())? {
            let completion = timer.block_on(task.future);
            app.finish_task(task.id, completion)
                .map_err(|error| error.to_string())?;
            completed += 1;
        }
        assert_eq!(completed, 17);
        app.deliver_action_results(&root, |_, _, _| Ok(false))
            .map_err(|error| error.to_string())?;
        let expected: Vec<_> = text.chars().enumerate().map(|(index, character)| json!({"key":format!("read_done_{index}"),"outcome":{"status":"succeeded","value":{"text":character.to_string(),"metadata":{"revision":3,"bytes":17}}}})).collect();
        assert_eq!(app.frame(&root).unwrap().state["results"], json!(expected));
        assert!(
            weak.upgrade().is_none(),
            "all original resource custody must release after settlement"
        );
        assert_eq!(app.accepted_action_count(), 0);
        Ok(())
    }));
    close_all(&mut app, &[root]);
    let result = completed.unwrap_or_else(|panic| std::panic::resume_unwind(panic));
    assert!(
        result.is_ok(),
        "complete original component action frame failed: {}",
        result.err().unwrap_or_default()
    );
}
