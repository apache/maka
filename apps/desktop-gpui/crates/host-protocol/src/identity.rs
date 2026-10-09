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

//! Identity values validated on the client side before they reach the wire.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

/// The stable identity a client presents in its `hello`.
///
/// Source: `requireClientInstanceId` in `protocol/index.ts` accepts any
/// 1–128 character string (`requireId`). This client is stricter and also
/// requires `^[A-Za-z0-9_-]{1,128}$`, the entity-id alphabet
/// (`requireEntityId` in `protocol/codec.ts`), so a generated id is valid
/// under either rule. A hyphenated UUID, which the TS client sends, passes.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct ClientInstanceId(String);

/// A candidate client instance id that is empty, too long, or uses a
/// character outside `[A-Za-z0-9_-]`.
#[derive(Debug, Error)]
#[error("client instance id must match ^[A-Za-z0-9_-]{{1,128}}$")]
pub struct InvalidClientInstanceId;

impl ClientInstanceId {
    /// Validates `value` as a client instance id.
    pub fn new(value: impl Into<String>) -> Result<Self, InvalidClientInstanceId> {
        let value = value.into();
        let valid = (1..=128).contains(&value.len())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
        if valid { Ok(Self(value)) } else { Err(InvalidClientInstanceId) }
    }

    /// The id as sent on the wire.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ClientInstanceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ClientInstanceId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

/// Whether `value` is a State Root id: 64 lowercase hex characters
/// (`requireHostRootId` in `protocol/index.ts`, `isRootMarker` in
/// `packages/storage/src/root-authority.ts`).
pub fn is_root_id(value: &str) -> bool {
    value.len() == 64
        && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_hyphenated_uuid() {
        let id = ClientInstanceId::new("0a4adfd1-a36c-47f0-8ba0-2012902025f8").expect("valid");
        assert_eq!(id.as_str(), "0a4adfd1-a36c-47f0-8ba0-2012902025f8");
    }

    #[test]
    fn rejects_empty_long_and_foreign_characters() {
        assert!(ClientInstanceId::new("").is_err());
        assert!(ClientInstanceId::new("a".repeat(129)).is_err());
        assert!(ClientInstanceId::new("a".repeat(128)).is_ok());
        assert!(ClientInstanceId::new("has space").is_err());
        assert!(ClientInstanceId::new("dotted.id").is_err());
    }

    #[test]
    fn root_id_requires_lowercase_hex() {
        let id = "67d440f2c07d4cf4e9f56a52aa2bf8e435c71602ddda6244987e201de0c4fb8d";
        assert!(is_root_id(id));
        assert!(!is_root_id(&id.to_uppercase()));
        assert!(!is_root_id(&id[1..]));
    }
}
