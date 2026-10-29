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

use crate::support;
use maka_agent_facts::configuration::*;
use maka_config::ConfigurationStore;
use maka_event_log::root::{RootNamespaces, RootOwner};
use serde_json::json;
use std::sync::Arc;

fn committed_basis(result: CatalogMutationResult) -> ConnectionVersionBasis {
    match result {
        CatalogMutationResult::Committed {
            connection: Some(basis),
            ..
        } => basis,
        other => panic!("expected connection commit, got {other:?}"),
    }
}

#[tokio::test]
async fn edits_preserve_endpoint_ownership_and_removal_durably_cleans_only_its_credentials() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let namespaces = RootNamespaces {
        ownership: temp.path().join("owners"),
        control: temp.path().join("control"),
    };
    let store = Arc::new(
        ConfigurationStore::for_root(Arc::new(RootOwner::create(&root, &namespaces).unwrap()))
            .await
            .unwrap(),
    );
    let create: CreateCatalogConnectionInput = serde_json::from_value(json!({
        "expectedCatalogRevision": 0,
        "connection": {"slug":"relay", "name":"Relay", "provider":{"packageId":"external","entryId":"api","scope":"profile","name":"api"},
            "configuration":{"baseUrl":"http://127.0.0.1:18080/v1"}, "enabled":true,
            "enabledModelIds":["first", "second"],
            "modelOverrides":{"first":{"vision":true}, "second":{"contextWindow":8192}}}
    }))
    .unwrap();
    let mut basis = committed_basis(store.create_connection(create.clone()).await.unwrap());
    let original_basis = basis.clone();
    let profiles = create.connection.model_overrides.clone().unwrap();
    let mut fallback = create;
    fallback.expected_catalog_revision = 1;
    fallback.connection.slug = "available-alternative".into();
    let fallback_basis = committed_basis(store.create_connection(fallback).await.unwrap());
    let target = ConnectionTarget {
        connection_id: basis.connection_id.clone(),
        model_id: "first".into(),
    };
    store
        .set_default_target(SetDefaultConnectionTargetInput {
            expected_catalog_revision: 2,
            target: Some(target.clone()),
        })
        .await
        .unwrap();

    let key = CredentialLocator::Connection {
        connection_id: basis.connection_id.clone(),
        kind: ConnectionCredentialKind::Provider,
    };
    let headers = CredentialLocator::Connection {
        connection_id: basis.connection_id.clone(),
        kind: ConnectionCredentialKind::RequestHeaders,
    };
    let unrelated = CredentialLocator::NetworkProxy {
        kind: PasswordKind::Password,
    };
    support::login(&store, &basis.connection_id, "fixture-key").await;
    basis.revision = store
        .catalog()
        .await
        .unwrap()
        .connections
        .iter()
        .find(|row| row.connection_id == basis.connection_id)
        .unwrap()
        .revision;
    let credential_target = ConnectionCredentialTarget {
        connection_id: basis.connection_id.clone(),
        revision: basis.revision,
        slug: "relay".into(),
        provider: serde_json::from_value(
            json!({"packageId":"external","entryId":"api","scope":"profile","name":"api"}),
        )
        .unwrap(),
        configuration: json!({"baseUrl":"http://127.0.0.1:18080/v1"}),
    };
    for (locator, secret) in [
        (headers.clone(), r#"{"X-Fixture":"headers"}"#),
        (unrelated.clone(), "fixture-password"),
    ] {
        let expected_connection = matches!(locator, CredentialLocator::Connection { .. })
            .then(|| credential_target.clone());
        assert!(matches!(
            store
                .set_credential(
                    SetCredentialInput {
                        locator,
                        expected: None,
                        expected_connection,
                        secret: secret.into(),
                    },
                    42
                )
                .await
                .unwrap(),
            CredentialMutationResult::Committed { .. }
        ));
    }
    // Public queries hide missing connections, so inspect durable rows read-only
    // to distinguish actual credential deletion from inaccessible orphan secrets.
    let database = rusqlite::Connection::open_with_flags(
        root.join("configuration-rust.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let vault_state = || -> (i64, i64) {
        database
            .query_row(
                "SELECT revision, (SELECT COUNT(*) FROM credentials) FROM credential_vault",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    };
    let mut changes: ConnectionCatalogEntryUpdate = serde_json::from_value(json!({
        "name":"Renamed relay", "configuration":{"baseUrl":"http://127.0.0.1:18080/v1"},
        "enabled":true, "enabledModelIds":["first", "second"]
    }))
    .unwrap();
    let edit = async |basis: ConnectionVersionBasis, changes: ConnectionCatalogEntryUpdate| {
        committed_basis(
            store
                .update_connection(UpdateCatalogConnectionInput {
                    expected: basis,
                    changes,
                })
                .await
                .unwrap(),
        )
    };
    basis = edit(basis, changes.clone()).await;
    let row = async || {
        store
            .catalog()
            .await
            .unwrap()
            .connections
            .into_iter()
            .find(|row| row.connection_id == original_basis.connection_id)
            .unwrap()
    };
    assert_eq!(row().await.model_overrides, Some(profiles.clone()));
    let before_stale = store.catalog().await.unwrap();
    let key_status = store.credential_status(key.clone()).await.unwrap();
    let stale_result = CatalogMutationResult::ConnectionStale {
        expected: original_basis.clone(),
        actual: Some(basis.clone()),
    };
    assert_eq!(
        store
            .update_connection(UpdateCatalogConnectionInput {
                expected: original_basis.clone(),
                changes: changes.clone(),
            })
            .await
            .unwrap(),
        stale_result
    );
    assert_eq!(
        store
            .remove_connection(RemoveCatalogConnectionInput {
                expected: original_basis.clone(),
            })
            .await
            .unwrap(),
        stale_result
    );
    assert_eq!(store.catalog().await.unwrap(), before_stale);
    assert_eq!(
        store.credential_status(key.clone()).await.unwrap(),
        key_status
    );
    let stored: maka_agent_facts::provider::Credential =
        serde_json::from_str(&store.credential_secret(&key, None).await.unwrap().unwrap()).unwrap();
    assert_eq!(stored.secret, "fixture-key");
    assert!(stored.refresh_at.is_none());
    assert_eq!(
        vault_state(),
        (3, 3),
        "stale row writes cannot touch the vault"
    );

    changes.enabled_model_ids = Some(vec!["first".into()]);
    basis = edit(basis, changes.clone()).await;
    let first_profile =
        std::collections::BTreeMap::from([("first".to_owned(), profiles["first"].clone())]);
    assert_eq!(
        row().await.model_overrides,
        Some(profiles.clone()),
        "disabling a model must not discard its declaration"
    );
    assert_eq!(store.catalog().await.unwrap().default_target, Some(target));
    changes.configuration = Some(json!({"baseUrl":"http://127.0.0.1:18081/v1"}));
    basis = edit(basis, changes.clone()).await;
    assert_eq!(row().await.model_overrides, None);
    changes.configuration = Some(json!({"baseUrl":"http://127.0.0.1:18082/v1"}));
    changes.model_overrides = Patch::Set(first_profile.clone());
    basis = edit(basis, changes.clone()).await;
    assert_eq!(row().await.model_overrides, Some(first_profile));
    changes.model_overrides = Patch::Keep;
    changes.enabled = Some(false);
    basis = edit(basis, changes).await;
    let disabled = store.catalog().await.unwrap();
    assert!(
        disabled
            .connections
            .iter()
            .any(|row| row.connection_id == fallback_basis.connection_id && row.enabled)
    );
    assert_eq!(
        disabled.default_target, None,
        "disabling the default must not select a fallback"
    );

    let removal = RemoveCatalogConnectionInput { expected: basis };
    let removed = store.remove_connection(removal.clone()).await.unwrap();
    let catalog = store.catalog().await.unwrap();
    assert_eq!(
        removed,
        CatalogMutationResult::Committed {
            catalog_revision: disabled.revision + 1,
            connection: None,
        }
    );
    assert_eq!(catalog.connections.len(), 1);
    assert_eq!(
        catalog.connections[0].connection_id,
        fallback_basis.connection_id
    );
    assert_eq!(
        vault_state(),
        (4, 1),
        "both related secrets share one vault revision"
    );
    assert_eq!(
        store
            .credential_secret(&unrelated, None)
            .await
            .unwrap()
            .as_deref(),
        Some("fixture-password")
    );
    assert_eq!(
        store.remove_connection(removal.clone()).await.unwrap(),
        removed
    );
    assert_eq!(vault_state(), (4, 1));
    store.shutdown().await.unwrap();
    drop(store);
    let store =
        ConfigurationStore::for_root(Arc::new(RootOwner::open(&root, &namespaces).unwrap()))
            .await
            .unwrap();
    assert_eq!(store.catalog().await.unwrap(), catalog);
    assert_eq!(store.remove_connection(removal).await.unwrap(), removed);
    assert_eq!(vault_state(), (4, 1));
    assert_eq!(
        store
            .credential_secret(&unrelated, None)
            .await
            .unwrap()
            .as_deref(),
        Some("fixture-password")
    );
    assert_eq!(
        store.credential_status(key).await.unwrap(),
        CredentialVaultQueryResult::ConnectionNotFound
    );
}

#[tokio::test]
async fn partial_updates_reopen_and_preserve_fields_until_the_connection_configuration_changes() {
    let temp = tempfile::tempdir().unwrap();
    let owner = crate::support::root(temp.path());
    let store = ConfigurationStore::for_root(owner.clone()).await.unwrap();
    let configuration =
        json!({"baseUrl":"https://relay.example/v1", "routingNotes":"route: east\n"});
    let profiles = json!({"first":{"vision":true}});
    let basis = committed_basis(store.create_connection(serde_json::from_value(json!({
        "expectedCatalogRevision":0,"connection":{"slug":"relay","name":"Original",
        "provider":{"packageId":"external","entryId":"api","scope":"profile","name":"api"},
        "configuration":configuration,"enabled":true,"enabledModelIds":["first","second"],"modelOverrides":profiles}
    })).unwrap()).await.unwrap());
    let original = store.catalog().await.unwrap().connections.remove(0);
    store.close().await.unwrap();
    let store = ConfigurationStore::for_root(owner).await.unwrap();
    assert_eq!(
        store.catalog().await.unwrap().connections.as_slice(),
        std::slice::from_ref(&original)
    );
    let renamed_basis = committed_basis(
        store
            .update_connection(UpdateCatalogConnectionInput {
                expected: basis.clone(),
                changes: serde_json::from_value(json!({"name":"Renamed"})).unwrap(),
            })
            .await
            .unwrap(),
    );
    let renamed = store.catalog().await.unwrap().connections.remove(0);
    assert_eq!(renamed.name, "Renamed");
    assert_eq!(renamed.configuration, configuration);
    assert_eq!(renamed.enabled_model_ids, ["first", "second"]);
    assert_eq!(renamed.model_overrides, original.model_overrides);
    assert_eq!(
        store
            .update_connection(UpdateCatalogConnectionInput {
                expected: basis.clone(),
                changes: serde_json::from_value(json!({"enabled":false,"enabledModelIds":[]}))
                    .unwrap(),
            })
            .await
            .unwrap(),
        CatalogMutationResult::ConnectionStale {
            expected: basis,
            actual: Some(renamed_basis.clone())
        }
    );
    assert!(
        store
            .update_connection(UpdateCatalogConnectionInput {
                expected: renamed_basis.clone(),
                changes: serde_json::from_value(json!({"configuration":null})).unwrap(),
            })
            .await
            .is_err()
    );
    assert_eq!(store.catalog().await.unwrap().connections, [renamed]);
    let disabled_basis = committed_basis(
        store
            .update_connection(UpdateCatalogConnectionInput {
                expected: renamed_basis,
                changes: serde_json::from_value(json!({"enabled":false,"enabledModelIds":[]}))
                    .unwrap(),
            })
            .await
            .unwrap(),
    );
    let disabled = store.catalog().await.unwrap().connections.remove(0);
    assert!(!disabled.enabled);
    assert!(disabled.enabled_model_ids.is_empty());
    assert_eq!(disabled.model_overrides, original.model_overrides);
    let changed_basis = committed_basis(
        store
            .update_connection(UpdateCatalogConnectionInput {
                expected: disabled_basis,
                changes: serde_json::from_value(
                    json!({"configuration":{"baseUrl":"https://changed.example/v1"}}),
                )
                .unwrap(),
            })
            .await
            .unwrap(),
    );
    assert!(
        store.catalog().await.unwrap().connections[0]
            .model_overrides
            .is_none()
    );
    committed_basis(store.update_connection(UpdateCatalogConnectionInput {
        expected:changed_basis, changes:serde_json::from_value(json!({
            "configuration":{"baseUrl":"https://reviewed.example/v1"},"modelOverrides":profiles
        })).unwrap(),
    }).await.unwrap());
    assert_eq!(
        store.catalog().await.unwrap().connections[0].model_overrides,
        original.model_overrides
    );
    store.close().await.unwrap();
}
