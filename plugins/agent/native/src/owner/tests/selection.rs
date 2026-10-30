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
