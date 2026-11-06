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

//! A published directory is a stable filesystem observation, not a string prefix.
use super::{Workspace, invalid};
use cap_std::{ambient_authority, fs::Dir};
use maka_agent_facts::execution::DirectoryIdentity;
use std::{
    io,
    path::{Component, Path, PathBuf},
};

pub struct PublishedDirectory {
    path: PathBuf,
    identity: DirectoryIdentity,
}

impl PublishedDirectory {
    pub fn open(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(invalid("published root must be absolute"));
        }
        let (path, identity) = crate::directory::capture(path)?;
        Ok(Self { path, identity })
    }

    pub fn identity(&self) -> io::Result<DirectoryIdentity> {
        Ok(self.identity.clone())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn validate_root(&self) -> io::Result<Dir> {
        let visible = Dir::open_ambient_dir(&self.path, ambient_authority())?;
        if crate::directory::identity(&visible)? != self.identity {
            return Err(invalid("workspace directory changed"));
        }
        Ok(visible)
    }

    pub fn resolve(&self, segments: &[String]) -> io::Result<PathBuf> {
        let mut path = self.path.clone();
        for segment in segments {
            if segment.is_empty()
                || segment.contains(['/', '\\', '\0'])
                || !matches!(
                    Path::new(segment).components().next(),
                    Some(Component::Normal(_))
                )
                || Path::new(segment).components().count() != 1
            {
                return Err(invalid("invalid published directory segment"));
            }
            path.push(segment);
        }
        self.contained(&path)
    }

    pub fn validate(&self, path: &Path) -> io::Result<()> {
        self.contained(path).map(|_| ())
    }

    fn contained(&self, path: &Path) -> io::Result<PathBuf> {
        let _root = self.validate_root()?;
        let path = path.canonicalize()?;
        if !path.starts_with(&self.path) || !path.is_dir() {
            return Err(invalid(
                "directory is outside the published root or unavailable",
            ));
        }
        self.validate_root()?;
        Ok(path)
    }

    /// Names use UTF-16 order because they also act as client continuation cursors.
    pub fn directory_names(&self, segments: &[String]) -> io::Result<Vec<String>> {
        let _root = self.validate_root()?;
        let directory = Workspace::capture(&self.resolve(segments)?)?;
        let mut names = Vec::new();
        for entry in directory.dir.entries()? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if !kind.is_dir() && !kind.is_symlink() {
                continue;
            }
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            // The wire format addresses only UTF-8 single-segment names.
            if name.contains(['/', '\\', '\0']) {
                continue;
            }
            if self.contained(&directory.path.join(&name)).is_ok() {
                names.push(name);
            }
        }
        directory.validate_directory()?;
        self.validate_root()?;
        names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        Ok(names)
    }
}
