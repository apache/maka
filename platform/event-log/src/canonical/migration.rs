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

//! Pure conversion functions installed only within the schema migration scope.
use super::recipe;
use crate::StoreError;
use rusqlite::{Connection, functions::FunctionFlags};
use sha2::{Digest, Sha256};
fn udf(error: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::UserFunctionError(Box::new(error))
}
pub(crate) fn register(db: &Connection) -> Result<(), StoreError> {
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    db.create_scalar_function("maka_projection_offset", 2, flags, |context| {
        let kind = context.get_raw(0).as_str()?;
        let json = context.get_raw(1).as_str()?;
        Ok(recipe::projection(kind, json)
            .map_err(udf)?
            .map(|projection| projection.offset as i64))
    })?;
    db.create_scalar_function("maka_projection_bytes", 2, flags, |context| {
        let kind = context.get_raw(0).as_str()?;
        let json = context.get_raw(1).as_str()?;
        Ok(recipe::projection(kind, json)
            .map_err(udf)?
            .map(|projection| projection.json.as_bytes().to_vec()))
    })?;
    db.create_scalar_function("maka_event_header", 2, flags, |context| {
        let kind = context.get_raw(0).as_str()?;
        let json = context.get_raw(1).as_str()?;
        match recipe::projection(kind, json).map_err(udf)? {
            Some(projection) => projection.header(json).map_err(udf),
            None => Ok(json.to_owned()),
        }
    })?;
    db.create_scalar_function("maka_body_sha", 1, flags, |context| {
        Ok(Sha256::digest(context.get_raw(0).as_bytes()?).to_vec())
    })?;
    Ok(())
}
pub(crate) fn unregister(db: &Connection) -> Result<(), StoreError> {
    for name in [
        "maka_projection_offset",
        "maka_projection_bytes",
        "maka_event_header",
    ] {
        db.remove_function(name, 2)?;
    }
    db.remove_function("maka_body_sha", 1)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;
    #[tokio::test]
    async fn old_bytes_ranges_lengths_and_shared_last_reference_survive_migration() {
        let mut db = sqlx::SqliteConnection::connect("sqlite::memory:")
            .await
            .unwrap();
        crate::sqlite_functions::register(&mut db).await.unwrap();
        crate::sqlite_functions::register_migrations(&mut db)
            .await
            .unwrap();
        let all = sqlx::migrate!("./migrations");
        let previous = sqlx::migrate::Migrator {
            migrations: all
                .iter()
                .filter(|m| m.version < 14)
                .cloned()
                .collect::<Vec<_>>()
                .into(),
            ..sqlx::migrate::Migrator::DEFAULT
        };
        previous.run_direct(None, &mut db, false).await.unwrap();
        let text = "汉a escaped \\\" line\n".repeat(4000);
        let projection = serde_json::json!({"kind":"json","value":{"n":1.0,"text":text}});
        let original=serde_json::to_string_pretty(&serde_json::json!({"invocation":{"session_id":"session","invocation_id":"invocation"},"fact":{"kind":"tool_settled","operation_id":"operation","outcome":{"kind":"succeeded","model_projection":projection}}})).unwrap().replace("\"n\": 1.0","\"n\": 1e+00").replace("汉a","汉\\u0061");
        for id in ["first", "second"] {
            sqlx::query("INSERT INTO event_log(event_id,invocation_id,kind,event_json) VALUES(?,'invocation','tool_settled',?)").bind(id).bind(&original).execute(&mut db).await.unwrap();
        }
        sqlx::query("INSERT INTO event_log(event_id,invocation_id,kind,event_json,retained_json,body_digest) VALUES('collected','invocation','tool_settled',NULL,'{}','old-digest')").execute(&mut db).await.unwrap();
        // Rebuilding span constraints must preserve opaque encoded directories,
        // child ownership, and rowid-addressed legacy pieces.
        sqlx::raw_sql("INSERT INTO context_semantic_fragments VALUES(1,0,'pieces',NULL,NULL,x'1020',2);
            INSERT INTO context_semantic_directory_children VALUES(1,0,'tool_parts',0,x'3040');
            INSERT INTO context_semantic_fragment_pieces(rowid,source_sequence,source_index,piece_index,bytes) VALUES(904,1,0,0,x'5060');")
            .execute(&mut db).await.unwrap();
        all.run_direct(None, &mut db, false).await.unwrap();
        crate::sqlite_functions::unregister_migrations(&mut db)
            .await
            .unwrap();
        let directory: Vec<u8> = sqlx::query_scalar(
            "SELECT directory_bytes FROM context_semantic_fragments WHERE source_sequence=1",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(directory, [0x10, 0x20]);
        let child: Vec<u8> = sqlx::query_scalar("SELECT directory_bytes FROM context_semantic_directory_children WHERE source_sequence=1").fetch_one(&mut db).await.unwrap();
        assert_eq!(child, [0x30, 0x40]);
        let piece: (i64, Vec<u8>) = sqlx::query_as(
            "SELECT rowid,bytes FROM context_semantic_fragment_pieces WHERE source_sequence=1",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(piece, (904, vec![0x50, 0x60]));
        sqlx::query("INSERT INTO context_semantic_fragments VALUES(9,0,'canonical_tool_projection',2147483648,32,x'00',32)").execute(&mut db).await.unwrap();
        assert!(sqlx::query("INSERT INTO context_semantic_fragments VALUES(10,0,'canonical_model_part',2147483648,32,x'00',32)").execute(&mut db).await.is_err());
        assert!(sqlx::query("INSERT INTO context_semantic_fragments VALUES(11,0,'canonical_tool_projection',9223372036854775776,32,x'00',32)").execute(&mut db).await.is_err());
        let foreign_keys = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut db)
            .await
            .unwrap();
        assert!(foreign_keys.is_empty());
        sqlx::query("DELETE FROM context_semantic_fragments WHERE source_sequence=1")
            .execute(&mut db)
            .await
            .unwrap();
        let children: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM context_semantic_directory_children WHERE source_sequence=1",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(children, 0);
        for sequence in [1, 2] {
            assert_eq!(
                crate::canonical::one(&mut db, sequence).await.unwrap(),
                original
            );
        }
        let bodies: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM event_bodies")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(bodies, 1);
        // The parent cannot disappear while referenced, and a valid alternate
        // body cannot redirect an already published event.
        assert!(
            sqlx::query("DELETE FROM event_bodies")
                .execute(&mut db)
                .await
                .is_err()
        );
        sqlx::query("INSERT INTO event_bodies(id,digest,raw_bytes,sqlite_json_bytes,payload) SELECT id+100,zeroblob(32),raw_bytes,sqlite_json_bytes,payload FROM event_bodies")
            .execute(&mut db).await.unwrap();
        let error = sqlx::query("UPDATE event_log SET body_id=body_id+100 WHERE sequence=1")
            .execute(&mut db)
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("references are immutable"),
            "{error}"
        );
        sqlx::query("DELETE FROM event_bodies WHERE digest=zeroblob(32)")
            .execute(&mut db)
            .await
            .unwrap();
        {
            let mut tx = db.begin().await.unwrap();
            sqlx::query("DELETE FROM event_log WHERE sequence IN (1,2)")
                .execute(&mut *tx)
                .await
                .unwrap();
            let bodies: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM event_bodies")
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            assert_eq!(bodies, 0);
            tx.rollback().await.unwrap();
        }
        let expected: i64 = sqlx::query_scalar(
            "SELECT length(CAST(json_extract(?,'$.fact.outcome.model_projection') AS BLOB))",
        )
        .bind(&original)
        .fetch_one(&mut db)
        .await
        .unwrap();
        let measured: i64 = sqlx::query_scalar("SELECT sqlite_json_bytes FROM event_bodies")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(measured, expected);
        let length: i64 =
            sqlx::query_scalar("SELECT canonical_bytes FROM event_log WHERE sequence=1")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(length as usize, original.len());
        let source = recipe::projection("tool_settled", &original)
            .unwrap()
            .unwrap();
        let ranges = [
            0..64,
            (source.offset - 2)..(source.offset + 32),
            (source.offset + source.json.len() - 2)..(source.offset + source.json.len() + 4),
            (original.len() - 64)..original.len(),
        ];
        let expected_ranges: Vec<_> = ranges
            .iter()
            .map(|range| original.as_bytes()[range.clone()].to_vec())
            .collect();
        crate::connection::worker_query(&mut db, move |worker| {
            Box::pin(async move {
                // SAFETY: the callback exclusively owns this original SQLite worker.
                let raw =
                    unsafe { rusqlite::Connection::from_handle(worker.as_raw_handle().as_ptr()) }?;
                for (range, expected) in ranges.into_iter().zip(expected_ranges) {
                    let actual = crate::canonical::with_span(
                        &raw,
                        1,
                        range.start as u64,
                        (range.end - range.start) as u64,
                        |reader| {
                            let mut bytes = Vec::new();
                            reader.read_to_end(&mut bytes)?;
                            Ok(bytes)
                        },
                    )?;
                    assert_eq!(actual, expected);
                }
                drop(raw);
                Ok(())
            })
        })
        .await
        .unwrap();
        assert!(matches!(
            crate::canonical::one(&mut db, 3).await,
            Err(StoreError::MaterialCollected)
        ));
        assert!(sqlx::query("UPDATE event_log SET event_header=NULL,canonical_bytes=NULL,retained_json='{}',body_digest='digest' WHERE sequence=1").execute(&mut db).await.is_err());
        for (sequence, remaining) in [(1, 1), (2, 0)] {
            let mut tx = db.begin().await.unwrap();
            sqlx::query("UPDATE event_log SET event_header=NULL,canonical_bytes=NULL,body_id=NULL,header_offset=NULL,retained_json='{}',body_digest='digest' WHERE sequence=?").bind(sequence).execute(&mut *tx).await.unwrap();
            tx.commit().await.unwrap();
            let bodies: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM event_bodies")
                .fetch_one(&mut db)
                .await
                .unwrap();
            assert_eq!(bodies, remaining);
        }
    }
}
