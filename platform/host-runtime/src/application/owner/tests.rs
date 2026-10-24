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
use maka_capabilities::call::Identity;
use maka_plugin_core::{
    composition::{Configuration, Environment, Node, PackageUse, Target},
    contract::{Availability, Cardinality, Export, Import, Method, Transport},
    package::{Declaration, EntryDeclaration, EntryTarget},
};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
struct Allowed;
impl Policy for Allowed {
    fn admit(&self, _: Invocation<'_>) -> Result<()> {
        Ok(())
    }
}
struct Count(Arc<AtomicUsize>);
impl Handler for Count {
    fn call(&self, _: String, input: Value, _: Context) -> BoxFuture<'static, Result<Value>> {
        let count = self.0.clone();
        Box::pin(async move {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(input)
        })
    }
}
impl NativeOwner for Count {
    fn close(&self) -> BoxFuture<'static, Result<()>> {
        Box::pin(async { Ok(()) })
    }
}
// Control backend termination independently of the owner's queued notification.
#[derive(Default)]
struct Domains(std::sync::Mutex<Vec<watch::Sender<bool>>>);
impl backend::Factory for Domains {
    fn create(&self) -> Result<Arc<dyn backend::Realm>> {
        let (closed, _) = watch::channel(false);
        self.0.lock().unwrap().push(closed.clone());
        Ok(Arc::new(Domain(closed)))
    }
}
struct Domain(watch::Sender<bool>);
impl backend::Realm for Domain {
    fn load(&self, _: String, _: String) -> Result<Arc<dyn backend::Module>> {
        unreachable!("owner admission fixture installs its resource directly")
    }
    fn is_terminated(&self) -> bool {
        *self.0.borrow()
    }
    fn failed(&self) -> BoxFuture<'static, String> {
        let mut closed = self.0.subscribe();
        Box::pin(async move {
            closed.wait_for(|closed| *closed).await.unwrap();
            "backend domain closed".into()
        })
    }
    fn shutdown(&self) -> BoxFuture<'static, ()> {
        let closed = self.0.clone();
        Box::pin(async move {
            closed.send_replace(true);
        })
    }
}
fn service_plan(contract: &Contract) -> (Input, Plan) {
    let mut packages = Packages::default();
    let mut nodes = BTreeMap::new();
    for (name, key, provider) in [("provider", 1, true), ("consumer", 2, false)] {
        let package = PackageRef {
            id: name.into(),
            revision: format!("sha256-{:064x}", key),
        };
        packages
            .insert(
                package.clone(),
                Declaration {
                    composition: None,
                    entries: BTreeMap::from([(
                        EntryTarget::Host,
                        EntryDeclaration {
                            scene: None,
                            implementation: if provider {
                                Implementation::Native {
                                    implementation: "native".into(),
                                }
                            } else {
                                Implementation::JavaScript {
                                    module: "consumer.mjs".into(),
                                    realm: Realm::Shared,
                                }
                            },
                            configuration: json!({}).into(),
                            imports: if provider {
                                BTreeMap::new()
                            } else {
                                BTreeMap::from([(
                                    "echo".into(),
                                    Import {
                                        contract: contract.clone(),
                                        cardinality: Cardinality::One,
                                    },
                                )])
                            },
                            exports: if provider {
                                BTreeMap::from([(
                                    "echo".into(),
                                    Export {
                                        contract: contract.clone(),
                                        availability: Availability::Required,
                                    },
                                )])
                            } else {
                                BTreeMap::new()
                            },
                        },
                    )]),
                },
            )
            .unwrap();
        nodes.insert(
            name.into(),
            Node {
                key: Uuid::from_u128(key),
                package: package.into(),
                use_package: PackageUse::Entry,
                configuration: Configuration::default(),
                parameters: Configuration::default(),
                bindings: if provider {
                    BTreeMap::new()
                } else {
                    BTreeMap::from([(
                        "echo".into(),
                        vec![Target::Instance {
                            path: vec!["provider".into()],
                            export: "echo".into(),
                        }],
                    )])
                },
                disabled: false,
                overrides: Vec::new(),
            },
        );
    }
    let input = Input {
        environment: Environment {
            location: ExecutionLocation::Host,
            presentation: None,
        },
        instances: nodes,
        recovery: None,
        launch: None,
    };
    let plan = Plan::prepare(&input, &packages, &RemoteExports::new()).unwrap();
    (input, plan)
}

#[tokio::test]
async fn final_admission_rejects_failed_consumer_before_terminal_notification_is_polled() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let contract = Contract {
            name: "example.Echo".into(),
            version: 1,
            transport: Transport::Local,
            interface: Interface::Service {
                methods: BTreeMap::from([(
                    "echo".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Query,
                        input: json!({}).into(),
                        output: json!({}).into(),
                        resources: BTreeMap::new(),
                    },
                )]),
            },
        };
        let (input, plan) = service_plan(&contract);
        let waiting_replacement = plan.instances()[&InstanceId(vec![Uuid::from_u128(2)])].clone();
        let issuer = Issuer::default();
        let domains = Arc::new(Domains::default());
        let mut owner = Owner::new(
            plan,
            input,
            BTreeMap::new(),
            NativeRegistry::default(),
            issuer.clone(),
            Arc::new(Allowed),
            Some(domains.clone()),
            watch::channel(Snapshot::default()).0,
            Weak::new(),
            None,
        );
        owner.pending.clear();
        owner.starting = false;
        let provider = owner
            .runtime
            .begin(&InstanceId(vec![Uuid::from_u128(1)]))
            .unwrap();
        let consumer = owner
            .runtime
            .begin(&InstanceId(vec![Uuid::from_u128(2)]))
            .unwrap();
        owner
            .activations
            .insert(provider.instance().clone(), provider.clone());
        owner
            .activations
            .insert(consumer.instance().clone(), consumer.clone());
        let count = Arc::new(AtomicUsize::new(0));
        let native = Arc::new(Count(count.clone()));
        let closing = native.clone();
        owner.owned.insert(
            provider.instance().clone(),
            Owned {
                imports: Arc::new(BTreeMap::new()),
                resource: owner
                    .runtime
                    .own_resource(&provider, "native provider")
                    .unwrap(),
                close: Some(Box::pin(async move { closing.close().await })),
                initializing: false,
                closing: false,
                retiring: false,
                native_owner: Some(native.clone()),
                vm: None,
            },
        );
        owner
            .runtime
            .publish(
                &provider,
                BTreeMap::from([(
                    "echo".into(),
                    Published {
                        contract: contract.clone(),
                        value: Service::new(contract, native).unwrap(),
                    },
                )]),
            )
            .map_err(|e| e.error)
            .unwrap();
        let resource = owner
            .runtime
            .own_resource(&consumer, "actual consumer module")
            .unwrap();
        let vm = owner.new_vm().unwrap();
        owner.owned.insert(
            consumer.instance().clone(),
            Owned {
                imports: Arc::new(BTreeMap::new()),
                resource,
                close: Some(Box::pin(async { Ok(()) })),
                initializing: false,
                closing: false,
                retiring: false,
                native_owner: None,
                vm: Some(vm),
            },
        );
        owner
            .runtime
            .publish(&consumer, BTreeMap::new())
            .map_err(|e| e.error)
            .unwrap();
        let binding = owner.capture_bindings(&consumer, "echo").unwrap().remove(0);
        let repeated = owner.capture_bindings(&consumer, "echo").unwrap().remove(0);
        assert!(Arc::ptr_eq(&binding.1, &repeated.1));
        assert!(Arc::ptr_eq(
            &binding.1,
            &owner.runtime.inspect(&binding.0).unwrap().contract,
        ));
        domains.0.lock().unwrap()[0].send_replace(true);
        owner.vms[&vm].failed().await;
        // Deliberately leave the notification unpolled. The command must check
        // actual domain health before accepting work from this consumer.
        assert_eq!(
            owner.runtime.status(&consumer).unwrap().phase,
            Phase::Active
        );
        let scope = issuer
            .issue(
                Identity::Remote {
                    request_id: Uuid::new_v4(),
                },
                CancellationToken::new(),
            )
            .unwrap();
        let (reply, result) = oneshot::channel();
        owner.command(Command::Call(Box::new(Call {
            kind: CallKind::Query(reply),
            parent: None,
            binding,
            method: "echo".into(),
            input: Value::Null,
            scope,
            attachments: Attachments::new(),
            capture: None,
            admitted: resource_ingress::AttachmentSize {
                payload: 0,
                descriptors: 0,
            },
            resources: Arc::new(Semaphore::new(0))
                .try_acquire_many_owned(0)
                .unwrap(),
            bytes: Arc::new(Semaphore::new(1)).try_acquire_owned().unwrap(),
        })));
        assert!(
            result
                .await
                .unwrap()
                .err()
                .unwrap()
                .contains("domain terminated")
        );
        assert_eq!(count.load(Ordering::SeqCst), 0);
        assert!(owner.jobs.is_empty());
        assert_eq!(
            owner.runtime.status(&provider).unwrap().phase,
            Phase::Active
        );
        assert_eq!(
            owner.runtime.status(&consumer).unwrap().phase,
            Phase::Retiring
        );
        // A new candidate is waiting on this old, already retiring domain.
        // Its delayed actual failure must not erase that replacement.
        owner.starting = true;
        owner.pending.push(waiting_replacement);
        owner.retire_vm(vm, "delayed original domain failure".into());
        assert!(owner.starting);
        assert_eq!(owner.pending.len(), 1);
        assert!(owner.startup_error.is_none());
        assert!(!owner.closing);
        owner.pending.clear();
        owner.starting = false;
        let original_vm = owner.vms[&vm].clone();
        owner.drive();
        while !owner.jobs.is_empty() {
            let done = owner.jobs.next().await.unwrap();
            owner.complete(done);
            owner.drive();
        }
        assert!(original_vm.is_terminated());
        assert!(owner.vms.is_empty());
        assert!(!owner.closing);
        assert_eq!(
            owner.runtime.status(&provider).unwrap().phase,
            Phase::Active
        );
        // Healthy module replacement closes its backend domain, even while a
        // later plan is starting; its terminal notification is not a failure.
        for _ in 0..16 {
            let activation = owner.runtime.begin(consumer.instance()).unwrap();
            owner
                .activations
                .insert(activation.instance().clone(), activation.clone());
            let resource = owner
                .runtime
                .own_resource(&activation, "healthy module")
                .unwrap();
            let index = owner.new_vm().unwrap();
            let vm = owner.vms[&index].clone();
            assert!(!vm.is_terminated());
            owner.owned.insert(
                activation.instance().clone(),
                Owned {
                    imports: Arc::new(BTreeMap::new()),
                    resource,
                    close: Some(Box::pin(async { Ok(()) })),
                    initializing: false,
                    closing: false,
                    retiring: false,
                    native_owner: None,
                    vm: Some(index),
                },
            );
            owner
                .runtime
                .publish(&activation, BTreeMap::new())
                .map_err(|e| e.error)
                .unwrap();
            owner.runtime.retire(&activation).unwrap();
            owner.drive();
            while !owner.jobs.is_empty() {
                let done = owner.jobs.next().await.unwrap();
                owner.complete(done);
                owner.drive();
            }
            assert!(vm.is_terminated());
            assert!(owner.vms.is_empty());
            assert!(owner.runtime.status(&activation).is_err());
            owner.starting = true;
            owner.retire_vm(index, "normal shutdown notification".into());
            assert!(owner.starting);
            assert!(owner.startup_error.is_none());
            owner.starting = false;
        }
        owner.stop();
        owner.drive();
        while let Some(done) = owner.jobs.next().await {
            owner.complete(done);
            owner.drive();
            if owner.closed {
                break;
            }
        }
        assert!(owner.closed);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn retained_old_head_after_new_explicit_adoption_does_not_poison_readiness() {
    use maka_event_log::root::{RootNamespaces, RootOwner};
    use maka_plugin_core::composition::{Environment, ExecutionLocation};
    let dir = tempfile::tempdir().unwrap();
    let ns = RootNamespaces {
        ownership: dir.path().join("owners"),
        control: dir.path().join("control"),
    };
    let store = Arc::new(
        maka_event_log::root_store::RootStore::open(Arc::new(
            RootOwner::create(&dir.path().join("root"), &ns).unwrap(),
        ))
        .await
        .unwrap(),
    );
    let input = Input {
        environment: Environment {
            location: ExecutionLocation::Host,
            presentation: None,
        },
        instances: BTreeMap::new(),
        recovery: None,
        launch: None,
    };
    let id = Uuid::new_v4();
    let first = store
        .commit_application(id, 0, input.clone(), vec![], vec![])
        .await
        .unwrap();
    let cursor = store.subscribe_application(first.clone()).unwrap();
    let second = store
        .commit_application(id, 1, input.clone(), vec![], vec![])
        .await
        .unwrap();
    // This is a real completed SQL head read retained across another owner turn.
    let (cursor, observed) = next_change(cursor).await;
    assert_eq!(observed.as_ref().unwrap(), &second);
    let third = store
        .commit_application(id, 2, input.clone(), vec![], vec![])
        .await
        .unwrap();
    let native = NativeRegistry::default();
    let (plan, sources) = prepare(&input, vec![], &native, true).unwrap();
    let (updates, _) = watch::channel(Snapshot::default());
    let mut owner = Owner::new(
        plan,
        input,
        sources,
        native,
        Issuer::default(),
        Arc::new(Allowed),
        None,
        updates,
        Weak::new(),
        Some((
            store
                .load_application_at(&first)
                .await
                .unwrap()
                .unwrap()
                .snapshot(),
            store.clone(),
        )),
    );
    owner
        .adopt(store.load_application_at(&third).await.unwrap().unwrap())
        .unwrap();
    owner.drive();
    owner.observe_source(observed.unwrap());
    let (_, latest) = next_change(cursor).await;
    owner.observe_source(latest.unwrap());
    let snapshot = owner.snapshot();
    assert_eq!(snapshot.desired, Some(third.clone()));
    assert_eq!(snapshot.effective, Some(third));
    assert!(snapshot.startup_error.is_none());
    assert!(owner.loading_adoption.is_none());
    assert!(owner.check_adoption_source(&second).is_err());
    drop(owner);
    Arc::try_unwrap(store).ok().unwrap().close().await.unwrap();
}

struct RetirementGate {
    subscription: bool,
    started: tokio::sync::Notify,
    returned: Arc<tokio::sync::Notify>,
    finish_query: Arc<tokio::sync::Notify>,
    cleanup: Arc<tokio::sync::Notify>,
    cancellation: std::sync::Mutex<Option<CancellationToken>>,
}
impl Handler for RetirementGate {
    fn call(&self, _: String, _: Value, context: Context) -> BoxFuture<'static, Result<Value>> {
        let subscription = self.subscription;
        let cleanup = self.cleanup.clone();
        let mut ticket = context.scope().resources.reserve().unwrap();
        ticket.start();
        tokio::spawn(async move {
            cleanup.notified().await;
            ticket.complete(Ok(()));
        });
        self.cancellation
            .lock()
            .unwrap()
            .replace(context.scope().cancellation.clone());
        self.started.notify_one();
        let stop = context.scope().cancellation.clone();
        let finished = self.finish_query.clone();
        let returned = self.returned.clone();
        Box::pin(async move {
            if subscription {
                stop.cancelled().await;
            } else {
                finished.notified().await;
            }
            returned.notify_one();
            Ok(Value::Null)
        })
    }
}

fn poll_ready(owner: &mut Owner) {
    while let Some(Some(done)) = owner.jobs.next().now_or_never() {
        owner.complete(done);
        owner.drive();
    }
}

async fn retirement_preserves_execution_cleanup(
    subscription: bool,
    consumer_only: bool,
    loading_consumer: bool,
) {
    let contract = Contract {
        name: "example.Retirement".into(),
        version: 1,
        transport: Transport::Local,
        interface: Interface::Service {
            methods: BTreeMap::from([(
                "observe".into(),
                Method {
                    progress: None,
                    mode: if subscription {
                        MethodMode::Subscription
                    } else {
                        MethodMode::Query
                    },
                    input: json!({}).into(),
                    output: json!({}).into(),
                    resources: BTreeMap::new(),
                },
            )]),
        },
    };
    let (input, plan) = service_plan(&contract);
    let issuer = Issuer::default();
    let mut owner = Owner::new(
        plan,
        input,
        BTreeMap::new(),
        NativeRegistry::default(),
        issuer.clone(),
        Arc::new(Allowed),
        None,
        watch::channel(Snapshot::default()).0,
        Weak::new(),
        None,
    );
    owner.pending.clear();
    owner.starting = false;
    let gate = Arc::new(RetirementGate {
        subscription,
        started: tokio::sync::Notify::new(),
        returned: Arc::new(tokio::sync::Notify::new()),
        finish_query: Arc::new(tokio::sync::Notify::new()),
        cleanup: Arc::new(tokio::sync::Notify::new()),
        cancellation: std::sync::Mutex::new(None),
    });
    let closes = Arc::new(AtomicUsize::new(0));
    let mut activations = Vec::new();
    for key in [1, 2] {
        let activation = owner
            .runtime
            .begin(&InstanceId(vec![Uuid::from_u128(key)]))
            .unwrap();
        let provider = key == 1;
        owner
            .activations
            .insert(activation.instance().clone(), activation.clone());
        let closed = closes.clone();
        owner.owned.insert(
            activation.instance().clone(),
            Owned {
                imports: Arc::new(BTreeMap::new()),
                resource: owner
                    .runtime
                    .own_resource(&activation, "native fixture")
                    .unwrap(),
                close: Some(Box::pin(async move {
                    if provider {
                        closed.fetch_add(1, Ordering::SeqCst);
                    }
                    Ok(())
                })),
                initializing: false,
                closing: false,
                retiring: false,
                native_owner: None,
                vm: None,
            },
        );
        if provider || !loading_consumer {
            owner
                .runtime
                .publish(
                    &activation,
                    if provider {
                        BTreeMap::from([(
                            "echo".into(),
                            Published {
                                contract: contract.clone(),
                                value: Service::new(contract.clone(), gate.clone()).unwrap(),
                            },
                        )])
                    } else {
                        BTreeMap::new()
                    },
                )
                .map_err(|error| error.error)
                .unwrap();
        }
        activations.push(activation);
    }
    let provider = &activations[0];
    let consumer = &activations[1];
    let binding = owner.capture_bindings(consumer, "echo").unwrap().remove(0);
    let scope = issuer
        .issue(
            Identity::Remote {
                request_id: Uuid::new_v4(),
            },
            CancellationToken::new(),
        )
        .unwrap();
    let (query_reply, query) = oneshot::channel();
    let (subscription_reply, observation) = oneshot::channel();
    owner.command(Command::Call(Box::new(Call {
        kind: if subscription {
            CallKind::Subscription {
                reply: subscription_reply,
            }
        } else {
            CallKind::Query(query_reply)
        },
        parent: None,
        binding,
        method: "observe".into(),
        input: Value::Null,
        scope: scope.clone(),
        attachments: Attachments::new(),
        capture: None,
        admitted: resource_ingress::AttachmentSize {
            payload: 0,
            descriptors: 0,
        },
        resources: Arc::new(Semaphore::new(0))
            .try_acquire_many_owned(0)
            .unwrap(),
        bytes: Arc::new(Semaphore::new(4))
            .try_acquire_many_owned(4)
            .unwrap(),
    })));
    let accepted_query = if subscription {
        None
    } else {
        Some(query.await.unwrap().unwrap())
    };
    let accepted_observation = if subscription {
        Some(observation.await.unwrap().unwrap())
    } else {
        None
    };
    poll_ready(&mut owner);
    gate.started.notified().await;
    owner.drive();
    poll_ready(&mut owner);
    assert!(
        !gate
            .cancellation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .is_cancelled(),
        "an admitted subscription remains live while its consumer initializes"
    );
    owner
        .runtime
        .retire(if consumer_only { consumer } else { provider })
        .unwrap();
    owner.drive();
    poll_ready(&mut owner);
    let cancelled = gate
        .cancellation
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .is_cancelled();
    assert_eq!(cancelled, subscription);
    assert!(
        !scope.cancellation.is_cancelled(),
        "retirement does not cancel the original caller"
    );
    if !subscription {
        gate.finish_query.notify_one();
        poll_ready(&mut owner);
    }
    gate.returned.notified().await;
    assert_eq!(
        owner.runtime.status(provider).unwrap().calls,
        1,
        "the returned handler still owns its unfinished native cleanup"
    );
    assert_eq!(
        closes.load(Ordering::SeqCst),
        0,
        "native close must wait for actual call cleanup"
    );
    assert!(!owner.closed);
    gate.cleanup.notify_one();
    let done = owner.jobs.next().await.unwrap();
    owner.complete(done);
    owner.drive();
    poll_ready(&mut owner);
    if subscription {
        accepted_observation
            .unwrap()
            .completion()
            .await
            .cleanup
            .unwrap();
    } else {
        let completion = accepted_query.unwrap().completion().await;
        assert_eq!(completion.result.unwrap(), Value::Null);
        completion.cleanup.unwrap();
    }
    scope.resources.finish().await.unwrap();
    if consumer_only {
        assert_eq!(owner.runtime.status(provider).unwrap().phase, Phase::Active);
    }
    owner.stop();
    owner.drive();
    while let Some(done) = owner.jobs.next().await {
        owner.complete(done);
        owner.drive();
    }
    assert!(owner.closed);
    assert_eq!(closes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn retiring_either_subscription_party_cancels_but_waits_for_original_cleanup() {
    tokio::time::timeout(Duration::from_secs(10), async {
        retirement_preserves_execution_cleanup(true, false, false).await;
        retirement_preserves_execution_cleanup(true, true, false).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn retirement_does_not_cancel_an_accepted_query() {
    tokio::time::timeout(
        Duration::from_secs(10),
        retirement_preserves_execution_cleanup(false, false, false),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn loading_consumer_subscription_survives_drive_until_retirement() {
    tokio::time::timeout(
        Duration::from_secs(10),
        retirement_preserves_execution_cleanup(true, true, true),
    )
    .await
    .unwrap();
}
