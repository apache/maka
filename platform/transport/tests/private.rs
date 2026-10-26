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

//! Physical failure and interrupted confirmations retain their original fences.
#[allow(dead_code)]
mod support;
use maka_event_log::{
    root::{RootNamespaces, RootOwner},
    root_store::RootStore,
};
use maka_host_runtime::application::{Application, NativeRegistry};
use maka_plugin_core::{composition::PresentationTarget, deployment::DeploymentRef};
use maka_transport::{
    Grant,
    transport::{Call, Endpoint, Peer, PeerPolicy, Reply, Server, Source},
    with_gateway,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, DuplexStream, ReadBuf};
use uuid::Uuid;
struct Fixture {
    _directory: tempfile::TempDir,
    namespaces: RootNamespaces,
    root: std::path::PathBuf,
    caller_root: std::path::PathBuf,
    store: Arc<RootStore>,
    caller: Arc<RootStore>,
    source: DeploymentRef,
    app: Application,
    server: Arc<Server>,
    peer: Arc<maka_transport::transport::Peers>,
}
// This progress fixture uses the same contract at the caller, gateway and provider.
fn wide_progress_contract() -> maka_plugin_core::contract::Contract {
    let mut contract = support::business();
    let maka_plugin_core::contract::Interface::Service { methods } = &mut contract.interface else {
        unreachable!()
    };
    methods.get_mut("write").unwrap().progress = Some(
        serde_json::json!({
            "type":"object","properties":{"step":{"type":"string"}},
            "required":["step"],"additionalProperties":false
        })
        .into(),
    );
    contract
}
fn wide_progress() -> serde_json::Value {
    serde_json::json!({"step":format!("原始:{}:尾", "中🙂\"\\\n\0".repeat(8192))})
}
fn replace_progress_contract(
    input: &mut maka_plugin_core::composition::Input,
    packages: &mut [maka_packages::Package],
) {
    let contract = wide_progress_contract();
    for package in packages {
        let original = package.application_ref();
        let mut declaration = package
            .manifest()
            .application
            .as_ref()
            .unwrap()
            .declaration()
            .clone();
        let mut changed = false;
        for entry in declaration.entries.values_mut() {
            for import in entry.imports.values_mut() {
                if import.contract.name == contract.name {
                    import.contract = contract.clone();
                    changed = true;
                }
            }
            for export in entry.exports.values_mut() {
                if export.contract.name == contract.name {
                    export.contract = contract.clone();
                    changed = true;
                }
            }
        }
        if changed {
            let mut files = package.files().clone();
            if package.manifest().id == "local.ui" {
                // Keep the original progress in state, without rendering its entire
                // payload into the unrelated terminal Text node.
                let source = String::from_utf8(files.remove("index.mjs").unwrap()).unwrap();
                let display =
                    "JSON.stringify(state.outcome?.reply?.receipt??state.outcome??'Ready')";
                assert!(source.contains(display));
                files.insert("index.mjs".into(), source.replace(display,
                    "(state.outcome?.status==='updated'?'Progress received':JSON.stringify(state.outcome?.reply?.receipt??state.outcome??'Ready'))").into_bytes());
            }
            files.insert(
                maka_packages::MANIFEST_FILE.into(),
                serde_json::to_vec(&serde_json::json!({
                    "schemaVersion":1,"id":package.manifest().id,"application":declaration
                }))
                .unwrap(),
            );
            *package = maka_packages::Package::new(files).unwrap();
            for node in input.instances.values_mut() {
                if node.package == original.clone().into() {
                    node.package = package.application_ref().into();
                }
            }
        }
    }
}
impl Fixture {
    async fn new() -> Self {
        Self::with_gate(None).await
    }
    async fn with_gate(gate: Option<Arc<Gate>>) -> Self {
        let directory = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }
        let root = directory.path().join("host");
        let caller_root = directory.path().join("caller");
        let namespaces = RootNamespaces {
            ownership: directory.path().join("owners"),
            control: directory.path().join("control"),
        };
        let owner = Arc::new(RootOwner::create(&root, &namespaces).unwrap());
        let store = Arc::new(support::setup(RootStore::open(owner)).await.unwrap());
        let owner = Arc::new(RootOwner::create(&caller_root, &namespaces).unwrap());
        let caller = Arc::new(support::setup(RootStore::open(owner)).await.unwrap());
        let wide_progress = gate.as_ref().is_some_and(|gate| gate.progress);
        let (mut input, mut packages, mut observations) = support::ui(PresentationTarget::Tui);
        if wide_progress {
            replace_progress_contract(&mut input, &mut packages);
            for observation in &mut observations {
                if observation.declaration.contract.name == support::business().name {
                    observation.declaration.contract = wide_progress_contract();
                }
            }
        }
        let source = caller
            .commit_application(Uuid::new_v4(), 0, input, observations, packages)
            .await
            .unwrap();
        let deployment = Uuid::new_v4();
        let (mut input, mut packages) = support::host();
        let mut native = NativeRegistry::default();
        if let Some(gate) = gate {
            let old = packages
                .iter_mut()
                .find(|p| p.manifest().id == "local.business")
                .unwrap();
            let old_ref = old.application_ref();
            let mut declaration = old
                .manifest()
                .application
                .as_ref()
                .unwrap()
                .declaration()
                .clone();
            declaration
                .entries
                .get_mut(&maka_plugin_core::package::EntryTarget::Host)
                .unwrap()
                .implementation = maka_plugin_core::package::Implementation::Native {
                implementation: "private.gated".into(),
            };
            *old = support::counter::package("local.business", declaration, None);
            input.instances.get_mut("business").unwrap().package = old.application_ref().into();
            assert_ne!(old.application_ref(), old_ref);
            native
                .insert(
                    "private.gated".into(),
                    Arc::new(move |_, _| {
                        let gate = gate.clone();
                        Box::pin(async move {
                            maka_host_runtime::application::NativeActivation {
                                exports: Ok(BTreeMap::from([(
                                    "Counter".into(),
                                    maka_plugin_core::runtime::Published {
                                        contract: if wide_progress {
                                            wide_progress_contract()
                                        } else {
                                            support::business()
                                        },
                                        value: gate.clone()
                                            as Arc<dyn maka_host_runtime::application::Handler>,
                                    },
                                )])),
                                owner: gate,
                            }
                        })
                    }),
                )
                .unwrap();
        }
        if wide_progress {
            replace_progress_contract(&mut input, &mut packages);
        }
        store
            .commit_application(deployment, 0, input, vec![], packages)
            .await
            .unwrap();
        let policy = Arc::new(PeerPolicy::default());
        let app = Application::start_from_store(
            store.clone(),
            deployment,
            with_gateway(native).unwrap(),
            policy.issuer(),
            policy.clone(),
            Some(maka_host_js::factory(Default::default())),
        )
        .await
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let consumer = client.activation(&support::identity(13)).unwrap();
        let binding = client
            .bind(consumer, "business".into())
            .await
            .unwrap()
            .pop()
            .unwrap();
        let endpoint = Endpoint::new(
            binding,
            Grant {
                methods: BTreeSet::from(["read".into(), "write".into()]),
                recovery: false,
            },
        )
        .unwrap();
        let reader = client
            .bind(
                client.activation(&support::identity(13)).unwrap(),
                "receipts".into(),
            )
            .await
            .unwrap()
            .pop()
            .unwrap();
        let reader = Endpoint::new(
            reader,
            Grant {
                methods: BTreeSet::from(["read".into()]),
                recovery: true,
            },
        )
        .unwrap();
        let server = Server::new(
            client,
            policy,
            BTreeMap::from([("business".into(), endpoint), ("receipts".into(), reader)]),
        )
        .unwrap();
        let peer = maka_transport::transport::Peers::new(
            Peer::new(source.clone(), BTreeSet::from([support::identity(2)])).unwrap(),
        );
        Self {
            _directory: directory,
            namespaces,
            root,
            caller_root,
            store,
            caller,
            source,
            app,
            server,
            peer,
        }
    }
    async fn cleanup(self) {
        self.app.shutdown().await.unwrap();
        drop(self.server);
        drop(self.app);
        self.store.shutdown().await.unwrap();
        drop(self.store);
        self.caller.shutdown().await.unwrap();
        drop(self.caller);
        drop(RootOwner::open(&self.root, &self.namespaces).unwrap());
    }
}
struct PanicReader;
impl AsyncRead for PanicReader {
    fn poll_read(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        _: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}
impl Drop for PanicReader {
    fn drop(&mut self) {
        panic!("physical input cleanup failed");
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn physical_drop_panic_is_a_sticky_server_failure_before_root_shutdown() {
    let f = Fixture::new().await;
    let observer = f
        .server
        .serve(PanicReader, tokio::io::sink(), f.peer.clone())
        .unwrap();
    assert!(observer.await.is_err());
    assert!(f.server.close().await.unwrap_err().contains("panicked"));
    assert!(f.server.close().await.is_err());
    assert_eq!(
        RootOwner::open(&f.root, &f.namespaces)
            .err()
            .unwrap()
            .kind(),
        std::io::ErrorKind::WouldBlock
    );
    // Explicit fixture teardown, never a claimed server cleanup receipt.
    f.cleanup().await;
}
struct PartialWriter {
    inner: DuplexStream,
    stage: Arc<AtomicUsize>,
    written: Arc<AtomicUsize>,
}
impl AsyncWrite for PartialWriter {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let stage = self.stage.load(Ordering::SeqCst);
        if stage == 2 {
            return Poll::Pending;
        }
        let bytes = if stage == 1 {
            &bytes[..bytes.len().min(2)]
        } else {
            bytes
        };
        match Pin::new(&mut self.inner).poll_write(cx, bytes) {
            Poll::Ready(Ok(n)) => {
                self.written.fetch_add(n, Ordering::SeqCst);
                if stage == 1 {
                    self.stage.store(2, Ordering::SeqCst);
                }
                Poll::Ready(Ok(n))
            }
            other => other,
        }
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_partial_commit_keeps_real_sql_token_and_cannot_append_cancel() {
    let f = Fixture::new().await;
    let (server_input, output) = tokio::io::duplex(64 * 1024);
    let (server_output, input) = tokio::io::duplex(64 * 1024);
    let observer = f
        .server
        .serve(server_input, server_output, f.peer.clone())
        .unwrap();
    let stage = Arc::new(AtomicUsize::new(0));
    let written = Arc::new(AtomicUsize::new(0));
    let source = Source {
        deployment: f.source.clone(),
        consumer: support::identity(2),
        mount: uuid::Uuid::new_v4(),
        request: Uuid::new_v4(),
    };
    let mut call = Call::new(
        input,
        PartialWriter {
            inner: output,
            stage: stage.clone(),
            written: written.clone(),
        },
        f.server.catalogue().select("business").unwrap(),
        source,
        "write".into(),
        serde_json::Value::Null,
        Default::default(),
    );
    call.start().await.unwrap();
    assert!(matches!(
        call.receive().await.unwrap(),
        Reply::Prepared { .. }
    ));
    let reference = call.reference().unwrap().clone();
    let recorded = f
        .caller
        .record_application_intent(
            f.source.clone(),
            support::identity(2),
            reference.clone(),
            serde_json::Value::Null,
        )
        .await
        .unwrap();
    let before = written.load(Ordering::SeqCst);
    stage.store(1, Ordering::SeqCst);
    {
        let mut commit = Box::pin(call.commit(recorded));
        assert!(futures_util::poll!(&mut commit).is_pending());
    }
    assert_eq!(written.load(Ordering::SeqCst), before + 2);
    assert!(call.holds_caller_intent());
    assert!(!call.cleanup_confirmed());
    stage.store(3, Ordering::SeqCst);
    assert!(call.cancel().await.is_err());
    assert_eq!(written.load(Ordering::SeqCst), before + 2);
    call.disconnect();
    // Only the caller public API can close this half-written channel. Original
    // server work must settle from physical EOF without Server.close().
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(5), observer)
            .await
            .unwrap()
            .is_err()
    );
    assert!(call.holds_caller_intent());
    assert!(!call.cleanup_confirmed());
    assert_eq!(written.load(Ordering::SeqCst), before + 2);
    f.server.close().await.unwrap();
    assert!(
        f.store
            .operation(&reference)
            .unwrap()
            .operation_observation()
            .await
            .unwrap()
            .is_none()
    );
    let Fixture {
        _directory,
        namespaces,
        caller_root,
        store,
        caller,
        app,
        server,
        ..
    } = f;
    app.shutdown().await.unwrap();
    drop(server);
    drop(app);
    store.shutdown().await.unwrap();
    drop(store);
    Arc::try_unwrap(caller).ok().unwrap().close().await.unwrap();
    assert_eq!(
        RootOwner::open(&caller_root, &namespaces)
            .err()
            .unwrap()
            .kind(),
        std::io::ErrorKind::WouldBlock
    );
    // The trusted fixture has separately observed original server close. No
    // remote frame, historical receipt or cancelled future supplied that ack.
    drop(call);
    drop(RootOwner::open(&caller_root, &namespaces).unwrap());
}

#[derive(Default)]
struct Gate {
    progress: bool,
    cancelled: Arc<tokio::sync::Notify>,
    release: Option<Arc<tokio::sync::Semaphore>>,
    callers: std::sync::Mutex<Vec<Option<maka_host_runtime::application::Caller>>>,
    entered: tokio::sync::Notify,
}
impl maka_host_runtime::application::Handler for Gate {
    fn call(
        &self,
        method: String,
        _: serde_json::Value,
        context: maka_host_runtime::application::Context,
    ) -> futures_util::future::BoxFuture<'static, Result<serde_json::Value, String>> {
        self.callers.lock().unwrap().push(context.caller().cloned());
        let stop = context.scope().cancellation.clone();
        let progress = self.progress;
        let cancelled = self.cancelled.clone();
        let release = self.release.clone();
        if method == "write" {
            self.entered.notify_one();
        }
        Box::pin(async move {
            if method == "write" {
                if progress {
                    context.emit(wide_progress()).await?;
                }
                stop.cancelled().await;
                cancelled.notify_one();
                if let Some(release) = release {
                    release.acquire().await.unwrap().forget();
                }
                Ok(serde_json::json!({"cancelled":true}))
            } else {
                Ok(serde_json::json!({"effects":0}))
            }
        })
    }
}
impl maka_host_runtime::application::NativeOwner for Gate {
    fn close(&self) -> futures_util::future::BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
struct Physical {
    server: Arc<Server>,
    peer: Arc<maka_transport::transport::Peers>,
}
impl maka_transport::transport::native::Connector for Physical {
    fn connect(
        &self,
        stop: tokio_util::sync::CancellationToken,
    ) -> futures_util::future::BoxFuture<
        'static,
        Result<maka_transport::transport::native::Stream, String>,
    > {
        let server = self.server.clone();
        let peer = self.peer.clone();
        Box::pin(async move {
            if stop.is_cancelled() {
                return Err("physical opening cancelled before admission".into());
            }
            let (channel, accepted) = tokio::io::duplex(64 * 1024);
            let (reader, writer) = tokio::io::split(accepted);
            // Original Server publishes owned work before returning this observer.
            drop(server.serve(reader, writer, peer)?);
            Ok(Box::new(channel) as maka_transport::transport::native::Stream)
        })
    }
}
struct Capture {
    inner: Arc<dyn maka_ui_runtime::actions::NativeService>,
    source: Arc<std::sync::Mutex<Option<maka_ui_runtime::actions::ServiceSource>>>,
}
impl maka_ui_runtime::actions::NativeService for Capture {
    fn call(
        &self,
        request: maka_ui_runtime::actions::ServiceRequest,
    ) -> maka_ui_runtime::actions::ServiceFuture {
        *self.source.lock().unwrap() = Some(request.source.clone());
        self.inner.call(request)
    }
    fn mutation(
        &self,
        request: maka_ui_runtime::actions::ServiceRequest,
    ) -> Result<Arc<dyn maka_ui_runtime::actions::NativeMutation>, String> {
        self.inner.mutation(request)
    }
}
async fn native_ui(
    f: &Fixture,
    connector: Arc<dyn maka_transport::transport::native::Connector>,
) -> (
    maka_ui_runtime::Application,
    Arc<maka_transport::transport::native::Connection>,
    Arc<std::sync::Mutex<Option<maka_ui_runtime::actions::ServiceSource>>>,
    Arc<dyn maka_ui_runtime::actions::NativeService>,
) {
    native_ui_at(f, connector, f.server.catalogue()).await
}
async fn native_ui_at(
    f: &Fixture,
    connector: Arc<dyn maka_transport::transport::native::Connector>,
    catalogue: maka_transport::transport::Catalogue,
) -> (
    maka_ui_runtime::Application,
    Arc<maka_transport::transport::native::Connection>,
    Arc<std::sync::Mutex<Option<maka_ui_runtime::actions::ServiceSource>>>,
    Arc<dyn maka_ui_runtime::actions::NativeService>,
) {
    use maka_transport::transport::native::{Connection, Service};
    let connection = Connection::new(connector);
    let source = Arc::new(std::sync::Mutex::new(None));
    let business = Arc::new(
        Service::new(
            connection.clone(),
            catalogue.select("business").unwrap(),
            f.peer.clone(),
        )
        .unwrap(),
    ) as Arc<dyn maka_ui_runtime::actions::NativeService>;
    let mut registrations = Vec::new();
    for (name, implementation) in [
        (
            "business",
            Arc::new(Capture {
                inner: business.clone(),
                source: source.clone(),
            }) as Arc<dyn maka_ui_runtime::actions::NativeService>,
        ),
        (
            "receipts",
            Arc::new(
                Service::new(
                    connection.clone(),
                    catalogue.select("receipts").unwrap(),
                    f.peer.clone(),
                )
                .unwrap(),
            ),
        ),
    ] {
        let selected = catalogue.select(name).unwrap();
        let description = selected.description();
        registrations.push(maka_ui_runtime::actions::RemoteService {
            target: maka_plugin_core::plan::RemoteCapability {
                deployment: "local".into(),
                instance: description.provider.clone(),
                export: description.export.clone(),
            },
            registration_epoch: description.registration_epoch.unwrap(),
            contract: description.contract.clone(),
            implementation,
        });
    }
    let ui = maka_ui_runtime::Application::start_from_store(
        f.caller.clone(),
        f.source.clone(),
        PresentationTarget::Tui,
        tokio::runtime::Handle::current(),
        maka_ui_js::execution(Default::default()),
        support::counter::scene::registry(PresentationTarget::Tui),
        registrations,
    )
    .await
    .unwrap();
    (ui, connection, source, business)
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn burst_of_native_queries_completes_without_manual_retry() {
    let f = Fixture::with_gate(Some(Arc::new(Gate::default()))).await;
    let (mut ui, connection, source, service) = native_ui(
        &f,
        Arc::new(Physical {
            server: f.server.clone(),
            peer: f.peer.clone(),
        }),
    )
    .await;
    let root = ui.mount_launch(serde_json::json!({})).unwrap();
    ui.wait_idle().await.unwrap();
    assert_eq!(
        ui_action(&mut ui, &root, "read").await["status"],
        "succeeded"
    );
    let source = source.lock().unwrap().take().unwrap();
    let calls = (0..320)
        .map(|_| {
            service.call(maka_ui_runtime::actions::ServiceRequest {
                source: source.clone(),
                method: "read".into(),
                input: serde_json::Value::Null,
                resources: Default::default(),
            })
        })
        .collect::<Vec<_>>();
    let results = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        futures_util::future::join_all(calls),
    )
    .await
    .unwrap();
    let mut failures = Vec::new();
    for result in results {
        if let Err(reason) = result.result {
            failures.push(reason);
        }
        assert!(result.cleanup.is_ok());
    }
    stop_ui(ui, &root).await;
    connection.close().await.unwrap();
    drop(service);
    drop(connection);
    f.server.close().await.unwrap();
    f.cleanup().await;
    assert!(failures.is_empty(), "read burst failed: {failures:?}");
}

async fn ui_action(
    ui: &mut maka_ui_runtime::Application,
    root: &maka_plugin_core::runtime::Mount,
    key: &str,
) -> serde_json::Value {
    ui.dispatch(
        root,
        ui.frame(root).unwrap().revision,
        key,
        serde_json::Value::Null,
    )
    .unwrap();
    ui.wait_idle().await.unwrap();
    ui.capture_actions(root, |_| panic!("resource-free action"))
        .unwrap();
    let mut task = ui.start_task(root).unwrap().unwrap();
    loop {
        let completion = task.future.await;
        match ui.finish_task(task.id, completion).unwrap() {
            Some(next) => task = next,
            None => break,
        }
    }
    ui.deliver_action_results(root, |_, _, _| Ok(false))
        .unwrap();
    ui.wait_idle().await.unwrap();
    ui.frame(root).unwrap().state["outcome"].clone()
}
async fn stop_ui(mut ui: maka_ui_runtime::Application, root: &maka_plugin_core::runtime::Mount) {
    ui.retire(root).unwrap();
    ui.close(root, Ok(())).unwrap();
    std::future::poll_fn(|cx| {
        ui.set_waker(cx.waker().clone());
        match ui.shutdown() {
            Err(maka_ui_runtime::Error::Core(maka_plugin_core::Error::CleanupPending)) => {
                std::task::Poll::Pending
            }
            result => std::task::Poll::Ready(result),
        }
    })
    .await
    .unwrap();
    assert!(ui.can_shutdown());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_adapter_runs_checked_ui_actions_actual_caller_sql_and_original_recovery() {
    use maka_host_runtime::application::{
        host::{Client, Configuration as HostConfiguration, Host},
        transport::HostEndpoint,
    };
    let f = Fixture::new().await;
    let deployment = f.app.source().unwrap().deployment;
    f.server.close().await.unwrap();
    f.app.shutdown().await.unwrap();
    let selections = BTreeMap::from([
        (
            "business".into(),
            HostEndpoint {
                consumer: support::identity(13),
                import: "business".into(),
                grant: Grant {
                    methods: ["read".into(), "write".into()].into(),
                    recovery: false,
                },
            },
        ),
        (
            "receipts".into(),
            HostEndpoint {
                consumer: support::identity(13),
                import: "receipts".into(),
                grant: Grant {
                    methods: ["read".into()].into(),
                    recovery: true,
                },
            },
        ),
    ]);
    let host = Host::open(
        f.store.clone(),
        deployment,
        NativeRegistry::default(),
        Some(maka_host_js::factory(Default::default())),
        HostConfiguration::PublicHost {
            endpoints: selections.clone(),
            native: vec![],
            product_methods: Default::default(),
        },
    )
    .await
    .unwrap();
    #[cfg(unix)]
    let path = f._directory.path().join("native.sock");
    #[cfg(windows)]
    let path = std::path::PathBuf::from(format!(r"\\.\pipe\maka-native-test-{}", Uuid::new_v4()));
    let listener = maka_host_runtime::ipc::LocalListener::bind(&path).unwrap();
    let serving = tokio::spawn({
        let host = host.clone();
        async move {
            host.serve_local(listener, tokio_util::sync::CancellationToken::new())
                .await
        }
    });
    let anchor = Client::connect_peer(
        &path,
        Some(host.epoch()),
        f.source.clone(),
        [support::identity(2)].into(),
        selections,
    )
    .await
    .unwrap();
    let (mut ui, connection, _, _) = native_ui_at(
        &f,
        Arc::new(maka_transport::transport::ipc::Connector::new(
            anchor.call_channel_opener().unwrap(),
        )),
        anchor.catalogue().clone(),
    )
    .await;
    let root = ui.mount_launch(serde_json::json!({})).unwrap();
    ui.wait_idle().await.unwrap();
    assert_eq!(
        ui_action(&mut ui, &root, "read").await["value"]["effects"],
        0
    );
    let result = ui_action(&mut ui, &root, "write").await;
    assert_eq!(result["status"], "operation");
    assert_eq!(result["reply"]["receipt"]["cleanup"]["kind"], "confirmed");
    assert_eq!(
        ui_action(&mut ui, &root, "read").await["value"]["effects"],
        1
    );
    assert_eq!(
        ui_action(&mut ui, &root, "recover").await["value"],
        result["reply"]
    );
    let intents = f
        .caller
        .application_intents(f.source.deployment, support::identity(2), 0, 10)
        .await
        .unwrap();
    assert_eq!(intents.len(), 1);
    assert_eq!(
        result["caller"],
        serde_json::to_value(intents[0].confirmation()).unwrap()
    );
    assert_eq!(result["caller"]["reference"], result["reply"]["reference"]);
    stop_ui(ui, &root).await;
    connection.close().await.unwrap();
    drop(connection);
    drop(anchor);
    // Detaching the UI does not stop the independent business Host.
    let mut observer = Client::connect(&path, Some(host.epoch())).await.unwrap();
    let mut read = observer
        .call(
            "business",
            "read".into(),
            serde_json::Value::Null,
            Default::default(),
        )
        .await
        .unwrap();
    read.start().await.unwrap();
    assert!(
        matches!(read.receive().await.unwrap(), Reply::Finished { result: Ok(ref value), cleanup: Ok(()) } if value["effects"] == 1)
    );
    observer.close().await.unwrap();
    assert!(Client::retire(&path, host.epoch()).await.unwrap());
    serving.await.unwrap().unwrap();
    drop(host);
    f.cleanup().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_native_dispatch_and_close_cancel_the_original_host_without_a_mutex_cycle() {
    let gate = Arc::new(Gate::default());
    let f = Fixture::with_gate(Some(gate.clone())).await;
    let (mut ui, connection, source, service) = native_ui(
        &f,
        Arc::new(Physical {
            server: f.server.clone(),
            peer: f.peer.clone(),
        }),
    )
    .await;
    let root = ui.mount_launch(serde_json::json!({})).unwrap();
    ui.wait_idle().await.unwrap();
    ui_action(&mut ui, &root, "read").await;
    let source = source.lock().unwrap().take().unwrap();
    let inert = service
        .mutation(maka_ui_runtime::actions::ServiceRequest {
            source: source.clone(),
            method: "write".into(),
            input: serde_json::Value::Null,
            resources: Default::default(),
        })
        .unwrap();
    let session = service
        .mutation(maka_ui_runtime::actions::ServiceRequest {
            source,
            method: "write".into(),
            input: serde_json::Value::Null,
            resources: Default::default(),
        })
        .unwrap();
    let reference = session.clone().prepare().await.unwrap();
    let recorded = f
        .caller
        .record_application_intent(
            f.source.clone(),
            support::identity(2),
            reference.clone(),
            serde_json::Value::Null,
        )
        .await
        .unwrap();
    let dispatched = tokio::spawn(
        session
            .clone()
            .dispatch(recorded, tokio::sync::mpsc::channel(1).0),
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), gate.entered.notified())
        .await
        .unwrap();
    // Revocation rejects unaccepted work but cannot discard accepted custody.
    f.peer.replace(vec![]).unwrap();
    assert!(
        inert
            .clone()
            .prepare()
            .await
            .unwrap_err()
            .contains("approved")
    );
    inert.clone().close().await.unwrap();
    drop(inert);
    let closed = session.clone().close();
    let (result, cleanup) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(dispatched, closed)
    })
    .await
    .unwrap();
    cleanup.unwrap();
    let result = result.unwrap();
    result.cleanup.unwrap();
    assert_eq!(result.reply.reference, reference);
    assert!(matches!(
        result.reply.receipt,
        maka_plugin_core::operation::Receipt::Recorded {
            outcome: maka_plugin_core::operation::OperationOutcome::Returned { .. },
            cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed
        }
    ));
    assert!(
        f.store
            .operation(&reference)
            .unwrap()
            .operation_observation()
            .await
            .unwrap()
            .is_some()
    );
    drop(session);
    drop(service);
    stop_ui(ui, &root).await;
    connection.close().await.unwrap();
    drop(connection);
    f.server.close().await.unwrap();
    f.cleanup().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn old_selection_cannot_retarget_the_same_alias_in_a_different_host_incarnation() {
    let original = Fixture::new().await;
    let selected = original.server.catalogue().select("business").unwrap();
    let replacement = Fixture::new().await;
    let (channel, accepted) = tokio::io::duplex(64 * 1024);
    let (reader, writer) = tokio::io::split(accepted);
    let observer = replacement
        .server
        .serve(reader, writer, replacement.peer.clone())
        .unwrap();
    let (reader, writer) = tokio::io::split(channel);
    let mut call = Call::new(
        reader,
        writer,
        selected,
        Source {
            deployment: replacement.source.clone(),
            consumer: support::identity(2),
            mount: uuid::Uuid::new_v4(),
            request: Uuid::new_v4(),
        },
        "write".into(),
        serde_json::Value::Null,
        Default::default(),
    );
    assert!(call.start().await.unwrap_err().contains("registration"));
    assert!(call.cleanup_confirmed());
    drop(call);
    observer.await.unwrap();
    replacement.server.close().await.unwrap();
    original.server.close().await.unwrap();
    replacement.cleanup().await;
    original.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unpolled_dispatch_observer_keeps_actual_sql_custody_until_original_preparation_closes() {
    let f = Fixture::new().await;
    let (channel, accepted) = tokio::io::duplex(64 * 1024);
    let (reader, writer) = tokio::io::split(accepted);
    let observer = f.server.serve(reader, writer, f.peer.clone()).unwrap();
    let (reader, writer) = tokio::io::split(channel);
    let mut call = Call::new(
        reader,
        writer,
        f.server.catalogue().select("business").unwrap(),
        Source {
            deployment: f.source.clone(),
            consumer: support::identity(2),
            mount: uuid::Uuid::new_v4(),
            request: Uuid::new_v4(),
        },
        "write".into(),
        serde_json::Value::Null,
        Default::default(),
    );
    call.start().await.unwrap();
    call.receive().await.unwrap();
    let recorded = f
        .caller
        .record_application_intent(
            f.source.clone(),
            support::identity(2),
            call.reference().unwrap().clone(),
            serde_json::Value::Null,
        )
        .await
        .unwrap();
    drop(call.commit(recorded)); // Do not poll this observer even once.
    assert!(call.holds_caller_intent());
    assert!(!call.cleanup_confirmed());
    let Fixture {
        _directory,
        namespaces,
        root,
        caller_root,
        caller,
        store,
        app,
        server,
        ..
    } = f;
    Arc::try_unwrap(caller).ok().unwrap().close().await.unwrap();
    assert_eq!(
        RootOwner::open(&caller_root, &namespaces)
            .err()
            .unwrap()
            .kind(),
        std::io::ErrorKind::WouldBlock
    );
    call.close().await.unwrap();
    assert!(!call.holds_caller_intent());
    assert!(call.cleanup_confirmed());
    drop(RootOwner::open(&caller_root, &namespaces).unwrap());
    drop(call);
    observer.await.unwrap();
    server.close().await.unwrap();
    app.shutdown().await.unwrap();
    drop(server);
    drop(app);
    store.shutdown().await.unwrap();
    drop(store);
    drop(RootOwner::open(&root, &namespaces).unwrap());
}
struct Connecting {
    entered: Arc<tokio::sync::Notify>,
}

struct HeldReservation {
    stream: maka_transport::transport::native::Stream,
    release: Option<tokio::sync::oneshot::Receiver<()>>,
    entered: Arc<tokio::sync::Notify>,
}
impl AsyncRead for HeldReservation {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if self.release.is_some() {
            self.entered.notify_one();
            std::task::ready!(Pin::new(self.release.as_mut().unwrap()).poll(cx)).unwrap();
            self.release = None;
        }
        Pin::new(&mut self.stream).poll_read(cx, buffer)
    }
}
impl AsyncWrite for HeldReservation {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}
struct Reserving {
    physical: Physical,
    release: std::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    entered: Arc<tokio::sync::Notify>,
}
impl maka_transport::transport::native::Connector for Reserving {
    fn connect(
        &self,
        stop: tokio_util::sync::CancellationToken,
    ) -> futures_util::future::BoxFuture<
        'static,
        Result<maka_transport::transport::native::Stream, String>,
    > {
        let opening = self.physical.connect(stop);
        let release = self.release.lock().unwrap().take();
        let entered = self.entered.clone();
        Box::pin(async move {
            Ok(Box::new(HeldReservation {
                stream: opening.await?,
                release,
                entered,
            }) as maka_transport::transport::native::Stream)
        })
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_during_native_reservation_finishes_the_original_handshake_and_cleanup() {
    use futures_util::FutureExt;
    let f = Fixture::new().await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let (release, held) = tokio::sync::oneshot::channel();
    let (mut ui, connection, _, service) = native_ui(
        &f,
        Arc::new(Reserving {
            physical: Physical {
                server: f.server.clone(),
                peer: f.peer.clone(),
            },
            release: std::sync::Mutex::new(Some(held)),
            entered: entered.clone(),
        }),
    )
    .await;
    let root = ui.mount_launch(serde_json::json!({})).unwrap();
    ui.wait_idle().await.unwrap();
    ui.dispatch(
        &root,
        ui.frame(&root).unwrap().revision,
        "read",
        serde_json::Value::Null,
    )
    .unwrap();
    ui.wait_idle().await.unwrap();
    ui.capture_actions(&root, |_| panic!("resource-free action"))
        .unwrap();
    let task = ui.start_task(&root).unwrap().unwrap();
    let id = task.id;
    let mut original = task.future;
    assert!(original.as_mut().now_or_never().is_none());
    tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    let close = connection.close();
    // Cancellation has been delivered, but Ready is still held. This must
    // remain the original live handshake, not a lost-channel completion.
    assert!(original.as_mut().now_or_never().is_none());
    release.send(()).unwrap();
    let (completion, cleanup) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(original, close)
    })
    .await
    .unwrap();
    cleanup.unwrap();
    ui.finish_task(id, completion).unwrap();
    assert_eq!(ui.accepted_action_count(), 0);
    stop_ui(ui, &root).await;
    drop(service);
    drop(connection);
    f.server.close().await.unwrap();
    f.cleanup().await;
}
impl maka_transport::transport::native::Connector for Connecting {
    fn connect(
        &self,
        stop: tokio_util::sync::CancellationToken,
    ) -> futures_util::future::BoxFuture<
        'static,
        Result<maka_transport::transport::native::Stream, String>,
    > {
        let entered = self.entered.clone();
        Box::pin(async move {
            entered.notify_one();
            stop.cancelled().await;
            Err("connector cancelled and settled".into())
        })
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connection_close_cancels_the_same_pending_native_connector_before_any_host_dispatch() {
    let f = Fixture::new().await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let (mut ui, connection, source, service) = native_ui(
        &f,
        Arc::new(Connecting {
            entered: entered.clone(),
        }),
    )
    .await;
    let root = ui.mount_launch(serde_json::json!({})).unwrap();
    ui.wait_idle().await.unwrap();
    ui.dispatch(
        &root,
        ui.frame(&root).unwrap().revision,
        "read",
        serde_json::Value::Null,
    )
    .unwrap();
    ui.wait_idle().await.unwrap();
    ui.capture_actions(&root, |_| panic!("resource-free action"))
        .unwrap();
    let task = ui.start_task(&root).unwrap().unwrap();
    let id = task.id;
    let original = tokio::spawn(task.future);
    tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    let source = source.lock().unwrap().take().unwrap();
    let pending = (0..32)
        .map(|_| {
            service.call(maka_ui_runtime::actions::ServiceRequest {
                source: source.clone(),
                method: "read".into(),
                input: serde_json::Value::Null,
                resources: Default::default(),
            })
        })
        .collect::<Vec<_>>();
    let mut close = connection.close();
    assert!(futures_util::poll!(&mut close).is_pending());
    let (completion, cleanup, pending) =
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(original, close, futures_util::future::join_all(pending))
        })
        .await
        .unwrap();
    cleanup.unwrap();
    for result in pending {
        assert!(result.result.is_err());
        assert!(result.cleanup.is_ok());
    }
    ui.finish_task(id, completion.unwrap()).unwrap();
    stop_ui(ui, &root).await;
    drop(service);
    drop(connection);
    f.server.close().await.unwrap();
    f.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completed_original_query_can_ack_cleanup_after_cancel_delivery_is_broken() {
    let f = Fixture::new().await;
    let (channel, accepted) = tokio::io::duplex(64 * 1024);
    let (reader, writer) = tokio::io::split(accepted);
    let observer = f.server.serve(reader, writer, f.peer.clone()).unwrap();
    let (reader, writer) = tokio::io::split(channel);
    let mut call = Call::new(
        reader,
        writer,
        f.server.catalogue().select("business").unwrap(),
        Source {
            deployment: f.source.clone(),
            consumer: support::identity(2),
            mount: uuid::Uuid::new_v4(),
            request: Uuid::new_v4(),
        },
        "read".into(),
        serde_json::Value::Null,
        Default::default(),
    );
    call.start().await.unwrap();
    // The actual Server has completed and dropped its reader; Cancel now hits
    // BrokenPipe. The original terminal frame still belongs to this call.
    observer.await.unwrap();
    match call.cancel().await.unwrap() {
        Reply::Finished { result, cleanup } => {
            assert_eq!(result.unwrap()["effects"], 0);
            cleanup.unwrap();
        }
        _ => panic!("original query completion required"),
    }
    assert!(call.cleanup_confirmed());
    call.close().await.unwrap();
    drop(call);
    f.server.close().await.unwrap();
    f.cleanup().await;
}

struct BlockingInput {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<std::sync::Barrier>,
    _root: Arc<RootOwner>,
}
impl maka_capabilities::call::ReadResource for BlockingInput {
    fn resource_type(&self) -> maka_plugin_core::contract::ResourceType {
        maka_plugin_core::contract::ResourceType {
            name: "test.payload".into(),
            version: 1,
        }
    }
    fn bytes(&self) -> usize {
        0
    }
    fn metadata(&self) -> serde_json::Value {
        serde_json::Value::Null
    }
    fn read(&self, _: std::ops::Range<usize>) -> Result<Vec<u8>, String> {
        Ok(Vec::new())
    }
}
impl Drop for BlockingInput {
    fn drop(&mut self) {
        self.entered.notify_one();
        self.release.wait();
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inert_native_cleanup_drops_real_inputs_before_releasing_the_connection_fence() {
    for explicit_close in [true, false] {
        let f = Fixture::new().await;
        let (mut ui, connection, captured, service) = native_ui(
            &f,
            Arc::new(Physical {
                server: f.server.clone(),
                peer: f.peer.clone(),
            }),
        )
        .await;
        let root = ui.mount_launch(serde_json::json!({})).unwrap();
        ui.wait_idle().await.unwrap();
        ui_action(&mut ui, &root, "read").await;
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(std::sync::Barrier::new(2));
        let payload_root = f._directory.path().join("payload");
        let payload = Arc::new(RootOwner::create(&payload_root, &f.namespaces).unwrap());
        let session = service
            .mutation(maka_ui_runtime::actions::ServiceRequest {
                source: captured.lock().unwrap().take().unwrap(),
                method: "write".into(),
                input: serde_json::Value::Null,
                resources: BTreeMap::from([(
                    "payload".into(),
                    Arc::new(BlockingInput {
                        entered: entered.clone(),
                        release: release.clone(),
                        _root: payload,
                    }) as Arc<dyn maka_capabilities::call::ReadResource>,
                )]),
            })
            .unwrap();
        // No preparation was started. Both explicit close and last-owner Drop
        // still own real local inputs through their actual destructor completion.
        let mut session = Some(session);
        let closing = if explicit_close {
            tokio::spawn(session.as_ref().unwrap().clone().close())
        } else {
            let original = session.take().unwrap();
            tokio::spawn(async move {
                drop(original);
                Ok::<(), String>(())
            })
        };
        tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        let mut connection_close = connection.close();
        assert!(futures_util::poll!(&mut connection_close).is_pending());
        assert_eq!(
            RootOwner::open(&payload_root, &f.namespaces)
                .err()
                .unwrap()
                .kind(),
            std::io::ErrorKind::WouldBlock
        );
        release.wait();
        closing.await.unwrap().unwrap();
        drop(RootOwner::open(&payload_root, &f.namespaces).unwrap());
        drop(session);
        connection_close.await.unwrap();
        drop(service);
        stop_ui(ui, &root).await;
        drop(connection);
        f.server.close().await.unwrap();
        f.cleanup().await;
    }
}

struct PanickingOpening {
    entered: Arc<tokio::sync::Notify>,
    waiting: futures_util::future::BoxFuture<'static, ()>,
    panic_on_drop: bool,
}
impl Future for PanickingOpening {
    type Output = Result<maka_transport::transport::native::Stream, String>;
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if !self.panic_on_drop {
            panic!("opening first poll panicked");
        }
        self.entered.notify_one();
        match self.waiting.as_mut().poll(cx) {
            Poll::Ready(()) => Poll::Ready(Err("cancelled opening".into())),
            Poll::Pending => Poll::Pending,
        }
    }
}
impl Drop for PanickingOpening {
    fn drop(&mut self) {
        if self.panic_on_drop {
            panic!("opening drop panicked");
        }
    }
}
struct PanicConnector {
    entered: Arc<tokio::sync::Notify>,
    panic_on_drop: bool,
}
impl maka_transport::transport::native::Connector for PanicConnector {
    fn connect(
        &self,
        stop: tokio_util::sync::CancellationToken,
    ) -> futures_util::future::BoxFuture<
        'static,
        Result<maka_transport::transport::native::Stream, String>,
    > {
        Box::pin(PanickingOpening {
            entered: self.entered.clone(),
            waiting: Box::pin(stop.cancelled_owned()),
            panic_on_drop: self.panic_on_drop,
        })
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn panicked_original_opening_keeps_the_connection_fenced_without_a_published_call() {
    for panic_on_drop in [false, true] {
        let f = Fixture::new().await;
        let entered = Arc::new(tokio::sync::Notify::new());
        let (mut ui, connection, _, service) = native_ui(
            &f,
            Arc::new(PanicConnector {
                entered: entered.clone(),
                panic_on_drop,
            }),
        )
        .await;
        let root = ui.mount_launch(serde_json::json!({})).unwrap();
        ui.wait_idle().await.unwrap();
        ui.dispatch(
            &root,
            ui.frame(&root).unwrap().revision,
            "read",
            serde_json::Value::Null,
        )
        .unwrap();
        ui.wait_idle().await.unwrap();
        ui.capture_actions(&root, |_| panic!("resource-free action"))
            .unwrap();
        let task = ui.start_task(&root).unwrap().unwrap();
        let id = task.id;
        let original = tokio::spawn(task.future);
        if panic_on_drop {
            tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
                .await
                .unwrap();
            // This same opening completes on cancellation, then its destructor
            // panics before any settled error can release the opening fence.
            drop(connection.close());
        }
        let completion = original.await;
        if let Ok(completion) = completion {
            assert!(matches!(
                ui.finish_task(id, completion),
                Err(maka_ui_runtime::Error::Core(
                    maka_plugin_core::Error::CleanupFailed(_)
                ))
            ));
        }
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(5), connection.close())
                .await
                .unwrap()
                .is_err()
        );
        // This deliberately failed UI/request remains an original cleanup fence.
        // Do not relabel or replay it; discard only the isolated test fixture.
        drop(service);
        drop(ui);
        drop(connection);
        f.server.close().await.unwrap();
        f.cleanup().await;
    }
}

struct InjectedChannel {
    stream: DuplexStream,
    broken: Option<Arc<std::sync::atomic::AtomicBool>>,
    panic_on_drop: bool,
}
impl AsyncRead for InjectedChannel {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if self
            .broken
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::SeqCst))
        {
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.stream).poll_read(cx, buffer)
    }
}
impl AsyncWrite for InjectedChannel {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        if self
            .broken
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::SeqCst))
        {
            return Poll::Ready(Err(std::io::ErrorKind::BrokenPipe.into()));
        }
        Pin::new(&mut self.stream).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}
impl Drop for InjectedChannel {
    fn drop(&mut self) {
        if self.panic_on_drop {
            panic!("returned physical channel drop panicked");
        }
    }
}
struct DoubleOpening {
    stream: Option<maka_transport::transport::native::Stream>,
    poll_panics: bool,
}
impl Future for DoubleOpening {
    type Output = Result<maka_transport::transport::native::Stream, String>;
    fn poll(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Self::Output> {
        if self.poll_panics {
            panic!("original opening poll panicked");
        }
        Poll::Ready(Ok(self.stream.take().unwrap()))
    }
}
impl Drop for DoubleOpening {
    fn drop(&mut self) {
        panic!("original opening destructor panicked");
    }
}
struct DoubleConnector {
    server: Arc<Server>,
    peer: Arc<maka_transport::transport::Peers>,
    poll_panics: bool,
}
impl maka_transport::transport::native::Connector for DoubleConnector {
    fn connect(
        &self,
        _: tokio_util::sync::CancellationToken,
    ) -> futures_util::future::BoxFuture<
        'static,
        Result<maka_transport::transport::native::Stream, String>,
    > {
        let (channel, accepted) = tokio::io::duplex(64 * 1024);
        let (reader, writer) = tokio::io::split(accepted);
        drop(
            self.server
                .serve(reader, writer, self.peer.clone())
                .unwrap(),
        );
        let stream: maka_transport::transport::native::Stream = if self.poll_panics {
            Box::new(channel)
        } else {
            Box::new(InjectedChannel {
                stream: channel,
                broken: None,
                panic_on_drop: true,
            })
        };
        Box::pin(DoubleOpening {
            stream: Some(stream),
            poll_panics: self.poll_panics,
        })
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opening_poll_future_drop_and_returned_channel_drop_are_independently_isolated() {
    for poll_panics in [true, false] {
        let f = Fixture::new().await;
        let (mut ui, connection, _, service) = native_ui(
            &f,
            Arc::new(DoubleConnector {
                server: f.server.clone(),
                peer: f.peer.clone(),
                poll_panics,
            }),
        )
        .await;
        let root = ui.mount_launch(serde_json::json!({})).unwrap();
        ui.wait_idle().await.unwrap();
        ui.dispatch(
            &root,
            ui.frame(&root).unwrap().revision,
            "read",
            serde_json::Value::Null,
        )
        .unwrap();
        ui.wait_idle().await.unwrap();
        ui.capture_actions(&root, |_| panic!("resource-free action"))
            .unwrap();
        let task = ui.start_task(&root).unwrap().unwrap();
        let completion = tokio::spawn(task.future)
            .await
            .expect("independent panic boundaries must not abort or unwind the UI task");
        assert!(matches!(
            ui.finish_task(task.id, completion),
            Err(maka_ui_runtime::Error::Core(
                maka_plugin_core::Error::CleanupFailed(_)
            ))
        ));
        assert!(connection.close().await.is_err());
        drop(service);
        drop(ui);
        drop(connection);
        // Only the original physical disconnect cancels the actual Server work.
        f.server.close().await.unwrap();
        f.cleanup().await;
    }
}

struct BrokenConnector {
    server: Arc<Server>,
    peer: Arc<maka_transport::transport::Peers>,
    broken: Arc<std::sync::atomic::AtomicBool>,
}
impl maka_transport::transport::native::Connector for BrokenConnector {
    fn connect(
        &self,
        stop: tokio_util::sync::CancellationToken,
    ) -> futures_util::future::BoxFuture<
        'static,
        Result<maka_transport::transport::native::Stream, String>,
    > {
        let server = self.server.clone();
        let peer = self.peer.clone();
        let broken = self.broken.clone();
        Box::pin(async move {
            if stop.is_cancelled() {
                return Err("opening cancelled before physical admission".into());
            }
            let (channel, accepted) = tokio::io::duplex(64 * 1024);
            let (reader, writer) = tokio::io::split(accepted);
            drop(server.serve(reader, writer, peer)?);
            Ok(Box::new(InjectedChannel {
                stream: channel,
                broken: Some(broken),
                panic_on_drop: false,
            }) as maka_transport::transport::native::Stream)
        })
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lost_close_before_dispatch_poll_keeps_the_actual_confirmed_sql_token() {
    let f = Fixture::new().await;
    let broken = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (mut ui, connection, captured, service) = native_ui(
        &f,
        Arc::new(BrokenConnector {
            server: f.server.clone(),
            peer: f.peer.clone(),
            broken: broken.clone(),
        }),
    )
    .await;
    let root = ui.mount_launch(serde_json::json!({})).unwrap();
    ui.wait_idle().await.unwrap();
    ui_action(&mut ui, &root, "read").await;
    let session = service
        .mutation(maka_ui_runtime::actions::ServiceRequest {
            source: captured.lock().unwrap().take().unwrap(),
            method: "write".into(),
            input: serde_json::Value::Null,
            resources: Default::default(),
        })
        .unwrap();
    let reference = session.clone().prepare().await.unwrap();
    let token = f
        .caller
        .record_application_intent(
            f.source.clone(),
            support::identity(2),
            reference.clone(),
            serde_json::Value::Null,
        )
        .await
        .unwrap();
    let dispatch = session
        .clone()
        .dispatch(token, tokio::sync::mpsc::channel(1).0);
    // Actual caller SQL is confirmed, but its dispatch observer has not run.
    broken.store(true, Ordering::SeqCst);
    assert!(session.clone().close().await.is_err());
    let completion = dispatch.await;
    assert!(completion.cleanup.is_err());
    assert_eq!(completion.reply.reference, reference);
    assert!(matches!(
        completion.reply.receipt,
        maka_plugin_core::operation::Receipt::Unavailable { .. }
    ));
    drop(session);
    stop_ui(ui, &root).await;
    let Fixture {
        _directory,
        namespaces,
        root: host_root,
        caller_root,
        store,
        caller,
        app,
        server,
        ..
    } = f;
    caller.shutdown().await.unwrap();
    drop(caller);
    // Only the original native failed-call token still holds this real Root.
    assert_eq!(
        RootOwner::open(&caller_root, &namespaces)
            .err()
            .unwrap()
            .kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert!(connection.close().await.is_err());
    server.close().await.unwrap();
    app.shutdown().await.unwrap();
    drop(server);
    drop(app);
    store.shutdown().await.unwrap();
    drop(store);
    drop(RootOwner::open(&host_root, &namespaces).unwrap());
    // Isolated fixture teardown destroys failed custody only after independently
    // draining its actual Host. It is not a successful Connection cleanup ack.
    drop(service);
    drop(connection);
    drop(RootOwner::open(&caller_root, &namespaces).unwrap());
    drop(_directory);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn application_close_cancels_bursts_of_partial_open_frames() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let f = Fixture::new().await;
    #[cfg(unix)]
    let path = f._directory.path().join("hello.sock");
    #[cfg(windows)]
    let path = std::path::PathBuf::from(format!(r"\\.\pipe\maka-open-test-{}", Uuid::new_v4()));
    let mut listener = maka_host_runtime::ipc::LocalListener::bind(&path).unwrap();
    let mut clients = Vec::new();
    let mut observers = Vec::new();
    let mut reads = Vec::new();
    for _ in 0..48 {
        let mut client = maka_host_runtime::ipc::connect(&path).await.unwrap();
        let accepted = listener.accept().await.unwrap();
        let (reader, writer) = tokio::io::split(accepted);
        let (read, observed) = tokio::sync::oneshot::channel();
        let mut read = Some(read);
        let reader = tokio_util::io::InspectReader::new(reader, move |bytes| {
            if !bytes.is_empty()
                && let Some(read) = read.take()
            {
                let _ = read.send(());
            }
        });
        reads.push(observed);
        observers.push(f.server.serve(reader, writer, f.peer.clone()).unwrap());
        // Leave a real physical header incomplete. No Scope/Open is admitted.
        client.write_all(&[0]).await.unwrap();
        clients.push(client);
    }
    drop(listener);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        // Closing with unread socket bytes can reset the peer. Observe actual
        // partial-header reads before asserting that cancellation produces EOF.
        for read in reads {
            read.await.unwrap();
        }
        f.server.close().await
    })
    .await
    .unwrap()
    .unwrap();
    for observer in observers {
        assert!(observer.await.is_err());
    }
    for mut client in clients {
        let mut byte = [0];
        assert_eq!(client.read(&mut byte).await.unwrap(), 0);
    }
    assert!(
        f.caller
            .application_intents(f.source.deployment, support::identity(2), 0, 10)
            .await
            .unwrap()
            .is_empty()
    );
    f.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoking_issued_scope_rejects_prepared_commit_without_losing_original_cleanup() {
    let f = Fixture::new().await;
    let (channel, accepted) = tokio::io::duplex(64 * 1024);
    let (reader, writer) = tokio::io::split(accepted);
    let observer = f.server.serve(reader, writer, f.peer.clone()).unwrap();
    let (reader, writer) = tokio::io::split(channel);
    let mut call = Call::new(
        reader,
        writer,
        f.server.catalogue().select("business").unwrap(),
        Source {
            deployment: f.source.clone(),
            consumer: support::identity(2),
            mount: uuid::Uuid::new_v4(),
            request: Uuid::new_v4(),
        },
        "write".into(),
        serde_json::Value::Null,
        Default::default(),
    );
    call.start().await.unwrap();
    assert!(matches!(
        call.receive().await.unwrap(),
        Reply::Prepared { .. }
    ));
    let reference = call.reference().unwrap().clone();
    let intent = f
        .caller
        .record_application_intent(
            f.source.clone(),
            support::identity(2),
            reference.clone(),
            serde_json::Value::Null,
        )
        .await
        .unwrap();
    f.peer.replace(vec![]).unwrap();
    let Reply::Mutation { reply, cleanup } = call.commit(intent).await.unwrap() else {
        panic!("mutation receipt")
    };
    assert_eq!(reply.reference, reference);
    assert!(
        matches!(reply.receipt, maka_plugin_core::operation::Receipt::Unavailable { ref diagnostic } if diagnostic.contains("revoked"))
    );
    cleanup.unwrap();
    assert!(call.cleanup_confirmed());
    assert!(!call.holds_caller_intent());
    assert!(
        f.store
            .operation(&reference)
            .unwrap()
            .operation_observation()
            .await
            .unwrap()
            .is_none()
    );
    drop(call);
    observer.await.unwrap();
    f.server.close().await.unwrap();
    f.cleanup().await;
}

struct HeldChannel {
    stream: DuplexStream,
    written: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
}
impl AsyncRead for HeldChannel {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_read(cx, buffer)
    }
}
impl AsyncWrite for HeldChannel {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match Pin::new(&mut self.stream).poll_write(cx, bytes) {
            Poll::Ready(Ok(count)) => {
                self.written.fetch_add(count, Ordering::SeqCst);
                Poll::Ready(Ok(count))
            }
            other => other,
        }
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}
impl Drop for HeldChannel {
    fn drop(&mut self) {
        self.dropped.fetch_add(1, Ordering::SeqCst);
    }
}
struct HeldConnector {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
    written: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
    physical: Physical,
}
impl maka_transport::transport::native::Connector for HeldConnector {
    fn connect(
        &self,
        _: tokio_util::sync::CancellationToken,
    ) -> futures_util::future::BoxFuture<
        'static,
        Result<maka_transport::transport::native::Stream, String>,
    > {
        let entered = self.entered.clone();
        let release = self.release.clone();
        let written = self.written.clone();
        let dropped = self.dropped.clone();
        let server = self.physical.server.clone();
        let peer = self.physical.peer.clone();
        Box::pin(async move {
            let (stream, accepted) = tokio::io::duplex(64 * 1024);
            let (reader, writer) = tokio::io::split(accepted);
            drop(server.serve(reader, writer, peer)?);
            entered.notify_one();
            release.notified().await;
            Ok(Box::new(HeldChannel {
                stream,
                written,
                dropped,
            }) as maka_transport::transport::native::Stream)
        })
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revocation_during_actual_opening_sends_no_wire_and_closes_original_channel() {
    let f = Fixture::new().await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let written = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::new(AtomicUsize::new(0));
    let (mut ui, connection, _, _) = native_ui(
        &f,
        Arc::new(HeldConnector {
            entered: entered.clone(),
            release: release.clone(),
            written: written.clone(),
            dropped: dropped.clone(),
            physical: Physical {
                server: f.server.clone(),
                peer: f.peer.clone(),
            },
        }),
    )
    .await;
    let root = ui.mount_launch(serde_json::json!({})).unwrap();
    ui.wait_idle().await.unwrap();
    ui.dispatch(
        &root,
        ui.frame(&root).unwrap().revision,
        "read",
        serde_json::Value::Null,
    )
    .unwrap();
    ui.wait_idle().await.unwrap();
    ui.capture_actions(&root, |_| panic!("resource-free action"))
        .unwrap();
    let task = ui.start_task(&root).unwrap().unwrap();
    let id = task.id;
    let worker = tokio::spawn(task.future);
    tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    f.peer.replace(vec![]).unwrap();
    assert!(
        f.peer
            .replace(vec![
                Peer::new(f.source.clone(), BTreeSet::from([support::identity(2)])).unwrap()
            ])
            .is_err()
    );
    release.notify_one();
    let completion = tokio::time::timeout(std::time::Duration::from_secs(5), worker)
        .await
        .unwrap()
        .unwrap();
    assert!(ui.finish_task(id, completion).unwrap().is_none());
    ui.deliver_action_results(&root, |_, _, _| Ok(false))
        .unwrap();
    ui.wait_idle().await.unwrap();
    assert_eq!(
        ui.frame(&root).unwrap().state["outcome"]["status"],
        "failed"
    );
    assert_eq!(written.load(Ordering::SeqCst), 0);
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    stop_ui(ui, &root).await;
    connection.close().await.unwrap();
    drop(connection);
    f.server.close().await.unwrap();
    f.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_caller_preserves_original_mount_across_requests_and_rejects_reopened_view_identity()
{
    let gate = Arc::new(Gate::default());
    let f = Fixture::with_gate(Some(gate.clone())).await;
    let (mut ui, connection, source, service) = native_ui(
        &f,
        Arc::new(Physical {
            server: f.server.clone(),
            peer: f.peer.clone(),
        }),
    )
    .await;
    let root = ui.mount_launch(serde_json::json!({})).unwrap();
    ui.wait_idle().await.unwrap();
    for _ in 0..2 {
        assert_eq!(
            ui_action(&mut ui, &root, "read").await["value"]["effects"],
            0
        );
        let captured = source.lock().unwrap().clone().unwrap();
        assert_eq!(
            maka_transport::transport::native::capture_source(&captured)
                .unwrap()
                .mount,
            root.id()
        );
    }
    ui.retire(&root).unwrap();
    ui.close(&root, Ok(())).unwrap();
    let reopened = ui.mount_launch(serde_json::json!({})).unwrap();
    ui.wait_idle().await.unwrap();
    assert_ne!(root, reopened);
    assert_eq!(
        ui_action(&mut ui, &reopened, "read").await["value"]["effects"],
        0
    );
    {
        let callers = gate.callers.lock().unwrap();
        assert_eq!(callers.len(), 3);
        assert!(callers.iter().all(Option::is_some));
        assert_eq!(callers[0], callers[1]);
        assert_ne!(callers[0], callers[2]);
    }
    stop_ui(ui, &reopened).await;
    connection.close().await.unwrap();
    drop(service);
    drop(connection);
    f.server.close().await.unwrap();
    f.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_caller_uses_actual_peer_approval_and_consumer_not_claimed_json_identity() {
    use maka_transport::transport::Peers;
    let gate = Arc::new(Gate::default());
    let f = Fixture::with_gate(Some(gate.clone())).await;
    let approved = || {
        Peer::new(
            f.source.clone(),
            BTreeSet::from([support::identity(2), support::identity(3)]),
        )
        .unwrap()
    };
    let peer = Peers::new(approved());
    let original = Source {
        deployment: f.source.clone(),
        consumer: support::identity(2),
        mount: Uuid::new_v4(),
        request: Uuid::new_v4(),
    };
    for case in 0..8 {
        let mut source = original.clone();
        source.request = Uuid::new_v4();
        let actual_peer = if case == 4 {
            Peers::new(approved())
        } else {
            peer.clone()
        };
        match case {
            2 => source.consumer = support::identity(3),
            3 => source.mount = Uuid::new_v4(),
            5 => source.consumer = support::identity(4),
            6 => source.deployment.deployment = Uuid::new_v4(),
            7 => source.mount = Uuid::nil(),
            _ => {}
        }
        let (channel, accepted) = tokio::io::duplex(64 * 1024);
        let (reader, writer) = tokio::io::split(accepted);
        let observer = f.server.serve(reader, writer, actual_peer).unwrap();
        let (reader, writer) = tokio::io::split(channel);
        let mut call = Call::new(
            reader,
            writer,
            f.server.catalogue().select("business").unwrap(),
            source,
            "read".into(),
            serde_json::Value::Null,
            Default::default(),
        );
        if case < 5 {
            call.start().await.unwrap();
            match call.receive().await.unwrap() {
                Reply::Finished { result, cleanup } => {
                    result.unwrap();
                    cleanup.unwrap();
                }
                other => panic!("unexpected caller admission: {other:?}"),
            }
        } else {
            assert!(call.start().await.is_err());
        }
        observer.await.unwrap();
        assert!(call.cleanup_confirmed());
    }
    {
        let callers = gate.callers.lock().unwrap();
        assert_eq!(
            callers.len(),
            5,
            "unapproved Source must never reach the Handler"
        );
        assert!(callers.iter().all(Option::is_some));
        assert_eq!(callers[0], callers[1]);
        for different in &callers[2..] {
            assert_ne!(&callers[0], different);
        }
    }
    f.server.close().await.unwrap();
    f.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checked_ui_mutation_progress_cancel_waits_for_original_completion_and_receipt() {
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let gate = Arc::new(Gate {
        progress: true,
        release: Some(release.clone()),
        ..Default::default()
    });
    let f = support::setup(Fixture::with_gate(Some(gate.clone()))).await;
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        let (mut ui, connection, _, _) = native_ui(
            &f,
            Arc::new(Physical {
                server: f.server.clone(),
                peer: f.peer.clone(),
            }),
        )
        .await;
        let root = ui.mount_launch(serde_json::json!({})).unwrap();
        ui.wait_idle().await.unwrap();
        ui.dispatch(
            &root,
            ui.frame(&root).unwrap().revision,
            "write",
            serde_json::Value::Null,
        )
        .unwrap();
        ui.wait_idle().await.unwrap();
        ui.capture_actions(&root, |_| unreachable!()).unwrap();
        let mut task = ui.start_task(&root).unwrap().unwrap();
        loop {
            let completed = task.future.await;
            let progress = matches!(
                &completed,
                maka_ui_runtime::actions::TaskCompletion::MutationProgress { .. }
            );
            task = ui
                .finish_task(task.id, completed)
                .unwrap()
                .expect("operation still running");
            let delivered = ui
                .deliver_action_results(&root, |_, _, _| Ok(false))
                .unwrap();
            if progress {
                assert_eq!(
                    delivered, 1,
                    "original mutation progress must enter the component"
                );
            }
            ui.wait_idle().await.unwrap();
            if ui.frame(&root).unwrap().state["outcome"]["status"] == "updated" {
                break;
            }
        }
        assert!(
            ui.frame(&root).unwrap().state["outcome"]["value"] == wide_progress(),
            "original Unicode mutation progress changed"
        );
        assert_eq!(ui.accepted_action_count(), 1);
        let id = task.id;
        let running = tokio::spawn(task.future);
        ui.dispatch(
            &root,
            ui.frame(&root).unwrap().revision,
            "cancel",
            serde_json::Value::Null,
        )
        .unwrap();
        ui.wait_idle().await.unwrap();
        gate.cancelled.notified().await;
        assert!(
            !running.is_finished(),
            "cancellation must not confirm actual completion"
        );
        assert_eq!(ui.accepted_action_count(), 1);
        release.add_permits(1);
        assert!(
            ui.finish_task(id, running.await.unwrap())
                .unwrap()
                .is_none()
        );
        ui.deliver_action_results(&root, |_, _, _| Ok(false))
            .unwrap();
        ui.wait_idle().await.unwrap();
        let original = ui.frame(&root).unwrap().state["outcome"].clone();
        assert_eq!(original["status"], "operation");
        assert_eq!(
            original["reply"]["receipt"]["outcome"]["value"],
            serde_json::json!({"cancelled":true})
        );
        assert_eq!(original["reply"]["receipt"]["cleanup"]["kind"], "confirmed");
        assert_eq!(
            ui_action(&mut ui, &root, "recover").await["value"],
            original["reply"]
        );
        assert_eq!(
            f.caller
                .application_intents(f.source.deployment, support::identity(2), 0, 10)
                .await
                .unwrap()
                .len(),
            1
        );
        stop_ui(ui, &root).await;
        connection.close().await.unwrap();
        f.server.close().await.unwrap();
        f.cleanup().await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn private_peer_cannot_delegate_its_caller_intent_to_the_host() {
    let f = Fixture::new().await;
    let (channel, accepted) = tokio::io::duplex(64 * 1024);
    let (reader, writer) = tokio::io::split(accepted);
    let observer = f.server.serve(reader, writer, f.peer.clone()).unwrap();
    let (reader, writer) = tokio::io::split(channel);
    let operation = Uuid::new_v4();
    let mut call = Call::new(
        reader,
        writer,
        f.server.catalogue().select("business").unwrap(),
        Source {
            deployment: f.source.clone(),
            consumer: support::identity(2),
            mount: Uuid::new_v4(),
            request: operation,
        },
        "write".into(),
        serde_json::Value::Null,
        Default::default(),
    );
    call.start().await.unwrap();
    assert!(matches!(
        call.receive().await.unwrap(),
        Reply::Prepared { .. }
    ));
    assert!(matches!(
        call.confirm().await.unwrap(),
        Reply::Aborted {
            cleanup: Ok(()),
            ..
        }
    ));
    observer.await.unwrap();
    assert!(
        f.caller
            .application_intent(f.source.deployment, support::identity(2), operation)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        f.store
            .application_intent(
                f.app.source().unwrap().deployment,
                support::identity(13),
                operation
            )
            .await
            .unwrap()
            .is_none()
    );
    assert!(call.cleanup_confirmed());
    drop(call);
    f.server.close().await.unwrap();
    f.cleanup().await;
}
