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

use crate::support::agent_loop::respond;
use crate::support::code_mode_lifetime as fixture;
use crate::support::http;

use crate::support::store::SessionFixture;

use maka_agent_engine::Engine;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::TerminalStatus;

use maka_code_runtime::CellLimits;
use maka_model::ModelExecutor;
use maka_tools::CodeExecutor;

use serde_json::json;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn yielded_cell_can_receive_an_answer_and_be_observed_by_the_next_model_step() {
    for continuation in [false, true] {
        verify_yielded(continuation).await;
    }
}

async fn verify_yielded(continuation: bool) {
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        SessionFixture::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    let effect = Arc::new(fixture::AnswerEffect::default());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let provider_effect = effect.clone();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        http::read_request(&mut socket).await;
        fixture::tool(
            &mut socket,
            "exec",
            json!({"code":"text(await tools.slow({value:42}));","yield_time_ms":0}),
        )
        .await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = http::read_request(&mut socket).await;
        let running: serde_json::Value = serde_json::from_str(
            request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|message| message["role"] == "tool")
                .unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(running["state"], "running");
        provider_effect.entered.notified().await;
        provider_effect.release.notify_one();
        let mut observed = Vec::new();
        for attempt in 0.. {
            crate::dynamic_tools::respond_tools(
                &mut socket,
                vec![crate::dynamic_tools::call(
                    &format!("wait-{attempt}"),
                    "wait",
                    json!({"cell_id":running["cell_id"]}),
                )],
                10,
            )
            .await;
            let (next_socket, _) = listener.accept().await.unwrap();
            socket = next_socket;
            let request = http::read_request(&mut socket).await;
            let mut output = request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|message| message["role"] == "tool")
                .unwrap()["content"]
                .as_str()
                .unwrap()
                .lines();
            let observation: serde_json::Value =
                serde_json::from_str(output.next().unwrap()).unwrap();
            observed.extend(
                output.map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap()),
            );
            if observation["state"] == "completed" {
                break;
            }
            assert_eq!(observation["state"], "running");
            assert_eq!(observation["cell_id"], running["cell_id"]);
        }
        assert_eq!(observed, vec![json!({"value":42})]);
        respond(&mut socket, false).await;
    });
    let engine = Engine::new(
        ModelExecutor::new(Duration::from_secs(5)).unwrap(),
        CodeExecutor::new(CellLimits::default()).unwrap(),
    )
    .unwrap();
    use maka_tools::{
        ToolCatalog, ToolDefinition, ToolHandler, ToolMode, ToolNesting, ToolRegistration,
        ToolSemantics,
    };
    let mut request = crate::support::invocation::input(
        &base,
        "yielded",
        maka_agent_engine::RunWork::Message {
            source_messages: Vec::new(),
            message: "question yielded".into(),
            tools: ToolCatalog::new([ToolRegistration {
                definition: ToolDefinition {
                    freeform: None,
                    output_schema: None,
                    provider: None,
                    name: "slow".into(),
                    description: "controlled answer".into(),
                    input_schema: json!({"type":"object"}),
                },
                nesting: ToolNesting::Nestable,
                semantics: ToolSemantics::Parallel,
                handler: ToolHandler::Immediate(effect.clone()),
            }])
            .unwrap(),
        },
    );
    request.configuration.tool_mode = ToolMode::CodeMode;
    if continuation {
        use maka_agent_facts::event::EventWrite;
        use maka_agent_facts::event::InvocationInput;
        use maka_agent_facts::event::RuntimeEvent;
        request.configuration.workspace_identity = Some(
            maka_agent_facts::execution::WorkspaceIdentity::from_marker_id(
                "ef751105-55b5-4d65-a364-646281586a17",
            )
            .unwrap(),
        );
        request.request_fingerprint = Some(maka_agent_facts::artifact::content_digest(
            b"resume-yielded",
        ));
        let source = Invocation {
            session_id: "session".into(),
            turn_id: "source".into(),
            run_id: "source".into(),
            invocation_id: "source".into(),
        };
        for fact in [
            Fact::InvocationOpened {
                configuration: Some(Box::new(request.configuration.clone())),
                input: InvocationInput::Message {
                    content: "original question".into(),
                    request_fingerprint: None,
                    source_messages: Vec::new(),
                },
            },
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Cancelled {
                    source: "user".into(),
                },
            },
        ] {
            log.append(&EventWrite::plain(RuntimeEvent::new(source.clone(), fact)).unwrap())
                .await
                .unwrap();
        }
        let prefix = log
            .run_source("session", "source", None)
            .await
            .unwrap()
            .unwrap();
        let maka_agent_engine::RunWork::Message { tools, .. } = request.work else {
            unreachable!()
        };
        request.work = maka_agent_engine::RunWork::Continuation {
            source: prefix.boundary,
            tools,
        };
    }
    tokio::time::timeout(Duration::from_secs(60), async {
        engine
            .run(log.store(), request, CancellationToken::new())
            .await
            .unwrap();
        server.await.unwrap();
        engine.drain().await;
    })
    .await
    .expect("yielded cells must continue without cancelling the pending answer");
    assert_eq!(effect.count.load(Ordering::SeqCst), 1);
    let projection = log
        .prefix(100, 128 * 1024)
        .await
        .unwrap()
        .project_invocation("invocation-yielded");
    assert_eq!(projection.terminal, Some(TerminalStatus::Completed));
    assert!(projection.uncertain_operations.is_empty());
    drop(engine);
    Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
}
