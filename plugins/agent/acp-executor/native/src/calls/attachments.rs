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

use maka_agent_api::executor::AttachmentMetadata;
use maka_capabilities::call::{ReadResource, ResourceEncoding};
use maka_external_agent::ports::PromptAttachment;
use std::{ops::Range, sync::Arc};

pub(super) fn read(
    resource: Option<Arc<dyn ReadResource>>,
) -> Result<Vec<PromptAttachment>, String> {
    let Some(resource) = resource else {
        return Ok(Vec::new());
    };
    if resource.resource_type() != maka_plugin_core::contract::binary_resource_type()
        || resource.encoding() != ResourceEncoding::Bytes
    {
        return Err("ACP attachment descriptor is invalid".into());
    }
    let manifest: Vec<AttachmentMetadata> = serde_json::from_value(resource.metadata())
        .map_err(|_| "ACP attachment metadata is invalid")?;
    let mut end = 0usize;
    let mut attachments = Vec::with_capacity(manifest.len());
    for metadata in manifest {
        let start = end;
        let length =
            usize::try_from(metadata.bytes).map_err(|_| "ACP attachment length is invalid")?;
        end = end
            .checked_add(length)
            .filter(|end| *end <= resource.bytes())
            .ok_or("ACP attachment descriptor is invalid")?;
        attachments.push(PromptAttachment {
            name: metadata.name.clone(),
            mime_type: metadata.mime_type.clone(),
            resource: Arc::new(Attachment {
                parent: resource.clone(),
                start,
                length,
                metadata,
            }),
        });
    }
    if end != resource.bytes() {
        return Err("ACP attachment descriptor is invalid".into());
    }
    Ok(attachments)
}

// The immutable bytes stay shared. Permits remain under the original request
// Context/Scope custody, which the ACP driver retains through cleanup.
struct Attachment {
    parent: Arc<dyn ReadResource>,
    start: usize,
    length: usize,
    metadata: AttachmentMetadata,
}
impl ReadResource for Attachment {
    fn resource_type(&self) -> maka_plugin_core::contract::ResourceType {
        self.parent.resource_type()
    }
    fn bytes(&self) -> usize {
        self.length
    }
    fn metadata(&self) -> serde_json::Value {
        serde_json::json!(self.metadata)
    }
    fn read(&self, range: Range<usize>) -> Result<Vec<u8>, String> {
        if range.start > range.end || range.end > self.length {
            return Err("ACP attachment range is invalid".into());
        }
        if range.is_empty() {
            return Ok(Vec::new());
        }
        let start = self
            .start
            .checked_add(range.start)
            .ok_or("ACP attachment range is invalid")?;
        let end = self
            .start
            .checked_add(range.end)
            .ok_or("ACP attachment range is invalid")?;
        self.parent.read(start..end)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    struct Resource {
        bytes: Vec<u8>,
        metadata: Value,
    }
    impl ReadResource for Resource {
        fn resource_type(&self) -> maka_plugin_core::contract::ResourceType {
            maka_plugin_core::contract::binary_resource_type()
        }
        fn bytes(&self) -> usize {
            self.bytes.len()
        }
        fn metadata(&self) -> Value {
            self.metadata.clone()
        }
        fn read(&self, range: Range<usize>) -> Result<Vec<u8>, String> {
            self.bytes
                .get(range)
                .map(<[u8]>::to_vec)
                .ok_or("invalid original range".into())
        }
    }
    fn item(name: &str, bytes: u64) -> Value {
        json!({"name":name,"mimeType":"text/plain","bytes":bytes,"digest":"original digest"})
    }

    #[test]
    fn attachment_views_preserve_order_empty_files_and_original_byte_ranges() {
        let resource: Arc<dyn ReadResource> = Arc::new(Resource {
            bytes: b"firstSECOND".to_vec(),
            metadata: json!([
                item("empty-before", 0),
                item("first", 5),
                item("empty-between", 0),
                item("second", 6),
                item("empty-after", 0)
            ]),
        });
        let attachments = read(Some(resource.clone())).unwrap();
        drop(resource);
        assert_eq!(
            attachments
                .iter()
                .map(|a| a.name.as_str())
                .collect::<Vec<_>>(),
            [
                "empty-before",
                "first",
                "empty-between",
                "second",
                "empty-after"
            ]
        );
        for index in [0, 2, 4] {
            assert_eq!(attachments[index].resource.bytes(), 0);
            assert_eq!(attachments[index].resource.read(0..0).unwrap(), b"");
            assert!(attachments[index].resource.read(0..1).is_err());
        }
        assert_eq!(attachments[1].resource.read(0..5).unwrap(), b"first");
        assert_eq!(attachments[3].resource.read(0..6).unwrap(), b"SECOND");
        assert_eq!(attachments[3].resource.read(1..4).unwrap(), b"ECO");
        assert!(attachments[1].resource.read(0..6).is_err());
        assert!(attachments[3].resource.read(6..7).is_err());
        assert!(
            attachments[3]
                .resource
                .read(Range { start: 4, end: 3 })
                .is_err()
        );
        assert_eq!(attachments[1].resource.metadata(), item("first", 5));
    }

    #[test]
    fn attachment_manifest_must_cover_exact_original_payload() {
        for manifest in [
            json!([item("short", 2)]),
            json!([item("long", 4)]),
            json!([item("overflow", u64::MAX), item("more", 1)]),
            json!({"bytes":3}),
        ] {
            let resource = Arc::new(Resource {
                bytes: b"abc".to_vec(),
                metadata: manifest,
            });
            assert!(read(Some(resource)).is_err());
        }
        assert!(read(None).unwrap().is_empty());
        let empty = Arc::new(Resource {
            bytes: Vec::new(),
            metadata: json!([item("named empty", 0)]),
        });
        let attachments = read(Some(empty)).unwrap();
        assert_eq!(attachments[0].name, "named empty");
        assert_eq!(attachments[0].resource.read(0..0).unwrap(), b"");
    }
}
