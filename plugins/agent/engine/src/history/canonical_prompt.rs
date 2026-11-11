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
use super::{capture_arena::CaptureArena, preparation::RequestPreparation};
use maka_agent_facts::{context::PreparedContextBreakdown, model::prompt_source::source::*};
use maka_model::{
    ModelPreparationResources,
    prompt::{Message, Prompt},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io, marker::PhantomData, ops::Range, sync::Arc};
use tokio_util::sync::CancellationToken;
mod project;
pub(super) use project::IdentifierBuilder;
use project::*;

const WORDS: usize = 20;
const RECORD_BYTES: usize = WORDS * 8;
type Record = [u64; WORDS];
#[derive(Clone, Copy, Default)]
struct List {
    offset: u64,
    len: usize,
}
#[derive(Clone)]
pub(super) struct Store {
    arena: CaptureArena,
    resources: ModelPreparationResources,
    owner: Arc<dyn Send + Sync>,
    inspection: bool,
}
impl Store {
    fn bytes(&self, range: Range<u64>) -> SourceBytes {
        let source = if self.inspection {
            self.arena.inspect(range)
        } else {
            self.arena.pending(range)
        };
        SourceBytes::Source(Arc::new(OwnedSource {
            source,
            owner: self.owner.clone(),
        }))
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
}
pub(crate) struct Builder {
    store: Store,
    cancellation: CancellationToken,
    count: usize,
    tail: u64,
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
                resources,
                owner,
                inspection: true,
            },
            cancellation,
            count: 0,
            tail: u64::MAX,
            mcp: McpSet::default(),
            prefix,
            breakdown: PreparedContextBreakdown::default(),
        })
    }
    pub fn resident_bytes() -> usize {
        std::mem::size_of::<Self>() + std::mem::size_of::<Directory>() + 4096
    }
    pub async fn append(&mut self, message: Message) -> io::Result<()> {
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
        self.capture(range, None).await
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
        super::serialize_source::exact_message_async(
            message,
            &budget,
            &self.cancellation,
            &mut emit,
        )
        .await?;
        let end = emit.position();
        emit.finish().await?;
        drop(budget);
        self.capture(start..end, Some(message)).await
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
        record[10] = u64::from(description.last_is_tool_result);
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
        let layout = Layout {
            version: 2,
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
        Ok(CapturedPrompt {
            prompt,
            layout,
            bytes,
            resident_bytes: Self::resident_bytes(),
        })
    }
}
pub(crate) async fn restore(
    arena: CaptureArena,
    resources: ModelPreparationResources,
    layout: Layout,
) -> io::Result<Prompt> {
    if layout.version != 2
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
    arena.seal().await?;
    Ok(make_prompt(
        Store {
            arena,
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
                logical_identity: hex::encode(digest(&record[11..15])).into(),
                role: role(record[2])?,
                last_is_tool_result: record[10] != 0,
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
