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

use maka_agent_facts::configuration::*;
use maka_config::{
    ConfigurationStore,
    connection_test::{ConnectionTestPreparation, PreparedConnectionTest},
    model_fetch::ModelFetchPreparation,
};
use maka_event_log::root::{RootNamespaces, RootOwner};
use serde_json::{Value, json};
use std::sync::Arc;
#[path = "header_cases.rs"]
mod header_cases;
#[path = "network_cases.rs"]
mod network_cases;
use crate::support as provider_support;

fn failed(error_class: ConnectionEffectFailureClass) -> ConnectionTestProjection {
    ConnectionTestProjection::Failed {
        checked_at: "2026-09-12T00:00:00.000Z".into(),
        model_id: Some("private-model-result".into()),
        latency_ms: Some(23),
        status_code: Some(401),
        error_class,
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    store: Arc<ConfigurationStore>,
    id: String,
}

impl Fixture {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let namespaces = RootNamespaces {
            ownership: temp.path().join("owners"),
            control: temp.path().join("control"),
        };
        let owner = Arc::new(RootOwner::create(&temp.path().join("root"), &namespaces).unwrap());
        let store = Arc::new(ConfigurationStore::for_root(owner).await.unwrap());
        let input = serde_json::from_value(json!({
            "expectedCatalogRevision":0,
            "connection":{"slug":"relay","name":"Relay","provider":{"packageId":"external","entryId":"api","scope":"profile","name":"api"},
                "configuration":{"baseUrl":"http://127.0.0.1:18080/v1"},"enabled":true,
                "enabledModelIds":["manual"]}
        }))
        .unwrap();
        let CatalogMutationResult::Committed {
            connection: Some(basis),
            ..
        } = store.create_connection(input).await.unwrap()
        else {
            panic!("expected connection commit")
        };
        Self {
            _temp: temp,
            store,
            id: basis.connection_id,
        }
    }

    fn input(&self, model: Option<&str>) -> ConnectionTestRunInput {
        ConnectionTestRunInput {
            connection_id: self.id.clone(),
            model_id: model.map(str::to_owned),
        }
    }

    async fn prepare(&self, model: Option<&str>) -> Box<PreparedConnectionTest> {
        match self
            .store
            .prepare_connection_test(self.input(model))
            .await
            .unwrap()
        {
            ConnectionTestPreparation::Ready(prepared) => prepared,
            _ => panic!("expected prepared test"),
        }
    }

    async fn key(&self) {
        provider_support::login(&self.store, &self.id, "private-fixture-key").await;
    }

    async fn inventory(&self, model: Value) {
        let ModelFetchPreparation::Ready(prepared) =
            self.store.prepare_model_fetch(&self.id).await.unwrap()
        else {
            panic!("expected prepared discovery")
        };
        assert!(matches!(
            prepared
                .complete(vec![serde_json::from_value(model).unwrap()], 100)
                .await
                .unwrap(),
            ConnectionModelFetchResult::Committed { .. }
        ));
    }

    async fn edit(&self, overlay: Option<Value>) {
        let row = self.store.catalog().await.unwrap().connections.remove(0);
        let mut input = json!({
            "expected":{"connectionId":self.id,"revision":row.revision},
            "changes":{"name":"Renamed during test","configuration":row.configuration,
                "enabled":true,"enabledModelIds":row.enabled_model_ids}
        });
        if let Some(overlay) = overlay {
            input["changes"]["requestBodyOverlay"] = overlay;
        }
        assert!(matches!(
            self.store
                .update_connection(serde_json::from_value(input).unwrap())
                .await
                .unwrap(),
            CatalogMutationResult::Committed { .. }
        ));
    }
}

#[tokio::test]
async fn preparation_allows_anonymous_providers_and_admits_only_known_models() {
    let fixture = Fixture::new().await;
    let before = fixture.store.catalog().await.unwrap();
    assert!(
        fixture
            .prepare(None)
            .await
            .provider_credential()
            .unwrap()
            .is_none()
    );
    assert_eq!(fixture.store.catalog().await.unwrap(), before);
    fixture.key().await;
    fixture.inventory(json!({"id":"discovered"})).await;
    let before = fixture.store.catalog().await.unwrap();
    assert!(
        fixture
            .store
            .prepare_connection_test(fixture.input(Some("unknown")))
            .await
            .is_err()
    );
    for model in [None, Some("manual"), Some("discovered")] {
        assert_eq!(fixture.prepare(model).await.model_id(), model);
    }
    assert_eq!(before.connections[0].enabled_model_ids, ["manual"]);
    assert_eq!(fixture.store.catalog().await.unwrap(), before);
}

#[tokio::test]
async fn changed_provider_inputs_and_overlay_supersede_in_flight_verification() {
    let fixture = Fixture::new().await;
    fixture.key().await;
    for model in [
        json!({"id":"manual","apiProtocol":"openai-chat-completions"}),
        json!({"id":"manual","apiProtocol":"openai-responses"}),
    ] {
        let prepared = fixture.prepare(Some("manual")).await;
        fixture.inventory(model).await;
        let before = fixture.store.catalog().await.unwrap();
        assert_eq!(
            prepared
                .complete(failed(ConnectionEffectFailureClass::Auth))
                .await
                .unwrap(),
            ConnectionTestRunResult::Superseded {
                changed: vec![ConnectionEffectChangedDomain::Connection]
            }
        );
        assert_eq!(fixture.store.catalog().await.unwrap(), before);
    }
    let prepared = fixture.prepare(Some("manual")).await;
    fixture
        .inventory(
            json!({"id":"manual","apiProtocol":"openai-responses","displayName":"New title"}),
        )
        .await;
    let before = fixture.store.catalog().await.unwrap();
    let verified = ConnectionTestProjection::Verified {
        checked_at: "2026-09-12T00:00:00.000Z".into(),
        model_id: "manual".into(),
        latency_ms: 8,
    };
    // The provider receives the full model and override. Host cannot assume
    // arbitrary plugin code ignores fields which bundled providers treat as cosmetic.
    assert_eq!(
        prepared.complete(verified.clone()).await.unwrap(),
        ConnectionTestRunResult::Superseded {
            changed: vec![ConnectionEffectChangedDomain::Connection]
        }
    );
    fixture
        .prepare(Some("manual"))
        .await
        .complete(verified.clone())
        .await
        .unwrap();
    let saved = fixture.store.catalog().await.unwrap();
    assert_eq!(saved.connections[0].models, before.connections[0].models);
    assert_eq!(
        saved.connections[0].last_test.as_ref().unwrap().status,
        ConnectionTestStatus::Verified
    );
    for declaration in [
        json!({"displayName":"Configured", "compactionThreshold":8000}),
        json!({"apiProtocol":"openai-chat-completions"}),
    ] {
        let prepared = fixture.prepare(Some("manual")).await;
        let row = fixture.store.catalog().await.unwrap().connections.remove(0);
        let input = serde_json::from_value(json!({
            "expected":{"connectionId":row.connection_id,"revision":row.revision},
            "changes":{"name":row.name,"configuration":row.configuration,"enabled":row.enabled,
                "enabledModelIds":row.enabled_model_ids,"modelOverrides":{"manual":declaration}}
        }))
        .unwrap();
        fixture.store.update_connection(input).await.unwrap();
        assert!(
            fixture.store.catalog().await.unwrap().connections[0]
                .last_test
                .is_none(),
            "changed provider input invalidates connection-test evidence"
        );
        let result = prepared.complete(verified.clone()).await.unwrap();
        assert!(matches!(result, ConnectionTestRunResult::Superseded { .. }));
    }
    let prepared = fixture.prepare(None).await;
    fixture.edit(Some(json!({"temperature":0.5}))).await;
    let before = fixture.store.catalog().await.unwrap();
    assert_eq!(
        prepared.complete(verified).await.unwrap(),
        ConnectionTestRunResult::Superseded {
            changed: vec![ConnectionEffectChangedDomain::Connection]
        }
    );
    assert_eq!(fixture.store.catalog().await.unwrap(), before);
}
