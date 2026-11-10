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

use super::Error;
use std::{fs::File, path::PathBuf};
#[cfg(target_os = "macos")]
use {
    super::candidate::{
        Observation, ObservedKind, capture_error, directory_at, ensure, observe_at, observe_file,
    },
    rustix::fs::{Mode, OFlags, fchmod, openat},
    serde::{Deserialize, Serialize},
    std::{
        ffi::OsStr,
        io::{self, BufReader, BufWriter, Seek, Write},
        path::{Component, Path},
        sync::Arc,
    },
};

/// Custody of the HOME created by this original owner, never host HOME or a
/// descriptor-derived credential grant. Retain before consuming TaskOwner.
#[derive(Clone)]
pub struct HomeCapture {
    #[cfg(target_os = "macos")]
    input: Arc<HomeInput>,
}
#[cfg(target_os = "macos")]
struct HomeInput {
    resource: File,
    resource_path: PathBuf,
    home: File,
    initial: Vec<(PathBuf, File)>,
}

/// A selected protected tree, not an atomic cut or proof that escaped writers
/// have died. Files are exact COW clones, accessed only through read-only FDs.
pub struct FrozenHome {
    #[cfg(target_os = "macos")]
    input: Arc<HomeInput>,
    #[cfg(target_os = "macos")]
    container: File,
    #[cfg(target_os = "macos")]
    directory: File,
    #[cfg(not(target_os = "macos"))]
    _private: (),
}

pub struct HomeEntry {
    pub relative_path: PathBuf,
    /// Original ordinary rwx bits, independent of a content backing FD's mode.
    pub mode: u32,
    pub kind: HomeEntryKind,
}
pub enum HomeEntryKind {
    File { file: File },
    Directory,
    Symlink { target: PathBuf },
}

pub struct HomeEntries {
    #[cfg(target_os = "macos")]
    directory: File,
    #[cfg(target_os = "macos")]
    records:
        serde_json::StreamDeserializer<'static, serde_json::de::IoRead<BufReader<File>>, Record>,
    #[cfg(target_os = "macos")]
    failed: bool,
}
#[cfg(target_os = "macos")]
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    relative_path: PathBuf,
    mode: u32,
    kind: Kind,
}
#[cfg(target_os = "macos")]
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Kind {
    File,
    Directory,
    Symlink { target: PathBuf },
}

pub(super) enum SeedState {
    Fresh,
    #[cfg(target_os = "macos")]
    Seeded,
    Failed,
}

impl HomeCapture {
    #[cfg(target_os = "macos")]
    pub(super) fn from_resource(path: &Path) -> Result<Self, Error> {
        let resource = super::evidence::open_resource(path)?;
        let home = directory_at(&resource, OsStr::new("home"))?;
        let mut initial = Vec::with_capacity(super::INITIAL_HOME_DIRECTORIES.len());
        for name in super::INITIAL_HOME_DIRECTORIES {
            initial.push((
                PathBuf::from(name),
                parent_directory(&home, Path::new(name))?,
            ));
        }
        Ok(Self {
            input: Arc::new(HomeInput {
                resource,
                resource_path: path.into(),
                home,
                initial,
            }),
        })
    }
    #[cfg(not(target_os = "macos"))]
    pub(super) fn from_resource(_: &std::path::Path) -> Result<Self, Error> {
        Err(unavailable())
    }

    /// Compare two already held capabilities. This cannot mint either one.
    pub fn owns(&self, frozen: &FrozenHome) -> bool {
        #[cfg(target_os = "macos")]
        {
            Arc::ptr_eq(&self.input, &frozen.input)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = frozen;
            false
        }
    }

    /// Requires the original group's closure and drained streams. AuthACK,
    /// current Root authority and profile publication remain broker decisions.
    pub async fn freeze(&self) -> Result<FrozenHome, Error> {
        #[cfg(target_os = "macos")]
        {
            let input = self.input.clone();
            tokio::task::spawn_blocking(move || freeze(input))
                .await
                .map_err(io::Error::other)?
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(unavailable())
        }
    }
}
impl FrozenHome {
    /// Streaming metadata and owned read-only file handles; call off-executor.
    pub fn entries(&self) -> Result<HomeEntries, Error> {
        #[cfg(target_os = "macos")]
        {
            let records = read_file(&self.container, OsStr::new("inventory.jsonl"))?;
            Ok(HomeEntries {
                directory: self.directory.try_clone()?,
                records: serde_json::Deserializer::from_reader(BufReader::new(records)).into_iter(),
                failed: false,
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(unavailable())
        }
    }
}
impl Iterator for HomeEntries {
    type Item = Result<HomeEntry, Error>;
    fn next(&mut self) -> Option<Self::Item> {
        #[cfg(target_os = "macos")]
        {
            if self.failed {
                return None;
            }
            let record = self.records.next()?;
            let entry = (|| {
                let record = record.map_err(io::Error::other)?;
                valid_path(&record.relative_path)?;
                valid_mode(record.mode)?;
                let kind = match record.kind {
                    Kind::File => {
                        let parent = parent_directory(
                            &self.directory,
                            record.relative_path.parent().unwrap_or(Path::new("")),
                        )?;
                        let file = read_file(
                            &parent,
                            record
                                .relative_path
                                .file_name()
                                .ok_or_else(|| invalid("HOME entry name"))?,
                        )?;
                        if !file.metadata()?.is_file() {
                            return Err(unsupported("HOME snapshot file changed type"));
                        }
                        HomeEntryKind::File { file }
                    }
                    Kind::Directory => HomeEntryKind::Directory,
                    Kind::Symlink { target } => HomeEntryKind::Symlink { target },
                };
                Ok(HomeEntry {
                    relative_path: record.relative_path,
                    mode: record.mode,
                    kind,
                })
            })();
            if entry.is_err() {
                self.failed = true;
            }
            Some(entry)
        }
        #[cfg(not(target_os = "macos"))]
        {
            None
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn unavailable() -> Error {
    Error::CaptureUnsupported("private HOME custody unavailable on this platform".into())
}
#[cfg(target_os = "macos")]
fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}
#[cfg(target_os = "macos")]
fn unsupported(message: &str) -> Error {
    Error::CaptureUnsupported(message.into())
}
#[cfg(target_os = "macos")]
fn valid_mode(mode: u32) -> Result<(), Error> {
    if mode & !0o777 != 0 {
        return Err(unsupported("HOME entry contains special permission bits"));
    }
    Ok(())
}
#[cfg(target_os = "macos")]
fn valid_path(path: &Path) -> Result<(), Error> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(invalid("HOME entry requires a normalized relative path").into());
    }
    Ok(())
}
#[cfg(target_os = "macos")]
fn read_file(parent: &File, name: &OsStr) -> io::Result<File> {
    Ok(openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?
    .into())
}
#[cfg(target_os = "macos")]
fn parent_directory(root: &File, relative: &Path) -> io::Result<File> {
    let mut parent = root.try_clone()?;
    for part in relative.components() {
        if !matches!(part, Component::Normal(_)) {
            return Err(invalid("HOME parent requires a normalized relative path"));
        }
        parent = directory_at(&parent, part.as_os_str())?;
    }
    Ok(parent)
}
#[cfg(target_os = "macos")]
fn observed(parent: &File, name: &OsStr, path: &Path) -> Result<Observation, Error> {
    let raw = rustix::fs::statat(parent, name, rustix::fs::AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|e| capture_error(path, e.into()))?;
    valid_mode(raw.st_mode as u32 & 0o7777)?;
    let observed = observe_at(parent, name).map_err(|e| capture_error(path, e))?;
    if observed.identity.device != raw.st_dev as u64 || observed.identity.inode != raw.st_ino {
        return Err(Error::CaptureUnstable(path.into()));
    }
    if matches!(observed.kind, ObservedKind::File) && raw.st_nlink != 1 {
        return Err(unsupported("HOME snapshot contains a multiply linked file"));
    }
    Ok(observed)
}

#[cfg(target_os = "macos")]
fn freeze(input: Arc<HomeInput>) -> Result<FrozenHome, Error> {
    let owner = directory_at(&input.resource, OsStr::new("owner"))?;
    let closure: super::Closure =
        super::evidence::read_json(super::evidence::open_regular(&owner, "closure.json")?)?;
    if !closure.is_closed() {
        return Err(unsupported(
            "private HOME original group or streams are not closed",
        ));
    }
    let original = observe_file(&input.home)?;
    ensure(
        &original,
        &observe_file(&directory_at(&input.resource, OsStr::new("home"))?)?,
        Path::new(""),
    )?;
    let container = tempfile::Builder::new()
        .prefix("frozen-home-")
        .disable_cleanup(true)
        .make_in(input.resource_path.join("owner"), |path| {
            let name = path
                .file_name()
                .ok_or_else(|| io::Error::other("HOME artifact name"))?;
            rustix::fs::mkdirat(&owner, name, Mode::RWXU)?;
            directory_at(&owner, name)
        })?
        .into_file();
    rustix::fs::mkdirat(&container, "tree", Mode::RWXU)?;
    let directory = directory_at(&container, OsStr::new("tree"))?;
    let inventory: File = openat(
        &container,
        "inventory.jsonl",
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::RUSR | Mode::WUSR,
    )?
    .into();
    let mut records = BufWriter::new(inventory);
    freeze_directory(&input.home, &directory, Path::new(""), &mut records)?;
    records.flush()?;
    fchmod(records.get_ref(), Mode::RUSR)?;
    fchmod(&directory, Mode::RUSR | Mode::XUSR)?;
    fchmod(&container, Mode::RUSR | Mode::XUSR)?;
    ensure(&original, &observe_file(&input.home)?, Path::new(""))?;
    ensure(
        &original,
        &observe_file(&directory_at(&input.resource, OsStr::new("home"))?)?,
        Path::new(""),
    )?;
    let frozen = FrozenHome {
        input,
        container,
        directory,
    };
    for entry in frozen.entries()? {
        let entry = entry?;
        if matches!(entry.kind, HomeEntryKind::Symlink { .. }) {
            validate_link(&frozen.directory, &entry.relative_path)?;
        }
    }
    Ok(frozen)
}
#[cfg(target_os = "macos")]
fn freeze_directory(
    source: &File,
    destination: &File,
    relative: &Path,
    records: &mut BufWriter<File>,
) -> Result<(), Error> {
    use std::os::unix::ffi::OsStrExt;
    let original = observe_file(source)?;
    let scan = directory_at(source, OsStr::new("."))?;
    for entry in rustix::fs::Dir::read_from(&scan)? {
        let entry = entry?;
        let bytes = entry.file_name().to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        let name = OsStr::from_bytes(bytes);
        let path = relative.join(name);
        let observed = observed(source, name, &path)?;
        let record = Record {
            relative_path: path.clone(),
            mode: observed.mode,
            kind: match &observed.kind {
                ObservedKind::File => Kind::File,
                ObservedKind::Directory { .. } => Kind::Directory,
                ObservedKind::Symlink(target) => {
                    if target.is_absolute() {
                        return Err(unsupported("HOME symlink must be tree-relative"));
                    }
                    Kind::Symlink {
                        target: target.clone(),
                    }
                }
            },
        };
        serde_json::to_writer(&mut *records, &record).map_err(io::Error::other)?;
        records.write_all(b"\n")?;
        match &observed.kind {
            ObservedKind::File => {
                let file = read_file(source, name).map_err(|e| capture_error(&path, e))?;
                ensure(&observed, &observe_file(&file)?, &path)?;
                match rustix::fs::fclonefileat(
                    &file,
                    destination,
                    name,
                    rustix::fs::CloneFlags::NOOWNERCOPY,
                ) {
                    Ok(()) => {}
                    Err(rustix::io::Errno::XDEV | rustix::io::Errno::OPNOTSUPP) => {
                        return Err(unsupported("HOME snapshot requires exact physical COW"));
                    }
                    Err(error) => return Err(error.into()),
                }
                let cloned = read_file(destination, name)?;
                let selected = observe_file(&cloned)?;
                if selected.kind != ObservedKind::File
                    || selected.identity == observed.identity
                    || selected.mode != observed.mode
                {
                    return Err(Error::CaptureUnstable(path));
                }
                fchmod(&cloned, Mode::RUSR)?;
                ensure(&observed, &observe_file(&file)?, &path)?;
            }
            ObservedKind::Directory { .. } => {
                let child = directory_at(source, name).map_err(|e| capture_error(&path, e))?;
                ensure(&observed, &observe_file(&child)?, &path)?;
                rustix::fs::mkdirat(destination, name, Mode::RWXU)?;
                let target = directory_at(destination, name)?;
                freeze_directory(&child, &target, &path, records)?;
                fchmod(&target, Mode::RUSR | Mode::XUSR)?;
            }
            ObservedKind::Symlink(target) => {
                rustix::fs::symlinkat(target, destination, name)?;
            }
        }
        ensure(
            &observed,
            &observe_at(source, name).map_err(|e| capture_error(&path, e))?,
            &path,
        )?;
    }
    ensure(&original, &observe_file(source)?, relative)
}

/// Resolve link components ourselves so a symlink followed by `..` cannot
/// defeat a merely lexical prefix check. Missing suffixes stay tree-relative.
#[cfg(target_os = "macos")]
fn validate_link(root: &File, relative: &Path) -> Result<(), Error> {
    use std::{collections::VecDeque, ffi::OsString, os::unix::ffi::OsStringExt};
    let mut pending: VecDeque<OsString> = relative
        .components()
        .map(|p| p.as_os_str().to_owned())
        .collect();
    let mut parents = vec![root.try_clone()?];
    let mut links = 0;
    let mut missing_depth = 0usize;
    while let Some(part) = pending.pop_front() {
        if part == OsStr::new(".") {
            continue;
        }
        if part == OsStr::new("..") {
            if missing_depth > 0 {
                missing_depth -= 1;
                continue;
            }
            if parents.len() == 1 {
                return Err(unsupported("HOME symlink escapes its tree"));
            }
            parents.pop();
            continue;
        }
        if missing_depth > 0 {
            missing_depth += 1;
            continue;
        }
        let parent = parents.last().expect("HOME root");
        let stat = match rustix::fs::statat(parent, &part, rustix::fs::AtFlags::SYMLINK_NOFOLLOW) {
            Ok(stat) => stat,
            Err(rustix::io::Errno::NOENT) => {
                missing_depth = 1;
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        match rustix::fs::FileType::from_raw_mode(stat.st_mode as _) {
            rustix::fs::FileType::Symlink => {
                links += 1;
                if links > 40 {
                    return Err(unsupported("HOME symlink cycle or excessive indirection"));
                }
                let target = PathBuf::from(OsString::from_vec(
                    rustix::fs::readlinkat(parent, &part, Vec::new())?.into_bytes(),
                ));
                if target.is_absolute() {
                    return Err(unsupported("HOME symlink targets an absolute resource"));
                }
                for component in target.components().rev() {
                    pending.push_front(component.as_os_str().to_owned());
                }
            }
            rustix::fs::FileType::Directory => {
                parents.push(directory_at(parent, &part)?);
            }
            rustix::fs::FileType::RegularFile if pending.is_empty() => {}
            _ => {
                return Err(unsupported(
                    "HOME symlink does not resolve within an ordinary tree",
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn seed(
    owner: &mut super::TaskOwner,
    entries: impl IntoIterator<Item = Result<HomeEntry, Error>>,
) -> Result<(), Error> {
    if !matches!(owner.home_seed, SeedState::Fresh) {
        owner.home_seed = SeedState::Failed;
        return Err(Error::CaptureUnsupported(
            "private HOME is not fresh".into(),
        ));
    }
    owner.home_seed = SeedState::Failed;
    #[cfg(target_os = "macos")]
    {
        let input = owner.home_capture.input.clone();
        ensure_home_anchor(&input)?;
        ensure_fresh(&input, &input.home, Path::new(""))?;
        seed_entries(&input, entries)?;
        ensure_home_anchor(&input)?;
        owner.home_seed = SeedState::Seeded;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = entries;
        Err(unavailable())
    }
}
#[cfg(target_os = "macos")]
fn ensure_home_anchor(input: &HomeInput) -> Result<(), Error> {
    let current = directory_at(&input.resource, OsStr::new("home"))?;
    if super::snapshot::identity(&current.metadata()?)
        != super::snapshot::identity(&input.home.metadata()?)
    {
        return Err(Error::CaptureUnstable(PathBuf::from("home")));
    }
    Ok(())
}
#[cfg(target_os = "macos")]
fn ensure_fresh(input: &HomeInput, directory: &File, relative: &Path) -> Result<(), Error> {
    use std::os::unix::ffi::OsStrExt;
    let scan = directory_at(directory, OsStr::new("."))?;
    for entry in rustix::fs::Dir::read_from(&scan)? {
        let entry = entry?;
        let bytes = entry.file_name().to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        let name = OsStr::from_bytes(bytes);
        let path = relative.join(name);
        let expected = input
            .initial
            .iter()
            .find(|(p, _)| p == &path)
            .ok_or_else(|| unsupported("private HOME already contains non-initial entries"))?;
        let child = directory_at(directory, name)?;
        if super::snapshot::identity(&child.metadata()?)
            != super::snapshot::identity(&expected.1.metadata()?)
        {
            return Err(Error::CaptureUnstable(path));
        }
        ensure_fresh(input, &child, &path)?;
    }
    Ok(())
}
#[cfg(target_os = "macos")]
fn seed_entries(
    input: &HomeInput,
    entries: impl IntoIterator<Item = Result<HomeEntry, Error>>,
) -> Result<(), Error> {
    let mut directories: Vec<(PathBuf, File, u32)> = Vec::new();
    // The stream is depth-first/parent-before-child, like FrozenHome::entries.
    // Restore restrictive directory modes only after writing their children.
    for entry in entries {
        let entry = entry?;
        valid_path(&entry.relative_path)?;
        valid_mode(entry.mode)?;
        let parent_path = entry.relative_path.parent().unwrap_or(Path::new(""));
        while directories
            .last()
            .is_some_and(|(path, _, _)| !parent_path.starts_with(path))
        {
            let (_, directory, mode) = directories.pop().expect("HOME ancestor");
            fchmod(&directory, Mode::from_bits_truncate(mode as _))?;
        }
        let parent = parent_directory(&input.home, parent_path)?;
        let name = entry
            .relative_path
            .file_name()
            .ok_or_else(|| invalid("HOME seed name"))?;
        match entry.kind {
            HomeEntryKind::Directory => {
                match rustix::fs::mkdirat(&parent, name, Mode::RWXU) {
                    Ok(()) => {}
                    Err(rustix::io::Errno::EXIST) => {
                        let expected = input
                            .initial
                            .iter()
                            .find(|(path, _)| path == &entry.relative_path)
                            .ok_or_else(|| {
                                unsupported("HOME seed refuses an unexpected existing directory")
                            })?;
                        let current = directory_at(&parent, name)?;
                        if super::snapshot::identity(&current.metadata()?)
                            != super::snapshot::identity(&expected.1.metadata()?)
                        {
                            return Err(Error::CaptureUnstable(entry.relative_path));
                        }
                    }
                    Err(error) => return Err(error.into()),
                }
                let directory = directory_at(&parent, name)?;
                directories.push((entry.relative_path, directory, entry.mode));
            }
            HomeEntryKind::File { mut file } => {
                if !file.metadata()?.is_file()
                    || rustix::fs::fcntl_getfl(&file)? & OFlags::ACCMODE != OFlags::RDONLY
                {
                    return Err(unsupported(
                        "HOME seed requires an immutable read-only regular file backing",
                    ));
                }
                let mut target: File = openat(
                    &parent,
                    name,
                    OFlags::WRONLY
                        | OFlags::CREATE
                        | OFlags::EXCL
                        | OFlags::NOFOLLOW
                        | OFlags::CLOEXEC,
                    Mode::RUSR | Mode::WUSR,
                )?
                .into();
                file.rewind()?;
                io::copy(&mut file, &mut target)?;
                fchmod(&target, Mode::from_bits_truncate(entry.mode as _))?;
            }
            HomeEntryKind::Symlink { target } => {
                if target.is_absolute() {
                    return Err(unsupported("HOME seed symlink must be relative"));
                }
                rustix::fs::symlinkat(&target, &parent, name)?;
                rustix::fs::chmodat(
                    &parent,
                    name,
                    Mode::from_bits_truncate(entry.mode as _),
                    rustix::fs::AtFlags::SYMLINK_NOFOLLOW,
                )?;
            }
        }
    }
    // Validate against the complete new tree, including forward link targets.
    validate_seed_links(&input.home, &input.home, Path::new(""))?;
    while let Some((_, directory, mode)) = directories.pop() {
        fchmod(&directory, Mode::from_bits_truncate(mode as _))?;
    }
    Ok(())
}
#[cfg(target_os = "macos")]
fn validate_seed_links(root: &File, directory: &File, relative: &Path) -> Result<(), Error> {
    use std::os::unix::ffi::OsStrExt;
    let scan = directory_at(directory, OsStr::new("."))?;
    for entry in rustix::fs::Dir::read_from(&scan)? {
        let entry = entry?;
        let bytes = entry.file_name().to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        let name = OsStr::from_bytes(bytes);
        let path = relative.join(name);
        match observe_at(directory, name)
            .map_err(|e| capture_error(&path, e))?
            .kind
        {
            ObservedKind::Directory { .. } => {
                validate_seed_links(root, &directory_at(directory, name)?, &path)?
            }
            ObservedKind::Symlink(_) => validate_link(root, &path)?,
            ObservedKind::File => {}
        }
    }
    Ok(())
}
