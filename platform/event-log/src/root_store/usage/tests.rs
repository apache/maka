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
use std::collections::BTreeSet;
use uuid::Uuid;

async fn open() -> (tempfile::TempDir, RootStore) {
    let dir = tempfile::tempdir().unwrap();
    let namespaces = root::RootNamespaces {
        ownership: dir.path().join("owners"),
        control: dir.path().join("control"),
    };
    let owner = Arc::new(root::RootOwner::create(&dir.path().join("root"), &namespaces).unwrap());
    let root = RootStore::open(owner).await.unwrap();
    (dir, root)
}
async fn admit(log: &EventLog, model: String, tokens: u64) {
    log.connection.run(move |connection| Box::pin(async move {
        let mut tx = connection.begin().await?;
        let id = Uuid::new_v4();
        let source = Uuid::new_v4();
        let records = [
            (id, "auxiliary_model_started", json!({"source":{"kind":"host_effect","id":source},"binding":{"connection_id":"connection","connection_slug":"named","model":model},"session_id":"session","started_at":{"secs_since_epoch":1,"nanos_since_epoch":0}})),
            (Uuid::new_v4(), "auxiliary_model_usage", json!({"request_id":id,"usage":{"input_tokens":tokens}})),
            (Uuid::new_v4(), "auxiliary_model_settled", json!({"request_id":id,"outcome":"success","completed_at":{"secs_since_epoch":2,"nanos_since_epoch":0}})),
        ];
        for (id, kind, event) in records {
            crate::canonical_insert::insert(crate::canonical_insert::Record {
                sequence: None, event_id: &id.to_string(), invocation_id: None,
                kind, operation_id: None, json: &event.to_string(),
            }).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    })).await.unwrap();
}
fn query() -> UsageQuery {
    UsageQuery {
        from: 0.0,
        to: 10_000.0,
        session_id: Some("session".into()),
        through: None,
    }
}

#[tokio::test]
async fn vector_fence_keyset_pages_merge_physical_journals_exactly_once() {
    let (_dir, root) = open().await;
    root.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    for index in 0..40 {
        admit(&root.partitions[0], format!("model-{index:02}"), 1).await;
        admit(&root.partitions[1], format!("model-{index:02}"), 2).await;
    }
    let report = root
        .usage_summary_page(query(), Group::ByModel, None)
        .await
        .unwrap();
    assert_eq!(report.summary.models.calls, 80);
    assert_eq!(report.summary.models.input.known, 120);
    assert_eq!(report.summary.models.output.missing, 80);
    assert_eq!(report.summary.by_model.len(), 32);
    assert!(
        report
            .summary
            .by_model
            .iter()
            .all(|entry| entry.totals.calls == 2 && entry.totals.input.known == 3)
    );
    let mut frozen = query();
    frozen.through = Some(report.through.clone());
    let more = root
        .usage_summary_page(frozen.clone(), Group::ByModel, report.next_cursor)
        .await
        .unwrap();
    assert_eq!(more.summary.by_model.len(), 8);
    assert!(more.next_cursor.is_none());
    assert_eq!(more.summary.models.calls, 80);
    let first = root
        .usage_activity(frozen.clone(), Selection::default(), None)
        .await
        .unwrap();
    assert_eq!(first.total, 80);
    assert_eq!(first.attempts.len(), 32);
    // A new settled admission at the same wall-clock time must not enter this fence.
    admit(&root.partitions[0], "new-model".into(), 1000).await;
    let mut ids = BTreeSet::new();
    let mut page = first;
    loop {
        for attempt in &page.attempts {
            assert!(ids.insert(cursor(attempt, 0).request_id));
        }
        let Some(after) = page.next_cursor else {
            break;
        };
        page = root
            .usage_activity(frozen.clone(), Selection::default(), Some(after))
            .await
            .unwrap();
        assert_eq!(page.total, 80);
    }
    assert_eq!(ids.len(), 80);
    let original = root.usage_totals(frozen).await.unwrap();
    assert_eq!(original.summary.models.input.known, 120);
    let current = root
        .session("session")
        .await
        .unwrap()
        .usage_totals(query())
        .await
        .unwrap();
    assert_eq!(current.summary.models.input.known, 1120);
    let mut foreign = query();
    foreign.through = Some(UsageFence {
        state_domain: "foreign".into(),
        partitions: [0; PARTITION_COUNT],
    });
    assert!(root.usage_totals(foreign).await.is_err());
    root.close().await.unwrap();
}
