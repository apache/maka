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

use crate::EventLog;
use maka_plugin_core::scope::Scope;
use maka_plugin_core::storage::{Data, Mutation, Namespace, Scan};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::sync::oneshot;

#[tokio::test]
async fn reads_observe_committed_batches_without_waiting_for_the_writer() {
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        EventLog::open(&directory.path().join("data.sqlite"))
            .await
            .unwrap(),
    );
    let namespace = Namespace::new("skills", Scope::Profile).unwrap();
    log.plugin_data_batch(
        &namespace,
        ["first", "second"]
            .into_iter()
            .map(|key| Mutation {
                key: key.into(),
                expected_revision: None,
                data: Data::Present(json!("before")),
            })
            .collect(),
    )
    .await
    .unwrap();

    // Keep an actual write transaction open between its two updates. Public
    // reads must proceed on the complete committed batch, never this partial one.
    let (started, waiting) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let owner = log.clone();
    let writer = tokio::spawn(async move {
        owner
            .connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                tx.execute(
                    "UPDATE plugin_data SET revision = 2, value_json = ? WHERE key = 'first'",
                    rusqlite::params![json!("after").to_string()],
                )?;
                started.send(()).unwrap();
                released.blocking_recv().unwrap();
                tx.execute(
                    "UPDATE plugin_data SET revision = 2, value_json = ? WHERE key = 'second'",
                    rusqlite::params![json!("after").to_string()],
                )?;
                tx.commit()?;
                Ok(())
            })
            .await
    });
    waiting.await.unwrap();
    let during = tokio::time::timeout(Duration::from_secs(5), async {
        let first = log.plugin_data(&namespace, "first").await.unwrap().unwrap();
        let page = log
            .plugin_data_scan(&namespace, Scan::default())
            .await
            .unwrap();
        (first, page)
    })
    .await;
    // Release even on a regression so a failed assertion cannot strand the owner.
    release.send(()).unwrap();
    writer.await.unwrap().unwrap();
    let (first, page) = during.expect("plugin reads waited for an uncommitted writer");
    assert_eq!(first.revision, 1);
    assert_eq!(first.data, Data::Present(json!("before")));
    assert_eq!(
        page.entries
            .iter()
            .map(|entry| entry.key.as_str())
            .collect::<Vec<_>>(),
        ["first", "second"]
    );
    assert!(page.next_after.is_none());
    for entry in page.entries {
        assert_eq!(entry.record.revision, 1);
        assert_eq!(entry.record.data, Data::Present(json!("before")));
    }

    // Reused read connections start fresh statement snapshots after the write
    // receipt; both single-key and scan APIs must now see its complete commit.
    for key in ["first", "second"] {
        let record = log.plugin_data(&namespace, key).await.unwrap().unwrap();
        assert_eq!(record.revision, 2);
        assert_eq!(record.data, Data::Present(json!("after")));
    }
    let page = log
        .plugin_data_scan(&namespace, Scan::default())
        .await
        .unwrap();
    assert_eq!(page.entries.len(), 2);
    for entry in page.entries {
        assert_eq!(entry.record.revision, 2);
        assert_eq!(entry.record.data, Data::Present(json!("after")));
    }
    Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
}
