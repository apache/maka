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
use maka_agent_facts::artifact::content_digest;

pub(super) async fn upload(
    f: &Fixture,
    session: &str,
    name: &str,
    bytes: &[u8],
    operation: Uuid,
) -> Result<Value, String> {
    let file = f._dir.path().join(name);
    std::fs::write(&file, bytes).unwrap();
    let snapshot = maka_ui_support::file::read_selected(&file).unwrap();
    f.mutation_with(
        2,
        "uploadAttachment",
        json!({"sessionId":session,"name":name,"bytes":bytes.len(),"digest":content_digest(bytes)}),
        operation,
        BTreeMap::from([(
            "file".into(),
            snapshot as Arc<dyn maka_capabilities::call::ReadResource>,
        )]),
    )
    .await
}

#[tokio::test]
async fn large_selected_upload_keeps_complete_bytes_and_session_authority() {
    let f = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let session = f.create("Large selected upload").await;
    let bytes = vec![b'z'; 50 * 1024 * 1024 + 1];
    let file = f._dir.path().join("large.txt");
    std::fs::write(&file, &bytes).unwrap();
    let completed = async {
        let snapshot = maka_ui_support::file::read_selected(&file).map_err(|error| error.to_string())?;
        let uploaded = f.mutation_with(
            2, "uploadAttachment",
            json!({"sessionId":session,"name":"large.txt","bytes":bytes.len(),"digest":content_digest(&bytes)}),
            Uuid::new_v4(),
            BTreeMap::from([("file".into(), snapshot as Arc<dyn maka_capabilities::call::ReadResource>)]),
        ).await?;
        let id = uploaded["attachment"]["id"].as_str().ok_or("upload did not return an attachment")?;
        let record = f.session(&session).await.get_artifact(&session, id).await.map_err(|error| error.to_string())?.record.ok_or("upload did not retain its artifact")?;
        let tail = f.session(&session).await.read_artifact_chunk(&session, id, 50 * 1024 * 1024, 64).await.map_err(|error| error.to_string())?.ok_or("upload lost final bytes")?;
        Ok::<_, String>((uploaded, record, tail))
    }.await;
    f.drained().await;
    let app_shutdown = f.app.shutdown().await;
    let config_shutdown = f.config.shutdown().await;
    app_shutdown.unwrap();
    config_shutdown.unwrap();
    let (uploaded, record, tail) = completed.expect("selected upload must retain complete bytes");
    assert_eq!(uploaded["kind"], "uploaded");
    assert_eq!(uploaded["attachment"]["sessionId"], session);
    assert_eq!(record.size_bytes, 50 * 1024 * 1024 + 1);
    assert_eq!(record.summary, Some(content_digest(&bytes)));
    assert_eq!(tail.total_bytes, 50 * 1024 * 1024 + 1);
    assert_eq!(tail.bytes, b"z");
}

#[tokio::test]
async fn attachment_upload_send_queue_and_resource_read_keep_session_and_receipt_authority() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::with_services(&format!("http://{}/v1", listener.local_addr().unwrap()), None, None, Some(service_tools::Setup::files("readText"))).await;
        let session = f.create("Attachments").await;
        let other = f.create("Other conversation").await;
        let text = "uploaded text\n".repeat(1500);
        let operation = Uuid::new_v4();
        let uploaded = upload(&f, &session, "notes.md", text.as_bytes(), operation).await.unwrap();
        assert_eq!(uploaded["kind"], "uploaded");
        let attachment = uploaded["attachment"].clone();
        assert_eq!(attachment["sessionId"], session);
        assert_eq!(attachment["mimeType"], "text/markdown");
        assert_eq!(attachment["name"], "notes.md");
        let id = attachment["id"].as_str().unwrap();
        let record = f.session(&session).await.get_artifact(&session, id).await.unwrap().record.unwrap();
        assert_eq!(record.summary.as_deref(), Some(content_digest(text.as_bytes()).as_str()));
        assert!(upload(&f, &session, "notes.md", text.as_bytes(), operation).await.is_err(), "a recapture is not the original resource-bearing operation");
        let reference = f.store.application_intents(f.app.source().unwrap().deployment, super::id(2), 0, 16).await.unwrap().into_iter()
            .find(|intent| intent.reference.operation == operation).unwrap().reference;
        let client = f.app.client();
        let recovered = client.recover(client.activation(&super::id(2)).unwrap(), reference, scope(&f.issuer, true)).await.unwrap().unwrap();
        assert_eq!(recovered.outcome, OperationOutcome::Returned { value: uploaded.clone() });
        assert_eq!(f.session(&session).await.list_artifacts(&session, 0, 10).await.unwrap().records.len(), 1);
        assert_eq!(f.session(&session).await.get_artifact(&session, id).await.unwrap().record.unwrap(), record);
        f.store.create_session("foreign_session", "foreign", &json!({"foreign":true}), 1).await.unwrap();
        assert!(upload(&f, "foreign_session", "notes.md", text.as_bytes(), Uuid::new_v4()).await.is_err());
        for (target, ids) in [(&other, vec![id]), (&session, vec![id, id]), (&session, vec!["missing"])] {
            assert!(f.mutation(2, "send", json!({"sessionId":target,"message":"","attachments":ids,"model":f.selection().await}), Uuid::new_v4()).await.is_err());
        }
        let model = f.selection().await;
        let send = |body: &str| f.mutation(2, "send", json!({"sessionId":session,"message":body,"attachments":[id],"model":model}), Uuid::new_v4());
        assert_eq!(send("").await.unwrap()["kind"], "started");
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(sent.to_string().contains(id), "model receives the canonical resource reference: {sent}");
        assert!(!sent.to_string().contains(&text), "uploaded text is read on demand");
        let history = f.query("history", json!({"sessionId":session,"position":{"kind":"start"},"includeThinking":true})).await.unwrap();
        assert_eq!(history["kind"], "ready");
        let user = history["chunks"].as_array().unwrap().iter().find(|chunk| chunk["role"] == "user").unwrap();
        assert_eq!(user["attachments"][0]["name"], "notes.md");
        assert_eq!(user["attachments"][0]["mimeType"], "text/markdown");
        assert!(user["attachments"][0].get("ref").is_none(), "history descriptors confer no storage access");
        let queued = send("queued text").await.unwrap();
        assert_eq!(queued["kind"], "queued");
        let queue = f.session(&session).await.message_queue(&session).await.unwrap();
        let refs = queue.entries[0].source.unprepared_content.attachments.clone();
        let changed = f.mutation(2, "editQueue", json!({"sessionId":session,"expectedRevision":queue.revision,"edit":{"kind":"update","messageId":queued["messageId"],"message":""}}), Uuid::new_v4()).await.unwrap();
        assert_eq!(changed["kind"], "committed");
        let queue = f.session(&session).await.message_queue(&session).await.unwrap();
        assert_eq!(queue.entries[0].source.unprepared_content.attachments, refs);
        assert_eq!(queue.entries[0].source.message.content.attachments, refs);
        assert_eq!(queue.entries[0].source.unprepared_content.text, "");
        let body = f.query("queueMessage", json!({"sessionId":session,"messageId":queued["messageId"],"expectedRevision":queue.revision})).await.unwrap();
        assert_eq!(body["hasAttachments"], true);
        assert_eq!(body["message"], "");
        assert_eq!(f.owner.queue(&session).await.unwrap().entries[0].preview, "notes.md");
        // Real Files dispatch receives authority from this invocation, not the URI.
        files::tool_response(&mut socket, json!({"path":format!("attachment:{id}")})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let tool = sent["messages"].as_array().unwrap().iter().rev().find(|m| m["role"] == "tool").unwrap();
        let result: Value = serde_json::from_str(tool["content"].as_str().unwrap()).unwrap();
        assert_eq!(result["kind"], "completed", "{result}");
        assert!(result["value"]["content"].as_str().unwrap().starts_with("uploaded text"));
        let next: maka_agent_facts::read::ReadInput = serde_json::from_value(result["value"]["next"].clone()).unwrap();
        assert!(next.resolve().unwrap().path().contains(id));
        response(&mut socket).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(sent.to_string().contains(id));
        files::tool_response(&mut socket, serde_json::to_value(&next).unwrap()).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let tool = sent["messages"].as_array().unwrap().iter().rev().find(|m| m["role"] == "tool").unwrap();
        let continued: Value = serde_json::from_str(tool["content"].as_str().unwrap()).unwrap();
        assert_eq!(continued["kind"], "completed");
        assert!(continued["value"]["offset"].as_u64().unwrap() > 0);
        response(&mut socket).await;
        f.drained().await;
        assert_eq!(f.session(&session).await.read_artifact_chunk(&session, id, 0, 50 * 1024).await.unwrap().unwrap().bytes, text.as_bytes());
        f.send(&other).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        files::tool_response(&mut socket, json!({"path":format!("attachment:{id}")})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let tool = sent["messages"].as_array().unwrap().iter().rev().find(|m| m["role"] == "tool").unwrap();
        assert!(tool["content"].as_str().unwrap().contains("Attachment was not found"));
        assert!(!tool["content"].as_str().unwrap().contains("uploaded text"));
        response(&mut socket).await;
        f.drained().await;
        f.store.set_session_archived::<StoredSessionConfiguration>(&session, true, now()).await.unwrap();
        assert_eq!(upload(&f, &session, "notes.md", text.as_bytes(), Uuid::new_v4()).await.unwrap(), json!({"kind":"rejected","reason":"archived"}));
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn cancelled_attachment_upload_retains_resource_custody_until_worker_finishes() {
    struct Held {
        entered: Arc<Semaphore>,
        release: Arc<(StdMutex<bool>, std::sync::Condvar)>,
    }
    impl maka_capabilities::call::ReadResource for Held {
        fn resource_type(&self) -> maka_plugin_core::contract::ResourceType {
            maka_plugin_core::contract::binary_resource_type()
        }
        fn bytes(&self) -> usize {
            3
        }
        fn metadata(&self) -> Value {
            json!({})
        }
        fn read(&self, range: std::ops::Range<usize>) -> Result<Vec<u8>, String> {
            self.entered.add_permits(1);
            let (lock, changed) = &*self.release;
            let _released = changed
                .wait_while(lock.lock().unwrap(), |released| !*released)
                .unwrap();
            Ok(b"abc"[range].to_vec())
        }
    }
    struct Release(Arc<(StdMutex<bool>, std::sync::Condvar)>);
    impl Drop for Release {
        fn drop(&mut self) {
            *self.0.0.lock().unwrap() = true;
            self.0.1.notify_all();
        }
    }
    tokio::time::timeout(Duration::from_secs(30), async {
        let f = Fixture::new("http://127.0.0.1:9/v1", None).await;
        let session = f.create("Upload lifetime").await;
        let release = Release(Arc::new((StdMutex::new(false), std::sync::Condvar::new())));
        let entered = Arc::new(Semaphore::new(0));
        let resource = Arc::new(Held { entered: entered.clone(), release: release.0.clone() });
        let original = scope(&f.issuer, true);
        let cancellation = original.cancellation.clone();
        let resources = original.resources.clone();
        let client = f.app.client();
        let prepared = client.prepare_mutation(f.binding(2).await, "uploadAttachment".into(),
            json!({"sessionId":session,"name":"held.txt","bytes":3,"digest":content_digest(b"abc")}),
            original, Uuid::new_v4(), BTreeMap::from([("file".into(), resource as Arc<dyn maka_capabilities::call::ReadResource>)]).into()).await.unwrap();
        let recorded = f.store.record_application_intent(prepared.reference().source.clone(), prepared.consumer().instance().clone(), prepared.reference().clone(), serde_json::Value::Null).await.unwrap();
        let mutation = client.mutate(prepared, recorded).await.unwrap();
        entered.acquire().await.unwrap().forget();
        cancellation.cancel();
        assert!(!resources.seal().unwrap());
        drop(release);
        assert!(mutation.completion().await.cleanup.is_ok());
        resources.finish().await.unwrap();
        assert!(f.session(&session).await.list_artifacts(&session, 0, 10).await.unwrap().records.is_empty());
        assert_eq!(upload(&f, &session, "after.txt", b"after", Uuid::new_v4()).await.unwrap()["kind"], "uploaded");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}
