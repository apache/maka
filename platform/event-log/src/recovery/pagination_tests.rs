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

fn page(db: &Connection, after: i64, limit: usize) -> (Vec<(String, i64)>, i32) {
    let mut query = db.prepare(UNFINISHED_INVOCATIONS).unwrap();
    let rows = query
        .query_map(params![after, i64::try_from(limit).unwrap()], |r| {
            Ok((r.get(3)?, r.get(4)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    (rows, query.get_status(StatementStatus::VmStep))
}

#[test]
fn more_than_ten_thousand_openings_page_without_rescanning_or_skipping_deleted_pages() {
    let mut db = database();
    let transaction = db.transaction().unwrap();
    let mut initial_work = 0;
    for n in 0..10_017 {
        append(
            &transaction,
            &format!("run-{n}"),
            "invocation_opened",
            None,
            json!({}),
        );
        if n == 1023 {
            initial_work = page(&transaction, 0, 64).1;
        }
    }
    transaction.commit().unwrap();
    assert!(
        page(&db, 0, 64).1 <= initial_work + 32,
        "page reads must not materialize every unfinished opening"
    );
    let mut cursor = 0;
    let mut seen = 0;
    loop {
        let (rows, _) = page(&db, cursor, 64);
        if rows.is_empty() {
            break;
        }
        assert!(rows.len() <= 64);
        for (invocation, sequence) in rows {
            assert!(sequence > cursor);
            assert_eq!(invocation, format!("run-{seen}"));
            append(
                &db,
                &invocation,
                "invocation_ended",
                None,
                json!({"outcome":{"class":"host_interrupted"}}),
            );
            cursor = sequence;
            seen += 1;
        }
    }
    assert_eq!(seen, 10_017);
    assert!(page(&db, 0, 64).0.is_empty());
}

#[test]
fn imported_openings_do_not_hide_later_local_pages() {
    let db = database();
    for n in 0..130 {
        let id = format!("import-{n}");
        append(&db, &id, "invocation_opened", None, json!({}));
        db.execute("INSERT INTO imported_invocations VALUES(?)", [&id])
            .unwrap();
    }
    append(&db, "local", "invocation_opened", None, json!({}));
    assert_eq!(page(&db, 0, 1).0, vec![("local".into(), 131)]);
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
