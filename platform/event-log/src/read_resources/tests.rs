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
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

async fn append_noise(log: &EventLog, first: i64, last: i64) {
    log.connection.run(move |db| Box::pin(async move {
        let mut tx=db.begin().await?;
        sqlx::query("INSERT INTO artifact_contents(content_sha256,payload) VALUES ('test',X'') ON CONFLICT DO NOTHING").execute(&mut *tx).await?;
        for number in first..=last {
            let id=format!("noise-{number:08}");
            sqlx::query("INSERT INTO artifacts(session_id,id,created_at,record_json,content_sha256,lookup_digest)
                VALUES('session',?,0,json_object('sessionId','session','id',?,'createdAt',0,'sizeBytes',0,'source','user_upload'),'test',?)")
                .bind(&id).bind(&id).bind(crate::artifacts::identity::artifact_lookup_digest("session",&id).as_slice()).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    })).await.unwrap();
}

async fn resolve_steps(log: &EventLog, prefix: &str) -> (Option<ResourceAddress>, u64) {
    resource_steps(log, ResourceAddress::Attachment(prefix.into())).await
}

async fn resource_steps(
    log: &EventLog,
    address: ResourceAddress,
) -> (Option<ResourceAddress>, u64) {
    let count = Arc::new(AtomicU64::new(0));
    let observed = count.clone();
    log.connection
        .run(move |db| {
            Box::pin(async move {
                db.lock_handle().await?.set_progress_handler(1, move || {
                    observed.fetch_add(1, Ordering::Relaxed);
                    true
                });
                Ok(())
            })
        })
        .await
        .unwrap();
    let resolved = log.resolve_read_resource("session", address).await.unwrap();
    log.connection
        .run(|db| {
            Box::pin(async move {
                db.lock_handle().await?.remove_progress_handler();
                Ok(())
            })
        })
        .await
        .unwrap();
    (resolved, count.load(Ordering::Relaxed))
}

#[tokio::test]
async fn literal_prefix_lookup_keeps_index_range_with_fixed_plans() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    log.create_session("session", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    append_noise(&log, 1, 128).await;
    log.connection.run(|db| Box::pin(async move {
        sqlx::query("INSERT INTO artifacts(session_id,id,created_at,record_json,content_sha256,lookup_digest)
            VALUES('session','wanted-resource-literal',0,
                '{\"sessionId\":\"session\",\"id\":\"wanted-resource-literal\",\"createdAt\":0,\"sizeBytes\":0,\"source\":\"user_upload\"}',
                'test',?)").bind(crate::artifacts::identity::artifact_lookup_digest("session","wanted-resource-literal").as_slice()).execute(db).await?;
        Ok(())
    })).await.unwrap();
    let (small, small_steps) = resolve_steps(&log, "wanted-resource-").await;
    assert_eq!(
        small,
        Some(ResourceAddress::Attachment(
            "wanted-resource-literal".into()
        ))
    );
    append_noise(&log, 129, 16_384).await;
    let (large, large_steps) = resolve_steps(&log, "wanted-resource-").await;
    assert_eq!(large, small);
    assert!(
        large_steps <= small_steps + 256,
        "prefix lookup scanned unrelated resources: {small_steps} -> {large_steps}"
    );
    assert_eq!(resolve_steps(&log, "wanted-other").await.0, None);
    log.close().await.unwrap();
}

async fn append_event_noise(log: &EventLog, first: i64, last: i64) {
    log.connection
        .run(move |db| {
            Box::pin(async move {
                let mut tx = db.begin().await?;
                crate::connection::worker_query(&mut tx, move |worker| {
                    Box::pin(async move {
                        for n in first..=last {
                            crate::canonical_insert::insert(crate::canonical_insert::Record {
                                sequence: None,
                                event_id: &format!("noise-event-{n:08}"),
                                invocation_id: Some("noise"),
                                kind: "probe",
                                operation_id: None,
                                json: r#"{"invocation":{"session_id":"session"}}"#,
                            })
                            .execute(&mut *worker)
                            .await?;
                        }
                        Ok(())
                    })
                })
                .await?;
                tx.commit().await?;
                Ok(())
            })
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn tool_result_prefix_lookup_does_not_scan_owner_history() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    log.create_session("session", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    append_event_noise(&log, 1, 128).await;
    log.connection.run(|db| Box::pin(async move {
        for (id, kind, json) in [
            ("dispatch-target", "tool_dispatched", r#"{"invocation":{"session_id":"session"},"fact":{"call":{"origin":{"kind":"provider"}}}}"#),
            ("result-target-literal", "tool_settled", r#"{"invocation":{"session_id":"session"},"fact":{"outcome":{"kind":"failed"}}}"#),
        ] {
            crate::canonical_insert::insert(crate::canonical_insert::Record {
                sequence: None, event_id: id, invocation_id: Some("target"),
                kind, operation_id: Some("target-operation"), json,
            }).execute(&mut *db).await?;
        }
        Ok(())
    })).await.unwrap();
    let wanted = ResourceAddress::ToolResult("result-target-".into());
    let (small, small_steps) = resource_steps(&log, wanted.clone()).await;
    assert_eq!(
        small,
        Some(ResourceAddress::ToolResult("result-target-literal".into()))
    );
    append_event_noise(&log, 129, 16_384).await;
    let (large, large_steps) = resource_steps(&log, wanted).await;
    assert_eq!(large, small);
    assert!(
        large_steps <= small_steps + 256,
        "tool prefix lookup scanned unrelated owner history: {small_steps} -> {large_steps}"
    );
    assert_eq!(
        log.resolve_read_resource(
            "other",
            ResourceAddress::ToolResult("result-target-".into())
        )
        .await
        .unwrap(),
        None
    );
    log.close().await.unwrap();
}
