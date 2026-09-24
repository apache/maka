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

use maka_plugins::{
    execution::{CreateChild, CreateRoot, Submit},
    storage::Mutation,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
#[serde(tag = "method", content = "input", deny_unknown_fields)]
pub(super) enum Request {
    #[serde(rename = "revision")]
    Revision(super::super::revision::Request),
    #[serde(rename = "inputs.names")]
    InputNames,
    #[serde(rename = "inputs.location")]
    InputLocation(Handle),
    #[serde(rename = "view.location")]
    ViewLocation(Handle),
    #[serde(rename = "inputs.read")]
    InputRead(Execution<maka_plugins::filesystem::ReadViewInput>),
    #[serde(rename = "inputs.list")]
    InputList(Execution<maka_plugins::filesystem::ListInput>),
    #[serde(rename = "view.read")]
    ViewRead(Execution<maka_plugins::filesystem::ReadViewInput>),
    #[serde(rename = "view.list")]
    ViewList(Execution<maka_plugins::filesystem::ListInput>),
    #[serde(rename = "inputs.openFile")]
    InputOpenFile(Execution<maka_plugins::filesystem::OpenFile>),
    #[serde(rename = "inputs.fileInfo")]
    InputFileInfo(Execution<maka_plugins::filesystem::OpenFile>),
    #[serde(rename = "view.fileInfo")]
    ViewFileInfo(Execution<maka_plugins::filesystem::OpenFile>),
    #[serde(rename = "view.openFile")]
    ViewOpenFile(Execution<maka_plugins::filesystem::OpenFile>),
    #[serde(rename = "pinnedFile.read")]
    PinnedFileRead(Execution<maka_plugins::filesystem::ReadRange>),
    #[serde(rename = "pinnedFile.close")]
    PinnedFileClose(Handle),
    #[serde(rename = "preferences.read")]
    Preferences,
    #[serde(rename = "remote.session")]
    SessionView(Authority),
    #[serde(rename = "remote.workspace")]
    WorkspaceView(WorkspaceView),
    #[serde(rename = "remote.queryDatabase")]
    QueryDatabase(DatabaseRead),
    #[serde(rename = "remote.authorize")]
    AuthorizeRemote(RemoteAuthorization),
    #[serde(rename = "authorization.open")]
    OpenAuthorization(Authorization),
    #[serde(rename = "authorization.close")]
    CloseAuthorization(Handle),
    #[serde(rename = "credentials.read")]
    CredentialRead(Key),
    #[serde(rename = "credentials.write")]
    CredentialWrite(maka_plugins::credentials::Write),
    #[serde(rename = "terminal.spawn")]
    TerminalSpawn(TerminalSpawn),
    #[serde(rename = "terminal.control")]
    TerminalControl(TerminalControl),
    #[serde(rename = "terminal.next")]
    TerminalNext(ProcessHandle),
    #[serde(rename = "terminal.wait")]
    TerminalWait(ProcessHandle),
    #[serde(rename = "terminal.close")]
    TerminalClose(Handle),
    #[serde(rename = "files.invoke")]
    Files(FileRequest),
    #[serde(rename = "sessions.list")]
    Sessions(SessionList),
    #[serde(rename = "history.list")]
    HistoryList(SessionList),
    #[serde(rename = "history.read")]
    HistoryRead(HistoryRead),
    #[serde(rename = "usage.activity")]
    UsageActivity(Authorized<maka_plugins::usage::Read>),
    #[serde(rename = "usage.summary")]
    UsageSummary(Authorized<String>),
    #[serde(rename = "pricing.query")]
    PricingQuery(maka_runtime::pricing::Query),
    #[serde(rename = "pricing.update")]
    PricingUpdate(Authorized<maka_runtime::pricing::Update>),
    #[serde(rename = "history.sources")]
    HistorySources(HistorySources),
    #[serde(rename = "history.copyMaterial")]
    HistoryCopyMaterial(HistoryTransfer<maka_plugins::session::history::CopyMaterial>),
    #[serde(rename = "history.copySession")]
    HistoryCopySession(HistoryTransfer<maka_plugins::session::history::CopySession>),
    #[serde(rename = "models.resolve")]
    ResolveModel(maka_plugins::llm::Selection),
    #[serde(rename = "models.search")]
    SearchModels(maka_plugins::llm::Search),
    #[serde(rename = "executors.search")]
    SearchExecutors(maka_plugins::executor::Search),
    #[serde(rename = "llm.generate")]
    Generate(ModelRequest),
    #[serde(rename = "clients.tools")]
    ClientCatalog(Authority),
    #[serde(rename = "clients.call")]
    ClientCall(ClientRequest),
    #[serde(rename = "clients.notify")]
    ClientNotify(NotificationRequest),
    #[serde(rename = "http.request")]
    HttpSend(HttpRequest),
    #[serde(rename = "permissions.request")]
    Permissions(PermissionRequest),
    #[serde(rename = "http.next")]
    HttpNext(ProcessHandle),
    #[serde(rename = "http.close")]
    HttpClose(Handle),
    #[serde(rename = "process.spawn")]
    ProcessSpawn(ProcessSpawn),
    #[serde(rename = "process.write")]
    ProcessWrite(ProcessWrite),
    #[serde(rename = "process.endInput")]
    ProcessEndInput(ProcessHandle),
    #[serde(rename = "process.next")]
    ProcessNext(ProcessHandle),
    #[serde(rename = "process.wait")]
    ProcessWait(ProcessHandle),
    #[serde(rename = "process.close")]
    ProcessClose(Handle),
    #[serde(rename = "executor.emit")]
    ExecutorEmit(ExecutorOutput),
    #[serde(rename = "model.io")]
    ModelIo(super::super::model::Operation),
    #[serde(rename = "contribution.publish")]
    Publish(Vec<super::super::registration::Registration>),
    #[serde(rename = "contribution.release")]
    Unpublish(Handle),
    #[serde(rename = "contribution.withdraw")]
    Withdraw(Withdraw),
    #[serde(rename = "storage.read")]
    Read(Key),
    #[serde(rename = "storage.scan")]
    Scan(maka_plugins::storage::Scan),
    #[serde(rename = "storage.batch")]
    Batch(Batch),
    #[serde(rename = "data")]
    Data(maka_plugins::filesystem::entries::Operation),
    #[serde(rename = "data.location")]
    DataLocation,
    #[serde(rename = "execution.offerInteraction")]
    OfferInteraction(Execution<maka_plugins::execution::OfferInteraction>),
    #[serde(rename = "execution.interaction")]
    Interaction(Execution<Operation>),
    #[serde(rename = "execution.waitInteraction")]
    WaitInteraction(Execution<Operation>),
    #[serde(rename = "execution.closeInteraction")]
    CloseInteraction(Execution<Operation>),
    #[serde(rename = "execution.copyAttachment")]
    CopyAttachment(Execution<CopyAttachment>),
    #[serde(rename = "execution.input")]
    ExecutionInput(Execution<maka_runtime::event::Invocation>),
    #[serde(rename = "execution.resume")]
    ResumeExecution(Execution<maka_plugins::execution::Resume>),
    #[serde(rename = "execution.configure")]
    ConfigureExecution(Execution<maka_plugins::execution::Configure>),
    #[serde(rename = "execution.removeSession")]
    RemoveSession(Execution<maka_plugins::execution::RemoveSession>),
    #[serde(rename = "execution.removalReceipt")]
    RemovalReceipt(Execution<SessionQuery>),
    #[serde(rename = "execution.previewRemoval")]
    PreviewRemoval(Execution<SessionQuery>),
    #[serde(rename = "execution.readMessage")]
    ReadMessage(Execution<maka_plugins::execution::SessionMessage>),
    #[serde(rename = "execution.enqueue")]
    Enqueue(Execution<maka_plugins::execution::Enqueue>),
    #[serde(rename = "execution.message")]
    Message(Execution<Operation>),
    #[serde(rename = "execution.retract")]
    Retract(Execution<Operation>),
    #[serde(rename = "execution.submit")]
    Submit(Execution<Submit>),
    #[serde(rename = "execution.capabilities")]
    ExecutionCapabilities(Execution<SessionQuery>),
    #[serde(rename = "execution.activity")]
    Activity(Execution<SessionQuery>),
    #[serde(rename = "execution.stop")]
    Stop(Execution<maka_runtime::event::Invocation>),
    #[serde(rename = "execution.session")]
    ExecutionSession(Execution<SessionQuery>),
    #[serde(rename = "execution.restoreChild")]
    RestoreChild(Execution<CreateChild>),
    #[serde(rename = "execution.createChild")]
    CreateChild(Execution<CreateChild>),
    #[serde(rename = "execution.createRoot")]
    CreateRoot(Execution<CreateRoot>),
    #[serde(rename = "execution.importSession")]
    ImportSession(Execution<maka_plugins::session::import::Command>),
    #[serde(rename = "execution.restoreRoot")]
    RestoreRoot(Execution<Operation>),
    #[serde(rename = "execution.abandonRevision")]
    AbandonRevision(Execution<Operation>),
    #[serde(rename = "execution.workspacePatch")]
    WorkspacePatch(Execution<Operation>),
    #[serde(rename = "execution.query")]
    Query(Execution<Operation>),
    #[serde(rename = "execution.cancel")]
    Cancel(Execution<Operation>),
    #[serde(rename = "execution.events")]
    Events(Execution<Events>),
    #[serde(rename = "execution.artifact")]
    Artifact(Execution<maka_plugins::execution::ReadArtifact>),
    #[serde(rename = "execution.event")]
    Event(Execution<Event>),
    #[serde(rename = "execution.restore")]
    RestoreExecution(Authorization),
    #[serde(rename = "execution.acquire")]
    AcquireExecution(Authority),
    #[serde(rename = "execution.close")]
    CloseExecution(Handle),
    #[serde(rename = "service.provide")]
    Provide(Provide),
    #[serde(rename = "service.get")]
    Get(Name),
    #[serde(rename = "service.call")]
    Call(Call),
    #[serde(rename = "service.release")]
    Release(Handle),
    #[serde(rename = "clock.sleep")]
    Sleep(Sleep),
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ProcessHandle {
    pub authority: String,
    pub handle: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Execution<T> {
    pub handle: String,
    pub input: T,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SessionQuery {
    pub session_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Authorization {
    pub id: maka_plugins::authorization::Id,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RemoteAuthorization {
    pub authority: String,
    pub request: maka_plugins::authorization::Request,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ProcessSpawn {
    pub authority: String,
    pub command: maka_plugins::process::Command,
}
#[derive(Deserialize)]
pub(super) struct TerminalSpawn {
    pub authority: String,
    #[serde(flatten)]
    pub input: maka_plugins::terminal::Spawn,
}
#[derive(Deserialize)]
pub(super) struct TerminalControl {
    pub authority: String,
    pub handle: String,
    #[serde(flatten)]
    pub input: maka_plugins::terminal::Control,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Authority {
    pub authority: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FileRequest {
    pub authority: String,
    pub operation: maka_plugins::filesystem::Operation,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HttpRequest {
    pub authority: String,
    #[serde(flatten)]
    pub request: maka_plugins::http::Request,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PermissionRequest {
    pub authority: String,
    pub request: maka_plugins::permissions::Request,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ModelRequest {
    pub authority: String,
    pub input: maka_plugins::llm::Generate,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ClientRequest {
    pub authority: String,
    pub call: maka_plugins::client_capability::Call,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct NotificationRequest {
    pub authority: String,
    pub input: maka_plugins::client_capability::Notification,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct WorkspaceView {
    pub authority: String,
    pub input: maka_plugins::remote::WorkspaceViewInput,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DatabaseRead {
    pub authority: String,
    pub input: maka_plugins::filesystem::database::Read,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ProcessWrite {
    #[serde(flatten)]
    pub target: ProcessHandle,
    pub bytes: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ExecutorOutput {
    pub handle: String,
    pub output: maka_runtime::executor::Output,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Withdraw {
    pub kind: super::super::registration::Kind,
    pub names: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Key {
    pub key: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Batch {
    pub mutations: Vec<Mutation>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Operation {
    pub operation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Events {
    pub operation_id: String,
    pub after: u64,
    pub through: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Event {
    pub operation_id: String,
    pub event_id: String,
    pub through: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Provide {
    pub name: String,
    pub callback: u32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Name {
    pub name: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Call {
    pub handle: String,
    pub input: Value,
    pub authority: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Handle {
    pub handle: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Sleep {
    pub milliseconds: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Code {
    Invalid,
    Revoked,
    Conflict,
    OutcomeUnknown,
    Unavailable,
    Busy,
    NotFound,
    LimitExceeded,
}
#[derive(Serialize)]
pub(super) struct Error {
    pub code: Code,
    pub message: String,
}
impl Error {
    pub fn tool(error: maka_runtime::tools::ToolError) -> Self {
        Self {
            code: match error {
                maka_runtime::tools::ToolError::Failed(_) => Code::Invalid,
                maka_runtime::tools::ToolError::Io { kind, .. } => match kind {
                    std::io::ErrorKind::PermissionDenied => Code::Revoked,
                    std::io::ErrorKind::NotFound => Code::NotFound,
                    std::io::ErrorKind::AlreadyExists => Code::Conflict,
                    _ => Code::Unavailable,
                },
                _ => Code::OutcomeUnknown,
            },
            message: error.to_string(),
        }
    }
    pub fn invalid(error: impl ToString) -> Self {
        Self {
            code: Code::Invalid,
            message: error.to_string(),
        }
    }
}
impl From<maka_plugins::filesystem::ReadError> for Error {
    fn from(error: maka_plugins::filesystem::ReadError) -> Self {
        use maka_plugins::filesystem::ReadError;
        let code = match &error {
            ReadError::Retired => Code::Revoked,
            ReadError::Invalid(_) => Code::Invalid,
            ReadError::Io(error) if error.kind() == std::io::ErrorKind::NotFound => Code::NotFound,
            ReadError::Io(_) | ReadError::ScanLimit { .. } => Code::Unavailable,
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}
impl From<maka_plugins::filesystem::database::Error> for Error {
    fn from(error: maka_plugins::filesystem::database::Error) -> Self {
        use maka_plugins::filesystem::database::Error as Database;
        let code = match &error {
            Database::Denied | Database::Cancelled => Code::Revoked,
            Database::Busy => Code::Busy,
            Database::NotFound => Code::NotFound,
            Database::Invalid(_) => Code::Invalid,
            Database::Limit(_) => Code::LimitExceeded,
            Database::Unavailable(_) => Code::Unavailable,
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}
impl From<maka_plugins::Error> for Error {
    fn from(error: maka_plugins::Error) -> Self {
        Self {
            code: if error == maka_plugins::Error::Retired {
                Code::Revoked
            } else {
                Code::Invalid
            },
            message: error.to_string(),
        }
    }
}
impl From<maka_plugins::remote::Error> for Error {
    fn from(error: maka_plugins::remote::Error) -> Self {
        use maka_plugins::remote::Error as Remote;
        Self {
            code: match error {
                Remote::Retired | Remote::Cancelled => Code::Revoked,
                Remote::Invalid(_) => Code::Invalid,
                Remote::Provider(_) => Code::Unavailable,
                Remote::OutcomeUnknown(_) | Remote::CleanupUnconfirmed => Code::OutcomeUnknown,
            },
            message: error.to_string(),
        }
    }
}
impl From<maka_plugins::storage::StoreError> for Error {
    fn from(error: maka_plugins::storage::StoreError) -> Self {
        use maka_plugins::storage::StoreError;
        let code = match &error {
            StoreError::Retired => Code::Revoked,
            StoreError::Conflict { .. } => Code::Conflict,
            StoreError::OutcomeUnknown(_) => Code::OutcomeUnknown,
            StoreError::Unavailable(_) => Code::Unavailable,
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}
impl From<maka_plugins::http::Error> for Error {
    fn from(error: maka_plugins::http::Error) -> Self {
        use maka_plugins::http::Error as Http;
        Self {
            code: match &error {
                Http::Denied => Code::Revoked,
                Http::Invalid(_) => Code::Invalid,
                Http::Failed(_) => Code::Unavailable,
                Http::CleanupUnconfirmed => Code::OutcomeUnknown,
            },
            message: error.to_string(),
        }
    }
}
impl From<maka_plugins::process::Error> for Error {
    fn from(error: maka_plugins::process::Error) -> Self {
        use maka_plugins::process::Error as Process;
        Self {
            code: match &error {
                Process::Denied => Code::Revoked,
                Process::Invalid(_) => Code::Invalid,
                Process::Failed(_) => Code::Unavailable,
                Process::CleanupUnconfirmed(_) => Code::OutcomeUnknown,
            },
            message: error.to_string(),
        }
    }
}
impl From<maka_plugins::filesystem::entries::Error> for Error {
    fn from(error: maka_plugins::filesystem::entries::Error) -> Self {
        use maka_plugins::filesystem::entries::Error as File;
        Self {
            code: match &error {
                File::Invalid(_) => Code::Invalid,
                File::NotFound => Code::NotFound,
                File::AlreadyExists => Code::Conflict,
                File::Retired | File::Cancelled => Code::Revoked,
                File::Io(_) => Code::Unavailable,
                File::OutcomeUnknown(_) => Code::OutcomeUnknown,
            },
            message: error.to_string(),
        }
    }
}
impl From<maka_plugins::execution::CommandError> for Error {
    fn from(error: maka_plugins::execution::CommandError) -> Self {
        use maka_plugins::execution::CommandError;
        let code = match &error {
            CommandError::Revoked | CommandError::Denied => Code::Revoked,
            CommandError::Conflict => Code::Conflict,
            CommandError::NotFound => Code::NotFound,
            CommandError::Busy => Code::Busy,
            CommandError::OutcomeUnknown(_) => Code::OutcomeUnknown,
            CommandError::Invalid(_) => Code::Invalid,
            CommandError::Draining | CommandError::Unavailable(_) | CommandError::Host(_) => {
                Code::Unavailable
            }
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SessionList {
    pub authority: String,
    pub input: maka_plugins::session::catalog::List,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HistoryRead {
    pub authority: String,
    pub input: maka_plugins::session::history::Read,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Authorized<T> {
    pub authority: String,
    pub input: T,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HistorySources {
    pub authority: String,
    pub input: maka_plugins::session::history::SourcesRead,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HistoryTransfer<T> {
    pub authority: String,
    pub target_handle: String,
    pub input: T,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CopyAttachment {
    pub source_handle: String,
    pub target_session_id: String,
    pub attachment: maka_runtime::attachment::AttachmentRef,
}
