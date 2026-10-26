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
use maka_agent_facts::event::{Fact, InvocationOutcome, LogScope};

const AFFECTED: [&str; 5] = [
    "workhub_tasks",
    "agent_list",
    "view_agent_graph",
    "update_agent_graph",
    "ScheduledTask",
];
const EMPTY: [&str; 2] = ["yield_agent_graph", "agent_swarm_status"];

#[derive(Clone, Copy)]
enum Wire {
    Compatible,
    Anthropic,
}

struct Captured {
    schemas: BTreeMap<String, Value>,
    violations: Vec<String>,
    results: Vec<Value>,
    tool_choice: Value,
}

pub(super) async fn read_wire(socket: &mut TcpStream) -> Value {
    http_fixture::read_request(socket).await.1
}

async fn send_body(socket: &mut TcpStream, status: &str, content_type: &str, body: String) {
    socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}

pub(super) async fn anthropic_text_reply(socket: &mut TcpStream, text: &str) {
    let events = [
        json!({"type":"message_start","message":{"id":"auxiliary-reply","type":"message","role":"assistant","model":"fixture-model","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}),
        json!({"type":"message_stop"}),
    ];
    let body = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect();
    send_body(socket, "200 OK", "text/event-stream", body).await;
}

async fn model_reply(socket: &mut TcpStream, wire: Wire, call: Option<(&str, &str, Value)>) {
    let tool_call = call.is_some();
    let events = match wire {
        Wire::Compatible => {
            let delta = match call {
                Some((id, name, arguments)) => {
                    json!({"tool_calls":[{"index":0,"id":id,"type":"function","function":{"name":name,"arguments":arguments.to_string()}}]})
                }
                None => json!({"content":"Catalog operations completed"}),
            };
            let reason = if tool_call { "tool_calls" } else { "stop" };
            vec![
                json!({"id":"schema-reply","choices":[{"index":0,"delta":delta,"finish_reason":null}]}),
                json!({"id":"schema-reply","choices":[{"index":0,"delta":{},"finish_reason":reason}],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}),
            ]
        }
        Wire::Anthropic => {
            let mut events = vec![
                json!({"type":"message_start","message":{"id":"schema-reply","type":"message","role":"assistant","model":"fixture-model","content":[],"usage":{"input_tokens":2,"output_tokens":0}}}),
            ];
            if let Some((id, name, arguments)) = call {
                events.extend([
                    json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":id,"name":name,"input":{}}}),
                    json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":arguments.to_string()}}),
                ]);
            } else {
                events.extend([
                    json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
                    json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Catalog operations completed"}}),
                ]);
            }
            events.extend([
                json!({"type":"content_block_stop","index":0}),
                json!({"type":"message_delta","delta":{"stop_reason":if tool_call {"tool_use"} else {"end_turn"},"stop_sequence":null},"usage":{"output_tokens":2}}),
                json!({"type":"message_stop"}),
            ]);
            events
        }
    };
    let mut body: String = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect();
    if matches!(wire, Wire::Compatible) {
        body.push_str("data: [DONE]\n\n");
    }
    send_body(socket, "200 OK", "text/event-stream", body).await;
}

fn settled_result(body: &Value, wire: Wire, id: &str) -> Value {
    let messages = body["messages"].as_array().unwrap();
    let output = match wire {
        Wire::Compatible => messages
            .iter()
            .rev()
            .find(|message| message["role"] == "tool" && message["tool_call_id"] == id)
            .map(|message| &message["content"]),
        Wire::Anthropic => messages
            .iter()
            .rev()
            .filter_map(|message| message["content"].as_array())
            .flatten()
            .find(|part| part["type"] == "tool_result" && part["tool_use_id"] == id)
            .map(|part| &part["content"]),
    };
    output
        .map(|output| {
            output
                .as_str()
                .and_then(|text| serde_json::from_str(text).ok())
                .unwrap_or_else(|| output.clone())
        })
        .unwrap_or(Value::Null)
}

async fn strict_provider(listener: TcpListener, wire: Wire) -> Captured {
    let (mut socket, _) = listener.accept().await.unwrap();
    let request = read_wire(&mut socket).await;
    let mut captured = Captured {
        schemas: BTreeMap::new(),
        violations: Vec::new(),
        results: Vec::new(),
        tool_choice: request["tool_choice"].clone(),
    };
    for tool in request["tools"].as_array().unwrap() {
        let (name, schema) = match wire {
            Wire::Compatible => (
                tool["function"]["name"].as_str().unwrap(),
                &tool["function"]["parameters"],
            ),
            Wire::Anthropic => (tool["name"].as_str().unwrap(), &tool["input_schema"]),
        };
        captured.schemas.insert(name.into(), schema.clone());
        if schema["type"] != "object"
            || ["oneOf", "anyOf", "allOf"]
                .iter()
                .any(|key| schema.get(*key).is_some())
        {
            captured.violations.push(format!(
                "{name}: root type must be object without root combinators; actual schema: {schema}"
            ));
        }
    }
    if !captured.violations.is_empty() {
        let message = captured.violations.join("\n");
        let error = match wire {
            Wire::Compatible => {
                json!({"error":{"message":message,"type":"invalid_request_error","code":"invalid_function_parameters"}})
            }
            Wire::Anthropic => {
                json!({"type":"error","error":{"type":"invalid_request_error","message":message}})
            }
        };
        send_body(
            &mut socket,
            "400 Bad Request",
            "application/json",
            error.to_string(),
        )
        .await;
        return captured;
    }
    model_reply(
        &mut socket,
        wire,
        Some((
            "workers",
            "workhub_tasks",
            json!({"request":{"operation":"workers"}}),
        )),
    )
    .await;
    let (mut socket, _) = listener.accept().await.unwrap();
    let next = read_wire(&mut socket).await;
    captured
        .results
        .push(settled_result(&next, wire, "workers"));
    model_reply(
        &mut socket,
        wire,
        Some((
            "schedule",
            "ScheduledTask",
            json!({"request":{"mode":"list"}}),
        )),
    )
    .await;
    let (mut socket, _) = listener.accept().await.unwrap();
    let next = read_wire(&mut socket).await;
    captured
        .results
        .push(settled_result(&next, wire, "schedule"));
    model_reply(&mut socket, wire, None).await;
    captured
}

async fn select_swarm(fixture: &Fixture, session: &str) {
    let client = fixture.app.client();
    let binding = client
        .bind(
            client.activation(&id(2)).unwrap(),
            maka_agent_api::workhub::EXPORT.into(),
        )
        .await
        .unwrap()
        .remove(0);
    let prepared = client
        .prepare_mutation(
            binding,
            "changeGraph".into(),
            json!({"sessionId":session,"action":{"kind":"start","mode":"swarm"}}),
            scope(&fixture.issuer, true),
            Uuid::new_v4(),
            Attachments::default().into(),
        )
        .await
        .unwrap();
    let reply = client.mutate_owned(prepared).await.unwrap().result().await;
    match reply.receipt {
        Receipt::Recorded {
            outcome: OperationOutcome::Returned { value },
            cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
        } => assert_eq!(value["kind"], "committed", "{value}"),
        other => panic!("swarm selection failed: {other:?}"),
    }
}

async fn coordinator_catalog_completes(wire: Wire, provider: &str) {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let mut fixture = Fixture::configured_provider(
            &base,
            None,
            None,
            None,
            |settings| {
                settings.scheduled_tasks = true;
                settings.recall = true;
                settings.plans = true;
                settings.goals = true;
                settings.todo = true;
            },
            provider,
        )
        .await;
        if matches!(wire, Wire::Anthropic) {
            selection::edit(&fixture, |changes| {
                changes.model_overrides = Patch::Set(BTreeMap::from([(
                    "fixture-model".into(),
                    ModelOverride {
                        capabilities: Some(
                            serde_json::from_value(json!({"parallelToolCalls":false})).unwrap(),
                        ),
                        ..Default::default()
                    },
                )]));
            })
            .await;
        }
        workhub::activate_workers(&mut fixture, true, true, true).await;
        let ready =
            workhub::resolve(&fixture, workhub::selection(&fixture).await, Uuid::new_v4()).await;
        let session = ready["session"]["id"].as_str().unwrap().to_owned();
        select_swarm(&fixture, &session).await;
        let server = tokio::spawn(strict_provider(listener, wire));
        let sent = fixture.send(&session).await.unwrap();
        let outcome = loop {
            let facts = fixture
                .session(&(session))
                .await
                .scoped_prefix(
                    LogScope::Session {
                        id: session.clone(),
                    },
                    512,
                    8 * 1024 * 1024,
                )
                .await
                .unwrap();
            if let Some(outcome) = facts.events.iter().find_map(|row| {
                if row.event.invocation.invocation_id == sent["invocationId"].as_str().unwrap()
                    && let Fact::InvocationEnded { outcome } = &row.event.fact
                {
                    Some(outcome.clone())
                } else {
                    None
                }
            }) {
                break outcome;
            }
            tokio::task::yield_now().await;
        };
        let captured = server.await.unwrap();
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
        if matches!(wire, Wire::Anthropic) {
            assert_eq!(
                captured.tool_choice["disable_parallel_tool_use"], true,
                "the actual Anthropic request must retain the declared parallel opt-out"
            );
        }
        for name in AFFECTED.into_iter().chain(EMPTY) {
            assert!(
                captured.schemas.contains_key(name),
                "actual coordinator catalog omitted {name}: {:?}",
                captured.schemas.keys()
            );
        }
        assert_eq!(
            outcome,
            InvocationOutcome::Completed,
            "{provider} rejected actual coordinator catalog: {:?}",
            captured.violations
        );
        assert_eq!(captured.violations, Vec::<String>::new());
        assert_eq!(
            captured.results,
            vec![
                json!({"workers":[{"name":"worker","available":true}]}),
                json!({"tasks":[],"nextCursor":null})
            ]
        );
    })
    .await
    .expect("actual coordinator provider request must settle");
}

#[tokio::test]
async fn coordinator_native_tool_schemas_complete_through_compatible_http() {
    coordinator_catalog_completes(Wire::Compatible, "openai-compatible").await;
}

#[tokio::test]
async fn coordinator_native_tool_schemas_complete_through_anthropic_http() {
    coordinator_catalog_completes(Wire::Anthropic, "anthropic").await;
}
