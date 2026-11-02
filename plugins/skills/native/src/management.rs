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

use super::*;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::Dir;
use maka_capabilities::filesystem::entries::{self, Operation};
use maka_event_log::root::{FileLease, RootOwner};
use maka_skills::LocationId;
use std::{io, path::Path};
use tokio_util::sync::CancellationToken;

pub(super) struct Managed {
    root: Arc<RootOwner>,
    pub registrations: registrations::Registrations,
}
impl Managed {
    pub fn open(root: Arc<RootOwner>, log: Arc<maka_event_log::RootStore>) -> Arc<Self> {
        Arc::new(Self {
            root,
            registrations: registrations::Registrations::new(log),
        })
    }
    pub fn execution_basis(&self) -> Option<Value> {
        serde_json::to_value(self.root.root_id()).ok()
    }
    async fn route(&self) -> Result<maka_network::Policy, String> {
        let store = maka_config::ConfigurationStore::for_root(self.root.clone())
            .await
            .map_err(|error| error.to_string())?;
        let configuration = store.network_configuration().await;
        let closed = store.close().await;
        let configuration = configuration.map_err(|error| error.to_string())?;
        closed.map_err(|error| error.to_string())?;
        maka_network::Policy::from_host_settings(
            &configuration.proxy,
            configuration.password.as_deref(),
        )
        .map_err(|error| error.to_string())
    }
    fn lock(&self) -> Result<FileLease, String> {
        self.root
            .validate_current()
            .map_err(|error| error.to_string())?;
        FileLease::acquire(&self.root.canonical_path().join("skills-management.lock"))
            .map_err(|error| format!("Cannot acquire skill management lock: {error}"))
    }
}

fn child(parent: &Dir, name: &str) -> Result<Dir, String> {
    match parent.create_dir(name) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.to_string()),
    }
    parent
        .open_dir_nofollow(name)
        .map_err(|error| error.to_string())
}
fn rename(root: &Dir, from: String, to: String) -> Result<(), String> {
    entries::execute(
        root,
        Operation::Rename { from, to },
        &CancellationToken::new(),
        None,
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

struct Stage {
    parent: Dir,
    name: String,
    directory: Dir,
    preserve: std::cell::Cell<bool>,
}
impl Stage {
    fn new(source: &CapturedSource) -> Result<Self, String> {
        let location = source
            .location
            .ok_or("This skill collection is read only")?;
        let parent = child(
            source.handle.as_ref().ok_or("Skill target unavailable")?,
            location.configuration_directory(),
        )?;
        let name = format!(".skills-{}", uuid::Uuid::new_v4());
        parent
            .create_dir(&name)
            .map_err(|error| error.to_string())?;
        let directory = parent
            .open_dir_nofollow(&name)
            .map_err(|error| error.to_string())?;
        child(&parent, "skills")?;
        Ok(Self {
            parent,
            name,
            directory,
            preserve: std::cell::Cell::new(false),
        })
    }
    fn publish(&self, id: &str, replace: bool) -> Result<(), String> {
        let target = format!("skills/{id}");
        let old = format!("{}/old", self.name);
        let next = format!("{}/next", self.name);
        let previous = match self.parent.symlink_metadata(&target) {
            Ok(metadata) => {
                if !replace {
                    return Err("A skill already exists at this location".into());
                }
                if !metadata.is_dir() || metadata.is_symlink() {
                    return Err("Skill target must be an ordinary directory".into());
                }
                self.preserve.set(true);
                rename(&self.parent, target.clone(), old.clone()).map_err(|error| {
                    format!("{error}; prepared directories retained under {}", self.name)
                })?;
                true
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.to_string()),
        };
        if let Err(error) = rename(&self.parent, next, target.clone()) {
            if previous && let Err(rollback) = rename(&self.parent, old.clone(), target) {
                self.preserve.set(true);
                return Err(format!(
                    "{error}; restoring previous skill failed: {rollback}; previous directory retained at {old}"
                ));
            }
            self.preserve.set(false);
            return Err(error);
        }
        Ok(())
    }
    fn cleanup(&self) -> Result<(), String> {
        self.parent.remove_dir_all(&self.name).map_err(|error| {
            format!(
                "Skill files changed, but temporary directory {} could not be removed: {error}",
                self.name
            )
        })?;
        self.preserve.set(false);
        Ok(())
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        if !self.preserve.get() {
            let _ = self.parent.remove_dir_all(&self.name);
        }
    }
}

fn open_source(
    root: &Dir,
    base: &Path,
    directory: &str,
    private: &Path,
    target: &CapturedSource,
) -> Result<Dir, String> {
    let relative = remote::relative(directory)?;
    let relative = if relative.as_os_str().is_empty() {
        Path::new(".")
    } else {
        &relative
    };
    let resolved = base.join(
        root.canonicalize(relative)
            .map_err(|error| error.to_string())?,
    );
    if resolved.starts_with(private) || private.starts_with(&resolved) {
        return Err("Skill source overlaps private Host data".into());
    }
    if Path::new(&target.metadata.path).starts_with(&resolved) {
        return Err("A skill cannot be installed inside its source directory".into());
    }
    root.open_dir(relative).map_err(|error| error.to_string())
}
fn nested(root: &Dir, path: &Path) -> Result<Dir, String> {
    let mut directory = root.try_clone().map_err(|error| error.to_string())?;
    for name in path.iter() {
        directory = directory
            .open_dir_nofollow(name)
            .map_err(|error| error.to_string())?;
    }
    Ok(directory)
}

fn copy_tree(source: &Dir, target: &Dir, cancellation: &CancellationToken) -> Result<(), String> {
    let mut pending = vec![PathBuf::new()];
    while let Some(path) = pending.pop() {
        let source = nested(source, &path)?;
        let target = nested(target, &path)?;
        for entry in source.entries().map_err(|error| error.to_string())? {
            if cancellation.is_cancelled() {
                return Err("Skill installation cancelled".into());
            }
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name();
            if name == ".git" {
                continue;
            }
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            if kind.is_dir() {
                target
                    .create_dir(&name)
                    .map_err(|error| error.to_string())?;
                pending.push(path.join(name));
            } else if kind.is_file() {
                let mut options = cap_std::fs::OpenOptions::new();
                options.read(true).follow(FollowSymlinks::No);
                #[cfg(unix)]
                {
                    use cap_std::fs::OpenOptionsExt;
                    options.custom_flags(libc::O_NONBLOCK);
                }
                let mut input = source
                    .open_with(&name, &options)
                    .map_err(|error| error.to_string())?;
                let metadata = input.metadata().map_err(|error| error.to_string())?;
                if !metadata.is_file() {
                    return Err("Skill resources must be ordinary files or directories".into());
                }
                let mut output = target
                    .open_with(
                        &name,
                        cap_std::fs::OpenOptions::new().write(true).create_new(true),
                    )
                    .map_err(|error| error.to_string())?;
                io::copy(&mut input, &mut output).map_err(|error| error.to_string())?;
                #[cfg(unix)]
                {
                    use cap_std::fs::PermissionsExt;
                    output
                        .set_permissions(cap_std::fs::Permissions::from_mode(
                            metadata.permissions().mode() & 0o777,
                        ))
                        .map_err(|error| error.to_string())?;
                }
            } else {
                return Err(format!(
                    "Skill resources cannot contain links or special files: {}",
                    name.to_string_lossy()
                ));
            }
        }
    }
    Ok(())
}

impl Library {
    /// The blocking worker owns all filesystem work and cleanup, even if its caller leaves.
    async fn management_work<T: Send + 'static>(
        &self,
        scope: &Scope,
        work: impl FnOnce(Self, Arc<Managed>, Scope, tokio::runtime::Handle) -> Result<T, String>
        + Send
        + 'static,
    ) -> Result<T, String> {
        let managed = self.managed.clone().ok_or("Skill management is disabled")?;
        let library = self.clone();
        let scope = scope.clone();
        let runtime = tokio::runtime::Handle::current();
        let mut ticket = scope
            .resources
            .reserve()
            .map_err(|error| error.to_string())?;
        tokio::task::spawn_blocking(move || {
            ticket.start();
            let result = if scope.cancellation.is_cancelled() {
                Err("Skill management cancelled".into())
            } else {
                work(library, managed, scope, runtime)
            };
            ticket.complete(Ok(()));
            result
        })
        .await
        .map_err(|error| error.to_string())?
    }
    pub(super) async fn discover_source(
        &self,
        input: DiscoverSource,
        scope: &Scope,
    ) -> Result<DiscoveredSource, String> {
        self.management_work(scope, move |library, managed, scope, runtime| {
            let base = input
                .workspace
                .map(|workspace| PathBuf::from(workspace.path))
                .or_else(|| {
                    library
                        .sources
                        .iter()
                        .find(|source| source.location == Some(LocationId::UserMaka))
                        .and_then(|source| {
                            Path::new(&source.metadata.path)
                                .parent()?
                                .parent()
                                .map(Path::to_owned)
                        })
                })
                .ok_or("No Host source directory is configured")?;
            let mut source = input.source.trim().to_owned();
            if source == "~" || source.starts_with("~/") {
                let home = library
                    .sources
                    .iter()
                    .find(|source| source.location == Some(LocationId::UserMaka))
                    .and_then(|source| Path::new(&source.metadata.path).parent()?.parent())
                    .ok_or("No Host home directory is configured")?;
                source = home
                    .join(source.strip_prefix("~/").unwrap_or(""))
                    .to_string_lossy()
                    .into_owned();
            }
            let local = base.join(&source);
            if local
                .canonicalize()
                .is_ok_and(|path| path.starts_with(&library.private))
            {
                return Err("The private Host directory cannot be a skill source".into());
            }
            let route = runtime.block_on(managed.route())?;
            runtime.block_on(remote::Checkout::discover(
                &source,
                &base,
                &library.private,
                &route,
                &scope,
            ))
        })
        .await
    }
    fn target(&self, location: LocationId) -> Result<&CapturedSource, String> {
        self.sources
            .iter()
            .find(|source| source.location == Some(location))
            .ok_or_else(|| "The selected skill location is unavailable".into())
    }
    pub(super) async fn install(
        &self,
        input: Install,
        scope: &Scope,
    ) -> Result<InstallResult, String> {
        self.management_work(scope, move |library, managed, scope, runtime| {
            let target = library.target(input.location)?;
            let route = runtime.block_on(managed.route())?;
            let checkout =
                runtime.block_on(remote::Checkout::open(input.source, false, &route, &scope))?;
            if checkout.root.starts_with(&library.private) {
                return Err("The private Host directory cannot be a skill source".into());
            }
            let root = Dir::open_ambient_dir(&checkout.root, cap_std::ambient_authority())
                .map_err(|error| error.to_string())?;
            let mut results = Vec::new();
            for directory in input.skills {
                let result = (|| {
                    let source =
                        open_source(&root, &checkout.root, &directory, &library.private, target)?;
                    let document = maka_skills::parse(
                        &remote::read_manifest(&source).map_err(|error| error.to_string())?,
                    )
                    .map_err(|_| "Invalid SKILL.md")?;
                    let id = document.manifest.name;
                    if id.is_empty()
                        || Path::new(&id).components().count() != 1
                        || !matches!(
                            Path::new(&id).components().next(),
                            Some(std::path::Component::Normal(_))
                        )
                    {
                        return Err("Skill name must be a directory name".into());
                    }
                    let stage = Stage::new(target)?;
                    let next = child(&stage.directory, "next")?;
                    copy_tree(&source, &next, &scope.cancellation)?;
                    let _lock = managed.lock()?;
                    if scope.cancellation.is_cancelled() {
                        return Err("Skill installation cancelled".into());
                    }
                    let path = Path::new(&target.metadata.path)
                        .join(&id)
                        .to_string_lossy()
                        .into_owned();
                    let current = runtime.block_on(managed.registrations.read(&path))?;
                    stage.publish(&id, false)?;
                    let recorded = runtime.block_on(managed.registrations.write(
                        &path,
                        current.revision,
                        Some(Installation {
                            source: checkout.source.clone(),
                            directory: directory.clone(),
                        }),
                    ));
                    stage.cleanup()?;
                    recorded.map_err(|error| {
                        format!("Skill installed, but recording its source failed: {error}")
                    })?;
                    Ok(format!("{}:{id}", target.prefix))
                })();
                results.push(match result {
                    Ok(reference) => InstallOutcome::Installed { reference },
                    Err(reason) => InstallOutcome::Rejected { directory, reason },
                });
            }
            Ok(InstallResult { results })
        })
        .await
    }
    pub(super) async fn manage_skill(
        &self,
        input: ManageSkill,
        update: bool,
        scope: &Scope,
    ) -> Result<ChangeResult, String> {
        self.management_work(scope, move |library, managed, scope, runtime| {
            let result = (|| {
                let target = library
                    .sources
                    .iter()
                    .find(|source| source.location.is_some() && source.contains(&input.reference))
                    .ok_or("This skill collection is read only")?;
                let id = input
                    .reference
                    .strip_prefix(&format!("{}:", target.prefix))
                    .ok_or("Invalid skill reference")?;
                if id.is_empty()
                    || Path::new(id).components().count() != 1
                    || !matches!(
                        Path::new(id).components().next(),
                        Some(std::path::Component::Normal(_))
                    )
                {
                    return Err("Invalid skill reference".into());
                }
                let path = Path::new(&target.metadata.path)
                    .join(id)
                    .to_string_lossy()
                    .into_owned();
                let current = runtime.block_on(managed.registrations.read(&path))?;
                let prepared = if update {
                    let installation = current
                        .installation
                        .ok_or("Only skills installed by Maka can be updated")?;
                    let route = runtime.block_on(managed.route())?;
                    let checkout = runtime.block_on(remote::Checkout::open(
                        installation.source,
                        true,
                        &route,
                        &scope,
                    ))?;
                    if checkout.root.starts_with(&library.private) {
                        return Err("The private Host directory cannot be a skill source".into());
                    }
                    let root = Dir::open_ambient_dir(&checkout.root, cap_std::ambient_authority())
                        .map_err(|error| error.to_string())?;
                    let source = open_source(
                        &root,
                        &checkout.root,
                        &installation.directory,
                        &library.private,
                        target,
                    )?;
                    maka_skills::parse(
                        &remote::read_manifest(&source).map_err(|error| error.to_string())?,
                    )
                    .map_err(|_| "Invalid SKILL.md")?;
                    let stage = Stage::new(target)?;
                    copy_tree(
                        &source,
                        &child(&stage.directory, "next")?,
                        &scope.cancellation,
                    )?;
                    (
                        stage,
                        Some(Installation {
                            source: checkout.source.clone(),
                            directory: installation.directory,
                        }),
                    )
                } else {
                    (Stage::new(target)?, None)
                };
                let (stage, installation) = prepared;
                let _lock = managed.lock()?;
                if scope.cancellation.is_cancelled() {
                    return Err("Skill management cancelled".into());
                }
                let observed = runtime.block_on(managed.registrations.read(&path))?;
                if observed.revision != current.revision {
                    return Err(
                        "Skill changed while preparing this operation; refresh and try again"
                            .into(),
                    );
                }
                if update {
                    stage.publish(id, true)?;
                } else {
                    stage.preserve.set(true);
                    rename(
                        &stage.parent,
                        format!("skills/{id}"),
                        format!("{}/old", stage.name),
                    )?;
                }
                let recorded = runtime.block_on(managed.registrations.write(
                    &path,
                    current.revision,
                    installation,
                ));
                stage.cleanup()?;
                recorded.map_err(|error| {
                    format!("Skill files changed, but recording the change failed: {error}")
                })?;
                Ok(())
            })();
            Ok(match result {
                Ok(()) => ChangeResult::Applied {
                    reference: input.reference,
                },
                Err(reason) => ChangeResult::Rejected { reason },
            })
        })
        .await
    }
}

#[cfg(test)]
mod tests;
