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

use futures_util::FutureExt;
use maka_agent_facts::tools::{ToolError, ToolFuture};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio::sync::{Notify, oneshot};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

#[derive(Clone, Default)]
pub(crate) struct Executions(Arc<State>);

#[derive(Default)]
struct State {
    active: Mutex<BTreeMap<String, CancellationToken>>,
    changed: Notify,
    tasks: TaskTracker,
    failure: Mutex<Option<ToolError>>,
}

impl Executions {
    pub(crate) fn start(
        &self,
        operation: String,
        future: ToolFuture,
        cancellation: CancellationToken,
    ) -> ToolFuture {
        let state = self.0.clone();
        state
            .active
            .lock()
            .unwrap()
            .insert(operation.clone(), cancellation);
        let (send, receive) = oneshot::channel();
        self.0.tasks.spawn(async move {
            let result = std::panic::AssertUnwindSafe(future)
                .catch_unwind()
                .await
                .unwrap_or_else(|_| Err(ToolError::CleanupUnconfirmed("tool panicked".into())));
            if let Err(
                error @ (ToolError::Persistence(_)
                | ToolError::CleanupUnconfirmed(_)
                | ToolError::OperationCleanupUnconfirmed { .. }),
            ) = &result
            {
                state
                    .failure
                    .lock()
                    .unwrap()
                    .get_or_insert_with(|| error.clone());
            }
            state.active.lock().unwrap().remove(&operation);
            state.changed.notify_one();
            let _ = send.send(result);
        });
        Box::pin(async move {
            receive
                .await
                .map_err(|_| ToolError::CleanupUnconfirmed("tool completion owner closed".into()))?
        })
    }

    pub(crate) fn is_idle(&self) -> bool {
        self.0.active.lock().unwrap().is_empty()
    }

    pub(crate) async fn changed(&self) {
        self.0.changed.notified().await;
    }

    pub(crate) fn check(&self) -> Result<(), ToolError> {
        match self.0.failure.lock().unwrap().clone() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    pub(crate) fn cancel(&self) {
        for token in self.0.active.lock().unwrap().values() {
            token.cancel();
        }
    }

    pub(crate) async fn shutdown(&self) -> Result<(), ToolError> {
        self.cancel();
        self.0.tasks.close();
        self.0.tasks.wait().await;
        self.check()
    }
}
