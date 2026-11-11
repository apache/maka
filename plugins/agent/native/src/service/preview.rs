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
use maka_agent_facts::durable::{Fact, ModelAttemptId, RunId, StepId};
use maka_agent_facts::model::{
    assembly::{AttemptCut, PreviewPart as CutPart},
    body::TextBody,
};
use maka_agent_state::session_history::HistoryItem;
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
    step: Option<StepDelivery>,
    empty: bool,
    present: bool,
}

struct StepDelivery {
    run: RunId,
    step_id: StepId,
    attempt: ModelAttemptId,
    revision: Option<u64>,
    offsets: HashMap<PartKey, usize>,
    accepted_prefix: u64,
    retired_inputs: HashSet<String>,
    closed: bool,
}

#[derive(Clone, PartialEq, Eq, Hash)]
enum PartKey {
    Text(u64),
    ToolInput(String),
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
            empty: false,
            present: false,
        }
    }

    pub(super) fn current(&mut self, cut: Option<Arc<AttemptCut>>) {
        let Some(cut) = cut else {
            self.pending = None;
            self.present = false;
            return;
        };
        if self.step.as_ref().is_some_and(|step| {
            step.run != cut.binding.execution.run_id
                || step.step_id != cut.binding.step_id
                || step.attempt != cut.binding.attempt_id
        }) {
            self.pending = None;
            self.step = None;
        }
        self.empty = false;
        self.present = true;
        let step = self.step.get_or_insert_with(|| StepDelivery {
            run: cut.binding.execution.run_id,
            step_id: cut.binding.step_id,
            attempt: cut.binding.attempt_id,
            revision: None,
            offsets: HashMap::new(),
            accepted_prefix: 0,
            retired_inputs: HashSet::new(),
            closed: false,
        });
        if step.closed || self.pending.is_some() || step.revision == Some(cut.revision) {
            return;
        }
        step.revision = Some(cut.revision);
        self.pending = Some(Cursor {
            cut,
            part: 0,
            first: true,
        });
    }

    pub(super) fn matches(&self, cut: &AttemptCut) -> bool {
        self.step.as_ref().is_some_and(|step| {
            step.run == cut.binding.execution.run_id
                && step.step_id == cut.binding.step_id
                && step.attempt == cut.binding.attempt_id
        })
    }

    pub(super) fn closed(&mut self, run: RunId, attempt: ModelAttemptId) {
        if let Some(step) = self
            .step
            .as_mut()
            .filter(|step| step.run == run && step.attempt == attempt)
        {
            step.closed = true;
            self.pending = None;
            self.present = false;
            self.empty = false;
            step.offsets.clear();
        }
    }

    pub(super) fn committed(&mut self, events: &[HistoryItem]) {
        let Some(step) = self.step.as_mut() else {
            return;
        };
        for event in events {
            if event.recorded.run != step.run {
                continue;
            }
            match &event.recorded.fact {
                Fact::ModelObserved {
                    attempt,
                    index,
                    part,
                    ..
                } if *attempt == step.attempt => {
                    step.accepted_prefix = step.accepted_prefix.max(index + 1);
                    step.offsets.remove(&PartKey::Text(*index));
                    if let maka_agent_facts::model::ModelPart::ToolCall { call } = part {
                        step.retired_inputs.insert(call.id.clone());
                        step.offsets.remove(&PartKey::ToolInput(call.id.clone()));
                    }
                }
                Fact::ModelClosed { attempt, .. } | Fact::ModelInterrupted { attempt, .. }
                    if *attempt == step.attempt =>
                {
                    step.closed = true;
                    self.pending = None;
                    self.present = false;
                    self.empty = false;
                    step.offsets.clear();
                }
                Fact::RunTerminated { .. } | Fact::StopRequested { .. } => {
                    step.closed = true;
                    self.pending = None;
                    self.present = false;
                    self.empty = false;
                    step.offsets.clear();
                }
                _ => {}
            }
        }
    }

    pub(super) fn seed(&mut self, view: &maka_agent_state::fold::RunView) -> Result<(), String> {
        let Some(step) = self.step.as_mut().filter(|step| step.run == view.run) else {
            return Ok(());
        };
        let attempt = view
            .attempts
            .get(&step.attempt)
            .ok_or("agent_preview_attempt_unavailable")?;
        if attempt.step != step.step_id {
            return Err("agent_preview_attempt_mismatch".into());
        }
        step.accepted_prefix = attempt.observed;
        for tool in view
            .tools
            .values()
            .filter(|tool| tool.key.attempt == step.attempt)
        {
            step.retired_inputs.insert(tool.key.call.clone());
        }
        if view.terminal.is_some()
            || view.stopped
            || attempt.closed.is_some()
            || attempt.interrupted.is_some()
        {
            let attempt_id = step.attempt;
            self.closed(view.run, attempt_id);
        }
        Ok(())
    }

    pub(super) fn next(&mut self, after: u64) -> Result<Option<PreviewPage>, String> {
        if !self.present {
            if self.empty {
                return Ok(None);
            }
            self.empty = true;
            return Ok(Some(PreviewPage::Empty {
                host_epoch: self.epoch.clone(),
            }));
        }
        let Some(step) = self.step.as_mut() else {
            if self.empty {
                return Ok(None);
            }
            self.empty = true;
            return Ok(Some(PreviewPage::Empty {
                host_epoch: self.epoch.clone(),
            }));
        };
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
                cursor.cut.binding.execution.run_id,
                cursor.cut.binding.attempt_id,
            );
            let retired_input = matches!(part, CutPart::ToolInput(input) if step.retired_inputs.contains(&input.id));
            let replaced = piece
                .ordinal
                .is_some_and(|ordinal| ordinal < step.accepted_prefix);
            if recorded || retired_input || replaced {
                cursor.part += 1;
                continue;
            }
            let key = match part {
                CutPart::Text { ordinal, .. } => PartKey::Text(*ordinal),
                CutPart::ToolInput(input) => PartKey::ToolInput(input.id.clone()),
            };
            let offset = step.offsets.get(&key).copied().unwrap_or(0);
            // The writer only appends within one attempt. Empty bodies still publish identity.
            if offset == body.len_bytes() && step.offsets.contains_key(&key) {
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
            let budget = PAGE_BYTES
                .checked_sub(overhead)
                .ok_or("agent_preview_metadata_exceeds_page")?;
            let (text, end) = body_piece(&body, offset, budget)?;
            let PreviewPage::Cut { mut parts, .. } = base else {
                unreachable!()
            };
            let mut piece = parts.remove(0);
            piece.text = text;
            step.offsets.insert(key, end);
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
        run_id: cut.binding.execution.run_id,
        turn_id: cut.binding.execution.turn_id.clone(),
        step_id: cut.binding.step_id,
        attempt_id: cut.binding.attempt_id,
        revision: cut.revision,
        depends_on: cut.depends_on,
        first,
        last,
        parts,
    }
}

fn descriptor(
    part: &CutPart,
    run: RunId,
    attempt: ModelAttemptId,
) -> (PreviewPart, TextBody, bool) {
    let (ordinal, message_id, provider_part_id, started_at, field, text, recorded) = match part {
        CutPart::Text {
            ordinal,
            message_id,
            started_at,
            provider_part_id,
            text_kind,
            text,
            final_answer,
            provider_options,
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
                final_answer: *final_answer,
            },
            if *text_kind == maka_agent_facts::model::TextKind::Thinking {
                maka_presentation::reasoning_text(text, provider_options.as_deref())
            } else {
                text.clone()
            },
            recorded.is_some(),
        ),
        CutPart::ToolInput(input) => (
            None,
            &input.message_id,
            Some(input.id.clone()),
            &input.started_at,
            PreviewField::ToolInput {
                tool_use_id: maka_agent_facts::tool_call::tool_use_id(
                    run,
                    &format!("{attempt}:{}", input.id),
                ),
                name: input.name.clone(),
                provider_executed: input.provider_executed,
            },
            input.text.clone(),
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
            if used + escaped > budget {
                if text.is_empty() {
                    return Err("agent_preview_metadata_exceeds_page".into());
                }
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
