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
use futures_util::{StreamExt, future::BoxFuture};
use maka_agent_facts::{
    event::{EventWrite, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent},
    tools::{ToolExecutor, ToolFuture},
};
use maka_agent_ports::model::{
    Binding, Connect, Context, Error, Lifetime, ProviderAdapter, Request, Session, Socket,
    Transport,
};
use maka_capabilities::http as model_http;
use tokio::sync::{mpsc, oneshot};

struct UploadPull {
    checkpoint: usize,
    release: oneshot::Sender<()>,
}

struct GatedUploads {
    binding: Binding,
    pulls: mpsc::UnboundedSender<UploadPull>,
}
impl ProviderAdapter for GatedUploads {
    fn enforces_idle_timeout(&self) -> bool {
        self.binding.enforces_idle_timeout()
    }
    fn supports_item_acceptance(&self) -> bool {
        self.binding.supports_item_acceptance()
    }
    fn open(
        &self,
        lifetime: Lifetime,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, Result<Arc<dyn Session>, Error>> {
        Box::pin(async move {
            Ok(Arc::new(GatedUploadSession {
                session: self.binding.open(lifetime, cancellation).await?,
                pulls: self.pulls.clone(),
            }) as Arc<dyn Session>)
        })
    }
}
struct GatedUploadSession {
    session: Arc<dyn Session>,
    pulls: mpsc::UnboundedSender<UploadPull>,
}
impl Session for GatedUploadSession {
    fn stream(
        &self,
        request: Request,
        mut context: Context,
    ) -> BoxFuture<'static, Result<(), Error>> {
        context.transport = Arc::new(GatedUploadTransport {
            transport: context.transport,
            pulls: self.pulls.clone(),
        });
        self.session.stream(request, context)
    }
}
struct GatedUploadTransport {
    transport: Arc<dyn Transport>,
    pulls: mpsc::UnboundedSender<UploadPull>,
}
impl Transport for GatedUploadTransport {
    fn identity(&self) -> u64 {
        self.transport.identity()
    }
    fn connect(&self, request: Connect) -> BoxFuture<'_, Result<Arc<dyn Socket>, Error>> {
        self.transport.connect(request)
    }
    fn request(
        &self,
        mut request: model_http::Request,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, Result<model_http::Response, Error>> {
        let pulls = self.pulls.clone();
        let stop = cancellation.clone();
        let source = request.body.into_stream();
        // Gate after real encoded chunks have been pulled, while the original
        // captured cursor and charged output remain owned by the HTTP upload.
        request.body = model_http::RequestBody::stream(futures_util::stream::try_unfold(
            (source, 0usize, 1usize),
            move |(mut source, mut bytes, mut checkpoint)| {
                let pulls = pulls.clone();
                let stop = stop.clone();
                async move {
                    let Some(chunk) = source.next().await else {
                        return Ok(None);
                    };
                    let chunk = chunk?;
                    bytes += chunk.len();
                    while checkpoint <= 3 && bytes >= checkpoint * 64 * 1024 {
                        let (release, released) = oneshot::channel();
                        pulls
                            .send(UploadPull {
                                checkpoint,
                                release,
                            })
                            .unwrap();
                        tokio::select! {
                            _ = stop.cancelled() => return Err(model_http::Error::Denied),
                            result = released => result.unwrap(),
                        }
                        checkpoint += 1;
                    }
                    Ok(Some((chunk, (source, bytes, checkpoint))))
                }
            },
        ));
        self.transport.request(request, cancellation)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sixteen_captured_http_uploads_allow_history_queries_and_close_original_custody() {
    tokio::time::timeout(Duration::from_secs(30), async {
        const SESSIONS: usize = 16;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut requests = tokio::task::JoinSet::new();
            for _ in 0..SESSIONS {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.spawn(async move {
                    let request = read_request(&mut socket).await;
                    respond(&mut socket, false).await;
                    request
                });
            }
            let mut received = Vec::new();
            while let Some(request) = requests.join_next().await {
                received.push(request.unwrap());
            }
            received
        });
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let root = crate::support::store::RootFixture::open(&path)
            .await
            .unwrap();
        let (pulls, mut pulled) = mpsc::unbounded_channel();
        let model = ModelExecutor::new(Duration::from_secs(10)).unwrap();
        let probe = crate::support::image_projection::input(&base, json!([]));
        let binding = model.binding(&probe.provider).unwrap();
        let source = binding.source().clone();
        let model = model.with_adapters(std::collections::BTreeMap::from([(
            "gated-upload".into(),
            Binding::new(Arc::new(GatedUploads { binding, pulls }), source),
        )]));
        let engine = Engine::new(model, CodeExecutor::new(CellLimits::default()).unwrap()).unwrap();
        let mut logs = Vec::new();
        let mut runs = Vec::new();
        let mut expected = std::collections::BTreeSet::new();
        for index in 0..SESSIONS {
            let id = format!("upload-{index}");
            root.create_session(&id, "create", &json!({}), 1)
                .await
                .unwrap();
            let log = root.select(&id).await.unwrap();
            let mut input = crate::support::image_projection::input(&base, json!([]));
            input.invocation = crate::support::image_projection::identity(&id);
            input.invocation.session_id = id.clone();
            input.provider.adapter = Some("gated-upload".into());
            let text = format!("{id}:{}", "captured🙂\\\"\n".repeat(24 * 1024));
            let maka_agent_engine::RunWork::Message { message, .. } = &mut input.work else {
                unreachable!()
            };
            *message = text.clone().into();
            expected.insert(text);
            let running = engine
                .start(log.store(), input, CancellationToken::new())
                .await
                .unwrap();
            runs.push(tokio::spawn(running.completion()));
            logs.push(log);
        }
        for checkpoint in 1..=3 {
            let mut releases = Vec::new();
            for _ in 0..SESSIONS {
                let pull = pulled.recv().await.unwrap();
                assert_eq!(pull.checkpoint, checkpoint);
                releases.push(pull.release);
            }
            let histories = futures_util::future::join_all(
                logs.iter().map(|log| log.prefix(100, 2 * 1024 * 1024)),
            );
            let progress = futures_util::future::join_all(
                logs.iter()
                    .map(|log| log.observe_session::<Value>(log.id())),
            );
            let (histories, progress) = tokio::join!(histories, progress);
            assert!(
                histories
                    .into_iter()
                    .all(|history| !history.unwrap().events.is_empty())
            );
            for (log, observation) in logs.iter().zip(progress) {
                let observation = observation.unwrap().unwrap();
                assert_eq!(observation.session.id, log.id());
                assert!(observation.through_sequence > 0);
            }
            assert!(runs.iter().all(|run| !run.is_finished()));
            assert!(
                maka_event_log::root::RootOwner::open(
                    &path.with_extension("root"),
                    &maka_event_log::root::RootNamespaces {
                        ownership: path.with_extension("ownership"),
                        control: path.with_extension("control"),
                    },
                )
                .is_err()
            );
            for release in releases {
                release.send(()).unwrap();
            }
        }
        for run in runs {
            let completion = run.await.unwrap();
            completion.cleanup.unwrap();
            completion.result.unwrap();
        }
        let requests = server.await.unwrap();
        let actual: std::collections::BTreeSet<_> = requests
            .iter()
            .map(|request| {
                request["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|message| message["role"] == "user")
                    .unwrap()["content"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        assert_eq!(requests.len(), SESSIONS);
        assert_eq!(actual, expected);
        engine.drain().await;
        for log in &logs {
            engine.release_session_state(log.id()).unwrap();
        }
        drop(engine);
        drop(logs);
        root.shutdown().await.unwrap();
        drop(root);
        let reopened = crate::support::store::RootFixture::open(&path)
            .await
            .unwrap();
        reopened.shutdown().await.unwrap();
    })
    .await
    .expect("captured uploads, ordinary queries and original close must make progress");
}

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
