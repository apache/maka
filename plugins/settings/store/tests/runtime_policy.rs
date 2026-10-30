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
use maka_agent_facts::configuration::policy::*;
use maka_config::{ConfigError, ConfigurationStore};
use maka_event_log::root::RootOwner;
use std::{
    future::Future,
    task::{Context, Poll, Waker},
};

fn database(owner: &RootOwner) -> rusqlite::Connection {
    rusqlite::Connection::open(owner.canonical_path().join("configuration-rust.sqlite")).unwrap()
}

fn count(database: &rusqlite::Connection) -> i64 {
    database
        .query_row("SELECT COUNT(*) FROM runtime_policy", [], |row| row.get(0))
        .unwrap()
}

#[tokio::test]
async fn proxy_policy_and_password_commit_together_with_cas_noops_and_rollback() {
    use maka_agent_facts::configuration::CredentialState;
    use maka_agent_facts::configuration::CredentialVersionBasis;
    use network_update::{CredentialTarget, CredentialUpdate, Update, UpdateResult};
    let temp = tempfile::tempdir().unwrap();
    let owner = root(temp.path());
    let store = ConfigurationStore::for_root(owner.clone()).await.unwrap();
    let db = database(&owner);
    let original = store.runtime_policy().await.unwrap();
    let proxy = NetworkProxy {
        enabled: true,
        auth_enabled: true,
        username: "user".into(),
        ..original.policy.network_proxy.clone()
    };
    let mut input = Update {
        expected_policy_revision: 0,
        expected_credential: None,
        network_proxy: proxy.clone(),
        credential: CredentialUpdate::Replace {
            secret: "first".into(),
            expected_target: Some(CredentialTarget::from_proxy(&original.policy.network_proxy)),
        },
    };
    let committed = store.update_network_proxy(input.clone(), 1).await.unwrap();
    let UpdateResult::Committed {
        revision: 1,
        credential_status,
    } = &committed
    else {
        panic!("{committed:?}")
    };
    let CredentialState::Configured {
        credential_id,
        revision,
        ..
    } = &credential_status.state
    else {
        panic!("configured")
    };
    let basis = CredentialVersionBasis {
        locator: network_update::locator(),
        credential_id: credential_id.clone(),
        revision: *revision,
    };
    assert!(matches!(
        store.update_network_proxy(input.clone(), 2).await.unwrap(),
        UpdateResult::RevisionConflict { .. }
    ));
    input.expected_policy_revision = 1;
    input.credential = CredentialUpdate::Replace {
        secret: "first".into(),
        expected_target: Some(CredentialTarget::from_proxy(&proxy)),
    };
    assert!(matches!(
        store.update_network_proxy(input.clone(), 2).await.unwrap(),
        UpdateResult::CredentialStale { .. }
    ));
    input.expected_credential = Some(basis.clone());
    assert_eq!(
        store.update_network_proxy(input.clone(), 2).await.unwrap(),
        committed
    );
    input.credential = CredentialUpdate::Replace {
        secret: "second".into(),
        expected_target: Some(CredentialTarget::from_proxy(&original.policy.network_proxy)),
    };
    assert!(matches!(
        store.update_network_proxy(input.clone(), 2).await.unwrap(),
        UpdateResult::ProxyTargetMismatch { .. }
    ));
    input.credential = CredentialUpdate::Replace {
        secret: "second".into(),
        expected_target: None,
    };
    input.network_proxy.port += 1;
    // Fail the final policy write after the password write: both must roll back.
    db.execute_batch("CREATE TRIGGER reject_proxy_update BEFORE UPDATE ON runtime_policy BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
    assert!(store.update_network_proxy(input.clone(), 2).await.is_err());
    assert_eq!(
        store.runtime_policy().await.unwrap().policy.network_proxy,
        proxy
    );
    assert_eq!(
        store
            .network_configuration()
            .await
            .unwrap()
            .password
            .as_deref(),
        Some("first")
    );
    db.execute_batch("DROP TRIGGER reject_proxy_update")
        .unwrap();
    input.network_proxy = original.policy.network_proxy;
    input.credential = CredentialUpdate::Delete {};
    assert!(matches!(
        store.update_network_proxy(input, 3).await.unwrap(),
        UpdateResult::Committed { revision: 2, .. }
    ));
    store.close().await.unwrap();
    let reopened = ConfigurationStore::for_root(owner).await.unwrap();
    assert_eq!(reopened.runtime_policy().await.unwrap().revision, 2);
    assert!(
        reopened
            .network_configuration()
            .await
            .unwrap()
            .password
            .is_none()
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn real_commit_failure_is_unknown_and_cancelled_accepted_write_still_commits() {
    let temp = tempfile::tempdir().unwrap();
    let owner = root(temp.path());
    let store = ConfigurationStore::for_root(owner.clone()).await.unwrap();
    let db = database(&owner);
    // The statement succeeds, but its deferred FK makes SQLite COMMIT fail.
    db.execute_batch(
        "CREATE TABLE fault_parent(id INTEGER PRIMARY KEY);
         CREATE TABLE fault_child(id INTEGER REFERENCES fault_parent(id) DEFERRABLE INITIALLY DEFERRED);
         CREATE TRIGGER fail_policy_commit AFTER INSERT ON runtime_policy BEGIN
             INSERT INTO fault_child VALUES(1);
         END;"
    ).unwrap();
    assert!(matches!(
        store.set_chat_defaults(0, ChatDefaults::default()).await,
        Err(ConfigError::CommitUnknown)
    ));
    assert_eq!(store.runtime_policy().await.unwrap().revision, 0);
    assert_eq!(count(&db), 0);
    db.execute_batch("DROP TRIGGER fail_policy_commit; BEGIN IMMEDIATE")
        .unwrap();
    let mut accepted = Box::pin(store.set_chat_defaults(0, ChatDefaults::default()));
    // The first poll sends into the empty owned lane. Drop only the reply waiter,
    // while the external write lock prevents the accepted transaction completing.
    assert!(matches!(
        accepted
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    drop(accepted);
    db.execute_batch("COMMIT").unwrap();
    assert_eq!(store.runtime_policy().await.unwrap().revision, 1);
    store.close().await.unwrap();
    let reopened = ConfigurationStore::for_root(owner).await.unwrap();
    assert_eq!(reopened.runtime_policy().await.unwrap().revision, 1);
    reopened.close().await.unwrap();
}
