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

//! Recoverable Host filesystem authority attached to one native command tree.
use crate::{command::Cleanup, windows::job::Job};
use maka_sandbox::windows::ExecutionJob;
use std::{io, os::windows::io::AsHandle};

/// The Host binds recoverable guards to this exact named execution Job before
/// launch. The process owner retains the lease through native and proxy drain.
pub struct Lease {
    job: ExecutionJob,
    cleanup: Cleanup,
}
impl Lease {
    pub fn new(
        job: ExecutionJob,
        cleanup: impl FnOnce() -> io::Result<()> + Send + Sync + 'static,
    ) -> Self {
        Self {
            job,
            cleanup: Cleanup::new(cleanup),
        }
    }

    pub(super) fn job(&self) -> io::Result<Job> {
        Ok(Job(self.job.as_handle().try_clone_to_owned()?))
    }

    /// Roll back a preparation that has not launched, or finish after the native
    /// owner has observed every process fence and drained its proxy. The private
    /// Job handle cannot be used to launch through this lease after transfer.
    pub async fn finish(&mut self) -> io::Result<()> {
        if !self.job()?.is_empty()? {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "MXC execution is still running",
            ));
        }
        self.cleanup.finish().await
    }
}
