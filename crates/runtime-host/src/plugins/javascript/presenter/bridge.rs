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
use maka_js_runtime::plugin::{Bridge, Error as VmError};
use maka_plugins::{
    remote::{Caller, Error, Method},
    terminal_ui::view::{Reply, Request},
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio_util::task::TaskTracker;

pub(super) struct PageBridge {
    backend: Arc<dyn Method>,
    calls: Mutex<HashMap<String, Entry>>,
    scheduler: tokio::runtime::Handle,
    tasks: TaskTracker,
}
struct Entry {
    caller: Caller,
    input: Option<Value>,
    outcome: Arc<Mutex<Option<Value>>>,
    read: bool,
    recover: bool,
}
pub(super) struct Guard {
    bridge: Arc<PageBridge>,
    pub id: String,
    outcome: Arc<Mutex<Option<Value>>>,
    read: bool,
}
impl Guard {
    pub fn outcome(&self) -> Option<Value> {
        self.outcome.lock().unwrap().clone()
    }
    pub fn resolve(&self, result: Result<Value, Error>) -> Result<Value, Error> {
        if let Some(outcome) = self.outcome() {
            return Ok(outcome);
        }
        let value = result?;
        if !self.read {
            return Err(Error::Provider(
                "terminal backend returned no authoritative outcome".into(),
            ));
        }
        let reply: Reply = serde_json::from_value(value.clone()).map_err(invalid)?;
        reply.validate().map_err(invalid)?;
        if matches!(reply, Reply::Applied { .. } | Reply::Unrecorded) {
            return Err(invalid("a terminal Read cannot produce a mutation outcome"));
        }
        Ok(value)
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        self.bridge.calls.lock().unwrap().remove(&self.id);
    }
}
impl PageBridge {
    pub fn new(backend: Arc<dyn Method>) -> Self {
        Self {
            backend,
            calls: Mutex::default(),
            scheduler: tokio::runtime::Handle::current(),
            tasks: TaskTracker::new(),
        }
    }
    pub fn enter(self: &Arc<Self>, input: &Value, caller: Caller) -> Result<Guard, Error> {
        let request: Request = serde_json::from_value(input.clone()).map_err(invalid)?;
        request.validate().map_err(invalid)?;
        if caller.cancellation.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let mut calls = self.calls.lock().unwrap();
        if self.tasks.is_closed() || calls.len() >= 16 {
            return Err(Error::Provider("terminal page is closed or busy".into()));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let read = matches!(request, Request::Read { .. });
        let outcome: Arc<Mutex<Option<Value>>> = Arc::default();
        calls.insert(
            id.clone(),
            Entry {
                caller,
                input: Some(input.clone()),
                outcome: outcome.clone(),
                read,
                recover: matches!(request, Request::Recover { .. }),
            },
        );
        Ok(Guard {
            bridge: self.clone(),
            id,
            outcome,
            read,
        })
    }
    pub fn cancel(&self) -> Vec<String> {
        let calls = self.calls.lock().unwrap();
        self.tasks.close();
        for entry in calls.values() {
            entry.caller.cancellation.cancel();
        }
        calls.keys().cloned().collect()
    }
    pub async fn drained(&self) -> Result<(), Error> {
        tokio::time::timeout(std::time::Duration::from_secs(5), self.tasks.wait())
            .await
            .map_err(|_| Error::CleanupUnconfirmed)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Backend {
    authority: String,
}
impl Bridge for PageBridge {
    fn max_output_bytes(&self, _: &str) -> usize {
        64 * 1024
    }
    fn call(&self, method: String, input: Value) -> BoxFuture<'static, Result<Value, VmError>> {
        let result = (|| {
            if method != "page.backend" {
                return Err(vm_error("terminal capability is unavailable"));
            }
            let Backend { authority } = serde_json::from_value(input).map_err(vm_error)?;
            let mut calls = self.calls.lock().unwrap();
            if self.tasks.is_closed() {
                return Err(vm_error("terminal page is retired"));
            }
            let entry = calls
                .get_mut(&authority)
                .filter(|entry| !entry.caller.cancellation.is_cancelled())
                .ok_or_else(|| vm_error("terminal call is retired"))?;
            let input = entry
                .input
                .take()
                .ok_or_else(|| vm_error("terminal backend ticket was already consumed"))?;
            let caller = entry.caller.clone();
            let outcome = entry.outcome.clone();
            let (read, recover) = (entry.read, entry.recover);
            let mut ticket = caller.resources.reserve().map_err(vm_error)?;
            ticket.start();
            let backend = self.backend.clone();
            // The original caller, JSON and resource ticket remain Host-owned
            // even after UI teardown drops its promise or attempts to replace it.
            let task = self.tasks.spawn_on(
                async move {
                    let result = backend.call(input, caller).await.and_then(|value| {
                        maka_plugins::remote::validate_payload(&value)?;
                        if !read {
                            let reply: Reply =
                                serde_json::from_value(value.clone()).map_err(invalid)?;
                            reply.validate().map_err(invalid)?;
                            if recover
                                && !matches!(
                                    reply,
                                    Reply::Applied { .. }
                                        | Reply::Unrecorded
                                        | Reply::Conflict
                                        | Reply::Rejected { .. }
                                )
                            {
                                return Err(invalid("invalid terminal recovery outcome"));
                            }
                            *outcome.lock().unwrap() = Some(value.clone());
                        }
                        Ok(value)
                    });
                    ticket.complete(match &result {
                        Err(Error::CleanupUnconfirmed) => {
                            Err("terminal backend cleanup is unconfirmed".into())
                        }
                        _ => Ok(()),
                    });
                    result.map_err(vm_error)
                },
                &self.scheduler,
            );
            Ok(task)
        })();
        Box::pin(async move { result?.await.map_err(vm_error)? })
    }
}
fn invalid(error: impl ToString) -> Error {
    Error::Invalid(error.to_string())
}
fn vm_error(error: impl ToString) -> VmError {
    VmError(error.to_string())
}

#[cfg(test)]
mod tests;
