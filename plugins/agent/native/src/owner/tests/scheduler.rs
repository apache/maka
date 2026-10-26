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

async fn fixture(base: &str) -> Fixture {
    Fixture::configured(base, None, None, None, |settings| {
        settings.scheduled_tasks = true
    })
    .await
}
fn task(effect: Value) -> Value {
    json!({"task":{"title":"Scheduled 中😀", "intentBody":"Remember the original request", "schedule":{"kind":"interval","everySeconds":3600,"startAt":now()+3_600_000},"effect":effect,"maxFires":null,"expiresAt":null},"timezone":"Asia/Singapore","misfire":"latest"})
}
async fn detail(f: &Fixture, id: &str) -> Value {
    f.query("schedules", json!({"kind":"get","taskId":id}))
        .await
        .unwrap()["detail"]
        .clone()
}
async fn change(f: &Fixture, kind: &str, id: &str, extra: Value) -> Value {
    let current = detail(f, id).await;
    let mut input = json!({"kind":kind,"taskId":id,"revision":current["revision"]});
    input
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    f.mutation(2, "schedule", input, Uuid::new_v4())
        .await
        .unwrap()
}
async fn settled(f: &Fixture, id: &str) -> Value {
    loop {
        let value = detail(f, id).await;
        if !value["task"]["runs"].as_array().unwrap().is_empty() {
            return value;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
async fn reopen(f: &mut Fixture) {
    let deployment = f.app.source().unwrap().deployment;
    f.app.shutdown().await.unwrap();
    let mut native = NativeRegistry::default();
    maka_settings_native::provide(&mut native, crate::owner::tests::bundled_catalog()).unwrap();
    crate::owner::tests::provide_all(&mut native).unwrap();
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
async fn scheduler_tool_schema_declares_object_and_preserves_operation_constraints() {
    let f = fixture("http://127.0.0.1:1/v1").await;
    let tools = f.owner.scheduler.tools();
    let schema = &tools[0].definition.input_schema;
    assert_eq!(schema["type"], "object");
    let validator = jsonschema::validator_for(schema).unwrap();
    for input in [
        json!({"mode":"create","title":"Model proposal","intentBody":"Original scheduled body","effect":"agent_run","schedule":{"kind":"interval","everySeconds":3600,"startAt":now()+3_600_000},"timezone":"UTC"}),
        json!({"mode":"list"}),
        json!({"mode":"pause","taskId":"task","revision":1}),
        json!({"mode":"resume","taskId":"task","revision":1}),
        json!({"mode":"delete","taskId":"task","revision":1}),
    ] {
        let input = json!({"request": input});
        assert!(
            validator.is_valid(&input),
            "valid task input rejected: {input}"
        );
    }
    for input in [
        json!({"mode":"create","title":"Missing task fields"}),
        json!({"mode":"list","unexpected":true}),
        json!({"mode":"pause","taskId":"task"}),
        json!({"mode":"resume","taskId":"task","revision":"1"}),
        json!({"mode":"delete","revision":1}),
        json!({"mode":"unknown"}),
        json!([]),
    ] {
        let input = json!({"request": input});
        assert!(
            !validator.is_valid(&input),
            "invalid task input accepted: {input}"
        );
    }
    f.app.shutdown().await.unwrap();
}

#[tokio::test]
async fn scheduler_reminder_survives_lost_host_reply_restart_snooze_and_delete_with_original_receipt()
 {
    tokio::time::timeout(Duration::from_secs(45), async {
        let mut f = fixture("http://127.0.0.1:1/v1").await;
        let mut invalid = task(json!({"kind":"reminder"}));
        invalid["task"]["title"] = json!("   ");
        let rejected = f
            .mutation(
                2,
                "schedule",
                json!({"kind":"create","input":invalid}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(
            rejected["kind"], "rejected",
            "known validation failure must return a durable result, never strand caller recovery"
        );
        assert_eq!(
            rejected["reason"],
            "invalid scheduled task: empty or invalid task field"
        );
        let input = json!({"kind":"create","input":task(json!({"kind":"reminder"}))});
        let client = f.app.client();
        let prepared = client
            .prepare_mutation(
                f.binding(2).await,
                "schedule".into(),
                input.clone(),
                scope(&f.issuer, true),
                Uuid::new_v4(),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        let reference = prepared.reference().clone();
        f.store
            .record_application_intent(
                reference.source.clone(),
                prepared.consumer().instance().clone(),
                reference.clone(),
                Value::Null,
            )
            .await
            .unwrap();
        // Fault boundary: business transaction commits but Host receives no reply.
        let committed = f
            .owner
            .schedule_change(
                serde_json::from_value(input).unwrap(),
                reference.clone(),
                &scope(&f.issuer, true),
            )
            .await
            .unwrap();
        let committed = serde_json::to_value(committed).unwrap();
        let id = committed["taskId"].as_str().unwrap().to_owned();
        assert_eq!(committed["kind"], "committed");
        assert_eq!(
            change(&f, "trigger_now", &id, json!({})).await["kind"],
            "committed"
        );
        let pending = detail(&f, &id).await;
        let fire = pending["pendingFire"].clone();
        assert!(fire.is_string());
        let mut alerts = client
            .subscribe(
                f.binding(2).await,
                "scheduleAlerts".into(),
                json!({}),
                scope(&f.issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        let alert = alerts.recv().await.unwrap();
        assert!(format!("{alert:?}").contains("Scheduled 中😀"));
        drop(alerts);
        reopen(&mut f).await;
        assert_eq!(detail(&f, &id).await["pendingFire"], fire);
        assert_eq!(
            f.query("schedules", json!({"kind":"receipt","reference":reference}))
                .await
                .unwrap()["result"],
            committed
        );
        let stale = f
            .mutation(
                2,
                "schedule",
                json!({"kind":"delete","taskId":id,"revision":1}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(stale["kind"], "conflict");
        assert_eq!(
            change(&f, "snooze", &id, json!({"delayMs":60_000})).await["kind"],
            "committed"
        );
        assert!(detail(&f, &id).await["pendingFire"].is_null());
        assert_eq!(
            change(&f, "pause", &id, json!({})).await["kind"],
            "committed"
        );
        assert_eq!(detail(&f, &id).await["task"]["status"], "paused");
        assert_eq!(
            change(&f, "resume", &id, json!({})).await["kind"],
            "committed"
        );
        assert_eq!(
            change(&f, "trigger_now", &id, json!({})).await["kind"],
            "committed"
        );
        let next = detail(&f, &id).await;
        assert_ne!(next["pendingFire"], fire);
        assert_eq!(
            change(
                &f,
                "acknowledge",
                &id,
                json!({"fireId":next["pendingFire"]})
            )
            .await["kind"],
            "committed"
        );
        assert_eq!(detail(&f, &id).await["task"]["runs"][0]["outcome"], "ok");
        assert_eq!(
            change(&f, "clear_history", &id, json!({})).await["kind"],
            "committed"
        );
        assert_eq!(detail(&f, &id).await["task"]["runs"], json!([]));
        assert_eq!(
            change(&f, "delete", &id, json!({})).await["kind"],
            "committed"
        );
        reopen(&mut f).await;
        assert!(detail(&f, &id).await.is_null());
        assert_eq!(
            f.query("schedules", json!({"kind":"receipt","reference":reference}))
                .await
                .unwrap()["result"],
            committed
        );
        f.app.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn scheduler_model_proposal_requires_user_approval_and_archived_source_blocks_background_execution()
 {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&format!("http://{}/v1",listener.local_addr().unwrap())).await;
        let source = f.create("Source conversation").await;
        f.send(&source).await.unwrap();
        let (mut socket,_) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(sent["tools"].as_array().unwrap().iter().any(|t| t["function"]["name"]=="ScheduledTask"));
        recall_tests::tool(&mut socket,"ScheduledTask",json!({"request":{"mode":"create","title":"Model proposal","intentBody":"Original scheduled body","effect":"agent_run","schedule":{"kind":"interval","everySeconds":3600,"startAt":now()+3_600_000},"timezone":"UTC"}})).await;
        let (mut socket,_) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let output: Value = serde_json::from_str(sent["messages"].as_array().unwrap().iter().rev().find(|m| m["role"]=="tool").unwrap()["content"].as_str().unwrap()).unwrap();
        let page = f.query("schedules",json!({"kind":"list"})).await.unwrap();
        assert_eq!(page["tasks"].as_array().unwrap().len(),1,"{output}");
        let id = page["tasks"][0]["id"].as_str().unwrap().to_owned();
        assert_eq!(page["tasks"][0]["approved"],false);
        assert_eq!(page["tasks"][0]["status"],"paused");
        recall_tests::tool(&mut socket,"ScheduledTask",json!({"request":{"mode":"resume","taskId":id,"revision":page["tasks"][0]["revision"]}})).await;
        let (mut socket,_) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(sent.to_string().contains("scheduler_user_approval_required"),"{sent}");
        response(&mut socket).await;
        assert_eq!(change(&f,"approve",&id,json!({})).await["kind"],"committed");
        assert_eq!(change(&f,"trigger_now",&id,json!({})).await["kind"],"committed");
        let (mut socket,_) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(sent.to_string().contains("Original scheduled body"));
        response(&mut socket).await;
        let executed = settled(&f,&id).await;
        let run = &executed["task"]["runs"][0];
        assert_eq!(run["outcome"],"ok");
        assert_eq!(run["message"],"Message admitted");
        assert_ne!(run["sessionId"],source);
        let actual = f.owner.session(run["sessionId"].as_str().unwrap()).await.unwrap();
        let original = f.owner.session(&source).await.unwrap();
        assert_eq!(actual.configuration.workspace,original.configuration.workspace);
        assert_eq!(actual.configuration.permissions,original.configuration.permissions);
        assert_eq!(change(&f,"clear_history",&id,json!({})).await["kind"],"committed");
        f.store.set_session_archived::<StoredSessionConfiguration>(&source,true,now()).await.unwrap();
        assert_eq!(change(&f,"trigger_now",&id,json!({})).await["kind"],"committed");
        let blocked = settled(&f,&id).await;
        assert_eq!(blocked["task"]["runs"][0]["outcome"],"blocked");
        assert!(blocked["task"]["runs"][0]["sessionId"].is_null());
        assert!(tokio::time::timeout(Duration::from_millis(100),listener.accept()).await.is_err());
        f.app.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn scheduler_reopens_frozen_fire_and_reconciles_original_admission_after_lost_settlement() {
    use maka_capabilities::storage::Data;
    use maka_capabilities::storage::Mutation;
    use maka_capabilities::storage::Namespace;
    use maka_capabilities::storage::Store;
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut f = fixture(&format!("http://{}/v1",listener.local_addr().unwrap())).await;
        let source = f.create("Background authority").await;
        let boundary = f.owner.session(&source).await.unwrap().configuration;
        let created = f.mutation(2,"schedule",json!({"kind":"create","input":task(json!({"kind":"agent_run","target":{"sessionId":source,"workspace":boundary.workspace,"permissions":boundary.permissions,"boundaryRevision":boundary.boundary_revision,"binding":boundary.binding},"model":f.selection().await,"thinkingLevel":null}))}),Uuid::new_v4()).await.unwrap();
        let id = created["taskId"].as_str().unwrap();
        f.app.shutdown().await.unwrap();
        let storage = maka_host_runtime::storage::Storage::new(f.store.clone(),f.owner.prefix.clone(),Namespace::new("maka.agent.scheduler",maka_plugin_core::scope::Scope::Profile).unwrap());
        let key = format!("task:{id}");
        let saved = storage.read(key.clone()).await.unwrap().unwrap();
        let mut pending: maka_scheduler::plan::TaskPlan<ScheduledEffect,Value> = serde_json::from_value(saved.data.value().unwrap().clone()).unwrap();
        pending.task.next_fire_at = Some(now() as i64);
        pending.claim(now() as i64).unwrap();
        let frozen = serde_json::to_value(&pending).unwrap();
        let fire = pending.pending.as_ref().unwrap().id.clone();
        storage.batch(vec![Mutation{key:key.clone(),expected_revision:Some(saved.revision),data:Data::Present(frozen.clone())}]).await.unwrap();
        reopen(&mut f).await;
        let (mut socket,_) = listener.accept().await.unwrap();
        assert!(request(&mut socket).await.to_string().contains("Remember the original request"));
        response(&mut socket).await;
        let first = settled(&f,id).await;
        let run = first["task"]["runs"][0].clone();
        assert_eq!(run["id"],fire);
        let target = run["sessionId"].as_str().unwrap();
        loop {
            if service_tools::facts(&f,target).await.iter().any(|fact| matches!(fact,maka_agent_facts::event::Fact::InvocationEnded { .. })) { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        f.app.shutdown().await.unwrap();
        // Durable cut after original Agent admission but before scheduler settlement:
        // retain the exact frozen fire/approval, as a failed settlement would.
        let saved = storage.read(key.clone()).await.unwrap().unwrap();
        storage.batch(vec![Mutation{key:key.clone(),expected_revision:Some(saved.revision),data:Data::Present(frozen)}]).await.unwrap();
        f.store.set_session_archived::<StoredSessionConfiguration>(&source,true,now()).await.unwrap();
        reopen(&mut f).await;
        let recovered = settled(&f,id).await;
        let actual = &recovered["task"]["runs"][0];
        assert_eq!(actual["id"],run["id"]);
        assert_eq!(actual["sessionId"],run["sessionId"]);
        assert_eq!(actual["runId"],run["runId"]);
        assert_eq!(actual["outcome"],"ok","revocation cannot rewrite an already admitted result");
        assert_eq!(recovered["task"]["fireCount"],1);
        let facts = service_tools::facts(&f,target).await;
        assert_eq!(facts.iter().filter(|fact| matches!(fact,maka_agent_facts::event::Fact::InvocationOpened { .. })).count(),1);
        assert!(tokio::time::timeout(Duration::from_millis(100),listener.accept()).await.is_err());
        f.app.shutdown().await.unwrap();
        storage.finish().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn scheduler_rechecks_new_conversation_boundary_after_creation_before_admission() {
    use maka_capabilities::storage::Data;
    use maka_capabilities::storage::Mutation;
    use maka_capabilities::storage::Namespace;
    use maka_capabilities::storage::Store;
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let source = f.create("Approved source").await;
        let boundary = f.owner.session(&source).await.unwrap().configuration;
        let created = f.mutation(2, "schedule", json!({"kind":"create","input":task(json!({"kind":"agent_run","target":{"sessionId":source,"workspace":boundary.workspace,"permissions":boundary.permissions,"boundaryRevision":boundary.boundary_revision,"binding":boundary.binding},"model":f.selection().await,"thinkingLevel":null}))}), Uuid::new_v4()).await.unwrap();
        let id = created["taskId"].as_str().unwrap();
        f.app.shutdown().await.unwrap();
        let storage = maka_host_runtime::storage::Storage::new(f.store.clone(), f.owner.prefix.clone(), Namespace::new("maka.agent.scheduler", maka_plugin_core::scope::Scope::Profile).unwrap());
        let key = format!("task:{id}");
        let saved = storage.read(key.clone()).await.unwrap().unwrap();
        let mut pending: maka_scheduler::plan::TaskPlan<ScheduledEffect, Value> = serde_json::from_value(saved.data.value().unwrap().clone()).unwrap();
        pending.task.next_fire_at = Some(now() as i64);
        pending.claim(now() as i64).unwrap();
        let fire = pending.pending.as_ref().unwrap();
        let identity = hex::encode(Sha256::digest(fire.id.as_bytes()));
        let target = format!("{}{}", f.owner.prefix, &identity[..32]);
        // Durable cut after creation. An intervening user boundary change must
        // not widen the scheduled invocation, even while its source is valid.
        let mut changed = f.session(&source).await.get_session::<StoredSessionConfiguration>(&source).await.unwrap().unwrap().configuration;
        changed.boundary_revision = 1;
        f.store.create_session(&target, "intervening-boundary-change", &changed, now()).await.unwrap();
        storage.batch(vec![Mutation { key, expected_revision: Some(saved.revision), data: Data::Present(serde_json::to_value(pending).unwrap()) }]).await.unwrap();
        reopen(&mut f).await;
        let blocked = settled(&f, id).await;
        assert_eq!(blocked["task"]["runs"][0]["outcome"], "blocked");
        assert!(f.session(&target).await.message_admission(&target, &format!("m_{identity}")).await.unwrap().is_none());
        assert!(service_tools::facts(&f, &target).await.is_empty());
        assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err());
        f.app.shutdown().await.unwrap();
        storage.finish().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn sleeping_producers_allow_idle_retirement_but_active_iterations_are_fenced() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let f = fixture("http://127.0.0.1:1/v1").await;
        f.drained().await;
        let producer = f.owner.producer().await.unwrap();
        assert!(!f.app.shutdown_if_idle().await.unwrap());
        assert!(!f.owner.stop.is_cancelled());
        drop(producer);
        // The guard blocks a new iteration, but an abandoned retirement restores it.
        let guard = loop {
            if let Some(guard) = f.owner.prepare_retirement() {
                break guard;
            }
            tokio::task::yield_now().await;
        };
        assert!(f.owner.producer_gate.try_lock().is_err());
        drop(guard);
        assert!(!f.owner.stop.is_cancelled());
        drop(f.owner.producer().await.unwrap());
        while !f.app.shutdown_if_idle().await.unwrap() {
            tokio::task::yield_now().await;
        }
        assert!(f.owner.producers.is_empty());
        assert!(f.owner.workers.is_empty());
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
