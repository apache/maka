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
use maka_agent_ports::session::history::{Cursor, HistoryField, Page, Position, Role};

#[tokio::test]
async fn cold_windows_use_complete_directory_and_preserve_all_anchor_kinds_after_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("sparse.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("a", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let (part, live) = partial(&log, "a", "answer😀").await;
    let assistant_id = part.message_id.clone();
    let sealed = interrupt(&log, "a", part).await;
    let through = end(
        &log,
        "a",
        InvocationOutcome::Cancelled {
            source: "user".into(),
        },
    )
    .await;
    let prefix = log.prefix(32, 65536).await.unwrap();
    let canonical = serde_json::to_vec(&prefix).unwrap();
    let mut view = maka_presentation::InvocationView::new();
    let expected: Vec<_> = prefix
        .events
        .iter()
        .flat_map(|fact| view.push(fact).unwrap())
        .collect();
    assert_eq!(expected.len(), 4);
    let assistant = expected
        .iter()
        .find(|row| row.message.id == assistant_id)
        .unwrap()
        .position;
    assert_eq!(
        assistant,
        RowPosition {
            source_sequence: sealed,
            item_index: 0
        }
    );
    assert!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "a"))
            .await
            .is_empty()
    );
    fn directory(db: &Connection) -> Vec<(i64, i64, String, String)> {
        db.prepare("SELECT source_sequence,item_index,message_id,role FROM transcript_directory WHERE session_id='a' ORDER BY source_sequence,item_index")
        .unwrap().query_map([],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?))).unwrap().collect::<Result<Vec<_>,_>>().unwrap()
    }
    assert!(
        crate::test_store::inspect_cache(&log, directory)
            .await
            .is_empty(),
        "append must not install observer metadata"
    );
    log.transcript_between_turns(
        "a",
        through,
        RowPosition {
            source_sequence: through,
            item_index: 0,
        },
    )
    .await
    .unwrap();
    assert!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "a"))
            .await
            .is_empty(),
        "directory installation must not hydrate bodies"
    );
    let metadata = crate::test_store::inspect_cache(&log, directory).await;
    assert_eq!(metadata.len(), expected.len());
    for (actual, row) in metadata.iter().zip(&expected) {
        assert_eq!(
            (actual.0 as u64, actual.1 as u64, &actual.2),
            (
                row.position.source_sequence,
                row.position.item_index,
                &row.message.id
            )
        );
    }
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "a"))
            .await
            .is_empty(),
        "ordinary reopen does not rebuild optional bodies"
    );
    // Each anchor starts with an independently empty body cache.
    let cursor = Cursor {
        position: assistant,
        field: HistoryField::Body,
        offset: 4,
    };
    for (position, texts) in [
        (Position::Tail, vec!["你好", "answer😀"]),
        (Position::Start, vec!["你好", "answer😀"]),
        (
            Position::Row {
                position: assistant,
                field: HistoryField::Body,
            },
            vec!["answer😀"],
        ),
        (Position::Event { sequence: sealed }, vec!["answer😀"]),
        (Position::Before { cursor }, vec!["你好", "answ"]),
        (Position::After { cursor }, vec!["er😀"]),
    ] {
        crate::test_store::inspect_cache(&log, move |db| {
            db.execute_batch("DELETE FROM temp.transcript_text; DELETE FROM temp.transcript_rows")
                .unwrap()
        })
        .await;
        let Page::Ready { chunks, .. } = log
            .history_text(
                "a",
                through,
                position,
                false,
                maka_event_log::transcript::HistoryLimits {
                    max_bytes: 8192,
                    max_chunks: Some(32),
                    max_json_bytes: 65536,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            chunks
                .iter()
                .map(|chunk| chunk.text.as_str())
                .collect::<Vec<_>>(),
            texts
        );
        for chunk in chunks {
            let original = expected
                .iter()
                .find(|row| row.position == chunk.position)
                .unwrap();
            assert_eq!(chunk.message_id, original.message.id);
            assert_eq!(chunk.turn_id, original.message.turn_id);
            assert_eq!(chunk.position.item_index, original.position.item_index);
            if chunk.role == Role::Assistant {
                assert_eq!(chunk.total_bytes, 10);
            }
        }
        assert_eq!(
            crate::test_store::inspect_cache(&log, directory).await,
            metadata,
            "cache reconstruction must preserve original metadata"
        );
    }
    crate::test_store::inspect_cache(&log, move |db| {
        db.execute_batch("DELETE FROM temp.transcript_text; DELETE FROM temp.transcript_rows; DELETE FROM temp.transcript_directory; DELETE FROM temp.transcript_failures; DELETE FROM temp.transcript_directory_progress")
            .unwrap()
    })
    .await;
    let Page::Ready {
        chunks,
        before,
        after,
        ..
    } = log
        .history_text(
            "a",
            through,
            Position::Tail,
            false,
            maka_event_log::transcript::HistoryLimits {
                max_bytes: 8192,
                max_chunks: Some(1),
                max_json_bytes: 65536,
            },
        )
        .await
        .unwrap();
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].message_id, assistant_id);
    assert!(before.is_some() && after.is_none());
    assert!(
        crate::test_store::inspect_cache(&log, |db| rows(db, "a"))
            .await
            .iter()
            .all(|row| row.0.source_sequence >= sealed),
        "tail must not hydrate unrelated opening rows"
    );
    // Later cache population cannot make an old fence observe the accepted suffix.
    let Page::Ready {
        chunks,
        before,
        after,
        ..
    } = log
        .history_text(
            "a",
            live,
            Position::Start,
            false,
            maka_event_log::transcript::HistoryLimits {
                max_bytes: 8192,
                max_chunks: Some(32),
                max_json_bytes: 65536,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        chunks
            .iter()
            .map(|chunk| chunk.text.as_str())
            .collect::<Vec<_>>(),
        ["你好"]
    );
    assert!(before.is_none() && after.is_none());
    assert_eq!(crate::test_store::inspect_cache(&log, |db| db.query_row("SELECT through_sequence FROM temp.transcript_directory_progress WHERE session_id='a'",[],|row|row.get::<_,i64>(0)).unwrap()).await,through as i64,"historical reads must not rewind progress after a later zero-row or visible source");
    assert_eq!(
        serde_json::to_vec(&log.prefix(32, 65536).await.unwrap()).unwrap(),
        canonical
    );
    log.close().await.unwrap();
}
