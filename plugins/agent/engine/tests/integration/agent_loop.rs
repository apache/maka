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
use maka_agent_engine::{Engine, RunError};
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::TerminalStatus;
use maka_code_runtime::CellLimits;
use maka_model::ModelExecutor;
use maka_tools::CodeExecutor;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::support::agent_loop as fixture;
use fixture::{Effect, input, respond};

use crate::support::http;
use http::read_request;

struct ObservedNativeBasis(Arc<AtomicUsize>);

impl maka_agent_engine::NativeActivationBasis for ObservedNativeBasis {
    fn checkpoint_value(&self) -> serde_json::Result<Value> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(json!({"accepted": "native basis"}))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn loop_commits_before_effects_replays_history_after_reopen_and_rejects_duplicate_admission()
{
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let received = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let server_received = received.clone();
        let server_release = release.clone();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for index in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(read_request(&mut socket).await);
                if index == 0 {
                    server_received.notify_one();
                    server_release.notified().await;
                }
                respond(&mut socket, index == 0).await;
            }
            requests
        });
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let count = Arc::new(AtomicUsize::new(0));
        {
            let log = Arc::new(SessionFixture::open(&path).await.unwrap());
            let engine = Engine::new(
                ModelExecutor::new(Duration::from_secs(10)).unwrap(),
                CodeExecutor::new(CellLimits::default()).unwrap(),
            )
            .unwrap();
            let effect = Arc::new(Effect {
                log: log.clone(),
                count: count.clone(),
            });
            let mut first = input(&base, "first", effect.clone());
            let basis_materializations = Arc::new(AtomicUsize::new(0));
            first.native_activation_basis = Some(Arc::new(ObservedNativeBasis(
                basis_materializations.clone(),
            )));
            // Execute the clone to exercise the settings ownership boundary as well.
            let cloned = first.clone();
            drop(first);
            let mut first = cloned;
            let maka_agent_engine::RunWork::Message { message, .. } = &mut first.work else {
                unreachable!()
            };
            message.display_text = Some("Display-only first question".into());
            for invalid_cwd in ["relative", "/invalid\0path"] {
                let mut invalid = input(&base, "invalid", effect.clone());
                invalid.configuration.cwd = invalid_cwd.into();
                assert!(matches!(
                    engine
                        .start(log.store(), invalid, CancellationToken::new())
                        .await,
                    Err(RunError::InvalidInput(_))
                ));
            }
            let mut invalid = input(&base, "invalid-model", effect.clone());
            invalid.configuration.model = Some(maka_agent_facts::execution::ModelBinding {
                connection_id: "connection".into(),
                connection_slug: "connection".into(),
                model: "not-the-dispatched-model".into(),
            });
            assert!(matches!(
                engine
                    .start(log.store(), invalid, CancellationToken::new())
                    .await,
                Err(RunError::InvalidInput(_))
            ));
            assert!(
                log.prefix(100, 128 * 1024).await.unwrap().events.is_empty(),
                "invalid context cannot publish an opening or dispatch"
            );
            assert_eq!(count.load(Ordering::SeqCst), 0);
            fixture::admit_root(&log, &mut first).await;
            let admitted = engine
                .start(log.store(), first, CancellationToken::new())
                .await
                .unwrap();
            let steering_invocation = admitted.invocation().clone();
            assert_eq!(admitted.invocation().invocation_id, "invocation-first");
            assert!(
                log.prefix(100, 128 * 1024)
                    .await
                    .unwrap()
                    .events
                    .iter()
                    .any(
                        |event| event.event.invocation.invocation_id == "invocation-first"
                            && matches!(event.event.fact, Fact::InvocationOpened { .. })
                    )
            );
            let mut running = tokio::spawn(admitted.wait());
            tokio::select! {
                _ = received.notified() => {},
                result = &mut running => panic!("engine ended before HTTP request: {result:?}"),
            }
            assert!(matches!(
                engine
                    .run(
                        log.store(),
                        input(&base, "duplicate", effect.clone()),
                        CancellationToken::new()
                    )
                    .await,
                Err(RunError::Busy)
            ));
            fixture::enqueue(&log, steering_invocation).await;
            release.notify_one();
            running.await.unwrap().unwrap();
            assert_eq!(
                basis_materializations.load(Ordering::SeqCst),
                0,
                "ordinary model and tool execution must not materialize checkpoint evidence"
            );
            let prefix = log.prefix(100, 128 * 1024).await.unwrap();
            assert!(log.pending_messages("session").await.unwrap().is_empty());
            assert!(
                log.root_message("session", "user-first")
                    .await
                    .unwrap()
                    .is_some()
            );
            assert!(
                log.steering_message("session", "steer-first")
                    .await
                    .unwrap()
                    .is_some()
            );
            assert!(
                matches!(&prefix.events[0].event.fact, Fact::InvocationOpened {
                input: maka_agent_facts::input::InvocationInput::Message { content, .. },
                ..
            } if content.text == "question first"
                && content.display_text.as_deref() == Some("Display-only first question"))
            );
            assert_eq!(
                prefix.project_invocation("invocation-first").terminal,
                Some(TerminalStatus::Completed)
            );
            assert_eq!(count.load(Ordering::SeqCst), 1);
            assert!(
                !serde_json::to_string(&prefix)
                    .unwrap()
                    .contains("do-not-persist-this-secret")
            );
            engine.drain().await;
            drop(engine);
            drop(effect);
            Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
        }
        {
            let log = Arc::new(SessionFixture::open(&path).await.unwrap());
            let engine = Engine::new(
                ModelExecutor::new(Duration::from_secs(10)).unwrap(),
                CodeExecutor::new(CellLimits::default()).unwrap(),
            )
            .unwrap();
            let effect = Arc::new(Effect {
                log: log.clone(),
                count: count.clone(),
            });
            engine
                .run(
                    log.store(),
                    input(&base, "next", effect),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            assert_eq!(
                count.load(Ordering::SeqCst),
                1,
                "committed tools are projected, never rerun"
            );
            assert_eq!(
                log.prefix(100, 128 * 1024)
                    .await
                    .unwrap()
                    .project_invocation("invocation-next")
                    .terminal,
                Some(TerminalStatus::Completed)
            );
        }
        let requests = server.await.unwrap();
        // This test owns conversation replay; system instructions have their own contract.
        let conversation = |request: &serde_json::Value| {
            request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|message| message["role"] != "system")
                .cloned()
                .collect::<Vec<_>>()
        };
        assert_eq!(
            conversation(&requests[0]),
            vec![json!({"role":"user","content":"question first"})]
        );
        let second = conversation(&requests[1]);
        assert!(second.iter().any(|m| m["role"] == "user"
            && m["content"].as_str().is_some_and(|text| {
                text.contains("<user_query>\nA queued correction\n</user_query>")
            })));
        let result = second
            .iter()
            .find(|message| message["role"] == "tool")
            .unwrap();
        assert_eq!(result["tool_call_id"], "call-1");
        assert_eq!(
            serde_json::from_str::<Value>(result["content"].as_str().unwrap()).unwrap(),
            json!({"value":42})
        );
        let after_reopen = conversation(&requests[2]);
        assert_eq!(&after_reopen[..second.len()], second.as_slice());
        assert_eq!(
            after_reopen.last().unwrap(),
            &json!({"role":"user","content":"question next"})
        );
    })
    .await
    .expect("agent loop must make bounded progress");
}

mod prepared_retention;
