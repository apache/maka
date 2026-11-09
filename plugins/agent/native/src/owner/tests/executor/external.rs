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

use super::external_support::{
    configured, input, input_runtime, native_task, packet, release, setup,
};
use super::*;
use futures_util::FutureExt;
use tokio::io::{AsyncBufReadExt, BufReader};

#[tokio::test]
async fn native_external_workspace_write_blocks_before_task_and_survives_reopen() {
    use maka_agent_facts::durable::{AuthorityStage, BlockerKind, UnixMillis};
    tokio::time::timeout(Duration::from_secs(30), async {
        let (mut f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("Native full access prerequisite").await;
        assert_eq!(
            f.owner.session(&session).await.unwrap().configuration.permissions.access,
            WorkspaceAccess::WorkspaceWrite
        );
        let mut changes = f.owner.durable.subscribe().unwrap();
        let accepted = f.mutation(2, "send", input(&session, "must not submit"), Uuid::new_v4()).await.unwrap();
        assert_eq!(accepted["kind"], "queued");
        let run = f.delivered_run(&accepted).await;
        loop {
            changes.borrow_and_update();
            let view = f.owner.durable.frontier(run).await.unwrap();
            assert!(view.terminal.is_none(), "missing current authority is not a terminal failure");
            if !view.blockers.is_empty() { break; }
            changes.changed().await.unwrap();
        }
        f.drained().await;
        let original: Vec<_> = f.recorded_facts(&session).await.into_iter()
            .filter(|recorded| recorded.run == run && matches!(&recorded.fact, Fact::Blocked { .. }))
            .collect();
        assert_eq!(original.len(), 1, "one canonical authority blocker");
        assert!(matches!(&original[0].fact,
            Fact::Blocked { reason: BlockerKind::CurrentAuthorityUnavailable { stage: AuthorityStage::BackendScope, .. }, .. }
        ));
        for reopened in [false, true] {
            if reopened { super::super::todo_tests::reopen(&mut f).await; }
            assert_eq!(f.delivered_run(&accepted).await, run);
            let observed = f.query("work", json!({"sessionId":session,"target":{"kind":"message","messageId":accepted["messageId"]}})).await.unwrap();
            assert_eq!(observed["kind"], "delivered");
            assert_eq!(observed["shared"], false);
            assert_eq!(observed["execution"]["runId"], json!(run));
            assert_eq!(observed["execution"]["state"]["kind"], "blocked");
            let view = f.owner.durable.frontier(run).await.unwrap();
            assert!(view.external.is_none(), "the rejected fresh preparation owns no task");
            assert!(view.terminal.is_none());
            let facts = f.recorded_facts(&session).await;
            assert!(!facts.iter().any(|recorded| recorded.run == run && matches!(&recorded.fact,
                Fact::ExternalTaskPrepared { .. } | Fact::ExternalTaskAdmitted { .. }
            )));
            assert_eq!(facts.into_iter().filter(|recorded| recorded.run == run && matches!(&recorded.fact, Fact::Blocked { .. })).collect::<Vec<_>>(), original);
            assert!(f.owner.durable.ready_runs(f.owner.run_owner(), UnixMillis(now() as i64), None, 64).await.unwrap().is_empty(), "a blocked Run is not fresh work");
            assert!(listener.accept().now_or_never().is_none(), "no native CLI receives this message");
        }
        assert_eq!(f.mutation(2, "stop", json!({"sessionId":session,"runId":run}), Uuid::new_v4()).await.unwrap()["requested"], true);
        loop {
            changes.borrow_and_update();
            let view = f.owner.durable.frontier(run).await.unwrap();
            if let Some(terminal) = view.terminal {
                assert_eq!(terminal, Terminal::Cancelled);
                assert!(view.external.is_none(), "Stop drains canonical state without a task");
                break;
            }
            changes.changed().await.unwrap();
        }
        assert!(listener.accept().now_or_never().is_none());
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_external_all_protocols_persist_original_task_and_start_private_successors() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let (f, listener) = configured("http://127.0.0.1:9/v1", |settings| {
            settings.tools = vec![super::external_support::host_tool("observe", "SessionRead")];
            let home = settings.workspace_roots[0].path.clone();
            std::fs::create_dir(home.join(".maka")).unwrap();
            std::fs::write(home.join(".maka/AGENTS.md"), "CAPTURED EXTERNAL GUIDANCE 中文").unwrap();
            for name in ["CLAUDE.md", "GEMINI.md"] {
                std::fs::write(home.join(".maka").join(name), "CLI GLOBAL RULES").unwrap();
            }
            settings.assistant = Some(crate::contract::AssistantConfiguration { home: Some(home.to_str().unwrap().into()) });
            settings.external.as_mut().unwrap().commands.antigravity.as_mut().unwrap().env.insert("MAKA_NATIVE_FIXTURE_BOOTSTRAP_TOOL".into(), "1".into());
        }).await;
        for runtime in ["codex", "antigravity", "claude"] {
            let session = f.create(&format!("Native {runtime}")).await;
            super::super::files::change(&f, &session, "danger_full_access", false, false).await;
            let mut original = None;
            let mut original_mcp = None;
            let mut original_tools = None;
            let mut original_operation = None;
            for round in 0..4 {
                let guidance = if round < 2 { "CAPTURED EXTERNAL GUIDANCE 中文" } else { "UPDATED EXTERNAL GUIDANCE 中文" };
                std::fs::write(f.workspace.join(".maka/AGENTS.md"), guidance).unwrap();
                for name in ["AGENTS.md", "CLAUDE.md", "GEMINI.md"] {
                    std::fs::write(f.workspace.join(name), format!("CLI PROJECT RULES {round}")).unwrap();
                }
                let operation = Uuid::new_v4();
                let input = input_runtime(&session, runtime, "complete");
                let accepted = f.mutation(2,"send",input.clone(),operation).await.unwrap();
                assert_eq!(accepted["kind"],"queued","{accepted}");
                assert_eq!(accepted["sessionId"],session);
                let actual_run=f.delivered_run(&accepted).await;
                let mut changes=f.owner.durable.subscribe().unwrap();
                let socket = loop {
                    changes.borrow_and_update();
                    let observed=f.query("work",json!({"sessionId":session,"target":{"kind":"message","messageId":accepted["messageId"]}})).await.unwrap();
                    assert_eq!(observed["kind"],"delivered");
                    assert_eq!(observed["shared"],false);
                    assert_eq!(observed["execution"]["runId"],json!(actual_run));
                    match observed["execution"]["state"]["kind"].as_str() {
                        Some("admitted" | "running" | "waiting")=>{},
                        Some("completed" | "failed" | "cancelled" | "blocked")=>{
                            let facts = f.recorded_facts(&session).await;
                            let outcomes: Vec<_> = facts.iter().filter(|row|row.run==actual_run).filter_map(|row| match &row.fact {
                                maka_agent_facts::durable::Fact::RunTerminated { .. } | maka_agent_facts::durable::Fact::ExternalTaskClosed { .. } | maka_agent_facts::durable::Fact::Blocked { .. } => Some(&row.fact),
                                _ => None,
                            }).collect();
                            panic!("native ended before fixture prompt: runtime={runtime} round={round} run={actual_run} state={} outcomes={outcomes:?}",observed["execution"]["state"])
                        },
                        unexpected=>panic!("unexpected native state before prompt: runtime={runtime} round={round} run={actual_run} kind={unexpected:?}"),
                    }
                    tokio::select! {
                        socket = listener.accept() => break socket.unwrap().0,
                        changed = changes.changed() => changed.unwrap(),
                    }
                };
                let mut control = BufReader::new(socket);
                let opened = packet(&mut control,"opened").await;
                let names: Vec<_> = opened["request"]["tools"].as_array().unwrap().iter().map(|tool| tool["name"].as_str().unwrap()).collect();
                assert_eq!(names, ["SessionRead"]);
                {
                    let instructions = opened["request"]["instructions"].as_str().unwrap();
                    if runtime=="claude" {let captured=super::external_support::native_task(&f,&session).await;assert_eq!(Some(instructions),captured.request.instructions.as_deref(),"pipe --append-system-prompt must receive the exact captured instructions");} else {assert!(instructions.starts_with("<maka_system_instructions>\n"));assert!(instructions.ends_with("\n</maka_system_instructions>"));}
                    assert!(instructions.contains("You are [Maka](https://github.com/apache/maka), an AI agent."));
                    assert!(instructions.contains(&format!("<global_instruction>\n{guidance}\n</global_instruction>")));
                    assert!(!instructions.contains("CLI GLOBAL RULES"));
                    assert!(!instructions.contains("CLI PROJECT RULES"));
                    assert!(!instructions.contains("<workspace-instructions"));
                    if runtime!="claude" {assert!(instructions.contains("replace all earlier Maka instruction blocks"));}
                    if round == 2 {
                        assert!(!instructions.contains("CAPTURED EXTERNAL GUIDANCE"));
                    }
                    if runtime == "antigravity" {
                        assert!(instructions.contains("Acknowledge readiness only"));
                        assert!(instructions.contains("Wait for the next user message"));
                    }
                }
                if round == 0 {
                    original_mcp = Some(opened["request"]["mcp"].clone());
                    original_tools = Some(opened["request"]["tools"].clone());
                } else {
                    assert_eq!(opened["request"]["mcp"]["url"], original_mcp.as_ref().unwrap()["url"], "Root endpoint stays stable while per-task credentials rotate");
                    if opened["request"]["mcp"].get("configPath").is_some() {assert_ne!(opened["request"]["mcp"]["configPath"], original_mcp.as_ref().unwrap()["configPath"], "private inputs must belong to this original Task");}
                    assert_eq!(Some(&opened["request"]["tools"]), original_tools.as_ref(), "native model tool definitions must stay stable");
                }
                assert!(opened["request"]["message"].as_str().unwrap().ends_with("complete"), "canonical history file reference must retain the current message verbatim");
                let journal = super::external_support::native_task(&f,&session).await;
                assert_eq!(journal.execution.run_id,actual_run);
                assert_eq!(journal.execution.session_id,session);
                assert!(journal.state.admitted,"canonical Task admission must precede native input");
                let original_task=journal.state.task;
                loop {
                    changes.borrow_and_update();
                    let view=f.owner.durable.frontier(actual_run).await.unwrap();
                    let task=view.external.as_ref().expect("original admitted native Task");
                    assert_eq!(task.task,original_task);
                    assert!(task.admitted,"original native Task remains admitted");
                    if task.binding.is_some() {break;}
                    assert!(view.terminal.is_none() && task.closed.is_none(),"original native Task ended before its canonical binding ACK");
                    changes.changed().await.unwrap();
                }
                let journal=super::external_support::native_task(&f,&session).await;
                assert_eq!(journal.execution.run_id,actual_run);
                assert_eq!(journal.execution.session_id,session);
                assert_eq!(journal.state.task,original_task);
                let binding=journal.binding.as_ref().expect("original native ACK");
                let current=binding.resource.resource_ref.clone();
                if let Some(original)=&original {assert_ne!(original,&current,"successor must use a different actual private namespace");} else {original=Some(current);}
                assert!(opened["request"].get("resume").is_none());
                let plan = json!({"calls":[{"callId":1,"name":"SessionRead","input":{"sessionId":session}}]});
                control.get_mut().write_all(format!("{plan}\n").as_bytes()).await.unwrap();
                packet(&mut control, "responsive").await;
                let reply = packet(&mut control, "tool_result").await;
                let result: Value = serde_json::from_str(reply["reply"]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
                assert_eq!(result["session"]["id"], session,
                    "SessionRead projection metadata: keys={:?}, kind={:?}, error_shape={:?}, mcp_is_error={:?}, message_prefix={:?}, observation_nonnull={}",
                    result.as_object().map(|object| object.keys().collect::<Vec<_>>()),
                    result.get("kind").and_then(Value::as_str),
                    result.get("error").map(|error| match error {
                        Value::Null => "null",
                        Value::Bool(_) => "boolean",
                        Value::Number(_) => "number",
                        Value::String(_) => "string (content omitted)",
                        Value::Array(_) => "array (content omitted)",
                        Value::Object(_) => "object (content omitted)",
                    }),
                    reply["reply"]["result"].get("isError").and_then(Value::as_bool),
                    result.get("message").and_then(Value::as_str).map(|message| message.chars().take(256).collect::<String>()),
                    result.get("observation").is_some_and(|observation| !observation.is_null())
                );
                packet(&mut control,"output").await;
                release(&mut control).await;
                packet(&mut control,"terminal").await;
                assert!(super::external_support::native_task(&f,&session).await.state.closed.is_none(),"pre-result output cannot close the original Task");
                release(&mut control).await;
                let final_work=loop {
                    changes.borrow_and_update();
                    let observed=f.query("work",json!({"sessionId":session,"target":{"kind":"message","messageId":accepted["messageId"]}})).await.unwrap();
                    assert_eq!(observed["kind"],"delivered");
                    assert_eq!(observed["shared"],false);
                    assert_eq!(observed["execution"]["runId"],json!(actual_run));
                    match observed["execution"]["state"]["kind"].as_str() {
                        Some("completed" | "failed" | "cancelled" | "blocked")=>break observed,
                        Some("admitted" | "running" | "waiting")=>changes.changed().await.unwrap(),
                        unexpected=>panic!("unexpected native settlement state: runtime={runtime} round={round} run={actual_run} kind={unexpected:?}"),
                    }
                };
                assert_eq!(final_work["execution"]["state"]["kind"],"completed","{runtime}: {final_work}");
                f.drained().await;
                let journal=loop {
                    changes.borrow_and_update();
                    let journal=super::external_support::native_task(&f,&session).await;
                    assert_eq!(journal.execution.run_id,actual_run);
                    assert_eq!(journal.execution.session_id,session);
                    assert_eq!(journal.state.task,original_task);
                    match &journal.state.cleanup {
                        maka_plugin_core::operation::OperationCleanup::Confirmed=>break journal,
                        maka_plugin_core::operation::OperationCleanup::Failed { .. }=>panic!("original native Task cleanup failed: runtime={runtime} round={round} run={actual_run} task={original_task}"),
                        maka_plugin_core::operation::OperationCleanup::Unconfirmed=>changes.changed().await.unwrap(),
                    }
                };
                assert_eq!(journal.execution.run_id,actual_run);
                assert_eq!(journal.execution.session_id,session);
                let closed=journal.state.closed.as_ref().expect("original native Task closure");
                assert_eq!(closed.outcome,maka_agent_facts::durable::Terminal::Completed);
                assert_eq!(journal.state.cleanup,maka_plugin_core::operation::OperationCleanup::Confirmed);
                let final_id=&closed.final_message.as_ref().expect("original native final message").message_id;
                let answer:String=f.recorded_facts(&session).await.iter().filter_map(|row|match &row.fact {
                    maka_agent_facts::durable::Fact::ExternalTaskObserved {task,output:maka_agent_facts::executor::Output::OutputDelta {message_id,text,..},..}
                        if row.run==actual_run && *task==journal.state.task && message_id==final_id=>Some(text.as_str()),
                    _=>None,
                }).collect();
                assert_eq!(answer,"committed output");
                let execution=journal.execution.clone();
                let originals=super::external_support::host_effects(&f,&session).await;
                let originals:Vec<_>=originals.iter().filter(|(descriptor,_)|descriptor.execution==execution&&descriptor.name=="SessionRead").collect();
                let dispatched:Vec<_>=originals.iter().map(|(descriptor,_)|descriptor.operation_id.clone()).collect();
                assert_eq!(dispatched.len(),1);
                if let Some(previous)=&original_operation { assert_ne!(previous,&dispatched[0],"each original Task owns its Host operation"); } else { original_operation=Some(dispatched[0].clone()); }
                let settled:Vec<_>=originals.iter().filter(|(_,effect)| {
                    if effect.rejected.is_some() { return false; }
                    if let Some(observation)=&effect.observation {
                        matches!(&observation.receipt,maka_plugin_core::operation::Receipt::Recorded { outcome:maka_plugin_core::operation::OperationOutcome::Returned { result:maka_plugin_core::operation::OperationResult::Success { .. } }, .. })
                    } else { effect.reference.is_none() && effect.returned.is_some() }
                }).map(|(descriptor,_)|descriptor.operation_id.clone()).collect();
                assert_eq!(settled,dispatched,"only original canonical Host effect receipts settle the call");
                if runtime == "antigravity" && round == 0 {
                    let facts = f.recorded_facts(&session).await;
                    let observed: Vec<_> = facts.iter().filter(|row| row.run == actual_run).filter_map(|row| {
                        match &row.fact {
                            maka_agent_facts::durable::Fact::ExternalTaskObserved { output, .. } => Some(output),
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

                assert_eq!(f.mutation(2,"send",input,operation).await.unwrap(),accepted);
                assert!(listener.accept().now_or_never().is_none());
            }
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
                assert!(std::path::Path::new(path).exists(), "Root deletion cannot garbage-collect an unproven private tree");
            }
        }
        f.app.shutdown().await.unwrap(); f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_external_eof_exit_zero_malformed_and_unrelated_turn_never_complete_or_replay() {
    tokio::time::timeout(Duration::from_secs(60),async {
        for message in ["crash","exit0","malformed","wrong-turn"] {
            let (f,listener)=setup("http://127.0.0.1:9/v1").await;let session=f.create("Native terminal correlation").await;let operation=Uuid::new_v4();let request=input(&session,message);
            let accepted=f.mutation(2,"send",request.clone(),operation).await.unwrap();let mut control=BufReader::new(listener.accept().await.unwrap().0);let opened=packet(&mut control,"opened").await;release(&mut control).await;packet(&mut control,"output").await;release(&mut control).await;
            if message=="wrong-turn" {packet(&mut control,"terminal").await;release(&mut control).await;}
            f.drained().await;assert_eq!(work(&f,&session,&accepted).await["execution"]["state"],"blocked");
            let original=native_task(&f,&session).await;assert_eq!(serde_json::to_value(original.execution.run_id).unwrap(),accepted["runId"]);assert!(original.state.closed.is_none(),"EOF, malformed output and unrelated terminal are not native business completion");assert_eq!(original.state.cleanup,if message=="malformed" {maka_plugin_core::operation::OperationCleanup::Unconfirmed} else {maka_plugin_core::operation::OperationCleanup::Confirmed},"Root pipe/group settlement is independent of missing native business terminal");
            let view=f.owner.durable.frontier(original.execution.run_id).await.unwrap();assert!(!view.stopped,"protocol failure cannot manufacture Human Stop");assert!(view.terminal.is_none());assert!(!view.blockers.is_empty());
            assert_eq!(f.mutation(2,"send",request,operation).await.unwrap(),accepted,"original admission recovery cannot replay native work");
            let next=f.mutation(2,"send",input(&session,"must-not-replay"),Uuid::new_v4()).await.unwrap();assert_eq!(next["kind"],"queued");f.drained().await;
            let queue=f.owner.durable.queue().read(session.clone()).await.unwrap();assert!(queue.entries.iter().any(|entry|entry.request.message_id==next["messageId"].as_str().unwrap() && matches!(entry.placement,maka_agent_state::queue::Placement::Steering {run,..} if run==original.execution.run_id)),"new input must remain attributed to the blocked original Run without dispatch");
            assert_eq!(native_task(&f,&session).await.state.task,original.state.task);assert!(listener.accept().now_or_never().is_none());
            if message=="malformed" {assert!(tokio::process::Command::new("/bin/kill").args(["-KILL",&opened["pid"].as_u64().unwrap().to_string()]).status().await.unwrap().success(),"test-only cleanup of the exact fixture pid is not canonical Stop or private-tree proof");}
            // Root resources and the unresolved private job have different owners.
            f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
        }
    }).await.unwrap();
}

#[tokio::test]
async fn native_external_stop_never_relabels_cancelled_turn_as_completed() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        for runtime in ["codex", "antigravity", "claude"] {
            let session = f.create("Native cancellation").await;
            super::super::files::change(&f, &session, "danger_full_access", false, false).await;
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
            assert_eq!(accepted["kind"], "queued");
            let actual_run = f.delivered_run(&accepted).await;
            let mut changes = f.owner.durable.subscribe().unwrap();
            let mut physical = f.owner.physical_changes();
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            packet(&mut control, "opened").await;
            release(&mut control).await;
            packet(&mut control, "output").await;
            let original = super::external_support::native_task(&f, &session).await;
            assert_eq!(original.execution.run_id, actual_run);
            let original_task = original.state.task;
            let activation = {
                let runs = f.owner.runs.state().await;
                let control = runs.controls.get(&session).expect("original live control");
                assert_eq!(control.execution.run_id, actual_run);
                control.cancellation.clone()
            };
            f.mutation(
                2,
                "stop",
                json!({"sessionId":session,"runId":actual_run}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
            if runtime == "codex" {
                packet(&mut control, "interrupt_requested").await;
                let task = super::external_support::native_task(&f, &session).await;
                assert_eq!(task.execution.run_id, actual_run);
                assert_eq!(task.state.task, original_task);
                assert!(
                    task.state.closed.is_none(),
                    "an interrupt request cannot manufacture native terminal"
                );
                assert!(!f.owner.runs.state().await.controls.is_empty());
                release(&mut control).await;
            }
            f.drained().await;
            let held_scope = if runtime == "codex" {
                let scopes = f.owner.runs.state().await.retained_cleanup
                    .get(&session).cloned().unwrap_or_default();
                let scope = scopes.first().expect("original cleanup Scope retained").clone();
                let (gate, release_on_failure, work_cancel, observation, pins) = loop {
                    match scope.original_driver_for_test(actual_run) {
                        Ok(driver) => {
                            let crate::owner::driver::NativeBackend::Executor(executor) = &driver.backend else {
                                panic!("original external driver");
                            };
                            let gate = executor.closed_tail.get().expect("source-installed tail gate").clone();
                            let release_on_failure = gate.release.clone().drop_guard();
                            let pins = f.owner.store.observe_work_settlement(
                                driver.access.custody().as_ref(), &session,
                            );
                            break (gate, release_on_failure, executor.cancellation.clone(), executor.root_observation.clone(), pins);
                        }
                        Err("busy") => tokio::task::yield_now().await,
                        Err(error) => panic!("original cleanup driver unavailable: {error}"),
                    }
                };
                gate.entered.cancelled().await;
                let pins = pins.unwrap();
                let paused = f.owner.durable.frontier(actual_run).await.unwrap();
                let task = paused.external.as_ref().unwrap();
                assert_eq!(task.task, original_task);
                assert_eq!(task.closed.as_ref().unwrap().outcome, maka_agent_facts::durable::Terminal::Cancelled);
                assert_eq!(task.cleanup, maka_plugin_core::operation::OperationCleanup::Unconfirmed);
                assert!(paused.stopped);
                assert!(work_cancel.is_cancelled());
                assert!(!activation.is_cancelled(), "business Stop does not retire the activation");
                assert!(!observation.is_cancelled(), "Closed still owes its original cleanup tail");
                assert!(matches!(pins.wait().await.unwrap_err().underlying(), maka_event_log::StoreError::CleanupUnconfirmed(_)));
                assert!(f.owner.runs.state().await.retained_cleanup.get(&session)
                    .is_some_and(|scopes| scopes.iter().any(|candidate| Arc::ptr_eq(candidate, &scope))));
                gate.release.cancel();
                drop(release_on_failure);
                Some((scope, pins))
            } else {
                None
            };
            let observed = f.query("work", json!({"sessionId":session,"target":{"kind":"message","messageId":accepted["messageId"]}})).await.unwrap();
            assert_eq!(observed["kind"], "delivered");
            assert_eq!(observed["execution"]["runId"], json!(actual_run));
            assert_eq!(
                observed["execution"]["state"]["kind"], "cancelled",
                "{runtime}: {observed}"
            );
            loop {
                changes.borrow_and_update();
                let settled = f.owner.durable.frontier(actual_run).await.unwrap();
                let task = settled.external.as_ref().unwrap();
                assert_eq!(task.task, original_task);
                let closed = task.closed.as_ref().expect("original native terminal");
                if runtime == "codex" {
                    assert_eq!(closed.outcome, maka_agent_facts::durable::Terminal::Cancelled);
                }
                match &task.cleanup {
                    maka_plugin_core::operation::OperationCleanup::Confirmed => break,
                    maka_plugin_core::operation::OperationCleanup::Unconfirmed => changes.changed().await.unwrap(),
                    maka_plugin_core::operation::OperationCleanup::Failed { .. } => panic!("original {runtime} cleanup failed"),
                }
            }
            if let Some((scope, pins)) = held_scope {
                loop {
                    physical.borrow_and_update();
                    let retained = f.owner.runs.state().await.retained_cleanup.get(&session)
                        .is_some_and(|scopes| scopes.iter().any(|candidate| Arc::ptr_eq(candidate, &scope)));
                    if !retained { break; }
                    physical.changed().await.unwrap();
                }
                pins.wait().await.unwrap();
                assert!(scope.original_driver_for_test(actual_run).is_err());
            }
            let facts = f.recorded_facts(&session).await;
            assert_eq!(facts.iter().filter(|row| row.run == actual_run && matches!(row.fact, maka_agent_facts::durable::Fact::ExternalTaskPrepared { .. })).count(), 1);
            assert_eq!(f.latest_run(&session).await.execution().run_id, actual_run);
            assert!(listener.accept().now_or_never().is_none(), "Stop and late cleanup cannot admit another prompt");
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
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "Explicit MAKA_NATIVE_REAL_MODE=claude-stub with pinned owned artifact inputs, or authenticated manual mode; never implicitly use a login"]
async fn native_external_real_runtime_host_tool_and_private_fresh_context() {
    use maka_agent_api::executor::{
        ExternalConfiguration, NativeCommand, NativeCommands, NativeRuntime, NativeRuntimeSwitches,
    };
    tokio::time::timeout(Duration::from_secs(240),async {
        let mode=std::env::var("MAKA_NATIVE_REAL_MODE").expect("Explicit claude-stub or authenticated mode required");
        assert!(matches!(mode.as_str(),"claude-stub"|"authenticated"),"unknown official native test mode");
        let stub=if mode=="claude-stub" {Some(super::external_support::OfficialClaude::from_env().await)}else{None};
        let runtime=std::env::var("MAKA_NATIVE_REAL_RUNTIME").expect("Select antigravity, codex or claude").parse::<NativeRuntime>().unwrap();
        if stub.is_some() {assert_eq!(runtime,NativeRuntime::Claude);}
        let command=if let Some(stub)=&stub {Some(stub.command.clone())}else{std::env::var("MAKA_NATIVE_REAL_COMMAND").ok().map(|json| serde_json::from_str::<NativeCommand>(&json).expect("NativeCommand JSON"))};
        let tooling=service_tools::Setup::javascript().with_host_tools(vec![super::external_support::host_tool("observe","SessionRead")]);
        let f=Fixture::configured("http://127.0.0.1:9/v1",None,None,Some(tooling),|settings| {
            let mut runtimes=NativeRuntimeSwitches::default();let mut commands=NativeCommands::default();
            match runtime { NativeRuntime::Antigravity=>{runtimes.antigravity=true;commands.antigravity=command},NativeRuntime::Codex=>{runtimes.codex=true;commands.codex=command},NativeRuntime::Claude=>{runtimes.claude=true;commands.claude=command} }
            settings.external=Some(ExternalConfiguration{runtimes,commands});
            if let Some(stub)=&stub {
                settings.permissions.request_permissions=false;
                settings.assistant=Some(crate::contract::AssistantConfiguration{home:Some(stub.command.env["HOME"].clone())});
            }
            if let Ok(cwd)=std::env::var("MAKA_NATIVE_REAL_CWD") { settings.workspace_roots[0].path=cwd.into(); }
        }).await;
        let mut create=f.create_input("Real native Host execution").await;
        create["tools"]=json!(["SessionRead"]);
        let created=f.mutation(2,"create",create,Uuid::new_v4()).await.unwrap();
        let session=created["session"]["id"].as_str().unwrap();
        let request_permissions=f.owner.session(session).await.unwrap().configuration.permissions.request_permissions;
        // Native opt-in cannot widen the actual issuer's restricted floor.
        super::super::files::change(&f,session,"danger_full_access",request_permissions,false).await;
        let stub_floor=if let Some(stub)=&stub {Some(stub.floor(&f,session).await)}else{None};
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
            if let Some(stub)=&stub {stub.begin(session,&marker,turn).await;}
            let mut input=json!({"sessionId":session,"message":message,"backend":{"kind":"executor","selection":{"executor":"external","settings":settings}}});
            if turn==0 && !attachment_ids.is_empty() {input["attachments"]=json!(attachment_ids);}
            let accepted=if let Some(floor)=&stub_floor {
                super::external_support::scoped_send(&f,input,floor).await
            }else{f.mutation(2,"send",input,Uuid::new_v4()).await.unwrap()};
            assert_eq!(accepted["kind"],"queued","official turn {turn} admission");
            assert_eq!(accepted["sessionId"],session,"official turn {turn} admission session");
            let actual_run=f.delivered_run(&accepted).await;
            let mut changes=f.owner.durable.subscribe().unwrap();
            let observed=loop {
                changes.borrow_and_update();
                let observed=f.query("work",json!({"sessionId":session,"target":{"kind":"message","messageId":accepted["messageId"]}})).await.unwrap();
                assert_eq!(observed["kind"],"delivered","official turn {turn} original message");
                assert_eq!(observed["shared"],false,"official turn {turn} must own a fresh Run");
                assert_eq!(observed["execution"]["runId"],json!(actual_run),"official turn {turn} original message Run");
                match observed["execution"]["state"]["kind"].as_str() {
                    Some("completed" | "failed" | "cancelled" | "blocked")=>break observed,
                    Some("admitted" | "running" | "waiting")=>changes.changed().await.unwrap(),
                    unexpected=>panic!("unexpected official execution state kind: turn={turn} run={actual_run} kind={unexpected:?}"),
                }
            };
            if observed["execution"]["state"]["kind"]!="completed" {
                let causes:Vec<_>=f.recorded_facts(session).await.iter().filter_map(|row|match &row.fact {
                    maka_agent_facts::durable::Fact::Blocked{blocker,reason}=>Some(format!("blocked id={blocker} reason={reason:?}")),
                    maka_agent_facts::durable::Fact::RunTerminated{terminal,diagnostic}=>Some(format!("terminal={terminal:?} diagnostic={diagnostic:?}")),
                    _=>None,
                }).collect();
                panic!("native runtime failed: turn={turn} run={actual_run} state={} causes={causes:?}",observed["execution"]["state"]);
            }
            f.drained().await;
            let journal=super::external_support::native_task(&f,session).await;
            assert_eq!(journal.execution.run_id,actual_run,"official turn {turn} native task must belong to the original message Run");
            let final_id=&journal.state.closed.as_ref().expect("official task closure").final_message.as_ref().expect("official final message").message_id;
            let answer:String=f.recorded_facts(session).await.iter().filter_map(|row|match &row.fact {
                maka_agent_facts::durable::Fact::ExternalTaskObserved {task,output:maka_agent_facts::executor::Output::OutputDelta {message_id,text,..},..}
                    if row.run==actual_run && *task==journal.state.task && message_id==final_id=>Some(text.as_str()),
                _=>None,
            }).collect();
            assert_eq!(answer.trim(),marker,"official turn {turn} canonical native final message");
            if let Some(floor)=&stub_floor {
                let view=f.owner.durable.frontier(journal.execution.run_id).await.unwrap();
                assert!(floor.contains(&view.spec.permission_ceiling.sandbox).unwrap(),
                    "the captured Run must not widen the explicit stub/MCP issuer floor");
            }
            let binding=journal.binding.as_ref().expect("real official native ACK");let current=(journal.state.task,binding.resource.resource_ref.clone(),journal.native_address().unwrap().to_owned());
            if let Some((task,resource,address))=&original {assert_ne!(task,&current.0);assert_ne!(resource,&current.1,"a fresh official job must not reopen an old private namespace");assert_ne!(address,&current.2,"a fresh job cannot resume the previous native session");}else{original=Some(current);}
            assert_eq!(journal.state.closed.as_ref().unwrap().outcome,maka_agent_facts::durable::Terminal::Completed,"exact native business result is required");
            assert_eq!(journal.state.cleanup,maka_plugin_core::operation::OperationCleanup::Confirmed,"official Root resources require their original child/group, pipe, bridge and writer acknowledgements");
            let effects=super::external_support::host_effects(&f,session).await;let dispatched:Vec<_>=effects.iter().filter(|(descriptor,_)|descriptor.name=="SessionRead" && matches!(&descriptor.origin,maka_agent_facts::tool_call::ToolOrigin::External {entry_id,..} if entry_id=="external")).collect();
            assert_eq!(dispatched.len(),turn+1,"each official task must use its fresh real Host bridge exactly once");
            let host_receipts:Vec<_>=dispatched.iter().map(|(descriptor,effect)|json!({
                "execution":descriptor.execution,"operationId":descriptor.operation_id,
                "key":descriptor.key,"returned":effect.returned,"cleanup":effect.cleanup
            })).collect();
            for (descriptor,effect) in dispatched {
                assert!(effect.admitted && effect.rejected.is_none());
                let returned=effect.returned.as_ref().expect("official Host call needs an exact canonical return");
                let bytes=f.owner.durable.content(descriptor.execution.run_id,returned.clone()).await.unwrap();
                let maka_agent_facts::external_effects::ExternalReturn::Output {output,is_error:false,..}=serde_json::from_slice::<maka_agent_facts::external_effects::ExternalReturn>(&bytes).unwrap() else {panic!("official Host call did not succeed: {}",descriptor.operation_id)};
                assert_eq!(output.into_code_value().unwrap()["session"]["id"],session);
                if let Some(reply)=&effect.observation {assert!(matches!(&reply.receipt,maka_plugin_core::operation::Receipt::Recorded {outcome:maka_plugin_core::operation::OperationOutcome::Returned {result:maka_plugin_core::operation::OperationResult::Success {..}},cleanup:maka_plugin_core::operation::OperationCleanup::Confirmed}));}
            }
            if let Some(stub)=&stub {stub.observe(&journal,turn,&marker,&host_receipts).await;}
        }
        f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
        if let Some(stub)=stub {stub.finish().await;}
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
        assert_eq!(result["answer"]["text"], "committed output");
        assert_eq!(
            super::external_support::assistant_texts(&f, &session).await,
            [
                (0..257).map(|i| format!("{i},")).collect::<String>(),
                "committed output".into(),
            ]
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
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
async fn native_external_skill_instructions_are_captured_once_for_each_private_task() {
    tokio::time::timeout(Duration::from_secs(120), async {
        let home=tempfile::tempdir().unwrap();let tooling=service_tools::Setup::skill_preparation(home.path().into(),true).with_standard_sources();
        let (f,listener)=super::external_support::with_tools("http://127.0.0.1:9/v1",Some(tooling),|_|{}).await;
        let skill=f.workspace.join(".maka/skills/review");
        for runtime in ["codex","antigravity","claude"] {
            let session=f.create("Current captured skill instructions").await;let mut previous_instructions=None;let mut previous_task=None;
            for round in 0..6 {
                if round==1||round==3 {std::fs::create_dir_all(&skill).unwrap();let version=if round==1 {"VERSION ONE"} else {"VERSION TWO"};std::fs::write(skill.join("SKILL.md"),format!("---\nname: review\ndescription: {version}\nrequired-tools: FindGuide LoadGuide\n---\nReview instructions")).unwrap();}
                else if round==4 {std::fs::remove_dir_all(&skill).unwrap();}
                let accepted=f.mutation(2,"send",input_runtime(&session,runtime,"complete"),Uuid::new_v4()).await.unwrap();assert_eq!(accepted["kind"],"started");
                let mut control=BufReader::new(listener.accept().await.unwrap().0);let opened=packet(&mut control,"opened").await;
                let original=super::external_support::native_task(&f,&session).await;
                let instructions=original.request.instructions.clone().unwrap_or_default();
                match round {0|4|5=>assert!(!instructions.contains("FindGuide")),1|2=>assert!(instructions.contains("VERSION ONE")),3=>{assert!(instructions.contains("VERSION TWO"));assert!(!instructions.contains("VERSION ONE"));},_=>unreachable!()}
                if round==2||round==5 {assert_eq!(Some(&instructions),previous_instructions.as_ref(),"unchanged captured instructions stay identical");}else if round>0 {assert_ne!(Some(&instructions),previous_instructions.as_ref());}
                let delivered=opened["request"]["instructions"].as_str().unwrap_or_default();
                if instructions.contains("VERSION") {assert!(delivered.contains(if round<3 {"VERSION ONE"} else {"VERSION TWO"}));assert!(delivered.contains(&instructions),"each fresh task receives the complete captured instructions, never a prior digest cache");}
                assert!(opened["request"].get("resume").is_none());
                if let Some(previous)=previous_task {assert_ne!(original.state.task,previous,"fresh preparation cannot inherit native instruction confirmation");}
                previous_task=Some(original.state.task);previous_instructions=Some(instructions);
                complete_instruction_turn(&f,&session,&accepted,&mut control).await;
            }
        }
        f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_external_cancelled_input_ack_does_not_mutate_an_earlier_task() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let (f, listener) = configured("http://127.0.0.1:9/v1", |settings| {
            let home = settings.workspace_roots[0].path.clone();
            std::fs::create_dir_all(home.join(".maka")).unwrap();
            std::fs::write(home.join(".maka/AGENTS.md"), "ORIGINAL_GUIDANCE").unwrap();
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
            std::fs::write(f.workspace.join(".maka/AGENTS.md"), "ORIGINAL_GUIDANCE").unwrap();
            let session = f
                .create("Original instruction source acknowledgement")
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
            let before = super::external_support::native_task(&f, &session).await;
            std::fs::write(
                f.workspace.join(".maka/AGENTS.md"),
                "CANCEL_UNCONFIRMED_GUIDANCE",
            )
            .unwrap();
            let stopped = f
                .mutation(
                    2,
                    "send",
                    input_runtime(&session, runtime, "complete"),
                    Uuid::new_v4(),
                )
                .await
                .unwrap();
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            packet(
                &mut control,
                if runtime == "claude" {
                    "before_input_ack"
                } else {
                    "before_instructions_ack"
                },
            )
            .await;
            let captured = super::external_support::native_task(&f, &session).await;
            assert!(
                captured
                    .request
                    .instructions
                    .as_ref()
                    .unwrap()
                    .contains("CANCEL_UNCONFIRMED_GUIDANCE")
            );
            f.mutation(
                2,
                "stop",
                json!({"sessionId":session,"runId":stopped["runId"]}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
            release(&mut control).await;
            f.drained().await;
            let source = f
                .owner
                .durable
                .frontier(captured.execution.run_id)
                .await
                .unwrap();
            assert!(
                source.stopped,
                "only the actual canonical Stop grants native control"
            );
            let unchanged = f
                .owner
                .durable
                .frontier(before.execution.run_id)
                .await
                .unwrap()
                .external
                .unwrap();
            assert_eq!(unchanged.binding, before.state.binding);
            assert_eq!(unchanged.closed, before.state.closed);
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
            packet(
                &mut control,
                if runtime == "claude" {
                    "before_input_ack"
                } else {
                    "before_instructions_ack"
                },
            )
            .await;
            release(&mut control).await;
            let opened = packet(&mut control, "opened").await;
            assert!(
                opened["request"]["instructions"]
                    .as_str()
                    .unwrap()
                    .contains("CANCEL_UNCONFIRMED_GUIDANCE")
            );
            assert!(opened["request"].get("resume").is_none());
            let current = super::external_support::native_task(&f, &session).await;
            assert_ne!(current.state.task, captured.state.task);
            assert_eq!(
                current.request.instructions, captured.request.instructions,
                "unconfirmed earlier ACK cannot advance or suppress current captured instructions"
            );
            complete_instruction_turn(&f, &session, &retry, &mut control).await;
        }
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
