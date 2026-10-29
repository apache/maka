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
use maka_agent_facts::oauth::LoginStart;
use maka_agent_facts::oauth::Target;
use maka_agent_facts::provider::AuthenticationInput;
use maka_agent_facts::provider::Credential;
use maka_agent_facts::provider::Identity;
use maka_config::{ConfigError, ConfigurationStore, oauth::enrollment::*};
use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_plugin_core::scope::Scope;
use serde_json::json;
use sqlx::Connection;
use std::{path::Path, sync::Arc};

fn namespaces(path: &Path) -> RootNamespaces {
    RootNamespaces {
        ownership: path.join("owners"),
        control: path.join("control"),
    }
}
async fn open(path: &Path, create: bool) -> Arc<ConfigurationStore> {
    let root = path.join("root");
    let owner = if create {
        RootOwner::create(&root, &namespaces(path))
    } else {
        RootOwner::open(&root, &namespaces(path))
    }
    .unwrap();
    Arc::new(ConfigurationStore::for_root(Arc::new(owner)).await.unwrap())
}
async fn prepare(store: &Arc<ConfigurationStore>, input: LoginStart) -> PreparedLogin {
    let LoginPreparation::Ready(ticket) = store.prepare_oauth_login(input).await.unwrap() else {
        panic!("expected unpublished login ticket")
    };
    *ticket
}
fn credential(secret: &str) -> Credential {
    Credential {
        secret: secret.into(),
        refresh_at: Some(50_000),
    }
}
fn create(attempt: &str) -> LoginStart {
    LoginStart {
        expected_credential: None,
        attempt_id: attempt.into(),
        target: Target::Create {
            provider: Identity {
                package_id: "external.account".into(),
                entry_id: "account-entry".into(),
                scope: Scope::Profile,
                name: "account".into(),
            },
            configuration: json!({"endpoint":"https://account.test/v1"}),
            slug: "chosen-account".into(),
            name: "My account".into(),
        },
        authentication: AuthenticationInput {
            method: "account".into(),
            input: json!({"key":"private-input-a"}),
        },
    }
}
async fn existing(store: &ConfigurationStore, attempt: &str, id: &str) -> LoginStart {
    let row = store
        .catalog()
        .await
        .unwrap()
        .connections
        .into_iter()
        .find(|r| r.connection_id == id)
        .unwrap();
    LoginStart {
        expected_credential: match store
            .credential_status(CredentialLocator::Connection {
                connection_id: row.connection_id.clone(),
                kind: ConnectionCredentialKind::Provider,
            })
            .await
            .unwrap()
        {
            maka_agent_facts::configuration::CredentialVaultQueryResult::Status { status } => {
                status.basis()
            }
            _ => panic!("connection status"),
        },
        attempt_id: attempt.into(),
        target: Target::Existing {
            expected: ConnectionCredentialTarget {
                connection_id: row.connection_id,
                revision: row.revision,
                slug: row.slug,
                provider: row.provider,
                configuration: row.configuration.clone(),
            },
            configuration: row.configuration,
        },
        authentication: create(attempt).authentication,
    }
}
async fn sql(path: &Path) -> sqlx::SqliteConnection {
    sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(path.join("root/configuration-rust.sqlite")),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn provider_login_explanation_survives_restart_without_creating_a_connection() {
    use maka_agent_facts::oauth::Failure;
    use maka_agent_facts::oauth::Phase;
    let temp = tempfile::tempdir().unwrap();
    let store = open(temp.path(), true).await;
    let input = create("rejected-login");
    let ticket = prepare(&store, input.clone()).await;
    assert!(ticket.claim().await.unwrap());
    let phase = Phase::Failed {
        failure: Failure::Provider {
            message: "Example provider: account approval required (HTTP 403).".into(),
        },
    };
    assert_eq!(ticket.finish_failure(phase.clone()).await.unwrap(), phase);
    drop(ticket);
    Arc::try_unwrap(store).ok().unwrap().close().await.unwrap();
    let store = open(temp.path(), false).await;
    let LoginPreparation::Finished(receipt) = store.prepare_oauth_login(input).await.unwrap()
    else {
        panic!("a completed rejection must not start authorization again");
    };
    assert_eq!(receipt.phase, phase);
    assert!(store.catalog().await.unwrap().connections.is_empty());
    Arc::try_unwrap(store).ok().unwrap().close().await.unwrap();
}

#[tokio::test]
async fn authentication_receipts_bind_inputs_and_survive_reopen_without_publishing_drafts() {
    let temp = tempfile::tempdir().unwrap();
    let store = open(temp.path(), true).await;
    let input = create("account-login");
    let mut ticket = prepare(&store, input.clone()).await;
    ticket
        .configure_creation(json!({"endpoint":"https://account.test/v1", "oneTimeDefault":true}))
        .unwrap();
    let duplicate = prepare(&store, input.clone()).await;
    let collision = prepare(&store, create("slug-collision")).await;
    assert!(store.catalog().await.unwrap().connections.is_empty());
    assert!(
        store
            .oauth_login_receipt(input.attempt_id.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert!(ticket.claim().await.unwrap());
    assert!(
        !duplicate.claim().await.unwrap(),
        "a claim never permits a second exchange"
    );
    assert!(matches!(
        store.prepare_oauth_login(input.clone()).await.unwrap(),
        LoginPreparation::OutcomeUnknown(_)
    ));
    let LoginCompletion::Committed(receipt) =
        ticket.complete(credential("grant-a"), 1).await.unwrap()
    else {
        panic!("atomic enrollment");
    };
    // A lost commit reply retries persistence, never the grant exchange.
    assert_eq!(
        ticket.complete(credential("grant-a"), 1).await.unwrap(),
        LoginCompletion::Committed(receipt.clone())
    );
    assert_eq!(
        duplicate
            .complete(credential("duplicate"), 1)
            .await
            .unwrap(),
        LoginCompletion::AttemptConflict
    );
    assert_eq!(
        collision
            .complete(credential("collision"), 1)
            .await
            .unwrap(),
        LoginCompletion::SlugTaken
    );
    let snapshot = store.catalog().await.unwrap();
    assert_eq!(snapshot.connections[0], *ticket.connection());
    assert_eq!(
        snapshot.connections[0].provider,
        receipt.connection.provider
    );
    assert_eq!(snapshot.connections[0].slug, "chosen-account");
    assert_eq!(snapshot.connections[0].name, "My account");
    assert_eq!(
        snapshot.connections[0].configuration["oneTimeDefault"],
        true
    );
    drop((ticket, duplicate, collision));
    store.shutdown().await.unwrap();
    drop(store);
    let store = open(temp.path(), false).await;
    assert!(
        matches!(store.prepare_oauth_login(input.clone()).await.unwrap(),
        LoginPreparation::Finished(saved) if saved == receipt)
    );
    let mut different = input.clone();
    different.authentication.input = json!({"key":"private-input-b"});
    assert!(matches!(
        store.prepare_oauth_login(different).await.unwrap(),
        LoginPreparation::Rejected(LoginRejection::AttemptConflict)
    ));
    let mut different = input;
    different.authentication.method = "another-account".into();
    assert!(matches!(
        store.prepare_oauth_login(different).await.unwrap(),
        LoginPreparation::Rejected(LoginRejection::AttemptConflict)
    ));
    assert_eq!(store.catalog().await.unwrap(), snapshot);
    let mut db = sql(temp.path()).await;
    let (target, method, digest): (String, String, String) =
        sqlx::query_as("SELECT target, method, request_fingerprint FROM oauth_login_receipts WHERE attempt_id = 'account-login'")
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert!(!format!("{target}{method}{digest}").contains("private-input"));
    db.close().await.unwrap();
    store.shutdown().await.unwrap();
}

#[tokio::test]
async fn repeated_authentication_retains_original_receipts_across_restart() {
    let temp = tempfile::tempdir().unwrap();
    let store = open(temp.path(), true).await;
    let original = create("initial");
    let ticket = prepare(&store, original.clone()).await;
    ticket
        .complete(credential("initial-grant"), 1)
        .await
        .unwrap();
    let id = ticket.identity().connection_id.clone();
    let uncertain = existing(&store, "uncertain-exchange", &id).await;
    let pending = prepare(&store, uncertain.clone()).await;
    assert!(pending.claim().await.unwrap());
    drop(pending);
    let cancelled = existing(&store, "cancelled-login", &id).await;
    let pending = prepare(&store, cancelled.clone()).await;
    assert!(pending.claim().await.unwrap());
    assert_eq!(
        pending
            .finish_failure(maka_agent_facts::oauth::Phase::Cancelled)
            .await
            .unwrap(),
        maka_agent_facts::oauth::Phase::Cancelled
    );
    assert!(
        matches!(store.prepare_oauth_login(cancelled).await.unwrap(),
        LoginPreparation::Finished(saved) if saved.phase == maka_agent_facts::oauth::Phase::Cancelled)
    );
    drop(pending);
    let mut last = None;
    for n in 0..257 {
        let input = existing(&store, &format!("retained-{n}"), &id).await;
        let ticket = prepare(&store, input.clone()).await;
        assert!(matches!(
            ticket
                .complete(credential("replacement-grant"), n)
                .await
                .unwrap(),
            LoginCompletion::Committed(_)
        ));
        last = Some(input);
    }
    let first = store
        .oauth_login_receipt("retained-0".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first.connection.connection_id, id);
    assert_eq!(first.phase, maka_agent_facts::oauth::Phase::Authenticated);
    assert!(
        store
            .oauth_login_receipt("retained-1".into())
            .await
            .unwrap()
            .is_some()
    );
    let mut db = sql(temp.path()).await;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM oauth_login_receipts")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(
        count, 260,
        "completed receipts and unresolved grant identities remain durable"
    );
    db.close().await.unwrap();
    drop(ticket);
    store.shutdown().await.unwrap();
    drop(store);
    let store = open(temp.path(), false).await;
    let LoginPreparation::Finished(saved) = store.prepare_oauth_login(original).await.unwrap()
    else {
        panic!("original completed login receipt was lost");
    };
    assert_eq!(saved.connection.connection_id, id);
    assert_eq!(saved.phase, maka_agent_facts::oauth::Phase::Authenticated);
    assert!(
        matches!(
            store.prepare_oauth_login(uncertain).await.unwrap(),
            LoginPreparation::OutcomeUnknown(_)
        ),
        "restart must not retry an uncertain authentication callback"
    );
    assert!(matches!(
        store.prepare_oauth_login(last.unwrap()).await.unwrap(),
        LoginPreparation::Finished(_)
    ));
    assert_eq!(store.catalog().await.unwrap().connections.len(), 1);
    store.shutdown().await.unwrap();
}

mod discovery;
mod recovery;

mod inventory;

#[tokio::test]
async fn enrollment_cas_rejects_refresh_and_logout_that_leave_the_connection_unchanged() {
    let temp = tempfile::tempdir().unwrap();
    let store = open(temp.path(), true).await;
    let first = prepare(&store, create("original")).await;
    assert!(first.claim().await.unwrap());
    assert!(matches!(
        first.complete(credential("original-key"), 1).await.unwrap(),
        LoginCompletion::Committed(_)
    ));
    let id = first.identity().connection_id.clone();
    let observed = existing(&store, "stale-observation", &id).await;
    let Target::Existing {
        expected: connection,
        ..
    } = &observed.target
    else {
        unreachable!()
    };
    let connection = connection.clone();
    let before = store.catalog().await.unwrap();
    let current = store
        .provider_credential(connection.clone())
        .await
        .unwrap()
        .unwrap();
    let rotated = current
        .commit_refresh(credential("rotated-key"), 2)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(store.catalog().await.unwrap(), before);
    assert!(matches!(
        store.prepare_oauth_login(observed.clone()).await.unwrap(),
        LoginPreparation::Rejected(LoginRejection::CredentialChanged)
    ));
    assert!(
        store
            .oauth_login_receipt(observed.attempt_id.clone())
            .await
            .unwrap()
            .is_none()
    );
    let after_refresh = existing(&store, "stale-after-logout", &id).await;
    assert_eq!(after_refresh.expected_credential.as_ref(), Some(&rotated));
    assert!(matches!(
        store
            .delete_credential(DeleteCredentialInput {
                expected: rotated,
                expected_connection: Some(connection.clone())
            })
            .await
            .unwrap(),
        CredentialMutationResult::Committed { .. }
    ));
    assert_eq!(
        store.catalog().await.unwrap(),
        before,
        "logout without a saved test does not change the connection"
    );
    assert!(matches!(
        store.prepare_oauth_login(after_refresh).await.unwrap(),
        LoginPreparation::Rejected(LoginRejection::CredentialChanged)
    ));
    let mut fresh = observed;
    fresh.attempt_id = "fresh-after-logout".into();
    fresh.expected_credential = None;
    let ready = prepare(&store, fresh).await;
    assert!(ready.claim().await.unwrap());
    assert!(matches!(
        ready.complete(credential("fresh-key"), 3).await.unwrap(),
        LoginCompletion::Committed(_)
    ));
    let row = ready.connection();
    let value = store
        .provider_credential(ConnectionCredentialTarget {
            connection_id: row.connection_id.clone(),
            revision: row.revision,
            slug: row.slug.clone(),
            provider: row.provider.clone(),
            configuration: row.configuration.clone(),
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(value.credential().secret, "fresh-key");
    assert_ne!(value.basis().credential_id, current.basis().credential_id);
    store.shutdown().await.unwrap();
}

#[tokio::test]
async fn credential_delete_cas_rejects_an_edited_connection_with_the_same_vault_generation() {
    let temp = tempfile::tempdir().unwrap();
    let store = open(temp.path(), true).await;
    let first = prepare(&store, create("delete-original")).await;
    assert!(first.claim().await.unwrap());
    assert!(matches!(
        first
            .complete(credential("keep-this-key"), 1)
            .await
            .unwrap(),
        LoginCompletion::Committed(_)
    ));
    let observed = existing(
        &store,
        "delete-observation",
        &first.identity().connection_id,
    )
    .await;
    let Target::Existing {
        expected: connection,
        ..
    } = observed.target
    else {
        unreachable!()
    };
    let old = observed.expected_credential.unwrap();
    let row = store.catalog().await.unwrap().connections.remove(0);
    let result = store
        .update_connection(UpdateCatalogConnectionInput {
            expected: ConnectionVersionBasis {
                connection_id: row.connection_id.clone(),
                revision: row.revision,
            },
            changes: ConnectionCatalogEntryUpdate {
                name: Some(row.name),
                configuration: Some(json!({"endpoint":"https://changed.test"})),
                enabled: Some(row.enabled),
                enabled_model_ids: Some(row.enabled_model_ids),
                model_overrides: Patch::Keep,
                request_body_overlay: Patch::Keep,
            },
        })
        .await
        .unwrap();
    assert!(matches!(result, CatalogMutationResult::Committed { .. }));
    assert!(matches!(
        store
            .delete_credential(DeleteCredentialInput {
                expected: old.clone(),
                expected_connection: Some(connection)
            })
            .await
            .unwrap(),
        CredentialMutationResult::ConnectionStale { .. }
    ));
    let CredentialVaultQueryResult::Status { status } =
        store.credential_status(old.locator.clone()).await.unwrap()
    else {
        unreachable!()
    };
    assert_eq!(
        status.basis(),
        Some(old.clone()),
        "stale delete must leave the actual generation untouched"
    );
    let row = store.catalog().await.unwrap().connections.remove(0);
    let current = ConnectionCredentialTarget {
        connection_id: row.connection_id,
        revision: row.revision,
        slug: row.slug,
        provider: row.provider,
        configuration: row.configuration,
    };
    assert!(matches!(
        store
            .delete_credential(DeleteCredentialInput {
                expected: old,
                expected_connection: Some(current)
            })
            .await
            .unwrap(),
        CredentialMutationResult::Committed { .. }
    ));
    store.shutdown().await.unwrap();
}

#[test]
fn enrollment_wire_requires_an_explicit_generation_and_rejects_cross_connection_basis() {
    let original = create("wire-input");
    let mut value = serde_json::to_value(&original).unwrap();
    assert!(serde_json::from_value::<LoginStart>(value.clone()).is_ok());
    value.as_object_mut().unwrap().remove("expectedCredential");
    assert!(serde_json::from_value::<LoginStart>(value).is_err());
    let mut invalid = original.clone();
    invalid.expected_credential = Some(CredentialVersionBasis {
        locator: CredentialLocator::Connection {
            connection_id: "00000000-0000-4000-8000-000000000001".into(),
            kind: ConnectionCredentialKind::Provider,
        },
        credential_id: "00000000-0000-4000-8000-000000000002".into(),
        revision: 1,
    });
    assert!(invalid.validate().is_err(), "creation must expect absence");
    let Target::Create {
        provider,
        configuration,
        slug,
        ..
    } = original.target
    else {
        unreachable!()
    };
    invalid.target = Target::Existing {
        expected: ConnectionCredentialTarget {
            connection_id: "00000000-0000-4000-8000-000000000003".into(),
            revision: 1,
            slug,
            provider,
            configuration: configuration.clone(),
        },
        configuration,
    };
    assert!(
        invalid.validate().is_err(),
        "observed generation cannot belong to another recipient"
    );
}

#[test]
fn credential_delete_wire_requires_connection_basis_and_distinguishes_network_credentials() {
    let network = DeleteCredentialInput {
        expected: CredentialVersionBasis {
            locator: CredentialLocator::NetworkProxy {
                kind: PasswordKind::Password,
            },
            credential_id: "00000000-0000-4000-8000-000000000001".into(),
            revision: 1,
        },
        expected_connection: None,
    };
    assert!(validation::delete_credential(&network).is_ok());
    let mut value = serde_json::to_value(&network).unwrap();
    assert!(serde_json::from_value::<DeleteCredentialInput>(value.clone()).is_ok());
    value.as_object_mut().unwrap().remove("expectedConnection");
    assert!(serde_json::from_value::<DeleteCredentialInput>(value).is_err());
    let mut invalid = network;
    invalid.expected.locator = CredentialLocator::Connection {
        connection_id: "00000000-0000-4000-8000-000000000002".into(),
        kind: ConnectionCredentialKind::Provider,
    };
    assert!(validation::delete_credential(&invalid).is_err());
}
