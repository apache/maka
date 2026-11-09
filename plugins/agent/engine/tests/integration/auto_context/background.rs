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

pub(super) async fn tool_response(
    socket: &mut TcpStream,
    name: &str,
    id: &str,
    input: Value,
    input_tokens: u64,
) {
    let delta = json!({"id":"tool","object":"chat.completion.chunk","created":1,"model":"test",
        "choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":id,"type":"function",
            "function":{"name":name,"arguments":input.to_string()}}]},"finish_reason":null}]});
    let end = json!({"id":"tool","object":"chat.completion.chunk","created":1,"model":"test",
        "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],
        "usage":{"prompt_tokens":input_tokens,"completion_tokens":3,"total_tokens":input_tokens+3}});
    let body = format!("data: {delta}\n\ndata: {end}\n\ndata: [DONE]\n\n");
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
pub(super) async fn respond_tail_call_with_usage(
    socket: &mut TcpStream,
    id: &str,
    value: impl serde::Serialize,
    input_tokens: u64,
) {
    tool_response(socket, "echo", id, json!({"value":value}), input_tokens).await;
}
async fn respond_tail_call(socket: &mut TcpStream, id: &str, value: impl serde::Serialize) {
    respond_tail_call_with_usage(socket, id, value, 4).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn background_summary_preserves_steering_tool_tail_and_frozen_physical_retry() {
    tokio::time::timeout(Duration::from_secs(90),async {
            let directory=tempfile::tempdir().unwrap();
            let effects=Arc::new(Effects::default());
            let f=open(directory.path(),effects.clone()).await;
            let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base=format!("http://{}/v1",listener.local_addr().unwrap());
            let model=f.configure_model(&base,"test","fixture").await.unwrap();
            override_model(&f,&model,limits(Some(110_000),false)).await;
            let session=f.create("Prepared tool tail",directory.path(),Some(backend(&model))).await.unwrap();
            let (steer_at,steer_ready)=tokio::sync::oneshot::channel();
            let (steer_done,steered)=tokio::sync::oneshot::channel();
            let server=tokio::spawn(async move {
                let key="messages";
                let (mut old,_)=incoming(&listener).await;
                respond_with_usage(&mut old,"old-answer","stop",json!({"prompt_tokens":100_000,"completion_tokens":50})).await;
                let (mut summary,request)=incoming(&listener).await;
                assert!(is_summary(&request));
                let covered=request[key].to_string();
                for absent in ["question next","A queued correction","during-summary-call"] {
                    assert!(!covered.contains(absent));
                }
                respond(&mut summary,SUMMARY,"stop").await;
                // Preparation is sequential; a finished candidate must not replace
                // the original Main until adoption or a real no-output overflow.
                let (mut main,request)=incoming(&listener).await;
                assert!(request[key].to_string().contains("old-answer"));
                assert!(!request[key].to_string().contains("summary-marker"));
                respond_tail_call_with_usage(&mut main,"during-summary-call",41,100_000).await;
                let (mut observing,request)=incoming(&listener).await;
                assert!(request[key].to_string().contains("during-summary-call"));
                steer_at.send(()).unwrap();
                steered.await.unwrap();
                respond_with_usage(&mut observing,"","stop",json!({"prompt_tokens":100_000,"completion_tokens":0})).await;
                let (mut main,frozen)=incoming(&listener).await;
                let messages=frozen[key].as_array().unwrap();
                assert!(messages.iter().any(|message|message.to_string().contains("A queued correction")));
                assert!(!frozen[key].to_string().contains("summary-marker"));
                let tail_start=messages.iter().position(|message|message["role"]=="user"
                    &&message["content"].to_string().contains("question next")).unwrap();
                let frozen_tail=messages[tail_start..].to_vec();
                assert_eq!(frozen_tail.iter().filter(|message|message["role"]=="tool").count(),1);
                assert!(frozen_tail.iter().any(|message|message["role"]=="tool"&&message.to_string().contains("41")));
                let bad=r#"{"error":{"message":"retry","type":"rate_limit_error"}}"#;
                main.write_all(format!("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 0.01\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{bad}",bad.len()).as_bytes()).await.unwrap();
                let (mut retry,retried)=incoming(&listener).await;
                assert_eq!(retried,frozen,"physical retry retains its exact original Frozen input and steering cut");
                respond_tail_call_with_usage(&mut retry,"while-summary-ready",43,100_000).await;
                let (mut below,request)=incoming(&listener).await;
                assert!(request[key].to_string().contains("old-answer"));
                assert!(!request[key].to_string().contains("summary-marker"),"ready is not adopted below 100%");
                respond_tail_call_with_usage(&mut below,"after-summary-call",42,110_000).await;
                let (mut adopted,request)=incoming(&listener).await;
                let messages=request[key].as_array().unwrap();
                let wire=request[key].to_string();
                assert!(wire.contains("summary-marker")&&!wire.contains("old-answer"));
                assert_eq!(wire.matches("A queued correction").count(),1);
                let start=messages.iter().position(|message|message["role"]=="user"
                    &&message["content"].to_string().contains("question next")).unwrap();
                assert!(messages[..start].iter().any(|message|message.to_string().contains("summary-marker")));
                assert_eq!(&messages[start..start+frozen_tail.len()],frozen_tail.as_slice(),"fixed capture never swallows or reorders newer messages");
                let later=&messages[start+frozen_tail.len()..];
                assert_eq!(later.len(),4,"each later tool contributes one call and its one result");
                assert!(later[0].to_string().contains("while-summary-ready"));
                assert!(later[1]["role"]=="tool");
                assert!(later[2].to_string().contains("after-summary-call"));
                assert!(later[3]["role"]=="tool"&&later[3].to_string().contains("42"));
                for id in ["during-summary-call","after-summary-call"] {
                    assert_eq!(messages.iter().filter(|message|message["role"]=="tool"&&message["tool_call_id"]==id).count(),1);
                }
                respond(&mut adopted,"done","stop").await;
            });
            message(&f,&session,"question old").await;
            let run=send(&f,&session,"question next").await;
            steer_ready.await.unwrap();
            let queued=f.mutation_value("send",json!({
                "sessionId":session,"message":"A queued correction","delivery":"steer","expectedRunId":run,
            })).await.unwrap();
            assert_eq!(queued["kind"],"queued");
            steer_done.send(()).unwrap();
            let view=f.wait_terminal(run).await.unwrap();
            assert_eq!(view.terminal,Some(Terminal::Completed));
            server.await.unwrap();
            assert_eq!(effects.inputs.lock().unwrap().as_slice(),[
                json!({"value":41}),json!({"value":43}),json!({"value":42}),
            ]);
            let prepared=requests(&f,run).await;
            let summaries:Vec<_>=prepared.iter().filter(|request|request.accounting.purpose==ModelPurpose::Summary).collect();
            assert_eq!(summaries.len(),1);
            let body=compacted(&f,&view).await;
            assert_eq!(body.checkpoint.summary_step_id,summaries[0].step);
            let source:RequestSource=decode(&f,run,&summaries[0].source_capture).await;
            assert_eq!(body.source_capture,summaries[0].source_capture);
            assert_eq!(body.checkpoint.covered_through,source.current.through_sequence,"checkpoint stays at its original capture");
            let facts=records(&f,run).await;
            let mut attempts=Vec::new();
            for record in &facts {
                if let Fact::ModelAttemptAdmitted {attempt,..}=&record.fact {
                    attempts.push((*attempt,f.state.request(run,view.attempts[attempt].step).await.unwrap()));
                }
            }
            assert_eq!(attempts.len(),7,"seven actual model POSTs follow the completed old Run");
            let summary_attempt=attempts[0].0;
            assert_eq!(attempts[0].1.step,summaries[0].step);
            assert!(attempts.iter().filter(|(_,request)|request.accounting.purpose==ModelPurpose::Main)
                .all(|(_,request)|request.compaction_recovery==Some(summary_attempt)));
            let original=prepared.iter().find(|request|request.accounting.purpose==ModelPurpose::Main
                &&request.compaction_recovery.is_none()&&!view.attempts.values().any(|attempt|attempt.step==request.step))
                .expect("actual unattempted Main precedes preparation of the Summary");
            assert_eq!(attempts[1].1.request,original.request);
            assert_eq!(attempts[1].1.source_capture,original.source_capture);
            assert_eq!(attempts[1].1.source_digest,original.source_digest);
            let timing:RequestContextEvidence=decode(&f,run,&attempts[1].1.provenance).await;
            assert!((93_500..110_000).contains(&timing.estimated_input_tokens));
            assert_ne!(attempts[3].0,attempts[4].0);
            assert_eq!(attempts[3].1.step,attempts[4].1.step);
            assert_eq!(attempts[3].1.request,attempts[4].1.request);
            assert_eq!(attempts[3].1.source_capture,attempts[4].1.source_capture);
            assert_eq!(attempts[3].1.source_digest,attempts[4].1.source_digest);
            assert!(!facts.iter().any(|record|matches!(&record.fact,Fact::ModelObserved {attempt,..} if *attempt==summary_attempt)));
            assert_eq!(facts.iter().filter(|record|matches!(record.fact,Fact::ToolAdmitted {..})).count(),3);
            assert_eq!(facts.iter().filter(|record|matches!(record.fact,Fact::ToolResultAccepted {..})).count(),3);
            assert!(facts.iter().filter(|record|matches!(record.fact,Fact::ToolAdmitted {..}|Fact::ToolResultAccepted {..}))
                .all(|record|record.revision>source.current_revision));
            f.shutdown().await.unwrap();
        }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn background_summary_drains_before_terminal_handoff_and_retirement() {
    use crate::support::canonical;
    use maka_agent_facts::durable::{Fact as DurableFact, UnixMillis};
    use maka_agent_state::Change;
    for ending in [
        "finish-ready",
        "complete",
        "cancel",
        "handoff",
        "retire",
        "summary-tool",
    ] {
        tokio::time::timeout(Duration::from_secs(90),async {
            let directory=tempfile::tempdir().unwrap();
            let effects=Arc::new(Effects::default());
            let f=open(directory.path(),effects.clone()).await;
            let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base=format!("http://{}/v1",listener.local_addr().unwrap());
            let model=f.configure_model(&base,"test","fixture").await.unwrap();
            override_model(&f,&model,limits(Some(110_000),false)).await;
            let session=f.create("Summary lifecycle",directory.path(),Some(backend(&model))).await.unwrap();
            let (ready,seen)=tokio::sync::oneshot::channel();
            let (release,released)=tokio::sync::oneshot::channel();
            let server=tokio::spawn(async move {
                let (mut old,_)=incoming(&listener).await;
                respond_with_usage(&mut old,"old","stop",json!({"prompt_tokens":100_000,"completion_tokens":50})).await;
                let (mut summary,request)=incoming(&listener).await;
                assert!(is_summary(&request));
                if matches!(ending,"cancel"|"retire") {
                    summary.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                    let delta=json!({"id":"summary","object":"chat.completion.chunk","created":1,"model":"test",
                        "choices":[{"index":0,"delta":{"content":"private unfinished summary"},"finish_reason":null}]});
                    summary.write_all(format!("data: {delta}\n\n").as_bytes()).await.unwrap();
                    ready.send(()).unwrap();
                    released.await.unwrap();
                    let mut remainder=Vec::new();
                    summary.read_to_end(&mut remainder).await.unwrap();
                    return;
                }
                if ending=="summary-tool" {
                    tool_response(&mut summary,"echo","forbidden-summary-call",json!({"value":99}),13).await;
                    let (mut repair,request)=incoming(&listener).await;
                    assert!(is_summary(&request));
                    assert_eq!(request["tool_choice"],"none");
                    tool_response(&mut repair,"echo","forbidden-summary-call",json!({"value":99}),13).await;
                }else if ending=="complete" {
                    respond(&mut summary,"private unfinished summary","length").await;
                }else{respond(&mut summary,SUMMARY,"stop").await;}
                let (mut main,request)=incoming(&listener).await;
                assert!(!is_summary(&request));
                assert!(request["messages"].to_string().contains("old"));
                assert!(!request["messages"].to_string().contains("summary-marker"));
                if matches!(ending,"handoff"|"finish-ready") {
                    respond_tail_call_with_usage(&mut main,"actual-effect",41,if ending=="finish-ready"{110_000}else{100_000}).await;
                    let (socket,request)=incoming(&listener).await;
                    main=socket;
                    assert!(request["messages"].to_string().contains("actual-effect"));
                    assert_eq!(request["messages"].to_string().contains("summary-marker"),ending=="finish-ready");
                }
                ready.send(()).unwrap();
                released.await.unwrap();
                if ending=="handoff" {
                    let mut remainder=Vec::new();
                    main.read_to_end(&mut remainder).await.unwrap();
                }else{respond(&mut main,"completed after preparation","stop").await;}
            });
            message(&f,&session,"question-old").await;
            let run=send(&f,&session,"question-next").await;
            seen.await.unwrap();
            let original=f.state.frontier(run).await.unwrap();
            let original_requests=requests(&f,run).await;
            let public=public_history(&f,&session).await;
            assert!(!public.to_string().contains("private unfinished summary"));
            if ending!="finish-ready" {assert!(!public.to_string().contains("summary-marker"),"unused candidate is not public conversation content");}
            let retired=matches!(ending,"handoff"|"retire");
            if ending=="cancel" {
                assert_eq!(f.mutation_value("stop",json!({"sessionId":session,"runId":run})).await.unwrap(),json!({"requested":true}));
            }else if retired {
                let at=UnixMillis(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis().try_into().unwrap());
                let stale=f.state.claim(run).await.unwrap();
                let _current=f.state.claim(run).await.unwrap();
                assert!(matches!(maka_agent_engine::Engine::new(f.state.clone()).drive(
                    stale,Arc::new(canonical::NoEffects(at)),tokio_util::sync::CancellationToken::new(),
                ).await.unwrap(),maka_agent_engine::DriverExit::Retired {..}),
                    "only a real DriverClaim retires, without opening a physical successor Run");
                assert!(f.state.frontier(run).await.unwrap().terminal.is_none(),"claim retirement is not logical failure");
            }
            release.send(()).unwrap();
            let view=if retired {
                f.app.shutdown().await.unwrap();
                server.await.unwrap();
                let view=f.state.frontier(run).await.unwrap();
                let at=UnixMillis(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis().try_into().unwrap());
                let change=Change::new(DurableFact::StopRequested {diagnostic:"explicit drain after original driver retirement".into()},at);
                f.state.control(run,(&view).into(),vec![change],vec![]).await.unwrap();
                assert!(matches!(canonical::drive(&f.state,run,at).await,
                    maka_agent_engine::DriverExit::Terminal {terminal:Terminal::Cancelled,..}));
                f.state.frontier(run).await.unwrap()
            }else {
                let view=f.wait_terminal(run).await.unwrap();
                server.await.unwrap();view
            };
            assert_eq!(view.terminal,Some(if ending=="cancel"||retired{Terminal::Cancelled}else{Terminal::Completed}));
            assert_eq!(effects.inputs.lock().unwrap().len(),usize::from(matches!(ending,"handoff"|"finish-ready")));
            assert_eq!(view.baseline.is_some(),ending=="finish-ready");
            for request in &original_requests {
                assert_eq!(f.state.request(run,request.step).await.unwrap(),*request,"late cleanup cannot replace frozen source evidence");
            }
            for (id,attempt) in &original.attempts {
                if let Some(closed)=&attempt.closed {assert_eq!(view.attempts[id].closed.as_ref(),Some(closed));}
            }
            for attempt in view.attempts.values() {
                if attempt.admission.is_some() {
                    assert_eq!(attempt.cleanup,maka_plugin_core::operation::OperationCleanup::Confirmed,"original admitted producer is joined before terminal");
                }
            }
            let records=records(&f,run).await;
            assert!(!serde_json::to_string(&records).unwrap().contains("private unfinished summary"));
            if ending=="summary-tool" {
                assert!(view.tools.is_empty(),"Summary has no authority to dispatch its local proposal");
                let prepared=requests(&f,run).await;
                assert_eq!(prepared.iter().filter(|r|r.accounting.purpose==ModelPurpose::Summary).count(),2);
                for request in prepared.iter().filter(|r|r.accounting.purpose==ModelPurpose::Summary) {
                    let attempt=view.attempts.values().find(|a|a.step==request.step).unwrap();
                    let protocol:ModelClosureProtocol=serde_json::from_value(attempt.closed.as_ref().unwrap().protocol.clone()).unwrap();
                    assert_eq!(protocol.summary,Some(SummaryResult::RejectedToolContent));
                }
            }
            if retired {f.config.shutdown().await.unwrap();f.root.shutdown().await.unwrap();drop(f);}
            else {f.shutdown().await.unwrap();}
            let f=open(directory.path(),Arc::new(Effects::default())).await;
            assert_eq!(f.state.frontier(run).await.unwrap(),view);
            let history=public_history(&f,&session).await.to_string();
            assert!(!history.contains("private unfinished summary"));
            if ending!="finish-ready" {assert!(!history.contains("summary-marker"),"reopen does not publish an unused candidate");}
            if ending=="finish-ready" {assert_eq!(compacted(&f,&view).await.checkpoint.summary.text_value().unwrap(),SUMMARY);}
            f.shutdown().await.unwrap();
        }).await.expect("original Summary source and driver custody must drain without a physical background engine");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejected_local_summary_preserves_main_tool_context_and_next_turn() {
    tokio::time::timeout(Duration::from_secs(90),async {
        let directory=tempfile::tempdir().unwrap();
        let effects=Arc::new(Effects::default());
        let f=open(directory.path(),effects.clone()).await;
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base=format!("http://{}/v1",listener.local_addr().unwrap());
        let model=f.configure_model(&base,"test","fixture").await.unwrap();
        override_model(&f,&model,limits(Some(110_000),false)).await;
        let session=f.create("Rejected private summary",directory.path(),Some(backend(&model))).await.unwrap();
        let original_body="original-tool-body-".repeat(1024);
        let old_body=original_body.clone();
        let server=tokio::spawn(async move {
            let (mut old,_)=incoming(&listener).await;
            respond_tail_call(&mut old,"original-call",&old_body).await;
            let (mut old,request)=incoming(&listener).await;
            assert!(request["messages"].to_string().contains(&old_body));
            respond_with_usage(&mut old,"old-answer","stop",json!({"prompt_tokens":100_000,"completion_tokens":50})).await;
            for repair in [false,true] {
                let (mut summary,request)=incoming(&listener).await;
                assert!(is_summary(&request));
                assert!(request["messages"].to_string().contains(&old_body));
                assert_eq!(request["tool_choice"],if repair{"none"}else{"auto"});
                let delta=json!({"id":"summary","object":"chat.completion.chunk","created":1,"model":"test",
                    "choices":[{"index":0,"delta":{"content":"private rejected summary prose",
                        "tool_calls":[{"index":0,"id":"forbidden-summary-call","type":"function",
                            "function":{"name":"echo","arguments":"{\"value\":99}"}}]},"finish_reason":null}]});
                let end=json!({"id":"summary","object":"chat.completion.chunk","created":1,"model":"test",
                    "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],
                    "usage":{"prompt_tokens":13,"completion_tokens":7,"total_tokens":20}});
                let body=format!("data: {delta}\n\ndata: {end}\n\ndata: [DONE]\n\n");
                summary.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            }
            let (mut main,request)=incoming(&listener).await;
            assert!(!is_summary(&request));
            assert!(request["messages"].to_string().contains(&old_body));
            respond_tail_call(&mut main,"next-call",41).await;
            let (mut main,request)=incoming(&listener).await;
            let body=request["messages"].to_string();
            for retained in [&old_body,"old-answer","next-call"] {assert!(body.contains(retained));}
            for absent in ["private rejected summary prose","forbidden-summary-call"] {assert!(!body.contains(absent));}
            respond(&mut main,"completed after rejected summary","stop").await;
            let (mut later,request)=incoming(&listener).await;
            let body=request["messages"].to_string();
            assert!(body.contains(&old_body)&&body.contains("completed after rejected summary"));
            assert!(!body.contains("private rejected summary prose")&&!body.contains("forbidden-summary-call"));
            respond(&mut later,"next turn completed","stop").await;
        });
        message(&f,&session,"question-old").await;
        let view=message(&f,&session,"question-next").await;
        assert!(view.baseline.is_none());
        assert_eq!(effects.inputs.lock().unwrap().as_slice(),[
            json!({"value":original_body}),json!({"value":41}),
        ]);
        let prepared=requests(&f,view.run).await;
        let summaries:Vec<_>=prepared.iter().filter(|r|r.accounting.purpose==ModelPurpose::Summary).collect();
        assert_eq!(summaries.len(),2);
        for request in &summaries {
            let attempt=view.attempts.values().find(|a|a.step==request.step).unwrap();
            let closed=attempt.closed.as_ref().unwrap();
            let protocol:ModelClosureProtocol=serde_json::from_value(closed.protocol.clone()).unwrap();
            assert_eq!(protocol.summary,Some(SummaryResult::RejectedToolContent));
            assert_eq!(closed.usage.input_tokens,Some(13));assert_eq!(closed.usage.output_tokens,Some(7));
        }
        let facts=records(&f,view.run).await;
        assert!(!facts.iter().any(|r|matches!(r.fact,Fact::ContextCompacted {..})));
        assert!(!facts.iter().any(|record|matches!(&record.fact,Fact::ModelObserved {attempt,..}
            if summaries.iter().any(|request|view.attempts[attempt].step==request.step))));
        assert!(!serde_json::to_string(&facts).unwrap().contains("private rejected summary prose"));
        f.shutdown().await.unwrap();
        let f=open(directory.path(),Arc::new(Effects::default())).await;
        assert_eq!(f.state.frontier(view.run).await.unwrap(),view);
        message(&f,&session,"question-later").await;
        server.await.unwrap();
        assert!(f.state.frontier(view.run).await.unwrap().baseline.is_none());
        assert_eq!(effects.inputs.lock().unwrap().len(),2,"reopen never replays an original service effect");
        assert!(!public_history(&f,&session).await.to_string().contains("private rejected summary prose"));
        f.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn historical_unknown_tool_does_not_disable_automatic_compaction_or_pin_old_context() {
    tokio::time::timeout(Duration::from_secs(90),async {
        let directory=tempfile::tempdir().unwrap();
        let effects=Arc::new(Effects::default());
        let f=open(directory.path(),effects.clone()).await;
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base=format!("http://{}/v1",listener.local_addr().unwrap());
        let model=f.configure_model(&base,"test","fixture").await.unwrap();
        override_model(&f,&model,limits(Some(110_000),false)).await;
        let session=f.create("Historical unknown",directory.path(),Some(backend(&model))).await.unwrap();
        let server=tokio::spawn(async move {
            let (mut legacy,_)=incoming(&listener).await;
            tool_response(&mut legacy,"echo","legacy-browser-call",json!({"unknown":true}),4).await;
            let (mut old,request)=incoming(&listener).await;
            assert!(request["messages"].to_string().contains("legacy-browser-call"));
            respond_with_usage(&mut old,"old-answer","stop",json!({"prompt_tokens":100_000,"completion_tokens":50})).await;
            let (mut summary,request)=incoming(&listener).await;
            assert!(is_summary(&request));
            assert!(request["messages"].as_array().unwrap().iter().any(|message|
                message["role"]=="tool"&&message["tool_call_id"]=="legacy-browser-call"
                &&message["content"].as_str().is_some_and(|text|text.to_lowercase().contains("unknown"))));
            respond(&mut summary,SUMMARY,"stop").await;
            let (mut main,request)=incoming(&listener).await;
            assert!(!is_summary(&request));
            assert!(request["messages"].to_string().contains("legacy-browser-call"));
            respond_tail_call_with_usage(&mut main,"new-call-1",41,110_000).await;
            let (mut adopted,request)=incoming(&listener).await;
            let body=request["messages"].to_string();
            assert!(body.contains("summary-marker")&&body.contains("new-call-1"));
            assert!(!body.contains("legacy-browser-call")&&!body.contains("original browser outcome unknown"));
            respond(&mut adopted,"done after compaction","stop").await;
            listener
        });
        let legacy=send(&f,&session,"old browser work").await;
        let mut changes=f.state.subscribe().unwrap();
        let blocked=loop {
            changes.borrow_and_update();
            let view=f.state.frontier(legacy).await.unwrap();
            if view.blockers.values().any(|blocker|matches!(blocker.reason,
                maka_agent_facts::durable::BlockerKind::OperationUnknown {..})){break view;}
            changes.changed().await.unwrap();
        };
        let (blocker,_)=blocked.blockers.iter().find(|(_,blocker)|matches!(blocker.reason,
            maka_agent_facts::durable::BlockerKind::OperationUnknown {..})).unwrap();
        assert_eq!(effects.inputs.lock().unwrap().as_slice(),[json!({"unknown":true})]);
        f.mutation_value("adjudicateRisk",json!({
            "sessionId":session,"runId":legacy,"expectedHighWater":blocked.revision,
            "blockerId":blocker,"decision":{"kind":"cancel_blocked_run","diagnostic":"original browser outcome unknown; cancel without replay"},
        })).await.unwrap();
        let cancelled=f.wait_terminal(legacy).await.unwrap();
        assert_eq!(cancelled.terminal,Some(Terminal::Cancelled));
        let original=records(&f,legacy).await;
        assert_eq!(original.iter().filter(|record|matches!(record.fact,Fact::ToolAdmitted {..})).count(),1);
        assert_eq!(original.iter().filter(|record|matches!(&record.fact,Fact::OperationObserved {reply,..}
            if matches!(reply.receipt,Receipt::Recorded {outcome:OperationOutcome::Unknown {..},..}))).count(),1);
        message(&f,&session,"question-old").await;
        let view=message(&f,&session,"question-next").await;
        let listener=server.await.unwrap();
        assert!(view.baseline.is_some());
        assert_eq!(compacted(&f,&view).await.checkpoint.summary.text_value().unwrap(),SUMMARY);
        assert_eq!(records(&f,legacy).await,original,"compaction never rewrites an original Unknown T2");
        assert_eq!(effects.inputs.lock().unwrap().as_slice(),[json!({"unknown":true}),json!({"value":41})]);
        assert_eq!(view.tools.len(),1);
        f.shutdown().await.unwrap();
        let reopened_effects=Arc::new(Effects::default());
        let f=open(directory.path(),reopened_effects.clone()).await;
        assert_eq!(records(&f,legacy).await,original);
        let replay=tokio::spawn(async move {
            let (mut socket,request)=incoming(&listener).await;
            let body=request["messages"].to_string();
            assert!(body.contains("summary-marker"));
            assert!(!body.contains("legacy-browser-call"));
            respond(&mut socket,"reopened","stop").await;
        });
        message(&f,&session,"question-reopened").await;
        replay.await.unwrap();
        assert!(reopened_effects.inputs.lock().unwrap().is_empty());
        assert_eq!(records(&f,legacy).await,original);
        f.shutdown().await.unwrap();
    }).await.expect("historical Unknown must not disable compaction or repeat its admitted effect");
}
