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
use rusqlite::params;

async fn page(db: &mut SqliteConnection, after: i64, limit: usize) -> (Vec<(String, i64)>, i32) {
    inspect(db, move |db| {
        let mut query = db.prepare(UNFINISHED_INVOCATIONS)?;
        let rows = query
            .query_map(params![after, i64::try_from(limit).unwrap()], |r| {
                Ok((r.get(3)?, r.get(4)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok((rows, query.get_status(StatementStatus::VmStep)))
    })
    .await
}

#[tokio::test]
async fn more_than_ten_thousand_openings_page_without_rescanning_or_skipping_deleted_pages() {
    let mut db = database().await;
    let mut transaction = db.begin().await.unwrap();
    let mut initial_work = 0;
    for n in 0..10_017 {
        let invocation = format!("run-{n}");
        crate::connection::worker_query(&mut transaction, move |worker| {
            Box::pin(async move { append_worker(worker, &invocation, opening()).await })
        })
        .await
        .unwrap();
        if n == 1023 {
            initial_work = page(&mut transaction, 0, 64).await.1;
        }
    }
    transaction.commit().await.unwrap();
    assert!(
        page(&mut db, 0, 64).await.1 <= initial_work + 32,
        "page reads must not materialize every unfinished opening"
    );
    let mut cursor = 0;
    let mut seen = 0;
    loop {
        let (rows, _) = page(&mut db, cursor, 64).await;
        if rows.is_empty() {
            break;
        }
        assert!(rows.len() <= 64);
        for (invocation, sequence) in rows {
            assert!(sequence > cursor);
            assert_eq!(invocation, format!("run-{seen}"));
            append(&mut db, &invocation, ended("host_interrupted")).await;
            cursor = sequence;
            seen += 1;
        }
    }
    assert_eq!(seen, 10_017);
    assert!(page(&mut db, 0, 64).await.0.is_empty());
}

#[tokio::test]
async fn imported_openings_do_not_hide_later_local_pages() {
    let mut db = database().await;
    for n in 0..130 {
        let id = format!("import-{n}");
        append(&mut db, &id, opening()).await;
        sqlx::query("INSERT INTO imported_invocations VALUES(?)")
            .bind(&id)
            .execute(&mut db)
            .await
            .unwrap();
    }
    append(&mut db, "local", opening()).await;
    assert_eq!(page(&mut db, 0, 1).await.0, vec![("local".into(), 131)]);
}

#[tokio::test]
async fn startup_settles_multiple_pages_in_opening_order() {
    use maka_agent_facts::{
        event::{EventWrite, Fact, RuntimeEvent},
        input,
    };
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    for n in 0..257 {
        let invocation = Invocation {
            session_id: format!("s-{n}"),
            turn_id: format!("t-{n}"),
            run_id: format!("r-{n}"),
            invocation_id: format!("i-{n}"),
        };
        let opening = RuntimeEvent::new(
            invocation,
            Fact::InvocationOpened {
                configuration: None,
                input: input::InvocationInput::Message {
                    source_messages: vec![],
                    content: "recover".into(),
                    request_fingerprint: None,
                },
            },
        );
        log.append(&EventWrite::plain(opening).unwrap())
            .await
            .unwrap();
    }
    let first = log.unfinished_invocations(0, 256).await.unwrap();
    assert_eq!(first.invocations.len(), 256);
    assert_eq!(recover_invocations(&log).await.unwrap(), 257);
    let ended = log.connection.read(|connection| Box::pin(async move {
        Ok(sqlx::query_scalar::<_, String>("SELECT invocation_id FROM runtime_events WHERE kind='invocation_ended' ORDER BY sequence")
            .fetch_all(connection).await?)
    })).await.unwrap();
    assert_eq!(
        ended,
        (0..257).map(|n| format!("i-{n}")).collect::<Vec<_>>()
    );
    assert!(
        log.unfinished_invocations(first.through_sequence, 256)
            .await
            .unwrap()
            .invocations
            .is_empty()
    );
    assert_eq!(recover_invocations(&log).await.unwrap(), 0);
    log.close().await.unwrap();
}
