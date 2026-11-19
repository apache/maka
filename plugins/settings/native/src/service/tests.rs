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
use maka_event_log::root::{RootNamespaces, RootOwner};
use serde_json::json;

#[tokio::test]
async fn ollama_cloud_enabled_model_resolves_to_a_settings_choice() {
    let directory = tempfile::tempdir().unwrap();
    let root = Arc::new(
        RootOwner::create(
            &directory.path().join("root"),
            &RootNamespaces {
                ownership: directory.path().join("owners"),
                control: directory.path().join("control"),
            },
        )
        .unwrap(),
    );
    let configuration = maka_config::ConfigurationStore::for_root(root)
        .await
        .unwrap();
    let revision = configuration.catalog().await.unwrap().revision;
    let committed = configuration.create_connection(serde_json::from_value(json!({
        "expectedCatalogRevision":revision,
        "connection":{
            "slug":"ollama-cloud","name":"Ollama Cloud",
            "provider":{"packageId":maka_providers::api::ID,"entryId":maka_providers::api::ID,"scope":"profile","name":"ollama-cloud"},
            "configuration":{"baseUrl":"https://ollama.com/v1"},
            "enabled":true,"enabledModelIds":["deepseek-v4-flash"]
        }
    })).unwrap()).await.unwrap();
    assert!(matches!(committed, CatalogMutationResult::Committed { .. }));
    let catalog = configuration.catalog().await.unwrap();
    let row = &catalog.connections[0];
    let snapshot = Arc::new(maka_providers::catalog::Snapshot::bundled().unwrap());
    assert!(selectable(row, snapshot.clone()));
    let choice = model_choice(row, &row.enabled_model_ids[0], snapshot)
        .await
        .unwrap();
    assert_eq!(choice.selection.model_id, "deepseek-v4-flash");
    assert_eq!(choice.selection.connection_id, row.connection_id);
    configuration.shutdown().await.unwrap();
}

#[tokio::test]
async fn dictation_lists_only_configured_official_connections_without_exposing_keys() {
    let directory = tempfile::tempdir().unwrap();
    let root = Arc::new(
        RootOwner::create(
            &directory.path().join("root"),
            &RootNamespaces {
                ownership: directory.path().join("owners"),
                control: directory.path().join("control"),
            },
        )
        .unwrap(),
    );
    let store = maka_config::ConfigurationStore::for_root(root)
        .await
        .unwrap();
    let store = Arc::new(store);
    for (slug, url) in [
        ("personal", "https://api.deepseek.com"),
        ("relay", "https://example.com"),
    ] {
        let revision = store.catalog().await.unwrap().revision;
        let result = store.create_connection(serde_json::from_value(json!({
            "expectedCatalogRevision":revision,"connection":{"slug":slug,"name":slug,
            "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"deepseek"},
            "configuration":{"baseUrl":url},"enabled":true,"enabledModelIds":[]}
        })).unwrap()).await.unwrap();
        assert!(matches!(result, CatalogMutationResult::Committed { .. }));
    }
    assert_eq!(
        crate::connections::dictation_connections(&store)
            .await
            .unwrap(),
        json!([])
    );
    for row in store.catalog().await.unwrap().connections {
        use maka_agent_facts::{
            oauth::{LoginStart, Target},
            provider::{AuthenticationInput, Credential},
        };
        use maka_config::oauth::enrollment::{LoginCompletion, LoginPreparation};
        let input = LoginStart {
            attempt_id: format!("dictation-{}", row.slug),
            expected_credential: None,
            authentication: AuthenticationInput {
                method: "api_key".into(),
                input: json!({}),
            },
            target: Target::Existing {
                configuration: row.configuration.clone(),
                expected: ConnectionCredentialTarget {
                    connection_id: row.connection_id,
                    revision: row.revision,
                    slug: row.slug,
                    provider: row.provider,
                    configuration: row.configuration,
                },
            },
        };
        let LoginPreparation::Ready(ticket) = store.prepare_oauth_login(input).await.unwrap()
        else {
            panic!("expected login ticket")
        };
        assert!(ticket.claim().await.unwrap());
        assert!(matches!(
            ticket
                .complete(
                    Credential {
                        secret: "test-only".into(),
                        refresh_at: None
                    },
                    10
                )
                .await
                .unwrap(),
            LoginCompletion::Committed(_)
        ));
    }
    let options = crate::connections::dictation_connections(&store)
        .await
        .unwrap();
    let choices = options.as_array().unwrap();
    assert_eq!(choices.len(), 1);
    assert_eq!(choices[0]["name"], "personal");
    assert_eq!(choices[0].as_object().unwrap().len(), 2);
    // A malformed recording stops after resolving the stored model credential, before networking.
    let request = DictationInput {
        connection: serde_json::from_value(choices[0]["basis"].clone()).unwrap(),
        audio: "invalid".into(),
    };
    assert_eq!(
        crate::connections::transcribe(&store, request)
            .await
            .unwrap_err(),
        "Invalid recording"
    );
    store.shutdown().await.unwrap();
}
