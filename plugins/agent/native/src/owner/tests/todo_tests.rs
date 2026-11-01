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
        settings.todo = true;
        settings.permissions.access = WorkspaceAccess::ReadOnly;
    })
    .await
}
fn last_tool(sent: &Value) -> &str {
    let messages = sent["messages"].as_array().unwrap();
    let tool = messages
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .unwrap_or_else(|| {
            panic!(
                "Expected a tool result; received: {:?}",
                messages
                    .iter()
                    .map(|message| (
                        message["role"].clone(),
                        message["content"]
                            .to_string()
                            .chars()
                            .take(1000)
                            .collect::<String>()
                    ))
                    .collect::<Vec<_>>()
            )
        });
    tool["content"].as_str().unwrap()
}
async fn page(f: &Fixture, session: &str, offset: usize) -> Value {
    f.query("checklist", json!({"sessionId":session,"offset":offset}))
        .await
        .unwrap()
}
pub(super) async fn reopen(f: &mut Fixture) {
    let deployment = f.app.source().unwrap().deployment;
    f.app.shutdown().await.unwrap();
    let mut native = NativeRegistry::default();
    maka_settings_native::provide(&mut native, crate::owner::tests::bundled_catalog()).unwrap();
    provide_all(&mut native).unwrap();
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
async fn todo_real_model_direct_and_code_mode_keep_full_list_isolation_and_restart() {
    tokio::time::timeout(Duration::from_secs(90), async {
        for code in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
            let no_service_bindings = f.owner.tool_basis.is_empty();
            selection::edit(&f, |changes| {
                changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride { code_mode: Some(code), context_window: Some(1_000_000), input_limit: Some(900_000), ..Default::default() })]));
            }).await;
            let session = f.create("Checklist source").await;
            let other = f.create("Separate checklist").await;
            let items: Vec<Value> = (0..240).map(|index| json!({"content":format!("{index:03} {}", "😀".repeat(256)),"status":if index == 0 { "completed" } else if index == 1 { "in_progress" } else { "pending" }})).collect();
            f.send(&session).await.unwrap();
            let (mut socket, _) = listener.accept().await.unwrap();
            let sent = request(&mut socket).await;
            let tool = if code { "exec" } else { "todo_write" };
            assert!(sent["tools"].as_array().unwrap().iter().any(|t| t["function"]["name"] == tool));
            let input = if code { json!({"code":"const todos = Array.from({length:240}, (_, index) => ({content:String(index).padStart(3, '0') + ' ' + '😀'.repeat(256), status:index === 0 ? 'completed' : index === 1 ? 'in_progress' : 'pending'})); await tools.todo_write({todos}); const read = await tools.todo_read({}); if (JSON.stringify(read.items) !== JSON.stringify(todos)) throw Error('read differs from complete write'); text(read.items.at(-1));"}) } else { json!({"todos":items}) };
            service_tools::named_tool_response(&mut socket, tool, input).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let written = request(&mut socket).await;
            let direct_archive = if code {
                assert!(last_tool(&written).contains("239"), "Code Mode must read the complete list");
                None
            } else {
                // Ordinary large tool results use the existing bounded archive projection.
                let archived: Value = serde_json::from_str(last_tool(&written)).unwrap();
                assert_eq!(archived["kind"], "maka.archived_tool_result");
                assert_eq!(archived["toolName"], "todo_write");
                assert!(archived["page"]["next"].is_object());
                Some(archived)
            };
            if !code {
                service_tools::named_tool_response(&mut socket,"todo_read",json!({})).await;
                let (mut next, _) = listener.accept().await.unwrap();
                let read = request(&mut next).await;
                let archived: Value = serde_json::from_str(last_tool(&read)).unwrap();
                assert_eq!(archived["kind"], "maka.archived_tool_result");
                assert_eq!(archived["toolName"], "todo_read");
                response(&mut next).await;
            } else { response(&mut socket).await; }
            f.drained().await;
            let first = page(&f,&session,0).await;
            assert_eq!(first["total"],240);
            assert_eq!(first["completed"],1);
            assert_eq!(first["current"],items[1]);
            assert_eq!(first["items"],json!(items[..20]));
            assert!(serde_json::to_vec(&first).unwrap().len() < 48 * 1024);
            let mut all = vec![];
            for offset in (0..240).step_by(20) {
                let current = page(&f,&session,offset).await;
                all.extend(current["items"].as_array().unwrap().iter().cloned());
                assert_eq!(current["revision"],first["revision"]);
            }
            assert_eq!(all,items);
            assert_eq!(page(&f,&other,0).await["total"],0);
            assert!(f.query("checklist",json!({"sessionId":"foreign-session","offset":0})).await.is_err());
            let facts = service_tools::facts(&f,&session).await;
            let dispatched: Vec<_> = facts.iter().filter_map(|fact| match fact { Fact::ToolDispatched { name, operation_id, .. } if name == "todo_write" || name == "todo_read" => Some(operation_id), _ => None }).collect();
            assert_eq!(dispatched.len(),2);
            let original = f.session(&(session)).await.scoped_prefix(maka_agent_facts::event::LogScope::Session { id: session.clone() }, 256, 4 * 1024 * 1024).await.unwrap();
            for id in dispatched {
                let event = original.events.iter().find(|event| matches!(&event.event.fact, Fact::ToolSettled { operation_id, .. } if operation_id == id)).unwrap();
                let output = f.session(&session).await.resolve_tool_result(&session, &event.event.id).await.unwrap();
                let maka_agent_facts::tool_output::ToolOutput::Json(document) = output else { panic!("original checklist JSON is retained") };
                assert_eq!(document["items"],json!(items), "every item survives in each original write/read receipt");
                assert_eq!(facts.iter().filter(|fact| matches!(fact, Fact::ToolSettled { operation_id, outcome: ToolOutcome::Succeeded { .. } } if operation_id == id)).count(),1);
            }
            reopen(&mut f).await;
            assert_eq!(page(&f,&session,0).await,first);
            assert_eq!(page(&f,&other,0).await["total"],0);
            f.app.shutdown().await.unwrap();
            f.config.shutdown().await.unwrap();
            if let Some(archived) = direct_archive {
                // This fixture selected no service bindings, including Files under any alias.
                assert!(no_service_bindings);
                assert!(sent["tools"].as_array().unwrap().iter()
                    .all(|tool| tool["function"]["name"] != "Read"), "{sent}");
                assert!(archived["page"]["next"].is_object());
                assert_eq!(archived["readInstructions"],
                    "Use page.next only with a selected Session tool-result reader; without one, the remainder is unavailable.");
            }
        }
    }).await.unwrap();
}

#[tokio::test]
async fn user_messages_after_abandoned_tool_dispatch_preserve_unknown_without_replay() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let check = |sent: &Value| {
            let messages = sent["messages"].as_array().unwrap();
            assert!(messages.iter().any(|message| message["role"] == "system" && message["content"].as_str().is_some_and(|text| text.contains("todo_write") && text.contains("may or may not have happened"))), "{messages:?}");
            assert!(messages.iter().any(|message| message["role"] == "tool" && message.to_string().contains("outcome_unknown")), "{messages:?}");
            assert!(messages.iter().any(|message| message["role"] == "user" && message["content"] == "What happened to the checklist?"), "{messages:?}");
        };
        for queued in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
            let session = f.create("Unknown checklist outcome").await;
            f.send(&session).await.unwrap();
            let (mut socket, _) = listener.accept().await.unwrap();
            request(&mut socket).await;
            if queued {
                assert_eq!(f.mutation(2, "send", json!({"sessionId":session,"message":"What happened to the checklist?","model":f.selection().await}), Uuid::new_v4()).await.unwrap()["kind"], "queued");
            }
            let db = rusqlite::Connection::open(f.session_database(&session)).unwrap();
            db.execute_batch("CREATE TRIGGER reject_settlement BEFORE INSERT ON event_log WHEN NEW.kind='tool_settled' BEGIN SELECT RAISE(ABORT, 'fixture settlement failure'); END;").unwrap();
            service_tools::named_tool_response(&mut socket, "todo_write", json!({"todos":[{"content":"durable side effect","status":"pending"}]})).await;
            if queued {
                let (mut socket, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
                    .await.expect("queued user message must reach the model after physical cleanup").unwrap();
                check(&request(&mut socket).await);
                response(&mut socket).await;
            }
            f.drained().await;
            f.app.shutdown().await.unwrap();
            db.execute_batch("DROP TRIGGER reject_settlement").unwrap();
            drop(db);
            // Root recovery runs only after every physical worker has stopped.
            f.store.recover_invocations().await.unwrap();
            assert!(f.session(&session).await.check_manual_message_history(&session).await.unwrap());
            reopen(&mut f).await;
            f.mutation(2, "send", json!({"sessionId":session,"message":"What happened to the checklist?","model":f.selection().await}), Uuid::new_v4()).await.unwrap();
            let (mut socket, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
                .await.expect("recovered user message must reach the model").unwrap();
            check(&request(&mut socket).await);
            response(&mut socket).await;
            while !f.query("observe", json!({"sessionId":session})).await.unwrap()["run"].is_null() { tokio::task::yield_now().await; }
            assert!(f.session(&session).await.pending_messages(&session).await.unwrap().is_empty());
            f.app.shutdown().await.unwrap();
            f.store.recover_invocations().await.unwrap();
            reopen(&mut f).await;
            f.send(&session).await.unwrap();
            let (mut socket, _) = listener.accept().await.unwrap();
            let sent = request(&mut socket).await;
            assert!(sent["messages"].as_array().unwrap().iter().any(|message| message["role"] == "tool" && message.to_string().contains("outcome_unknown")));
            response(&mut socket).await;
            while !f.query("observe", json!({"sessionId":session})).await.unwrap()["run"].is_null() { tokio::task::yield_now().await; }
            assert_eq!(page(&f, &session, 0).await["items"][0]["content"], "durable side effect");
            f.app.shutdown().await.unwrap();
            let history = f.session(&session).await.scoped_prefix(maka_agent_facts::event::LogScope::Session { id: session.clone() }, 256, 4 * 1024 * 1024).await.unwrap();
            assert_eq!(history.events.iter().filter(|event| matches!(&event.event.fact, Fact::ToolDispatched { name, .. } if name == "todo_write")).count(), 1);
            assert!(!history.events.iter().any(|event| matches!(&event.event.fact, Fact::ToolSettled { .. })));
            assert!(history.events.iter().any(|event| matches!(&event.event.fact, Fact::InvocationEnded { outcome: InvocationOutcome::Failed { class, .. } } if class == "tool_execution")));
            f.config.shutdown().await.unwrap();
        }
    }).await.unwrap();
}
