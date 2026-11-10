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

// Synthetic selected-resource metadata exercises the complete upload/draft path.
// No filesystem filename or OS limit is inferred from this display label.
fn selected_name() -> String {
    format!("{}-original-selected.txt", "附".repeat(600))
}
struct SelectedFile;
impl maka_capabilities::call::ReadResource for SelectedFile {
    fn resource_type(&self) -> maka_plugin_core::contract::ResourceType {
        maka_plugin_core::contract::binary_resource_type()
    }
    fn bytes(&self) -> usize {
        b"actual selected bytes".len()
    }
    fn metadata(&self) -> Value {
        json!({"name":selected_name(),"bytes":21,"digest":"sha256:9989a315c7fb6c07f91bd91de902109f14ed480e4ea7b04534e872abc81f1007"})
    }
    fn read(&self, range: std::ops::Range<usize>) -> Result<Vec<u8>> {
        b"actual selected bytes"
            .get(range)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| "invalid range".into())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn original_upload_receipts_and_complete_attachment_drafts_survive_restart_and_send() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let fixture = Fixture::new().await;
        let client = fixture.client().await;
        let observer = client.clone();
        let mut updates = observer.watch_uploads();
        let upload = client
            .upload_attachment(
                Uuid::new_v4(),
                "session-one",
                "composer",
                Arc::new(SelectedFile),
            )
            .await
            .unwrap();
        updates.changed().await.unwrap();
        assert_eq!(
            observer
                .pending_uploads("session-one", "composer")
                .await
                .unwrap()[0]
                .id,
            upload.id()
        );
        upload.prepare().await.unwrap();
        upload.confirm().await.unwrap();
        assert!(
            client
                .pending_operations("agent", "session-one", "composer")
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            client
                .pending_uploads("session-two", "composer")
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            client
                .operation_for_upload("session-one", "other-editor", upload.id())
                .await
                .unwrap_err(),
            "original attachment upload belongs to another draft owner"
        );
        client.close().await.unwrap();

        let client = fixture.client().await;
        let originals = client
            .pending_uploads("session-one", "composer")
            .await
            .unwrap();
        assert_eq!(
            originals
                .iter()
                .map(|operation| operation.id)
                .collect::<Vec<_>>(),
            [upload.id()]
        );
        let Some(Receipt::Recorded {
            outcome: OperationOutcome::Returned { value },
            ..
        }) = &originals[0].receipt
        else {
            panic!("original uploaded receipt must survive client reopen");
        };
        assert_eq!(value["attachment"]["name"], selected_name());
        assert_eq!(value["attachment"]["bytes"], 21);
        assert_eq!(value["attachment"]["id"], "original-upload");

        let attachment = DraftAttachment {
            id: "original-upload".into(),
            name: selected_name(),
            mime_type: "text/plain".into(),
            bytes: 21,
        };
        let edit = DraftEdit {
            quotes: vec![],
            text: String::new(),
            attachments: vec![attachment.clone()],
            settled_uploads: vec![upload.id()],
        };
        assert!(
            client
                .save_draft("agent", "session-one", "other-editor", None, edit.clone())
                .await
                .is_err()
        );
        let saved = client
            .save_draft("agent", "session-one", "composer", None, edit)
            .await
            .unwrap();
        assert_eq!(
            (
                saved.revision,
                saved.text.as_str(),
                saved.attachments.as_slice()
            ),
            (1, "", std::slice::from_ref(&attachment))
        );
        assert!(
            client
                .pending_uploads("session-one", "composer")
                .await
                .unwrap()
                .is_empty()
        );
        client.close().await.unwrap();

        let client = fixture.client().await;
        assert_eq!(
            client
                .load_draft("agent", "session-one", "composer")
                .await
                .unwrap()
                .unwrap()
                .attachments,
            [attachment]
        );
        let send = client
            .reserve_send_draft(
                Uuid::new_v4(),
                "agent",
                "session-one",
                "composer",
                1,
                json!({"attachments":["unselected-forged-id"]}),
            )
            .await
            .unwrap();
        let send = send.open().await.unwrap();
        send.prepare().await.unwrap();
        send.confirm().await.unwrap();
        let messages = fixture.counter.messages.lock().unwrap().clone();
        assert_eq!(messages[0]["message"], "");
        assert_eq!(messages[0]["attachments"], json!(["original-upload"]));
        let unknown = client
            .upload_attachment(
                Uuid::new_v4(),
                "session-one",
                "composer",
                Arc::new(SelectedFile),
            )
            .await
            .unwrap();
        unknown.prepare().await.unwrap();
        unknown.disconnect().await.unwrap();
        assert!(matches!(
            client.recover(unknown.id()).await.unwrap().receipt,
            Receipt::NotRecorded
        ));
        client
            .save_draft(
                "agent",
                "session-one",
                "composer",
                Some(1),
                DraftEdit {
                    quotes: vec![],
                    text: String::new(),
                    settled_uploads: vec![unknown.id()],
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(
            client
                .pending_uploads("session-one", "composer")
                .await
                .unwrap()
                .is_empty()
        );
        client.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn legacy_frozen_send_survives_upgrade_and_preserves_the_next_draft() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let fixture = Fixture::new().await;
        let client = fixture.client().await;
        let first = client.save_draft("agent", "session-one", "composer", None, "original message".into()).await.unwrap();
        let original = Uuid::new_v4();
        let frozen = client.reserve_send_draft(original, "agent", "session-one", "composer", first.revision, json!({"delivery":"steer"})).await.unwrap();
        assert_eq!(client.load_draft("agent", "session-one", "composer").await.unwrap().unwrap().text, "");
        let next = client.save_draft("agent", "session-one", "composer", Some(first.revision), "new draft".into()).await.unwrap();
        assert!(client.retry_send(original, Uuid::new_v4(), json!({})).await.is_err(), "an unconfirmed attempt never authorizes another send");
        drop(frozen);
        client.close().await.unwrap();

        // The previous client had no quote table or quote field in frozen sends.
        let legacy = SqlitePool::connect_with(sqlx::sqlite::SqliteConnectOptions::new()
            .filename(fixture.directory.path().join("client.db"))).await.unwrap();
        sqlx::query("DROP TABLE draft_quotes").execute(&legacy).await.unwrap();
        sqlx::query("UPDATE operations SET context=json_remove(context,'$.correlation.draft.quotes') WHERE id=?")
            .bind(original.to_string()).execute(&legacy).await.unwrap();
        legacy.close().await;

        let client = fixture.client().await;
        let upgraded = client.load_draft("agent", "session-one", "composer").await.unwrap().unwrap();
        assert_eq!(upgraded.text, "new draft");
        assert!(upgraded.quotes.is_empty());
        let pending = client.pending_operations("agent", "session-one", "composer").await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].correlation["draft"]["text"], "original message");
        assert!(client.recover(original).await.is_err());
        assert!(client.operation(original).await.unwrap().abandoned);
        fixture.counter.blocked.store(true, Ordering::SeqCst);
        let retry = client.retry_send(original, Uuid::new_v4(), json!({"delivery":"steer"})).await.unwrap().open().await.unwrap();
        retry.prepare().await.unwrap();
        let mut confirmed = Box::pin(retry.confirm());
        tokio::select! {
            result = &mut confirmed => panic!("send returned before releasing the gate: {result:?}"),
            () = fixture.counter.started.notified() => {},
        }
        assert!(client.retry_send(retry.id(), Uuid::new_v4(), json!({})).await.is_err(), "an already dispatched attempt with no receipt cannot be replayed");
        client.save_draft("agent", "session-one", "composer", Some(next.revision), "typed while sending".into()).await.unwrap();
        fixture.counter.release.notify_one();
        confirmed.await.unwrap();
        assert_eq!(client.load_draft("agent", "session-one", "composer").await.unwrap().unwrap().text, "typed while sending");
        assert_eq!(fixture.counter.messages.lock().unwrap().iter().map(|value| value["message"].as_str().unwrap()).collect::<Vec<_>>(), ["original message"]);
        assert!(client.pending_operations("agent", "session-one", "composer").await.unwrap().is_empty());
        client.close().await.unwrap();
        fixture.finish().await;
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queue_delivery_requires_native_confirmation_and_stopped_messages_can_retry() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let fixture = Fixture::new().await;
        let client = fixture.client().await;
        let draft = client
            .save_draft(
                "agent",
                "session-one",
                "composer",
                None,
                "queued snapshot".into(),
            )
            .await
            .unwrap();
        let id = Uuid::new_v4();
        let send = client
            .reserve_send_draft(
                id,
                "agent",
                "session-one",
                "composer",
                draft.revision,
                json!({"delivery":"queue","expectedInvocationId":"running"}),
            )
            .await
            .unwrap()
            .open()
            .await
            .unwrap();
        send.prepare().await.unwrap();
        send.confirm().await.unwrap();
        let next = client
            .save_draft(
                "agent",
                "session-one",
                "composer",
                Some(draft.revision),
                "separate draft".into(),
            )
            .await
            .unwrap();
        assert_eq!(
            client.send_delivery(id).await.unwrap(),
            SendDelivery::Accepted
        );
        assert!(
            client
                .retry_send(id, Uuid::new_v4(), json!({}))
                .await
                .is_err()
        );
        fixture
            .counter
            .deliveries
            .lock()
            .unwrap()
            .insert("message-1".into(), "unknown".into());
        assert_eq!(
            client.send_delivery(id).await.unwrap(),
            SendDelivery::Unknown
        );
        assert!(
            client
                .retry_send(id, Uuid::new_v4(), json!({}))
                .await
                .is_err(),
            "queue disappearance alone cannot authorize replay"
        );
        assert_eq!(
            client
                .pending_operations("agent", "session-one", "composer")
                .await
                .unwrap()
                .len(),
            1
        );
        fixture
            .counter
            .deliveries
            .lock()
            .unwrap()
            .insert("message-1".into(), "cancelled".into());
        let retry = client
            .retry_send(
                id,
                Uuid::new_v4(),
                json!({"delivery":"steer","expectedInvocationId":"next-run"}),
            )
            .await
            .unwrap()
            .open()
            .await
            .unwrap();
        retry.prepare().await.unwrap();
        retry.confirm().await.unwrap();
        assert_eq!(
            client
                .load_draft("agent", "session-one", "composer")
                .await
                .unwrap()
                .unwrap()
                .text,
            "separate draft"
        );
        assert_eq!(
            fixture.counter.messages.lock().unwrap()[1]["message"],
            "queued snapshot"
        );
        assert_eq!(
            fixture.counter.messages.lock().unwrap()[1]["expectedInvocationId"],
            "next-run"
        );

        let stopped = client
            .reserve_send_draft(
                Uuid::new_v4(),
                "agent",
                "session-one",
                "composer",
                next.revision,
                json!({"delivery":"steer","expectedInvocationId":"stopped"}),
            )
            .await
            .unwrap()
            .open()
            .await
            .unwrap();
        stopped.prepare().await.unwrap();
        stopped.confirm().await.unwrap();
        let pending = client
            .pending_operations("agent", "session-one", "composer")
            .await
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].correlation["draft"]["text"], "separate draft");
        let retry = client
            .retry_send(stopped.id(), Uuid::new_v4(), json!({"delivery":"queue"}))
            .await
            .unwrap()
            .open()
            .await
            .unwrap();
        let delivered = retry.id();
        retry.prepare().await.unwrap();
        retry.confirm().await.unwrap();
        fixture
            .counter
            .deliveries
            .lock()
            .unwrap()
            .insert("message-3".into(), "delivered".into());
        assert_eq!(
            client.send_delivery(delivered).await.unwrap(),
            SendDelivery::Delivered
        );
        assert!(
            client
                .pending_operations("agent", "session-one", "composer")
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(fixture.counter.messages.lock().unwrap().len(), 4);
        client.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quote_only_draft_survives_reopen_frozen_retry_and_newer_edits() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let fixture = Fixture::new().await;
        let client = fixture.client().await;
        let quote = json!({"text":"A published finding","sourceMessageId":"bot/4","sourceTurnId":"original-bot-turn",
            "source":{"sessionId":"session-one","sessionName":"Bot","capturedAt":1234,"truncated":false}});
        let edit: DraftEdit = serde_json::from_value(json!({"text":"","quotes":[quote],"attachments":[],"settledUploads":[]})).unwrap();
        let saved = client.save_draft("agent","session-one","composer",None,edit.clone()).await.unwrap();
        client.close().await.unwrap();
        let client = fixture.client().await;
        assert_eq!(client.load_draft("agent","session-one","composer").await.unwrap().unwrap().quotes,edit.quotes);
        let original = Uuid::new_v4();
        let frozen = client.reserve_send_draft(original,"agent","session-one","composer",saved.revision,json!({"quotes":[{"text":"forged"}]})).await.unwrap();
        assert!(client.load_draft("agent","session-one","composer").await.unwrap().unwrap().quotes.is_empty());
        let newer = client.save_draft("agent","session-one","composer",Some(saved.revision),"Later unrelated draft".into()).await.unwrap();
        assert!(client.save_draft("agent","session-one","composer",Some(saved.revision),edit).await.is_err());
        drop(frozen);
        client.close().await.unwrap();
        let client = fixture.client().await;
        assert!(client.recover(original).await.is_err());
        let retry = client.retry_send(original,Uuid::new_v4(),json!({"delivery":"queue","quotes":[]})).await.unwrap().open().await.unwrap();
        retry.prepare().await.unwrap(); retry.confirm().await.unwrap();
        let sent = fixture.counter.messages.lock().unwrap().clone();
        assert_eq!(sent.len(),1);
        assert_eq!(sent[0]["quotes"],json!([quote]));
        assert_eq!(sent[0]["message"],"");
        assert_eq!(client.load_draft("agent","session-one","composer").await.unwrap().unwrap().text,newer.text);
        let send = client.reserve_send_draft(Uuid::new_v4(),"agent","session-one","composer",newer.revision,json!({"quotes":[{"text":"injected"}]})).await.unwrap().open().await.unwrap();
        send.prepare().await.unwrap();send.confirm().await.unwrap();
        assert_eq!(fixture.counter.messages.lock().unwrap()[1]["quotes"],json!([]));
        client.close().await.unwrap();fixture.finish().await;
    }).await.unwrap();
}
