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

use super::{ImageOutput, ToolOutput};
use crate::{
    artifact::content_digest, attachment::StorageRef, event::Invocation,
    event_write::ProjectionArtifactWrite,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::{self, Write},
    time::SystemTime,
};

pub const MAX_RAW_TOOL_RESULT_BYTES: usize = 64 * 1024 * 1024;
/// Embedded JSON root is depth zero. The typed raw envelopes add at most four
/// containers, safely below serde_json's default 128-level decoder guard.
pub const MAX_RAW_TOOL_RESULT_JSON_DEPTH: usize = 64;
pub const DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE: &str =
    "The tool completed, but its model-visible result could not be projected safely.";
const MAX_PROJECTION_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawToolResultRef {
    pub bytes: u64,
    pub digest: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DurableToolProjection {
    Text { text: String },
    Json { value: Value },
    Content { parts: Vec<ProjectionPart> },
    Failure,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProjectionPart {
    Text { text: String },
    Artifact { image: ImageOutput },
    Audio { audio: super::AudioOutput },
}

impl ProjectionPart {
    pub fn media(&self) -> Option<(&StorageRef, &str)> {
        match self {
            Self::Artifact { image } => Some((&image.reference, &image.mime_type)),
            Self::Audio { audio } => Some((&audio.reference, &audio.mime_type)),
            Self::Text { .. } => None,
        }
    }
    pub fn reference_mut(&mut self) -> Option<&mut StorageRef> {
        match self {
            Self::Artifact { image } => Some(&mut image.reference),
            Self::Audio { audio } => Some(&mut audio.reference),
            Self::Text { .. } => None,
        }
    }
}

pub fn decode_raw_tool_result(
    bytes: &[u8],
    evidence: &RawToolResultRef,
) -> Result<ToolOutput, &'static str> {
    if bytes.len() > MAX_RAW_TOOL_RESULT_BYTES
        || evidence.bytes != bytes.len() as u64
        || evidence.digest != content_digest(bytes)
    {
        return Err("raw tool result integrity mismatch");
    }
    let output = serde_json::from_slice(bytes).map_err(|_| "invalid raw tool result encoding")?;
    validate_raw_depth(&output)?;
    Ok(output)
}

pub(crate) fn encode_raw_tool_result(output: &ToolOutput) -> Result<Vec<u8>, &'static str> {
    validate_raw_depth(output)?;
    bounded_encode(output, MAX_RAW_TOOL_RESULT_BYTES)
}

fn validate_raw_depth(output: &ToolOutput) -> Result<(), &'static str> {
    fn within_limit(value: &Value, depth: usize) -> bool {
        if depth > MAX_RAW_TOOL_RESULT_JSON_DEPTH {
            return false;
        }
        match value {
            Value::Array(values) => values.iter().all(|value| within_limit(value, depth + 1)),
            Value::Object(values) => values.values().all(|value| within_limit(value, depth + 1)),
            _ => true,
        }
    }
    let valid = match output {
        ToolOutput::Json(value) => within_limit(value, 0),
        ToolOutput::Mcp(result) => {
            result
                .structured_content
                .as_ref()
                .is_none_or(|value| within_limit(value, 0))
                && result.content.iter().all(|block| match block {
                    crate::capability::ContentBlock::Unknown { value } => within_limit(value, 0),
                    crate::capability::ContentBlock::Text { .. }
                    | crate::capability::ContentBlock::Image { .. }
                    | crate::capability::ContentBlock::Audio { .. }
                    | crate::capability::ContentBlock::Resource { .. }
                    | crate::capability::ContentBlock::ResourceLink { .. } => true,
                })
        }
        ToolOutput::Image(_) | ToolOutput::Text(_) | ToolOutput::Model(_) => true,
    };
    if valid {
        Ok(())
    } else {
        Err("raw tool result JSON exceeds depth limit")
    }
}

pub(crate) fn bounded_encode(
    value: &impl Serialize,
    limit: usize,
) -> Result<Vec<u8>, &'static str> {
    struct Bounded {
        bytes: Vec<u8>,
        limit: usize,
    }
    impl Write for Bounded {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
                return Err(io::Error::other("encoded tool result exceeds byte limit"));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut writer = Bounded {
        bytes: Vec::new(),
        limit,
    };
    serde_json::to_writer(&mut writer, value)
        .map_err(|_| "tool result encoding exceeds limit or is invalid")?;
    Ok(writer.bytes)
}

pub(crate) fn freeze(
    output: &ToolOutput,
    id: &str,
    time: SystemTime,
    invocation: &Invocation,
) -> (DurableToolProjection, Vec<ProjectionArtifactWrite>) {
    let prepared = match output {
        ToolOutput::Mcp(result) => super::mcp::project(result, id, time, invocation),
        ToolOutput::Image(image) => checked_image(image, &invocation.session_id).map(|image| {
            (
                DurableToolProjection::Content {
                    parts: vec![
                        ProjectionPart::Text {
                            text: "Image read successfully.".into(),
                        },
                        ProjectionPart::Artifact { image },
                    ],
                },
                Vec::new(),
            )
        }),
        ToolOutput::Json(value) => {
            if !json_shape(value, &mut 0, 0) || bounded_encode(value, MAX_PROJECTION_BYTES).is_err()
            {
                None
            } else {
                Some((
                    match value {
                        Value::String(text) => DurableToolProjection::Text { text: text.clone() },
                        _ => DurableToolProjection::Json {
                            value: value.clone(),
                        },
                    },
                    Vec::new(),
                ))
            }
        }
        ToolOutput::Text(text) => (text.len() <= MAX_PROJECTION_BYTES).then(|| {
            (
                DurableToolProjection::Json {
                    value: serde_json::json!({"kind":"text","text":text}),
                },
                Vec::new(),
            )
        }),
        ToolOutput::Model(result) => Some((
            DurableToolProjection::Json {
                value: serde_json::json!({
                    "modelId": result.model_id,
                    "finishReason": result.finish_reason,
                    "usage": result.usage
                }),
            },
            Vec::new(),
        )),
    };
    prepared
        .filter(|(projection, _)| projection.validate(&invocation.session_id).is_ok())
        .unwrap_or((DurableToolProjection::Failure, Vec::new()))
}

impl DurableToolProjection {
    pub fn validate(&self, session: &str) -> Result<(), &'static str> {
        let valid = match self {
            Self::Json { value } => json_shape(value, &mut 0, 0),
            Self::Content { parts } => {
                !parts.is_empty()
                    && parts.len() <= 64
                    && parts.iter().all(|part| match part {
                        ProjectionPart::Text { .. } => true,
                        ProjectionPart::Artifact { image } => {
                            checked_image(image, session).as_ref() == Some(image)
                        }
                        ProjectionPart::Audio { audio } => {
                            super::audio::valid_mime(&audio.mime_type)
                                && matches!(&audio.reference, StorageRef::SessionFile { session_id, relative_path }
                                    if session_id == session && crate::interaction::entity_id(relative_path).is_ok())
                        }
                    })
            }
            Self::Text { .. } | Self::Failure => true,
        };
        if !valid {
            return Err("invalid durable tool projection");
        }
        bounded_encode(self, MAX_PROJECTION_BYTES).map(|_| ())
    }
}

fn json_shape(value: &Value, nodes: &mut usize, depth: usize) -> bool {
    *nodes += 1;
    if *nodes > 20_000 || depth > 32 {
        return false;
    }
    match value {
        Value::Array(values) => values.iter().all(|v| json_shape(v, nodes, depth + 1)),
        Value::Object(values) => values.values().all(|v| json_shape(v, nodes, depth + 1)),
        _ => true,
    }
}

pub(super) fn checked_image(image: &ImageOutput, session: &str) -> Option<ImageOutput> {
    let StorageRef::SessionFile {
        session_id,
        relative_path,
    } = &image.reference
    else {
        return None;
    };
    if session_id != session || crate::interaction::entity_id(relative_path).is_err() {
        return None;
    }
    let mime = super::media::normalize_mime(&image.mime_type)?;
    Some(ImageOutput {
        detail: image.detail,
        mime_type: mime,
        reference: image.reference.clone(),
    })
}
