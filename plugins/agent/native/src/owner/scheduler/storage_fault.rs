/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

use maka_event_log::root_store::RootStore;
use maka_plugin_core::storage::{Mutation, Namespace, Record, Store, StoreError};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

enum Fault {
    Unknown(oneshot::Sender<()>),
    Hold(oneshot::Sender<()>, oneshot::Receiver<()>),
}

/// Keep real atomic writes and retirement semantics; only alter their acknowledgement.
pub(in crate::owner) struct Storage {
    inner: Arc<maka_host_runtime::storage::Storage>,
    fault: Mutex<Option<(&'static str, Fault)>>,
}
impl std::ops::Deref for Storage {
    type Target = maka_host_runtime::storage::Storage;
    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}
impl Storage {
    pub(super) fn inner(&self) -> Arc<maka_host_runtime::storage::Storage> {
        self.inner.clone()
    }
    pub(super) fn new(store: Arc<RootStore>, prefix: String, namespace: Namespace) -> Self {
        Self {
            inner: Arc::new(maka_host_runtime::storage::Storage::new(
                store, prefix, namespace,
            )),
            fault: Mutex::new(None),
        }
    }
    pub(in crate::owner) fn unknown_after(&self, kind: &'static str) -> oneshot::Receiver<()> {
        let (sent, observed) = oneshot::channel();
        assert!(
            self.fault
                .lock()
                .unwrap()
                .replace((kind, Fault::Unknown(sent)))
                .is_none()
        );
        observed
    }
    pub(in crate::owner) fn hold_before(
        &self,
        kind: &'static str,
    ) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (entered, observed) = oneshot::channel();
        let (release, wait) = oneshot::channel();
        assert!(
            self.fault
                .lock()
                .unwrap()
                .replace((kind, Fault::Hold(entered, wait)))
                .is_none()
        );
        (observed, release)
    }
    pub(in crate::owner) async fn batch(
        &self,
        writes: Vec<Mutation>,
    ) -> Result<Vec<Record>, StoreError> {
        let fault = {
            let mut armed = self.fault.lock().unwrap();
            if armed.as_ref().is_some_and(|(kind, _)| {
                writes.iter().any(|write| {
                    write
                        .data
                        .value()
                        .is_some_and(|v| v["content"]["kind"] == *kind)
                })
            }) {
                armed.take().map(|(_, fault)| fault)
            } else {
                None
            }
        };
        let unknown = match fault {
            Some(Fault::Hold(entered, release)) => {
                entered.send(()).unwrap();
                release.await.unwrap();
                None
            }
            Some(Fault::Unknown(observed)) => Some(observed),
            None => None,
        };
        let records = self.inner.batch(writes).await?;
        if let Some(observed) = unknown {
            // Native Storage retires after OutcomeUnknown; recovery must reopen the owner.
            self.inner.finish().await.unwrap();
            observed.send(()).unwrap();
            return Err(StoreError::OutcomeUnknown(
                "test: committed batch acknowledgement lost".into(),
            ));
        }
        Ok(records)
    }
}
