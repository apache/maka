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
use maka_agent_api::{contract::WorkspaceAccess, session::StoredSessionConfiguration};
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
    async fn exclusions(&self) -> Value {
        let result = self
            .query(
                "schedules",
                json!({"kind":"discovery_exclusions","sessionId":self.bot}),
            )
            .await;
        assert_eq!(result["kind"], "discovery_exclusions", "{result}");
        result["exclusions"].clone()
    }
    async fn change_exclusions(&self, revision: Value, entries: Value) -> Value {
        self.query(
            "changeDiscoveryExclusions",
            json!({"sessionId":self.bot,"revision":revision,"entries":entries}),
        )
        .await
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
    let (mut socket, _) = next(&listener).await;
    let observation =
        json!({"text":"Evidence remains useful after notification.","references":["source.md"]});
    tool(
        &mut socket,
        "DiscoveryComplete",
        json!({"kind":"report","text":"A useful finding","notes":[observation]}),
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
async fn discovery_standard_tools_pin_the_displayed_list_until_reapproved() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    f.change_source(|config| config.tools = Some(vec!["Read".into()]))
        .await;
    let effect = f.effect("session").await;
    assert_eq!(f.preview(&effect, None).await, json!(["Read"]));
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
    assert!(expanded.iter().any(|name| name == "Write"), "{expanded:?}");
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
            json!({"command":"printf approved-shell","login":false}),
        )
        .await;
        let (socket, body) = next(&listener).await;
        let shell_result = output(&body).to_string();
        assert!(shell_result.contains("approved-shell"), "{shell_result}");
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
async fn discovery_applies_group_scope_and_global_file_exclusions_to_live_tools() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    f.change_source(|config| config.permissions.access = WorkspaceAccess::WorkspaceWrite)
        .await;
    let workspace = f
        .rig
        .directory
        .path()
        .join("workspace")
        .canonicalize()
        .unwrap();
    std::fs::create_dir(workspace.join("private")).unwrap();
    let protected = [
        ("private/note.txt", "excluded-folder-content"),
        ("settings.conf", "excluded-file-content"),
        ("token.PEM", "excluded-suffix-content"),
    ];
    for (path, sentinel) in protected {
        std::fs::write(workspace.join(path), sentinel).unwrap();
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(workspace.join("settings.conf"), workspace.join("alias.txt"))
        .unwrap();

    let mut effect = f.effect("read_only").await;
    effect["workerTools"] = json!({"custom":{
        "readFiles":true,"readHistory":false,"modifyFiles":false,
        "runCommands":true,"network":false,"manageSessions":false,
        "extensions":false,"desktop":false
    }});
    let task = f.create_effect(
        "Local discovery scope", "Check local files",
        json!({"kind":"interval","everySeconds":3600,"startAt":maka_agent_authority::now()+3_600_000}),
        effect.clone(),
    ).await;
    assert_eq!(f.exclusions().await, json!({"entries":[],"revision":null}));
    let entries = json!([
        {"kind":"directory","path":workspace.join("private")},
        {"kind":"file","path":workspace.join("settings.conf")},
        {"kind":"suffix","suffix":"PEM"}
    ]);
    let saved = f.change_exclusions(Value::Null, entries).await;
    assert_eq!(saved["kind"], "committed", "{saved}");
    assert_eq!(saved["exclusions"]["entries"][2]["suffix"], ".pem");
    assert_eq!(
        f.change_exclusions(Value::Null, json!([])).await["kind"],
        "conflict"
    );
    f.reopen().await;
    assert_eq!(f.exclusions().await, saved["exclusions"]);
    assert_eq!(f.detail(&task).await["approved"], true);

    f.change(&task, "trigger_now").await;
    let (mut model, request) = next(&listener).await;
    let names: Vec<_> = request["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["function"]["name"].as_str())
        .collect();
    assert!(
        names.contains(&"Read") && names.contains(&"DiscoveryComplete"),
        "{names:?}"
    );
    for name in [
        "Write",
        "DiscoveryMemory",
        "SessionRead",
        "Recall",
        "ScheduledTask",
    ] {
        assert!(!names.contains(&name), "{name}: {names:?}");
    }
    assert_eq!(names.contains(&"Shell"), cfg!(target_os = "macos"));
    let changed = f
        .change_exclusions(saved["exclusions"]["revision"].clone(), json!([]))
        .await;
    assert_eq!(changed["kind"], "investigation_running", "{changed}");
    assert_eq!(f.exclusions().await, saved["exclusions"]);

    tool(&mut model, "Read", json!({"path":"discovery.txt"})).await;
    let (mut model, body) = next(&listener).await;
    assert!(
        output(&body)
            .to_string()
            .contains("Observed fixture evidence")
    );
    for (path, sentinel) in protected {
        tool(&mut model, "Read", json!({"path":path})).await;
        let (following, body) = next(&listener).await;
        let result = output(&body).to_string();
        assert!(!result.contains(sentinel), "{path}: {result}");
        assert!(result.to_lowercase().contains("deni"), "{path}: {result}");
        model = following;
    }
    #[cfg(unix)]
    {
        tool(&mut model, "Read", json!({"path":"alias.txt"})).await;
        let (following, body) = next(&listener).await;
        let result = output(&body).to_string();
        assert!(
            result.to_lowercase().contains("deni") && !result.contains("excluded-file-content"),
            "{result}"
        );
        model = following;
    }
    tool(
        &mut model,
        "Read",
        json!({"path":format!("maka://session/{}",f.bot)}),
    )
    .await;
    let (mut model, body) = next(&listener).await;
    assert!(
        output(&body)
            .to_string()
            .contains("Discovery history access is disabled"),
        "{body}"
    );
    #[cfg(target_os = "macos")]
    let mut model = {
        tool(&mut model, "Shell", json!({
            "command":"cat discovery.txt; cat private/note.txt settings.conf token.PEM; echo forbidden > write-test.txt",
            "login": false
        })).await;
        let (model, body) = next(&listener).await;
        let result = output(&body).to_string();
        assert!(result.contains("Observed fixture evidence"), "{result}");
        assert!(!result.contains("excluded-"), "{result}");
        assert!(!workspace.join("write-test.txt").exists(), "{result}");
        model
    };
    tool(
        &mut model,
        "DiscoveryComplete",
        json!({"kind":"no_report","note":"Verified scope"}),
    )
    .await;
    assert_eq!(
        f.settled(&task, 1).await["task"]["runs"][0]["outcome"],
        "ok"
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_memory_search_paginates_and_matches_record_text() {
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
    let (mut socket, _) = next(&listener).await;
    let (mut socket, page) = memory(&listener, &mut socket, json!({"action":"list"})).await;
    let record = page["records"][0]["id"].clone();
    for index in 0..38 {
        let text = if index == 37 {
            "Migration observation: He said \"stop\"\nCheck the next line".into()
        } else if index < 4 {
            format!("Migration observation {index}")
        } else {
            format!("Unrelated observation {index}")
        };
        let (next_socket, saved) = memory(
            &listener,
            &mut socket,
            json!({"action":"correct","record":record,"note":{"text":text}}),
        )
        .await;
        assert_eq!(saved["recorded"], true, "{saved}");
        socket = next_socket;
    }
    let sequences = |page: &Value| {
        page["records"]
            .as_array()
            .unwrap()
            .iter()
            .map(|record| record["sequence"].as_u64().unwrap())
            .collect::<Vec<_>>()
    };
    let (mut socket, first) = memory(
        &listener,
        &mut socket,
        json!({"action":"list","query":"migration"}),
    )
    .await;
    assert_eq!(sequences(&first), [39]);
    assert_eq!(first["next_before"], 8);
    let (mut socket, second) = memory(
        &listener,
        &mut socket,
        json!({"action":"list","query":"migration","before":first["next_before"]}),
    )
    .await;
    assert_eq!(sequences(&second), [5, 4, 3, 2]);
    let (mut socket, third) = memory(
        &listener,
        &mut socket,
        json!({"action":"list","query":"migration","before":second["next_before"]}),
    )
    .await;
    assert_eq!(sequences(&third), [1]);
    assert_eq!(third["next_before"], Value::Null);

    let (mut socket, page) = memory(
        &listener,
        &mut socket,
        json!({"action":"list","query":"original-search-marker"}),
    )
    .await;
    assert!(sequences(&page).is_empty());
    assert_eq!(page["next_before"], 8);
    let (mut socket, page) = memory(
        &listener,
        &mut socket,
        json!({"action":"list","query":"original-search-marker","before":page["next_before"]}),
    )
    .await;
    assert_eq!(sequences(&page), [1]);
    assert_eq!(page["records"][0]["id"], record);
    assert_eq!(page["next_before"], Value::Null);
    let (mut socket, page) = memory(
        &listener,
        &mut socket,
        json!({"action":"list","query":"He said \"stop\"\nCheck"}),
    )
    .await;
    assert_eq!(sequences(&page), [39]);
    let (mut socket, page) = memory(
        &listener,
        &mut socket,
        json!({"action":"list","query":"kind"}),
    )
    .await;
    assert!(sequences(&page).is_empty());
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

async fn report_to_bot(f: &Fixture, listener: &TcpListener, task: &str) -> TcpStream {
    f.change(task, "trigger_now").await;
    let (mut worker, _) = next(listener).await;
    tool(
        &mut worker,
        "DiscoveryComplete",
        json!({"kind":"report","text":"Check the release date again after the update."}),
    )
    .await;
    let (bot, _) = next(listener).await;
    bot
}

async fn propose_followup(
    listener: &TcpListener,
    bot: &mut TcpStream,
    title: &str,
    schedule: Value,
    worker_tools: Option<&str>,
) -> (TcpStream, Value) {
    let mut request = json!({"mode":"create","title":title,"intentBody":"Check the updated release date","effect":"discovery","schedule":schedule,"timezone":"UTC"});
    if let Some(worker_tools) = worker_tools {
        request["workerTools"] = json!(worker_tools);
    }
    tool(bot, "ScheduledTask", json!({ "request": request })).await;
    let (socket, request) = next(listener).await;
    (socket, output(&request))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_report_authorizes_one_time_followup_but_not_a_recurring_or_chained_plan() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut f = Fixture::new(&listener).await;
    let parent = f
        .create_with_worker_tools(
            "Approved release watch",
            "Check the release date",
            json!({"kind":"interval","everySeconds":3600,"startAt":maka_agent_authority::now()+3_600_000}),
            Some("read_only"),
        )
        .await;
    let mut bot = report_to_bot(&f, &listener, &parent).await;
    let at = maka_agent_authority::now() + 3_600_000;
    let once = json!({"kind":"once","runAt":at});
    let (mut bot, recurring) = propose_followup(
        &listener,
        &mut bot,
        "New recurring watch",
        json!({"kind":"interval","everySeconds":3600,"startAt":at}),
        None,
    )
    .await;
    assert_eq!(recurring["approved"], false, "{recurring}");
    let (mut bot, wider) = propose_followup(
        &listener,
        &mut bot,
        "Follow-up requesting Session tools",
        once.clone(),
        Some("session"),
    )
    .await;
    assert_eq!(wider["approved"], false, "{wider}");
    let waiting = f.detail(wider["taskId"].as_str().unwrap()).await;
    assert_eq!(waiting["task"]["status"], "paused");
    assert_eq!(waiting["task"]["effect"]["workerTools"], "session");

    let (mut bot, result) = propose_followup(
        &listener,
        &mut bot,
        "One-time follow-up",
        once.clone(),
        None,
    )
    .await;
    assert_eq!(result["approved"], true, "{result}");
    let followup = result["taskId"].as_str().unwrap();
    let detail = f.detail(followup).await;
    assert_eq!(detail["task"]["status"], "active");
    assert_eq!(
        detail["task"]["effect"],
        f.detail(&parent).await["task"]["effect"]
    );
    let page = f
        .query("schedules", json!({"kind":"discovery","sessionId":f.bot}))
        .await;
    let background = page["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|task| task["backgroundFollowup"] == true)
        .map(|task| &task["id"])
        .collect::<Vec<_>>();
    assert_eq!(background, vec![&result["taskId"]]);
    quiet(&f, &listener, &mut bot).await;

    let saved = f
        .change_exclusions(Value::Null, json!([{"kind":"suffix","suffix":".txt"}]))
        .await;
    assert_eq!(saved["kind"], "committed", "{saved}");
    f.change(followup, "trigger_now").await;
    let (mut worker, _) = next(&listener).await;
    tool(&mut worker, "Read", json!({"path":"discovery.txt"})).await;
    let (mut worker, body) = next(&listener).await;
    assert!(
        output(&body).to_string().to_lowercase().contains("deni"),
        "{body}"
    );
    tool(
        &mut worker,
        "DiscoveryComplete",
        json!({"kind":"report","text":"Release status checked"}),
    )
    .await;
    let (mut bot, _) = next(&listener).await;
    let (mut bot, chained) =
        propose_followup(&listener, &mut bot, "Chained follow-up", once, None).await;
    assert_eq!(chained["approved"], false, "{chained}");
    quiet(&f, &listener, &mut bot).await;
    assert_eq!(
        f.settled(followup, 1).await["task"]["runs"][0]["outcome"],
        "ok"
    );
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
    let worker = f
        .owner()
        .scheduler
        .investigation
        .read()
        .unwrap()
        .as_ref()
        .unwrap()
        .worker
        .clone();
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
