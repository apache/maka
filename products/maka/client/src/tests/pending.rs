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
use maka_capabilities::call::ReadResource;
use std::ops::Range;

struct SelectedBytes {
    name: &'static str,
    bytes: Vec<u8>,
}

impl ReadResource for SelectedBytes {
    fn resource_type(&self) -> maka_plugin_core::contract::ResourceType {
        maka_plugin_core::contract::binary_resource_type()
    }

    fn bytes(&self) -> usize {
        self.bytes.len()
    }

    fn metadata(&self) -> Value {
        json!({"name":self.name,"bytes":self.bytes.len()})
    }

    fn read(&self, range: Range<usize>) -> Result<Vec<u8>> {
        self.bytes
            .get(range)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| "invalid selected byte range".into())
    }
}

#[tokio::test]
async fn pending_drafts_reopen_without_host_mutations_and_preserve_content_on_stale_saves() {
    let fixture = Fixture::new().await;
    let client = fixture.client().await;
    let id = Uuid::new_v4().to_string();
    let state = json!({"text":"UNSENT_RESTART_TEXT","files":[id]});
    let revision = client
        .save_pending_draft(
            0,
            state.clone(),
            vec![id.clone()],
            vec![PendingFile {
                id: id.clone(),
                resource: Arc::new(SelectedBytes {
                    name: "selected.bin",
                    bytes: b"kkk".to_vec(),
                }),
            }],
        )
        .await
        .unwrap();
    assert_eq!(revision, 1);
    client.close().await.unwrap();
    drop(client);

    let reopened = fixture.client().await;
    assert_eq!(reopened.pending_draft().await.unwrap(), (1, state.clone()));
    let saved = reopened.pending_file(&id).await.unwrap();
    assert_eq!((saved.name.as_str(), saved.bytes), ("selected.bin", 3));
    assert_eq!(reopened.pending_file_chunk(&id, 0).await.unwrap(), b"kkk");
    let error = reopened
        .save_pending_draft(0, Value::Null, vec![], vec![])
        .await
        .unwrap_err();
    assert_eq!(
        error,
        "The desktop draft changed in another window. Reopen it before editing."
    );
    assert_eq!(reopened.pending_draft().await.unwrap(), (1, state));
    assert_eq!(reopened.pending_file_chunk(&id, 0).await.unwrap(), b"kkk");
    reopened
        .save_pending_draft(1, Value::Null, vec![], vec![])
        .await
        .unwrap();
    assert_eq!(reopened.pending_draft().await.unwrap(), (2, Value::Null));
    assert!(reopened.pending_file(&id).await.is_err());
    assert!(reopened.pending_file_chunk(&id, 0).await.is_err());
    assert_eq!(fixture.counter.effects.load(Ordering::SeqCst), 0);
    reopened.close().await.unwrap();
    fixture.finish().await;
}

#[tokio::test]
async fn pending_drafts_restore_distinct_chunks_and_the_final_partial_chunk() {
    let fixture = Fixture::new().await;
    let client = fixture.client().await;
    let document = Uuid::new_v4().to_string();
    let second = Uuid::new_v4().to_string();
    let ids = vec![document.clone(), second.clone()];
    let state = json!({"text":"COMPLETE_DRAFT","files":ids});
    let content = [vec![b'a'; 65536], vec![b'b'; 65536], b"end".to_vec()].concat();
    client
        .save_pending_draft(
            0,
            state.clone(),
            ids,
            vec![
                PendingFile {
                    id: document.clone(),
                    resource: Arc::new(SelectedBytes {
                        name: "document.bin",
                        bytes: content,
                    }),
                },
                PendingFile {
                    id: second.clone(),
                    resource: Arc::new(SelectedBytes {
                        name: "second.bin",
                        bytes: b"second attachment".to_vec(),
                    }),
                },
            ],
        )
        .await
        .unwrap();
    client.close().await.unwrap();
    drop(client);

    let reopened = fixture.client().await;
    assert_eq!(reopened.pending_draft().await.unwrap(), (1, state));
    let metadata = reopened.pending_file(&document).await.unwrap();
    assert_eq!(
        (metadata.name.as_str(), metadata.bytes),
        ("document.bin", 131075)
    );
    assert_eq!(
        reopened.pending_file_chunk(&document, 0).await.unwrap(),
        vec![b'a'; 65536]
    );
    assert_eq!(
        reopened.pending_file_chunk(&document, 65536).await.unwrap(),
        vec![b'b'; 65536]
    );
    assert_eq!(
        reopened
            .pending_file_chunk(&document, 131072)
            .await
            .unwrap(),
        b"end"
    );
    assert_eq!(
        reopened.pending_file_chunk(&second, 0).await.unwrap(),
        b"second attachment"
    );
    assert_eq!(fixture.counter.effects.load(Ordering::SeqCst), 0);
    reopened.close().await.unwrap();
    fixture.finish().await;
}
