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

use super::media::MAX_MEDIA_BYTES;
use super::{DurableToolProjection, ImageOutput, ProjectionPart};
use crate::{
    capability::{CallResult, ContentBlock},
    event::{Invocation, ProjectionArtifactWrite},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::time::SystemTime;

const MAX_TEXT: usize = 200_000;
const MAX_IMAGE_CHARS: usize = 20_000_000;
const TRUNCATION_MARKER: &str = "\n…[truncated by Maka]";

/// Freeze the existing MCP text/image policy before T2; raw bytes stay untouched.
pub(super) fn project(
    result: &CallResult,
    id: &str,
    time: SystemTime,
    invocation: &Invocation,
) -> Option<(DurableToolProjection, Vec<ProjectionArtifactWrite>)> {
    let mut parts = Vec::new();
    let mut artifacts = Vec::new();
    let mut summaries = Vec::new();
    let mut remaining_text = MAX_TEXT;
    let mut image_chars = 0;
    let mut omitted = 0usize;
    for block in &result.content {
        if let ContentBlock::Text { text } = block {
            append_text(&mut parts, &mut remaining_text, text);
            continue;
        }
        if let ContentBlock::Image { data, mime_type } = block {
            let chars = utf16_len(data);
            if artifacts.len() < 4 && chars <= MAX_IMAGE_CHARS - image_chars {
                let (image, artifact) =
                    image_artifact(data, mime_type, id, parts.len(), time, invocation)?;
                parts.push(ProjectionPart::Artifact { image });
                artifacts.push(artifact);
                image_chars += chars;
                continue;
            }
        }
        if let ContentBlock::Audio { data, mime_type } = block {
            let chars = utf16_len(data);
            if artifacts.len() < 4 && chars <= MAX_IMAGE_CHARS - image_chars {
                let (part, artifact) =
                    super::audio::project(data, mime_type, id, parts.len(), time, invocation)?;
                parts.push(part);
                artifacts.extend(artifact);
                image_chars += chars;
                continue;
            }
        }
        if summaries.len() < 100 {
            summaries.push(summarize(block));
        } else {
            omitted += 1;
        }
    }
    if remaining_text > 0
        && (!summaries.is_empty() || omitted > 0 || result.structured_content.is_some())
    {
        let mut summary = json!({});
        if !summaries.is_empty() {
            summary["content"] = summaries.into();
        }
        if omitted > 0 {
            summary["omittedContentBlocks"] = json!(omitted);
        }
        if let Some(structured) = &result.structured_content {
            summary["structuredContent"] = structured.clone();
        }
        append_text(&mut parts, &mut remaining_text, &summary.to_string());
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
    invocation: &Invocation,
) -> Option<(ImageOutput, ProjectionArtifactWrite)> {
    if data.len() > MAX_MEDIA_BYTES.div_ceil(3) * 4 {
        return None;
    }
    let bytes = STANDARD.decode(data).ok()?;
    if bytes.len() > MAX_MEDIA_BYTES || STANDARD.encode(&bytes) != data {
        return None;
    }
    super::media::image_artifact(bytes, mime, event_id, part, time, invocation).ok()
}

fn summarize(block: &ContentBlock) -> Value {
    match block {
        ContentBlock::Audio { data, mime_type } => {
            json!({"type":"audio","mimeType":mime_type,"base64Chars":utf16_len(data)})
        }
        ContentBlock::Image { data, mime_type } => {
            json!({"type":"image","mimeType":mime_type,"base64Chars":utf16_len(data),"omitted":"too_large"})
        }
        ContentBlock::Unknown { .. } => json!({"type":"unknown","omitted":true}),
        ContentBlock::Resource {
            uri,
            mime_type,
            text,
            blob,
        } => {
            let mut summary = json!({"type":"resource","uri":uri});
            if let Some(mime) = mime_type {
                summary["mimeType"] = json!(mime);
            }
            if let Some(text) = text {
                summary["text"] = json!(clip_text(text, MAX_TEXT));
            }
            if let Some(blob) = blob {
                if blob.is_empty() {
                    summary["blob"] = json!("");
                } else {
                    summary["base64Chars"] = json!(utf16_len(blob));
                }
            }
            summary
        }
        _ => serde_json::to_value(block).expect("content blocks contain JSON values"),
    }
}
fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}
fn append_text(parts: &mut Vec<ProjectionPart>, remaining: &mut usize, text: &str) {
    if *remaining > 0 {
        let text = clip_text(text, *remaining);
        *remaining -= utf16_len(&text);
        parts.push(ProjectionPart::Text { text });
    }
}
fn clip_text(text: &str, limit: usize) -> String {
    if utf16_len(text) <= limit {
        return text.to_owned();
    }
    let marker_len = utf16_len(TRUNCATION_MARKER);
    if limit <= marker_len {
        return TRUNCATION_MARKER.chars().take(limit).collect();
    }
    let mut units = 0;
    let prefix: String = text
        .chars()
        .take_while(|ch| {
            units += ch.len_utf16();
            units <= limit - marker_len
        })
        .collect();
    prefix + TRUNCATION_MARKER
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    #[test]
    fn mixed_mcp_keeps_order_and_artifacts_have_stable_protected_identity() {
        let invocation = Invocation {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
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
        let (projection, artifacts) = project(&result, "event", time, &invocation).unwrap();
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
            project(&result, "event", time, &invocation).unwrap().1[0].artifact()
        );
        assert_ne!(
            descriptor.id,
            project(&result, "other", time, &invocation).unwrap().1[0]
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
    fn utf16_clipping_and_empty_resource_blob_match_source_policy() {
        let text = clip_text(&"🦊".repeat(MAX_TEXT), MAX_TEXT);
        assert!(utf16_len(&text) <= MAX_TEXT);
        assert!(text.ends_with(TRUNCATION_MARKER));
        for limit in 0..=utf16_len(TRUNCATION_MARKER) {
            assert_eq!(
                clip_text(&"🦊".repeat(30), limit),
                TRUNCATION_MARKER.chars().take(limit).collect::<String>()
            );
        }
        assert_eq!(
            summarize(&ContentBlock::Resource {
                uri: "x".into(),
                mime_type: None,
                text: None,
                blob: Some(String::new())
            })["blob"],
            ""
        );
    }
}
