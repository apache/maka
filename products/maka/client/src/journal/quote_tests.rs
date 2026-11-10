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
use serde_json::json;

fn owner() -> (DeploymentRef, DraftKey) {
    let host = DeploymentRef {
        state_domain: "a".repeat(64),
        deployment: Uuid::new_v4(),
        revision: 1,
    };
    let namespace = InstanceId(vec![Uuid::new_v4()]);
    let key = DraftKey::new(&host, &namespace, "agent", "bot", "composer").unwrap();
    (host, key)
}
fn send(host: &DeploymentRef, key: &DraftKey, draft: Draft) -> Operation {
    Operation {
        id: Uuid::new_v4(),
        host: host.clone(),
        endpoint: "agent".into(),
        method: "send".into(),
        session_id: Some(key.session_id.clone()),
        correlation: json!({"draft":draft,"selection":{}}),
        draft: Some(DraftReference {
            key: key.clone(),
            revision: draft.revision,
        }),
        upload: None,
        abandoned: false,
        reference: None,
        receipt: None,
    }
}

#[tokio::test]
async fn quoted_drafts_and_frozen_sends_survive_restart_without_consuming_newer_edits() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("client.db");
    let (host, key) = owner();
    let quote = json!({"text":"An original finding","sourceMessageId":"bot/4","sourceTurnId":"published-turn",
        "source":{"sessionId":"bot","sessionName":"Bot","capturedAt":1234,"truncated":false}});
    let edit: DraftEdit = serde_json::from_value(
        json!({"text":"","quotes":[quote],"attachments":[],"settledUploads":[]}),
    )
    .unwrap();
    let journal = Journal::open(&path).await.unwrap();
    let draft = journal.save_draft(&key, None, edit.clone()).await.unwrap();
    journal.pool.close().await;
    drop(journal);
    let journal = Journal::open(&path).await.unwrap();
    assert_eq!(
        journal.load_draft(&key).await.unwrap().unwrap().quotes,
        edit.quotes
    );
    let original = send(&host, &key, draft.clone());
    journal.reserve_send(&original).await.unwrap();
    assert!(
        journal
            .load_draft(&key)
            .await
            .unwrap()
            .unwrap()
            .quotes
            .is_empty()
    );
    let newer = journal
        .save_draft(&key, Some(draft.revision), "Unrelated later draft".into())
        .await
        .unwrap();
    assert!(
        journal
            .save_draft(&key, Some(draft.revision), edit)
            .await
            .is_err()
    );
    assert!(
        journal
            .reserve_send(&send(&host, &key, draft))
            .await
            .is_err()
    );
    journal.pool.close().await;
    drop(journal);
    let journal = Journal::open(&path).await.unwrap();
    let retained = journal.load(&host, original.id).await.unwrap();
    let frozen: SendSnapshot = serde_json::from_value(retained.correlation).unwrap();
    assert_eq!(
        serde_json::to_value(frozen.draft.quotes).unwrap(),
        json!([quote])
    );
    assert_eq!(
        journal.load_draft(&key).await.unwrap().unwrap().text,
        newer.text
    );
    assert_eq!(journal.pending(&host, &key).await.unwrap().len(), 1);
    journal.pool.close().await;
}

#[tokio::test]
async fn pre_quote_journal_upgrade_preserves_frozen_send_and_current_draft() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("client.db");
    let (host, key) = owner();
    let journal = Journal::open(&path).await.unwrap();
    let draft = journal
        .save_draft(&key, None, "Original message".into())
        .await
        .unwrap();
    let original = send(&host, &key, draft.clone());
    journal.reserve_send(&original).await.unwrap();
    journal
        .save_draft(&key, Some(draft.revision), "Newer draft".into())
        .await
        .unwrap();
    // Match the persisted layout written before quoted drafts were supported.
    sqlx::query("DROP TABLE draft_quotes")
        .execute(&journal.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE operations SET context=json_remove(context,'$.correlation.draft.quotes') WHERE id=?")
        .bind(original.id.to_string()).execute(&journal.pool).await.unwrap();
    journal.pool.close().await;
    drop(journal);
    let journal = Journal::open(&path).await.unwrap();
    let draft = journal.load_draft(&key).await.unwrap().unwrap();
    assert_eq!(draft.text, "Newer draft");
    assert!(draft.quotes.is_empty());
    let frozen: SendSnapshot =
        serde_json::from_value(journal.load(&host, original.id).await.unwrap().correlation)
            .unwrap();
    assert_eq!(frozen.draft.text, "Original message");
    assert!(frozen.draft.quotes.is_empty());
    assert_eq!(journal.pending(&host, &key).await.unwrap().len(), 1);
    journal.pool.close().await;
}
