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
    javascript_plugins::ready,
    support::{
        client_probe::ClientFixture,
        message_recovery::{ModelRequest, Provider, configure},
        peer::Peer,
    },
};
use base64::{Engine, engine::general_purpose::STANDARD};
use maka_plugins::{
    composition::Scope,
    execution::{Progress, Submit},
    fiber::Fiber,
    kernel::Definition,
};
use maka_runtime::{configuration::policy::ChatDefaults, event::InvocationOutcome};
use maka_runtime_host::{
    plugins::Setup,
    server::{Host, HostOptions, local::LocalListener},
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn renamed_recall_finds_archived_unicode_suffix_and_expands_without_echoing_current_turn() {
    tokio::time::timeout(Duration::from_secs(40), scenario())
        .await
        .unwrap();
}
async fn scenario() {
    let fixture = ClientFixture::new("maka-recall-");
    let (provider, mut requests) = Provider::controlled().await;
    let model = configure(&fixture, &provider.base_url).await;
    let config = maka_config::ConfigurationStore::for_root(Arc::new(fixture.owner()))
        .await
        .unwrap();
    let updated = config.update_connection(serde_json::from_value(json!({
        "expected":{"connectionId":model.connection_id,"revision":2},
        "changes":{"name":"Recall fixture","configuration":{"baseUrl":provider.base_url},"enabled":true,
            "enabledModelIds":[model.model],"modelOverrides":{"fixture-model":{"contextWindow":200000,"vision":true}}}
    })).unwrap()).await.unwrap();
    assert!(matches!(
        updated,
        maka_runtime::configuration::CatalogMutationResult::Committed { .. }
    ));
    config
        .set_chat_defaults(
            0,
            ChatDefaults {
                ..Default::default()
            },
        )
        .await
        .unwrap();
    config.close().await.unwrap();
    let source = format!(
        "{}CAFÉ late-needle\n{}",
        "Unrelated background 🦀.\n".repeat(1500),
        "Trailing details.\n".repeat(350)
    );
    let replies = tokio::spawn(async move {
        finish(requests.recv().await.unwrap(), &source);
        reply(
            requests.recv().await.unwrap(),
            "tool_search",
            json!({"query":"Recall RecallMore RecallMaterial"}),
        );
        reply(
            requests.recv().await.unwrap(),
            "Recall",
            json!({"terms":["cafe\u{301}","LATE-NEEDLE"]}),
        );
        let request = requests.recv().await.unwrap();
        let text = latest_tool(&request.body);
        assert!(text.contains("CAFÉ late-needle"), "{text}");
        assert!(text.contains("(source)"), "{text}");
        assert!(
            !text.contains("(search)"),
            "current Turn echoed as corroboration: {text}"
        );
        let anchor = text
            .lines()
            .find_map(|line| line.strip_prefix("Anchor: "))
            .unwrap()
            .to_owned();
        let offset = text
            .lines()
            .find_map(|line| {
                let (_, rest) = line.split_once("next Some(")?;
                rest.split_once(')')?.0.parse::<usize>().ok()
            })
            .unwrap();
        reply(
            request,
            "RecallMore",
            json!({"session_id":"source","anchor_message_id":anchor,"before":0,"after":0,"offset":offset}),
        );
        let request = requests.recv().await.unwrap();
        let text = latest_tool(&request.body);
        assert!(text.contains("Trailing details."), "{text}");
        assert!(!text.contains("Unrelated background"), "{text}");
        reply(request, "Recall", json!({"terms":["historical-upload"]}));
        let request = requests.recv().await.unwrap();
        let text = latest_tool(&request.body);
        let artifact_id = maka_runtime::artifact::upload_artifact_id("source", "text");
        assert!(
            text.contains("historical-upload.txt") && text.contains(&artifact_id),
            "{text}"
        );
        reply(
            request,
            "RecallMaterial",
            json!({"session_id":"source","artifact_id":artifact_id,"offset":1,"limit":1}),
        );
        let request = requests.recv().await.unwrap();
        let page: Value = serde_json::from_str(&latest_tool(&request.body)).unwrap();
        assert_eq!(page["offset"], 1);
        assert_eq!(page["partialLine"], true);
        assert!(
            page["content"]
                .as_str()
                .unwrap()
                .starts_with("Archived attachment evidence")
        );
        assert!(page["content"].as_str().unwrap().len() < 7500);
        assert!(
            page["next"]["path"]
                .as_str()
                .unwrap()
                .contains("maka://read/")
        );
        reply(request, "Read", page["next"].clone());
        let request = requests.recv().await.unwrap();
        assert!(latest_tool(&request.body).contains("evidence-tail"));
        assert!(!latest_tool(&request.body).contains("last line"));
        // Retrying a material copy reuses its immutable destination.
        reply(
            request,
            "RecallMaterial",
            json!({"session_id":"source","artifact_id":artifact_id,"offset":1,"limit":1}),
        );
        let request = requests.recv().await.unwrap();
        assert!(latest_tool(&request.body).contains("Archived attachment evidence"));
        reply(
            request,
            "RecallMaterial",
            json!({"session_id":"source","artifact_id":maka_runtime::artifact::upload_artifact_id("source", "image")}),
        );
        let request = requests.recv().await.unwrap();
        assert!(
            request.body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| {
                    message["role"] == "user"
                        && message["content"].as_array().is_some_and(|parts| {
                            parts.iter().any(|part| part["type"] == "image_url")
                        })
                }),
            "recalled image was not delivered to the model: {}",
            latest_tool(&request.body)
        );
        reply(
            request,
            "RecallMaterial",
            json!({"session_id":"source","artifact_id":maka_runtime::artifact::upload_artifact_id("source", "binary")}),
        );
        let request = requests.recv().await.unwrap();
        assert!(latest_tool(&request.body).contains("binary attachment"));
        finish(request, "Recovered the archived exchange and materials");
    });
    let host = Host::open_with_options(
        fixture.owner(),
        None,
        HostOptions {
            plugins: setup(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    #[cfg(unix)]
    let endpoint = fixture.workspace.parent().unwrap().join("recall.sock");
    #[cfg(windows)]
    let endpoint =
        std::path::PathBuf::from(format!(r"\\.\pipe\maka-recall-{}", uuid::Uuid::new_v4()));
    let stop = CancellationToken::new();
    let cleanup = stop.clone().drop_guard();
    let server = tokio::spawn(
        LocalListener::bind(&endpoint)
            .unwrap()
            .serve(host.clone(), stop),
    );
    let mut peer = Peer::new(host.clone(), "recall").await;
    ready(&mut peer).await;
    for session in ["source", "search"] {
        success(peer.rpc("session.create", json!({
            "sessionId":session,"workspace":{"kind":"host_path","path":fixture.workspace},
            "sandboxMode":"danger-full-access","modelTarget":{"kind":"explicit","connectionId":model.connection_id,"connectionSlug":model.connection_slug,"model":model.model}
        })).await);
    }
    let text = upload(
        &mut peer,
        "text",
        "historical-upload.txt",
        "text/plain",
        format!(
            "first line\nArchived attachment evidence {} evidence-tail\nlast line",
            "x".repeat(11000)
        )
        .as_bytes(),
    )
    .await;
    let png = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=").unwrap();
    let image = upload(
        &mut peer,
        "image",
        "historical-upload.png",
        "image/png",
        &png,
    )
    .await;
    let binary = upload(
        &mut peer,
        "binary",
        "archive.zip",
        "application/zip",
        b"PK\0\0binary",
    )
    .await;
    run(
        &host,
        "source",
        serde_json::from_value(
            json!({"text":"Remember the exchange","attachments":[text,image,binary]}),
        )
        .unwrap(),
    )
    .await;
    success(
        peer.rpc(
            "session.lifecycle.set",
            json!({"sessionId":"source","state":"archived"}),
        )
        .await,
    );
    run(
        &host,
        "search",
        "Find CAFÉ late-needle from earlier history".into(),
    )
    .await;
    replies.await.unwrap();
    assert_eq!(provider.requests.lock().unwrap().len(), 11);
    // A native client calls the renamed plugin without a fabricated UI bundle.
    let binding = json!({"packageId":"z.history","method":"search","sessionId":null});
    let bound = success(
        peer.rpc("plugin.remote", json!({"kind":"bind","binding":binding}))
            .await,
    );
    let document = success(
        peer.rpc("plugin.remote", json!({"kind":"open_document"}))
            .await,
    )["document"]
        .clone();
    let query = json!({"kind":"call","binding":binding,"target":bound["target"],"document":document,"input":{"terms":["historical-upload"],"limit":4}});
    let searched = success(peer.rpc("plugin.remote", query.clone()).await)["value"].clone();
    assert_eq!(searched["complete"], true);
    assert!(searched["matches"].as_array().unwrap().iter().any(|entry| {
        entry["sessionId"] == "source"
            && entry["sequence"]
                .as_u64()
                .is_some_and(|sequence| sequence > 0)
    }));
    success(
        peer.rpc(
            "plugin.composition.apply",
            json!({"operations":[{"type":"update","entryId":"recall","patch":{"disabled":true}}]}),
        )
        .await,
    );
    assert_eq!(
        peer.rpc("plugin.remote", query).await["ok"],
        false,
        "a bound native caller cannot cross retirement"
    );
    success(
        peer.rpc(
            "plugin.remote",
            json!({"kind":"close_document","document":document}),
        )
        .await,
    );
    for upload in ["text", "image", "binary"] {
        success(peer.rpc("artifact.delete", json!({"sessionId":"source","artifactId":maka_runtime::artifact::upload_artifact_id("source", upload)})).await);
    }
    peer.close().await;
    drop(cleanup);
    server.await.unwrap().unwrap();
    let log = fixture.log().await;
    let copies = log.list_artifacts("search", 0, 128).await.unwrap().records;
    let copies: Vec<_> = copies
        .iter()
        .filter(|artifact| artifact.source == maka_runtime::artifact::ArtifactSource::UserUpload)
        .collect();
    assert_eq!(
        copies.len(),
        3,
        "material retry must not create another copy"
    );
    for artifact in copies {
        let content = log
            .read_artifact_chunk("search", &artifact.id, 0, 1024)
            .await
            .unwrap()
            .unwrap()
            .bytes;
        assert!(
            !content.is_empty(),
            "source deletion must not break the copied evidence"
        );
        if artifact.name.ends_with(".txt") {
            assert!(
                String::from_utf8(content)
                    .unwrap()
                    .contains("Archived attachment evidence")
            );
        } else if artifact.name.ends_with(".png") {
            assert_eq!(content, png);
        } else {
            assert_eq!(content, b"PK\0\0binary");
        }
    }
    log.close().await.unwrap();
}
async fn run(host: &Arc<Host>, session: &str, content: maka_runtime::input::MessageInput) {
    let driver = Fiber::new("example.driver", session, Scope::Profile).unwrap();
    driver.begin_loading().unwrap();
    let commands = host
        .authorize_plugin_execution(driver.context(), &[session.into()])
        .await
        .unwrap();
    driver.ready().unwrap();
    driver.publish().unwrap();
    commands
        .submit(Submit {
            orchestration_mode: None,
            operation_id: session.into(),
            session_id: session.into(),
            content,
        })
        .await
        .unwrap();
    loop {
        if let Progress::Ended { outcome } = commands.query(session.into()).await.unwrap().progress
        {
            assert_eq!(outcome, InvocationOutcome::Completed);
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    driver
        .shutdown(tokio::time::Instant::now() + Duration::from_secs(2))
        .await
        .unwrap();
}
async fn upload(peer: &mut Peer, id: &str, name: &str, mime: &str, bytes: &[u8]) -> Value {
    success(peer.rpc("artifact.ingest", json!({"kind":"begin","sessionId":"source","uploadId":id,"name":name,"mimeType":mime,"totalBytes":bytes.len(),"contentSha256":maka_runtime::artifact::content_digest(bytes)})).await);
    success(peer.rpc("artifact.ingest", json!({"kind":"chunk","sessionId":"source","uploadId":id,"offset":0,"chunkBase64":STANDARD.encode(bytes)})).await);
    success(
        peer.rpc(
            "artifact.ingest",
            json!({"kind":"commit","sessionId":"source","uploadId":id}),
        )
        .await,
    )["attachment"]
        .clone()
}
fn latest_tool(body: &Value) -> String {
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .unwrap()["content"]
        .as_str()
        .unwrap()
        .into()
}
fn reply(request: ModelRequest, name: &str, input: Value) {
    request.reply.send(json!({"index":0,"delta":{"tool_calls":[{"index":0,"id":format!("call-{name}"),"type":"function","function":{"name":name,"arguments":input.to_string()}}]},"finish_reason":"tool_calls"})).unwrap();
}
fn finish(request: ModelRequest, text: &str) {
    request
        .reply
        .send(json!({"index":0,"delta":{"content":text},"finish_reason":"stop"}))
        .unwrap();
}
fn success(value: Value) -> Value {
    assert_eq!(value["ok"], true, "{value}");
    value["result"].clone()
}
fn setup() -> Setup {
    let id = "z.history";
    Setup {
        builtins: [(id.into(), Arc::new(Definition { id:id.into(), revision:"binary".into(), dependencies:vec![], inject:vec![], plugin:Arc::new(maka_assistant::recall::Builtin) }))].into(),
        layers: [(id.into(), vec![
            serde_json::from_value(json!({"type":"remove","entryId":"maka.recall"})).unwrap(),
            serde_json::from_value(json!({"type":"insert","rootId":"profile","entry":{"id":"recall","packageId":id}})).unwrap(),
        ])].into(), ..Default::default()
    }
}
