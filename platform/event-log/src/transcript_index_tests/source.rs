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
use maka_agent_facts::import::Content;
use maka_agent_facts::import::Record;
use maka_agent_facts::import::Source;

use maka_agent_ports::session::history::SourceField;
use maka_agent_ports::session::history::SourceFormat;
use maka_agent_ports::session::history::SourcePosition;
use maka_agent_ports::session::history::SourceRole;
use maka_capabilities::storage::Namespace;
use maka_plugin_core::scope::Scope;

#[tokio::test]
async fn failure_search_reads_original_diagnostic_fields_and_visible_body() {
    let dir = tempfile::tempdir().unwrap();
    let log = EventLog::open(&dir.path().join("failure.sqlite"))
        .await
        .unwrap();
    log.create_session("failed", "create-failed", &serde_json::json!({}), 1)
        .await
        .unwrap();
    log.append(&event("failed", opening())).await.unwrap();
    let message = format!("failure-hit a... é Straße {}", "中😀\n".repeat(2000));
    let through = end(
        &log,
        "failed",
        InvocationOutcome::Failed {
            model_failure: None,
            class: "failure-class-hit".into(),
            message: Some(message.clone()),
        },
    )
    .await;

    // The first '..' touches 'a'; the overlapping second occurrence is valid.
    // Simple case folding does not normalize é or expand ß into SS.
    for (query, count) in [
        ("..", 1),
        ("é", 1),
        ("e\u{301}", 0),
        ("straße", 1),
        ("STRASSE", 0),
    ] {
        let result = log
            .search_transcript(
                "failed",
                maka_event_log::transcript::search::TranscriptSearch {
                    through,
                    after: None,
                    query: query.into(),
                    case_sensitive: false,
                    whole_word: true,
                    include_internal: false,
                    max_matches: 16,
                },
            )
            .await
            .unwrap();
        assert_eq!(result.matches.len(), count, "{query}");
        if count == 1 {
            assert_eq!(result.matches[0].field, SourceField::FailureMessage);
            assert!(
                result.matches[0]
                    .preview
                    .starts_with("failure-hit a... é Straße ")
            );
        }
        assert_eq!(result.next_after, None);
    }
    for (query, field, expected) in [
        // The original transcript intentionally limits displayed failure messages
        // to 256 UTF-8 bytes; source reads preserve that same searchable field.
        (
            "failure-hit",
            SourceField::FailureMessage,
            message[..message.floor_char_boundary(256)].to_owned(),
        ),
        (
            "failure-class-hit",
            SourceField::ErrorClass,
            "failure-class-hit".into(),
        ),
    ] {
        let result = log
            .search_transcript(
                "failed",
                maka_event_log::transcript::search::TranscriptSearch {
                    through,
                    after: None,
                    query: query.into(),
                    case_sensitive: true,
                    whole_word: false,
                    include_internal: false,
                    max_matches: 16,
                },
            )
            .await
            .unwrap();
        assert_eq!(result.matches.len(), 1);
        let hit = &result.matches[0];
        assert_eq!(hit.field, field);
        let mut collected = String::new();
        let mut position = SourcePosition::Start;
        for _ in 0..16 {
            let page = log
                .history_source(
                    "failed",
                    through,
                    maka_event_log::transcript::SourceSelection {
                        locator: hit.position,
                        field,
                        path: None,
                    },
                    position,
                    31,
                )
                .await
                .unwrap();
            assert_eq!(page.position, hit.position);
            assert_eq!(page.field, field);
            assert_eq!(page.role, SourceRole::Failure);
            assert_eq!(
                page.fields,
                [
                    SourceField::Body,
                    SourceField::ErrorClass,
                    SourceField::FailureMessage
                ]
            );
            assert_eq!(page.format, SourceFormat::Text);
            assert!(page.tool.is_none());
            collected.push_str(&page.text);
            let offset = page.offset + page.text.len() as u64;
            if offset == page.total_bytes {
                break;
            }
            position = SourcePosition::After { offset };
        }
        assert_eq!(collected, expected);
        let body = log
            .history_source(
                "failed",
                through,
                maka_event_log::transcript::SourceSelection {
                    locator: hit.position,
                    field: SourceField::Body,
                    path: None,
                },
                SourcePosition::Start,
                8192,
            )
            .await
            .unwrap();
        assert_eq!(body.role, SourceRole::Failure);
        assert_eq!(body.text, message[..message.floor_char_boundary(256)]);
        assert!(
            log.history_source(
                "failed",
                through - 1,
                maka_event_log::transcript::SourceSelection {
                    locator: hit.position,
                    field,
                    path: None
                },
                SourcePosition::Start,
                8192
            )
            .await
            .is_err()
        );
    }
    log.shutdown().await.unwrap();
}

#[tokio::test]
async fn structured_sources_select_original_values_without_aliasing_keys_or_authority() {
    use maka_agent_ports::session::history::SourceSegment::Index;
    use maka_agent_ports::session::history::SourceSegment::Key;
    let dir = tempfile::tempdir().unwrap();
    let database = dir.path().join("structured.sqlite");
    let log = EventLog::open(&database).await.unwrap();
    let text = "中😀\0\r\n".repeat(3);
    let long_key = "original-key-".repeat(24);
    let mut nested = serde_json::json!("original selected raw bytes 🦀");
    let mut deep_path = vec![Key("deep".into())];
    for index in (0..16).rev() {
        nested = serde_json::json!({format!("k{index}"): nested});
    }
    deep_path.extend((0..16).map(|index| Key(format!("k{index}"))));
    let value = serde_json::json!({
        long_key.clone(): "original selected raw bytes 🦀", "deep":nested,
        "content":text, "array":[{"0":"object key", "":true}],
        "a.\"\\/\0key":{"value":u64::MAX}, "empty":"", "nil":null,
        "boolean":false, "number":1.2345678901234567, "object":{"x":1}
    });
    let owner = maka_event_log::sessions::PluginSession {
        session_id: "structured".into(),
        creator: Namespace::new("source.fixture", Scope::Profile).unwrap(),
        fingerprint: "structured-import".into(),
        managed: false,
        authority_session_id: None,
    };

    log.import_session(
        &owner,
        &Source {
            adapter: "fixture".into(),
            session_id: "foreign".into(),
        },
        &serde_json::json!({}),
        [
            Content::User {
                text: "Inspect structured tool fields".into(),
            },
            Content::ToolCall {
                call_id: "call".into(),
                name: "Arbitrary alias".into(),
                input: Some(value.clone()),
            },
            Content::ToolResult {
                call_id: "call".into(),
                output: value.clone(),
                is_error: false,
            },
        ]
        .into_iter()
        .enumerate()
        .map(|(i, content)| Record {
            source_message_id: format!("row-{i}"),
            source_turn_id: "turn".into(),
            timestamp: Some(1),
            content,
        })
        .collect(),
        1,
    )
    .await
    .unwrap();

    let through = *log.subscribe_commits().borrow();

    log.transcript_between_turns(
        "structured",
        through,
        RowPosition {
            source_sequence: through,
            item_index: 0,
        },
    )
    .await
    .unwrap();
    let sequences = crate::test_store::inspect_cache(&log, |db| db.prepare("SELECT source_sequence, item_index FROM transcript_directory WHERE session_id='structured' AND role IN ('tool_call','tool_result') ORDER BY source_sequence, item_index").unwrap().query_map([], |row| Ok(RowPosition { source_sequence: row.get::<_, i64>(0)? as u64, item_index: row.get::<_, i64>(1)? as u64 })).unwrap().collect::<Result<Vec<_>,_>>().unwrap()).await;
    assert_eq!(sequences.len(), 2);
    let (sequence, field) = (sequences[1], SourceField::Result);
    let source = log
        .history_source(
            "structured",
            through,
            maka_event_log::transcript::SourceSelection {
                locator: sequence,
                field,
                path: Some(vec![Key("content".into())]),
            },
            SourcePosition::Start,
            8192,
        )
        .await
        .unwrap();
    assert_eq!(source.path, Some(vec![Key("content".into())]));
    assert_eq!(source.position, sequence);
    assert_eq!(source.field, field);
    assert_eq!(source.format, SourceFormat::Text);
    assert_eq!(source.total_bytes, text.len() as u64);
    assert_eq!(source.text, text);
    for (path, expected, format) in [
        (
            vec![Key("array".into()), Index(0), Key("0".into())],
            "object key".to_owned(),
            SourceFormat::Text,
        ),
        (
            vec![Key("array".into()), Index(0), Key("".into())],
            "true".into(),
            SourceFormat::Json,
        ),
        (
            vec![Key("a.\"\\/\0key".into()), Key("value".into())],
            u64::MAX.to_string(),
            SourceFormat::Json,
        ),
        (
            vec![Key(long_key.clone())],
            "original selected raw bytes 🦀".into(),
            SourceFormat::Text,
        ),
        (
            deep_path.clone(),
            "original selected raw bytes 🦀".into(),
            SourceFormat::Text,
        ),
        (vec![Key("empty".into())], String::new(), SourceFormat::Text),
        (vec![Key("nil".into())], "null".into(), SourceFormat::Json),
        (
            vec![Key("boolean".into())],
            "false".into(),
            SourceFormat::Json,
        ),
        (
            vec![Key("number".into())],
            value["number"].to_string(),
            SourceFormat::Json,
        ),
        (
            vec![Key("object".into())],
            value["object"].to_string(),
            SourceFormat::Json,
        ),
    ] {
        let source = log
            .history_source(
                "structured",
                through,
                maka_event_log::transcript::SourceSelection {
                    locator: sequence,
                    field,
                    path: Some(path.clone()),
                },
                SourcePosition::Start,
                8192,
            )
            .await
            .unwrap();
        assert_eq!(source.path, Some(path));
        assert_eq!(source.format, format);
        assert_eq!(source.text, expected);
    }
    for path in [
        vec![Key("missing".into())],
        vec![Key("array".into()), Key("0".into())],
        vec![Key("array".into()), Index(0), Index(0)],
        vec![Key("array".into()), Index(u32::MAX)],
    ] {
        assert!(
            log.history_source(
                "structured",
                through,
                maka_event_log::transcript::SourceSelection {
                    locator: sequence,
                    field,
                    path: Some(path)
                },
                SourcePosition::Start,
                8192
            )
            .await
            .is_err()
        );
    }
    assert!(
        log.history_source(
            "structured",
            through,
            maka_event_log::transcript::SourceSelection {
                locator: sequence,
                field: SourceField::Body,
                path: Some(vec![])
            },
            SourcePosition::Start,
            8192
        )
        .await
        .is_err()
    );
    assert!(
        log.history_source(
            "structured",
            through,
            maka_event_log::transcript::SourceSelection {
                locator: sequence,
                field,
                path: Some(vec![Key("content".into())])
            },
            SourcePosition::After { offset: 1 },
            8192
        )
        .await
        .is_err()
    );
    assert!(
        log.history_source(
            "foreign",
            through,
            maka_event_log::transcript::SourceSelection {
                locator: sequence,
                field,
                path: Some(vec![Key("content".into())])
            },
            SourcePosition::Start,
            8192
        )
        .await
        .is_err()
    );
    let root = log
        .history_source(
            "structured",
            through,
            maka_event_log::transcript::SourceSelection {
                locator: sequence,
                field,
                path: Some(vec![]),
            },
            SourcePosition::Tail,
            8192,
        )
        .await
        .unwrap();
    let raw = log
        .history_source(
            "structured",
            through,
            maka_event_log::transcript::SourceSelection {
                locator: sequence,
                field,
                path: None,
            },
            SourcePosition::Tail,
            8192,
        )
        .await
        .unwrap();
    assert_eq!(root.text, raw.text);
    assert_eq!(root.total_bytes, raw.total_bytes);
    assert_eq!(root.path, Some(vec![]));
    assert!(raw.path.is_none());
    log.shutdown().await.unwrap();
    let reopened = EventLog::open(&database).await.unwrap();
    let source = reopened
        .history_source(
            "structured",
            through,
            maka_event_log::transcript::SourceSelection {
                locator: sequences[1],
                field: SourceField::Result,
                path: Some(vec![Key("content".into())]),
            },
            SourcePosition::Tail,
            8192,
        )
        .await
        .unwrap();
    assert_eq!(source.text, text);
}
