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
use maka_config::ConfigurationStore;
use maka_event_log::root::{RootNamespaces, RootOwner};
use serde_json::json;
use std::sync::Arc;

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
