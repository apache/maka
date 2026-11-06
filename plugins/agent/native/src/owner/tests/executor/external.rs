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
use tokio::io::{AsyncBufReadExt, BufReader};

#[tokio::test]
async fn native_external_all_protocols_persist_before_prompt_and_resume_original_identity() {
    let (f, listener) = configured("http://127.0.0.1:9/v1", |settings| {
        settings.tools = vec![super::external_support::host_tool("observe", "SessionRead")];
        let home = settings.workspace_roots[0].path.clone();
        std::fs::write(
            std::path::Path::new(&home).join("AGENTS.md"),
            "CAPTURED EXTERNAL GUIDANCE 中文",
        )
        .unwrap();
        settings.assistant = Some(crate::contract::AssistantConfiguration {
            home: Some(home.to_str().unwrap().into()),
        });
        settings
            .external
            .as_mut()
            .unwrap()
            .commands
            .antigravity
            .as_mut()
            .unwrap()
            .env
            .insert("MAKA_NATIVE_FIXTURE_BOOTSTRAP_TOOL".into(), "1".into());
    })
    .await;
    for runtime in ["codex", "antigravity", "claude"] {
        let session = f.create(&format!("Native {runtime}")).await;
        let mut original = None;
        let mut original_mcp = None;
        let mut original_tools = None;
        let mut original_operation = None;
        for round in 0..4 {
            let guidance = if round < 2 {
                "CAPTURED EXTERNAL GUIDANCE 中文"
            } else {
                "UPDATED EXTERNAL GUIDANCE 中文"
            };
            std::fs::write(f.workspace.join("AGENTS.md"), guidance).unwrap();
            let operation = Uuid::new_v4();
            let input = input_runtime(&session, runtime, "complete");
            tokio::time::timeout(Duration::from_secs(60), async {
                let accepted = f.mutation(2,"send",input.clone(),operation).await.unwrap();
                assert_eq!(accepted["kind"],"started","{accepted}");
                eprintln!("native fixture {runtime}: admitted");
                let socket = tokio::select! {
                    socket = listener.accept() => socket.unwrap().0,
                    () = f.drained() => {
                        let facts = f.prefix(&session, 128, 1024 * 1024).await;
                        let outcomes: Vec<_> = facts.events.iter().filter_map(|row| match &row.event.fact {
                            maka_agent_facts::event::Fact::InvocationEnded { .. } | maka_agent_facts::event::Fact::ExecutorCompleted { .. } => Some(&row.event.fact),
                            _ => None,
                        }).collect();
                        panic!("native ended before fixture prompt: {}; outcomes: {outcomes:?}",work(&f,&session,&accepted).await)
                    },
                };
                let mut control = BufReader::new(socket);
                let opened = packet(&mut control,"opened").await;
                let names: Vec<_> = opened["request"]["tools"].as_array().unwrap().iter().map(|tool| tool["name"].as_str().unwrap()).collect();
                assert_eq!(names, ["SessionRead"]);
                if round == 0 || round == 2 {
                    let instructions = opened["request"]["instructions"].as_str().unwrap();
                    assert!(instructions.starts_with("<maka_system_instructions>\n"));
                    assert!(instructions.ends_with("\n</maka_system_instructions>"));
                    assert!(instructions.contains(guidance));
                    assert!(instructions.contains("replace all earlier Maka instruction blocks"));
                    if round == 2 {
                        assert!(!instructions.contains("CAPTURED EXTERNAL GUIDANCE"));
                    }
                    if runtime != "codex" {
                        assert!(instructions.contains("Acknowledge readiness only"));
                        assert!(instructions.contains("Wait for the next user message"));
                    }
                } else {
                    assert!(opened["request"].get("instructions").is_none(), "unchanged instructions must not add another native turn");
                }
                if round == 0 {
                    original_mcp = Some(opened["request"]["mcp"].clone());
                    original_tools = Some(opened["request"]["tools"].clone());
                } else {
                    assert_eq!(Some(&opened["request"]["mcp"]), original_mcp.as_ref(), "endpoint and native config path must be session-scoped");
                    assert_eq!(Some(&opened["request"]["tools"]), original_tools.as_ref(), "native model tool definitions must stay stable");
                }
                assert_eq!(opened["request"]["message"], "complete", "instructions must be a distinct ordinary native message");
                eprintln!("native fixture {runtime}: opened");
                let journal = super::external_support::record_runtime(&f,&session,runtime).await;
                assert_eq!(journal["running"],accepted["invocationId"],"journal must be durable before native prompt admission");
                let current = journal["nativeSession"].as_str().unwrap().to_owned();
                if let Some(original) = &original { assert_eq!(original,&current); assert_eq!(opened["request"]["resume"],current); }
                else { assert!(opened["request"].get("resume").is_none()); original = Some(current); }
                let plan = json!({"calls":[{"callId":1,"name":"SessionRead","input":{"sessionId":session}}]});
                control.get_mut().write_all(format!("{plan}\n").as_bytes()).await.unwrap();
                packet(&mut control, "responsive").await;
                let reply = packet(&mut control, "tool_result").await;
                let result: Value = serde_json::from_str(reply["reply"]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
                assert_eq!(result["session"]["id"], session);
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
                let events = f.prefix(&session, 128, 1024 * 1024).await.events;
                let dispatched: Vec<_> = events.iter().filter_map(|row| match &row.event.fact {
                    maka_agent_facts::event::Fact::ToolDispatched { operation_id, name, .. }
                        if row.event.invocation.invocation_id == accepted["invocationId"] && name == "SessionRead" => Some(operation_id.clone()),
                    _ => None,
                }).collect();
                assert_eq!(dispatched.len(), 1);
                if let Some(previous) = &original_operation {
                    assert_ne!(previous, &dispatched[0], "each invocation owns its original operation");
                } else {
                    original_operation = Some(dispatched[0].clone());
                }
                let settled: Vec<_> = events.iter().filter_map(|row| match &row.event.fact {
                    maka_agent_facts::event::Fact::ToolSettled { operation_id, outcome: maka_agent_facts::event::ToolOutcome::Succeeded { .. } }
                        if row.event.invocation.invocation_id == accepted["invocationId"] => Some(operation_id.clone()),
                    _ => None,
                }).collect();
                assert_eq!(settled, dispatched, "receipts must settle the original invocation only");
                if runtime == "antigravity" && round == 0 {
                    let facts = f.prefix(&session, 128, 1024 * 1024).await;
                    let observed: Vec<_> = facts.events.iter().filter(|row| row.event.invocation.invocation_id == accepted["invocationId"]).filter_map(|row| {
                        match &row.event.fact {
                            maka_agent_facts::event::Fact::ExecutorObserved { output } => Some(output),
                            _ => None,
                        }
                    }).collect();
                    let global: Vec<_> = observed.iter().filter_map(|output| match output {
                        maka_agent_facts::executor::Output::ToolStart {tool_call_id,name,input} if name == "call_mcp_tool" => {
                            assert_eq!(input["ServerName"], "maka", "only the private maka_maka wrapper is suppressed");
                            Some(tool_call_id)
                        }
                        _ => None,
                    }).collect();
                    assert_eq!(global.len(), 1);
                    assert!(observed.iter().any(|output| matches!(output,
                        maka_agent_facts::executor::Output::ToolResult {tool_call_id,is_error:true,..} if tool_call_id == global[0]
                    )), "DONE plus tool_info.error is still a failed native tool");
                    let starts: Vec<_> = observed.iter().filter_map(|output| match output {
                        maka_agent_facts::executor::Output::ToolStart { tool_call_id, name, .. } if name == "bootstrap-native" => Some(tool_call_id),
                        _ => None
                    }).collect();
                    assert_eq!(starts.len(), 1, "bootstrap native tools must remain observable");
                    assert!(observed.iter().any(|output| matches!(output,
                        maka_agent_facts::executor::Output::ToolResult { tool_call_id, is_error: false, .. }
                        if tool_call_id == starts[0]
                    )));
                }

                assert!(super::external_support::record_runtime(&f,&session,runtime).await["running"].is_null());
                assert_eq!(f.mutation(2,"send",input,operation).await.unwrap(),accepted);
                f.drained().await;
                assert!(listener.accept().now_or_never().is_none());
                }).await.unwrap_or_else(|_| panic!("native {runtime} round {round} must persist, execute and settle without replay"));
        }
        tokio::time::timeout(Duration::from_secs(60), async {
            let mcp = original_mcp.unwrap();
            let url = mcp["url"].as_str().unwrap();
            let address = url.strip_prefix("http://").unwrap().strip_suffix("/mcp").unwrap();
            let mut socket = TcpStream::connect(address).await.unwrap();
            socket.write_all(b"POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            let mut status = String::new();
            BufReader::new(socket).read_line(&mut status).await.unwrap();
            assert_eq!(status, "HTTP/1.1 401 Unauthorized\r\n",
                "idle conversation keeps its listener without granting authority");
            let observation = f.query("observe", json!({"sessionId":session})).await.unwrap();
            let removed = f.mutation(2, "changeSession", json!({"sessionId":session,"expectedRevision":observation["session"]["revision"],"action":"remove"}), Uuid::new_v4()).await.unwrap();
            assert_eq!(removed["kind"], "removed", "{removed}");
            f.drained().await;
            assert!(TcpStream::connect(address).await.is_err(), "deleted session must release its listener");
            if let Some(path) = mcp.get("configPath").and_then(Value::as_str) {
                assert!(!std::path::Path::new(path).exists(), "deleted session must release native MCP configuration");
            }
            }).await.unwrap_or_else(|_| panic!("native {runtime} session removal must release its listener and configuration"));
    }
    f.app.shutdown().await.unwrap();
    f.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn native_external_eof_exit_zero_malformed_and_unrelated_turn_never_complete_or_replay() {
    for message in ["crash", "exit0", "malformed", "wrong-turn"] {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("Native terminal correlation").await;
        let operation = Uuid::new_v4();
        let request = input(&session, message);
        tokio::time::timeout(Duration::from_secs(60), async {
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
        })
        .await
        .unwrap_or_else(|_| {
            panic!("native {message} must fail without replay or false cleanup confirmation")
        });
        f.config.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn native_external_stop_never_relabels_cancelled_turn_as_completed() {
    let (f, listener) = setup("http://127.0.0.1:9/v1").await;
    for runtime in ["codex", "antigravity", "claude"] {
        let session = f.create("Native cancellation").await;
        tokio::time::timeout(Duration::from_secs(60), async {
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
        })
        .await
        .unwrap_or_else(|_| {
            panic!("native {runtime} cancellation must settle without completing the turn")
        });
    }
    f.app.shutdown().await.unwrap();
    f.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn native_external_discovery_keeps_native_models_and_reports_unsupported_claude_capabilities()
{
    let (f, listener) = configured("http://127.0.0.1:9/v1", |settings| {
        settings.external.as_mut().unwrap().runtimes.antigravity = false;
    })
    .await;
    tokio::time::timeout(Duration::from_secs(40), async {
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
    })
    .await
    .expect("native discovery must preserve models and report unsupported capabilities");
    f.app.shutdown().await.unwrap();
    f.config.shutdown().await.unwrap();
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
            settings.external=Some(ExternalConfiguration{runtimes,commands});
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
    tokio::time::timeout(Duration::from_secs(40), async {
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
        assert_eq!(result["answer"]["text"], "committed output");
        assert_eq!(
            super::external_support::assistant_texts(&f, &session).await,
            [
                (0..257).map(|i| format!("{i},")).collect::<String>(),
                "committed output".into(),
            ]
        );
    })
    .await
    .expect("native Codex must preserve every preack delta through completion");
    f.app.shutdown().await.unwrap();
    f.config.shutdown().await.unwrap();
}

async fn complete_instruction_turn(
    f: &Fixture,
    session: &str,
    accepted: &Value,
    control: &mut BufReader<TcpStream>,
) {
    release(control).await;
    packet(control, "output").await;
    release(control).await;
    packet(control, "terminal").await;
    release(control).await;
    f.drained().await;
    assert_eq!(
        work(f, session, accepted).await["execution"]["state"],
        "completed"
    );
}

#[tokio::test]
async fn native_external_skill_instructions_arrive_after_none_and_clear_without_repeating() {
    tokio::time::timeout(Duration::from_secs(120), async {
        let home = tempfile::tempdir().unwrap();
        let tooling = service_tools::Setup::skill_preparation(home.path().into(), true).with_standard_sources();
        let (f, listener) = super::external_support::with_tools("http://127.0.0.1:9/v1", Some(tooling), |_| {}).await;
        let skill = f.workspace.join(".maka/skills/review");
        for runtime in ["codex", "antigravity", "claude"] {
            let session = f.create("Changing native skill metadata").await;
            let mut original = None;
            let mut previous_digest = Value::Null;
            for round in 0..6 {
                if round == 1 || round == 3 {
                    std::fs::create_dir_all(&skill).unwrap();
                    let version = if round == 1 { "VERSION ONE" } else { "VERSION TWO" };
                    std::fs::write(skill.join("SKILL.md"), format!("---\nname: review\ndescription: {version}\nrequired-tools: FindGuide LoadGuide\n---\nReview instructions")).unwrap();
                } else if round == 4 {
                    std::fs::remove_dir_all(&skill).unwrap();
                }
                let accepted = f.mutation(2, "send", input_runtime(&session, runtime, "complete"), Uuid::new_v4()).await.unwrap();
                assert_eq!(accepted["kind"], "started");
                let mut control = BufReader::new(listener.accept().await.unwrap().0);
                let opened = packet(&mut control, "opened").await;
                let instructions = opened["request"]["instructions"].as_str();
                match round {
                    0 if runtime == "antigravity" => assert!(!instructions.unwrap().contains("FindGuide")),
                    0 | 2 | 5 => assert!(instructions.is_none(), "unchanged instructions must not be resubmitted"),
                    1 | 3 => {
                        let instructions = instructions.unwrap();
                        let version = if round == 1 { "VERSION ONE" } else { "VERSION TWO" };
                        assert!(instructions.contains(version));
                        assert!(instructions.contains("replace all earlier Maka instruction blocks"));
                        if round == 3 { assert!(!instructions.contains("VERSION ONE")); }
                    }
                    4 => assert!(instructions.unwrap().contains("previous Maka instruction blocks are now cleared")),
                    _ => unreachable!(),
                }
                assert_eq!(opened["request"]["message"], "complete");
                let record = super::external_support::record_runtime(&f, &session, runtime).await;
                if let Some(original) = &original { assert_eq!(&record["nativeSession"], original); }
                else { original = Some(record["nativeSession"].clone()); }
                if round == 2 || round == 5 { assert_eq!(record["instructionsDigest"], previous_digest); }
                else if round > 0 { assert_ne!(record["instructionsDigest"], previous_digest); }
                previous_digest = record["instructionsDigest"].clone();
                complete_instruction_turn(&f, &session, &accepted, &mut control).await;
            }
        }
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_external_cancelled_instruction_ack_does_not_advance_confirmed_digest() {
    let (f, listener) = configured("http://127.0.0.1:9/v1", |settings| {
        let home = settings.workspace_roots[0].path.clone();
        settings.assistant = Some(crate::contract::AssistantConfiguration {
            home: Some(home.to_str().unwrap().into()),
        });
        let commands = &mut settings.external.as_mut().unwrap().commands;
        for command in [
            &mut commands.codex,
            &mut commands.antigravity,
            &mut commands.claude,
        ] {
            command
                .as_mut()
                .unwrap()
                .env
                .insert("MAKA_NATIVE_FIXTURE_PAUSE_INSTRUCTIONS".into(), "1".into());
        }
    })
    .await;
    for runtime in ["codex", "antigravity", "claude"] {
        std::fs::write(f.workspace.join("AGENTS.md"), "CONFIRMED GUIDANCE").unwrap();
        let session = f
            .create("Native instruction acknowledgement cancellation")
            .await;
        let first = f
            .mutation(
                2,
                "send",
                input_runtime(&session, runtime, "complete"),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control, "opened").await;
        complete_instruction_turn(&f, &session, &first, &mut control).await;
        let before = super::external_support::record_runtime(&f, &session, runtime).await;
        std::fs::write(f.workspace.join("AGENTS.md"), "CANCEL_UNCONFIRMED_GUIDANCE").unwrap();
        tokio::time::timeout(Duration::from_secs(90), async {
            let cancelled = f
                .mutation(
                    2,
                    "send",
                    input_runtime(&session, runtime, "must-not-be-submitted"),
                    Uuid::new_v4(),
                )
                .await
                .unwrap();
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            packet(&mut control, "before_instructions_ack").await;
            f.mutation(
                2,
                "stop",
                json!({"sessionId":session,"invocationId":cancelled["invocationId"]}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
            f.drained().await;
            assert_eq!(
                work(&f, &session, &cancelled).await["execution"]["state"],
                "cancelled"
            );
            let after = super::external_support::record_runtime(&f, &session, runtime).await;
            assert_eq!(after["instructionsDigest"], before["instructionsDigest"]);
            assert_eq!(after["nativeSession"], before["nativeSession"]);
            assert!(after["running"].is_null());
            let retry = f
                .mutation(
                    2,
                    "send",
                    input_runtime(&session, runtime, "complete"),
                    Uuid::new_v4(),
                )
                .await
                .unwrap();
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            packet(&mut control, "before_instructions_ack").await;
            release(&mut control).await;
            let opened = packet(&mut control, "opened").await;
            assert!(
                opened["request"]["instructions"]
                    .as_str()
                    .unwrap()
                    .contains("CANCEL_UNCONFIRMED_GUIDANCE")
            );
            complete_instruction_turn(&f, &session, &retry, &mut control).await;
            let confirmed = super::external_support::record_runtime(&f, &session, runtime).await;
            assert_ne!(
                confirmed["instructionsDigest"],
                before["instructionsDigest"]
            );
            assert_eq!(confirmed["nativeSession"], before["nativeSession"]);
            })
            .await
            .unwrap_or_else(|_| panic!("native {runtime} instruction cancellation and retry must preserve confirmed identity and digest"));
    }
    f.app.shutdown().await.unwrap();
    f.config.shutdown().await.unwrap();
}
