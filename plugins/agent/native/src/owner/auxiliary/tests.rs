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
use maka_event_log::root::{RootNamespaces, RootOwner};

async fn fixture() -> (
    tempfile::TempDir,
    RootStore,
    maka_event_log::root_store::SessionStore,
) {
    let directory = tempfile::tempdir().unwrap();
    let owner = RootOwner::create(
        &directory.path().join("root"),
        &RootNamespaces {
            ownership: directory.path().join("ownership"),
            control: directory.path().join("control"),
        },
    )
    .unwrap();
    let root = RootStore::open(Arc::new(owner)).await.unwrap();
    let session = root
        .create_session("auxiliary", "fixture", &serde_json::json!({}), 1)
        .await
        .unwrap();
    (directory, root, session)
}

async fn writer_available(root: &RootStore) {
    tokio::time::timeout(
        Duration::from_secs(2),
        root.session_retirement_ready("auxiliary"),
    )
    .await
    .expect("physical custody must release the Session writer")
    .unwrap();
}

#[tokio::test]
async fn undispatched_admission_drop_releases_physical_custody() {
    let (_directory, root, session) = fixture().await;
    let admission = IdleLease(Some(session.execution_scope(None).await.unwrap().accept()));
    drop(admission);
    writer_available(&root).await;
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn drained_persistence_exit_releases_custody_without_settlement() {
    let (_directory, root, session) = fixture().await;
    let lease = session.execution_scope(None).await.unwrap().accept();
    let custody = JournalCustody {
        journal: Some(Journal::Session {
            store: lease.store(),
            lease,
            id: Uuid::new_v4(),
        }),
        phase: ProviderPhase::Drained,
    };
    drop(custody);
    writer_available(&root).await;
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn rejected_settlement_still_releases_confirmed_physical_custody() {
    let (_directory, root, session) = fixture().await;
    let lease = session.execution_scope(None).await.unwrap().accept();
    let journal = Journal::Session {
        store: lease.store(),
        lease,
        id: Uuid::new_v4(),
    };
    assert!(journal.settle(Outcome::Success).await.is_err());
    writer_available(&root).await;
    root.shutdown().await.unwrap();
}
