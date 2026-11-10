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

use crate::scope::Scope;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Validation of the portable storage contract, independent of any I/O owner.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("invalid plugin storage data: {0}")]
    Invalid(String),
}

pub const MAX_PAGE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Namespace {
    package: String,
    scope: Scope,
}

impl Namespace {
    pub fn new(package: impl Into<String>, scope: Scope) -> Result<Self, Error> {
        let package = package.into();
        crate::identifier(&package).map_err(|e| Error::Invalid(e.to_string()))?;
        if let Scope::Session(id) = &scope {
            if id.is_empty() || id.chars().any(|c| c.is_control() || c.is_whitespace()) {
                return Err(Error::Invalid(format!("invalid identifier: {id:?}")));
            }
        }
        Ok(Self { package, scope })
    }
    pub fn package(&self) -> &str {
        &self.package
    }
    pub fn scope(&self) -> &Scope {
        &self.scope
    }
}

/// Deletions retain a revision, preventing stale writers from recreating a key
/// as if it had never existed. Revision is not a business schema version.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "StateRecord")]
pub struct Record {
    pub revision: u64,
    pub data: Data,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scan {
    #[serde(default)]
    pub prefix: String,
    pub after: Option<String>,
}
impl Scan {
    pub fn validate(&self) -> Result<(), Error> {
        if !self.prefix.is_empty() {
            validate_key(&self.prefix)?;
        }
        if let Some(after) = &self.after {
            validate_key(after)?;
            if !after.starts_with(&self.prefix) {
                return Err(Error::Invalid(
                    "storage cursor is outside its prefix".into(),
                ));
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub key: String,
    pub record: Record,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "StatePage")]
pub struct Page {
    pub entries: Vec<Entry>,
    pub next_after: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Data {
    Present(Value),
    Deleted,
}

impl Data {
    pub fn value(&self) -> Option<&Value> {
        match self {
            Self::Present(value) => Some(value),
            Self::Deleted => None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mutation {
    pub key: String,
    pub expected_revision: Option<u64>,
    pub data: Data,
}

impl Mutation {
    pub fn validate(&self) -> Result<(), Error> {
        validate_key(&self.key)?;
        if self
            .expected_revision
            .is_some_and(|revision| revision == 0 || revision >= (1 << 53) - 1)
        {
            return Err(Error::Invalid("invalid plugin data revision".into()));
        }
        Ok(())
    }
}

pub fn validate_key(key: &str) -> Result<(), Error> {
    if key.is_empty() || key.chars().any(char::is_control) {
        return Err(Error::Invalid("invalid plugin storage key".into()));
    }
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("plugin storage capability is retired")]
    Retired,
    #[error("plugin data revision conflict: expected {expected}, found {actual}")]
    Conflict { expected: String, actual: String },
    #[error("plugin data commit outcome is unknown: {0}")]
    OutcomeUnknown(String),
    #[error("plugin storage is unavailable: {0}")]
    Unavailable(String),
}

/// Namespace is bound by Host, not supplied by each plugin operation.
pub trait Store: Send + Sync {
    /// Ordered, bounded enumeration including tombstones. Each page is current,
    /// not a cross-page snapshot; domain consistency uses revisions and batches.
    fn scan(&self, query: Scan) -> futures_util::future::BoxFuture<'_, Result<Page, StoreError>>;
    fn read(
        &self,
        key: String,
    ) -> futures_util::future::BoxFuture<'_, Result<Option<Record>, StoreError>>;
    /// Atomic CAS of the complete selected mutation set.
    fn batch(
        &self,
        mutations: Vec<Mutation>,
    ) -> futures_util::future::BoxFuture<'_, Result<Vec<Record>, StoreError>>;
}
