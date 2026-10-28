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

//! Numeric jobs and bounded field reduction; no recursive owned JSON tree.

use super::super::capture_arena::CaptureArena;
use super::{
    FRAME_BYTES, OptionsFootprint, Roots, cancelled, invalid, io as page,
    record::{FIELD_BYTES, Field, NODE_BYTES, Node, SEGMENT_BYTES, SPAN_BYTES, Segment, Span},
    sort::{self, Order},
};
use maka_agent_facts::model::prompt_source::source::{SourceBudget, json::JsonKind};
use std::{io, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(super) struct Compiled {
    pub directory: u64,
    pub pieces: u64,
    pub length: u64,
}
struct Emitter<'a> {
    arena: &'a CaptureArena,
    start: u64,
    count: u64,
    maximum: u64,
    length: u64,
}
impl Emitter<'_> {
    async fn literal(&mut self, token: u8) -> io::Result<()> {
        self.piece(u64::MAX, 0, 1, token).await
    }
    async fn raw(&mut self, span: Span) -> io::Result<()> {
        self.piece(span.source, span.start, span.end, 0).await
    }
    async fn piece(&mut self, source: u64, start: u64, end: u64, literal: u8) -> io::Result<()> {
        if end < start || self.count == self.maximum {
            return Err(invalid());
        }
        self.length = self.length.checked_add(end - start).ok_or_else(invalid)?;
        let offset = self
            .start
            .checked_add(
                self.count
                    .checked_mul(SEGMENT_BYTES as u64)
                    .ok_or_else(invalid)?,
            )
            .ok_or_else(invalid)?;
        page::write(
            self.arena,
            offset,
            Segment {
                end: self.length,
                source,
                start,
                source_end: end,
                literal,
            }
            .encode(),
        )
        .await?;
        self.count += 1;
        Ok(())
    }
}
#[derive(Clone, Copy)]
struct Frame {
    parent: u64,
    state: u8,
    value: Span,
    directory: u64,
    count: u64,
    index: u64,
}
impl Frame {
    fn encode(self) -> [u8; FRAME_BYTES] {
        let mut bytes = [0; FRAME_BYTES];
        put(&mut bytes, 0, self.parent);
        bytes[8] = self.state;
        bytes[16..56].copy_from_slice(&self.value.encode());
        put(&mut bytes, 56, self.directory);
        put(&mut bytes, 64, self.count);
        put(&mut bytes, 72, self.index);
        bytes
    }
    fn decode(bytes: &[u8; FRAME_BYTES]) -> io::Result<Self> {
        Ok(Self {
            parent: get(bytes, 0),
            state: bytes[8],
            value: Span::decode(&bytes[16..56])?,
            directory: get(bytes, 56),
            count: get(bytes, 64),
            index: get(bytes, 72),
        })
    }
}
fn put(bytes: &mut [u8], at: usize, value: u64) {
    bytes[at..at + 8].copy_from_slice(&value.to_le_bytes());
}
fn get(bytes: &[u8], at: usize) -> u64 {
    let mut value = [0; 8];
    value.copy_from_slice(&bytes[at..at + 8]);
    u64::from_le_bytes(value)
}

pub(super) async fn compile(
    arena: &CaptureArena,
    roots: &Roots,
    plan: &OptionsFootprint,
    budget: Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<Compiled> {
    let mut root = None;
    let mut contributors = 0;
    let mut contributor_count = 0u64;
    for root_index in 0..roots.len() {
        cancelled(cancel)?;
        let node =
            Node::decode(&page::read::<NODE_BYTES>(arena, roots.node(root_index).await?).await?)?;
        let previous = root.map(|span: Span| span.kind);
        if node.value.kind == JsonKind::Object {
            if previous != Some(JsonKind::Object) {
                contributors = page::position(arena).await?;
                contributor_count = 0;
            }
            page::append(arena, node.value.encode()).await?;
            contributor_count += 1;
        } else {
            contributor_count = 0;
        }
        root = Some(node.value);
    }
    let value = root.ok_or_else(invalid)?;
    let pieces = page::reserve(
        arena,
        plan.pieces
            .checked_mul(SEGMENT_BYTES as u64)
            .ok_or_else(invalid)?,
        cancel,
    )
    .await?;
    let frames = page::reserve(
        arena,
        plan.nodes
            .checked_mul(FRAME_BYTES as u64)
            .ok_or_else(invalid)?,
        cancel,
    )
    .await?;
    let mut frame_count = 1u64;
    let mut current = 0u64;
    page::write(
        arena,
        frames,
        Frame {
            parent: u64::MAX,
            state: 0,
            value,
            directory: contributors,
            count: contributor_count,
            index: 0,
        }
        .encode(),
    )
    .await?;
    let mut output = Emitter {
        arena,
        start: pieces,
        count: 0,
        maximum: plan.pieces,
        length: 0,
    };
    while current != u64::MAX {
        cancelled(cancel)?;
        let frame_offset = frames
            .checked_add(
                current
                    .checked_mul(FRAME_BYTES as u64)
                    .ok_or_else(invalid)?,
            )
            .ok_or_else(invalid)?;
        let mut frame = Frame::decode(&page::read::<FRAME_BYTES>(arena, frame_offset).await?)?;
        let mut child = None;
        match frame.state {
            0 => match frame.value.kind {
                JsonKind::Object => {
                    let (directory, count) = object(
                        arena,
                        roots,
                        frame.value,
                        frame.directory,
                        frame.count,
                        budget.clone(),
                        cancel,
                    )
                    .await?;
                    frame.state = 1;
                    frame.directory = directory;
                    frame.count = count;
                    frame.index = 0;
                    output.literal(b'{').await?;
                    page::write(arena, frame_offset, frame.encode()).await?;
                }
                JsonKind::Array => {
                    let node =
                        Node::decode(&page::read::<NODE_BYTES>(arena, frame.value.node).await?)?;
                    frame.state = 2;
                    frame.directory = if node.last == node.value.node {
                        u64::MAX
                    } else {
                        node.value
                            .node
                            .checked_add(NODE_BYTES as u64)
                            .ok_or_else(invalid)?
                    };
                    frame.count = node.last;
                    frame.index = 0;
                    output.literal(b'[').await?;
                    page::write(arena, frame_offset, frame.encode()).await?;
                }
                _ => {
                    output.raw(frame.value).await?;
                    current = frame.parent;
                }
            },
            1 => {
                if frame.index == frame.count {
                    output.literal(b'}').await?;
                    current = frame.parent;
                    continue;
                }
                let offset = frame
                    .directory
                    .checked_add(
                        frame
                            .index
                            .checked_mul(FIELD_BYTES as u64)
                            .ok_or_else(invalid)?,
                    )
                    .ok_or_else(invalid)?;
                let field = Field::decode(&page::read::<FIELD_BYTES>(arena, offset).await?)?;
                if frame.index != 0 {
                    output.literal(b',').await?;
                }
                output.raw(field.key).await?;
                output.literal(b':').await?;
                frame.index += 1;
                page::write(arena, frame_offset, frame.encode()).await?;
                child = Some(Frame {
                    parent: current,
                    state: 0,
                    value: field.value,
                    directory: field.children_start,
                    count: field.children_count,
                    index: 0,
                });
            }
            2 => {
                if frame.directory == u64::MAX || frame.directory > frame.count {
                    output.literal(b']').await?;
                    current = frame.parent;
                    continue;
                }
                let node = Node::decode(&page::read::<NODE_BYTES>(arena, frame.directory).await?)?;
                if frame.index != 0 {
                    output.literal(b',').await?;
                }
                frame.directory = node
                    .last
                    .checked_add(NODE_BYTES as u64)
                    .ok_or_else(invalid)?;
                frame.index += 1;
                page::write(arena, frame_offset, frame.encode()).await?;
                child = Some(Frame {
                    parent: current,
                    state: 0,
                    value: node.value,
                    directory: 0,
                    count: 0,
                    index: 0,
                });
            }
            _ => return Err(invalid()),
        }
        if let Some(child) = child {
            if frame_count == plan.nodes {
                return Err(invalid());
            }
            let offset = frames
                .checked_add(
                    frame_count
                        .checked_mul(FRAME_BYTES as u64)
                        .ok_or_else(invalid)?,
                )
                .ok_or_else(invalid)?;
            page::write(arena, offset, child.encode()).await?;
            current = frame_count;
            frame_count += 1;
        }
    }
    Ok(Compiled {
        directory: pieces,
        pieces: output.count,
        length: output.length,
    })
}

async fn object(
    arena: &CaptureArena,
    roots: &Roots,
    single: Span,
    list: u64,
    layers: u64,
    budget: Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<(u64, u64)> {
    let start = page::position(arena).await?;
    let mut writer = page::PageWriter::append(arena, budget.clone()).await?;
    let count_layers = layers.max(1);
    let mut count = 0u64;
    for layer in 0..count_layers {
        cancelled(cancel)?;
        let span = if layers == 0 {
            single
        } else {
            let offset = list
                .checked_add(layer.checked_mul(SPAN_BYTES as u64).ok_or_else(invalid)?)
                .ok_or_else(invalid)?;
            Span::decode(&page::read::<SPAN_BYTES>(arena, offset).await?)?
        };
        let parent = Node::decode(&page::read::<NODE_BYTES>(arena, span.node).await?)?;
        let mut child = parent
            .value
            .node
            .checked_add(NODE_BYTES as u64)
            .ok_or_else(invalid)?;
        while child <= parent.last {
            cancelled(cancel)?;
            let node = Node::decode(&page::read::<NODE_BYTES>(arena, child).await?)?;
            writer
                .push(
                    &Field {
                        digest: node.digest,
                        key: node.key,
                        value: node.value,
                        layer,
                        member: node.member,
                        first_layer: layer,
                        first_member: node.member,
                        children_start: 0,
                        children_count: 0,
                    }
                    .encode(),
                )
                .await?;
            count = count.checked_add(1).ok_or_else(invalid)?;
            child = node
                .last
                .checked_add(NODE_BYTES as u64)
                .ok_or_else(invalid)?;
        }
    }
    if writer.finish().await? != count.checked_mul(FIELD_BYTES as u64).ok_or_else(invalid)? {
        return Err(invalid());
    }
    if count == 0 {
        return Ok((start, 0));
    }
    let bytes = count.checked_mul(FIELD_BYTES as u64).ok_or_else(invalid)?;
    let scratch = page::reserve(arena, bytes, cancel).await?;
    let resolved = page::reserve(arena, bytes, cancel).await?;
    let sorted = sort::sort(
        arena,
        roots,
        start,
        scratch,
        count,
        Order::Key,
        budget.clone(),
        cancel,
    )
    .await?;
    let mut input = page::PageReader::new(
        arena.inspect(page::region(sorted, count, FIELD_BYTES)?),
        budget.clone(),
    )
    .await?;
    let mut output = page::PageWriter::new(arena, resolved, budget.clone()).await?;
    let mut current = input
        .read::<FIELD_BYTES>()
        .await?
        .map(|bytes| Field::decode(&bytes))
        .transpose()?;
    let mut resolved_count = 0u64;
    while let Some(first) = current.take() {
        let mut pending = first;
        let mut result = None;
        loop {
            cancelled(cancel)?;
            let next = input
                .read::<FIELD_BYTES>()
                .await?
                .map(|bytes| Field::decode(&bytes))
                .transpose()?;
            let same = if let Some(next) = &next {
                sort::same_key(roots, &first, next, budget.clone()).await?
            } else {
                false
            };
            if same {
                let next = next.ok_or_else(invalid)?;
                if next.layer == pending.layer {
                    pending.value = next.value;
                    pending.member = next.member;
                } else {
                    apply(arena, &mut result, pending).await?;
                    pending = next;
                }
            } else {
                apply(arena, &mut result, pending).await?;
                output.push(&result.ok_or_else(invalid)?.encode()).await?;
                resolved_count += 1;
                current = next;
                break;
            }
        }
    }
    if output.finish().await?
        != resolved_count
            .checked_mul(FIELD_BYTES as u64)
            .ok_or_else(invalid)?
    {
        return Err(invalid());
    }
    let ordered = sort::sort(
        arena,
        roots,
        resolved,
        scratch,
        resolved_count,
        Order::Insertion,
        budget,
        cancel,
    )
    .await?;
    Ok((ordered, resolved_count))
}
async fn apply(arena: &CaptureArena, result: &mut Option<Field>, next: Field) -> io::Result<()> {
    let previous_object = result
        .as_ref()
        .is_some_and(|value| value.value.kind == JsonKind::Object);
    let mut value = result.unwrap_or(next);
    if next.value.kind == JsonKind::Object {
        if !previous_object || value.children_count == 0 {
            value.children_start = page::position(arena).await?;
            value.children_count = 0;
        }
        page::append(arena, next.value.encode()).await?;
        value.children_count = value.children_count.checked_add(1).ok_or_else(invalid)?;
    } else {
        value.children_count = 0;
    }
    value.value = next.value;
    value.layer = next.layer;
    value.member = next.member;
    *result = Some(value);
    Ok(())
}
