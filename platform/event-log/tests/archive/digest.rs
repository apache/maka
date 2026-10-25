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
use sha2::{Digest, Sha256};

#[tokio::test]
async fn effective_digest_covers_archives_beyond_the_first_page() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("digest.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    open(&log, "history", false).await;
    let mut archives = Vec::new();
    for index in 0..129 {
        let result = tool(&log, "history", &format!("step-{index}"), "x".repeat(8192)).await;
        archives.push(archive("writer", &result));
    }
    end(&log, "history").await;
    open(&log, "writer", false).await;
    for archived in &archives {
        log.append(archived).await.unwrap();
    }
    let after = log
        .capture_model_context("session", Some("writer"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    let archived: Vec<_> = after
        .tail
        .iter()
        .filter_map(|entry| match entry {
            ContextEvent::Archived(entry) => Some(entry),
            _ => None,
        })
        .collect();
    assert_eq!(archived.len(), 129);
    // Check the durable digest contract against the exact append inputs and
    // exposed replacements, including the record past the old page boundary.
    let mut hash = Sha256::new();
    hash.update(b"maka.effective-context.v1\0");
    hash.update(after.source_evidence.digest.as_bytes());
    hash.update(Sha256::digest(b"maka.archive.copy.v1\0"));
    for (actual, written) in archived.iter().zip(&archives) {
        let Fact::ToolResultArchived { placeholder } = &written.event().fact else {
            panic!()
        };
        assert_eq!(actual.event_id, placeholder.identity.runtime_event_id);
        assert_eq!(
            actual.replacement,
            placeholder.to_canonical_projection().unwrap()
        );
    }
    assert_eq!(
        after.effective_source_digest,
        format!("sha256:{}", hex::encode(hash.finalize()))
    );
    end(&log, "writer").await;
    let revision = log
        .get_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap()
        .revision;
    assert!(matches!(
        log.copy_session(
            maka_event_log::sessions::SessionCopy {
                source_session_id: "session".into(),
                target_session_id: "copy".into(),
                expected_source_revision: revision,
                purpose: maka_agent_facts::session::CopyPurpose::Branch {
                    turn_id: Some("history".into()),
                    side_conversation: false,
                },
            },
            &json!({}),
            2,
        )
        .await
        .unwrap(),
        maka_event_log::sessions::SessionCopyResult::Committed(_)
    ));
    let writer = event(
        "copy-writer",
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: Vec::new(),
                content: "question".into(),
                request_fingerprint: None,
            },
        },
    );
    let mut writer = writer.event().clone();
    writer.invocation.session_id = "copy".into();
    log.append(&EventWrite::plain(writer.clone()).unwrap())
        .await
        .unwrap();
    log.capture_model_context("copy", Some("copy-writer"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    // A newly submitted duplicate remains an admission error even though old
    // accepted archives no longer reauthenticate their source payloads.
    let duplicate = RuntimeEvent::new(writer.invocation, archives[127].event().fact.clone());
    assert!(
        log.append(&EventWrite::plain(duplicate).unwrap())
            .await
            .is_err()
    );
    let copied = log
        .capture_model_context("copy", Some("copy-writer"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(
        copied
            .tail
            .iter()
            .filter(|row| matches!(row, ContextEvent::Archived(_)))
            .count(),
        129
    );
    log.close().await.unwrap();
}
