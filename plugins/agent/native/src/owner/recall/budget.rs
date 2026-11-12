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

use super::failed;
use maka_agent_facts::{
    tool_output::{DurableToolProjection, ToolOutput, ToolSuccess},
    tools::ToolError,
};
use maka_assistant::recall::search::{Passage, ResultSet};

const RESULT_BYTES: usize = 64 * 1024;
const MESSAGE_BYTES: usize = 4 * 1024;

pub(super) fn tool_output(
    mut page: ResultSet,
    text_offset: Option<usize>,
) -> Result<ToolSuccess, ToolError> {
    let mut passages = std::mem::take(&mut page.passages).into_iter().peekable();
    while let Some(mut passage) = passages.next() {
        for message in &mut passage.messages {
            let start = text_offset.unwrap_or(0);
            if !message.text.is_char_boundary(start) {
                return Err(failed(
                    "RecallMore text_offset is outside the message or splits a UTF-8 character",
                ));
            }
            let end = message
                .text
                .floor_char_boundary(start.saturating_add(MESSAGE_BYTES));
            message.next_text_offset = (end < message.text.len()).then_some(end);
            if start == 0 {
                message.text.truncate(end);
            } else {
                message.text = message.text[start..end].to_owned();
            }
        }
        page.passages.push(passage);
        page.more_passages = passages.peek().is_some();
        while !fits(&page)? {
            if page.passages.len() > 1 {
                page.passages.pop();
                page.more_passages = true;
                return finish(page);
            }
            if !shrink_context(&mut page.passages[0]) {
                return Err(too_large());
            }
        }
    }
    finish(page)
}

fn shrink_context(passage: &mut Passage) -> bool {
    let Some(anchor) = passage
        .messages
        .iter()
        .position(|message| message.is_anchor)
    else {
        return false;
    };
    let before = anchor;
    let after = passage.messages.len() - anchor - 1;
    if before == 0 && after == 0 {
        return false;
    }
    passage.messages.truncate(anchor + 1 + after / 2);
    passage.messages.drain(..before.div_ceil(2));
    passage.has_more_before |= before > 0;
    passage.has_more_after |= after > 0;
    true
}

fn fits(page: &ResultSet) -> Result<bool, ToolError> {
    Ok(serde_json::to_vec(&(page, page.render()))
        .map_err(failed)?
        .len()
        <= RESULT_BYTES)
}

fn finish(page: ResultSet) -> Result<ToolSuccess, ToolError> {
    let text = page.render();
    if serde_json::to_vec(&(&page, &text)).map_err(failed)?.len() > RESULT_BYTES {
        return Err(too_large());
    }
    Ok(ToolSuccess::projected(
        ToolOutput::Json(serde_json::to_value(page).map_err(failed)?),
        DurableToolProjection::Text { text },
    ))
}

fn too_large() -> ToolError {
    failed(
        "Recall result metadata exceeds the response byte limit. Narrow the search or read one message with RecallMore.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::durable::{ExecutionIdentity, FactId, RunId};
    use maka_agent_ports::session::history::{Role, RowPosition};
    use maka_assistant::recall::search::PassageMessage;
    use serde_json::Value;

    fn passage(index: usize, messages: Vec<PassageMessage>) -> Passage {
        let anchor = messages.iter().find(|message| message.is_anchor).unwrap();
        Passage {
            session_id: format!("session-{index}"),
            session_title: "History".into(),
            anchor_message_id: anchor.message_id.clone(),
            anchor_position: RowPosition::Live {
                sequence: 1,
                fact: FactId::new(),
                item_index: 0,
            },
            turn_id: "turn".into(),
            messages,
            matched_terms: vec!["history".into()],
            score: 1.0,
            has_more_before: false,
            has_more_after: false,
        }
    }

    fn message(index: usize, text: String, is_anchor: bool) -> PassageMessage {
        PassageMessage {
            message_id: format!("message-{index}"),
            role: Role::ToolResult,
            text,
            next_text_offset: None,
            timestamp: 1,
            is_anchor,
            attachments: vec![],
        }
    }

    fn page(passages: Vec<Passage>, offset: Option<usize>) -> (Value, String) {
        let result = ResultSet {
            passages,
            searched_every_session: true,
            gaps: vec![],
            more_passages: false,
        };
        let prepared = tool_output(result, offset)
            .unwrap()
            .into_durable(
                "recall",
                std::time::SystemTime::UNIX_EPOCH,
                &ExecutionIdentity {
                    session_id: "current".into(),
                    turn_id: "turn".into(),
                    run_id: RunId::new(),
                },
            )
            .unwrap();
        let (ToolOutput::Json(value), DurableToolProjection::Text { text }) =
            (prepared.output, prepared.projection)
        else {
            panic!("Recall must retain both the structured and model views");
        };
        assert!(serde_json::to_vec(&(&value, &text)).unwrap().len() <= RESULT_BYTES);
        (value, text)
    }

    #[test]
    fn recall_limits_large_ranked_passages_and_preserves_anchor_and_more_flags() {
        let windows = (0..5)
            .map(|index| {
                let messages = (0..9)
                    .map(|id| message(id, "\u{0001}".repeat(5000), id == 4))
                    .collect();
                passage(index, messages)
            })
            .collect();
        let (value, text) = page(windows, None);
        let top = &value["passages"][0];
        assert_eq!(top["session_id"], "session-0");
        assert_eq!(top["anchor_message_id"], "message-4");
        assert_eq!(top["has_more_before"], true);
        assert_eq!(top["has_more_after"], true);
        assert_eq!(value["more_passages"], true);
        assert!(text.contains("More ranked passages omitted"));
    }

    #[test]
    fn recall_more_resumes_one_large_message_at_utf8_boundaries() {
        let original = "复".repeat(2800) + "end";
        let make = || passage(0, vec![message(0, original.clone(), true)]);
        let mut text = String::new();
        let mut offset = None;
        for _ in 0..3 {
            let (value, rendered) = page(vec![make()], offset);
            let item = &value["passages"][0]["messages"][0];
            text.push_str(item["text"].as_str().unwrap());
            offset = item["next_text_offset"]
                .as_u64()
                .map(|value| value as usize);
            if let Some(next) = offset {
                assert!(rendered.contains(&format!("text_offset={next}")));
            }
        }
        assert_eq!(offset, None);
        assert_eq!(text, original);
    }
}
