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

use super::{
    PENDING_INTERACTIONS,
    lifecycle::{PENDING_ROOT_PAGE, PENDING_SESSION_PAGE},
};
use rusqlite::{Connection, StatementStatus, ToSql, params};

fn pending_schema() -> String {
    crate::schema::fixture(|_, name| name.starts_with("interaction_pending"))
}
const OLD_PENDING: &str = "SELECT request_id FROM interaction_requests AS request
    WHERE session_id = ? AND NOT EXISTS (SELECT 1 FROM interaction_outcomes AS outcome
    WHERE outcome.request_id = request.request_id) ORDER BY created_at, request_id";

fn canonical_schema(db: &Connection) {
    db.execute_batch("PRAGMA foreign_keys=ON;
        CREATE TABLE interaction_requests (
            request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
            created_at INTEGER NOT NULL, record_json TEXT NOT NULL);
        CREATE INDEX interaction_session_pending ON interaction_requests(session_id,created_at,request_id);
        CREATE TABLE interaction_outcomes (
            request_id TEXT PRIMARY KEY REFERENCES interaction_requests(request_id),
            outcome_json TEXT NOT NULL);").unwrap();
}
fn request(db: &Connection, id: &str, session: &str, time: i64) {
    db.execute(
        "INSERT INTO interaction_requests VALUES(?1,?2,?3,?4)",
        params![id, session, time, format!("{{\"requestId\":\"{id}\"}}")],
    )
    .unwrap();
}
fn outcome(db: &Connection, id: &str) {
    db.execute(
        "INSERT INTO interaction_outcomes VALUES(?1,'{\"kind\":\"closure\"}')",
        [id],
    )
    .unwrap();
}
fn pending(db: &Connection, session: &str) -> Vec<String> {
    db.prepare(PENDING_INTERACTIONS)
        .unwrap()
        .query_map([session], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}
fn work(db: &Connection, sql: &str, parameters: &[&dyn ToSql]) -> (usize, i32) {
    let mut statement = db.prepare(sql).unwrap();
    let rows = statement
        .query_map(parameters, |_| Ok(()))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    (rows.len(), statement.get_status(StatementStatus::VmStep))
}
#[test]
fn pending_work_is_independent_of_completed_history() {
    let db = Connection::open_in_memory().unwrap();
    canonical_schema(&db);
    db.execute_batch(&pending_schema()).unwrap();
    request(&db, "active-b", "s", 2);
    request(&db, "active-a", "s", 2);
    request(&db, "active-first", "s", 1);
    request(&db, "foreign", "other", 0);
    let queries: [(&str, &str, Vec<&dyn ToSql>, usize); 5] = [
        ("pending", PENDING_INTERACTIONS, vec![&"s"], 3),
        ("Session closure", PENDING_SESSION_PAGE, vec![&"s", &""], 3),
        ("root recovery", PENDING_ROOT_PAGE, vec![&""], 4),
        (
            "pending since",
            "SELECT MIN(created_at) FROM interaction_pending WHERE session_id = ?",
            vec![&"s"],
            1,
        ),
        (
            "pending exists",
            "SELECT EXISTS(SELECT 1 FROM interaction_pending WHERE session_id = ?)",
            vec![&"s"],
            1,
        ),
    ];
    let mut short = Vec::new();
    let mut old_short = 0;
    for (start, end) in [(0, 1000), (1000, 10000)] {
        db.execute_batch("BEGIN IMMEDIATE").unwrap();
        for n in start..end {
            let id = format!("old-{n}");
            request(&db, &id, "s", n);
            outcome(&db, &id);
        }
        db.execute_batch("COMMIT").unwrap();
        assert_eq!(pending(&db, "s"), ["active-first", "active-a", "active-b"]);
        let old = work(&db, OLD_PENDING, &[&"s"]);
        assert_eq!(old.0, 3);
        if end == 1000 {
            old_short = old.1;
        } else {
            assert!(old.1 > old_short * 8);
        }
        eprintln!(
            "SQLite {} completed={end} old_pending_vm_steps={}",
            rusqlite::version(),
            old.1
        );
        for (index, (name, sql, parameters, expected_rows)) in queries.iter().enumerate() {
            let (rows, steps) = work(&db, sql, parameters);
            assert_eq!(rows, *expected_rows, "{name}");
            if end == 1000 {
                short.push(steps);
            } else {
                assert_eq!(steps, short[index], "{name} scanned completed history");
            }
            eprintln!("{name}: rows={rows} vm_steps={steps}");
        }
    }
    // Session closure also ignores other Sessions' live work; root recovery
    // intentionally sees it, but stays bounded to each 64-request cursor page.
    let before = work(&db, PENDING_SESSION_PAGE, &[&"s", &""]);
    for n in 0..1000 {
        request(&db, &format!("foreign-{n}"), "other", n);
    }
    assert_eq!(work(&db, PENDING_SESSION_PAGE, &[&"s", &""]), before);
    assert_eq!(work(&db, PENDING_ROOT_PAGE, &[&""]).0, 64);
}
