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
use maka_agent_facts::artifact::ArtifactKind;
use maka_agent_facts::artifact::ArtifactSource;
use maka_agent_facts::read::ReadRequest;

pub async fn read(
    store: &maka_event_log::SessionStore,
    session: &str,
    id: &str,
    request: &ReadRequest,
    image: bool,
    cancellation: &CancellationToken,
) -> Result<Output, ToolError> {
    let record = store
        .get_artifact(session, id)
        .await
        .map_err(failed)?
        .record
        .filter(|record| {
            record.session_id == session && record.source == ArtifactSource::UserUpload
        })
        .ok_or_else(|| failed("Attachment was not found in this Session"))?;
    cancelled(cancellation)?;
    if record.kind == ArtifactKind::Pdf {
        return Err(failed("PDF attachments cannot be decoded by Read"));
    }
    if image != (record.kind == ArtifactKind::Image) {
        return Err(failed(
            "Use readImage for images and readText for UTF-8 text attachments",
        ));
    }
    let window = usize::try_from(record.size_bytes).map_err(failed)?.max(1);
    let chunk = store
        .read_artifact_chunk(session, id, 0, window)
        .await
        .map_err(failed)?
        .ok_or_else(|| failed("Attachment was not found in this Session"))?;
    cancelled(cancellation)?;
    if chunk.total_bytes != record.size_bytes || chunk.bytes.len() as u64 != record.size_bytes {
        return Err(failed("Attachment content changed"));
    }
    if image {
        let mime_type = record
            .mime_type
            .ok_or_else(|| failed("Attachment has no media type"))?;
        if !matches!(
            mime_type.as_str(),
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        ) {
            return Err(failed("Read supports PNG, JPEG, GIF and WebP images"));
        }
        Ok(Output::Image {
            bytes: chunk.bytes,
            mime_type,
        })
    } else {
        let text = String::from_utf8(chunk.bytes)
            .map_err(|_| failed("Read cannot decode this binary attachment as UTF-8 text"))?;
        if text.contains('\0') {
            return Err(failed("Read cannot decode this binary attachment as text"));
        }
        serde_json::to_value(
            request
                .page_with_budget(&text, read_page_budget())
                .map_err(failed)?,
        )
        .map(Output::Json)
        .map_err(failed)
    }
}
