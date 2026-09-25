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

use crate::support::invocation;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use maka_agent::{Engine, RunError, RunInput};
use maka_event_log::EventLog;
use maka_js_runtime::{CellLimits, CodeExecutor};
use maka_model::{ModelExecutor, ProviderConfig, ProviderKind};
use maka_runtime::event::{Fact, Invocation, InvocationOutcome, ToolOutcome};
use maka_runtime::tool_call::{ToolCallIdentity, ToolOrigin, ToolRejection};
use maka_runtime::tools::{ToolExecutor, ToolFuture};
use maka_tools::{
    ToolCatalog, ToolDefinition, ToolHandler, ToolMode, ToolNesting, ToolRegistration,
    ToolSemantics,
};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Default)]
struct Effect {
    entered: Arc<Notify>,
    cancelled: Arc<Notify>,
    release: Arc<Notify>,
    count: Arc<AtomicUsize>,
}

impl ToolExecutor for Effect {
    fn names(&self) -> Vec<String> {
        vec!["echo".into()]
    }

    fn invoke(&self, _name: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let effect = self.clone();
        Box::pin(async move {
            effect.count.fetch_add(1, Ordering::SeqCst);
            effect.entered.notify_one();
            cancellation.cancelled().await;
            effect.cancelled.notify_one();
            // This dispatched native effect must finish even after cancellation.
            effect.release.notified().await;
            Ok(input)
        })
    }
}

fn input(base: &str, suffix: &str, effect: Arc<Effect>) -> RunInput {
    RunInput {
        model_source: None,
        model_revision: None,
        provider_id: "fixture".into(),
        main_output_limit: None,
        context: None,
        invocation: Invocation {
            session_id: "session".into(),
            turn_id: format!("turn-{suffix}"),
            run_id: format!("run-{suffix}"),
            invocation_id: format!("invocation-{suffix}"),
        },
        request_fingerprint: None,
        provider: ProviderConfig {
            adapter: None,
            capabilities: Default::default(),
            kind: ProviderKind::OpenaiChat,
            model: "test".into(),
            base_url: base.into(),
            auth: maka_model::ProviderAuth::ApiKey("test-key".into()),
            headers: BTreeMap::new(),
            network: Default::default(),
            body_overlay: None,
        },
        provider_options: json!({}),
        supports_vision: false,
        configuration: invocation::configuration(ToolMode::Direct),
        work: maka_agent::RunWork::Message {
            allow_prior_unknown: false,
            source_messages: Vec::new(),
            message: format!("question {suffix}").into(),
            tools: ToolCatalog::new([ToolRegistration {
                definition: ToolDefinition {
                    freeform: None,
                    output_schema: None,
                    provider: None,
                    name: "echo".into(),
                    description: "echo".into(),
                    input_schema: json!({"type":"object"}),
                },
                nesting: ToolNesting::Nestable,
                semantics: ToolSemantics::Parallel,
                handler: ToolHandler::Immediate(effect),
            }])
            .unwrap(),
            max_steps: 3,
        },
    }
}

use crate::support::http;
use http::read_request;
async fn respond(socket: &mut TcpStream, tool: bool) {
    let delta = if tool {
        json!({"tool_calls":[
            {"index":0,"id":"call-1","type":"function","function":{"name":"echo","arguments":"{\"value\":42}"}},
            {"index":1,"id":"call-2","type":"function","function":{"name":"echo","arguments":"{\"value\":43}"}}
        ]})
    } else {
        json!({"content":"done"})
    };
    let first = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
    let last = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":if tool {"tool_calls"} else {"stop"}}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}});
    let body = format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n");
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn aborted_caller_cancels_worker_but_retains_admission_until_effect_is_durable() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for index in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(read_request(&mut socket).await);
                respond(&mut socket, index == 0).await;
            }
            requests
        });
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let effect = Arc::new(Effect::default());
        {
            let log = Arc::new(EventLog::open(&path).await.unwrap());
            let engine = Engine::new(
                log.clone(),
                ModelExecutor::new(1, Duration::from_secs(10)).unwrap(),
                CodeExecutor::new(2, CellLimits::default()).unwrap(),
            );
            let caller_token = CancellationToken::new();
            let running_engine = engine.clone();
            let running_input = input(&base, "aborted", effect.clone());
            let running_token = caller_token.clone();
            let caller =
                tokio::spawn(async move { running_engine.run(running_input, running_token).await });
            effect.entered.notified().await;
            caller.abort();
            assert!(caller.await.unwrap_err().is_cancelled());
            effect.cancelled.notified().await;
            assert!(
                !caller_token.is_cancelled(),
                "dropping a run must only cancel its child token"
            );
            let held = log.prefix(100, 128 * 1024).await.unwrap();
            assert!(matches!(
                held.events.last().unwrap().event.fact,
                Fact::ToolDispatched { .. }
            ));
            assert_eq!(held.project_invocation("invocation-aborted").terminal, None);
            assert!(matches!(
                engine
                    .run(input(&base, "blocked", effect.clone()), CancellationToken::new())
                    .await,
                Err(RunError::Busy)
            ));
            assert_eq!(
                log.prefix(100, 128 * 1024).await.unwrap().high_water,
                held.high_water,
                "rejected admission and caller abort must not seal a live effect"
            );

            effect.release.notify_one();
            // The detached worker has no join handle exposed by Engine. Retry
            // admission with cooperative yields until its drain has completed.
            loop {
                match engine
                    .run(input(&base, "next", effect.clone()), CancellationToken::new())
                    .await
                {
                    Err(RunError::Busy) => tokio::task::yield_now().await,
                    result => {
                        result.unwrap();
                        break;
                    }
                }
            }
            let settled = log.prefix(100, 128 * 1024).await.unwrap();
            let aborted: Vec<_> = settled
                .events
                .iter()
                .filter(|stored| stored.event.invocation.invocation_id == "invocation-aborted")
                .collect();
            let boundaries: Vec<_> = aborted
                .iter()
                .copied()
                .filter(|stored| !matches!(stored.event.fact, Fact::ModelObserved { .. }))
                .collect();
            for observation in aborted
                .iter()
                .filter(|stored| matches!(stored.event.fact, Fact::ModelObserved { .. }))
            {
                assert!(
                    boundaries[1].sequence < observation.sequence
                        && observation.sequence < boundaries[2].sequence
                );
            }
            let aborted = boundaries;
            assert_eq!(
                aborted
                    .iter()
                    .map(|stored| stored.event.fact.kind())
                    .collect::<Vec<_>>().join(","),
                "invocation_opened,model_requested,model_completed,tool_dispatched,tool_settled,tool_rejected,invocation_ended"
            );
            let Fact::ToolDispatched { operation_id, call, .. } = &aborted[3].event.fact else {
                unreachable!()
            };
            let ToolOrigin::Provider { step_id } = &call.origin else {
                panic!("direct tool calls must preserve their provider step")
            };
            assert!(matches!(&aborted[4].event.fact,
                Fact::ToolSettled { operation_id: settled, outcome: ToolOutcome::Succeeded { .. } } if settled == operation_id));
            assert_eq!(log.resolve_tool_result(&aborted[4].event.invocation.session_id, &aborted[4].event.id).await.unwrap().into_json(), json!({"value":42}));
            assert_eq!(aborted[5].event.fact, Fact::ToolRejected {
                operation_id: format!("{step_id}:call-2"),
                call: ToolCallIdentity::provider(step_id.clone(), "call-2".into()),
                name: "echo".into(),
                input: json!({"value":43}),
                reason: ToolRejection::Cancelled,
            });
            assert_eq!(
                aborted[6].event.fact,
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::Cancelled {
                        source: "runtime_cancellation".into()
                    }
                }
            );
            let next_opening = settled
                .events
                .iter()
                .find(|stored| stored.event.invocation.invocation_id == "invocation-next")
                .unwrap();
            assert!(aborted[6].sequence < next_opening.sequence);
            engine.drain().await;
            drop(engine);
            Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
        }
        {
            // Reopen to verify durable, usable history without effect replay.
            let log = Arc::new(EventLog::open(&path).await.unwrap());
            let engine = Engine::new(
                log.clone(),
                ModelExecutor::new(1, Duration::from_secs(10)).unwrap(),
                CodeExecutor::new(2, CellLimits::default()).unwrap(),
            );
            engine
                .run(input(&base, "reopened", effect.clone()), CancellationToken::new())
                .await
                .unwrap();
        }
        assert_eq!(
            effect.count.load(Ordering::SeqCst),
            1,
            "committed effect must never be replayed"
        );
        let requests = server.await.unwrap();
        for (request, suffix) in requests[1..].iter().zip(["next", "reopened"]) {
            let messages = request["messages"].as_array().unwrap();
            assert_eq!(
                messages.last().unwrap(),
                &json!({"role":"user","content":format!("question {suffix}")})
            );
            let results: Vec<_> = messages
                .iter()
                .filter(|message| message["role"] == "tool")
                .collect();
            assert_eq!(results.len(), 2);
            assert_eq!(results[0]["tool_call_id"], "call-1");
            assert_eq!(results[1]["tool_call_id"], "call-2");
            assert!(results[1]["content"].as_str().unwrap().contains(&ToolRejection::Cancelled.to_string()));
            assert_eq!(
                serde_json::from_str::<Value>(results[0]["content"].as_str().unwrap()).unwrap(),
                json!({"value":42})
            );
        }
    })
    .await
    .expect("caller cancellation and effect draining must make bounded progress");
}
