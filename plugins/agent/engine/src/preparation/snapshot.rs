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
        canonical_prompt::{self, Builder, Layout, MediaCapture, RestoredMediaEntry},
        capture_arena::CaptureArena,
        preparation::RequestPreparation,
    },
    prepared_prompt::PreparedPrompt,
};
use maka_agent_facts::{
    durable::{ContentRef, RunId},
    model::prompt_source::source::{
        ChargedBuffer, MessageMetadata, MessageRecipe, MessageSource, NextRecipe, RecipeCursor,
        RecipeSource, SourceBytes,
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

// Prompts grow by appending, so consecutive steps share every full chunk and store only the
// last one anew. On a trial database 32 KiB stored about half of what 128 KiB did; 16 KiB
// saved little more while doubling the chunk list each step carries.
const CHUNK_BYTES: usize = 32 * 1024;

pub type FrozenPromptCleanup = Pin<Box<dyn Future<Output = Result<(), RunError>> + Send + 'static>>;

pub struct FrozenPrompt {
    reference: ContentRef,
    chunks: Vec<ContentBlob>,
    media: Vec<ContentBlob>,
    pub layout: Layout,
    cleanup: FrozenPromptCleanup,
}
impl FrozenPrompt {
    pub fn into_parts(
        self,
    ) -> (
        ContentRef,
        Vec<ContentBlob>,
        Vec<ContentBlob>,
        Layout,
        FrozenPromptCleanup,
    ) {
        (
            self.reference,
            self.chunks,
            self.media,
            self.layout,
            self.cleanup,
        )
    }
}

struct Staging {
    preparation: Arc<RequestPreparation>,
    directory: DirectoryLease,
    resident_bytes: usize,
}
async fn staging(
    resources: &ModelPreparationResources,
    extra_directory_bytes: usize,
    cancellation: &CancellationToken,
) -> Result<Staging, RunError> {
    let metadata = 2 * CaptureArena::metadata_bytes()
        + RequestPreparation::metadata_bytes()
        + std::mem::size_of::<ArenaBody>()
        + std::mem::size_of::<ArenaReader<'static>>()
        + 4 * std::mem::size_of::<usize>();
    let resident_bytes = metadata
        .checked_add(Builder::resident_bytes())
        .and_then(|bytes| bytes.checked_add(extra_directory_bytes))
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
    let staging = staging(&resources, 0, cancellation).await?;
    let arena = CaptureArena::new(io.clone(), None).await?;
    let media_capture = MediaCapture::new(io.clone(), staging.preparation.clone());
    let result = async {
        let mut builder = Builder::new_external_media(
            arena.clone(),
            media_capture.clone(),
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
        let mut chunks = Vec::new();
        let mut chunk_bytes = 0;
        let mut chunk_hash = Sha256::new();
        loop {
            check(cancellation)?;
            let read = reader.read_chunk(buffer).await?;
            let mut input = &read.buffer.as_ref()[..read.bytes_read];
            hash.update(input);
            while !input.is_empty() {
                let size = input.len().min(CHUNK_BYTES - chunk_bytes);
                let (head, tail) = input.split_at(size);
                chunk_hash.update(head);
                chunk_bytes += size;
                if chunk_bytes == CHUNK_BYTES {
                    chunks.push(ContentRef {
                        digest: format!(
                            "sha256:{}",
                            hex::encode(std::mem::take(&mut chunk_hash).finalize())
                        ),
                        bytes: chunk_bytes as u64,
                    });
                    chunk_bytes = 0;
                }
                input = tail;
            }
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
        if chunk_bytes != 0 || chunks.is_empty() {
            chunks.push(ContentRef {
                digest: format!("sha256:{}", hex::encode(chunk_hash.finalize())),
                bytes: chunk_bytes as u64,
            });
        }
        let (released, done) = tokio::sync::oneshot::channel();
        let cleanup_arena = arena.clone();
        let cleanup_media_arena = captured.media_arena.clone();
        let cleanup_preparation = staging.preparation.clone();
        let cleanup: FrozenPromptCleanup = Box::pin(async move {
            let released = done.await;
            let closed_main = cleanup_arena.close().await;
            let closed_media = match cleanup_media_arena {
                Some(media) => media.close().await,
                None => Ok(()),
            };
            drop(cleanup_preparation);
            closed_main.map_err(RunError::PreparationCleanup)?;
            closed_media.map_err(RunError::PreparationCleanup)?;
            released.map_err(|_| {
                RunError::Internal("frozen prompt body release signal was lost".into())
            })
        });
        let body = Arc::new(ArenaBody {
            arena: arena.clone(),
            media_arena: captured.media_arena,
            access: Mutex::new(()),
            _io: io,
            _preparation: staging.preparation,
            _directory: staging.directory,
            _source: captured.bytes,
            released: Some(released),
        });
        let mut start = 0;
        let chunks = chunks
            .into_iter()
            .map(|chunk| {
                let end = start + chunk.bytes;
                let data = ArenaChunk {
                    body: body.clone(),
                    start,
                    end,
                    media: false,
                };
                start = end;
                ContentBlob::prepared(chunk, Arc::new(data))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let media = captured
            .media_entries
            .into_iter()
            .map(|entry| {
                let data = ArenaChunk {
                    body: body.clone(),
                    start: entry.range.start,
                    end: entry.range.end,
                    media: true,
                };
                ContentBlob::prepared(entry.reference, Arc::new(data))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(FrozenPrompt {
            reference,
            chunks,
            media,
            layout: captured.layout,
            cleanup,
        })
    }
    .await;
    let media_arena = media_capture.current_arena();
    close_failed_arenas(&arena, media_arena.as_ref(), result).await
}

pub enum ContentSource<'a> {
    Live {
        history: &'a SessionHistory,
        cut: &'a HistoryCut,
    },
    Snapshot(&'a maka_agent_state::session_history::snapshot::Snapshot),
}

#[expect(
    clippy::too_many_arguments,
    reason = "Restoration requires the original history cut, content identity, chunks, media refs, layout, I/O owner and cancellation as independent inputs"
)]
pub async fn restore_prompt(
    io: PreparationIo,
    resources: ModelPreparationResources,
    history: &SessionHistory,
    cut: &HistoryCut,
    run: RunId,
    reference: &ContentRef,
    chunks: &[ContentRef],
    media: &[ContentRef],
    layout: &Layout,
    cancellation: &CancellationToken,
) -> Result<PreparedPrompt, RunError> {
    restore_prompt_from(
        io,
        resources,
        ContentSource::Live { history, cut },
        run,
        reference,
        chunks,
        media,
        layout,
        cancellation,
    )
    .await
}

#[expect(
    clippy::too_many_arguments,
    reason = "Restore preserves the original logical and stored content identities"
)]
pub async fn restore_prompt_from(
    io: PreparationIo,
    resources: ModelPreparationResources,
    source: ContentSource<'_>,
    run: RunId,
    reference: &ContentRef,
    chunks: &[ContentRef],
    media: &[ContentRef],
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
    match layout.version {
        2 if !media.is_empty() => {
            return Err(RunError::InvalidInput(
                "legacy v2 frozen prompt cannot carry external media references".into(),
            ));
        }
        2 | 3 => {}
        _ => {
            return Err(RunError::InvalidInput(
                "unsupported frozen prompt layout version".into(),
            ));
        }
    }
    let media_directory_bytes = media
        .len()
        .checked_mul(std::mem::size_of::<RestoredMediaEntry>())
        .ok_or_else(overflow)?;
    let staging = staging(&resources, media_directory_bytes, cancellation).await?;
    let media_directory = staging.preparation.plan_directory(media_directory_bytes)?;
    let mut expected_media = Vec::with_capacity(media.len());
    for part in media {
        part.validate()
            .map_err(|reason| RunError::InvalidInput(reason.into()))?;
        expected_media.push((decode_sha256_ref(&part.digest)?, part.bytes));
    }
    let arena = CaptureArena::new(io, None).await?;
    let result = async {
        let work = tokio::select! {
            biased;
            _=cancellation.cancelled()=>return Err(RunError::Cancelled),
            work=resources.acquire_work()=>work?,
        };
        let budget = work.budget();
        let mut buffer = budget.allocate(32 * 1024).await?;
        let mut hash = Sha256::new();
        let mut bytes = 0u64;
        let parts = if chunks.is_empty() {
            std::slice::from_ref(reference)
        } else {
            chunks
        };
        for part in parts {
            check(cancellation)?;
            let copy_arena = arena.clone();
            let expected = part.bytes;
            let copy_cancellation = cancellation.clone();
            bytes = bytes.checked_add(expected).ok_or_else(overflow)?;
            if bytes > reference.bytes {
                return Err(invalid("frozen prompt chunks exceed the original length").into());
            }
            let consume = move |reader: &mut dyn Read| {
                Ok(copy_arena
                    .with_writer_sync(|writer| {
                        copy_content(
                            reader,
                            writer,
                            &mut buffer,
                            expected,
                            &mut hash,
                            &copy_cancellation,
                        )
                    })
                    .map(|()| (buffer, hash)))
            };
            let copied = match &source {
                ContentSource::Live { history, cut } => {
                    history.with_content(cut, run, part, consume).await?
                }
                ContentSource::Snapshot(snapshot) => {
                    snapshot.with_content(run, part, consume).await?
                }
            };
            (buffer, hash) = copied.map_err(RunError::preparation)?;
        }
        if bytes != reference.bytes
            || format!("sha256:{}", hex::encode(hash.finalize())) != reference.digest
        {
            return Err(invalid(
                "frozen prompt content digest or length differs from its reference",
            )
            .into());
        }
        // Validate every record's media slot, digest, length, and exact coverage BEFORE
        // copying external media blobs into the arena or returning PreparedPrompt.
        canonical_prompt::validate_external_media_directory(
            &arena,
            layout,
            &expected_media,
            cancellation,
        )
        .await?;
        let mut restored_media = Vec::with_capacity(media.len());
        for (part, &(expected_digest, expected)) in media.iter().zip(expected_media.iter()) {
            check(cancellation)?;
            let start = arena.with_writer(|w| Ok(w.position())).await?;
            let copy_arena = arena.clone();
            let copy_cancellation = cancellation.clone();
            let mut media_hash = Sha256::new();
            let consume = move |reader: &mut dyn Read| {
                Ok(copy_arena
                    .with_writer_sync(|writer| {
                        copy_content(
                            reader,
                            writer,
                            &mut buffer,
                            expected,
                            &mut media_hash,
                            &copy_cancellation,
                        )
                    })
                    .map(|()| (buffer, media_hash)))
            };
            let copied = match &source {
                ContentSource::Live { history, cut } => {
                    history.with_content(cut, run, part, consume).await?
                }
                ContentSource::Snapshot(snapshot) => {
                    snapshot.with_content(run, part, consume).await?
                }
            };
            let (next_buffer, next_hash) = copied.map_err(RunError::preparation)?;
            buffer = next_buffer;
            let actual_digest: [u8; 32] = next_hash.finalize().into();
            if actual_digest != expected_digest {
                return Err(invalid(
                    "frozen prompt media content digest differs from its reference",
                )
                .into());
            }
            let end = start.checked_add(expected).ok_or_else(overflow)?;
            restored_media.push(RestoredMediaEntry {
                digest: actual_digest,
                range: start..end,
            });
        }
        drop(buffer);
        drop((budget, work));
        check(cancellation)?;
        let source_directory = staging
            .preparation
            .plan_directory(Builder::resident_bytes())?;
        let body = canonical_prompt::restore(
            arena.clone(),
            resources.clone(),
            layout.clone(),
            restored_media.into(),
        )
        .await?;
        let source = body
            .recipes()
            .cloned()
            .ok_or_else(|| RunError::Internal("restored prompt lacks source recipes".into()))?;
        let source = ChargedSource {
            source,
            owner: Arc::new((staging.directory, source_directory, media_directory)),
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
    buffer: &mut ChargedBuffer,
    expected: u64,
    hash: &mut Sha256,
    cancellation: &CancellationToken,
) -> io::Result<()> {
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
        if bytes > expected {
            return Err(invalid("frozen prompt exceeds its content reference"));
        }
        let chunk = &buffer.as_ref()[..count];
        hash.update(chunk);
        writer.write_all(chunk)?;
    }
    if bytes != expected {
        return Err(invalid(
            "frozen prompt chunk differs from its stored length",
        ));
    }
    Ok(())
}

fn decode_sha256_ref(digest: &str) -> io::Result<[u8; 32]> {
    let hex_part = digest
        .strip_prefix("sha256:")
        .ok_or_else(|| invalid("invalid sha256 content reference prefix"))?;
    let mut bytes = [0u8; 32];
    hex::decode_to_slice(hex_part, &mut bytes)
        .map_err(|_| invalid("invalid sha256 content reference digest"))?;
    Ok(bytes)
}

struct ArenaBody {
    arena: CaptureArena,
    media_arena: Option<CaptureArena>,
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
struct ArenaChunk {
    body: Arc<ArenaBody>,
    start: u64,
    end: u64,
    media: bool,
}
impl ImmutableContentBody for ArenaChunk {
    fn reader(&self) -> io::Result<Box<dyn Read + Send + '_>> {
        Ok(Box::new(ArenaReader {
            body: &self.body,
            position: self.start,
            end: self.end,
            media: self.media,
        }))
    }
}
struct ArenaReader<'a> {
    body: &'a ArenaBody,
    position: u64,
    end: u64,
    media: bool,
}
impl Read for ArenaReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = (self.end - self.position).min(buffer.len() as u64) as usize;
        if count == 0 {
            return Ok(0);
        }
        let _access = self
            .body
            .access
            .lock()
            .map_err(|_| io::Error::other("frozen prompt reader lock poisoned"))?;
        let target = if self.media {
            self.body
                .media_arena
                .as_ref()
                .ok_or_else(|| invalid("missing frozen prompt media arena"))?
        } else {
            &self.body.arena
        };
        target
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
    close_failed_arenas(arena, None, result).await
}
async fn close_failed_arenas<T>(
    arena: &CaptureArena,
    media_arena: Option<&CaptureArena>,
    result: Result<T, RunError>,
) -> Result<T, RunError> {
    match result {
        Ok(value) => Ok(value),
        Err(preparation) => {
            let main_close = arena.close().await;
            let media_close = match media_arena {
                Some(media) => media.close().await,
                None => Ok(()),
            };
            match main_close.and(media_close) {
                Ok(()) => Err(preparation),
                Err(cleanup) => Err(RunError::PreparationCleanup(io::Error::other(
                    CleanupError {
                        preparation,
                        cleanup,
                    },
                ))),
            }
        }
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
    owner: Arc<(DirectoryLease, DirectoryLease, DirectoryLease)>,
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
}
struct ChargedCursor<T> {
    cursor: Box<dyn RecipeCursor<T>>,
    _owner: Arc<(DirectoryLease, DirectoryLease, DirectoryLease)>,
}
impl<T: Send + 'static> RecipeCursor<T> for ChargedCursor<T> {
    fn next(&mut self) -> NextRecipe<'_, T> {
        self.cursor.next()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use maka_agent_facts::model::prompt_source::source::{
        ByteCursor, ByteSource, ContentRecipe, MediaSource, ReadSource, SourceBudget, TextEncoding,
        TextSource,
    };
    use maka_event_log::{
        RootStore,
        root::{RootNamespaces, RootOwner},
    };
    use maka_model::{
        PreparationPolicy,
        prompt::{ContentPart, FileData, Message},
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    async fn open_io() -> (
        tempfile::TempDir,
        RootStore,
        maka_event_log::root_store::SessionWorkLease,
        maka_event_log::root_store::WorkEffects,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let namespaces = RootNamespaces {
            ownership: dir.path().join("owners"),
            control: dir.path().join("control"),
        };
        let owner = Arc::new(RootOwner::create(&dir.path().join("root"), &namespaces).unwrap());
        let root = RootStore::open(owner, maka_event_log::ROOT_MIGRATIONS)
            .await
            .unwrap();
        let scope = root
            .create_session("snapshot-test", "fp", &serde_json::json!({}), 1)
            .await
            .unwrap()
            .work_scope(None)
            .await
            .unwrap();
        let (lease, effects) = scope.accept(CancellationToken::new());
        (dir, root, lease, effects)
    }

    async fn read_source_bytes(
        source: &SourceBytes,
        budget: &Arc<dyn SourceBudget>,
    ) -> io::Result<Vec<u8>> {
        let mut cursor = source.open(budget.clone());
        let mut buf = budget.allocate(16 * 1024).await?;
        let mut out = Vec::new();
        loop {
            let read = cursor.read_chunk(buf).await?;
            out.extend_from_slice(&read.buffer.as_ref()[..read.bytes_read]);
            buf = read.buffer;
            if read.eof {
                return Ok(out);
            }
        }
    }

    #[tokio::test]
    async fn legacy_v2_inline_image_restores_without_media_and_rejects_media_refs() {
        let (_dir, root, lease, _effects) = open_io().await;
        let resources = ModelPreparationResources::new(PreparationPolicy::default()).unwrap();
        let cancel = CancellationToken::new();
        let io = PreparationIo::new(&lease.store()).unwrap();

        let image = b"legacy-v2-inline-image-payload-0123456789".to_vec();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&image);
        let stage = staging(&resources, 0, &cancel).await.unwrap();
        let arena = CaptureArena::new(io.clone(), None).await.unwrap();
        let mut builder = Builder::new(
            arena.clone(),
            resources.clone(),
            stage.preparation.clone(),
            cancel.clone(),
        )
        .await
        .unwrap();
        builder
            .append(
                Message::User {
                    content: vec![ContentPart::File {
                        data: FileData::Data(b64),
                        media_type: "image/png".into(),
                        provider_options: None,
                    }],
                    provider_options: None,
                },
                false,
            )
            .await
            .unwrap();
        let captured = builder.finish_captured().await.unwrap();
        assert_eq!(captured.layout.version, 2);

        // Paired checks against the genuine v2 inline-image arena:
        // 1. Non-empty media refs are rejected at directory validation.
        let bogus_digest: [u8; 32] = Sha256::digest(&image).into();
        assert!(
            canonical_prompt::validate_external_media_directory(
                &arena,
                &captured.layout,
                &[(bogus_digest, image.len() as u64)],
                &cancel,
            )
            .await
            .is_err()
        );
        // 2. Empty media validates and restores the exact inline image bytes.
        canonical_prompt::validate_external_media_directory(&arena, &captured.layout, &[], &cancel)
            .await
            .unwrap();
        let restored = canonical_prompt::restore(
            arena.clone(),
            resources.clone(),
            captured.layout.clone(),
            Arc::from([]),
        )
        .await
        .unwrap();
        {
            let work = resources.acquire_work().await.unwrap();
            let Some(MessageRecipe::User { content, .. }) =
                restored.recipes().unwrap().open(0).next().await.unwrap()
            else {
                panic!("expected user message");
            };
            let Some(ContentRecipe::Media { media, .. }) = content.open(0).next().await.unwrap()
            else {
                panic!("expected inline media");
            };
            assert_eq!(
                read_source_bytes(&media.bytes, &work.budget())
                    .await
                    .unwrap(),
                image
            );
        }
        drop((restored, captured, stage));
        arena.close().await.unwrap();
        drop(arena);
        drop(io);
        lease.finish();
        root.close().await.unwrap();
    }

    #[tokio::test]
    async fn external_media_capture_is_single_pass_rewinds_duplicates_and_charges_directory_budget()
    {
        struct CountingBytes {
            data: Arc<[u8]>,
            opens: Arc<AtomicUsize>,
        }
        struct SliceCursor {
            data: Arc<[u8]>,
            pos: usize,
        }
        impl ByteCursor for SliceCursor {
            fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> ReadSource<'_> {
                Box::pin(async move {
                    let rem = self.data.len() - self.pos;
                    let n = rem.min(buffer.as_ref().len());
                    buffer.as_mut()[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
                    self.pos += n;
                    Ok(maka_agent_facts::model::prompt_source::source::SourceRead {
                        buffer,
                        bytes_read: n,
                        eof: self.pos == self.data.len(),
                    })
                })
            }
        }
        impl ByteSource for CountingBytes {
            fn len(&self) -> Option<u64> {
                Some(self.data.len() as u64)
            }
            fn open(&self, _budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
                self.opens.fetch_add(1, Ordering::SeqCst);
                Box::new(SliceCursor {
                    data: self.data.clone(),
                    pos: 0,
                })
            }
        }
        struct OneMessage(MessageRecipe);
        impl RecipeSource<MessageRecipe> for OneMessage {
            fn len(&self) -> usize {
                1
            }
            fn open(&self, start: usize) -> Box<dyn RecipeCursor<MessageRecipe>> {
                let item = (start == 0).then(|| self.0.clone());
                struct Once(Option<MessageRecipe>);
                impl RecipeCursor<MessageRecipe> for Once {
                    fn next(&mut self) -> NextRecipe<'_, MessageRecipe> {
                        let item = self.0.take();
                        Box::pin(async move { Ok(item) })
                    }
                }
                Box::new(Once(item))
            }
        }
        impl MessageSource for OneMessage {
            fn open_metadata(&self, _start: usize) -> Box<dyn RecipeCursor<MessageMetadata>> {
                unreachable!("snapshot_prompt only opens recipes")
            }
        }
        struct Parts(Vec<ContentRecipe>);
        impl RecipeSource<ContentRecipe> for Parts {
            fn len(&self) -> usize {
                self.0.len()
            }
            fn open(&self, start: usize) -> Box<dyn RecipeCursor<ContentRecipe>> {
                struct VecCursor(std::vec::IntoIter<ContentRecipe>);
                impl RecipeCursor<ContentRecipe> for VecCursor {
                    fn next(&mut self) -> NextRecipe<'_, ContentRecipe> {
                        let item = self.0.next();
                        Box::pin(async move { Ok(item) })
                    }
                }
                Box::new(VecCursor(Vec::from(&self.0[start..]).into_iter()))
            }
        }

        let (_dir, root, lease, _effects) = open_io().await;
        let resources = ModelPreparationResources::new(PreparationPolicy::default()).unwrap();
        let cancel = CancellationToken::new();
        let io = PreparationIo::new(&lease.store()).unwrap();

        let img_a: Arc<[u8]> = vec![0xAAu8; 4096].into();
        let img_b: Arc<[u8]> = vec![0xBBu8; 4096].into();
        let (opens_a1, opens_b, opens_a2) = (
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
        );
        let make_part = |data: Arc<[u8]>, opens: Arc<AtomicUsize>| ContentRecipe::Media {
            media: MediaSource {
                bytes: SourceBytes::Source(Arc::new(CountingBytes { data, opens })),
                media_type: TextSource::new(
                    SourceBytes::Inline(b"image/png".as_slice().into()),
                    TextEncoding::Utf8,
                ),
                detail: None,
            },
            provider_options: None,
        };
        let prompt = Prompt::from_recipes(
            Arc::new(OneMessage(MessageRecipe::User {
                is_pinned_memory: false,
                content: Arc::new(Parts(vec![
                    make_part(img_a.clone(), opens_a1.clone()),
                    make_part(img_b.clone(), opens_b.clone()),
                    make_part(img_a.clone(), opens_a2.clone()),
                ])),
                provider_options: None,
            })),
            String::from("id"),
            1,
            Default::default(),
        );
        let frozen = snapshot_prompt(io.clone(), resources, &prompt, &cancel)
            .await
            .unwrap();
        assert_eq!(opens_a1.load(Ordering::SeqCst), 1);
        assert_eq!(
            opens_b.load(Ordering::SeqCst),
            1,
            "2nd unique image must be read once"
        );
        assert_eq!(
            opens_a2.load(Ordering::SeqCst),
            1,
            "duplicate image must be read once"
        );
        let (_ref, chunks, media, layout, cleanup) = frozen.into_parts();
        assert_eq!(layout.version, 3);
        assert_eq!(media.len(), 2);
        assert_eq!(
            media[0].reference(),
            ContentBlob::new(img_a.to_vec()).reference()
        );
        assert_eq!(
            media[1].reference(),
            ContentBlob::new(img_b.to_vec()).reference()
        );
        drop((chunks, media));
        cleanup.await.unwrap();

        // Tight staging budget must reject unbounded unique media directory growth.
        let base_meta = 2 * CaptureArena::metadata_bytes()
            + RequestPreparation::metadata_bytes()
            + std::mem::size_of::<ArenaBody>()
            + std::mem::size_of::<ArenaReader<'static>>()
            + 4 * std::mem::size_of::<usize>()
            + Builder::resident_bytes();
        let tight = ModelPreparationResources::new(PreparationPolicy {
            staging_bytes: base_meta + 1024,
            resident_bytes: base_meta + 64 * 1024,
            work_bytes: 64 * 1024,
            progress_bytes: 128 * 1024,
        })
        .unwrap();
        let many_parts: Vec<_> = (0u8..20)
            .map(|i| ContentRecipe::Media {
                media: MediaSource {
                    bytes: SourceBytes::Inline(vec![i; 64].into()),
                    media_type: TextSource::new(
                        SourceBytes::Inline(b"image/png".as_slice().into()),
                        TextEncoding::Utf8,
                    ),
                    detail: None,
                },
                provider_options: None,
            })
            .collect();
        let big_prompt = Prompt::from_recipes(
            Arc::new(OneMessage(MessageRecipe::User {
                is_pinned_memory: false,
                content: Arc::new(Parts(many_parts)),
                provider_options: None,
            })),
            String::from("many"),
            1,
            Default::default(),
        );
        let err = snapshot_prompt(io.clone(), tight, &big_prompt, &cancel).await;
        assert!(
            err.is_err(),
            "unique media directory growth must hit staging plan_directory budget"
        );
        drop(io);
        lease.finish();
        root.close().await.unwrap();
    }
}
