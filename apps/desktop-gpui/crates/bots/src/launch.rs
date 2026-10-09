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

//! What must hold before the bot sidecar starts, checked in one place.
//!
//! The sidecar connects to the Runtime Host through the Host's local
//! registration, so it serves a Host on this computer only: Desktop runs its
//! bots against its default local Host (`handleBotIncomingMessage` in
//! runtime-host-desktop-manager.ts) and refuses them for guest profiles. It
//! runs Maka's bot package from the Maka checkout the client launches its
//! Host from, with a Node found the way the Host launch finds one, and it
//! runs once per State Root ([`crate::InstanceLock`]).

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

use host_client::{DiscoveryError, NodeError, NodeRuntime, configured_maka_checkout, read_root_id};
use thiserror::Error;

use crate::instance_lock::{InstanceLock, InstanceLockError, default_lock_directory};
use crate::sidecar::{
    BOTS_BUILD_MARKER, SidecarCommand, default_cache_directory, materialize_sidecar,
};
use crate::supervisor::{RestartPolicy, SupervisedBots, supervise};

/// The Runtime Host the window works with.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum BotHost {
    /// A Host on this computer, serving the State Root at `state_root`.
    Local { state_root: PathBuf },
    /// A Host reached over the network.
    Remote,
}

/// Where the sidecar's pieces come from. Every field left `None` is found
/// the way the app finds it.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct LaunchOptions {
    /// The Maka checkout; default `$MAKA_REPO`, else `~/code/maka-pin`.
    pub checkout: Option<PathBuf>,
    /// The Node executable; default [`NodeRuntime::discover`].
    pub node: Option<PathBuf>,
    /// Default [`crate::default_lock_directory`].
    pub lock_directory: Option<PathBuf>,
    /// Default [`crate::default_cache_directory`].
    pub cache_directory: Option<PathBuf>,
    /// Extra environment for the sidecar (`None` removes a variable).
    pub env: Vec<(OsString, Option<OsString>)>,
}

impl LaunchOptions {
    pub fn with_checkout(mut self, checkout: impl Into<PathBuf>) -> Self {
        self.checkout = Some(checkout.into());
        self
    }

    pub fn with_node(mut self, node: impl Into<PathBuf>) -> Self {
        self.node = Some(node.into());
        self
    }

    pub fn with_lock_directory(mut self, directory: impl Into<PathBuf>) -> Self {
        self.lock_directory = Some(directory.into());
        self
    }

    pub fn with_cache_directory(mut self, directory: impl Into<PathBuf>) -> Self {
        self.cache_directory = Some(directory.into());
        self
    }

    pub fn with_env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((key.into(), Some(value.into())));
        self
    }
}

/// Why the sidecar is not started.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum LaunchRefusal {
    /// Bots answer through the local Host only.
    #[error("chat bots run only with a Runtime Host on this computer")]
    HostNotLocal,
    /// The State Root has no root marker yet (its Host never started).
    #[error(transparent)]
    NoStateRoot(DiscoveryError),
    #[error(transparent)]
    Locked(InstanceLockError),
    #[error("no Maka checkout to run the chat bots from; set MAKA_REPO to a Maka checkout")]
    NoCheckout,
    #[error(
        "the Maka checkout at {} has no built bot package ({BOTS_BUILD_MARKER}); build it (docs/dev-host.md)",
        checkout.display()
    )]
    CheckoutNotBuilt { checkout: PathBuf },
    #[error(transparent)]
    NoNode(NodeError),
    #[error("no cache or config directory for the bot sidecar")]
    NoDirectory,
    #[error("cannot write the bot sidecar to {}: {source}", path.display())]
    Materialize {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

impl LaunchRefusal {
    /// Another window or client already runs this State Root's bots.
    pub fn is_held_elsewhere(&self) -> bool {
        matches!(self, Self::Locked(InstanceLockError::Held { .. }))
    }
}

/// A sidecar ready to start, holding its State Root's lock.
#[derive(Debug)]
pub struct PreparedLaunch {
    command: SidecarCommand,
    root_id: String,
    lock: InstanceLock,
}

impl PreparedLaunch {
    pub fn command(&self) -> &SidecarCommand {
        &self.command
    }

    pub fn root_id(&self) -> &str {
        &self.root_id
    }

    /// Supervises the sidecar; the lock is held until the supervisor stops.
    pub fn supervise(self, policy: RestartPolicy) -> SupervisedBots {
        supervise(self.command, policy, Some(self.lock))
    }
}

/// Checks everything the sidecar needs for `host` and takes the State
/// Root's lock.
pub async fn prepare_launch(
    host: &BotHost,
    options: &LaunchOptions,
) -> Result<PreparedLaunch, LaunchRefusal> {
    let BotHost::Local { state_root } = host else {
        return Err(LaunchRefusal::HostNotLocal);
    };
    let root_id = read_root_id(state_root).await.map_err(LaunchRefusal::NoStateRoot)?;
    let lock_directory = options
        .lock_directory
        .clone()
        .or_else(default_lock_directory)
        .ok_or(LaunchRefusal::NoDirectory)?;
    let lock =
        InstanceLock::acquire(&lock_directory, &root_id).await.map_err(LaunchRefusal::Locked)?;
    let checkout = options
        .checkout
        .clone()
        .or_else(configured_maka_checkout)
        .ok_or(LaunchRefusal::NoCheckout)?;
    if !is_file(&checkout.join(BOTS_BUILD_MARKER)).await {
        return Err(LaunchRefusal::CheckoutNotBuilt { checkout });
    }
    let node = match &options.node {
        Some(node) => node.clone(),
        None => NodeRuntime::discover().await.map_err(LaunchRefusal::NoNode)?.path().to_owned(),
    };
    let cache_directory = options
        .cache_directory
        .clone()
        .or_else(default_cache_directory)
        .ok_or(LaunchRefusal::NoDirectory)?;
    let script = materialize_sidecar(&cache_directory)
        .await
        .map_err(|source| LaunchRefusal::Materialize { path: cache_directory.clone(), source })?;
    let mut command = SidecarCommand::bot_sidecar(&node, &script, &checkout, state_root);
    for (key, value) in &options.env {
        command = match value {
            Some(value) => command.env(key, value),
            None => command.env_remove(key),
        };
    }
    Ok(PreparedLaunch { command, root_id, lock })
}

async fn is_file(path: &Path) -> bool {
    async_fs::metadata(path).await.is_ok_and(|metadata| metadata.is_file())
}

#[cfg(test)]
// Test setup writes fixture files synchronously; no UI thread is involved.
#[allow(clippy::disallowed_methods)]
mod tests {
    use std::fs;

    use futures_lite::future::block_on;
    use host_client::{STORAGE_ROOT_MARKER_FILE, prepare_state_root};

    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("bots-launch-{name}-{}", uuid::Uuid::new_v4().simple()));
            fs::create_dir_all(&dir).expect("scratch");
            Self(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    fn options(scratch: &Scratch, checkout: &Path) -> LaunchOptions {
        LaunchOptions::default()
            .with_checkout(checkout)
            .with_node("/usr/bin/true")
            .with_lock_directory(scratch.0.join("locks"))
            .with_cache_directory(scratch.0.join("cache"))
    }

    #[test]
    fn a_remote_host_is_refused() {
        let refusal = block_on(prepare_launch(&BotHost::Remote, &LaunchOptions::default()))
            .expect_err("remote");
        assert!(matches!(refusal, LaunchRefusal::HostNotLocal), "{refusal}");
    }

    #[test]
    fn a_local_root_launches_once_from_a_built_checkout() {
        let scratch = Scratch::new("local");
        let root = scratch.0.join("root");
        block_on(prepare_state_root(&root)).expect("state root");
        assert!(root.join(STORAGE_ROOT_MARKER_FILE).is_file());
        let host = BotHost::Local { state_root: root.clone() };
        let checkout = scratch.0.join("checkout");

        let refusal =
            block_on(prepare_launch(&host, &options(&scratch, &checkout))).expect_err("not built");
        assert!(matches!(refusal, LaunchRefusal::CheckoutNotBuilt { .. }), "{refusal}");

        let marker = checkout.join(BOTS_BUILD_MARKER);
        fs::create_dir_all(marker.parent().expect("parent")).expect("dirs");
        fs::write(&marker, "").expect("marker");
        let launch =
            block_on(prepare_launch(&host, &options(&scratch, &checkout))).expect("launch");
        let command = launch.command().to_command();
        let args: Vec<_> = command.get_args().map(|arg| arg.to_owned()).collect();
        assert_eq!(command.get_program(), "/usr/bin/true");
        assert!(args[0].to_string_lossy().ends_with("main.mjs"), "{args:?}");
        assert_eq!(
            args[1..],
            [
                "--maka-repo".into(),
                checkout.clone().into_os_string(),
                "--state-root".into(),
                root.clone().into_os_string()
            ]
        );

        // While the first launch holds the State Root, a second is refused.
        let refusal =
            block_on(prepare_launch(&host, &options(&scratch, &checkout))).expect_err("held");
        assert!(refusal.is_held_elsewhere(), "{refusal}");
        drop(launch);
        block_on(prepare_launch(&host, &options(&scratch, &checkout))).expect("released");
    }

    #[test]
    fn a_folder_that_is_not_a_state_root_is_refused() {
        let scratch = Scratch::new("no-root");
        let host = BotHost::Local { state_root: scratch.0.join("missing") };
        let refusal =
            block_on(prepare_launch(&host, &options(&scratch, &scratch.0))).expect_err("no root");
        assert!(matches!(refusal, LaunchRefusal::NoStateRoot(_)), "{refusal}");
    }
}
