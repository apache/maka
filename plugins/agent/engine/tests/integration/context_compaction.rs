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

use crate::support::{
    context::{SUMMARY, respond},
    http::read_request,
    native::{FixtureService, NativeFixture},
};
use futures_util::future::BoxFuture;
use maka_agent_api::{
    Configuration, ModelSelection,
    contract::{BackendPreference, CompactResult, SendResult},
};
use maka_agent_facts::{
    context::{
        CompactedContext, ModelClosureProtocol, ModelPurpose, RequestContextEvidence, SummaryResult,
    },
    durable::{ContentRef, Fact, RecordedFact, RunId, Terminal},
    execution::SystemPrompt,
    history_snapshot::RequestSource,
    model::{ModelFinishReason, ModelPart},
};
use maka_agent_state::fold::RunView;
use maka_host_runtime::application::{Context, Handler, HandlerResult, HandlerValue, NativeOwner};
use maka_plugin_core::contract::{Contract, Interface, Method, MethodMode, Transport};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{io::AsyncWriteExt, net::TcpListener};

fn configuration(workspace: &Path, home: Option<&Path>) -> Configuration {
    serde_json::from_value(json!({
        "locale":"en", "tools":[],
        "workspaceRoots":[{"label":"Workspace","path":workspace}],
        "permissions":{"access":"workspace_write","requestPermissions":false},
        "assistant":home.map(|home|json!({"home":home})),
    }))
    .unwrap()
}

struct Echo {
    effects: Arc<AtomicUsize>,
}
impl Handler for Echo {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        assert_eq!(method, "echo");
        assert!(
            context.operation().is_some(),
            "echo is a real admitted service mutation"
        );
        self.effects.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(HandlerValue::Json(input)) })
    }
}
impl NativeOwner for Echo {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
fn echo_service(effects: Arc<AtomicUsize>) -> FixtureService {
    let contract = Contract {
        name: "fixture.Echo".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: BTreeMap::from([(
                "echo".into(),
                Method {
                    mode: MethodMode::Mutation,
                    input: json!({"type":"object"}).into(),
                    output: json!({"type":"object"}).into(),
                    resources: BTreeMap::new(),
                    progress: None,
                },
            )]),
        },
    };
    FixtureService::new(contract, Arc::new(Echo { effects }))
}
fn echo_configuration(workspace: &Path) -> Configuration {
    let mut value = configuration(workspace, None);
    value.tools.push(serde_json::from_value(json!({
        "name":"echo", "description":"echo", "method":"echo", "nestable":true,
        "target":{"kind":"import","name":"fixture"}, "result":"json", "confirmation":"preapproved",
    })).unwrap());
    value
}

fn backend(model: &ModelSelection) -> BackendPreference {
    BackendPreference::Model {
        connection_id: model.connection_id.clone(),
        model_id: model.model_id.clone(),
        thinking_level: None,
    }
}

async fn message(f: &NativeFixture, session: &str, text: &str) -> RunView {
    let sent = f.send(session, text, None).await.unwrap();
    let SendResult::Queued { message_id, .. } = sent else {
        panic!("send must return its actual queued receipt")
    };
    let mut changes = f.state.subscribe().unwrap();
    let run = loop {
        changes.borrow_and_update();
        match f
            .state
            .queue()
            .resolve_message(session.into(), message_id.clone())
            .await
            .unwrap()
        {
            maka_agent_state::queue::MessageResolution::Delivered { run, .. } => break run,
            maka_agent_state::queue::MessageResolution::Pending => changes.changed().await.unwrap(),
            observed => panic!("original queued message was not delivered: {observed:?}"),
        }
    };
    f.wait_terminal(run).await.unwrap()
}

async fn compact(f: &NativeFixture, session: &str, model: &ModelSelection) -> RunView {
    let result = f
        .mutation_value("compact", json!({"sessionId":session,"model":model}))
        .await
        .unwrap();
    let CompactResult::Started { execution } = serde_json::from_value(result).unwrap() else {
        panic!("manual compaction must admit a real Summary Run")
    };
    f.wait_terminal(execution.run_id).await.unwrap()
}

async fn facts(f: &NativeFixture, run: RunId) -> Vec<RecordedFact> {
    let mut result = Vec::new();
    let mut after = 0;
    loop {
        let page = f.state.history(run, after, 256).await.unwrap();
        let full = page.len() == 256;
        if let Some(last) = page.last() {
            after = last.revision;
        }
        result.extend(page);
        if !full {
            return result;
        }
    }
}

async fn decode<T: DeserializeOwned + Send + 'static>(
    f: &NativeFixture,
    run: RunId,
    reference: &ContentRef,
) -> T {
    let view = f.state.frontier(run).await.unwrap();
    let history = f
        .state
        .session_history(view.spec.owner, view.spec.session_id);
    let cut = history.capture().await.unwrap();
    history
        .with_content(&cut, run, reference, |reader| {
            Ok(serde_json::from_reader(reader))
        })
        .await
        .unwrap()
        .unwrap()
}

async fn baseline(f: &NativeFixture, summary: &RunView) -> CompactedContext {
    let body: CompactedContext = decode(
        f,
        summary.run,
        summary
            .baseline
            .as_ref()
            .expect("committed compacted context"),
    )
    .await;
    body.validate().unwrap();
    let capture: RequestSource = decode(f, summary.run, &body.source_capture).await;
    assert_eq!(
        body.checkpoint.covered_through,
        capture.current.through_sequence
    );
    assert_eq!(body.checkpoint.source_digest, capture.current.digest);
    body
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compact_next_main_and_reopen_use_durable_baseline_with_complete_tail() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        let home = directory.path().join("home");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::create_dir_all(home.join(".maka")).unwrap();
        std::fs::write(home.join(".maka/AGENTS.md"), "MAIN_SYSTEM_PROMPT_EVIDENCE").unwrap();
        let f = NativeFixture::open(directory.path(), configuration(&workspace, Some(&home)))
            .await
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let model = f
            .configure_model(&base, "gpt-4.1", "fixture")
            .await
            .unwrap();
        let session = f
            .create(
                "Durable compacted baseline",
                &workspace,
                Some(backend(&model)),
            )
            .await
            .unwrap();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for text in [
                "old-answer-private",
                SUMMARY,
                "tail-answer",
                "reopened-answer",
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(read_request(&mut socket).await);
                respond(&mut socket, text, "stop").await;
            }
            assert!(
                tokio::time::timeout(Duration::from_millis(30), listener.accept())
                    .await
                    .is_err(),
                "exactly four provider requests"
            );
            requests
        });
        let old = message(&f, &session, "question-old").await;
        assert_eq!(old.terminal, Some(Terminal::Completed));
        let original: Option<SystemPrompt> = decode(&f, old.run, &old.spec.system_prompt).await;
        let original = original.expect("real admitted Main system prompt");
        assert!(original.text.contains("MAIN_SYSTEM_PROMPT_EVIDENCE"));
        let summary = compact(&f, &session, &model).await;
        assert_eq!(summary.terminal, Some(Terminal::Completed));
        let body = baseline(&f, &summary).await;
        assert_eq!(body.checkpoint.summary.text_value().unwrap(), SUMMARY);
        let summary_facts = facts(&f, summary.run).await;
        let checkpoint_record = summary_facts
            .iter()
            .find(|record| matches!(&record.fact, Fact::ContextCompacted { .. }))
            .unwrap();
        let checkpoint = checkpoint_record.id.to_string();
        let started = summary_facts
            .iter()
            .find(|record| matches!(&record.fact, Fact::RunAdmitted { .. }))
            .unwrap()
            .at
            .0;
        let adopted = checkpoint_record.at.0;
        let duration = u64::try_from(adopted.checked_sub(started).unwrap()).unwrap();
        for record in summary_facts.iter().filter(|record| {
            matches!(
                &record.fact,
                Fact::ModelAttemptAdmitted { .. } | Fact::ModelClosed { .. }
            )
        }) {
            assert!(
                record.at.0 >= started && record.at.0 <= adopted,
                "original Summary timing must fall inside its recorded adoption span"
            );
        }
        async fn conversation_marker(
            f: &NativeFixture,
            session: &str,
            checkpoint: &str,
            adopted: i64,
            duration: u64,
        ) -> Value {
            let page: maka_agent_api::contract::HistoryPage = serde_json::from_value(
                f.query(
                    "history",
                    json!({"sessionId":session,"position":{"kind":"tail"},"view":"conversation"}),
                )
                .await
                .unwrap(),
            )
            .unwrap();
            let maka_agent_api::contract::HistoryPage::Ready { chunks, .. } = page;
            let mut found = chunks
                .into_iter()
                .filter(|chunk| chunk.message_id.as_deref() == Some(checkpoint));
            let marker = found
                .next()
                .expect("actual adopted checkpoint Conversation row");
            assert!(found.next().is_none());
            assert_eq!(
                marker.role,
                maka_agent_ports::session::history::Role::Compaction
            );
            assert!(
                marker.text.is_empty(),
                "Conversation marker must not display private adopted Summary text"
            );
            assert_eq!(marker.timestamp, Some(u64::try_from(adopted).unwrap()));
            assert_eq!(
                marker
                    .compaction
                    .as_ref()
                    .expect("actual recorded compaction duration")
                    .duration_ms,
                duration
            );
            serde_json::to_value(marker).unwrap()
        }
        let marker_before = conversation_marker(&f, &session, &checkpoint, adopted, duration).await;
        let tail = message(&f, &session, "question-tail").await;
        assert_eq!(tail.terminal, Some(Terminal::Completed));
        for step in tail.steps.keys() {
            let request = f.state.request(tail.run, *step).await.unwrap();
            let evidence: RequestContextEvidence = decode(&f, tail.run, &request.provenance).await;
            assert_eq!(
                evidence.previous_checkpoint_id.as_deref(),
                Some(checkpoint.as_str())
            );
        }
        f.shutdown().await.unwrap();
        let f = NativeFixture::open(directory.path(), configuration(&workspace, Some(&home)))
            .await
            .unwrap();
        let reopened_model = f
            .configure_model(&base, "gpt-4.1", "fixture")
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(reopened_model).unwrap(),
            serde_json::to_value(&model).unwrap()
        );
        let persisted = f.state.frontier(summary.run).await.unwrap();
        assert_eq!(persisted.baseline, summary.baseline);
        assert_eq!(baseline(&f, &persisted).await, body);
        assert_eq!(
            conversation_marker(&f, &session, &checkpoint, adopted, duration).await,
            marker_before
        );
        let reopened = message(&f, &session, "question-reopen").await;
        assert_eq!(reopened.terminal, Some(Terminal::Completed));
        for step in reopened.steps.keys() {
            let request = f.state.request(reopened.run, *step).await.unwrap();
            let evidence: RequestContextEvidence =
                decode(&f, reopened.run, &request.provenance).await;
            assert_eq!(
                evidence.previous_checkpoint_id.as_deref(),
                Some(checkpoint.as_str())
            );
        }
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 4);
        for index in [0, 2, 3] {
            assert_eq!(requests[index]["messages"][0]["role"], "system");
            assert!(
                requests[index]["messages"][0]["content"]
                    .as_str()
                    .unwrap()
                    .starts_with(&original.text)
            );
            assert_eq!(requests[index]["messages"][0], requests[0]["messages"][0]);
        }
        assert_eq!(requests[1]["messages"][0], requests[0]["messages"][0]);
        assert_eq!(requests[1]["messages"][1], requests[0]["messages"][1]);
        assert!(
            requests[1]["messages"]
                .to_string()
                .contains("old-answer-private")
        );
        assert_eq!(requests[1]["messages"][0]["role"], "system");
        let instruction = maka_agent_facts::context::default_compaction_prompt(
            maka_agent_facts::language::Language::En,
        );
        let first_line = instruction.lines().next().unwrap();
        assert!(
            requests[1]["messages"].as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap()
                .contains(first_line)
        );
        assert!(requests[1]["tools"].as_array().is_none_or(Vec::is_empty));
        assert_eq!(requests[1]["max_tokens"], 8000);
        for request in &requests[2..] {
            assert!(
                request["messages"][1]["content"]
                    .as_str()
                    .unwrap()
                    .contains(SUMMARY)
            );
            assert!(
                !request["messages"]
                    .to_string()
                    .contains("old-answer-private")
            );
            assert!(!request["messages"].to_string().contains(first_line));
        }
        assert!(requests[3]["messages"].to_string().contains("tail-answer"));
        for run in [old.run, summary.run, tail.run, reopened.run] {
            let ordinary: Vec<_> = facts(&f, run)
                .await
                .into_iter()
                .filter(|record| matches!(&record.fact, Fact::ModelObserved { .. }))
                .collect();
            assert!(
                !serde_json::to_string(&ordinary)
                    .unwrap()
                    .contains("summary-marker"),
                "summary attempts never become ordinary history"
            );
        }
        f.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn incomplete_summary_fails_without_repair_and_main_retains_incomplete_text() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let effects = Arc::new(AtomicUsize::new(0));
        let service = echo_service(effects.clone());
        let f = NativeFixture::open_with_service(directory.path(), echo_configuration(&workspace), service).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let model = f.configure_model(&base, "gpt-4.1", "fixture").await.unwrap();
        let session = f.create("Compaction boundaries", &workspace, Some(backend(&model))).await.unwrap();
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (text, reason) in [
            ("old", "stop"),
            ("cut", "length"),
            ("truncated-main", "length"),
            ("after-failure", "stop"),
        ] {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(read_request(&mut socket).await);
            if text == "truncated-main" {
                let partial = json!({"id":"partial","object":"chat.completion.chunk","created":1,"model":"test",
                    "choices":[{"index":0,"delta":{"content":text,"tool_calls":[{"index":0,"id":"unexecuted","type":"function",
                        "function":{"name":"echo","arguments":"{\"value\":42}"}}]},"finish_reason":null}]});
                let end = json!({"id":"partial","object":"chat.completion.chunk","created":1,"model":"test",
                    "choices":[{"index":0,"delta":{},"finish_reason":reason}]});
                let body = format!("data: {partial}\n\ndata: {end}\n\ndata: [DONE]\n\n");
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            } else {
                respond(&mut socket, text, reason).await;
            }
        }
        assert!(tokio::time::timeout(Duration::from_millis(30), listener.accept()).await.is_err(), "exactly four provider requests; truncated Summary has no repair");
        requests
    });

        let old = message(&f, &session, "question-old").await;
        assert_eq!(old.terminal, Some(Terminal::Completed));
        let summary = compact(&f, &session, &model).await;
        assert_eq!(summary.terminal, Some(Terminal::Failed), "truncated Summary is a known failure, never a blocked unknown outcome");
        assert!(summary.baseline.is_none());
        assert_eq!(summary.attempts.len(), 1, "length truncation cannot consume a Summary tool-content repair");
        assert!(summary.tools.is_empty(), "a Summary cannot create hard tool obligations");
        let summary_closed = summary.attempts.values().next().unwrap().closed.as_ref().expect("real Finished length closure");
        assert_eq!(summary_closed.outcome, maka_agent_facts::accounting::Outcome::Success);
        let protocol: ModelClosureProtocol = serde_json::from_value(summary_closed.protocol.clone()).unwrap();
        assert_eq!(protocol.finish_reason, ModelFinishReason::Length);
        assert_eq!(protocol.summary, Some(SummaryResult::Incomplete));
        let truncated = message(&f, &session, "question truncated").await;
        assert_eq!(truncated.terminal, Some(Terminal::Failed));
        assert_eq!(truncated.attempts.len(), 1);
        let main_closed = truncated.attempts.values().next().unwrap().closed.as_ref().expect("Main owns its actual Finished closure");
        assert_eq!(main_closed.outcome, maka_agent_facts::accounting::Outcome::Success);
        let protocol: ModelClosureProtocol = serde_json::from_value(main_closed.protocol.clone()).unwrap();
        assert_eq!(protocol.finish_reason, ModelFinishReason::Length);
        assert_eq!(protocol.summary, None);
        assert_eq!(effects.load(Ordering::SeqCst), 0);
        let after = message(&f, &session, "question-after-failure").await;
        assert_eq!(after.terminal, Some(Terminal::Completed));
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 4);
        assert!(requests[3]["messages"].to_string().contains("truncated-main"), "valid incomplete text remains available to a new user message");
        let summary_facts = facts(&f, summary.run).await;
        assert!(summary_facts.iter().any(|record| matches!(&record.fact, Fact::RunTerminated { terminal: Terminal::Failed, .. })));
        assert!(!summary_facts.iter().any(|record| matches!(&record.fact, Fact::ModelObserved { .. })), "failed Summary prose stays private before closure validation");
        let truncated_facts = facts(&f, truncated.run).await;
        assert!(truncated_facts.iter().any(|record| matches!(&record.fact, Fact::ToolPreventedBeforeHostAdmission { rejection: maka_agent_facts::tool_call::ToolRejection::PreparationFailed {..}, .. })));
        assert!(!truncated_facts.iter().any(|record| matches!(&record.fact, Fact::ToolAdmitted { .. } | Fact::ToolOriginalBound { .. } | Fact::OperationObserved { .. })));
        assert!(truncated_facts.iter().any(|record| matches!(&record.fact, Fact::RunTerminated {terminal: Terminal::Failed, ..})));
        assert!(truncated_facts.iter().any(|record| matches!(&record.fact, Fact::ModelClosed { .. })), "Main has its real upstream terminal closure");
        assert!(truncated_facts.iter().any(|record| matches!(&record.fact,
            Fact::ModelObserved { part: ModelPart::Text {text, ..}, .. } if text.chunks().collect::<String>() == "truncated-main"
        )), "Main incomplete prose remains durably owned by its actual original attempt");
        for run in [old.run, summary.run, truncated.run, after.run] {
            let records = facts(&f, run).await;
            assert!(!records.iter().any(|record| matches!(&record.fact, Fact::ContextCompacted {..})));
            assert!(!serde_json::to_string(&records).unwrap().contains("\"cut\""), "a failed Summary never publishes private prose, including closure/partial material");
        }
        f.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn summary_advertised_tools_never_execute() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let effects = Arc::new(AtomicUsize::new(0));
        let service = echo_service(effects.clone());
        let f = NativeFixture::open_with_service(directory.path(), echo_configuration(&workspace), service).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let model = f.configure_model(&base, "gpt-4.1", "fixture").await.unwrap();
        let session = f.create("Compaction boundaries", &workspace, Some(backend(&model))).await.unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let main = read_request(&mut socket).await;
        respond(&mut socket, "ordinary answer", "stop").await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let summary = read_request(&mut socket).await;
        assert!(main["tools"].as_array().unwrap().iter().any(|tool| tool["function"]["name"] == "echo"), "the actual effect service must be advertised");
        assert_eq!(summary["tools"], main["tools"]);
        assert_eq!(summary["tool_choice"], "auto");
        let call = serde_json::json!({"id":"summary","object":"chat.completion.chunk","created":1,"model":"test",
            "choices":[{"index":0,"delta":{"content":"private forbidden summary prose","tool_calls":[{"index":0,"id":"forbidden","type":"function",
            "function":{"name":"echo","arguments":"{}"}}]},"finish_reason":null}]});
        let end = serde_json::json!({"id":"summary","object":"chat.completion.chunk","created":1,"model":"test",
            "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],
            "usage":{"prompt_tokens":13,"completion_tokens":7,"total_tokens":20}});
        let body = format!("data: {call}\n\ndata: {end}\n\ndata: [DONE]\n\n");
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let summary_retry = read_request(&mut socket).await;
        assert_eq!(summary_retry["tools"], main["tools"]);
        assert_eq!(summary_retry["tool_choice"], "none");
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let recovered = read_request(&mut socket).await;
        let messages = recovered["messages"].to_string();
        assert!(messages.contains("ordinary answer"));
        assert!(!messages.contains("private forbidden summary prose"));
        assert!(!messages.contains("forbidden"));
        respond(&mut socket, "recovered answer", "stop").await;
        assert!(tokio::time::timeout(Duration::from_millis(30), listener.accept()).await.is_err(), "one Summary repair only");
        [main, summary, summary_retry, recovered]
    });

        let main = message(&f, &session, "question main").await;
        assert_eq!(main.terminal, Some(Terminal::Completed));
        let summary = compact(&f, &session, &model).await;
        assert_eq!(summary.terminal, Some(Terminal::Failed));
        assert!(summary.baseline.is_none());
        assert!(summary.tools.is_empty(), "Summary tool proposals must not become hard obligations");
        let recovered = message(&f, &session, "question-recovered").await;
        assert_eq!(recovered.terminal, Some(Terminal::Completed));
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 4);
        assert_eq!(effects.load(Ordering::SeqCst), 0);
        let records = facts(&f, summary.run).await;
        assert!(records.iter().any(|record| matches!(&record.fact, Fact::RunTerminated {terminal: Terminal::Failed, diagnostic: Some(reason)} if reason == "summary_contains_tool_content")));
        let attempts: Vec<_> = records.iter().filter_map(|record| match &record.fact {
            Fact::ModelAttemptPrepared {attempt,step} => Some((*attempt,*step)), _=>None,
        }).collect();
        assert_eq!(attempts.len(), 2);
        let original = f.state.request(summary.run, attempts[0].1).await.unwrap();
        let repair = f.state.request(summary.run, attempts[1].1).await.unwrap();
        assert_eq!(original.accounting.purpose, ModelPurpose::Summary);
        assert_eq!(repair.accounting.purpose, ModelPurpose::Summary);
        assert_eq!(original.summary_repair_of, None);
        assert_eq!(repair.summary_repair_of, Some(attempts[0].0));
        assert_eq!(repair.source_capture, original.source_capture, "repair uses the same original fixed source, never today's history");
        assert_eq!(repair.source_digest, original.source_digest);
        for (attempt,_) in &attempts {
            assert!(!records.iter().any(|record| matches!(&record.fact, Fact::ModelObserved {attempt: original, ..} if original == attempt)), "an unexecuted local Summary request stays private");
            let closed = summary.attempts[attempt].closed.as_ref().expect("actual Finished keeps its real closure and usage");
            assert_eq!(closed.outcome, maka_agent_facts::accounting::Outcome::Success);
            assert_eq!(closed.usage.input_tokens, Some(13));
            assert_eq!(closed.usage.output_tokens, Some(7));
            let protocol: ModelClosureProtocol = serde_json::from_value(closed.protocol.clone()).unwrap();
            assert_eq!(protocol.summary, Some(SummaryResult::RejectedToolContent));
        }
        let usage = f.state.usage().activity(
            maka_agent_state::usage::UsageQuery {from:0.0,to:253402300799999.0,owner:Some(summary.spec.owner.clone()),session_id:Some(session.clone()),through:None},
            maka_agent_facts::accounting::Selection::default(), None,
        ).await.unwrap();
        let attempt = usage.attempts.iter().find_map(|activity| match activity {
            maka_agent_facts::accounting::Activity::Model(attempt) if matches!(&attempt.origin, maka_agent_facts::accounting::Origin::Agent {execution,link,purpose} if execution.run_id == summary.run && link.attempt == attempts[0].0 && *purpose == ModelPurpose::Summary) => Some(attempt),
            _=>None,
        }).unwrap();
        assert_eq!(attempt.usage.input_tokens, Some(13));
        assert_eq!(attempt.usage.output_tokens, Some(7), "real Finished remains accountable without publishing a failed Summary body");
        for run in [main.run, summary.run, recovered.run] {
            let records = facts(&f, run).await;
            assert!(!serde_json::to_string(&records).unwrap().contains("private forbidden summary prose"));
            assert!(!records.iter().any(|record| matches!(&record.fact, Fact::ToolAdmitted { .. } | Fact::ToolOriginalBound { .. } | Fact::OperationObserved { .. })));
            assert!(!records.iter().any(|record| matches!(&record.fact, Fact::ContextCompacted { .. })));
        }
        f.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn summary_tool_call_retries_once_with_tool_choice_none_and_records_checkpoint() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let effects = Arc::new(AtomicUsize::new(0));
        let service = echo_service(effects.clone());
        let f = NativeFixture::open_with_service(directory.path(), echo_configuration(&workspace), service).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let model = f.configure_model(&base, "gpt-4.1", "fixture").await.unwrap();
        let session = f.create("Compaction boundaries", &workspace, Some(backend(&model))).await.unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let main = read_request(&mut socket).await;
        respond(&mut socket, "ordinary answer", "stop").await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let summary_first = read_request(&mut socket).await;
        assert!(main["tools"].as_array().unwrap().iter().any(|tool| tool["function"]["name"] == "echo"), "the actual effect service must be advertised");
        assert_eq!(summary_first["tools"], main["tools"]);
        assert_eq!(summary_first["tool_choice"], "auto");
        let call = serde_json::json!({"id":"summary-1","object":"chat.completion.chunk","created":1,"model":"test",
            "choices":[{"index":0,"delta":{"content":"discarded draft","tool_calls":[{"index":0,"id":"forbidden","type":"function",
            "function":{"name":"echo","arguments":"{}"}}]},"finish_reason":null}]});
        let end = serde_json::json!({"id":"summary-1","object":"chat.completion.chunk","created":1,"model":"test",
            "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],
            "usage":{"prompt_tokens":13,"completion_tokens":7,"total_tokens":20}});
        let body = format!("data: {call}\n\ndata: {end}\n\ndata: [DONE]\n\n");
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let summary_retry = read_request(&mut socket).await;
        assert_eq!(summary_retry["tools"], main["tools"]);
        assert_eq!(summary_retry["tool_choice"], "none");
        respond(&mut socket, SUMMARY, "stop").await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let resumed = read_request(&mut socket).await;
        let messages = resumed["messages"].to_string();
        assert!(messages.contains("summary-marker"));
        assert!(!messages.contains("ordinary answer"));
        assert!(!messages.contains("discarded draft"));
        respond(&mut socket, "resumed answer", "stop").await;
        assert!(tokio::time::timeout(Duration::from_millis(30), listener.accept()).await.is_err(), "one Summary repair only");
        [main, summary_first, summary_retry, resumed]
    });

        let main = message(&f, &session, "question main").await;
        assert_eq!(main.terminal, Some(Terminal::Completed));
        let summary = compact(&f, &session, &model).await;
        assert_eq!(summary.terminal, Some(Terminal::Completed));
        assert!(summary.tools.is_empty());
        let body = baseline(&f, &summary).await;
        assert_eq!(body.checkpoint.summary.text_value(), Some(SUMMARY));
        let resumed = message(&f, &session, "question-resumed").await;
        assert_eq!(resumed.terminal, Some(Terminal::Completed));
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 4);
        assert_eq!(effects.load(Ordering::SeqCst), 0);
        let records = facts(&f, summary.run).await;
        assert_eq!(records.iter().filter(|record| matches!(&record.fact, Fact::ContextCompacted { .. })).count(), 1);
        assert!(!records.iter().any(|record| matches!(&record.fact, Fact::ModelObserved {..})), "Summary text belongs only to its validated result and committed checkpoint, never ordinary model history");
        let attempts: Vec<_> = records.iter().filter_map(|record| match &record.fact {
            Fact::ModelAttemptPrepared {attempt,step} => Some((*attempt,*step)), _=>None,
        }).collect();
        assert_eq!(attempts.len(), 2);
        let original = f.state.request(summary.run, attempts[0].1).await.unwrap();
        let repair = f.state.request(summary.run, attempts[1].1).await.unwrap();
        assert_eq!(original.accounting.purpose, ModelPurpose::Summary);
        assert_eq!(repair.accounting.purpose, ModelPurpose::Summary);
        assert_eq!(original.summary_repair_of, None);
        assert_eq!(repair.summary_repair_of, Some(attempts[0].0));
        assert_eq!(repair.source_capture, original.source_capture);
        assert_eq!(repair.source_digest, original.source_digest);
        assert_eq!(body.checkpoint.summary_step_id, attempts[1].1);
        let first_closed = summary.attempts[&attempts[0].0].closed.as_ref().expect("first Summary has its actual Finished closure");
        let first_protocol: ModelClosureProtocol = serde_json::from_value(first_closed.protocol.clone()).unwrap();
        assert_eq!(first_protocol.summary, Some(SummaryResult::RejectedToolContent));
        let repaired_closed = summary.attempts[&attempts[1].0].closed.as_ref().expect("repair has its actual Finished closure");
        let repaired_protocol: ModelClosureProtocol = serde_json::from_value(repaired_closed.protocol.clone()).unwrap();
        let Some(SummaryResult::Text { summary: accepted }) = repaired_protocol.summary else { panic!("successful repair must own validated Summary text") };
        assert_eq!(accepted.text, SUMMARY);
        for run in [main.run, summary.run, resumed.run] {
            let records = facts(&f, run).await;
            assert!(!serde_json::to_string(&records).unwrap().contains("discarded draft"));
            assert!(!records.iter().any(|record| matches!(&record.fact, Fact::ToolAdmitted { .. } | Fact::ToolOriginalBound { .. } | Fact::OperationObserved { .. })));
        }
        f.shutdown().await.unwrap();
    }).await.unwrap();
}
