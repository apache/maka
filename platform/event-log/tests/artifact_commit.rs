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
use maka_event_log::EventLog;
use std::{
    future::{Future, poll_fn},
    sync::Arc,
    task::Poll,
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

struct ReservedBytes {
    bytes: Vec<u8>,
    _reservation: OwnedSemaphorePermit,
}
impl AsRef<[u8]> for ReservedBytes {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}

#[tokio::test]
async fn abandoned_upload_waiter_cannot_free_the_accepted_database_jobs_byte_budget() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("runtime.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let capacity = Arc::new(Semaphore::new(7));
    let payload = ReservedBytes {
        bytes: b"content".to_vec(),
        _reservation: capacity.clone().acquire_many_owned(7).await.unwrap(),
    };
    let artifact = Artifact {
        id: "upload".into(),
        session_id: "session".into(),
        turn_id: "upload".into(),
        created_at: 1,
        name: "file".into(),
        kind: ArtifactKind::File,
        size_bytes: 7,
        mime_type: Some("text/plain".into()),
        source: ArtifactSource::UserUpload,
        summary: Some(content_digest(payload.as_ref())),
    };
    let competing = rusqlite::Connection::open(&path).unwrap();
    competing.execute_batch("BEGIN IMMEDIATE").unwrap();
    let mut pending = Box::pin(log.commit_artifact(artifact.clone(), payload));
    poll_fn(|cx| {
        assert!(pending.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    drop(pending);
    assert_eq!(
        capacity.available_permits(),
        0,
        "database job still owns the payload"
    );
    assert_eq!(
        competing
            .query_row("SELECT COUNT(*) FROM artifacts", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    // Independent reads observe committed state even while an accepted writer
    // waits for its transaction; they are not implicit writer-queue barriers.
    let before = tokio::time::timeout(
        Duration::from_secs(5),
        log.get_artifact("session", "upload"),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(before.record.is_none());
    competing.execute_batch("ROLLBACK").unwrap();
    let released = tokio::time::timeout(
        Duration::from_secs(5),
        capacity.clone().acquire_many_owned(7),
    )
    .await
    .unwrap()
    .unwrap();
    drop(released);
    let entry = tokio::time::timeout(
        Duration::from_secs(5),
        log.get_artifact("session", "upload"),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(entry.record, Some(artifact));
    assert_eq!(capacity.available_permits(), 7);
    assert_eq!(
        log.read_artifact_chunk("session", "upload", 0, 7)
            .await
            .unwrap()
            .unwrap()
            .bytes,
        b"content"
    );
    log.close().await.unwrap();
}
