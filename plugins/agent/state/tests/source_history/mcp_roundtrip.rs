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

use crate::support::{self, imported::Tape};
use maka_agent_facts::{
    artifact::ToolReturn,
    capability::{CallResult, ContentBlock},
    history_snapshot::{
        Entry, HistoricalRole, ImportedArtifactScope, ImportedMessage, ImportedPart,
        ImportedTurnOrdinal, SnapshotId,
    },
    tool_output::{DurableToolProjection, ReturnedToolResult, ToolOutput},
};
use maka_agent_state::session_history::snapshot::ImportedCaptureRequest;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn typed_mcp_blocks_and_missing_vs_null_structured_values_survive_frozen_archive() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let state = support::state(&root);
    let history = state.session_history(support::owner(), "session".into());
    let mut tape = Tape::new();
    let raw = tape.push_blob(b"original MCP source");
    let content = vec![
        ContentBlock::Text {
            text: "汉🦀\n".into(),
        },
        ContentBlock::Audio {
            data: "AQIDBA==".into(),
            mime_type: "audio/wav".into(),
        },
        ContentBlock::Image {
            data: "noncanonical base64".into(),
            mime_type: "image/png".into(),
        },
        ContentBlock::Resource {
            uri: "resource://original".into(),
            mime_type: Some("application/octet-stream".into()),
            text: Some("same text".into()),
            blob: Some("AQIDBA==".into()),
        },
        ContentBlock::Unknown {
            value: serde_json::json!({"provider":"extra","numeric":1.25}),
        },
    ];
    let mut originals = vec![];
    for (ordinal, structured_content) in [
        None,
        Some(serde_json::Value::Null),
        Some(serde_json::json!({"numeric":1.25,"nested":[true,null,"汉"]})),
    ]
    .into_iter()
    .enumerate()
    {
        let output = ToolOutput::Mcp(CallResult {
            content: content.clone(),
            structured_content,
        });
        let part = tape.push_json(&ImportedPart::ToolReturn {
            call_id: format!("foreign-call-{ordinal}"),
            name: "fixture.mcp".into(),
            result: ToolReturn {
                schema_version: maka_agent_facts::durable::SCHEMA_VERSION,
                artifacts: vec![],
                body: ReturnedToolResult {
                    output: output.clone(),
                    projection: DurableToolProjection::Text {
                        text: "model summary".into(),
                    },
                    is_error: false,
                    loaded_tools: Default::default(),
                },
            },
        });
        let message = ImportedMessage {
            turn_ordinal: ImportedTurnOrdinal(0),
            original_ordinal: 0,
            media: vec![],
            source_message_id: Some(format!("foreign-message-{ordinal}")),
            source_turn_id: None,
            timestamp: Some(1),
            role: HistoricalRole::Tool,
            artifact_scope: ImportedArtifactScope {
                owner: support::owner(),
                session: "session".into(),
            },
            parts: vec![part.clone()],
            provider_metadata: None,
            original: raw.clone(),
        };
        let body = tape.push_json(&message);
        tape.push_entry(&Entry::Imported {
            ordinal: ordinal as u64,
            message: body,
        });
        originals.push((ordinal as u64, part, output));
    }
    let fingerprint = tape.original_source(
        vec![raw],
        maka_agent_facts::artifact::content_digest(b"original MCP source"),
    );
    let id = SnapshotId::try_from(uuid::Uuid::new_v4()).unwrap();
    let snapshot = tape
        .capture(
            &history,
            ImportedCaptureRequest {
                id,
                source: maka_agent_facts::import::Source {
                    adapter: "fixture".into(),
                    session_id: "foreign".into(),
                },
                fingerprint,
            },
            CancellationToken::new(),
        )
        .await;
    let exported = snapshot
        .export(tempfile::tempfile().unwrap())
        .await
        .unwrap();
    let target_dir = tempfile::tempdir().unwrap();
    let target_root = support::open(target_dir.path(), false).await;
    support::create(&target_root, "target").await;
    let target = support::state(&target_root);
    let target_history = target.session_history(support::owner(), "target".into());
    let imported = target_history
        .import_snapshot(
            uuid::Uuid::new_v4(),
            exported.history,
            exported.file,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    root.close().await.unwrap();
    for (ordinal, part, output) in originals {
        let actual: ImportedPart = imported
            .with_imported_content(ordinal, &part, |reader| {
                Ok(serde_json::from_reader(reader)?)
            })
            .await
            .unwrap();
        let ImportedPart::ToolReturn { result, .. } = actual else {
            panic!("original typed MCP result")
        };
        assert_eq!(result.body.output, output);
    }
    target_root.close().await.unwrap();
}
