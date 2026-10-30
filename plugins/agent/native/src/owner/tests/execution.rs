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
        #[cfg(unix)]
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
        // Windows retains a workspace handle that prevents directory replacement.
        #[cfg(unix)]
        {
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
        }
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
        let source_configuration = fixture
            .session(&session)
            .await
            .invocation_configuration(
                &fixture
                    .session(&session)
                    .await
                    .invocation_boundary(&session, source["invocationId"].as_str().unwrap())
                    .await
                    .unwrap()
                    .unwrap()
                    .0
                    .invocation,
            )
            .await
            .unwrap()
            .unwrap();
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
                configuration: Some(Box::new(source_configuration)),
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
        assert_eq!(
            fixture
                .query(
                    "resumable",
                    json!({"sessionId":session,"model":fixture.selection().await})
                )
                .await
                .unwrap(),
            json!({"kind":"unavailable","reason":"safety_check_failed"})
        );
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

#[tokio::test]
async fn resumable_observes_without_admission_and_resume_rechecks_the_observed_source() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::new(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
        )
        .await;
        let session = fixture.create("Resumable observation").await;
        let query = json!({"sessionId":session,"model":fixture.selection().await});
        assert_eq!(
            fixture.query("resumable", query.clone()).await.unwrap(),
            json!({"kind":"unavailable","reason":"source_missing"})
        );
        let source = cancelled(&fixture, &listener, &session).await;
        let store = fixture.session(&session).await;
        let before = store.committed_sequence().await.unwrap();
        for _ in 0..2 {
            assert_eq!(
                fixture.query("resumable", query.clone()).await.unwrap(),
                json!({"kind":"ready","source":source})
            );
        }
        assert_eq!(
            store.committed_sequence().await.unwrap(),
            before,
            "observation must not admit a turn or reserve a continuation"
        );
        let input = resume_input(&fixture, &source).await;
        let operation = Uuid::new_v4();
        let resumed = fixture
            .mutation(2, "resume", input.clone(), operation)
            .await
            .unwrap();
        assert_eq!(resumed["kind"], "started");
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
            fixture.query("resumable", query.clone()).await.unwrap(),
            json!({"kind":"unavailable","reason":"busy"})
        );
        response(&mut socket).await;
        fixture.drained().await;
        assert_eq!(
            fixture
                .mutation(2, "resume", input.clone(), operation)
                .await
                .unwrap(),
            resumed
        );
        assert_eq!(
            fixture
                .mutation(2, "resume", input, Uuid::new_v4())
                .await
                .unwrap(),
            json!({"kind":"parked","reason":"already_continued"})
        );
        assert_eq!(
            fixture.query("resumable", query.clone()).await.unwrap(),
            json!({"kind":"unavailable","reason":"source_not_resumable"})
        );
        // The latest completed run hides older interrupted work from the composer.
        let source = cancelled(&fixture, &listener, &session).await;
        fixture
            .store
            .set_session_archived::<StoredSessionConfiguration>(&session, true, now())
            .await
            .unwrap();
        assert_eq!(
            fixture.query("resumable", query).await.unwrap(),
            json!({"kind":"unavailable","reason":"archived"})
        );
        assert_eq!(
            fixture
                .mutation(
                    2,
                    "resume",
                    resume_input(&fixture, &source).await,
                    Uuid::new_v4()
                )
                .await
                .unwrap(),
            json!({"kind":"parked","reason":"archived"})
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
        fixture.mutation(2, "send", json!({"sessionId":session,"message":"old question","model":older}), Uuid::new_v4()).await.unwrap();
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
        fixture.mutation(2,"stop",json!({"sessionId":session,"invocationId":sent["invocationId"]}),Uuid::new_v4()).await.unwrap();
        fixture.drained().await;
        let result=fixture.query("resumable",json!({"sessionId":session,"model":fixture.selection().await})).await;
        assert_eq!(result.as_ref().unwrap()["kind"],"ready","{result:?}");
        let source = &result.unwrap()["source"];
        let resumed = fixture.mutation(2,"resume",resume_input(&fixture, source).await,Uuid::new_v4()).await.unwrap();
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
