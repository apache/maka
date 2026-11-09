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

async fn cancelled(fixture: &Fixture, listener: &TcpListener, session: &str) -> Value {
    let sent = fixture.send(session).await.unwrap();
    let run = fixture.delivered_run(&sent).await;
    let (mut socket, _) = listener.accept().await.unwrap();
    request(&mut socket).await;
    let stopped = fixture
        .mutation(
            2,
            "stop",
            json!({
                "sessionId":session, "runId":run
            }),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
    assert_eq!(stopped["requested"], true);
    fixture.drained().await;
    let read = fixture
        .query(
            "execution",
            json!({
                "sessionId":session, "runId":run
            }),
        )
        .await
        .unwrap();
    assert_eq!(read["execution"]["state"]["kind"], "cancelled");
    read["execution"].clone()
}
async fn continuation_input(fixture: &Fixture, source: &Value) -> Value {
    json!({"sessionId":source["sessionId"], "sourceRunId":source["runId"],
        "sourceHighWater":source["highWater"], "model":fixture.selection().await})
}

#[tokio::test]
async fn exact_receipt_resumes_original_input_and_deduplicates_after_prerequisites_disappear() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::new(&format!("http://{}/v1", listener.local_addr().unwrap()), None).await;
        let session = fixture.create("Resume original").await;
        let source = cancelled(&fixture, &listener, &session).await;
        let history=fixture.history(&session);
        let run=serde_json::from_value(source["runId"].clone()).unwrap();
        let original=history.run_source(run).await.unwrap();
        let input_bytes=history.content(run,&original.spec.input).await.unwrap();
        let maka_agent_facts::input::RunInput::Message{source_messages,..}=serde_json::from_slice(&input_bytes).unwrap() else{panic!("original message")};
        let message = source_messages[0].message.message_id.clone();
        let original_work = fixture.query("work",json!({"sessionId":session,"target":{"kind":"run","runId":run}})).await.unwrap();
        let original_delivery = fixture.query("work",json!({"sessionId":session,"target":{"kind":"message","messageId":message}})).await.unwrap();
        assert_eq!(original_work["kind"], "delivered");
        assert_eq!(original_work["execution"], source);
        assert_eq!(original_work["answer"], Value::Null);
        assert_eq!(original_delivery, original_work);

        let later = fixture.mutation(2, "send", json!({"sessionId":session, "message":"Later separate request", "backend":model_backend(&fixture.selection().await)}), Uuid::new_v4()).await.unwrap();
        let later_run=fixture.delivered_run(&later).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response(&mut socket).await;
        fixture.drained().await;
        let read = fixture.query("execution", json!({"sessionId":session,"runId":source["runId"]})).await.unwrap();
        assert_eq!(read["execution"], source, "exact receipt must not become the Session tip");
        let other = fixture.create("Other session").await;
        assert_eq!(fixture.query("execution", json!({"sessionId":other,"runId":source["runId"]})).await.unwrap(), json!({"kind":"missing"}));
        assert!(fixture.query("execution", json!({"sessionId":"foreign","runId":source["runId"]})).await.is_err());
        let input = continuation_input(&fixture, &source).await;
        let operation = Uuid::new_v4();
        let prepared = fixture.app.client().prepare_mutation(fixture.binding(2).await, "continueRun".into(), input.clone(), scope(&fixture.issuer, true), operation, Attachments::new().into()).await.unwrap();
        assert_eq!(prepared.reference().operation,operation);
        drop(prepared);
        let resumed = fixture.mutation(2, "continueRun", input.clone(), operation).await.unwrap();
        assert_eq!(resumed["kind"], "started", "{resumed}");
        let execution = &resumed["execution"];
        assert_ne!(execution["runId"], source["runId"]);
        assert_ne!(execution["runId"],serde_json::to_value(later_run).unwrap());
        let (mut socket, _) = listener.accept().await.unwrap();
        let replay = request(&mut socket).await;
        assert!(replay["messages"].as_array().unwrap().iter().any(|message| message["content"] == "Hello"));
        assert!(!replay.to_string().contains("Later separate request"));
        response(&mut socket).await;
        fixture.drained().await;
        let duplicate = fixture.mutation(2, "continueRun", input.clone(), operation).await.unwrap();
        assert_eq!(duplicate, resumed, "operation journal returns original reply");
        let second = fixture.mutation(2, "continueRun", input.clone(), Uuid::new_v4()).await.unwrap();
        assert_eq!(second, json!({"kind":"rejected","reason":"already_continued"}));
        let selected = fixture.config.catalog().await.unwrap().connections.remove(0);
        assert!(matches!(fixture.config.remove_connection(RemoveCatalogConnectionInput {
            expected: ConnectionVersionBasis { connection_id: selected.connection_id, revision: selected.revision },
        }).await.unwrap(), CatalogMutationResult::Committed { .. }));
        fixture.store.set_session_archived::<StoredSessionConfiguration>(&session, true, now()).await.unwrap();
        std::fs::rename(&fixture.workspace, fixture.workspace.with_extension("removed")).unwrap();
        let accepted=fixture.mutation(2,"continueRun",input,operation).await.unwrap();
        assert_eq!(accepted,resumed,"original SDK receipt survives unavailable admission prerequisites");
        let accepted=fixture.query("execution",json!({"sessionId":session,"runId":execution["runId"]})).await.unwrap();
        assert_eq!(accepted["execution"]["runId"], execution["runId"]);
        assert_eq!(accepted["execution"]["state"]["kind"], "completed");
        let delivery = fixture.query("work",json!({"sessionId":session,"target":{"kind":"message","messageId":message}})).await.unwrap();
        assert_eq!(delivery["kind"],"delivered");
        assert_eq!(delivery["shared"],false);
        assert_eq!(delivery, original_delivery, "original message delivery never redirects to a continuation or unrelated Run");
        let source_work = fixture.query("work",json!({"sessionId":session,"target":{"kind":"run","runId":source["runId"]}})).await.unwrap();
        assert_eq!(source_work, original_work, "source Run work and its original cancelled answer remain immutable");
        assert_eq!(source_work["execution"], source);
        let continued_work = fixture.query("work",json!({"sessionId":session,"target":{"kind":"run","runId":execution["runId"]}})).await.unwrap();
        assert_eq!(continued_work["execution"], accepted["execution"]);
        assert_eq!(continued_work["answer"]["text"], "Elegant response");
        let unrelated_work = fixture.query("work",json!({"sessionId":session,"target":{"kind":"run","runId":later_run}})).await.unwrap();
        assert_eq!(unrelated_work["execution"]["runId"], serde_json::to_value(later_run).unwrap());
        assert_eq!(unrelated_work["answer"]["text"], "Elegant response");
        assert_eq!(fixture.query("execution",json!({"sessionId":session,"runId":source["runId"]})).await.unwrap()["execution"],source);
        assert_eq!(fixture.query("work",json!({"sessionId":session,"target":{"kind":"run","runId":execution["runId"]},"cursor":{"runId":source["runId"],"offset":9000}})).await.unwrap(),json!({"kind":"changed"}),"source cursor must be rejected before applying its offset to the new target Run");


        assert!(tokio::time::timeout(Duration::from_millis(30), listener.accept()).await.is_err(), "no second model request");
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn continuation_rejects_stale_foreign_busy_sources_and_accepts_completed_sources() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::new(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
        )
        .await;
        let session = fixture.create("Resume fences").await;
        let source = cancelled(&fixture, &listener, &session).await;
        let input = continuation_input(&fixture, &source).await;
        for (field, value, reason) in [
            (
                "sourceHighWater",
                json!(source["highWater"].as_u64().unwrap() + 1),
                "source_changed",
            ),
            (
                "sourceRunId",
                json!(maka_agent_facts::durable::RunId::new()),
                "source_missing",
            ),
            (
                "sessionId",
                json!(fixture.create("Other").await),
                "source_missing",
            ),
        ] {
            let mut invalid = input.clone();
            invalid[field] = value;
            assert_eq!(
                fixture
                    .mutation(2, "continueRun", invalid, Uuid::new_v4())
                    .await
                    .unwrap(),
                json!({"kind":"rejected","reason":reason})
            );
        }
        let source_query = json!({"sessionId":session,"runId":source["runId"]});
        assert_eq!(
            fixture
                .query("continuationAvailability", source_query.clone())
                .await
                .unwrap(),
            json!({"kind":"ready","source":source})
        );
        let active = fixture.send(&session).await.unwrap();
        let active_run = fixture.delivered_run(&active).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        assert_eq!(
            fixture
                .query(
                    "continuationAvailability",
                    json!({"sessionId":session,"runId":active_run})
                )
                .await
                .unwrap(),
            json!({"kind":"rejected","reason":"source_not_terminal"})
        );
        assert_eq!(
            fixture
                .query("continuationAvailability", source_query)
                .await
                .unwrap(),
            json!({"kind":"rejected","reason":"busy"})
        );
        assert_eq!(
            fixture
                .mutation(2, "continueRun", input.clone(), Uuid::new_v4())
                .await
                .unwrap(),
            json!({"kind":"rejected","reason":"busy"})
        );
        response(&mut socket).await;
        fixture.drained().await;
        let completed = fixture
            .query("execution", json!({"sessionId":session,"runId":active_run}))
            .await
            .unwrap();
        assert_eq!(completed["execution"]["state"]["kind"], "completed");
        let history = fixture.history(&session);
        assert_eq!(
            history.successor(active_run).await.unwrap(),
            None,
            "completion must not automatically continue a Run"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(30), listener.accept())
                .await
                .is_err(),
            "completion must not start another provider request"
        );
        let completed_query = json!({"sessionId":session,"runId":active_run});
        assert_eq!(
            fixture
                .query("continuationAvailability", completed_query.clone())
                .await
                .unwrap(),
            json!({"kind":"ready","source":completed["execution"]})
        );
        let completed_input = continuation_input(&fixture, &completed["execution"]).await;
        let continued = fixture
            .mutation(2, "continueRun", completed_input.clone(), Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(continued["kind"], "started", "{continued}");
        assert_ne!(
            continued["execution"]["runId"],
            completed["execution"]["runId"]
        );
        assert_ne!(
            continued["execution"]["turnId"],
            completed["execution"]["turnId"]
        );
        let continued_run: maka_agent_facts::durable::RunId =
            serde_json::from_value(continued["execution"]["runId"].clone()).unwrap();
        assert_eq!(
            history.successor(active_run).await.unwrap(),
            Some(continued_run)
        );
        let (mut continued_socket, _) = listener.accept().await.unwrap();
        let outgoing = request(&mut continued_socket).await;
        assert!(
            outgoing["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| message["content"] == "Hello")
        );
        response(&mut continued_socket).await;
        fixture.drained().await;
        let continued_work = fixture
            .query(
                "work",
                json!({"sessionId":session,"target":{"kind":"run","runId":continued_run}}),
            )
            .await
            .unwrap();
        assert_eq!(
            continued_work["execution"]["runId"],
            continued["execution"]["runId"]
        );
        assert_eq!(continued_work["execution"]["state"]["kind"], "completed");
        assert_eq!(continued_work["answer"]["text"], "Elegant response");
        assert_eq!(
            fixture
                .query("execution", completed_query.clone())
                .await
                .unwrap(),
            completed,
            "manual continuation must not reopen or mutate the completed source"
        );
        assert_eq!(
            fixture
                .query("continuationAvailability", completed_query)
                .await
                .unwrap(),
            json!({"kind":"rejected","reason":"already_continued"})
        );
        assert_eq!(
            fixture
                .mutation(2, "continueRun", completed_input, Uuid::new_v4())
                .await
                .unwrap(),
            json!({"kind":"rejected","reason":"already_continued"})
        );
        let facts = fixture.recorded_facts(&session).await;
        for run in [active_run, continued_run] {
            assert_eq!(
                facts.iter().filter(|record|record.run == run && matches!(&record.fact, maka_agent_facts::durable::Fact::ModelAttemptPrepared {..})).count(),
                1,
                "one provider attempt per Run: continuation neither reopens the source nor repeats its own request"
            );
        }
        // Replacing the directory at the same path must not authorize replay.
        std::fs::rename(
            &fixture.workspace,
            fixture.workspace.with_extension("original"),
        )
        .unwrap();
        std::fs::create_dir(&fixture.workspace).unwrap();
        assert_eq!(
            fixture
                .mutation(2, "continueRun", input, Uuid::new_v4())
                .await
                .unwrap(),
            json!({"kind":"rejected","reason":"workspace_changed"})
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(30), listener.accept())
                .await
                .is_err()
        );
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn application_reactivation_resumes_sealed_source_through_original_engine() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut fixture = Fixture::new(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
        )
        .await;
        let session = fixture.create("Resume after reactivation").await;
        let source = cancelled(&fixture, &listener, &session).await;
        let input = continuation_input(&fixture, &source).await;
        let deployment = fixture.app.source().unwrap().deployment;
        fixture.app.shutdown().await.unwrap();
        let captured = Arc::new(StdMutex::new(None));
        let capture = captured.clone();
        let durable = fixture.owner.durable.clone();
        let mut native = NativeRegistry::default();
        maka_settings_native::provide(&mut native, crate::owner::tests::bundled_catalog()).unwrap();
        native
            .insert(
                IMPLEMENTATION.into(),
                Arc::new(move |context, configuration| {
                    let capture = capture.clone();
                    let durable = durable.clone();
                    Box::pin(async move {
                        let owner = Owner::open(
                            context,
                            configuration,
                            crate::owner::tests::bundled_catalog(),
                            durable,
                            super::native_helper(),
                            None,
                        )
                        .await
                        .unwrap();
                        *capture.lock().unwrap() = Some(owner.clone());
                        let service = Arc::new(Agent(owner));
                        NativeActivation {
                            exports: Ok(BTreeMap::from([(
                                EXPORT.into(),
                                maka_plugin_core::runtime::Published {
                                    contract: contract(),
                                    value: service.clone()
                                        as Arc<dyn maka_host_runtime::application::Handler>,
                                },
                            )])),
                            owner: service,
                        }
                    })
                }),
            )
            .unwrap();
        fixture.app = Application::start_from_store(
            fixture.store.clone(),
            deployment,
            native,
            fixture.issuer.clone(),
            Arc::new(Grant(fixture.issuer.clone(), None)),
            Some(maka_host_js::factory(Default::default())),
        )
        .await
        .unwrap();
        fixture.app.ready().await.unwrap();
        fixture.owner = captured.lock().unwrap().take().unwrap();
        let resumed = fixture
            .mutation(2, "continueRun", input, Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(resumed["kind"], "started", "{resumed}");
        let (mut socket, _) = listener.accept().await.unwrap();
        assert!(
            request(&mut socket).await["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| message["content"] == "Hello")
        );
        response(&mut socket).await;
        fixture.drained().await;
        let execution = fixture
            .query(
                "execution",
                json!({"sessionId":session,"runId":resumed["execution"]["runId"]}),
            )
            .await
            .unwrap();
        assert_eq!(execution["execution"]["state"]["kind"], "completed");
        let old = fixture
            .query(
                "execution",
                json!({"sessionId":session,"runId":source["runId"]}),
            )
            .await
            .unwrap();
        assert_eq!(old["execution"], source);
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn resume_uses_live_workspace_permissions_instead_of_original_grants() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            Some(service_tools::Setup::files("write")),
        )
        .await;
        let session = fixture.create("Resume permission boundary").await;
        let source = cancelled(&fixture, &listener, &session).await;
        let history = fixture.history(&session);
        let source_run = serde_json::from_value(source["runId"].clone()).unwrap();
        let original = history.run_source(source_run).await.unwrap();
        let changed = files::change(&fixture, &session, "read_only", false, true).await;
        assert_eq!(changed["session"]["boundaryRevision"], 1);
        let current = fixture.owner.session(&session).await.unwrap();
        let current_basis = current.configuration.permission_basis();
        assert_ne!(original.spec.permission_basis, current_basis);
        assert_eq!(
            fixture
                .query(
                    "continuationAvailability",
                    json!({"sessionId":session,"runId":source_run})
                )
                .await
                .unwrap(),
            json!({"kind":"ready","source":source}),
            "downgrading current permissions does not make a terminal source ineligible"
        );
        let resumed = fixture
            .mutation(
                2,
                "continueRun",
                continuation_input(&fixture, &source).await,
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(resumed["kind"], "started", "{resumed}");
        let continued_run = serde_json::from_value(resumed["execution"]["runId"].clone()).unwrap();
        let continued = history.run_source(continued_run).await.unwrap();
        assert_eq!(
            continued.spec.permission_basis, current_basis,
            "new admission captures the entire current Root permission basis"
        );
        assert_ne!(
            continued.spec.permission_ceiling, original.spec.permission_ceiling,
            "new admission cannot inherit the source's old writable grant"
        );
        assert_eq!(
            continued.spec.permission_ceiling.approval,
            maka_sandbox::Approval::Never
        );
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        files::tool_response(&mut socket, json!({"path":"blocked.txt","content":"never"})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let tool = sent["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["role"] == "tool")
            .unwrap();
        let result: Value = serde_json::from_str(tool["content"].as_str().unwrap()).unwrap();
        assert_eq!(result["kind"], "failed");
        response(&mut socket).await;
        fixture.drained().await;
        assert!(!fixture.workspace.join("blocked.txt").exists());
        assert!(
            fixture
                .owner
                .durable
                .interactions()
                .pending(&session)
                .await
                .unwrap()
                .records
                .is_empty()
        );
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn continuation_availability_observes_without_admission_and_rechecks_the_source() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::new(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
        )
        .await;
        let session = fixture.create("Resumable observation").await;
        let missing_query = json!({"sessionId":session,"runId":maka_agent_facts::durable::RunId::new()});
        assert_eq!(
            fixture.query("continuationAvailability", missing_query).await.unwrap(),
            json!({"kind":"rejected","reason":"source_missing"})
        );
        let source = cancelled(&fixture, &listener, &session).await;
        let query = json!({"sessionId":session,"runId":source["runId"]});
        let mcp_record = fixture.workspace.join("resume-mcp.jsonl");
        let mcp_config = fixture.workspace.join(".maka/mcp.json");
        std::fs::create_dir_all(mcp_config.parent().unwrap()).unwrap();
        std::fs::write(&mcp_config, serde_json::to_vec(&json!({"mcpServers":{"fixture":{
            "command":"node",
            "args":[std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../mcp/tests/server.mjs"),"normal",mcp_record],
            "tools":["echo"], "preapproved":true
        }}})).unwrap()).unwrap();
        let project = fixture.query("projectMcp", json!({"sessionId":session})).await.unwrap();
        fixture.mutation(2, "trustProjectMcp", json!({"sessionId":session,"revision":project["revision"]}), Uuid::new_v4()).await.unwrap();
        let root_read = rusqlite::Connection::open_with_flags(
            fixture.root.join(maka_event_log::root::ROOT_DATABASE),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ).unwrap();
        let root_before: i64 = root_read.pragma_query_value(None, "data_version", |row|row.get(0)).unwrap();
        let before=fixture.through(&session).await;
        for _ in 0..2 {
            assert_eq!(
                fixture.query("continuationAvailability", query.clone()).await.unwrap(),
                json!({"kind":"ready","source":source})
            );
        }
        assert_eq!(
            fixture.through(&session).await,
            before,
            "observation must not admit a turn or reserve a continuation"
        );
        let root_after: i64 = root_read.pragma_query_value(None, "data_version", |row|row.get(0)).unwrap();
        assert_eq!(root_after, root_before, "availability must not commit any Root writes, including non-Agent state");
        drop(root_read);
        assert!(!mcp_record.exists(), "status observation must not start MCP servers");
        assert!(tokio::time::timeout(Duration::from_millis(30), listener.accept()).await.is_err(), "availability must not dispatch a model request");
        let input = continuation_input(&fixture, &source).await;
        let operation = Uuid::new_v4();
        let resumed = fixture
            .mutation(2, "continueRun", input.clone(), operation)
            .await
            .unwrap();
        assert_eq!(resumed["kind"], "started");
        assert!(mcp_record.exists(), "admission starts the selected MCP servers");
        assert_ne!(resumed["execution"]["turnId"], source["turnId"]);
        let (mut socket, _) = listener.accept().await.unwrap();
        let replay = request(&mut socket).await;
        assert!(
            replay["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| message["content"] == "Hello")
        );
        assert_eq!(
            fixture.query("continuationAvailability", query.clone()).await.unwrap(),
            json!({"kind":"rejected","reason":"already_continued"})
        );
        response(&mut socket).await;
        fixture.drained().await;
        assert_eq!(
            fixture
                .mutation(2, "continueRun", input.clone(), operation)
                .await
                .unwrap(),
            resumed
        );
        assert_eq!(
            fixture
                .mutation(2, "continueRun", input, Uuid::new_v4())
                .await
                .unwrap(),
            json!({"kind":"rejected","reason":"already_continued"})
        );
        assert_eq!(
            fixture.query("continuationAvailability", query.clone()).await.unwrap(),
            json!({"kind":"rejected","reason":"already_continued"})
        );
        let completed = fixture.query("execution", json!({"sessionId":session,"runId":resumed["execution"]["runId"]})).await.unwrap();
        assert_eq!(completed["execution"]["state"]["kind"], "completed");
        assert_eq!(fixture.query("continuationAvailability", json!({"sessionId":session,"runId":resumed["execution"]["runId"]})).await.unwrap(), json!({"kind":"ready","source":completed["execution"]}), "every terminal Run is eligible, not just interrupted work");
        let source = cancelled(&fixture, &listener, &session).await;
        let query = json!({"sessionId":session,"runId":source["runId"]});
        assert_eq!(fixture.query("continuationAvailability", query.clone()).await.unwrap(), json!({"kind":"ready","source":source}));
        fixture
            .store
            .set_session_archived::<StoredSessionConfiguration>(&session, true, now())
            .await
            .unwrap();
        assert_eq!(
            fixture.query("continuationAvailability", query).await.unwrap(),
            json!({"kind":"rejected","reason":"archived"})
        );
        assert_eq!(
            fixture
                .mutation(
                    2,
                    "continueRun",
                    continuation_input(&fixture, &source).await,
                    Uuid::new_v4()
                )
                .await
                .unwrap(),
            json!({"kind":"rejected","reason":"archived"})
        );
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn resume_filters_incompatible_reasoning_but_preserves_portable_history() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture=Fixture::new(&format!("http://{}/v1",listener.local_addr().unwrap()),None).await;
        let session=fixture.create("Reasoning stop").await;
        selection::edit(&fixture, |changes| {
            changes.enabled_model_ids = Some(vec!["fixture-model".into(), "older-model".into()]);
        }).await;
        fixture.send(&session).await.unwrap();
        let (mut route_socket, _) = listener.accept().await.unwrap();
        request(&mut route_socket).await;
        response_with_thinking(&mut route_socket, "portable old route answer", Some("incompatible old route reasoning")).await;
        fixture.drained().await;
        let current_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        selection::edit(&fixture, |changes| {
            changes.configuration = Some(json!({"baseUrl":format!("http://{}/v1", current_listener.local_addr().unwrap())}));
        }).await;
        let listener = current_listener;
        let mut older = fixture.selection().await;
        older.model_id = "older-model".into();
        fixture.mutation(2, "send", json!({"sessionId":session,"message":"old question","backend":model_backend(&older)}), Uuid::new_v4()).await.unwrap();
        let (mut old_socket, _) = listener.accept().await.unwrap();
        request(&mut old_socket).await;
        response_with_thinking(&mut old_socket, "portable old answer", Some("incompatible old reasoning")).await;
        fixture.drained().await;
        fixture.send(&session).await.unwrap();
        let (mut same_socket, _) = listener.accept().await.unwrap();
        request(&mut same_socket).await;
        response_with_thinking(&mut same_socket, "portable current answer", Some("compatible current reasoning")).await;
        fixture.drained().await;
        let sent=fixture.send(&session).await.unwrap();
        let run=fixture.delivered_run(&sent).await;
        let(mut socket,_)=listener.accept().await.unwrap();request(&mut socket).await;
        let mut preview=fixture.owner.preview_reader(&session).await.unwrap();
        let delta=json!({"id":"thinking","choices":[{"index":0,"delta":{"reasoning_content":"unfinished reasoning"},"finish_reason":null}]});
        let body=format!("data: {delta}\n\n");
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{body}\r\n",body.len()).as_bytes()).await.unwrap();
        loop {
            let visible=preview.borrow_and_update().as_ref().is_some_and(|cut|cut.parts.iter().any(|part|matches!(part,maka_agent_facts::model::assembly::PreviewPart::Text{text,..} if text.to_string() == "unfinished reasoning")));
            if visible {break;}
            preview.changed().await.unwrap();
        }
        fixture.mutation(2,"stop",json!({"sessionId":session,"runId":run}),Uuid::new_v4()).await.unwrap();
        fixture.drained().await;
        let result=fixture.query("continuationAvailability",json!({"sessionId":session,"runId":run})).await;
        assert_eq!(result.as_ref().unwrap()["kind"],"ready","{result:?}");
        let source = &result.unwrap()["source"];
        let resumed = fixture.mutation(2,"continueRun",continuation_input(&fixture, source).await,Uuid::new_v4()).await.unwrap();
        assert_eq!(resumed["kind"], "started");
        assert_ne!(resumed["execution"]["turnId"], source["turnId"]);
        let (mut resumed_socket, _) = listener.accept().await.unwrap();
        let wire = request(&mut resumed_socket).await.to_string();
        for retained in ["old question", "portable old answer", "portable old route answer", "portable current answer", "compatible current reasoning"] {
            assert!(wire.contains(retained), "missing {retained}");
        }
        for omitted in ["incompatible old reasoning", "incompatible old route reasoning", "unfinished reasoning"] {
            assert!(!wire.contains(omitted), "replayed {omitted}");
        }
        response(&mut resumed_socket).await;
        fixture.drained().await;
        let facts = serde_json::to_string(&service_tools::facts(&fixture, &session).await).unwrap();
        assert!(facts.contains("incompatible old reasoning"));
        assert!(facts.contains("incompatible old route reasoning"));
        assert!(facts.contains("unfinished reasoning"));
        fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}
