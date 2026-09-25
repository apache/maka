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

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use maka_model::{
    ModelEvent, ModelExecutor, ModelRequest, ProviderConfig, ProviderKind, StepBuilder,
};
use maka_runtime::model::{ModelFinishReason, ModelPart, TextKind};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Notify,
};
use tokio_util::sync::CancellationToken;

// Exercise the locked Responses SDKs over loopback, not a live provider.
fn frames(events: &[Value]) -> String {
    events
        .iter()
        .map(|event| {
            format!(
                "event: {}\ndata: {event}\n\n",
                event["type"].as_str().unwrap()
            )
        })
        .collect()
}

async fn read_request(socket: &mut TcpStream) -> Value {
    let mut bytes = Vec::new();
    let boundary = loop {
        let mut chunk = [0; 4096];
        let count = socket.read(&mut chunk).await.unwrap();
        assert_ne!(count, 0);
        bytes.extend_from_slice(&chunk[..count]);
        assert!(bytes.len() < 64 * 1024);
        if let Some(at) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            break at + 4;
        }
    };
    let head = String::from_utf8_lossy(&bytes[..boundary]);
    assert!(head.starts_with("POST /v1/responses HTTP/1.1\r\n"));
    assert!(
        head.lines()
            .any(|line| line.eq_ignore_ascii_case("authorization: Bearer local-test-key"))
    );
    assert!(
        head.lines()
            .any(|line| line.eq_ignore_ascii_case("x-test-provider: responses"))
    );
    let length: usize = head
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().unwrap())
        })
        .unwrap();
    assert!(boundary + length < 64 * 1024);
    while bytes.len() < boundary + length {
        let mut chunk = [0; 4096];
        let count = socket.read(&mut chunk).await.unwrap();
        assert_ne!(count, 0);
        bytes.extend_from_slice(&chunk[..count]);
    }
    serde_json::from_slice(&bytes[boundary..boundary + length]).unwrap()
}

fn completed() -> Value {
    json!({"type":"response.completed","response":{"usage":{
        "input_tokens":12,"output_tokens":7,"input_tokens_details":{"cached_tokens":3},
        "output_tokens_details":{"reasoning_tokens":4}}}})
}

fn text_events(text: &str) -> Vec<Value> {
    vec![
        json!({"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"msg_1","role":"assistant","content":[]}}),
        json!({"type":"response.output_text.delta","item_id":"msg_1","output_index":1,"content_index":0,"delta":text}),
        json!({"type":"response.output_item.done","output_index":1,"item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":text,"annotations":[]}]}}),
    ]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn responses_http_preserves_reasoning_and_raw_tool_identity_across_steps() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let gate = Arc::new(Notify::new());
        let release = gate.clone();
        let first = frames(&[
            json!({"type":"response.created","response":{"id":"resp_1","created_at":1,"model":"gpt-5"}}),
            json!({"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1"}}),
            json!({"type":"response.reasoning_summary_part.added","item_id":"rs_1","output_index":0,"summary_index":0}),
            json!({"type":"response.reasoning_summary_text.delta","item_id":"rs_1","summary_index":0,"delta":"Check the echo tool."}),
        ]);
        let mut tail = vec![
            json!({"type":"response.reasoning_summary_part.done","item_id":"rs_1","summary_index":0}),
            json!({"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","encrypted_content":"opaque-reasoning","summary":[{"type":"summary_text","text":"Check the echo tool."}]}}),
        ];
        tail.extend(text_events("Checking 😀"));
        tail.extend([
            json!({"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"fc_item_1","call_id":"call_raw_1","name":"maka_tool_search","arguments":""}}),
            json!({"type":"response.function_call_arguments.delta","item_id":"fc_item_1","output_index":2,"delta":"{\"text\":"}),
            json!({"type":"response.function_call_arguments.delta","item_id":"fc_item_1","output_index":2,"delta":"\"你好😀\"}"}),
            json!({"type":"response.function_call_arguments.done","item_id":"fc_item_1","output_index":2,"arguments":"{\"text\":\"你好😀\"}"}),
            json!({"type":"response.output_item.done","output_index":2,"item":{"type":"function_call","id":"fc_item_1","call_id":"call_raw_1","name":"maka_tool_search","arguments":"{\"text\":\"你好😀\"}","status":"completed"}}),
            completed(),
        ]);
        let tail = frames(&tail);
        let mut second = vec![json!({"type":"response.created","response":{"id":"resp_2","created_at":2,"model":"gpt-5"}})];
        second.extend(text_events("Echoed 你好😀"));
        second.push(completed());
        let second = frames(&second);
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for index in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(read_request(&mut socket).await);
                let length = if index == 0 { first.len() + tail.len() } else { second.len() };
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                if index == 0 {
                    socket.write_all(first.as_bytes()).await.unwrap();
                    release.notified().await;
                    socket.write_all(tail.as_bytes()).await.unwrap();
                } else {
                    socket.write_all(second.as_bytes()).await.unwrap();
                }
            }
            requests
        });
        let executor = ModelExecutor::new(1, Duration::from_secs(15)).unwrap();
        let mut prompt = vec![json!({"role":"user","content":[{"type":"text","text":"Echo 你好😀"}]})];
        let schema = json!({"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false});
        for index in 0..2 {
            let request = ModelRequest {
                provider: ProviderConfig { adapter: None, capabilities: Default::default(), network: Default::default(), kind: ProviderKind::OpenaiResponses, model: "gpt-5".into(), base_url: base_url.clone(), auth: maka_model::ProviderAuth::ApiKey("local-test-key".into()), headers: BTreeMap::from([("x-test-provider".into(), "responses".into())]), body_overlay: Some(serde_json::Map::from_iter([("fixture_context".into(), json!({"route":"responses"}))])) },
                prompt: serde_json::from_value(json!(prompt)).unwrap(),
                tools: vec![maka_model::ToolDefinition { freeform: None, output_schema: None, provider: None, name: "tool_search".into(), description: "Echo text".into(), input_schema: schema.clone() }],
                provider_options: json!({"openai":{"store":false,"reasoningEffort":"low","reasoningSummary":"auto"}}),
                max_output_tokens: Some(128),
            };
            let mut stream = executor.stream(request, CancellationToken::new()).await.unwrap();
            let mut builder = StepBuilder::for_step(&format!("step-{index}")).unwrap();
            while let Some(event) = stream.next().await {
                let event = event.unwrap();
                if matches!(&event, ModelEvent::PartDelta { text, .. } if text == "Check the echo tool.") {
                    gate.notify_one(); // The provider cannot finish until reasoning reaches Rust.
                }
                builder.push(event).unwrap();
            }
            let step = builder.finish().unwrap();
            assert_eq!(step.response_id.as_deref(), Some(if index == 0 { "resp_1" } else { "resp_2" }));
            assert_eq!(step.model.as_deref(), Some("gpt-5"));
            assert_eq!(step.timestamp.as_deref(), Some(if index == 0 { "1970-01-01T00:00:01.000Z" } else { "1970-01-01T00:00:02.000Z" }));
            assert_eq!(step.provider_options.as_ref().unwrap()["openai"]["responseId"], if index == 0 { "resp_1" } else { "resp_2" });
            assert_eq!(step.usage.input_tokens, Some(12));
            assert_eq!(step.usage.output_tokens, Some(7));
            assert_eq!(step.usage.cache_read_tokens, Some(3));
            assert_eq!(step.usage.reasoning_tokens, Some(4));
            if index == 1 {
                assert_eq!(step.finish_reason, ModelFinishReason::Stop);
                assert!(matches!(&step.parts[..], [ModelPart::Text { text, .. }] if text == "Echoed 你好😀"));
                continue;
            }
            assert_eq!(step.finish_reason, ModelFinishReason::ToolCalls);
            assert_eq!(step.parts.len(), 3);
            let ModelPart::Text { text_kind, text, provider_options } = &step.parts[0] else { panic!("reasoning missing") };
            assert_eq!(*text_kind, TextKind::Thinking);
            assert_eq!(text, "Check the echo tool.");
            assert_eq!(provider_options.as_ref().unwrap()["openai"], json!({"itemId":"rs_1","reasoningEncryptedContent":"opaque-reasoning"}));
            let call = step.tool_calls().next().unwrap();
            assert_eq!(call.id, "call_raw_1");
            assert_eq!(call.name, "tool_search");
            assert_eq!(call.input, json!({"text":"你好😀"}));
            assert!(!call.provider_executed);
            assert_eq!(call.provider_options.as_ref().unwrap()["openai"]["itemId"], "fc_item_1");
            // Project accepted parts into the next SDK request. Engine persistence
            // and tool execution are deliberately outside this adapter test.
            let content: Vec<Value> = step.parts.iter().map(|part| match part {
                ModelPart::Text { text_kind, text, provider_options } => json!({"type":if *text_kind == TextKind::Thinking { "reasoning" } else { "text" },"text":text,"providerOptions":provider_options}),
                ModelPart::ToolCall { call } => json!({"type":"tool-call","toolCallId":call.id,"toolName":call.name,"input":call.input,"providerOptions":call.provider_options}),
                _ => unreachable!(),
            }).collect();
            prompt.push(json!({"role":"assistant","content":content}));
            prompt.push(json!({"role":"tool","content":[{"type":"tool-result","toolCallId":call.id,"toolName":call.name,"output":{"type":"json","value":{"echo":"你好😀"}}}]}));
        }
        let requests = server.await.unwrap();
        for body in &requests {
            assert_eq!(body["model"], "gpt-5");
            assert_eq!(body["stream"], true);
            assert_eq!(body["fixture_context"], json!({"route":"responses"}));
            assert_eq!(body["store"], false);
            assert_eq!(body["max_output_tokens"], 128);
            assert_eq!(body["reasoning"], json!({"effort":"low","summary":"auto"}));
            assert_eq!(body["tool_choice"], "auto");
            assert_eq!(body["tools"][0]["type"], "function");
            assert_eq!(body["tools"][0]["name"], "maka_tool_search");
            assert_eq!(body["tools"][0]["parameters"], schema);
            assert!(body["include"].as_array().unwrap().contains(&json!("reasoning.encrypted_content")));
        }
        assert_eq!(requests[0]["input"], json!([{"role":"user","content":[{"type":"input_text","text":"Echo 你好😀"}]}]));
        let history = requests[1]["input"].as_array().unwrap();
        assert_eq!(history.len(), 5);
        assert_eq!(history[1]["type"], "reasoning");
        assert_eq!(history[1]["id"], "rs_1");
        assert_eq!(history[1]["encrypted_content"], "opaque-reasoning");
        assert_eq!(history[2]["content"][0]["text"], "Checking 😀");
        assert_eq!(history[3]["type"], "function_call");
        // SDK deliberately omits the item ID on replayed client function calls;
        // call_id pairs the call with its output, while Rust retains item metadata.
        assert!(history[3].get("id").is_none());
        assert_eq!(history[3]["call_id"], "call_raw_1");
        assert_eq!(history[3]["name"], "maka_tool_search");
        assert_eq!(serde_json::from_str::<Value>(history[3]["arguments"].as_str().unwrap()).unwrap(), json!({"text":"你好😀"}));
        assert_eq!(history[4]["type"], "function_call_output");
        assert_eq!(history[4]["call_id"], "call_raw_1");
        assert_eq!(serde_json::from_str::<Value>(history[4]["output"].as_str().unwrap()).unwrap(), json!({"echo":"你好😀"}));
    }).await.expect("Responses SSE and continuation must make bounded progress");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plaintext_responses_replays_only_its_declared_carrier_after_a_tool_step() {
    use maka_runtime::model::{
        OpenResponsesCompatibility, PlaintextReasoningReplay as Replay, PlaintextResponses,
    };
    tokio::time::timeout(Duration::from_secs(30), async {
        for (replay, compatibility) in [
            (Replay::PlaintextContent, None),
            (Replay::PlaintextSummary, None),
            (Replay::PlaintextSummary, Some(OpenResponsesCompatibility::AlibabaTokenPlan)),
        ] {
            let summary = replay == Replay::PlaintextSummary;
            let contract = PlaintextResponses { reasoning_replay: replay, compatibility };
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
            let gate = Arc::new(Notify::new());
            let release = gate.clone();
            let delta_type = if summary { "response.reasoning_summary_text.delta" } else { "response.reasoning_text.delta" };
            let other_type = if summary { "response.reasoning_text.delta" } else { "response.reasoning_summary_text.delta" };
            let first = frames(&[
                json!({"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_plain","summary":[]}}),
                json!({"type":other_type,"item_id":"rs_plain","output_index":0,"summary_index":0,"content_index":0,"delta":"wrong carrier"}),
                json!({"type":delta_type,"item_id":"rs_plain","output_index":0,"summary_index":0,"content_index":0,"delta":"想😀"}),
            ]);
            let mut item = json!({"type":"reasoning","id":"rs_plain",
                "summary":[{"type":"summary_text","text":"wrong carrier"}],
                "content":[{"type":"reasoning_text","text":"wrong carrier"}]});
            if summary {
                item["summary"] = json!([{"type":"summary_text","text":"想😀"},{"type":"summary_text","text":""},{"type":"summary_text","text":"好"}]);
            } else {
                item["content"] = json!([{"type":"reasoning_text","text":"想😀好"}]);
            }
            let tail = frames(&[
                json!({"type":"response.output_item.done","output_index":0,"item":item}),
                json!({"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_plain","call_id":"call_plain","name":"maka_tool_search","arguments":""}}),
                json!({"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc_plain","call_id":"call_plain","name":"maka_tool_search","arguments":"{}","status":"completed"}}),
                completed(),
            ]);
            let mut done = text_events("done"); done.push(completed());
            let second = frames(&done);
            let server = tokio::spawn(async move {
                let mut requests = Vec::new();
                for index in 0..2 {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    requests.push(read_request(&mut socket).await);
                    let length = if index == 0 { first.len() + tail.len() } else { second.len() };
                    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                    if index == 0 {
                        socket.write_all(first.as_bytes()).await.unwrap();
                        release.notified().await;
                        socket.write_all(tail.as_bytes()).await.unwrap();
                    } else { socket.write_all(second.as_bytes()).await.unwrap(); }
                }
                requests
            });
            let mut prompt = vec![maka_model::prompt::Message::user("Use the tool")];
            for index in 0..2 {
                let executor = ModelExecutor::new(1, Duration::from_secs(5)).unwrap();
                let request = ModelRequest {
                    provider: ProviderConfig { adapter: None, capabilities: Default::default(), network: Default::default(), kind: ProviderKind::OpenResponses(contract),
                        model: "plain".into(), base_url: base_url.clone(), auth: maka_model::ProviderAuth::ApiKey("local-test-key".into()),
                        headers: BTreeMap::from([("x-test-provider".into(),"responses".into())]), body_overlay: None },
                    prompt: prompt.clone(), tools: vec![maka_model::ToolDefinition { freeform: None, output_schema: None, provider: None, name: "tool_search".into(), description: "Search tools".into(), input_schema: json!({"type":"object"}) }],
                    provider_options: json!({"openResponses":{"reasoningEffort":"high","reasoningSummary":"auto"}}),
                    max_output_tokens: Some(256),
                };
                let mut stream = executor.stream(request, CancellationToken::new()).await.unwrap();
                let mut builder = StepBuilder::for_step(&format!("plain-{index}")).unwrap();
                while let Some(event) = stream.next().await {
                    let event = event.unwrap();
                    if matches!(&event, ModelEvent::PartDelta { text, .. } if text == "想😀") { gate.notify_one(); }
                    builder.push(event).unwrap();
                }
                let output = builder.finish().unwrap();
                // Only serializable canonical parts survive to a fresh model request.
                let parts: Vec<ModelPart> = serde_json::from_slice(&serde_json::to_vec(&output.parts).unwrap()).unwrap();
                if index == 1 {
                    assert!(matches!(&parts[..], [ModelPart::Text { text, .. }] if text == "done")); continue;
                }
                assert!(matches!(&parts[0], ModelPart::Text { text, text_kind: TextKind::Thinking, .. } if text == "想😀好"));
                let content: Vec<Value> = parts.iter().map(|part| match part {
                    ModelPart::Text { text, provider_options, .. } => json!({"type":"reasoning","text":text,"providerOptions":provider_options}),
                    ModelPart::ToolCall { call } => json!({"type":"tool-call","toolCallId":call.id,"toolName":call.name,"input":call.input,"providerOptions":call.provider_options}),
                    _ => unreachable!(),
                }).collect();
                prompt.push(serde_json::from_value(json!({"role":"assistant","content":content})).unwrap());
                prompt.push(maka_model::prompt::Message::tool("call_plain", "tool_search", maka_model::prompt::ToolOutput::Text("found".into())));
            }
            let requests = server.await.unwrap();
            assert_eq!(requests[0]["reasoning"]["effort"], "high");
            let input = requests[1]["input"].as_array().unwrap();
            let reasoning = input.iter().find(|part| part["type"] == "reasoning").unwrap();
            if summary {
                assert_eq!(reasoning["id"], "rs_plain");
                assert_eq!(reasoning["summary"], item["summary"]);
                assert!(reasoning.get("content").is_none());
            } else {
                assert_eq!(reasoning["content"], item["content"]);
                assert_eq!(reasoning["summary"], json!([]));
            }
            assert!(input.iter().any(|part| part["type"] == "function_call" && part["call_id"] == "call_plain" && part["name"] == "maka_tool_search"));
            assert!(input.iter().any(|part| part["type"] == "function_call_output" && part["call_id"] == "call_plain"));
            assert!(!serde_json::to_string(input).unwrap().contains("wrong carrier"));
            if compatibility.is_some() { assert!(requests.iter().all(|body| body["store"] == false)); }
        }
    }).await.expect("plaintext reasoning and continuation must make bounded progress");
}

#[tokio::test]
async fn plaintext_responses_does_not_turn_transport_eof_into_success() {
    use maka_runtime::model::{PlaintextReasoningReplay, PlaintextResponses};
    tokio::time::timeout(Duration::from_secs(10), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            let body = frames(&text_events("incomplete"));
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        });
        let executor = ModelExecutor::new(1, Duration::from_secs(3)).unwrap();
        let mut stream = executor.stream(ModelRequest {
            provider: ProviderConfig { adapter: None, capabilities: Default::default(), network: Default::default(),
                kind: ProviderKind::OpenResponses(PlaintextResponses { reasoning_replay: PlaintextReasoningReplay::PlaintextSummary, compatibility: None }),
                model: "plain".into(), base_url, auth: maka_model::ProviderAuth::ApiKey("local-test-key".into()),
                headers: BTreeMap::from([("x-test-provider".into(), "responses".into())]), body_overlay: None },
            prompt: vec![maka_model::prompt::Message::user("hello")],
            tools: vec![], provider_options: json!({}), max_output_tokens: None,
        }, CancellationToken::new()).await.unwrap();
        let mut failure = None;
        while let Some(event) = stream.next().await {
            match event {
                Ok(ModelEvent::Finished { .. }) => panic!("EOF was mistaken for provider completion"),
                Err(error) => { failure = Some(error); break; }
                _ => {}
            }
        }
        assert!(matches!(failure, Some(maka_model::ModelError::Provider(error))
            if error.reason() == maka_model::ProviderFailureReason::StreamTruncated));
        server.await.unwrap();
    }).await.expect("truncated stream must fail promptly");
}
