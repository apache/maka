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
use maka_capabilities::call::Resources;
use maka_capabilities::call::Ticket;
use maka_capabilities::filesystem::OpenFile;
use maka_capabilities::filesystem::ReadAuthorization;
use maka_capabilities::filesystem::ReadError;
use maka_capabilities::filesystem::ReadRoot;
use maka_session_import::{Error, claude};
use serde_json::{Value, json};
use std::{
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

fn source(rows: Vec<Value>) -> Vec<u8> {
    let mut bytes = Vec::new();
    for mut row in rows {
        row["sessionId"] = json!("selected");
        serde_json::to_writer(&mut bytes, &row).unwrap();
        bytes.push(b'\n');
    }
    bytes
}
struct Rewrite {
    path: PathBuf,
    bytes: Vec<u8>,
    reads: AtomicUsize,
    resources: Arc<Resources>,
}
impl ReadAuthorization for Rewrite {
    fn check(&self) -> Pin<Box<dyn Future<Output = Result<Ticket, ReadError>> + Send + '_>> {
        Box::pin(async move {
            // The source application rewrites in place after the lineage scan,
            // before the next authorized read batch. The descriptor stays valid.
            if self.reads.fetch_add(1, Ordering::SeqCst) == 2 {
                std::fs::write(&self.path, &self.bytes).unwrap();
            }
            self.resources.reserve().map_err(|_| ReadError::Retired)
        })
    }
}
async fn read(
    bytes: &[u8],
    replacement: Option<Vec<u8>>,
) -> Result<maka_session_import::Transcript, Error> {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("transcript");
    std::fs::write(&path, bytes).unwrap();
    let owner = maka_capabilities::call::Issuer::default()
        .issue(
            maka_capabilities::call::Identity::Remote {
                request_id: uuid::Uuid::new_v4(),
            },
            CancellationToken::new(),
        )
        .unwrap();
    let root = ReadRoot::open(directory.path()).await.unwrap();
    let resources = Arc::new(Resources::default());
    let view = match replacement {
        Some(bytes) => root.bind_authorized(
            &owner,
            Arc::new(Rewrite {
                path,
                bytes,
                reads: AtomicUsize::new(0),
                resources: resources.clone(),
            }),
        ),
        None => root.bind_scope(&owner),
    };
    let file = view
        .open_file(OpenFile::from("transcript".to_owned()))
        .await
        .unwrap();
    let result = claude::read(&file, "selected").await;
    file.close().await.unwrap();
    resources.finish().await.unwrap();
    owner.finish().await.unwrap();
    result
}

#[tokio::test]
async fn claude_selects_rewinds_without_losing_parallel_results_fragments_or_compaction_roots() {
    let fragment = json!({"type":"assistant","uuid":"fragment-b","parentUuid":"fragment-a","message":{
        "id":"response","model":"source-model","stop_reason":"max_tokens","content":[
            {"type":"text","text":"second"},
            {"type":"thinking","thinking":"a thought"},
            {"type":"tool_use","id":"b","name":"Read","input":{"path":"b"}}
        ]
    }});
    let bytes = source(vec![
        json!({"type":"assistant","uuid":"lead","parentUuid":null,"cwd":"/source","message":{"content":"leading answer"}}),
        json!({"type":"user","uuid":"z-withdrawn","parentUuid":"lead","message":{"content":"withdrawn question"}}),
        json!({"type":"assistant","uuid":"old-answer","parentUuid":"z-withdrawn","message":{"content":"withdrawn answer"}}),
        json!({"type":"user","uuid":"a-selected","parentUuid":"lead","timestamp":1234,"message":{"content":"selected question"}}),
        json!({"type":"assistant","uuid":"fragment-a","parentUuid":"a-selected","message":{
            "id":"response","model":"source-model","content":[
                {"type":"text","text":"first"},
                {"type":"tool_use","id":"a","name":"Read","input":{"path":"a"}}
            ]
        }}),
        json!({"type":"user","uuid":"result-a","parentUuid":"fragment-a","message":{"content":[
            {"type":"tool_result","tool_use_id":"a","content":"first\nsecond\n"}
        ]}}),
        fragment.clone(),
        json!({"type":"user","uuid":"result-b","parentUuid":"fragment-b","message":{"content":[
            {"type":"tool_result","tool_use_id":"b","content":"failed","is_error":true}
        ]}}),
        json!({"type":"system","uuid":"compact","parentUuid":null,"logicalParentUuid":"after","subtype":"compact_boundary"}),
        json!({"type":"user","uuid":"after","parentUuid":null,"message":{"content":"after compaction"}}),
        json!({"type":"user","uuid":"interrupted","parentUuid":"after","message":{"content":"[Request interrupted by user]"}}),
        json!({"type":"ai-title","aiTitle":"selected source title"}),
        fragment,
    ]);
    let transcript = read(&bytes, None).await.unwrap();
    assert_eq!(transcript.title, "selected source title");
    assert_eq!(transcript.cwd.as_deref(), Some("/source"));
    let records = &transcript.records;
    assert_eq!(records.len(), 11);
    assert_eq!(
        records[1].timestamp,
        Some(1234),
        "Claude numeric timestamps are milliseconds"
    );
    assert!(
        matches!(&records[0].content, Content::Assistant { text, .. } if text == "leading answer")
    );
    assert!(matches!(&records[1].content, Content::User { text } if text == "selected question"));
    assert!(
        matches!(&records[2].content, Content::Assistant { text, thinking, .. }
        if text == "first\n\nsecond" && thinking.as_deref() == Some("a thought"))
    );
    let Content::ToolCall { call_id: a, .. } = &records[3].content else {
        panic!("missing first call")
    };
    let Content::ToolCall { call_id: b, .. } = &records[4].content else {
        panic!("missing second call")
    };
    assert!(
        matches!(&records[5].content, Content::ToolResult { call_id, output, .. }
        if call_id == a && output == &json!("first\nsecond\n"))
    );
    assert!(matches!(&records[6].content, Content::Note { text } if text.contains("output limit")));
    assert!(
        matches!(&records[7].content, Content::ToolResult { call_id, is_error: true, .. } if call_id == b)
    );
    assert!(matches!(&records[8].content, Content::Note { text } if text.contains("compacted")));
    assert!(matches!(&records[9].content, Content::User { text } if text == "after compaction"));
    assert!(matches!(&records[10].content, Content::Note { text } if text.contains("interrupted")));
    assert_eq!(records[5].source_turn_id, "a-selected");
    let encoded = serde_json::to_string(&records).unwrap();
    assert!(!encoded.contains("withdrawn"));
}

#[tokio::test]
async fn claude_refuses_a_mixed_snapshot_or_sidechain_without_publishing_partial_history() {
    let original = source(vec![
        json!({"type":"user","uuid":"user","message":{"content":"hello"}}),
    ]);
    let rewritten = source(vec![
        json!({"type":"user","uuid":"user","message":{"content":"jello"}}),
    ]);
    assert_eq!(original.len(), rewritten.len());
    assert!(matches!(
        read(&original, Some(rewritten)).await,
        Err(Error::Invalid("Claude source changed between read passes"))
    ));
    let sidechain = source(vec![
        json!({"type":"user","uuid":"user","isSidechain":true,"message":{"content":"hello"}}),
    ]);
    assert!(matches!(
        read(&sidechain, None).await,
        Err(Error::Invalid(_))
    ));
    let wrong_identity =
        b"{\"type\":\"user\",\"sessionId\":\"other\",\"message\":{\"content\":\"hello\"}}\n";
    assert!(matches!(
        read(wrong_identity, None).await,
        Err(Error::Invalid(_))
    ));
    let mut corrupt = original.clone();
    corrupt.extend_from_slice(b"{\"unfinished\":\n");
    assert!(matches!(
        read(&corrupt, None).await,
        Err(Error::Decode { line: 2, .. })
    ));
}
