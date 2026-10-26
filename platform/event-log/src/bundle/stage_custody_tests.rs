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
use std::{
    sync::{Arc, mpsc},
    time::Duration,
};

#[test]
fn cancelled_stage_writer_retains_root_past_observer_runtime_and_root_close() {
    cancelled_stage_retains_root(false, true);
}

#[test]
fn cancelled_stage_reader_retains_root_past_observer_runtime_and_root_close() {
    cancelled_stage_retains_root(true, true);
}

#[test]
fn root_close_acknowledges_only_after_stage_sql_physically_closes() {
    cancelled_stage_retains_root(false, false);
}

fn cancelled_stage_retains_root(reading: bool, destroy_runtime: bool) {
    let directory = tempfile::tempdir().unwrap();
    let root_path = directory.path().join("root");
    let namespaces = crate::root::RootNamespaces {
        ownership: directory.path().join("ownership"),
        control: directory.path().join("control"),
    };
    let root = Arc::new(crate::root::RootOwner::create(&root_path, &namespaces).unwrap());
    let weak = Arc::downgrade(&root);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let store = runtime
        .block_on(crate::root_store::RootStore::open(root.clone()))
        .unwrap();
    let mut staged = runtime.block_on(async {
        let source = crate::EventLog::open(&directory.path().join("source.sqlite"))
            .await
            .unwrap();
        source
            .create_session("source", "source", &serde_json::json!({}), 1)
            .await
            .unwrap();
        let inventory = source.preview_bundle("source").await.unwrap();
        let (bytes, _) = source
            .export_bundle("source", &inventory.subtree_digest, Vec::new())
            .await
            .unwrap();
        source.close().await.unwrap();
        StagedBundle::read(bytes.as_slice()).await.unwrap()
    });
    runtime.block_on(staged.validate_history()).unwrap();
    let stage_directory = root_path.join("runtime-stages");
    crate::root::private_directory(&stage_directory).unwrap();
    let path = stage_directory.join(format!("{}.sqlite", uuid::Uuid::new_v4()));
    let task_path = path.clone();
    let (entered, reached) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    let staged = if reading {
        runtime
            .block_on(staged.persist(&path, store.stage_owner().unwrap()))
            .unwrap();
        None
    } else {
        Some(staged)
    };
    let stage_owner = store.stage_owner().unwrap();
    drop(root);
    runtime.spawn(async move {
        if reading {
            StagedBundle::reopen_owned(&task_path, stage_owner, move |db| {
                Box::pin(async move {
                    db.run_with_connection(move |_| {
                        entered.send(()).unwrap();
                        gate.recv_timeout(Duration::from_secs(30)).unwrap();
                    })
                    .await?;
                    Ok(())
                })
            })
            .await
            .map(|_| ())
        } else {
            staged
                .unwrap()
                .persist_owned(&task_path, stage_owner, move |db| {
                    Box::pin(async move {
                        db.lock_handle().await?.set_commit_hook(move || {
                            entered.send(()).unwrap();
                            gate.recv_timeout(Duration::from_secs(30)).unwrap();
                            true
                        });
                        Ok(())
                    })
                })
                .await
        }
    });
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(20), async {
            while reached.try_recv().is_err() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    });
    let mut closing = runtime.spawn(store.close());
    runtime.block_on(async {
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut closing)
                .await
                .is_err()
        );
    });
    assert!(weak.upgrade().is_some());
    assert!(crate::root::RootOwner::open(&root_path, &namespaces).is_err());
    if destroy_runtime {
        // Destroy both observers while the actual SQLite worker remains blocked.
        drop(runtime);
        release.send(()).unwrap();
    } else {
        release.send(()).unwrap();
        runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(20), closing)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        });
        drop(runtime);
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(20), async {
            while weak.upgrade().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let next = Arc::new(crate::root::RootOwner::open(&root_path, &namespaces).unwrap());
        // Only now may startup collect the unreserved durable stage.
        crate::root_store::RootStore::open(next)
            .await
            .unwrap()
            .close()
            .await
            .unwrap();
    });
    assert!(!path.exists());
}

#[tokio::test]
async fn stage_close_failure_fails_root_close_and_retains_original_authority() {
    struct PanickingDrop;
    impl Drop for PanickingDrop {
        fn drop(&mut self) {
            panic!("stage SQLite callback destructor failed");
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let root_path = directory.path().join("root");
    let namespaces = crate::root::RootNamespaces {
        ownership: directory.path().join("ownership"),
        control: directory.path().join("control"),
    };
    let root = Arc::new(crate::root::RootOwner::create(&root_path, &namespaces).unwrap());
    let weak = Arc::downgrade(&root);
    let store = crate::root_store::RootStore::open(root).await.unwrap();
    let stage = store
        .stage_owner()
        .unwrap()
        .open(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(root_path.join("failed-stage.sqlite"))
                .create_if_missing(true),
            |db| {
                Box::pin(async move {
                    let retained = PanickingDrop;
                    db.lock_handle().await?.set_progress_handler(1, move || {
                        let _retained = &retained;
                        true
                    });
                    Ok(())
                })
            },
        )
        .await
        .unwrap();
    assert!(stage.shutdown().await.is_err());
    drop(stage);
    assert!(
        tokio::time::timeout(Duration::from_secs(10), store.close())
            .await
            .unwrap()
            .is_err()
    );
    assert!(weak.upgrade().is_some());
    assert!(crate::root::RootOwner::open(&root_path, &namespaces).is_err());
}
