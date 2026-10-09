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

//! Finding what a Host candidate runs: the Maka installation that provides
//! the candidate entry point, and a Node runtime new enough to run it.

use std::cmp::Ordering;
use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};

use thiserror::Error;

/// Names the Maka checkout to launch Hosts from.
pub const MAKA_REPO_ENV: &str = "MAKA_REPO";

/// Names the Node executable to launch Hosts with.
pub const MAKA_NODE_ENV: &str = "MAKA_NODE";

/// The candidate entry point inside a Maka checkout: the built form of
/// `packages/runtime-host/src/execution-candidate-main.ts`, which the TS
/// launchers run (`@maka/runtime-host/execution-candidate-main`, resolved in
/// `connectRuntimeHostCliConnection` in
/// `packages/cli/src/runtime-host-cli-context.ts`).
pub const CANDIDATE_ENTRYPOINT: &str = "packages/runtime-host/dist/execution-candidate-main.js";

/// The checkout used when [`MAKA_REPO_ENV`] is not set, relative to the home
/// directory (the default `AGENTS.md` documents): a checkout of the apache/maka
/// commit `MAKA_PIN` names, whose Hosts speak this client's compatibility
/// epoch.
const DEFAULT_CHECKOUT: &str = "code/maka-pin";

/// The oldest Node that runs Maka: `engines.node` (`>=22.19.0`) in the Maka
/// repository's root `package.json`.
pub const MINIMUM_NODE_VERSION: NodeVersion = NodeVersion::new(22, 19, 0);

/// The Maka checkout Hosts are launched from: [`MAKA_REPO_ENV`] when set,
/// else `~/code/maka-pin`. Reads the environment only; whether a built
/// checkout is there is [`MakaInstallation::discover`]'s question.
pub fn configured_maka_checkout() -> Option<PathBuf> {
    match std::env::var_os(MAKA_REPO_ENV).filter(|repo| !repo.is_empty()) {
        Some(repo) => Some(PathBuf::from(repo)),
        None => std::env::home_dir().map(|home| home.join(DEFAULT_CHECKOUT)),
    }
}

/// Where Hosts are launched from: the candidate entry point of one Maka
/// installation.
///
/// Today that is a development checkout. A released Maka CLI package is the
/// next source to add here; the TS CLI finds its own copy with
/// `import.meta.resolve('@maka/runtime-host/execution-candidate-main')`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MakaInstallation {
    entrypoint: PathBuf,
}

impl MakaInstallation {
    /// An installation whose candidate entry point is `entrypoint`, used as
    /// given.
    pub fn with_entrypoint(entrypoint: impl Into<PathBuf>) -> Self {
        Self { entrypoint: entrypoint.into() }
    }

    /// The candidate entry point script.
    pub fn entrypoint(&self) -> &Path {
        &self.entrypoint
    }

    /// Finds the installation named by [`MAKA_REPO_ENV`], or the default
    /// checkout `~/code/maka-pin` when it is unset. A set variable is
    /// never second-guessed with the default.
    pub async fn discover() -> Result<Self, InstallationError> {
        Self::discover_in(std::env::var_os(MAKA_REPO_ENV), std::env::home_dir()).await
    }

    pub(crate) async fn discover_in(
        repo: Option<OsString>,
        home: Option<PathBuf>,
    ) -> Result<Self, InstallationError> {
        let (repo, from_environment) = match repo.filter(|repo| !repo.is_empty()) {
            Some(repo) => (PathBuf::from(repo), true),
            None => match home {
                Some(home) => (home.join(DEFAULT_CHECKOUT), false),
                None => {
                    return Err(InstallationError {
                        searched: vec![Searched::new(
                            format!("${MAKA_REPO_ENV}"),
                            "unset, and the home directory is unknown",
                        )],
                        checkout: None,
                    });
                }
            },
        };
        let origin = if from_environment {
            format!("${MAKA_REPO_ENV}")
        } else {
            format!("default, ${MAKA_REPO_ENV} unset")
        };
        let entrypoint = repo.join(CANDIDATE_ENTRYPOINT);
        let outcome = match async_fs::metadata(&entrypoint).await {
            Ok(metadata) if metadata.is_file() => return Ok(Self { entrypoint }),
            Ok(_) => "not a file".to_owned(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                "not found; build the Runtime Host (see docs/dev-host.md)".to_owned()
            }
            Err(error) => error.to_string(),
        };
        let exists = async_fs::metadata(&repo).await.is_ok_and(|metadata| metadata.is_dir());
        Err(InstallationError {
            searched: vec![Searched::new(format!("{} ({origin})", entrypoint.display()), outcome)],
            checkout: Some(MissingCheckout { path: repo, from_environment, exists }),
        })
    }
}

/// The Maka checkout a Host was to be started from, which has no built
/// candidate entry point ([`CANDIDATE_ENTRYPOINT`]).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct MissingCheckout {
    /// The checkout directory.
    pub path: PathBuf,
    /// Whether [`MAKA_REPO_ENV`] named it; otherwise it is the default,
    /// `~/code/maka-pin`.
    pub from_environment: bool,
    /// Whether the directory exists: then it is a checkout that was not
    /// built, else there is no checkout at all.
    pub exists: bool,
}

impl MissingCheckout {
    /// The checkout at `path`, named by [`MAKA_REPO_ENV`] when
    /// `from_environment`, which `exists` as a directory or not.
    pub fn new(path: impl Into<PathBuf>, from_environment: bool, exists: bool) -> Self {
        Self { path: path.into(), from_environment, exists }
    }
}

/// One place that was searched, and why it did not qualify.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Searched {
    location: String,
    outcome: String,
}

impl Searched {
    fn new(location: impl Into<String>, outcome: impl Into<String>) -> Self {
        Self { location: location.into(), outcome: outcome.into() }
    }

    pub fn location(&self) -> &str {
        &self.location
    }

    pub fn outcome(&self) -> &str {
        &self.outcome
    }
}

fn write_searched(f: &mut fmt::Formatter<'_>, searched: &[Searched]) -> fmt::Result {
    for (index, place) in searched.iter().enumerate() {
        let separator = if index == 0 { " Searched: " } else { "; " };
        write!(f, "{separator}{}: {}", place.location, place.outcome)?;
    }
    if !searched.is_empty() {
        f.write_str(".")?;
    }
    Ok(())
}

/// No Maka installation to launch a Host from.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub struct InstallationError {
    searched: Vec<Searched>,
    checkout: Option<MissingCheckout>,
}

impl InstallationError {
    pub fn searched(&self) -> &[Searched] {
        &self.searched
    }

    /// The checkout that was looked in, unless there was none to look in
    /// (no [`MAKA_REPO_ENV`] and no home directory).
    pub fn checkout(&self) -> Option<&MissingCheckout> {
        self.checkout.as_ref()
    }
}

impl fmt::Display for InstallationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "no Maka installation to start a Runtime Host from; set {MAKA_REPO_ENV} to a Maka checkout."
        )?;
        write_searched(f, &self.searched)
    }
}

/// A Node version, `major.minor.patch`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NodeVersion {
    major: u32,
    minor: u32,
    patch: u32,
}

impl NodeVersion {
    pub const fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self { major, minor, patch }
    }

    /// Parses `v24.18.0` or `24.18.0`, ignoring surrounding whitespace.
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let text = text.strip_prefix('v').unwrap_or(text);
        let mut parts = text.split('.');
        let mut next = || parts.next()?.parse::<u32>().ok();
        let version = Self::new(next()?, next()?, next()?);
        parts.next().is_none().then_some(version)
    }
}

impl PartialOrd for NodeVersion {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for NodeVersion {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch).cmp(&(other.major, other.minor, other.patch))
    }
}

impl fmt::Display for NodeVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "v{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// How a [`NodeRuntime`] was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum NodeSource {
    /// Given by the caller.
    Explicit,
    /// [`MAKA_NODE_ENV`].
    Environment,
    /// The first `node` on `PATH`.
    Path,
    /// The newest qualifying version installed by nvm.
    Nvm,
}

/// A Node executable at least [`MINIMUM_NODE_VERSION`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeRuntime {
    path: PathBuf,
    version: Option<NodeVersion>,
    source: NodeSource,
}

impl NodeRuntime {
    /// The executable at `path`, used as given without a version check.
    pub fn with_path(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into(), version: None, source: NodeSource::Explicit }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The version, when discovery checked it.
    pub fn version(&self) -> Option<NodeVersion> {
        self.version
    }

    pub fn source(&self) -> NodeSource {
        self.source
    }

    /// Finds Node the way `docs/dev-host.md` describes: [`MAKA_NODE_ENV`] if
    /// set (it must qualify; nothing else is tried), else the first `node`
    /// on `PATH` if it is new enough, else the newest version nvm installed
    /// under `$NVM_DIR` (default `~/.nvm`) that is new enough.
    ///
    /// A GUI app started from Finder gets a minimal `PATH`, so the nvm step
    /// is what usually finds Node there.
    pub async fn discover() -> Result<Self, NodeError> {
        let lookup = NodeLookup {
            maka_node: std::env::var_os(MAKA_NODE_ENV),
            path: std::env::var_os("PATH"),
            nvm_dir: std::env::var_os("NVM_DIR").map(PathBuf::from),
            home: std::env::home_dir(),
        };
        Self::discover_in(&lookup).await
    }

    pub(crate) async fn discover_in(lookup: &NodeLookup) -> Result<Self, NodeError> {
        let mut searched = Vec::new();
        if let Some(explicit) = lookup.maka_node.as_ref().filter(|value| !value.is_empty()) {
            let path = PathBuf::from(explicit);
            let location = format!("{} (${MAKA_NODE_ENV})", path.display());
            return match check_node(&path).await {
                Ok(version) => {
                    Ok(Self { path, version: Some(version), source: NodeSource::Environment })
                }
                Err(outcome) => Err(NodeError { searched: vec![Searched::new(location, outcome)] }),
            };
        }

        match find_on_path(lookup.path.as_deref()).await {
            Some(path) => {
                let location = format!("{} (PATH)", path.display());
                match check_node(&path).await {
                    Ok(version) => {
                        return Ok(Self { path, version: Some(version), source: NodeSource::Path });
                    }
                    Err(outcome) => searched.push(Searched::new(location, outcome)),
                }
            }
            None => searched.push(Searched::new("node on PATH", "not found")),
        }

        let nvm_dir =
            lookup.nvm_dir.clone().or_else(|| lookup.home.as_ref().map(|home| home.join(".nvm")));
        match nvm_dir {
            Some(nvm_dir) => {
                let versions = nvm_dir.join("versions/node");
                match newest_nvm_node(&versions).await {
                    Ok(Some((path, version))) => {
                        return Ok(Self { path, version: Some(version), source: NodeSource::Nvm });
                    }
                    Ok(None) => searched.push(Searched::new(
                        versions.display().to_string(),
                        format!("no version {MINIMUM_NODE_VERSION} or newer"),
                    )),
                    Err(outcome) => {
                        searched.push(Searched::new(versions.display().to_string(), outcome))
                    }
                }
            }
            None => searched.push(Searched::new("nvm", "no NVM_DIR and no home directory")),
        }
        Err(NodeError { searched })
    }
}

/// What [`NodeRuntime::discover`] reads from the environment.
#[derive(Debug, Clone, Default)]
pub(crate) struct NodeLookup {
    pub(crate) maka_node: Option<OsString>,
    pub(crate) path: Option<OsString>,
    pub(crate) nvm_dir: Option<PathBuf>,
    pub(crate) home: Option<PathBuf>,
}

/// No Node runtime new enough to run a Host.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub struct NodeError {
    searched: Vec<Searched>,
}

impl NodeError {
    pub fn searched(&self) -> &[Searched] {
        &self.searched
    }
}

impl fmt::Display for NodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "no Node {MINIMUM_NODE_VERSION} or newer to run the Runtime Host; install one with nvm \
             or set {MAKA_NODE_ENV} to its path."
        )?;
        write_searched(f, &self.searched)
    }
}

/// Runs `node --version` on the blocking pool and checks the result.
async fn check_node(path: &Path) -> Result<NodeVersion, String> {
    match async_fs::metadata(path).await {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err("not a file".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err("not found".to_owned());
        }
        Err(error) => return Err(error.to_string()),
    }
    let executable = path.to_owned();
    let output = blocking::unblock(move || {
        // Runs on the `blocking` thread pool, never on the UI thread.
        #[allow(clippy::disallowed_methods)]
        std::process::Command::new(executable)
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .output()
    })
    .await
    .map_err(|error| format!("cannot run it: {error}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let version = NodeVersion::parse(&text)
        .ok_or_else(|| format!("`--version` printed {:?}", text.trim()))?;
    if version < MINIMUM_NODE_VERSION {
        return Err(format!("{version} is older than {MINIMUM_NODE_VERSION}"));
    }
    Ok(version)
}

/// The first `node` in `path` that is a file with an execute bit.
async fn find_on_path(path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    for directory in std::env::split_paths(path?) {
        if directory.as_os_str().is_empty() {
            continue;
        }
        let candidate = directory.join(if cfg!(windows) { "node.exe" } else { "node" });
        if let Ok(metadata) = async_fs::metadata(&candidate).await
            && metadata.is_file()
            && is_executable(&metadata)
        {
            return Some(candidate);
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_: &std::fs::Metadata) -> bool {
    true
}

/// The newest `v*/bin/node` under nvm's `versions/node` directory that is
/// at least [`MINIMUM_NODE_VERSION`], judged by the directory name.
async fn newest_nvm_node(versions: &Path) -> Result<Option<(PathBuf, NodeVersion)>, String> {
    use futures_lite::StreamExt as _;

    let mut entries = match async_fs::read_dir(versions).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err("not found".to_owned());
        }
        Err(error) => return Err(error.to_string()),
    };
    let mut best: Option<(PathBuf, NodeVersion)> = None;
    while let Some(entry) = entries.next().await {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name();
        let Some(version) = name.to_str().and_then(NodeVersion::parse) else { continue };
        if version < MINIMUM_NODE_VERSION || best.as_ref().is_some_and(|(_, best)| *best >= version)
        {
            continue;
        }
        let node = entry.path().join("bin").join(if cfg!(windows) { "node.exe" } else { "node" });
        if async_fs::metadata(&node).await.is_ok_and(|metadata| metadata.is_file()) {
            best = Some((node, version));
        }
    }
    Ok(best)
}

#[cfg(all(test, unix))]
// Test setup writes fixture files synchronously; no UI thread is involved.
#[allow(clippy::disallowed_methods)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt as _;

    use futures_lite::future::block_on;

    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("host-client-installation-{name}-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    /// A fake `node` that prints `version`.
    fn fake_node(path: &Path, version: &str) {
        fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        fs::write(path, format!("#!/bin/sh\necho {version}\n")).expect("script");
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("chmod");
    }

    #[test]
    fn versions_parse_and_order() {
        assert_eq!(NodeVersion::parse("v24.18.0\n"), Some(NodeVersion::new(24, 18, 0)));
        assert_eq!(NodeVersion::parse("22.19.0"), Some(NodeVersion::new(22, 19, 0)));
        for bad in ["", "v24", "v24.18", "v24.18.0.1", "node", "v24.x.0"] {
            assert_eq!(NodeVersion::parse(bad), None, "{bad}");
        }
        assert!(NodeVersion::new(22, 17, 0) < MINIMUM_NODE_VERSION);
        assert!(NodeVersion::new(22, 19, 0) >= MINIMUM_NODE_VERSION);
        assert!(NodeVersion::new(24, 18, 0) > NodeVersion::new(23, 99, 99));
        assert_eq!(NodeVersion::new(24, 18, 0).to_string(), "v24.18.0");
    }

    #[test]
    fn the_checkout_comes_from_maka_repo_or_the_default() {
        let dir = scratch("checkout");
        let entrypoint = dir.join(CANDIDATE_ENTRYPOINT);
        fs::create_dir_all(entrypoint.parent().expect("parent")).expect("dirs");
        fs::write(&entrypoint, "").expect("entrypoint");

        let found = block_on(MakaInstallation::discover_in(Some(dir.clone().into()), None))
            .expect("from MAKA_REPO");
        assert_eq!(found.entrypoint(), entrypoint);

        let home = scratch("home");
        let error = block_on(MakaInstallation::discover_in(None, Some(home.clone())))
            .expect_err("no default checkout");
        let text = error.to_string();
        assert!(text.contains("set MAKA_REPO"), "{text}");
        assert!(
            text.contains(
                &home.join(DEFAULT_CHECKOUT).join(CANDIDATE_ENTRYPOINT).display().to_string()
            ),
            "{text}"
        );
        assert!(text.contains("default, $MAKA_REPO unset"), "{text}");
        // The window names the checkout, and that there is none yet.
        assert_eq!(
            error.checkout(),
            Some(&MissingCheckout {
                path: home.join(DEFAULT_CHECKOUT),
                from_environment: false,
                exists: false
            })
        );

        // A set variable is not replaced by the default.
        let error =
            block_on(MakaInstallation::discover_in(Some(home.clone().into()), Some(dir.clone())))
                .expect_err("MAKA_REPO without a build");
        assert!(error.to_string().contains("($MAKA_REPO)"), "{error}");
        // The directory is there; it was not built.
        assert_eq!(
            error.checkout(),
            Some(&MissingCheckout { path: home.clone(), from_environment: true, exists: true })
        );
        let error = block_on(MakaInstallation::discover_in(None, None)).expect_err("no home");
        assert_eq!(error.checkout(), None);
        fs::remove_dir_all(dir).ok();
        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn maka_node_must_qualify_and_nothing_else_is_tried() {
        let dir = scratch("maka-node");
        let old = dir.join("old/node");
        fake_node(&old, "v22.17.0");
        let lookup = NodeLookup { maka_node: Some(old.clone().into()), ..NodeLookup::default() };
        let error = block_on(NodeRuntime::discover_in(&lookup)).expect_err("too old");
        assert_eq!(error.searched().len(), 1);
        assert!(error.to_string().contains("v22.17.0 is older than v22.19.0"), "{error}");

        let good = dir.join("good/node");
        fake_node(&good, "v24.18.0");
        let lookup = NodeLookup { maka_node: Some(good.clone().into()), ..NodeLookup::default() };
        let node = block_on(NodeRuntime::discover_in(&lookup)).expect("qualifies");
        assert_eq!((node.path(), node.source()), (good.as_path(), NodeSource::Environment));
        assert_eq!(node.version(), Some(NodeVersion::new(24, 18, 0)));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn an_old_node_on_path_falls_back_to_the_newest_nvm_version() {
        let dir = scratch("nvm");
        let path_node = dir.join("bin/node");
        fake_node(&path_node, "v22.17.0");
        let nvm = dir.join("nvm");
        for version in ["v22.17.0", "v24.18.0", "v26.5.0", "v27.0.0"] {
            fake_node(&nvm.join("versions/node").join(version).join("bin/node"), version);
        }
        // An installation without a binary does not count.
        fs::remove_file(nvm.join("versions/node/v27.0.0/bin/node")).expect("remove");
        let lookup = NodeLookup {
            path: Some(std::env::join_paths([dir.join("empty"), dir.join("bin")]).expect("PATH")),
            nvm_dir: Some(nvm.clone()),
            ..NodeLookup::default()
        };
        let node = block_on(NodeRuntime::discover_in(&lookup)).expect("nvm");
        assert_eq!(node.source(), NodeSource::Nvm);
        assert_eq!(node.version(), Some(NodeVersion::new(26, 5, 0)));
        assert_eq!(node.path(), nvm.join("versions/node/v26.5.0/bin/node"));

        // A new enough node on PATH wins over nvm.
        fake_node(&path_node, "v24.19.0");
        let node = block_on(NodeRuntime::discover_in(&lookup)).expect("PATH");
        assert_eq!((node.path(), node.source()), (path_node.as_path(), NodeSource::Path));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn no_node_lists_every_place_searched() {
        let dir = scratch("none");
        let lookup = NodeLookup {
            path: Some(dir.join("empty").into()),
            home: Some(dir.clone()),
            ..NodeLookup::default()
        };
        let error = block_on(NodeRuntime::discover_in(&lookup)).expect_err("none");
        let text = error.to_string();
        assert!(text.contains("set MAKA_NODE"), "{text}");
        assert!(text.contains("node on PATH: not found"), "{text}");
        assert!(text.contains(&dir.join(".nvm/versions/node").display().to_string()), "{text}");
        fs::remove_dir_all(dir).ok();
    }
}
