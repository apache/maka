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

#[tokio::test]
async fn new_composer_survives_reopen_keeps_files_on_typing_and_rejects_stale_edits() {
    let fixture = Fixture::new().await;
    let client = fixture.client().await;
    let value = json!({"recent":["/project"],"draft":{"text":"first draft"}});
    assert_eq!(client.load_composer().await.unwrap().revision, 0);
    let revision = client
        .save_composer(
            0,
            value,
            Some(vec![ComposerFile {
                name: "selected.txt".into(),
                contents: b"selected bytes".to_vec(),
            }]),
        )
        .await
        .unwrap();
    client.close().await.unwrap();
    let client = fixture.client().await;
    let restored = client.load_composer().await.unwrap();
    assert_eq!(restored.value["draft"]["text"], "first draft");
    assert_eq!(restored.files[0].contents, b"selected bytes");
    let changed = json!({"recent":["/project"],"draft":{"text":"edited after restart"}});
    let revision = client
        .save_composer(revision, changed.clone(), None)
        .await
        .unwrap();
    assert!(
        client
            .save_composer(restored.revision, Value::Null, Some(vec![]))
            .await
            .is_err()
    );
    let kept = client.load_composer().await.unwrap();
    assert_eq!(kept.value, changed);
    assert_eq!(kept.files[0].name, "selected.txt");
    assert_eq!(kept.files[0].contents, b"selected bytes");
    client
        .save_composer(
            revision,
            json!({"recent":["/project"],"draft":null}),
            Some(vec![]),
        )
        .await
        .unwrap();
    assert!(client.load_composer().await.unwrap().files.is_empty());
    client.close().await.unwrap();
    fixture.finish().await;
}

#[tokio::test]
async fn composer_memory_is_scoped_to_the_admitted_host() {
    let first = Fixture::new().await;
    let second = Fixture::new().await;
    let client = first.client().await;
    client
        .save_composer(0, json!({"draft":"first Host only"}), None)
        .await
        .unwrap();
    let host = HostClient::connect(&second.address, Some(second.host.epoch()))
        .await
        .unwrap();
    let journal = Journal::open(&first.directory.path().join("client.db"))
        .await
        .unwrap();
    let other = Client::new(host, journal, "receipts".into()).unwrap();
    assert!(other.load_composer().await.unwrap().value.is_null());
    other
        .save_composer(0, json!({"draft":"second Host only"}), None)
        .await
        .unwrap();
    assert_eq!(
        client.load_composer().await.unwrap().value["draft"],
        "first Host only"
    );
    client.close().await.unwrap();
    other.close().await.unwrap();
    first.finish().await;
    second.finish().await;
}
