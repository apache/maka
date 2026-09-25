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
use maka_protocol::{
    session::{copy, sources},
    turn::*,
};
use std::sync::atomic::AtomicBool;

#[derive(Clone, Default)]
struct Preparation {
    revision: maka_plugins::revision::Revision,
    invalidated: Arc<AtomicBool>,
    calls: Arc<AtomicUsize>,
}
impl Plugin for Preparation {
    fn activate(&self, _: PluginContext, _: Value) -> BoxFuture<'static, Result<Staged, String>> {
        let provider = self.clone();
        Box::pin(async move {
            let mut staged = Staged::default();
            staged
                .insert(
                    "example.review",
                    session::SessionBehavior::new(Arc::new(Business::default())),
                )
                .unwrap();
            staged
                .insert(
                    "example.prepare",
                    input::InputPreparation(Arc::new(provider)),
                )
                .unwrap();
            Ok(staged)
        })
    }
}
impl input::Provider for Preparation {
    fn prepare(
        &self,
        mut request: input::Request,
        _: maka_plugins::filesystem::ReadDirectory,
    ) -> BoxFuture<'static, Result<input::Outcome, maka_plugins::Error>> {
        let provider = self.clone();
        Box::pin(async move {
            provider.calls.fetch_add(1, Ordering::SeqCst);
            if request.content.text == "block" {
                return Ok(input::Outcome::Blocked {
                    message: "Input needs correction".into(),
                    receipt: json!({"blocked":true}),
                });
            }
            // Invalidate ONLY the first input's captured basis while preparing
            // the second. Keeping only the last guard would admit stale text.
            if request.content.text == "second"
                && !provider.invalidated.swap(true, Ordering::SeqCst)
            {
                drop(provider.revision.invalidate().await);
            }
            let basis = provider.revision.capture().await;
            request.content.text = format!("{} v{}", request.content.text, basis.version());
            Ok(input::Outcome::Ready {
                content: request.content,
                receipt: json!({"version":basis.version(),"selections":request.selections}),
                required_tools: Default::default(),
                basis: Some(basis),
            })
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn atomic_batch_revalidates_all_sources_and_replays_once_across_revision_and_restart() {
    tokio::time::timeout(Duration::from_secs(45), scenario())
        .await
        .unwrap();
}

async fn scenario() {
    let fixture = ClientFixture::new("maka-batch-");
    let (provider, mut requests) = Provider::controlled().await;
    let model = configure(&fixture, &provider.base_url).await;
    let preparation = Preparation::default();
    let mut original = None;
    let mut original_run = None;
    for reopened in [false, true] {
        let mut plugins = setup(&Business::default());
        plugins.builtins.insert(
            "example".into(),
            Arc::new(Definition {
                id: "example".into(),
                revision: "binary".into(),
                dependencies: vec![],
                inject: vec![],
                plugin: Arc::new(preparation.clone()),
            }),
        );
        let host = Host::open_with_options(
            fixture.owner(),
            None,
            HostOptions {
                plugins,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        #[cfg(unix)]
        let endpoint = fixture.workspace.parent().unwrap().join("batch.sock");
        #[cfg(windows)]
        let endpoint =
            std::path::PathBuf::from(format!(r"\\.\pipe\maka-batch-{}", uuid::Uuid::new_v4()));
        let stop = CancellationToken::new();
        let cleanup = stop.clone().drop_guard();
        let server = tokio::spawn(
            LocalListener::bind(&endpoint)
                .unwrap()
                .serve(host.clone(), stop),
        );
        let (mut peer, hello) = Peer::handshake(host.clone(), "batch").await;
        super::super::skills_plugin::converged(&mut peer).await;
        let (client, _notices) = maka_client::Client::connect(
            maka_client::local::open_stream(&endpoint).await.unwrap(),
            hello["rootId"].as_str().unwrap(),
            hello["hostEpoch"].as_str().unwrap(),
            maka_client::Operations,
        )
        .await
        .unwrap();
        if !reopened {
            let created = peer.rpc("session.create", json!({
                "sessionId":"batch", "workspace":{"kind":"host_path","path":fixture.workspace},
                "modelTarget":{"kind":"explicit","connectionId":model.connection_id,"connectionSlug":model.connection_slug,"model":model.model},
                "orchestrationMode":"example.review"
            })).await;
            assert_eq!(created["ok"], true, "{created}");
            for input in [
                json!({"kind":"begin","sessionId":"batch","uploadId":"file","name":"note.txt","mimeType":"text/plain","totalBytes":1,"contentSha256":maka_runtime::artifact::content_digest(b"x")}),
                json!({"kind":"chunk","sessionId":"batch","uploadId":"file","offset":0,"chunkBase64":"eA=="}),
            ] {
                let result = peer.rpc("artifact.ingest", input).await;
                assert_eq!(result["ok"], true, "{result}");
            }
            let artifact = peer
                .rpc(
                    "artifact.ingest",
                    json!({"kind":"commit","sessionId":"batch","uploadId":"file"}),
                )
                .await;
            assert_eq!(artifact["result"]["kind"], "committed", "{artifact}");
            original = Some(decode_turn_batch_start_input(&json!({
                "sessionId":"batch", "turnId":"turn", "messages":[
                    {"content":{"text":"first", "displayText":"🦀 @a.rs", "attachments":[artifact["result"]["attachment"]],
                        "inlineReferences":[{"kind":"workspace_file","value":"@a.rs","label":"a.rs","start":3}]}, "inputSelections":{"example.prepare":["first"]}},
                    {"content":{"text":"second", "displayText":"🦀 @a.rs", "inlineReferences":[{"kind":"workspace_file","value":"@a.rs","label":"a.rs","start":3}]},"inputSelections":{"example.prepare":["second"]}}
                ]
            })).unwrap());
        }
        let original = original.as_ref().unwrap();
        let started = client.start_turn_batch(original.clone()).await.unwrap();
        let TurnStartResult::Started {
            turn,
            preparation: receipts,
        } = started
        else {
            panic!("batch blocked")
        };
        assert_eq!(receipts.len(), 2);
        assert!(receipts.iter().all(|r| r.receipt["version"] == 1));
        if reopened {
            assert_eq!(Some(turn.run_id), original_run);
            assert_eq!(
                preparation.calls.load(Ordering::SeqCst),
                8,
                "replay must not prepare again"
            );
        } else {
            original_run = Some(turn.run_id.clone());
            let request = requests.recv().await.unwrap();
            assert!(request.body.to_string().contains("first v1"));
            assert!(request.body.to_string().contains("second v1"));
            assert_eq!(preparation.calls.load(Ordering::SeqCst), 4);
            let replay = client.start_turn_batch(original.clone()).await.unwrap();
            assert!(
                matches!(replay, TurnStartResult::Started { turn: replayed, .. } if replayed.run_id == turn.run_id)
            );
            let mut changed = original.clone();
            changed.messages[1].content.text.push('!');
            let conflict = client.start_turn_batch(changed).await.unwrap_err();
            assert!(
                format!("{conflict:?}").contains("OperationConflict"),
                "{conflict:?}"
            );
            request
                .reply
                .send(json!({"index":0,"delta":{"content":"done"},"finish_reason":"stop"}))
                .unwrap();
            completed(&client, "batch", "turn").await;
            let sources = client
                .session_turn_sources(sources::Input {
                    session_id: "batch".into(),
                    turn_id: "turn".into(),
                })
                .await
                .unwrap();
            assert_eq!(sources.messages.len(), 2);
            for (source, message) in sources.messages.iter().zip(&original.messages) {
                assert_eq!(source.content, message.content);
                assert_eq!(source.input_selections, message.input_selections);
            }
            let mut blocked = original.clone();
            blocked.turn_id = "blocked".into();
            blocked.messages[1].content = maka_runtime::input::MessageInput::from("block").into();
            assert!(
                matches!(client.start_turn_batch(blocked).await.unwrap(), TurnStartResult::Blocked { preparation, .. } if preparation.len() == 2)
            );
            let missing = peer
                .rpc(
                    "turn.query",
                    json!({"sessionId":"batch","turnId":"blocked"}),
                )
                .await;
            assert_eq!(missing["error"]["code"], "not_found", "{missing}");
            assert_eq!(provider.requests.lock().unwrap().len(), 1);
            let catalog = peer
                .rpc(
                    "session.catalog.query",
                    json!({"kind":"get","sessionId":"batch"}),
                )
                .await;
            client
                .copy_session(copy::Input {
                    source_session_id: "batch".into(),
                    target_session_id: "revision".into(),
                    expected_source_revision: catalog["result"]["session"]["revision"]
                        .as_u64()
                        .unwrap(),
                    purpose: copy::Purpose::Revision {
                        turn_id: "turn".into(),
                    },
                })
                .await
                .unwrap();
            let copied = client
                .session_turn_sources(sources::Input {
                    session_id: "revision".into(),
                    turn_id: "turn".into(),
                })
                .await
                .unwrap();
            let attachment = &copied.messages[0].content.attachments.as_ref().unwrap()[0];
            assert!(
                matches!(&attachment.storage_ref, StorageRef::SessionFile { session_id, .. } if session_id == "revision")
            );
            let revised = TurnBatchStartInput {
                session_id: "revision".into(),
                turn_id: "revised".into(),
                messages: copied
                    .messages
                    .into_iter()
                    .map(|source| TurnStartMessage {
                        content: source.content,
                        input_selections: source.input_selections,
                    })
                    .collect(),
                turn_orchestration: None,
                max_steps: None,
            };
            assert!(matches!(
                client.start_turn_batch(revised).await.unwrap(),
                TurnStartResult::Started { .. }
            ));
            requests
                .recv()
                .await
                .unwrap()
                .reply
                .send(json!({"index":0,"delta":{"content":"revised"},"finish_reason":"stop"}))
                .unwrap();
            completed(&client, "revision", "revised").await;
            let catalog = peer
                .rpc(
                    "session.catalog.query",
                    json!({"kind":"get","sessionId":"revision"}),
                )
                .await;
            assert_eq!(
                catalog["result"]["session"]["revisionState"], "committed",
                "{catalog}"
            );
        }
        client.disconnect();
        peer.close().await;
        drop(cleanup);
        server.await.unwrap().unwrap();
        drop(host);
    }
    assert_eq!(provider.requests.lock().unwrap().len(), 2);
    let log = fixture.log().await;
    let prefix = log.prefix(1000, 4 * 1024 * 1024).await.unwrap();
    let openings: Vec<_> = prefix
        .events
        .iter()
        .filter_map(|event| match &event.event.fact {
            Fact::InvocationOpened {
                input:
                    maka_runtime::input::InvocationInput::Message {
                        content,
                        source_messages,
                        ..
                    },
                ..
            } => Some((content, source_messages)),
            _ => None,
        })
        .collect();
    assert_eq!(
        openings.len(),
        2,
        "exactly one opening per batch, none for blocked"
    );
    for (content, sources) in openings {
        assert_eq!(sources.len(), 2);
        assert_eq!(content.inline_references.as_ref().unwrap()[1].start, 13);
        assert!(
            sources.iter().all(|source| source.disposition
                == maka_runtime::message::MessageDisposition::TurnStarted)
        );
    }
    log.close().await.unwrap();
}

async fn completed(client: &maka_client::Client, session: &str, turn: &str) {
    loop {
        let turn = client
            .query_turn(TurnQueryInput {
                session_id: session.into(),
                turn_id: turn.into(),
            })
            .await
            .unwrap();
        match turn.state {
            TurnState::Completed { .. } => break,
            TurnState::Failed { .. } | TurnState::Cancelled { .. } => panic!("{turn:?}"),
            _ => tokio::task::yield_now().await,
        }
    }
}
