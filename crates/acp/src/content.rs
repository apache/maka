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

//! Validate the entire prompt before publishing any caller-owned attachments.
use agent_client_protocol::schema::v2 as acp;
use maka_client::Client;
use maka_protocol::{
    artifact,
    turn::{AttachmentKind, AttachmentRef, MessageContent, StorageRef},
};
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

mod io;
mod upload;

pub fn capabilities() -> acp::PromptCapabilities {
    acp::PromptCapabilities::new()
        .image(acp::PromptImageCapabilities::default())
        .embedded_context(acp::PromptEmbeddedContextCapabilities::default())
}

struct Pending {
    name: String,
    mime: Option<String>,
    source: Source,
}
enum Source {
    File(PathBuf),
    Bytes(Vec<u8>),
}
struct Prepared {
    id: String,
    reference: AttachmentRef,
    bytes: Vec<u8>,
}

pub async fn prepare(
    client: &Client,
    session: &str,
    blocks: Vec<acp::ContentBlock>,
    cancel: &CancellationToken,
) -> Result<MessageContent, crate::Error> {
    let (mut content, pending) = validate(blocks)?;
    let mut prepared = Vec::with_capacity(pending.len());
    for item in pending {
        active(cancel)?;
        let bytes = match item.source {
            Source::Bytes(bytes) => bytes,
            Source::File(path) => io::read(path, cancel).await?,
        };
        let mime = artifact::sniff_binary_mime(&bytes)
            .map(str::to_owned)
            .or(item.mime)
            .unwrap_or_else(|| "application/octet-stream".into());
        let id = uuid::Uuid::new_v4().to_string();
        let reference = AttachmentRef {
            kind: AttachmentKind::from_metadata(&mime, &item.name),
            name: item.name,
            mime_type: mime,
            bytes: bytes.len() as u64,
            storage_ref: StorageRef::SessionFile {
                session_id: session.into(),
                relative_path: artifact::upload_artifact_id(session, &id),
            },
        };
        // Includes metadata control characters and the Host's upload limits.
        artifact::decode_ingest_input(&serde_json::to_value(upload::begin(
            session, &id, &reference, &bytes,
        ))?)?;
        prepared.push(Prepared {
            id,
            reference,
            bytes,
        });
    }
    content.attachments =
        (!prepared.is_empty()).then(|| prepared.iter().map(|p| p.reference.clone()).collect());
    // This also catches total encoded input size before any artifact is uploaded.
    content.validate_admission(false)?;
    for item in prepared {
        upload::publish(client, session, item, cancel).await?;
    }
    active(cancel)?;
    Ok(content)
}

fn validate(
    blocks: Vec<acp::ContentBlock>,
) -> Result<(MessageContent, Vec<Pending>), crate::Error> {
    let mut parts = Vec::new();
    let mut pending = Vec::new();
    let mut text_bytes = 0usize;
    for block in blocks {
        let text = match block {
            acp::ContentBlock::Text(value) => Some(value.text),
            acp::ContentBlock::ResourceLink(value) => {
                let uri = resource_uri(&value.uri)?;
                if uri.scheme() == "file" {
                    if uri
                        .host_str()
                        .is_some_and(|s| !s.is_empty() && s != "localhost")
                        || uri.query().is_some()
                        || uri.fragment().is_some()
                    {
                        return Err("Unsupported local resource URI".into());
                    }
                    let path = uri
                        .to_file_path()
                        .map_err(|_| "Invalid local resource URI")?;
                    let name = if value.name.is_empty() {
                        path.file_name()
                            .and_then(|s| s.to_str())
                            .ok_or("Invalid resource filename")?
                            .to_owned()
                    } else {
                        value.name
                    };
                    pending.push(Pending {
                        name: name.clone(),
                        mime: value.mime_type.map(|mime| mime.to_string()),
                        source: Source::File(path),
                    });
                    Some(format!("Resource: {name}\n{}", value.uri))
                } else {
                    // A link is context, not a claim that its contents were retrieved.
                    Some(format!("Resource: {}\n{}", value.name, value.uri))
                }
            }
            acp::ContentBlock::Resource(value) => match value.resource {
                acp::EmbeddedResourceResource::TextResourceContents(value) => {
                    resource_uri(&value.uri)?;
                    Some(format!("Resource: {}\n{}", value.uri, value.text))
                }
                acp::EmbeddedResourceResource::BlobResourceContents(value) => {
                    let uri = resource_uri(&value.uri)?;
                    pending.push(Pending {
                        name: uri
                            .path_segments()
                            .and_then(|mut p| p.next_back())
                            .filter(|s| !s.is_empty())
                            .unwrap_or("resource")
                            .into(),
                        mime: value.mime_type.map(|mime| mime.to_string()),
                        source: Source::Bytes(decode(&value.blob)?),
                    });
                    Some(format!("Resource: {}", value.uri))
                }
                _ => return Err("Unsupported embedded resource type".into()),
            },
            acp::ContentBlock::Image(value) => {
                if !value.mime_type.as_ref().starts_with("image/") {
                    return Err("Invalid image MIME type".into());
                }
                if let Some(uri) = &value.uri {
                    resource_uri(uri)?;
                }
                pending.push(Pending {
                    name: "image".into(),
                    mime: Some(value.mime_type.to_string()),
                    source: Source::Bytes(decode(&value.data)?),
                });
                None
            }
            _ => return Err("Unsupported prompt content type".into()),
        };
        if pending.len() > 8 {
            return Err("Too many attachments".into());
        }
        if let Some(text) = text {
            text_bytes = text_bytes
                .saturating_add(text.len())
                .saturating_add(if parts.is_empty() { 0 } else { 2 });
            if text_bytes > 48 * 1024 {
                return Err("Prompt text exceeds byte limit".into());
            }
            parts.push(text);
        }
    }
    for item in &mut pending {
        metadata(&item.name, 512)?;
        item.name = artifact::normalize_name(&item.name);
        if let Some(mime) = &item.mime {
            metadata(mime, 256)?;
        }
    }
    Ok((
        MessageContent {
            text: parts.join("\n\n"),
            display_text: None,
            attachments: None,
            directory_references: None,
            quotes: None,
            inline_references: None,
        },
        pending,
    ))
}

fn metadata(value: &str, max: usize) -> Result<(), crate::Error> {
    if value.is_empty() || value.len() > max || value.bytes().any(|b| b < 32 || b == 127) {
        return Err("Invalid attachment metadata".into());
    }
    Ok(())
}
fn resource_uri(value: &str) -> Result<url::Url, crate::Error> {
    if value.len() > 4096 || value.chars().any(char::is_control) {
        return Err("Invalid resource URI".into());
    }
    Ok(url::Url::parse(value).map_err(|_| "Invalid resource URI")?)
}
fn decode(value: &str) -> Result<Vec<u8>, crate::Error> {
    Ok(artifact::decode_chunk(
        value,
        artifact::MAX_ATTACHMENT_BYTES as usize,
    )?)
}
fn active(cancel: &CancellationToken) -> Result<(), crate::Error> {
    if cancel.is_cancelled() {
        Err("Prompt cancelled".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn block(value: serde_json::Value) -> acp::ContentBlock {
        serde_json::from_value(value).unwrap()
    }
    #[test]
    fn text_and_remote_links_are_explicit_context() {
        let (content, files) = validate(vec!["hello".into(), block(serde_json::json!({"type":"resource_link", "uri":"https://example.com/doc", "name":"guide"}))]).unwrap();
        assert_eq!(
            content.text,
            "hello\n\nResource: guide\nhttps://example.com/doc"
        );
        assert!(files.is_empty());
    }
    #[test]
    fn rejects_bad_payloads_and_limits_before_io() {
        assert!(validate(vec!["x".repeat(48 * 1024 + 1).into()]).is_err());
        assert!(
            validate(vec![block(
                serde_json::json!({"type":"image", "data":"!", "mimeType":"image/png"})
            )])
            .is_err()
        );
        let link = block(
            serde_json::json!({"type":"resource_link", "uri":"file:///missing", "name":"file"}),
        );
        assert!(validate(vec![link; 9]).is_err());
        assert!(validate(vec![block(serde_json::json!({"type":"resource_link", "uri":"file:///tmp/a?query", "name":"file"}))]).is_err());
    }
    #[test]
    fn embedded_text_keeps_uri_and_content() {
        let (content, _) = validate(vec![block(serde_json::json!({"type":"resource", "resource":{"uri":"memory://context", "text":"actual content"}}))]).unwrap();
        assert!(content.text.contains("memory://context\nactual content"));
    }
}
