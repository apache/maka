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
use maka_agent_api::session::StoredSessionConfiguration;
use maka_plugin_core::storage::{Mutation, Scan, Store};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
};
#[path = "../../../tests/http_fixture.rs"]
mod http_fixture;

struct Fixture {
    rig: Rig,
    boot: Boot,
    bot: String,
    model: Value,
}
impl Fixture {
    async fn new(listener: &TcpListener) -> Self {
        Self::new_bound(listener, false).await
    }
    async fn new_bound(listener: &TcpListener, project: bool) -> Self {
        let mut rig = Rig::new().unwrap();
        let base = rig.directory.path().to_path_buf();
        let mut boot = bootstrap(
            &base,
            format!("http://{}/v1", listener.local_addr().unwrap()),
            false,
        )
        .await
        .unwrap();
        let store = root(&base, false).await.unwrap();
        let loaded = store
            .load_application(boot.deployment)
            .await
            .unwrap()
            .unwrap();
        let (source, packages, _, _) = loaded.into_parts();
        let mut input = source.input;
        let config = &mut input
            .instances
            .get_mut("agent")
            .unwrap()
            .configuration
            .values;
        std::fs::create_dir_all(base.join("other-workspace")).unwrap();
        config.insert("workspaceRoots".into(),json!([{"label":"source","path":base.join("workspace")},{"label":"destination","path":base.join("other-workspace")} ]));
        config.insert("bot".into(), json!(true));
        config.insert("scheduledTasks".into(), json!(true));
        config.insert("recall".into(), json!(true));
        store
            .commit_application(
                boot.deployment,
                source.reference.revision,
                input,
                source.remote_exports,
                packages,
            )
            .await
            .unwrap();
        boot.source = serde_json::to_value(
            store
                .load_application(boot.deployment)
                .await
                .unwrap()
                .unwrap()
                .source(),
        )
        .unwrap();
        store.shutdown().await.unwrap();
        drop(store);
        attach(&mut rig, &boot).await.unwrap();
        let client = rig.client.as_ref().unwrap();
        let catalog = call(client, "settings", "connections", json!({"kind":"start"}))
            .await
            .unwrap();
        let connection=call(client,"settings","create",json!({"expectedCatalogRevision":catalog["revision"],"connection":{"slug":"discovery","name":"Discovery fixture","provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},"configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.2"],"modelOverrides":{"llama3.2":{"codeMode":false,"apiProtocol":"openai-chat-completions"}}}})).await.unwrap();
        assert_eq!(connection["kind"], "committed");
        let model = json!({"kind":"model","connectionId":connection["connection"]["connectionId"],"modelId":"llama3.2","thinkingLevel":null});
        let path = base.join("workspace");
        let workspace = if project {
            let registered = call(
                client,
                "agent",
                "project",
                json!({"kind":"register","path":path,"expected":null}),
            )
            .await
            .unwrap();
            assert_eq!(registered["kind"], "committed", "{registered}");
            json!({"kind":"project","project":registered["project"]["reference"],"path":path})
        } else {
            json!({"kind":"directory","path":path})
        };
        let opened = call(client, "agent", "openBot", json!({"workspace":workspace}))
            .await
            .unwrap();
        let bot = opened["sessionId"].as_str().unwrap().to_string();
        call(
            client,
            "agent",
            "selectBackend",
            json!({"sessionId":bot,"backend":model}),
        )
        .await
        .unwrap();
        Self {
            rig,
            boot,
            bot,
            model,
        }
    }
    fn owner(&self) -> Arc<Owner> {
        self.rig.captured.lock().unwrap().as_ref().unwrap().clone()
    }
    async fn query(&self, method: &str, input: Value) -> Value {
        call(self.rig.client.as_ref().unwrap(), "agent", method, input)
            .await
            .unwrap_or_else(|e| panic!("{method}: {e}"))
    }
    async fn create(&self, title: &str) -> String {
        self.create_scheduled(title, json!({"kind":"interval","everySeconds":3600,"startAt":maka_agent_authority::now()+3_600_000})).await
    }
    async fn create_scheduled(&self, title: &str, schedule: Value) -> String {
        let config = self.owner().session(&self.bot).await.unwrap().configuration;
        let result=self.query("schedule",json!({"kind":"create","input":{"task":{"title":title,"intentBody":format!("Check authorized sources for {title}"),"schedule":schedule,"effect":{"kind":"discovery","target":{"sessionId":self.bot,"workspace":config.workspace,"permissions":config.permissions,"boundaryRevision":config.boundary_revision,"binding":config.binding},"model":{"connectionId":self.model["connectionId"],"modelId":"llama3.2"},"thinkingLevel":null},"maxFires":null,"expiresAt":null},"timezone":"UTC","misfire":"latest"}})).await;
        assert_eq!(result["kind"], "committed", "{result}");
        result["taskId"].as_str().unwrap().to_owned()
    }
    async fn detail(&self, task: &str) -> Value {
        self.query("schedules", json!({"kind":"get","taskId":task}))
            .await["detail"]
            .clone()
    }
    async fn change(&self, task: &str, kind: &str) {
        tokio::time::timeout(Duration::from_secs(45), async {
            loop {
                let d = self.detail(task).await;
                let r = self
                    .query(
                        "schedule",
                        json!({"kind":kind,"taskId":task,"revision":d["revision"]}),
                    )
                    .await;
                match r["kind"].as_str() {
                    Some("committed") => return,
                    // Settlement can advance the plan revision between get and change.
                    Some("conflict") => tokio::task::yield_now().await,
                    _ => panic!("{kind} {task}: {r}"),
                }
            }
        })
        .await
        .expect("schedule change did not settle");
    }
    async fn settled(&self, task: &str, count: usize) -> Value {
        tokio::time::timeout(Duration::from_secs(45), async {
            loop {
                let d = self.detail(task).await;
                if d["task"]["runs"].as_array().unwrap().len() == count {
                    return d;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap()
    }
    async fn send(&self, text: &str, quotes: Value) -> Value {
        self.query("send",json!({"sessionId":self.bot,"message":text,"quotes":quotes,"backend":self.model,"delivery":"queue"})).await
    }
    async fn outbox(&self) -> Value {
        self.query("botOutbox", json!({})).await["messages"].clone()
    }
    async fn quiescent(&self, session: &str) {
        let owner = self.owner();
        loop {
            if owner
                .durable
                .session_quiescence(owner.run_owner(), session.to_owned())
                .await
                .unwrap()
                .is_quiescent()
                && !owner.runs.state().await.busy(session)
            {
                return;
            }
            tokio::task::yield_now().await;
        }
    }
    async fn close(&mut self) {
        let errors = self.rig.finish().await;
        assert!(errors.is_empty(), "{errors:?}");
    }
    async fn setting(&mut self, key: &str, value: Value) {
        self.close().await;
        self.rig.captured.lock().unwrap().take();
        self.rig.client = None;
        self.rig.host = None;
        self.rig.store = None;
        let store = root(self.rig.directory.path(), false).await.unwrap();
        let loaded = store
            .load_application(self.boot.deployment)
            .await
            .unwrap()
            .unwrap();
        let (source, packages, _, _) = loaded.into_parts();
        let mut input = source.input;
        input
            .instances
            .get_mut("agent")
            .unwrap()
            .configuration
            .values
            .insert(key.into(), value);
        store
            .commit_application(
                self.boot.deployment,
                source.reference.revision,
                input,
                source.remote_exports,
                packages,
            )
            .await
            .unwrap();
        self.boot.source = serde_json::to_value(
            store
                .load_application(self.boot.deployment)
                .await
                .unwrap()
                .unwrap()
                .source(),
        )
        .unwrap();
        store.shutdown().await.unwrap();
        drop(store);
        self.rig.stop_serving = CancellationToken::new();
        attach(&mut self.rig, &self.boot).await.unwrap();
    }
    async fn change_source(&mut self, update: fn(&mut StoredSessionConfiguration)) {
        self.close().await;
        self.rig.captured.lock().unwrap().take();
        self.rig.client = None;
        self.rig.host = None;
        self.rig.store = None;
        let store = root(self.rig.directory.path(), false).await.unwrap();
        let session = store
            .get_session::<StoredSessionConfiguration>(&self.bot)
            .await
            .unwrap()
            .unwrap();
        store
            .update_session_metadata(
                &self.bot,
                session.revision,
                move |config: &mut StoredSessionConfiguration| {
                    update(config);
                    Ok(())
                },
            )
            .await
            .unwrap();
        store.shutdown().await.unwrap();
        drop(store);
        self.rig.stop_serving = CancellationToken::new();
        attach(&mut self.rig, &self.boot).await.unwrap();
    }
    async fn reopen(&mut self) {
        self.close().await;
        self.rig.captured.lock().unwrap().take();
        self.rig.client = None;
        self.rig.host = None;
        self.rig.store = None;
        self.rig.stop_serving = CancellationToken::new();
        attach(&mut self.rig, &self.boot).await.unwrap();
    }
}
async fn next(listener: &TcpListener) -> (TcpStream, Value) {
    tokio::time::timeout(Duration::from_secs(45), async {
        let (mut socket, _) = listener.accept().await.unwrap();
        let (_, body) = http_fixture::read_request(&mut socket).await;
        (socket, body)
    })
    .await
    .unwrap()
}
async fn tool(socket: &mut TcpStream, name: &str, input: Value) {
    let body = format!(
        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        json!({"id":"fixture","object":"chat.completion.chunk","created":1,"model":"llama3.2","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":format!("call_{}",Uuid::new_v4()),"type":"function","function":{"name":name,"arguments":input.to_string()}}]},"finish_reason":null}]}),
        json!({"id":"fixture","object":"chat.completion.chunk","created":1,"model":"llama3.2","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}})
    );
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
    socket.shutdown().await.unwrap();
}
async fn finish_text(socket: &mut TcpStream, text: &str) {
    let body = format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({"id":"plain","object":"chat.completion.chunk","created":1,"model":"llama3.2","choices":[{"index":0,"delta":{"role":"assistant","content":text},"finish_reason":"stop"}]})
    );
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
    socket.shutdown().await.unwrap();
}
fn output(body: &Value) -> Value {
    let text = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|m| m["role"] == "tool")
        .unwrap()["content"]
        .as_str()
        .unwrap();
    serde_json::from_str(text).unwrap_or(json!({"error":text}))
}
async fn memory(
    listener: &TcpListener,
    socket: &mut TcpStream,
    input: Value,
) -> (TcpStream, Value) {
    tool(socket, "DiscoveryMemory", input).await;
    let (s, b) = next(listener).await;
    (s, output(&b))
}
async fn quiet(f: &Fixture, listener: &TcpListener, socket: &mut TcpStream) {
    finish_text(socket, "Investigation received.").await;
    tokio::time::timeout(Duration::from_secs(45), f.quiescent(&f.bot))
        .await
        .expect("Bot Run did not settle before Host teardown");
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_is_silent_read_only_and_retains_bounded_progress_after_reopen() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    f.setting("toolDiscovery", json!(true)).await;
    let task = f.create("Continuity").await;
    f.change(&task, "trigger_now").await;
    let (mut socket, body) = next(&listener).await;
    let names: Vec<_> = body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["function"]["name"].as_str().unwrap())
        .collect();
    assert!(
        names.contains(&"DiscoveryComplete") && names.contains(&"DiscoveryMemory"),
        "{names:?}"
    );
    assert!(!names.iter().any(|n| {
        [
            "SendUser",
            "sleep",
            "ScheduledTask",
            "Bash",
            "tool_search",
            "SessionCreate",
        ]
        .contains(n)
    }));
    let(mut socket,r)=memory(&listener,&mut socket,json!({"action":"checkpoint","note":{"text":"checked README; next inspect changelog","references":["README.md"]}})).await;
    assert_eq!(r["staged"], true);
    let note = "No actionable change. ".repeat(150);
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":note}),
    )
    .await;
    let done = f.settled(&task, 1).await;
    assert_eq!(done["task"]["runs"][0]["outcome"], "ok");
    let worker = done["task"]["runs"][0]["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let config = f.owner().session(&worker).await.unwrap().configuration;
    assert_eq!(config.permissions, crate::owner::discovery::permissions());
    assert_eq!(config.parent_session_id.as_deref(), Some(f.bot.as_str()));
    assert_eq!(f.outbox().await, json!([]));
    f.reopen().await;
    f.change(&task, "trigger_now").await;
    let (mut socket, body) = next(&listener).await;
    assert!(body.to_string().contains("Discovery continuation"));
    assert!(!body.to_string().contains(&note));
    let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
    assert_eq!(page["records"][0]["content"]["result"]["note"], note);
    assert_eq!(
        page["records"][0]["content"]["checkpoint"]["references"],
        json!(["README.md"])
    );
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"new round"}),
    )
    .await;
    let done = f.settled(&task, 2).await;
    assert_ne!(done["task"]["runs"][0]["sessionId"], worker);
    assert_eq!(f.outbox().await, json!([]));
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_committed_outcome_recovers_after_lost_acknowledgement() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Uncertain settlement").await;
    f.change(&task, "trigger_now").await;
    let (mut socket, _) = next(&listener).await;
    let committed = f.owner().scheduler.storage.unknown_after("investigation");
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"durable result"}),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(45), committed)
        .await
        .unwrap()
        .unwrap();
    f.reopen().await;
    let done = f.settled(&task, 1).await;
    assert_eq!(done["task"]["fireCount"], 1);
    assert_eq!(done["task"]["runs"][0]["outcome"], "ok");
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
    f.send("Review the investigation", json!([])).await;
    let (mut socket, _) = next(&listener).await;
    let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
    assert_eq!(page["records"].as_array().unwrap().len(), 1);
    assert_eq!(
        page["records"][0]["content"]["result"]["note"],
        "durable result"
    );
    quiet(&f, &listener, &mut socket).await;
    assert_eq!(f.outbox().await, json!([]));
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_recovery_rechecks_notification_authority() {
    for (setting, after_commit) in [
        ("recall", true),
        ("bot", true),
        ("scheduledTasks", true),
        ("recall", false),
        ("permissions", true),
        ("boundary_revision", true),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut f = Fixture::new(&listener).await;
        // Keep the Bot occupied so the real report remains queued across the crash.
        f.send("Wait for my next instruction", json!([])).await;
        let (_bot_socket, _) = next(&listener).await;
        let task = f.create("Recovered report authorization").await;
        f.change(&task, "trigger_now").await;
        let (mut worker, _) = next(&listener).await;
        let committed = if after_commit {
            f.owner().scheduler.storage.unknown_after("delivering")
        } else {
            f.owner().scheduler.storage.unknown_before("delivering")
        };
        tool(
            &mut worker,
            "DiscoveryComplete",
            json!({"kind":"report","text":"recovery-boundary-finding"}),
        )
        .await;
        tokio::time::timeout(Duration::from_secs(45), committed)
            .await
            .unwrap()
            .unwrap();
        let pending = f.owner().durable.queue().read(f.bot.clone()).await.unwrap();
        assert_eq!(pending.entries.len(), 1);
        let report = pending.entries[0].request.clone();
        match setting {
            "permissions" => {
                f.change_source(|config| {
                    config.permissions = crate::owner::discovery::permissions()
                })
                .await
            }
            "boundary_revision" => {
                f.change_source(|config| config.boundary_revision += 1)
                    .await
            }
            _ => f.setting(setting, json!(false)).await,
        }
        assert_eq!(
            f.owner()
                .durable
                .queue()
                .resolve_message(f.bot.clone(), report.message_id.clone())
                .await
                .unwrap(),
            maka_agent_state::queue::MessageResolution::Cancelled,
            "revoked {setting} report survived recovery"
        );
        assert_eq!(
            f.settled(&task, 1).await["task"]["runs"][0]["outcome"],
            "blocked"
        );
        f.reopen().await;
        assert_eq!(
            f.owner()
                .durable
                .queue()
                .resolve_message(f.bot.clone(), report.message_id)
                .await
                .unwrap(),
            maka_agent_state::queue::MessageResolution::Cancelled
        );
        f.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_recovery_delivers_an_authorized_notification_once() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    f.send("Wait for my next instruction", json!([])).await;
    let (_bot_socket, _) = next(&listener).await;
    // Recovery can admit the report before the next query; stop only the original Run.
    let busy = f
        .owner()
        .durable
        .latest_run(f.bot.clone())
        .await
        .unwrap()
        .unwrap();
    let task = f.create("Authorized recovered report").await;
    f.change(&task, "trigger_now").await;
    let (mut worker, _) = next(&listener).await;
    let committed = f.owner().scheduler.storage.unknown_after("delivering");
    tool(
        &mut worker,
        "DiscoveryComplete",
        json!({"kind":"report","text":"authorized-recovery-finding"}),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(45), committed)
        .await
        .unwrap()
        .unwrap();
    let pending = f.owner().durable.queue().read(f.bot.clone()).await.unwrap();
    assert_eq!(pending.entries.len(), 1);
    let report = pending.entries[0].request.clone();
    // Later user work in the worker Session must not change the investigation's
    // captured Run or keep its original report from settling after restart.
    let bytes = f
        .owner()
        .durable
        .queue()
        .content(f.bot.clone(), report.id.clone(), report.source.clone())
        .await
        .unwrap();
    let source: maka_agent_facts::message::RootSourceMessage =
        serde_json::from_slice(&bytes).unwrap();
    let Some(maka_agent_facts::message::MessageOrigin::BotWorker {
        session_id: worker_id,
    }) = source.message.origin
    else {
        panic!("missing original worker");
    };
    f.query("send", json!({"sessionId":worker_id,"message":"A later independent turn", "backend":f.model,"delivery":"queue"})).await;
    let (mut later_worker, _) = next(&listener).await;
    finish_text(&mut later_worker, "Independent turn complete.").await;
    tokio::time::timeout(Duration::from_secs(45), f.quiescent(&worker_id))
        .await
        .expect("independent worker Run did not settle before Host teardown");
    f.reopen().await;
    f.query("stop", json!({"sessionId":f.bot,"runId":busy}))
        .await;
    let (mut bot, body) = next(&listener).await;
    assert!(
        body.to_string().contains("authorized-recovery-finding"),
        "{body}"
    );
    quiet(&f, &listener, &mut bot).await;
    assert_eq!(
        f.settled(&task, 1).await["task"]["runs"][0]["outcome"],
        "ok"
    );
    let delivered = f
        .owner()
        .durable
        .queue()
        .resolve_message(f.bot.clone(), report.message_id.clone())
        .await
        .unwrap();
    assert!(
        matches!(
            delivered,
            maka_agent_state::queue::MessageResolution::Delivered { shared: false, .. }
        ),
        "expected the recovered report to start its own Bot Run, got {delivered:?}"
    );
    f.reopen().await;
    assert_eq!(
        f.owner()
            .durable
            .queue()
            .resolve_message(f.bot.clone(), report.message_id)
            .await
            .unwrap(),
        delivered
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_notification_receipt_is_idempotent_across_retry_and_reopen() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Notification receipt").await;
    f.change(&task, "trigger_now").await;
    let (mut socket, _) = next(&listener).await;
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"report","text":"A useful finding"}),
    )
    .await;
    let (mut socket, _) = next(&listener).await;
    let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
    let record = page["records"][0]["id"].clone();
    let input = json!({"messageId":"notification-uncertain","messages":[{"text":"A useful finding"}],"discovery":{"record":record,"reason":"verified"}});
    tool(&mut socket, "SendUser", input.clone()).await;
    let (mut socket, _) = next(&listener).await;
    quiet(&f, &listener, &mut socket).await;
    let original = f.outbox().await;
    assert_eq!(original.as_array().unwrap().len(), 1);
    f.reopen().await;
    assert_eq!(f.outbox().await, original);
    f.send("Retry the original notification", json!([])).await;
    let (mut socket, _) = next(&listener).await;
    tool(&mut socket, "SendUser", input).await;
    let (mut socket, body) = next(&listener).await;
    assert!(body.to_string().contains("Already sent"), "{body}");
    let (mut socket, page) = memory(
        &listener,
        &mut socket,
        json!({"action":"list","related":record}),
    )
    .await;
    assert_eq!(page["records"].as_array().unwrap().len(), 2, "{page}");
    assert_eq!(page["records"][0]["content"]["kind"], "notified");
    assert_eq!(f.outbox().await, original);
    quiet(&f, &listener, &mut socket).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_uncertain_decision_ack_keeps_one_outbox_message_and_blocks_false_completion() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Notification receipt").await;
    f.change(&task, "trigger_now").await;
    let (mut socket, _) = next(&listener).await;
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"report","text":"A useful finding"}),
    )
    .await;
    let (mut socket, _) = next(&listener).await;
    let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
    let record = page["records"][0]["id"].clone();
    let input = json!({"messageId":"notification-uncertain","messages":[{"text":"A useful finding"}],"discovery":{"record":record,"reason":"verified"}});
    let committed = f.owner().scheduler.storage.unknown_after("notified");
    tool(&mut socket, "SendUser", input.clone()).await;
    tokio::time::timeout(Duration::from_secs(45), committed)
        .await
        .unwrap()
        .unwrap();
    let original = f.outbox().await;
    assert_eq!(original.as_array().unwrap().len(), 1);
    let owner = f.owner();
    tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            let run = owner
                .durable
                .latest_run(f.bot.clone())
                .await
                .unwrap()
                .unwrap();
            let view = owner.durable.frontier(run).await.unwrap();
            if !view.blockers.is_empty() {
                assert!(
                    view.terminal.is_none(),
                    "unknown publication must not become success"
                );
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(f.outbox().await, original);
    let errors = f.rig.finish().await;
    assert!(
        errors
            .iter()
            .any(|error| error.contains("cleanup_unconfirmed")),
        "{errors:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_memory_serializes_bot_append_with_settlement() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Concurrent records").await;
    f.change(&task, "trigger_now").await;
    let (mut worker, _) = next(&listener).await;
    tool(
        &mut worker,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"first"}),
    )
    .await;
    f.settled(&task, 1).await;
    f.send("Review records", json!([])).await;
    let (mut socket, _) = next(&listener).await;
    let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
    let original = page["records"][0]["id"].clone();
    f.change(&task, "trigger_now").await;
    let (mut worker, _) = next(&listener).await;
    let (entered, release) = f.owner().scheduler.storage.hold_before("investigation");
    tool(
        &mut worker,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"second"}),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(45), entered)
        .await
        .unwrap()
        .unwrap();
    let owner = f.owner();
    let run = owner
        .durable
        .latest_run(f.bot.clone())
        .await
        .unwrap()
        .unwrap();
    let previous = owner.durable.frontier(run).await.unwrap().tools.len();
    tool(
        &mut socket,
        "DiscoveryMemory",
        json!({"action":"withhold","record":original,"reason":"No new action"}),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(45), async {
        while owner.durable.frontier(run).await.unwrap().tools.len() <= previous {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let premature = tokio::time::timeout(Duration::from_millis(150), listener.accept()).await;
    release.send(()).unwrap();
    assert!(premature.is_err());
    let (mut socket, body) = next(&listener).await;
    assert_eq!(output(&body)["recorded"], true);
    f.settled(&task, 2).await;
    let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
    let records = page["records"].as_array().unwrap();
    assert_eq!(records.len(), 3);
    assert_eq!(
        records
            .iter()
            .map(|r| r["sequence"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [3, 2, 1]
    );
    quiet(&f, &listener, &mut socket).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_memory_retries_a_rejected_head_revision_without_partial_writes() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Discovery record conflict").await;
    f.change(&task, "trigger_now").await;
    let (mut worker, _) = next(&listener).await;
    tool(
        &mut worker,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"Original finding"}),
    )
    .await;
    f.settled(&task, 1).await;
    f.send("Review records", json!([])).await;
    let (mut socket, _) = next(&listener).await;
    let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
    let record = &page["records"][0]["id"];
    let decision = json!({"action":"withhold","record":record,"reason":"No new action"});
    let owner = f.owner();
    let storage = &owner.scheduler.storage;
    let scan = Scan {
        prefix: "discovery/memory/".into(),
        after: None,
    };
    let mut expected = storage.scan(scan.clone()).await.unwrap();
    assert!(expected.next_after.is_none());
    let head = expected
        .entries
        .iter_mut()
        .find(|entry| entry.key.ends_with("/head"))
        .unwrap();

    let (entered, release) = storage.hold_before("withheld");
    tool(&mut socket, "DiscoveryMemory", decision.clone()).await;
    tokio::time::timeout(Duration::from_secs(45), entered)
        .await
        .unwrap()
        .unwrap();
    // Advance the storage revision without changing the record sequence.
    let advanced = storage
        .batch(vec![Mutation {
            key: head.key.clone(),
            expected_revision: Some(head.record.revision),
            data: head.record.data.clone(),
        }])
        .await
        .unwrap();
    head.record = advanced.into_iter().next().unwrap();
    release.send(()).unwrap();

    let (mut socket, body) = next(&listener).await;
    let rejected = output(&body);
    assert!(
        rejected
            .to_string()
            .contains("plugin data revision conflict"),
        "{rejected}"
    );
    let after = storage.scan(scan).await.unwrap();
    assert_eq!(
        serde_json::to_value(after).unwrap(),
        serde_json::to_value(expected).unwrap(),
        "rejected append left a record, index, or receipt"
    );

    let (mut socket, saved) = memory(&listener, &mut socket, decision).await;
    assert_eq!(saved["recorded"], true, "{saved}");
    let (mut socket, page) = memory(
        &listener,
        &mut socket,
        json!({"action":"list","related":record}),
    )
    .await;
    let entries = page["records"].as_array().unwrap();
    assert_eq!(entries.len(), 2, "{page}");
    assert_eq!(entries[0]["id"], saved["record"]);
    assert_eq!(entries[0]["sequence"], 2);
    assert_eq!(entries[0]["content"]["kind"], "withheld");
    assert_eq!(entries[1]["id"], *record);
    quiet(&f, &listener, &mut socket).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_preserves_quote_only_and_steered_feedback_and_sleep_decisions() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Feedback").await;
    f.change(&task, "trigger_now").await;
    let (mut socket, _) = next(&listener).await;
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"Original finding"}),
    )
    .await;
    f.settled(&task, 1).await;
    let quote = "Do not repeat this recommendation.";
    f.send("", json!([{"text":quote}])).await;
    let (mut socket, body) = next(&listener).await;
    assert!(body.to_string().contains(quote));
    let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
    let record = page["records"][0]["id"].clone();
    let (mut socket, result) = memory(
        &listener,
        &mut socket,
        json!({"action":"feedback","record":record,"note":"Avoid repeating this"}),
    )
    .await;
    assert_eq!(result["recorded"], true, "{result}");
    let (mut socket, source) = memory(
        &listener,
        &mut socket,
        json!({"action":"feedback_source","record":result["record"]}),
    )
    .await;
    let source: Value = serde_json::from_str(source["source"].as_str().unwrap()).unwrap();
    assert_eq!(source["text"], "");
    assert_eq!(source["quotes"][0]["text"], quote);
    let steered=f.query("send",json!({"sessionId":f.bot,"message":"Actually, revisit only if the situation changes.","backend":f.model,"delivery":"steer"})).await;
    let (mut socket, _) = memory(&listener, &mut socket, json!({"action":"list"})).await;
    let(mut socket,result)=memory(&listener,&mut socket,json!({"action":"feedback","record":record,"note":"Revisit after a change","message_id":steered["messageId"]})).await;
    assert_eq!(result["recorded"], true, "{result}");
    let (mut socket, source) = memory(
        &listener,
        &mut socket,
        json!({"action":"feedback_source","record":result["record"]}),
    )
    .await;
    assert!(
        source["source"]
            .as_str()
            .unwrap()
            .contains("Actually, revisit")
    );
    tool(
        &mut socket,
        "sleep",
        json!({"discovery":{"record":record,"reason":"No change yet"}}),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            let owner = f.owner();
            if owner
                .durable
                .session_quiescence(owner.run_owner(), f.bot.clone())
                .await
                .unwrap()
                .is_quiescent()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(f.outbox().await, json!([]));
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_pause_resume_cancels_only_the_original_fire_before_next_worker() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let first = f.create("A").await;
    let second = f.create("B").await;
    f.change(&first, "trigger_now").await;
    let (mut socket, _) = next(&listener).await;
    let (_socket, result) = memory(
        &listener,
        &mut socket,
        json!({"action":"checkpoint","note":{"text":"cancelled checkpoint"}}),
    )
    .await;
    assert_eq!(result["staged"], true);
    f.change(&second, "trigger_now").await;
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
    f.change(&first, "pause").await;
    f.change(&first, "resume").await;
    let done = f.settled(&first, 1).await;
    assert_eq!(done["task"]["runs"][0]["outcome"], "blocked");
    let (mut socket, body) = next(&listener).await;
    assert!(!body.to_string().contains("cancelled checkpoint"));
    let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
    assert_eq!(page["records"], json!([]));
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"B completed"}),
    )
    .await;
    f.settled(&second, 1).await;
    assert_eq!(f.outbox().await, json!([]));
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_revoked_permissions_hide_old_records_and_reject_publication() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Scope boundary").await;
    f.change(&task, "trigger_now").await;
    let (mut socket, _) = next(&listener).await;
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"old-source-observation"}),
    )
    .await;
    f.settled(&task, 1).await;
    f.send("Read previous records", json!([])).await;
    let (mut socket, _) = next(&listener).await;
    let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
    let record = page["records"][0]["id"].clone();
    quiet(&f, &listener, &mut socket).await;
    let previous = f.owner().session(&f.bot).await.unwrap();
    let result=f.query("metadata",json!({"sessionId":f.bot,"expectedRevision":previous.revision,"title":previous.configuration.title,"labels":[],"permissions":{"settings":{"access":"read_only","requestPermissions":false},"revokeGrants":true}})).await;
    assert_eq!(result["kind"], "committed", "{result}");
    f.send("Read the old record", json!([])).await;
    let (mut socket, _) = next(&listener).await;
    let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
    assert_eq!(page["records"], json!([]));
    let (mut socket, result) = memory(
        &listener,
        &mut socket,
        json!({"action":"feedback","record":record,"note":"old source"}),
    )
    .await;
    assert!(result.to_string().contains("discovery_record_unavailable"));
    tool(&mut socket,"SendUser",json!({"messageId":"stale-source","messages":[{"text":"Old finding"}],"discovery":{"record":record,"reason":"old source"}})).await;
    let (mut socket, body) = next(&listener).await;
    assert!(
        output(&body)
            .to_string()
            .contains("discovery_record_unavailable")
    );
    assert_eq!(f.outbox().await, json!([]));
    quiet(&f, &listener, &mut socket).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_project_relocation_rejects_old_feedback_and_notifications() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new_bound(&listener, true).await;
    let task = f.create("Project boundary").await;
    f.change(&task, "trigger_now").await;
    let (mut socket, _) = next(&listener).await;
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"original location"}),
    )
    .await;
    f.settled(&task, 1).await;
    f.send("Read the records", json!([])).await;
    let (mut socket, _) = next(&listener).await;
    let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
    let record = page["records"][0]["id"].clone();
    quiet(&f, &listener, &mut socket).await;
    let before = f.owner().session(&f.bot).await.unwrap().configuration;
    let project = f
        .query(
            "projects",
            json!({"kind":"directory","path":f.rig.directory.path().join("workspace")}),
        )
        .await["location"]["project"]["reference"]
        .clone();
    let changed=f.query("project",json!({"kind":"relocate","project":project,"path":f.rig.directory.path().join("other-workspace"),"destination":null})).await;
    assert_eq!(changed["kind"], "committed", "{changed}");
    let after = f.owner().session(&f.bot).await.unwrap().configuration;
    assert_eq!(after.permissions, before.permissions);
    assert_eq!(after.binding.id, before.binding.id);
    assert_eq!(
        after.binding.permission_epoch,
        before.binding.permission_epoch + 1
    );
    f.send("Read the old observation", json!([])).await;
    let (mut socket, _) = next(&listener).await;
    let (mut socket, result) = memory(
        &listener,
        &mut socket,
        json!({"action":"feedback","record":record,"note":"old location"}),
    )
    .await;
    assert!(result.to_string().contains("discovery_record_unavailable"));
    tool(&mut socket,"SendUser",json!({"messageId":"old-location","messages":[{"text":"Old location result"}],"discovery":{"record":record,"reason":"old location"}})).await;
    let (mut socket, body) = next(&listener).await;
    assert!(
        output(&body)
            .to_string()
            .contains("discovery_record_unavailable")
    );
    quiet(&f, &listener, &mut socket).await;
    assert_eq!(f.outbox().await, json!([]));
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_recall_revocation_blocks_old_approval_and_hides_old_memory() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Recall scope").await;
    f.change(&task, "trigger_now").await;
    let (mut socket, _) = next(&listener).await;
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"original recall observation"}),
    )
    .await;
    f.settled(&task, 1).await;
    f.setting("recall", json!(false)).await;
    f.change(&task, "trigger_now").await;
    let done = f.settled(&task, 2).await;
    assert_eq!(done["task"]["runs"][0]["outcome"], "blocked");
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
    f.send("Check memory", json!([])).await;
    let (mut socket, body) = next(&listener).await;
    assert!(!body.to_string().contains("original recall observation"));
    let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
    assert_eq!(page["records"], json!([]));
    quiet(&f, &listener, &mut socket).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_plain_completion_fails_but_preserves_its_checkpoint() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Interrupted progress").await;
    f.change(&task, "trigger_now").await;
    let (mut socket, _) = next(&listener).await;
    let (mut socket, staged) = memory(
        &listener,
        &mut socket,
        json!({"action":"checkpoint","note":{"text":"README checked; changelog still pending"}}),
    )
    .await;
    assert_eq!(staged["staged"], true);
    finish_text(&mut socket, "Partial investigation").await;
    let done = f.settled(&task, 1).await;
    assert_eq!(done["task"]["runs"][0]["outcome"], "failed");
    assert_eq!(f.outbox().await, json!([]));
    f.change(&task, "trigger_now").await;
    let (mut socket, _) = next(&listener).await;
    let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
    assert_eq!(
        page["records"][0]["content"]["checkpoint"]["text"],
        "README checked; changelog still pending"
    );
    assert_eq!(page["records"][0]["content"]["result"], Value::Null);
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"Remaining work checked"}),
    )
    .await;
    f.settled(&task, 2).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_search_continues_past_an_empty_bounded_page() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Older useful record").await;
    f.change(&task, "trigger_now").await;
    let (mut socket, _) = next(&listener).await;
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"report","text":"unique-original-search-marker"}),
    )
    .await;
    let (mut socket, _) = next(&listener).await;
    let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
    let record = page["records"][0]["id"].clone();
    for index in 0..33 {
        let (next_socket, saved) = memory(&listener, &mut socket, json!({"action":"correct","record":record,"note":{"text":format!("Additional observation {index}")}})).await;
        assert_eq!(saved["recorded"], true, "{saved}");
        socket = next_socket;
    }
    let (mut socket, page) = memory(
        &listener,
        &mut socket,
        json!({"action":"list","query":"unique-original-search-marker"}),
    )
    .await;
    assert_eq!(page["records"], json!([]));
    assert!(
        page["next_before"].is_number(),
        "an empty filtered page is not EOF"
    );
    let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list","query":"unique-original-search-marker","before":page["next_before"]})).await;
    assert_eq!(page["records"].as_array().unwrap().len(), 1);
    assert_eq!(page["records"][0]["id"], record);
    assert_eq!(page["next_before"], Value::Null);
    quiet(&f, &listener, &mut socket).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_tools_are_not_offered_to_an_ordinary_session() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let created=f.query("create",json!({"title":"Ordinary control","automaticTitle":false,"labels":[],"tools":["DiscoveryComplete","DiscoveryMemory"],"workspace":{"kind":"directory","path":f.rig.directory.path().join("workspace")}})).await;
    let session = created["session"]["id"].as_str().unwrap();
    f.query(
        "send",
        json!({"sessionId":session,"message":"Hello","backend":f.model,"delivery":"queue"}),
    )
    .await;
    let (mut socket, body) = next(&listener).await;
    let names: Vec<_> = body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| t["function"]["name"].as_str().unwrap())
        .collect();
    assert!(
        !names.contains(&"DiscoveryComplete") && !names.contains(&"DiscoveryMemory"),
        "{names:?}"
    );
    finish_text(&mut socket, "Ordinary answer").await;
    tokio::time::timeout(Duration::from_secs(45), f.quiescent(session))
        .await
        .expect("ordinary Run did not settle before Host teardown");
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn disabled_bot_blocks_an_approved_discovery_without_calling_a_model() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Disabled Bot").await;
    f.setting("bot", json!(false)).await;
    f.change(&task, "trigger_now").await;
    assert_eq!(
        f.settled(&task, 1).await["task"]["runs"][0]["outcome"],
        "blocked"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn disabling_scheduling_settles_existing_work_without_reviving_its_checkpoint() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Withdraw existing work").await;
    f.change(&task, "trigger_now").await;
    let (mut socket, _) = next(&listener).await;
    let (socket, result) = memory(
        &listener,
        &mut socket,
        json!({"action":"checkpoint","note":{"text":"discarded progress"}}),
    )
    .await;
    assert_eq!(result["staged"], true);
    f.setting("scheduledTasks", json!(false)).await;
    drop(socket);
    assert_eq!(
        f.settled(&task, 1).await["task"]["runs"][0]["outcome"],
        "blocked"
    );
    f.setting("scheduledTasks", json!(true)).await;
    f.change(&task, "trigger_now").await;
    let (mut socket, body) = next(&listener).await;
    assert!(!body.to_string().contains("discarded progress"));
    let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
    assert_eq!(page["records"], json!([]));
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"new investigation"}),
    )
    .await;
    f.settled(&task, 2).await;
    assert_eq!(f.outbox().await, json!([]));
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_model_proposals_require_bot_identity_and_human_approval() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let proposal = json!({"request":{"mode":"create","title":"Proposed discovery","intentBody":"Check authorized documents","effect":"discovery","schedule":{"kind":"interval","everySeconds":3600,"startAt":maka_agent_authority::now()+3_600_000},"timezone":"UTC"}});
    let created=f.query("create",json!({"title":"Ordinary proposer","automaticTitle":false,"labels":[],"tools":["ScheduledTask"],"workspace":{"kind":"directory","path":f.rig.directory.path().join("workspace")}})).await;
    let session = created["session"]["id"].as_str().unwrap();
    f.query("send",json!({"sessionId":session,"message":"Propose a discovery","backend":f.model,"delivery":"queue"})).await;
    let (mut socket, _) = next(&listener).await;
    tool(&mut socket, "ScheduledTask", proposal.clone()).await;
    let (mut socket, body) = next(&listener).await;
    assert!(
        output(&body).to_string().contains("discovery_requires_bot"),
        "{body}"
    );
    finish_text(&mut socket, "Cannot propose discovery here").await;
    assert_eq!(
        f.query("schedules", json!({"kind":"list"})).await["tasks"],
        json!([])
    );
    f.send("Propose a discovery", json!([])).await;
    let (mut socket, _) = next(&listener).await;
    tool(&mut socket, "ScheduledTask", proposal).await;
    let (mut socket, _) = next(&listener).await;
    let page = f.query("schedules", json!({"kind":"list"})).await;
    let task = &page["tasks"][0];
    let id = task["id"].as_str().unwrap();
    assert_eq!(task["status"], "paused");
    assert_eq!(task["approved"], false);
    tool(
        &mut socket,
        "ScheduledTask",
        json!({"request":{"mode":"resume","taskId":id,"revision":task["revision"]}}),
    )
    .await;
    let (mut socket, body) = next(&listener).await;
    assert!(
        output(&body)
            .to_string()
            .contains("scheduler_user_approval_required"),
        "{body}"
    );
    quiet(&f, &listener, &mut socket).await;
    f.change(id, "approve").await;
    f.change(id, "trigger_now").await;
    let (mut worker, _) = next(&listener).await;
    tool(
        &mut worker,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"Checked after user approval"}),
    )
    .await;
    assert_eq!(f.settled(id, 1).await["task"]["runs"][0]["outcome"], "ok");
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_one_shot_timer_runs_without_a_manual_trigger() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f
        .create_scheduled(
            "One check",
            json!({"kind":"once","runAt":maka_agent_authority::now()+2_000}),
        )
        .await;
    let (mut socket, _) = next(&listener).await;
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"Timed investigation"}),
    )
    .await;
    let done = f.settled(&task, 1).await;
    assert_eq!(done["task"]["status"], "completed");
    assert_eq!(done["task"]["runs"][0]["outcome"], "ok");
    assert_eq!(f.outbox().await, json!([]));
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_restart_settles_an_interrupted_original_run_without_replay() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Interrupted investigation").await;
    f.change(&task, "trigger_now").await;
    let (_socket, _) = next(&listener).await;
    let worker = f
        .owner()
        .scheduler
        .investigation
        .read()
        .unwrap()
        .clone()
        .unwrap();
    f.reopen().await;
    let original = f
        .owner()
        .durable
        .latest_run(worker.clone())
        .await
        .unwrap()
        .unwrap();
    f.query("stop", json!({"sessionId":worker,"runId":original}))
        .await;
    let done = f.settled(&task, 1).await;
    assert_eq!(done["task"]["runs"][0]["outcome"], "failed");
    assert_eq!(done["task"]["runs"][0]["sessionId"], worker);
    assert_eq!(done["task"]["runs"][0]["runId"], json!(original));
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
    f.close().await;
}
