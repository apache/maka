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
    assert_log_refs(&log).await;
    log.close().await.unwrap();
}

#[tokio::test]
async fn wire_envelope_failure_retries_the_same_build_without_changing_logical_snapshot() {
    async fn snapshot(log: &EventLog, view: &PreparedView) -> serde_json::Value {
        let group = log.prepared_semantic_group(view, 1).await.unwrap().unwrap();
        serde_json::to_value((
            group.rows,
            group.manifest,
            group.skip,
            view.message_count,
            &view.breakdown,
            log.prepared_prefix_identity(view, 1).await.unwrap(),
        ))
        .unwrap()
    }
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("wire-retry.sqlite"))
        .await
        .unwrap();
    seed(&log, 1, 1, false).await;
    log.connection
        .run(|db| {
            Box::pin(async move {
                let payload = maka_agent_facts::history::semantic::Payload::Text(
                    "captured logical row".into(),
                );
                sqlx::query("INSERT INTO context_semantic_fragments VALUES(1,0,1,0)")
                    .execute(&mut *db)
                    .await?;
                sqlx::query("INSERT INTO context_semantic_fragment_pieces VALUES(1,0,0,?)")
                    .bind(serde_json::to_vec(&payload)?)
                    .execute(db)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    let messages = vec![
        Message::user("first 漢字🙂"),
        Message::user("second logical message"),
    ];
    let values = BTreeMap::from([("1".into(), messages.clone())]);
    let logical = log
        .prepare_model_view(selection(1), "wire-retry", None)
        .await
        .unwrap();
    assert_eq!(render(&log, &logical, &values).await, 1);
    let view = log.finish_prepared(&logical).await.unwrap();
    assert_eq!(view.message_count, 2);
    let before = snapshot(&log, &view).await;
    let build = log
        .prepare_wire_view(&view, WireFormat::Responses, "fixture-v1", None)
        .await
        .unwrap();
    let group = PreparedGroup { id: "1".into() };
    let mut wrong = encoded_wire(&messages, WireFormat::Responses, "ordinary");
    wrong.message_count = 3;
    assert!(
        log.put_prepared_wire_group(&build, &group, wrong)
            .await
            .unwrap_err()
            .to_string()
            .contains("logical message count")
    );
    let root = view.root.clone();
    let wire_view = build.id.clone();
    log.prepared_store().unwrap().run(move |db,_|Box::pin(async move {
        let logical_id=tree::content_id(db,root.as_deref(),1).await?;
        sqlx::query("CREATE TEMP TABLE wire_fault_target(logical_id TEXT,view_id TEXT)").execute(&mut *db).await?;
        sqlx::query("INSERT INTO wire_fault_target VALUES(?,?)").bind(logical_id).bind(wire_view).execute(&mut *db).await?;
        sqlx::raw_sql("CREATE TEMP TRIGGER fail_wire_edge BEFORE UPDATE ON prepared_cache.context_prepared_refs
            WHEN NEW.kind='group' AND NEW.id=(SELECT logical_id FROM wire_fault_target)
              AND EXISTS(SELECT 1 FROM context_prepared_chunks)
              AND EXISTS(SELECT 1 FROM context_prepared_wire_dirty WHERE view_id=(SELECT view_id FROM wire_fault_target) AND content IS NOT NULL)
            BEGIN SELECT RAISE(ABORT,'wire logical edge fault'); END;").execute(db).await?;
        Ok(())
    })).await.unwrap();
    let error = log
        .put_prepared_wire_group(
            &build,
            &group,
            encoded_wire(&messages, WireFormat::Responses, "ordinary"),
        )
        .await
        .unwrap_err();
    assert!(matches!(&error, StoreError::Sqlx(sqlx::Error::Database(_))));
    assert!(error.to_string().contains("wire logical edge fault"));
    assert_eq!(snapshot(&log, &view).await, before);
    assert_eq!(
        log.prepared_wire_dirty_groups(&build, None, 8)
            .await
            .unwrap()
            .iter()
            .map(|group| group.id.as_str())
            .collect::<Vec<_>>(),
        ["1"]
    );
    log.prepared_store().unwrap().run(|db,_|Box::pin(async move {
        let failed:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT COUNT(*) FROM context_prepared_payloads),(SELECT COUNT(*) FROM context_prepared_chunks),(SELECT COUNT(*) FROM context_prepared_wire_dirty WHERE content IS NOT NULL)").fetch_one(&mut *db).await?;
        assert_eq!(failed,(0,0,0),"failed publication must roll back chunks, envelope staging and payload together");
        assert_refs(db).await?;
        sqlx::raw_sql("DROP TRIGGER fail_wire_edge; DROP TABLE wire_fault_target;").execute(db).await?;
        Ok(())
    })).await.unwrap();
    log.put_prepared_wire_group(
        &build,
        &group,
        encoded_wire(&messages, WireFormat::Responses, "ordinary"),
    )
    .await
    .unwrap();
    let first = log.finish_prepared_wire(&build).await.unwrap();
    assert_eq!(first.message_count, view.message_count);
    let expected: Vec<u8> = messages
        .iter()
        .flat_map(|message| serde_json::to_vec(&("ordinary", message)).unwrap())
        .collect();
    assert_eq!(bytes(&log, &first).await, expected);
    let prefix = log.prepared_wire_prefix_identity(&first, 1).await.unwrap();
    assert_eq!(snapshot(&log, &view).await, before);
    let alternate = log
        .prepare_wire_view(&view, WireFormat::Responses, "alternate", None)
        .await
        .unwrap();
    let mut encoded = encoded_wire(
        &messages,
        WireFormat::Responses,
        "different encoding and metadata",
    );
    encoded.codec = "alternate".into();
    log.put_prepared_wire_group(&alternate, &group, encoded)
        .await
        .unwrap();
    let alternate = log.finish_prepared_wire(&alternate).await.unwrap();
    assert_eq!(alternate.message_count, view.message_count);
    assert_ne!(bytes(&log, &alternate).await, expected);
    lifetimes::drain(&log).await;
    assert_eq!(bytes(&log, &first).await, expected);
    assert_eq!(
        log.prepared_wire_prefix_identity(&first, 1).await.unwrap(),
        prefix
    );
    assert_eq!(snapshot(&log, &view).await, before);
    assert_log_refs(&log).await;
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
        let mut refs=refs::RefBatch::default();
        refs.create(&mut tx,refs::Kind::Wire,"same-content").await?;
        refs.flush(&mut tx).await?;
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
        let mut refs=refs::RefBatch::default();
        let group=Group { index_bytes:0,dependencies:vec![],members:vec![1],messages:vec![],manifest:Default::default(),breakdown:Default::default() };
        let logical_content=tree::save_group(&mut tx,&mut refs,&group).await?;
        let (logical_id,_)=tree::logical_group(&mut tx,&logical_content).await?;
        let content=tree::save_wire_group(&mut tx,&mut refs,tree::WireGroup::new(logical_id,"same-content".into(),4160)).await?;
        sqlx::query("INSERT INTO context_prepared_builds(id,cache_key,selection_json,through_sequence,captured_revision,before_sequence,previous_revision,identity,discovered) VALUES('owner','fixture','{}',0,0,1,0,'owner',1)").execute(&mut *tx).await?;
        sqlx::query("INSERT INTO context_prepared_wire_views(id,build_id,codec,format_json,discovered) VALUES('wire-owner','owner','fixture',?,1)").bind(encoded(&WireFormat::Responses)?).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO context_prepared_wire_dirty(view_id,group_sequence) VALUES('wire-owner',1)").execute(&mut *tx).await?;
        assembly::stage(&mut tx,&mut refs,&runtime::InFlight::default(),assembly::Kind::Wire,"wire-owner",1,&content).await?;
        refs.flush(&mut tx).await?;
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
        assert_refs(&mut tx).await?;
        tx.rollback().await?;
        Ok(())
    })).await.unwrap();
    log.close().await.unwrap();
}
