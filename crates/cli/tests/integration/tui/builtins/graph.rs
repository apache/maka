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
use maka_plugins::terminal_ui::view::{Node, Target, View};
use maka_protocol::Operation;
use std::collections::BTreeSet;
use tokio::io::AsyncWriteExt;

const SESSION: &str = "graph-reading";
mod reading;

#[test]
fn real_host_graph_reads_every_work_and_unicode_page_through_public_routes() {
    let mut fixture = Fixture::new();
    let instruction = format!(
        "Graph reading instruction\n{}\n\ntail instruction",
        "中🦀\n".repeat(1400)
    );
    let answer = format!(
        "Graph reading result\n{}\n\ntail result",
        "答😀\n".repeat(900)
    );
    let listener = fixture.listener.take().unwrap();
    let model_instruction = instruction.clone();
    let model_answer = answer.clone();
    let model = fixture.runtime.spawn(async move {
        let mut supervisor = 0;
        loop {
            let (mut stream, body) = model_request(&listener).await;
            let choice = if body.to_string().contains("Agent Graph supervisor") {
                supervisor += 1;
                let (name, arguments) = match supervisor {
                    1 => ("tool_search", json!({"query":"update_agent_graph"})),
                    2 => ("update_agent_graph", json!({"operation":"add_work","work":
                        (0..17).map(|_| json!({"target":{"kind":"preset","presetId":"reader"},
                            "instruction":model_instruction})).collect::<Vec<_>>()})),
                    _ if body["tools"].as_array().unwrap().iter().any(|tool| tool["function"]["name"] == "yield_agent_graph") => ("yield_agent_graph", json!({})),
                    _ => ("tool_search", json!({"query":"yield_agent_graph"})),
                };
                json!({"index":0,"delta":{"tool_calls":[{"index":0,"id":format!("step-{supervisor}"),
                    "type":"function","function":{"name":name,"arguments":arguments.to_string()}}]},"finish_reason":"tool_calls"})
            } else {
                assert!(body.to_string().contains("tail instruction"), "{body}");
                json!({"index":0,"delta":{"content":model_answer},"finish_reason":"stop"})
            };
            let frame = json!({"id":"graph-reading","object":"chat.completion.chunk","model":"fixture-model","choices":[choice]});
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {frame}\n\ndata: [DONE]\n\n").as_bytes()).await.unwrap();
        }
    });
    let settings = fixture.read("maka.agent-graph", "settings", json!({"kind":"read"}));
    fixture.read("maka.agent-graph", "settings", json!({"kind":"replace","snapshot":{
        "revision":settings["revision"],"presets":[{"id":"reader","name":"Reader","description":"Synthetic reader",
        "profile":"local_read","connectionSlug":"tui-fixture","model":"fixture-model","enabled":true}]}}));
    fixture.runtime.block_on(async {
        fixture.client.create_session(maka_protocol::session::decode_session_create_input(&json!({
            "sessionId":SESSION,"name":"Graph reading","workspace":{"kind":"host_path","path":fixture.directory.path()},
            "modelTarget":{"kind":"default"},"orchestrationMode":"graph"
        })).unwrap()).await.unwrap();
        let binding = binding("authorize");
        let RemoteResult::Bound { target, .. } = fixture.client.plugin_remote(RemoteRequest::Bind { binding: binding.clone() }).await.unwrap() else { panic!("authorization binding") };
        let grant = fixture.client.request(Operation::PluginAuthorization, json!({"binding":binding,"target":target,
            "command":{"kind":"approve","request":{"operationId":uuid::Uuid::new_v4(),"title":"Synthetic Graph reading",
                "target":{"kind":"session","sessionId":SESSION},"capabilities":["executions"]}}})).await.unwrap();
        call(&fixture.client, "authorize", json!({"kind":"remember","id":grant["grant"]["id"]})).await;
        fixture.client.request(Operation::TurnStart, json!({"sessionId":SESSION,"turnId":"graph-reading-start",
            "content":{"text":"Coordinate this synthetic reading test."}})).await.unwrap();
        let graph = tokio::time::timeout(Duration::from_secs(60), async {
            loop {
                let epochs = call(&fixture.client, "query", json!({"kind":"epochs"})).await;
                if let Some(graph) = epochs["epochs"][0]["graphId"].as_str() {
                    let mut after = Value::Null;
                    let mut completed = 0;
                    loop {
                        let page = call(&fixture.client, "query", json!({"kind":"snapshot","graphId":graph,"after":after})).await;
                        completed += page["graph"]["work"].as_array().unwrap().iter().filter(|work| work["execution"]["state"] == "completed").count();
                        after = page["graph"]["nextAfter"].clone();
                        if after.is_null() { break; }
                    }
                    if completed == 17 { break graph.to_owned(); }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.unwrap();
        for locale in ["en", "zh-CN", "zh-TW"] {
            let first = read(&fixture.client, Value::Null, locale).await;
            let next = route(&first.root, "next").unwrap();
            let second = read(&fixture.client, next, locale).await;
            let mut works = BTreeSet::new();
            work_ids(&first.root, &mut works);
            work_ids(&second.root, &mut works);
            assert_eq!(works.len(), 17);
            assert!(route(&second.root, "next").is_none());
            let reset = read(&fixture.client, route(&second.root, "first").unwrap(), locale).await;
            assert_eq!(reset.root, first.root);
            let mut reading = second.root.children().into_iter().find_map(work_route).unwrap();
            assert_eq!(reading["graph"], graph);
            assert!(reading["result"].is_string());
            let work = reading["work"].clone();
            let result = reading["result"].clone();
            for (section, expected, offset) in [("instruction", instruction.as_str(), "instruction_offset"), ("answer", answer.as_str(), "result_offset")] {
                let mut recovered = String::new();
                loop {
                    let view = read(&fixture.client, reading.clone(), locale).await;
                    let section = find(&view.root, section).unwrap();
                    let Node::Markdown { text, .. } = find(section, "text").unwrap() else { panic!("page text") };
                    assert_eq!(reading[offset].as_u64().unwrap() as usize, recovered.len());
                    recovered.push_str(text);
                    let Some(next) = route(section, "next") else { break; };
                    assert_eq!(next["work"], work);
                    assert_eq!(next["result"], result);
                    assert!(expected.is_char_boundary(next[offset].as_u64().unwrap() as usize));
                    reading = next;
                }
                assert_eq!(recovered, expected);
            }
            // Invalidated schedule cursors offer a bounded, explicit restart.
            let mut stale = route(&first.root, "next").unwrap();
            stale["after"]["revision"] = json!(999);
            let changed = read(&fixture.client, stale, locale).await;
            let reopened = read(&fixture.client, route(&changed.root, "restart").unwrap(), locale).await;
            assert_eq!(reopened.root, first.root);
        }
        call(&fixture.client, "stop", json!({"graphId":graph})).await;
    });
    model.abort();
    fixture.runtime.block_on(async {
        assert!(model.await.unwrap_err().is_cancelled());
    });
    let mut tui = fixture.tui();
    tui.resize(170, 40);
    tui.wait_for("Graph reading");
    tui.click_text("Graph reading");
    tui.wait_until(|screen| {
        screen.contains("Message…") && !screen.contains("Loading conversation")
    });
    if tui
        .screen
        .snapshot()
        .unwrap()
        .screen
        .contains("Conversation unavailable")
    {
        tui.click_last_text("ⓘ");
        tui.wait_for("ID: graph-reading");
        panic!(
            "Graph conversation failed:\n{}",
            tui.screen.snapshot().unwrap().screen
        );
    }
    tui.wait_for("◨");
    tui.click_text("◨");
    tui.wait_for("Give this session an objective");
    reveal(&mut tui, "Next work items");
    tui.wait_for("Page 16/16");
    tui.wait_for("17 work items");
    reading::click(&mut tui, "Next work items");
    tui.wait_for("Page 1/1");
    reading::click(&mut tui, "Graph reading instruction");
    reading::reveal(&mut tui, "Next instruction page");
    reading::click(&mut tui, "Next instruction page");
    reading::reveal(&mut tui, "tail instruction");
    reading::reveal(&mut tui, "Next result page");
    reading::click(&mut tui, "Next result page");
    reading::reveal(&mut tui, "tail result");
    // Each back restores the preceding offsets and its reading position.
    eprintln!("Graph reading: Back to the preceding result page");
    tui.send(b"\x1b[1;3D");
    tui.wait_for("Next result page");
    eprintln!("Graph reading: Back to the preceding instruction page");
    tui.send(b"\x1b[1;3D");
    tui.wait_for("Next instruction page");
    eprintln!("Graph reading: Back to the second work page");
    tui.send(b"\x1b[1;3D");
    tui.wait_for("Page 1/1");
    reading::click(&mut tui, "First work items");
    tui.wait_for("Page 16/16");
    tui.close_terminal();
    tui.finish();
    fixture.client.disconnect();
    fixture.host.retire_registered();
    assert!(fixture.host.wait_for_exit().success());
}

fn binding(method: &str) -> RemoteBinding {
    RemoteBinding::Package {
        package_id: "maka.agent-graph".into(),
        method: method.into(),
        session_id: Some(SESSION.into()),
    }
}

async fn call(client: &maka_client::Client, method: &str, input: Value) -> Value {
    let binding = binding(method);
    let RemoteResult::Bound { target, .. } = client
        .plugin_remote(RemoteRequest::Bind {
            binding: binding.clone(),
        })
        .await
        .unwrap()
    else {
        panic!("Graph binding")
    };
    let RemoteResult::Document { document } = client
        .plugin_remote(RemoteRequest::OpenDocument)
        .await
        .unwrap()
    else {
        panic!("Graph document")
    };
    let result = client
        .plugin_remote(RemoteRequest::Call {
            binding,
            target,
            document,
            input,
        })
        .await;
    client
        .plugin_remote(RemoteRequest::CloseDocument { document })
        .await
        .unwrap();
    let RemoteResult::Value { value } = result.unwrap() else {
        panic!("Graph reply")
    };
    value
}

async fn read(client: &maka_client::Client, route: Value, locale: &str) -> View {
    let reply = call(
        client,
        "terminal",
        json!({"kind":"read","route":route,"locale":locale}),
    )
    .await;
    let view: View = serde_json::from_value(reply["view"].clone()).unwrap();
    view.validate().unwrap();
    view
}

fn find<'a>(node: &'a Node, key: &str) -> Option<&'a Node> {
    if node.key() == key {
        return Some(node);
    }
    node.children()
        .into_iter()
        .find_map(|child| find(child, key))
}

fn route(node: &Node, key: &str) -> Option<Value> {
    match find(node, key)? {
        Node::Item {
            target: Target::Route { route },
            ..
        } => Some(route.clone()),
        _ => None,
    }
}

fn work_route(node: &Node) -> Option<Value> {
    if let Node::Item {
        target: Target::Route { route },
        ..
    } = node
        && route["kind"] == "work"
    {
        return Some(route.clone());
    }
    node.children().into_iter().find_map(work_route)
}

fn work_ids(node: &Node, ids: &mut BTreeSet<String>) {
    if let Node::Item {
        target: Target::Route { route },
        ..
    } = node
        && route["kind"] == "work"
    {
        assert!(ids.insert(route["work"].as_str().unwrap().to_owned()));
    }
    for child in node.children() {
        work_ids(child, ids);
    }
}
