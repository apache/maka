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
    lifecycle::{ALL_PENDING_SESSION_PAGE, PENDING_ROOT_PAGE, PENDING_SESSION_PAGE},
};
use rusqlite::{Connection, StatementStatus, ToSql, params};

fn pending_schema() -> String {
    format!(
        "{}{}{}",
        crate::schema::fixture(|_, name| name.starts_with("interaction_pending")),
        crate::connection::control::STANDALONE_APP_VIEWS,
        crate::connection::control::ALL_INTERACTION_PENDING
    )
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
fn mixed_root_pending_work_is_independent_of_completed_app_history() {
    use crate::connection::control::{ALL_INTERACTION_PENDING, ATTACHED_APP_VIEWS};
    use rusqlite::OpenFlags;
    use std::fmt::Write;

    let directory = tempfile::tempdir().unwrap();
    let root_path = directory.path().join("control.sqlite");
    let root = Connection::open(&root_path).unwrap();
    canonical_schema(&root);
    root.execute_batch(&crate::schema::fixture(|_, name| {
        name.starts_with("interaction_pending")
            || name.starts_with("computer_app_")
            || name == "session_catalog_revision"
    }))
    .unwrap();
    root.execute("INSERT INTO session_catalog_revision VALUES(1,0)", [])
        .unwrap();
    let db = Connection::open_with_flags(
        ":memory:",
        OpenFlags::default() | OpenFlags::SQLITE_OPEN_URI,
    )
    .unwrap();
    canonical_schema(&db);
    db.execute_batch(&crate::schema::fixture(|_, name| {
        name.starts_with("interaction_pending")
    }))
    .unwrap();
    let mut uri = String::from("file:");
    for byte in root_path.to_str().unwrap().replace('\\', "/").bytes() {
        if byte.is_ascii_alphanumeric() || b"/-_.~:".contains(&byte) {
            uri.push(char::from(byte));
        } else {
            write!(&mut uri, "%{byte:02X}").unwrap();
        }
    }
    uri.push_str("?mode=ro");
    db.execute("ATTACH DATABASE ? AS root_control", [uri])
        .unwrap();
    assert!(db.is_readonly("root_control").unwrap());
    db.execute_batch(ATTACHED_APP_VIEWS).unwrap();
    db.execute_batch(ALL_INTERACTION_PENDING).unwrap();
    let app_request = |id: &str, session: &str, time: i64| {
        root.execute(
            "INSERT INTO interaction_requests VALUES(?1,?2,?3,?4)",
            params![
                id,
                session,
                time,
                serde_json::json!({"requestId":id,"request":{
                    "kind":"computer_app","nativeOperationId":id
                }})
                .to_string()
            ],
        )
        .unwrap();
    };
    request(&db, "local-active", "s", 2);
    request(&db, "local-foreign", "other", 0);
    app_request("root-first", "s", 1);
    app_request("root-tie", "s", 2);
    app_request("root-foreign", "other", 0);
    request(&root, "root-non-app", "s", 0);
    let mut baseline = None;
    for (start, end) in [(0, 1000), (1000, 10000)] {
        root.execute_batch("BEGIN IMMEDIATE").unwrap();
        for n in start..end {
            let id = format!("completed-app-{n}");
            app_request(&id, "s", n + 10);
            outcome(&root, &id);
        }
        root.execute_batch("COMMIT").unwrap();
        assert_eq!(
            pending(&db, "s"),
            ["root-first", "local-active", "root-tie"]
        );
        assert_eq!(pending(&db, "other"), ["local-foreign", "root-foreign"]);
        let current = (
            work(&db, PENDING_INTERACTIONS, &[&"s"]),
            work(&db, ALL_PENDING_SESSION_PAGE, &[&"s", &""]),
        );
        assert_eq!(current.0.0, 3);
        assert_eq!(current.1.0, 3);
        if let Some(expected) = baseline {
            assert_eq!(
                current, expected,
                "query scanned completed root app history"
            );
        } else {
            baseline = Some(current);
        }
        eprintln!(
            "SQLite {} completed_root_apps={end} pending_vm_steps={} terminal_page_vm_steps={}",
            rusqlite::version(),
            current.0.1,
            current.1.1
        );
    }
    for (sql, parameters) in [
        (PENDING_INTERACTIONS, vec![&"s" as &dyn ToSql]),
        (ALL_PENDING_SESSION_PAGE, vec![&"s" as &dyn ToSql, &""]),
    ] {
        let details = plan(&db, sql, &parameters);
        assert!(
            details
                .iter()
                .any(|line| line.contains("MERGE (UNION ALL)")),
            "{details:?}"
        );
        assert!(
            details.iter().all(|line| !line.contains("TEMP B-TREE")),
            "{details:?}"
        );
        assert!(
            details.iter().any(|line| line.contains("SEARCH")
                && line.contains("interaction_requests")
                && line.contains("request_id=?")),
            "{details:?}"
        );
        eprintln!("mixed root plan: {details:?}");
    }
    // Populated ranges exercise the same terminal index-bound comparison;
    // an empty following range can instead finish directly at index EOF.
    let mut foreign_baseline = None;
    for (start, end) in [(0, 1000), (1000, 10000)] {
        root.execute_batch("BEGIN IMMEDIATE").unwrap();
        for n in start..end {
            app_request(&format!("foreign-app-{n}"), "unrelated", n);
        }
        root.execute_batch("COMMIT").unwrap();
        for n in start..end {
            request(&db, &format!("foreign-local-{n}"), "unrelated", n);
        }
        assert_eq!(
            pending(&db, "s"),
            ["root-first", "local-active", "root-tie"]
        );
        let current = (
            work(&db, PENDING_INTERACTIONS, &[&"s"]),
            work(&db, ALL_PENDING_SESSION_PAGE, &[&"s", &""]),
        );
        assert_eq!(current.0.0, 3);
        assert_eq!(current.1.0, 3);
        if let Some(expected) = foreign_baseline {
            assert_eq!(
                current, expected,
                "query scanned unrelated pending sessions"
            );
        } else {
            foreign_baseline = Some(current);
        }
        let details = plan(&db, PENDING_INTERACTIONS, &[&"s"]);
        assert!(
            details
                .iter()
                .any(|line| line.contains("MERGE (UNION ALL)")),
            "{details:?}"
        );
        assert!(
            details.iter().all(|line| !line.contains("TEMP B-TREE")),
            "{details:?}"
        );
        assert!(
            details.iter().any(|line| line.contains("SEARCH")
                && line.contains("interaction_requests")
                && line.contains("request_id=?")),
            "{details:?}"
        );
        eprintln!(
            "SQLite {} unrelated_pending_per_source={end} pending_vm_steps={} terminal_page_vm_steps={}",
            rusqlite::version(),
            current.0.1,
            current.1.1
        );
    }
}

#[test]
fn membership_is_atomic_for_retry_rollback_import_and_delete() {
    let db = Connection::open_in_memory().unwrap();
    canonical_schema(&db);
    db.execute_batch(&pending_schema()).unwrap();
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
