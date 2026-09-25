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

pub(super) use maka_plugins::call::Scope as Authority;
use maka_runtime::tools::ToolError;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

pub(super) struct Calls {
    pub revisions: super::revision::Revisions,
    issuer: maka_plugins::call::Issuer,
    invocations: Mutex<BTreeMap<String, Authority>>,
    remotes: Mutex<BTreeMap<String, maka_plugins::remote::Caller>>,
    reads: Mutex<BTreeMap<String, ReadEntry>>,
}
struct ReadEntry {
    view: maka_plugins::filesystem::ReadDirectory,
    remote: Option<String>,
}
impl Calls {
    pub fn new(issuer: maka_plugins::call::Issuer) -> Self {
        Self {
            issuer,
            revisions: Default::default(),
            invocations: Default::default(),
            remotes: Default::default(),
            reads: Default::default(),
        }
    }
    pub fn forward(self: &Arc<Self>, authority: Authority) -> Result<Guard, ToolError> {
        if !self.issuer.owns(&authority) || authority.cancellation.is_cancelled() {
            return Err(ToolError::Failed(
                "foreign or closed plugin invocation".into(),
            ));
        }
        let mut calls = self.invocations.lock().unwrap();
        if calls.len() >= 128 {
            return Err(ToolError::Failed(
                "plugin invocation capacity exceeded".into(),
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        calls.insert(id.clone(), authority.clone());
        Ok(Guard {
            calls: self.clone(),
            id,
            authority,
        })
    }
    pub fn get(&self, id: &str) -> Result<Authority, maka_plugins::Error> {
        self.invocations
            .lock()
            .unwrap()
            .get(id)
            .filter(|call| !call.cancellation.is_cancelled())
            .cloned()
            .ok_or(maka_plugins::Error::Retired)
    }

    pub fn borrow_read(
        self: &Arc<Self>,
        view: maka_plugins::filesystem::ReadDirectory,
    ) -> Result<ReadGuard, maka_plugins::Error> {
        let mut reads = self.reads.lock().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        reads.insert(id.clone(), ReadEntry { view, remote: None });
        Ok(ReadGuard {
            calls: self.clone(),
            id,
        })
    }

    pub fn read(
        &self,
        id: &str,
    ) -> Result<maka_plugins::filesystem::ReadDirectory, maka_plugins::Error> {
        self.reads
            .lock()
            .unwrap()
            .get(id)
            .map(|entry| entry.view.clone())
            .ok_or(maka_plugins::Error::Retired)
    }

    pub fn remote_read(
        &self,
        authority: &str,
        view: maka_plugins::filesystem::ReadDirectory,
    ) -> Result<String, maka_plugins::Error> {
        let remotes = self.remotes.lock().unwrap();
        let caller = remotes.get(authority).ok_or(maka_plugins::Error::Retired)?;
        if caller.cancellation.is_cancelled() {
            return Err(maka_plugins::Error::Retired);
        }
        let mut reads = self.reads.lock().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        reads.insert(
            id.clone(),
            ReadEntry {
                view,
                remote: Some(authority.into()),
            },
        );
        Ok(id)
    }

    pub fn enter_remote(
        self: &Arc<Self>,
        mut caller: maka_plugins::remote::Caller,
    ) -> Result<RemoteGuard, maka_plugins::remote::Error> {
        if caller.cancellation.is_cancelled() {
            return Err(maka_plugins::remote::Error::Cancelled);
        }
        let mut calls = self.remotes.lock().unwrap();
        // Stream callers retain authority until close. These owned identities
        // are not executing work; the VM separately bounds ordinary calls.
        let id = uuid::Uuid::new_v4().to_string();
        caller.cancellation = caller.cancellation.child_token();
        let cancellation = caller.cancellation.clone();
        calls.insert(id.clone(), caller);
        Ok(RemoteGuard {
            calls: self.clone(),
            id,
            cancellation,
        })
    }

    pub fn remote(&self, id: &str) -> Result<maka_plugins::remote::Caller, maka_plugins::Error> {
        self.remotes
            .lock()
            .unwrap()
            .get(id)
            .filter(|caller| !caller.cancellation.is_cancelled())
            .cloned()
            .ok_or(maka_plugins::Error::Retired)
    }
}
pub(super) struct RemoteGuard {
    calls: Arc<Calls>,
    pub id: String,
    pub cancellation: CancellationToken,
}
pub(super) struct ReadGuard {
    calls: Arc<Calls>,
    pub id: String,
}
impl Drop for ReadGuard {
    fn drop(&mut self) {
        let removed = self.calls.reads.lock().unwrap().remove(&self.id);
        drop(removed);
    }
}
impl Drop for RemoteGuard {
    fn drop(&mut self) {
        self.cancellation.cancel();
        self.calls.remotes.lock().unwrap().remove(&self.id);
        let removed: Vec<_> = self
            .calls
            .reads
            .lock()
            .unwrap()
            .extract_if(.., |_, entry| entry.remote.as_ref() == Some(&self.id))
            .collect();
        drop(removed);
    }
}
pub(super) struct Guard {
    calls: Arc<Calls>,
    pub id: String,
    pub authority: Authority,
}
impl Drop for Guard {
    fn drop(&mut self) {
        self.authority.cancellation.cancel();
        self.calls.invocations.lock().unwrap().remove(&self.id);
    }
}

#[cfg(test)]
mod tests;
