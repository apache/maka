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

//! Provider item bytes and direct numeric indexes in the source's existing arena.

use crate::history::capture_arena::{ArenaAppend, CaptureArena};
use bytes::Bytes;
use maka_agent_facts::model::prompt_source::{self as wire, source::*};
use maka_model::{
    DirectoryLease, ModelError, ModelPreparationResources, WirePlan, WireSink, WireWrite,
};
use maka_provider_protocol::anthropic::{
    CacheDirective, CacheSite, CacheTtl,
    prompt::{Caller, prepared as ap},
};
use std::{io, io::Write, ops::Range, sync::Arc};

const RECORD_BYTES: u64 = 256;
// Match the existing arena copy and backed upload quantum.
const BODY_BUFFER_BYTES: usize = 32 * 1024;
type Record = [u64; 32];
type Part = ap::PartMetadata<IdentifiedText, ap::FrozenCacheCandidate>;

fn error(error: impl std::fmt::Display) -> ModelError {
    ModelError::Adapter(error.to_string())
}
fn invalid(reason: &'static str) -> ModelError {
    error(reason)
}
fn index(base: u64, ordinal: usize, width: u64) -> Result<u64, ModelError> {
    base.checked_add(
        (ordinal as u64)
            .checked_mul(width)
            .ok_or_else(|| invalid("wire index overflows"))?,
    )
    .ok_or_else(|| invalid("wire index overflows"))
}
fn digest_words(words: &mut [u64], digest: [u8; 32]) {
    for (word, bytes) in words.iter_mut().zip(digest.as_chunks::<8>().0.iter()) {
        *word = u64::from_le_bytes(*bytes);
    }
}
fn digest_bytes(words: &[u64]) -> [u8; 32] {
    let mut digest = [0; 32];
    for (bytes, word) in digest.as_chunks_mut::<8>().0.iter_mut().zip(words) {
        bytes.copy_from_slice(&word.to_le_bytes());
    }
    digest
}
fn encode_record(record: Record) -> [u8; RECORD_BYTES as usize] {
    let mut bytes = [0; RECORD_BYTES as usize];
    for (chunk, word) in bytes.as_chunks_mut::<8>().0.iter_mut().zip(record) {
        chunk.copy_from_slice(&word.to_le_bytes());
    }
    bytes
}
async fn read_record(custody: &Arc<Custody>, offset: u64) -> Result<Record, ModelError> {
    let bytes = custody
        .arena
        .read_control_owned::<{ RECORD_BYTES as usize }>(offset, custody.clone())
        .await
        .map_err(error)?;
    let mut record = [0; 32];
    for (word, bytes) in record.iter_mut().zip(bytes.as_chunks::<8>().0.iter()) {
        *word = u64::from_le_bytes(*bytes);
    }
    Ok(record)
}

struct Tables {
    messages: u64,
    items: u64,
    documents: u64,
    identities: u64,
}
struct OpenItem {
    message: usize,
    body_start: u64,
    metadata_tag: u64,
    metadata: u64,
    buffer: Option<ChargedBuffer>,
    filled: usize,
}
struct Builder {
    arena: CaptureArena,
    custody: Arc<Custody>,
    append: ArenaAppend,
    body_buffer_bytes: usize,
    tables: Tables,
    item: Option<OpenItem>,
    item_count: usize,
    message_count: usize,
    message_start: usize,
    document_count: usize,
    identity_count: usize,
    expected_messages: usize,
    expected_items: usize,
    expected_documents: usize,
    expected_identities: usize,
}

/// Constant resident header allowance; item, prefix, document and identity tables live on disk.
pub(super) fn resident_bytes() -> usize {
    std::mem::size_of::<Directory>()
        + std::mem::size_of::<Custody>()
        + std::mem::size_of::<Identities>()
        + std::mem::size_of::<SharedDirectory>()
        + 8 * std::mem::size_of::<usize>()
}

/// The caller selected backing because the complete request itself exceeds resident policy.
pub(super) async fn build(
    plan: &WirePlan,
    logical: Arc<dyn MessageSource>,
    arena: CaptureArena,
    lease: DirectoryLease,
    resources: ModelPreparationResources,
) -> Result<maka_model::FrozenWire, ModelError> {
    if lease.capacity() < resident_bytes() {
        return Err(invalid("backed wire header exceeds its prepaid envelope"));
    }
    let custody = Arc::new(Custody {
        arena: arena.clone(),
        _lease: lease,
    });
    let append = arena.begin_append().await;
    let messages = plan.message_count();
    let items = plan.item_count();
    let documents = plan.document_count();
    let identities = plan.source_identity_count();
    let table_custody = custody.clone();
    let tables = append
        .with_writer(move |builder| {
            let _custody = table_custody;
            let mut reserve = |count: usize, width: u64| {
                let bytes = (count as u64)
                    .checked_mul(width)
                    .ok_or_else(|| io::Error::other("wire table size overflows"))?;
                Ok::<_, io::Error>(builder.reserve_zeroed(bytes)?.start)
            };
            Ok(Tables {
                messages: reserve(messages, RECORD_BYTES)?,
                items: reserve(items, RECORD_BYTES)?,
                documents: reserve(documents, 8)?,
                identities: reserve(identities, 32)?,
            })
        })
        .await
        .map_err(error)?;
    let policy = resources.policy();
    let body_buffer_bytes = BODY_BUFFER_BYTES.min(policy.progress_bytes - policy.work_bytes);
    let mut builder = Builder {
        arena: arena.clone(),
        custody: custody.clone(),
        append,
        body_buffer_bytes,
        tables,
        item: None,
        item_count: 0,
        message_count: 0,
        message_start: 0,
        document_count: 0,
        identity_count: 0,
        expected_messages: messages,
        expected_items: items,
        expected_documents: documents,
        expected_identities: identities,
    };
    let encoded = plan.encode_to(&mut builder, resources.clone()).await?;
    if builder.item.is_some()
        || builder.item_count != items
        || builder.message_count != messages
        || builder.document_count != documents
        || builder.identity_count != identities
    {
        return Err(invalid("backed wire shape differs from its counted plan"));
    }
    builder.sort_identities().await?;
    let tables = builder.tables;
    drop(builder.append);
    arena.seal().await.map_err(error)?;
    let identities = Arc::new(Identities {
        custody: custody.clone(),
        table: tables.identities,
        count: identities,
    });
    Ok(maka_model::FrozenWire {
        source: Arc::new(SharedDirectory(Arc::new(Directory {
            custody,
            tables,
            logical,
            resources,
            messages,
            items,
            documents,
            initial_prefix: plan.initial_prefix(),
            identities,
        }))),
        identity: encoded.identity,
    })
}

impl Builder {
    async fn flush_body(&mut self) -> Result<(), ModelError> {
        let item = self.item.as_mut().expect("body flush has an open item");
        if item.filled == 0 {
            return Ok(());
        }
        let buffer = item.buffer.take().expect("open body owns its buffer");
        let count = item.filled;
        let buffer = self
            .write(move |builder| {
                builder.write_all(&buffer.as_ref()[..count])?;
                Ok(buffer)
            })
            .await
            .map_err(error)?;
        let item = self.item.as_mut().expect("body flush retains its item");
        item.buffer = Some(buffer);
        item.filled = 0;
        Ok(())
    }

    async fn body(&mut self, bytes: Bytes) -> Result<(), ModelError> {
        if self.body_buffer_bytes == 0 {
            return self
                .write(move |builder| builder.write_all(&bytes))
                .await
                .map_err(error);
        }
        let mut remaining = bytes.as_ref();
        while !remaining.is_empty() {
            let item = self.item.as_mut().expect("body write has an open item");
            let buffer = item.buffer.as_mut().expect("open body owns its buffer");
            let count = remaining.len().min(buffer.as_ref().len() - item.filled);
            buffer.as_mut()[item.filled..item.filled + count].copy_from_slice(&remaining[..count]);
            item.filled += count;
            remaining = &remaining[count..];
            if item.filled == buffer.as_ref().len() {
                self.flush_body().await?;
            }
        }
        Ok(())
    }

    async fn write<T: Send + 'static>(
        &self,
        write: impl FnOnce(&mut crate::history::request_backing::RequestBackingBuilder) -> io::Result<T>
        + Send
        + 'static,
    ) -> io::Result<T> {
        let custody = self.custody.clone();
        self.append
            .with_writer(move |builder| {
                let _custody = custody;
                write(builder)
            })
            .await
    }
    async fn position(&self) -> Result<u64, ModelError> {
        self.write(|builder| Ok(builder.position()))
            .await
            .map_err(error)
    }
    async fn record(&self, record: Record) -> Result<u64, ModelError> {
        self.write(move |builder| Ok(builder.append_bytes(&encode_record(record))?.start))
            .await
            .map_err(error)
    }
    async fn put(&self, offset: u64, record: Record) -> Result<(), ModelError> {
        self.write(move |builder| builder.write_at(offset, &encode_record(record)))
            .await
            .map_err(error)
    }
    async fn put_u64(&self, offset: u64, value: u64) -> Result<(), ModelError> {
        self.write(move |builder| builder.write_at(offset, &value.to_le_bytes()))
            .await
            .map_err(error)
    }
    async fn raw(&self, bytes: Vec<u8>) -> Result<Range<u64>, ModelError> {
        self.write(move |builder| builder.append_bytes(&bytes))
            .await
            .map_err(error)
    }
    async fn text(
        &self,
        text: &IdentifiedText,
        budget: Arc<dyn SourceBudget>,
    ) -> Result<u64, ModelError> {
        let source = text::bytes(text.text.clone(), budget.clone());
        let mut cursor = source.open(budget.clone());
        let start = self.position().await?;
        let mut buffer = budget
            .allocate(32 * 1024)
            .await
            .map_err(error)?
            .retain_owner(self.custody.clone());
        loop {
            let read = cursor.read_chunk(buffer).await.map_err(error)?;
            let used = read.bytes_read;
            let eof = read.eof;
            buffer = self
                .write(move |builder| {
                    builder.write_all(&read.buffer.as_ref()[..used])?;
                    Ok(read.buffer)
                })
                .await
                .map_err(error)?;
            if eof {
                break;
            }
            if used == 0 {
                return Err(invalid("wire metadata text made no progress"));
            }
        }
        let mut record = [0; 32];
        record[0] = start;
        record[1] = self.position().await?;
        digest_words(&mut record[2..6], text.identity);
        self.record(record).await
    }
    async fn optional_text(
        &self,
        text: Option<&IdentifiedText>,
        budget: Arc<dyn SourceBudget>,
    ) -> Result<u64, ModelError> {
        match text {
            Some(text) => self.text(text, budget).await.map(|offset| offset + 1),
            None => Ok(0),
        }
    }
    async fn strings(&self, strings: &[String]) -> Result<u64, ModelError> {
        let count = strings.len();
        let table = self
            .write(move |builder| {
                Ok(builder
                    .reserve_zeroed(
                        (count as u64)
                            .checked_mul(16)
                            .ok_or_else(|| io::Error::other("wire string index overflows"))?,
                    )?
                    .start)
            })
            .await
            .map_err(error)?;
        for (ordinal, string) in strings.iter().enumerate() {
            let range = self.raw(string.as_bytes().to_vec()).await?;
            let offset = index(table, ordinal, 16)?;
            self.write(move |builder| {
                builder.write_at(offset, &range.start.to_le_bytes())?;
                builder.write_at(offset + 8, &(range.end - range.start).to_le_bytes())
            })
            .await
            .map_err(error)?;
        }
        let mut record = [0; 32];
        record[0] = table;
        record[1] = count as u64;
        self.record(record).await
    }
    async fn slot(&self, slot: Option<&ap::FieldSlot>) -> Result<u64, ModelError> {
        let Some(slot) = slot else {
            return Ok(0);
        };
        let mut record = [0; 32];
        record[0] = slot.offset;
        record[1] = u64::from(slot.comma_before) | (u64::from(slot.comma_after) << 1);
        self.record(record).await.map(|offset| offset + 1)
    }
    async fn metadata(
        &self,
        metadata: &Part,
        budget: Arc<dyn SourceBudget>,
    ) -> Result<u64, ModelError> {
        let mut record = [0; 32];
        record[0] = match metadata.message.role {
            ap::MessageRole::System => 0,
            ap::MessageRole::User => 1,
            ap::MessageRole::Assistant => 2,
        };
        if let Some(system) = &metadata.message.system {
            record[1] = 1 | (u64::from(system.text_block) << 1);
            record[2] = system.changes as u64;
            record[3] = match system.clear_at {
                None => 0,
                Some(ap::ClearAt::NextUserMessage) => 1,
            };
            record[4] = match system.effort {
                None => 0,
                Some(ap::Effort::Low) => 1,
                Some(ap::Effort::Medium) => 2,
                Some(ap::Effort::High) => 3,
                Some(ap::Effort::Xhigh) => 4,
                Some(ap::Effort::Max) => 5,
            };
        }
        record[5] = metadata.message.part_count as u64;
        record[6] = metadata.part_index as u64;
        record[7] = u64::from(metadata.emitted)
            | (u64::from(metadata.local_tool) << 1)
            | (u64::from(metadata.boundary) << 2)
            | (u64::from(metadata.system_text) << 3)
            | (u64::from(metadata.message.user_content) << 4);
        let candidates = metadata.cache.candidates();
        let count = candidates.len();
        let table = self
            .write(move |builder| Ok(builder.reserve_zeroed((count as u64) * 8)?.start))
            .await
            .map_err(error)?;
        for (ordinal, candidate) in candidates.iter().enumerate() {
            self.put_u64(index(table, ordinal, 8)?, cache_candidate(*candidate))
                .await?;
        }
        let mut cache = [0; 32];
        cache[0] = table;
        cache[1] = count as u64;
        cache[2] = cache_site(metadata.cache.site());
        if let Some((candidate, site)) = metadata.cache.rejected() {
            cache[3] = cache_candidate(*candidate) + 1;
            cache[4] = cache_site(site);
        }
        record[8] = self.record(cache).await?;
        record[9] = self.slot(metadata.cache_slot.as_ref()).await?;
        record[10] = self.slot(metadata.caller_slot.as_ref()).await?;
        if let Some(caller) = &metadata.caller {
            let mut value = [0; 32];
            value[0] = self.text(&caller.id, budget.clone()).await?;
            match &caller.caller {
                Caller::Direct => value[1] = 0,
                Caller::Code20250825 { tool_id } => {
                    value[1] = 1;
                    value[2] = self.text(tool_id, budget.clone()).await?;
                }
                Caller::Code20260120 { tool_id } => {
                    value[1] = 2;
                    value[2] = self.text(tool_id, budget.clone()).await?;
                }
            }
            record[11] = self.record(value).await? + 1;
        }
        record[12] = self
            .optional_text(metadata.source_id.as_ref(), budget.clone())
            .await?;
        record[13] = self
            .optional_text(metadata.mcp_id.as_ref(), budget.clone())
            .await?;
        if let Some(document) = &metadata.document {
            let mut value = [0; 32];
            value[0] = self.text(&document.title, budget.clone()).await?;
            value[1] = self
                .optional_text(document.filename.as_ref(), budget.clone())
                .await?;
            value[2] = self.text(&document.media_type, budget.clone()).await?;
            record[14] = self.record(value).await? + 1;
        }
        record[15] = self.strings(&metadata.features).await?;
        record[16] = self.strings(&metadata.warnings).await?;
        if let Some(trim) = &metadata.trim {
            let mut value = [0; 32];
            value[0] = trim.leading.start;
            value[1] = trim.leading.end;
            value[2] = trim.trailing.start;
            value[3] = trim.trailing.end;
            record[17] = self.record(value).await? + 1;
        }
        record[18] = metadata.base_bytes;
        self.record(record).await
    }
    async fn identity(&self, ordinal: usize) -> Result<[u8; 32], ModelError> {
        self.arena
            .read_control_owned::<32>(
                index(self.tables.identities, ordinal, 32)?,
                self.custody.clone(),
            )
            .await
            .map_err(error)
    }
    async fn swap_identities(&self, a: usize, b: usize) -> Result<(), ModelError> {
        let left = self.identity(a).await?;
        let right = self.identity(b).await?;
        let a = index(self.tables.identities, a, 32)?;
        let b = index(self.tables.identities, b, 32)?;
        self.write(move |builder| {
            builder.write_at(a, &right)?;
            builder.write_at(b, &left)
        })
        .await
        .map_err(error)
    }
    async fn sift(&self, mut root: usize, end: usize) -> Result<(), ModelError> {
        loop {
            let Some(left) = root
                .checked_mul(2)
                .and_then(|value| value.checked_add(1))
                .filter(|left| *left < end)
            else {
                return Ok(());
            };
            let right = left + 1;
            let child = if right < end && self.identity(left).await? < self.identity(right).await? {
                right
            } else {
                left
            };
            if self.identity(root).await? >= self.identity(child).await? {
                return Ok(());
            }
            self.swap_identities(root, child).await?;
            root = child;
        }
    }
    async fn sort_identities(&self) -> Result<(), ModelError> {
        for root in (0..self.identity_count / 2).rev() {
            self.sift(root, self.identity_count).await?;
        }
        for end in (1..self.identity_count).rev() {
            self.swap_identities(0, end).await?;
            self.sift(0, end).await?;
        }
        Ok(())
    }
}

impl WireSink for Builder {
    fn extra_work_bytes(&self) -> usize {
        self.body_buffer_bytes
    }

    fn chunk(&mut self, chunk: wire::WireChunk, budget: Arc<dyn SourceBudget>) -> WireWrite<'_> {
        Box::pin(async move {
            if chunk.item_start {
                if self.item.is_some() || self.item_count >= self.expected_items {
                    return Err(invalid("backed wire item shape changed"));
                }
                let (metadata_tag, metadata) = match chunk.metadata.as_ref() {
                    None => (0, 0),
                    Some(wire::WireItemMetadata::Message(_)) => (1, chunk.message_index as u64),
                    Some(wire::WireItemMetadata::Anthropic(metadata)) => {
                        let offset = self.metadata(metadata, budget.clone()).await?;
                        if metadata.document.is_some() {
                            if self.document_count >= self.expected_documents {
                                return Err(invalid("backed document count grew"));
                            }
                            self.put_u64(
                                index(self.tables.documents, self.document_count, 8)?,
                                self.item_count as u64,
                            )
                            .await?;
                            self.document_count += 1;
                        }
                        if let Some(source) = &metadata.source_id {
                            if self.identity_count >= self.expected_identities {
                                return Err(invalid("backed source identity count grew"));
                            }
                            let offset = index(self.tables.identities, self.identity_count, 32)?;
                            let identity = source.identity;
                            self.write(move |builder| builder.write_at(offset, &identity))
                                .await
                                .map_err(error)?;
                            self.identity_count += 1;
                        }
                        (2, offset)
                    }
                    Some(wire::WireItemMetadata::GeneratedAnthropic(_)) => {
                        return Err(invalid(
                            "owned oracle metadata is not a backed source input",
                        ));
                    }
                };
                self.item = Some(OpenItem {
                    message: chunk.message_index,
                    body_start: self.position().await?,
                    metadata_tag,
                    metadata,
                    buffer: if self.body_buffer_bytes == 0 {
                        None
                    } else {
                        Some(
                            budget
                                .allocate(self.body_buffer_bytes)
                                .await
                                .map_err(error)?
                                .retain_owner(self.custody.clone()),
                        )
                    },
                    filled: 0,
                });
            }
            if self
                .item
                .as_ref()
                .is_none_or(|item| item.message != chunk.message_index)
            {
                return Err(invalid("backed wire chunk has no matching item"));
            }
            self.body(chunk.bytes).await?;
            if chunk.item_end {
                self.flush_body().await?;
                let item = self.item.take().expect("open item checked");
                drop(item.buffer);
                let mut record = [0; 32];
                record[0] = item.message as u64;
                record[1] = item.body_start;
                record[2] = self.position().await?;
                record[3] = item.metadata_tag;
                record[4] = item.metadata;
                self.put(
                    index(self.tables.items, self.item_count, RECORD_BYTES)?,
                    record,
                )
                .await?;
                self.item_count += 1;
            }
            Ok(())
        })
    }
    fn message_end(
        &mut self,
        message_index: usize,
        _role: MessageRole,
        prefix: [u8; 32],
    ) -> WireWrite<'_> {
        Box::pin(async move {
            if self.item.is_some()
                || message_index != self.message_count
                || message_index >= self.expected_messages
            {
                return Err(invalid("backed wire message order changed"));
            }
            let mut record = [0; 32];
            record[0] = self.message_start as u64;
            record[1] = self.item_count as u64;
            digest_words(&mut record[2..6], prefix);
            self.put(
                index(self.tables.messages, message_index, RECORD_BYTES)?,
                record,
            )
            .await?;
            self.message_start = self.item_count;
            self.message_count += 1;
            Ok(())
        })
    }
}

fn cache_candidate(candidate: ap::FrozenCacheCandidate) -> u64 {
    match candidate {
        ap::FrozenCacheCandidate::Invalid => 0,
        ap::FrozenCacheCandidate::Valid(CacheDirective::Ephemeral { ttl: None }) => 1,
        ap::FrozenCacheCandidate::Valid(CacheDirective::Ephemeral {
            ttl: Some(CacheTtl::FiveMinutes),
        }) => 2,
        ap::FrozenCacheCandidate::Valid(CacheDirective::Ephemeral {
            ttl: Some(CacheTtl::OneHour),
        }) => 3,
    }
}
fn decode_candidate(value: u64) -> Result<ap::FrozenCacheCandidate, ModelError> {
    Ok(match value {
        0 => ap::FrozenCacheCandidate::Invalid,
        1 => ap::FrozenCacheCandidate::Valid(CacheDirective::Ephemeral { ttl: None }),
        2 => ap::FrozenCacheCandidate::Valid(CacheDirective::Ephemeral {
            ttl: Some(CacheTtl::FiveMinutes),
        }),
        3 => ap::FrozenCacheCandidate::Valid(CacheDirective::Ephemeral {
            ttl: Some(CacheTtl::OneHour),
        }),
        _ => return Err(invalid("unknown frozen cache candidate")),
    })
}
fn cache_site(site: CacheSite) -> u64 {
    match site {
        CacheSite::System => 0,
        CacheSite::Text => 1,
        CacheSite::Image => 2,
        CacheSite::Document => 3,
        CacheSite::ToolResult => 4,
        CacheSite::ToolDefinition => 5,
        CacheSite::Reasoning => 6,
        CacheSite::RedactedReasoning => 7,
    }
}
fn decode_site(value: u64) -> Result<CacheSite, ModelError> {
    Ok(match value {
        0 => CacheSite::System,
        1 => CacheSite::Text,
        2 => CacheSite::Image,
        3 => CacheSite::Document,
        4 => CacheSite::ToolResult,
        5 => CacheSite::ToolDefinition,
        6 => CacheSite::Reasoning,
        7 => CacheSite::RedactedReasoning,
        _ => return Err(invalid("unknown frozen cache site")),
    })
}
struct Custody {
    arena: CaptureArena,
    _lease: DirectoryLease,
}
struct Directory {
    custody: Arc<Custody>,
    tables: Tables,
    logical: Arc<dyn MessageSource>,
    resources: ModelPreparationResources,
    messages: usize,
    items: usize,
    documents: usize,
    initial_prefix: [u8; 32],
    identities: Arc<Identities>,
}
impl Directory {
    async fn item(&self, ordinal: usize) -> Result<Record, ModelError> {
        if ordinal >= self.items {
            return Err(invalid("wire item exceeds backed directory"));
        }
        read_record(
            &self.custody,
            index(self.tables.items, ordinal, RECORD_BYTES)?,
        )
        .await
    }
    async fn message(&self, ordinal: usize) -> Result<Record, ModelError> {
        if ordinal >= self.messages {
            return Err(invalid("wire message exceeds backed directory"));
        }
        read_record(
            &self.custody,
            index(self.tables.messages, ordinal, RECORD_BYTES)?,
        )
        .await
    }
    async fn read_u64(&self, offset: u64) -> Result<u64, ModelError> {
        Ok(u64::from_le_bytes(
            self.custody
                .arena
                .read_control_owned::<8>(offset, self.custody.clone())
                .await
                .map_err(error)?,
        ))
    }
    async fn text(&self, offset: u64) -> Result<IdentifiedText, ModelError> {
        let record = read_record(&self.custody, offset).await?;
        Ok(IdentifiedText {
            text: TextSource::new(
                SourceBytes::Source(Arc::new(OwnedSource {
                    source: self.custody.arena.pending(record[0]..record[1]),
                    custody: self.custody.clone(),
                })),
                TextEncoding::Utf8,
            ),
            identity: digest_bytes(&record[2..6]),
        })
    }
    async fn optional_text(&self, offset: u64) -> Result<Option<IdentifiedText>, ModelError> {
        if offset == 0 {
            Ok(None)
        } else {
            self.text(offset - 1).await.map(Some)
        }
    }
    async fn strings(
        &self,
        offset: u64,
        budget: Arc<dyn SourceBudget>,
    ) -> Result<Vec<String>, ModelError> {
        let record = read_record(&self.custody, offset).await?;
        let mut strings = Vec::with_capacity(usize::try_from(record[1]).map_err(error)?);
        for ordinal in 0..record[1] as usize {
            let offset = index(record[0], ordinal, 16)?;
            let start = self.read_u64(offset).await?;
            let len = self.read_u64(offset + 8).await?;
            let source = self.custody.arena.pending(start..start + len);
            let mut cursor = source.open(budget.clone());
            let mut buffer = budget
                .allocate(usize::try_from(len).map_err(error)?)
                .await
                .map_err(error)?;
            let read = cursor.read_chunk(buffer).await.map_err(error)?;
            if !read.eof || read.bytes_read != len as usize {
                return Err(invalid("backed metadata string shortened"));
            }
            buffer = read.buffer;
            strings.push(
                String::from_utf8(buffer.as_ref()[..read.bytes_read].to_vec()).map_err(error)?,
            );
        }
        Ok(strings)
    }
    async fn slot(&self, offset: u64) -> Result<Option<ap::FieldSlot>, ModelError> {
        if offset == 0 {
            return Ok(None);
        }
        let record = read_record(&self.custody, offset - 1).await?;
        Ok(Some(ap::FieldSlot {
            offset: record[0],
            comma_before: record[1] & 1 != 0,
            comma_after: record[1] & 2 != 0,
        }))
    }
    async fn document(
        &self,
        offset: u64,
    ) -> Result<ap::DocumentMetadata<IdentifiedText>, ModelError> {
        let record = read_record(&self.custody, offset).await?;
        Ok(ap::DocumentMetadata {
            title: self.text(record[0]).await?,
            filename: self.optional_text(record[1]).await?,
            media_type: self.text(record[2]).await?,
        })
    }
    async fn part(&self, offset: u64, budget: Arc<dyn SourceBudget>) -> Result<Part, ModelError> {
        let record = read_record(&self.custody, offset).await?;
        let role = match record[0] {
            0 => ap::MessageRole::System,
            1 => ap::MessageRole::User,
            2 => ap::MessageRole::Assistant,
            _ => return Err(invalid("unknown backed Anthropic role")),
        };
        let system = if record[1] & 1 == 0 {
            None
        } else {
            Some(ap::SystemMetadata {
                text_block: record[1] & 2 != 0,
                changes: usize::try_from(record[2]).map_err(error)?,
                clear_at: match record[3] {
                    0 => None,
                    1 => Some(ap::ClearAt::NextUserMessage),
                    _ => return Err(invalid("unknown backed clear policy")),
                },
                effort: match record[4] {
                    0 => None,
                    1 => Some(ap::Effort::Low),
                    2 => Some(ap::Effort::Medium),
                    3 => Some(ap::Effort::High),
                    4 => Some(ap::Effort::Xhigh),
                    5 => Some(ap::Effort::Max),
                    _ => return Err(invalid("unknown backed effort")),
                },
            })
        };
        let cache = read_record(&self.custody, record[8]).await?;
        let mut candidates = Vec::with_capacity(usize::try_from(cache[1]).map_err(error)?);
        for ordinal in 0..cache[1] as usize {
            candidates.push(decode_candidate(
                self.read_u64(index(cache[0], ordinal, 8)?).await?,
            )?);
        }
        let rejected = if cache[3] == 0 {
            None
        } else {
            Some((decode_candidate(cache[3] - 1)?, decode_site(cache[4])?))
        };
        let caller = if record[11] == 0 {
            None
        } else {
            let caller = read_record(&self.custody, record[11] - 1).await?;
            let kind = match caller[1] {
                0 => Caller::Direct,
                1 => Caller::Code20250825 {
                    tool_id: self.text(caller[2]).await?,
                },
                2 => Caller::Code20260120 {
                    tool_id: self.text(caller[2]).await?,
                },
                _ => return Err(invalid("unknown backed caller")),
            };
            Some(ap::CallerMetadata {
                id: self.text(caller[0]).await?,
                caller: kind,
            })
        };
        let trim = if record[17] == 0 {
            None
        } else {
            let trim = read_record(&self.custody, record[17] - 1).await?;
            Some(ap::TextTrim {
                leading: trim[0]..trim[1],
                trailing: trim[2]..trim[3],
            })
        };
        Ok(Part {
            message: ap::MessageMetadata {
                role,
                system,
                user_content: record[7] & 16 != 0,
                part_count: usize::try_from(record[5]).map_err(error)?,
            },
            part_index: usize::try_from(record[6]).map_err(error)?,
            emitted: record[7] & 1 != 0,
            local_tool: record[7] & 2 != 0,
            boundary: record[7] & 4 != 0,
            system_text: record[7] & 8 != 0,
            cache: ap::CacheProgram::new(candidates, decode_site(cache[2])?, rejected),
            cache_slot: self.slot(record[9]).await?,
            caller_slot: self.slot(record[10]).await?,
            caller,
            source_id: self.optional_text(record[12]).await?,
            mcp_id: self.optional_text(record[13]).await?,
            document: if record[14] == 0 {
                None
            } else {
                Some(self.document(record[14] - 1).await?)
            },
            features: self.strings(record[15], budget.clone()).await?,
            warnings: self.strings(record[16], budget).await?,
            trim,
            base_bytes: record[18],
        })
    }
    async fn metadata(
        &self,
        item: &Record,
        budget: Arc<dyn SourceBudget>,
    ) -> Result<Option<wire::WireItemMetadata>, ModelError> {
        match item[3] {
            0 => Ok(None),
            1 => {
                let mut cursor = self.logical.open_metadata(item[4] as usize);
                let metadata = cursor
                    .next()
                    .await
                    .map_err(error)?
                    .ok_or_else(|| invalid("backed wire logical metadata disappeared"))?;
                Ok(Some(wire::WireItemMetadata::Message(metadata)))
            }
            2 => Ok(Some(wire::WireItemMetadata::Anthropic(Arc::new(
                self.part(item[4], budget).await?,
            )))),
            _ => Err(invalid("unknown backed wire metadata")),
        }
    }
}

struct Identities {
    custody: Arc<Custody>,
    table: u64,
    count: usize,
}
impl wire::SourceIdentityLookup for Identities {
    fn contains(&self, identity: [u8; 32], _budget: Arc<dyn SourceBudget>) -> wire::HasSource<'_> {
        Box::pin(async move {
            let (mut low, mut high) = (0, self.count);
            while low < high {
                let middle = low + (high - low) / 2;
                let candidate = self
                    .custody
                    .arena
                    .read_control_owned::<32>(index(self.table, middle, 32)?, self.custody.clone())
                    .await
                    .map_err(error)?;
                match candidate.cmp(&identity) {
                    std::cmp::Ordering::Less => low = middle + 1,
                    std::cmp::Ordering::Greater => high = middle,
                    std::cmp::Ordering::Equal => return Ok(true),
                }
            }
            Ok(false)
        })
    }
}
struct WorkFactory(ModelPreparationResources);
impl SourceBudgetFactory for WorkFactory {
    fn acquire(&self) -> AcquireBudget<'_> {
        Box::pin(async move { Ok(self.0.acquire_work().await?.budget()) })
    }
}

struct SharedDirectory(Arc<Directory>);
impl wire::WireSource for SharedDirectory {
    fn source_identities(&self) -> Option<Arc<dyn wire::SourceIdentityLookup>> {
        Some(self.0.identities.clone())
    }
    fn document_count(&self) -> usize {
        self.0.documents
    }
    fn document(
        &self,
        ordinal: usize,
        _budget: Arc<dyn SourceBudget>,
    ) -> wire::NextWireDocument<'_> {
        Box::pin(async move {
            if ordinal >= self.0.documents {
                return Ok(None);
            }
            let item = self
                .0
                .read_u64(index(self.0.tables.documents, ordinal, 8)?)
                .await?;
            let item = self.0.item(item as usize).await?;
            if item[3] != 2 {
                return Err(invalid("document index lacks Anthropic metadata"));
            }
            let metadata = read_record(&self.0.custody, item[4]).await?;
            if metadata[14] == 0 {
                return Err(invalid("document index lacks its descriptor"));
            }
            Ok(Some(self.0.document(metadata[14] - 1).await?))
        })
    }
    fn budget_factory(&self) -> Option<Arc<dyn SourceBudgetFactory>> {
        Some(Arc::new(WorkFactory(self.0.resources.clone())))
    }
    fn open(&self, start_message: usize) -> Box<dyn wire::WireCursor> {
        Box::new(Cursor::new(
            self.0.clone(),
            wire::WirePosition {
                message_index: start_message,
                piece_index: 0,
            },
            false,
        ))
    }
    fn open_at(&self, position: wire::WirePosition) -> Option<Box<dyn wire::WireCursor>> {
        if position.message_index >= self.0.messages {
            return None;
        }
        Some(Box::new(Cursor::new(self.0.clone(), position, true)))
    }
    fn open_metadata(&self, start_message: usize) -> Option<Box<dyn wire::WireMetadataCursor>> {
        Some(Box::new(MetadataCursor {
            directory: self.0.clone(),
            initial_message: Some(start_message),
            index: 0,
        }))
    }
    fn prefix_identity(&self, messages: usize) -> wire::PrefixIdentity<'_> {
        Box::pin(async move {
            let identity = if messages == 0 {
                self.0.initial_prefix
            } else {
                digest_bytes(&self.0.message(messages - 1).await?[2..6])
            };
            Ok(Some(hex::encode(identity)))
        })
    }
}
struct Cursor {
    directory: Arc<Directory>,
    initial: Option<wire::WirePosition>,
    strict_item: bool,
    index: usize,
    current: Option<Body>,
    budget: Option<Arc<dyn SourceBudget>>,
}
struct Body {
    record: Record,
    cursor: Box<dyn ByteCursor>,
    first: bool,
}
impl Cursor {
    fn new(directory: Arc<Directory>, position: wire::WirePosition, strict_item: bool) -> Self {
        Self {
            directory,
            initial: Some(position),
            strict_item,
            index: 0,
            current: None,
            budget: None,
        }
    }
}
impl wire::WireCursor for Cursor {
    fn budget(&self) -> Option<Arc<dyn SourceBudget>> {
        self.budget.clone()
    }
    fn next(&mut self) -> wire::NextWire<'_> {
        Box::pin(async move {
            if let Some(position) = self.initial.take() {
                if position.message_index >= self.directory.messages {
                    self.index = self.directory.items;
                } else {
                    let message = self.directory.message(position.message_index).await?;
                    let ordinal = message[0]
                        .checked_add(position.piece_index as u64)
                        .ok_or_else(|| invalid("backed item seek overflows"))?;
                    if ordinal > message[1]
                        || ((self.strict_item || position.piece_index != 0)
                            && ordinal == message[1])
                    {
                        return Err(invalid("backed item seek exceeds message"));
                    }
                    self.index = usize::try_from(ordinal).map_err(error)?;
                }
            }
            if self.index >= self.directory.items {
                self.budget = None;
                return Ok(None);
            }
            if self.budget.is_none() {
                self.budget = Some(
                    self.directory
                        .resources
                        .acquire_work()
                        .await
                        .map_err(error)?
                        .budget(),
                );
            }
            let budget = self.budget.as_ref().expect("cursor acquired work").clone();
            if self.current.is_none() {
                let record = self.directory.item(self.index).await?;
                let source = self.directory.custody.arena.pending(record[1]..record[2]);
                self.current = Some(Body {
                    record,
                    cursor: source.open(budget.clone()),
                    first: true,
                });
            }
            let body = self.current.as_mut().expect("current item exists");
            let metadata = if body.first {
                self.directory
                    .metadata(&body.record, budget.clone())
                    .await?
            } else {
                None
            };
            let read = body
                .cursor
                .read_chunk(
                    budget
                        .allocate(32 * 1024)
                        .await
                        .map_err(error)?
                        .retain_owner(self.directory.custody.clone()),
                )
                .await
                .map_err(error)?;
            if read.bytes_read == 0 && !read.eof {
                return Err(invalid("backed wire body made no progress"));
            }
            let first = body.first;
            body.first = false;
            let message = body.record[0] as usize;
            let bytes = Bytes::from_owner(OutputBytes {
                bytes: read.buffer.into_bytes(read.bytes_read),
                _custody: self.directory.custody.clone(),
            });
            if read.eof {
                self.current = None;
                self.index += 1;
            }
            Ok(Some(wire::WireChunk {
                bytes,
                item_start: first,
                item_end: read.eof,
                message_index: message,
                metadata,
            }))
        })
    }
}
struct MetadataCursor {
    directory: Arc<Directory>,
    initial_message: Option<usize>,
    index: usize,
}
impl wire::WireMetadataCursor for MetadataCursor {
    fn next(&mut self) -> wire::NextWireMetadata<'_> {
        Box::pin(async move {
            if let Some(message) = self.initial_message.take() {
                self.index = if message >= self.directory.messages {
                    self.directory.items
                } else {
                    self.directory.message(message).await?[0] as usize
                };
            }
            let mut budget = None;
            while self.index < self.directory.items {
                let ordinal = self.index;
                self.index += 1;
                let item = self.directory.item(ordinal).await?;
                if item[3] == 0 {
                    continue;
                }
                if budget.is_none() {
                    budget = Some(
                        self.directory
                            .resources
                            .acquire_work()
                            .await
                            .map_err(error)?
                            .budget(),
                    );
                }
                let metadata = self
                    .directory
                    .metadata(
                        &item,
                        budget.as_ref().expect("metadata work admitted").clone(),
                    )
                    .await?
                    .ok_or_else(|| invalid("indexed metadata disappeared"))?;
                let message = self.directory.message(item[0] as usize).await?;
                return Ok(Some(wire::WireMetadata {
                    position: wire::WirePosition {
                        message_index: item[0] as usize,
                        piece_index: ordinal - message[0] as usize,
                    },
                    message_index: item[0] as usize,
                    metadata,
                }));
            }
            Ok(None)
        })
    }
}
struct OutputBytes {
    bytes: Bytes,
    _custody: Arc<Custody>,
}
impl AsRef<[u8]> for OutputBytes {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}
struct OwnedSource {
    source: SourceBytes,
    custody: Arc<Custody>,
}
impl ByteSource for OwnedSource {
    fn len(&self) -> Option<u64> {
        self.source.len()
    }
    fn slice(&self, range: Range<u64>) -> io::Result<Arc<dyn ByteSource>> {
        Ok(Arc::new(Self {
            source: self.source.slice(range)?,
            custody: self.custody.clone(),
        }))
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(OwnedCursor {
            cursor: self.source.open(budget),
            custody: self.custody.clone(),
        })
    }
}
struct OwnedCursor {
    cursor: Box<dyn ByteCursor>,
    custody: Arc<Custody>,
}
impl ByteCursor for OwnedCursor {
    fn read_chunk(&mut self, buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            let read = self
                .cursor
                .read_chunk(buffer.retain_owner(self.custody.clone()))
                .await?;
            Ok(SourceRead {
                buffer: read.buffer.retain_owner(self.custody.clone()),
                bytes_read: read.bytes_read,
                eof: read.eof,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use maka_agent_facts::model::prompt::{AssistantPart, Message};
    use maka_capabilities::model_preparation::PreparationPolicy;
    use maka_event_log::{
        context::semantic::SemanticSelection,
        root::{RootNamespaces, RootOwner},
        root_store::{RootStore, SessionExecutionLease},
    };
    use std::{path::Path, time::Duration};

    async fn arena(path: &Path) -> (RootStore, CaptureArena, SessionExecutionLease) {
        let root = RootStore::open(Arc::new(
            RootOwner::create(
                &path.join("root"),
                &RootNamespaces {
                    ownership: path.join("owners"),
                    control: path.join("control"),
                },
            )
            .unwrap(),
        ))
        .await
        .unwrap();
        let session = root
            .create_session("session", "create", &serde_json::json!({}), 1)
            .await
            .unwrap();
        let execution = session.execution_scope(None).await.unwrap().accept();
        let captured = execution
            .store()
            .capture_source(SemanticSelection {
                session: "session".into(),
                lineage: None,
                after: 0,
                through: 0,
                before: 1,
                captured_through: 0,
                replay: None,
                prior_unknown: false,
            })
            .await
            .unwrap();
        let arena = CaptureArena::new(captured, None).await.unwrap();
        (root, arena, execution)
    }
    fn resources(bytes: usize) -> ModelPreparationResources {
        ModelPreparationResources::new(PreparationPolicy {
            resident_bytes: bytes,
            ..Default::default()
        })
        .unwrap()
    }
    fn encoding(kind: maka_model::ProviderKind) -> maka_model::WireEncoding {
        maka_model::WireEncoding::new(
            maka_agent_facts::language::Language::En,
            &maka_model::ProviderConfig {
                adapter: None,
                capabilities: Default::default(),
                network: Default::default(),
                kind,
                model: "fixture".into(),
                base_url: "https://example.invalid".into(),
                auth: maka_model::ProviderAuth::ApiKey("fixture".into()),
                headers: Default::default(),
                body_overlay: None,
            },
            &serde_json::Value::Null,
            &[],
        )
        .unwrap()
    }
    async fn items(mut cursor: Box<dyn wire::WireCursor>) -> Vec<(usize, Vec<u8>)> {
        let mut items: Vec<(usize, Vec<u8>)> = Vec::new();
        while let Some(chunk) = cursor.next().await.unwrap() {
            if chunk.item_start {
                items.push((chunk.message_index, Vec::new()));
            }
            items.last_mut().unwrap().1.extend_from_slice(&chunk.bytes);
        }
        items
    }
    #[tokio::test]
    async fn backed_anthropic_document_and_identity_indexes_preserve_typed_metadata() {
        use maka_agent_facts::model::{
            ToolInput,
            prompt::{ContentPart, FileData},
        };
        use sha2::{Digest, Sha256};
        tokio::time::timeout(Duration::from_secs(20), async {
            let directory = tempfile::tempdir().unwrap();
            let (root, arena, execution) = arena(directory.path()).await;
            let logical: Arc<dyn MessageSource> = Arc::new(generated::GeneratedMessages::new(&[
                Message::User { content: vec![ContentPart::File {
                    data: FileData::Data("ZG9jdW1lbnQ=".into()), media_type: "text/plain".into(),
                    provider_options: Some(serde_json::json!({"anthropic":{"citations":{"enabled":true}}})),
                }], provider_options: None },
                Message::Assistant { content: vec![
                    AssistantPart::ToolCall { tool_call_id: "source".into(), tool_name: "code_execution".into(),
                        input: ToolInput::Json(serde_json::json!({})), provider_executed: Some(true), provider_options: None },
                    AssistantPart::ToolCall { tool_call_id: "local".into(), tool_name: "local".into(),
                        input: ToolInput::Json(serde_json::json!({"arg":1})), provider_executed: None,
                        provider_options: Some(serde_json::json!({"anthropic":{"caller":{"type":"code_execution_20250825","toolId":"source"},"cacheControl":{"type":"ephemeral"}}})) },
                ], provider_options: None },
                Message::user("tail"),
            ]));
            let encoding = encoding(maka_model::ProviderKind::Anthropic);
            let generous = resources(1024 * 1024);
            let plan = encoding.count_source(logical.clone(), generous.clone()).await.unwrap();
            let resident = encoding.prepare_source(logical.clone(), generous).await.unwrap();
            let resources = resources(resident_bytes());
            let active = resources.reserve_staging(0).await.unwrap().promote(resident_bytes()).await.unwrap();
            let backed = build(&plan, logical, arena.clone(), active.directory(resident_bytes()).unwrap(), resources.clone()).await.unwrap();
            assert_eq!(backed.source.document_count(), 1);
            let budget = resources.acquire_work().await.unwrap().budget();
            let document = backed.source.document(0, budget.clone()).await.unwrap().unwrap();
            assert_eq!(document.title.identity, <[u8;32]>::from(Sha256::digest(b"Untitled Document")));
            assert_eq!(document.media_type.identity, <[u8;32]>::from(Sha256::digest(b"text/plain")));
            assert!(backed.source.document(1, budget.clone()).await.unwrap().is_none());
            let identities = backed.source.source_identities().unwrap();
            assert!(identities.contains(Sha256::digest(b"source").into(), budget.clone()).await.unwrap());
            assert!(!identities.contains(Sha256::digest(b"absent").into(), budget.clone()).await.unwrap());
            drop(identities); drop(document); drop(budget);
            let mut actual = backed.source.open_metadata(0).unwrap();
            let mut expected = resident.source.open_metadata(0).unwrap();
            while let Some(item) = actual.next().await.unwrap() {
                let oracle = expected.next().await.unwrap().unwrap();
                assert_eq!(item.position.message_index, oracle.position.message_index);
                assert_eq!(item.position.piece_index, oracle.position.piece_index);
                let (wire::WireItemMetadata::Anthropic(item), wire::WireItemMetadata::Anthropic(oracle)) = (item.metadata, oracle.metadata) else {
                    panic!("native Anthropic metadata required");
                };
                assert_eq!(serde_json::to_value(item.map_text(|text| hex::encode(text.identity))).unwrap(),
                    serde_json::to_value(oracle.map_text(|text| hex::encode(text.identity))).unwrap());
            }
            assert!(expected.next().await.unwrap().is_none());
            drop(actual); drop(expected); drop(backed); drop(resident); drop(plan); drop(active);
            arena.close().await.unwrap(); drop(arena);
            execution.finish(); root.shutdown().await.unwrap();
        }).await.expect("indexed documents, source identities and typed metadata must make progress");
    }
    #[tokio::test]
    async fn backed_zero_width_items_preserve_logical_offsets_and_midmessage_seek() {
        tokio::time::timeout(Duration::from_secs(20), async {
            for responses in [true, false] {
                let directory = tempfile::tempdir().unwrap();
                let (root, arena, execution) = arena(directory.path()).await;
                let empty_content = if responses {
                    vec![AssistantPart::Reasoning { text: "not replayable".into(), provider_options: None }]
                } else { Vec::new() };
                let logical: Arc<dyn MessageSource> = Arc::new(generated::GeneratedMessages::new(&[
                    Message::user("before"),
                    Message::Assistant { content: empty_content, provider_options: None },
                    Message::Assistant { content: vec![
                        AssistantPart::Text { text: "one".into(), provider_options: None },
                        AssistantPart::Text { text: "two".into(), provider_options: None },
                    ], provider_options: None },
                    Message::user("after"),
                ]));
                let (kind, expected, prefixes) = if responses {
                    (maka_model::ProviderKind::OpenaiResponses,
                        vec![
                            (0, br#"{"role":"user","content":[{"type":"input_text","text":"before"}]}"#.to_vec()),
                            (1, Vec::new()),
                            (2, br#"{"role":"assistant","content":[{"type":"output_text","text":"one"}]}"#.to_vec()),
                            (2, br#"{"role":"assistant","content":[{"type":"output_text","text":"two"}]}"#.to_vec()),
                            (3, br#"{"role":"user","content":[{"type":"input_text","text":"after"}]}"#.to_vec()),
                        ],
                        ["cf0d061762399371f26d578b4d318e27031ac278882c2ff6705d57b09c1687ad",
                         "163580562e171e1789602185be35c58a1285abb8e7bf28ca02b9a52fac8cda51",
                         "eba4944586aaa95a117f9c472f065123cc129ca58b103304dd49e6595c07730d",
                         "ef84d816cb1aa09b347c51baf9112d5ddff648c678bebcaec3cdd59d2feb543f",
                         "74fc885e31e087960383bebc2ee9d6d7bc54ad5bc5959a2b7725a3da3c0c36df"])
                } else {
                    (maka_model::ProviderKind::Anthropic,
                        vec![
                            (0, br#"{"type":"text","text":"before"}"#.to_vec()),
                            (1, Vec::new()),
                            (2, br#"{"type":"text","text":"one"}"#.to_vec()),
                            (2, br#"{"type":"text","text":"two"}"#.to_vec()),
                            (3, br#"{"type":"text","text":"after"}"#.to_vec()),
                        ],
                        ["6f13abb20ebe32c90328beb6471f7786df28a7236e56e6b5a513cdc028452385",
                         "dc653d888a78abed15fa52f82b5c6936879b6bb1535087aa694f08f434c87dff",
                         "7a337cfd76ddddd5fd03c9b39f6bfcc8c96e140ffc89d775ba318b7636ff6bb8",
                         "12c3ec3f99abafd7f6156faf83ff64968be1b693f3e0d0e526a34613fcf5dbf6",
                         "abcd0f7ca242f4ef9b52c3c8b091700918600e49da181c9001df7cc52295d316"])
                };
                let encoding = encoding(kind);
                let generous = resources(1024 * 1024);
                let plan = encoding.count_source(logical.clone(), generous.clone()).await.unwrap();
                assert_eq!(plan.message_count(), 4);
                assert_eq!(plan.item_count(), 5);
                let resident = encoding.prepare_source(logical.clone(), generous).await.unwrap();
                let resources = resources(resident_bytes());
                let active = resources.reserve_staging(0).await.unwrap().promote(resident_bytes()).await.unwrap();
                let backed = build(&plan, logical, arena.clone(), active.directory(resident_bytes()).unwrap(), resources).await.unwrap();
                assert_eq!(items(resident.source.open(0)).await, expected);
                assert_eq!(items(backed.source.open(0)).await, expected);
                assert_eq!(backed.identity, prefixes[4]);
                assert_eq!(resident.identity, prefixes[4]);
                for (start, prefix) in prefixes.iter().enumerate() {
                    let suffix = expected.iter().filter(|(message, _)| *message >= start).cloned().collect::<Vec<_>>();
                    assert_eq!(items(backed.source.open(start)).await, suffix);
                    assert_eq!(items(resident.source.open(start)).await, suffix);
                    assert_eq!(backed.source.prefix_identity(start).await.unwrap().as_deref(), Some(*prefix));
                    assert_eq!(resident.source.prefix_identity(start).await.unwrap().as_deref(), Some(*prefix));
                }
                for (message_index, piece_index, ordinal) in [(0,0,0),(1,0,1),(2,0,2),(2,1,3),(3,0,4)] {
                    let position = wire::WirePosition { message_index, piece_index };
                    assert_eq!(items(backed.source.open_at(position).unwrap()).await, expected[ordinal..]);
                    assert_eq!(items(resident.source.open_at(position).unwrap()).await, expected[ordinal..]);
                }
                let mut empty = backed.source.open_at(wire::WirePosition { message_index: 1, piece_index: 0 }).unwrap();
                let chunk = empty.next().await.unwrap().unwrap();
                assert_eq!(chunk.message_index, 1);
                assert!(chunk.item_start && chunk.item_end);
                assert_eq!(&chunk.bytes[..], b"");
                match chunk.metadata.as_ref().unwrap() {
                    wire::WireItemMetadata::Message(metadata) => assert_eq!(metadata.message_index, 1),
                    wire::WireItemMetadata::Anthropic(metadata) => {
                        assert!(!metadata.emitted);
                        assert_eq!(metadata.part_index, 0);
                        assert_eq!(metadata.message.part_count, 1);
                    },
                    _ => panic!("native typed metadata required"),
                }
                drop(chunk); drop(empty);
                let mut metadata = backed.source.open_metadata(1).unwrap();
                let mut positions = Vec::new();
                while let Some(item) = metadata.next().await.unwrap() {
                    positions.push((item.position.message_index, item.position.piece_index));
                }
                assert_eq!(positions, if responses { vec![(1,0),(2,0),(3,0)] } else { vec![(1,0),(2,0),(2,1),(3,0)] });
                drop(metadata); drop(backed); drop(resident); drop(plan); drop(active);
                arena.close().await.unwrap(); drop(arena);
                execution.finish(); root.shutdown().await.unwrap();
            }
        }).await.expect("zero-width items must preserve numeric logical and item offsets");
    }
}
