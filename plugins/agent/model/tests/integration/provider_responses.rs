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

use maka_agent_facts::model::ModelFinishReason;
use maka_agent_facts::model::ModelPart;
use maka_agent_facts::model::TextKind;
use maka_model::{
    ModelEvent, ModelExecutor, ModelRequest, ProviderConfig, ProviderKind, StepBuilder,
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Notify,
};
use tokio_util::sync::CancellationToken;

// Exercise the native Responses adapter over loopback, not a live provider.
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
    let (head, bytes) = crate::http_request(socket).await;
    assert!(head.starts_with("POST /v1/responses HTTP/1.1\r\n"));
    assert!(
        head.lines()
            .any(|line| line.eq_ignore_ascii_case("authorization: Bearer local-test-key"))
    );
    assert!(
        head.lines()
            .any(|line| line.eq_ignore_ascii_case("x-test-provider: responses"))
    );
    serde_json::from_slice(&bytes).unwrap()
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
async fn responses_http_preserves_complete_ordered_output_items() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
    let mut events =
        vec![json!({"type":"response.created","response":{"id":"complete-items","model":"gpt-5"}})];
    for index in 0..129 {
        let id = format!("message-{index:03}");
        let text = format!("complete-part-{index:03}");
        events.extend([
            json!({"type":"response.output_item.added","output_index":index,"item":{"type":"message","id":id,"role":"assistant","content":[]}}),
            json!({"type":"response.output_text.delta","item_id":id,"output_index":index,"content_index":0,"delta":text}),
            json!({"type":"response.output_item.done","output_index":index,"item":{"type":"message","id":id,"role":"assistant","content":[{"type":"output_text","text":text,"annotations":[]}]}}),
        ]);
    }
    events.push(completed());
    let body = frames(&events);
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_request(&mut socket).await;
        let write = socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
        (request, write)
    });
    let executor = ModelExecutor::new(Duration::from_secs(15)).unwrap();
    let mut input = super::provider_stream::request(ProviderKind::OpenaiResponses, base_url);
    input.provider.model = "gpt-5".into();
    input.provider.auth = maka_model::ProviderAuth::ApiKey("local-test-key".into());
    input
        .provider
        .headers
        .insert("x-test-provider".into(), "responses".into());
    let mut stream = executor
        .stream(input, CancellationToken::new())
        .await
        .unwrap();
    let mut builder = StepBuilder::for_step("complete-items").unwrap();
    let completed = async {
        while let Some(event) = stream.next().await {
            builder
                .push(event.map_err(|error| error.to_string())?.event)
                .map_err(|error| error.to_string())?;
        }
        builder.finish().map_err(|error| error.to_string())
    }
    .await;
    let cleanup = stream.cancel_and_wait().await;
    let (request, write) = server.await.unwrap();
    cleanup.unwrap();
    write.unwrap();
    let step = completed.expect("valid provider output must preserve every ordered item");
    assert_eq!(request["model"], "gpt-5");
    assert_eq!(step.response_id.as_deref(), Some("complete-items"));
    let parts: Vec<_> = step
        .parts
        .iter()
        .map(|part| match part {
            ModelPart::Text { text, .. } => text.chunks().collect::<String>(),
            other => panic!("unexpected provider part {other:?}"),
        })
        .collect();
    assert_eq!(
        parts,
        (0..129)
            .map(|index| format!("complete-part-{index:03}"))
            .collect::<Vec<_>>()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn responses_http_preserves_reasoning_and_raw_tool_identity_across_steps() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let gate = Arc::new(Notify::new());
        let release = gate.clone();
        let input_gate = Arc::new(Notify::new());
        let release_input = input_gate.clone();
        let first = frames(&[
            json!({"type":"response.created","response":{"id":"resp_1","created_at":1,"model":"gpt-5"}}),
            json!({"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1"}}),
            json!({"type":"response.reasoning_summary_part.added","item_id":"rs_1","output_index":0,"summary_index":0}),
            json!({"type":"response.reasoning_summary_text.delta","item_id":"rs_1","summary_index":0,"delta":"Check the echo tool."}),
        ]);
        let mut preview = vec![
            json!({"type":"response.reasoning_summary_part.done","item_id":"rs_1","summary_index":0}),
            json!({"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","encrypted_content":"opaque-reasoning","summary":[{"type":"summary_text","text":"Check the echo tool."}]}}),
        ];
        preview.extend(text_events("Checking 😀"));
        preview.extend([
            json!({"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"fc_item_1","call_id":"call_raw_1","name":"maka_tool_search","arguments":""}}),
            json!({"type":"response.function_call_arguments.delta","item_id":"fc_item_1","output_index":2,"delta":"{\"text\":\"你"}),
        ]);
        let preview = frames(&preview);
        let tail = frames(&[
            json!({"type":"response.function_call_arguments.delta","item_id":"fc_item_1","output_index":2,"delta":"好😀\"}"}),
            json!({"type":"response.function_call_arguments.done","item_id":"fc_item_1","output_index":2,"arguments":"{\"text\":\"你好😀\"}"}),
            json!({"type":"response.output_item.done","output_index":2,"item":{"type":"function_call","id":"fc_item_1","call_id":"call_raw_1","name":"maka_tool_search","arguments":"{\"text\":\"你好😀\"}","status":"completed"}}),
            completed(),
        ]);
        let mut second = vec![json!({"type":"response.created","response":{"id":"resp_2","created_at":2,"model":"gpt-5"}})];
        second.extend(text_events("Echoed 你好😀"));
        second.push(completed());
        let second = frames(&second);
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for index in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(read_request(&mut socket).await);
                let length = if index == 0 { first.len() + preview.len() + tail.len() } else { second.len() };
                // The subscription endpoint can omit this header on a valid
                // response; both turns must be decoded by their SSE events.
                let content_type = if index == 0 { "Content-Type: text/event-stream\r\n" } else { "" };
                socket.write_all(format!("HTTP/1.1 200 OK\r\n{content_type}Content-Length: {length}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                if index == 0 {
                    socket.write_all(first.as_bytes()).await.unwrap();
                    release.notified().await;
                    socket.write_all(preview.as_bytes()).await.unwrap();
                    release_input.notified().await;
                    socket.write_all(tail.as_bytes()).await.unwrap();
                } else {
                    socket.write_all(second.as_bytes()).await.unwrap();
                }
            }
            requests
        });
        let executor = ModelExecutor::new(Duration::from_secs(15)).unwrap();
        let mut prompt = vec![json!({"role":"user","content":[{"type":"text","text":"Echo 你好😀"}]})];
        let schema = json!({"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false});
        for index in 0..2 {
            let request = ModelRequest {
                language: maka_agent_facts::language::Language::En,
                provider: ProviderConfig { adapter: None, capabilities: Default::default(), network: Default::default(), kind: ProviderKind::OpenaiResponses, model: "gpt-5".into(), base_url: base_url.clone(), auth: maka_model::ProviderAuth::ApiKey("local-test-key".into()), headers: BTreeMap::from([("x-test-provider".into(), "responses".into())]), body_overlay: Some(serde_json::Map::from_iter([("fixture_context".into(), json!({"route":"responses"}))])) },
                prompt: serde_json::from_value::<Vec<maka_model::prompt::Message>>(json!(prompt)).unwrap().into(),
                tools: vec![maka_model::ToolDefinition { freeform: None, output_schema: None, provider: None, name: "tool_search".into(), description: "Echo text".into(), input_schema: schema.clone() }],
                provider_options: json!({"openai":{"store":false,"reasoningEffort":"low","reasoningSummary":"auto"}}),
                max_output_tokens: Some(128),
            };
            let mut stream = executor.stream(request, CancellationToken::new()).await.unwrap();
            let mut builder = StepBuilder::for_step(&format!("step-{index}")).unwrap();
            let mut input_events = Vec::new();
            while let Some(event) = stream.next().await {
                let event = event.unwrap().event;
                if matches!(&event, ModelEvent::PartDelta { text, .. } if text == "Check the echo tool.") {
                    gate.notify_one(); // The provider cannot finish until reasoning reaches Rust.
                }
                if matches!(&event, ModelEvent::ToolInputStarted { .. } | ModelEvent::ToolInputDelta { .. } | ModelEvent::ToolInputFinished { .. }) {
                    input_events.push(event.clone());
                }
                if matches!(&event, ModelEvent::ToolInputDelta { id, text } if id == "call_raw_1" && text == "{\"text\":\"你") {
                    assert_eq!(input_events, vec![
                        ModelEvent::ToolInputStarted { id: "call_raw_1".into(), name: "tool_search".into(), provider_executed: false },
                        ModelEvent::ToolInputDelta { id: "call_raw_1".into(), text: "{\"text\":\"你".into() },
                    ]);
                    // Final arguments and the complete call remain held at the provider.
                    input_gate.notify_one();
                }
                if matches!(&event, ModelEvent::ToolCall(_)) {
                    assert_eq!(input_events.last(), Some(&ModelEvent::ToolInputFinished { id: "call_raw_1".into() }));
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
                assert!(matches!(&step.parts[..], [ModelPart::Text { text, .. }] if text.chunks().collect::<String>() == "Echoed 你好😀"));
                continue;
            }
            assert_eq!(step.finish_reason, ModelFinishReason::ToolCalls);
            assert_eq!(input_events, vec![
                ModelEvent::ToolInputStarted { id: "call_raw_1".into(), name: "tool_search".into(), provider_executed: false },
                ModelEvent::ToolInputDelta { id: "call_raw_1".into(), text: "{\"text\":\"你".into() },
                ModelEvent::ToolInputDelta { id: "call_raw_1".into(), text: "好😀\"}".into() },
                ModelEvent::ToolInputFinished { id: "call_raw_1".into() },
            ]);
            assert_eq!(step.parts.len(), 3);
            let ModelPart::Text { text_kind, text, provider_options } = &step.parts[0] else { panic!("reasoning missing") };
            assert_eq!(*text_kind, TextKind::Thinking);
            assert_eq!(text.chunks().collect::<String>(), "Check the echo tool.");
            let metadata = &provider_options.as_ref().unwrap()["openai"];
            assert_eq!(metadata["itemId"], "rs_1");
            assert_eq!(metadata["reasoningEncryptedContent"], "opaque-reasoning");
            assert_eq!(metadata["responsesReplay"]["fields"]["type"], "reasoning");
            assert!(!metadata["responsesReplay"].to_string().contains("Check the echo tool."));
            let call = step.tool_calls().next().unwrap();
            assert_eq!(call.id, "call_raw_1");
            assert_eq!(call.name, "tool_search");
            assert_eq!(call.input, maka_agent_facts::model::ToolInput::Json(json!({"text":"你好😀"})));
            assert!(!call.provider_executed);
            assert_eq!(call.provider_options.as_ref().unwrap()["openai"]["itemId"], "fc_item_1");
            // Project accepted parts into the next adapter request. Engine persistence
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
        // The canonical accepted item retains its provider identity even after
        // the disposable connection/cache is gone.
        assert_eq!(history[3]["id"], "fc_item_1");
        assert_eq!(history[3]["call_id"], "call_raw_1");
        assert_eq!(history[3]["name"], "maka_tool_search");
        assert_eq!(serde_json::from_str::<Value>(history[3]["arguments"].as_str().unwrap()).unwrap(), json!({"text":"你好😀"}));
        assert_eq!(history[4]["type"], "function_call_output");
        assert_eq!(history[4]["call_id"], "call_raw_1");
        assert_eq!(serde_json::from_str::<Value>(history[4]["output"].as_str().unwrap()).unwrap(), json!({"echo":"你好😀"}));
    }).await.expect("Responses SSE and continuation must make bounded progress");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn responses_http_streams_custom_input_before_its_complete_freeform_call() {
    use maka_agent_facts::model::ToolInput;
    use maka_agent_facts::tools::FreeformGrammar;
    tokio::time::timeout(Duration::from_secs(10), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let gate = Arc::new(Notify::new());
        let release = gate.clone();
        let source = "text('你好😀');\n";
        let first = frames(&[
            json!({"type":"response.output_item.added","output_index":0,"item":{"type":"custom_tool_call","id":"custom_item","call_id":"custom_call","name":"exec","input":""}}),
            json!({"type":"response.custom_tool_call_input.delta","item_id":"custom_item","output_index":0,"delta":"text('你"}),
        ]);
        let tail = frames(&[
            json!({"type":"response.custom_tool_call_input.delta","item_id":"custom_item","output_index":0,"delta":"好😀');\n"}),
            json!({"type":"response.custom_tool_call_input.done","item_id":"custom_item","output_index":0,"input":source}),
            json!({"type":"response.output_item.done","output_index":0,"item":{"type":"custom_tool_call","id":"custom_item","call_id":"custom_call","name":"exec","input":source}}),
            completed(),
        ]);
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            let length = first.len() + tail.len();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
            socket.write_all(first.as_bytes()).await.unwrap();
            release.notified().await;
            socket.write_all(tail.as_bytes()).await.unwrap();
            request
        });
        let executor = ModelExecutor::new(Duration::from_secs(3)).unwrap();
        let mut request = super::provider_stream::request(ProviderKind::OpenaiResponses, base_url);
        request.provider.auth = maka_model::ProviderAuth::ApiKey("local-test-key".into());
        request.provider.headers.insert("x-test-provider".into(), "responses".into());
        request.tools = vec![maka_model::ToolDefinition {
            name: "exec".into(), description: "JavaScript".into(), provider: None,
            input_schema: json!({"type":"object"}), output_schema: None,
            freeform: Some(FreeformGrammar::Lark { definition: "start: /[\\s\\S]+/".into() }),
        }];
        let mut stream = executor.stream(request, CancellationToken::new()).await.unwrap();
        let mut builder = StepBuilder::for_step("custom-step").unwrap();
        let mut input_events = Vec::new();
        while let Some(event) = stream.next().await {
            let event = event.unwrap().event;
            if matches!(&event, ModelEvent::ToolInputStarted { .. } | ModelEvent::ToolInputDelta { .. } | ModelEvent::ToolInputFinished { .. }) {
                input_events.push(event.clone());
            }
            if matches!(&event, ModelEvent::ToolInputDelta { id, text } if id == "custom_call" && text == "text('你") {
                assert_eq!(input_events, vec![
                    ModelEvent::ToolInputStarted { id: "custom_call".into(), name: "exec".into(), provider_executed: false },
                    ModelEvent::ToolInputDelta { id: "custom_call".into(), text: "text('你".into() },
                ]);
                gate.notify_one();
            }
            if matches!(&event, ModelEvent::ToolCall(_)) {
                assert_eq!(input_events.last(), Some(&ModelEvent::ToolInputFinished { id: "custom_call".into() }));
            }
            builder.push(event).unwrap();
        }
        assert_eq!(input_events, vec![
            ModelEvent::ToolInputStarted { id: "custom_call".into(), name: "exec".into(), provider_executed: false },
            ModelEvent::ToolInputDelta { id: "custom_call".into(), text: "text('你".into() },
            ModelEvent::ToolInputDelta { id: "custom_call".into(), text: "好😀');\n".into() },
            ModelEvent::ToolInputFinished { id: "custom_call".into() },
        ]);
        let step = builder.finish().unwrap();
        assert_eq!(step.finish_reason, ModelFinishReason::ToolCalls);
        let [ModelPart::ToolCall { call }] = &step.parts[..] else { panic!("expected one complete freeform call") };
        assert_eq!(call.id, "custom_call");
        assert_eq!(call.name, "exec");
        assert_eq!(call.input, ToolInput::Json(json!(source)));
        assert!(!call.provider_executed);
        let metadata = &call.provider_options.as_ref().unwrap()["openai"];
        assert_eq!(metadata["itemId"], "custom_item");
        assert_eq!(metadata["toolKind"], "custom");
        assert_eq!(metadata["responsesReplay"]["fields"]["type"], "custom_tool_call");
        assert!(metadata["responsesReplay"]["fields"].get("input").is_none());
        let request = server.await.unwrap();
        assert_eq!(request["tools"][0]["type"], "custom");
        assert_eq!(request["tools"][0]["name"], "exec");
        assert_eq!(request["tools"][0]["format"]["syntax"], "lark");
    }).await.expect("custom argument preview must arrive before the complete call is released");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plaintext_responses_replays_only_its_declared_carrier_after_a_tool_step() {
    use maka_agent_facts::model::OpenResponsesCompatibility;
    use maka_agent_facts::model::PlaintextReasoningReplay as Replay;
    use maka_agent_facts::model::PlaintextResponses;
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
                let executor = ModelExecutor::new(Duration::from_secs(5)).unwrap();
                let request = ModelRequest {
                    language: maka_agent_facts::language::Language::En,
                    provider: ProviderConfig { adapter: None, capabilities: Default::default(), network: Default::default(), kind: ProviderKind::OpenResponses(contract),
                        model: "plain".into(), base_url: base_url.clone(), auth: maka_model::ProviderAuth::ApiKey("local-test-key".into()),
                        headers: BTreeMap::from([("x-test-provider".into(),"responses".into())]), body_overlay: None },
                    prompt: prompt.clone().into(), tools: vec![maka_model::ToolDefinition { freeform: None, output_schema: None, provider: None, name: "tool_search".into(), description: "Search tools".into(), input_schema: json!({"type":"object"}) }],
                    provider_options: json!({"openResponses":{"reasoningEffort":"high","reasoningSummary":"auto"}}),
                    max_output_tokens: Some(256),
                };
                let mut stream = executor.stream(request, CancellationToken::new()).await.unwrap();
                let mut builder = StepBuilder::for_step(&format!("plain-{index}")).unwrap();
                while let Some(event) = stream.next().await {
                    let event = event.unwrap().event;
                    if matches!(&event, ModelEvent::PartDelta { text, .. } if text == "想😀") { gate.notify_one(); }
                    builder.push(event).unwrap();
                }
                let output = builder.finish().unwrap();
                // Only serializable canonical parts survive to a fresh model request.
                let parts: Vec<ModelPart> = serde_json::from_slice(&serde_json::to_vec(&output.parts).unwrap()).unwrap();
                if index == 1 {
                    assert!(matches!(&parts[..], [ModelPart::Text { text, .. }] if text.chunks().collect::<String>() == "done")); continue;
                }
                assert!(matches!(&parts[0], ModelPart::Text { text, text_kind: TextKind::Thinking, .. } if text.chunks().collect::<String>() == "想😀好"));
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
    use maka_agent_facts::model::PlaintextReasoningReplay;
    use maka_agent_facts::model::PlaintextResponses;
    tokio::time::timeout(Duration::from_secs(10), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            let body = frames(&text_events("incomplete"));
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        });
        let executor = ModelExecutor::new(Duration::from_secs(3)).unwrap();
        let mut stream = executor.stream(ModelRequest {
            language: maka_agent_facts::language::Language::En,
            provider: ProviderConfig { adapter: None, capabilities: Default::default(), network: Default::default(),
                kind: ProviderKind::OpenResponses(PlaintextResponses { reasoning_replay: PlaintextReasoningReplay::PlaintextSummary, compatibility: None }),
                model: "plain".into(), base_url, auth: maka_model::ProviderAuth::ApiKey("local-test-key".into()),
                headers: BTreeMap::from([("x-test-provider".into(), "responses".into())]), body_overlay: None },
            prompt: vec![maka_model::prompt::Message::user("hello")].into(),
            tools: vec![], provider_options: json!({}), max_output_tokens: None,
        }, CancellationToken::new()).await.unwrap();
        let mut failure = None;
        while let Some(event) = stream.next().await {
            match event {
                Ok(maka_model::Emission { event: ModelEvent::Finished { .. }, .. }) => panic!("EOF was mistaken for provider completion"),
                Err(error) => { failure = Some(error); break; }
                _ => {}
            }
        }
        assert!(matches!(failure, Some(maka_model::ModelError::Provider(error))
            if error.reason() == maka_model::ProviderFailureReason::StreamTruncated));
        server.await.unwrap();
    }).await.expect("truncated stream must fail promptly");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idle_http_reads_keep_protocol_safety_and_explicit_rejections() {
    use maka_model::{ModelError, ProviderFailureReason};
    tokio::time::timeout(Duration::from_secs(10), async {
        for (status, mode) in [(0, "empty"), (200, "empty"), (200, "text"), (200, "opaque"), (200, "untyped"), (200, "untyped_text"), (401, "empty"), (429, "empty"), (503, "empty")] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                read_request(&mut socket).await;
                if status != 0 {
                    let content_type = if mode.starts_with("untyped") { "" } else if status == 200 { "Content-Type: text/event-stream\r\n" } else { "Content-Type: application/json\r\n" };
                    socket.write_all(format!("HTTP/1.1 {status} Fixture\r\n{content_type}Retry-After: 2\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                    let body = match mode {
                        "text" | "untyped_text" => frames(&text_events("retained answer")),
                        "untyped" => "<html>unexpected gateway response</html>".into(),
                        "opaque" => frames(&[json!({"type":"response.future_call.in_progress"})]),
                        _ => String::new(),
                    };
                    socket.write_all(body.as_bytes()).await.unwrap();
                }
                assert_eq!(socket.read(&mut [0; 1]).await.unwrap(), 0, "timeout must close HTTP I/O");
            });
            let executor = ModelExecutor::new(Duration::from_millis(150)).unwrap();
            let mut input = super::provider_stream::request(ProviderKind::OpenaiResponses, base_url);
            input.provider.auth = maka_model::ProviderAuth::ApiKey("local-test-key".into());
            input.provider.headers.insert("x-test-provider".into(), "responses".into());
            let before = maka_model::ProviderFailure::now_unix_ms();
            let mut stream = executor.stream(input, CancellationToken::new()).await.unwrap();
            let error = loop {
                match stream.next().await.expect("must report the interruption") {
                    Err(error) => break error,
                    Ok(event) => assert!(!matches!(event.event, ModelEvent::Finished { .. })),
                }
            };
            stream.cancel_and_wait().await.expect("physical cleanup");
            server.await.unwrap();
            if mode == "untyped" {
                assert!(matches!(error, ModelError::Adapter(message) if message.contains("missing Content-Type and no SSE events")));
            } else if status == 401 {
                assert!(matches!(error, ModelError::Http { status: 401, .. }));
            } else {
                let ModelError::Provider(failure) = error else { panic!("expected recoverable evidence: {error}") };
                assert_eq!(failure.reason(), match status { 429 => ProviderFailureReason::RateLimit, 503 => ProviderFailureReason::ProviderUnavailable, _ => ProviderFailureReason::TimedOut });
                assert_eq!(failure.replay_safe(), mode == "empty");
                assert_eq!(failure.retained_output_safe(), status < 400 && mode != "opaque");
                match failure.retry_at_unix_ms() {
                    Some(at) => { assert_ne!(status, 0, "a response actually supplied Retry-After, including successful SSE"); assert!((before + 2000..=maka_model::ProviderFailure::now_unix_ms() + 2000).contains(&at)); },
                    None => assert_eq!(status, 0, "only the fixture without HTTP headers has no deadline"),
                }
            }
        }
    }).await.expect("all idle HTTP boundaries must settle");
}
