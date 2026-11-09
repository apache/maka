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

use crate::durable::ExecutionIdentity;

use super::{DurableToolProjection, ImageOutput, ProjectionPart};
use crate::{
    capability::{CallResult, ContentBlock},
    event::ProjectionArtifactWrite,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::json;
use std::time::SystemTime;

/// Freeze the existing MCP text/image policy before T2; raw bytes stay untouched.
pub(super) fn project(
    result: &CallResult,
    id: &str,
    time: SystemTime,
    execution: &ExecutionIdentity,
) -> Option<(DurableToolProjection, Vec<ProjectionArtifactWrite>)> {
    let mut parts = Vec::new();
    let mut artifacts = Vec::new();
    for block in &result.content {
        match block {
            ContentBlock::Text { text } => parts.push(ProjectionPart::Text { text: text.clone() }),
            ContentBlock::Image { data, mime_type } => {
                let (image, artifact) =
                    image_artifact(data, mime_type, id, parts.len(), time, execution)?;
                parts.push(ProjectionPart::Artifact { image });
                artifacts.push(artifact);
            }
            ContentBlock::Audio { data, mime_type } => {
                let (part, artifact) =
                    super::audio::project(data, mime_type, id, parts.len(), time, execution)?;
                parts.push(part);
                artifacts.extend(artifact);
            }
            _ => parts.push(ProjectionPart::Text {
                text: serde_json::to_string(block).ok()?,
            }),
        }
    }
    if let Some(structured) = &result.structured_content {
        parts.push(ProjectionPart::Text {
            text: json!({"structuredContent": structured}).to_string(),
        });
    }
    if parts.is_empty() {
        parts.push(ProjectionPart::Text {
            text: "MCP tool completed with no content.".into(),
        });
    }
    Some((DurableToolProjection::Content { parts }, artifacts))
}

fn image_artifact(
    data: &str,
    mime: &str,
    event_id: &str,
    part: usize,
    time: SystemTime,
    execution: &ExecutionIdentity,
) -> Option<(ImageOutput, ProjectionArtifactWrite)> {
    let bytes = STANDARD.decode(data).ok()?;
    if STANDARD.encode(&bytes) != data {
        return None;
    }
    super::media::image_artifact(bytes, mime, event_id, part, time, execution).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    #[test]
    fn mixed_mcp_keeps_order_and_artifacts_have_stable_protected_identity() {
        let execution = ExecutionIdentity {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: crate::durable::RunId::try_from(uuid::Uuid::from_u128(1)).unwrap(),
        };
        let result = CallResult {
            content: vec![
                ContentBlock::Text {
                    text: "answer".into(),
                },
                ContentBlock::Image {
                    data: STANDARD.encode(b"\x89PNG\r\n\x1a\n"),
                    mime_type: "IMAGE/PNG".into(),
                },
                ContentBlock::Audio {
                    data: "YWJj".into(),
                    mime_type: "audio/wav".into(),
                },
            ],
            structured_content: Some(json!({"answer":42})),
        };
        let time = UNIX_EPOCH + std::time::Duration::from_millis(1234);
        let (projection, artifacts) = project(&result, "event", time, &execution).unwrap();
        let DurableToolProjection::Content { parts } = &projection else {
            panic!()
        };
        assert!(matches!(&parts[0], ProjectionPart::Text { text } if text == "answer"));
        assert!(
            matches!(&parts[1], ProjectionPart::Artifact { image } if image.mime_type == "image/png")
        );
        assert!(
            matches!(&parts[2], ProjectionPart::Audio { audio } if audio.mime_type == "audio/wav")
        );
        assert!(matches!(&parts[3], ProjectionPart::Text { text } if text.contains("42")));
        assert_eq!(artifacts[1].bytes(), b"abc");
        assert!(!artifacts[1].artifact().source.user_deletable());
        assert_eq!(artifacts[0].bytes(), b"\x89PNG\r\n\x1a\n");
        let descriptor = artifacts[0].artifact();
        assert_eq!(descriptor.created_at, 1234);
        assert!(!descriptor.source.user_deletable());
        assert_eq!(
            descriptor,
            project(&result, "event", time, &execution).unwrap().1[0].artifact()
        );
        assert_ne!(
            descriptor.id,
            project(&result, "other", time, &execution).unwrap().1[0]
                .artifact()
                .id
        );
        assert!(
            !serde_json::to_string(&projection)
                .unwrap()
                .contains("iVBOR")
        );
    }

    #[test]
    fn complete_resource_text_is_not_clipped() {
        let execution = ExecutionIdentity {
            session_id: "s".into(),
            turn_id: "t".into(),
            run_id: crate::durable::RunId::try_from(uuid::Uuid::from_u128(1)).unwrap(),
        };
        let text = "🦊".repeat(200_001);
        let result = CallResult {
            content: vec![ContentBlock::Text { text: text.clone() }],
            structured_content: None,
        };
        let (projection, artifacts) = project(&result, "e", UNIX_EPOCH, &execution).unwrap();
        assert_eq!(
            projection,
            DurableToolProjection::Content {
                parts: vec![ProjectionPart::Text { text }]
            }
        );
        assert!(artifacts.is_empty());
    }
}
