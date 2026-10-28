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

//! Preorder structure records let every original subtree be read exactly once.

use super::super::capture_arena::CaptureArena;
use super::{
    cancelled, invalid, io as page,
    record::{NODE_BYTES, Node, Span},
};
use maka_agent_facts::model::prompt_source::source::{
    JsonSource, SourceBudget, TextEncoding, TextSource,
    json::{self, JsonKind, JsonStructureEvent, StructureCursor},
};
use std::{io, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(super) async fn input(
    arena: &CaptureArena,
    source_id: u64,
    source: &JsonSource,
    budget: Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<u64> {
    input_at(arena, source_id, source, 0, budget, cancel).await
}

pub(super) async fn input_at(
    arena: &CaptureArena,
    source_id: u64,
    source: &JsonSource,
    base_offset: u64,
    budget: Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<u64> {
    let base = page::position(arena).await?;
    let mut cursor = StructureCursor::open(source.clone(), budget.clone()).await?;
    let mut last = base;
    let mut seen = false;
    while let Some(event) = cursor.next().await? {
        cancelled(cancel)?;
        match event {
            JsonStructureEvent::Value(value) => {
                let offset = base
                    .checked_add(
                        value
                            .ordinal
                            .checked_mul(NODE_BYTES as u64)
                            .ok_or_else(invalid)?,
                    )
                    .ok_or_else(invalid)?;
                let key_range = value.key_range.unwrap_or(0..0);
                let key = Span {
                    source: source_id,
                    start: base_offset
                        .checked_add(key_range.start)
                        .ok_or_else(invalid)?,
                    end: base_offset.checked_add(key_range.end).ok_or_else(invalid)?,
                    kind: JsonKind::String,
                    node: u64::MAX,
                };
                let digest = if key.start != key.end {
                    json::text_digest(
                        &TextSource {
                            bytes: source.bytes.slice(key_range)?,
                            encoding: TextEncoding::JsonString,
                        },
                        budget.clone(),
                    )
                    .await?
                } else {
                    [0; 32]
                };
                let node = Node {
                    value: Span {
                        source: source_id,
                        start: base_offset.checked_add(value.start).ok_or_else(invalid)?,
                        end: base_offset
                            .checked_add(value.end.unwrap_or(value.start))
                            .ok_or_else(invalid)?,
                        kind: value.kind,
                        node: offset,
                    },
                    key,
                    last: offset,
                    member: value.member,
                    digest,
                };
                arena
                    .with_writer(move |writer| {
                        if writer.position() != offset {
                            return Err(invalid());
                        }
                        writer.append_bytes(&node.encode())?;
                        Ok(())
                    })
                    .await?;
                last = offset;
                seen = true;
            }
            JsonStructureEvent::End { ordinal, end } => {
                let offset = base
                    .checked_add(ordinal.checked_mul(NODE_BYTES as u64).ok_or_else(invalid)?)
                    .ok_or_else(invalid)?;
                let mut node = Node::decode(&page::read::<NODE_BYTES>(arena, offset).await?)?;
                node.value.end = base_offset.checked_add(end).ok_or_else(invalid)?;
                node.last = last;
                page::write(arena, offset, node.encode()).await?;
            }
        }
    }
    if !seen {
        return Err(invalid());
    }
    Ok(base)
}
