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

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use crate::support::store::SessionFixture;
use maka_agent_engine::{Engine, project_model_history};
use maka_agent_facts::event::{Fact, TerminalStatus};
use maka_agent_facts::model::prompt::{AssistantPart, Message, ToolOutput};
use maka_agent_facts::model::{ModelEvent, ToolInput};
use maka_agent_facts::tool_call::ToolRejection;
use maka_code_runtime::CellLimits;
use maka_model::ModelExecutor;
use maka_tools::CodeExecutor;
use maka_tools::ToolMode;
use serde_json::json;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::support::{agent_loop as fixture, http::read_request};

const RAW: &str = "{\"n\":";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn malformed_direct_arguments_are_rejected_and_corrected() {
    malformed_arguments_are_rejected_and_corrected(ToolMode::Direct).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn malformed_exec_arguments_are_rejected_and_corrected() {
    malformed_arguments_are_rejected_and_corrected(ToolMode::CodeMode).await;
}

async fn malformed_arguments_are_rejected_and_corrected(mode: ToolMode) {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let name = if mode == ToolMode::Direct { "echo" } else { "exec" };
        let corrected = if mode == ToolMode::Direct {
            json!({"n":7})
        } else {
            json!({"code":"text(await tools.echo({n:7}));"})
        };
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for (id, arguments) in [
                ("malformed-call", RAW.to_owned()),
                ("corrected-call", corrected.to_string()),
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(read_request(&mut socket).await);
                crate::dynamic_tools::respond_tools(
                    &mut socket,
                    vec![json!({"index":0,"id":id,"type":"function",
                        "function":{"name":name,"arguments":arguments}})],
                    10,
                ).await;
            }
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(read_request(&mut socket).await);
            fixture::respond(&mut socket, false).await;
            requests
        });
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(SessionFixture::open(&directory.path().join("events.sqlite")).await.unwrap());
        let count = Arc::new(AtomicUsize::new(0));
        let engine = Engine::new(
            ModelExecutor::new(Duration::from_secs(5)).unwrap(),
            CodeExecutor::new(CellLimits::default()).unwrap(),
        ).unwrap();
        let mut input = fixture::input(&base, "arguments", Arc::new(fixture::Effect {
            log: log.clone(), count: count.clone(),
        }));
        input.configuration.tool_mode = mode;
        // Await the run before joining the server: the original adapter failure
        // must fail this assertion immediately rather than wait for another request.
        engine.run(log.store(), input, CancellationToken::new()).await
            .expect("malformed arguments must be a recoverable tool rejection");
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let messages = requests[1]["messages"].as_array().unwrap();
        let call = messages.iter().find(|message| message["role"] == "assistant")
            .unwrap()["tool_calls"][0].clone();
        assert_eq!(call["id"], "malformed-call");
        assert_eq!(call["function"]["name"], name);
        assert_eq!(call["function"]["arguments"], "{}");
        let result = messages.iter().find(|message| message["role"] == "tool").unwrap();
        assert_eq!(result["tool_call_id"], "malformed-call");
        assert_diagnostic(result["content"].as_str().unwrap());

        let prefix = log.prefix(100, 128 * 1024).await.unwrap();
        assert_eq!(prefix.project_invocation("invocation-arguments").terminal,
            Some(TerminalStatus::Completed));
        let rejections: Vec<_> = prefix.events.iter().filter_map(|stored| {
            if let Fact::ToolRejected { call, name, reason, .. } = &stored.event.fact {
                Some((call, name, reason))
            } else { None }
        }).collect();
        assert_eq!(rejections.len(), 1);
        assert!(prefix.events.iter().any(|stored| matches!(&stored.event.fact,
            Fact::ModelObserved { event: ModelEvent::ToolCall(call), .. }
                if call.id == "malformed-call" && call.name == name
                    && call.input == ToolInput::InvalidJson { raw: RAW.into() })));
        let rejected_input = prefix.events.iter().find_map(|stored| {
            if let Fact::ToolRejected { input, .. } = &stored.event.fact { Some(input) } else { None }
        }).unwrap();
        assert_eq!(rejected_input, &ToolInput::InvalidJson { raw: RAW.into() });
        assert_eq!(rejections[0].0.tool_call_id, "malformed-call");
        assert_eq!(rejections[0].1, name);
        assert!(matches!(rejections[0].2, ToolRejection::InvalidInput { .. }));
        let effects: Vec<_> = prefix.events.iter().filter_map(|stored| {
            if let Fact::ToolDispatched { call, name, input, .. } = &stored.event.fact {
                assert_ne!(call.tool_call_id, "malformed-call");
                (name == "echo").then_some(input)
            } else { None }
        }).collect();
        assert_eq!(effects, vec![&json!({"n":7})]);
        let history = project_model_history(&prefix, "session", maka_agent_facts::language::Language::En).unwrap();
        let rejected = history.iter().find_map(|message| {
            if let Message::Tool { content, .. } = message {
                content.iter().find(|result| result.tool_call_id == "malformed-call")
            } else { None }
        }).unwrap();
        assert_eq!(rejected.tool_name, name);
        let ToolOutput::ErrorText(error) = &rejected.output else {
            panic!("rejected arguments must project as ErrorText");
        };
        assert_diagnostic(error);
        assert!(history.iter().any(|message| matches!(message,
            Message::Assistant { content, .. }
                if content.iter().any(|part| matches!(part, AssistantPart::Text { text, .. } if text == "done")))));
        engine.drain().await;
        drop(engine);
        Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
        let reopened = SessionFixture::open(&directory.path().join("events.sqlite")).await.unwrap();
        let replay = reopened.prefix(100, 128 * 1024).await.unwrap();
        assert_eq!(project_model_history(&replay, "session", maka_agent_facts::language::Language::En).unwrap(), history);
        assert_eq!(replay.events.iter().filter(|stored| matches!(stored.event.fact,
            Fact::ToolRejected { .. })).count(), 1);
    }).await.expect("argument correction must make bounded progress");
}

fn assert_diagnostic(error: &str) {
    assert!(
        error.contains("Invalid tool arguments JSON: "),
        "missing parse diagnostic: {error}"
    );
    let escaped = serde_json::to_string(RAW).unwrap();
    assert!(
        error.contains(&format!("Raw arguments: {escaped}")),
        "original malformed argument text must reach the model: {error}"
    );
}

#[tokio::test]
async fn recovered_malformed_arguments_keep_raw_diagnostics_for_every_rejection_reason() {
    use crate::support::recovery_session as recovery;
    use maka_agent_facts::model::{ModelFinishReason, ModelPart, ModelStep, ModelToolCall};
    use maka_agent_facts::tool_call::ToolCallIdentity;

    for reason in [
        ToolRejection::Cancelled,
        ToolRejection::PreparationFailed {
            message: "model response was incomplete".into(),
        },
        ToolRejection::ExclusiveConflict,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let log = SessionFixture::open(&path).await.unwrap();
        recovery::opening(&log).await;
        recovery::request(&log).await;
        recovery::append(
            &log,
            Fact::ModelCompleted {
                step_id: "step".into(),
                output: ModelStep {
                    parts: vec![ModelPart::ToolCall {
                        call: ModelToolCall {
                            id: "malformed-call".into(),
                            name: "echo".into(),
                            input: ToolInput::InvalidJson { raw: RAW.into() },
                            provider_options: None,
                            provider_executed: false,
                        },
                    }],
                    finish_reason: ModelFinishReason::ToolCalls,
                    usage: Default::default(),
                    provider_options: None,
                    response_id: None,
                    model: None,
                    timestamp: None,
                },
            },
        )
        .await;
        recovery::append(
            &log,
            Fact::ToolRejected {
                operation_id: "step:malformed-call".into(),
                call: ToolCallIdentity::provider("step".into(), "malformed-call".into()),
                name: "echo".into(),
                input: ToolInput::InvalidJson { raw: RAW.into() },
                reason: reason.clone(),
            },
        )
        .await;
        recovery::append(
            &log,
            Fact::InvocationEnded {
                outcome: maka_agent_facts::event::InvocationOutcome::Completed,
            },
        )
        .await;
        let prefix = log.prefix(100, 128 * 1024).await.unwrap();
        let history =
            project_model_history(&prefix, "session", maka_agent_facts::language::Language::En)
                .unwrap();
        let Message::Tool { content, .. } = history.last().unwrap() else {
            panic!("rejected tool result must remain model-visible");
        };
        assert_eq!(content.len(), 1);
        assert_eq!(content[0].tool_call_id, "malformed-call");
        let ToolOutput::ErrorText(error) = &content[0].output else {
            panic!("rejection must project as ErrorText");
        };
        assert!(error.starts_with(&format!("{reason}\n")));
        assert_diagnostic(error);
        assert!(matches!(&prefix.events[3].event.fact,
            Fact::ToolRejected { reason: persisted, .. } if persisted == &reason));
        log.close().await.unwrap();
        let reopened = SessionFixture::open(&path).await.unwrap();
        assert_eq!(
            project_model_history(
                &reopened.prefix(100, 128 * 1024).await.unwrap(),
                "session",
                maka_agent_facts::language::Language::En
            )
            .unwrap(),
            history
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_malformed_arguments_survive_transport_interruption_without_reexecution() {
    use futures_util::{SinkExt, StreamExt};
    use maka_model::ProviderKind;
    use serde_json::Value;
    use tokio_tungstenite::{accept_async, tungstenite::Message as Frame};

    tokio::time::timeout(Duration::from_secs(20), async {
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(
            SessionFixture::open(&directory.path().join("events.sqlite"))
                .await
                .unwrap(),
        );
        let count = Arc::new(AtomicUsize::new(0));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let observed = log.clone();
        let mut commits = log.subscribe_commits();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(socket).await.unwrap();
            socket.next().await.unwrap().unwrap();
            let malformed = json!({"type":"function_call","id":"invalid-item",
                "call_id":"malformed-call","name":"echo","arguments":RAW});
            socket
                .send(Frame::Text(
                    json!({"type":"response.output_item.done",
                "output_index":0,"item":malformed})
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
            loop {
                let prefix = observed.prefix(100, 128 * 1024).await.unwrap();
                if prefix.events.iter().any(|stored| {
                    matches!(&stored.event.fact,
                    Fact::ToolRejected { call, .. } if call.tool_call_id == "malformed-call")
                }) {
                    assert!(!prefix.events.iter().any(|stored| matches!(
                        stored.event.fact,
                        Fact::ModelCompleted { .. } | Fact::ToolDispatched { .. }
                    )));
                    break;
                }
                commits.changed().await.unwrap();
            }
            // The accepted invalid call and its durable rejection must survive
            // a real connection loss before response.completed.
            socket.close(None).await.unwrap();
            drop(socket);
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(socket).await.unwrap();
            let retry: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            assert!(retry.get("previous_response_id").is_none());
            let carried: Vec<_> = retry["input"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|item| item["call_id"] == "malformed-call")
                .collect();
            assert_eq!(carried.len(), 2);
            assert_eq!(carried[0]["type"], "function_call");
            assert_eq!(carried[0]["name"], "echo");
            assert_eq!(carried[0]["arguments"], RAW);
            assert_eq!(carried[1]["type"], "function_call_output");
            assert_diagnostic(carried[1]["output"].as_str().unwrap());
            let corrected = json!({"type":"function_call","id":"corrected-item",
                "call_id":"corrected-call","name":"echo","arguments":"{\"n\":7}"});
            socket
                .send(Frame::Text(
                    json!({"type":"response.completed",
                "response":{"id":"corrected-response","output":[corrected]}})
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
            let next: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            assert!(next["input"].as_array().unwrap().iter().any(|item| {
                item["type"] == "function_call_output"
                    && item["call_id"] == "corrected-call"
                    && item["output"].as_str().is_some_and(|output| {
                        serde_json::from_str::<Value>(output).unwrap() == json!({"n":7})
                    })
            }));
            socket
                .send(Frame::Text(
                    json!({"type":"response.completed",
                "response":{"id":"final","output":[{"type":"message","id":"answer",
                    "content":[{"type":"output_text","text":"done"}]}]}})
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
        });
        let mut input = fixture::input(
            &base,
            "retained-invalid",
            Arc::new(fixture::Effect {
                log: log.clone(),
                count: count.clone(),
            }),
        );
        input.provider.kind = ProviderKind::OpenaiResponses;
        input.provider_options = json!({"openai":{"store":false}});
        let engine = Engine::new(
            ModelExecutor::new(Duration::from_secs(10)).unwrap(),
            CodeExecutor::new(CellLimits::default()).unwrap(),
        )
        .unwrap();
        engine
            .run(log.store(), input, CancellationToken::new())
            .await
            .unwrap();
        engine.drain().await;
        server.await.unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let prefix = log.prefix(100, 128 * 1024).await.unwrap();
        assert_eq!(
            prefix
                .events
                .iter()
                .filter(|stored| matches!(stored.event.fact, Fact::ToolRejected { .. }))
                .count(),
            1
        );
        assert_eq!(
            prefix
                .events
                .iter()
                .filter(|stored| matches!(stored.event.fact, Fact::ToolDispatched { .. }))
                .count(),
            1
        );
        assert_eq!(
            prefix
                .events
                .iter()
                .filter(|stored| matches!(
                    stored.event.fact,
                    Fact::ModelInterrupted {
                        status: maka_agent_facts::event::ModelInterruption::RetryableFailure,
                        ..
                    }
                ))
                .count(),
            1
        );
        assert_eq!(
            prefix
                .project_invocation("invocation-retained-invalid")
                .terminal,
            Some(TerminalStatus::Completed)
        );
    })
    .await
    .expect("accepted malformed call must survive reconnect and permit correction");
}
