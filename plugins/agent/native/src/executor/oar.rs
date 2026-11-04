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

use super::*;
use futures_util::{FutureExt, future::Shared};
use maka_agent_ports::executor::{Outcome, Request};
use maka_capabilities::storage::Store;
use maka_host_runtime::storage::Storage;
use std::path::PathBuf;
use std::time::{Duration, Instant};

mod attachments;
mod history;
mod journal;
mod projection;
mod worker;

struct CatalogSnapshot {
    cwd: String,
    started: Instant,
    result: Shared<BoxFuture<'static, Result<Value, Error>>>,
}

pub(super) struct Oar {
    executable: PathBuf,
    args: Vec<String>,
    storage: Storage,
    queries: Arc<maka_capabilities::call::Resources>,
    catalog: tokio::sync::Mutex<Option<CatalogSnapshot>>,
    stop: CancellationToken,
    root: Arc<RootStore>,
    package: String,
    activation: String,
    pub basis: String,
}
impl Oar {
    pub fn capture(
        context: &NativeContext,
        configuration: &maka_agent_api::executor::OarConfiguration,
    ) -> Result<Arc<Self>, String> {
        let persistence = context.persistence().ok_or("OAR requires persistence")?;
        let executable = match &configuration.executable {
            Some(path) => PathBuf::from(path),
            None => std::env::current_exe()
                .map_err(|e| e.to_string())?
                .with_file_name(if cfg!(windows) {
                    "maka-oar-worker.exe"
                } else {
                    "maka-oar-worker"
                }),
        };
        if !executable.is_absolute() {
            return Err("OAR worker requires an absolute executable".into());
        }
        let prefix = hex::encode(Sha256::digest(
            serde_json::to_vec(&(
                persistence.source().deployment,
                context.activation().instance(),
            ))
            .map_err(|e| e.to_string())?,
        ));
        let storage = Storage::new(
            persistence.store().clone(),
            format!("{prefix}/"),
            maka_capabilities::storage::Namespace::new(
                "maka.agent.oar",
                maka_plugin_core::scope::Scope::Profile,
            )
            .map_err(|e| e.to_string())?,
        );
        let basis = hex::encode(Sha256::digest(
            serde_json::to_vec(&(
                context.activation().epoch(),
                &executable,
                &configuration.args,
                storage.execution_basis(),
            ))
            .map_err(|e| e.to_string())?,
        ));
        Ok(Arc::new(Self {
            executable,
            args: configuration.args.clone(),
            storage,
            queries: Arc::default(),
            catalog: tokio::sync::Mutex::new(None),
            stop: CancellationToken::new(),
            root: persistence.store().clone(),
            package: context.package().id.clone(),
            activation: context.activation().epoch().to_string(),
            basis,
        }))
    }
    pub fn admit(self: &Arc<Self>, request: Request) -> Result<Admitted, Error> {
        if request.settings.runtime.is_none() {
            return Err(Error::Invalid("OAR requires a runtime selection".into()));
        }
        Ok(Admitted {
            identity: maka_agent_facts::executor::Binding {
                executor_id: "oar".to_owned().try_into().expect("OAR identity"),
                package_id: self.package.clone(),
                entry_id: "oar".into(),
                activation: self.activation.clone(),
            },
            execution: Box::new(Call {
                owner: self.clone(),
                request,
            }),
        })
    }
    pub async fn query(
        self: &Arc<Self>,
        cwd: String,
        request: Value,
        cancellation: CancellationToken,
    ) -> Result<Value, Error> {
        if cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if request.get("kind").and_then(Value::as_str) == Some("catalog")
            && request.get("runtime").is_none()
        {
            // One bounded discovery result is shared across filtering and pagination.
            let discovery = {
                let mut cached = self.catalog.lock().await;
                if let Some(entry) = cached.as_ref().filter(|entry| {
                    entry.cwd == cwd
                        && (entry.result.peek().is_none()
                            || (entry.started.elapsed() < Duration::from_secs(30)
                                && matches!(entry.result.peek(), Some(Ok(_)))))
                }) {
                    entry.result.clone()
                } else {
                    let owner = self.clone();
                    let work_cwd = cwd.clone();
                    let discovery = async move {
                        owner
                            .query_worker(work_cwd, request, owner.stop.child_token())
                            .await
                    }
                    .boxed()
                    .shared();
                    let retained = discovery.clone();
                    tokio::spawn(async move {
                        let _ = retained.await;
                    });
                    *cached = Some(CatalogSnapshot {
                        cwd,
                        started: Instant::now(),
                        result: discovery.clone(),
                    });
                    discovery
                }
            };
            return tokio::select! {
                biased;
                () = cancellation.cancelled() => Err(Error::Cancelled),
                () = self.stop.cancelled() => Err(Error::Retired),
                result = discovery => result,
            };
        }
        let installs = request.get("kind").and_then(Value::as_str) == Some("setup")
            && request.get("action").and_then(Value::as_str) == Some("install");
        let result = self.query_worker(cwd, request, cancellation).await;
        if installs {
            self.catalog.lock().await.take();
        }
        result
    }

    async fn query_worker(
        self: &Arc<Self>,
        cwd: String,
        request: Value,
        cancellation: CancellationToken,
    ) -> Result<Value, Error> {
        if cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let mut ticket = self.queries.reserve().map_err(|_| Error::Retired)?;
        let owner = self.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            ticket.start();
            let stopped = cancellation.child_token();
            let work = worker::query(
                &owner.executable,
                &owner.args,
                &cwd,
                request,
                stopped.clone(),
            );
            tokio::pin!(work);
            let result = tokio::select! {
                result = &mut work => result,
                () = owner.stop.cancelled() => { stopped.cancel(); work.await },
            };
            ticket.complete(if matches!(&result, Err(Error::CleanupUnconfirmed)) {
                Err("OAR query cleanup is unconfirmed".into())
            } else {
                Ok(())
            });
            let _ = send.send(result);
        });
        receive.await.map_err(|_| Error::CleanupUnconfirmed)?
    }
    pub async fn finish(&self) -> Result<(), String> {
        self.stop.cancel();
        let queries = self
            .queries
            .finish()
            .await
            .map_err(|error| error.to_string());
        let storage = self.storage.finish().await;
        queries?;
        storage
    }
}
struct Call {
    owner: Arc<Oar>,
    request: Request,
}
impl executor::Execution for Call {
    fn execute(
        self: Box<Self>,
        execution: Arc<dyn maka_agent_facts::tools::ExecutionCustody>,
        output: Arc<dyn OutputSink>,
        cancellation: CancellationToken,
    ) -> BoxFuture<'static, Settlement> {
        Box::pin(async move {
            let result = self.run(execution, output, cancellation).await;
            Settlement::new(result, self.owner)
        })
    }
}
impl Call {
    async fn run(
        &self,
        execution: Arc<dyn maka_agent_facts::tools::ExecutionCustody>,
        output: Arc<dyn OutputSink>,
        cancellation: CancellationToken,
    ) -> Result<Outcome, Error> {
        if cancellation.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let store = self
            .owner
            .root
            .session_for_execution(execution.as_ref(), &self.request.invocation)
            .map_err(|e| Error::Persistence(e.to_string()))?;
        let mut materials = attachments::prepare(&store, &self.request, &cancellation).await?;
        let mut journal = journal::Journal::load(&self.owner.storage, &self.request).await?;
        if let Some(mut context) =
            history::context(&store, &self.request, journal.last_delivered_run()).await?
        {
            context.push_str("\n\n--- Current user message ---\n");
            context.push_str(&materials.message);
            materials.message = context;
        }
        if cancellation.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let lease = self
            .owner
            .root
            .fork_execution(execution.as_ref(), &self.request.invocation)
            .map_err(|e| Error::Persistence(e.to_string()))?;
        if let Err(error) = journal
            .start(&self.owner.storage, &self.request.invocation.invocation_id)
            .await
        {
            lease.finish();
            return Err(error);
        }
        let request = serde_json::json!({
            "kind":"execute", "runtime":self.request.settings.runtime, "cwd":self.request.cwd,
            "message":materials.message,
            "images":materials.images,
        });
        let mut request = request.as_object().expect("worker request").clone();
        for (key, value) in [
            ("model", self.request.settings.model.as_deref()),
            (
                "effort",
                self.request
                    .settings
                    .thinking_level
                    .as_ref()
                    .map(|e| e.as_str()),
            ),
            ("instructions", self.request.instructions.as_deref()),
            ("resume", journal.native_session()),
        ] {
            if let Some(value) = value {
                request.insert(key.into(), value.into());
            }
        }
        // From this point cancellation/drop must not remove paths that the native
        // agent may still be reading. Only confirmed worker settlement releases them.
        let directory = materials.handoff();
        let result = worker::execute(
            &self.owner.executable,
            &self.owner.args,
            &self.request.cwd,
            request.into(),
            &self.owner.storage,
            &mut journal,
            output,
            cancellation,
        )
        .await;
        if !matches!(result, Err(Error::CleanupUnconfirmed)) {
            lease.finish();
            if let Some(directory) = directory {
                tokio::fs::remove_dir_all(directory)
                    .await
                    .map_err(|e| Error::Provider(format!("OAR attachment cleanup failed: {e}")))?;
            }
        }
        if matches!(&result, Ok(Outcome::Completed { .. })) {
            journal
                .delivered(&self.owner.storage, &self.request.invocation.run_id)
                .await?;
        }
        result
    }
}
