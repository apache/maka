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

//! Execution policy and operating-system isolation. This crate neither grants
//! authority nor retries effects; the Host owns both decisions and their receipts.
mod account;
pub use account::account_home;
#[cfg(unix)]
pub use account::is_private_account_directory;
pub mod filesystem;
pub mod grant;
mod network;
mod path;
mod policy;
pub mod workspace;
pub use network::{Destination, Network};
pub use policy::{Approval, ApprovalKind, Mode, Permissions, Sandbox};
pub mod launch;

/// Address of the private native-task namespace. This does not grant access.
pub fn native_task_namespace() -> std::io::Result<std::path::PathBuf> {
    Ok(std::env::temp_dir()
        .canonicalize()?
        .join("maka-native-tasks"))
}
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod seatbelt;
#[cfg(windows)]
pub mod windows;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid sandbox policy: {0}")]
    Invalid(String),
    #[error("sandbox cannot enforce this policy: {0}")]
    Unsupported(String),
    #[error("sandbox preparation failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("sandbox preparation cleanup is unconfirmed: {0}")]
    CleanupUnconfirmed(String),
}
