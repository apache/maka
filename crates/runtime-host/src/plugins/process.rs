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

mod worker;

use crate::execution::Executions;
use futures_util::future::BoxFuture;
use maka_plugins::call::Scope as Authority;
use maka_plugins::fiber::Context;
use maka_plugins::process::{self as api, Chunk, Command, Exit, Lifetime};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
enum State {
    Starting,
    Running,
    Ended(Result<Exit, String>),
}
struct Handle {
    target: crate::execution::ResourceTarget,
    boundary: maka_plugins::authorization::Boundary,
    sandbox: maka_sandbox::Sandbox,
    input: mpsc::Sender<Option<Vec<u8>>>,
    output: tokio::sync::Mutex<mpsc::Receiver<Chunk>>,
    state: watch::Receiver<State>,
    stop: CancellationToken,
    expires: Option<CancellationToken>,
}
#[derive(Clone)]
pub(super) struct Processes(Arc<Inner>);
struct Inner {
    host: Weak<Executions>,
    owner: Context,
    private_data: PathBuf,
    handles: Mutex<BTreeMap<String, Arc<Handle>>>,
}
impl Processes {
    fn host(&self, authority: &Authority) -> Result<Arc<Executions>, api::Error> {
        let host = self.0.host.upgrade().ok_or(api::Error::Denied)?;
        if !host.plugin_calls.owns(authority) || authority.cancellation.is_cancelled() {
            return Err(api::Error::Denied);
        }
        Ok(host)
    }
    pub fn new(host: Weak<Executions>, owner: Context, private_data: PathBuf) -> Self {
        Self(Arc::new(Inner {
            host,
            owner,
            private_data,
            handles: Mutex::default(),
        }))
    }
    pub async fn spawn(&self, authority: Authority, input: Command) -> Result<String, api::Error> {
        let _lease = self.0.owner.admit().map_err(|_| api::Error::Denied)?;
        let host = self.host(&authority)?;
        let prepared = host
            .admit_plugin_process(&authority, &input, &self.0.private_data)
            .await
            .map_err(api::Error::from)?;
        let command = prepared.command;
        let admission = prepared.gate;
        let ticket = match input.lifetime {
            Lifetime::Invocation => Some(authority.resources.reserve().map_err(failed)?),
            Lifetime::Instance => None,
        };
        let (send, output) = mpsc::channel(8);
        let (stdin, receive) = mpsc::channel(8);
        let (state, snapshot) = watch::channel(State::Starting);
        let stop = CancellationToken::new();
        let unclaimed = stop.clone().drop_guard();
        let handle = Arc::new(Handle {
            boundary: prepared.boundary,
            sandbox: prepared.sandbox,
            target: host
                .plugin_resource_target(&authority)
                .map_err(api::Error::from)?,
            input: stdin,
            output: tokio::sync::Mutex::new(output),
            state: snapshot,
            stop: stop.clone(),
            expires: matches!(input.lifetime, Lifetime::Invocation)
                .then(|| authority.cancellation.clone()),
        });
        let id = uuid::Uuid::new_v4().to_string();
        {
            let mut handles = self.0.handles.lock().unwrap();
            if handles.len() >= 32 {
                return Err(api::Error::Invalid(
                    "plugin process handle capacity exceeded; close unused handles".into(),
                ));
            }
            if authority.cancellation.is_cancelled() {
                return Err(api::Error::Denied);
            }
            handles.insert(id.clone(), handle.clone());
        }
        let lifetime = input.lifetime;
        let activity = handle
            .target
            .session()
            .map(|id| host.own_plugin_process(id, stop.clone()));
        let session = handle.target.session().map(str::to_owned);
        let execution =
            self.0
                .owner
                .spawn_resource("protocol process", move |retiring| async move {
                    let mut activity = activity;
                    let mut ticket = ticket;
                    if let Some(ticket) = &mut ticket {
                        ticket.start();
                    }
                    let launch = authority.cancellation.clone();
                    let cancellation = match lifetime {
                        Lifetime::Invocation => authority.cancellation.clone(),
                        Lifetime::Instance => CancellationToken::new(),
                    };
                    let result = async {
                        if let Some(activity) = &mut activity {
                            activity.start().await.map_err(|error| error.to_string())?;
                        }
                        if let Some(session) = &session {
                            host.publish_session_change(session).await;
                        }
                        worker::run(
                            command,
                            receive,
                            send,
                            state,
                            worker::Stops {
                                launch,
                                explicit: stop,
                                retiring,
                                invocation: cancellation,
                            },
                            admission,
                        )
                        .await
                    }
                    .await;
                    let result = match activity {
                        Some(activity) => activity
                            .settle(result.is_ok())
                            .await
                            .map_err(|error| error.to_string())
                            .and(result),
                        None => result,
                    };
                    if result.is_err() {
                        host.begin_drain();
                    }
                    if let Some(ticket) = ticket {
                        ticket.complete(result.clone());
                    }
                    result
                });
        if let Err(error) = execution {
            self.0.handles.lock().unwrap().remove(&id);
            return Err(failed(error));
        }
        let mut state = handle.state.clone();
        loop {
            let current = state.borrow_and_update().clone();
            match current {
                State::Starting => state.changed().await.map_err(failed)?,
                State::Running | State::Ended(Ok(_)) => {
                    unclaimed.disarm();
                    return Ok(id);
                }
                State::Ended(Err(error)) => {
                    self.0.handles.lock().unwrap().remove(&id);
                    return Err(api::Error::Failed(error));
                }
            }
        }
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
        if handle.stop.is_cancelled()
            || handle
                .expires
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(api::Error::Denied);
        }
        if handle.target
            != self
                .host(authority)?
                .plugin_resource_target(authority)
                .map_err(api::Error::from)?
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
        if current != handle.boundary {
            return Err(api::Error::Denied);
        }
        if !host
            .plugin_process_sandbox(authority, &current, &self.0.private_data)
            .await
            .map_err(api::Error::from)?
            .contains(&handle.sandbox)
            .map_err(failed)?
        {
            return Err(api::Error::Denied);
        }
        Ok(handle)
    }
    pub async fn write(
        &self,
        authority: &Authority,
        id: &str,
        bytes: Vec<u8>,
    ) -> Result<(), api::Error> {
        if bytes.len() > 64 * 1024 {
            return Err(api::Error::Invalid("process input exceeds 64 KiB".into()));
        }
        self.send_input(authority, id, Some(bytes)).await
    }
    pub async fn end_input(&self, authority: &Authority, id: &str) -> Result<(), api::Error> {
        self.send_input(authority, id, None).await
    }
    async fn send_input(
        &self,
        authority: &Authority,
        id: &str,
        bytes: Option<Vec<u8>>,
    ) -> Result<(), api::Error> {
        let handle = self.get(authority, id).await?;
        // Wait for backpressure without holding global execution admission.
        let permit = tokio::select! {
            biased;
            _ = authority.cancellation.cancelled() => return Err(api::Error::Denied),
            _ = handle.stop.cancelled() => return Err(api::Error::Denied),
            permit = handle.input.reserve() => permit.map_err(failed)?,
        };
        let host = self.host(authority)?;
        let _gate = tokio::select! {
            biased;
            _ = authority.cancellation.cancelled() => return Err(api::Error::Denied),
            gate = host.lock_admission() => gate,
        };
        self.get(authority, id).await?;
        permit.send(bytes);
        Ok(())
    }
    pub async fn next(&self, authority: &Authority, id: &str) -> Result<Option<Chunk>, api::Error> {
        let handle = self.get(authority, id).await?;
        let mut output = handle
            .output
            .try_lock()
            .map_err(|_| api::Error::Invalid("process already has an output consumer".into()))?;
        tokio::select! {
            biased;
            _ = authority.cancellation.cancelled() => Err(api::Error::Denied),
            chunk = output.recv() => Ok(chunk),
        }
    }
    pub async fn wait(&self, authority: &Authority, id: &str) -> Result<Exit, api::Error> {
        let mut state = self.get(authority, id).await?.state.clone();
        loop {
            if let State::Ended(result) = state.borrow_and_update().clone() {
                return result.map_err(api::Error::Failed);
            }
            tokio::select! {
                biased;
                _ = authority.cancellation.cancelled() => return Err(api::Error::Denied),
                changed = state.changed() => changed.map_err(failed)?,
            }
        }
    }
    pub async fn close(&self, id: &str) -> Result<(), String> {
        let Some(handle) = self.0.handles.lock().unwrap().get(id).cloned() else {
            return Ok(());
        };
        handle.stop.cancel();
        let mut state = handle.state.clone();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let State::Ended(result) = state.borrow_and_update().clone() {
                    return result.map(|_| ());
                }
                state.changed().await.map_err(message)?;
            }
        })
        .await
        .map_err(|_| "process cleanup unconfirmed")??;
        self.0.handles.lock().unwrap().remove(id);
        Ok(())
    }
}
fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn failed(error: impl std::fmt::Display) -> api::Error {
    api::Error::Failed(error.to_string())
}

impl api::Processes for Processes {
    fn spawn(
        &self,
        call: Authority,
        command: Command,
    ) -> BoxFuture<'_, Result<api::Handle, api::Error>> {
        Box::pin(async move {
            self.host(&call).map_err(|_| api::Error::Denied)?;
            command.validate()?;
            let id = self.spawn(call.clone(), command).await?;
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
impl Processes {
    fn bind(&self, call: Authority, id: String) -> api::Handle {
        api::Handle {
            id: api::Id(id.clone()),
            io: Arc::new(Bound {
                processes: self.clone(),
                call,
                id,
            }),
        }
    }
}
struct Bound {
    processes: Processes,
    call: Authority,
    id: String,
}
impl api::Process for Bound {
    fn write(&self, bytes: Vec<u8>) -> BoxFuture<'_, Result<(), api::Error>> {
        Box::pin(async move { self.processes.write(&self.call, &self.id, bytes).await })
    }
    fn end_input(&self) -> BoxFuture<'_, Result<(), api::Error>> {
        Box::pin(async move { self.processes.end_input(&self.call, &self.id).await })
    }
    fn next(&self) -> BoxFuture<'_, Result<Option<Chunk>, api::Error>> {
        Box::pin(async move { self.processes.next(&self.call, &self.id).await })
    }
    fn wait(&self) -> BoxFuture<'_, Result<Exit, api::Error>> {
        Box::pin(async move { self.processes.wait(&self.call, &self.id).await })
    }
    fn close(&self) -> BoxFuture<'_, Result<(), api::Error>> {
        Box::pin(async move {
            self.processes
                .close(&self.id)
                .await
                .map_err(api::Error::CleanupUnconfirmed)
        })
    }
}
