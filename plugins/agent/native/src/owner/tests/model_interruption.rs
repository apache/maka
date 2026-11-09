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
use futures_util::{SinkExt, StreamExt, future::BoxFuture};
use maka_agent_facts::{
    accounting::Outcome,
    durable::{AttemptRecovery, ContentRef, ModelAttemptId},
    model::{
        ModelPart,
        assembly::{AttemptCut, PreviewPart},
        recorded::{CompletionPart, ModelPartial, PrivateModelPartial},
    },
};
use serde::de::DeserializeOwned;
use tokio::sync::Notify;

const PARTIAL: &str = "unfinished-secret-fragment";

async fn profile(f: &Fixture, code: bool, responses: bool) {
    selection::edit(f, |changes| {
        changes.model_overrides = Patch::Set(BTreeMap::from([(
            "fixture-model".into(),
            ModelOverride {
                code_mode: Some(code),
                context_window: Some(1_000_000),
                input_limit: Some(900_000),
                api_protocol: responses.then_some(ApiProtocol::OpenaiResponses),
                ..Default::default()
            },
        )]))
    })
    .await;
}
async fn send(f: &Fixture, session: &str, message: &str) -> RunId {
    let queued = f
        .mutation(
            2,
            "send",
            json!({"sessionId":session,"message":message,"delivery":"queue",
        "backend":model_backend(&f.selection().await)}),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
    f.delivered_run(&queued).await
}
async fn done(f: &Fixture, session: &str, run: RunId, terminal: Terminal) {
    wait_fact(f, run, |fact| matches!(fact, Fact::RunTerminated { .. })).await;
    f.drained().await;
    let view = f.owner.durable.frontier(run).await.unwrap();
    assert_eq!(view.spec.session_id, session);
    assert_eq!(view.terminal, Some(terminal), "{view:?}");
    let readiness: maka_agent_api::contract::WorkReadiness = serde_json::from_value(
        f.query(
            "workReadiness",
            json!({"sessionId":session,"target":{"kind":"run","runId":run}}),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert!(matches!(
        readiness,
        maka_agent_api::contract::WorkReadiness::Ready
    ));
}
async fn decode<T: DeserializeOwned>(f: &Fixture, run: RunId, reference: &ContentRef) -> T {
    serde_json::from_slice(
        &f.owner
            .durable
            .content(run, reference.clone())
            .await
            .unwrap(),
    )
    .unwrap()
}
async fn records(f: &Fixture, run: RunId) -> Vec<RecordedFact> {
    let mut records = Vec::new();
    let mut after = 0;
    loop {
        let page = f.owner.durable.history(run, after, 256).await.unwrap();
        let full = page.len() == 256;
        if let Some(last) = page.last() {
            after = last.revision;
        }
        records.extend(page);
        if !full {
            return records;
        }
    }
}
async fn attempts(f: &Fixture, run: RunId) -> Vec<(ModelAttemptId, RequestSpec)> {
    let mut attempts = Vec::new();
    for record in records(f, run).await {
        if let Fact::ModelAttemptPrepared { attempt, step } = record.fact {
            attempts.push((attempt, f.owner.durable.request(run, step).await.unwrap()));
        }
    }
    attempts
}
async fn retained_partials(f: &Fixture, run: RunId) -> Vec<PrivateModelPartial> {
    let view = f.owner.durable.frontier(run).await.unwrap();
    let mut partials = Vec::new();
    for record in records(f, run).await {
        if let Fact::ModelPrivatePartialCaptured { attempt, partial } = record.fact {
            let private: PrivateModelPartial = decode(f, run, &partial).await;
            assert_eq!(
                private.binding.execution,
                ExecutionIdentity {
                    session_id: view.spec.session_id.clone(),
                    turn_id: view.spec.turn_id.clone(),
                    run_id: view.run,
                }
            );
            assert_eq!(private.binding.attempt_id, attempt);
            assert_eq!(private.binding.step_id, view.attempts[&attempt].step);
            assert_eq!(
                private.binding.purpose,
                maka_agent_facts::context::ModelPurpose::Main
            );
            partials.push(private);
        }
    }
    partials
}
async fn wait_fact(f: &Fixture, run: RunId, predicate: impl Fn(&Fact) -> bool) -> RecordedFact {
    let mut changed = f.owner.durable.subscribe().unwrap();
    loop {
        changed.borrow_and_update();
        if let Some(record) = records(f, run)
            .await
            .into_iter()
            .find(|record| predicate(&record.fact))
        {
            return record;
        }
        changed.changed().await.unwrap();
    }
}
fn preview_has_text(cut: &AttemptCut, expected: &str) -> bool {
    cut.parts.iter().any(|part|matches!(part,PreviewPart::Text {text,..} if text.chunks().collect::<String>()==expected))
}
fn partial_has_text(partial: &ModelPartial, expected: &str) -> bool {
    partial.parts.iter().any(|part| match part {
        CompletionPart::Own(record) => matches!(record.part.as_ref(),
        ModelPart::Text {text,..} if text.chunks().collect::<String>()==expected),
        CompletionPart::Ref(_) => false,
    })
}
async fn preview(
    f: &Fixture,
    session: &str,
) -> tokio::sync::watch::Receiver<Option<Arc<AttemptCut>>> {
    loop {
        if let Some(reader) = f.owner.preview_reader(session).await {
            return reader;
        }
        tokio::task::yield_now().await;
    }
}
async fn visible(
    reader: &mut tokio::sync::watch::Receiver<Option<Arc<AttemptCut>>>,
    text: &str,
) -> Arc<AttemptCut> {
    loop {
        let value = reader.borrow_and_update().clone();
        if let Some(cut) = value
            && preview_has_text(&cut, text)
        {
            return cut;
        }
        reader
            .changed()
            .await
            .expect("actual model preview stays live");
    }
}
async fn respond(socket: &mut TcpStream, partial: bool) {
    let text = if partial { PARTIAL } else { "done" };
    let chunk = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test",
        "choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]});
    socket
        .write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
        )
        .await
        .unwrap();
    socket
        .write_all(format!("data: {chunk}\n\n").as_bytes())
        .await
        .unwrap();
    if !partial {
        let end = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test",
        "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
        socket
            .write_all(format!("data: {end}\n\ndata: [DONE]\n\n").as_bytes())
            .await
            .unwrap();
    }
}
fn conversation(request: &Value) -> Vec<Value> {
    request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] != "system")
        .cloned()
        .collect()
}
async fn frozen_source(f: &Fixture, session: &str, run: RunId, request: &RequestSpec) {
    let source: maka_agent_facts::history_snapshot::RequestSource =
        decode(f, run, &request.source_capture).await;
    let history = f.history(session);
    assert_eq!(
        history
            .capture_at(source.cut.through_sequence)
            .await
            .unwrap(),
        source.cut
    );
    assert_eq!(
        history
            .capture_at(source.current.through_sequence)
            .await
            .unwrap(),
        source.current
    );
    assert_eq!(request.source_digest, source.cut.digest);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn safe_retry_preserves_failed_evidence_and_cancellation_stops_backoff() {
    tokio::time::timeout(Duration::from_secs(60),async {
        for (cancel,reset) in [(false,false),(true,false),(false,true)] {
            let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let base=format!("http://{}/v1",listener.local_addr().unwrap());
            let observed=Arc::new(Notify::new());let reset_ready=observed.clone();
            let server=tokio::spawn(async move {
                let (mut socket,_)=listener.accept().await.unwrap();let mut requests=vec![request(&mut socket).await];
                respond(&mut socket,true).await;
                let intent=json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test",
                    "choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"unexecuted","type":"function",
                        "function":{"name":"Read","arguments":"{\"path\":\"never-read\"}"}}]},"finish_reason":null}]});
                socket.write_all(format!("data: {intent}\n\n").as_bytes()).await.unwrap();
                if reset {reset_ready.notified().await;socket.set_zero_linger().unwrap();}
                drop(socket);
                if !cancel {let (mut socket,_)=listener.accept().await.unwrap();requests.push(request(&mut socket).await);respond(&mut socket,false).await;}
                (requests,listener)
            });
            let f=Fixture::new(&base,None).await;profile(&f,false,false).await;let session=f.create("Original interrupted request").await;
            let run=send(&f,&session,"question retry").await;
            if reset {let mut reader=preview(&f,&session).await;visible(&mut reader,PARTIAL).await;observed.notify_one();}
            if cancel {
                wait_fact(&f,run,|fact|matches!(fact,Fact::RetryCharged {..})).await;
                assert_eq!(f.mutation(2,"stop",json!({"sessionId":session,"runId":run}),Uuid::new_v4()).await.unwrap()["requested"],true);
            }
            done(&f,&session,run,if cancel {Terminal::Cancelled}else{Terminal::Completed}).await;
            let (requests,listener)=server.await.unwrap();assert_eq!(requests.len(),if cancel {1}else{2});
            if !cancel {assert_eq!(requests[0],requests[1],"physical retry retains all original frozen bytes");}
            assert!(tokio::time::timeout(Duration::from_millis(20),listener.accept()).await.is_err());
            let attempts=attempts(&f,run).await;assert_eq!(attempts.len(),requests.len());
            if !cancel {assert_ne!(attempts[0].0,attempts[1].0);assert_eq!(attempts[0].1.step,attempts[1].1.step);
                assert_eq!(attempts[0].1.request,attempts[1].1.request);assert_eq!(attempts[0].1.source_capture,attempts[1].1.source_capture);
                assert_eq!(attempts[0].1.source_digest,attempts[1].1.source_digest);}
            let facts=records(&f,run).await;
            assert_eq!(facts.iter().filter(|record|matches!(&record.fact,Fact::AttemptRecoveryRecorded {recovery:AttemptRecovery::FrozenRetrySafe {..},..})).count(),1);
            assert!(facts.iter().any(|record|matches!(&record.fact,Fact::ModelInterrupted {diagnostic:message,..} if !message.is_empty())));
            let causes=failures(&f,run,&facts).await;assert_eq!(causes.len(),1);
            assert!(matches!(&causes[0].failure,maka_model::ModelError::Provider(failure)
                if failure.replay_safe()&&matches!(failure.reason(),maka_model::ProviderFailureReason::Network|maka_model::ProviderFailureReason::StreamTruncated)));
            assert_eq!(facts.iter().filter(|record|matches!(&record.fact,Fact::ModelClosed {..})).count(),usize::from(!cancel),
                "EOF/RST knowledge cannot manufacture upstream Closed");
            assert!(!facts.iter().any(|record|matches!(&record.fact,Fact::ToolDecided {..}|Fact::ToolAdmitted {..})));
            let partials=retained_partials(&f,run).await;assert_eq!(partials.len(),1);
            assert!(partial_has_text(&partials[0].partial,PARTIAL));
            for (_,request) in &attempts {frozen_source(&f,&session,run,request).await;}
            f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
        }
    }).await.expect("original EOF/RST, frozen retry and Stop during backoff settle");
}

pub(in crate::owner) async fn cold_reopen(f: Fixture) -> Fixture {
    let deployment = f.app.source().unwrap().deployment;
    f.app.shutdown().await.unwrap();
    f.config.shutdown().await.unwrap();
    let Fixture {
        _dir,
        namespaces,
        root,
        workspace,
        store,
        config,
        issuer,
        owner,
        app,
        services,
    } = f;
    drop((owner, app, services, config));
    Arc::try_unwrap(store)
        .ok()
        .expect("release actual old Root before cold reopen")
        .close()
        .await
        .unwrap();
    let owner = Arc::new(RootOwner::open_existing(&root, &namespaces).unwrap());
    let migrations: Vec<_> = maka_event_log::ROOT_MIGRATIONS
        .iter()
        .chain(maka_agent_state::MIGRATIONS)
        .cloned()
        .collect();
    let store = Arc::new(RootStore::open(owner.clone(), &migrations).await.unwrap());
    let config = Arc::new(ConfigurationStore::for_root(owner).await.unwrap());
    let data = store.data_writer().unwrap();
    let state = maka_agent_state::Store::new(
        data.clone(),
        maka_agent_state::DriverDomain::new(data).unwrap(),
    )
    .unwrap();
    let catalog = bundled_catalog();
    let mut native = NativeRegistry::default();
    maka_settings_native::provide(&mut native, catalog.clone()).unwrap();
    let capture: FixtureCapture = Arc::new(StdMutex::new(None));
    let captured = capture.clone();
    let helper = native_helper();
    native
        .insert(
            IMPLEMENTATION.into(),
            Arc::new(move |context, configuration| {
                let captured = captured.clone();
                let catalog = catalog.clone();
                let state = state.clone();
                let helper = helper.clone();
                Box::pin(async move {
                    let services = context.services();
                    let owner = Owner::open(context, configuration, catalog, state, helper, None)
                        .await
                        .unwrap();
                    *captured.lock().unwrap() = Some((owner.clone(), services));
                    let service = Arc::new(Agent(owner));
                    NativeActivation {
                        owner: service.clone(),
                        exports: Ok(BTreeMap::from([(
                            EXPORT.into(),
                            maka_plugin_core::runtime::Published {
                                contract: contract(),
                                value: service as Arc<dyn maka_host_runtime::application::Handler>,
                            },
                        )])),
                    }
                })
            }),
        )
        .unwrap();
    let app = Application::start_from_store(
        store.clone(),
        deployment,
        native,
        issuer.clone(),
        Arc::new(Grant(issuer.clone(), None)),
        Some(maka_host_js::factory(Default::default())),
    )
    .await
    .unwrap();
    app.ready().await.unwrap();
    let (owner, services) = capture.lock().unwrap().take().unwrap();
    Fixture {
        _dir,
        namespaces,
        root,
        workspace,
        store,
        config,
        issuer,
        owner,
        app,
        services,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn partial_text_survives_cancellation_without_becoming_replayed_model_history() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let release = Arc::new(Notify::new());
        let server_release = release.clone();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for index in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(request(&mut socket).await);
                respond(&mut socket, index == 0).await;
                if index == 0 {
                    server_release.notified().await;
                }
            }
            assert!(
                tokio::time::timeout(Duration::from_millis(20), listener.accept())
                    .await
                    .is_err()
            );
            requests
        });
        let f = Fixture::new(&base, None).await;
        profile(&f, false, false).await;
        let session = f.create("Retained private partial").await;
        let cancelled = send(&f, &session, "question cancelled").await;
        let mut preview = preview(&f, &session).await;
        let held = visible(&mut preview, PARTIAL).await;
        let active = f.owner.durable.frontier(cancelled).await.unwrap();
        assert!(active.terminal.is_none());
        assert_eq!(active.attempts.len(), 1);
        assert!(
            active
                .attempts
                .values()
                .all(|attempt| attempt.closed.is_none() && attempt.interrupted.is_none())
        );
        assert_eq!(
            f.mutation(
                2,
                "stop",
                json!({"sessionId":session,"runId":cancelled}),
                Uuid::new_v4()
            )
            .await
            .unwrap()["requested"],
            true
        );
        done(&f, &session, cancelled, Terminal::Cancelled).await;
        assert!(
            preview.borrow().is_none(),
            "the sealed attempt is no longer current"
        );
        assert!(
            preview_has_text(&held, PARTIAL),
            "held immutable preview remains stable after the producer retires"
        );
        let before = records(&f, cancelled).await;
        assert!(!before.iter().any(|record| matches!(
            &record.fact,
            Fact::ModelClosed {
                outcome: Outcome::Success,
                ..
            }
        )));
        assert!(
            !before
                .iter()
                .any(|record| matches!(&record.fact, Fact::ModelObserved { .. })),
            "private partials are not completed items"
        );
        let partials = retained_partials(&f, cancelled).await;
        assert_eq!(partials.len(), 1);
        assert!(partial_has_text(&partials[0].partial, PARTIAL));
        assert_eq!(partials[0].binding, held.binding);
        assert!(partials[0].revision >= held.revision);
        let interrupted = before
            .iter()
            .find(|record| matches!(&record.fact, Fact::ModelInterrupted { .. }))
            .unwrap();
        let terminal = before
            .iter()
            .find(|record| matches!(&record.fact, Fact::RunTerminated { .. }))
            .unwrap();
        assert!(
            interrupted.revision < terminal.revision,
            "cancellation interruption precedes the canonical terminal"
        );
        release.notify_one();
        let next = send(&f, &session, "question next").await;
        done(&f, &session, next, Terminal::Completed).await;
        let all_before = f.recorded_facts(&session).await;
        drop(preview);
        let f = cold_reopen(f).await;
        assert_eq!(
            f.recorded_facts(&session).await,
            all_before,
            "cold reopen never rewrites or reexecutes original evidence"
        );
        assert_eq!(retained_partials(&f, cancelled).await, partials);
        assert_eq!(records(&f, cancelled).await, before);
        let reopened = send(&f, &session, "question reopened").await;
        done(&f, &session, reopened, Terminal::Completed).await;
        for run in [cancelled, next, reopened] {
            assert_eq!(attempts(&f, run).await.len(), 1);
            for (_, request) in attempts(&f, run).await {
                frozen_source(&f, &session, run, &request).await;
            }
        }
        assert_eq!(
            f.owner.durable.frontier(cancelled).await.unwrap().terminal,
            Some(Terminal::Cancelled)
        );
        assert_eq!(
            f.owner.durable.frontier(next).await.unwrap().terminal,
            Some(Terminal::Completed)
        );
        assert_eq!(
            f.owner.durable.frontier(reopened).await.unwrap().terminal,
            Some(Terminal::Completed)
        );
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(
            conversation(&requests[0]),
            vec![json!({"role":"user","content":"question cancelled"})]
        );
        assert_eq!(
            conversation(&requests[1]),
            vec![
                json!({"role":"user","content":"question cancelled"}),
                json!({"role":"user","content":"question next"})
            ]
        );
        assert_eq!(
            conversation(&requests[2]),
            vec![
                json!({"role":"user","content":"question cancelled"}),
                json!({"role":"user","content":"question next"}),
                json!({"role":"assistant","content":"done"}),
                json!({"role":"user","content":"question reopened"})
            ]
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .expect("retained preview cancellation and genuine cold Root recovery settle");
}

async fn websocket_body(socket: &mut tokio_tungstenite::WebSocketStream<TcpStream>) -> Value {
    serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap()
}
async fn websocket_event(socket: &mut tokio_tungstenite::WebSocketStream<TcpStream>, event: Value) {
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            event.to_string().into(),
        ))
        .await
        .unwrap();
}
fn response_done(text: &str) -> Value {
    json!({"type":"response.completed","response":{"id":"done","status":"completed","output":[{
        "type":"message","id":"answer","role":"assistant","content":[{"type":"output_text","text":text}]}]}})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn successful_finish_turn_is_authoritative_after_stream_interruption() {
    check_interrupted_finish(true).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refused_finish_turn_recovers_after_stream_interruption() {
    check_interrupted_finish(false).await;
}
async fn check_interrupted_finish(success: bool) {
    tokio::time::timeout(Duration::from_secs(30),async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let base=format!("http://{}/v1",listener.local_addr().unwrap());
        let f=Fixture::configured_provider(&base,None,None,None,|settings|settings.bot=true,"openai").await;
        profile(&f,false,true).await;
        let workspace=f.create_input("FinishTurn authority").await["workspace"].clone();
        let opened=f.mutation(2,"openBot",json!({"workspace":workspace}),Uuid::new_v4()).await.unwrap();
        assert_eq!(opened["kind"],"opened");let session=opened["sessionId"].as_str().unwrap();
        let run=send(&f,session,"question finish-turn").await;
        let (socket,_)=listener.accept().await.unwrap();let mut socket=tokio_tungstenite::accept_async(socket).await.unwrap();
        let initial=websocket_body(&mut socket).await;
        assert!(initial["tools"].as_array().unwrap().iter().any(|tool|tool["name"]==crate::owner::bot::SLEEP),
            "the real Bot catalog, not a test tool name, grants FinishTurn");
        if !success {
            let queued=f.mutation(2,"send",json!({"sessionId":session,"message":"Handle this queued message before sleeping",
                "delivery":"steer","expectedRunId":run}),Uuid::new_v4()).await.unwrap();
            assert_eq!(queued["kind"],"queued","the actual Bot sleep predicate must refuse pending steering");
            assert_eq!(f.owner.durable.queue().steering(session.to_owned(),run).await.unwrap().entries.len(),1);
        }
        websocket_event(&mut socket,json!({"type":"response.output_item.done","item":{"type":"function_call",
            "id":"finish-item","call_id":"finish-call","name":crate::owner::bot::SLEEP,"arguments":"{}"}})).await;
        let settled=wait_fact(&f,run,|fact|matches!(fact,Fact::ToolResultAccepted {tool,..} if tool.call=="finish-call")).await;
        assert!(matches!(&settled.fact,Fact::ToolResultAccepted {outcome,..} if *outcome==if success {
            maka_agent_facts::durable::AcceptedResult::Succeeded
        }else{maka_agent_facts::durable::AcceptedResult::Failed}));
        assert!(!records(&f,run).await.iter().any(|record|matches!(&record.fact,Fact::ModelClosed {outcome:Outcome::Success,..})),
            "the provider has not completed the response that carried the finishing call");
        // Actual transport loss after T2, without ever sending response.completed.
        drop(socket);
        if !success {
            let (socket,_)=listener.accept().await.unwrap();let mut socket=tokio_tungstenite::accept_async(socket).await.unwrap();
            let retry=websocket_body(&mut socket).await;
            assert!(retry.get("previous_response_id").is_none());
            let input=retry["input"].as_array().unwrap();
            assert_eq!(input.iter().filter(|item|item["call_id"]=="finish-call").count(),2);
            let refusal=input.iter().find(|item|item["type"]=="function_call_output"&&item["call_id"]=="finish-call").unwrap();
            assert!(refusal["output"].to_string().contains("before you sleep"));
            websocket_event(&mut socket,response_done("finished after refusal")).await;
        }
        done(&f,session,run,Terminal::Completed).await;
        assert!(tokio::time::timeout(Duration::from_millis(20),listener.accept()).await.is_err());
        let facts=records(&f,run).await;
        assert_eq!(attempts(&f,run).await.len(),if success {1}else{2});
        assert_eq!(facts.iter().filter(|record|matches!(&record.fact,Fact::ModelClosed {outcome:Outcome::Success,..})).count(),usize::from(!success),
            "successful FinishTurn cannot fabricate upstream Finished");
        assert_eq!(facts.iter().filter(|record|matches!(&record.fact,Fact::ToolAdmitted {tool} if tool.call=="finish-call")).count(),1);
        assert_eq!(facts.iter().filter(|record|matches!(&record.fact,Fact::ToolResultAccepted {tool,..} if tool.call=="finish-call")).count(),1);
        assert!(!facts.iter().any(|record|matches!(&record.fact,Fact::StopRequested {..})),"FinishTurn is not a fake user Stop");
        f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
    }).await.expect("real Bot FinishTurn success or known pending-steering refusal recovers boundedly");
}

struct FinalizationSql(String);
impl maka_event_log::writeback::Statement for FinalizationSql {
    type Value = ();
    type Output = ();
    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<maka_event_log::writeback::Prepared<()>, maka_event_log::StoreError> {
        connection.execute_batch(&self.0)?;
        Ok(maka_event_log::writeback::Prepared {
            value: (),
            changed: true,
            notification: maka_event_log::writeback::Notification::METADATA,
        })
    }
    fn committed((): ()) {}
    fn isolated_rejection(_: &maka_event_log::StoreError) -> bool {
        false
    }
}
async fn finalization_sql(f: &Fixture, sql: String) {
    f.store
        .data_writer()
        .unwrap()
        .write(FinalizationSql(sql))
        .await
        .unwrap();
}
async fn chat_text(socket: &mut TcpStream, text: &str) {
    socket
        .write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
        )
        .await
        .unwrap();
    let text = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{
        "index":0,"delta":{"content":text},"finish_reason":null}]});
    let end = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{
        "index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}});
    socket
        .write_all(format!("data: {text}\n\ndata: {end}\n\ndata: [DONE]\n\n").as_bytes())
        .await
        .unwrap();
}
async fn unavailable_read(socket: &mut TcpStream) {
    socket
        .write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
        )
        .await
        .unwrap();
    let call = json!({"id":"read","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,
        "delta":{"tool_calls":[{"index":0,"id":"earlier-read","type":"function","function":{"name":"read","arguments":"{}"}}]},"finish_reason":null}]});
    let end = json!({"id":"read","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]});
    socket
        .write_all(format!("data: {call}\n\ndata: {end}\n\ndata: [DONE]\n\n").as_bytes())
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn continuation_claim_replays_only_its_lineage_and_retries_with_frozen_input() {
    tokio::time::timeout(Duration::from_secs(60),async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let base=format!("http://{}/v1",listener.local_addr().unwrap());
        let release=Arc::new(Notify::new());let source_release=release.clone();
        let server=tokio::spawn(async move {
            let mut warm=Vec::new();let mut child=Vec::new();
            for index in 0..6 {
                let (mut socket,_)=listener.accept().await.unwrap();let body=request(&mut socket).await;
                if index<4 {warm.push(body);}else{child.push(body);}
                match index {
                    0=>unavailable_read(&mut socket).await,
                    1=>chat_text(&mut socket,"earlier settled answer").await,
                    2=>{source_release.notified().await;chat_text(&mut socket,"trimmed old tail").await;},
                    3=>chat_text(&mut socket,"unrelated later answer").await,
                    4=>respond(&mut socket,true).await,
                    5=>chat_text(&mut socket,"continued answer").await,
                    _=>unreachable!(),
                }
            }
            assert!(tokio::time::timeout(Duration::from_millis(20),listener.accept()).await.is_err());(warm,child)
        });
        let f=Fixture::new(&base,None).await;profile(&f,false,false).await;let session=f.create("Chosen continuation lineage").await;
        let earlier=send(&f,&session,"earlier settled question").await;done(&f,&session,earlier,Terminal::Completed).await;
        assert_eq!(attempts(&f,earlier).await.len(),2);
        assert!(records(&f,earlier).await.iter().any(|record|matches!(&record.fact,Fact::ToolDecided {tool,decision:maka_agent_facts::durable::ToolDecision::Rejected {..}} if tool.call=="earlier-read")));
        let source=send(&f,&session,"question source").await;
        // Gate only this actual Run's successful final publication, not its model
        // observations, successful closure, accounting or original resource drain.
        finalization_sql(&f,format!("CREATE TEMP TRIGGER hold_source_completed BEFORE INSERT ON agent_facts
            WHEN NEW.run='{source}' AND EXISTS(SELECT 1 FROM contents c WHERE c.id=NEW.body_content_id
                AND json_extract(c.payload,'$.fact.kind')='run_terminated'
                AND json_extract(c.payload,'$.fact.terminal')='completed')
            BEGIN SELECT RAISE(ABORT,'fixture hold successful source finalization'); END;" )).await;
        release.notify_one();
        wait_fact(&f,source,|fact|matches!(fact,Fact::ModelClosed {outcome:Outcome::Success,..})).await;
        wait_fact(&f,source,|fact|matches!(fact,Fact::BudgetCharged {..})).await;
        let active=f.owner.durable.frontier(source).await.unwrap();assert!(active.terminal.is_none());
        assert!(records(&f,source).await.iter().any(|record|matches!(&record.fact,Fact::ModelObserved {part:ModelPart::Text {text,..},..} if text.chunks().collect::<String>()=="trimmed old tail")));
        assert_eq!(f.mutation(2,"stop",json!({"sessionId":session,"runId":source}),Uuid::new_v4()).await.unwrap()["requested"],true);
        finalization_sql(&f,"DROP TRIGGER hold_source_completed;".into()).await;
        done(&f,&session,source,Terminal::Cancelled).await;
        let source_facts=records(&f,source).await;
        assert_eq!(source_facts.iter().filter(|record|matches!(&record.fact,Fact::ModelClosed {outcome:Outcome::Success,..})).count(),1,
            "Stop wins the still-active Root Run without rewriting the already successful actual model");
        let source_receipt=f.query("execution",json!({"sessionId":session,"runId":source})).await.unwrap()["execution"].clone();
        let later=send(&f,&session,"unrelated later branch").await;done(&f,&session,later,Terminal::Completed).await;
        let before=f.recorded_facts(&session).await;let history=f.history(&session);
        assert_eq!(history.successor(source).await.unwrap(),None);
        assert_eq!(f.query("continuationAvailability",json!({"sessionId":session,"runId":source})).await.unwrap(),json!({"kind":"ready","source":source_receipt}));
        assert_eq!(f.recorded_facts(&session).await,before,"read-only availability acquires no canonical claim");
        let input=json!({"sessionId":session,"sourceRunId":source,"sourceHighWater":source_receipt["highWater"],"model":f.selection().await});
        let moved=f.workspace.with_extension("moved");std::fs::rename(&f.workspace,&moved).unwrap();std::fs::create_dir(&f.workspace).unwrap();
        assert_eq!(f.mutation(2,"continueRun",input.clone(),Uuid::new_v4()).await.unwrap(),json!({"kind":"rejected","reason":"workspace_changed"}));
        assert_eq!(history.successor(source).await.unwrap(),None);assert_eq!(f.recorded_facts(&session).await,before);
        std::fs::remove_dir(&f.workspace).unwrap();std::fs::rename(&moved,&f.workspace).unwrap();
        let operation=Uuid::new_v4();let accepted=f.mutation(2,"continueRun",input.clone(),operation).await.unwrap();assert_eq!(accepted["kind"],"started");
        let child:RunId=serde_json::from_value(accepted["execution"]["runId"].clone()).unwrap();
        done(&f,&session,child,Terminal::Completed).await;
        assert_eq!(f.mutation(2,"continueRun",input.clone(),operation).await.unwrap(),accepted,"the original SDK receipt is recovered, not dispatched twice");
        assert_eq!(f.mutation(2,"continueRun",input,Uuid::new_v4()).await.unwrap(),json!({"kind":"rejected","reason":"already_continued"}));
        assert_eq!(history.successor(source).await.unwrap(),Some(child));assert_ne!(child,source);assert_ne!(child,later);
        assert_eq!(records(&f,source).await,source_facts);
        let spec=f.owner.durable.frontier(child).await.unwrap().spec;
        let input:maka_agent_facts::input::RunInput=decode(&f,child,&spec.input).await;
        let maka_agent_facts::input::RunInput::Continuation {claim,..}=input else{panic!("actual canonical inherited claim")};
        assert_eq!(claim.source.execution.run_id,source);assert_eq!(claim.source.high_water,source_receipt["highWater"].as_u64().unwrap());
        let requests=attempts(&f,child).await;assert_eq!(requests.len(),2);assert_ne!(requests[0].0,requests[1].0);
        assert_eq!(requests[0].1.step,requests[1].1.step);assert_eq!(requests[0].1.source_capture,requests[1].1.source_capture);
        assert_eq!(requests[0].1.request,requests[1].1.request);assert_eq!(requests[0].1.source_digest,requests[1].1.source_digest);
        for (_,request) in &requests {frozen_source(&f,&session,child,request).await;}
        let partials=retained_partials(&f,child).await;assert_eq!(partials.len(),1);
        assert!(partial_has_text(&partials[0].partial,PARTIAL));
        let (warm,child)=server.await.unwrap();assert_eq!(warm.len(),4,"replaces only the old hand-seeded setup with actual wire work");
        assert_eq!(child.len(),2);assert_eq!(child[0],child[1]);
        let replay=child[0]["messages"].as_array().unwrap();
        assert!(replay.iter().any(|message|message["content"]=="question source"));
        assert_eq!(replay.iter().flat_map(|message|message["tool_calls"].as_array().into_iter().flatten()).filter(|call|call["function"]["name"]=="read").count(),1);
        assert_eq!(replay.iter().filter(|message|message["role"]=="tool"&&message["tool_call_id"]=="earlier-read").count(),1);
        assert!(replay.iter().any(|message|message["role"]=="tool"&&message["content"].to_string().to_ascii_lowercase().contains("unavailable")));
        for absent in ["trimmed old tail","unrelated later branch","unrelated later answer","question child",PARTIAL] {
            assert!(!child[0].to_string().contains(absent),"chosen lineage must omit {absent}");
        }
        f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
    }).await.expect("actual accepted model tail, Stop-before-Root-terminal and chosen canonical continuation settle");
}

struct EchoEffects {
    state: std::sync::OnceLock<maka_agent_state::Store>,
    inputs: Arc<StdMutex<Vec<Value>>>,
    overlap: Option<Arc<tokio::sync::Barrier>>,
}
impl EchoEffects {
    fn new(parallel: bool) -> Arc<Self> {
        Arc::new(Self {
            state: Default::default(),
            inputs: Arc::default(),
            overlap: parallel.then(|| Arc::new(tokio::sync::Barrier::new(2))),
        })
    }
}
impl maka_host_runtime::application::Handler for EchoEffects {
    fn call(
        &self,
        method: String,
        input: Value,
        context: maka_host_runtime::application::Context,
    ) -> BoxFuture<'static, maka_host_runtime::application::HandlerResult> {
        assert_eq!(method, "echo");
        let identity = context
            .scope()
            .identity
            .agent()
            .expect("actual Agent caller")
            .clone();
        let operation = context.operation().cloned();
        let overlap = self.overlap.clone();
        let inputs = self.inputs.clone();
        let state = self
            .state
            .get()
            .expect("attach actual Root Store before model work")
            .clone();
        Box::pin(async move {
            let view = state.frontier(identity.run_id).await.unwrap();
            if overlap.is_some() {
                assert!(
                    operation.is_none(),
                    "parallel fixture uses an actual Query contract"
                );
            } else {
                let original = operation.expect("actual Echo Host mutation");
                assert!(
                    view.tools
                        .values()
                        .any(|tool| tool.admitted && tool.original.as_ref() == Some(&original))
                        || view
                            .cells
                            .values()
                            .flat_map(|cell| cell.children.values())
                            .any(|child| child.admitted
                                && child.reference.as_ref() == Some(&original)),
                    "actual canonical T1 precedes direct or nested cell effects"
                );
            }
            inputs.lock().unwrap().push(input.clone());
            if let Some(overlap) = overlap {
                overlap.wait().await;
            }
            Ok(maka_host_runtime::application::HandlerValue::Json(input))
        })
    }
}
impl maka_host_runtime::application::NativeOwner for EchoEffects {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
fn call_item(id: &str, arguments: &str) -> Value {
    json!({"type":"function_call","id":format!("item-{id}"),"call_id":id,"name":"echo","arguments":arguments})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn parallel_calls_overlap_while_the_model_stream_is_still_open() {
    tokio::time::timeout(Duration::from_secs(30),async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let base=format!("http://{}/v1",listener.local_addr().unwrap());
        let effects=EchoEffects::new(true);
        let setup=service_tools::Setup::parallel_echo(effects.clone(),effects.clone());
        let f=Fixture::configured_provider(&base,None,None,Some(setup),|_|{},"openai").await;
        effects.state.set(f.owner.durable.clone()).unwrap_or_else(|_|panic!("attach actual Store once"));profile(&f,false,true).await;
        let session=f.create("Concurrent accepted items").await;let run=send(&f,&session,"question parallel").await;
        let (socket,_)=listener.accept().await.unwrap();let mut socket=tokio_tungstenite::accept_async(socket).await.unwrap();
        let first=websocket_body(&mut socket).await;
        assert_eq!(first["tools"].as_array().unwrap().iter().filter(|tool|tool["name"]=="echo").count(),1);
        let calls=[call_item("call-1","{}"),call_item("call-2","{}")];
        for call in &calls {websocket_event(&mut socket,json!({"type":"response.output_item.done","item":call})).await;}
        wait_fact(&f,run,|fact|matches!(fact,Fact::ToolResultAccepted {tool,..} if tool.call=="call-1")).await;
        wait_fact(&f,run,|fact|matches!(fact,Fact::ToolResultAccepted {tool,..} if tool.call=="call-2")).await;
        assert_eq!(*effects.inputs.lock().unwrap(),vec![json!({}),json!({})],"both real handlers crossed their shared barrier");
        assert!(!records(&f,run).await.iter().any(|record|matches!(&record.fact,Fact::ModelClosed {..})),
            "serial dispatch or waiting for provider Finished deadlocks before this point");
        websocket_event(&mut socket,json!({"type":"response.completed","response":{"id":"calls","status":"completed","output":calls}})).await;
        let next=websocket_body(&mut socket).await;
        let output=next["input"].as_array().unwrap().iter().filter(|item|item["type"]=="function_call_output").collect::<Vec<_>>();
        assert_eq!(output.len(),2);
        for id in ["call-1","call-2"] {assert_eq!(output.iter().filter(|item|item["call_id"]==id).count(),1);}
        websocket_event(&mut socket,response_done("done")).await;
        done(&f,&session,run,Terminal::Completed).await;
        assert_eq!(effects.inputs.lock().unwrap().len(),2);assert_eq!(attempts(&f,run).await.len(),2);
        let facts=records(&f,run).await;
        assert_eq!(facts.iter().filter(|record|matches!(&record.fact,Fact::ToolAdmitted {..})).count(),2);
        assert_eq!(facts.iter().filter(|record|matches!(&record.fact,Fact::ToolResultAccepted {..})).count(),2);
        assert!(tokio::time::timeout(Duration::from_millis(20),listener.accept()).await.is_err());
        f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
    }).await.expect("both actual Query handlers overlap and settle while provider stream is open");
}

async fn archive_round_trip(f: &Fixture, session: &str, run: RunId) {
    use maka_agent_facts::history_snapshot::SnapshotId;
    use maka_agent_state::session_history::{
        snapshot::CaptureRequest, tool_result_source::ToolResultReader,
    };
    let facts = records(f, run).await;
    let result = facts
        .iter()
        .find_map(|record| match &record.fact {
            Fact::ToolResultAccepted { tool, result, .. } if tool.call == "call-1" => Some(result),
            _ => None,
        })
        .unwrap();
    let history = f.history(session);
    let cut = history.capture().await.unwrap();
    ToolResultReader::live(&history, &cut, run, &CancellationToken::new())
        .source(result)
        .await
        .unwrap();
    let original: maka_agent_facts::tool_output::AcceptedToolResult = decode(f, run, result).await;
    let snapshot = history
        .capture_snapshot(
            CaptureRequest {
                id: SnapshotId::try_from(Uuid::new_v4()).unwrap(),
                cut,
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let file = f
        .store
        .session(session)
        .await
        .unwrap()
        .with_resource_io(|| Ok(maka_event_log::root_store::create_request_file()?))
        .await
        .unwrap();
    let exported = snapshot.export(file).await.unwrap();
    let destination = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let target = destination.create("Imported original model evidence").await;
    let imported = destination
        .history(&target)
        .import_snapshot(
            Uuid::new_v4(),
            exported.history,
            exported.file,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let mut after = 0;
    let mut imported_facts = Vec::new();
    loop {
        let page = imported.history(run, after, 256).await.unwrap();
        let Some(last) = page.last() else {
            break;
        };
        after = last.revision;
        imported_facts.extend(page);
    }
    assert!(
        imported_facts
            .iter()
            .any(|item| matches!(&item.fact, Fact::ModelObserved { .. })),
        "portable canonical model observations remain available"
    );
    assert!(imported_facts.iter().any(
        |item| matches!(&item.fact,Fact::ToolResultAccepted {tool,..} if tool.call=="call-1")
    ));
    ToolResultReader::snapshot(&imported, run, &CancellationToken::new())
        .source(result)
        .await
        .unwrap();
    let copied: maka_agent_facts::tool_output::AcceptedToolResult = imported
        .with_content(run, result, |bytes| {
            serde_json::from_reader(bytes).map_err(maka_event_log::StoreError::from)
        })
        .await
        .unwrap();
    assert_eq!(
        copied, original,
        "archive export/import retains actual accepted result rather than another execution"
    );
    destination.app.shutdown().await.unwrap();
    destination.config.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_call_runs_before_stream_completion_and_survives_retry_in_direct_and_code_mode() {
    for (code, idle) in [(false, false), (true, false), (false, true), (true, true)] {
        tokio::time::timeout(Duration::from_secs(60),async {
            let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let base=format!("http://{}/v1",listener.local_addr().unwrap());
            let effects=EchoEffects::new(false);let mut setup=service_tools::Setup::echo(effects.clone(),effects.clone());setup.nestable=true;
            let model=ModelExecutor::new(if idle {Duration::from_secs(1)}else{Duration::from_secs(20)}).unwrap();
            let f=Fixture::configured_provider(&base,Some(model),None,Some(setup),|_|{},"openai").await;
            effects.state.set(f.owner.durable.clone()).unwrap_or_else(|_|panic!("attach actual Store once"));profile(&f,code,true).await;
            let session=f.create("Execute accepted item before provider Finished").await;let run=send(&f,&session,"question early-effect").await;
            let (socket,_)=listener.accept().await.unwrap();let mut socket=tokio_tungstenite::accept_async(socket).await.unwrap();
            let initial=websocket_body(&mut socket).await;
            let item=if code {
                websocket_event(&mut socket,json!({"type":"response.custom_tool_call_input.delta","item_id":"item-call-1","delta":"text("})).await;
                json!({"type":"custom_tool_call","id":"item-call-1","call_id":"call-1","name":"exec","input":"text(await tools.echo({value:42}));"})
            }else{call_item("call-1",r#"{"value":42}"#)};
            websocket_event(&mut socket,json!({"type":"response.output_item.done","output_index":0,"item":item})).await;
            wait_fact(&f,run,|fact|matches!(fact,Fact::ToolResultAccepted {tool,..} if tool.call=="call-1")).await;
            assert_eq!(*effects.inputs.lock().unwrap(),vec![json!({"value":42})]);
            assert!(!records(&f,run).await.iter().any(|record|matches!(&record.fact,Fact::ModelClosed {..})),
                "T0 and the actual effect/result cannot wait for whole-response completion");
            if idle {
                assert!(socket.next().await.is_none_or(|frame|frame.is_err()||matches!(frame,Ok(tokio_tungstenite::tungstenite::Message::Close(_)))));
            }else{socket.close(None).await.unwrap();}
            drop(socket);
            let (mut transport,_)=listener.accept().await.unwrap();
            let retry=if idle {
                let body=request(&mut transport).await;
                let event=response_done("done");let body_bytes=format!("data: {event}\n\n");
                transport.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body_bytes}",body_bytes.len()).as_bytes()).await.unwrap();body
            }else{
                let mut socket=tokio_tungstenite::accept_async(transport).await.unwrap();let body=websocket_body(&mut socket).await;
                websocket_event(&mut socket,response_done("done")).await;body
            };
            assert!(retry.get("previous_response_id").is_none());let input=retry["input"].as_array().unwrap();
            assert_eq!(input[0],initial["input"][0]);
            let calls=input.iter().filter(|value|value["call_id"]=="call-1").collect::<Vec<_>>();
            assert_eq!(calls.len(),2,"exactly one accepted call and one known settled result survive reconnect");
            assert_eq!(calls[0]["type"],item["type"]);assert!(calls[1]["output"].to_string().contains("42"));
            done(&f,&session,run,Terminal::Completed).await;
            assert_eq!(effects.inputs.lock().unwrap().len(),1,"a progress retry must not replay the original effect");
            let facts=records(&f,run).await;let requests=attempts(&f,run).await;assert_eq!(requests.len(),2);
            assert_ne!(requests[0].0,requests[1].0);assert_ne!(requests[0].1.step,requests[1].1.step);
            assert_ne!(requests[0].1.request,requests[1].1.request);assert_ne!(requests[0].1.source_digest,requests[1].1.source_digest);
            let first:maka_agent_facts::history_snapshot::RequestSource=decode(&f,run,&requests[0].1.source_capture).await;
            let second:maka_agent_facts::history_snapshot::RequestSource=decode(&f,run,&requests[1].1.source_capture).await;
            assert!(second.current.through_sequence>first.current.through_sequence);
            assert_eq!(facts.iter().filter(|record|matches!(&record.fact,Fact::ToolAdmitted {tool} if tool.call=="call-1")).count(),1);
            assert_eq!(facts.iter().filter(|record|matches!(&record.fact,Fact::ToolResultAccepted {tool,..} if tool.call=="call-1")).count(),1);
            if idle {assert!(facts.iter().any(|record|matches!(&record.fact,Fact::ModelClosed {diagnostic:Some(message),..}|Fact::ModelInterrupted {diagnostic:message,..} if message.contains("idle timeout"))));}
            for (_,request) in &requests {frozen_source(&f,&session,run,request).await;}
            archive_round_trip(&f,&session,run).await;
            assert!(tokio::time::timeout(Duration::from_millis(20),listener.accept()).await.is_err());
            f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
        }).await.expect("accepted direct/code item executes once before Finished and survives WS reconnect or HTTP fallback");
    }
}

use maka_agent_facts::model::retry_transport::FallbackAvailability;
use maka_agent_ports::{model as protocol, provider};
use maka_capabilities::http;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

// Binding lookup observes real compiled API resolution. Execution itself still
// resolves and authorizes the actual Root catalog connection independently.
async fn builtin_binding(executor: &ModelExecutor, base: &str, adapter: &str) -> protocol::Binding {
    let definition = maka_providers::api::ApiProviders::definition(
        "openai",
        Arc::new(maka_providers::catalog::Snapshot::bundled().unwrap()),
    )
    .unwrap();
    let configuration = definition.configure(json!({"baseUrl":base})).unwrap();
    let resolved = definition
        .prepare(provider::Resolve {
            connection: provider::Connection {
                id: "fixture-binding".into(),
                revision: 1,
                configuration,
            },
            model: ModelInfo::new("fixture-model"),
            overrides: Some(ModelOverride {
                adapter: Some(adapter.into()),
                api_protocol: Some(ApiProtocol::OpenaiResponses),
                ..Default::default()
            }),
            thinking_level: None,
        })
        .await
        .unwrap();
    executor
        .binding(&maka_model::ProviderConfig {
            adapter: Some(resolved.adapter),
            capabilities: resolved.info.capabilities.unwrap_or_default(),
            image_input: resolved.info.image_input,
            network: Default::default(),
            kind: resolved.protocol,
            model: "fixture-model".into(),
            base_url: resolved.base_url,
            auth: maka_model::ProviderAuth::RequestHeaders(BTreeMap::new()),
            headers: BTreeMap::new(),
            body_overlay: None,
        })
        .unwrap()
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SocketFault {
    Send,
    Idle,
    OpaqueIdle,
    Protocol,
}
#[derive(Clone)]
struct SocketEvidence {
    fault: SocketFault,
    sent: Arc<StdMutex<Vec<Value>>>,
    closed: Arc<AtomicBool>,
    requests: Arc<AtomicUsize>,
}
struct SocketAdapter {
    inner: protocol::Binding,
    evidence: SocketEvidence,
}
impl protocol::ProviderAdapter for SocketAdapter {
    fn recovery_contract(
        &self,
        kind: &protocol::ProviderKind,
        tools: &[Arc<maka_agent_facts::tools::ToolDefinition>],
    ) -> Option<protocol::RecoveryContract> {
        self.inner.recovery_contract(kind, tools)
    }
    fn continuation_cursor(
        &self,
        contract: &protocol::RecoveryContract,
        part: &ModelPart,
    ) -> Option<Value> {
        self.inner.continuation_cursor(contract, part)
    }
    fn supports_item_acceptance(&self) -> bool {
        self.inner.supports_item_acceptance()
    }
    fn enforces_idle_timeout(&self) -> bool {
        self.inner.enforces_idle_timeout()
    }
    fn open(
        &self,
        lifetime: protocol::Lifetime,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, Result<Arc<dyn protocol::Session>, maka_model::ModelError>> {
        Box::pin(async move {
            Ok(Arc::new(SocketSession {
                inner: self.inner.open(lifetime, cancellation).await?,
                evidence: self.evidence.clone(),
            }) as Arc<dyn protocol::Session>)
        })
    }
}
struct SocketSession {
    inner: Arc<dyn protocol::Session>,
    evidence: SocketEvidence,
}
impl protocol::Session for SocketSession {
    fn fallback_availability(&self) -> FallbackAvailability {
        self.inner.fallback_availability()
    }
    fn retry_transport_phase(&self) -> protocol::RetryTransportPhase {
        self.inner.retry_transport_phase()
    }
    fn restore_retry_transport_phase(
        &self,
        phase: protocol::RetryTransportPhase,
    ) -> Result<(), maka_model::ModelError> {
        self.inner.restore_retry_transport_phase(phase)
    }
    fn try_switch_fallback_transport(&self) -> bool {
        self.inner.try_switch_fallback_transport()
    }
    fn needs_confirmation(&self) -> bool {
        self.inner.needs_confirmation()
    }
    fn confirm<'a>(
        &'a self,
        prompt: &'a maka_agent_facts::model::prompt_source::Prompt,
        ids: &'a [&'a str],
        response: Option<&'a str>,
    ) -> BoxFuture<'a, bool> {
        self.inner.confirm(prompt, ids, response)
    }
    fn stream(
        &self,
        request: protocol::Request,
        mut context: protocol::Context,
    ) -> BoxFuture<'static, Result<(), maka_model::ModelError>> {
        context.transport = Arc::new(SocketNetwork {
            inner: context.transport,
            evidence: self.evidence.clone(),
        });
        self.inner.stream(request, context)
    }
}
struct SocketNetwork {
    inner: Arc<dyn protocol::Transport>,
    evidence: SocketEvidence,
}
impl protocol::Transport for SocketNetwork {
    fn send_text(
        &self,
        socket: Arc<dyn protocol::Socket>,
        chunks: protocol::TextStream,
    ) -> BoxFuture<'_, Result<(), protocol::Error>> {
        self.inner.send_text(socket, chunks)
    }
    fn identity(&self) -> u64 {
        self.inner.identity()
    }
    fn request(
        &self,
        request: http::Request,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, Result<http::Response, maka_model::ModelError>> {
        assert!(
            self.evidence.closed.load(Ordering::SeqCst),
            "failed original socket must close before the HTTP recovery"
        );
        self.evidence.requests.fetch_add(1, Ordering::SeqCst);
        self.inner.request(request, cancellation)
    }
    fn connect(
        &self,
        _: protocol::Connect,
    ) -> BoxFuture<'_, Result<Arc<dyn protocol::Socket>, maka_model::ModelError>> {
        let socket = FaultSocket {
            evidence: self.evidence.clone(),
            received: AtomicBool::new(false),
        };
        Box::pin(async move { Ok(Arc::new(socket) as Arc<dyn protocol::Socket>) })
    }
}
struct FaultSocket {
    evidence: SocketEvidence,
    received: AtomicBool,
}
impl Drop for FaultSocket {
    fn drop(&mut self) {
        self.evidence.closed.store(true, Ordering::SeqCst);
    }
}
impl protocol::Socket for FaultSocket {
    fn send_text(
        &self,
        mut chunks: protocol::TextStream,
    ) -> BoxFuture<'_, Result<(), maka_model::ModelError>> {
        Box::pin(async move {
            let mut bytes = Vec::new();
            while let Some(chunk) = chunks.next().await {
                bytes.extend_from_slice(&chunk?);
            }
            self.send(protocol::Frame::Text(String::from_utf8(bytes).unwrap()))
                .await
        })
    }
    fn send(&self, frame: protocol::Frame) -> BoxFuture<'_, Result<(), maka_model::ModelError>> {
        let protocol::Frame::Text(text) = frame else {
            panic!("actual codec request must be text")
        };
        self.evidence
            .sent
            .lock()
            .unwrap()
            .push(serde_json::from_str(&text).unwrap());
        Box::pin(async move {
            match self.evidence.fault {
                SocketFault::Send => Err(maka_model::ModelError::Provider(
                    maka_model::ProviderFailure::new(
                        maka_model::ProviderFailureReason::Network,
                        "Broken pipe",
                        false,
                        None,
                    ),
                )),
                SocketFault::Protocol => Err(maka_model::ModelError::Adapter(
                    "invalid WebSocket message".into(),
                )),
                SocketFault::Idle | SocketFault::OpaqueIdle => Ok(()),
            }
        })
    }
    fn receive(&self) -> BoxFuture<'_, Result<Option<protocol::Frame>, maka_model::ModelError>> {
        Box::pin(async move {
            if self.evidence.fault == SocketFault::OpaqueIdle
                && !self.received.swap(true, Ordering::SeqCst)
            {
                return Ok(Some(protocol::Frame::Text(
                    json!({"type":"response.future_call.in_progress"}).to_string(),
                )));
            }
            std::future::pending().await
        })
    }
    fn close(&self) -> BoxFuture<'_, Result<(), maka_model::ModelError>> {
        Box::pin(async { Ok(()) })
    }
}
async fn failures(
    f: &Fixture,
    run: RunId,
    facts: &[RecordedFact],
) -> Vec<maka_agent_facts::context::ModelFailureProtocol> {
    let view = f.owner.durable.frontier(run).await.unwrap();
    let mut seen = std::collections::BTreeSet::new();
    let mut failures = Vec::new();
    for record in facts {
        let (attempt, evidence) = match &record.fact {
            Fact::ModelSourceFailureCaptured { attempt, failure } => {
                assert_eq!(
                    view.attempts[attempt].source_failure.as_ref(),
                    Some(failure)
                );
                (*attempt, decode(f, run, failure).await)
            }
            Fact::ModelClosed {
                attempt,
                outcome: Outcome::Error,
                protocol,
                ..
            } => {
                assert!(
                    view.attempts[attempt].source_failure.is_none(),
                    "knowledge and upstream Error are mutually exclusive"
                );
                (*attempt, serde_json::from_value(protocol.clone()).unwrap())
            }
            _ => continue,
        };
        assert!(
            seen.insert(attempt),
            "one actual typed cause per original attempt"
        );
        failures.push(evidence);
    }
    failures
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn send_and_idle_faults_recover_the_original_request_but_opaque_effects_and_protocol_errors_stop()
 {
    for fault in [
        SocketFault::Send,
        SocketFault::Idle,
        SocketFault::OpaqueIdle,
        SocketFault::Protocol,
    ] {
        tokio::time::timeout(Duration::from_secs(30),async {
            let recover=matches!(fault,SocketFault::Send|SocketFault::Idle);
            let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let base=format!("http://{}/v1",listener.local_addr().unwrap());
            let evidence=SocketEvidence {fault,sent:Arc::default(),closed:Arc::new(AtomicBool::new(false)),requests:Arc::new(AtomicUsize::new(0))};
            let executor=ModelExecutor::new(Duration::from_millis(150)).unwrap();
            let inner=builtin_binding(&executor,&base,maka_providers::codex::ADAPTER).await;
            let source=inner.source().clone();let executor=executor.with_adapters(BTreeMap::from([(maka_providers::codex::ADAPTER.into(),
                protocol::Binding::new(Arc::new(SocketAdapter {inner,evidence:evidence.clone()}),source))]));
            let f=Fixture::configured_provider(&base,Some(executor),None,None,|_|{},"openai").await;
            selection::edit(&f,|changes|changes.model_overrides=Patch::Set(BTreeMap::from([("fixture-model".into(),ModelOverride {
                code_mode:Some(false),api_protocol:Some(ApiProtocol::OpenaiResponses),adapter:Some(maka_providers::codex::ADAPTER.into()),
                context_window:Some(1_000_000),input_limit:Some(900_000),..Default::default()
            })]))).await;
            let sent=evidence.sent.clone();let server=tokio::spawn(async move {
                if recover {let (mut socket,_)=listener.accept().await.unwrap();let body=request(&mut socket).await;
                    assert_eq!(body["input"],sent.lock().unwrap()[0]["input"]);assert!(body.get("previous_response_id").is_none());
                    let body=format!("data: {}\n\n",response_done("recovered answer"));
                    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();}
                assert!(tokio::time::timeout(Duration::from_millis(20),listener.accept()).await.is_err());
            });
            let session=f.create("Actual codec socket failure").await;let run=send(&f,&session,"question recovery").await;
            done(&f,&session,run,if recover {Terminal::Completed}else{Terminal::Failed}).await;server.await.unwrap();
            assert!(evidence.closed.load(Ordering::SeqCst));assert_eq!(evidence.sent.lock().unwrap().len(),1,"transport never re-sends its failed request");
            assert_eq!(evidence.requests.load(Ordering::SeqCst),usize::from(recover));
            let requests=attempts(&f,run).await;assert_eq!(requests.len(),if recover {2}else{1});
            if recover {assert_ne!(requests[0].0,requests[1].0);assert_eq!(requests[0].1.step,requests[1].1.step);
                assert_eq!(requests[0].1.request,requests[1].1.request);assert_eq!(requests[0].1.source_capture,requests[1].1.source_capture);
                assert_eq!(requests[0].1.source_digest,requests[1].1.source_digest);}
            let facts=records(&f,run).await;let failures=failures(&f,run,&facts).await;assert_eq!(failures.len(),1);
            match (&fault,&failures[0].failure) {
                (SocketFault::Protocol,maka_model::ModelError::Adapter(message))=>assert!(message.contains("invalid WebSocket message")),
                (fault,maka_model::ModelError::Provider(failure))=>{
                    assert_eq!(failure.reason(),if *fault==SocketFault::Send {maka_model::ProviderFailureReason::Network}else{maka_model::ProviderFailureReason::TimedOut});
                    assert_eq!(failure.replay_safe(),recover);
                },
                _=>panic!("preserve actual codec typed cause: {failures:?}"),
            }
            assert_eq!(facts.iter().filter(|record|matches!(&record.fact,Fact::ModelClosed {outcome:Outcome::Success,..})).count(),usize::from(recover));
            assert_eq!(facts.iter().filter(|record|matches!(&record.fact,Fact::ModelSourceFailureCaptured {..})).count(),1);
            assert!(!facts.iter().any(|record|matches!(&record.fact,Fact::ModelClosed {outcome:Outcome::Error,..})),
                "network, timeout and adapter interruption are knowledge, not an upstream error receipt");
            assert!(!facts.iter().any(|record|matches!(&record.fact,Fact::ToolAdmitted {..})));
            for (_,request) in &requests {frozen_source(&f,&session,run,request).await;}
            f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
        }).await.unwrap_or_else(|_|panic!("{fault:?} actual socket recovery must settle"));
    }
}

// This is the original transport-policy failure port, not a pretend WS codec.
// Socket reconstruction and subscription timeout ownership are covered above.
struct UnavailableAdapter {
    observed: Arc<StdMutex<Vec<protocol::RetryTransportPhase>>>,
    replay_safe: bool,
    quota: bool,
    advice: Option<u64>,
}
struct UnavailableSession {
    lane: Arc<StdMutex<BudgetLane>>,
    observed: Arc<StdMutex<Vec<protocol::RetryTransportPhase>>>,
    replay_safe: bool,
    quota: bool,
    advice: Option<u64>,
}
#[derive(Clone, Copy)]
enum BudgetLane {
    Fresh(protocol::RetryTransportPhase),
    Failed(protocol::RetryTransportPhase),
}
impl BudgetLane {
    fn phase(self) -> protocol::RetryTransportPhase {
        match self {
            Self::Fresh(phase) | Self::Failed(phase) => phase,
        }
    }
}
impl protocol::ProviderAdapter for UnavailableAdapter {
    fn open(
        &self,
        lifetime: protocol::Lifetime,
        _: CancellationToken,
    ) -> BoxFuture<'_, Result<Arc<dyn protocol::Session>, maka_model::ModelError>> {
        assert!(
            matches!(lifetime, protocol::Lifetime::Conversation),
            "one real Run-owned model session, not a phase map masking Request lifetime"
        );
        let session = UnavailableSession {
            lane: Arc::new(StdMutex::new(BudgetLane::Fresh(
                protocol::RetryTransportPhase::Primary,
            ))),
            observed: self.observed.clone(),
            replay_safe: self.replay_safe,
            quota: self.quota,
            advice: self.advice,
        };
        Box::pin(async move { Ok(Arc::new(session) as Arc<dyn protocol::Session>) })
    }
}
impl protocol::Session for UnavailableSession {
    fn fallback_availability(&self) -> FallbackAvailability {
        match *self.lane.lock().unwrap() {
            BudgetLane::Failed(protocol::RetryTransportPhase::Primary) => {
                FallbackAvailability::WarmIdlePrimary
            }
            _ => FallbackAvailability::Unavailable,
        }
    }
    fn retry_transport_phase(&self) -> protocol::RetryTransportPhase {
        self.lane.lock().unwrap().phase()
    }
    fn restore_retry_transport_phase(
        &self,
        phase: protocol::RetryTransportPhase,
    ) -> Result<(), maka_model::ModelError> {
        let mut current = self.lane.lock().unwrap();
        if current.phase() == protocol::RetryTransportPhase::Fallback
            && phase == protocol::RetryTransportPhase::Primary
        {
            return Err(maka_model::ModelError::Adapter(
                "cannot restore a consumed fallback to primary".into(),
            ));
        }
        if current.phase() != phase {
            *current = BudgetLane::Fresh(phase);
        }
        Ok(())
    }
    fn try_switch_fallback_transport(&self) -> bool {
        let mut lane = self.lane.lock().unwrap();
        if !matches!(
            *lane,
            BudgetLane::Failed(protocol::RetryTransportPhase::Primary)
        ) {
            return false;
        }
        assert!(self.replay_safe && !self.quota);
        assert_eq!(
            self.observed.lock().unwrap().as_slice(),
            &[protocol::RetryTransportPhase::Primary; 10],
            "fallback is selected only after all ten actual primary streams failed"
        );
        *lane = BudgetLane::Fresh(protocol::RetryTransportPhase::Fallback);
        true
    }
    fn stream(
        &self,
        _: protocol::Request,
        _: protocol::Context,
    ) -> BoxFuture<'static, Result<(), maka_model::ModelError>> {
        let observed = self.observed.clone();
        let lane = self.lane.clone();
        let failure = maka_model::ProviderFailure::new(
            if self.quota {
                maka_model::ProviderFailureReason::QuotaExhausted
            } else {
                maka_model::ProviderFailureReason::Network
            },
            if self.quota {
                "Usage limit reached for 5 hour. Your limit will reset at 2026-10-29 15:00:00"
            } else {
                "transport unavailable"
            },
            self.replay_safe,
            self.advice,
        );
        Box::pin(async move {
            let phase = lane.lock().unwrap().phase();
            observed.lock().unwrap().push(phase);
            *lane.lock().unwrap() = BudgetLane::Failed(phase);
            Err(maka_model::ModelError::Provider(failure))
        })
    }
}

// Native uses the actual wall clock. Unlike the retired facade's paused-clock
// fixture, nine Primary plus ten Fallback charges take real time (about 320 s).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fallback_waits_for_retry_budget_and_gets_one_bounded_budget_of_its_own() {
    let quota_at = maka_model::ProviderFailure::now_unix_ms() + 18_000_000;
    for (replay_safe, quota, advice) in [
        (true, false, None),
        (false, false, None),
        (true, true, Some(quota_at)),
        (true, true, None),
    ] {
        tokio::time::timeout(Duration::from_secs(600),async {
            let base="http://127.0.0.1:1/v1";let observed=Arc::new(StdMutex::new(Vec::new()));
            let executor=ModelExecutor::new(Duration::from_secs(5)).unwrap();let inner=builtin_binding(&executor,base,"chat-completions").await;
            let adapter=UnavailableAdapter {observed:observed.clone(),replay_safe,quota,advice};
            let executor=executor.with_adapters(BTreeMap::from([("chat-completions".into(),protocol::Binding::new(Arc::new(adapter),inner.source().clone()))]));
            let f=Fixture::new(base,Some(executor)).await;profile(&f,false,false).await;
            let session=f.create("One bounded budget for each permitted transport").await;let run=send(&f,&session,"question budget").await;
            done(&f,&session,run,Terminal::Failed).await;
            let expected=if replay_safe&&!quota {let mut phases=vec![protocol::RetryTransportPhase::Primary;10];phases.extend([protocol::RetryTransportPhase::Fallback;10]);phases}
                else{vec![protocol::RetryTransportPhase::Primary]};
            assert_eq!(*observed.lock().unwrap(),expected);
            let requests=attempts(&f,run).await;assert_eq!(requests.len(),expected.len());
            let first=&requests[0].1;let composition=first.composition.clone();
            for (_,request) in &requests {
                assert_eq!(request.step,first.step);assert_eq!(request.request,first.request);
                assert_eq!(request.source_capture,first.source_capture);assert_eq!(request.source_digest,first.source_digest);
                assert_eq!(request.composition,composition,"the whole captured model/tool surface is frozen across both budgets");
                frozen_source(&f,&session,run,request).await;
            }
            let facts=records(&f,run).await;let failures=failures(&f,run,&facts).await;assert_eq!(failures.len(),expected.len());
            let provenance:Value=decode(&f,run,&first.provenance).await;
            for (index,evidence) in failures.into_iter().enumerate() {
                let transport=evidence.transport.expect("production captures the actual bound Conversation session evidence");
                assert_eq!(transport.adapter.kind,maka_agent_facts::composition::SourceKind::ModelAdapter);
                assert!(first.composition.sources.contains(&transport.adapter));assert_eq!(transport.route_identity,provenance["routeIdentity"].as_str().expect("original prepared route identity"));
                assert_eq!(transport.fallback,if expected[index]==protocol::RetryTransportPhase::Primary {
                    FallbackAvailability::WarmIdlePrimary
                }else{FallbackAvailability::Unavailable});
                let maka_model::ModelError::Provider(failure)=evidence.failure else{panic!("actual typed provider failure")};
                assert_eq!(failure.reason(),if quota {maka_model::ProviderFailureReason::QuotaExhausted}else{maka_model::ProviderFailureReason::Network});
                assert_eq!(failure.replay_safe(),replay_safe);assert_eq!(failure.retry_at_unix_ms(),advice);
                if quota {assert!(failure.message().contains("2026-10-29 15:00:00"));}
            }
            assert_eq!(facts.iter().filter(|record|matches!(&record.fact,Fact::ModelSourceFailureCaptured {..})).count(),if quota {0}else{expected.len()});
            assert_eq!(facts.iter().filter(|record|matches!(&record.fact,Fact::ModelClosed {outcome:Outcome::Error,..})).count(),usize::from(quota),
                "network knowledge never rewrites Unknown into an upstream error receipt");
            assert_eq!(facts.iter().filter(|record|matches!(&record.fact,Fact::RetryCharged {phase:protocol::RetryTransportPhase::Primary,..})).count(),if replay_safe&&!quota {9}else{0});
            assert_eq!(facts.iter().filter(|record|matches!(&record.fact,Fact::RetryCharged {phase:protocol::RetryTransportPhase::Fallback,..})).count(),if replay_safe&&!quota {10}else{0});
            let selected=facts.iter().filter(|record|matches!(&record.fact,Fact::ModelTransportSelected {..})).collect::<Vec<_>>();
            assert_eq!(selected.len(),usize::from(replay_safe&&!quota));
            if replay_safe&&!quota {
                assert!(matches!(&selected[0].fact,Fact::ModelTransportSelected {attempt,phase:protocol::RetryTransportPhase::Fallback} if *attempt==requests[9].0));
                let charged=facts.iter().find(|record|matches!(&record.fact,Fact::RetryCharged {phase:protocol::RetryTransportPhase::Fallback,..})).unwrap();
                let requested=facts.iter().find(|record|matches!(&record.fact,Fact::ModelAttemptPrepared {attempt,..} if *attempt==requests[10].0)).unwrap();
                assert!(selected[0].revision<charged.revision&&charged.revision<requested.revision,
                    "canonical fallback selection precedes its first charge and physical request");
            }
            assert!(!facts.iter().any(|record|matches!(&record.fact,Fact::ModelClosed {outcome:Outcome::Success,..}|Fact::ToolAdmitted {..})));
            f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
        }).await.expect("each physical transport gets exactly its own bounded real-clock retry budget");
    }
}

mod late_cleanup_publication {
    use super::*;
    use maka_event_log::writeback::{Notification, Prepared, Statement};

    #[derive(Clone)]
    struct WorkerBarrier {
        entered: Arc<Notify>,
        release: tokio::sync::watch::Receiver<bool>,
    }
    struct Adapter {
        inner: protocol::Binding,
        barrier: WorkerBarrier,
    }
    impl protocol::ProviderAdapter for Adapter {
        fn recovery_contract(
            &self,
            kind: &protocol::ProviderKind,
            tools: &[Arc<maka_agent_facts::tools::ToolDefinition>],
        ) -> Option<protocol::RecoveryContract> {
            self.inner.recovery_contract(kind, tools)
        }
        fn continuation_cursor(
            &self,
            contract: &protocol::RecoveryContract,
            part: &ModelPart,
        ) -> Option<Value> {
            self.inner.continuation_cursor(contract, part)
        }
        fn supports_item_acceptance(&self) -> bool {
            self.inner.supports_item_acceptance()
        }
        fn enforces_idle_timeout(&self) -> bool {
            self.inner.enforces_idle_timeout()
        }
        fn open(
            &self,
            lifetime: protocol::Lifetime,
            cancellation: CancellationToken,
        ) -> BoxFuture<'_, Result<Arc<dyn protocol::Session>, maka_model::ModelError>> {
            Box::pin(async move {
                Ok(Arc::new(Session {
                    inner: self.inner.open(lifetime, cancellation).await?,
                    barrier: self.barrier.clone(),
                }) as Arc<dyn protocol::Session>)
            })
        }
    }
    struct Session {
        inner: Arc<dyn protocol::Session>,
        barrier: WorkerBarrier,
    }
    impl protocol::Session for Session {
        fn fallback_availability(&self) -> FallbackAvailability {
            self.inner.fallback_availability()
        }
        fn retry_transport_phase(&self) -> protocol::RetryTransportPhase {
            self.inner.retry_transport_phase()
        }
        fn restore_retry_transport_phase(
            &self,
            phase: protocol::RetryTransportPhase,
        ) -> Result<(), maka_model::ModelError> {
            self.inner.restore_retry_transport_phase(phase)
        }
        fn try_switch_fallback_transport(&self) -> bool {
            self.inner.try_switch_fallback_transport()
        }
        fn needs_confirmation(&self) -> bool {
            self.inner.needs_confirmation()
        }
        fn confirm<'a>(
            &'a self,
            prompt: &'a maka_agent_facts::model::prompt_source::Prompt,
            ids: &'a [&'a str],
            response: Option<&'a str>,
        ) -> BoxFuture<'a, bool> {
            self.inner.confirm(prompt, ids, response)
        }
        fn stream(
            &self,
            request: protocol::Request,
            context: protocol::Context,
        ) -> BoxFuture<'static, Result<(), maka_model::ModelError>> {
            let work = self.inner.stream(request, context);
            let mut barrier = self.barrier.clone();
            Box::pin(async move {
                let result = work.await;
                barrier.entered.notify_one();
                while !*barrier.release.borrow_and_update() {
                    barrier
                        .release
                        .changed()
                        .await
                        .expect("original worker barrier owner");
                }
                result
            })
        }
    }
    type Publications = Arc<StdMutex<BTreeMap<String, Vec<(String, String)>>>>;
    struct RejectFirst {
        run: RunId,
        observed: Publications,
        partial_ack_lost_after_commit: bool,
    }
    impl Statement for RejectFirst {
        type Value = ();
        type Output = ();
        fn execute(
            self,
            c: &rusqlite::Connection,
        ) -> Result<Prepared<()>, maka_event_log::StoreError> {
            let observed = self.observed;
            let partial_ack_lost_after_commit = self.partial_ack_lost_after_commit;
            c.create_scalar_function(
                "accept_original_model_publication",
                3,
                rusqlite::functions::FunctionFlags::SQLITE_UTF8,
                move |context| {
                    let kind: String = context.get(0)?;
                    let id: String = context.get(1)?;
                    let body: String = context.get(2)?;
                    let mut seen = observed.lock().unwrap();
                    let accept_partial =
                        partial_ack_lost_after_commit && kind == "model_private_partial_captured";
                    let seen = seen.entry(kind).or_default();
                    let accept = accept_partial || !seen.is_empty();
                    seen.push((id, body));
                    Ok(accept)
                },
            )?;
            c.execute_batch(&format!("CREATE TRIGGER reject_first_original_model_publication BEFORE INSERT ON agent_facts WHEN NEW.run='{}' AND (json_extract((SELECT payload FROM contents WHERE id=NEW.body_content_id),'$.fact.kind')='model_private_partial_captured' OR (json_extract((SELECT payload FROM contents WHERE id=NEW.body_content_id),'$.fact.kind')='model_cleanup_observed' AND json_extract((SELECT payload FROM contents WHERE id=NEW.body_content_id),'$.fact.cleanup.kind')='confirmed')) AND NOT accept_original_model_publication(json_extract((SELECT payload FROM contents WHERE id=NEW.body_content_id),'$.fact.kind'),NEW.id,NEW.body_content_id) BEGIN SELECT RAISE(ABORT,'first original model publication rejected without commit'); END;",self.run))?;
            Ok(Prepared {
                value: (),
                changed: true,
                notification: Notification::METADATA,
            })
        }
        fn committed((): ()) {}
        fn isolated_rejection(_: &maka_event_log::StoreError) -> bool {
            false
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn late_worker_cleanup_retries_original_partial_and_ack_after_one_silent_sql_failure() {
        tokio::time::timeout(Duration::from_secs(90),async {
            for partial in [false,true] {
                let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let base=format!("http://{}/v1",listener.local_addr().unwrap());
                let (release,receiver)=tokio::sync::watch::channel(false);let entered=Arc::new(Notify::new());
                let executor=ModelExecutor::new(Duration::from_secs(5)).unwrap();let inner=builtin_binding(&executor,&base,maka_providers::codex::ADAPTER).await;
                let source=inner.source().clone();let executor=executor.with_adapters(BTreeMap::from([(maka_providers::codex::ADAPTER.into(),protocol::Binding::new(Arc::new(Adapter {inner,barrier:WorkerBarrier {entered:entered.clone(),release:receiver}}),source))]));
                let f=Fixture::configured_provider(&base,Some(executor),None,None,|_|{},"openai").await;
                selection::edit(&f,|changes|changes.model_overrides=Patch::Set(BTreeMap::from([("fixture-model".into(),ModelOverride {code_mode:Some(false),api_protocol:Some(ApiProtocol::OpenaiResponses),adapter:Some(maka_providers::codex::ADAPTER.into()),..Default::default()})]))).await;
                let session=f.create("Original cleanup SQL retry").await;let run=send(&f,&session,"one original source").await;
                let (socket,_)=listener.accept().await.unwrap();let mut socket=tokio_tungstenite::accept_async(socket).await.unwrap();let _input=websocket_body(&mut socket).await;
                let observed:Publications=Arc::default();f.store.data_writer().unwrap().write(RejectFirst {run,observed:observed.clone(),partial_ack_lost_after_commit:partial}).await.unwrap();
                websocket_event(&mut socket,json!({"type":"response.created","response":{"id":"cleanup","created_at":1,"model":"fixture-model"}})).await;
                websocket_event(&mut socket,json!({"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[]}})).await;
                websocket_event(&mut socket,json!({"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":PARTIAL})).await;
                if partial {
                    let mut current=preview(&f,&session).await;let _held=visible(&mut current,PARTIAL).await;
                    assert_eq!(f.mutation(2,"stop",json!({"sessionId":session,"runId":run}),Uuid::new_v4()).await.unwrap()["requested"],true);
                } else {
                    websocket_event(&mut socket,json!({"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":PARTIAL,"annotations":[]}]}})).await;
                    websocket_event(&mut socket,json!({"type":"response.completed","response":{"id":"cleanup","output":[],"usage":{"input_tokens":2,"output_tokens":1}}})).await;
                    wait_fact(&f,run,|fact|matches!(fact,Fact::ModelClosed {outcome:Outcome::Success,..})).await;
                    assert!(f.owner.durable.frontier(run).await.unwrap().terminal.is_none(),"Closed is not the held original worker EOF");
                }
                entered.notified().await;
                let peer=tokio::spawn(async move { while let Some(message)=socket.next().await { if matches!(message,Ok(tokio_tungstenite::tungstenite::Message::Close(_))) { break; } } });
                // Wait for the real Model cleanup timeout/observer, not a fabricated EOF flag.
                wait_fact(&f,run,|fact|matches!(fact,Fact::ModelCleanupObserved {cleanup,..} if *cleanup!=maka_plugin_core::operation::OperationCleanup::Confirmed)).await;
                let mut changes=f.owner.durable.subscribe().unwrap();let mut physical=f.owner.physical_changes();
                if partial {
                    loop {
                        changes.borrow_and_update();physical.borrow_and_update();
                        if f.owner.lose_retained_partial_ack_once(&session).await {break;}
                        tokio::select! { _=changes.changed()=>{}, _=physical.changed()=>{} }
                    }
                }
                release.send(true).unwrap();
                loop {
                    changes.borrow_and_update();physical.borrow_and_update();
                    let view=f.owner.durable.frontier(run).await.unwrap();
                    let retained=f.owner.runs.state().await.retained_cleanup.get(&session).is_some_and(|scopes|!scopes.is_empty());
                    if view.attempts.values().all(|attempt|attempt.cleanup==maka_plugin_core::operation::OperationCleanup::Confirmed)&&!retained {break;}
                    tokio::select! { _=changes.changed()=>{}, _=physical.changed()=>{} }
                }
                // No intervening SQL or unrelated Session commit removes the failure: the UDF
                // remembers only the rejected attempt in memory, outside SQLite rollback.
                let seen=observed.lock().unwrap().clone();let expected=if partial {2}else{1};assert_eq!(seen.len(),expected);
                let facts=records(&f,run).await;
                for (kind,values) in &seen {
                    let readonly_partial=partial && kind=="model_private_partial_captured";
                    assert_eq!(values.len(),if readonly_partial {1}else{2},"partial deduplication must be readonly; only the original cleanup ACK is inserted again");
                    if !readonly_partial {assert_eq!(values[0],values[1],"same original FactId and body on retry");}
                    assert_eq!(facts.iter().filter(|fact|fact.id.to_string()==values[0].0).count(),1);
                }
                assert_eq!(retained_partials(&f,run).await.len(),usize::from(partial));assert_eq!(attempts(&f,run).await.len(),1);
                done(&f,&session,run,if partial {Terminal::Cancelled}else{Terminal::Completed}).await;
                f.app.shutdown().await.unwrap();peer.await.unwrap();f.config.shutdown().await.unwrap();
            }
        }).await.expect("original partial/cleanup publications retry without an unrelated database commit");
    }
}
