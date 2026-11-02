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

//! A selected image subscription produces owned bytes, never a path or bearer.
use crate::contract::ImageFrame;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use maka_agent_facts::tool_output::ToolSuccess;
use maka_agent_facts::tools::ToolError;
use maka_capabilities::call::Attachments;
use maka_host_runtime::application::{Context, ServiceTarget};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use maka_agent_api::IMAGE_CHUNK_BYTES as CHUNK_BYTES;

pub(super) async fn read(
    request: &Context,
    target: &ServiceTarget,
    method: String,
    input: Value,
    cancellation: &CancellationToken,
) -> Result<ToolSuccess, ToolError> {
    let mut subscription = request
        .subscribe_target(target, method, input, Attachments::default())
        .map_err(failed)?
        .await
        .map_err(failed)?;
    let mut image = Image::default();
    loop {
        let value = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(failed("Image tool cancelled")),
            value = subscription.recv() => value,
        };
        let Some(value) = value else {
            break;
        };
        image.push(value)?;
    }
    let completion = subscription.completion().await;
    completion.cleanup.map_err(ToolError::CleanupUnconfirmed)?;
    let value = completion.result.map_err(failed)?;
    if !matches!(
        serde_json::from_value::<ImageFrame>(value),
        Ok(ImageFrame::Complete)
    ) {
        return Err(failed("Image producer did not complete"));
    }
    image.finish()
}

#[derive(Default)]
struct Image {
    descriptor: Option<(String, usize)>,
    bytes: Vec<u8>,
}
impl Image {
    fn push(&mut self, value: Value) -> Result<(), ToolError> {
        let ImageFrame::Chunk {
            mime_type,
            total_bytes,
            offset,
            data,
        } = serde_json::from_value(value).map_err(|_| failed("Invalid image chunk"))?
        else {
            return Err(failed("Image completion cannot be emitted as a chunk"));
        };
        if total_bytes == 0
            || offset != self.bytes.len()
            || offset >= total_bytes
            || data.is_empty()
            || data.len() > 43692
        {
            return Err(failed("Image chunk exceeds bounds or is out of order"));
        }
        let chunk = STANDARD
            .decode(data)
            .map_err(|_| failed("Invalid image Base64"))?;
        if chunk.len() != CHUNK_BYTES.min(total_bytes - offset) {
            return Err(failed("Image chunk exceeds its declared bounds"));
        }
        match &self.descriptor {
            Some((mime, total)) if mime != &mime_type || *total != total_bytes => {
                return Err(failed("Image descriptor changed during transfer"));
            }
            Some(_) => {}
            None => {
                if !matches!(
                    mime_type.as_str(),
                    "image/png" | "image/jpeg" | "image/gif" | "image/webp"
                ) {
                    return Err(failed("Unsupported image MIME"));
                }
                self.descriptor = Some((mime_type, total_bytes));
            }
        }
        self.bytes.try_reserve(chunk.len()).map_err(failed)?;
        self.bytes.extend_from_slice(&chunk);
        Ok(())
    }
    fn finish(self) -> Result<ToolSuccess, ToolError> {
        let Some((mime, total)) = self.descriptor else {
            return Err(failed("Image producer returned no image"));
        };
        if self.bytes.len() != total {
            return Err(failed("Image transfer ended before all bytes arrived"));
        }
        if maka_fs_tools::image::validate(&self.bytes)? != mime {
            return Err(failed("Image MIME does not match its content"));
        }
        ToolSuccess::image(self.bytes, mime).map_err(failed)
    }
}
fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}
