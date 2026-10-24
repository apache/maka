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

use maka_agent_facts::execution::ModelBinding;
use maka_agent_facts::language::Language;
use maka_agent_facts::model::ModelUsage;
use maka_agent_ports::llm::Generate;
use maka_capabilities::authorization::Boundary;
use maka_capabilities::call::Identity;
use maka_event_log::{
    EventLog,
    effects::{Operation, Outcome as EffectOutcome, Request},
    usage::{AuxiliarySource, Origin, Outcome, Query},
};
use maka_plugin_core::scope::Scope;
use uuid::Uuid;

fn request() -> Request {
    Request {
        source: Identity::Remote {
            request_id: Uuid::new_v4(),
        },
        owner: maka_event_log::effects::Owner {
            package_id: "external-model-client".into(),
            entry_id: "entry".into(),
            scope: Scope::Profile,
            activation: "activation".into(),
            generation: 1,
        },
        boundary: Boundary::Profile,
        operation: Operation::Model {
            input: Generate {
                language: Language::En,
                prompt: "work".into(),
                system: None,
                max_output_tokens: None,
            },
            model: ModelBinding {
                connection_id: "connection".into(),
                connection_slug: "named-connection".into(),
                model: "chosen-model".into(),
            },
            thinking_level: None,
        },
    }
}

fn query() -> Query {
    Query {
        from: 0.0,
        to: f64::MAX,
        session_id: None,
        through: None,
    }
}

#[tokio::test]
async fn auxiliary_accounting_requires_admission_and_preserves_usage_through_failed_recovery() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("auxiliary.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    assert!(
        log.begin_auxiliary_model(
            AuxiliarySource::HostEffect { id: Uuid::new_v4() },
            Language::En,
            None
        )
        .await
        .is_err()
    );
    let parent = log.begin_host_effect(request()).await.unwrap();
    let source = AuxiliarySource::HostEffect { id: parent };
    let quote = serde_json::from_value::<maka_agent_facts::pricing::Quote>(serde_json::json!({
        "providerId":"fixture", "revision":9, "pricing":{
            "modelKey":"fixture:chosen-model", "inputUsdPer1M":1, "outputUsdPer1M":2
        }
    }))
    .unwrap();
    let id = log
        .begin_auxiliary_model(source.clone(), Language::En, Some(quote.clone()))
        .await
        .unwrap();
    assert!(
        log.begin_auxiliary_model(source.clone(), Language::En, None)
            .await
            .is_err(),
        "one accepted generation cannot be physically dispatched twice"
    );
    let usage = ModelUsage {
        input_tokens: Some(77),
        ..Default::default()
    };
    log.observe_auxiliary_model(id, usage.clone())
        .await
        .unwrap();
    assert_eq!(log.model_attempts(query(), 0, 100).await.unwrap().total, 0);
    log.settle_auxiliary_model(id, Outcome::Error)
        .await
        .unwrap();
    log.settle_host_effect(
        parent,
        EffectOutcome::Failed {
            message: "invalid model output".into(),
        },
        None,
    )
    .await
    .unwrap();
    assert!(
        log.observe_auxiliary_model(id, ModelUsage::default())
            .await
            .is_err()
    );
    assert!(
        log.settle_auxiliary_model(id, Outcome::Success)
            .await
            .is_err()
    );
    assert!(
        log.begin_auxiliary_model(source.clone(), Language::En, None)
            .await
            .is_err()
    );
    let before = log.model_attempts(query(), 0, 100).await.unwrap();
    assert_eq!(before.total, 1);
    let attempt = &before.attempts[0];
    assert_eq!(attempt.origin, Origin::Auxiliary { source });
    assert_eq!(attempt.outcome, Outcome::Error);
    assert_eq!(attempt.usage, usage);
    assert_eq!(attempt.quote, Some(quote.clone()));
    assert_eq!(attempt.cost_usd, None, "partial usage is not free");
    let binding = attempt.binding.as_ref().unwrap();
    assert_eq!(binding.connection_slug, "named-connection");
    assert_eq!(binding.model, "chosen-model");

    // Crash after usage arrives but before the effect or model outcome commits.
    let parent = log.begin_host_effect(request()).await.unwrap();
    let interrupted = log
        .begin_auxiliary_model(
            AuxiliarySource::HostEffect { id: parent },
            Language::En,
            Some(quote.clone()),
        )
        .await
        .unwrap();
    let complete_usage = ModelUsage {
        input_tokens: Some(1_000_000),
        output_tokens: Some(2_000_000),
        ..Default::default()
    };
    log.observe_auxiliary_model(interrupted, complete_usage.clone())
        .await
        .unwrap();
    let mut fixed = query();
    fixed.through = Some(log.model_attempts(query(), 0, 100).await.unwrap().through);
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    log.recover_host_effects().await.unwrap();
    log.recover_auxiliary_models().await.unwrap();
    log.recover_auxiliary_models().await.unwrap();
    let after = log.model_attempts(query(), 0, 100).await.unwrap();
    assert_eq!(after.total, 2);
    assert_eq!(after.attempts[0].request_id, interrupted.to_string());
    assert_eq!(after.attempts[0].outcome, Outcome::Unknown);
    assert_eq!(after.attempts[0].usage, complete_usage);
    assert_eq!(after.attempts[0].quote, Some(quote));
    assert_eq!(after.attempts[0].cost_usd, Some(5.0));
    assert_eq!(after.attempts[1], *attempt);
    assert_eq!(
        log.model_attempts(fixed, 0, 100).await.unwrap().attempts,
        before.attempts
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn title_accounting_uses_first_opening_after_stop_and_never_replays_after_recovery() {
    use maka_agent_facts::event::EventWrite;
    use maka_agent_facts::event::Fact;
    use maka_agent_facts::event::Invocation;
    use maka_agent_facts::event::InvocationOutcome;
    use maka_agent_facts::event::RuntimeEvent;
    use maka_agent_facts::execution::*;
    use maka_agent_facts::input::InvocationInput;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("title.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session(
        "title",
        "create",
        &serde_json::json!({"name":"New Chat"}),
        1,
    )
    .await
    .unwrap();
    let invocation = Invocation {
        session_id: "title".into(),
        turn_id: "first".into(),
        run_id: "run".into(),
        invocation_id: "first".into(),
    };
    let source = AuxiliarySource::SessionTitle {
        invocation: invocation.clone(),
    };
    assert!(
        log.begin_auxiliary_model(source.clone(), Language::En, None)
            .await
            .is_err()
    );
    let configuration = InvocationConfiguration {
        language: Language::En,
        compaction_prompt: None,
        workspace_origin: WorkspaceOrigin::Selected,
        approval_policy: ApprovalPolicy::OnRequest,
        boundary_revision: 0,
        cwd: directory.path().to_string_lossy().into_owned(),
        workspace_binding: None,
        workspace_identity: None,
        model: Some(ModelBinding {
            connection_id: "connection".into(),
            connection_slug: "frozen".into(),
            model: "title-model".into(),
        }),
        editing_tools: None,
        tool_discovery: false,
        tool_composition: None,
        system_prompt: None,
        thinking_level: None,
        sandbox_mode: SandboxMode::ReadOnly,
        collaboration_mode: CollaborationMode::Agent,
        orchestration_mode: BehaviorId::default(),
        tool_mode: ToolMode::Direct,
        code_language: Default::default(),
    };
    let opening = Fact::InvocationOpened {
        configuration: Some(Box::new(configuration)),
        input: InvocationInput::Message {
            source_messages: vec![],
            content: "first question".into(),
            request_fingerprint: None,
        },
    };
    log.append(&EventWrite::plain(RuntimeEvent::new(invocation.clone(), opening.clone())).unwrap())
        .await
        .unwrap();
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            invocation.clone(),
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Cancelled {
                    source: "user".into(),
                },
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
    log.set_session_archived::<serde_json::Value>("title", true, 2)
        .await
        .unwrap();
    assert!(
        log.begin_auxiliary_model(source.clone(), Language::En, None)
            .await
            .is_err(),
        "archived Sessions cannot admit title work"
    );
    log.set_session_archived::<serde_json::Value>("title", false, 3)
        .await
        .unwrap();
    let later = Invocation {
        turn_id: "later".into(),
        run_id: "later".into(),
        invocation_id: "later".into(),
        ..invocation.clone()
    };
    log.append(&EventWrite::plain(RuntimeEvent::new(later.clone(), opening)).unwrap())
        .await
        .unwrap();
    assert!(
        log.begin_auxiliary_model(
            AuxiliarySource::SessionTitle {
                invocation: later.clone()
            },
            Language::En,
            None
        )
        .await
        .is_err(),
        "later turns cannot mint title attempts"
    );
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            later,
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Cancelled {
                    source: "user".into(),
                },
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
    let id = log
        .begin_auxiliary_model(source.clone(), Language::En, None)
        .await
        .unwrap();
    assert!(
        log.begin_auxiliary_model(source.clone(), Language::En, None)
            .await
            .is_err()
    );
    log.observe_auxiliary_model(
        id,
        ModelUsage {
            input_tokens: Some(17),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let session = log
        .get_session::<serde_json::Value>("title")
        .await
        .unwrap()
        .unwrap();
    log.begin_session_removal("title", session.revision)
        .await
        .unwrap();
    assert!(
        !log.session_retirement_ready("title").await.unwrap(),
        "pending title accounting retains its Session owner"
    );
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    log.recover_auxiliary_models().await.unwrap();
    assert!(
        log.session_retirement_ready("title").await.unwrap(),
        "exclusive recovery releases the title owner without replay"
    );
    assert!(
        log.begin_auxiliary_model(source.clone(), Language::En, None)
            .await
            .is_err(),
        "unknown title attempts are not replayable"
    );
    let page = log.model_attempts(query(), 0, 10).await.unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.attempts[0].origin, Origin::Auxiliary { source });
    assert_eq!(page.attempts[0].outcome, Outcome::Unknown);
    assert_eq!(
        page.attempts[0].binding.as_ref().unwrap().connection_slug,
        "frozen"
    );
    assert_eq!(page.attempts[0].usage.input_tokens, Some(17));
}

#[test]
fn persisted_host_model_effect_replays_literal_english_input() {
    let original = r#"{"kind":"model","input":{"input":{"prompt":"Original 用户 text","system":null,"maxOutputTokens":null},"model":{"connection_id":"connection","connection_slug":"named","model":"chosen"},"thinking_level":null}}"#;
    let operation: Operation = serde_json::from_str(original).unwrap();
    let Operation::Model { ref input, .. } = operation else {
        panic!("model effect")
    };
    assert_eq!(input.language, Language::En);
    assert_eq!(serde_json::to_string(&operation).unwrap(), original);
}

#[tokio::test]
async fn auxiliary_admission_records_language_without_changing_source_identity() {
    use sqlx::Connection;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("languages.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let mut observer = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(&path),
    )
    .await
    .unwrap();
    for (language, tag) in [
        (Language::En, None),
        (Language::ZhCn, Some("zh-CN")),
        (Language::ZhTw, Some("zh-TW")),
    ] {
        let parent = log.begin_host_effect(request()).await.unwrap();
        let source = AuxiliarySource::HostEffect { id: parent };
        let id = log
            .begin_auxiliary_model(source.clone(), language, None)
            .await
            .unwrap();
        let raw: String = sqlx::query_scalar("SELECT event_json FROM event_log WHERE event_id = ?")
            .bind(id.to_string())
            .fetch_one(&mut observer)
            .await
            .unwrap();
        let record: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(record.get("language").and_then(|value| value.as_str()), tag);
        assert_eq!(
            record["source"],
            serde_json::json!({"kind":"host_effect","id":parent})
        );
        assert!(
            log.begin_auxiliary_model(source, Language::ZhTw, None)
                .await
                .is_err()
        );
    }
}
