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
    chunks: watch::Receiver<usize>,
}
impl Receipt {
    /// Confirm source custody was released before settling the resource ticket.
    pub async fn finish(&mut self) -> Result<serde_json::Value, Error> {
        tokio::time::timeout(
            Duration::from_secs(5),
            self.dropped.wait_for(|value| *value),
        )
        .await
        .map_err(|_| Error::CleanupUnconfirmed)?
        .map_err(|_| Error::CleanupUnconfirmed)?;
        tokio::time::timeout(
            Duration::from_secs(5),
            self.chunks.wait_for(|value| *value == 0),
        )
        .await
        .map_err(|_| Error::CleanupUnconfirmed)?
        .map_err(|_| Error::CleanupUnconfirmed)?;
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
pub struct Upload {
    stream: BoxStream<'static, Result<Bytes, Error>>,
    dropped: watch::Sender<bool>,
}
impl Stream for Upload {
    type Item = Result<Bytes, Error>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.stream.as_mut().poll_next(cx)
    }
}
impl Drop for Upload {
    fn drop(&mut self) {
        // Drop the cursor and any pending giant chunk before confirming release.
        self.stream = futures_util::stream::empty().boxed();
        self.dropped.send_replace(true);
    }
}
pub fn track(input: RequestBody, stop: CancellationToken) -> (Upload, Receipt) {
    let length = input.length();
    let progress = Arc::new(Mutex::new(Progress::default()));
    let audit = progress.clone();
    let (dropped, finished) = watch::channel(false);
    let (chunks, drained) = watch::channel(0_usize);
    let stream = futures_util::stream::try_unfold(
        (input.into_stream(), Bytes::new(), 0_u64),
        move |(mut source, mut pending, mut count)| {
            let stop = stop.clone();
            let audit = audit.clone();
            let chunks = chunks.clone();
            async move {
                while pending.is_empty() {
                    let next = tokio::select! {
                        biased;
                        _ = stop.cancelled() => return Err(Error::Denied),
                        next = source.next() => next,
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
                            pending = bytes;
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
                if length == Some(count) && pending.len() <= CHUNK_BYTES {
                    loop {
                        let next = tokio::select! {
                            biased;
                            _ = stop.cancelled() => return Err(Error::Denied),
                            next = source.next() => next,
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
                                source = futures_util::stream::empty().boxed();
                                break;
                            }
                        }
                    }
                }
                let bytes = pending.split_to(pending.len().min(CHUNK_BYTES));
                {
                    let mut progress = audit.lock().unwrap();
                    progress.bytes += bytes.len() as u64;
                    progress.digest.update(&bytes);
                }
                chunks.send_modify(|count| *count += 1);
                let bytes = Bytes::from_owner(InFlight { bytes, chunks });
                Ok(Some((bytes, (source, pending, count))))
            }
        },
    );
    (
        Upload {
            stream: stream.boxed(),
            dropped,
        },
        Receipt {
            progress,
            dropped: finished,
            chunks: drained,
        },
    )
}
