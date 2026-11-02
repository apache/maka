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

//! Durable, bounded replacements of immutable model evidence.
mod encoding;
mod reference;
use crate::{
    read::{MAX_PAGE_CHARS, ReadInput, ReadPage},
    tool_output::DurableToolProjection,
};
pub use encoding::{encode_projection, outcome_projection, projection_digest};
pub use reference::ToolResultAddress;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const ARCHIVE_READ_INSTRUCTIONS: &str = "Read the page below; pass page.next to Read to continue. The address is a Session resource, not a workspace file.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PruneReason {
    ToolResultPruned,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveIdentity {
    pub runtime_event_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub source_projection_digest: String,
    pub body_sha256: String,
    pub original_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchivedPlaceholder {
    pub identity: ArchiveIdentity,
    pub original_estimated_tokens: u64,
    pub reason: PruneReason,
    pub page: ReadPage,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalHeader<'a> {
    kind: &'static str,
    resource_ref: String,
    tool_name: &'a str,
    original_bytes: u64,
    reason: PruneReason,
    read_instructions: &'static str,
}

#[derive(Serialize)]
struct CanonicalPlaceholder<'a> {
    #[serde(flatten)]
    header: CanonicalHeader<'a>,
    page: &'a ReadPage,
}

pub(crate) fn identity_string(value: &str) -> bool {
    !value.is_empty()
}
pub(crate) fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn valid_projection_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(hash)
}

impl ArchivedPlaceholder {
    /// One size rule for current and historical results. Media stays materializable.
    pub fn prepare(
        event_id: String,
        tool_call_id: String,
        tool_name: String,
        projection: &DurableToolProjection,
    ) -> Result<Option<Self>, &'static str> {
        if matches!(projection, DurableToolProjection::Content { parts }
            if parts.iter().any(|part| part.media().is_some()))
            || matches!(projection, DurableToolProjection::Json { value }
                if value.get("kind").and_then(serde_json::Value::as_str) == Some("maka.archived_tool_result"))
        {
            return Ok(None);
        }
        let bytes = encode_projection(projection)?;
        let body = std::str::from_utf8(&bytes).map_err(|_| "invalid archive text")?;
        let chars = body.encode_utf16().count();
        if chars <= MAX_PAGE_CHARS {
            return Ok(None);
        }
        let identity = ArchiveIdentity {
            runtime_event_id: event_id,
            tool_call_id,
            tool_name,
            source_projection_digest: projection_digest(projection)?,
            body_sha256: hex::encode(Sha256::digest(&bytes)),
            original_bytes: bytes.len() as u64,
        };
        identity.validate()?;
        let header = canonical_header(&identity)?;
        // Inserting ,"page": into the header adds eight characters.
        let overhead = serde_json::to_string(&header)
            .map_err(|_| "invalid archive header")?
            .encode_utf16()
            .count()
            + 8;
        let request = ReadInput {
            path: header.resource_ref.clone(),
            offset: None,
            limit: None,
        }
        .resolve()
        .map_err(|_| "invalid archive address")?;
        let page = request
            .tool_result_page(
                &identity.tool_name,
                body,
                MAX_PAGE_CHARS.saturating_sub(overhead).max(1),
            )
            .map_err(|_| "archive page cannot fit the model response")?;
        let placeholder = Self {
            identity,
            original_estimated_tokens: (chars as u64).div_ceil(4),
            reason: PruneReason::ToolResultPruned,
            page,
        };
        placeholder.validate()?;
        Ok(Some(placeholder))
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        self.identity.validate()?;
        if self.original_estimated_tokens > 9_007_199_254_740_991 {
            return Err("archive exceeds token limit");
        }
        Ok(())
    }

    /// Canonical evidence codec; Engine projects current guidance separately.
    /// Preserve the frozen page and header for source verification.
    pub fn to_canonical_projection(&self) -> Result<DurableToolProjection, &'static str> {
        self.validate()?;
        Ok(DurableToolProjection::Json {
            value: self.canonical_value()?,
        })
    }

    fn canonical_value(&self) -> Result<serde_json::Value, &'static str> {
        serde_json::to_value(CanonicalPlaceholder {
            header: canonical_header(&self.identity)?,
            page: &self.page,
        })
        .map_err(|_| "invalid archive projection")
    }
}

fn canonical_header(identity: &ArchiveIdentity) -> Result<CanonicalHeader<'_>, &'static str> {
    Ok(CanonicalHeader {
        kind: "maka.archived_tool_result",
        resource_ref: identity.short_ref()?,
        tool_name: &identity.tool_name,
        original_bytes: identity.original_bytes,
        reason: PruneReason::ToolResultPruned,
        read_instructions: ARCHIVE_READ_INSTRUCTIONS,
    })
}
