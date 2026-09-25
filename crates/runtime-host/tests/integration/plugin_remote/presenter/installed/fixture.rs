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
use crate::support::client_probe::ClientFixture;
use maka_runtime_host::server::{Host, local::LocalListener};
use tokio_util::sync::CancellationToken;

pub(super) struct Scene {
    pub fixture: ClientFixture,
    pub host: Arc<Host>,
    pub peer: Peer,
    stop: CancellationToken,
    _cleanup: tokio_util::sync::DropGuard,
    server: tokio::task::JoinHandle<Result<(), maka_runtime_host::server::HostError>>,
}
impl Scene {
    pub async fn new() -> Self {
        let fixture = ClientFixture::new("maka-installed-presenter-");
        let package = fixture.workspace.join("plugin");
        std::fs::create_dir(&package).unwrap();
        std::fs::write(
            package.join("host.mjs"),
            include_str!("../../../../fixtures/presenter-host.mjs"),
        )
        .unwrap();
        std::fs::write(package.join("bad.mjs"), [255]).unwrap();
        std::fs::write(
            package.join("ui.mjs"),
            include_str!("../../../../fixtures/presenter-ui.mjs"),
        )
        .unwrap();
        std::fs::write(package.join("maka.extension.json"), json!({"schemaVersion":1,"id":PACKAGE,"runtime":{"entry":"host.mjs","sdkVersion":2,"vm":"dedicated"}}).to_string()).unwrap();
        let host = Host::open(fixture.owner()).await.unwrap();
        #[cfg(unix)]
        let endpoint = fixture.workspace.parent().unwrap().join("presenter.sock");
        #[cfg(windows)]
        let endpoint =
            std::path::PathBuf::from(format!(r"\\.\pipe\presenter-{}", uuid::Uuid::new_v4()));
        let stop = CancellationToken::new();
        let server = tokio::spawn(
            LocalListener::bind(&endpoint)
                .unwrap()
                .serve(host.clone(), stop.clone()),
        );
        let mut peer = Peer::new(host.clone(), "presenter-installed").await;
        success(
            peer.rpc("plugin.package.install", json!({"sourcePath":package}))
                .await,
        );
        success(peer.rpc("plugin.composition.apply", json!({"operations":[{"type":"insert","rootId":"profile","entry":{"id":PACKAGE,"packageId":PACKAGE}}]})).await);
        ready(&mut peer).await;
        let cleanup = stop.clone().drop_guard();
        Self {
            fixture,
            host,
            peer,
            stop,
            server,
            _cleanup: cleanup,
        }
    }
    pub async fn close(self) {
        self.peer.close().await;
        self.stop.cancel();
        self.server.await.unwrap().unwrap();
    }
}
pub(super) async fn bind(peer: &mut Peer, method: &str) -> (Value, Value) {
    let binding = json!({"packageId":PACKAGE,"method":method,"sessionId":null});
    let target = rpc(peer, json!({"kind":"bind","binding":binding})).await["target"].clone();
    (binding, target)
}
pub(super) async fn document(peer: &mut Peer) -> Value {
    rpc(peer, json!({"kind":"open_document"})).await["document"].clone()
}
pub(super) fn call(binding: &Value, target: &Value, document: &Value, input: Value) -> Value {
    json!({"kind":"call","binding":binding,"target":target,"document":document,"input":input})
}
pub(super) fn read(route: Value) -> Value {
    json!({"kind":"read","route":route,"locale":"zh-TW"})
}
pub(super) fn submit(operation: &str, action: &str) -> Value {
    json!({"kind":"submit","route":{"operation":operation},"revision":"original-revision","action":action,"fields":{"note":"original secret"},"grant":null,"locale":"zh-CN"})
}
pub(super) fn model(reply: Value) -> Value {
    serde_json::from_str(
        reply["value"]["view"]["root"]["spans"][0]["text"]
            .as_str()
            .unwrap(),
    )
    .unwrap()
}
pub(super) async fn stats(peer: &mut Peer, stats: &(Value, Value), document: &Value) -> Value {
    rpc(peer, call(&stats.0, &stats.1, document, Value::Null)).await["value"].clone()
}
