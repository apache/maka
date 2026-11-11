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
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::AtomicUsize;

fn event(value: Value) -> String {
    format!(
        "event: {}\ndata: {value}\n\n",
        value["type"].as_str().unwrap()
    )
}
fn start() -> String {
    event(
        json!({"type":"message_start","message":{"id":"steering","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}),
    )
}
fn finish() -> String {
    start()
        + &event(
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Corrected answer."}}),
        )
        + &event(json!({"type":"content_block_stop","index":0}))
        + &event(
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}),
        )
        + &event(json!({"type":"message_stop"}))
}

fn responses_text(text: &str) -> Value {
    json!({"id":"answer","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
}
fn responses_events(id: &str, item: Value, complete: bool) -> Vec<Value> {
    let mut events = vec![
        json!({"type":"response.created","response":{"id":id,"model":"gpt-4.1"}}),
        json!({"type":"response.output_item.done","output_index":0,"item":item}),
    ];
    if complete {
        events.push(json!({"type":"response.completed","response":{"id":id,"status":"completed","output":[item],"usage":{"input_tokens":10,"output_tokens":3}}}));
    }
    events
}

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
    let mut host = Host::spawn(&sandbox).unwrap();
    let (mut client, _) = host.ready().await.unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let (requests, mut received) = mpsc::unbounded_channel();
    let count = Arc::new(AtomicUsize::new(0));
    let posted = count.clone();
    let server = tokio::spawn(async move {
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                joined = connections.join_next(), if !connections.is_empty() => { joined.unwrap().unwrap(); }
                socket = listener.accept() => {
                    let (socket, _) = socket.unwrap();
                    let requests = requests.clone();
                    let posted = posted.clone();
                    let count = posted.clone();
                    connections.spawn(async move {
                        let upgrade = Arc::new(std::sync::Mutex::new(None));
                        let handle = upgrade.clone();
                        let observed = requests.clone();
                        let service = service_fn(move |mut request: Request<Incoming>| {
                            let requests = requests.clone();
                            let handle = handle.clone();
                            let posted = posted.clone();
                            async move {
                                if request.headers().contains_key("upgrade") {
                                    let key = request.headers()["sec-websocket-key"].as_bytes();
                                    let accept = tokio_tungstenite::tungstenite::handshake::derive_accept_key(key);
                                    *handle.lock().unwrap() = Some(hyper::upgrade::on(&mut request));
                                    return Ok::<_, Infallible>(Response::builder().status(101)
                                        .header("connection", "upgrade").header("upgrade", "websocket")
                                        .header("sec-websocket-accept", accept)
                                        .body(Full::new(Bytes::new()).boxed_unsync()).unwrap());
                                }
                                if request.method() == hyper::Method::GET {
                                    return Ok(response(json!({"data":[{"id":model}]}).to_string(), "application/json"));
                                }
                                assert!(!prefix, "Responses conversation must use its primary WebSocket transport");
                                let body: Value = serde_json::from_slice(&request.into_body().collect().await.unwrap().to_bytes()).unwrap();
                                if !body.to_string().contains("steering-original") {
                                    return Ok(response(finish(), "text/event-stream"));
                                }
                                posted.fetch_add(1, Ordering::SeqCst);
                                requests.send(body.clone()).unwrap();
                                if body.to_string().contains("steering-correction") {
                                    return Ok(response(finish(), "text/event-stream"));
                                }
                                std::future::pending().await
                            }
                        });
                        if let Err(error) = hyper::server::conn::http1::Builder::new().keep_alive(false)
                            .serve_connection(TokioIo::new(socket), service).with_upgrades().await {
                            assert!(error.is_incomplete_message() || error.is_canceled(), "{error}");
                        }
                        let pending = upgrade.lock().unwrap().take();
                        if let Some(pending) = pending {
                            let mut ws = tokio_tungstenite::WebSocketStream::from_raw_socket(
                                TokioIo::new(pending.await.unwrap()),
                                tokio_tungstenite::tungstenite::protocol::Role::Server, None,
                            ).await;
                            while let Some(message) = ws.next().await {
                                use tokio_tungstenite::tungstenite::{Message, Error, error::ProtocolError};
                                let message = match message {
                                    Ok(Message::Close(_)) => { ws.flush().await.unwrap(); break; }
                                    Ok(message) => message,
                                    Err(Error::Protocol(ProtocolError::ResetWithoutClosingHandshake)) | Err(Error::ConnectionClosed) => break,
                                    Err(error) => panic!("{error}"),
                                };
                                let Message::Text(text) = message else { continue; };
                                let body: Value = serde_json::from_str(&text).unwrap();
                                let prompt = body.to_string();
                                let main = prompt.contains("steering-original") || prompt.contains("effect-result");
                                let events = if main {
                                    let phase = count.fetch_add(1, Ordering::SeqCst);
                                    observed.send(body.clone()).unwrap();
                                    match phase {
                                        0 => {
                                            let command = "printf 'once\\n' >> steering-effects.log; printf 'effect-result'";
                                            responses_events("tool-response", json!({"id":"effect","type":"function_call","call_id":"steering-effect","name":"Shell","arguments":json!({"command":command}).to_string(),"status":"completed"}), true)
                                        }
                                        1 => {
                                            assert!(prompt.contains("effect-result"), "{body}");
                                            responses_events("held-response", responses_text("accepted-prefix"), false)
                                        }
                                        2 => {
                                            assert!(prompt.contains("steering-correction"), "{body}");
                                            responses_events("corrected-response", responses_text("Corrected answer."), true)
                                        }
                                        _ => panic!("original request was repeated: {body}"),
                                    }
                                } else {
                                    responses_events("warmup", responses_text("Ready."), true)
                                };
                                for event in events { ws.send(Message::Text(event.to_string().into())).await.unwrap(); }
                            }
                        }
                    });
                }
            }
        }
    });
    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(45), async {
        let catalog = call(&client, "settings", "connections", json!({"kind":"start"}), Attachments::new()).await;
        let created = call(&client, "settings", "create", json!({"expectedCatalogRevision":catalog["revision"],"connection":{
            "slug":"steering","name":"Steering loopback","provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":provider},
            "configuration":{"baseUrl":base},"enabled":true,"enabledModelIds":[model],"modelOverrides":{(model):{"codeMode":false,"apiProtocol":protocol}}
        }}), Attachments::new()).await;
        assert_eq!(created["kind"], "committed", "{created}");
        let connection = &created["connection"]["connectionId"];
        let detail = call(&client, "settings", "connection", json!({"connectionId":connection}), Attachments::new()).await;
        let secret: Arc<dyn ReadResource> = Arc::new(FixtureKey);
        let saved = call(&client, "settings", "saveCredential", json!({"expected":detail["target"],"expectedCredential":null}), Attachments::from([("secret".into(), secret)])).await;
        assert_eq!(saved["kind"], "saved");
        let created = call(&client, "agent", "create", json!({"title":"Steering stream","automaticTitle":false,"labels":[],"tools":["Shell"],"workspace":{"kind":"directory","path":sandbox.workspace},"backend":{"kind":"model","connectionId":connection,"modelId":model,"thinkingLevel":null}}), Attachments::new()).await;
        let session = created["session"]["id"].as_str().unwrap();
        let sent = call(&client, "agent", "send", json!({"sessionId":session,"message":"steering-original","delivery":"queue"}), Attachments::new()).await;
        assert!(matches!(sent["kind"].as_str(), Some("started" | "queued")), "original send rejected: {sent}");
        let original = match tokio::time::timeout(Duration::from_secs(5), received.recv()).await {
            Ok(Some(body)) => body,
            other => {
                let current = work(&client, session, json!({"kind":"message","messageId":sent["messageId"]}), None).await;
                panic!("original provider request missing: {other:?}; work={current}");
            }
        };
        assert!(!original.to_string().contains("steering-correction"));

        if prefix {
            let followup = received.recv().await.unwrap();
            assert!(followup.to_string().contains("effect-result"), "{followup}");
            assert_eq!(tokio::fs::read_to_string(sandbox.workspace.join("steering-effects.log")).await.unwrap(), "once\n");
            loop {
                let history = call(&client, "agent", "history", json!({"sessionId":session,"position":{"kind":"tail"}}), Attachments::new()).await;
                if history.to_string().contains("accepted-prefix") { break; }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        let original = work(&client, session, json!({"kind":"message","messageId":sent["messageId"]}), None).await;
        let run = original["execution"]["runId"].clone();
        let correction = call(&client, "agent", "send", json!({"sessionId":session,"message":"steering-correction","delivery":"steer","expectedRunId":run}), Attachments::new()).await;
        assert_eq!(correction["kind"], "queued", "{correction}");
        let corrected = received.recv().await.unwrap();
        let messages = corrected.to_string();
        assert_eq!(messages.matches("steering-original").count(), 1);
        assert_eq!(messages.matches("steering-correction").count(), 1);
        if prefix {
            assert!(messages.contains("effect-result"), "{messages}");
            assert!(messages.contains("accepted-prefix"), "{messages}");
        }
        let completed = work(&client, session, json!({"kind":"run","runId":run}), Some("completed")).await;
        assert_eq!(completed["execution"]["runId"], run);
        assert_eq!(count.load(Ordering::SeqCst), if prefix {3} else {2}, "original request must not be replayed");
        let queue = call(&client, "agent", "queue", json!({"sessionId":session}), Attachments::new()).await;
        assert_eq!(queue["entries"], json!([]));
        if prefix { assert_eq!(tokio::fs::read_to_string(sandbox.workspace.join("steering-effects.log")).await.unwrap(), "once\n"); }
        host.quit(&mut client).await.unwrap();
        let facts = identities(&sandbox, session, &run).await;
        assert_eq!(facts.iter().filter(|fact| fact["kind"] == "model_closed").count(), if prefix {2} else {1}, "interruption must not fabricate completion");
        let attempts: Vec<_> = facts.iter().filter(|fact| fact["kind"] == "model_attempt_prepared").collect();
        assert_eq!(attempts.len(), if prefix {3} else {2});
        for attempt in attempts {
            assert!(facts.iter().any(|fact| fact["kind"] == "model_cleanup_observed" && fact["attempt"] == attempt["attempt"] && fact["cleanup"]["kind"] == "confirmed"), "{facts:?}");
        }
    })).catch_unwind().await;
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
    host.cleanup().await.unwrap();
    match result {
        Ok(result) => result.expect("steering must interrupt a provider that never finishes"),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

#[tokio::test]
async fn steering_interrupts_before_response_headers() {
    steering(false).await;
}

#[tokio::test]
async fn steering_preserves_accepted_prefix_without_repeating_effects() {
    steering(true).await;
}
