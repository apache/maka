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

use maka_agent_facts::model::{ModelPart, TextKind};
use maka_model::prompt::{AssistantPart, ToolOutput};

pub(crate) fn assistant_part(part: &ModelPart) -> Option<AssistantPart> {
    Some(match part {
        ModelPart::Source { .. } => return None,
        ModelPart::Text {
            text_kind,
            text,
            provider_options,
        } => match text_kind {
            TextKind::Thinking => AssistantPart::Reasoning {
                text: text.chunks().collect(),
                provider_options: provider_options.as_deref().cloned(),
            },
            TextKind::Text => AssistantPart::Text {
                text: text.chunks().collect(),
                provider_options: provider_options.as_deref().cloned(),
            },
        },
        ModelPart::ToolCall { call } => AssistantPart::ToolCall {
            tool_call_id: call.id.clone(),
            tool_name: call.name.clone(),
            input: call.input.clone(),
            provider_executed: Some(call.provider_executed),
            provider_options: call.provider_options.clone(),
        },
        ModelPart::ToolResult {
            id,
            name,
            output,
            is_error,
            provider_options,
        } => AssistantPart::ToolResult {
            tool_call_id: id.clone(),
            tool_name: name.clone(),
            output: if *is_error {
                ToolOutput::ErrorJson(output.clone())
            } else {
                ToolOutput::Json(output.clone())
            },
            provider_options: provider_options.clone(),
        },
    })
}
