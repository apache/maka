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
mod authority;
mod fixture;
mod lifecycle;
use fixture::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn managed_native_input_preserves_identity_content_queue_and_restart_proof() {
    tokio::time::timeout(Duration::from_secs(45), native())
        .await
        .unwrap();
}
async fn native() {
    let fixture = ClientFixture::new("maka-managed-native-");
    let (provider, mut requests) = Provider::controlled().await;
    let model = configure(&fixture, &provider.base_url).await;
    fixture::seed(&fixture, &model).await;
    let (pauses, _paused) = tokio::sync::mpsc::unbounded_channel();
    let javascript = super::super::javascript_plugins::package(
        &fixture.workspace,
        "example.javascript",
        "shared",
        r#"
export default async function(ctx) {
    await ctx.behaviors.register('example.javascript', () => ({}), { nativeInput: 'native_user_messages' });
}
"#,
        false,
    );
    let mut saved = None;
    let mut accepted = None;
    for reopened in [false, true] {
        // The fixture retains a Publisher for dynamic registration tests. Its
        // Catalog pins Host admission/storage, so it belongs to one Host lifetime.
        let manager = Manager::new(pauses.clone());
        let host = Host::open_with_options(
            fixture.owner(),
            None,
            HostOptions {
                plugins: fixture::setup(&manager),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        #[cfg(unix)]
        let endpoint = fixture.workspace.parent().unwrap().join("managed.sock");
        #[cfg(windows)]
        let endpoint =
            std::path::PathBuf::from(format!(r"\\.\pipe\maka-managed-{}", uuid::Uuid::new_v4()));
        let stop = CancellationToken::new();
        let cleanup = stop.clone().drop_guard();
        let server = tokio::spawn(
            LocalListener::bind(&endpoint)
                .unwrap()
                .serve(host.clone(), stop),
        );
        let (mut peer, hello) = Peer::handshake(host.clone(), "managed-input").await;
        peer.wait_for_plugins().await;
        if reopened {
            let replay = peer
                .rpc("turn.message.submit", saved.clone().unwrap())
                .await;
            assert_eq!(Some(submitted(&replay)), accepted, "{replay}");
            assert_eq!(
                availability(&mut peer, "managed").await,
                "managed_unavailable"
            );
        } else {
            assert_eq!(availability(&mut peer, "managed").await, "managed_native");
            assert_eq!(availability(&mut peer, "ordinary").await, "ordinary");
            for session in ["denied", "plan", "wrong-owner", "wrong-scope", "executor"] {
                assert_eq!(
                    availability(&mut peer, session).await,
                    "managed_unavailable"
                );
                let response = peer
                    .rpc(
                        "turn.message.submit",
                        submit(
                            &hello["hostEpoch"],
                            session,
                            "rejected",
                            "hello",
                            "current_turn",
                        ),
                    )
                    .await;
                assert_eq!(
                    response["error"]["code"], "operation_unavailable",
                    "{response}"
                );
            }
            let mut override_input = submit(
                &hello["hostEpoch"],
                "managed",
                "override",
                "hello",
                "current_turn",
            );
            override_input["turnOrchestration"] = json!({"mode":"default","source":"host_api"});
            let rejected = peer.rpc("turn.message.submit", override_input).await;
            assert_eq!(
                rejected["error"]["code"], "operation_unavailable",
                "{rejected}"
            );
            for input in [
                json!({"kind":"begin","sessionId":"managed","uploadId":"note","name":"note.txt","mimeType":"text/plain","totalBytes":1,"contentSha256":maka_runtime::artifact::content_digest(b"x")}),
                json!({"kind":"chunk","sessionId":"managed","uploadId":"note","offset":0,"chunkBase64":"eA=="}),
            ] {
                let result = peer.rpc("artifact.ingest", input).await;
                assert_eq!(result["ok"], true, "{result}");
            }
            let artifact = peer
                .rpc(
                    "artifact.ingest",
                    json!({"kind":"commit","sessionId":"managed","uploadId":"note"}),
                )
                .await;
            assert_eq!(artifact["result"]["kind"], "committed", "{artifact}");
            let mut input = submit(
                &hello["hostEpoch"],
                "managed",
                "original-user-id",
                "full input",
                "current_turn",
            );
            input["content"] = json!({"text":"full input","displayText":"🦀 @a.rs","attachments":[artifact["result"]["attachment"]],
                "inlineReferences":[{"kind":"workspace_file","value":"@a.rs","label":"a.rs","start":3}]});
            input["inputSelections"] = json!({"example.prepare":["selected"]});
            let result = peer.rpc("turn.message.submit", input.clone()).await;
            let accepted_result = submitted(&result);
            let SubmitResult::TurnStarted {
                turn_id,
                preparation,
            } = &accepted_result
            else {
                panic!("expected a canonical opening: {accepted_result:?}");
            };
            assert_eq!(
                preparation[0].receipt["selections"]["example.prepare"],
                json!(["selected"])
            );
            let request = requests.recv().await.unwrap();
            for (field, replacement) in [
                ("content", json!({"text":"changed"})),
                ("inputSelections", json!({"example.prepare":["changed"]})),
            ] {
                let mut conflict = input.clone();
                conflict[field] = replacement;
                let conflict = peer.rpc("turn.message.submit", conflict).await;
                assert_eq!(
                    conflict["error"]["code"], "operation_conflict",
                    "{conflict}"
                );
            }
            let mut conflict = input.clone();
            conflict["placement"] = json!("next_turn");
            conflict.as_object_mut().unwrap().remove("inputSelections");
            let conflict = peer.rpc("turn.message.submit", conflict).await;
            assert_eq!(
                conflict["error"]["code"], "operation_conflict",
                "{conflict}"
            );
            for (id, placement) in [("steer", "current_turn"), ("followup", "next_turn")] {
                let queued = submit(&hello["hostEpoch"], "managed", id, id, placement);
                let first = peer.rpc("turn.message.submit", queued.clone()).await;
                let first = submitted(&first);
                assert!(
                    matches!(
                        (placement, &first),
                        (
                            "current_turn",
                            SubmitResult::Steering {
                                queue_revision: Some(_),
                                ..
                            }
                        ) | (
                            "next_turn",
                            SubmitResult::Followup {
                                queue_revision: Some(_),
                                ..
                            }
                        )
                    ),
                    "{first:?}"
                );
                assert_eq!(
                    submitted(&peer.rpc("turn.message.submit", queued).await),
                    first
                );
            }
            // Retraction keeps its existing authority even on a managed Session.
            let cancelled = peer.rpc("queue.retract", json!({"originHostEpoch":hello["hostEpoch"],"sessionId":"managed","retractId":"cancel-queue"})).await;
            assert_eq!(cancelled["ok"], true, "{cancelled}");
            request
                .reply
                .send(json!({"index":0,"delta":{"content":"done"},"finish_reason":"stop"}))
                .unwrap();
            complete(&mut peer, "managed", &json!(turn_id)).await;
            saved = Some(input.clone());
            accepted = Some(accepted_result);
            let installed = peer
                .rpc("plugin.package.install", json!({"sourcePath":javascript}))
                .await;
            assert_eq!(installed["ok"], true, "{installed}");
            peer.wait_for_plugins().await;
            assert_eq!(
                availability(&mut peer, "javascript").await,
                "managed_native"
            );
            let js = peer
                .rpc(
                    "turn.message.submit",
                    submit(
                        &hello["hostEpoch"],
                        "javascript",
                        "js-user-id",
                        "generic JS owner",
                        "next_turn",
                    ),
                )
                .await;
            let SubmitResult::TurnStarted { turn_id, .. } = submitted(&js) else {
                panic!("expected a canonical JavaScript-owned opening: {js}");
            };
            requests
                .recv()
                .await
                .unwrap()
                .reply
                .send(json!({"index":0,"delta":{"content":"JS done"},"finish_reason":"stop"}))
                .unwrap();
            complete(&mut peer, "javascript", &json!(turn_id)).await;
            let disabled = peer.rpc("plugin.composition.apply", json!({"operations":[{"type":"update","entryId":"example","patch":{"disabled":true}}]})).await;
            assert_eq!(disabled["ok"], true, "{disabled}");
            peer.wait_for_plugins().await;
            assert_eq!(
                availability(&mut peer, "managed").await,
                "managed_unavailable"
            );
            assert_eq!(
                submitted(
                    &peer
                        .rpc("turn.message.submit", saved.clone().unwrap())
                        .await
                ),
                accepted.clone().unwrap()
            );
        }
        peer.close().await;
        drop(cleanup);
        server.await.unwrap().unwrap();
        drop(host);
        drop(manager);
    }
    // EventLog owns a writer lease even for reads. Inspect immutable proof only
    // after both real Host lifetimes have completed their storage drain.
    let log = fixture.log().await;
    let proof = log
        .root_message("managed", "original-user-id")
        .await
        .unwrap()
        .unwrap();
    let original: maka_protocol::message::SubmitInput =
        serde_json::from_value(saved.unwrap()).unwrap();
    let content: maka_runtime::input::MessageInput = original.content.into();
    assert_eq!(proof.source().unprepared_content, content);
    assert_eq!(proof.source().message.message_id, "original-user-id");
    log.close().await.unwrap();
}
