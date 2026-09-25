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

use super::EventRef;
use crate::RunError;
use maka_event_log::EventLog;
use maka_runtime::{
    attachment::StorageRef,
    event::{Fact, InvocationInput, ToolOutcome},
    tool_output::DurableToolProjection,
};
use std::collections::HashMap;
use tokio_util::sync::CancellationToken;

/// Request-local rendering aliases. Canonical references and evidence stay intact.
pub(super) struct Resources<'a> {
    session: &'a str,
    inherited: HashMap<(&'a str, &'a str), Option<StorageRef>>,
}

impl<'a> Resources<'a> {
    pub fn native(session: &'a str) -> Self {
        Self {
            session,
            inherited: HashMap::new(),
        }
    }

    pub async fn load(
        log: &EventLog,
        session: &'a str,
        events: impl Iterator<Item = EventRef<'a>>,
        cancellation: &CancellationToken,
    ) -> Result<Self, RunError> {
        let mut resources = Self::native(session);
        for event in events.filter_map(EventRef::canonical) {
            let mut references = Vec::new();
            match &event.event.fact {
                Fact::InvocationOpened {
                    input: InvocationInput::Message { content, .. },
                    ..
                } => {
                    references.extend(content.attachments.iter().flatten().map(|a| &a.storage_ref));
                }
                Fact::MessageSteered { message } => {
                    references.extend(
                        message
                            .content
                            .attachments
                            .iter()
                            .flatten()
                            .map(|a| &a.storage_ref),
                    );
                }
                Fact::ToolSettled {
                    outcome:
                        ToolOutcome::Succeeded {
                            model_projection: DurableToolProjection::Content { parts },
                            ..
                        },
                    ..
                } => {
                    references.extend(
                        parts
                            .iter()
                            .filter_map(|part| part.media().map(|(reference, _)| reference)),
                    );
                }
                _ => {}
            }
            for reference in references {
                let StorageRef::SessionFile {
                    session_id,
                    relative_path,
                } = reference
                else {
                    continue;
                };
                if session_id == session
                    || resources
                        .inherited
                        .contains_key(&(session_id.as_str(), relative_path.as_str()))
                {
                    continue;
                }
                if cancellation.is_cancelled() {
                    return Err(RunError::Cancelled);
                }
                let resolved = log
                    .resolve_history_artifact(session, session_id, relative_path)
                    .await?;
                resources
                    .inherited
                    .insert((session_id, relative_path), resolved);
            }
        }
        Ok(resources)
    }

    pub fn resolve<'b>(&'b self, reference: &'b StorageRef) -> Option<&'b StorageRef> {
        match reference {
            StorageRef::SessionFile {
                session_id,
                relative_path,
            } if session_id != self.session => self
                .inherited
                .get(&(session_id.as_str(), relative_path.as_str()))
                .and_then(Option::as_ref),
            _ => Some(reference),
        }
    }
}
