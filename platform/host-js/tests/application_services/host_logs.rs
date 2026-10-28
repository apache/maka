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
use maka_event_log::{
    root::{RootNamespaces, RootOwner},
    root_store::RootStore,
};
use maka_host_runtime::{
    application::{
        host::{Client, Configuration, Host},
        transport::{Grant as EndpointGrant, HostEndpoint, wire::Reply},
    },
    ipc::LocalListener,
};
use std::io::Write;

fn sources() -> (Input, Vec<Package>) {
    let contract = maka_host_runtime::application::logs::contract();
    let logs = package(
        "test.host.logs",
        EntryDeclaration {
            implementation: Implementation::Native {
                implementation: "maka.host.logs".into(),
            },
            configuration: json!({"type":"object","additionalProperties":false}).into(),
            imports: BTreeMap::new(),
            exports: BTreeMap::from([(
                "HostLogs".into(),
                Export {
                    contract: contract.clone(),
                    availability: Availability::Required,
                },
            )]),
        },
        None,
    );
    let consumer = package(
        "test.host.logs.client",
        EntryDeclaration {
            implementation: Implementation::JavaScript {
                module: "host.mjs".into(),
                realm: Realm::Dedicated,
            },
            configuration: json!({"type":"object"}).into(),
            exports: BTreeMap::new(),
            imports: BTreeMap::from([(
                "logs".into(),
                Import {
                    contract,
                    cardinality: Cardinality::One,
                },
            )]),
        },
        Some("export function activate(){return {}; }".into()),
    );
    let broken = package(
        "test.host.logs.unrelated",
        EntryDeclaration {
            implementation: Implementation::JavaScript {
                module: "host.mjs".into(),
                realm: Realm::Dedicated,
            },
            configuration: json!({"type":"object"}).into(),
            imports: BTreeMap::new(),
            exports: BTreeMap::new(),
        },
        Some(
            "export function activate(){throw new Error('unrelated business initializer failed');}"
                .into(),
        ),
    );
    let mut client = node(&consumer, 2, true);
    client.bindings = BTreeMap::from([(
        "logs".into(),
        vec![Target::Instance {
            path: vec!["logs".into()],
            export: "HostLogs".into(),
        }],
    )]);
    (
        Input {
            ui: None,
            instances: BTreeMap::from([
                ("logs".into(), node(&logs, 1, true)),
                ("client".into(), client),
                ("unrelated".into(), node(&broken, 3, true)),
            ]),
        },
        vec![logs, consumer, broken],
    )
}

#[tokio::test]
async fn fixed_root_logs_public_endpoint_survives_unrelated_initialization_failure() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let directory = tempfile::tempdir().unwrap();
        let namespaces = RootNamespaces {
            ownership: directory.path().join("owners"),
            control: directory.path().join("control"),
        };
        let owner =
            Arc::new(RootOwner::create(&directory.path().join("root"), &namespaces).unwrap());
        let mut capture = maka_host_runtime::logs::Source::from_owner(&owner)
            .unwrap()
            .open_capture()
            .unwrap();
        capture.write_all(b"before\n").unwrap();
        capture.flush().unwrap();
        let store = Arc::new(RootStore::open(owner).await.unwrap());
        let (input, packages) = sources();
        let source = store
            .commit_application(Uuid::new_v4(), 0, input, vec![], packages)
            .await
            .unwrap();
        let host = Host::open(
            store.clone(),
            source.deployment,
            NativeRegistry::default(),
            Some(maka_host_js::factory(Limits::default())),
            Configuration::PublicHost {
                endpoints: [("logs", vec!["read", "watch"]), ("readOnly", vec!["read"])]
                    .into_iter()
                    .map(|(name, methods)| {
                        (
                            name.into(),
                            HostEndpoint {
                                consumer: id(2),
                                import: "logs".into(),
                                grant: EndpointGrant {
                                    methods: methods.into_iter().map(str::to_owned).collect(),
                                    recovery: false,
                                },
                            },
                        )
                    })
                    .collect(),
                native: vec![],
                product_methods: Default::default(),
            },
        )
        .await
        .unwrap();
        let ipc = directory.path().join("ipc");
        maka_event_log::root::private_directory(&ipc).unwrap();
        let address = ipc.join("host.sock");
        let listener = LocalListener::bind(&address).unwrap();
        let stop = CancellationToken::new();
        let served = {
            let host = host.clone();
            let stop = stop.clone();
            tokio::spawn(async move { host.serve_local(listener, stop).await })
        };
        let mut client = Client::connect(&address, Some(host.epoch())).await.unwrap();
        let startup_error = client.catalogue().startup_error().map(str::to_owned);
        let observed = async {
            let read = query(&client, "logs", json!({"position":{"kind":"tail"}})).await?;
            let path_error = query(
                &client,
                "logs",
                json!({"position":{"kind":"tail"},"path":"/ungranted/private.log"}),
            )
            .await
            .err();
            let mut denied = client
                .call(
                    "readOnly",
                    "watch".into(),
                    json!({"position":{"kind":"tail"}}),
                    Attachments::new(),
                )
                .await?;
            // Method grants reject before resource reservation; start consumes
            // that terminal Aborted reply and returns its reason directly.
            let denied_reason = denied
                .start()
                .await
                .err()
                .ok_or("ungranted watch unexpectedly reserved resources")?;
            denied.close().await?;
            if !denied.cleanup_confirmed() {
                return Err("rejected watch cleanup unconfirmed".into());
            }
            let mut watch = subscribe(&client, json!({"position":{"kind":"tail"}})).await?;
            let initial = item(&mut watch).await?;
            capture
                .write_all(b"after\n")
                .map_err(|error| error.to_string())?;
            capture.flush().map_err(|error| error.to_string())?;
            let appended = item(&mut watch).await?;
            watch.close().await?;
            if !watch.cleanup_confirmed() {
                return Err("watch cancellation did not confirm physical cleanup".into());
            }
            let cursor = appended["cursor"].clone();
            client.close().await?;
            client = Client::connect(&address, Some(host.epoch())).await?;
            capture
                .write_all(b"reconnect\n")
                .map_err(|error| error.to_string())?;
            capture.flush().map_err(|error| error.to_string())?;
            let mut resumed = subscribe(
                &client,
                json!({"position":{"kind":"after","cursor":cursor}}),
            )
            .await?;
            let reconnected = item(&mut resumed).await?;
            resumed.close().await?;
            if !resumed.cleanup_confirmed() {
                return Err("reconnected watch cleanup unconfirmed".into());
            }
            Ok::<_, String>((
                read,
                initial,
                appended,
                reconnected,
                denied_reason,
                path_error,
            ))
        }
        .await;
        client.close().await.unwrap();
        stop.cancel();
        served.await.unwrap().unwrap();
        host.shutdown().await.unwrap();
        drop(host);
        let store = Arc::try_unwrap(store)
            .unwrap_or_else(|_| panic!("Host cleanup retained the original RootStore"));
        store.close().await.unwrap();
        let (read, initial, appended, reconnected, denied_reason, path_error) = observed.expect(
            "explicitly granted public HostLogs must read and follow the original Root capture",
        );
        assert_eq!(read["kind"], "data");
        assert_eq!(read["bytes"], "YmVmb3JlCg==");
        assert_eq!(read["reset"], Value::Null);
        assert_eq!(read["truncated"], false);
        assert_eq!(read["hasMore"], false);
        assert_eq!(initial["bytes"], "YmVmb3JlCg==");
        assert_eq!(appended["bytes"], "YWZ0ZXIK");
        assert_eq!(reconnected["bytes"], "cmVjb25uZWN0Cg==");
        assert_eq!(reconnected["reset"], Value::Null);
        assert_eq!(denied_reason, "Application method is not granted");
        assert!(path_error.is_some(), "request fields cannot choose a path");
        assert!(
            startup_error
                .unwrap()
                .contains("unrelated business initializer failed")
        );
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn failed_startup_retirement_waits_for_cleanup_without_blocking_session_admission() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let directory = tempfile::tempdir().unwrap();
        let namespaces = RootNamespaces {
            ownership: directory.path().join("owners"),
            control: directory.path().join("control"),
        };
        let root = directory.path().join("root");
        let owner = Arc::new(RootOwner::create(&root, &namespaces).unwrap());
        let root_id = owner.root_id().to_owned();
        let store = Arc::new(RootStore::open(owner).await.unwrap());
        let mut provider = entry(
            true,
            Implementation::Native {
                implementation: "native.echo".into(),
            },
            MethodMode::Query,
        );
        provider.exports.get_mut("echo").unwrap().contract.transport = Transport::Remote;
        let provider = package("native", provider, None);
        let mut consumer = entry(
            false,
            Implementation::JavaScript {
                module: "host.mjs".into(),
                realm: Realm::Shared,
            },
            MethodMode::Query,
        );
        consumer.imports.get_mut("echo").unwrap().contract.transport = Transport::Remote;
        let consumer = package(
            "consumer",
            consumer,
            Some("export function activate() { return {}; }".into()),
        );
        let source = store
            .commit_application(
                Uuid::new_v4(),
                0,
                input(&provider, &consumer),
                vec![],
                vec![provider, consumer],
            )
            .await
            .unwrap();
        let closing = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let mut native = NativeRegistry::default();
        native
            .insert(
                "native.echo".into(),
                Arc::new({
                    let closing = closing.clone();
                    let release = release.clone();
                    move |_, _| {
                        let closing = closing.clone();
                        let release = release.clone();
                        Box::pin(async move {
                            NativeActivation {
                                exports: Err("original initializer rejected".into()),
                                owner: native_owner(move || {
                                    let closing = closing.clone();
                                    let release = release.clone();
                                    Box::pin(async move {
                                        closing.add_permits(1);
                                        permit(&release).await;
                                        Ok(())
                                    })
                                }),
                            }
                        })
                    }
                }),
            )
            .unwrap();
        let host = Host::open(
            store.clone(),
            source.deployment,
            native,
            Some(maka_host_js::factory(Limits::default())),
            Configuration::PublicHost {
                endpoints: BTreeMap::from([(
                    "echo".into(),
                    HostEndpoint {
                        consumer: id(2),
                        import: "echo".into(),
                        grant: EndpointGrant {
                            methods: ["echo".to_owned()].into_iter().collect(),
                            recovery: false,
                        },
                    },
                )]),
                native: vec![],
                product_methods: Default::default(),
            },
        )
        .await
        .unwrap();
        permit(&closing).await;
        let ipc = directory.path().join("ipc");
        maka_event_log::root::private_directory(&ipc).unwrap();
        let address = ipc.join("host.sock");
        let listener = LocalListener::bind(&address).unwrap();
        let served = {
            let host = host.clone();
            tokio::spawn(async move { host.serve_local(listener, CancellationToken::new()).await })
        };
        let mut client = Client::connect(&address, Some(host.epoch())).await.unwrap();
        assert!(
            client
                .catalogue()
                .startup_error()
                .unwrap()
                .contains("original initializer rejected")
        );
        client.close().await.unwrap();
        assert_eq!(host.status().sessions, 0);
        let mut second = {
            let retirement = host.retire(false, false);
            tokio::pin!(retirement);
            let (early, admitted) = tokio::select! {
                biased;
                result = &mut retirement => (Some(result), None),
                result = Client::connect(&address, Some(host.epoch())) => (None, Some(result)),
            };
            // Release original cleanup even when the old production path returns early.
            release.add_permits(1);
            assert!(
                early.is_none(),
                "retirement returned before failed native cleanup settled: {early:?}"
            );
            let second = admitted.unwrap().unwrap();
            assert!(
                !retirement.await.unwrap(),
                "a newly admitted session must refuse retirement"
            );
            second
        };
        assert!(!host.status().closing);
        assert_eq!(host.status().sessions, 1);
        assert!(RootOwner::open(&root, &namespaces).is_err());
        second.close().await.unwrap();
        assert!(host.retire(false, false).await.unwrap());
        served.await.unwrap().unwrap();
        assert!(host.status().closed);
        drop(host);
        let store = Arc::try_unwrap(store)
            .unwrap_or_else(|_| panic!("Host cleanup retained the original RootStore"));
        store.close().await.unwrap();
        assert_eq!(
            RootOwner::open(&root, &namespaces).unwrap().root_id(),
            root_id
        );
    })
    .await
    .unwrap();
}

async fn query(client: &Client, endpoint: &str, input: Value) -> Result<Value> {
    let mut call = client
        .call(endpoint, "read".into(), input, Attachments::new())
        .await?;
    call.start().await?;
    let reply = call.receive().await?;
    call.close().await?;
    match reply {
        Reply::Finished { result, cleanup } => {
            cleanup?;
            result
        }
        other => Err(format!("unexpected log query reply: {other:?}")),
    }
}
async fn subscribe(
    client: &Client,
    input: Value,
) -> Result<maka_host_runtime::application::host::LocalCall> {
    let mut call = client
        .call("logs", "watch".into(), input, Attachments::new())
        .await?;
    call.start().await?;
    let reply = call.receive().await?;
    if !matches!(reply, Reply::Subscribed) {
        call.close().await?;
        return Err(format!("unexpected log subscription reply: {reply:?}"));
    }
    Ok(call)
}
async fn item(call: &mut maka_host_runtime::application::host::LocalCall) -> Result<Value> {
    match call.pull().await? {
        Reply::Item { value } => Ok(value),
        other => Err(format!("unexpected log subscription item: {other:?}")),
    }
}
