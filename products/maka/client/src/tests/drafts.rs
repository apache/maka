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
            .send_draft(
                Uuid::new_v4(),
                "agent",
                "session-one",
                "composer",
                1,
                json!({"attachments":["unselected-forged-id"]}),
            )
            .await
            .unwrap();
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
async fn saved_drafts_and_receipts_preserve_new_edits_across_clear_ordering_and_restart() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let fixture = Fixture::new().await;
        let client = fixture.client().await;
        let first = client.save_draft("agent", "session-one", "composer", None, "first message".into()).await.unwrap();
        assert_eq!(first.revision, 1);
        assert!(client.load_draft("receipts", "session-one", "composer").await.unwrap().is_none());
        assert!(client.load_draft("agent", "session-two", "composer").await.unwrap().is_none());
        assert!(client.load_draft("agent", "session-one", "another-editor").await.unwrap().is_none());
        assert!(client.save_draft("agent", "session-one", "composer", None, "stale creation".into()).await.is_err());
        let abandoned = client.send_draft(Uuid::new_v4(), "agent", "session-one", "composer", 1, json!({})).await.unwrap();
        // A different native scope has no request handle to cancel. Only the
        // durable SQL fence can prevent the old scope's later preparation.
        let replacement = fixture.client().await;
        assert!(replacement.abandon_unprepared(abandoned.id()).await.unwrap().abandoned);
        replacement.close().await.unwrap();
        assert_eq!(abandoned.prepare().await.unwrap_err(), "original client preparation was already recorded or is unavailable");
        assert_eq!(client.query("agent", "read", Value::Null).await.unwrap(), json!({"sent":0}));
        assert!(client.pending_operations("agent", "session-one", "composer").await.unwrap().is_empty());
        let id = Uuid::new_v4();
        let sent = client.send_draft(id, "agent", "session-one", "composer", first.revision, json!({"model":{"kind":"default"}})).await.unwrap();
        let pending = client.pending_operations("agent", "session-one", "composer").await.unwrap();
        assert_eq!(pending.iter().map(|operation|operation.id).collect::<Vec<_>>(), [id]);
        assert!(client.pending_controls().await.unwrap().is_empty());
        assert_eq!(client.operation_for_control(id).await.unwrap_err(), "original client operation belongs to another control owner");
        assert!(pending[0].reference.is_none());
        assert!(client.pending_operations("receipts", "session-one", "composer").await.unwrap().is_empty());
        let operation = sent.prepare().await.unwrap();
        assert!(!client.abandon_unprepared(id).await.unwrap().abandoned, "committed preparation wins against later abandonment");
        assert_eq!(operation.draft.as_ref().unwrap().key.namespace, InstanceId(vec![Uuid::from_u128(1)]));
        sent.confirm().await.unwrap();
        fixture.counter.started.notified().await;
        assert!(client.pending_operations("agent", "session-one", "composer").await.unwrap().is_empty());
        let cleared = client.load_draft("agent", "session-one", "composer").await.unwrap().unwrap();
        let settled = client.operation_for_draft("agent", "session-one", "composer", id).await.unwrap();
        assert_eq!(settled.id, id);
        assert!(matches!(settled.receipt, Some(Receipt::Recorded { outcome: OperationOutcome::Returned { ref value }, .. }) if value["messageId"] == "message-1"));
        for (endpoint, session, editor) in [
            ("receipts", "session-one", "composer"),
            ("agent", "session-two", "composer"),
            ("agent", "session-one", "another-editor"),
        ] {
            assert_eq!(client.operation_for_draft(endpoint, session, editor, id).await.unwrap_err(), "original client operation belongs to another draft owner");
        }
        assert_eq!((cleared.revision, cleared.text.as_str()), (1, ""));
        assert!(client.send_draft(Uuid::new_v4(), "agent", "session-one", "composer", 1, json!({})).await.is_err());
        // Consumption is not another editor write: an already queued save of
        // R=1 can follow the clear without losing the newly typed text.
        let second = client.save_draft("agent", "session-one", "composer", Some(1), "second message".into()).await.unwrap();
        assert_eq!(second.revision, 2);
        fixture.counter.blocked.store(true, Ordering::SeqCst);
        let second_send = client.send_draft(Uuid::new_v4(), "agent", "session-one", "composer", 2, json!({})).await.unwrap();
        second_send.prepare().await.unwrap();
        let mut confirming = Box::pin(second_send.confirm());
        tokio::select! {
            result = &mut confirming => panic!("gated send returned before the next edit: {result:?}"),
            () = fixture.counter.started.notified() => {},
        }
        let third = client.save_draft("agent", "session-one", "composer", Some(2), "typed while sending".into()).await.unwrap();
        assert_eq!(third.revision, 3);
        fixture.counter.release.notify_one();
        confirming.await.unwrap();
        let current = client.load_draft("agent", "session-one", "composer").await.unwrap().unwrap();
        assert_eq!((current.revision, current.text.as_str()), (3, "typed while sending"));
        assert!(client.save_draft("agent", "session-one", "composer", Some(2), "late old write".into()).await.is_err());
        assert_eq!(fixture.counter.messages.lock().unwrap().iter().map(|input| input["message"].as_str().unwrap().to_owned()).collect::<Vec<_>>(), ["first message", "second message"]);
        client.close().await.unwrap();
        let restarted = fixture.client().await;
        restarted.recover(id).await.unwrap();
        let current = restarted.load_draft("agent", "session-one", "composer").await.unwrap().unwrap();
        assert_eq!((current.revision, current.text.as_str()), (3, "typed while sending"));
        // A returned domain rejection is recorded, but does not consume a draft.
        restarted.save_draft("agent", "session-one", "composer", Some(3), "reject".into()).await.unwrap();
        let rejected = restarted.send_draft(Uuid::new_v4(), "agent", "session-one", "composer", 4, json!({})).await.unwrap();
        rejected.prepare().await.unwrap();
        assert!(matches!(rejected.confirm().await.unwrap().receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { ref value }, .. } if value["kind"] == "rejected"));
        assert_eq!(restarted.load_draft("agent", "session-one", "composer").await.unwrap().unwrap().text, "reject");
        let unconfirmed = restarted.send_draft(Uuid::new_v4(), "agent", "session-one", "composer", 4, json!({})).await.unwrap();
        unconfirmed.prepare().await.unwrap();
        unconfirmed.disconnect().await.unwrap();
        assert!(matches!(restarted.recover(unconfirmed.id()).await.unwrap().receipt, Receipt::NotRecorded));
        assert_eq!(restarted.load_draft("agent", "session-one", "composer").await.unwrap().unwrap().text, "reject");
        let pending = restarted.pending_operations("agent", "session-one", "composer").await.unwrap();
        assert!(pending.is_empty());
        assert!(restarted.operation(unconfirmed.id()).await.unwrap().abandoned);
        restarted.close().await.unwrap();
        fixture.finish().await;
    }).await.unwrap();
}
