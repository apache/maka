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

use super::{
    javascript_plugins::{package, ready},
    support::{
        client_probe::ClientFixture,
        message_recovery::{Provider, configure},
        peer::Peer,
    },
};
use futures_util::{SinkExt, StreamExt};
use maka_config::ConfigurationStore;
use maka_runtime_host::server::{Host, local::LocalListener};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn external_model_adapters_use_host_io_confirm_settled_tools_and_retire_without_fallback() {
    tokio::time::timeout(Duration::from_secs(60), async {
        for mode in ["shared", "dedicated"] {
            let fixture = ClientFixture::new("maka-model-adapter-");
            let provider = Provider::start().await;
            let model = configure(&fixture, &provider.base_url).await;
            let configuration = ConfigurationStore::for_root(Arc::new(fixture.owner())).await.unwrap();
            let row = configuration.catalog().await.unwrap().connections.remove(0);
            let changed = configuration.update_connection(serde_json::from_value(json!({
                "expected":{"connectionId":row.connection_id, "revision":row.revision},
                "changes":{"name":row.name, "configuration":row.configuration, "enabled":true,
                    "enabledModelIds":row.enabled_model_ids, "modelOverrides":{"fixture-model":{"contextWindow":200000,"adapter":"example.protocol"}}}
            })).unwrap()).await.unwrap();
            assert!(matches!(changed, maka_runtime::configuration::CatalogMutationResult::Committed { .. }));
            configuration.close().await.unwrap();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("ws://{}/responses", listener.local_addr().unwrap());
            let socket = tokio::spawn(async move {
                let (tcp, _) = listener.accept().await.unwrap();
                let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
                for step in 0..2 {
                    let frame = ws.next().await.unwrap().unwrap();
                    assert_eq!(frame.to_text().unwrap(), format!("step:{step}"));
                    ws.send(frame).await.unwrap();
                }
                // The run owns the adapter session, not the plugin instance.
                let frame = ws.next().await;
                assert!(!matches!(frame, Some(Ok(tokio_tungstenite::tungstenite::Message::Text(_)))));
            });
            let source = include_str!("../fixtures/model-adapter.mjs").replace("__WEBSOCKET__", &url);
            let package = package(&fixture.workspace, "example.model", mode, &source, false);
            let host = Host::open(fixture.owner()).await.unwrap();
            #[cfg(unix)]
            let endpoint = fixture.workspace.parent().unwrap().join("model.sock");
            #[cfg(windows)]
            let endpoint = std::path::PathBuf::from(format!(r"\\.\pipe\maka-model-{}", uuid::Uuid::new_v4()));
            let stop = CancellationToken::new();
            let _cleanup = stop.clone().drop_guard();
            let server = tokio::spawn(LocalListener::bind(&endpoint).unwrap().serve(host.clone(), stop.clone()));
            let mut peer = Peer::new(host.clone(), "model-plugin").await;
            ready(&mut peer).await;
            let installed = peer.rpc("plugin.package.install", json!({"sourcePath":package})).await;
            assert_eq!(installed["ok"], true, "{installed}");
            ready(&mut peer).await;
            let created = peer.rpc("session.create", json!({
                "sessionId":"adapter", "workspace":{"kind":"host_path","path":fixture.workspace},
                "modelTarget":{"kind":"explicit","connectionId":model.connection_id,"connectionSlug":model.connection_slug,"model":model.model}
            })).await;
            assert_eq!(created["ok"], true, "{created}");
            for (turn, expected) in [("first", "completed"), ("retired", "failed")] {
                if turn == "retired" {
                    let disabled = peer.rpc("plugin.composition.apply", json!({
                        "operations":[{"type":"update","entryId":"example.model","patch":{"disabled":true}}]
                    })).await;
                    assert_eq!(disabled["ok"], true, "{disabled}");
                    ready(&mut peer).await;
                }
                let started = peer.rpc("turn.start", json!({"sessionId":"adapter","turnId":turn,"content":{"text":"exercise adapter"}})).await;
                if turn == "retired" {
                    assert_eq!(started["error"]["code"], "operation_unavailable", "{started}");
                    assert_eq!(peer.rpc("turn.query", json!({"sessionId":"adapter","turnId":turn})).await["error"]["code"], "not_found");
                    continue;
                }
                assert_eq!(started["ok"], true, "{started}");
                loop {
                    let state = peer.rpc("turn.query", json!({"sessionId":"adapter","turnId":turn})).await;
                    assert_eq!(state["ok"], true, "{state}");
                    if !matches!(state["result"]["status"].as_str(), Some("admitted" | "created" | "running")) {
                        assert_eq!(state["result"]["status"], expected, "{state}");
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }
            socket.await.unwrap();
            assert_eq!(provider.requests.lock().unwrap().len(), 2, "retirement must not fall back to SDK");
            peer.close().await;
            stop.cancel();
            server.await.unwrap().unwrap();
        }
    }).await.unwrap();
}
