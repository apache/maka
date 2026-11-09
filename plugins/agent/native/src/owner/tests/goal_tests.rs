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
use maka_agent_facts::durable::{Fact, Terminal};

async fn fixture(base: &str) -> Fixture {
    Fixture::configured(base, None, None, None, |settings| {
        settings.goals = true;
        settings.tool_discovery = true;
    })
    .await
}
async fn current(f: &Fixture, session: &str) -> Value {
    f.query("goal", json!({"sessionId":session})).await.unwrap()["current"].clone()
}
async fn wait_status(f: &Fixture, session: &str, status: &str) -> Value {
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let value = current(f, session).await;
            if value["status"] == status && value["pending"] == false {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    match result {
        Ok(goal) => goal,
        Err(_) => panic!(
            "Goal did not settle as {status}: {}",
            current(f, session).await
        ),
    }
}

async fn approval(f: &Fixture, session: &str) -> Value {
    let config = f.owner.session(session).await.unwrap().configuration;
    json!({"target":{"sessionId":session,"workspace":config.workspace,"permissions":config.permissions,"boundaryRevision":config.boundary_revision,"binding":config.binding},"model":f.selection().await,"thinkingLevel":null})
}
async fn create(f: &Fixture, session: &str, start: bool, budget: Option<u64>) -> Value {
    f.mutation(2, "changeGoal", json!({"kind":"create","sessionId":session,"objective":"Verify the original native Goal 中😀","start":start,"tokenBudget":budget,"approval":approval(f,session).await}), Uuid::new_v4()).await.unwrap()
}
async fn control(f: &Fixture, session: &str, action: &str) -> Value {
    let current = current(f, session).await;
    f.mutation(2, "changeGoal", json!({"kind":"control","sessionId":session,"goalId":current["id"],"revision":current["revision"],"action":action}), Uuid::new_v4()).await.unwrap()
}
async fn report(socket: &mut TcpStream, code: bool, status: &str) {
    let input = json!({"status":status,"note":format!("Verified checkpoint {status} 中😀")});
    let (name, input) = if code {
        (
            "exec",
            json!({"code":format!("text(await tools.GoalStatus({input}));")}),
        )
    } else {
        ("GoalStatus", input)
    };
    service_tools::named_tool_response(socket, name, input).await;
}
#[tokio::test]
async fn goal_real_model_direct_and_code_mode_continue_only_after_settlement_and_keep_restart_receipts()
 {
    tokio::time::timeout(Duration::from_secs(90), async {
        for code in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
            selection::edit(&f, |changes| {
                changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride { code_mode: Some(code), ..Default::default() })]));
            }).await;
            let session = f.create("Goal execution").await;
            let other = f.create("Goal isolation").await;
            assert_eq!(create(&f, &session, true, None).await["kind"], "committed");
            let (mut first, _) = listener.accept().await.unwrap();
            let sent = request(&mut first).await;
            // A retired record need not decode execution authority; one unreadable active record cannot block another Goal.
            {
                use maka_plugin_core::storage::{Data, Mutation, Namespace, Store};
                let storage = maka_host_runtime::storage::Storage::new(
                    f.owner.store.clone(), f.owner.prefix.clone(),
                    Namespace::new("maka.agent.goal", maka_plugin_core::scope::Scope::Profile).unwrap(),
                );
                let retired = f.create("retired").await;
                let unreadable = f.create("unreadable").await;
                let gate = f.owner.goals.gate.lock().await;
                let saved = f.owner.goals.repository.read(&session).await.unwrap().unwrap();
                let mut mutations = Vec::new();
                for (neighbor, status) in [(retired, "achieved"), (unreadable, "active")] {
                    let mut record = serde_json::to_value(&saved.goal).unwrap();
                    record["sessionId"] = json!(neighbor);
                    record["status"] = json!(status);
                    record["pending"] = Value::Null;
                    record["arm"]["grant"] = json!({"unsupported_execution_snapshot":true});
                    let key = format!("session/{}", hex::encode(Sha256::digest(neighbor.as_bytes())));
                    mutations.push(Mutation { key, expected_revision: None, data: Data::Present(record) });
                }
                let schedule = storage.read("schedule".into()).await.unwrap();
                mutations.push(Mutation { key: "schedule".into(), expected_revision: schedule.map(|record| record.revision), data: Data::Deleted });
                storage.batch(mutations).await.unwrap();
                drop(gate);
                f.owner.goals.execution_changed();
                storage.finish().await.unwrap();
            }
            let names: Vec<_> = sent["tools"].as_array().unwrap().iter().filter_map(|tool| tool["function"]["name"].as_str()).collect();
            assert!(names.contains(&if code { "exec" } else { "GoalStatus" }), "{names:?}");
            assert!(!f.app.shutdown_if_idle().await.unwrap(), "an active Goal keeps the original Host alive");
            report(&mut first, code, "progress").await;
            let (mut finish, _) = listener.accept().await.unwrap();
            let result = request(&mut finish).await;
            assert!(result["messages"].to_string().contains("Verified checkpoint progress"));
            let pending = current(&f, &session).await;
            assert_eq!(pending["status"], "active");
            assert_eq!(pending["report"]["status"], "progress");
            assert_eq!(pending["iterations"], 1);
            response(&mut finish).await;
            let (mut next, _) = listener.accept().await.unwrap();
            let second = request(&mut next).await;
            assert!(second["messages"].to_string().contains("Verified checkpoint progress"));
            assert_eq!(current(&f, &session).await["iterations"], 2);
            report(&mut next, code, "achieved").await;
            let (mut finish, _) = listener.accept().await.unwrap();
            request(&mut finish).await;
            assert_eq!(current(&f, &session).await["status"], "achieved");
            assert_eq!(current(&f, &session).await["pending"], true, "completion must still observe physical cleanup");
            response(&mut finish).await;
            let achieved = wait_status(&f, &session, "achieved").await;
            assert_eq!(achieved["iterations"], 2);
            assert!(achieved["consumed"]["known"].as_u64().unwrap() >= 6);
            assert!(achieved["consumed"]["missing"].as_u64().unwrap() > 0);
            assert!(current(&f, &other).await.is_null());
            assert!(f.query("goal", json!({"sessionId":"foreign-session"})).await.is_err());
            let facts = f.recorded_facts(&session).await;
            let runs: Vec<_> = facts.iter().filter(|recorded| matches!(&recorded.fact, Fact::RunAdmitted { .. }))
                .map(|recorded| recorded.run).collect();
            assert_eq!(runs.len(), 2);
            for run in runs {
                let view = f.owner.durable.frontier(run).await.unwrap();
                if code {
                    let reports: Vec<_> = view.cells.values().flat_map(|cell| cell.children.values())
                        .filter(|child| child.name == "GoalStatus").collect();
                    assert_eq!(reports.len(), 1, "each iteration calls the actual GoalStatus child once");
                    assert!(reports[0].admitted, "preparation alone is not the child's T1");
                }
                let name = if code { "exec" } else { "GoalStatus" };
                let tools: Vec<_> = view.tools.values().filter(|tool| tool.call.name == name).collect();
                assert_eq!(tools.len(), 1);
                let key = &tools[0].key;
                assert!(tools[0].admitted);
                assert_eq!(facts.iter().filter(|recorded| recorded.run == run && matches!(&recorded.fact,
                    Fact::ToolAdmitted { tool } if tool == key)).count(), 1);
                assert_eq!(facts.iter().filter(|recorded| recorded.run == run && matches!(&recorded.fact,
                    Fact::ToolResultAccepted { tool, outcome: maka_agent_facts::durable::AcceptedResult::Succeeded, .. }
                        if tool == key)).count(), 1);
            }
            todo_tests::reopen(&mut f).await;
            assert_eq!(current(&f, &session).await, achieved);
            assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err());
            f.app.shutdown().await.unwrap();
            f.config.shutdown().await.unwrap();
        }
    }).await.unwrap();
}

#[tokio::test]
async fn goal_pause_stops_later_iterations_and_cancel_targets_only_the_original_goal_run() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let session = f.create("Pause and cancel Goal").await;
        let sibling = f.create("Independent user request").await;
        assert_eq!(create(&f, &session, true, None).await["kind"], "committed");
        let (mut first, _) = listener.accept().await.unwrap();
        request(&mut first).await;
        assert_eq!(control(&f, &session, "pause").await["kind"], "committed");
        response(&mut first).await;
        wait_status(&f, &session, "paused").await;
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
        assert_eq!(control(&f, &session, "resume").await["kind"], "committed");
        let (mut goal_run, _) = listener.accept().await.unwrap();
        request(&mut goal_run).await;
        assert_eq!(f.send(&sibling).await.unwrap()["kind"], "queued");
        assert!(f.owner.runs.state().await.controls.contains_key(&sibling));
        assert_eq!(control(&f, &session, "cancel").await["kind"], "committed");
        let mut byte = [0];
        assert_eq!(
            goal_run.read(&mut byte).await.unwrap(),
            0,
            "the original model connection is physically cancelled"
        );
        let cancelled = wait_status(&f, &session, "cancelled").await;
        assert_eq!(cancelled["iterations"], 2);
        assert!(f.owner.runs.state().await.controls.contains_key(&sibling));
        let (mut sibling_run, _) = listener.accept().await.unwrap();
        request(&mut sibling_run).await;
        response(&mut sibling_run).await;
        f.drained().await;
        assert!(
            service_tools::facts(&f, &session)
                .await
                .iter()
                .any(|fact| matches!(
                    fact,
                    Fact::RunTerminated {
                        terminal: Terminal::Cancelled,
                        ..
                    }
                ))
        );
        assert!(
            service_tools::facts(&f, &sibling)
                .await
                .iter()
                .any(|fact| matches!(
                    fact,
                    Fact::RunTerminated {
                        terminal: Terminal::Completed,
                        ..
                    }
                ))
        );
        f.app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn goal_incomplete_usage_blocks_finite_budget_even_after_it_is_raised() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let session = f.create("Goal with incomplete usage").await;
        assert_eq!(create(&f, &session, true, Some(6)).await["kind"], "committed");
        let (mut first, _) = listener.accept().await.unwrap();
        request(&mut first).await;
        report(&mut first, false, "progress").await;
        let (mut next, _) = listener.accept().await.unwrap();
        request(&mut next).await; response(&mut next).await;
        let limited = wait_status(&f, &session, "budget_limited").await;
        assert_eq!(limited["consumed"], json!({"known":3,"missing":2}));
        assert_eq!(limited["remainingTokens"], Value::Null);
        assert_eq!(limited["iterations"], 1);
        assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err());
        assert_eq!(f.mutation(2, "changeGoal", json!({"kind":"control","sessionId":session,"goalId":limited["id"],"revision":limited["revision"],"action":"resume","budget":{"tokenBudget":9}}), Uuid::new_v4()).await.unwrap()["kind"], "committed");
        let still_limited = wait_status(&f, &session, "budget_limited").await;
        assert_eq!(still_limited["id"], limited["id"]);
        assert_eq!(still_limited["iterations"], 1);
        assert_eq!(still_limited["consumed"], limited["consumed"]);
        assert_eq!(still_limited["tokenBudget"], 9);
        assert_eq!(still_limited["remainingTokens"], Value::Null);
        assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err());
        f.app.shutdown().await.unwrap();
    }).await.unwrap();
}

async fn known_usage_report(socket: &mut TcpStream) {
    let delta = json!({"id":"tool-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"goal-known","type":"function","function":{"name":"GoalStatus","arguments":json!({"status":"progress","note":"Verified checkpoint progress 中😀"}).to_string()}}]},"finish_reason":null}]});
    let end = json!({"id":"tool-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":0,"completion_tokens":1,"total_tokens":1}});
    let body = format!("data: {delta}\n\ndata: {end}\n\ndata: [DONE]\n\n");
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
async fn known_usage_finish(socket: &mut TcpStream) {
    let delta = json!({"id":"goal-finish","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]});
    let end = json!({"id":"goal-finish","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}});
    let body = format!("data: {delta}\n\ndata: {end}\n\ndata: [DONE]\n\n");
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
#[tokio::test]
async fn goal_known_usage_and_a_raised_budget_preserve_iterations_and_cumulative_cost() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let session = f.create("Goal with known usage").await;
        assert_eq!(create(&f, &session, true, Some(6)).await["kind"], "committed");
        let (mut first, _) = listener.accept().await.unwrap();
        request(&mut first).await; known_usage_report(&mut first).await;
        let (mut finish, _) = listener.accept().await.unwrap();
        request(&mut finish).await; known_usage_finish(&mut finish).await;
        let (mut second, _) = listener.accept().await.unwrap();
        request(&mut second).await; response(&mut second).await;
        let limited = wait_status(&f, &session, "budget_limited").await;
        assert_eq!(limited["consumed"], json!({"known":6,"missing":0}));
        assert_eq!(limited["iterations"], 2);
        assert_eq!(f.mutation(2, "changeGoal", json!({"kind":"control","sessionId":session,"goalId":limited["id"],"revision":limited["revision"],"action":"resume","budget":{"tokenBudget":9}}), Uuid::new_v4()).await.unwrap()["kind"], "committed");
        let (mut third, _) = listener.accept().await.unwrap();
        request(&mut third).await; response(&mut third).await;
        let finished = wait_status(&f, &session, "budget_limited").await;
        assert_eq!(finished["id"], limited["id"]);
        assert_eq!(finished["iterations"], 3);
        assert_eq!(finished["consumed"], json!({"known":9,"missing":0}));
        f.app.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn a_model_created_goal_finishes_in_the_creating_turn_and_is_readable_later() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let session = f.create("Create a Goal on request").await;
        f.send(&session).await.unwrap();
        let (mut first, _) = listener.accept().await.unwrap();
        let sent = request(&mut first).await;
        assert!(sent.to_string().contains("CreateGoal"));
        let objective = "完成这个长期目标 😀".repeat(500);
        service_tools::named_tool_response(
            &mut first,
            "CreateGoal",
            json!({"objective":objective}),
        )
        .await;
        let (mut second, _) = listener.accept().await.unwrap();
        let sent = request(&mut second).await;
        assert!(sent.to_string().contains("createdAt"));
        report(&mut second, false, "achieved").await;
        let (mut last, _) = listener.accept().await.unwrap();
        request(&mut last).await;
        response(&mut last).await;
        let goal = wait_status(&f, &session, "achieved").await;
        assert_eq!(goal["iterations"], 1);
        assert_eq!(goal["objective"], objective);
        f.send(&session).await.unwrap();
        let (mut read, _) = listener.accept().await.unwrap();
        request(&mut read).await;
        service_tools::named_tool_response(&mut read, "GetGoal", json!({})).await;
        let (mut answer, _) = listener.accept().await.unwrap();
        let sent = request(&mut answer).await;
        assert!(sent.to_string().contains("achieved"));
        response(&mut answer).await;
        f.drained().await;
        assert_eq!(current(&f, &session).await["id"], goal["id"]);
        f.app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn goal_original_business_receipt_and_reserved_iteration_survive_restart_without_replay() {
    use maka_goal::goal::{Control, Repository};
    use maka_plugin_core::storage::Namespace;
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let session = f.create("Recover Goal").await;
        let input = json!({"kind":"create","sessionId":session,"objective":"Preserve this original approval 中😀","start":false,"tokenBudget":3,"approval":approval(&f,&session).await});
        let client = f.app.client();
        let prepared = client.prepare_mutation(f.binding(2).await, "changeGoal".into(), input.clone(), scope(&f.issuer,true), Uuid::new_v4(), Attachments::new().into()).await.unwrap();
        let reference = prepared.reference().clone();
        f.store.record_application_intent(reference.source.clone(), prepared.consumer().instance().clone(), reference.clone(), Value::Null).await.unwrap();
        // Commit the business transaction without delivering its reply to Host.
        let committed = f.owner.goal_change(serde_json::from_value(input).unwrap(), reference.clone(), &scope(&f.issuer,true)).await.unwrap();
        let committed = serde_json::to_value(committed).unwrap();
        assert_eq!(committed["kind"], "committed");
        let mut armed = current(&f,&session).await;
        todo_tests::reopen(&mut f).await;
        let mut reopened = current(&f,&session).await;
        armed.as_object_mut().unwrap().remove("elapsedSeconds");
        reopened.as_object_mut().unwrap().remove("elapsedSeconds");
        assert_eq!(reopened,armed);
        assert_eq!(f.query("goalReceipt",json!({"reference":reference})).await.unwrap(),committed);
        f.app.shutdown().await.unwrap();
        let storage = Arc::new(maka_host_runtime::storage::Storage::new(f.store.clone(), f.owner.prefix.clone(), Namespace::new("maka.agent.goal",maka_plugin_core::scope::Scope::Profile).unwrap()));
        let repo: Repository<crate::owner::notifications::BackgroundApproval> = Repository::new(storage.clone());
        let mut saved = repo.read(&session).await.unwrap().unwrap();
        saved.goal.control(Control::Resume).unwrap();
        saved.goal.reserve().unwrap();
        let original = saved.goal.clone();
        repo.save(saved).await.unwrap();
        todo_tests::reopen(&mut f).await;
        let (mut socket,_) = listener.accept().await.unwrap();
        assert!(request(&mut socket).await.to_string().contains("Preserve this original approval"));
        response(&mut socket).await;
        assert_eq!(wait_status(&f,&session,"budget_limited").await["iterations"],1);
        f.app.shutdown().await.unwrap();
        // A lost Goal settlement retains its outbox, but the original turn already
        // completed. Even revocation must not rewrite or redispatch that result.
        let mut saved = repo.read(&session).await.unwrap().unwrap();
        saved.goal = original;
        repo.save(saved).await.unwrap();
        f.store.set_session_archived::<StoredSessionConfiguration>(&session,true,now()).await.unwrap();
        todo_tests::reopen(&mut f).await;
        assert_eq!(wait_status(&f,&session,"budget_limited").await["iterations"],1);
        assert_eq!(service_tools::facts(&f,&session).await.iter().filter(|fact| matches!(fact,Fact::RunAdmitted { .. })).count(),1);
        assert!(tokio::time::timeout(Duration::from_millis(100),listener.accept()).await.is_err());
        assert_eq!(f.query("goalReceipt",json!({"reference":reference})).await.unwrap(),committed);
        f.app.shutdown().await.unwrap();
        storage.finish().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn goal_rechecks_revoked_session_before_original_outbox_admission() {
    use maka_goal::goal::{Control, Repository};
    use maka_plugin_core::storage::Namespace;
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut f = fixture(&format!("http://{}/v1",listener.local_addr().unwrap())).await;
        let session = f.create("Revocable Goal").await;
        let mut stale = approval(&f,&session).await;
        stale["target"]["boundaryRevision"] = json!(99);
        let rejected = f.mutation(2,"changeGoal",json!({"kind":"create","sessionId":session,"objective":"Stale boundary","start":true,"tokenBudget":null,"approval":stale}),Uuid::new_v4()).await.unwrap();
        assert_eq!(rejected["kind"],"rejected");
        assert!(current(&f,&session).await.is_null());
        let mut foreign_binding = approval(&f, &session).await;
        foreign_binding["target"]["binding"]["id"] = json!(Uuid::new_v4());
        let rejected = f.mutation(2, "changeGoal", json!({
            "kind":"create", "sessionId":session, "objective":"Same values, foreign binding",
            "start":true, "tokenBudget":null, "approval":foreign_binding
        }), Uuid::new_v4()).await.unwrap();
        assert_eq!(rejected["kind"], "rejected");
        assert!(current(&f, &session).await.is_null());
        assert_eq!(create(&f,&session,false,None).await["kind"],"committed");
        f.app.shutdown().await.unwrap();
        let storage = Arc::new(maka_host_runtime::storage::Storage::new(f.store.clone(),f.owner.prefix.clone(),Namespace::new("maka.agent.goal",maka_plugin_core::scope::Scope::Profile).unwrap()));
        let repo: Repository<crate::owner::notifications::BackgroundApproval> = Repository::new(storage.clone());
        let mut saved = repo.read(&session).await.unwrap().unwrap();
        saved.goal.control(Control::Resume).unwrap();
        saved.goal.reserve().unwrap();
        repo.save(saved).await.unwrap();
        f.store.set_session_archived::<StoredSessionConfiguration>(&session,true,now()).await.unwrap();
        todo_tests::reopen(&mut f).await;
        let paused = wait_status(&f,&session,"paused").await;
        assert_eq!(paused["iterations"],1);
        assert!(service_tools::facts(&f,&session).await.is_empty());
        assert!(tokio::time::timeout(Duration::from_millis(100),listener.accept()).await.is_err());
        f.app.shutdown().await.unwrap();
        storage.finish().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn goal_original_run_recovers_once_and_managed_stop_requires_a_new_iteration() {
    tokio::time::timeout(Duration::from_secs(90), async {
        for action in ["automatic", "resume", "cancel", "route_changed"] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
            let session = f.create("Goal original continuation").await;
            let (entered, preparing) = tokio::sync::oneshot::channel();
            let (release, released) = tokio::sync::oneshot::channel();
            *f.owner.continuation_preparation.lock().unwrap() = Some(Box::pin(async move {
                entered.send(()).expect("original preparation observer");
                released.await.map_err(|error| RunError::Internal(error.to_string()))?;
                Err(RunError::Cancelled)
            }));
            create(&f, &session, true, None).await;
            let (mut first, _) = listener.accept().await.unwrap();
            request(&mut first).await;
            let original = f.latest_run(&session).await;
            report(&mut first, false, "progress").await;
            preparing.await.unwrap();
            if action != "automatic" {
                assert_eq!(control(&f, &session, "pause").await["kind"], "committed");
                let mut commits = f.store.subscribe_changes();
                loop {
                    commits.borrow_and_update();
                    if f.owner.durable.frontier(original.run).await.unwrap().stopped { break; }
                    commits.changed().await.unwrap();
                }
            }
            f.owner.stop.cancel();
            release.send(()).unwrap();
            todo_tests::reopen(&mut f).await;
            if action != "automatic" {
                let paused = wait_status(&f, &session, "paused").await;
                assert_eq!(paused["iterations"], 1);
                let stopped = f.owner.durable.frontier(original.run).await.unwrap();
                assert!(stopped.stopped);
                assert!(stopped.terminal.is_some());
                assert_eq!(stopped.spec, original.spec);
            }
            if action == "route_changed" {
                let replacement = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let replacement_base = format!("http://{}/v1", replacement.local_addr().unwrap());
                selection::edit(&f, |changes| {
                    changes.configuration = Some(json!({"baseUrl":replacement_base}));
                    changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride { max_output_tokens: Some(200), ..Default::default() })]));
                }).await;
                assert_eq!(control(&f, &session, "resume").await["kind"], "committed");
                let paused = wait_status(&f, &session, "paused").await;
                assert_eq!(paused["iterations"], 1);
                assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err());
                assert!(tokio::time::timeout(Duration::from_millis(100), replacement.accept()).await.is_err());
                assert_eq!(f.mutation(2, "changeGoal", json!({"kind":"control", "sessionId":session, "goalId":paused["id"], "revision":paused["revision"], "action":"resume", "approval":approval(&f,&session).await}), Uuid::new_v4()).await.unwrap()["kind"], "committed");
                let (mut resumed, _) = replacement.accept().await.unwrap();
                let sent = request(&mut resumed).await;
                assert_eq!(sent["max_tokens"], 200);
                report(&mut resumed, false, "achieved").await;
                let (mut final_answer, _) = replacement.accept().await.unwrap();
                request(&mut final_answer).await;
                response(&mut final_answer).await;
                let done = wait_status(&f, &session, "achieved").await;
                assert_eq!(done["id"], paused["id"]);
                assert_eq!(done["iterations"], 2);
                f.app.shutdown().await.unwrap();
                continue;
            }
            if action != "automatic" {
                assert_eq!(control(&f, &session, action).await["kind"], "committed");
            }
            if action == "cancel" {
                wait_status(&f, &session, "cancelled").await;
                assert_eq!(f.send(&session).await.unwrap()["kind"], "queued");
                let (mut ordinary, _) = listener.accept().await.unwrap();
                request(&mut ordinary).await;
                response(&mut ordinary).await;
                f.drained().await;
            } else {
                let (mut successor, _) = listener.accept().await.unwrap();
                let sent = request(&mut successor).await;
                assert!(
                    sent["messages"]
                        .to_string()
                        .contains("Verified checkpoint progress")
                );
                report(&mut successor, false, "achieved").await;
                let (mut final_answer, _) = listener.accept().await.unwrap();
                request(&mut final_answer).await;
                response(&mut final_answer).await;
                let done = wait_status(&f, &session, "achieved").await;
                assert_eq!(done["iterations"], if action == "automatic" { 1 } else { 2 });
                let latest = f.latest_run(&session).await;
                if action == "automatic" {
                    assert_eq!(latest.run, original.run);
                    assert_eq!(latest.spec, original.spec);
                } else {
                    assert_ne!(latest.run, original.run);
                    assert!(f.owner.durable.frontier(original.run).await.unwrap().stopped);
                }
                let facts = service_tools::facts(&f, &session).await;
                assert_eq!(
                    facts
                        .iter()
                        .filter(|fact| matches!(fact, Fact::RunAdmitted { .. }))
                        .count(),
                    if action == "automatic" { 1 } else { 2 }
                );
            }
            f.app.shutdown().await.unwrap();
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn goal_default_edits_keep_approved_settings_and_new_messages_use_new_defaults() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let session = f.create("Goal settings change").await;
        create(&f, &session, true, None).await;
        let original = current(&f, &session).await;
        let (mut first, _) = listener.accept().await.unwrap();
        let approved_request = request(&mut first).await;
        selection::edit(&f, |changes| {
            changes.model_overrides = Patch::Set(BTreeMap::from([(
                "fixture-model".into(),
                ModelOverride {
                    max_output_tokens: Some(200),
                    ..Default::default()
                },
            )]));
        })
        .await;
        response(&mut first).await;
        let (mut continued, _) = listener.accept().await.unwrap();
        let sent = request(&mut continued).await;
        assert_eq!(
            sent["max_tokens"], approved_request["max_tokens"],
            "continuation uses its original approved settings"
        );
        assert_ne!(
            sent["max_tokens"], 200,
            "new defaults are not silently adopted by the Goal grant"
        );
        report(&mut continued, false, "achieved").await;
        let (mut final_answer, _) = listener.accept().await.unwrap();
        request(&mut final_answer).await;
        response(&mut final_answer).await;
        let done = wait_status(&f, &session, "achieved").await;
        assert_eq!(done["id"], original["id"]);
        assert_eq!(done["iterations"], 2);
        assert_eq!(f.send(&session).await.unwrap()["kind"], "queued");
        let (mut ordinary, _) = listener.accept().await.unwrap();
        assert_eq!(request(&mut ordinary).await["max_tokens"], 200);
        response(&mut ordinary).await;
        f.drained().await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn a_completed_reserved_goal_releases_its_outbox_and_can_be_replaced() {
    use maka_goal::goal::{Control, Repository};
    use maka_plugin_core::storage::Namespace;
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let session = f.create("Goal completed before dispatch").await;
        create(&f, &session, false, None).await;
        f.app.shutdown().await.unwrap();
        let storage = Arc::new(maka_host_runtime::storage::Storage::new(
            f.store.clone(),
            f.owner.prefix.clone(),
            Namespace::new("maka.agent.goal", maka_plugin_core::scope::Scope::Profile).unwrap(),
        ));
        let repo: Repository<crate::owner::notifications::BackgroundApproval> =
            Repository::new(storage.clone());
        let mut saved = repo.read(&session).await.unwrap().unwrap();
        saved.goal.control(Control::Resume).unwrap();
        saved.goal.reserve().unwrap();
        saved.goal.control(Control::Complete).unwrap();
        repo.save(saved).await.unwrap();
        todo_tests::reopen(&mut f).await;
        wait_status(&f, &session, "achieved").await;
        assert_eq!(
            create(&f, &session, true, Some(3)).await["kind"],
            "committed"
        );
        let (mut next, _) = listener.accept().await.unwrap();
        request(&mut next).await;
        response(&mut next).await;
        assert_eq!(
            wait_status(&f, &session, "budget_limited").await["iterations"],
            1
        );
        f.app.shutdown().await.unwrap();
        storage.finish().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn provider_quota_deadlines_hold_continuation_until_a_different_model_is_selected() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let session = f.create("Wait for model quota").await;
        create(&f, &session, true, None).await;
        let (mut first, _) = listener.accept().await.unwrap();
        request(&mut first).await;
        let body = json!({"error":{"message":"Quota exhausted","type":"insufficient_quota","code":"insufficient_quota"}}).to_string();
        first.write_all(format!("HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Length: {}\r\nRetry-After: 3600\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        first.shutdown().await.unwrap();
        let waiting = loop {
            let goal = current(&f, &session).await;
            if goal["retryAt"].is_number() && goal["pending"] == false { break goal; }
            tokio::task::yield_now().await;
        };
        assert_eq!(waiting["status"], "active");
        assert_eq!(waiting["iterations"], 1);
        assert_eq!(control(&f, &session, "pause").await["kind"], "committed");
        let paused = current(&f, &session).await;
        selection::edit(&f, |changes| { changes.enabled_model_ids = Some(vec!["fixture-model".into(), "fallback-model".into()]); }).await;
        let mut granted = approval(&f, &session).await;
        granted["model"]["modelId"] = json!("fallback-model");
        assert_eq!(f.mutation(2, "changeGoal", json!({"kind":"control","sessionId":session,"goalId":paused["id"],"revision":paused["revision"],"action":"resume","approval":granted}), Uuid::new_v4()).await.unwrap()["kind"], "committed");
        let (mut fallback, _) = listener.accept().await.unwrap();
        let sent = request(&mut fallback).await;
        assert_eq!(sent["model"], "fallback-model");
        report(&mut fallback, false, "achieved").await;
        let (mut final_answer, _) = listener.accept().await.unwrap();
        request(&mut final_answer).await; response(&mut final_answer).await;
        assert_eq!(wait_status(&f, &session, "achieved").await["id"], waiting["id"]);
        f.app.shutdown().await.unwrap();
    }).await.unwrap();
}
