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

use crate::{Error, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;
use std::{borrow::Cow, collections::BTreeMap};

/// Provider options are opaque extensions until the selected protocol decodes
/// them. They never authorize network, filesystem or tool execution capabilities.
pub type Extensions = Option<BTreeMap<String, Value>>;

#[derive(Debug, Clone)]
pub enum Message {
    System {
        text: String,
        extensions: Extensions,
    },
    User {
        parts: Vec<UserPart>,
        extensions: Extensions,
    },
    Assistant {
        parts: Vec<AssistantPart>,
        extensions: Extensions,
    },
    Tool {
        results: Vec<ToolResult>,
        extensions: Extensions,
    },
}
#[derive(Debug, Clone)]
pub enum UserPart {
    Text {
        text: String,
        extensions: Extensions,
    },
    File(File),
    Custom {
        kind: String,
        extensions: Extensions,
    },
}
impl UserPart {
    pub fn extensions(&self) -> &Extensions {
        match self {
            Self::Text { extensions, .. } | Self::Custom { extensions, .. } => extensions,
            Self::File(file) => &file.extensions,
        }
    }
}
#[derive(Debug, Clone)]
pub enum AssistantPart {
    Text {
        text: String,
        extensions: Extensions,
    },
    Reasoning {
        text: String,
        extensions: Extensions,
    },
    ToolCall(ToolCall),
    ToolResult(ToolResult),
    Custom {
        kind: String,
        extensions: Extensions,
    },
}
impl AssistantPart {
    pub fn extensions(&self) -> &Extensions {
        match self {
            Self::Text { extensions, .. }
            | Self::Reasoning { extensions, .. }
            | Self::Custom { extensions, .. } => extensions,
            Self::ToolCall(call) => &call.extensions,
            Self::ToolResult(result) => &result.extensions,
        }
    }
}
#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
    pub provider_executed: bool,
    pub extensions: Extensions,
}
#[derive(Debug, Clone)]
pub struct ToolResult {
    pub id: String,
    pub name: String,
    pub output: ToolOutput,
    pub extensions: Extensions,
}
#[derive(Debug, Clone)]
pub struct ToolOutput {
    pub value: ToolValue,
    pub extensions: Extensions,
}
#[derive(Debug, Clone)]
pub enum ToolValue {
    Text(String),
    Json(Value),
    ErrorText(String),
    ErrorJson(Value),
    Denied { reason: Option<String> },
    Content(Vec<UserPart>),
}
#[derive(Debug, Clone)]
pub struct File {
    pub media_type: String,
    pub filename: Option<String>,
    pub source: FileSource,
    pub extensions: Extensions,
}
#[derive(Debug, Clone)]
pub enum FileSource {
    Inline(InlineData),
    Url(String),
    Text(String),
    Reference(BTreeMap<String, Value>),
}
#[derive(Debug, Clone)]
pub enum InlineData {
    Bytes(Vec<u8>),
    Base64(String),
}
impl InlineData {
    pub fn bytes(&self) -> Result<Cow<'_, [u8]>> {
        match self {
            Self::Bytes(bytes) => Ok(Cow::Borrowed(bytes)),
            Self::Base64(text) => {
                STANDARD
                    .decode(text)
                    .map(Cow::Owned)
                    .map_err(|_| Error::InvalidArgument {
                        field: "base64 media data".into(),
                        value: Value::Null,
                    })
            }
        }
    }
    pub fn base64(&self) -> Cow<'_, str> {
        match self {
            Self::Bytes(bytes) => Cow::Owned(STANDARD.encode(bytes)),
            Self::Base64(text) => Cow::Borrowed(text),
        }
    }
}
impl File {
    pub fn reference(&self, provider: &str) -> Result<&Value> {
        let FileSource::Reference(references) = &self.source else {
            return Err(Error::InvalidArgument {
                field: "provider media reference".into(),
                value: Value::Null,
            });
        };
        references
            .get(provider)
            .filter(|v| !v.is_null())
            .ok_or_else(|| Error::MissingReference {
                provider: provider.into(),
                reference: serde_json::to_value(references).expect("reference values are JSON"),
            })
    }
    pub fn resolved_media_type(&self) -> Result<Cow<'_, str>> {
        if self.media_type.contains('/') && !self.media_type.ends_with("/*") {
            return Ok(Cow::Borrowed(&self.media_type));
        }
        let top = self.media_type.split('/').next().unwrap_or_default();
        if let FileSource::Inline(data) = &self.source {
            let bytes = data.bytes()?;
            let detected = match top {
                "image" if bytes.starts_with(b"\x89PNG") => Some("image/png"),
                "image" if bytes.starts_with(&[0xff, 0xd8, 0xff]) => Some("image/jpeg"),
                "image" if bytes.starts_with(b"GIF8") => Some("image/gif"),
                "image" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => {
                    Some("image/webp")
                }
                "audio" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE") => {
                    Some("audio/wav")
                }
                "audio"
                    if bytes.starts_with(b"ID3")
                        || (bytes.first() == Some(&0xff)
                            && bytes.get(1).is_some_and(|v| v & 0xe0 == 0xe0)) =>
                {
                    Some("audio/mpeg")
                }
                "audio" if bytes.starts_with(b"OggS") => Some("audio/ogg"),
                "audio" if bytes.starts_with(b"fLaC") => Some("audio/flac"),
                "application" if bytes.starts_with(b"%PDF-") => Some("application/pdf"),
                "video" if bytes.get(4..8) == Some(b"ftyp") => Some("video/mp4"),
                _ => None,
            };
            if let Some(media_type) = detected {
                return Ok(Cow::Borrowed(media_type));
            }
        }
        Err(Error::unsupported(format!(
            "file of media type \"{}\" must specify subtype since {}",
            self.media_type,
            if matches!(self.source, FileSource::Inline(_)) {
                "it could not be auto-detected"
            } else {
                "it is not passed as inline bytes"
            }
        )))
    }
}
