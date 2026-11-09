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
use maka_agent_facts::{
    artifact::{ArtifactKind, ArtifactSource},
    read::{ReadPage, ReadRequest, Utf8Page},
};
use maka_agent_state::artifacts::{ArtifactStore, SessionScope};
use std::io::Read;

pub async fn read(
    store: &ArtifactStore,
    scope: SessionScope,
    id: String,
    request: ReadRequest,
    image: bool,
    cancellation: &CancellationToken,
) -> Result<Output, ToolError> {
    let stop = cancellation.clone();
    let result = store
        .with_content(scope, id, move |record, reader| {
            cancelled(&stop)?;
            if record.source != ArtifactSource::UserUpload {
                return Err(failed("Attachment was not found in this Session"));
            }
            if record.kind == ArtifactKind::Pdf {
                return Err(failed("PDF attachments cannot be decoded by Read"));
            }
            if image != (record.kind == ArtifactKind::Image) {
                return Err(failed(
                    "Use readImage for images and readText for UTF-8 text attachments",
                ));
            }
            if image {
                let mime_type = record
                    .mime_type
                    .as_deref()
                    .ok_or_else(|| failed("Attachment has no media type"))?;
                if !matches!(
                    mime_type,
                    "image/png" | "image/jpeg" | "image/gif" | "image/webp"
                ) {
                    return Err(failed("Read supports PNG, JPEG, GIF and WebP images"));
                }
                let mut bytes = Vec::new();
                let mut buffer = [0; 32 * 1024];
                loop {
                    cancelled(&stop)?;
                    let count = reader.read(&mut buffer).map_err(failed)?;
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                }
                if bytes.len() as u64 != record.size_bytes {
                    return Err(failed("Attachment content changed"));
                }
                Ok(Output::Image {
                    bytes,
                    mime_type: mime_type.to_owned(),
                })
            } else {
                let page = text_page(reader, &request, &stop)?;
                serde_json::to_value(page).map(Output::Json).map_err(failed)
            }
        })
        .await
        .map_err(failed)?
        .ok_or_else(|| failed("Attachment was not found in this Session"))??;
    cancelled(cancellation)?;
    Ok(result)
}

pub(super) fn text_page(
    reader: &mut dyn Read,
    request: &ReadRequest,
    stop: &CancellationToken,
) -> Result<ReadPage, ToolError> {
    let mut page = Utf8Page::new(request, read_page_budget());
    let mut buffer = [0; 32 * 1024];
    loop {
        cancelled(stop)?;
        let count = reader.read(&mut buffer).map_err(failed)?;
        if count == 0 {
            return page.finish().map_err(failed);
        }
        page.push(&buffer[..count]).map_err(failed)?;
    }
}
