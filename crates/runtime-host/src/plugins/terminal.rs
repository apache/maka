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

use crate::{
    execution::Executions,
    shell::{PtyReplay, PtyStream, PtyStreamEvent, ShellHandle},
};
use futures_util::future::BoxFuture;
use maka_plugins::call::Scope as Authority;
use maka_plugins::fiber::Context;
use maka_plugins::process::Lifetime;
use maka_plugins::terminal::{self as api, Control, Output, Spawn, Written};
use maka_runtime::shell_run::ShellOutcome;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

mod resource;

struct Cursor {
    initial: Option<PtyReplay>,
    stream: PtyStream,
}
struct Handle {
    session: String,
    expires: Option<CancellationToken>,
    stop: CancellationToken,
    shell: ShellHandle,
    cursor: tokio::sync::Mutex<Cursor>,
    _capacity: tokio::sync::OwnedSemaphorePermit,
}
#[derive(Clone)]
pub(super) struct Terminals(Arc<Inner>);
struct Inner {
    host: Weak<Executions>,
    owner: Context,
    private_data: std::path::PathBuf,
    handles: Mutex<BTreeMap<String, Arc<Handle>>>,
    capacity: Arc<tokio::sync::Semaphore>,
}
impl Terminals {
    fn host(&self, authority: &Authority) -> Result<Arc<Executions>, api::Error> {
        let host = self.0.host.upgrade().ok_or(api::Error::Denied)?;
        if !host.plugin_calls.owns(authority) || authority.cancellation.is_cancelled() {
            return Err(api::Error::Denied);
        }
        Ok(host)
    }
    pub fn new(host: Weak<Executions>, owner: Context, private_data: std::path::PathBuf) -> Self {
        Self(Arc::new(Inner {
            host,
            owner,
            private_data,
            handles: Mutex::default(),
            capacity: Arc::new(tokio::sync::Semaphore::new(8)),
        }))
    }
    pub async fn spawn(&self, authority: Authority, input: Spawn) -> Result<String, api::Error> {
        let lease = self.0.owner.admit().map_err(|_| api::Error::Denied)?;
        self.0.handles.lock().unwrap().retain(|_, handle| {
            !handle
                .expires
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
        });
        let capacity = self.0.capacity.clone().try_acquire_owned().map_err(|_| {
            api::Error::Invalid("plugin terminal capacity exceeded; close unused handles".into())
        })?;
        let host = self.host(&authority)?;
        let session = host
            .plugin_resource_target(&authority)
            .map_err(api::Error::from)?
            .session()
            .ok_or_else(|| api::Error::Invalid("a terminal requires a Session".into()))?
            .to_owned();
        let expires = matches!(input.command.lifetime, Lifetime::Invocation)
            .then(|| authority.cancellation.clone());
        let ticket = match input.command.lifetime {
            Lifetime::Invocation => Some(authority.resources.reserve().map_err(failed)?),
            Lifetime::Instance => None,
        };
        let stop = CancellationToken::new();
        let unclaimed = stop.clone().drop_guard();
        let terminal_id = uuid::Uuid::new_v4().to_string();
        let (send, receive) = tokio::sync::oneshot::channel();
        let worker_stop = stop.clone();
        let id = terminal_id.clone();
        let private_data = self.0.private_data.clone();
        self.0
            .owner
            .spawn_resource("terminal", move |retiring| async move {
                let _lease = lease;
                resource::Worker {
                    host,
                    authority,
                    input,
                    private_data,
                    id,
                    ticket,
                    stop: worker_stop,
                    retiring,
                    send,
                }
                .run()
                .await
            })
            .map_err(failed)?;
        let shell = receive
            .await
            .map_err(|_| api::Error::Failed("terminal worker disappeared".into()))??;
        let (initial, stream) = shell
            .attach()
            .ok_or_else(|| api::Error::Failed("terminal has no output".into()))?;
        let handle = Arc::new(Handle {
            session,
            expires,
            stop,
            shell,
            cursor: tokio::sync::Mutex::new(Cursor {
                initial: Some(initial),
                stream,
            }),
            _capacity: capacity,
        });
        self.0
            .handles
            .lock()
            .unwrap()
            .insert(terminal_id.clone(), handle.clone());
        if let Err(error) = handle.shell.clone().ready().await {
            self.0.handles.lock().unwrap().remove(&terminal_id);
            handle.stop.cancel();
            return Err(failed(error));
        }
        unclaimed.disarm();
        Ok(terminal_id)
    }
    fn handle(&self, authority: &Authority, id: &str) -> Result<Arc<Handle>, api::Error> {
        let _lease = self.0.owner.admit().map_err(|_| api::Error::Denied)?;
        if authority.cancellation.is_cancelled() {
            return Err(api::Error::Denied);
        }
        let handle = self
            .0
            .handles
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or(api::Error::Denied)?;
        if Some(handle.session.as_str())
            != self
                .host(authority)?
                .plugin_resource_target(authority)
                .map_err(api::Error::from)?
                .session()
            || handle
                .expires
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(api::Error::Denied);
        }
        Ok(handle)
    }
    async fn get(&self, authority: &Authority, id: &str) -> Result<Arc<Handle>, api::Error> {
        let handle = self.handle(authority, id)?;
        let host = self.host(authority)?;
        let current = host
            .plugin_process_boundary(authority)
            .await
            .map_err(api::Error::from)?;
        let record = handle.shell.clone().ready().await.map_err(failed)?;
        if !matches!(&current, maka_plugins::authorization::Boundary::Session { boundary, .. }
            if boundary.boundary_revision == record.permissions.boundary_revision)
        {
            return Err(api::Error::Denied);
        }
        if !host
            .plugin_process_sandbox(authority, &current, &self.0.private_data)
            .await
            .map_err(api::Error::from)?
            .contains(&record.permissions.sandbox)
            .map_err(failed)?
        {
            return Err(api::Error::Denied);
        }
        Ok(handle)
    }
    pub async fn control(
        &self,
        authority: &Authority,
        id: &str,
        input: Control,
    ) -> Result<Written, api::Error> {
        if input.text.len() > 64 * 1024 || (input.text.is_empty() && input.size.is_none()) {
            return Err(api::Error::Invalid(
                "terminal input is empty or exceeds 64 KiB".into(),
            ));
        }
        let host = self.host(authority)?;
        let gate = host.lock_admission().await;
        let handle = self.get(authority, id).await?;
        let receipt = handle
            .shell
            .enqueue_control(
                crate::shell::ControlInput::Raw(input.text),
                input.size,
                authority.cancellation.clone(),
            )
            .map_err(failed)?;
        drop(gate);
        let receipt = receipt.await.map_err(failed)?;
        Ok(Written {
            accepted_bytes: receipt.accepted_bytes,
            resized: receipt.resized,
        })
    }
    pub async fn next(&self, authority: &Authority, id: &str) -> Result<Output, api::Error> {
        let handle = self.get(authority, id).await?;
        let mut cursor = handle
            .cursor
            .try_lock()
            .map_err(|_| api::Error::Invalid("terminal already has an output consumer".into()))?;
        let event = if let Some(initial) = cursor.initial.take() {
            PtyStreamEvent::Reset(initial)
        } else {
            tokio::select! {
                biased;
                _ = authority.cancellation.cancelled() => return Err(api::Error::Denied),
                event = cursor.stream.next() => event,
            }
        };
        Ok(match event {
            PtyStreamEvent::Data(data) => Output::Data {
                sequence: data.sequence,
                text: data.data.clone(),
            },
            PtyStreamEvent::Reset(data) => Output::Reset {
                sequence: data.sequence,
                text: data.buffer,
                size: data.size,
            },
            PtyStreamEvent::Closed => Output::Closed,
        })
    }
    pub async fn wait(&self, authority: &Authority, id: &str) -> Result<ShellOutcome, api::Error> {
        let handle = self.get(authority, id).await?;
        let mut shell = handle.shell.clone();
        let record = tokio::select! {
            biased;
            _ = authority.cancellation.cancelled() => return Err(api::Error::Denied),
            record = shell.drained() => record.map_err(failed)?,
        };
        match &record.state {
            maka_runtime::shell_run::ShellState::Terminal { outcome, .. } => Ok(outcome.clone()),
            _ => Err(api::Error::CleanupUnconfirmed(
                "terminal worker exited without settlement".into(),
            )),
        }
    }
    pub async fn close(&self, id: &str) -> Result<(), String> {
        let Some(handle) = self.0.handles.lock().unwrap().remove(id) else {
            return Ok(());
        };
        handle.stop.cancel();
        tokio::time::timeout(Duration::from_secs(8), handle.shell.clone().drained())
            .await
            .map_err(|_| "terminal cleanup unconfirmed")?
            .map_err(message)?;
        Ok(())
    }
}
fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn failed(error: impl std::fmt::Display) -> api::Error {
    api::Error::Failed(error.to_string())
}

impl api::Terminals for Terminals {
    fn spawn(
        &self,
        call: Authority,
        input: Spawn,
    ) -> BoxFuture<'_, Result<api::Handle, api::Error>> {
        Box::pin(async move {
            self.host(&call).map_err(|_| api::Error::Denied)?;
            input.command.validate()?;
            let id = self.spawn(call.clone(), input).await?;
            Ok(self.bind(call, id))
        })
    }
    fn open(&self, call: Authority, id: api::Id) -> Result<api::Handle, api::Error> {
        self.host(&call).map_err(|_| api::Error::Denied)?;
        self.handle(&call, &id.0)?;
        Ok(self.bind(call, id.0))
    }
    fn close(&self, id: api::Id) -> BoxFuture<'_, Result<(), api::Error>> {
        Box::pin(async move {
            self.close(&id.0)
                .await
                .map_err(api::Error::CleanupUnconfirmed)
        })
    }
}
impl Terminals {
    fn bind(&self, call: Authority, id: String) -> api::Handle {
        api::Handle {
            id: api::Id(id.clone()),
            io: Arc::new(Bound {
                terminals: self.clone(),
                call,
                id,
            }),
        }
    }
}
struct Bound {
    terminals: Terminals,
    call: Authority,
    id: String,
}
impl api::Terminal for Bound {
    fn control(&self, input: Control) -> BoxFuture<'_, Result<Written, api::Error>> {
        Box::pin(async move { self.terminals.control(&self.call, &self.id, input).await })
    }
    fn next(&self) -> BoxFuture<'_, Result<Output, api::Error>> {
        Box::pin(async move { self.terminals.next(&self.call, &self.id).await })
    }
    fn wait(&self) -> BoxFuture<'_, Result<ShellOutcome, api::Error>> {
        Box::pin(async move { self.terminals.wait(&self.call, &self.id).await })
    }
    fn close(&self) -> BoxFuture<'_, Result<(), api::Error>> {
        Box::pin(async move {
            self.terminals
                .close(&self.id)
                .await
                .map_err(api::Error::CleanupUnconfirmed)
        })
    }
}
