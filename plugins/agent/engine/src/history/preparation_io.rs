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

//! Request resource custody, independent of canonical history selection.

use maka_event_log::{
    StoreError,
    root_store::{SessionStore, WorkEffectLease},
};
use std::{io, sync::Arc};

#[derive(Clone)]
pub struct PreparationIo(Arc<Owner>);

struct Owner {
    lease: Option<WorkEffectLease>,
    runtime: tokio::runtime::Handle,
    observation: Option<(tokio_util::task::TaskTracker, crate::cleanup::Evidence)>,
}
impl Drop for Owner {
    fn drop(&mut self) {
        // This lease owns no file. Each file has its own explicit close receipt.
        self.lease
            .take()
            .expect("live preparation custody")
            .finish(Ok(()));
    }
}
impl PreparationIo {
    pub fn new(work: &SessionStore) -> Result<Self, StoreError> {
        Self::bind(work, None)
    }
    pub fn new_tracked(
        work: &SessionStore,
        workers: tokio_util::task::TaskTracker,
        physical: crate::cleanup::Evidence,
    ) -> Result<Self, StoreError> {
        Self::bind(work, Some((workers, physical)))
    }
    fn bind(
        work: &SessionStore,
        observation: Option<(tokio_util::task::TaskTracker, crate::cleanup::Evidence)>,
    ) -> Result<Self, StoreError> {
        let runtime = tokio::runtime::Handle::try_current().map_err(|error| {
            StoreError::InvalidTransition(format!(
                "preparation cleanup has no execution runtime: {error}"
            ))
        })?;
        Ok(Self(Arc::new(Owner {
            lease: Some(work.fork_effect()?),
            runtime,
            observation,
        })))
    }
    pub(crate) const fn metadata_bytes() -> usize {
        2 * std::mem::size_of::<usize>() + std::mem::size_of::<Owner>()
    }
    fn work(&self) -> SessionStore {
        self.0
            .lease
            .as_ref()
            .expect("live preparation custody")
            .store()
    }
    pub(crate) fn reserve_local_resource(&self) -> Result<WorkEffectLease, StoreError> {
        self.work().fork_effect()
    }
    pub(super) fn close_file_on_worker(&self, file: std::fs::File, resource: WorkEffectLease) {
        let owner = self.clone();
        let original = self.clone();
        // The original effect ticket, not this detached observer, owns cleanup.
        let job = async move {
            if let Err(error) = owner
                .with_local_io(move || original.close_file_in_worker(file, resource))
                .await
            {
                if let Some((_, physical)) = &owner.0.observation {
                    physical.observe(&crate::RunError::CleanupUnconfirmed);
                }
                tracing::error!(%error,"original request backing cleanup failed");
            }
        };
        let _cleanup = match &self.0.observation {
            Some((workers, _)) => workers.spawn_on(job, &self.0.runtime),
            None => self.0.runtime.spawn(job),
        };
    }
    pub(super) fn close_file_in_worker(
        &self,
        file: std::fs::File,
        resource: WorkEffectLease,
    ) -> io::Result<()> {
        match maka_event_log::root_store::close_request_file(file) {
            Ok(()) => {
                resource.finish(Ok(()));
                Ok(())
            }
            Err(receipt) => {
                if let Some((_, physical)) = &self.0.observation {
                    physical.observe(&crate::RunError::CleanupUnconfirmed);
                }
                let receipt = Arc::new(receipt);
                let error = io::Error::new(receipt.error().kind(), receipt.clone());
                // The observed descriptor is not an owned File and must never be closed again.
                resource.retain_unconfirmed((self.clone(), receipt), error.to_string());
                Err(error)
            }
        }
    }
    pub(crate) async fn with_local_io<T: Send + 'static>(
        &self,
        operation: impl FnOnce() -> io::Result<T> + Send + 'static,
    ) -> io::Result<T> {
        let owner = self.clone();
        self.work()
            .with_resource_io(move || {
                let _owner = owner;
                // Preserve I/O error identity rather than wrapping it in a StoreError.
                Ok(operation())
            })
            .await
            .map_err(io::Error::other)?
    }
}
