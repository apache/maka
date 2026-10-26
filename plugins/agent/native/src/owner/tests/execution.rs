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
    let (mut socket, _) = listener.accept().await.unwrap();
    request(&mut socket).await;
    let stopped = fixture
        .mutation(
            2,
            "stop",
            json!({
                "sessionId":session, "invocationId":sent["invocationId"]
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
                "sessionId":session, "invocationId":sent["invocationId"]
            }),
        )
        .await
        .unwrap();
    assert_eq!(read["execution"]["state"], "cancelled");
    read["execution"].clone()
}
async fn resume_input(fixture: &Fixture, source: &Value) -> Value {
    json!({"sessionId":source["sessionId"], "sourceInvocationId":source["invocationId"],
        "sourceHighWater":source["highWater"], "model":fixture.selection().await})
}

fn assert_computer_state(request: &Value, expected: &str) {
    let tool = request["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["function"]["name"] == "cua_repl")
        .expect("real Computer tool descriptor");
    assert!(
        tool["function"]["description"]
            .as_str()
            .unwrap()
            .contains(&format!("Current REPL state: {expected}.")),
        "{tool}"
    );
}

async fn assert_computer_output(fixture: &Fixture, session: &str, expected: &str) {
    use maka_agent_facts::event::{Fact, ToolOutcome};
    use maka_agent_facts::tool_output::DurableToolProjection;

    let facts = service_tools::facts(fixture, session).await;
    let outcome = facts
        .iter()
        .rev()
        .find_map(|fact| match fact {
            Fact::ToolSettled { outcome, .. } => Some(outcome),
            _ => None,
        })
        .expect("actual Computer settlement");
    let ToolOutcome::Succeeded {
        model_projection: DurableToolProjection::Text { text },
        ..
    } = outcome
    else {
        panic!("expected successful Computer text output: {outcome:?}");
    };
    assert_eq!(text, &format!("{expected}\nREPL state: \"ready\""));
}

async fn computer_resume_replays_original_input_without_duplicate_effects(stop: bool) {
    use maka_agent_facts::event::Fact;
    use maka_agent_facts::interaction::InteractionRequest;
    const SECRET: &str = "SECRET_MAIN_PROVIDER_BODY_SENTINEL";

    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            Some(service_tools::Setup::computer()),
        )
        .await;
        let session = fixture.create("Resume with Computer").await;

        // Establish a real approved Computer VM before interrupting another run.
        fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        assert_computer_state(&request(&mut socket).await, "fresh");
        service_tools::named_tool_response(
            &mut socket,
            "cua_repl",
            json!({"code":"globalThis.resumeCounter = 40; nodeRepl.write(globalThis.resumeCounter);"}),
        )
        .await;
        let mut commits = fixture.session(&session).await.subscribe_commits().unwrap();
        let approval = loop {
            commits.borrow_and_update();
            if let Some(record) = fixture.session(&session).await.pending_interactions(&session)
                .await
                .unwrap()
                .into_iter()
                .next()
            {
                break record;
            }
            commits.changed().await.unwrap();
        };
        assert!(matches!(&approval.request, InteractionRequest::ClientCapability { target, .. } if target == &maka_workspace_api::computer::target()));
        assert_eq!(fixture.mutation(2, "respond", json!({"sessionId":session,"requestId":approval.request_id,"answer":{"kind":"client_capability","decision":"allow"}}), Uuid::new_v4()).await.unwrap()["kind"], "recorded");
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        assert_computer_output(&fixture, &session, "40").await;
        response(&mut socket).await;
        fixture.drained().await;

        let sent = fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        assert_computer_state(&request(&mut socket).await, "ready");
        if stop {
            assert_eq!(fixture.mutation(2, "stop", json!({"sessionId":session,"invocationId":sent["invocationId"]}), Uuid::new_v4()).await.unwrap()["requested"], true);
        } else {
            let body = json!({"error":{"message":SECRET,"type":"invalid_request_error","code":"invalid_request"}}).to_string();
            socket.write_all(format!("HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
        drop(socket);
        fixture.drained().await;
        let source = fixture.query("execution", json!({"sessionId":session,"invocationId":sent["invocationId"]})).await.unwrap()["execution"].clone();
        assert_eq!(source["state"], if stop { "cancelled" } else { "failed" }, "{source}");
        let failed_invocation=fixture.session(&session).await.invocation_boundary(&session,sent["invocationId"].as_str().unwrap()).await.unwrap().unwrap().0.invocation;
        let diagnostics=fixture.query("diagnostics",json!({"sessionId":session,"position":{"kind":"latest"}})).await;

        // A later message must not replace the selected source's original input.
        fixture.mutation(2, "send", json!({"sessionId":session,"message":"Later unrelated Computer request","model":fixture.selection().await}), Uuid::new_v4()).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response(&mut socket).await;
        fixture.drained().await;

        let input = resume_input(&fixture, &source).await;
        let operation = Uuid::new_v4();
        let resumed = fixture.mutation(2, "resume", input.clone(), operation).await.unwrap();
        assert_eq!(resumed["kind"], "started", "{resumed}");
        assert_ne!(resumed["execution"]["invocationId"], source["invocationId"]);
        let (mut socket, _) = listener.accept().await.unwrap();
        let replay = request(&mut socket).await;
        assert_computer_state(&replay, "ready");
        let last_user = replay["messages"].as_array().unwrap().iter().rev().find(|message| message["role"] == "user").unwrap();
        assert_eq!(last_user["content"], "Hello");
        assert!(!replay.to_string().contains("Later unrelated Computer request"));
        service_tools::named_tool_response(&mut socket, "cua_repl", json!({"code":"nodeRepl.write(++globalThis.resumeCounter);"})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        assert_computer_output(&fixture, &session, "41").await;
        response(&mut socket).await;
        fixture.drained().await;
        let completed = fixture.query("execution", json!({"sessionId":session,"invocationId":resumed["execution"]["invocationId"]})).await.unwrap();
        assert_eq!(completed["execution"]["state"], "completed");
        assert_eq!(fixture.mutation(2, "resume", input.clone(), operation).await.unwrap(), resumed);
        assert_eq!(fixture.mutation(2, "resume", input, Uuid::new_v4()).await.unwrap(), json!({"kind":"parked","reason":"already_continued"}));
        assert_eq!(fixture.query("execution", json!({"sessionId":session,"invocationId":source["invocationId"]})).await.unwrap()["execution"], source);
        let facts = service_tools::facts(&fixture, &session).await;
        assert_eq!(facts.iter().filter(|fact| matches!(fact, Fact::ToolDispatched { name, input, .. } if name == "cua_repl" && input["code"] == "nodeRepl.write(++globalThis.resumeCounter);")).count(), 1);

        // Read the real VM again: duplicate resume must not have incremented it.
        fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        assert_computer_state(&request(&mut socket).await, "ready");
        service_tools::named_tool_response(&mut socket, "cua_repl", json!({"code":"nodeRepl.write(globalThis.resumeCounter);"})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        assert_computer_output(&fixture, &session, "41").await;
        response(&mut socket).await;
        fixture.drained().await;
        assert!(fixture.session(&session).await.pending_interactions(&session).await.unwrap().is_empty());
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
        if !stop {
            let diagnostics=diagnostics.expect("actual main HTTP failure must be readable through public diagnostics");
            let entries=diagnostics["entries"].as_array().unwrap();
            assert_eq!(entries.len(),2,"both original model-step and terminal execution evidence must be visible");
            for entry in entries {
                assert!(entry["sequence"].as_u64().is_some_and(|sequence|sequence>0));
                assert!(entry["eventId"].as_str().is_some_and(|id|!id.is_empty()));
                assert!(entry["recordedAt"].as_f64().is_some());
                assert_eq!(entry["detail"]["invocation"],serde_json::to_value(&failed_invocation).unwrap());
                assert_eq!(entry["detail"]["modelFailure"],json!({"kind":"http","status":400}));
            }
            let execution=entries.iter().find(|entry|entry["detail"]["kind"] == "execution").unwrap();
            assert_eq!(execution["detail"]["reason"],"model_http");
            let step=entries.iter().find(|entry|entry["detail"]["kind"] == "model_step").unwrap();
            assert_eq!(step["detail"]["status"],"failed");
            let interrupted=facts.iter().find(|fact|matches!(fact,Fact::ModelInterrupted {..})).unwrap();
            let ended=facts.iter().find(|fact|matches!(fact,Fact::InvocationEnded {outcome:maka_agent_facts::event::InvocationOutcome::Failed {..}})).unwrap();
            assert_eq!(serde_json::to_value(interrupted).unwrap()["model_failure"],json!({"kind":"http","status":400}));
            assert_eq!(serde_json::to_value(ended).unwrap()["outcome"]["model_failure"],json!({"kind":"http","status":400}));
            assert!(!diagnostics.to_string().contains(SECRET),"safe diagnostics must not expose provider response bodies");
        }
    }).await.unwrap();
}

#[tokio::test]
async fn computer_resume_stopped_replays_original_input_without_duplicate_effects() {
    computer_resume_replays_original_input_without_duplicate_effects(true).await;
}

#[tokio::test]
async fn computer_resume_model_failure_replays_original_input_without_duplicate_effects() {
    computer_resume_replays_original_input_without_duplicate_effects(false).await;
}

#[tokio::test]
async fn exact_receipt_resumes_original_input_and_deduplicates_after_prerequisites_disappear() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::new(&format!("http://{}/v1", listener.local_addr().unwrap()), None).await;
        let session = fixture.create("Resume original").await;
        let source = cancelled(&fixture, &listener, &session).await;
        let boundary = fixture.session(&session).await.invocation_boundary(&session,source["invocationId"].as_str().unwrap()).await.unwrap().unwrap().0;
        let maka_agent_facts::input::InvocationInput::Message {source_messages,..} = boundary.root_input() else {panic!("original message")};
        let message = source_messages[0].message.message_id.clone();

        let later = fixture.mutation(2, "send", json!({"sessionId":session, "message":"Later separate request", "model":fixture.selection().await}), Uuid::new_v4()).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        response(&mut socket).await;
        fixture.drained().await;
        let read = fixture.query("execution", json!({"sessionId":session,"invocationId":source["invocationId"]})).await.unwrap();
        assert_eq!(read["execution"], source, "exact receipt must not become the Session tip");
        let other = fixture.create("Other session").await;
        assert_eq!(fixture.query("execution", json!({"sessionId":other,"invocationId":source["invocationId"]})).await.unwrap(), json!({"kind":"missing"}));
        assert!(fixture.query("execution", json!({"sessionId":"foreign","invocationId":source["invocationId"]})).await.is_err());
        let input = resume_input(&fixture, &source).await;
        let operation = Uuid::new_v4();
        let prepared = fixture.app.client().prepare_mutation(fixture.binding(2).await, "resume".into(), input.clone(), scope(&fixture.issuer, true), operation, Attachments::new().into()).await.unwrap();
        let reference = prepared.reference().clone();
        drop(prepared);
        let resumed = fixture.mutation(2, "resume", input.clone(), operation).await.unwrap();
        assert_eq!(resumed["kind"], "started", "{resumed}");
        let execution = &resumed["execution"];
        assert_ne!(execution["invocationId"], source["invocationId"]);
        assert_ne!(execution["invocationId"], later["invocationId"]);
        let (mut socket, _) = listener.accept().await.unwrap();
        let replay = request(&mut socket).await;
        assert!(replay["messages"].as_array().unwrap().iter().any(|message| message["content"] == "Hello"));
        assert!(!replay.to_string().contains("Later separate request"));
        response(&mut socket).await;
        fixture.drained().await;
        let duplicate = fixture.mutation(2, "resume", input.clone(), operation).await.unwrap();
        assert_eq!(duplicate, resumed, "operation journal returns original reply");
        let second = fixture.mutation(2, "resume", input.clone(), Uuid::new_v4()).await.unwrap();
        assert_eq!(second, json!({"kind":"parked","reason":"already_continued"}));
        let selected = fixture.selection().await;
        assert!(matches!(fixture.config.remove_connection(RemoveCatalogConnectionInput {
            expected: ConnectionVersionBasis { connection_id: selected.connection_id, revision: selected.revision },
        }).await.unwrap(), CatalogMutationResult::Committed { .. }));
        fixture.store.set_session_archived::<StoredSessionConfiguration>(&session, true, now()).await.unwrap();
        std::fs::rename(&fixture.workspace, fixture.workspace.with_extension("removed")).unwrap();
        let accepted = fixture.owner.resume(serde_json::from_value(input).unwrap(), &reference).await.unwrap();
        let accepted = serde_json::to_value(accepted).unwrap();
        assert_eq!(accepted["execution"]["invocationId"], execution["invocationId"]);
        assert_eq!(accepted["execution"]["state"], "completed");
        let delivery = fixture.query("work",json!({"sessionId":session,"target":{"kind":"message","messageId":message}})).await.unwrap();
        assert_eq!(delivery["kind"],"delivered");
        assert_eq!(delivery["shared"],false);
        assert_eq!(delivery["execution"],accepted["execution"],"message follows canonical continuation, never later unrelated work");
        let original_work = fixture.query("work",json!({"sessionId":session,"target":{"kind":"invocation","invocationId":source["invocationId"]}})).await.unwrap();
        assert_eq!(original_work,delivery,"direct admission follows the same explicit continuation");
        assert_eq!(original_work["answer"]["text"],"Elegant response");
        assert_eq!(fixture.query("work",json!({"sessionId":session,"target":{"kind":"invocation","invocationId":source["invocationId"]},"cursor":{"invocationId":source["invocationId"],"offset":9000}})).await.unwrap(),json!({"kind":"changed"}),"old cursor must be rejected before applying its offset to a new answer");


        assert!(tokio::time::timeout(Duration::from_millis(30), listener.accept()).await.is_err(), "no second model request");
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn resume_rejects_stale_foreign_busy_and_completed_sources_without_new_work() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::new(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
        )
        .await;
        let session = fixture.create("Resume fences").await;
        let source = cancelled(&fixture, &listener, &session).await;
        let input = resume_input(&fixture, &source).await;
        for (field, value, reason) in [
            (
                "sourceHighWater",
                json!(source["highWater"].as_u64().unwrap() + 1),
                "source_changed",
            ),
            ("sourceInvocationId", json!("missing"), "source_missing"),
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
                    .mutation(2, "resume", invalid, Uuid::new_v4())
                    .await
                    .unwrap(),
                json!({"kind":"parked","reason":reason})
            );
        }
        let active = fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        assert_eq!(
            fixture
                .mutation(2, "resume", input.clone(), Uuid::new_v4())
                .await
                .unwrap(),
            json!({"kind":"parked","reason":"busy"})
        );
        response(&mut socket).await;
        fixture.drained().await;
        let completed = fixture
            .query(
                "execution",
                json!({"sessionId":session,"invocationId":active["invocationId"]}),
            )
            .await
            .unwrap();
        let completed_input = resume_input(&fixture, &completed["execution"]).await;
        assert_eq!(
            fixture
                .mutation(2, "resume", completed_input, Uuid::new_v4())
                .await
                .unwrap(),
            json!({"kind":"parked","reason":"source_not_resumable"})
        );
        // Replacing the directory at the same path must not authorize replay.
        std::fs::rename(
            &fixture.workspace,
            fixture.workspace.with_extension("original"),
        )
        .unwrap();
        std::fs::create_dir(&fixture.workspace).unwrap();
        assert_eq!(
            fixture
                .mutation(2, "resume", input, Uuid::new_v4())
                .await
                .unwrap(),
            json!({"kind":"parked","reason":"workspace_changed"})
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
        let input = resume_input(&fixture, &source).await;
        let deployment = fixture.app.source().unwrap().deployment;
        fixture.app.shutdown().await.unwrap();
        let captured = Arc::new(StdMutex::new(None));
        let capture = captured.clone();
        let mut native = NativeRegistry::default();
        maka_settings_native::provide(&mut native, crate::owner::tests::bundled_catalog()).unwrap();
        native
            .insert(
                IMPLEMENTATION.into(),
                Arc::new(move |context, configuration| {
                    let capture = capture.clone();
                    Box::pin(async move {
                        let owner = Owner::open(
                            context,
                            configuration,
                            crate::owner::tests::bundled_catalog(),
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
            .mutation(2, "resume", input, Uuid::new_v4())
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
                json!({"sessionId":session,"invocationId":resumed["execution"]["invocationId"]}),
            )
            .await
            .unwrap();
        assert_eq!(execution["execution"]["state"], "completed");
        let old = fixture
            .query(
                "execution",
                json!({"sessionId":session,"invocationId":source["invocationId"]}),
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
async fn resume_refuses_unsettled_effect_outside_its_selected_lineage() {
    use maka_agent_facts::event::EventWrite;
    use maka_agent_facts::event::Fact;
    use maka_agent_facts::event::InvocationOutcome;
    use maka_agent_facts::event::RuntimeEvent;
    use maka_agent_facts::input::InvocationInput;
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::new(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
        )
        .await;
        let session = fixture.create("Unresolved prior effect").await;
        let source = cancelled(&fixture, &listener, &session).await;
        // Canonical crash-cut fixture: a later sealed invocation has a dispatched
        // effect without a settlement. No production recovery override is used.
        let invocation = Invocation {
            session_id: session.clone(),
            turn_id: "later-turn".into(),
            run_id: "later-run".into(),
            invocation_id: "later-invocation".into(),
        };
        for fact in [
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    content: "Unresolved later work".into(),
                    source_messages: vec![],
                    request_fingerprint: None,
                },
            },
            Fact::ToolDispatched {
                presentation: None,
                title: None,
                operation_id: "unresolved".into(),
                call: maka_agent_facts::tool_call::ToolCallIdentity::standalone(
                    "unresolved-call".into(),
                ),
                name: "write".into(),
                input: json!({}),
            },
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Failed {
                    model_failure: None,
                    class: "outcome_unknown".into(),
                    message: None,
                },
            },
        ] {
            fixture
                .session(&session)
                .await
                .append(&EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap())
                .await
                .unwrap();
        }
        let resumed = fixture
            .mutation(
                2,
                "resume",
                resume_input(&fixture, &source).await,
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(
            resumed,
            json!({"kind":"parked","reason":"safety_check_failed"})
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(30), listener.accept())
                .await
                .is_err()
        );
        let facts = service_tools::facts(&fixture, &session).await;
        assert_eq!(
            facts
                .iter()
                .filter(|fact| matches!(fact, Fact::InvocationOpened { .. }))
                .count(),
            2
        );
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
        let changed = files::change(&fixture, &session, "read_only", false, true).await;
        assert_eq!(changed["session"]["boundaryRevision"], 1);
        let resumed = fixture
            .mutation(
                2,
                "resume",
                resume_input(&fixture, &source).await,
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(resumed["kind"], "started", "{resumed}");
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
                .session(&session)
                .await
                .pending_interactions(&session)
                .await
                .unwrap()
                .is_empty()
        );
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn work_answer_pages_preserve_exact_unicode_nul_and_owner_after_later_work() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture=Fixture::new(&format!("http://{}/v1",listener.local_addr().unwrap()),None).await;
        let session=fixture.create("Original work answer").await;
        let original=fixture.send(&session).await.unwrap();
        let target=json!({"kind":"invocation","invocationId":original["invocationId"]});
        let (mut socket,_)=listener.accept().await.unwrap();request(&mut socket).await;
        let answer="中\0🦀\n".repeat(2200);
        response_with_thinking(&mut socket,&answer,Some("Hidden worker reasoning")).await;
        fixture.drained().await;
        fixture.send(&session).await.unwrap();
        let (mut socket,_)=listener.accept().await.unwrap();request(&mut socket).await;
        response_with_text(&mut socket,"Unrelated later answer").await;fixture.drained().await;
        let mut cursor=Value::Null;let mut joined=String::new();let mut pages=0;
        loop {
            let page=fixture.query("work",json!({"sessionId":session,"target":target,"cursor":cursor})).await.unwrap();
            assert_eq!(page["kind"],"delivered");assert_eq!(page["execution"]["invocationId"],original["invocationId"]);
            assert_eq!(page["execution"]["state"],"completed");assert_eq!(page["pendingInteractions"],0);
            let text=page["answer"]["text"].as_str().unwrap();assert!(text.len()<=16_384);joined.push_str(text);pages+=1;
            cursor=page["answer"]["next"].clone();if cursor.is_null() {break;}
            assert_eq!(cursor["offset"],joined.len());
        }
        assert!(pages>1);assert_eq!(joined,answer);assert!(!joined.contains("Hidden"));
        assert!(fixture.query("work",json!({"sessionId":session,"target":target,"cursor":{"invocationId":original["invocationId"],"offset":1}})).await.is_err());
        let other=fixture.create("Different owner").await;
        assert_eq!(fixture.query("work",json!({"sessionId":other,"target":target})).await.unwrap(),json!({"kind":"missing"}));
        fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}
