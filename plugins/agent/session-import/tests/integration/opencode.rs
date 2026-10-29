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

use maka_agent_facts::import::Content;
use maka_session_import::opencode::{self, Message, Part, Session, Snapshot};
use serde_json::{Value, json, value::to_raw_value};

fn message(id: &str, at: u64, data: Value) -> Message {
    Message {
        id: id.into(),
        created_at: Some(at),
        data: to_raw_value(&data).unwrap(),
    }
}
fn part(id: &str, message: &str, at: u64, data: Value) -> Part {
    Part {
        id: format!("{at:03}-{id}"),
        message_id: message.into(),
        created_at: Some(at),
        data: to_raw_value(&data).unwrap(),
    }
}
fn snapshot() -> Snapshot {
    Snapshot {
        session: Session {
            id: "s".into(),
            parent_id: None,
            directory: Some("/source/project".into()),
            title: None,
            revert: None,
        },
        messages: vec![
            message(
                "answer",
                20,
                json!({"role":"assistant","modelID":"source-model","finish":"tool-calls"}),
            ),
            message("prompt", 10, json!({"role":"user"})),
        ],
        parts: vec![
            part(
                "last",
                "answer",
                24,
                json!({"type":"tool","callID":"reused","tool":"shell","state":{"status":"running","input":{"command":"still pending"}}}),
            ),
            part(
                "prompt-text",
                "prompt",
                10,
                json!({"type":"text","text":"Read the file"}),
            ),
            part(
                "answer-text",
                "answer",
                20,
                json!({"type":"text","text":"Before thinking"}),
            ),
            part(
                "answer-thinking",
                "answer",
                21,
                json!({"type":"reasoning","text":"Then thinking"}),
            ),
            part(
                "first",
                "answer",
                22,
                json!({"type":"tool","callID":"reused","tool":"Read","state":{"status":"completed","input":{"path":"a"},"output":"one\ntwo\n"}}),
            ),
            part(
                "failure",
                "answer",
                23,
                json!({"type":"tool","callID":"reused","tool":"Read","state":{"status":"error","input":{"path":"b"},"error":"source failure"}}),
            ),
        ],
    }
}
#[test]
fn opencode_preserves_part_order_tool_pairing_and_missing_results_without_native_execution() {
    let mut source = snapshot();
    // Source part IDs, not insertion timestamps, determine displayed order.
    for part in &mut source.parts {
        part.created_at = part.created_at.map(|time| 100 - time);
    }
    let transcript = opencode::convert(source, "s").unwrap();
    assert_eq!(transcript.title, "Read the file");
    assert_eq!(transcript.cwd.as_deref(), Some("/source/project"));
    assert!(!transcript.fingerprint.incomplete_tail);
    let records = transcript.records;
    assert!(
        records
            .iter()
            .all(|record| record.source_turn_id == "prompt")
    );
    assert!(matches!(&records[0].content, Content::User { text } if text == "Read the file"));
    assert!(
        matches!(&records[1].content, Content::Assistant { text, thinking: None, model: Some(model) } if text == "Before thinking" && model == "source-model")
    );
    assert!(
        matches!(&records[2].content, Content::Assistant { text, thinking: Some(thinking), .. } if text.is_empty() && thinking == "Then thinking")
    );
    let calls: Vec<_> = records
        .iter()
        .filter_map(|record| match &record.content {
            Content::ToolCall { call_id, .. } => Some(call_id),
            _ => None,
        })
        .collect();
    let results: Vec<_> = records
        .iter()
        .filter_map(|record| match &record.content {
            Content::ToolResult {
                call_id,
                output,
                is_error,
            } => Some((call_id, output, *is_error)),
            _ => None,
        })
        .collect();
    assert_eq!(calls.len(), 3);
    assert_eq!(
        results,
        [
            (calls[0], &json!("one\ntwo\n"), false),
            (calls[1], &json!("source failure"), true)
        ]
    );
    assert_ne!(calls[0], calls[1]);
    assert_ne!(calls[1], calls[2]);
    assert!(
        matches!(&records.last().unwrap().content, Content::Note { text } if text == "Source finish: tool-calls")
    );
    let mut partial = snapshot();
    partial.session.revert = Some(opencode::Revert {
        message_id: "answer".into(),
        part_id: Some("022-first".into()),
    });
    for part in &mut partial.parts {
        part.created_at = part.created_at.map(|time| 100 - time);
    }
    let partial = opencode::convert(partial, "s").unwrap();
    assert!(!partial.records.iter().any(|record| matches!(
        record.content,
        Content::ToolCall { .. } | Content::ToolResult { .. }
    )));
    assert!(
        partial
            .records
            .iter()
            .any(|record| matches!(&record.content,
        Content::Assistant { text, .. } if text == "Before thinking"))
    );
    let mut reverted = snapshot();
    reverted.session.revert = Some(opencode::Revert {
        message_id: "answer".into(),
        part_id: None,
    });
    let reverted = opencode::convert(reverted, "s").unwrap();
    assert_eq!(reverted.records.len(), 1);
    assert!(matches!(reverted.records[0].content, Content::User { .. }));
}
#[test]
fn opencode_refuses_ambiguous_or_corrupt_snapshots_before_publishing_any_history() {
    let mut unknown_revert = snapshot();
    unknown_revert.session.revert = Some(opencode::Revert {
        message_id: "missing".into(),
        part_id: None,
    });
    assert!(opencode::convert(unknown_revert, "s").is_err());
    let mut invalid_role = snapshot();
    invalid_role.messages[0].data = to_raw_value(&json!({"role":"asssistant"})).unwrap();
    assert!(opencode::convert(invalid_role, "s").is_err());
    assert!(opencode::convert(snapshot(), "wrong").is_err());
    let mut child = snapshot();
    child.session.parent_id = Some("parent".into());
    assert!(opencode::convert(child, "s").is_err());
    let mut orphan = snapshot();
    orphan.parts[0].message_id = "missing".into();
    assert!(opencode::convert(orphan, "s").is_err());
    let mut broken = snapshot();
    broken.parts[0].data = to_raw_value(
        &json!({"type":"tool","tool":"Read","callID":"c","state":{"status":"completed"}}),
    )
    .unwrap();
    assert!(opencode::convert(broken, "s").is_err());
    let mut dense = snapshot();
    dense.parts[0].data = to_raw_value(&json!({"type":"tool","tool":"Read","callID":"c","state":{"status":"running","input":vec![0;70_000]}})).unwrap();
    assert!(opencode::convert(dense, "s").is_ok());
}
