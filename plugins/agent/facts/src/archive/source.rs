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
    ArchiveIdentity, ArchivedPlaceholder, CanonicalHeader, CanonicalPlaceholder, PruneReason,
    canonical_header, canonical_resource_header, identity_string, projection_identity_source,
    projection_source,
};
use crate::{
    history::HistoryRowAddress,
    model::prompt_source::source::{
        ByteSource, JsonSource, SourceBudget,
        json::{self, ArrayCursor},
    },
    read::{self, MAX_PAGE_CHARS, ReadInput, ReadPage},
    tool_output::DurableToolProjection,
};
use sha2::{Digest, Sha256};
use std::{io, sync::Arc};
use tokio_util::sync::CancellationToken;

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
                if chars <= MAX_PAGE_CHARS as u64 {
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
                let page = first_page(&header, projection, budget, cancellation).await?;
                let placeholder = Self {
                    identity,
                    original_estimated_tokens: chars.div_ceil(4),
                    reason: PruneReason::ToolResultPruned,
                    page,
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

/// Format an original Imported tool result; the address is not read authority.
pub async fn prepare_imported_source(
    address: &HistoryRowAddress,
    call_id: String,
    tool_name: String,
    projection: JsonSource,
    budget: Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<Option<DurableToolProjection>> {
    cancel
        .run_until_cancelled(async {
            address.validate().map_err(invalid)?;
            if !matches!(address, HistoryRowAddress::Imported { .. }) {
                return Err(invalid(
                    "imported archive requires an Imported history address",
                ));
            }
            if !identity_string(&call_id) || !identity_string(&tool_name) {
                return Err(invalid("invalid imported tool result identity"));
            }
            if excluded(&projection, budget.clone()).await? {
                return Ok(None);
            }
            let mut count = CountBytes(0);
            serde_json::to_writer(&mut count, address).map_err(io::Error::other)?;
            if count.0 >= MAX_PAGE_CHARS {
                // Base64 cannot shrink this descriptor into the model page budget.
                // The address remains valid for Read; keep the original projection.
                return Ok(None);
            }
            let resource_ref = read::imported_tool_result_path(address).map_err(invalid)?;
            if resource_ref.encode_utf16().count() >= MAX_PAGE_CHARS {
                return Ok(None);
            }
            let mut original_bytes = 0u64;
            let mut chars = 0u64;
            scan_source(
                projection_source(projection.clone()),
                budget.clone(),
                |bytes| record_size(bytes, &mut original_bytes, &mut chars),
            )
            .await?;
            if chars <= MAX_PAGE_CHARS as u64 {
                return Ok(None);
            }
            if !(1..=9_007_199_254_740_991).contains(&original_bytes) {
                return Err(invalid("invalid archive byte count"));
            }
            let header = canonical_resource_header(&tool_name, resource_ref, original_bytes);
            let page = first_page(&header, projection, budget, cancel).await?;
            let value = serde_json::to_value(CanonicalPlaceholder {
                header,
                page: &page,
            })
            .map_err(io::Error::other)?;
            if serde_json::to_string(&value)
                .map_err(io::Error::other)?
                .encode_utf16()
                .count()
                > MAX_PAGE_CHARS
            {
                return Ok(None);
            }
            Ok(Some(DurableToolProjection::Json { value }))
        })
        .await
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::Interrupted, "archive preparation cancelled")
        })?
}

async fn first_page(
    header: &CanonicalHeader<'_>,
    projection: JsonSource,
    budget: Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<ReadPage> {
    let overhead = serde_json::to_string(header)
        .map_err(io::Error::other)?
        .encode_utf16()
        .count()
        + 8;
    let request = ReadInput {
        path: header.resource_ref.clone(),
        offset: None,
        limit: None,
    }
    .resolve()
    .map_err(io::Error::other)?;
    read::projection_page(
        projection,
        header.tool_name,
        &request,
        MAX_PAGE_CHARS.saturating_sub(overhead).max(1),
        budget,
        cancel,
    )
    .await
}

struct CountBytes(usize);
impl io::Write for CountBytes {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len())
            .ok_or_else(|| invalid("history resource address size overflow"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn record_size(bytes: &[u8], original_bytes: &mut u64, chars: &mut u64) -> io::Result<()> {
    *original_bytes = original_bytes
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| invalid("archive byte count overflow"))?;
    // The canonical encoder emits valid UTF-8. Count leading bytes only, so
    // split scalars need no retained input tail.
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
        if let Some(kind) = json::field(&value.source, &["kind"], budget.clone()).await? {
            if kind.kind == json::JsonKind::String {
                return json::text_eq(&kind.text()?, "maka.archived_tool_result", budget).await;
            }
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
