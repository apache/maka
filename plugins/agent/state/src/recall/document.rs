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
//! Policy-independent document vocabulary shared by live and frozen navigation.
use super::*;
use maka_agent_facts::{
    cells::CellEvent,
    executor::Output,
    input::MessageInput,
    model::ModelPart,
    tool_output::{DurableToolProjection, ProjectionPart},
};
use serde_json::Value;
mod external;
pub(super) use external::{prepared as external_prepared, returned as external_returned};

pub(crate) enum Rule<'a> {
    Admission,
    Steering {
        step: &'a StepId,
        request: &'a ContentRef,
    },
    ExternalSources,
    Model(&'a ModelPart),
    Returned {
        result: &'a ContentRef,
        receipt: Option<&'a maka_plugin_core::operation::RecoveryRef>,
    },
    Accepted(&'a ContentRef),
    External(&'a Output),
    ExternalPrepared {
        key: &'a maka_agent_facts::external_effects::ExternalEffectKey,
        descriptor: &'a ContentRef,
    },
    ExternalReturned(&'a ContentRef),
    Cell(&'a CellEvent),
    Receipt(&'a maka_agent_facts::operation::RecordedOperationReply),
    Failure(&'a str),
    Compaction(&'a ContentRef),
}
pub(crate) fn rule(fact: &Fact) -> Option<Rule<'_>> {
    Some(match fact {
        Fact::RunAdmitted { .. } => Rule::Admission,
        Fact::StepPrepared { step, request, .. } => Rule::Steering { step, request },
        Fact::ExternalTaskPrepared { .. } => Rule::ExternalSources,
        Fact::ModelObserved { part, .. } => Rule::Model(part),
        Fact::LocalToolReturned { result, .. } => Rule::Returned {
            result,
            receipt: None,
        },
        Fact::HostToolResultRecorded {
            result, reference, ..
        } => Rule::Returned {
            result,
            receipt: Some(reference),
        },
        Fact::ToolResultAccepted { result, .. } => Rule::Accepted(result),
        Fact::ExternalTaskObserved { output, .. } => Rule::External(output),
        Fact::ExternalEffect {
            event:
                maka_agent_facts::external_effects::ExternalEffectEvent::Prepared { key, descriptor },
        } => Rule::ExternalPrepared { key, descriptor },
        Fact::ExternalEffect {
            event: maka_agent_facts::external_effects::ExternalEffectEvent::Returned { output, .. },
        } => Rule::ExternalReturned(output),
        Fact::Cell { event } => Rule::Cell(event),
        Fact::OperationObserved { reply, .. } => Rule::Receipt(reply),
        Fact::ModelInterrupted { diagnostic, .. }
        | Fact::RunTerminated {
            diagnostic: Some(diagnostic),
            ..
        } => Rule::Failure(diagnostic),
        Fact::ContextCompacted { baseline } => Rule::Compaction(baseline),
        _ => return None,
    })
}
pub(crate) fn strings(value: &Value, out: &mut String) {
    let append = |out: &mut String, text: &str| {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(text);
    };
    match value {
        Value::String(s) => append(out, s),
        Value::Array(values) => {
            for value in values {
                strings(value, out)
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                append(out, key);
                strings(value, out)
            }
        }
        Value::Bool(_) | Value::Number(_) => append(out, &value.to_string()),
        Value::Null => {}
    }
}
pub(crate) fn json_text(value: &Value) -> String {
    let mut text = String::new();
    strings(value, &mut text);
    text
}
pub(crate) fn cell_text(content: Vec<maka_agent_facts::cells::CellOutput>) -> String {
    content
        .into_iter()
        .filter_map(|part| match part {
            maka_agent_facts::cells::CellOutput::Text { text } => Some(text),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}
pub(crate) fn field(message: &mut Message, field: Field, text: &str, internal: bool) {
    if !message.body.is_empty() {
        message.body.push('\n');
    }
    let start = message.body.len();
    message.body.push_str(text);
    message.fields.push(FieldSpan {
        field,
        start,
        end: message.body.len(),
        internal,
    });
}
pub(crate) fn projection(value: DurableToolProjection) -> String {
    match value {
        DurableToolProjection::Text { text } => text,
        DurableToolProjection::Json { value } => {
            let mut text = String::new();
            strings(&value, &mut text);
            text
        }
        DurableToolProjection::Content { parts } => parts
            .into_iter()
            .filter_map(|p| match p {
                ProjectionPart::Text { text } => Some(text),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        DurableToolProjection::Failure => {
            maka_agent_facts::tool_output::DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE.into()
        }
    }
}
pub(crate) fn input_message(
    spec: &RunSpec,
    fact: &RecordedFact,
    sequence: u64,
    ordinal: u64,
    id: String,
    input: MessageInput,
    reference: ContentRef,
) -> Message {
    let mut body = input.display_text.unwrap_or(input.text);
    let display_bytes = body.len();
    for attachment in input.attachments.iter().flatten() {
        if !body.is_empty() {
            body.push('\n');
        }
        body.push_str(&attachment_label(&attachment.name, attachment.bytes));
    }
    for directory in input.directory_references.iter().flatten() {
        if !body.is_empty() {
            body.push('\n');
        }
        body.push_str(&directory_label(&directory.path));
    }
    Message {
        message_id: id,
        position: RowPosition {
            source_sequence: sequence,
            item_index: ordinal,
        },
        run: fact.run,
        turn_id: spec.turn_id.clone(),
        timestamp: u64::try_from(fact.at.0).expect("validated fact time"),
        role: Role::User,
        body,
        attachments: input.attachments.unwrap_or_default(),
        references: vec![reference],
        fields: vec![FieldSpan {
            field: Field::Body,
            start: 0,
            end: display_bytes,
            internal: false,
        }],
        origin: None,
    }
}

pub(crate) fn attachment_label(name: &str, bytes: u64) -> String {
    let size = if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1_048_576 {
        format!("{:.1} KiB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MiB", bytes as f64 / 1_048_576.0)
    };
    format!("↳ {name} · {size}")
}
pub(crate) fn directory_label(path: &str) -> String {
    format!("▱ {path}")
}
