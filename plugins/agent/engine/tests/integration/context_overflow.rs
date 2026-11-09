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

use crate::support::{context as fixture, native::NativeFixture};
use maka_agent_api::{
    Configuration, ModelSelection,
    contract::{BackendPreference, SendResult},
};
use maka_agent_facts::{
    configuration::{
        CatalogMutationResult, ConnectionCatalogEntryUpdate, ConnectionVersionBasis, ModelOverride,
        Patch, UpdateCatalogConnectionInput,
    },
    context::{
        CompactedContext, ModelClosureProtocol, ModelPurpose, RequestContextEvidence, SummaryResult,
    },
    durable::{AttemptRecovery, Fact, ModelAttemptId, RecordedFact, RequestSpec, RunId, Terminal},
    model::{ModelFinishReason, ModelPart},
};
use maka_agent_state::fold::RunView;
use serde_json::json;
use std::{collections::BTreeMap, path::Path, time::Duration};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
};

fn configuration(workspace: &Path) -> Configuration {
    serde_json::from_value(json!({
        "locale":"en", "workspaceRoots":[{"label":"Workspace","path":workspace}],
        "permissions":{"access":"workspace_write","requestPermissions":false}, "tools":[],
    }))
    .unwrap()
}
fn backend(model: &ModelSelection) -> BackendPreference {
    BackendPreference::Model {
        connection_id: model.connection_id.clone(),
        model_id: model.model_id.clone(),
        thinking_level: None,
    }
}
async fn profile(f: &NativeFixture, model: &ModelSelection, mut value: ModelOverride) {
    value.code_mode = Some(false);
    let row = f
        .config
        .catalog()
        .await
        .unwrap()
        .connections
        .into_iter()
        .find(|row| row.connection_id == model.connection_id)
        .unwrap();
    let result = f
        .config
        .update_connection(UpdateCatalogConnectionInput {
            expected: ConnectionVersionBasis {
                connection_id: row.connection_id,
                revision: row.revision,
            },
            changes: ConnectionCatalogEntryUpdate {
                name: None,
                configuration: None,
                enabled: None,
                enabled_model_ids: None,
                model_overrides: Patch::Set(BTreeMap::from([(model.model_id.clone(), value)])),
                request_body_overlay: Patch::Keep,
            },
        })
        .await
        .unwrap();
    assert!(matches!(result, CatalogMutationResult::Committed { .. }));
}
async fn message(f: &NativeFixture, session: &str, text: &str) -> RunView {
    let SendResult::Queued { message_id, .. } = f.send(session, text, None).await.unwrap() else {
        panic!("actual queued send required")
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
            observed => panic!("queued source did not deliver: {observed:?}"),
        }
    };
    f.wait_terminal(run).await.unwrap()
}
async fn facts(f: &NativeFixture, run: RunId) -> Vec<RecordedFact> {
    let mut records = Vec::new();
    let mut after = 0;
    loop {
        let page = f.state.history(run, after, 256).await.unwrap();
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
async fn requests(f: &NativeFixture, run: RunId) -> Vec<(ModelAttemptId, RequestSpec)> {
    let mut requests = Vec::new();
    for record in facts(f, run).await {
        if let Fact::ModelAttemptPrepared { attempt, step } = record.fact {
            requests.push((attempt, f.state.request(run, step).await.unwrap()));
        }
    }
    requests
}

pub(super) async fn overflow(socket: &mut TcpStream, observed: bool) {
    let error = json!({"error":{"message":"request exceeds context","type":"invalid_request_error","code":"context_length_exceeded"}});
    let (status, media, body) = if observed {
        let chunk = json!({"id":"partial","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"already-observed"},"finish_reason":null}]});
        (
            "200 OK",
            "text/event-stream",
            format!("data: {chunk}\n\ndata: {error}\n\n"),
        )
    } else {
        ("400 Bad Request", "application/json", error.to_string())
    };
    socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: {media}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn overflow_recovers_once_only_without_observed_output() {
    tokio::time::timeout(Duration::from_secs(60), async {
        for observed in [false,true] {
            let recover = !observed;
            let directory = tempfile::tempdir().unwrap();
            let workspace = directory.path().join("workspace");
            std::fs::create_dir(&workspace).unwrap();
            let f = NativeFixture::open(directory.path(),configuration(&workspace)).await.unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1",listener.local_addr().unwrap());
            let model = f.configure_model(&base,"gpt-4.1","fixture").await.unwrap();
            let session = f.create("Overflow recovery",&workspace,Some(backend(&model))).await.unwrap();
            let server = tokio::spawn(async move {
                let mut requests = Vec::new();
                let (mut old,_) = listener.accept().await.unwrap();
                requests.push(fixture::read_request(&mut old).await);
                fixture::respond(&mut old,"old-answer","stop").await;
                let (mut rejected,_) = listener.accept().await.unwrap();
                let rejected_request = fixture::read_request(&mut rejected).await;
                assert_eq!(rejected_request["max_tokens"],128_000);
                requests.push(rejected_request.clone());
                overflow(&mut rejected,observed).await;
                if recover {
                    let (mut summary,_) = listener.accept().await.unwrap();
                    let request = fixture::read_request(&mut summary).await;
                    let instruction = maka_agent_facts::context::default_compaction_prompt(maka_agent_facts::language::Language::En);
                    let first_line = instruction.lines().next().unwrap();
                    let messages = request["messages"].as_array().unwrap();
                    let original = rejected_request["messages"].as_array().unwrap();
                    assert_eq!(messages.len(),original.len()+1);
                    assert_eq!(&messages[..original.len()],original.as_slice(),"overflow Summary starts with the complete original frozen Main prompt");
                    assert!(messages.last().unwrap()["content"].as_str().unwrap().contains(first_line));
                    assert_eq!(request["messages"].to_string().matches(first_line).count(),1,"append exactly one Summary instruction");
                    requests.push(request);
                    fixture::respond(&mut summary,fixture::SUMMARY,"stop").await;
                    let (mut next,_) = listener.accept().await.unwrap();
                    let request = fixture::read_request(&mut next).await;
                    assert!(request["messages"].to_string().contains("summary-marker"));
                    assert_eq!(request["max_tokens"],128_000);
                    requests.push(request);
                    fixture::respond(&mut next,"done","stop").await;
                }
                assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err(),"no unbudgeted recovery request");
                requests
            });
            let old = message(&f,&session,"question-old").await;
            assert_eq!(old.terminal,Some(Terminal::Completed));
            profile(&f,&model,ModelOverride {
                context_window:Some(1_000_000),input_limit:Some(1_000_000),max_output_tokens:Some(128_000),..Default::default()
            }).await;
            let view = message(&f,&session,"question-overflow").await;
            assert_eq!(view.terminal,Some(if recover {Terminal::Completed} else {Terminal::Failed}));
            let physical = server.await.unwrap();
            assert_eq!(physical.len(),if recover {4} else {2});
            let requests = requests(&f,view.run).await;
            assert_eq!(requests.iter().filter(|(_,request)|request.accounting.purpose==ModelPurpose::Main).count(),if recover {2} else {1});
            assert_eq!(requests.iter().filter(|(_,request)|request.accounting.purpose==ModelPurpose::Summary).count(),usize::from(recover));
            let records = facts(&f,view.run).await;
            assert_eq!(records.iter().filter(|record|matches!(&record.fact,Fact::ModelInterrupted {..})).count(),1);
            let (original_attempt,original) = &requests[0];
            assert_eq!(original.accounting.purpose,ModelPurpose::Main);
            assert_eq!(original.composition.max_output_tokens,Some(128_000));
            assert_eq!(original.compaction_recovery,None);
            assert!(matches!(&view.attempts[original_attempt].recovery,Some(AttemptRecovery::ContextOverflow {observed_output}) if *observed_output==observed));
            if recover {
                let (summary_attempt,summary) = &requests[1];
                let (_,continued) = &requests[2];
                assert_eq!(summary.source_capture,original.source_capture);
                assert_eq!(summary.source_digest,original.source_digest);
                assert_eq!(summary.compaction_recovery,Some(*original_attempt));
                assert_eq!(continued.compaction_recovery,Some(*original_attempt));
                assert_eq!(continued.composition.max_output_tokens,Some(128_000));
                assert_eq!(continued.accounting.purpose,ModelPurpose::Main);
                let closed = view.attempts[summary_attempt].closed.as_ref().unwrap();
                assert_eq!(closed.outcome,maka_agent_facts::accounting::Outcome::Success);
                let protocol: ModelClosureProtocol = serde_json::from_value(closed.protocol.clone()).unwrap();
                let Some(SummaryResult::Text {summary}) = protocol.summary else {panic!("overflow Summary must own validated text")};
                assert_eq!(summary.text,fixture::SUMMARY);
                let body: CompactedContext = serde_json::from_slice(&f.state.content(view.run,view.baseline.clone().expect("real committed checkpoint")).await.unwrap()).unwrap();
                body.validate().unwrap();
                assert_eq!(body.checkpoint.summary.text_value(),Some(fixture::SUMMARY));
            } else {
                assert!(view.baseline.is_none());
                assert!(records.iter().any(|record|matches!(&record.fact,Fact::ModelObserved {part:ModelPart::Text {text,..},..} if text.chunks().collect::<String>()=="already-observed")),"observed Main source text remains canonical even when overflow is not recoverable");
            }
            for attempt in view.attempts.values().filter_map(|attempt|attempt.closed.as_ref()) {
                assert_eq!(attempt.usage.input_tokens,Some(20));
                assert_eq!(attempt.usage.output_tokens,Some(50));
            }
            assert_eq!(view.tokens,if recover {140} else {0},"only real Finished usage is charged");
            f.shutdown().await.unwrap();
        }
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proactive_failure_spends_the_same_budget_as_overflow_recovery() {
    const PRIVATE_SUMMARY: &str = "private incomplete summary prose";
    tokio::time::timeout(Duration::from_secs(60), async {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let f = NativeFixture::open(directory.path(),configuration(&workspace)).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1",listener.local_addr().unwrap());
        let model = f.configure_model(&base,"gpt-4.1","fixture").await.unwrap();
        let session = f.create("One shared compaction budget",&workspace,Some(backend(&model))).await.unwrap();
        let server = tokio::spawn(async move {
            let (mut old,_) = listener.accept().await.unwrap();
            fixture::read_request(&mut old).await;
            let mut request_count = 1usize;
            fixture::respond(&mut old,"old-answer","stop").await;
            let mut main = None;
            let mut summaries = 0;
            while summaries < 1 || main.is_none() {
                let (mut socket,_) = listener.accept().await.unwrap();
                request_count += 1;
                let request = fixture::read_request(&mut socket).await;
                if request["messages"].to_string().contains(maka_agent_facts::context::default_compaction_prompt(maka_agent_facts::language::Language::En).lines().next().unwrap()) {
                    summaries+=1;
                    fixture::respond(&mut socket,PRIVATE_SUMMARY,"length").await;
                } else {
                    assert!(main.is_none(),"only one main request before overflow");
                    assert!(request["messages"].to_string().contains("old-answer"));
                    assert!(!request["messages"].to_string().contains("malformed"));
                    assert!(!request["messages"].to_string().contains(PRIVATE_SUMMARY));
                    main=Some(socket);
                }
            }
            let mut main=main.unwrap();
            overflow(&mut main,false).await;
            assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err(),"proactive failure already consumed the one Summary budget");
            assert_eq!(summaries,1);
            request_count
        });
        let old=message(&f,&session,"question-old").await;
        assert_eq!(old.terminal,Some(Terminal::Completed));
        profile(&f,&model,ModelOverride {
            context_window:Some(8192),input_limit:Some(8192),compaction_threshold:Some(1),..Default::default()
        }).await;
        let view=message(&f,&session,"question-latched").await;
        assert_eq!(view.terminal,Some(Terminal::Failed));
        assert_eq!(server.await.unwrap(),3);
        let records=facts(&f,view.run).await;
        assert!(!records.iter().any(|record|matches!(&record.fact,Fact::ContextCompacted {..})));
        assert!(view.baseline.is_none());
        let physical=requests(&f,view.run).await;
        assert_eq!(physical.iter().filter(|(_,request)|request.accounting.purpose==ModelPurpose::Summary).count(),1);
        assert_eq!(physical.iter().filter(|(_,request)|request.accounting.purpose==ModelPurpose::Main).count(),1);
        let (summary_attempt,summary)=physical.iter().find(|(_,request)|request.accounting.purpose==ModelPurpose::Summary).unwrap();
        let (main_attempt,main)=physical.iter().find(|(_,request)|request.accounting.purpose==ModelPurpose::Main).unwrap();
        assert!(matches!(&view.attempts[main_attempt].recovery,Some(AttemptRecovery::ContextOverflow {observed_output:false})));
        assert_eq!(main.compaction_recovery,Some(*summary_attempt),"failed proactive compaction consumes the same once-per-Run recovery budget");
        let initial=records.iter().filter_map(|record|match &record.fact {Fact::StepPrepared {step,..}=>Some(*step),_=>None});
        let mut original=None;
        for step in initial {
            let request=f.state.request(view.run,step).await.unwrap();
            if request.accounting.purpose==ModelPurpose::Main && request.compaction_recovery.is_none() {original=Some(request);break;}
        }
        let original=original.expect("the original Main was frozen before proactive Summary, not dispatched or fabricated");
        assert_eq!(main.source_capture,original.source_capture,"failed proactive Summary must restore the exact original frozen Main source");
        assert_eq!(main.source_digest,original.source_digest);
        assert_eq!(main.request,original.request,"do not recapture the queue or rebuild original Main material");
        let evidence: RequestContextEvidence=serde_json::from_slice(&f.state.content(view.run,summary.provenance.clone()).await.unwrap()).unwrap();
        assert_eq!(evidence.model_context.unwrap().declared_window,Some(1));
        let closed=view.attempts[summary_attempt].closed.as_ref().unwrap();
        assert_eq!(closed.outcome,maka_agent_facts::accounting::Outcome::Success);
        assert_eq!(closed.usage.input_tokens,Some(20));
        assert_eq!(closed.usage.output_tokens,Some(50));
        let protocol: ModelClosureProtocol=serde_json::from_value(closed.protocol.clone()).unwrap();
        assert_eq!(protocol.finish_reason,ModelFinishReason::Length);
        assert_eq!(protocol.summary,Some(SummaryResult::Incomplete));
        assert!(!records.iter().any(|record|matches!(&record.fact,Fact::ModelObserved {attempt,..} if attempt==summary_attempt)),"failed proactive Summary body stays private");
        assert!(!serde_json::to_string(&records).unwrap().contains(PRIVATE_SUMMARY),"private failed Summary text cannot enter canonical closures or model history");
        assert_eq!(view.tokens,70);
        f.shutdown().await.unwrap();
    }).await.unwrap();
}
