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

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::{
        context::ModelPurpose,
        durable::{ExecutionIdentity, FactId, RecordedFact, UnixMillis},
        model::{
            ModelEvent, ModelPart, TextKind,
            assembly::{AttemptBinding, AttemptWriter},
        },
    };
    use maka_agent_state::session_history::HistoryScope;

    fn binding() -> AttemptBinding {
        AttemptBinding {
            execution: ExecutionIdentity {
                session_id: "session".into(),
                turn_id: "turn".into(),
                run_id: RunId::new(),
            },
            step_id: StepId::new(),
            attempt_id: ModelAttemptId::new(),
            purpose: ModelPurpose::Main,
        }
    }
    fn writer(binding: AttemptBinding, text: &str, kind: TextKind) -> AttemptWriter {
        let mut writer = AttemptWriter::new(binding, true).unwrap();
        writer
            .push(
                ModelEvent::PartStarted {
                    id: "part".into(),
                    text_kind: kind,
                    provider_options: None,
                },
                UNIX_EPOCH,
            )
            .unwrap();
        append(&mut writer, text);
        writer.fenced(4);
        writer
    }
    fn append(writer: &mut AttemptWriter, text: &str) {
        writer
            .push(
                ModelEvent::PartDelta {
                    id: "part".into(),
                    text: text.into(),
                    provider_options: None,
                },
                UNIX_EPOCH,
            )
            .unwrap();
    }
    fn receipt(cut: &AttemptCut, sequence: u64, fact: Fact) -> HistoryItem {
        HistoryItem {
            sequence,
            admission_sequence: 1,
            scope: HistoryScope {
                step: Some(cut.binding.step_id),
                attempt: Some(cut.binding.attempt_id),
            },
            recorded: RecordedFact {
                schema_version: 1,
                id: FactId::new(),
                run: cut.binding.execution.run_id,
                revision: sequence,
                at: UnixMillis(0),
                fact,
            },
        }
    }
    fn observed(cut: &AttemptCut, sequence: u64, index: u64, part: ModelPart) -> HistoryItem {
        receipt(
            cut,
            sequence,
            Fact::ModelObserved {
                attempt: cut.binding.attempt_id,
                index,
                part,
                continuation: None,
            },
        )
    }
    fn drain(delivery: &mut Delivery, after: u64) -> Vec<PreviewPart> {
        let mut parts = Vec::new();
        while let Some(page) = delivery.next(after).unwrap() {
            if let PreviewPage::Cut { parts: next, .. } = page {
                parts.extend(next);
            }
        }
        parts
    }

    #[test]
    fn slow_consumer_keeps_its_cut_then_only_gets_the_new_suffix() {
        let original = "中文🙂\"\\\n\r\t\0".repeat(20_000);
        let mut writer = writer(binding(), &original, TextKind::Text);
        let first = writer.snapshot();
        let first_revision = first.revision;
        let mut delivery = Delivery::new("epoch");
        delivery.current(Some(first));
        assert!(delivery.next(3).unwrap().is_none());
        let first_page = delivery.next(4).unwrap().unwrap();
        append(&mut writer, "suffix🙂");
        delivery.current(Some(writer.snapshot()));
        let mut pages = vec![first_page];
        while let Some(page) = delivery.next(4).unwrap() {
            pages.push(page);
        }
        let mut restored = String::new();
        for page in &pages {
            assert!(
                serde_json::to_vec(&PreviewEnvelope {
                    kind: "preview",
                    page
                })
                .unwrap()
                .len()
                    <= PAGE_BYTES
            );
            let PreviewPage::Cut {
                revision, parts, ..
            } = page
            else {
                panic!("expected cut");
            };
            assert_eq!(*revision, first_revision);
            for part in parts {
                restored.push_str(&part.text);
            }
        }
        assert_eq!(restored, original);
        delivery.current(Some(writer.snapshot()));
        let suffix = drain(&mut delivery, 4);
        assert_eq!(suffix.len(), 1);
        assert_eq!(suffix[0].offset, original.len() as u64);
        assert_eq!(suffix[0].text, "suffix🙂");
    }

    #[test]
    fn canonical_fact_retires_draft_by_attempt_and_ordinal_not_message_id() {
        for committed_mid_page in [true, false] {
            let mut writer = writer(binding(), &"old".repeat(50_000), TextKind::Text);
            let cut = writer.snapshot();
            let mut delivery = Delivery::new("epoch");
            delivery.current(Some(cut.clone()));
            if committed_mid_page {
                let _ = delivery.next(4).unwrap();
            } else {
                let _ = drain(&mut delivery, 4);
            }
            let fact = observed(
                &cut,
                5,
                0,
                ModelPart::Text {
                    text_kind: TextKind::Text,
                    text: "complete original".into(),
                    provider_options: None,
                },
            );
            let CutPart::Text { message_id, .. } = &cut.parts[0] else {
                panic!("missing text");
            };
            assert_ne!(fact.recorded.id.to_string(), *message_id);
            delivery.committed(&[fact]);
            assert!(drain(&mut delivery, 5).is_empty());
            append(&mut writer, " obsolete");
            writer
                .push(
                    ModelEvent::PartFinished {
                        id: "part".into(),
                        provider_options: None,
                    },
                    UNIX_EPOCH,
                )
                .unwrap();
            writer
                .push(
                    ModelEvent::PartStarted {
                        id: "fresh".into(),
                        text_kind: TextKind::Text,
                        provider_options: None,
                    },
                    UNIX_EPOCH,
                )
                .unwrap();
            writer
                .push(
                    ModelEvent::PartDelta {
                        id: "fresh".into(),
                        text: "fresh".into(),
                        provider_options: None,
                    },
                    UNIX_EPOCH,
                )
                .unwrap();
            delivery.current(Some(writer.snapshot()));
            let remaining = drain(&mut delivery, 5);
            assert_eq!(remaining.len(), 1);
            assert_eq!(remaining[0].text, "fresh");
            assert_eq!(remaining[0].ordinal, Some(1));
        }
    }

    #[test]
    fn late_old_attempt_close_cannot_close_a_retry_or_reopen_a_closed_attempt() {
        let first = binding();
        let mut retry = first.clone();
        retry.attempt_id = ModelAttemptId::new();
        let old = writer(first, "old", TextKind::Text).snapshot();
        let mut current = writer(retry, "retry", TextKind::Text);
        let next = current.snapshot();
        let mut delivery = Delivery::new("epoch");
        delivery.current(Some(old.clone()));
        let _ = drain(&mut delivery, 4);
        delivery.current(Some(next.clone()));
        delivery.committed(&[receipt(
            &old,
            5,
            Fact::ModelInterrupted {
                attempt: old.binding.attempt_id,
                diagnostic: "old failure".into(),
            },
        )]);
        assert_eq!(drain(&mut delivery, 5)[0].text, "retry");
        delivery.committed(&[receipt(
            &next,
            6,
            Fact::ModelInterrupted {
                attempt: next.binding.attempt_id,
                diagnostic: "closed".into(),
            },
        )]);
        assert!(drain(&mut delivery, 6).is_empty());
        delivery.current(None);
        let _ = drain(&mut delivery, 6);
        append(&mut current, " stale suffix");
        delivery.current(Some(current.snapshot()));
        assert!(drain(&mut delivery, 6).is_empty());
    }

    #[test]
    fn tool_input_id_is_attempt_scoped_and_canonical_call_retires_only_that_attempt() {
        fn input(binding: AttemptBinding) -> AttemptWriter {
            let mut writer = AttemptWriter::new(binding, true).unwrap();
            writer
                .push(
                    ModelEvent::ToolInputStarted {
                        id: "call".into(),
                        name: "echo".into(),
                        provider_executed: false,
                    },
                    UNIX_EPOCH,
                )
                .unwrap();
            writer
                .push(
                    ModelEvent::ToolInputDelta {
                        id: "call".into(),
                        text: "{\"arg\":".into(),
                    },
                    UNIX_EPOCH,
                )
                .unwrap();
            writer.fenced(4);
            writer
        }
        let first = input(binding());
        let cut = first.snapshot();
        let mut retry_binding = cut.binding.clone();
        retry_binding.attempt_id = ModelAttemptId::new();
        let retry = input(retry_binding);
        let mut delivery = Delivery::new("epoch");
        delivery.current(Some(cut.clone()));
        let old = drain(&mut delivery, 4);
        let PreviewField::ToolInput {
            tool_use_id: old_id,
            ..
        } = &old[0].field
        else {
            panic!("tool input");
        };
        delivery.committed(&[observed(
            &cut,
            5,
            0,
            ModelPart::ToolCall {
                call: maka_agent_facts::model::ModelToolCall {
                    id: "call".into(),
                    name: "echo".into(),
                    input: serde_json::json!({"arg":1}).into(),
                    provider_options: None,
                    provider_executed: false,
                },
            },
        )]);
        delivery.current(Some(first.snapshot()));
        assert!(drain(&mut delivery, 5).is_empty());
        delivery.current(Some(retry.snapshot()));
        let new = drain(&mut delivery, 5);
        let PreviewField::ToolInput {
            tool_use_id: new_id,
            ..
        } = &new[0].field
        else {
            panic!("tool input");
        };
        assert_ne!(old_id, new_id);
        assert_eq!(new[0].text, "{\"arg\":");
    }

    #[test]
    fn reasoning_summary_breaks_are_delivered_once_as_a_suffix() {
        let mut writer = writer(binding(), "**检查🙂**", TextKind::Thinking);
        let mut delivery = Delivery::new("epoch");
        delivery.current(Some(writer.snapshot()));
        assert_eq!(drain(&mut delivery, 4)[0].text, "**检查🙂**");
        writer
            .push(
                ModelEvent::PartDelta {
                    id: "part".into(),
                    text: "**Build**".into(),
                    provider_options: Some(serde_json::json!({"makaSummaryBreaks":[14]})),
                },
                UNIX_EPOCH,
            )
            .unwrap();
        delivery.current(Some(writer.snapshot()));
        let next = drain(&mut delivery, 4);
        assert_eq!(next[0].offset, 14);
        assert_eq!(next[0].text, "\n\n**Build**");
        writer.push(ModelEvent::PartFinished { id: "part".into(), provider_options: Some(serde_json::json!({"openai":{"responsesReplay":{"textField":"summary","parts":[{"bytes":14},{"bytes":9}]}}})) }, UNIX_EPOCH).unwrap();
        delivery.current(Some(writer.snapshot()));
        assert!(drain(&mut delivery, 4).is_empty());
    }
}
