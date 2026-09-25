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

use super::provider_stream::{read_request, request};
use futures_util::{SinkExt, StreamExt};
use maka_model::{Conversation, ModelExecutor, ProviderKind, StepBuilder};
use maka_runtime::{
    model::{ModelPart, ModelSource},
    tools::ProviderTool,
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{io::AsyncWriteExt, net::TcpListener};
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

fn responses() -> Vec<Value> {
    vec![
        json!({"type":"response.created","response":{"id":"resp_search","created_at":1,"model":"gpt-5"}}),
        json!({"type":"response.output_item.added","output_index":0,"item":{"type":"web_search_call","id":"search_1","status":"in_progress"}}),
        json!({"type":"response.output_item.done","output_index":0,"item":{"type":"web_search_call","id":"search_1","status":"completed","action":{"type":"search","query":"Maka","sources":[{"type":"url","url":"https://example.com/source"}]}}}),
        json!({"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"msg_1","role":"assistant","content":[]}}),
        json!({"type":"response.output_text.delta","item_id":"msg_1","output_index":1,"content_index":0,"delta":"Answer"}),
        json!({"type":"response.output_text.annotation.added","item_id":"msg_1","output_index":1,"content_index":0,"annotation_index":0,"annotation":{"type":"url_citation","start_index":0,"end_index":6,"url":"https://example.com/source","title":"Source"}}),
        json!({"type":"response.output_item.done","output_index":1,"item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"Answer","annotations":[]}]}}),
        json!({"type":"response.completed","response":{"id":"resp_search","output":[],"usage":{"input_tokens":2,"output_tokens":5}}}),
    ]
}
fn anthropic() -> Vec<Value> {
    vec![
        json!({"type":"message_start","message":{"id":"msg_search","type":"message","role":"assistant","model":"claude-sonnet-4","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"output_tokens":0}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"search_1","name":"web_search","input":{}}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"Maka\"}"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"search_1","content":[{"type":"web_search_result","url":"https://example.com/source","title":"Source","encrypted_content":"opaque","page_age":null}]}}),
        json!({"type":"content_block_stop","index":1}),
        json!({"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"Answer"}}),
        json!({"type":"content_block_stop","index":2}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}),
        json!({"type":"message_stop"}),
    ]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hosted_tools_cross_the_real_sdks_on_http_and_websocket_without_becoming_functions() {
    tokio::time::timeout(Duration::from_secs(40), scenario())
        .await
        .unwrap();
}

async fn scenario() {
    let executor = ModelExecutor::new(1, Duration::from_secs(10)).unwrap();
    for (kind, websocket, incomplete) in [
        (ProviderKind::OpenaiResponses, false, false),
        (ProviderKind::OpenaiResponses, true, false),
        (ProviderKind::Anthropic, false, false),
        (ProviderKind::OpenaiResponses, false, true),
        (ProviderKind::OpenaiResponses, true, true),
        (ProviderKind::Anthropic, false, true),
    ] {
        let openai = matches!(kind, ProviderKind::OpenaiResponses);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let mut events = if openai { responses() } else { anthropic() };
        if incomplete {
            if openai {
                events.last_mut().unwrap()["type"] = json!("response.incomplete");
            } else {
                let terminal = events
                    .iter_mut()
                    .find(|event| event["type"] == "message_delta")
                    .unwrap();
                terminal["delta"]["stop_reason"] = json!("model_context_window_exceeded");
            }
        }
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            if websocket {
                let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
                let message = socket.next().await.unwrap().unwrap();
                let request: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
                assert_eq!(request["type"], "response.create");
                for event in events {
                    socket
                        .send(Message::Text(event.to_string().into()))
                        .await
                        .unwrap();
                }
                // Keep the socket alive until the request lane is dropped.
                let _ = socket.next().await;
                request
            } else {
                let raw = read_request(&mut socket).await;
                let request: Value =
                    serde_json::from_str(raw.split_once("\r\n\r\n").unwrap().1).unwrap();
                let body: String = events
                    .iter()
                    .map(|event| {
                        format!(
                            "event: {}\ndata: {event}\n\n",
                            event["type"].as_str().unwrap()
                        )
                    })
                    .collect();
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                request
            }
        });
        let mut input = request(kind, base);
        input.tools[0].name = "Research".into(); // No Host or adapter special-casing of WebSearch.
        input.tools[0].provider = Some(ProviderTool {
            id: if openai {
                "openai.web_search"
            } else {
                "anthropic.web_search_20250305"
            }
            .into(),
            args: if openai {
                json!({"searchContextSize":"medium"})
            } else {
                json!({"maxUses":8})
            },
        });
        let lane = websocket.then(Conversation::default);
        let mut stream = executor
            .stream_in_conversation(input, CancellationToken::new(), lane.clone())
            .await
            .unwrap();
        let mut builder = StepBuilder::for_step("native-search").unwrap();
        while let Some(event) = stream.next().await {
            builder.push(event.unwrap()).unwrap();
        }
        let step = builder.finish().unwrap();
        assert_eq!(
            step.finish_reason == maka_runtime::model::ModelFinishReason::Length,
            incomplete
        );
        assert!(
            step.tool_calls()
                .all(|call| call.provider_executed && call.name == "Research"),
            "{:?}",
            step.parts
        );
        assert_eq!(step.tool_calls().count(), 1);
        assert!(
            step.parts
                .iter()
                .any(|part| matches!(part, ModelPart::ToolResult {name, ..} if name == "Research"))
        );
        assert!(step.parts.iter().any(|part| matches!(part, ModelPart::Source {source: ModelSource::Url {url, ..}} if url == "https://example.com/source")));
        stream.cancel_and_wait().await;
        if websocket && incomplete {
            assert!(
                !lane.as_ref().unwrap().needs_confirmation(),
                "an incomplete response without details cannot authorize cached continuation"
            );
        }
        drop(lane);
        let wire = server.await.unwrap();
        assert_eq!(wire["tools"].as_array().unwrap().len(), 1);
        assert_eq!(
            wire["tools"][0]["type"],
            if openai {
                "web_search"
            } else {
                "web_search_20250305"
            }
        );
        if openai {
            assert_eq!(wire["tools"][0]["search_context_size"], "medium");
        } else {
            assert_eq!(wire["tools"][0]["max_uses"], 8);
        }
    }
    for (kind, id) in [
        (ProviderKind::OpenaiResponses, "openai.unknown_tool"),
        (ProviderKind::OpenaiResponses, "openai.local_shell"),
        (ProviderKind::Anthropic, "anthropic.unknown_tool"),
        (ProviderKind::Anthropic, "anthropic.bash_20250124"),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut input = request(
            kind,
            format!("http://{}/v1", listener.local_addr().unwrap()),
        );
        input.tools[0].provider = Some(ProviderTool {
            id: id.into(),
            args: json!({}),
        });
        let mut stream = executor
            .stream(input, CancellationToken::new())
            .await
            .unwrap();
        let error = tokio::select! {
            result = listener.accept() => panic!("invalid tool reached network: {result:?}"),
            result = stream.next() => result.unwrap().unwrap_err(),
        };
        assert!(
            error
                .to_string()
                .contains("Unsupported provider-executed tool"),
            "{error}"
        );
        stream.cancel_and_wait().await;
    }
}
