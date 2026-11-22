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
use maka_agent_facts::configuration::ConnectionCatalogEntryUpdate;
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
        Self::with_tools(listener, &[]).await
    }
    async fn with_tools(listener: &TcpListener, extra: &[Value]) -> Self {
        let mut rig = Rig::new().unwrap();
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap_with(
            &base,
            format!("http://{}/v1", listener.local_addr().unwrap()),
            |config| {
                config["bot"] = json!(true);
                config["scheduledTasks"] = json!(true);
                config["recall"] = json!(true);
                config["workspaceRoots"] = json!([
                    {"label":"source","path":base.join("workspace")},
                    {"label":"destination","path":base.join("other-workspace")}
                ]);
                config["tools"] = json!([
                    {
                        "name":"Read","description":"Read a workspace file.",
                        "input":"json","result":"image","confirmation":"preapproved",
                        "target":{"kind":"import","name":"files"},"method":"read"
                    },
                    {
                        "name":"Write","description":"Write a workspace file.",
                        "input":"json","result":"json","confirmation":"preapproved",
                        "target":{"kind":"import","name":"files"},"method":"write"
                    }
                ]);
                config["tools"]
                    .as_array_mut()
                    .unwrap()
                    .extend_from_slice(extra);
                #[cfg(target_os = "macos")]
                config["tools"].as_array_mut().unwrap().push(json!({
                    "name":"Shell","description":"Execute a workspace shell command.",
                    "input":"shell","result":"json","confirmation":"preapproved",
                    "target":{"kind":"import","name":"processes"},"method":"execute"
                }));
            },
        )
        .await
        .unwrap();
        std::fs::create_dir_all(base.join("other-workspace")).unwrap();
        std::fs::write(
            base.join("workspace").join("discovery.txt"),
            "Observed fixture evidence",
        )
        .unwrap();
        attach(&mut rig, &boot).await.unwrap();
        let client = rig.client.as_ref().unwrap();
        let catalog = call(client, "settings", "connections", json!({"kind":"start"}))
            .await
            .unwrap();
        let connection=call(client,"settings","create",json!({"expectedCatalogRevision":catalog["revision"],"connection":{"slug":"discovery","name":"Discovery fixture","provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},"configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.2"],"modelOverrides":{"llama3.2":{"codeMode":false,"apiProtocol":"openai-chat-completions"}}}})).await.unwrap();
        assert_eq!(connection["kind"], "committed");
        let model = json!({"kind":"model","connectionId":connection["connection"]["connectionId"],"modelId":"llama3.2","thinkingLevel":null});
        let opened = call(
            client,
            "agent",
            "openBot",
            json!({
                "workspace":{"kind":"directory","path":base.join("workspace")}
            }),
        )
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
    fn active_worker(&self) -> String {
        self.owner()
            .scheduler
            .investigation
            .read()
            .unwrap()
            .as_ref()
            .unwrap()
            .worker
            .clone()
    }
    async fn query(&self, method: &str, input: Value) -> Value {
        call(self.rig.client.as_ref().unwrap(), "agent", method, input)
            .await
            .unwrap_or_else(|e| panic!("{method}: {e}"))
    }
    async fn create(&self, title: &str) -> String {
        self.create_scheduled(
            title,
            &format!("Check authorized sources for {title}"),
            json!({"kind":"interval","everySeconds":3600,"startAt":maka_agent_authority::now()+3_600_000}),
        )
        .await
    }
    async fn create_scheduled(&self, title: &str, direction: &str, schedule: Value) -> String {
        self.create_with_worker_tools(title, direction, schedule, Some("session"))
            .await
    }
    async fn create_with_worker_tools(
        &self,
        title: &str,
        direction: &str,
        schedule: Value,
        tools: Option<&str>,
    ) -> String {
        let effect = self.effect(tools.unwrap_or("read_only")).await;
        self.create_effect(title, direction, schedule, effect).await
    }
    async fn create_effect(
        &self,
        title: &str,
        direction: &str,
        schedule: Value,
        effect: Value,
    ) -> String {
        let catalog = self.preview(&effect, None).await;
        let catalog = match effect["selectedTools"].as_object() {
            Some(chosen) => json!(
                catalog
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|name| {
                        let name = name.as_str().unwrap();
                        matches!(
                            name,
                            "DiscoveryComplete"
                                | "FinishNoChange"
                                | "RegisterWatch"
                                | "StagePendingAction"
                                | "StageArtifact"
                                | "UpsertDossier"
                        ) || chosen.contains_key(name)
                    })
                    .collect::<Vec<_>>()
            ),
            None => catalog,
        };
        let result=self.query("schedule",json!({"kind":"create","input":{"task":{"title":title,"intentBody":direction,"schedule":schedule,"effect":effect,"maxFires":null,"expiresAt":null},"timezone":"UTC","misfire":"latest","approvedTools":catalog}})).await;
        assert_eq!(result["kind"], "committed", "{result}");
        result["taskId"].as_str().unwrap().to_owned()
    }
    async fn effect(&self, tools: &str) -> Value {
        let config = self.owner().session(&self.bot).await.unwrap().configuration;
        json!({"kind":"discovery","target":{"sessionId":self.bot,"workspace":config.workspace,"permissions":config.permissions,"boundaryRevision":config.boundary_revision,"binding":config.binding},"model":{"connectionId":self.model["connectionId"],"modelId":"llama3.2"},"thinkingLevel":null,"workerTools":tools})
    }
    async fn preview(&self, effect: &Value, task_id: Option<&str>) -> Value {
        let preview = self
            .query(
                "schedules",
                json!({
                    "kind":"preview_discovery","effect":effect,"taskId":task_id,
                }),
            )
            .await;
        assert_eq!(preview["kind"], "discovery_tools", "{preview}");
        preview["names"].clone()
    }
    async fn reapprove(&self, task: &str, profile: &str) -> Value {
        let detail = self.detail(task).await;
        let effect = self.effect(profile).await;
        let names = self.preview(&effect, Some(task)).await;
        self.query("schedule", json!({
            "kind":"approve","taskId":task,"revision":detail["revision"],"input":{
                "task": {"title":detail["task"]["title"],"intentBody":detail["task"]["intent"]["body"],
                    "schedule":detail["task"]["schedule"],"effect":effect,
                    "maxFires":detail["task"]["maxFires"],"expiresAt":detail["task"]["expiresAt"]},
                "timezone":detail["timezone"], "misfire":detail["misfire"], "approvedTools":names
            },
        })).await
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
    async fn change_model_endpoint(&self, listener: &TcpListener) {
        self.update_model_connection(ConnectionCatalogEntryUpdate {
            configuration: Some(json!({
                "baseUrl":format!("http://{}/v1", listener.local_addr().unwrap())
            })),
            ..Default::default()
        })
        .await;
    }
    async fn update_model_connection(&self, changes: ConnectionCatalogEntryUpdate) {
        use maka_agent_facts::configuration::{
            CatalogMutationResult, ConnectionVersionBasis, UpdateCatalogConnectionInput,
        };

        let owner = self.owner();
        let catalog = owner.configuration.catalog().await.unwrap();
        let connection_id = self.model["connectionId"].as_str().unwrap();
        let connection = catalog
            .connections
            .iter()
            .find(|connection| connection.connection_id == connection_id)
            .unwrap();
        let updated = owner
            .configuration
            .update_connection(UpdateCatalogConnectionInput {
                expected: ConnectionVersionBasis {
                    connection_id: connection_id.to_owned(),
                    revision: connection.revision,
                },
                changes,
            })
            .await
            .unwrap();
        assert!(
            matches!(updated, CatalogMutationResult::Committed { .. }),
            "{updated:?}"
        );
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
async fn discovery_notification_receipt_is_idempotent_across_retry_and_reopen() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Notification receipt").await;
    f.change(&task, "trigger_now").await;
    let (mut socket, request) = next(&listener).await;
    let tools = request["tools"].as_array().unwrap();
    assert!(tools.iter().any(|tool| tool["function"]["name"] == "Read"));
    #[cfg(target_os = "macos")]
    assert!(tools.iter().any(|tool| tool["function"]["name"] == "Shell"));
    let observation =
        json!({"text":"Evidence remains useful after notification.","references":["source.md"]});
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"report","text":"A useful finding","notes":[observation]}),
    )
    .await;
    f.settled(&task, 1).await;
    assert_bot_untouched(&f).await;
    f.send(
        "Read the investigation record and publish my requested notification",
        json!([]),
    )
    .await;
    let (mut socket, _) = next(&listener).await;
    let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
    let record = page["records"][0]["id"].clone();
    let (mut socket, entry) = memory(
        &listener,
        &mut socket,
        json!({"action":"get","record":record}),
    )
    .await;
    assert_eq!(entry["content"]["result"]["notes"], json!([observation]));
    let input = json!({"messageId":"notification-uncertain","messages":[{"text":"A useful finding"}],"discovery":{"record":record,"reason":"verified"}});
    tool(&mut socket, "SendUser", input.clone()).await;
    let (mut socket, _) = next(&listener).await;
    quiet(&f, &listener, &mut socket).await;
    let original = f.outbox().await;
    assert_eq!(original.as_array().unwrap().len(), 1);
    let publication = &original[0];
    let run = f.settled(&task, 1).await["task"]["runs"][0].clone();
    assert_eq!(publication["discovery"]["recordId"], record);
    assert_eq!(
        publication["discovery"]["workerSessionId"],
        run["sessionId"]
    );
    assert_eq!(
        publication["discovery"]["workerTurnId"],
        entry["source"]["turnId"]
    );
    f.change_source(|config| config.boundary_revision += 1)
        .await;
    f.change(&task, "trigger_now").await;
    let blocked = f.settled(&task, 2).await;
    assert_eq!(blocked["task"]["status"], "paused", "{blocked}");
    assert_eq!(blocked["approved"], false, "{blocked}");
    assert!(blocked["task"]["nextFireAt"].is_null(), "{blocked}");
    assert_eq!(
        blocked["task"]["lastError"],
        "scheduler_authorization_changed"
    );
    assert_eq!(f.reapprove(&task, "session").await["kind"], "committed");
    assert_eq!(f.detail(&task).await["task"]["status"], "active");
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
    assert_eq!(page["records"][0]["kind"], "notified");
    assert_eq!(f.outbox().await, original);
    let (mut socket, sent_source) = memory(
        &listener,
        &mut socket,
        json!({"action":"get","record":page["records"][0]["id"]}),
    )
    .await;
    assert_eq!(
        sent_source["source_path"],
        format!("maka://session/{}", f.bot)
    );
    assert_eq!(
        sent_source["content"]["message_id"],
        "notification-uncertain"
    );
    quiet(&f, &listener, &mut socket).await;
    let quote = json!({"text":"Do not repeat this finding", "label":"Proactive discovery",
        "sourceMessageId":format!("bot/{}",publication["sequence"]),"sourceTurnId":publication["turnId"],
        "source":{"sessionId":f.bot,"sessionName":"Bot","capturedAt":maka_agent_authority::now(),"truncated":false}});
    let sent = f.send("", json!([quote])).await;
    let (mut socket, body) = next(&listener).await;
    assert!(body.to_string().contains("Do not repeat this finding"));
    let (mut socket, rejected) = memory(
        &listener,
        &mut socket,
        json!({"action":"feedback","record":"another-investigation","note":"Wrong target"}),
    )
    .await;
    assert!(
        rejected
            .to_string()
            .contains("feedback_does_not_match_quoted_discovery"),
        "{rejected}"
    );
    let (mut socket, saved) = memory(
        &listener,
        &mut socket,
        json!({"action":"feedback","note":"Stop repeating this"}),
    )
    .await;
    assert_eq!(saved["recorded"], true, "{saved}");
    let (mut socket, source) = memory(
        &listener,
        &mut socket,
        json!({"action":"get","record":saved["record"]}),
    )
    .await;
    assert_eq!(source["source_path"], format!("maka://session/{}", f.bot));
    assert_eq!(source["content"]["message_id"], sent["messageId"]);
    quiet(&f, &listener, &mut socket).await;
    f.reopen().await;
    let mut position = json!({"kind":"tail"});
    let mut through = Value::Null;
    let displayed = loop {
        let history = f
            .query(
                "history",
                json!({"sessionId":f.bot,"position":position,"through":through}),
            )
            .await;
        through = history["through"].clone();
        if let Some(chunk) = history["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|chunk| chunk["messageId"] == sent["messageId"] && chunk["offset"] == 0)
        {
            break chunk.clone();
        }
        assert!(
            !history["before"].is_null(),
            "quoted message missing from history: {sent}"
        );
        let before = json!({"kind":"before","cursor":history["before"]});
        assert_ne!(before, position, "history cursor did not advance");
        position = before;
    };
    assert_eq!(
        displayed["quotes"],
        json!([{ "text":quote["text"], "label":quote["label"], "truncated":false }])
    );
    assert_eq!(displayed["hasReferences"], true);
    assert_eq!(displayed["text"], "");
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_late_notification_keeps_the_original_outbox_and_quoted_feedback_together() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Late notification").await;
    let mut records = vec![];
    for subject in ["First finding", "Second finding"] {
        f.change(&task, "trigger_now").await;
        let (mut worker, _) = next(&listener).await;
        tool(
            &mut worker,
            "DiscoveryComplete",
            json!({"kind":"report","text":subject}),
        )
        .await;
        f.settled(&task, records.len() + 1).await;
        f.send("Read the saved investigation", json!([])).await;
        let (mut bot, _) = next(&listener).await;
        let (mut bot, page) = memory(&listener, &mut bot, json!({"action":"list"})).await;
        records.push(page["records"][0]["id"].as_str().unwrap().to_owned());
        quiet(&f, &listener, &mut bot).await;
        f.settled(&task, records.len()).await;
    }
    assert_ne!(records[0], records[1]);
    f.send("Publish the first finding.", json!([])).await;
    let (mut bot, _) = next(&listener).await;
    tool(
        &mut bot,
        "SendUser",
        json!({"messageId":"two-parts","messages":[{"text":"Finding"},{"text":"Details"}]}),
    )
    .await;
    let (mut bot, _) = next(&listener).await;
    let notified = |record: &str| json!({"action":"notified","record":record,"reason":"verified","message_id":"two-parts"});
    let (mut bot, linked) = memory(&listener, &mut bot, notified(&records[0])).await;
    assert_eq!(linked["recorded"], true, "{linked}");
    let (mut bot, rejected) = memory(&listener, &mut bot, notified(&records[1])).await;
    assert!(
        rejected
            .to_string()
            .contains("notification_linked_to_another_discovery"),
        "{rejected}"
    );
    let (mut bot, other) = memory(
        &listener,
        &mut bot,
        json!({"action":"list","related":records[1]}),
    )
    .await;
    assert!(
        other["records"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["kind"] != "notified")
    );
    quiet(&f, &listener, &mut bot).await;
    f.reopen().await;
    let outbox = f.query("botOutbox", json!({})).await;
    assert_eq!(outbox["through"], 2);
    assert_eq!(outbox["discoveryLink"]["revision"], 1);
    let messages = outbox["messages"].as_array().unwrap();
    assert!(
        messages
            .iter()
            .all(|message| message["discovery"]["recordId"] == records[0])
    );
    let second = &messages[1];
    let quote = json!({"text":"Details","sourceMessageId":format!("bot/{}", second["sequence"]),
        "sourceTurnId":second["turnId"],"source":{"sessionId":f.bot,"sessionName":"Bot",
        "capturedAt":maka_agent_authority::now(),"truncated":false}});
    f.send("Please stop.", json!([quote])).await;
    let (mut bot, _) = next(&listener).await;
    let (mut bot, retried) = memory(&listener, &mut bot, notified(&records[0])).await;
    assert_eq!(retried, linked);
    let (mut bot, feedback) = memory(
        &listener,
        &mut bot,
        json!({"action":"feedback","note":"Stop this finding"}),
    )
    .await;
    let (mut bot, entry) = memory(
        &listener,
        &mut bot,
        json!({"action":"get","record":feedback["record"]}),
    )
    .await;
    assert_eq!(entry["content"]["record"], records[0], "{entry}");
    quiet(&f, &listener, &mut bot).await;
    f.close().await;
}

fn assert_requires_reapproval(detail: &Value, message: &str) {
    assert_eq!(detail["task"]["status"], "paused", "{detail}");
    assert_eq!(detail["approved"], false, "{detail}");
    assert!(detail["task"]["nextFireAt"].is_null(), "{detail}");
    assert_eq!(
        detail["task"]["lastError"], "scheduler_authorization_changed",
        "{detail}"
    );
    assert_eq!(detail["task"]["runs"][0]["outcome"], "blocked", "{detail}");
    assert_eq!(detail["task"]["runs"][0]["message"], message, "{detail}");
}

async fn check_removed_credential(at_delivery: bool) {
    use maka_agent_facts::{
        configuration::{
            ConnectionCredentialKind, ConnectionCredentialTarget, CredentialLocator,
            CredentialMutationResult, CredentialVaultQueryResult, DeleteCredentialInput,
        },
        oauth::{LoginStart, Target},
        provider::{AuthenticationInput, Credential},
    };
    use maka_config::oauth::enrollment::{LoginCompletion, LoginPreparation};

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let healthy = f.create("Healthy plan with a separate connection").await;
    let owner = f.owner();
    let store = &owner.configuration;
    let client = f.rig.client.as_ref().unwrap();
    let catalog = call(client, "settings", "connections", json!({"kind":"start"}))
        .await
        .unwrap();
    let created = call(client, "settings", "create", json!({
        "expectedCatalogRevision": catalog["revision"],
        "connection": {"slug":"keyed-discovery", "name":"Synthetic keyed connection",
            "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"new-api"},
            "configuration":{"baseUrl":f.boot.base_url}, "enabled":true,"enabledModelIds":["llama3.2"],
            "modelOverrides":{"llama3.2":{"codeMode":false,"apiProtocol":"openai-chat-completions"}}}
    })).await.unwrap();
    assert_eq!(created["kind"], "committed", "{created}");
    let id = created["connection"]["connectionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let target =
        |row: maka_agent_facts::configuration::ConnectionCatalogEntry| ConnectionCredentialTarget {
            connection_id: row.connection_id,
            revision: row.revision,
            slug: row.slug,
            provider: row.provider,
            configuration: row.configuration,
        };
    let row = store
        .catalog()
        .await
        .unwrap()
        .connections
        .into_iter()
        .find(|row| row.connection_id == id)
        .unwrap();
    let original = target(row);
    let login = LoginStart {
        attempt_id: "discovery-test-login".into(),
        expected_credential: None,
        target: Target::Existing {
            expected: original.clone(),
            configuration: original.configuration,
        },
        authentication: AuthenticationInput {
            method: "api-key".into(),
            input: json!({"apiKey":"synthetic-fixture-token"}),
        },
    };
    let LoginPreparation::Ready(ticket) = store.prepare_oauth_login(login).await.unwrap() else {
        panic!("Cannot enroll fixture connection")
    };
    assert!(ticket.claim().await.unwrap());
    assert!(matches!(
        ticket
            .complete(
                Credential {
                    secret: "synthetic-fixture-token".into(),
                    refresh_at: None
                },
                1
            )
            .await
            .unwrap(),
        LoginCompletion::Committed(_)
    ));

    let mut effect = f.effect("session").await;
    effect["model"]["connectionId"] = json!(id);
    let task = f.create_effect("Plan whose authorization will become unavailable","Check a synthetic fixture",
        json!({"kind":"interval","everySeconds":3600,"startAt":maka_agent_authority::now()+3_600_000}), effect).await;
    let mut worker = if at_delivery {
        f.change(&task, "trigger_now").await;
        Some(next(&listener).await.0)
    } else {
        None
    };
    let row = store
        .catalog()
        .await
        .unwrap()
        .connections
        .into_iter()
        .find(|row| row.connection_id == id)
        .unwrap();
    let locator = CredentialLocator::Connection {
        connection_id: id.clone(),
        kind: ConnectionCredentialKind::Provider,
    };
    let CredentialVaultQueryResult::Status { status } =
        store.credential_status(locator).await.unwrap()
    else {
        panic!("Key missing from test setup")
    };
    assert!(matches!(
        store
            .delete_credential(DeleteCredentialInput {
                expected: status.basis().unwrap(),
                expected_connection: Some(target(row))
            })
            .await
            .unwrap(),
        CredentialMutationResult::Committed { .. }
    ));
    if let Some(socket) = &mut worker {
        tool(
            socket,
            "DiscoveryComplete",
            json!({"kind":"report","text":"Synthetic finding"}),
        )
        .await;
    } else {
        f.change(&task, "trigger_now").await;
    }
    let blocked = f.settled(&task, 1).await;
    if at_delivery {
        assert_eq!(blocked["task"]["runs"][0]["outcome"], "ok", "{blocked}");
    } else {
        assert_requires_reapproval(&blocked, "agent_authentication_required");
    }
    assert_eq!(blocked["task"]["runs"][0]["runId"].is_string(), at_delivery);
    assert!(blocked["pendingFire"].is_null());
    assert_eq!(f.outbox().await, json!([]));
    f.change(&healthy, "trigger_now").await;
    let (mut control, _) = next(&listener).await;
    tool(
        &mut control,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"Control ran"}),
    )
    .await;
    assert_eq!(
        f.settled(&healthy, 1).await["task"]["runs"][0]["outcome"],
        "ok"
    );
    assert_eq!(f.reapprove(&task, "session").await["kind"], "committed");
    let renewed = f.detail(&task).await;
    assert_eq!(
        renewed["task"]["effect"]["model"]["connectionId"],
        f.model["connectionId"]
    );
    assert_eq!(renewed["task"]["status"], "active");
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_releases_the_slot_when_required_credentials_are_removed() {
    check_removed_credential(false).await;
    check_removed_credential(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_releases_the_slot_when_its_workspace_disappears() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let workspace = f.rig.directory.path().join("workspace");
    let moved = f.rig.directory.path().join("moved-workspace");
    for reporting in [false, true] {
        let task = f.create("Check the approved workspace").await;
        if reporting {
            f.change(&task, "trigger_now").await;
            let (mut worker, _) = next(&listener).await;
            std::fs::rename(&workspace, &moved).unwrap();
            tool(
                &mut worker,
                "DiscoveryComplete",
                json!({"kind":"report","text":"Workspace finding"}),
            )
            .await;
        } else {
            std::fs::rename(&workspace, &moved).unwrap();
            f.change(&task, "trigger_now").await;
        }
        let blocked = f.settled(&task, 1).await;
        if reporting {
            assert_eq!(blocked["task"]["runs"][0]["outcome"], "ok", "{blocked}");
        } else {
            assert_requires_reapproval(&blocked, "agent_workspace_unavailable");
        }
        assert_eq!(blocked["task"]["runs"][0]["runId"].is_string(), reporting);
        assert!(blocked["pendingFire"].is_null());
        assert_eq!(f.outbox().await, json!([]));
        std::fs::rename(&moved, &workspace).unwrap();
    }
    let healthy = f.create("Independent plan").await;
    f.change(&healthy, "trigger_now").await;
    let (mut control, _) = next(&listener).await;
    tool(
        &mut control,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"Control ran"}),
    )
    .await;
    assert_eq!(
        f.settled(&healthy, 1).await["task"]["runs"][0]["outcome"],
        "ok"
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_rejects_script_edits_even_when_the_existing_grant_matches() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Time-based investigation").await;
    let detail = f.detail(&task).await;
    let effect = detail["task"]["effect"].clone();
    let names = f.preview(&effect, Some(&task)).await;
    let result = f.query("schedule", json!({
        "kind":"update", "taskId":task, "revision":detail["revision"],
        "input":{"task":{"title":"Script check","intentBody":"Check only on a match","schedule":{
            "kind":"script","source":"console.log(false)","everySeconds":60,"startAt":maka_agent_authority::now()+1000
        },"effect":effect,"maxFires":null,"expiresAt":null},"timezone":"UTC","misfire":"latest","approvedTools":names}
    })).await;
    assert_eq!(
        result["reason"], "discovery_requires_time_schedule",
        "{result}"
    );
    let unchanged = f.detail(&task).await;
    assert_eq!(unchanged["revision"], detail["revision"]);
    assert_eq!(unchanged["task"]["schedule"], detail["task"]["schedule"]);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_invalidates_changed_model_routes_and_releases_the_slot() {
    let original = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let updated = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&original).await;
    f.change_source(|config| config.tools = Some(vec!["Read".into()]))
        .await;
    let stale = f.create("Approved before the endpoint changed").await;
    f.change_source(|config| config.tools = None).await;
    f.change_model_endpoint(&updated).await;
    f.change(&stale, "trigger_now").await;

    let blocked = f.settled(&stale, 1).await;
    assert_requires_reapproval(&blocked, "background_model_route_changed");
    assert!(blocked["task"]["runs"][0]["runId"].is_null(), "{blocked}");
    assert_eq!(
        blocked["task"]["effect"]["selectedTools"],
        json!({"Read":"read_files"})
    );
    let available = f.preview(&f.effect("session").await, Some(&stale)).await;
    assert!(
        available
            .as_array()
            .unwrap()
            .contains(&json!("StageArtifact"))
    );

    let reporting = f.create("Route changes while investigating").await;
    f.change(&reporting, "trigger_now").await;
    let (mut socket, _) = next(&updated).await;
    f.change_model_endpoint(&original).await;
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"report","text":"A finding on the previously approved route"}),
    )
    .await;
    let blocked = f.settled(&reporting, 1).await;
    assert_eq!(blocked["task"]["runs"][0]["outcome"], "ok", "{blocked}");
    assert!(blocked["task"]["runs"][0]["runId"].is_string(), "{blocked}");
    assert_eq!(f.outbox().await, json!([]));

    assert_eq!(f.reapprove(&stale, "session").await["kind"], "committed");
    f.change(&stale, "trigger_now").await;
    let (mut socket, _) = next(&original).await;
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"Checked after reapproval"}),
    )
    .await;
    assert_eq!(
        f.settled(&stale, 2).await["task"]["runs"][0]["outcome"],
        "ok"
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_checks_model_on_worker_admission_and_settles_locally() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let waiting = f.create("Approved before disabling the connection").await;
    let reporting = f.create("Model removed before report delivery").await;

    f.update_model_connection(ConnectionCatalogEntryUpdate {
        enabled: Some(false),
        ..Default::default()
    })
    .await;
    f.change(&waiting, "trigger_now").await;
    let blocked = f.settled(&waiting, 1).await;
    assert_requires_reapproval(&blocked, "background_model_unavailable");
    assert!(blocked["task"]["runs"][0]["runId"].is_null(), "{blocked}");

    f.update_model_connection(ConnectionCatalogEntryUpdate {
        enabled: Some(true),
        ..Default::default()
    })
    .await;
    f.change(&reporting, "trigger_now").await;
    let (mut socket, _) = next(&listener).await;
    f.update_model_connection(ConnectionCatalogEntryUpdate {
        enabled_model_ids: Some(vec![]),
        ..Default::default()
    })
    .await;
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"report","text":"A finding whose delivery model was removed"}),
    )
    .await;
    let blocked = f.settled(&reporting, 1).await;
    assert_eq!(blocked["task"]["runs"][0]["outcome"], "ok", "{blocked}");
    assert!(blocked["task"]["runs"][0]["runId"].is_string(), "{blocked}");
    assert_eq!(f.outbox().await, json!([]));

    f.update_model_connection(ConnectionCatalogEntryUpdate {
        enabled_model_ids: Some(vec!["llama3.2".into()]),
        ..Default::default()
    })
    .await;
    assert_eq!(f.reapprove(&waiting, "session").await["kind"], "committed");
    f.change(&waiting, "trigger_now").await;
    let (mut socket, _) = next(&listener).await;
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"Checked after enabling the model again"}),
    )
    .await;
    assert_eq!(
        f.settled(&waiting, 2).await["task"]["runs"][0]["outcome"],
        "ok"
    );
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
async fn discovery_resume_does_not_upgrade_an_existing_read_only_plan() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create_with_worker_tools(
        "Original read-only approval", "Check one file",
        json!({"kind":"interval","everySeconds":3600,"startAt":maka_agent_authority::now()+3_600_000}),
        None,
    ).await;
    f.change(&task, "pause").await;
    f.change(&task, "resume").await;
    assert_eq!(
        f.detail(&task).await["task"]["effect"]["workerTools"],
        "read_only"
    );
    f.change(&task, "trigger_now").await;
    let (mut worker, request) = next(&listener).await;
    let tools = request["tools"].as_array().unwrap();
    assert!(
        tools
            .iter()
            .any(|t| t["function"]["name"] == "DiscoveryComplete")
    );
    assert!(!tools.iter().any(|t| matches!(
        t["function"]["name"].as_str(),
        Some("Shell" | "Write" | "tool_search" | "ScheduledTask")
    )));
    for name in ["Read", "RecallMaterial"] {
        assert!(
            tools.iter().any(|tool| tool["function"]["name"] == name),
            "{tools:?}"
        );
    }
    tool(&mut worker, "Read", json!({"path":"discovery.txt"})).await;
    let (mut worker, body) = next(&listener).await;
    assert!(
        output(&body)
            .to_string()
            .contains("Observed fixture evidence"),
        "{body}"
    );
    tool(
        &mut worker,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"Read-only check"}),
    )
    .await;
    let done = f.settled(&task, 1).await;
    let worker = done["task"]["runs"][0]["sessionId"].as_str().unwrap();
    assert_eq!(
        f.owner()
            .session(worker)
            .await
            .unwrap()
            .configuration
            .permissions,
        crate::owner::discovery::permissions()
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_previews_and_enforces_the_bot_tool_ceiling() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    f.change_source(|config| config.tools = Some(vec!["ScheduledTask".into()]))
        .await;

    let names = f.preview(&f.effect("session").await, None).await;
    assert_eq!(
        names,
        json!([
            "DiscoveryComplete",
            "FinishNoChange",
            "RegisterWatch",
            "ScheduledTask",
            "StageArtifact",
            "StagePendingAction",
            "UpsertDossier"
        ])
    );
    let task = f.create("Investigation under the explicit ceiling").await;
    f.change(&task, "trigger_now").await;
    let (mut worker, request) = next(&listener).await;
    assert_eq!(json!(model_tool_names(&request)), names);
    assert!(
        !request["messages"]
            .to_string()
            .contains("Use DiscoveryMemory to read")
    );
    tool(
        &mut worker,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"Finished with approved tools"}),
    )
    .await;
    assert_eq!(
        f.settled(&task, 1).await["task"]["runs"][0]["outcome"],
        "ok"
    );
    f.send("Check the Bot tool ceiling", json!([])).await;
    let (mut socket, request) = next(&listener).await;
    let tools = request["tools"].as_array().unwrap();
    assert!(
        tools
            .iter()
            .any(|tool| tool["function"]["name"] == "ScheduledTask"),
        "{tools:?}"
    );
    assert!(
        !tools
            .iter()
            .any(|tool| tool["function"]["name"] == "DiscoveryMemory"),
        "{tools:?}"
    );
    quiet(&f, &listener, &mut socket).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_approves_grouped_aliases_and_rechecks_the_parent_ceiling() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::with_tools(&listener, &[
        json!({"name":"OpenDocument","description":"Read a document.","input":"json","result":"image","confirmation":"preapproved","target":{"kind":"import","name":"files"},"method":"read"}),
        json!({"name":"BrowseConversations","description":"List conversations.","input":"json","result":"json","confirmation":"preapproved","target":{"kind":"export","name":"agent"},"method":"sessionList"}),
        json!({"name":"SessionRead","description":"List available models.","input":"json","result":"json","confirmation":"preapproved","target":{"kind":"export","name":"agent"},"method":"models"}),
        json!({"name":"InspectSetup","description":"Read plugin settings.","result":"json","confirmation":"preapproved","target":{"kind":"import","name":"management"},"method":"readSettings"}),
        json!({"name":"ChangeSetup","description":"Configure a plugin.","result":"json","confirmation":"preapproved","target":{"kind":"import","name":"management"},"method":"configure"}),
    ]).await;
    let read_only = f.preview(&f.effect("read_only").await, None).await;
    let eligible = read_only.as_array().unwrap();
    assert!(
        eligible.contains(&json!("BrowseConversations"))
            && !eligible.contains(&json!("SessionRead")),
        "{eligible:?}"
    );
    let mut effect = f.effect("session").await;
    let preview = f
        .query(
            "schedules",
            json!({"kind":"preview_discovery","effect":effect}),
        )
        .await;
    assert_eq!(preview["groups"]["OpenDocument"], "read_files");
    assert_eq!(preview["groups"]["InspectSetup"], "other");
    assert!(preview["groups"].get("ChangeSetup").is_none());
    assert_eq!(preview["groups"]["DiscoveryMemory"], "history");
    assert!(preview["groups"].get("DiscoveryComplete").is_none());
    let schedule = json!({"kind":"interval","everySeconds":3600,"startAt":maka_agent_authority::now()+3_600_000});
    effect["selectedTools"] = json!({"ChangeSetup":"other"});
    let rejected = f.query("schedule",json!({"kind":"create","input":{
        "task":{"title":"Stale category","intentBody":"","schedule":schedule,"effect":effect},
        "timezone":"UTC","misfire":"latest","approvedTools":["ChangeSetup","DiscoveryComplete"]
    }})).await;
    assert_eq!(
        rejected["reason"], "scheduler_discovery_tools_changed",
        "{rejected}"
    );

    effect["selectedTools"] = json!({"OpenDocument":"read_files","InspectSetup":"other"});
    let task = f
        .create_effect("Grouped tools", "", schedule, effect.clone())
        .await;
    f.reopen().await;
    let preview = f
        .query(
            "schedules",
            json!({"kind":"preview_discovery","effect":effect,"taskId":task}),
        )
        .await;
    assert_eq!(
        preview["approvedNames"],
        json!([
            "DiscoveryComplete",
            "FinishNoChange",
            "InspectSetup",
            "OpenDocument",
            "RegisterWatch",
            "StageArtifact",
            "StagePendingAction",
            "UpsertDossier"
        ])
    );
    f.change(&task, "trigger_now").await;
    let (mut worker, request) = next(&listener).await;
    assert_eq!(
        model_tool_names(&request),
        [
            "DiscoveryComplete",
            "FinishNoChange",
            "InspectSetup",
            "OpenDocument",
            "RegisterWatch",
            "StageArtifact",
            "StagePendingAction",
            "UpsertDossier"
        ]
    );
    let opening = request["messages"].to_string();
    assert!(
        !opening.contains("recent_conversations")
            && !opening.contains("use SessionList to find conversations")
    );
    tool(&mut worker, "OpenDocument", json!({"path":"discovery.txt"})).await;
    let (mut worker, response) = next(&listener).await;
    assert!(
        output(&response)
            .to_string()
            .contains("Observed fixture evidence"),
        "{response}"
    );
    tool(
        &mut worker,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"Checked"}),
    )
    .await;
    f.settled(&task, 1).await;
    f.change_source(|config| config.tools = Some(vec!["Read".into()]))
        .await;
    f.change(&task, "trigger_now").await;
    let (mut worker, request) = next(&listener).await;
    assert_eq!(
        model_tool_names(&request),
        [
            "DiscoveryComplete",
            "FinishNoChange",
            "RegisterWatch",
            "StageArtifact",
            "StagePendingAction",
            "UpsertDossier"
        ]
    );
    tool(
        &mut worker,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"Finished"}),
    )
    .await;
    f.settled(&task, 2).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_preview_omits_tools_attached_only_to_the_bot_session() {
    use maka_agent_facts::configuration::mcp::{ServerConfiguration, Transport};
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let owner = f.owner();
    let directory = f.rig.directory.path();
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../mcp/tests/server.mjs");
    let config = ServerConfiguration::new(
        "session-demo".into(),
        Transport::Stdio {
            command: "node".into(),
            args: vec![
                script.to_str().unwrap().into(),
                "normal".into(),
                directory.join("mcp-events.jsonl").to_str().unwrap().into(),
            ],
            cwd: directory.to_str().unwrap().into(),
            env: Default::default(),
            pass_env: vec![],
        },
    );
    let servers = Arc::new(
        crate::mcp::Servers::open(&[config], &owner.configuration)
            .await
            .unwrap(),
    );
    let generation = crate::mcp::ClientGeneration::fresh();
    let projects = &owner.mcp_projects;
    projects.begin_client(&f.bot, generation).unwrap();
    projects
        .publish_client(&f.bot, generation, servers.clone())
        .unwrap();
    let client_tool = "mcp__session_demo__echo";
    assert!(
        projects
            .with_client(&f.bot, projects.base.clone())
            .unwrap()
            .tools
            .contains(client_tool)
    );
    let names = f.preview(&f.effect("session").await, None).await;
    let names = names.as_array().unwrap();
    assert!(
        names.contains(&json!("Read")) && !names.contains(&json!(client_tool)),
        "{names:?}"
    );
    projects.withdraw_client(&f.bot, generation);
    servers.close().await.unwrap();
    projects.remove_client(&f.bot, generation);
    f.close().await;
}

fn model_tool_names(request: &Value) -> Vec<&str> {
    let mut names: Vec<_> = request["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["function"]["name"].as_str().unwrap())
        .collect();
    names.sort_unstable();
    names
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_standard_tools_pin_the_displayed_list_until_reapproved() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    f.change_source(|config| config.tools = Some(vec!["ScheduledTask".into()]))
        .await;
    let effect = f.effect("session").await;
    let names = f.preview(&effect, None).await;
    assert!(
        !names.as_array().unwrap().iter().any(|name| name == "Read"),
        "{names}"
    );
    f.change_source(|config| config.tools = Some(vec!["Read".into()]))
        .await;
    let effect = f.effect("session").await;
    assert_eq!(
        f.preview(&effect, None).await,
        json!([
            "DiscoveryComplete",
            "FinishNoChange",
            "Read",
            "RegisterWatch",
            "StageArtifact",
            "StagePendingAction",
            "UpsertDossier"
        ])
    );
    let task = f.create("Approved tool ceiling").await;

    // Ordinary Session gains Write again. The existing plan keeps its approved Read.
    f.change_source(|config| config.tools = None).await;
    f.change(&task, "pause").await;
    f.change(&task, "resume").await;
    f.change(&task, "trigger_now").await;
    let (mut socket, request) = next(&listener).await;
    let names = |request: &Value| {
        request["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["function"]["name"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    let original = names(&request);
    assert!(original.iter().any(|name| name == "Read"), "{original:?}");
    assert!(!original.iter().any(|name| name == "Write"), "{original:?}");
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"Restricted search"}),
    )
    .await;
    assert_eq!(
        f.settled(&task, 1).await["task"]["runs"][0]["outcome"],
        "ok"
    );

    assert_eq!(f.reapprove(&task, "session").await["kind"], "committed");
    f.change(&task, "trigger_now").await;
    let (mut socket, request) = next(&listener).await;
    let expanded = names(&request);
    assert!(!expanded.iter().any(|name| name == "Write"), "{expanded:?}");
    assert!(
        !expanded.iter().any(|name| name == "SendUser"),
        "{expanded:?}"
    );
    #[cfg(target_os = "macos")]
    let mut socket = {
        assert!(expanded.iter().any(|name| name == "Shell"), "{expanded:?}");
        tool(
            &mut socket,
            "Shell",
            json!({"command":"printf approved-shell && echo changed > discovery.txt","login":false}),
        )
        .await;
        let (socket, body) = next(&listener).await;
        let shell_result = output(&body).to_string();
        assert!(shell_result.contains("approved-shell"), "{shell_result}");
        assert_eq!(
            tokio::fs::read_to_string(f.rig.directory.path().join("workspace/discovery.txt"))
                .await
                .unwrap(),
            "Observed fixture evidence"
        );
        socket
    };
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"Updated scope"}),
    )
    .await;
    assert_eq!(
        f.settled(&task, 2).await["task"]["runs"][0]["outcome"],
        "ok"
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_memory_tool_searches_record_text_and_relationships() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Older useful record").await;
    f.change(&task, "trigger_now").await;
    let (mut socket, _) = next(&listener).await;
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"report","text":"Migration original-search-marker"}),
    )
    .await;
    f.settled(&task, 1).await;
    f.send("Look up the investigation history", json!([])).await;
    let (mut socket, _) = next(&listener).await;
    let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
    let record = page["records"][0]["id"].clone();
    let (mut socket, saved) = memory(
        &listener, &mut socket,
        json!({"action":"correct","record":record,"note":{"text":"He said \"stop\"\nCheck the next line"}})
    ).await;
    assert_eq!(saved["recorded"], true);
    let (mut socket, page) = memory(
        &listener,
        &mut socket,
        json!({"action":"list","query":"He said \"stop\"\nCheck","related":record}),
    )
    .await;
    assert_eq!(page["records"].as_array().unwrap().len(), 1);
    assert_eq!(page["records"][0]["sequence"], 2);
    assert_eq!(page["records"][0]["related"], record);
    assert_eq!(page["next_before"], Value::Null);
    let (mut socket, page) = memory(
        &listener,
        &mut socket,
        json!({"action":"list","query":"kind"}),
    )
    .await;
    assert_eq!(page["records"], json!([]));
    quiet(&f, &listener, &mut socket).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_model_proposals_require_bot_identity_and_human_approval() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let proposal = json!({"request":{"mode":"create","title":"Proposed discovery","intentBody":"Check authorized documents","effect":"discovery","schedule":{"kind":"interval","everySeconds":3600,"startAt":maka_agent_authority::now()+3_600_000},"timezone":"UTC"}});
    let created=f.query("create",json!({"title":"Ordinary proposer","automaticTitle":false,"labels":[],"tools":["ScheduledTask","DiscoveryComplete","DiscoveryMemory"],"workspace":{"kind":"directory","path":f.rig.directory.path().join("workspace")}})).await;
    let session = created["session"]["id"].as_str().unwrap();
    f.query("send",json!({"sessionId":session,"message":"Propose a discovery","backend":f.model,"delivery":"queue"})).await;
    let (mut socket, body) = next(&listener).await;
    assert!(
        body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|tool| !matches!(
                tool["function"]["name"].as_str(),
                Some("DiscoveryComplete" | "DiscoveryMemory")
            ))
    );
    tool(&mut socket, "ScheduledTask", proposal.clone()).await;
    let (mut socket, body) = next(&listener).await;
    assert!(
        output(&body).to_string().contains("discovery_requires_bot"),
        "{body}"
    );
    finish_text(&mut socket, "Cannot propose discovery here").await;
    f.quiescent(session).await;
    assert_eq!(
        f.query("schedules", json!({"kind":"discovery","sessionId":f.bot}))
            .await["tasks"],
        json!([])
    );
    f.send("Propose a discovery", json!([])).await;
    let (mut socket, _) = next(&listener).await;
    tool(&mut socket, "ScheduledTask", proposal).await;
    let (mut socket, _) = next(&listener).await;
    let page = f
        .query("schedules", json!({"kind":"discovery","sessionId":f.bot}))
        .await;
    let task = &page["tasks"][0];
    let id = task["id"].as_str().unwrap();
    assert_eq!(task["status"], "paused");
    assert_eq!(task["approved"], false);
    assert_eq!(
        f.detail(id).await["task"]["effect"]["workerTools"],
        "read_only"
    );
    assert!(task["backgroundFollowup"].is_null());
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

    f.send("Pause and then resume your discovery", json!([]))
        .await;
    let (mut socket, _) = next(&listener).await;
    for (mode, status) in [("pause", "paused"), ("resume", "active")] {
        let revision = f.detail(id).await["revision"].clone();
        tool(
            &mut socket,
            "ScheduledTask",
            json!({"request":{"mode":mode,"taskId":id,"revision":revision}}),
        )
        .await;
        let (reply, body) = next(&listener).await;
        assert_eq!(output(&body)["taskId"], id, "{body}");
        assert_eq!(f.detail(id).await["task"]["status"], status);
        socket = reply;
    }
    quiet(&f, &listener, &mut socket).await;

    f.change(id, "pause").await;
    f.reopen().await;
    f.send("Try to pause and resume the paused plan", json!([]))
        .await;
    let (mut socket, _) = next(&listener).await;
    tool(
        &mut socket,
        "ScheduledTask",
        json!({"request":{"mode":"pause","taskId":id,"revision":f.detail(id).await["revision"]}}),
    )
    .await;
    let (mut socket, body) = next(&listener).await;
    assert_eq!(output(&body)["taskId"], id, "{body}");
    tool(
        &mut socket,
        "ScheduledTask",
        json!({"request":{"mode":"resume","taskId":id,"revision":f.detail(id).await["revision"]}}),
    )
    .await;
    let (mut socket, body) = next(&listener).await;
    assert!(
        output(&body)
            .to_string()
            .contains("scheduler_user_resume_required"),
        "{body}"
    );
    assert_eq!(f.detail(id).await["task"]["status"], "paused");
    quiet(&f, &listener, &mut socket).await;

    f.change(id, "resume").await;
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
async fn discovery_schedules_the_next_check_from_the_finished_investigation() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let delay = 1_800_000;
    let task = f
        .create_scheduled(
            "Check after the previous run",
            "Look for a changed release date.",
            json!({
                "kind": "interval",
                "everySeconds": 1800,
                "startAt": maka_agent_authority::now() + delay,
                "cadence": "after_completion"
            }),
        )
        .await;
    f.change(&task, "trigger_now").await;
    let (mut worker, _) = next(&listener).await;
    tool(
        &mut worker,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"Finished the manual check"}),
    )
    .await;
    let done = f.settled(&task, 1).await;
    let next_at = done["task"]["runs"][0]["at"].as_u64().unwrap() + delay;
    assert_eq!(done["task"]["nextFireAt"], json!(next_at));

    f.reopen().await;
    assert_eq!(f.detail(&task).await["task"]["nextFireAt"], json!(next_at));
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_restart_settles_an_interrupted_original_run_without_replay() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Interrupted investigation").await;
    f.change(&task, "trigger_now").await;
    let (_socket, _) = next(&listener).await;
    let worker = f.active_worker();
    f.reopen().await;
    let original = f
        .owner()
        .durable
        .latest_run(worker.clone())
        .await
        .unwrap()
        .unwrap();
    // Restart resumes the interrupted original run after its frozen-retry delay;
    // wait for that recovered attempt before stopping so settlement cannot race it.
    let (_resumed, _) = next(&listener).await;
    assert_eq!(
        f.owner()
            .durable
            .runs(worker.clone(), None, 10)
            .await
            .unwrap(),
        vec![original]
    );
    f.query("stop", json!({"sessionId":worker,"runId":original}))
        .await;
    let done = f.settled(&task, 1).await;
    assert_eq!(done["task"]["runs"][0]["outcome"], "failed");
    assert_eq!(done["task"]["runs"][0]["sessionId"], worker);
    assert_eq!(done["task"]["runs"][0]["runId"], json!(original));
    assert_eq!(
        f.owner()
            .durable
            .runs(worker.clone(), None, 10)
            .await
            .unwrap(),
        vec![original]
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_startup_commits_stop_for_a_paused_worker_before_queue_recovery() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Paused while the Host was stopping").await;
    f.change(&task, "trigger_now").await;
    let (_socket, _) = next(&listener).await;
    let worker = f.active_worker();
    let owner = f.owner();
    let run = owner.durable.latest_run(worker).await.unwrap().unwrap();

    // Hold the scheduler at the persisted pause, before its next reconciliation.
    let producer = owner.producer_gate.lock().await;
    f.change(&task, "pause").await;
    let paused = owner.durable.frontier(run).await.unwrap();
    assert!(!paused.stopped && paused.terminal.is_none());

    owner.restore_discovery().await.unwrap();
    assert!(owner.durable.frontier(run).await.unwrap().stopped);
    drop(producer);

    let done = f.settled(&task, 1).await;
    assert_eq!(done["task"]["status"], "paused");
    assert_eq!(done["task"]["runs"][0]["outcome"], "blocked");
    assert_eq!(done["task"]["runs"][0]["runId"], json!(run));
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_desktop_lists_only_its_plans_and_tracks_the_original_worker() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Desktop plan").await;
    let schedule = f.detail(&task).await["task"]["schedule"].clone();
    let target = f.detail(&task).await["task"]["effect"]["target"].clone();
    let automation = f.query("schedule", json!({"kind":"create","input":{"task":{
        "title":"Unrelated automation","intentBody":"Other task","schedule":schedule,"effect":{"kind":"session","target":target,"model":f.model},"maxFires":null,"expiresAt":null},"timezone":"UTC","misfire":"latest"}})).await;
    assert_eq!(automation["kind"], "committed");
    let automation_page = f.query("schedules", json!({"kind":"list"})).await;
    assert_eq!(automation_page["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(automation_page["tasks"][0]["title"], "Unrelated automation");
    let page = f
        .query("schedules", json!({"kind":"discovery","sessionId":f.bot}))
        .await;
    assert_eq!(page["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(page["tasks"][0]["id"], task);
    let other = f
        .query(
            "create",
            json!({"title":"Other session","automaticTitle":false,"labels":[],
        "workspace":{"kind":"directory","path":f.rig.directory.path().join("workspace")}}),
        )
        .await;
    assert_eq!(
        f.query(
            "schedules",
            json!({"kind":"discovery","sessionId":other["session"]["id"]})
        )
        .await["tasks"],
        json!([])
    );
    f.change(&task, "trigger_now").await;
    let (mut socket, _) = next(&listener).await;
    let owner = f.owner();
    let mut updates = owner.schedule_changes();
    let active = tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            let active = f.detail(&task).await["investigation"].clone();
            if !active.is_null() {
                break active;
            }
            updates.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert_eq!(active["phase"], "investigating");
    assert_ne!(active["sessionId"], f.bot);
    assert!(!active["turnId"].as_str().unwrap().is_empty());
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"No material change"}),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(45), updates.changed())
        .await
        .unwrap()
        .unwrap();
    let done = f.settled(&task, 1).await;
    assert!(done["investigation"].is_null());
    assert_eq!(done["task"]["runs"][0]["sessionId"], active["sessionId"]);
    assert_eq!(
        f.query(
            "schedules",
            json!({"kind":"discovery","sessionId":f.bot,"expectedRevision":page["revision"]})
        )
        .await["kind"],
        "changed"
    );
    drop(owner);
    f.close().await;
}

async fn assert_bot_untouched(f: &Fixture) {
    let owner = f.owner();
    let queue = owner.durable.queue().read(f.bot.clone()).await.unwrap();
    assert_eq!(
        queue.revision, 0,
        "background activity wrote to the Bot queue"
    );
    assert!(
        owner
            .durable
            .latest_run(f.bot.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(f.outbox().await, json!([]));
}

async fn dossier_update(stream: &mut maka_host_runtime::application::host::LocalCall) -> Value {
    let reply = tokio::time::timeout(Duration::from_secs(45), stream.pull())
        .await
        .unwrap()
        .unwrap();
    let Reply::Item { value } = reply else {
        panic!("dossier subscription: {reply:?}")
    };
    value
}

async fn worker_upsert(
    listener: &TcpListener,
    mut socket: TcpStream,
    input: Value,
) -> (TcpStream, Value) {
    tool(&mut socket, "UpsertDossier", input).await;
    let (socket, request) = next(listener).await;
    (socket, output(&request))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_dossiers_commit_linked_once_edits_and_gate_interrupts() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let reminder = f
        .create_scheduled(
            "Signing reminder",
            "Old attachment deadline",
            json!({"kind":"once","runAt":maka_agent_authority::now()+3_600_000}),
        )
        .await;
    let task = f.create("Review evidence").await;
    let mut stream = f
        .rig
        .client
        .as_ref()
        .unwrap()
        .call(
            "agent",
            "watchDossiers".into(),
            json!({}),
            Attachments::new(),
        )
        .await
        .unwrap();
    stream.start().await.unwrap();
    assert!(matches!(stream.receive().await.unwrap(), Reply::Subscribed));
    assert_eq!(
        dossier_update(&mut stream).await,
        json!({"dossiers":[],"notificationsEnabled":true,"latestInterrupt":null})
    );
    f.change(&task, "trigger_now").await;
    let (worker, _) = next(&listener).await;
    let mut input = json!({"topic_id":"contract","expected_revision":0,"title":"Attachments","signal":"red","priority_weight":7.0,"summary_md":"The new annex supersedes the old deadline.","artifacts":[],"linked_task_ids":[reminder],"schedule_ops":[{"kind":"update","task_id":reminder,"intent_body":"Review the new annex"}],"notify_intent":{"kind":"interrupt","reason":"Signature due"}});
    let (worker, first) = worker_upsert(&listener, worker, input.clone()).await;
    assert_eq!(first["revision"], 1, "{first}");
    assert_eq!(first["notified"], true);
    let update = dossier_update(&mut stream).await;
    assert_eq!(update["latestInterrupt"]["reason"], "Signature due");
    assert_eq!(update["dossiers"][0]["topicId"], "contract");
    stream.cancel().await.unwrap();
    stream.close().await.unwrap();
    let revised = f.detail(&reminder).await;
    assert_eq!(revised["task"]["intent"]["body"], "Review the new annex");
    input["schedule_ops"] = json!([]);
    input["expected_revision"] = json!(1);
    let (worker, duplicate) = worker_upsert(&listener, worker, input.clone()).await;
    assert_eq!(duplicate["notified"], false, "{duplicate}");
    f.query("setDiscoveryNotifications", json!({"enabled":false}))
        .await;
    input["summary_md"] = json!("Confirmed against the signed copy");
    let (worker, global) = worker_upsert(&listener, worker, input.clone()).await;
    assert_eq!(
        (global["revision"].as_u64(), global["notified"].as_bool()),
        (Some(2), Some(false)),
        "{global}"
    );
    f.query(
        "setDossierMuted",
        json!({"topicId":"contract","muted":true}),
    )
    .await;
    f.query("setDiscoveryNotifications", json!({"enabled":true}))
        .await;
    input["expected_revision"] = json!(2);
    input["summary_md"] = json!("Concluded at review marker 8921");
    let (worker, muted) = worker_upsert(&listener, worker, input.clone()).await;
    assert_eq!(muted["notified"], false, "{muted}");
    input["expected_revision"] = json!(1);
    input["schedule_ops"] = json!([{"kind":"cancel","task_id":reminder}]);
    let (worker, conflict) = worker_upsert(&listener, worker, input.clone()).await;
    assert!(conflict.to_string().contains("revision"), "{conflict}");
    assert_eq!(
        f.detail(&reminder).await["task"]["intent"],
        revised["task"]["intent"]
    );
    input["expected_revision"] = json!(3);
    let (worker, cancelled) = worker_upsert(&listener, worker, input.clone()).await;
    assert_eq!(cancelled["revision"], 4, "{cancelled}");
    assert!(f.detail(&reminder).await.is_null());
    input["topic_id"] = json!("unrelated");
    input["expected_revision"] = json!(0);
    input["schedule_ops"] = json!([]);
    input["linked_task_ids"] = json!([]);
    input["summary_md"] = json!("Separate evidence");
    input["notify_intent"] = json!({"kind":"quiet"});
    let (mut worker, second) = worker_upsert(&listener, worker, input).await;
    assert_eq!(second["revision"], 1, "{second}");
    tool(
        &mut worker,
        "FinishNoChange",
        json!({"note":"Checked both sources","checked_topic_ids":["contract","unrelated"]}),
    )
    .await;
    assert_eq!(
        f.settled(&task, 1).await["task"]["runs"][0]["outcome"],
        "ok"
    );
    assert_bot_untouched(&f).await;
    let page = f.query("dossiers", json!({})).await;
    assert_eq!(page["notificationsEnabled"], true);
    assert_eq!(page["dossiers"].as_array().unwrap().len(), 2);
    let detail = f.query("dossier", json!({"topicId":"contract"})).await;
    assert_eq!(detail["lastNotifiedRevision"], 1);
    assert_eq!(detail["lastInterruptReason"], "Signature due");
    assert_eq!(detail["linkedTaskIds"], json!([]));
    assert!(
        detail["lastCheckedAt"].as_i64().unwrap()
            >= detail["lastMaterialChangeAt"].as_i64().unwrap()
    );
    f.send("What changed on the contract?", json!([])).await;
    let (mut bot, request) = next(&listener).await;
    assert!(!request["messages"].to_string().contains("8921"));
    assert!(model_tool_names(&request).contains(&"ListDossiers"));
    tool(&mut bot, "ListDossiers", json!({})).await;
    let (mut bot, list) = next(&listener).await;
    assert_eq!(output(&list).as_array().unwrap().len(), 2);
    assert!(!output(&list).to_string().contains("8921"));
    tool(&mut bot, "ReadDossier", json!({"topic_id":"contract"})).await;
    let (mut bot, read) = next(&listener).await;
    assert_eq!(output(&read)["summary_md"], detail["summaryMd"]);
    assert!(!output(&read).to_string().contains("Separate evidence"));
    quiet(&f, &listener, &mut bot).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_lead_opens_one_isolated_thread_with_its_initial_summary() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    f.send("Private Bot history marker 4719", json!([])).await;
    let (mut bot, _) = next(&listener).await;
    quiet(&f, &listener, &mut bot).await;
    let query = f
        .query(
            "dropDiscoveryLead",
            json!({"text":"Review specification marker 8142","paths":["docs/spec.md"]}),
        )
        .await;
    let original = f.query("dossier", query.clone()).await;
    assert!(original["threadSessionId"].is_null());
    assert!(original["priorityWeight"].as_f64().unwrap() > 0.);
    assert!(
        original["summaryMd"]
            .as_str()
            .unwrap()
            .contains("docs/spec.md")
    );
    let (a, b) = tokio::join!(
        f.query("openDossierThread", query.clone()),
        f.query("openDossierThread", query.clone())
    );
    assert_eq!(a, b);
    let session = a["sessionId"].as_str().unwrap();
    assert_ne!(session, f.bot);
    f.reopen().await;
    assert_eq!(f.query("openDossierThread", query.clone()).await, a);
    assert_eq!(f.query("dossier", query).await["threadSessionId"], session);
    f.query(
        "send",
        json!({"sessionId":session,"message":"What should I check?","backend":f.model}),
    )
    .await;
    let (mut thread, request) = next(&listener).await;
    let messages = request["messages"].to_string();
    assert!(
        messages.contains("8142") && messages.contains("docs/spec.md"),
        "{messages}"
    );
    assert!(!messages.contains("4719"), "{messages}");
    finish_text(&mut thread, "Check the referenced spec.").await;
    f.quiescent(session).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_stalled_worker_settles_quietly_and_releases_the_slot() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Review terms").await;
    f.change(&task, "trigger_now").await;
    let (mut worker, opening) = next(&listener).await;
    assert!(
        opening["messages"]
            .to_string()
            .contains("Deltas [kind,path,ms]")
    );
    for step in 1..=9 {
        let path = if step % 2 == 1 {
            "discovery.txt"
        } else {
            "./discovery.txt"
        };
        tool(&mut worker, "Read", json!({"path":path})).await;
        if step < 9 {
            let (socket, request) = next(&listener).await;
            worker = socket;
            let message = request["messages"].as_array().unwrap().last().unwrap();
            assert_eq!(message["role"], "tool");
            assert_eq!(
                message["content"]
                    .to_string()
                    .contains("Wrap up immediately"),
                step == 7,
                "{message}"
            );
        }
    }
    let result = f.settled(&task, 1).await;
    assert_eq!(result["task"]["runs"][0]["outcome"], "ok", "{result}");
    assert!(
        result["task"]["runs"][0]["message"]
            .as_str()
            .unwrap()
            .contains("repeated")
    );
    assert_bot_untouched(&f).await;
    f.change(&task, "trigger_now").await;
    let (mut worker, _) = next(&listener).await;
    tool(&mut worker, "FinishNoChange", json!({"note":"Done"})).await;
    f.settled(&task, 2).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_checkpoints_reach_the_worker_tool_result_and_skip_bot_chat() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let dir = f.rig.directory.path().join("workspace").join("evidence");
    tokio::fs::create_dir(&dir).await.unwrap();
    for n in 1..=35 {
        tokio::fs::write(dir.join(format!("{n}.txt")), format!("Verified source {n}"))
            .await
            .unwrap();
    }
    let task = f.create("Follow the evidence").await;
    f.change(&task, "trigger_now").await;
    let (mut worker, _) = next(&listener).await;
    for step in 1..=35 {
        tool(
            &mut worker,
            "Read",
            json!({"path":format!("evidence/{step}.txt")}),
        )
        .await;
        let (socket, request) = next(&listener).await;
        worker = socket;
        let msg = request["messages"].as_array().unwrap().last().unwrap();
        assert_eq!(msg["role"], "tool");
        assert!(
            msg["content"]
                .to_string()
                .contains(&format!("Verified source {step}"))
        );
        assert_eq!(
            msg["content"]
                .to_string()
                .contains(&format!("Checkpoint (step {step})")),
            matches!(step, 15 | 35),
            "{msg}"
        );
    }
    tool(
        &mut worker,
        "FinishNoChange",
        json!({"note":"Finished all topics"}),
    )
    .await;
    f.settled(&task, 1).await;
    f.send("Read the evidence", json!([])).await;
    let (mut bot, _) = next(&listener).await;
    for _ in 0..15 {
        tool(&mut bot, "Read", json!({"path":"discovery.txt"})).await;
        let (socket, request) = next(&listener).await;
        bot = socket;
        let content =
            request["messages"].as_array().unwrap().last().unwrap()["content"].to_string();
        assert!(
            !content.contains("Wrap up immediately") && !content.contains("Checkpoint (step"),
            "{content}"
        );
    }
    quiet(&f, &listener, &mut bot).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_file_drop_in_another_authorized_root_wakes_only_an_active_plan() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create_scheduled("Review new arrivals", "", json!({"kind":"interval","everySeconds":3600,"startAt":maka_agent_authority::now()+3_600_000})).await;
    let owner = f.owner();
    for _ in 0..3 {
        owner
            .store
            .data_writer()
            .unwrap()
            .write(owner.discovery.record_opening(
                maka_agent_state::discovery::changes::OpeningSources::FollowUp(vec![]),
                true,
                at(),
            ))
            .await
            .unwrap();
    }
    drop(owner);
    f.change(&task, "pause").await;
    tokio::fs::write(
        f.rig
            .directory
            .path()
            .join("other-workspace")
            .join("terms.pdf"),
        b"new terms",
    )
    .await
    .unwrap();
    let owner = f.owner();
    let state = &owner.discovery;
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut poll = tokio::time::interval(Duration::from_millis(100));
        loop {
            poll.tick().await;
            if state.has_ready_changes(at()).await.unwrap() {
                break;
            }
        }
    })
    .await
    .expect("watcher did not publish a debounced delta");
    let paused = f.detail(&task).await;
    assert!(
        paused["pendingFire"].is_null() && paused["task"]["runs"].as_array().unwrap().is_empty()
    );
    f.change(&task, "resume").await;
    let (mut worker, request) = next(&listener).await;
    let messages = request["messages"].to_string();
    assert!(
        messages.contains("terms.pdf") && messages.contains("created"),
        "{messages}"
    );
    tool(
        &mut worker,
        "FinishNoChange",
        json!({"note":"Reviewed the new file"}),
    )
    .await;
    assert_eq!(
        f.settled(&task, 1).await["task"]["runs"][0]["outcome"],
        "ok"
    );
    assert!(!state.has_ready_changes(at()).await.unwrap());
    assert_eq!(state.broad_cycle().await.unwrap(), 3);
    assert_bot_untouched(&f).await;
    drop(owner);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_code_mode_counts_new_files_read_inside_cells() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f=Fixture::with_tools(&listener,&[json!({
        "name":"ReadPart","description":"Read a source file.","nestable":true,
        "input":"json","result":"image","confirmation":"preapproved","target":{"kind":"import","name":"files"},"method":"read"
    })]).await;
    f.update_model_connection(ConnectionCatalogEntryUpdate {
        model_overrides: serde_json::from_value(
            json!({"llama3.2":{"codeMode":true,"apiProtocol":"openai-chat-completions"}}),
        )
        .unwrap(),
        ..Default::default()
    })
    .await;
    let dir = f.rig.directory.path().join("workspace");
    for n in 0..9 {
        tokio::fs::write(dir.join(format!("part-{n}")), "same text")
            .await
            .unwrap();
    }
    let task = f.create("Check each part").await;
    f.change(&task, "trigger_now").await;
    let (mut worker, _) = next(&listener).await;
    for n in 0..9 {
        tool(&mut worker,"exec",json!({"code":format!("const page = await tools.ReadPart({{path:'part-{n}'}}); text(page.value.content);"),"yield_time_ms":30000})).await;
        let (socket, request) = next(&listener).await;
        worker = socket;
        let last = output(&request).to_string();
        assert!(
            last.contains("same text") && !last.contains("Wrap up immediately"),
            "{last}"
        );
    }
    tool(
        &mut worker,
        "FinishNoChange",
        json!({"note":"Checked each part"}),
    )
    .await;
    assert_eq!(
        f.settled(&task, 1).await["task"]["runs"][0]["outcome"],
        "ok"
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_staged_receipt_attaches_verbatim_and_preview_checks_the_dossier_and_bytes() {
    use sha2::{Digest, Sha256};
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Prepare a draft").await;
    f.change(&task, "trigger_now").await;
    let (mut worker, request) = next(&listener).await;
    assert!(!model_tool_names(&request).contains(&"UpdateDiscoveryPreferences"));
    let input = json!({"topic_id":"terms","relative_path":"notes/annex.diff","content":"+ 合同\n","purpose":"Review the clause","input_paths":["discovery.txt","missing.txt"]});
    let mut outside = input.clone();
    outside["input_paths"] = json!(["../other-workspace/terms"]);
    tool(&mut worker, "StageArtifact", outside).await;
    let (mut worker, rejected) = next(&listener).await;
    assert!(
        output(&rejected)
            .to_string()
            .contains("outside authorized workspace"),
        "{rejected}"
    );
    tool(&mut worker, "StageArtifact", input).await;
    let (worker, staged) = next(&listener).await;
    let artifact = output(&staged);
    assert_eq!(artifact["sha256"], hex::encode(Sha256::digest("+ 合同\n")));
    assert_eq!(
        artifact["input_hashes"],
        json!({"discovery.txt":hex::encode(Sha256::digest("Observed fixture evidence"))})
    );
    let query = json!({"topicId":"terms","path":"notes/annex.diff"});
    let client = f.rig.client.as_ref().unwrap();
    assert!(
        call(client, "agent", "readDossierArtifact", query.clone())
            .await
            .is_err()
    );
    let (mut worker, committed) = worker_upsert(&listener, worker, json!({
        "topic_id":"terms","expected_revision":0,"title":"Terms","signal":"yellow","priority_weight":3.0,
        "summary_md":"Check the draft","artifacts":[artifact],"notify_intent":{"kind":"quiet"}
    })).await;
    assert_eq!(committed["revision"], 1, "{committed}");
    assert_eq!(
        f.query("readDossierArtifact", query.clone()).await,
        "+ 合同\n"
    );
    for bad in [
        json!({"topicId":"other","path":"notes/annex.diff"}),
        json!({"topicId":"terms","path":"draft.md"}),
        json!({"topicId":"terms","path":"../terms/notes/annex.diff"}),
        json!({"topicId":"../terms","path":"notes/annex.diff"}),
    ] {
        assert!(
            call(client, "agent", "readDossierArtifact", bad)
                .await
                .is_err()
        );
    }
    let state = f.owner().store.owned_root().unwrap();
    let path = state
        .canonical_path()
        .join("discovery/staging/terms/notes/annex.diff");
    tokio::fs::write(&path, "unattached revision")
        .await
        .unwrap();
    assert!(
        call(client, "agent", "readDossierArtifact", query.clone())
            .await
            .unwrap_err()
            .to_string()
            .contains("changed")
    );
    #[cfg(unix)]
    {
        let outside = f.rig.directory.path().join("other-workspace/original.txt");
        tokio::fs::write(&outside, "+ 合同\n").await.unwrap();
        tokio::fs::remove_file(&path).await.unwrap();
        tokio::fs::symlink(&outside, &path).await.unwrap();
        assert!(
            call(client, "agent", "readDossierArtifact", query)
                .await
                .is_err()
        );
    }
    tool(
        &mut worker,
        "FinishNoChange",
        json!({"note":"Draft attached"}),
    )
    .await;
    f.settled(&task, 1).await;
    drop(state);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_wander_starts_blind_rotates_sources_and_learns_only_in_followups() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let query = f
        .query(
            "dropDiscoveryLead",
            json!({"text":"Existing dossier marker 3819"}),
        )
        .await;
    let topic = query["topicId"].as_str().unwrap();
    let session = f.query("openDossierThread", query.clone()).await["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    f.query(
        "send",
        json!({"sessionId":session,"message":"周五再提醒","backend":f.model}),
    )
    .await;
    let (mut thread, req) = next(&listener).await;
    assert!(req["messages"].to_string().contains(topic));
    tool(
        &mut thread,
        "UpdateDiscoveryPreferences",
        json!({"mode":"append","rule":"周五再提醒"}),
    )
    .await;
    let (mut thread, req) = next(&listener).await;
    assert_eq!(output(&req)["updated"], true, "{}", output(&req));
    let mut draft = json!({"topic_id":"other-topic","relative_path":"draft.md","content":"Dossier draft","purpose":"For review"});
    tool(&mut thread, "StageArtifact", draft.clone()).await;
    let (mut thread, req) = next(&listener).await;
    assert!(output(&req).to_string().contains("discovery_wrong_topic"));
    draft["topic_id"] = json!(topic);
    tool(&mut thread, "StageArtifact", draft).await;
    let (mut thread, req) = next(&listener).await;
    assert_eq!(output(&req)["path"], "draft.md");
    finish_text(&mut thread, "Saved.").await;
    f.quiescent(&session).await;
    assert_eq!(
        f.query(
            "readDossierArtifact",
            json!({"topicId":topic,"path":"draft.md"})
        )
        .await,
        "Dossier draft"
    );
    f.query("setDossierMuted", json!({"topicId":topic,"muted":true}))
        .await;

    f.send("Save my discovery preference", json!([])).await;
    let (mut bot, req) = next(&listener).await;
    let system = |r: &Value| {
        r["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "system")
            .cloned()
            .collect::<Vec<_>>()
    };
    let prefix = system(&req);
    assert!(!model_tool_names(&req).contains(&"StageArtifact"));
    tool(
        &mut bot,
        "UpdateDiscoveryPreferences",
        json!({"mode":"replace","rule":"Skip subtitle tracking"}),
    )
    .await;
    let (mut bot, req) = next(&listener).await;
    assert_eq!(output(&req)["updated"], true, "{}", output(&req));
    quiet(&f, &listener, &mut bot).await;
    for n in 0..6 {
        tokio::fs::create_dir(f.rig.directory.path().join(format!("workspace/cold-{n}")))
            .await
            .unwrap();
    }
    let schedule = json!({"kind":"interval","everySeconds":3600,"startAt":maka_agent_authority::now()+3_600_000});
    let broad = f
        .create_scheduled("Broad discovery", "", schedule.clone())
        .await;
    let directed = f
        .create_scheduled("Focused", "Check contract", schedule)
        .await;
    for n in 1..=8 {
        if n == 4 {
            f.reopen().await;
            f.change(&directed, "trigger_now").await;
            let (mut focused, req) = next(&listener).await;
            assert!(
                req["messages"]
                    .to_string()
                    .contains("Existing dossier marker")
            );
            tool(&mut focused, "FinishNoChange", json!({"note":"Checked"})).await;
            f.settled(&directed, 1).await;
        }
        f.change(&broad, "trigger_now").await;
        let (mut worker, req) = next(&listener).await;
        let opening = req["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["role"] == "user")
            .unwrap()["content"]
            .as_str()
            .unwrap();
        if n % 4 == 0 {
            assert!(
                opening.contains("Cold starting points")
                    && opening.contains("ListDossiers only just before"),
                "{opening}"
            );
            assert!(
                !opening.contains(topic)
                    && !opening.contains("Existing dossier marker")
                    && !opening.contains("last_investigation")
                    && !opening.contains("Skip subtitle tracking"),
                "{opening}"
            );
            let cold: Vec<String> =
                serde_json::from_str(opening.lines().find(|l| l.starts_with('[')).unwrap())
                    .unwrap();
            let start = if n == 4 { 0 } else { 3 };
            assert_eq!(
                cold,
                (start..start + 3)
                    .map(|i| format!("cold-{i}"))
                    .collect::<Vec<_>>()
            );
            let finding = json!({"topic_id":"cold-brief","title":"Cold brief","signal":"yellow","priority_weight":1.0,
                "summary_md":"Cross-checked the cold brief","expected_revision":0,"notify_intent":{"kind":"quiet"}});
            if n == 4 {
                let (socket, refused) = worker_upsert(&listener, worker, finding.clone()).await;
                assert!(
                    refused
                        .to_string()
                        .contains("Call ListDossiers before committing")
                );
                worker = socket;
            }
            tool(&mut worker, "ListDossiers", json!({})).await;
            let (socket, list) = next(&listener).await;
            assert!(output(&list).to_string().contains(topic));
            worker = socket;
            if n == 4 {
                let (socket, saved) = worker_upsert(&listener, worker, finding).await;
                assert_eq!(saved["revision"], 1, "{saved}");
                worker = socket;
            }
        } else {
            for expected in [
                topic,
                "Existing dossier marker",
                "周五再提醒",
                "Skip subtitle tracking",
                "replied in the dossier thread",
                "opened a staged artifact",
                "muted the topic",
            ] {
                assert!(opening.contains(expected), "{expected}: {opening}");
            }
        }
        tool(
            &mut worker,
            "FinishNoChange",
            json!({"note":"No material change"}),
        )
        .await;
        f.settled(&broad, n).await;
    }
    f.send("Hello again", json!([])).await;
    let (mut bot, req) = next(&listener).await;
    assert_eq!(prefix, system(&req));
    quiet(&f, &listener, &mut bot).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upsert_then_legacy_discovery_complete_skips_duplicate_task_dossier() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let task = f.create("Review evidence").await;
    f.change(&task, "trigger_now").await;
    let (worker, _) = next(&listener).await;
    let (mut worker, saved) = worker_upsert(
        &listener,
        worker,
        json!({
            "topic_id": "contract",
            "expected_revision": 0,
            "title": "Contract compliance",
            "signal": "red",
            "priority_weight": 9.0,
            "summary_md": "Ready for one-click decision.",
            "artifacts": [],
            "notify_intent": {"kind": "interrupt", "reason": "Action needed"}
        }),
    )
    .await;
    assert_eq!(saved["revision"], 1, "{saved}");
    tool(
        &mut worker,
        "DiscoveryComplete",
        json!({"kind": "report", "text": "Duplicate legacy summary"}),
    )
    .await;
    let detail = f.settled(&task, 1).await;
    let run = &detail["task"]["runs"][0];
    assert_eq!(run["outcome"], "ok");
    assert_eq!(run["message"], "Dossiers updated");
    let list = f.query("dossiers", json!({})).await;
    let ids: Vec<&str> = list["dossiers"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|d| d["topicId"].as_str())
        .collect();
    assert_eq!(
        ids,
        vec!["contract"],
        "legacy DiscoveryComplete must not create a duplicate task dossier: {list}"
    );
    f.close().await;
}

mod guards;
