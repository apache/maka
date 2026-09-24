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

mod service;
mod wire;

use futures_util::future::BoxFuture;
use maka_js_runtime::plugin::{Bridge, Error as VmError, Module, WeakModule};
use maka_plugins::{
    execution::Access, kernel::PluginContext, services::method::Handle, storage::Store,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use wire::{Error, Request};

struct State {
    inputs: maka_plugins::filesystem::ReadInputs,
    open_files: Mutex<BTreeMap<String, maka_plugins::filesystem::PinnedFile>>,
    preferences: Arc<dyn maka_plugins::preferences::Preferences>,
    source: Arc<super::remote::Source>,
    processes: Arc<dyn maka_plugins::process::Processes>,
    http: Arc<dyn maka_plugins::http::Client>,
    permissions: Arc<dyn maka_plugins::permissions::Access>,
    responses: Mutex<BTreeMap<String, HttpResponse>>,
    files: Arc<dyn maka_plugins::filesystem::Files>,
    models: Arc<dyn maka_plugins::llm::Models>,
    executors: Arc<dyn maka_plugins::executor::Executors>,
    clients: Arc<dyn maka_plugins::client_capability::Clients>,
    terminals: Arc<dyn maka_plugins::terminal::Terminals>,
    calls: Arc<super::invocation::Calls>,
    outputs: Arc<super::executor::Outputs>,
    model_calls: Arc<super::model::Calls>,
    registrations: Mutex<BTreeMap<String, maka_plugins::contributions::Registration>>,
    context: PluginContext,
    storage: Arc<dyn Store>,
    credentials: Arc<dyn maka_plugins::credentials::Credentials>,
    commands: Arc<dyn Access>,
    sessions: Arc<dyn maka_plugins::session::catalog::Queries>,
    history: Arc<dyn maka_plugins::session::history::History>,
    usage: Arc<dyn maka_plugins::usage::Usage>,
    pricing: Arc<dyn maka_plugins::pricing::Prices>,
    execution_handles: Mutex<BTreeMap<String, Arc<dyn maka_plugins::execution::Commands>>>,
    authorizations: Arc<dyn maka_plugins::authorization::Access>,
    authorized_calls:
        Mutex<BTreeMap<String, (maka_plugins::call::Owned, super::invocation::Guard)>>,
    module: OnceLock<WeakModule>,
    handles: Mutex<BTreeMap<String, Handle>>,
}
pub(super) struct HostBridge(Arc<State>);
struct HttpResponse {
    call: maka_plugins::call::Scope,
    body: Arc<dyn maka_plugins::http::Body>,
}
impl HostBridge {
    pub fn new(
        context: PluginContext,
        host: maka_plugins::host::Services,
        issuer: maka_plugins::call::Issuer,
        source: Arc<super::remote::Source>,
    ) -> Self {
        Self(Arc::new(State {
            inputs: host.inputs,
            open_files: Mutex::default(),
            preferences: host.preferences,
            source,
            http: host.http,
            permissions: host.permissions,
            responses: Default::default(),
            files: host.files,
            models: host.models,
            executors: host.executors,
            clients: host.clients,
            processes: host.processes,
            terminals: host.terminals,
            calls: Arc::new(super::invocation::Calls::new(issuer)),
            outputs: Arc::default(),
            model_calls: Arc::default(),
            registrations: Mutex::default(),
            context,
            storage: host.storage,
            credentials: host.credentials,
            commands: host.executions,
            sessions: host.sessions,
            history: host.history,
            usage: host.usage,
            pricing: host.pricing,
            execution_handles: Mutex::default(),
            authorizations: host.authorizations,
            authorized_calls: Mutex::default(),
            module: OnceLock::new(),
            handles: Mutex::default(),
        }))
    }
    pub fn bind(&self, module: &Module) {
        self.0
            .module
            .set(module.downgrade())
            .ok()
            .expect("module is bound once");
    }
    pub fn outputs(&self) -> &Arc<super::executor::Outputs> {
        &self.0.outputs
    }
    pub fn model_calls(&self) -> &Arc<super::model::Calls> {
        &self.0.model_calls
    }
    pub fn calls(&self) -> &Arc<super::invocation::Calls> {
        &self.0.calls
    }
}
impl Bridge for HostBridge {
    fn max_output_bytes(&self, method: &str) -> usize {
        match method {
            "model.io" => 32 * 1024 * 1024,
            "remote.queryDatabase" => maka_plugins::filesystem::database::MAX_BYTES + 1024,
            "storage.batch" => maka_plugins::storage::MAX_BATCH_WIRE_BYTES,
            "storage.read" => maka_plugins::storage::MAX_VALUE_BYTES + 1024,
            "storage.scan" => {
                maka_plugins::storage::MAX_PAGE_BYTES
                    + 64 * (2 * maka_plugins::storage::MAX_KEY_BYTES + 128)
                    + 1024
            }
            // A 1 MiB byte page expands to at most 4 MiB in a JSON array.
            "inputs.read" | "view.read" | "pinnedFile.read" => 5 * 1024 * 1024,
            _ => 1024 * 1024,
        }
    }
    fn max_input_bytes(&self, method: &str) -> usize {
        match method {
            // A byte can take four JSON bytes, plus bounded headers and URL.
            "http.request" => 5 * 1024 * 1024,
            "files.invoke" => 7 * 1024 * 1024,
            "execution.importSession" => 7 * 1024 * 1024,
            "storage.batch" => maka_plugins::storage::MAX_BATCH_WIRE_BYTES,
            "llm.generate" => 2 * 1024 * 1024,
            "model.io" => 32 * 1024 * 1024,
            _ => 1024 * 1024,
        }
    }
    fn call(&self, method: String, input: Value) -> BoxFuture<'static, Result<Value, VmError>> {
        let state = self.0.clone();
        Box::pin(async move {
            let request = serde_json::from_value(json!({ "method": method, "input": input }))
                .map_err(Error::invalid);
            let result = match request {
                Ok(request) => state.call(request).await,
                Err(error) => Err(error),
            };
            Ok(match result {
                Ok(value) => json!({"ok":true,"value":value}),
                Err(error) => json!({"ok":false,"error":error}),
            })
        })
    }
}
impl State {
    fn session_view(
        &self,
        authority: &str,
        view: maka_plugins::remote::SessionView,
    ) -> Result<Value, Error> {
        let files = self.calls.remote_read(authority, view.files)?;
        Ok(json!({"workspace": view.workspace, "tools": view.tools, "files": files}))
    }
    fn authorize(&self, owned: maka_plugins::call::Owned) -> Result<Value, Error> {
        let call = self.calls.forward(owned.scope()).map_err(Error::tool)?;
        let mut calls = self.authorized_calls.lock().unwrap();
        if calls.len() >= 32 {
            return Err(Error::invalid("too many open authorization scopes"));
        }
        let value = json!({"handle":call.id, "source":call.authority.identity});
        calls.insert(call.id.clone(), (owned, call));
        Ok(value)
    }
    fn execution<T>(
        &self,
        scoped: wire::Execution<T>,
    ) -> Result<(Arc<dyn maka_plugins::execution::Commands>, T), Error> {
        let commands = self
            .execution_handles
            .lock()
            .unwrap()
            .get(&scoped.handle)
            .cloned()
            .ok_or(maka_plugins::execution::CommandError::Revoked)?;
        Ok((commands, scoped.input))
    }
    fn execution_handle(
        &self,
        commands: Arc<dyn maka_plugins::execution::Commands>,
    ) -> Result<Value, Error> {
        let mut handles = self.execution_handles.lock().unwrap();
        if handles.len() >= 128 {
            return Err(Error::invalid(
                "execution view capacity exceeded; close unused views",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        handles.insert(id.clone(), commands);
        encode(id)
    }
    fn terminal(
        &self,
        input: wire::ProcessHandle,
    ) -> Result<maka_plugins::terminal::Handle, Error> {
        let call = self.calls.get(&input.authority)?;
        Ok(self
            .terminals
            .open(call, maka_plugins::terminal::Id(input.handle))?)
    }
    fn process(&self, input: wire::ProcessHandle) -> Result<maka_plugins::process::Handle, Error> {
        let call = self.calls.get(&input.authority)?;
        Ok(self
            .processes
            .open(call, maka_plugins::process::Id(input.handle))?)
    }
    fn data(&self) -> Result<&maka_plugins::storage::Directory, Error> {
        self.context.data.as_ref().ok_or_else(|| Error {
            code: wire::Code::Unavailable,
            message: "private files are unavailable in this scope".into(),
        })
    }
    fn opened_file(&self, file: maka_plugins::filesystem::PinnedFile) -> Result<Value, Error> {
        let mut files = self.open_files.lock().unwrap();
        files.retain(|_, file| !file.is_released());
        if files.len() >= 128 {
            return Err(Error::invalid(
                "open-file capacity exceeded; close unused files",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let value = json!({"handle":id, "info":file.info()});
        files.insert(id, file);
        Ok(value)
    }
    async fn call(&self, request: Request) -> Result<Value, Error> {
        // Initialization may access declared Services and data, not submit work.
        // Execution commands independently require effective business admission.
        let _lease = self.context.lifecycle.resource_call()?;
        match request {
            Request::InputNames => encode(self.inputs.names()?),
            Request::InputLocation(input) => encode(
                self.inputs
                    .open(&input.handle)?
                    .ok_or_else(|| Error::invalid("unknown input mount"))?
                    .location(),
            ),
            Request::ViewLocation(input) => encode(self.calls.read(&input.handle)?.location()),
            Request::InputRead(input) => {
                let view = self
                    .inputs
                    .open(&input.handle)?
                    .ok_or_else(|| Error::invalid("unknown input mount"))?;
                encode(view.read(input.input).await?)
            }
            Request::InputList(input) => {
                let view = self
                    .inputs
                    .open(&input.handle)?
                    .ok_or_else(|| Error::invalid("unknown input mount"))?;
                encode(view.list(input.input).await?)
            }
            Request::ViewRead(input) => {
                encode(self.calls.read(&input.handle)?.read(input.input).await?)
            }
            Request::ViewList(input) => {
                encode(self.calls.read(&input.handle)?.list(input.input).await?)
            }
            Request::InputOpenFile(input) => {
                let view = self
                    .inputs
                    .open(&input.handle)?
                    .ok_or_else(|| Error::invalid("unknown input mount"))?;
                self.opened_file(view.open_file(input.input).await?)
            }
            Request::InputFileInfo(input) => {
                let view = self
                    .inputs
                    .open(&input.handle)?
                    .ok_or_else(|| Error::invalid("unknown input mount"))?;
                encode(view.file_info(input.input).await?)
            }
            Request::ViewFileInfo(input) => encode(
                self.calls
                    .read(&input.handle)?
                    .file_info(input.input)
                    .await?,
            ),
            Request::ViewOpenFile(input) => self.opened_file(
                self.calls
                    .read(&input.handle)?
                    .open_file(input.input)
                    .await?,
            ),
            Request::PinnedFileRead(input) => {
                let file = self
                    .open_files
                    .lock()
                    .unwrap()
                    .get(&input.handle)
                    .cloned()
                    .ok_or(maka_plugins::Error::Retired)?;
                encode(file.read(input.input).await?)
            }
            Request::PinnedFileClose(input) => {
                let file = self.open_files.lock().unwrap().get(&input.handle).cloned();
                if let Some(file) = file {
                    file.close().await?;
                    self.open_files.lock().unwrap().remove(&input.handle);
                }
                Ok(Value::Null)
            }
            Request::Sessions(input) => {
                let call = self.calls.get(&input.authority)?;
                encode(self.sessions.list(call, input.input).await?)
            }
            Request::HistoryList(input) => {
                let call = self.calls.get(&input.authority)?;
                encode(self.history.list(call, input.input).await?)
            }
            Request::HistoryRead(input) => {
                let call = self.calls.get(&input.authority)?;
                encode(self.history.read(call, input.input).await?)
            }
            Request::HistorySources(input) => {
                let call = self.calls.get(&input.authority)?;
                encode(self.history.sources(call, input.input).await?)
            }
            Request::HistoryCopyMaterial(input) => {
                let call = self.calls.get(&input.authority)?;
                let target = self
                    .execution_handles
                    .lock()
                    .unwrap()
                    .get(&input.target_handle)
                    .cloned()
                    .ok_or_else(|| Error::invalid("execution capability is closed"))?;
                encode(
                    self.history
                        .copy_material(call, target, input.input)
                        .await?,
                )
            }
            Request::ResolveModel(input) => encode(self.models.resolve(input).await?),
            Request::HistoryCopySession(input) => {
                let call = self.calls.get(&input.authority)?;
                let target = self
                    .execution_handles
                    .lock()
                    .unwrap()
                    .get(&input.target_handle)
                    .cloned()
                    .ok_or_else(|| Error::invalid("execution capability is closed"))?;
                encode(self.history.copy_session(call, target, input.input).await?)
            }
            Request::SearchModels(input) => encode(self.models.search(input).await?),
            Request::UsageActivity(input) => {
                let call = self.calls.get(&input.authority)?;
                encode(self.usage.activity(call, input.input).await?)
            }
            Request::UsageSummary(input) => {
                let call = self.calls.get(&input.authority)?;
                encode(self.usage.summary(call, input.input).await?)
            }
            Request::PricingQuery(input) => encode(self.pricing.query(input).await?),
            Request::PricingUpdate(input) => {
                let call = self.calls.get(&input.authority)?;
                encode(
                    self.pricing
                        .update(call, input.input)
                        .await
                        .map_err(Error::tool)?,
                )
            }
            Request::SearchExecutors(input) => encode(self.executors.search(input).await?),
            Request::Revision(input) => {
                let _lease = self.context.lifecycle.resource_call()?;
                Ok(self.calls.revisions.call(input).await?)
            }
            Request::Preferences => encode(self.preferences.read().await?),
            Request::OpenAuthorization(input) => {
                let authorized = self.authorizations.open(input.id).await?;
                let mut output = self.authorize(authorized.call)?;
                output["grant"] = serde_json::to_value(authorized.grant).map_err(Error::invalid)?;
                output["boundary"] =
                    serde_json::to_value(authorized.boundary).map_err(Error::invalid)?;
                Ok(output)
            }
            Request::AuthorizeRemote(input) => {
                let caller = self.calls.remote(&input.authority)?;
                self.authorize(
                    caller
                        .views
                        .authorize(input.request)
                        .await
                        .map_err(|error| Error::invalid(error.to_string()))?,
                )
            }
            Request::CloseAuthorization(input) => {
                let call = self.authorized_calls.lock().unwrap().remove(&input.handle);
                if let Some((owned, _guard)) = call {
                    owned.finish().await.map_err(Error::tool)?;
                }
                Ok(Value::Null)
            }
            Request::SessionView(input) => {
                let caller = self.calls.remote(&input.authority)?;
                self.session_view(&input.authority, caller.views.session().await?)
            }
            Request::WorkspaceView(input) => {
                let caller = self.calls.remote(&input.authority)?;
                self.session_view(&input.authority, caller.views.workspace(input.input).await?)
            }
            Request::QueryDatabase(input) => {
                let caller = self.calls.remote(&input.authority)?;
                encode(caller.views.query_database(input.input).await?)
            }
            Request::CredentialRead(input) => encode(self.credentials.read(input.key).await?),
            Request::CredentialWrite(input) => encode(self.credentials.write(input).await?),
            Request::TerminalSpawn(input) => {
                let authority = self.calls.get(&input.authority)?;
                encode(self.terminals.spawn(authority, input.input).await?.id)
            }
            Request::TerminalControl(input) => encode(
                self.terminal(wire::ProcessHandle {
                    authority: input.authority,
                    handle: input.handle,
                })?
                .io
                .control(input.input)
                .await?,
            ),
            Request::TerminalNext(input) => encode(self.terminal(input)?.io.next().await?),
            Request::TerminalWait(input) => encode(self.terminal(input)?.io.wait().await?),
            Request::TerminalClose(input) => {
                self.terminals
                    .close(maka_plugins::terminal::Id(input.handle))
                    .await?;
                Ok(Value::Null)
            }
            Request::Files(input) => {
                let authority = self.calls.get(&input.authority)?;
                self.files
                    .invoke(authority, input.operation)
                    .await
                    .map(maka_plugins::filesystem::Output::into_json)
                    .map_err(Error::tool)
            }
            Request::Generate(input) => {
                let authority = self.calls.get(&input.authority)?;
                encode(
                    self.models
                        .generate(authority, input.input)
                        .await
                        .map_err(Error::tool)?,
                )
            }
            Request::ClientCatalog(input) => {
                let authority = self.calls.get(&input.authority)?;
                encode(self.clients.tools(authority).await.map_err(Error::tool)?)
            }
            Request::ClientNotify(input) => {
                let authority = self.calls.get(&input.authority)?;
                self.clients
                    .notify(authority, input.input)
                    .await
                    .map_err(Error::tool)?;
                Ok(Value::Null)
            }
            Request::ClientCall(input) => {
                let authority = self.calls.get(&input.authority)?;
                self.clients
                    .call(authority, input.call)
                    .await
                    .map_err(Error::tool)
            }
            Request::Permissions(input) => {
                let authority = self.calls.get(&input.authority)?;
                encode(
                    self.permissions
                        .request(authority, input.request)
                        .await
                        .map_err(Error::tool)?,
                )
            }
            Request::HttpSend(input) => {
                let authority = self.calls.get(&input.authority)?;
                self.responses
                    .lock()
                    .unwrap()
                    .retain(|_, response| !response.call.cancellation.is_cancelled());
                let response = self.http.request(authority.clone(), input.request).await?;
                let id = uuid::Uuid::new_v4().to_string();
                self.responses.lock().unwrap().insert(
                    id.clone(),
                    HttpResponse {
                        call: authority,
                        body: response.body,
                    },
                );
                Ok(
                    json!({"handle":id, "status":response.head.status, "url":response.head.url, "headers":response.head.headers}),
                )
            }
            Request::HttpNext(input) => {
                let authority = self.calls.get(&input.authority)?;
                let body = {
                    let responses = self.responses.lock().unwrap();
                    let response = responses
                        .get(&input.handle)
                        .ok_or_else(|| Error::from(maka_plugins::http::Error::Denied))?;
                    if response.call.identity != authority.identity {
                        return Err(maka_plugins::http::Error::Denied.into());
                    }
                    response.body.clone()
                };
                encode(body.next().await?)
            }
            Request::HttpClose(input) => {
                let response = self.responses.lock().unwrap().remove(&input.handle);
                if let Some(response) = response {
                    response.body.close().await?;
                }
                Ok(Value::Null)
            }
            Request::ProcessSpawn(input) => {
                let authority = self.calls.get(&input.authority)?;
                encode(self.processes.spawn(authority, input.command).await?.id)
            }
            Request::ProcessWrite(input) => {
                self.process(input.target)?.io.write(input.bytes).await?;
                Ok(Value::Null)
            }
            Request::ProcessEndInput(input) => {
                self.process(input)?.io.end_input().await?;
                Ok(Value::Null)
            }
            Request::ProcessNext(input) => encode(self.process(input)?.io.next().await?),
            Request::ProcessWait(input) => encode(self.process(input)?.io.wait().await?),
            Request::ProcessClose(input) => {
                self.processes
                    .close(maka_plugins::process::Id(input.handle))
                    .await?;
                Ok(Value::Null)
            }
            Request::ExecutorEmit(input) => {
                self.outputs
                    .emit(&input.handle, input.output)
                    .await
                    .map_err(|error| Error {
                        code: wire::Code::Unavailable,
                        message: error.to_string(),
                    })?;
                Ok(Value::Null)
            }
            Request::ModelIo(input) => Ok(match self.model_calls.execute(input).await {
                Ok(value) => json!({"value":value}),
                Err(error) => json!({"error":error}),
            }),
            Request::Publish(registrations) => {
                let module = self
                    .module
                    .get()
                    .and_then(WeakModule::upgrade)
                    .ok_or(maka_plugins::Error::Retired)?;
                let staged = super::registration::stage_entries(
                    registrations,
                    &module,
                    &self.outputs,
                    &self.model_calls,
                    &self.calls,
                    &self.source,
                    &self.context.lifecycle,
                )
                .map_err(Error::invalid)?;
                let mut registrations = self.registrations.lock().unwrap();
                if registrations.len() >= 128 {
                    return Err(Error::invalid("dynamic registration capacity exceeded"));
                }
                let registration = self.context.contributions.publish(staged)?;
                let id = uuid::Uuid::new_v4().to_string();
                registrations.insert(id.clone(), registration);
                Ok(json!(id))
            }
            Request::Unpublish(input) => {
                self.registrations.lock().unwrap().remove(&input.handle);
                Ok(Value::Null)
            }
            Request::Withdraw(input) => {
                super::registration::withdraw(
                    &self.context.contributions,
                    &self.context.lifecycle,
                    input.kind,
                    &input.names,
                )?;
                Ok(Value::Null)
            }
            Request::Read(input) => encode(self.storage.read(input.key).await?),
            Request::Scan(input) => encode(self.storage.scan(input).await?),
            Request::Batch(input) => encode(self.storage.batch(input.mutations).await?),
            Request::DataLocation => encode(self.data()?.read_only().await?.location()),
            Request::Data(operation) => encode(
                self.data()?
                    .run(move |root, cancellation| {
                        maka_plugins::filesystem::entries::execute(
                            root,
                            operation,
                            cancellation,
                            None,
                        )
                    })
                    .await??,
            ),
            Request::RestoreExecution(input) => {
                let commands = self.commands.restore(input.id).await?;
                self.execution_handle(commands)
            }
            Request::AcquireExecution(input) => {
                let call = self.calls.get(&input.authority)?;
                self.execution_handle(self.commands.acquire(call).await?)
            }
            Request::CloseExecution(input) => {
                self.execution_handles.lock().unwrap().remove(&input.handle);
                Ok(Value::Null)
            }
            Request::OfferInteraction(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.offer_interaction(input).await?)
            }
            Request::Interaction(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.interaction(input.operation_id).await?)
            }
            Request::WaitInteraction(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.wait_interaction(input.operation_id).await?)
            }
            Request::CloseInteraction(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.close_interaction(input.operation_id).await?)
            }
            Request::CopyAttachment(input) => {
                let (commands, input) = self.execution(input)?;
                let source = self
                    .execution_handles
                    .lock()
                    .unwrap()
                    .get(&input.source_handle)
                    .cloned()
                    .ok_or_else(|| Error::invalid("execution capability is closed"))?;
                encode(
                    commands
                        .copy_attachment(
                            source,
                            maka_plugins::execution::CopyAttachment {
                                target_session_id: input.target_session_id,
                                attachment: input.attachment,
                            },
                        )
                        .await?,
                )
            }
            Request::ExecutionInput(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.input(input).await?)
            }
            Request::ResumeExecution(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.resume(input).await?)
            }
            Request::ConfigureExecution(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.configure(input).await?)
            }
            Request::RemoveSession(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.remove_session(input).await?)
            }
            Request::RemovalReceipt(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.removal_receipt(input.session_id).await?)
            }
            Request::PreviewRemoval(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.preview_removal(input.session_id).await?)
            }
            Request::ReadMessage(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.read_message(input).await?)
            }
            Request::Enqueue(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.enqueue(input).await?)
            }
            Request::Message(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.message(input.operation_id).await?)
            }
            Request::Retract(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.retract(input.operation_id).await?)
            }
            Request::Submit(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.submit(input).await?)
            }
            Request::ExecutionCapabilities(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.capabilities(input.session_id).await?)
            }
            Request::Activity(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.activity(input.session_id).await?)
            }
            Request::Stop(input) => {
                let (commands, input) = self.execution(input)?;
                commands.stop(input).await?;
                Ok(Value::Null)
            }
            Request::ExecutionSession(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.session(input.session_id).await?)
            }
            Request::RestoreChild(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.restore_child(input).await?)
            }
            Request::CreateChild(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.create_child(input).await?)
            }
            Request::CreateRoot(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.create_root(input).await?)
            }
            Request::ImportSession(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.import_session(input).await?)
            }
            Request::RestoreRoot(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.restore_root(input.operation_id).await?)
            }
            Request::AbandonRevision(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.abandon_revision(input.operation_id).await?)
            }
            Request::WorkspacePatch(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.workspace_patch(input.operation_id).await?)
            }
            Request::Query(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.query(input.operation_id).await?)
            }
            Request::Cancel(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.cancel(input.operation_id).await?)
            }
            Request::Events(input) => {
                let (commands, input) = self.execution(input)?;
                encode(
                    commands
                        .events(input.operation_id, input.after, input.through)
                        .await?,
                )
            }
            Request::Artifact(input) => {
                let (commands, input) = self.execution(input)?;
                encode(commands.artifact(input).await?)
            }
            Request::Event(input) => {
                let (commands, input) = self.execution(input)?;
                encode(
                    commands
                        .event(input.operation_id, input.event_id, input.through)
                        .await?,
                )
            }
            Request::Provide(input) => {
                if input.callback == 0 {
                    return Err(Error::invalid("invalid service callback"));
                }
                let module = self
                    .module
                    .get()
                    .and_then(WeakModule::upgrade)
                    .ok_or(maka_plugins::Error::Retired)?;
                let callback = Arc::new(super::callbacks::Callback {
                    module,
                    id: input.callback,
                    calls: self.calls.clone(),
                });
                let mut registrations = self.registrations.lock().unwrap();
                if registrations.len() >= 128 {
                    return Err(Error::invalid("dynamic registration capacity exceeded"));
                }
                let registration = self
                    .context
                    .services
                    .register_method(&input.name, Arc::new(service::JavaScript { callback }))?;
                let id = uuid::Uuid::new_v4().to_string();
                registrations.insert(id.clone(), registration);
                Ok(json!(id))
            }
            Request::Get(input) => {
                let Some(service) = self.context.services.method(&input.name)? else {
                    return Ok(Value::Null);
                };
                let mut handles = self.handles.lock().unwrap();
                if handles.len() >= 128 {
                    return Err(Error::invalid("service handle limit exceeded"));
                }
                let id = uuid::Uuid::new_v4().to_string();
                handles.insert(id.clone(), service);
                Ok(json!(id))
            }
            Request::Call(input) => self.call_service(input).await,
            Request::Release(input) => {
                self.handles.lock().unwrap().remove(&input.handle);
                Ok(Value::Null)
            }
            Request::Sleep(input) => {
                if input.milliseconds > 86_400_000 {
                    return Err(Error::invalid("sleep exceeds one day"));
                }
                let stopping = self.context.lifecycle.stopping()?;
                tokio::select! {
                    biased;
                    _ = stopping.cancelled() => Err(maka_plugins::Error::Retired.into()),
                    _ = tokio::time::sleep(Duration::from_millis(input.milliseconds)) => Ok(Value::Null),
                }
            }
        }
    }
}
fn encode(value: impl Serialize) -> Result<Value, Error> {
    serde_json::to_value(value).map_err(Error::invalid)
}
