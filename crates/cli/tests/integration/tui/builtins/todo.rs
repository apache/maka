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
use tokio::io::AsyncWriteExt;

#[test]
fn real_model_todo_updates_reach_the_panel_and_unpriced_usage() {
    let mut fixture = Fixture::new();
    fixture.runtime.block_on(async {
        fixture
            .client
            .create_session(
                maka_protocol::session::decode_session_create_input(&json!({
                    "sessionId":"builtin-todo","name":"Checklist acceptance",
                    "workspace":{"kind":"host_path","path":fixture.directory.path()},
                    "sandboxMode":"read-only","modelTarget":{"kind":"default"}
                }))
                .unwrap(),
            )
            .await
            .unwrap();
    });
    let listener = fixture.listener.take().unwrap();
    let (proceed, resume) = tokio::sync::oneshot::channel();
    let model = fixture.runtime.spawn(async move {
        let (stream, _) = model_request(&listener).await;
        reply(
            stream,
            tool(
                "find-todo",
                "tool_search",
                json!({"query":"todo checklist"}),
            ),
        )
        .await;
        let (stream, body) = model_request(&listener).await;
        assert!(
            body["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["function"]["name"] == "todo_write")
        );
        reply(
            stream,
            tool(
                "start-todo",
                "todo_write",
                json!({"todos":[
                    {"content":"Inspect acceptance fixture","status":"completed"},
                    {"content":"Verify durable checklist","status":"in_progress"}
                ]}),
            ),
        )
        .await;
        let (stream, body) = model_request(&listener).await;
        assert!(
            body["messages"]
                .to_string()
                .contains("Verify durable checklist")
        );
        // Keep the turn live until the PTY has observed the first model write.
        resume.await.unwrap();
        reply(
            stream,
            tool(
                "finish-todo",
                "todo_write",
                json!({"todos":[
                    {"content":"Inspect acceptance fixture","status":"completed"},
                    {"content":"Verify durable checklist","status":"completed"}
                ]}),
            ),
        )
        .await;
        let (stream, body) = model_request(&listener).await;
        assert!(body["messages"].to_string().contains("completed"));
        reply(stream, json!({"content":"Checklist acceptance finished"})).await;
    });
    let mut tui = fixture.tui();
    tui.resize(170, 44);
    tui.wait_for("Checklist acceptance");
    tui.click_text("Checklist acceptance");
    tui.wait_for("Message…");
    tui.click_page_text("Message…");
    tui.send(b"Update the isolated checklist\r");
    tui.wait_for("Verify durable checklist");
    tui.wait_for("◨");
    tui.click_text("◨");
    tui.wait_for("Checklist");
    reveal(&mut tui, "Verify durable checklist");
    let first = fixture.runtime.block_on(stored(
        &fixture.host.root,
        "maka.todo",
        "session/builtin-todo",
    ));
    assert_eq!(first["items"][1]["status"], "in_progress");
    proceed.send(()).unwrap();
    tui.wait_for("Checklist acceptance finished");
    fixture.runtime.block_on(model).unwrap();
    let final_document = fixture.runtime.block_on(stored(
        &fixture.host.root,
        "maka.todo",
        "session/builtin-todo",
    ));
    assert_eq!(final_document["items"].as_array().unwrap().len(), 2);
    assert!(
        final_document["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["status"] == "completed")
    );
    tui.wait_for("2 of 2 done");
    category(&mut tui, "Usage & pricing", "unpriced");
    let activity = fixture.read("maka.insights", "request", json!({"kind":"activity", "operationId":uuid::Uuid::new_v4(),
        "read":{"kind":"start","filter":{"from":0,"to":4_000_000_000_000_u64,"sessionId":"builtin-todo"}}}));
    let summary = fixture.read("maka.insights", "request", json!({"kind":"summary", "operationId":uuid::Uuid::new_v4(),"cursor":activity["page"]["cursor"]}));
    assert_eq!(summary["summary"]["models"]["calls"], 4);
    assert_eq!(summary["summary"]["models"]["cost"]["unvalued"], 4);
    fixture.finish(tui);
}

fn tool(id: &str, name: &str, input: Value) -> Value {
    json!({"tool_calls":[{"index":0,"id":id,"type":"function","function":{"name":name,"arguments":input.to_string()}}]})
}

async fn reply(mut stream: tokio::net::TcpStream, delta: Value) {
    let finish = if delta.get("tool_calls").is_some() {
        "tool_calls"
    } else {
        "stop"
    };
    let frame = json!({"id":"builtin-model","object":"chat.completion.chunk","model":"fixture-model",
        "choices":[{"index":0,"delta":delta,"finish_reason":finish}],
        "usage":{"prompt_tokens":20,"completion_tokens":8,"total_tokens":28}});
    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {frame}\n\ndata: [DONE]\n\n").as_bytes()).await.unwrap();
}
