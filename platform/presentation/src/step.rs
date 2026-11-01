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

use crate::{Content, Message, ProjectionError, Thinking};
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::model::recorded::{CompletionPart, ModelPartRecord};
use maka_agent_facts::model::{ModelPart, TextKind};
use std::collections::BTreeMap;

pub(crate) mod reasoning;

pub(super) struct Step {
    id: String,
    pub item_acceptance: bool,
    model: String,
    records: BTreeMap<u64, (String, ModelPartRecord)>,
    text_anchor: Option<u64>,
}

impl Step {
    pub fn new(id: String, model: String, item_acceptance: bool) -> Self {
        Self {
            id,
            item_acceptance,
            model,
            records: BTreeMap::new(),
            text_anchor: None,
        }
    }

    pub fn check_id(&self, id: &str) -> Result<(), ProjectionError> {
        if self.id == id {
            Ok(())
        } else {
            Err(ProjectionError::Invalid("model step identity changed"))
        }
    }

    pub fn observe(&mut self, event: &RuntimeEvent, record: &ModelPartRecord) {
        if matches!(record.part.as_ref(), ModelPart::Text { .. }) {
            self.text_anchor = Some(
                self.text_anchor
                    .map_or(record.ordinal, |ordinal| ordinal.max(record.ordinal)),
            );
        }
        self.records
            .insert(record.ordinal, (event.id.clone(), record.clone()));
    }

    pub fn resolve<'part>(
        &'part self,
        part: &'part CompletionPart,
    ) -> Result<&'part ModelPartRecord, ProjectionError> {
        match part {
            CompletionPart::Own(record) => Ok(record),
            CompletionPart::Ref(reference) => self
                .records
                .get(&reference.ordinal)
                .filter(|(event_id, _)| event_id == &reference.event_id)
                .map(|(_, record)| record)
                .ok_or(ProjectionError::Invalid(
                    "model part reference without original body",
                )),
        }
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn anchor(&self) -> Option<&str> {
        self.text_anchor
            .and_then(|ordinal| self.records.get(&ordinal))
            .map(|(_, record)| record.message_id.as_str())
    }

    pub fn text(
        &self,
        event: &RuntimeEvent,
        record: &ModelPartRecord,
        failed: bool,
    ) -> Result<Option<Message>, ProjectionError> {
        let ModelPart::Text {
            text_kind,
            text,
            provider_options,
        } = record.part.as_ref()
        else {
            return Ok(None);
        };
        let options = provider_options.as_deref().cloned();
        let interrupted =
            failed && !(*text_kind == TextKind::Thinking && reasoning::finalized(options.as_ref()));
        let body = match text_kind {
            TextKind::Thinking => reasoning::display_text(text, options.as_ref()),
            TextKind::Text => text.clone(),
        }
        .chunks()
        .collect();
        let (text, thinking) = match text_kind {
            TextKind::Text => (body, None),
            TextKind::Thinking => (
                String::new(),
                Some(Thinking {
                    text: body,
                    provider_options: options.clone(),
                }),
            ),
        };
        Ok(Some(Message {
            id: record.message_id.clone(),
            turn_id: event.invocation.turn_id.clone(),
            ts: crate::message::capture_time(record.started_at)?,
            content: Content::Assistant {
                imported: false,
                text,
                model_id: self.model.clone(),
                interrupted,
                thinking,
                provider_options: options,
            },
        }))
    }
}
