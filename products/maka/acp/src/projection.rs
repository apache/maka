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

//! ACP presentation of public observations and durable transcript rows.
use crate::presentation::{MessageKind, Meta, Text, ToolCard, ToolStatus, Update};
use maka_agent_api::contract::{ContentKind, HistoryChunk, PreviewField, PreviewPage};
use maka_agent_facts::durable::{ModelAttemptId, RunId, StepId};
use maka_agent_ports::session::history::{HistoryField, ModelPartIdentity, Role, RowPosition};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

mod messages;
mod tools;

struct Message {
    text: String,
    meta: Meta,
    canonical: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum MessageIdentity {
    Message { turn: String, id: String },
    ModelPart(ModelPartIdentity),
    Row(RowPosition),
}
impl MessageIdentity {
    fn live(turn: &str, id: &str) -> Self {
        Self::Message {
            turn: turn.into(),
            id: id.into(),
        }
    }
    fn history(chunk: &HistoryChunk) -> Self {
        match (&chunk.position, &chunk.turn_id, &chunk.message_id) {
            (RowPosition::Live { .. }, _, _) if let Some(part) = &chunk.model_part => {
                Self::ModelPart(part.clone())
            }
            (RowPosition::Live { .. }, Some(turn), Some(id))
                if matches!(chunk.role, Role::User | Role::Assistant | Role::Failure) =>
            {
                Self::Message {
                    turn: turn.clone(),
                    id: id.clone(),
                }
            }
            _ => Self::Row(chunk.position.clone()),
        }
    }
    fn presentation_id(&self, kind: MessageKind) -> Result<String, crate::Error> {
        let id = match self {
            Self::Message { id, .. } => id.clone(),
            Self::ModelPart(part) => format!("model-part:{}:{}", part.attempt_id, part.ordinal),
            Self::Row(position) => format!("history-row:{}", serde_json::to_string(position)?),
        };
        Ok(if kind == MessageKind::Thinking {
            format!("thinking:{id}")
        } else {
            id
        })
    }
}

#[derive(Default)]
pub struct Projection {
    streams: HashMap<(MessageIdentity, MessageKind), Message>,
    tools: HashMap<String, Tool>,
    pending_models: HashMap<
        (StepId, ModelAttemptId),
        HashSet<(maka_agent_ports::session::history::RowPosition, MessageKind)>,
    >,
    preview_epoch: Option<String>,
    preview_attempt: Option<(RunId, StepId, ModelAttemptId)>,
    preview_seed: HashMap<(ModelPartIdentity, MessageKind), String>,
    committed_parts: HashSet<ModelPartIdentity>,
    closed_steps: HashSet<(RunId, StepId, ModelAttemptId)>,
    assembly: Option<CanonicalAssembly>,
}

struct CanonicalAssembly {
    identity: MessageIdentity,
    position: maka_agent_ports::session::history::RowPosition,
    field: HistoryField,
    text: String,
    meta: Meta,
}

struct Tool {
    turn: Option<String>,
    card: ToolCard,
    published: Option<ToolCard>,
    authoritative: bool,
    position: Option<maka_agent_ports::session::history::RowPosition>,
}

impl Projection {
    pub fn chunk(&mut self, chunk: &HistoryChunk) -> Result<Vec<Update>, crate::Error> {
        let identity = MessageIdentity::history(chunk);
        if chunk.offset == 0 {
            if let MessageIdentity::ModelPart(part) = &identity {
                self.preview_seed.retain(|(seed, _), _| seed != part);
            }
            let mut meta = Meta::from_iter([("maka".into(), json!({}))]);
            if matches!(&identity, MessageIdentity::Row(_)) {
                meta["maka"]["historyPosition"] = serde_json::to_value(&chunk.position)?;
                meta["maka"]["historyOrder"] = serde_json::to_value(&chunk.order)?;
            }
            if let Some(turn) = &chunk.turn_id {
                meta["maka"]["turnId"] = json!(turn);
            }
            if let Some(id) = &chunk.message_id {
                meta["maka"]["hostMessageId"] = json!(id);
            }
            if let Some(run) = chunk.run_id {
                meta["maka"]["runId"] = serde_json::to_value(run)?;
            }
            if let Some(model) = &chunk.model {
                meta["maka"]["model"] = serde_json::to_value(model)?;
            }
            if let Some(origin) = &chunk.origin {
                meta["maka"]["origin"] = serde_json::to_value(origin)?;
            }
            if !chunk.attachments.is_empty() {
                meta["maka"]["attachments"] = serde_json::to_value(&chunk.attachments)?;
            }
            self.assembly = Some(CanonicalAssembly {
                identity: identity.clone(),
                position: chunk.position.clone(),
                field: chunk.field,
                text: String::new(),
                meta,
            });
        }
        let CanonicalAssembly {
            position,
            field,
            text,
            ..
        } = self
            .assembly
            .as_mut()
            .ok_or("History field starts with a missing fragment")?;
        if *position != chunk.position || *field != chunk.field || text.len() as u64 != chunk.offset
        {
            return Err("History field fragments are discontinuous".into());
        }
        if text.len() + chunk.text.len() > chunk.total_bytes as usize {
            return Err("History field exceeds its declared size".into());
        }
        text.push_str(&chunk.text);
        if text.len() as u64 != chunk.total_bytes {
            return Ok(vec![]);
        }
        let CanonicalAssembly { text, mut meta, .. } =
            self.assembly.take().expect("complete field");
        if chunk.tool.is_some() {
            return self.tool_chunk(chunk, &text);
        }
        let kind = match (chunk.role, chunk.field) {
            (Role::User, _) => MessageKind::User,
            (Role::Assistant, HistoryField::Thinking) => MessageKind::Thinking,
            (Role::Assistant, HistoryField::Body) => MessageKind::Text,
            (Role::Failure, _) => {
                meta["maka"]["role"] = json!("failure");
                MessageKind::Text
            }
            (Role::ToolCall | Role::ToolResult, _) => return self.tool_chunk(chunk, &text),
            (Role::System | Role::Context | Role::Tool, _) => {
                meta["maka"]["role"] = serde_json::to_value(chunk.role)?;
                MessageKind::Text
            }
            (Role::Compaction, _) => return Ok(vec![]),
        };
        let updates = self.replace_text(identity.clone(), kind, &text, meta)?;
        if let Some(message) = self.streams.get_mut(&(identity, kind)) {
            if !message.canonical
                && matches!(
                    chunk.model,
                    Some(maka_agent_ports::session::history::HistoryModel::Native { .. })
                )
                && let Some(part) = &chunk.model_part
            {
                self.pending_models
                    .entry((part.step_id, part.attempt_id))
                    .or_default()
                    .insert((chunk.position.clone(), kind));
            }
            message.canonical = true;
        }
        Ok(updates)
    }
    pub fn commit_preview(
        &mut self,
        run: RunId,
        step: StepId,
        attempt: ModelAttemptId,
        ordinal: Option<u64>,
    ) {
        if let Some(ordinal) = ordinal {
            let part = ModelPartIdentity {
                step_id: step,
                attempt_id: attempt,
                ordinal,
            };
            self.preview_seed.retain(|(seed, _), _| seed != &part);
            self.committed_parts.insert(part);
        } else {
            self.closed_steps.insert((run, step, attempt));
            if self.preview_attempt == Some((run, step, attempt)) {
                self.preview_seed.clear();
            }
        }
    }

    pub fn preview(&mut self, page: &PreviewPage) -> Result<Vec<Update>, crate::Error> {
        let PreviewPage::Cut {
            host_epoch,
            run_id,
            turn_id,
            step_id,
            attempt_id,
            parts,
            ..
        } = page
        else {
            self.preview_seed.clear();
            self.preview_attempt = None;
            return Ok(vec![]);
        };
        if self
            .preview_epoch
            .as_ref()
            .is_some_and(|epoch| epoch != host_epoch)
        {
            self.committed_parts.clear();
            self.closed_steps.clear();
            self.preview_seed.clear();
        }
        self.preview_epoch = Some(host_epoch.clone());
        let attempt = (*run_id, *step_id, *attempt_id);
        if self.preview_attempt.as_ref() != Some(&attempt) {
            self.preview_seed.clear();
            self.committed_parts
                .retain(|part| part.step_id == *step_id && part.attempt_id == *attempt_id);
            self.closed_steps
                .retain(|(r, s, a)| r == run_id && s == step_id && a == attempt_id);
            self.preview_attempt = Some(attempt);
        }
        if self.closed_steps.contains(&attempt) {
            return Ok(vec![]);
        }
        let mut updates = Vec::new();
        for part in parts {
            let PreviewField::Text { text_kind, .. } = &part.field else {
                continue;
            };
            let address = ModelPartIdentity {
                step_id: *step_id,
                attempt_id: *attempt_id,
                ordinal: part
                    .ordinal
                    .ok_or("Model text preview has no part ordinal")?,
            };
            let identity = MessageIdentity::ModelPart(address.clone());
            if self
                .assembly
                .as_ref()
                .is_some_and(|assembly| assembly.identity == identity)
                || self.committed_parts.contains(&address)
            {
                continue;
            }
            let kind = match text_kind {
                ContentKind::Text => MessageKind::Text,
                ContentKind::Thinking => MessageKind::Thinking,
            };
            let previous = self.streams.get(&(identity.clone(), kind));
            if previous.is_some_and(|message| message.canonical) {
                continue;
            }
            let key = (address, kind);
            let meta = message_meta(turn_id, &part.message_id);
            if part.offset == 0 {
                self.preview_seed.insert(key.clone(), String::new());
            }
            if let Some(text) = self.preview_seed.get_mut(&key) {
                if text.len() as u64 != part.offset {
                    return Err("Preview seed fragments are discontinuous".into());
                }
                text.push_str(&part.text);
                if text.len() as u64 > part.total_bytes {
                    return Err("Preview seed exceeds its declared size".into());
                }
                if text.len() as u64 == part.total_bytes {
                    let text = self
                        .preview_seed
                        .remove(&key)
                        .expect("complete preview seed");
                    updates.extend(self.replace_text(identity, kind, &text, meta)?);
                }
            } else {
                if previous.map(|message| message.text.len() as u64) != Some(part.offset) {
                    return Err("Preview suffix has no complete prefix".into());
                }
                if part.offset + part.text.len() as u64 > part.total_bytes {
                    return Err("Preview suffix exceeds its declared size".into());
                }
                updates.extend(self.append_text(identity, kind, &part.text, meta)?);
            }
        }
        Ok(updates)
    }

    pub fn append(
        &mut self,
        turn: &str,
        id: &str,
        kind: &ContentKind,
        delta: &str,
    ) -> Result<Vec<Update>, crate::Error> {
        let message_kind = match kind {
            ContentKind::Text => MessageKind::Text,
            ContentKind::Thinking => MessageKind::Thinking,
        };
        self.append_text(
            MessageIdentity::live(turn, id),
            message_kind,
            delta,
            message_meta(turn, id),
        )
    }

    fn append_text(
        &mut self,
        identity: MessageIdentity,
        kind: MessageKind,
        delta: &str,
        meta: Meta,
    ) -> Result<Vec<Update>, crate::Error> {
        let key = (identity.clone(), kind);
        if delta.is_empty()
            && self
                .streams
                .get(&key)
                .is_none_or(|message| message.meta == meta)
        {
            return Ok(vec![]);
        }
        let id = identity.presentation_id(kind)?;
        let message = self.streams.entry(key).or_insert_with(|| Message {
            text: String::new(),
            meta: meta.clone(),
            canonical: false,
        });
        message.text.push_str(delta);
        message.meta = meta.clone();
        let update = Update::Message {
            id,
            kind,
            text: Text::Delta(delta.into()),
            meta,
        };
        Ok(vec![update])
    }
}

fn message_meta(turn: &str, id: &str) -> Meta {
    Meta::from_iter([("maka".into(), json!({"hostMessageId":id,"turnId":turn}))])
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_api::contract::PreviewPart;
    use maka_agent_facts::{durable::FactId, history::HistoryOrder};

    #[test]
    fn committed_model_text_only_appends_the_unstreamed_suffix_in_v1() {
        let run_id = RunId::new();
        let step_id = StepId::new();
        let attempt_id = ModelAttemptId::new();
        let fact = FactId::new();
        let mut source = Projection::default();
        let mut client = crate::transport::v1::Projection::default();
        let mut received = Vec::new();
        for (revision, offset, text) in [(1, 0, "Hello"), (2, 5, " world")] {
            let page = PreviewPage::Cut {
                host_epoch: "host".into(),
                run_id,
                turn_id: "turn".into(),
                step_id,
                attempt_id,
                revision,
                depends_on: 0,
                first: true,
                last: true,
                parts: vec![PreviewPart {
                    ordinal: Some(0),
                    message_id: "preview".into(),
                    provider_part_id: Some("text".into()),
                    started_at: 0.0,
                    field: PreviewField::Text {
                        text_kind: ContentKind::Text,
                        final_answer: false,
                    },
                    offset,
                    total_bytes: offset + text.len() as u64,
                    text: text.into(),
                }],
            };
            for update in source.preview(&page).unwrap() {
                let notification = client.update(update).unwrap().unwrap();
                received.push(serde_json::to_value(notification).unwrap());
            }
        }
        source.commit_preview(run_id, step_id, attempt_id, Some(0));
        let chunk: HistoryChunk = serde_json::from_value(json!({
            "importedTurn":null, "runId":run_id, "modelPart":{"stepId":step_id,"attemptId":attempt_id,"ordinal":0},
            "field":"body", "messageId":fact.to_string(), "turnId":"turn", "role":"assistant",
            "position":RowPosition::Live {sequence:3, fact, item_index:0},
            "order":HistoryOrder {path:vec![3], item_index:0},
            "offset":0, "totalBytes":12, "text":"Hello world!", "tool":null,
        })).unwrap();
        for update in source.chunk(&chunk).unwrap() {
            let notification = client.update(update).unwrap().unwrap();
            received.push(serde_json::to_value(notification).unwrap());
        }
        assert_eq!(
            received
                .iter()
                .map(|update| update["content"]["text"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["Hello", " world", "!"]
        );
    }
}
