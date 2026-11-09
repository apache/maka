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
    artifact::ToolReturn,
    cells::{CellEvent, CellReturnedResult},
    durable::{Fact, ToolKey},
    model::ModelPart,
    tool_call::ToolSettlement,
    tool_output::{ReturnedToolResult, ToolOutput},
};

async fn fixture(base: &str) -> Fixture {
    Fixture::configured(base, None, None, None, |settings| {
        settings.todo = true;
        settings.permissions.access = WorkspaceAccess::ReadOnly;
    })
    .await
}
fn last_tool(sent: &Value) -> &str {
    let messages = sent["messages"].as_array().unwrap();
    let tool = messages
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .unwrap_or_else(|| {
            panic!(
                "Expected a tool result; received: {:?}",
                messages
                    .iter()
                    .map(|message| (
                        message["role"].clone(),
                        message["content"]
                            .to_string()
                            .chars()
                            .take(1000)
                            .collect::<String>()
                    ))
                    .collect::<Vec<_>>()
            )
        });
    tool["content"].as_str().unwrap()
}
async fn page(f: &Fixture, session: &str, offset: usize) -> Value {
    f.query("checklist", json!({"sessionId":session,"offset":offset}))
        .await
        .unwrap()
}
pub(super) async fn reopen(f: &mut Fixture) {
    let deployment = f.app.source().unwrap().deployment;
    f.app.shutdown().await.unwrap();
    let mut native = NativeRegistry::default();
    maka_settings_native::provide(&mut native, crate::owner::tests::bundled_catalog()).unwrap();
    provide_all(&mut native, f.owner.durable.clone()).unwrap();
    f.app = Application::start_from_store(
        f.store.clone(),
        deployment,
        native,
        f.issuer.clone(),
        Arc::new(Grant(f.issuer.clone(), None)),
        Some(maka_host_js::factory(Default::default())),
    )
    .await
    .unwrap();
    f.app.ready().await.unwrap();
}
#[tokio::test]
async fn todo_real_model_direct_and_code_mode_keep_full_list_isolation_and_restart() {
    tokio::time::timeout(Duration::from_secs(90), async {
        for code in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
            let no_service_bindings = f.owner.tool_basis.is_empty();
            selection::edit(&f, |changes| {
                changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride { code_mode: Some(code), context_window: Some(1_000_000), input_limit: Some(900_000), ..Default::default() })]));
            }).await;
            let session = f.create("Checklist source").await;
            let other = f.create("Separate checklist").await;
            let items: Vec<Value> = (0..240).map(|index| json!({"content":format!("{index:03} {}", "😀".repeat(256)),"status":if index == 0 { "completed" } else if index == 1 { "in_progress" } else { "pending" }})).collect();
            f.send(&session).await.unwrap();
            let (mut socket, _) = listener.accept().await.unwrap();
            let sent = request(&mut socket).await;
            let tool = if code { "exec" } else { "todo_write" };
            assert!(sent["tools"].as_array().unwrap().iter().any(|t| t["function"]["name"] == tool));
            let input = if code { json!({"code":"const todos = Array.from({length:240}, (_, index) => ({content:String(index).padStart(3, '0') + ' ' + '😀'.repeat(256), status:index === 0 ? 'completed' : index === 1 ? 'in_progress' : 'pending'})); await tools.todo_write({todos}); const read = await tools.todo_read({}); if (JSON.stringify(read.items) !== JSON.stringify(todos)) throw Error('read differs from complete write'); text(read.items.at(-1));"}) } else { json!({"todos":items}) };
            service_tools::named_tool_response(&mut socket, tool, input).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let written = request(&mut socket).await;
            let direct_archive = if code {
                assert!(last_tool(&written).contains("239"), "Code Mode must read the complete list");
                None
            } else {
                // Ordinary large tool results use the existing bounded archive projection.
                let archived: Value = serde_json::from_str(last_tool(&written)).unwrap();
                assert_eq!(archived["kind"], "maka.archived_tool_result");
                assert_eq!(archived["toolName"], "todo_write");
                assert!(archived["page"]["next"].is_object());
                Some(archived)
            };
            if !code {
                service_tools::named_tool_response(&mut socket,"todo_read",json!({})).await;
                let (mut next, _) = listener.accept().await.unwrap();
                let read = request(&mut next).await;
                let archived: Value = serde_json::from_str(last_tool(&read)).unwrap();
                assert_eq!(archived["kind"], "maka.archived_tool_result");
                assert_eq!(archived["toolName"], "todo_read");
                response(&mut next).await;
            } else { response(&mut socket).await; }
            f.drained().await;
            let first = page(&f,&session,0).await;
            assert_eq!(first["total"],240);
            assert_eq!(first["completed"],1);
            assert_eq!(first["current"],items[1]);
            assert_eq!(first["items"],json!(items[..20]));
            assert!(serde_json::to_vec(&first).unwrap().len() < 48 * 1024);
            let mut all = vec![];
            for offset in (0..240).step_by(20) {
                let current = page(&f,&session,offset).await;
                all.extend(current["items"].as_array().unwrap().iter().cloned());
                assert_eq!(current["revision"],first["revision"]);
            }
            assert_eq!(all,items);
            assert_eq!(page(&f,&other,0).await["total"],0);
            assert!(f.query("checklist",json!({"sessionId":"foreign-session","offset":0})).await.is_err());
            let facts = f.recorded_facts(&session).await;
            let mut original_results = vec![];
            if code {
                let children: Vec<_> = facts.iter().filter_map(|recorded| match &recorded.fact {
                    Fact::Cell { event: CellEvent::ChildPrepared { cell, operation, name, .. } }
                        if name == "todo_write" || name == "todo_read" => Some((recorded.run, *cell, *operation)),
                    _ => None,
                }).collect();
                assert_eq!(children.len(), 2);
                for (run, cell, operation) in children {
                    assert_eq!(facts.iter().filter(|recorded| recorded.run == run && matches!(&recorded.fact,
                        Fact::Cell { event: CellEvent::ChildAdmitted { cell: id, operation: child } }
                            if *id == cell && *child == operation)).count(), 1);
                    let returned: Vec<_> = facts.iter().filter_map(|recorded| match &recorded.fact {
                        Fact::Cell { event: CellEvent::LocalChildReturned { cell: id, operation: child, result, is_error: false, settlement: ToolSettlement::Returned } }
                            if recorded.run == run && *id == cell && *child == operation => Some(result),
                        _ => None,
                    }).collect();
                    assert_eq!(returned.len(), 1, "each original child has one successful canonical return");
                    let original: ToolReturn<CellReturnedResult> = serde_json::from_slice(
                        &f.owner.durable.content(run, returned[0].clone()).await.unwrap()
                    ).unwrap();
                    original.validate().unwrap();
                    let ToolOutput::Json(document) = original.body.output else { panic!("original checklist child JSON is retained") };
                    assert_eq!(document["items"], json!(items), "every item survives in each original child write/read receipt");
                    original_results.push((run, returned[0].clone()));
                }
            } else {
                let calls: Vec<_> = facts.iter().filter_map(|recorded| match &recorded.fact {
                    Fact::ModelObserved { attempt, part: ModelPart::ToolCall { call }, .. }
                        if call.name == "todo_write" || call.name == "todo_read" =>
                            Some((recorded.run, ToolKey { attempt: *attempt, call: call.id.clone() })),
                    _ => None,
                }).collect();
                assert_eq!(calls.len(), 2);
                for (run, key) in calls {
                    assert_eq!(facts.iter().filter(|recorded| recorded.run == run && matches!(&recorded.fact,
                        Fact::ToolAdmitted { tool } if *tool == key)).count(), 1);
                    let returned: Vec<_> = facts.iter().filter_map(|recorded| match &recorded.fact {
                        Fact::LocalToolReturned { tool, result, is_error: false, settlement: ToolSettlement::Returned }
                            if recorded.run == run && *tool == key => Some(result),
                        _ => None,
                    }).collect();
                    assert_eq!(returned.len(), 1, "each original tool has one successful canonical return");
                    let original: ToolReturn<ReturnedToolResult> = serde_json::from_slice(
                        &f.owner.durable.content(run, returned[0].clone()).await.unwrap()
                    ).unwrap();
                    original.validate().unwrap();
                    let ToolOutput::Json(document) = original.body.output else { panic!("original checklist JSON is retained") };
                    assert_eq!(document["items"], json!(items), "every item survives in each original write/read receipt");
                    assert_eq!(facts.iter().filter(|recorded| recorded.run == run && matches!(&recorded.fact,
                        Fact::ToolResultAccepted { tool, outcome: maka_agent_facts::durable::AcceptedResult::Succeeded, .. }
                            if *tool == key)).count(), 1);
                    original_results.push((run, returned[0].clone()));
                }
            }
            reopen(&mut f).await;
            assert_eq!(page(&f,&session,0).await,first);
            assert_eq!(page(&f,&other,0).await["total"],0);
            for (run, reference) in original_results {
                let bytes = f.owner.durable.content(run, reference).await.unwrap();
                let output = if code {
                    let original: ToolReturn<CellReturnedResult> = serde_json::from_slice(&bytes).unwrap();
                    original.validate().unwrap();
                    original.body.output
                } else {
                    let original: ToolReturn<ReturnedToolResult> = serde_json::from_slice(&bytes).unwrap();
                    original.validate().unwrap();
                    original.body.output
                };
                let ToolOutput::Json(document) = output else { panic!("reopen must preserve original checklist JSON") };
                assert_eq!(document["items"], json!(items));
            }
            f.app.shutdown().await.unwrap();
            f.config.shutdown().await.unwrap();
            if let Some(archived) = direct_archive {
                // This fixture selected no service bindings, including Files under any alias.
                assert!(no_service_bindings);
                assert!(sent["tools"].as_array().unwrap().iter()
                    .all(|tool| tool["function"]["name"] != "Read"), "{sent}");
                assert!(archived["page"]["next"].is_object());
                assert_eq!(archived["readInstructions"],
                    "Use page.next only with a selected Session tool-result reader; without one, the remainder is unavailable.");
            }
        }
    }).await.unwrap();
}

struct TodoFaultSql(String);
impl maka_event_log::writeback::Statement for TodoFaultSql {
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
async fn todo_fault_sql(f: &Fixture, sql: String) {
    f.store
        .data_writer()
        .unwrap()
        .write(TodoFaultSql(sql))
        .await
        .unwrap();
}
async fn completed_run(f: &Fixture, run: maka_agent_facts::durable::RunId) {
    let mut commits = f.owner.durable.subscribe().unwrap();
    loop {
        commits.borrow_and_update();
        if let Some(terminal) = f.owner.durable.frontier(run).await.unwrap().terminal {
            assert_eq!(terminal, maka_agent_facts::durable::Terminal::Completed);
            return;
        }
        commits.changed().await.unwrap();
    }
}

#[tokio::test]
async fn user_messages_after_abandoned_tool_dispatch_preserve_unknown_without_replay() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let check = |sent: &Value| {
            let messages = sent["messages"].as_array().unwrap();
            assert!(messages.iter().any(|message|
                message["content"].to_string().contains("durable side effect")),
                "the next model must receive the original known checklist result: {messages:?}");
            assert!(messages.iter().any(|message| message["role"] == "user"
                && message["content"] == "What happened to the checklist?"), "{messages:?}");
        };
        for queued in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
            let session = f.create("Unknown checklist outcome").await;
            let before_write = page(&f, &session, 0).await;
            assert_eq!(before_write["total"], 0);
            assert!(before_write["revision"].is_null());
            assert_eq!(before_write["items"], json!([]));
            f.send(&session).await.unwrap();
            let (mut socket, _) = listener.accept().await.unwrap();
            request(&mut socket).await;
            let run = f.latest_run(&session).await.run;
            if queued {
                assert_eq!(f.mutation(2, "send", json!({"sessionId":session,"message":"What happened to the checklist?","delivery":"queue","backend":model_backend(&f.selection().await)}), Uuid::new_v4()).await.unwrap()["kind"], "queued");
            }
            todo_fault_sql(&f, format!(
                "CREATE TRIGGER reject_settlement BEFORE INSERT ON agent_facts WHEN NEW.run='{run}' AND json_extract((SELECT payload FROM contents WHERE id=NEW.body_content_id),'$.fact.kind')='local_tool_returned' BEGIN SELECT RAISE(ABORT,'fixture original local T2 unavailable'); END;"
            )).await;
            let mut physical = f.owner.physical_changes();
            service_tools::named_tool_response(&mut socket, "todo_write", json!({"todos":[{"content":"durable side effect","status":"pending"}]})).await;
            let (key, original_id, original_result) = loop {
                physical.borrow_and_update();
                let original = f.owner.retained_tool_returns(&session).await;
                if !original.is_empty() {
                    assert_eq!(original.len(), 1);
                    break original.into_iter().next().unwrap();
                }
                physical.changed().await.unwrap();
            };
            let before_ack = page(&f, &session, 0).await;
            assert_eq!(before_ack, before_write,
                "a precommit T2 failure must roll back the same-transaction business replacement");
            assert_eq!(before_ack["total"], 0);
            assert!(before_ack["revision"].is_null());
            assert!(f.owner.durable.publication(run, vec![original_id], None).await.unwrap().facts.is_empty(),
                "the SQL failure must really prevent the original T2 acknowledgement");
            let mut commits = f.owner.durable.subscribe().unwrap();
            todo_fault_sql(&f, "DROP TRIGGER reject_settlement".into()).await;
            let acknowledged = loop {
                commits.borrow_and_update();
                if let Some(original) = f.owner.durable.fact(run, original_id).await.unwrap() {
                    break original;
                }
                commits.changed().await.unwrap();
            };
            let after_ack = page(&f, &session, 0).await;
            assert_eq!(after_ack["total"], 1);
            assert_eq!(after_ack["revision"], 1, "the business replacement commits exactly once with its original T2");
            assert_eq!(after_ack["items"], json!([{"content":"durable side effect","status":"pending"}]));
            assert_eq!(acknowledged.id, original_id, "late acknowledgement must reuse the actual frozen fact identity");
            assert!(matches!(&acknowledged.fact,
                Fact::LocalToolReturned { tool, result, is_error: false, settlement: ToolSettlement::Returned }
                    if *tool == key && *result == original_result),
                "late acknowledgement must retain the actual frozen key and result bytes");
            let returned: ToolReturn<ReturnedToolResult> = serde_json::from_slice(
                &f.owner.durable.content(run, original_result.clone()).await.unwrap()
            ).unwrap();
            returned.validate().unwrap();
            assert!(!returned.body.is_error);
            let ToolOutput::Json(original_document) = returned.body.output else { panic!("original local checklist result must be readable") };
            assert_eq!(original_document["items"], json!([{"content":"durable side effect","status":"pending"}]));
            loop {
                physical.borrow_and_update();
                if !f.owner.runs.state().await.retained_cleanup.contains_key(&session) {
                    break;
                }
                physical.changed().await.unwrap();
            }
            if !queued {
                f.mutation(2, "send", json!({"sessionId":session,"message":"What happened to the checklist?","backend":model_backend(&f.selection().await)}), Uuid::new_v4()).await.unwrap();
            }
            let (mut socket, _) = listener.accept().await.unwrap();
            check(&request(&mut socket).await);
            let recovery_run = f.latest_run(&session).await.run;
            response(&mut socket).await;
            completed_run(&f, recovery_run).await;
            assert!(f.owner.durable.queue().read(session.clone()).await.unwrap().entries.is_empty());
            assert_eq!(page(&f, &session, 0).await, after_ack,
                "retrying the original atomic publication and queued/new messages must not repeat the business mutation");
            reopen(&mut f).await;
            assert_eq!(page(&f, &session, 0).await, after_ack);
            let persisted = f.owner.durable.fact(run, original_id).await.unwrap().unwrap();
            assert_eq!(persisted.fact, acknowledged.fact);
            assert_eq!(persisted.at, acknowledged.at);
            assert_eq!(persisted.schema_version, acknowledged.schema_version);
            let reopened: ToolReturn<ReturnedToolResult> = serde_json::from_slice(
                &f.owner.durable.content(run, original_result.clone()).await.unwrap()
            ).unwrap();
            reopened.validate().unwrap();
            assert_eq!(reopened.body.output.into_json(), original_document);
            f.send(&session).await.unwrap();
            let (mut socket, _) = listener.accept().await.unwrap();
            check(&request(&mut socket).await);
            let final_run = f.latest_run(&session).await.run;
            response(&mut socket).await;
            completed_run(&f, final_run).await;
            assert!(f.owner.durable.queue().read(session.clone()).await.unwrap().entries.is_empty());
            assert_eq!(page(&f, &session, 0).await, after_ack);
            let history = f.recorded_facts(&session).await;
            assert_eq!(history.iter().filter(|recorded| matches!(&recorded.fact,
                Fact::ModelObserved { part: ModelPart::ToolCall { call }, .. } if call.name == "todo_write")).count(), 1,
                "no replay may produce another checklist call");
            assert_eq!(history.iter().filter(|recorded| recorded.run == run && matches!(&recorded.fact,
                Fact::ToolAdmitted { tool } if *tool == key)).count(), 1);
            assert_eq!(history.iter().filter(|recorded| recorded.run == run && matches!(&recorded.fact,
                Fact::LocalToolReturned { tool, result, .. } if *tool == key && *result == original_result)).count(), 1);
            assert_eq!(history.iter().filter(|recorded| recorded.id == original_id).count(), 1);
            f.app.shutdown().await.unwrap();
            f.config.shutdown().await.unwrap();
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        selection::edit(&f, |changes| {
            changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride {
                code_mode: Some(true), ..Default::default()
            })]));
        }).await;
        let session = f.create("Cell CAS rejection after original publication failure").await;
        let baseline = page(&f, &session, 0).await;
        assert!(baseline["revision"].is_null());
        let started = f.send(&session).await.unwrap();
        let run = f.delivered_run(&started).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        todo_fault_sql(&f, format!(
            "CREATE TRIGGER reject_cell_settlement BEFORE INSERT ON agent_facts WHEN NEW.run='{run}' AND json_extract((SELECT payload FROM contents WHERE id=NEW.body_content_id),'$.fact.event.kind')='local_child_returned' BEGIN SELECT RAISE(ABORT,'fixture original Cell local T2 unavailable'); END;"
        )).await;
        // Only the callbacks take this gate; both real preparations and T1s can finish with the same empty revision.
        let admission_barrier = f.owner.runs.state().await;
        service_tools::named_tool_response(&mut socket, "exec", json!({"code":r#"
            const settled = await Promise.allSettled([
                tools.todo_write({todos:[{content:'candidate A',status:'pending'}]}),
                tools.todo_write({todos:[{content:'candidate B',status:'pending'}]})
            ]);
            if (settled.some(result => result.status !== 'rejected')) throw Error('an unavailable original T2 was reported as success');
            text('both original publication failures were observed without replay');
        "#})).await;
        let mut commits = f.owner.durable.subscribe().unwrap();
        let (cell, first, second) = loop {
            commits.borrow_and_update();
            let view = f.owner.durable.frontier(run).await.unwrap();
            let mut found = None;
            for cell in view.cells.values() {
                let mut first = None;
                let mut second = None;
                for (operation, child) in &cell.children {
                    let input: Value = serde_json::from_slice(&f.owner.durable.content(run, child.input.clone()).await.unwrap()).unwrap();
                    match input["todos"][0]["content"].as_str() {
                        Some("candidate A") => first = Some((*operation, child)),
                        Some("candidate B") => second = Some((*operation, child)),
                        _ => {},
                    }
                }
                if let (Some((first, a)), Some((second, b))) = (first, second)
                    && a.admitted && b.admitted
                {
                    assert!(a.local_result.is_none() && b.local_result.is_none());
                    found = Some((cell.id, first, second));
                    break;
                }
            }
            if let Some(found) = found { break found; }
            commits.changed().await.unwrap();
        };
        drop(admission_barrier);
        f.drained().await;
        assert!(f.owner.runs.state().await.retained_cleanup.contains_key(&session),
            "the SQL fault must retain the real original Cell before it can be flushed");
        assert_eq!(page(&f, &session, 0).await, baseline,
            "neither prepared replacement can commit while both original T2 inserts fail");
        let retained = f.owner.durable.frontier(run).await.unwrap();
        assert!(retained.blockers.values().any(|blocker| matches!(blocker.reason,
            maka_agent_facts::durable::BlockerKind::CodeCellRecoveryUnavailable { .. })));
        assert!(retained.cells[&cell].children[&first].local_result.is_none());
        assert!(retained.cells[&cell].children[&second].local_result.is_none());
        let mut physical = f.owner.physical_changes();
        commits.borrow_and_update();
        todo_fault_sql(&f, "DROP TRIGGER reject_cell_settlement".into()).await;
        let closed = loop {
            physical.borrow_and_update();
            commits.borrow_and_update();
            let view = f.owner.durable.frontier(run).await.unwrap();
            let current = view.cells.get(&cell).unwrap();
            if current.physical_cleanup_confirmed()
                && !f.owner.runs.state().await.retained_cleanup.contains_key(&session)
            {
                break current.clone();
            }
            tokio::select! {
                changed = physical.changed() => changed.unwrap(),
                changed = commits.changed() => changed.unwrap(),
            }
        };
        let mut winners = Vec::new();
        let mut losers = Vec::new();
        for operation in [first, second] {
            let result = closed.children[&operation].local_result.as_ref().unwrap();
            match (result.is_error, &result.settlement) {
                (false, ToolSettlement::Returned) => winners.push(operation),
                (true, ToolSettlement::Failed) => losers.push(operation),
                other => panic!("original CAS publication has no authoritative terminal outcome: {other:?}"),
            }
        }
        assert_eq!(winners.len(), 1);
        assert_eq!(losers.len(), 1);
        let winner = winners[0];
        let loser = losers[0];
        let committed = page(&f, &session, 0).await;
        assert_eq!(committed["revision"], 1);
        let content = if winner == first { "candidate A" } else { "candidate B" };
        assert_eq!(committed["items"], json!([{"content":content,"status":"pending"}]));
        let rejected = closed.children[&loser].local_result.as_ref().unwrap();
        let failure_bytes = f.owner.durable.content(run, rejected.result.clone()).await.unwrap();
        let failure: ToolReturn<CellReturnedResult> = serde_json::from_slice(&failure_bytes).unwrap();
        assert!(failure.body.is_error);
        assert!(matches!(&failure.body.output, ToolOutput::Text(message) if message.contains("revision")),
            "late authoritative T2 must report the real business CAS conflict");
        let returned = closed.children[&winner].local_result.as_ref().unwrap();
        let successful: ToolReturn<CellReturnedResult> = serde_json::from_slice(
            &f.owner.durable.content(run, returned.result.clone()).await.unwrap()).unwrap();
        assert!(!successful.body.is_error);
        let ToolOutput::Json(document) = successful.body.output else { panic!("original successful checklist document required") };
        assert_eq!(document["items"], committed["items"]);
        let history = f.recorded_facts(&session).await;
        for operation in [first, second] {
            assert_eq!(history.iter().filter(|recorded| matches!(&recorded.fact,
                Fact::Cell { event: CellEvent::ChildAdmitted { cell: original, operation: child } }
                    if *original == cell && *child == operation)).count(), 1);
            assert_eq!(history.iter().filter(|recorded| matches!(&recorded.fact,
                Fact::Cell { event: CellEvent::LocalChildReturned { cell: original, operation: child, .. } }
                    if *original == cell && *child == operation)).count(), 1);
        }
        let blocked = f.owner.durable.frontier(run).await.unwrap();
        let (blocker, _) = blocked.blockers.iter().find(|(_, blocker)| matches!(blocker.reason,
            maka_agent_facts::durable::BlockerKind::CodeCellRecoveryUnavailable { .. })).unwrap();
        f.mutation(2, "adjudicateRisk", json!({
            "sessionId":session,"runId":run,"expectedHighWater":blocked.revision,"blockerId":blocker,
            "decision":{"kind":"cancel_blocked_run","diagnostic":"The original Cell is gone; preserve its failed CAS result without replay."}
        }), Uuid::new_v4()).await.unwrap();
        f.drained().await;
        assert_eq!(f.owner.durable.frontier(run).await.unwrap().terminal,
            Some(maka_agent_facts::durable::Terminal::Cancelled));
        let next = f.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response(&mut socket).await;
        completed_run(&f, f.delivered_run(&next).await).await;
        assert!(f.owner.durable.queue().read(session.clone()).await.unwrap().entries.is_empty());
        assert_eq!(page(&f, &session, 0).await, committed,
            "cleanup and a new Run must not retry the superseded replacement");
        assert_eq!(f.owner.durable.content(run, rejected.result.clone()).await.unwrap(), failure_bytes);
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}
