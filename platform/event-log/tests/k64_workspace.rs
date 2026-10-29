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

use maka_event_log::EventLog;
use serde_json::{Value, json};

#[tokio::test]
async fn complete_workspace_membership_and_session_configuration_survive_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("events.sqlite");
    let cwd = temp
        .path()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let log = EventLog::open(&path).await.unwrap();
    let binding = log
        .attach_workspace("workspace-test", &json!({"path":cwd}))
        .await
        .unwrap();
    for index in 0..257 {
        log.create_session(
            &format!("session-{index:03}"),
            &format!("create-{index}"),
            &json!({"workspace":binding,"boundary_revision":0,"name":format!("Session {index}")}),
            1,
        )
        .await
        .unwrap();
    }
    let fence = log.workspace_fence(&cwd).await;
    let large = json!({"workspace":binding,"boundary_revision":0,"original":"original-config-🦀".repeat(6000)});
    let created = log
        .create_session("large-session", "large-original", &large, 2)
        .await;
    log.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    let restored = reopened
        .get_session::<Value>("large-session")
        .await
        .unwrap();
    let other = reopened
        .workspace_has_other_session(&cwd, "session-000")
        .await
        .unwrap();
    reopened.close().await.unwrap();
    assert!(other, "other original Sessions still own the workspace");
    let fence = fence.expect("complete original workspace membership");
    assert_eq!(
        fence
            .0
            .iter()
            .map(|entry| entry.session_id.clone())
            .collect::<Vec<_>>(),
        (0..257)
            .map(|i| format!("session-{i:03}"))
            .collect::<Vec<_>>()
    );
    assert!(
        created.is_ok(),
        "complete Session configuration refused: {created:?}"
    );
    assert_eq!(restored.unwrap().configuration, large);
}

#[tokio::test]
async fn complete_structured_history_selectors_keep_deep_and_long_original_keys() {
    use maka_agent_facts::import::{Content, Record, Source};
    use maka_agent_ports::session::history::{
        Position, SourceField, SourcePosition, SourceSegment,
    };
    use maka_capabilities::storage::Namespace;
    use maka_event_log::sessions::PluginSession;
    use maka_plugin_core::scope::Scope;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("source.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let long = "original-key-".repeat(24);
    let mut nested = json!("original selected raw bytes 🦀");
    for index in (0..16).rev() {
        nested = json!({format!("k{index}"):nested});
    }
    let input = json!({long.clone():"original selected raw bytes 🦀","deep":nested});
    let owner = PluginSession {
        session_id: "original".into(),
        creator: Namespace::new("k64.fixture", Scope::Profile).unwrap(),
        fingerprint: "original-import".into(),
        managed: false,
        authority_session_id: None,
    };
    let records = vec![
        Content::User {
            text: "Inspect original data".into(),
        },
        Content::ToolCall {
            call_id: "call".into(),
            name: "Original".into(),
            input: Some(input.clone()),
        },
        Content::ToolResult {
            call_id: "call".into(),
            output: json!("done"),
            is_error: false,
        },
    ]
    .into_iter()
    .enumerate()
    .map(|(i, content)| Record {
        source_message_id: format!("m{i}"),
        source_turn_id: "turn".into(),
        timestamp: Some(1),
        content,
    })
    .collect();
    log.import_session(
        &owner,
        &Source {
            adapter: "fixture".into(),
            session_id: "source".into(),
        },
        &json!({}),
        records,
        1,
    )
    .await
    .unwrap();
    let through = *log.subscribe_commits().borrow();
    log.history_text(
        "original",
        through,
        Position::Start,
        false,
        maka_event_log::transcript::HistoryLimits {
            max_bytes: 8192,
            max_chunks: Some(8),
            max_json_bytes: 65536,
        },
    )
    .await
    .unwrap();
    let headers = log
        .transcript_headers(
            "original",
            &maka_event_log::transcript::TranscriptRead {
                through,
                position: None,
                direction: maka_event_log::transcript::TranscriptDirection::Newer,
                limit: 16,
            },
        )
        .await
        .unwrap();
    let mut locator = None;
    for header in headers {
        let value: Value = serde_json::from_slice(
            &log.transcript_fragment("original", header.position, 0, header.total_bytes)
                .await
                .unwrap(),
        )
        .unwrap();
        if value["type"] == "tool_call" {
            locator = Some(header.position);
            break;
        }
    }
    let locator = locator.expect("imported tool call must be readable");
    let mut deep = vec![SourceSegment::Key("deep".into())];
    deep.extend((0..16).map(|i| SourceSegment::Key(format!("k{i}"))));
    let mut results = Vec::new();
    for selected in [deep, vec![SourceSegment::Key(long)]] {
        results.push(
            log.history_source(
                "original",
                through,
                maka_event_log::transcript::SourceSelection {
                    locator,
                    field: SourceField::Arguments,
                    path: Some(selected),
                },
                SourcePosition::Start,
                4096,
            )
            .await,
        );
    }
    log.close().await.unwrap();
    for (index, result) in results.into_iter().enumerate() {
        let selected = result.unwrap_or_else(|error| panic!("selector{index}: {error}"));
        assert_eq!(
            selected.format,
            maka_agent_ports::session::history::SourceFormat::Text
        );
        assert_eq!(selected.text, "original selected raw bytes 🦀");
    }
}
