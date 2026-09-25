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
    support::{client_probe::ClientFixture, message_recovery::Provider, peer::Peer},
};
use maka_runtime_host::server::{Host, local::LocalListener};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const PROVIDER: &str = r#"
export default async function(ctx) {
    let logins = 0;
    await ctx.modelProviders.register('example.account', {
        label: 'Example Account',
        configurationSchema: {type:'object',properties:{baseUrl:{type:'string'}},required:['baseUrl'],additionalProperties:false},
        configurationDefaults: {baseUrl:'https://provider.invalid/v1'},
        authentication: [{id:'key',label:'API key',inputSchema:{type:'object',properties:{key:{type:'string'}},required:['key']},interactive:false}],
        anonymous: false, discovery: true,
    }, {
        resolve: ({model,connection}) => ({
            adapter:'chat-completions',protocol:'openai_chat',baseUrl:connection.configuration.baseUrl,
            info:model,thinkingLevels:[],providerOptions:{},mainOutputLimit:null,
        }),
        authorize: ({credential}) => ({apiKey:credential.secret}),
        authenticate: ({input}) => {
            if (++logins !== 1) throw new Error('authentication replayed');
            return {secret:input.key,refreshAt:null};
        },
        discover: ({credential}) => {
            if (credential.secret !== 'fixture-account-secret') throw new Error('wrong recipient');
            return [{id:'fixture-model',contextWindow:32768,maxOutputTokens:1024}];
        },
        verify: ({credential}) => {
            if (credential.secret !== 'fixture-account-secret') throw new Error('wrong recipient');
        },
    });
}
"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn external_provider_authentication_execution_retirement_and_recovery_share_public_authority()
{
    tokio::time::timeout(Duration::from_secs(60), async {
        for mode in ["shared", "dedicated"] {
            let fixture = ClientFixture::new("maka-provider-directory-");
            let model = Provider::start().await;
            let source = package(&fixture.workspace, "example.account", mode, PROVIDER, false);
            let host = Host::open(fixture.owner()).await.unwrap();
            #[cfg(unix)]
            let endpoint = fixture.workspace.parent().unwrap().join("providers.sock");
            #[cfg(windows)]
            let endpoint = std::path::PathBuf::from(format!(r"\\.\pipe\maka-providers-{}", uuid::Uuid::new_v4()));
            let stop = CancellationToken::new();
            let _cleanup = stop.clone().drop_guard();
            let server = tokio::spawn(LocalListener::bind(&endpoint).unwrap().serve(host.clone(), stop.clone()));
            let mut observer = Peer::new(host.clone(), "provider-catalog-observer").await;
            let mut peer = Peer::new(host, "provider-directory").await;
            ready(&mut peer).await;
            success(peer.rpc("plugin.package.install", json!({"sourcePath":source})).await);
            ready(&mut peer).await;
            let page = success(peer.rpc("model.provider.catalog.query", json!({})).await);
            catalog_changed(&mut observer, &page["revision"]).await;
            let entry = page["entries"].as_array().unwrap().iter()
                .find(|entry| entry["identity"]["packageId"] == "example.account").unwrap();
            let identity = entry["identity"].clone();
            assert_eq!(identity, json!({
                "packageId":"example.account","entryId":"example.account","scope":"profile","name":"example.account",
            }));
            assert_eq!(entry["descriptor"]["authentication"][0]["id"], "key");
            assert_eq!(entry["descriptor"]["configurationDefaults"]["baseUrl"], "https://provider.invalid/v1");
            let revision = page["revision"].clone();
            let input = json!({"attemptId":"external-login", "target":{
                "kind":"create", "provider":identity, "configuration":{"baseUrl":model.base_url},
                "slug":"external", "name":"External"
            }, "authentication":{"method":"key", "input":{"key":"fixture-account-secret"}}});
            let authenticated = login(&mut peer, &input).await;
            let connection_id = authenticated["connection"]["connectionId"].clone();
            assert_eq!(success(peer.rpc("oauth.login.start", input.clone()).await), authenticated);
            let discovered = success(peer.rpc("connection.models.fetch", json!({"connectionId":connection_id})).await);
            assert_eq!(discovered["kind"], "committed", "{discovered}");
            assert_eq!(discovered["modelCount"], 1);
            let catalog = success(peer.rpc("connection.catalog.query", json!({"kind":"start"})).await);
            let row = catalog["items"].as_array().unwrap().iter()
                .find(|row| row["kind"] == "connection" && row["connectionId"] == connection_id).unwrap();
            assert_eq!(row["provider"], identity);
            assert_eq!(row["configuration"], json!({"baseUrl":model.base_url}));
            assert!(!catalog.to_string().contains("fixture-account-secret"));
            let changed = success(peer.rpc("connection.catalog.update", json!({
                "expected":{"connectionId":connection_id,"revision":row["revision"]},
                "changes":{"name":row["name"],"configuration":row["configuration"],"enabled":true,"enabledModelIds":["fixture-model"]}
            })).await);
            assert_eq!(changed["kind"], "committed");
            let verified = success(peer.rpc("connection.test.run", json!({"connectionId":connection_id,"modelId":"fixture-model"})).await);
            assert_eq!(verified["test"]["kind"], "verified", "{verified}");
            success(peer.rpc("session.create", json!({
                "sessionId":"provider", "workspace":{"kind":"host_path","path":fixture.workspace},
                "modelTarget":{"kind":"explicit","connectionId":connection_id,"connectionSlug":"external","model":"fixture-model"}
            })).await);
            turn(&mut peer, "initial", "completed").await;
            for disabled in [true, false] {
                success(peer.rpc("plugin.composition.apply", json!({"operations":[{
                    "type":"update","entryId":"example.account","patch":{"disabled":disabled}
                }]})).await);
                ready(&mut peer).await;
                let stale = success(peer.rpc("model.provider.catalog.query", json!({"revision":revision})).await);
                assert_eq!(stale["kind"], "revision_changed");
                let page = success(peer.rpc("model.provider.catalog.query", json!({})).await);
                catalog_changed(&mut observer, &page["revision"]).await;
                let entry = page["entries"].as_array().unwrap().iter().find(|entry| entry["identity"] == identity);
                assert_eq!(entry.is_none(), disabled);
                assert_eq!(success(peer.rpc("oauth.login.start", input.clone()).await), authenticated,
                    "a durable receipt does not depend on provider availability");
                turn(&mut peer, if disabled { "retired" } else { "restored" }, if disabled { "unavailable" } else { "completed" }).await;
            }
            peer.close().await;
            observer.close().await;
            stop.cancel();
            server.await.unwrap().unwrap();
            // Neither reinstall nor another authorization is needed after restart.
            let host = Host::open(fixture.owner()).await.unwrap();
            let stop = CancellationToken::new();
            let _cleanup = stop.clone().drop_guard();
            let server = tokio::spawn(LocalListener::bind(&endpoint).unwrap().serve(host.clone(), stop.clone()));
            let mut peer = Peer::new(host, "provider-recovery").await;
            ready(&mut peer).await;
            assert_eq!(success(peer.rpc("oauth.login.query", json!({"attemptId":"external-login"})).await), authenticated);
            turn(&mut peer, "reopened", "completed").await;
            assert_eq!(model.requests.lock().unwrap().len(), 3, "retirement cannot select a fallback provider or replay work");
            assert!(model.requests.lock().unwrap().iter().all(|request| request["max_tokens"] == 1024),
                "a plugin's absent request override still respects its advertised output ceiling");
            peer.close().await;
            stop.cancel();
            server.await.unwrap().unwrap();
        }
    }).await.unwrap();
}
async fn catalog_changed(observer: &mut Peer, revision: &Value) {
    loop {
        let frame = observer.frame().await;
        if frame["kind"] == "model.provider.catalog.changed" && frame["revision"] == *revision {
            break;
        }
    }
}
async fn login(peer: &mut Peer, input: &Value) -> Value {
    let mut projection = success(peer.rpc("oauth.login.start", input.clone()).await);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while matches!(
        projection["phase"].as_str(),
        Some("exchanging" | "committing")
    ) {
        assert!(tokio::time::Instant::now() < deadline, "{projection}");
        tokio::time::sleep(Duration::from_millis(10)).await;
        projection = success(
            peer.rpc("oauth.login.query", json!({"attemptId":input["attemptId"]}))
                .await,
        );
    }
    assert_eq!(projection["phase"], "authenticated", "{projection}");
    projection
}
async fn turn(peer: &mut Peer, id: &str, expected: &str) {
    let started = peer.rpc("turn.start", json!({"sessionId":"provider","turnId":id,"content":{"text":"exercise external provider"}})).await;
    if expected == "unavailable" {
        assert_eq!(
            started["error"]["code"], "operation_unavailable",
            "{started}"
        );
        return;
    }
    success(started);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let turn = success(
            peer.rpc("turn.query", json!({"sessionId":"provider","turnId":id}))
                .await,
        );
        if !matches!(
            turn["status"].as_str(),
            Some("admitted" | "created" | "running")
        ) {
            assert_eq!(turn["status"], expected, "{turn}");
            return;
        }
        assert!(tokio::time::Instant::now() < deadline, "{turn}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
fn success(reply: Value) -> Value {
    assert_eq!(reply["ok"], true, "{reply}");
    reply["result"].clone()
}
