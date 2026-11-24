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

use crate::Command;
use maka_sandbox::filesystem::Policy;
use std::path::Path;

pub(super) const SUPPORTED: bool = cfg!(any(target_os = "macos", target_os = "linux", windows));

/// Sandbox installation selected by the trusted launcher, never by a task manifest.
#[derive(Default)]
pub struct SandboxRuntime {
    #[cfg(target_os = "linux")]
    network_helper: Option<std::path::PathBuf>,
    #[cfg(windows)]
    backend: Option<std::sync::Arc<dyn crate::bootstrap::Backend>>,
}

impl SandboxRuntime {
    #[cfg(target_os = "linux")]
    pub fn with_network_helper(mut self, executable: std::path::PathBuf) -> Self {
        self.network_helper = Some(executable);
        self
    }

    #[cfg(windows)]
    pub fn with_backend(mut self, backend: std::sync::Arc<dyn crate::bootstrap::Backend>) -> Self {
        self.backend = Some(backend);
        self
    }

    pub(super) fn apply(&self, command: Command) -> Command {
        #[cfg(target_os = "linux")]
        if let Some(helper) = &self.network_helper {
            return command.with_network_helper(helper.clone());
        }
        #[cfg(windows)]
        if let Some(backend) = &self.backend {
            return command.with_backend(backend.clone());
        }
        command
    }
}

// Seatbelt needs metadata-only access to walk through denied ancestors.
#[cfg(target_os = "macos")]
pub(super) fn allow_traversal(policy: &mut Policy, directory: &Path) {
    use maka_sandbox::filesystem::{Access, Rule};
    policy.rules.push(Rule::exact(directory, Access::Read));
}

#[cfg(not(target_os = "macos"))]
pub(super) fn allow_traversal(_: &mut Policy, _: &Path) {}

pub(super) fn private_stdio(_command: &mut Command) {
    #[cfg(target_os = "macos")]
    {
        _command.private_stdio = true;
    }
}

pub(super) fn set_helper_namespace(_command: &mut Command, _resource: &Path) {
    let temp = _resource
        .parent()
        .and_then(Path::parent)
        .expect("native task namespace");
    #[cfg(unix)]
    _command.env("TMPDIR", temp);
    #[cfg(windows)]
    {
        for key in ["SystemRoot", "SystemDrive"] {
            if let Some(value) = std::env::var_os(key) {
                _command.env(key, value);
            }
        }
        _command.env("TEMP", temp).env("TMP", temp);
    }
}

pub(super) async fn canonical(path: &Path) -> std::io::Result<std::path::PathBuf> {
    let canonical = tokio::fs::canonicalize(path).await?;
    Ok(maka_sandbox::policy_path_from_resolved(&canonical)
        .map_err(std::io::Error::other)?
        .into_owned())
}
