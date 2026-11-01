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
use crate::support::store::SessionFixture;
use std::time::Duration;

fn catalog(reverse: bool, effects: Arc<AtomicUsize>) -> ToolCatalog {
    let mut names = vec!["zeta", "echo"];
    if reverse {
        names.reverse();
    }
    ToolCatalog::new(names.into_iter().map(|name| ToolRegistration {
        definition: ToolDefinition { freeform: None, output_schema: None, provider: None,
            name: name.into(), description: "fixture echo tool".into(),
            input_schema: json!({"type":"object","properties":{"n":{"type":"integer"}},"required":["n"]}) },
        nesting: ToolNesting::Nestable, semantics: ToolSemantics::Parallel,
        handler: ToolHandler::Immediate(Arc::new(Echo(effects.clone()))),
    })).unwrap().with_discovery()
}
fn input(
    base: &str,
    turn: &str,
    mode: ToolMode,
    tools: ToolCatalog,
) -> maka_agent_engine::RunInput {
    let mut input = fixture::input(base, turn, false);
    input.configuration.tool_mode = mode;
    input.work = RunWork::Message {
        source_messages: vec![],
        message: "continue".into(),
        tools,
    };
    input
}
async fn next(listener: &TcpListener) -> (TcpStream, Value) {
    let (mut socket, _) = listener.accept().await.unwrap();
    let request = fixture::read_request(&mut socket).await;
    (socket, request)
}
fn empty(request: &Value, mode: ToolMode) {
    assert_eq!(
        visible(request, mode),
        if mode == ToolMode::Direct {
            vec!["tool_search".to_string()]
        } else {
            vec![]
        }
    );
}
fn loaded(request: &Value, mode: ToolMode) {
    assert_eq!(
        visible(request, mode),
        if mode == ToolMode::Direct {
            vec![
                "echo".to_string(),
                "zeta".to_string(),
                "tool_search".to_string(),
            ]
        } else {
            vec!["echo".to_string(), "zeta".to_string()]
        }
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn continuation_admission_rejects_changed_loading_before_claiming_the_source() {
    use maka_agent_facts::event::EventWrite;
    use maka_agent_facts::event::InvocationOutcome;
    use maka_agent_facts::event::RuntimeEvent;
    use maka_agent_facts::input::InvocationInput;
    tokio::time::timeout(Duration::from_secs(20), async {
        for mode in [ToolMode::Direct, ToolMode::CodeMode] {
            let directory = tempfile::tempdir().unwrap();
            let log = Arc::new(
                SessionFixture::open(&directory.path().join("events.sqlite"))
                    .await
                    .unwrap(),
            );

            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, request) = next(&listener).await;
                empty(&request, ToolMode::Direct);
                respond_tools(
                    &mut socket,
                    vec![call("discover", "tool_search", json!({"query":"fixture"}))],
                    10,
                )
                .await;
                let (mut socket, request) = next(&listener).await;
                loaded(&request, ToolMode::Direct);
                fixture::respond(&mut socket, "loaded", "stop").await;
                let (mut socket, summary) = next(&listener).await;
                assert_eq!(summary["tools"], request["tools"]);
                fixture::respond(&mut socket, fixture::SUMMARY, "stop").await;
                let (mut socket, resumed) = next(&listener).await;
                empty(&resumed, mode);
                fixture::respond(&mut socket, "continued", "stop").await;
            });
            let effects = Arc::new(AtomicUsize::new(0));
            let engine = fixture::engine();
            let mut source = input(&base, "source", mode, catalog(false, effects.clone()));
            source.configuration.workspace_identity = Some(
                maka_agent_facts::execution::WorkspaceIdentity::from_marker_id(
                    "c193cd58-f929-4ba2-bfb5-6887beaf8132",
                )
                .unwrap(),
            );
            for fact in [
                Fact::InvocationOpened {
                    configuration: Some(Box::new(source.configuration.clone())),
                    input: InvocationInput::Message {
                        content: "continue".into(),
                        request_fingerprint: None,
                        source_messages: vec![],
                    },
                },
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::Cancelled {
                        source: "user".into(),
                    },
                },
            ] {
                log.append(
                    &EventWrite::plain(RuntimeEvent::new(source.invocation.clone(), fact)).unwrap(),
                )
                .await
                .unwrap();
            }
            let prefix = log
                .run_source("session", &source.invocation.run_id, None)
                .await
                .unwrap()
                .unwrap();
            let mut resumed = source.clone();
            resumed.invocation = input(&base, "resumed", mode, ToolCatalog::default()).invocation;
            resumed.request_fingerprint = Some(maka_agent_facts::artifact::content_digest(
                b"resume-fixture",
            ));
            resumed.work = RunWork::Continuation {
                source: prefix.boundary,
                tools: catalog(false, effects.clone()),
            };
            let cold = engine
                .prepare_continuation(log.store(), resumed.clone(), &CancellationToken::new())
                .await
                .unwrap();
            engine
                .run(
                    log.store(),
                    input(&base, "seed", ToolMode::Direct, catalog(false, effects)),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            let before = log.prefix(200, 1024 * 1024).await.unwrap();
            assert!(matches!(
                engine
                    .start_continuation(cold, CancellationToken::new())
                    .await,
                Err(maka_agent_engine::RunError::ContinuationChanged)
            ));
            assert_eq!(
                log.prefix(200, 1024 * 1024).await.unwrap().digest,
                before.digest,
                "stale cold preparation cannot open or claim a Run"
            );

            let warm = engine
                .prepare_continuation(log.store(), resumed.clone(), &CancellationToken::new())
                .await
                .unwrap();
            engine
                .run(
                    log.store(),
                    fixture::input(&base, "compact", true),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            let before = log.prefix(200, 1024 * 1024).await.unwrap();
            assert!(matches!(
                engine
                    .start_continuation(warm, CancellationToken::new())
                    .await,
                Err(maka_agent_engine::RunError::ContinuationChanged)
            ));
            assert_eq!(
                log.prefix(200, 1024 * 1024).await.unwrap().digest,
                before.digest,
                "stale warm preparation cannot restore names cleared by compaction"
            );

            let current = engine
                .prepare_continuation(log.store(), resumed, &CancellationToken::new())
                .await
                .unwrap();
            engine
                .start_continuation(current, CancellationToken::new())
                .await
                .unwrap()
                .wait()
                .await
                .unwrap();
            engine.drain().await;
            server.await.unwrap();
            let prefix = log.prefix(200, 1024 * 1024).await.unwrap();
            let claim = prefix
                .events
                .iter()
                .find_map(|event| match &event.event.fact {
                    Fact::InvocationOpened {
                        input: InvocationInput::Continuation { claim, .. },
                        ..
                    } => Some(claim),
                    _ => None,
                })
                .unwrap();
            let actual = prefix
                .events
                .iter()
                .find_map(|event| match &event.event.fact {
                    Fact::ModelRequested { input_digest, .. }
                        if event.event.invocation.run_id == "run-resumed" =>
                    {
                        Some(input_digest)
                    }
                    _ => None,
                })
                .unwrap();
            assert_eq!(
                actual, &claim.replay.digest,
                "freshly admitted evidence matches the actual cold request"
            );
        }
    })
    .await
    .expect("stale continuation preparation must be retryable without effects");
}
