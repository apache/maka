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

//! Isolated query fixtures select their objects from the current production schema.
use rusqlite::Connection;

pub(crate) fn schema(include: impl Fn(&str, &str) -> bool) -> String {
    let db = Connection::open_in_memory().unwrap();
    for migration in super::MIGRATIONS.iter() {
        db.execute_batch(migration.sql.as_ref()).unwrap();
    }
    let mut query = db.prepare(
        "SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND tbl_name NOT IN (SELECT name FROM pragma_table_list WHERE schema='main' AND type='shadow') ORDER BY rowid",
    ).unwrap();
    let rows = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .unwrap();
    let mut schema = String::new();
    for row in rows {
        let (kind, name, sql) = row.unwrap();
        if include(&kind, &name) {
            schema.push_str(&sql);
            schema.push_str(";\n");
        }
    }
    schema
}

#[tokio::test]
async fn existing_artifact_rows_migrate_without_losing_bytes_or_history_aliases() {
    use maka_agent_facts::artifact::{Artifact, ArtifactKind, ArtifactSource, content_digest};
    use sqlx::{Connection, sqlite::SqliteConnectOptions};
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("old.sqlite");
    let mut db = sqlx::SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true),
    )
    .await
    .unwrap();
    sqlx::query("PRAGMA application_id = 1296124754")
        .execute(&mut db)
        .await
        .unwrap();
    crate::sqlite_functions::register(&mut db).await.unwrap();
    let previous = sqlx::migrate::Migrator {
        migrations: super::MIGRATIONS
            .iter()
            .filter(|m| m.version < 10)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..sqlx::migrate::Migrator::DEFAULT
    };
    previous.run_direct(None, &mut db, false).await.unwrap();
    let bytes = b"shared migrated attachment";
    for session in ["source", "copy"] {
        sqlx::query("INSERT INTO session_control(id,fingerprint,revision,created_at,updated_at,archived,configuration) VALUES(?,?,1,1,1,0,'{}')").bind(session).bind(session).execute(&mut db).await.unwrap();
        let record = Artifact {
            id: "file".into(),
            session_id: session.into(),
            turn_id: "turn".into(),
            created_at: 1,
            name: "file.bin".into(),
            kind: ArtifactKind::File,
            size_bytes: bytes.len() as u64,
            mime_type: Some("application/octet-stream".into()),
            source: ArtifactSource::UserUpload,
            summary: Some(content_digest(bytes)),
        };
        sqlx::query("INSERT INTO artifacts(lookup_digest,session_id,id,created_at,record_json,content_sha256,payload) VALUES(?,?,'file',1,?,?,?)")
            .bind(crate::artifacts::identity::artifact_lookup_digest(session,"file").as_slice()).bind(session).bind(serde_json::to_string(&record).unwrap()).bind(content_digest(bytes)).bind(bytes.as_slice()).execute(&mut db).await.unwrap();
    }
    sqlx::query("INSERT INTO session_history_copies(session_id,source_session_id,source_revision,through_sequence,observed_through,request_json,lineage_json,state) VALUES('copy','source',1,0,0,'{}','{}','committed')").execute(&mut db).await.unwrap();
    sqlx::query("INSERT INTO session_history_artifacts(lookup_digest,target_digest,session_id,source_session_id,source_artifact_id,artifact_id) VALUES(?,?,'copy','source','file','file')")
        .bind(crate::artifacts::identity::history_lookup_digest("copy","source","file").as_slice()).bind(crate::artifacts::identity::artifact_lookup_digest("copy","file").as_slice()).execute(&mut db).await.unwrap();
    // A conflicting old digest must not silently pick one of two different bodies.
    sqlx::query("UPDATE artifacts SET payload=zeroblob(length(payload)) WHERE session_id='copy'")
        .execute(&mut db)
        .await
        .unwrap();
    let error = super::MIGRATIONS
        .run_direct(None, &mut db, false)
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("NOT NULL constraint failed: artifact_contents.payload"),
        "{error:?}"
    );
    let contents: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_schema WHERE name='artifact_contents'")
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert_eq!(contents, 0, "failed migration rolls back its new schema");
    let original: Vec<u8> =
        sqlx::query_scalar("SELECT payload FROM artifacts WHERE session_id='source'")
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert_eq!(original, bytes, "old material survives failed migration");
    let conflicting: Vec<u8> =
        sqlx::query_scalar("SELECT payload FROM artifacts WHERE session_id='copy'")
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert_eq!(conflicting, vec![0; bytes.len()]);
    sqlx::query("UPDATE artifacts SET payload=? WHERE session_id='copy'")
        .bind(bytes.as_slice())
        .execute(&mut db)
        .await
        .unwrap();
    db.close().await.unwrap();
    let log = crate::EventLog::open(&path).await.unwrap();
    let inspect = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        inspect
            .query_row("SELECT COUNT(*) FROM artifact_contents", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        inspect
            .query_row("SELECT COUNT(*) FROM session_history_artifacts", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        1
    );
    assert!(
        !inspect
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap()
    );
    for session in ["source", "copy"] {
        assert_eq!(
            log.read_artifact_chunk(session, "file", 0, 1024)
                .await
                .unwrap()
                .unwrap()
                .bytes,
            bytes
        );
    }
    log.close().await.unwrap();
}
