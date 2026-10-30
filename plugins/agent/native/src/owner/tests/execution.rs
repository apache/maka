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
