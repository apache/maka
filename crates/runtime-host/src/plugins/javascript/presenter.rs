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

mod bridge;

use futures_util::future::BoxFuture;
use maka_js_runtime::plugin::{Limits, Module, Vm};
use maka_plugins::{
    package::{Package, validate_path},
    remote::{Caller, Error, Method},
    terminal_ui::presenter as api,
};
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tokio::sync::{Semaphore, watch};
use tokio_util::sync::CancellationToken;

/// One Host-wide admission budget, independent of business Dedicated VMs.
/// Four bounds simultaneous page heaps; hidden drafts do not reserve a slot.
pub(super) struct Capacity {
    slots: Arc<Semaphore>,
    limits: Limits,
}
impl Capacity {
    pub fn new(limits: Limits) -> Self {
        Self {
            slots: Arc::new(Semaphore::new(4)),
            limits,
        }
    }
}
pub(super) struct Factory {
    source: String,
    name: String,
    capacity: Arc<Capacity>,
    observations: Vec<api::Observation>,
    backend: Arc<dyn Method>,
    retiring: CancellationToken,
}
impl Factory {
    pub fn new(
        package: &Package,
        entry: &str,
        capacity: Arc<Capacity>,
        backend: Arc<dyn Method>,
        retiring: CancellationToken,
        observations: Vec<api::Observation>,
    ) -> Result<Self, Error> {
        validate_path(entry).map_err(invalid)?;
        let bytes = package
            .file(entry)
            .ok_or_else(|| invalid("terminal entry is missing"))?;
        let source = std::str::from_utf8(bytes).map_err(invalid)?.to_owned();
        Ok(Self {
            source,
            name: format!("{}:{entry}", package.digest()),
            capacity,
            observations,
            backend,
            retiring,
        })
    }
}
impl api::Factory for Factory {
    fn observations(&self) -> &[api::Observation] {
        &self.observations
    }
    fn open(&self, cancellation: CancellationToken) -> Result<Arc<dyn api::Page>, Error> {
        if cancellation.is_cancelled() || self.retiring.is_cancelled() {
            return Err(Error::Retired);
        }
        let reservation = self
            .capacity
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Provider("terminal page VM capacity exhausted".into()))?;
        let vm = Vm::new(self.capacity.limits.clone()).map_err(provider)?;
        let bridge = Arc::new(bridge::PageBridge::new(self.backend.clone()));
        let module = match vm.load_presenter(self.name.clone(), self.source.clone(), bridge.clone())
        {
            Ok(module) => module,
            Err(error) => {
                tokio::spawn(async move {
                    vm.shutdown().await;
                    drop(reservation);
                });
                return Err(provider(error));
            }
        };
        let stop = cancellation.child_token();
        let (done, closed) = watch::channel(None);
        let cancelling = module.clone();
        let page = Arc::new(Page(Arc::new(Inner {
            module,
            bridge: bridge.clone(),
            stop: stop.clone(),
            closed,
        })));
        let retiring = self.retiring.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = stop.cancelled() => {},
                _ = retiring.cancelled() => {},
                _ = vm.failed() => {},
            }
            stop.cancel();
            let ids = bridge.cancel();
            // Cooperative signals are best effort; worker teardown remains the
            // proof of UI cleanup even when a continuation ignores its signal.
            let _ = tokio::time::timeout(Duration::from_millis(200), async {
                for id in ids {
                    let _ = cancelling.cancel_call(id).await;
                }
            })
            .await;
            // A permit remains held until actual worker teardown, even if a
            // caller stops waiting. VM death is not unknown Host cleanup.
            vm.shutdown().await;
            let result = bridge.drained().await;
            drop(reservation);
            done.send_replace(Some(result));
        });
        Ok(page)
    }
}
struct Page(Arc<Inner>);
struct Inner {
    module: Module,
    bridge: Arc<bridge::PageBridge>,
    stop: CancellationToken,
    closed: watch::Receiver<Option<Result<(), Error>>>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}
impl Inner {
    async fn closed(&self) -> Result<(), Error> {
        let mut closed = self.closed.clone();
        let wait = async {
            loop {
                if let Some(result) = closed.borrow_and_update().clone() {
                    return result;
                }
                closed
                    .changed()
                    .await
                    .map_err(|_| Error::CleanupUnconfirmed)?;
            }
        };
        tokio::time::timeout(Duration::from_secs(5), wait)
            .await
            .map_err(|_| Error::CleanupUnconfirmed)?
    }
}
impl api::Page for Page {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        let page = self.0.clone();
        Box::pin(async move {
            if page.stop.is_cancelled() {
                return Err(Error::Retired);
            }
            let cancellation = caller.cancellation.clone();
            let guard = page.bridge.enter(&input, caller)?;
            let call = page.module.call(
                vec!["invoke".into()],
                vec![input, Value::String(guard.id.clone())],
            );
            tokio::pin!(call);
            let result = tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(Error::Cancelled),
                _ = page.stop.cancelled() => Err(Error::Retired),
                result = &mut call => result.map_err(provider),
            };
            let failed = result.is_err();
            let result = guard.resolve(result);
            if failed || result.is_err() {
                page.stop.cancel();
                let closed = page.closed().await;
                // Receipt authority and cleanup confirmation are independent.
                // Backend completion during teardown still settles this call.
                if let Some(outcome) = guard.outcome() {
                    return Ok(outcome);
                }
                closed?;
            }
            result
        })
    }
    fn cancel(&self) {
        self.0.stop.cancel();
        self.0.bridge.cancel();
    }
    fn retired(&self) -> BoxFuture<'_, ()> {
        Box::pin(self.0.stop.cancelled())
    }
    fn close(&self) -> BoxFuture<'_, Result<(), Error>> {
        self.cancel();
        Box::pin(self.0.closed())
    }
}
/// Only the document dispatcher can invoke this registration's private backend.
pub(super) struct Endpoint(pub Arc<Factory>);
impl Method for Endpoint {
    fn page_factory(&self) -> Option<Arc<dyn api::Factory>> {
        Some(self.0.clone())
    }
    fn call(&self, _: Value, _: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        Box::pin(async {
            Err(Error::Invalid(
                "terminal app requires an isolated document".into(),
            ))
        })
    }
}
fn invalid(error: impl ToString) -> Error {
    Error::Invalid(error.to_string())
}
fn provider(error: impl ToString) -> Error {
    Error::Provider(error.to_string())
}

#[cfg(test)]
mod tests;
