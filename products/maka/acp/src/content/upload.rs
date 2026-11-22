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

use super::{Client, Prepared, active, artifact};
use maka_agent_api::contract::AttachmentUploadResult;
use maka_capabilities::call::Attachments;
use maka_capabilities::call::ReadResource;
use maka_plugin_core::contract::{ResourceType, binary_resource_type};
use serde_json::{Value, json};
use std::{ops::Range, sync::Arc};
use tokio_util::sync::CancellationToken;
struct Payload(Vec<u8>);
impl ReadResource for Payload {
    fn resource_type(&self) -> ResourceType {
        binary_resource_type()
    }
    fn bytes(&self) -> usize {
        self.0.len()
    }
    fn metadata(&self) -> Value {
        json!({})
    }
    fn read(&self, range: Range<usize>) -> Result<Vec<u8>, String> {
        self.0
            .get(range)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| "Attachment read exceeds immutable payload".into())
    }
}
pub(super) async fn publish(
    client: &Client,
    session: &str,
    item: Prepared,
    cancel: &CancellationToken,
) -> Result<String, crate::Error> {
    active(cancel)?;
    let input = json!({"sessionId":session,"name":item.name,"bytes":item.bytes.len(),"digest":artifact::content_digest(&item.bytes)});
    let resources: Attachments = [(
        "file".into(),
        Arc::new(Payload(item.bytes)) as Arc<dyn ReadResource>,
    )]
    .into();
    // Await the original confirmation even if ACP cancellation arrives during upload.
    match client
        .mutate("agent", "uploadAttachment", input, resources)
        .await?
    {
        AttachmentUploadResult::Uploaded { attachment } if attachment.session_id == session => {
            Ok(attachment.id)
        }
        _ => Err("Host rejected the attachment upload".into()),
    }
}
