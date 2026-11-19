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

use cap_fs_ext::DirExt;
use cap_std::{ambient_authority, fs::Dir};
use std::{
    ffi::OsString,
    io,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

/// All resolution stays on captured handles, including absolute in-root links.
/// Ambient names are only aliases: replacing them never replaces our authority.
#[derive(Clone)]
pub(super) struct Directory {
    parents: Vec<Arc<Dir>>,
    names: Vec<OsString>,
    aliases: Arc<[PathBuf; 2]>,
    policy: Option<Arc<maka_sandbox::filesystem::Compiled>>,
}

impl Directory {
    pub(super) fn from_handle(directory: Dir, path: PathBuf) -> Self {
        Self {
            parents: vec![Arc::new(directory)],
            names: Vec::new(),
            aliases: Arc::new([path.clone(), path]),
            policy: None,
        }
    }

    pub(super) fn execution_basis(&self) -> io::Result<serde_json::Value> {
        let identities = self
            .parents
            .iter()
            .map(|directory| maka_sandbox::workspace::DirectoryIdentity::execution_basis(directory))
            .collect::<io::Result<Vec<_>>>()?;
        // Aliases and policy affect link resolution. Observe held handles, never
        // the directory currently occupying one of those ambient names.
        serde_json::to_value((
            identities,
            &self.names,
            &self.aliases,
            self.policy.as_ref().map(|policy| policy.policy()),
        ))
        .map_err(io::Error::other)
    }

    pub(super) fn path(&self) -> &Path {
        &self.aliases[1]
    }

    pub(super) fn capture(path: &Path) -> io::Result<Self> {
        let canonical = path.canonicalize()?;
        let root = Dir::open_ambient_dir(&canonical, ambient_authority())?;
        Ok(Self {
            parents: vec![Arc::new(root)],
            names: Vec::new(),
            aliases: Arc::new([canonical, path.to_owned()]),
            policy: None,
        })
    }

    pub(super) fn restrict(
        mut self,
        policy: Arc<maka_sandbox::filesystem::Compiled>,
    ) -> Result<Self, crate::Error> {
        self.policy = Some(match &self.policy {
            Some(current) => Arc::new(
                current
                    .intersect(&policy)
                    .map_err(|error| crate::Error::Invalid(error.to_string()))?,
            ),
            None => policy,
        });
        Ok(self)
    }

    pub(super) fn readable(&self, name: &Path) -> bool {
        self.policy.is_none() || self.resolve(name, true).is_ok()
    }

    fn check_name(&self, name: &Path) -> io::Result<()> {
        let Some(policy) = &self.policy else {
            return Ok(());
        };
        let relative = self.relative(name);
        let path: PathBuf = self.aliases[0].join(&relative).components().collect();
        if policy.access(dunce::simplified(&path)).can_read() {
            Ok(())
        } else {
            Err(blocked())
        }
    }

    fn check_resolved(&self, name: &Path) -> io::Result<()> {
        self.check_name(name)?;
        let Some(policy) = &self.policy else {
            return Ok(());
        };
        // Links have already been resolved on held handles. Expand alternate
        // spellings (notably Windows short names) before checking the target.
        let relative = self.relative(name);
        let resolved = self.parents[0].canonicalize(if relative.as_os_str().is_empty() {
            Path::new(".")
        } else {
            &relative
        })?;
        let path: PathBuf = self.aliases[0].join(resolved).components().collect();
        if policy.access(dunce::simplified(&path)).can_read() {
            Ok(())
        } else {
            Err(blocked())
        }
    }

    pub(super) fn dir(&self) -> &Dir {
        self.parents.last().expect("captured root remains present")
    }

    pub(super) fn relative(&self, name: &Path) -> PathBuf {
        self.names.iter().collect::<PathBuf>().join(name)
    }

    pub(super) fn open(&self, path: &Path, follow: bool) -> io::Result<Self> {
        if path.as_os_str().is_empty() {
            self.check_resolved(Path::new(""))?;
            return Ok(self.clone());
        }
        let (mut parent, name) = self.resolve(path, follow)?;
        parent
            .parents
            .push(Arc::new(parent.dir().open_dir_nofollow(&name)?));
        if name != "." {
            parent.names.push(name);
        }
        Ok(parent)
    }

    /// Resolve the final name without following it at the subsequent open.
    /// Nofollow opens close the metadata/open race if a link is replaced.
    pub(super) fn resolve(&self, path: &Path, follow: bool) -> io::Result<(Self, OsString)> {
        self.check_name(path)?;
        let mut directory = self.clone();
        let mut pending = without_dots(path);
        if pending.as_os_str().is_empty() {
            directory.check_resolved(Path::new(""))?;
            return Ok((directory, OsString::from(".")));
        }
        let mut links = 0;
        loop {
            let mut components = pending.components();
            let component = components.next().ok_or_else(blocked)?;
            let remaining = without_dots(components.as_path());
            match component {
                Component::Normal(name) => {
                    let kind = directory.dir().symlink_metadata(name)?.file_type();
                    if kind.is_symlink() {
                        if !follow && remaining.as_os_str().is_empty() {
                            return Err(blocked());
                        }
                        links += 1;
                        if links > 40 {
                            return Err(blocked());
                        }
                        let target = directory.dir().read_link_contents(name)?;
                        let target = if target.is_absolute() {
                            let relative = directory
                                .aliases
                                .iter()
                                .find_map(|root| target.strip_prefix(root).ok())
                                .ok_or_else(blocked)?
                                .to_owned();
                            directory.parents.truncate(1);
                            directory.names.clear();
                            relative
                        } else {
                            target
                        };
                        pending = without_dots(&target.join(remaining));
                        if pending.as_os_str().is_empty() {
                            directory.check_resolved(Path::new(""))?;
                            return Ok((directory, OsString::from(".")));
                        }
                        continue;
                    }
                    if remaining.as_os_str().is_empty() {
                        directory.check_resolved(Path::new(name))?;
                        return Ok((directory, name.to_owned()));
                    }
                    directory
                        .parents
                        .push(Arc::new(directory.dir().open_dir_nofollow(name)?));
                    directory.names.push(name.to_owned());
                }
                Component::ParentDir if directory.parents.len() > 1 => {
                    directory.parents.pop();
                    directory.names.pop();
                }
                _ => return Err(blocked()),
            }
            pending = remaining;
            if pending.as_os_str().is_empty() {
                directory.check_resolved(Path::new(""))?;
                return Ok((directory, OsString::from(".")));
            }
        }
    }
}

fn without_dots(path: &Path) -> PathBuf {
    path.components()
        .filter(|part| !matches!(part, Component::CurDir))
        .collect()
}

fn blocked() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "path leaves its admitted directory or uses a forbidden link",
    )
}
