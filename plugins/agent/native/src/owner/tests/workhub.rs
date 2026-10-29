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
use maka_agent_api::workhub as hub;
use maka_agent_facts::event::Fact;
use maka_host_runtime::application::{Handler, NativeOwner};

pub(super) async fn activate(fixture: &mut Fixture, install: bool) {
    activate_workers(fixture, install, false, false).await
}
pub(super) async fn activate_workers(
    fixture: &mut Fixture,
    install: bool,
    workers: bool,
    granted: bool,
) {
    activate_worker_mode(fixture, install, workers, granted, WorkerBehavior::Returned).await;
}
pub(super) enum Setup {
    Coordinator,
    Worker {
        behavior: WorkerBehavior,
        granted: bool,
    },
}
impl Setup {
    pub(super) fn workers() -> Self {
        Self::worker(WorkerBehavior::Returned)
    }
    fn worker(behavior: WorkerBehavior) -> Self {
        Self::Worker {
            behavior,
            granted: true,
        }
    }
    fn state(&self) -> (bool, bool, WorkerBehavior) {
        match self {
            Self::Coordinator => (false, false, WorkerBehavior::Returned),
            Self::Worker { behavior, granted } => (true, *granted, behavior.clone()),
        }
    }
    pub(super) fn composition(&self, settings: &Configuration) -> (Input, Vec<Package>) {
        let (workers, _, behavior) = self.state();
        let external = matches!(behavior, WorkerBehavior::External);
        let mut provider = entry(true);
        provider.configuration = hub::configuration_schema().into();
        provider.implementation = Implementation::Native {
            implementation: hub::IMPLEMENTATION.into(),
        };
        provider.exports.insert(
            hub::EXPORT.into(),
            Export {
                contract: hub::contract(),
                availability: Availability::Required,
            },
        );
        let mut consumer = entry(false);
        consumer.imports.insert(
            hub::EXPORT.into(),
            Import {
                contract: hub::contract(),
                cardinality: Cardinality::One,
            },
        );
        if workers {
            for entry in [&mut provider, &mut consumer] {
                entry.imports.insert(
                    "worker".into(),
                    Import {
                        contract: contract(),
                        cardinality: Cardinality::One,
                    },
                );
            }
        }
        let (mut composition, mut packages) = application_input(
            settings,
            application_package("agent", provider),
            application_package("consumer", consumer),
        );
        if settings
            .tools
            .iter()
            .any(|tool| tool.import == "service" && tool.method == "execute")
        {
            assert!(
                !workers,
                "fixture process and worker providers use distinct scenarios"
            );
            service_tools::Setup::processes().install(&mut composition, &mut packages);
            composition
                .instances
                .get_mut("service")
                .unwrap()
                .configuration
                .values
                .insert("sessionKind".into(), json!("workhub"));
        }

        if workers {
            let mut entry = entry(true);
            if external {
                entry.imports.insert(
                    "executor".into(),
                    Import {
                        contract: maka_agent_api::executor::contract(),
                        cardinality: Cardinality::One,
                    },
                );
            }
            if !matches!(
                behavior,
                WorkerBehavior::Returned
                    | WorkerBehavior::DeniedQuery(_)
                    | WorkerBehavior::External
            ) {
                entry.implementation = Implementation::Native {
                    implementation: "fixture.lost-agent".into(),
                };
            }
            let worker = application_package("worker", entry);
            let mut node = composition.instances["provider"].clone();
            node.key = Uuid::from_u128(21);
            node.package = worker.application_ref().into();
            if external {
                node.configuration.values.insert(
                    "executors".into(),
                    json!([{"name":"external","import":"executor"}]),
                );
                node.bindings.insert(
                    "executor".into(),
                    vec![Target::Instance {
                        path: vec!["executor".into()],
                        export: "executor".into(),
                    }],
                );
            }
            composition.instances.insert("worker".into(), node);
            packages.push(worker);
            for name in ["provider", "a", "b"] {
                composition
                    .instances
                    .get_mut(name)
                    .unwrap()
                    .bindings
                    .insert(
                        "worker".into(),
                        vec![Target::Instance {
                            path: vec!["worker".into()],
                            export: EXPORT.into(),
                        }],
                    );
            }
        }
        composition
            .instances
            .get_mut("provider")
            .unwrap()
            .configuration = NodeConfiguration {
            values: BTreeMap::from([
                ("agent".into(), serde_json::to_value(settings).unwrap()),
                (
                    "workers".into(),
                    if workers {
                        json!(["worker"])
                    } else {
                        json!([])
                    },
                ),
            ]),
            parameters: BTreeMap::new(),
        };
        for name in ["a", "b"] {
            composition
                .instances
                .get_mut(name)
                .unwrap()
                .bindings
                .insert(
                    hub::EXPORT.into(),
                    vec![Target::Instance {
                        path: vec!["provider".into()],
                        export: hub::EXPORT.into(),
                    }],
                );
        }
        if external {
            let package=Package::new(BTreeMap::from([
            (MANIFEST_FILE.into(),serde_json::to_vec(&json!({"schemaVersion":1,"id":"fixture-executor","application":{"host":{
                "implementation":{"kind":"javascript","module":"executor.mjs","realm":"shared"},"configuration":{"type":"object","additionalProperties":false},"imports":{},
                "exports":{"executor":{"contract":maka_agent_api::executor::contract(),"availability":"required"}}
            }}})).unwrap()),
            ("executor.mjs".into(),format!(r#"export function activate(){{return {{executor:{{contract:{},service:['backend']}}}};}} export const backend={{async execute(input,observation,context){{
                let suffix='';
                if(input.message.includes('original upload')) {{
                    const descriptor=await context.invoke({{operation:'metadata',slot:'attachments'}});
                    const files=descriptor.metadata;
                    if(!Array.isArray(files)) throw new Error('attachment manifest required');
                    let offset=0;
                    const texts=[];
                    for(const file of files) {{
                        const end=offset+file.bytes;
                        if(!Number.isSafeInteger(end)||end<offset) throw new Error('invalid attachment length');
                        const decoder=new TextDecoder();
                        let text='';
                        for(let start=offset;start<end;start+=65536) {{
                            const chunkEnd=Math.min(start+65536,end);
                            const bytes=await context.invoke({{operation:'read',slot:'attachments',start,end:chunkEnd}});
                            if(bytes.length!==chunkEnd-start) throw new Error('incomplete original attachment');
                            text+=decoder.decode(new Uint8Array(bytes),{{stream:true}});
                        }}
                        text+=decoder.decode();
                        texts.push(text);
                        offset=end;
                    }}
                    if(offset!==descriptor.bytes) throw new Error('attachment manifest does not cover original bundle');
                    suffix=' / attachment: '+texts.join(' | ');
                }}
                return {{status:'completed',text:input.message+' / '+input.settings.model+suffix}};
            }}}};"#,serde_json::to_string(&maka_agent_api::executor::contract()).unwrap()).into_bytes())
        ])).unwrap();
            composition.instances.insert(
                "executor".into(),
                Node {
                    key: Uuid::from_u128(22),
                    package: package.application_ref().into(),
                    use_package: PackageUse::Host,
                    configuration: Default::default(),
                    parameters: Default::default(),
                    disabled: false,
                    overrides: vec![],
                    bindings: BTreeMap::new(),
                },
            );
            packages.push(package);
        }
        (composition, packages)
    }
    pub(super) fn provide(&self, native: &mut NativeRegistry, capture: FixtureCapture) {
        let (_, _, behavior) = self.state();
        crate::owner::tests::provide_without_workhub(native).unwrap();
        crate::workhub::provide_captured(
            native,
            bundled_catalog(),
            Arc::new(move |owner| {
                *capture.lock().unwrap() = Some((owner.clone(), owner.recall.services.clone()));
            }),
        )
        .unwrap();
        if !matches!(
            behavior,
            WorkerBehavior::Returned | WorkerBehavior::DeniedQuery(_) | WorkerBehavior::External
        ) {
            native
                .insert(
                    "fixture.lost-agent".into(),
                    Arc::new(move |context, settings| {
                        let behavior = behavior.clone();
                        Box::pin(async move {
                            let owner = Arc::new(Worker(
                                Agent(
                                    Owner::open(
                                        context,
                                        settings,
                                        crate::owner::tests::bundled_catalog(),
                                    )
                                    .await
                                    .unwrap(),
                                ),
                                behavior,
                            ));
                            NativeActivation {
                                owner: owner.clone(),
                                exports: Ok(BTreeMap::from([(
                                    EXPORT.into(),
                                    maka_plugin_core::runtime::Published {
                                        contract: contract(),
                                        value: owner as Arc<dyn Handler>,
                                    },
                                )])),
                            }
                        })
                    }),
                )
                .unwrap();
        }
    }
    pub(super) fn policy(&self) -> Arc<maka_transport::transport::PeerPolicy> {
        let (_, granted, behavior) = self.state();
        let external = matches!(behavior, WorkerBehavior::External);
        let denied_query = match behavior {
            WorkerBehavior::DeniedQuery(method) => Some(method),
            _ => None,
        };
        Arc::new(
            maka_transport::transport::PeerPolicy::with_native_grants(if granted {
                let mut grants = vec![maka_transport::transport::NativeGrant {
                    origin: id(1),
                    consumer: id(1),
                    provider: id(21),
                    export: EXPORT.into(),
                    methods: [
                        "list",
                        "directories",
                        "create",
                        "uploadAttachment",
                        "send",
                        "execution",
                        "execute",
                        "executors",
                        "tools",
                        "snapshotPatch",
                        "readPatch",
                        "work",
                        "observe",
                        "watch",
                        "stop",
                        "resume",
                        "queue",
                        "editQueue",
                    ]
                    .into_iter()
                    .filter(|method| Some(*method) != denied_query)
                    .map(str::to_owned)
                    .collect(),
                    recovery: true,
                }];
                if external {
                    grants.push(maka_transport::transport::NativeGrant {
                        origin: id(21),
                        consumer: id(21),
                        provider: id(22),
                        export: "executor".into(),
                        methods: ["execute".into()].into_iter().collect(),
                        recovery: true,
                    });
                }
                grants
            } else {
                vec![]
            })
            .unwrap(),
        )
    }
}

async fn activate_worker_mode(
    fixture: &mut Fixture,
    install: bool,
    workers: bool,
    granted: bool,
    behavior: WorkerBehavior,
) -> Arc<Owner> {
    let setup = if workers {
        Setup::Worker { behavior, granted }
    } else {
        Setup::Coordinator
    };
    let source = fixture.app.source().unwrap().clone();
    fixture.app.shutdown().await.unwrap();
    if install {
        let (composition, packages) = setup.composition(&fixture.owner.settings);
        fixture
            .store
            .commit_application(
                source.deployment,
                source.revision,
                composition,
                vec![],
                packages,
            )
            .await
            .unwrap();
    }
    let mut native = NativeRegistry::default();
    let captured = Arc::new(StdMutex::new(None));
    setup.provide(&mut native, captured.clone());
    maka_settings_native::provide(&mut native, bundled_catalog()).unwrap();
    fixture.app = Application::start_from_store(
        fixture.store.clone(),
        source.deployment,
        native,
        fixture.issuer.clone(),
        Arc::new(Grant(fixture.issuer.clone(), Some(setup.policy()))),
        Some(maka_host_js::factory(Default::default())),
    )
    .await
    .unwrap();
    fixture.app.ready().await.unwrap();
    let (owner, services) = captured
        .lock()
        .unwrap()
        .take()
        .expect("actual coordinator Owner");
    fixture.owner = owner.clone();
    fixture.services = services;
    owner
}
async fn binding(fixture: &Fixture) -> Binding {
    let client = fixture.app.client();
    client
        .bind(client.activation(&id(2)).unwrap(), hub::EXPORT.into())
        .await
        .unwrap()
        .remove(0)
}
async fn coordinator(fixture: &Fixture) -> Value {
    fixture
        .app
        .client()
        .start(
            binding(fixture).await,
            "coordinator".into(),
            json!({}),
            scope(&fixture.issuer, true),
            Attachments::default().into(),
        )
        .await
        .unwrap()
        .result()
        .await
        .unwrap()
}
async fn prepare(
    fixture: &Fixture,
    selection: Value,
    operation: Uuid,
) -> maka_host_runtime::application::PreparedMutation {
    fixture
        .app
        .client()
        .prepare_mutation(
            binding(fixture).await,
            "resolve".into(),
            json!({"workspace":selection}),
            scope(&fixture.issuer, true),
            operation,
            Attachments::default().into(),
        )
        .await
        .unwrap()
}
pub(super) async fn resolve(fixture: &Fixture, selection: Value, operation: Uuid) -> Value {
    let prepared = prepare(fixture, selection, operation).await;
    let recorded = fixture
        .store
        .record_application_intent(
            prepared.reference().source.clone(),
            prepared.consumer().instance().clone(),
            prepared.reference().clone(),
            Value::Null,
        )
        .await
        .unwrap();
    let reply = fixture
        .app
        .client()
        .mutate(prepared, recorded)
        .await
        .unwrap()
        .result()
        .await;
    match reply.receipt {
        Receipt::Recorded {
            outcome: OperationOutcome::Returned { value },
            cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
        } => value,
        other => panic!("unexpected coordinator receipt {other:?}"),
    }
}
pub(super) async fn selection(fixture: &Fixture) -> Value {
    fixture
        .query("directories", json!({"kind":"roots"}))
        .await
        .unwrap()["roots"][0]["selection"]
        .clone()
}

#[tokio::test]
async fn workhub_concurrent_resolution_reactivation_and_old_agent_namespace() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let mut fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
        let old = fixture.create("ordinary Agent").await;
        activate(&mut fixture, true).await;
        assert_eq!(coordinator(&fixture).await, json!({"kind":"missing"}));
        assert!(
            fixture
                .query("observe", json!({"sessionId":old}))
                .await
                .is_err()
        );
        let selected = selection(&fixture).await;
        let op = Uuid::new_v4();
        let (a, b) = tokio::join!(
            resolve(&fixture, selected.clone(), op),
            resolve(&fixture, selected.clone(), Uuid::new_v4())
        );
        assert_eq!(a, b);
        assert_eq!(a["kind"], "ready");
        assert_ne!(a["session"]["id"], old);
        assert_eq!(resolve(&fixture, selected.clone(), op).await, a);
        assert_eq!(coordinator(&fixture).await, a);
        activate(&mut fixture, false).await;
        // Resolving an accepted original coordinator never revalidates a later path.
        std::fs::rename(&fixture.workspace, fixture.workspace.with_extension("gone")).unwrap();
        assert_eq!(resolve(&fixture, selected, Uuid::new_v4()).await, a);
        assert_eq!(coordinator(&fixture).await, a);
        let page = fixture
            .query("list", json!({"filter":"all","position":{"kind":"start"}}))
            .await
            .unwrap();
        assert_eq!(page["sessions"].as_array().unwrap().len(), 1);
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn workhub_invalid_directory_does_not_freeze_an_intent() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let fixture = Fixture::workhub("http://127.0.0.1:1/v1", Setup::Coordinator).await;
        let selected = selection(&fixture).await;
        let mut invalid = selected.clone();
        invalid["rootId"] = json!("unknown");
        assert_eq!(
            resolve(&fixture, invalid, Uuid::new_v4()).await,
            json!({"kind":"rejected","reason":"workspace_unavailable"})
        );
        assert_eq!(coordinator(&fixture).await, json!({"kind":"missing"}));
        assert_eq!(
            resolve(&fixture, selected, Uuid::new_v4()).await["kind"],
            "ready"
        );
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn workhub_persisted_intent_recovers_original_identity_before_session_creation() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let mut fixture = Fixture::workhub("http://127.0.0.1:1/v1", Setup::Coordinator).await;
        let selected = selection(&fixture).await;
        let prepared = prepare(&fixture, selected.clone(), Uuid::new_v4()).await;
        let reference = prepared.reference().clone();
        drop(prepared);
        let prefix = maka_host_runtime::storage::instance_prefix(
            &reference.source.state_domain,
            reference.source.deployment,
            &reference.namespace,
        );
        let prefix = format!("wh_{}", &prefix[3..]);
        let digest = hex::encode(Sha256::digest(serde_json::to_vec(&reference).unwrap()));
        let expected = format!("{}{}", prefix, &digest[..32]);
        fixture
            .store
            .plugin_data_batch(
                &maka_capabilities::storage::Namespace::new(
                    hub::IMPLEMENTATION,
                    maka_plugin_core::scope::Scope::Profile,
                )
                .unwrap(),
                vec![maka_capabilities::storage::Mutation {
                    key: format!("{prefix}coordinator"),
                    expected_revision: None,
                    data: maka_capabilities::storage::Data::Present(
                        json!({"operation":reference,"workspace":selected}),
                    ),
                }],
            )
            .await
            .unwrap();
        assert_eq!(
            coordinator(&fixture).await,
            json!({"kind":"pending","workspace":selected})
        );
        activate(&mut fixture, false).await;
        let mut different = selected.clone();
        different["rootId"] = json!("ignored-later-choice");
        let ready = resolve(&fixture, different, Uuid::new_v4()).await;
        assert_eq!(ready["session"]["id"], expected);
        assert_eq!(coordinator(&fixture).await, ready);
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn workhub_uses_original_agent_engine_and_freezes_coordinator_prompt() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::workhub(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            Setup::Coordinator,
        )
        .await;
        let ready = resolve(&fixture, selection(&fixture).await, Uuid::new_v4()).await;
        let session = ready["session"]["id"].as_str().unwrap();
        let sent = fixture.send(session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = request(&mut socket).await;
        assert!(!fixture.app.shutdown_if_idle().await.unwrap());
        response(&mut socket).await;
        loop {
            let execution = fixture
                .query(
                    "execution",
                    json!({"sessionId":session,"invocationId":sent["invocationId"]}),
                )
                .await
                .unwrap();
            if execution["execution"]["state"] == "completed" {
                break;
            }
            tokio::task::yield_now().await;
        }
        let boundary = fixture
            .session(session)
            .await
            .invocation_boundary(session, sent["invocationId"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap()
            .0;
        let config = fixture
            .session(&(boundary.invocation).session_id)
            .await
            .invocation_configuration(&boundary.invocation)
            .await
            .unwrap()
            .unwrap();
        let prompt = config.system_prompt.unwrap();
        let frozen_system = session_context::composition(&fixture, session).await;
        while !fixture.app.shutdown_if_idle().await.unwrap() {
            tokio::task::yield_now().await;
        }
        fixture.config.shutdown().await.unwrap();
        assert!(
            request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| {
                    message["role"] == "system"
                        && message["content"]
                            .as_str()
                            .is_some_and(|text| text.contains(&prompt.text))
                })
        );
        assert_eq!(prompt.sources[0].name, hub::IMPLEMENTATION);
        session_context::assert_current_context(&request, &ready["session"]);
        session_context::assert_frozen_context(&request, &frozen_system);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn workhub_queued_message_keeps_original_behavior_across_activation() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut fixture = Fixture::workhub(&format!("http://{}/v1", listener.local_addr().unwrap()), Setup::Coordinator).await;
        let ready = resolve(&fixture, selection(&fixture).await, Uuid::new_v4()).await;
        let session = ready["session"]["id"].as_str().unwrap().to_owned();
        let sent = fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        let queued = fixture.mutation(2, "send", json!({"sessionId":session,"message":"Follow up after shutdown","model":fixture.selection().await}), Uuid::new_v4()).await.unwrap();
        assert_eq!(queued["kind"], "queued");
        let queue = fixture.session(&session).await.message_queue(&session).await.unwrap();
        let original = queue.entries.iter().find(|entry| entry.source.message.message_id == queued["messageId"]).unwrap().execution.basis["behavior"].clone();
        assert!(original["text"].as_str().unwrap().contains("WorkHub coordinator"));
        activate(&mut fixture, false).await;
        drop(socket);
        let (mut socket, _) = listener.accept().await.unwrap();
        let delivered = request(&mut socket).await;
        assert!(delivered["messages"].to_string().contains("Follow up after shutdown"));
        response(&mut socket).await;
        let invocation = loop {
            let observed = fixture.query("observe", json!({"sessionId":session})).await.unwrap();
            if observed["run"].is_null() {
                let boundary = fixture.session(&session).await.observe_session::<StoredSessionConfiguration>(&session).await.unwrap().unwrap().root_turn.unwrap();
                if boundary.invocation.invocation_id != sent["invocationId"] {
                    break boundary.invocation;
                }
            }
            tokio::task::yield_now().await;
        };
        let config = fixture.session(&(invocation).session_id).await.invocation_configuration(&invocation).await.unwrap().unwrap();
        assert_eq!(serde_json::to_value(config.system_prompt.unwrap()).unwrap(), original);
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

async fn imported(fixture: &Fixture, import: &str) -> Binding {
    let client = fixture.app.client();
    client
        .bind(client.activation(&id(2)).unwrap(), import.into())
        .await
        .unwrap()
        .remove(0)
}
async fn query_import(fixture: &Fixture, import: &str, method: &str, input: Value) -> Value {
    fixture
        .app
        .client()
        .start(
            imported(fixture, import).await,
            method.into(),
            input.clone(),
            scope(&fixture.issuer, true),
            Attachments::default().into(),
        )
        .await
        .unwrap_or_else(|error| panic!("start {import}.{method}({input}) failed: {error:?}"))
        .result()
        .await
        .unwrap_or_else(|error| panic!("query {import}.{method}({input}) failed: {error:?}"))
}
async fn worker_mutation(fixture: &Fixture, method: &str, input: Value) -> Value {
    let client = fixture.app.client();
    let prepared = client
        .prepare_mutation(
            imported(fixture, "worker").await,
            method.into(),
            input,
            scope(&fixture.issuer, true),
            Uuid::new_v4(),
            Attachments::default().into(),
        )
        .await
        .unwrap();
    let recorded = fixture
        .store
        .record_application_intent(
            prepared.reference().source.clone(),
            prepared.consumer().instance().clone(),
            prepared.reference().clone(),
            Value::Null,
        )
        .await
        .unwrap();
    let reply = client
        .mutate(prepared, recorded)
        .await
        .unwrap()
        .result()
        .await;
    let Receipt::Recorded {
        outcome: OperationOutcome::Returned { value },
        ..
    } = reply.receipt
    else {
        panic!("{reply:?}")
    };
    value
}
async fn worker_session(fixture: &Fixture) -> String {
    let roots = query_import(fixture, "worker", "directories", json!({"kind":"roots"})).await;
    worker_mutation(fixture,"create",json!({"title":"Worker","labels":[],"workspace":{"kind":"directory","selection":roots["roots"][0]["selection"]}})).await["session"]["id"].as_str().unwrap().into()
}
async fn task_response(socket: &mut TcpStream, input: Value) {
    let input = json!({"request": input});
    let delta = json!({"id":"task-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":Uuid::new_v4().to_string(),"type":"function","function":{"name":"workhub_tasks","arguments":input.to_string()}}]},"finish_reason":null}]});
    let body = format!(
        "data: {delta}\n\ndata: {{\"id\":\"task-model\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n"
    );
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
async fn first_task(fixture: &Fixture) -> String {
    loop {
        let tasks = query_import(fixture, hub::EXPORT, "tasks", json!({})).await;
        if let Some(id) = tasks["entries"][0]["taskId"].as_str() {
            return id.into();
        }
        tokio::task::yield_now().await;
    }
}
async fn idle(fixture: &Fixture, import: &str, session: &str) {
    loop {
        let observation =
            query_import(fixture, import, "observe", json!({"sessionId":session})).await;
        if observation["run"].is_null() {
            return;
        }
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn workhub_real_model_routes_original_input_and_recovers_child_receipt_without_redispatch() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut fixture = Fixture::workhub(&format!("http://{}/v1",listener.local_addr().unwrap()), Setup::workers()).await;
        let worker=worker_session(&fixture).await;
        let ready=resolve(&fixture,selection(&fixture).await,Uuid::new_v4()).await;
        let coordinator=ready["session"]["id"].as_str().unwrap().to_owned();
        let mut list_watch = fixture.app.client().subscribe(imported(&fixture, hub::EXPORT).await, "watchTasks".into(), json!({}), scope(&fixture.issuer,true), Attachments::default().into()).await.unwrap();
        assert_eq!(list_watch.recv().await.unwrap()["entries"], json!([]));
        fixture.send(&coordinator).await.unwrap();
        let (mut socket,_)=listener.accept().await.unwrap();
        let initial=request(&mut socket).await;
        assert!(initial["tools"].to_string().contains("workhub_tasks"));
        let acceptance_lower_bound = maka_agent_authority::now();
        task_response(&mut socket,json!({"operation":"route","worker":"worker","target":{"kind":"existing","sessionId":worker},"note":"Process this assigned work","model":fixture.selection().await})).await;
        let mut worker_calls=0;
        let mut task_watch = None;
        let mut routed_task_id = None;
        for _ in 0..3 {
            let (mut socket,_)=listener.accept().await.unwrap();
            let input=request(&mut socket).await;
            if !is_coordinator(&input) {
                worker_calls+=1;
                let page = list_watch.recv().await.unwrap();
                let id = page["entries"][0]["taskId"].clone();
                routed_task_id = Some(id.as_str().unwrap().to_owned());
                task_watch = Some(fixture.app.client().subscribe(imported(&fixture, hub::EXPORT).await, "watchTask".into(), json!({"taskId": id}), scope(&fixture.issuer,true), Attachments::default().into()).await.unwrap());
                assert_eq!(task_watch.as_mut().unwrap().recv().await.unwrap()["taskId"], id);
                assert!(input["messages"].to_string().contains("Hello"));
                assert!(input["messages"].to_string().contains("Process this assigned work"));
            } else {
                assert!(input["messages"].to_string().contains("wt_"));
                if input["messages"].to_string().contains("Original worker observation:") {
                    assert!(input["messages"].to_string().contains("Elegant response"));
                    assert!(input["messages"].to_string().contains("has ended"));
                }
            }
            response(&mut socket).await;
        }
        assert_eq!(worker_calls,1);
        loop {
            let observed = task_watch.as_mut().unwrap().recv().await.unwrap();
            if observed["status"]["progress"]["execution"]["state"] == "completed" {
                assert_eq!(observed["status"]["progress"]["answer"]["text"], "Elegant response");
                break;
            }
        }
        drop(task_watch); drop(list_watch);
        idle(&fixture,EXPORT,&coordinator).await;
        idle(&fixture,"worker",&worker).await;
        let task_id=first_task(&fixture).await;
        assert_eq!(routed_task_id.as_deref(), Some(task_id.as_str()));
        let listed_before_restart = query_import(&fixture,hub::EXPORT,"tasks",json!({})).await;
        assert_eq!(listed_before_restart["entries"][0]["title"],"Hello");
        let task=query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task_id})).await;
        let acceptance_upper_bound = maka_agent_authority::now();
        assert_eq!(task["status"]["kind"],"started");
        assert_eq!(task["status"]["progress"]["execution"]["state"],"completed");
        assert_eq!(task["status"]["progress"]["answer"]["text"],"Elegant response");
        let originals=fixture.store.application_intents(fixture.app.source().unwrap().deployment,id(1),0,128).await.unwrap();
        assert_eq!(originals.len(),1);
        assert_eq!(originals[0].reference.namespace,id(21));
        assert_eq!(originals[0].reference.method,"send");
        assert_eq!(task["operation"], originals[0].reference.operation.to_string());
        let namespace = maka_capabilities::storage::Namespace::new(hub::IMPLEMENTATION, maka_plugin_core::scope::Scope::Profile).unwrap();
        let records = fixture.store.plugin_data_scan(&namespace, maka_capabilities::storage::Scan { prefix: String::new(), after: None }).await.unwrap();
        let record = records.entries.into_iter().find(|entry| entry.key.ends_with(&format!("tasks/{task_id}"))).unwrap();
        let maka_capabilities::storage::Data::Present(mut value) = record.record.data else { panic!("task data"); };
        assert!(!value["notification"]["admission"].is_null());
        let frozen_admission = value["notification"]["admission"].clone();
        let notification_message_id = frozen_admission["source"]["message_id"].as_str().unwrap().to_owned();
        // The same body submitted through the public API has no trusted provenance.
        let notice_body = frozen_admission["source"]["content"]["text"].as_str().unwrap();
        let spoofed = fixture.mutation(2,"send",json!({"sessionId":coordinator,"message":notice_body,"model":fixture.selection().await,
            "origin":{"kind":"workhub_task","taskId":task_id}}),Uuid::new_v4()).await;
        let ordinary = fixture.mutation(2,"send",json!({"sessionId":coordinator,"message":notice_body,"model":fixture.selection().await}),Uuid::new_v4()).await.unwrap();
        let ordinary_message_id = ordinary["messageId"].as_str().unwrap().to_owned();
        let (mut socket,_) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response(&mut socket).await;
        idle(&fixture,EXPORT,&coordinator).await;
        value["notification"]["accepted"] = json!(false);
        fixture.store.plugin_data_batch(&namespace, vec![maka_capabilities::storage::Mutation {
            key: record.key, expected_revision: Some(record.record.revision), data: maka_capabilities::storage::Data::Present(value),
        }]).await.unwrap();
        activate_workers(&mut fixture,false,true,true).await;
        let restored=query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task_id})).await;
        let listed_after_restart = query_import(&fixture,hub::EXPORT,"tasks",json!({})).await;
        assert_eq!(restored["status"]["invocationId"],task["status"]["invocationId"]);
        assert_eq!(restored["operation"],task["operation"]);
        // A new activation reads the original source without becoming the old executor.
        assert_eq!(restored["status"]["progress"],task["status"]["progress"]);
        for method in ["observe", "work"] {
            activate_worker_mode(&mut fixture,false,true,true,WorkerBehavior::DeniedQuery(method)).await;
            let denied=query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task_id})).await;
            assert_eq!(denied["status"]["invocationId"],task["status"]["invocationId"]);
            assert!(denied["status"]["progress"].is_null(),"source identity is never a {method} grant");
        }
        for field in ["session", "stateDomain", "deployment", "namespace"] {
            let calls=Arc::new(std::sync::atomic::AtomicUsize::new(0));
            activate_worker_mode(&mut fixture,true,true,true,WorkerBehavior::ChangedObservation(field,calls.clone())).await;
            let changed=query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task_id})).await;
            assert_eq!(changed["status"]["invocationId"],task["status"]["invocationId"]);
            assert!(changed["status"]["progress"].is_null(),"{field} must match the original receipt");
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst),0,"mismatched observations cannot trigger work queries");
        }
        assert_eq!(fixture.store.application_intents(fixture.app.source().unwrap().deployment,id(1),0,128).await.unwrap().len(),1);
        assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err());
        // Read the immutable notice after outbox replay and worker reactivation;
        // display attribution must not depend on the worker's current observation.
        let records = fixture.store.plugin_data_scan(&namespace, maka_capabilities::storage::Scan {prefix:String::new(),after:None}).await.unwrap();
        let replayed = records.entries.into_iter().find(|entry| entry.key.ends_with(&format!("tasks/{task_id}"))).unwrap();
        let maka_capabilities::storage::Data::Present(replayed) = replayed.record.data else {panic!("task data");};
        let canonical = fixture.session(&(coordinator)).await.scoped_prefix(maka_agent_facts::event::LogScope::Session {id:coordinator.clone()},256,4*1024*1024).await.unwrap();
        let sources: Vec<_> = canonical.events.iter().filter_map(|row| match &row.event.fact {
            Fact::InvocationOpened {input:maka_agent_facts::input::InvocationInput::Message {source_messages,..},..} => Some(source_messages.as_slice()),
            _ => None,
        }).flatten().filter(|source| source.message.message_id == notification_message_id)
            .map(|source| serde_json::to_value(&source.message).unwrap()).collect();
        let mut history_request = json!({"sessionId":coordinator,"position":{"kind":"start"}});
        let ordinary_sources: Vec<_> = canonical.events.iter().filter_map(|row| match &row.event.fact {
            Fact::InvocationOpened {input:maka_agent_facts::input::InvocationInput::Message {source_messages,..},..} => Some(source_messages.as_slice()),
            _ => None,
        }).flatten().filter(|source| source.message.message_id == ordinary_message_id)
            .map(|source| serde_json::to_value(&source.message).unwrap()).collect();
        let mut notice_chunks = Vec::new();
        let mut ordinary_chunks = Vec::new();
        let mut history_finished = false;
        for _ in 0..128 {
            let page = fixture.query("history",history_request.clone()).await.unwrap();
            history_request["through"] = page["through"].clone();
            assert_eq!(page["kind"], "ready");
            notice_chunks.extend(page["chunks"].as_array().unwrap().iter()
                .filter(|chunk| chunk["role"] == "user" && chunk["messageId"] == notification_message_id)
                .cloned());
            ordinary_chunks.extend(page["chunks"].as_array().unwrap().iter()
                .filter(|chunk| chunk["role"] == "user" && chunk["messageId"] == ordinary_message_id)
                .cloned());
            if page["after"].is_null() {history_finished = true;break;}
            history_request["position"] = json!({"kind":"after","cursor":page["after"]});
        }
        fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
        assert_eq!(task["title"],"Hello","task detail must carry the original request title independently of list state");
        let accepted_at = task["acceptedAt"].as_u64().expect("task detail must expose its Host acceptance time");
        assert!((acceptance_lower_bound..=acceptance_upper_bound).contains(&accepted_at),"acceptance time {accepted_at} must fall within the actual route admission interval {acceptance_lower_bound}..={acceptance_upper_bound}");
        for entry in [&listed_before_restart["entries"][0], &listed_after_restart["entries"][0], &restored] {
            assert_eq!(entry["taskId"],task_id);
            assert_eq!(entry["title"],"Hello");
            assert_eq!(entry["acceptedAt"],accepted_at,"task metadata must match list/detail and remain frozen across restart");
        }
        let expected_origin = json!({"kind":"workhub_task","taskId":task_id});
        assert_eq!(frozen_admission["source"]["origin"], expected_origin, "actual task notification must freeze structured origin before admission");
        assert_eq!(replayed["notification"]["admission"], frozen_admission, "outbox replay must retain the original notification identity and origin");
        assert_eq!(sources.len(),1,"outbox replay must not duplicate the canonical notice");
        assert_eq!(sources[0]["origin"],expected_origin);
        assert!(history_finished,"history must reach its captured fence");
        assert!(!notice_chunks.is_empty(),"public history must contain the actual frozen notification message");
        for chunk in notice_chunks {assert_eq!(chunk["origin"],expected_origin);}
        assert!(spoofed.is_err(),"public send must reject an origin setter");
        assert_eq!(ordinary_sources.len(),1);
        assert!(ordinary_sources[0].get("origin").is_none(),"matching notice wording cannot stamp trusted source metadata");
        assert!(!ordinary_chunks.is_empty());
        for chunk in ordinary_chunks {assert!(chunk.get("origin").is_none());}
    }).await.unwrap();
}

#[tokio::test]
async fn workhub_routing_to_busy_worker_follows_exact_queued_message_after_later_work() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut fixture = Fixture::workhub(&format!("http://{}/v1",listener.local_addr().unwrap()), Setup::workers()).await;
        let worker=worker_session(&fixture).await;
        let busy=worker_mutation(&fixture,"send",json!({"sessionId":worker,"message":"Unrelated running work","model":fixture.selection().await})).await;
        let (mut running,_)=listener.accept().await.unwrap();request(&mut running).await;
        let ready=resolve(&fixture,selection(&fixture).await,Uuid::new_v4()).await;
        let coordinator=ready["session"]["id"].as_str().unwrap().to_owned();
        fixture.send(&coordinator).await.unwrap();
        let (mut socket,_)=listener.accept().await.unwrap();request(&mut socket).await;
        task_response(&mut socket,json!({"operation":"route","worker":"worker","target":{"kind":"existing","sessionId":worker},"note":"Queued assignment","model":fixture.selection().await})).await;
        let (mut socket,_)=listener.accept().await.unwrap();request(&mut socket).await;response(&mut socket).await;
        let task_id=first_task(&fixture).await;
        let queued=query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task_id})).await;
        assert_eq!(queued["status"]["kind"],"queued");
        assert_eq!(queued["status"]["progress"]["kind"],"pending");
        response(&mut running).await;
        let (mut socket,_)=listener.accept().await.unwrap();
        let input=request(&mut socket).await;assert!(input["messages"].to_string().contains("Queued assignment"));response(&mut socket).await;
        idle(&fixture,"worker",&worker).await;
        let delivered=query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task_id})).await;
        assert_eq!(delivered["status"]["progress"]["kind"],"delivered");
        assert_eq!(delivered["status"]["progress"]["shared"],false);
        assert_ne!(delivered["status"]["progress"]["execution"]["invocationId"],busy["invocationId"]);
        worker_mutation(&fixture,"send",json!({"sessionId":worker,"message":"Later separate work","model":fixture.selection().await})).await;
        let (mut socket,_)=listener.accept().await.unwrap();request(&mut socket).await;response(&mut socket).await;
        idle(&fixture,"worker",&worker).await;
        let original=query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task_id})).await;
        assert_eq!(original,delivered,"task follows its message, never the Session tip");
        activate_workers(&mut fixture,false,true,true).await;
        let restored=query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task_id})).await;
        assert_eq!(restored,original,"restarted observation still follows the original message");
        let refused=control_turn(&fixture,&listener,&coordinator,json!({"operation":"control","taskId":task_id,"action":{"kind":"resume","model":fixture.selection().await}})).await;
        assert_eq!(refused["status"]["kind"],"unavailable","readable history cannot authorize replacement execution");
        assert_eq!(fixture.store.application_intents(fixture.app.source().unwrap().deployment,id(1),0,128).await.unwrap().len(),1);
        assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err());
        fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn workhub_selected_worker_requires_independent_native_dispatch_grant() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut fixture = Fixture::workhub(&format!("http://{}/v1",listener.local_addr().unwrap()), Setup::Worker { behavior: WorkerBehavior::Returned, granted: false }).await;
        let worker=worker_session(&fixture).await;
        let ready=resolve(&fixture,selection(&fixture).await,Uuid::new_v4()).await;
        let coordinator=ready["session"]["id"].as_str().unwrap().to_owned();
        fixture.send(&coordinator).await.unwrap();
        let (mut socket,_)=listener.accept().await.unwrap();request(&mut socket).await;
        task_response(&mut socket,json!({"operation":"route","worker":"worker","target":{"kind":"existing","sessionId":worker},"note":"Denied assignment","model":fixture.selection().await})).await;
        let (mut socket,_)=listener.accept().await.unwrap();
        let next=request(&mut socket).await;assert!(!next["messages"].to_string().contains("Original user request:"));response(&mut socket).await;
        idle(&fixture,EXPORT,&coordinator).await;
        let task_id=first_task(&fixture).await;
        let task=query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task_id})).await;
        assert_eq!(task["status"]["kind"],"pending");
        let worker_view=query_import(&fixture,"worker","observe",json!({"sessionId":worker})).await;
        assert!(worker_view["run"].is_null());
        assert!(fixture.store.application_intents(fixture.app.source().unwrap().deployment,id(1),0,128).await.unwrap().is_empty());
        assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err());
        // The durable assignment precedes dispatch. New grants and activation cannot
        // convert that old intent into a fresh call on a replacement binding.
        activate_workers(&mut fixture,false,true,true).await;
        fixture.send(&coordinator).await.unwrap();
        let (mut socket,_)=listener.accept().await.unwrap();request(&mut socket).await;
        task_response(&mut socket,json!({"operation":"advance","taskId":task_id})).await;
        let (mut socket,_)=listener.accept().await.unwrap();let input=request(&mut socket).await;
        assert!(input["messages"].to_string().contains("unavailable"));
        assert!(!input["messages"].to_string().contains("Original user request:"));response(&mut socket).await;
        idle(&fixture,EXPORT,&coordinator).await;
        assert!(fixture.store.application_intents(fixture.app.source().unwrap().deployment,id(1),0,128).await.unwrap().is_empty());
        fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[derive(Clone)]
pub(super) enum WorkerBehavior {
    Returned,
    External,
    OneSessionPage,
    DeniedQuery(&'static str),
    ChangedObservation(&'static str, Arc<std::sync::atomic::AtomicUsize>),
    Lost(&'static str),
    Watched(Arc<tokio::sync::Semaphore>),
    Blocked(Arc<Blocked>),
}
pub(super) struct Blocked {
    method: &'static str,
    entered: tokio::sync::Semaphore,
    cancelled: tokio::sync::Semaphore,
    release: tokio::sync::Semaphore,
}
struct Worker(Agent, WorkerBehavior);
impl Handler for Worker {
    fn call(
        &self,
        method: String,
        input: Value,
        context: maka_host_runtime::application::Context,
    ) -> BoxFuture<'static, Result<Value, String>> {
        let owner = self.0.0.clone();
        let behavior = self.1.clone();
        Box::pin(async move {
            if let WorkerBehavior::Watched(entered) = &behavior
                && method == "watch"
            {
                entered.add_permits(1);
            }
            if let WorkerBehavior::Blocked(blocked) = &behavior
                && method == blocked.method
            {
                blocked.entered.add_permits(1);
                context.scope().cancellation.cancelled().await;
                blocked.cancelled.add_permits(1);
                blocked.release.acquire().await.unwrap().forget();
            }
            if let WorkerBehavior::ChangedObservation(_, calls) = &behavior
                && method == "work"
            {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            let mut value = Agent(owner).call(method.clone(), input, context).await?;
            if let WorkerBehavior::ChangedObservation(field, _) = &behavior
                && method == "observe"
            {
                match *field {
                    "session" => value["session"]["id"] = json!("different-session"),
                    "stateDomain" => {
                        value["session"]["dataSource"][field] = json!("different-root")
                    }
                    "deployment" => value["session"]["dataSource"][field] = json!(Uuid::new_v4()),
                    "namespace" => value["session"]["dataSource"][field] = json!(id(99)),
                    _ => panic!("unknown observation fixture field"),
                }
            }
            if matches!(behavior, WorkerBehavior::OneSessionPage) && method == "list" {
                let rows = value["sessions"].as_array_mut().unwrap();
                if rows.len() > 1 {
                    rows.truncate(1);
                    let cursor = rows[0]["id"].clone();
                    value["after"] = cursor;
                }
            }
            if matches!(&behavior, WorkerBehavior::Lost(lost) if method == *lost) {
                Err("fixture lost reply after real worker admission".into())
            } else {
                Ok(value)
            }
        })
    }
}
impl NativeOwner for Worker {
    fn activated(&self) {
        self.0.0.activated();
    }
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        self.0.0.close()
    }
}
#[tokio::test]
async fn workhub_unknown_worker_admission_keeps_original_receipt_across_source_update_and_advance()
{
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut fixture = Fixture::workhub(&format!("http://{}/v1",listener.local_addr().unwrap()), Setup::worker(WorkerBehavior::Lost("send"))).await;
        let worker=worker_session(&fixture).await;
        let ready=resolve(&fixture,selection(&fixture).await,Uuid::new_v4()).await;
        let coordinator=ready["session"]["id"].as_str().unwrap().to_owned();
        fixture.send(&coordinator).await.unwrap();
        let (mut socket,_)=listener.accept().await.unwrap();request(&mut socket).await;
        task_response(&mut socket,json!({"operation":"route","worker":"worker","target":{"kind":"existing","sessionId":worker},"note":"Executed despite lost reply","model":fixture.selection().await})).await;
        let mut effects=0;
        for _ in 0..2 {
            let (mut socket,_)=listener.accept().await.unwrap();let input=request(&mut socket).await;
            if input["messages"].to_string().contains("Original user request:") {effects+=1;} else {assert!(input["messages"].to_string().contains("uncertain"));}
            response(&mut socket).await;
        }
        idle(&fixture,EXPORT,&coordinator).await;idle(&fixture,"worker",&worker).await;
        assert_eq!(effects,1);
        let task_id=first_task(&fixture).await;
        let original=query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task_id})).await;
        assert_eq!(original["status"]["kind"],"uncertain");
        let intents=fixture.store.application_intents(fixture.app.source().unwrap().deployment,id(1),0,128).await.unwrap();
        assert_eq!(intents.len(),1);
        let reference=intents[0].reference.clone();
        activate_workers(&mut fixture,true,true,true).await;
        assert!(fixture.app.source().unwrap().revision > reference.source.revision);
        assert_eq!(query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task_id})).await,original);
        fixture.send(&coordinator).await.unwrap();
        let (mut socket,_)=listener.accept().await.unwrap();request(&mut socket).await;
        task_response(&mut socket,json!({"operation":"advance","taskId":task_id})).await;
        let (mut socket,_)=listener.accept().await.unwrap();let input=request(&mut socket).await;
        assert!(!input["messages"].to_string().contains("Original user request:"));
        assert!(input["messages"].to_string().contains("uncertain"));response(&mut socket).await;
        idle(&fixture,EXPORT,&coordinator).await;
        assert_eq!(query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task_id})).await,original);
        let receipt=fixture.store.operation(&reference).unwrap().operation_observation().await.unwrap().unwrap();
        assert!(matches!(receipt.outcome,OperationOutcome::Unknown {..}));
        assert_eq!(fixture.store.application_intents(fixture.app.source().unwrap().deployment,id(1),0,128).await.unwrap().len(),1);
        assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err());
        fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn workhub_cancelled_worker_queries_and_mutations_reach_cleanup_budget() {
    for method in ["list", "send", "uploadAttachment"] {
        tokio::time::timeout(Duration::from_secs(30), async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let blocked = Arc::new(Blocked { method, entered: tokio::sync::Semaphore::new(0), cancelled: tokio::sync::Semaphore::new(0), release: tokio::sync::Semaphore::new(0) });
            let fixture = Fixture::workhub(&format!("http://{}/v1",listener.local_addr().unwrap()), Setup::worker(WorkerBehavior::Blocked(blocked.clone()))).await;
            let coordinator_owner = fixture.owner.clone();
            let worker = worker_session(&fixture).await;
            let ready = resolve(&fixture,selection(&fixture).await,Uuid::new_v4()).await;
            let coordinator = ready["session"]["id"].as_str().unwrap().to_owned();
            let sent = if method == "uploadAttachment" {
                let uploaded=attachments::upload(&fixture,&coordinator,"blocked.txt",b"original bytes",Uuid::new_v4()).await.unwrap();
                fixture.mutation(2,"send",json!({"sessionId":coordinator,"message":"Transfer original attachment","attachments":[uploaded["attachment"]["id"]],"model":fixture.selection().await}),Uuid::new_v4()).await.unwrap()
            } else { fixture.send(&coordinator).await.unwrap() };
            let (mut socket,_) = listener.accept().await.unwrap();request(&mut socket).await;
            task_response(&mut socket, if method == "list" { json!({"operation":"sessions","worker":"worker"}) } else { json!({"operation":"route","worker":"worker","target":{"kind":"existing","sessionId":worker},"note":"Blocked admission","model":fixture.selection().await}) }).await;
            blocked.entered.acquire().await.unwrap().forget();
            fixture.mutation(2,"stop",json!({"sessionId":coordinator,"invocationId":sent["invocationId"]}),Uuid::new_v4()).await.unwrap();
            blocked.cancelled.acquire().await.unwrap().forget();
            // Physical callback stays owned beyond the original five-second budget.
            tokio::time::timeout(Duration::from_secs(8), async {
                while !coordinator_owner.workers.is_empty() { tokio::task::yield_now().await; }
            }).await.unwrap();
            assert!(coordinator_owner.runs.lock().await.quarantined.contains(&coordinator));
            assert!(fixture.app.client().snapshot().instances.iter().any(|instance| instance.activation.instance() == &id(21) && instance.calls > 0));
            let facts = fixture.facts_after_failed_shutdown(&coordinator).await;
            assert!(!facts.iter().any(|fact| matches!(fact,Fact::ToolSettled { .. })));
            blocked.release.add_permits(1);
            assert!(fixture.app.shutdown().await.is_err());
            assert!(!fixture.app.client().snapshot().closed);
            fixture.config.shutdown().await.unwrap();
            eprintln!("Retained WorkHub cleanup-failure Root: {}",fixture._dir.keep().display());
        }).await.unwrap();
    }
}

#[tokio::test]
async fn workhub_queued_input_cannot_adopt_reactivated_worker_bindings() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut fixture = Fixture::workhub(&format!("http://{}/v1",listener.local_addr().unwrap()), Setup::workers()).await;
        let ready=resolve(&fixture,selection(&fixture).await,Uuid::new_v4()).await;
        let session=ready["session"]["id"].as_str().unwrap().to_owned();
        fixture.send(&session).await.unwrap();
        let (mut socket,_)=listener.accept().await.unwrap();request(&mut socket).await;
        let queued=fixture.mutation(2,"send",json!({"sessionId":session,"message":"Keep original workers","model":fixture.selection().await}),Uuid::new_v4()).await.unwrap();
        assert_eq!(queued["kind"],"queued");
        activate_workers(&mut fixture,false,true,true).await;drop(socket);
        let resolved=loop {
            let value=fixture.query("work",json!({"sessionId":session,"target":{"kind":"message","messageId":queued["messageId"]}})).await.unwrap();
            if value["kind"] == "delivered" {break value;}
            tokio::task::yield_now().await;
        };
        assert_eq!(resolved["execution"]["state"],"failed");
        let facts=fixture.session(&(session)).await.scoped_prefix(maka_agent_facts::event::LogScope::Session {id:session},256,4*1024*1024).await.unwrap();
        assert!(facts.events.iter().any(|event| matches!(&event.event.fact,Fact::InvocationEnded {outcome:maka_agent_facts::event::InvocationOutcome::Failed {message:Some(message),..}} if message == "agent_tools_changed")));
        assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err());
        fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

fn is_coordinator(input: &Value) -> bool {
    input["messages"].as_array().unwrap().iter().any(|message| {
        message["role"] == "system"
            && message["content"]
                .as_str()
                .unwrap_or_default()
                .contains("WorkHub coordinator")
    })
}
fn tool_value(input: &Value) -> Value {
    let message = input["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .unwrap();
    serde_json::from_str(message["content"].as_str().unwrap())
        .unwrap_or_else(|error| panic!("{error}: {}", message["content"]))
}
fn is_worker_notice(input: &Value) -> bool {
    input["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "user")
        .is_some_and(|message| {
            message["content"]
                .to_string()
                .contains("Original worker observation:")
        })
}
// A completion can arrive between explicit coordinator turns. Consume that
// independent real model request before scripting the next user-triggered tool.
async fn coordinator_request(listener: &TcpListener) -> (TcpStream, Value) {
    loop {
        let (mut socket, _) = listener.accept().await.unwrap();
        // Host retirement can close a connected transport before it writes an
        // HTTP request. Once any byte exists, the original parser stays strict.
        if socket.peek(&mut [0; 1]).await.unwrap() == 0 {
            continue;
        }
        let input = request(&mut socket).await;
        assert!(is_coordinator(&input), "unexpected model request: {input}");
        if is_worker_notice(&input) {
            response(&mut socket).await;
        } else {
            return (socket, input);
        }
    }
}
async fn control_turn(
    fixture: &Fixture,
    listener: &TcpListener,
    coordinator: &str,
    input: Value,
) -> Value {
    fixture.send(coordinator).await.unwrap();
    let (mut socket, _) = coordinator_request(listener).await;
    task_response(&mut socket, input).await;
    let (mut socket, next) = coordinator_request(listener).await;
    let result = tool_value(&next);
    response(&mut socket).await;
    idle(fixture, EXPORT, coordinator).await;
    result
}
async fn active_task(
    fixture: &Fixture,
    listener: &TcpListener,
    worker: &str,
) -> (String, String, TcpStream) {
    let ready = resolve(fixture, selection(fixture).await, Uuid::new_v4()).await;
    let coordinator = ready["session"]["id"].as_str().unwrap().to_owned();
    fixture.send(&coordinator).await.unwrap();
    let (mut socket, _) = listener.accept().await.unwrap();
    request(&mut socket).await;
    task_response(&mut socket,json!({"operation":"route","worker":"worker","target":{"kind":"existing","sessionId":worker},"note":"Original assigned work","model":fixture.selection().await})).await;
    let mut running = None;
    for _ in 0..2 {
        let (mut socket, _) = listener.accept().await.unwrap();
        let input = request(&mut socket).await;
        if is_coordinator(&input) {
            response(&mut socket).await;
        } else {
            running = Some(socket);
        }
    }
    idle(fixture, EXPORT, &coordinator).await;
    (coordinator, first_task(fixture).await, running.unwrap())
}
#[tokio::test]
async fn workhub_control_preserves_stop_resume_and_unknown_originals_without_retargeting() {
    for lost in [false, true] {
        tokio::time::timeout(Duration::from_secs(60), async {
            let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut fixture = Fixture::workhub(&format!("http://{}/v1",listener.local_addr().unwrap()), Setup::worker(if lost {WorkerBehavior::Lost("resume")} else {WorkerBehavior::Returned})).await;
            let worker=worker_session(&fixture).await;
            let (coordinator,task_id,running)=active_task(&fixture,&listener,&worker).await;
            let original=query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task_id})).await;
            let stopped=control_turn(&fixture,&listener,&coordinator,json!({"operation":"control","taskId":task_id,"action":{"kind":"stop"}})).await;
            assert_eq!(stopped["status"]["kind"],"returned");
            assert_eq!(stopped["status"]["outcome"]["kind"],"stop");
            assert_eq!(stopped["status"]["outcome"]["result"]["requested"],true);
            drop(running);idle(&fixture,"worker",&worker).await;
            assert_eq!(query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task_id})).await["status"]["progress"]["execution"]["state"],"cancelled");
            fixture.send(&coordinator).await.unwrap();
            let (mut socket,_)=coordinator_request(&listener).await;
            task_response(&mut socket,json!({"operation":"control","taskId":task_id,"action":{"kind":"resume","model":fixture.selection().await}})).await;
            let mut resumed=None;let mut worker_calls=0;
            for _ in 0..2 {
                let (mut socket,_)=listener.accept().await.unwrap();let input=request(&mut socket).await;
                if is_coordinator(&input) {resumed=Some(tool_value(&input));response(&mut socket).await;}
                else {assert!(input["messages"].to_string().contains("Original assigned work"));worker_calls+=1;response_with_text(&mut socket,"Resumed worker result").await;}
            }
            assert_eq!(worker_calls,1);idle(&fixture,EXPORT,&coordinator).await;idle(&fixture,"worker",&worker).await;
            let resumed=resumed.unwrap();assert_eq!(resumed["status"]["kind"],if lost {"uncertain"} else {"returned"});
            let completed=control_turn(&fixture,&listener,&coordinator,json!({"operation":"inspect","taskId":task_id})).await;
            assert_eq!(completed["status"]["invocationId"],original["status"]["invocationId"]);
            assert_ne!(completed["status"]["progress"]["execution"]["invocationId"],original["status"]["invocationId"]);
            assert_eq!(completed["status"]["progress"]["answer"]["text"],"Resumed worker result");
            let controls=query_import(&fixture,hub::EXPORT,"controls",json!({})).await;
            assert_eq!(controls["entries"].as_array().unwrap().len(),2);
            // New work must not become the target of an old stop's recovery.
            let later=worker_mutation(&fixture,"send",json!({"sessionId":worker,"message":"Later unrelated work","model":fixture.selection().await})).await;
            // The completed resumed task can notify its coordinator before this
            // unrelated worker request reaches the shared model listener.
            let mut later_socket=loop {
                let (mut socket,_)=listener.accept().await.unwrap();
                let input=request(&mut socket).await;
                if is_coordinator(&input) {
                    assert!(input["messages"].as_array().unwrap().iter().rev().find(|message| message["role"] == "user").unwrap()["content"].to_string().contains("Original worker observation:"));
                    response(&mut socket).await;
                } else {
                    assert_eq!(input["messages"].as_array().unwrap().last().unwrap()["content"],"Later unrelated work");
                    break socket;
                }
            };
            assert_eq!(control_turn(&fixture,&listener,&coordinator,json!({"operation":"advance_control","controlId":stopped["controlId"]})).await,stopped);
            let view=query_import(&fixture,"worker","observe",json!({"sessionId":worker})).await;
            assert_eq!(view["run"]["invocationId"],later["invocationId"]);
            response(&mut later_socket).await;idle(&fixture,"worker",&worker).await;
            activate_workers(&mut fixture,true,true,true).await;
            assert_eq!(query_import(&fixture,hub::EXPORT,"control",json!({"controlId":resumed["controlId"]})).await,resumed);
            assert_eq!(control_turn(&fixture,&listener,&coordinator,json!({"operation":"advance_control","controlId":resumed["controlId"]})).await,resumed);
            assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err());
            fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
        }).await.unwrap();
    }
}
#[tokio::test]
async fn workhub_stop_retracts_only_its_pending_message_and_preserves_unrelated_running_work() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::workhub(&format!("http://{}/v1",listener.local_addr().unwrap()), Setup::workers()).await;
        let worker=worker_session(&fixture).await;
        let busy=worker_mutation(&fixture,"send",json!({"sessionId":worker,"message":"Unrelated current work","model":fixture.selection().await})).await;
        let (mut running,_)=listener.accept().await.unwrap();request(&mut running).await;
        let ready=resolve(&fixture,selection(&fixture).await,Uuid::new_v4()).await;
        let coordinator=ready["session"]["id"].as_str().unwrap().to_owned();
        let queued=control_turn(&fixture,&listener,&coordinator,json!({"operation":"route","worker":"worker","target":{"kind":"existing","sessionId":worker},"note":"Pending task","model":fixture.selection().await})).await;
        assert_eq!(queued["status"]["kind"],"queued");
        let stopped=control_turn(&fixture,&listener,&coordinator,json!({"operation":"control","taskId":queued["taskId"],"action":{"kind":"stop"}})).await;
        assert_eq!(stopped["status"]["outcome"]["kind"],"retract");assert_eq!(stopped["status"]["outcome"]["result"]["kind"],"committed");
        assert_eq!(query_import(&fixture,hub::EXPORT,"task",json!({"taskId":queued["taskId"]})).await["status"]["progress"]["kind"],"cancelled");
        assert_eq!(query_import(&fixture,"worker","observe",json!({"sessionId":worker})).await["run"]["invocationId"],busy["invocationId"]);
        response(&mut running).await;idle(&fixture,"worker",&worker).await;
        // Retraction reports its terminal outcome to the coordinator. Observe
        // that original cancellation notice before checking for duplicate work.
        let (mut notice, _) = listener.accept().await.unwrap();
        let input = request(&mut notice).await;
        assert!(is_coordinator(&input), "retracted worker was dispatched: {input}");
        let text = input["messages"].as_array().unwrap().iter().rev()
            .find(|message| message["role"] == "user").unwrap()["content"]
            .as_str().unwrap();
        let observation: Value = serde_json::from_str(
            text.split_once("Original worker observation:\n").unwrap().1
        ).unwrap();
        assert_eq!(observation["taskId"], queued["taskId"]);
        assert_eq!(observation["status"]["progress"]["kind"], "cancelled");
        response(&mut notice).await;
        idle(&fixture, EXPORT, &coordinator).await;
        assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err());
        fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn workhub_shared_delivery_never_authorizes_stop_of_the_original_worker_run() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::workhub(&format!("http://{}/v1",listener.local_addr().unwrap()), Setup::workers()).await;
        let worker=worker_session(&fixture).await;
        let busy=worker_mutation(&fixture,"send",json!({"sessionId":worker,"message":"Original worker owner","model":fixture.selection().await})).await;
        let (mut running,_)=listener.accept().await.unwrap();request(&mut running).await;
        let ready=resolve(&fixture,selection(&fixture).await,Uuid::new_v4()).await;
        let coordinator=ready["session"]["id"].as_str().unwrap().to_owned();
        let queued=control_turn(&fixture,&listener,&coordinator,json!({"operation":"route","worker":"worker","target":{"kind":"existing","sessionId":worker},"note":"Shared steering input","model":fixture.selection().await})).await;
        let queue=query_import(&fixture,"worker","queue",json!({"sessionId":worker})).await;
        let promoted=worker_mutation(&fixture,"editQueue",json!({"sessionId":worker,"expectedRevision":queue["revision"],"edit":{"kind":"promote","messageId":queued["status"]["messageId"]}})).await;
        assert_eq!(promoted["kind"],"committed");
        // Even an unavailable tool produces a real next step, where steering is consumed.
        task_response(&mut running,json!({"operation":"workers"})).await;
        let (mut next,_)=listener.accept().await.unwrap();let input=request(&mut next).await;
        assert!(!is_coordinator(&input));assert!(input["messages"].to_string().contains("Shared steering input"));
        let task=query_import(&fixture,hub::EXPORT,"task",json!({"taskId":queued["taskId"]})).await;
        assert_eq!(task["status"]["progress"]["shared"],true);
        let stopped=control_turn(&fixture,&listener,&coordinator,json!({"operation":"control","taskId":queued["taskId"],"action":{"kind":"stop"}})).await;
        assert_eq!(stopped,json!({"kind":"rejected","reason":"shared_work"}));
        assert_eq!(query_import(&fixture,hub::EXPORT,"controls",json!({})).await["entries"],json!([]));
        assert_eq!(query_import(&fixture,"worker","observe",json!({"sessionId":worker})).await["run"]["invocationId"],busy["invocationId"]);
        response(&mut next).await;idle(&fixture,"worker",&worker).await;
        fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}
#[tokio::test]
async fn workhub_session_tool_browses_live_catalog_across_coordinator_turns() {
    tokio::time::timeout(Duration::from_secs(60), async {
        for behavior in [WorkerBehavior::Returned, WorkerBehavior::OneSessionPage] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let fixture = Fixture::workhub(
                &format!("http://{}/v1", listener.local_addr().unwrap()),
                Setup::worker(behavior),
            )
            .await;
            let mut expected = std::collections::BTreeSet::new();
            for _ in 0..6 {
                expected.insert(worker_session(&fixture).await);
            }
            let ready = resolve(&fixture, selection(&fixture).await, Uuid::new_v4()).await;
            let coordinator = ready["session"]["id"].as_str().unwrap().to_owned();
            let mut position = Value::Null;
            let mut found = std::collections::BTreeSet::new();
            let mut pages = 0;
            loop {
                let page = control_turn(
                    &fixture,
                    &listener,
                    &coordinator,
                    json!({"operation":"sessions","worker":"worker","after":position}),
                )
                .await;
                assert!(page.to_string().encode_utf16().count() < 7500);
                assert!(page["sessions"].as_array().unwrap().len() <= 4);
                for session in page["sessions"].as_array().unwrap() {
                    assert!(found.insert(session["id"].as_str().unwrap().to_owned()));
                }
                pages += 1;
                position = page["after"].clone();
                if position.is_null() {
                    break;
                }
                assert!(position.as_str().is_some());
            }
            assert_eq!(found, expected);
            assert!(pages > 1);
            fixture.app.shutdown().await.unwrap();
            fixture.config.shutdown().await.unwrap();
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn workhub_wait_returns_worker_answer_in_the_routing_turn_and_cancels_only_observation() {
    let _log_guard = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::WARN)
            .with_test_writer()
            .with_ansi(false)
            .finish(),
    );
    tokio::time::timeout(Duration::from_secs(60), async {
        for cancel in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let entered = Arc::new(tokio::sync::Semaphore::new(0));
            let fixture = Fixture::workhub(&format!("http://{}/v1",listener.local_addr().unwrap()), Setup::worker(WorkerBehavior::Watched(entered.clone()))).await;
            let worker = worker_session(&fixture).await;
            let ready = resolve(&fixture,selection(&fixture).await,Uuid::new_v4()).await;
            let coordinator = ready["session"]["id"].as_str().unwrap();
            let accepted = fixture.send(coordinator).await.unwrap();
            let (mut socket,_) = listener.accept().await.unwrap();request(&mut socket).await;
            task_response(&mut socket,json!({"operation":"route","worker":"worker","target":{"kind":"existing","sessionId":worker},"note":"Return the worker result","model":fixture.selection().await})).await;
            let mut running = None;
            let mut task = None;
            for _ in 0..2 {
                let (mut socket,_) = listener.accept().await.unwrap();
                let input = request(&mut socket).await;
                if is_coordinator(&input) {
                    let routed = tool_value(&input);
                    assert_eq!(routed["status"]["kind"],"started");
                    task = Some(routed["taskId"].clone());
                    task_response(&mut socket,json!({"operation":"wait","taskId":routed["taskId"]})).await;
                } else {running=Some(socket);}
            }
            entered.acquire().await.unwrap().forget();
            assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err());
            if cancel {
                fixture.mutation(2,"stop",json!({"sessionId":coordinator,"invocationId":accepted["invocationId"]}),Uuid::new_v4()).await.unwrap();
                idle(&fixture,EXPORT,coordinator).await;
                // Logical run completion precedes the Host's independent watch
                // cleanup acknowledgement. Wait for that observable owner too.
                while fixture.app.client().snapshot().instances.iter().any(|instance| instance.activation.instance() == &id(21) && instance.calls != 0) {
                    tokio::task::yield_now().await;
                }
                assert!(fixture.app.client().snapshot().instances.iter().filter(|instance| instance.activation.instance() == &id(21)).all(|instance| instance.calls == 0),"watch cleaned before independent worker completion");
                assert_eq!(query_import(&fixture,"worker","observe",json!({"sessionId":worker})).await["run"]["state"],"running");
            }
            response(&mut running.unwrap()).await;
            if !cancel {
                let (mut socket,_) = listener.accept().await.unwrap();
                let input=request(&mut socket).await;
                let result=tool_value(&input);
                assert_eq!(result["taskId"],task.unwrap());
                assert_eq!(result["status"]["progress"]["execution"]["state"],"completed");
                assert_eq!(result["status"]["progress"]["answer"]["text"],"Elegant response");
                response(&mut socket).await;
                idle(&fixture,EXPORT,coordinator).await;
            }
            idle(&fixture,"worker",&worker).await;
            fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
        }
    }).await.unwrap();
}

#[tokio::test]
async fn workhub_creates_selected_worker_and_transfers_original_attachment_bytes_before_send() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut fixture = Fixture::workhub(&format!("http://{}/v1",listener.local_addr().unwrap()), Setup::workers()).await;
        let ready=resolve(&fixture,selection(&fixture).await,Uuid::new_v4()).await;
        let coordinator=ready["session"]["id"].as_str().unwrap().to_owned();
        let directories=control_turn(&fixture,&listener,&coordinator,json!({"operation":"directories","worker":"worker","location":{"kind":"roots"}})).await;
        let directory=directories["roots"][0]["selection"].clone();
        assert!(directory.is_object());
        let mut files: Vec<_> = (0..9).map(|index| (format!("transfer-{index}.txt"), if index == 0 { "original user attachment\n中\0".repeat(6000).into_bytes() } else { format!("original user attachment {index}\n中\0tail-{index}").into_bytes() })).collect();
        if let Ok(size) = std::env::var("MAKA_WORKHUB_ARTIFACT_PROBE_BYTES") {
            let size: usize = size.parse().expect("MAKA_WORKHUB_ARTIFACT_PROBE_BYTES must be an integer");
            let pattern = b"original user attachment\n\0";
            let mut bytes = pattern.repeat(size / pattern.len() + 1);
            bytes.truncate(size);
            files[0].1 = bytes;
        }
        let mut sources=Vec::new();
        for (name,bytes) in &files {
            let uploaded=attachments::upload(&fixture,&coordinator,name,bytes,Uuid::new_v4()).await.unwrap();
            sources.push(uploaded["attachment"]["id"].as_str().unwrap().to_owned());
        }
        fixture.mutation(2,"send",json!({"sessionId":coordinator,"message":"Use my attached file","attachments":sources,"model":fixture.selection().await}),Uuid::new_v4()).await.unwrap();
        let (mut socket,_)=listener.accept().await.unwrap();request(&mut socket).await;
        task_response(&mut socket,json!({"operation":"route","worker":"worker","target":{"kind":"new","title":"New assigned worker","workspace":directory},"note":"Check the original file","model":fixture.selection().await})).await;
        let mut dispatched=None;
        let mut worker_calls=0;
        for _ in 0..2 {
            let (mut socket,_)=listener.accept().await.unwrap();let input=request(&mut socket).await;
            if is_coordinator(&input) {dispatched=Some(tool_value(&input));} else {
                worker_calls+=1;
                assert!(input["messages"].to_string().contains("Use my attached file"));
                for source in &sources { assert!(!input["messages"].to_string().contains(source),"foreign artifact IDs must never be forwarded as worker authority"); }
            }
            response(&mut socket).await;
        }
        assert_eq!(worker_calls,1);
        let task=dispatched.unwrap();assert_eq!(task["status"]["kind"],"started");
        assert_eq!(query_import(&fixture,hub::EXPORT,"tasks",json!({})).await["entries"][0]["title"],"New assigned worker");
        let worker=task["status"]["sessionId"].as_str().unwrap();
        idle(&fixture,EXPORT,&coordinator).await;idle(&fixture,"worker",worker).await;
        let artifacts=fixture.session(worker).await.list_artifacts(worker,0,10).await.unwrap();assert_eq!(artifacts.records.len(),9);
        for ((name,bytes),source) in files.iter().zip(&sources) {
            let copied=artifacts.records.iter().find(|record|record.name==*name).unwrap();
            assert_ne!(&copied.id,source);
            assert_eq!(copied.session_id,worker);
            assert_eq!(copied.size_bytes,bytes.len() as u64);
            assert_eq!(copied.summary.as_deref(),Some(maka_agent_facts::artifact::content_digest(bytes).as_str()));
            assert!(fixture.session(worker).await.read_artifact_chunk(worker,&copied.id,0,bytes.len()).await.unwrap().unwrap().bytes==*bytes,"original transfer bytes differ: {name}");
        }
        let through=fixture.through(worker).await;
        let events=fixture.session(worker).await.session_events(worker,0,through,512,usize::MAX).await.unwrap();
        let received=events.events.iter().find_map(|stored|match &stored.event.fact {
            Fact::InvocationOpened {input:maka_agent_facts::event::InvocationInput::Message {content,..},..}=>content.attachments.as_ref(),
            _=>None,
        }).unwrap();
        assert_eq!(received.len(),9);
        for (attachment,(name,bytes)) in received.iter().zip(&files) {
            assert_eq!(&attachment.name,name);
            assert_eq!(attachment.bytes,bytes.len() as u64);
            let copied=artifacts.records.iter().find(|record|record.name==*name).unwrap();
            assert_eq!(attachment.storage_ref,maka_agent_facts::attachment::StorageRef::SessionFile {session_id:worker.into(),relative_path:copied.id.clone()});
        }
        let records=fixture.store.application_intents(fixture.app.source().unwrap().deployment,id(1),0,128).await.unwrap();
        let methods:Vec<_>=std::iter::once("create").chain(std::iter::repeat_n("uploadAttachment",9)).chain(std::iter::once("send")).collect();
        assert_eq!(records.iter().map(|row|row.reference.method.as_str()).collect::<Vec<_>>(),methods);
        assert_eq!(query_import(&fixture,"worker","list",json!({"filter":"all","position":{"kind":"start"}})).await["sessions"].as_array().unwrap().len(),1);
        let replay=control_turn(&fixture,&listener,&coordinator,json!({"operation":"advance","taskId":task["taskId"]})).await;
        assert_eq!(replay["status"]["invocationId"],task["status"]["invocationId"]);
        assert_eq!(fixture.session(worker).await.list_artifacts(worker,0,10).await.unwrap().records.len(),9);
        while let Ok(accepted)=tokio::time::timeout(Duration::from_millis(30),listener.accept()).await {
            let (mut socket,_)=accepted.unwrap();let input=request(&mut socket).await;
            assert!(is_coordinator(&input)&&is_worker_notice(&input),"advance redispatched work instead of receiving the original completion notice: {input}");
            response(&mut socket).await;
            idle(&fixture,EXPORT,&coordinator).await;
        }
        activate_workers(&mut fixture,false,true,true).await;
        let restored=query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task["taskId"]})).await;
        assert_eq!(restored["status"]["sessionId"],worker);assert_eq!(restored["status"]["invocationId"],task["status"]["invocationId"]);
        assert_eq!(restored["status"]["progress"]["answer"]["text"],"Elegant response");
        assert_eq!(fixture.store.application_intents(fixture.app.source().unwrap().deployment,id(1),0,128).await.unwrap().len(),11);
        fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn workhub_unknown_preparation_never_recreates_or_reuploads_on_advance() {
    for method in ["create", "uploadAttachment"] {
        tokio::time::timeout(Duration::from_secs(60), async {
            let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut fixture = Fixture::workhub(&format!("http://{}/v1",listener.local_addr().unwrap()), Setup::worker(WorkerBehavior::Lost(method))).await;
            let ready=resolve(&fixture,selection(&fixture).await,Uuid::new_v4()).await;
            let coordinator=ready["session"]["id"].as_str().unwrap().to_owned();
            let roots=query_import(&fixture,"worker","directories",json!({"kind":"roots"})).await;
            let uploaded=attachments::upload(&fixture,&coordinator,"original.txt",b"original bytes",Uuid::new_v4()).await.unwrap();
            fixture.mutation(2,"send",json!({"sessionId":coordinator,"message":"Use my attached file","attachments":[uploaded["attachment"]["id"]],"model":fixture.selection().await}),Uuid::new_v4()).await.unwrap();
            let (mut socket,_)=listener.accept().await.unwrap();request(&mut socket).await;
            task_response(&mut socket,json!({"operation":"route","worker":"worker","target":{"kind":"new","title":"Frozen preparation","workspace":roots["roots"][0]["selection"]},"note":"Use original input","model":fixture.selection().await})).await;
            let (mut socket,_)=listener.accept().await.unwrap();let next=request(&mut socket).await;
            assert!(is_coordinator(&next));let original=tool_value(&next);
            assert_eq!(original["status"]["kind"],"preparing");
            assert_eq!(original["status"]["state"]["kind"],"uncertain");
            response(&mut socket).await;idle(&fixture,EXPORT,&coordinator).await;
            let sessions=query_import(&fixture,"worker","list",json!({"filter":"all","position":{"kind":"start"}})).await;
            let sessions=sessions["sessions"].as_array().unwrap();assert_eq!(sessions.len(),1);
            let worker=sessions[0]["id"].as_str().unwrap().to_owned();
            let count=usize::from(method=="uploadAttachment");
            assert_eq!(fixture.session(&worker).await.list_artifacts(&worker,0,10).await.unwrap().records.len(),count);
            let records=fixture.store.application_intents(fixture.app.source().unwrap().deployment,id(1),0,128).await.unwrap();
            assert_eq!(records.len(),count+1);assert_eq!(records.last().unwrap().reference.method,method);
            let reference=records.last().unwrap().reference.clone();
            activate_workers(&mut fixture,true,true,true).await;
            assert_eq!(query_import(&fixture,hub::EXPORT,"task",json!({"taskId":original["taskId"]})).await,original);
            assert_eq!(control_turn(&fixture,&listener,&coordinator,json!({"operation":"advance","taskId":original["taskId"]})).await,original);
            assert_eq!(fixture.session(&worker).await.list_artifacts(&worker,0,10).await.unwrap().records.len(),count);
            assert_eq!(fixture.store.application_intents(fixture.app.source().unwrap().deployment,id(1),0,128).await.unwrap().len(),count+1);
            assert!(matches!(fixture.store.operation(&reference).unwrap().operation_observation().await.unwrap().unwrap().outcome,OperationOutcome::Unknown {..}));
            assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err());
            fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
        }).await.unwrap();
    }
}

#[tokio::test]
async fn workhub_directory_pages_preserve_choices_and_stale_choice_cannot_create() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture=Fixture::workhub(&format!("http://{}/v1",listener.local_addr().unwrap()),Setup::workers()).await;
        let names=(0..9).map(|n|format!("project-{n}-{}","长目录".repeat(15))).collect::<Vec<_>>();
        for name in &names { std::fs::create_dir(fixture.workspace.join(name)).unwrap(); }
        let ready=resolve(&fixture,selection(&fixture).await,Uuid::new_v4()).await;
        let coordinator=ready["session"]["id"].as_str().unwrap().to_owned();
        let roots=control_turn(&fixture,&listener,&coordinator,json!({"operation":"directories","worker":"worker","location":{"kind":"roots"}})).await;
        let mut after=Value::Null;let mut seen=Vec::new();let mut choice=Value::Null;
        loop {
            let page=control_turn(&fixture,&listener,&coordinator,json!({"operation":"directories","worker":"worker","location":{"kind":"children","selection":roots["roots"][0]["selection"],"after":after}})).await;
            assert!(page.to_string().encode_utf16().count()<=7000);
            let rows=page["children"].as_array().unwrap();assert!(rows.len()<=4);
            for row in rows { let name=row["selection"]["segments"][0].as_str().unwrap();seen.push(name.to_owned());assert!(row["nameExcerpt"].as_str().unwrap().len()<name.len());choice=row["selection"].clone(); }
            after=page["after"].clone();if after.is_null(){break;}
            assert_eq!(after,seen.last().unwrap().as_str());
        }
        assert_eq!(seen,names);
        let last=names.last().unwrap();
        std::fs::rename(fixture.workspace.join(last),fixture.workspace.join("moved")).unwrap();
        std::fs::create_dir(fixture.workspace.join(last)).unwrap();
        let rejected=control_turn(&fixture,&listener,&coordinator,json!({"operation":"route","worker":"worker","target":{"kind":"new","title":"Stale workspace","workspace":choice},"note":"Cannot use replacement directory","model":fixture.selection().await})).await;
        assert_eq!(rejected["status"]["kind"],"preparing");assert_eq!(rejected["status"]["state"]["kind"],"rejected");assert_eq!(rejected["status"]["state"]["reason"],"workspace_unavailable");
        assert!(query_import(&fixture,"worker","list",json!({"filter":"all","position":{"kind":"start"}})).await["sessions"].as_array().unwrap().is_empty());
        fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn workhub_unrecorded_upload_requires_original_capture_after_sql_recovery() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::workhub(&format!("http://{}/v1",listener.local_addr().unwrap()), Setup::workers()).await;
        let worker=worker_session(&fixture).await;
        let ready=resolve(&fixture,selection(&fixture).await,Uuid::new_v4()).await;
        let coordinator=ready["session"]["id"].as_str().unwrap().to_owned();
        let uploaded=attachments::upload(&fixture,&coordinator,"original.txt",b"original bytes",Uuid::new_v4()).await.unwrap();
        let databases: Vec<_> = fixture.runtime_databases().into_iter().map(|path| rusqlite::Connection::open(path).unwrap()).collect();
        for raw in &databases { raw.execute_batch("CREATE TRIGGER hold_upload BEFORE INSERT ON application_operations WHEN json_extract(NEW.request_json,'$.method')='uploadAttachment' BEGIN SELECT RAISE(ABORT, 'fixture reservation unavailable'); END;").unwrap(); }
        fixture.mutation(2,"send",json!({"sessionId":coordinator,"message":"Use my file","attachments":[uploaded["attachment"]["id"]],"model":fixture.selection().await}),Uuid::new_v4()).await.unwrap();
        let (mut socket,_)=listener.accept().await.unwrap();request(&mut socket).await;
        task_response(&mut socket,json!({"operation":"route","worker":"worker","target":{"kind":"existing","sessionId":worker},"note":"Transfer original bytes","model":fixture.selection().await})).await;
        let (mut socket,_)=listener.accept().await.unwrap();assert!(is_coordinator(&request(&mut socket).await));response(&mut socket).await;idle(&fixture,EXPORT,&coordinator).await;
        let task=first_task(&fixture).await;
        let original=query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task})).await;
        assert_eq!(original["status"]["state"]["kind"],"original_capture_required");
        let intents=fixture.store.application_intents(fixture.app.source().unwrap().deployment,id(1),0,128).await.unwrap();assert_eq!(intents.len(),1);
        let reference=intents[0].reference.clone();assert_eq!(reference.method,"uploadAttachment");assert!(fixture.store.operation(&reference).unwrap().operation_observation().await.unwrap().is_none());
        for raw in &databases { raw.execute_batch("DROP TRIGGER hold_upload;").unwrap(); } drop(databases);
        assert_eq!(control_turn(&fixture,&listener,&coordinator,json!({"operation":"advance","taskId":task})).await,original);
        assert!(fixture.store.operation(&reference).unwrap().operation_observation().await.unwrap().is_none());
        assert!(fixture.session(&worker).await.list_artifacts(&worker,0,10).await.unwrap().records.is_empty());
        assert_eq!(fixture.store.application_intents(fixture.app.source().unwrap().deployment,id(1),0,128).await.unwrap().len(),1);
        assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err());
        fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn workhub_routes_external_executor_through_original_worker_and_recovers_answer() {
    tokio::time::timeout(Duration::from_secs(60),async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut fixture = Fixture::workhub(&format!("http://{}/v1",listener.local_addr().unwrap()), Setup::worker(WorkerBehavior::External)).await;
        let worker=worker_session(&fixture).await;
        let ready=resolve(&fixture,selection(&fixture).await,Uuid::new_v4()).await;
        let coordinator=ready["session"]["id"].as_str().unwrap().to_owned();
        let choices=control_turn(&fixture,&listener,&coordinator,json!({"operation":"executors","worker":"worker"})).await;
        assert_eq!(choices,json!({"executors":["external"],"setup":[]}));
        let uploaded=attachments::upload(&fixture,&coordinator,"worker-note.txt",b"original upload bytes",Uuid::new_v4()).await.unwrap();
        fixture.mutation(2,"send",json!({"sessionId":coordinator,"message":"Use the original upload","attachments":[uploaded["attachment"]["id"]],"model":fixture.selection().await}),Uuid::new_v4()).await.unwrap();
        let (mut socket,_)=listener.accept().await.unwrap();request(&mut socket).await;
        task_response(&mut socket,json!({"operation":"route","worker":"worker","target":{"kind":"existing","sessionId":worker},"note":"Use the explicit backend","executor":{"executor":"external","settings":{"model":"external-model"}}})).await;
        let (mut socket,_)=listener.accept().await.unwrap();let input=request(&mut socket).await;
        assert!(is_coordinator(&input));let routed=tool_value(&input);assert_eq!(routed["status"]["kind"],"started");
        task_response(&mut socket,json!({"operation":"wait","taskId":routed["taskId"]})).await;
        let (mut socket,_)=listener.accept().await.unwrap();let input=request(&mut socket).await;
        let task=tool_value(&input);assert_eq!(task["status"]["progress"]["execution"]["state"],"completed");
        let answer=task["status"]["progress"]["answer"]["text"].as_str().unwrap();
        assert!(answer.contains("Original user request:\nUse the original upload"));assert!(answer.contains("Use the explicit backend"));assert!(answer.ends_with(" / external-model / attachment: original upload bytes"));
        response(&mut socket).await;idle(&fixture,EXPORT,&coordinator).await;idle(&fixture,"worker",&worker).await;
        for (consumer,provider) in [(1,21),(21,22)] {
            let intents=fixture.store.application_intents(fixture.app.source().unwrap().deployment,id(consumer),0,128).await.unwrap();
            let executions:Vec<_>=intents.iter().filter(|v|v.reference.method=="execute").collect();
            assert_eq!(executions.len(),1);assert_eq!(executions[0].reference.namespace,id(provider));

        }
        activate_worker_mode(&mut fixture,false,true,true,WorkerBehavior::External).await;
        let restored=query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task["taskId"]})).await;
        assert_eq!(restored,task);
        assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err());
        fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn workhub_presets_freeze_selected_worker_tools_and_recover_after_restart() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut fixture=Fixture::workhub_configured(&format!("http://{}/v1",listener.local_addr().unwrap()),Setup::workers(),|settings| settings.isolated_workspaces=true).await;
        worktrees::git(&fixture.workspace,&["init","--quiet"]);
        worktrees::git(&fixture.workspace,&["config","user.email","test@example.invalid"]);
        worktrees::git(&fixture.workspace,&["config","user.name","Fixture"]);
        std::fs::write(fixture.workspace.join("tracked.txt"),"base\n").unwrap();
        worktrees::git(&fixture.workspace,&["add","tracked.txt"]);
        worktrees::git(&fixture.workspace,&["commit","--quiet","-m","base"]);
        let ready=resolve(&fixture,selection(&fixture).await,Uuid::new_v4()).await;
        let coordinator=ready["session"]["id"].as_str().unwrap().to_owned();
        let directory=query_import(&fixture,"worker","directories",json!({"kind":"roots"})).await["roots"][0]["selection"].clone();
        let selected=fixture.selection().await;
        let mut preset=json!({"id":"reasoner","name":"Reasoner","description":"Reason without tools", "worker":"worker", "tools":[],
            "model":{"connectionId":selected.connection_id,"modelId":selected.model_id},"thinkingLevel":null,"enabled":true,"isolatedWorkspace":true});
        let client=fixture.app.client();
        let prepared=client.prepare_mutation(binding(&fixture).await,"savePresets".into(),json!({"revision":null,"entries":[preset.clone()]}),scope(&fixture.issuer,true),Uuid::new_v4(),Attachments::default().into()).await.unwrap();
        let original=prepared.reference().clone();
        let intent=fixture.store.record_application_intent(original.source.clone(),prepared.consumer().instance().clone(),original.clone(),Value::Null).await.unwrap();
        let reply=client.mutate(prepared,intent).await.unwrap().result().await;
        assert!(matches!(reply.receipt,Receipt::Recorded{outcome:OperationOutcome::Returned{ref value},cleanup:maka_plugin_core::operation::OperationCleanup::Confirmed} if value["kind"] == "saved"));
        selection::edit(&fixture,|changes| changes.name=Some("Renamed connection after preset save".into())).await;
        fixture.mutation(2,"send",json!({"sessionId":coordinator,"message":"Delegate reasoning", "model":fixture.selection().await}),Uuid::new_v4()).await.unwrap();
        let (mut socket,_)=listener.accept().await.unwrap();request(&mut socket).await;
        task_response(&mut socket,json!({"operation":"route_preset","preset":"reasoner","title":"Restricted reasoning","workspace":directory,"note":"Solve the task"})).await;
        let mut task=None;
        for _ in 0..2 {
            let (mut socket,_)=listener.accept().await.unwrap();let input=request(&mut socket).await;
            if is_coordinator(&input) {
                let result=tool_value(&input);
                if result["status"]["kind"] != "started" {
                    response(&mut socket).await;
                    idle(&fixture,EXPORT,&coordinator).await;
                    fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
                    assert_eq!(result["status"]["kind"],"started","saved preset must remain reusable after a connection display-name change: {result}");
                }
                task=Some(result);
            } else {
                assert_eq!(input["model"],"fixture-model");
                assert!(input["tools"].is_null() || input["tools"].as_array().unwrap().is_empty());
            }
            response(&mut socket).await;
        }
        let task=task.unwrap();assert_eq!(task["status"]["kind"],"started");
        let worker=task["status"]["sessionId"].as_str().unwrap();
        idle(&fixture,EXPORT,&coordinator).await;idle(&fixture,"worker",worker).await;
        assert_eq!(query_import(&fixture,"worker","observe",json!({"sessionId":worker})).await["session"]["tools"],json!([]));
        let observed=query_import(&fixture,"worker","observe",json!({"sessionId":worker})).await;
        let presets=query_import(&fixture,hub::EXPORT,"presets",json!({})).await;
        preset["enabled"]=json!(false);
        preset["tools"]=json!(["Read"]);
        preset["model"]["modelId"]=json!("later-preset-model");
        let prepared=client.prepare_mutation(binding(&fixture).await,"savePresets".into(),json!({"revision":presets["revision"],"entries":[preset]}),scope(&fixture.issuer,true),Uuid::new_v4(),Attachments::default().into()).await.unwrap();
        let changed=client.mutate_owned(prepared).await.unwrap().result().await;
        assert!(matches!(changed.receipt,Receipt::Recorded{outcome:OperationOutcome::Returned{ref value},cleanup:maka_plugin_core::operation::OperationCleanup::Confirmed} if value["kind"] == "saved"));
        let advanced=control_turn(&fixture,&listener,&coordinator,json!({"operation":"advance","taskId":task["taskId"]})).await;
        let path=std::path::PathBuf::from(observed["session"]["workspace"]["path"].as_str().unwrap());
        assert!(path.starts_with(fixture.root.canonicalize().unwrap().join("subagent-worktrees")));
        std::fs::write(path.join("tracked.txt"),"worker patch\n").unwrap();
        let control=control_turn(&fixture,&listener,&coordinator,json!({"operation":"control","taskId":task["taskId"],"action":{"kind":"snapshot_patch"}})).await;
        assert_eq!(control["status"]["outcome"]["result"]["kind"],"ready","{control}");
        let page=control_turn(&fixture,&listener,&coordinator,json!({"operation":"read_patch","controlId":control["controlId"],"offset":0})).await;
        assert_eq!(page["kind"],"ready","{page}");
        assert!(page["text"].as_str().unwrap().contains("+worker patch"));
        assert!(page["next"].is_null());
        assert_eq!(std::fs::read_to_string(fixture.workspace.join("tracked.txt")).unwrap(),"base\n");
        activate_workers(&mut fixture,false,true,true).await;
        assert_eq!(query_import(&fixture,hub::EXPORT,"presets",json!({})).await["entries"][0]["id"],"reasoner");
        let restored=query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task["taskId"]})).await;
        assert_eq!(restored["status"]["invocationId"],task["status"]["invocationId"]);
        let restored_worker=query_import(&fixture,"worker","observe",json!({"sessionId":worker})).await;
        fixture.send(&coordinator).await.unwrap();
        let (mut socket,_)=coordinator_request(&listener).await;
        task_response(&mut socket,json!({"operation":"route_preset","preset":"reasoner","title":"Must not route disabled preset","workspace":directory,"note":"No new assignment"})).await;
        let (mut socket,refused)=coordinator_request(&listener).await;
        let refused_result=refused["messages"].as_array().unwrap().iter().rev().find(|message|message["role"] == "tool").unwrap()["content"].clone();
        response(&mut socket).await;
        idle(&fixture,EXPORT,&coordinator).await;
        let listed=query_import(&fixture,hub::EXPORT,"tasks",json!({})).await;
        let persisted_presets=query_import(&fixture,hub::EXPORT,"presets",json!({})).await;
        let intents=fixture.store.application_intents(fixture.app.source().unwrap().deployment,id(1),0,128).await.unwrap();
        fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
        let prefix=fixture.session(worker).await.scoped_prefix(maka_agent_facts::event::LogScope::Session {id:worker.to_owned()},256,4*1024*1024).await.unwrap();
        let original_invocation=task["status"]["invocationId"].as_str().unwrap();
        let mut lifecycle=[0usize;4];
        let mut requested_step=None;
        for event in prefix.events.iter().map(|row|&row.event).filter(|event|event.invocation.session_id == worker) {
            let index=match &event.fact {
                Fact::InvocationOpened {..} => 0,
                Fact::ModelRequested {purpose,model_id,step_id,..} => {
                    assert_eq!(*purpose,maka_agent_facts::context::ModelPurpose::Main);
                    assert_eq!(model_id,"fixture-model");
                    requested_step=Some(step_id);
                    1
                }
                Fact::ModelCompleted {step_id,..} => {
                    assert_eq!(Some(step_id),requested_step);
                    2
                }
                Fact::InvocationEnded {outcome} => {
                    assert_eq!(*outcome,maka_agent_facts::event::InvocationOutcome::Completed);
                    3
                }
                _ => continue,
            };
            assert_eq!(event.invocation.invocation_id,original_invocation);
            lifecycle[index]+=1;
        }
        assert_eq!(lifecycle,[1,1,1,1],"worker must keep one original opening, request, completion and ending across restart");
        for original_task in [&advanced,&restored] {
            assert_eq!(original_task["taskId"],task["taskId"]);
            assert_eq!(original_task["operation"],task["operation"]);
            assert_eq!(original_task["status"]["sessionId"],worker);
            assert_eq!(original_task["status"]["invocationId"],task["status"]["invocationId"]);
        }
        assert_eq!(restored_worker["session"]["tools"],json!([]));
        assert_eq!(restored_worker["metrics"]["modelId"],"fixture-model");
        assert_eq!(persisted_presets["entries"][0]["enabled"],false);
        assert_eq!(refused_result,"workhub_preset_disabled");
        assert_eq!(listed["entries"].as_array().unwrap().len(),1,"a disabled preset must not publish a new task");
        assert_eq!(intents.iter().filter(|intent|intent.reference.method == "send").count(),1,"accepted task advance/restart must not dispatch another worker message");
    }).await.unwrap();
}

#[tokio::test]
async fn workhub_dependencies_wait_cancel_and_dispatch_once_with_complete_original_answers() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut fixture = Fixture::workhub(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            Setup::workers(),
        )
        .await;
        let worker = worker_session(&fixture).await;
        let (coordinator, parent, mut running) = active_task(&fixture, &listener, &worker).await;
        let directory = query_import(&fixture, "worker", "directories", json!({"kind":"roots"}))
            .await["roots"][0]["selection"]
            .clone();
        let route = |title: &str, model: ModelSelection| {
            json!({"operation":"route","worker":"worker",
            "target":{"kind":"new","title":title,"workspace":directory,"tools":[]},
            "dependencies":[parent],"note":"Use the completed dependency", "model":model})
        };
        let cancelled = control_turn(
            &fixture,
            &listener,
            &coordinator,
            route("Never start", fixture.selection().await),
        )
        .await;
        let downstream = control_turn(
            &fixture,
            &listener,
            &coordinator,
            route("After evidence", fixture.selection().await),
        )
        .await;
        assert_eq!(cancelled["status"]["kind"], "blocked");
        assert_eq!(downstream["status"]["kind"], "blocked");
        assert_eq!(downstream["dependencies"], json!([parent]));
        assert_eq!(
            query_import(
                &fixture,
                "worker",
                "list",
                json!({"filter":"all","position":{"kind":"start"}})
            )
            .await["sessions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let result = control_turn(
            &fixture,
            &listener,
            &coordinator,
            json!({"operation":"cancel_pending","taskId":cancelled["taskId"]}),
        )
        .await;
        assert_eq!(result["kind"], "cancelled");
        let evidence = "Complete original evidence. 中文 ".repeat(90);
        response_with_text(&mut running, &evidence).await;
        let child = loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let input = request(&mut socket).await;
            if is_coordinator(&input) {
                response(&mut socket).await;
                continue;
            }
            let messages = input["messages"].as_array().unwrap();
            assert!(
                messages.iter().any(|message| message["content"]
                    .as_str()
                    .is_some_and(|text| text.contains(&evidence))),
                "dependency pagination must deliver the complete final answer"
            );
            assert!(input["tools"].is_null() || input["tools"].as_array().unwrap().is_empty());
            let observed = query_import(
                &fixture,
                hub::EXPORT,
                "task",
                json!({"taskId":downstream["taskId"]}),
            )
            .await;
            response_with_text(&mut socket, "Dependent work completed").await;
            break observed;
        };
        let child_session = child["status"]["sessionId"].as_str().unwrap();
        idle(&fixture, "worker", child_session).await;
        assert_eq!(
            query_import(
                &fixture,
                hub::EXPORT,
                "task",
                json!({"taskId":cancelled["taskId"]})
            )
            .await["status"]["kind"],
            "cancelled"
        );
        activate_workers(&mut fixture, false, true, true).await;
        let restored = query_import(
            &fixture,
            hub::EXPORT,
            "task",
            json!({"taskId":downstream["taskId"]}),
        )
        .await;
        assert_eq!(
            restored["status"]["invocationId"],
            child["status"]["invocationId"]
        );
        assert_eq!(
            restored["status"]["progress"]["execution"]["state"],
            "completed"
        );
        assert_eq!(
            query_import(
                &fixture,
                hub::EXPORT,
                "task",
                json!({"taskId":cancelled["taskId"]})
            )
            .await["status"]["kind"],
            "cancelled"
        );
        let intents = fixture
            .store
            .application_intents(fixture.app.source().unwrap().deployment, id(1), 0, 128)
            .await
            .unwrap();
        assert_eq!(
            intents
                .iter()
                .filter(|intent| intent.reference.method == "send")
                .count(),
            2
        );
        assert_eq!(
            intents
                .iter()
                .filter(|intent| intent.reference.method == "create")
                .count(),
            1
        );
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[path = "workhub_graph.rs"]
mod graph_tests;

#[tokio::test]
async fn workhub_complete_dependency_capture_above_one_mib() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut fixture = Fixture::workhub(&format!("http://{}/v1", listener.local_addr().unwrap()), Setup::workers()).await;
        let worker = worker_session(&fixture).await;
        let (coordinator, parent, mut running) = active_task(&fixture, &listener, &worker).await;
        let directory = query_import(&fixture, "worker", "directories", json!({"kind":"roots"}))
            .await["roots"][0]["selection"].clone();
        let downstream = control_turn(&fixture, &listener, &coordinator, json!({
            "operation":"route", "worker":"worker",
            "target":{"kind":"new", "title":"Complete dependency", "workspace":directory, "tools":[]},
            "dependencies":[parent], "note":"Use every original dependency byte",
            "model":fixture.selection().await,
        })).await;
        assert_eq!(downstream["status"]["kind"], "blocked");
        let evidence = format!("K64_FIRST\n{}\nK64_LATE_AFTER_ONE_MIB", "甲🙂z".repeat(1152 * 1024 / 8));
        response_with_text(&mut running, &evidence).await;
        idle(&fixture, "worker", &worker).await;

        // Observe an actual advance result even when the original implementation
        // refuses the capture. Never await a child HTTP request on that branch.
        fixture.send(&coordinator).await.unwrap();
        let mut advanced = false;
        let mut child_requests = 0;
        let mut complete_request = false;
        let advance_result = loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            if socket.peek(&mut [0; 1]).await.unwrap() == 0 { continue; }
            let input = request(&mut socket).await;
            if !is_coordinator(&input) {
                child_requests += 1;
                complete_request |= input["messages"].as_array().unwrap().iter().any(|message| {
                    message["content"].as_str().is_some_and(|text| text.contains(&evidence))
                });
                response_with_text(&mut socket, "Complete dependent result").await;
            } else if is_worker_notice(&input) {
                response(&mut socket).await;
            } else if !advanced {
                task_response(&mut socket, json!({"operation":"advance", "taskId":downstream["taskId"]})).await;
                advanced = true;
            } else {
                let result = input["messages"].as_array().unwrap().iter().rev()
                    .find(|message| message["role"] == "tool").unwrap()["content"]
                    .as_str().unwrap().to_owned();
                response(&mut socket).await;
                break result;
            }
        };
        idle(&fixture, EXPORT, &coordinator).await;
        let refused = advance_result.contains("workhub_dependency_capture_unknown");
        let mut restored_same = false;
        let mut sends = 0;
        if !refused {
            while child_requests == 0 {
                let (mut socket, _) = listener.accept().await.unwrap();
                if socket.peek(&mut [0; 1]).await.unwrap() == 0 { continue; }
                let input = request(&mut socket).await;
                if is_coordinator(&input) { response(&mut socket).await; continue; }
                child_requests += 1;
                complete_request |= input["messages"].as_array().unwrap().iter().any(|message| {
                    message["content"].as_str().is_some_and(|text| text.contains(&evidence))
                });
                response_with_text(&mut socket, "Complete dependent result").await;
            }
            let child = query_import(&fixture, hub::EXPORT, "task", json!({"taskId":downstream["taskId"]})).await;
            idle(&fixture, "worker", child["status"]["sessionId"].as_str().unwrap()).await;
            let finished = query_import(&fixture, hub::EXPORT, "task", json!({"taskId":downstream["taskId"]})).await;
            activate_workers(&mut fixture, false, true, true).await;
            let restored = query_import(&fixture, hub::EXPORT, "task", json!({"taskId":downstream["taskId"]})).await;
            restored_same = restored == finished;
            sends = fixture.store.application_intents(fixture.app.source().unwrap().deployment, id(1), 0, 128)
                .await.unwrap().iter().filter(|intent| intent.reference.method == "send").count();
        }
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();

        assert!(!refused, "complete dependency capture refused: {}", advance_result.chars().take(256).collect::<String>());
        assert!(complete_request, "downstream HTTP lost original dependency bytes");
        assert_eq!(child_requests, 1);
        assert!(restored_same, "restart changed the original dependent result");
        assert_eq!(sends, 2, "recovery dispatched another worker message");
    }).await.unwrap();
}
