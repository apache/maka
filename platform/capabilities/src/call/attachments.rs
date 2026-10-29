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

//! Actual immutable request payloads, never JSON bearer handles.

use maka_plugin_core::contract::ResourceType;
use serde_json::Value;
use std::{collections::BTreeMap, ops::Range, sync::Arc};

/// Byte interpretation preserved by immutable transport snapshots.
#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    PartialEq,
    Eq,
    serde::Serialize,
    serde::Deserialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum ResourceEncoding {
    #[default]
    Bytes,
    Utf8,
}

/// Trusted immutable payload. Its owner must not retain a native UI entity,
/// live input, mount lease or a writable buffer. Descriptors remain immutable.
/// Reads use in-bounds byte ranges; text implementations check UTF-8 boundaries.
/// Transport adapters apply their own framing limits.
pub trait ReadResource: Send + Sync + 'static {
    fn encoding(&self) -> ResourceEncoding {
        ResourceEncoding::Bytes
    }
    fn resource_type(&self) -> ResourceType;
    fn bytes(&self) -> usize;
    fn metadata(&self) -> Value;
    fn read(&self, range: Range<usize>) -> std::result::Result<Vec<u8>, String>;
}
/// Actual request-local payloads. Slot names and metadata cannot construct them;
/// the execution adapter owns capacity and retains these values through cleanup.
pub type Attachments = BTreeMap<String, Arc<dyn ReadResource>>;

// Append to existing capabilities/src/call/attachments.rs; re-export
// immutable_bytes from capabilities/src/call.rs. No authority/native custody.
struct FrozenBytes {
    name: String,
    bytes: Arc<[u8]>,
    digest: String,
}
/// Freeze actual owned bytes for existing immutable resource transport.
pub fn immutable_bytes(name: String, bytes: Vec<u8>) -> Arc<dyn ReadResource> {
    use sha2::{Digest, Sha256};
    let digest = format!("sha256:{}", hex::encode(Sha256::digest(&bytes)));
    Arc::new(FrozenBytes {
        name,
        bytes: bytes.into(),
        digest,
    })
}
impl ReadResource for FrozenBytes {
    fn resource_type(&self) -> ResourceType {
        maka_plugin_core::contract::binary_resource_type()
    }
    fn bytes(&self) -> usize {
        self.bytes.len()
    }
    fn metadata(&self) -> Value {
        serde_json::json!({"name":self.name,"bytes":self.bytes.len(),"digest":self.digest})
    }
    fn read(&self, range: Range<usize>) -> Result<Vec<u8>, String> {
        if range
            .end
            .checked_sub(range.start)
            .is_none_or(|count| count > 64 * 1024)
        {
            return Err("invalid immutable resource range or exceeds 64 KiB".into());
        }
        self.bytes
            .get(range)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| "invalid immutable resource range".into())
    }
}
