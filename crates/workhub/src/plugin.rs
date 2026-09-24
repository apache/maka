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

mod remote;
mod session;
mod tools;

use crate::{Access, Coordinator, Repository, assignment::Assignments};
use futures_util::future::BoxFuture;
use maka_plugins::{
    client::{Bundle, Client},
    composition::Scope,
    contributions::Staged,
    kernel::{Plugin, PluginContext},
};
use serde_json::Value;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tokio::sync::Notify;

pub const ID: &str = "maka.workhub";
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
                "WorkHub takes no Entry configuration".into(),
            ))
        }
    }
    fn activate(
        &self,
        context: PluginContext,
        config: Value,
    ) -> BoxFuture<'static, Result<Staged, String>> {
        let bundle = self.bundle.clone();
        Box::pin(async move {
            let identity = context.lifecycle.identity().map_err(error)?;
            let mut staged = Staged::default();
            if identity.scope == Scope::DesktopUi {
                staged
                    .insert(identity.entry_id, Client { bundle, config })
                    .map_err(error)?;
                return Ok(staged);
            }
            let host = context
                .host
                .ok_or("WorkHub Host capabilities unavailable")?;
            let repository = Arc::new(Repository::new(host.storage.clone()));
            let access = Arc::new(Access {
                repository: repository.clone(),
                executions: host.executions.clone(),
                authorizations: host.authorizations.clone(),
            });
            let coordinator = Arc::new(Coordinator {
                repository: repository.clone(),
                access: access.clone(),
                models: host.models.clone(),
                behavior: format!("{}.coordinator", identity.package_id)
                    .try_into()
                    .map_err(error)?,
                tools: session::tool_ceiling(),
            });
            let manager = Arc::new(Manager {
                assignments: Arc::new(Assignments {
                    repository,
                    access: access.clone(),
                    coordinator: coordinator.clone(),
                }),
                coordinator,
                access,
                queries: host.sessions,
                executor_choices: host.executors,
                executions: host.executions,
                wake: Notify::new(),
                recovering: AtomicBool::new(true),
                report: Mutex::default(),
            });
            remote::publish(
                &mut staged,
                manager.clone(),
                &identity.package_id,
                &bundle.content_digest,
            )?;
            session::publish(&mut staged, manager.clone())?;
            tools::publish(&mut staged, manager.clone())?;
            staged
                .insert(
                    "workhub",
                    manager.clone() as Arc<dyn maka_plugins::background::BackgroundWork>,
                )
                .map_err(error)?;
            let lifecycle = context.lifecycle.clone();
            context
                .lifecycle
                .spawn("recover WorkHub decisions", async move {
                    lifecycle.effective().await.map_err(error)?;
                    manager.recover().await;
                    Ok(())
                })
                .map_err(error)?;
            Ok(staged)
        })
    }
}

pub(super) struct Manager {
    pub(super) coordinator: Arc<Coordinator>,
    pub(super) assignments: Arc<Assignments>,
    pub(super) access: Arc<Access>,
    pub(super) queries: Arc<dyn maka_plugins::session::catalog::Queries>,
    executions: Arc<dyn maka_plugins::execution::Access>,
    executor_choices: Arc<dyn maka_plugins::executor::Executors>,
    wake: Notify,
    recovering: AtomicBool,
    report: Mutex<crate::recovery::Report>,
}
fn error(error: impl ToString) -> String {
    error.to_string()
}

impl Manager {
    async fn recover(&self) {
        let mut delay = Duration::from_millis(250);
        loop {
            // Subscribe before reading facts: changes are invalidations, never
            // a second source of truth. A timer also covers restored consent.
            let mut changes = if self
                .assignments
                .repository
                .pending()
                .await
                .is_ok_and(|pending| !pending.is_empty())
            {
                self.coordinator
                    .resolve()
                    .await
                    .ok()
                    .and_then(|(_, commands)| commands.changes().ok())
            } else {
                None
            };
            let retry = match self.recover_decisions().await {
                Ok(report) => {
                    let retry = report.retrying() || report.pending_results;
                    *self.report.lock().unwrap() = report;
                    retry
                }
                Err(error) => {
                    self.report.lock().unwrap().unavailable =
                        Some(error.to_string().chars().take(512).collect());
                    true
                }
            };
            self.recovering.store(retry, Ordering::Release);
            if retry {
                tokio::select! {
                    _ = self.wake.notified() => { delay = Duration::from_millis(250); }
                    _ = async { match &mut changes {
                        Some(changes) => {
                            if changes.changed().await.is_err() { std::future::pending::<()>().await; }
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                        None => std::future::pending().await,
                    }} => { delay = Duration::from_millis(250); }
                    _ = tokio::time::sleep(delay) => { delay = (delay * 2).min(Duration::from_secs(30)); }
                }
            } else {
                self.wake.notified().await;
                delay = Duration::from_millis(250);
            }
        }
    }
}
impl maka_plugins::background::BackgroundWork for Manager {
    fn is_pending(&self) -> bool {
        self.recovering.load(Ordering::Acquire)
    }
    fn wake(&self) {
        self.wake.notify_one();
    }
}
