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

use futures_util::future::BoxFuture;
use maka_agent_facts::event::Invocation;
use maka_agent_ports::execution::Receipt;
use maka_assistant::plan::{Artifact, Command, Request, Snapshot, Step};
use maka_capabilities::storage::Mutation;
use maka_capabilities::storage::Namespace;
use maka_capabilities::storage::Page;
use maka_capabilities::storage::Record;
use maka_capabilities::storage::Scan;
use maka_capabilities::storage::Store;
use maka_capabilities::storage::StoreError;
use maka_event_log::EventLog;
use maka_plugin_core::scope::Scope;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub struct Storage {
    log: Arc<EventLog>,
    namespace: Namespace,
    pub lose_reply: AtomicBool,
}
impl Storage {
    pub fn new(log: Arc<EventLog>) -> Arc<Self> {
        Arc::new(Self {
            log,
            namespace: Namespace::new("example.planning", Scope::Profile).unwrap(),
            lose_reply: AtomicBool::new(false),
        })
    }
}
impl Store for Storage {
    fn read(&self, key: String) -> BoxFuture<'_, Result<Option<Record>, StoreError>> {
        Box::pin(async move {
            self.log
                .plugin_data(&self.namespace, &key)
                .await
                .map_err(storage_error)
        })
    }
    fn scan(&self, query: Scan) -> BoxFuture<'_, Result<Page, StoreError>> {
        Box::pin(async move {
            self.log
                .plugin_data_scan(&self.namespace, query)
                .await
                .map_err(storage_error)
        })
    }
    fn batch(&self, mutations: Vec<Mutation>) -> BoxFuture<'_, Result<Vec<Record>, StoreError>> {
        Box::pin(async move {
            let result = self
                .log
                .plugin_data_batch(&self.namespace, mutations)
                .await
                .map_err(storage_error)?;
            if self.lose_reply.swap(false, Ordering::SeqCst) {
                return Err(StoreError::OutcomeUnknown("lost committed reply".into()));
            }
            Ok(result)
        })
    }
}
fn storage_error(error: maka_event_log::StoreError) -> StoreError {
    match error {
        maka_event_log::StoreError::RevisionConflict { expected, actual } => {
            StoreError::Conflict { expected, actual }
        }
        error => StoreError::Unavailable(error.to_string()),
    }
}
pub fn draft() -> Artifact {
    Artifact {
        title: "Preserve exact execution identity".into(),
        overview: None,
        risks: vec![],
        steps: ["implement", "verify"]
            .map(|id| Step {
                id: id.into(),
                title: id.into(),
                description: format!("{id} the approved change"),
                files: vec![],
                complexity: None,
            })
            .into(),
    }
}
pub fn request(id: &str, revision: u64, command: Command) -> Request {
    Request {
        operation_id: id.into(),
        expected_revision: revision,
        command,
    }
}
pub fn host_receipt(state: &Snapshot, run: &str) -> Receipt {
    let execution = state.execution.as_ref().unwrap();
    Receipt {
        invocation: Invocation {
            session_id: "session".into(),
            turn_id: format!("turn_{run}"),
            run_id: run.into(),
            invocation_id: format!("invocation_{run}"),
        },
        message_id: format!("message_{run}"),
        content_digest: execution.request.digest().unwrap(),
    }
}
