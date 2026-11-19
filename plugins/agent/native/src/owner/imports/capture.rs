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
use futures_util::future::BoxFuture;
use maka_agent_facts::{
    artifact::{Artifact, ArtifactKind, ArtifactSource, PublishedArtifact},
    durable::{ContentRef, RunOwner},
    history_snapshot::{
        Entry, ImportedArtifactScope, ImportedMessage, ImportedProviderMetadata,
        OriginalRecordsPage, OriginalSource, PAGE_ENTRIES,
    },
};
use maka_agent_state::session_history::snapshot::IMPORT_TAPE_MAGIC;
use maka_capabilities::filesystem::{PinnedReader, ReadRange};
use maka_session_import::{
    Error,
    exact::{ExactMedia, ExactPart, ExactRecord, ExactSink, ExactTranscript, MediaBody, MediaSink},
};
use sha2::{Digest, Sha256};
use std::io::{Seek, SeekFrom, Write};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use uuid::Uuid;

pub(super) struct Capture {
    file: tokio::fs::File,
    owner: RunOwner,
    session: String,
    source: maka_agent_facts::import::Source,
    operation: Uuid,
    created_at: u64,
    message: u64,
    raw_ordinal: u64,
    media: u64,
    current_media: Vec<String>,
    media_source: ArtifactSource,
    turn: String,
    raw: Vec<ContentRef>,
    previous: Option<ContentRef>,
}
impl Capture {
    pub(super) async fn new(
        owner: RunOwner,
        session: String,
        source: maka_agent_facts::import::Source,
        operation: Uuid,
        turn: String,
        created_at: u64,
    ) -> Result<Self, Error> {
        let file = tokio::task::spawn_blocking(tempfile::tempfile)
            .await?
            .map_err(sink)?;
        let mut file = tokio::fs::File::from_std(file);
        file.write_all(IMPORT_TAPE_MAGIC).await.map_err(sink)?;
        Ok(Self {
            file,
            owner,
            session,
            source,
            operation,
            created_at,
            message: 0,
            raw_ordinal: 0,
            media: 0,
            current_media: vec![],
            media_source: ArtifactSource::ToolResult,
            turn,
            raw: Vec::with_capacity(PAGE_ENTRIES),
            previous: None,
        })
    }
    async fn content(&mut self, bytes: Vec<u8>) -> Result<ContentRef, Error> {
        let (bytes, digest) = tokio::task::spawn_blocking(move || {
            let digest = Sha256::digest(&bytes);
            (bytes, digest)
        })
        .await?;
        self.file.write_all(&[0]).await.map_err(sink)?;
        self.file.write_all(&digest).await.map_err(sink)?;
        self.file
            .write_all(&(bytes.len() as u64).to_be_bytes())
            .await
            .map_err(sink)?;
        self.file.write_all(&bytes).await.map_err(sink)?;
        Ok(ContentRef {
            digest: format!("sha256:{}", hex::encode(digest)),
            bytes: bytes.len() as u64,
        })
    }
    async fn json<T: serde::Serialize + Send + 'static>(
        &mut self,
        value: T,
    ) -> Result<ContentRef, Error> {
        let bytes = tokio::task::spawn_blocking(move || serde_json::to_vec(&value)).await??;
        self.content(bytes).await
    }
    async fn entry(&mut self, entry: Entry) -> Result<(), Error> {
        let bytes = serde_json::to_vec(&entry)?;
        self.file.write_all(&[1]).await.map_err(sink)?;
        self.file
            .write_all(&(bytes.len() as u64).to_be_bytes())
            .await
            .map_err(sink)?;
        self.file.write_all(&bytes).await.map_err(sink)?;
        Ok(())
    }
    async fn flush_raw(&mut self) -> Result<(), Error> {
        if self.raw.is_empty() {
            return Ok(());
        }
        let page = OriginalRecordsPage {
            previous: self.previous.take(),
            records: std::mem::replace(&mut self.raw, Vec::with_capacity(PAGE_ENTRIES)),
        };
        self.previous = Some(self.json(page).await?);
        Ok(())
    }
    pub(super) async fn finish(
        mut self,
        transcript: &ExactTranscript,
    ) -> Result<(std::fs::File, ContentRef), Error> {
        self.flush_raw().await?;
        let fingerprint = serde_json::to_string(&transcript.fingerprint)?;
        let records = self.previous.take();
        let root = self
            .json(OriginalSource {
                version: 1,
                fingerprint,
                records,
            })
            .await?;
        self.file.flush().await.map_err(sink)?;
        self.file.sync_all().await.map_err(sink)?;
        self.file.rewind().await.map_err(sink)?;
        Ok((self.file.into_std().await, root))
    }
}
impl ExactSink for Capture {
    fn record(&mut self, record: ExactRecord) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            let original_ordinal = self.raw_ordinal;
            self.raw_ordinal = self
                .raw_ordinal
                .checked_add(1)
                .ok_or_else(|| sink(std::io::Error::other("source raw record ordinal overflow")))?;
            let original = self.content(record.raw_record).await?;
            self.raw.push(original.clone());
            if self.raw.len() == PAGE_ENTRIES {
                self.flush_raw().await?;
            }
            for message in record.messages {
                self.current_media.clear();
                let mut parts = Vec::with_capacity(message.parts.len());
                for part in message.parts {
                    self.media_source = if matches!(&part, ExactPart::Input { .. }) {
                        ArtifactSource::UserUpload
                    } else {
                        ArtifactSource::ToolResult
                    };
                    let bound = part.bind(self).await?;
                    parts.push(self.json(bound).await?);
                }
                let metadata = self
                    .json(ImportedProviderMetadata {
                        version: 1,
                        source: self.source.clone(),
                        metadata: message.provider_metadata,
                    })
                    .await?;
                let media = std::mem::take(&mut self.current_media);
                let body = self
                    .json(ImportedMessage {
                        turn_ordinal: message.turn_ordinal,
                        original_ordinal,
                        media,
                        source_message_id: message.source_message_id,
                        source_turn_id: message.source_turn_id,
                        timestamp: message.timestamp,
                        role: message.role,
                        artifact_scope: ImportedArtifactScope {
                            owner: self.owner.clone(),
                            session: self.session.clone(),
                        },
                        parts,
                        provider_metadata: Some(metadata),
                        original: original.clone(),
                    })
                    .await?;
                self.entry(Entry::Imported {
                    ordinal: self.message,
                    message: body,
                })
                .await?;
                self.message = self.message.checked_add(1).ok_or_else(|| {
                    sink(std::io::Error::other("source message ordinal overflow"))
                })?;
            }
            Ok(())
        })
    }
}
impl MediaSink for Capture {
    fn copy<'a>(
        &'a mut self,
        media: &'a ExactMedia,
    ) -> BoxFuture<'a, Result<PublishedArtifact, Error>> {
        Box::pin(async move {
            let payload = match &media.body {
                MediaBody::Inline(bytes) => {
                    // Only this original media part is borrowed; the source is never
                    // flattened or accumulated in a session-sized allocation.
                    let mut hash = Sha256::new();
                    let start = self.file.stream_position().await.map_err(sink)?;
                    self.file.write_all(&[0]).await.map_err(sink)?;
                    self.file.write_all(&[0u8; 40]).await.map_err(sink)?;
                    for chunk in bytes.chunks(64 * 1024) {
                        hash.update(chunk);
                        self.file.write_all(chunk).await.map_err(sink)?;
                    }
                    let end = self.file.stream_position().await.map_err(sink)?;
                    let digest = hash.finalize();
                    self.file
                        .seek(SeekFrom::Start(start + 1))
                        .await
                        .map_err(sink)?;
                    self.file.write_all(&digest).await.map_err(sink)?;
                    self.file
                        .write_all(&(bytes.len() as u64).to_be_bytes())
                        .await
                        .map_err(sink)?;
                    self.file.seek(SeekFrom::Start(end)).await.map_err(sink)?;
                    ContentRef {
                        digest: format!("sha256:{}", hex::encode(digest)),
                        bytes: bytes.len() as u64,
                    }
                }
                MediaBody::File(file) => {
                    self.file.flush().await.map_err(sink)?;
                    let mut backing = self.file.try_clone().await.map_err(sink)?.into_std().await;
                    let result = file
                        .with_reader(move |reader| Ok(copy_file(&mut backing, reader)))
                        .await??;
                    self.file.seek(SeekFrom::Current(0)).await.map_err(sink)?;
                    result
                }
            };
            let id = media_id(self.operation, self.media);
            self.media = self
                .media
                .checked_add(1)
                .ok_or_else(|| sink(std::io::Error::other("source media ordinal overflow")))?;
            let kind = if media.mime_type.starts_with("image/") {
                ArtifactKind::Image
            } else if media.mime_type == "application/pdf" {
                ArtifactKind::Pdf
            } else {
                ArtifactKind::File
            };
            let artifact = Artifact {
                id,
                session_id: self.session.clone(),
                turn_id: self.turn.clone(),
                created_at: self.created_at,
                name: media.name.clone(),
                kind,
                size_bytes: payload.bytes,
                mime_type: Some(media.mime_type.clone()),
                source: self.media_source,
                summary: None,
            };
            artifact.validate().map_err(Error::Invalid)?;
            let published = PublishedArtifact { artifact, payload };
            self.entry(Entry::Artifact {
                owner: self.owner.clone(),
                session: self.session.clone(),
                run: None,
                through_sequence: None,
                record: published.clone(),
            })
            .await?;
            self.current_media.push(published.artifact.id.clone());
            Ok(published)
        })
    }
}
fn copy_file(
    backing: &mut std::fs::File,
    reader: &mut PinnedReader<'_>,
) -> Result<ContentRef, Error> {
    let start = backing.stream_position().map_err(sink)?;
    backing.write_all(&[0]).map_err(sink)?;
    backing.write_all(&[0u8; 40]).map_err(sink)?;
    let mut hash = Sha256::new();
    let mut offset = 0u64;
    loop {
        let page = reader.read(ReadRange {
            offset,
            limit: 64 * 1024,
        })?;
        hash.update(&page.bytes);
        backing.write_all(&page.bytes).map_err(sink)?;
        let bytes = page.bytes.len() as u64;
        offset = offset
            .checked_add(bytes)
            .ok_or_else(|| sink(std::io::Error::other("source media byte length overflow")))?;
        match page.next_offset {
            Some(next) if next == offset => {}
            Some(_) => return Err(sink(std::io::Error::other("source media range changed"))),
            None => break,
        }
    }
    let end = backing.stream_position().map_err(sink)?;
    let digest = hash.finalize();
    backing.seek(SeekFrom::Start(start + 1)).map_err(sink)?;
    backing.write_all(&digest).map_err(sink)?;
    backing.write_all(&offset.to_be_bytes()).map_err(sink)?;
    backing.seek(SeekFrom::Start(end)).map_err(sink)?;
    Ok(ContentRef {
        digest: format!("sha256:{}", hex::encode(digest)),
        bytes: offset,
    })
}
fn media_id(operation: Uuid, ordinal: u64) -> String {
    let mut hash = Sha256::new();
    hash.update(b"maka.import.media.v1");
    hash.update(operation.as_bytes());
    hash.update(ordinal.to_be_bytes());
    hex::encode(hash.finalize())
}
fn sink(error: impl std::error::Error + Send + Sync + 'static) -> Error {
    Error::Sink(Box::new(error))
}
