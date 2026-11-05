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

use super::external_support::{configured, input, input_runtime, packet, record, release, setup};
use super::*;
use futures_util::FutureExt;
use tokio::io::BufReader;

#[tokio::test]
async fn native_external_all_protocols_persist_before_prompt_and_resume_original_identity() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        for runtime in ["codex", "antigravity", "claude"] {
            let session = f.create(&format!("Native {runtime}")).await;
            let mut original = None;
            for _ in 0..2 {
                let operation = Uuid::new_v4();
                let input = input_runtime(&session, runtime, "complete");
                let accepted = f.mutation(2,"send",input.clone(),operation).await.unwrap();
                assert_eq!(accepted["kind"],"started","{accepted}");
                eprintln!("native fixture {runtime}: admitted");
                let socket = tokio::select! {
                    socket = listener.accept() => socket.unwrap().0,
                    () = f.drained() => panic!("native ended before fixture prompt: {}",work(&f,&session,&accepted).await),
                };
                let mut control = BufReader::new(socket);
                let opened = packet(&mut control,"opened").await;
                eprintln!("native fixture {runtime}: opened");
                let journal = super::external_support::record_runtime(&f,&session,runtime).await;
                assert_eq!(journal["running"],accepted["invocationId"],"journal must be durable before native prompt admission");
                let current = journal["nativeSession"].as_str().unwrap().to_owned();
                if let Some(original) = &original { assert_eq!(original,&current); assert_eq!(opened["request"]["resume"],current); }
                else { assert!(opened["request"].get("resume").is_none()); original = Some(current); }
                release(&mut control).await;
                packet(&mut control,"output").await;
                release(&mut control).await;
                packet(&mut control,"terminal").await;
                assert_eq!(super::external_support::record_runtime(&f,&session,runtime).await["running"],accepted["invocationId"]);
                release(&mut control).await;
                eprintln!("native fixture {runtime}: waiting settlement");
                f.drained().await;
                eprintln!("native fixture {runtime}: settled");
                let final_work=work(&f,&session,&accepted).await;
                assert_eq!(final_work["execution"]["state"],"completed","{runtime}: {final_work}");
                assert_eq!(final_work["answer"]["text"],"committed output");
                assert!(super::external_support::record_runtime(&f,&session,runtime).await["running"].is_null());
                assert_eq!(f.mutation(2,"send",input,operation).await.unwrap(),accepted);
                assert!(listener.accept().now_or_never().is_none());
            }
        }
        f.app.shutdown().await.unwrap(); f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_external_eof_exit_zero_malformed_and_unrelated_turn_never_complete_or_replay() {
    tokio::time::timeout(Duration::from_secs(60), async {
        for message in ["crash", "exit0", "malformed", "wrong-turn"] {
            let (f, listener) = setup("http://127.0.0.1:9/v1").await;
            let session = f.create("Native terminal correlation").await;
            let operation = Uuid::new_v4();
            let request = input(&session, message);
            let accepted = f
                .mutation(2, "send", request.clone(), operation)
                .await
                .unwrap();
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            packet(&mut control, "opened").await;
            release(&mut control).await;
            packet(&mut control, "output").await;
            release(&mut control).await;
            if message == "wrong-turn" {
                packet(&mut control, "terminal").await;
                release(&mut control).await;
            }
            f.drained().await;
            assert_eq!(
                work(&f, &session, &accepted).await["execution"]["state"],
                "failed"
            );
            assert_eq!(
                record(&f, &session).await["running"],
                accepted["invocationId"]
            );
            assert_eq!(
                f.mutation(2, "send", request, operation).await.unwrap(),
                accepted
            );
            let next = f
                .mutation(
                    2,
                    "send",
                    input(&session, "must-not-replay"),
                    Uuid::new_v4(),
                )
                .await
                .unwrap();
            f.drained().await;
            assert_eq!(
                work(&f, &session, &next).await["execution"]["state"],
                "failed"
            );
            assert!(listener.accept().now_or_never().is_none());
            if message == "malformed" {
                f.app.shutdown().await.unwrap();
            } else {
                assert!(
                    f.app
                        .shutdown_if_idle()
                        .await
                        .unwrap_err()
                        .contains("cleanup_unconfirmed"),
                    "proxy exit cannot prove a shared daemon turn has stopped"
                );
            }
            f.config.shutdown().await.unwrap();
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_external_stop_never_relabels_cancelled_turn_as_completed() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        for runtime in ["codex", "antigravity", "claude"] {
            let session = f.create("Native cancellation").await;
            let accepted = f
                .mutation(
                    2,
                    "send",
                    input_runtime(
                        &session,
                        runtime,
                        if runtime == "codex" {
                            "wait-cancel-terminal"
                        } else {
                            "wait"
                        },
                    ),
                    Uuid::new_v4(),
                )
                .await
                .unwrap();
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            packet(&mut control, "opened").await;
            release(&mut control).await;
            packet(&mut control, "output").await;
            f.mutation(
                2,
                "stop",
                json!({"sessionId":session,"invocationId":accepted["invocationId"]}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
            if runtime == "codex" {
                packet(&mut control, "interrupt_requested").await;
                assert_eq!(
                    super::external_support::record_runtime(&f, &session, runtime).await["running"],
                    accepted["invocationId"],
                    "an interrupt request or proxy lifetime cannot settle a daemon turn"
                );
                assert!(!f.owner.runs.lock().await.controls.is_empty());
                release(&mut control).await;
            }
            f.drained().await;
            let observed = work(&f, &session, &accepted).await;
            assert_eq!(
                observed["execution"]["state"], "cancelled",
                "{runtime}: {observed}"
            );
            assert!(
                super::external_support::record_runtime(&f, &session, runtime).await["running"]
                    .is_null()
            );
        }
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_external_discovery_keeps_native_models_and_reports_unsupported_claude_capabilities()
{
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = configured("http://127.0.0.1:9/v1", |settings| {
            settings.external.as_mut().unwrap().runtimes.antigravity = false;
        })
        .await;
        let page = f
            .query("models", json!({"kind":"start","query":"External codex"}))
            .await
            .unwrap();
        assert_eq!(page["choices"].as_array().unwrap().len(), 16, "{page}");
        assert_eq!(
            page["choices"]
                .as_array()
                .unwrap()
                .iter()
                .find(
                    |choice| choice["selection"]["selection"]["settings"]["model"] == "external-0"
                )
                .unwrap()["thinkingLevels"],
            json!(["vendor-deep"])
        );
        assert_eq!(
            page["choices"]
                .as_array()
                .unwrap()
                .iter()
                .find(
                    |choice| choice["selection"]["selection"]["settings"]["model"] == "external-0"
                )
                .unwrap()["defaultThinkingLevel"],
            "vendor-deep"
        );
        let next = f
            .query(
                "models",
                json!({"kind":"continue","revision":page["revision"],"cursor":page["next"]}),
            )
            .await
            .unwrap();
        assert_eq!(next["choices"].as_array().unwrap().len(), 5);
        let status = f.query("externalAgents", json!({})).await.unwrap();
        let rows = status["state"]["runtimes"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], "codex");
        assert_eq!(rows[1]["id"], "claude");
        assert_eq!(rows[1]["authentication"]["kind"], "unsupported");
        assert_eq!(rows[1]["models"]["kind"], "unsupported");
        assert!(
            listener.accept().now_or_never().is_none(),
            "discovery must never send a user prompt"
        );
        let cwd = f.owner.external_cwd().await.unwrap().unwrap();
        assert!(
            f.owner
                .executors
                .external_query(
                    cwd.clone(),
                    json!({"kind":"catalog","runtime":"antigravity"}),
                    CancellationToken::new()
                )
                .await
                .is_err()
        );
        assert!(
            f.owner
                .executors
                .external_query(
                    cwd,
                    json!({"kind":"setup","runtime":"codex","action":"install"}),
                    CancellationToken::new()
                )
                .await
                .is_err()
        );
        assert!(
            f.owner
                .executors
                .select(executor::Selection {
                    executor: "oar".into(),
                    settings: Default::default()
                })
                .is_err(),
            "queued legacy executor identity must never become external"
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "Requires MAKA_NATIVE_REAL_RUNTIME and an authenticated native CLI; optional MAKA_NATIVE_REAL_COMMAND JSON launch override"]
async fn native_external_real_runtime_host_tool_and_exact_resume() {
    use maka_agent_api::executor::{
        ExternalConfiguration, NativeCommand, NativeCommands, NativeRuntime, NativeRuntimeSwitches,
    };
    tokio::time::timeout(Duration::from_secs(240),async {
        let runtime=std::env::var("MAKA_NATIVE_REAL_RUNTIME").expect("Select antigravity, codex or claude").parse::<NativeRuntime>().unwrap();
        let command=std::env::var("MAKA_NATIVE_REAL_COMMAND").ok().map(|json| serde_json::from_str::<NativeCommand>(&json).expect("NativeCommand JSON"));
        let tooling=service_tools::Setup::javascript().with_host_tools(vec![super::external_support::host_tool("observe","SessionRead")]);
        let f=Fixture::configured("http://127.0.0.1:9/v1",None,None,Some(tooling),|settings| {
            let mut runtimes=NativeRuntimeSwitches::default();let mut commands=NativeCommands::default();
            match runtime { NativeRuntime::Antigravity=>{runtimes.antigravity=true;commands.antigravity=command},NativeRuntime::Codex=>{runtimes.codex=true;commands.codex=command},NativeRuntime::Claude=>{runtimes.claude=true;commands.claude=command} }
            settings.external=Some(ExternalConfiguration{enabled:true,runtimes,commands});
            if let Ok(cwd)=std::env::var("MAKA_NATIVE_REAL_CWD") { settings.workspace_roots[0].path=cwd.into(); }
        }).await;
        let mut create=f.create_input("Real native Host execution").await;
        create["tools"]=json!(["SessionRead"]);
        let created=f.mutation(2,"create",create,Uuid::new_v4()).await.unwrap();
        let session=created["session"]["id"].as_str().unwrap();
        let images=std::env::var("MAKA_NATIVE_REAL_IMAGES").ok().map(|v|serde_json::from_str::<Vec<String>>(&v).expect("image path list")).unwrap_or_default();
        let marker=if images.is_empty() {format!("NATIVE-{}",Uuid::new_v4())}
            else {std::env::var("MAKA_NATIVE_REAL_IMAGE_ANSWER").expect("expected visible image answer")};
        let mut attachment_ids=Vec::new();
        for (index,path) in images.iter().enumerate() {
            let bytes=tokio::fs::read(path).await.unwrap();
            let uploaded=super::super::attachments::upload(&f,session,&format!("image-{index}.png"),&bytes,Uuid::new_v4()).await.unwrap();
            attachment_ids.push(uploaded["attachment"]["id"].clone());
        }
        let mut original=None;
        let mut settings=json!({"runtime":runtime.as_str()});
        if let Ok(model)=std::env::var("MAKA_NATIVE_REAL_MODEL") {settings["model"]=model.into();}
        if let Ok(effort)=std::env::var("MAKA_NATIVE_REAL_EFFORT") {settings["thinkingLevel"]=effort.into();}
        let messages=if images.is_empty() {
            [format!("Use the Maka SessionRead MCP tool exactly once with sessionId {session}. Remember verification marker {marker} for our next turn. After the tool returns, reply with exactly that marker. Do not use other tools."),
             format!("Use the Maka SessionRead MCP tool exactly once with sessionId {session} again. Then recall the verification marker from our previous turn and reply with exactly that marker. Do not use other tools.")]
        } else {
            [format!("Use the Maka SessionRead MCP tool exactly once with sessionId {session}. Inspect all attached images in attachment order. Reply with only their visible four-digit numbers separated by a single space. Remember that answer for the next turn. Do not use other tools."),
             format!("Use the Maka SessionRead MCP tool exactly once with sessionId {session} again. Recall the numbers visible in our previous turn's images, in the same image order. Reply with only those numbers separated by a single space. Do not use other tools.")]
        };
        for (turn,message) in messages.into_iter().enumerate() {
            let mut input=json!({"sessionId":session,"message":message,"backend":{"kind":"executor","selection":{"executor":"external","settings":settings}}});
            if turn==0 && !attachment_ids.is_empty() {input["attachments"]=json!(attachment_ids);}
            let accepted=f.mutation(2,"send",input,Uuid::new_v4()).await.unwrap();
            assert_eq!(accepted["kind"],"started");f.drained().await;
            let observed=work(&f,session,&accepted).await;
            if observed["execution"]["state"]!="completed" {
                let causes:Vec<_>=f.prefix(session,256,1024*1024).await.events.iter().filter_map(|row|match &row.event.fact {maka_agent_facts::event::Fact::InvocationEnded{outcome:maka_agent_facts::event::InvocationOutcome::Failed{message,..}}=>message.clone(),_=>None}).collect();
                panic!("native runtime failed: {causes:?}");
            }
            assert_eq!(observed["answer"]["text"].as_str().unwrap().trim(),marker);
            let journal=super::external_support::record_runtime(&f,session,runtime.as_str()).await;
            let current=journal["nativeSession"].as_str().unwrap().to_owned();
            if let Some(original)=&original {assert_eq!(original,&current);}else{original=Some(current);}
            let events=f.prefix(session,256,1024*1024).await.events;
            let dispatched:Vec<_>=events.iter().filter_map(|row|match &row.event.fact {
                maka_agent_facts::event::Fact::ToolDispatched{operation_id,name,call,..} if name=="SessionRead" && matches!(&call.origin,maka_agent_facts::tool_call::ToolOrigin::HostSdk{entry_id,..} if entry_id=="external")=>Some(operation_id),
                _=>None,
            }).collect();
            assert_eq!(dispatched.len(),turn+1,"each native invocation must use its fresh Host bridge");
            for operation in dispatched {assert!(events.iter().any(|row|matches!(&row.event.fact,maka_agent_facts::event::Fact::ToolSettled{operation_id,outcome:maka_agent_facts::event::ToolOutcome::Succeeded{..}} if operation_id==operation)));}
        }
        f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_external_codex_preserves_more_than_128_preack_deltas() {
    use super::external_support::configured;
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = configured("http://127.0.0.1:9/v1", |settings| {
            settings
                .external
                .as_mut()
                .unwrap()
                .commands
                .codex
                .as_mut()
                .unwrap()
                .env
                .insert("MAKA_NATIVE_FIXTURE_EARLY_EVENTS".into(), "1".into());
        })
        .await;
        let session = f.create("Native early events").await;
        let accepted = f
            .mutation(
                2,
                "send",
                input(&session, "early event burst"),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control, "opened").await;
        release(&mut control).await;
        packet(&mut control, "output").await;
        release(&mut control).await;
        packet(&mut control, "terminal").await;
        release(&mut control).await;
        f.drained().await;
        let result = work(&f, &session, &accepted).await;
        assert_eq!(result["execution"]["state"], "completed");
        assert_eq!(
            result["answer"]["text"],
            format!(
                "{}committed output",
                (0..257).map(|i| format!("{i},")).collect::<String>()
            )
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
