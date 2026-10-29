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

//! Bounded asynchronous append through the original request arena worker.
use super::AsyncEmit;
use crate::history::capture_arena::{ArenaAppend, CaptureArena};
use maka_agent_facts::model::prompt_source::source::{ChargedBuffer, SourceBudget};
use std::{
    future::Future,
    io::{self, Write},
    pin::Pin,
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

pub(crate) struct ArenaEmit {
    append: ArenaAppend,
    buffer: Option<ChargedBuffer>,
    position: u64,
    filled: usize,
    cancellation: CancellationToken,
}
impl ArenaEmit {
    pub async fn new(
        arena: CaptureArena,
        budget: &Arc<dyn SourceBudget>,
        cancellation: &CancellationToken,
    ) -> io::Result<Self> {
        Self::new_with_owner(arena, budget, cancellation, None).await
    }
    pub async fn new_owned(
        arena: CaptureArena,
        budget: &Arc<dyn SourceBudget>,
        cancellation: &CancellationToken,
        owner: Arc<dyn Send + Sync>,
    ) -> io::Result<Self> {
        Self::new_with_owner(arena, budget, cancellation, Some(owner)).await
    }
    async fn new_with_owner(
        arena: CaptureArena,
        budget: &Arc<dyn SourceBudget>,
        cancellation: &CancellationToken,
        owner: Option<Arc<dyn Send + Sync>>,
    ) -> io::Result<Self> {
        let mut buffer = budget.allocate(4096).await?;
        if let Some(owner) = &owner {
            buffer = buffer.retain_owner(owner.clone());
        }
        let buffer = Some(buffer);
        let append = arena.begin_append().await;
        let position = append
            .with_writer(move |writer| {
                let _owner = owner;
                Ok(writer.position())
            })
            .await?;
        Ok(Self {
            append,
            buffer,
            position,
            filled: 0,
            cancellation: cancellation.clone(),
        })
    }
    pub fn position(&self) -> u64 {
        self.position
    }
    async fn flush(&mut self) -> io::Result<()> {
        if self.filled == 0 {
            return Ok(());
        }
        let buffer = self.buffer.take().expect("arena emission owns its buffer");
        let count = self.filled;
        let buffer = self
            .append
            .with_writer(move |writer| {
                writer.write_all(&buffer.as_ref()[..count])?;
                Ok(buffer)
            })
            .await?;
        self.buffer = Some(buffer);
        self.filled = 0;
        Ok(())
    }
    pub async fn finish(mut self) -> io::Result<()> {
        self.flush().await
    }
}

impl AsyncEmit for ArenaEmit {
    fn write<'a>(
        &'a mut self,
        bytes: &'a [u8],
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + 'a>> {
        Box::pin(async move {
            let mut remaining = bytes;
            while !remaining.is_empty() {
                if self.cancellation.is_cancelled() {
                    return Err(crate::preparation_cancelled(
                        "arena serialization cancelled",
                    ));
                }
                let buffer = self
                    .buffer
                    .as_mut()
                    .expect("arena emission owns its buffer");
                let capacity = buffer.as_mut().len();
                let count = remaining.len().min(capacity - self.filled);
                buffer.as_mut()[self.filled..self.filled + count]
                    .copy_from_slice(&remaining[..count]);
                self.filled += count;
                self.position = self
                    .position
                    .checked_add(count as u64)
                    .ok_or_else(|| io::Error::other("arena emission position overflow"))?;
                remaining = &remaining[count..];
                if self.filled == capacity {
                    self.flush().await?;
                }
            }
            Ok(())
        })
    }
}
