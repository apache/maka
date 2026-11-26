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

use crate::{StoreError, content};
use rusqlite::{Connection, OptionalExtension, params};

/// Atomically rebuilds `application_operation_contracts`, `application_operations`,
/// and `application_intents` so their large JSON columns (`contract_json`, `request_json`,
/// `reference_json`, `recovery_json`) store tiered/dict zstd-compressed BLOBs alongside
/// an explicit encoding tag, compressing all existing rows in place inside the migration
/// savepoint.
pub(crate) fn migrate_compress_application_tables(c: &Connection) -> Result<(), StoreError> {
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

    // 1. Rebuild application_operation_contracts and application_operations while
    //    preserving the foreign-key relationship and all outcome/cleanup columns.
    c.execute_batch(
        r#"CREATE TABLE application_operation_contracts_v65 (
             digest TEXT PRIMARY KEY NOT NULL,
             contract_json BLOB NOT NULL,
             contract_encoding INTEGER NOT NULL DEFAULT 0 CHECK(contract_encoding IN (0, 1, 2, 3)),
             CHECK(contract_encoding != 0 OR json_valid(CAST(contract_json AS TEXT)))
         );"#,
    )?;
    {
        let mut select =
            c.prepare("SELECT digest, contract_json FROM application_operation_contracts")?;
        let mut insert = c.prepare(
            "INSERT INTO application_operation_contracts_v65(digest, contract_json, contract_encoding)
             VALUES(?1, ?2, ?3)",
        )?;
        let mut rows = select.query([])?;
        while let Some(row) = rows.next()? {
            let digest: String = row.get(0)?;
            let raw: String = row.get(1)?;
            let encoded = content::encode(raw.as_bytes())?;
            insert.execute(params![digest, encoded.payload.as_ref(), encoded.encoding])?;
        }
    }

    c.execute_batch(
        r#"CREATE TEMP TABLE _v65_application_operations AS
         SELECT deployment, namespace, operation, source_revision, request_json,
                outcome_content_id, outcome_json, cleanup_json, contract_digest
         FROM application_operations;
         DROP TABLE application_operations;
         DROP TABLE application_operation_contracts;
         ALTER TABLE application_operation_contracts_v65 RENAME TO application_operation_contracts;
         CREATE TABLE "application_operations" (
             deployment TEXT NOT NULL,
             namespace TEXT NOT NULL,
             operation TEXT NOT NULL,
             source_revision INTEGER NOT NULL,
             request_json BLOB NOT NULL,
             request_encoding INTEGER NOT NULL DEFAULT 0 CHECK(request_encoding IN (0, 1, 2, 3)),
             outcome_content_id INTEGER REFERENCES contents(id),
             outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json)),
             cleanup_json TEXT NOT NULL CHECK(json_valid(cleanup_json)),
             contract_digest TEXT NOT NULL REFERENCES application_operation_contracts(digest),
             PRIMARY KEY(deployment, namespace, operation),
             CHECK(request_encoding != 0 OR json_valid(CAST(request_json AS TEXT)))
         );"#,
    )?;
    {
        let mut select = c.prepare(
            "SELECT deployment, namespace, operation, source_revision, request_json,
                    outcome_content_id, outcome_json, cleanup_json, contract_digest
             FROM _v65_application_operations",
        )?;
        let mut insert = c.prepare(
            "INSERT INTO application_operations(
                 deployment, namespace, operation, source_revision,
                 request_json, request_encoding,
                 outcome_content_id, outcome_json, cleanup_json, contract_digest
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )?;
        let mut rows = select.query([])?;
        while let Some(row) = rows.next()? {
            let deployment: String = row.get(0)?;
            let namespace: String = row.get(1)?;
            let operation: String = row.get(2)?;
            let source_revision: i64 = row.get(3)?;
            let request_raw: String = row.get(4)?;
            let outcome_content_id: Option<i64> = row.get(5)?;
            let outcome_json: String = row.get(6)?;
            let cleanup_json: String = row.get(7)?;
            let contract_digest: String = row.get(8)?;
            let encoded = content::encode(request_raw.as_bytes())?;
            insert.execute(params![
                deployment,
                namespace,
                operation,
                source_revision,
                encoded.payload.as_ref(),
                encoded.encoding,
                outcome_content_id,
                outcome_json,
                cleanup_json,
                contract_digest,
            ])?;
        }
    }
    c.execute_batch(
        "DROP TABLE _v65_application_operations;
         CREATE INDEX operation_content_refs ON application_operations(outcome_content_id)
         WHERE outcome_content_id IS NOT NULL;",
    )?;

    // 2. Rebuild application_intents preserving exact autoincrement cursor sequence.
    let saved_seq: Option<i64> = c
        .query_row(
            "SELECT seq FROM sqlite_sequence WHERE name = 'application_intents'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    c.execute_batch(
        r#"CREATE TABLE "application_intents_v65" (
             cursor INTEGER PRIMARY KEY AUTOINCREMENT,
             deployment TEXT NOT NULL,
             consumer TEXT NOT NULL CHECK(json_valid(consumer)),
             operation TEXT NOT NULL,
             source_revision INTEGER NOT NULL,
             reference_json BLOB NOT NULL,
             reference_encoding INTEGER NOT NULL DEFAULT 0 CHECK(reference_encoding IN (0, 1, 2, 3)),
             recovery_json BLOB NOT NULL DEFAULT X'6e756c6c',
             recovery_encoding INTEGER NOT NULL DEFAULT 0 CHECK(recovery_encoding IN (0, 1, 2, 3)),
             UNIQUE(deployment, consumer, operation),
             CHECK(reference_encoding != 0 OR json_valid(CAST(reference_json AS TEXT))),
             CHECK(recovery_encoding != 0 OR json_valid(CAST(recovery_json AS TEXT)))
         );"#,
    )?;
    {
        let mut select = c.prepare(
            "SELECT cursor, deployment, consumer, operation, source_revision, reference_json, recovery_json
             FROM application_intents ORDER BY cursor",
        )?;
        let mut insert = c.prepare(
            "INSERT INTO application_intents_v65(
                 cursor, deployment, consumer, operation, source_revision,
                 reference_json, reference_encoding, recovery_json, recovery_encoding
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?;
        let mut rows = select.query([])?;
        while let Some(row) = rows.next()? {
            let cursor: i64 = row.get(0)?;
            let deployment: String = row.get(1)?;
            let consumer: String = row.get(2)?;
            let operation: String = row.get(3)?;
            let source_revision: i64 = row.get(4)?;
            let reference_raw: String = row.get(5)?;
            let recovery_raw: String = row.get(6)?;
            let enc_ref = content::encode(reference_raw.as_bytes())?;
            let enc_rec = content::encode(recovery_raw.as_bytes())?;
            insert.execute(params![
                cursor,
                deployment,
                consumer,
                operation,
                source_revision,
                enc_ref.payload.as_ref(),
                enc_ref.encoding,
                enc_rec.payload.as_ref(),
                enc_rec.encoding,
            ])?;
        }
    }
    c.execute_batch(
        "DROP TABLE application_intents;
         ALTER TABLE application_intents_v65 RENAME TO application_intents;
         CREATE INDEX application_intent_history ON application_intents(deployment, consumer, cursor);",
    )?;
    if let Some(seq) = saved_seq {
        let updated = c.execute(
            "UPDATE sqlite_sequence SET seq = max(seq, ?1) WHERE name = 'application_intents'",
            [seq],
        )?;
        if updated == 0 {
            c.execute(
                "INSERT INTO sqlite_sequence(name, seq) VALUES('application_intents', ?1)",
                [seq],
            )?;
        }
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
    use crate::schema::ROOT_MIGRATIONS;

    #[test]
    fn v65_compresses_existing_application_tables_and_preserves_autoincrement_cursor() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        let up_to_62: Vec<_> = ROOT_MIGRATIONS
            .iter()
            .copied()
            .filter(|m| m.version <= 64)
            .collect();
        crate::migration::run(&conn, &up_to_62).unwrap();

        let large_contract = format!(
            r#"{{"protocol":"maka.test@1","name":"workspace.Read","schema":"{}"}}"#,
            "schema_property_description_".repeat(80)
        );
        let large_request = format!(
            r#"{{"operation":"op-1","input":{{"path":"/workspace/file.rs","body":"{}"}}}}"#,
            "repeated_request_segment_".repeat(120)
        );
        let large_ref = format!(
            r#"{{"operation":"op-1","export":"fs","method":"read","pad":"{}"}}"#,
            "reference_metadata_".repeat(40)
        );
        let large_recovery = format!(
            r#"{{"step":"s1","context":"{}"}}"#,
            "recovery_context_payload_".repeat(150)
        );

        conn.execute(
            "INSERT INTO application_operation_contracts(digest, contract_json) VALUES('d1', ?1)",
            [&large_contract],
        )
        .unwrap();
        conn.execute(
            r#"INSERT INTO application_operations(deployment, namespace, operation, source_revision, request_json, outcome_json, cleanup_json, contract_digest)
             VALUES('dep-1', 'ns-1', 'op-1', 1, ?1, '{"kind":"unresolved"}', '{"kind":"unconfirmed"}', 'd1')"#,
            [&large_request],
        )
        .unwrap();
        conn.execute(
            r#"INSERT INTO application_intents(cursor, deployment, consumer, operation, source_revision, reference_json, recovery_json)
             VALUES(42, 'dep-1', '{"kind":"test"}', 'op-1', 1, ?1, ?2)"#,
            params![&large_ref, &large_recovery],
        )
        .unwrap();

        // Run full migrations including v65.
        crate::migration::run(&conn, ROOT_MIGRATIONS).unwrap();

        let (c_bytes, c_enc): (Vec<u8>, i64) = conn
            .query_row(
                "SELECT contract_json, contract_encoding FROM application_operation_contracts WHERE digest='d1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_ne!(c_enc, content::ENCODING_RAW);
        assert!(c_bytes.len() < large_contract.len() / 2);
        assert_eq!(
            content::decode_inline_text(rusqlite::types::ValueRef::Blob(&c_bytes), c_enc).unwrap(),
            large_contract
        );

        let (r_bytes, r_enc): (Vec<u8>, i64) = conn
            .query_row(
                "SELECT request_json, request_encoding FROM application_operations WHERE operation='op-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_ne!(r_enc, content::ENCODING_RAW);
        assert!(r_bytes.len() < large_request.len() / 2);
        assert_eq!(
            content::decode_inline_text(rusqlite::types::ValueRef::Blob(&r_bytes), r_enc).unwrap(),
            large_request
        );

        let (ref_bytes, ref_enc, rec_bytes, rec_enc): (Vec<u8>, i64, Vec<u8>, i64) = conn
            .query_row(
                "SELECT reference_json, reference_encoding, recovery_json, recovery_encoding FROM application_intents WHERE cursor=42",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_ne!(ref_enc, content::ENCODING_RAW);
        assert_ne!(rec_enc, content::ENCODING_RAW);
        assert!(rec_bytes.len() < large_recovery.len() / 2);
        assert_eq!(
            content::decode_inline_text(rusqlite::types::ValueRef::Blob(&ref_bytes), ref_enc)
                .unwrap(),
            large_ref
        );
        assert_eq!(
            content::decode_inline_text(rusqlite::types::ValueRef::Blob(&rec_bytes), rec_enc)
                .unwrap(),
            large_recovery
        );

        // Next autoincrement cursor must advance strictly past 42.
        conn.execute(
            r#"INSERT INTO application_intents(deployment, consumer, operation, source_revision, reference_json)
             VALUES('dep-1', '{"kind":"test"}', 'op-2', 1, '{"ok":true}')"#,
            [],
        )
        .unwrap();
        let next_cursor: i64 = conn
            .query_row(
                "SELECT cursor FROM application_intents WHERE operation='op-2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(next_cursor, 43);
    }
}
