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

//! Presentation only: canonical identities pair calls; names affect labels, not execution.
use crate::i18n::I18n;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use unicode_segmentation::UnicodeSegmentation;

mod changes;
mod outcome;

pub(super) use crate::ui::transcript::{Activity, Content, ToolState as State};

type Identity<'a> = (&'a str, &'a str);
type Row<'a> = (u64, &'a Value);

pub(super) struct Card<'a> {
    pub turn: &'a str,
    pub id: &'a str,
    pub call: Option<Row<'a>>,
    pub result: Option<Row<'a>>,
    pub closed: bool,
}
impl Card<'_> {
    fn patch(&self) -> bool {
        self.call.is_some_and(|(_, call)| {
            call["toolName"] == "apply_patch"
                && matches!(call["origin"].as_str(), Some("provider" | "code_mode"))
        })
    }
    pub fn activity(&self) -> Option<Activity> {
        let (_, call) = self.call?;
        if !matches!(call["origin"].as_str(), Some("provider" | "code_mode")) {
            return None;
        }
        match call["toolName"].as_str()? {
            "Read" => Some(Activity::Read),
            "Glob" | "Grep" => Some(Activity::Search),
            _ => None,
        }
    }
    pub fn internal(&self) -> bool {
        self.call.is_some_and(|(_, call)| {
            matches!(
                (call["origin"].as_str(), call["toolName"].as_str()),
                (Some("provider"), Some("exec" | "wait" | "tool_search"))
                    | (Some("code_mode"), Some("code_cell" | "tool_search"))
            )
        })
    }
    pub fn state(&self, waiting: bool) -> State {
        if let Some((_, result)) = self.result {
            if result["isError"] == true
                || (self.patch() && changes::patch::failed(&result["content"]))
            {
                State::Attention
            } else {
                outcome::shell(self.call.map(|(_, call)| call), &result["content"])
                    .unwrap_or(State::Returned)
            }
        } else if self
            .call
            .is_some_and(|(_, call)| call["origin"] == "imported")
        {
            State::Missing
        } else if waiting {
            State::Waiting
        } else if self.closed {
            State::Missing
        } else {
            State::Pending
        }
    }
    pub fn text(&self, state: State, i18n: &I18n, trace: bool) -> Content {
        let name = self
            .call
            .map(|(_, call)| call["toolName"].as_str().unwrap());
        let parent = self
            .call
            .or(self.result)
            .and_then(|(_, call)| call["parentToolCallId"].as_str());
        let mut change_text = String::new();
        let patch_result = (!trace && self.patch())
            .then(|| {
                self.result
                    .filter(|(_, result)| {
                        result["isError"] == false || changes::patch::failed(&result["content"])
                    })
                    .and_then(|(_, result)| changes::patch::result(&result["content"], i18n))
            })
            .flatten();
        let changes = (!trace)
            .then(|| {
                self.call.and_then(|(_, call)| {
                    changes::append(
                        call,
                        self.result.map(|(_, result)| result),
                        &mut change_text,
                        i18n,
                    )
                })
            })
            .flatten();
        let patch_failure = !trace && self.patch() && state == State::Attention;
        let mut text = String::new();
        let mut file = None;
        let label = match name {
            Some("Shell") => i18n.text("tool-run"),
            Some("Read") => i18n.text("tool-read"),
            Some("Glob" | "Grep") => i18n.text("tool-search"),
            Some("AskUserQuestion") => i18n.text("tool-question"),
            Some("apply_patch") => i18n.text("tool-patch"),
            Some(name) => name
                .strip_prefix("mcp__")
                .and_then(|qualified| qualified.split_once("__"))
                .filter(|(server, tool)| !server.is_empty() && !tool.is_empty())
                .map_or_else(
                    || preview(name),
                    |(server, tool)| format!("{} · {}", preview(tool), preview(server)),
                ),
            None => i18n.text("tool-earlier"),
        };
        text.push_str(&label);
        if matches!(state, State::Waiting | State::Missing) || state.problem() {
            text.push_str(&format!(" · {}", i18n.text(state.label())));
        }
        if let Some((_, call)) = self.call {
            let args = &call["args"];
            if let Some(summary) = ["command", "path", "file_path", "pattern", "query", "code"]
                .into_iter()
                .find_map(|key| args[key].as_str())
                .or_else(|| {
                    self.patch()
                        .then(|| args["operation"]["path"].as_str())
                        .flatten()
                })
            {
                text.push_str(" · ");
                let start = text.len();
                text.push_str(&preview(summary));
                if !trace
                    && matches!(call["origin"].as_str(), Some("provider" | "code_mode"))
                    && matches!(name, Some("Read" | "Edit" | "Write" | "apply_patch"))
                    && crate::files::valid_path(summary)
                {
                    let path = self
                        .result
                        .filter(|(_, result)| result["isError"] == false)
                        .and_then(|(_, result)| result["content"]["value"]["path"].as_str())
                        .filter(|path| crate::files::valid_path(path))
                        .unwrap_or(summary);
                    file = Some(crate::files::Link {
                        source: start..text.len(),
                        path: path.into(),
                    });
                }
            }
        }
        if state.problem()
            && let Some((_, result)) = self.result
        {
            let summary = patch_result
                .as_deref()
                .and_then(|text| text.lines().next())
                .map(str::to_owned)
                .or_else(|| {
                    outcome::summary(self.call.map(|(_, call)| call), &result["content"], i18n)
                })
                .unwrap_or_else(|| output(&result["content"]));
            text.push_str(&format!(" · {}", preview(&summary)));
        }
        text.push('\n');
        if !patch_failure
            && patch_result.is_none()
            && (changes.is_none() || state != State::Returned)
        {
            text.push_str(&format!("{}\n", i18n.text(state.label())));
        }
        if trace && let Some(name) = name {
            text.push_str(&format!("{}: {name}\n", i18n.text("tool-name")));
        }
        if trace && let Some(parent) = parent {
            text.push_str(&format!("{}: {parent}\n", i18n.text("tool-parent")));
        }
        if patch_failure {
            if let Some((_, details)) = patch_result
                .as_deref()
                .and_then(|text| text.split_once('\n'))
            {
                text.push_str(details);
                text.push('\n');
            } else if let Some((_, result)) = self.result {
                let content = &result["content"];
                let plain = content["kind"] == "text"
                    && content["text"].is_string()
                    && content.as_object().is_some_and(|fields| fields.len() == 2);
                let full = if plain {
                    output(content)
                } else {
                    content.to_string()
                };
                // A complete short text error is already in the title. Keep
                // structured evidence and truncated details before the request.
                if !plain || full.graphemes(true).take(161).count() > 160 {
                    text.push_str(&full);
                    text.push('\n');
                }
            }
        }
        let changes = changes.map(|mut rows| {
            let offset = text.len();
            text.push_str(&change_text);
            for row in &mut rows {
                row.source.start += offset;
                row.source.end += offset;
            }
            rows
        });
        if changes.is_none()
            && let Some((_, call)) = self.call
            && !call["args"].as_object().is_some_and(|args| args.is_empty())
        {
            text.push_str(&format!("\n{}\n", i18n.text("tool-arguments")));
            if let Some(args) = call["args"].as_object() {
                for (key, value) in args {
                    text.push_str(key);
                    text.push_str(": ");
                    text.push_str(&value_text(value));
                    text.push('\n');
                }
            } else {
                text.push_str(&call["args"].to_string());
            }
        }
        if let Some((_, result)) = self.result
            && !patch_failure
        {
            let change_result = patch_result.or_else(|| {
                (changes.is_some() && state == State::Returned)
                    .then(|| changes::result(name?, &result["content"]))
                    .flatten()
            });
            if let Some(summary) = change_result {
                if !summary.is_empty() {
                    text.push_str(&format!("\n{summary}"));
                }
            } else {
                text.push_str(&format!("\n{}\n", i18n.text("tool-result")));
                let readable =
                    (!trace && state == State::Returned && self.activity() == Some(Activity::Read))
                        .then(|| read_page(&result["content"], i18n))
                        .flatten();
                text.push_str(&readable.unwrap_or_else(|| output(&result["content"])));
            }
        }
        Content {
            emphasis: Some(0..label.len()),
            text,
            changes: changes.unwrap_or_default(),
            file,
        }
    }
}

// Render only the exact native text page shape. Future metadata, images and
// malformed counters stay inspectable as JSON, never silently discarded.
fn read_page(content: &Value, i18n: &I18n) -> Option<String> {
    if content["kind"] != "json" {
        return None;
    }
    let value = &content["value"];
    let object = value.as_object()?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "content" | "offset" | "returnedLines" | "totalLines" | "next" | "partialLine"
        )
    }) {
        return None;
    }
    let body = value["content"].as_str()?;
    let offset = value["offset"].as_u64()?;
    let count = value["returnedLines"].as_u64()?;
    let total = value["totalLines"].as_u64()?;
    let end = offset.checked_add(count)?;
    if end > total
        || value
            .get("partialLine")
            .is_some_and(|value| !value.is_boolean())
    {
        return None;
    }
    let next = value.get("next")?;
    if !next.is_null() && !next.is_object() {
        return None;
    }
    let mut text = if count == 0 {
        i18n.format("tool-read-empty", &[("total", &total.to_string())])
    } else {
        i18n.format(
            "tool-read-range",
            &[
                ("start", &offset.checked_add(1)?.to_string()),
                ("end", &end.to_string()),
                ("total", &total.to_string()),
            ],
        )
    };
    text.push('\n');
    text.push_str(body);
    if value["partialLine"] == true {
        text.push_str(&format!("\n{}", i18n.text("tool-read-partial")));
    }
    if !next.is_null() {
        text.push_str(&format!("\n{}\n{next}", i18n.text("tool-read-next")));
    }
    Some(text)
}

fn value_text(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}
fn output(content: &Value) -> String {
    match content["kind"].as_str() {
        Some("text") => value_text(&content["text"]),
        Some("json") => {
            text_content(&content["value"]).unwrap_or_else(|| value_text(&content["value"]))
        }
        _ => content.to_string(), // Keep image references and unknown payloads inspectable.
    }
}

// Recognize only the exact text-only content envelope; unknown metadata or
// mixed media stays visible in raw JSON rather than silently losing information.
fn text_content(value: &Value) -> Option<String> {
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    let parts = object.get("content")?.as_array()?;
    if parts.is_empty() {
        return None;
    }
    parts
        .iter()
        .map(|part| {
            let object = part.as_object()?;
            if object.len() != 2 || part["type"] != "text" {
                return None;
            }
            part["text"].as_str()
        })
        .collect::<Option<Vec<_>>>()
        .map(|text| text.join("\n\n"))
}
fn preview(value: &str) -> String {
    value
        .graphemes(true)
        .take(160)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Only unique, same-Turn identities pair. Ambiguous or future-schema rows
/// remain independent raw records instead of disappearing behind a guessed card.
pub(super) struct Index<'a> {
    calls: HashMap<Identity<'a>, Option<Row<'a>>>,
    results: HashMap<Identity<'a>, Option<Row<'a>>>,
    closed: HashMap<&'a str, bool>,
}
pub(super) enum Entry<'a> {
    Card(Card<'a>),
    Consumed,
    Raw,
}
impl<'a> Index<'a> {
    pub fn new(rows: &'a BTreeMap<u64, Value>) -> Self {
        let mut index = Self {
            calls: HashMap::new(),
            results: HashMap::new(),
            closed: HashMap::new(),
        };
        for (&sequence, row) in rows {
            let turn = row["turnId"].as_str().unwrap();
            let (map, id) = match row["type"].as_str() {
                Some("tool_call") if row["toolName"].is_string() && row.get("args").is_some() => {
                    (&mut index.calls, row["id"].as_str())
                }
                Some("tool_result")
                    if row["isError"].is_boolean() && row["content"].is_object() =>
                {
                    (&mut index.results, row["toolUseId"].as_str())
                }
                Some("turn_state") => {
                    index.closed.insert(
                        turn,
                        matches!(
                            row["status"].as_str(),
                            Some("completed" | "failed" | "aborted")
                        ),
                    );
                    continue;
                }
                _ => continue,
            };
            if let Some(id) = id.filter(|id| !id.is_empty()) {
                map.entry((turn, id))
                    .and_modify(|old| *old = None)
                    .or_insert(Some((sequence, row)));
            }
        }
        index
    }
    pub fn entry(&self, row: &'a Value) -> Entry<'a> {
        let turn = row["turnId"].as_str().unwrap();
        let is_call = row["type"] == "tool_call";
        let Some(id) = row[if is_call { "id" } else { "toolUseId" }].as_str() else {
            return Entry::Raw;
        };
        let key = (turn, id);
        let call = self.calls.get(&key);
        let result = self.results.get(&key);
        if matches!(call, Some(None)) || matches!(result, Some(None)) {
            return Entry::Raw;
        }
        let call = call.copied().flatten();
        let result = result.copied().flatten();
        if (is_call && call.is_none()) || (!is_call && result.is_none()) {
            return Entry::Raw;
        }
        let indexed = if is_call { call } else { result };
        if indexed.is_none_or(|(_, value)| !std::ptr::eq(value, row)) {
            return Entry::Raw;
        }
        if let (Some((call_seq, call)), Some((result_seq, result))) = (call, result)
            && (call_seq > result_seq
                || ["origin", "parentToolCallId", "parentOperationId"]
                    .into_iter()
                    .any(|key| call[key] != result[key]))
        {
            return Entry::Raw;
        }
        if !is_call && call.is_some() {
            return Entry::Consumed;
        }
        Entry::Card(Card {
            turn,
            id,
            call,
            result,
            closed: self.closed.get(turn).copied().unwrap_or(false),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_read_pages_keep_text_ranges_continuations_and_raw_diagnostics_separate() {
        use crate::i18n::{Locale, LocalePreference};
        let call = json!({"toolName":"Read","origin":"code_mode","parentToolCallId":"cell","args":{"path":"source.rs"}});
        let result = json!({"isError":false,"content":{"kind":"json","value":{
            "content":"first\n中文🦀\n","offset":4,"returnedLines":2,"totalLines":10,
            "partialLine":true,"next":{"path":"maka://read/continuation"}
        }}});
        let original = result.clone();
        let card = Card {
            turn: "t",
            id: "call",
            call: Some((1, &call)),
            result: Some((2, &result)),
            closed: true,
        };
        for locale in Locale::ALL {
            let i18n = I18n::new(LocalePreference::Explicit(locale), locale);
            let text = card.text(State::Returned, &i18n, false).text;
            assert!(text.contains("first\n中文🦀\n"));
            assert!(text.contains("5–6") && text.contains("10"));
            assert!(text.contains("maka://read/continuation"));
            assert!(!text.contains("returnedLines") && !text.contains("cell"));
            let trace = card.text(State::Returned, &i18n, true).text;
            assert!(trace.contains("returnedLines") && trace.contains("cell"));
            assert!(i18n.diagnostics().is_empty());
            for (field, value) in [
                ("metadata", json!({"resource":"preserve"})),
                ("returnedLines", json!(20)),
                ("partialLine", json!("true")),
            ] {
                let mut unknown = result["content"].clone();
                unknown["value"][field] = value;
                assert!(
                    read_page(&unknown, &i18n).is_none(),
                    "unknown evidence must remain raw"
                );
            }
        }
        assert_eq!(result, original);
    }

    #[test]
    fn pairing_never_hides_ambiguous_malformed_foreign_or_mismatched_records() {
        let content =
            json!({"kind":"json","value":{"content":[{"type":"text","text":"中文🦀\nline two"}]}});
        assert_eq!(output(&content), "中文🦀\nline two");
        let mut extended = content;
        extended["value"]["metadata"] = json!({"retain":"evidence"});
        assert!(output(&extended).contains("evidence"));
        let call = json!({"turnId":"a","id":"call","type":"tool_call","toolName":"Shell","args":{},"origin":"provider"});
        let result = json!({"turnId":"a","id":"result","type":"tool_result","toolUseId":"call","isError":true,"content":{"kind":"text","text":"denied"},"origin":"provider"});
        let normal = BTreeMap::from([(1, call.clone()), (2, result.clone())]);
        let index = Index::new(&normal);
        let Entry::Card(card) = index.entry(&normal[&1]) else {
            panic!("paired card")
        };
        assert!(card.state(false) == State::Attention);
        assert!(matches!(index.entry(&normal[&2]), Entry::Consumed));
        for mutate in 0..4 {
            let mut rows = normal.clone();
            match mutate {
                0 => {
                    rows.get_mut(&2).unwrap()["origin"] = json!("code_mode");
                }
                1 => {
                    rows.insert(3, result.clone());
                }
                2 => {
                    rows.get_mut(&2).unwrap()["isError"] = json!("false");
                }
                _ => {
                    rows.remove(&1);
                    rows.insert(3, call.clone());
                }
            }
            let index = Index::new(&rows);
            assert!(
                rows.values()
                    .all(|row| !matches!(index.entry(row), Entry::Consumed))
            );
        }
        let mut foreign = result;
        foreign["turnId"] = json!("b");
        let rows = BTreeMap::from([(1, call), (2, foreign)]);
        let index = Index::new(&rows);
        let Entry::Card(call) = index.entry(&rows[&1]) else {
            panic!("call")
        };
        let Entry::Card(orphan) = index.entry(&rows[&2]) else {
            panic!("orphan")
        };
        assert!(call.result.is_none() && orphan.call.is_none());
    }
}
