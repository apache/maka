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

use maka_agent_facts::tools::ToolError;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::task::{TaskTracker, task_tracker::TaskTrackerToken};

#[derive(Default)]
pub struct Resources {
    state: Mutex<State>,
    tasks: TaskTracker,
}
#[derive(Default)]
struct State {
    closed: bool,
    failure: Option<String>,
    retained: Vec<Box<dyn std::any::Any + Send>>,
}

impl Resources {
    /// Observe settlement without closing admission. Callers deciding retirement
    /// must independently fence every producer before relying on this result.
    pub fn is_idle(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.failure.is_none() && self.tasks.is_empty()
    }
    pub fn reserve(self: &Arc<Self>) -> Result<Ticket, ToolError> {
        let state = self.state.lock().unwrap();
        if state.closed {
            return Err(ToolError::Failed("invocation resources closed".into()));
        }
        Ok(Ticket {
            group: self.clone(),
            _token: self.tasks.token(),
            state: TicketState::Reserved,
        })
    }
    /// Seal original admission and inspect actual worker settlement without a
    /// timeout. `false` means still pending, never a failed cleanup receipt.
    pub fn seal(&self) -> Result<bool, ToolError> {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        self.tasks.close();
        match &state.failure {
            Some(error) => Err(ToolError::CleanupUnconfirmed(error.clone())),
            None => Ok(self.tasks.is_empty()),
        }
    }
    pub async fn finish(&self) -> Result<(), ToolError> {
        self.state.lock().unwrap().closed = true;
        self.tasks.close();
        tokio::time::timeout(Duration::from_secs(5), self.tasks.wait())
            .await
            .map_err(|_| ToolError::CleanupUnconfirmed("plugin resources did not settle".into()))?;
        match &self.state.lock().unwrap().failure {
            Some(error) => Err(ToolError::CleanupUnconfirmed(error.clone())),
            None => Ok(()),
        }
    }
}
pub struct Ticket {
    group: Arc<Resources>,
    _token: TaskTrackerToken,
    state: TicketState,
}
enum TicketState {
    Reserved,
    Started,
    Settled,
}
impl Ticket {
    pub fn start(&mut self) {
        self.state = TicketState::Started;
    }
    /// Preserve original custody when losing an observation cannot establish
    /// actual resource cleanup. A failed group never emits a successful receipt.
    pub fn unconfirmed(mut self, error: String, custody: impl std::any::Any + Send) {
        let mut state = self.group.state.lock().unwrap();
        state.failure.get_or_insert(error);
        state.retained.push(Box::new(custody));
        self.state = TicketState::Settled;
    }
    pub fn complete(mut self, result: Result<(), String>) {
        if let Err(error) = result {
            self.group
                .state
                .lock()
                .unwrap()
                .failure
                .get_or_insert(error);
        }
        self.state = TicketState::Settled;
    }
}
impl Drop for Ticket {
    fn drop(&mut self) {
        if matches!(self.state, TicketState::Started) {
            self.group
                .state
                .lock()
                .unwrap()
                .failure
                .get_or_insert_with(|| "plugin resource worker disappeared".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealing_waits_for_actual_original_tickets_and_closes_admission() {
        let group = Arc::new(Resources::default());
        let mut ticket = group.reserve().unwrap();
        ticket.start();
        assert!(!group.seal().unwrap());
        assert!(group.reserve().is_err());
        assert!(!group.seal().unwrap());
        ticket.complete(Ok(()));
        assert!(group.seal().unwrap());
    }

    #[test]
    fn unconfirmed_cleanup_keeps_original_custody_after_worker_observation_is_lost() {
        struct Custody(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Custody {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let group = Arc::new(Resources::default());
        let mut ticket = group.reserve().unwrap();
        ticket.start();
        ticket.unconfirmed("original observation lost".into(), Custody(dropped.clone()));
        assert!(group.seal().is_err());
        assert!(!dropped.load(std::sync::atomic::Ordering::SeqCst));
        drop(group);
        assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn known_failure_is_sticky_even_while_another_worker_is_pending() {
        let group = Arc::new(Resources::default());
        let mut failed = group.reserve().unwrap();
        failed.start();
        let held = group.reserve().unwrap();
        failed.complete(Err("original worker failed".into()));
        assert!(group.seal().is_err());
        drop(held);
        assert!(group.seal().is_err());

        let group = Arc::new(Resources::default());
        let mut lost = group.reserve().unwrap();
        lost.start();
        drop(lost);
        assert!(group.seal().is_err());
    }
}
