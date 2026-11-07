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
use maka_agent_facts::{event::Fact, message::MessageOrigin};

async fn bot_fixture(base: &str) -> Fixture {
    Fixture::configured(base, None, None, None, |settings| {
        settings.bot = true;
        settings.todo = true;
        settings.scheduled_tasks = true;
    })
    .await
}
async fn open(f: &Fixture) -> Value {
    let workspace = f.create_input("Bot").await["workspace"].clone();
    f.mutation(2, "openBot", json!({"workspace":workspace}), Uuid::new_v4())
        .await
        .unwrap()
}
fn tool_names(sent: &Value) -> Vec<String> {
    sent["tools"]
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool["function"]["name"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}
fn last_tool_result(sent: &Value) -> String {
    sent["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .map(|message| message["content"].to_string())
        .unwrap_or_default()
}
async fn outbox(f: &Fixture) -> Value {
    f.query("botOutbox", json!({})).await.unwrap()
}
async fn idle(f: &Fixture, session: &str) {
    for _ in 0..400 {
        let active = f.owner.runs.lock().await.controls.contains_key(session);
        if !active
            && f.session(session)
                .await
                .pending_messages(session)
                .await
                .unwrap()
                .is_empty()
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("session did not become idle");
}

#[tokio::test]
async fn bot_mode_is_off_by_default() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::new(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
        )
        .await;
        assert_eq!(
            open(&f).await,
            json!({"kind":"rejected","reason":"disabled"})
        );
        let empty = outbox(&f).await;
        assert_eq!(empty["enabled"], false);
        assert_eq!(empty["messages"], json!([]));
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

async fn sees_send_user(f: &Fixture, listener: &TcpListener, session: &str) -> bool {
    f.send(session).await.unwrap();
    let (mut socket, _) = listener.accept().await.unwrap();
    let sent = request(&mut socket).await;
    response(&mut socket).await;
    idle(f, session).await;
    tool_names(&sent).contains(&"SendUser".to_owned())
}

#[tokio::test]
async fn bot_identity_alone_grants_send_user() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = bot_fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let opened = open(&f).await;
        assert_eq!(opened["kind"], "opened");
        assert_eq!(opened["created"], true);
        let bot = opened["sessionId"].as_str().unwrap().to_owned();
        assert_eq!(open(&f).await, json!({"kind":"opened","sessionId":bot,"created":false}));

        // The Bot's tool list is coordination only; SendUser is granted by identity.
        let tools = f.owner.session(&bot).await.unwrap().configuration.tools.unwrap();
        assert!(!tools.iter().any(|name| name == "SendUser"), "{tools:?}");
        assert!(tools.iter().all(|name| crate::owner::bot::COORDINATION_TOOLS.contains(&name.as_str())), "{tools:?}");
        assert!(sees_send_user(&f, &listener, &bot).await);

        // Ordinary creation cannot request SendUser.
        let mut input = f.create_input("Impostor").await;
        input["tools"] = json!(["SendUser"]);
        assert_eq!(f.mutation(2, "create", input, Uuid::new_v4()).await.unwrap()["kind"], "rejected");

        // Ordinary, derived and forked Sessions are not the Bot.
        let ordinary = f.create("Ordinary").await;
        assert!(!sees_send_user(&f, &listener, &ordinary).await);
        let derived = f
            .mutation(2, "create", json!({"title":"Derived","labels":[],"workspace":{"kind":"session","sessionId":bot}}), Uuid::new_v4())
            .await
            .unwrap()["session"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(!f.owner.bot.is(&derived));
        assert!(!sees_send_user(&f, &listener, &derived).await);
        let first = f.mutation(2, "send", json!({"sessionId":bot,"message":"a turn to fork","backend":model_backend(&f.selection().await)}), Uuid::new_v4()).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response(&mut socket).await;
        idle(&f, &bot).await;
        let turn = f.session(&bot).await.invocation_boundary(&bot, first["invocationId"].as_str().unwrap())
            .await.unwrap().unwrap().0.invocation.turn_id;
        let revision = f.owner.session(&bot).await.unwrap().revision;
        let forked = f
            .mutation(2, "fork", json!({"sessionId":bot,"expectedRevision":revision,"position":{"kind":"through_turn","turnId":turn},"title":"Fork","labels":[]}), Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(forked["kind"], "forked", "{forked}");
        let forked = forked["session"]["id"].as_str().unwrap().to_owned();
        assert!(!f.owner.bot.is(&forked));
        assert!(!sees_send_user(&f, &listener, &forked).await);
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn a_replaced_bot_keeps_its_replies_readable_without_its_authority() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = bot_fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let old = open(&f).await["sessionId"].as_str().unwrap().to_owned();
        f.send(&old).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        service_tools::named_tool_response(
            &mut socket,
            "SendUser",
            json!({"messageId":"m1","messages":[{"text":"Said before the replacement."}]}),
        )
        .await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response(&mut socket).await;
        idle(&f, &old).await;

        let revision = f.owner.session(&old).await.unwrap().revision;
        let archived = f
            .mutation(
                2,
                "changeSession",
                json!({"sessionId":old,"expectedRevision":revision,"action":"archive"}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(archived["kind"], "changed", "{archived}");
        let new = open(&f).await["sessionId"].as_str().unwrap().to_owned();
        assert_ne!(new, old);

        // The old Bot is still a Bot and its replies are still there.
        let read = f
            .query("botOutbox", json!({"sessionId":old}))
            .await
            .unwrap();
        assert_eq!(read["isBot"], true, "{read}");
        assert_eq!(
            read["sessionId"], new,
            "the current Bot is still the new one"
        );
        assert_eq!(read["messages"][0]["text"], "Said before the replacement.");
        // The current Bot has none of them, and an ordinary Session is no Bot.
        let current = outbox(&f).await;
        assert_eq!(current["isBot"], true);
        assert_eq!(current["messages"], json!([]));
        let ordinary = f.create("Ordinary").await;
        let read = f
            .query("botOutbox", json!({"sessionId":ordinary}))
            .await
            .unwrap();
        assert_eq!(read["isBot"], false, "{read}");
        assert_eq!(read["messages"], json!([]));
        // Being readable gives the old Bot nothing back: it cannot be sent to, and it is
        // not the Bot, so it would not hold SendUser either.
        assert!(!f.owner.bot.is(&old));
        assert!(
            f.send(&old).await.is_err(),
            "an archived former Bot accepts no message"
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn new_conversation_from_bot_uses_installed_tools_in_the_same_workspace() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            Some(service_tools::Setup::files("readText")),
            |settings| {
                settings.bot = true;
                settings.todo = true;
            },
        ).await;
        let opened = open(&f).await;
        let bot = opened["sessionId"].as_str().unwrap();
        let bot_configuration = f.owner.session(bot).await.unwrap().configuration;
        assert!(!bot_configuration.tools.as_ref().unwrap().iter().any(|name| name == "WorkspaceFile"));
        let created = f.mutation(
            2, "create",
            json!({"title":"New conversation", "labels":[], "workspace":{"kind":"session","sessionId":bot}}),
            Uuid::new_v4(),
        ).await.unwrap();
        assert_eq!(created["kind"], "created");
        let session = created["session"]["id"].as_str().unwrap();
        let configuration = f.owner.session(session).await.unwrap().configuration;
        assert!(configuration.tools.is_none(), "a workspace reference must not copy the Bot tool ceiling");
        assert_eq!(configuration.workspace, bot_configuration.workspace);
        f.send(session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let names = tool_names(&request(&mut socket).await);
        assert!(names.iter().any(|name| name == "WorkspaceFile"), "{names:?}");
        assert!(!names.iter().any(|name| name == "SendUser"), "{names:?}");
        response(&mut socket).await;
        idle(&f, session).await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn bot_tools_follow_the_current_composition_not_the_list_stored_at_creation() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            None,
            |settings| {
                settings.bot = true;
                settings.tools = vec![
                    session_tool("create", "SessionCreate"),
                    session_tool("send", "SessionSend"),
                ];
            },
        )
        .await;
        let bot = open(&f).await["sessionId"].as_str().unwrap().to_owned();
        // A Bot opened by an older build holds a shorter list.
        let original = f.owner.session(&bot).await.unwrap();
        f.session(&bot)
            .await
            .update_session_metadata(
                &bot,
                original.revision,
                |configuration: &mut StoredSessionConfiguration| {
                    configuration.tools = Some(vec!["todo_read".into()]);
                    Ok(())
                },
            )
            .await
            .unwrap();
        let accepted = f.send(&bot).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let stopped = f
            .mutation(
                2,
                "stop",
                json!({"sessionId":bot,"invocationId":accepted["invocationId"]}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(stopped["requested"], true);
        idle(&f, &bot).await;
        let source = f
            .query(
                "execution",
                json!({"sessionId":bot,"invocationId":accepted["invocationId"]}),
            )
            .await
            .unwrap();
        assert_eq!(source["execution"]["state"], "cancelled");
        let resumed = f
            .mutation(
                2,
                "resume",
                json!({
                    "sessionId":bot,
                    "sourceInvocationId":accepted["invocationId"],
                    "sourceHighWater":source["execution"]["highWater"],
                    "model":f.selection().await,
                }),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(resumed["kind"], "started", "{resumed}");
        let (mut socket, _) = listener.accept().await.unwrap();
        let replay = request(&mut socket).await;
        let queued = f
            .mutation(
                2,
                "send",
                json!({
                    "sessionId": bot,
                    "message": "queued then promoted on resumed bot",
                    "delivery": "queue",
                    "backend": model_backend(&f.selection().await),
                }),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(queued["kind"], "queued", "{queued}");
        let promoted = f
            .mutation(
                2,
                "editQueue",
                json!({
                    "sessionId": bot,
                    "expectedRevision": queued["revision"],
                    "edit": { "kind": "promote", "messageId": queued["messageId"] },
                }),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(promoted["kind"], "committed", "{promoted}");
        response(&mut socket).await;
        let (mut steered_socket, _) = listener.accept().await.unwrap();
        let steered = request(&mut steered_socket).await;
        response(&mut steered_socket).await;
        idle(&f, &bot).await;
        for sent in [&sent, &replay, &steered] {
            let names = tool_names(sent);
            for name in ["SessionCreate", "SessionSend", "SendUser", "sleep"] {
                assert!(
                    names.iter().any(|held| held == name),
                    "{name} missing: {names:?}"
                );
            }
            assert!(
                !names.iter().any(|name| name == "WorkspaceFile"),
                "{names:?}"
            );
            let prompt = sent["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|message| message["role"] == "system" || message["role"] == "developer")
                .map(|message| message["content"].to_string())
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                prompt.contains("SessionSend"),
                "the standing instructions name the derived tools"
            );
        }
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn bot_opened_from_a_restricted_session_still_speaks() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = bot_fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let mut input = f.create_input("Restricted").await;
        input["tools"] = json!(["todo_read"]);
        let restricted = f
            .mutation(2, "create", input, Uuid::new_v4())
            .await
            .unwrap()["session"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let opened = f
            .mutation(
                2,
                "openBot",
                json!({"workspace":{"kind":"session","sessionId":restricted}}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(opened["kind"], "opened", "{opened}");
        let bot = opened["sessionId"].as_str().unwrap().to_owned();
        assert!(sees_send_user(&f, &listener, &bot).await);
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_and_retried_first_opens_leave_one_bot_session() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = bot_fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let workspace = f.create_input("Bot").await["workspace"].clone();
        let retried = Uuid::new_v4();
        let (a, b, c) = tokio::join!(
            f.mutation(2, "openBot", json!({"workspace":workspace}), retried),
            f.mutation(2, "openBot", json!({"workspace":workspace}), Uuid::new_v4()),
            f.mutation(2, "openBot", json!({"workspace":workspace}), Uuid::new_v4()),
        );
        let (a, b, c) = (a.unwrap(), b.unwrap(), c.unwrap());
        let bot = a["sessionId"].clone();
        assert_eq!(b["sessionId"], bot, "{a} {b}");
        assert_eq!(c["sessionId"], bot, "{a} {c}");
        let created = [&a, &b, &c].iter().filter(|r| r["created"] == true).count();
        assert_eq!(created, 1, "{a} {b} {c}");
        // A retry of an operation returns the same Bot.
        assert_eq!(
            f.mutation(2, "openBot", json!({"workspace":workspace}), retried)
                .await
                .unwrap()["sessionId"],
            bot
        );
        let listed = f
            .query("list", json!({"filter":"all","position":{"kind":"start"}}))
            .await
            .unwrap();
        let bots = listed.to_string().matches("\"title\":\"Bot\"").count();
        assert_eq!(bots, 1, "{listed}");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn send_user_is_the_only_voice_idempotent_and_durable() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut f = bot_fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let bot = open(&f).await["sessionId"].as_str().unwrap().to_owned();
        f.send(&bot).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        let first = json!({"messageId":"m1","messages":[{"text":"CI is green."},{"text":"PR #123 needs review."}]});
        service_tools::named_tool_response(&mut socket, "SendUser", first.clone()).await;

        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(last_tool_result(&sent).contains("Sent 2 message(s)"), "{}", last_tool_result(&sent));
        // A retry with the same id and content is not sent again.
        service_tools::named_tool_response(&mut socket, "SendUser", first).await;

        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(last_tool_result(&sent).contains("Already sent"), "{}", last_tool_result(&sent));
        // The same id with different content is refused.
        service_tools::named_tool_response(&mut socket, "SendUser", json!({"messageId":"m1","messages":[{"text":"Something else"}]})).await;

        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(last_tool_result(&sent).contains("different content"), "{}", last_tool_result(&sent));
        // Ordinary assistant text stays internal.
        response_with_text(&mut socket, "Internal reasoning that must not reach the user").await;
        idle(&f, &bot).await;

        let page = outbox(&f).await;
        assert_eq!(page["enabled"], true);
        assert_eq!(page["sessionId"], bot);
        assert_eq!(page["through"], 2);
        let texts: Vec<_> = page["messages"].as_array().unwrap().iter().map(|m| (m["sequence"].as_u64().unwrap(), m["text"].as_str().unwrap().to_owned())).collect();
        assert_eq!(texts, vec![(1, "CI is green.".to_owned()), (2, "PR #123 needs review.".to_owned())]);
        assert!(!page.to_string().contains("Internal reasoning"));
        let turn = f.owner.runs.lock().await.controls.get(&bot).map(|c| c.invocation.turn_id.clone());
        assert!(turn.is_none(), "the turn has ended");
        let turns: std::collections::BTreeSet<_> = page["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["turnId"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(turns.len(), 1, "both messages belong to the turn that sent them");
        assert_eq!(f.query("botOutbox", json!({"after":1})).await.unwrap()["messages"].as_array().unwrap().len(), 1);

        // The outbox and the Bot record survive a restart.
        super::todo_tests::reopen(&mut f).await;
        assert_eq!(outbox(&f).await["messages"], page["messages"]);
        assert_eq!(open(&f).await, json!({"kind":"opened","sessionId":bot,"created":false}));
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

/// A tool dispatched but never settled leaves an unknown outcome. A delegated
/// worker result must still wake the Bot; an ordinary Session keeps the
/// stricter protection.
async fn origin_wake_after_unknown_outcome(bot_mode: bool) -> bool {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = bot_fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
    let session = if bot_mode {
        open(&f).await["sessionId"].as_str().unwrap().to_owned()
    } else {
        f.create("Ordinary").await
    };
    let raw: Vec<_> = f
        .runtime_databases()
        .into_iter()
        .map(|path| rusqlite::Connection::open(path).unwrap())
        .collect();
    for db in &raw {
        db.execute_batch("CREATE TRIGGER hold_settle BEFORE INSERT ON event_log WHEN NEW.kind='tool_settled' BEGIN SELECT RAISE(ABORT, 'crash before settle'); END;").unwrap();
    }
    f.send(&session).await.unwrap();
    let (mut socket, _) = listener.accept().await.unwrap();
    request(&mut socket).await;
    let invocation = f
        .owner
        .runs
        .lock()
        .await
        .controls
        .get(&session)
        .unwrap()
        .invocation
        .clone();
    let route = f.owner.return_route(&invocation).await.unwrap();
    service_tools::named_tool_response(
        &mut socket,
        "todo_write",
        json!({"todos":[{"content":"x","status":"pending"}]}),
    )
    .await;
    for _ in 0..400 {
        if !f.owner.runs.lock().await.controls.contains_key(&session) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let facts = service_tools::facts(&f, &session).await;
    assert!(
        facts
            .iter()
            .any(|fact| matches!(fact, Fact::ToolDispatched { name, .. } if name == "todo_write"))
    );
    assert!(
        !facts
            .iter()
            .any(|fact| matches!(fact, Fact::ToolSettled { .. }))
    );
    for db in &raw {
        db.execute_batch("DROP TRIGGER hold_settle").unwrap();
    }
    drop(raw);
    let admission = f
        .owner
        .prepare_notification(
            &invocation,
            &route,
            "unknown-outcome-wake",
            |_| "Delegated task finished".into(),
            MessageOrigin::BotWorker {
                session_id: "worker-1".into(),
            },
        )
        .await
        .unwrap()
        .expect("idle session accepts a notification");
    assert!(f.owner.admit_notification(&admission).await.unwrap());
    let reached = match tokio::time::timeout(Duration::from_secs(6), listener.accept()).await {
        Ok(accepted) => {
            let (mut socket, _) = accepted.unwrap();
            let sent = request(&mut socket).await;
            assert!(
                sent.to_string().contains("outcome_unknown"),
                "the model is told about the unknown outcome"
            );
            response(&mut socket).await;
            idle(&f, &session).await;
            true
        }
        Err(_) => false,
    };
    f.app.shutdown().await.unwrap();
    f.config.shutdown().await.unwrap();
    reached
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bot_and_ordinary_sessions_process_notifications_after_unknown_tool_outcomes() {
    tokio::time::timeout(Duration::from_secs(90), async {
        assert!(
            origin_wake_after_unknown_outcome(true).await,
            "Bot Session must continue"
        );
        assert!(
            origin_wake_after_unknown_outcome(false).await,
            "ordinary sessions also receive the unknown outcome and continue"
        );
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn input_while_the_bot_runs_is_queued_not_rejected() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = bot_fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let bot = open(&f).await["sessionId"].as_str().unwrap().to_owned();
        f.send(&bot).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        let queued = f
            .mutation(
                2,
                "send",
                json!({"sessionId":bot,"message":"one more thing","backend":model_backend(&f.selection().await)}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert!(queued["messageId"].is_string(), "{queued}");
        response(&mut socket).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(sent.to_string().contains("one more thing"));
        response(&mut socket).await;
        idle(&f, &bot).await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn outbox_keeps_every_call_and_pages_by_cursor() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = bot_fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let bot = open(&f).await["sessionId"].as_str().unwrap().to_owned();
        f.send(&bot).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        // No count limit: one call records 150 messages.
        let many: Vec<_> = (1..=150)
            .map(|n| json!({"text":format!("message {n}")}))
            .collect();
        service_tools::named_tool_response(
            &mut socket,
            "SendUser",
            json!({"messageId":"bulk","messages":many}),
        )
        .await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        service_tools::named_tool_response(
            &mut socket,
            "SendUser",
            json!({"messageId":"bulk","messages":[{"text":"other"}]}),
        )
        .await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(last_tool_result(&sent).contains("different content"));
        response(&mut socket).await;
        idle(&f, &bot).await;

        let first = f.query("botOutbox", json!({})).await.unwrap();
        assert_eq!(first["through"], 150);
        assert_eq!(first["messages"].as_array().unwrap().len(), 100);
        assert_eq!(first["messages"][0]["sequence"], 1);
        assert_eq!(first["nextAfter"], 100);
        let second = f.query("botOutbox", json!({"after":100})).await.unwrap();
        assert_eq!(second["messages"].as_array().unwrap().len(), 50);
        assert_eq!(second["messages"][49]["text"], "message 150");
        assert!(second["nextAfter"].is_null());
        let head = f.query("botOutbox", json!({"limit":0})).await.unwrap();
        assert_eq!(head["through"], 150);
        assert_eq!(head["sessionId"], bot);
        assert_eq!(head["messages"], json!([]));
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn only_the_bot_session_carries_bot_instructions() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = bot_fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let bot = open(&f).await["sessionId"].as_str().unwrap().to_owned();
        let ordinary = f.create("Ordinary").await;
        let mut prompts = Vec::new();
        for session in [&bot, &ordinary] {
            f.send(session).await.unwrap();
            let (mut socket, _) = listener.accept().await.unwrap();
            let sent = request(&mut socket).await;
            response(&mut socket).await;
            idle(&f, session).await;
            prompts.push(sent["messages"].to_string());
        }
        let instructed = |text: &str| {
            text.contains("persistent Bot")
                || text.contains("常驻 Bot")
                || text.contains("常駐 Bot")
        };
        assert!(instructed(&prompts[0]), "{}", prompts[0]);
        assert!(
            prompts[0].contains("cannot read or edit files"),
            "the Bot is told what it cannot do"
        );
        // This fixture has no delegation tools, so the Bot must not be told to delegate.
        assert!(
            !prompts[0].contains("SessionCreate") && prompts[0].contains("ScheduledTask"),
            "the Bot is told only about tools it holds"
        );
        assert!(!instructed(&prompts[1]), "{}", prompts[1]);
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn send_user_is_visible_from_the_first_request_with_tool_discovery() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            None,
            |settings| {
                settings.bot = true;
                settings.todo = true;
                settings.tool_discovery = true;
            },
        )
        .await;
        let bot = open(&f).await["sessionId"].as_str().unwrap().to_owned();
        f.send(&bot).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        response(&mut socket).await;
        idle(&f, &bot).await;
        let send_user = sent["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["function"]["name"] == "SendUser")
            .unwrap_or_else(|| panic!("SendUser is deferred: {:?}", tool_names(&sent)));
        assert!(
            send_user["function"]["description"]
                .as_str()
                .unwrap()
                .contains("only way")
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

async fn bot_count(f: &Fixture) -> usize {
    let listed = f
        .query("list", json!({"filter":"all","position":{"kind":"start"}}))
        .await
        .unwrap();
    listed.to_string().matches("\"title\":\"Bot\"").count()
}

#[tokio::test]
async fn an_interrupted_claim_is_taken_over() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = bot_fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        // A claim whose creator is gone (interrupted, or from an earlier run).
        f.owner
            .bot
            .claim_for_test("ma_interrupted_creator", false)
            .await;
        let opened = open(&f).await;
        assert_eq!(opened["kind"], "opened", "{opened}");
        assert_eq!(opened["created"], true);
        assert_ne!(opened["sessionId"], "ma_interrupted_creator");
        assert_eq!(bot_count(&f).await, 1);
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_live_slow_creator_keeps_its_claim() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = bot_fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        // A creator still working on its Session, well past the old five-second wait.
        f.owner.bot.claim_for_test("ma_slow_creator", true).await;
        let workspace = f.create_input("Bot").await["workspace"].clone();
        let waiting = f.mutation(2, "openBot", json!({"workspace":workspace}), Uuid::new_v4());
        tokio::pin!(waiting);
        assert!(
            tokio::time::timeout(Duration::from_secs(7), &mut waiting)
                .await
                .is_err(),
            "the second open waits instead of taking over"
        );
        assert!(
            f.owner.bot.is("ma_slow_creator"),
            "the live claim is untouched"
        );
        assert_eq!(bot_count(&f).await, 0);
        // The slow creator gives up and releases its claim; the waiter then opens.
        f.owner.bot.release_for_test("ma_slow_creator").await;
        let opened = waiting.await.unwrap();
        assert_eq!(opened["kind"], "opened", "{opened}");
        assert_eq!(opened["created"], true);
        assert_eq!(bot_count(&f).await, 1);
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn bot_sleep_allows_prediction_without_waking_or_speaking() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = bot_fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let bot = open(&f).await["sessionId"].as_str().unwrap().to_owned();
        f.send(&bot).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        service_tools::named_tool_response(
            &mut socket,
            "SendUser",
            json!({"messageId":"status","messages":[{"text":"CI is green."}]}),
        )
        .await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut original = request(&mut socket).await;
        service_tools::named_tool_response(&mut socket, "sleep", json!({})).await;
        idle(&f, &bot).await;

        let before = f.query("observe", json!({"sessionId":bot})).await.unwrap();
        assert!(before["run"].is_null());
        let messages = outbox(&f).await;
        assert_eq!(messages["messages"][0]["text"], "CI is green.");
        let prediction = f.mutation(
            2,
            "predictNextMessage",
            json!({"sessionId":bot,"expectedTurnId":before["lastCompletedTurnId"],"trigger":"live"}),
            Uuid::new_v4(),
        );
        tokio::pin!(prediction);
        let (mut socket, _) = tokio::select! {
            result = &mut prediction => panic!("prediction ended before dispatch: {result:?}"),
            accepted = listener.accept() => accepted.unwrap(),
        };
        let mut predicted = request(&mut socket).await;
        assert!(predicted["messages"].as_array().unwrap().starts_with(
            original["messages"].as_array().unwrap()
        ));
        original.as_object_mut().unwrap().remove("messages");
        predicted.as_object_mut().unwrap().remove("messages");
        assert_eq!(predicted, original, "Bot model, reasoning and tools must be reused");
        response_with_thinking(
            &mut socket,
            r#"{"suggestion":"Check the deployment."}"#,
            Some("Consider the user's next step."),
        )
        .await;
        let result = prediction.await.unwrap();
        assert_eq!(result["suggestion"], "Check the deployment.");
        assert_eq!(outbox(&f).await, messages, "prediction must not call SendUser");
        let after = f.query("observe", json!({"sessionId":bot})).await.unwrap();
        let appended = f.session(&bot).await.session_events(
            &bot, before["through"].as_u64().unwrap(), after["through"].as_u64().unwrap(),
            1, usize::MAX,
        ).await.unwrap();
        assert!(appended.events.is_empty(), "prediction must not append conversation events");
        assert_eq!(after["lastCompletedTurnId"], before["lastCompletedTurnId"]);
        assert!(after["run"].is_null());

        let policy = f.config.runtime_policy().await.unwrap();
        f.config.set_message_predictions(
            policy.revision,
            maka_agent_facts::configuration::policy::MessagePredictionSettings {
                ordinary_sessions_only: true,
                ..policy.policy.predictions
            },
        ).await.unwrap();
        let restricted = f.mutation(
            2, "predictNextMessage",
            json!({"sessionId":bot,"expectedTurnId":before["lastCompletedTurnId"],"trigger":"live"}),
            Uuid::new_v4(),
        );
        tokio::pin!(restricted);
        let restricted = tokio::select! {
            result = &mut restricted => result.unwrap(),
            _ = listener.accept() => panic!("regular-conversations-only must not dispatch for the Bot"),
        };
        assert_eq!(restricted["suggestion"], Value::Null);

        // A later message wakes the Bot into a new Turn that still remembers the sleep.
        f.mutation(
            2,
            "send",
            json!({"sessionId":bot,"message":"are you there?","backend":model_backend(&f.selection().await)}),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(sent.to_string().contains("are you there?"));
        assert!(
            last_tool_result(&sent).contains("Turn ended"),
            "{}",
            last_tool_result(&sent)
        );
        response(&mut socket).await;
        idle(&f, &bot).await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn only_the_bot_has_sleep_and_ordinary_creation_cannot_request_it() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = bot_fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let _ = open(&f).await;
        let ordinary = f.create("Ordinary").await;
        f.send(&ordinary).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        response(&mut socket).await;
        idle(&f, &ordinary).await;
        assert!(
            !tool_names(&sent).contains(&"sleep".to_owned()),
            "{:?}",
            tool_names(&sent)
        );
        let mut input = f.create_input("Impostor").await;
        input["tools"] = json!(["sleep"]);
        assert_eq!(
            f.mutation(2, "create", input, Uuid::new_v4())
                .await
                .unwrap()["kind"],
            "rejected"
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[test]
fn the_instructions_name_only_the_tools_the_bot_holds() {
    use crate::owner::bot::bot_prompt;
    let held = |names: &[&str]| {
        names
            .iter()
            .map(|name| (*name).to_owned())
            .collect::<Vec<_>>()
    };
    for language in [Language::ZhCn, Language::ZhTw, Language::En] {
        // Identity grants SendUser and sleep; nothing else is promised.
        let bare = bot_prompt(language, &[]);
        for absent in [
            "SessionCreate",
            "ScheduledTask",
            "GoalStatus",
            "Recall",
            "todo_read",
            "SkillSearch",
        ] {
            assert!(
                !bare.contains(absent),
                "{language:?} promised {absent}: {bare}"
            );
        }
        assert!(bare.contains("SendUser") && bare.contains("sleep"));
        // A held tool is named, and delegation is offered only with SessionCreate + SessionSend.
        let some = bot_prompt(language, &held(&["ScheduledTask", "todo_read", "Skill"]));
        assert!(
            some.contains("ScheduledTask") && some.contains("todo_read") && some.contains("Skill")
        );
        assert!(!some.contains("SessionCreate"), "{language:?}: {some}");
        // A partial family is credited only with the members it holds.
        let skill_only = bot_prompt(language, &held(&["Skill"]));
        assert!(
            skill_only.contains("Skill") && !skill_only.contains("SkillSearch"),
            "{language:?}: {skill_only}"
        );
        let todo_write = bot_prompt(language, &held(&["todo_write"]));
        assert!(
            todo_write.contains("todo_write") && !todo_write.contains("todo_read"),
            "{language:?}: {todo_write}"
        );
        let reads = bot_prompt(language, &held(&["SessionList", "SessionRead"]));
        assert!(
            reads.contains("SessionList / SessionRead"),
            "{language:?}: {reads}"
        );
        assert!(
            !reads.contains("SessionSend") && !reads.contains("SessionHistory"),
            "{language:?}: {reads}"
        );
        let sessions = bot_prompt(
            language,
            &held(&["SessionCreate", "SessionSend", "SessionRead"]),
        );
        assert!(
            sessions.contains("SessionCreate / SessionSend") && !sessions.contains("SessionStop"),
            "{language:?}: {sessions}"
        );
        // With delegation held, the Bot is not told it cannot delegate.
        assert!(
            !sessions.contains("neither do nor delegate")
                && !sessions.contains("既做不到也無法委派")
                && !sessions.contains("既做不到也无法委派"),
            "{language:?}: {sessions}"
        );
    }
}

#[tokio::test]
async fn the_bot_opens_without_naming_a_workspace() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = bot_fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        // No other conversation exists and no workspace is given.
        let opened = f
            .mutation(2, "openBot", json!({}), Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(opened["kind"], "opened", "{opened}");
        assert_eq!(opened["created"], true);
        let bot = opened["sessionId"].as_str().unwrap().to_owned();
        let roots = f
            .query("directories", json!({"kind":"roots"}))
            .await
            .unwrap();
        let workspace = f.owner.session(&bot).await.unwrap().configuration.workspace;
        assert_eq!(
            workspace.path,
            roots["roots"][0]["path"].as_str().unwrap(),
            "the Bot starts in the Host's first workspace root"
        );
        // A second open, also without a workspace, returns the same Bot.
        let again = f
            .mutation(2, "openBot", json!({}), Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(
            again,
            json!({"kind":"opened","sessionId":bot,"created":false})
        );
        assert!(sees_send_user(&f, &listener, &bot).await);
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

fn session_tool(method: &str, name: &str) -> contract::ServiceTool {
    contract::ServiceTool {
        nestable: true,
        input: contract::ToolInput::Json,
        presentation: None,
        title: None,
        result: contract::ToolResult::Json,
        confirmation: contract::ToolConfirmation::Preapproved,
        name: name.into(),
        description: "Read a conversation.".into(),
        target: maka_host_runtime::application::ServiceTarget::Export {
            name: "agent".into(),
        },
        method: method.into(),
    }
}

#[tokio::test]
async fn the_bot_can_read_conversations_but_is_not_given_tools_that_change_them() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            None,
            |settings| {
                settings.bot = true;
                settings.tools = vec![
                    session_tool("list", "SessionList"),
                    session_tool("observe", "SessionRead"),
                    session_tool("send", "SessionSend"),
                    session_tool("changeSession", "SessionChange"),
                ];
            },
        )
        .await;
        let bot = open(&f).await["sessionId"].as_str().unwrap().to_owned();
        let held = f
            .owner
            .session(&bot)
            .await
            .unwrap()
            .configuration
            .tools
            .unwrap();
        assert!(held.iter().any(|name| name == "SessionList"), "{held:?}");
        assert!(held.iter().any(|name| name == "SessionRead"), "{held:?}");
        assert!(
            !held.iter().any(|name| name == "SessionChange"),
            "tools that change a conversation are not granted: {held:?}"
        );

        // The Bot sees the user's conversation through SessionList.
        let ordinary = f.create("Quarterly planning").await;
        f.send(&bot).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let names = tool_names(&sent);
        assert!(names.contains(&"SessionList".to_owned()), "{names:?}");
        assert!(!names.contains(&"SessionChange".to_owned()), "{names:?}");
        service_tools::named_tool_response(
            &mut socket,
            "SessionList",
            json!({"filter":"all","position":{"kind":"start"}}),
        )
        .await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let result = last_tool_result(&sent);
        assert!(
            result.contains("Quarterly planning") && result.contains(&ordinary),
            "{result}"
        );
        response(&mut socket).await;
        idle(&f, &bot).await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn the_bot_delegates_to_ordinary_sessions_and_controls_only_its_own() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            None,
            |settings| {
                settings.bot = true;
                settings.tools = vec![
                    session_tool("list", "SessionList"),
                    session_tool("observe", "SessionRead"),
                    session_tool("create", "SessionCreate"),
                    session_tool("send", "SessionSend"),
                    session_tool("stop", "SessionStop"),
                    session_tool("changeSession", "SessionChange"),
                ];
            },
        )
        .await;
        let bot = open(&f).await["sessionId"].as_str().unwrap().to_owned();
        let ordinary = f.create("The user's own conversation").await;
        f.send(&bot).await.unwrap();

        // The Bot creates a worker in its own workspace.
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        service_tools::named_tool_response(
            &mut socket,
            "SessionCreate",
            json!({"title":"Worker","labels":[],"workspace":{"kind":"session","sessionId":bot}}),
        )
        .await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let created: Value = serde_json::from_str(&last_tool_result(&sent)).unwrap();
        let created = match created {
            Value::String(text) => serde_json::from_str(&text).unwrap(),
            other => other,
        };
        assert_eq!(created["session"]["parentSessionId"], bot.as_str(), "{created}");
        let worker = created["session"]["id"].as_str().unwrap().to_owned();
        // Omitted tools follow the ordinary rule: nothing narrows the worker, and
        // it does not become a Bot.
        assert!(created["session"]["tools"].is_null(), "{created}");

        // Sending to a conversation the Bot did not create is refused.
        service_tools::named_tool_response(
            &mut socket,
            "SessionSend",
            json!({"sessionId":ordinary,"message":"hello","backend":model_backend(&f.selection().await)}),
        )
        .await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(last_tool_result(&sent).contains("not_your_worker"), "{}", last_tool_result(&sent));

        // Explicit tools are not intersected with the Bot's own list: the Bot does
        // not hold SessionChange, its worker may.
        service_tools::named_tool_response(
            &mut socket,
            "SessionCreate",
            json!({"title":"Narrow","labels":[],"tools":["SessionChange"],"workspace":{"kind":"session","sessionId":bot}}),
        )
        .await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(last_tool_result(&sent).contains("SessionChange"), "{}", last_tool_result(&sent));
        // SendUser and sleep still follow Bot identity alone.
        service_tools::named_tool_response(
            &mut socket,
            "SessionCreate",
            json!({"title":"Voice","labels":[],"tools":["SendUser"],"workspace":{"kind":"session","sessionId":bot}}),
        )
        .await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(last_tool_result(&sent).contains("tools_unavailable"), "{}", last_tool_result(&sent));

        // Its own worker can be sent to; the worker starts its admitted message.
        service_tools::named_tool_response(
            &mut socket,
            "SessionSend",
            json!({"sessionId":worker,"message":"Do the task","backend":model_backend(&f.selection().await)}),
        )
        .await;
        let mut worker_socket = None;
        let mut bot_socket = None;
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let sent = request(&mut socket).await;
            if sent["messages"].as_array().unwrap().iter().any(|message| message["role"] == "tool") {
                assert!(sent["messages"].to_string().contains("started"));
                bot_socket = Some(socket);
            } else {
                assert!(sent["messages"].to_string().contains("Do the task"));
                worker_socket = Some(socket);
            }
        }
        response(&mut bot_socket.expect("the Bot resumes")).await;
        response(&mut worker_socket.expect("the worker runs")).await;
        idle(&f, &worker).await;
        // The finished worker wakes the Bot; serve that Turn before checking idle.
        let (mut socket, _) = tokio::time::timeout(Duration::from_secs(20), listener.accept())
            .await
            .expect("the Bot is woken")
            .unwrap();
        request(&mut socket).await;
        response(&mut socket).await;
        idle(&f, &bot).await;
        let completed = f.query("observe", json!({"sessionId":worker})).await.unwrap();
        assert!(completed["lastCompletedTurnId"].is_string());
        let prediction = f.mutation(
            2, "predictNextMessage",
            json!({"sessionId":worker,"expectedTurnId":completed["lastCompletedTurnId"],"trigger":"live"}),
            Uuid::new_v4(),
        );
        tokio::pin!(prediction);
        let prediction = tokio::select! {
            result = &mut prediction => result.unwrap(),
            _ = listener.accept() => panic!("Agent-created conversations must never dispatch predictions"),
        };
        assert_eq!(prediction["suggestion"], Value::Null);
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

/// How a stored watch an earlier build wrote is damaged in a `worker_wake` run.
#[derive(Clone, Copy, PartialEq)]
enum Damage {
    None,
    /// Left for a worker that no longer exists: it must be retired.
    GoneWorker,
    /// Written over a live worker's watch before the Bot sends to it again.
    LiveWorker,
}

async fn worker_wake(worker_first: bool, damage: Damage) {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            None,
            |settings| {
                settings.bot = true;
                settings.tools = vec![
                    session_tool("create", "SessionCreate"),
                    session_tool("send", "SessionSend"),
                ];
            },
        )
        .await;
        let bot = open(&f).await["sessionId"].as_str().unwrap().to_owned();
        if damage == Damage::GoneWorker {
            // Sorts before any worker id, so a scan meets it first.
            f.owner.bot.plant_unreadable_watch("0-unreadable").await;
        }
        f.send(&bot).await.unwrap();

        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        service_tools::named_tool_response(
            &mut socket,
            "SessionCreate",
            json!({"title":"Research task","labels":[],"workspace":{"kind":"session","sessionId":bot}}),
        )
        .await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let created: Value = serde_json::from_str(&last_tool_result(&sent)).unwrap();
        let created = match created {
            Value::String(text) => serde_json::from_str(&text).unwrap(),
            other => other,
        };
        let worker = created["session"]["id"].as_str().unwrap().to_owned();
        if damage == Damage::LiveWorker {
            f.owner.bot.plant_unreadable_watch(&worker).await;
        }
        service_tools::named_tool_response(
            &mut socket,
            "SessionSend",
            json!({"sessionId":worker,"message":"Do the task","backend":model_backend(&f.selection().await)}),
        )
        .await;
        let mut worker_socket = None;
        let mut bot_socket = None;
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let sent = request(&mut socket).await;
            if sent["messages"].as_array().unwrap().iter().any(|message| message["role"] == "tool") {
                bot_socket = Some(socket);
            } else {
                worker_socket = Some(socket);
            }
        }
        // Either the Bot ends its Turn first, or the worker finishes while the Bot is
        // still running; the report waits for the Bot in that case.
        let mut bot_socket = bot_socket.expect("the Bot resumes");
        let mut worker_socket = worker_socket.expect("the worker runs");
        if worker_first {
            response(&mut worker_socket).await;
            idle(&f, &worker).await;
            tokio::time::sleep(Duration::from_secs(3)).await;
            response(&mut bot_socket).await;
            idle(&f, &bot).await;
        } else {
            response(&mut bot_socket).await;
            idle(&f, &bot).await;
            response(&mut worker_socket).await;
            idle(&f, &worker).await;
        }

        // The finished worker wakes the Bot with a new Turn that names it.
        let (mut socket, _) = tokio::time::timeout(Duration::from_secs(20), listener.accept())
            .await
            .expect("the Bot is woken")
            .unwrap();
        let sent = request(&mut socket).await;
        let text = sent["messages"].to_string();
        assert!(
            text.contains("Research task") && text.contains(&worker) && text.contains("finished its latest run"),
            "{text}"
        );
        response(&mut socket).await;
        idle(&f, &bot).await;
        if damage == Damage::GoneWorker {
            assert!(
                !f.owner.bot.has_watch("0-unreadable").await,
                "an unreadable watch of a worker that is gone is retired"
            );
        }

        // The same finished run is never reported twice.
        assert!(
            tokio::time::timeout(Duration::from_secs(6), listener.accept()).await.is_err(),
            "a reported run wakes the Bot only once"
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn the_bot_is_woken_once_when_its_worker_finishes() {
    worker_wake(false, Damage::None).await;
}

#[tokio::test]
async fn an_unreadable_watch_of_a_gone_worker_is_retired_and_does_not_stop_other_wakes() {
    worker_wake(false, Damage::GoneWorker).await;
}

#[tokio::test]
async fn the_next_send_to_a_worker_replaces_its_unreadable_watch_so_it_wakes_the_bot() {
    worker_wake(false, Damage::LiveWorker).await;
}

#[tokio::test]
async fn a_report_for_a_worker_that_finished_while_the_bot_ran_waits_for_the_bot() {
    worker_wake(true, Damage::None).await;
}

#[tokio::test]
async fn bot_code_mode_nests_delegation_schedules_and_send_user_while_finishing_with_direct_sleep()
{
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            None,
            |settings| {
                settings.bot = true;
                settings.scheduled_tasks = true;
                settings.todo = true;
                settings.tool_discovery = true;
                settings.tools = vec![
                    session_tool("models", "ModelList"),
                    session_tool("create", "SessionCreate"),
                    session_tool("send", "SessionSend"),
                    session_tool("observe", "SessionRead"),
                ];
            },
        )
        .await;
        selection::edit(&f, |changes| {
            changes.model_overrides = Patch::Set(BTreeMap::from([(
                "fixture-model".into(),
                ModelOverride {
                    code_mode: Some(true),
                    ..Default::default()
                },
            )]));
        })
        .await;
        let bot = open(&f).await["sessionId"].as_str().unwrap().to_owned();
        f.send(&bot).await.unwrap();

        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert_eq!(tool_names(&sent), vec!["exec", "wait", "sleep"]);
        let exec_description = sent["tools"][0]["function"]["description"]
            .as_str()
            .unwrap();
        assert!(
            exec_description.contains("SendUser("),
            "Bot's voice must stay visible in Code Mode even with toolDiscovery enabled: {exec_description}"
        );
        let fire_at = now() + 3_600_000;
        let script = format!(
            r#"
            const discovered = ALL_TOOLS.map(tool => tool.name);
            for (const expected of ['ModelList', 'SessionCreate', 'SessionSend', 'ScheduledTask', 'SendUser']) {{
                if (!discovered.includes(expected)) throw Error('missing ALL_TOOLS entry: ' + expected);
            }}
            const catalog = await tools.ModelList({{ request: {{ kind: 'start' }} }});
            const backend = catalog.choices[0].selection;
            const created = await tools.SessionCreate({{
                title: 'Code Mode worker',
                labels: [],
                workspace: {{ kind: 'session', sessionId: {bot:?} }},
            }});
            const workerId = created.session.id;
            const sent = await tools.SessionSend({{
                sessionId: workerId,
                message: 'Inspect from Code Mode',
                backend,
            }});
            const scheduled = await tools.ScheduledTask({{
                request: {{
                    mode: 'create',
                    title: 'Code Mode reminder',
                    intentBody: 'Check delegated output',
                    schedule: {{ kind: 'interval', everySeconds: 3600, startAt: {fire_at} }},
                    timezone: 'UTC',
                    effect: 'reminder',
                    maxFires: null,
                    expiresAt: null,
                }},
            }});
            await tools.SendUser({{
                messageId: 'code-bot-1',
                messages: [{{ text: 'Delegated and scheduled.' }}],
            }});
            text({{ workerId, sendKind: sent.kind, taskId: scheduled.taskId }});
            "#
        );
        service_tools::named_tool_response(&mut socket, "exec", json!({ "code": script })).await;

        let mut worker_socket = None;
        let mut bot_socket = None;
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let req = request(&mut socket).await;
            if req["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| message["role"] == "tool")
            {
                assert!(
                    last_tool_result(&req).contains("started"),
                    "{}",
                    last_tool_result(&req)
                );
                bot_socket = Some(socket);
            } else {
                assert!(req["messages"].to_string().contains("Inspect from Code Mode"));
                worker_socket = Some(socket);
            }
        }
        let mut bot_socket = bot_socket.expect("Bot receives exec result");
        let mut worker_socket = worker_socket.expect("worker starts in Code Mode");
        service_tools::named_tool_response(&mut bot_socket, "sleep", json!({})).await;
        idle(&f, &bot).await;

        let out = outbox(&f).await;
        assert_eq!(out["messages"].as_array().unwrap().len(), 1);
        assert_eq!(out["messages"][0]["text"], "Delegated and scheduled.");
        let schedules = f.query("schedules", json!({ "kind": "list" })).await.unwrap();
        assert_eq!(schedules["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(schedules["tasks"][0]["title"], "Code Mode reminder");
        assert_eq!(schedules["tasks"][0]["nextFireAt"], json!(fire_at));
        let detail = f
            .query(
                "schedules",
                json!({ "kind": "get", "taskId": schedules["tasks"][0]["id"] }),
            )
            .await
            .unwrap();
        assert_eq!(detail["detail"]["task"]["schedule"]["startAt"], json!(fire_at));

        response(&mut worker_socket).await;
        let (mut wake_socket, _) = tokio::time::timeout(Duration::from_secs(20), listener.accept())
            .await
            .expect("finished worker wakes Bot")
            .unwrap();
        let wake = request(&mut wake_socket).await;
        assert!(wake["messages"].to_string().contains("Code Mode worker"));
        service_tools::named_tool_response(&mut wake_socket, "sleep", json!({})).await;
        idle(&f, &bot).await;

        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn bot_read_receipts_are_monotonic_and_do_not_clear_new_messages() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let f = bot_fixture("http://127.0.0.1:1/v1").await;
        let opened = open(&f).await;
        let session = opened["sessionId"].as_str().unwrap();
        f.owner
            .bot
            .append(
                session,
                "turn",
                "first",
                "first",
                &["one".into(), "two\nlines".into()],
                1,
            )
            .await
            .unwrap();
        let initial = outbox(&f).await;
        assert_eq!(initial["through"], 2);
        assert_eq!(initial["readThrough"], 0);
        assert_eq!(initial["preview"], "two lines");
        let first = f
            .mutation(
                2,
                "markBotRead",
                json!({"sessionId":session,"through":1}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(first["readThrough"], 1);
        // A new message arrives while another window is acknowledging the old head.
        f.owner
            .bot
            .append(session, "turn", "second", "second", &["three".into()], 2)
            .await
            .unwrap();
        let seen = f
            .mutation(
                2,
                "markBotRead",
                json!({"sessionId":session,"through":2}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(seen["through"], 3);
        assert_eq!(seen["readThrough"], 2);
        let stale = f
            .mutation(
                2,
                "markBotRead",
                json!({"sessionId":session,"through":1}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(stale["readThrough"], 2);
        assert!(
            f.mutation(
                2,
                "markBotRead",
                json!({"sessionId":session,"through":4}),
                Uuid::new_v4()
            )
            .await
            .is_err()
        );
        // Reopening reads the persisted cursor, without relying on the UI's counters.
        assert_eq!(outbox(&f).await["readThrough"], 2);
        assert_eq!(open(&f).await["sessionId"], session);
        assert_eq!(outbox(&f).await["readThrough"], 2);
        let ordinary = f.create("ordinary").await;
        assert!(
            f.mutation(
                2,
                "markBotRead",
                json!({"sessionId":ordinary,"through":0}),
                Uuid::new_v4()
            )
            .await
            .is_err()
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
