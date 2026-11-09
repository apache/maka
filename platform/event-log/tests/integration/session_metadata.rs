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

use maka_event_log::{
    ROOT_MIGRATIONS, RootStore, StoreError,
    root::{RootNamespaces, RootOwner},
    sessions::SessionMutation,
};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn metadata_cas_noop_and_reopen_preserve_activity_fingerprint_and_original_work() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("root");
    let namespaces = RootNamespaces {
        ownership: temp.path().join("owners"),
        control: temp.path().join("control"),
    };
    let owner = RootOwner::create(&path, &namespaces).unwrap();
    let log = RootStore::open(Arc::new(owner), ROOT_MIGRATIONS)
        .await
        .unwrap();
    let session = log
        .create_session(
            "session",
            "original-create",
            &json!({"name":"initial","flag":false}),
            10,
        )
        .await
        .unwrap();
    let (work, effects) = session
        .work_scope(None)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    let original = work.store();
    assert_eq!(
        log.get_session::<Value>("session")
            .await
            .unwrap()
            .unwrap()
            .revision,
        1
    );
    let initial_catalog = log
        .list_sessions::<Value>(None, None, 32)
        .await
        .unwrap()
        .revision;
    let result = log
        .update_session_metadata("session", 1, |value: &mut Value| {
            value["name"] = json!("renamed");
            value["flag"] = json!(true);
            Ok(())
        })
        .await
        .unwrap();
    let SessionMutation::Committed(updated) = result else {
        panic!("expected committed update");
    };
    assert_eq!(updated.revision, 2);
    assert_eq!((updated.created_at, updated.updated_at), (10, 10));
    assert_eq!(updated.configuration, json!({"name":"renamed","flag":true}));
    let changed_catalog = log
        .list_sessions::<Value>(None, None, 32)
        .await
        .unwrap()
        .revision;
    assert_ne!(initial_catalog, changed_catalog);
    let result = log
        .update_session_metadata::<Value, _>("session", 1, |_| {
            panic!("CAS must precede policy/no-op")
        })
        .await
        .unwrap();
    assert!(matches!(
        result,
        SessionMutation::RevisionConflict {
            expected: 1,
            actual: 2
        }
    ));
    let SessionMutation::Committed(unchanged) = log
        .update_session_metadata("session", 2, move |value: &mut Value| {
            value["name"] = json!("renamed");
            Ok(())
        })
        .await
        .unwrap()
    else {
        panic!("current-revision no-op must succeed");
    };
    assert_eq!(unchanged, updated);
    let error = log
        .update_session_metadata("session", 2, move |value: &mut Value| {
            value["name"] = json!("x".repeat(65536));
            Err(StoreError::InvalidTransition("policy refused".into()))
        })
        .await;
    assert!(error.is_err());
    assert_eq!(
        changed_catalog,
        log.list_sessions::<Value>(None, None, 32)
            .await
            .unwrap()
            .revision
    );
    assert_eq!(
        Some((*updated).clone()),
        log.get_session::<Value>("session").await.unwrap()
    );
    assert_eq!(
        original.get::<Value>().await.unwrap(),
        Some((*updated).clone())
    );
    drop(original);
    effects.settle().await.unwrap();
    work.finish();
    drop(session);
    log.close().await.unwrap();
    let owner = RootOwner::open_existing(&path, &namespaces).unwrap();
    let log = RootStore::open(Arc::new(owner), ROOT_MIGRATIONS)
        .await
        .unwrap();
    assert_eq!(
        Some(*updated),
        log.probe_session_create::<Value>("session", "original-create")
            .await
            .unwrap()
    );
    assert_eq!(
        changed_catalog,
        log.list_sessions::<Value>(None, None, 32)
            .await
            .unwrap()
            .revision
    );
    assert!(matches!(
        log.update_session_metadata::<Value, _>("missing", 1, |_| Ok(()))
            .await,
        Err(StoreError::SessionNotFound)
    ));
    log.close().await.unwrap();
}
