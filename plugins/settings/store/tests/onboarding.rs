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

use maka_agent_facts::configuration::onboarding::*;
use maka_agent_facts::configuration::*;
use maka_agent_facts::oauth::LoginStart;
use maka_agent_facts::oauth::Target;
use maka_agent_facts::provider::AuthenticationInput;
use maka_agent_facts::provider::Credential;
use maka_agent_facts::provider::Identity;
use maka_config::{
    ConfigurationStore,
    oauth::enrollment::LoginPreparation,
    onboarding::{OnboardingPreparation, PreparedOnboarding},
};
use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_plugin_core::scope::Scope;
use serde_json::json;
use sqlx::Connection;
use std::sync::Arc;

fn create() -> Target {
    Target::Create {
        provider: Identity {
            package_id: "external.account".into(),
            entry_id: "api".into(),
            scope: Scope::Profile,
            name: "api".into(),
        },
        configuration: json!({"baseUrl":"https://account.test/v1"}),
        slug: "chosen-relay".into(),
        name: "My relay".into(),
    }
}
fn existing(row: &ConnectionCatalogEntry) -> Target {
    Target::Existing {
        expected: ConnectionCredentialTarget {
            connection_id: row.connection_id.clone(),
            revision: row.revision,
            slug: row.slug.clone(),
            provider: row.provider.clone(),
            configuration: row.configuration.clone(),
        },
        configuration: row.configuration.clone(),
    }
}
async fn prepare(store: &Arc<ConfigurationStore>, target: Target) -> Box<PreparedOnboarding> {
    let OnboardingPreparation::Ready(ticket) = store.prepare_onboarding(target).await.unwrap()
    else {
        panic!("expected onboarding ticket")
    };
    ticket
}

#[tokio::test]
async fn onboarding_publishes_atomically_and_rejects_stale_configuration_or_authentication() {
    let temp = tempfile::tempdir().unwrap();
    let namespaces = RootNamespaces {
        ownership: temp.path().join("owners"),
        control: temp.path().join("control"),
    };
    let path = temp.path().join("root");
    let store = Arc::new(
        ConfigurationStore::for_root(Arc::new(RootOwner::create(&path, &namespaces).unwrap()))
            .await
            .unwrap(),
    );
    let ticket = prepare(&store, create()).await;
    assert!(store.catalog().await.unwrap().connections.is_empty());
    assert!(ticket.provider_credential().unwrap().is_none());
    let mut sql = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(path.join("configuration-rust.sqlite")),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER fail_onboard BEFORE UPDATE ON connection_catalog BEGIN SELECT RAISE(ABORT, 'injected'); END")
        .execute(&mut sql).await.unwrap();
    assert!(
        ticket
            .complete(vec![ModelInfo::new("one")], vec![], 1)
            .await
            .is_err()
    );
    assert!(store.catalog().await.unwrap().connections.is_empty());
    let revision: i64 = sqlx::query_scalar("SELECT revision FROM connection_catalog")
        .fetch_one(&mut sql)
        .await
        .unwrap();
    assert_eq!(revision, 0);
    sqlx::query("DROP TRIGGER fail_onboard")
        .execute(&mut sql)
        .await
        .unwrap();
    let first = prepare(&store, create()).await;
    let losing = prepare(&store, create()).await;
    assert!(matches!(
        first
            .complete(
                vec![ModelInfo::new("one"), ModelInfo::new("manual")],
                vec![],
                2,
            )
            .await
            .unwrap(),
        OnboardingSaveResult::Saved { .. }
    ));
    assert_eq!(
        losing
            .complete(vec![ModelInfo::new("one")], vec![], 3)
            .await
            .unwrap(),
        OnboardingSaveResult::Rejected {
            reason: OnboardingRejection::SlugTaken
        }
    );
    let catalog = store.catalog().await.unwrap();
    assert_eq!(catalog.default_target.as_ref().unwrap().model_id, "one");
    let row = &catalog.connections[0];
    assert_eq!(row.name, "My relay");
    let ticket = prepare(&store, existing(row)).await;
    assert!(matches!(
        ticket
            .complete(vec![ModelInfo::new("one")], vec!["one".into()], 4)
            .await
            .unwrap(),
        OnboardingSaveResult::Saved { .. }
    ));
    let row = store.catalog().await.unwrap().connections.remove(0);
    assert_eq!(row.enabled_model_ids, ["one", "manual"]);
    let stale = prepare(&store, existing(&row)).await;
    store
        .update_connection(UpdateCatalogConnectionInput {
            expected: ConnectionVersionBasis {
                connection_id: row.connection_id.clone(),
                revision: row.revision,
            },
            changes: ConnectionCatalogEntryUpdate {
                name: Some("Concurrent rename".into()),
                configuration: Some(row.configuration.clone()),
                enabled: Some(true),
                enabled_model_ids: Some(row.enabled_model_ids.clone()),
                model_overrides: Patch::Keep,
                request_body_overlay: Patch::Keep,
            },
        })
        .await
        .unwrap();
    let before = store.catalog().await.unwrap();
    assert_eq!(
        stale
            .complete(vec![ModelInfo::new("new")], vec![], 5)
            .await
            .unwrap(),
        OnboardingSaveResult::Rejected {
            reason: OnboardingRejection::Superseded
        }
    );
    assert_eq!(store.catalog().await.unwrap(), before);

    // Authentication is a separate accepted operation; discovery cannot overwrite it.
    let target = existing(&before.connections[0]);
    let stale = prepare(&store, target.clone()).await;
    let LoginPreparation::Ready(login) = store
        .prepare_oauth_login(LoginStart {
            expected_credential: None,
            attempt_id: "login".into(),
            target,
            authentication: AuthenticationInput {
                method: "api-key".into(),
                input: json!({"key":"input"}),
            },
        })
        .await
        .unwrap()
    else {
        panic!("login");
    };
    assert!(login.claim().await.unwrap());
    login
        .complete(
            Credential {
                secret: "accepted".into(),
                refresh_at: None,
            },
            6,
        )
        .await
        .unwrap();
    assert_eq!(
        stale
            .complete(vec![ModelInfo::new("new")], vec![], 7)
            .await
            .unwrap(),
        OnboardingSaveResult::Rejected {
            reason: OnboardingRejection::Superseded
        }
    );
    let before = store.catalog().await.unwrap();
    let ticket = prepare(&store, existing(&before.connections[0])).await;
    assert_eq!(
        ticket
            .provider_credential()
            .unwrap()
            .unwrap()
            .credential()
            .secret,
        "accepted"
    );
    drop(ticket);
    sql.close().await.unwrap();
    store.shutdown().await.unwrap();
    drop(store);
    let store =
        ConfigurationStore::for_root(Arc::new(RootOwner::open(&path, &namespaces).unwrap()))
            .await
            .unwrap();
    assert_eq!(store.catalog().await.unwrap(), before);
    store.close().await.unwrap();
}
