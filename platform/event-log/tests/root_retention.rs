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

use futures_util::poll;
use maka_event_log::{
    ROOT_MIGRATIONS, RootStore, StoreError,
    connection::Query,
    content,
    root::{RootNamespaces, RootOwner},
    root_store::DataWriter,
    writeback::{Notification, Prepared, Statement},
};
use rusqlite::Connection;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

struct Material(Arc<AtomicBool>);
impl Drop for Material {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

struct Put(Vec<u8>);
impl Statement for Put {
    type Value = String;
    type Output = String;
    fn execute(self, connection: &Connection) -> Result<Prepared<String>, StoreError> {
        let digest = format!("sha256:{}", hex::encode(Sha256::digest(&self.0)));
        content::put(connection, &digest, &self.0)?;
        Ok(Prepared {
            value: digest,
            changed: true,
            notification: Notification::NONE,
        })
    }
    fn committed(value: String) -> String {
        value
    }
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}
struct Read(String);
impl Query for Read {
    type Output = Option<Vec<u8>>;
    fn execute(self, connection: &Connection) -> Result<Self::Output, StoreError> {
        content::read(connection, &self.0)
    }
}
async fn acknowledge(writer: &DataWriter, bytes: &[u8]) {
    let digest = writer.write(Put(bytes.to_vec())).await.unwrap();
    assert_eq!(
        writer.query(Read(digest)).await.unwrap().as_deref(),
        Some(bytes)
    );
}

#[tokio::test]
async fn original_retention_tokens_allow_late_ack_and_release_only_their_owner() {
    let directory = tempfile::tempdir().unwrap();
    let owner = Arc::new(
        RootOwner::create(
            &directory.path().join("root"),
            &RootNamespaces {
                ownership: directory.path().join("owners"),
                control: directory.path().join("control"),
            },
        )
        .unwrap(),
    );
    let released = Arc::downgrade(&owner);
    let root = RootStore::open(owner, ROOT_MIGRATIONS).await.unwrap();
    let session = root
        .create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    let (work_a, _) = session
        .work_scope(None)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    let (work_b, _) = session
        .work_scope(None)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    let custody_a = work_a.store().work_custody().unwrap();
    let custody_b = work_b.store().work_custody().unwrap();
    let observer_a = root
        .observe_work_settlement(custody_a.as_ref(), "session")
        .unwrap();
    let observer_b = root
        .observe_work_settlement(custody_b.as_ref(), "session")
        .unwrap();
    let observer_a_copy = observer_a.clone();
    assert!(poll!(std::pin::pin!(observer_a.wait())).is_pending());
    assert!(poll!(std::pin::pin!(observer_b.wait())).is_pending());
    let child_a = root.fork_work(custody_a.as_ref(), "session").unwrap();
    let writer_a = root
        .data_writer_for_work(custody_a.as_ref(), "session")
        .unwrap();
    let writer_b = root
        .data_writer_for_work(custody_b.as_ref(), "session")
        .unwrap();
    let dropped_a = Arc::new(AtomicBool::new(false));
    let dropped_b = Arc::new(AtomicBool::new(false));
    let token_a = work_a.retain_original_material(Material(dropped_a.clone()));
    let token_b = work_b.retain_original_material(Material(dropped_b.clone()));

    assert!(matches!(
        observer_a.wait().await,
        Err(StoreError::CleanupUnconfirmed(_))
    ));
    assert!(matches!(
        observer_b.wait().await,
        Err(StoreError::CleanupUnconfirmed(_))
    ));

    let first = root.shutdown().await.unwrap_err();
    assert!(matches!(&first, StoreError::CloseFailed(_)));
    let original_failure = first.to_string();
    acknowledge(&writer_a, b"original A late acknowledgement").await;
    acknowledge(&writer_b, b"original B late acknowledgement").await;
    assert!(!dropped_a.load(Ordering::Acquire));
    assert!(!dropped_b.load(Ordering::Acquire));

    token_a.confirm_cleanup();
    assert!(dropped_a.load(Ordering::Acquire));
    assert!(!dropped_b.load(Ordering::Acquire));
    assert!(matches!(
        writer_a.write(Put(b"after A confirmation".to_vec())).await,
        Err(StoreError::ConnectionClosed)
    ));
    // The original pin is gone, but its real fork still owns the same Guards.
    assert!(matches!(
        observer_a.wait().await,
        Err(StoreError::CleanupUnconfirmed(_))
    ));
    child_a.finish();
    tokio::time::timeout(Duration::from_secs(5), observer_a_copy.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        observer_b.wait().await,
        Err(StoreError::CleanupUnconfirmed(_))
    ));
    acknowledge(&writer_b, b"B remains accepted after A confirmation").await;
    assert_eq!(
        root.shutdown().await.unwrap_err().to_string(),
        original_failure
    );

    token_b.confirm_cleanup();
    assert!(dropped_b.load(Ordering::Acquire));
    tokio::time::timeout(Duration::from_secs(5), observer_b.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        writer_b
            .query(Read("unused-after-confirmation".into()))
            .await,
        Err(StoreError::ConnectionClosed)
    ));
    assert_eq!(
        root.shutdown().await.unwrap_err().to_string(),
        original_failure
    );
    drop(root);
    // This deadline bounds the regression test; only original token confirmation
    // and the actual SQL close acknowledgement release the Root authority.
    tokio::time::timeout(Duration::from_secs(5), async {
        while released.upgrade().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("original lifecycle kept Root authority after both actual settlements");
    observer_a.wait().await.unwrap();
    observer_b.wait().await.unwrap();
}
