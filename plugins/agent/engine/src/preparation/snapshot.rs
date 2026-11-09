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

//! Immutable final logical recipes, persisted and restored without flattening.
use super::PreparationIo;
use crate::{
    RunError,
    history::{
        canonical_prompt::{self, Builder, Layout},
        capture_arena::CaptureArena,
        preparation::RequestPreparation,
    },
    prepared_prompt::PreparedPrompt,
};
use maka_agent_facts::{
    durable::{ContentRef, RunId},
    model::prompt_source::source::{
        ChargedBuffer, MessageMetadata, MessageRecipe, MessageSource, NextRecipe, RecipeCursor,
        RecipeIdentity, RecipeSource, SourceBytes,
    },
};
use maka_agent_state::{
    ContentBlob, ImmutableContentBody,
    session_history::{HistoryCut, SessionHistory},
};
use maka_model::{DirectoryLease, ModelPreparationResources, prompt::Prompt};
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    io::{self, Read, Write},
    pin::Pin,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

pub type FrozenPromptCleanup = Pin<Box<dyn Future<Output = Result<(), RunError>> + Send + 'static>>;

pub struct FrozenPrompt {
    pub content: ContentBlob,
    pub layout: Layout,
    cleanup: FrozenPromptCleanup,
}
impl FrozenPrompt {
    pub fn into_parts(self) -> (ContentBlob, Layout, FrozenPromptCleanup) {
        (self.content, self.layout, self.cleanup)
    }
}

struct Staging {
    preparation: Arc<RequestPreparation>,
    directory: DirectoryLease,
    resident_bytes: usize,
}
async fn staging(
    resources: &ModelPreparationResources,
    cancellation: &CancellationToken,
) -> Result<Staging, RunError> {
    let metadata = CaptureArena::metadata_bytes()
        + RequestPreparation::metadata_bytes()
        + std::mem::size_of::<ArenaBody>()
        + std::mem::size_of::<ArenaReader<'static>>()
        + 4 * std::mem::size_of::<usize>();
    let resident_bytes = metadata
        .checked_add(Builder::resident_bytes())
        .ok_or_else(overflow)?;
    let staged = tokio::select! {
        biased;
        _=cancellation.cancelled()=>return Err(RunError::Cancelled),
        staged=resources.reserve_staging(resident_bytes)=>staged?,
    };
    let preparation = RequestPreparation::new(staged);
    let directory = preparation.plan_directory(metadata)?;
    Ok(Staging {
        preparation,
        directory,
        resident_bytes,
    })
}

pub async fn snapshot_prompt(
    io: PreparationIo,
    resources: ModelPreparationResources,
    prompt: &Prompt,
    cancellation: &CancellationToken,
) -> Result<FrozenPrompt, RunError> {
    let source = prompt.recipes().ok_or_else(|| {
        RunError::Internal("snapshot requires final source-backed prompt recipes".into())
    })?;
    let staging = staging(&resources, cancellation).await?;
    let arena = CaptureArena::new(io.clone(), None).await?;
    let result = async {
        let mut builder = Builder::new(
            arena.clone(),
            resources.clone(),
            staging.preparation.clone(),
            cancellation.clone(),
        )
        .await?;
        let mut cursor = source.open(0);
        while let Some(message) = cursor.next().await? {
            check(cancellation)?;
            builder.append_recipe(&message).await?;
        }
        let captured = builder.finish_captured().await?;
        let work = tokio::select! {
            biased;
            _=cancellation.cancelled()=>return Err(RunError::Cancelled),
            work=resources.acquire_work()=>work?,
        };
        let budget = work.budget();
        let mut reader = captured.bytes.open(budget.clone());
        let mut buffer = budget.allocate(32 * 1024).await?;
        let mut hash = Sha256::new();
        let mut bytes = 0u64;
        loop {
            check(cancellation)?;
            let read = reader.read_chunk(buffer).await?;
            hash.update(&read.buffer.as_ref()[..read.bytes_read]);
            bytes = bytes
                .checked_add(read.bytes_read as u64)
                .ok_or_else(overflow)?;
            buffer = read.buffer;
            if read.eof {
                break;
            }
            if read.bytes_read == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "frozen prompt source made no progress",
                )
                .into());
            }
        }
        if bytes != captured.layout.byte_len {
            return Err(invalid("frozen prompt length changed").into());
        }
        let reference = ContentRef {
            digest: format!("sha256:{}", hex::encode(hash.finalize())),
            bytes,
        };
        let (released, done) = tokio::sync::oneshot::channel();
        let cleanup_arena = arena.clone();
        let cleanup_preparation = staging.preparation.clone();
        let cleanup: FrozenPromptCleanup = Box::pin(async move {
            let released = done.await;
            let closed = cleanup_arena.close().await;
            drop(cleanup_preparation);
            closed.map_err(RunError::PreparationCleanup)?;
            released.map_err(|_| {
                RunError::Internal("frozen prompt body release signal was lost".into())
            })
        });
        let body = ArenaBody {
            arena: arena.clone(),
            bytes,
            access: Mutex::new(()),
            _io: io,
            _preparation: staging.preparation,
            _directory: staging.directory,
            _source: captured.bytes,
            released: Some(released),
        };
        Ok(FrozenPrompt {
            content: ContentBlob::prepared(reference, Arc::new(body))?,
            layout: captured.layout,
            cleanup,
        })
    }
    .await;
    close_failed(&arena, result).await
}

pub enum ContentSource<'a> {
    Live {
        history: &'a SessionHistory,
        cut: &'a HistoryCut,
    },
    Snapshot(&'a maka_agent_state::session_history::snapshot::Snapshot),
}

pub async fn restore_prompt(
    io: PreparationIo,
    resources: ModelPreparationResources,
    history: &SessionHistory,
    cut: &HistoryCut,
    run: RunId,
    reference: &ContentRef,
    layout: &Layout,
    cancellation: &CancellationToken,
) -> Result<PreparedPrompt, RunError> {
    restore_prompt_from(
        io,
        resources,
        ContentSource::Live { history, cut },
        run,
        reference,
        layout,
        cancellation,
    )
    .await
}

pub async fn restore_prompt_from(
    io: PreparationIo,
    resources: ModelPreparationResources,
    source: ContentSource<'_>,
    run: RunId,
    reference: &ContentRef,
    layout: &Layout,
    cancellation: &CancellationToken,
) -> Result<PreparedPrompt, RunError> {
    reference
        .validate()
        .map_err(|reason| RunError::InvalidInput(reason.into()))?;
    if reference.bytes != layout.byte_len {
        return Err(RunError::InvalidInput(
            "frozen prompt manifest length differs from its content".into(),
        ));
    }
    let staging = staging(&resources, cancellation).await?;
    let arena = CaptureArena::new(io, None).await?;
    let result = async {
        let work = tokio::select! {
            biased;
            _=cancellation.cancelled()=>return Err(RunError::Cancelled),
            work=resources.acquire_work()=>work?,
        };
        let budget = work.budget();
        let buffer = budget.allocate(32 * 1024).await?;
        let copy_arena = arena.clone();
        let expected = reference.clone();
        let copy_cancellation = cancellation.clone();
        let consume = move |reader: &mut dyn Read| {
            Ok(copy_arena.with_writer_sync(|writer| {
                copy_content(reader, writer, buffer, &expected, &copy_cancellation)
            }))
        };
        let copied = match source {
            ContentSource::Live { history, cut } => {
                history.with_content(cut, run, reference, consume).await?
            }
            ContentSource::Snapshot(snapshot) => {
                snapshot.with_content(run, reference, consume).await?
            }
        };
        copied.map_err(RunError::preparation)?;
        drop((budget, work));
        check(cancellation)?;
        let source_directory = staging
            .preparation
            .plan_directory(Builder::resident_bytes())?;
        let body =
            canonical_prompt::restore(arena.clone(), resources.clone(), layout.clone()).await?;
        let source = body
            .recipes()
            .cloned()
            .ok_or_else(|| RunError::Internal("restored prompt lacks source recipes".into()))?;
        let source = ChargedSource {
            source,
            owner: Arc::new((staging.directory, source_directory)),
        };
        let body = Prompt::from_recipes(
            Arc::new(source),
            body.identity().to_owned(),
            body.len(),
            body.breakdown().clone(),
        );
        let prompt = PreparedPrompt::from_canonical(
            body,
            arena.clone(),
            resources,
            staging.preparation,
            staging.resident_bytes,
        );
        Ok(prompt)
    }
    .await;
    close_failed(&arena, result).await
}

fn copy_content(
    reader: &mut dyn Read,
    writer: &mut crate::history::request_backing::RequestBackingBuilder,
    mut buffer: ChargedBuffer,
    expected: &ContentRef,
    cancellation: &CancellationToken,
) -> io::Result<()> {
    if writer.position() != 0 {
        return Err(invalid("restored prompt arena is not empty"));
    }
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    loop {
        if cancellation.is_cancelled() {
            return Err(crate::preparation_cancelled(
                "frozen prompt restore cancelled",
            ));
        }
        let count = reader.read(buffer.as_mut())?;
        if count == 0 {
            break;
        }
        bytes = bytes.checked_add(count as u64).ok_or_else(overflow)?;
        if bytes > expected.bytes {
            return Err(invalid("frozen prompt exceeds its content reference"));
        }
        let chunk = &buffer.as_ref()[..count];
        hash.update(chunk);
        writer.write_all(chunk)?;
    }
    if bytes != expected.bytes
        || format!("sha256:{}", hex::encode(hash.finalize())) != expected.digest
    {
        return Err(invalid(
            "frozen prompt content digest or length differs from its reference",
        ));
    }
    Ok(())
}

struct ArenaBody {
    arena: CaptureArena,
    bytes: u64,
    access: Mutex<()>,
    _io: PreparationIo,
    _preparation: Arc<RequestPreparation>,
    _directory: DirectoryLease,
    _source: SourceBytes,
    released: Option<tokio::sync::oneshot::Sender<()>>,
}
impl Drop for ArenaBody {
    fn drop(&mut self) {
        // Borrowed readers cannot outlive this final content owner. CAS hits,
        // which need no reader at all, follow this same release boundary.
        let _ = self
            .released
            .take()
            .expect("live frozen prompt body")
            .send(());
    }
}
impl ImmutableContentBody for ArenaBody {
    fn reader(&self) -> io::Result<Box<dyn Read + Send + '_>> {
        Ok(Box::new(ArenaReader {
            body: self,
            position: 0,
        }))
    }
}
struct ArenaReader<'a> {
    body: &'a ArenaBody,
    position: u64,
}
impl Read for ArenaReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = (self.body.bytes - self.position).min(buffer.len() as u64) as usize;
        if count == 0 {
            return Ok(0);
        }
        let _access = self
            .body
            .access
            .lock()
            .map_err(|_| io::Error::other("frozen prompt reader lock poisoned"))?;
        self.body
            .arena
            .with_writer_sync(|writer| writer.read_exact_at(self.position, &mut buffer[..count]))?;
        self.position += count as u64;
        Ok(count)
    }
}

fn check(cancellation: &CancellationToken) -> Result<(), RunError> {
    if cancellation.is_cancelled() {
        Err(RunError::Cancelled)
    } else {
        Ok(())
    }
}
fn invalid(reason: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason)
}
fn overflow() -> io::Error {
    io::Error::other("frozen prompt size overflow")
}
async fn close_failed<T>(arena: &CaptureArena, result: Result<T, RunError>) -> Result<T, RunError> {
    match result {
        Ok(value) => Ok(value),
        Err(preparation) => match arena.close().await {
            Ok(()) => Err(preparation),
            Err(cleanup) => Err(RunError::PreparationCleanup(io::Error::other(
                CleanupError {
                    preparation,
                    cleanup,
                },
            ))),
        },
    }
}
#[derive(Debug)]
struct CleanupError {
    preparation: RunError,
    cleanup: io::Error,
}
impl std::fmt::Display for CleanupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}; closing frozen prompt also failed: {}",
            self.preparation, self.cleanup
        )
    }
}
impl std::error::Error for CleanupError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cleanup)
    }
}

struct ChargedSource {
    source: Arc<dyn MessageSource>,
    owner: Arc<(DirectoryLease, DirectoryLease)>,
}
impl RecipeSource<MessageRecipe> for ChargedSource {
    fn len(&self) -> usize {
        self.source.len()
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<MessageRecipe>> {
        Box::new(ChargedCursor {
            cursor: self.source.open(start),
            _owner: self.owner.clone(),
        })
    }
}
impl MessageSource for ChargedSource {
    fn open_metadata(&self, start: usize) -> Box<dyn RecipeCursor<MessageMetadata>> {
        Box::new(ChargedCursor {
            cursor: self.source.open_metadata(start),
            _owner: self.owner.clone(),
        })
    }
    fn prefix_identity(&self, messages: usize) -> RecipeIdentity<'_> {
        self.source.prefix_identity(messages)
    }
}
struct ChargedCursor<T> {
    cursor: Box<dyn RecipeCursor<T>>,
    _owner: Arc<(DirectoryLease, DirectoryLease)>,
}
impl<T: Send + 'static> RecipeCursor<T> for ChargedCursor<T> {
    fn next(&mut self) -> NextRecipe<'_, T> {
        self.cursor.next()
    }
}
