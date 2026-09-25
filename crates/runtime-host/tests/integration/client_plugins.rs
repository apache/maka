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

use super::support::{client_probe::ClientFixture, peer::Peer};
use maka_runtime_host::server::{Host, local::LocalListener};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn client_bundles_follow_publication_not_disk_or_intent_and_fence_reload_and_restart() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let fixture = ClientFixture::new("maka-client-plugin-");
        let path = fixture.workspace.join("package");
        std::fs::create_dir(&path).unwrap();
        let source = format!("/*{}*/ export default () => {{}};", "🦀中\\\"".repeat(9000));
        std::fs::write(path.join("client.mjs"), &source).unwrap();
        std::fs::write(path.join("host.mjs"), "throw new Error('desktop-ui must not execute Host entrypoint')").unwrap();
        std::fs::write(path.join("maka.extension.json"), serde_json::to_vec(&json!({
            "schemaVersion":1,"id":"example.client",
            "runtime":{"entry":"host.mjs","sdkVersion":1},
            "client":{"entry":"client.mjs","sdkVersion":1}
        })).unwrap()).unwrap();
        let mut previous = None;
        for reopened in [false, true] {
            let host = Host::open(fixture.owner()).await.unwrap();
            #[cfg(unix)]
            let endpoint = fixture.workspace.parent().unwrap().join("client-plugin.sock");
            #[cfg(windows)]
            let endpoint = std::path::PathBuf::from(format!(r"\\.\pipe\maka-client-plugin-{}", uuid::Uuid::new_v4()));
            let stop = CancellationToken::new();
            let cleanup = stop.clone().drop_guard();
            let server = tokio::spawn(LocalListener::bind(&endpoint).unwrap().serve(host.clone(), stop.clone()));
            let mut peer = Peer::new(host.clone(), "client-plugin").await;
            let mut observer = Peer::new(host.clone(), "client-plugin-observer").await;
            ready(&mut peer).await;
            if !reopened {
                let empty = success(peer.rpc("plugin.client.query", json!({"kind":"snapshot"})).await);
                success(peer.rpc("plugin.package.install", json!({"sourcePath":path})).await);
                ready(&mut peer).await;
                let incompatible = peer.rpc("plugin.composition.apply", json!({"operations":[{
                    "type":"insert","rootId":"profile","entry":{"id":"unsupported-host","packageId":"example.client"}
                }]})).await;
                assert_eq!(incompatible["ok"], false, "{incompatible}");
                assert!(incompatible["error"]["message"].as_str().unwrap().contains("SDK"), "{incompatible}");
                assert_eq!(success(peer.rpc("plugin.client.query", json!({"kind":"snapshot"})).await)["revision"], empty["revision"]);
                let entries: Vec<_> = (0..40).map(|index| json!({
                    "type":"insert","rootId":"desktop-ui","entry":{
                        "id":format!("view-{index:02}"),"packageId":"example.client","config":{"index":index}
                    }
                })).collect();
                success(peer.rpc("plugin.composition.apply", json!({"operations":entries})).await);
                ready(&mut peer).await;
                std::fs::write(path.join("client.mjs"), "uninstalled local edits must not leak into a bundle").unwrap();
            }
            if let Some(stale) = &previous {
                let response = peer.rpc("plugin.client.query", bundle(stale, 0)).await;
                assert_eq!(response["error"]["code"], "operation_conflict", "{response}");
            }
            let page = success(peer.rpc("plugin.client.query", json!({"kind":"snapshot"})).await);
            assert_eq!(page["entries"].as_array().unwrap().len(), 32);
            let second = success(peer.rpc("plugin.client.query", json!({"kind":"snapshot","cursor":page["nextCursor"]})).await);
            let entries: Vec<_> = page["entries"].as_array().unwrap().iter()
                .chain(second["entries"].as_array().unwrap())
                .filter(|entry| entry["extensionId"] == "example.client")
                .map(|entry| entry["entryId"].as_str().unwrap().to_owned()).collect();
            assert_eq!(entries, (0..40).map(|index| format!("view-{index:02}")).collect::<Vec<_>>());
            assert!(second["nextCursor"].is_null());
            assert_eq!(page["revision"], second["revision"]);
            let entry = page["entries"].as_array().unwrap().iter().find(|entry| entry["entryId"] == "view-00").unwrap().clone();
            assert_eq!(entry["config"], json!({"index":0}));
            assert_eq!(entry["sdkVersion"], 1);
            let mut offset = 0;
            let mut downloaded = String::new();
            loop {
                let chunk = success(peer.rpc("plugin.client.query", bundle(&entry, offset)).await);
                assert_eq!(chunk["offset"], offset);
                downloaded.push_str(chunk["content"].as_str().unwrap());
                match chunk["nextOffset"].as_u64() {
                    Some(next) => { assert!(next as usize > offset); offset = next as usize; }
                    None => break,
                }
            }
            assert_eq!(downloaded, source);
            let invalid = peer.rpc("plugin.client.query", bundle(&entry, 3)).await;
            assert_eq!(invalid["error"]["code"], "invalid_request", "{invalid}");
            success(peer.rpc("plugin.composition.apply", json!({"operations":[{
                "type":"update","entryId":"view-00","patch":{"disabled":true}
            }]})).await);
            ready(&mut peer).await;
            let stale = peer.rpc("plugin.client.query", bundle(&entry, 0)).await;
            assert_eq!(stale["error"]["code"], "operation_conflict", "{stale}");
            let stale = peer.rpc("plugin.client.query", json!({"kind":"snapshot","cursor":page["nextCursor"]})).await;
            assert_eq!(stale["error"]["code"], "stale_cursor", "{stale}");
            success(peer.rpc("plugin.composition.apply", json!({"operations":[{
                "type":"update","entryId":"view-00","patch":{"disabled":false}
            }]})).await);
            ready(&mut peer).await;
            let next = success(peer.rpc("plugin.client.query", json!({"kind":"snapshot"})).await);
            loop {
                let notice = observer.frame().await;
                if notice["kind"] == "plugin.client.changed" && notice["revision"] == next["revision"] { break; }
            }
            let next = next["entries"].as_array().unwrap().iter().find(|entry| entry["entryId"] == "view-00").unwrap();
            assert_ne!(next["activation"], entry["activation"]);
            assert_eq!(next["clientDigest"], entry["clientDigest"]);
            previous = Some(next.clone());
            peer.close().await;
            observer.close().await;
            stop.cancel();
            tokio::time::timeout(Duration::from_secs(10), server).await.unwrap().unwrap().unwrap();
            cleanup.disarm();
            drop(host);
        }
    }).await.expect("client publication and retirement must make bounded progress");
}
fn success(response: Value) -> Value {
    assert_eq!(response["ok"], true, "{response}");
    response["result"].clone()
}
fn bundle(entry: &Value, offset: usize) -> Value {
    json!({"kind":"bundle","entryId":entry["entryId"],"activation":entry["activation"],"clientDigest":entry["clientDigest"],"offset":offset})
}
async fn ready(peer: &mut Peer) {
    loop {
        let result = success(
            peer.rpc("plugin.platform.query", json!({"view":"status"}))
                .await,
        );
        if result["convergence"] == "converged" {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
