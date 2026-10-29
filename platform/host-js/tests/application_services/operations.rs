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

mod reconciliation;
mod startup;

mod mutation_progress;

mod peer_confirmations;
mod receipts;
mod resource_mutations;

use super::*;
use maka_event_log::{
    root::{RootNamespaces, RootOwner},
    root_store::RootStore,
};
use maka_host_runtime::application::RecoveryInvocation;
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, OperationReply, Receipt};
use std::sync::atomic::AtomicBool;

async fn store() -> (tempfile::TempDir, RootNamespaces, Arc<RootStore>) {
    let dir = tempfile::tempdir().unwrap();
    let namespaces = RootNamespaces {
        ownership: dir.path().join("owners"),
        control: dir.path().join("control"),
    };
    let owner = Arc::new(RootOwner::create(&dir.path().join("root"), &namespaces).unwrap());
    let store = Arc::new(setup(RootStore::open(owner)).await.unwrap());
    (dir, namespaces, store)
}
fn mutation_packages() -> (Package, Package) {
    let provider = package(
        "native",
        entry(
            true,
            Implementation::Native {
                implementation: "native.echo".into(),
            },
            MethodMode::Mutation,
        ),
        None,
    );
    let consumer = package(
        "consumer",
        entry(
            false,
            Implementation::JavaScript {
                module: "host.mjs".into(),
                realm: Realm::Shared,
            },
            MethodMode::Mutation,
        ),
        Some("export function activate() { return {}; }".into()),
    );
    (provider, consumer)
}
struct RecoveryGrant {
    issuer: Issuer,
    recovery: Arc<AtomicBool>,
}
impl Policy for RecoveryGrant {
    fn admit(&self, invocation: Invocation<'_>) -> Result<()> {
        Grant(self.issuer.clone()).admit(invocation)
    }
    fn recover(&self, invocation: RecoveryInvocation<'_>) -> Result<()> {
        if self.issuer.evidence::<bool>(invocation.scope) == Some(&true)
            && self.recovery.load(Ordering::SeqCst)
        {
            Ok(())
        } else {
            Err("historical grant denied".into())
        }
    }
}
struct VerifiedEcho {
    caller: InstanceId,
    store: Arc<RootStore>,
    calls: Arc<AtomicUsize>,
}
impl Handler for VerifiedEcho {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value>> {
        let store = self.store.clone();
        let caller = self.caller.clone();
        let calls = self.calls.clone();
        Box::pin(async move {
            let reference = context.operation().expect("actual operation context");
            let observation = store
                .operation(reference)
                .unwrap()
                .operation_observation()
                .await
                .unwrap()
                .expect("dispatch must precede effect");
            assert_eq!(observation.outcome, OperationOutcome::Unresolved);
            assert_eq!(observation.cleanup, OperationCleanup::Unconfirmed);
            assert!(
                store
                    .application_intents(reference.source.deployment, caller, 0, 128)
                    .await
                    .unwrap()
                    .iter()
                    .any(|intent| intent.reference == *reference),
                "caller commit must also precede effect"
            );
            if input == json!("escaped-fail") {
                calls.fetch_add(1, Ordering::SeqCst);
                return Err("\u{00}\n\"".repeat(64 * 1024));
            }
            Echo { calls }.call(method, input, context).await
        })
    }
}
async fn launch(
    store: Arc<RootStore>,
    issuer: &Issuer,
    recovery: Arc<AtomicBool>,
    handler: Arc<dyn Handler>,
) -> (Application, Uuid) {
    let (provider, consumer) = mutation_packages();
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
        registry_contract(handler, contract(MethodMode::Mutation)),
        issuer.clone(),
        Arc::new(RecoveryGrant {
            issuer: issuer.clone(),
            recovery,
        }),
        Some(maka_host_js::factory(Limits::default())),
    )
    .await
    .unwrap();
    app.ready().await.unwrap();
    (app, deployment)
}
// Native callers use their actual persisted Host source; UI callers use their own Root.
async fn mutate(
    client: &maka_host_runtime::application::Client,
    store: &RootStore,
    binding: maka_host_runtime::application::Binding,
    method: String,
    input: Value,
    scope: Scope,
    operation: Uuid,
) -> Result<maka_host_runtime::application::Mutation> {
    let prepared = client
        .prepare_mutation(
            binding,
            method,
            input,
            scope,
            operation,
            Attachments::new().into(),
        )
        .await?;
    let recorded = store
        .record_application_intent(
            prepared.reference().source.clone(),
            prepared.consumer().instance().clone(),
            prepared.reference().clone(),
            serde_json::Value::Null,
        )
        .await
        .map_err(|e| e.to_string())?;
    client.mutate(prepared, recorded).await
}
async fn close(store: Arc<RootStore>) {
    Arc::try_unwrap(store)
        .ok()
        .expect("no live storage owner")
        .close()
        .await
        .unwrap();
}

#[tokio::test]
async fn real_mutation_commits_before_effect_and_duplicate_requires_recovery_grant() {
    let (_dir, _ns, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let issuer = Issuer::default();
        let recovery = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(AtomicUsize::new(0));
        let (app, _) = launch(
            store.clone(),
            &issuer,
            recovery.clone(),
            Arc::new(VerifiedEcho {
                caller: id(2),
                store: store.clone(),
                calls: calls.clone(),
            }),
        )
        .await;
        let client = app.client();
        let consumer = client.activation(&id(2)).unwrap();
        let binding = client
            .bind(consumer.clone(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        assert!(
            client
                .start(
                    binding.clone(),
                    "echo".into(),
                    json!("original"),
                    scope(&issuer, true),
                    Attachments::new().into()
                )
                .await
                .is_err()
        );
        assert!(
            mutate(
                &client,
                &store,
                binding.clone(),
                "echo".into(),
                json!("original"),
                scope(&issuer, true),
                Uuid::nil()
            )
            .await
            .is_err()
        );
        assert!(
            mutate(
                &client,
                &store,
                binding.clone(),
                "echo".into(),
                json!("original"),
                scope(&issuer, false),
                Uuid::new_v4()
            )
            .await
            .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let operation = Uuid::new_v4();
        let accepted = mutate(
            &client,
            &store,
            binding.clone(),
            "echo".into(),
            json!("original"),
            scope(&issuer, true),
            operation,
        )
        .await
        .unwrap();
        let reference = accepted.reference.clone();
        let completion = accepted.completion().await;
        assert_eq!(completion.reply.reference, reference);
        assert!(completion.cleanup.is_ok());
        assert_eq!(returned(completion.reply), json!("original"));
        let observation = store
            .operation(&reference)
            .unwrap()
            .operation_observation()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(observation.cleanup, OperationCleanup::Confirmed);
        assert!(
            client
                .recover(consumer.clone(), reference.clone(), scope(&issuer, true))
                .await
                .unwrap_err()
                .contains("historical grant denied")
        );
        assert!(
            unavailable(
                mutate(
                    &client,
                    &store,
                    binding.clone(),
                    "echo".into(),
                    json!("original"),
                    scope(&issuer, true),
                    operation
                )
                .await
                .unwrap()
                .result()
                .await
            )
            .contains("historical grant denied")
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        recovery.store(true, Ordering::SeqCst);
        assert_eq!(
            client
                .recover(consumer.clone(), reference.clone(), scope(&issuer, true))
                .await
                .unwrap()
                .unwrap(),
            observation
        );
        assert_eq!(
            returned(
                mutate(
                    &client,
                    &store,
                    binding.clone(),
                    "echo".into(),
                    json!("original"),
                    scope(&issuer, true),
                    operation
                )
                .await
                .unwrap()
                .result()
                .await
            ),
            json!("original")
        );
        assert!(
            mutate(
                &client,
                &store,
                binding,
                "echo".into(),
                json!("changed"),
                scope(&issuer, true),
                operation
            )
            .await
            .err()
            .unwrap()
            .contains("conflicts")
        );
        let foreign = Issuer::default();
        assert!(
            client
                .recover(consumer.clone(), reference.clone(), scope(&foreign, true))
                .await
                .is_err()
        );
        let cancelled = scope(&issuer, true);
        cancelled.cancellation.cancel();
        assert!(
            client
                .recover(consumer.clone(), reference.clone(), cancelled)
                .await
                .is_err()
        );
        client.retire(consumer.clone()).await.unwrap();
        assert!(
            client
                .recover(consumer, reference.clone(), scope(&issuer, true))
                .await
                .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            store
                .operation(&reference)
                .unwrap()
                .operation_observation()
                .await
                .unwrap()
                .unwrap(),
            observation
        );
        app.shutdown().await.unwrap();
        drop(app);
        drop(client);
        close(store).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn unknown_result_is_not_replayed_and_default_recovery_policy_denies() {
    let (_dir, _ns, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let (provider, consumer) = mutation_packages();
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
        let calls = Arc::new(AtomicUsize::new(0));
        let app = Application::start_from_store(
            store.clone(),
            deployment,
            registry_contract(
                Arc::new(VerifiedEcho {
                    caller: id(2),
                    store: store.clone(),
                    calls: calls.clone(),
                }),
                contract(MethodMode::Mutation),
            ),
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            Some(maka_host_js::factory(Limits::default())),
        )
        .await
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let consumer = client.activation(&id(2)).unwrap();
        let binding = client
            .bind(consumer.clone(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        for input in ["fail", "bad-result", "escaped-fail"] {
            let operation = Uuid::new_v4();
            let accepted = mutate(
                &client,
                &store,
                binding.clone(),
                "echo".into(),
                json!(input),
                scope(&issuer, true),
                operation,
            )
            .await
            .unwrap();
            let reference = accepted.reference.clone();
            let completion = accepted.completion().await;
            assert_eq!(completion.reply.reference, reference);
            assert!(completion.cleanup.is_ok());
            assert!(unknown(completion.reply));
            let observation = store
                .operation(&reference)
                .unwrap()
                .operation_observation()
                .await
                .unwrap()
                .unwrap();
            assert!(matches!(
                observation.outcome,
                OperationOutcome::Unknown { .. }
            ));
            assert_eq!(observation.cleanup, OperationCleanup::Confirmed);
            assert!(
                unavailable(
                    mutate(
                        &client,
                        &store,
                        binding.clone(),
                        "echo".into(),
                        json!(input),
                        scope(&issuer, true),
                        operation
                    )
                    .await
                    .unwrap()
                    .result()
                    .await
                )
                .contains("not authorized")
            );
            assert!(
                client
                    .recover(consumer.clone(), reference.clone(), scope(&issuer, true))
                    .await
                    .unwrap_err()
                    .contains("not authorized")
            );
            assert_eq!(
                store
                    .operation(&reference)
                    .unwrap()
                    .operation_observation()
                    .await
                    .unwrap()
                    .unwrap(),
                observation
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        app.shutdown().await.unwrap();
        drop(binding);
        drop(app);
        drop(client);
        close(store).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn original_receipt_survives_restart_and_new_composition_without_provider() {
    let (dir, ns, store) = store().await;
    let (_other_dir, _other_ns, other_store) = self::store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let issuer = Issuer::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let recovery = Arc::new(AtomicBool::new(true));
        let (app, deployment) = launch(
            store.clone(),
            &issuer,
            recovery.clone(),
            Arc::new(VerifiedEcho {
                caller: id(2),
                store: store.clone(),
                calls: calls.clone(),
            }),
        )
        .await;
        let client = app.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let original = large_receipt_value();
        let accepted = mutate(
            &client,
            &store,
            binding,
            "echo".into(),
            original.clone(),
            scope(&issuer, true),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        let reference = accepted.reference.clone();
        assert_eq!(
            accepted.result().await.receipt,
            Receipt::Recorded {
                outcome: OperationOutcome::Returned {
                    value: original.clone()
                },
                cleanup: OperationCleanup::Confirmed,
            }
        );
        let mut declaration = entry(
            false,
            Implementation::JavaScript {
                module: "host.mjs".into(),
                realm: Realm::Shared,
            },
            MethodMode::Query,
        );
        declaration.imports.clear();
        let replacement = package(
            "replacement",
            declaration,
            Some("export function activate() { return {}; }".into()),
        );
        let mut replacement_node = node(&replacement, 2, true);
        replacement_node.bindings.clear();
        let replacement_input = Input {
            ui: None,
            instances: BTreeMap::from([("recovery-client".into(), replacement_node)]),
        };
        // Acceptance precedes committed withdrawal; new admission is revoked
        // when the live owner adopts the new source automatically.
        let original_consumer = client.activation(&id(2)).unwrap();
        let old_binding = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let old_accepted = mutate(
            &client,
            &store,
            old_binding,
            "echo".into(),
            json!("old-owner"),
            scope(&issuer, true),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        let replacement_source = store
            .commit_application(deployment, 1, replacement_input, vec![], vec![replacement])
            .await
            .unwrap();
        while client.snapshot().desired != Some(replacement_source.clone()) {
            tokio::task::yield_now().await;
        }
        client.ready().await.unwrap();
        assert!(client.bind(original_consumer, "echo".into()).await.is_err());
        assert_eq!(old_accepted.reference.source, reference.source);
        assert_eq!(returned(old_accepted.result().await), json!("old-owner"));
        assert_eq!(
            store
                .load_application_at(&reference.source)
                .await
                .unwrap()
                .unwrap()
                .source()
                .reference,
            reference.source
        );
        app.shutdown().await.unwrap();
        drop(app);
        drop(client);
        close(store).await;
        let owner = Arc::new(RootOwner::open(&dir.path().join("root"), &ns).unwrap());
        let reopened = Arc::new(RootStore::open(owner).await.unwrap());
        let new_issuer = Issuer::default();
        let new_app = Application::start_from_store(
            reopened.clone(),
            deployment,
            NativeRegistry::default(),
            new_issuer.clone(),
            Arc::new(RecoveryGrant {
                issuer: new_issuer.clone(),
                recovery,
            }),
            Some(maka_host_js::factory(Limits::default())),
        )
        .await
        .unwrap();
        new_app.ready().await.unwrap();
        let client = new_app.client();
        let consumer = client.activation(&id(2)).unwrap();
        assert!(client.activation(&id(1)).is_err());
        let observation = client
            .recover(consumer, reference.clone(), scope(&new_issuer, true))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            observation.outcome,
            OperationOutcome::Returned { value: original }
        );
        assert_eq!(observation.cleanup, OperationCleanup::Confirmed);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let current = reopened
            .load_application(deployment)
            .await
            .unwrap()
            .unwrap();
        let (source, packages, _, _) = current.into_parts();
        other_store
            .commit_application(deployment, 0, source.input, vec![], packages)
            .await
            .unwrap();
        let other_app = Application::start_from_store(
            other_store.clone(),
            deployment,
            NativeRegistry::default(),
            new_issuer.clone(),
            Arc::new(RecoveryGrant {
                issuer: new_issuer.clone(),
                recovery: Arc::new(AtomicBool::new(true)),
            }),
            Some(maka_host_js::factory(Limits::default())),
        )
        .await
        .unwrap();
        other_app.ready().await.unwrap();
        let other_client = other_app.client();
        assert!(
            other_client
                .recover(
                    other_client.activation(&id(2)).unwrap(),
                    reference,
                    scope(&new_issuer, true)
                )
                .await
                .unwrap_err()
                .contains("foreign operation state domain")
        );
        other_app.shutdown().await.unwrap();
        drop(other_app);
        drop(other_client);
        close(other_store).await;
        new_app.shutdown().await.unwrap();
        drop(new_app);
        drop(client);
        close(reopened).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn javascript_mutation_receives_original_reference_and_dispatches_once() {
    let (_dir, _ns, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let issuer=Issuer::default();let recovery=Arc::new(AtomicBool::new(true));
        let contract=contract(MethodMode::Mutation);
        let source=format!(r#"let calls=0;
            export const service={{echo(input, observation) {{
                if (!observation.operation || observation.operation.method !== 'echo' || observation.operation.source.revision !== 1) throw Error('missing original operation observation');
                calls++; return input+':'+calls;
            }}}};
            export function activate() {{return {{echo:{{contract:{},service:['service']}}}};}}
        "#,serde_json::to_string(&contract).unwrap());
        let provider=package("script",entry(true,Implementation::JavaScript {module:"host.mjs".into(),realm:Realm::Dedicated},MethodMode::Mutation),Some(source));
        let consumer=mutation_packages().1;let deployment=Uuid::new_v4();store.commit_application(deployment,0,input(&provider,&consumer),vec![],vec![provider,consumer]).await.unwrap();
        let app=Application::start_from_store(store.clone(),deployment,NativeRegistry::default(),issuer.clone(),Arc::new(RecoveryGrant {issuer:issuer.clone(),recovery}),Some(maka_host_js::factory(Limits::default()))).await.unwrap();app.ready().await.unwrap();
        let client=app.client();let binding=client.bind(client.activation(&id(2)).unwrap(),"echo".into()).await.unwrap().remove(0);let operation=Uuid::new_v4();
        let accepted=mutate(&client, &store, binding.clone(),"echo".into(),json!("script"),scope(&issuer,true),operation).await.unwrap();let reference=accepted.reference.clone();assert_eq!(returned(accepted.result().await),json!("script:1"));
        assert_eq!(returned(mutate(&client, &store, binding,"echo".into(),json!("script"),scope(&issuer,true),operation).await.unwrap().result().await),json!("script:1"));
        assert_eq!(store.operation(&reference).unwrap().operation_observation().await.unwrap().unwrap().outcome,OperationOutcome::Returned {value:json!("script:1")});
        app.shutdown().await.unwrap();drop(app);drop(client);close(store).await;
    }).await.unwrap();
}

#[tokio::test]
async fn javascript_forwarded_mutation_preserves_original_evidence_and_parent_cleanup() {
    let (_dir, _ns, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let issuer=Issuer::default();let calls=Arc::new(AtomicUsize::new(0));let operation=Uuid::new_v4();
        let (sink,_)=mutation_packages();
        let mut forwarder_entry=entry(true,Implementation::JavaScript {module:"host.mjs".into(),realm:Realm::Shared},MethodMode::Query);
        forwarder_entry.imports.insert("child".into(), Import {contract:contract(MethodMode::Mutation),cardinality:Cardinality::One});
        let source=format!(r#"
            export const service={{async echo(input,_observation,context) {{
                const reply=await context.invoke({{operation:'mutate',import:'child',provider:0,method:'echo',input,operationId:'{operation}',attachments:{{}}}});
                if(reply.receipt.kind !== 'recorded' || reply.receipt.outcome.kind !== 'returned') throw Error('child receipt not returned');
                if(!reply.reference || reply.reference.operation !== '{operation}') throw Error('lost child reference');
                return reply.receipt.outcome.value+':parent';
            }}}};
            export function activate() {{return {{echo:{{contract:{},service:['service']}}}};}}
        "#,serde_json::to_string(&contract(MethodMode::Query)).unwrap());
        let forwarder=package("forwarder",forwarder_entry,Some(source));let consumer=consumer();
        let mut input=input(&forwarder,&consumer);let parent=input.instances.get_mut("provider").unwrap();parent.key=Uuid::from_u128(4);
        parent.bindings.insert("child".into(),vec![Target::Instance {path:vec!["sink".into()],export:"echo".into()}]);input.instances.insert("sink".into(),node(&sink,1,true));
        let deployment=Uuid::new_v4();store.commit_application(deployment,0,input,vec![],vec![sink,forwarder,consumer]).await.unwrap();
        let app=Application::start_from_store(store.clone(),deployment,registry_contract(Arc::new(VerifiedEcho {caller:id(4),store:store.clone(),calls:calls.clone()}),contract(MethodMode::Mutation)),issuer.clone(),Arc::new(RecoveryGrant {issuer:issuer.clone(),recovery:Arc::new(AtomicBool::new(true))}),Some(maka_host_js::factory(Limits::default()))).await.unwrap();app.ready().await.unwrap();
        let client=app.client();let binding=client.bind(client.activation(&id(2)).unwrap(),"echo".into()).await.unwrap().remove(0);
        for _ in 0..2 {assert_eq!(client.start(binding.clone(),"echo".into(),json!("child"),scope(&issuer,true),Attachments::new().into()).await.unwrap().result().await.unwrap(),json!("child:parent"));}
        assert_eq!(calls.load(Ordering::SeqCst),1);
        app.shutdown().await.unwrap();drop(binding);drop(app);drop(client);close(store).await;
    }).await.unwrap();
}

struct HeldMutation {
    store: Arc<RootStore>,
    started: Arc<Semaphore>,
    release: Arc<Semaphore>,
    resource_started: Arc<Semaphore>,
    resource_release: Arc<Semaphore>,
}
impl Handler for HeldMutation {
    fn call(&self, _: String, input: Value, context: Context) -> BoxFuture<'static, Result<Value>> {
        let store = self.store.clone();
        let reference = context.operation().unwrap().clone();
        let scope = context.scope().clone();
        let started = self.started.clone();
        let release = self.release.clone();
        let resource_started = self.resource_started.clone();
        let resource_release = self.resource_release.clone();
        Box::pin(async move {
            assert_eq!(
                store
                    .operation(&reference)
                    .unwrap()
                    .operation_observation()
                    .await
                    .unwrap()
                    .unwrap()
                    .outcome,
                OperationOutcome::Unresolved
            );
            started.add_permits(1);
            permit(&release).await;
            let mut ticket = scope.resources.reserve().unwrap();
            ticket.start();
            tokio::spawn(async move {
                resource_started.add_permits(1);
                permit(&resource_release).await;
                ticket.complete(Ok(()));
            });
            Ok(input)
        })
    }
}
#[tokio::test]
async fn dropped_root_and_all_observers_keep_mutation_resources_native_close_and_root_lease() {
    let (dir, ns, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let issuer = Issuer::default();
        let started = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let resource_started = Arc::new(Semaphore::new(0));
        let resource_release = Arc::new(Semaphore::new(0));
        let close_started = Arc::new(Semaphore::new(0));
        let close_release = Arc::new(Semaphore::new(0));
        let handler: Arc<dyn Handler> = Arc::new(HeldMutation {
            store: store.clone(),
            started: started.clone(),
            release: release.clone(),
            resource_started: resource_started.clone(),
            resource_release: resource_release.clone(),
        });
        let mut registry = NativeRegistry::default();
        let closing = close_started.clone();
        let closed = close_release.clone();
        registry
            .insert(
                "native.echo".into(),
                Arc::new(move |_, _| {
                    let handler = handler.clone();
                    let closing = closing.clone();
                    let closed = closed.clone();
                    Box::pin(async move {
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "echo".into(),
                                Published {
                                    contract: contract(MethodMode::Mutation),
                                    value: handler,
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
        let (provider, consumer) = mutation_packages();
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
            store.clone(),
            deployment,
            registry,
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            Some(maka_host_js::factory(Limits::default())),
        )
        .await
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let accepted = mutate(
            &client,
            &store,
            binding,
            "echo".into(),
            json!("held"),
            scope(&issuer, true),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        let reference = accepted.reference.clone();
        permit(&started).await;
        let weak = Arc::downgrade(&store);
        drop(accepted);
        drop(app);
        drop(client);
        drop(store);
        assert!(RootOwner::open(&dir.path().join("root"), &ns).is_err());
        release.add_permits(1);
        permit(&resource_started).await;
        let observation = weak
            .upgrade()
            .unwrap()
            .operation(&reference)
            .unwrap()
            .operation_observation()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(observation.outcome, OperationOutcome::Unresolved);
        assert_eq!(observation.cleanup, OperationCleanup::Unconfirmed);
        assert_eq!(close_started.available_permits(), 0);
        assert!(RootOwner::open(&dir.path().join("root"), &ns).is_err());
        resource_release.add_permits(1);
        permit(&close_started).await;
        let observation = weak
            .upgrade()
            .unwrap()
            .operation(&reference)
            .unwrap()
            .operation_observation()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            observation.outcome,
            OperationOutcome::Returned {
                value: json!("held")
            }
        );
        assert_eq!(observation.cleanup, OperationCleanup::Confirmed);
        assert!(RootOwner::open(&dir.path().join("root"), &ns).is_err());
        close_release.add_permits(1);
        loop {
            match RootOwner::open(&dir.path().join("root"), &ns) {
                Ok(owner) => {
                    let reopened = RootStore::open(Arc::new(owner)).await.unwrap();
                    assert_eq!(
                        reopened
                            .operation(&reference)
                            .unwrap()
                            .operation_observation()
                            .await
                            .unwrap()
                            .unwrap(),
                        observation
                    );
                    reopened.close().await.unwrap();
                    break;
                }
                Err(_) => tokio::task::yield_now().await,
            }
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn returned_mutation_and_failed_cleanup_are_separate_persistent_facts() {
    let (dir, ns, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let issuer = Issuer::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let (app, _) = launch(
            store.clone(),
            &issuer,
            Arc::new(AtomicBool::new(true)),
            Arc::new(VerifiedEcho {
                caller: id(2),
                store: store.clone(),
                calls: calls.clone(),
            }),
        )
        .await;
        let client = app.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let prepared = client
            .prepare_mutation(
                binding,
                "echo".into(),
                json!("resource-fail"),
                scope(&issuer, true),
                Uuid::new_v4(),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        let reference = prepared.reference().clone();
        let journal = store.operation(&reference).unwrap();
        let recorded = store
            .record_application_intent(
                reference.source.clone(),
                id(2),
                reference.clone(),
                Value::Null,
            )
            .await
            .unwrap();
        let accepted = client.mutate(prepared, recorded).await.unwrap();
        let completion = accepted.completion().await;
        assert_eq!(completion.reply.reference, reference);
        assert!(completion.cleanup.is_err());
        assert_eq!(returned(completion.reply), json!("resource-fail"));
        assert!(store.shutdown().await.is_err());
        assert!(journal.operation_observation().await.is_err());
        let observation = persisted_operation(&dir.path().join("root"), &reference);
        assert_eq!(
            observation.outcome,
            OperationOutcome::Returned {
                value: json!("resource-fail")
            }
        );
        assert!(matches!(
            observation.cleanup,
            OperationCleanup::Failed { .. }
        ));
        assert!(app.shutdown().await.is_err());
        drop(app);
        drop(client);
        drop(store);
        tokio::task::yield_now().await;
        assert!(RootOwner::open(&dir.path().join("root"), &ns).is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    })
    .await
    .unwrap();
}

// Locate persisted test evidence without exposing a raw partition API in production.
fn journal_database(root: &std::path::Path, table: &str, operation: Uuid) -> std::path::PathBuf {
    let databases = match table {
        "application_intents" => vec![root.join(maka_event_log::root::ROOT_DATABASE)],
        "application_operations" => journal_databases(root),
        _ => panic!("unsupported journal table {table}"),
    };
    for database in databases {
        let connection = rusqlite::Connection::open_with_flags(
            &database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let found: bool = connection
            .query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE operation=?)"),
                [operation.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        if found {
            return database;
        }
    }
    panic!("persisted {table} operation {operation} not found");
}
// Failed Root cleanup closes actor admission. Inspect the committed failure fact
// independently after its shutdown receipt, without reopening a production Root.
fn persisted_operation(
    root: &std::path::Path,
    reference: &maka_plugin_core::operation::RecoveryRef,
) -> maka_plugin_core::operation::OperationObservation {
    let database = journal_database(root, "application_operations", reference.operation);
    let connection =
        rusqlite::Connection::open_with_flags(database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let (outcome, cleanup): (String, String) = connection.query_row(
        "SELECT outcome_json, cleanup_json FROM application_operations WHERE deployment=? AND namespace=? AND operation=? AND source_revision=?",
        rusqlite::params![reference.source.deployment.to_string(), serde_json::to_string(&reference.namespace).unwrap(), reference.operation.to_string(), i64::try_from(reference.source.revision).unwrap()],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    maka_plugin_core::operation::OperationObservation {
        reference: reference.clone(),
        outcome: serde_json::from_str(&outcome).unwrap(),
        cleanup: serde_json::from_str(&cleanup).unwrap(),
    }
}

fn journal_databases(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    (0..8)
        .map(|index| {
            root.join("runtime-partitions")
                .join(format!("{index:02}.sqlite"))
        })
        .collect()
}

const SETTLEMENT_SECRET: &str = "SECRET_OPERATION_SETTLEMENT_SQL_PAYLOAD";

struct UncertainSettlement {
    store: Arc<RootStore>,
    database: std::path::PathBuf,
    calls: Arc<AtomicUsize>,
}
impl Handler for UncertainSettlement {
    fn call(&self, _: String, input: Value, context: Context) -> BoxFuture<'static, Result<Value>> {
        let store = self.store.clone();
        let reference = context.operation().unwrap().clone();
        let database = self.database.clone();
        let calls = self.calls.clone();
        Box::pin(async move {
            assert_eq!(
                store
                    .operation(&reference)
                    .unwrap()
                    .operation_observation()
                    .await
                    .unwrap()
                    .unwrap()
                    .outcome,
                OperationOutcome::Unresolved
            );
            calls.fetch_add(1, Ordering::SeqCst);
            let connection = rusqlite::Connection::open(journal_database(
                &database,
                "application_operations",
                reference.operation,
            ))
            .unwrap();
            connection.execute_batch(&format!("CREATE TRIGGER reject_operation_settlement BEFORE UPDATE OF outcome_json ON application_operations BEGIN SELECT RAISE(ABORT,'{SETTLEMENT_SECRET}'); END;")).unwrap();
            Ok(input)
        })
    }
}
#[tokio::test]
async fn uncertain_durable_settlement_does_not_replay_effect_or_invent_cleanup_failure() {
    let (dir, _ns, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let (mut capture, _log_guard) = log_capture();
        let issuer = Issuer::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let database = dir.path().join("root");
        let (app, _) = launch(
            store.clone(),
            &issuer,
            Arc::new(AtomicBool::new(true)),
            Arc::new(UncertainSettlement {
                store: store.clone(),
                database: database.clone(),
                calls: calls.clone(),
            }),
        )
        .await;
        let client = app.client();
        let consumer = client.activation(&id(2)).unwrap();
        let binding = client
            .bind(consumer.clone(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let operation = Uuid::new_v4();
        let accepted = mutate(
            &client,
            &store,
            binding.clone(),
            "echo".into(),
            json!("effect"),
            scope(&issuer, true),
            operation,
        )
        .await
        .unwrap();
        let reference = accepted.reference.clone();
        let execution_id = accepted.id;
        let completion = accepted.completion().await;
        assert_eq!(completion.reply.reference, reference);
        assert!(
            completion.cleanup.is_ok(),
            "failed receipt SQL must not invent failed physical cleanup"
        );
        assert!(unavailable(completion.reply).contains("settlement outcome unknown"));
        assert!(client.snapshot().cleanup_error.is_none());
        let observation = client
            .recover(consumer, reference.clone(), scope(&issuer, true))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(observation.outcome, OperationOutcome::Unresolved);
        assert_eq!(observation.cleanup, OperationCleanup::Unconfirmed);
        let duplicate = mutate(
            &client,
            &store,
            binding,
            "echo".into(),
            json!("effect"),
            scope(&issuer, true),
            operation,
        )
        .await
        .unwrap()
        .completion()
        .await;
        assert!(duplicate.cleanup.is_ok());
        assert_eq!(duplicate.reply.reference, reference);
        assert!(matches!(
            duplicate.reply.receipt,
            Receipt::Recorded {
                outcome: OperationOutcome::Unresolved,
                cleanup: OperationCleanup::Unconfirmed
            }
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        app.shutdown().await.unwrap();
        drop(app);
        drop(client);
        close(store).await;
        let connection = rusqlite::Connection::open(journal_database(
            &database,
            "application_operations",
            reference.operation,
        ))
        .unwrap();
        connection
            .execute_batch("DROP TRIGGER reject_operation_settlement;")
            .unwrap();
        let log = log_text(&mut capture);
        let event = log
            .lines()
            .find(|line| line.contains("stage=\"operation_settlement\""))
            .expect(
                "actual receipt settlement SQL failure must be logged before its cause is erased",
            );
        assert!(event.contains("ERROR"));
        assert!(event.contains("state_domain=") && event.contains(&reference.source.state_domain));
        assert!(event.contains("cause=\"store_sqlx\""));
        assert!(event.contains("sql_code=1811"));
        for identity in [
            format!("operation_id={}", reference.operation),
            format!("execution_id={execution_id}"),
            format!("deployment_id={}", reference.source.deployment),
            format!("source_revision={}", reference.source.revision),
        ] {
            assert!(
                event.contains(&identity),
                "settlement evidence must identify the original accepted operation/source: {event}"
            );
        }
        assert!(
            !log.contains(SETTLEMENT_SECRET),
            "raw SQL error payload must not enter the Host log"
        );
    })
    .await
    .unwrap();
}

fn returned(reply: OperationReply) -> Value {
    match reply.receipt {
        Receipt::Recorded {
            outcome: OperationOutcome::Returned { value },
            ..
        } => value,
        other => panic!("expected returned receipt: {other:?}"),
    }
}
fn unavailable(reply: OperationReply) -> String {
    match reply.receipt {
        Receipt::Unavailable { diagnostic } => diagnostic,
        other => panic!("expected unavailable receipt: {other:?}"),
    }
}
fn unknown(reply: OperationReply) -> bool {
    matches!(
        reply.receipt,
        Receipt::Recorded {
            outcome: OperationOutcome::Unknown { .. },
            ..
        }
    )
}

fn large_receipt_value() -> Value {
    json!("回🙂\"\\\n".repeat(128 * 1024))
}

struct ReceiptBoundaryEcho(Arc<AtomicUsize>);
impl Handler for ReceiptBoundaryEcho {
    fn call(&self, _: String, input: Value, _: Context) -> BoxFuture<'static, Result<Value>> {
        let calls = self.0.clone();
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            if input == json!("large") {
                Ok(large_receipt_value())
            } else if input == json!("integer") {
                Ok(json!(9007199254740993_u64))
            } else {
                Err("effect result unknown".into())
            }
        })
    }
}

#[tokio::test]
async fn javascript_receipts_preserve_child_reference_unknown_and_oversized_recorded_results() {
    let (_dir, _ns, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20), async {

        let issuer = Issuer::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let recovery = Arc::new(AtomicBool::new(true));
        let mut leaf_contract = contract(MethodMode::Mutation);
        let Interface::Service {methods} = &mut leaf_contract.interface else { unreachable!() };
        methods.get_mut("echo").unwrap().output = json!({"type":["string","integer"]}).into();
        let mut sink_entry = entry(true,Implementation::Native {implementation:"native.echo".into()},MethodMode::Mutation);
        sink_entry.exports.get_mut("echo").unwrap().contract = leaf_contract.clone();
        let sink = package("sink",sink_entry,None);
        let mut declaration = entry(true, Implementation::JavaScript { module: "host.mjs".into(), realm: Realm::Shared }, MethodMode::Query);
        declaration.imports.insert("child".into(), Import { contract: leaf_contract.clone(), cardinality: Cardinality::One });
        let source = format!(r#"
            let reference;
            export const service = {{ async echo(input, _, context) {{
                let reply;
                if (input === 'recover') reply = await context.invoke({{ operation:'recover', reference }});
                else if (input === 'missing') {{
                    const missing = {{...reference, operation:'00000000-0000-0000-0000-000000000abc'}};
                    reply = await context.invoke({{ operation:'recover', reference:missing }});
                }} else {{
                    reply = await context.invoke({{ operation:'mutate', import:'child', provider:0, method:'echo', input, attachments:{{}}, operationId:input==='large'?'00000000-0000-0000-0000-000000000002':input==='integer'?'00000000-0000-0000-0000-000000000003':'00000000-0000-0000-0000-000000000001' }});
                    reference = reply.reference;
                }}
                return JSON.stringify(reply);
            }} }};
            export function activate() {{ return {{echo:{{contract:{},service:['service']}}}}; }}
        "#, serde_json::to_string(&contract(MethodMode::Query)).unwrap());
        let forwarder = package("forwarder", declaration, Some(source));
        let consumer = consumer();
        let reader = package("reader",entry(true,Implementation::JavaScript {module:"host.mjs".into(),realm:Realm::Shared},MethodMode::Query),Some(format!(r#"
            export const service = {{ async echo(input,_,context) {{
                return JSON.stringify(await context.invoke({{operation:'recover',reference:JSON.parse(input)}}));
            }} }};
            export function activate() {{ return {{echo:{{contract:{},service:['service']}}}}; }}
        "#,serde_json::to_string(&contract(MethodMode::Query)).unwrap())));
        let mut desired = input(&forwarder, &consumer);
        desired.instances.insert("reader".into(),node(&reader,5,true));
        let mut reader_client = node(&consumer,6,false);
        reader_client.bindings.insert("echo".into(),vec![Target::Instance {path:vec!["reader".into()],export:"echo".into()}]);
        desired.instances.insert("reader-client".into(),reader_client);
        let parent = desired.instances.get_mut("provider").unwrap();
        parent.key = Uuid::from_u128(4);
        parent.bindings.insert("child".into(), vec![Target::Instance { path:vec!["sink".into()],export:"echo".into() }]);
        desired.instances.insert("sink".into(),node(&sink,1,true));
        let deployment = Uuid::new_v4();
        store.commit_application(deployment,0,desired,vec![],vec![sink,forwarder,consumer,reader]).await.unwrap();
        let app = Application::start_from_store(store.clone(),deployment,registry_contract(Arc::new(ReceiptBoundaryEcho(calls.clone())),leaf_contract),issuer.clone(),Arc::new(RecoveryGrant {issuer:issuer.clone(),recovery:recovery.clone()}),Some(maka_host_js::factory(Limits::default()))).await.unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let binding = client.bind(client.activation(&id(2)).unwrap(),"echo".into()).await.unwrap().remove(0);
        let read = |input: &'static str| {
            let client = client.clone(); let binding = binding.clone(); let issued = scope(&issuer,true);
            async move {
                let value = client.start(binding,"echo".into(),json!(input),issued,Attachments::new().into()).await.unwrap().result().await.unwrap();
                serde_json::from_str::<OperationReply>(value.as_str().unwrap()).unwrap()
            }
        };
        let first = read("fail").await;
        assert!(matches!(first.receipt,Receipt::Recorded {outcome:OperationOutcome::Unknown {..},cleanup:OperationCleanup::Confirmed}));
        assert_eq!(read("fail").await,first);
        assert_eq!(read("recover").await,first);
        assert_eq!(calls.load(Ordering::SeqCst),1);
        let integer = read("integer").await;
        assert!(matches!(integer.receipt,Receipt::Unavailable {..}));
        assert_eq!(read("recover").await,integer);
        let stored_integer = store.operation(&integer.reference).unwrap().operation_observation().await.unwrap().unwrap();
        assert_eq!(stored_integer.outcome,OperationOutcome::Returned {value:json!(9007199254740993_u64)});
        assert_eq!(stored_integer.cleanup,OperationCleanup::Confirmed);
        assert_eq!(calls.load(Ordering::SeqCst),2);
        let large = read("large").await;
        assert!(matches!(&large.receipt,Receipt::Recorded {
            outcome:OperationOutcome::Returned {value},
            cleanup:OperationCleanup::Confirmed,
        } if value == &large_receipt_value()), "expected the complete large returned value with confirmed cleanup; calls={}, unknown={}", calls.load(Ordering::SeqCst), matches!(&large.receipt, Receipt::Recorded { outcome: OperationOutcome::Unknown {..}, .. }));
        let stored = store.operation(&large.reference).unwrap().operation_observation().await.unwrap().unwrap();
        assert_eq!(stored.outcome,OperationOutcome::Returned {value:large_receipt_value()});
        assert_eq!(stored.cleanup,OperationCleanup::Confirmed);
        assert_eq!(read("large").await,large);
        assert_eq!(read("recover").await,large);
        assert_eq!(calls.load(Ordering::SeqCst),3);
        client.retire(client.activation(&id(1)).unwrap()).await.unwrap();
        let reader_binding = client.bind(client.activation(&id(6)).unwrap(),"echo".into()).await.unwrap().remove(0);
        let recover = |reference: maka_plugin_core::operation::RecoveryRef| {
            let client = client.clone(); let binding = reader_binding.clone(); let issued = scope(&issuer,true);
            async move {
                let value = client.start(binding,"echo".into(),json!(serde_json::to_string(&reference).unwrap()),issued,Attachments::new().into()).await.unwrap().result().await.unwrap();
                serde_json::from_str::<OperationReply>(value.as_str().unwrap()).unwrap()
            }
        };
        // An independent reader has no import of the retired provider.
        assert_eq!(recover(large.reference.clone()).await,large);
        let mut missing = large.reference.clone(); missing.operation = Uuid::new_v4();
        assert!(matches!(recover(missing).await.receipt,Receipt::NotRecorded));
        recovery.store(false,Ordering::SeqCst);
        let denied = recover(large.reference.clone()).await;
        assert_eq!(denied.reference,large.reference);
        assert!(unavailable(denied).contains("historical grant denied"));
        assert_eq!(store.operation(&large.reference).unwrap().operation_observation().await.unwrap().unwrap(),stored);
        assert_eq!(calls.load(Ordering::SeqCst),3);
        app.shutdown().await.unwrap();drop(reader_binding);drop(binding);drop(app);drop(client);close(store).await;
    }).await.unwrap();
}

#[tokio::test]
async fn original_contract_metadata_stays_native_while_compact_receipts_are_deliverable() {
    let (_dir, _ns, store) = store().await;
    let issuer = Issuer::default();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut declared = contract(MethodMode::Mutation);
    let Interface::Service { methods } = &mut declared.interface else {
        unreachable!()
    };
    methods.get_mut("echo").unwrap().output =
        json!({"type":"string","minimum":9007199254740993_u64}).into();
    let mut provider_entry = entry(
        true,
        Implementation::Native {
            implementation: "native.echo".into(),
        },
        MethodMode::Mutation,
    );
    provider_entry.exports.get_mut("echo").unwrap().contract = declared.clone();
    let mut consumer_entry = entry(
        false,
        Implementation::JavaScript {
            module: "host.mjs".into(),
            realm: Realm::Shared,
        },
        MethodMode::Mutation,
    );
    consumer_entry.imports.get_mut("echo").unwrap().contract = declared.clone();
    let provider = package("large-contract", provider_entry, None);
    let consumer = package(
        "consumer",
        consumer_entry,
        Some("export function activate(){return {}; }".into()),
    );
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
        store.clone(),
        deployment,
        registry_contract(
            Arc::new(Echo {
                calls: calls.clone(),
            }),
            declared,
        ),
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
    let client = app.client();
    let binding = client
        .bind(client.activation(&id(2)).unwrap(), "echo".into())
        .await
        .unwrap()
        .remove(0);
    let operation = Uuid::new_v4();
    let mutation = mutate(
        &client,
        &store,
        binding.clone(),
        "echo".into(),
        json!("effect"),
        scope(&issuer, true),
        operation,
    )
    .await
    .unwrap();
    let reference = mutation.reference.clone();
    let reply = mutation.result().await;
    assert_eq!(reply.reference, reference);
    assert_eq!(
        reply.receipt,
        Receipt::Recorded {
            outcome: OperationOutcome::Returned {
                value: json!("effect")
            },
            cleanup: OperationCleanup::Confirmed,
        }
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    app.shutdown().await.unwrap();
    drop(binding);
    drop(app);
    drop(client);
    close(store).await;
}

#[tokio::test]
async fn preparation_is_effect_free_does_not_lock_native_root_and_never_redirects_after_restart() {
    let (dir, ns, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let issuer = Issuer::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let (app, deployment) = launch(
            store.clone(),
            &issuer,
            Arc::new(AtomicBool::new(true)),
            Arc::new(VerifiedEcho {
                caller: id(2),
                store: store.clone(),
                calls: calls.clone(),
            }),
        )
        .await;
        let client = app.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let prepared = client
            .prepare_mutation(
                binding,
                "echo".into(),
                json!("prepared"),
                scope(&issuer, true),
                Uuid::new_v4(),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        let reference = prepared.reference().clone();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(
            store
                .operation(&reference)
                .unwrap()
                .operation_observation()
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .application_intents(deployment, id(2), 0, 128)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(client.snapshot().instances.iter().all(|s| s.calls == 0));
        app.shutdown().await.unwrap();
        drop(app);
        close(store).await;
        // Prepared still exists. It must not retain VerifiedEcho -> RootStore -> RootOwner.
        let owner = Arc::new(RootOwner::open(&dir.path().join("root"), &ns).unwrap());
        let reopened = Arc::new(RootStore::open(owner).await.unwrap());
        let replacement = Application::start_from_store(
            reopened.clone(),
            deployment,
            registry_contract(
                Arc::new(Echo {
                    calls: calls.clone(),
                }),
                contract(MethodMode::Mutation),
            ),
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            Some(maka_host_js::factory(Limits::default())),
        )
        .await
        .unwrap();
        replacement.ready().await.unwrap();
        let recorded = reopened
            .record_application_intent(
                reference.source.clone(),
                id(2),
                reference.clone(),
                serde_json::Value::Null,
            )
            .await
            .unwrap();
        assert!(
            replacement
                .client()
                .mutate(prepared, recorded)
                .await
                .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(
            reopened
                .operation(&reference)
                .unwrap()
                .operation_observation()
                .await
                .unwrap()
                .is_none()
        );
        replacement.shutdown().await.unwrap();
        drop(replacement);
        drop(client);
        close(reopened).await;
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn recorded_intent_does_not_override_revocation_between_prepare_and_dispatch() {
    let (_dir, _ns, store) = store().await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let issuer = Issuer::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let (app, _) = launch(
            store.clone(),
            &issuer,
            Arc::new(AtomicBool::new(true)),
            Arc::new(VerifiedEcho {
                caller: id(2),
                store: store.clone(),
                calls: calls.clone(),
            }),
        )
        .await;
        let client = app.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        for provider_retired in [false, true] {
            let scope = scope(&issuer, true);
            let cancellation = scope.cancellation.clone();
            let prepared = client
                .prepare_mutation(
                    binding.clone(),
                    "echo".into(),
                    json!("effect"),
                    scope,
                    Uuid::new_v4(),
                    Attachments::new().into(),
                )
                .await
                .unwrap();
            let reference = prepared.reference().clone();
            let recorded = store
                .record_application_intent(
                    reference.source.clone(),
                    id(2),
                    reference.clone(),
                    serde_json::Value::Null,
                )
                .await
                .unwrap();
            if provider_retired {
                client.retire(binding.provider().clone()).await.unwrap();
            } else {
                cancellation.cancel();
            }
            assert!(client.mutate(prepared, recorded).await.is_err());
            assert!(
                store
                    .operation(&reference)
                    .unwrap()
                    .operation_observation()
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        app.shutdown().await.unwrap();
        drop(app);
        drop(client);
        // Holding a retired binding no longer keeps the handler or storage owner alive.
        close(store).await;
        drop(binding);
    })
    .await
    .unwrap();
}

struct CallerCheckedMutation {
    caller_database: std::path::PathBuf,
    started: Arc<tokio::sync::Semaphore>,
    release: Arc<tokio::sync::Semaphore>,
    fail_cleanup: bool,
}
impl Handler for CallerCheckedMutation {
    fn call(&self, _: String, input: Value, context: Context) -> BoxFuture<'static, Result<Value>> {
        let database = self.caller_database.clone();
        let started = self.started.clone();
        let release = self.release.clone();
        let fail_cleanup = self.fail_cleanup;
        Box::pin(async move {
            use sqlx::Connection;
            let reference = context.operation().unwrap();
            let mut connection = sqlx::SqliteConnection::connect_with(
                &sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(journal_database(
                        &database,
                        "application_intents",
                        reference.operation,
                    ))
                    .read_only(true),
            )
            .await
            .map_err(|e| e.to_string())?;
            let saved: String = sqlx::query_scalar(
                "SELECT reference_json FROM application_intents WHERE operation=?",
            )
            .bind(reference.operation.to_string())
            .fetch_one(&mut connection)
            .await
            .map_err(|e| e.to_string())?;
            let saved: maka_plugin_core::operation::RecoveryRef =
                serde_json::from_str(&saved).unwrap();
            assert_eq!(
                &saved, reference,
                "the separate caller Root committed the original reference before effects"
            );
            connection.close().await.map_err(|e| e.to_string())?;
            started.add_permits(1);
            release.acquire().await.unwrap().forget();
            if fail_cleanup {
                let mut ticket = context.scope().resources.reserve().unwrap();
                ticket.start();
                ticket.complete(Err("caller effect cleanup unconfirmed".into()));
            }
            Ok(input)
        })
    }
}
fn remote_mutation_packages() -> (Package, Package, Contract) {
    let mut declared = contract(MethodMode::Mutation);
    declared.transport = Transport::Remote;
    let (provider, consumer) = mutation_packages();
    let mut p = provider
        .manifest()
        .application
        .as_ref()
        .unwrap()
        .declaration()
        .clone();
    p.host
        .as_mut()
        .unwrap()
        .exports
        .get_mut("echo")
        .unwrap()
        .contract = declared.clone();
    let mut c = consumer
        .manifest()
        .application
        .as_ref()
        .unwrap()
        .declaration()
        .clone();
    c.host
        .as_mut()
        .unwrap()
        .imports
        .get_mut("echo")
        .unwrap()
        .contract = declared.clone();
    (
        package("native", p.host.take().unwrap(), None),
        package(
            "consumer",
            c.host.take().unwrap(),
            Some("export function activate(){return {}; }".into()),
        ),
        declared,
    )
}

struct RecordingGate {
    issuer: Issuer,
    prepared: Arc<Semaphore>,
    allowed: Arc<AtomicBool>,
}
impl Policy for RecordingGate {
    fn admit(&self, invocation: Invocation<'_>) -> Result<()> {
        let maka_plugin_core::contract::Interface::Service { methods } =
            &invocation.contract.interface
        else {
            unreachable!()
        };
        let mutation = methods[invocation.method].mode == MethodMode::Mutation;
        Grant(self.issuer.clone()).admit(invocation)?;
        if mutation {
            if !self.allowed.load(Ordering::SeqCst) {
                return Err("recording gate revoked".into());
            }
            self.prepared.add_permits(1);
        }
        Ok(())
    }
}

#[tokio::test]
async fn internal_caller_commit_precedes_final_admission_and_failed_record_never_dispatches() {
    for mode in ["retire", "revoke", "record-failure", "commit-error"] {
        let (dir, _ns, store) = store().await;
        tokio::time::timeout(Duration::from_secs(30), async {

            let issuer = Issuer::default();
            let calls = Arc::new(AtomicUsize::new(0));
            let prepared = Arc::new(Semaphore::new(0));
            let allowed = Arc::new(AtomicBool::new(true));
            let (sink, _) = mutation_packages();
            let mut forwarder_entry = entry(true, Implementation::JavaScript {
                module: "host.mjs".into(), realm: Realm::Shared,
            }, MethodMode::Query);
            forwarder_entry.imports.insert("child".into(), Import {
                contract: contract(MethodMode::Mutation), cardinality: Cardinality::One,
            });
            let operation = Uuid::new_v4();
            let source = format!(r#"
                export const service={{async echo(input,_observation,context) {{
                    try {{ await context.invoke({{operation:'mutate',import:'child',provider:0,method:'echo',input,operationId:'{operation}',attachments:{{}}}}); }}
                    catch(error) {{ return String(error); }}
                    throw Error('unexpected accepted child');
                }}}};
                export function activate() {{return {{echo:{{contract:{},service:['service']}}}};}}
            "#, serde_json::to_string(&contract(MethodMode::Query)).unwrap());
            let forwarder = package("forwarder", forwarder_entry, Some(source));
            let consumer = consumer();
            let mut composition = input(&forwarder, &consumer);
            let parent = composition.instances.get_mut("provider").unwrap();
            parent.key = Uuid::from_u128(4);
            parent.bindings.insert("child".into(), vec![Target::Instance {
                path: vec!["sink".into()], export: "echo".into(),
            }]);
            composition.instances.insert("sink".into(), node(&sink, 1, true));
            let deployment = Uuid::new_v4();
            store.commit_application(deployment, 0, composition, vec![], vec![sink, forwarder, consumer]).await.unwrap();
            let app = Application::start_from_store(store.clone(), deployment,
                registry_contract(Arc::new(VerifiedEcho {caller: id(4), store: store.clone(), calls: calls.clone()}), contract(MethodMode::Mutation)),
                issuer.clone(), Arc::new(RecordingGate {issuer: issuer.clone(), prepared: prepared.clone(), allowed: allowed.clone()}), Some(maka_host_js::factory(Limits::default()))).await.unwrap();
            app.ready().await.unwrap();
            let client = app.client();
            let binding = client.bind(client.activation(&id(2)).unwrap(), "echo".into()).await.unwrap().remove(0);
            let connection = rusqlite::Connection::open(dir.path().join("root").join(maka_event_log::root::ROOT_DATABASE)).unwrap();
            if mode == "record-failure" {
                connection.execute_batch("CREATE TRIGGER reject_caller_intent BEFORE INSERT ON application_intents BEGIN SELECT RAISE(ABORT,'caller record unavailable'); END;").unwrap();
            }
            if mode == "commit-error" {
                connection.execute_batch("CREATE TABLE caller_commit_parent (deployment TEXT, revision INTEGER, PRIMARY KEY(deployment,revision)); CREATE TABLE caller_commit_probe (deployment TEXT, revision INTEGER, FOREIGN KEY(deployment,revision) REFERENCES caller_commit_parent(deployment,revision) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER reject_caller_commit AFTER INSERT ON application_intents BEGIN INSERT INTO caller_commit_probe VALUES ('missing',1); END;").unwrap();
            }
            // A real competing SQLite writer keeps the caller commit pending.
            connection.execute_batch("BEGIN IMMEDIATE;").unwrap();
            let parent = client.start(binding, "echo".into(), json!("no-effect"), scope(&issuer, true), Attachments::new().into()).await.unwrap();
            prepared.acquire().await.unwrap().forget();
            match mode {
                "retire" => client.retire(client.activation(&id(1)).unwrap()).await.unwrap(),
                "revoke" => allowed.store(false, Ordering::SeqCst),
                _ => {},
            }
            connection.execute_batch("COMMIT;").unwrap();
            let error = parent.result().await.unwrap();
            let error = error.as_str().unwrap();
            match mode {
                "retire" => assert!(error.contains("retired") || error.contains("not active"), "{error}"),
                "revoke" => assert!(error.contains("recording gate revoked"), "{error}"),
                _ => assert!(error.contains("caller intent was not confirmed"), "{error}"),
            }
            let saved = store.application_intents(deployment, id(4), 0, 128).await.unwrap();
            if mode == "record-failure" || mode == "commit-error" {
                assert!(saved.is_empty());
            } else {
                assert_eq!(saved.len(), 1);
                assert_eq!(saved[0].reference.operation, operation);
                assert!(store.operation(&saved[0].reference).unwrap().operation_observation().await.unwrap().is_none());
            }
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            assert!(client.snapshot().cleanup_error.is_none(), "no effect admission is not a physical cleanup failure");
            app.shutdown().await.unwrap();
            drop(connection); drop(app); drop(client); close(store).await;
        }).await.unwrap();
    }
}
async fn commit_caller_source(
    store: &RootStore,
    deployment: Uuid,
    expected: u64,
    declared: Contract,
    role: &str,
) -> maka_plugin_core::deployment::DeploymentRef {
    let declaration = Declaration {
        host: Some(EntryDeclaration {
            implementation: Implementation::Native {
                implementation: "test.caller".into(),
            },
            configuration: json!({"type":"object"}).into(),
            imports: BTreeMap::from([(
                "echo".into(),
                Import {
                    contract: declared.clone(),
                    cardinality: Cardinality::One,
                },
            )]),
            exports: BTreeMap::new(),
        }),
        ui: None,
        composition: None,
    };
    let caller = Package::new(BTreeMap::from([(
        MANIFEST_FILE.into(),
        serde_json::to_vec(
            &json!({"schemaVersion":1,"id":"remote.caller","application":declaration}),
        )
        .unwrap(),
    )]))
    .unwrap();
    let mut node = node(&caller, 41, false);
    node.bindings.insert(
        "echo".into(),
        vec![Target::Remote {
            deployment: role.into(),
            instance: id(1),
            export: "echo".into(),
        }],
    );
    let input = Input {
        ui: None,
        instances: BTreeMap::from([("caller".into(), node)]),
    };
    let observed = maka_plugin_core::deployment::RemoteObservation {
        capability: maka_plugin_core::plan::RemoteCapability {
            deployment: role.into(),
            instance: id(1),
            export: "echo".into(),
        },
        declaration: Export {
            contract: declared,
            availability: Availability::Required,
        },
    };
    store
        .commit_application(deployment, expected, input, vec![observed], vec![caller])
        .await
        .unwrap()
}
#[tokio::test]
async fn separate_caller_root_stays_owned_through_effect_cleanup_and_keeps_original_after_rebinding()
 {
    for fail_cleanup in [false, true] {
        let (_host_dir, _host_ns, host_store) = store().await;
        let (caller_dir, caller_ns, caller_store) = store().await;
        tokio::time::timeout(Duration::from_secs(30),async {
            let (provider,consumer,declared)=remote_mutation_packages();
            let host_deployment=Uuid::new_v4();
            host_store.commit_application(host_deployment,0,input(&provider,&consumer),vec![],vec![provider,consumer]).await.unwrap();
            let caller_deployment=Uuid::new_v4();
            let caller_source=commit_caller_source(&caller_store,caller_deployment,0,declared.clone(),"original-host").await;
            let started=Arc::new(tokio::sync::Semaphore::new(0));let release=Arc::new(tokio::sync::Semaphore::new(0));let issuer=Issuer::default();
            let host=Application::start_from_store(host_store.clone(),host_deployment,registry_contract(Arc::new(CallerCheckedMutation {caller_database:caller_dir.path().join("root"),started:started.clone(),release:release.clone(),fail_cleanup}),declared.clone()),issuer.clone(),Arc::new(RecoveryGrant {issuer:issuer.clone(),recovery:Arc::new(AtomicBool::new(true))}),Some(maka_host_js::factory(Limits::default()))).await.unwrap();
            host.ready().await.unwrap();let client=host.client();
            let binding=client.bind(client.activation(&id(2)).unwrap(),"echo".into()).await.unwrap().remove(0);
            let prepared=client.prepare_mutation(binding,"echo".into(),json!("original"),scope(&issuer,true),Uuid::new_v4(),Attachments::new().into()).await.unwrap();
            let reference=prepared.reference().clone();
            assert!(host_store.operation(&reference).unwrap().operation_observation().await.unwrap().is_none());
            let recorded=caller_store.record_application_intent(caller_source.clone(),id(41),reference.clone(), serde_json::Value::Null).await.unwrap();
            let next=commit_caller_source(&caller_store,caller_deployment,1,declared,"replacement-host").await;
            assert_ne!(next,caller_source);
            let accepted=client.mutate(prepared,recorded).await.unwrap();
            started.acquire().await.unwrap().forget();
            close(caller_store).await;
            assert!(RootOwner::open(&caller_dir.path().join("root"),&caller_ns).is_err(),"the actual accepted effect retains the caller lease, not its observer or connection");
            release.add_permits(1);
            let completion=accepted.completion().await;
            assert_eq!(completion.cleanup.is_err(),fail_cleanup);
            let reply=completion.reply;
            assert_eq!(reply.reference,reference);
            assert_eq!(returned(reply),json!("original"));
            if fail_cleanup {
                assert!(host.shutdown().await.is_err());drop(host);drop(client);drop(host_store);
                assert!(RootOwner::open(&caller_dir.path().join("root"),&caller_ns).is_err(),"failed physical cleanup retains the original caller lease");
            } else {
                let owner=Arc::new(RootOwner::open(&caller_dir.path().join("root"),&caller_ns).unwrap());
                let caller=Arc::new(RootStore::open(owner).await.unwrap());
                assert_eq!(caller.load_application(caller_deployment).await.unwrap().unwrap().source().reference,next);
                let saved=caller.application_intents(caller_deployment,id(41),0,128).await.unwrap();
                assert_eq!(saved.len(),1);assert_eq!(saved[0].caller,caller_source);assert_eq!(saved[0].reference,reference);
                assert!(caller.operation(&reference).is_err(),"the current caller Root cannot substitute a not-recorded business receipt");
                let original=client.recover(client.activation(&id(2)).unwrap(),saved[0].reference.clone(),scope(&issuer,true)).await.unwrap().unwrap();
                assert_eq!(original.outcome,OperationOutcome::Returned {value:json!("original")});
                host.shutdown().await.unwrap();drop(host);drop(client);close(host_store).await;close(caller).await;
            }
        }).await.unwrap();
    }
}
