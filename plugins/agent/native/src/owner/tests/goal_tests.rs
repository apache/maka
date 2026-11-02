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
use maka_agent_facts::event::{Fact, InvocationOutcome, ToolOutcome};

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
            let facts = service_tools::facts(&f, &session).await;
            assert_eq!(facts.iter().filter(|fact| matches!(fact, Fact::InvocationOpened { .. })).count(), 2);
            assert_eq!(facts.iter().filter(|fact| matches!(fact, Fact::ToolDispatched { name, .. } if name == "GoalStatus")).count(), 2);
            assert!(facts.iter().any(|fact| matches!(fact, Fact::ToolSettled { outcome: ToolOutcome::Succeeded { .. }, .. })));
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
        assert_eq!(f.send(&sibling).await.unwrap()["kind"], "started");
        assert!(f.owner.runs.lock().await.controls.contains_key(&sibling));
        assert_eq!(control(&f, &session, "cancel").await["kind"], "committed");
        let mut byte = [0];
        assert_eq!(
            goal_run.read(&mut byte).await.unwrap(),
            0,
            "the original model connection is physically cancelled"
        );
        let cancelled = wait_status(&f, &session, "cancelled").await;
        assert_eq!(cancelled["iterations"], 2);
        assert!(f.owner.runs.lock().await.controls.contains_key(&sibling));
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
                    Fact::InvocationEnded {
                        outcome: InvocationOutcome::Cancelled { .. }
                    }
                ))
        );
        assert!(
            service_tools::facts(&f, &sibling)
                .await
                .iter()
                .any(|fact| matches!(
                    fact,
                    Fact::InvocationEnded {
                        outcome: InvocationOutcome::Completed
                    }
                ))
        );
        f.app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn goal_incomplete_usage_continues_and_a_raised_budget_resumes_the_same_goal() {
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
        let (mut second, _) = listener.accept().await.unwrap();
        request(&mut second).await; response(&mut second).await;
        let limited = wait_status(&f, &session, "budget_limited").await;
        assert_eq!(limited["consumed"]["known"], 6);
        assert_eq!(limited["remainingTokens"], Value::Null);
        assert_eq!(limited["iterations"], 2);
        assert_eq!(f.mutation(2, "changeGoal", json!({"kind":"control","sessionId":session,"goalId":limited["id"],"revision":limited["revision"],"action":"resume","budget":{"tokenBudget":9}}), Uuid::new_v4()).await.unwrap()["kind"], "committed");
        let (mut third, _) = listener.accept().await.unwrap();
        request(&mut third).await; response(&mut third).await;
        let finished = wait_status(&f, &session, "budget_limited").await;
        assert_eq!(finished["id"], limited["id"]);
        assert_eq!(finished["iterations"], 3);
        assert_eq!(finished["consumed"]["known"], 9);
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
    use maka_capabilities::storage::Namespace;
    use maka_goal::goal::{Control, Repository};
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
        let repo: Repository<MessageBasis> = Repository::new(storage.clone());
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
        assert_eq!(service_tools::facts(&f,&session).await.iter().filter(|fact| matches!(fact,Fact::InvocationOpened { .. })).count(),1);
        assert!(tokio::time::timeout(Duration::from_millis(100),listener.accept()).await.is_err());
        assert_eq!(f.query("goalReceipt",json!({"reference":reference})).await.unwrap(),committed);
        f.app.shutdown().await.unwrap();
        storage.finish().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn goal_rechecks_privacy_and_revoked_session_before_original_outbox_admission() {
    use maka_capabilities::storage::Namespace;
    use maka_goal::goal::{Control, Repository};
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
        let policy = f.config.runtime_policy().await.unwrap();
        f.config.set_privacy(policy.revision,maka_agent_facts::configuration::policy::PrivacyPolicy{incognito_active:true}).await.unwrap();
        assert_eq!(create(&f,&session,true,None).await["reason"],"goal_incognito");
        assert!(current(&f,&session).await.is_null());
        let policy = f.config.runtime_policy().await.unwrap();
        f.config.set_privacy(policy.revision,maka_agent_facts::configuration::policy::PrivacyPolicy{incognito_active:false}).await.unwrap();
        assert_eq!(create(&f,&session,false,None).await["kind"],"committed");
        f.app.shutdown().await.unwrap();
        let storage = Arc::new(maka_host_runtime::storage::Storage::new(f.store.clone(),f.owner.prefix.clone(),Namespace::new("maka.agent.goal",maka_plugin_core::scope::Scope::Profile).unwrap()));
        let repo: Repository<MessageBasis> = Repository::new(storage.clone());
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
async fn goal_sealed_handoff_recovers_once_and_cancel_releases_the_session() {
    use maka_agent_facts::handoff::HandoffIntent;
    use maka_goal::goal::Control;
    tokio::time::timeout(Duration::from_secs(90), async {
        for action in ["automatic", "resume", "cancel", "settings_changed"] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
            let session = f.create("Handoff Goal").await;
            create(&f, &session, true, None).await;
            let (mut first, _) = listener.accept().await.unwrap();
            request(&mut first).await;
            let original_control = f
                .owner
                .runs
                .lock()
                .await
                .controls
                .get(&session)
                .unwrap()
                .clone();
            let reservation = original_control
                .handoff
                .as_ref()
                .unwrap()
                .reserve(HandoffIntent {
                    handoff_id: "goal-transfer".into(),
                    host_epoch: "test-host".into(),
                    root_run_id: original_control.invocation.run_id.clone(),
                    successor_run_id: "goal-successor-run".into(),
                    successor_invocation_id: "goal-successor-invocation".into(),
                    claim_id: "goal-transfer-claim".into(),
                })
                .unwrap();
            report(&mut first, false, "progress").await;
            let held = reservation.ready().await.unwrap();
            let owner = f.owner.clone();
            let gate = owner.goals.gate.lock().await;
            held.commit().unwrap().wait().await.unwrap();
            let mut saved = owner
                .goals
                .repository
                .read(&session)
                .await
                .unwrap()
                .unwrap();
            if action != "automatic" {
                saved.goal.control(Control::Pause).unwrap();
            }
            owner.goals.repository.save(saved).await.unwrap();
            owner.stop.cancel();
            drop(gate);
            todo_tests::reopen(&mut f).await;
            if action == "settings_changed" {
                selection::edit(&f, |changes| {
                    changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride { max_output_tokens: Some(200), ..Default::default() })]));
                }).await;
                assert_eq!(control(&f, &session, "resume").await["kind"], "committed");
                let paused = wait_status(&f, &session, "paused").await;
                assert_eq!(paused["iterations"], 1);
                assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err());
                assert_eq!(f.mutation(2, "changeGoal", json!({"kind":"control", "sessionId":session, "goalId":paused["id"], "revision":paused["revision"], "action":"resume", "approval":approval(&f,&session).await}), Uuid::new_v4()).await.unwrap()["kind"], "committed");
                let (mut resumed, _) = listener.accept().await.unwrap();
                let sent = request(&mut resumed).await;
                assert_eq!(sent["max_tokens"], 200);
                report(&mut resumed, false, "achieved").await;
                let (mut final_answer, _) = listener.accept().await.unwrap();
                request(&mut final_answer).await;
                response(&mut final_answer).await;
                let done = wait_status(&f, &session, "achieved").await;
                assert_eq!(done["id"], paused["id"]);
                assert_eq!(done["iterations"], 2);
                f.app.shutdown().await.unwrap();
                continue;
            }
            if action != "automatic" {
                assert_eq!(current(&f, &session).await["status"], "paused");
                assert_eq!(control(&f, &session, action).await["kind"], "committed");
            }
            if action == "cancel" {
                wait_status(&f, &session, "cancelled").await;
                assert_eq!(f.send(&session).await.unwrap()["kind"], "started");
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
                assert_eq!(done["iterations"], 1);
                let facts = service_tools::facts(&f, &session).await;
                assert_eq!(
                    facts
                        .iter()
                        .filter(|fact| matches!(fact, Fact::InvocationOpened { .. }))
                        .count(),
                    2
                );
            }
            f.app.shutdown().await.unwrap();
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn changed_goal_model_settings_wait_for_reapproval_instead_of_retrying_the_old_basis() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let session = f.create("Goal settings change").await;
        create(&f, &session, true, None).await;
        let (mut first, _) = listener.accept().await.unwrap();
        request(&mut first).await;
        selection::edit(&f, |changes| {
            changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride { max_output_tokens: Some(200), ..Default::default() })]));
        }).await;
        response(&mut first).await;
        let paused = wait_status(&f, &session, "paused").await;
        assert_eq!(paused["iterations"], 2);
        assert_eq!(f.mutation(2, "changeGoal", json!({"kind":"control","sessionId":session,"goalId":paused["id"],"revision":paused["revision"],"action":"resume","approval":approval(&f,&session).await}), Uuid::new_v4()).await.unwrap()["kind"], "committed");
        let (mut resumed, _) = listener.accept().await.unwrap();
        let sent = request(&mut resumed).await;
        assert_eq!(sent["max_tokens"], 200);
        report(&mut resumed, false, "achieved").await;
        let (mut final_answer, _) = listener.accept().await.unwrap();
        request(&mut final_answer).await; response(&mut final_answer).await;
        let done = wait_status(&f, &session, "achieved").await;
        assert_eq!(done["id"], paused["id"]);
        f.app.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn a_completed_reserved_goal_releases_its_outbox_and_can_be_replaced() {
    use maka_capabilities::storage::Namespace;
    use maka_goal::goal::{Control, Repository};
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
        let repo: Repository<MessageBasis> = Repository::new(storage.clone());
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

#[test]
fn persisted_goals_upgrade_without_losing_the_original_execution_or_checkpoint() {
    use maka_goal::goal::{Control, Goal, Meter, Pending, Status};
    use serde_json::json;
    let db = rusqlite::Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE plugin_data(package_id TEXT, scope_id TEXT, key TEXT, revision INTEGER, value_json TEXT);").unwrap();
    for (state, report_status, expected) in [
        ("active", "progress", Status::Active),
        ("active", "achieved", Status::Achieved),
        ("active", "waiting", Status::Blocked),
        ("active", "impossible", Status::Blocked),
        ("paused", "achieved", Status::Paused),
        ("budget_unknown", "progress", Status::Paused),
    ] {
        let legacy = json!({
            "id":"d638a182-a505-4d95-aeb5-057b859d3952", "sessionId":"session",
            "arm":{"operationId":"d638a182-a505-4d95-aeb5-057b859d3952", "objective":"修复问题\n验证结果", "grant":{"model":"accepted-model"}, "maxIterations":1, "tokenBudget":100, "start":true},
            "status":state, "iterations":1, "baseline":{"known":0,"missing":0}, "consumed":{"known":3,"missing":1},
            "pending":if state == "active" { json!({"dispatched":true, "request":{"operationId":"goal-original-1", "sessionId":"session", "content":{"text":"original frozen request","displayText":null}}}) } else { serde_json::Value::Null },
            "lastOperationId":null,"report":{"status":report_status,"note":"First checkpoint"}, "note":"First checkpoint", "authorityBlocked":false
        });
        db.execute("DELETE FROM plugin_data", []).unwrap();
        db.execute(
            "INSERT INTO plugin_data VALUES('maka.agent.goal','profile','session/key',7,?1)",
            [legacy.to_string()],
        )
        .unwrap();
        let receipt = json!({"session":"session","arm":legacy["arm"]});
        db.execute(
            "INSERT INTO plugin_data VALUES('maka.agent.goal','profile','arm/original',3,?1)",
            [receipt.to_string()],
        )
        .unwrap();
        db.execute_batch(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../platform/event-log/migrations/0015_goal_progress.sql"
        )))
        .unwrap();
        let value: String = db
            .query_row(
                "SELECT value_json FROM plugin_data WHERE key LIKE 'session/%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let unchanged: String = db
            .query_row(
                "SELECT value_json FROM plugin_data WHERE key='arm/original'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&unchanged).unwrap(), receipt);
        let mut goal: Goal<serde_json::Value> = serde_json::from_str(&value).unwrap();
        assert_eq!(goal.arm.objective, "修复问题\n验证结果");
        assert_eq!(goal.arm.grant, json!({"model":"accepted-model"}));
        assert_eq!(goal.note, "First checkpoint");
        assert_eq!(goal.status, expected);
        if state == "active" {
            let Some(Pending::Dispatch {
                request,
                dispatched,
            }) = &goal.pending
            else {
                panic!("original dispatch was lost")
            };
            assert_eq!(request.operation_id, "goal-original-1");
            assert!(*dispatched);
        }
        if expected == Status::Paused {
            goal.control(Control::Resume).unwrap();
        }
        goal.settled(
            maka_agent_facts::event::InvocationOutcome::Completed,
            Ok(Meter {
                known: 6,
                missing: 1,
            }),
        );
        if matches!(expected, Status::Active | Status::Paused) {
            assert!(goal.reserve().unwrap());
            assert_eq!(goal.iterations, 2);
            assert_eq!(goal.status, Status::Active);
        } else {
            assert_eq!(
                goal.status, expected,
                "settlement must retain the original completion or blocked report"
            );
            assert!(goal.pending.is_none());
        }
    }
}
