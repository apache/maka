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

use maka_host_runtime::{
    HostError,
    application::host::{Host, LifecycleMode, Options, websocket::WebSocketListener},
};
use serde_json::json;
use std::{path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(super) async fn run(
    path: &Path,
    websocket: Option<std::net::SocketAddr>,
    expected_root: Option<&str>,
) -> Result<(), maka_host_runtime::HostError> {
    use maka_event_log::root::{ROOT_MARKER, RootNamespaces, RootOwner};
    let namespaces = RootNamespaces::for_current_account()?;
    let owner = if path.join(ROOT_MARKER).exists() {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            match RootOwner::open(path, &namespaces) {
                Ok(owner) => break owner,
                Err(error)
                    if expected_root.is_some()
                        && error.kind() == std::io::ErrorKind::WouldBlock
                        && tokio::time::Instant::now() < deadline =>
                {
                    // launchd can start the job while its registrar still
                    // holds Root. Admission happens only after acquisition.
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
                Err(error) => return Err(error.into()),
            }
        }
    } else if expected_root.is_none() {
        RootOwner::create(path, &namespaces)?
    } else {
        return Err("service State Root must already be installed".into());
    };
    if expected_root.is_some_and(|expected| expected != owner.root_id()) {
        return Err("service State Root identity changed".into());
    }
    if expected_root.is_none() {
        let logs = maka_host_runtime::logs::Source::from_owner(&owner)?;
        eprintln!("Host diagnostics: {}", logs.path().display());
        crate::logging::capture(logs.open_capture()?)?;
    }
    let deployment = crate::deployment::admit(&owner, crate::deployment::Mode::Supervised).await?;
    if expected_root.is_some() && deployment.is_none() {
        return Err("service State Root must have a supervised deployment".into());
    }
    let websocket = match deployment
        .as_ref()
        .map(|deployment| deployment.websocket)
        .or(websocket)
    {
        Some(address) => Some(WebSocketListener::bind(address, Vec::new()).await?),
        None => None,
    };
    let host = crate::application::open_host(
        owner,
        Options {
            lifecycle_mode: LifecycleMode::Service,
            generation: deployment
                .as_ref()
                .map(|deployment| deployment.generation()),
            ..Default::default()
        },
        deployment
            .as_ref()
            .map(|deployment| {
                crate::application::Roots::Configured(deployment.project_directory_roots.clone())
            })
            .unwrap_or(crate::application::Roots::Saved),
        None,
    )
    .await?;
    serve_product(host, websocket).await
}
async fn serve_product(
    mut product: crate::application::ProductHost,
    websocket: Option<WebSocketListener>,
) -> Result<(), HostError> {
    let result = async {
    let host = &product.host;
    let endpoint = super::endpoint::LocalEndpoint::bind()?;
    let cancellation = CancellationToken::new();
    let _signals = super::signals::watch(cancellation.clone())?;
    let registration = host.publish_registration(
        &endpoint.path,
        websocket
            .as_ref()
            .map(|listener| listener.local_addr())
            .transpose()?,
    )?;
    let mut ready = json!({"kind":"ready","rootId":host.root_id(),"hostEpoch":host.epoch(),"socketPath":endpoint.path});
    if let Some(listener) = &websocket {
        ready["websocketUrl"] = format!("ws://{}/runtime-host", listener.local_addr()?).into();
    }
    println!("{ready}");
    let result = listen(endpoint, websocket, host.clone(), cancellation).await;
    result.and(registration.remove().map_err(Into::into))
    }.await;
    let cleanup = product.shutdown().await;
    result.and(cleanup)
}

pub(super) async fn listen(
    endpoint: super::endpoint::LocalEndpoint,
    websocket: Option<WebSocketListener>,
    host: Arc<Host>,
    cancellation: CancellationToken,
) -> Result<(), HostError> {
    host.serve(endpoint.listener, websocket, cancellation)
        .await
        .map_err(Into::into)
}

pub(super) fn home_directory() -> Result<Option<std::path::PathBuf>, maka_host_runtime::HostError> {
    #[cfg(unix)]
    let instructions = std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(std::path::PathBuf::from);
    #[cfg(windows)]
    let instructions = Some(maka_event_log::root::windows::account_home()?);
    Ok(instructions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_event_log::root::{RootNamespaces, RootOwner};
    use maka_host_runtime::application::{
        Context, Handler, NativeActivation, NativeOwner, NativeRegistry, host::Configuration,
    };
    use std::{
        io::{BufRead, Read, Write},
        process::{Child, Command, Stdio},
        time::{Duration, Instant},
    };

    struct ChildGuard(Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    const CLOSING: &str = "original cleanup is waiting";

    struct CleanupGate(std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>);
    impl Handler for CleanupGate {
        fn call(
            &self,
            _: String,
            input: serde_json::Value,
            _: Context,
        ) -> futures_util::future::BoxFuture<'static, Result<serde_json::Value, String>> {
            Box::pin(async move { Ok(input) })
        }
    }
    impl NativeOwner for CleanupGate {
        fn activated(&self) {
            self.0.lock().unwrap().take().unwrap().send(()).unwrap();
        }
        fn close(&self) -> futures_util::future::BoxFuture<'static, Result<(), String>> {
            let fail = std::env::var("MAKA_LISTEN_CLEANUP_TEST_FAIL").as_deref() == Ok("1");
            Box::pin(async move {
                tokio::task::spawn_blocking(|| {
                    println!("{CLOSING}");
                    std::io::stdout().flush().unwrap();
                    let mut release = [0];
                    std::io::stdin().read_exact(&mut release).unwrap();
                    assert_eq!(release, [1]);
                })
                .await
                .map_err(|error| error.to_string())?;
                if fail {
                    Err("original close failed".into())
                } else {
                    Ok(())
                }
            })
        }
    }

    #[test]
    fn listen_keeps_root_until_blocking_cleanup_finishes() {
        const CHILD_ROOT: &str = "MAKA_LISTEN_CLEANUP_TEST_ROOT";
        if let Some(root) = std::env::var_os(CHILD_ROOT) {
            let runtime = tokio::runtime::Runtime::new().unwrap();
            runtime.block_on(async {
                let owner = RootOwner::create(
                    &std::path::PathBuf::from(root),
                    &RootNamespaces::for_current_account().unwrap(),
                )
                .unwrap();
                let store = Arc::new(maka_transport::open_store(Arc::new(owner)).await.unwrap());
                let deployment = uuid::Uuid::new_v4();
                let contract: maka_plugin_core::contract::Contract = serde_json::from_value(json!({
                    "name":"example.CleanupGate", "version":1, "transport":"remote",
                    "interface":{"kind":"service","methods":{"ping":{
                        "mode":"query","input":{},"output":{},"resources":{}
                    }}}
                }))
                .unwrap();
                let package = |id: &str, implementation: &str, imports, exports| {
                    maka_packages::Package::new(std::collections::BTreeMap::from([(
                        "maka.extension.json".into(),
                        serde_json::to_vec(&json!({
                            "schemaVersion":1,"id":id,"application":{"host":{
                                "implementation":{"kind":"native","implementation":implementation},
                                "configuration":{"type":"object"},"imports":imports,"exports":exports
                            }}
                        })).unwrap(),
                    )]))
                    .unwrap()
                };
                let provider = package(
                    "example.cleanup-gate", "cleanup-gate", json!({}),
                    json!({"ping":{"contract":contract,"availability":"required"}}),
                );
                let consumer = package(
                    "example.cleanup-consumer", "cleanup-consumer",
                    json!({"ping":{"contract":contract,"cardinality":{"kind":"one"}}}),
                    json!({}),
                );
                let consumer_id = uuid::Uuid::new_v4();
                let input = serde_json::from_value(json!({"ui":null,"instances":{
                    "gate":{
                        "key":uuid::Uuid::new_v4(),
                        "package":maka_plugin_core::package::PackageSelection::from(provider.application_ref()),
                        "usePackage":"host"
                    },
                    "consumer":{
                        "key":consumer_id,
                        "package":maka_plugin_core::package::PackageSelection::from(consumer.application_ref()),
                        "usePackage":"host",
                        "bindings":{"ping":[{"kind":"instance","path":["gate"],"export":"ping"}]}
                    }
                }}))
                .unwrap();
                store
                    .commit_application(deployment, 0, input, vec![], vec![provider, consumer])
                    .await
                    .unwrap();
                let (started, ready) = tokio::sync::oneshot::channel();
                let cleanup = Arc::new(CleanupGate(std::sync::Mutex::new(Some(started))));
                let mut native = NativeRegistry::default();
                native
                    .insert(
                        "cleanup-gate".into(),
                        Arc::new(move |_, _| {
                            let owner = cleanup.clone();
                            let contract = contract.clone();
                            Box::pin(async move {
                                NativeActivation {
                                    exports: Ok(std::collections::BTreeMap::from([(
                                        "ping".into(),
                                        maka_plugin_core::runtime::Published {
                                            contract,
                                            value: owner.clone() as Arc<dyn Handler>,
                                        },
                                    )])),
                                    owner,
                                }
                            })
                        }),
                    )
                    .unwrap();
                native
                    .insert(
                        "cleanup-consumer".into(),
                        Arc::new(|_, _| Box::pin(async {
                            NativeActivation {
                                exports: Ok(Default::default()),
                                owner: Arc::new(()),
                            }
                        })),
                    )
                    .unwrap();
                let host = Host::open_with_options(
                    store,
                    deployment,
                    native,
                    None,
                    Configuration::PublicHost {
                        endpoints: std::collections::BTreeMap::from([(
                            "ping".into(),
                            maka_host_runtime::application::transport::HostEndpoint {
                                consumer: maka_plugin_core::composition::InstanceId(vec![consumer_id]),
                                import: "ping".into(),
                                grant: maka_host_runtime::application::transport::Grant {
                                    methods: std::collections::BTreeSet::from(["ping".into()]),
                                    recovery: false,
                                },
                            },
                        )]),
                        native: vec![],
                        product_methods: Default::default(),
                    },
                    Options {
                        lifecycle_mode: LifecycleMode::Service,
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
                ready.await.unwrap();
                let cancellation = CancellationToken::new();
                cancellation.cancel();
                listen(
                    super::super::endpoint::LocalEndpoint::bind().unwrap(),
                    None,
                    host,
                    cancellation,
                )
                .await
                .unwrap();
            });
            drop(runtime);
            return;
        }

        for fail in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().join("root");
            let mut child = ChildGuard(
                Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "serve::tests::listen_keeps_root_until_blocking_cleanup_finishes",
                        "--nocapture",
                    ])
                    .env(CHILD_ROOT, &root)
                    .env(
                        "MAKA_LISTEN_CLEANUP_TEST_FAIL",
                        if fail { "1" } else { "0" },
                    )
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .unwrap(),
            );
            let output = child.0.stdout.take().unwrap();
            let (closing, ready) = std::sync::mpsc::channel();
            let reader = std::thread::spawn(move || {
                for line in std::io::BufReader::new(output).lines() {
                    if line.unwrap() == CLOSING {
                        closing.send(()).unwrap();
                    }
                }
            });
            ready
                .recv_timeout(Duration::from_secs(20))
                .expect("real listener did not reach original blocking cleanup");
            // Surviving the former ten-second process deadline is the regression target.
            std::thread::sleep(Duration::from_secs(11));
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "listener must leave forced termination to its process owner"
            );
            let namespaces = RootNamespaces::for_current_account().unwrap();
            let unavailable = RootOwner::open(&root, &namespaces)
                .err()
                .expect("original blocking cleanup must retain Root");
            assert_eq!(unavailable.kind(), std::io::ErrorKind::WouldBlock);
            child.0.stdin.take().unwrap().write_all(&[1]).unwrap();
            let deadline = Instant::now() + Duration::from_secs(15);
            let status = loop {
                if let Some(status) = child.0.try_wait().unwrap() {
                    break status;
                }
                assert!(Instant::now() < deadline, "released cleanup did not finish");
                std::thread::sleep(Duration::from_millis(10));
            };
            assert_eq!(
                status.success(),
                !fail,
                "released listener exited with {status}"
            );
            reader.join().unwrap();
            drop(RootOwner::open(&root, &namespaces).unwrap());
        }
    }
}
