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

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, File, OpenOptions};
use maka_sandbox::filesystem::{Access, Compiled};
use std::{
    io,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

/// A held directory plus an optional immutable policy ceiling. Resolve aliases
/// through the capability, authorize the resolved name, then walk without
/// following links again. A symlink swap cannot redirect an authorized open.
pub(crate) struct Directory {
    pub(super) inner: Dir,
    path: PathBuf,
    policy: Option<Arc<Compiled>>,
}

impl Directory {
    pub(super) fn new(inner: Dir, path: PathBuf, policy: Option<Arc<Compiled>>) -> Self {
        Self {
            inner,
            path,
            policy,
        }
    }

    fn check(&self, relative: &Path, access: Access) -> io::Result<()> {
        let Some(policy) = &self.policy else {
            return Ok(());
        };
        let path: PathBuf = self.path.join(relative).components().collect();
        let actual = policy.access(dunce::simplified(&path));
        if actual.intersect(access) != access {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "filesystem policy denies {access:?} access to {}",
                    path.display()
                ),
            ));
        }
        Ok(())
    }

    fn resolve(&self, relative: &Path) -> io::Result<PathBuf> {
        // Parent components must retain real symlink/.. semantics; the canonical
        // capability path below is the authority for that spelling.
        if !relative
            .components()
            .any(|part| part == Component::ParentDir)
        {
            self.check(relative, Access::Read)?;
        }
        let resolved = self.inner.canonicalize(nonempty(relative))?;
        self.check(&resolved, Access::Read)?;
        Ok(resolved)
    }

    pub(crate) fn open_with(
        &self,
        relative: impl AsRef<Path>,
        options: &OpenOptions,
    ) -> io::Result<File> {
        let relative = relative.as_ref();
        if self.policy.is_none() {
            return self.inner.open_with(nonempty(relative), options);
        }
        let resolved = self.resolve(relative)?;
        self.open_resolved(&resolved, options)
    }

    fn open_resolved(&self, resolved: &Path, options: &OpenOptions) -> io::Result<File> {
        let (parent, name) = self.parent(resolved)?;
        parent.open_with(name, options.clone().follow(FollowSymlinks::No))
    }

    /// Writes already refuse every symlink and parent component. Retain the
    /// directory capability after authorizing the exact name, including missing
    /// targets; read-only metadata cannot be created or replaced through Write.
    pub(crate) fn authorize_write(self, relative: &Path) -> io::Result<(Dir, bool)> {
        self.check(relative, Access::Write)?;
        if self.policy.is_some() {
            let resolved = match self.inner.canonicalize(relative) {
                Ok(resolved) => resolved,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    let name = relative.file_name().ok_or_else(|| {
                        io::Error::new(io::ErrorKind::InvalidInput, "file basename required")
                    })?;
                    self.inner
                        .canonicalize(nonempty(relative.parent().unwrap_or(Path::new(""))))?
                        .join(name)
                }
                Err(error) => return Err(error),
            };
            self.check(&resolved, Access::Write)?;
        }
        Ok((self.inner, self.policy.is_some()))
    }

    fn parent(&self, relative: &Path) -> io::Result<(Dir, std::ffi::OsString)> {
        match relative.file_name() {
            Some(name) => Ok((
                walk(&self.inner, relative.parent().unwrap_or(Path::new("")))?,
                name.to_owned(),
            )),
            None => Ok((self.inner.try_clone()?, ".".into())),
        }
    }
}

fn nonempty(path: &Path) -> &Path {
    if path.as_os_str().is_empty() {
        Path::new(".")
    } else {
        path
    }
}

fn walk(root: &Dir, path: &Path) -> io::Result<Dir> {
    let mut directory = root.try_clone()?;
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::Normal(name) => directory = directory.open_dir_nofollow(name)?,
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "invalid resolved capability path",
                ));
            }
        }
    }
    Ok(directory)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use maka_sandbox::filesystem::{Policy, Rule};

    #[test]
    fn replacement_after_resolution_cannot_redirect_a_read_into_denied_data() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        for directory in ["public", "private"] {
            std::fs::create_dir(root.join(directory)).unwrap();
            std::fs::write(root.join(directory).join("file"), directory).unwrap();
        }
        let policy = Arc::new(
            Policy {
                default: Access::Read,
                rules: vec![Rule::subtree(root.join("private"), Access::Deny)],
                deny_globs: vec![],
            }
            .compile()
            .unwrap(),
        );
        let directory = Directory::new(
            Dir::open_ambient_dir(&root, cap_std::ambient_authority()).unwrap(),
            root.clone(),
            Some(policy),
        );
        let resolved = directory.resolve(Path::new("public/file")).unwrap();
        std::fs::rename(root.join("public"), root.join("original")).unwrap();
        std::os::unix::fs::symlink("private", root.join("public")).unwrap();
        assert!(
            directory
                .open_resolved(&resolved, OpenOptions::new().read(true))
                .is_err()
        );
        assert!(
            directory
                .open_with("public/file", OpenOptions::new().read(true))
                .is_err()
        );
    }
}
