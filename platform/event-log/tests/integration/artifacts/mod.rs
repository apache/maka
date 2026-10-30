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

use maka_agent_facts::artifact::Artifact;
use maka_agent_facts::artifact::ArtifactKind;
use maka_agent_facts::artifact::ArtifactSource;
use maka_agent_facts::artifact::content_digest;
use maka_event_log::{
    EventLog, StoreError,
    artifacts::{ArtifactDeletion, ArtifactReadScope},
};
use serde_json::json;
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};

fn artifact(id: &str, bytes: &[u8]) -> Artifact {
    Artifact {
        id: id.into(),
        session_id: "session".into(),
        turn_id: "upload".into(),
        created_at: 10,
        name: "file.bin".into(),
        kind: ArtifactKind::File,
        size_bytes: bytes.len() as u64,
        mime_type: Some("application/octet-stream".into()),
        source: ArtifactSource::UserUpload,
        summary: Some(content_digest(bytes)),
    }
}

#[tokio::test]
async fn immutable_uploads_are_scoped_bounded_and_reopen_with_atomic_catalog_changes() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    for session in ["session", "other"] {
        log.create_session(session, session, &json!({}), 1)
            .await
            .unwrap();
    }
    let initial = log.list_artifacts("session", 0, 128).await.unwrap();
    let bytes: Vec<u8> = (0..100_000).map(|i| (i % 251) as u8).collect();
    let first = artifact("first", &bytes);
    assert_eq!(
        log.commit_artifact(first.clone(), bytes.clone())
            .await
            .unwrap(),
        first
    );
    let page = log.list_artifacts("session", 0, 128).await.unwrap();
    assert_ne!(page.revision, initial.revision);
    assert_eq!(page.records, std::slice::from_ref(&first));
    let mut retry = first.clone();
    retry.created_at = 99;
    assert_eq!(
        log.commit_artifact(retry, bytes.clone()).await.unwrap(),
        first
    );
    assert_eq!(
        log.list_artifacts("session", 0, 128)
            .await
            .unwrap()
            .revision,
        page.revision
    );
    let mut different = bytes.clone();
    different[17] ^= 1;
    assert!(matches!(
        log.commit_artifact(first.clone(), different).await,
        Err(StoreError::ArtifactConflict)
    ));
    let mut renamed = first.clone();
    renamed.name = "different".into();
    assert!(matches!(
        log.commit_artifact(renamed, bytes.clone()).await,
        Err(StoreError::ArtifactConflict)
    ));
    let read = log
        .read_artifact_chunk("session", "first", 123, 32_768)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(read.total_bytes, bytes.len() as u64);
    assert_eq!(read.bytes, bytes[123..123 + 32_768]);
    let mut invocation = maka_agent_facts::event::Invocation {
        session_id: "session".into(),
        turn_id: "upload".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let scoped = log
        .with_artifact(
            ArtifactReadScope::Execution(&invocation),
            "first",
            |record, reader| {
                let mut bytes = Vec::new();
                reader.read_to_end(&mut bytes).unwrap();
                (record.clone(), bytes)
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(scoped.0, first);
    assert_eq!(scoped.1, bytes);
    invocation.turn_id = "different-turn".into();
    assert!(
        log.with_artifact(
            ArtifactReadScope::Execution(&invocation),
            "first",
            |_, _| panic!("foreign Turn read")
        )
        .await
        .unwrap()
        .is_none()
    );
    invocation.turn_id = "upload".into();
    invocation.session_id = "other".into();
    assert!(
        log.with_artifact(
            ArtifactReadScope::Execution(&invocation),
            "first",
            |_, _| panic!("foreign Session read")
        )
        .await
        .unwrap()
        .is_none()
    );
    assert!(
        log.read_artifact_chunk("session", "first", bytes.len() as u64, 1)
            .await
            .unwrap()
            .unwrap()
            .bytes
            .is_empty()
    );
    assert!(
        log.read_artifact_chunk("session", "first", bytes.len() as u64 + 1, 1)
            .await
            .is_err()
    );
    assert!(
        log.get_artifact("other", "first")
            .await
            .unwrap()
            .record
            .is_none()
    );
    assert!(
        log.read_artifact_chunk("other", "first", 0, 1)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        log.delete_user_artifact("other", "first").await.unwrap(),
        ArtifactDeletion::NotFound
    );
    let mut protected = artifact("protected", b"proof");
    protected.source = ArtifactSource::ToolResultArchive;
    protected.created_at = 11;
    log.commit_artifact(protected.clone(), b"proof".to_vec())
        .await
        .unwrap();
    let newer = log.list_artifacts("session", 0, 1).await.unwrap();
    assert_eq!(newer.total, 2);
    assert_eq!(newer.records, [protected.clone()]);
    assert_eq!(
        log.list_artifacts("session", 1, 1).await.unwrap().records,
        std::slice::from_ref(&first)
    );
    assert_eq!(
        log.delete_user_artifact("session", "protected")
            .await
            .unwrap(),
        ArtifactDeletion::Protected
    );
    assert_eq!(
        log.list_artifacts("session", 0, 128)
            .await
            .unwrap()
            .revision,
        newer.revision
    );
    // This control authority must not fabricate invocation facts.
    assert_eq!(log.prefix(1, 1024).await.unwrap().high_water, 0);
    log.close().await.unwrap();

    let mut observer = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    let stored: (String, Vec<u8>) =
        sqlx::query_as("SELECT record_json, payload FROM artifacts WHERE id = 'first'")
            .fetch_one(&mut observer)
            .await
            .unwrap();
    assert_eq!(serde_json::from_str::<Artifact>(&stored.0).unwrap(), first);
    assert_eq!(stored.1, bytes);
    observer.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.list_artifacts("session", 0, 128)
            .await
            .unwrap()
            .revision,
        newer.revision
    );
    assert_eq!(
        log.delete_user_artifact("session", "first").await.unwrap(),
        ArtifactDeletion::Deleted
    );
    let remaining = log.list_artifacts("session", 0, 128).await.unwrap();
    assert_ne!(remaining.revision, newer.revision);
    assert_eq!(remaining.records, [protected]);
    assert!(
        log.read_artifact_chunk("session", "first", 0, 1)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        log.delete_user_artifact("session", "first").await.unwrap(),
        ArtifactDeletion::NotFound
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn catalog_fault_rolls_back_payload_metadata_and_delete_as_one_commit() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    let before = log.list_artifacts("session", 0, 128).await.unwrap();
    let mut observer = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    sqlx::raw_sql(
        "CREATE TRIGGER reject_artifact_revision BEFORE INSERT ON artifact_catalog
        BEGIN SELECT RAISE(ABORT, 'injected revision fault'); END;",
    )
    .execute(&mut observer)
    .await
    .unwrap();
    let record = artifact("artifact", b"content");
    assert!(
        log.commit_artifact(record.clone(), b"content".to_vec())
            .await
            .is_err()
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM artifacts")
        .fetch_one(&mut observer)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "metadata/payload insertion rolled back when revision failed"
    );
    assert_eq!(
        log.list_artifacts("session", 0, 128)
            .await
            .unwrap()
            .revision,
        before.revision
    );
    sqlx::raw_sql("DROP TRIGGER reject_artifact_revision")
        .execute(&mut observer)
        .await
        .unwrap();
    log.commit_artifact(record.clone(), b"content".to_vec())
        .await
        .unwrap();
    let committed = log.list_artifacts("session", 0, 128).await.unwrap();
    sqlx::raw_sql(
        "CREATE TRIGGER reject_artifact_revision BEFORE INSERT ON artifact_catalog
        BEGIN SELECT RAISE(ABORT, 'injected deletion revision fault'); END;",
    )
    .execute(&mut observer)
    .await
    .unwrap();
    assert!(
        log.delete_user_artifact("session", "artifact")
            .await
            .is_err()
    );
    assert_eq!(
        log.get_artifact("session", "artifact")
            .await
            .unwrap()
            .record,
        Some(record.clone())
    );
    assert_eq!(
        log.read_artifact_chunk("session", "artifact", 0, 100)
            .await
            .unwrap()
            .unwrap()
            .bytes,
        b"content"
    );
    assert_eq!(
        log.list_artifacts("session", 0, 128)
            .await
            .unwrap()
            .revision,
        committed.revision
    );
    observer.close().await.unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.get_artifact("session", "artifact")
            .await
            .unwrap()
            .record,
        Some(record)
    );
    assert_eq!(
        log.list_artifacts("session", 0, 128)
            .await
            .unwrap()
            .revision,
        committed.revision
    );
    log.close().await.unwrap();
}

mod reads;
