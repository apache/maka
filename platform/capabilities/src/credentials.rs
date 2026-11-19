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

use futures_util::future::BoxFuture;
use maka_plugin_core::storage::StoreError;
use serde::{Deserialize, Serialize};

/// Tombstones retain their revision, so deletion cannot revive a stale writer.
/// Deliberately has no Debug implementation: the value is secret material.
#[derive(Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub revision: u64,
    pub secret: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Write {
    pub key: String,
    pub expected_revision: Option<u64>,
    /// None deletes the value, not its revision.
    pub secret: Option<String>,
}
impl Write {
    pub fn validate(&self) -> Result<(), crate::Error> {
        maka_plugin_core::storage::validate_key(&self.key)?;
        if self
            .expected_revision
            .is_some_and(|value| value == 0 || value >= (1 << 53) - 1)
        {
            return Err(crate::Error::Invalid("invalid credential revision".into()));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WriteResult {
    Written { revision: u64 },
    Conflict { actual: Option<u64> },
}
/// The Host fixes package/scope identity. No API accepts a different namespace.
pub trait Credentials: Send + Sync {
    fn read(&self, key: String) -> BoxFuture<'_, Result<Option<Record>, StoreError>>;
    fn write(&self, input: Write) -> BoxFuture<'_, Result<WriteResult, StoreError>>;
}
