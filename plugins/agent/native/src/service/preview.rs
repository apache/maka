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

use crate::contract::{ContentKind, PreviewField, PreviewPage, PreviewPart};
use maka_agent_facts::model::{
    assembly::{AttemptCut, PreviewPart as CutPart},
    body::TextBody,
};
use maka_event_log::observation::{StoreStreamEvent, StreamFact};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::UNIX_EPOCH,
};

const PAGE_BYTES: usize = 48 * 1024;

/// One watch owns one stable cut; no producer waits for its pagination.
pub(super) struct Delivery {
    epoch: String,
    pending: Option<Cursor>,
    step: Option<String>,
    invocation: Option<String>,
    revision: Option<u64>,
    offsets: HashMap<String, usize>,
    replaced: HashSet<String>,
    retired_inputs: HashSet<String>,
    closed: bool,
    empty: bool,
}

struct Cursor {
    cut: Arc<AttemptCut>,
    part: usize,
    first: bool,
}

impl Delivery {
    pub(super) fn new(epoch: &str) -> Self {
        Self {
            epoch: epoch.to_owned(),
            pending: None,
            step: None,
            invocation: None,
            revision: None,
            offsets: HashMap::new(),
            replaced: HashSet::new(),
            retired_inputs: HashSet::new(),
            closed: false,
            empty: false,
        }
    }

    pub(super) fn current(&mut self, cut: Option<Arc<AttemptCut>>) {
        let Some(cut) = cut else {
            self.pending = None;
            self.step = None;
            self.invocation = None;
            self.revision = None;
            self.offsets.clear();
            self.replaced.clear();
            self.retired_inputs.clear();
            self.closed = false;
            return;
        };
        if self.step.as_deref() != Some(cut.binding.step_id.as_str()) {
            self.pending = None;
            self.offsets.clear();
            self.replaced.clear();
            self.retired_inputs.clear();
            self.closed = false;
            self.revision = None;
            self.step = Some(cut.binding.step_id.clone());
            self.invocation = Some(cut.binding.invocation.invocation_id.clone());
        }
        self.empty = false;
        if self.closed || self.pending.is_some() || self.revision == Some(cut.revision) {
            return;
        }
        self.revision = Some(cut.revision);
        self.pending = Some(Cursor {
            cut,
            part: 0,
            first: true,
        });
    }

    pub(super) fn committed(&mut self, events: &[StoreStreamEvent]) {
        for event in events {
            match &event.fact {
                StreamFact::ModelPartCommitted {
                    step_id,
                    message_id,
                    ..
                } if self.step.as_deref() == Some(step_id.as_str()) => {
                    self.replaced.insert(message_id.clone());
                    self.offsets.remove(message_id);
                }
                StreamFact::ToolInputReady {
                    step_id,
                    tool_call_id,
                    ..
                } if self.step.as_deref() == Some(step_id.as_str()) => {
                    self.retired_inputs.insert(tool_call_id.clone());
                    if let Some(cursor) = &self.pending {
                        for part in &cursor.cut.parts {
                            if let CutPart::ToolInput(input) = part
                                && input.id == *tool_call_id
                            {
                                self.replaced.insert(input.message_id.clone());
                                self.offsets.remove(&input.message_id);
                            }
                        }
                    }
                }
                StreamFact::StepEnded { step_id, .. }
                    if self.step.as_deref() == Some(step_id.as_str()) =>
                {
                    self.closed = true;
                    self.pending = None;
                    self.offsets.clear();
                }
                StreamFact::InvocationEnded { .. }
                    if self.invocation.as_deref()
                        == Some(event.invocation.invocation_id.as_str()) =>
                {
                    self.closed = true;
                    self.pending = None;
                    self.offsets.clear();
                }
                _ => {}
            }
        }
    }

    pub(super) fn initial_fence(&self) -> Option<u64> {
        self.pending
            .as_ref()
            .filter(|cursor| cursor.first)
            .map(|cursor| cursor.cut.depends_on)
    }

    pub(super) fn next(&mut self, after: u64) -> Result<Option<PreviewPage>, String> {
        if self.step.is_none() {
            if self.empty {
                return Ok(None);
            }
            self.empty = true;
            return Ok(Some(PreviewPage::Empty {
                host_epoch: self.epoch.clone(),
            }));
        }
        let Some(cursor) = self.pending.as_mut() else {
            return Ok(None);
        };
        if after < cursor.cut.depends_on {
            return Ok(None);
        }
        let mut next = None;
        while let Some(part) = cursor.cut.parts.get(cursor.part) {
            let (mut piece, body, recorded) = descriptor(
                part,
                &cursor.cut.binding.step_id,
                &cursor.cut.binding.invocation.invocation_id,
            );
            let retired_input = matches!(part, CutPart::ToolInput(input) if self.retired_inputs.contains(&input.id));
            if recorded || retired_input || self.replaced.contains(&piece.message_id) {
                cursor.part += 1;
                continue;
            }
            let offset = self.offsets.get(&piece.message_id).copied().unwrap_or(0);
            // The writer only appends within one attempt. Empty bodies still publish identity.
            if offset == body.len_bytes() && self.offsets.contains_key(&piece.message_id) {
                cursor.part += 1;
                continue;
            }
            piece.offset = offset as u64;
            let base = page(&self.epoch, &cursor.cut, cursor.first, false, vec![piece]);
            let overhead = serde_json::to_vec(&PreviewEnvelope {
                kind: "preview",
                page: &base,
            })
            .map_err(|error| error.to_string())?
            .len();
            let (text, end) = body_piece(body, offset, PAGE_BYTES.saturating_sub(overhead))?;
            let PreviewPage::Cut { mut parts, .. } = base else {
                unreachable!()
            };
            let mut piece = parts.remove(0);
            piece.text = text;
            self.offsets.insert(piece.message_id.clone(), end);
            if end == body.len_bytes() {
                cursor.part += 1;
            }
            next = Some(piece);
            break;
        }
        let last = cursor.part == cursor.cut.parts.len();
        let output = page(
            &self.epoch,
            &cursor.cut,
            cursor.first,
            last,
            next.into_iter().collect(),
        );
        cursor.first = false;
        if last {
            self.pending = None;
        }
        Ok(Some(output))
    }
}

#[derive(serde::Serialize)]
struct PreviewEnvelope<'a> {
    kind: &'static str,
    page: &'a PreviewPage,
}

fn page(
    epoch: &str,
    cut: &AttemptCut,
    first: bool,
    last: bool,
    parts: Vec<PreviewPart>,
) -> PreviewPage {
    PreviewPage::Cut {
        host_epoch: epoch.to_owned(),
        invocation_id: cut.binding.invocation.invocation_id.clone(),
        turn_id: cut.binding.invocation.turn_id.clone(),
        step_id: cut.binding.step_id.clone(),
        revision: cut.revision,
        depends_on: cut.depends_on,
        first,
        last,
        parts,
    }
}

fn descriptor<'a>(
    part: &'a CutPart,
    step: &str,
    invocation: &str,
) -> (PreviewPart, &'a TextBody, bool) {
    let (ordinal, message_id, provider_part_id, started_at, field, text, recorded) = match part {
        CutPart::Text {
            ordinal,
            message_id,
            started_at,
            provider_part_id,
            text_kind,
            text,
            recorded,
        } => (
            Some(*ordinal),
            message_id,
            Some(provider_part_id.clone()),
            started_at,
            PreviewField::Text {
                text_kind: match text_kind {
                    maka_agent_facts::model::TextKind::Text => ContentKind::Text,
                    maka_agent_facts::model::TextKind::Thinking => ContentKind::Thinking,
                },
            },
            text,
            recorded.is_some(),
        ),
        CutPart::ToolInput(input) => (
            None,
            &input.message_id,
            Some(input.id.clone()),
            &input.started_at,
            PreviewField::ToolInput {
                tool_use_id: maka_agent_facts::tool_call::tool_use_id(
                    invocation,
                    &format!("{step}:{}", input.id),
                ),
                name: input.name.clone(),
                provider_executed: input.provider_executed,
            },
            &input.text,
            false,
        ),
    };
    (
        PreviewPart {
            ordinal,
            message_id: message_id.clone(),
            provider_part_id,
            started_at: started_at
                .duration_since(UNIX_EPOCH)
                .map_or(0.0, |duration| duration.as_secs_f64() * 1000.0),
            field,
            offset: 0,
            total_bytes: text.len_bytes() as u64,
            text: String::new(),
        },
        text,
        recorded,
    )
}

fn body_piece(body: &TextBody, offset: usize, budget: usize) -> Result<(String, usize), String> {
    let slice = body
        .slice(offset..body.len_bytes())
        .ok_or("agent_preview_offset_invalid")?;
    let mut text = String::new();
    let mut used = 0;
    for chunk in slice.chunks() {
        for point in chunk.chars() {
            let escaped = match point {
                '\"' | '\\' | '\n' | '\r' | '\t' | '\u{08}' | '\u{0c}' => 2,
                point if point < '\u{20}' => 6,
                point => point.len_utf8(),
            };
            if used + escaped > budget && !text.is_empty() {
                let end = offset + text.len();
                return Ok((text, end));
            }
            text.push(point);
            used += escaped;
        }
    }
    let end = offset + text.len();
    Ok((text, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn writer(text: &str, provider_id: &str) -> maka_agent_facts::model::assembly::AttemptWriter {
        use maka_agent_facts::{
            context::ModelPurpose,
            event::Invocation,
            model::{
                ModelEvent, TextKind,
                assembly::{AttemptBinding, AttemptWriter},
            },
        };
        let mut writer = AttemptWriter::new(
            AttemptBinding {
                invocation: Invocation {
                    session_id: "session".into(),
                    turn_id: "turn".into(),
                    run_id: "run".into(),
                    invocation_id: "invocation".into(),
                },
                step_id: "step".into(),
                purpose: ModelPurpose::Main,
            },
            true,
        )
        .unwrap();
        writer
            .push(
                ModelEvent::PartStarted {
                    id: provider_id.into(),
                    text_kind: TextKind::Text,
                    provider_options: None,
                },
                UNIX_EPOCH,
            )
            .unwrap();
        writer
            .push(
                ModelEvent::PartDelta {
                    id: provider_id.into(),
                    text: text.into(),
                    provider_options: None,
                },
                UNIX_EPOCH,
            )
            .unwrap();
        writer.fenced(4);
        writer
    }

    fn append(writer: &mut maka_agent_facts::model::assembly::AttemptWriter, text: &str) {
        writer
            .push(
                maka_agent_facts::model::ModelEvent::PartDelta {
                    id: "provider-part".into(),
                    text: text.into(),
                    provider_options: None,
                },
                UNIX_EPOCH,
            )
            .unwrap();
    }

    #[test]
    fn slow_seed_keeps_its_cut_then_delivers_only_the_new_suffix() {
        let original = "中文🙂\"\\\n\r\t\0".repeat(20_000);
        let mut writer = writer(&original, "provider-part");
        let first = writer.snapshot();
        let first_revision = first.revision;
        let (published, mut reader) = tokio::sync::watch::channel(Some(first));
        let mut delivery = Delivery::new("epoch");
        delivery.current(reader.borrow_and_update().clone());
        assert!(delivery.next(3).unwrap().is_none());
        let first_page = delivery.next(4).unwrap().unwrap();
        // Publishing does not require this reader to drain its first stable cut.
        append(&mut writer, "suffix🙂");
        let latest = writer.snapshot();
        let latest_revision = latest.revision;
        let _ = published.send_replace(Some(latest));
        delivery.current(reader.borrow_and_update().clone());
        let mut pages = vec![first_page];
        while let Some(page) = delivery.next(4).unwrap() {
            pages.push(page);
        }
        assert!(pages.len() > 1);
        let mut restored = String::new();
        for page in &pages {
            let PreviewPage::Cut {
                revision, parts, ..
            } = page
            else {
                panic!("missing cut")
            };
            assert_eq!(*revision, first_revision);
            let encoded = serde_json::to_vec(&PreviewEnvelope {
                kind: "preview",
                page,
            })
            .unwrap();
            assert!(encoded.len() <= PAGE_BYTES);
            for part in parts {
                restored.push_str(&part.text);
            }
        }
        assert_eq!(restored, original);
        delivery.current(reader.borrow_and_update().clone());
        let PreviewPage::Cut {
            revision,
            first,
            last,
            parts,
            ..
        } = delivery.next(4).unwrap().unwrap()
        else {
            panic!("missing suffix")
        };
        assert_eq!(revision, latest_revision);
        assert!(first && last);
        assert_eq!(parts[0].offset, original.len() as u64);
        assert_eq!(parts[0].text, "suffix🙂");
    }

    #[test]
    fn canonical_replacement_retires_the_remaining_old_cut() {
        let original = "old prefix".repeat(20_000);
        let mut writer = writer(&original, "provider-part");
        let current = writer.snapshot();
        let CutPart::Text { message_id, .. } = &current.parts[0] else {
            panic!("missing text")
        };
        let mut delivery = Delivery::new("epoch");
        delivery.current(Some(current.clone()));
        assert!(delivery.next(4).unwrap().is_some());
        delivery.committed(&[StoreStreamEvent {
            sequence: 5,
            id: "canonical-part".into(),
            invocation: current.binding.invocation.clone(),
            root_run_id: "run".into(),
            recorded_at: UNIX_EPOCH,
            fact: StreamFact::ModelPartCommitted {
                step_id: "step".into(),
                message_id: message_id.clone(),
                ordinal: 0,
            },
        }]);
        let PreviewPage::Cut { last, parts, .. } = delivery.next(5).unwrap().unwrap() else {
            panic!("missing cut completion")
        };
        assert!(last);
        assert!(parts.is_empty());
        append(&mut writer, "obsolete tail");
        delivery.current(Some(writer.snapshot()));
        let PreviewPage::Cut { parts, .. } = delivery.next(5).unwrap().unwrap() else {
            panic!("missing newer cut")
        };
        assert!(parts.is_empty());
    }

    #[test]
    fn oversized_metadata_does_not_prevent_body_progress() {
        let provider_id = "provider-part".repeat(PAGE_BYTES);
        let writer = writer("🙂中", &provider_id);
        let mut delivery = Delivery::new("epoch");
        delivery.current(Some(writer.snapshot()));
        let mut restored = String::new();
        let mut offset = 0;
        while let Some(page) = delivery.next(4).unwrap() {
            assert!(
                serde_json::to_vec(&PreviewEnvelope {
                    kind: "preview",
                    page: &page
                })
                .unwrap()
                .len()
                    > PAGE_BYTES
            );
            let PreviewPage::Cut { parts, .. } = page else {
                panic!("missing cut")
            };
            let part = &parts[0];
            assert_eq!(part.offset, offset);
            assert!(!part.text.is_empty());
            offset += part.text.len() as u64;
            restored.push_str(&part.text);
        }
        assert_eq!(restored, "🙂中");
    }
}
