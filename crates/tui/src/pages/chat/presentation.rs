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

//! Native observation projection. No Session authority is inferred by the shared widget.
use super::*;
use crate::ui::transcript::{Kind, MessageKey, Outcome, Part, Revision, Timing, Transcript};
use std::collections::{HashMap, HashSet};
#[derive(Default)]
pub struct Presentation {
    pub active_turn: Option<String>,
    waiting: HashSet<(String, String)>,
    branchable: HashMap<MessageKey, Revision>,
    timings: HashMap<String, Timing>,
}
impl Presentation {
    #[cfg(test)]
    pub(crate) fn wait_for(&mut self, turn: &str, id: &str) {
        self.waiting.insert((turn.into(), id.into()));
    }

    pub(crate) fn interactions(
        &mut self,
        projection: &maka_protocol::interaction::SessionInteractionProjection,
    ) {
        use maka_protocol::interaction::InteractionRequest;
        self.waiting = projection
            .pending()
            .iter()
            .filter_map(|pending| {
                let id = match pending.request() {
                    InteractionRequest::Permissions { tool_use_id, .. } => tool_use_id.as_deref(),
                    InteractionRequest::Question { tool_use_id, .. }
                    | InteractionRequest::Form { tool_use_id, .. }
                    | InteractionRequest::ClientCapability { tool_use_id, .. } => {
                        Some(tool_use_id.as_str())
                    }
                }?;
                Some((pending.turn_id().into(), id.into()))
            })
            .collect();
    }
    pub fn sync(
        &mut self,
        view: &mut Transcript,
        rows: &BTreeMap<u64, Value>,
        live: &[(SessionAssistantStreamIdentity, LiveText)],
        live_revision: u64,
        i18n: &I18n,
        ascii: bool,
    ) {
        view.begin();
        self.branchable.clear();
        let trace = view.trace;
        let tools = tools::Index::new(rows);
        let latest: BTreeMap<_, _> = rows
            .iter()
            .filter(|(_, row)| row["type"] == "turn_state")
            .map(|(sequence, row)| (row["turnId"].as_str().unwrap(), *sequence))
            .collect();
        for (sequence, row) in rows {
            let kind = row["type"].as_str().unwrap();
            if matches!(kind, "tool_call" | "tool_result") {
                match tools.entry(row) {
                    tools::Entry::Consumed => continue,
                    tools::Entry::Card(card) => {
                        let state = card.state(
                            self.waiting
                                .iter()
                                .any(|(turn, id)| turn == card.turn && id == card.id),
                        );
                        if !view.trace
                            && card.internal()
                            && matches!(state, tools::State::Pending | tools::State::Returned)
                        {
                            continue;
                        }
                        view.upsert(
                            MessageKey::new(card.turn, card.id, Part::Tool),
                            Revision::Tool {
                                call: card.call.map(|(seq, _)| seq),
                                result: card.result.map(|(seq, _)| seq),
                                trace,
                            },
                            Kind::Tool(state),
                            || card.text(state, i18n, trace),
                        );
                        view.metadata(
                            &MessageKey::new(card.turn, card.id, Part::Tool),
                            None,
                            card.activity(),
                        );
                        continue;
                    }
                    tools::Entry::Raw => {}
                }
            }
            if kind == "turn_state" && latest.get(row["turnId"].as_str().unwrap()) != Some(sequence)
            {
                continue;
            }
            if !view.trace
                && (kind == "token_usage"
                    || (kind == "turn_state"
                        && matches!(
                            row["status"].as_str(),
                            Some("completed" | "running" | "waiting_for_user")
                        )))
            {
                continue;
            }
            let mut key = durable(row);
            let branchable = matches!(kind, "user" | "assistant") && row["imported"] != true;
            if kind == "assistant"
                && let Some(thinking) = row["thinking"]["text"].as_str()
            {
                if !thinking.trim().is_empty() {
                    view.upsert(
                        key.clone(),
                        Revision::Durable(*sequence),
                        Kind::Thinking,
                        || thinking.to_owned().into(),
                    );
                    if branchable {
                        self.branchable
                            .insert(key.clone(), Revision::Durable(*sequence));
                    }
                }
                if row["text"]
                    .as_str()
                    .is_none_or(|text| text.trim().is_empty())
                {
                    continue;
                }
                key = MessageKey::new(key.turn(), key.message(), Part::Text);
            }
            let presentation = match kind {
                "user" => Kind::User,
                "assistant" => Kind::Assistant,
                "system_note" if row["kind"] == "imported" => Kind::Meta,
                "tool_call" | "tool_result" => Kind::Other,
                "turn_state" if row["status"].as_str() == Some("failed") => Kind::Failure,
                "turn_state" | "token_usage" => Kind::Meta,
                _ => Kind::Other,
            };
            view.upsert(
                key.clone(),
                Revision::Durable(*sequence),
                presentation,
                || project(row, i18n, ascii).into(),
            );
            if branchable {
                self.branchable
                    .insert(key.clone(), Revision::Durable(*sequence));
            }
            if matches!(presentation, Kind::User | Kind::Assistant) {
                view.metadata(&key, row["ts"].as_u64(), None);
            }
        }
        for (id, stream) in live {
            if stream.text.trim().is_empty() {
                continue;
            }
            view.upsert(
                live_key(id),
                Revision::Live(live_revision),
                if id.kind == AssistantStreamKind::Thinking {
                    Kind::Thinking
                } else {
                    Kind::Assistant
                },
                || stream.text.clone().into(),
            );
        }
        self.sync_timings(rows, live);
        let active_turn = self.active_turn.clone();
        view.finish(
            self.timings.values().cloned().map(|mut timing| {
                timing.active = active_turn.as_ref() == Some(&timing.turn);
                timing
            }),
            i18n,
        );
    }

    pub fn branch_point<'a>(&self, view: &'a Transcript) -> Option<(&'a str, &'a str)> {
        let selected = view.selected()?;
        (self.branchable.get(selected.key) == Some(selected.revision))
            .then_some((selected.key.turn(), selected.text))
    }
    fn sync_timings(
        &mut self,
        rows: &BTreeMap<u64, Value>,
        live: &[(SessionAssistantStreamIdentity, LiveText)],
    ) {
        let retained: HashSet<&str> = rows
            .values()
            .filter_map(|row| row["turnId"].as_str())
            .chain(live.iter().map(|(id, _)| id.turn_id.as_str()))
            .collect();
        self.timings
            .retain(|turn, _| retained.contains(turn.as_str()));
        for row in rows.values().filter(|row| row["type"] == "turn_state") {
            let (Some(turn), Some(at), Some(status)) = (
                row["turnId"].as_str(),
                row["ts"].as_i64(),
                row["status"].as_str(),
            ) else {
                continue;
            };
            if at < 0 {
                continue;
            }
            let timing = self.timings.entry(turn.into()).or_insert_with(|| Timing {
                turn: turn.into(),
                ..Default::default()
            });
            match status {
                "running" => timing.start = Some(timing.start.map_or(at, |start| start.min(at))),
                "completed" => timing.end = Some((at, Outcome::Completed)),
                "failed" => timing.end = Some((at, Outcome::Failed)),
                "aborted" => timing.end = Some((at, Outcome::Aborted)),
                _ => {}
            }
        }
    }
}
pub(crate) fn durable(row: &Value) -> MessageKey {
    MessageKey::new(
        row["turnId"].as_str().unwrap(),
        row["id"].as_str().unwrap(),
        if row["thinking"]["text"].is_string() {
            Part::Thinking
        } else {
            Part::Text
        },
    )
}
pub(crate) fn live_key(id: &SessionAssistantStreamIdentity) -> MessageKey {
    MessageKey::new(
        &id.turn_id,
        &id.message_id,
        if id.kind == AssistantStreamKind::Thinking {
            Part::Thinking
        } else {
            Part::Text
        },
    )
}
fn project(row: &Value, i18n: &I18n, ascii: bool) -> String {
    match row["type"].as_str().unwrap() {
        "user" => Some(prompt_content(row, ascii)),
        "assistant" => row["text"].as_str().map(str::to_owned),
        "system_note" if row["kind"] == "imported" => {
            row["data"]["text"].as_str().map(str::to_owned)
        }
        "turn_state" => {
            let key = match row["status"].as_str() {
                Some("running") => "session-running",
                Some("completed") => "chat-completed",
                Some("aborted") => "session-aborted",
                Some("failed") => "chat-run-failed",
                _ => "chat-state-unknown",
            };
            Some(format!(
                "{}\n{}",
                i18n.text(key),
                row["failureMessage"].as_str().unwrap_or("")
            ))
        }
        "token_usage" => Some(format!(
            "{} {} · {} {}",
            if ascii { "in" } else { "↑" },
            row["input"],
            if ascii { "out" } else { "↓" },
            row["output"]
        )),
        "tool_call" | "tool_result" => Some(row.to_string()),
        _ => None,
    }
    .unwrap_or_else(|| row.to_string())
}

pub(crate) fn prompt_content(row: &Value, ascii: bool) -> String {
    let mut text = row["displayText"]
        .as_str()
        .or_else(|| row["text"].as_str())
        .unwrap_or("")
        .to_owned();
    for attachment in row["attachments"].as_array().into_iter().flatten() {
        let Some(name) = attachment["name"].as_str() else {
            continue;
        };
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(if ascii { "+ " } else { "↳ " });
        text.push_str(&crate::view::safe(name));
        if let Some(bytes) = attachment["bytes"].as_u64() {
            text.push_str(" · ");
            text.push_str(&crate::pages::attachments::size(bytes));
        }
    }
    for reference in row["directoryReferences"].as_array().into_iter().flatten() {
        if let Some(path) = reference["path"].as_str() {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(if ascii { "/ " } else { "▱ " });
            text.push_str(&crate::view::safe(path));
        }
    }
    text
}

#[cfg(test)]
pub(crate) mod testing {
    pub(crate) use maka_client::transcript::LiveText;
    pub(crate) use maka_protocol::subscription::{
        AssistantStreamKind, SessionAssistantStreamIdentity,
    };
    pub(crate) use serde_json::Value;
    pub(crate) use std::collections::BTreeMap;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{Locale, LocalePreference};
    #[test]
    fn semantic_identity_and_selection_do_not_grant_native_branch_authority() {
        let i18n = I18n::new(LocalePreference::Explicit(Locale::En), Locale::En);
        let rows = BTreeMap::from([(
            1,
            serde_json::json!({"type":"user","turnId":"turn","id":"message","text":"Native prompt"}),
        )]);
        let mut presentation = Presentation::default();
        let mut view = Transcript::default();
        presentation.sync(&mut view, &rows, &[], 0, &i18n, false);
        let key = durable(&rows[&1]);
        view.select(key.clone());
        assert_eq!(
            presentation.branch_point(&view),
            Some(("turn", "Native prompt"))
        );
        view.begin();
        view.upsert(
            key.clone(),
            Revision::External("1".into()),
            Kind::User,
            || "Unrelated plugin content".to_owned().into(),
        );
        view.finish([], &i18n);
        view.select(key);
        assert!(presentation.branch_point(&view).is_none());
    }
}
