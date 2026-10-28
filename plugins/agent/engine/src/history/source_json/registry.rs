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

//! Ordinary roots retain capabilities; oversized roots become numeric arena spans.

use super::super::capture_arena::CaptureArena;
use super::{
    OptionsFootprint, Root, index, invalid, io as page,
    record::{NODE_BYTES, Node, Span},
};
use maka_agent_facts::model::prompt_source::source::{JsonSource, SourceBudget, SourceBytes};
use std::{io, ops::Range, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(super) const ARENA_SOURCE: u64 = u64::MAX - 1;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RootMode {
    Resident,
    Arena,
}
pub(super) enum Roots {
    Resident(Box<[Root]>),
    Arena {
        arena: CaptureArena,
        table: u64,
        count: usize,
    },
}
impl Roots {
    pub fn len(&self) -> usize {
        match self {
            Self::Resident(roots) => roots.len(),
            Self::Arena { count, .. } => *count,
        }
    }
    pub async fn node(&self, index: usize) -> io::Result<u64> {
        match self {
            Self::Resident(roots) => roots.get(index).map(|root| root.node).ok_or_else(invalid),
            Self::Arena {
                arena,
                table,
                count,
            } => {
                if index >= *count {
                    return Err(invalid());
                }
                let at = table
                    .checked_add((index as u64).checked_mul(8).ok_or_else(invalid)?)
                    .ok_or_else(invalid)?;
                Ok(u64::from_le_bytes(page::read::<8>(arena, at).await?))
            }
        }
    }
    pub fn raw(&self, span: Span) -> io::Result<JsonSource> {
        Ok(JsonSource {
            bytes: self.raw_bytes(span.source, span.range())?,
        })
    }
    pub fn raw_bytes(&self, source: u64, range: Range<u64>) -> io::Result<SourceBytes> {
        match self {
            Self::Resident(roots) => roots
                .get(usize::try_from(source).map_err(|_| invalid())?)
                .ok_or_else(invalid)?
                .source
                .bytes
                .slice(range),
            Self::Arena { arena, .. } => {
                if source != ARENA_SOURCE {
                    return Err(invalid());
                }
                Ok(arena.inspect(range))
            }
        }
    }
}
pub(super) struct RootBuilder {
    arena: CaptureArena,
    mode: RootMode,
    roots: Vec<Root>,
    table: u64,
    count: usize,
    nodes: u64,
    bytes: u64,
    expected_roots: usize,
    expected_nodes: u64,
    expected_bytes: u64,
}
impl RootBuilder {
    pub async fn new(
        plan: &OptionsFootprint,
        arena: &CaptureArena,
        cancel: &CancellationToken,
    ) -> io::Result<Self> {
        let mut roots = Vec::new();
        let table = if plan.storage == RootMode::Resident {
            roots
                .try_reserve_exact(plan.roots)
                .map_err(io::Error::other)?;
            if roots.capacity() != plan.roots {
                return Err(invalid());
            }
            0
        } else {
            page::reserve(
                arena,
                (plan.roots as u64).checked_mul(8).ok_or_else(invalid)?,
                cancel,
            )
            .await?
        };
        Ok(Self {
            arena: arena.clone(),
            mode: plan.storage,
            roots,
            table,
            count: 0,
            nodes: 0,
            bytes: 0,
            expected_roots: plan.roots,
            expected_nodes: plan.nodes,
            expected_bytes: plan.input_bytes,
        })
    }
    pub async fn push(
        &mut self,
        source: JsonSource,
        budget: Arc<dyn SourceBudget>,
        cancel: &CancellationToken,
    ) -> io::Result<u64> {
        if self.count == self.expected_roots {
            return Err(invalid());
        }
        let length = source.bytes.len().ok_or_else(invalid)?;
        let node = match self.mode {
            RootMode::Resident => {
                let node =
                    index::input(&self.arena, self.count as u64, &source, budget, cancel).await?;
                self.roots.push(Root { source, node });
                node
            }
            RootMode::Arena => {
                let range = self
                    .arena
                    .append(source.bytes, budget.clone(), cancel)
                    .await?;
                if range.end - range.start != length {
                    return Err(invalid());
                }
                let source = JsonSource {
                    bytes: self.arena.inspect(range.clone()),
                };
                let node = index::input_at(
                    &self.arena,
                    ARENA_SOURCE,
                    &source,
                    range.start,
                    budget,
                    cancel,
                )
                .await?;
                page::write(
                    &self.arena,
                    self.table
                        .checked_add((self.count as u64).checked_mul(8).ok_or_else(invalid)?)
                        .ok_or_else(invalid)?,
                    node.to_le_bytes(),
                )
                .await?;
                node
            }
        };
        let last = Node::decode(&page::read::<NODE_BYTES>(&self.arena, node).await?)?.last;
        let nodes = last
            .checked_sub(node)
            .filter(|bytes| bytes % NODE_BYTES as u64 == 0)
            .ok_or_else(invalid)?
            / (NODE_BYTES as u64)
            + 1;
        self.nodes = self.nodes.checked_add(nodes).ok_or_else(invalid)?;
        self.bytes = self.bytes.checked_add(length).ok_or_else(invalid)?;
        self.count += 1;
        Ok(node)
    }
    #[cfg(test)]
    pub fn resident_roots(&self) -> usize {
        self.roots.capacity()
    }
    pub fn finish(self) -> io::Result<Roots> {
        if self.count != self.expected_roots
            || self.nodes != self.expected_nodes
            || self.bytes != self.expected_bytes
        {
            return Err(invalid());
        }
        Ok(match self.mode {
            RootMode::Resident => Roots::Resident(self.roots.into_boxed_slice()),
            RootMode::Arena => Roots::Arena {
                arena: self.arena,
                table: self.table,
                count: self.count,
            },
        })
    }
}
