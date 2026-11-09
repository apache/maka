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
use maka_agent_authority::permissions::Access as _;
use maka_agent_facts::interaction::ClosureReason;
use maka_agent_facts::interaction::InteractionOutcome;
use maka_host_runtime::application::Subscription;

async fn next(stream: &mut Subscription) -> Value {
    tokio::time::timeout(Duration::from_secs(5), stream.recv())
        .await
        .expect("catalog update")
        .expect("live subscription")
}

// A separate actual Host namespace, sharing only this Root and its DriverDomain.
struct ForeignAgent {
    app: Application,
    owner: Arc<Owner>,
    issuer: Issuer,
}
impl ForeignAgent {
    async fn open(f: &Fixture) -> Self {
        let (input, packages) = input(&f.owner.settings);
        let deployment = Uuid::new_v4();
        f.store
            .commit_application(deployment, 0, input, vec![], packages)
            .await
            .unwrap();
        let captured = Arc::new(StdMutex::new(None));
        let capture = captured.clone();
        let state = f.owner.durable.clone();
        let catalog = bundled_catalog();
        let helper = native_helper();
        let mut native = NativeRegistry::default();
        maka_settings_native::provide(&mut native, catalog.clone()).unwrap();
        native
            .insert(
                IMPLEMENTATION.into(),
                Arc::new(move |context, configuration| {
                    let capture = capture.clone();
                    let state = state.clone();
                    let catalog = catalog.clone();
                    let helper = helper.clone();
                    Box::pin(async move {
                        let owner =
                            Owner::open(context, configuration, catalog, state, helper, None)
                                .await
                                .unwrap();
                        *capture.lock().unwrap() = Some(owner.clone());
                        let service = Arc::new(Agent(owner));
                        NativeActivation {
                            owner: service.clone(),
                            exports: Ok(BTreeMap::from([(
                                EXPORT.into(),
                                maka_plugin_core::runtime::Published {
                                    contract: contract(),
                                    value: service
                                        as Arc<dyn maka_host_runtime::application::Handler>,
                                },
                            )])),
                        }
                    })
                }),
            )
            .unwrap();
        let policy = Arc::new(maka_transport::transport::PeerPolicy::default());
        let issuer = policy.issuer();
        let app = Application::start_from_store(
            f.store.clone(),
            deployment,
            native,
            issuer.clone(),
            Arc::new(Grant(issuer.clone(), Some(policy))),
            Some(maka_host_js::factory(Default::default())),
        )
        .await
        .unwrap();
        app.ready().await.unwrap();
        let owner = captured.lock().unwrap().take().unwrap();
        assert_ne!(owner.run_owner(), f.owner.run_owner());
        Self { app, owner, issuer }
    }
}
async fn foreign_mutation(f: &ForeignAgent, method: &str, input: Value) -> Value {
    let client = f.app.client();
    let binding = client
        .bind(client.activation(&id(2)).unwrap(), EXPORT.into())
        .await
        .unwrap()
        .remove(0);
    let prepared = client
        .prepare_mutation(
            binding,
            method.into(),
            input,
            scope(&f.issuer, true),
            Uuid::new_v4(),
            Attachments::new().into(),
        )
        .await
        .unwrap();
    let recovery = json!({"reference":prepared.reference()});
    let reply = client
        .mutate_owned(prepared, recovery)
        .await
        .unwrap()
        .result()
        .await;
    let Receipt::Recorded {
        outcome:
            OperationOutcome::Returned {
                result: OperationResult::Success { value },
            },
        ..
    } = reply.receipt
    else {
        panic!("{reply:?}")
    };
    value
}
async fn permissions(
    owner: &Arc<Owner>,
    session: &str,
    names: &[&str],
    socket: &mut TcpStream,
) -> (
    Vec<maka_agent_facts::interaction::InteractionRecord>,
    tokio::sync::oneshot::Sender<()>,
) {
    use maka_agent_facts::{
        durable::AuthorizationObligation,
        interaction::{InteractionRecord, InteractionRequest, PermissionRequest},
    };
    let access = owner.runs.state().await.controls[session]
        .access
        .upgrade()
        .expect("actual live driver access");
    let (release, held) = tokio::sync::oneshot::channel();
    let (entered, entering) = tokio::sync::oneshot::channel();
    let stop = owner.stop.clone();
    let pause = Box::pin(async move {
        entered.send(()).expect("actual pre-T1 worker entered");
        tokio::select! {
            _=stop.cancelled()=>Ok(()),
            held=held=>held.map_err(|error|RunError::Internal(error.to_string())),
        }
    });
    {
        let mut preparation = owner.tool_preparation.lock().unwrap();
        assert!(preparation.is_none());
        *preparation = Some(pause);
    }
    let calls:Vec<_>=names.iter().enumerate().map(|(index,name)|json!({
        "index":index,"id":name,"type":"function","function":{"name":"SessionCreate",
        "arguments":json!({"title":format!("Catalog permission {name}"),"labels":[],"workspace":{"kind":"session","sessionId":session}}).to_string()}
    })).collect();
    let delta = json!({"id":"catalog-model","choices":[{"index":0,"delta":{"tool_calls":calls},"finish_reason":null}]});
    let body = format!(
        "data: {delta}\n\ndata: {{\"id\":\"catalog-model\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n"
    );
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
    entering.await.unwrap();
    let view = access.fresh().await.unwrap();
    let configuration = access.live_configuration().await.unwrap();
    let mut records = Vec::new();
    for name in names {
        let tool = view
            .tools
            .values()
            .find(|tool| {
                tool.key.call == *name
                    && tool.call.name == "SessionCreate"
                    && !tool.admitted
                    && tool.accepted.is_none()
                    && tool.decision.is_none()
            })
            .expect("actual Finished T0 unprepared tool");
        let target = AuthorizationObligation::Tool {
            tool: tool.key.clone(),
        };
        let record = InteractionRecord {
            execution: access.execution().clone(),
            request_id: (*name).into(),
            created_at: now(),
            outcome: None,
            request: InteractionRequest::Permissions {
                tool_use_id: Some(maka_agent_facts::tool_call::tool_use_id(
                    access.execution().run_id,
                    &maka_agent_state::fold::tool_key(&tool.key),
                )),
                target: target.clone(),
                basis: configuration.permission_basis(),
                request: PermissionRequest {
                    reason: "Write the catalog request result.".into(),
                    command: None,
                    permissions: maka_sandbox::grant::Permissions {
                        filesystem: vec![maka_sandbox::filesystem::Rule {
                            path: std::path::PathBuf::from(&configuration.workspace.path)
                                .join(format!("{name}.txt")),
                            scope: maka_sandbox::filesystem::Scope::Exact,
                            access: maka_sandbox::filesystem::Access::Write,
                        }],
                        network: maka_sandbox::Network::Denied,
                    },
                },
            },
        };
        records.push(access.establish_for_target(&record, &target).await.unwrap());
    }
    (records, release)
}

#[tokio::test]
async fn catalog_observes_metadata_pending_and_removal_at_its_original_location() {
    let model = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fixture = session_parent_authority::fixture(&model).await;
    let mut bootstrap = fixture
        .app
        .client()
        .subscribe(
            fixture.binding(2).await,
            "catalog".into(),
            json!({"filter":"all","position":{"kind":"start"}}),
            scope(&fixture.issuer, true),
            Attachments::new().into(),
        )
        .await
        .unwrap();
    assert_eq!(next(&mut bootstrap).await["sessions"], json!([]));
    let first_id = fixture.create("First").await;
    let published = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let page = next(&mut bootstrap).await;
            // A partition commit can precede publication of its Root route.
            if !page["sessions"].as_array().unwrap().is_empty() {
                break page;
            }
        }
    })
    .await
    .expect("created Session must be published to the catalog");
    assert_eq!(published["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(published["sessions"][0]["id"], first_id);
    assert_eq!(published["sessions"][0]["title"], "First");
    let mut ids = vec![first_id];
    for title in ["Second", "Third"] {
        let id = fixture.create(title).await;
        let page = loop {
            let page = next(&mut bootstrap).await;
            if page["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|session| session["id"] == id)
            {
                break page;
            }
        };
        assert_eq!(
            page["sessions"][0]["id"], id,
            "Start follows new conversations"
        );
        ids.push(id);
    }
    bootstrap.completion().await;
    ids.reverse();
    let owned_scope = json!({"kind":"workspace","sessionId":ids[0]});
    let first_title = fixture
        .query(
            "list",
            json!({
                "filter":"all","position":{"kind":"start"},
                "scope":owned_scope,"titleQuery":"First"
            }),
        )
        .await
        .unwrap();
    assert_eq!(first_title["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(first_title["sessions"][0]["title"], "First");
    for (scope, title) in [
        (owned_scope.clone(), "Second"),
        (json!({"kind":"workspace","sessionId":ids[1]}), "First"),
        (json!({"kind":"all"}), "First"),
    ] {
        let changed = fixture.query("list", json!({
            "filter":"all","position":{"kind":"after","revision":first_title["revision"],"cursor":first_title["sessions"][0]["id"]},
            "scope":scope,"titleQuery":title
        })).await.unwrap_err();
        assert!(changed.contains("agent_catalog_changed"), "{changed}");
    }
    let defaults = fixture
        .query("list", json!({"filter":"all","position":{"kind":"start"}}))
        .await
        .unwrap();
    let explicit = fixture.query("list", json!({"filter":"all","position":{"kind":"start"},"scope":{"kind":"all"},"titleQuery":""})).await.unwrap();
    assert_eq!(
        defaults, explicit,
        "omitted and empty query have one catalog identity"
    );
    let unavailable = fixture.query("list", json!({
        "filter":"all","position":{"kind":"start"},"scope":{"kind":"workspace","sessionId":"foreign"}
    })).await.unwrap_err();
    assert!(
        unavailable.contains("agent_session_unavailable"),
        "{unavailable}"
    );
    let mut filtered = fixture.app.client().subscribe(
        fixture.binding(2).await, "catalog".into(),
        json!({"filter":"all","position":{"kind":"start"},"scope":owned_scope,"titleQuery":"Updated"}),
        scope(&fixture.issuer, true), Attachments::new().into(),
    ).await.unwrap();
    assert_eq!(next(&mut filtered).await["sessions"], json!([]));
    let mut stream = fixture
        .app
        .client()
        .subscribe(
            fixture.binding(2).await,
            "catalog".into(),
            json!({"filter":"all","position":{"kind":"at","cursor":ids[1]}}),
            scope(&fixture.issuer, true),
            Attachments::new().into(),
        )
        .await
        .unwrap();
    let first = next(&mut stream).await;
    assert_eq!(first["sessions"][0]["id"], ids[1]);
    assert_eq!(first["sessions"].as_array().unwrap().len(), 2);
    assert_eq!(first["needsYouCount"], 0);
    assert_eq!(first["before"], ids[1]);

    let changed = fixture
        .mutation(
            2,
            "metadata",
            json!({
                "sessionId":ids[1],"expectedRevision":first["sessions"][0]["revision"],
                "title":"Updated while reading","labels":[],
            }),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
    assert_eq!(changed["kind"], "committed");
    let renamed = next(&mut stream).await;
    assert_eq!(renamed["sessions"][0]["title"], "Updated while reading");
    let matched = next(&mut filtered).await;
    assert_eq!(matched["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(matched["sessions"][0]["id"], ids[1]);
    assert_eq!(matched["sessions"][0]["title"], "Updated while reading");
    assert_eq!(fixture.query("list", json!({"filter":"all","position":{"kind":"start"},"scope":owned_scope,"titleQuery":"updated"})).await.unwrap()["sessions"], json!([]), "title substring matching is case-sensitive");
    fixture
        .store
        .set_session_archived::<StoredSessionConfiguration>(&ids[1], true, 3)
        .await
        .unwrap();
    let archived = next(&mut stream).await;
    assert_eq!(archived["sessions"][0]["id"], ids[2]);
    assert_eq!(
        next(&mut filtered).await["sessions"],
        json!([]),
        "a catalog update replaces its filtered window"
    );
    filtered.cancel();
    tokio::time::timeout(Duration::from_secs(5), filtered.completion())
        .await
        .unwrap();

    // Background pending Sessions outside this page contribute to the exact count.
    let mut background_socket = session_parent_authority::start(&fixture, &model, &ids[0]).await;
    let (background, release) = permissions(
        &fixture.owner,
        &ids[0],
        &["background", "background-second"],
        &mut background_socket,
    )
    .await;
    assert_eq!(
        fixture
            .owner
            .durable
            .interactions()
            .pending(&ids[0])
            .await
            .unwrap()
            .records
            .len(),
        2
    );
    assert_eq!(
        fixture
            .query("observe", json!({"sessionId":ids[0]}))
            .await
            .unwrap()["session"]["activity"],
        "waiting"
    );
    let pending = loop {
        let page = next(&mut stream).await;
        if page["needsYouCount"] == 1 {
            break page;
        }
    };
    assert_eq!(pending["needsYouCount"], 1);
    assert_eq!(pending["sessions"][0]["id"], ids[2]);
    assert_eq!(
        fixture
            .query("list", json!({"filter":"all","position":{"kind":"start"}}))
            .await
            .unwrap()["needsYouCount"],
        1,
        "count sessions, not requests"
    );

    fixture
        .store
        .create_session(
            "foreign",
            "foreign",
            &json!({"invalidPrivateConfiguration":true}),
            1,
        )
        .await
        .unwrap();
    assert_eq!(next(&mut stream).await["sessions"], pending["sessions"]);
    let foreign = ForeignAgent::open(&fixture).await;
    let foreign_session = foreign_mutation(
        &foreign,
        "create",
        fixture.create_input("Foreign owner pending").await,
    )
    .await["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(!fixture.owner.owns(&foreign_session));
    assert!(fixture.query("list",json!({"filter":"all","position":{"kind":"start"},"scope":{"kind":"workspace","sessionId":foreign_session}})).await.unwrap_err().contains("agent_session_unavailable"));
    let queued=foreign_mutation(&foreign,"send",json!({"sessionId":foreign_session,"message":"foreign catalog source","delivery":"queue","backend":model_backend(&fixture.selection().await)})).await;
    assert_eq!(queued["kind"], "queued");
    let (mut foreign_socket, _) = model.accept().await.unwrap();
    request(&mut foreign_socket).await;
    let (foreign_records, foreign_release) = permissions(
        &foreign.owner,
        &foreign_session,
        &["foreign-request"],
        &mut foreign_socket,
    )
    .await;
    assert_eq!(
        foreign
            .owner
            .durable
            .interactions()
            .pending(&foreign_session)
            .await
            .unwrap()
            .records,
        foreign_records
    );
    let private = fixture
        .query(
            "list",
            json!({"filter":"all","position":{"kind":"at","cursor":ids[2]}}),
        )
        .await
        .unwrap();
    assert_eq!(private["needsYouCount"], 1);
    assert_eq!(private["sessions"], pending["sessions"]);

    for request in ["background", "background-second"] {
        fixture
            .owner
            .durable
            .interactions()
            .commit_outcome(
                &ids[0],
                request,
                InteractionOutcome::Closure {
                    reason: ClosureReason::ProducerCancelled,
                    committed_at: now(),
                },
            )
            .await
            .unwrap();
        let updated = loop {
            let updated = next(&mut stream).await;
            // Earlier changes may still have a valid pending snapshot queued.
            if request == "background-second" && updated["needsYouCount"] == 1 {
                continue;
            }
            break updated;
        };
        assert_eq!(
            updated["needsYouCount"],
            if request == "background" { 1 } else { 0 }
        );
    }
    fixture
        .mutation(
            2,
            "stop",
            json!({"sessionId":ids[0],"runId":background[0].execution.run_id}),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
    release.send(()).expect("original background worker held");
    fixture.drained().await;
    for id in &ids[1..] {
        let record = fixture
            .store
            .get_session::<StoredSessionConfiguration>(id)
            .await
            .unwrap()
            .unwrap();
        fixture
            .store
            .begin_session_removal(id, record.revision)
            .await
            .unwrap();
        let updated = loop {
            let page = next(&mut stream).await;
            if page["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row["id"] != *id)
                && (id != &ids[2]
                    || (page["sessions"][0]["id"] == ids[0] && page["before"].is_null()))
            {
                break page;
            }
        };
        assert!(
            updated["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row["id"] != *id)
        );
        if id == &ids[2] {
            assert_eq!(
                updated["sessions"][0]["id"], ids[0],
                "removed anchor resets to the head in the same owner scope"
            );
            assert!(updated["before"].is_null());
            assert!(updated["after"].is_null());
            assert_eq!(
                updated["needsYouCount"], 0,
                "foreign pending session stays excluded"
            );
        }
    }
    foreign_mutation(
        &foreign,
        "stop",
        json!({"sessionId":foreign_session,"runId":foreign_records[0].execution.run_id}),
    )
    .await;
    foreign_release
        .send(())
        .expect("original foreign worker held");
    foreign.app.shutdown().await.unwrap();
    stream.cancel();
    tokio::time::timeout(Duration::from_secs(5), stream.completion())
        .await
        .unwrap();
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn session_lifecycle_is_revision_checked_reversible_and_scoped() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let model = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = session_parent_authority::fixture(&model).await;
        let session = f.create("Remove this conversation").await;
        let other = f.create("Keep this conversation").await;
        let file = f.workspace.join("keep.txt");
        std::fs::write(&file, "user work").unwrap();
        let mut revision = 1;
        for action in ["archive", "restore"] {
            let result = f
                .mutation(
                    2,
                    "changeSession",
                    json!({"sessionId":session,"expectedRevision":revision,"action":action}),
                    Uuid::new_v4(),
                )
                .await
                .unwrap();
            assert_eq!(result["kind"], "changed");
            assert_eq!(result["session"]["archived"], action == "archive");
            revision = result["session"]["revision"].as_u64().unwrap();
        }
        let stale = f
            .mutation(
                2,
                "changeSession",
                json!({"sessionId":session,"expectedRevision":1,"action":"remove"}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(stale["kind"], "revision_conflict");
        let mut socket = session_parent_authority::start(&f, &model, &session).await;
        let (record, release) = session_parent_authority::establish_permissions(
            &f,
            &session,
            "pending-delete",
            maka_sandbox::grant::Permissions {
                filesystem: vec![maka_sandbox::filesystem::Rule {
                    path: f.workspace.join("pending-delete.txt"),
                    scope: maka_sandbox::filesystem::Scope::Exact,
                    access: maka_sandbox::filesystem::Access::Write,
                }],
                network: maka_sandbox::Network::Denied,
            },
            &mut socket,
        )
        .await;
        revision = f
            .store
            .get_session::<StoredSessionConfiguration>(&session)
            .await
            .unwrap()
            .unwrap()
            .revision;
        let busy = f
            .mutation(
                2,
                "changeSession",
                json!({"sessionId":session,"expectedRevision":revision,"action":"remove"}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(busy["reason"], "busy");
        f.owner
            .durable
            .interactions()
            .commit_outcome(
                &session,
                "pending-delete",
                InteractionOutcome::Closure {
                    reason: ClosureReason::ProducerCancelled,
                    committed_at: now(),
                },
            )
            .await
            .unwrap();
        f.mutation(
            2,
            "stop",
            json!({"sessionId":session,"runId":record.execution.run_id}),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        release
            .send(())
            .expect("original pending deletion producer held");
        f.drained().await;
        revision = f
            .store
            .get_session::<StoredSessionConfiguration>(&session)
            .await
            .unwrap()
            .unwrap()
            .revision;
        let removed = f
            .mutation(
                2,
                "changeSession",
                json!({"sessionId":session,"expectedRevision":revision,"action":"remove"}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(removed["kind"], "removed");
        f.drained().await;
        assert!(
            f.store
                .get_session::<StoredSessionConfiguration>(&session)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            f.store
                .get_session::<StoredSessionConfiguration>(&other)
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(std::fs::read_to_string(file).unwrap(), "user work");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn pinning_keeps_title_policy_survives_restart_and_respects_metadata_revision() {
    let mut fixture = Fixture::configured("http://127.0.0.1:1/v1", None, None, None, |settings| {
        settings.automatic_titles = true
    })
    .await;
    for title in ["Pin first", "Pin second", "Pin third"] {
        let mut input = fixture.create_input(title).await;
        input["automaticTitle"] = json!(true);
        fixture
            .mutation(2, "create", input, Uuid::new_v4())
            .await
            .unwrap();
    }
    let original = fixture
        .query("list", json!({"filter":"all","position":{"kind":"start"}}))
        .await
        .unwrap();
    let last = original["sessions"].as_array().unwrap().last().unwrap();
    let id = last["id"].as_str().unwrap();
    assert_eq!(last["pinned"], false);
    let input = json!({"sessionId":id,"expectedRevision":last["revision"],"title":last["title"],"labels":last["labels"],"pinned":true});
    let changed = fixture
        .mutation(2, "metadata", input.clone(), Uuid::new_v4())
        .await
        .unwrap();
    assert_eq!(changed["kind"], "committed");
    assert_eq!(changed["session"]["pinned"], true);
    assert_eq!(
        changed["session"]["boundaryRevision"],
        last["boundaryRevision"]
    );
    let record = fixture
        .store
        .get_session::<StoredSessionConfiguration>(id)
        .await
        .unwrap()
        .unwrap();
    assert!(
        !record.configuration.title_is_manual,
        "pinning must preserve automatic titles"
    );
    let conflict = fixture
        .mutation(2, "metadata", input, Uuid::new_v4())
        .await
        .unwrap();
    assert_eq!(conflict["kind"], "revision_conflict");
    let listed = fixture
        .query("list", json!({"filter":"all","position":{"kind":"start"}}))
        .await
        .unwrap();
    assert_eq!(listed["sessions"][0]["id"], id);
    todo_tests::reopen(&mut fixture).await;
    let observed = fixture
        .query("observe", json!({"sessionId":id}))
        .await
        .unwrap();
    assert_eq!(observed["session"]["pinned"], true);
    let unpinned = fixture.mutation(2,"metadata",json!({"sessionId":id,"expectedRevision":observed["session"]["revision"],"title":last["title"],"labels":last["labels"],"pinned":false}),Uuid::new_v4()).await.unwrap();
    assert_eq!(unpinned["session"]["pinned"], false);
    let listed = fixture
        .query("list", json!({"filter":"all","position":{"kind":"start"}}))
        .await
        .unwrap();
    let ids = |page: &Value| {
        page["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(&listed), ids(&original));
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}
