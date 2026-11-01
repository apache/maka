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

//! Startup-only conversion from the former JSON directory representation.
use super::directory::codec;
use crate::StoreError;
use maka_agent_facts::history::semantic::directory::{
    ChildDirectory, PayloadDirectory, RowDirectory,
};
use rusqlite::{
    Connection,
    functions::{Context, FunctionFlags},
};
use serde::de::DeserializeOwned;

fn transcode<T: DeserializeOwned>(
    context: &Context<'_>,
    encode: impl FnOnce(&T) -> Result<Vec<u8>, StoreError>,
) -> rusqlite::Result<Vec<u8>> {
    let value: T = serde_json::from_slice(context.get_raw(0).as_bytes()?)
        .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))?;
    encode(&value).map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))
}
pub(crate) fn register(db: &Connection) -> Result<(), StoreError> {
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    db.create_scalar_function("maka_directory_row", 1, flags, |context| {
        transcode::<RowDirectory>(context, codec::encode)
    })?;
    db.create_scalar_function("maka_directory_payload", 1, flags, |context| {
        transcode::<PayloadDirectory>(context, codec::encode)
    })?;
    db.create_scalar_function("maka_directory_child", 1, flags, |context| {
        transcode::<ChildDirectory>(context, codec::encode)
    })?;
    Ok(())
}
pub(crate) fn unregister(db: &Connection) -> Result<(), StoreError> {
    for name in [
        "maka_directory_row",
        "maka_directory_payload",
        "maka_directory_child",
    ] {
        db.remove_function(name, 1)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::{
        history::{
            RowPosition,
            semantic::directory::{ByteRange, JsonSpan, TextSpan, ValueKind},
        },
        model::prompt_source::source::{DecodedTextMeasure, RawJsonMeasure},
    };
    use sqlx::Connection;

    #[tokio::test]
    async fn migration_is_atomic_preserves_commitments_and_does_not_repeat() {
        let directory = tempfile::tempdir().unwrap();
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(directory.path().join("runtime.sqlite"))
            .create_if_missing(true)
            .foreign_keys(true);
        let mut db = sqlx::SqliteConnection::connect_with(&options)
            .await
            .unwrap();
        sqlx::query("PRAGMA application_id=1296124754")
            .execute(&mut db)
            .await
            .unwrap();
        crate::sqlite_functions::register(&mut db).await.unwrap();
        let all = sqlx::migrate!("./migrations");
        let previous = sqlx::migrate::Migrator {
            migrations: all
                .iter()
                .filter(|migration| migration.version < 13)
                .cloned()
                .collect::<Vec<_>>()
                .into(),
            ..sqlx::migrate::Migrator::DEFAULT
        };
        previous.run_direct(None, &mut db, false).await.unwrap();
        let text = TextSpan {
            range: ByteRange { start: 7, len: 15 },
            measure: DecodedTextMeasure {
                bytes: 9,
                sha256: std::array::from_fn(|index| (index * 7) as u8),
            },
        };
        let json = JsonSpan {
            range: ByteRange { start: 23, len: 29 },
            measure: RawJsonMeasure {
                bytes: 29,
                sha256: std::array::from_fn(|index| 255 - index as u8),
            },
            kind: ValueKind::Object,
        };
        let row = RowDirectory::User {
            payload: RowPosition {
                source_sequence: 1,
                item_index: 0,
            },
            steering: true,
        };
        let payload = PayloadDirectory::User {
            text,
            quotes: 1,
            attachments: 0,
            directory_references: Some(json),
        };
        let child = ChildDirectory::Quote {
            label: Some(text),
            source: Some(json),
            text,
        };
        let row_json = serde_json::to_string_pretty(&row).unwrap();
        sqlx::query("INSERT INTO context_semantic_rows(owner_session_id,source_sequence,source_index,revision,order_sequence,order_index,invocation_id,revision_invocation,event_id,kind,archived,inherited,visible,unknown_only,row_json,directory_json) VALUES('session',1,0,1,1,0,'invocation','invocation','event','user',0,0,1,0,'{}',?)").bind(&row_json).execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO context_semantic_fragments(source_sequence,source_index,storage_kind,byte_offset,byte_len,directory_json,payload_bytes) VALUES(1,0,'pieces',NULL,NULL,'corrupt descriptor',64)").execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO context_semantic_directory_children(source_sequence,source_index,list_kind,ordinal,directory_json) VALUES(1,0,'quotes',0,?)").bind(serde_json::to_string_pretty(&child).unwrap()).execute(&mut db).await.unwrap();
        assert!(crate::schema::initialize_connection(&mut db).await.is_err());
        let saved: String = sqlx::query_scalar("SELECT directory_json FROM context_semantic_rows")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(
            saved, row_json,
            "the earlier successful row conversion must roll back with the later failure"
        );
        let applied: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM _sqlx_migrations WHERE version=13)")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert!(
            !applied,
            "a failed conversion must not publish its migration ledger entry"
        );
        let functions:i64=sqlx::query_scalar("SELECT COUNT(*) FROM pragma_function_list WHERE name IN ('maka_directory_row','maka_directory_payload','maka_directory_child')").fetch_one(&mut db).await.unwrap();
        assert_eq!(
            functions, 0,
            "migration functions must be removed after failure"
        );
        sqlx::query("UPDATE context_semantic_fragments SET directory_json=?")
            .bind(serde_json::to_string_pretty(&payload).unwrap())
            .execute(&mut db)
            .await
            .unwrap();
        crate::schema::initialize_connection(&mut db).await.unwrap();
        let row_bytes: Vec<u8> =
            sqlx::query_scalar("SELECT directory_bytes FROM context_semantic_rows")
                .fetch_one(&mut db)
                .await
                .unwrap();
        let payload_bytes: Vec<u8> =
            sqlx::query_scalar("SELECT directory_bytes FROM context_semantic_fragments")
                .fetch_one(&mut db)
                .await
                .unwrap();
        let child_bytes: Vec<u8> =
            sqlx::query_scalar("SELECT directory_bytes FROM context_semantic_directory_children")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(
            serde_json::to_value(codec::decode::<RowDirectory>(&row_bytes).unwrap()).unwrap(),
            serde_json::to_value(row).unwrap()
        );
        assert_eq!(
            serde_json::to_value(codec::decode::<PayloadDirectory>(&payload_bytes).unwrap())
                .unwrap(),
            serde_json::to_value(payload).unwrap()
        );
        assert_eq!(
            serde_json::to_value(codec::decode::<ChildDirectory>(&child_bytes).unwrap()).unwrap(),
            serde_json::to_value(child).unwrap()
        );
        db.close().await.unwrap();
        let mut db = sqlx::SqliteConnection::connect_with(&options)
            .await
            .unwrap();
        crate::schema::initialize_connection(&mut db).await.unwrap();
        let repeated: Vec<u8> =
            sqlx::query_scalar("SELECT directory_bytes FROM context_semantic_rows")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(
            repeated, row_bytes,
            "reopening must not convert binary descriptors a second time"
        );
        let functions:i64=sqlx::query_scalar("SELECT COUNT(*) FROM pragma_function_list WHERE name IN ('maka_directory_row','maka_directory_payload','maka_directory_child')").fetch_one(&mut db).await.unwrap();
        assert_eq!(
            functions, 0,
            "migration functions must not remain on live query connections"
        );
    }
}
