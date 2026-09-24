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

//! What the transcript shows, as plain data: the Host's rows and live
//! streams become entries, and entries fold into list rows. A settled turn
//! keeps its prompt and final answer in view and folds the work before the
//! answer under one "worked for" line.

use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Debug, PartialEq)]
pub enum Entry {
    Prompt {
        id: String,
        turn: String,
        text: String,
        at: u64,
    },
    Text {
        id: String,
        turn: String,
        text: String,
        streaming: bool,
    },
    Thought {
        id: String,
        turn: String,
        text: String,
        streaming: bool,
    },
    Tool {
        id: String,
        turn: String,
        name: String,
        args: Value,
        result: Option<Outcome>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    pub failed: bool,
    pub output: String,
}

impl Entry {
    pub fn id(&self) -> &str {
        match self {
            Self::Prompt { id, .. }
            | Self::Text { id, .. }
            | Self::Thought { id, .. }
            | Self::Tool { id, .. } => id,
        }
    }

    pub fn turn(&self) -> &str {
        match self {
            Self::Prompt { turn, .. }
            | Self::Text { turn, .. }
            | Self::Thought { turn, .. }
            | Self::Tool { turn, .. } => turn,
        }
    }

    /// Text that is only whitespace is work, not an answer.
    fn answers(&self) -> bool {
        matches!(self, Self::Text { text, .. } if !text.trim().is_empty())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Ending {
    Completed,
    Failed(String),
    Cancelled,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Turn {
    pub started: Option<u64>,
    pub ended: Option<(u64, Ending)>,
}

#[derive(Default)]
pub struct Transcript {
    pub entries: Vec<Entry>,
    pub turns: BTreeMap<String, Turn>,
}

/// Durable rows in sequence order, then live text that has no row yet.
pub fn transcript<'a>(
    rows: impl IntoIterator<Item = &'a Value>,
    live: impl IntoIterator<Item = Entry>,
) -> Transcript {
    let mut out = Transcript::default();
    let mut calls = BTreeMap::new();
    for row in rows {
        let id = row["id"].as_str().unwrap_or_default().to_owned();
        let turn = row["turnId"].as_str().unwrap_or_default().to_owned();
        let at = row["ts"].as_u64().unwrap_or_default();
        match row["type"].as_str() {
            Some("user") => {
                let text = row["displayText"]
                    .as_str()
                    .filter(|text| !text.trim().is_empty())
                    .or_else(|| row["text"].as_str())
                    .unwrap_or_default()
                    .to_owned();
                out.turns.entry(turn.clone()).or_default().started = Some(at);
                out.entries.push(Entry::Prompt { id, turn, text, at });
            }
            Some("assistant") => {
                if let Some(thought) = row["thinking"]["text"].as_str()
                    && !thought.trim().is_empty()
                {
                    out.entries.push(Entry::Thought {
                        id: id.clone(),
                        turn: turn.clone(),
                        text: thought.to_owned(),
                        streaming: false,
                    });
                }
                if let Some(text) = row["text"].as_str()
                    && !text.is_empty()
                {
                    out.entries.push(Entry::Text {
                        id,
                        turn,
                        text: text.to_owned(),
                        streaming: false,
                    });
                }
            }
            Some("tool_call") => {
                calls.insert((turn.clone(), id.clone()), out.entries.len());
                out.entries.push(Entry::Tool {
                    id,
                    turn,
                    name: row["toolName"].as_str().unwrap_or("tool").to_owned(),
                    args: row["args"].clone(),
                    result: None,
                });
            }
            Some("tool_result") => {
                let call = row["toolUseId"].as_str().unwrap_or_default().to_owned();
                if let Some(&ix) = calls.get(&(turn, call))
                    && let Entry::Tool { result, .. } = &mut out.entries[ix]
                {
                    *result = Some(Outcome {
                        failed: row["isError"] == true,
                        output: output(&row["content"]),
                    });
                }
            }
            Some("turn_state") => {
                let ending = match row["status"].as_str() {
                    Some("completed") => Ending::Completed,
                    Some("failed") => Ending::Failed(
                        row["failureMessage"]
                            .as_str()
                            .unwrap_or("未知错误")
                            .to_owned(),
                    ),
                    Some("aborted") => Ending::Cancelled,
                    _ => continue,
                };
                out.turns.entry(turn).or_default().ended = Some((at, ending));
            }
            _ => {}
        }
    }
    let known: HashSet<(String, &'static str)> = out
        .entries
        .iter()
        .filter_map(|entry| match entry {
            Entry::Text { id, .. } => Some((id.clone(), "text")),
            Entry::Thought { id, .. } => Some((id.clone(), "thought")),
            _ => None,
        })
        .collect();
    for entry in live {
        let kind = if matches!(entry, Entry::Thought { .. }) {
            "thought"
        } else {
            "text"
        };
        if !known.contains(&(entry.id().to_owned(), kind)) {
            out.entries.push(entry);
        }
    }
    out
}

fn output(content: &Value) -> String {
    match content["kind"].as_str() {
        Some("text") => content["text"].as_str().unwrap_or_default().to_owned(),
        Some("json") => serde_json::to_string_pretty(&content["value"]).unwrap_or_default(),
        Some("image") => "[图片]".into(),
        _ => content.to_string(),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Row {
    Prompt(usize),
    Text(usize),
    /// A run of tool calls and thoughts with no answer text between them.
    Work {
        items: Vec<usize>,
        live: bool,
    },
    /// The folded work of a settled turn.
    Summary {
        turn: String,
        open: bool,
    },
    Notice {
        turn: String,
        text: String,
    },
    Footer {
        turn: String,
    },
    Working,
}

impl Row {
    /// Stable across refolds, so measurements and state follow the row.
    pub fn key(&self, entries: &[Entry]) -> String {
        match self {
            Self::Prompt(ix) => format!("prompt:{}", entries[*ix].id()),
            Self::Text(ix) => format!("text:{}", entries[*ix].id()),
            Self::Work { items, .. } => format!("work:{}", entries[items[0]].id()),
            Self::Summary { turn, .. } => format!("summary:{turn}"),
            Self::Notice { turn, .. } => format!("notice:{turn}"),
            Self::Footer { turn } => format!("footer:{turn}"),
            Self::Working => "working".into(),
        }
    }
}

/// `running` is the turn the Host reports live, if any; `open` holds the
/// settled turns whose folded work the reader expanded.
pub fn fold(transcript: &Transcript, running: Option<&str>, open: &HashSet<String>) -> Vec<Row> {
    let entries = &transcript.entries;
    // Unfolded rows, grouped by turn in order of appearance.
    let mut turns: Vec<(String, Vec<Row>)> = Vec::new();
    for (ix, entry) in entries.iter().enumerate() {
        let turn = entry.turn();
        if turns.last().is_none_or(|(id, _)| id != turn) {
            turns.push((turn.to_owned(), Vec::new()));
        }
        let rows = &mut turns.last_mut().expect("pushed").1;
        match entry {
            Entry::Prompt { .. } => rows.push(Row::Prompt(ix)),
            Entry::Text { .. } if entry.answers() => rows.push(Row::Text(ix)),
            // Blank text between calls shows nothing and counts as nothing.
            Entry::Text { .. } => {}
            _ => match rows.last_mut() {
                Some(Row::Work { items, .. }) => items.push(ix),
                _ => rows.push(Row::Work {
                    items: vec![ix],
                    live: false,
                }),
            },
        }
    }
    let mut out = Vec::new();
    for (turn, rows) in turns {
        let state = transcript.turns.get(&turn);
        if running == Some(turn.as_str()) {
            let last = rows.len().saturating_sub(1);
            for (ix, mut row) in rows.into_iter().enumerate() {
                if let Row::Work { live, .. } = &mut row {
                    *live = ix == last;
                }
                out.push(row);
            }
            continue;
        }
        let answer_from = rows
            .iter()
            .rposition(|row| !matches!(row, Row::Text(_)))
            .map_or(0, |ix| ix + 1);
        let hidden_from = rows
            .iter()
            .position(|row| !matches!(row, Row::Prompt(_)))
            .unwrap_or(rows.len());
        let expanded = open.contains(&turn);
        let mut visible_answer = false;
        for (ix, row) in rows.into_iter().enumerate() {
            if ix == hidden_from && hidden_from < answer_from {
                out.push(Row::Summary {
                    turn: turn.clone(),
                    open: expanded,
                });
            }
            let hidden = ix >= hidden_from && ix < answer_from;
            if hidden && !expanded {
                continue;
            }
            visible_answer |= ix >= answer_from && matches!(row, Row::Text(_));
            out.push(row);
        }
        if let Some((_, Ending::Failed(message))) = state.and_then(|state| state.ended.as_ref()) {
            out.push(Row::Notice {
                turn: turn.clone(),
                text: format!("运行失败：{message}"),
            });
        }
        if visible_answer {
            out.push(Row::Footer { turn });
        }
    }
    if running.is_some() {
        out.push(Row::Working);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rows() -> Vec<Value> {
        vec![
            json!({"type":"user","id":"u1","turnId":"t1","ts":1000,"text":"fix it"}),
            json!({"type":"assistant","id":"a1","turnId":"t1","text":"Looking.","thinking":{"text":"plan"}}),
            json!({"type":"tool_call","id":"c1","turnId":"t1","toolName":"Shell","args":{"command":"ls"}}),
            json!({"type":"tool_result","id":"r1","turnId":"t1","toolUseId":"c1","isError":false,"content":{"kind":"text","text":"a.rs"}}),
            json!({"type":"assistant","id":"a2","turnId":"t1","text":"Done."}),
            json!({"type":"turn_state","id":"s1","turnId":"t1","ts":66000,"status":"completed"}),
        ]
    }

    fn kinds(rows: &[Row], entries: &[Entry]) -> Vec<String> {
        rows.iter().map(|row| row.key(entries)).collect()
    }

    #[test]
    fn a_settled_turn_folds_its_work_above_the_answer() {
        let rows = rows();
        let transcript = transcript(&rows, []);
        let folded = fold(&transcript, None, &HashSet::new());
        assert_eq!(
            kinds(&folded, &transcript.entries),
            ["prompt:u1", "summary:t1", "text:a2", "footer:t1"]
        );
        let Entry::Tool { result, .. } = &transcript.entries[3] else {
            panic!("{:?}", transcript.entries[3]);
        };
        assert_eq!(result.as_ref().unwrap().output, "a.rs");
        assert_eq!(transcript.turns["t1"].started, Some(1000));
    }

    #[test]
    fn blank_text_between_calls_is_neither_shown_nor_counted() {
        let mut rows = rows();
        rows.insert(
            4,
            json!({"type":"assistant","id":"a9","turnId":"t1","text":"\n\n"}),
        );
        rows.insert(
            5,
            json!({"type":"tool_call","id":"c2","turnId":"t1","toolName":"Shell","args":{"command":"pwd"}}),
        );
        let transcript = transcript(&rows, []);
        let open = HashSet::from(["t1".to_owned()]);
        let folded = fold(&transcript, None, &open);
        let Some(Row::Work { items, .. }) = folded
            .iter()
            .find(|row| row.key(&transcript.entries) == "work:c1")
        else {
            panic!("{:?}", kinds(&folded, &transcript.entries));
        };
        assert_eq!(items.len(), 2, "both calls, no blank text between them");
    }

    #[test]
    fn opening_the_fold_shows_the_work_in_order() {
        let rows = rows();
        let transcript = transcript(&rows, []);
        let open = HashSet::from(["t1".to_owned()]);
        let folded = fold(&transcript, None, &open);
        assert_eq!(
            kinds(&folded, &transcript.entries),
            [
                "prompt:u1",
                "summary:t1",
                "work:a1",
                "text:a1",
                "work:c1",
                "text:a2",
                "footer:t1",
            ]
        );
    }

    #[test]
    fn a_running_turn_shows_everything_and_only_its_last_group_is_live() {
        let rows = &rows()[..4];
        let transcript = transcript(rows, []);
        let folded = fold(&transcript, Some("t1"), &HashSet::new());
        assert_eq!(
            kinds(&folded, &transcript.entries),
            ["prompt:u1", "work:a1", "text:a1", "work:c1", "working"]
        );
        assert!(matches!(folded[1], Row::Work { live: false, .. }));
        assert!(matches!(folded[3], Row::Work { live: true, .. }));
    }

    #[test]
    fn live_text_joins_until_its_row_lands() {
        let rows = &rows()[..1];
        let live = Entry::Text {
            id: "a1".into(),
            turn: "t1".into(),
            text: "Look".into(),
            streaming: true,
        };
        let partial = transcript(rows, [live.clone()]);
        assert_eq!(partial.entries.len(), 2);
        let all = rows_with_answer();
        let settled = transcript(&all, [live]);
        assert_eq!(
            settled
                .entries
                .iter()
                .filter(|entry| entry.id() == "a1")
                .count(),
            1
        );
    }

    fn rows_with_answer() -> Vec<Value> {
        let mut rows = rows()[..1].to_vec();
        rows.push(json!({"type":"assistant","id":"a1","turnId":"t1","text":"Looking."}));
        rows
    }

    #[test]
    fn a_failed_turn_says_so_and_a_tool_only_turn_has_no_footer() {
        let rows = vec![
            json!({"type":"user","id":"u1","turnId":"t1","ts":0,"text":"go"}),
            json!({"type":"tool_call","id":"c1","turnId":"t1","toolName":"Shell","args":{}}),
            json!({"type":"turn_state","id":"s","turnId":"t1","ts":5,"status":"failed","failureMessage":"quota"}),
        ];
        let transcript = transcript(&rows, []);
        let folded = fold(&transcript, None, &HashSet::new());
        assert_eq!(
            kinds(&folded, &transcript.entries),
            ["prompt:u1", "summary:t1", "notice:t1"]
        );
    }
}
