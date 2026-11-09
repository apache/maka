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

//! Frozen external-task steering on the original Agent/queue Root transaction.
use crate::{fold::RunView, queue, store::invalid};
use maka_agent_facts::{durable::*, external_steering::*};
use maka_event_log::StoreError;
use serde::{Deserialize, Serialize};

mod sql;
pub(crate) use sql::{persist, read_original, read_spec, replay};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSteeringSource {
    pub request: queue::RequestId,
    pub source: ContentRef,
    pub resources: ContentRef,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSteeringSpec {
    pub schema_version: u32,
    pub execution: ExecutionIdentity,
    pub key: ExternalSteeringKey,
    pub consume: queue::Consume,
    pub sources: Vec<ExternalSteeringSource>,
    pub input: ContentRef,
}
impl ExternalSteeringSpec {
    pub fn content_refs(&self) -> Vec<&ContentRef> {
        let mut refs = vec![&self.input];
        refs.extend(self.sources.iter().flat_map(|s| [&s.source, &s.resources]));
        refs
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalSteering {
    pub key: ExternalSteeringKey,
    pub descriptor: ContentRef,
    pub admitted: bool,
}

pub(crate) fn apply(view: &mut RunView, event: &ExternalSteeringEvent) -> Result<(), StoreError> {
    let key = event.key();
    if key.steering.is_nil() {
        return Err(invalid("nil external steering identity"));
    }
    if !matches!(view.spec.origin, RunOrigin::Local) {
        return Err(invalid("historical Run cannot adopt steering"));
    }
    let task = view
        .external
        .as_mut()
        .ok_or_else(|| invalid("external steering has no task"))?;
    if task.task != key.task || !task.admitted || task.closed.is_some() {
        return Err(invalid(
            "external steering has no open original admitted task",
        ));
    }
    if view
        .blockers
        .values()
        .any(|b| b.decision.is_none() && b.resolved_by.is_none())
    {
        return Err(invalid("blocked external task cannot adopt new input"));
    }
    match event {
        ExternalSteeringEvent::Prepared { descriptor, .. } => {
            descriptor.validate().map_err(invalid)?;
            if let Some(current) = &task.steering {
                if current.key == key {
                    if current.descriptor != *descriptor {
                        return Err(StoreError::EventConflict);
                    }
                    if current.admitted {
                        return Err(invalid("external steering was already adopted"));
                    }
                    return Ok(());
                }
                if !current.admitted {
                    return Err(invalid("previous external steering is not yet adopted"));
                }
            }
            task.steering = Some(ExternalSteering {
                key,
                descriptor: descriptor.clone(),
                admitted: false,
            });
        }
        ExternalSteeringEvent::Admitted { .. } => {
            let current = task
                .steering
                .as_mut()
                .ok_or_else(|| invalid("external steering was not prepared"))?;
            if current.key != key || current.admitted {
                return Err(invalid(
                    "external steering is not awaiting original adoption",
                ));
            }
            current.admitted = true;
        }
    }
    Ok(())
}

/// Host-only provenance is not part of the visible text used by inline offsets.
pub fn attributed_source(
    source: maka_agent_facts::message::RootSourceMessage,
    language: maka_agent_facts::language::Language,
) -> maka_agent_facts::input::MessageInput {
    let mut content = source.message.content;
    if let Some(origin) = source.message.origin {
        content
            .display_text
            .get_or_insert_with(|| content.text.clone());
        content.text.insert_str(0, &origin.prompt_header(language));
    }
    content
}
