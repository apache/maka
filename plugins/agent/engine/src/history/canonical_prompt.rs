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

//! Canonical model messages captured into one request-owned, replayable arena.
use super::{
    capture_arena::CaptureArena, preparation::RequestPreparation, preparation_io::PreparationIo,
    serialize_source::MediaExternalizer,
};
use maka_agent_facts::{
    context::PreparedContextBreakdown, durable::ContentRef, model::prompt_source::source::*,
};
use maka_model::{
    ModelPreparationResources,
    prompt::{Message, Prompt},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    future::Future,
    io,
    marker::PhantomData,
    ops::Range,
    pin::Pin,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;
mod project;
pub(super) use project::IdentifierBuilder;
use project::*;

const MESSAGE_FLAGS: usize = 10;
const PINNED_MEMORY: u64 = 1 << 2;
const WORDS: usize = 20;
const RECORD_BYTES: usize = WORDS * 8;
type Record = [u64; WORDS];
#[derive(Clone, Copy, Default)]
struct List {
    offset: u64,
    len: usize,
}
#[derive(Clone)]
pub(crate) struct ExternalMediaEntry {
    pub reference: ContentRef,
    pub digest: [u8; 32],
    pub range: Range<u64>,
}

#[derive(Clone)]
pub(crate) struct RestoredMediaEntry {
    pub digest: [u8; 32],
    pub range: Range<u64>,
}

#[derive(Default)]
struct MediaIndex {
    entries: Vec<ExternalMediaEntry>,
    by_key: HashMap<([u8; 32], u64), usize>,
    leases: Vec<maka_model::DirectoryLease>,
    charged_bytes: usize,
}

fn media_index_entry_bytes(digest_cap: usize) -> usize {
    // Account for Vec<ExternalMediaEntry> (2x doubling headroom), HashMap bucket (~2x load factor),
    // and the digest String heap buffer.
    2 * std::mem::size_of::<ExternalMediaEntry>()
        + 2 * (std::mem::size_of::<([u8; 32], u64, usize)>() + 1)
        + digest_cap
}

fn decode_sha256_digest(digest: &str) -> io::Result<[u8; 32]> {
    let hex_part = digest.strip_prefix("sha256:").ok_or_else(invalid)?;
    let bytes = hex::decode(hex_part).map_err(|_| invalid())?;
    bytes.try_into().map_err(|_| invalid())
}

pub(crate) struct MediaCapture {
    io: PreparationIo,
    preparation: Arc<RequestPreparation>,
    arena: Mutex<Option<CaptureArena>>,
    index: Mutex<MediaIndex>,
}
impl MediaCapture {
    pub(crate) fn new(io: PreparationIo, preparation: Arc<RequestPreparation>) -> Arc<Self> {
        Arc::new(Self {
            io,
            preparation,
            arena: Mutex::new(None),
            index: Mutex::new(MediaIndex::default()),
        })
    }
    pub(crate) fn charged_bytes(&self) -> usize {
        self.index
            .lock()
            .expect("media capture index lock poisoned")
            .charged_bytes
    }
    pub(crate) fn current_arena(&self) -> Option<CaptureArena> {
        self.arena
            .lock()
            .expect("media capture arena lock poisoned")
            .clone()
    }
    pub(crate) fn entries(&self) -> Vec<ExternalMediaEntry> {
        self.index
            .lock()
            .expect("media capture index lock poisoned")
            .entries
            .clone()
    }
    async fn ensure_arena(&self) -> io::Result<CaptureArena> {
        if let Some(existing) = self.current_arena() {
            return Ok(existing);
        }
        let created = CaptureArena::new(self.io.clone(), None).await?;
        let existing = {
            let mut guard = self
                .arena
                .lock()
                .expect("media capture arena lock poisoned");
            if let Some(existing) = guard.as_ref() {
                Some(existing.clone())
            } else {
                *guard = Some(created.clone());
                None
            }
        };
        if let Some(existing) = existing {
            let _ = created.close().await;
            return Ok(existing);
        }
        Ok(created)
    }
    async fn capture_bytes(
        &self,
        source: SourceBytes,
        budget: &Arc<dyn SourceBudget>,
        cancellation: &CancellationToken,
    ) -> io::Result<ContentRef> {
        // Stream and hash once into the append-serialized media arena; rewind on dedup hit or error.
        let arena = self.ensure_arena().await?;
        let append = arena.begin_append().await;
        let start = append.with_writer(|w| Ok(w.position())).await?;
        let mut cursor = source.open(budget.clone());
        let mut buffer = budget.allocate(32 * 1024).await?;
        let mut hash = Sha256::new();
        let mut total = 0u64;
        let stream_result: io::Result<()> = async {
            loop {
                if cancellation.is_cancelled() {
                    return Err(crate::preparation_cancelled(
                        "canonical media capture cancelled",
                    ));
                }
                let read = cursor.read_chunk(buffer).await?;
                let count = read.bytes_read;
                buffer = read.buffer;
                if count != 0 {
                    hash.update(&buffer.as_ref()[..count]);
                    total = total.checked_add(count as u64).ok_or_else(overflow)?;
                    buffer = append
                        .with_writer(move |w| {
                            w.append_bytes(&buffer.as_ref()[..count])?;
                            Ok(buffer)
                        })
                        .await?;
                }
                if read.eof {
                    return Ok(());
                }
                if count == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "media source made no progress",
                    ));
                }
            }
        }
        .await;
        if let Err(error) = stream_result {
            let _ = append
                .with_writer(move |w| w.truncate_unsealed(start))
                .await;
            return Err(error);
        }
        let end = append.with_writer(|w| Ok(w.position())).await?;
        if end.checked_sub(start) != Some(total) {
            let _ = append
                .with_writer(move |w| w.truncate_unsealed(start))
                .await;
            return Err(invalid());
        }
        let digest_bytes: [u8; 32] = hash.finalize().into();
        let key = (digest_bytes, total);
        let existing = {
            let guard = self
                .index
                .lock()
                .expect("media capture index lock poisoned");
            guard
                .by_key
                .get(&key)
                .map(|&slot| guard.entries[slot].reference.clone())
        };
        if let Some(existing) = existing {
            append
                .with_writer(move |w| w.truncate_unsealed(start))
                .await?;
            return Ok(existing);
        }
        let reference = ContentRef {
            digest: format!("sha256:{}", hex::encode(digest_bytes)),
            bytes: total,
        };
        let entry_bytes = media_index_entry_bytes(reference.digest.capacity());
        let lease = match self.preparation.plan_directory(entry_bytes) {
            Ok(lease) => lease,
            Err(error) => {
                let _ = append
                    .with_writer(move |w| w.truncate_unsealed(start))
                    .await;
                return Err(error);
            }
        };
        let mut guard = self
            .index
            .lock()
            .expect("media capture index lock poisoned");
        let slot = guard.entries.len();
        guard.entries.push(ExternalMediaEntry {
            reference: reference.clone(),
            digest: digest_bytes,
            range: start..end,
        });
        guard.by_key.insert(key, slot);
        guard.charged_bytes = guard.charged_bytes.saturating_add(entry_bytes);
        guard.leases.push(lease);
        drop(guard);
        drop(append);
        Ok(reference)
    }
    fn lookup(&self, digest: &str, bytes: u64) -> io::Result<(usize, [u8; 32])> {
        let digest_bytes = decode_sha256_digest(digest)?;
        let guard = self
            .index
            .lock()
            .expect("media capture index lock poisoned");
        let slot = *guard
            .by_key
            .get(&(digest_bytes, bytes))
            .ok_or_else(invalid)?;
        Ok((slot, guard.entries[slot].digest))
    }
    fn arena_range(
        &self,
        slot: usize,
        expected_bytes: u64,
        expected_digest: [u8; 32],
    ) -> io::Result<(CaptureArena, Range<u64>)> {
        let range = {
            let guard = self
                .index
                .lock()
                .expect("media capture index lock poisoned");
            let entry = guard.entries.get(slot).ok_or_else(invalid)?;
            if entry.reference.bytes != expected_bytes
                || entry.digest != expected_digest
                || entry.range.end.checked_sub(entry.range.start) != Some(expected_bytes)
            {
                return Err(invalid());
            }
            entry.range.clone()
        };
        let arena = self.current_arena().ok_or_else(invalid)?;
        Ok((arena, range))
    }
}

struct MediaCaptureExternalizer(Arc<MediaCapture>);
impl MediaExternalizer for MediaCaptureExternalizer {
    fn capture<'a>(
        &'a mut self,
        bytes: SourceBytes,
        budget: &'a Arc<dyn SourceBudget>,
        cancellation: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = io::Result<ContentRef>> + Send + 'a>> {
        let capture = self.0.clone();
        Box::pin(async move { capture.capture_bytes(bytes, budget, cancellation).await })
    }
}

#[derive(Clone)]
enum MediaBacking {
    None,
    Capture(Arc<MediaCapture>),
    Restored(Arc<[RestoredMediaEntry]>),
}

#[derive(Clone)]
pub(super) struct Store {
    arena: CaptureArena,
    media: MediaBacking,
    resources: ModelPreparationResources,
    owner: Arc<dyn Send + Sync>,
    inspection: bool,
}
impl Store {
    fn bytes(&self, range: Range<u64>) -> SourceBytes {
        self.arena_bytes(&self.arena, range)
    }
    fn arena_bytes(&self, arena: &CaptureArena, range: Range<u64>) -> SourceBytes {
        let source = if self.inspection {
            arena.inspect(range)
        } else {
            arena.pending(range)
        };
        SourceBytes::Source(Arc::new(OwnedSource {
            source,
            owner: self.owner.clone(),
        }))
    }
    fn lookup_external_media(&self, digest: &str, bytes: u64) -> io::Result<(usize, [u8; 32])> {
        match &self.media {
            MediaBacking::Capture(capture) => capture.lookup(digest, bytes),
            MediaBacking::None | MediaBacking::Restored(_) => Err(invalid()),
        }
    }
    fn external_media_bytes(
        &self,
        slot: usize,
        expected_bytes: u64,
        expected_digest: [u8; 32],
    ) -> io::Result<SourceBytes> {
        match &self.media {
            MediaBacking::Capture(capture) => {
                let (arena, range) = capture.arena_range(slot, expected_bytes, expected_digest)?;
                Ok(self.arena_bytes(&arena, range))
            }
            MediaBacking::Restored(entries) => {
                let entry = entries.get(slot).ok_or_else(invalid)?;
                if entry.digest != expected_digest
                    || entry.range.end.checked_sub(entry.range.start) != Some(expected_bytes)
                {
                    return Err(invalid());
                }
                Ok(self.bytes(entry.range.clone()))
            }
            MediaBacking::None => Err(invalid()),
        }
    }
    async fn read(&self, offset: u64) -> io::Result<Record> {
        let bytes = self
            .arena
            .read_control_owned::<RECORD_BYTES>(offset, self.owner.clone())
            .await?;
        Ok(std::array::from_fn(|i| {
            u64::from_le_bytes(bytes[i * 8..i * 8 + 8].try_into().unwrap())
        }))
    }
    async fn write(&self, record: Record) -> io::Result<u64> {
        self.arena
            .with_writer(move |writer| {
                let bytes: [u8; RECORD_BYTES] =
                    std::array::from_fn(|i| record[i / 8].to_le_bytes()[i % 8]);
                Ok(writer.append_bytes(&bytes)?.start)
            })
            .await
    }
    async fn table(&self, len: usize) -> io::Result<List> {
        let bytes = (len as u64).checked_mul(8).ok_or_else(overflow)?;
        let offset = self
            .arena
            .with_writer(move |w| Ok(w.reserve_zeroed(bytes)?.start))
            .await?;
        Ok(List { offset, len })
    }
    async fn put(&self, list: List, index: usize, offset: u64) -> io::Result<()> {
        self.arena
            .with_writer(move |w| w.write_at(list.offset + index as u64 * 8, &offset.to_le_bytes()))
            .await
    }
    async fn get(&self, list: List, index: usize) -> io::Result<Option<Record>> {
        if index >= list.len {
            return Ok(None);
        }
        let bytes = self
            .arena
            .read_control_owned::<8>(list.offset + index as u64 * 8, self.owner.clone())
            .await?;
        self.read(u64::from_le_bytes(bytes)).await.map(Some)
    }
    fn list<T: Decode>(&self, list: List) -> Arc<dyn RecipeSource<T>> {
        Arc::new(Indexed::<T> {
            store: self.clone(),
            list,
            _type: PhantomData,
        })
    }
}
#[derive(Clone)]
struct OwnedSource {
    source: SourceBytes,
    owner: Arc<dyn Send + Sync>,
}
impl ByteSource for OwnedSource {
    fn locator(&self) -> Option<SourceLocator> {
        match &self.source {
            SourceBytes::Source(source) => source.locator(),
            _ => None,
        }
    }
    fn len(&self) -> Option<u64> {
        self.source.len()
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(OwnedCursor {
            cursor: self.source.open(budget),
            owner: Arc::new(self.clone()),
        })
    }
    fn slice(&self, range: Range<u64>) -> io::Result<Arc<dyn ByteSource>> {
        Ok(Arc::new(Self {
            source: self.source.slice(range)?,
            owner: self.owner.clone(),
        }))
    }
}
struct OwnedCursor {
    cursor: Box<dyn ByteCursor>,
    owner: Arc<OwnedSource>,
}
impl ByteCursor for OwnedCursor {
    fn read_chunk(&mut self, buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            let mut read = self.cursor.read_chunk(buffer).await?;
            read.buffer = read.buffer.retain_owner(self.owner.clone());
            Ok(read)
        })
    }
}
fn overflow() -> io::Error {
    io::Error::other("canonical prompt offset overflow")
}
fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid canonical prompt layout",
    )
}

/// Positions describe bytes only. Storage custody and pinning belong to the caller.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Layout {
    pub version: u32,
    pub message_count: usize,
    pub index_offset: u64,
    pub byte_len: u64,
    pub identity: String,
    pub breakdown: PreparedContextBreakdown,
}
pub(crate) struct CapturedPrompt {
    pub prompt: Prompt,
    pub layout: Layout,
    pub bytes: SourceBytes,
    pub resident_bytes: usize,
    pub media_arena: Option<CaptureArena>,
    pub media_entries: Vec<ExternalMediaEntry>,
}
pub(crate) struct Builder {
    store: Store,
    cancellation: CancellationToken,
    count: usize,
    tail: u64,
    last_non_system_stable: Option<bool>,
    mcp: McpSet,
    prefix: Sha256,
    breakdown: PreparedContextBreakdown,
}
impl Builder {
    pub async fn new(
        arena: CaptureArena,
        resources: ModelPreparationResources,
        preparation: Arc<RequestPreparation>,
        cancellation: CancellationToken,
    ) -> io::Result<Self> {
        Self::new_with_media(
            arena,
            MediaBacking::None,
            resources,
            preparation,
            cancellation,
        )
        .await
    }
    pub async fn new_external_media(
        arena: CaptureArena,
        media: Arc<MediaCapture>,
        resources: ModelPreparationResources,
        preparation: Arc<RequestPreparation>,
        cancellation: CancellationToken,
    ) -> io::Result<Self> {
        Self::new_with_media(
            arena,
            MediaBacking::Capture(media),
            resources,
            preparation,
            cancellation,
        )
        .await
    }
    async fn new_with_media(
        arena: CaptureArena,
        media: MediaBacking,
        resources: ModelPreparationResources,
        preparation: Arc<RequestPreparation>,
        cancellation: CancellationToken,
    ) -> io::Result<Self> {
        // No total length is known at this boundary; file backing keeps both
        // the append-only payload and its directory independent of heap limits.
        arena.promote_to_file().await?;
        let owner: Arc<dyn Send + Sync> =
            Arc::new(preparation.plan_directory(Self::resident_bytes())?);
        let mut prefix = Sha256::new();
        prefix.update(b"maka.logical-prefix\0");
        Ok(Self {
            store: Store {
                arena,
                media,
                resources,
                owner,
                inspection: true,
            },
            cancellation,
            count: 0,
            tail: u64::MAX,
            last_non_system_stable: None,
            mcp: McpSet::default(),
            prefix,
            breakdown: PreparedContextBreakdown::default(),
        })
    }
    pub fn has_non_system_messages(&self) -> bool {
        self.last_non_system_stable.is_some()
    }
    pub fn needs_continuation_cue(&self) -> bool {
        self.last_non_system_stable == Some(false)
    }
    pub fn resident_bytes() -> usize {
        std::mem::size_of::<Self>() + std::mem::size_of::<Directory>() + 4096
    }
    pub async fn append(&mut self, message: Message, is_pinned_memory: bool) -> io::Result<()> {
        self.check()?;
        let budget = self.acquire_budget().await?;
        let buffer = budget.allocate(4096).await?;
        let range = self
            .store
            .arena
            .with_writer(move |writer| {
                let start = writer.position();
                let mut output = BufferedWriter {
                    writer,
                    buffer,
                    filled: 0,
                };
                serde_json::to_writer(&mut output, &message).map_err(io::Error::other)?;
                std::io::Write::flush(&mut output)?;
                Ok(start..output.writer.position())
            })
            .await?;
        drop(budget);
        self.capture(range, None, is_pinned_memory).await
    }
    pub async fn append_recipe(&mut self, message: &MessageRecipe) -> io::Result<()> {
        self.check()?;
        let budget = self.acquire_budget().await?;
        let mut emit = super::serialize_source::ArenaEmit::new(
            self.store.arena.clone(),
            &budget,
            &self.cancellation,
        )
        .await?;
        let start = emit.position();
        match &self.store.media {
            MediaBacking::Capture(capture) => {
                let mut externalizer = MediaCaptureExternalizer(capture.clone());
                super::serialize_source::exact_message_async_with_media(
                    message,
                    &budget,
                    &self.cancellation,
                    &mut emit,
                    Some(&mut externalizer),
                )
                .await?;
            }
            MediaBacking::None | MediaBacking::Restored(_) => {
                super::serialize_source::exact_message_async(
                    message,
                    &budget,
                    &self.cancellation,
                    &mut emit,
                )
                .await?;
            }
        }
        let end = emit.position();
        emit.finish().await?;
        drop(budget);
        self.capture(start..end, Some(message), message.is_pinned_memory())
            .await
    }
    async fn acquire_budget(&self) -> io::Result<Arc<dyn SourceBudget>> {
        tokio::select! {
            biased;
            _ = self.cancellation.cancelled() => Err(crate::preparation_cancelled("canonical capture cancelled")),
            work = self.store.resources.acquire_work() => Ok(work?.budget()),
        }
    }
    fn check(&self) -> io::Result<()> {
        if self.cancellation.is_cancelled() {
            Err(crate::preparation_cancelled("canonical capture cancelled"))
        } else {
            Ok(())
        }
    }
    async fn capture(
        &mut self,
        range: Range<u64>,
        original: Option<&MessageRecipe>,
        is_pinned_memory: bool,
    ) -> io::Result<()> {
        let budget = self.acquire_budget().await?;
        let store = self.store.clone();
        let mut record = index_message(&store, range, &budget, &self.cancellation).await?;
        mark_mcp(&store, record, &mut self.mcp, &budget, &self.cancellation).await?;
        if let Some(original) = original {
            preserve_decisions(&store, record, original, &budget, &self.cancellation).await?;
        }
        let recipe = MessageRecipe::decode(&store, record).await?;
        let description = super::measure_source::describe_backed(
            recipe,
            &budget,
            self.store.owner.clone(),
            &self.cancellation,
            &store,
        )
        .await?;
        let names = index_identifiers(
            &store,
            description.local_tool_names.as_ref(),
            &budget,
            &self.cancellation,
        )
        .await?;
        let settled = index_identifiers(
            &store,
            description.settled_tool_call_ids.as_ref(),
            &budget,
            &self.cancellation,
        )
        .await?;
        record[6] = names.offset;
        record[7] = names.len as u64;
        record[8] = settled.offset;
        record[9] = settled.len as u64;
        let message_role = role(record[2])?;
        if message_role != MessageRole::System {
            self.last_non_system_stable = Some(
                matches!(message_role, MessageRole::User | MessageRole::Tool)
                    || (message_role == MessageRole::Assistant
                        && (description.last_is_tool_result || description.is_native_checkpoint)),
            );
        }
        record[MESSAGE_FLAGS] = (u64::from(is_pinned_memory) * PINNED_MEMORY)
            | u64::from(description.last_is_tool_result)
            | (u64::from(description.is_native_checkpoint) << 1);
        put_digest(&mut record[11..15], description.commitment);
        self.prefix.update(description.commitment);
        put_digest(&mut record[15..19], self.prefix.clone().finalize().into());
        record[19] = self.tail;
        self.tail = self.store.write(record).await?;
        self.count = self.count.checked_add(1).ok_or_else(overflow)?;
        self.breakdown.accumulate(&description.breakdown);
        Ok(())
    }
    pub async fn finish_captured(self) -> io::Result<CapturedPrompt> {
        self.check()?;
        let table = self.store.table(self.count).await?;
        let mut tail = self.tail;
        for index in (0..self.count).rev() {
            self.store.put(table, index, tail).await?;
            tail = self.store.read(tail).await?[19];
        }
        let byte_len = self.store.arena.with_writer(|w| Ok(w.position())).await?;
        self.store.arena.seal().await?;
        let (version, media_arena, media_entries, media_dir_bytes) = match &self.store.media {
            MediaBacking::Capture(capture) => {
                let entries = capture.entries();
                let arena = capture.current_arena();
                let dir_bytes = capture.charged_bytes();
                if let Some(arena) = &arena {
                    arena.seal().await?;
                }
                (3, arena, entries, dir_bytes)
            }
            MediaBacking::None | MediaBacking::Restored(_) => (2, None, Vec::new(), 0),
        };
        let layout = Layout {
            version,
            message_count: self.count,
            index_offset: table.offset,
            byte_len,
            identity: hex::encode(self.prefix.finalize()),
            breakdown: self.breakdown,
        };
        let mut store = self.store;
        store.inspection = false;
        let bytes = store.bytes(0..byte_len);
        let prompt = make_prompt(store, &layout);
        let resident_bytes = Self::resident_bytes()
            .checked_add(media_dir_bytes)
            .ok_or_else(overflow)?;
        Ok(CapturedPrompt {
            prompt,
            layout,
            bytes,
            resident_bytes,
            media_arena,
            media_entries,
        })
    }
}
/// Verify every external media record in the prompt directory against `expected_media`
/// (slot bounds, SHA-256 digest, byte length) and reject unreferenced trailing media slots.
/// Reads only fixed-size directory records, before any external media payload is copied.
pub(crate) async fn validate_external_media_directory(
    arena: &CaptureArena,
    layout: &Layout,
    expected_media: &[([u8; 32], u64)],
    cancellation: &CancellationToken,
) -> io::Result<()> {
    let valid_version = (layout.version == 2 && expected_media.is_empty()) || layout.version == 3;
    if !valid_version {
        return Err(invalid());
    }
    let owner: Arc<dyn Send + Sync> = Arc::new(());
    async fn read_record(
        arena: &CaptureArena,
        offset: u64,
        byte_len: u64,
        owner: &Arc<dyn Send + Sync>,
    ) -> io::Result<Record> {
        if offset
            .checked_add(RECORD_BYTES as u64)
            .is_none_or(|end| end > byte_len)
        {
            return Err(invalid());
        }
        let bytes = arena
            .read_control_owned::<RECORD_BYTES>(offset, owner.clone())
            .await?;
        Ok(std::array::from_fn(|i| {
            u64::from_le_bytes(bytes[i * 8..i * 8 + 8].try_into().unwrap())
        }))
    }
    async fn read_list_item(
        arena: &CaptureArena,
        list: List,
        index: usize,
        byte_len: u64,
        owner: &Arc<dyn Send + Sync>,
    ) -> io::Result<Record> {
        let entry_offset = list
            .offset
            .checked_add((index as u64).checked_mul(8).ok_or_else(overflow)?)
            .ok_or_else(overflow)?;
        if entry_offset.checked_add(8).is_none_or(|end| end > byte_len) {
            return Err(invalid());
        }
        let bytes = arena
            .read_control_owned::<8>(entry_offset, owner.clone())
            .await?;
        read_record(arena, u64::from_le_bytes(bytes), byte_len, owner).await
    }
    async fn check_content_list(
        arena: &CaptureArena,
        list: List,
        byte_len: u64,
        version: u32,
        expected_media: &[([u8; 32], u64)],
        referenced: &mut [bool],
        owner: &Arc<dyn Send + Sync>,
        cancellation: &CancellationToken,
    ) -> io::Result<()> {
        if list
            .offset
            .checked_add((list.len as u64).checked_mul(8).ok_or_else(overflow)?)
            .is_none_or(|end| end > byte_len)
        {
            return Err(invalid());
        }
        for i in 0..list.len {
            if cancellation.is_cancelled() {
                return Err(crate::preparation_cancelled(
                    "frozen prompt restore cancelled",
                ));
            }
            let r = read_list_item(arena, list, i, byte_len, owner).await?;
            match r[0] {
                1 | 2 => {}
                3 => {
                    if version != 3 {
                        return Err(invalid());
                    }
                    let slot = usize::try_from(r[1]).map_err(|_| invalid())?;
                    let expected_bytes = r[2];
                    let expected_digest = digest(&r[6..10]);
                    let (actual_digest, actual_bytes) =
                        expected_media.get(slot).ok_or_else(invalid)?;
                    if *actual_digest != expected_digest || *actual_bytes != expected_bytes {
                        return Err(invalid());
                    }
                    referenced[slot] = true;
                }
                _ => return Err(invalid()),
            }
        }
        Ok(())
    }

    let root = List {
        offset: layout.index_offset,
        len: layout.message_count,
    };
    if root
        .offset
        .checked_add((root.len as u64).checked_mul(8).ok_or_else(overflow)?)
        .is_none_or(|end| end > layout.byte_len)
    {
        return Err(invalid());
    }
    let mut referenced = vec![false; expected_media.len()];
    for msg_idx in 0..root.len {
        if cancellation.is_cancelled() {
            return Err(crate::preparation_cancelled(
                "frozen prompt restore cancelled",
            ));
        }
        let msg = read_list_item(arena, root, msg_idx, layout.byte_len, &owner).await?;
        let list = List {
            offset: msg[3],
            len: usize::try_from(msg[4]).map_err(|_| invalid())?,
        };
        match role(msg[2])? {
            MessageRole::System => {}
            MessageRole::User => {
                check_content_list(
                    arena,
                    list,
                    layout.byte_len,
                    layout.version,
                    expected_media,
                    &mut referenced,
                    &owner,
                    cancellation,
                )
                .await?;
            }
            MessageRole::Assistant => {
                if list
                    .offset
                    .checked_add((list.len as u64).checked_mul(8).ok_or_else(overflow)?)
                    .is_none_or(|end| end > layout.byte_len)
                {
                    return Err(invalid());
                }
                for item_idx in 0..list.len {
                    if cancellation.is_cancelled() {
                        return Err(crate::preparation_cancelled(
                            "frozen prompt restore cancelled",
                        ));
                    }
                    let item =
                        read_list_item(arena, list, item_idx, layout.byte_len, &owner).await?;
                    if item[0] == 7 && item[5] == 4 {
                        let content = List {
                            offset: item[6],
                            len: usize::try_from(item[7]).map_err(|_| invalid())?,
                        };
                        check_content_list(
                            arena,
                            content,
                            layout.byte_len,
                            layout.version,
                            expected_media,
                            &mut referenced,
                            &owner,
                            cancellation,
                        )
                        .await?;
                    }
                }
            }
            MessageRole::Tool => {
                if list
                    .offset
                    .checked_add((list.len as u64).checked_mul(8).ok_or_else(overflow)?)
                    .is_none_or(|end| end > layout.byte_len)
                {
                    return Err(invalid());
                }
                for item_idx in 0..list.len {
                    if cancellation.is_cancelled() {
                        return Err(crate::preparation_cancelled(
                            "frozen prompt restore cancelled",
                        ));
                    }
                    let item =
                        read_list_item(arena, list, item_idx, layout.byte_len, &owner).await?;
                    if item[5] == 4 {
                        let content = List {
                            offset: item[6],
                            len: usize::try_from(item[7]).map_err(|_| invalid())?,
                        };
                        check_content_list(
                            arena,
                            content,
                            layout.byte_len,
                            layout.version,
                            expected_media,
                            &mut referenced,
                            &owner,
                            cancellation,
                        )
                        .await?;
                    }
                }
            }
        }
    }
    if referenced.iter().any(|&used| !used) {
        return Err(invalid());
    }
    Ok(())
}

pub(crate) async fn restore(
    arena: CaptureArena,
    resources: ModelPreparationResources,
    layout: Layout,
    media: Arc<[RestoredMediaEntry]>,
) -> io::Result<Prompt> {
    let valid_version = (layout.version == 2 && media.is_empty()) || layout.version == 3;
    if !valid_version
        || layout
            .index_offset
            .checked_add(
                (layout.message_count as u64)
                    .checked_mul(8)
                    .ok_or_else(overflow)?,
            )
            .is_none_or(|end| end > layout.byte_len)
    {
        return Err(invalid());
    }
    let available = arena.with_writer(|writer| Ok(writer.position())).await?;
    if layout.byte_len > available {
        return Err(invalid());
    }
    for entry in media.iter() {
        if entry.range.start < layout.byte_len
            || entry.range.start > entry.range.end
            || entry.range.end > available
        {
            return Err(invalid());
        }
    }
    arena.seal().await?;
    Ok(make_prompt(
        Store {
            arena,
            media: if media.is_empty() {
                MediaBacking::None
            } else {
                MediaBacking::Restored(media)
            },
            resources,
            owner: Arc::new(()),
            inspection: false,
        },
        &layout,
    ))
}
fn make_prompt(store: Store, layout: &Layout) -> Prompt {
    let directory = Directory {
        store,
        list: List {
            offset: layout.index_offset,
            len: layout.message_count,
        },
    };
    Prompt::from_recipes(
        Arc::new(directory),
        layout.identity.clone(),
        layout.message_count,
        layout.breakdown.clone(),
    )
}
fn put_digest(words: &mut [u64], digest: [u8; 32]) {
    for (word, bytes) in words.iter_mut().zip(digest.as_chunks::<8>().0) {
        *word = u64::from_le_bytes(*bytes);
    }
}
fn digest(words: &[u64]) -> [u8; 32] {
    std::array::from_fn(|i| words[i / 8].to_le_bytes()[i % 8])
}

trait Decode: Send + Sync + Sized + 'static {
    fn decode<'a>(
        store: &'a Store,
        record: Record,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = io::Result<Self>> + Send + 'a>>;
}
struct Indexed<T> {
    store: Store,
    list: List,
    _type: PhantomData<T>,
}
impl<T: Decode> RecipeSource<T> for Indexed<T> {
    fn len(&self) -> usize {
        self.list.len
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<T>> {
        Box::new(Cursor::<T> {
            store: self.store.clone(),
            list: self.list,
            index: start,
            _type: PhantomData,
        })
    }
}
struct Cursor<T> {
    store: Store,
    list: List,
    index: usize,
    _type: PhantomData<T>,
}
impl<T: Decode> RecipeCursor<T> for Cursor<T> {
    fn next(&mut self) -> NextRecipe<'_, T> {
        Box::pin(async move {
            let Some(record) = self.store.get(self.list, self.index).await? else {
                return Ok(None);
            };
            let value = T::decode(&self.store, record).await?;
            self.index += 1;
            Ok(Some(value))
        })
    }
}
struct Directory {
    store: Store,
    list: List,
}
impl RecipeSource<MessageRecipe> for Directory {
    fn len(&self) -> usize {
        self.list.len
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<MessageRecipe>> {
        self.store.list::<MessageRecipe>(self.list).open(start)
    }
}
impl MessageSource for Directory {
    fn open_metadata(&self, start: usize) -> Box<dyn RecipeCursor<MessageMetadata>> {
        Box::new(MetadataCursor {
            store: self.store.clone(),
            list: self.list,
            index: start,
        })
    }
}
struct MetadataCursor {
    store: Store,
    list: List,
    index: usize,
}
impl RecipeCursor<MessageMetadata> for MetadataCursor {
    fn next(&mut self) -> NextRecipe<'_, MessageMetadata> {
        Box::pin(async move {
            let Some(record) = self.store.get(self.list, self.index).await? else {
                return Ok(None);
            };
            let result = MessageMetadata {
                message_index: self.index,
                is_pinned_memory: record[MESSAGE_FLAGS] & PINNED_MEMORY != 0,
                logical_identity: hex::encode(digest(&record[11..15])).into(),
                role: role(record[2])?,
                last_is_tool_result: (record[MESSAGE_FLAGS] & 1) != 0,
                is_native_checkpoint: (record[MESSAGE_FLAGS] & 2) != 0,
                local_tool_names: self.store.list(List {
                    offset: record[6],
                    len: record[7] as usize,
                }),
                settled_tool_call_ids: self.store.list(List {
                    offset: record[8],
                    len: record[9] as usize,
                }),
            };
            self.index += 1;
            Ok(Some(result))
        })
    }
}

struct BufferedWriter<'a> {
    writer: &'a mut super::request_backing::RequestBackingBuilder,
    buffer: ChargedBuffer,
    filled: usize,
}
impl std::io::Write for BufferedWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        let count = bytes.len().min(self.buffer.as_ref().len() - self.filled);
        if count == 0 {
            self.flush()?;
            return self.write(bytes);
        }
        self.buffer.as_mut()[self.filled..self.filled + count].copy_from_slice(&bytes[..count]);
        self.filled += count;
        Ok(count)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.writer
            .write_all(&self.buffer.as_ref()[..self.filled])?;
        self.filled = 0;
        Ok(())
    }
}
