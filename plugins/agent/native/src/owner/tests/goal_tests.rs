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
    loop {
        let value = current(f, session).await;
        if value["status"] == status && value["pending"] == false {
            return value;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
async fn approval(f: &Fixture, session: &str) -> Value {
    let config = f.owner.session(session).await.unwrap().configuration;
    json!({"target":{"sessionId":session,"workspace":config.workspace,"permissions":config.permissions,"boundaryRevision":config.boundary_revision,"binding":config.binding},"model":f.selection().await,"thinkingLevel":null})
}
async fn create(
    f: &Fixture,
    session: &str,
    start: bool,
    iterations: u32,
    budget: Option<u64>,
) -> Value {
    f.mutation(2, "changeGoal", json!({"kind":"create","sessionId":session,"objective":"Verify the original native Goal 中😀","start":start,"maxIterations":iterations,"tokenBudget":budget,"approval":approval(f,session).await}), Uuid::new_v4()).await.unwrap()
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
            assert_eq!(create(&f, &session, true, 3, None).await["kind"], "committed");
            let (mut first, _) = listener.accept().await.unwrap();
            let sent = request(&mut first).await;
            let names: Vec<_> = sent["tools"].as_array().unwrap().iter().filter_map(|tool| tool["function"]["name"].as_str()).collect();
            assert!(names.contains(&if code { "exec" } else { "GoalStatus" }), "{names:?}");
            assert!(!f.app.shutdown_if_idle().await.unwrap(), "an active Goal keeps the original Host alive");
            report(&mut first, code, "progress").await;
            let (mut finish, _) = listener.accept().await.unwrap();
            let result = request(&mut finish).await;
            assert!(result["messages"].to_string().contains("recorded"), "{result}");
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
            assert_eq!(current(&f, &session).await["status"], "active", "model claims do not settle an unfinished iteration");
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
        assert_eq!(
            create(&f, &session, true, 5, None).await["kind"],
            "committed"
        );
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
async fn goal_usage_threshold_missing_counters_and_iteration_limit_stop_real_continuations() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        for (name, budget, report_missing, expected) in [
            ("Known budget", Some(3), false, "budget_limited"),
            ("Unknown budget", Some(100_000), true, "budget_unknown"),
            ("Bounded iterations", None, false, "max_iterations"),
        ] {
            let session = f.create(name).await;
            assert_eq!(
                create(&f, &session, true, 1, budget).await["kind"],
                "committed"
            );
            let (mut socket, _) = listener.accept().await.unwrap();
            request(&mut socket).await;
            if report_missing {
                report(&mut socket, false, "progress").await;
                let (mut next, _) = listener.accept().await.unwrap();
                request(&mut next).await;
                response(&mut next).await;
            } else {
                response(&mut socket).await;
            }
            let stopped = wait_status(&f, &session, expected).await;
            assert_eq!(stopped["iterations"], 1);
            assert_eq!(stopped["consumed"]["known"], 3);
            assert!(
                tokio::time::timeout(Duration::from_millis(100), listener.accept())
                    .await
                    .is_err()
            );
        }
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
        let input = json!({"kind":"create","sessionId":session,"objective":"Preserve this original approval 中😀","start":false,"maxIterations":1,"tokenBudget":3,"approval":approval(&f,&session).await});
        let client = f.app.client();
        let prepared = client.prepare_mutation(f.binding(2).await, "changeGoal".into(), input.clone(), scope(&f.issuer,true), Uuid::new_v4(), Attachments::new().into()).await.unwrap();
        let reference = prepared.reference().clone();
        f.store.record_application_intent(reference.source.clone(), prepared.consumer().instance().clone(), reference.clone(), Value::Null).await.unwrap();
        // Commit the business transaction without delivering its reply to Host.
        let committed = f.owner.goal_change(serde_json::from_value(input).unwrap(), reference.clone(), &scope(&f.issuer,true)).await.unwrap();
        let committed = serde_json::to_value(committed).unwrap();
        assert_eq!(committed["kind"], "committed");
        let armed = current(&f,&session).await;
        todo_tests::reopen(&mut f).await;
        assert_eq!(current(&f,&session).await,armed);
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
        let rejected = f.mutation(2,"changeGoal",json!({"kind":"create","sessionId":session,"objective":"Stale boundary","start":true,"maxIterations":2,"tokenBudget":null,"approval":stale}),Uuid::new_v4()).await.unwrap();
        assert_eq!(rejected["kind"],"rejected");
        assert!(current(&f,&session).await.is_null());
        let mut foreign_binding = approval(&f, &session).await;
        foreign_binding["target"]["binding"]["id"] = json!(Uuid::new_v4());
        let rejected = f.mutation(2, "changeGoal", json!({
            "kind":"create", "sessionId":session, "objective":"Same values, foreign binding",
            "start":true, "maxIterations":2, "tokenBudget":null, "approval":foreign_binding
        }), Uuid::new_v4()).await.unwrap();
        assert_eq!(rejected["kind"], "rejected");
        assert!(current(&f, &session).await.is_null());
        let policy = f.config.runtime_policy().await.unwrap();
        f.config.set_privacy(policy.revision,maka_agent_facts::configuration::policy::PrivacyPolicy{incognito_active:true}).await.unwrap();
        assert_eq!(create(&f,&session,true,2,None).await["reason"],"goal_incognito");
        assert!(current(&f,&session).await.is_null());
        let policy = f.config.runtime_policy().await.unwrap();
        f.config.set_privacy(policy.revision,maka_agent_facts::configuration::policy::PrivacyPolicy{incognito_active:false}).await.unwrap();
        assert_eq!(create(&f,&session,false,2,None).await["kind"],"committed");
        f.app.shutdown().await.unwrap();
        let storage = Arc::new(maka_host_runtime::storage::Storage::new(f.store.clone(),f.owner.prefix.clone(),Namespace::new("maka.agent.goal",maka_plugin_core::scope::Scope::Profile).unwrap()));
        let repo: Repository<MessageBasis> = Repository::new(storage.clone());
        let mut saved = repo.read(&session).await.unwrap().unwrap();
        saved.goal.control(Control::Resume).unwrap();
        saved.goal.reserve().unwrap();
        repo.save(saved).await.unwrap();
        f.store.set_session_archived::<StoredSessionConfiguration>(&session,true,now()).await.unwrap();
        todo_tests::reopen(&mut f).await;
        let blocked = wait_status(&f,&session,"blocked").await;
        assert_eq!(blocked["iterations"],1);
        assert!(service_tools::facts(&f,&session).await.is_empty());
        assert!(tokio::time::timeout(Duration::from_millis(100),listener.accept()).await.is_err());
        f.app.shutdown().await.unwrap();
        storage.finish().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn goal_prepared_report_cannot_override_a_newer_user_pause() {
    use maka_agent_facts::{
        tool_call::ToolCallIdentity,
        tools::{ToolCallContext, ToolJournal, ToolPreparer},
    };
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&format!("http://{}/v1",listener.local_addr().unwrap())).await;
        let session = f.create("User controls Goal").await;
        assert_eq!(create(&f,&session,true,2,None).await["kind"],"committed");
        let (mut socket,_) = listener.accept().await.unwrap();
        request(&mut socket).await;
        let invocation = f.owner.runs.lock().await.controls.get(&session).unwrap().invocation.clone();
        let scope = f.session(&session).await.execution_scope(Some(f.owner.session(&session).await.unwrap().configuration.permission_basis())).await.unwrap();
        let execution_store = Arc::new(scope.store());
        let input = json!({"status":"achieved","note":"A prepared report cannot overrule later user intent"});
        let pending = f.owner.goals.prepare("GoalStatus".into(),input.clone(),ToolCallContext{invocation:invocation.clone(),operation_id:"late-report".into(),execution:Some(execution_store.execution_custody().unwrap())},CancellationToken::new()).await.unwrap();
        assert_eq!(control(&f,&session,"pause").await["kind"],"committed");
        assert!(ToolJournal::new(execution_store,invocation).invoke_prepared_call("late-report".into(),ToolCallIdentity::standalone("late-report".into()),"GoalStatus".into(),input,None,CancellationToken::new(),pending).await.is_err());
        response(&mut socket).await;
        let paused = wait_status(&f,&session,"paused").await;
        drop(scope);
        assert!(paused["report"].is_null());
        assert_eq!(paused["iterations"],1);
        assert!(tokio::time::timeout(Duration::from_millis(100),listener.accept()).await.is_err());
        f.app.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn goal_cancelled_before_dispatch_never_calls_the_model() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let session = f.create("Cancel accepted Goal queue").await;
        let producer = f.owner.producer_gate.lock().await;
        assert_eq!(
            create(&f, &session, true, 2, None).await["kind"],
            "committed"
        );
        assert_eq!(control(&f, &session, "cancel").await["kind"], "committed");
        drop(producer);
        wait_status(&f, &session, "cancelled").await;
        assert!(
            f.session(&session)
                .await
                .message_queue(&session)
                .await
                .unwrap()
                .entries
                .is_empty()
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
        let facts = service_tools::facts(&f, &session).await;
        assert_eq!(
            facts
                .iter()
                .filter(|fact| matches!(fact, Fact::InvocationOpened { .. }))
                .count(),
            0
        );
        assert!(!facts.iter().any(|fact| matches!(
            fact,
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed
            }
        )));
        f.app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn goal_language_stays_approved_until_an_idle_resume_renews_both_captures() {
    fn system(request: &Value) -> String {
        request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "system")
            .map(|message| message["content"].as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n")
    }
    fn user(request: &Value) -> &str {
        request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|message| message["role"] == "user")
            .unwrap()["content"]
            .as_str()
            .unwrap()
    }
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let home = tempfile::tempdir().unwrap();
        let f = Fixture::configured(&format!("http://{}/v1", listener.local_addr().unwrap()), None, None, None, |settings| {
            settings.goals = true;
            settings.tool_discovery = true;
            settings.assistant = Some(contract::AssistantConfiguration { home: Some(home.path().to_str().unwrap().into()) });
        }).await;
        let session = f.create("Goal language authority").await;
        let english = prompt_language::select_language(&f, "en").await;
        let objective = "GOAL_ORIGINAL_🦀 原样数据 \\\"quoted\\\" must survive every approval";
        let input = json!({"kind":"create","sessionId":session,"objective":objective,"start":true,"maxIterations":8,"tokenBudget":null,"approval":approval(&f,&session).await});
        let operation = Uuid::new_v4();
        let created = f.mutation(2, "changeGoal", input.clone(), operation).await.unwrap();
        let mut watch = f.app.client().subscribe(f.binding(2).await, "watchGoal".into(), json!({"sessionId":session}),
            scope(&f.issuer, true), Attachments::new().into()).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let first = request(&mut socket).await;
        let first_invocation = f.session(&session).await.latest_turn_boundary(&session).await.unwrap().unwrap().invocation;
        let first_configuration = f.session(&(first_invocation).session_id).await.invocation_configuration(&first_invocation).await.unwrap().unwrap();
        let accepted = session_context::composition(&f, &session).await;
        let chinese = prompt_language::select_language(&f, "zh-CN").await;
        let pending = current(&f, &session).await;
        let retried = f.mutation(2, "changeGoal", input, operation).await.unwrap();
        let after_retry = current(&f, &session).await;
        report(&mut socket, false, "progress").await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let followup = request(&mut socket).await;
        response(&mut socket).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let original_chain = request(&mut socket).await;
        let chain_invocation = f.session(&session).await.latest_turn_boundary(&session).await.unwrap().unwrap().invocation;
        let chain_configuration = f.session(&(chain_invocation).session_id).await.invocation_configuration(&chain_invocation).await.unwrap().unwrap();
        let paused = control(&f, &session, "pause").await;
        response(&mut socket).await;
        let idle_english = loop {
            let observed = watch.recv().await.unwrap();
            if observed["current"]["status"] == "paused" && observed["current"]["pending"] == false {
                break observed["current"].clone();
            }
        };
        let renewed_cn = f.mutation(2, "changeGoal", json!({"kind":"control","sessionId":session,"goalId":idle_english["id"],"revision":idle_english["revision"],"action":"resume","approval":approval(&f,&session).await}), Uuid::new_v4()).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let cn_request = request(&mut socket).await;
        let cn_invocation = f.session(&session).await.latest_turn_boundary(&session).await.unwrap().unwrap().invocation;
        let cn_configuration = f.session(&(cn_invocation).session_id).await.invocation_configuration(&cn_invocation).await.unwrap().unwrap();
        let paused_cn = control(&f, &session, "pause").await;
        response(&mut socket).await;
        let idle_cn = loop {
            let observed = watch.recv().await.unwrap();
            if observed["current"]["status"] == "paused" && observed["current"]["pending"] == false {
                break observed["current"].clone();
            }
        };
        let traditional = prompt_language::select_language(&f, "zh-TW").await;
        let renewed_tw = f.mutation(2, "changeGoal", json!({"kind":"control","sessionId":session,"goalId":idle_cn["id"],"revision":idle_cn["revision"],"action":"resume","approval":approval(&f,&session).await}), Uuid::new_v4()).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let tw_request = request(&mut socket).await;
        let tw_invocation = f.session(&session).await.latest_turn_boundary(&session).await.unwrap().unwrap().invocation;
        let tw_configuration = f.session(&(tw_invocation).session_id).await.invocation_configuration(&tw_invocation).await.unwrap().unwrap();
        let paused_tw = control(&f, &session, "pause").await;
        response(&mut socket).await;
        let idle_tw = loop {
            let observed = watch.recv().await.unwrap();
            if observed["current"]["status"] == "paused" && observed["current"]["pending"] == false {
                break observed["current"].clone();
            }
        };
        let completed = control(&f, &session, "complete").await;
        drop(watch);
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();

        for receipt in [english, chinese, traditional, created.clone(), paused, renewed_cn, paused_cn, renewed_tw, paused_tw, completed] {
            assert_eq!(receipt["kind"], "committed", "{receipt}");
        }
        assert_eq!(retried, created, "retrying accepted Goal approval returns its exact original receipt");
        assert_eq!(pending["pending"], true);
        assert_eq!(after_retry, pending, "pending operation retry must not replace the approved Goal");
        assert_eq!(user(&followup), user(&first), "the accepted iteration retains exact input after the setting changes");
        assert!(system(&followup).contains(accepted.system_prompt.as_deref().unwrap()));
        for request in [&first, &followup, &original_chain] {
            assert!(system(request).contains(accepted.system_prompt.as_deref().unwrap()));
            assert!(user(request).contains(objective));
            assert!(user(request).contains("iteration"), "the approved English Arm keeps rendering English iterations: {request}");
        }
        assert_eq!(serde_json::to_value(first_configuration.language).unwrap(), "en");
        assert_eq!(serde_json::to_value(chain_configuration.language).unwrap(), "en");
        for (request, configuration, tag) in [
            (&cn_request, &cn_configuration, "zh-CN"),
            (&tw_request, &tw_configuration, "zh-TW"),
        ] {
            assert!(system(request).contains(&configuration.system_prompt.as_ref().unwrap().text), "renewed captured guidance reaches the actual request: {request}");
            assert!(user(request).contains("迭代"), "renewed Arm language reaches actual iteration input: {request}");
            assert!(user(request).contains(objective));
            assert_eq!(serde_json::to_value(configuration.language).unwrap(), tag);
        }
        for idle in [idle_english, idle_cn, idle_tw] {
            assert_eq!(idle["status"], "paused");
            assert_eq!(idle["pending"], false);
            assert_eq!(idle["objective"], objective);
        }
    }).await.unwrap();
}
