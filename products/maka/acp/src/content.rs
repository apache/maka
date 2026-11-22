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
use crate::client::Client;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use maka_agent_facts::artifact;
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

mod io;
mod upload;

#[derive(Clone, Debug)]
pub(crate) enum Input {
    Text(String),
    Link {
        uri: String,
        name: String,
        mime: Option<String>,
    },
    EmbeddedText {
        uri: String,
        text: String,
    },
    EmbeddedBlob {
        uri: String,
        blob: String,
        mime: Option<String>,
    },
    Image {
        data: String,
        mime: String,
        uri: Option<String>,
    },
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
pub struct Message {
    pub text: String,
    pub attachments: Vec<String>,
}
struct Prepared {
    name: String,
    bytes: Vec<u8>,
}
pub async fn prepare(
    client: &Client,
    session: &str,
    blocks: Vec<Input>,
    cancel: &CancellationToken,
) -> Result<Message, crate::Error> {
    let (mut content, pending) = validate(blocks)?;
    let mut prepared = Vec::with_capacity(pending.len());
    for item in pending {
        active(cancel)?;
        let bytes = match item.source {
            Source::Bytes(bytes) => bytes,
            Source::File(path) => io::read(path, cancel).await?,
        };
        if bytes.is_empty() {
            return Err("Invalid attachment byte length".into());
        }
        prepared.push(Prepared {
            name: item.name,
            bytes,
        });
    }
    for item in prepared {
        content
            .attachments
            .push(upload::publish(client, session, item, cancel).await?);
    }
    active(cancel)?;
    Ok(content)
}

fn validate(blocks: Vec<Input>) -> Result<(Message, Vec<Pending>), crate::Error> {
    let mut parts = Vec::new();
    let mut pending = Vec::new();
    let mut text_bytes = 0usize;
    for block in blocks {
        let text = match block {
            Input::Text(text) => Some(text),
            Input::Link { uri, name, mime } => {
                let uri = resource_uri(&uri)?;
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
                    let name = if name.is_empty() {
                        path.file_name()
                            .and_then(|s| s.to_str())
                            .ok_or("Invalid resource filename")?
                            .to_owned()
                    } else {
                        name
                    };
                    pending.push(Pending {
                        name: name.clone(),
                        mime,
                        source: Source::File(path),
                    });
                    Some(format!("Resource: {name}\n{}", uri))
                } else {
                    // A link is context, not a claim that its contents were retrieved.
                    Some(format!("Resource: {}\n{}", name, uri))
                }
            }
            Input::EmbeddedText { uri, text } => {
                resource_uri(&uri)?;
                Some(format!("Resource: {uri}\n{text}"))
            }
            Input::EmbeddedBlob { uri, blob, mime } => {
                let parsed = resource_uri(&uri)?;
                pending.push(Pending {
                    name: parsed
                        .path_segments()
                        .and_then(|mut p| p.next_back())
                        .filter(|s| !s.is_empty())
                        .unwrap_or("resource")
                        .into(),
                    mime,
                    source: Source::Bytes(decode(&blob)?),
                });
                Some(format!("Resource: {uri}"))
            }
            Input::Image { data, mime, uri } => {
                if !mime.starts_with("image/") {
                    return Err("Invalid image MIME type".into());
                }
                if let Some(uri) = &uri {
                    resource_uri(uri)?;
                }
                pending.push(Pending {
                    name: "image".into(),
                    mime: Some(mime),
                    source: Source::Bytes(decode(&data)?),
                });
                None
            }
        };
        if let Some(text) = text {
            text_bytes = text_bytes
                .checked_add(text.len())
                .and_then(|bytes| bytes.checked_add(if parts.is_empty() { 0 } else { 2 }))
                .ok_or("Prompt text size is not representable")?;
            parts.push(text);
        }
    }
    for item in &mut pending {
        metadata(&item.name)?;
        item.name = artifact::normalize_name(&item.name);
        if let Some(mime) = &item.mime {
            metadata(mime)?;
        }
    }
    let mut text = String::new();
    text.try_reserve(text_bytes)?;
    for (index, part) in parts.into_iter().enumerate() {
        if index > 0 {
            text.push_str("\n\n");
        }
        text.push_str(&part);
    }
    Ok((
        Message {
            text,
            attachments: vec![],
        },
        pending,
    ))
}

fn metadata(value: &str) -> Result<(), crate::Error> {
    if value.is_empty() || value.bytes().any(|b| b < 32 || b == 127) {
        return Err("Invalid attachment metadata".into());
    }
    Ok(())
}
fn resource_uri(value: &str) -> Result<url::Url, crate::Error> {
    if value.chars().any(char::is_control) {
        return Err("Invalid resource URI".into());
    }
    Ok(url::Url::parse(value).map_err(|_| "Invalid resource URI")?)
}
fn decode(value: &str) -> Result<Vec<u8>, crate::Error> {
    let capacity = (value.len() / 4)
        .checked_mul(3)
        .and_then(|bytes| bytes.checked_add(3))
        .ok_or("Attachment size is not representable")?;
    let mut bytes = Vec::new();
    bytes.try_reserve(capacity)?;
    STANDARD.decode_vec(value, &mut bytes)?;
    Ok(bytes)
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
    fn block(value: serde_json::Value) -> Input {
        crate::transport::v2::content(serde_json::from_value(value).unwrap()).unwrap()
    }
    #[test]
    fn text_links_and_embedded_resources_preserve_explicit_context() {
        let (content, files) = validate(vec![
            Input::Text("hello".into()),
            block(serde_json::json!({"type":"resource_link", "uri":"https://example.com/doc", "name":"guide"})),
            block(serde_json::json!({"type":"resource", "resource":{"uri":"memory://context", "text":"actual content"}})),
        ]).unwrap();
        assert_eq!(
            content.text,
            "hello\n\nResource: guide\nhttps://example.com/doc\n\nResource: memory://context\nactual content"
        );
        assert!(files.is_empty());
    }
    #[test]
    fn complete_context_preserves_validation_before_io() {
        assert_eq!(
            validate(vec![Input::Text("x".repeat(48 * 1024 + 1))])
                .unwrap()
                .0
                .text,
            "x".repeat(48 * 1024 + 1)
        );
        assert!(
            validate(vec![block(
                serde_json::json!({"type":"image", "data":"!", "mimeType":"image/png"})
            )])
            .is_err()
        );
        let link = block(
            serde_json::json!({"type":"resource_link", "uri":"file:///missing", "name":"file"}),
        );
        assert_eq!(validate(vec![link; 9]).unwrap().1.len(), 9);
        assert!(validate(vec![block(serde_json::json!({"type":"resource_link", "uri":"file:///tmp/a?query", "name":"file"}))]).is_err());
    }
}
