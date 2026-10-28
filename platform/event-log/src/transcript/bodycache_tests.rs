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

use crate::{
    EventLog,
    test_store::{inspect as inspect_main, inspect_cache as inspect},
};
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
        assert!(db.query_row("SELECT count(*) FROM temp.transcript_rows", [], |row| row.get::<_, i64>(0)).unwrap()>0);
        assert_eq!(db.query_row("SELECT count(*) FROM main.sqlite_schema WHERE name IN ('transcript_rows','transcript_text')", [], |row| row.get::<_, i64>(0)).unwrap(),0);
        assert_eq!(db.query_row("PRAGMA main.journal_mode", [], |row| row.get::<_, String>(0)).unwrap(), "wal");
        for (query, expected) in [("PRAGMA main.synchronous",2), ("PRAGMA temp.page_size",4096), ("PRAGMA temp.auto_vacuum",1), ("PRAGMA temp.cache_size",-4096), ("PRAGMA temp.synchronous",0), ("PRAGMA temp_store",1)] {
            assert_eq!(db.query_row(query, [], |row| row.get::<_, i64>(0)).unwrap(), expected, "{query}");
        }
        assert_eq!(db.query_row("SELECT count(*) FROM pragma_compile_options WHERE compile_options='TEMP_STORE=3'", [], |row| row.get::<_, i64>(0)).unwrap(),0,"temporary storage must be spillable");
    }).await;
    log.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    inspect(&reopened, |db| {
        assert_eq!(
            db.query_row("SELECT count(*) FROM temp.transcript_rows", [], |row| row
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
                c"temp".as_ptr(),
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
                "SELECT count(*) FROM temp.transcript_rows WHERE session_id='cache' AND source_sequence=?",
                [through as i64],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            SIBLINGS as i64 + 1,
            "the opening must project each attributed message and its running state"
        );
        assert!(
            db.query_row("PRAGMA temp.page_count", [], |row| row
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
        .observe(move |db| {
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
        .observe(|db| {
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
            .query_row("PRAGMA temp.page_count", [], |row| row.get::<_, i64>(0))
            .unwrap();
        assert!(pages <= super::RETAINED_PAGES);
        assert_eq!(
            db.query_row("PRAGMA temp.freelist_count", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM temp.transcript_rows WHERE source_sequence=?",
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
        if corruption == "identity" {
            inspect_main(&log, |db| {
                db.execute(
                    "UPDATE transcript_directory SET turn_id='wrong' WHERE item_index=34",
                    [],
                )
                .unwrap();
            })
            .await;
        }
        let before = inspect(&log, move |db| {
            db.execute(
                "DELETE FROM temp.transcript_rows WHERE item_index != 34",
                [],
            )
            .unwrap();
            assert_eq!(
                db.query_row("SELECT count(*) FROM temp.transcript_rows", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
                1
            );
            match corruption {
                "identity" => Ok(0),
                "payload" => db.execute("UPDATE temp.transcript_rows SET payload=x'00'", []),
                "digest" => db.execute("UPDATE temp.transcript_rows SET digest='wrong'", []),
                "bytes" => db.execute(
                    "UPDATE temp.transcript_rows SET total_bytes=total_bytes+1",
                    [],
                ),
                "unique_message" => {
                    db.execute("UPDATE temp.transcript_rows SET item_index=999", [])
                }
                _ => unreachable!(),
            }
            .unwrap();
            db.query_row(
                "SELECT item_index,payload,digest,total_bytes FROM temp.transcript_rows",
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
                db.query_row("SELECT count(*) FROM temp.transcript_rows", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
                1
            );
            let after = db
                .query_row(
                    "SELECT item_index,payload,digest,total_bytes FROM temp.transcript_rows",
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

#[tokio::test]
async fn observation_reads_leave_canonical_subscribers_idle_and_complete_while_writer_is_held() {
    use futures_util::FutureExt;
    use sha2::{Digest, Sha256};
    use std::panic::AssertUnwindSafe;
    use std::time::Duration;
    use tokio::sync::oneshot;

    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("observations.sqlite"))
        .await
        .unwrap();
    log.create_session("cache", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let first = user(&log, "first", "first 中🙂".into()).await;
    let second = user(&log, "second", "second text".into()).await;
    // Flush the final append's subscriber notification before establishing the baseline.
    log.connection
        .run(|_| Box::pin(async { Ok(()) }))
        .await
        .unwrap();
    let mut changes = log.connection.subscribe_changes();
    let writer = log.connection.writer();
    let (entered, ready) = oneshot::channel();
    let (release, gate) = oneshot::channel();
    let held = tokio::spawn(async move {
        writer
            .run(move |_| {
                Box::pin(async move {
                    entered.send(()).unwrap();
                    let _ = gate.await;
                    Ok(())
                })
            })
            .await
    });
    ready.await.unwrap();
    // Cloning the owner's receiver preserves its unseen setup notifications.
    // The held writer has finished every setup job, so consume that baseline.
    changes.borrow_and_update();
    let reads = AssertUnwindSafe(async {
        assert!(!changes.has_changed().unwrap());
        tokio::time::timeout(Duration::from_secs(5), async {
            for sequence in [first, second, first, second] {
                let expected = if sequence == first {
                    "first 中🙂"
                } else {
                    "second text"
                };
                let page = read(
                    &log,
                    sequence,
                    Position::Row {
                        position: RowPosition {
                            source_sequence: sequence,
                            item_index: 0,
                        },
                        field: HistoryField::Body,
                    },
                )
                .await;
                let Page::Ready { chunks, .. } = page;
                assert_eq!(chunks[0].text, expected);
                let position = RowPosition {
                    source_sequence: sequence,
                    item_index: 0,
                };
                let header = log
                    .transcript_headers(
                        "cache",
                        &crate::transcript::TranscriptRead {
                            through: sequence,
                            position: Some(position),
                            direction: crate::transcript::TranscriptDirection::Newer,
                            limit: 1,
                        },
                    )
                    .await
                    .unwrap()
                    .remove(0);
                let bytes = log
                    .transcript_fragment("cache", position, 0, header.total_bytes)
                    .await
                    .unwrap();
                assert_eq!(
                    header.digest,
                    format!("sha256:{}", hex::encode(Sha256::digest(&bytes)))
                );
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["text"],
                    expected
                );
                let source = log
                    .history_source(
                        "cache",
                        sequence,
                        crate::transcript::SourceSelection {
                            locator: position,
                            field: maka_agent_ports::session::history::SourceField::Body,
                            path: None,
                        },
                        maka_agent_ports::session::history::SourcePosition::Start,
                        8192,
                    )
                    .await
                    .unwrap();
                assert_eq!(source.text, expected);
            }
        })
        .await
        .expect("history, source and fragments must not wait for the canonical writer");
        assert!(
            !changes.has_changed().unwrap(),
            "private cache writes must not wake canonical subscribers"
        );
    })
    .catch_unwind()
    .await;
    let _ = release.send(());
    held.await.unwrap().unwrap();
    if let Err(panic) = reads {
        std::panic::resume_unwind(panic);
    }
    async fn reject_main_write(db: &mut sqlx::SqliteConnection) -> Result<(), crate::StoreError> {
        let error = sqlx::query(
            "INSERT INTO session_read_state(session_id,has_unread) VALUES('forbidden',0)",
        )
        .execute(db)
        .await
        .unwrap_err();
        assert!(
            matches!(error, sqlx::Error::Database(error) if error.code().as_deref() == Some("8"))
        );
        Ok(())
    }
    log.connection
        .read(|db| Box::pin(reject_main_write(db)))
        .await
        .unwrap();
    log.connection
        .observe(|db| Box::pin(reject_main_write(db)))
        .await
        .unwrap();
    log.close().await.unwrap();
}

#[tokio::test]
async fn queued_observations_do_not_consume_pure_read_admission() {
    use std::time::Duration;
    use tokio::sync::oneshot;
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("admission.sqlite"))
        .await
        .unwrap();
    let observer = log.connection.scoped(std::sync::Arc::new(()));
    let (entered, ready) = oneshot::channel();
    let (release, gate) = oneshot::channel();
    let held = tokio::spawn(async move {
        observer
            .observe(move |_| {
                Box::pin(async move {
                    entered.send(()).unwrap();
                    gate.await.unwrap();
                    Ok(())
                })
            })
            .await
    });
    ready.await.unwrap();
    let mut queued = Box::pin(log.connection.observe(|_| Box::pin(async { Ok(()) })));
    assert!(futures_util::poll!(&mut queued).is_pending());
    let value = tokio::time::timeout(
        Duration::from_secs(5),
        log.connection.read(|db| {
            Box::pin(async move {
                Ok(sqlx::query_scalar::<_, i64>("SELECT 42")
                    .fetch_one(db)
                    .await?)
            })
        }),
    )
    .await
    .expect("pure reader must retain its independent admission")
    .unwrap();
    assert_eq!(value, 42);
    release.send(()).unwrap();
    held.await.unwrap().unwrap();
    queued.await.unwrap();
    log.close().await.unwrap();
}

#[tokio::test]
async fn inherited_directory_replaces_a_warmed_bare_claimant_on_the_observation_snapshot() {
    use maka_agent_facts::{
        input::DeliveredMessage,
        message::{MessageDisposition, Placement, RootSourceMessage},
        session::CopyPurpose,
    };
    async fn append(log: &EventLog, session: &str, turn: &str, text: &str) -> u64 {
        let content: maka_agent_facts::input::MessageInput = text.to_owned().into();
        let invocation = Invocation {
            session_id: session.into(),
            turn_id: turn.into(),
            run_id: format!("run-{turn}"),
            invocation_id: format!("inv-{turn}"),
        };
        let source = RootSourceMessage {
            message: DeliveredMessage {
                origin: None,
                message_id: "shared-message".into(),
                submitted_content_digest: content.content_digest().unwrap(),
                content: content.clone(),
            },
            unprepared_content: content.clone(),
            submitted_placement: Placement::CurrentTurn,
            disposition: MessageDisposition::TurnStarted,
            submitted_intent: None,
        };
        let sequence = log
            .append(
                &EventWrite::plain(RuntimeEvent::new(
                    invocation.clone(),
                    Fact::InvocationOpened {
                        configuration: None,
                        input: InvocationInput::Message {
                            content,
                            source_messages: vec![source],
                            request_fingerprint: None,
                        },
                    },
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        log.append(
            &EventWrite::plain(RuntimeEvent::new(
                invocation,
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::Completed,
                },
            ))
            .unwrap(),
        )
        .await
        .unwrap();
        sequence
    }
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("inherited.sqlite"))
        .await
        .unwrap();
    log.create_session("parent", "parent", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let inherited = append(&log, "parent", "parent-turn", "inherited bytes").await;
    let bare = append(&log, "cache", "bare-turn", "bare bytes").await;
    let bare_position = RowPosition {
        source_sequence: bare,
        item_index: 0,
    };
    let header = log
        .transcript_headers(
            "cache",
            &crate::transcript::TranscriptRead {
                through: bare,
                position: Some(bare_position),
                direction: crate::transcript::TranscriptDirection::Newer,
                limit: 1,
            },
        )
        .await
        .unwrap()
        .remove(0);
    let bytes = log
        .transcript_fragment("cache", bare_position, 0, header.total_bytes)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["text"],
        "bare bytes"
    );
    let revision = log
        .get_session::<serde_json::Value>("parent")
        .await
        .unwrap()
        .unwrap()
        .revision;
    let copied = log
        .copy_session(
            crate::sessions::SessionCopy {
                source_session_id: "parent".into(),
                target_session_id: "cache".into(),
                expected_source_revision: revision,
                purpose: CopyPurpose::Branch {
                    position: maka_agent_facts::session::ForkPosition::End,
                    side_conversation: false,
                },
            },
            &serde_json::json!({}),
            2,
        )
        .await
        .unwrap();
    assert!(matches!(
        copied,
        crate::sessions::SessionCopyResult::Committed(_)
    ));
    let Page::Ready { chunks, .. } = read(&log, inherited, Position::Start).await;
    assert_eq!(chunks[0].text, "inherited bytes");
    inspect(&log, move |db| {
        assert_eq!(db.query_row("SELECT count(*) FROM temp.transcript_rows WHERE session_id='cache' AND source_sequence=?", [bare as i64], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }).await;
    log.close().await.unwrap();
}

#[tokio::test]
async fn accepted_cleanup_survives_waiter_cancellation_and_shutdown_drains_its_observation() {
    use std::{
        sync::{
            Arc,
            atomic::{AtomicI64, Ordering},
        },
        time::Duration,
    };
    use tokio::sync::oneshot;
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("cleanup.sqlite"))
        .await
        .unwrap();
    log.create_session("cache", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let through = user(&log, "first", "cached bytes".into()).await;
    read(&log, through, Position::Start).await;
    let deleted = Arc::new(AtomicI64::new(0));
    let observed = deleted.clone();
    let cached = inspect(&log, move |db| {
        db.create_scalar_function("cache_deleted", 0, rusqlite::functions::FunctionFlags::SQLITE_UTF8, move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
            Ok(0)
        }).unwrap();
        db.execute_batch("CREATE TEMP TRIGGER observe_cache_delete AFTER DELETE ON transcript_rows BEGIN SELECT cache_deleted(); END").unwrap();
        db.query_row("SELECT count(*) FROM temp.transcript_rows", [], |row| row.get::<_, i64>(0)).unwrap()
    }).await;
    assert!(cached > 0);
    let observer = log.connection.scoped(Arc::new(()));
    let (entered, ready) = oneshot::channel();
    let (release, gate) = oneshot::channel();
    let held = tokio::spawn(async move {
        observer
            .observe(move |_| {
                Box::pin(async move {
                    entered.send(()).unwrap();
                    gate.await.unwrap();
                    Ok(())
                })
            })
            .await
    });
    ready.await.unwrap();
    let writer = log.connection.writer();
    let cleanup = log.connection.observations();
    let (committed, accepted) = oneshot::channel();
    let caller = tokio::spawn(async move {
        writer
            .run(move |db| {
                Box::pin(async move {
                    use sqlx::Connection;
                    let mut tx = db.begin().await?;
                    sqlx::query("DELETE FROM transcript_directory WHERE session_id='cache'")
                        .execute(&mut *tx)
                        .await?;
                    tx.commit().await?;
                    committed.send(()).unwrap();
                    cleanup.purge_session("cache".into()).await
                })
            })
            .await
    });
    accepted.await.unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    log.connection.request_shutdown();
    let mut closing = Box::pin(log.connection.shutdown());
    assert!(futures_util::poll!(&mut closing).is_pending());
    release.send(()).unwrap();
    held.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5), closing)
        .await
        .expect("accepted writer cleanup must finish before reader shutdown")
        .unwrap();
    assert_eq!(
        deleted.load(Ordering::SeqCst),
        cached,
        "shutdown must drain actual cache deletion after the original observer vanished"
    );
    log.close().await.unwrap();
}
