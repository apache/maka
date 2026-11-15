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
async fn room_draft_relations_survive_restart_and_transfer_to_the_original_send() {
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
        "room",
        "composer",
    )
    .unwrap();
    let draft = journal
        .save_draft(
            &key,
            None,
            DraftEdit {
                text: "Check the layout".into(),
                mentions: vec!["designer".into(), "reviewer".into()],
                reply_to: Some("original-message".into()),
                ..DraftEdit::default()
            },
        )
        .await
        .unwrap();
    let reopened = Journal::open(&path).await.unwrap();
    let restored = reopened.load_draft(&key).await.unwrap().unwrap();
    assert_eq!(restored.text, "Check the layout");
    assert_eq!(restored.mentions, ["designer", "reviewer"]);
    assert_eq!(restored.reply_to.as_deref(), Some("original-message"));
    let operation = Operation {
        id: Uuid::new_v4(),
        host: host.clone(),
        endpoint: "agent".into(),
        method: "send".into(),
        session_id: Some("room".into()),
        correlation: serde_json::to_value(SendSnapshot {
            draft: restored,
            selection: json!({"delivery":"steer"}),
        })
        .unwrap(),
        draft: Some(DraftReference {
            key: key.clone(),
            revision: draft.revision,
        }),
        upload: None,
        abandoned: false,
        reference: None,
        receipt: None,
    };
    reopened.reserve_send(&operation).await.unwrap();
    let empty = reopened.load_draft(&key).await.unwrap().unwrap();
    assert!(empty.text.is_empty());
    assert!(empty.mentions.is_empty());
    assert_eq!(empty.reply_to, None);
    let pending = reopened.pending(&host, &key).await.unwrap();
    assert_eq!(pending.len(), 1);
    let frozen: SendSnapshot = serde_json::from_value(pending[0].correlation.clone()).unwrap();
    assert_eq!(frozen.draft.mentions, ["designer", "reviewer"]);
    assert_eq!(frozen.draft.reply_to.as_deref(), Some("original-message"));
    reopened
        .save_draft(
            &key,
            Some(empty.revision),
            DraftEdit {
                text: "Next thought".into(),
                mentions: vec!["writer".into()],
                ..DraftEdit::default()
            },
        )
        .await
        .unwrap();
    reopened.observe(&operation, &Receipt::Recorded {
        outcome: OperationOutcome::Returned {
            result: OperationResult::Success { value: json!({"kind":"posted","sessionId":"room","messageId":"posted-message","deliveries":[]}) },
        },
        cleanup: OperationCleanup::Confirmed,
    }).await.unwrap();
    assert!(reopened.pending(&host, &key).await.unwrap().is_empty());
    let next = reopened.load_draft(&key).await.unwrap().unwrap();
    assert_eq!(next.text, "Next thought");
    assert_eq!(next.mentions, ["writer"]);
    assert_eq!(next.reply_to, None);
    let other = DraftKey {
        session_id: "other-room".into(),
        ..key
    };
    assert!(reopened.load_draft(&other).await.unwrap().is_none());
}
