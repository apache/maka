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

use crate::support::root;
use maka_agent_facts::configuration::*;
use maka_config::ConfigurationStore;
use maka_event_log::root::{RootNamespaces, RootOwner};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn plugin_vault_isolates_namespaces_and_retains_cas_through_deletion_and_reopen() {
    use maka_capabilities::credentials::Write;
    use maka_capabilities::credentials::WriteResult;
    use maka_capabilities::storage::Namespace;
    use maka_plugin_core::scope::Scope;
    let temp = tempfile::tempdir().unwrap();
    let owner = root(temp.path());
    let namespace = Namespace::new("example", Scope::Profile).unwrap();
    let store = ConfigurationStore::for_root(owner.clone()).await.unwrap();
    let write = |expected_revision, secret: Option<&str>| Write {
        key: "token".into(),
        expected_revision,
        secret: secret.map(str::to_owned),
    };
    assert_eq!(
        store
            .write_plugin_credential(namespace.clone(), write(None, Some("first")))
            .await
            .unwrap(),
        WriteResult::Written { revision: 1 }
    );
    for other in [
        Namespace::new("other", Scope::Profile).unwrap(),
        Namespace::new("example", Scope::Session("session".into())).unwrap(),
    ] {
        assert!(
            store
                .plugin_credential(other, "token".into())
                .await
                .unwrap()
                .is_none()
        );
    }
    let (left, right) = tokio::join!(
        store.write_plugin_credential(namespace.clone(), write(Some(1), Some("left"))),
        store.write_plugin_credential(namespace.clone(), write(Some(1), Some("right"))),
    );
    let results = [left.unwrap(), right.unwrap()];
    assert_eq!(
        results
            .iter()
            .filter(|value| **value == WriteResult::Written { revision: 2 })
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|value| **value == WriteResult::Conflict { actual: Some(2) })
            .count(),
        1
    );
    assert_eq!(
        store
            .write_plugin_credential(namespace.clone(), write(Some(2), None))
            .await
            .unwrap(),
        WriteResult::Written { revision: 3 }
    );
    store.close().await.unwrap();
    let reopened = ConfigurationStore::for_root(owner).await.unwrap();
    let tombstone = reopened
        .plugin_credential(namespace.clone(), "token".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(tombstone.revision, 3);
    assert!(tombstone.secret.is_none());
    for stale in [None, Some(2)] {
        assert_eq!(
            reopened
                .write_plugin_credential(namespace.clone(), write(stale, Some("stale")))
                .await
                .unwrap(),
            WriteResult::Conflict { actual: Some(3) }
        );
    }
    assert_eq!(
        reopened
            .write_plugin_credential(namespace, write(Some(3), Some("renewed")))
            .await
            .unwrap(),
        WriteResult::Written { revision: 4 }
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn catalog_and_vault_keep_independent_cas_and_private_material_across_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let namespaces = RootNamespaces {
        ownership: temp.path().join("owners"),
        control: temp.path().join("control"),
    };
    let owner = Arc::new(RootOwner::create(&root, &namespaces).unwrap());
    let store = ConfigurationStore::for_root(owner.clone()).await.unwrap();
    let create: CreateCatalogConnectionInput = serde_json::from_value(json!({
        "expectedCatalogRevision":0,
        "connection":{"slug":"local-fixture","name":"Local fixture","provider":{"packageId":"external","entryId":"api","scope":"profile","name":"api"},
        "configuration":{"baseUrl":"http://127.0.0.1:18080/v1"},"enabled":true,"enabledModelIds":["fixture-model"]}
    })).unwrap();
    let created = store.create_connection(create.clone()).await.unwrap();
    let CatalogMutationResult::Committed {
        catalog_revision: 1,
        connection: Some(basis),
    } = created
    else {
        panic!("expected first connection commit");
    };
    assert!(matches!(
        store.create_connection(create).await.unwrap(),
        CatalogMutationResult::RevisionConflict {
            expected_revision: 0,
            actual_revision: 1
        }
    ));
    let locator = CredentialLocator::Connection {
        connection_id: basis.connection_id.clone(),
        kind: ConnectionCredentialKind::RequestHeaders,
    };
    let expected_connection = ConnectionCredentialTarget {
        connection_id: basis.connection_id.clone(),
        revision: 1,
        slug: "local-fixture".into(),
        provider: serde_json::from_value(
            json!({"packageId":"external","entryId":"api","scope":"profile","name":"api"}),
        )
        .unwrap(),
        configuration: json!({"baseUrl":"http://127.0.0.1:18080/v1"}),
    };
    let input = SetCredentialInput {
        locator: locator.clone(),
        expected: None,
        expected_connection: Some(expected_connection.clone()),
        secret: r#"{"X-Fixture":"dummy-private-fixture"}"#.into(),
    };
    let saved = store.set_credential(input.clone(), 42).await.unwrap();
    let CredentialMutationResult::Committed {
        vault_revision: 1,
        status,
    } = saved
    else {
        panic!("expected first credential commit");
    };
    let CredentialState::Configured {
        credential_id,
        revision: 1,
        updated_at: 42,
    } = &status.state
    else {
        panic!("expected configured credential metadata");
    };
    assert!(matches!(
        store.set_credential(input.clone(), 43).await.unwrap(),
        CredentialMutationResult::CredentialStale {
            expected: None,
            actual: Some(_)
        }
    ));
    let mut stale_target = input;
    stale_target
        .expected_connection
        .as_mut()
        .unwrap()
        .configuration = json!({"baseUrl":"http://127.0.0.1:18081/v1"});
    assert!(matches!(
        store.set_credential(stale_target, 44).await.unwrap(),
        CredentialMutationResult::ConnectionStale { .. }
    ));
    let target = ConnectionTarget {
        connection_id: basis.connection_id.clone(),
        model_id: "fixture-model".into(),
    };
    assert!(matches!(
        store
            .set_default_target(SetDefaultConnectionTargetInput {
                expected_catalog_revision: 1,
                target: Some(target.clone()),
            })
            .await
            .unwrap(),
        CatalogMutationResult::Committed {
            catalog_revision: 2,
            connection: None
        }
    ));
    let catalog = store.catalog().await.unwrap();
    assert_eq!(catalog.default_target, Some(target.clone()));
    assert!(
        catalog.connections[0].models.is_empty(),
        "manual enabled model needs no fabricated discovery"
    );
    assert!(
        !serde_json::to_string(&catalog)
            .unwrap()
            .contains("dummy-private-fixture")
    );
    assert!(
        !serde_json::to_string(&status)
            .unwrap()
            .contains("dummy-private-fixture")
    );
    assert_eq!(
        store
            .credential_secret(&locator, Some(&expected_connection))
            .await
            .unwrap()
            .as_deref(),
        Some(r#"{"X-Fixture":"dummy-private-fixture"}"#)
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(root.join("configuration-rust.sqlite"))
                .unwrap()
                .permissions()
                .mode()
                & 0o077,
            0
        );
    }
    drop(owner);
    assert!(
        RootOwner::open(&root, &namespaces).is_err(),
        "configuration store retains root authority"
    );
    store.close().await.unwrap();
    let owner = Arc::new(RootOwner::open(&root, &namespaces).unwrap());
    let store = ConfigurationStore::for_root(owner).await.unwrap();
    assert_eq!(store.catalog().await.unwrap(), catalog);
    let CredentialVaultQueryResult::Status { status: reopened } =
        store.credential_status(locator.clone()).await.unwrap()
    else {
        panic!("expected existing connection");
    };
    assert_eq!(reopened, status);
    assert_eq!(
        store
            .credential_secret(&locator, Some(&expected_connection))
            .await
            .unwrap()
            .as_deref(),
        Some(r#"{"X-Fixture":"dummy-private-fixture"}"#)
    );
    let deleted = store
        .delete_credential(DeleteCredentialInput {
            expected_connection: Some(expected_connection.clone()),
            expected: CredentialVersionBasis {
                locator: locator.clone(),
                credential_id: credential_id.clone(),
                revision: 1,
            },
        })
        .await
        .unwrap();
    assert!(matches!(
        deleted,
        CredentialMutationResult::Committed {
            vault_revision: 2,
            status: CredentialStatus {
                state: CredentialState::Absent,
                ..
            }
        }
    ));
    assert!(
        store
            .credential_secret(&locator, Some(&expected_connection))
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store.catalog().await.unwrap().revision,
        2,
        "vault writes do not invent catalog changes"
    );
}
