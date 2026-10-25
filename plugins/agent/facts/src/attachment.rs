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

pub const ATTACHMENT_RESOURCE_PREFIX: &str = "maka://runtime/attachments/";

/// Image signatures are fixed-offset; PDF permits a bounded leading preamble.
pub fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        return Some("image/webp");
    }
    bytes[..bytes.len().min(1024)]
        .windows(5)
        .any(|window| window == b"%PDF-")
        .then_some("application/pdf")
}

pub fn sniff_binary_mime(bytes: &[u8]) -> Option<&'static str> {
    if let Some(mime) = sniff_mime(bytes) {
        return Some(mime);
    }
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]);
    let text = text.trim_start_matches(js_whitespace).to_ascii_lowercase();
    let svg = |text: &str| {
        text.strip_prefix("<svg")
            .and_then(|rest| rest.chars().next())
            .is_some_and(|c| c == '>' || js_whitespace(c))
    };
    (svg(&text)
        || (text.starts_with("<?xml") && text.match_indices("<svg").any(|(i, _)| svg(&text[i..]))))
    .then_some("image/svg+xml")
}
fn js_whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

impl AttachmentKind {
    pub fn from_metadata(mime_type: &str, name: &str) -> Self {
        let mime = mime_type.to_lowercase();
        if mime.starts_with("image/") {
            return Self::Image;
        }
        if mime == "application/pdf" {
            return Self::Pdf;
        }
        let name = name.to_lowercase();
        match name.rsplit_once('.').map(|(_, extension)| extension) {
            Some("docx" | "doc" | "xlsx" | "xls" | "pptx" | "ppt") => Self::Doc,
            Some(
                "c" | "cc" | "cpp" | "cs" | "css" | "go" | "h" | "hpp" | "java" | "js" | "json"
                | "jsx" | "kt" | "mjs" | "cjs" | "php" | "py" | "rb" | "rs" | "sh" | "sql"
                | "svelte" | "swift" | "ts" | "tsx" | "vue" | "yaml" | "yml" | "zsh",
            ) => Self::Code,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentRef {
    pub kind: AttachmentKind,
    pub name: String,
    pub mime_type: String,
    pub bytes: u64,
    #[serde(rename = "ref")]
    pub storage_ref: StorageRef,
}

impl AttachmentRef {
    pub fn text_bytes(&self) -> usize {
        let (scope, locator) = match &self.storage_ref {
            StorageRef::SessionFile {
                session_id,
                relative_path,
            } => (session_id.as_str(), relative_path.as_str()),
            StorageRef::WorkspaceFile { relative_path } => ("", relative_path.as_str()),
            StorageRef::ExternalFile { absolute_path } => ("", absolute_path.as_str()),
            StorageRef::SessionContext { session_id, ref_id } => {
                (session_id.as_str(), ref_id.as_str())
            }
        };
        [self.name.as_str(), self.mime_type.as_str(), scope, locator]
            .into_iter()
            .fold(0usize, |bytes, text| bytes.saturating_add(text.len()))
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    Image,
    Pdf,
    Doc,
    Code,
    Other,
}
/// Canonical references; client admission must reject host-owned Session context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StorageRef {
    SessionContext {
        session_id: String,
        ref_id: String,
    },
    SessionFile {
        session_id: String,
        relative_path: String,
    },
    WorkspaceFile {
        relative_path: String,
    },
    ExternalFile {
        absolute_path: String,
    },
}

impl StorageRef {
    /// The invocation supplies Session authority; the opaque URI never does.
    pub fn resource_ref(&self) -> Option<String> {
        match self {
            Self::SessionFile { relative_path, .. }
                if crate::interaction::entity_id(relative_path).is_ok() =>
            {
                Some(format!("{ATTACHMENT_RESOURCE_PREFIX}{relative_path}"))
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modality_precedes_filename_but_mime_whitespace_is_not_reinterpreted() {
        for (mime, name, expected) in [
            ("IMAGE/PNG", "script.rs", AttachmentKind::Image),
            ("application/pdf", "sheet.xlsx", AttachmentKind::Pdf),
            (
                "application/octet-stream",
                "REPORT.DOCX",
                AttachmentKind::Doc,
            ),
            (" image/png", "script.rs", AttachmentKind::Code),
            (
                "application/pdf; charset=utf-8",
                "paper.pdf",
                AttachmentKind::Other,
            ),
        ] {
            assert_eq!(AttachmentKind::from_metadata(mime, name), expected);
        }
    }
}
