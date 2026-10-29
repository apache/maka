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

//! Fixed-width message metadata alongside the same arena's numeric recipes.

use super::arena_recipes::{ArenaRecipes, List, Node, Record};
use maka_agent_facts::{context::PreparedContextBreakdown, model::prompt_source::source::*};
use sha2::{Digest, Sha256};
use std::{io, sync::Arc};
use tokio_util::sync::CancellationToken;

const METADATA: u64 = 11;
const IDENTIFIED_TEXT: u64 = 12;

pub(super) struct Builder {
    store: ArenaRecipes,
    recipes: List,
    metadata: List,
    position: usize,
    prefix: Sha256,
    totals: PreparedContextBreakdown,
}
impl Builder {
    pub async fn new(store: ArenaRecipes, messages: usize) -> io::Result<Self> {
        let recipes = store.begin_list(messages).await?;
        let metadata = store.begin_list(messages).await?;
        let mut prefix = Sha256::new();
        prefix.update(b"maka.logical-prefix\0");
        Ok(Self {
            store,
            recipes,
            metadata,
            position: 0,
            prefix,
            totals: PreparedContextBreakdown::default(),
        })
    }
    /// The producer can build a giant message directly into `store` and submit
    /// its numeric root; no complete message or part vector is retained here.
    pub async fn push(
        &mut self,
        recipe: Node,
        metadata: MessageMetadata,
        breakdown: &PreparedContextBreakdown,
        commitment: [u8; 32],
        budget: Arc<dyn SourceBudget>,
        cancellation: &CancellationToken,
    ) -> io::Result<()> {
        if self.position >= self.recipes.len {
            return Err(invalid("too many captured messages"));
        }
        let names = self
            .identifiers(
                metadata.local_tool_names.as_ref(),
                budget.clone(),
                cancellation,
            )
            .await?;
        let settled = self
            .identifiers(
                metadata.settled_tool_call_ids.as_ref(),
                budget,
                cancellation,
            )
            .await?;
        self.prefix.update(commitment);
        let prefix: [u8; 32] = self.prefix.clone().finalize().into();
        let mut record = Record::default();
        record[0] = METADATA;
        record[1] = match metadata.role {
            MessageRole::System => 0,
            MessageRole::User => 1,
            MessageRole::Assistant => 2,
            MessageRole::Tool => 3,
        };
        record[2] = u64::from(metadata.last_is_tool_result);
        record[3] = self.store.list_record(names).await?.0;
        record[4] = self.store.list_record(settled).await?.0;
        encode_digest(&mut record[5..9], commitment);
        encode_digest(&mut record[9..13], prefix);
        let metadata = self.store.record(record).await?;
        self.store.put(self.recipes, self.position, recipe).await?;
        self.store
            .put(self.metadata, self.position, metadata)
            .await?;
        self.totals.accumulate(breakdown);
        self.position += 1;
        Ok(())
    }
    async fn identifiers(
        &self,
        source: &dyn RecipeSource<IdentifiedText>,
        budget: Arc<dyn SourceBudget>,
        cancel: &CancellationToken,
    ) -> io::Result<List> {
        let list = self.store.begin_list(source.len()).await?;
        let mut cursor = source.open(0);
        for index in 0..list.len {
            let identified = cursor
                .next()
                .await?
                .ok_or_else(|| invalid("identifier directory shortened"))?;
            let text = self
                .store
                .text(identified.text, budget.clone(), cancel)
                .await?;
            let mut record = Record::default();
            record[0] = IDENTIFIED_TEXT;
            record[1] = text.0;
            encode_digest(&mut record[2..6], identified.identity);
            let node = self.store.record(record).await?;
            self.store.put(list, index, node).await?;
        }
        if cursor.next().await?.is_some() {
            return Err(invalid("identifier directory grew"));
        }
        Ok(list)
    }
    pub fn finish(self) -> io::Result<ArenaDirectory> {
        let identity = hex::encode(self.prefix.finalize());
        let recipes = self.store.messages(self.recipes.range(0..self.position)?);
        Ok(ArenaDirectory(Arc::new(Directory {
            store: self.store,
            recipes,
            metadata: self.metadata.range(0..self.position)?,
            totals: self.totals,
            identity,
        })))
    }
}
#[derive(Clone)]
pub(super) struct ArenaDirectory(Arc<Directory>);
struct Directory {
    store: ArenaRecipes,
    recipes: Arc<dyn RecipeSource<MessageRecipe>>,
    metadata: List,
    totals: PreparedContextBreakdown,
    identity: String,
}
impl ArenaDirectory {
    pub fn metadata_bytes() -> usize {
        std::mem::size_of::<Directory>() + 2 * std::mem::size_of::<usize>() + 64
    }
    pub fn identity(&self) -> &str {
        &self.0.identity
    }
    pub fn breakdown(&self) -> &PreparedContextBreakdown {
        &self.0.totals
    }
    async fn record(&self, index: usize) -> io::Result<Option<Record>> {
        let Some(node) = self.0.store.get(self.0.metadata, index).await? else {
            return Ok(None);
        };
        let record = self.0.store.read(node).await?;
        if record[0] != METADATA {
            return Err(invalid("expected message metadata"));
        }
        Ok(Some(record))
    }
    async fn identifiers(&self, node: Node) -> io::Result<Arc<dyn RecipeSource<IdentifiedText>>> {
        let list = self.0.store.read_list(node).await?;
        Ok(Arc::new(Identifiers {
            store: self.0.store.clone(),
            list,
        }))
    }
}
impl RecipeSource<MessageRecipe> for ArenaDirectory {
    fn len(&self) -> usize {
        self.0.recipes.len()
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<MessageRecipe>> {
        self.0.recipes.open(start)
    }
}
impl MessageSource for ArenaDirectory {
    fn open_metadata(&self, start: usize) -> Box<dyn RecipeCursor<MessageMetadata>> {
        Box::new(MetadataCursor {
            directory: self.clone(),
            index: start,
        })
    }
    fn prefix_identity(&self, messages: usize) -> RecipeIdentity<'_> {
        Box::pin(async move {
            if messages == 0 {
                let mut hash = Sha256::new();
                hash.update(b"maka.logical-prefix\0");
                return Ok(hex::encode(hash.finalize()));
            }
            let record = self
                .record(messages - 1)
                .await?
                .ok_or_else(|| invalid("logical prefix exceeds arena directory"))?;
            Ok(hex::encode(decode_digest(&record[9..13])))
        })
    }
}
struct MetadataCursor {
    directory: ArenaDirectory,
    index: usize,
}
impl RecipeCursor<MessageMetadata> for MetadataCursor {
    fn next(&mut self) -> NextRecipe<'_, MessageMetadata> {
        Box::pin(async move {
            let Some(r) = self.directory.record(self.index).await? else {
                return Ok(None);
            };
            let role = match r[1] {
                0 => MessageRole::System,
                1 => MessageRole::User,
                2 => MessageRole::Assistant,
                3 => MessageRole::Tool,
                _ => return Err(invalid("unknown frozen role")),
            };
            let metadata = MessageMetadata {
                message_index: self.index,
                logical_identity: hex::encode(decode_digest(&r[5..9])).into(),
                role,
                last_is_tool_result: r[2] != 0,
                local_tool_names: self.directory.identifiers(Node(r[3])).await?,
                settled_tool_call_ids: self.directory.identifiers(Node(r[4])).await?,
            };
            self.index += 1;
            Ok(Some(metadata))
        })
    }
}
struct Identifiers {
    store: ArenaRecipes,
    list: List,
}
impl RecipeSource<IdentifiedText> for Identifiers {
    fn len(&self) -> usize {
        self.list.len
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<IdentifiedText>> {
        Box::new(IdentifierCursor {
            store: self.store.clone(),
            list: self.list,
            index: start,
        })
    }
}
struct IdentifierCursor {
    store: ArenaRecipes,
    list: List,
    index: usize,
}
impl RecipeCursor<IdentifiedText> for IdentifierCursor {
    fn next(&mut self) -> NextRecipe<'_, IdentifiedText> {
        Box::pin(async move {
            let Some(node) = self.store.get(self.list, self.index).await? else {
                return Ok(None);
            };
            let r = self.store.read(node).await?;
            if r[0] != IDENTIFIED_TEXT {
                return Err(invalid("expected identified text"));
            }
            let text = self.store.read_text(Node(r[1])).await?;
            self.index += 1;
            Ok(Some(IdentifiedText {
                text,
                identity: decode_digest(&r[2..6]),
            }))
        })
    }
}
fn encode_digest(words: &mut [u64], digest: [u8; 32]) {
    for (word, bytes) in words.iter_mut().zip(digest.as_chunks::<8>().0.iter()) {
        *word = u64::from_le_bytes(*bytes);
    }
}
fn decode_digest(words: &[u64]) -> [u8; 32] {
    let mut digest = [0; 32];
    for (bytes, word) in digest.as_chunks_mut::<8>().0.iter_mut().zip(words) {
        bytes.copy_from_slice(&word.to_le_bytes());
    }
    digest
}
fn invalid(reason: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason)
}
