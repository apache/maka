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

use crate::{Content, Message, ProjectionError};
use maka_agent_facts::input::MessageInput;

pub(super) fn project(
    id: &str,
    run_id: maka_agent_facts::durable::RunId,
    turn: &str,
    ts: u64,
    content: &MessageInput,
    origin: Option<&maka_agent_facts::message::MessageOrigin>,
) -> Result<Message, ProjectionError> {
    Ok(Message {
        id: id.into(),
        run_id,
        model: None,
        turn_id: turn.into(),
        ts,
        content: Content::User {
            origin: origin.cloned(),
            imported: false,
            text: content.text.clone(),
            display_text: content.display_text.clone(),
            attachments: content.attachments.clone(),
            quotes: content.quotes.clone(),
            directory_references: content.directory_references.clone(),
            inline_references: content.inline_references.clone(),
        },
    })
}
