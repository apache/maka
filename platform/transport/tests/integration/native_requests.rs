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

use crate::support;
use futures_util::future::BoxFuture;
use maka_capabilities::call::Attachments;
use maka_capabilities::call::Identity;
use maka_event_log::{
    root::{RootNamespaces, RootOwner},
    root_store::RootStore,
};
use maka_host_runtime::application::{
    Application, Context, Handler, NativeActivation, NativeOwner, NativeRegistry, NativeRequest,
    NativeServices,
};
use maka_plugin_core::{
    composition::InstanceId,
    operation::{OperationOutcome, Receipt},
    package::Implementation,
    runtime::Published,
};
use maka_transport::{
    GATEWAY,
    transport::{NativeGrant, PeerPolicy},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Default)]
struct Jobs(Mutex<Vec<Arc<NativeRequest>>>);
impl NativeOwner for Jobs {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        let requests = self.0.lock().unwrap().clone();
        Box::pin(async move {
            for request in requests {
                request.finish().await?;
            }
            Ok(())
        })
    }
}
fn native(jobs: Arc<Jobs>, captured: Arc<Mutex<Option<NativeServices>>>) -> NativeRegistry {
    let mut registry = NativeRegistry::default();
    registry
        .insert(
            GATEWAY.into(),
            Arc::new(move |context, _| {
                *captured.lock().unwrap() = Some(context.services());
                let jobs = jobs.clone();
                Box::pin(async move {
                    NativeActivation {
                        exports: Ok(BTreeMap::new()),
                        owner: jobs,
                    }
                })
            }),
        )
        .unwrap();
    registry
}
fn grant(provider: InstanceId, recovery: bool) -> NativeGrant {
    NativeGrant {
        origin: support::identity(13),
        consumer: support::identity(13),
        provider,
        export: "Counter".into(),
        methods: ["read".into(), "write".into()].into(),
        recovery,
    }
}
fn request(services: &NativeServices, jobs: &Jobs) -> Arc<NativeRequest> {
    let request = Arc::new(
        services
            .request(
                Identity::Remote {
                    request_id: Uuid::new_v4(),
                },
                CancellationToken::new(),
            )
            .unwrap(),
    );
    jobs.0.lock().unwrap().push(request.clone());
    request
}
async fn store() -> (tempfile::TempDir, Arc<RootStore>) {
    let directory = tempfile::tempdir().unwrap();
    let namespaces = RootNamespaces {
        ownership: directory.path().join("owners"),
        control: directory.path().join("control"),
    };
    let root = Arc::new(RootOwner::create(&directory.path().join("root"), &namespaces).unwrap());
    let store = Arc::new(support::setup(RootStore::open(root)).await.unwrap());
    (directory, store)
}

#[tokio::test]
async fn native_domain_calls_require_explicit_grants_and_ignore_public_identity_claims() {
    let (_directory, store) = store().await;
    let deployment = Uuid::new_v4();
    let (input, packages) = support::host();
    store
        .commit_application(deployment, 0, input, vec![], packages)
        .await
        .unwrap();
    let captured = Arc::new(Mutex::new(None));
    let jobs = Arc::new(Jobs::default());
    let policy = Arc::new(PeerPolicy::default());
    let app = Application::start_from_store(
        store.clone(),
        deployment,
        native(jobs.clone(), captured.clone()),
        policy.issuer(),
        policy.clone(),
        Some(maka_host_js::factory(Default::default())),
    )
    .await
    .unwrap();
    app.ready().await.unwrap();
    let services = captured.lock().unwrap().clone().unwrap();
    assert_eq!(
        services
            .imports()
            .find(|(name, _)| *name == "business")
            .unwrap()
            .1[0]
            .provider()
            .instance(),
        &support::identity(11)
    );
    let denied = request(&services, &jobs);
    assert!(
        denied
            .call(
                "business",
                0,
                "read".into(),
                json!({}),
                Attachments::default()
            )
            .unwrap()
            .await
            .unwrap_err()
            .contains("not granted")
    );
    denied.finish().await.unwrap();
    app.shutdown().await.unwrap();
    drop(app);
    let jobs = Arc::new(Jobs::default());
    let policy = Arc::new(
        PeerPolicy::with_native_grants(vec![grant(support::identity(11), false)]).unwrap(),
    );
    let app = Application::start_from_store(
        store.clone(),
        deployment,
        native(jobs.clone(), captured.clone()),
        policy.issuer(),
        policy.clone(),
        Some(maka_host_js::factory(Default::default())),
    )
    .await
    .unwrap();
    app.ready().await.unwrap();
    let services = captured.lock().unwrap().clone().unwrap();
    let job = request(&services, &jobs);
    assert_eq!(
        job.call(
            "business",
            0,
            "read".into(),
            json!({}),
            Attachments::default()
        )
        .unwrap()
        .await
        .unwrap(),
        json!({"effects":0})
    );
    // Reusing public observation with a Host issuer does not create NativeOrigin.
    let claimed = policy
        .issuer()
        .issue(
            Identity::Remote {
                request_id: Uuid::new_v4(),
            },
            CancellationToken::new(),
        )
        .unwrap();
    let binding = app
        .client()
        .bind(
            app.client().activation(&support::identity(13)).unwrap(),
            "business".into(),
        )
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert!(
        app.client()
            .start(
                binding,
                "read".into(),
                json!({}),
                claimed.clone(),
                Attachments::default().into()
            )
            .await
            .is_err()
    );
    claimed.finish().await.unwrap();
    let operation = Uuid::new_v4();
    let mutation = job
        .mutate(
            "business",
            0,
            "write".into(),
            json!({}),
            operation,
            Attachments::default(),
        )
        .unwrap()
        .await
        .unwrap();
    assert!(
        matches!(mutation.receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { ref value }, .. } if value == &json!({"effects":1}))
    );
    assert!(
        job.recover(mutation.reference.clone())
            .unwrap()
            .await
            .is_err(),
        "mutation admission is not recovery approval"
    );
    job.finish().await.unwrap();
    assert!(
        job.call(
            "business",
            0,
            "read".into(),
            json!({}),
            Attachments::default()
        )
        .is_err()
    );
    app.client()
        .retire(app.client().activation(&support::identity(13)).unwrap())
        .await
        .unwrap();
    let retired = request(&services, &jobs);
    assert!(
        retired
            .call(
                "business",
                0,
                "read".into(),
                json!({}),
                Attachments::default()
            )
            .unwrap()
            .await
            .is_err(),
        "old native origin cannot start work after retirement"
    );
    retired.finish().await.unwrap();
    app.shutdown().await.unwrap();
    drop((app, job, services, denied));
    store.shutdown().await.unwrap();
}

struct Forward;
impl Handler for Forward {
    fn call(
        &self,
        _: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value, String>> {
        Box::pin(async move {
            context
                .call("next", 0, "read".into(), input, Attachments::default())?
                .await
        })
    }
}
impl NativeOwner for Forward {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
#[tokio::test]
async fn native_origin_survives_forwarding_but_never_grants_an_unlisted_downstream_edge() {
    for allowed in [false, true] {
        let (_directory, store) = store().await;
        let deployment = Uuid::new_v4();
        let (mut input, mut packages) = support::host();
        let provider = packages
            .iter_mut()
            .find(|package| package.manifest().id == "local.business")
            .unwrap();
        let next_package = provider.clone();
        let mut declaration = provider
            .manifest()
            .application
            .as_ref()
            .unwrap()
            .declaration()
            .clone();
        let entry = declaration.host.as_mut().unwrap();
        entry.implementation = Implementation::Native {
            implementation: "native.forward".into(),
        };
        entry.imports.insert(
            "next".into(),
            maka_plugin_core::contract::Import {
                contract: support::business(),
                cardinality: maka_plugin_core::contract::Cardinality::One,
            },
        );
        *provider = support::counter::package("local.business", declaration, None);
        let current = input.instances.get_mut("business").unwrap();
        current.package = provider.application_ref().into();
        current.bindings.insert(
            "next".into(),
            vec![maka_plugin_core::composition::Target::Instance {
                path: vec!["next".into()],
                export: "Counter".into(),
            }],
        );
        input
            .instances
            .insert("next".into(), support::counter::node(&next_package, 21));
        packages.push(next_package);
        store
            .commit_application(deployment, 0, input, vec![], packages)
            .await
            .unwrap();
        let captured = Arc::new(Mutex::new(None));
        let jobs = Arc::new(Jobs::default());
        let mut registry = native(jobs.clone(), captured.clone());
        registry
            .insert(
                "native.forward".into(),
                Arc::new(|_, _| {
                    Box::pin(async {
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "Counter".into(),
                                Published {
                                    contract: support::business(),
                                    value: Arc::new(Forward) as Arc<dyn Handler>,
                                },
                            )])),
                            owner: Arc::new(Forward),
                        }
                    })
                }),
            )
            .unwrap();
        let mut grants = vec![grant(support::identity(11), false)];
        if allowed {
            let mut edge = grant(support::identity(21), false);
            edge.consumer = support::identity(11);
            grants.push(edge);
        }
        let policy = Arc::new(PeerPolicy::with_native_grants(grants).unwrap());
        let app = Application::start_from_store(
            store.clone(),
            deployment,
            registry,
            policy.issuer(),
            policy.clone(),
            Some(maka_host_js::factory(Default::default())),
        )
        .await
        .unwrap();
        app.ready().await.unwrap();
        let services = captured.lock().unwrap().clone().unwrap();
        let job = request(&services, &jobs);
        let result = job
            .call(
                "business",
                0,
                "read".into(),
                json!({}),
                Attachments::default(),
            )
            .unwrap()
            .await;
        if allowed {
            assert_eq!(result.unwrap(), json!({"effects":0}));
        } else {
            assert!(result.unwrap_err().contains("not granted"));
        }
        job.finish().await.unwrap();
        app.shutdown().await.unwrap();
        drop((app, job, services));
        store.shutdown().await.unwrap();
    }
}

struct FailedEffect(Arc<std::sync::atomic::AtomicUsize>);
impl Handler for FailedEffect {
    fn call(
        &self,
        _: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value, String>> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(async move {
            if input["cleanup"].as_bool() == Some(true) {
                let mut ticket = context.scope().resources.reserve().unwrap();
                ticket.start();
                ticket.complete(Err("original native effect cleanup unconfirmed".into()));
                Ok(json!({"effects":1}))
            } else {
                Err("reply lost after effect".into())
            }
        })
    }
}
impl NativeOwner for FailedEffect {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
#[tokio::test]
async fn native_requests_preserve_unknown_receipts_and_independent_failed_cleanup() {
    for cleanup in [false, true] {
        let (_directory, store) = store().await;
        let deployment = Uuid::new_v4();
        let (mut input, mut packages) = support::host();
        let provider = packages
            .iter_mut()
            .find(|package| package.manifest().id == "local.business")
            .unwrap();
        let mut declaration = provider
            .manifest()
            .application
            .as_ref()
            .unwrap()
            .declaration()
            .clone();
        declaration.host.as_mut().unwrap().implementation = Implementation::Native {
            implementation: "native.failure".into(),
        };
        *provider = support::counter::package("local.business", declaration, None);
        input.instances.get_mut("business").unwrap().package = provider.application_ref().into();
        store
            .commit_application(deployment, 0, input, vec![], packages)
            .await
            .unwrap();
        let captured = Arc::new(Mutex::new(None));
        let jobs = Arc::new(Jobs::default());
        let mut registry = native(jobs.clone(), captured.clone());
        let effects = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let capture = effects.clone();
        registry
            .insert(
                "native.failure".into(),
                Arc::new(move |_, _| {
                    let failed = Arc::new(FailedEffect(capture.clone()));
                    Box::pin(async move {
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "Counter".into(),
                                Published {
                                    contract: support::business(),
                                    value: failed.clone() as Arc<dyn Handler>,
                                },
                            )])),
                            owner: failed,
                        }
                    })
                }),
            )
            .unwrap();
        let policy = Arc::new(
            PeerPolicy::with_native_grants(vec![grant(support::identity(11), true)]).unwrap(),
        );
        let app = Application::start_from_store(
            store.clone(),
            deployment,
            registry,
            policy.issuer(),
            policy.clone(),
            Some(maka_host_js::factory(Default::default())),
        )
        .await
        .unwrap();
        app.ready().await.unwrap();
        let services = captured.lock().unwrap().clone().unwrap();
        let job = request(&services, &jobs);
        let operation = Uuid::new_v4();
        let reply = job
            .mutate(
                "business",
                0,
                "write".into(),
                json!({"cleanup":cleanup}),
                operation,
                Attachments::default(),
            )
            .unwrap()
            .await
            .unwrap();
        if cleanup {
            assert!(matches!(
                reply.receipt,
                Receipt::Recorded {
                    outcome: OperationOutcome::Returned { .. },
                    cleanup: maka_plugin_core::operation::OperationCleanup::Failed { .. }
                }
            ));
            assert!(
                job.finish()
                    .await
                    .unwrap_err()
                    .contains("cleanup unconfirmed")
            );
            assert!(app.shutdown().await.is_err());
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            let snapshot = loop {
                let snapshot = app.client().snapshot();
                if snapshot.instances.iter().any(|status| {
                    status.activation.instance() == &support::identity(13)
                        && !status.failures.is_empty()
                }) {
                    break snapshot;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "native owner close did not publish original request cleanup failure"
                );
                tokio::task::yield_now().await;
            };
            assert!(!snapshot.closed);
            assert!(snapshot.cleanup_error.is_some());
            assert_eq!(effects.load(std::sync::atomic::Ordering::SeqCst), 1);
            // Retain this intentional unconfirmed-cleanup Root; do not delete its
            // files underneath the original failed owner during test teardown.
            let retained = _directory.keep();
            eprintln!(
                "retained negative cleanup fixture Root: {}",
                retained.display()
            );
            assert!(
                snapshot
                    .instances
                    .iter()
                    .filter(|status| status.activation.instance() == &support::identity(13))
                    .any(|status| status.resources > 0 && !status.failures.is_empty()),
                "original native caller retains its failed owner resource fence"
            );
            assert!(
                snapshot
                    .instances
                    .iter()
                    .any(
                        |status| status.activation.instance() == &support::identity(11)
                            && status.calls > 0
                            && !status.failures.is_empty()
                    ),
                "original provider retains its failed execution fence"
            );
        } else {
            assert!(matches!(
                reply.receipt,
                Receipt::Recorded {
                    outcome: OperationOutcome::Unknown { .. },
                    cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed
                }
            ));
            let repeated = job
                .mutate(
                    "business",
                    0,
                    "write".into(),
                    json!({"cleanup":cleanup}),
                    operation,
                    Attachments::default(),
                )
                .unwrap()
                .await
                .unwrap();
            assert_eq!(
                reply, repeated,
                "an unknown original operation remains the same receipt"
            );
            assert_eq!(
                effects.load(std::sync::atomic::Ordering::SeqCst),
                1,
                "historical receipt lookup must not replay an unknown effect"
            );
            let original = job
                .recover(reply.reference.clone())
                .unwrap()
                .await
                .unwrap()
                .unwrap();
            assert!(matches!(original.outcome, OperationOutcome::Unknown { .. }));
            job.finish().await.unwrap();
            app.shutdown().await.unwrap();
            drop((app, job, services));
            store.shutdown().await.unwrap();
        }
    }
}

#[tokio::test]
async fn native_resource_capture_shares_host_budget_and_cannot_cross_request_scope() {
    use maka_capabilities::call::ResourceEncoding;
    use maka_host_runtime::application::ResourceDescriptor;
    let (_directory, store) = store().await;
    let deployment = Uuid::new_v4();
    let (input, packages) = support::host();
    store
        .commit_application(deployment, 0, input, vec![], packages)
        .await
        .unwrap();
    let captured = Arc::new(Mutex::new(None));
    let jobs = Arc::new(Jobs::default());
    let policy =
        Arc::new(PeerPolicy::with_native_grants(vec![grant(support::identity(11), true)]).unwrap());
    let app = Application::start_from_store(
        store,
        deployment,
        native(jobs.clone(), captured.clone()),
        policy.issuer(),
        policy,
        Some(maka_host_js::factory(Default::default())),
    )
    .await
    .unwrap();
    app.ready().await.unwrap();
    let services = captured.lock().unwrap().clone().unwrap();
    let original = request(&services, &jobs);
    let other = request(&services, &jobs);
    let descriptors = |length| {
        BTreeMap::from([(
            "file".into(),
            ResourceDescriptor {
                resource: maka_plugin_core::contract::binary_resource_type(),
                encoding: ResourceEncoding::Bytes,
                length,
                metadata: json!({}),
            },
        )])
    };
    let receiving = original
        .capture_resources(descriptors(64 * 1024 * 1024))
        .unwrap();
    assert!(
        other
            .capture_resources(descriptors(1))
            .err()
            .unwrap()
            .contains("budget exhausted")
    );
    assert!(
        app.client()
            .capture_resources(other.scope().clone(), descriptors(1))
            .err()
            .unwrap()
            .contains("budget exhausted")
    );
    drop(receiving);
    drop(other.capture_resources(descriptors(1)).unwrap());
    let foreign = original
        .capture_resources(BTreeMap::new())
        .unwrap()
        .finish()
        .unwrap();
    assert!(
        other
            .mutate(
                "business",
                0,
                "write".into(),
                json!({}),
                Uuid::new_v4(),
                foreign
            )
            .err()
            .unwrap()
            .contains("another request Scope")
    );
    let resources = original
        .capture_resources(BTreeMap::new())
        .unwrap()
        .finish()
        .unwrap();
    let reply = original
        .mutate(
            "business",
            0,
            "write".into(),
            json!({}),
            Uuid::new_v4(),
            resources,
        )
        .unwrap()
        .await
        .unwrap();
    assert!(
        matches!(reply.receipt, Receipt::Recorded {outcome:OperationOutcome::Returned{ref value},cleanup:maka_plugin_core::operation::OperationCleanup::Confirmed} if value==&json!({"effects":1}))
    );
    let recovered = original
        .recover(reply.reference)
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        Receipt::Recorded {
            outcome: recovered.outcome,
            cleanup: recovered.cleanup
        },
        reply.receipt
    );
    original.finish().await.unwrap();
    other.finish().await.unwrap();
    assert!(original.capture_resources(BTreeMap::new()).is_err());
    app.shutdown().await.unwrap();
}
