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
        owner: maka_event_log::effects::Owner::Resource(maka_event_log::effects::ResourceOwner {
            package_id: "external-model-client".into(),
            entry_id: "entry".into(),
            scope: Scope::Profile,
            activation: "activation".into(),
            generation: 1,
        }),
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
    let replayed = log
        .host_effect(
            maka_capabilities::storage::Namespace::new("external-model-client", Scope::Profile)
                .unwrap(),
            parent,
        )
        .await
        .unwrap()
        .unwrap();
    let Operation::Model { input, model, .. } = replayed.request.operation else {
        panic!("reopened model effect changed operation");
    };
    assert_eq!(input.language, Language::En);
    assert_eq!(input.prompt, "work");
    assert_eq!(model.model, "chosen-model");
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
