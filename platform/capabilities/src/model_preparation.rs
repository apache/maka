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

//! Host-owned allocation admission for frozen directories and streaming codecs.

use maka_agent_facts::model::prompt_source::source::{Allocate, ChargedBuffer, SourceBudget};
use std::{
    io,
    sync::{Arc, Mutex},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Deployment allocation allowances, shared by every Engine on one Host.
/// Preparation memory includes staging + resident + progress, plus fixed owner metadata.
#[derive(Clone, Copy, Debug)]
pub struct PreparationPolicy {
    /// Frozen sources awaiting their complete request admission.
    pub staging_bytes: usize,
    /// Complete active request envelopes, retained through the last allocation owner.
    pub resident_bytes: usize,
    pub progress_bytes: usize,
    pub work_bytes: usize,
}

impl Default for PreparationPolicy {
    /// Host allocation defaults, independent of per-session or input size limits.
    fn default() -> Self {
        Self {
            staging_bytes: 32 * 1024 * 1024,
            resident_bytes: 256 * 1024 * 1024,
            progress_bytes: 32 * 1024 * 1024,
            work_bytes: 256 * 1024,
        }
    }
}

/// One Host's preparation admission; clones share all byte allowances.
#[derive(Clone, Debug)]
pub struct ModelPreparationResources {
    staging: Arc<Semaphore>,
    resident: Arc<Semaphore>,
    progress: Arc<Semaphore>,
    policy: PreparationPolicy,
}

impl ModelPreparationResources {
    /// Validate that at least one complete codec work envelope can progress.
    pub fn new(policy: PreparationPolicy) -> io::Result<Self> {
        if policy.staging_bytes == 0
            || policy.resident_bytes == 0
            || policy.work_bytes == 0
            || policy.work_bytes > policy.progress_bytes
            || policy.staging_bytes > u32::MAX as usize
            || policy.resident_bytes > u32::MAX as usize
            || policy.progress_bytes > u32::MAX as usize
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid preparation allocation policy",
            ));
        }
        Ok(Self {
            staging: Arc::new(Semaphore::new(policy.staging_bytes)),
            resident: Arc::new(Semaphore::new(policy.resident_bytes)),
            progress: Arc::new(Semaphore::new(policy.progress_bytes)),
            policy,
        })
    }

    pub fn policy(&self) -> PreparationPolicy {
        self.policy
    }

    /// Reserve the source envelope independently of active requests.
    pub async fn reserve_staging(&self, bytes: usize) -> io::Result<StagedPreparation> {
        check_envelope(bytes, self.policy.staging_bytes)?;
        let charge = self
            .staging
            .clone()
            .acquire_many_owned(bytes as u32)
            .await
            .map_err(closed)?;
        Ok(StagedPreparation {
            account: Arc::new(Account {
                state: Mutex::new(AccountState {
                    charge,
                    capacity: bytes,
                    claimed: 0,
                }),
            }),
            full: self.resident.clone(),
            full_capacity: self.policy.resident_bytes,
        })
    }

    /// Admit an entire read/transform/upload envelope before its first allocation.
    pub async fn acquire_work(&self) -> io::Result<WorkLease> {
        let permit = self
            .progress
            .clone()
            .acquire_many_owned(self.policy.work_bytes as u32)
            .await
            .map_err(closed)?;
        Ok(WorkLease {
            inner: Arc::new(Work {
                _permit: permit,
                allocations: Arc::new(Semaphore::new(self.policy.work_bytes)),
                capacity: self.policy.work_bytes,
            }),
        })
    }

    /// Stop new admission and wake waiting selectors; existing owners retain their charges.
    pub fn close(&self) {
        self.staging.close();
        self.resident.close();
        self.progress.close();
    }
}

/// A frozen source waiting for its one complete active reservation.
#[derive(Debug)]
pub struct StagedPreparation {
    account: Arc<Account>,
    full: Arc<Semaphore>,
    full_capacity: usize,
}

impl StagedPreparation {
    pub fn directory(&self, bytes: usize) -> io::Result<DirectoryLease> {
        self.account.directory(bytes)
    }

    /// Transfer every existing directory owner to one complete active charge.
    pub async fn promote(self, bytes: usize) -> io::Result<ActivePreparation> {
        check_envelope(bytes, self.full_capacity)?;
        {
            let mut state = self
                .account
                .state
                .lock()
                .expect("preparation account poisoned");
            if bytes < state.claimed {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "active envelope is smaller than existing directory allocations",
                ));
            }
            if bytes < state.capacity {
                let unused = state.capacity - bytes;
                drop(state.charge.split(unused));
                state.capacity = bytes;
            }
        }
        // No account lock is held while waiting for the only Full admission.
        let charge = self
            .full
            .acquire_many_owned(bytes as u32)
            .await
            .map_err(closed)?;
        let old_charge = {
            let mut state = self
                .account
                .state
                .lock()
                .expect("preparation account poisoned");
            state.capacity = bytes;
            std::mem::replace(&mut state.charge, charge)
        };
        drop(old_charge);
        Ok(ActivePreparation {
            account: self.account,
        })
    }
}

/// One complete request envelope; directory claims never wait for Host admission.
#[derive(Debug)]
pub struct ActivePreparation {
    account: Arc<Account>,
}

impl ActivePreparation {
    pub fn capacity(&self) -> usize {
        self.account
            .state
            .lock()
            .expect("preparation account poisoned")
            .capacity
    }

    pub fn directory(&self, bytes: usize) -> io::Result<DirectoryLease> {
        self.account.directory(bytes)
    }
}

#[derive(Debug)]
struct Account {
    state: Mutex<AccountState>,
}

#[derive(Debug)]
struct AccountState {
    charge: OwnedSemaphorePermit,
    capacity: usize,
    claimed: usize,
}

impl Account {
    fn directory(self: &Arc<Self>, bytes: usize) -> io::Result<DirectoryLease> {
        let mut state = self.state.lock().expect("preparation account poisoned");
        if bytes > state.capacity - state.claimed {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "directory allocation exceeds planned preparation envelope",
            ));
        }
        state.claimed += bytes;
        Ok(DirectoryLease {
            account: self.clone(),
            capacity: bytes,
        })
    }
}

/// Keep this owner with the directory allocation, including shared snapshots.
#[derive(Debug)]
pub struct DirectoryLease {
    account: Arc<Account>,
    capacity: usize,
}

impl DirectoryLease {
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Partition an already admitted directory envelope without further admission.
    pub fn split(&mut self, bytes: usize) -> io::Result<Self> {
        if bytes > self.capacity {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "directory split exceeds reservation",
            ));
        }
        self.capacity -= bytes;
        Ok(Self {
            account: self.account.clone(),
            capacity: bytes,
        })
    }

    /// Recycle unused allocation locally; retain the request's global charge.
    pub fn shrink_to(&mut self, bytes: usize) {
        let unused = self
            .capacity
            .checked_sub(bytes)
            .expect("directory allocation exceeds reservation");
        self.account
            .state
            .lock()
            .expect("preparation account poisoned")
            .claimed -= unused;
        self.capacity = bytes;
    }
}

impl Drop for DirectoryLease {
    fn drop(&mut self) {
        self.account
            .state
            .lock()
            .expect("preparation account poisoned")
            .claimed -= self.capacity;
    }
}

fn check_envelope(bytes: usize, capacity: usize) -> io::Result<()> {
    if bytes > capacity {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "preparation envelope requires request-local backing",
        ));
    }
    Ok(())
}

/// A prepaid progress envelope; buffer and Bytes owners can outlive this handle.
#[derive(Debug)]
pub struct WorkLease {
    inner: Arc<Work>,
}
impl WorkLease {
    /// Allocation waits recycle only this envelope, never acquire more Host allowance.
    pub fn budget(&self) -> Arc<dyn SourceBudget> {
        Arc::new(WorkBudget(self.inner.clone()))
    }
}

#[derive(Debug)]
struct Work {
    _permit: OwnedSemaphorePermit,
    allocations: Arc<Semaphore>,
    capacity: usize,
}

#[derive(Debug)]
struct Allocation {
    _work: Arc<Work>,
    _permit: OwnedSemaphorePermit,
    _extra: Option<OwnedSemaphorePermit>,
}

struct WorkBudget(Arc<Work>);

impl SourceBudget for WorkBudget {
    fn allocate(&self, minimum: usize) -> Allocate<'_> {
        Box::pin(async move {
            let work = &self.0;
            if minimum > work.capacity {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "allocation exceeds prepaid work envelope",
                ));
            }
            let permit = work
                .allocations
                .clone()
                .acquire_many_owned(minimum as u32)
                .await
                .map_err(closed)?;
            let mut bytes = Vec::new();
            bytes.try_reserve_exact(minimum).map_err(io::Error::other)?;
            let extra = bytes.capacity() - minimum;
            let extra = if extra == 0 {
                None
            } else {
                // Allocator rounding cannot introduce a second async acquisition while
                // an allocation is held. A failed exact-capacity admission frees it.
                Some(
                    work.allocations
                        .clone()
                        .try_acquire_many_owned(u32::try_from(extra).map_err(io::Error::other)?)
                        .map_err(io::Error::other)?,
                )
            };
            bytes.resize(minimum, 0);
            Ok(ChargedBuffer::new(
                bytes,
                Allocation {
                    _work: work.clone(),
                    _permit: permit,
                    _extra: extra,
                },
            ))
        })
    }
}

fn closed(error: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::poll;
    use std::task::Poll;

    fn resources() -> ModelPreparationResources {
        ModelPreparationResources::new(PreparationPolicy {
            staging_bytes: 32,
            resident_bytes: 32,
            progress_bytes: 16,
            work_bytes: 16,
        })
        .unwrap()
    }

    #[tokio::test]
    async fn upload_slice_retains_work_after_cursor_release() {
        let resources = resources();
        let work = resources.acquire_work().await.unwrap();
        let budget = work.budget();
        let buffer = budget.allocate(16).await.unwrap();
        let bytes = buffer.into_bytes(16);
        let slice = bytes.slice(3..5);
        drop(bytes);
        drop(budget);
        drop(work);
        let pending = resources.acquire_work();
        tokio::pin!(pending);
        assert!(matches!(poll!(&mut pending), Poll::Pending));
        assert_eq!(&slice[..], &[0, 0]);
        drop(slice);
        assert!(pending.await.is_ok());
    }

    #[tokio::test]
    async fn downstream_release_recycles_only_the_prepaid_envelope() {
        let resources = resources();
        let work = resources.acquire_work().await.unwrap();
        let budget = work.budget();
        let input = budget.allocate(8).await.unwrap();
        let output = budget.allocate(8).await.unwrap().into_bytes(8);
        let next = budget.allocate(8);
        tokio::pin!(next);
        assert!(matches!(poll!(&mut next), Poll::Pending));
        drop(output);
        let output = next.await.unwrap();
        assert_eq!(output.capacity(), 8);
        assert_eq!(input.capacity(), 8);
    }

    #[tokio::test]
    async fn promotion_transfers_existing_owners_and_releases_staging() {
        let resources = resources();
        let staged = resources.reserve_staging(32).await.unwrap();
        let source = staged.directory(16).unwrap();
        let staging_waiter = resources.reserve_staging(32);
        tokio::pin!(staging_waiter);
        assert!(matches!(poll!(&mut staging_waiter), Poll::Pending));
        let active = staged.promote(32).await.unwrap();
        let second = staging_waiter.await.unwrap();
        let pending = second.promote(32);
        tokio::pin!(pending);
        assert!(matches!(poll!(&mut pending), Poll::Pending));
        drop(active);
        assert!(matches!(poll!(&mut pending), Poll::Pending));
        assert_eq!(source.capacity(), 16);
        drop(source);
        let second = pending.await.unwrap();
        assert_eq!(second.directory(32).unwrap().capacity(), 32);
    }

    #[tokio::test]
    async fn directory_split_shrink_and_drop_recycle_only_local_capacity() {
        let resources = resources();
        let active = resources
            .reserve_staging(16)
            .await
            .unwrap()
            .promote(32)
            .await
            .unwrap();
        let mut directory = active.directory(32).unwrap();
        let slice = directory.split(8).unwrap();
        directory.shrink_to(16);
        assert_eq!(
            active.directory(9).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        let reused = active.directory(8).unwrap();
        drop(directory);
        assert_eq!(active.directory(16).unwrap().capacity(), 16);
        drop(reused);
        drop(active);
        let pending = resources.reserve_staging(32).await.unwrap().promote(32);
        tokio::pin!(pending);
        assert!(matches!(poll!(&mut pending), Poll::Pending));
        assert_eq!(slice.capacity(), 8);
        drop(slice);
        assert_eq!(pending.await.unwrap().directory(32).unwrap().capacity(), 32);
    }

    #[tokio::test]
    async fn cancelled_promotion_retains_source_charge_until_last_owner() {
        let resources = resources();
        let active = resources
            .reserve_staging(32)
            .await
            .unwrap()
            .promote(32)
            .await
            .unwrap();
        let staged = resources.reserve_staging(32).await.unwrap();
        let source = staged.directory(16).unwrap();
        {
            let pending = staged.promote(32);
            tokio::pin!(pending);
            assert!(matches!(poll!(&mut pending), Poll::Pending));
        }
        let pending = resources.reserve_staging(32);
        tokio::pin!(pending);
        assert!(matches!(poll!(&mut pending), Poll::Pending));
        drop(source);
        assert_eq!(pending.await.unwrap().directory(32).unwrap().capacity(), 32);
        drop(active);
        assert_eq!(
            resources
                .reserve_staging(32)
                .await
                .unwrap()
                .promote(32)
                .await
                .unwrap()
                .directory(32)
                .unwrap()
                .capacity(),
            32
        );
    }

    #[tokio::test]
    async fn smaller_full_plan_shrinks_staging_but_rejects_uncovered_allocations() {
        let resources = resources();
        let active = resources
            .reserve_staging(32)
            .await
            .unwrap()
            .promote(32)
            .await
            .unwrap();
        let staged = resources.reserve_staging(32).await.unwrap();
        let source = staged.directory(8).unwrap();
        let promotion = staged.promote(16);
        tokio::pin!(promotion);
        assert!(matches!(poll!(&mut promotion), Poll::Pending));
        let remainder = resources.reserve_staging(16).await.unwrap();
        assert_eq!(remainder.directory(16).unwrap().capacity(), 16);
        drop(active);
        let promoted = promotion.await.unwrap();
        assert_eq!(promoted.directory(8).unwrap().capacity(), 8);
        assert_eq!(
            promoted.directory(9).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        drop(source);
        drop(promoted);
        drop(remainder);
        let staged = resources.reserve_staging(32).await.unwrap();
        let source = staged.directory(17).unwrap();
        assert_eq!(
            staged.promote(16).await.unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(source.capacity(), 17);
    }

    #[tokio::test]
    async fn closing_admission_wakes_waiters_without_revoking_active_bytes() {
        let resources = resources();
        let work = resources.acquire_work().await.unwrap();
        let budget = work.budget();
        let bytes = budget.allocate(8).await.unwrap().into_bytes(8);
        let pending = resources.acquire_work();
        tokio::pin!(pending);
        assert!(matches!(poll!(&mut pending), Poll::Pending));
        resources.close();
        assert_eq!(pending.await.unwrap_err().kind(), io::ErrorKind::BrokenPipe);
        assert_eq!(bytes.len(), 8);
        assert!(budget.allocate(8).await.is_ok());
    }
}
