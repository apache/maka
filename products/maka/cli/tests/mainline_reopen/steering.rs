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
use maka_mock_ai::{
    ControlPlaneConfig, FinishReason, MockAiBuilder, ModelEntry, NormalizedRequest, Protocol,
    TurnContext, TurnEvent, TurnPlan, Usage,
};
use std::sync::atomic::AtomicUsize;

async fn steering(prefix: bool) {
    let provider = if prefix { "openai" } else { "anthropic" };
    let model = if prefix {
        "gpt-4.1"
    } else {
        "claude-sonnet-4-5"
    };
    let protocol = if prefix {
        "openai-responses"
    } else {
        "anthropic-messages"
    };
    let sandbox = Sandbox::new().await.unwrap();
    let (requests, mut received) = mpsc::unbounded_channel();
    let count = Arc::new(AtomicUsize::new(0));
    let retired_first = CancellationToken::new();
    let retired_second = CancellationToken::new();

    let server = {
        let requests = requests.clone();
        let count = count.clone();
        let retired_first = retired_first.clone();
        let retired_second = retired_second.clone();
        MockAiBuilder::new()
            .control(ControlPlaneConfig {
                models: vec![ModelEntry::simple(model)],
                ..Default::default()
            })
            .handler_fn(move |req: &NormalizedRequest, _ctx: &TurnContext| {
                let body = req.raw_body.clone();
                let prompt = body.to_string();
                if prefix {
                    assert_eq!(
                        req.protocol,
                        Protocol::OpenaiResponsesWs,
                        "Responses conversation must use its primary WebSocket transport"
                    );
                    let main =
                        prompt.contains("steering-original") || prompt.contains("effect-result");
                    if !main {
                        return TurnPlan::new()
                            .with_response_id("warmup")
                            .push_text("Ready.")
                            .with_usage(Usage::new(10, 3))
                            .finish(FinishReason::Stop);
                    }
                    let phase = count.fetch_add(1, Ordering::SeqCst);
                    requests.send(body.clone()).unwrap();
                    match phase {
                        0 => {
                            let command = "printf 'once\n' >> steering-effects.log && while [ ! -f release-steering-tool ]; do sleep 0.05; done && printf 'effect-result'";
                            TurnPlan::new()
                                .with_response_id("held-response")
                                .with_on_close(retired_first.clone())
                                .push_text("accepted-prefix")
                                .push_tool_call(
                                    "steering-effect",
                                    "Shell",
                                    json!({ "command": command }),
                                )
                                .push(TurnEvent::Stall)
                        }
                        1 => {
                            assert!(prompt.contains("steering-correction"), "{body}");
                            TurnPlan::new()
                                .with_response_id("held-continuation")
                                .with_on_close(retired_second.clone())
                                .push_stream_start()
                                .push(TurnEvent::Stall)
                        }
                        2 => {
                            assert!(prompt.contains("steering-final"), "{body}");
                            TurnPlan::new()
                                .with_response_id("corrected-response")
                                .push_text("Corrected answer.")
                                .with_usage(Usage::new(10, 3))
                                .finish(FinishReason::Stop)
                        }
                        _ => panic!("original request was repeated: {body}"),
                    }
                } else {
                    assert_eq!(req.protocol, Protocol::AnthropicMessages);
                    if !prompt.contains("steering-original") {
                        return TurnPlan::new()
                            .with_response_id("steering")
                            .push_text("Ready.")
                            .with_usage(Usage::new(10, 3))
                            .finish(FinishReason::Stop);
                    }
                    count.fetch_add(1, Ordering::SeqCst);
                    requests.send(body).unwrap();
                    if prompt.contains("steering-correction") {
                        TurnPlan::new()
                            .with_response_id("steering")
                            .push_text("Corrected answer.")
                            .with_usage(Usage::new(10, 3))
                            .finish(FinishReason::Stop)
                    } else {
                        TurnPlan::stall()
                    }
                }
            })
            .start()
            .await
            .unwrap()
    };

    let base = server.base_url();
    // Seed before Host startup so public catalog refresh cannot race the fixture's CAS.
    let connection = {
        let root = sandbox.root.clone();
        let owner = tokio::task::spawn_blocking(move || {
            maka_event_log::root::RootOwner::create(
                &root,
                &maka_event_log::root::RootNamespaces::for_current_account().unwrap(),
            )
            .unwrap()
        })
        .await
        .unwrap();
        let store = maka_config::ConfigurationStore::for_root(Arc::new(owner))
            .await
            .unwrap();
        let created = store
            .create_connection(
                serde_json::from_value(json!({
                    "expectedCatalogRevision": 0,
                    "connection": {
                        "slug": "steering",
                        "name": "Steering loopback",
                        "provider": {
                            "packageId": "maka.providers",
                            "entryId": "maka.providers",
                            "scope": "profile",
                            "name": provider
                        },
                        "configuration": { "baseUrl": base },
                        "enabled": true,
                        "enabledModelIds": [model],
                        "modelOverrides": {
                            (model): { "codeMode": false, "apiProtocol": protocol }
                        }
                    }
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        store.shutdown().await.unwrap();
        let maka_agent_facts::configuration::CatalogMutationResult::Committed {
            connection: Some(connection),
            ..
        } = created
        else {
            panic!("fixture connection was not committed: {created:?}");
        };
        connection.connection_id
    };
    let mut host = Host::spawn(&sandbox).unwrap();
    let (mut client, _) = host.ready().await.unwrap();

    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(45), async {
        let detail = call(
            &client,
            "settings",
            "connection",
            json!({"connectionId":connection}),
            Attachments::new(),
        )
        .await;
        let secret: Arc<dyn ReadResource> = Arc::new(FixtureKey);
        let saved = call(
            &client,
            "settings",
            "saveCredential",
            json!({"expected":detail["target"],"expectedCredential":null}),
            Attachments::from([("secret".into(), secret)]),
        )
        .await;
        assert_eq!(saved["kind"], "saved");
        let mut session_input = json!({"title":"Steering stream","automaticTitle":false,"labels":[],"tools":["Shell"],"workspace":{"kind":"directory","path":sandbox.workspace},"backend":{"kind":"model","connectionId":connection,"modelId":model,"thinkingLevel":null}});
        let created = call(
            &client,
            "agent",
            "create",
            session_input.clone(),
            Attachments::new(),
        )
        .await;
        assert_eq!(created["kind"], "created", "{created}");
        let session = created["session"]["id"].as_str().unwrap();
        let sent = call(
            &client,
            "agent",
            "send",
            json!({"sessionId":session,"message":"steering-original","delivery":"queue"}),
            Attachments::new(),
        )
        .await;
        assert!(
            matches!(sent["kind"].as_str(), Some("started" | "queued")),
            "original send rejected: {sent}"
        );
        let original = match tokio::time::timeout(Duration::from_secs(5), received.recv()).await {
            Ok(Some(body)) => body,
            other => {
                let current = work(
                    &client,
                    session,
                    json!({"kind":"message","messageId":sent["messageId"]}),
                    None,
                )
                .await;
                panic!("original provider request missing: {other:?}; work={current}");
            }
        };
        assert!(!original.to_string().contains("steering-correction"));

        if prefix {
            loop {
                if let Ok(output) =
                    tokio::fs::read_to_string(sandbox.workspace.join("steering-effects.log")).await
                {
                    assert_eq!(output, "once\n");
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        let original = work(
            &client,
            session,
            json!({"kind":"message","messageId":sent["messageId"]}),
            None,
        )
        .await;
        let run = original["execution"]["runId"].clone();
        let correction = call(
            &client,
            "agent",
            "send",
            json!({"sessionId":session,"message":"steering-correction","delivery":"steer","expectedRunId":run}),
            Attachments::new(),
        )
        .await;
        assert_eq!(correction["kind"], "queued", "{correction}");
        if prefix {
            retired_first.cancelled().await;
            assert!(
                received.try_recv().is_err(),
                "continuation must wait for the admitted tool"
            );

            session_input["title"] = json!("Independent stream");
            let peer = call(&client, "agent", "create", session_input, Attachments::new()).await;
            assert_eq!(peer["kind"], "created", "{peer}");
            let peer_session = peer["session"]["id"].as_str().unwrap();
            let peer_sent = call(
                &client,
                "agent",
                "send",
                json!({"sessionId":peer_session,"message":"independent-request","delivery":"queue"}),
                Attachments::new(),
            )
            .await;
            assert!(
                matches!(peer_sent["kind"].as_str(), Some("started" | "queued")),
                "independent send rejected: {peer_sent}"
            );
            let peer_result = work(
                &client,
                peer_session,
                json!({"kind":"message","messageId":peer_sent["messageId"]}),
                Some("completed"),
            )
            .await;
            assert_ne!(peer_result["execution"]["runId"], run);
            assert!(
                received.try_recv().is_err(),
                "the independent Run must complete before releasing the admitted tool"
            );

            tokio::fs::write(sandbox.workspace.join("release-steering-tool"), b"")
                .await
                .unwrap();
        }
        let corrected = received.recv().await.unwrap();
        let messages = corrected.to_string();
        assert_eq!(messages.matches("steering-original").count(), 1);
        assert_eq!(messages.matches("steering-correction").count(), 1);
        if prefix {
            assert!(messages.contains("effect-result"), "{messages}");
            assert!(messages.contains("accepted-prefix"), "{messages}");

            let correction = call(
                &client,
                "agent",
                "send",
                json!({"sessionId":session,"message":"steering-final","delivery":"steer","expectedRunId":run}),
                Attachments::new(),
            )
            .await;
            assert_eq!(correction["kind"], "queued", "{correction}");
            retired_second.cancelled().await;
            let final_request = received.recv().await.unwrap().to_string();
            assert_eq!(final_request.matches("steering-original").count(), 1);
            assert_eq!(final_request.matches("steering-correction").count(), 1);
            assert_eq!(final_request.matches("steering-final").count(), 1);
            assert!(
                final_request.find("steering-correction").unwrap()
                    < final_request.find("steering-final").unwrap(),
                "{final_request}"
            );
            assert!(final_request.contains("effect-result"), "{final_request}");
            assert!(final_request.contains("accepted-prefix"), "{final_request}");
        }
        let completed = work(
            &client,
            session,
            json!({"kind":"run","runId":run}),
            Some("completed"),
        )
        .await;
        assert_eq!(completed["execution"]["runId"], run);
        let expected_outcomes = if prefix {
            vec![json!("aborted"), json!("aborted"), json!("success")]
        } else {
            vec![json!("aborted"), json!("success")]
        };
        assert_eq!(
            count.load(Ordering::SeqCst),
            expected_outcomes.len(),
            "original requests must not be replayed"
        );
        let queue = call(
            &client,
            "agent",
            "queue",
            json!({"sessionId":session}),
            Attachments::new(),
        )
        .await;
        assert_eq!(queue["entries"], json!([]));
        if prefix {
            assert_eq!(
                tokio::fs::read_to_string(sandbox.workspace.join("steering-effects.log"))
                    .await
                    .unwrap(),
                "once\n"
            );
        }
        host.quit(&mut client).await.unwrap();
        let facts = identities(&sandbox, session, &run).await;
        let outcomes: Vec<_> = facts
            .iter()
            .filter(|fact| fact["kind"] == "model_closed")
            .map(|fact| fact["outcome"].clone())
            .collect();
        assert_eq!(outcomes, expected_outcomes);
        let attempts: Vec<_> = facts
            .iter()
            .filter(|fact| fact["kind"] == "model_attempt_prepared")
            .collect();
        assert_eq!(attempts.len(), expected_outcomes.len());
        for attempt in attempts {
            assert!(
                facts.iter().any(|fact| {
                    fact["kind"] == "model_cleanup_observed"
                        && fact["attempt"] == attempt["attempt"]
                        && fact["cleanup"]["kind"] == "confirmed"
                }),
                "{facts:?}"
            );
        }
    }))
    .catch_unwind()
    .await;
    server.shutdown().await;
    host.cleanup().await.unwrap();
    match result {
        Ok(result) => {
            result.expect("steering must continue without waiting for the original model finish")
        }
        Err(payload) => std::panic::resume_unwind(payload),
    }
}

#[tokio::test]
async fn steering_cancels_pre_output_stream_and_continues_on_same_run() {
    steering(false).await;
}

#[tokio::test]
async fn steering_after_admitted_prefix_waits_for_tool_and_continues_on_same_run() {
    steering(true).await;
}
