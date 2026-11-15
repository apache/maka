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

//! Short-lived live-mount directory observations for single operations and cursors.
use cap_fs_ext::MetadataExt;
use cap_std::{ambient_authority, fs::Dir};
use serde::{Deserialize, Serialize};
use std::{
    io,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(try_from = "String", into = "String")]
#[schemars(with = "String")]
pub struct Observation(String);

impl Observation {
    pub fn matches(&self, directory: &Dir) -> io::Result<bool> {
        Ok(&identity(directory)? == self)
    }
}

impl TryFrom<String> for Observation {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.strip_prefix("sha256:").is_none_or(|hex| {
            hex.len() != 64
                || !hex
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }) {
            return Err("invalid directory observation");
        }
        Ok(Self(value))
    }
}

impl From<Observation> for String {
    fn from(observation: Observation) -> Self {
        observation.0
    }
}

pub fn capture(path: &Path) -> io::Result<(PathBuf, Observation)> {
    let (path, _directory, observed) = capture_directory(path)?;
    Ok((path, observed))
}

pub fn capture_directory(path: &Path) -> io::Result<(PathBuf, Dir, Observation)> {
    let path = path.canonicalize()?;
    let directory = Dir::open_ambient_dir(&path, ambient_authority())?;
    let observed = identity(&directory)?;
    if path.canonicalize()? != path {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "authorized directory was replaced",
        ));
    }
    open(&path, &observed)?;
    Ok((path, directory, observed))
}

pub fn open(path: &Path, expected: &Observation) -> io::Result<Dir> {
    let directory = Dir::open_ambient_dir(path, ambient_authority())?;
    if !expected.matches(&directory)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "authorized directory was replaced",
        ));
    }
    Ok(directory)
}

/// Identify the held directory on its current mount without reopening its ambient pathname.
pub fn identity(directory: &Dir) -> io::Result<Observation> {
    let metadata = directory.dir_metadata()?;
    let birth = metadata
        .created()
        .ok()
        .and_then(|time| time.into_std().duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| (duration.as_secs(), duration.subsec_nanos()));
    let bytes =
        serde_json::to_vec(&(metadata.dev(), metadata.ino(), birth)).map_err(io::Error::other)?;
    Observation::try_from(maka_agent_facts::artifact::content_digest(&bytes))
        .map_err(io::Error::other)
}
