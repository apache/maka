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
use serde_json::json;

#[tokio::test]
async fn launcher_requires_root_and_preserves_complete_configuration_with_typed_storage() {
    let directory = tempfile::tempdir().unwrap();
    let unowned = EventLog::open(&directory.path().join("unowned.sqlite"))
        .await
        .unwrap();
    assert!(unowned.application_launch().await.is_err());
    assert!(
        unowned
            .begin_application_launch(Launch {
                deployment: Uuid::new_v4(),
                configuration: json!({}),
                pending: Some(vec![1])
            })
            .await
            .is_err()
    );
    unowned.close().await.unwrap();
    let (_dir, store) = crate::applications::tests::store().await;
    for (id, pending) in [
        (Uuid::nil(), Some(vec![1])),
        (Uuid::new_v4(), None),
        (Uuid::new_v4(), Some(vec![])),
    ] {
        assert!(
            store
                .begin_application_launch(Launch {
                    deployment: id,
                    configuration: json!({}),
                    pending
                })
                .await
                .is_err()
        );
    }
    let deployment = Uuid::new_v4();
    let configuration = json!({"large":"x".repeat(1024 * 1024 + 1)});
    store
        .begin_application_launch(Launch {
            deployment,
            configuration: configuration.clone(),
            pending: Some(vec![1]),
        })
        .await
        .unwrap();
    let stored = store.application_launch().await.unwrap().unwrap();
    assert_eq!(stored.deployment, deployment);
    assert_eq!(stored.configuration, configuration);
    assert_eq!(stored.pending, Some(vec![1]));
    store
        .connection
        .run(|connection| {
            Box::pin(async move {
                sqlx::query("UPDATE application_launch SET deployment='invalid-uuid'")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert!(store.application_launch().await.is_err());
    store.close().await.unwrap();
}

#[tokio::test]
async fn unknown_commit_is_not_reported_as_success_or_replaced() {
    let (_dir, store) = crate::applications::tests::store().await;
    store.connection.run(|connection| Box::pin(async move {
        sqlx::raw_sql("CREATE TABLE launcher_probe (id TEXT REFERENCES application_deployments(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER reject_launch AFTER INSERT ON application_launch BEGIN INSERT INTO launcher_probe VALUES ('missing'); END;").execute(connection).await?;
        Ok(())
    })).await.unwrap();
    let result = store
        .begin_application_launch(Launch {
            deployment: Uuid::new_v4(),
            configuration: json!({}),
            pending: Some(vec![1]),
        })
        .await;
    assert!(matches!(result, Err(StoreError::CommitUnknown(_))));
    assert!(store.application_launch().await.unwrap().is_none());
    store.close().await.unwrap();
}

#[tokio::test]
async fn host_configuration_cas_checks_source_and_original_authority_on_retries() {
    let (_directory, store) = crate::applications::tests::store().await;
    let deployment = Uuid::new_v4();
    let source = store
        .commit_application(
            deployment,
            0,
            crate::applications::tests::input(),
            vec![],
            vec![],
        )
        .await
        .unwrap();
    let previous = json!({"kind":"public_host","native":[],"endpoints":{"old":true}});
    let desired = json!({"kind":"public_host","native":[],"endpoints":{"new":true}});
    store
        .begin_application_launch(Launch {
            deployment,
            configuration: previous.clone(),
            pending: Some(vec![1]),
        })
        .await
        .unwrap();
    assert!(
        !store
            .compare_and_set_application_launch_configuration(
                source.clone(),
                previous.clone(),
                desired.clone()
            )
            .await
            .unwrap()
    );
    store.complete_application_launch(deployment).await.unwrap();
    assert!(
        !store
            .compare_and_set_application_launch_configuration(
                source.clone(),
                json!({"foreign":true}),
                desired.clone()
            )
            .await
            .unwrap()
    );
    assert!(
        store
            .compare_and_set_application_launch_configuration(
                source.clone(),
                previous.clone(),
                desired.clone()
            )
            .await
            .unwrap()
    );
    // The same desired authority is an idempotent retry at this exact source.
    assert!(
        store
            .compare_and_set_application_launch_configuration(
                source.clone(),
                previous.clone(),
                desired.clone()
            )
            .await
            .unwrap()
    );
    let newer = store
        .commit_application(
            deployment,
            1,
            crate::applications::tests::input(),
            vec![],
            vec![],
        )
        .await
        .unwrap();
    assert!(
        !store
            .compare_and_set_application_launch_configuration(source, previous, desired.clone())
            .await
            .unwrap()
    );
    let latest = json!({"kind":"public_host","native":[],"endpoints":{"latest":true}});
    assert!(
        store
            .compare_and_set_application_launch_configuration(newer, desired, latest.clone())
            .await
            .unwrap()
    );
    let record = store.application_launch().await.unwrap().unwrap();
    assert_eq!(record.configuration, latest);
    assert!(record.pending.is_none());
    store.close().await.unwrap();
}

#[tokio::test]
async fn committed_selection_requires_current_source_and_never_overwrites_selection() {
    let (_directory, store) = crate::applications::tests::store().await;
    let deployment = Uuid::new_v4();
    let original = store
        .commit_application(
            deployment,
            0,
            crate::applications::tests::input(),
            vec![],
            vec![],
        )
        .await
        .unwrap();
    let mut missing = original.clone();
    missing.deployment = Uuid::new_v4();
    assert!(
        store
            .select_committed_application_launch(missing, json!({}))
            .await
            .is_err()
    );
    let current = store
        .commit_application(
            deployment,
            1,
            crate::applications::tests::input(),
            vec![],
            vec![],
        )
        .await
        .unwrap();
    assert!(
        store
            .select_committed_application_launch(original, json!({}))
            .await
            .is_err()
    );
    assert!(store.application_launch().await.unwrap().is_none());
    let configuration = json!({"trusted":"committed"});
    store
        .select_committed_application_launch(current.clone(), configuration.clone())
        .await
        .unwrap();
    let selected = store.application_launch().await.unwrap().unwrap();
    assert_eq!(selected.deployment, deployment);
    assert_eq!(selected.configuration, configuration);
    assert!(selected.pending.is_none());
    assert!(
        store
            .select_committed_application_launch(current.clone(), json!({"replacement":true}))
            .await
            .is_err()
    );
    assert_eq!(
        store
            .application_launch()
            .await
            .unwrap()
            .unwrap()
            .configuration,
        configuration
    );
    assert_eq!(
        store.application_head(deployment).await.unwrap(),
        Some(current)
    );
    store.close().await.unwrap();
}
