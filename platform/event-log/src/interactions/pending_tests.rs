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

const MIGRATION: &str = include_str!("../../migrations/0050_pending_interactions.sql");
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
fn canonical(db: &Connection) -> (Vec<String>, Vec<String>) {
    let rows = |sql| {
        db.prepare(sql)
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<String>, _>>()
            .unwrap()
    };
    (
        rows(
            "SELECT json_array(request_id,session_id,created_at,record_json) FROM interaction_requests ORDER BY request_id",
        ),
        rows(
            "SELECT json_array(request_id,outcome_json) FROM interaction_outcomes ORDER BY request_id",
        ),
    )
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
fn plan(db: &Connection, sql: &str, parameters: &[&dyn ToSql]) -> Vec<String> {
    db.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .unwrap()
        .query_map(parameters, |row| row.get(3))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn pending_work_is_independent_of_completed_history() {
    let db = Connection::open_in_memory().unwrap();
    canonical_schema(&db);
    db.execute_batch(MIGRATION).unwrap();
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
            let details = plan(&db, sql, parameters);
            assert!(
                details
                    .iter()
                    .any(|line| line.contains("SEARCH interaction_pending")),
                "{name}: {details:?}"
            );
            assert!(
                details
                    .iter()
                    .all(|line| !line.contains("interaction_requests")
                        && !line.contains("interaction_outcomes")
                        && !line.contains("TEMP B-TREE")),
                "{name}: {details:?}"
            );
            eprintln!("{name}: rows={rows} vm_steps={steps} plan={details:?}");
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

#[test]
fn migration_backfills_only_active_rows_and_survives_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("interactions.sqlite");
    let db = Connection::open(&path).unwrap();
    canonical_schema(&db);
    request(&db, "completed", "s", 0);
    outcome(&db, "completed");
    request(&db, "later-b", "s", 2);
    request(&db, "later-a", "s", 2);
    request(&db, "earlier", "s", 1);
    request(&db, "foreign", "other", 0);
    let before = canonical(&db);
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    db.execute_batch(MIGRATION).unwrap();
    db.execute_batch("COMMIT").unwrap();
    assert_eq!(canonical(&db), before);
    assert_eq!(pending(&db, "s"), ["earlier", "later-a", "later-b"]);
    drop(db);
    let db = Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    assert_eq!(canonical(&db), before);
    assert_eq!(pending(&db, "s"), ["earlier", "later-a", "later-b"]);
    outcome(&db, "earlier");
    assert_eq!(pending(&db, "s"), ["later-a", "later-b"]);
    assert_eq!(pending(&db, "other"), ["foreign"]);
}

#[test]
fn membership_is_atomic_for_retry_rollback_import_and_delete() {
    let db = Connection::open_in_memory().unwrap();
    canonical_schema(&db);
    db.execute_batch(MIGRATION).unwrap();
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    request(&db, "rolled-back-request", "s", 0);
    assert_eq!(pending(&db, "s"), ["rolled-back-request"]);
    db.execute_batch("ROLLBACK").unwrap();
    assert!(pending(&db, "s").is_empty());
    request(&db, "active", "s", 1);
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    outcome(&db, "active");
    assert!(pending(&db, "s").is_empty());
    db.execute_batch("ROLLBACK").unwrap();
    assert_eq!(pending(&db, "s"), ["active"]);
    db.execute(
        "INSERT OR IGNORE INTO interaction_requests VALUES('active','wrong',99,'{}')",
        [],
    )
    .unwrap();
    assert_eq!(pending(&db, "s"), ["active"]);
    assert!(pending(&db, "wrong").is_empty());
    outcome(&db, "active");
    db.execute(
        "INSERT OR IGNORE INTO interaction_outcomes VALUES('active','{}')",
        [],
    )
    .unwrap();
    assert!(pending(&db, "s").is_empty());
    db.execute_batch(
        "BEGIN IMMEDIATE; DELETE FROM interaction_outcomes WHERE request_id='active';",
    )
    .unwrap();
    assert_eq!(pending(&db, "s"), ["active"]);
    db.execute_batch("ROLLBACK").unwrap();
    assert!(pending(&db, "s").is_empty());
    db.execute_batch("DELETE FROM interaction_outcomes WHERE request_id='active';")
        .unwrap();
    assert_eq!(pending(&db, "s"), ["active"]);
    db.execute_batch("DELETE FROM interaction_requests WHERE request_id='active';")
        .unwrap();
    assert!(pending(&db, "s").is_empty());
    // Imported rows can arrive outcome-first within a deferred-FK transaction.
    db.execute_batch("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON;")
        .unwrap();
    outcome(&db, "import-closed");
    request(&db, "import-closed", "s", 2);
    request(&db, "import-active", "s", 3);
    db.execute_batch("COMMIT").unwrap();
    assert_eq!(pending(&db, "s"), ["import-active"]);
    // A replacement outcome cannot resurrect the request even with recursive
    // DELETE triggers enabled; cleanup can delete outcome then request safely.
    db.execute_batch(
        "PRAGMA recursive_triggers=ON;
        INSERT OR REPLACE INTO interaction_outcomes VALUES('import-closed','{}');
        DELETE FROM interaction_outcomes WHERE request_id='import-closed';
        DELETE FROM interaction_requests WHERE request_id='import-closed';",
    )
    .unwrap();
    assert_eq!(pending(&db, "s"), ["import-active"]);
    let violations: i64 = db
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(violations, 0);
}
