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

use maka_event_log::{EventLog, StoreError};
use serde_json::json;

#[tokio::test]
async fn data_batches_are_namespaced_atomic_and_preserve_tombstone_revisions() {
    use maka_plugin_core::scope::Scope;
    use maka_plugin_core::storage::Data;
    use maka_plugin_core::storage::Mutation;
    use maka_plugin_core::storage::Namespace;
    use maka_plugin_core::storage::Scan;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("data.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let namespace = Namespace::new("graph", Scope::Profile).unwrap();
    let mutation = |key: &str, revision, data| Mutation {
        key: key.into(),
        expected_revision: revision,
        data,
    };
    log.plugin_data_batch(
        &namespace,
        vec![mutation("state", None, Data::Present(json!(null)))],
    )
    .await
    .unwrap();
    let stored = log.plugin_data(&namespace, "state").await.unwrap().unwrap();
    assert_eq!(stored.revision, 1);
    assert_eq!(stored.data, Data::Present(json!(null)));
    let rejected = log
        .plugin_data_batch(
            &namespace,
            vec![
                mutation("new", None, Data::Present(json!(1))),
                mutation("state", None, Data::Deleted),
            ],
        )
        .await;
    assert!(matches!(rejected, Err(StoreError::RevisionConflict { .. })));
    assert!(log.plugin_data(&namespace, "new").await.unwrap().is_none());
    log.plugin_data_batch(&namespace, vec![mutation("state", Some(1), Data::Deleted)])
        .await
        .unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let deleted = log.plugin_data(&namespace, "state").await.unwrap().unwrap();
    assert_eq!(deleted.revision, 2);
    assert_eq!(deleted.data, Data::Deleted);
    let page = log
        .plugin_data_scan(&namespace, Scan::default())
        .await
        .unwrap();
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].record, deleted);
    assert!(page.next_after.is_none());
    assert!(
        log.plugin_data_batch(
            &namespace,
            vec![mutation("state", None, Data::Present(json!(2)))]
        )
        .await
        .is_err()
    );
    let separate = Namespace::new("graph", Scope::Session("other".into())).unwrap();
    assert!(log.plugin_data(&separate, "state").await.unwrap().is_none());
    assert!(
        log.plugin_data_scan(&separate, Scan::default())
            .await
            .unwrap()
            .entries
            .is_empty()
    );
    let mut records = (0..66)
        .map(|n| mutation(&format!("r%_/{n:03}"), None, Data::Present(json!(n))))
        .collect::<Vec<_>>();
    records.push(mutation(
        "rax/not-selected",
        None,
        Data::Present(json!(false)),
    ));
    log.plugin_data_batch(&namespace, records).await.unwrap();
    let page = log
        .plugin_data_scan(
            &namespace,
            Scan {
                prefix: "r%_/".into(),
                after: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(page.entries.len(), 64);
    assert_eq!(page.next_after.as_deref(), Some("r%_/063"));
    let tail = log
        .plugin_data_scan(
            &namespace,
            Scan {
                prefix: "r%_/".into(),
                after: page.next_after,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        tail.entries
            .iter()
            .map(|entry| entry.key.as_str())
            .collect::<Vec<_>>(),
        ["r%_/064", "r%_/065"]
    );
    assert!(tail.next_after.is_none());
    log.plugin_data_batch(
        &namespace,
        (0..3)
            .map(|n| {
                mutation(
                    &format!("large/{n}"),
                    None,
                    Data::Present(json!("x".repeat(900_000))),
                )
            })
            .collect(),
    )
    .await
    .unwrap();
    let page = log
        .plugin_data_scan(
            &namespace,
            Scan {
                prefix: "large/".into(),
                after: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        page.entries.len(),
        2,
        "byte budget also bounds decoded rows"
    );
    assert_eq!(page.next_after.as_deref(), Some("large/1"));
    let tail = log
        .plugin_data_scan(
            &namespace,
            Scan {
                prefix: "large/".into(),
                after: page.next_after,
            },
        )
        .await
        .unwrap();
    assert_eq!(tail.entries.len(), 1);
    assert!(
        matches!(&tail.entries[0].record.data, Data::Present(value) if value.as_str().unwrap().len() == 900_000)
    );
    assert!(tail.next_after.is_none());
    log.plugin_data_batch(
        &namespace,
        vec![mutation("state", Some(2), Data::Present(json!(3)))],
    )
    .await
    .unwrap();
    log.close().await.unwrap();
}
