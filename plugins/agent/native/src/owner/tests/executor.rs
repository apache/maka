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
use maka_agent_api::executor;
use maka_host_runtime::application::{Context, Handler, HandlerResult, HandlerValue, NativeOwner};
use maka_plugin_core::runtime::Published;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone, Copy)]
pub(super) enum Behavior {
    Unsettled,
    Streaming,
    Attachments,
    InvalidSuccess,
    Protocol,
    SetupProtocol,
}
pub(super) struct Probe {
    behavior: Behavior,
    calls: AtomicUsize,
    pub(super) entered: Arc<Semaphore>,
    cancelled: Arc<Semaphore>,
    pub(super) release: Arc<Semaphore>,
    pub(super) contexts: Arc<StdMutex<std::collections::VecDeque<Arc<Context>>>>,
    pub(super) services: std::sync::OnceLock<maka_host_runtime::application::NativeServices>,
    tasks: Arc<StdMutex<BTreeMap<maka_agent_facts::durable::ExternalTaskId, ProbeTask>>>,
}
struct ProbeTask {
    outputs: Vec<executor::IndexedOutput>,
    state: executor::TaskState,
    changes: tokio::sync::watch::Sender<()>,
}
impl Probe {
    pub(super) fn new(behavior: Behavior) -> Arc<Self> {
        Arc::new(Self {
            behavior,
            calls: AtomicUsize::new(0),
            entered: Arc::new(Semaphore::new(0)),
            cancelled: Arc::new(Semaphore::new(0)),
            release: Arc::new(Semaphore::new(0)),
            contexts: Arc::default(),
            services: std::sync::OnceLock::new(),
            tasks: Arc::default(),
        })
    }
}
impl Handler for Probe {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        let tasks = self.tasks.clone();
        let context = Arc::new(context);
        if method == "setup" {
            assert!(matches!(self.behavior, Behavior::SetupProtocol));
            let contexts = self.contexts.clone();
            let entered = self.entered.clone();
            let release = self.release.clone();
            return Box::pin(async move {
                let actual = context
                    .native_context::<maka_agent_authority::setup::ActualSetupContext>()
                    .expect("actual selected setup provider context");
                actual
                    .0
                    .bind_original(&context)
                    .await
                    .map_err(|error| error.to_string())?;
                contexts.lock().unwrap().push_back(context);
                entered.add_permits(1);
                release.acquire().await.unwrap().forget();
                Ok(HandlerValue::Json(
                    json!({"kind":"checked","info":null,"methods":[]}),
                ))
            });
        }
        if method == "observe" {
            return Box::pin(async move {
                let input: executor::Observe = serde_json::from_value(input).unwrap();
                let mut after = input.after_index;
                loop {
                    let (observation, changes) = {
                        let tasks = tasks.lock().unwrap();
                        match tasks.get(&input.task_id) {
                            None => (executor::TaskObservation::Missing, None),
                            Some(task) => {
                                let start = after.map(|after| usize::try_from(after).unwrap());
                                assert!(start.is_none_or(|start| start <= task.outputs.len()));
                                let end = start.map_or(0, |start| {
                                    start.saturating_add(256).min(task.outputs.len())
                                });
                                (
                                    executor::TaskObservation::Found {
                                        task_id: input.task_id,
                                        observed: end as u64,
                                        has_more: start.is_some() && end < task.outputs.len(),
                                        outputs: task.outputs[start.unwrap_or(0)..end].to_vec(),
                                        state: task.state.clone(),
                                        cleanup: if matches!(
                                            &task.state,
                                            executor::TaskState::Closed { .. }
                                        ) {
                                            maka_plugin_core::operation::OperationCleanup::Confirmed
                                        } else {
                                            maka_plugin_core::operation::OperationCleanup::Unconfirmed
                                        },
                                    },
                                    Some(task.changes.subscribe()),
                                )
                            }
                        }
                    };
                    let (has_more, terminal) = match &observation {
                        executor::TaskObservation::Missing => (false, true),
                        executor::TaskObservation::Found {
                            observed,
                            has_more,
                            state,
                            ..
                        } => {
                            if after.is_some() {
                                after = Some(*observed);
                            }
                            (*has_more, !matches!(state, executor::TaskState::Running))
                        }
                    };
                    context
                        .emit(serde_json::to_value(observation).unwrap())
                        .await?;
                    if has_more {
                        continue;
                    }
                    if terminal {
                        return Ok(HandlerValue::Json(Value::Null));
                    }
                    let mut changes =
                        changes.expect("original running fixture task has its own notice");
                    tokio::select! {
                        () = context.scope().cancellation.cancelled() => return Ok(HandlerValue::Json(Value::Null)),
                        changed = changes.changed() => changed.expect("original fixture producer remains owned"),
                    }
                }
            });
        }
        assert_eq!(method, "execute");
        assert!(context.operation().is_some());
        let execution = context
            .scope()
            .identity
            .agent()
            .expect("native Agent identity required");
        assert_eq!(input["execution"], serde_json::to_value(execution).unwrap());
        let request: executor::Execute = serde_json::from_value(input.clone()).unwrap();
        let task_id = request.task_id;
        let authority = context
            .native_context::<maka_agent_authority::executor::ExecutorCallContext>()
            .expect("selected executor requires its real native call context");
        assert_eq!(authority.0.task_id(), task_id);
        assert_eq!(authority.0.execution(), execution);
        if let Some(task) = tasks.lock().unwrap().get(&task_id) {
            let outcome = match &task.state {
                executor::TaskState::Closed { outcome } => {
                    Ok(HandlerValue::Json(serde_json::to_value(outcome).unwrap()))
                }
                _ => Err(maka_host_runtime::application::HandlerError::Unknown {
                    diagnostic: "original fixture task is still running".into(),
                }),
            };
            return Box::pin(async move { outcome });
        }
        tasks.lock().unwrap().insert(
            task_id,
            ProbeTask {
                outputs: vec![],
                state: executor::TaskState::Running,
                changes: tokio::sync::watch::channel(()).0,
            },
        );
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let (behavior, entered, cancelled, release) = (
            self.behavior,
            self.entered.clone(),
            self.cancelled.clone(),
            self.release.clone(),
        );
        let contexts = self.contexts.clone();
        Box::pin(async move {
            authority
                .0
                .validate(&context)
                .await
                .map_err(|e| e.to_string())?;
            let emit = |value: Value| {
                let tasks = tasks.clone();
                let context = context.clone();
                async move {
                    let indexed = {
                        let mut tasks = tasks.lock().unwrap();
                        let task = tasks.get_mut(&task_id).unwrap();
                        let output = executor::IndexedOutput {
                            index: task.outputs.len() as u64,
                            output: serde_json::from_value(value).unwrap(),
                        };
                        task.outputs.push(output.clone());
                        task.changes.send_replace(());
                        output
                    };
                    context.emit(serde_json::to_value(indexed).unwrap()).await
                }
            };
            if matches!(behavior, Behavior::Protocol) {
                contexts.lock().unwrap().push_back(context.clone());
            }
            entered.add_permits(1);
            let result: Result<Value, String> = async {

            let answer = match behavior {
                Behavior::Streaming => {
                    emit(json!({"type":"message_start","messageId":"commentary"}))
                        .await?;
                    emit(json!({"type":"thinking_delta","messageId":"commentary","text":"checking"}))
                        .await?;
                    for index in 0..35 {
                        emit(json!({"type":"output_delta","messageId":"commentary","text":format!("part {index}\n")}))
                            .await?;
                    }
                    tokio::select! {
                        permit=release.acquire() => permit.unwrap().forget(),
                        ()=context.scope().cancellation.cancelled() => return Ok(json!({"status":"cancelled","reason":"stopped"})),
                    }
                    emit(json!({"type":"message_end","messageId":"commentary"}))
                        .await?;
                    input["message"].clone()
                }

                Behavior::Attachments => {
                    assert_eq!(context.attachments().len(), 1);
                    let resource = context.attachments().get("attachments").unwrap();
                    assert_eq!(
                        resource.resource_type(),
                        maka_plugin_core::contract::binary_resource_type()
                    );
                    let manifest: Vec<executor::AttachmentMetadata> =
                        serde_json::from_value(resource.metadata()).unwrap();
                    let mut files = Vec::new();
                    let mut offset = 0usize;
                    for metadata in manifest {
                        let len = usize::try_from(metadata.bytes).unwrap();
                        let end = offset.checked_add(len).unwrap();
                        assert!(end <= resource.bytes());
                        let mut bytes = Vec::new();
                        for start in (offset..end).step_by(64 * 1024) {
                            let chunk_end = start.saturating_add(64 * 1024).min(end);
                            let chunk = resource.read(start..chunk_end)?;
                            assert_eq!(chunk.len(), chunk_end - start);
                            bytes.extend(chunk);
                        }
                        assert_eq!(bytes.len(), len);
                        assert_eq!(
                            metadata.digest,
                            maka_agent_facts::artifact::content_digest(&bytes)
                        );
                        files.push(json!({"metadata":metadata,"preview":String::from_utf8(bytes[..bytes.len().min(80)].to_vec()).unwrap()}));
                        offset = end;
                    }
                    assert_eq!(
                        offset,
                        resource.bytes(),
                        "manifest must cover the entire original bundle"
                    );
                    json!(serde_json::to_string(&files).unwrap())
                }
                Behavior::Protocol => {
                    release.acquire().await.unwrap().forget();
                    input["message"].clone()
                }
                Behavior::Unsettled => {
                    context.scope().cancellation.cancelled().await;
                    cancelled.add_permits(1);
                    release.acquire().await.unwrap().forget();
                    return Ok(json!({"status":"completed","message_id":null}));
                }
                Behavior::SetupProtocol=>return Err("Setup fixture cannot execute an Agent task".into()),
                Behavior::InvalidSuccess => {
                    emit(json!({"type":"message_start","messageId":"partial"}))
                        .await?;
                    emit(json!({"type":"output_delta","messageId":"partial","text":"partial answer"})).await?;
                    let message_id = if call == 0 { None } else { Some("unknown") };
                    return Ok(json!({"status":"completed","message_id":message_id}));
                }
            };
            for output in [
                json!({"type":"message_start","messageId":"answer"}),
                json!({"type":"output_delta","messageId":"answer","text":answer}),
                json!({"type":"message_end","messageId":"answer"}),
            ] {
                emit(output).await?;
            }
            Ok(json!({"status":"completed","message_id":"answer"}))
            }.await;
            match result {
                Ok(value) => {
                    let mut tasks = tasks.lock().unwrap();
                    let task = tasks.get_mut(&task_id).unwrap();
                    task.state = executor::TaskState::Closed {
                        outcome: serde_json::from_value(value.clone()).unwrap(),
                    };
                    task.changes.send_replace(());
                    Ok(HandlerValue::Json(value))
                }
                Err(diagnostic) => {
                    let mut tasks = tasks.lock().unwrap();
                    let task = tasks.get_mut(&task_id).unwrap();
                    task.state = executor::TaskState::Unknown {
                        diagnostic: diagnostic.clone(),
                    };
                    task.changes.send_replace(());
                    Err(maka_host_runtime::application::HandlerError::Unknown { diagnostic })
                }
            }
        })
    }
}
impl NativeOwner for Probe {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
async fn activate(fixture: &mut Fixture, install: bool, probe: Option<Arc<Probe>>, granted: bool) {
    activate_backend(fixture, install, probe, granted, None, &[]).await;
}
pub(super) async fn activate_backend(
    fixture: &mut Fixture,
    install: bool,
    probe: Option<Arc<Probe>>,
    granted: bool,
    acp: Option<maka_agent_api::acp::Configuration>,
    denied: &[&str],
) {
    let setup_probe = probe
        .as_ref()
        .is_some_and(|probe| matches!(probe.behavior, Behavior::SetupProtocol));
    let with_setup = acp.is_some() || setup_probe;
    let with_protocol = with_setup
        || probe
            .as_ref()
            .is_some_and(|probe| matches!(probe.behavior, Behavior::Protocol));
    let publication_method = "publishChange";
    let with_publication =
        with_protocol && acp.is_some() && granted && !denied.contains(&publication_method);
    let source = fixture.app.source().unwrap().clone();
    fixture.app.shutdown().await.unwrap();
    if install {
        let mut settings = fixture.owner.settings.clone();
        settings.executors = vec![executor::ServiceExecutor {
            name: "external".into(),
            import: "executor".into(),
            member: 0,
            setup: with_setup.then(|| executor::setup::Binding {
                import: "setup".into(),
                member: 0,
            }),
        }];
        let (mut input, mut packages) = input(&settings);
        let mut manifest = packages[0].manifest().clone();
        let mut manifest_application = manifest.application.as_ref().unwrap().declaration().clone();
        manifest_application.host.as_mut().unwrap().imports.insert(
            "executor".into(),
            Import {
                contract: executor::contract(),
                cardinality: Cardinality::One,
            },
        );
        if with_publication {
            manifest_application.host.as_mut().unwrap().imports.insert(
                "files".into(),
                Import {
                    contract: maka_workspace_api::files::contract(),
                    cardinality: Cardinality::One,
                },
            );
        }
        let provider = Package::new(BTreeMap::from([(MANIFEST_FILE.into(), {
            manifest.application = Some(
                maka_plugin_core::package::CheckedDeclaration::new(manifest_application).unwrap(),
            );
            serde_json::to_vec(&manifest).unwrap()
        })]))
        .unwrap();
        input.instances.get_mut("provider").unwrap().package = provider.application_ref().into();
        input
            .instances
            .get_mut("provider")
            .unwrap()
            .bindings
            .insert(
                "executor".into(),
                vec![Target::Instance {
                    path: vec!["executor".into()],
                    export: "executor".into(),
                }],
            );
        if with_publication {
            input
                .instances
                .get_mut("provider")
                .unwrap()
                .bindings
                .insert(
                    "files".into(),
                    vec![Target::Instance {
                        path: vec!["files".into()],
                        export: "files".into(),
                    }],
                );
        }
        let provider = if with_setup {
            let mut manifest = provider.manifest().clone();
            let mut manifest_application =
                manifest.application.as_ref().unwrap().declaration().clone();
            manifest_application.host.as_mut().unwrap().imports.insert(
                "setup".into(),
                Import {
                    contract: executor::setup::contract(),
                    cardinality: Cardinality::One,
                },
            );
            let provider = Package::new(BTreeMap::from([(MANIFEST_FILE.into(), {
                manifest.application = Some(
                    maka_plugin_core::package::CheckedDeclaration::new(manifest_application)
                        .unwrap(),
                );
                serde_json::to_vec(&manifest).unwrap()
            })]))
            .unwrap();
            let node = input.instances.get_mut("provider").unwrap();
            node.package = provider.application_ref().into();
            node.bindings.insert(
                "setup".into(),
                vec![Target::Instance {
                    path: vec!["executor".into()],
                    export: "setup".into(),
                }],
            );
            provider
        } else {
            provider
        };
        packages[0] = provider;
        let implementation = if acp.is_some() {
            json!({"kind":"native","implementation":maka_agent_api::acp::IMPLEMENTATION})
        } else if probe.is_some() {
            json!({"kind":"native","implementation":"fixture.executor"})
        } else {
            json!({"kind":"javascript","module":"executor.mjs","realm":"shared"})
        };
        let mut imports = serde_json::Map::new();
        let mut bindings = BTreeMap::new();
        if with_protocol {
            for (name, key, implementation, contract, schema, configuration) in [
                (
                    "processes",
                    22,
                    maka_workspace_api::protocol::IMPLEMENTATION,
                    maka_workspace_api::protocol::contract(),
                    serde_json::to_value(schemars::schema_for!(
                        maka_workspace_api::processes::Configuration
                    ))
                    .unwrap(),
                    json!({"filesystem":{"default":"write","rules":[],"denyGlobs":[]},"network":"allowed","helper":crate::owner::tests::native_helper()}),
                ),
                (
                    "files",
                    23,
                    maka_workspace_api::files::IMPLEMENTATION,
                    maka_workspace_api::files::contract(),
                    json!({"type":"object","additionalProperties":false}),
                    json!({}),
                ),
                (
                    "forms",
                    24,
                    maka_interactions_api::forms::IMPLEMENTATION,
                    maka_interactions_api::forms::contract(),
                    json!({"type":"object","additionalProperties":false}),
                    json!({}),
                ),
            ] {
                if acp.is_none() && name != "processes" {
                    continue;
                }
                let export = if name == "processes" {
                    "protocol"
                } else {
                    name
                };
                imports.insert(
                    name.into(),
                    json!({"contract":contract,"cardinality":Cardinality::One}),
                );
                bindings.insert(
                    name.into(),
                    vec![Target::Instance {
                        path: vec![name.into()],
                        export: export.into(),
                    }],
                );
                let package = Package::new(BTreeMap::from([(MANIFEST_FILE.into(), serde_json::to_vec(&json!({
                    "schemaVersion":1,"id":format!("fixture-acp-{name}"),"application":{"host":{
                        "implementation":{"kind":"native","implementation":implementation},"configuration":schema,"imports":{},
                        "exports":{(export):{"contract":contract,"availability":"required"}}
                    }}
                })).unwrap())])).unwrap();
                input.instances.insert(
                    name.into(),
                    Node {
                        key: Uuid::from_u128(key),
                        package: package.application_ref().into(),
                        use_package: PackageUse::Host,
                        configuration: NodeConfiguration {
                            values: serde_json::from_value(configuration).unwrap(),
                            parameters: BTreeMap::new(),
                        },
                        parameters: Default::default(),
                        disabled: false,
                        overrides: vec![],
                        bindings: BTreeMap::new(),
                    },
                );
                packages.push(package);
            }
        }
        let configuration_schema = if acp.is_some() {
            serde_json::to_value(schemars::schema_for!(maka_agent_api::acp::Configuration)).unwrap()
        } else {
            json!({"type":"object","additionalProperties":false})
        };
        let mut exports = serde_json::Map::from_iter([(
            "executor".into(),
            json!({"contract":executor::contract(),"availability":"required"}),
        )]);
        if with_setup {
            exports.insert(
                "setup".into(),
                json!({"contract":executor::setup::contract(),"availability":"required"}),
            );
        }
        let mut files=BTreeMap::from([(MANIFEST_FILE.into(),serde_json::to_vec(&json!({"schemaVersion":1,"id":"fixture-executor","application":{"host":{
            "implementation":implementation,"configuration":configuration_schema,"imports":imports,
            "exports":exports
        }}})).unwrap())]);
        if probe.is_none() && acp.is_none() {
            files.insert("executor.mjs".into(),format!(r#"const tasks=new Map(); function changed(task){{const wake=task.wake;task.changed=new Promise(resolve=>{{task.wake=resolve;}});if(wake)wake();}} export function activate(){{return {{executor:{{contract:{},service:['backend']}}}};}} export const backend={{async execute(input, observation, context){{
                const previous=tasks.get(input.taskId); if(previous){{if(previous.state.kind==='closed')return previous.state.outcome;throw new Error('original task is still running');}} const task={{outputs:[],state:{{kind:'running'}}}};changed(task);tasks.set(input.taskId,task);
                try {{
                for (const value of [
                    {{type:'message_start',messageId:'commentary'}},
                    {{type:'thinking_delta',messageId:'commentary',text:'思考'}},
                    {{type:'output_delta',messageId:'commentary',text:'live 外部'}},
                    {{type:'message_end',messageId:'commentary'}},
                    {{type:'tool_start',toolCallId:'observed-tool',name:'external.read',input:{{path:'source.txt'}}}},
                    {{type:'tool_progress',toolCallId:'observed-tool',text:'reading'}},
                    {{type:'tool_result',toolCallId:'observed-tool',text:'done',isError:false}},
                    {{type:'message_start',messageId:'answer'}},
                    {{type:'output_delta',messageId:'answer',text:input.message+' / '+input.settings.model+' / '+input.settings.thinkingLevel}},
                    {{type:'message_end',messageId:'answer'}}
                ]) {{ const indexed={{index:task.outputs.length,output:value}};task.outputs.push(indexed);changed(task);await context.invoke({{operation:'emit',value:indexed}}); }}
                const outcome={{status:'completed',message_id:'answer'}};task.state={{kind:'closed',outcome}};changed(task);return outcome;
                }} catch(error) {{task.state={{kind:'unknown',diagnostic:'original fixture output delivery failed'}};changed(task);throw error;}}
            }},async observe(input, observation, context){{
                const task=tasks.get(input.taskId);if(!task){{await context.invoke({{operation:'emit',value:{{kind:'missing'}}}});return null;}}
                const headers=input.afterIndex==null;let after=headers?0:input.afterIndex;
                for (;;) {{
                    const notice=task.changed;
                    const end=headers?0:Math.min(after+256,task.outputs.length);const state=task.state;const hasMore=!headers&&end<task.outputs.length;
                    await context.invoke({{operation:'emit',value:{{kind:'found',taskId:input.taskId,observed:end,hasMore,outputs:task.outputs.slice(after,end),state,cleanup:{{kind:state.kind==='closed'?'confirmed':'unconfirmed'}}}}}});
                    after=end;if(hasMore)continue;if(state.kind!=='running')return null;
                    await notice;
                }}
            }}}};"#,serde_json::to_string(&executor::contract()).unwrap()).into_bytes());
        }
        let package = Package::new(files).unwrap();
        input.instances.insert(
            "executor".into(),
            Node {
                key: Uuid::from_u128(21),
                package: package.application_ref().into(),
                use_package: PackageUse::Host,
                configuration: acp
                    .as_ref()
                    .map(|c| NodeConfiguration {
                        values: serde_json::from_value(serde_json::to_value(c).unwrap()).unwrap(),
                        parameters: BTreeMap::new(),
                    })
                    .unwrap_or_default(),
                parameters: Default::default(),
                disabled: false,
                overrides: vec![],
                bindings,
            },
        );
        packages.push(package);
        fixture
            .store
            .commit_application(source.deployment, source.revision, input, vec![], packages)
            .await
            .unwrap();
    }
    let mut native = NativeRegistry::default();
    maka_settings_native::provide(&mut native, crate::owner::tests::bundled_catalog()).unwrap();
    if with_protocol {
        maka_processes_native::provide(&mut native).unwrap();
    }
    if acp.is_some() {
        maka_acp_native::provide(&mut native).unwrap();
        maka_files_native::provide(&mut native).unwrap();
        maka_interactions_native::forms::provide(&mut native).unwrap();
    }
    let captured = Arc::new(StdMutex::new(None));
    let capture = captured.clone();
    let durable = fixture.owner.durable.clone();
    native
        .insert(
            IMPLEMENTATION.into(),
            Arc::new(move |context, configuration| {
                let capture = capture.clone();
                let durable = durable.clone();
                Box::pin(async move {
                    let services = context.services();
                    let owner = Owner::open(
                        context,
                        configuration,
                        crate::owner::tests::bundled_catalog(),
                        durable,
                        crate::owner::tests::native_helper(),
                        None,
                    )
                    .await
                    .unwrap();
                    *capture.lock().unwrap() = Some((owner.clone(), services));
                    let agent = Arc::new(Agent(owner));
                    NativeActivation {
                        owner: agent.clone(),
                        exports: Ok(BTreeMap::from([(
                            EXPORT.into(),
                            Published {
                                contract: contract(),
                                value: agent as Arc<dyn Handler>,
                            },
                        )])),
                    }
                })
            }),
        )
        .unwrap();
    if let Some(probe) = probe {
        native
            .insert(
                "fixture.executor".into(),
                Arc::new(move |context, _| {
                    let probe = probe.clone();
                    let _ = probe.services.set(context.services());
                    Box::pin(async move {
                        NativeActivation {
                            owner: probe.clone(),
                            exports: {
                                let mut exports = BTreeMap::from([(
                                    "executor".into(),
                                    Published {
                                        contract: executor::contract(),
                                        value: probe.clone() as Arc<dyn Handler>,
                                    },
                                )]);
                                if setup_probe {
                                    exports.insert(
                                        "setup".into(),
                                        Published {
                                            contract: executor::setup::contract(),
                                            value: probe as Arc<dyn Handler>,
                                        },
                                    );
                                }
                                Ok(exports)
                            },
                        }
                    })
                }),
            )
            .unwrap();
    }
    let mut grants = if granted {
        vec![maka_transport::transport::NativeGrant {
            origin: id(1),
            consumer: id(1),
            provider: id(21),
            export: "executor".into(),
            methods: ["execute".into(), "observe".into()].into_iter().collect(),
            recovery: true,
        }]
    } else {
        vec![]
    };
    if with_protocol {
        if with_publication {
            grants.push(maka_transport::transport::NativeGrant {
                origin: id(1),
                consumer: id(1),
                provider: id(23),
                export: "files".into(),
                methods: [publication_method.into()].into_iter().collect(),
                recovery: true,
            });
        }
        if with_setup && granted && !denied.contains(&"setup") {
            grants.push(maka_transport::transport::NativeGrant {
                origin: id(1),
                consumer: id(1),
                provider: id(21),
                export: "setup".into(),
                methods: ["setup".into()].into_iter().collect(),
                recovery: true,
            });
        }
        for (provider, export, methods) in [
            (22, "protocol", vec!["run", "input", "launch", "close"]),
            (23, "files", vec!["readText", "write"]),
            (24, "forms", vec!["ask"]),
        ] {
            if acp.is_none() && provider != 22 {
                continue;
            }
            grants.push(maka_transport::transport::NativeGrant {
                origin: id(21),
                consumer: id(21),
                provider: id(provider),
                export: export.into(),
                methods: methods
                    .into_iter()
                    .filter(|method| !denied.contains(method))
                    .map(String::from)
                    .collect(),
                recovery: true,
            });
        }
    }
    let policy = maka_transport::transport::PeerPolicy::with_native_grants(grants).unwrap();
    fixture.app = Application::start_from_store(
        fixture.store.clone(),
        source.deployment,
        native,
        fixture.issuer.clone(),
        Arc::new(Grant(fixture.issuer.clone(), Some(Arc::new(policy)))),
        Some(maka_host_js::factory(Default::default())),
    )
    .await
    .unwrap();
    fixture.app.ready().await.unwrap();
    let (owner, services) = captured.lock().unwrap().take().unwrap();
    fixture.owner = owner;
    fixture.services = services;
}
fn input_for(session: &str, message: &str) -> Value {
    json!({"sessionId":session,"message":message,"delivery":"queue","backend":{"kind":"executor","selection":{"executor":"external","settings":{"model":"backend-model","thinkingLevel":"high"}}}})
}
async fn work(fixture: &Fixture, session: &str, accepted: &Value) -> Value {
    assert_eq!(accepted["kind"], "queued");
    assert_eq!(accepted["sessionId"], session);
    let run = fixture.delivered_run(accepted).await;
    fixture
        .query(
            "work",
            json!({"sessionId":session,"target":{"kind":"run","runId":run}}),
        )
        .await
        .unwrap()
}

async fn external_result(
    fixture: &Fixture,
    session: &str,
    accepted: &Value,
) -> (
    maka_agent_state::fold::RunView,
    Vec<maka_agent_facts::durable::RecordedFact>,
    String,
) {
    use maka_agent_facts::durable::{Fact, Terminal};
    use maka_agent_facts::executor::Output;
    let run = fixture.delivered_run(accepted).await;
    let head = fixture
        .owner
        .durable
        .frontier(run)
        .await
        .unwrap_or_else(|_| panic!("original Delivered Run frontier unavailable"));
    assert!(head.run == run, "original Delivered Run identity required");
    assert!(
        head.spec.session_id == session,
        "original Delivered session required"
    );
    assert!(
        head.spec.owner == fixture.owner.run_owner(),
        "original Delivered owner required"
    );
    let task = head
        .external
        .as_ref()
        .expect("original external Task required");
    assert!(task.admitted, "original external Task must be admitted");
    let closed = task
        .closed
        .as_ref()
        .expect("original external Task must be closed");
    assert_eq!(closed.outcome, Terminal::Completed);
    let final_message = closed
        .final_message
        .as_ref()
        .expect("original final message required");
    let mut prefix = Vec::new();
    let mut after = 0;
    while after < head.revision {
        let page = fixture
            .owner
            .durable
            .history(run, after, 128)
            .await
            .unwrap_or_else(|_| panic!("original Delivered Run history page unavailable"));
        let page: Vec<_> = page
            .into_iter()
            .filter(|row| row.revision <= head.revision)
            .collect();
        let next = page
            .last()
            .expect("original Run history must reach its captured revision")
            .revision;
        assert!(next > after, "original Run revision cursor must advance");
        assert!(
            page.iter().all(|row| row.run == run),
            "history must retain the original Run"
        );
        prefix.extend(page);
        after = next;
    }
    assert_eq!(prefix.len() as u64, head.revision);
    let end = prefix
        .iter()
        .find(|row| row.id == final_message.end)
        .expect("original final MessageEnd fact required");
    assert!(
        matches!(&end.fact, Fact::ExternalTaskObserved {
        task: original, output: Output::MessageEnd { message_id }, ..
    } if *original == task.task && *message_id == final_message.message_id),
        "final MessageEnd must belong to the original Task and message"
    );
    let answer = prefix
        .iter()
        .filter_map(|row| match &row.fact {
            Fact::ExternalTaskObserved {
                task: original,
                output: Output::OutputDelta { message_id, text },
                ..
            } if *original == task.task && *message_id == final_message.message_id => {
                Some(text.as_str())
            }
            _ => None,
        })
        .collect();
    (head, prefix, answer)
}

#[tokio::test]
async fn executor_service_selects_the_exact_authorized_import_member() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let mut f = Fixture::new("http://127.0.0.1:9/v1", None).await;
        activate(&mut f, true, None, true).await;
        let loaded = f
            .store
            .load_application(f.app.source().unwrap().deployment)
            .await
            .unwrap()
            .unwrap();
        let (loaded_source, loaded_packages, _, _) = loaded.into_parts();
        let mut input = loaded_source.input;
        let mut packages = loaded_packages;
        let mut manifest = packages
            .iter()
            .find(|p| p.manifest().id == "agent")
            .unwrap()
            .manifest()
            .clone();
        let executor_name = format!("external-{}", "x".repeat(160));
        let import_name = format!("executor-{}", "r".repeat(300));
        let mut manifest_application = manifest.application.as_ref().unwrap().declaration().clone();
        let imports = &mut manifest_application.host.as_mut().unwrap().imports;
        let mut selected_import = imports.remove("executor").unwrap();
        selected_import.cardinality = Cardinality::Many { min: 0, max: 8 };
        imports.insert(import_name.clone(), selected_import);
        let package = Package::new(BTreeMap::from([(MANIFEST_FILE.into(), {
            manifest.application = Some(
                maka_plugin_core::package::CheckedDeclaration::new(manifest_application).unwrap(),
            );
            serde_json::to_vec(&manifest).unwrap()
        })]))
        .unwrap();
        let mut decoy = input.instances["executor"].clone();
        decoy.key = Uuid::from_u128(25);
        input.instances.insert("decoy".into(), decoy);
        let agent = input.instances.get_mut("provider").unwrap();
        agent.package = package.application_ref().into();
        let configured = &mut agent.configuration.values.get_mut("executors").unwrap()[0];
        configured["member"] = json!(1);
        configured["name"] = json!(executor_name);
        configured["import"] = json!(import_name);
        let validator = jsonschema::validator_for(&maka_agent_api::configuration_schema()).unwrap();
        let configuration = serde_json::to_value(&agent.configuration.values).unwrap();
        for (field, invalid) in [("name", "bad name"), ("name", ""), ("import", "")] {
            let mut malformed = configuration.clone();
            malformed["executors"][0][field] = json!(invalid);
            assert!(!validator.is_valid(&malformed));
        }
        let mut targets = agent.bindings.remove("executor").unwrap();
        targets.insert(
            0,
            Target::Instance {
                path: vec!["decoy".into()],
                export: "executor".into(),
            },
        );
        agent.bindings.insert(import_name.clone(), targets);
        packages.push(package);
        let source = f
            .store
            .commit_application(
                loaded_source.reference.deployment,
                loaded_source.reference.revision,
                input,
                vec![],
                packages,
            )
            .await
            .unwrap();
        f.app.adopt_committed(source).await.unwrap();
        f.app.ready().await.unwrap();
        let session = f.create("Selected member").await;
        let mut changes = f.owner.durable.subscribe().unwrap();
        let mut execution = input_for(&session, "second binding");
        execution["backend"]["selection"]["executor"] = json!(executor_name);
        let accepted = f
            .mutation(2, "send", execution, Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(accepted["kind"], "queued", "{accepted}");
        loop {
            changes.borrow_and_update();
            let observed = work(&f, &session, &accepted).await;
            match observed["execution"]["state"]["kind"].as_str() {
                Some("running" | "admitted" | "waiting") => {
                    changes.changed().await.unwrap();
                }
                _ => {
                    assert_eq!(
                        observed["execution"]["state"]["kind"], "completed",
                        "{observed}"
                    );
                    let (_, _, answer) = external_result(&f, &session, &accepted).await;
                    assert_eq!(answer, "second binding / backend-model / high");
                    break;
                }
            }
        }
        let records = f
            .store
            .application_intents(f.app.source().unwrap().deployment, id(1), 0, 128)
            .await
            .unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].reference.namespace,
            id(21),
            "member zero has no grant and must never be invoked"
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn executor_service_javascript_uses_original_engine_and_read_only_restart() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let mut fixture = Fixture::new("http://127.0.0.1:9/v1", None).await;
        activate(&mut fixture, true, None, true).await;
        let initial = input_for("unused", "")["backend"].clone();
        let mut create = fixture.create_input("External").await;
        create["backend"] = initial.clone();
        let created = fixture.mutation(2, "create", create, Uuid::new_v4()).await.unwrap();
        assert_eq!(created["session"]["backend"], initial);
        let session = created["session"]["id"].as_str().unwrap().to_owned();
        let mut input = input_for(&session, "original 外部 text");
        *fixture.owner.catalog.snapshot.write().await =
            Err("fixture_public_catalog_unavailable".into());
        let backend = input["backend"].clone();
        let saved = fixture
            .mutation(
                2,
                "selectBackend",
                json!({"sessionId":session,"backend":backend}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(saved["kind"], "committed");
        let selected = fixture
            .query("observe", json!({"sessionId":session}))
            .await
            .unwrap();
        assert_eq!(selected["session"]["backend"], backend);
        input.as_object_mut().unwrap().remove("backend");
        let operation = Uuid::new_v4();
        let accepted = fixture
            .mutation(2, "send", input.clone(), operation)
            .await
            .unwrap();
        assert_eq!(accepted["kind"], "queued");
        fixture.drained().await;
        let mut changes = fixture.owner.durable.subscribe().unwrap();
        let observed = loop {
            changes.borrow_and_update();
            let observed = work(&fixture, &session, &accepted).await;
            if !matches!(observed["execution"]["state"]["kind"].as_str(), Some("admitted" | "running" | "waiting")) {
                break observed;
            }
            changes.changed().await.unwrap();
        };
        assert_eq!(observed["execution"]["state"]["kind"], "completed");
        let (head, prefix, answer) = external_result(&fixture, &session, &accepted).await;
        assert_eq!(
            answer,
            "original 外部 text / backend-model / high"
        );
        let records = fixture
            .store
            .application_intents(fixture.app.source().unwrap().deployment, id(1), 0, 128)
            .await
            .unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].reference.namespace, id(21));
        assert_eq!(records[0].reference.method, "execute");
        assert_eq!(records[0].reference.export, "executor");
        assert!(matches!(head.spec.backend, maka_agent_facts::durable::BackendSpec::Executor { .. }));
        assert_eq!(prefix.len() as u64, head.revision);
        assert!(prefix.iter().all(|row| !matches!(row.fact, maka_agent_facts::durable::Fact::ModelAttemptPrepared { .. })));
        let outputs=prefix.iter().filter_map(|row| match &row.fact {
            maka_agent_facts::durable::Fact::ExternalTaskObserved { output, .. } => Some(serde_json::to_value(output).unwrap()),
            _=>None,
        }).collect::<Vec<_>>();
        assert_eq!(outputs,vec![
            json!({"type":"message_start","messageId":"commentary"}),
            json!({"type":"thinking_delta","messageId":"commentary","text":"思考"}),
            json!({"type":"output_delta","messageId":"commentary","text":"live 外部"}),
            json!({"type":"message_end","messageId":"commentary"}),
            json!({"type":"tool_start","toolCallId":"observed-tool","name":"external.read","input":{"path":"source.txt"}}),
            json!({"type":"tool_progress","toolCallId":"observed-tool","text":"reading"}),
            json!({"type":"tool_result","toolCallId":"observed-tool","text":"done","isError":false}),
            json!({"type":"message_start","messageId":"answer"}),
            json!({"type":"output_delta","messageId":"answer","text":"original 外部 text / backend-model / high"}),
            json!({"type":"message_end","messageId":"answer"}),
        ]);
        let descriptor = prefix.iter().find_map(|row| match &row.fact {
            maka_agent_facts::durable::Fact::ExternalTaskPrepared { descriptor, .. } => Some(descriptor),
            _ => None,
        }).unwrap();
        let bytes = fixture.history(&session).content(head.run, descriptor).await.unwrap();
        let descriptor: maka_agent_facts::executor::TaskDescriptor<Value> = serde_json::from_slice(&bytes).unwrap();
        let binding = descriptor.source;
        assert_eq!(binding.package_id, "fixture-executor");
        assert_eq!(binding.entry_id, "executor");
        let current = fixture
            .services
            .imports()
            .find(|(name, _)| *name == "executor")
            .unwrap()
            .1[0]
            .clone();
        assert_eq!(binding.activation, current.provider().epoch().to_string());
        activate(&mut fixture, false, None, true).await;
        assert_eq!(work(&fixture, &session, &accepted).await, observed);
        assert_eq!(
            fixture
                .mutation(2, "send", input, operation)
                .await
                .unwrap(),
            accepted
        );
        fixture.drained().await;
        assert_eq!(
            fixture
                .store
                .application_intents(fixture.app.source().unwrap().deployment, id(1), 0, 128)
                .await
                .unwrap()
                .len(),
            1
        );
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn executor_service_cancelled_unsettled_callback_keeps_actual_owner() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let mut fixture = Fixture::new("http://127.0.0.1:9/v1", None).await;
        let probe = Probe::new(Behavior::Unsettled);
        activate(&mut fixture, true, Some(probe.clone()), true).await;
        let session = fixture.create("Unsettled").await;
        let accepted = fixture
            .mutation(2, "send", input_for(&session, "blocked"), Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(accepted["kind"], "queued");
        assert_eq!(accepted["sessionId"], session);
        let run = fixture.delivered_run(&accepted).await;
        probe.entered.acquire().await.unwrap().forget();
        let stopped = fixture
            .mutation(
                2,
                "stop",
                json!({"sessionId":session,"runId":run}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(stopped["requested"], true);
        probe.cancelled.acquire().await.unwrap().forget();
        assert!(fixture.owner.runs.state().await.busy(&session));
        let view = fixture.owner.durable.frontier(run).await.unwrap();
        assert_eq!(view.run, run);
        assert_eq!(view.spec.owner, fixture.owner.run_owner());
        assert_eq!(view.spec.session_id, session);
        assert!(view.stopped);

        assert!(
            fixture
                .app
                .client()
                .snapshot()
                .instances
                .iter()
                .any(|instance| instance.activation.instance() == &id(21) && instance.calls > 0)
        );
        probe.release.add_permits(1);
        while fixture
            .app
            .client()
            .snapshot()
            .instances
            .iter()
            .any(|instance| instance.activation.instance() == &id(21) && instance.calls > 0)
        {
            tokio::task::yield_now().await;
        }
        fixture.drained().await;
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn executor_service_progress_is_canonical_before_original_backend_finishes() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let mut fixture = Fixture::new("http://127.0.0.1:9/v1", None).await;
        let probe = Probe::new(Behavior::Streaming);
        activate(&mut fixture, true, Some(probe.clone()), true).await;
        let session = fixture.create("Live output").await;
        let mut commits = fixture.owner.durable.subscribe().unwrap();
        let accepted = fixture
            .mutation(
                2,
                "send",
                input_for(&session, "final canonical answer"),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        probe.entered.acquire().await.unwrap().forget();
        let live = work(&fixture, &session, &accepted).await;
        let run = live["execution"]["runId"].as_str().unwrap();
        loop {
            commits.borrow_and_update();
            let run_id =
                serde_json::from_value::<maka_agent_facts::durable::RunId>(json!(run)).unwrap();
            let head = fixture.owner.durable.frontier(run_id).await.unwrap();
            let prefix: Vec<_> = fixture
                .recorded_facts(&session)
                .await
                .into_iter()
                .filter(|row| row.run == run_id && row.revision <= head.revision)
                .collect();
            assert_eq!(prefix.len() as u64, head.revision);
            let outputs = prefix
                .iter()
                .filter(|row| {
                    matches!(
                        row.fact,
                        maka_agent_facts::durable::Fact::ExternalTaskObserved { .. }
                    )
                })
                .count();
            assert!(prefix.iter().all(|row| !matches!(
                row.fact,
                maka_agent_facts::durable::Fact::RunTerminated { .. }
                    | maka_agent_facts::durable::Fact::ExternalTaskClosed { .. }
            )));
            if outputs == 37 {
                break;
            }
            commits.changed().await.unwrap();
        }
        let snapshot = fixture
            .query("observe", json!({"sessionId":session}))
            .await
            .unwrap();
        assert!(snapshot["run"].is_object());
        let live_history = fixture
            .query(
                "history",
                json!({"sessionId":session,"position":{"kind":"start"}}),
            )
            .await
            .unwrap();
        let through = live_history["through"]
            .as_u64()
            .expect("original live history cut required");
        let mut page = live_history;
        let mut live_chunks = Vec::new();
        loop {
            assert_eq!(page["through"].as_u64(), Some(through));
            live_chunks.extend(page["chunks"].as_array().unwrap().iter().cloned());
            let after = page
                .get("after")
                .expect("original history page cursor field required");
            if after.is_null() {
                break;
            }
            page = fixture
                .query(
                    "history",
                    json!({
                        "sessionId":session, "through":through,
                        "position":{"kind":"after","cursor":after}
                    }),
                )
                .await
                .unwrap();
        }
        let body: String = live_chunks
            .iter()
            .filter(|row| row["role"] == "assistant" && row["field"] == "body")
            .filter_map(|row| row["text"].as_str())
            .collect();
        assert_eq!(
            body,
            (0..35)
                .map(|index| format!("part {index}\n"))
                .collect::<String>()
        );
        assert!(
            live_chunks
                .iter()
                .filter(|row| row["role"] == "assistant")
                .all(|row| row["finalOutput"] != true)
        );
        let mut stream = fixture
            .app
            .client()
            .subscribe(
                fixture.binding(2).await,
                "watch".into(),
                json!({"sessionId":session,"after":0}),
                scope(&fixture.issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        let mut deltas = Vec::new();
        let mut started = None;
        while deltas.len() < 36 {
            let page = stream.recv().await.unwrap();
            if let Some(events) = page["events"].as_array() {
                for event in events {
                    assert_ne!(
                        event["fact"]["kind"], "ended",
                        "watch ended before backend completion"
                    );
                    let history = fixture.history(&session);
                    let cut = history
                        .capture_at(page["through"].as_u64().unwrap())
                        .await
                        .unwrap();
                    let item = history
                        .item(&cut, event["sequence"].as_u64().unwrap())
                        .await
                        .unwrap()
                        .unwrap();
                    if let maka_agent_facts::durable::Fact::ExternalTaskObserved {
                        output, ..
                    } = item.recorded.fact
                    {
                        match output {
                            maka_agent_facts::executor::Output::MessageStart { message_id } => {
                                started = Some(json!(message_id))
                            }
                            maka_agent_facts::executor::Output::ThinkingDelta {
                                message_id,
                                text,
                            } => {
                                assert_eq!(message_id, "commentary");
                                deltas.push((json!("thinking"), json!(text)));
                            }
                            maka_agent_facts::executor::Output::OutputDelta {
                                message_id,
                                text,
                            } => {
                                assert_eq!(message_id, "commentary");
                                deltas.push((json!("text"), json!(text)));
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        assert_eq!(started, Some(json!("commentary")));
        assert_eq!(deltas[0], (json!("thinking"), json!("checking")));
        for index in 0..35 {
            assert_eq!(
                deltas[index + 1],
                (json!("text"), json!(format!("part {index}\n")))
            );
        }
        stream.completion().await.cleanup.unwrap();
        let records = fixture
            .store
            .application_intents(fixture.app.source().unwrap().deployment, id(1), 0, 128)
            .await
            .unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(
            fixture
                .store
                .operation(&records[0].reference)
                .unwrap()
                .operation_observation()
                .await
                .unwrap()
                .unwrap()
                .outcome,
            OperationOutcome::Unresolved
        );
        probe.release.add_permits(1);
        fixture.drained().await;
        let observed = loop {
            commits.borrow_and_update();
            let observed = work(&fixture, &session, &accepted).await;
            if !matches!(
                observed["execution"]["state"]["kind"].as_str(),
                Some("admitted" | "running" | "waiting")
            ) {
                break observed;
            }
            commits.changed().await.unwrap();
        };
        assert_eq!(observed["execution"]["state"]["kind"], "completed");
        let (_, _, answer) = external_result(&fixture, &session, &accepted).await;
        assert_eq!(answer, "final canonical answer");
        let history = fixture
            .query(
                "history",
                json!({"sessionId":session,"position":{"kind":"start"}}),
            )
            .await
            .unwrap();
        let through = history["through"]
            .as_u64()
            .expect("original completed history cut required");
        let mut page = history;
        let mut chunks = Vec::new();
        loop {
            assert_eq!(page["through"].as_u64(), Some(through));
            chunks.extend(page["chunks"].as_array().unwrap().iter().cloned());
            let after = page
                .get("after")
                .expect("original history page cursor field required");
            if after.is_null() {
                break;
            }
            page = fixture
                .query(
                    "history",
                    json!({
                        "sessionId":session, "through":through,
                        "position":{"kind":"after","cursor":after}
                    }),
                )
                .await
                .unwrap();
        }
        let commentary: Vec<_> = chunks
            .iter()
            .filter(|row| {
                row["role"] == "assistant"
                    && row["field"] == "body"
                    && row["text"]
                        .as_str()
                        .is_some_and(|text| text.starts_with("part "))
            })
            .collect();
        assert_eq!(
            commentary
                .iter()
                .filter_map(|row| row["text"].as_str())
                .collect::<String>(),
            (0..35)
                .map(|index| format!("part {index}\n"))
                .collect::<String>()
        );
        assert!(commentary.iter().all(|row| row["finalOutput"] != true));
        let final_answer = chunks
            .iter()
            .find(|row| row["finalOutput"] == true)
            .unwrap();
        assert_eq!(final_answer["text"], "final canonical answer");
        assert!(
            commentary
                .iter()
                .all(|row| row["messageId"] != final_answer["messageId"])
        );
        assert_eq!(probe.calls.load(Ordering::SeqCst), 1);
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn executor_service_invalid_success_fails_durably_and_preserves_interrupted_body() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let mut fixture = Fixture::new("http://127.0.0.1:9/v1", None).await;
        let probe = Probe::new(Behavior::InvalidSuccess);
        activate(&mut fixture, true, Some(probe.clone()), true).await;
        for expected_calls in 1..=2 {
            let session = fixture.create("Invalid executor completion").await;
            let accepted = fixture
                .mutation(2, "send", input_for(&session, "answer"), Uuid::new_v4())
                .await
                .unwrap();
            assert_eq!(accepted["kind"], "queued");
            fixture.drained().await;
            let mut changes = fixture.owner.durable.subscribe().unwrap();
            let observed = loop {
                changes.borrow_and_update();
                let observed = work(&fixture, &session, &accepted).await;
                if !matches!(
                    observed["execution"]["state"]["kind"].as_str(),
                    Some("admitted" | "running" | "waiting")
                ) {
                    break observed;
                }
                changes.changed().await.unwrap();
            };
            assert_eq!(
                observed["execution"]["state"]["kind"], "failed",
                "{observed}"
            );
            let stored = fixture.recorded_facts(&session).await;
            assert!(!stored.iter().any(|row| matches!(
                row.fact,
                maka_agent_facts::durable::Fact::ExternalTaskClosed {
                    outcome: maka_agent_facts::durable::Terminal::Completed,
                    ..
                }
            )));
            assert!(stored.iter().any(|row| matches!(
                &row.fact,
                maka_agent_facts::durable::Fact::RunTerminated {
                    terminal: maka_agent_facts::durable::Terminal::Failed,
                    diagnostic: Some(_)
                }
            )));
            let history = fixture
                .query(
                    "history",
                    json!({"sessionId":session,"position":{"kind":"start"}}),
                )
                .await
                .unwrap();
            let partial = history["chunks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|chunk| chunk["role"] == "assistant")
                .unwrap();
            assert_eq!(partial["text"], "partial answer");
            assert_ne!(partial["finalOutput"], true);
            assert_eq!(probe.calls.load(Ordering::SeqCst), expected_calls);
        }
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[cfg(target_os = "macos")]
mod acp;

#[tokio::test]
async fn executor_attachments_use_only_owned_immutable_uploads_and_original_receipts() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let mut f = Fixture::new("http://127.0.0.1:9/v1", None).await;
        let probe = Probe::new(Behavior::Attachments);
        activate(&mut f, true, Some(probe.clone()), true).await;
        let session = f.create("Attachments").await;
        let other = f.create("Other").await;
        let files = [
            (
                "notes.md".to_owned(),
                "original immutable content\n".repeat(3000),
            ),
            (
                "utf8.txt".to_owned(),
                "distinct executor file\n中\0tail".to_owned(),
            ),
        ];
        let mut ids = Vec::new();
        for (name, bytes) in &files {
            let uploaded =
                super::attachments::upload(&f, &session, name, bytes.as_bytes(), Uuid::new_v4())
                    .await
                    .unwrap();
            ids.push(uploaded["attachment"]["id"].clone());
        }
        let id = ids[0].clone();
        for (target, ids) in [
            (&other, json!([id])),
            (&session, json!([id, id])),
            (&session, json!(["missing"])),
        ] {
            let mut input = input_for(target, "");
            input["attachments"] = ids;
            assert!(f.mutation(2, "send", input, Uuid::new_v4()).await.is_err());
        }
        let mut input = input_for(&session, "");
        input["attachments"] = json!(ids);
        let operation = Uuid::new_v4();
        let accepted = f
            .mutation(2, "send", input.clone(), operation)
            .await
            .unwrap();
        assert_eq!(accepted["kind"], "queued");
        assert_eq!(accepted["sessionId"], session);
        let run = f.delivered_run(&accepted).await;

        probe.entered.acquire().await.unwrap().forget();

        f.drained().await;

        let mut changes = f.owner.durable.subscribe().unwrap();
        let observed = loop {
            changes.borrow_and_update();
            let observed = work(&f, &session, &accepted).await;
            if !matches!(
                observed["execution"]["state"]["kind"].as_str(),
                Some("admitted" | "running" | "waiting")
            ) {
                break observed;
            }
            changes.changed().await.unwrap();
        };
        assert_eq!(
            observed["execution"]["state"]["kind"], "completed",
            "{observed}"
        );
        let (original, _, answer) = external_result(&f, &session, &accepted).await;
        assert_eq!(original.run, run);
        let received: Vec<Value> = serde_json::from_str(&answer).unwrap();
        assert_eq!(received.len(), files.len());
        for (received, (name, bytes)) in received.iter().zip(&files) {
            assert_eq!(received["metadata"]["name"], *name);
            assert_eq!(received["metadata"]["bytes"], bytes.len());
            assert_eq!(
                received["metadata"]["digest"],
                maka_agent_facts::artifact::content_digest(bytes.as_bytes())
            );
            assert_eq!(received["preview"], &bytes[..bytes.len().min(80)]);
        }
        assert_eq!(
            f.mutation(2, "send", input, operation).await.unwrap(),
            accepted
        );
        assert_eq!(probe.calls.load(Ordering::SeqCst), 1);
        assert!(f.owner.runs.state().await.controls.is_empty());
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

mod external;
mod external_host_tools;
mod external_owner_regressions;
mod external_steering;

mod external_attachments;

mod external_history;

mod external_support;

mod external_persistence;
