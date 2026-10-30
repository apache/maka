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

use std::{sync::Arc, time::Duration};

use maka_event_log::{
    RootStore,
    root::{RootNamespaces, RootOwner},
};
use serde_json::json;
use tokio::sync::Barrier;

#[tokio::test]
async fn absent_checkpoint_rollback_releases_shared_reader_for_interruptible_interaction_reads() {
    let directory = tempfile::tempdir().unwrap();
    let namespaces = RootNamespaces {
        ownership: directory.path().join("owners"),
        control: directory.path().join("control"),
    };
    let owner = RootOwner::create(&directory.path().join("root"), &namespaces).unwrap();
    let root = RootStore::open(Arc::new(owner)).await.unwrap();
    let session = root
        .create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    let lease = session.execution_scope(None).await.unwrap().accept();
    let selected = lease.store();
    let start = Arc::new(Barrier::new(4));
    let finish = Arc::new(Barrier::new(4));
    let checkpoints_store = session.clone();
    let checkpoint_start = start.clone();
    let checkpoint_finish = finish.clone();
    let checkpoint_reader = tokio::spawn(async move {
        for _ in 0..128 {
            checkpoint_start.wait().await;
            assert!(
                checkpoints_store
                    .native_approval_checkpoint("session")
                    .await
                    .unwrap()
                    .is_none()
            );
            checkpoint_finish.wait().await;
        }
    });
    let interactions_store = selected.clone();
    let interaction_start = start.clone();
    let interaction_finish = finish.clone();
    let interaction_reader = tokio::spawn(async move {
        for _ in 0..128 {
            interaction_start.wait().await;
            assert!(
                interactions_store
                    .interaction("missing-interaction")
                    .await
                    .unwrap()
                    .is_none()
            );
            interaction_finish.wait().await;
        }
    });
    let metadata_store = session.clone();
    let metadata_start = start.clone();
    let metadata_finish = finish.clone();
    let metadata_reader = tokio::spawn(async move {
        for _ in 0..128 {
            metadata_start.wait().await;
            assert!(
                metadata_store
                    .get_session::<serde_json::Value>("session")
                    .await
                    .unwrap()
                    .is_some()
            );
            metadata_finish.wait().await;
        }
    });
    tokio::time::timeout(Duration::from_secs(15),async {
        for _ in 0..128 {
            // Three independent API futures enter the shared physical lane
            // together; no read waits for another caller's acknowledgement.
            start.wait().await;
            finish.wait().await;
        }
        checkpoint_reader.await.unwrap();interaction_reader.await.unwrap();metadata_reader.await.unwrap();
        assert!(selected.native_approval_checkpoint("session").await.unwrap().is_none());
    }).await.expect("concurrent early rollback, interruptible and metadata reads must release the shared physical reader");
    drop(selected);
    lease.finish();
    drop(session);
    root.close().await.unwrap();
}
