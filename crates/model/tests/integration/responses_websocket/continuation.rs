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
use maka_runtime::model::{ModelPart, TextKind};
const CONFIRMATION_CASES: [&str; 7] = [
    "confirmed",
    "properties",
    "unconfirmed",
    "wrong-tool",
    "changed-before",
    "changed-after",
    "wrong-response",
];

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn custom_result_and_notifications_all_survive_confirmed_websocket_delta() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut socket = accept(&listener).await;
            assert_eq!(body(&mut socket).await["tools"][0]["type"], "custom");
            let item = json!({"type":"custom_tool_call","id":"custom-item","call_id":"call_1","name":"exec","input":"text('start');"});
            for event in [
                json!({"type":"response.created","response":{"id":"resp_1","created_at":1,"model":"test-responses"}}),
                json!({"type":"response.output_item.done","output_index":0,"item":item}),
                json!({"type":"response.completed","response":{"id":"resp_1","output":[item],"usage":{"input_tokens":2,"output_tokens":1}}}),
            ] { socket.send(Message::Text(event.to_string().into())).await.unwrap(); }
            let delta = body(&mut socket).await;
            assert_eq!(delta["previous_response_id"], "resp_1");
            assert_eq!(delta["input"], json!([
                {"type":"custom_tool_call_output","call_id":"call_1","output":"running"},
                {"type":"custom_tool_call_output","call_id":"call_1","output":"notice one"},
                {"type":"custom_tool_call_output","call_id":"call_1","output":"notice two"},
            ]));
            finish(&mut socket, "resp_2").await;
        });
        let executor = ModelExecutor::new(1, Duration::from_secs(5)).unwrap();
        let lane = Conversation::default();
        let mut input = request(&base, "first");
        input.tools = vec![maka_model::ToolDefinition { name:"exec".into(), description:"JavaScript".into(), input_schema:json!({"type":"object"}), provider:None, output_schema:None,
            freeform:Some(maka_runtime::tools::FreeformGrammar::Lark { definition:"start: /[\\s\\S]+/".into() }) }];
        let mut next = request(&base, "first");
        next.tools = input.tools.clone();
        let step = generate_step(&executor, &lane, input).await;
        let mut input = next;
        let call = step.tool_calls().next().unwrap();
        input.prompt.push(serde_json::from_value(json!({"role":"assistant","content":[{"type":"tool-call","toolCallId":call.id,"toolName":call.name,"input":call.input,"providerOptions":call.provider_options}]})).unwrap());
        for (value, notification) in [("running",false),("notice one",true),("notice two",true)] {
            input.prompt.push(serde_json::from_value(json!({"role":"tool","content":[{"type":"tool-result","toolCallId":"call_1","toolName":"exec",
                "output":{"type":"text","value":value}, "providerOptions":{"openai":{"toolKind":"custom"},"maka":{"notification":notification}}}]})).unwrap());
        }
        assert!(lane.confirm(&input.prompt, &["call_1"], step.response_id.as_deref()).await.unwrap());
        generate(&executor, &lane, input).await;
        server.await.unwrap();
    }).await.expect("custom outputs must not disappear from WS continuation");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idle_close_reconnect_and_upgrade_fallback_restore_the_raw_baseline() {
    tokio::time::timeout(Duration::from_secs(25), async {
        let executor = ModelExecutor::new(1, Duration::from_secs(10)).unwrap();
        for fallback in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let mut original = accept(&listener).await;
                wire(&mut original, "first").await;
                // One flush makes the idle close observable alongside completion,
                // not a sleep-based race with the second request.
                for event in sparse_events() {
                    original.feed(Message::Text(event.to_string().into())).await.unwrap();
                }
                original.feed(Message::Close(None)).await.unwrap();
                original.flush().await.unwrap();
                drop(original);
                let next = if fallback {
                    for _ in 0..6 { reject_upgrade(&listener).await; }
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut head = Vec::new();
                    loop {
                        head.push(socket.read_u8().await.unwrap());
                        if head.ends_with(b"\r\n\r\n") { break; }
                    }
                    let head = String::from_utf8(head).unwrap();
                    assert!(head.starts_with("POST "));
                    let length: usize = head.lines().find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length").then(|| value.trim().parse().unwrap())
                    }).unwrap();
                    let mut bytes = vec![0; length];
                    socket.read_exact(&mut bytes).await.unwrap();
                    let next: Value = serde_json::from_slice(&bytes).unwrap();
                    assert_eq!(next["stream"], true);
                    assert!(next.get("type").is_none());
                    let response: String = events("resp_http", "OK").iter().map(|event| format!("data: {event}\n\n")).collect();
                    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
                    next
                } else {
                    let mut socket = accept(&listener).await;
                    let next = body(&mut socket).await;
                    assert_eq!(next["type"], "response.create");
                    finish(&mut socket, "resp_2").await;
                    next
                };
                assert!(next.get("previous_response_id").is_none());
                let history = next["input"].as_array().unwrap();
                let finalized: Vec<_> = sparse_events().into_iter()
                    .filter(|event| event["type"] == "response.output_item.done")
                    .map(|mut event| event["item"].take()).collect();
                assert_eq!(history.len(), 5);
                assert_eq!(&history[1..4], finalized.as_slice());
                assert_eq!(history[4]["call_id"], "call_1");
            });
            let lane = Conversation::default();
            let step = generate_step(&executor, &lane, request(&base, "first")).await;
            assert_eq!(step.parts.len(), 3);
            assert!(matches!(&step.parts[0], ModelPart::Text { text_kind: TextKind::Thinking, text, .. } if text == "Check the file."));
            assert!(matches!(&step.parts[1], ModelPart::Text { text_kind: TextKind::Text, text, .. } if text == "Checking 😀"));
            // Confirm exactly the SDK-observed history, not a hand-written
            // semantic prefix that could conceal lost reasoning or text.
            let content: Vec<_> = step.parts.iter().map(|part| match part {
                ModelPart::Text { text_kind, text, provider_options } => json!({"type":if *text_kind == TextKind::Thinking { "reasoning" } else { "text" },"text":text,"providerOptions":provider_options}),
                ModelPart::ToolCall { call } => json!({"type":"tool-call","toolCallId":call.id,"toolName":call.name,"input":call.input,"providerOptions":call.provider_options}),
                _ => unreachable!(),
            }).collect();
            let mut next = replay(&base);
            next.prompt[1] = serde_json::from_value(json!({"role":"assistant","content":content})).unwrap();
            assert!(lane.confirm(&next.prompt, &["call_1"], step.response_id.as_deref()).await.unwrap());
            generate(&executor, &lane, next).await;
            drop(lane);
            server.await.unwrap();
        }
    }).await.unwrap();
}

fn sparse_events() -> Vec<Value> {
    let reasoning = json!({"type":"reasoning","id":"rs_1","encrypted_content":"opaque-reasoning",
        "summary":[{"type":"summary_text","text":"Check the file."}]});
    let message = json!({"type":"message","id":"msg_1","role":"assistant","status":"completed",
        "phase":"commentary","content":[{"type":"output_text","text":"Checking 😀","annotations":[]}]});
    let mut events = vec![
        call_events().remove(0),
        json!({"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1"}}),
        json!({"type":"response.reasoning_summary_part.added","item_id":"rs_1","output_index":0,"summary_index":0}),
        json!({"type":"response.reasoning_summary_text.delta","item_id":"rs_1","summary_index":0,"delta":"Check the file."}),
        json!({"type":"response.reasoning_summary_part.done","item_id":"rs_1","summary_index":0}),
        json!({"type":"response.output_item.done","output_index":0,"item":reasoning}),
        json!({"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"msg_1","role":"assistant","phase":"commentary","content":[]}}),
        json!({"type":"response.output_text.delta","item_id":"msg_1","output_index":1,"content_index":0,"delta":"Checking 😀"}),
        json!({"type":"response.output_item.done","output_index":1,"item":message}),
    ];
    events.extend(call_events().into_iter().skip(1).map(|mut event| {
        if event["type"] == "response.completed" {
            event["response"]["output"] = json!([]);
        } else {
            event["output_index"] = json!(2);
        }
        event
    }));
    events
}

fn call_events() -> Vec<Value> {
    let item = json!({"type":"function_call","id":"fc_1","call_id":"call_1",
        "name":"read","arguments":"{}","status":"completed"});
    vec![
        json!({"type":"response.created","response":{"id":"resp_1","created_at":1,"model":"test-responses"}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
        json!({"type":"response.output_item.done","output_index":0,"item":item}),
        json!({"type":"response.completed","response":{"id":"resp_1","output":[item],"usage":{"input_tokens":2,"output_tokens":1}}}),
    ]
}

fn replay(base: &str) -> ModelRequest {
    let mut request = request(base, "first");
    request.prompt.extend(serde_json::from_value::<Vec<maka_model::prompt::Message>>(json!([
        {"role":"assistant","content":[{"type":"tool-call","toolCallId":"call_1","toolName":"read","input":{},
            "providerOptions":{"openai":{"itemId":"fc_1"}}}]},
        {"role":"tool","content":[{"type":"tool-result","toolCallId":"call_1","toolName":"read","output":{"type":"text","value":"result"}}]},
    ])).unwrap());
    request
}

async fn call(socket: &mut WebSocketStream<TcpStream>) {
    for event in call_events() {
        socket
            .send(Message::Text(event.to_string().into()))
            .await
            .unwrap();
    }
}

pub(super) async fn body(socket: &mut WebSocketStream<TcpStream>) -> Value {
    serde_json::from_str(&socket.next().await.unwrap().unwrap().into_text().unwrap()).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn canonical_tool_confirmation_matches_ts_and_changed_properties_restore_full_input() {
    tokio::time::timeout(Duration::from_secs(25), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut oracle = accept(&listener).await;
            let first = wire(&mut oracle, "first").await;
            call(&mut oracle).await;
            let delta = body(&mut oracle).await;
            assert_eq!(delta["previous_response_id"], "resp_1");
            assert_eq!(delta["input"].as_array().unwrap().len(), 1);
            assert_eq!(delta["input"][0]["type"], "function_call_output");
            finish(&mut oracle, "resp_2").await;
            let _ = oracle.next().await;

            for mode in CONFIRMATION_CASES {
                let mut socket = accept(&listener).await;
                assert_eq!(wire(&mut socket, "first").await, first);
                call(&mut socket).await;
                let next = body(&mut socket).await;
                if mode == "properties" {
                    assert!(next.get("previous_response_id").is_none());
                    assert_eq!(next["max_output_tokens"], 64);
                    assert_eq!(next["input"].as_array().unwrap().len(), 3);
                    assert_eq!(
                        next["input"][1],
                        call_events().last().unwrap()["response"]["output"][0]
                    );
                    assert_eq!(next["input"][2], delta["input"][0]);
                } else if mode == "confirmed" {
                    assert_eq!(next, delta);
                } else {
                    assert!(next.get("previous_response_id").is_none(), "{mode}");
                    assert_eq!(next["input"].as_array().unwrap().len(), 3, "{mode}");
                    assert!(
                        next["input"][1].get("id").is_none(),
                        "full SDK projection, not raw cache"
                    );
                    assert_eq!(next["input"][2], delta["input"][0]);
                }
                finish(&mut socket, "resp_2").await;
                let _ = socket.next().await;
            }
        });
        let oracle = tokio::process::Command::new("node")
            .arg(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../tests/fixtures/responses-websocket-oracle.mjs"),
            )
            .arg(&base)
            .arg("continuation")
            .kill_on_drop(true)
            .output()
            .await
            .unwrap();
        assert!(
            oracle.status.success(),
            "{}",
            String::from_utf8_lossy(&oracle.stderr)
        );
        let executor = ModelExecutor::new(1, Duration::from_secs(10)).unwrap();
        for mode in CONFIRMATION_CASES {
            let lane = Conversation::default();
            let step = generate_step(&executor, &lane, request(&base, "first")).await;
            assert_eq!(step.tool_calls().next().unwrap().id, "call_1");
            let mut next = replay(&base);
            match mode {
                "unconfirmed" => {}
                "wrong-tool" => assert!(
                    !lane
                        .confirm(&next.prompt, &["another-call"], step.response_id.as_deref())
                        .await
                        .unwrap()
                ),
                "wrong-response" => {
                    assert!(
                        !lane
                            .confirm(&next.prompt, &["call_1"], Some("other-response"))
                            .await
                            .unwrap()
                    )
                }
                "changed-before" => {
                    next.prompt[0] = maka_model::prompt::Message::user("compacted");
                    assert!(
                        !lane
                            .confirm(&next.prompt, &["call_1"], step.response_id.as_deref())
                            .await
                            .unwrap()
                    );
                }
                _ => assert!(
                    lane.confirm(&next.prompt, &["call_1"], step.response_id.as_deref())
                        .await
                        .unwrap()
                ),
            }
            if mode == "changed-after" {
                next.prompt[0] = maka_model::prompt::Message::user("compacted");
            }
            if mode == "properties" {
                next.max_output_tokens = Some(64);
            }
            generate(&executor, &lane, next).await;
        }
        server.await.unwrap();
    })
    .await
    .unwrap();
}
