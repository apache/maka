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
use std::time::SystemTime;

pub const DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE: &str =
    "The tool completed, but its model-visible result could not be projected safely.";

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
    if evidence.bytes != bytes.len() as u64 || evidence.digest != content_digest(bytes) {
        return Err("raw tool result integrity mismatch");
    }
    let output = serde_json::from_slice(bytes).map_err(|_| "invalid raw tool result encoding")?;
    validate_raw(&output)?;
    Ok(output)
}

pub(crate) fn encode_raw_tool_result(output: &ToolOutput) -> Result<Vec<u8>, &'static str> {
    validate_raw(output)?;
    let bytes = serde_json::to_vec(output).map_err(|_| "invalid tool result encoding")?;
    // Keep the dependency's supported typed decoder representation coherent on
    // write and read, without imposing a smaller independent depth policy.
    let _: ToolOutput =
        serde_json::from_slice(&bytes).map_err(|_| "unsupported tool result encoding")?;
    Ok(bytes)
}

fn validate_raw(output: &ToolOutput) -> Result<(), &'static str> {
    if let ToolOutput::Operation(reply) = output
        && !matches!(
            &reply.receipt,
            maka_plugin_core::operation::Receipt::Recorded {
                outcome: maka_plugin_core::operation::OperationOutcome::Returned { .. },
                ..
            }
        )
    {
        return Err("successful operation output requires a returned receipt");
    }
    Ok(())
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
        ToolOutput::Json(value) => Some((
            match value {
                Value::String(text) => DurableToolProjection::Text { text: text.clone() },
                _ => DurableToolProjection::Json {
                    value: value.clone(),
                },
            },
            Vec::new(),
        )),
        ToolOutput::Operation(reply) => match &reply.receipt {
            maka_plugin_core::operation::Receipt::Recorded {
                outcome: maka_plugin_core::operation::OperationOutcome::Returned { value },
                ..
            } => Some((
                DurableToolProjection::Json {
                    value: value.clone(),
                },
                Vec::new(),
            )),
            _ => None,
        },
        ToolOutput::Text(text) => Some((
            DurableToolProjection::Json {
                value: serde_json::json!({"kind":"text","text":text}),
            },
            Vec::new(),
        )),
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
            Self::Json { .. } => true,
            Self::Content { parts } => {
                !parts.is_empty()
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
        Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_results_round_trip_beyond_old_depth_and_reject_unsupported_decoder_shape() {
        let nested = |depth| {
            let mut value = serde_json::json!("exact tail");
            for _ in 0..depth {
                value = Value::Array(vec![value]);
            }
            value
        };
        let value = nested(80);
        let bytes = encode_raw_tool_result(&ToolOutput::Json(value.clone())).unwrap();
        let evidence = RawToolResultRef {
            bytes: bytes.len() as u64,
            digest: content_digest(&bytes),
        };
        let ToolOutput::Json(restored) = decode_raw_tool_result(&bytes, &evidence).unwrap() else {
            panic!("raw result changed kind")
        };
        assert_eq!(restored, value);
        assert_eq!(
            encode_raw_tool_result(&ToolOutput::Json(nested(160))),
            Err("unsupported tool result encoding")
        );
    }
}
