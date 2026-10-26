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
use crate::tests::scope;

async fn root_store(path: &std::path::Path) -> Arc<RootStore> {
    use maka_event_log::root::{RootNamespaces, RootOwner};
    let namespaces = RootNamespaces {
        ownership: path.join("owners"),
        control: path.join("control"),
    };
    let root_path = path.join("root");
    let owner = if root_path.exists() {
        RootOwner::open(&root_path, &namespaces).unwrap()
    } else {
        RootOwner::create(&root_path, &namespaces).unwrap()
    };
    Arc::new(RootStore::open(Arc::new(owner)).await.unwrap())
}

fn change(revision: u64, enabled: bool, pinned: bool) -> SetPreference {
    SetPreference {
        reference: "source:local:review".into(),
        revision,
        preference: maka_skills::Preference { enabled, pinned },
    }
}
#[tokio::test]
async fn concurrent_cas_persists_the_winner_and_separates_owners() {
    let dir = tempfile::tempdir().unwrap();
    let log = root_store(dir.path()).await;
    let store = Store::new(log.clone(), "one_".into());
    let other = Store::new(log.clone(), "two_".into());
    let call = scope();
    assert_eq!(store.read(&call).await.unwrap().revision, 0);
    let (a, b) = tokio::join!(
        store.set(change(0, false, false), &call),
        store.set(change(0, true, true), &call)
    );
    assert!(matches!(
        (&a, &b),
        (
            Ok(PreferenceResult::Applied { revision: 1 }),
            Ok(PreferenceResult::Changed)
        ) | (
            Ok(PreferenceResult::Changed),
            Ok(PreferenceResult::Applied { revision: 1 })
        )
    ));
    let expected = store.read(&call).await.unwrap().entries;
    assert_eq!(expected.len(), 1);
    assert!(other.read(&call).await.unwrap().entries.is_empty());
    call.finish().await.unwrap();
    log.shutdown().await.unwrap();
    drop((store, other, log));
    let log = root_store(dir.path()).await;
    let store = Store::new(log.clone(), "one_".into());
    let call = scope();
    assert_eq!(store.read(&call).await.unwrap().entries, expected);
    assert!(matches!(
        store.set(change(1, true, false), &call).await.unwrap(),
        PreferenceResult::Applied { revision: 2 }
    ));
    let current = store.read(&call).await.unwrap();
    assert_eq!(current.revision, 2);
    assert!(current.entries.is_empty());
    assert!(matches!(
        store.set(change(0, false, false), &call).await.unwrap(),
        PreferenceResult::Changed
    ));
    call.finish().await.unwrap();
    log.shutdown().await.unwrap();
}
#[tokio::test]
async fn deleted_revision_is_preserved_and_invalid_or_cancelled_reads_never_enable_skills() {
    let dir = tempfile::tempdir().unwrap();
    let log = root_store(dir.path()).await;
    let store = Store::new(log.clone(), "one_".into());
    log.plugin_data_batch(
        &namespace(),
        vec![Mutation {
            key: store.key.clone(),
            expected_revision: None,
            data: Data::Deleted,
        }],
    )
    .await
    .unwrap();
    let call = scope();
    assert!(matches!(
        store.set(change(0, false, false), &call).await.unwrap(),
        PreferenceResult::Changed
    ));
    assert!(matches!(
        store.set(change(1, false, false), &call).await.unwrap(),
        PreferenceResult::Applied { revision: 2 }
    ));
    log.plugin_data_batch(
        &namespace(),
        vec![Mutation {
            key: store.key.clone(),
            expected_revision: Some(2),
            data: Data::Present(serde_json::json!({"bad": {"enabled": true}})),
        }],
    )
    .await
    .unwrap();
    assert!(store.read(&call).await.is_err());
    assert!(store.set(change(3, true, false), &call).await.is_err());
    call.cancellation.cancel();
    assert!(store.read(&call).await.is_err());
    call.finish().await.unwrap();
    assert!(store.read(&call).await.is_err());
    log.shutdown().await.unwrap();
}

#[tokio::test]
async fn dropping_observer_cannot_finish_the_original_call_before_its_store_work() {
    let dir = tempfile::tempdir().unwrap();
    let log = root_store(dir.path()).await;
    let store = Store::new(log.clone(), "one_".into());
    let call = scope();
    let (started, running) = tokio::sync::oneshot::channel();
    let (release, held) = tokio::sync::oneshot::channel();
    let worker_store = store.clone();
    let worker_scope = call.clone();
    let observer = tokio::spawn(async move {
        worker_store.run(&worker_scope, move |store, _| Box::pin(async move {
            started.send(()).unwrap();
            held.await.unwrap();
            store.log.plugin_data_batch(&namespace(), vec![Mutation {
                key: store.key, expected_revision: None,
                data: Data::Present(serde_json::json!({"source:local:review":{"enabled":false,"pinned":true}})),
            }]).await.map_err(|_| "test write failed".to_owned())
        })).await
    });
    running.await.unwrap();
    observer.abort();
    assert!(observer.await.unwrap_err().is_cancelled());
    assert!(
        !call.resources.seal().unwrap(),
        "the detached observer cannot settle live SQL custody"
    );
    release.send(()).unwrap();
    call.finish().await.unwrap();
    let current = store.read(&scope()).await.unwrap();
    assert_eq!(current.revision, 1);
    assert!(!current.entries["source:local:review"].enabled);
    log.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_returned_business_error_does_not_invent_a_cleanup_failure() {
    let dir = tempfile::tempdir().unwrap();
    let log = root_store(dir.path()).await;
    let store = Store::new(log.clone(), "one_".into());
    let call = scope();
    let result = store
        .run(&call, |_, _| {
            Box::pin(async { Err::<(), _>("skills_preferences_unknown".into()) })
        })
        .await;
    assert_eq!(result.unwrap_err(), "skills_preferences_unknown");
    call.finish()
        .await
        .expect("the task actually returned; business uncertainty is separate");
    log.shutdown().await.unwrap();
}
