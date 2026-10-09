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

//! The workspace a window works in: its Runtime Host connection, the project
//! new sessions go into, and the window-wide command Actions.
//!
//! - [`HostSession`] owns one supervised Host connection. It runs the
//!   `host-client` supervisor on the background executor, moves its events to
//!   the foreground, keeps an observable [`ConnectionStatus`], re-emits push
//!   frames as [`HostSessionEvent`]s, and hands out a [`HostRequester`] for
//!   typed requests.
//! - [`ProjectSelection`] lists the Host's projects, changes them
//!   (`project.catalog.mutate`), and tracks the one new tasks go into.
//! - [`ConnectionCatalog`] keeps the Host's model connections and their
//!   enabled models, which the model picker and the connection settings read.
//! - [`StateRootStore`] remembers which State Root the app opens;
//!   [`check_state_root_choice`] keeps Maka Desktop's data out of it.
//! - [`HostDirectory`] keeps the Runtime Hosts a window can talk to (the
//!   local one and the saved remote ones, the default, the enabled ones)
//!   and adds one by pairing; a [`HostSession`] talks to one of them
//!   ([`WindowHost`]), with the [`HostAccess`] its credential gives.

pub mod actions;
mod config_file;
mod connections;
mod host_session;
mod hosts;
mod projects;
mod requester;
mod state_root;

pub use config_file::{client_config_file, read_config_file, write_config_file};
pub use connections::{
    ConnectionCatalog, ConnectionCatalogStatus, ConnectionEntry, ConnectionList, ConnectionModel,
    read_connections,
};
pub use host_client::{
    EpochMismatch, HostBlocker, HostSelection, LOCAL_PROFILE_ID, MissingCheckout, RemoteHostEntry,
    RemoteHostProfile, RemoteProfileStore, SshFailure, configured_maka_checkout,
};
pub use host_session::{
    ConnectionStatus, HostSession, HostSessionEvent, RemoteHost, RetryState, WindowHost,
    remote_endpoint_label,
};
pub use hosts::{
    AddMethod, HostAction, HostChoice, HostDirectory, HostList, HostOutcome, HostPairing,
    HostRefusal, LivePairing,
};
pub use projects::{
    HostProjectCatalog, NewTaskTarget, ProjectCatalogError, ProjectCatalogSource, ProjectCommand,
    ProjectEntry, ProjectSelection, ProjectSelectionEvent, UnavailableProjectCatalog, folder_name,
    list_directory, list_directory_roots, path_name,
};
pub use requester::{
    DEFAULT_REQUEST_TIMEOUT, HostAccess, HostRequestError, HostRequester, HostTransport,
};
pub use state_root::{
    STATE_ROOT_CHOICE_FILE, StateRootChoiceError, StateRootFile, StateRootStore,
    check_state_root_choice, default_state_root, desktop_data_directory,
};

#[cfg(test)]
mod hosts_tests;
