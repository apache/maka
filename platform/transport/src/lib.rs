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

//! Trusted local connections between separate UI and Host deployment owners.
mod connections;
pub mod stdio;
pub mod transport;
mod updates;
pub use connections::{Configuration, Connections, Grant, Host, HostEndpoint, HostLocation};
pub use maka_host_runtime::application::transport::{GATEWAY, with_gateway};
pub use updates::{ApprovedUpdate, Updates};
/// Compiled fixed-UI-target management availability for explicit cohost entries.
pub const UI_DEPLOYMENT_MANAGER: &str = "maka.application.ui-management";
pub type Result<T> = std::result::Result<T, String>;

/// The user's choice when closing a UI, after its physical calls have drained.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ExitMode {
    #[default]
    Quit,
    KeepHost,
}

/// Product startup must not exit after losing confirmation of an acquired SQL
/// owner's close. That original worker retains the Root and writer authority.
pub async fn open_store(
    owner: std::sync::Arc<maka_event_log::root::RootOwner>,
) -> std::result::Result<maka_event_log::root_store::RootStore, maka_event_log::StoreError> {
    confirmed_store(maka_event_log::root_store::RootStore::open(owner).await).await
}

/// Inspect an existing Root's saved application without initializing storage.
/// Startup cleanup retains the same original SQL/Root authority as execution.
pub async fn open_application_inspection(
    owner: std::sync::Arc<maka_event_log::root::RootOwner>,
) -> std::result::Result<maka_event_log::EventLog, maka_event_log::StoreError> {
    confirmed_store(maka_event_log::EventLog::for_application_inspection(owner).await).await
}

async fn confirmed_store<T>(
    result: std::result::Result<T, maka_event_log::StoreError>,
) -> std::result::Result<T, maka_event_log::StoreError> {
    match result {
        Err(error @ maka_event_log::StoreError::StartupCleanupFailed { .. }) => {
            eprintln!("SQL startup cleanup unconfirmed: {error}");
            std::future::pending().await
        }
        result => result,
    }
}

pub fn manager_native() -> maka_plugin_core::package::NativeDefinition {
    let mut definition = maka_host_runtime::application::management::native();
    definition.implementation = UI_DEPLOYMENT_MANAGER.into();
    definition
}
