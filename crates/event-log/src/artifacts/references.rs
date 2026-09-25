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

use crate::StoreError;
use maka_runtime::{
    attachment::{AttachmentRef, StorageRef},
    event::{Fact, InvocationInput, RuntimeEvent, ToolOutcome},
    tool_output::DurableToolProjection,
};

/// Only typed canonical references convey ownership; arbitrary plugin JSON does not.
pub(crate) fn from_event(event: &RuntimeEvent) -> Vec<(&StorageRef, Option<&AttachmentRef>)> {
    let mut references: Vec<(&StorageRef, Option<&AttachmentRef>)> = Vec::new();
    match &event.fact {
        Fact::InvocationOpened {
            input:
                InvocationInput::Message {
                    content,
                    source_messages,
                    ..
                },
            ..
        } => {
            references.extend(
                content
                    .attachments
                    .iter()
                    .flatten()
                    .map(|a| (&a.storage_ref, Some(a))),
            );
            for message in source_messages {
                references.extend(
                    message
                        .unprepared_content
                        .attachments
                        .iter()
                        .flatten()
                        .map(|a| (&a.storage_ref, Some(a))),
                );
                references.extend(
                    message
                        .message
                        .content
                        .attachments
                        .iter()
                        .flatten()
                        .map(|a| (&a.storage_ref, Some(a))),
                );
            }
        }
        Fact::MessageSteered { message } => {
            references.extend(
                message
                    .content
                    .attachments
                    .iter()
                    .flatten()
                    .map(|a| (&a.storage_ref, Some(a))),
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
                    .filter_map(|part| part.media().map(|(reference, _)| (reference, None))),
            );
        }
        _ => {}
    }

    references
}

/// Only original editable inputs belong to Revision evidence.
pub(crate) fn revision(event: &RuntimeEvent) -> Result<Vec<&AttachmentRef>, StoreError> {
    let Fact::InvocationOpened {
        input: InvocationInput::Message {
            source_messages, ..
        },
        ..
    } = &event.fact
    else {
        return Err(StoreError::InvalidTransition(
            "revision source is not a message opening".into(),
        ));
    };
    Ok(source_messages
        .iter()
        .flat_map(|message| message.unprepared_content.attachments.iter().flatten())
        .collect())
}
