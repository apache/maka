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

use maka_event_log::{
    ROOT_MIGRATIONS,
    root::{RootNamespaces, RootOwner, private_directory},
    root_store::RootStore,
};
use maka_host_runtime::{
    application::{
        host::{
            Channel, Client, Configuration, Host, LifecycleMode, OpenChannel, Options,
            websocket::{self, WebSocketListener},
        },
        logs,
        transport::{GATEWAY, Reply},
    },
    ipc::LocalListener,
};
use maka_packages::Package;
use serde_json::{Value, json};
use std::{collections::BTreeMap, io, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

fn package(id: &str, host: Value) -> Package {
    Package::new(BTreeMap::from([(
        "maka.extension.json".into(),
        serde_json::to_vec(&json!({"schemaVersion":1,"id":id,"application":{"host":host}}))
            .unwrap(),
    )]))
    .unwrap()
}

#[tokio::test]
async fn host_opens_independent_supplied_channels() {
    let dir = tempfile::tempdir().unwrap();
    private_directory(dir.path()).unwrap();
    let root = Arc::new(
        RootOwner::create(
            &dir.path().join("root"),
            &RootNamespaces {
                ownership: dir.path().join("ownership"),
                control: dir.path().join("control"),
            },
        )
        .unwrap(),
    );
    let store = Arc::new(RootStore::open(root, ROOT_MIGRATIONS).await.unwrap());
    let contract = logs::contract();
    let logs = package(
        "test.logs",
        json!({
            "implementation":{"kind":"native","implementation":logs::HOST_LOGS},
            "configuration":{"type":"object"},"imports":{},
            "exports":{"HostLogs":{"contract":contract,"availability":"required"}}
        }),
    );
    let gateway = package(
        "test.gateway",
        json!({
            "implementation":{"kind":"native","implementation":GATEWAY},
            "configuration":{"type":"object"},"exports":{},
            "imports":{"hostLogs":{"contract":contract,"cardinality":{"kind":"one"}}}
        }),
    );
    let consumer = Uuid::new_v4();
    let deployment = Uuid::new_v4();
    store.commit_application(
        deployment, 0,
        serde_json::from_value(json!({"instances":{
            "logs":{"key":Uuid::new_v4(),"package":{"source":"pinned","package":logs.application_ref()},"usePackage":"host"},
            "gateway":{"key":consumer,"package":{"source":"pinned","package":gateway.application_ref()},"usePackage":"host",
                "bindings":{"hostLogs":[{"kind":"instance","path":["logs"],"export":"HostLogs"}]}}
        }})).unwrap(),
        vec![], vec![logs, gateway],
    ).await.unwrap();
    let configuration = Configuration::PublicHost {
        endpoints: serde_json::from_value(json!({
            "hostLogs":{"consumer":[consumer],"import":"hostLogs","grant":{"methods":["read"],"recovery":false}}
        })).unwrap(),
        native: Default::default(),
        product_methods: Default::default(),
    };
    let host = Host::open_with_options(
        store,
        deployment,
        Default::default(),
        None,
        configuration.clone(),
        Options {
            lifecycle_mode: LifecycleMode::Ephemeral,
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let pairing = host
        .prepare_access("test-remote-client".into())
        .await
        .unwrap();
    let epoch = host.epoch();
    #[cfg(unix)]
    let socket = dir.path().join("host.sock");
    #[cfg(windows)]
    let socket = std::path::PathBuf::from(format!(r"\\.\pipe\maka-remote-test-{}", Uuid::new_v4()));
    let local = LocalListener::bind(&socket).unwrap();
    let websocket = WebSocketListener::bind("127.0.0.1:0".parse().unwrap(), vec![])
        .await
        .unwrap();
    let address = websocket.local_addr().unwrap();
    let stop = CancellationToken::new();
    let mut server = tokio::spawn({
        let stop = stop.clone();
        async move { host.serve(local, Some(websocket), stop).await }
    });
    let transport: OpenChannel = Arc::new(move || {
        Box::pin(
            async move { Ok(Box::new(tokio::net::TcpStream::connect(address).await?) as Channel) },
        )
    });
    let client_id: Arc<str> = Uuid::new_v4().to_string().into();
    let bad =
        Client::connect_websocket(transport.clone(), "invalid".into(), client_id.clone(), None)
            .await;
    assert!(matches!(bad, Err(ref error) if error.contains("401")));

    let bearer: Arc<str> = pairing.credential.into();
    // A routine connect cannot accidentally activate a pending credential.
    assert!(
        Client::connect_websocket(transport.clone(), bearer.clone(), client_id.clone(), None)
            .await
            .is_err()
    );
    let opener = websocket::channel_opener(transport.clone(), bearer.clone());
    Client::finalize_access(opener, client_id.clone(), None)
        .await
        .unwrap();
    assert!(
        Client::connect_websocket(
            transport.clone(),
            bearer.clone(),
            client_id.clone(),
            Some(Uuid::new_v4())
        )
        .await
        .is_err()
    );
    let mut client = Client::connect_websocket(transport, bearer, client_id, None)
        .await
        .unwrap();
    assert_eq!(client.epoch(), epoch);
    assert_eq!(client.source().state_domain, pairing.root_id);
    for rejected in [
        client.quit().await,
        client.quit_ephemeral().await,
        client.publication().await.map(|_| ()),
        client
            .configure(
                client.source().clone(),
                configuration.clone(),
                configuration,
            )
            .await,
    ] {
        assert_eq!(
            rejected.unwrap_err(),
            "Host control requires the local owner"
        );
    }
    read_logs_on_independent_channels(&client).await;
    client.close().await.unwrap();
    let status = Client::status(&socket, Some(epoch)).await.unwrap();
    assert!(!status.closing && !status.closed);
    assert_eq!(status.sessions, 0);

    let opener: OpenChannel = Arc::new({
        let socket = socket.clone();
        move || {
            let socket = socket.clone();
            Box::pin(async move {
                Ok(Box::new(
                    maka_host_runtime::ipc::connect(&socket)
                        .await
                        .map_err(io::Error::other)?,
                ) as Channel)
            })
        }
    });
    let mut supplied = Client::connect_on(opener, Some(epoch), None).await.unwrap();
    assert_eq!(supplied.epoch(), epoch);
    supplied.publication().await.unwrap();
    read_logs_on_independent_channels(&supplied).await;
    supplied.quit_ephemeral().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), &mut server)
        .await
        .expect("the last local owner can quit an ephemeral Host")
        .unwrap()
        .unwrap();
}

async fn open_test_host(dir: &std::path::Path) -> (Arc<Host>, Configuration) {
    private_directory(dir).unwrap();
    let root = Arc::new(
        RootOwner::create(
            &dir.join("root"),
            &RootNamespaces {
                ownership: dir.join("ownership"),
                control: dir.join("control"),
            },
        )
        .unwrap(),
    );
    let store = Arc::new(RootStore::open(root, ROOT_MIGRATIONS).await.unwrap());
    let contract = logs::contract();
    let logs = package(
        "test.logs",
        json!({
            "implementation":{"kind":"native","implementation":logs::HOST_LOGS},
            "configuration":{"type":"object"},"imports":{},
            "exports":{"HostLogs":{"contract":contract,"availability":"required"}}
        }),
    );
    let gateway = package(
        "test.gateway",
        json!({
            "implementation":{"kind":"native","implementation":GATEWAY},
            "configuration":{"type":"object"},"exports":{},
            "imports":{"hostLogs":{"contract":contract,"cardinality":{"kind":"one"}}}
        }),
    );
    let consumer = Uuid::new_v4();
    let deployment = Uuid::new_v4();
    store
        .commit_application(
            deployment,
            0,
            serde_json::from_value(json!({"instances":{
                "logs":{"key":Uuid::new_v4(),"package":{"source":"pinned","package":logs.application_ref()},"usePackage":"host"},
                "gateway":{"key":consumer,"package":{"source":"pinned","package":gateway.application_ref()},"usePackage":"host",
                    "bindings":{"hostLogs":[{"kind":"instance","path":["logs"],"export":"HostLogs"}]}}
            }}))
            .unwrap(),
            vec![],
            vec![logs, gateway],
        )
        .await
        .unwrap();
    let configuration = Configuration::PublicHost {
        endpoints: serde_json::from_value(json!({
            "hostLogs":{"consumer":[consumer],"import":"hostLogs","grant":{"methods":["read"],"recovery":false}}
        }))
        .unwrap(),
        native: Default::default(),
        product_methods: Default::default(),
    };
    let host = Host::open_with_options(
        store,
        deployment,
        Default::default(),
        None,
        configuration.clone(),
        Options {
            lifecycle_mode: LifecycleMode::Ephemeral,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    (host, configuration)
}

#[tokio::test]
async fn host_accepts_remote_channels_over_supplied_streams() {
    let dir = tempfile::tempdir().unwrap();
    let (host, _) = open_test_host(dir.path()).await;

    let (dup_tx, dup_rx) = tokio::sync::mpsc::channel(1);
    drop(dup_tx);
    assert!(
        WebSocketListener::from_streams(
            dup_rx,
            vec!["https://maka.local".into(), "https://maka.local".into()],
        )
        .is_err()
    );

    let (stream_tx, stream_rx) = tokio::sync::mpsc::channel::<Channel>(16);
    let websocket = WebSocketListener::from_streams(stream_rx, vec![]).unwrap();
    assert_eq!(
        websocket.local_addr().unwrap_err().kind(),
        io::ErrorKind::AddrNotAvailable
    );
    let pairing = host
        .prepare_access("supplied-stream-client".into())
        .await
        .unwrap();
    let credential_id = pairing.credential_id.clone();
    let epoch = host.epoch();
    let stop = CancellationToken::new();
    let mut server = tokio::spawn({
        let host = host.clone();
        let stop = stop.clone();
        async move { host.serve_remote(websocket, stop).await }
    });

    let transport: OpenChannel = Arc::new({
        let stream_tx = stream_tx.clone();
        move || {
            let stream_tx = stream_tx.clone();
            Box::pin(async move {
                let (client_io, server_io) = tokio::io::duplex(64 * 1024);
                stream_tx
                    .send(Box::new(server_io))
                    .await
                    .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "listener closed"))?;
                Ok(Box::new(client_io) as Channel)
            })
        }
    });

    let client_id: Arc<str> = Uuid::new_v4().to_string().into();
    let bad =
        Client::connect_websocket(transport.clone(), "invalid".into(), client_id.clone(), None)
            .await;
    assert!(matches!(bad, Err(ref error) if error.contains("401")));

    let bearer: Arc<str> = pairing.credential.into();
    let opener = websocket::channel_opener(transport.clone(), bearer.clone());
    Client::finalize_access(opener, client_id.clone(), None)
        .await
        .unwrap();

    let mut client =
        Client::connect_websocket(transport.clone(), bearer.clone(), client_id.clone(), None)
            .await
            .unwrap();
    assert_eq!(client.epoch(), epoch);
    read_logs_on_independent_channels(&client).await;
    client.close().await.unwrap();
    drop(client);

    assert!(host.revoke_access(credential_id).await.unwrap());
    let revoked = Client::connect_websocket(transport, bearer, client_id, None).await;
    assert!(matches!(revoked, Err(ref error) if error.contains("401")));

    // Closing the sole supplied stream ingress drains and shuts down the Host cleanly.
    drop(stream_tx);
    tokio::time::timeout(Duration::from_secs(5), &mut server)
        .await
        .expect("Host drains after supplied stream ingress closes")
        .unwrap()
        .unwrap();
}

async fn read_logs_on_independent_channels(client: &Client) {
    let read = || {
        client.call(
            "hostLogs",
            "read".into(),
            json!({"position":{"kind":"tail"}}),
            Default::default(),
        )
    };
    let (first, second) = tokio::join!(read(), read());
    for mut call in [first.unwrap(), second.unwrap()] {
        call.start().await.unwrap();
        match call.receive().await.unwrap() {
            Reply::Finished { result, cleanup } => {
                cleanup.unwrap();
                let page: maka_host_runtime::logs::HostLogPage =
                    serde_json::from_value(result.unwrap()).unwrap();
                assert_eq!(page, maka_host_runtime::logs::HostLogPage::Missing);
            }
            _ => panic!("HostLogs.read did not finish"),
        }
        call.close().await.unwrap();
    }
}
