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

//! Request-local recursive options overlay over indexed canonical spans.

mod build;
mod index;
mod io;
mod record;
mod registry;
mod rope;
mod sort;

use super::capture_arena::CaptureArena;
use maka_agent_facts::model::prompt_source::source::{
    JsonSource, SourceBudget, SourceBytes, TextEncoding, TextSource,
    json::{self, JsonCounts},
};
use maka_event_log::context::semantic::{CapturedSource, PayloadSource};
use record::{FIELD_BYTES, NODE_BYTES, SEGMENT_BYTES, SPAN_BYTES, Span};
use registry::{RootBuilder, RootMode, Roots};
use std::{io as stdio, mem, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(super) const FRAME_BYTES: usize = 80;
#[derive(Clone, Debug)]
pub(super) struct OptionsFootprint {
    pub metadata_bytes: usize,
    pub backing_bytes: u64,
    pub roots: usize,
    pub pieces: u64,
    pub nodes: u64,
    pub input_bytes: u64,
    pub roots_metadata_bytes: usize,
    storage: RootMode,
}
struct Root {
    source: JsonSource,
    node: u64,
}

pub(super) async fn text_options_footprint(
    captured: &CapturedSource,
    payload: &PayloadSource,
    budget: Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> stdio::Result<OptionsFootprint> {
    let mut after = None;
    let mut roots = 0usize;
    let mut metadata_bytes = 0usize;
    let mut counts = JsonCounts::default();
    let mut input_bytes = 0u64;
    while let Some((key, fragment)) = captured
        .next_text_fragment(payload, after)
        .await
        .map_err(stdio::Error::other)?
    {
        cancelled(cancel)?;
        after = Some(key);
        let Some(source) = option(captured, &fragment, budget.clone()).await? else {
            continue;
        };
        input_bytes = input_bytes
            .checked_add(source.bytes.len().ok_or_else(invalid)?)
            .ok_or_else(invalid)?;
        roots = roots.checked_add(1).ok_or_else(invalid)?;
        metadata_bytes = metadata_bytes
            .checked_add(mem::size_of::<Root>())
            .ok_or_else(invalid)?;
        if let SourceBytes::Source(value) = &source.bytes {
            metadata_bytes = metadata_bytes
                .checked_add(arc_bytes(
                    mem::size_of_val(value.as_ref()),
                    mem::align_of_val(value.as_ref()),
                )?)
                .ok_or_else(invalid)?;
        }
        let next = json::measure(&source, budget.clone()).await?;
        for (target, next) in [
            (&mut counts.objects, next.objects),
            (&mut counts.arrays, next.arrays),
            (&mut counts.members, next.members),
            (&mut counts.elements, next.elements),
            (&mut counts.leaves, next.leaves),
        ] {
            *target = target.checked_add(next).ok_or_else(invalid)?;
        }
    }
    footprint(roots, metadata_bytes, counts, input_bytes)
}

fn footprint(
    roots: usize,
    mut metadata_bytes: usize,
    counts: JsonCounts,
    input_bytes: u64,
) -> stdio::Result<OptionsFootprint> {
    let nodes = counts
        .objects
        .checked_add(counts.arrays)
        .and_then(|n| n.checked_add(counts.leaves))
        .ok_or_else(invalid)?;
    let pieces = counts
        .objects
        .checked_add(counts.arrays)
        .and_then(|n| n.checked_mul(2))
        .and_then(|n| counts.members.checked_mul(3).and_then(|m| n.checked_add(m)))
        .and_then(|n| n.checked_add(counts.elements))
        .and_then(|n| n.checked_add(counts.leaves))
        .ok_or_else(invalid)?;
    let backing_bytes = nodes
        .checked_mul((NODE_BYTES + FRAME_BYTES) as u64)
        .and_then(|n| {
            counts
                .members
                .checked_mul((3 * FIELD_BYTES + SPAN_BYTES) as u64)
                .and_then(|m| n.checked_add(m))
        })
        .and_then(|n| {
            (roots as u64)
                .checked_mul(SPAN_BYTES as u64)
                .and_then(|m| n.checked_add(m))
        })
        .and_then(|n| {
            pieces
                .checked_mul(SEGMENT_BYTES as u64)
                .and_then(|m| n.checked_add(m))
        })
        .ok_or_else(invalid)?;
    let roots_metadata_bytes = metadata_bytes;
    if roots != 0 {
        metadata_bytes = metadata_bytes
            .checked_add(rope::metadata_bytes()?)
            .ok_or_else(invalid)?;
    }
    Ok(OptionsFootprint {
        metadata_bytes,
        backing_bytes,
        roots,
        pieces,
        nodes,
        input_bytes,
        roots_metadata_bytes,
        storage: RootMode::Resident,
    })
}
impl OptionsFootprint {
    /// Selected only when this request's root directory intrinsically exceeds
    /// resident admission, never because another request currently owns bytes.
    pub(super) fn spilled(&self) -> stdio::Result<Self> {
        if self.storage == RootMode::Arena {
            return Ok(self.clone());
        }
        let mut plan = self.clone();
        plan.storage = RootMode::Arena;
        let range_metadata = super::capture_arena::source_metadata_bytes(1)?;
        plan.metadata_bytes = rope::metadata_bytes()?
            .checked_add(super::joined_source::metadata_bytes(1)?)
            .and_then(|bytes| bytes.checked_add(range_metadata))
            .ok_or_else(invalid)?;
        let output = self
            .input_bytes
            .checked_add(self.pieces)
            .ok_or_else(invalid)?;
        plan.backing_bytes = plan
            .backing_bytes
            .checked_add((self.roots as u64).checked_mul(8).ok_or_else(invalid)?)
            .and_then(|bytes| bytes.checked_add(self.input_bytes))
            .and_then(|bytes| bytes.checked_add(output))
            .ok_or_else(invalid)?;
        plan.roots_metadata_bytes = 0;
        Ok(plan)
    }
}

pub(super) async fn text_options(
    captured: &CapturedSource,
    payload: &PayloadSource,
    plan: &OptionsFootprint,
    arena: &CaptureArena,
    budget: Arc<dyn SourceBudget>,
    owner: Arc<dyn Send + Sync>,
    cancel: &CancellationToken,
) -> stdio::Result<Option<JsonSource>> {
    if plan.roots == 0 {
        return Ok(None);
    }
    let mut builder = RootBuilder::new(plan, arena, cancel).await?;
    let mut after = None;
    while let Some((key, fragment)) = captured
        .next_text_fragment(payload, after)
        .await
        .map_err(stdio::Error::other)?
    {
        cancelled(cancel)?;
        after = Some(key);
        let Some(source) = option(captured, &fragment, budget.clone()).await? else {
            continue;
        };
        builder.push(source, budget.clone(), cancel).await?;
    }
    finish_roots(builder.finish()?, plan, arena, budget, owner, cancel)
        .await
        .map(Some)
}

async fn finish_roots(
    roots: Roots,
    plan: &OptionsFootprint,
    arena: &CaptureArena,
    budget: Arc<dyn SourceBudget>,
    owner: Arc<dyn Send + Sync>,
    cancel: &CancellationToken,
) -> stdio::Result<JsonSource> {
    let compiled = build::compile(arena, &roots, plan, budget.clone(), cancel).await?;
    let source = rope::source(arena.clone(), roots, compiled, owner.clone())?;
    if plan.storage == RootMode::Arena {
        let range = arena.append(source, budget, cancel).await?;
        let source = super::joined_source::join(vec![arena.inspect(range)], owner)?;
        Ok(JsonSource { bytes: source })
    } else {
        Ok(JsonSource { bytes: source })
    }
}

async fn option(
    captured: &CapturedSource,
    payload: &PayloadSource,
    budget: Arc<dyn SourceBudget>,
) -> stdio::Result<Option<JsonSource>> {
    let source = JsonSource {
        bytes: SourceBytes::Source(captured.byte_source(payload).map_err(stdio::Error::other)?),
    };
    let delta = json::field(&source, &["TextDelta"], budget.clone())
        .await?
        .filter(|value| value.kind == json::JsonKind::Object)
        .ok_or_else(invalid)?;
    Ok(json::field(&delta.source, &["provider_options"], budget)
        .await?
        .filter(|value| value.kind != json::JsonKind::Null)
        .map(|value| value.source))
}
fn raw(roots: &Roots, span: Span) -> stdio::Result<JsonSource> {
    roots.raw(span)
}
fn key_text(roots: &Roots, span: Span) -> stdio::Result<TextSource> {
    Ok(TextSource {
        bytes: raw(roots, span)?.bytes,
        encoding: TextEncoding::JsonString,
    })
}
fn arc_bytes(size: usize, alignment: usize) -> stdio::Result<usize> {
    let value =
        std::alloc::Layout::from_size_align(size, alignment).map_err(stdio::Error::other)?;
    let (layout, _) = std::alloc::Layout::new::<[usize; 2]>()
        .extend(value)
        .map_err(stdio::Error::other)?;
    Ok(layout.pad_to_align().size())
}
fn cancelled(cancel: &CancellationToken) -> stdio::Result<()> {
    if cancel.is_cancelled() {
        return Err(stdio::Error::new(
            stdio::ErrorKind::Interrupted,
            "options overlay cancelled",
        ));
    }
    Ok(())
}
fn invalid() -> stdio::Error {
    stdio::Error::new(
        stdio::ErrorKind::InvalidData,
        "invalid request options overlay directory",
    )
}

#[cfg(test)]
mod tests;
