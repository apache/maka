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
use maka_capabilities::filesystem::OpenFile;
use maka_capabilities::filesystem::ReadRoot;
use maka_session_import::{Error, codex};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

async fn read(bytes: &[u8], id: &str) -> Result<maka_session_import::Transcript, Error> {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("rollout"), bytes).unwrap();
    let owner = maka_capabilities::call::Issuer::default()
        .issue(
            maka_capabilities::call::Identity::Remote {
                request_id: uuid::Uuid::new_v4(),
            },
            CancellationToken::new(),
        )
        .unwrap();
    let root = ReadRoot::open(directory.path()).await.unwrap();
    let file = root
        .bind_scope(&owner)
        .open_file(OpenFile::from("rollout".to_owned()))
        .await
        .unwrap();
    let result = codex::read(&file, id).await;
    file.close().await.unwrap();
    owner.finish().await.unwrap();
    result
}
fn lines(values: Vec<Value>) -> Vec<u8> {
    let mut result = Vec::new();
    for value in values {
        serde_json::to_writer(&mut result, &value).unwrap();
        result.push(b'\n');
    }
    result
}
fn meta() -> Value {
    json!({"type":"session_meta","payload":{"id":"source","cwd":"/source/workspace","model_provider":"not-a-model",
        "api_key":"not-conversation","provider_options":{"private":"never import"}}})
}
#[tokio::test]
async fn codex_keeps_observations_ordered_without_mirrors_or_invented_execution() {
    let user = "跨页正文".repeat(12_000);
    let mut bytes = lines(vec![
        meta(),
        json!({"type":"event_msg","payload":{"type":"agent_message","message":"leading assistant"}}),
        json!({"type":"turn_context","payload":{"turn_id":"first","model":"source-model"}}),
        json!({"type":"event_msg","timestamp":"2026-09-23T00:00:00Z","payload":{"type":"item_completed","item":{
            "type":"UserMessage","client_id":"client-message","content":[{"type":"text","text":user}]
        }}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":user}]}}),
        json!({"type":"event_msg","timestamp":"1790121600","payload":{"type":"item_completed","item":{
            "type":"Reasoning","id":"thinking","summary_text":["first thought",{"text":"second thought"}]
        }}}),
        json!({"type":"response_item","payload":{"type":"function_call","call_id":"foreign-call","namespace":"functions","name":"shell","arguments":"{\"command\":\"pwd\"}"}}),
        json!({"type":"event_msg","payload":{"type":"agent_message","message":"answer while tool runs"}}),
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"second"}}),
        json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"foreign-call","output":{"content":"a\nb\nc\n"}}}),
        json!({"type":"response_item","payload":{"type":"custom_tool_call","call_id":"foreign-call","name":"apply_patch","input":"*** patch ***"}}),
        json!({"type":"event_msg","payload":{"type":"user_message","images":["unavailable"]}}),
        json!({"type":"token_count","payload":{"api_key":"not-conversation"}}),
    ]);
    // A concurrent append may stop halfway through its final JSON value. Its
    // prefix is not presented as a complete message, nor confused with corruption.
    bytes.extend_from_slice(b"{\"type\":\"event_msg\",\"payload\":");
    let transcript = read(&bytes, "source").await.unwrap();
    assert_eq!(transcript.cwd.as_deref(), Some("/source/workspace"));
    assert_eq!(transcript.fingerprint.bytes, bytes.len() as u64);
    assert!(transcript.fingerprint.incomplete_tail);
    let records = &transcript.records;
    assert_eq!(records.len(), 8);
    assert_eq!(records[0].timestamp, None);
    assert!(
        matches!(&records[0].content, Content::Assistant { model: None, text, .. } if text == "leading assistant")
    );
    assert_eq!(records[1].source_message_id, "client-message");
    assert_eq!(records[1].source_turn_id, "first");
    assert_eq!(records[1].timestamp, Some(1_790_121_600_000));
    assert_eq!(records[1].timestamp, records[2].timestamp);
    assert!(matches!(&records[1].content, Content::User { text } if text == &user));
    assert!(
        matches!(&records[2].content, Content::Assistant { text, model, thinking }
        if text.is_empty() && model.as_deref() == Some("source-model") && thinking.as_deref() == Some("first thought\nsecond thought"))
    );
    let Content::ToolCall {
        call_id,
        name,
        input,
    } = &records[3].content
    else {
        panic!("missing call")
    };
    assert_eq!(name, "functions.shell");
    assert_eq!(input, &Some(json!({"command":"pwd"})));
    assert!(
        matches!(&records[4].content, Content::Assistant { text, .. } if text == "answer while tool runs")
    );
    assert!(
        matches!(&records[5].content, Content::ToolResult { call_id: key, output, .. }
        if key == call_id && output == &json!({"content":"a\nb\nc\n"}))
    );
    assert_eq!(
        records[5].source_turn_id, "first",
        "late result belongs to its call, not the next turn"
    );
    assert!(
        matches!(&records[6].content, Content::ToolCall { call_id: key, input, .. }
        if key != call_id && input == &Some(json!("*** patch ***")))
    );
    assert!(matches!(&records[7].content, Content::User { text } if text == "[Image]"));
    let encoded = serde_json::to_string(&transcript).unwrap();
    assert!(!encoded.contains("api_key") && !encoded.contains("provider_options"));
    let repeat = read(&bytes, "source").await.unwrap();
    assert_eq!(transcript.records, repeat.records);
    assert_eq!(transcript.fingerprint, repeat.fingerprint);

    let revised = lines(vec![
        meta(),
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"kept"}}),
        json!({"type":"event_msg","payload":{"type":"user_message","message":"keep","images":null}}),
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"withdrawn"}}),
        json!({"type":"event_msg","payload":{"type":"user_message","message":"withdrawn"}}),
        json!({"type":"response_item","payload":{"type":"function_call","call_id":"reuse","name":"shell","arguments":"{}"}}),
        json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}),
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"replacement"}}),
        json!({"type":"event_msg","payload":{"type":"user_message","message":"replacement"}}),
        json!({"type":"response_item","payload":{"type":"function_call","call_id":"reuse","name":"shell","arguments":"{}"}}),
        json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":"Plan","id":"plan","text":"actual plan"}}}),
        json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":"Reasoning","id":"raw","summary_text":[],"raw_content":["actual thought"]}}}),
        json!({"type":"event_msg","payload":{"type":"agent_reasoning_raw_content","text":"legacy thought"}}),
        json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"reuse","output":"observed"}}),
    ]);
    let revised = read(&revised, "source").await.unwrap();
    assert_eq!(revised.records.len(), 7);
    assert!(
        !serde_json::to_string(&revised)
            .unwrap()
            .contains("withdrawn")
    );
    assert!(
        matches!(&revised.records[3].content, Content::Assistant { text, .. } if text == "actual plan")
    );
    assert!(
        matches!(&revised.records[4].content, Content::Assistant { thinking, .. } if thinking.as_deref() == Some("actual thought"))
    );
    assert!(
        matches!(&revised.records[5].content, Content::Assistant { thinking, .. } if thinking.as_deref() == Some("legacy thought"))
    );
    let Content::ToolCall { call_id, .. } = &revised.records[2].content else {
        panic!("missing replacement call")
    };
    assert!(
        matches!(&revised.records[6].content, Content::ToolResult { call_id: key, .. } if key == call_id)
    );
}

#[tokio::test]
async fn codex_rejects_corruption_and_identity_mismatch_but_keeps_large_history() {
    let valid = lines(vec![
        meta(),
        json!({"type":"event_msg","payload":{"type":"user_message","message":"hello"}}),
    ]);
    assert!(matches!(
        read(&valid, "another-session").await,
        Err(Error::Invalid(_))
    ));
    let mut corrupted = valid.clone();
    corrupted.extend_from_slice(b"{broken}\n");
    assert!(matches!(
        read(&corrupted, "source").await,
        Err(Error::Decode { line: 3, .. })
    ));
    corrupted.pop(); // A syntax error is still corruption without a newline.
    assert!(matches!(
        read(&corrupted, "source").await,
        Err(Error::Decode { line: 3, .. })
    ));
    let only_tools = lines(vec![
        meta(),
        json!({"type":"response_item","payload":{
            "type":"function_call","call_id":"call","name":"shell","arguments":"{}"
        }}),
    ]);
    assert!(matches!(
        read(&only_tools, "source").await,
        Err(Error::Invalid(_))
    ));
    let oversized = lines(vec![
        meta(),
        json!({"type":"event_msg","payload":{
            "type":"user_message","message":"x".repeat(6 * 1024 * 1024)
        }}),
    ]);
    let imported = read(&oversized, "source").await.unwrap();
    assert!(
        matches!(&imported.records[0].content, Content::User { text } if text.len() == 6 * 1024 * 1024)
    );
    let mut unterminated = valid.clone();
    unterminated.pop();
    assert!(
        !read(&unterminated, "source")
            .await
            .unwrap()
            .fingerprint
            .incomplete_tail
    );
    let malformed_known = lines(vec![
        meta(),
        json!({"type":"event_msg","payload":{"type":"agent_message","message":42}}),
    ]);
    assert!(matches!(
        read(&malformed_known, "source").await,
        Err(Error::Decode { line: 2, .. })
    ));
    let dense = vec![0; 65_536];
    let dense_output = lines(vec![
        meta(),
        json!({"type":"event_msg","payload":{"type":"user_message","message":"Keep dense tool history"}}),
        json!({"type":"response_item","payload":{
            "type":"function_call_output","call_id":"dense","output":dense
        }}),
    ]);
    assert!(read(&dense_output, "source").await.is_ok());
    // Large tool arguments and output remain intact historical evidence.
    let dense_input = lines(vec![
        meta(),
        json!({"type":"event_msg","payload":{"type":"user_message","message":"Keep dense tool history"}}),
        json!({"type":"response_item","payload":{
            "type":"function_call","call_id":"dense","name":"shell","arguments":serde_json::to_string(&dense).unwrap()
        }}),
    ]);
    assert!(read(&dense_input, "source").await.is_ok());
}
