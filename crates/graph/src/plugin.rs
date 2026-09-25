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

mod definitions;
mod operators;
mod read;
mod remote;
mod session;
mod terminal;
mod tools;

use crate::{Mode, owner::Handle};
use futures_util::future::BoxFuture;
use maka_plugins::{
    client::{Bundle, Client},
    composition::Scope,
    contributions::Staged,
    fiber::Context,
    kernel::{Plugin, PluginContext},
    session::SessionBehavior,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

pub const ID: &str = "maka.agent-graph";

pub struct Builtin {
    pub bundle: Arc<Bundle>,
}
impl Plugin for Builtin {
    fn supports_scope(&self, scope: &Scope) -> bool {
        matches!(scope, Scope::Profile | Scope::DesktopUi)
    }
    fn validate(&self, _: &Scope, config: &Value) -> Result<(), maka_plugins::Error> {
        if config.is_null() || config.as_object().is_some_and(|object| object.is_empty()) {
            Ok(())
        } else {
            Err(maka_plugins::Error::Invalid(
                "Agent Graph currently takes no instance configuration".into(),
            ))
        }
    }
    fn activate(
        &self,
        context: PluginContext,
        config: Value,
    ) -> BoxFuture<'static, Result<Staged, String>> {
        let bundle = self.bundle.clone();
        if context
            .lifecycle
            .identity()
            .is_ok_and(|identity| identity.scope == Scope::DesktopUi)
        {
            return Box::pin(async move {
                let identity = context.lifecycle.identity().map_err(error)?;
                let mut staged = Staged::default();
                staged
                    .insert(identity.entry_id, Client { bundle, config })
                    .map_err(error)?;
                Ok(staged)
            });
        }
        let repository = context
            .host
            .as_ref()
            .ok_or_else(|| "Graph Host capabilities are unavailable".to_owned())
            .and_then(|host| {
                let identity = context.lifecycle.identity().map_err(error)?;
                crate::repository::Repository::new(host.storage.clone(), &identity.entry_id)
                    .map(Arc::new)
                    .map_err(error)
            });
        let models = context.host.as_ref().map(|host| host.models.clone());
        let settings = context
            .host
            .as_ref()
            .map(|host| Arc::new(crate::settings::Settings::new(host.storage.clone())));
        let parent = context.lifecycle;
        let access = context.host.as_ref().map(|host| {
            Arc::new(crate::access::Access {
                storage: host.storage.clone(),
                executions: host.executions.clone(),
                authorizations: host.authorizations.clone(),
            })
        });
        Box::pin(async move {
            let manager = Arc::new(Manager {
                parent,
                repository: repository?,
                settings: settings.ok_or("Graph storage is unavailable")?,
                models: models.ok_or("Graph Host models are unavailable")?,
                access: access.ok_or("Graph Host capabilities are unavailable")?,
                changed: tokio::sync::watch::channel(()).0,
                roots: Mutex::default(),
                recovering: AtomicBool::new(true),
            });
            let recovery = manager.clone();
            manager
                .parent
                .spawn("recover Agent Graph Sessions", async move {
                    recovery.parent.effective().await.map_err(error)?;
                    let mut delay = Duration::from_millis(250);
                    loop {
                        if recovery.restore().await.is_ok() {
                            recovery.recovering.store(false, Ordering::Release);
                            return Ok(());
                        }
                        tokio::time::sleep(delay).await;
                        delay = (delay * 2).min(Duration::from_secs(30));
                    }
                })
                .map_err(error)?;
            let mut staged = Staged::default();
            remote::register(&mut staged, manager.clone(), &bundle.content_digest)?;
            tools::register(&mut staged, manager.clone())?;
            staged
                .insert(
                    "agent-graph",
                    manager.clone() as Arc<dyn maka_plugins::background::BackgroundWork>,
                )
                .map_err(error)?;
            for (id, mode) in [("graph", Mode::Graph), ("swarm", Mode::Swarm)] {
                staged
                    .insert(
                        id,
                        SessionBehavior::new(Arc::new(session::GraphBehavior {
                            manager: manager.clone(),
                            mode,
                        })),
                    )
                    .map_err(error)?;
            }
            Ok(staged)
        })
    }
}

type Slot = Arc<tokio::sync::Mutex<Option<Root>>>;
struct Manager {
    settings: Arc<crate::settings::Settings>,
    models: Arc<dyn maka_plugins::llm::Models>,
    parent: Context,
    repository: Arc<crate::repository::Repository>,
    access: Arc<crate::access::Access>,
    changed: tokio::sync::watch::Sender<()>,
    roots: Mutex<BTreeMap<String, Slot>>,
    recovering: AtomicBool,
}
impl maka_plugins::background::BackgroundWork for Manager {
    fn is_pending(&self) -> bool {
        if self.recovering.load(Ordering::Acquire) {
            return true;
        }
        self.roots.lock().unwrap().values().any(|slot| {
            let Ok(slot) = slot.try_lock() else {
                return true;
            };
            slot.as_ref().is_some_and(|root| {
                let view = root.handle.snapshot();
                !root.cancel.is_cancelled() && (!view.initialized || view.pending_work)
            })
        })
    }
}
pub(crate) struct Root {
    pub(crate) revision: maka_plugins::revision::Revision,
    pub(crate) commands: Arc<dyn maka_plugins::execution::Commands>,
    pub(crate) cancel: tokio_util::sync::CancellationToken,
    pub(crate) done: futures_util::future::Shared<BoxFuture<'static, Result<(), String>>>,
    operators: Arc<NativeOperators>,
    pub(crate) handle: Handle,
    pub(crate) mode: Mode,
}

impl Root {
    async fn shutdown(&self) -> Result<(), String> {
        let _invalidating = self.revision.invalidate().await;
        self.cancel.cancel();
        tokio::time::timeout(Duration::from_secs(10), self.done.clone())
            .await
            .map_err(|_| "Graph coordinator cleanup timed out".to_owned())?
    }
}

struct NativeOperators {
    revision: maka_plugins::revision::Revision,
    repository: Arc<crate::repository::Repository>,
    commands: Arc<dyn maka_plugins::execution::Commands>,
    cancel: tokio_util::sync::CancellationToken,
    root: String,
    graph_id: crate::GraphId,
    definitions: definitions::Definitions,
    storage: Arc<dyn maka_plugins::storage::Store>,
}
fn error(error: impl ToString) -> String {
    error.to_string()
}
pub(crate) fn now() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(error)?
        .as_millis()
        .try_into()
        .map_err(|_| "system clock overflow".into())
}
