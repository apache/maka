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

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Completed opaque subscription state; wire validation happens at the adapter boundary.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub struct NativeCompaction(std::sync::Arc<Value>);
impl NativeCompaction {
    pub fn new(item: Value) -> Result<Self, &'static str> {
        if item["type"] != "compaction"
            || item["encrypted_content"].as_str().is_none_or(str::is_empty)
        {
            return Err("invalid native Codex compaction item");
        }
        Ok(Self(std::sync::Arc::new(item)))
    }
    pub fn item(&self) -> &Value {
        &self.0
    }
    pub fn digest(&self) -> String {
        use sha2::{Digest, Sha256};
        struct DigestWriter(Sha256);
        impl std::io::Write for DigestWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.update(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut digest = DigestWriter(Sha256::new());
        serde_json::to_writer(&mut digest, &self.0).expect("native item serializes to JSON");
        format!("sha256:{}", hex::encode(digest.0.finalize()))
    }
}
impl<'de> Deserialize<'de> for NativeCompaction {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(Value::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}
