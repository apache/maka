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
use maka_host_runtime::application::Client;
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};

fn resource_contract() -> Contract {
    let mut value = attached_contract();
    let Interface::Service { methods } = &mut value.interface else {
        unreachable!()
    };
    methods.get_mut("echo").unwrap().mode = MethodMode::Mutation;
    value
}
async fn application(
    store: Arc<RootStore>,
    issuer: &Issuer,
    handler: Arc<dyn Handler>,
) -> Application {
    application_contract(store, issuer, handler, resource_contract()).await
}
async fn application_contract(
    store: Arc<RootStore>,
    issuer: &Issuer,
    handler: Arc<dyn Handler>,
    declared: Contract,
) -> Application {
    let (provider, consumer) = mutation_packages();
    let rewrite = |old: Package| {
        let mut declaration = old
            .manifest()
            .application
            .as_ref()
            .unwrap()
            .declaration()
            .clone();
        let entry = declaration.entries.get_mut(&EntryTarget::Host).unwrap();
        for value in entry.exports.values_mut() {
            value.contract = declared.clone();
        }
        for value in entry.imports.values_mut() {
            value.contract = declared.clone();
        }
        let source = old
            .file("host.mjs")
            .map(|v| std::str::from_utf8(v).unwrap().to_owned());
        package(&old.manifest().id, entry.clone(), source)
    };
    let provider = rewrite(provider);
    let consumer = rewrite(consumer);
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
    let app = Application::start_from_store(
        store,
        deployment,
        registry_contract(handler, declared),
        issuer.clone(),
        Arc::new(RecoveryGrant {
            issuer: issuer.clone(),
            recovery: Arc::new(AtomicBool::new(true)),
        }),
        Some(maka_host_js::factory(Limits::default())),
    )
    .await
    .unwrap();
    app.ready().await.unwrap();
    app
}
async fn binding(client: &Client) -> maka_host_runtime::application::Binding {
    client
        .bind(client.activation(&id(2)).unwrap(), "echo".into())
        .await
        .unwrap()
        .remove(0)
}
struct Effect {
    caller: InstanceId,
    store: Arc<RootStore>,
    calls: Arc<AtomicUsize>,
}
impl Handler for Effect {
    fn call(&self, _: String, _: Value, context: Context) -> BoxFuture<'static, Result<Value>> {
        let store = self.store.clone();
        let calls = self.calls.clone();
        let caller = self.caller.clone();
        Box::pin(async move {
            let reference = context.operation().unwrap();
            assert_eq!(
                store
                    .operation(reference)
                    .unwrap()
                    .operation_observation()
                    .await
                    .unwrap()
                    .unwrap()
                    .outcome,
                OperationOutcome::Unresolved
            );
            assert!(
                store
                    .application_intents(reference.source.deployment, caller, 0, 10)
                    .await
                    .unwrap()
                    .iter()
                    .any(|i| i.reference == *reference)
            );
            assert_eq!(context.attachments()["text"].read(0..5)?, b"xxxxx");
            Ok(json!(format!(
                "effect-{}",
                calls.fetch_add(1, Ordering::SeqCst) + 1
            )))
        })
    }
}

#[tokio::test]
async fn original_bundle_survives_prepare_dispatch_and_new_capture_cannot_replay_it() {
    let (dir, _, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let issuer = Issuer::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let app = application(
            store.clone(),
            &issuer,
            Arc::new(Effect {
                caller: id(2),
                store: store.clone(),
                calls: calls.clone(),
            }),
        )
        .await;
        let client = app.client();
        let binding = binding(&client).await;
        let operation = Uuid::new_v4();
        let (resources, original) = bytes(64 * 1024 * 1024);
        let prepared = client
            .prepare_mutation(
                binding.clone(),
                "echo".into(),
                json!("public"),
                scope(&issuer, true),
                operation,
                resources.into(),
            )
            .await
            .unwrap();
        let reference = prepared.reference().clone();
        assert!(
            store
                .operation(&reference)
                .unwrap()
                .operation_observation()
                .await
                .unwrap()
                .is_none()
        );
        let (too_many, rejected) = bytes(1);
        assert!(
            client
                .prepare_mutation(
                    binding.clone(),
                    "echo".into(),
                    json!("public"),
                    scope(&issuer, true),
                    Uuid::new_v4(),
                    too_many.into()
                )
                .await
                .err()
                .unwrap()
                .contains("budget")
        );
        assert!(rejected.upgrade().is_none());
        let recorded = store
            .record_application_intent(
                reference.source.clone(),
                id(2),
                reference.clone(),
                serde_json::Value::Null,
            )
            .await
            .unwrap();
        let completed = client
            .mutate(prepared, recorded)
            .await
            .unwrap()
            .completion()
            .await;
        assert_eq!(completed.reply.reference, reference);
        assert!(completed.cleanup.is_ok());
        assert_eq!(returned(completed.reply.clone()), json!("effect-1"));
        assert!(
            original.upgrade().is_none(),
            "success must release physical custody before waking its observer"
        );
        let (resources, second) = bytes(64 * 1024 * 1024);
        let prepared = client
            .prepare_mutation(
                binding.clone(),
                "echo".into(),
                json!("public"),
                scope(&issuer, true),
                operation,
                resources.into(),
            )
            .await
            .unwrap();
        assert_ne!(
            prepared.reference().fingerprint,
            reference.fingerprint,
            "fresh bundle is a fresh original capture, even with the same JSON and operation UUID"
        );
        assert!(
            store
                .record_application_intent(
                    reference.source.clone(),
                    id(2),
                    prepared.reference().clone(),
                    serde_json::Value::Null
                )
                .await
                .is_err()
        );
        drop(prepared);
        assert!(second.upgrade().is_none());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let observation = client
            .recover(
                client.activation(&id(2)).unwrap(),
                reference.clone(),
                scope(&issuer, true),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(observation.reference, reference);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let mut sql = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(journal_database(
                    &dir.path().join("root"),
                    "application_operations",
                    reference.operation,
                ))
                .read_only(true),
        )
        .await
        .unwrap();
        let raw: String = sqlx::query_scalar("SELECT request_json FROM application_operations")
            .fetch_one(&mut sql)
            .await
            .unwrap();
        let stored: Value = serde_json::from_str(&raw).unwrap();
        assert!(stored["capture"].as_str().is_some());
        assert_eq!(stored["input"], json!("public"));
        assert!(stored.get("attachments").is_none() && stored.get("metadata").is_none());
        sql.close().await.unwrap();
        app.shutdown().await.unwrap();
        drop(binding);
        drop(client);
        drop(app);
        close(store).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn queued_unreceived_and_ready_preparations_keep_scope_open_until_actual_bundle_drop() {
    let (_dir, _namespaces, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let issuer = Issuer::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let app = application(
            store.clone(),
            &issuer,
            Arc::new(Effect {
                caller: id(2),
                store: store.clone(),
                calls: calls.clone(),
            }),
        )
        .await;
        let client = app.client();
        let binding = binding(&client).await;
        for phase in 0..3 {
            let original_scope = scope(&issuer, true);
            let (resources, weak) = bytes(64 * 1024 * 1024);
            let preparation = client.prepare_mutation(
                binding.clone(),
                "echo".into(),
                json!("public"),
                original_scope.clone(),
                Uuid::new_v4(),
                resources.into(),
            );
            match phase {
                0 => {
                    // Current-thread runtime: the original Call is queued but Host
                    // has not consumed it. Dropping its observer is no acknowledgement.
                    let mut closing = Box::pin(original_scope.finish());
                    assert!(matches!(
                        futures_util::poll!(&mut closing),
                        std::task::Poll::Pending
                    ));
                    assert!(weak.upgrade().is_some());
                    drop(preparation);
                    closing.await.unwrap();
                }
                1 => {
                    client
                        .bind(client.activation(&id(2)).unwrap(), "echo".into())
                        .await
                        .unwrap();
                    // Host already replied; the actual payload is still in oneshot.
                    let mut closing = Box::pin(original_scope.finish());
                    assert!(matches!(
                        futures_util::poll!(&mut closing),
                        std::task::Poll::Pending
                    ));
                    assert!(weak.upgrade().is_some());
                    drop(preparation);
                    closing.await.unwrap();
                }
                _ => {
                    let prepared = preparation.await.unwrap();
                    let mut closing = Box::pin(original_scope.finish());
                    assert!(matches!(
                        futures_util::poll!(&mut closing),
                        std::task::Poll::Pending
                    ));
                    assert!(weak.upgrade().is_some());
                    drop(prepared);
                    closing.await.unwrap();
                }
            }
            assert!(weak.upgrade().is_none());
            // The very next full-capacity preparation must be admissible.
            let (resources, next) = bytes(64 * 1024 * 1024);
            let prepared = client
                .prepare_mutation(
                    binding.clone(),
                    "echo".into(),
                    json!("public"),
                    scope(&issuer, true),
                    Uuid::new_v4(),
                    resources.into(),
                )
                .await
                .unwrap();
            drop(prepared);
            assert!(next.upgrade().is_none());
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        app.shutdown().await.unwrap();
        drop(binding);
        drop(client);
        drop(app);
        close(store).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn javascript_delegated_mutation_forwards_actual_current_slots_and_never_rebuilds_original_bundle()
 {
    let (_dir, _namespaces, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20),async {
        let issuer=Issuer::default();let calls=Arc::new(AtomicUsize::new(0));let operation=Uuid::new_v4();
        let mut sink_entry=entry(true,Implementation::Native {implementation:"native.echo".into()},MethodMode::Mutation);
        sink_entry.exports.get_mut("echo").unwrap().contract=resource_contract();let sink=package("sink",sink_entry,None);
        let mut forward=attached_entry(true,Implementation::JavaScript {module:"host.mjs".into(),realm:Realm::Shared});
        forward.imports.insert("child".into(),Import {contract:resource_contract(),cardinality:Cardinality::One});
        let source=format!(r#"
            export function activate(){{return {{echo:{{contract:{},service:['service']}}}};}}
            export const service={{async echo(input,_observation,context){{
                try {{
                    const reply=await context.invoke({{operation:'mutate',import:'child',provider:0,method:'echo',input,operationId:'{operation}',attachments:{{text:'text'}}}});
                    if(reply.receipt.kind!=='recorded'||reply.receipt.outcome.kind!=='returned')throw Error('receipt unavailable');
                    return reply.receipt.outcome.value;
                }} catch(error) {{return 'blocked';}}
            }}}};
        "#,serde_json::to_string(&attached_contract()).unwrap());
        let forward=package("forward",forward,Some(source));let consumer=attached_packages().1;
        let mut input=input(&forward,&consumer);let node=input.instances.get_mut("provider").unwrap();node.key=Uuid::from_u128(4);
        node.bindings.insert("child".into(),vec![Target::Instance {path:vec!["sink".into()],export:"echo".into()}]);input.instances.insert("sink".into(),super::super::node(&sink,1,true));
        let deployment=Uuid::new_v4();store.commit_application(deployment,0,input,vec![],vec![sink,forward,consumer]).await.unwrap();
        let app=Application::start_from_store(store.clone(),deployment,registry_contract(Arc::new(Effect {caller:id(4),store:store.clone(),calls:calls.clone()}),resource_contract()),issuer.clone(),Arc::new(Grant(issuer.clone())),Some(maka_host_js::factory(Limits::default()))).await.unwrap();app.ready().await.unwrap();
        let client=app.client();let binding=binding(&client).await;
        for attempt in 0..2 {
            let (resources,weak)=bytes(32*1024*1024);
            let result=client.start(binding.clone(),"echo".into(),json!("public"),scope(&issuer,true),resources.into()).await.unwrap().completion().await;
            assert!(result.cleanup.is_ok());assert_eq!(result.result.unwrap(),if attempt==0 {json!("effect-1")} else {json!("blocked")});
            assert!(weak.upgrade().is_none(),"completed parent releases the actual forwarded bundle");
        }
        assert_eq!(calls.load(Ordering::SeqCst),1);
        app.shutdown().await.unwrap();drop(binding);drop(client);drop(app);close(store).await;
    }).await.unwrap();
}

#[tokio::test]
async fn failed_resource_mutation_keeps_original_snapshot_and_capacity_after_business_return() {
    let (_dir, _namespaces, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20),async {
        let issuer=Issuer::default();let calls=Arc::new(AtomicUsize::new(0));
        let app=application(store.clone(),&issuer,Arc::new(ReadAttachment {calls:calls.clone(),started:Arc::new(Semaphore::new(0)),release:Arc::new(Semaphore::new(0))})).await;
        let client=app.client();let binding=binding(&client).await;let original_scope=scope(&issuer,true);
        let (resources,weak)=bytes(64*1024*1024);
        let prepared=client.prepare_mutation(binding.clone(),"echo".into(),json!("fail-cleanup"),original_scope.clone(),Uuid::new_v4(),resources.into()).await.unwrap();
        let reference=prepared.reference().clone();
        let journal=store.operation(&reference).unwrap();
        let recorded=store.record_application_intent(reference.source.clone(),id(2),reference.clone(), serde_json::Value::Null).await.unwrap();
        let completed=client.mutate(prepared,recorded).await.unwrap().completion().await;
        assert!(completed.cleanup.is_err());
        assert!(matches!(completed.reply.receipt,Receipt::Recorded {outcome:OperationOutcome::Returned {ref value},cleanup:OperationCleanup::Failed {..}} if value==&json!("xxxxx")));
        assert!(original_scope.finish().await.is_err());assert!(weak.upgrade().is_some());
        let (resources,rejected)=bytes(1);
        let failure=client.prepare_mutation(binding,"echo".into(),json!("public"),scope(&issuer,true),Uuid::new_v4(),resources.into()).await.err().unwrap();
        assert!(failure.contains("budget"));assert!(rejected.upgrade().is_none());
        assert_eq!(calls.load(Ordering::SeqCst),1);
        assert!(store.shutdown().await.is_err());
        assert!(journal.operation_observation().await.is_err());
        assert!(matches!(persisted_operation(&_dir.path().join("root"), &reference).cleanup,OperationCleanup::Failed {..}));
        assert!(app.shutdown().await.is_err());assert!(weak.upgrade().is_some(),"unknown physical cleanup keeps actual owner custody");
        // This fixture deliberately leaves failed physical custody with its real
        // owner; dropping the caller/observers does not manufacture recovery.
    }).await.unwrap();
}

#[tokio::test]
async fn received_original_payload_reservation_survives_prepare_and_real_caller_commit() {
    let (_dir, _, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        use maka_capabilities::call::ResourceEncoding;
        use maka_host_runtime::application::{RESOURCE_CHUNK_LIMIT, ResourceDescriptor};
        let issuer = Issuer::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let app = application(
            store.clone(),
            &issuer,
            Arc::new(Effect {
                caller: id(2),
                store: store.clone(),
                calls: calls.clone(),
            }),
        )
        .await;
        let client = app.client();
        let binding = binding(&client).await;
        for abort in [true, false] {
            let source = scope(&issuer, true);
            let descriptor = BTreeMap::from([(
                "text".into(),
                ResourceDescriptor {
                    resource: ResourceType {
                        name: "example.Bytes".into(),
                        version: 1,
                    },
                    length: 64 * 1024 * 1024,
                    metadata: json!({"owner":"original receiver"}),
                    encoding: ResourceEncoding::Bytes,
                },
            )]);
            let mut capture = client
                .capture_resources(source.clone(), descriptor)
                .unwrap();
            let chunk = vec![b'x'; RESOURCE_CHUNK_LIMIT];
            for offset in (0..64 * 1024 * 1024).step_by(RESOURCE_CHUNK_LIMIT) {
                capture.write("text", offset as u64, &chunk).unwrap();
            }
            let prepared = client
                .prepare_mutation(
                    binding.clone(),
                    "echo".into(),
                    json!("public"),
                    source.clone(),
                    Uuid::new_v4(),
                    capture.finish().unwrap(),
                )
                .await
                .unwrap();
            let reference = prepared.reference().clone();
            assert!(
                store
                    .operation(&reference)
                    .unwrap()
                    .operation_observation()
                    .await
                    .unwrap()
                    .is_none()
            );
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            let rejected = scope(&issuer, true);
            let descriptor = BTreeMap::from([(
                "text".into(),
                ResourceDescriptor {
                    resource: ResourceType {
                        name: "example.Bytes".into(),
                        version: 1,
                    },
                    length: 1,
                    metadata: json!(null),
                    encoding: ResourceEncoding::Bytes,
                },
            )]);
            assert!(
                client
                    .capture_resources(rejected.clone(), descriptor)
                    .err()
                    .unwrap()
                    .contains("attachment budget")
            );
            rejected.finish().await.unwrap();
            if abort {
                drop(prepared);
            } else {
                let token = store
                    .record_application_intent(
                        reference.source.clone(),
                        id(2),
                        reference.clone(),
                        serde_json::Value::Null,
                    )
                    .await
                    .unwrap();
                let completed = client
                    .mutate(prepared, token)
                    .await
                    .unwrap()
                    .completion()
                    .await;
                completed.cleanup.unwrap();
                assert_eq!(completed.reply.reference, reference);
                assert_eq!(returned(completed.reply), json!("effect-1"));
            }
            source.finish().await.unwrap();
            // The original physical release precedes its Scope and completion acknowledgement.
            let probe = scope(&issuer, true);
            let descriptor = BTreeMap::from([(
                "text".into(),
                ResourceDescriptor {
                    resource: ResourceType {
                        name: "example.Bytes".into(),
                        version: 1,
                    },
                    length: 64 * 1024 * 1024,
                    metadata: json!(null),
                    encoding: ResourceEncoding::Bytes,
                },
            )]);
            let capture = client.capture_resources(probe.clone(), descriptor).unwrap();
            drop(capture);
            probe.finish().await.unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        app.shutdown().await.unwrap();
        store.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn optional_slots_keep_original_resource_capture_and_recovery() {
    struct Probe;
    impl Handler for Probe {
        fn call(&self, _: String, _: Value, context: Context) -> BoxFuture<'static, Result<Value>> {
            Box::pin(async move { Ok(json!(context.attachments().len().to_string())) })
        }
    }
    let (_dir, _, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let issuer = Issuer::default();
        let mut contract = resource_contract();
        let Interface::Service { methods } = &mut contract.interface else {
            unreachable!()
        };
        methods
            .get_mut("echo")
            .unwrap()
            .resources
            .get_mut("text")
            .unwrap()
            .optional = true;
        let app = application_contract(store.clone(), &issuer, Arc::new(Probe), contract).await;
        let client = app.client();
        let binding = binding(&client).await;
        for present in [false, true] {
            let resources = if present {
                bytes(5).0
            } else {
                Attachments::default()
            };
            let prepared = client
                .prepare_mutation(
                    binding.clone(),
                    "echo".into(),
                    json!("public"),
                    scope(&issuer, true),
                    Uuid::new_v4(),
                    resources.into(),
                )
                .await
                .unwrap();
            let reference = prepared.reference().clone();
            let intent = store
                .record_application_intent(
                    reference.source.clone(),
                    prepared.consumer().instance().clone(),
                    reference.clone(),
                    Value::Null,
                )
                .await
                .unwrap();
            let result = client
                .mutate(prepared, intent)
                .await
                .unwrap()
                .completion()
                .await;
            result.cleanup.unwrap();
            assert_eq!(
                returned(result.reply),
                json!(usize::from(present).to_string())
            );
            let observed = client
                .recover(
                    client.activation(&id(2)).unwrap(),
                    reference,
                    scope(&issuer, true),
                )
                .await
                .unwrap()
                .unwrap();
            assert!(matches!(
                observed.outcome,
                OperationOutcome::Returned { .. }
            ));
        }
        let mut resources = bytes(5).0;
        let value = resources.remove("text").unwrap();
        resources.insert("unknown".into(), value);
        assert!(
            client
                .prepare_mutation(
                    binding,
                    "echo".into(),
                    json!("public"),
                    scope(&issuer, true),
                    Uuid::new_v4(),
                    resources.into()
                )
                .await
                .is_err()
        );
        app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
