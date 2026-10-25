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

use crate::{EventLog, test_store::inspect};
use maka_agent_facts::{
    event::{EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent},
    history::RowPosition,
};
use maka_agent_ports::session::history::{HistoryField, Page, Position};

async fn user(log: &EventLog, turn: &str, text: String) -> u64 {
    user_input(
        log,
        turn,
        InvocationInput::Message {
            source_messages: vec![],
            content: text.into(),
            request_fingerprint: None,
        },
    )
    .await
}

async fn user_input(log: &EventLog, turn: &str, input: InvocationInput) -> u64 {
    let write = EventWrite::plain(RuntimeEvent::new(
        Invocation {
            session_id: "cache".into(),
            turn_id: turn.into(),
            run_id: format!("run-{turn}"),
            invocation_id: format!("inv-{turn}"),
        },
        Fact::InvocationOpened {
            configuration: None,
            input,
        },
    ))
    .unwrap();
    let source = log.append(&write).await.unwrap();
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            write.event().invocation.clone(),
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
    source
}

async fn read(log: &EventLog, through: u64, position: Position) -> Page {
    log.history_text(
        "cache",
        through,
        position,
        false,
        crate::transcript::HistoryLimits {
            max_bytes: 8192,
            max_chunks: Some(1),
            max_json_bytes: 32768,
        },
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn private_body_reads_do_not_write_main_and_reopen_reconstructs_exact_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("history.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("cache", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let expected = "hello 中🙂\n".repeat(200);
    let through = user(&log, "first", expected.clone()).await;
    let main = rusqlite::Connection::open(&path).unwrap();
    let version = || {
        main.query_row("PRAGMA data_version", [], |row| row.get::<_, i64>(0))
            .unwrap()
    };
    let before = version();
    let page = read(&log, through, Position::Start).await;
    let Page::Ready { chunks, .. } = &page;
    assert_eq!(
        chunks
            .iter()
            .map(|chunk| chunk.text.as_str())
            .collect::<String>(),
        expected
    );
    let position = RowPosition {
        source_sequence: through,
        item_index: 0,
    };
    let header = log
        .transcript_headers(
            "cache",
            &crate::transcript::TranscriptRead {
                through,
                position: Some(position),
                direction: crate::transcript::TranscriptDirection::Newer,
                limit: 1,
            },
        )
        .await
        .unwrap()
        .remove(0);
    let payload = log
        .transcript_fragment("cache", position, 0, header.total_bytes)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&payload).unwrap()["text"],
        expected
    );
    assert_eq!(
        version(),
        before,
        "cold body/text filling must not commit to main"
    );
    inspect(&log, |db| {
        assert!(db.query_row("SELECT count(*) FROM transcript_cache.rows", [], |row| row.get::<_, i64>(0)).unwrap()>0);
        assert_eq!(db.query_row("SELECT count(*) FROM main.sqlite_schema WHERE name IN ('transcript_rows','transcript_text')", [], |row| row.get::<_, i64>(0)).unwrap(),0);
        assert_eq!(db.query_row("PRAGMA main.journal_mode", [], |row| row.get::<_, String>(0)).unwrap(), "wal");
        for (query, expected) in [("PRAGMA main.synchronous",2), ("PRAGMA transcript_cache.page_size",4096), ("PRAGMA transcript_cache.auto_vacuum",1), ("PRAGMA transcript_cache.cache_size",-4096), ("PRAGMA transcript_cache.synchronous",0), ("PRAGMA temp_store",1)] {
            assert_eq!(db.query_row(query, [], |row| row.get::<_, i64>(0)).unwrap(), expected, "{query}");
        }
        assert_eq!(db.query_row("SELECT count(*) FROM pragma_compile_options WHERE compile_options='TEMP_STORE=3'", [], |row| row.get::<_, i64>(0)).unwrap(),0,"temporary storage must be spillable");
    }).await;
    log.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    inspect(&reopened, |db| {
        assert_eq!(
            db.query_row("SELECT count(*) FROM transcript_cache.rows", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        )
    })
    .await;
    let before = version();
    assert_eq!(
        serde_json::to_value(read(&reopened, through, Position::Start).await).unwrap(),
        serde_json::to_value(page).unwrap()
    );
    assert_eq!(version(), before);
    reopened.close().await.unwrap();
}

/// Observe actual VFS backing size while holding the original SQLite worker.
/// An unspilled temporary database has no open file methods yet.
fn backing_bytes(db: &rusqlite::Connection) -> Option<i64> {
    use rusqlite::ffi;
    let mut file: *mut ffi::sqlite3_file = std::ptr::null_mut();
    // SAFETY: db and its VFS file remain owned and exclusively accessed by this
    // callback; neither the handle nor method pointers escape it.
    unsafe {
        assert_eq!(
            ffi::sqlite3_file_control(
                db.handle(),
                c"transcript_cache".as_ptr(),
                ffi::SQLITE_FCNTL_FILE_POINTER,
                (&mut file as *mut *mut ffi::sqlite3_file).cast()
            ),
            ffi::SQLITE_OK
        );
        if file.is_null() || (*file).pMethods.is_null() {
            return None;
        }
        let mut size = 0;
        assert_eq!(
            ((*(*file).pMethods).xFileSize.unwrap())(file, &mut size),
            ffi::SQLITE_OK
        );
        Some(size)
    }
}

#[tokio::test]
async fn oversized_source_reuses_fragments_then_reclaims_backing_file_on_replacement() {
    use maka_agent_facts::{
        input::{DeliveredMessage, MessageInput},
        message::{MessageDisposition, MessageOrigin, Placement, RootSourceMessage, aggregate},
    };
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("oversized.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("cache", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    // One canonical producer owns 34 MiB across enough siblings to distinguish
    // an indexed continuation from a repeated cache-wide maintenance scan.
    let text: MessageInput = "α".repeat(17 * 1024).into();
    let digest = text.content_digest().unwrap();
    const SIBLINGS: usize = 1024;
    let sources: Vec<_> = (0..SIBLINGS)
        .map(|index| RootSourceMessage {
            message: DeliveredMessage {
                origin: Some(MessageOrigin::WorkhubTask {
                    task_id: format!("task-{index}"),
                }),
                message_id: format!("large-{index}"),
                content: text.clone(),
                submitted_content_digest: digest.clone(),
            },
            unprepared_content: text.clone(),
            submitted_placement: Placement::CurrentTurn,
            disposition: MessageDisposition::TurnStarted,
            submitted_intent: None,
        })
        .collect();
    let through = user_input(
        &log,
        "large",
        InvocationInput::Message {
            content: aggregate(sources.iter().map(|source| &source.message.content)),
            source_messages: sources,
            request_fingerprint: None,
        },
    )
    .await;
    let position = RowPosition {
        source_sequence: through,
        item_index: 0,
    };
    let page = read(
        &log,
        through,
        Position::Row {
            position,
            field: HistoryField::Body,
        },
    )
    .await;
    let Page::Ready { chunks, after, .. } = page;
    assert_eq!(chunks[0].text, "α".repeat(4096));
    let before = inspect(&log, move |db| {
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM transcript_cache.rows WHERE session_id='cache' AND source_sequence=?",
                [through as i64],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            SIBLINGS as i64 + 1,
            "the opening must project each attributed message and its running state"
        );
        assert!(
            db.query_row("PRAGMA transcript_cache.page_count", [], |row| row
                .get::<_, i64>(0))
                .unwrap()
                > super::RETAINED_PAGES
        );
        (
            db.total_changes(),
            backing_bytes(db).expect("large source must spill with a 4 MiB pager target"),
        )
    })
    .await;
    let steps = Arc::new(AtomicUsize::new(0));
    let observed = steps.clone();
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
    let Page::Ready { chunks, .. } = read(
        &log,
        through,
        Position::After {
            cursor: after.unwrap(),
        },
    )
    .await;
    log.connection
        .run(|db| {
            Box::pin(async move {
                db.lock_handle().await?.remove_progress_handler();
                Ok(())
            })
        })
        .await
        .unwrap();
    let steps = steps.load(Ordering::Relaxed);
    // Even one correlated sweep of all siblings must read/compare both source
    // key columns and advance each row (>8 VM ops/row). Stay below that sweep
    // lower bound, rather than imposing a machine-dependent elapsed-time cap.
    assert!(
        steps > 0 && steps < SIBLINGS * 8,
        "cached continuation must not scan all {SIBLINGS} siblings: {steps} VM steps"
    );
    assert_eq!(chunks[0].text, "α".repeat(4096));
    inspect(&log, move |db| {
        assert_eq!(
            db.total_changes(),
            before.0,
            "another fragment must reuse the same source and text"
        )
    })
    .await;
    let small = user(&log, "small", "replacement 中🙂".into()).await;
    let Page::Ready { chunks, .. } = read(
        &log,
        small,
        Position::Row {
            position: RowPosition {
                source_sequence: small,
                item_index: 0,
            },
            field: HistoryField::Body,
        },
    )
    .await;
    assert_eq!(chunks[0].text, "replacement 中🙂");
    inspect(&log, move |db| {
        let pages = db
            .query_row("PRAGMA transcript_cache.page_count", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        assert!(pages <= super::RETAINED_PAGES);
        assert_eq!(
            db.query_row("PRAGMA transcript_cache.freelist_count", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM transcript_cache.rows WHERE source_sequence=?",
                [through as i64],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        let size = backing_bytes(db).unwrap();
        assert!(
            size <= 32 * 1024 * 1024 && size < before.1,
            "actual temporary file must shrink: {} -> {size}",
            before.1
        );
    })
    .await;
    let Page::Ready { chunks, .. } = read(
        &log,
        through,
        Position::Row {
            position,
            field: HistoryField::Body,
        },
    )
    .await;
    assert_eq!(
        chunks[0].text,
        "α".repeat(4096),
        "evicted source reconstructs without changing its identity or bytes"
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn late_sibling_conflicts_roll_back_all_earlier_cache_fills() {
    use maka_agent_facts::{
        input::DeliveredMessage,
        message::{MessageDisposition, Placement, RootSourceMessage, aggregate},
    };
    for corruption in ["identity", "payload", "digest", "bytes", "unique_message"] {
        let directory = tempfile::tempdir().unwrap();
        let log = EventLog::open(&directory.path().join("conflict.sqlite"))
            .await
            .unwrap();
        log.create_session("cache", "create", &serde_json::json!({}), 1)
            .await
            .unwrap();
        let sources: Vec<_> = (0..35)
            .map(|index| {
                let content: maka_agent_facts::input::MessageInput =
                    format!("sibling {index}").into();
                let digest = content.content_digest().unwrap();
                RootSourceMessage {
                    message: DeliveredMessage {
                        origin: Some(maka_agent_facts::message::MessageOrigin::WorkhubTask {
                            task_id: format!("task-{index}"),
                        }),
                        message_id: format!("message-{index}"),
                        content: content.clone(),
                        submitted_content_digest: digest,
                    },
                    unprepared_content: content,
                    submitted_placement: Placement::CurrentTurn,
                    disposition: MessageDisposition::TurnStarted,
                    submitted_intent: None,
                }
            })
            .collect();
        let through = user_input(
            &log,
            "siblings",
            InvocationInput::Message {
                content: aggregate(sources.iter().map(|source| &source.message.content)),
                source_messages: sources,
                request_fingerprint: None,
            },
        )
        .await;
        read(&log, through, Position::Start).await;
        let before = inspect(&log, move |db| {
            db.execute(
                "DELETE FROM transcript_cache.rows WHERE item_index != 34",
                [],
            )
            .unwrap();
            assert_eq!(
                db.query_row("SELECT count(*) FROM transcript_cache.rows", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
                1
            );
            match corruption {
                "identity" => db.execute(
                    "UPDATE transcript_directory SET turn_id='wrong' WHERE item_index=34",
                    [],
                ),
                "payload" => db.execute("UPDATE transcript_cache.rows SET payload=x'00'", []),
                "digest" => db.execute("UPDATE transcript_cache.rows SET digest='wrong'", []),
                "bytes" => db.execute(
                    "UPDATE transcript_cache.rows SET total_bytes=total_bytes+1",
                    [],
                ),
                "unique_message" => {
                    db.execute("UPDATE transcript_cache.rows SET item_index=999", [])
                }
                _ => unreachable!(),
            }
            .unwrap();
            db.query_row(
                "SELECT item_index,payload,digest,total_bytes FROM transcript_cache.rows",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Vec<u8>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .unwrap()
        })
        .await;
        let result = log
            .history_text(
                "cache",
                through,
                Position::Start,
                false,
                crate::transcript::HistoryLimits {
                    max_bytes: 8192,
                    max_chunks: Some(1),
                    max_json_bytes: 32768,
                },
            )
            .await;
        assert!(
            matches!(result, Err(crate::StoreError::TranscriptConflict)),
            "{corruption}: {result:?}"
        );
        inspect(&log, move |db| {
            assert_eq!(
                db.query_row("SELECT count(*) FROM transcript_cache.rows", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
                1
            );
            let after = db
                .query_row(
                    "SELECT item_index,payload,digest,total_bytes FROM transcript_cache.rows",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, Vec<u8>>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )
                .unwrap();
            assert_eq!(after, before, "{corruption}");
        })
        .await;
        log.close().await.unwrap();
    }
}
