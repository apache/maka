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
use maka_host_runtime::application::{Context, Handler, NativeOwner};
use maka_plugin_core::runtime::Published;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone, Copy)]
enum Behavior {
    Unsettled,
    Streaming,
    Attachments,
}
struct Probe {
    behavior: Behavior,
    calls: AtomicUsize,
    entered: Arc<Semaphore>,
    cancelled: Arc<Semaphore>,
    release: Arc<Semaphore>,
}
impl Probe {
    fn new(behavior: Behavior) -> Arc<Self> {
        Arc::new(Self {
            behavior,
            calls: AtomicUsize::new(0),
            entered: Arc::new(Semaphore::new(0)),
            cancelled: Arc::new(Semaphore::new(0)),
            release: Arc::new(Semaphore::new(0)),
        })
    }
}
impl Handler for Probe {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value, String>> {
        assert_eq!(method, "execute");
        assert!(context.operation().is_some());
        let Identity::Agent { invocation, .. } = &context.scope().identity else {
            panic!("native Agent identity required");
        };
        assert_eq!(
            input["invocation"],
            serde_json::to_value(invocation).unwrap()
        );
        self.calls.fetch_add(1, Ordering::SeqCst);
        let (behavior, entered, cancelled, release) = (
            self.behavior,
            self.entered.clone(),
            self.cancelled.clone(),
            self.release.clone(),
        );
        Box::pin(async move {
            entered.add_permits(1);
            match behavior {
                Behavior::Streaming => {
                    context
                        .emit(json!({"type":"thinking_delta","text":"checking"}))
                        .await?;
                    for index in 0..35 {
                        context
                            .emit(json!({"type":"output_delta","text":format!("part {index}\n")}))
                            .await?;
                    }
                    tokio::select! {
                        permit=release.acquire() => permit.unwrap().forget(),
                        ()=context.scope().cancellation.cancelled() => return Ok(json!({"status":"cancelled","reason":"stopped"})),
                    }
                }

                Behavior::Attachments => {
                    assert_eq!(context.attachments().len(), 1);
                    let resource = context.attachments().get("attachments").unwrap();
                    assert_eq!(
                        resource.encoding(),
                        maka_capabilities::call::ResourceEncoding::Bytes
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
                    return Ok(
                        json!({"status":"completed","text":serde_json::to_string(&files).unwrap()}),
                    );
                }
                Behavior::Unsettled => {
                    context.scope().cancellation.cancelled().await;
                    cancelled.add_permits(1);
                    release.acquire().await.unwrap().forget();
                }
            }
            Ok(json!({"status":"completed","text":input["message"]}))
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
async fn activate_backend(
    fixture: &mut Fixture,
    install: bool,
    probe: Option<Arc<Probe>>,
    granted: bool,
    acp: Option<maka_agent_api::acp::Configuration>,
    denied: &[&str],
) {
    let source = fixture.app.source().unwrap().clone();
    fixture.app.shutdown().await.unwrap();
    if install {
        let mut settings = fixture.owner.settings.clone();
        settings.executors = vec![executor::ServiceExecutor {
            name: "external".into(),
            import: "executor".into(),
            member: 0,
            setup: acp.as_ref().map(|_| executor::setup::Binding {
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
        let provider = if acp.is_some() {
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
        if acp.is_some() {
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
                    json!({"filesystem":{"default":"write","rules":[],"denyGlobs":[]},"network":"allowed","helper":null,"sessionOwner":id(1),"setupDirectory":if denied.contains(&"directory") { Value::Null } else { json!(fixture.workspace) }}),
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
        if acp.is_some() {
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
            files.insert("executor.mjs".into(),format!(r#"export function activate(){{return {{executor:{{contract:{},service:['backend']}}}};}} export const backend={{async execute(input, observation, context){{
                for (const value of [
                    {{type:'thinking_delta',text:'思考'}},
                    {{type:'output_delta',text:'live 外部'}},
                    {{type:'tool_start',toolCallId:'observed-tool',name:'external.read',input:{{path:'source.txt'}}}},
                    {{type:'tool_progress',toolCallId:'observed-tool',text:'reading'}},
                    {{type:'tool_result',toolCallId:'observed-tool',text:'done',isError:false}}
                ]) await context.invoke({{operation:'emit',value}});
                return {{status:'completed',text:input.message+' / '+input.settings.model+' / '+input.settings.thinkingLevel}};
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
    if acp.is_some() {
        maka_acp_native::provide(&mut native).unwrap();
        maka_processes_native::provide(&mut native).unwrap();
        maka_files_native::provide(&mut native).unwrap();
        maka_interactions_native::forms::provide(&mut native).unwrap();
    }
    let captured = Arc::new(StdMutex::new(None));
    let capture = captured.clone();
    native
        .insert(
            IMPLEMENTATION.into(),
            Arc::new(move |context, configuration| {
                let capture = capture.clone();
                Box::pin(async move {
                    let services = context.services();
                    let owner = Owner::open(
                        context,
                        configuration,
                        crate::owner::tests::bundled_catalog(),
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
                Arc::new(move |_, _| {
                    let probe = probe.clone();
                    Box::pin(async move {
                        NativeActivation {
                            owner: probe.clone(),
                            exports: Ok(BTreeMap::from([(
                                "executor".into(),
                                Published {
                                    contract: executor::contract(),
                                    value: probe as Arc<dyn Handler>,
                                },
                            )])),
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
            methods: ["execute".into()].into_iter().collect(),
            recovery: true,
        }]
    } else {
        vec![]
    };
    if acp.is_some() {
        if granted && !denied.contains(&"setup") {
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
            (22, "protocol", vec!["run", "input", "launch"]),
            (23, "files", vec!["readText", "write"]),
            (24, "forms", vec!["ask"]),
        ] {
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
    json!({"sessionId":session,"message":message,"executor":{"executor":"external","settings":{"model":"backend-model","thinkingLevel":"high"}}})
}
async fn work(fixture: &Fixture, session: &str, accepted: &Value) -> Value {
    fixture.query("work",json!({"sessionId":session,"target":{"kind":"invocation","invocationId":accepted["invocationId"]}})).await.unwrap()
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
        let mut changes = f.session(&session).await.subscribe_commits().unwrap();
        let mut execution = input_for(&session, "second binding");
        execution["executor"]["executor"] = json!(executor_name);
        let accepted = f
            .mutation(2, "execute", execution, Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(accepted["kind"], "started", "{accepted}");
        loop {
            let observed = work(&f, &session, &accepted).await;
            match observed["execution"]["state"].as_str() {
                Some("running") | Some("admitted") | Some("waiting_for_user") | None => {
                    changes.changed().await.unwrap();
                }
                _ => {
                    assert_eq!(observed["execution"]["state"], "completed", "{observed}");
                    assert_eq!(
                        observed["answer"]["text"],
                        "second binding / backend-model / high"
                    );
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
        let session = fixture.create("External").await;
        let input = input_for(&session, "original 外部 text");
        *fixture.owner.catalog.snapshot.write().await =
            Err("fixture_public_catalog_unavailable".into());
        let backend = json!({"kind":"executor","selection":input["executor"]});
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
        let operation = Uuid::new_v4();
        let accepted = fixture
            .mutation(2, "execute", input.clone(), operation)
            .await
            .unwrap();
        assert_eq!(accepted["kind"], "started");
        fixture.drained().await;
        let observed = work(&fixture, &session, &accepted).await;
        assert_eq!(observed["execution"]["state"], "completed");
        assert_eq!(
            observed["answer"]["text"],
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
        let configuration = fixture.session(&(Invocation {
                session_id: session.clone(),
                turn_id: observed["execution"]["turnId"].as_str().unwrap().into(),
                run_id: observed["execution"]["runId"].as_str().unwrap().into(),
                invocation_id: accepted["invocationId"].as_str().unwrap().into(),
            }).session_id).await.invocation_configuration(&Invocation {
                session_id: session.clone(),
                turn_id: observed["execution"]["turnId"].as_str().unwrap().into(),
                run_id: observed["execution"]["runId"].as_str().unwrap().into(),
                invocation_id: accepted["invocationId"].as_str().unwrap().into(),
            })
            .await
            .unwrap()
            .unwrap();
        assert!(configuration.model.is_none());
        let source = fixture.session(&session).await.run_source(
            &session, observed["execution"]["runId"].as_str().unwrap(), None,
        ).await.unwrap().unwrap();
        let mut prefix = fixture.session(&session).await.session_events(
            &session, 0, source.last.sequence, 512, 65536,
        ).await.unwrap();
        assert!(prefix.next_after.is_none());
        prefix.events.retain(|row| row.event.invocation == source.boundary.invocation);
        assert_eq!(prefix.events.len() as u64, source.boundary.high_water);
        assert!(prefix.events.iter().all(|row| !matches!(
            row.event.fact,
            maka_agent_facts::event::Fact::ModelRequested { .. }
        )));
        let outputs=prefix.events.iter().filter_map(|row| match &row.event.fact {
            maka_agent_facts::event::Fact::ExecutorObserved { output } => Some(serde_json::to_value(output).unwrap()),
            _=>None,
        }).collect::<Vec<_>>();
        assert_eq!(outputs,vec![
            json!({"type":"thinking_delta","text":"思考"}),
            json!({"type":"output_delta","text":"live 外部"}),
            json!({"type":"tool_start","toolCallId":"observed-tool","name":"external.read","input":{"path":"source.txt"}}),
            json!({"type":"tool_progress","toolCallId":"observed-tool","text":"reading"}),
            json!({"type":"tool_result","toolCallId":"observed-tool","text":"done","isError":false}),
        ]);
        let binding = prefix
            .events
            .iter()
            .find_map(|row| match &row.event.fact {
                maka_agent_facts::event::Fact::ExecutorStarted { binding, .. } => Some(binding),
                _ => None,
            })
            .unwrap();
        assert_eq!(binding.package_id, "fixture-executor");
        assert_eq!(binding.entry_id, "host");
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
                .mutation(2, "execute", input, operation)
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
            .mutation(2, "execute", input_for(&session, "blocked"), Uuid::new_v4())
            .await
            .unwrap();
        probe.entered.acquire().await.unwrap().forget();
        let stopped = fixture
            .mutation(
                2,
                "stop",
                json!({"sessionId":session,"invocationId":accepted["invocationId"]}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(stopped["requested"], true);
        probe.cancelled.acquire().await.unwrap().forget();
        fixture.drained().await;
        assert!(
            fixture
                .owner
                .runs
                .lock()
                .await
                .retained_cleanup
                .contains(&session)
        );
        assert!(
            !fixture
                .owner
                .runs
                .lock()
                .await
                .controls
                .contains_key(&session)
        );
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
        assert!(fixture.app.shutdown().await.is_err());
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
        let mut commits = fixture.session(&session).await.subscribe_commits().unwrap();
        let accepted = fixture
            .mutation(
                2,
                "execute",
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
            let source = fixture
                .session(&session)
                .await
                .run_source(&session, run, None)
                .await
                .unwrap()
                .unwrap();
            let mut prefix = fixture
                .session(&session)
                .await
                .session_events(&session, 0, source.last.sequence, 512, 65536)
                .await
                .unwrap();
            assert!(prefix.next_after.is_none());
            prefix
                .events
                .retain(|row| row.event.invocation == source.boundary.invocation);
            assert_eq!(prefix.events.len() as u64, source.boundary.high_water);
            let outputs = prefix
                .events
                .iter()
                .filter(|row| {
                    matches!(
                        &row.event.fact,
                        maka_agent_facts::event::Fact::ExecutorObserved { .. }
                    )
                })
                .count();
            assert!(prefix.events.iter().all(|row| !matches!(
                &row.event.fact,
                maka_agent_facts::event::Fact::InvocationEnded { .. }
                    | maka_agent_facts::event::Fact::ExecutorCompleted { .. }
            )));
            if outputs == 36 {
                break;
            }
            commits.changed().await.unwrap();
        }
        let snapshot = fixture
            .query("observe", json!({"sessionId":session}))
            .await
            .unwrap();
        let parts = snapshot["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["messageId"], parts[1]["messageId"]);
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
                    let fact = &event["fact"];
                    match fact["kind"].as_str().unwrap() {
                        "executor_started" => started = Some(fact["messageId"].clone()),
                        "delta" => {
                            assert_eq!(fact["stepId"], accepted["invocationId"]);
                            deltas.push((fact["partId"].clone(), fact["text"].clone()));
                        }
                        "ended" => panic!("watch ended before actual backend completion"),
                        _ => {}
                    }
                }
            }
        }
        assert_eq!(started, Some(parts[0]["messageId"].clone()));
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
        assert_eq!(
            work(&fixture, &session, &accepted).await["answer"]["text"],
            "final canonical answer"
        );
        assert_eq!(probe.calls.load(Ordering::SeqCst), 1);
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
            ("notes.md".to_owned(), "original immutable content\n".repeat(3000)),
            ("utf8.txt".to_owned(), "distinct executor file\n中\0tail".to_owned()),
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
            assert!(
                f.mutation(2, "execute", input, Uuid::new_v4())
                    .await
                    .is_err()
            );
        }
        let mut input = input_for(&session, "");
        input["attachments"] = json!(ids);
        let operation = Uuid::new_v4();
        let accepted = f
            .mutation(2, "execute", input.clone(), operation)
            .await
            .unwrap();
        assert_eq!(accepted["kind"], "started");

        probe.entered.acquire().await.unwrap().forget();

        f.drained().await;

        let observed = work(&f, &session, &accepted).await;
        assert_eq!(observed["execution"]["state"], "completed", "{observed}");
        let mut page = observed;
        let mut answer = String::new();
        loop {
            assert_eq!(page["execution"]["state"], "completed");
            assert_eq!(page["execution"]["invocationId"], accepted["invocationId"]);
            answer.push_str(page["answer"]["text"].as_str().unwrap());
            let cursor = &page["answer"]["next"];
            if cursor.is_null() {
                break;
            }
            page = f
                .query("work", json!({"sessionId":session,"target":{"kind":"invocation","invocationId":accepted["invocationId"]},"cursor":cursor}))
                .await
                .unwrap();
        }
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
            f.mutation(2, "execute", input, operation).await.unwrap(),
            accepted
        );
        assert_eq!(probe.calls.load(Ordering::SeqCst), 1);
        assert!(f.owner.runs.lock().await.controls.is_empty());
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
