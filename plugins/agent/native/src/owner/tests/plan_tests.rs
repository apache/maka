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
use maka_agent_facts::event::{Fact, ToolOutcome};

async fn fixture(base: &str) -> Fixture {
    Fixture::configured(
        base,
        None,
        None,
        Some(service_tools::Setup::files("write")),
        |settings| {
            settings.plans = true;
        },
    )
    .await
}
fn artifact() -> Value {
    json!({"title":"Reviewed native implementation 中😀","overview":"Make and verify exactly the approved change",
        "steps":[{"id":"change","title":"Make change","description":"Write the approved file","files":["plan-output.txt"],"complexity":"low"},
                 {"id":"verify","title":"Verify result","description":"Verify the actual native effect","files":[],"complexity":"low"}],
        "risks":["Do not execute before approval"]})
}
async fn current(f: &Fixture, session: &str) -> Value {
    f.query("plan", json!({"sessionId":session})).await.unwrap()["current"].clone()
}
async fn phase(f: &Fixture, session: &str, expected: &str) -> Value {
    loop {
        let snapshot = current(f, session).await;
        if snapshot["execution"]["phase"] == expected {
            return snapshot;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
async fn mode(f: &Fixture, session: &str, mode: &str) -> Value {
    let record = f
        .session(session)
        .await
        .get_session::<StoredSessionConfiguration>(session)
        .await
        .unwrap()
        .unwrap();
    f.mutation(2,"metadata",json!({"sessionId":session,"expectedRevision":record.revision,"title":record.configuration.title,"labels":record.configuration.labels,"collaborationMode":mode}),Uuid::new_v4()).await.unwrap()
}
async fn approval(f: &Fixture, session: &str) -> Value {
    let config = f.owner.session(session).await.unwrap().configuration;
    json!({"target":{"sessionId":session,"workspace":config.workspace,"permissions":config.permissions,"boundaryRevision":config.boundary_revision,"binding":config.binding},"model":f.selection().await,"thinkingLevel":null})
}
async fn approve(f: &Fixture, session: &str) -> (Value, Value, Uuid) {
    let snapshot = current(f, session).await;
    let input = json!({"sessionId":session,"revision":snapshot["revision"],"action":{"kind":"approve","proposalId":snapshot["proposal"]["id"],"proposalRevision":snapshot["proposal"]["revision"],"approval":approval(f,session).await}});
    let id = Uuid::new_v4();
    let result = f
        .mutation(2, "changePlan", input.clone(), id)
        .await
        .unwrap();
    (result, input, id)
}
async fn propose(f: &Fixture, session: &str, listener: &TcpListener) {
    assert_eq!(mode(f, session, "plan").await["kind"], "committed");
    f.send(session).await.unwrap();
    let (mut socket, _) = listener.accept().await.unwrap();
    request(&mut socket).await;
    service_tools::named_tool_response(&mut socket, "SubmitPlan", artifact()).await;
    f.drained().await;
    assert_eq!(
        current(f, session).await["proposal"]["status"],
        "pending_approval"
    );
}
async fn progress(socket: &mut TcpStream, code: bool) {
    let input = json!({"steps":[{"id":"change","status":"completed","note":"File exists"},{"id":"verify","status":"completed","note":"Original result verified"}]});
    if code {
        service_tools::named_tool_response(
            socket,
            "exec",
            json!({"code":format!("text(await tools.update_plan({input}));")}),
        )
        .await;
    } else {
        service_tools::named_tool_response(socket, "update_plan", input).await;
    }
}

#[tokio::test]
async fn plan_real_direct_and_code_mode_require_review_then_native_effect_and_canonical_completion()
{
    tokio::time::timeout(Duration::from_secs(90), async {
        for code in [false,true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut f = fixture(&format!("http://{}/v1",listener.local_addr().unwrap())).await;
            selection::edit(&f,|changes| changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(),ModelOverride { code_mode:Some(code), ..Default::default() })]))).await;
            let mut create = f.create_input("Plan review").await;
            create["automaticTitle"] = json!(true);
            let session = f.mutation(2,"create",create,Uuid::new_v4()).await.unwrap()["session"]["id"].as_str().unwrap().to_owned();
            let sibling = f.create("Independent session").await;
            assert_eq!(mode(&f,&session,"plan").await["kind"],"committed");
            assert!(!f.session(&session).await.get_session::<StoredSessionConfiguration>(&session).await.unwrap().unwrap().configuration.title_is_manual, "mode selection must preserve automatic title eligibility");
            f.send(&session).await.unwrap();
            let (mut first,_) = listener.accept().await.unwrap();
            let sent = request(&mut first).await;
            let names: Vec<_> = sent["tools"].as_array().unwrap().iter().filter_map(|tool|tool["function"]["name"].as_str()).collect();
            assert!(names.contains(&"SubmitPlan"),"{names:?}");
            assert!(!names.contains(&"WorkspaceFile") && !names.contains(&"update_plan") && !names.contains(&"cancel_plan"),"{names:?}");
            assert!(sent["messages"].to_string().contains("Inspect and discuss only"));
            assert_eq!(mode(&f,&session,"agent").await["reason"],"busy");
            service_tools::named_tool_response(&mut first,"WorkspaceFile",json!({"path":"should-not-exist","content":"unapproved"})).await;
            let (mut after_denial,_) = listener.accept().await.unwrap();
            request(&mut after_denial).await;
            assert!(!f.workspace.join("should-not-exist").exists());
            assert!(f.session(&session).await.pending_interactions(&session).await.unwrap().is_empty());
            service_tools::named_tool_response(&mut after_denial,"SubmitPlan",artifact()).await;
            f.drained().await;
            let proposed = current(&f,&session).await;
            assert_eq!(proposed["proposal"]["status"],"pending_approval");
            assert!(proposed["execution"].is_null());
            assert!(tokio::time::timeout(Duration::from_millis(100),listener.accept()).await.is_err(),"submission ends planning without implementation");
            let (approved,input,id) = approve(&f,&session).await;
            assert_eq!(approved["kind"],"committed","{approved}");
            assert_eq!(f.mutation(2,"changePlan",input.clone(),id).await.unwrap(),approved);
            let (mut executing,_) = listener.accept().await.unwrap();
            let sent = request(&mut executing).await;
            let names:Vec<_> = sent["tools"].as_array().unwrap().iter().filter_map(|tool|tool["function"]["name"].as_str()).collect();
            assert!(names.contains(&"WorkspaceFile") && names.contains(&"cancel_plan") && !names.contains(&"SubmitPlan"),"{names:?}");
            assert!(sent["messages"].to_string().contains("user-approved plan"));
            service_tools::named_tool_response(&mut executing,"WorkspaceFile",json!({"path":"plan-output.txt","content":"Only the approved execution writes this"})).await;
            let (mut reporting,_) = listener.accept().await.unwrap();
            request(&mut reporting).await;
            assert_eq!(std::fs::read_to_string(f.workspace.join("plan-output.txt")).unwrap(),"Only the approved execution writes this");
            progress(&mut reporting,code).await;
            let (mut finishing,_) = listener.accept().await.unwrap();
            let sent = request(&mut finishing).await;
            assert!(sent.to_string().contains("recorded"),"{sent}");
            let reported = phase(&f,&session,"active").await;
            assert_eq!(reported["execution"]["steps"][1]["status"],"completed");
            assert!(sent.to_string().contains("Current Plan state for this model step"));
            response(&mut finishing).await;
            let completed = phase(&f,&session,"completed").await;
            assert_eq!(current(&f,&sibling).await["revision"],0);
            assert!(f.query("plan",json!({"sessionId":"foreign-session"})).await.is_err());
            f.drained().await;
            todo_tests::reopen(&mut f).await;
            assert_eq!(current(&f,&session).await,completed);
            assert_eq!(f.mutation(2,"changePlan",input,id).await.unwrap(),approved);
            let history = f.query("planHistory",json!({"sessionId":session,"throughRevision":completed["revision"],"after":0})).await.unwrap();
            assert_eq!(history["snapshots"][0]["proposal"]["artifact"],artifact());
            assert_eq!(history["snapshots"].as_array().unwrap().last().unwrap()["execution"]["phase"],"completed");
            assert!(tokio::time::timeout(Duration::from_millis(100),listener.accept()).await.is_err());
            let facts = service_tools::facts(&f,&session).await;
            assert_eq!(facts.iter().filter(|fact|matches!(fact,Fact::InvocationOpened { .. })).count(),2);
            assert!(facts.iter().any(|fact|matches!(fact,Fact::ToolSettled { outcome:ToolOutcome::Succeeded { .. }, .. })));
            f.app.shutdown().await.unwrap();
        }
    }).await.unwrap();
}

#[tokio::test]
async fn plan_unknown_original_approval_and_accepted_outbox_recover_after_restart_without_replay() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut f=fixture(&format!("http://{}/v1",listener.local_addr().unwrap())).await;
        let session=f.create("Recover original Plan").await;
        propose(&f,&session,&listener).await;
        let snapshot=current(&f,&session).await;
        let input=json!({"sessionId":session,"revision":snapshot["revision"],"action":{"kind":"approve","proposalId":snapshot["proposal"]["id"],"proposalRevision":snapshot["proposal"]["revision"],"approval":approval(&f,&session).await}});
        let prepared=f.app.client().prepare_mutation(f.binding(2).await,"changePlan".into(),input.clone(),scope(&f.issuer,true),Uuid::new_v4(),Attachments::new().into()).await.unwrap();
        let reference=prepared.reference().clone();
        f.store.record_application_intent(reference.source.clone(),prepared.consumer().instance().clone(),reference.clone(),Value::Null).await.unwrap();
        let producer=f.owner.producer_gate.lock().await;
        // The original business commit succeeds while its Host reply is lost.
        let committed=f.owner.plan_change(serde_json::from_value(input).unwrap(),reference.clone(),&scope(&f.issuer,true)).await.unwrap();
        let committed=serde_json::to_value(committed).unwrap();
        assert_eq!(committed["kind"],"committed");
        assert_eq!(current(&f,&session).await["execution"]["phase"],"awaiting_admission");
        assert!(tokio::time::timeout(Duration::from_millis(100),listener.accept()).await.is_err());
        f.owner.stop.cancel();
        drop(producer);
        todo_tests::reopen(&mut f).await;
        assert_eq!(f.query("planReceipt",json!({"reference":reference})).await.unwrap(),committed);
        let (mut socket,_) = listener.accept().await.unwrap();
        assert!(request(&mut socket).await.to_string().contains("Reviewed native implementation 中😀"));
        progress(&mut socket,false).await;
        let (mut socket,_) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response(&mut socket).await;
        phase(&f,&session,"completed").await;
        todo_tests::reopen(&mut f).await;
        assert_eq!(f.query("planReceipt",json!({"reference":reference})).await.unwrap(),committed);
        assert!(f.session(&session).await.message_queue(&session).await.unwrap().entries.is_empty());
        assert_eq!(service_tools::facts(&f,&session).await.iter().filter(|fact|matches!(fact,Fact::InvocationOpened{..})).count(),2);
        assert!(tokio::time::timeout(Duration::from_millis(100),listener.accept()).await.is_err());
        f.app.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn planning_filters_actual_service_methods_before_discovery_and_code_mode_even_when_renamed()
{
    tokio::time::timeout(Duration::from_secs(60),async {
        for name in ["Read", "Recall"] {
            let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
            let f=Fixture::configured(&format!("http://{}/v1",listener.local_addr().unwrap()),None,None,
                Some(service_tools::Setup::files("write").named(name)),|settings| {
                    settings.plans=true;
                    settings.tool_discovery=true;

                }).await;
            selection::edit(&f,|changes|changes.model_overrides=Patch::Set(BTreeMap::from([("fixture-model".into(),ModelOverride { code_mode:Some(true),..Default::default() })]))).await;
            let session=f.create("Planning alias isolation").await;
            assert_eq!(mode(&f,&session,"plan").await["kind"],"committed");
            f.send(&session).await.unwrap();
            let (mut socket,_) = listener.accept().await.unwrap();
            let sent=request(&mut socket).await;
            assert!(!sent["tools"].as_array().unwrap().iter().any(|tool|tool["function"]["name"]==name));
            service_tools::named_tool_response(&mut socket,"tool_search",json!({"query":name})).await;
            let (mut socket,_) = listener.accept().await.unwrap();
            let sent=request(&mut socket).await;
            assert!(!sent["tools"].as_array().unwrap().iter().any(|tool|tool["function"]["name"]==name));
            service_tools::named_tool_response(&mut socket,"exec",json!({"code":format!("await tools.{name}({{path:'unapproved.txt',content:'must never be written'}});")})).await;
            let (mut socket,_) = listener.accept().await.unwrap();
            request(&mut socket).await;
            assert!(!f.workspace.join("unapproved.txt").exists());
            assert!(f.session(&session).await.pending_interactions(&session).await.unwrap().is_empty());
            service_tools::named_tool_response(&mut socket,"SubmitPlan",artifact()).await;
            f.drained().await;
            assert_eq!(current(&f,&session).await["proposal"]["status"],"pending_approval");
            f.app.shutdown().await.unwrap();
        }
        // A renamed legitimate reader remains available under the same bound method.
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f=Fixture::configured(&format!("http://{}/v1",listener.local_addr().unwrap()),None,None,
            Some(service_tools::Setup::files("readText").named("InspectDocument")),|settings| {
                settings.plans=true;
            }).await;
        std::fs::write(f.workspace.join("inspect.txt"),"Actual planning read").unwrap();
        let session=f.create("Planning read alias").await;
        mode(&f,&session,"plan").await;
        f.send(&session).await.unwrap();
        let (mut socket,_) = listener.accept().await.unwrap();
        let sent=request(&mut socket).await;
        assert!(sent["tools"].as_array().unwrap().iter().any(|tool|tool["function"]["name"]=="InspectDocument"));
        service_tools::named_tool_response(&mut socket,"InspectDocument",json!({"path":"inspect.txt"})).await;
        let (mut socket,_) = listener.accept().await.unwrap();
        assert!(request(&mut socket).await.to_string().contains("Actual planning read"));
        service_tools::named_tool_response(&mut socket,"SubmitPlan",artifact()).await;
        f.drained().await;
        f.app.shutdown().await.unwrap();
    }).await.unwrap();
}
