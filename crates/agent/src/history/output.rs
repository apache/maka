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

use super::images;
use maka_model::prompt::{ContentPart, ToolOutput};
use maka_runtime::tool_output::{
    DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE, DurableToolProjection, ProjectionPart,
};

pub(super) fn project<'a>(
    projection: &'a DurableToolProjection,
    message: usize,
    images: &mut Vec<images::Target<'a>>,
    vision: bool,
) -> ToolOutput {
    match projection {
        DurableToolProjection::Text { text } => ToolOutput::Text(text.clone()),
        DurableToolProjection::Json { value } => ToolOutput::Json(value.clone()),
        DurableToolProjection::Failure => {
            ToolOutput::ErrorText(DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE.into())
        }
        DurableToolProjection::Content { parts } => {
            let value: Vec<_> = parts
                .iter()
                .enumerate()
                .map(|(part, item)| match item {
                    ProjectionPart::Text { text } => ContentPart::text(text.clone()),
                    ProjectionPart::Audio { audio } => {
                        images.push(images::Target::Audio {
                            message,
                            part,
                            audio,
                        });
                        ContentPart::text("Audio could not be loaded.")
                    }
                    ProjectionPart::Artifact { image } => {
                        if vision {
                            images.push(images::Target::Tool {
                                message,
                                part,
                                image,
                            });
                        }
                        ContentPart::text(images::NO_VISION)
                    }
                })
                .collect();
            ToolOutput::Content(value)
        }
    }
}
