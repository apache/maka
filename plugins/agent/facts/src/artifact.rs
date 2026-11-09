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

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Canonical tool-return manifest. The body codec belongs to its actual consumer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishedArtifact {
    pub artifact: Artifact,
    pub payload: crate::durable::ContentRef,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolReturn<T> {
    pub schema_version: u32,
    pub artifacts: Vec<PublishedArtifact>,
    pub body: T,
}
impl<T> ToolReturn<T> {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != crate::durable::SCHEMA_VERSION {
            return Err("unsupported tool return schema");
        }
        for published in &self.artifacts {
            published.artifact.validate()?;
            published.payload.validate()?;
            if published.artifact.size_bytes != published.payload.bytes {
                return Err("artifact payload length mismatch");
            }
        }
        Ok(())
    }
}

/// Material committed atomically with a canonical fact, not a best-effort file reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactEvidence {
    pub id: String,
    pub bytes: u64,
    pub digest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    File,
    Diff,
    Html,
    Image,
    Pdf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactSource {
    ToolResult,
    ToolResultProjection,
    ToolResultArchive,
    SubagentWriteback,
    UserUpload,
    SessionEffect,
}

impl ArtifactSource {
    pub fn user_deletable(self) -> bool {
        matches!(self, Self::ToolResult | Self::UserUpload)
    }
}

/// Canonical descriptor. The payload is owned by storage, never a renderer path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Artifact {
    pub id: String,
    pub session_id: String,
    pub turn_id: String,
    pub created_at: u64,
    pub name: String,
    pub kind: ArtifactKind,
    pub size_bytes: u64,
    #[serde(
        default,
        deserialize_with = "optional_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub mime_type: Option<String>,
    pub source: ArtifactSource,
    #[serde(
        default,
        deserialize_with = "optional_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub summary: Option<String>,
}

impl Artifact {
    pub fn validate_attachment(
        &self,
        attachment: &crate::attachment::AttachmentRef,
    ) -> Result<(), &'static str> {
        use crate::attachment::AttachmentKind;
        if self.name != attachment.name
            || self.mime_type.as_deref() != Some(attachment.mime_type.as_str())
            || self.size_bytes != attachment.bytes
        {
            return Err("Attachment metadata does not match its canonical Artifact");
        }
        let kind = AttachmentKind::from_metadata(&attachment.mime_type, &self.name);
        if attachment.kind != kind
            || (kind == AttachmentKind::Image) != (self.kind == ArtifactKind::Image)
            || (kind == AttachmentKind::Pdf) != (self.kind == ArtifactKind::Pdf)
        {
            return Err("Attachment kind does not match its canonical Artifact");
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        crate::interaction::entity_id(&self.id)?;
        crate::interaction::entity_id(&self.session_id)?;
        if self.turn_id.is_empty()
            || self.turn_id.bytes().any(|b| b < 32 || b == 127)
            || self.created_at > 9_007_199_254_740_991
            || self.size_bytes > 9_007_199_254_740_991
            || self.name.is_empty()
            || self.mime_type.as_ref().is_some_and(String::is_empty)
            || self.summary.as_ref().is_some_and(String::is_empty)
        {
            return Err("Invalid artifact descriptor");
        }
        Ok(())
    }
}

fn optional_text<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

/// Stable logical identity makes an acknowledged or ambiguous upload retryable
/// without assigning it a different destination or overwriting another artifact.
pub fn upload_artifact_id(session_id: &str, upload_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(session_id);
    digest.update([0]);
    digest.update(upload_id);
    format!("attachment-{}", &hex::encode(digest.finalize())[..32])
}

pub fn content_digest(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

pub fn workspace_patch_id(session: &str, turn: &str) -> String {
    let identity = serde_json::to_vec(&(session, turn)).expect("string identity serializes");
    format!("worktree-{}", hex::encode(Sha256::digest(identity)))
}

pub fn normalize_name(name: &str) -> String {
    let mut cleaned = String::new();
    let mut whitespace = false;
    for character in name.trim_matches(js_whitespace).chars() {
        if js_whitespace(character) {
            if !whitespace {
                cleaned.push(' ');
            }
            whitespace = true;
        } else {
            cleaned.push(if "\\/:*?\"<>|\0".contains(character) {
                '-'
            } else {
                character
            });
            whitespace = false;
        }
    }
    let cleaned = cleaned.trim_matches([' ', '.', '-']);
    let result = cleaned;
    if result.is_empty() {
        "artifact".into()
    } else {
        result.into()
    }
}

fn js_whitespace(character: char) -> bool {
    matches!(character, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' |
        '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' |
        '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attachment::{AttachmentKind, AttachmentRef, StorageRef};

    #[test]
    fn canonical_metadata_and_bidirectional_modality_are_required_without_source_restriction() {
        let attachment = AttachmentRef {
            kind: AttachmentKind::Image,
            name: "picture.png".into(),
            mime_type: "image/png".into(),
            bytes: 4,
            storage_ref: StorageRef::SessionFile {
                session_id: "session".into(),
                relative_path: "artifact".into(),
            },
        };
        let mut record = Artifact {
            id: "artifact".into(),
            session_id: "session".into(),
            turn_id: "turn".into(),
            created_at: 1,
            name: attachment.name.clone(),
            kind: ArtifactKind::Image,
            size_bytes: attachment.bytes,
            mime_type: Some(attachment.mime_type.clone()),
            source: ArtifactSource::ToolResultProjection,
            summary: None,
        };
        assert!(record.validate_attachment(&attachment).is_ok());
        for changed in [
            AttachmentRef {
                name: "other.png".into(),
                ..attachment.clone()
            },
            AttachmentRef {
                mime_type: "image/jpeg".into(),
                ..attachment.clone()
            },
            AttachmentRef {
                bytes: 5,
                ..attachment.clone()
            },
            AttachmentRef {
                kind: AttachmentKind::Other,
                ..attachment.clone()
            },
        ] {
            assert!(record.validate_attachment(&changed).is_err());
        }
        record.kind = ArtifactKind::File;
        assert!(record.validate_attachment(&attachment).is_err());
        let mut text = attachment;
        text.mime_type = "text/plain".into();
        text.kind = AttachmentKind::Other;
        record.mime_type = Some(text.mime_type.clone());
        assert!(record.validate_attachment(&text).is_ok());
        for kind in [ArtifactKind::Image, ArtifactKind::Pdf] {
            record.kind = kind;
            assert!(record.validate_attachment(&text).is_err());
        }
    }

    #[test]
    fn names_are_complete_and_idempotent_with_javascript_whitespace() {
        for (input, expected) in [
            (" ../unsafe:name?.txt ".into(), "unsafe-name-.txt".into()),
            ("-.gitignore".into(), "gitignore".into()),
            ("\u{feff}  . a\u{feff}".into(), "a".into()),
            ("\u{0085}a\u{0085}".into(), "\u{0085}a\u{0085}".into()),
            (
                format!("{}😀", "a".repeat(119)),
                format!("{}😀", "a".repeat(119)),
            ),
            (". -- ".into(), "artifact".into()),
        ] {
            assert_eq!(normalize_name(&input), expected);
            assert_eq!(normalize_name(&expected), expected);
        }
    }
}
