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

use maka_agent_facts::language::Language;

use super::images;
use maka_agent_facts::tool_output::DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE;
use maka_agent_facts::tool_output::DurableToolProjection;
use maka_agent_facts::tool_output::ProjectionPart;
use maka_model::prompt::{ContentPart, ToolOutput};

pub(super) fn project(projection: &DurableToolProjection, language: Language) -> ToolOutput {
    match projection {
        DurableToolProjection::Text { text } => ToolOutput::Text(text.clone()),
        DurableToolProjection::Json { value } => ToolOutput::Json(value.clone()),
        DurableToolProjection::Failure => ToolOutput::ErrorText(
            match language {
                Language::En => DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE,
                Language::ZhCn => "工具已完成，但无法安全投影其供模型读取的结果。",
                Language::ZhTw => "工具已完成，但無法安全投影其供模型讀取的結果。",
            }
            .into(),
        ),
        DurableToolProjection::Content { parts } => {
            let value: Vec<_> = parts
                .iter()
                .map(|item| match item {
                    ProjectionPart::Text { text } => ContentPart::text(text.clone()),
                    ProjectionPart::Audio { .. } => ContentPart::text(match language {
                        Language::En => "Audio could not be loaded.",
                        Language::ZhCn => "无法加载音频。",
                        Language::ZhTw => "無法載入音訊。",
                    }),
                    ProjectionPart::Artifact { .. } => {
                        ContentPart::text(images::no_vision(language))
                    }
                })
                .collect();
            ToolOutput::Content(value)
        }
    }
}
