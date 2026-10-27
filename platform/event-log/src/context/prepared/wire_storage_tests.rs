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

fn fragments(count: usize, invalid_last: bool) -> WireGroup {
    WireGroup {
        format: WireFormat::Responses,
        codec: "fixture-v1".into(),
        message_count: 1,
        chunks: Box::new((0..count).map(move |index| {
            Ok(WireChunk {
                bytes: vec![
                    index as u8;
                    if invalid_last && index + 1 == count {
                        32769
                    } else {
                        1024
                    }
                ],
                message_index: 0,
                item_start: index == 0,
                item_end: index + 1 == count,
                metadata: Some(serde_json::json!({"piece":index})),
            })
        })),
    }
}

#[tokio::test]
async fn duplicate_wire_and_failed_encoding_preserve_pages_metadata_and_identity() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    seed(&log, 1, 1, false).await;
    let logical = log
        .prepare_model_view(selection(1), "wire-storage", None)
        .await
        .unwrap();
    render(&log, &logical, &BTreeMap::new()).await;
    let view = log.finish_prepared(&logical).await.unwrap();
    let build = log
        .prepare_wire_view(&view, WireFormat::Responses, "fixture-v1", None)
        .await
        .unwrap();
    let group = PreparedGroup { id: "1".into() };
    log.put_prepared_wire_group(&build, &group, fragments(259, false))
        .await
        .unwrap();
    let first = log.finish_prepared_wire(&build).await.unwrap();
    log.put_prepared_wire_group(&build, &group, fragments(259, false))
        .await
        .unwrap();
    let duplicate = log.finish_prepared_wire(&build).await.unwrap();
    assert_eq!(first.identity, duplicate.identity);
    assert_eq!(
        log.prepared_wire_prefix_identity(&first, 1).await.unwrap(),
        log.prepared_wire_prefix_identity(&duplicate, 1)
            .await
            .unwrap()
    );
    let error = log
        .put_prepared_wire_group(&build, &group, fragments(2, true))
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("invalid prepared wire fragment boundary")
    );

    let mut cursor = PreparedWireCursor::default();
    let mut count = 0;
    loop {
        let page = log.prepared_wire_page(&first, cursor, 17).await.unwrap();
        for chunk in page.chunks {
            assert_eq!(chunk.bytes, vec![count as u8; 1024]);
            assert_eq!(chunk.message_index, 0);
            assert_eq!(chunk.item_start, count == 0);
            assert_eq!(chunk.item_end, count == 258);
            assert_eq!(chunk.metadata, Some(serde_json::json!({"piece":count})));
            count += 1;
        }
        match page.next_cursor {
            Some(next) => cursor = next,
            None => break,
        }
    }
    assert_eq!(count, 259);
    let mut cursor = PreparedWireCursor::default();
    let mut count = 0;
    loop {
        let page = log
            .prepared_wire_metadata_page(&duplicate, cursor, 19)
            .await
            .unwrap();
        for item in page.items {
            assert_eq!(item.message_index, 0);
            assert_eq!(item.metadata, serde_json::json!({"piece":count}));
            count += 1;
        }
        match page.next_cursor {
            Some(next) => cursor = next,
            None => break,
        }
    }
    assert_eq!(count, 259);
    let mut drained = false;
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
            drained = true;
            break;
        }
    }
    assert!(drained, "duplicate wire storage did not finish retirement");
    let counts: (i64, i64) = log
        .prepared_store()
        .unwrap()
        .read_interruptible(|connection| {
            Box::pin(async move {
                Ok(sqlx::query_as(
                    "SELECT COUNT(digest),COUNT(*)-COUNT(digest) FROM context_prepared_payloads",
                )
                .fetch_one(connection)
                .await?)
            })
        })
        .await
        .unwrap();
    assert_eq!(counts, (1, 0));
    log.close().await.unwrap();
}

#[tokio::test]
async fn same_digest_reappears_while_old_storage_is_partially_collected() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    log.prepared_store().unwrap().run(|connection, _in_flight| Box::pin(async move {
        let mut tx = connection.begin().await?;
        sqlx::query("INSERT INTO context_prepared_payloads VALUES('a-old','same-content')").execute(&mut *tx).await?;
        sqlx::query("INSERT INTO context_prepared_refs VALUES('wire','same-content',0)").execute(&mut *tx).await?;
        for index in 0..260i64 {
            sqlx::query("INSERT INTO context_prepared_chunks VALUES('a-old',?,0,0,0,NULL,?)").bind(index).bind(vec![index as u8; 16]).execute(&mut *tx).await?;
        }
        gc::collect_unreachable(&mut tx).await?;
        let (withdrawn, remaining): (bool,i64) = sqlx::query_as("SELECT digest IS NULL,(SELECT COUNT(*) FROM context_prepared_chunks WHERE storage_id='a-old') FROM context_prepared_payloads WHERE storage_id='a-old'").fetch_one(&mut *tx).await?;
        assert!(withdrawn);
        assert_eq!(remaining, 132);

        sqlx::query("INSERT INTO context_prepared_payloads(storage_id) VALUES('b-new')").execute(&mut *tx).await?;
        for index in 0..260i64 {
            sqlx::query("INSERT INTO context_prepared_chunks VALUES('b-new',?,0,0,0,NULL,?)").bind(index).bind(vec![index as u8; 16]).execute(&mut *tx).await?;
        }
        wire::publish_payload(&mut tx, "b-new", "same-content").await?;
        sqlx::query("INSERT INTO context_prepared_refs VALUES('wire','same-content',1)").execute(&mut *tx).await?;
        gc::collect_unreachable(&mut tx).await?;
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM context_prepared_chunks WHERE storage_id='a-old'").fetch_one(&mut *tx).await?;
        assert_eq!(remaining, 4);
        gc::collect_unreachable(&mut tx).await?;
        let old_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM context_prepared_payloads WHERE storage_id='a-old')").fetch_one(&mut *tx).await?;
        assert!(!old_exists);
        let storage: String = sqlx::query_scalar("SELECT storage_id FROM context_prepared_payloads WHERE digest='same-content'").fetch_one(&mut *tx).await?;
        assert_eq!(storage, "b-new");
        let pieces: Vec<Vec<u8>> = sqlx::query_scalar("SELECT bytes FROM context_prepared_chunks WHERE storage_id=? ORDER BY piece_index").bind(storage).fetch_all(&mut *tx).await?;
        assert_eq!(pieces, (0..260).map(|index|vec![index as u8;16]).collect::<Vec<_>>());
        tx.rollback().await?;
        Ok(())
    })).await.unwrap();
    log.close().await.unwrap();
}
