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

use super::{CredentialBase, CredentialSeed, Error};
use maka_agent_api::executor::{NativeCommand, NativeRuntime};
use maka_sandbox::Sandbox;
use std::{
    fs::OpenOptions,
    path::{Path, PathBuf},
};

/// Called only after the real Run capability's current policy check. Export
/// known login material, never the old CLI profile, daemon address or whole HOME.
pub(super) async fn capture(
    runtime: NativeRuntime,
    command: &NativeCommand,
    actual: &Sandbox,
    state_root: &Path,
) -> Result<Vec<CredentialSeed>, Error> {
    let home = command
        .env
        .get("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from));
    let source = match runtime {
        NativeRuntime::Codex => {
            let base = command
                .env
                .get("CODEX_HOME")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("CODEX_HOME").map(PathBuf::from))
                .or_else(|| home.as_ref().map(|home| home.join(".codex")));
            base.map(|base| {
                (
                    base.join("auth.json"),
                    CredentialBase::CodexHome,
                    PathBuf::from("auth.json"),
                )
            })
        }
        NativeRuntime::Claude => {
            let base = command
                .env
                .get("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from))
                .or_else(|| home.as_ref().map(|home| home.join(".claude")));
            base.map(|base| {
                (
                    base.join(".credentials.json"),
                    CredentialBase::ClaudeConfig,
                    PathBuf::from(".credentials.json"),
                )
            })
        }
        NativeRuntime::Antigravity => None,
    };
    let Some((source, base, relative)) = source else {
        return Ok(Vec::new());
    };
    let actual = actual.clone();
    let state_root = state_root.to_owned();
    tokio::task::spawn_blocking(move || {
        if !source.is_absolute() {
            return Err(Error::Invalid(
                "native credential location must be absolute".into(),
            ));
        }
        let source = match source.canonicalize() {
            Ok(source) => source,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => {
                return Err(Error::Invalid(format!(
                    "native credential export unavailable: {error}"
                )));
            }
        };
        if source.starts_with(&state_root) {
            return Err(Error::Invalid(
                "native credential export cannot read private Root state".into(),
            ));
        }
        match actual {
            Sandbox::Managed { filesystem, .. } => {
                if !filesystem
                    .compile()
                    .map_err(|error| Error::Invalid(error.to_string()))?
                    .access(&source)
                    .can_read()
                {
                    return Err(Error::Invalid(
                        "native credential export is outside current read permissions".into(),
                    ));
                }
            }
            Sandbox::Disabled => {}
            Sandbox::External { .. } => {
                return Err(Error::IsolationUnavailable(
                    "external filesystem read authority is unavailable".into(),
                ));
            }
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = options.open(&source).map_err(|error| {
            Error::Invalid(format!("native credential export unavailable: {error}"))
        })?;
        let before = file
            .metadata()
            .map_err(|error| Error::Invalid(error.to_string()))?;
        if !before.is_file() {
            return Err(Error::Invalid(
                "native credential export is not a regular file".into(),
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if before.nlink() != 1 {
                return Err(Error::Invalid(
                    "native credential export cannot use a linked file".into(),
                ));
            }
        }
        Ok(vec![CredentialSeed {
            base,
            relative,
            len: before.len(),
            file,
        }])
    })
    .await
    .map_err(|_| Error::Invalid("native credential export worker failed".into()))?
}
