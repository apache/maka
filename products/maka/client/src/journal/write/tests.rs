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

use super::*;
use crate::journal::{Journal, UploadReference};
use maka_plugin_core::composition::InstanceId;
use serde_json::Value;

fn key() -> DraftKey {
    DraftKey {
        state_domain: "host".into(),
        deployment: Uuid::from_u128(1),
        namespace: InstanceId(vec![Uuid::from_u128(2)]),
        export: "Agent".into(),
        session_id: "session".into(),
        editor_id: "editor".into(),
    }
}
fn pending(command: Command) -> (Pending, oneshot::Receiver<Result<Output>>) {
    let (reply, receiver) = oneshot::channel();
    (Pending { command, reply }, receiver)
}
fn save(key: &DraftKey, expected: Option<u64>, text: &str) -> Command {
    Command::SaveDraft {
        key: key.clone(),
        expected,
        edit: text.into(),
    }
}

#[tokio::test]
async fn grouped_cas_rejection_rolls_back_upload_adoption_and_preserves_peers_on_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("client.db");
    let journal = Journal::open(&path).await.unwrap();
    let key = key();
    journal
        .save_draft(&key, None, "original".into())
        .await
        .unwrap();
    let upload = Operation {
        id: Uuid::from_u128(3),
        host: DeploymentRef {
            state_domain: key.state_domain.clone(),
            deployment: key.deployment,
            revision: 1,
        },
        endpoint: "agent".into(),
        method: "uploadAttachment".into(),
        session_id: Some(key.session_id.clone()),
        correlation: Value::Null,
        draft: None,
        upload: Some(UploadReference {
            key: key.clone(),
            name: "file".into(),
            bytes: 4,
            digest: "digest".into(),
        }),
        abandoned: false,
        reference: None,
        receipt: None,
    };
    journal.reserve(&upload).await.unwrap();
    // A rejected upload is still adopted by a successful editor save.
    journal
        .observe(
            &upload,
            &Receipt::Recorded {
                outcome: OperationOutcome::Returned {
                    value: serde_json::json!({"kind":"rejected"}),
                },
                cleanup: OperationCleanup::Confirmed,
            },
        )
        .await
        .unwrap();
    let (first, first_reply) = pending(save(&key, Some(1), "winner"));
    let (rejected, rejected_reply) = pending(Command::SaveDraft {
        key: key.clone(),
        expected: Some(1),
        edit: DraftEdit {
            text: "loser".into(),
            settled_uploads: vec![upload.id],
            attachments: vec![],
        },
    });
    let mut peer_key = key.clone();
    peer_key.editor_id = "peer".into();
    let (peer, peer_reply) = pending(save(&peer_key, None, "independent"));
    commit_batch(&journal.pool, vec![first, rejected, peer]).await;
    assert!(matches!(
        first_reply.await.unwrap(),
        Ok(Output::Draft(Draft { revision: 2, .. }))
    ));
    assert!(
        rejected_reply
            .await
            .unwrap()
            .err()
            .unwrap()
            .contains("revision conflicts")
    );
    assert!(peer_reply.await.unwrap().is_ok());
    journal.pool.close().await;
    drop(journal);
    let reopened = Journal::open(&path).await.unwrap();
    assert_eq!(
        reopened.load_draft(&key).await.unwrap().unwrap().text,
        "winner"
    );
    assert_eq!(
        reopened.load_draft(&peer_key).await.unwrap().unwrap().text,
        "independent"
    );
    assert_eq!(
        reopened
            .pending_uploads(&upload.host, &key)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn failed_shared_commit_never_replies_success_or_persists_prepared_writes() {
    let directory = tempfile::tempdir().unwrap();
    let journal = Journal::open(&directory.path().join("client.db"))
        .await
        .unwrap();
    // A deferred foreign key fails the real COMMIT after both commands succeed.
    sqlx::query("CREATE TABLE parent(id INTEGER PRIMARY KEY)")
        .execute(&journal.pool)
        .await
        .unwrap();
    sqlx::query(
        "CREATE TABLE child(parent INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)",
    )
    .execute(&journal.pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER fail_commit AFTER INSERT ON drafts BEGIN INSERT INTO child VALUES(1); END",
    )
    .execute(&journal.pool)
    .await
    .unwrap();
    let first_key = key();
    let mut second_key = key();
    second_key.editor_id = "second".into();
    let (first, first_reply) = pending(save(&first_key, None, "first"));
    let (second, second_reply) = pending(save(&second_key, None, "second"));
    commit_batch(&journal.pool, vec![first, second]).await;
    for receiver in [first_reply, second_reply] {
        let cause = receiver.await.unwrap().err().unwrap();
        assert!(
            cause.contains("committing writes") && cause.contains("FOREIGN KEY"),
            "{cause}"
        );
    }
    assert!(journal.load_draft(&first_key).await.unwrap().is_none());
    assert!(journal.load_draft(&second_key).await.unwrap().is_none());
}

#[tokio::test]
async fn closing_queue_drains_abandoned_observers_and_releases_worker() {
    let directory = tempfile::tempdir().unwrap();
    let journal = Journal::open(&directory.path().join("client.db"))
        .await
        .unwrap();
    let (sender, receiver) = mpsc::channel(COMMAND_BUFFER_SIZE);
    let key = key();
    let (write, response) = pending(save(&key, None, "accepted before cancellation"));
    sender.send(write).await.ok().unwrap();
    drop(response);
    drop(sender);
    run(journal.pool.clone(), receiver).await;
    assert_eq!(
        journal.load_draft(&key).await.unwrap().unwrap().text,
        "accepted before cancellation"
    );
}
