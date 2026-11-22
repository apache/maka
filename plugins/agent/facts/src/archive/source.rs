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

use super::{
    ArchiveIdentity, ArchivedPlaceholder, BoundedTextAccumulator, CanonicalHeader,
    CanonicalPlaceholder, CellStatus, PruneReason, ToolResultAddress, canonical_header,
    canonical_resource_header, extract_cell_status_prefix, identity_string,
    mixed_archive_notice_text, page_and_tail_budgets, projection_identity_source,
    projection_source,
};
use crate::{
    history::HistoryRowAddress,
    model::prompt_source::source::{
        self as pull, ByteSource, JsonSource, SourceBudget,
        json::{self, ArrayCursor},
    },
    read::{self, MAX_PAGE_CHARS, ReadInput, ReadPage},
    tool_output::{DurableToolProjection, ProjectionPart},
};
use sha2::{Digest, Sha256};
use std::{io, sync::Arc};
use tokio_util::sync::CancellationToken;

const MAX_MEDIA_PART_BYTES: usize = 64 * 1024;

impl ArchivedPlaceholder {
    /// Prepare only bounded model evidence from an already-authorized projection.
    /// The supplied Fact identity remains the original result's archive locator.
    pub async fn prepare_source(
        event_id: String,
        tool_call_id: String,
        tool_name: String,
        projection: JsonSource,
        budget: Arc<dyn SourceBudget>,
        cancellation: &CancellationToken,
    ) -> io::Result<Option<Self>> {
        Self::prepare_source_with_budget(
            event_id,
            tool_call_id,
            tool_name,
            projection,
            MAX_PAGE_CHARS,
            budget,
            cancellation,
        )
        .await
    }

    pub async fn prepare_source_with_budget(
        event_id: String,
        tool_call_id: String,
        tool_name: String,
        projection: JsonSource,
        display_budget_chars: usize,
        budget: Arc<dyn SourceBudget>,
        cancellation: &CancellationToken,
    ) -> io::Result<Option<Self>> {
        cancellation
            .run_until_cancelled(async {
                if excluded(&projection, budget.clone()).await? {
                    return Ok(None);
                }
                let mut original_bytes = 0u64;
                let mut chars = 0u64;
                let body_sha256 = hash_source(
                    projection_source(projection.clone()),
                    budget.clone(),
                    |bytes| record_size(bytes, &mut original_bytes, &mut chars),
                )
                .await?;
                if chars <= display_budget_chars as u64 {
                    return Ok(None);
                }
                let digest = hash_source(
                    projection_identity_source(projection.clone()),
                    budget.clone(),
                    |_| Ok(()),
                )
                .await?;
                let identity = ArchiveIdentity {
                    runtime_event_id: event_id,
                    tool_call_id,
                    tool_name,
                    source_projection_digest: format!("sha256:{digest}"),
                    body_sha256,
                    original_bytes,
                };
                identity.validate().map_err(invalid)?;
                let header = canonical_header(&identity).map_err(invalid)?;
                let (page, tail_preview, cell_status) = first_page_with_tail(
                    &header,
                    projection,
                    display_budget_chars,
                    budget,
                    cancellation,
                )
                .await?;
                let placeholder = Self {
                    identity,
                    original_estimated_tokens: chars.div_ceil(4),
                    reason: PruneReason::ToolResultPruned,
                    page,
                    cell_status,
                    tail_preview,
                };
                placeholder.validate().map_err(invalid)?;
                Ok(Some(placeholder))
            })
            .await
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::Interrupted, "archive preparation cancelled")
            })?
    }
}

/// Unified streaming archive projection for native tool results: handles both pure-text/JSON
/// placeholders and mixed text+media Content results under one display-body budget.
pub async fn prepare_source_projection(
    event_id: String,
    tool_call_id: String,
    tool_name: String,
    projection: JsonSource,
    display_budget_chars: usize,
    budget: Arc<dyn SourceBudget>,
    cancellation: &CancellationToken,
) -> io::Result<Option<DurableToolProjection>> {
    let mixed = cancellation
        .run_until_cancelled(async {
            let Some(parts) = mixed_media_parts(&projection, budget.clone()).await? else {
                return Ok(None);
            };
            if !identity_string(&event_id)
                || !identity_string(&tool_call_id)
                || !identity_string(&tool_name)
            {
                return Err(invalid("invalid archive identity"));
            }
            let resource_ref = ToolResultAddress::short_event_ref(&event_id).map_err(invalid)?;
            prepare_streaming_mixed_content(
                &tool_name,
                resource_ref,
                projection.clone(),
                parts,
                display_budget_chars,
                budget.clone(),
            )
            .await
            .map(Some)
        })
        .await
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::Interrupted, "archive preparation cancelled")
        })??;
    if let Some(result) = mixed {
        return Ok(result);
    }
    let Some(archived) = ArchivedPlaceholder::prepare_source_with_budget(
        event_id,
        tool_call_id,
        tool_name,
        projection,
        display_budget_chars,
        budget,
        cancellation,
    )
    .await?
    else {
        return Ok(None);
    };
    archived
        .to_canonical_projection()
        .map(Some)
        .map_err(invalid)
}

/// Prepare a bounded archive placeholder for an imported ToolReturn whose
/// original locator is a session history row address rather than a local FactId.
pub async fn prepare_imported_source(
    address: &HistoryRowAddress,
    tool_call_id: String,
    tool_name: String,
    projection: JsonSource,
    budget: Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<Option<DurableToolProjection>> {
    prepare_imported_source_with_budget(
        address,
        tool_call_id,
        tool_name,
        projection,
        MAX_PAGE_CHARS,
        budget,
        cancel,
    )
    .await
}

pub async fn prepare_imported_source_with_budget(
    address: &HistoryRowAddress,
    tool_call_id: String,
    tool_name: String,
    projection: JsonSource,
    display_budget_chars: usize,
    budget: Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<Option<DurableToolProjection>> {
    cancel
        .run_until_cancelled(async {
            if !identity_string(&tool_call_id) || !identity_string(&tool_name) {
                return Err(invalid("invalid imported tool result identity"));
            }
            if let Some(parts) = mixed_media_parts(&projection, budget.clone()).await? {
                let resource_ref = read::imported_tool_result_path(address).map_err(invalid)?;
                return prepare_streaming_mixed_content(
                    &tool_name,
                    resource_ref,
                    projection,
                    parts,
                    display_budget_chars,
                    budget,
                )
                .await;
            }
            if excluded(&projection, budget.clone()).await? {
                return Ok(None);
            }
            let resource_ref = read::imported_tool_result_path(address).map_err(invalid)?;
            let mut original_bytes = 0u64;
            let mut chars = 0u64;
            scan_source(
                projection_source(projection.clone()),
                budget.clone(),
                |bytes| record_size(bytes, &mut original_bytes, &mut chars),
            )
            .await?;
            if chars <= display_budget_chars as u64 {
                return Ok(None);
            }
            if !(1..=9_007_199_254_740_991).contains(&original_bytes) {
                return Err(invalid("invalid archive byte count"));
            }
            let header = canonical_resource_header(&tool_name, resource_ref, original_bytes);
            let (page, tail_preview, cell_status) =
                first_page_with_tail(&header, projection, display_budget_chars, budget, cancel)
                    .await?;
            let value = serde_json::to_value(CanonicalPlaceholder {
                header,
                cell_status: cell_status.as_ref(),
                page: &page,
                tail_preview: tail_preview.as_deref(),
            })
            .map_err(io::Error::other)?;
            Ok(Some(DurableToolProjection::Json { value }))
        })
        .await
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::Interrupted, "archive preparation cancelled")
        })?
}

async fn first_page_with_tail(
    header: &CanonicalHeader<'_>,
    projection: JsonSource,
    display_budget_chars: usize,
    budget: Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<(ReadPage, Option<String>, Option<CellStatus>)> {
    let (page_budget, tail_budget) = page_and_tail_budgets(display_budget_chars);
    let request = ReadInput {
        path: header.resource_ref.clone(),
        offset: None,
        limit: None,
    }
    .resolve()
    .map_err(io::Error::other)?;
    let (page, tail, prefix) = read::projection_page_with_budget_and_prefix(
        projection,
        header.tool_name,
        &request,
        page_budget,
        tail_budget,
        budget,
        cancel,
    )
    .await?;
    let cell_status = extract_cell_status_prefix(&prefix);
    Ok((page, tail, cell_status))
}

const CELL_STATUS_PREFIX_BYTES: usize = crate::read::page::STREAM_PREFIX_CAPTURE_BYTES;

async fn mixed_media_parts(
    projection: &JsonSource,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<Option<JsonSource>> {
    let fields = json::fields(projection, &["kind", "parts"], budget.clone()).await?;
    let kind = fields[0]
        .as_ref()
        .ok_or_else(|| invalid("missing projection kind"))?
        .text()?;
    if !json::text_eq(&kind, "content", budget.clone()).await? {
        return Ok(None);
    }
    let parts = fields[1]
        .as_ref()
        .ok_or_else(|| invalid("missing projection parts"))?;
    let mut cursor = ArrayCursor::open(parts.source.clone(), budget.clone()).await?;
    while let Some(part) = cursor.next().await? {
        let part_kind = json::field(&part.source, &["kind"], budget.clone())
            .await?
            .ok_or_else(|| invalid("missing projection part kind"))?
            .text()?;
        if json::text_eq(&part_kind, "artifact", budget.clone()).await?
            || json::text_eq(&part_kind, "audio", budget.clone()).await?
        {
            return Ok(Some(parts.source.clone()));
        }
    }
    Ok(None)
}

async fn prepare_streaming_mixed_content(
    tool_name: &str,
    resource_ref: String,
    projection: JsonSource,
    parts_source: JsonSource,
    limit: usize,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<Option<DurableToolProjection>> {
    let mut total_text_chars = 0u64;
    let mut cursor = ArrayCursor::open(parts_source.clone(), budget.clone()).await?;
    while let Some(part) = cursor.next().await? {
        let fields = json::fields(&part.source, &["kind", "text"], budget.clone()).await?;
        let part_kind = fields[0]
            .as_ref()
            .ok_or_else(|| invalid("missing projection part kind"))?
            .text()?;
        if json::text_eq(&part_kind, "text", budget.clone()).await? {
            let text_val = fields[1]
                .as_ref()
                .ok_or_else(|| invalid("missing text part content"))?;
            let bytes = pull::text::bytes(text_val.text()?, budget.clone());
            let mut reader = bytes.open(budget.clone());
            let mut buffer = budget.allocate(32 * 1024).await?;
            loop {
                let read = reader.read_chunk(buffer).await?;
                let mut ignored_bytes = 0u64;
                record_size(
                    &read.buffer.as_ref()[..read.bytes_read],
                    &mut ignored_bytes,
                    &mut total_text_chars,
                )?;
                buffer = read.buffer;
                if read.eof {
                    break;
                }
            }
        }
    }
    if total_text_chars <= limit as u64 {
        return Ok(None);
    }

    let mut original_bytes = 0u64;
    let mut ignored_chars = 0u64;
    scan_source(projection_source(projection), budget.clone(), |bytes| {
        record_size(bytes, &mut original_bytes, &mut ignored_chars)
    })
    .await?;

    let mut acc = BoundedTextAccumulator::for_json_notice(limit);
    let mut bounded_parts = Vec::new();
    let mut seen_text = false;
    let mut first_part = true;
    let mut first_part_prefix = String::new();
    let mut cursor = ArrayCursor::open(parts_source, budget.clone()).await?;
    while let Some(part) = cursor.next().await? {
        let is_first_part = first_part;
        first_part = false;
        let fields = json::fields(&part.source, &["kind", "text"], budget.clone()).await?;
        let part_kind = fields[0]
            .as_ref()
            .ok_or_else(|| invalid("missing projection part kind"))?
            .text()?;
        if json::text_eq(&part_kind, "text", budget.clone()).await? {
            if seen_text {
                acc.push_separator();
            }
            seen_text = true;
            let text_val = fields[1]
                .as_ref()
                .ok_or_else(|| invalid("missing text part content"))?;
            let bytes = pull::text::bytes(text_val.text()?, budget.clone());
            let mut reader = bytes.open(budget.clone());
            let mut buffer = budget.allocate(32 * 1024).await?;
            let mut pending = Vec::new();
            let mut kept = String::new();
            loop {
                let read = reader.read_chunk(buffer).await?;
                if read.bytes_read > 0 {
                    pending.extend_from_slice(&read.buffer.as_ref()[..read.bytes_read]);
                    let end = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(error) if error.error_len().is_none() => error.valid_up_to(),
                        Err(_) => return Err(invalid("invalid UTF-8 in text projection part")),
                    };
                    let chunk = std::str::from_utf8(&pending[..end])
                        .map_err(|_| invalid("invalid UTF-8 in text projection part"))?;
                    if is_first_part && first_part_prefix.len() < CELL_STATUS_PREFIX_BYTES {
                        for ch in chunk.chars() {
                            if first_part_prefix.len() + ch.len_utf8() > CELL_STATUS_PREFIX_BYTES {
                                break;
                            }
                            first_part_prefix.push(ch);
                        }
                    }
                    acc.push_chunk(chunk, &mut kept);
                    pending.drain(..end);
                }
                buffer = read.buffer;
                if read.eof {
                    break;
                }
            }
            if !pending.is_empty() {
                return Err(invalid("incomplete UTF-8 in text projection part"));
            }
            if !kept.is_empty() {
                bounded_parts.push(ProjectionPart::Text { text: kept });
            }
        } else {
            let raw =
                collect_bounded(part.source.into_bytes(), &budget, MAX_MEDIA_PART_BYTES).await?;
            let media_part: ProjectionPart =
                serde_json::from_slice(&raw).map_err(io::Error::other)?;
            bounded_parts.push(media_part);
        }
    }
    let cell_status = extract_cell_status_prefix(&first_part_prefix);
    let tail = acc.finish_tail();
    let notice = mixed_archive_notice_text(
        tool_name,
        resource_ref,
        original_bytes,
        cell_status.as_ref(),
        tail.as_deref(),
    )
    .map_err(invalid)?;
    bounded_parts.push(ProjectionPart::Text { text: notice });
    Ok(Some(DurableToolProjection::Content {
        parts: bounded_parts,
    }))
}

async fn collect_bounded(
    source: pull::SourceBytes,
    budget: &Arc<dyn SourceBudget>,
    maximum: usize,
) -> io::Result<Vec<u8>> {
    let mut reader = source.open(budget.clone());
    let mut buffer = budget.allocate(16 * 1024).await?;
    let mut out = Vec::new();
    loop {
        let read = reader.read_chunk(buffer).await?;
        if out.len() + read.bytes_read > maximum {
            return Err(invalid("media projection part exceeds bounded size"));
        }
        out.extend_from_slice(&read.buffer.as_ref()[..read.bytes_read]);
        buffer = read.buffer;
        if read.eof {
            return Ok(out);
        }
    }
}

fn record_size(bytes: &[u8], original_bytes: &mut u64, chars: &mut u64) -> io::Result<()> {
    *original_bytes = original_bytes
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| invalid("archive byte count overflow"))?;
    let units: u64 = bytes
        .iter()
        .map(|byte| {
            if *byte & 0xc0 == 0x80 {
                0
            } else if *byte >= 0xf0 {
                2
            } else {
                1
            }
        })
        .sum();
    *chars = chars
        .checked_add(units)
        .ok_or_else(|| invalid("archive UTF-16 count overflow"))?;
    Ok(())
}

async fn excluded(projection: &JsonSource, budget: Arc<dyn SourceBudget>) -> io::Result<bool> {
    let fields = json::fields(projection, &["kind", "value", "parts"], budget.clone()).await?;
    let kind = fields[0]
        .as_ref()
        .ok_or_else(|| invalid("missing projection kind"))?
        .text()?;
    if json::text_eq(&kind, "json", budget.clone()).await? {
        let value = fields[1]
            .as_ref()
            .ok_or_else(|| invalid("missing projection value"))?;
        if let Some(kind) = json::field(&value.source, &["kind"], budget.clone()).await?
            && kind.kind == json::JsonKind::String
        {
            return json::text_eq(&kind.text()?, "maka.archived_tool_result", budget).await;
        }
    } else if json::text_eq(&kind, "content", budget.clone()).await? {
        let parts = fields[2]
            .as_ref()
            .ok_or_else(|| invalid("missing projection parts"))?;
        let mut cursor = ArrayCursor::open(parts.source.clone(), budget.clone()).await?;
        while let Some(part) = cursor.next().await? {
            let kind = json::field(&part.source, &["kind"], budget.clone())
                .await?
                .ok_or_else(|| invalid("missing projection part kind"))?
                .text()?;
            if json::text_eq(&kind, "artifact", budget.clone()).await?
                || json::text_eq(&kind, "audio", budget.clone()).await?
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

async fn hash_source(
    source: Arc<dyn ByteSource>,
    budget: Arc<dyn SourceBudget>,
    mut observe: impl FnMut(&[u8]) -> io::Result<()>,
) -> io::Result<String> {
    let mut digest = Sha256::new();
    scan_source(source, budget, |bytes| {
        observe(bytes)?;
        digest.update(bytes);
        Ok(())
    })
    .await?;
    Ok(hex::encode(digest.finalize()))
}

async fn scan_source(
    source: Arc<dyn ByteSource>,
    budget: Arc<dyn SourceBudget>,
    mut observe: impl FnMut(&[u8]) -> io::Result<()>,
) -> io::Result<()> {
    let mut cursor = source.open(budget.clone());
    let mut buffer = budget.allocate(32 * 1024).await?;
    loop {
        let read = cursor.read_chunk(buffer).await?;
        observe(&read.buffer.as_ref()[..read.bytes_read])?;
        buffer = read.buffer;
        if read.eof {
            return Ok(());
        }
    }
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        attachment::StorageRef,
        model::prompt_source::source::{Allocate, ChargedBuffer, SourceBytes},
        tool_output::ImageOutput,
    };
    use serde_json::json;

    struct Budget;

    impl SourceBudget for Budget {
        fn allocate(&self, minimum: usize) -> Allocate<'_> {
            Box::pin(async move { Ok(ChargedBuffer::new(vec![0; minimum], ())) })
        }
    }

    #[tokio::test]
    async fn archived_shell_output_with_nul_can_be_paged() {
        let stdout = format!(
            "{}\nlast\0line",
            "前\0后\n".repeat(MAX_PAGE_CHARS / 8 + 200)
        );
        let projection = JsonSource::new(SourceBytes::Inline(
            serde_json::to_vec(&json!({
                "kind": "json",
                "value": {
                    "kind": "terminal",
                    "status": "completed",
                    "exitCode": 0,
                    "output": {
                        "mode": "pipes",
                        "stdout": stdout,
                        "stderr": "",
                        "stdoutTruncated": false,
                        "stderrTruncated": false,
                        "redacted": false
                    }
                }
            }))
            .unwrap()
            .into(),
        ));
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let stop = CancellationToken::new();
        let first = ArchivedPlaceholder::prepare_source(
            "original-event".into(),
            "shell-call".into(),
            "Shell".into(),
            projection.clone(),
            budget.clone(),
            &stop,
        )
        .await
        .unwrap()
        .expect("long shell output needs an archive")
        .page;
        let next = first.next.expect("long output has a continuation");
        let second = read::projection_page(
            projection,
            "Shell",
            &next.resolve().unwrap(),
            MAX_PAGE_CHARS,
            budget,
            &stop,
        )
        .await
        .unwrap();
        assert!(!first.partial_line);
        assert!(second.next.is_none());
        assert_eq!(format!("{}\n{}", first.content, second.content), stdout);
    }

    #[tokio::test]
    async fn bounded_budget_emits_tail_preview_and_honors_zero_budget_on_imported() {
        let mut lines =
            vec![r#"{"state":"completed","cell_id":"cell-1","result":{"ok":true}}"#.to_string()];
        for i in 0..300 {
            lines.push(format!(
                "line {i:03}: \"quoted\" \\ 中文 😀 {}",
                "x".repeat(40)
            ));
        }
        lines.push("FINAL DIAGNOSTIC: test_mixed_media failed".into());
        let body = lines.join("\n");
        let proj = DurableToolProjection::Text { text: body.clone() };
        let source = JsonSource::new(SourceBytes::Inline(
            serde_json::to_vec(&proj).unwrap().into(),
        ));
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let stop = CancellationToken::new();

        let streamed = prepare_source_projection(
            "event-123".into(),
            "call-1".into(),
            "exec".into(),
            source.clone(),
            4_000,
            budget.clone(),
            &stop,
        )
        .await
        .unwrap()
        .expect("overflowing exec output must archive");
        let in_mem = ArchivedPlaceholder::prepare_projection(
            "event-123".into(),
            "call-1".into(),
            "exec".into(),
            &proj,
            4_000,
        )
        .unwrap()
        .expect("in-memory archive");
        assert_eq!(streamed, in_mem);
        let DurableToolProjection::Json { value } = streamed else {
            panic!("expected canonical placeholder JSON");
        };
        let tail = value["tailPreview"].as_str().expect("tailPreview present");
        assert!(tail.contains("FINAL DIAGNOSTIC: test_mixed_media failed"));
        assert!(value["page"]["next"].is_object());

        let addr = HistoryRowAddress::Imported {
            path: Vec::new(),
            snapshot: serde_json::from_str("\"00000000-0000-0000-0000-000000000001\"").unwrap(),
            message_ordinal: 1,
            part_ordinal: 0,
        };
        let zero_imported = prepare_imported_source_with_budget(
            &addr,
            "call-1".into(),
            "exec".into(),
            source,
            0,
            budget.clone(),
            &stop,
        )
        .await
        .unwrap()
        .expect("zero budget on imported over-limit result must NOT fall back to full text");
        let DurableToolProjection::Json { value: zero_val } = zero_imported else {
            panic!("expected JSON placeholder");
        };
        assert!(zero_val.get("tailPreview").is_none());
        assert_eq!(zero_val["cellStatus"]["state"], "completed");
        assert_eq!(zero_val["cellStatus"]["cell_id"], "cell-1");
        assert_eq!(zero_val["page"]["content"].as_str(), Some(""));
        assert_eq!(zero_val["page"]["returnedLines"], 0);
        assert!(zero_val["page"]["next"].is_object());

        // Short 120-char optional body under max_output_tokens=0 must NOT leak body chars
        // and must be recoverable via page.next (at=0).
        let short_body = format!(
            "{{\"state\":\"completed\",\"cell_id\":\"cell-short\",\"result\":{{\"ok\":true}}}}\nSHORT_SECRET_{}",
            "x".repeat(120)
        );
        let short_proj = DurableToolProjection::Text {
            text: short_body.clone(),
        };
        let short_source = JsonSource::new(SourceBytes::Inline(
            serde_json::to_vec(&short_proj).unwrap().into(),
        ));
        let short_zero = prepare_source_projection(
            "evt-short-zero".into(),
            "call-short".into(),
            "exec".into(),
            short_source.clone(),
            0,
            budget.clone(),
            &stop,
        )
        .await
        .unwrap()
        .expect("short body must archive under zero budget");
        let short_ext = ArchivedPlaceholder::prepare_projection(
            "evt-short-zero".into(),
            "call-short".into(),
            "exec".into(),
            &short_proj,
            0,
        )
        .unwrap()
        .expect("external short zero archive");
        assert_eq!(short_zero, short_ext);
        let DurableToolProjection::Json { value: sz_val } = short_zero else {
            panic!("expected JSON placeholder");
        };
        assert_eq!(sz_val["cellStatus"]["state"], "completed");
        assert_eq!(sz_val["cellStatus"]["cell_id"], "cell-short");
        assert_eq!(sz_val["page"]["content"].as_str(), Some(""));
        assert!(!sz_val.to_string().contains("SHORT_SECRET_"));
        let next_input: ReadInput = serde_json::from_value(sz_val["page"]["next"].clone()).unwrap();
        let recovered = read::projection_page(
            short_source,
            "exec",
            &next_input.resolve().unwrap(),
            MAX_PAGE_CHARS,
            budget,
            &stop,
        )
        .await
        .unwrap();
        assert_eq!(recovered.content, short_body);
    }

    #[tokio::test]
    async fn mixed_text_and_media_budgets_text_and_preserves_media_order() {
        let img = ImageOutput {
            mime_type: "image/png".into(),
            reference: StorageRef::SessionFile {
                session_id: "sess-1".into(),
                relative_path: "artifacts/shot.png".into(),
            },
            detail: None,
        };
        let proj = DurableToolProjection::Content {
            parts: vec![
                ProjectionPart::Text {
                    text: r#"{"state":"completed","cell_id":"cell-mix","result":{"ok":true}}"#
                        .into(),
                },
                ProjectionPart::Text {
                    text: format!("{}\nTAIL-ERROR-MARKER", "log-line\n".repeat(1_000)),
                },
                ProjectionPart::Artifact { image: img.clone() },
                ProjectionPart::Text {
                    text: "after-image-final-line".into(),
                },
            ],
        };
        let source = JsonSource::new(SourceBytes::Inline(
            serde_json::to_vec(&proj).unwrap().into(),
        ));
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let stop = CancellationToken::new();

        let streamed = prepare_source_projection(
            "evt-mix".into(),
            "call-mix".into(),
            "exec".into(),
            source,
            2_000,
            budget,
            &stop,
        )
        .await
        .unwrap()
        .expect("mixed media with huge text must be bounded");
        let in_mem = ArchivedPlaceholder::prepare_projection(
            "evt-mix".into(),
            "call-mix".into(),
            "exec".into(),
            &proj,
            2_000,
        )
        .unwrap()
        .expect("in-memory mixed media bounded");
        assert_eq!(streamed, in_mem);

        let DurableToolProjection::Content { parts } = streamed else {
            panic!("expected Content projection preserving media");
        };
        assert!(
            parts
                .iter()
                .any(|p| matches!(p, ProjectionPart::Artifact { image } if image == &img))
        );
        let notice = match parts.last().unwrap() {
            ProjectionPart::Text { text } => {
                serde_json::from_str::<serde_json::Value>(text).unwrap()
            }
            other => panic!("expected trailing archive notice, got {other:?}"),
        };
        assert_eq!(notice["kind"], "maka.archived_tool_result");
        assert_eq!(notice["resourceRef"], "archive:evt-mix");
        assert!(
            notice["tailPreview"]
                .as_str()
                .unwrap()
                .contains("after-image-final-line")
        );
        let total_text_len: usize = parts
            .iter()
            .filter_map(|p| match p {
                ProjectionPart::Text { text } => Some(text.len()),
                _ => None,
            })
            .sum();
        assert_eq!(notice["cellStatus"]["state"], "completed");
        assert_eq!(notice["cellStatus"]["cell_id"], "cell-mix");
        assert!(
            total_text_len < 3_500,
            "text should stay bounded, got {total_text_len}"
        );

        // Zero budget on short mixed text+image must leak zero text and preserve image + cellStatus.
        let short_mixed = DurableToolProjection::Content {
            parts: vec![
                ProjectionPart::Text {
                    text: r#"{"state":"completed","cell_id":"cell-mix-0","result":{"ok":true}}"#
                        .into(),
                },
                ProjectionPart::Text {
                    text: format!("MIXED_SECRET_{}", "x".repeat(120)),
                },
                ProjectionPart::Artifact { image: img.clone() },
            ],
        };
        let sm_source = JsonSource::new(SourceBytes::Inline(
            serde_json::to_vec(&short_mixed).unwrap().into(),
        ));
        let sm_streamed = prepare_source_projection(
            "evt-mix-0".into(),
            "call-mix-0".into(),
            "exec".into(),
            sm_source,
            0,
            Arc::new(Budget),
            &stop,
        )
        .await
        .unwrap()
        .expect("mixed zero budget must archive");
        let sm_ext = ArchivedPlaceholder::prepare_projection(
            "evt-mix-0".into(),
            "call-mix-0".into(),
            "exec".into(),
            &short_mixed,
            0,
        )
        .unwrap()
        .expect("external mixed zero budget");
        assert_eq!(sm_streamed, sm_ext);
        let DurableToolProjection::Content { parts: sm_parts } = sm_streamed else {
            panic!("expected Content");
        };
        assert_eq!(
            sm_parts.len(),
            2,
            "expected only [Artifact, Notice], got {sm_parts:?}"
        );
        assert!(matches!(&sm_parts[0], ProjectionPart::Artifact { image } if image == &img));
        let ProjectionPart::Text {
            text: sm_notice_raw,
        } = &sm_parts[1]
        else {
            panic!("expected notice text");
        };
        assert!(!sm_notice_raw.contains("MIXED_SECRET_"));
        let sm_notice: serde_json::Value = serde_json::from_str(sm_notice_raw).unwrap();
        assert_eq!(sm_notice["cellStatus"]["state"], "completed");
        assert_eq!(sm_notice["cellStatus"]["cell_id"], "cell-mix-0");
        assert!(sm_notice.get("tailPreview").is_none());

        // Escaped quotes/backslashes/newlines in mixed tailPreview must respect serialized JSON budget.
        let escaped_line = "\"quoted\" \\path\\to\\file\n";
        let escaped_mixed = DurableToolProjection::Content {
            parts: vec![
                ProjectionPart::Text {
                    text: r#"{"state":"completed","cell_id":"cell-esc"}"#.into(),
                },
                ProjectionPart::Text {
                    text: format!("{}FINAL_ESCAPED_TAIL", escaped_line.repeat(600)),
                },
                ProjectionPart::Artifact { image: img },
            ],
        };
        let esc_out = ArchivedPlaceholder::prepare_projection(
            "evt-esc".into(),
            "call-esc".into(),
            "exec".into(),
            &escaped_mixed,
            4_000,
        )
        .unwrap()
        .expect("escaped mixed must archive");
        let DurableToolProjection::Content { parts: esc_parts } = esc_out else {
            panic!("expected Content");
        };
        let ProjectionPart::Text {
            text: esc_notice_raw,
        } = esc_parts.last().unwrap()
        else {
            panic!("expected notice");
        };
        let esc_notice: serde_json::Value = serde_json::from_str(esc_notice_raw).unwrap();
        let esc_tail = esc_notice["tailPreview"].as_str().expect("tailPreview");
        assert!(esc_tail.contains("FINAL_ESCAPED_TAIL"));
        let serialized_tail_field = crate::read::page::TAIL_PREVIEW_KEY_UTF16
            + crate::read::page::json_string_utf16_len(esc_tail);
        assert!(
            serialized_tail_field <= 1_000,
            "mixed tailPreview serialized JSON cost exceeded 1/4 of 4000 budget: {serialized_tail_field}"
        );
    }
}
