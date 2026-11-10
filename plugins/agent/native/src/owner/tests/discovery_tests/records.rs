/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

use super::*;

#[tokio::test]
async fn discovery_records_recover_a_committed_outcome_without_its_acknowledgement() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (mut f, bot) = fixture(&listener, false).await;
        let task = create(&f, &bot, "Lost settlement acknowledgement").await;
        change(&f, "trigger_now", &task, json!({})).await;
        let (mut socket, _) = next(&listener).await;
        let worker = f
            .owner
            .scheduler
            .investigation
            .read()
            .unwrap()
            .clone()
            .unwrap();
        let committed = f.owner.scheduler.storage.unknown_after("investigation");
        finish(
            &mut socket,
            json!({"kind":"no_report","note":"durable-result-marker"}),
        )
        .await;
        committed.await.unwrap();
        reopen(&mut f).await;
        let done = settled(&f, &task).await;
        assert_eq!(done["task"]["fireCount"], 1);
        assert_eq!(done["task"]["runs"].as_array().unwrap().len(), 1);
        assert_eq!(done["task"]["runs"][0]["sessionId"], worker.session_id);
        assert_eq!(done["task"]["runs"][0]["outcome"], "ok");
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
        f.send(&bot).await.unwrap();
        let (mut socket, _) = next(&listener).await;
        let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
        assert_eq!(page["records"].as_array().unwrap().len(), 1, "{page}");
        assert_eq!(
            page["records"][0]["content"]["result"]["note"],
            "durable-result-marker"
        );
        quiet(&f, &listener, &mut socket, &bot).await;
        change(&f, "trigger_now", &task, json!({})).await;
        let (mut socket, _) = next(&listener).await;
        finish(
            &mut socket,
            json!({"kind":"no_report","note":"next independent investigation"}),
        )
        .await;
        loop {
            if detail(&f, &task).await["task"]["runs"]
                .as_array()
                .unwrap()
                .len()
                == 2
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(
            f.query("botOutbox", json!({})).await.unwrap()["messages"],
            json!([])
        );
        close(&f).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn discovery_records_recover_an_uncertain_notified_receipt_without_resending() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (mut f, bot) = fixture(&listener, false).await;
        let task = create(&f, &bot, "Lost decision acknowledgement").await;
        change(&f, "trigger_now", &task, json!({})).await;
        let (mut worker, _) = next(&listener).await;
        finish(&mut worker, json!({"kind":"report","text":"A durable finding"})).await;
        let (mut socket, _) = next(&listener).await;
        let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
        let record = page["records"][0]["id"].clone();
        let input = json!({"messageId":"uncertain-publication","messages":[{"text":"The finding is actionable."}],
            "discovery":{"record":record,"reason":"verified against the source"}});
        let committed = f.owner.scheduler.storage.unknown_after("notified");
        service_tools::named_tool_response(&mut socket, "SendUser", input.clone()).await;
        committed.await.unwrap();
        let original = f.query("botOutbox", json!({})).await.unwrap()["messages"].clone();
        assert_eq!(original.as_array().unwrap().len(), 1);
        reopen(&mut f).await;
        assert_eq!(f.query("botOutbox", json!({})).await.unwrap()["messages"], original);
        f.send(&bot).await.unwrap();
        let (mut socket, _) = next(&listener).await;
        service_tools::named_tool_response(&mut socket, "SendUser", input).await;
        let (mut socket, sent) = next(&listener).await;
        assert!(sent["messages"].to_string().contains("Already sent"), "{sent}");
        let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list","related":record})).await;
        assert_eq!(page["records"].as_array().unwrap().len(), 2, "{page}");
        assert_eq!(page["records"][0]["content"]["kind"], "notified");
        assert_eq!(page["records"][1]["content"]["kind"], "investigation");
        assert_eq!(f.query("botOutbox", json!({})).await.unwrap()["messages"], original);
        quiet(&f, &listener, &mut socket, &bot).await;
        close(&f).await;
    }).await.unwrap();
}

#[tokio::test]
async fn discovery_records_serialize_a_bot_append_with_investigation_settlement() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (f, bot) = fixture(&listener, false).await;
        let task = create(&f, &bot, "Concurrent records").await;
        change(&f, "trigger_now", &task, json!({})).await;
        let (mut worker, _) = next(&listener).await;
        finish(&mut worker, json!({"kind":"no_report","note":"original investigation"})).await;
        settled(&f, &task).await;
        f.send(&bot).await.unwrap();
        let (mut socket, _) = next(&listener).await;
        let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
        let original = page["records"][0]["id"].clone();
        change(&f, "trigger_now", &task, json!({})).await;
        let (mut worker, _) = next(&listener).await;
        let (entered, release) = f.owner.scheduler.storage.hold_before("investigation");
        finish(&mut worker, json!({"kind":"no_report","note":"concurrent investigation"})).await;
        entered.await.unwrap();
        let previous = service_tools::facts(&f, &bot).await.len();
        service_tools::named_tool_response(&mut socket, "DiscoveryMemory",
            json!({"action":"withhold","record":original,"reason":"still not actionable"})).await;
        // The settlement has read the old head; admit the competing Bot write.
        loop {
            let facts = service_tools::facts(&f, &bot).await;
            if facts.iter().skip(previous).any(|fact| matches!(fact, Fact::ToolDispatched { name, .. } if name == "DiscoveryMemory")) { break; }
            tokio::task::yield_now().await;
        }
        let replied_while_held = tokio::time::timeout(Duration::from_millis(150), listener.accept()).await;
        release.send(()).unwrap();
        assert!(replied_while_held.is_err(), "the Bot append must wait for the settlement's head update");
        let (mut socket, sent) = next(&listener).await;
        assert_eq!(output(&sent)["recorded"], true, "{sent}");
        loop {
            if detail(&f, &task).await["task"]["runs"].as_array().unwrap().len() == 2 { break; }
            tokio::task::yield_now().await;
        }
        let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
        let records = page["records"].as_array().unwrap();
        assert_eq!(records.len(), 3, "{page}");
        assert_eq!(records.iter().map(|r| r["sequence"].as_u64().unwrap()).collect::<Vec<_>>(), [3, 2, 1]);
        assert_eq!(records.iter().filter(|r| r["content"]["kind"] == "withheld").count(), 1);
        assert_eq!(records.iter().filter(|r| r["content"]["kind"] == "investigation").count(), 2);
        quiet(&f, &listener, &mut socket, &bot).await;
        close(&f).await;
    }).await.unwrap();
}

#[tokio::test]
async fn discovery_records_reject_feedback_and_publication_after_project_relocation() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::configured(&format!("http://{}/v1", listener.local_addr().unwrap()),
            None, None, None, |settings| {
                settings.bot = true;
                settings.scheduled_tasks = true;
                settings.recall = true;
            }).await;
        let roots = f.query("directories", json!({"kind":"roots"})).await.unwrap();
        let source = roots["roots"][0]["path"].clone();
        let registered = f.mutation(2, "project", json!({"kind":"register","path":source,"expected":null}), Uuid::new_v4()).await.unwrap();
        assert_eq!(registered["kind"], "committed");
        let opened = f.mutation(2, "openBot", json!({"workspace":{"kind":"project","project":registered["project"]["reference"],"path":source}}), Uuid::new_v4()).await.unwrap();
        let bot = opened["sessionId"].as_str().unwrap().to_owned();
        let task = create(&f, &bot, "Relocated source").await;
        change(&f, "trigger_now", &task, json!({})).await;
        let (mut worker, _) = next(&listener).await;
        finish(&mut worker, json!({"kind":"report","text":"Finding under the original binding"})).await;
        let (mut socket, _) = next(&listener).await;
        let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
        let record = page["records"][0]["id"].clone();
        quiet(&f, &listener, &mut socket, &bot).await;
        let before = f.owner.session(&bot).await.unwrap().configuration;
        let project = f.query("projects", json!({"kind":"directory","path":source})).await.unwrap()["location"]["project"]["reference"].clone();
        let moved = f.mutation(2, "project", json!({"kind":"relocate","project":project,"path":roots["roots"][1]["path"],"destination":null}), Uuid::new_v4()).await.unwrap();
        assert_eq!(moved["kind"], "committed", "{moved}");
        let after = f.owner.session(&bot).await.unwrap().configuration;
        assert_eq!(after.permissions, before.permissions);
        assert_eq!(after.binding.id, before.binding.id);
        assert_eq!(after.binding.permission_epoch, before.binding.permission_epoch + 1);
        f.send(&bot).await.unwrap();
        let (mut socket, _) = next(&listener).await;
        let (mut socket, rejected) = memory(&listener, &mut socket,
            json!({"action":"feedback","record":record,"note":"Do not use the old source"})).await;
        assert!(rejected.to_string().contains("discovery_record_unavailable"), "{rejected}");
        service_tools::named_tool_response(&mut socket, "SendUser",
            json!({"messageId":"old-binding-report","messages":[{"text":"Stale source finding"}],
                "discovery":{"record":record,"reason":"old source"}})).await;
        let (mut socket, rejected) = next(&listener).await;
        assert!(output(&rejected).to_string().contains("discovery_record_unavailable"), "{rejected}");
        assert_eq!(f.query("botOutbox", json!({})).await.unwrap()["messages"], json!([]));
        quiet(&f, &listener, &mut socket, &bot).await;
        close(&f).await;
    }).await.unwrap();
}

async fn next(listener: &TcpListener) -> (TcpStream, Value) {
    let (mut socket, _) = listener.accept().await.unwrap();
    let sent = request(&mut socket).await;
    (socket, sent)
}
fn output(sent: &Value) -> Value {
    let content = sent["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|m| m["role"] == "tool")
        .unwrap()["content"]
        .as_str()
        .unwrap();
    serde_json::from_str(content).unwrap_or_else(|_| json!({"error":content}))
}
async fn memory(
    listener: &TcpListener,
    socket: &mut TcpStream,
    input: Value,
) -> (TcpStream, Value) {
    service_tools::named_tool_response(socket, "DiscoveryMemory", input).await;
    let (socket, sent) = next(listener).await;
    (socket, output(&sent))
}
async fn quiet(f: &Fixture, listener: &TcpListener, socket: &mut TcpStream, bot: &str) {
    service_tools::named_tool_response(socket, "sleep", json!({})).await;
    loop {
        if f.query("observe", json!({"sessionId":bot})).await.unwrap()["run"].is_null() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn discovery_records_survive_restart_and_carry_only_bounded_continuation() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (mut f, bot) = fixture(&listener, false).await;
        let task = create(&f, &bot, "Continuation").await;
        change(&f, "trigger_now", &task, json!({})).await;
        let (mut socket, sent) = next(&listener).await;
        assert!(names(&sent).contains(&"DiscoveryMemory"));
        let (mut socket2, result) = memory(&listener, &mut socket,
            json!({"action":"checkpoint","note":{"text":"Verified configuration; next inspect the changelog.","references":["README.md#configuration"]}})).await;
        assert_eq!(result["staged"], true, "{result}");
        let long_reason = format!("No actionable change: {} end-of-reason", "中".repeat(1500));
        finish(&mut socket2, json!({"kind":"no_report","note":long_reason})).await;
        let first = settled(&f, &task).await["task"]["runs"][0].clone();
        reopen(&mut f).await;
        change(&f, "trigger_now", &task, json!({})).await;
        let (mut socket, sent) = next(&listener).await;
        let prompt = sent["messages"].to_string();
        assert!(prompt.contains("Discovery continuation"));
        assert!(!prompt.contains("end-of-reason"), "full old record must be loaded on demand");
        let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
        assert_eq!(page["records"].as_array().unwrap().len(), 1, "{page}");
        let record = &page["records"][0];
        assert_eq!(record["content"]["result"]["note"], long_reason);
        assert_eq!(record["source"]["session_id"], first["sessionId"]);
        assert_eq!(record["content"]["checkpoint"]["references"], json!(["README.md#configuration"]));
        finish(&mut socket, json!({"kind":"no_report","note":"Resumed from configuration; checked changelog."})).await;
        loop {
            let detail = detail(&f, &task).await;
            if detail["task"]["runs"].as_array().unwrap().len() == 2 {
                assert_ne!(detail["task"]["runs"][0]["sessionId"], first["sessionId"]);
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(f.query("botOutbox", json!({})).await.unwrap()["messages"], json!([]));
        close(&f).await;
    }).await.unwrap();
}

#[tokio::test]
async fn discovery_records_keep_bot_decisions_and_exact_quote_only_feedback() {
    tokio::time::timeout(Duration::from_secs(120), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (f, bot) = fixture(&listener, false).await;
        let task = create(&f, &bot, "A finding").await;
        change(&f, "trigger_now", &task, json!({})).await;
        let (mut socket, _) = next(&listener).await;
        finish(&mut socket, json!({"kind":"report","text":"A candidate finding; inspect source.md."})).await;
        let (mut socket, sent) = next(&listener).await;
        assert!(sent["messages"].to_string().contains("DiscoveryMemory record:"));
        let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
        let record = page["records"][0]["id"].as_str().unwrap().to_owned();
        let reason = format!("Withheld until confirmation: {} full-reason-end", "详".repeat(600));
        let (mut socket, saved) = memory(&listener, &mut socket, json!({"action":"withhold","record":record,"reason":reason})).await;
        assert_eq!(saved["recorded"], true, "{saved}");
        let (mut socket, rejected) = memory(&listener, &mut socket, json!({"action":"notified","record":record,"reason":"claimed notification","message_id":"never-sent"})).await;
        assert!(rejected.to_string().contains("notification_not_recorded"), "{rejected}");
        service_tools::named_tool_response(&mut socket, "SendUser", json!({"messageId":"finding-publication","messages":[{"text":"There is a candidate finding in source.md."}],"discovery":{"record":record,"reason":"User should verify this finding"}})).await;
        let (mut socket, _) = next(&listener).await;
        // Retrying publication also reuses the linked decision receipt.
        service_tools::named_tool_response(&mut socket, "SendUser", json!({"messageId":"finding-publication","messages":[{"text":"There is a candidate finding in source.md."}],"discovery":{"record":record,"reason":"User should verify this finding"}})).await;
        let (mut socket, sent) = next(&listener).await;
        assert!(sent["messages"].to_string().contains("Already sent"));
        assert_eq!(f.query("botOutbox", json!({})).await.unwrap()["messages"].as_array().unwrap().len(), 1);
        let (mut socket, saved) = memory(&listener, &mut socket, json!({"action":"notified","record":record,"reason":"User should verify this finding","message_id":"finding-publication"})).await;
        assert_eq!(saved["recorded"], true, "{saved}");
        quiet(&f, &listener, &mut socket, &bot).await;
        let published = f.query("botOutbox", json!({})).await.unwrap()["messages"][0].clone();
        let quote = json!({"text":format!("这个事项不要再提醒；此前结论已失效。{}", "引用".repeat(2500)),"label":"User correction","sourceTurnId":published["turnId"]});
        f.mutation(2,"send",json!({"sessionId":bot,"message":"","quotes":[quote],
            "delivery":"queue","backend":model_backend(&f.selection().await)}),Uuid::new_v4()).await.unwrap();
        let (mut socket, _) = next(&listener).await;
        let (mut socket, saved) = memory(&listener, &mut socket, json!({"action":"feedback","record":record,"note":"User asks to stop reminders and invalidates the old conclusion."})).await;
        assert_eq!(saved["recorded"], true, "{saved}");
        let feedback = saved["record"].clone();
        let (mut socket, source) = memory(&listener, &mut socket, json!({"action":"feedback_source","record":feedback})).await;
        let mut raw = source["source"].as_str().unwrap().to_owned();
        let mut offset = source["next_offset"].clone();
        assert!(offset.is_number(), "long feedback must have explicit continuation");
        while !offset.is_null() {
            let (next_socket, next_source) = memory(&listener, &mut socket, json!({"action":"feedback_source","record":feedback,"offset":offset})).await;
            socket = next_socket;
            raw.push_str(next_source["source"].as_str().unwrap());
            offset = next_source["next_offset"].clone();
        }
        let original: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(original["text"], "");
        assert_eq!(original["quotes"][0], quote);
        let (mut socket, saved) = memory(&listener, &mut socket, json!({"action":"correct","record":record,"note":{"text":"Conclusion superseded by the user's correction.","references":[]}})).await;
        assert_eq!(saved["recorded"], true, "{saved}");
        quiet(&f, &listener, &mut socket, &bot).await;
        change(&f, "trigger_now", &task, json!({})).await;
        let (mut socket, sent) = next(&listener).await;
        assert!(sent["messages"].to_string().contains("stop reminders"));
        let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list","related":record})).await;
        assert_eq!(page["records"].as_array().unwrap().len(), 4);
        let withheld = page["records"].as_array().unwrap().iter().find(|r| r["content"]["kind"] == "withheld").unwrap();
        assert_eq!(withheld["content"]["reason"], reason);
        assert!(page["next_before"].is_number());
        let (mut socket, last) = memory(&listener, &mut socket, json!({"action":"list","related":record,"before":page["next_before"]})).await;
        assert_eq!(last["records"].as_array().unwrap().len(), 1);
        assert_eq!(last["records"][0]["content"]["kind"], "investigation");
        assert!(last["next_before"].is_null());
        let (mut socket, rejected) = memory(&listener, &mut socket, json!({"action":"withhold","record":record,"reason":"worker must not speak for Bot"})).await;
        assert!(rejected.to_string().contains("decision_requires_bot"));
        finish(&mut socket,json!({"kind":"no_report","note":"Read feedback and did not repeat the dismissed finding."})).await;
        close(&f).await;
    }).await.unwrap();
}

#[tokio::test]
async fn discovery_records_cancelled_checkpoints_never_reach_the_next_worker() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (f, bot) = fixture(&listener, false).await;
        let task = create(&f, &bot, "Cancelled work").await;
        change(&f, "trigger_now", &task, json!({})).await;
        let (mut socket, _) = next(&listener).await;
        let (socket, saved) = memory(
            &listener,
            &mut socket,
            json!({"action":"checkpoint","note":{"text":"abandoned-checkpoint-marker"}}),
        )
        .await;
        assert_eq!(saved["staged"], true);
        change(&f, "pause", &task, json!({})).await;
        assert_eq!(
            settled(&f, &task).await["task"]["runs"][0]["outcome"],
            "blocked"
        );
        drop(socket);
        change(&f, "resume", &task, json!({})).await;
        change(&f, "trigger_now", &task, json!({})).await;
        let (mut socket, sent) = next(&listener).await;
        assert!(
            !sent["messages"]
                .to_string()
                .contains("abandoned-checkpoint-marker")
        );
        let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
        assert_eq!(page["records"], json!([]));
        let (mut socket, saved) = memory(&listener, &mut socket, json!({"action":"checkpoint","note":{"text":"Partial investigation; retry the unverified section."}})).await;
        assert_eq!(saved["staged"], true);
        response_with_text(&mut socket, "Interrupted before submitting a result").await;
        loop {
            if detail(&f, &task).await["task"]["runs"].as_array().unwrap().len() == 2 { break; }
            tokio::task::yield_now().await;
        }
        change(&f, "trigger_now", &task, json!({})).await;
        let (mut socket, _) = next(&listener).await;
        let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
        assert_eq!(page["records"].as_array().unwrap().len(), 1);
        assert_eq!(page["records"][0]["content"]["outcome"], "failed");
        assert!(page["records"][0]["content"]["result"].is_null());
        assert_eq!(page["records"][0]["content"]["checkpoint"]["text"], "Partial investigation; retry the unverified section.");
        finish(&mut socket, json!({"kind":"no_report","note":"Recovered investigation progress."})).await;
        close(&f).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn discovery_records_do_not_cross_changed_permissions_or_ordinary_sessions() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (f, bot) = fixture(&listener, false).await;
        let task = create(&f,&bot,"Private observation").await;
        change(&f,"trigger_now",&task,json!({})).await;
        let (mut socket, _) = next(&listener).await;
        finish(&mut socket,json!({"kind":"no_report","note":"private-memory-marker"})).await;
        settled(&f,&task).await;
        f.send(&bot).await.unwrap();
        let (mut socket, _) = next(&listener).await;
        let (mut socket, page) = memory(&listener,&mut socket,json!({"action":"list"})).await;
        let record = page["records"][0]["id"].clone();
        quiet(&f,&listener,&mut socket,&bot).await;
        let before = f.owner.session(&bot).await.unwrap();
        let changed = f.mutation(2,"metadata",json!({"sessionId":bot,"expectedRevision":before.revision,
            "title":before.configuration.title,"labels":[],"permissions":{"settings":{"access":"read_only","requestPermissions":false},"revokeGrants":true}}),Uuid::new_v4()).await.unwrap();
        assert_eq!(changed["kind"],"committed");
        f.send(&bot).await.unwrap();
        let (mut socket, _) = next(&listener).await;
        let (mut socket, page) = memory(&listener,&mut socket,json!({"action":"list"})).await;
        assert_eq!(page["records"],json!([]));
        let (mut socket, rejected) = memory(&listener,&mut socket,json!({"action":"get","record":record})).await;
        assert!(rejected.to_string().contains("discovery_record_unavailable"));
        quiet(&f,&listener,&mut socket,&bot).await;
        let ordinary = f.create("Unrelated session").await;
        f.send(&ordinary).await.unwrap();
        let (mut socket,sent) = next(&listener).await;
        assert!(!names(&sent).contains(&"DiscoveryMemory"));
        response(&mut socket).await;
        close(&f).await;
    }).await.unwrap();
}

#[tokio::test]
async fn discovery_records_withhold_in_sleep_and_preserve_steered_feedback() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (f, bot) = fixture(&listener, false).await;
        let task = create(&f, &bot, "Quiet result").await;
        change(&f, "trigger_now", &task, json!({})).await;
        let (mut socket, _) = next(&listener).await;
        finish(&mut socket, json!({"kind":"report","text":"A possible observation."})).await;
        let (mut socket, _) = next(&listener).await;
        let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
        let record = page["records"][0]["id"].clone();
        let (mut socket, rejected) = memory(&listener, &mut socket,
            json!({"action":"feedback","record":record,"note":"A worker message is not user consent"})).await;
        assert!(rejected.to_string().contains("no_user_feedback_in_turn"));
        service_tools::named_tool_response(&mut socket,"sleep",json!({"discovery":{"record":record,"reason":"Not actionable now; do not interrupt the user."}})).await;
        loop {
            if !f.owner.runs.lock().await.controls.contains_key(&bot) { break; }
            tokio::task::yield_now().await;
        }
        assert!(tokio::time::timeout(Duration::from_millis(150),listener.accept()).await.is_err(), "recording the decision must not require another model step");
        assert_eq!(f.query("botOutbox",json!({})).await.unwrap()["messages"],json!([]));
        f.send(&bot).await.unwrap();
        let (mut socket, _) = next(&listener).await;
        let (mut socket, page) = memory(&listener,&mut socket,json!({"action":"list","related":record})).await;
        assert_eq!(page["records"][0]["content"]["kind"],"withheld", "{page}");
        let quote = json!({"text":"Stop reminders about this finding.","sourceTurnId":null});
        let queued = f.mutation(2,"send",json!({"sessionId":bot,"message":"","quotes":[quote],"delivery":"steer"}),Uuid::new_v4()).await.unwrap();
        assert_eq!(queued["kind"],"queued","{queued}");
        // Steering supersedes the old step before its proposed tool dispatch.
        service_tools::named_tool_response(&mut socket, "DiscoveryMemory", json!({"action":"list"})).await;
        let (mut socket, sent) = next(&listener).await;
        assert!(sent["messages"].to_string().contains("Stop reminders about this finding."));
        let (mut socket, saved) = memory(&listener,&mut socket,json!({"action":"feedback","record":record,"note":"Steered user says stop reminders.","message_id":queued["messageId"]})).await;
        assert_eq!(saved["recorded"],true,"{saved}");
        let (mut socket, source) = memory(&listener,&mut socket,json!({"action":"feedback_source","record":saved["record"]})).await;
        assert!(source["source"].as_str().unwrap().contains("Stop reminders about this finding."));
        quiet(&f,&listener,&mut socket,&bot).await;
        close(&f).await;
    }).await.unwrap();
}

#[tokio::test]
async fn discovery_records_search_continues_past_an_empty_bounded_page() {
    tokio::time::timeout(Duration::from_secs(120), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (f, bot) = fixture(&listener, false).await;
        let task = create(&f,&bot,"Older useful record").await;
        change(&f,"trigger_now",&task,json!({})).await;
        let (mut socket,_) = next(&listener).await;
        finish(&mut socket,json!({"kind":"report","text":"unique-original-search-marker"})).await;
        let (mut socket,_) = next(&listener).await;
        let (mut socket,page) = memory(&listener,&mut socket,json!({"action":"list"})).await;
        let record = page["records"][0]["id"].clone();
        for index in 0..33 {
            let (next_socket, saved) = memory(&listener,&mut socket,json!({"action":"correct","record":record,"note":{"text":format!("Additional observation {index}")}})).await;
            assert_eq!(saved["recorded"],true,"{saved}");
            socket = next_socket;
        }
        let (mut socket,page) = memory(&listener,&mut socket,json!({"action":"list","query":"unique-original-search-marker"})).await;
        assert_eq!(page["records"],json!([]));
        assert!(page["next_before"].is_number(),"empty filtered page is not EOF");
        let (mut socket,page) = memory(&listener,&mut socket,json!({"action":"list","query":"unique-original-search-marker","before":page["next_before"]})).await;
        assert_eq!(page["records"].as_array().unwrap().len(),1);
        assert_eq!(page["records"][0]["id"],record);
        assert!(page["next_before"].is_null());
        quiet(&f,&listener,&mut socket,&bot).await;
        close(&f).await;
    }).await.unwrap();
}

#[tokio::test]
async fn discovery_records_do_not_survive_recall_revocation_as_an_alternate_read_path() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (mut f, bot) = fixture(&listener, false).await;
        let task = create(&f, &bot, "Recall observation").await;
        change(&f, "trigger_now", &task, json!({})).await;
        let (mut socket, _) = next(&listener).await;
        finish(
            &mut socket,
            json!({"kind":"no_report","note":"observation-from-previous-recall-grant"}),
        )
        .await;
        settled(&f, &task).await;
        let deployment = f.app.source().unwrap().deployment;
        f.app.shutdown().await.unwrap();
        let (source, packages, _, _) = f
            .store
            .load_application(deployment)
            .await
            .unwrap()
            .unwrap()
            .into_parts();
        let mut input = source.input;
        input
            .instances
            .get_mut("provider")
            .unwrap()
            .configuration
            .values
            .insert("recall".into(), json!(false));
        f.store
            .commit_application(
                deployment,
                source.reference.revision,
                input,
                source.remote_exports,
                packages,
            )
            .await
            .unwrap();
        reopen(&mut f).await;
        change(&f, "trigger_now", &task, json!({})).await;
        loop {
            let value = detail(&f, &task).await;
            if value["task"]["runs"].as_array().unwrap().len() == 2 {
                assert_eq!(value["task"]["runs"][0]["outcome"], "blocked");
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(150), listener.accept())
                .await
                .is_err()
        );
        f.send(&bot).await.unwrap();
        let (mut socket, sent) = next(&listener).await;
        assert!(
            !sent["messages"]
                .to_string()
                .contains("observation-from-previous-recall-grant")
        );
        let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
        assert_eq!(page["records"], json!([]));
        service_tools::named_tool_response(&mut socket, "sleep", json!({})).await;
        close(&f).await;
    })
    .await
    .unwrap();
}
