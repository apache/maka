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

//! What the supervisor starts: the sidecar's sources, compiled into this
//! crate and written out once per build to the client's cache directory, and
//! the command line that runs them.
//!
//! The sources are compiled in so the app needs no files beside its binary:
//! a bundled app and a development build start the same sidecar. They are
//! written to `<cache>/maka-gpui/bots-sidecar/<digest>/`, named by a digest of
//! their contents, so a new build never runs an old copy and two instances of
//! one build share one.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest as _, Sha256};

/// The sidecar's files, as `sidecars/bots/` has them.
const SOURCES: &[(&str, &str)] = &[
    ("main.mjs", include_str!("../../../sidecars/bots/main.mjs")),
    ("sidecar.mjs", include_str!("../../../sidecars/bots/sidecar.mjs")),
    ("incoming.mjs", include_str!("../../../sidecars/bots/incoming.mjs")),
    ("onboarding.mjs", include_str!("../../../sidecars/bots/onboarding.mjs")),
    ("session-adapter.mjs", include_str!("../../../sidecars/bots/session-adapter.mjs")),
    ("host-link.mjs", include_str!("../../../sidecars/bots/host-link.mjs")),
    ("telegram-api.mjs", include_str!("../../../sidecars/bots/telegram-api.mjs")),
    ("maka.mjs", include_str!("../../../sidecars/bots/maka.mjs")),
];

/// The entry point among [`SOURCES`].
const ENTRYPOINT: &str = "main.mjs";

/// The directory under the platform cache directory that holds this
/// client's cached files.
const CACHE_DIRECTORY: &str = "maka-gpui";

/// A file in the Maka checkout that only a checkout with the bots package
/// built has (`@maka/runtime/bots`).
pub const BOTS_BUILD_MARKER: &str = "packages/runtime/dist/bots/index.js";

/// The platform cache directory for this client (on macOS
/// `~/Library/Caches/maka-gpui`).
pub fn default_cache_directory() -> Option<PathBuf> {
    Some(dirs::cache_dir()?.join(CACHE_DIRECTORY))
}

/// Writes the sidecar's sources under `cache_directory` unless this build's
/// copy is already there, and returns the entry point script.
pub async fn materialize_sidecar(cache_directory: &Path) -> io::Result<PathBuf> {
    let directory = cache_directory.join("bots-sidecar").join(sources_digest());
    let entrypoint = directory.join(ENTRYPOINT);
    if async_fs::metadata(&entrypoint).await.is_ok_and(|metadata| metadata.is_file()) {
        return Ok(entrypoint);
    }
    let parent = directory.parent().unwrap_or(cache_directory);
    async_fs::create_dir_all(parent).await?;
    // Written beside the target and renamed into place, so the entry point
    // exists only once every file does.
    let staging = parent.join(format!(".staging-{}", uuid::Uuid::new_v4().simple()));
    let written = async {
        async_fs::create_dir(&staging).await?;
        for (name, contents) in SOURCES {
            async_fs::write(staging.join(name), contents).await?;
        }
        async_fs::rename(&staging, &directory).await
    }
    .await;
    if let Err(error) = written {
        let _ = async_fs::remove_dir_all(&staging).await;
        // Another instance of this build got there first.
        if async_fs::metadata(&entrypoint).await.is_ok_and(|metadata| metadata.is_file()) {
            return Ok(entrypoint);
        }
        return Err(error);
    }
    Ok(entrypoint)
}

/// The first 16 hex digits of a SHA-256 over every file's name and contents.
fn sources_digest() -> String {
    let mut hasher = Sha256::new();
    for (name, contents) in SOURCES {
        hasher.update((name.len() as u64).to_le_bytes());
        hasher.update(name.as_bytes());
        hasher.update((contents.len() as u64).to_le_bytes());
        hasher.update(contents.as_bytes());
    }
    hasher.finalize().iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

/// A process to supervise: the program, its arguments and its environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarCommand {
    program: PathBuf,
    args: Vec<OsString>,
    env: Vec<(OsString, Option<OsString>)>,
    current_dir: Option<PathBuf>,
}

impl SidecarCommand {
    /// Runs `program` with no arguments in the client's environment.
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self { program: program.into(), args: Vec::new(), env: Vec::new(), current_dir: None }
    }

    /// The bot sidecar: `node <script> --maka-repo <checkout> --state-root
    /// <root>`, run from the checkout.
    pub fn bot_sidecar(node: &Path, script: &Path, checkout: &Path, state_root: &Path) -> Self {
        Self::new(node)
            .arg(script)
            .arg("--maka-repo")
            .arg(checkout)
            .arg("--state-root")
            .arg(state_root)
            .current_dir(checkout)
    }

    pub fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }

    /// Sets `key` for the process.
    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((key.into(), Some(value.into())));
        self
    }

    /// Removes `key` from the process's environment.
    pub fn env_remove(mut self, key: impl Into<OsString>) -> Self {
        self.env.push((key.into(), None));
        self
    }

    pub fn current_dir(mut self, directory: impl Into<PathBuf>) -> Self {
        self.current_dir = Some(directory.into());
        self
    }

    pub fn program(&self) -> &Path {
        &self.program
    }

    pub(crate) fn to_command(&self) -> async_process::Command {
        let mut command = async_process::Command::new(&self.program);
        command.args(&self.args);
        for (key, value) in &self.env {
            match value {
                Some(value) => command.env(key, value),
                None => command.env_remove(key),
            };
        }
        if let Some(directory) = &self.current_dir {
            command.current_dir(directory);
        }
        command
    }
}

#[cfg(test)]
// Test setup reads files synchronously; no UI thread is involved.
#[allow(clippy::disallowed_methods)]
mod tests {
    use std::fs;

    use futures_lite::future::block_on;

    use super::*;

    #[test]
    fn every_module_the_sidecar_imports_is_compiled_in() {
        let names: Vec<_> = SOURCES.iter().map(|(name, _)| *name).collect();
        for (name, contents) in SOURCES {
            for line in contents.lines() {
                let Some(start) = line.find("from './") else { continue };
                let rest = &line[start + "from './".len()..];
                let imported = &rest[..rest.find('\'').expect("closing quote")];
                assert!(names.contains(&imported), "{name} imports ./{imported}, which is missing");
            }
        }
    }

    #[test]
    fn the_sources_are_written_once_per_digest() {
        let cache = std::env::temp_dir()
            .join(format!("bots-sidecar-cache-{}", uuid::Uuid::new_v4().simple()));
        let entrypoint = block_on(materialize_sidecar(&cache)).expect("written");
        assert_eq!(entrypoint.file_name().and_then(|name| name.to_str()), Some(ENTRYPOINT));
        let directory = entrypoint.parent().expect("directory");
        for (name, contents) in SOURCES {
            assert_eq!(fs::read_to_string(directory.join(name)).expect(name), *contents);
        }
        assert_eq!(block_on(materialize_sidecar(&cache)).expect("reused"), entrypoint);
        let entries = fs::read_dir(cache.join("bots-sidecar")).expect("list").count();
        assert_eq!(entries, 1, "no staging directory is left behind");
        fs::remove_dir_all(cache).ok();
    }
}
