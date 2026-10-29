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

mod caller;
mod execution_basis;
mod host_logs;
mod management;
mod native_context;
mod operations;
mod persistence;
mod resource_ingress;
mod retirement;
mod subscriptions;

// Opening a real Root initializes its control database and eight execution partitions.
// Keep that bounded setup cost separate from each scenario's behavior deadline.
async fn setup<T>(future: impl std::future::Future<Output = T>) -> T {
    let started = std::time::Instant::now();
    tokio::time::timeout(std::time::Duration::from_secs(60), future)
        .await
        .unwrap_or_else(|_| {
            panic!(
                "fixture initialization timed out after {:?}",
                started.elapsed()
            )
        })
}

use futures_util::{FutureExt, future::BoxFuture};
use maka_capabilities::call::Attachments;
use maka_capabilities::call::Identity;
use maka_capabilities::call::Issuer;
use maka_capabilities::call::ReadResource;
use maka_capabilities::call::Scope;
use maka_host_runtime::application::{
    Application, Context, Handler, Invocation, NativeActivation, NativeOwner, NativeRegistry,
    Policy, Result,
};
use maka_js_runtime::plugin::Limits;
use maka_packages::MANIFEST_FILE;
use maka_packages::Package;
use maka_plugin_core::{
    composition::{Configuration, Input, InstanceId, Node, PackageUse, Target},
    contract::{
        Availability, Cardinality, Contract, Export, Import, Interface, Method, MethodMode,
        ResourceType, Transport,
    },
    package::{Declaration, EntryDeclaration, Implementation, Realm},
    runtime::{Phase, Published},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

// Hold the thread-local dispatcher through actual current-thread fixture shutdown.
fn log_capture() -> (std::fs::File, tracing::subscriber::DefaultGuard) {
    let file = tempfile::tempfile().unwrap();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(file.try_clone().unwrap())
        .with_max_level(tracing::Level::WARN)
        .with_ansi(false)
        .without_time()
        .finish();
    (file, tracing::subscriber::set_default(subscriber))
}
fn log_text(file: &mut std::fs::File) -> String {
    use std::io::{Read, Seek};
    file.rewind().unwrap();
    let mut text = String::new();
    file.read_to_string(&mut text).unwrap();
    text
}

fn contract(mode: MethodMode) -> Contract {
    Contract {
        name: "example.Echo".into(),
        version: 1,
        transport: Transport::Local,
        interface: Interface::Service {
            methods: BTreeMap::from([(
                "echo".into(),
                Method {
                    progress: None,
                    mode,
                    input: json!({"type":"string"}).into(),
                    output: json!({"type":"string"}).into(),
                    resources: BTreeMap::new(),
                },
            )]),
        },
    }
}
fn entry(provider: bool, implementation: Implementation, mode: MethodMode) -> EntryDeclaration {
    EntryDeclaration {
        implementation,
        configuration: json!({"type":"object"}).into(),
        imports: if provider {
            BTreeMap::new()
        } else {
            BTreeMap::from([(
                "echo".into(),
                Import {
                    contract: contract(mode),
                    cardinality: Cardinality::One,
                },
            )])
        },
        exports: if provider {
            BTreeMap::from([(
                "echo".into(),
                Export {
                    contract: contract(mode),
                    availability: Availability::Required,
                },
            )])
        } else {
            BTreeMap::new()
        },
    }
}
fn package(id: &str, entry: EntryDeclaration, source: Option<String>) -> Package {
    let mut files = BTreeMap::from([(
        MANIFEST_FILE.into(),
        serde_json::to_vec(&json!({
            "schemaVersion":1,"id":id,"application":Declaration {
                host: Some(entry), ui: None, composition: None,
            }
        }))
        .unwrap(),
    )]);
    if let Some(source) = source {
        files.insert("host.mjs".into(), source.into_bytes());
    }
    Package::new(files).unwrap()
}
fn node(package: &Package, key: u128, provider: bool) -> Node {
    Node {
        key: Uuid::from_u128(key),
        package: package.application_ref().into(),
        use_package: PackageUse::Host,
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
    }
}
fn input(provider: &Package, consumer: &Package) -> Input {
    Input {
        ui: None,
        instances: BTreeMap::from([
            ("provider".into(), node(provider, 1, true)),
            ("a".into(), node(consumer, 2, false)),
            ("b".into(), node(consumer, 3, false)),
        ]),
    }
}
fn id(key: u128) -> InstanceId {
    InstanceId(vec![Uuid::from_u128(key)])
}
fn consumer() -> Package {
    package(
        "consumer",
        entry(
            false,
            Implementation::JavaScript {
                module: "host.mjs".into(),
                realm: Realm::Shared,
            },
            MethodMode::Query,
        ),
        Some("export function activate() { return {}; }".into()),
    )
}
fn large_json_text() -> String {
    "original界🙂\"\\\n\t".repeat(64 * 1024)
}
fn scope(issuer: &Issuer, allowed: bool) -> Scope {
    issuer
        .issue_with(
            Identity::Remote {
                request_id: Uuid::new_v4(),
            },
            allowed,
            CancellationToken::new(),
        )
        .unwrap()
}
struct Grant(Issuer);
impl Policy for Grant {
    fn admit(&self, invocation: Invocation<'_>) -> Result<()> {
        if self.0.evidence::<bool>(invocation.scope) == Some(&true) {
            Ok(())
        } else {
            Err("query grant denied".into())
        }
    }
}
async fn permit(semaphore: &Semaphore) {
    semaphore.acquire().await.unwrap().forget();
}

#[tokio::test]
async fn javascript_exports_use_shared_core_exact_binding_and_private_realms() {
    tokio::time::timeout(Duration::from_secs(20), async {
        for realm in [Realm::Shared, Realm::Dedicated] {
            let source = format!(r#"
                let calls = 0;
                export const service = {{ label:'original', async echo(input) {{
                    await Promise.resolve();
                    service.echo = () => 'replacement';
                    return this.label + ':' + input + ':' + ++calls;
                }} }};
                export function activate() {{
                    if (typeof Deno !== 'undefined' || typeof fetch !== 'undefined') throw Error('ambient Host bridge');
                    return {{ echo: {{ contract: {}, service:['service'] }} }};
                }}
            "#, serde_json::to_string(&contract(MethodMode::Query)).unwrap());
            let provider = package("script", entry(true, Implementation::JavaScript { module:"host.mjs".into(), realm }, MethodMode::Query), Some(source));
            let consumer = consumer();
            let issuer = Issuer::default();
            let app = Application::start(input(&provider, &consumer), vec![provider, consumer], NativeRegistry::default(),
                issuer.clone(), Arc::new(Grant(issuer.clone())), Some(maka_host_js::factory(Limits::default()))).unwrap();
            app.ready().await.unwrap();
            let client = app.client();
            let a = client.activation(&id(2)).unwrap();
            let b = client.activation(&id(3)).unwrap();
            let first = client.bind(a.clone(), "echo".into()).await.unwrap().remove(0);
            let second = client.bind(b, "echo".into()).await.unwrap().remove(0);
            assert_eq!(first.registration_epoch(), second.registration_epoch());
            for (binding, text, count) in [(first.clone(), "one", 1), (first.clone(), "two", 2)] {
                let value = client.start(binding, "echo".into(), json!(text), scope(&issuer, true), Attachments::new().into()).await.unwrap().result().await.unwrap();
                assert_eq!(value, json!(format!("original:{text}:{count}")));
            }
            client.retire(a).await.unwrap();
            assert!(client.start(first, "echo".into(), json!("late"), scope(&issuer, true), Attachments::new().into()).await.is_err());
            assert_eq!(client.start(second, "echo".into(), json!("other"), scope(&issuer, true), Attachments::new().into()).await.unwrap().result().await.unwrap(), json!("original:other:3"));
            app.shutdown().await.unwrap();
            assert!(client.snapshot().closed);
        }
    }).await.unwrap();
}

struct Echo {
    calls: Arc<AtomicUsize>,
}
impl Handler for Echo {
    fn call(&self, _: String, input: Value, context: Context) -> BoxFuture<'static, Result<Value>> {
        let scope = context.scope().clone();
        let calls = self.calls.clone();
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            match input.as_str().unwrap() {
                "fail" => Err("ordinary business error".into()),
                "bad-result" => Ok(json!(false)),
                "resource-fail" => {
                    let mut ticket = scope.resources.reserve().unwrap();
                    ticket.start();
                    ticket.complete(Err("actual resource cleanup failed".into()));
                    Ok(input)
                }
                "panic" => panic!("query implementation panicked"),
                _ => Ok(input),
            }
        })
    }
}
fn native_package() -> Package {
    package(
        "native",
        entry(
            true,
            Implementation::Native {
                implementation: "native.echo".into(),
            },
            MethodMode::Query,
        ),
        None,
    )
}
struct CloseFn(Arc<dyn Fn() -> BoxFuture<'static, Result<()>> + Send + Sync>);
impl NativeOwner for CloseFn {
    fn close(&self) -> BoxFuture<'static, Result<()>> {
        (self.0)()
    }
}
fn native_owner(
    f: impl Fn() -> BoxFuture<'static, Result<()>> + Send + Sync + 'static,
) -> Arc<dyn NativeOwner> {
    Arc::new(CloseFn(Arc::new(f)))
}
fn registry(query: Arc<dyn Handler>) -> NativeRegistry {
    registry_contract(query, contract(MethodMode::Query))
}
fn registry_contract(query: Arc<dyn Handler>, contract: Contract) -> NativeRegistry {
    let mut registry = NativeRegistry::default();
    registry
        .insert(
            "native.echo".into(),
            Arc::new(move |_, _| {
                let query = query.clone();
                let contract = contract.clone();
                Box::pin(async move {
                    NativeActivation {
                        exports: Ok(BTreeMap::from([(
                            "echo".into(),
                            Published {
                                contract,
                                value: query,
                            },
                        )])),
                        owner: native_owner(|| Box::pin(async { Ok(()) })),
                    }
                })
            }),
        )
        .unwrap();
    registry
}

#[tokio::test]
async fn authority_and_validation_reject_before_work_and_business_errors_settle_cleanly() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let provider = native_package();
        let consumer = consumer();
        let issuer = Issuer::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let app = Application::start(
            input(&provider, &consumer),
            vec![provider, consumer],
            registry(Arc::new(Echo {
                calls: calls.clone(),
            })),
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            Some(maka_host_js::factory(Limits::default())),
        )
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        for denied in [scope(&Issuer::default(), true), scope(&issuer, false)] {
            assert!(
                client
                    .start(
                        binding.clone(),
                        "echo".into(),
                        json!("input"),
                        denied,
                        Attachments::new().into()
                    )
                    .await
                    .is_err()
            );
        }
        let revoked = scope(&issuer, true);
        revoked.cancellation.cancel();
        assert!(
            client
                .start(
                    binding.clone(),
                    "echo".into(),
                    json!("input"),
                    revoked,
                    Attachments::new().into()
                )
                .await
                .is_err()
        );
        for (method, input) in [("unknown", json!("input")), ("echo", json!(false))] {
            assert!(
                client
                    .start(
                        binding.clone(),
                        method.into(),
                        input,
                        scope(&issuer, true),
                        Attachments::new().into()
                    )
                    .await
                    .is_err()
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let original = json!(large_json_text());
        let large_scope = scope(&issuer, true);
        assert_eq!(
            client
                .start(
                    binding.clone(),
                    "echo".into(),
                    original.clone(),
                    large_scope.clone(),
                    Attachments::new().into()
                )
                .await
                .unwrap()
                .result()
                .await
                .unwrap(),
            original
        );
        large_scope.finish().await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        for value in ["fail", "bad-result"] {
            assert!(
                client
                    .start(
                        binding.clone(),
                        "echo".into(),
                        json!(value),
                        scope(&issuer, true),
                        Attachments::new().into()
                    )
                    .await
                    .unwrap()
                    .result()
                    .await
                    .is_err()
            );
            let status = client
                .snapshot()
                .instances
                .into_iter()
                .find(|s| s.activation.instance() == &id(1))
                .unwrap();
            assert_eq!(status.calls, 0);
            assert_eq!(status.phase, Phase::Active);
            assert!(status.failures.is_empty());
        }
        assert_eq!(
            client
                .start(
                    binding,
                    "echo".into(),
                    json!("healthy"),
                    scope(&issuer, true),
                    Attachments::new().into()
                )
                .await
                .unwrap()
                .result()
                .await
                .unwrap(),
            json!("healthy")
        );
        app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

async fn javascript_nested_echo_preserves_large_json(configuration: bool) {
    tokio::time::timeout(Duration::from_secs(20), async {
        for realm in [Realm::Shared, Realm::Dedicated] {
            let implementation = Implementation::JavaScript {
                module: "host.mjs".into(),
                realm,
            };
            let mut declaration = entry(true, implementation.clone(), MethodMode::Query);
            declaration.imports = entry(false, implementation, MethodMode::Query).imports;
            let source = format!(
                r#"
                    let configuration;
                    export const service = {{
                        async echo(input, _observation, context) {{
                            return await context.invoke({{
                                operation: 'call', import: 'echo', provider: 0,
                                method: 'echo', input: configuration.original ?? input,
                                attachments: {{}}
                            }});
                        }}
                    }};
                    export function activate(config) {{
                        configuration = config;
                        return {{echo: {{contract: {}, service: ['service']}}}};
                    }}
                "#,
                serde_json::to_string(&contract(MethodMode::Query)).unwrap()
            );
            let wrapper = package("forwarder", declaration, Some(source));
            let provider = native_package();
            let consumer = consumer();
            let mut composition = input(&provider, &consumer);
            let mut wrapper_node = node(&wrapper, 4, false);
            let original = json!(large_json_text());
            if configuration {
                wrapper_node
                    .configuration
                    .values
                    .insert("original".into(), original.clone());
            }
            composition.instances.insert("wrapper".into(), wrapper_node);
            composition
                .instances
                .get_mut("a")
                .unwrap()
                .bindings
                .get_mut("echo")
                .unwrap()[0] = Target::Instance {
                path: vec!["wrapper".into()],
                export: "echo".into(),
            };
            let calls = Arc::new(AtomicUsize::new(0));
            let issuer = Issuer::default();
            let app = Application::start(
                composition,
                vec![provider, consumer, wrapper],
                registry(Arc::new(Echo {
                    calls: calls.clone(),
                })),
                issuer.clone(),
                Arc::new(Grant(issuer.clone())),
                Some(maka_host_js::factory(Limits::default())),
            )
            .unwrap();
            app.ready().await.unwrap();
            let client = app.client();
            let binding = client
                .bind(client.activation(&id(2)).unwrap(), "echo".into())
                .await
                .unwrap()
                .remove(0);
            let request_scope = scope(&issuer, true);
            assert_eq!(
                client
                    .start(
                        binding,
                        "echo".into(),
                        if configuration {
                            json!("read configuration")
                        } else {
                            original.clone()
                        },
                        request_scope.clone(),
                        Attachments::new().into(),
                    )
                    .await
                    .unwrap()
                    .result()
                    .await
                    .unwrap(),
                original
            );
            request_scope.finish().await.unwrap();
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            app.shutdown().await.unwrap();
            assert!(client.snapshot().closed);
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn javascript_nested_query_preserves_large_unicode_json() {
    javascript_nested_echo_preserves_large_json(false).await;
}

#[tokio::test]
async fn javascript_configuration_preserves_large_unicode_json() {
    javascript_nested_echo_preserves_large_json(true).await;
}

struct Held {
    started: Arc<Semaphore>,
    release: Arc<Semaphore>,
    resource_started: Arc<Semaphore>,
    resource_release: Arc<Semaphore>,
}
impl Handler for Held {
    fn call(&self, _: String, input: Value, context: Context) -> BoxFuture<'static, Result<Value>> {
        let scope = context.scope().clone();
        let started = self.started.clone();
        let release = self.release.clone();
        let resource_started = self.resource_started.clone();
        let resource_release = self.resource_release.clone();
        Box::pin(async move {
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
async fn abandoned_observer_and_root_keep_actual_query_resource_and_native_close_owned() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let started = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let resource_started = Arc::new(Semaphore::new(0));
        let resource_release = Arc::new(Semaphore::new(0));
        let native_closed = Arc::new(Semaphore::new(0));
        let query = Arc::new(Held {
            started: started.clone(),
            release: release.clone(),
            resource_started: resource_started.clone(),
            resource_release: resource_release.clone(),
        });
        let weak = Arc::downgrade(&query);
        let mut native = NativeRegistry::default();
        let close = native_closed.clone();
        native
            .insert(
                "native.echo".into(),
                Arc::new(move |_, _| {
                    let query: Arc<dyn Handler> = query.clone();
                    let close = close.clone();
                    Box::pin(async move {
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "echo".into(),
                                Published {
                                    contract: contract(MethodMode::Query),
                                    value: query,
                                },
                            )])),
                            owner: native_owner(move || {
                                let close = close.clone();
                                Box::pin(async move {
                                    close.add_permits(1);
                                    Ok(())
                                })
                            }),
                        }
                    })
                }),
            )
            .unwrap();
        let provider = native_package();
        let consumer = consumer();
        let issuer = Issuer::default();
        let app = Application::start(
            input(&provider, &consumer),
            vec![provider, consumer],
            native,
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            Some(maka_host_js::factory(Limits::default())),
        )
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let observer = client
            .start(
                binding,
                "echo".into(),
                json!("held"),
                scope(&issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        permit(&started).await;
        drop(observer);
        drop(app);
        drop(client);
        assert!(weak.upgrade().is_some());
        assert_eq!(native_closed.available_permits(), 0);
        release.add_permits(1);
        permit(&resource_started).await;
        assert!(weak.upgrade().is_some());
        assert_eq!(native_closed.available_permits(), 0);
        resource_release.add_permits(1);
        permit(&native_closed).await;
        while weak.upgrade().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn initialization_is_fenced_before_await_and_late_exports_close_under_original_owner() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let init_started = Arc::new(Semaphore::new(0));
        let init_release = Arc::new(Semaphore::new(0));
        let close_started = Arc::new(Semaphore::new(0));
        let close_release = Arc::new(Semaphore::new(0));
        let mut native = NativeRegistry::default();
        let a = init_started.clone();
        let b = init_release.clone();
        let c = close_started.clone();
        let d = close_release.clone();
        native
            .insert(
                "native.echo".into(),
                Arc::new(move |_, _| {
                    let a = a.clone();
                    let b = b.clone();
                    let c = c.clone();
                    let d = d.clone();
                    Box::pin(async move {
                        a.add_permits(1);
                        permit(&b).await;
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "echo".into(),
                                Published {
                                    contract: contract(MethodMode::Query),
                                    value: Arc::new(Echo {
                                        calls: Arc::new(AtomicUsize::new(0)),
                                    })
                                        as Arc<dyn Handler>,
                                },
                            )])),
                            owner: native_owner(move || {
                                let c = c.clone();
                                let d = d.clone();
                                Box::pin(async move {
                                    c.add_permits(1);
                                    permit(&d).await;
                                    Ok(())
                                })
                            }),
                        }
                    })
                }),
            )
            .unwrap();
        let provider = native_package();
        let consumer = consumer();
        let issuer = Issuer::default();
        let app = Application::start(
            input(&provider, &consumer),
            vec![provider, consumer],
            native,
            issuer.clone(),
            Arc::new(Grant(issuer)),
            Some(maka_host_js::factory(Limits::default())),
        )
        .unwrap();
        permit(&init_started).await;
        let client = app.client();
        let activation = client.activation(&id(1)).unwrap();
        let status = client
            .snapshot()
            .instances
            .into_iter()
            .find(|s| s.activation == activation)
            .unwrap();
        assert_eq!(status.phase, Phase::Loading);
        assert_eq!(status.resources, 1);
        client.retire(activation.clone()).await.unwrap();
        assert_eq!(close_started.available_permits(), 0);
        init_release.add_permits(1);
        permit(&close_started).await;
        let status = client
            .snapshot()
            .instances
            .into_iter()
            .find(|s| s.activation == activation)
            .unwrap();
        assert_eq!(status.phase, Phase::Retiring);
        assert_eq!(status.resources, 1);
        let shutdown = app.shutdown();
        tokio::pin!(shutdown);
        assert!(futures_util::poll!(&mut shutdown).is_pending());
        close_release.add_permits(1);
        shutdown.await.unwrap();
        assert!(client.snapshot().closed);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn cleanup_failure_or_executor_panic_keeps_work_and_owner_after_every_client_leaves() {
    tokio::time::timeout(Duration::from_secs(15), async {
        for value in ["resource-fail", "panic"] {
            let calls = Arc::new(AtomicUsize::new(0));
            let query = Arc::new(Echo { calls });
            let weak = Arc::downgrade(&query);
            let provider = native_package();
            let consumer = consumer();
            let issuer = Issuer::default();
            let app = Application::start(
                input(&provider, &consumer),
                vec![provider, consumer],
                registry(query),
                issuer.clone(),
                Arc::new(Grant(issuer.clone())),
                Some(maka_host_js::factory(Limits::default())),
            )
            .unwrap();
            app.ready().await.unwrap();
            let client = app.client();
            let binding = client
                .bind(client.activation(&id(2)).unwrap(), "echo".into())
                .await
                .unwrap()
                .remove(0);
            let result = client
                .start(
                    binding,
                    "echo".into(),
                    json!(value),
                    scope(&issuer, true),
                    Attachments::new().into(),
                )
                .await
                .unwrap()
                .result()
                .await;
            if value == "resource-fail" {
                assert_eq!(result.unwrap(), json!(value));
            } else {
                assert!(result.is_err());
            }
            assert!(app.shutdown().await.is_err());
            let status = client
                .snapshot()
                .instances
                .into_iter()
                .find(|s| s.activation.instance() == &id(1))
                .unwrap();
            assert_eq!(status.phase, Phase::Retiring);
            assert_eq!(status.calls, 1);
            assert!(!status.failures.is_empty());
            drop(app);
            drop(client);
            tokio::task::yield_now().await;
            assert!(weak.upgrade().is_some());
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn undeclared_exports_fail_startup_and_unsupported_modes_never_activate() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let consumer = consumer();
        let issuer = Issuer::default();
        let provider = package(
            "bad",
            entry(
                true,
                Implementation::JavaScript {
                    module: "host.mjs".into(),
                    realm: Realm::Shared,
                },
                MethodMode::Query,
            ),
            Some("export function activate() { return {}; }".into()),
        );
        let app = Application::start(
            input(&provider, &consumer),
            vec![provider, consumer],
            NativeRegistry::default(),
            issuer.clone(),
            Arc::new(Grant(issuer)),
            Some(maka_host_js::factory(Limits::default())),
        )
        .unwrap();
        assert!(
            app.ready()
                .await
                .unwrap_err()
                .contains("missing required export")
        );
        app.shutdown().await.unwrap();
        let mut complete = attached_entry(
            true,
            Implementation::JavaScript {
                module: "host.mjs".into(),
                realm: Realm::Shared,
            },
        );
        let Interface::Service { methods } =
            &mut complete.exports.get_mut("echo").unwrap().contract.interface
        else {
            unreachable!()
        };
        methods.get_mut("echo").unwrap().resources = (0..17)
            .map(|i| {
                (
                    format!("slot{i}"),
                    ResourceType {
                        name: "example.Bytes".into(),
                        version: 1,
                    }
                    .required(),
                )
            })
            .collect();
        let mut consumer_entry = attached_entry(
            false,
            Implementation::JavaScript {
                module: "host.mjs".into(),
                realm: Realm::Shared,
            },
        );
        consumer_entry.imports.get_mut("echo").unwrap().contract =
            complete.exports["echo"].contract.clone();
        let consumer = package(
            "consumer.complete-attachments",
            consumer_entry,
            Some("export function activate() { return {}; }".into()),
        );
        let source = format!(r#"
            let calls=0;
            export const service={{async echo(input,observation,context){{
                calls++;
                for(let i=0;i<17;i++){{
                    const bytes=await context.invoke({{operation:'read',slot:'slot'+i,start:0,end:3}});
                    if(bytes.length!==3 || bytes[0]!==i || bytes[1]!==255 || bytes[2]!==0) throw Error('original slot bytes changed');
                }}
                return 'verified:'+input+':'+calls;
            }}}};
            export function activate(){{return {{echo:{{contract:{},service:['service']}}}};}}
        "#, serde_json::to_string(&complete.exports["echo"].contract).unwrap());
        let provider = package("complete.attachments", complete, Some(source));
        let issuer = Issuer::default();
        let app = Application::start(
            input(&provider, &consumer), vec![provider, consumer], NativeRegistry::default(),
            issuer.clone(), Arc::new(Grant(issuer.clone())), Some(maka_host_js::factory(Limits::default())),
        ).unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let binding = client.bind(client.activation(&id(2)).unwrap(), "echo".into()).await.unwrap().remove(0);
        let mut retained = Vec::new();
        let attachments: Attachments = (0..17).map(|i| {
            let resource = Arc::new(Bytes { data: vec![i as u8,255,0], version:1 });
            retained.push(Arc::downgrade(&resource));
            (format!("slot{i}"), resource as Arc<dyn ReadResource>)
        }).collect();
        let scope = scope(&issuer, true);
        let completion = client.start(binding, "echo".into(), json!("original"), scope.clone(), attachments.into()).await.unwrap().completion().await;
        completion.cleanup.unwrap();
        assert_eq!(completion.result.unwrap(), json!("verified:original:1"));
        scope.finish().await.unwrap();
        assert!(scope.resources.is_idle());
        assert!(retained.iter().all(|resource| resource.upgrade().is_none()));
        app.shutdown().await.unwrap();
        {
            let mode = MethodMode::Mutation;
            let provider = package(
                "unsupported",
                entry(
                    true,
                    Implementation::Native {
                        implementation: "native.echo".into(),
                    },
                    mode,
                ),
                None,
            );
            let consumer = package(
                "consumer",
                entry(
                    false,
                    Implementation::Native {
                        implementation: "consumer".into(),
                    },
                    mode,
                ),
                None,
            );
            let issuer = Issuer::default();
            let calls = Arc::new(AtomicUsize::new(0));
            assert!(
                Application::start(
                    input(&provider, &consumer),
                    vec![provider, consumer],
                    registry(Arc::new(Echo {
                        calls: calls.clone()
                    })),
                    issuer.clone(),
                    Arc::new(Grant(issuer)),
                    Some(maka_host_js::factory(Limits::default()))
                )
                .is_err()
            );
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn rejected_exports_and_failed_close_preserve_actual_native_owner() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let lifetime = Arc::new(std::sync::Mutex::new(std::sync::Weak::<()>::new()));
        let observed = lifetime.clone();
        let mut native = NativeRegistry::default();
        native
            .insert(
                "native.echo".into(),
                Arc::new(move |_, _| {
                    let observed = observed.clone();
                    Box::pin(async move {
                        let resource = Arc::new(());
                        *observed.lock().unwrap() = Arc::downgrade(&resource);
                        NativeActivation {
                            exports: Err("native exports failed".into()),
                            owner: native_owner(move || {
                                let resource = resource.clone();
                                Box::pin(async move {
                                    std::hint::black_box(&resource);
                                    Err("native close unconfirmed".into())
                                })
                            }),
                        }
                    })
                }),
            )
            .unwrap();
        let provider = native_package();
        let consumer = consumer();
        let issuer = Issuer::default();
        let app = Application::start(
            input(&provider, &consumer),
            vec![provider, consumer],
            native,
            issuer.clone(),
            Arc::new(Grant(issuer)),
            Some(maka_host_js::factory(Limits::default())),
        )
        .unwrap();
        assert!(app.ready().await.is_err());
        assert!(app.shutdown().await.unwrap_err().contains("native close"));
        let client = app.client();
        let status = client
            .snapshot()
            .instances
            .into_iter()
            .find(|s| s.activation.instance() == &id(1))
            .unwrap();
        assert_eq!(status.resources, 1);
        assert_eq!(status.phase, Phase::Retiring);
        drop(app);
        drop(client);
        tokio::task::yield_now().await;
        assert!(lifetime.lock().unwrap().upgrade().is_some());
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn shared_vm_failure_revokes_its_actual_registrations_but_preserves_unrelated_domains() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let source = format!(
            r#"export const service={{async echo(input){{
            if(input==='throw') throw Error('ordinary query error');
            if(input==='stall') while(true){{}};
            return input;
        }}}}; export function activate(){{return {{echo:{{contract:{},service:['service']}}}};}}"#,
            serde_json::to_string(&contract(MethodMode::Query)).unwrap()
        );
        let provider = package(
            "shared",
            entry(
                true,
                Implementation::JavaScript {
                    module: "host.mjs".into(),
                    realm: Realm::Shared,
                },
                MethodMode::Query,
            ),
            Some(source),
        );
        let consumer = consumer();
        let native = native_package();
        let separate = package(
            "isolated",
            entry(
                false,
                Implementation::JavaScript {
                    module: "host.mjs".into(),
                    realm: Realm::Dedicated,
                },
                MethodMode::Query,
            ),
            Some("export function activate(){return {}; }".into()),
        );
        let mut composition = input(&provider, &consumer);
        composition
            .instances
            .insert("other".into(), node(&provider, 4, true));
        composition
            .instances
            .get_mut("b")
            .unwrap()
            .bindings
            .get_mut("echo")
            .unwrap()[0] = Target::Instance {
            path: vec!["other".into()],
            export: "echo".into(),
        };
        composition
            .instances
            .insert("native".into(), node(&native, 6, true));
        let mut separate_node = node(&separate, 7, false);
        separate_node.bindings.get_mut("echo").unwrap()[0] = Target::Instance {
            path: vec!["native".into()],
            export: "echo".into(),
        };
        composition.instances.insert("c".into(), separate_node);
        let issuer = Issuer::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let app = Application::start(
            composition,
            vec![provider, consumer, native, separate],
            registry(Arc::new(Echo { calls })),
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            Some(maka_host_js::factory(Limits {
                synchronous_slice: Duration::from_millis(200),
                ..Limits::default()
            })),
        )
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let a = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let b = client
            .bind(client.activation(&id(3)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let c = client
            .bind(client.activation(&id(7)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        assert!(
            client
                .start(
                    a.clone(),
                    "echo".into(),
                    json!("throw"),
                    scope(&issuer, true),
                    Attachments::new().into()
                )
                .await
                .unwrap()
                .result()
                .await
                .is_err()
        );
        assert_eq!(
            client
                .start(
                    b.clone(),
                    "echo".into(),
                    json!("still-live"),
                    scope(&issuer, true),
                    Attachments::new().into()
                )
                .await
                .unwrap()
                .result()
                .await
                .unwrap(),
            json!("still-live")
        );
        assert!(
            client
                .start(
                    a,
                    "echo".into(),
                    json!("stall"),
                    scope(&issuer, true),
                    Attachments::new().into()
                )
                .await
                .unwrap()
                .result()
                .await
                .is_err()
        );
        assert!(
            client
                .start(
                    b,
                    "echo".into(),
                    json!("retired-domain"),
                    scope(&issuer, true),
                    Attachments::new().into()
                )
                .await
                .is_err()
        );
        assert_eq!(
            client
                .start(
                    c,
                    "echo".into(),
                    json!("unrelated"),
                    scope(&issuer, true),
                    Attachments::new().into()
                )
                .await
                .unwrap()
                .result()
                .await
                .unwrap(),
            json!("unrelated")
        );
        app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

struct Forward;
impl Handler for Forward {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value>> {
        let result = context.call("echo", 0, method, input, context.attachments().clone());
        Box::pin(async move { result?.await })
    }
}
struct ForwardPolicy(Issuer);
impl Policy for ForwardPolicy {
    fn admit(&self, invocation: Invocation<'_>) -> Result<()> {
        if invocation.provider.instance() == &id(4)
            || self.0.evidence::<bool>(invocation.scope) == Some(&true)
        {
            Ok(())
        } else {
            Err("leaf effect grant denied".into())
        }
    }
}
#[tokio::test]
async fn forwarding_preserves_private_evidence_and_never_substitutes_wrapper_authority() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let (provider, consumer) = attached_packages();
        let mut wrapper_entry = attached_entry(
            true,
            Implementation::Native {
                implementation: "native.wrapper".into(),
            },
        );
        wrapper_entry.imports = attached_entry(
            false,
            Implementation::Native {
                implementation: "unused".into(),
            },
        )
        .imports;
        let wrapper = package("wrapper", wrapper_entry, None);
        let mut composition = input(&provider, &consumer);
        composition
            .instances
            .insert("wrapper".into(), node(&wrapper, 4, false));
        composition
            .instances
            .get_mut("a")
            .unwrap()
            .bindings
            .get_mut("echo")
            .unwrap()[0] = Target::Instance {
            path: vec!["wrapper".into()],
            export: "echo".into(),
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let mut native = registry_contract(
            Arc::new(ReadAttachment {
                calls: calls.clone(),
                started: Arc::new(Semaphore::new(0)),
                release: Arc::new(Semaphore::new(0)),
            }),
            attached_contract(),
        );
        let forward = Arc::new(Forward);
        let implementation = forward.clone();
        native
            .insert(
                "native.wrapper".into(),
                Arc::new(move |_, _| {
                    let implementation: Arc<dyn Handler> = implementation.clone();
                    Box::pin(async move {
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "echo".into(),
                                Published {
                                    contract: attached_contract(),
                                    value: implementation,
                                },
                            )])),
                            owner: native_owner(|| Box::pin(async { Ok(()) })),
                        }
                    })
                }),
            )
            .unwrap();
        let issuer = Issuer::default();
        let app = Application::start(
            composition,
            vec![provider, consumer, wrapper],
            native,
            issuer.clone(),
            Arc::new(ForwardPolicy(issuer.clone())),
            Some(maka_host_js::factory(Limits::default())),
        )
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let denied = client
            .start(
                binding.clone(),
                "echo".into(),
                json!("narrow"),
                scope(&issuer, false),
                bytes(5).0.into(),
            )
            .await
            .unwrap()
            .result()
            .await
            .unwrap_err();
        assert!(denied.contains("leaf effect grant denied"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            client
                .start(
                    binding,
                    "echo".into(),
                    json!("allowed"),
                    scope(&issuer, true),
                    bytes(5).0.into()
                )
                .await
                .unwrap()
                .result()
                .await
                .unwrap(),
            json!("xxxxx")
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
struct InputResource(Arc<Semaphore>);
impl Handler for InputResource {
    fn call(&self, _: String, input: Value, context: Context) -> BoxFuture<'static, Result<Value>> {
        let scope = context.scope().clone();
        let release = self.0.clone();
        Box::pin(async move {
            let mut ticket = scope.resources.reserve().unwrap();
            ticket.start();
            tokio::spawn(async move {
                permit(&release).await;
                std::hint::black_box(input);
                ticket.complete(Ok(()));
            });
            Ok(json!("resource running"))
        })
    }
}
struct LargeHeld {
    started: Arc<Semaphore>,
    release: Arc<Semaphore>,
}
impl Handler for LargeHeld {
    fn call(&self, _: String, input: Value, _: Context) -> BoxFuture<'static, Result<Value>> {
        let started = self.started.clone();
        let release = self.release.clone();
        Box::pin(async move {
            started.add_permits(1);
            permit(&release).await;
            std::hint::black_box(input);
            Ok(json!("done"))
        })
    }
}
#[tokio::test]
async fn resource_timeout_keeps_input_quota_until_actual_cleanup_is_confirmed() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let provider = native_package();
        let consumer = consumer();
        let healthy = package(
            "healthy",
            entry(
                true,
                Implementation::Native {
                    implementation: "native.held".into(),
                },
                MethodMode::Query,
            ),
            None,
        );
        let mut composition = input(&provider, &consumer);
        composition
            .instances
            .insert("healthy".into(), node(&healthy, 4, true));
        composition
            .instances
            .get_mut("b")
            .unwrap()
            .bindings
            .get_mut("echo")
            .unwrap()[0] = Target::Instance {
            path: vec!["healthy".into()],
            export: "echo".into(),
        };
        let resource_release = Arc::new(Semaphore::new(0));
        let started = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let mut native = registry(Arc::new(InputResource(resource_release.clone())));
        let implementation = Arc::new(LargeHeld {
            started: started.clone(),
            release: release.clone(),
        });
        native
            .insert(
                "native.held".into(),
                Arc::new(move |_, _| {
                    let implementation: Arc<dyn Handler> = implementation.clone();
                    Box::pin(async move {
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "echo".into(),
                                Published {
                                    contract: contract(MethodMode::Query),
                                    value: implementation,
                                },
                            )])),
                            owner: native_owner(|| Box::pin(async { Ok(()) })),
                        }
                    })
                }),
            )
            .unwrap();
        let issuer = Issuer::default();
        let app = Application::start(
            composition,
            vec![provider, consumer, healthy],
            native,
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            Some(maka_host_js::factory(Limits::default())),
        )
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let failed = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let healthy = client
            .bind(client.activation(&id(3)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let large = json!("x".repeat(1024 * 1024 - 2));
        assert_eq!(
            client
                .start(
                    failed,
                    "echo".into(),
                    large.clone(),
                    scope(&issuer, true),
                    Attachments::new().into()
                )
                .await
                .unwrap()
                .result()
                .await
                .unwrap(),
            json!("resource running")
        );
        assert!(
            client
                .snapshot()
                .cleanup_error
                .unwrap()
                .contains("did not settle")
        );
        let mut accepted = Vec::new();
        for _ in 0..31 {
            accepted.push(
                client
                    .start(
                        healthy.clone(),
                        "echo".into(),
                        large.clone(),
                        scope(&issuer, true),
                        Attachments::new().into(),
                    )
                    .await
                    .unwrap(),
            );
        }
        for _ in 0..31 {
            permit(&started).await;
        }
        assert!(
            client
                .start(
                    healthy,
                    "echo".into(),
                    large,
                    scope(&issuer, true),
                    Attachments::new().into()
                )
                .await
                .err()
                .unwrap()
                .contains("input budget")
        );
        resource_release.add_permits(1);
        release.add_permits(31);
        for observer in accepted {
            assert_eq!(observer.result().await.unwrap(), json!("done"));
        }
        assert!(app.shutdown().await.is_err()); // Timeout remains fenced until explicit recovery.
    })
    .await
    .unwrap();
}

fn attached_contract() -> Contract {
    let mut contract = contract(MethodMode::Query);
    let Interface::Service { methods } = &mut contract.interface else {
        unreachable!()
    };
    methods.get_mut("echo").unwrap().resources = BTreeMap::from([(
        "text".into(),
        ResourceType {
            name: "example.Bytes".into(),
            version: 1,
        }
        .required(),
    )]);
    contract
}
fn attached_entry(provider: bool, implementation: Implementation) -> EntryDeclaration {
    let mut declaration = entry(provider, implementation, MethodMode::Query);
    if provider {
        declaration.exports.get_mut("echo").unwrap().contract = attached_contract();
    } else {
        declaration.imports.get_mut("echo").unwrap().contract = attached_contract();
    }
    declaration
}
fn attached_packages() -> (Package, Package) {
    (
        package(
            "attached.provider",
            attached_entry(
                true,
                Implementation::Native {
                    implementation: "native.echo".into(),
                },
            ),
            None,
        ),
        package(
            "attached.consumer",
            attached_entry(
                false,
                Implementation::JavaScript {
                    module: "host.mjs".into(),
                    realm: Realm::Shared,
                },
            ),
            Some("export function activate() { return {}; }".into()),
        ),
    )
}
struct Bytes {
    data: Vec<u8>,
    version: u32,
}
impl ReadResource for Bytes {
    fn resource_type(&self) -> ResourceType {
        ResourceType {
            name: "example.Bytes".into(),
            version: self.version,
        }
    }
    fn bytes(&self) -> usize {
        self.data.len()
    }
    fn metadata(&self) -> Value {
        json!({"bytes":self.data.len()})
    }
    fn read(&self, range: std::ops::Range<usize>) -> Result<Vec<u8>> {
        if range
            .end
            .checked_sub(range.start)
            .is_none_or(|n| n > 64 * 1024)
        {
            return Err("chunk exceeds 64 KiB".into());
        }
        self.data
            .get(range)
            .map(|r| r.to_vec())
            .ok_or("invalid byte range".into())
    }
}
fn bytes(size: usize) -> (Attachments, std::sync::Weak<Bytes>) {
    let value = Arc::new(Bytes {
        data: vec![b'x'; size],
        version: 1,
    });
    let weak = Arc::downgrade(&value);
    (
        BTreeMap::from([("text".into(), value as Arc<dyn ReadResource>)]),
        weak,
    )
}
struct ReadAttachment {
    calls: Arc<AtomicUsize>,
    started: Arc<Semaphore>,
    release: Arc<Semaphore>,
}
impl Handler for ReadAttachment {
    fn call(&self, _: String, input: Value, context: Context) -> BoxFuture<'static, Result<Value>> {
        let scope = context.scope().clone();
        let attachments = context.attachments().clone();
        let calls = self.calls.clone();
        let started = self.started.clone();
        let release = self.release.clone();
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            if input == "held" {
                started.add_permits(1);
                permit(&release).await;
            }
            if input == "fail-cleanup" || input == "fail-cleanup-error" {
                let mut ticket = scope.resources.reserve().unwrap();
                ticket.start();
                ticket.complete(Err("attachment cleanup unconfirmed".into()));
            }
            if input == "business-fail" || input == "fail-cleanup-error" {
                return Err("ordinary leaf business error".into());
            }
            Ok(json!(
                String::from_utf8(attachments["text"].read(0..5)?).unwrap()
            ))
        })
    }
}
struct BadDescriptor {
    before_enqueue: bool,
    type_reads: AtomicUsize,
}
impl BadDescriptor {
    fn new(before_enqueue: bool) -> Self {
        Self {
            before_enqueue,
            type_reads: AtomicUsize::new(0),
        }
    }
}
impl ReadResource for BadDescriptor {
    fn resource_type(&self) -> ResourceType {
        assert!(
            self.before_enqueue || self.type_reads.fetch_add(1, Ordering::SeqCst) == 0,
            "type descriptor panicked during final admission"
        );
        ResourceType {
            name: "example.Bytes".into(),
            version: 1,
        }
    }
    fn bytes(&self) -> usize {
        5
    }
    fn metadata(&self) -> Value {
        assert!(
            !self.before_enqueue,
            "metadata descriptor panicked before enqueue"
        );
        Value::Null
    }
    fn read(&self, _: std::ops::Range<usize>) -> Result<Vec<u8>> {
        panic!("invalid payload must not be read")
    }
}
#[tokio::test]
async fn attachment_validation_and_descriptor_panics_do_not_cancel_other_accepted_work() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let (provider, consumer) = attached_packages();
        let issuer = Issuer::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let app = Application::start(
            input(&provider, &consumer),
            vec![provider, consumer],
            registry_contract(
                Arc::new(ReadAttachment {
                    calls: calls.clone(),
                    started: started.clone(),
                    release: release.clone(),
                }),
                attached_contract(),
            ),
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            Some(maka_host_js::factory(Limits::default())),
        )
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let (attachments, held) = bytes(5);
        let observer = client
            .start(
                binding.clone(),
                "echo".into(),
                json!("held"),
                scope(&issuer, true),
                attachments.into(),
            )
            .await
            .unwrap();
        permit(&started).await;
        // JSON observation contains no actual payload, even with the correct slot.
        assert!(
            client
                .start(
                    binding.clone(),
                    "echo".into(),
                    json!("text:{bytes:5}"),
                    scope(&issuer, true),
                    Attachments::new().into()
                )
                .await
                .err()
                .unwrap()
                .contains("slots or types")
        );
        let (mut extra, _) = bytes(5);
        extra.insert("extra".into(), extra["text"].clone());
        assert!(
            client
                .start(
                    binding.clone(),
                    "echo".into(),
                    json!("extra"),
                    scope(&issuer, true),
                    extra.into()
                )
                .await
                .is_err()
        );
        let wrong = Attachments::from([(
            "text".into(),
            Arc::new(Bytes {
                data: vec![b'x'; 5],
                version: 2,
            }) as Arc<dyn ReadResource>,
        )]);
        assert!(
            client
                .start(
                    binding.clone(),
                    "echo".into(),
                    json!("wrong-type"),
                    scope(&issuer, true),
                    wrong.into()
                )
                .await
                .err()
                .unwrap()
                .contains("slots or types")
        );
        for before_enqueue in [true, false] {
            let bad = Attachments::from([(
                "text".into(),
                Arc::new(BadDescriptor::new(before_enqueue)) as Arc<dyn ReadResource>,
            )]);
            assert!(
                client
                    .start(
                        binding.clone(),
                        "echo".into(),
                        json!("panic-descriptor"),
                        scope(&issuer, true),
                        bad.into()
                    )
                    .await
                    .err()
                    .unwrap()
                    .contains("panicked")
            );
            assert_eq!(
                client
                    .snapshot()
                    .instances
                    .iter()
                    .find(|s| s.activation.instance() == &id(1))
                    .unwrap()
                    .calls,
                1
            );
            assert!(held.upgrade().is_some());
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }
        let (attachments, denied) = bytes(5);
        assert!(
            client
                .start(
                    binding.clone(),
                    "echo".into(),
                    json!("denied"),
                    scope(&issuer, false),
                    attachments.into()
                )
                .await
                .is_err()
        );
        assert!(denied.upgrade().is_none());
        release.add_permits(1);
        assert_eq!(observer.result().await.unwrap(), json!("xxxxx"));
        assert!(held.upgrade().is_none());
        let (attachments, done) = bytes(5);
        assert_eq!(
            client
                .start(
                    binding,
                    "echo".into(),
                    json!("healthy"),
                    scope(&issuer, true),
                    attachments.into()
                )
                .await
                .unwrap()
                .result()
                .await
                .unwrap(),
            json!("xxxxx")
        );
        assert!(done.upgrade().is_none());
        app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn failed_cleanup_retains_actual_attachments_and_the_shared_64_mib_capacity() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let (provider, consumer) = attached_packages();
        let healthy = package(
            "attached.healthy",
            attached_entry(
                true,
                Implementation::Native {
                    implementation: "native.healthy".into(),
                },
            ),
            None,
        );
        let mut composition = input(&provider, &consumer);
        composition
            .instances
            .insert("healthy".into(), node(&healthy, 4, true));
        composition
            .instances
            .get_mut("b")
            .unwrap()
            .bindings
            .get_mut("echo")
            .unwrap()[0] = Target::Instance {
            path: vec!["healthy".into()],
            export: "echo".into(),
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let query: Arc<dyn Handler> = Arc::new(ReadAttachment {
            calls: calls.clone(),
            started: started.clone(),
            release: release.clone(),
        });
        let mut native = registry_contract(query.clone(), attached_contract());
        native
            .insert(
                "native.healthy".into(),
                Arc::new(move |_, _| {
                    let query = query.clone();
                    Box::pin(async move {
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                "echo".into(),
                                Published {
                                    contract: attached_contract(),
                                    value: query,
                                },
                            )])),
                            owner: native_owner(|| Box::pin(async { Ok(()) })),
                        }
                    })
                }),
            )
            .unwrap();
        let issuer = Issuer::default();
        let app = Application::start(
            composition,
            vec![provider, consumer, healthy],
            native,
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            Some(maka_host_js::factory(Limits::default())),
        )
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let failed = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let healthy = client
            .bind(client.activation(&id(3)).unwrap(), "echo".into())
            .await
            .unwrap()
            .remove(0);
        let (attachments, retained) = bytes(1024 * 1024);
        assert_eq!(
            client
                .start(
                    failed,
                    "echo".into(),
                    json!("fail-cleanup"),
                    scope(&issuer, true),
                    attachments.into()
                )
                .await
                .unwrap()
                .result()
                .await
                .unwrap(),
            json!("xxxxx")
        );
        assert!(retained.upgrade().is_some());
        assert!(
            client
                .snapshot()
                .cleanup_error
                .unwrap()
                .contains("unconfirmed")
        );
        let (attachments, large) = bytes(63 * 1024 * 1024);
        let observer = client
            .start(
                healthy.clone(),
                "echo".into(),
                json!("held"),
                scope(&issuer, true),
                attachments.into(),
            )
            .await
            .unwrap();
        permit(&started).await;
        let (attachments, rejected) = bytes(5);
        assert!(
            client
                .start(
                    healthy,
                    "echo".into(),
                    json!("over-quota"),
                    scope(&issuer, true),
                    attachments.into()
                )
                .await
                .err()
                .unwrap()
                .contains("attachment budget")
        );
        assert!(rejected.upgrade().is_none());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        drop(observer);
        drop(app);
        drop(client);
        assert!(retained.upgrade().is_some());
        assert!(large.upgrade().is_some());
        release.add_permits(1);
        // A successful query releases the actual payload even after all observers
        // and roots exit; the unrelated failed record remains independently owned.
        while large.upgrade().is_some() {
            tokio::task::yield_now().await;
        }
        assert!(large.upgrade().is_none());
        assert!(retained.upgrade().is_some());
    })
    .await
    .unwrap();
}

fn attached_script() -> Package {
    let source = format!(
        r#"
        let saved;
        export const service = {{ async echo(input, observation, context) {{
            if (typeof Deno!=='undefined' || typeof fetch!=='undefined') throw Error('ambient Host access');
            if (input==='stale') {{
                try {{ await saved.invoke({{operation:'read',slot:'text',start:0,end:5}}); return 'unexpected stale read'; }}
                catch(e) {{ return e.message.includes('expired')?'expired':e.message; }}
            }}
            saved=context;
            if (input==='invalid') {{
                for (const request of [
                    {{operation:'read',slot:'other',start:0,end:1}},
                    {{operation:'read',slot:'text',start:5,end:1}},
                    {{operation:'read',slot:'text',start:0,end:65537}},
                    {{operation:'read',slot:'text',start:0,end:6}},
                    {{operation:'read',slot:'text',start:0,end:1,extra:true}},
                    {{operation:'call',binding:'echo',input:'forged'}},
                ]) {{
                    try {{ await context.invoke(request); return 'unexpected acceptance'; }} catch {{}}
                }}
                return 'rejected';
            }}
            if (input==='panic') {{
                try {{ await context.invoke({{operation:'read',slot:'text',start:0,end:5}}); return 'unexpected read'; }}
                catch {{ return 'caught'; }}
            }}
            const metadata = await context.invoke({{operation:'metadata',slot:'text'}});
            if (metadata.type.name!=='example.Bytes' || metadata.type.version!==1) throw Error('incorrect type');
            const bytes = await context.invoke({{operation:'read',slot:'text',start:0,end:5}});
            return new TextDecoder().decode(new Uint8Array(bytes));
        }} }};
        export function activate() {{ return {{echo:{{contract:{},service:['service']}}}}; }}
    "#,
        serde_json::to_string(&attached_contract()).unwrap()
    );
    package(
        "script.attached",
        attached_entry(
            true,
            Implementation::JavaScript {
                module: "host.mjs".into(),
                realm: Realm::Shared,
            },
        ),
        Some(source),
    )
}
#[tokio::test]
async fn javascript_resource_contexts_use_actual_slots_and_release_saved_snapshots() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let provider = attached_script();
        let (_, consumer) = attached_packages();
        let issuer = Issuer::default();
        let app = Application::start(
            input(&provider, &consumer),
            vec![provider, consumer],
            NativeRegistry::default(),
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            Some(maka_host_js::factory(Limits::default())),
        )
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .pop()
            .unwrap();
        let (first, first_weak) = bytes(5);
        let second = Arc::new(Bytes {
            data: vec![b'y'; 5],
            version: 1,
        });
        let second_weak = Arc::downgrade(&second);
        let one = client
            .start(
                binding.clone(),
                "echo".into(),
                json!("read"),
                scope(&issuer, true),
                first.into(),
            )
            .await
            .unwrap();
        let two = client
            .start(
                binding.clone(),
                "echo".into(),
                json!("read"),
                scope(&issuer, true),
                BTreeMap::from([("text".into(), second as Arc<dyn ReadResource>)]).into(),
            )
            .await
            .unwrap();
        let (one, two) = tokio::join!(one.result(), two.result());
        assert_eq!(one.unwrap(), json!("xxxxx"));
        assert_eq!(two.unwrap(), json!("yyyyy"));
        // An owner command acknowledges the preceding completion turn.
        client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap();
        assert!(first_weak.upgrade().is_none());
        assert!(
            second_weak.upgrade().is_none(),
            "saved context cannot hold the immutable snapshot"
        );
        for (mode, expected) in [("stale", "expired"), ("invalid", "rejected")] {
            let (attachments, weak) = bytes(5);
            assert_eq!(
                client
                    .start(
                        binding.clone(),
                        "echo".into(),
                        json!(mode),
                        scope(&issuer, true),
                        attachments.into()
                    )
                    .await
                    .unwrap()
                    .result()
                    .await
                    .unwrap(),
                json!(expected)
            );
            client
                .bind(client.activation(&id(2)).unwrap(), "echo".into())
                .await
                .unwrap();
            assert!(weak.upgrade().is_none());
        }
        app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
struct PanicRead(Vec<u8>);
impl ReadResource for PanicRead {
    fn resource_type(&self) -> ResourceType {
        ResourceType {
            name: "example.Bytes".into(),
            version: 1,
        }
    }
    fn bytes(&self) -> usize {
        self.0.len()
    }
    fn metadata(&self) -> Value {
        Value::Null
    }
    fn read(&self, _: std::ops::Range<usize>) -> Result<Vec<u8>> {
        panic!("native read lost its actual executor");
    }
}
#[tokio::test]
async fn javascript_cannot_catch_away_native_resource_cleanup_failure_or_release_capacity() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let provider = attached_script();
        let (_, consumer) = attached_packages();
        let mut composition = input(&provider, &consumer);
        composition
            .instances
            .insert("healthy".into(), node(&provider, 4, true));
        composition.instances.get_mut("b").unwrap().bindings.insert(
            "echo".into(),
            vec![Target::Instance {
                path: vec!["healthy".into()],
                export: "echo".into(),
            }],
        );
        let issuer = Issuer::default();
        let app = Application::start(
            composition,
            vec![provider, consumer],
            NativeRegistry::default(),
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            Some(maka_host_js::factory(Limits::default())),
        )
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let failing = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .pop()
            .unwrap();
        let healthy = client
            .bind(client.activation(&id(3)).unwrap(), "echo".into())
            .await
            .unwrap()
            .pop()
            .unwrap();
        let payload = Arc::new(PanicRead(vec![0; 1024 * 1024]));
        let weak = Arc::downgrade(&payload);
        let result = client
            .start(
                failing,
                "echo".into(),
                json!("panic"),
                scope(&issuer, true),
                BTreeMap::from([("text".into(), payload as Arc<dyn ReadResource>)]).into(),
            )
            .await
            .unwrap()
            .result()
            .await
            .unwrap();
        assert_eq!(
            result,
            json!("caught"),
            "JS may catch the business observation"
        );
        client
            .bind(client.activation(&id(3)).unwrap(), "echo".into())
            .await
            .unwrap();
        assert!(
            weak.upgrade().is_some(),
            "actual cleanup failure stays fenced"
        );
        assert!(
            client
                .snapshot()
                .cleanup_error
                .as_deref()
                .unwrap()
                .contains("cleanup unconfirmed")
        );
        let (full, full_weak) = bytes(64 * 1024 * 1024);
        assert!(
            client
                .start(
                    healthy.clone(),
                    "echo".into(),
                    json!("read"),
                    scope(&issuer, true),
                    full.into()
                )
                .await
                .err()
                .unwrap()
                .contains("attachment budget")
        );
        assert!(full_weak.upgrade().is_none());
        let (small, small_weak) = bytes(5);
        assert_eq!(
            client
                .start(
                    healthy,
                    "echo".into(),
                    json!("read"),
                    scope(&issuer, true),
                    small.into()
                )
                .await
                .unwrap()
                .result()
                .await
                .unwrap(),
            json!("xxxxx")
        );
        client
            .bind(client.activation(&id(3)).unwrap(), "echo".into())
            .await
            .unwrap();
        assert!(
            small_weak.upgrade().is_none(),
            "unrelated module in shared worker stays healthy"
        );
        assert!(app.shutdown().await.is_err());
        drop(client);
        assert!(
            weak.upgrade().is_some(),
            "dropping root and observers cannot acknowledge failed work"
        );
    })
    .await
    .unwrap();
}

fn wrapper_entry(implementation: Implementation) -> EntryDeclaration {
    let mut entry = attached_entry(true, implementation.clone());
    entry.imports = attached_entry(false, implementation).imports;
    entry
}
fn wrapper_input(provider: &Package, consumer: &Package, wrapper: &Package) -> Input {
    let mut composition = input(provider, consumer);
    composition
        .instances
        .insert("wrapper".into(), node(wrapper, 4, false));
    composition
        .instances
        .get_mut("a")
        .unwrap()
        .bindings
        .get_mut("echo")
        .unwrap()[0] = Target::Instance {
        path: vec!["wrapper".into()],
        export: "echo".into(),
    };
    composition
}
fn script_forwarder(realm: Realm) -> Package {
    static SOURCE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let source = SOURCE
        .get_or_init(|| {
            let work = tempfile::tempdir().unwrap();
            let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
            let sdk = root.join("packages/plugin-sdk");
            let output = work.path().join("forwarder.mjs");
            let status = std::process::Command::new("node")
                .arg(sdk.join("scripts/bundle.mjs"))
                .arg(root.join("platform/host-js/tests/fixtures/forwarder.ts"))
                .arg(&output)
                .current_dir(&root)
                .status()
                .unwrap();
            assert!(status.success(), "SDK Host bundle failed");
            std::fs::read_to_string(output).unwrap()
        })
        .clone();
    package(
        "script.forwarder",
        wrapper_entry(Implementation::JavaScript {
            module: "host.mjs".into(),
            realm,
        }),
        Some(source),
    )
}
struct RecordedForwardPolicy {
    issuer: Issuer,
    calls: Arc<std::sync::Mutex<Vec<(InstanceId, InstanceId, Identity)>>>,
}
impl Policy for RecordedForwardPolicy {
    fn admit(&self, invocation: Invocation<'_>) -> Result<()> {
        self.calls.lock().unwrap().push((
            invocation.consumer.instance().clone(),
            invocation.provider.instance().clone(),
            invocation.scope.identity.clone(),
        ));
        ForwardPolicy(self.issuer.clone()).admit(invocation)
    }
}
#[tokio::test]
async fn javascript_forwarding_uses_exact_local_imports_original_evidence_and_actual_slots() {
    tokio::time::timeout(Duration::from_secs(15), async {
        // Cover both native and JavaScript leaf execution, including a dedicated
        // wrapper calling a shared leaf through the same root authority.
        for (javascript_leaf, realm) in [
            (false, Realm::Dedicated),
            (true, Realm::Dedicated),
            (true, Realm::Shared),
        ] {
            let (native_provider, consumer) = attached_packages();
            let provider = if javascript_leaf {
                attached_script()
            } else {
                native_provider
            };
            let wrapper = script_forwarder(realm);
            let calls = Arc::new(AtomicUsize::new(0));
            let native = if javascript_leaf {
                NativeRegistry::default()
            } else {
                registry_contract(
                    Arc::new(ReadAttachment {
                        calls: calls.clone(),
                        started: Arc::new(Semaphore::new(0)),
                        release: Arc::new(Semaphore::new(0)),
                    }),
                    attached_contract(),
                )
            };
            let issuer = Issuer::default();
            let admitted = Arc::new(std::sync::Mutex::new(Vec::new()));
            let app = Application::start(
                wrapper_input(&provider, &consumer, &wrapper),
                vec![provider, consumer, wrapper],
                native,
                issuer.clone(),
                Arc::new(RecordedForwardPolicy {
                    issuer: issuer.clone(),
                    calls: admitted.clone(),
                }),
                Some(maka_host_js::factory(Limits::default())),
            )
            .unwrap();
            app.ready().await.unwrap();
            let client = app.client();
            let binding = client
                .bind(client.activation(&id(2)).unwrap(), "echo".into())
                .await
                .unwrap()
                .pop()
                .unwrap();
            let narrow = scope(&issuer, false);
            let identity = narrow.identity.clone();
            let (attachments, weak) = bytes(5);
            let result = client
                .start(
                    binding.clone(),
                    "echo".into(),
                    json!("narrow"),
                    narrow,
                    attachments.into(),
                )
                .await
                .unwrap()
                .result()
                .await
                .unwrap();
            assert!(
                result
                    .as_str()
                    .unwrap()
                    .contains("leaf effect grant denied")
            );
            assert!(weak.upgrade().is_none());
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            assert_eq!(
                admitted.lock().unwrap().as_slice(),
                &[(id(2), id(4), identity.clone()), (id(4), id(1), identity),]
            );
            for (mode, expected) in [("twice", "xxxxx:xxxxx"), ("invalid", "rejected")] {
                let (attachments, weak) = bytes(5);
                assert_eq!(
                    client
                        .start(
                            binding.clone(),
                            "echo".into(),
                            json!(mode),
                            scope(&issuer, true),
                            attachments.into()
                        )
                        .await
                        .unwrap()
                        .result()
                        .await
                        .unwrap(),
                    json!(expected)
                );
                assert!(weak.upgrade().is_none());
                assert!(client.snapshot().cleanup_error.is_none());
            }
            if !javascript_leaf {
                let (attachments, weak) = bytes(5);
                assert_eq!(
                    client
                        .start(
                            binding,
                            "echo".into(),
                            json!("business-fail"),
                            scope(&issuer, true),
                            attachments.into()
                        )
                        .await
                        .unwrap()
                        .result()
                        .await
                        .unwrap(),
                    json!("caught:plugin VM: ordinary leaf business error")
                );
                assert!(weak.upgrade().is_none());
                assert!(client.snapshot().cleanup_error.is_none());
                assert_eq!(calls.load(Ordering::SeqCst), 3);
            }
            app.shutdown().await.unwrap();
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn javascript_catch_cannot_acknowledge_child_cleanup_or_release_parent_and_child_capacity() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let (provider, consumer) = attached_packages();
        let wrapper = script_forwarder(Realm::Dedicated);
        let issuer = Issuer::default();
        let app = Application::start(
            wrapper_input(&provider, &consumer, &wrapper),
            vec![provider, consumer, wrapper],
            registry_contract(
                Arc::new(ReadAttachment {
                    calls: Arc::new(AtomicUsize::new(0)),
                    started: Arc::new(Semaphore::new(0)),
                    release: Arc::new(Semaphore::new(0)),
                }),
                attached_contract(),
            ),
            issuer.clone(),
            Arc::new(ForwardPolicy(issuer.clone())),
            Some(maka_host_js::factory(Limits::default())),
        )
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "echo".into())
            .await
            .unwrap()
            .pop()
            .unwrap();
        let sibling = client
            .bind(client.activation(&id(3)).unwrap(), "echo".into())
            .await
            .unwrap()
            .pop()
            .unwrap();
        let (attachments, weak) = bytes(32 * 1024 * 1024);
        assert_eq!(
            client
                .start(
                    binding,
                    "echo".into(),
                    json!("fail-cleanup-error"),
                    scope(&issuer, true),
                    attachments.into()
                )
                .await
                .unwrap()
                .result()
                .await
                .unwrap(),
            json!("caught:plugin VM: ordinary leaf business error")
        );
        assert!(weak.upgrade().is_some());
        let snapshot = client.snapshot();
        assert!(snapshot.cleanup_error.unwrap().contains("unconfirmed"));
        for instance in [id(1), id(4)] {
            let state = snapshot
                .instances
                .iter()
                .find(|s| s.activation.instance() == &instance)
                .unwrap();
            assert_eq!(
                state.calls, 1,
                "both actual child and parent keep their core work"
            );
            assert_eq!(state.phase, Phase::Retiring);
        }
        // Use a real binding captured before retirement: input preparation runs
        // before final admission, so this proves both actual 32 MiB charges remain.
        let (attachments, rejected) = bytes(5);
        assert!(
            client
                .start(
                    sibling,
                    "echo".into(),
                    json!("healthy"),
                    scope(&issuer, true),
                    attachments.into()
                )
                .await
                .err()
                .unwrap()
                .contains("attachment budget")
        );
        assert!(rejected.upgrade().is_none());
        drop(app);
        drop(client);
        assert!(weak.upgrade().is_some());
    })
    .await
    .unwrap();
}
struct HeldChild {
    started: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<CancellationToken>>>,
    release: Arc<Semaphore>,
    calls: Arc<AtomicUsize>,
}
impl Handler for HeldChild {
    fn call(&self, _: String, input: Value, context: Context) -> BoxFuture<'static, Result<Value>> {
        let started = if input == "held" {
            self.started.lock().unwrap().take()
        } else {
            None
        };
        let release = self.release.clone();
        let calls = self.calls.clone();
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            if let Some(started) = started {
                let _ = started.send(context.scope().cancellation.clone());
                permit(&release).await;
            }
            Ok(json!(
                String::from_utf8(context.attachments()["text"].read(0..5)?).unwrap()
            ))
        })
    }
}
#[tokio::test]
async fn unobserved_accepted_child_keeps_parent_work_until_actual_cleanup_after_root_exit() {
    tokio::time::timeout(Duration::from_secs(15), async {
        for mode in ["ignore", "terminate"] {
            let (provider, consumer) = attached_packages();
            let wrapper = script_forwarder(Realm::Dedicated);
            let issuer = Issuer::default();
            let (started, observed) = tokio::sync::oneshot::channel();
            let release = Arc::new(Semaphore::new(0));
            let calls = Arc::new(AtomicUsize::new(0));
            let app = Application::start(
                wrapper_input(&provider, &consumer, &wrapper),
                vec![provider, consumer, wrapper],
                registry_contract(
                    Arc::new(HeldChild {
                        calls: calls.clone(),
                        started: std::sync::Mutex::new(Some(started)),
                        release: release.clone(),
                    }),
                    attached_contract(),
                ),
                issuer.clone(),
                Arc::new(ForwardPolicy(issuer.clone())),
                Some(maka_host_js::factory(Limits {
                    synchronous_slice: if mode == "terminate" {
                        Duration::from_millis(250)
                    } else {
                        Duration::from_secs(5)
                    },
                    ..Limits::default()
                })),
            )
            .unwrap();
            app.ready().await.unwrap();
            let client = app.client();
            let binding = client
                .bind(client.activation(&id(2)).unwrap(), "echo".into())
                .await
                .unwrap()
                .pop()
                .unwrap();
            let (attachments, weak) = bytes(5);
            let accepted = client
                .start(
                    binding.clone(),
                    "echo".into(),
                    json!(mode),
                    scope(&issuer, true),
                    attachments.into(),
                )
                .await
                .unwrap();
            let child_cancellation = observed.await.unwrap();
            // The child remains held. Its inherited revocation therefore proves the
            // JS parent returned or actually hit the VM watchdog and entered cleanup,
            // before the deployment exits.
            child_cancellation.cancelled().await;
            if mode == "terminate" {
                // Distinguish actual domain termination from an ordinary guest
                // throw: use this exact old binding at final owner admission.
                let error = client
                    .start(
                        binding,
                        "echo".into(),
                        json!("late"),
                        scope(&issuer, true),
                        bytes(5).0.into(),
                    )
                    .await
                    .err()
                    .unwrap();
                assert!(error.contains("execution domain terminated"), "{error}");
            }
            let mut result = Box::pin(accepted.result());
            assert!(result.as_mut().now_or_never().is_none());
            assert!(weak.upgrade().is_some());
            drop(result);
            drop(app);
            drop(client);
            assert!(
                weak.upgrade().is_some(),
                "root and Promise observers do not own cleanup"
            );
            release.add_permits(1);
            while weak.upgrade().is_some() {
                tokio::task::yield_now().await;
            }
            assert_eq!(calls.load(Ordering::SeqCst), 2);
        }
    })
    .await
    .unwrap();
}
struct DescriptorForward;
impl Handler for DescriptorForward {
    fn call(&self, _: String, input: Value, context: Context) -> BoxFuture<'static, Result<Value>> {
        let attachments = if input == "ordinary-reject" {
            Attachments::new()
        } else {
            Attachments::from([(
                "text".into(),
                Arc::new(BadDescriptor::new(input == "enqueue-panic")) as Arc<dyn ReadResource>,
            )])
        };
        let result = context.call("echo", 0, "echo".into(), json!("healthy"), attachments);
        Box::pin(async move {
            if let Ok(observer) = result {
                assert!(observer.await.is_err());
            }
            Ok(json!("caught"))
        })
    }
}
#[tokio::test]
async fn accepted_parent_descriptor_panics_are_cleanup_failure_but_ordinary_child_rejection_is_clean()
 {
    tokio::time::timeout(Duration::from_secs(15), async {
        for mode in ["ordinary-reject", "enqueue-panic", "admission-panic"] {
            let (provider, consumer) = attached_packages();
            let wrapper = package(
                "native.descriptor",
                wrapper_entry(Implementation::Native {
                    implementation: "native.descriptor".into(),
                }),
                None,
            );
            let calls = Arc::new(AtomicUsize::new(0));
            let mut native = registry_contract(
                Arc::new(ReadAttachment {
                    calls: calls.clone(),
                    started: Arc::new(Semaphore::new(0)),
                    release: Arc::new(Semaphore::new(0)),
                }),
                attached_contract(),
            );
            native
                .insert(
                    "native.descriptor".into(),
                    Arc::new(|_, _| {
                        Box::pin(async {
                            NativeActivation {
                                exports: Ok(BTreeMap::from([(
                                    "echo".into(),
                                    Published {
                                        contract: attached_contract(),
                                        value: Arc::new(DescriptorForward) as Arc<dyn Handler>,
                                    },
                                )])),
                                owner: native_owner(|| Box::pin(async { Ok(()) })),
                            }
                        })
                    }),
                )
                .unwrap();
            let issuer = Issuer::default();
            let app = Application::start(
                wrapper_input(&provider, &consumer, &wrapper),
                vec![provider, consumer, wrapper],
                native,
                issuer.clone(),
                Arc::new(ForwardPolicy(issuer.clone())),
                Some(maka_host_js::factory(Limits::default())),
            )
            .unwrap();
            app.ready().await.unwrap();
            let client = app.client();
            let binding = client
                .bind(client.activation(&id(2)).unwrap(), "echo".into())
                .await
                .unwrap()
                .pop()
                .unwrap();
            let (attachments, weak) = bytes(5);
            assert_eq!(
                client
                    .start(
                        binding,
                        "echo".into(),
                        json!(mode),
                        scope(&issuer, true),
                        attachments.into()
                    )
                    .await
                    .unwrap()
                    .result()
                    .await
                    .unwrap(),
                json!("caught")
            );
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            if mode == "ordinary-reject" {
                assert!(weak.upgrade().is_none());
                assert!(client.snapshot().cleanup_error.is_none());
                app.shutdown().await.unwrap();
            } else {
                assert!(weak.upgrade().is_some());
                assert!(
                    client
                        .snapshot()
                        .cleanup_error
                        .unwrap()
                        .contains("panicked")
                );
                assert_eq!(
                    client
                        .snapshot()
                        .instances
                        .iter()
                        .find(|s| s.activation.instance() == &id(4))
                        .unwrap()
                        .calls,
                    1
                );
                assert_eq!(
                    client
                        .snapshot()
                        .instances
                        .iter()
                        .find(|s| s.activation.instance() == &id(1))
                        .unwrap()
                        .calls,
                    0
                );
                drop(app);
                drop(client);
                assert!(weak.upgrade().is_some());
            }
        }
    })
    .await
    .unwrap();
}
