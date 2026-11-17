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
use maka_plugin_core::operation::OperationCleanup;
use serde_json::json;

#[tokio::test]
async fn room_recovered_send_preserves_its_mentions_and_the_newer_draft() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("client.sqlite");
    let journal = Journal::open(&path).await.unwrap();
    let host = DeploymentRef {
        state_domain: "a".repeat(64),
        deployment: Uuid::new_v4(),
        revision: 1,
    };
    let key = DraftKey::new(
        &host,
        &InstanceId(vec![Uuid::new_v4()]),
        "agent",
        "review-room",
        "composer",
    )
    .unwrap();
    let draft = journal
        .save_draft(
            &key,
            None,
            DraftEdit {
                text: "Review this patch".into(),
                mentions: vec!["reviewer".into()],
                reply_to: Some("original-message".into()),
                ..DraftEdit::default()
            },
        )
        .await
        .unwrap();
    let operation = Operation {
        id: Uuid::new_v4(),
        host: host.clone(),
        endpoint: "agent".into(),
        method: "send".into(),
        session_id: Some("review-room".into()),
        draft: Some(DraftReference {
            key: key.clone(),
            revision: draft.revision,
        }),
        correlation: serde_json::to_value(SendSnapshot {
            draft,
            selection: json!({}),
        })
        .unwrap(),
        upload: None,
        abandoned: false,
        reference: None,
        receipt: None,
    };
    journal.reserve_send(&operation).await.unwrap();
    let next = journal.load_draft(&key).await.unwrap().unwrap();
    assert_eq!(
        (
            &*next.text,
            next.mentions.as_slice(),
            next.reply_to.as_deref()
        ),
        ("", &[][..], None)
    );
    journal
        .save_draft(
            &key,
            Some(next.revision),
            DraftEdit {
                text: "Check the layout next".into(),
                mentions: vec!["designer".into()],
                reply_to: Some("layout-message".into()),
                ..DraftEdit::default()
            },
        )
        .await
        .unwrap();
    journal.pool.close().await;
    drop(journal);

    let journal = Journal::open(&path).await.unwrap();
    let pending = journal.pending(&host, &key).await.unwrap();
    assert_eq!(pending.len(), 1);
    let frozen: SendSnapshot = serde_json::from_value(pending[0].correlation.clone()).unwrap();
    assert_eq!(frozen.draft.text, "Review this patch");
    assert_eq!(frozen.draft.mentions, ["reviewer"]);
    assert_eq!(frozen.draft.reply_to.as_deref(), Some("original-message"));
    journal.observe(&pending[0], &Receipt::Recorded {
        outcome: OperationOutcome::Returned {
            result: OperationResult::Success { value: json!({
                "kind":"posted", "sessionId":"review-room", "messageId":"posted-message", "deliveries":[]
            }) },
        },
        cleanup: OperationCleanup::Confirmed,
    }).await.unwrap();
    assert_eq!(journal.pending(&host, &key).await.unwrap().len(), 0);
    let next = journal.load_draft(&key).await.unwrap().unwrap();
    assert_eq!(next.text, "Check the layout next");
    assert_eq!(next.mentions, ["designer"]);
    assert_eq!(next.reply_to.as_deref(), Some("layout-message"));
    journal.pool.close().await;
}

#[tokio::test]
async fn drafts_saved_before_rooms_still_load() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("client.sqlite");
    let host = DeploymentRef {
        state_domain: "a".repeat(64),
        deployment: Uuid::new_v4(),
        revision: 1,
    };
    let key = DraftKey::new(
        &host,
        &InstanceId(vec![Uuid::new_v4()]),
        "agent",
        "session",
        "composer",
    )
    .unwrap();
    {
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let mut connection = sqlx::ConnectOptions::connect(&options).await.unwrap();
        sqlx::query("CREATE TABLE drafts (owner TEXT PRIMARY KEY, revision INTEGER NOT NULL, text TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, attachments TEXT NOT NULL DEFAULT '[]')")
            .execute(&mut connection).await.unwrap();
        sqlx::query("INSERT INTO drafts (owner, revision, text) VALUES (?, 3, 'kept')")
            .bind(serde_json::to_string(&key).unwrap())
            .execute(&mut connection)
            .await
            .unwrap();
    }
    let journal = Journal::open(&path).await.unwrap();
    let draft = journal.load_draft(&key).await.unwrap().unwrap();
    assert_eq!((draft.revision, draft.text.as_str()), (3, "kept"));
    assert!(draft.mentions.is_empty() && draft.reply_to.is_none());
}
