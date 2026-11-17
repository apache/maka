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

use crate::{
    archive::ToolResultAddress, attachment::ATTACHMENT_RESOURCE_PREFIX, history::HistoryRowAddress,
    interaction::entity_id,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use maka_plugin_core::shell_result::RESOURCE_REF_PREFIX;

const IMPORTED_TOOL_RESULT_PREFIX: &str = "maka://history/tool-result/";
pub const SESSION_RESOURCE_PREFIX: &str = "maka://session/";
const SESSION_TOOL_RESULT_SEGMENT: &str = "/tool-results/";
const SESSION_IMPORTED_TOOL_RESULT_SEGMENT: &str = "/imported-tool-results/";
const SESSION_THROUGH_QUERY_PREFIX: &str = "through=";
const MAX_SAFE_THROUGH: u64 = (1 << 53) - 1;

fn encode_imported_address(address: &HistoryRowAddress) -> Result<String, &'static str> {
    if !matches!(address, HistoryRowAddress::Imported { .. }) {
        return Err("Tool-result history addresses must identify an imported part");
    }
    address.validate()?;
    let bytes = serde_json::to_vec(address).map_err(|_| "Invalid imported tool-result address")?;
    let encoded_len = base64::encoded_len(bytes.len(), false)
        .ok_or("Imported tool-result address length overflow")?;
    let mut out = String::with_capacity(encoded_len);
    URL_SAFE_NO_PAD.encode_string(bytes, &mut out);
    Ok(out)
}

fn decode_imported_address(encoded: &str) -> Result<HistoryRowAddress, &'static str> {
    let invalid = "Invalid imported tool-result address";
    if encoded.is_empty() {
        return Err(invalid);
    }
    let capacity = encoded
        .len()
        .checked_div(4)
        .and_then(|length| length.checked_mul(3))
        .and_then(|length| length.checked_add(3))
        .ok_or(invalid)?;
    let mut bytes = vec![0; capacity];
    let length = URL_SAFE_NO_PAD
        .decode_slice(encoded, &mut bytes)
        .map_err(|_| invalid)?;
    let address: HistoryRowAddress =
        serde_json::from_slice(&bytes[..length]).map_err(|_| invalid)?;
    if encode_imported_address(&address)? != encoded {
        return Err(invalid);
    }
    Ok(address)
}

/// Only an address within a caller's actual source tree, never read authority.
pub fn imported_tool_result_path(address: &HistoryRowAddress) -> Result<String, &'static str> {
    let encoded = encode_imported_address(address)?;
    Ok(format!("{IMPORTED_TOOL_RESULT_PREFIX}{encoded}"))
}

pub fn parse_imported_tool_result_path(
    path: &str,
) -> Result<Option<HistoryRowAddress>, &'static str> {
    let Some(encoded) = path.strip_prefix(IMPORTED_TOOL_RESULT_PREFIX) else {
        return Ok(None);
    };
    decode_imported_address(encoded).map(Some)
}

/// A Session resource locator; resolving it never grants access to its content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResourceAddress {
    Attachment(String),
    Task(String),
    ToolResult(String),
    Session {
        session_id: String,
        through: Option<u64>,
    },
    SessionToolResult {
        session_id: String,
        event_id: String,
    },
    SessionImportedToolResult {
        session_id: String,
        address: HistoryRowAddress,
    },
}

impl ResourceAddress {
    /// Ordinary filesystem paths have no resource address.
    pub fn parse(path: &str) -> Result<Option<Self>, &'static str> {
        if path.starts_with("archive:") || path.starts_with("maka://runtime/tool-results/") {
            return ToolResultAddress::parse(path)
                .map(|address| Some(Self::ToolResult(address.event_id().to_owned())));
        }
        if let Some(rest) = path.strip_prefix(SESSION_RESOURCE_PREFIX) {
            if let Some((session_id, event_id)) = rest.split_once(SESSION_TOOL_RESULT_SEGMENT) {
                let event_id = event_id.strip_suffix('/').unwrap_or(event_id);
                entity_id(session_id)?;
                entity_id(event_id)?;
                return Ok(Some(Self::SessionToolResult {
                    session_id: session_id.into(),
                    event_id: event_id.into(),
                }));
            }
            if let Some((session_id, encoded)) =
                rest.split_once(SESSION_IMPORTED_TOOL_RESULT_SEGMENT)
            {
                let encoded = encoded.strip_suffix('/').unwrap_or(encoded);
                entity_id(session_id)?;
                let address = decode_imported_address(encoded)?;
                return Ok(Some(Self::SessionImportedToolResult {
                    session_id: session_id.into(),
                    address,
                }));
            }
            if let Some((raw_id, query)) = rest.split_once('?') {
                let id = raw_id.strip_suffix('/').unwrap_or(raw_id);
                entity_id(id)?;
                let Some(raw_through) = query.strip_prefix(SESSION_THROUGH_QUERY_PREFIX) else {
                    return Err("Invalid Session resource query; only ?through=<u64> is supported");
                };
                if raw_through.is_empty() || !raw_through.bytes().all(|b| b.is_ascii_digit()) {
                    return Err("Invalid Session resource through watermark");
                }
                let through: u64 = raw_through
                    .parse()
                    .map_err(|_| "Invalid Session resource through watermark")?;
                if through > MAX_SAFE_THROUGH {
                    return Err("Invalid Session resource through watermark");
                }
                return Ok(Some(Self::Session {
                    session_id: id.into(),
                    through: Some(through),
                }));
            }
            let id = rest.strip_suffix('/').unwrap_or(rest);
            entity_id(id)?;
            return Ok(Some(Self::Session {
                session_id: id.into(),
                through: None,
            }));
        }
        if let Some(id) = path.strip_prefix("session:") {
            entity_id(id)?;
            return Ok(Some(Self::Session {
                session_id: id.into(),
                through: None,
            }));
        }
        for (short, full, attachment) in [
            ("attachment:", ATTACHMENT_RESOURCE_PREFIX, true),
            ("task:", RESOURCE_REF_PREFIX, false),
        ] {
            if let Some(id) = path.strip_prefix(short).or_else(|| path.strip_prefix(full)) {
                entity_id(id)?;
                return Ok(Some(if attachment {
                    Self::Attachment(id.into())
                } else {
                    Self::Task(id.into())
                }));
            }
        }
        if path.starts_with("http://") || path.starts_with("https://") {
            return Err("HTTP(S) URLs cannot be read with Read; use WebFetch instead");
        }
        if path.contains("://") {
            return Err(
                "Unsupported URI in Read; supported Maka resources are maka://session/<id> (or session:<id>), attachment:<id>, archive:<id>, and maka://read/... continuations",
            );
        }
        Ok(None)
    }

    pub fn id(&self) -> &str {
        match self {
            Self::Attachment(id) | Self::Task(id) | Self::ToolResult(id) => id,
            Self::Session { session_id, .. }
            | Self::SessionImportedToolResult { session_id, .. } => session_id,
            Self::SessionToolResult { event_id, .. } => event_id,
        }
    }

    pub fn with_id(mut self, resolved: String) -> Self {
        match &mut self {
            Self::Attachment(id) | Self::Task(id) | Self::ToolResult(id) => *id = resolved,
            Self::Session { session_id, .. }
            | Self::SessionImportedToolResult { session_id, .. } => *session_id = resolved,
            Self::SessionToolResult { event_id, .. } => *event_id = resolved,
        }
        self
    }

    pub fn canonical_path(&self) -> Result<String, &'static str> {
        match self {
            Self::Attachment(id) => {
                entity_id(id)?;
                Ok(format!("{ATTACHMENT_RESOURCE_PREFIX}{id}"))
            }
            Self::Task(id) => {
                entity_id(id)?;
                Ok(format!("{RESOURCE_REF_PREFIX}{id}"))
            }
            Self::ToolResult(id) => ToolResultAddress::event_path(id),
            Self::Session {
                session_id,
                through,
            } => {
                entity_id(session_id)?;
                match through {
                    Some(t) if *t <= MAX_SAFE_THROUGH => {
                        Ok(format!("{SESSION_RESOURCE_PREFIX}{session_id}?through={t}"))
                    }
                    Some(_) => Err("Invalid Session resource through watermark"),
                    None => Ok(format!("{SESSION_RESOURCE_PREFIX}{session_id}")),
                }
            }
            Self::SessionToolResult {
                session_id,
                event_id,
            } => {
                entity_id(session_id)?;
                entity_id(event_id)?;
                Ok(format!(
                    "{SESSION_RESOURCE_PREFIX}{session_id}{SESSION_TOOL_RESULT_SEGMENT}{event_id}"
                ))
            }
            Self::SessionImportedToolResult {
                session_id,
                address,
            } => {
                entity_id(session_id)?;
                let encoded = encode_imported_address(address)?;
                Ok(format!(
                    "{SESSION_RESOURCE_PREFIX}{session_id}{SESSION_IMPORTED_TOOL_RESULT_SEGMENT}{encoded}"
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_session_and_actionable_uri_diagnostics() {
        assert_eq!(
            ResourceAddress::parse("maka://session/ma_123").unwrap(),
            Some(ResourceAddress::Session {
                session_id: "ma_123".into(),
                through: None,
            })
        );
        assert_eq!(
            ResourceAddress::parse("maka://session/ma_123?through=42").unwrap(),
            Some(ResourceAddress::Session {
                session_id: "ma_123".into(),
                through: Some(42),
            })
        );
        assert_eq!(
            ResourceAddress::Session {
                session_id: "ma_123".into(),
                through: Some(42),
            }
            .canonical_path()
            .unwrap(),
            "maka://session/ma_123?through=42"
        );
        assert_eq!(
            ResourceAddress::parse("session:ma_123").unwrap(),
            Some(ResourceAddress::Session {
                session_id: "ma_123".into(),
                through: None,
            })
        );
        assert_eq!(
            ResourceAddress::parse("maka://session/ma_123/tool-results/evt_456").unwrap(),
            Some(ResourceAddress::SessionToolResult {
                session_id: "ma_123".into(),
                event_id: "evt_456".into(),
            })
        );
        let imported: HistoryRowAddress = serde_json::from_value(serde_json::json!({
            "kind": "imported",
            "path": [],
            "snapshot": "00000000-0000-0000-0000-000000000001",
            "messageOrdinal": 3,
            "partOrdinal": 0
        }))
        .unwrap();
        let imported_uri = ResourceAddress::SessionImportedToolResult {
            session_id: "ma_123".into(),
            address: imported.clone(),
        }
        .canonical_path()
        .unwrap();
        assert_eq!(
            ResourceAddress::parse(&imported_uri).unwrap(),
            Some(ResourceAddress::SessionImportedToolResult {
                session_id: "ma_123".into(),
                address: imported,
            })
        );
        let http_err = ResourceAddress::parse("https://github.com/apache/maka").unwrap_err();
        assert!(http_err.contains("WebFetch"), "{http_err}");
        let uri_err = ResourceAddress::parse("maka://unknown/thing").unwrap_err();
        assert!(uri_err.contains("maka://session/<id>"), "{uri_err}");
    }
}
