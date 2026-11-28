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

use maka_event_log::{StoreError, content};
use rusqlite::{Connection, params};

/// Atomically:
/// 1. Rebuilds `agent_cells` with zstd-compressed `body` + `body_encoding` and promotes
///    `(owner_attempt, owner_call)` columns for `agent_cell_parent` so parent lookups and
///    uniqueness enforcement do not decompress cell JSON.
/// 2. Rebuilds `agent_usage_calls` replacing repeated `binding_json` and `quote_json`
///    text columns with integer foreign keys into `agent_usage_json_blobs`.
pub(crate) fn migrate_compress_cells_and_usage(c: &Connection) -> Result<(), StoreError> {
    let saved_views: Vec<(String, String)> = c
        .prepare("SELECT name, sql FROM sqlite_master WHERE type='view' AND sql IS NOT NULL ORDER BY rowid")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let saved_triggers: Vec<(String, String)> = c
        .prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL ORDER BY rowid")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;

    for (name, _) in &saved_triggers {
        c.execute(&format!(r#"DROP TRIGGER "{name}""#), [])?;
    }
    for (name, _) in &saved_views {
        c.execute(&format!(r#"DROP VIEW "{name}""#), [])?;
    }

    // 1. Rebuild agent_cells with compressed body + promoted owner columns.
    c.execute_batch(
        "CREATE TABLE agent_cells_v66 (
             cell TEXT PRIMARY KEY,
             session TEXT NOT NULL,
             run TEXT,
             pending INTEGER NOT NULL,
             owner_attempt TEXT,
             owner_call TEXT,
             body BLOB NOT NULL,
             body_encoding INTEGER NOT NULL DEFAULT 0 CHECK(body_encoding IN (0, 1, 2, 3)),
             CHECK(body_encoding != 0 OR json_valid(CAST(body AS TEXT)))
         );",
    )?;
    {
        let mut select = c.prepare(
            "SELECT cell, session, run, pending,
                    json_extract(body, '$.owner.link.attempt'),
                    json_extract(body, '$.owner.call'),
                    body
             FROM agent_cells",
        )?;
        let mut insert = c.prepare(
            "INSERT INTO agent_cells_v66(
                 cell, session, run, pending, owner_attempt, owner_call, body, body_encoding
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        let mut rows = select.query([])?;
        while let Some(row) = rows.next()? {
            let cell: String = row.get(0)?;
            let session: String = row.get(1)?;
            let run: Option<String> = row.get(2)?;
            let pending: i64 = row.get(3)?;
            let owner_attempt: Option<String> = row.get(4)?;
            let owner_call: Option<String> = row.get(5)?;
            let raw: String = row.get(6)?;
            let encoded = content::encode(raw.as_bytes())?;
            insert.execute(params![
                cell,
                session,
                run,
                pending,
                owner_attempt,
                owner_call,
                encoded.payload.as_ref(),
                encoded.encoding,
            ])?;
        }
    }
    c.execute_batch(
        "DROP TABLE agent_cells;
         ALTER TABLE agent_cells_v66 RENAME TO agent_cells;
         CREATE INDEX agent_cells_pending ON agent_cells(run, pending, cell);
         CREATE INDEX agent_cells_session ON agent_cells(session, cell);
         CREATE UNIQUE INDEX agent_cell_parent ON agent_cells(run, owner_attempt, owner_call) WHERE run IS NOT NULL;",
    )?;

    // 2. Intern binding_json and quote_json on agent_usage_calls into agent_usage_json_blobs.
    c.execute_batch(
        "INSERT OR IGNORE INTO agent_usage_json_blobs(body)
         SELECT DISTINCT binding_json FROM agent_usage_calls WHERE binding_json IS NOT NULL
         UNION
         SELECT DISTINCT quote_json FROM agent_usage_calls WHERE quote_json IS NOT NULL;",
    )?;
    let results_create: String = c.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_usage_results'",
        [],
        |r| r.get(0),
    )?;
    let results_indexes: Vec<String> = c
        .prepare(
            "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='agent_usage_results' AND sql IS NOT NULL ORDER BY rowid",
        )?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;

    c.execute_batch(
        "CREATE TEMP TABLE _v66_agent_usage_results AS SELECT * FROM agent_usage_results;
         DROP TABLE agent_usage_results;
         CREATE TABLE agent_usage_calls_v66 (
             request TEXT PRIMARY KEY,
             source TEXT NOT NULL CHECK(source IN ('fact', 'auxiliary', 'cell')),
             kind TEXT NOT NULL CHECK(kind IN ('model', 'tool')),
             namespace_id INTEGER REFERENCES agent_namespaces(id),
             standalone_session TEXT,
             run TEXT,
             admission_sequence INTEGER NOT NULL CHECK(admission_sequence > 0),
             started_at INTEGER NOT NULL CHECK(started_at >= 0),
             model_id TEXT,
             provider_id TEXT,
             name TEXT,
             purpose TEXT,
             binding_id INTEGER REFERENCES agent_usage_json_blobs(id),
             quote_id INTEGER REFERENCES agent_usage_json_blobs(id),
             origin_json TEXT NOT NULL CHECK(json_valid(origin_json)),
             CHECK((namespace_id IS NOT NULL) != (standalone_session IS NOT NULL))
         );
         INSERT INTO agent_usage_calls_v66(
             request, source, kind, namespace_id, standalone_session, run,
             admission_sequence, started_at, model_id, provider_id, name, purpose,
             binding_id, quote_id, origin_json
         )
         SELECT u.request, u.source, u.kind, u.namespace_id, u.standalone_session, u.run,
                u.admission_sequence, u.started_at, u.model_id, u.provider_id, u.name, u.purpose,
                b.id, q.id, u.origin_json
         FROM agent_usage_calls u
         LEFT JOIN agent_usage_json_blobs b ON b.body = u.binding_json
         LEFT JOIN agent_usage_json_blobs q ON q.body = u.quote_json;
         DROP TABLE agent_usage_calls;
         ALTER TABLE agent_usage_calls_v66 RENAME TO agent_usage_calls;
         CREATE INDEX agent_usage_call_scope ON agent_usage_calls(namespace_id, admission_sequence, request) WHERE namespace_id IS NOT NULL;
         CREATE INDEX agent_usage_call_time ON agent_usage_calls(started_at, request);
         CREATE INDEX agent_usage_call_owner_time ON agent_usage_calls(namespace_id, started_at, request) WHERE namespace_id IS NOT NULL;
         CREATE INDEX agent_usage_call_standalone_time ON agent_usage_calls(standalone_session, started_at, request) WHERE standalone_session IS NOT NULL;",
    )?;
    c.execute_batch(&results_create)?;
    c.execute_batch(
        "INSERT INTO agent_usage_results SELECT * FROM _v66_agent_usage_results;
         DROP TABLE _v66_agent_usage_results;",
    )?;
    for sql in &results_indexes {
        c.execute_batch(sql)?;
    }

    for (_, sql) in &saved_views {
        c.execute_batch(sql)?;
    }
    for (_, sql) in &saved_triggers {
        c.execute_batch(sql)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v66_compresses_cells_promotes_parent_index_and_interns_usage_json() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        let catalog: Vec<_> = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(crate::MIGRATIONS)
            .copied()
            .collect();
        let up_to_63: Vec<_> = catalog
            .iter()
            .copied()
            .filter(|m| m.version <= 65)
            .collect();
        maka_event_log::migration::run(&conn, &up_to_63).unwrap();

        let cell_body = format!(
            r#"{{"id":"c1","owner":{{"kind":"agent","link":{{"run":"r1","step":"s1","attempt":"a1"}},"call":"call-1"}},"status":{{"kind":"completed"}},"children":{{"op1":{{"name":"Read","detail":"{}"}}}}}}"#,
            "repeated_cell_child_metadata_".repeat(100)
        );
        conn.execute(
            "INSERT INTO agent_cells(cell, session, run, pending, body) VALUES('c1', 'sess-1', 'r1', 0, ?1)",
            [&cell_body],
        )
        .unwrap();

        let ns_id = crate::namespace::ensure_id(&conn, r#"{"kind":"local"}"#, "sess-1").unwrap();
        let binding = r#"{"connection_slug":"openai","model":"gpt-5.4"}"#;
        let quote = r#"{"provider_id":"openai","pricing":{"input":1.0}}"#;
        for i in 1..=5 {
            conn.execute(
                r#"INSERT INTO agent_usage_calls(request, source, kind, namespace_id, standalone_session, run, admission_sequence, started_at, model_id, provider_id, purpose, binding_json, quote_json, origin_json)
                 VALUES(?1, 'fact', 'model', ?2, NULL, 'r1', ?3, ?4, 'gpt-5.4', 'openai', '"turn"', ?5, ?6, '{"kind":"run"}')"#,
                params![format!("model:r1:{i}"), ns_id, i, i * 100, binding, quote],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO agent_usage_results(request, sequence, completed_at, outcome, input, output) VALUES(?1, ?2, ?3, 'success', 100, 20)",
                params![format!("model:r1:{i}"), i, i * 100 + 10],
            )
            .unwrap();
        }

        maka_event_log::migration::run(&conn, &catalog).unwrap();

        let (stored_body, enc, owner_attempt, owner_call): (Vec<u8>, i64, Option<String>, Option<String>) =
            conn.query_row(
                "SELECT body, body_encoding, owner_attempt, owner_call FROM agent_cells WHERE cell='c1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_ne!(enc, content::ENCODING_RAW);
        assert!(stored_body.len() < cell_body.len() / 2);
        assert_eq!(owner_attempt.as_deref(), Some("a1"));
        assert_eq!(owner_call.as_deref(), Some("call-1"));
        let decoded: String = conn
            .query_row(
                "SELECT maka_content_text(body, body_encoding) FROM agent_cells WHERE cell='c1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(decoded, cell_body);

        // Duplicate (run, owner_attempt, owner_call) must still be rejected by agent_cell_parent.
        let dup = conn.execute(
            "INSERT INTO agent_cells(cell, session, run, pending, owner_attempt, owner_call, body, body_encoding) VALUES('c2', 'sess-1', 'r1', 0, 'a1', 'call-1', X'7b7d', 0)",
            [],
        );
        assert!(dup.is_err(), "agent_cell_parent uniqueness must hold");

        // All 5 usage calls share exactly 2 interned JSON blobs (1 binding + 1 quote).
        let blob_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM agent_usage_json_blobs", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(blob_count, 2);
        let res_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM agent_usage_results", [], |r| r.get(0))
            .unwrap();
        assert_eq!(res_count, 5);
    }
}
