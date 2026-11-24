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

use super::{SHARE, directory, identity, open_at};
use crate::isolated::{Error, FileIdentity, SnapshotFile, SnapshotKind};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    fs::File,
    io::{self, Read},
    os::windows::io::AsRawHandle,
    path::{Path, PathBuf},
    ptr,
};
use windows_sys::{
    Wdk::Storage::FileSystem as nt,
    Win32::{
        Foundation::{GENERIC_READ, GENERIC_WRITE},
        Storage::FileSystem::*,
    },
};

#[derive(PartialEq, Eq)]
struct Observation {
    id: FileIdentity,
    attributes: u32,
    changed: i64,
    modified: i64,
    size: u64,
}

fn observe(file: &File) -> io::Result<Observation> {
    let mut info = FILE_BASIC_INFO::default();
    // SAFETY: a synchronous information query on the held object with the matching record.
    crate::windows::checked(unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileBasicInfo,
            ptr::from_mut(&mut info).cast(),
            size_of::<FILE_BASIC_INFO>() as u32,
        )
    })?;
    Ok(Observation {
        id: identity(file)?,
        attributes: info.FileAttributes,
        changed: info.ChangeTime,
        modified: info.LastWriteTime,
        size: file.metadata()?.len(),
    })
}

fn changed(path: &Path, error: io::Error) -> Error {
    if matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory | io::ErrorKind::InvalidData
    ) || error.raw_os_error()
        == Some(windows_sys::Win32::Foundation::ERROR_SHARING_VIOLATION as i32)
    {
        Error::CaptureUnstable(path.into())
    } else {
        Error::Io(error)
    }
}

pub(in crate::isolated) fn open_relative(root: &File, relative: &Path) -> io::Result<File> {
    let mut file = root.try_clone()?;
    for component in relative.components() {
        file = open_at(
            &file,
            component.as_os_str(),
            GENERIC_READ,
            nt::FILE_OPEN,
            0,
            None,
            SHARE,
        )?;
    }
    Ok(file)
}

fn inventory(
    root: &File,
    allow: &impl Fn(&Path) -> bool,
) -> Result<BTreeMap<PathBuf, Observation>, Error> {
    fn walk(
        dir: &File,
        path: &Path,
        allow: &impl Fn(&Path) -> bool,
        entries: &mut BTreeMap<PathBuf, Observation>,
    ) -> Result<(), Error> {
        let original = observe(dir)?;
        for name in super::names(dir)? {
            let path = path.join(&name);
            if !allow(&path) {
                continue;
            }
            let file = open_at(dir, &name, GENERIC_READ, nt::FILE_OPEN, 0, None, SHARE)
                .map_err(|e| changed(&path, e))?;
            if file.metadata()?.is_dir() {
                walk(&file, &path, allow, entries)?;
            } else {
                let info = observe(&file)?;
                if entries.insert(path.clone(), info).is_some() {
                    return Err(Error::CaptureUnstable(path));
                }
            }
        }
        if observe(dir)? != original || entries.insert(path.into(), original).is_some() {
            return Err(Error::CaptureUnstable(path.into()));
        }
        Ok(())
    }
    let mut entries = BTreeMap::new();
    walk(root, Path::new(""), allow, &mut entries)?;
    Ok(entries)
}

/// Independent ordinary files. Inherit the destination directory's ACL so
/// the working tree remains usable by the execution account after capture.
pub(in crate::isolated) fn create_entry(
    dir: &File,
    name: &OsStr,
    is_dir: bool,
) -> io::Result<File> {
    let (access, options) = if is_dir {
        (GENERIC_READ, nt::FILE_DIRECTORY_FILE)
    } else {
        (GENERIC_READ | GENERIC_WRITE, nt::FILE_NON_DIRECTORY_FILE)
    };
    open_at(dir, name, access, nt::FILE_CREATE, options, None, SHARE)
}

pub(in crate::isolated) fn copy_tree(
    source: &File,
    destination: &File,
    allow: impl Fn(&Path) -> bool,
) -> Result<(Vec<SnapshotFile>, u64), Error> {
    let before = inventory(source, &allow)?;
    let mut entries = Vec::with_capacity(before.len().saturating_sub(1));
    let mut bytes = 0;
    for (relative, original) in &before {
        let Some(name) = relative.file_name() else {
            continue;
        };
        let parent_path = relative.parent().expect("tree entry");
        let mut parent = source.try_clone()?;
        let mut path = PathBuf::new();
        for component in parent_path.components() {
            path.push(component.as_os_str());
            parent = directory(&parent, component.as_os_str()).map_err(|e| changed(&path, e))?;
            if before.get(&path) != Some(&observe(&parent)?) {
                return Err(Error::CaptureUnstable(path));
            }
        }
        // A copy cannot overlap an ordinary writer, even if last-write timestamps
        // are deferred until its write handle closes.
        let file = open_at(
            &parent,
            name,
            GENERIC_READ,
            nt::FILE_OPEN,
            0,
            None,
            FILE_SHARE_READ,
        )
        .map_err(|e| changed(relative, e))?;
        if &observe(&file)? != original {
            return Err(Error::CaptureUnstable(relative.clone()));
        }
        let is_dir = file.metadata()?.is_dir();
        let target = open_relative(destination, parent_path)?;
        let mut output = create_entry(&target, name, is_dir)?;
        let (kind, mode) = if is_dir {
            (SnapshotKind::Directory, 0o700)
        } else {
            let n = io::copy(&mut (&file).take(original.size), &mut output)?;
            if n != original.size {
                return Err(Error::CaptureUnstable(relative.clone()));
            }
            bytes += n;
            let readonly = original.attributes & FILE_ATTRIBUTE_READONLY != 0;
            if readonly {
                let mut permissions = output.metadata()?.permissions();
                permissions.set_readonly(true);
                output.set_permissions(permissions)?;
            }
            (SnapshotKind::File, if readonly { 0o400 } else { 0o600 })
        };
        if &observe(&file)? != original {
            return Err(Error::CaptureUnstable(relative.clone()));
        }
        entries.push(SnapshotFile {
            relative_path: relative.clone(),
            mode,
            kind,
            identity: identity(&output)?,
        });
    }
    let after = inventory(source, &allow)?;
    if before != after {
        let path = before
            .keys()
            .chain(after.keys())
            .find(|p| before.get(*p) != after.get(*p))
            .expect("different inventories");
        return Err(Error::CaptureUnstable(path.clone()));
    }
    Ok((entries, bytes))
}
