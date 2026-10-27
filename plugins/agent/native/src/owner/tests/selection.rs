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
use maka_agent_engine::ModelSource;

pub(super) async fn edit(
    fixture: &Fixture,
    change: impl FnOnce(&mut ConnectionCatalogEntryUpdate),
) {
    let row = fixture
        .config
        .catalog()
        .await
        .unwrap()
        .connections
        .remove(0);
    let mut changes = ConnectionCatalogEntryUpdate {
        name: Some(row.name),
        configuration: Some(row.configuration),
        enabled: Some(row.enabled),
        enabled_model_ids: Some(row.enabled_model_ids),
        model_overrides: Patch::Keep,
        request_body_overlay: Patch::Keep,
    };
    change(&mut changes);
    assert!(matches!(
        fixture
            .config
            .update_connection(UpdateCatalogConnectionInput {
                expected: ConnectionVersionBasis {
                    connection_id: row.connection_id,
                    revision: row.revision
                },
                changes,
            })
            .await
            .unwrap(),
        CatalogMutationResult::Committed { .. }
    ));
}
async fn settings(fixture: &Fixture) -> Binding {
    let client = fixture.app.client();
    client
        .bind(client.activation(&id(2)).unwrap(), "settings".into())
        .await
        .unwrap()
        .remove(0)
}
async fn models(fixture: &Fixture, input: Value) -> Result<Value, String> {
    fixture
        .app
        .client()
        .start(
            settings(fixture).await,
            "models".into(),
            input,
            scope(&fixture.issuer, true),
            Attachments::new().into(),
        )
        .await?
        .result()
        .await
}

#[tokio::test]
async fn explicit_models_switch_in_one_session_and_stale_selection_has_no_admission() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for (expected, text, reported) in [
                ("fixture-model", "Answer from the requested alias", Some("fixture-model-2026-10-01")),
                ("second-model", "Answer without provider model metadata", None),
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let body = request(&mut socket).await;
                assert_eq!(body["model"], expected);
                let mut delta = json!({"id":"selected-model","choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]});
                if let Some(reported) = reported {delta["model"] = json!(reported);}
                let end = json!({"id":"selected-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}});
                let body = format!("data: {delta}\n\ndata: {end}\n\ndata: [DONE]\n\n");
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            }
        });
        let mut fixture = Fixture::new(&base, None).await;
        let session = fixture.create("Per-message model choice").await;
        let stale = fixture.selection().await;
        edit(&fixture, |changes| {
            changes
                .enabled_model_ids
                .as_mut()
                .unwrap()
                .push("second-model".into())
        })
        .await;
        assert!(
            fixture
                .mutation(
                    2,
                    "send",
                    json!({"sessionId":session,"message":"Stale","model":stale}),
                    Uuid::new_v4()
                )
                .await
                .is_err()
        );
        let observed = fixture
            .query("observe", json!({"sessionId":session}))
            .await
            .unwrap();
        assert!(observed["run"].is_null());
        let page = fixture
            .query(
                "history",
                json!({"sessionId":session,"position":{"kind":"start"}}),
            )
            .await
            .unwrap();
        assert!(page["chunks"].as_array().unwrap().is_empty());
        for model in ["fixture-model", "second-model"] {
            let mut selected = fixture.selection().await;
            selected.model_id = model.into();
            let started = fixture
                .mutation(
                    2,
                    "send",
                    json!({"sessionId":session,"message":"Chosen model","model":selected}),
                    Uuid::new_v4(),
                )
                .await
                .unwrap();
            assert_eq!(started["sessionId"], session);
            fixture.drained().await;
        }
        server.await.unwrap();
        let mut historical_answers = Vec::new();
        let mut current_model_after_restart = Value::Null;
        for after_restart in [false,true] {
            if after_restart {
                edit(&fixture,|changes|changes.enabled_model_ids.as_mut().unwrap().push("current-picker-model".into())).await;
                let selected = fixture.selection().await;
                let saved = fixture.mutation(2,"selectBackend",json!({"sessionId":session,"backend":{
                    "kind":"model","connectionId":selected.connection_id,"modelId":"current-picker-model","thinkingLevel":null
                }}),Uuid::new_v4()).await.unwrap();
                assert_eq!(saved["kind"],"committed");
                todo_tests::reopen(&mut fixture).await;
                current_model_after_restart = fixture.query("observe",json!({"sessionId":session})).await.unwrap()["session"]["backend"]["modelId"].clone();
            }
            let mut history_request = json!({"sessionId":session,"position":{"kind":"start"}});
            let mut assistant_chunks = Vec::new();
            let mut history_finished = false;
            for _ in 0..128 {
                let page = fixture.query("history",history_request.clone()).await.unwrap();
                history_request["through"] = page["through"].clone();
                assert_eq!(page["kind"], "ready");
                assistant_chunks.extend(page["chunks"].as_array().unwrap().iter()
                    .filter(|chunk|chunk["role"] == "assistant")
                    .map(|chunk|json!({"text":chunk["text"],"model":chunk["model"]})));
                if page["after"].is_null() {history_finished = true;break;}
                history_request["position"] = json!({"kind":"after","cursor":page["after"]});
            }
            historical_answers.push((assistant_chunks,history_finished));
        }
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
        assert_eq!(current_model_after_restart,"current-picker-model");
        for (assistant_chunks,history_finished) in historical_answers {
        assert!(history_finished,"history must reach its captured fence");
        assert_eq!(assistant_chunks,json!([
            {"text":"Answer from the requested alias","model":{"kind":"native","requestedModelId":"fixture-model","reportedModelId":"fixture-model-2026-10-01"}},
            {"text":"Answer without provider model metadata","model":{"kind":"native","requestedModelId":"second-model","reportedModelId":null}}
        ]).as_array().unwrap().clone(),"history must associate each actual answer with its own requested and provider-reported model evidence");
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn captured_execution_ignores_catalog_labels_and_other_models_but_rejects_execution_changes()
{
    let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let session = fixture.create("Original execution basis").await;
    edit(&fixture, |changes| {
        changes.model_overrides = Patch::Set(BTreeMap::from([(
            "fixture-model".into(),
            ModelOverride {
                max_output_tokens: Some(16_384),
                ..Default::default()
            },
        )]));
    })
    .await;
    let public = ModelInfo {
        context_window: Some(128_000),
        max_output_tokens: Some(4096),
        thinking_levels: Some(vec![ThinkingLevel::Low, ThinkingLevel::High]),
        default_thinking_level: Some(ThinkingLevel::High),
        capabilities: Some(ModelCapabilities {
            vision: Some(true),
            ..Default::default()
        }),
        ..ModelInfo::new("fixture-model")
    };
    *fixture.owner.catalog.snapshot.write().await = Ok(Arc::new(
        maka_providers::catalog::Snapshot::for_model(
            "openai-compatible",
            "fixture-model",
            Some(public.clone()),
        )
        .unwrap(),
    ));
    let (mut source, _) = crate::model::Source::select(
        fixture.config.clone(),
        fixture.owner.catalog.clone(),
        fixture.owner.credentials.clone(),
        fixture.selection().await,
        None,
        session.clone(),
        fixture.owner.revision.clone(),
    )
    .await
    .unwrap();
    let persisted = serde_json::to_string(&source.accepted).unwrap();
    assert!(!persisted.contains("private-fixture-key"));
    let stored: Value = serde_json::from_str(&persisted).unwrap();
    assert_eq!(stored["public_model"]["maxOutputTokens"], 4096);
    let mut missing = stored.clone();
    missing.as_object_mut().unwrap().remove("public_model");
    assert!(
        serde_json::from_value::<crate::model::AcceptedModel>(missing).is_err(),
        "captured absence must be explicit null, never inferred from a missing field"
    );
    let refreshed_public = ModelInfo {
        context_window: Some(1_000_000),
        max_output_tokens: Some(8192),
        default_thinking_level: Some(ThinkingLevel::Low),
        capabilities: Some(ModelCapabilities {
            vision: Some(false),
            ..Default::default()
        }),
        ..public
    };
    *fixture.owner.catalog.snapshot.write().await = Ok(Arc::new(
        maka_providers::catalog::Snapshot::for_model(
            "openai-compatible",
            "fixture-model",
            Some(refreshed_public),
        )
        .unwrap(),
    ));
    for prepared in [
        source.capture().await.unwrap(),
        source.capture_auxiliary().await.unwrap(),
    ] {
        assert_eq!(prepared.main_output_limit, Some(4096));
        assert_eq!(
            prepared.context.unwrap().model_context_window,
            Some(128_000)
        );
        assert!(prepared.supports_vision);
    }
    source = crate::model::Source::restore(
        fixture.config.clone(),
        fixture.owner.credentials.clone(),
        serde_json::from_str(&persisted).unwrap(),
        session,
        fixture.owner.revision.clone(),
    )
    .unwrap();
    let recovered = source.capture().await.unwrap();
    assert_eq!(recovered.main_output_limit, Some(4096));
    assert_eq!(
        recovered
            .options
            .as_object()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>(),
        vec![json!({"reasoningEffort":"high"})],
    );
    assert!(recovered.supports_vision);
    let choices = models(&fixture, json!({"kind":"start","query":"fixture-model"}))
        .await
        .unwrap();
    assert_eq!(choices["choices"][0]["limits"]["contextWindow"], 1_000_000);
    assert_eq!(choices["choices"][0]["limits"]["maxOutputTokens"], 8192);
    assert_eq!(choices["choices"][0]["defaultThinkingLevel"], "low");
    let (_, next) = crate::model::Source::select(
        fixture.config.clone(),
        fixture.owner.catalog.clone(),
        fixture.owner.credentials.clone(),
        fixture.selection().await,
        None,
        "new-public-defaults".into(),
        fixture.owner.revision.clone(),
    )
    .await
    .unwrap();
    assert_eq!(next.main_output_limit, Some(8192));
    assert_eq!(next.context.unwrap().model_context_window, Some(1_000_000));
    assert!(!next.supports_vision);
    edit(&fixture, |changes| {
        changes.name = Some("A different label".into());
        changes
            .enabled_model_ids
            .as_mut()
            .unwrap()
            .push("other-model".into());
        changes.model_overrides = Patch::Set(BTreeMap::from([
            (
                "fixture-model".into(),
                ModelOverride {
                    display_name: Some("Visible name".into()),
                    description: Some("Updated description".into()),
                    knowledge_cutoff: Some("2026".into()),
                    max_output_tokens: Some(16_384),
                    ..Default::default()
                },
            ),
            (
                "other-model".into(),
                ModelOverride {
                    max_output_tokens: Some(900),
                    ..Default::default()
                },
            ),
        ]));
    })
    .await;
    let next = source.capture().await.unwrap();
    assert_eq!(next.provider.model, "fixture-model");
    assert_eq!(next.provider.base_url, "http://127.0.0.1:1/v1");
    let credential = fixture
        .config
        .observe_model(source.accepted.binding.clone())
        .await
        .unwrap()
        .unwrap()
        .credential
        .unwrap();
    assert!(
        credential
            .commit_refresh(
                maka_agent_facts::provider::Credential {
                    secret: "refreshed-fixture-key".into(),
                    refresh_at: None
                },
                2
            )
            .await
            .unwrap()
            .is_some()
    );
    let refreshed = source.capture().await.unwrap();
    assert!(
        matches!(refreshed.provider.auth, maka_model::ProviderAuth::ApiKey(ref key) if key == "refreshed-fixture-key")
    );
    edit(&fixture, |changes| {
        changes.model_overrides = Patch::Set(BTreeMap::from([(
            "fixture-model".into(),
            ModelOverride {
                max_output_tokens: Some(64),
                ..Default::default()
            },
        )]))
    })
    .await;
    assert!(source.capture().await.is_err());
    let (current, _) = crate::model::Source::select(
        fixture.config.clone(),
        fixture.owner.catalog.clone(),
        fixture.owner.credentials.clone(),
        fixture.selection().await,
        None,
        "current".into(),
        fixture.owner.revision.clone(),
    )
    .await
    .unwrap();
    edit(&fixture, |changes| {
        changes.configuration = Some(json!({"baseUrl":"http://127.0.0.1:2/v1"}))
    })
    .await;
    assert!(current.capture().await.is_err());
    let (current, _) = crate::model::Source::select(
        fixture.config.clone(),
        fixture.owner.catalog.clone(),
        fixture.owner.credentials.clone(),
        fixture.selection().await,
        None,
        "current".into(),
        fixture.owner.revision.clone(),
    )
    .await
    .unwrap();
    edit(&fixture, |changes| {
        changes.enabled_model_ids = Some(vec!["other-model".into()])
    })
    .await;
    assert!(current.capture().await.is_err());
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn ordinary_settings_pages_keep_root_revision_and_exact_default_cas_without_secrets() {
    let first = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let second = Fixture::new("http://127.0.0.1:2/v1", None).await;
    edit(&first, |changes| {
        changes.enabled_model_ids = Some((0..20).map(|at| format!("model-{at:02}")).collect())
    })
    .await;
    let page = models(&first, json!({"kind":"start"})).await.unwrap();
    assert_eq!(page["defaultModel"], json!({"kind":"none"}));
    assert_eq!(page["choices"].as_array().unwrap().len(), 16);
    assert!(serde_json::to_vec(&page).unwrap().len() < 48 * 1024);
    assert!(!page.to_string().contains("private-fixture-key"));
    assert!(!page.to_string().contains("baseUrl"));
    let continuation = json!({"kind":"continue","revision":page["revision"],"cursor":page["next"]});
    let last = models(&first, continuation.clone()).await.unwrap();
    assert_eq!(last["choices"].as_array().unwrap().len(), 4);
    assert!(last["next"].is_null());
    let other = models(&second, json!({"kind":"start"})).await.unwrap();
    assert_eq!(other["choices"].as_array().unwrap().len(), 1);
    assert_ne!(
        other["choices"][0]["selection"]["connectionId"],
        page["choices"][0]["selection"]["connectionId"]
    );
    let binding = settings(&first).await;
    let operation = Uuid::new_v4();
    let input = json!({"expectedCatalogRevision":page["revision"],"target":{"connectionId":page["choices"][0]["selection"]["connectionId"],"modelId":"model-19"}});
    let client = first.app.client();
    assert!(
        client
            .prepare_mutation(
                binding.clone(),
                "setDefault".into(),
                input.clone(),
                scope(&first.issuer, false),
                operation,
                Attachments::new().into()
            )
            .await
            .is_err()
    );
    assert!(
        client
            .prepare_mutation(
                binding.clone(),
                "setDefault".into(),
                json!({"expectedCatalogRevision":page["revision"]}),
                scope(&first.issuer, true),
                operation,
                Attachments::new().into()
            )
            .await
            .is_err()
    );
    let prepared = client
        .prepare_mutation(
            binding,
            "setDefault".into(),
            input,
            scope(&first.issuer, true),
            operation,
            Attachments::new().into(),
        )
        .await
        .unwrap();
    let recorded = first
        .store
        .record_application_intent(
            prepared.reference().source.clone(),
            prepared.consumer().instance().clone(),
            prepared.reference().clone(),
            serde_json::Value::Null,
        )
        .await
        .unwrap();
    let reply = client
        .mutate(prepared, recorded)
        .await
        .unwrap()
        .result()
        .await;
    assert!(
        matches!(reply.receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { ref value }, .. } if value["kind"] == "committed")
    );
    let changed = models(&first, continuation).await.unwrap();
    assert_eq!(changed["kind"], "changed");
    let new = models(&first, json!({"kind":"start"})).await.unwrap();
    assert_eq!(new["defaultModel"]["kind"], "ready");
    assert_eq!(
        new["defaultModel"]["choice"]["selection"]["modelId"],
        "model-19"
    );
    assert_eq!(
        new["defaultModel"]["choice"]["selection"]["revision"],
        new["choices"][0]["selection"]["revision"]
    );
    assert!(
        !new["choices"]
            .as_array()
            .unwrap()
            .iter()
            .any(|choice| choice["selection"]["modelId"] == "model-19")
    );
    assert!(new["choices"][0].get("isDefault").is_none());
    assert!(models(&first, json!({"kind":"continue","revision":new["revision"],"cursor":{"connection":0,"model":4000}})).await.is_err());
    // A valid Root default can belong to a provider outside this capability's
    // selectable catalog. It must remain visible as unavailable, not disappear
    // or silently become the first available choice.
    let CatalogMutationResult::Committed {
        catalog_revision,
        connection: Some(unsupported),
    } = first.config.create_connection(serde_json::from_value(json!({
        "expectedCatalogRevision":new["revision"],
        "connection":{
            "slug":"other-provider","name":"Other provider",
            "provider":{"packageId":"example.models","entryId":"models","scope":"profile","name":"custom"},
            "configuration":{},"enabled":true,"enabledModelIds":["other-model"]
        }
    })).unwrap()).await.unwrap() else { panic!("other provider commit"); };
    let target = ConnectionTarget {
        connection_id: unsupported.connection_id,
        model_id: "other-model".into(),
    };
    assert!(matches!(
        first
            .config
            .set_default_target(SetDefaultConnectionTargetInput {
                expected_catalog_revision: catalog_revision,
                target: Some(target.clone()),
            })
            .await
            .unwrap(),
        CatalogMutationResult::Committed {
            connection: None,
            ..
        }
    ));
    let unavailable = models(&first, json!({"kind":"start"})).await.unwrap();
    assert_eq!(
        unavailable["defaultModel"],
        json!({"kind":"unavailable","target":target})
    );
    assert_eq!(unavailable["choices"].as_array().unwrap().len(), 16);
    assert_eq!(
        first.config.catalog().await.unwrap().default_target,
        Some(target)
    );
    first.app.shutdown().await.unwrap();
    second.app.shutdown().await.unwrap();
    first.config.shutdown().await.unwrap();
    second.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn model_search_reaches_sparse_matches_and_true_eof_with_catalog_fences() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let long_term = format!("{}終", "界".repeat(257));
    edit(&fixture, |changes| {
        changes.name = Some(format!("Research Account {long_term}"));
        changes.enabled_model_ids = Some((0..300).map(|at| format!("model-{at:03}")).collect());
    })
    .await;
    let browsing_query = format!("RESEARCH {long_term}");
    let browsing = models(&fixture, json!({"kind":"start","query":browsing_query}))
        .await
        .unwrap();
    assert_eq!(browsing["choices"].as_array().unwrap().len(), 16);
    assert_eq!(browsing["next"]["query"], browsing_query);
    let continuation =
        json!({"kind":"continue","revision":browsing["revision"],"cursor":browsing["next"]});
    assert!(
        models(&fixture, json!({"kind":"start","query":null}))
            .await
            .is_err()
    );
    let query = format!("RESEARCH {long_term} model-299");
    let found = models(&fixture, json!({"kind":"start","query":query}))
        .await
        .unwrap();
    assert_eq!(found["choices"].as_array().unwrap().len(), 1);
    assert_eq!(found["choices"][0]["selection"]["modelId"], "model-299");
    assert!(found["next"].is_null());
    assert!(!found.to_string().contains("private-fixture-key"));
    assert!(!found.to_string().contains("baseUrl"));
    // A distinct tail beyond the old text boundary must participate in matching.
    let missing_tail = format!("RESEARCH {}異 model-299", "界".repeat(257));
    let missing = models(&fixture, json!({"kind":"start","query":missing_tail}))
        .await
        .unwrap();
    assert!(missing["choices"].as_array().unwrap().is_empty());
    assert!(missing["next"].is_null());
    let matches = models(&fixture, json!({"kind":"start","query":"MoDeL-29"}))
        .await
        .unwrap();
    assert_eq!(matches["choices"].as_array().unwrap().len(), 10);
    assert_eq!(matches["choices"][0]["selection"]["modelId"], "model-290");
    assert_eq!(matches["choices"][9]["selection"]["modelId"], "model-299");
    assert!(matches["next"].is_null());
    let none = models(
        &fixture,
        json!({"kind":"start","query":"research missing-token"}),
    )
    .await
    .unwrap();
    assert!(none["choices"].as_array().unwrap().is_empty());
    assert!(none["next"].is_null());
    edit(&fixture, |changes| {
        changes.name = Some("Renamed Account".into())
    })
    .await;
    let changed = models(&fixture, continuation).await.unwrap();
    assert_eq!(changed["kind"], "changed");
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn queued_model_route_change_settles_original_message_without_retargeting() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let (mut capture, _log_guard) = log_capture();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let fixture = Fixture::new(&base, None).await;
        let connection = fixture.selection().await.connection_id;
        let session = fixture.create("Queued original model").await;
        fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        let queued = fixture.send(&session).await.unwrap();
        assert_eq!(queued["kind"], "queued");
        edit(&fixture, |changes| changes.configuration = Some(json!({"baseUrl":"http://127.0.0.1:1/v1"}))).await;
        response(&mut socket).await;
        fixture.drained().await;
        assert!(fixture.session(&session).await.pending_messages(&session).await.unwrap().is_empty());
        let facts = fixture.session(&(session)).await.scoped_prefix(maka_agent_facts::event::LogScope::Session { id: session.clone() }, 256, 1024 * 1024).await.unwrap();
        assert!(facts.events.iter().any(|event| matches!(&event.event.fact, maka_agent_facts::event::Fact::InvocationEnded { outcome: maka_agent_facts::event::InvocationOutcome::Failed { class, .. } } if class == "message_preparation_failed")));
        assert_eq!(facts.events.iter().filter(|event| matches!(event.event.fact, maka_agent_facts::event::Fact::InvocationOpened { .. })).count(), 2);
        let diagnostics=fixture.query("diagnostics",json!({"sessionId":session,"position":{"kind":"latest"}})).await;
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
        let failed = facts.events.iter().find(|event|matches!(&event.event.fact,maka_agent_facts::event::Fact::InvocationEnded {
            outcome:maka_agent_facts::event::InvocationOutcome::Failed {class,..}} if class == "message_preparation_failed")).unwrap();
        let diagnostics=diagnostics.expect("queued preparation failure must be available through public diagnostics");
        assert_eq!(diagnostics["entries"].as_array().unwrap().len(),1);
        let entry=&diagnostics["entries"][0];
        assert_eq!(entry["sequence"],failed.sequence);
        assert_eq!(entry["eventId"],failed.event.id);
        assert_eq!(entry["detail"]["kind"],"execution");
        assert_eq!(entry["detail"]["invocation"],serde_json::to_value(&failed.event.invocation).unwrap());
        assert_eq!(entry["detail"]["reason"],"message_preparation_failed");
        assert!(entry["detail"]["modelFailure"].is_null(),"a deterministic queued route conflict is not a provider failure");
        let log = log_text(&mut capture);
        let cause = log.lines().find(|line| line.contains("stage=\"accepted_model_observation\"")
            && line.contains("cause=\"accepted_configuration_changed\""))
            .expect("accepted route rejection must retain the original configuration-change cause");
        assert!(cause.contains("session_id=") && cause.contains(&session));
        assert!(cause.contains("connection_id=") && cause.contains(&connection));
        for secret in ["private-fixture-key", base.as_str(), "http://127.0.0.1:1/v1", "Hello"] {
            assert!(!log.contains(secret), "accepted route warning must not dump either configuration or the queued message");
        }
    }).await.unwrap();
}

#[tokio::test]
async fn queue_promotion_rejects_a_different_accepted_model_execution() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let fixture = Fixture::new(&base, None).await;
        let session = fixture.create("Different queued model").await;
        let started = fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        edit(&fixture, |changes| changes.configuration = Some(json!({"baseUrl":"http://127.0.0.1:1/v1"}))).await;
        let queued = fixture.send(&session).await.unwrap();
        let result = fixture.mutation(2, "editQueue", json!({"sessionId":session,"expectedRevision":queued["revision"],"edit":{"kind":"promote","messageId":queued["messageId"]}}), Uuid::new_v4()).await.unwrap();
        assert_eq!(result, json!({"kind":"rejected","reason":"execution_changed"}));
        assert_eq!(fixture.query("queue", json!({"sessionId":session})).await.unwrap()["entries"][0]["kind"], "followup");
        fixture.mutation(2, "stop", json!({"sessionId":session,"invocationId":started["invocationId"]}), Uuid::new_v4()).await.unwrap();
        fixture.drained().await;
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

pub(super) async fn thinking(
    fixture: &Fixture,
    levels: Vec<maka_agent_facts::execution::ThinkingLevel>,
    default: maka_agent_facts::execution::ThinkingLevel,
) {
    edit(fixture, |changes| {
        changes.model_overrides = Patch::Set(BTreeMap::from([(
            "fixture-model".into(),
            ModelOverride {
                thinking_levels: Some(levels),
                default_thinking_level: Some(default),
                ..Default::default()
            },
        )]));
    })
    .await;
}

#[tokio::test]
async fn thinking_choices_reach_requests_and_queued_policy_cannot_steer_another_run() {
    use maka_agent_facts::execution::ThinkingLevel::High;
    use maka_agent_facts::execution::ThinkingLevel::Low;
    use maka_agent_facts::execution::ThinkingLevel::Off;
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let fixture = Fixture::new(&base, None).await;
        thinking(&fixture, vec![Off, Low, High], High).await;
        let page = models(&fixture, json!({"kind":"start"})).await.unwrap();
        assert_eq!(page["choices"][0]["thinkingLevels"], json!(["off", "low", "high"]));
        assert_eq!(page["choices"][0]["defaultThinkingLevel"], "high");
        let session = fixture.create("Per-message thinking").await;
        let selection = fixture.selection().await;
        // Omission selects the configured default; explicit Off is a different policy.
        fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        assert_eq!(request(&mut socket).await["reasoning_effort"], "high");
        for level in [Off, Low] {
            let result = fixture.mutation(2, "send", json!({"sessionId":session,"message":"chosen thinking","model":selection,"thinkingLevel":level}), Uuid::new_v4()).await.unwrap();
            assert_eq!(result["kind"], "queued");
        }
        assert!(fixture.mutation(2, "send", json!({"sessionId":session,"message":"unsupported","model":selection,"thinkingLevel":"ultra"}), Uuid::new_v4()).await.is_err());
        let pending = fixture.session(&session).await.pending_messages(&session).await.unwrap();
        assert_eq!(pending.len(), 2);
        for (entry, level) in pending.iter().zip([Off, Low]) {
            let basis: MessageBasis = serde_json::from_value(entry.execution.basis.clone()).unwrap();
            assert_eq!(basis.model.unwrap().thinking_level, Some(level));
        }
        let queue = fixture.query("queue", json!({"sessionId":session})).await.unwrap();
        let rejected = fixture.mutation(2, "editQueue", json!({"sessionId":session,"expectedRevision":queue["revision"],"edit":{"kind":"promote","messageId":pending[0].source.message.message_id}}), Uuid::new_v4()).await.unwrap();
        assert_eq!(rejected, json!({"kind":"rejected","reason":"execution_changed"}));
        response(&mut socket).await;
        for expected in ["none", "low"] {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(request(&mut socket).await["reasoning_effort"], expected);
            response(&mut socket).await;
        }
        fixture.drained().await;
        assert!(fixture.session(&session).await.pending_messages(&session).await.unwrap().is_empty());
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn restored_thinking_preserves_explicit_choice_and_refuses_changed_default_or_support() {
    use maka_agent_facts::execution::ThinkingLevel::High;
    use maka_agent_facts::execution::ThinkingLevel::Low;
    let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    thinking(&fixture, vec![Low, High], High).await;
    let session = fixture.create("Restored thinking policy").await;
    let mut sources = Vec::new();
    for level in [None, Some(High)] {
        let (source, prepared) = crate::model::Source::select(
            fixture.config.clone(),
            fixture.owner.catalog.clone(),
            fixture.owner.credentials.clone(),
            fixture.selection().await,
            level,
            session.clone(),
            fixture.owner.revision.clone(),
        )
        .await
        .unwrap();
        let encoded = serde_json::to_vec(&source.accepted).unwrap();
        let restored = crate::model::Source::restore(
            fixture.config.clone(),
            fixture.owner.credentials.clone(),
            serde_json::from_slice(&encoded).unwrap(),
            session.clone(),
            fixture.owner.revision.clone(),
        )
        .unwrap();
        assert_eq!(restored.capture().await.unwrap().options, prepared.options);
        sources.push((restored, prepared.options));
    }
    thinking(&fixture, vec![Low, High], Low).await;
    assert!(sources[0].0.capture().await.is_err());
    assert_eq!(sources[1].0.capture().await.unwrap().options, sources[1].1);
    thinking(&fixture, vec![Low], Low).await;
    assert!(sources[1].0.capture().await.is_err());
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn unsupported_thinking_logs_original_provider_cause_without_admitting_execution() {
    use maka_agent_facts::execution::ThinkingLevel::Low;
    tokio::time::timeout(Duration::from_secs(30), async {
        const MESSAGE: &str = "submitted-message-must-not-enter-model-log";
        let (mut capture, _log_guard) = log_capture();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let fixture = Fixture::new(&base, None).await;
        thinking(&fixture, vec![Low], Low).await;
        let session = fixture.create("Provider preparation failure").await;
        let selection = fixture.selection().await;
        let connection = selection.connection_id.clone();
        let result = fixture
            .mutation(
                2,
                "send",
                json!({
                    "sessionId": session,
                    "message": MESSAGE,
                    "model": selection,
                    "thinkingLevel": "high"
                }),
                Uuid::new_v4(),
            )
            .await;
        fixture.drained().await;
        let facts = fixture.session(&(session)).await.scoped_prefix(
                maka_agent_facts::event::LogScope::Session {
                    id: session.clone(),
                },
                256,
                1024 * 1024,
            )
            .await
            .unwrap();
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
        let dispatched = match listener.into_std().unwrap().accept() {
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => false,
            Ok(_) => true,
            Err(error) => panic!("observe actual provider listener: {error}"),
        };
        let log = log_text(&mut capture);
        assert_eq!(result.unwrap_err(), "agent_execution_unavailable");
        assert!(
            !facts.events.iter().any(|event| matches!(
                event.event.fact,
                maka_agent_facts::event::Fact::InvocationOpened { .. }
            )),
            "preparation rejection must not admit an invocation"
        );
        assert!(
            !dispatched,
            "unsupported thinking must fail before provider HTTP dispatch"
        );
        let cause = log
            .lines()
            .find(|line| {
                line.contains("stage=\"provider_prepare\"")
                    && line.contains("cause=\"provider_invalid\"")
            })
            .expect(
                "actual typed provider rejection must be logged before its public cause is erased",
            );
        assert!(cause.contains("reason=\"unsupported_thinking_level\""),
            "the original deterministic preparation reason must survive public sanitization: {cause}");
        assert!(
            cause.contains("session_id=") && cause.contains(&session),
            "warning must identify the existing session: {cause}"
        );
        assert!(
            cause.contains("connection_id=") && cause.contains(&connection),
            "warning must identify the existing connection: {cause}"
        );
        for secret in ["private-fixture-key", base.as_str(), MESSAGE] {
            assert!(
                !log.contains(secret),
                "model cause log must omit credentials, URLs and submitted input"
            );
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn invalid_thinking_default_remains_unavailable_without_poisoning_other_models() {
    use maka_agent_facts::execution::ThinkingLevel::High;
    use maka_agent_facts::execution::ThinkingLevel::Low;
    let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    thinking(&fixture, vec![Low], High).await;
    edit(&fixture, |changes| {
        changes
            .enabled_model_ids
            .as_mut()
            .unwrap()
            .extend((0..260).map(|at| format!("other-{at}")));
    })
    .await;
    let catalog = fixture.config.catalog().await.unwrap();
    let target = ConnectionTarget {
        connection_id: catalog.connections[0].connection_id.clone(),
        model_id: "fixture-model".into(),
    };
    fixture
        .config
        .set_default_target(SetDefaultConnectionTargetInput {
            expected_catalog_revision: catalog.revision,
            target: Some(target.clone()),
        })
        .await
        .unwrap();
    let page = models(&fixture, json!({"kind":"start"})).await.unwrap();
    assert_eq!(
        page["defaultModel"],
        json!({"kind":"unavailable","target":target})
    );
    assert_eq!(page["choices"].as_array().unwrap().len(), 16);
    assert!(
        page["choices"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["selection"]["modelId"] != "fixture-model")
    );
    // Search still advances over the omitted model and non-matching rows.
    let page = models(&fixture, json!({"kind":"start","query":"fixture-model"}))
        .await
        .unwrap();
    assert!(page["choices"].as_array().unwrap().is_empty());
    assert!(page["next"].is_null());
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn accepted_tool_policy_survives_settings_changes_and_requires_explicit_fields() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let session = fixture.create("Frozen tool policy").await;
    edit(&fixture, |changes| {
        changes.model_overrides = Patch::Set(BTreeMap::from([(
            "fixture-model".into(),
            ModelOverride {
                code_mode: Some(true),
                code_mode_language: Some(maka_agent_facts::execution::CodeLanguage::Python),
                apply_patch: Some(false),
                context_window: Some(1_000_000),
                input_limit: Some(900_000),
                compaction_threshold: Some(700_000),
                ..Default::default()
            },
        )]));
    })
    .await;
    let (source, prepared) = crate::model::Source::select(
        fixture.config.clone(),
        fixture.owner.catalog.clone(),
        fixture.owner.credentials.clone(),
        fixture.selection().await,
        None,
        session.clone(),
        fixture.owner.revision.clone(),
    )
    .await
    .unwrap();
    assert_eq!(source.accepted.tool_mode, ToolMode::CodeMode);
    assert_eq!(
        source.accepted.code_language,
        maka_agent_facts::execution::CodeLanguage::Python
    );
    assert_eq!(
        source.accepted.editing_tools,
        Some(maka_agent_facts::execution::EditingTools::Structured)
    );
    let context = prepared.context.unwrap();
    assert_eq!(context.model_context_window, Some(1_000_000));
    assert_eq!(context.context_window, Some(900_000));
    assert_eq!(context.declared_window, Some(700_000));
    let stored = serde_json::to_value(&source.accepted).unwrap();
    assert!(stored.as_object().unwrap().contains_key("public_model"));
    assert!(stored["public_model"].is_null());
    *fixture.owner.catalog.snapshot.write().await = Ok(Arc::new(
        maka_providers::catalog::Snapshot::for_model(
            "openai-compatible",
            "fixture-model",
            Some(ModelInfo {
                max_output_tokens: Some(4096),
                ..ModelInfo::new("fixture-model")
            }),
        )
        .unwrap(),
    ));
    edit(&fixture, |changes| {
        changes.model_overrides = Patch::Set(BTreeMap::from([(
            "fixture-model".into(),
            ModelOverride {
                code_mode: Some(false),
                apply_patch: Some(true),
                context_window: Some(128_000),
                input_limit: Some(96_000),
                ..Default::default()
            },
        )]));
    })
    .await;
    let restored = crate::model::Source::restore(
        fixture.config.clone(),
        fixture.owner.credentials.clone(),
        serde_json::from_value(stored.clone()).unwrap(),
        session.clone(),
        fixture.owner.revision.clone(),
    )
    .unwrap();
    assert_eq!(restored.capture().await.unwrap().context, Some(context));
    assert_eq!(restored.accepted.tool_mode, ToolMode::CodeMode);
    assert_eq!(
        restored.accepted.code_language,
        maka_agent_facts::execution::CodeLanguage::Python
    );
    assert_eq!(
        restored.accepted.editing_tools,
        Some(maka_agent_facts::execution::EditingTools::Structured)
    );
    assert_eq!(serde_json::to_value(&restored.accepted).unwrap(), stored);
    let (next, prepared) = crate::model::Source::select(
        fixture.config.clone(),
        fixture.owner.catalog.clone(),
        fixture.owner.credentials.clone(),
        fixture.selection().await,
        None,
        session.clone(),
        fixture.owner.revision.clone(),
    )
    .await
    .unwrap();
    let context = prepared.context.unwrap();
    assert_eq!(context.model_context_window, Some(128_000));
    assert_eq!(context.context_window, Some(96_000));
    assert_eq!(context.declared_window, Some(81_600));
    assert_eq!(next.accepted.tool_mode, ToolMode::Direct);
    assert_eq!(
        next.accepted.code_language,
        maka_agent_facts::execution::CodeLanguage::JavaScript
    );
    assert_eq!(
        next.accepted.editing_tools,
        Some(maka_agent_facts::execution::EditingTools::ApplyPatch)
    );
    let mut unfiltered = stored.clone();
    unfiltered["editing_tools"] = Value::Null;
    let accepted: crate::model::AcceptedModel = serde_json::from_value(unfiltered.clone()).unwrap();
    assert_eq!(accepted.editing_tools, None);
    assert_eq!(serde_json::to_value(&accepted).unwrap(), unfiltered);
    for field in ["tool_mode", "editing_tools"] {
        let mut missing = stored.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<crate::model::AcceptedModel>(missing).is_err(),
            "accepted tool policy requires an explicit {field}"
        );
    }
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn model_filter_distinguishes_connections_and_preserves_search_across_pages() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let ids: Vec<_> = (0..20).map(|at| format!("family/shared.{at:02}")).collect();
    edit(&fixture, |changes| {
        changes.name = Some("OpenRouter".into());
        changes.enabled_model_ids = Some(ids.clone());
        changes.model_overrides = Patch::Set(BTreeMap::from([
            (
                "family/shared.00".into(),
                ModelOverride {
                    context_window: Some(8192),
                    ..Default::default()
                },
            ),
            (
                "family/shared.01".into(),
                ModelOverride {
                    context_window: Some(16384),
                    ..Default::default()
                },
            ),
        ]));
    })
    .await;
    let original = fixture.config.catalog().await.unwrap();
    let first = &original.connections[0];
    let created = fixture
        .config
        .create_connection(
            serde_json::from_value(json!({
                "expectedCatalogRevision": original.revision,
                "connection": {
                    "slug":"custom", "name":"Custom connection", "provider":first.provider,
                    "configuration":first.configuration, "enabled":true,
                    "enabledModelIds":ids,
                }
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let CatalogMutationResult::Committed {
        connection: Some(custom),
        catalog_revision,
    } = created
    else {
        panic!("custom connection commit");
    };
    let target = ConnectionTarget {
        connection_id: first.connection_id.clone(),
        model_id: "family/shared.00".into(),
    };
    fixture
        .config
        .set_default_target(SetDefaultConnectionTargetInput {
            expected_catalog_revision: catalog_revision,
            target: Some(target),
        })
        .await
        .unwrap();
    let summaries = fixture.config.connection_summaries().await.unwrap();
    assert_eq!(
        summaries
            .connections
            .iter()
            .map(|row| (row.name.as_str(), row.enabled_model_count))
            .collect::<Vec<_>>(),
        vec![("OpenRouter", 20), ("Custom connection", 20)]
    );
    let scoped = fixture
        .config
        .model_catalog(Some(&custom.connection_id))
        .await
        .unwrap();
    let default = scoped
        .connections
        .iter()
        .find(|row| row.connection_id == first.connection_id)
        .unwrap();
    assert_eq!(default.enabled_model_ids, vec!["family/shared.00"]);
    assert_eq!(
        default
            .model_overrides
            .as_ref()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec!["family/shared.00"]
    );
    let all = models(&fixture, json!({"kind":"start","query":"family/shared.00"}))
        .await
        .unwrap();
    assert_eq!(
        all["choices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|choice| choice["connectionName"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["OpenRouter", "Custom connection"]
    );
    let page = models(
        &fixture,
        json!({"kind":"start","query":"shared","connectionId":custom.connection_id}),
    )
    .await
    .unwrap();
    assert_eq!(page["choices"].as_array().unwrap().len(), 16);
    assert_eq!(page["next"]["connectionId"], custom.connection_id);
    assert_eq!(
        page["defaultModel"]["choice"]["limits"]["contextWindow"],
        8192
    );
    assert_eq!(
        page["defaultModel"]["choice"]["selection"]["connectionId"],
        first.connection_id
    );
    assert_eq!(
        page["defaultModel"]["choice"]["selection"]["modelId"],
        "family/shared.00"
    );
    let last = models(
        &fixture,
        json!({"kind":"continue","revision":page["revision"],"cursor":page["next"]}),
    )
    .await
    .unwrap();
    let choices: Vec<_> = page["choices"]
        .as_array()
        .unwrap()
        .iter()
        .chain(last["choices"].as_array().unwrap())
        .collect();
    assert_eq!(
        choices
            .iter()
            .map(|choice| choice["selection"]["modelId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        (0..20)
            .map(|at| format!("family/shared.{at:02}"))
            .collect::<Vec<_>>()
    );
    assert!(
        choices
            .iter()
            .all(|choice| choice["selection"]["connectionId"] == custom.connection_id)
    );
    assert!(last["next"].is_null());
    let missing = models(
        &fixture,
        json!({"kind":"start","query":"absent","connectionId":custom.connection_id}),
    )
    .await
    .unwrap();
    assert_eq!(missing["choices"], json!([]));
    fixture
        .config
        .set_default_target(SetDefaultConnectionTargetInput {
            expected_catalog_revision: summaries.revision,
            target: Some(ConnectionTarget {
                connection_id: first.connection_id.clone(),
                model_id: "family/shared.02".into(),
            }),
        })
        .await
        .unwrap();
    let without_override = models(
        &fixture,
        json!({"kind":"start","query":"family/shared.00","connectionId":custom.connection_id}),
    )
    .await
    .unwrap();
    assert_eq!(
        without_override["defaultModel"]["choice"]["selection"]["modelId"],
        "family/shared.02"
    );
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}
