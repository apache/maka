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

/// Only an address within a caller's actual source tree, never read authority.
pub fn imported_tool_result_path(address: &HistoryRowAddress) -> Result<String, &'static str> {
    if !matches!(address, HistoryRowAddress::Imported { .. }) {
        return Err("Tool-result history addresses must identify an imported part");
    }
    address.validate()?;
    let bytes = serde_json::to_vec(address).map_err(|_| "Invalid imported tool-result address")?;
    let encoded_len = base64::encoded_len(bytes.len(), false)
        .and_then(|length| length.checked_add(IMPORTED_TOOL_RESULT_PREFIX.len()))
        .ok_or("Imported tool-result address length overflow")?;
    let mut path = String::with_capacity(encoded_len);
    path.push_str(IMPORTED_TOOL_RESULT_PREFIX);
    URL_SAFE_NO_PAD.encode_string(bytes, &mut path);
    Ok(path)
}

pub fn parse_imported_tool_result_path(
    path: &str,
) -> Result<Option<HistoryRowAddress>, &'static str> {
    let Some(encoded) = path.strip_prefix(IMPORTED_TOOL_RESULT_PREFIX) else {
        return Ok(None);
    };
    let invalid = "Invalid imported tool-result address";
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
    if imported_tool_result_path(&address)? != path {
        return Err(invalid);
    }
    Ok(Some(address))
}

/// A Session resource locator; resolving it never grants access to its content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResourceAddress {
    Attachment(String),
    Task(String),
    ToolResult(String),
}

impl ResourceAddress {
    /// Ordinary filesystem paths have no resource address.
    pub fn parse(path: &str) -> Result<Option<Self>, &'static str> {
        if path.starts_with("archive:") || path.starts_with("maka://runtime/tool-results/") {
            return ToolResultAddress::parse(path)
                .map(|address| Some(Self::ToolResult(address.event_id().to_owned())));
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
        if path.contains("://") {
            return Err("Unsupported Maka address; use a path returned by a tool");
        }
        Ok(None)
    }

    pub fn id(&self) -> &str {
        match self {
            Self::Attachment(id) | Self::Task(id) | Self::ToolResult(id) => id,
        }
    }

    pub fn with_id(mut self, resolved: String) -> Self {
        match &mut self {
            Self::Attachment(id) | Self::Task(id) | Self::ToolResult(id) => *id = resolved,
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
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        durable::{FactId, RunId},
        history_snapshot::SnapshotId,
    };

    #[test]
    fn imported_uri_preserves_the_whole_leaf_address_and_rejects_noncanonical_data() {
        let address = HistoryRowAddress::Imported {
            path: vec![RunId::new(), RunId::new()],
            snapshot: SnapshotId::new(),
            message_ordinal: 7,
            part_ordinal: 3,
        };
        let uri = imported_tool_result_path(&address).unwrap();
        assert_eq!(
            parse_imported_tool_result_path(&uri).unwrap(),
            Some(address.clone())
        );
        let mut invalid_range = serde_json::to_value(&address).unwrap();
        invalid_range["messageOrdinal"] = serde_json::json!(9_007_199_254_740_992_u64);
        for bad in [
            format!("{uri}="),
            format!("{uri}?session=other"),
            format!("{uri}#fragment"),
            format!(
                "{IMPORTED_TOOL_RESULT_PREFIX}{}",
                URL_SAFE_NO_PAD.encode(serde_json::to_string_pretty(&address).unwrap(),)
            ),
            format!(
                "{IMPORTED_TOOL_RESULT_PREFIX}{}",
                URL_SAFE_NO_PAD.encode(
                    serde_json::to_vec(&HistoryRowAddress::Live {
                        sequence: 1,
                        fact: FactId::new(),
                        item_index: 0,
                    })
                    .unwrap(),
                )
            ),
            format!(
                "{IMPORTED_TOOL_RESULT_PREFIX}{}",
                URL_SAFE_NO_PAD.encode(serde_json::to_vec(&invalid_range).unwrap(),)
            ),
        ] {
            assert!(parse_imported_tool_result_path(&bad).is_err(), "{bad}");
        }
        let live = format!("archive:{}", FactId::new());
        assert_eq!(parse_imported_tool_result_path(&live).unwrap(), None);
        assert!(matches!(
            ResourceAddress::parse(&live).unwrap(),
            Some(ResourceAddress::ToolResult(_))
        ));
    }

    #[test]
    fn a_deep_imported_address_is_not_rejected_as_a_32k_work_chunk() {
        let address = HistoryRowAddress::Imported {
            path: vec![RunId::new(); 900],
            snapshot: SnapshotId::new(),
            message_ordinal: 0,
            part_ordinal: 0,
        };
        let uri = imported_tool_result_path(&address).unwrap();
        assert!(uri.len() > 32 * 1024);
        assert_eq!(
            parse_imported_tool_result_path(&uri).unwrap(),
            Some(address)
        );
    }
}
