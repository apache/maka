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
mod source;
use crate::{
    read::{
        MAX_PAGE_CHARS, PageBudget, ReadInput, ReadPage,
        page::{TAIL_PREVIEW_KEY_UTF16, TailRing, json_char_utf16_len, json_string_body_utf16_len},
    },
    tool_output::{DurableToolProjection, ProjectionPart},
};
pub use encoding::{
    encode_projection, outcome_projection, projection_digest, projection_identity_source,
    projection_source,
};
pub use reference::ToolResultAddress;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
pub use source::{
    prepare_imported_source, prepare_imported_source_with_budget, prepare_source_projection,
};

/// Default approximate text-output budget for Code Mode (`exec` / `wait`) in tokens.
pub const DEFAULT_CELL_OUTPUT_TOKENS: usize = 10_000;
/// Hard ceiling on per-call Code Mode output tokens.
pub const MAX_CELL_OUTPUT_TOKENS: usize = 20_000;
/// Approximate UTF-16 code units per token used for Cell display budgets.
pub const CHARS_PER_TOKEN: usize = 4;
/// Default Cell display-body budget in UTF-16 code units (40,000 chars).
pub const DEFAULT_CELL_DISPLAY_CHARS: usize = DEFAULT_CELL_OUTPUT_TOKENS * CHARS_PER_TOKEN;
/// Maximum Cell display-body budget in UTF-16 code units (80,000 chars).
pub const MAX_CELL_DISPLAY_CHARS: usize = MAX_CELL_OUTPUT_TOKENS * CHARS_PER_TOKEN;
/// Bounded trailing preview target (UTF-16 code units) for bounded-format archive placeholders.
pub const ARCHIVE_TAIL_PREVIEW_CHARS: usize = 3_000;

/// Minimum optional display-body budget before attaching a trailing preview.
const MIN_BUDGET_FOR_TAIL_PREVIEW: usize = 1_000;

const ARCHIVE_READ_INSTRUCTIONS: &str = "Output exceeded the display budget and was archived. Pass page.next to Read to continue sequentially, or call Read({ path: resourceRef, offset, limit }) to jump directly to specific lines (e.g. near page.totalLines). The address is a Session resource, not a workspace file.";
const MIXED_ARCHIVE_READ_INSTRUCTIONS: &str = "Text output exceeded the display budget and was archived while preserving media parts in order. Call Read({ path: resourceRef, offset, limit }) to read the full archived event. The address is a Session resource, not a workspace file.";

/// Effective frozen display-body budget for a Cell observation, capped at MAX_CELL_OUTPUT_TOKENS
/// with no artificial lower bound so explicit small budgets are honored.
pub fn effective_cell_display_chars(max_tokens: usize) -> usize {
    max_tokens
        .min(MAX_CELL_OUTPUT_TOKENS)
        .saturating_mul(CHARS_PER_TOKEN)
}

/// Returns (page_budget, tail_serialized_budget) for archiving an overflowing result.
pub(crate) fn page_and_tail_budgets(display_budget_chars: usize) -> (PageBudget, usize) {
    let tail_budget = if display_budget_chars >= MIN_BUDGET_FOR_TAIL_PREVIEW {
        ARCHIVE_TAIL_PREVIEW_CHARS.min(display_budget_chars / 4)
    } else {
        0
    };
    (PageBudget::DisplayBody(display_budget_chars), tail_budget)
}

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

/// Mandatory Cell status preserved outside the optional display-body cap so
/// zero/tiny budgets still expose Cell state and cell_id without leaking body text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CellStatus {
    pub state: String,
    pub cell_id: String,
}

/// Extract mandatory Cell status (state, cell_id) from the leading JSON prefix
/// of a Cell observation without reading or exposing variable result/diagnostic payloads.
pub(crate) fn extract_cell_status_prefix(prefix: &str) -> Option<CellStatus> {
    let rest = prefix.strip_prefix("{\"state\":\"")?;
    let state_end = rest.find('"')?;
    let state = &rest[..state_end];
    if !matches!(state, "running" | "completed" | "interrupted") {
        return None;
    }
    let rest = rest[state_end..].strip_prefix("\",\"cell_id\":\"")?;
    let id_end = rest.find('"')?;
    let cell_id = &rest[..id_end];
    if cell_id.is_empty() || cell_id.len() > 128 || cell_id.bytes().any(|b| b == b'\\' || b < 0x20)
    {
        return None;
    }
    match rest.as_bytes().get(id_end + 1) {
        Some(b',' | b'}') => Some(CellStatus {
            state: state.to_owned(),
            cell_id: cell_id.to_owned(),
        }),
        _ => None,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchivedPlaceholder {
    pub identity: ArchiveIdentity,
    pub original_estimated_tokens: u64,
    pub reason: PruneReason,
    pub page: ReadPage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cell_status: Option<CellStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tail_preview: Option<String>,
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
#[serde(rename_all = "camelCase")]
struct CanonicalPlaceholder<'a> {
    #[serde(flatten)]
    header: CanonicalHeader<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cell_status: Option<&'a CellStatus>,
    page: &'a ReadPage,
    #[serde(skip_serializing_if = "Option::is_none")]
    tail_preview: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MixedArchiveNotice<'a> {
    #[serde(flatten)]
    header: CanonicalHeader<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cell_status: Option<&'a CellStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tail_preview: Option<&'a str>,
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
    /// Prepare only bounded model evidence from an already-authorized projection.
    /// The supplied Fact identity remains the original result's archive locator.
    pub fn prepare(
        event_id: String,
        tool_call_id: String,
        tool_name: String,
        projection: &DurableToolProjection,
    ) -> Result<Option<Self>, &'static str> {
        Self::prepare_with_budget(
            event_id,
            tool_call_id,
            tool_name,
            projection,
            MAX_PAGE_CHARS,
        )
    }

    pub fn prepare_with_budget(
        event_id: String,
        tool_call_id: String,
        tool_name: String,
        projection: &DurableToolProjection,
        display_budget_chars: usize,
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
        if chars <= display_budget_chars {
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
        let (page_budget, tail_budget) = page_and_tail_budgets(display_budget_chars);
        let request = ReadInput {
            path: header.resource_ref.clone(),
            offset: None,
            limit: None,
        }
        .resolve()
        .map_err(|_| "invalid archive address")?;
        let (page, tail_preview) = request
            .tool_result_page_with_budget(&identity.tool_name, body, page_budget, tail_budget)
            .map_err(|_| "archive page cannot fit the model response")?;
        let cell_status = match projection {
            DurableToolProjection::Text { text } => extract_cell_status_prefix(text),
            DurableToolProjection::Content { parts } => parts.first().and_then(|part| match part {
                ProjectionPart::Text { text } => extract_cell_status_prefix(text),
                _ => None,
            }),
            _ => None,
        };
        let placeholder = Self {
            identity,
            original_estimated_tokens: (chars as u64).div_ceil(4),
            reason: PruneReason::ToolResultPruned,
            page,
            cell_status,
            tail_preview,
        };
        placeholder.validate()?;
        Ok(Some(placeholder))
    }

    /// Unified in-memory archive projection: handles both pure-text/JSON placeholders and
    /// mixed text+media Content projections under one display-body budget.
    pub fn prepare_projection(
        event_id: String,
        tool_call_id: String,
        tool_name: String,
        projection: &DurableToolProjection,
        display_budget_chars: usize,
    ) -> Result<Option<DurableToolProjection>, &'static str> {
        if let DurableToolProjection::Content { parts } = projection
            && parts.iter().any(|part| part.media().is_some())
        {
            let total_text_chars: usize = parts
                .iter()
                .filter_map(|part| match part {
                    ProjectionPart::Text { text } => Some(text.encode_utf16().count()),
                    _ => None,
                })
                .sum();
            if total_text_chars <= display_budget_chars {
                return Ok(None);
            }
            if !identity_string(&event_id)
                || !identity_string(&tool_call_id)
                || !identity_string(&tool_name)
            {
                return Err("invalid archive identity");
            }
            let original_bytes = encode_projection(projection)?.len() as u64;
            let resource_ref = ToolResultAddress::short_event_ref(&event_id)?;
            let bounded = bound_mixed_content_parts(
                parts,
                &tool_name,
                resource_ref,
                original_bytes,
                display_budget_chars,
            )?;
            return Ok(Some(DurableToolProjection::Content { parts: bounded }));
        }
        match Self::prepare_with_budget(
            event_id,
            tool_call_id,
            tool_name,
            projection,
            display_budget_chars,
        )? {
            Some(archived) => Ok(Some(archived.to_canonical_projection()?)),
            None => Ok(None),
        }
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
            cell_status: self.cell_status.as_ref(),
            page: &self.page,
            tail_preview: self.tail_preview.as_deref(),
        })
        .map_err(|_| "invalid archive projection")
    }
}

fn canonical_header(identity: &ArchiveIdentity) -> Result<CanonicalHeader<'_>, &'static str> {
    Ok(canonical_resource_header(
        &identity.tool_name,
        identity.short_ref()?,
        identity.original_bytes,
    ))
}

fn canonical_resource_header(
    tool_name: &str,
    resource_ref: String,
    original_bytes: u64,
) -> CanonicalHeader<'_> {
    CanonicalHeader {
        kind: "maka.archived_tool_result",
        resource_ref,
        tool_name,
        original_bytes,
        reason: PruneReason::ToolResultPruned,
        read_instructions: ARCHIVE_READ_INSTRUCTIONS,
    }
}

pub(crate) fn mixed_archive_notice_text(
    tool_name: &str,
    resource_ref: String,
    original_bytes: u64,
    cell_status: Option<&CellStatus>,
    tail_preview: Option<&str>,
) -> Result<String, &'static str> {
    serde_json::to_string(&MixedArchiveNotice {
        header: CanonicalHeader {
            kind: "maka.archived_tool_result",
            resource_ref,
            tool_name,
            original_bytes,
            reason: PruneReason::ToolResultPruned,
            read_instructions: MIXED_ARCHIVE_READ_INSTRUCTIONS,
        },
        cell_status,
        tail_preview,
    })
    .map_err(|_| "invalid mixed archive notice")
}

/// Fixed-memory UTF-16 bounded head + trailing ring accumulator shared across mixed-media
/// archiving and asynchronous Cell notification / recovery rendering.
pub struct BoundedTextAccumulator {
    head_remaining: usize,
    json_escaped: bool,
    tail: TailRing,
    total_bytes: usize,
    total_utf16: usize,
    total_lines: usize,
    last_kept_byte: usize,
    truncated: bool,
}

impl BoundedTextAccumulator {
    /// Budget optional display text embedded in a JSON-serialized archive notice
    /// (accounting for JSON string escaping in both head and tailPreview).
    pub fn for_json_notice(budget_chars: usize) -> Self {
        let tail_cap = if budget_chars >= MIN_BUDGET_FOR_TAIL_PREVIEW {
            ARCHIVE_TAIL_PREVIEW_CHARS.min(budget_chars / 4)
        } else {
            0
        };
        let head_budget = budget_chars.saturating_sub(tail_cap);
        let tail_content_cap = tail_cap.saturating_sub(TAIL_PREVIEW_KEY_UTF16 + 2);
        Self {
            head_remaining: head_budget,
            json_escaped: true,
            tail: TailRing::new(tail_content_cap, true),
            total_bytes: 0,
            total_utf16: 0,
            total_lines: 1,
            last_kept_byte: 0,
            truncated: false,
        }
    }

    /// Budget plain-text display payloads (e.g. asynchronous Cell notifications and recovery).
    pub fn for_plain_text(budget_chars: usize) -> Self {
        let tail_cap = if budget_chars >= MIN_BUDGET_FOR_TAIL_PREVIEW {
            ARCHIVE_TAIL_PREVIEW_CHARS.min(budget_chars / 4)
        } else {
            0
        };
        let head_budget = budget_chars.saturating_sub(tail_cap);
        Self {
            head_remaining: head_budget,
            json_escaped: false,
            tail: TailRing::new(tail_cap, false),
            total_bytes: 0,
            total_utf16: 0,
            total_lines: 1,
            last_kept_byte: 0,
            truncated: false,
        }
    }

    pub fn push_chunk(&mut self, text: &str, kept: &mut String) {
        for ch in text.chars() {
            let raw_u16 = ch.len_utf16();
            let cost = if self.json_escaped {
                json_char_utf16_len(ch)
            } else {
                raw_u16
            };
            let u8_len = ch.len_utf8();
            if ch == '\n' {
                self.total_lines += 1;
            }
            if !self.truncated && cost <= self.head_remaining {
                kept.push(ch);
                self.head_remaining -= cost;
                self.last_kept_byte = self.total_bytes + u8_len;
            } else {
                self.truncated = true;
            }
            self.tail.push(ch, self.total_bytes);
            self.total_bytes += u8_len;
            self.total_utf16 += raw_u16;
        }
    }

    pub fn push_separator(&mut self) {
        if self.total_bytes == 0 {
            return;
        }
        let mut ignored = String::new();
        self.push_chunk("\n", &mut ignored);
    }

    pub fn truncated(&self) -> bool {
        self.truncated
    }

    pub fn total_utf16(&self) -> usize {
        self.total_utf16
    }

    pub fn total_lines(&self) -> usize {
        self.total_lines
    }

    pub fn finish_tail(self) -> Option<String> {
        if !self.truncated {
            return None;
        }
        self.tail.finish(self.last_kept_byte)
    }
}

/// Bound a text field that will be embedded as a JSON string inside a report object
/// (e.g. async Cell notify text, diagnostic, or stringified result) so its JSON-escaped
/// UTF-16 length strictly fits within budget_chars. Returns (text, serialized_json_body_utf16).
pub fn bound_json_field_text(
    text: &str,
    budget_chars: usize,
) -> (std::borrow::Cow<'_, str>, usize) {
    let raw_json_cost = json_string_body_utf16_len(text);
    if raw_json_cost <= budget_chars {
        return (std::borrow::Cow::Borrowed(text), raw_json_cost);
    }
    // Reserve the worst-case JSON-escaped UTF-16 overhead of the truncation banner + tail header.
    const NOTICE_JSON_RESERVE: usize = 160;
    if budget_chars <= NOTICE_JSON_RESERVE {
        let mut kept = String::new();
        let mut used = 0usize;
        for ch in text.chars() {
            let cost = json_char_utf16_len(ch);
            if used + cost > budget_chars {
                break;
            }
            kept.push(ch);
            used += cost;
        }
        return (std::borrow::Cow::Owned(kept), used);
    }
    let content_budget = budget_chars - NOTICE_JSON_RESERVE;
    let tail_cap = if content_budget >= MIN_BUDGET_FOR_TAIL_PREVIEW {
        ARCHIVE_TAIL_PREVIEW_CHARS.min(content_budget / 4)
    } else {
        0
    };
    let head_budget = content_budget.saturating_sub(tail_cap);
    let mut acc = BoundedTextAccumulator {
        head_remaining: head_budget,
        json_escaped: true,
        tail: TailRing::new(tail_cap, true),
        total_bytes: 0,
        total_utf16: 0,
        total_lines: 1,
        last_kept_byte: 0,
        truncated: false,
    };
    let mut head = String::new();
    acc.push_chunk(text, &mut head);
    let total_utf16 = acc.total_utf16();
    let total_lines = acc.total_lines();
    let tail = acc.finish_tail();
    let mut rendered = head;
    if !rendered.is_empty() {
        rendered.push('\n');
    }
    rendered.push_str(&format!(
        "[output truncated: {total_utf16} chars across {total_lines} lines exceeded display budget of {budget_chars} chars]"
    ));
    if let Some(tail) = tail {
        rendered.push_str("\n[tailPreview]\n");
        rendered.push_str(&tail);
    }
    let cost = json_string_body_utf16_len(&rendered);
    (std::borrow::Cow::Owned(rendered), cost)
}

fn bound_mixed_content_parts(
    parts: &[ProjectionPart],
    tool_name: &str,
    resource_ref: String,
    original_bytes: u64,
    limit: usize,
) -> Result<Vec<ProjectionPart>, &'static str> {
    let cell_status = parts.first().and_then(|part| match part {
        ProjectionPart::Text { text } => extract_cell_status_prefix(text),
        _ => None,
    });
    let mut acc = BoundedTextAccumulator::for_json_notice(limit);
    let mut bounded = Vec::with_capacity(parts.len() + 1);
    let mut seen_text = false;
    for part in parts {
        match part {
            ProjectionPart::Text { text } => {
                if seen_text {
                    acc.push_separator();
                }
                seen_text = true;
                let mut kept = String::new();
                acc.push_chunk(text, &mut kept);
                if !kept.is_empty() {
                    bounded.push(ProjectionPart::Text { text: kept });
                }
            }
            media => bounded.push(media.clone()),
        }
    }
    let tail = acc.finish_tail();
    let notice = mixed_archive_notice_text(
        tool_name,
        resource_ref,
        original_bytes,
        cell_status.as_ref(),
        tail.as_deref(),
    )?;
    bounded.push(ProjectionPart::Text { text: notice });
    Ok(bounded)
}
