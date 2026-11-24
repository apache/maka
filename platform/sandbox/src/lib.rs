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
pub use path::{canonical_policy_path, policy_path_from_resolved};
pub use policy::{Approval, ApprovalKind, Mode, Permissions, Sandbox};
pub mod launch;

/// Address of the private native-task namespace. This does not grant access.
pub fn native_task_namespace() -> std::io::Result<std::path::PathBuf> {
    #[cfg(target_os = "linux")]
    // SAFETY: geteuid has no preconditions.
    let name = format!("maka-native-tasks-{}", unsafe { libc::geteuid() });
    #[cfg(not(target_os = "linux"))]
    let name = "maka-native-tasks";
    Ok(canonical_policy_path(std::env::temp_dir())?.join(name))
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

#[cfg(test)]
mod tests {
    use super::*;
    use filesystem::{Access, Policy, Rule};

    #[test]
    fn native_task_namespace_can_be_denied_by_policy() {
        let namespace = native_task_namespace().unwrap();
        let policy = Policy {
            default: Access::Write,
            rules: vec![Rule::subtree(&namespace, Access::Deny)],
            deny_globs: Vec::new(),
        }
        .compile()
        .unwrap();
        assert_eq!(policy.access(&namespace), Access::Deny);
        assert_eq!(policy.access(&namespace.join("task")), Access::Deny);
        assert_eq!(
            policy.access(&namespace.parent().unwrap().join("other")),
            Access::Write
        );
    }
}
