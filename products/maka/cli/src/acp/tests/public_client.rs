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

//! Independent public Agent consumer; no ACP, TUI or GPUI adapter participates.
use super::support::{self, Fixture};
use maka_agent_api::contract::{DeliveryFact, DeliveryPage, HistoryPage};
use maka_agent_ports::session::history::Role;
use maka_host_runtime::application::{
    host::{Client, LocalCall},
    transport::wire::Reply,
};
use serde_json::{Value, json};
use std::time::Duration;

async fn watch(client: &Client, session: &str, after: u64) -> LocalCall {
    let mut call = client
        .call(
            "agent",
            "watch".into(),
            json!({"sessionId":session,"after":after}),
            Default::default(),
        )
        .await
        .unwrap();
    call.start().await.unwrap();
    assert!(matches!(call.receive().await.unwrap(), Reply::Subscribed));
    call
}
async fn page(call: &mut LocalCall) -> DeliveryPage {
    let Reply::Item { value } = call.pull().await.unwrap() else {
        panic!("Agent watch ended before the original invocation settled");
    };
    serde_json::from_value(value).unwrap()
}
async fn history_page(
    client: &Client,
    session: &str,
    through: Option<u64>,
    position: Value,
) -> HistoryPage {
    let page: HistoryPage = serde_json::from_value(
        support::query(
            client,
            "agent",
            "history",
            json!({
                "sessionId":session,"through":through,"position":position,
            }),
        )
        .await,
    )
    .unwrap();
    let fence = match &page {
        HistoryPage::Ready { through, .. } => *through,
    };
    if let Some(through) = through {
        assert_eq!(fence, through);
    }
    page
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn independent_public_agent_client_reconnects_history_watch_and_pending_interaction() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let mut fixture = Fixture::open().await;
        let session = fixture.session.clone();
        let prompt = format!("Agent reconnect fixture: {}", "中文🙂".repeat(7000));
        let models = support::query(&fixture.native, "settings", "models", json!({"kind":"start"})).await;
        let model = &models["choices"][0]["selection"];
        assert_eq!(model["modelId"], "fixture-model");
        let accepted = support::mutate(&fixture.native, "agent", "send", json!({
            "sessionId":session,"message":prompt,"model":model,"thinkingLevel":"off",
        })).await;
        assert_eq!(accepted["kind"], "started");
        let invocation = accepted["invocationId"].as_str().unwrap().to_owned();
        let message = accepted["messageId"].as_str().unwrap().to_owned();
        let first = fixture.model_requests.recv().await.unwrap();
        assert_eq!(first.body["model"], "fixture-model");
        assert!(first.body["tools"].as_array().unwrap().iter().any(|tool| tool["function"]["name"] == "AskUserQuestion"));
        let mut original_watch = watch(&fixture.native, &session, 0).await;
        first.reply.send(json!({"index":0,"delta":{"role":"assistant","tool_calls":[{
            "index":0,"id":"public-question","type":"function","function":{"name":"AskUserQuestion",
                "arguments":json!({"questions":[{"question":"Choose the answer","options":[{"label":"Alpha"},{"label":"Beta"}]}]}).to_string()}
        }]},"finish_reason":"tool_calls"})).unwrap();
        let mut pending = None;
        let mut opened = 0;
        let after = loop {
            match page(&mut original_watch).await {
                DeliveryPage::Interactions { pending: current } if !current.entries.is_empty() => pending = Some(current),
                DeliveryPage::Events { next_after, events, .. } => {
                    opened += events.iter().filter(|event| event.invocation_id == invocation && matches!(&event.fact, DeliveryFact::Opened)).count();
                    if pending.is_some() { break next_after; }
                }
                _ => {}
            }
        };
        assert_eq!(opened, 1);
        let pending = pending.unwrap();
        assert_eq!(pending.entries.len(), 1);
        let request = &pending.entries[0];
        let tool = request.tool_use_id.as_ref().unwrap();
        let original = support::query(&fixture.native, "agent", "interaction", json!({"sessionId":session,"requestId":request.request_id})).await;
        let HistoryPage::Ready { through, chunks: mut pinned, after: mut continuation, .. } = history_page(&fixture.native, &session, None, json!({"kind":"start"})).await;
        assert!(continuation.is_some(), "the original message must require real history pagination");

        original_watch.close().await.unwrap();
        assert!(original_watch.cleanup_confirmed());
        fixture.native.close().await.unwrap();
        fixture.client.close().await.unwrap();
        let status = Client::status(&fixture.endpoint, Some(fixture.epoch)).await.unwrap();
        assert_eq!(status.sessions, 0);
        assert!(!status.closing && !status.closed);
        assert!(fixture.model_requests.try_recv().is_err(), "disconnect must not resend or answer the pending question");

        let mut client = Client::connect(&fixture.endpoint, Some(fixture.epoch)).await.unwrap();
        let resumed = support::query(&client, "agent", "pendingInteractions", json!({"sessionId":session})).await;
        assert_eq!(resumed, serde_json::to_value(&pending).unwrap());
        let restored = support::query(&client, "agent", "interaction", json!({"sessionId":session,"requestId":request.request_id})).await;
        assert_eq!(restored, original);
        let mut updates = watch(&client, &session, after).await;
        loop {
            if let DeliveryPage::Interactions { pending: restored } = page(&mut updates).await {
                assert!(restored == pending, "watch must restore the same pending interaction snapshot");
                break;
            }
        }
        let answered = support::mutate(&client, "agent", "respond", json!({
            "sessionId":session,"requestId":request.request_id,"answer":{"kind":"question","answers":["Beta"]},
        })).await;
        assert_eq!(answered["kind"], "recorded");
        assert_eq!(answered["record"]["requestId"], request.request_id);
        let next = fixture.model_requests.recv().await.unwrap();
        let result = next.body["messages"].as_array().unwrap().iter().find(|entry| entry["role"] == "tool").unwrap();
        assert!(result["content"].as_str().unwrap().contains("Beta"));
        let stopped = support::mutate(&client, "agent", "stop", json!({"sessionId":session,"invocationId":invocation})).await;
        assert_eq!(stopped, json!({"requested":true}));
        loop {
            if let DeliveryPage::Events { events, .. } = page(&mut updates).await {
                assert!(events.iter().all(|event| event.sequence > after));
                opened += events.iter().filter(|event| event.invocation_id == invocation && matches!(&event.fact, DeliveryFact::Opened)).count();
                if events.iter().any(|event| event.invocation_id == invocation && matches!(&event.fact, DeliveryFact::Ended { .. })) { break; }
            }
        }
        assert_eq!(opened, 1, "reconnect observes the original invocation without another send");
        loop {
            let observed = support::query(&client, "agent", "observe", json!({"sessionId":session})).await;
            if observed["run"].is_null() { break; }
            tokio::task::yield_now().await;
        }
        let execution = support::query(&client, "agent", "execution", json!({"sessionId":session,"invocationId":invocation})).await;
        assert_eq!(execution["execution"]["state"], "cancelled");
        let _ = next.reply.send(json!({"index":0,"delta":{},"finish_reason":"stop"}));

        // Continue the pre-disconnect snapshot after new facts have committed.
        while let Some(cursor) = continuation {
            let HistoryPage::Ready { through: fence, chunks, after, .. } = history_page(&client, &session, Some(through), json!({"kind":"after","cursor":cursor})).await;
            assert_eq!(fence, through);
            pinned.extend(chunks);
            continuation = after;
        }
        let user: Vec<_> = pinned.iter().filter(|chunk| chunk.role == Role::User).collect();
        assert!(user.iter().all(|chunk| chunk.message_id == message));
        assert_eq!(user.iter().map(|chunk| chunk.text.as_str()).collect::<String>(), prompt);
        assert!(!pinned.iter().any(|chunk| chunk.role == Role::ToolResult), "the fixed fence predates the original question's answer");
        let final_history = support::canonical(&client, &session).await;
        let tool_result = final_history.iter().find(|chunk| chunk.role == Role::ToolResult && chunk.tool.as_ref().is_some_and(|entry| &entry.tool_use_id == tool)).unwrap();
        assert!(tool_result.text.contains("Beta"));
        updates.close().await.unwrap();
        assert!(updates.cleanup_confirmed());
        client.quit().await.unwrap();
        fixture.server.await.unwrap().unwrap();
        assert!(fixture.model_requests.try_recv().is_err(), "only the original question and its continuation reached the model");
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn independent_public_agent_client_reads_context_without_own_model_request() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let mut fixture = Fixture::open().await;
        let before = fixture.intent_count().await;
        assert!(
            before > 0,
            "fixture session creation must have a durable caller intent"
        );
        let observed = support::query(
            &fixture.native,
            "agent",
            "observe",
            json!({"sessionId":fixture.session}),
        )
        .await;
        let result: Result<Value, String> = async {
            let mut call = fixture
                .native
                .call(
                    "agent",
                    "context".into(),
                    json!({
                        "sessionId":fixture.session,"through":null,
                    }),
                    Default::default(),
                )
                .await?;
            call.start().await?;
            let reply = call.receive().await?;
            let Reply::Finished { result, cleanup } = reply else {
                return Err(format!("context query did not finish: {reply:?}"));
            };
            cleanup?;
            assert!(call.cleanup_confirmed());
            assert!(!call.holds_caller_intent());
            result
        }
        .await;
        // A session without its own model request has no prepared input to report.
        let expected = json!({"through":observed["through"],"request":null});
        if let Ok(value) = &result {
            assert_eq!(value, &expected);
        }
        // Close both clients even when the query was rejected.
        fixture.native.close().await.unwrap();
        fixture.client.close().await.unwrap();
        let status = Client::status(&fixture.endpoint, Some(fixture.epoch))
            .await
            .unwrap();
        assert_eq!(status.sessions, 0);
        assert!(!status.closing && !status.closed);
        let mut reconnected = Client::connect(&fixture.endpoint, Some(fixture.epoch))
            .await
            .unwrap();
        if result.is_ok() {
            assert_eq!(
                support::query(
                    &reconnected,
                    "agent",
                    "context",
                    json!({
                        "sessionId":fixture.session,"through":observed["through"],
                    })
                )
                .await,
                expected
            );
            let mut foreign = reconnected
                .call(
                    "agent",
                    "context".into(),
                    json!({
                        "sessionId":"foreign-session","through":null,
                    }),
                    Default::default(),
                )
                .await
                .unwrap();
            foreign.start().await.unwrap();
            let Reply::Finished { result, cleanup } = foreign.receive().await.unwrap() else {
                panic!("foreign context query did not settle");
            };
            assert_eq!(result.unwrap_err(), "agent_session_unavailable");
            cleanup.unwrap();
            assert!(foreign.cleanup_confirmed());
            // The Settings endpoint does not expose this Agent method.
            let mut unselected = reconnected
                .call(
                    "settings",
                    "context".into(),
                    json!({
                        "sessionId":fixture.session,"through":null,
                    }),
                    Default::default(),
                )
                .await
                .unwrap();
            assert_eq!(
                unselected.start().await.unwrap_err(),
                "Application method is not granted"
            );
            unselected.close().await.unwrap();
            assert!(unselected.cleanup_confirmed());
            assert_eq!(
                support::query(
                    &reconnected,
                    "agent",
                    "context",
                    json!({
                        "sessionId":fixture.session,"through":observed["through"],
                    })
                )
                .await,
                expected
            );
        }
        reconnected.quit().await.unwrap();
        let after = fixture.intent_count().await;
        fixture.server.await.unwrap().unwrap();
        assert_eq!(
            after, before,
            "context queries and rejections must not create caller intents"
        );
        assert!(
            fixture.model_requests.try_recv().is_err(),
            "context reads must not request a model"
        );
        assert_eq!(
            result.expect("the public Agent context query must be available"),
            json!({"through":observed["through"],"request":null}),
        );
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn independent_public_agent_client_forks_an_empty_session_without_changing_its_source() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let mut fixture = Fixture::open().await;
        let original = support::query(
            &fixture.native,
            "agent",
            "observe",
            json!({
                "sessionId":fixture.session,
            }),
        )
        .await;
        let result: Result<(Value, maka_plugin_core::operation::RecoveryRef, Value), String> = async {
            let mut call = fixture
                .native
                .call(
                    "agent",
                    "fork".into(),
                    json!({
                        "sessionId":fixture.session,
                        "expectedRevision":original["session"]["revision"],
                        "position":{"kind":"end"},"title":"Forked conversation","labels":[],
                    }),
                    Default::default(),
                )
                .await?;
            let result = async {
                call.start().await?;
                let Reply::Prepared { reference } = call.receive().await? else {
                    return Err("fork mutation was not prepared".into());
                };
                assert_eq!(reference.method, "fork");
                let Reply::Mutation { reply, cleanup } = call.confirm().await? else {
                    return Err("fork mutation returned no receipt".into());
                };
                cleanup?;
                assert_eq!(reply.reference, *reference);
                let recorded_reply = serde_json::to_value(&reply).unwrap();
                let maka_plugin_core::operation::Receipt::Recorded {
                    outcome: maka_plugin_core::operation::OperationOutcome::Returned { value },
                    cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
                } = reply.receipt
                else {
                    return Err("fork mutation has no confirmed recorded result".into());
                };
                Ok((value, *reference, recorded_reply))
            }
            .await;
            call.close().await?;
            assert!(call.cleanup_confirmed());
            result
        }
        .await;
        let source_after = support::query(
            &fixture.native,
            "agent",
            "observe",
            json!({
                "sessionId":fixture.session,
            }),
        )
        .await;
        let child = if let Ok((value, reference, recorded_reply)) = &result {
            let child = support::query(&fixture.native, "agent", "observe", json!({
                "sessionId":value["session"]["id"],
            })).await;
            assert_eq!(value["session"]["branch"], json!({"sessionId":fixture.session,"position":{"kind":"end"}}));
            assert_eq!(support::query(&fixture.native,"agent","forkReceipt",json!({"reference":reference})).await,
                json!({"session":value["session"]}));
            assert_eq!(support::query(&fixture.native,"receipts","read",json!(reference)).await, *recorded_reply);
            let mut changed = reference.clone();
            changed.fingerprint = format!("sha256-{}", "0".repeat(64));
            changed.validate().unwrap();
            assert_ne!(changed.fingerprint, reference.fingerprint);
            assert_eq!(support::query(&fixture.native,"agent","forkReceipt",json!({"reference":changed})).await,
                json!({"session":null}));
            let mut foreign = reference.clone();
            foreign.namespace.0 = vec![uuid::Uuid::new_v4()];
            let mut denied = fixture.native.call("agent","forkReceipt".into(),json!({"reference":foreign}),Default::default()).await.unwrap();
            denied.start().await.unwrap();
            let Reply::Finished { result, cleanup } = denied.receive().await.unwrap() else { panic!("foreign forkReceipt did not settle"); };
            assert_eq!(result.unwrap_err(),"agent_fork_reference_unavailable");
            cleanup.unwrap();
            assert!(denied.cleanup_confirmed());
            let mut unselected = fixture.native.call("settings","forkReceipt".into(),json!({"reference":reference}),Default::default()).await.unwrap();
            assert_eq!(unselected.start().await.unwrap_err(),"Application method is not granted");
            unselected.close().await.unwrap();
            assert!(unselected.cleanup_confirmed());
            let changed_source = support::mutate(&fixture.native,"agent","metadata",json!({
                "sessionId":fixture.session,"expectedRevision":original["session"]["revision"],
                "title":"Source renamed after fork","labels":[],
            })).await;
            assert_eq!(changed_source["kind"],"committed");
            let removed = support::mutate(&fixture.native,"agent","changeSession",json!({
                "sessionId":fixture.session,"expectedRevision":changed_source["session"]["revision"],"action":"remove",
            })).await;
            assert_eq!(removed["kind"],"removed");
            assert_eq!(support::query(&fixture.native,"agent","forkReceipt",json!({"reference":reference})).await,
                json!({"session":value["session"]}));
            fixture.native.close().await.unwrap();
            fixture.client.close().await.unwrap();
            let mut reconnected = Client::connect(&fixture.endpoint,Some(fixture.epoch)).await.unwrap();
            assert_eq!(support::query(&reconnected,"receipts","read",json!(reference)).await,*recorded_reply);
            assert_eq!(support::query(&reconnected,"agent","forkReceipt",json!({"reference":reference})).await,
                json!({"session":value["session"]}));
            let current = support::query(&reconnected,"agent","list",json!({"filter":"all","position":{"kind":"start"}})).await;
            assert_eq!(current["sessions"].as_array().unwrap().iter().map(|s|s["id"].clone()).collect::<Vec<_>>(), vec![value["session"]["id"].clone()]);
            let removed = support::mutate(&reconnected,"agent","changeSession",json!({
                "sessionId":value["session"]["id"],"expectedRevision":value["session"]["revision"],"action":"remove",
            })).await;
            assert_eq!(removed["kind"],"removed");
            assert_eq!(support::query(&reconnected,"agent","forkReceipt",json!({"reference":reference})).await,
                json!({"session":null}));
            assert_eq!(support::query(&reconnected,"receipts","read",json!(reference)).await,*recorded_reply);
            reconnected.close().await.unwrap();
            Some(child)
        } else {
            None
        };
        fixture.native.close().await.unwrap();
        fixture.client.close().await.unwrap();
        let mut final_client = Client::connect(&fixture.endpoint, Some(fixture.epoch)).await.unwrap();
        final_client.quit().await.unwrap();
        fixture.server.await.unwrap().unwrap();
        assert_eq!(source_after["session"], original["session"]);
        assert_eq!(source_after["through"], original["through"]);
        assert!(
            fixture.model_requests.try_recv().is_err(),
            "fork must not request a model"
        );
        let (forked, _, _) = result.expect("the public Agent fork mutation must be available");
        assert_eq!(forked["kind"], "forked");
        assert_ne!(forked["session"]["id"], original["session"]["id"]);
        assert_eq!(forked["session"]["title"], "Forked conversation");
        assert_eq!(forked["session"]["labels"], json!([]));
        assert_eq!(child.unwrap()["session"], forked["session"]);
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn independent_public_agent_client_finds_published_fork_after_uncertain_host_settlement_and_reopen()
 {
    tokio::time::timeout(Duration::from_secs(60), async {
        use sqlx::Connection;
        let mut fixture = Fixture::open().await;
        let original = support::query(&fixture.native,"agent","observe",json!({"sessionId":fixture.session})).await;
        let mut call = fixture.native.call("agent","fork".into(),json!({
            "sessionId":fixture.session,"expectedRevision":original["session"]["revision"],
            "position":{"kind":"end"},"title":"Published before settlement","labels":[],
        }),Default::default()).await.unwrap();
        call.start().await.unwrap();
        let Reply::Prepared { reference } = call.receive().await.unwrap() else { panic!("fork not prepared"); };
        // Prepared has an identity but no stored operation yet. Install the
        // operation-scoped failpoint in every runtime journal before dispatch;
        // only its selected journal can execute the settlement UPDATE.
        let mut connections = Vec::new();
        for path in fixture.runtime_databases().await {
            let options = sqlx::sqlite::SqliteConnectOptions::new().filename(path);
            let mut connection = sqlx::SqliteConnection::connect_with(&options).await.unwrap();
            // SQLite trigger definitions cannot bind the typed operation UUID.
            sqlx::query(sqlx::AssertSqlSafe(format!("CREATE TRIGGER reject_fork_settlement BEFORE UPDATE OF outcome_json ON application_operations WHEN OLD.operation='{}' BEGIN SELECT RAISE(ABORT,'fork settlement fixture'); END;",reference.operation)))
                .execute(&mut connection).await.unwrap();
            connections.push(connection);
        }
        let Reply::Mutation { reply, cleanup } = call.confirm().await.unwrap() else { panic!("fork returned no receipt"); };
        cleanup.unwrap();
        assert_eq!(reply.reference,*reference);
        let maka_plugin_core::operation::Receipt::Unavailable { diagnostic } = reply.receipt else { panic!("failed settlement must not claim a recorded fork result"); };
        assert!(diagnostic.contains("settlement outcome unknown"),"{diagnostic}");
        call.close().await.unwrap();
        assert!(call.cleanup_confirmed());
        fixture.database_containing(
            "SELECT EXISTS(SELECT 1 FROM application_operations WHERE deployment=? AND namespace=? AND operation=?)",
            &[&reference.source.deployment.to_string(), &serde_json::to_string(&reference.namespace).unwrap(), &reference.operation.to_string()],
        ).await;
        for mut connection in connections {
            sqlx::query("DROP TRIGGER reject_fork_settlement").execute(&mut connection).await.unwrap();
            connection.close().await.unwrap();
        }
        let unresolved = json!({"reference":reference,"receipt":{
            "kind":"recorded","outcome":{"kind":"unresolved"},"cleanup":{"kind":"unconfirmed"},
        }});
        assert_eq!(support::query(&fixture.native,"receipts","read",json!(reference)).await,unresolved);
        let published = support::query(&fixture.native,"agent","forkReceipt",json!({"reference":reference})).await;
        let target = &published["session"];
        assert_eq!(target["title"],"Published before settlement");
        assert_eq!(target["branch"],json!({"sessionId":fixture.session,"position":{"kind":"end"}}));
        assert_ne!(target["id"],original["session"]["id"]);
        let removed = support::mutate(&fixture.native,"agent","changeSession",json!({
            "sessionId":fixture.session,"expectedRevision":original["session"]["revision"],"action":"remove",
        })).await;
        assert_eq!(removed["kind"],"removed");
        fixture.native.close().await.unwrap();
        fixture.client.quit().await.unwrap();
        fixture.server.await.unwrap().unwrap();

        // Reopen the original Root, not another fixture or an adopted snapshot.
        let namespaces = maka_event_log::root::RootNamespaces {
            ownership:fixture._root.path().join("owners"),
            control:fixture._root.path().join("control"),
        };
        let owner = maka_event_log::root::RootOwner::open(fixture.database.parent().unwrap(),&namespaces).unwrap();
        let mut product = crate::application::open_host(owner,Default::default(),crate::application::Roots::Configured(Some(vec![
            maka_host_runtime::DirectoryRootSpec {label:"Test".into(),path:fixture.workspace.to_str().unwrap().into()},
        ])),Some(support::catalog_transport())).await.unwrap();
        let epoch = product.host.epoch();
        assert_ne!(epoch,fixture.epoch);
        #[cfg(unix)]
        let endpoint = fixture._root.path().join("reopened.sock");
        #[cfg(windows)]
        let endpoint = std::path::PathBuf::from(format!(r"\\.\pipe\maka-fork-reopen-{}",uuid::Uuid::new_v4()));
        let listener = maka_host_runtime::ipc::LocalListener::bind(&endpoint).unwrap();
        let stop = tokio_util::sync::CancellationToken::new();
        let _cleanup = stop.clone().drop_guard();
        let server = tokio::spawn(async move {
            let result = product.host.serve_local(listener,stop).await;
            let cleanup = product.shutdown().await.map_err(|error| error.to_string());
            result.and(cleanup)
        });
        let mut client = Client::connect(&endpoint,Some(epoch)).await.unwrap();
        assert_eq!(support::query(&client,"receipts","read",json!(reference)).await,unresolved);
        assert_eq!(support::query(&client,"agent","forkReceipt",json!({"reference":reference})).await,published);
        let current = support::query(&client,"agent","list",json!({"filter":"all","position":{"kind":"start"}})).await;
        assert_eq!(current["sessions"].as_array().unwrap().iter().map(|s|s["id"].clone()).collect::<Vec<_>>(),vec![target["id"].clone()]);
        assert_eq!(support::query(&client,"agent","forkReceipt",json!({"reference":reference})).await,published);
        assert_eq!(support::query(&client,"receipts","read",json!(reference)).await,unresolved);
        let removed = support::mutate(&client,"agent","changeSession",json!({
            "sessionId":target["id"],"expectedRevision":target["revision"],"action":"remove",
        })).await;
        assert_eq!(removed["kind"],"removed");
        assert_eq!(support::query(&client,"agent","forkReceipt",json!({"reference":reference})).await,json!({"session":null}));
        assert_eq!(support::query(&client,"receipts","read",json!(reference)).await,unresolved);
        assert!(fixture.model_requests.try_recv().is_err(),"fork receipt recovery must not start a model");
        client.quit().await.unwrap();
        server.await.unwrap().unwrap();
    }).await.unwrap();
}
