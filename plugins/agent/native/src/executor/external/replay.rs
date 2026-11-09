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

use super::*;
use maka_agent_facts::executor::Output;
use std::sync::{
    Mutex,
    atomic::{AtomicU64, Ordering},
};
use tokio::io::{AsyncBufReadExt, AsyncSeekExt, BufReader};

pub(super) struct Stream {
    reader: BufReader<tokio::fs::File>,
    cancellation: CancellationToken,
    retired: CancellationToken,
}
impl Stream {
    pub fn new(
        file: std::fs::File,
        cancellation: CancellationToken,
        retired: CancellationToken,
    ) -> Self {
        Self {
            reader: BufReader::new(tokio::fs::File::from_std(file)),
            cancellation,
            retired,
        }
    }
    pub async fn rewind(&mut self) -> Result<(), Error> {
        self.reader
            .rewind()
            .await
            .map(|_| ())
            .map_err(|error| Error::Provider(format!("Original native spool seek failed: {error}")))
    }
    pub async fn next(&mut self) -> Result<Option<Value>, Error> {
        let mut row = Vec::new();
        loop {
            let available = tokio::select! {
                biased;
                () = self.retired.cancelled() => return Err(Error::ObservationRetired),
                () = self.cancellation.cancelled() => return Err(Error::ObservationRetired),
                available = self.reader.fill_buf() => available.map_err(|error| Error::Provider(format!("Original native spool read failed: {error}")))?,
            };
            if available.is_empty() {
                return if row.is_empty() {
                    Ok(None)
                } else {
                    Err(Error::Unknown)
                };
            }
            let count = available
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(available.len(), |index| index + 1);
            if row.len() + count > runtime::MAX_MESSAGE_BYTES {
                return Err(Error::Invalid(
                    "Original protocol line exceeds 256 MiB".into(),
                ));
            }
            let complete = available[count - 1] == b'\n';
            row.extend_from_slice(&available[..count]);
            self.reader.consume(count);
            if complete {
                return runtime::parse_json(row, "original native protocol")
                    .await
                    .map(Some);
            }
        }
    }
    pub async fn required(&mut self) -> Result<Value, Error> {
        self.next().await?.ok_or(Error::Unknown)
    }
}

pub(super) struct Count {
    after: u64,
    total: AtomicU64,
    prefix: Mutex<[u8; 32]>,
}
impl Count {
    pub fn new(after: u64) -> Self {
        Self {
            after,
            total: AtomicU64::new(0),
            prefix: Mutex::new([0; 32]),
        }
    }
    pub fn total(&self) -> u64 {
        self.total.load(Ordering::Relaxed)
    }
    pub fn prefix(&self) -> [u8; 32] {
        *self.prefix.lock().expect("replay prefix lock poisoned")
    }
}
impl OutputSink for Count {
    fn emit(&self, output: Output) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            output
                .validate()
                .map_err(|message| Error::Invalid(message.into()))?;
            let index = self.total.fetch_add(1, Ordering::Relaxed);
            if index < self.after {
                let hash = tokio::task::spawn_blocking(move || {
                    serde_json::to_vec(&output).map(Sha256::digest)
                })
                .await
                .map_err(|error| {
                    Error::Provider(format!("Original output-prefix hashing failed: {error}"))
                })?
                .map_err(|error| Error::Invalid(error.to_string()))?;
                let mut prefix = self.prefix.lock().expect("replay prefix lock poisoned");
                let mut next = Sha256::new();
                next.update(*prefix);
                next.update(hash);
                *prefix = next.finalize().into();
            }
            Ok(())
        })
    }
}
pub(super) struct Suffix<'a> {
    after: u64,
    total: AtomicU64,
    output: &'a dyn OutputSink,
}
impl<'a> Suffix<'a> {
    pub fn new(after: u64, output: &'a dyn OutputSink) -> Self {
        Self {
            after,
            total: AtomicU64::new(0),
            output,
        }
    }
}
impl OutputSink for Suffix<'_> {
    fn emit(&self, output: Output) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            if self.total.fetch_add(1, Ordering::Relaxed) < self.after {
                return Ok(());
            }
            self.output.emit(output).await
        })
    }
}

pub(super) async fn parse(
    request: &Request,
    binding: &NativeBinding,
    admitted_steering_batches: u64,
    input: &mut Stream,
    stream: &mut Stream,
    output: &dyn OutputSink,
) -> Result<Outcome, Error> {
    let outcome = match binding.task {
        NativeTask::Codex { .. } => codex::replay(request, binding, input, stream, output).await,
        NativeTask::Antigravity { .. } => {
            agy::replay(request, binding, input, stream, output).await
        }
        NativeTask::ClaudeStream { .. } => {
            claude::replay(binding, admitted_steering_batches, input, stream, output).await
        }
        NativeTask::Claude { .. } => Err(Error::Unknown),
    }?;
    if matches!(outcome, Outcome::Completed { .. })
        && matches!(
            binding.task,
            NativeTask::Codex { .. } | NativeTask::Antigravity { .. }
        )
        && admitted_steering_batches != 0
    {
        return Err(Error::Unknown);
    }
    Ok(outcome)
}
pub(super) fn same_outcome(a: &Outcome, b: &Outcome) -> bool {
    match (a, b) {
        (Outcome::Completed { message_id: a }, Outcome::Completed { message_id: b }) => a == b,
        (Outcome::Cancelled { reason: a }, Outcome::Cancelled { reason: b }) => a == b,
        (
            Outcome::Failed {
                message: a,
                code: ac,
                recoverable: ar,
            },
            Outcome::Failed {
                message: b,
                code: bc,
                recoverable: br,
            },
        ) => a == b && ac == bc && ar == br,
        _ => false,
    }
}
