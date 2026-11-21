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

use super::{ArchiveIdentity, hash, identity_string, valid_projection_digest};
const SHORT_PREFIX: &str = "archive:";
const EVENT_PREFIX: &str = "maka://runtime/tool-results/";

/// A Session-scoped locator. The store resolves and verifies its evidence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolResultAddress(String);

impl ToolResultAddress {
    pub fn parse(path: &str) -> Result<Self, &'static str> {
        if path.starts_with(SHORT_PREFIX) {
            return ArchiveIdentity::parse_short_ref(path).map(Self);
        }
        let encoded = path
            .strip_prefix(EVENT_PREFIX)
            .ok_or("invalid tool result address")?;
        let id = String::from_utf8(decode(encoded)?).map_err(|_| "invalid tool result event ID")?;
        if !identity_string(&id) || encode(&id) != encoded {
            return Err("invalid or noncanonical tool result event ID");
        }
        Ok(Self(id))
    }

    pub fn event_id(&self) -> &str {
        &self.0
    }

    pub fn event_path(id: &str) -> Result<String, &'static str> {
        if !identity_string(id) {
            return Err("invalid tool result event ID");
        }
        Ok(format!("{EVENT_PREFIX}{}", encode(id)))
    }

    pub(crate) fn short_event_ref(id: &str) -> Result<String, &'static str> {
        if !identity_string(id) {
            return Err("invalid archive event ID");
        }
        Ok(format!("{SHORT_PREFIX}{}", encode(id)))
    }
}

impl ArchiveIdentity {
    /// A locator only. Session access and full evidence are resolved by the store.
    pub fn short_ref(&self) -> Result<String, &'static str> {
        self.validate()?;
        Ok(format!("{SHORT_PREFIX}{}", encode(&self.runtime_event_id)))
    }

    pub fn parse_short_ref(resource: &str) -> Result<String, &'static str> {
        let encoded = resource
            .strip_prefix(SHORT_PREFIX)
            .ok_or("unsupported archive reference")?;
        let id = String::from_utf8(decode(encoded)?).map_err(|_| "invalid archive event ID")?;
        if !identity_string(&id) || encode(&id) != encoded {
            return Err("invalid or noncanonical archive event ID");
        }
        Ok(id)
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if ![&self.runtime_event_id, &self.tool_call_id, &self.tool_name]
            .into_iter()
            .all(|value| identity_string(value))
            || !valid_projection_digest(&self.source_projection_digest)
            || !hash(&self.body_sha256)
            || !(1..=9_007_199_254_740_991).contains(&self.original_bytes)
        {
            return Err("invalid ledger archive identity");
        }
        Ok(())
    }
}

fn encode(value: &str) -> String {
    let mut result = String::new();
    // ECMAScript encodeURIComponent, deliberately not form-urlencoded.
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            result.push(byte as char);
        } else {
            use std::fmt::Write;
            write!(&mut result, "%{byte:02X}").expect("String write");
        }
    }
    result
}
fn decode(encoded: &str) -> Result<Vec<u8>, &'static str> {
    let mut bytes = Vec::with_capacity(encoded.len());
    let mut input = encoded.bytes();
    while let Some(byte) = input.next() {
        bytes.push(if byte == b'%' {
            let high = input
                .next()
                .and_then(hex)
                .ok_or("invalid percent encoding")?;
            let low = input
                .next()
                .and_then(hex)
                .ok_or("invalid percent encoding")?;
            high * 16 + low
        } else {
            byte
        });
    }
    Ok(bytes)
}
fn hex(byte: u8) -> Option<u8> {
    (byte as char).to_digit(16).map(|value| value as u8)
}
