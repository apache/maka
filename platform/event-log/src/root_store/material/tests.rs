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

use super::super::*;
use crate::{
    plugins::storage::WritePluginData,
    sessions::{SessionRemovalResult, SessionRetirement},
    writeback::{Notification, Prepared, Statement},
};
use maka_plugin_core::{
    scope::Scope,
    storage::{Data, Mutation, Namespace, Record},
};
use serde_json::json;
use std::{path::Path, time::Duration};
use tokio_util::sync::CancellationToken;

fn owner(path: &Path) -> Arc<root::RootOwner> {
    Arc::new(
        root::RootOwner::create(
            &path.join("root"),
            &root::RootNamespaces {
                ownership: path.join("ownership"),
                control: path.join("control"),
            },
        )
        .unwrap(),
    )
}

async fn block_update(
    log: &EventLog,
    table: &'static str,
) -> (
    tokio::sync::oneshot::Receiver<()>,
    std::sync::mpsc::Sender<()>,
) {
    let (entered, reached) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    log.connection
        .run(move |db| {
            let mut entered = Some(entered);
            db.update_hook(Some(move |_, _: &str, updated_table: &str, _| {
                if updated_table == table
                    && let Some(entered) = entered.take()
                {
                    let _ = entered.send(());
                    let _ = released.recv();
                }
            }))
            .unwrap();
            Ok(())
        })
        .await
        .unwrap();
    (reached, release)
}

const KEYS: usize = 8;
const BYTES_PER_VALUE: usize = 256 * 1024;

fn namespace() -> Namespace {
    Namespace::new("material-tests", Scope::Profile).unwrap()
}
fn replacements(expected: Option<u64>, data: Data) -> Vec<Mutation> {
    (0..KEYS)
        .map(|index| Mutation {
            key: format!("material-{index}"),
            expected_revision: expected,
            data: data.clone(),
        })
        .collect()
}
async fn seed(log: &EventLog, namespace: &Namespace) {
    log.plugin_data_batch(
        namespace,
        replacements(None, Data::Present(json!("x".repeat(BYTES_PER_VALUE)))),
    )
    .await
    .unwrap();
}

// This test owner releases its own mutable metadata, not canonical domain evidence.
struct ReleaseMetadata(WritePluginData);
impl ReleaseMetadata {
    fn new(namespace: &Namespace, expected: u64) -> Self {
        let (_, statement) = WritePluginData::for_completion(
            namespace,
            replacements(Some(expected), Data::Present(json!("kept"))),
        )
        .unwrap();
        Self(statement)
    }
}
impl Statement for ReleaseMetadata {
    type Value = Vec<Record>;
    type Output = Vec<Record>;
    fn execute(self, connection: &SqliteConnection) -> Result<Prepared<Self::Value>, StoreError> {
        let mut prepared = self.0.execute(connection)?;
        prepared.notification = prepared
            .notification
            .combine(Notification::MATERIAL_RELEASED);
        Ok(prepared)
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        WritePluginData::isolated_rejection(error)
    }
}

async fn material_state(log: &EventLog) -> (i64, i64) {
    log.connection
        .read(|db| {
            let free = db.query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
            let pages = db.query_row("PRAGMA page_count", [], |row| row.get(0))?;
            Ok((free, pages))
        })
        .await
        .unwrap()
}
async fn reclaimed(log: &EventLog, pages_before: i64) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let (free, pages) = material_state(log).await;
            if free == 0 && pages < pages_before {
                return;
            }
            // Vacuum does not change total_changes(); observe the physical level.
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("Root maintenance must return the released database pages");
}
async fn assert_replaced(log: &EventLog, namespace: &Namespace) {
    for index in 0..KEYS {
        let record = log
            .plugin_data(namespace, &format!("material-{index}"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(record.revision, 2);
        assert_eq!(record.data, Data::Present(json!("kept")));
    }
}

#[tokio::test]
async fn committed_release_returns_pages_after_a_rejected_metadata_cas() {
    let directory = tempfile::tempdir().unwrap();
    let root = RootStore::open(owner(directory.path()), crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    let namespace = namespace();
    seed(&root.log, &namespace).await;
    let (_, pages_before) = material_state(&root.log).await;
    let writer = root.data_writer().unwrap();
    let mut rejected = replacements(Some(1), Data::Present(json!("kept")));
    rejected.last_mut().unwrap().expected_revision = Some(2);
    let (_, rejected) = WritePluginData::for_completion(&namespace, rejected).unwrap();
    assert!(matches!(
        writer.write(ReleaseMetadata(rejected)).await,
        Err(StoreError::RevisionConflict { .. })
    ));
    for index in 0..KEYS {
        let retained = root
            .plugin_data(&namespace, &format!("material-{index}"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(retained.revision, 1);
        assert_eq!(
            retained.data.value().unwrap().as_str().unwrap().len(),
            BYTES_PER_VALUE
        );
    }
    assert_eq!(
        writer
            .write(ReleaseMetadata::new(&namespace, 1))
            .await
            .unwrap()
            .len(),
        KEYS
    );
    reclaimed(&root.log, pages_before).await;
    assert_replaced(&root.log, &namespace).await;
    root.close().await.unwrap();
}

#[tokio::test]
async fn cancelled_observer_cannot_lose_the_committed_material_release() {
    let directory = tempfile::tempdir().unwrap();
    let root = RootStore::open(owner(directory.path()), crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    let namespace = namespace();
    seed(&root.log, &namespace).await;
    let (_, pages_before) = material_state(&root.log).await;
    let statement = ReleaseMetadata::new(&namespace, 1);
    let writer = root.data_writer().unwrap();
    let mut releases = root.log.commits.subscribe_material_releases();
    let (reached, release) = block_update(&root.log, "plugin_data").await;
    let observer = tokio::spawn(async move { writer.write(statement).await });
    tokio::time::timeout(Duration::from_secs(10), reached)
        .await
        .unwrap()
        .unwrap();
    observer.abort();
    assert!(observer.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(10), releases.changed())
        .await
        .expect("committed release must outlive its cancelled observer")
        .unwrap();
    reclaimed(&root.log, pages_before).await;
    assert_replaced(&root.log, &namespace).await;
    root.close().await.unwrap();
}

#[tokio::test]
async fn opening_root_reclaims_existing_freelist_without_a_new_release() {
    let directory = tempfile::tempdir().unwrap();
    let owner = owner(directory.path());
    let log = EventLog::for_root(owner.clone()).await.unwrap();
    let namespace = namespace();
    seed(&log, &namespace).await;
    let (_, pages_before) = material_state(&log).await;
    log.plugin_data_batch(
        &namespace,
        replacements(Some(1), Data::Present(json!("kept"))),
    )
    .await
    .unwrap();
    assert!(material_state(&log).await.0 > 0);
    log.shutdown().await.unwrap();
    drop(log);
    let root = RootStore::open(owner, crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    reclaimed(&root.log, pages_before).await;
    assert_replaced(&root.log, &namespace).await;
    root.close().await.unwrap();
}

#[tokio::test]
async fn forked_work_keeps_retirement_busy_until_the_last_physical_pin_is_released() {
    let directory = tempfile::tempdir().unwrap();
    let root = RootStore::open(owner(directory.path()), crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    let session = root
        .create_session("source", "source", &json!({}), 1)
        .await
        .unwrap();
    let (work, effects) = session
        .work_scope(None)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    let custody = work.store().work_custody().unwrap();
    let fork = root.fork_work(custody.as_ref(), "source").unwrap();
    effects.settle().await.unwrap();
    work.finish();
    assert!(matches!(
        root.begin_session_removal("source", 1).await.unwrap(),
        SessionRemovalResult::Accepted(SessionRetirement::Removing)
    ));
    assert!(matches!(
        root.finish_session_retirement("source").await,
        Err(StoreError::SessionBusy)
    ));
    fork.finish();
    assert_eq!(
        root.finish_session_retirement("source").await.unwrap(),
        SessionRetirement::Removed
    );
    root.close().await.unwrap();
}
