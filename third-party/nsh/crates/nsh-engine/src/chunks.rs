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

//! Shared asynchronous source loading for native engines.

use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

use crossbeam_channel::Sender;
use rustc_hash::FxHashMap;
use tokio::{runtime::Handle, task::JoinHandle};

use crate::{Chunk, Message};

/// A module's JavaScript source and the location of its imported assets.
#[derive(Clone, Debug, Default)]
#[non_exhaustive]
pub struct ChunkSource {
    /// The compiled ES module source.
    pub code: String,
    /// The directory against which imported asset paths are resolved.
    pub asset_base: Option<String>,
}

impl ChunkSource {
    /// Source whose imported assets use the application's asset root.
    pub fn new(code: String) -> Self {
        Self {
            code,
            asset_base: None,
        }
    }

    /// Gives imported assets a directory of their own.
    pub fn with_asset_base(mut self, base: impl Into<String>) -> Self {
        self.asset_base = Some(base.into());
        self
    }
}

/// The JavaScript source of a module, or why it could not be read.
pub type ChunkLoad = Pin<Box<dyn Future<Output = Result<ChunkSource, String>> + Send + 'static>>;

/// Loads the source of modules an app imports at runtime.
///
/// The engine runs the future on its configured asynchronous runtime. Blocking
/// reads or CPU work belong on that runtime's blocking workers.
pub trait ChunkLoader: Send + Sync + 'static {
    /// Reads the module named by `id`, a flat `.js` file name.
    fn load(&self, id: &str) -> ChunkLoad;
}

type Notify = Arc<dyn Fn() + Send + Sync>;

pub(crate) struct Loads {
    loader: Arc<dyn ChunkLoader>,
    runtime: Handle,
    tx: Sender<Message>,
    tasks: FxHashMap<String, JoinHandle<()>>,
    notify: Arc<Mutex<Option<Notify>>>,
}

impl Loads {
    pub(crate) fn new(loader: Arc<dyn ChunkLoader>, runtime: Handle, tx: Sender<Message>) -> Self {
        Self {
            loader,
            runtime,
            tx,
            tasks: FxHashMap::default(),
            notify: Arc::default(),
        }
    }

    pub(crate) fn set_notify(&self, notify: Notify) {
        *self.notify.lock().expect("chunk notify lock") = Some(notify);
    }

    pub(crate) fn load(&mut self, id: &str) {
        let loader = self.loader.clone();
        let id = id.to_owned();
        let tx = self.tx.clone();
        let notify = self.notify.clone();
        let task_id = id.clone();
        let task = self.runtime.spawn(async move {
            let result = loader
                .load(&id)
                .await
                .map(|source| {
                    let mut chunk = Chunk::source(id.clone(), source.code);
                    chunk.asset_base = source.asset_base.map(Arc::from);
                    chunk
                })
                .map_err(|message| (id, message));
            if tx.send(Message::Chunk(result)).is_ok() {
                let notify = notify.lock().expect("chunk notify lock").clone();
                if let Some(notify) = notify {
                    notify();
                }
            }
        });
        self.tasks.insert(task_id, task);
    }

    pub(crate) fn finished(&mut self, id: &str) {
        self.tasks.remove(id);
    }
}

impl Drop for Loads {
    fn drop(&mut self) {
        for (_, task) in self.tasks.drain() {
            task.abort();
        }
    }
}
