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
use maka_agent_facts::configuration::ConnectionCatalogEntryUpdate;
use maka_agent_facts::execution::SandboxMode;
struct Fixture {
    rig: Rig,
    boot: Boot,
    bot: String,
    model: Value,
}
impl Fixture {
    async fn new(server: &MockAiServer) -> Self {
        Self::with_tools(server, &[]).await
    }
    async fn with_tools(server: &MockAiServer, extra: &[Value]) -> Self {
        Self::configured(server, extra, "", |_| {}).await
    }
    async fn configured(
        server: &MockAiServer,
        extra: &[Value],
        subdirectory: &str,
        configure: impl FnOnce(&mut Value),
    ) -> Self {
        let mut rig = Rig::new().unwrap();
        let base = rig.directory.path().to_path_buf();
        let workspace = base.join("workspace").join(subdirectory);
        let boot = bootstrap_with(&base, server.base_url(), |config| {
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
            configure(config);
        })
        .await
        .unwrap();
        std::fs::create_dir_all(base.join("other-workspace")).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("discovery.txt"), "Observed fixture evidence").unwrap();
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
                "workspace":{"kind":"directory","path":workspace}
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
    async fn worker_count(&self) -> usize {
        self.owner()
            .store
            .list_sessions::<StoredSessionConfiguration>(None, None, 64)
            .await
            .unwrap()
            .sessions
            .iter()
            .filter(|s| s.configuration.discovery_worker)
            .count()
    }

    async fn active_token_budget(&self) -> Option<u64> {
        self.owner()
            .latest_session_run(&self.active_worker())
            .await
            .unwrap()
            .unwrap()
            .spec
            .budget
            .tokens
    }

    /// Replay a saved approval from before workers could write individual dossiers.
    async fn use_legacy_report_grant(&self, task: &str) {
        let owner = self.owner();
        let _gate = owner.scheduler.gate.lock().await;
        let mut catalog = owner.scheduler.load().await.unwrap();
        let mut plan = catalog.plans[task].plan.clone();
        let Some(crate::owner::scheduler::Approval::Discovery { tools, .. }) =
            &mut plan.authorization
        else {
            panic!("expected discovery approval");
        };
        tools
            .names
            .retain(|name| !crate::owner::discovery::WORKER_TOOLS.contains(&name.as_str()));
        tools.names.push("DiscoveryComplete".into());
        tools.names.sort();
        owner
            .scheduler
            .commit(&mut catalog, task, Some(plan), None)
            .await
            .unwrap();
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
                        ) || (matches!(name, "UpdateWatchScope" | "UpdateWorkspaceMap")
                            && chosen.values().any(|group| group == "read_files"))
                            || chosen.contains_key(name)
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
    async fn conversation(&self, kind: &str, title: &str) -> String {
        let response = self.query("create", json!({
            "kind":kind,"title":title,"labels":[],
            "workspace":{"kind":"directory","path":self.rig.directory.path().join("workspace")}
        })).await;
        response["session"]["id"].as_str().unwrap().to_owned()
    }
    async fn outbox(&self) -> Value {
        self.query("botOutbox", json!({})).await["messages"].clone()
    }
    async fn quiet_room(&self, title: &str) -> (String, UnixMillis) {
        let room = self.conversation("room", title).await;
        let posted = UnixMillis(at().0 - 300_000);
        let owner = self.owner();
        owner
            .store
            .data_writer()
            .unwrap()
            .write(owner.durable.rooms(owner.run_owner()).post_statement(
                maka_agent_state::room::Post {
                    session: room.clone(),
                    id: "room-note".into(),
                    at: posted,
                    author: maka_agent_facts::room::RoomAuthor::Human,
                    content: "Review the terms".into(),
                    reply_to: None,
                    mentions: vec![],
                    deliveries: vec![],
                },
            ))
            .await
            .unwrap();
        (room, posted)
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
    async fn change_model_endpoint(&self, server: &MockAiServer) {
        self.update_model_connection(ConnectionCatalogEntryUpdate {
            configuration: Some(json!({
                "baseUrl":server.base_url()
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
async fn next(server: &mut MockAiServer) -> (TurnHandle, Value) {
    let mut turn = tokio::time::timeout(Duration::from_secs(45), server.next_turn())
        .await
        .unwrap()
        .expect("model request missing");
    let body = std::mem::take(&mut turn.request.raw_body);
    (turn, body)
}
fn tool(turn: TurnHandle, name: &str, input: Value) {
    turn.send_plan(
        TurnPlan::new()
            .push_tool_call(format!("call_{}", Uuid::new_v4()), name, input)
            .with_usage(Usage::new(100, 10))
            .finish(FinishReason::ToolCalls),
    );
}
fn finish_with_usage(turn: TurnHandle, usage: Usage) {
    turn.send_plan(
        TurnPlan::new()
            .push_tool_call("finish", "FinishNoChange", json!({"note":"Reviewed"}))
            .with_usage(usage)
            .finish(FinishReason::ToolCalls),
    );
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
async fn memory(server: &mut MockAiServer, turn: TurnHandle, input: Value) -> (TurnHandle, Value) {
    tool(turn, "DiscoveryMemory", input);
    let (s, b) = next(server).await;
    (s, output(&b))
}
async fn quiet(f: &Fixture, server: &mut MockAiServer, turn: TurnHandle) {
    turn.reply_text("Investigation received.");
    tokio::time::timeout(Duration::from_secs(45), f.quiescent(&f.bot))
        .await
        .expect("Bot Run did not settle before Host teardown");
    assert!(
        tokio::time::timeout(Duration::from_millis(100), server.next_turn())
            .await
            .is_err()
    );
}

fn session_read_tool() -> Value {
    json!({"name":"SessionRead","description":"Read a conversation or Room.","input":"json","result":"json",
        "confirmation":"preapproved","target":{"kind":"export","name":"agent"},"method":"sessionRead"})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_schedule_reads_idle_chats_rooms_and_only_human_bot_turns() {
    use maka_agent_facts::message::MessageOrigin;
    let mut server = MockAiBuilder::new().interactive(24).start().await.unwrap();
    let mut f = Fixture::with_tools(&server, &[session_read_tool()]).await;
    let owner = f.owner();
    let chat = f.conversation("agent", "Release decisions").await;
    let room = f.conversation("room", "Release room").await;
    f.query(
        "send",
        json!({"sessionId":chat,"message":"Chat evidence 132","backend":f.model}),
    )
    .await;
    next(&mut server).await.0.reply_text("Recorded.");
    f.quiescent(&chat).await;
    f.query(
        "send",
        json!({"sessionId":room,"message":"Room evidence 243"}),
    )
    .await;
    f.send("Human Bot evidence 354", json!([])).await;
    let (bot_turn, _) = next(&mut server).await;
    let user_run = owner.latest_session_run(&f.bot).await.unwrap().unwrap();
    let source = ExecutionIdentity {
        session_id: f.bot.clone(),
        run_id: user_run.run,
        turn_id: user_run.spec.turn_id,
    };
    let route = owner.return_route(&source).await.unwrap();
    bot_turn.reply_text("Recorded.");
    f.quiescent(&f.bot).await;
    let mut effect = f.effect("read_only").await;
    effect["selectedTools"] = json!({"SessionRead":"history"});
    let start = at().0 + 60_000;
    let task = f
        .create_effect(
            "Session changes",
            "",
            json!({
                "kind":"interval","everySeconds":1800,"startAt":start,"cadence":"after_completion"
            }),
            effect,
        )
        .await;
    owner.tick_schedules_at(start).await.unwrap();
    let idle = owner.discovery.plan_activity(&task).await.unwrap();
    assert_eq!(
        (idle.skipped, idle.tokens, f.worker_count().await),
        (1, 0, 0)
    );

    let due = f.detail(&task).await["task"]["nextFireAt"]
        .as_i64()
        .unwrap();
    owner.tick_schedules_at(due).await.unwrap();
    let (mut worker, request) = next(&mut server).await;
    let opening = request["messages"].to_string();
    assert!(
        opening.contains("Sessions [kind,session_id,title,ms]")
            && opening.contains("Check only the named topic"),
        "{opening}"
    );
    let worker_id = f.active_worker();
    let config = owner.session(&worker_id).await.unwrap().configuration;
    assert!(config.discovery_worker && config.parent_session_id.as_ref() == Some(&f.bot));
    let ids = [chat.clone(), room.clone(), f.bot.clone()];
    let watermarks = owner.discovery.session_explored_at(&ids).await.unwrap();
    assert_eq!(watermarks.len(), 3);
    for (id, marker, kind) in [
        (&chat, "Chat evidence 132", "session"),
        (&room, "Room evidence 243", "room"),
        (&f.bot, "Human Bot evidence 354", "bot"),
    ] {
        assert!(
            opening.contains(&format!(r#"[\"{kind}\",\"{id}\""#)),
            "{opening}"
        );
        tool(worker, "SessionRead", json!({"sessionId":id}));
        let (next_worker, body) = next(&mut server).await;
        let read = output(&body);
        assert_eq!(read["session"]["id"], id.as_str(), "{read}");
        assert!(
            read["transcript"]["items"].to_string().contains(marker),
            "{read}"
        );
        worker = next_worker;
    }
    finish_with_usage(worker, Usage::new(10, 2));
    f.settled(&task, 1).await;

    let notice = owner
        .prepare_notification(
            &source,
            &route,
            "discovery-report-test",
            |_| "Worker finished".into(),
            MessageOrigin::DiscoveryReport {
                session_id: worker_id,
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert!(owner.admit_notification(&notice).await.unwrap());
    next(&mut server).await.0.reply_text("Report received.");
    f.quiescent(&f.bot).await;
    let next_due = f.detail(&task).await["task"]["nextFireAt"]
        .as_i64()
        .unwrap();
    owner.tick_schedules_at(next_due).await.unwrap();
    assert_eq!(f.worker_count().await, 1);
    assert_eq!(
        owner.discovery.plan_activity(&task).await.unwrap().skipped,
        2
    );
    assert_eq!(
        owner.discovery.session_explored_at(&ids).await.unwrap(),
        watermarks
    );

    f.query(
        "send",
        json!({"sessionId":chat,"message":"Change the release date","backend":f.model}),
    )
    .await;
    let (busy_chat, _) = next(&mut server).await;
    let next_due = f.detail(&task).await["task"]["nextFireAt"]
        .as_i64()
        .unwrap();
    owner.tick_schedules_at(next_due).await.unwrap();
    assert_eq!(
        owner.discovery.plan_activity(&task).await.unwrap().skipped,
        3
    );
    f.change(&task, "trigger_now").await;
    let (manual, request) = next(&mut server).await;
    assert!(
        !request["messages"]
            .to_string()
            .contains("Sessions [kind,session_id,title,ms]")
    );
    finish_with_usage(manual, Usage::new(10, 2));
    f.settled(&task, 2).await;
    busy_chat.reply_text("Date changed.");
    f.quiescent(&chat).await;
    f.change(&task, "trigger_now").await;
    let (manual, request) = next(&mut server).await;
    assert!(
        request["messages"]
            .to_string()
            .contains("Sessions [kind,session_id,title,ms]")
    );
    let fresh = owner.discovery.session_explored_at(&ids).await.unwrap();
    assert!(fresh[&chat] > watermarks[&chat]);
    assert_eq!(
        (fresh[&room], fresh[&f.bot]),
        (watermarks[&room], watermarks[&f.bot])
    );
    finish_with_usage(manual, Usage::new(10, 2));
    f.settled(&task, 3).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_failed_enqueue_preserves_watermarks_and_empty_retry_skips_the_model() {
    use maka_agent_state::discovery::changes::OpeningSources;
    let mut server = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let mut f = Fixture::with_tools(&server, &[session_read_tool()]).await;
    let owner = f.owner();
    let writer = owner.store.data_writer().unwrap();
    let (room, posted) = f.quiet_room("Pending review").await;
    let mut effect = f.effect("read_only").await;
    effect["selectedTools"] = json!({"SessionRead":"history"});
    let due = at().0 + 600_000;
    let plan = f
        .create_effect(
            "Room changes",
            "",
            json!({"kind":"interval","everySeconds":1800,"startAt":due}),
            effect,
        )
        .await;
    writer.write(Sql("CREATE TRIGGER reject_discovery_queue BEFORE INSERT ON agent_queue_events
        WHEN EXISTS(SELECT 1 FROM session_control WHERE id=NEW.session AND json_extract(configuration,'$.discoveryWorker')=1)
        BEGIN SELECT RAISE(ABORT,'discovery queue unavailable'); END;")).await.unwrap();
    let failure = owner.tick_schedules_at(due).await.unwrap_err();
    assert!(failure.contains("discovery queue unavailable"), "{failure}");
    assert!(
        owner
            .discovery
            .session_explored_at(std::slice::from_ref(&room))
            .await
            .unwrap()
            .is_empty()
    );

    // Another opening consumes this Room while the failed request is waiting to retry.
    writer
        .write(owner.discovery.record_opening(
            OpeningSources::FollowUp {
                files: vec![],
                sessions: vec![(room, posted)],
            },
            UnixMillis(due),
        ))
        .await
        .unwrap();
    writer
        .write(Sql("DROP TRIGGER reject_discovery_queue"))
        .await
        .unwrap();
    owner.tick_schedules_at(due).await.unwrap();
    owner.tick_schedules_at(due).await.unwrap();
    let detail = f.detail(&plan).await;
    assert!(
        detail["pendingFire"].is_null() && detail["task"]["runs"].as_array().unwrap().is_empty(),
        "{detail}"
    );
    let activity = owner.discovery.plan_activity(&plan).await.unwrap();
    assert_eq!(
        (activity.model_runs, activity.tokens, activity.skipped),
        (0, 0, 1)
    );
    assert!(owner.scheduler.investigation.read().unwrap().is_none());
    let (fresh, posted) = f.quiet_room("Next review").await;
    f.change(&plan, "trigger_now").await;
    let (worker, request) = next(&mut server).await;
    assert!(request["messages"].to_string().contains(&fresh));
    assert_eq!(
        owner
            .discovery
            .session_explored_at(std::slice::from_ref(&fresh))
            .await
            .unwrap()[&fresh],
        posted.0
    );
    finish_with_usage(worker, Usage::new(10, 2));
    f.settled(&plan, 1).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_without_session_read_skips_session_admission_and_opening() {
    check_unreadable_sessions(session_read_tool(), json!({"DiscoveryMemory":"history"})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_session_list_named_session_read_cannot_consume_conversations() {
    let mut list = session_read_tool();
    list["method"] = json!("sessionList");
    check_unreadable_sessions(list, json!({"SessionRead":"history"})).await;
}

async fn check_unreadable_sessions(tool: Value, selected: Value) {
    let mut server = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let mut f = Fixture::with_tools(&server, &[tool]).await;
    let room = f.conversation("room", "Release room").await;
    f.query(
        "send",
        json!({"sessionId":room,"message":"Ready for review"}),
    )
    .await;
    let mut effect = f.effect("read_only").await;
    let named_session_read = selected.get("SessionRead").is_some();
    effect["selectedTools"] = selected;
    let start = at().0 + 600_000;
    let task = f
        .create_effect(
            "Memory only",
            "",
            json!({
                "kind":"interval","everySeconds":1800,"startAt":start
            }),
            effect,
        )
        .await;
    let owner = f.owner();
    owner.tick_schedules_at(start).await.unwrap();
    let idle = owner.discovery.plan_activity(&task).await.unwrap();
    assert_eq!(
        (idle.skipped, idle.tokens, f.worker_count().await),
        (1, 0, 0)
    );
    f.change(&task, "trigger_now").await;
    let (manual, request) = next(&mut server).await;
    assert_eq!(
        model_tool_names(&request).contains(&"SessionRead"),
        named_session_read
    );
    assert!(
        !request["messages"]
            .to_string()
            .contains("Sessions [kind,session_id,title,ms]")
    );
    assert!(
        owner
            .discovery
            .session_explored_at(&[room])
            .await
            .unwrap()
            .is_empty()
    );
    finish_with_usage(manual, Usage::new(10, 2));
    f.settled(&task, 1).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_notification_receipt_is_idempotent_across_retry_and_reopen() {
    let mut server = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
    let task = f.create("Notification receipt").await;
    f.use_legacy_report_grant(&task).await;
    f.change(&task, "trigger_now").await;
    let (turn, request) = next(&mut server).await;
    let tools = request["tools"].as_array().unwrap();
    assert!(tools.iter().any(|tool| tool["function"]["name"] == "Read"));
    #[cfg(target_os = "macos")]
    assert!(tools.iter().any(|tool| tool["function"]["name"] == "Shell"));
    let observation =
        json!({"text":"Evidence remains useful after notification.","references":["source.md"]});
    tool(
        turn,
        "DiscoveryComplete",
        json!({"kind":"report","text":"A useful finding","notes":[observation]}),
    );
    f.settled(&task, 1).await;
    assert_bot_untouched(&f).await;
    f.send(
        "Read the investigation record and publish my requested notification",
        json!([]),
    )
    .await;
    let (turn, _) = next(&mut server).await;
    let (turn, page) = memory(&mut server, turn, json!({"action":"list"})).await;
    let record = page["records"][0]["id"].clone();
    let (turn, entry) = memory(&mut server, turn, json!({"action":"get","record":record})).await;
    assert_eq!(entry["content"]["result"]["notes"], json!([observation]));
    let input = json!({"messageId":"notification-uncertain","messages":[{"text":"A useful finding"}],"discovery":{"record":record,"reason":"verified"}});
    tool(turn, "SendUser", input.clone());
    let (turn, _) = next(&mut server).await;
    quiet(&f, &mut server, turn).await;
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
    let (turn, _) = next(&mut server).await;
    tool(turn, "SendUser", input);
    let (turn, body) = next(&mut server).await;
    assert!(body.to_string().contains("Already sent"), "{body}");
    let (turn, page) = memory(&mut server, turn, json!({"action":"list","related":record})).await;
    assert_eq!(page["records"].as_array().unwrap().len(), 2, "{page}");
    assert_eq!(page["records"][0]["kind"], "notified");
    assert_eq!(f.outbox().await, original);
    let (turn, sent_source) = memory(
        &mut server,
        turn,
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
    quiet(&f, &mut server, turn).await;
    let quote = json!({"text":"Do not repeat this finding", "label":"Proactive discovery",
        "sourceMessageId":format!("bot/{}",publication["sequence"]),"sourceTurnId":publication["turnId"],
        "source":{"sessionId":f.bot,"sessionName":"Bot","capturedAt":maka_agent_authority::now(),"truncated":false}});
    let sent = f.send("", json!([quote])).await;
    let (turn, body) = next(&mut server).await;
    assert!(body.to_string().contains("Do not repeat this finding"));
    let (turn, rejected) = memory(
        &mut server,
        turn,
        json!({"action":"feedback","record":"another-investigation","note":"Wrong target"}),
    )
    .await;
    assert!(
        rejected
            .to_string()
            .contains("feedback_does_not_match_quoted_discovery"),
        "{rejected}"
    );
    let (turn, saved) = memory(
        &mut server,
        turn,
        json!({"action":"feedback","note":"Stop repeating this"}),
    )
    .await;
    assert_eq!(saved["recorded"], true, "{saved}");
    let (turn, source) = memory(
        &mut server,
        turn,
        json!({"action":"get","record":saved["record"]}),
    )
    .await;
    assert_eq!(source["source_path"], format!("maka://session/{}", f.bot));
    assert_eq!(source["content"]["message_id"], sent["messageId"]);
    quiet(&f, &mut server, turn).await;
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
    let mut server = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
    let task = f.create("Late notification").await;
    f.use_legacy_report_grant(&task).await;
    let mut records = vec![];
    for subject in ["First finding", "Second finding"] {
        f.change(&task, "trigger_now").await;
        let (worker, _) = next(&mut server).await;
        tool(
            worker,
            "DiscoveryComplete",
            json!({"kind":"report","text":subject}),
        );
        f.settled(&task, records.len() + 1).await;
        f.send("Read the saved investigation", json!([])).await;
        let (bot, _) = next(&mut server).await;
        let (bot, page) = memory(&mut server, bot, json!({"action":"list"})).await;
        records.push(page["records"][0]["id"].as_str().unwrap().to_owned());
        quiet(&f, &mut server, bot).await;
        f.settled(&task, records.len()).await;
    }
    assert_ne!(records[0], records[1]);
    f.send("Publish the first finding.", json!([])).await;
    let (bot, _) = next(&mut server).await;
    tool(
        bot,
        "SendUser",
        json!({"messageId":"two-parts","messages":[{"text":"Finding"},{"text":"Details"}]}),
    );
    let (bot, _) = next(&mut server).await;
    let notified = |record: &str| json!({"action":"notified","record":record,"reason":"verified","message_id":"two-parts"});
    let (bot, linked) = memory(&mut server, bot, notified(&records[0])).await;
    assert_eq!(linked["recorded"], true, "{linked}");
    let (bot, rejected) = memory(&mut server, bot, notified(&records[1])).await;
    assert!(
        rejected
            .to_string()
            .contains("notification_linked_to_another_discovery"),
        "{rejected}"
    );
    let (bot, other) = memory(
        &mut server,
        bot,
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
    quiet(&f, &mut server, bot).await;
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
    let (bot, _) = next(&mut server).await;
    let (bot, retried) = memory(&mut server, bot, notified(&records[0])).await;
    assert_eq!(retried, linked);
    let (bot, feedback) = memory(
        &mut server,
        bot,
        json!({"action":"feedback","note":"Stop this finding"}),
    )
    .await;
    let (bot, entry) = memory(
        &mut server,
        bot,
        json!({"action":"get","record":feedback["record"]}),
    )
    .await;
    assert_eq!(entry["content"]["record"], records[0], "{entry}");
    quiet(&f, &mut server, bot).await;
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

    let mut server = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
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
    f.use_legacy_report_grant(&task).await;
    let worker = if at_delivery {
        f.change(&task, "trigger_now").await;
        Some(next(&mut server).await.0)
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
    if let Some(turn) = worker {
        tool(
            turn,
            "DiscoveryComplete",
            json!({"kind":"report","text":"Synthetic finding"}),
        );
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
    let (control, _) = next(&mut server).await;
    tool(control, "FinishNoChange", json!({"note":"Control ran"}));
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
    let mut server = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
    let workspace = f.rig.directory.path().join("workspace");
    let moved = f.rig.directory.path().join("moved-workspace");
    for reporting in [false, true] {
        let task = f.create("Check the approved workspace").await;
        f.use_legacy_report_grant(&task).await;
        if reporting {
            f.change(&task, "trigger_now").await;
            let (worker, _) = next(&mut server).await;
            std::fs::rename(&workspace, &moved).unwrap();
            tool(
                worker,
                "DiscoveryComplete",
                json!({"kind":"report","text":"Workspace finding"}),
            );
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
    let (control, _) = next(&mut server).await;
    tool(control, "FinishNoChange", json!({"note":"Control ran"}));
    assert_eq!(
        f.settled(&healthy, 1).await["task"]["runs"][0]["outcome"],
        "ok"
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_rejects_script_edits_even_when_the_existing_grant_matches() {
    let server = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
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
    let mut original = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let mut updated = MockAiBuilder::new().interactive(8).start().await.unwrap();
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
    f.use_legacy_report_grant(&reporting).await;
    f.change(&reporting, "trigger_now").await;
    let (turn, _) = next(&mut updated).await;
    f.change_model_endpoint(&original).await;
    tool(
        turn,
        "DiscoveryComplete",
        json!({"kind":"report","text":"A finding on the previously approved route"}),
    );
    let blocked = f.settled(&reporting, 1).await;
    assert_eq!(blocked["task"]["runs"][0]["outcome"], "ok", "{blocked}");
    assert!(blocked["task"]["runs"][0]["runId"].is_string(), "{blocked}");
    assert_eq!(f.outbox().await, json!([]));

    assert_eq!(f.reapprove(&stale, "session").await["kind"], "committed");
    f.change(&stale, "trigger_now").await;
    let (turn, _) = next(&mut original).await;
    tool(
        turn,
        "FinishNoChange",
        json!({"note":"Checked after reapproval"}),
    );
    assert_eq!(
        f.settled(&stale, 2).await["task"]["runs"][0]["outcome"],
        "ok"
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_checks_model_on_worker_admission_and_settles_locally() {
    let mut server = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
    let waiting = f.create("Approved before disabling the connection").await;
    let reporting = f.create("Model removed before report delivery").await;
    f.use_legacy_report_grant(&reporting).await;

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
    let (turn, _) = next(&mut server).await;
    f.update_model_connection(ConnectionCatalogEntryUpdate {
        enabled_model_ids: Some(vec![]),
        ..Default::default()
    })
    .await;
    tool(
        turn,
        "DiscoveryComplete",
        json!({"kind":"report","text":"A finding whose delivery model was removed"}),
    );
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
    let (turn, _) = next(&mut server).await;
    tool(
        turn,
        "FinishNoChange",
        json!({"note":"Checked after enabling the model again"}),
    );
    assert_eq!(
        f.settled(&waiting, 2).await["task"]["runs"][0]["outcome"],
        "ok"
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_pause_resume_cancels_only_the_original_fire_before_next_worker() {
    let mut server = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
    let first = f.create("A").await;
    let second = f.create("B").await;
    f.change(&first, "trigger_now").await;
    let (turn, _) = next(&mut server).await;
    let (_socket, result) = memory(
        &mut server,
        turn,
        json!({"action":"checkpoint","note":{"text":"cancelled checkpoint"}}),
    )
    .await;
    assert_eq!(result["staged"], true);
    f.change(&second, "trigger_now").await;
    assert!(
        tokio::time::timeout(Duration::from_millis(100), server.next_turn())
            .await
            .is_err()
    );
    f.change(&first, "pause").await;
    f.change(&first, "resume").await;
    let done = f.settled(&first, 1).await;
    assert_eq!(done["task"]["runs"][0]["outcome"], "blocked");
    let (turn, body) = next(&mut server).await;
    assert!(!body.to_string().contains("cancelled checkpoint"));
    let (turn, page) = memory(&mut server, turn, json!({"action":"list"})).await;
    assert_eq!(page["records"], json!([]));
    tool(turn, "FinishNoChange", json!({"note":"B completed"}));
    f.settled(&second, 1).await;
    assert_eq!(f.outbox().await, json!([]));
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_resume_does_not_upgrade_an_existing_read_only_plan() {
    let mut server = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
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
    let (worker, request) = next(&mut server).await;
    let tools = request["tools"].as_array().unwrap();
    assert!(
        tools
            .iter()
            .any(|t| t["function"]["name"] == "FinishNoChange")
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
    tool(worker, "Read", json!({"path":"discovery.txt"}));
    let (worker, body) = next(&mut server).await;
    assert!(
        output(&body)
            .to_string()
            .contains("Observed fixture evidence"),
        "{body}"
    );
    tool(worker, "FinishNoChange", json!({"note":"Read-only check"}));
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
    let mut server = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
    f.change_source(|config| config.tools = Some(vec!["ScheduledTask".into()]))
        .await;

    let names = f.preview(&f.effect("session").await, None).await;
    assert_eq!(
        names,
        json!([
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
    let (worker, request) = next(&mut server).await;
    assert_eq!(json!(model_tool_names(&request)), names);
    assert!(
        !request["messages"]
            .to_string()
            .contains("Use DiscoveryMemory to read")
    );
    tool(
        worker,
        "FinishNoChange",
        json!({"note":"Finished with approved tools"}),
    );
    assert_eq!(
        f.settled(&task, 1).await["task"]["runs"][0]["outcome"],
        "ok"
    );
    f.send("Check the Bot tool ceiling", json!([])).await;
    let (turn, request) = next(&mut server).await;
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
    quiet(&f, &mut server, turn).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_approves_grouped_aliases_and_rechecks_the_parent_ceiling() {
    let mut server = MockAiBuilder::new().interactive(12).start().await.unwrap();
    let mut f = Fixture::with_tools(&server, &[
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
            "FinishNoChange",
            "InspectSetup",
            "OpenDocument",
            "RegisterWatch",
            "StageArtifact",
            "StagePendingAction",
            "UpdateWatchScope",
            "UpdateWorkspaceMap",
            "UpsertDossier"
        ])
    );
    f.change(&task, "trigger_now").await;
    let (worker, request) = next(&mut server).await;
    assert_eq!(
        model_tool_names(&request),
        [
            "FinishNoChange",
            "InspectSetup",
            "OpenDocument",
            "RegisterWatch",
            "StageArtifact",
            "StagePendingAction",
            "UpdateWatchScope",
            "UpdateWorkspaceMap",
            "UpsertDossier"
        ]
    );
    assert!(request["messages"].to_string().contains("Onboard"));
    tool(worker, "OpenDocument", json!({"path":"discovery.txt"}));
    let (worker, response) = next(&mut server).await;
    assert!(
        output(&response)
            .to_string()
            .contains("Observed fixture evidence"),
        "{response}"
    );
    tool(worker, "UpdateWorkspaceMap", json!({"action":"mark_ready"}));
    let (worker, response) = next(&mut server).await;
    assert_eq!(output(&response)["updated"], true, "{response}");
    tool(worker, "FinishNoChange", json!({"note":"Mapped"}));
    f.settled(&task, 1).await;
    f.change(&task, "trigger_now").await;
    let (worker, request) = next(&mut server).await;
    assert_eq!(
        model_tool_names(&request),
        [
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
    tool(worker, "FinishNoChange", json!({"note":"Checked"}));
    f.settled(&task, 2).await;
    f.change_source(|config| config.tools = Some(vec!["Read".into()]))
        .await;
    f.change(&task, "trigger_now").await;
    let (worker, request) = next(&mut server).await;
    assert_eq!(
        model_tool_names(&request),
        [
            "FinishNoChange",
            "RegisterWatch",
            "StageArtifact",
            "StagePendingAction",
            "UpsertDossier"
        ]
    );
    tool(worker, "FinishNoChange", json!({"note":"Finished"}));
    f.settled(&task, 3).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_preview_omits_tools_attached_only_to_the_bot_session() {
    use maka_agent_facts::configuration::mcp::{ServerConfiguration, Transport};
    let server = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
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
    let mut server = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
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
            "FinishNoChange",
            "Read",
            "RegisterWatch",
            "StageArtifact",
            "StagePendingAction",
            "UpdateWatchScope",
            "UpdateWorkspaceMap",
            "UpsertDossier"
        ])
    );
    let task = f.create("Approved tool ceiling").await;

    // Ordinary Session gains Write again. The existing plan keeps its approved Read.
    f.change_source(|config| config.tools = None).await;
    f.change(&task, "pause").await;
    f.change(&task, "resume").await;
    f.change(&task, "trigger_now").await;
    let (turn, request) = next(&mut server).await;
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
    tool(turn, "FinishNoChange", json!({"note":"Restricted search"}));
    assert_eq!(
        f.settled(&task, 1).await["task"]["runs"][0]["outcome"],
        "ok"
    );

    assert_eq!(f.reapprove(&task, "session").await["kind"], "committed");
    f.change(&task, "trigger_now").await;
    let (turn, request) = next(&mut server).await;
    let expanded = names(&request);
    assert!(!expanded.iter().any(|name| name == "Write"), "{expanded:?}");
    assert!(
        !expanded.iter().any(|name| name == "SendUser"),
        "{expanded:?}"
    );
    #[cfg(target_os = "macos")]
    let turn = {
        assert!(expanded.iter().any(|name| name == "Shell"), "{expanded:?}");
        tool(
            turn,
            "Shell",
            json!({"command":"printf approved-shell && echo changed > discovery.txt","login":false}),
        );
        let (socket, body) = next(&mut server).await;
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
    tool(turn, "FinishNoChange", json!({"note":"Updated scope"}));
    assert_eq!(
        f.settled(&task, 2).await["task"]["runs"][0]["outcome"],
        "ok"
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_memory_tool_searches_record_text_and_relationships() {
    let mut server = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
    let task = f.create("Older useful record").await;
    f.use_legacy_report_grant(&task).await;
    f.change(&task, "trigger_now").await;
    let (turn, _) = next(&mut server).await;
    tool(
        turn,
        "DiscoveryComplete",
        json!({"kind":"report","text":"Migration original-search-marker"}),
    );
    f.settled(&task, 1).await;
    f.send("Look up the investigation history", json!([])).await;
    let (turn, _) = next(&mut server).await;
    let (turn, page) = memory(&mut server, turn, json!({"action":"list"})).await;
    let record = page["records"][0]["id"].clone();
    let (turn, saved) = memory(
        &mut server, turn,
        json!({"action":"correct","record":record,"note":{"text":"He said \"stop\"\nCheck the next line"}})
    ).await;
    assert_eq!(saved["recorded"], true);
    let (turn, page) = memory(
        &mut server,
        turn,
        json!({"action":"list","query":"He said \"stop\"\nCheck","related":record}),
    )
    .await;
    assert_eq!(page["records"].as_array().unwrap().len(), 1);
    assert_eq!(page["records"][0]["sequence"], 2);
    assert_eq!(page["records"][0]["related"], record);
    assert_eq!(page["next_before"], Value::Null);
    let (turn, page) = memory(&mut server, turn, json!({"action":"list","query":"kind"})).await;
    assert_eq!(page["records"], json!([]));
    quiet(&f, &mut server, turn).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scheduler_dry_run_rejects_oversize_state_without_saving_a_task() {
    let mut server = MockAiBuilder::new().interactive(4).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
    f.send("Preview this automation", json!([])).await;
    let (turn, _) = next(&mut server).await;
    tool(
        turn,
        "ScheduledTask",
        json!({"request":{"mode":"test_script",
        "source":"console.log(true)", "state":"x".repeat(65_535)}}),
    );
    let (turn, body) = next(&mut server).await;
    let preview = output(&body);
    assert_eq!(preview["ok"], false, "{preview}");
    assert_eq!(preview["error"], "state exceeds 65536 JSON bytes");
    assert!(preview["durationMs"].is_u64());
    assert_eq!(
        f.query("schedules", json!({"kind":"list"})).await["tasks"],
        json!([])
    );
    quiet(&f, &mut server, turn).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_model_proposals_require_bot_identity_and_human_approval() {
    let mut server = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
    let proposal = json!({"request":{"mode":"create","title":"Proposed discovery","intentBody":"Check authorized documents","effect":"discovery","schedule":{"kind":"interval","everySeconds":3600,"startAt":maka_agent_authority::now()+3_600_000},"timezone":"UTC"}});
    let created=f.query("create",json!({"title":"Ordinary proposer","automaticTitle":false,"labels":[],"tools":["ScheduledTask","DiscoveryComplete","DiscoveryMemory"],"workspace":{"kind":"directory","path":f.rig.directory.path().join("workspace")}})).await;
    let session = created["session"]["id"].as_str().unwrap();
    f.query("send",json!({"sessionId":session,"message":"Propose a discovery","backend":f.model,"delivery":"queue"})).await;
    let (turn, body) = next(&mut server).await;
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
    tool(turn, "ScheduledTask", proposal.clone());
    let (turn, body) = next(&mut server).await;
    assert!(
        output(&body).to_string().contains("discovery_requires_bot"),
        "{body}"
    );
    turn.reply_text("Cannot propose discovery here");
    f.quiescent(session).await;
    assert_eq!(
        f.query("schedules", json!({"kind":"discovery","sessionId":f.bot}))
            .await["tasks"],
        json!([])
    );
    f.send("Propose a discovery", json!([])).await;
    let (turn, _) = next(&mut server).await;
    tool(turn, "ScheduledTask", proposal);
    let (turn, _) = next(&mut server).await;
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
        turn,
        "ScheduledTask",
        json!({"request":{"mode":"resume","taskId":id,"revision":task["revision"]}}),
    );
    let (turn, body) = next(&mut server).await;
    assert!(
        output(&body)
            .to_string()
            .contains("scheduler_user_approval_required"),
        "{body}"
    );
    quiet(&f, &mut server, turn).await;
    f.change(id, "approve").await;

    f.send("Pause and then resume your discovery", json!([]))
        .await;
    let (mut turn, _) = next(&mut server).await;
    for (mode, status) in [("pause", "paused"), ("resume", "active")] {
        let revision = f.detail(id).await["revision"].clone();
        tool(
            turn,
            "ScheduledTask",
            json!({"request":{"mode":mode,"taskId":id,"revision":revision}}),
        );
        let (reply, body) = next(&mut server).await;
        assert_eq!(output(&body)["taskId"], id, "{body}");
        assert_eq!(f.detail(id).await["task"]["status"], status);
        turn = reply;
    }
    quiet(&f, &mut server, turn).await;

    f.change(id, "pause").await;
    f.reopen().await;
    f.send("Try to pause and resume the paused plan", json!([]))
        .await;
    let (turn, _) = next(&mut server).await;
    tool(
        turn,
        "ScheduledTask",
        json!({"request":{"mode":"pause","taskId":id,"revision":f.detail(id).await["revision"]}}),
    );
    let (turn, body) = next(&mut server).await;
    assert_eq!(output(&body)["taskId"], id, "{body}");
    tool(
        turn,
        "ScheduledTask",
        json!({"request":{"mode":"resume","taskId":id,"revision":f.detail(id).await["revision"]}}),
    );
    let (turn, body) = next(&mut server).await;
    assert!(
        output(&body)
            .to_string()
            .contains("scheduler_user_resume_required"),
        "{body}"
    );
    assert_eq!(f.detail(id).await["task"]["status"], "paused");
    quiet(&f, &mut server, turn).await;

    f.change(id, "resume").await;
    f.change(id, "trigger_now").await;
    let (worker, _) = next(&mut server).await;
    tool(
        worker,
        "FinishNoChange",
        json!({"note":"Checked after user approval"}),
    );
    assert_eq!(f.settled(id, 1).await["task"]["runs"][0]["outcome"], "ok");
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_schedules_the_next_check_from_the_finished_investigation() {
    let mut server = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
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
    let (worker, _) = next(&mut server).await;
    tool(
        worker,
        "FinishNoChange",
        json!({"note":"Finished the manual check"}),
    );
    let done = f.settled(&task, 1).await;
    let next_at = done["task"]["runs"][0]["at"].as_u64().unwrap() + delay;
    assert_eq!(done["task"]["nextFireAt"], json!(next_at));

    f.reopen().await;
    assert_eq!(f.detail(&task).await["task"]["nextFireAt"], json!(next_at));
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_restart_settles_an_interrupted_original_run_without_replay() {
    let mut server = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
    let task = f.create("Interrupted investigation").await;
    f.change(&task, "trigger_now").await;
    let (_socket, _) = next(&mut server).await;
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
    let (_resumed, _) = next(&mut server).await;
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
        tokio::time::timeout(Duration::from_millis(100), server.next_turn())
            .await
            .is_err()
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_startup_commits_stop_for_a_paused_worker_before_queue_recovery() {
    let mut server = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
    let task = f.create("Paused while the Host was stopping").await;
    f.change(&task, "trigger_now").await;
    let (_socket, _) = next(&mut server).await;
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
async fn discovery_catalog_tracks_the_original_worker_and_rejects_continuation() {
    let mut server = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
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
    let (turn, _) = next(&mut server).await;
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
    let catalog = f.query("list", json!({"filter":"all","scope":{"kind":"children","sessionId": f.bot}, "position":{"kind":"start"}})).await;
    let probe = catalog["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == active["sessionId"])
        .unwrap();
    assert_eq!(probe["discoveryWorker"], true);

    assert_ne!(active["sessionId"], f.bot);
    assert!(!active["turnId"].as_str().unwrap().is_empty());
    tool(turn, "FinishNoChange", json!({"note":"No material change"}));
    tokio::time::timeout(Duration::from_secs(45), updates.changed())
        .await
        .unwrap()
        .unwrap();
    let done = f.settled(&task, 1).await;
    assert!(done["investigation"].is_null());
    let run = &done["task"]["runs"][0];
    assert_eq!(run["sessionId"], active["sessionId"]);
    let availability = f
        .query(
            "continuationAvailability",
            json!({"sessionId":run["sessionId"],"runId":run["runId"]}),
        )
        .await;
    assert_eq!(
        availability,
        json!({"kind":"rejected","reason":"safety_check_failed"})
    );

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
    server: &mut MockAiServer,
    turn: TurnHandle,
    input: Value,
) -> (TurnHandle, Value) {
    tool(turn, "UpsertDossier", input);
    let (turn, request) = next(server).await;
    (turn, output(&request))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_dossiers_commit_linked_once_edits_and_gate_interrupts() {
    let mut server = MockAiBuilder::new().interactive(16).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
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
    let (worker, _) = next(&mut server).await;
    let mut input = json!({"topic_id":"contract","expected_revision":0,"title":"Attachments","signal":"red","priority_weight":7.0,"summary_md":"The new annex supersedes the old deadline.","artifacts":[],"linked_task_ids":[reminder],"schedule_ops":[{"kind":"update","task_id":reminder,"intent_body":"Review the new annex"}],"notify_intent":{"kind":"interrupt","reason":"Signature due"}});
    let (worker, first) = worker_upsert(&mut server, worker, input.clone()).await;
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
    let (worker, duplicate) = worker_upsert(&mut server, worker, input.clone()).await;
    assert_eq!(duplicate["notified"], false, "{duplicate}");
    f.query("setDiscoveryNotifications", json!({"enabled":false}))
        .await;
    input["summary_md"] = json!("Confirmed against the signed copy");
    input["fact_state"] = json!("Annex signed");
    let (worker, global) = worker_upsert(&mut server, worker, input.clone()).await;
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
    input["fact_state"] = json!("Review concluded");
    input["change_note"] = json!("Legal approved the annex");
    input["evidence_md"] = json!("Signed decision 8921");
    let (worker, muted) = worker_upsert(&mut server, worker, input.clone()).await;
    assert_eq!(muted["notified"], false, "{muted}");
    input["expected_revision"] = json!(1);
    input["schedule_ops"] = json!([{"kind":"cancel","task_id":reminder}]);
    let (worker, conflict) = worker_upsert(&mut server, worker, input.clone()).await;
    assert!(conflict.to_string().contains("revision"), "{conflict}");
    assert_eq!(
        f.detail(&reminder).await["task"]["intent"],
        revised["task"]["intent"]
    );
    input["expected_revision"] = json!(3);
    let (worker, cancelled) = worker_upsert(&mut server, worker, input.clone()).await;
    assert_eq!(cancelled["revision"], 4, "{cancelled}");
    assert!(f.detail(&reminder).await.is_null());
    input["topic_id"] = json!("unrelated");
    input["expected_revision"] = json!(0);
    input["schedule_ops"] = json!([]);
    input["linked_task_ids"] = json!([]);
    input["summary_md"] = json!("Separate evidence");
    input["notify_intent"] = json!({"kind":"quiet"});
    let (worker, second) = worker_upsert(&mut server, worker, input).await;
    assert_eq!(second["revision"], 1, "{second}");
    tool(
        worker,
        "FinishNoChange",
        json!({"note":"Checked both sources","checked_topic_ids":["contract","unrelated"]}),
    );
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
    let (bot, request) = next(&mut server).await;
    assert!(!request["messages"].to_string().contains("8921"));
    assert!(model_tool_names(&request).contains(&"ListDossiers"));
    tool(bot, "ListDossiers", json!({}));
    let (bot, list) = next(&mut server).await;
    assert_eq!(output(&list).as_array().unwrap().len(), 2);
    assert!(!output(&list).to_string().contains("8921"));
    tool(bot, "ReadDossier", json!({"topic_id":"contract"}));
    let (bot, read) = next(&mut server).await;
    assert_eq!(output(&read)["summary_md"], detail["summaryMd"]);
    assert_eq!(output(&read)["evidence_md"], "Signed decision 8921");
    assert_eq!(output(&read)["change_note"], "Legal approved the annex");
    assert!(!output(&read).to_string().contains("Separate evidence"));
    quiet(&f, &mut server, bot).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_lead_opens_one_isolated_thread_with_its_initial_summary() {
    let mut server = MockAiBuilder::new().interactive(8).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
    f.send("Private Bot history marker 4719", json!([])).await;
    let (bot, _) = next(&mut server).await;
    quiet(&f, &mut server, bot).await;
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
    let (thread, request) = next(&mut server).await;
    let messages = request["messages"].to_string();
    assert!(
        messages.contains("8142") && messages.contains("docs/spec.md"),
        "{messages}"
    );
    assert!(!messages.contains("4719"), "{messages}");
    thread.reply_text("Check the referenced spec.");
    f.quiescent(session).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn elevate_dossier_thread_observes_defaults_quiescence_and_archive() {
    let mut server = MockAiBuilder::new().interactive(4).start().await.unwrap();
    let mut f = Fixture::configured(&server, &[], "", |config| {
        config["permissions"]["access"] = json!("workspace_write");
    })
    .await;
    let owner = f.owner();
    assert_eq!(
        owner.settings.permissions.access,
        WorkspaceAccess::WorkspaceWrite
    );
    let policy = owner.configuration.runtime_policy().await.unwrap();
    let mut defaults = policy.policy.chat_defaults;
    defaults.sandbox_mode = SandboxMode::ReadOnly;
    owner
        .configuration
        .set_chat_defaults(policy.revision, defaults)
        .await
        .unwrap();
    let lead = f
        .query(
            "dropDiscoveryLead",
            json!({"text":"Check permission elevation policy","paths":[]}),
        )
        .await;
    let opened = f.query("openDossierThread", lead.clone()).await;
    let session = opened["sessionId"].as_str().unwrap().to_owned();
    let initial = owner.session(&session).await.unwrap().configuration;
    let initial_boundary = initial.boundary_revision;
    assert!(!initial.dossier_elevated);

    assert_eq!(initial.permissions.access, WorkspaceAccess::ReadOnly);
    f.query("send", json!({"sessionId": session, "message": "Review the current document.", "backend": f.model})).await;
    let (turn, _) = next(&mut server).await;
    assert!(
        matches!(owner.elevate_dossier_thread(&session).await, Err(reason) if reason == "session_busy")
    );
    turn.reply_text("Review complete.");
    f.quiescent(&session).await;

    let elevated = f
        .query(
            "openDossierThread",
            json!({"topicId": lead["topicId"], "elevate": true}),
        )
        .await;
    assert_eq!(elevated["sessionId"], session);
    let after = owner.session(&session).await.unwrap().configuration;
    assert!(after.dossier_elevated);
    assert_eq!(after.permissions, initial.permissions);
    assert_eq!(after.boundary_revision, initial_boundary + 1);
    f.query(
        "openDossierThread",
        json!({"topicId": lead["topicId"], "elevate": true}),
    )
    .await;
    assert_eq!(
        owner
            .session(&session)
            .await
            .unwrap()
            .configuration
            .boundary_revision,
        after.boundary_revision
    );

    let direct = f
        .query(
            "dropDiscoveryLead",
            json!({"text":"Direct execution thread"}),
        )
        .await;
    let opened = f
        .query(
            "openDossierThread",
            json!({"topicId":direct["topicId"],"elevate":true}),
        )
        .await;
    let direct = owner
        .session(opened["sessionId"].as_str().unwrap())
        .await
        .unwrap()
        .configuration;
    assert!(direct.dossier_elevated);
    assert_eq!(direct.permissions, initial.permissions);

    let second = f
        .query(
            "dropDiscoveryLead",
            json!({"text":"Concurrent thread opening","paths":[]}),
        )
        .await;
    let (ordinary, elevated) = tokio::join!(
        f.query("openDossierThread", second.clone()),
        f.query(
            "openDossierThread",
            json!({"topicId":second["topicId"],"elevate":true})
        ),
    );
    assert_eq!(ordinary, elevated);
    let winner = owner
        .session(elevated["sessionId"].as_str().unwrap())
        .await
        .unwrap();
    assert!(winner.configuration.dossier_elevated);
    assert_eq!(winner.configuration.permissions, initial.permissions);

    // Archiving or referencing a missing session must reject explicit elevation.
    assert!(
        owner
            .elevate_dossier_thread("nonexistent-dossier-session")
            .await
            .is_err()
    );
    let rev = owner
        .canonical_catalog()
        .unwrap()
        .record(&session)
        .await
        .unwrap()
        .unwrap()
        .metadata
        .revision;
    f.query(
        "changeSession",
        json!({"action":"archive","sessionId":session,"expectedRevision":rev}),
    )
    .await;
    assert!(owner.elevate_dossier_thread(&session).await.is_err());
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_stalled_worker_settles_quietly_and_releases_the_slot() {
    let mut server = MockAiBuilder::new().interactive(16).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
    let task = f.create("Review terms").await;
    f.change(&task, "trigger_now").await;
    let (worker, opening) = next(&mut server).await;
    assert!(
        opening["messages"]
            .to_string()
            .contains("Deltas [kind,path,ms]")
    );
    let mut worker = Some(worker);
    for step in 1..=6 {
        let path = if step % 2 == 1 {
            "discovery.txt"
        } else {
            "./discovery.txt"
        };
        tool(worker.take().unwrap(), "Read", json!({"path":path}));
        if step < 6 {
            let (socket, request) = next(&mut server).await;
            worker = Some(socket);
            let message = request["messages"].as_array().unwrap().last().unwrap();
            assert_eq!(message["role"], "tool");
            assert_eq!(
                message["content"]
                    .to_string()
                    .contains("Wrap up immediately"),
                step == 4,
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
    let plan = f
        .owner()
        .scheduler
        .change_basis(&task)
        .await
        .unwrap()
        .unwrap()
        .plan;
    assert_eq!(plan.consecutive_incomplete, 1);
    assert!(plan.task.next_fire_at.unwrap() >= plan.task.last_fire_at.unwrap() + 3_600_000);
    f.change(&task, "trigger_now").await;
    let (worker, _) = next(&mut server).await;
    tool(worker, "FinishNoChange", json!({"note":"Done"}));
    f.settled(&task, 2).await;
    assert_eq!(
        f.owner()
            .scheduler
            .change_basis(&task)
            .await
            .unwrap()
            .unwrap()
            .plan
            .consecutive_incomplete,
        0
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_checkpoints_reach_the_worker_tool_result_and_skip_bot_chat() {
    let mut server = MockAiBuilder::new().interactive(64).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
    let dir = f.rig.directory.path().join("workspace").join("evidence");
    tokio::fs::create_dir(&dir).await.unwrap();
    let large = format!("{}MIDDLE{}END", "源".repeat(2_600), "界".repeat(1_400));
    for n in 1..=17 {
        tokio::fs::write(
            dir.join(format!("{n}.txt")),
            format!("Verified source {n} {}", if n == 12 { &large } else { "" }),
        )
        .await
        .unwrap();
    }
    let due = at().0 + 3_600_000;
    let task = f
        .create_scheduled(
            "Weekly synthesis",
            "Prepare the weekly evidence briefing",
            json!({"kind":"interval","everySeconds":3600,"startAt":due}),
        )
        .await;
    f.owner().tick_schedules_at(due).await.unwrap();
    let (mut worker, frozen_opening) = next(&mut server).await;
    assert_eq!(f.active_token_budget().await, Some(1_500_000));
    assert!(
        frozen_opening["messages"]
            .to_string()
            .contains("4–7 natural prose paragraphs")
    );
    assert!(
        !model_tool_names(&frozen_opening)
            .iter()
            .any(|name| matches!(
                *name,
                "UpdateWorkspaceMap" | "UpdateWatchScope" | "DiscoveryComplete"
            ))
    );
    let tools = model_tool_names(&frozen_opening)
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut checkpoint_prefix: Vec<Value> = Vec::new();
    for step in 1..=17 {
        tool(
            worker,
            "Read",
            json!({"path":format!("evidence/{step}.txt")}),
        );
        let (socket, request) = next(&mut server).await;
        worker = socket;
        assert_eq!(model_tool_names(&request), tools);
        let messages = request["messages"].as_array().unwrap();
        assert!(
            messages.starts_with(&checkpoint_prefix),
            "the replayed prefix changed at step {step}"
        );
        let msg = messages.last().unwrap();
        assert_eq!(msg["role"], "tool");
        let content = msg["content"].to_string();
        assert_eq!(
            content.contains(&format!("Verified source {step}")),
            step <= 14,
            "{msg}"
        );
        assert_eq!(
            content.contains("remaining step budget"),
            step == 12 || step >= 14,
            "{msg}"
        );
        if step == 12 {
            assert!(content.contains("Output truncated") && content.contains("END"));
            assert!(!content.contains("MIDDLE"));
            checkpoint_prefix = messages.clone();
        }
    }
    tool(
        worker,
        "FinishNoChange",
        json!({"note":"Finished all topics"}),
    );
    f.settled(&task, 1).await;
    let client = f.rig.client.as_ref().unwrap();
    let workspace = f.rig.directory.path().join("workspace");
    let ordinary = call(
        client,
        "agent",
        "create",
        json!({
            "title":"Ordinary session","automaticTitle":false,"labels":[],
            "workspace":{"kind":"directory","path":workspace}
        }),
    )
    .await
    .unwrap();
    let session = ordinary["session"]["id"].as_str().unwrap().to_string();
    call(
        client,
        "agent",
        "selectBackend",
        json!({"sessionId":session,"backend":f.model}),
    )
    .await
    .unwrap();
    let sent = call(
        client,
        "agent",
        "send",
        json!({"sessionId":session,"message":"Read the large evidence"}),
    )
    .await
    .unwrap();
    let (ordinary_turn, _) = next(&mut server).await;
    tool(ordinary_turn, "Read", json!({"path":"evidence/12.txt"}));
    let (ordinary_turn, request) = next(&mut server).await;
    let content = request["messages"].as_array().unwrap().last().unwrap()["content"].to_string();
    assert!(
        content.contains(&large) && !content.contains("Output truncated"),
        "ordinary session content (len={}): {}",
        content.len(),
        &content[..content.len().min(800)]
    );
    ordinary_turn.reply_text("Done.");
    quiescent_message(client, &session, &sent["messageId"])
        .await
        .unwrap();

    f.send("Read the evidence", json!([])).await;
    let (mut bot, _) = next(&mut server).await;
    for _ in 1..=17 {
        tool(bot, "Read", json!({"path":"discovery.txt"}));
        let (socket, request) = next(&mut server).await;
        bot = socket;
        let content =
            request["messages"].as_array().unwrap().last().unwrap()["content"].to_string();
        assert!(
            !content.contains("Wrap up immediately") && !content.contains("remaining step budget"),
            "{content}"
        );
    }
    quiet(&f, &mut server, bot).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_greedy_onboard_wraps_up_softly_and_persists_map() {
    use maka_agent_facts::durable::{AcceptedResult, ToolDecision};
    let mut server = MockAiBuilder::new().interactive(32).start().await.unwrap();
    // Bind Shell to the fixture's file reader so every platform returns deterministic evidence.
    let mut f = Fixture::configured(&server, &[], "", |config| {
        let tools = config["tools"].as_array_mut().unwrap();
        tools.retain(|tool| tool["name"] != "Shell");
        let mut shell = tools
            .iter()
            .find(|tool| tool["name"] == "Read")
            .unwrap()
            .clone();
        shell["name"] = json!("Shell");
        tools.push(shell);
    })
    .await;
    let dir = f.rig.directory.path().join("workspace/notes");
    tokio::fs::create_dir(&dir).await.unwrap();
    for n in 1..=18 {
        tokio::fs::write(dir.join(format!("{n}.txt")), format!("source {n}"))
            .await
            .unwrap();
    }
    let task = f
        .create_scheduled(
            "Map notes",
            "",
            json!({"kind":"interval","everySeconds":3600,"startAt":at().0 + 3_600_000}),
        )
        .await;
    f.change(&task, "trigger_now").await;
    let mut worker = None;
    for step in 1..=18 {
        let (turn, request) = next(&mut server).await;
        if step == 1 {
            worker = Some(f.active_worker());
            let prompt = request["messages"].to_string();
            assert!(prompt.contains("first 2–4 steps") && prompt.contains("upsert_sources"));
        }
        let names = model_tool_names(&request);
        for name in [
            "Shell",
            "UpdateWorkspaceMap",
            "UpsertDossier",
            "FinishNoChange",
        ] {
            assert!(names.contains(&name));
        }
        let mut plan = TurnPlan::new().push_tool_call(
            format!("shell-{step}"),
            "Shell",
            json!({"path":format!("notes/{step}.txt")}),
        );
        match step {
            3 => plan = plan.push_tool_call("checkpoint", "UpdateWorkspaceMap", json!({"action":"upsert_sources","sources":[{"path":"notes","summary":"Project notes"}]})),
            16 => plan = plan.push_tool_call("save-dossier", "UpsertDossier", json!({"topic_id":"notes","expected_revision":0,"title":"Project notes","signal":"yellow","priority_weight":1,"summary_md":"Review pending","notify_intent":{"kind":"quiet"}})),
            18 => plan = plan.push_tool_call("map-ready", "UpdateWorkspaceMap", json!({"action":"mark_ready"})),
            _ => (),
        }
        turn.send_plan(
            plan.with_usage(Usage::new(100, 10))
                .finish(FinishReason::ToolCalls),
        );
    }
    let detail = f.settled(&task, 1).await;
    assert_eq!(detail["task"]["runs"][0]["outcome"], "ok");
    assert_eq!(
        detail["task"]["runs"][0]["message"],
        "Discovery reached its step limit"
    );
    let run_id = f
        .owner()
        .durable
        .latest_run(worker.unwrap())
        .await
        .unwrap()
        .unwrap();
    let view = f
        .owner()
        .durable
        .find_run_full(run_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(view.steps.len(), 18);
    for n in 1..=18 {
        let id = format!("shell-{n}");
        let call = view.tools.values().find(|t| t.call.id == id).unwrap();
        let outcome = &call.accepted.as_ref().unwrap().outcome;
        if n <= 14 {
            assert_eq!(outcome, &AcceptedResult::Succeeded);
        } else {
            assert_eq!(outcome, &AcceptedResult::Rejected);
            let Some(ToolDecision::Rejected { rejection, .. }) = &call.decision else {
                panic!("missing Shell rejection at step {n}")
            };
            assert!(
                rejection
                    .to_string()
                    .contains(&format!("remaining step budget is {}.", 19 - n))
            );
        }
    }
    f.reopen().await;
    assert_eq!(
        f.query("dossier", json!({"topicId":"notes"})).await["revision"],
        1
    );
    f.send("Inspect the workspace map", json!([])).await;
    let (bot, _) = next(&mut server).await;
    tool(bot, "UpdateWorkspaceMap", json!({"action":"inspect"}));
    let (bot, request) = next(&mut server).await;
    let map = output(&request);
    assert_eq!(map["phase"], "ready");
    assert_eq!(map["sources"][0]["summary"], "Project notes");
    quiet(&f, &mut server, bot).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_file_drop_in_another_authorized_root_wakes_only_an_active_plan() {
    let mut server = MockAiBuilder::new().interactive(16).start().await.unwrap();
    let mut f = Fixture::with_tools(&server, &[session_read_tool()]).await;
    let task = f.create_scheduled("Review new arrivals", "", json!({"kind":"interval","everySeconds":3600,"startAt":maka_agent_authority::now()+3_600_000})).await;
    f.change(&task, "pause").await;
    let (room, posted) = f.quiet_room("Contract review").await;
    let owner = f.owner();
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
    let effect = &paused["task"]["effect"];
    let names = f.preview(effect, Some(&task)).await;
    let due = at().0 + 8_000;
    let resumed = f
        .query(
            "schedule",
            json!({"kind":"approve","taskId":task,"revision":paused["revision"],
                "input":{"task":{"title":"Review new arrivals","intentBody":"","effect":effect,
                    "schedule":{"kind":"interval","everySeconds":1800,"startAt":due,"cadence":"after_completion"}},
                    "timezone":"UTC","misfire":"latest","approvedTools":names}}),
        )
        .await;
    assert_eq!(resumed["kind"], "committed", "{resumed}");
    let (worker, request) = next(&mut server).await;
    let messages = request["messages"].to_string();
    assert!(
        messages.contains("terms.pdf") && messages.contains("created"),
        "{messages}"
    );
    assert!(messages.contains("Sessions [kind,session_id,title,ms]") && messages.contains(&room));
    assert_eq!(
        state
            .session_explored_at(std::slice::from_ref(&room))
            .await
            .unwrap()[&room],
        posted.0
    );

    let until_due = due.saturating_sub(at().0).max(0) as u64;
    tokio::time::sleep(Duration::from_millis(until_due)).await;
    tool(
        worker,
        "FinishNoChange",
        json!({"note":"Reviewed the new file"}),
    );
    assert_eq!(
        f.settled(&task, 1).await["task"]["runs"][0]["outcome"],
        "ok"
    );
    assert!(!state.has_ready_changes(at()).await.unwrap());
    // The preserved timer can perform the initial onboarding independently of the file fire.
    let (onboard, request) = next(&mut server).await;
    assert!(request["messages"].to_string().contains("Onboard"));
    tool(
        onboard,
        "UpdateWorkspaceMap",
        json!({"action":"mark_ready"}),
    );
    let (onboard, _) = next(&mut server).await;
    tool(onboard, "FinishNoChange", json!({"note":"Ready"}));
    f.settled(&task, 2).await;
    assert_bot_untouched(&f).await;
    drop(owner);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_file_change_waits_for_cooldown_and_drains_only_displayed_rows() {
    use maka_agent_facts::discovery::SourceUri;
    use maka_agent_state::discovery::changes::ChangeQuery;
    use maka_scheduler::plan::FireSource;

    let mut server = MockAiBuilder::new().interactive(16).start().await.unwrap();
    let project = ".gemini/antigravity/scratch/app";
    let mut f = Fixture::configured(&server, &[], project, |_| {}).await;
    let task = f
        .create_scheduled(
            "Review incoming files",
            "Review the changes",
            json!({"kind":"interval","everySeconds":10,"startAt":at().0 + 3_600_000}),
        )
        .await;
    let home = tokio::fs::canonicalize(f.rig.directory.path().join("workspace"))
        .await
        .unwrap();
    let home = Path::new(maka_fs_tools::workspace::project::host_path(&home).unwrap());
    let project = home.join(project);
    let outside = home.join("Downloads/other.txt");
    let noise = home.join(".gemini/antigravity/brain/state");
    let files: Vec<_> = (0..25)
        .map(|i| project.join(format!("busy/section-{i}/spec.md")))
        .collect();
    for path in files.iter().chain([&outside, &noise]) {
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
    }
    f.reopen().await;
    f.change(&task, "trigger_now").await;
    let (first, _) = next(&mut server).await;
    for path in [&outside, &noise].into_iter().chain(&files) {
        tokio::fs::write(path, "updated terms").await.unwrap();
    }
    let owner = f.owner();
    let ready = || {
        owner
            .discovery
            .change_snapshot(at(), ChangeQuery::opening(64, home), |_, _| true)
    };
    tokio::time::timeout(Duration::from_secs(40), async {
        let mut poll = tokio::time::interval(Duration::from_millis(100));
        loop {
            poll.tick().await;
            let changes = ready().await.unwrap().into_deltas();
            if changes
                .iter()
                .filter(|d| Path::new(&d.path).starts_with(&project))
                .count()
                == 25
                && changes.iter().any(|d| Path::new(&d.path) == outside)
            {
                break;
            }
        }
    })
    .await
    .expect("watcher did not debounce the project burst and the separate Downloads change");
    assert!(
        owner
            .discovery
            .get_source_cursor(SourceUri(noise.to_str().unwrap().into()))
            .await
            .unwrap()
            .is_none()
    );

    tool(
        first,
        "FinishNoChange",
        json!({"note":"First review complete"}),
    );
    let last = f.settled(&task, 1).await["task"]["lastFireAt"]
        .as_i64()
        .unwrap();
    let (second, request) = next(&mut server).await;
    let fire = owner
        .scheduler
        .change_basis(&task)
        .await
        .unwrap()
        .unwrap()
        .plan
        .pending
        .unwrap();
    assert_eq!(fire.source, FireSource::FileChange);
    assert!(
        fire.scheduled_at >= last + 5_000,
        "early file wake after {} ms",
        fire.scheduled_at - last
    );
    let opening = request["messages"].to_string();
    assert_eq!(opening.matches("spec.md").count(), 2, "{opening}");
    assert!(
        opening.contains("busy") && opening.contains("25") && !opening.contains("other.txt"),
        "{opening}"
    );
    tool(
        second,
        "FinishNoChange",
        json!({"note":"Reviewed the project"}),
    );
    f.settled(&task, 2).await;
    let remaining = ready().await.unwrap().into_deltas();
    assert_eq!(remaining.len(), 1);
    assert_eq!(Path::new(&remaining[0].path), outside);
    drop(owner);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_code_mode_counts_new_files_read_inside_cells() {
    let mut server = MockAiBuilder::new().interactive(16).start().await.unwrap();
    let mut f=Fixture::with_tools(&server,&[json!({
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
    for n in 0..15 {
        tokio::fs::write(dir.join(format!("part-{n}")), "same text")
            .await
            .unwrap();
    }
    let task = f.create("Check each part").await;
    f.change(&task, "trigger_now").await;
    let (mut worker, _) = next(&mut server).await;
    for n in 0..15 {
        tool(
            worker,
            "exec",
            json!({"code":format!("const page = await tools.ReadPart({{path:'part-{n}'}}); text(page.value.content);"),"yield_time_ms":30000}),
        );
        let (socket, request) = next(&mut server).await;
        worker = socket;
        let last = output(&request).to_string();
        assert_eq!(
            last.contains("remaining step budget"),
            n == 11 || n >= 13,
            "{last}"
        );
        assert!(
            (last.contains("same text") == (n < 14)) && !last.contains("Wrap up immediately"),
            "{last}"
        );
    }
    tool(
        worker,
        "FinishNoChange",
        json!({"note":"Checked each part"}),
    );
    assert_eq!(
        f.settled(&task, 1).await["task"]["runs"][0]["outcome"],
        "ok"
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_staged_receipt_attaches_verbatim_and_preview_checks_the_dossier_and_bytes() {
    use sha2::{Digest, Sha256};
    let mut server = MockAiBuilder::new().interactive(16).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
    let task = f.create("Prepare a draft").await;
    f.change(&task, "trigger_now").await;
    let (worker, request) = next(&mut server).await;
    assert!(!model_tool_names(&request).contains(&"UpdateDiscoveryPreferences"));
    let input = json!({"topic_id":"terms","relative_path":"notes/annex.diff","content":"+ 合同\n","purpose":"Review the clause","input_paths":["discovery.txt","missing.txt"]});
    let mut outside = input.clone();
    outside["input_paths"] = json!(["../other-workspace/terms"]);
    tool(worker, "StageArtifact", outside);
    let (worker, rejected) = next(&mut server).await;
    assert!(
        output(&rejected)
            .to_string()
            .contains("outside authorized workspace"),
        "{rejected}"
    );
    tool(worker, "StageArtifact", input);
    let (worker, staged) = next(&mut server).await;
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
    let (worker, committed) = worker_upsert(&mut server, worker, json!({
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
    tool(worker, "FinishNoChange", json!({"note":"Draft attached"}));
    f.settled(&task, 1).await;
    drop(state);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_due_frontier_targets_wander_and_manual_followups_keep_dossier_context() {
    let mut server = MockAiBuilder::new().interactive(32).start().await.unwrap();
    let mut f = Fixture::with_tools(&server, &[session_read_tool()]).await;
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
    let (thread, req) = next(&mut server).await;
    assert!(req["messages"].to_string().contains(topic));
    assert!(model_tool_names(&req).contains(&"UpdateWatchScope"));
    tool(
        thread,
        "UpdateDiscoveryPreferences",
        json!({"mode":"append","rule":"周五再提醒"}),
    );
    let (thread, req) = next(&mut server).await;
    assert_eq!(output(&req)["updated"], true, "{}", output(&req));
    let mut draft = json!({"topic_id":"other-topic","relative_path":"draft.md","content":"Dossier draft","purpose":"For review"});
    tool(thread, "StageArtifact", draft.clone());
    let (thread, req) = next(&mut server).await;
    assert!(output(&req).to_string().contains("discovery_wrong_topic"));
    draft["topic_id"] = json!(topic);
    tool(thread, "StageArtifact", draft);
    let (thread, req) = next(&mut server).await;
    assert_eq!(output(&req)["path"], "draft.md");
    thread.reply_text("Saved.");
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

    f.query("openDossierThread", json!({"topicId":topic,"elevate":true}))
        .await;
    f.query(
        "create",
        json!({
            "title":"Shipment timing discussion","automaticTitle":false,"labels":[],
            "workspace":{"kind":"directory","path":f.rig.directory.path().join("workspace")}
        }),
    )
    .await;

    f.send("Save my discovery preference", json!([])).await;
    let (bot, req) = next(&mut server).await;
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
        bot,
        "UpdateWatchScope",
        json!({"action":"add_exclude","path":"generated","reason":"Build outputs"}),
    );
    let (bot, req) = next(&mut server).await;
    assert_eq!(output(&req)["updated"], true, "{}", output(&req));
    tool(
        bot,
        "UpdateDiscoveryPreferences",
        json!({"mode":"replace","rule":"Skip subtitle tracking"}),
    );
    let (bot, req) = next(&mut server).await;
    assert_eq!(output(&req)["updated"], true, "{}", output(&req));
    quiet(&f, &mut server, bot).await;
    let cold = f.rig.directory.path().join("workspace/cold");
    tokio::fs::create_dir(&cold).await.unwrap();
    let hour = 3_600_000;
    // Exercise the due map frontier after the earlier human Bot turn ages out of discovery.
    let due = at().0 + 25 * hour;
    let broad = f
        .create_scheduled(
            "Broad discovery",
            "",
            json!({"kind":"interval","everySeconds":3600,"startAt":due}),
        )
        .await;
    f.owner().tick_schedules_at(due).await.unwrap();
    let (onboard, req) = next(&mut server).await;
    let opening = req["messages"].to_string();
    assert!(opening.contains("Onboard") && opening.contains("Shipment timing discussion"));
    assert!(!opening.contains("Existing dossier marker"));
    tool(
        onboard,
        "UpdateWorkspaceMap",
        json!({"action":"record_frontier","branches":[
            {"path":"cold","reason":"Check release manifest","next_probe_after":due+2*hour}
        ]}),
    );
    let (onboard, req) = next(&mut server).await;
    assert_eq!(output(&req)["phase"], "scanning");
    tool(
        onboard,
        "FinishNoChange",
        json!({"note":"Saved map checkpoint"}),
    );
    f.settled(&broad, 1).await;
    f.reopen().await;
    f.owner().tick_schedules_at(due + hour).await.unwrap();
    let (onboard, req) = next(&mut server).await;
    let resumed = req["messages"].to_string();
    assert!(resumed.contains("Onboard") && resumed.contains("Check release manifest"));
    tool(
        onboard,
        "UpdateWorkspaceMap",
        json!({"action":"mark_ready","frontier":[
            {"path":"discovery.txt","reason":"Check separate release note","next_probe_after":due+2*hour}
        ]}),
    );
    let (onboard, req) = next(&mut server).await;
    assert_eq!(output(&req)["phase"], "ready");
    tool(
        onboard,
        "FinishNoChange",
        json!({"note":"Mapped workspace"}),
    );
    f.settled(&broad, 2).await;
    f.owner().tick_schedules_at(due + 2 * hour).await.unwrap();
    let (worker, req) = next(&mut server).await;
    let opening = req["messages"].to_string();
    assert!(
        opening.contains("Cold starting points") && opening.contains("Check release manifest"),
        "{opening}"
    );
    assert!(
        !opening.contains("Existing dossier marker")
            && !opening.contains("Check separate release note")
    );
    assert!(opening.contains("Shipment timing discussion"));
    let names = model_tool_names(&req);
    assert!(names.contains(&"UpdateWorkspaceMap") && !names.contains(&"UpdateWatchScope"));
    assert_eq!(f.active_token_budget().await, Some(1_500_000));
    let finding = json!({"topic_id":"cold-brief","title":"Cold brief","signal":"yellow","priority_weight":1.0,
        "summary_md":"Cross-checked the cold brief","expected_revision":0,"notify_intent":{"kind":"quiet"}});
    let (worker, refused) = worker_upsert(&mut server, worker, finding.clone()).await;
    assert!(
        refused
            .to_string()
            .contains("Call ListDossiers before committing")
    );
    tool(worker, "ListDossiers", json!({}));
    let (worker, list) = next(&mut server).await;
    assert!(output(&list).to_string().contains(topic));
    let (worker, saved) = worker_upsert(&mut server, worker, finding).await;
    assert_eq!(saved["revision"], 1);
    tool(
        worker,
        "UpdateWorkspaceMap",
        json!({"action":"mark_verified","paths":["cold"],"material_finding":true}),
    );
    let (worker, _) = next(&mut server).await;
    tool(
        worker,
        "FinishNoChange",
        json!({"note":"Checked mapped source"}),
    );
    f.settled(&broad, 3).await;
    f.change(&broad, "trigger_now").await;
    let (worker, req) = next(&mut server).await;
    let opening = req["messages"].to_string();
    assert!(!model_tool_names(&req).iter().any(|name| matches!(
        *name,
        "UpdateWorkspaceMap" | "UpdateWatchScope" | "DiscoveryComplete"
    )));
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
    tool(worker, "FinishNoChange", json!({"note":"Checked"}));
    f.settled(&broad, 4).await;
    f.send("Hello again", json!([])).await;
    let (bot, req) = next(&mut server).await;
    assert_eq!(prefix, system(&req));
    quiet(&f, &mut server, bot).await;
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_twelve_idle_hours_after_onboarding_create_no_workers_calls_tokens_or_revisions()
{
    let mut server = MockAiBuilder::new().interactive(16).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
    const HOUR: i64 = 3_600_000;
    let due = (at().0.div_euclid(24 * HOUR) + 1) * 24 * HOUR + HOUR;
    let plan = f
        .create_scheduled(
            "Hourly discovery",
            "",
            json!({"kind":"interval","everySeconds":3600,"startAt":due}),
        )
        .await;
    f.owner().tick_schedules_at(due).await.unwrap();
    let (onboard, request) = next(&mut server).await;
    assert!(request["messages"].to_string().contains("Onboard"));
    assert_eq!(f.active_token_budget().await, Some(1_500_000));
    finish_with_usage(onboard, Usage::new(0, 1_000_000));
    f.settled(&plan, 1).await;
    let first = f.owner().discovery.plan_activity(&plan).await.unwrap();
    assert_eq!((first.tokens, first.last_run_at), (4_000_000, due));

    let due = due + HOUR;
    f.owner().tick_schedules_at(due).await.unwrap();
    let (onboard, request) = next(&mut server).await;
    assert!(request["messages"].to_string().contains("Onboard"));
    assert_eq!(f.active_token_budget().await, Some(1_500_000));
    let mut finding = json!({"topic_id":"release","expected_revision":0,"title":"Release approval","signal":"yellow",
        "priority_weight":1.0,"fact_state":"Approval pending","summary_md":"Awaiting release approval","notify_intent":{"kind":"quiet"}});
    let (onboard, saved) = worker_upsert(&mut server, onboard, finding.clone()).await;
    assert_eq!(saved["revision"], 1);
    tool(
        onboard,
        "UpdateWorkspaceMap",
        json!({"action":"mark_ready"}),
    );
    let (onboard, _) = next(&mut server).await;
    finish_with_usage(
        onboard,
        Usage::new(200_000, 3_000)
            .with_cache_read(180_000)
            .with_cache_creation(15_000)
            .with_reasoning(2_000),
    );
    f.settled(&plan, 2).await;
    let initial = f.owner().discovery.plan_activity(&plan).await.unwrap();

    assert_eq!(initial.tokens, 4_000_000 + 2 * 140 + 50_000);
    assert_eq!(initial.last_run_at, due);
    for hour in 1..=12 {
        if hour == 7 {
            f.reopen().await;
        }
        f.owner()
            .tick_schedules_at(due + hour * HOUR)
            .await
            .unwrap();
    }
    let detail = f.detail(&plan).await;
    assert!(detail["pendingFire"].is_null());
    assert_eq!(detail["task"]["nextFireAt"], due + 13 * HOUR);
    assert_eq!(detail["task"]["fireCount"], 2);
    assert_eq!(f.worker_count().await, 2);
    let idle = f.owner().discovery.plan_activity(&plan).await.unwrap();
    assert_eq!(
        (idle.skipped, idle.model_runs, idle.revised, idle.notified),
        (12, 2, 1, 0)
    );
    assert_eq!(idle.tokens, initial.tokens);
    assert_eq!(
        f.query("dossier", json!({"topicId":"release"})).await["revisions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), server.next_turn())
            .await
            .is_err()
    );

    f.change(&plan, "trigger_now").await;
    let (manual, _) = next(&mut server).await;
    assert_eq!(f.active_token_budget().await, Some(1_500_000));
    finding["expected_revision"] = json!(1);
    finding["summary_md"] = json!("Release approval is still pending");
    let (manual, receipt) = worker_upsert(&mut server, manual, finding).await;
    assert_eq!(receipt["material_change"], false);
    tool(manual, "FinishNoChange", json!({"note":"Reviewed"}));
    assert_eq!(
        f.settled(&plan, 3).await["task"]["runs"][0]["message"],
        "No report"
    );
    let manual = f.owner().discovery.plan_activity(&plan).await.unwrap();
    assert_eq!(manual.tokens, idle.tokens + 2 * 140);
    assert_eq!((manual.model_runs, manual.deferred), (3, 0));
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_daily_budget_defers_original_fire_without_consuming_deltas() {
    use maka_agent_state::discovery::changes::{FileWrite, Fingerprint, ProbeResult, WriteKind};
    let mut server = MockAiBuilder::new().interactive(16).start().await.unwrap();
    let mut f = Fixture::new(&server).await;
    const HOUR: i64 = 3_600_000;
    const DAY: i64 = 24 * HOUR;
    let due = (at().0.div_euclid(DAY) + 1) * DAY + HOUR;
    let task = f.create_scheduled("Daily digest", "Prepare a briefing",
        json!({"kind":"interval","everySeconds":3600,"startAt":due,"cadence":"after_completion"})).await;
    let state = f.owner().discovery.clone();
    f.owner().tick_schedules_at(due).await.unwrap();
    let (worker, _) = next(&mut server).await;
    assert_eq!(f.active_token_budget().await, Some(1_500_000));
    finish_with_usage(worker, Usage::new(0, 500_000));
    f.settled(&task, 1).await;

    for (n, (spent, interval, output_tokens)) in [
        (2_000_000, 2 * HOUR, 300_000),
        (3_200_000, 4 * HOUR, 200_000),
    ]
    .into_iter()
    .enumerate()
    {
        let meter = state.plan_activity(&task).await.unwrap();
        assert_eq!(meter.tokens, spent);
        let next_due = f.detail(&task).await["task"]["nextFireAt"]
            .as_i64()
            .unwrap();
        let until = meter.last_run_at + interval;
        assert!(next_due < until);
        f.owner().tick_schedules_at(next_due).await.unwrap();
        let pending = f
            .owner()
            .scheduler
            .change_basis(&task)
            .await
            .unwrap()
            .unwrap()
            .plan
            .pending
            .unwrap();
        assert_eq!(pending.deferred_until, Some(until));
        f.owner().tick_schedules_at(until - 1).await.unwrap();
        assert_eq!(f.worker_count().await, n + 1);
        f.owner().tick_schedules_at(until).await.unwrap();
        let (worker, _) = next(&mut server).await;
        // At 80% only 800,000 weighted tokens remain, but the engine still gets its full raw allowance.
        assert_eq!(f.active_token_budget().await, Some(1_500_000));
        finish_with_usage(worker, Usage::new(0, output_tokens));
        let detail = f.settled(&task, n + 2).await;
        assert_eq!(detail["task"]["runs"][0]["id"], pending.id);
        assert_eq!(detail["task"]["runs"][0]["outcome"], "ok");
    }
    let when = at();
    let path = f
        .owner()
        .session(&f.bot)
        .await
        .unwrap()
        .configuration
        .workspace
        .path;
    state
        .observe_writes(
            vec![FileWrite {
                path: format!("{path}/discovery.txt"),
                kind: WriteKind::Modified,
                at: when,
            }],
            0,
            100,
            100,
        )
        .await
        .unwrap();
    let probes = state.due_probes(when, 100).await.unwrap();
    assert!(!probes.is_empty());
    state
        .finish_probes(
            probes
                .into_iter()
                .map(|p| {
                    (
                        p,
                        ProbeResult::Stable(Fingerprint {
                            mtime: when,
                            hash: "new".into(),
                        }),
                    )
                })
                .collect(),
        )
        .await
        .unwrap();

    {
        use maka_scheduler::plan::FireSource;
        let owner = f.owner();
        let _gate = owner.scheduler.gate.lock().await;
        let mut catalog = owner.scheduler.load().await.unwrap();
        let mut plan = catalog.plans[&task].plan.clone();
        plan.claim_preserving_schedule(when.0, FireSource::FileChange)
            .unwrap()
            .unwrap();
        owner
            .scheduler
            .commit(&mut catalog, &task, Some(plan), None)
            .await
            .unwrap();
    }
    f.owner().tick_schedules_at(when.0).await.unwrap();
    let pending = f
        .owner()
        .scheduler
        .change_basis(&task)
        .await
        .unwrap()
        .unwrap()
        .plan
        .pending
        .unwrap();
    let midnight = (due.div_euclid(DAY) + 1) * DAY;
    assert_eq!(pending.deferred_until, Some(midnight));
    let activity = state.plan_activity(&task).await.unwrap();
    assert_eq!(
        (activity.model_runs, activity.tokens, activity.deferred),
        (3, 4_000_000, 3)
    );
    assert!(state.has_ready_changes(when).await.unwrap());
    assert_eq!(f.worker_count().await, 3);
    drop(state);
    f.reopen().await;
    f.owner().tick_schedules_at(midnight - 1).await.unwrap();
    assert_eq!(f.worker_count().await, 3);
    f.owner().tick_schedules_at(midnight).await.unwrap();
    let (worker, request) = next(&mut server).await;
    assert!(request["messages"].to_string().contains("discovery.txt"));
    assert_eq!(f.active_token_budget().await, Some(1_500_000));
    tool(
        worker,
        "FinishNoChange",
        json!({"note":"Reviewed after reset"}),
    );
    assert_eq!(
        f.settled(&task, 4).await["task"]["runs"][0]["id"],
        pending.id
    );
    assert!(!f.owner().discovery.has_ready_changes(when).await.unwrap());
    let reset = f.owner().discovery.plan_activity(&task).await.unwrap();
    assert_eq!(
        (reset.day, reset.tokens, reset.model_runs),
        (midnight.div_euclid(DAY), 140, 4)
    );
    f.close().await;
}

mod guards;
