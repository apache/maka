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

//! Request-local derived bytes with one original-owner backing and explicit seal.
use super::request_backing::RequestBackingBuilder;
use maka_agent_facts::model::prompt_source::source::*;
use maka_event_log::context::semantic::CapturedSource;
use std::{
    io,
    io::Write,
    ops::Range,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(crate) struct CaptureArena(Arc<Inner>);
pub(crate) struct ArenaAppend {
    arena: CaptureArena,
    _sequence: tokio::sync::OwnedMutexGuard<()>,
}
impl ArenaAppend {
    pub async fn with_writer<T: Send + 'static>(
        &self,
        write: impl FnOnce(&mut RequestBackingBuilder) -> io::Result<T> + Send + 'static,
    ) -> io::Result<T> {
        self.arena.write_job(write).await
    }
}
pub(crate) struct ArenaValue {
    pub source: JsonSource,
    pub inspection: JsonSource,
}
pub(crate) fn source_metadata_bytes(count: usize) -> io::Result<usize> {
    count
        .checked_mul(std::mem::size_of::<RangeSource>() + 2 * std::mem::size_of::<usize>())
        .ok_or_else(|| io::Error::other("arena source metadata size overflow"))
}
struct Inner {
    captured: CapturedSource,
    builder: Mutex<Option<RequestBackingBuilder>>,
    published: AtomicU64,
    close_result: Mutex<Option<Result<(), String>>>,
    serial: Arc<tokio::sync::Mutex<()>>,
    access: Arc<tokio::sync::Mutex<()>>,
}
impl CaptureArena {
    pub fn metadata_bytes() -> usize {
        2 * std::mem::size_of::<usize>()
            + std::mem::size_of::<Inner>()
            + RequestBackingBuilder::metadata_bytes()
            + 2 * std::mem::size_of::<usize>()
            + std::mem::size_of::<tokio::sync::Mutex<()>>()
            + 2 * std::mem::size_of::<usize>()
            + std::mem::size_of::<tokio::sync::Mutex<()>>()
    }

    pub async fn new(
        captured: CapturedSource,
        resident: Option<maka_model::DirectoryLease>,
    ) -> io::Result<Self> {
        let inner = Arc::new(Inner {
            captured: captured.clone(),
            builder: Mutex::new(None),
            published: AtomicU64::new(0),
            close_result: Mutex::new(None),
            serial: Arc::new(tokio::sync::Mutex::new(())),
            access: Arc::new(tokio::sync::Mutex::new(())),
        });
        let worker = inner.clone();
        captured
            .with_local_io(move || {
                let builder = match resident {
                    Some(lease) => RequestBackingBuilder::resident(worker.captured.clone(), lease)?,
                    None => RequestBackingBuilder::file(
                        worker.captured.clone(),
                        worker
                            .captured
                            .reserve_local_resource()
                            .map_err(io::Error::other)?,
                    )?,
                };
                *worker.builder.lock().expect("capture arena lock poisoned") = Some(builder);
                Ok(())
            })
            .await
            .map_err(io::Error::other)?;
        Ok(Self(inner))
    }

    /// The callback runs only in the original source worker, with no state lock
    /// held during its I/O. Callers must serialize it with the capture sequence.
    pub fn with_writer_sync<T>(
        &self,
        write: impl FnOnce(&mut RequestBackingBuilder) -> io::Result<T>,
    ) -> io::Result<T> {
        let mut builder = self
            .0
            .builder
            .lock()
            .expect("capture arena lock poisoned")
            .take()
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::BrokenPipe, "capture arena is not writable")
            })?;
        let result = write(&mut builder);
        *self.0.builder.lock().expect("capture arena lock poisoned") = Some(builder);
        result
    }

    /// One producer owns the complete contiguous append sequence. Metadata and
    /// labels must be reserved before emitting a continuous body through it.
    pub async fn begin_append(&self) -> ArenaAppend {
        ArenaAppend {
            arena: self.clone(),
            _sequence: self.0.serial.clone().lock_owned().await,
        }
    }

    pub async fn with_writer<T: Send + 'static>(
        &self,
        write: impl FnOnce(&mut RequestBackingBuilder) -> io::Result<T> + Send + 'static,
    ) -> io::Result<T> {
        let _serial = self.0.serial.lock().await;
        self.write_job(write).await
    }

    async fn write_job<T: Send + 'static>(
        &self,
        write: impl FnOnce(&mut RequestBackingBuilder) -> io::Result<T> + Send + 'static,
    ) -> io::Result<T> {
        let access = self.0.access.clone().lock_owned().await;
        let arena = self.clone();
        self.0
            .captured
            .with_local_io(move || {
                let _access = access;
                arena.with_writer_sync(write).map_err(Into::into)
            })
            .await
            .map_err(io::Error::other)
    }

    /// Internal fixed metadata reads may run while an append sequence consumes
    /// recipes from this same arena. This never publishes or mutates a range.
    #[cfg(test)]
    pub async fn read_control<const N: usize>(&self, offset: u64) -> io::Result<[u8; N]> {
        self.read_control_with_owner(offset, ()).await
    }

    pub async fn read_control_owned<const N: usize>(
        &self,
        offset: u64,
        owner: Arc<dyn Send + Sync>,
    ) -> io::Result<[u8; N]> {
        self.read_control_with_owner(offset, owner).await
    }

    async fn read_control_with_owner<const N: usize>(
        &self,
        offset: u64,
        owner: impl Send + 'static,
    ) -> io::Result<[u8; N]> {
        self.write_job(move |builder| {
            let _owner = owner;
            let mut bytes = [0; N];
            builder.read_exact_at(offset, &mut bytes)?;
            Ok(bytes)
        })
        .await
    }

    pub async fn append(
        &self,
        source: SourceBytes,
        budget: Arc<dyn SourceBudget>,
        cancellation: &CancellationToken,
    ) -> io::Result<Range<u64>> {
        let append = self.begin_append().await;
        let start = append.with_writer(|builder| Ok(builder.position())).await?;
        let mut cursor = source.open(budget.clone());
        let mut buffer = budget.allocate(32 * 1024).await?;
        loop {
            if cancellation.is_cancelled() {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "capture arena append cancelled",
                ));
            }
            let read = cursor.read_chunk(buffer).await?;
            let used = read.bytes_read;
            let eof = read.eof;
            buffer = append
                .with_writer(move |builder| {
                    builder.write_all(&read.buffer.as_ref()[..used])?;
                    Ok(read.buffer)
                })
                .await?;
            if eof {
                break;
            }
            if used == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "arena input made no progress",
                ));
            }
        }
        let end = append.with_writer(|builder| Ok(builder.position())).await?;
        Ok(start..end)
    }

    pub async fn append_text(
        &self,
        source: TextSource,
        budget: Arc<dyn SourceBudget>,
        cancellation: &CancellationToken,
    ) -> io::Result<ArenaValue> {
        let range = self
            .append(text::bytes(source, budget.clone()), budget, cancellation)
            .await?;
        Ok(ArenaValue {
            source: JsonSource {
                bytes: self.pending(range.clone()),
            },
            inspection: JsonSource {
                bytes: self.inspect(range),
            },
        })
    }

    /// Internal immutable-prefix inspection is available before publication.
    pub fn inspect(&self, range: Range<u64>) -> SourceBytes {
        SourceBytes::Source(Arc::new(RangeSource {
            arena: self.clone(),
            range,
            inspection: true,
        }))
    }
    /// Provider sources become readable when their complete range has been sealed.
    pub fn pending(&self, range: Range<u64>) -> SourceBytes {
        SourceBytes::Source(Arc::new(RangeSource {
            arena: self.clone(),
            range,
            inspection: false,
        }))
    }
    /// Publish the flushed immutable prefix, keeping the same arena appendable.
    pub async fn seal(&self) -> io::Result<()> {
        let _serial = self.0.serial.lock().await;
        let access = self.0.access.clone().lock_owned().await;
        let arena = self.clone();
        self.0
            .captured
            .with_local_io(move || {
                let _access = access;
                let length = arena.with_writer_sync(RequestBackingBuilder::seal_prefix)?;
                arena.0.published.store(length, Ordering::Release);
                Ok(())
            })
            .await
            .map_err(io::Error::other)
    }

    /// Caller has established that this request intrinsically exceeds resident policy.
    pub async fn promote_to_file(&self) -> io::Result<()> {
        let _serial = self.0.serial.lock().await;
        let access = self.0.access.clone().lock_owned().await;
        let arena = self.clone();
        self.0
            .captured
            .with_local_io(move || {
                let _access = access;
                arena
                    .with_writer_sync(|builder| {
                        let resource = arena
                            .0
                            .captured
                            .reserve_local_resource()
                            .map_err(io::Error::other)?;
                        builder.promote_to_file(resource)
                    })
                    .map_err(Into::into)
            })
            .await
            .map_err(io::Error::other)
    }
    pub async fn close(&self) -> io::Result<()> {
        let _serial = self.0.serial.lock().await;
        let access = self.0.access.clone().lock_owned().await;
        let arena = self.clone();
        self.0
            .captured
            .with_local_io(move || {
                let _access = access;
                if let Some(result) = arena
                    .0
                    .close_result
                    .lock()
                    .expect("capture arena lock poisoned")
                    .as_ref()
                {
                    return result.clone().map_err(io::Error::other).map_err(Into::into);
                }
                let builder = arena
                    .0
                    .builder
                    .lock()
                    .expect("capture arena lock poisoned")
                    .take();
                let result = match builder {
                    Some(builder) => builder.abort_in_worker(),
                    None => Ok(()),
                };
                *arena
                    .0
                    .close_result
                    .lock()
                    .expect("capture arena lock poisoned") =
                    Some(result.as_ref().map(|_| ()).map_err(ToString::to_string));
                result.map_err(Into::into)
            })
            .await
            .map_err(io::Error::other)
    }
}
struct RangeSource {
    arena: CaptureArena,
    range: Range<u64>,
    inspection: bool,
}
impl ByteSource for RangeSource {
    fn len(&self) -> Option<u64> {
        Some(self.range.end - self.range.start)
    }
    fn slice(&self, range: Range<u64>) -> io::Result<Arc<dyn ByteSource>> {
        if range.start > range.end || range.end > self.range.end - self.range.start {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "arena range exceeds frozen bytes",
            ));
        }
        Ok(Arc::new(Self {
            arena: self.arena.clone(),
            range: self.range.start + range.start..self.range.start + range.end,
            inspection: self.inspection,
        }))
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(Cursor {
            arena: self.arena.clone(),
            range: self.range.clone(),
            position: 0,
            inspection: self.inspection,
            _budget: budget,
        })
    }
}
struct Cursor {
    arena: CaptureArena,
    range: Range<u64>,
    position: u64,
    inspection: bool,
    _budget: Arc<dyn SourceBudget>,
}
impl ByteCursor for Cursor {
    fn read_chunk(&mut self, buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            let access = self.arena.0.access.clone().lock_owned().await;
            if !self.inspection && self.range.end > self.arena.0.published.load(Ordering::Acquire) {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "capture arena range is not published",
                ));
            }
            let available = usize::try_from(self.range.end - self.range.start - self.position)
                .unwrap_or(usize::MAX)
                .min(buffer.as_ref().len());
            if available == 0 && self.position != self.range.end - self.range.start {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "arena read has an empty buffer",
                ));
            }
            let offset = self.range.start + self.position;
            let arena = self.arena.clone();
            let buffer = self
                .arena
                .0
                .captured
                .with_local_io(move || {
                    let _access = access;
                    arena
                        .with_writer_sync(|builder| {
                            builder.read_buffer_at(offset, buffer, available)
                        })
                        .map_err(Into::into)
                })
                .await
                .map_err(io::Error::other)?;
            self.position += available as u64;
            Ok(SourceRead {
                buffer,
                bytes_read: available,
                eof: self.position == self.range.end - self.range.start,
            })
        })
    }
}
