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

#[tokio::test]
async fn only_the_single_bot_session_holds_send_user() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = bot_fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let opened = open(&f).await;
        assert_eq!(opened["kind"], "opened");
        assert_eq!(opened["created"], true);
        let bot = opened["sessionId"].as_str().unwrap().to_owned();
        let again = open(&f).await;
        assert_eq!(again, json!({"kind":"opened","sessionId":bot,"created":false}));

        // The Bot's allow-list is the coordination subset plus SendUser, nothing else.
        let tools = f.owner.session(&bot).await.unwrap().configuration.tools.unwrap();
        assert!(tools.iter().any(|name| name == "SendUser"));
        assert!(tools.iter().all(|name| crate::owner::bot::ALLOWED_TOOLS.contains(&name.as_str())), "{tools:?}");

        // Ordinary creation cannot request SendUser.
        let mut input = f.create_input("Impostor").await;
        input["tools"] = json!(["SendUser"]);
        let rejected = f.mutation(2, "create", input, Uuid::new_v4()).await.unwrap();
        assert_eq!(rejected["kind"], "rejected", "{rejected}");

        // A Session derived from the Bot does not inherit its voice.
        let derived = f
            .mutation(2, "create", json!({"title":"Derived","labels":[],"workspace":{"kind":"session","sessionId":bot}}), Uuid::new_v4())
            .await
            .unwrap();
        let derived = derived["session"]["id"].as_str().unwrap().to_owned();
        let inherited = f.owner.session(&derived).await.unwrap().configuration.tools.unwrap();
        assert!(!inherited.iter().any(|name| name == "SendUser"), "{inherited:?}");

        // The model sees SendUser only in the Bot Session.
        let ordinary = f.create("Ordinary").await;
        f.send(&ordinary).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(!tool_names(&sent).contains(&"SendUser".to_owned()));
        response(&mut socket).await;
        idle(&f, &ordinary).await;
        f.send(&bot).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(tool_names(&sent).contains(&"SendUser".to_owned()), "{:?}", tool_names(&sent));
        response(&mut socket).await;
        idle(&f, &bot).await;
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
/// (WorkHub-origin) result must still wake the Bot; an ordinary Session keeps the
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
            MessageOrigin::WorkhubTask {
                task_id: "task-1".into(),
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
async fn bot_continues_after_unknown_tool_outcome_and_ordinary_sessions_keep_protection() {
    tokio::time::timeout(Duration::from_secs(90), async {
        assert!(
            origin_wake_after_unknown_outcome(true).await,
            "Bot Session must continue"
        );
        assert!(
            !origin_wake_after_unknown_outcome(false).await,
            "ordinary Session keeps the stricter rule"
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
                json!({"sessionId":bot,"message":"one more thing","model":f.selection().await}),
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
async fn bot_interval_wakes_have_a_minimum() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = bot_fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let bot = open(&f).await["sessionId"].as_str().unwrap().to_owned();
        let ordinary = f.create("Ordinary").await;
        let schedule = |session: String, every: u32| {
            let f = &f;
            async move {
                let boundary = f.owner.session(&session).await.unwrap().configuration;
                let task = json!({"task":{"title":"Heartbeat","intentBody":"Check in","schedule":{"kind":"interval","everySeconds":every,"startAt":now()+3_600_000},"effect":{"kind":"session","target":{"sessionId":session,"workspace":boundary.workspace,"permissions":boundary.permissions,"boundaryRevision":boundary.boundary_revision,"binding":boundary.binding},"model":f.selection().await,"thinkingLevel":null},"maxFires":null,"expiresAt":null},"timezone":"UTC","misfire":"skip"});
                f.mutation(2, "schedule", json!({"kind":"create","input":task}), Uuid::new_v4()).await.unwrap()
            }
        };
        assert_eq!(schedule(bot.clone(), 60).await, json!({"kind":"rejected","reason":"scheduler_bot_interval_too_short"}));
        assert_eq!(schedule(bot.clone(), 300).await["kind"], "committed");
        assert_eq!(schedule(ordinary, 60).await["kind"], "committed");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
