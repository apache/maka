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
use maka_agent_facts::{
    event::{EventWrite, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent},
    tools::{ToolExecutor, ToolFuture},
};

struct GapEffect {
    entered: Arc<Notify>,
    release: Arc<Notify>,
}
impl ToolExecutor for GapEffect {
    fn names(&self) -> Vec<String> {
        vec!["echo".into()]
    }
    fn invoke(&self, _name: String, input: Value, _cancellation: CancellationToken) -> ToolFuture {
        let entered = self.entered.clone();
        let release = self.release.clone();
        Box::pin(async move {
            entered.notify_one();
            release.notified().await;
            Ok(input)
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn active_run_preserves_history_and_releases_retirement_after_completion_or_cancellation() {
    tokio::time::timeout(Duration::from_secs(30), async {
        for cancel in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("events.sqlite");
            let log = Arc::new(SessionFixture::open(&path).await.unwrap());
            let entered = Arc::new(Notify::new());
            let release = Arc::new(Notify::new());
            let effect = Arc::new(GapEffect {
                entered: entered.clone(),
                release: release.clone(),
            });
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let first = read_request(&mut socket).await;
                respond(&mut socket, true).await;
                if cancel {
                    return 1;
                }
                let (mut socket, _) = listener.accept().await.unwrap();
                let second = read_request(&mut socket).await;
                let opening = |request: &Value| {
                    request["messages"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|message| message["role"] == "user")
                        .unwrap()
                        .clone()
                };
                assert_eq!(
                    opening(&first),
                    json!({"role":"user","content":"question retention"})
                );
                assert_eq!(opening(&second), opening(&first));
                assert!(
                    !second["messages"]
                        .to_string()
                        .contains("unrelated source append")
                );
                let tool = second["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|message| message["role"] == "tool")
                    .unwrap();
                assert_eq!(tool["tool_call_id"], "call-1");
                assert_eq!(
                    serde_json::from_str::<Value>(tool["content"].as_str().unwrap()).unwrap(),
                    json!({"value":42})
                );
                respond(&mut socket, false).await;
                2
            });
            let engine = Engine::new(
                ModelExecutor::new(Duration::from_secs(10)).unwrap(),
                CodeExecutor::new(CellLimits::default()).unwrap(),
            )
            .unwrap();
            let running = engine
                .start(
                    log.store(),
                    input(&base, "retention", effect),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            entered.notified().await;
            let unrelated = log
                .root()
                .create_session("unrelated", "append", &json!({}), 1)
                .await
                .unwrap();
            let invocation = Invocation {
                session_id: "unrelated".into(),
                turn_id: "other".into(),
                run_id: "other".into(),
                invocation_id: "other".into(),
            };
            unrelated
                .append_batch(&[
                    EventWrite::plain(RuntimeEvent::new(
                        invocation.clone(),
                        Fact::InvocationOpened {
                            configuration: None,
                            input: InvocationInput::Message {
                                content: "unrelated source append".into(),
                                source_messages: Vec::new(),
                                request_fingerprint: None,
                            },
                        },
                    ))
                    .unwrap(),
                    EventWrite::plain(RuntimeEvent::new(
                        invocation,
                        Fact::InvocationEnded {
                            outcome: InvocationOutcome::Completed,
                        },
                    ))
                    .unwrap(),
                ])
                .await
                .unwrap();
            drop(unrelated);
            if cancel {
                let revision = log
                    .get_session::<Value>("session")
                    .await
                    .unwrap()
                    .unwrap()
                    .revision;
                assert!(matches!(
                    log.root()
                        .begin_session_removal("session", revision)
                        .await
                        .unwrap(),
                    maka_event_log::sessions::SessionRemovalResult::Accepted(_)
                ));
                assert!(
                    !log.root()
                        .session_retirement_ready("session")
                        .await
                        .unwrap(),
                    "the accepted effect still owns its original source custody"
                );
                running.cancel();
            }
            release.notify_one();
            let completion = running.completion().await;
            assert!(completion.cleanup.is_ok());
            if cancel {
                assert!(matches!(completion.result, Err(RunError::Cancelled)));
            } else {
                completion.result.unwrap();
            }
            assert_eq!(server.await.unwrap(), if cancel { 1 } else { 2 });
            engine.drain().await;
            if !cancel {
                let revision = log
                    .get_session::<Value>("session")
                    .await
                    .unwrap()
                    .unwrap()
                    .revision;
                assert!(matches!(
                    log.root()
                        .begin_session_removal("session", revision)
                        .await
                        .unwrap(),
                    maka_event_log::sessions::SessionRemovalResult::Accepted(_)
                ));
            }
            assert!(
                log.root()
                    .session_retirement_ready("session")
                    .await
                    .unwrap(),
                "idle history must not retain the completed execution's source pins"
            );
            engine.release_session_state("session").unwrap();
            let canonical = log.prefix(100, 512 * 1024).await.unwrap();
            let raw = canonical
                .events
                .iter()
                .find_map(|stored| match &stored.event.fact {
                    Fact::ToolSettled {
                        outcome: maka_agent_facts::event::ToolOutcome::Succeeded { .. },
                        ..
                    } => Some(stored.event.id.clone()),
                    _ => None,
                });
            if !cancel {
                assert!(raw.is_some());
            }
            let raw_before = match &raw {
                Some(id) => Some(log.resolve_tool_result("session", id).await.unwrap()),
                None => None,
            };
            if !cancel {
                assert_eq!(
                    raw_before,
                    Some(maka_agent_facts::tool_output::ToolOutput::Json(
                        json!({"value":42})
                    ))
                );
            }
            let recall_query = || maka_event_log::recall::SearchQuery {
                terms: vec!["unrelated".into()],
                session_id: Some("unrelated".into()),
                since: None,
                until: None,
                exclude: None,
                limit: None,
            };
            let recalled = log
                .root()
                .search_history("unrelated", recall_query(), CancellationToken::new())
                .await
                .unwrap();
            assert_eq!(recalled.hits.len(), 1);
            assert_eq!(recalled.hits[0].body, "unrelated source append");
            let recall_id = recalled.hits[0].message_id.clone();
            drop(engine);
            Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
            let reopened = SessionFixture::open(&path).await.unwrap();
            assert_eq!(
                serde_json::to_value(reopened.prefix(100, 512 * 1024).await.unwrap().events)
                    .unwrap(),
                serde_json::to_value(canonical.events).unwrap()
            );
            if let Some(id) = raw {
                assert_eq!(
                    Some(reopened.resolve_tool_result("session", &id).await.unwrap()),
                    raw_before
                );
            }
            let recalled = reopened
                .root()
                .search_history("unrelated", recall_query(), CancellationToken::new())
                .await
                .unwrap();
            assert_eq!(recalled.hits.len(), 1);
            assert_eq!(recalled.hits[0].message_id, recall_id);
            assert_eq!(recalled.hits[0].body, "unrelated source append");
            reopened.close().await.unwrap();
        }
    })
    .await
    .expect("active source custody and physical cleanup must settle");
}
