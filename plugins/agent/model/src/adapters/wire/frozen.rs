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

//! Request-owned replay directory and pull cursors.
use super::{
    WireEncoding, WireOptions, anthropic, chat_source, responses,
    source::{FragmentCursor, SourceItem},
};
use crate::{DirectoryLease, ModelError, ModelPreparationResources, WorkLease};
use bytes::Bytes;
use maka_agent_facts::model::prompt_source::{
    self as wire,
    source::{MessageSource, SourceBudget},
};
use sha2::{Digest, Sha256};
use std::{future::Future, pin::Pin, sync::Arc};

mod summary;
pub use summary::SummaryWireBound;

pub type WireWrite<'a> = Pin<Box<dyn Future<Output = Result<(), ModelError>> + Send + 'a>>;

/// Receives provider items directly into the request-owned backing arena.
pub trait WireSink: Send {
    /// Extra progress retained by this sink while the codec continues producing.
    fn extra_work_bytes(&self) -> usize {
        0
    }

    fn chunk(&mut self, chunk: wire::WireChunk, budget: Arc<dyn SourceBudget>) -> WireWrite<'_>;
    fn message_end(
        &mut self,
        message_index: usize,
        role: wire::source::MessageRole,
        prefix: [u8; 32],
    ) -> WireWrite<'_>;
}
pub struct EncodedWire {
    pub identity: String,
}

pub struct FrozenWire {
    pub source: Arc<dyn wire::WireSource>,
    pub identity: String,
}
struct Entry {
    message_index: usize,
    item: SourceItem,
}
struct Directory {
    entries: Vec<Entry>,
    starts: Vec<usize>,
    prefixes: Vec<[u8; 32]>,
    documents: Vec<usize>,
    source_identities: Arc<Identities>,
    resources: ModelPreparationResources,
    _lease: DirectoryLease,
}
fn error(error: std::io::Error) -> ModelError {
    ModelError::Adapter(error.to_string())
}
#[derive(Default, Clone, Copy, PartialEq, Eq)]
struct Shape {
    items: usize,
    retained: usize,
    documents: usize,
    source_ids: usize,
}
#[derive(Default, Clone, Copy, PartialEq, Eq)]
struct Counts {
    items: usize,
    retained: usize,
    documents: usize,
    systems: Shape,
    system_messages: usize,
    last: Shape,
    last_role: Option<maka_agent_facts::model::prompt_source::source::MessageRole>,
    source_ids: usize,
}
fn add(total: &mut usize, bytes: usize) -> Result<(), ModelError> {
    *total = total
        .checked_add(bytes)
        .ok_or_else(|| ModelError::Adapter("wire directory allocation size overflow".into()))?;
    Ok(())
}
fn array_bytes<T>(count: usize) -> Result<usize, ModelError> {
    count
        .checked_mul(std::mem::size_of::<T>())
        .ok_or_else(|| ModelError::Adapter("wire directory allocation size overflow".into()))
}
fn arc_bytes(size: usize, alignment: usize) -> Result<usize, ModelError> {
    let value = std::alloc::Layout::from_size_align(size, alignment)
        .map_err(|error| ModelError::Adapter(error.to_string()))?;
    let (layout, _) = std::alloc::Layout::new::<[usize; 2]>()
        .extend(value)
        .map_err(|error| ModelError::Adapter(error.to_string()))?;
    Ok(layout.pad_to_align().size())
}
impl Counts {
    fn item(&mut self, item: &SourceItem) -> Result<(), ModelError> {
        add(&mut self.items, 1)?;
        add(&mut self.retained, item.owned_bytes)?;
        add(
            &mut self.retained,
            arc_bytes(
                array_bytes::<super::source::SourceFragment>(item.fragments.len())?,
                std::mem::align_of::<super::source::SourceFragment>(),
            )?,
        )?;
        for fragment in item.fragments.iter() {
            match fragment {
                super::source::SourceFragment::OwnedLiteral { capacity, .. } => {
                    add(&mut self.retained, *capacity)?
                }
                super::source::SourceFragment::OwnedRaw { metadata_bytes, .. }
                | super::source::SourceFragment::OwnedJsonString { metadata_bytes, .. } => {
                    add(&mut self.retained, *metadata_bytes)?
                }
                _ => {}
            }
        }
        if let Some(wire::WireItemMetadata::Anthropic(metadata)) = &item.metadata {
            if metadata.document.is_some() {
                add(&mut self.documents, 1)?;
            }
            if metadata.source_id.is_some() {
                add(&mut self.source_ids, 1)?;
            }
            add(
                &mut self.retained,
                arc_bytes(
                    std::mem::size_of_val(metadata.as_ref()),
                    std::mem::align_of_val(metadata.as_ref()),
                )?,
            )?;
            add(&mut self.retained, metadata.local_allocation_bytes())?;
        }
        Ok(())
    }
    fn allocation(&self, messages: usize) -> Result<usize, ModelError> {
        let slots = messages
            .checked_add(1)
            .ok_or_else(|| ModelError::Adapter("wire message count overflow".into()))?;
        let mut bytes = self.retained;
        add(&mut bytes, array_bytes::<Entry>(self.items)?)?;
        add(&mut bytes, array_bytes::<usize>(slots)?)?;
        add(&mut bytes, array_bytes::<[u8; 32]>(slots)?)?;
        add(&mut bytes, array_bytes::<usize>(self.documents)?)?;
        add(&mut bytes, identities_allocation(self.source_ids)?)?;
        add(
            &mut bytes,
            arc_bytes(
                std::mem::size_of::<Directory>(),
                std::mem::align_of::<Directory>(),
            )?,
        )?;
        add(
            &mut bytes,
            arc_bytes(
                std::mem::size_of::<SharedDirectory>(),
                std::mem::align_of::<SharedDirectory>(),
            )?,
        )?;
        Ok(bytes)
    }
}
struct Builder {
    source_ids: Vec<[u8; 32]>,
    documents: Vec<usize>,
    entries: Vec<Entry>,
    starts: Vec<usize>,
    prefixes: Vec<[u8; 32]>,
    hash: Sha256,
    counts: Counts,
    expected: Counts,
}
struct BackedBuilder<'a> {
    output: &'a mut dyn WireSink,
    hash: Sha256,
    counts: Counts,
    expected: Counts,
}
enum Sink<'a> {
    Count(Counts),
    Build(Builder),
    Backed(BackedBuilder<'a>),
}
impl Sink<'_> {
    fn shape(&self) -> Shape {
        let count = match self {
            Self::Count(count) => count,
            Self::Build(build) => &build.counts,
            Self::Backed(build) => &build.counts,
        };
        Shape {
            items: count.items,
            retained: count.retained,
            documents: count.documents,
            source_ids: count.source_ids,
        }
    }
    fn begin(&mut self) {
        match self {
            Self::Count(_) => {}
            Self::Build(build) => {
                build.starts.push(build.entries.len());
                build.hash.update([0]);
            }
            Self::Backed(build) => build.hash.update([0]),
        }
    }
    async fn item(
        &mut self,
        message_index: usize,
        item: SourceItem,
        budget: Arc<dyn SourceBudget>,
    ) -> Result<(), ModelError> {
        match self {
            Self::Count(count) => count.item(&item),
            Self::Backed(build) => {
                build.counts.item(&item)?;
                check_count(&build.counts, &build.expected)?;
                build.hash.update([1]);
                let metadata = item.metadata.clone();
                let mut pump = ItemPump::new(item);
                let mut pending = pump.read(budget.clone()).await?;
                let mut first = true;
                loop {
                    let next = pump.read(budget.clone()).await?;
                    let item_end = next.is_none();
                    let bytes = pending.take().unwrap_or_default();
                    build.hash.update(&bytes);
                    build
                        .output
                        .chunk(
                            wire::WireChunk {
                                bytes,
                                item_start: first,
                                item_end,
                                message_index,
                                metadata: if first { metadata.clone() } else { None },
                            },
                            budget.clone(),
                        )
                        .await?;
                    if item_end {
                        break;
                    }
                    pending = next;
                    first = false;
                }
                build.hash.update([2]);
                Ok(())
            }
            Self::Build(build) => {
                build.counts.item(&item)?;
                check_count(&build.counts, &build.expected)?;
                build.hash.update([1]);
                let mut pump = ItemPump::new(item.clone());
                while let Some(bytes) = pump.read(budget.clone()).await? {
                    build.hash.update(&bytes);
                }
                build.hash.update([2]);
                if let Some(wire::WireItemMetadata::Anthropic(metadata)) = &item.metadata
                    && let Some(source_id) = &metadata.source_id
                {
                    build.source_ids.push(source_id.identity);
                }
                if matches!(&item.metadata,Some(wire::WireItemMetadata::Anthropic(metadata))if metadata.document.is_some())
                {
                    build.documents.push(build.entries.len());
                }
                build.entries.push(Entry {
                    message_index,
                    item,
                });
                Ok(())
            }
        }
    }
    async fn end(
        &mut self,
        message_index: usize,
        role: maka_agent_facts::model::prompt_source::source::MessageRole,
        before: Shape,
    ) -> Result<(), ModelError> {
        let after = self.shape();
        let current = Shape {
            items: after.items - before.items,
            retained: after.retained - before.retained,
            documents: after.documents - before.documents,
            source_ids: after.source_ids - before.source_ids,
        };
        let count = match self {
            Self::Count(count) => count,
            Self::Build(build) => {
                build.hash.update([3]);
                build.prefixes.push(build.hash.clone().finalize().into());
                &mut build.counts
            }
            Self::Backed(build) => {
                build.hash.update([3]);
                let prefix = build.hash.clone().finalize().into();
                build
                    .output
                    .message_end(message_index, role, prefix)
                    .await?;
                &mut build.counts
            }
        };
        count.last = current;
        count.last_role = Some(role);
        if role == maka_agent_facts::model::prompt_source::source::MessageRole::System {
            add(&mut count.systems.items, current.items)?;
            add(&mut count.systems.retained, current.retained)?;
            add(&mut count.systems.documents, current.documents)?;
            add(&mut count.systems.source_ids, current.source_ids)?;
            add(&mut count.system_messages, 1)?;
        }
        Ok(())
    }
}
async fn emit<'a>(
    encoding: &WireEncoding,
    source: &dyn MessageSource,
    budget: Arc<dyn SourceBudget>,
    mut sink: Sink<'a>,
    projection: chat_source::Projection,
) -> Result<Sink<'a>, ModelError> {
    let mut recipes = source.open(0);
    let mut metadata = source.open_metadata(0);
    let anthropic_compiler = match encoding.options.as_ref() {
        WireOptions::Anthropic(options) => {
            Some(anthropic::Compiler::new(options.clone(), encoding.language))
        }
        _ => None,
    };
    let mut chat_compiler = match encoding.options.as_ref() {
        WireOptions::Chat(options) => Some(match projection {
            chat_source::Projection::Generated => {
                chat_source::Compiler::new(options, encoding.language)
            }
            chat_source::Projection::Captured => {
                chat_source::Compiler::captured(options, encoding.language)
            }
        }),
        _ => None,
    };
    let mut next_recipe = recipes.next().await.map_err(error)?;
    for message_index in 0..source.len() {
        tokio::task::yield_now().await;
        let before = sink.shape();
        sink.begin();
        let recipe = next_recipe
            .take()
            .ok_or_else(|| ModelError::Adapter("truncated message recipe directory".into()))?;
        next_recipe = recipes.next().await.map_err(error)?;
        let last_tool = !matches!(
            &next_recipe,
            Some(maka_agent_facts::model::prompt_source::source::MessageRecipe::Tool { .. })
        );
        let message_metadata =
            metadata.next().await.map_err(error)?.ok_or_else(|| {
                ModelError::Adapter("truncated message metadata directory".into())
            })?;
        let role = message_metadata.role;
        match encoding.options.as_ref() {
            WireOptions::Chat(_) => {
                let mut cursor = chat_compiler.as_mut().expect("Chat compiler").open(
                    recipe,
                    last_tool,
                    budget.clone(),
                );
                let mut first = true;
                while let Some(mut item) = cursor.next().await? {
                    if first {
                        item.metadata =
                            Some(wire::WireItemMetadata::Message(message_metadata.clone()));
                        first = false;
                    }
                    sink.item(message_index, item, budget.clone()).await?;
                }
                if first {
                    sink.item(
                        message_index,
                        SourceItem {
                            fragments: Arc::from([]),
                            metadata: Some(wire::WireItemMetadata::Message(message_metadata)),
                            owned_bytes: 0,
                        },
                        budget.clone(),
                    )
                    .await?;
                }
            }
            WireOptions::Responses { plaintext, options } => {
                let mut cursor = responses::open(
                    recipe,
                    encoding.language,
                    *plaintext,
                    options,
                    budget.clone(),
                );
                let mut first = true;
                while let Some(mut item) = cursor.next().await? {
                    if first {
                        item.metadata =
                            Some(wire::WireItemMetadata::Message(message_metadata.clone()));
                        first = false;
                    }
                    sink.item(message_index, item, budget.clone()).await?;
                }
                if first {
                    sink.item(
                        message_index,
                        SourceItem {
                            fragments: Arc::from([]),
                            metadata: Some(wire::WireItemMetadata::Message(message_metadata)),
                            owned_bytes: 0,
                        },
                        budget.clone(),
                    )
                    .await?;
                }
            }
            WireOptions::Anthropic(_) => {
                let mut cursor = anthropic_compiler
                    .as_ref()
                    .expect("Anthropic compiler")
                    .open(recipe, budget.clone())
                    .await?;
                while let Some(item) = cursor.next().await? {
                    sink.item(message_index, item, budget.clone()).await?;
                }
            }
        }
        sink.end(message_index, role, before).await?;
    }
    Ok(sink)
}
pub struct WirePlan {
    pub(super) encoding: WireEncoding,
    source: Arc<dyn MessageSource>,
    counts: Counts,
    allocation: usize,
    projection: chat_source::Projection,
}
impl WirePlan {
    pub fn message_count(&self) -> usize {
        self.source.len()
    }
    pub fn item_count(&self) -> usize {
        self.counts.items
    }
    pub fn document_count(&self) -> usize {
        self.counts.documents
    }
    pub fn source_identity_count(&self) -> usize {
        self.counts.source_ids
    }
    pub fn initial_prefix(&self) -> [u8; 32] {
        initial_hash(&self.encoding).finalize().into()
    }
    pub async fn encode_to(
        &self,
        output: &mut dyn WireSink,
        resources: ModelPreparationResources,
    ) -> Result<EncodedWire, ModelError> {
        let work = resources
            .acquire_work_with_extra(output.extra_work_bytes())
            .await
            .map_err(error)?;
        let sink = Sink::Backed(BackedBuilder {
            output,
            hash: initial_hash(&self.encoding),
            counts: Counts::default(),
            expected: self.counts,
        });
        let Sink::Backed(build) = emit(
            &self.encoding,
            self.source.as_ref(),
            work.budget(),
            sink,
            self.projection,
        )
        .await?
        else {
            unreachable!("backed encoding pass")
        };
        if build.counts != self.counts {
            return Err(changed_plan());
        }
        Ok(EncodedWire {
            identity: hex_digest(build.hash.finalize().into()),
        })
    }
    pub fn allocation(&self) -> usize {
        self.allocation
    }
    pub fn codec(&self) -> &str {
        self.encoding.codec()
    }
    pub fn format(&self) -> wire::WireFormat {
        self.encoding.format()
    }
    pub async fn summary_fit_bound(
        &self,
        original_messages: usize,
        resources: ModelPreparationResources,
    ) -> Result<SummaryWireBound, ModelError> {
        summary::count(self, original_messages, resources).await
    }
}
pub(super) async fn count(
    encoding: WireEncoding,
    source: Arc<dyn MessageSource>,
    projection: chat_source::Projection,
    resources: ModelPreparationResources,
) -> Result<WirePlan, ModelError> {
    let work = resources.acquire_work().await.map_err(error)?;
    let budget = work.budget();
    let Sink::Count(counts) = emit(
        &encoding,
        source.as_ref(),
        budget,
        Sink::Count(Counts::default()),
        projection,
    )
    .await?
    else {
        unreachable!("count pass")
    };
    drop(work);
    let allocation = counts.allocation(source.len())?;
    Ok(WirePlan {
        encoding,
        source,
        counts,
        allocation,
        projection,
    })
}
pub(super) async fn build(
    plan: WirePlan,
    mut lease: DirectoryLease,
    resources: ModelPreparationResources,
) -> Result<FrozenWire, ModelError> {
    if lease.capacity() < plan.allocation {
        return Err(ModelError::Adapter(
            "prepaid wire directory lease is smaller than its counted envelope".into(),
        ));
    }
    let WirePlan {
        encoding,
        source,
        counts: count,
        projection,
        ..
    } = plan;
    let work = resources.acquire_work().await.map_err(error)?;
    let budget = work.budget();
    let hash = initial_hash(&encoding);
    let mut prefixes = Vec::with_capacity(source.len() + 1);
    prefixes.push(hash.clone().finalize().into());
    let identity_lease = lease
        .split(identities_allocation(count.source_ids)?)
        .map_err(error)?;
    let build = Builder {
        source_ids: Vec::with_capacity(count.source_ids),
        documents: Vec::with_capacity(count.documents),
        entries: Vec::with_capacity(count.items),
        starts: Vec::with_capacity(source.len() + 1),
        prefixes,
        hash,
        counts: Counts::default(),
        expected: count,
    };
    let Sink::Build(mut build) = emit(
        &encoding,
        source.as_ref(),
        budget,
        Sink::Build(build),
        projection,
    )
    .await?
    else {
        unreachable!("build pass")
    };
    if build.counts != count {
        return Err(ModelError::Adapter(
            "frozen wire plan changed between admission passes".into(),
        ));
    }
    anthropic::sort_source_identities(&mut build.source_ids).await;
    drop(work);
    let source_identities = Arc::new(Identities {
        values: build.source_ids,
        _lease: identity_lease,
    });
    build.starts.push(build.entries.len());
    let identity = hex_digest(*build.prefixes.last().expect("empty prefix exists"));
    Ok(FrozenWire {
        source: Arc::new(SharedDirectory(Arc::new(Directory {
            entries: build.entries,
            starts: build.starts,
            prefixes: build.prefixes,
            documents: build.documents,
            source_identities,
            resources,
            _lease: lease,
        }))),
        identity,
    })
}
fn initial_hash(encoding: &WireEncoding) -> Sha256 {
    let mut hash = Sha256::new();
    hash.update(b"maka-frozen-wire\0");
    hash.update(encoding.codec().as_bytes());
    hash
}
fn changed_plan() -> ModelError {
    ModelError::Adapter("frozen wire plan changed between admission passes".into())
}
fn check_count(actual: &Counts, expected: &Counts) -> Result<(), ModelError> {
    if actual.items > expected.items
        || actual.retained > expected.retained
        || actual.documents > expected.documents
        || actual.source_ids > expected.source_ids
    {
        return Err(changed_plan());
    }
    Ok(())
}
fn hex_digest(bytes: [u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut value = String::with_capacity(64);
    for byte in bytes {
        value.push(char::from(HEX[usize::from(byte >> 4)]));
        value.push(char::from(HEX[usize::from(byte & 15)]));
    }
    value
}

struct ItemPump {
    item: SourceItem,
    index: usize,
    current: Option<FragmentCursor>,
}
impl ItemPump {
    fn new(item: SourceItem) -> Self {
        Self {
            item,
            index: 0,
            current: None,
        }
    }
    async fn read(&mut self, budget: Arc<dyn SourceBudget>) -> Result<Option<Bytes>, ModelError> {
        loop {
            if let Some(current) = &mut self.current {
                if let Some(bytes) = current.next(budget.clone()).await.map_err(error)? {
                    if !bytes.is_empty() {
                        return Ok(Some(bytes));
                    }
                    continue;
                }
                self.current = None;
            }
            let Some(fragment) = self.item.fragments.get(self.index) else {
                return Ok(None);
            };
            self.index += 1;
            self.current = Some(FragmentCursor::new(fragment.clone()));
        }
    }
}
struct Identities {
    values: Vec<[u8; 32]>,
    _lease: DirectoryLease,
}
fn identities_allocation(count: usize) -> Result<usize, ModelError> {
    arc_bytes(
        std::mem::size_of::<Identities>(),
        std::mem::align_of::<Identities>(),
    )?
    .checked_add(array_bytes::<[u8; 32]>(count)?)
    .ok_or_else(|| ModelError::Adapter("source identity index size overflow".into()))
}
impl wire::SourceIdentityLookup for Identities {
    fn contains(&self, identity: [u8; 32], _budget: Arc<dyn SourceBudget>) -> wire::HasSource<'_> {
        Box::pin(async move { Ok(self.values.binary_search(&identity).is_ok()) })
    }
}
struct OutputBytes {
    bytes: Bytes,
    _directory: Arc<Directory>,
}
impl AsRef<[u8]> for OutputBytes {
    fn as_ref(&self) -> &[u8] {
        self.bytes.as_ref()
    }
}
struct Cursor {
    directory: Arc<Directory>,
    index: usize,
    pump: Option<ItemPump>,
    pending: Option<Bytes>,
    first: bool,
    work: Option<WorkLease>,
    budget: Option<Arc<dyn SourceBudget>>,
}
impl Cursor {
    fn new(directory: Arc<Directory>, index: usize) -> Self {
        Self {
            directory,
            index,
            pump: None,
            pending: None,
            first: true,
            work: None,
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
            if self.index >= self.directory.entries.len() {
                self.budget = None;
                self.work = None;
                return Ok(None);
            }
            if self.work.is_none() {
                let work = self
                    .directory
                    .resources
                    .acquire_work()
                    .await
                    .map_err(error)?;
                self.budget = Some(work.budget());
                self.work = Some(work);
            }
            let entry = &self.directory.entries[self.index];
            let budget = self.budget.as_ref().expect("active work budget");
            if self.pump.is_none() {
                self.pump = Some(ItemPump::new(entry.item.clone()));
                self.first = true;
            }
            let pump = self.pump.as_mut().expect("active item");
            let bytes = match self.pending.take() {
                Some(bytes) => Some(bytes),
                None => pump.read(budget.clone()).await?,
            };
            let next = pump.read(budget.clone()).await?;
            let item_end = next.is_none();
            self.pending = next;
            let item_start = std::mem::take(&mut self.first);
            let chunk = wire::WireChunk {
                bytes: bytes
                    .map(|bytes| {
                        Bytes::from_owner(OutputBytes {
                            bytes,
                            _directory: self.directory.clone(),
                        })
                    })
                    .unwrap_or_default(),
                item_start,
                item_end,
                message_index: entry.message_index,
                metadata: if item_start {
                    entry.item.metadata.clone()
                } else {
                    None
                },
            };
            if item_end {
                self.index += 1;
                self.pump = None;
            }
            Ok(Some(chunk))
        })
    }
}
#[derive(Clone)]
struct SharedDirectory(Arc<Directory>);
struct BudgetFactory(ModelPreparationResources);
impl maka_agent_facts::model::prompt_source::source::SourceBudgetFactory for BudgetFactory {
    fn acquire(&self) -> maka_agent_facts::model::prompt_source::source::AcquireBudget<'_> {
        Box::pin(async move { Ok(self.0.acquire_work().await?.budget()) })
    }
}
impl wire::WireSource for SharedDirectory {
    fn source_identities(&self) -> Option<Arc<dyn wire::SourceIdentityLookup>> {
        Some(self.0.source_identities.clone())
    }

    fn document_count(&self) -> usize {
        self.0.documents.len()
    }
    fn document(&self, index: usize, _budget: Arc<dyn SourceBudget>) -> wire::NextWireDocument<'_> {
        Box::pin(async move {
            let Some(entry) = self
                .0
                .documents
                .get(index)
                .and_then(|entry| self.0.entries.get(*entry))
            else {
                return Ok(None);
            };
            match &entry.item.metadata {
                Some(wire::WireItemMetadata::Anthropic(metadata)) => Ok(metadata.document.clone()),
                _ => Err(ModelError::Adapter("invalid frozen document index".into())),
            }
        })
    }

    fn budget_factory(
        &self,
    ) -> Option<Arc<dyn maka_agent_facts::model::prompt_source::source::SourceBudgetFactory>> {
        Some(Arc::new(BudgetFactory(self.0.resources.clone())))
    }
    fn acquire_budget(&self) -> wire::AcquireWireBudget<'_> {
        Box::pin(async move { Ok(self.0.resources.acquire_work().await?.budget()) })
    }
    fn open(&self, start: usize) -> Box<dyn wire::WireCursor> {
        Box::new(Cursor::new(
            self.0.clone(),
            self.0
                .starts
                .get(start)
                .copied()
                .unwrap_or(self.0.entries.len()),
        ))
    }
    fn open_at(&self, position: wire::WirePosition) -> Option<Box<dyn wire::WireCursor>> {
        let start = *self.0.starts.get(position.message_index)?;
        let end = *self.0.starts.get(position.message_index + 1)?;
        let index = start.checked_add(position.piece_index)?;
        (index < end)
            .then(|| Box::new(Cursor::new(self.0.clone(), index)) as Box<dyn wire::WireCursor>)
    }
    fn open_metadata(&self, start: usize) -> Option<Box<dyn wire::WireMetadataCursor>> {
        Some(Box::new(MetadataCursor {
            directory: self.0.clone(),
            index: self
                .0
                .starts
                .get(start)
                .copied()
                .unwrap_or(self.0.entries.len()),
        }))
    }
    fn prefix_identity(&self, messages: usize) -> wire::PrefixIdentity<'_> {
        Box::pin(async move { Ok(self.0.prefixes.get(messages).copied().map(hex_digest)) })
    }
}
struct MetadataCursor {
    directory: Arc<Directory>,
    index: usize,
}
impl wire::WireMetadataCursor for MetadataCursor {
    fn next(&mut self) -> wire::NextWireMetadata<'_> {
        Box::pin(async move {
            while let Some(entry) = self.directory.entries.get(self.index) {
                let index = self.index;
                self.index += 1;
                if let Some(metadata) = entry.item.metadata.clone() {
                    return Ok(Some(wire::WireMetadata {
                        position: wire::WirePosition {
                            message_index: entry.message_index,
                            piece_index: index - self.directory.starts[entry.message_index],
                        },
                        message_index: entry.message_index,
                        metadata,
                    }));
                }
            }
            Ok(None)
        })
    }
}
