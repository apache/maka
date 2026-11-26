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
use crate::isolated::{SnapshotFile, SnapshotKind, evidence, fs};
use std::{collections::BTreeSet, io::Seek};

impl HomeCapture {
    pub(in crate::isolated) fn from_resource(path: &Path) -> Result<Self, Error> {
        let resource = evidence::open_resource(path)?;
        let home = fs::directory(&resource, "home".as_ref())?;
        let mut initial = Vec::new();
        for name in crate::isolated::INITIAL_HOME_DIRECTORIES {
            let path = Path::new(name);
            initial.push((path.to_owned(), fs::open_relative(&home, path)?));
        }
        Ok(Self {
            input: Arc::new(HomeInput {
                resource,
                home,
                initial,
            }),
        })
    }
}

fn check_anchor(input: &HomeInput) -> Result<(), Error> {
    if fs::identity(&input.home)?
        != fs::identity(&fs::directory(&input.resource, "home".as_ref())?)?
    {
        return Err(Error::CaptureUnstable("home".into()));
    }
    Ok(())
}

pub(super) fn freeze(input: Arc<HomeInput>) -> Result<FrozenHome, Error> {
    let current = fs::directory(&input.resource, "home".as_ref())?;
    if fs::identity(&input.home)? != fs::identity(&current)? {
        return Err(Error::CaptureUnstable("home".into()));
    }
    let owner = fs::directory(&input.resource, "owner".as_ref())?;
    let closure: crate::isolated::Closure =
        evidence::read_json(evidence::open_regular(&owner, "closure.json")?)?;
    if !matches!(
        closure,
        crate::isolated::Closure::GroupClosed {
            original_group_closed: true,
            streams_drained: true,
            ..
        }
    ) {
        return Err(unsupported(
            "private HOME original group or streams are not closed",
        ));
    }
    let directory = fs::mkdir(
        &owner,
        format!("frozen-home-{}", uuid::Uuid::new_v4()).as_ref(),
    )?;
    let (entries, _) = fs::copy_tree(&current, &directory, |_| true)?;
    check_anchor(&input)?;
    Ok(FrozenHome {
        input,
        directory,
        entries: entries.into(),
    })
}

pub(super) fn entry(directory: &File, entry: &SnapshotFile) -> Result<HomeEntry, Error> {
    let file = fs::open_relative(directory, &entry.relative_path)?;
    if fs::identity(&file)? != entry.identity {
        return Err(Error::CaptureUnstable(entry.relative_path.clone()));
    }
    let kind = match entry.kind {
        SnapshotKind::File => HomeEntryKind::File { file },
        SnapshotKind::Directory => HomeEntryKind::Directory,
        SnapshotKind::Symlink { .. } => {
            return Err(unsupported("reparse points are not private HOME entries"));
        }
    };
    Ok(HomeEntry {
        relative_path: entry.relative_path.clone(),
        mode: entry.mode,
        kind,
    })
}

pub(super) fn seed(
    home: &HomeCapture,
    entries: impl IntoIterator<Item = Result<HomeEntry, Error>>,
) -> Result<(), Error> {
    let input = &home.input;
    check_anchor(input)?;
    let mut parents = vec![(PathBuf::new(), input.home.try_clone()?)];
    let mut observed = BTreeSet::new();
    while let Some((relative, directory)) = parents.pop() {
        for name in fs::names(&directory)? {
            let path = relative.join(&name);
            let (_, expected) = input
                .initial
                .iter()
                .find(|(p, _)| p == &path)
                .ok_or_else(|| unsupported("private HOME contains a non-initial entry"))?;
            let child = fs::directory(&directory, &name)?;
            if fs::identity(&child)? != fs::identity(expected)? {
                return Err(Error::CaptureUnstable(path));
            }
            observed.insert(path.clone());
            parents.push((path, child));
        }
    }
    if observed.len() != input.initial.len() {
        return Err(Error::CaptureUnstable("home".into()));
    }
    for entry in entries {
        let entry = entry?;
        valid_path(&entry.relative_path)?;
        valid_mode(entry.mode)?;
        let path = &entry.relative_path;
        let directory =
            fs::open_relative(&input.home, path.parent().expect("normalized HOME path"))?;
        let name = path.file_name().expect("normalized HOME entry");
        match entry.kind {
            HomeEntryKind::Directory if observed.remove(path) => {
                let held = &input
                    .initial
                    .iter()
                    .find(|(p, _)| p == path)
                    .expect("initial HOME directory")
                    .1;
                if fs::identity(held)? != fs::identity(&fs::directory(&directory, name)?)? {
                    return Err(Error::CaptureUnstable(path.clone()));
                }
            }
            HomeEntryKind::Directory => {
                fs::create_entry(&directory, name, true)?;
            }
            HomeEntryKind::File { mut file } => {
                if !fs::read_only_backing(&file)? {
                    return Err(unsupported("expected read-only regular HOME backing file"));
                }
                file.rewind()?;
                let mut output = fs::create_entry(&directory, name, false)?;
                io::copy(&mut file, &mut output)?;
                if entry.mode & 0o222 == 0 {
                    let mut permissions = output.metadata()?.permissions();
                    permissions.set_readonly(true);
                    output.set_permissions(permissions)?;
                }
            }
            HomeEntryKind::Symlink { .. } => {
                return Err(unsupported("Windows private HOME refuses reparse points"));
            }
        }
    }
    check_anchor(input)
}
