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

//! Pull-driven request uploads. Bytes slices retain the source allocation until
//! the HTTP stack has drained them; there is no producer queue or full-body copy.
use super::{Bytes, Error, RequestBody};
use futures_util::{Stream, StreamExt, stream::BoxStream};
use sha2::{Digest, Sha256};
use std::{
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

const CHUNK_BYTES: usize = 16 * 1024;
#[derive(Default)]
struct Progress {
    bytes: u64,
    digest: Sha256,
    complete: bool,
}
pub struct Receipt {
    progress: Arc<Mutex<Progress>>,
    dropped: watch::Receiver<bool>,
    source: watch::Receiver<bool>,
    cleanup: Option<Arc<dyn super::UploadCleanup>>,
    chunks: watch::Receiver<usize>,
}
impl Receipt {
    pub fn needs_source_close(&self) -> bool {
        self.cleanup.is_some()
    }

    /// Wait for the producer and all transport-retained chunks without closing
    /// the response connection. The HTTP wrapper may remain alive after EOF.
    pub async fn source_released(&mut self) -> Result<(), Error> {
        self.source
            .wait_for(|released| *released)
            .await
            .map_err(|_| Error::CleanupUnconfirmed)?;
        self.chunks
            .wait_for(|count| *count == 0)
            .await
            .map_err(|_| Error::CleanupUnconfirmed)?;
        Ok(())
    }

    /// Close materialization after a positive physical release receipt. Once
    /// started, callers must await this operation before settling its custody.
    pub async fn close_source(&mut self) -> Result<(), Error> {
        self.source_released().await?;
        if let Some(cleanup) = &self.cleanup {
            cleanup.close().await.map_err(|error| {
                tracing::error!(stage = "upload_materialization_close", %error, "cleanup unconfirmed");
                Error::CleanupUnconfirmed
            })?;
            self.cleanup = None;
        }
        Ok(())
    }

    /// Confirm source custody was released before settling the resource ticket.
    pub async fn finish(&mut self) -> Result<serde_json::Value, Error> {
        let cleanup_started = tokio::time::Instant::now();
        let outcome = match tokio::time::timeout(
            Duration::from_secs(5),
            self.dropped.wait_for(|value| *value),
        )
        .await
        {
            Ok(Ok(_)) => None,
            Ok(Err(_)) => Some("channel_closed"),
            Err(_) => Some("timeout"),
        };
        if let Some(outcome) = outcome {
            tracing::error!(
                stage = "upload_source_drop",
                outcome,
                timeout_ms = 5000_u64,
                elapsed_ms = cleanup_started.elapsed().as_millis(),
                source_dropped = *self.dropped.borrow(),
                in_flight_chunks = *self.chunks.borrow(),
                "cleanup unconfirmed"
            );
            return Err(Error::CleanupUnconfirmed);
        }
        let cleanup_started = tokio::time::Instant::now();
        let outcome = match tokio::time::timeout(
            Duration::from_secs(5),
            self.chunks.wait_for(|value| *value == 0),
        )
        .await
        {
            Ok(Ok(_)) => None,
            Ok(Err(_)) => Some("channel_closed"),
            Err(_) => Some("timeout"),
        };
        if let Some(outcome) = outcome {
            tracing::error!(
                stage = "upload_chunks_drain",
                outcome,
                timeout_ms = 5000_u64,
                elapsed_ms = cleanup_started.elapsed().as_millis(),
                source_dropped = *self.dropped.borrow(),
                in_flight_chunks = *self.chunks.borrow(),
                "cleanup unconfirmed"
            );
            return Err(Error::CleanupUnconfirmed);
        }
        self.close_source().await?;
        let progress = self.progress.lock().unwrap();
        // These are bytes handed to the HTTP transport, not a claim that the
        // remote endpoint committed them (especially on cancellation).
        Ok(serde_json::json!({
            "bodyBytes": progress.bytes,
            "bodyDigest": format!("sha256:{}", hex::encode(progress.digest.clone().finalize())),
            "bodyComplete": progress.complete,
        }))
    }
}
// Count physical byte owners, including slices retained inside the HTTP stack.
// Cancelling the source is not itself proof that these allocations were drained.
struct InFlight {
    bytes: Bytes,
    chunks: watch::Sender<usize>,
}
impl AsRef<[u8]> for InFlight {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}
impl Drop for InFlight {
    fn drop(&mut self) {
        self.bytes = Bytes::new();
        self.chunks.send_modify(|count| *count -= 1);
    }
}
struct Source {
    stream: BoxStream<'static, Result<Bytes, Error>>,
    pending: Bytes,
    released: watch::Sender<bool>,
}
impl Drop for Source {
    fn drop(&mut self) {
        self.stream = futures_util::stream::empty().boxed();
        self.pending = Bytes::new();
        self.released.send_replace(true);
    }
}

pub struct Upload {
    stream: BoxStream<'static, Result<Bytes, Error>>,
    dropped: watch::Sender<bool>,
}
impl Stream for Upload {
    type Item = Result<Bytes, Error>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let next = self.stream.as_mut().poll_next(cx);
        if matches!(next, Poll::Ready(None) | Poll::Ready(Some(Err(_)))) {
            self.stream = futures_util::stream::empty().boxed();
        }
        next
    }
}
impl Drop for Upload {
    fn drop(&mut self) {
        // Drop the cursor and any pending giant chunk before confirming release.
        self.stream = futures_util::stream::empty().boxed();
        self.dropped.send_replace(true);
    }
}
pub fn track(mut input: RequestBody, stop: CancellationToken) -> (Upload, Receipt) {
    let length = input.length();
    let cleanup = input.cleanup.take();
    let progress = Arc::new(Mutex::new(Progress::default()));
    let audit = progress.clone();
    let (dropped, finished) = watch::channel(false);
    let (chunks, drained) = watch::channel(0_usize);
    let (source_released, source_receipt) = watch::channel(false);
    let source = Source {
        stream: input.into_stream(),
        pending: Bytes::new(),
        released: source_released,
    };
    let stream =
        futures_util::stream::try_unfold((Some(source), 0_u64), move |(mut source, mut count)| {
            let stop = stop.clone();
            let audit = audit.clone();
            let chunks = chunks.clone();
            async move {
                if source.is_none() {
                    return Ok(None);
                }
                let producer = source.as_mut().expect("active source");
                let mut exhausted = false;
                while producer.pending.is_empty() {
                    let next = tokio::select! {
                        biased;
                        _ = stop.cancelled() => return Err(Error::Denied),
                        next = producer.stream.next() => next,
                    };
                    match next {
                        Some(Ok(bytes)) => {
                            count = count.checked_add(bytes.len() as u64).ok_or_else(|| {
                                Error::Invalid("HTTP body length overflow".into())
                            })?;
                            if length.is_some_and(|length| count > length) {
                                return Err(Error::Invalid(
                                    "HTTP body exceeds declared length".into(),
                                ));
                            }
                            producer.pending = bytes;
                        }
                        Some(Err(error)) => return Err(error),
                        None => {
                            if length.is_some_and(|length| count != length) {
                                return Err(Error::Invalid(
                                    "HTTP body shorter than declared length".into(),
                                ));
                            }
                            audit.lock().unwrap().complete = true;
                            return Ok(None);
                        }
                    }
                }
                if stop.is_cancelled() {
                    return Err(Error::Denied);
                }
                // HTTP may stop polling at Content-Length. Verify EOF before
                // yielding the final frame so a lying declaration cannot hide
                // a trailing source chunk or bypass source error reporting.
                if length == Some(count) && producer.pending.len() <= CHUNK_BYTES {
                    loop {
                        let next = tokio::select! {
                            biased;
                            _ = stop.cancelled() => return Err(Error::Denied),
                            next = producer.stream.next() => next,
                        };
                        match next {
                            Some(Ok(bytes)) if bytes.is_empty() => continue,
                            Some(Ok(_)) => {
                                return Err(Error::Invalid(
                                    "HTTP body exceeds declared length".into(),
                                ));
                            }
                            Some(Err(error)) => return Err(error),
                            None => {
                                audit.lock().unwrap().complete = true;
                                exhausted = true;
                                break;
                            }
                        }
                    }
                }
                let bytes = producer
                    .pending
                    .split_to(producer.pending.len().min(CHUNK_BYTES));
                {
                    let mut progress = audit.lock().unwrap();
                    progress.bytes += bytes.len() as u64;
                    progress.digest.update(&bytes);
                }
                chunks.send_modify(|count| *count += 1);
                // Publish source release only after the final held chunk is
                // counted; receipt observers must never see a false zero gap.
                if exhausted {
                    source = None;
                }
                let bytes = Bytes::from_owner(InFlight { bytes, chunks });
                Ok(Some((bytes, (source, count))))
            }
        });
    (
        Upload {
            stream: stream.boxed(),
            dropped,
        },
        Receipt {
            progress,
            dropped: finished,
            source: source_receipt,
            cleanup,
            chunks: drained,
        },
    )
}
