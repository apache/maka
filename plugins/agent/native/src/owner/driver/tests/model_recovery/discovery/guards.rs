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
use maka_agent_facts::discovery::{ActionId, PendingActionStatus, TopicId};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

async fn thread(f: &Fixture) -> (String, String) {
    let topic = f
        .query("dropDiscoveryLead", json!({"text":"Contract release"}))
        .await;
    let session = f.query("openDossierThread", topic.clone()).await;
    (
        topic["topicId"].as_str().unwrap().into(),
        session["sessionId"].as_str().unwrap().into(),
    )
}
async fn talk(f: &Fixture, server: &mut MockAiServer, session: &str) -> TurnHandle {
    f.query(
        "send",
        json!({"sessionId":session,"message":"Review this dossier","backend":f.model}),
    )
    .await;
    let (socket, req) = next(server).await;
    assert!(
        model_tool_names(&req).contains(&"RegisterWatch")
            && model_tool_names(&req).contains(&"StagePendingAction")
    );
    for name in ["Write", "SendMail"] {
        assert!(
            !model_tool_names(&req).contains(&name),
            "dossier thread exposed a direct mutation"
        );
    }
    socket
}
async fn mail_fixture(server: &MockAiServer) -> Fixture {
    Fixture::with_tools(server,&[json!({"name":"SendMail","description":"Send a test message.","input":"json","result":"json",
        "confirmation":"required","target":{"kind":"import","name":"connector"},"method":"send"})]).await
}
fn mail(topic: &str, id: &str, to: &str, paths: Value) -> Value {
    json!({"topic_id":topic,"action_id":id,"connector_tool":"SendMail","params":{"to":to},"input_paths":paths,"idempotency_key":format!("key-{id}")})
}
async fn expect_status(f: &Fixture, id: &str, status: PendingActionStatus) {
    let store = f.owner().discovery.clone();
    let mut updates = store.subscribe();
    tokio::time::timeout(Duration::from_secs(12), async {
        loop {
            updates.borrow_and_update();
            if store
                .get_pending_action(ActionId(id.into()))
                .await
                .unwrap()
                .is_some_and(|r| r.status == status)
            {
                return;
            }
            updates.changed().await.unwrap();
        }
    })
    .await
    .unwrap_or_else(|_| panic!("action {id} did not reach {status:?}"));
}
async fn stage(f: &Fixture, server: &mut MockAiServer, session: &str, action: Value) {
    let socket = talk(f, server, session).await;
    tool(socket, "StagePendingAction", action.clone());
    expect_status(
        f,
        action["action_id"].as_str().unwrap(),
        PendingActionStatus::AwaitingConfirm,
    )
    .await;
    tokio::time::timeout(Duration::from_secs(12), f.quiescent(session))
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_http_watch_notifies_once_on_the_fourth_poll_without_a_model() {
    let mut model = MockAiBuilder::new().interactive(16).start().await.unwrap();
    let site = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::configured(&model, &[], "", |config| {
        config["permissions"]["access"] = json!("danger_full_access");
    })
    .await;
    let owner = f.owner();
    let policy = owner.configuration.runtime_policy().await.unwrap();
    let mut defaults = policy.policy.chat_defaults;
    defaults.sandbox_mode = SandboxMode::DangerFullAccess;
    owner
        .configuration
        .set_chat_defaults(policy.revision, defaults)
        .await
        .unwrap();
    let query = f
        .query(
            "dropDiscoveryLead",
            json!({"text":"Monitor a permitted release endpoint"}),
        )
        .await;
    let topic = query["topicId"].as_str().unwrap().to_owned();
    let opened = f
        .query("openDossierThread", json!({"topicId":topic,"elevate":true}))
        .await;
    let session = opened["sessionId"].as_str().unwrap().to_owned();
    let baseline = f.query("dossier", query.clone()).await;
    f.query(
        "send",
        json!({"sessionId":session,"message":"Monitor the release endpoint","backend":f.model}),
    )
    .await;
    let (opening, _) = next(&mut model).await;
    let target = format!("http://{}/stock", site.local_addr().unwrap());
    tool(
        opening,
        "RegisterWatch",
        json!({"topic_id":topic,"kind":"http_check","target":target,"interval_secs":1,
        "predicate":{"status_code":200,"contains_text":"white","not_contains_text":"captcha","json_pointer_equals":{"pointer":"/stock","value":"in_stock"}},"on_trigger":"notify_direct"}),
    );
    let (socket, reply) = next(&mut model).await;
    assert!(output(&reply)["watch_id"].is_string(), "{reply}");
    socket.reply_text("Monitoring.");
    f.quiescent(&session).await;
    let mut last_change = 0;
    for poll in 1..=5 {
        let (mut connection, _) = tokio::time::timeout(Duration::from_secs(8), site.accept())
            .await
            .unwrap()
            .unwrap();
        let mut get = [0u8; 1024];
        let n = connection.read(&mut get).await.unwrap();
        assert!(get[..n].starts_with(b"GET /stock HTTP/"));
        let body=json!({"sku":"white","stock":if poll<4{"out_of_stock"}else{"in_stock"},"unrelated_counter":poll}).to_string();
        let before = f.query("dossier", query.clone()).await["lastCheckedAt"]
            .as_i64()
            .unwrap();
        connection
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let detail = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let detail = f.query("dossier", query.clone()).await;
                if detail["lastCheckedAt"].as_i64().unwrap() > before {
                    break detail;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        if poll < 4 {
            assert_eq!(
                detail["lastMaterialChangeAt"],
                baseline["lastMaterialChangeAt"]
            );
            assert_eq!(detail["revision"], baseline["revision"]);
            assert_eq!(detail["lastNotifiedRevision"], 0);
        } else {
            assert_eq!(
                detail["revision"],
                baseline["revision"].as_i64().unwrap() + 1
            );
            assert_eq!(detail["lastNotifiedRevision"], detail["revision"]);
            let observed = detail["lastInterruptAt"].as_i64().unwrap();
            assert!(
                detail["lastInterruptReason"]
                    .as_str()
                    .unwrap()
                    .contains(&format!(
                        "http_check GET · {target} · observed_at {}",
                        jiff::Timestamp::from_millisecond(observed).unwrap()
                    ))
            );
            if poll == 4 {
                last_change = observed
            } else {
                assert_eq!(observed, last_change)
            }
        }
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(80), model.next_turn())
            .await
            .is_err()
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_both_hash_guards_block_changed_and_missing_inputs_and_release_the_worker() {
    let mut model = MockAiBuilder::new().interactive(16).start().await.unwrap();
    let mut f = mail_fixture(&model).await;
    let (topic, session) = thread(&f).await;
    let file = f.rig.directory.path().join("workspace/discovery.txt");
    let task = f.create("Prepare review").await;
    f.change(&task, "trigger_now").await;
    let (socket, _) = next(&mut model).await;
    tool(
        socket,
        "StagePendingAction",
        mail(&topic, "worker", "review", json!(["discovery.txt"])),
    );
    let (socket, _) = next(&mut model).await;
    tool(
        socket,
        "FinishNoChange",
        json!({"note":"Action ready for review"}),
    );
    assert_eq!(
        f.settled(&task, 1).await["task"]["runs"][0]["outcome"],
        "ok"
    );
    expect_status(&f, "worker", PendingActionStatus::AwaitingConfirm).await;
    tokio::fs::write(&file, "v4").await.unwrap();
    expect_status(&f, "worker", PendingActionStatus::Stale).await;
    let stale = f
        .query("confirmPendingAction", json!({"actionId":"worker"}))
        .await;
    assert_eq!(stale["outcome"], "stale");
    f.query("dismissPendingAction", json!({"actionId":"worker"}))
        .await;

    let owner = f.owner();
    let hold = owner.watch_runner.file_checks.lock().await;
    let socket = talk(&f, &mut model, &session).await;
    tool(
        socket,
        "StageArtifact",
        json!({"topic_id":topic,"relative_path":"draft.md","content":"staged v3","purpose":"Review"}),
    );
    let (socket, reply) = next(&mut model).await;
    assert_eq!(output(&reply)["path"], "draft.md");
    let staged = format!("staging/{topic}/draft.md");
    tool(
        socket,
        "StagePendingAction",
        mail(&topic, "race", "review", json!(["discovery.txt", staged])),
    );
    expect_status(&f, "race", PendingActionStatus::AwaitingConfirm).await;
    tokio::fs::write(&file, "another revision").await.unwrap();
    tokio::fs::remove_file(
        owner
            .store
            .owned_root()
            .unwrap()
            .canonical_path()
            .join("discovery")
            .join(&staged),
    )
    .await
    .unwrap();
    let blocked = f
        .query("confirmPendingAction", json!({"actionId":"race"}))
        .await;
    assert_eq!(blocked["outcome"], "stale");
    assert_eq!(blocked["changedPaths"].as_array().unwrap().len(), 2);
    assert!(
        blocked["changedPaths"]
            .as_array()
            .unwrap()
            .contains(&json!(staged))
    );
    assert!(
        blocked["changedPaths"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p.as_str().unwrap().ends_with("/workspace/discovery.txt"))
    );
    assert_eq!(f.rig.connector_calls.load(Ordering::SeqCst), 0);
    drop(hold);
    drop(owner);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_double_confirmation_and_lost_receipts_survive_cold_restart() {
    let mut listener = MockAiBuilder::new().interactive(16).start().await.unwrap();
    let mut f = mail_fixture(&listener).await;
    let (topic, session) = thread(&f).await;
    stage(
        &f,
        &mut listener,
        &session,
        mail(&topic, "once", "client", json!(["discovery.txt"])),
    )
    .await;
    stage(
        &f,
        &mut listener,
        &session,
        mail(&topic, "lost", "disconnect", json!([])),
    )
    .await;
    f.reopen().await;
    let detail = f.query("dossier", json!({"topicId":topic})).await;
    assert_eq!(detail["watches"].as_array().unwrap().len(), 1);
    let client = f.rig.client.as_ref().unwrap();
    let confirm = || {
        call(
            client,
            "agent",
            "confirmPendingAction",
            json!({"actionId":"once"}),
        )
    };
    let (first, second) = tokio::join!(confirm(), confirm());
    let successes = [first, second]
        .into_iter()
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    assert_eq!(successes.len(), 1, "{successes:?}");
    assert_eq!(successes[0]["outcome"], "done", "{successes:?}");
    assert_eq!(f.rig.connector_calls.load(Ordering::SeqCst), 1);
    assert!(
        f.query("dossier", json!({"topicId":topic})).await["watches"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let unknown = f
        .query("confirmPendingAction", json!({"actionId":"lost"}))
        .await;
    assert_eq!(unknown["outcome"], "unknown_pending_receipt", "{unknown}");
    assert!(
        unknown["error"]
            .as_str()
            .unwrap()
            .contains("delivery connection lost")
    );
    let uncertain = f
        .owner()
        .discovery
        .get_pending_action(ActionId("lost".into()))
        .await
        .unwrap()
        .unwrap()
        .receipt
        .unwrap();
    assert_eq!(uncertain["idempotencyKey"], "key-lost");
    assert!(uncertain["original"]["reference"]["operation"].is_string());
    f.reopen().await;
    assert_eq!(
        f.query("confirmPendingAction", json!({"actionId":"lost"}))
            .await,
        unknown
    );
    assert_eq!(f.rig.connector_calls.load(Ordering::SeqCst), 2);
    assert!(
        call(
            f.rig.client.as_ref().unwrap(),
            "agent",
            "dismissPendingAction",
            json!({"actionId":"lost"})
        )
        .await
        .is_err()
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_deadline_rejects_a_late_worker_and_enqueues_one_targeted_followup() {
    let mut model = MockAiBuilder::new().interactive(16).start().await.unwrap();
    let mut f = Fixture::new(&model).await;
    let (topic, _) = thread(&f).await;
    let query = json!({"topicId":topic});
    f.query("setDossierMuted", json!({"topicId":topic,"muted":true}))
        .await;
    let original = f.query("dossier", query.clone()).await;
    let plan = f.create("Follow the review").await;
    f.change(&plan, "trigger_now").await;
    let (worker, _) = next(&mut model).await;
    let watch = |trigger: &str| json!({"topic_id":topic,"target":"Sign","kind":"deadline","predicate":{"trigger_at_ms":1},"on_trigger":trigger});
    tool(worker, "RegisterWatch", watch("notify_direct"));
    let (worker, resp) = next(&mut model).await;
    assert!(output(&resp)["watch_id"].is_string(), "{resp}");
    let owner = f.owner();
    let mut notices = owner.discovery.subscribe();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            notices.borrow_and_update();
            let detail = owner
                .discovery
                .get_dossier(TopicId(topic.clone()))
                .await
                .unwrap()
                .unwrap();
            if detail.revision > original["revision"].as_u64().unwrap() {
                assert_eq!(detail.last_notified_revision, 0);
                break;
            }
            notices.changed().await.unwrap()
        }
    })
    .await
    .unwrap();
    let late = json!({"topic_id":topic,"expected_revision":original["revision"],"title":"Old finding","signal":"green","priority_weight":1,"summary_md":"Out of date","notify_intent":{"kind":"quiet"}});
    let (worker, conflict) = worker_upsert(&mut model, worker, late).await;
    assert!(conflict.to_string().contains("revision"), "{conflict}");
    tool(worker, "RegisterWatch", watch("enqueue_followup"));
    let (worker, resp) = next(&mut model).await;
    assert!(output(&resp)["watch_id"].is_string());
    tool(worker, "FinishNoChange", json!({"note":"Checked"}));
    let (followup, req) = next(&mut model).await;
    assert!(
        req["messages"]
            .to_string()
            .contains(&format!("Review dossier {topic} after its watch matched"))
    );
    tool(
        followup,
        "FinishNoChange",
        json!({"note":"Reviewed the deadline"}),
    );
    f.settled(&plan, 2).await;
    drop(owner);
    f.reopen().await;
    let detail = f.query("dossier", query).await;
    assert_eq!(
        detail["revision"],
        original["revision"].as_u64().unwrap() + 1
    );
    assert!(
        detail["watches"]
            .as_array()
            .unwrap()
            .iter()
            .all(|w| w["lastStateHash"] == "fired" && w["expiresAt"].is_number())
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(120), model.next_turn())
            .await
            .is_err()
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_workspace_overwrite_checks_the_destination_and_current_session_permission() {
    let mut model = MockAiBuilder::new().interactive(16).start().await.unwrap();
    let mut f = Fixture::new(&model).await;
    let (topic, session) = thread(&f).await;
    async fn permission(f: &Fixture, id: &str, access: &str) {
        let s = f.owner().session(id).await.unwrap();
        let result=f.query("metadata",json!({"sessionId":id,"expectedRevision":s.revision,"title":s.configuration.title,"labels":[],
            "permissions":{"settings":{"access":access,"requestPermissions":false},"revokeGrants":true}})).await;
        assert!(result["kind"] != "rejected", "{result}");
    }
    permission(&f, &session, "workspace_write").await;
    let file = f.rig.directory.path().join("workspace/discovery.txt");
    let overwrite = |id: &str, content: &str| json!({"topic_id":topic,"action_id":id,"connector_tool":"Write","params":{"path":"discovery.txt","content":content},"input_paths":[]});
    stage(
        &f,
        &mut model,
        &session,
        overwrite("write", "Confirmed file"),
    )
    .await;
    assert_eq!(
        tokio::fs::read_to_string(&file).await.unwrap(),
        "Observed fixture evidence"
    );
    let done = f
        .query("confirmPendingAction", json!({"actionId":"write"}))
        .await;
    assert_eq!(done["outcome"], "done", "{done}");
    assert_eq!(
        tokio::fs::read_to_string(&file).await.unwrap(),
        "Confirmed file"
    );
    stage(&f, &mut model, &session, overwrite("revoked", "Forbidden")).await;
    permission(&f, &session, "read_only").await;
    let blocked = f
        .query("confirmPendingAction", json!({"actionId":"revoked"}))
        .await;
    assert_ne!(blocked["outcome"], "done");
    assert_eq!(
        tokio::fs::read_to_string(&file).await.unwrap(),
        "Confirmed file"
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_dossier_thread_elevates_in_place_on_same_session_id() {
    let mut model = MockAiBuilder::new().interactive(16).start().await.unwrap();
    let mut f = mail_fixture(&model).await;
    let (topic, session) = thread(&f).await;
    // Phase 1: default consultation thread stays read-only (no Write / SendMail).
    let initial = talk(&f, &mut model, &session).await;
    initial.reply_text("Awaiting confirmation.");
    f.quiescent(&session).await;

    // Phase 2: user confirms an execution choice -> elevate the same thread session in-place.
    let elevated = f
        .query(
            "openDossierThread",
            json!({"topicId": topic, "elevate": true}),
        )
        .await;
    assert_eq!(elevated["sessionId"], session);

    f.query(
        "send",
        json!({"sessionId": session, "message": "Proceed with option A", "backend": f.model}),
    )
    .await;
    let (socket, req) = next(&mut model).await;
    let tools = model_tool_names(&req);
    assert!(
        tools.contains(&"Write"),
        "elevated dossier thread should expose normal workspace write tools: {tools:?}"
    );
    assert!(
        tools.contains(&"SendMail"),
        "elevated dossier thread should expose normal session connector tools: {tools:?}"
    );
    assert!(
        tools.contains(&"UpdateDiscoveryPreferences") && tools.contains(&"StageArtifact"),
        "elevated dossier thread should keep dossier helper tools: {tools:?}"
    );
    socket.reply_text("Done.");
    f.quiescent(&session).await;
    f.close().await;
}
