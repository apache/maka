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

mod finite;
use maka_client::{Client, RequestFailure};
use maka_protocol::{
    Operation,
    plugin::{RemoteRequest, RemoteResult},
};

async fn fixture() -> (ClientFixture, Arc<Host>, Arc<State>, String) {
    let fixture = ClientFixture::new("maka-observation-lane-");
    let package = Package::new(BTreeMap::from([
        (MANIFEST_FILE.into(), serde_json::to_vec(&json!({"schemaVersion":1,"id":"example.remote","client":{"entry":"client.js","sdkVersion":1}})).unwrap()),
        ("client.js".into(), b"immutable fixture".to_vec()),
    ])).unwrap();
    let state = Arc::new(State::default());
    let mut setup = Setup::default();
    setup.builtins.insert(
        "example.remote".into(),
        Arc::new(Definition {
            id: "example.remote".into(),
            revision: package.digest().into(),
            dependencies: vec![],
            inject: vec![],
            plugin: Arc::new(Example {
                bundle: Bundle::from_package(&package).unwrap().unwrap(),
                state: state.clone(),
            }),
        }),
    );
    setup.layers.insert("example.remote".into(), serde_json::from_value(json!([
        {"type":"insert","rootId":"profile","entry":{"id":"remote-host","packageId":"example.remote"}}
    ])).unwrap());
    let host = Host::open_with_options(
        fixture.owner(),
        None,
        HostOptions {
            plugins: setup,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let (mut peer, hello) = Peer::handshake(host.clone(), "observation-inspector").await;
    ready(&mut peer).await;
    peer.close().await;
    (
        fixture,
        host,
        state,
        hello["hostEpoch"].as_str().unwrap().into(),
    )
}

async fn drain(fixture: &ClientFixture, host: Arc<Host>) {
    #[cfg(unix)]
    let endpoint = fixture.workspace.parent().unwrap().join("drain.sock");
    #[cfg(windows)]
    let endpoint =
        std::path::PathBuf::from(format!(r"\\.\pipe\maka-drain-{}", uuid::Uuid::new_v4()));
    let stop = CancellationToken::new();
    stop.cancel();
    LocalListener::bind(&endpoint)
        .unwrap()
        .serve(host, stop)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn owned_idle_next_waits_do_not_exhaust_same_connection_calls_or_close() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let (fixture, host, state, epoch) = fixture().await;
        let (local, remote) = tokio::io::duplex(1024 * 1024);
        let (reader, writer) = maka_transport::ndjson::split(remote, CancellationToken::new());
        let serving = tokio::spawn({ let host = host.clone(); async move { host.local_owner_connection(reader, writer).await } });
        let (client, mut notices) = Client::connect(local, host.root_id(), &epoch, maka_client::Operations).await.unwrap();
        let observing = tokio::spawn(async move { while notices.recv().await.is_some() {} });
        let RemoteResult::Document { document } = client.plugin_remote(RemoteRequest::OpenDocument).await.unwrap() else { panic!("document") };
        let binding: maka_protocol::plugin::RemoteBinding = serde_json::from_value(json!({"packageId":"example.remote","method":"events","sessionId":null})).unwrap();
        let RemoteResult::Bound { target, .. } = client.plugin_remote(RemoteRequest::Bind { binding: binding.clone() }).await.unwrap() else { panic!("binding") };
        let mut waits = Vec::new();
        let mut streams = Vec::new();
        for _ in 0..96 {
            let RemoteResult::Opened { stream } = client.plugin_remote(RemoteRequest::Open {
                binding: binding.clone(), target: target.clone(), document, input: Value::Null,
            }).await.unwrap() else { panic!("stream") };
            for _ in 0..2 { assert!(matches!(client.plugin_remote(RemoteRequest::Next { document, stream }).await.unwrap(), RemoteResult::Item { .. })); }
            let client = client.clone();
            waits.push(tokio::spawn(async move { client.plugin_remote(RemoteRequest::Next { document, stream }).await }));
            streams.push(stream);
        }
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let changed = state.reads_changed.notified();
                if state.reads.load(Ordering::SeqCst) == 96 { break; }
                changed.await;
            }
        }).await.expect("every owned wait must reach its stream before its ten-second timeout");
        assert!(waits.iter().all(|wait| !wait.is_finished()));
        let duplicate = client.plugin_remote(RemoteRequest::Next { document, stream: streams[0] }).await;
        assert!(matches!(duplicate, Err(RequestFailure::Rejected(_))));
        let invalid = client.plugin_remote(RemoteRequest::Next { document: uuid::Uuid::new_v4(), stream: streams[0] }).await;
        assert!(matches!(invalid, Err(RequestFailure::Rejected(_))));
        let call_binding: maka_protocol::plugin::RemoteBinding = serde_json::from_value(json!({"packageId":"example.remote","method":"echo","sessionId":null})).unwrap();
        let RemoteResult::Bound { target, .. } = client.plugin_remote(RemoteRequest::Bind { binding: call_binding.clone() }).await.unwrap() else { panic!("method") };
        let call = client.plugin_remote(RemoteRequest::Call { binding: call_binding, target, document, input: json!("finite") });
        assert!(matches!(tokio::time::timeout(Duration::from_secs(2), call).await.unwrap().unwrap(), RemoteResult::Value { value } if value["input"] == "finite"));
        assert_eq!(client.request(Operation::HostWake, json!({})).await.unwrap(), json!({}));
        assert!(matches!(tokio::time::timeout(Duration::from_secs(2), client.plugin_remote(RemoteRequest::CloseDocument { document })).await.unwrap().unwrap(), RemoteResult::Closed));
        for wait in waits { assert!(wait.await.unwrap().is_err()); }
        assert_eq!(state.live.load(Ordering::SeqCst), 0);
        client.disconnect();
        serving.await.unwrap().unwrap();
        observing.await.unwrap();
        drain(&fixture, host).await;
    }).await.expect("observation isolation did not settle");
}
