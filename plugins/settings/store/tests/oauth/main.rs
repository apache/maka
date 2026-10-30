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
use maka_config::{ConfigError, ConfigurationStore, oauth::ProviderCredential};
use maka_event_log::root::{RootNamespaces, RootOwner};
use serde_json::json;
use std::sync::Arc;

#[path = "fixture.rs"]
mod fixture;
use fixture::{Fixture, credential, namespaces};

#[tokio::test]
async fn refresh_cas_preserves_generation_across_races_logout_aba_and_reopen() {
    let mut fixture = Fixture::new("opaque-account").await;
    fixture.login("old-grant").await;
    let original = fixture.snapshot().await;
    let before = fixture.store.catalog().await.unwrap();
    let (first, second) = tokio::join!(
        original.commit_refresh(credential("first-rotation"), 11),
        original.commit_refresh(credential("second-rotation"), 11),
    );
    let (first, second) = (first.unwrap(), second.unwrap());
    assert_ne!(
        first.is_some(),
        second.is_some(),
        "exactly one writer can rotate this generation"
    );
    let winner = first.or(second).unwrap();
    assert_eq!(winner.credential_id, original.basis().credential_id);
    assert_eq!(winner.revision, original.basis().revision + 1);
    assert_eq!(
        fixture.store.catalog().await.unwrap(),
        before,
        "rotation changes only the vault"
    );
    let current = fixture.snapshot().await;
    assert_eq!(current.basis(), &winner);
    assert!(matches!(
        current.credential().secret.as_str(),
        "first-rotation" | "second-rotation"
    ));
    assert_eq!(
        original.credential().secret.as_str(),
        "old-grant",
        "admitted snapshots are immutable"
    );
    let public = serde_json::to_string(
        &fixture
            .store
            .credential_status(winner.locator.clone())
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(!public.contains(current.credential().secret.as_str()));
    let deleted = fixture
        .store
        .delete_credential(DeleteCredentialInput {
            expected_connection: Some(fixture.target.clone()),
            expected: winner.clone(),
        })
        .await
        .unwrap();
    assert!(matches!(
        deleted,
        CredentialMutationResult::Committed { .. }
    ));
    assert!(
        fixture
            .store
            .provider_credential(fixture.target.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        current
            .commit_refresh(credential("late-after-logout"), 12)
            .await
            .unwrap()
            .is_none()
    );
    // Re-login with the same bytes and revision 1 must not resurrect the old ID.
    fixture.login("old-grant").await;
    let relogged = fixture.snapshot().await;
    assert_ne!(
        relogged.basis().credential_id,
        original.basis().credential_id
    );
    assert_eq!(relogged.basis().revision, original.basis().revision);
    assert!(
        original
            .commit_refresh(credential("late-after-relogin"), 13)
            .await
            .unwrap()
            .is_none()
    );
    fixture.login("old-grant").await;
    assert!(
        relogged.current_generation().await.unwrap().is_none(),
        "reauthentication replaces, rather than refreshes, authority"
    );
    let replacement = fixture.snapshot().await;
    assert_ne!(
        replacement.basis().credential_id,
        relogged.basis().credential_id
    );
    let expected = replacement.basis().clone();
    assert!(replacement.claim_refresh().await.unwrap());
    assert!(!replacement.claim_refresh().await.unwrap());
    drop(replacement);
    drop((original, current, relogged));
    let before_reopen = fixture.store.catalog().await.unwrap();
    let Fixture {
        temp,
        store,
        target,
    } = fixture;
    store.shutdown().await.unwrap();
    drop(store);
    let owner =
        Arc::new(RootOwner::open(&temp.path().join("root"), &namespaces(temp.path())).unwrap());
    let reopened = Arc::new(ConfigurationStore::for_root(owner).await.unwrap());
    let persisted = reopened.provider_credential(target).await.unwrap().unwrap();
    assert_eq!(persisted.basis(), &expected);
    assert_eq!(persisted.credential().secret.as_str(), "old-grant");
    assert!(
        !persisted.claim_refresh().await.unwrap(),
        "a process restart must not reuse a possibly consumed grant"
    );
    persisted
        .commit_refresh(credential("received-replacement"), 15)
        .await
        .unwrap()
        .unwrap();
    let advanced = persisted.current_generation().await.unwrap().unwrap();
    assert!(
        advanced.claim_refresh().await.unwrap(),
        "a new grant has its own claim"
    );
    drop(advanced);
    assert_eq!(reopened.catalog().await.unwrap(), before_reopen);
    drop(persisted);
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn refresh_is_bound_to_recipient_and_route_without_raw_credential_injection() {
    let mut fixture = Fixture::new("opaque-account").await;
    fixture.login("bound-grant").await;
    let original = fixture.snapshot().await;
    let policy = fixture.store.runtime_policy().await.unwrap();
    let mut proxy = policy.policy.network_proxy.clone();
    proxy.enabled = true;
    proxy.host = "127.0.0.1".into();
    proxy.port = 7890;
    fixture
        .store
        .set_network_proxy(policy.revision, proxy.clone())
        .await
        .unwrap();
    assert_eq!(
        original.network_configuration().proxy,
        policy.policy.network_proxy
    );
    assert_eq!(
        fixture.snapshot().await.network_configuration().proxy,
        proxy
    );
    // A completed refresh must retain its rotated grant even when the user
    // changes routing meanwhile. Future requests resolve the new routing snapshot.
    assert!(
        original
            .commit_refresh(credential("routed-grant"), 30)
            .await
            .unwrap()
            .is_some()
    );
    let current = fixture.snapshot().await;
    fixture.update(true).await;
    assert!(
        current
            .commit_refresh(credential("after-edit"), 31)
            .await
            .unwrap()
            .is_some()
    );
    let current = fixture.snapshot().await;
    assert_eq!(current.credential().secret.as_str(), "after-edit");
    fixture.update(false).await;
    let disabled_catalog = fixture.store.catalog().await.unwrap();
    let rotated = current
        .commit_refresh(credential("after-disable"), 32)
        .await
        .unwrap()
        .expect("persist a spent refresh grant even when execution is disabled");
    assert_eq!(rotated.revision, current.basis().revision + 1);
    assert_eq!(fixture.store.catalog().await.unwrap(), disabled_catalog);
    assert!(
        fixture
            .store
            .provider_credential(fixture.target.clone())
            .await
            .unwrap()
            .is_none()
    );
    fixture.update(true).await;
    let current = fixture.snapshot().await;
    assert_eq!(current.credential().secret.as_str(), "after-disable");
    assert_eq!(current.basis(), &rotated);
    let mut forged = fixture.target.clone();
    forged.provider.package_id = "different.provider".into();
    assert!(
        fixture
            .store
            .provider_credential(forged)
            .await
            .unwrap()
            .is_none()
    );
    fixture.remove().await;
    assert!(
        current
            .commit_refresh(credential("after-removal"), 33)
            .await
            .unwrap()
            .is_none()
    );
    fixture.store.shutdown().await.unwrap();
    let outsider = Fixture::new("opaque-account").await;
    assert!(matches!(
        outsider
            .store
            .set_credential(
                SetCredentialInput {
                    locator: CredentialLocator::Connection {
                        connection_id: outsider.target.connection_id.clone(),
                        kind: ConnectionCredentialKind::Provider,
                    },
                    expected: None,
                    expected_connection: Some(outsider.target.clone()),
                    secret: "must-not-import".into(),
                },
                34
            )
            .await,
        Err(ConfigError::Invalid(_))
    ));
    assert!(
        outsider
            .store
            .provider_credential(outsider.target.clone())
            .await
            .unwrap()
            .is_none()
    );
    outsider.store.shutdown().await.unwrap();
}
