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
use crate::projection::Projection;
use maka_agent_ports::session::history::Cursor;
use serde_json::{Value, json};
use std::{collections::VecDeque, future::ready};

fn position(sequence: u64) -> RowPosition {
    RowPosition {
        source_sequence: sequence,
        item_index: 0,
    }
}

fn chunk(sequence: u64, role: &str, tool: &str, offset: u64, text: &str) -> HistoryChunk {
    serde_json::from_value(json!({
        "field":"body", "messageId":if role == "tool_call" { tool.to_owned() } else { format!("result-{sequence}") }, "turnId":"turn", "timestamp":1,
        "role":role, "position":position(sequence), "offset":offset, "totalBytes":6, "text":text,
        "tool":{"toolUseId":tool,
            "call":{"position":position(if role == "tool_call" { sequence } else { sequence - 1 }),"name":"Read",
                "ancestorToolUseIds":[],"title":null,"pending":role == "tool_call","dispatched":role == "tool_result"},
            "result":if role == "tool_result" { json!({"position":position(sequence),"settlement":"returned",
                "isError":false,"image":false}) } else { Value::Null }
        }
    })).unwrap()
}

fn page(through: u64, chunks: Vec<HistoryChunk>, after: Option<Cursor>) -> HistoryPage {
    HistoryPage::Ready {
        through,
        chunks,
        before: None,
        after,
    }
}

fn round_pages(after: u64, tool: &str) -> VecDeque<HistoryPage> {
    let cursor = Cursor {
        position: position(after + 2),
        field: HistoryField::Body,
        offset: 3,
    };
    VecDeque::from([
        page(
            after + 10,
            vec![
                chunk(after + 1, "tool_call", tool, 0, "intent"),
                chunk(after + 2, "tool_result", tool, 0, "abc"),
            ],
            Some(cursor),
        ),
        page(
            after + 10,
            vec![chunk(after + 2, "tool_result", tool, 3, "def")],
            None,
        ),
    ])
}

#[tokio::test]
async fn two_hundred_twenty_tool_rounds_read_only_new_pages_and_publish_complete_results() {
    let mut through = 0;
    let mut projection = Projection::default();
    let mut reads = 0;
    for round in 0..220 {
        let tool = format!("read-{round}");
        let mut pages = round_pages(through, &tool);
        let start = through + 1;
        let cursor = Cursor {
            position: position(through + 2),
            field: HistoryField::Body,
            offset: 3,
        };
        let mut expected = VecDeque::from([
            HistoryPosition::Event { sequence: start },
            HistoryPosition::After { cursor },
        ]);
        let snapshot = since_with(
            |fence, requested| {
                reads += 1;
                assert_eq!(fence, Some((round + 1) * 10));
                assert_eq!(requested, expected.pop_front().unwrap());
                ready(Ok(pages.pop_front().unwrap()))
            },
            through + 10,
            through,
        )
        .await
        .unwrap();
        let mut updates = Vec::new();
        for chunk in snapshot.chunks {
            updates.extend(projection.chunk(&chunk).unwrap());
        }
        let results: Vec<Value> = updates
            .iter()
            .map(|update| serde_json::to_value(update).unwrap())
            .filter(|update| update["content"][0]["content"]["text"] == "abcdef")
            .collect();
        assert_eq!(
            results.len(),
            1,
            "round {round} must publish its complete tool result once"
        );
        assert_eq!(results[0]["status"], "completed");
        through = snapshot.through;
        assert_eq!(
            reads,
            (round + 1) * 2,
            "page work must not grow with completed rounds"
        );
    }
    assert!(projection.finish("turn", true).unwrap().is_empty());
    let empty = since_with(
        |_, _| ready(Err("an acknowledged fence must not be read again".into())),
        through,
        through,
    )
    .await
    .unwrap();
    assert!(empty.chunks.is_empty());
}

#[tokio::test]
async fn failed_page_does_not_return_progress_and_retry_replays_every_fragment() {
    let mut pages = round_pages(10, "read");
    let first = pages.pop_front().unwrap();
    let mut replies = VecDeque::from([Ok(first), Err("page unavailable".into())]);
    let result = since_with(|_, _| ready(replies.pop_front().unwrap()), 20, 10).await;
    assert!(
        result.is_err(),
        "a partial snapshot cannot acknowledge its fence"
    );
    let mut pages = round_pages(10, "read");
    let mut positions = Vec::new();
    let snapshot = since_with(
        |_, requested| {
            positions.push(requested);
            ready(Ok(pages.pop_front().unwrap()))
        },
        20,
        10,
    )
    .await
    .unwrap();
    assert_eq!(positions[0], HistoryPosition::Event { sequence: 11 });
    let mut projection = Projection::default();
    let updates: Vec<_> = snapshot
        .chunks
        .iter()
        .flat_map(|chunk| projection.chunk(chunk).unwrap())
        .collect();
    let output = serde_json::to_value(updates.last().unwrap()).unwrap();
    assert_eq!(output["content"][0]["content"]["text"], "abcdef");
    assert_eq!(snapshot.through, 20);
}

#[tokio::test]
async fn terminal_without_result_refreshes_late_dispatch_before_marking_failed() {
    let mut projection = Projection::default();
    projection
        .chunk(&chunk(1, "tool_call", "old", 0, "intent"))
        .unwrap();
    let pending: Vec<_> = projection.unsettled_tool_positions().collect();
    assert_eq!(
        pending,
        vec![position(1)],
        "finish must refresh a dispatched call even without its final stream frame"
    );
    let call = pending[0];
    let mut first = chunk(1, "tool_call", "old", 0, "int");
    first.tool.as_mut().unwrap().call.as_mut().unwrap().title = Some(Box::new(
        maka_agent_facts::display::Text::plain("Read workspace"),
    ));
    first
        .tool
        .as_mut()
        .unwrap()
        .call
        .as_mut()
        .unwrap()
        .presentation = Some("workspace.read".into());
    let mut second = chunk(1, "tool_call", "old", 3, "ent");
    second.tool = first.tool.clone();
    let cursor = Cursor {
        position: call,
        field: HistoryField::Body,
        offset: 3,
    };
    let mut pages = VecDeque::from([
        page(2200, vec![first], Some(cursor)),
        page(
            2200,
            vec![second, chunk(2199, "tool_call", "unrelated", 0, "intent")],
            None,
        ),
    ]);
    let mut expected = VecDeque::from([
        HistoryPosition::Row {
            position: call,
            field: HistoryField::Body,
        },
        HistoryPosition::After { cursor },
    ]);
    let snapshot = read_pages(
        |fence, requested| {
            assert_eq!(fence, Some(2200));
            assert_eq!(requested, expected.pop_front().unwrap());
            ready(Ok(pages.pop_front().unwrap()))
        },
        Some(2200),
        HistoryPosition::Row {
            position: call,
            field: HistoryField::Body,
        },
        Some(call),
    )
    .await
    .unwrap();
    let updates: Vec<_> = snapshot
        .chunks
        .iter()
        .flat_map(|chunk| projection.chunk(chunk).unwrap())
        .collect();
    assert_eq!(updates.len(), 1);
    let output = serde_json::to_value(&updates[0]).unwrap();
    assert_eq!(output["title"], "Read workspace");
    assert_eq!(output["_meta"]["maka"]["presentation"], "workspace.read");
    let terminal = projection.finish("turn", false).unwrap();
    assert_eq!(terminal.len(), 1);
    let output = serde_json::to_value(&terminal[0]).unwrap();
    assert_eq!(output["status"], "failed");
    assert_eq!(output["title"], "Read workspace");
    assert_eq!(output["_meta"]["maka"]["presentation"], "workspace.read");
    assert_eq!(output["_meta"]["maka"]["hostStatus"], "interrupted");
    assert_eq!(
        projection.tool_position("unrelated"),
        None,
        "row refresh must not replay its suffix"
    );
}
