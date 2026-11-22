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

//! Request-scoped ownership of Hyper connection, HTTP/2 and pool tasks.
use std::sync::{Arc, Mutex};
use tokio::task::AbortHandle;
use tokio_util::task::TaskTracker;

#[derive(Default)]
struct State {
    sealed: bool,
    tasks: Vec<AbortHandle>,
}

/// Owns one client's drivers. Each request/hop uses a dedicated client so
/// cancellation cannot abort an unrelated request multiplexed on HTTP/2.
#[derive(Default)]
pub struct ConnectionTasks {
    state: Arc<Mutex<State>>,
    tracker: TaskTracker,
}
impl ConnectionTasks {
    pub fn client_builder(&self, builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
        let state = self.state.clone();
        let tracker = self.tracker.clone();
        builder.connection_executor(move |future| {
            let mut state = state.lock().unwrap();
            if state.sealed {
                // Even recursively spawned tasks are rejected after sealing.
                drop(state);
                drop(future);
                return;
            }
            state.tasks.retain(|task| !task.is_finished());
            state.tasks.push(tracker.spawn(future).abort_handle());
        })
    }
    fn abort(&self) {
        let mut state = self.state.lock().unwrap();
        state.sealed = true;
        for task in state.tasks.drain(..) {
            task.abort();
        }
        self.tracker.close();
    }
    /// Sealing and aborting are atomic with task registration. TaskTracker waits
    /// until every future has actually been dropped; this wait is cancel-safe.
    pub async fn close(&self) {
        self.abort();
        self.tracker.wait().await;
    }
}
impl Drop for ConnectionTasks {
    fn drop(&mut self) {
        // Drop initiates cleanup only. Callers must await close for confirmation.
        self.abort();
    }
}
