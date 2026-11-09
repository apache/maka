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

use super::scheduler_tests::{change, detail, reopen, settled};
use super::*;
use maka_agent_facts::event::Fact;
use maka_capabilities::storage::{Data, Mutation, Namespace, Store};

async fn fixture(listener: &TcpListener, files: bool) -> (Fixture, String) {
    let f = Fixture::configured(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
        None,
        files.then(|| service_tools::Setup::files("readText")),
        |settings| {
            settings.bot = true;
            settings.scheduled_tasks = true;
            settings.recall = true;
        },
    )
    .await;
    let bot = f
        .mutation(2, "openBot", json!({}), Uuid::new_v4())
        .await
        .unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    (f, bot)
}
async fn create(f: &Fixture, bot: &str, title: &str) -> String {
    let boundary = f.owner.session(bot).await.unwrap().configuration;
    let created = f.mutation(2, "schedule", json!({"kind":"create","input":{
        "task":{"title":title, "intentBody":format!("Read authorized material for {title}."),
            "schedule":{"kind":"interval","everySeconds":3600,"startAt":now()+3_600_000},
            "effect":{"kind":"discovery","target":{"sessionId":bot,"workspace":boundary.workspace,
                "permissions":boundary.permissions,"boundaryRevision":boundary.boundary_revision,"binding":boundary.binding},
                "model":f.selection().await,"thinkingLevel":null},"maxFires":null,"expiresAt":null},
        "timezone":"UTC","misfire":"latest"}}), Uuid::new_v4()).await.unwrap();
    assert_eq!(created["kind"], "committed", "{created}");
    created["taskId"].as_str().unwrap().to_owned()
}
fn names(request: &Value) -> Vec<&str> {
    request["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["function"]["name"].as_str().unwrap())
        .collect()
}
async fn finish(socket: &mut TcpStream, report: Value) {
    service_tools::named_tool_response(socket, "DiscoveryComplete", report).await;
}
async fn close(f: &Fixture) {
    f.app.shutdown().await.unwrap();
    f.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn discovery_no_report_is_silent_and_uses_a_read_only_worker_profile() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (f, bot) = fixture(&listener, true).await;
        let id = create(&f, &bot, "Check documents").await;
        change(&f, "trigger_now", &id, json!({})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let tools = names(&sent);
        assert!(
            tools.contains(&"DiscoveryComplete") && tools.contains(&"WorkspaceFile"),
            "{tools:?}"
        );
        assert!(!tools.iter().any(|name| {
            [
                "SendUser",
                "sleep",
                "ScheduledTask",
                "SessionSend",
                "SessionCreate",
                "Bash",
            ]
            .contains(name)
        }));
        assert!(!sent["messages"].to_string().contains("persistent Bot"));
        assert_eq!(
            detail(&f, &id).await["task"]["runs"],
            json!([]),
            "admission is not completion"
        );
        finish(
            &mut socket,
            json!({"kind":"no_report","note":"Checked authorized documents; no material change."}),
        )
        .await;
        let done = settled(&f, &id).await;
        assert_eq!(done["task"]["runs"][0]["message"], "No report");
        let worker = done["task"]["runs"][0]["sessionId"].as_str().unwrap();
        let config = f.owner.session(worker).await.unwrap().configuration;
        assert_eq!(config.permissions.access, WorkspaceAccess::ReadOnly);
        assert!(!config.permissions.request_permissions);
        assert_eq!(config.parent_session_id.as_deref(), Some(bot.as_str()));
        assert!(f.owner.bot.is(&bot) && !f.owner.bot.is(worker));
        assert_eq!(
            f.query("botOutbox", json!({})).await.unwrap()["messages"],
            json!([])
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(150), listener.accept())
                .await
                .is_err()
        );
        close(&f).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn discovery_reports_the_recorded_result_once_and_reopens_after_lost_scheduler_settlement() {
    tokio::time::timeout(Duration::from_secs(75), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (mut f, bot) = fixture(&listener, false).await;
        let id = create(&f, &bot, "Source finding").await;
        change(&f, "trigger_now", &id, json!({})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        let storage = maka_host_runtime::storage::Storage::new(
            f.store.clone(),
            f.owner.prefix.clone(),
            Namespace::new(
                "maka.agent.scheduler",
                maka_plugin_core::scope::Scope::Profile,
            )
            .unwrap(),
        );
        let key = format!("task:{id}");
        let frozen = storage
            .read(key.clone())
            .await
            .unwrap()
            .unwrap()
            .data
            .value()
            .unwrap()
            .clone();
        finish(
            &mut socket,
            json!({"kind":"report","text":"Verified discovery-marker from README.md."}),
        )
        .await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(
            sent["messages"]
                .to_string()
                .contains("Verified discovery-marker from README.md.")
        );
        assert!(names(&sent).contains(&"SendUser"));
        assert!(!names(&sent).contains(&"DiscoveryComplete"));
        service_tools::named_tool_response(
            &mut socket,
            "SendUser",
            json!({"messageId":"discovery-answer","messages":[{"text":"Found discovery-marker."}]}),
        )
        .await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        service_tools::named_tool_response(&mut socket, "sleep", json!({})).await;
        let done = settled(&f, &id).await;
        let run = done["task"]["runs"][0].clone();
        assert_eq!(run["message"], "Report admitted to Bot");
        f.app.shutdown().await.unwrap();
        // Reproduce the durable cut: result and Bot admission succeeded, but
        // the scheduler's acknowledgement of its original fire was lost.
        let current = storage.read(key.clone()).await.unwrap().unwrap();
        storage
            .batch(vec![Mutation {
                key,
                expected_revision: Some(current.revision),
                data: Data::Present(frozen),
            }])
            .await
            .unwrap();
        reopen(&mut f).await;
        let recovered = settled(&f, &id).await;
        assert_eq!(recovered["task"]["runs"][0], run);
        assert_eq!(recovered["task"]["fireCount"], 1);
        let outbox = f.query("botOutbox", json!({})).await.unwrap();
        assert_eq!(outbox["messages"].as_array().unwrap().len(), 1, "{outbox}");
        assert!(
            tokio::time::timeout(Duration::from_millis(200), listener.accept())
                .await
                .is_err(),
            "recovery must not call a model again"
        );
        close(&f).await;
        storage.finish().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn discovery_serializes_investigations_and_starts_a_fresh_session_for_each_fire() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (f, bot) = fixture(&listener, false).await;
        let a = create(&f, &bot, "A").await;
        let b = create(&f, &bot, "B").await;
        change(&f, "trigger_now", &a, json!({})).await;
        let (mut first, _) = listener.accept().await.unwrap();
        request(&mut first).await;
        change(&f, "trigger_now", &b, json!({})).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(200), listener.accept())
                .await
                .is_err(),
            "second investigation must wait"
        );
        finish(&mut first, json!({"kind":"no_report","note":"A checked"})).await;
        let (mut second, _) = listener.accept().await.unwrap();
        let sent = request(&mut second).await;
        assert!(sent["messages"].to_string().contains("material for B"));
        finish(&mut second, json!({"kind":"no_report","note":"B checked"})).await;
        let first = settled(&f, &a).await["task"]["runs"][0].clone();
        let second = settled(&f, &b).await["task"]["runs"][0].clone();
        assert_ne!(first["sessionId"], second["sessionId"]);
        change(&f, "trigger_now", &a, json!({})).await;
        let (mut third, _) = listener.accept().await.unwrap();
        let sent = request(&mut third).await;
        assert!(
            !sent["messages"].to_string().contains("A checked"),
            "new cycle must not copy the previous worker history"
        );
        finish(
            &mut third,
            json!({"kind":"no_report","note":"A checked again"}),
        )
        .await;
        loop {
            let done = detail(&f, &a).await;
            if done["task"]["runs"].as_array().unwrap().len() == 2 {
                assert_ne!(done["task"]["runs"][0]["sessionId"], first["sessionId"]);
                break;
            }
            tokio::task::yield_now().await;
        }
        close(&f).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn discovery_plain_text_completion_is_failed_not_a_silent_success() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (f, bot) = fixture(&listener, false).await;
        let id = create(&f, &bot, "Incomplete result").await;
        change(&f, "trigger_now", &id, json!({})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response_with_text(&mut socket, "No findings; forgot the completion tool.").await;
        let done = settled(&f, &id).await;
        assert_eq!(done["task"]["runs"][0]["outcome"], "failed");
        assert_eq!(
            done["task"]["runs"][0]["message"],
            "Investigation ended without DiscoveryComplete"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(150), listener.accept())
                .await
                .is_err()
        );
        close(&f).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn discovery_pause_discards_an_unsent_report_while_the_bot_is_busy() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (f, bot) = fixture(&listener, false).await;
        f.send(&bot).await.unwrap();
        let (mut bot_socket, _) = listener.accept().await.unwrap();
        request(&mut bot_socket).await;
        let id = create(&f, &bot, "Cancel pending report").await;
        change(&f, "trigger_now", &id, json!({})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        finish(
            &mut socket,
            json!({"kind":"report","text":"Do not deliver this cancelled report."}),
        )
        .await;
        // Wait for the canonical worker terminal while its report cannot reach the busy Bot.
        loop {
            let invocation = f
                .owner
                .scheduler
                .investigation
                .read()
                .unwrap()
                .clone()
                .unwrap();
            let terminal = f
                .store
                .session(&invocation.session_id)
                .await
                .unwrap()
                .turn_boundary(&invocation.session_id, &invocation.turn_id)
                .await
                .unwrap();
            if terminal.is_some_and(|b| {
                matches!(
                    b.state,
                    maka_event_log::turns::InvocationState::Ended { .. }
                )
            }) {
                break;
            }
            tokio::task::yield_now().await;
        }
        change(&f, "pause", &id, json!({})).await;
        let done = settled(&f, &id).await;
        assert_eq!(done["task"]["runs"][0]["outcome"], "blocked");
        service_tools::named_tool_response(&mut bot_socket, "sleep", json!({})).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(200), listener.accept())
                .await
                .is_err()
        );
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
async fn discovery_restart_reconciles_an_interrupted_worker_without_repeating_it() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (mut f, bot) = fixture(&listener, false).await;
        let id = create(&f, &bot, "Interrupted investigation").await;
        change(&f, "trigger_now", &id, json!({})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        let original = f
            .owner
            .scheduler
            .investigation
            .read()
            .unwrap()
            .clone()
            .unwrap();
        f.app.shutdown().await.unwrap();
        drop(socket);
        reopen(&mut f).await;
        let done = settled(&f, &id).await;
        assert_eq!(done["task"]["runs"][0]["sessionId"], original.session_id);
        assert_eq!(done["task"]["runs"][0]["outcome"], "failed");
        let facts = service_tools::facts(&f, &original.session_id).await;
        assert_eq!(
            facts
                .iter()
                .filter(|fact| matches!(
                    fact,
                    maka_agent_facts::event::Fact::InvocationOpened { .. }
                ))
                .count(),
            1
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(200), listener.accept())
                .await
                .is_err()
        );
        close(&f).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn discovery_one_shot_timer_runs_without_a_manual_trigger() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (f, bot) = fixture(&listener, false).await;
        let boundary = f.owner.session(&bot).await.unwrap().configuration;
        let created = f.mutation(2, "schedule", json!({"kind":"create","input":{
            "task":{"title":"Timed discovery","intentBody":"Check once.",
                "schedule":{"kind":"once","runAt":now()+2000},
                "effect":{"kind":"discovery","target":{"sessionId":bot,"workspace":boundary.workspace,
                    "permissions":boundary.permissions,"boundaryRevision":boundary.boundary_revision,"binding":boundary.binding},
                    "model":f.selection().await,"thinkingLevel":null},"maxFires":null,"expiresAt":null},
            "timezone":"UTC","misfire":"latest"}}), Uuid::new_v4()).await.unwrap();
        assert_eq!(created["kind"], "committed", "{created}");
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(names(&sent).contains(&"DiscoveryComplete"));
        finish(&mut socket, json!({"kind":"no_report","note":"Timed check completed."})).await;
        let done = settled(&f, created["taskId"].as_str().unwrap()).await;
        assert_eq!(done["task"]["status"], "completed");
        assert_eq!(done["task"]["fireCount"], 1);
        close(&f).await;
    }).await.unwrap();
}

#[tokio::test]
async fn discovery_model_proposals_require_the_bot_and_human_approval() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (f, bot) = fixture(&listener, false).await;
        let ordinary = f.create("Ordinary conversation").await;
        let proposal = json!({"request":{"mode":"create","title":"Read-only discovery proposal",
            "intentBody":"Check authorized documents.","effect":"discovery",
            "schedule":{"kind":"interval","everySeconds":3600,"startAt":now()+3_600_000},"timezone":"UTC"}});
        f.send(&ordinary).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(!names(&sent).contains(&"DiscoveryComplete"));
        recall_tests::tool(&mut socket, "ScheduledTask", proposal.clone()).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(sent.to_string().contains("discovery_requires_bot"));
        response(&mut socket).await;
        assert_eq!(f.query("schedules", json!({"kind":"list"})).await.unwrap()["tasks"], json!([]));

        f.send(&bot).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        recall_tests::tool(&mut socket, "ScheduledTask", proposal).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        let page = f.query("schedules", json!({"kind":"list"})).await.unwrap();
        let task = &page["tasks"][0];
        let id = task["id"].as_str().unwrap();
        assert_eq!(task["status"], "paused");
        assert_eq!(task["approved"], false);
        recall_tests::tool(&mut socket, "ScheduledTask", json!({"request":{"mode":"resume","taskId":id,"revision":task["revision"]}})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        assert!(request(&mut socket).await.to_string().contains("scheduler_user_approval_required"));
        service_tools::named_tool_response(&mut socket, "sleep", json!({})).await;
        assert_eq!(change(&f, "approve", id, json!({})).await["kind"], "committed");
        change(&f, "trigger_now", id, json!({})).await;
        let (mut worker, _) = listener.accept().await.unwrap();
        assert!(names(&request(&mut worker).await).contains(&"DiscoveryComplete"));
        finish(&mut worker, json!({"kind":"no_report","note":"Checked after approval."})).await;
        assert_eq!(settled(&f, id).await["task"]["runs"][0]["outcome"], "ok");
        close(&f).await;
    }).await.unwrap();
}

#[tokio::test]
async fn discovery_handoff_keeps_the_original_turn_and_pause_stops_its_successor() {
    use maka_agent_facts::handoff::HandoffIntent;
    tokio::time::timeout(Duration::from_secs(90), async {
        for action in ["complete", "pause", "route_changed"] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let (mut f, bot) = fixture(&listener, true).await;
            std::fs::write(f.workspace.join("discovery.txt"), "verified handoff-marker").unwrap();
            let id = create(&f, &bot, "Transfer investigation").await;
            change(&f, "trigger_now", &id, json!({})).await;
            let (mut first, _) = listener.accept().await.unwrap();
            request(&mut first).await;
            let original = f.owner.scheduler.investigation.read().unwrap().clone().unwrap();
            let control = f.owner.runs.lock().await.controls[&original.session_id].clone();
            let reservation = control.handoff.as_ref().unwrap().reserve(HandoffIntent {
                handoff_id:"discovery-transfer".into(), host_epoch:"test-host".into(),
                root_run_id:original.run_id.clone(), successor_run_id:"discovery-successor-run".into(),
                successor_invocation_id:"discovery-successor-invocation".into(), claim_id:"discovery-transfer-claim".into(),
            }).unwrap();
            service_tools::named_tool_response(&mut first, "WorkspaceFile", json!({"path":f.workspace.join("discovery.txt")})).await;
            let held = reservation.ready().await.unwrap();
            let owner = f.owner.clone();
            let gate = owner.scheduler.gate.lock().await;
            held.commit().unwrap().wait().await.unwrap();
            owner.stop.cancel();
            drop(gate);
            if action == "route_changed" {
                selection::edit(&f, |changes| {
                    changes.configuration = Some(json!({"baseUrl":"http://127.0.0.1:1/v1"}));
                }).await;
            }
            reopen(&mut f).await;
            if action != "route_changed" {
                let (mut successor, _) = listener.accept().await.unwrap();
                let sent = request(&mut successor).await;
                assert!(sent["messages"].to_string().contains("verified handoff-marker"));
                assert!(names(&sent).contains(&"DiscoveryComplete"));
                if action == "pause" {
                    change(&f, "pause", &id, json!({})).await;
                } else {
                    finish(&mut successor, json!({"kind":"no_report","note":"Investigation continued from its recorded read."})).await;
                }
            }
            let done = settled(&f, &id).await;
            let expected = match action { "pause" => "blocked", "route_changed" => "failed", _ => "ok" };
            assert_eq!(done["task"]["runs"][0]["outcome"], expected);
            assert_eq!(done["task"]["runs"][0]["sessionId"], original.session_id);
            assert_eq!(done["task"]["runs"][0]["runId"], original.run_id);
            let facts = service_tools::facts(&f, &original.session_id).await;
            // Cancellation closes the reserved successor with canonical facts too.
            assert_eq!(facts.iter().filter(|fact| matches!(fact, Fact::InvocationOpened { .. })).count(), 2);
            if action == "route_changed" {
                assert_eq!(facts.iter().filter(|fact| matches!(fact, Fact::ModelRequested { .. })).count(), 1);
            }
            assert_eq!(facts.iter().filter(|fact| matches!(fact, Fact::ToolDispatched { name, .. } if name == "WorkspaceFile")).count(), 1);
            assert!(tokio::time::timeout(Duration::from_millis(150), listener.accept()).await.is_err());
            close(&f).await;
        }
    }).await.unwrap();
}
