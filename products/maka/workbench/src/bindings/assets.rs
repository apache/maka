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

use super::{Owner, execute};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use maka_agent_api::contract::{AttachmentImageRead, AttachmentImageSource, ToolImageRead};
use maka_agent_facts::artifact::content_digest;
use nsh_engine::Assets;
use serde_json::json;
use std::sync::Arc;

pub(super) struct HostAssets(pub(super) Arc<Owner>);

impl Assets for HostAssets {
    fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
        if let Some(encoded) = uri.strip_prefix("asset:/plugin/") {
            return super::plugins::asset(&self.0, encoded);
        }
        if let Some(encoded) = uri.strip_prefix(super::files::PREFIX) {
            let source: maka_agent_api::contract::FileRead = serde_json::from_slice(
                &URL_SAFE_NO_PAD
                    .decode(encoded)
                    .map_err(|_| "Invalid current file selector")?,
            )
            .map_err(|_| "Invalid current file selector")?;
            source
                .path
                .validate()
                .map_err(|_| "Invalid current file path")?;
            if source.session_id.is_empty() || source.expected_version.is_none() {
                return Err("Invalid current file selector".into());
            }
            let owner = self.0.clone();
            return self.0.runtime.block_on(execute(owner.clone(), async move {
                match super::files::read(&owner, &source).await? {
                    super::files::Outcome::Ready(capture)
                        if matches!(
                            capture.content,
                            maka_agent_api::contract::FileContent::Image { .. }
                        ) =>
                    {
                        Ok(capture.bytes)
                    }
                    _ => Err(
                        "The current image changed or is unavailable; refresh the file preview"
                            .into(),
                    ),
                }
            }));
        }
        let source = if let Some(encoded) = uri.strip_prefix("asset:/tool-image/") {
            let source: ToolImageRead = serde_json::from_slice(
                &URL_SAFE_NO_PAD
                    .decode(encoded)
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            source.position.validate().map_err(str::to_owned)?;
            if source.offset != 0
                || source.through > 9_007_199_254_740_991
                || source.position.source_sequence > source.through
            {
                return Err("Invalid tool image source".into());
            }
            ImageSource::Tool(source)
        } else if let Some(encoded) = uri.strip_prefix("asset:/attachment-image/") {
            let source: AttachmentImageRead = serde_json::from_slice(
                &URL_SAFE_NO_PAD
                    .decode(encoded)
                    .map_err(|_| "Invalid attachment image source")?,
            )
            .map_err(|_| "Invalid attachment image source")?;
            match &source.source {
                AttachmentImageSource::Uploaded { id } if id.is_empty() => {
                    return Err("Invalid uploaded image source".into());
                }
                AttachmentImageSource::History {
                    through, position, ..
                } => {
                    position.validate().map_err(str::to_owned)?;
                    if *through > 9_007_199_254_740_991 || position.source_sequence > *through {
                        return Err("Invalid attachment history source".into());
                    }
                }
                _ => {}
            }
            if source.offset != 0 {
                return Err("Invalid attachment image offset".into());
            }
            ImageSource::Attachment(source)
        } else {
            return Err(format!("Unknown application asset: {uri}"));
        };
        if source.session().is_empty() {
            return Err("Invalid image session".into());
        }
        let owner = self.0.clone();
        // Image assets are read on NSH's image workers. Track the whole read
        // with the launcher's other IO.
        let (bytes, digest) = self.0.runtime.block_on(execute(owner.clone(), async move {
            read_image(&owner, source).await
        }))?;
        // Hash a large image on its reader, without occupying a Host IO worker.
        if content_digest(&bytes) != digest {
            return Err("The original image digest does not match".into());
        }
        Ok(bytes)
    }
}

async fn read_image(owner: &Owner, source: ImageSource) -> Result<(Vec<u8>, String), String> {
    // Image bytes remain on the original native reader, outside the JS heap.
    let (method, mut input, expected) = source.request();
    let mut bytes = Vec::new();
    let mut metadata: Option<(u64, String, String)> = None;
    loop {
        let offset = bytes.len() as u64;
        input["offset"] = offset.into();
        let page = owner.client.query("agent", method, input.clone()).await?;
        let total = page["totalBytes"]
            .as_u64()
            .filter(|total| *total > 0)
            .ok_or("Invalid original image length")?;
        let mime = page["mimeType"].as_str().ok_or("Missing image MIME type")?;
        let digest = page["digest"].as_str().ok_or("Missing image digest")?;
        let data = page["data"].as_str().ok_or("Missing image bytes")?;
        if page["kind"] != "ready"
            || expected
                .as_object()
                .unwrap()
                .iter()
                .any(|(key, value)| page.get(key) != Some(value))
            || page["offset"].as_u64() != Some(offset)
            || offset >= total
            || data.len() > 43692
            || !matches!(
                mime,
                "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif"
            )
            || !digest.strip_prefix("sha256:").is_some_and(|hash| {
                hash.len() == 64
                    && hash
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
            || metadata.as_ref().is_some_and(|(length, kind, hash)| {
                *length != total || kind != mime || hash != digest
            })
        {
            return Err("The original image could not be verified".into());
        }
        if mime == "image/avif" {
            return Err("AVIF previews are not supported by this terminal renderer".into());
        }
        if metadata.is_none() {
            bytes
                .try_reserve_exact(
                    usize::try_from(total)
                        .map_err(|_| "Tool image length cannot be represented")?,
                )
                .map_err(|error| error.to_string())?;
            metadata = Some((total, mime.to_owned(), digest.to_owned()));
        }
        // Each page has its own padding: concatenating Base64 would corrupt
        // every image that crosses the Host's 32 KiB page boundary.
        let chunk = STANDARD.decode(data).map_err(|error| error.to_string())?;
        if chunk.len() as u64 != (total - offset).min(32 * 1024) {
            return Err("The original image page has an invalid length".into());
        }
        bytes.extend_from_slice(&chunk);
        if bytes.len() as u64 == total {
            return Ok((bytes, digest.to_owned()));
        }
    }
}

// Both selectors remain authorized by the same original Host; only their
// canonical page identity differs. Encoded bytes never enter the JS heap.
enum ImageSource {
    Tool(ToolImageRead),
    Attachment(AttachmentImageRead),
}
impl ImageSource {
    fn session(&self) -> &str {
        match self {
            Self::Tool(source) => &source.session_id,
            Self::Attachment(source) => &source.session_id,
        }
    }
    fn request(self) -> (&'static str, serde_json::Value, serde_json::Value) {
        match self {
            Self::Tool(source) => (
                "toolImage",
                json!({"sessionId":source.session_id,"through":source.through,"position":source.position,"offset":0}),
                json!({"through":source.through,"position":source.position}),
            ),
            Self::Attachment(source) => (
                "attachmentImage",
                json!({"sessionId":source.session_id,"source":source.source,"offset":0}),
                json!({"source":source.source}),
            ),
        }
    }
}
