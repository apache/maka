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
use crate::checkpoints::{LoadOperation, LoadState};

fn request(revision: Revision) -> LoadOperation {
    LoadOperation {
        operation: Uuid::from_u128(101),
        fingerprint: "b".repeat(64),
        revision,
    }
}
#[tokio::test]
async fn exact_load_is_idempotent_isolated_and_survives_head_move() {
    let dir = tempfile::tempdir().unwrap();
    let (store, handle, publish) = fixture(dir.path()).await;
    let head = published(
        &handle
            .publish(publish.clone(), snapshot_file())
            .await
            .unwrap(),
    );
    let input = request(head.revision);
    let (a, b) = tokio::join!(
        handle.load_exact(input.clone()),
        handle.load_exact(input.clone())
    );
    let value = a.unwrap();
    assert_eq!(b.unwrap(), value);
    assert!(matches!(value.state, LoadState::Ready { .. }));
    let source = store
        .get_session::<serde_json::Value>("source")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(source.configuration["title"], "original");
    assert_eq!(source.revision, 1);
    let mut next = publish;
    next.operation = Uuid::from_u128(102);
    next.expected_revision = Some(head.revision);
    let newer = published(&handle.publish(next, snapshot_file()).await.unwrap());
    let mut conflict = input.clone();
    conflict.revision = newer.revision;
    assert!(
        handle
            .load_exact(conflict)
            .await
            .unwrap_err()
            .to_string()
            .contains("identity conflict")
    );
    let mut stale = input.clone();
    stale.operation = Uuid::from_u128(103);
    assert!(handle.load_exact(stale.clone()).await.is_err());
    assert!(handle.load_receipt(stale).await.unwrap().is_none());
    assert_eq!(handle.load_exact(input.clone()).await.unwrap(), value);
    store.close().await.unwrap();
    let store = RootStore::open(owner(dir.path()), crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    let handle = store.history_checkpoints("source", scope()).await.unwrap();
    assert_eq!(
        handle.load_receipt(input.clone()).await.unwrap(),
        Some(value.clone())
    );
    assert_eq!(
        handle.loaded_checkpoint(input.operation).await.unwrap(),
        value
    );
    assert_original_snapshot(
        handle
            .loaded_snapshot(input.operation)
            .await
            .unwrap()
            .snapshot,
    );
    store
        .create_session("foreign", "foreign", &json!({}), 1)
        .await
        .unwrap();
    let foreign_session = store.history_checkpoints("foreign", scope()).await.unwrap();
    assert!(
        foreign_session
            .loaded_checkpoint(input.operation)
            .await
            .is_err()
    );
    assert!(
        foreign_session
            .loaded_snapshot(input.operation)
            .await
            .is_err()
    );
    let mut foreign = scope();
    foreign.deployment = Uuid::new_v4();
    let other = store.history_checkpoints("source", foreign).await.unwrap();
    assert!(other.loaded_snapshot(input.operation).await.is_err());
    store.close().await.unwrap();
    assert!(handle.load_receipt(input).await.is_err());
}
