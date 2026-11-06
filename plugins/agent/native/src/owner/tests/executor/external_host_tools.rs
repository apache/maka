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

use super::external_support::{host_tool, input, packet, release, with_tools};
use super::*;
use maka_agent_facts::{
    event::{Fact, ToolOutcome},
    tool_call::ToolOrigin,
};
use tokio::io::BufReader;

async fn plan(control: &mut BufReader<TcpStream>, calls: Value) {
    let mut bytes = serde_json::to_vec(&json!({"calls":calls})).unwrap();
    bytes.push(b'\n');
    control.get_mut().write_all(&bytes).await.unwrap();
}
async fn replies(control: &mut BufReader<TcpStream>, count: usize) -> BTreeMap<u64, Value> {
    let mut replies = BTreeMap::new();
    let mut responsive = false;
    while replies.len() < count || !responsive {
        let mut line = String::new();
        tokio::io::AsyncBufReadExt::read_line(control, &mut line)
            .await
            .unwrap();
        let value: Value = serde_json::from_str(&line).unwrap();
        match value["phase"].as_str().unwrap() {
            "responsive" => responsive = true,
            "tool_result" => {
                replies.insert(
                    value["reply"]["callId"].as_u64().unwrap(),
                    value["reply"]["result"].clone(),
                );
            }
            _ => panic!("unexpected fixture packet: {value}"),
        }
    }
    replies
}
fn business(result: &Value) -> Value {
    serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
}
async fn finish(f: &Fixture, control: &mut BufReader<TcpStream>) {
    packet(control, "output").await;
    release(control).await;
    packet(control, "terminal").await;
    release(control).await;
    f.drained().await;
}

#[tokio::test]
async fn native_external_host_query_mutation_preserve_origin_receipt_and_allowlist() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let tooling = service_tools::Setup::javascript().with_host_tools(vec![host_tool("observe", "SessionRead"), host_tool("create", "SessionCreate"), host_tool("metadata", "SessionUpdate"), host_tool("changeSession", "SessionChange")]);
        let (f, listener) = with_tools("http://127.0.0.1:9/v1", Some(tooling), |_| {}).await;
        let mut create = f.create_input("Host bridge").await;
        create["tools"] = json!(["SessionRead", "SessionCreate", "SessionUpdate", "SessionChange"]);
        let created = f.mutation(2, "create", create, Uuid::new_v4()).await.unwrap();
        let session = created["session"]["id"].as_str().unwrap();
        let accepted = f.mutation(2, "send", input(session, "host query"), Uuid::new_v4()).await.unwrap();
        assert_eq!(accepted["kind"], "started", "{accepted}");
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        let opened = packet(&mut control, "opened").await;
        let names: Vec<_> = opened["request"]["tools"].as_array().unwrap().iter().map(|tool| tool["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["SessionCreate", "SessionRead"]);
        plan(&mut control, json!([
            {"callId":1,"name":"SessionRead","input":{"sessionId":session}},
            {"callId":2,"name":"SessionCreate","input":{"title":"Bridge child","labels":[],"workspace":{"kind":"session","sessionId":session}}},
            {"callId":3,"name":"Execute","input":{"command":"touch forbidden"}},
            {"callId":4,"name":"SessionUpdate","input":{}},
        ])).await;
        let results = replies(&mut control, 4).await;
        assert!(results[&1].get("isError").is_none(), "{}", results[&1]);
        assert_eq!(business(&results[&1])["session"]["id"], session);
        assert_eq!(business(&results[&2])["kind"], "created", "{}", business(&results[&2]));
        let child = business(&results[&2])["session"]["id"].as_str().unwrap().to_owned();
        assert_eq!(f.query("observe", json!({"sessionId":child})).await.unwrap()["session"]["parentSessionId"], session);
        assert_eq!(results[&3]["isError"], true);
        assert_eq!(results[&4]["isError"], true);
        let events = f.prefix(session, 128, 1024*1024).await.events;
        let calls: Vec<_> = events.iter().filter_map(|row| match &row.event.fact {
            Fact::ToolDispatched { name, call, .. } => Some((name, call)), _ => None,
        }).collect();
        assert_eq!(calls.len(), 2);
        assert!(calls.iter().all(|(_, call)| matches!(&call.origin, ToolOrigin::HostSdk { entry_id, parent: None, .. } if entry_id == "external")));
        assert!(events.iter().any(|row| matches!(&row.event.fact, Fact::ToolSettled { outcome: ToolOutcome::Succeeded { .. }, .. })));
        finish(&f, &mut control).await;
        // A narrower Session ceiling must also reject adversarial out-of-catalog calls.
        let mut create = f.create_input("Narrow bridge").await;
        create["tools"] = json!(["SessionRead"]);
        let created = f.mutation(2, "create", create, Uuid::new_v4()).await.unwrap();
        let narrow = created["session"]["id"].as_str().unwrap();
        f.mutation(2, "send", input(narrow, "narrow"), Uuid::new_v4()).await.unwrap();
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        let opened = packet(&mut control, "opened").await;
        assert_eq!(opened["request"]["tools"].as_array().unwrap().len(), 1);
        plan(&mut control, json!([{ "callId":1,"name":"SessionCreate","input":{"title":"Forbidden child","labels":[],"workspace":{"kind":"session","sessionId":narrow}}}])).await;
        assert_eq!(replies(&mut control, 1).await[&1]["isError"], true);
        finish(&f, &mut control).await;
        f.app.shutdown().await.unwrap(); f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_external_host_read_accepts_resources_and_rejects_decoded_local_paths() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let (f, listener) = with_tools(
            "http://127.0.0.1:9/v1",
            Some(service_tools::Setup::files("readText")),
            |_| {},
        )
        .await;
        let session = f.create("Resource read").await;
        let uploaded = super::super::attachments::upload(
            &f,
            &session,
            "host.txt",
            b"host resource evidence\n",
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        let id = uploaded["attachment"]["id"].as_str().unwrap();
        let local = maka_agent_facts::read::ReadInput {
            path: "/etc/passwd".into(),
            offset: None,
            limit: None,
        };
        let encoded = local
            .resolve()
            .unwrap()
            .page(&"local\n".repeat(3000))
            .unwrap()
            .next
            .unwrap();
        assert_eq!(encoded.resolve().unwrap().path(), "/etc/passwd");
        f.mutation(2, "send", input(&session, "read resources"), Uuid::new_v4())
            .await
            .unwrap();
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        let opened = packet(&mut control, "opened").await;
        assert!(
            opened["request"]["tools"][0]["description"]
                .as_str()
                .unwrap()
                .contains("only Maka")
        );
        plan(
            &mut control,
            json!([
                {"callId":1,"name":"WorkspaceFile","input":{"path":format!("attachment:{id}")}},
                {"callId":2,"name":"WorkspaceFile","input":{"path":"/etc/passwd"}},
                {"callId":3,"name":"WorkspaceFile","input":encoded},
                {"callId":4,"name":"WorkspaceFile","input":{"path":"task:abcdef012345"}},
            ]),
        )
        .await;
        let results = replies(&mut control, 4).await;
        assert!(results[&1].get("isError").is_none(), "{}", results[&1]);
        assert_eq!(
            business(&results[&1])["value"]["content"],
            "host resource evidence\n"
        );
        for id in [2, 3, 4] {
            assert_eq!(results[&id]["isError"], true);
        }
        finish(&f, &mut control).await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_external_host_questions_wait_inline_while_native_stream_remains_active() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let mut tooling = service_tools::Setup::questions();
        tooling.confirmation = contract::ToolConfirmation::Required;
        let (f, listener) = with_tools("http://127.0.0.1:9/v1", Some(tooling), |_| {}).await;
        let session = f.create("Host inline interaction").await;
        f.mutation(2, "send", input(&session, "question"), Uuid::new_v4()).await.unwrap();
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control, "opened").await;
        plan(&mut control, json!([{ "callId":1,"name":"AskUserQuestion","input":{"questions":[{"question":"Choose output","options":[{"label":"Brief","description":"Brief output"},{"label":"Full","description":"Complete output"}]}]}}])).await;
        packet(&mut control, "responsive").await;
        let approval = service_tools::pending_approval(&f, &session).await;
        let answer = f.mutation(2, "respond", json!({"sessionId":session,"requestId":approval.request_id,"answer":{"kind":"service_approval","decision":"allow"}}), Uuid::new_v4()).await.unwrap();
        assert_eq!(answer["kind"], "recorded");
        let mut commits = f.session(&session).await.subscribe_commits().unwrap();
        let question = loop {
            let pending = f.session(&session).await.pending_interactions(&session).await.unwrap();
            if let Some(question) = pending.into_iter().find(|record| matches!(record.request, maka_agent_facts::interaction::InteractionRequest::Question { .. })) { break question; }
            commits.changed().await.unwrap();
        };
        f.mutation(2, "respond", json!({"sessionId":session,"requestId":question.request_id,"answer":{"kind":"question","answers":["Brief"]}}), Uuid::new_v4()).await.unwrap();
        let result = packet(&mut control, "tool_result").await;
        assert_eq!(business(&result["reply"]["result"])["kind"], "answered");
        finish(&f, &mut control).await;
        f.app.shutdown().await.unwrap(); f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_external_host_excludes_third_party_aliases_and_local_shell_services() {
    tokio::time::timeout(Duration::from_secs(45), async {
        for tooling in [
            service_tools::Setup::javascript().named("SessionRead"),
            service_tools::Setup::processes(),
        ] {
            let (f, listener) = with_tools("http://127.0.0.1:9/v1", Some(tooling), |_| {}).await;
            let session = f.create("Host provenance").await;
            f.mutation(2, "send", input(&session, "provenance"), Uuid::new_v4())
                .await
                .unwrap();
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            let opened = packet(&mut control, "opened").await;
            assert_eq!(opened["request"]["tools"], json!([]));
            plan(
                &mut control,
                json!([
                    {"callId":1,"name":"SessionRead","input":{"amount":1}},
                    {"callId":2,"name":"Execute","input":{"command":"touch must-not-exist"}},
                ]),
            )
            .await;
            let results = replies(&mut control, 2).await;
            assert_eq!(results[&1]["isError"], true);
            assert_eq!(results[&2]["isError"], true);
            assert!(
                !f.prefix(&session, 128, 1024 * 1024)
                    .await
                    .events
                    .iter()
                    .any(|row| matches!(row.event.fact, Fact::ToolDispatched { .. }))
            );
            finish(&f, &mut control).await;
            f.app.shutdown().await.unwrap();
            f.config.shutdown().await.unwrap();
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_external_host_large_results_archive_at_actual_t2_and_continue_through_read() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let tooling = service_tools::Setup::files("readText").with_host_tools(vec![host_tool("list", "SessionList")]);
        let (f, listener) = with_tools("http://127.0.0.1:9/v1", Some(tooling), |_| {}).await;
        let session = f.create("Archive bridge").await;
        for index in 0..24 { f.create(&format!("Archive child {index:02} {}", "x".repeat(100))).await; }
        f.mutation(2, "send", input(&session, "large result"), Uuid::new_v4()).await.unwrap();
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control, "opened").await;
        plan(&mut control, json!([{ "callId":1,"name":"SessionList","input":{"filter":"all","position":{"kind":"start"}}}])).await;
        let result = business(&replies(&mut control, 1).await[&1]);
        assert_eq!(result["kind"], "maka.archived_tool_result", "{result}");
        let page = result["page"].clone();
        assert!(page["next"].is_object(), "{page}");
        let events = f.prefix(&session, 256, 1024*1024).await.events;
        let address = maka_agent_facts::read::ResourceAddress::parse(result["resourceRef"].as_str().unwrap()).unwrap().unwrap();
        let source = events.iter().find(|row| row.event.id.starts_with(address.id())).unwrap();
        assert!(matches!(source.event.fact, Fact::ToolSettled { outcome: ToolOutcome::Succeeded { .. }, .. }));
        let original = f.session(&session).await.resolve_tool_result(&session, &source.event.id).await.unwrap().into_code_value().unwrap();
        let full = serde_json::to_string(&original).unwrap();
        assert!(full.len() > 7500);
        finish(&f, &mut control).await;
        f.mutation(2, "send", input(&session, "continue archive"), Uuid::new_v4()).await.unwrap();
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control, "opened").await;
        plan(&mut control, json!([{ "callId":1,"name":"WorkspaceFile","input":page["next"]}])).await;
        let results = replies(&mut control, 1).await;
        assert!(results[&1].get("isError").is_none(), "{}", results[&1]);
        let continued = business(&results[&1]);
        let mut reconstructed = page["content"].as_str().unwrap().to_owned();
        reconstructed.push_str(continued["value"]["content"].as_str().unwrap());
        assert!(full.starts_with(&reconstructed), "continuation must read the immutable original business result");
        finish(&f, &mut control).await;
        f.app.shutdown().await.unwrap(); f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

struct HeldHostQuestion {
    entered: Arc<Semaphore>,
    cancelled: Arc<Semaphore>,
    release: Arc<Semaphore>,
}
impl Handler for HeldHostQuestion {
    fn call(
        &self,
        method: String,
        _: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value, String>> {
        assert_eq!(method, "ask");
        assert!(matches!(context.scope().identity, Identity::Agent { .. }));
        assert!(context.operation().is_some());
        let (entered, cancelled, release) = (
            self.entered.clone(),
            self.cancelled.clone(),
            self.release.clone(),
        );
        Box::pin(async move {
            entered.add_permits(1);
            context.scope().cancellation.cancelled().await;
            cancelled.add_permits(1);
            release.acquire().await.unwrap().forget();
            Ok(json!({"kind":"closed","reason":"producer_cancelled"}))
        })
    }
}
impl NativeOwner for HeldHostQuestion {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
async fn native_external_host_stop_drains_admitted_tool_after_worker_terminal_and_exit() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let held = Arc::new(HeldHostQuestion { entered: Arc::new(Semaphore::new(0)), cancelled: Arc::new(Semaphore::new(0)), release: Arc::new(Semaphore::new(0)) });
        let tooling = service_tools::Setup::questions().with_handler(held.clone(), held.clone());
        let (f, listener) = with_tools("http://127.0.0.1:9/v1", Some(tooling), |_| {}).await;
        let session = f.create("Drain Host effect").await;
        let accepted = f.mutation(2, "send", input(&session, "drain"), Uuid::new_v4()).await.unwrap();
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control, "opened").await;
        let mut bytes = serde_json::to_vec(&json!({"earlyTerminal":true,"calls":[{"callId":1,"name":"AskUserQuestion","input":{"questions":[{"question":"Wait","options":[{"label":"A"},{"label":"B"}]}]}}]})).unwrap(); bytes.push(b'\n');
        control.get_mut().write_all(&bytes).await.unwrap();
        packet(&mut control, "responsive").await;
        held.entered.acquire().await.unwrap().forget();
        f.mutation(2, "stop", json!({"sessionId":session,"invocationId":accepted["invocationId"]}), Uuid::new_v4()).await.unwrap();
        packet(&mut control, "cancelled_tools").await;
        packet(&mut control, "terminal").await;
        held.cancelled.acquire().await.unwrap().forget();
        release(&mut control).await;
        assert!(!f.owner.runs.lock().await.controls.is_empty(), "worker terminal must retain execution custody through Host tool settlement");
        held.release.add_permits(1);
        f.drained().await;
        let events = f.prefix(&session, 128, 1024*1024).await.events;
        let settled = events.iter().position(|row| matches!(row.event.fact, Fact::ToolSettled { .. })).unwrap();
        let ended = events.iter().position(|row| matches!(row.event.fact, Fact::InvocationEnded { .. })).unwrap();
        assert!(settled < ended, "executor terminal must follow the admitted effect's T2");
        f.app.shutdown().await.unwrap(); f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_external_host_bindings_hide_private_recall_and_supply_real_skill_tools() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let (f, listener) = with_tools("http://127.0.0.1:9/v1", None, |settings| settings.recall = true).await;
        let session = f.create("Private Recall bridge").await;
        let before = f.config.runtime_policy().await.unwrap();
        f.config.set_privacy(before.revision, maka_agent_facts::configuration::policy::PrivacyPolicy { incognito_active: true }).await.unwrap();
        f.mutation(2, "send", input(&session, "private"), Uuid::new_v4()).await.unwrap();
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        let opened = packet(&mut control, "opened").await;
        assert_eq!(opened["request"]["tools"], json!([]));
        plan(&mut control, json!([{ "callId":1,"name":"Recall","input":{"terms":["secret"]}}])).await;
        assert_eq!(replies(&mut control, 1).await[&1]["isError"], true);
        finish(&f, &mut control).await;
        f.app.shutdown().await.unwrap(); f.config.shutdown().await.unwrap();

        let home = tempfile::tempdir().unwrap();
        let tooling = service_tools::Setup::skill_preparation(home.path().into(), true).with_standard_sources();
        let (f, listener) = with_tools("http://127.0.0.1:9/v1", Some(tooling), |_| {}).await;
        let session = f.create("Skill bridge").await;
        let workspace = f.owner.session(&session).await.unwrap().configuration.workspace;
        let skill = std::path::Path::new(&workspace.path).join(".maka/skills/review");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "---\nname: review\ndescription: Review bridge\nrequired-tools: FindGuide LoadGuide\n---\nBRIDGE REVIEW INSTRUCTIONS").unwrap();
        for runtime in ["codex", "antigravity"] {
        let accepted = f.mutation(2, "send", super::external_support::input_runtime(&session, runtime, "/skill:review inspect"), Uuid::new_v4()).await.unwrap();
        assert_eq!(accepted["kind"], "started", "{accepted}");
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        let opened = packet(&mut control, "opened").await;
        assert!(opened["request"]["message"].as_str().unwrap().contains("BRIDGE REVIEW INSTRUCTIONS"));
        let names: Vec<_> = opened["request"]["tools"].as_array().unwrap().iter().map(|tool| tool["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["FindGuide", "LoadGuide"]);
        plan(&mut control, json!([{ "callId":1,"name":"FindGuide","input":{"query":"Review bridge"}}])).await;
        let results = replies(&mut control, 1).await;
        assert_eq!(business(&results[&1])["totalEligible"], 1, "{}", results[&1]);
        finish(&f, &mut control).await;
        }
        f.app.shutdown().await.unwrap(); f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

struct UncertainHostQuestion {
    cleanup_failed: bool,
}
impl Handler for UncertainHostQuestion {
    fn call(
        &self,
        _: String,
        _: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value, String>> {
        let cleanup_failed = self.cleanup_failed;
        Box::pin(async move {
            if cleanup_failed {
                let mut ticket = context.scope().resources.reserve().unwrap();
                ticket.start();
                ticket.complete(Err("Host question cleanup failed".into()));
                Ok(json!({"kind":"closed","reason":"producer_cancelled"}))
            } else {
                Err("original Host effect lost reply".into())
            }
        })
    }
}
impl NativeOwner for UncertainHostQuestion {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
#[tokio::test]
async fn native_external_host_uncertainty_keeps_operation_receipts_and_fatal_execution_evidence() {
    tokio::time::timeout(Duration::from_secs(45), async {
        for cleanup_failed in [false, true] {
            let handler = Arc::new(UncertainHostQuestion { cleanup_failed });
            let tooling = service_tools::Setup::questions().with_handler(handler.clone(), handler);
            let (f, listener) = with_tools("http://127.0.0.1:9/v1", Some(tooling), |_| {}).await;
            let session = f.create("Uncertain Host effect").await;
            let accepted = f.mutation(2, "send", input(&session, "uncertain"), Uuid::new_v4()).await.unwrap();
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            packet(&mut control, "opened").await;
            let mut bytes = serde_json::to_vec(&json!({"expectCancel":true,"calls":[{"callId":1,"name":"AskUserQuestion","input":{"questions":[{"question":"Proceed","options":[{"label":"A"},{"label":"B"}]}]}}]})).unwrap(); bytes.push(b'\n');
            control.get_mut().write_all(&bytes).await.unwrap();
            let results = replies(&mut control, 1).await;
            assert_eq!(results[&1]["isError"], true);
            let error = business(&results[&1]);
            assert!(error["operationId"].is_string(), "{error}");
            assert!(error["observation"]["receipt"].is_object(), "{error}");
            // Fatal tool settlement cancels the native worker; let it return its receipt.
            packet(&mut control, "cancelled_tools").await;
            packet(&mut control, "terminal").await;
            release(&mut control).await;
            f.drained().await;
            let events = f.prefix(&session, 128, 1024*1024).await.events;
            assert!(events.iter().any(|row| matches!(&row.event.fact, Fact::InvocationEnded { outcome: maka_agent_facts::event::InvocationOutcome::Failed { .. } })));
            if cleanup_failed {
                assert!(events.iter().any(|row| matches!(&row.event.fact, Fact::ToolSettled { outcome: ToolOutcome::Succeeded { .. }, .. })));
                assert_eq!(super::external_support::record(&f, &session).await["running"], accepted["invocationId"]);
            } else {
                assert!(events.iter().any(|row| matches!(&row.event.fact, Fact::ToolSettled { outcome: ToolOutcome::Unknown { operation: Some(_), .. }, .. })));
            }
            let _ = f.app.shutdown().await;
            f.config.shutdown().await.unwrap();
        }
    }).await.unwrap();
}

#[tokio::test]
async fn native_external_host_mcp_calls_commit_without_following_native_output() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let tooling = service_tools::Setup::javascript()
            .with_host_tools(vec![host_tool("observe", "SessionRead")]);
        let (f, listener) = with_tools("http://127.0.0.1:9/v1", Some(tooling), |_| {}).await;
        let session = f.create("Tool frame acknowledgements").await;
        for cancel_calls in [false, true] {
            f.mutation(
                2,
                "send",
                super::external_support::input_runtime(
                    &session,
                    "antigravity",
                    "tool frame commit",
                ),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            let opened = packet(&mut control, "opened").await;
            assert!(
                opened["request"]["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tool| tool["name"] == "SessionRead")
            );
            let mut bytes = serde_json::to_vec(&json!({
                "calls":[{"callId":1,"name":"SessionRead","input":{"sessionId":session}}],
                "toolFramesOnly":true,"cancelCalls":cancel_calls,
            }))
            .unwrap();
            bytes.push(b'\n');
            control.get_mut().write_all(&bytes).await.unwrap();
            replies(&mut control, 1).await;
            finish(&f, &mut control).await;
        }
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_external_host_large_mcp_message_is_accepted_and_delivered_intact() {
    tokio::time::timeout(Duration::from_secs(45),async {
        let tooling=service_tools::Setup::javascript().with_host_tools(vec![host_tool("send","SessionSend")]);
        let (f,listener)=with_tools("http://127.0.0.1:9/v1",Some(tooling),|_|{}).await;
        let session=f.create("Large MCP input").await;
        let accepted=f.mutation(2,"send",input(&session,"queue a large follow-up"),Uuid::new_v4()).await.unwrap();
        let mut control=BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control,"opened").await;
        let message="Full UTF-8 follow-up 中文\n".repeat(200_000);
        assert!(message.len()>4*1024*1024);
        plan(&mut control,json!([{"callId":1,"name":"SessionSend","input":{
            "sessionId":session,"message":message,"delivery":"queue","backend":super::external_support::backend("codex")
        }}])).await;
        let results=replies(&mut control,1).await;
        assert_ne!(results[&1]["isError"],true,"valid large Host request must be admitted");
        let queued=business(&results[&1]);
        assert_eq!(queued["kind"],"queued");
        packet(&mut control,"output").await;release(&mut control).await;
        packet(&mut control,"terminal").await;release(&mut control).await;
        let mut followup=BufReader::new(listener.accept().await.unwrap().0);
        let delivered=packet(&mut followup,"opened").await;
        assert!(delivered["request"]["message"].as_str().unwrap().ends_with(&message));
        release(&mut followup).await;finish(&f,&mut followup).await;
        assert_eq!(work(&f,&session,&accepted).await["execution"]["state"],"completed");
        let completed=f.query("work",json!({"sessionId":session,"target":{"kind":"message","messageId":queued["messageId"]}})).await.unwrap();
        assert_eq!(completed["execution"]["state"],"completed");
        f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
    }).await.unwrap();
}
