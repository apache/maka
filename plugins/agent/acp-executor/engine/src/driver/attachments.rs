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

use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

impl Driver<'_> {
    pub(super) fn prompt_content<T: DeserializeOwned>(
        &self,
        connection: &Connection,
    ) -> Result<Vec<T>, Error> {
        let prepared: Result<Vec<T>, Error> = (|| {
            let (image, embedded) = match connection.peer.as_ref() {
                Some(Peer::V1(_, peer)) => (
                    peer.agent_capabilities.prompt_capabilities.image,
                    peer.agent_capabilities.prompt_capabilities.embedded_context,
                ),
                Some(Peer::V2(_, peer)) => peer
                    .capabilities
                    .session
                    .as_ref()
                    .and_then(|session| session.prompt.as_ref())
                    .map_or((false, false), |caps| {
                        (caps.image.is_some(), caps.embedded_context.is_some())
                    }),
                None => return Err(Error::Invalid("ACP peer has not initialized")),
            };
            let attachments = if let Some(scope) = &self.context.call {
                self.host
                    .callbacks
                    .prompt_attachments(scope)
                    .map_err(|error| Error::Output(executor::Error::Provider(error)))?
            } else {
                vec![]
            };
            let text = prompt(
                &self.request.content,
                self.request.instructions.as_deref(),
                self.request.language,
            )?;
            let content = blocks(
                text,
                attachments,
                image,
                embedded,
                self.request.language,
                &self.context.cancellation,
            )?;
            content
                .into_iter()
                .map(|block| serde_json::from_value(block).map_err(Error::from))
                .collect()
        })();
        prepared.map_err(|error| match error {
            error @ (Error::Invalid(_) | Error::Decode(_)) => {
                Error::RejectedBeforePrompt(Box::new(error))
            }
            error => error,
        })
    }
}
fn blocks(
    text: Vec<String>,
    attachments: Vec<crate::ports::PromptAttachment>,
    image: bool,
    embedded: bool,
    language: maka_agent_facts::language::Language,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<Vec<Value>, Error> {
    let mut blocks: Vec<_> = text
        .into_iter()
        .map(|text| json!({"type":"text","text":text}))
        .collect();
    for (index, attachment) in attachments.into_iter().enumerate() {
        if attachment.name.is_empty()
            || attachment.name.chars().any(char::is_control)
            || attachment.mime_type.is_empty()
            || attachment.mime_type.chars().any(char::is_control)
        {
            return Err(Error::Invalid("ACP attachment metadata is invalid"));
        }
        let is_image = attachment.mime_type.starts_with("image/");
        if is_image && !image {
            return Err(Error::Invalid(
                "ACP peer does not support image attachments",
            ));
        }
        let resource = attachment.resource;
        let mut bytes = Vec::with_capacity(resource.bytes());
        for start in (0..resource.bytes()).step_by(64 * 1024) {
            if cancellation.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let end = (start + 64 * 1024).min(resource.bytes());
            let chunk = resource
                .read(start..end)
                .map_err(|error| Error::Output(executor::Error::Provider(error)))?;
            if chunk.len() != end - start {
                return Err(Error::Invalid("ACP attachment read is incomplete"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let uri = format!("maka-attachment:{index}");
        let block = if is_image {
            json!({"type":"image","data":STANDARD.encode(&bytes),"mimeType":attachment.mime_type,"uri":uri})
        } else if let Some(text) = std::str::from_utf8(&bytes).ok().filter(|text| {
            !text.contains('\0')
                && (attachment.mime_type.starts_with("text/")
                    || attachment.mime_type == "application/json")
        }) {
            if embedded {
                json!({"type":"resource","resource":{"uri":uri,"mimeType":attachment.mime_type,"text":text}})
            } else {
                json!({"type":"text","text":text})
            }
        } else if embedded {
            json!({"type":"resource","resource":{"uri":uri,"mimeType":attachment.mime_type,"blob":STANDARD.encode(&bytes)}})
        } else {
            return Err(Error::Invalid(
                "ACP peer does not support binary attachments",
            ));
        };
        // Keep the filename as a separate ordinary text block for all protocol versions.
        let label = match language {
            maka_agent_facts::language::Language::En => "Attachment: ",
            maka_agent_facts::language::Language::ZhCn => "附件：",
            maka_agent_facts::language::Language::ZhTw => "附件：",
        };
        let name = json!({"type":"text","text":format!("{label}{}", attachment.name)});
        blocks.push(name);
        blocks.push(block);
    }
    if cancellation.is_cancelled() {
        return Err(Error::Cancelled);
    }
    Ok(blocks)
}
