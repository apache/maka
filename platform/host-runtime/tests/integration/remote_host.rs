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
            Channel, Client, Configuration, Host, WebSocketStreamOpener,
            websocket::WebSocketListener,
        },
        logs,
        transport::GATEWAY,
    },
    ipc::LocalListener,
};
use maka_packages::Package;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
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
async fn remote_host_opens_independent_websocket_channels() {
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
    let host = Host::open(store, deployment, Default::default(), None, Configuration::PublicHost {
        endpoints: serde_json::from_value(json!({
            "hostLogs":{"consumer":[consumer],"import":"hostLogs","grant":{"methods":["read"],"recovery":false}}
        })).unwrap(),
        native: Default::default(),
        product_methods: Default::default(),
    }).await.unwrap();

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
    let server = tokio::spawn({
        let stop = stop.clone();
        async move { host.serve(local, Some(websocket), stop).await }
    });
    // Stand in for one peer endpoint: each call returns a fresh byte stream.
    let opened = Arc::new(AtomicUsize::new(0));
    let opener: WebSocketStreamOpener = Arc::new({
        let opened = opened.clone();
        move || {
            opened.fetch_add(1, Ordering::Relaxed);
            Box::pin(async move {
                Ok(Box::new(
                    tokio::net::TcpStream::connect(address)
                        .await
                        .map_err(|e| e.to_string())?,
                ) as Channel)
            })
        }
    });
    let client_id: Arc<str> = Uuid::new_v4().to_string().into();
    let bad =
        Client::connect_websocket(opener.clone(), "invalid".into(), client_id.clone(), epoch).await;
    assert!(matches!(bad, Err(ref error) if error.contains("401")));
    let mut client = Client::connect_websocket(opener, pairing.credential.into(), client_id, epoch)
        .await
        .unwrap();
    assert_eq!(client.epoch(), epoch);
    let (first, second) = tokio::join!(client.open_call_channel(), client.open_call_channel());
    let (first, second) = (first.unwrap(), second.unwrap());
    assert_eq!(opened.load(Ordering::Relaxed), 5);
    drop((first, second));
    client.quit_ephemeral().await.unwrap();
    assert_eq!(
        Client::status(&socket, Some(epoch)).await.unwrap().sessions,
        0
    );

    stop.cancel();
    server.await.unwrap().unwrap();
}
