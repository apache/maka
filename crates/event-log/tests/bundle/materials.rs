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

use maka_event_log::{
    EventLog, StoreError,
    bundle::{self, BundleError, StagedBundle},
    sessions::SessionCopy,
};
use maka_runtime::{
    capability::{CallResult, ContentBlock},
    event::{EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent},
    session::CopyPurpose,
    tool_call::ToolCallIdentity,
    tool_output::{ToolOutput, ToolSuccess},
};
use serde_json::{Value, json};
use sqlx::Connection;

pub(super) async fn verify_nested_copy(log: &EventLog) {
    let revision = log
        .get_session::<Value>("branch")
        .await
        .unwrap()
        .unwrap()
        .revision;
    log.copy_session(
        SessionCopy {
            source_session_id: "branch".into(),
            target_session_id: "nested".into(),
            expected_source_revision: revision,
            purpose: CopyPurpose::Branch {
                turn_id: None,
                side_conversation: false,
            },
        },
        &json!({}),
        3,
    )
    .await
    .unwrap();
    let inventory = log.preview_bundle("nested").await.unwrap();
    let (bytes, report) = log
        .export_bundle("nested", &inventory.subtree_digest, Vec::new())
        .await
        .unwrap();
    let records = super::frames::records(&bytes, &report.digest);
    assert_eq!(records.iter().filter(|r| r["kind"] == "copy").count(), 2);
    assert_eq!(records.iter().filter(|r| r["kind"] == "session").count(), 1);
    let mut staged = StagedBundle::read(bytes.as_slice()).await.unwrap();
    staged.validate_history().await.unwrap();
    staged.close().await.unwrap();
    let mut changed = false;
    let unpinned = super::frames::rewrite_records(&bytes, |record| {
        if record["kind"] == "member"
            && record["session"] == "nested"
            && !record["archive_sequence"].is_null()
        {
            record["archive_sequence"] = Value::Null;
            changed = true;
        }
        true
    });
    assert!(changed);
    bundle::inspect(unpinned.as_slice()).await.unwrap();
    let mut staged = StagedBundle::read(unpinned.as_slice()).await.unwrap();
    let error = staged.validate_history().await;
    assert!(
        matches!(error, Err(BundleError::Store(StoreError::InvalidTransition(ref message)))
        if message == "copy archive pin differs from its source projection"),
        "{error:?}"
    );
    staged.close().await.unwrap();
    let forged = super::frames::rewrite_records(&bytes, |record| {
        if record["kind"] == "copy" && record["request"]["targetSessionId"] == "nested" {
            record["request"]["sourceSessionId"] = json!("unrelated-parent");
            record["lineage"]["origin"]["parent_session_id"] = json!("unrelated-parent");
        }
        true
    });
    bundle::inspect(forged.as_slice()).await.unwrap();
    let mut staged = StagedBundle::read(forged.as_slice()).await.unwrap();
    let error = staged.validate_history().await;
    assert!(
        matches!(error, Err(BundleError::Store(StoreError::InvalidTransition(ref message)))
        if message == "bundle member is outside its declared source history"
            || message == "copy archive pin differs from its source projection"),
        "{error:?}"
    );
    staged.close().await.unwrap();
}

#[tokio::test]
async fn generated_media_remain_required_material_not_deletable_upload_references() {
    let dir = tempfile::tempdir().unwrap();
    let log = EventLog::open(&dir.path().join("events.sqlite"))
        .await
        .unwrap();
    log.create_session("images", "images", &json!({}), 1)
        .await
        .unwrap();
    let invocation = Invocation {
        session_id: "images".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let event = |fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap();
    log.append(&event(Fact::InvocationOpened {
        input: InvocationInput::Code {
            source: "images".into(),
        },
        configuration: None,
    }))
    .await
    .unwrap();
    let outputs = [
        ToolSuccess::image(b"\x89PNG\r\n\x1a\n".to_vec(), "image/png".into()).unwrap(),
        ToolOutput::Mcp(CallResult {
            content: vec![ContentBlock::Image {
                data: "iVBORw0KGgo=".into(),
                mime_type: "image/png".into(),
            }],
            structured_content: None,
        })
        .into(),
        ToolOutput::Mcp(CallResult {
            content: vec![ContentBlock::Audio {
                data: "SUQzAAAA".into(),
                mime_type: "audio/mpeg".into(),
            }],
            structured_content: None,
        })
        .into(),
    ];
    for (index, output) in outputs.into_iter().enumerate() {
        let operation = format!("image-{index}");
        log.append(&event(Fact::ToolDispatched {
            operation_id: operation.clone(),
            call: ToolCallIdentity::standalone(operation.clone()),
            name: "Read".into(),
            input: json!({}),
        }))
        .await
        .unwrap();
        let (write, _) = EventWrite::tool_success(
            format!("result-{index}"),
            std::time::SystemTime::now(),
            invocation.clone(),
            operation,
            output,
        )
        .unwrap();
        log.append(&write).await.unwrap();
    }
    log.append(&event(Fact::InvocationEnded {
        outcome: InvocationOutcome::Completed,
    }))
    .await
    .unwrap();
    let inventory = log.preview_bundle("images").await.unwrap();
    let (bytes, _) = log
        .export_bundle("images", &inventory.subtree_digest, Vec::new())
        .await
        .unwrap();
    let mut staged = StagedBundle::read(bytes.as_slice()).await.unwrap();
    staged.validate_history().await.unwrap();
    staged.close().await.unwrap();
    for remove in [true, false] {
        let damaged = super::frames::rewrite_records(&bytes, |record| {
            if record["kind"] == "blob" && record["resource"] == "artifact" {
                if remove {
                    return false;
                }
                record["metadata"]["kind"] = json!("file");
            }
            true
        });
        bundle::inspect(damaged.as_slice()).await.unwrap();
        let mut staged = StagedBundle::read(damaged.as_slice()).await.unwrap();
        let error = staged.validate_history().await;
        let expected = if remove {
            "bundle lacks generated tool material"
        } else {
            "bundle generated tool material differs from its canonical evidence"
        };
        assert!(
            matches!(error, Err(BundleError::Store(StoreError::InvalidTransition(ref message))) if message == expected),
            "{error:?}"
        );
        staged.close().await.unwrap();
    }
    let mut corrupt = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(dir.path().join("events.sqlite")),
    )
    .await
    .unwrap();
    sqlx::query("DELETE FROM artifacts")
        .execute(&mut corrupt)
        .await
        .unwrap();
    corrupt.close().await.unwrap();
    let error = log
        .export_bundle("images", &inventory.subtree_digest, Vec::new())
        .await;
    assert!(
        matches!(error, Err(BundleError::Store(StoreError::InvalidTransition(ref message))) if message == "bundle lacks generated tool material"),
        "{error:?}"
    );
    log.close().await.unwrap();
}
