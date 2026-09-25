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

use super::{DurableToolProjection, ImageOutput, ToolOutput, durable::freeze};
use crate::{
    artifact::{Artifact, ArtifactKind, ArtifactSource, content_digest},
    attachment::StorageRef,
    event::{Invocation, ProjectionArtifactWrite},
};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) const MAX_MEDIA_BYTES: usize = 5 * 1024 * 1024;

/// Effect output awaiting T2 normalization. This is intentionally not serializable:
/// pending image bytes must become an immutable Session ref before delivery.
#[derive(Debug)]
pub struct ToolSuccess(ToolSuccessValue);

#[derive(Debug)]
enum ToolSuccessValue {
    Output(ToolOutput),
    Projected {
        output: ToolOutput,
        projection: DurableToolProjection,
    },
    Image {
        bytes: Vec<u8>,
        mime_type: String,
    },
    Content {
        output: ToolOutput,
        parts: Vec<ToolContent>,
    },
}

/// Ordered explicit output, normalized to immutable evidence at settlement.
#[derive(Clone, Debug)]
pub enum ToolContent {
    Text(String),
    Image(ImageOutput),
    Media {
        content: crate::capability::ContentBlock,
        detail: Option<super::ImageDetail>,
    },
}

pub(crate) struct NormalizedToolSuccess {
    pub output: ToolOutput,
    pub projection: DurableToolProjection,
    pub artifacts: Vec<ProjectionArtifactWrite>,
}

impl From<ToolOutput> for ToolSuccess {
    fn from(output: ToolOutput) -> Self {
        Self(ToolSuccessValue::Output(output))
    }
}
impl From<Value> for ToolSuccess {
    fn from(value: Value) -> Self {
        ToolOutput::Json(value).into()
    }
}

impl ToolSuccess {
    pub fn content(output: ToolOutput, parts: Vec<ToolContent>) -> Self {
        Self(ToolSuccessValue::Content { output, parts })
    }
    /// Freeze an executor-owned model view alongside the unmodified raw result.
    /// Invalid projections become projection failures, not failed tool effects.
    pub fn projected(output: ToolOutput, projection: DurableToolProjection) -> Self {
        Self(ToolSuccessValue::Projected { output, projection })
    }

    /// The executor owns authorization and image-header/dimension validation.
    /// Core checks representation bounds before accepting pending media.
    pub fn image(bytes: Vec<u8>, mime_type: String) -> Result<Self, &'static str> {
        if bytes.len() > MAX_MEDIA_BYTES {
            return Err("tool image exceeds 5 MiB byte limit");
        }
        let mime_type = normalize_mime(&mime_type).ok_or("unsafe tool image MIME")?;
        Ok(Self(ToolSuccessValue::Image { bytes, mime_type }))
    }

    pub(crate) fn normalize(
        self,
        id: &str,
        time: SystemTime,
        invocation: &Invocation,
    ) -> Result<NormalizedToolSuccess, &'static str> {
        let (output, pending_image) = match self.0 {
            ToolSuccessValue::Content { output, parts } => {
                if parts.len() > 64 {
                    return Ok(NormalizedToolSuccess {
                        output,
                        projection: DurableToolProjection::Failure,
                        artifacts: Vec::new(),
                    });
                }
                let mut projection = Vec::new();
                let mut artifacts = Vec::new();
                let mut valid = true;
                for (index, part) in parts.into_iter().enumerate() {
                    match part {
                        ToolContent::Text(text) => {
                            projection.push(super::ProjectionPart::Text { text })
                        }
                        ToolContent::Image(image) => {
                            projection.push(super::ProjectionPart::Artifact { image })
                        }
                        ToolContent::Media { content, detail } => {
                            let result = crate::capability::CallResult {
                                content: vec![content],
                                structured_content: None,
                            };
                            let Some((media, writes)) = super::mcp::project(
                                &result,
                                &format!("{id}:{index}"),
                                time,
                                invocation,
                            ) else {
                                valid = false;
                                break;
                            };
                            if let DurableToolProjection::Content { mut parts } = media {
                                for part in &mut parts {
                                    if let super::ProjectionPart::Artifact { image } = part {
                                        image.detail = detail;
                                    }
                                }
                                projection.extend(parts);
                            }
                            artifacts.extend(writes);
                        }
                    }
                }
                let mut projection = if projection
                    .iter()
                    .all(|part| matches!(part, super::ProjectionPart::Text { .. }))
                {
                    DurableToolProjection::Text {
                        text: projection
                            .into_iter()
                            .filter_map(|part| match part {
                                super::ProjectionPart::Text { text } => Some(text),
                                _ => None,
                            })
                            .collect::<Vec<_>>()
                            .join("\n"),
                    }
                } else {
                    DurableToolProjection::Content { parts: projection }
                };
                if !valid || projection.validate(&invocation.session_id).is_err() {
                    projection = DurableToolProjection::Failure;
                    artifacts.clear();
                }
                return Ok(NormalizedToolSuccess {
                    output,
                    projection,
                    artifacts,
                });
            }
            ToolSuccessValue::Output(output) => (output, None),
            ToolSuccessValue::Projected { output, projection } => {
                let projection = if projection.validate(&invocation.session_id).is_ok() {
                    projection
                } else {
                    DurableToolProjection::Failure
                };
                return Ok(NormalizedToolSuccess {
                    output,
                    projection,
                    artifacts: Vec::new(),
                });
            }
            ToolSuccessValue::Image { bytes, mime_type } => {
                let (image, artifact) = image_artifact(bytes, &mime_type, id, 0, time, invocation)?;
                (ToolOutput::Image(image), Some(artifact))
            }
        };
        let (projection, mut artifacts) = freeze(&output, id, time, invocation);
        if let Some(image) = pending_image {
            artifacts.push(image);
        }
        Ok(NormalizedToolSuccess {
            output,
            projection,
            artifacts,
        })
    }
}

pub(super) fn normalize_mime(mime: &str) -> Option<String> {
    let mime = mime.trim().to_ascii_lowercase();
    matches!(
        mime.as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif"
    )
    .then_some(mime)
}

/// The T2 identity and part position make exact retries stable without a new
/// media authority. Bytes and descriptor are submitted in the same EventWrite.
pub(super) fn image_artifact(
    bytes: Vec<u8>,
    mime: &str,
    event_id: &str,
    part: usize,
    time: SystemTime,
    invocation: &Invocation,
) -> Result<(ImageOutput, ProjectionArtifactWrite), &'static str> {
    if bytes.len() > MAX_MEDIA_BYTES {
        return Err("tool image exceeds 5 MiB byte limit");
    }
    let mime_type = normalize_mime(mime).ok_or("unsafe tool image MIME")?;
    let (reference, artifact) =
        media_artifact(bytes, &mime_type, event_id, part, time, invocation)?;
    Ok((
        ImageOutput {
            detail: None,
            mime_type,
            reference,
        },
        artifact,
    ))
}

pub(super) fn media_artifact(
    bytes: Vec<u8>,
    mime: &str,
    event_id: &str,
    part: usize,
    time: SystemTime,
    invocation: &Invocation,
) -> Result<(StorageRef, ProjectionArtifactWrite), &'static str> {
    let id = format!(
        "tool-projection-{}",
        &content_digest(format!("{event_id}\0{part}").as_bytes())[7..39]
    );
    let reference = StorageRef::SessionFile {
        session_id: invocation.session_id.clone(),
        relative_path: id.clone(),
    };
    let image = mime.starts_with("image/");
    let artifact = Artifact {
        id,
        session_id: invocation.session_id.clone(),
        turn_id: invocation.turn_id.clone(),
        created_at: u64::try_from(
            time.duration_since(UNIX_EPOCH)
                .map_err(|_| "invalid media capture time")?
                .as_millis(),
        )
        .map_err(|_| "invalid media capture time")?,
        name: format!(
            "tool-result-{}-{part}",
            if image { "image" } else { "audio" }
        ),
        kind: if image {
            ArtifactKind::Image
        } else {
            ArtifactKind::File
        },
        size_bytes: bytes.len() as u64,
        mime_type: Some(mime.into()),
        source: ArtifactSource::ToolResultProjection,
        summary: None,
    };
    artifact.validate()?;
    Ok((reference, ProjectionArtifactWrite::new(artifact, bytes)))
}
