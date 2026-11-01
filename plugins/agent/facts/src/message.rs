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

//! Durable message provenance shared by admission, execution and recovery.
use crate::{
    execution::BehaviorId,
    input::{DeliveredMessage, MessageInput},
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Trusted producer attribution, preserved independently of editable content.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MessageOrigin {
    WorkhubTask {
        task_id: String,
    },
    WorkhubGraph {
        graph_id: String,
    },
    /// A worker conversation created by the Bot finished a run.
    BotWorker {
        session_id: String,
    },
    /// The opening message of an approved Plan execution. `title` is the
    /// approved Plan's title when the execution was frozen, not the current Plan.
    Plan {
        execution_id: String,
        title: String,
    },
}
impl MessageOrigin {
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::WorkhubTask { task_id } => crate::interaction::entity_id(task_id),
            Self::WorkhubGraph { graph_id } => crate::interaction::entity_id(graph_id),
            Self::BotWorker { session_id } => crate::interaction::entity_id(session_id),
            Self::Plan {
                execution_id,
                title,
            } => {
                crate::interaction::entity_id(execution_id)?;
                if title.trim().is_empty() || title.contains('\0') {
                    return Err("Invalid Plan title");
                }
                Ok(())
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Placement {
    CurrentTurn,
    NextTurn,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnOrchestration {
    pub mode: BehaviorId,
    pub source: TurnOrchestrationSource,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnOrchestrationSource {
    SlashCommand,
    HostApi,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubmittedTurnIntent {
    pub input_selections: crate::input::Selections,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input_selection_sources: crate::input::SelectionSources,
    pub turn_orchestration: Option<TurnOrchestration>,
}
impl SubmittedTurnIntent {
    /// Source shape is not admission: Host verifies actual providers before use.
    pub fn is_exact_turn(&self) -> bool {
        self.turn_orchestration.is_some()
            || crate::input::has_unbound_selections(
                &self.input_selections,
                &self.input_selection_sources,
            )
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        crate::input::validate_selection_sources(
            &self.input_selections,
            &self.input_selection_sources,
        )?;
        if self.input_selections.is_empty() && self.turn_orchestration.is_none() {
            return Err("invalid submitted Turn intent");
        }
        Ok(())
    }
}

/// Current delivery disposition; promotion may change it to Steering while
/// submitted_placement preserves the original requested placement.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageDisposition {
    TurnStarted,
    Steering,
    Followup,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RootSourceMessage {
    #[serde(flatten)]
    pub message: DeliveredMessage,
    /// Input before plugin preparation, including the last accepted queue edit.
    /// Unlike the original submission digest, this follows edits to delivery.
    pub unprepared_content: MessageInput,
    pub submitted_placement: Placement,
    pub disposition: MessageDisposition,
    pub submitted_intent: Option<SubmittedTurnIntent>,
}

/// A Session-owned editing view, not proof that the Session admitted this message.
/// Reusing its content requires a fresh message identity and current preparation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditableMessage {
    pub message_id: String,
    pub turn_id: String,
    pub content: MessageInput,
    pub intent: Option<SubmittedTurnIntent>,
}

impl RootSourceMessage {
    pub fn validate(&self) -> Result<(), &'static str> {
        self.message.validate()?;
        if !self.unprepared_content.preparation.is_empty() {
            return Err("invalid unprepared source content");
        }
        if let Some(intent) = &self.submitted_intent {
            intent.validate()?;
            if intent.is_exact_turn() && self.submitted_placement != Placement::CurrentTurn {
                return Err("exact Turn intent requires current_turn");
            }
        }
        Ok(())
    }
}

/// The canonical opening must consume exactly its ordered source batch.
pub fn validate_sources(
    content: &MessageInput,
    sources: &[RootSourceMessage],
) -> Result<(), &'static str> {
    crate::input::validate_receipts(&content.preparation)?;
    if sources.is_empty() {
        return Ok(());
    }
    let mut ids = HashSet::new();
    let started = sources[0].disposition == MessageDisposition::TurnStarted;
    let orchestration = sources[0]
        .submitted_intent
        .as_ref()
        .and_then(|intent| intent.turn_orchestration.as_ref());
    for source in sources {
        source.validate()?;
        if !ids.insert(&source.message.message_id)
            || (sources.len() != 1
                && if started {
                    source.disposition != MessageDisposition::TurnStarted
                        || source.submitted_placement != Placement::CurrentTurn
                        || source
                            .submitted_intent
                            .as_ref()
                            .and_then(|intent| intent.turn_orchestration.as_ref())
                            != orchestration
                } else {
                    source.disposition == MessageDisposition::TurnStarted
                        || source
                            .submitted_intent
                            .as_ref()
                            .is_some_and(SubmittedTurnIntent::is_exact_turn)
                })
        {
            return Err("conflicting root message sources");
        }
    }
    if aggregate(sources.iter().map(|s| &s.message.content)) != *content {
        return Err("root content differs from its source messages");
    }
    Ok(())
}

/// Matches the client-source aggregate, including UTF-16 inline reference offsets.
pub fn aggregate<'a>(contents: impl IntoIterator<Item = &'a MessageInput>) -> MessageInput {
    let mut result = MessageInput::from("");
    let mut display = String::new();
    let mut offset = 0u64;
    for (index, content) in contents.into_iter().enumerate() {
        if index > 0 {
            result.text.push_str("\n\n");
            display.push_str("\n\n");
        }
        result.text.push_str(&content.text);
        result
            .preparation
            .extend(content.preparation.iter().cloned());
        let visible = content.display_text.as_deref().unwrap_or(&content.text);
        display.push_str(visible);
        append(&mut result.attachments, content.attachments.as_deref());
        append(&mut result.quotes, content.quotes.as_deref());
        append(
            &mut result.directory_references,
            content.directory_references.as_deref(),
        );
        if let Some(references) = &content.inline_references {
            let target = result.inline_references.get_or_insert_with(Vec::new);
            for reference in references {
                let mut reference = reference.clone();
                reference.start = reference.start.saturating_add(offset);
                target.push(reference);
            }
        }
        offset = offset.saturating_add(visible.encode_utf16().count() as u64 + 2);
    }
    if display != result.text {
        result.display_text = Some(display);
    }
    result
}
fn append<T: Clone>(target: &mut Option<Vec<T>>, source: Option<&[T]>) {
    if let Some(source) = source.filter(|items| !items.is_empty()) {
        target
            .get_or_insert_with(Vec::new)
            .extend_from_slice(source);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_starts_preserve_intent_without_accepting_mixed_queue_sources() {
        let mut sources: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|text| {
                let content = MessageInput::from(text);
                RootSourceMessage {
                    message: DeliveredMessage {
                        origin: None,
                        message_id: text.into(),
                        submitted_content_digest: content.content_digest().unwrap(),
                        content: content.clone(),
                    },
                    unprepared_content: content,
                    submitted_placement: Placement::CurrentTurn,
                    disposition: MessageDisposition::TurnStarted,
                    submitted_intent: Some(SubmittedTurnIntent {
                        input_selections: std::collections::BTreeMap::from([(
                            "example".into(),
                            vec![text.into()],
                        )]),
                        input_selection_sources: Default::default(),
                        turn_orchestration: None,
                    }),
                }
            })
            .collect();
        let content = aggregate(sources.iter().map(|s| &s.message.content));
        assert!(validate_sources(&content, &sources).is_ok());
        sources[0].message.origin = Some(MessageOrigin::WorkhubTask {
            task_id: "invalid/id".into(),
        });
        assert!(validate_sources(&content, &sources).is_err());
        sources[0].message.origin = None;
        sources[1]
            .submitted_intent
            .as_mut()
            .unwrap()
            .turn_orchestration = Some(TurnOrchestration {
            mode: "example".to_owned().try_into().unwrap(),
            source: TurnOrchestrationSource::HostApi,
        });
        assert!(validate_sources(&content, &sources).is_err());
        sources[1].submitted_intent = None;
        sources[1].submitted_placement = Placement::NextTurn;
        assert!(validate_sources(&content, &sources).is_err());
        sources[1].disposition = MessageDisposition::Followup;
        assert!(validate_sources(&content, &sources).is_err());
        sources.reverse();
        let reversed = aggregate(sources.iter().map(|s| &s.message.content));
        assert!(validate_sources(&reversed, &sources).is_err());
        sources[1].disposition = MessageDisposition::Steering;
        assert!(validate_sources(&reversed, &sources).is_err());
        sources[1].submitted_intent = None;
        assert!(validate_sources(&reversed, &sources).is_ok());
        sources[0].disposition = MessageDisposition::TurnStarted;
        assert!(
            validate_sources(&sources[0].message.content, &sources[..1]).is_ok(),
            "an ordinary NextTurn submit may start an idle Session"
        );
    }
}
