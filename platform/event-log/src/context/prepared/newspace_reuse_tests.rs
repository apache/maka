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

async fn publish(
    log: &EventLog,
    policy: &str,
    pieces: usize,
    byte: u8,
) -> (PreparedView, PreparedWireView) {
    let logical = log
        .prepare_model_view(selection(1), policy, None)
        .await
        .unwrap();
    render(log, &logical, &BTreeMap::new()).await;
    let view = log.finish_prepared(&logical).await.unwrap();
    let build = log
        .prepare_wire_view(&view, WireFormat::Responses, policy, None)
        .await
        .unwrap();
    let wire = WireGroup {
        format: WireFormat::Responses,
        codec: policy.to_owned(),
        message_count: 1,
        chunks: Box::new((0..pieces).map(move |index| {
            Ok(WireChunk {
                bytes: vec![byte; 32 * 1024],
                message_index: 0,
                item_start: index == 0,
                item_end: index + 1 == pieces,
                metadata: None,
            })
        })),
    };
    log.put_prepared_wire_group(&build, &PreparedGroup { id: "1".into() }, wire)
        .await
        .unwrap();
    let wire = log.finish_prepared_wire(&build).await.unwrap();
    (view, wire)
}

async fn drain(log: &EventLog) {
    for _ in 0..10_000 {
        let registry = log.prepared.clone();
        let more = log
            .prepared_store()
            .unwrap()
            .run(move |connection, in_flight| {
                Box::pin(async move { gc::maintain(connection, &registry, in_flight).await })
            })
            .await
            .unwrap();
        if !more {
            return;
        }
    }
    panic!("prepared collection did not quiesce");
}

async fn space(log: &EventLog) -> (i64, i64, i64) {
    log.prepared_store()
        .unwrap()
        .read_interruptible(|connection| {
            Box::pin(async move {
                let pages = sqlx::query_scalar("PRAGMA prepared_cache.page_count")
                    .fetch_one(&mut *connection)
                    .await?;
                let free = sqlx::query_scalar("PRAGMA prepared_cache.freelist_count")
                    .fetch_one(&mut *connection)
                    .await?;
                let body_bytes = sqlx::query_scalar(
                    "SELECT COALESCE(SUM(length(bytes)),0) FROM context_prepared_chunks",
                )
                .fetch_one(connection)
                .await?;
                Ok((pages, free, body_bytes))
            })
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn live_preparations_reuse_collected_pages_then_idle_storage_shrinks() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    seed(&log, 1, 1, false).await;
    let (old_view, old_wire) = publish(&log, "large", 320, 1).await;
    let (current_view, current_wire) = publish(&log, "current", 1, 2).await;
    drop(old_wire);
    drop(old_view);
    drain(&log).await;
    let (pages, free, body_bytes) = space(&log).await;
    assert_eq!(
        body_bytes,
        32 * 1024,
        "unreachable old body must be deleted"
    );
    assert!(free > 0, "live preparation must retain reusable pages");
    assert_eq!(bytes(&log, &current_wire).await, vec![2; 32 * 1024]);

    let (next_view, next_wire) = publish(&log, "reuse", 32, 3).await;
    let (reused_pages, reused_free, _) = space(&log).await;
    assert_eq!(
        reused_pages, pages,
        "new storage must reuse available pages"
    );
    assert!(
        reused_free < free,
        "new body must consume the retained free pages"
    );
    assert_ne!(next_wire.identity, current_wire.identity);
    assert_eq!(bytes(&log, &next_wire).await, vec![3; 32 * 32 * 1024]);
    assert_eq!(bytes(&log, &current_wire).await, vec![2; 32 * 1024]);

    drop(next_wire);
    drop(next_view);
    drop(current_wire);
    drop(current_view);
    drain(&log).await;
    let (idle_pages, idle_free, body_bytes) = space(&log).await;
    assert_eq!(
        idle_free, 0,
        "last lease release must resume idle shrinking"
    );
    assert!(idle_pages < pages);
    assert_eq!(
        body_bytes,
        32 * 32 * 1024,
        "idle cache head must remain readable"
    );
    let cached = log
        .prepare_model_view(selection(1), "reuse", None)
        .await
        .unwrap();
    let cached = log.finish_prepared(&cached).await.unwrap();
    let cached_wire = log
        .prepare_wire_view(&cached, WireFormat::Responses, "reuse", None)
        .await
        .unwrap();
    let cached_wire = log.finish_prepared_wire(&cached_wire).await.unwrap();
    assert_eq!(bytes(&log, &cached_wire).await, vec![3; 32 * 32 * 1024]);
    log.close().await.unwrap();
}
