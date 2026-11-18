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

use maka_agent_ports::session::history::{Role, RowPosition};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "RecallQuery")]
pub struct Query {
    /// Supply 1 to 32 search terms of at most 256 UTF-8 bytes each.
    #[schemars(length(min = 1, max = 32), inner(length(min = 1)))]
    pub terms: Vec<String>,
    /// Resume current memory facts after the last returned key.
    pub facts_after: Option<u64>,
    /// An explicit caller-selected result budget; omission retains all matching results.
    #[schemars(range(min = 1))]
    pub limit: Option<usize>,
    #[schemars(length(min = 1))]
    pub session_id: Option<String>,
    pub since: Option<u64>,
    pub until: Option<u64>,
}
impl Query {
    pub fn validate(&mut self) -> Result<(), String> {
        if !(1..=32).contains(&self.terms.len()) {
            return Err("Recall requires 1 to 32 terms".into());
        }
        if self.terms.iter().any(|term| term.len() > 256) {
            return Err("Each Recall term must fit in 256 UTF-8 bytes".into());
        }
        if self.facts_after.is_some_and(|n| n > 9_007_199_254_740_991)
            || self.limit.is_some_and(|n| n == 0)
            || self.since.zip(self.until).is_some_and(|(a, b)| a > b)
            || self.session_id.as_ref().is_some_and(|text| !nonempty(text))
        {
            return Err(
                "Recall requires a safe facts_after cursor, a positive limit and valid Session/time bounds"
                    .into(),
            );
        }
        for term in &mut self.terms {
            if !nonempty(term) {
                return Err("Recall terms must be nonempty".into());
            }
            *term = term.trim().nfc().collect();
        }
        let mut seen = std::collections::BTreeSet::new();
        // Keep non-ASCII variants that FTS5's unicode61 tokenizer can index separately.
        self.terms
            .retain(|term| seen.insert(term.to_ascii_lowercase()));
        Ok(())
    }
}
#[derive(Clone, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "RecallToolQuery")]
pub struct ToolQuery {
    /// Continue the current rendered result with the byte offset returned by the previous call.
    pub output_offset: Option<usize>,
    /// Supply 1 to 32 search terms of at most 256 UTF-8 bytes each.
    #[schemars(length(min = 1, max = 32), inner(length(min = 1)))]
    pub terms: Vec<String>,
    /// Resume current memory facts after the last returned key.
    pub facts_after: Option<u64>,
    /// An explicit caller-selected result budget; omission retains all matching results.
    #[schemars(range(min = 1))]
    pub limit: Option<usize>,
    #[schemars(length(min = 1))]
    pub session_id: Option<String>,
    pub since: Option<u64>,
    pub until: Option<u64>,
    /// Neighboring messages before each anchor (default 4; pass 0 with after: 0 for anchor-only scan).
    pub before: Option<usize>,
    /// Neighboring messages after each anchor (default 4; pass 0 with before: 0 for anchor-only scan).
    pub after: Option<usize>,
}
impl ToolQuery {
    pub fn into_parts(self) -> Result<(Query, usize, usize), String> {
        let mut query = Query {
            terms: self.terms,
            facts_after: self.facts_after,
            limit: self.limit,
            session_id: self.session_id,
            since: self.since,
            until: self.until,
        };
        query.validate()?;
        Ok((query, self.before.unwrap_or(4), self.after.unwrap_or(4)))
    }
}
#[derive(Clone, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct More {
    /// Continue the current rendered result with the byte offset returned by the previous call.
    pub output_offset: Option<usize>,
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(length(min = 1))]
    pub anchor_message_id: String,
    pub before: Option<usize>,
    pub after: Option<usize>,
}
impl More {
    pub fn validate(&self) -> Result<(), String> {
        if !nonempty(&self.session_id) || !nonempty(&self.anchor_message_id) {
            Err("RecallMore requires an existing Session/message".into())
        } else {
            Ok(())
        }
    }
}
fn nonempty(text: &str) -> bool {
    !text.trim().is_empty() && !text.contains('\0')
}
pub(super) fn fold(text: &str) -> String {
    text.nfc().collect::<String>().to_lowercase()
}

#[derive(Clone, Serialize)]
pub struct PassageMessage {
    pub message_id: String,
    pub role: Role,
    pub text: String,
    pub timestamp: u64,
    pub is_anchor: bool,
    pub attachments: Vec<maka_agent_facts::attachment::AttachmentRef>,
}
#[derive(Serialize)]
pub struct Passage {
    pub session_id: String,
    pub session_title: String,
    pub anchor_message_id: String,
    pub anchor_position: RowPosition,
    pub through: u64,
    pub turn_id: String,
    pub messages: Vec<PassageMessage>,
    pub matched_terms: Vec<String>,
    pub score: f64,
    pub has_more_before: bool,
    pub has_more_after: bool,
}
#[derive(Serialize)]
pub struct ResultSet {
    pub facts: Vec<maka_agent_facts::memory::RecallFact>,
    pub next_facts_after: Option<u64>,
    pub passages: Vec<Passage>,
    pub searched_every_session: bool,
    pub gaps: Vec<String>,
}
impl ResultSet {
    pub fn render(&self) -> String {
        let mut text = format!("Search complete: {}\n", self.searched_every_session);
        for fact in &self.facts {
            text.push_str(&format!(
                "Memory fact: {}\n",
                serde_json::to_string(fact).expect("serializable memory fact")
            ));
        }
        if let Some(after) = self.next_facts_after {
            text.push_str(&format!("Continue facts with facts_after={after}\n"));
        }
        for gap in &self.gaps {
            text.push_str(&format!("{gap}\n"));
        }
        if self.passages.len() > 1 {
            text.push_str(&format!("\nRanked anchors ({}):\n", self.passages.len()));
            for (index, passage) in self.passages.iter().enumerate() {
                let anchor_role = passage
                    .messages
                    .iter()
                    .find(|message| message.is_anchor)
                    .map(|message| format!("{:?}", message.role))
                    .unwrap_or_else(|| "Message".into());
                if passage.matched_terms.is_empty() {
                    text.push_str(&format!(
                        "{}. session_id={} anchor_message_id={} role={} ({})\n",
                        index + 1,
                        passage.session_id,
                        passage.anchor_message_id,
                        anchor_role,
                        passage.session_title,
                    ));
                } else {
                    text.push_str(&format!(
                        "{}. session_id={} anchor_message_id={} role={} matched={:?} ({})\n",
                        index + 1,
                        passage.session_id,
                        passage.anchor_message_id,
                        anchor_role,
                        passage.matched_terms,
                        passage.session_title,
                    ));
                }
            }
        }
        for passage in &self.passages {
            let pointer = serde_json::json!({
                "sessionId": passage.session_id,
                "row": {
                    "through": passage.through,
                    "position": passage.anchor_position,
                    "field": "body",
                }
            });
            text.push_str(&format!(
                "\nSession: {} ({})\nAnchor: {}\nOriginal: SessionRead({})\nMore before: {}; more after: {}\n",
                passage.session_title,
                passage.session_id,
                passage.anchor_message_id,
                serde_json::to_string(&pointer).expect("SessionRead pointer is serializable"),
                passage.has_more_before,
                passage.has_more_after
            ));
            for message in &passage.messages {
                text.push_str(&format!(
                    "\n{:?} {}{}:\n{}\n",
                    message.role,
                    message.message_id,
                    if message.is_anchor { " [anchor]" } else { "" },
                    message.text
                ));
                for attachment in &message.attachments {
                    if let maka_agent_facts::attachment::StorageRef::SessionFile {
                        session_id,
                        relative_path,
                    } = &attachment.storage_ref
                    {
                        text.push_str(&format!(
                            "Attachment: {} ({}, {} bytes); session_id: {}; artifact_id: {}\n",
                            attachment.name,
                            attachment.mime_type,
                            attachment.bytes,
                            session_id,
                            relative_path
                        ));
                    }
                }
            }
        }
        text
    }
}
