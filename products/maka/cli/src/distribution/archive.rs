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

use super::{decode_integrity, regular_file, target::Target};
use flate2::read::GzDecoder;
use maka_event_log::root::private_directory;
use maka_host_runtime::HostError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Read, Write},
    path::Path,
};
use tempfile::NamedTempFile;

#[derive(Deserialize)]
struct Package {
    name: String,
    version: String,
    os: Vec<String>,
    cpu: Vec<String>,
    #[serde(default)]
    libc: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    target: Target,
    version: String,
    integrity: String,
    files: BTreeMap<String, Member>,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Member {
    size: u64,
    sha256: String,
}

fn allowed(target: Target, name: &str) -> bool {
    required(target).any(|member| member == name) || matches!(name, "README.md" | "README.zh-CN.md")
}

fn required(target: Target) -> impl Iterator<Item = &'static str> {
    [
        "package.json",
        "DISCLAIMER",
        "LICENSE",
        "NOTICE",
        "THIRD_PARTY_NOTICES.txt",
        target.executable(),
        target.desktop_executable(),
        target.python_worker(),
    ]
    .into_iter()
    .chain(target.desktop_members().iter().copied())
    .chain(target.service_executable())
}

/// The package root or a parent of a required member.
fn directory(target: Target, name: &str) -> bool {
    name.is_empty()
        || required(target).any(|member| {
            member
                .strip_prefix(name)
                .is_some_and(|rest| rest.starts_with('/'))
        })
}

pub(super) fn cached(
    directory: &Path,
    target: Target,
    version: &str,
) -> Result<Option<String>, HostError> {
    match directory.symlink_metadata() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(metadata) if !metadata.is_dir() => {
            return Err("native package cache entry is not a directory".into());
        }
        Ok(_) => {}
    }
    private_directory(directory)?;
    private_directory(&directory.join("bin"))?;
    let receipt: Receipt = serde_json::from_reader(regular_file(&directory.join("receipt.json"))?)?;
    decode_integrity(&receipt.integrity)?;
    if receipt.target != target
        || receipt.version != version
        || required(target).any(|name| !receipt.files.contains_key(name))
    {
        return Err("native package cache identity or file set changed".into());
    }
    for (name, expected) in &receipt.files {
        if !allowed(target, name) {
            return Err("native package cache contains an unexpected member".into());
        }
        let file = member_file(directory, name)?;
        if digest(file)? != *expected {
            return Err("native package cache integrity mismatch".into());
        }
    }
    if let Some(bundle) = target.desktop_bundle() {
        verify_bundle_members(directory, bundle, &receipt.files)?;
    }
    validate_package(directory, target, version)?;
    Ok(Some(receipt.integrity))
}

fn verify_bundle_members(
    directory: &Path,
    name: &str,
    files: &BTreeMap<String, Member>,
) -> Result<(), HostError> {
    // macOS reads more of a bundle than its Info.plist. Check the actual tree as
    // well as the receipt's required bytes.
    for entry in fs::read_dir(directory.join(name))? {
        let entry = entry?;
        let filename = entry.file_name();
        let filename = filename
            .to_str()
            .ok_or("native package bundle contains a non-UTF-8 member")?;
        let name = format!("{name}/{filename}");
        let kind = entry.file_type()?;
        if kind.is_dir() {
            verify_bundle_members(directory, &name, files)?;
        } else if !kind.is_file() || !files.contains_key(&name) {
            return Err(
                "native package bundle contains an unrecorded or non-regular member".into(),
            );
        }
    }
    Ok(())
}

pub(super) fn publish(
    archive: NamedTempFile,
    cache: &Path,
    destination: &Path,
    target: Target,
    version: &str,
    integrity: &str,
) -> Result<(), HostError> {
    let stage = tempfile::Builder::new()
        .prefix(".native-")
        .tempdir_in(cache)?;
    // On Windows a generic temp directory may have the Administrators group
    // as owner. Create the published child with the account SID atomically;
    // never adopt the temp directory by weakening private_directory's checks.
    let package = stage.path().join("package");
    private_directory(&package)?;
    private_directory(&package.join("bin"))?;
    let mut files = BTreeMap::new();
    let decoder = GzDecoder::new(archive.reopen()?);
    // Raw entries prevent unbounded GNU/PAX metadata allocation. Package
    // members use portable package paths, not general tar semantics.
    let mut tar = tar::Archive::new(decoder);
    for entry in tar.entries()?.raw(true) {
        let mut entry = entry?;
        let path = entry.path_bytes();
        let path = std::str::from_utf8(&path)?.to_owned();
        if entry.header().entry_type().is_dir()
            && path
                .strip_prefix("package/")
                .and_then(|name| {
                    if name.is_empty() {
                        Some(name)
                    } else {
                        name.strip_suffix('/')
                    }
                })
                .is_some_and(|name| directory(target, name))
            && entry.size() == 0
        {
            continue;
        }
        let name = path
            .strip_prefix("package/")
            .ok_or("native package member is outside package/")?;
        let executable = target.is_executable(name);
        if !allowed(target, name)
            || !entry.header().entry_type().is_file()
            || files.contains_key(name)
            || entry.size() == 0
        {
            return Err("native package contains an invalid or duplicate member".into());
        }
        // Never use a tar member as an unrestricted filesystem path, restore
        // ownership/mode bits, follow links, or run package lifecycle scripts.
        let path = package.join(name);
        fs::create_dir_all(path.parent().ok_or("native package member has no parent")?)?;
        let mut file = File::create_new(&path)?;
        let size = std::io::copy(&mut entry, &mut file)?;
        if size != entry.size() {
            return Err("native package member is incomplete".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(if executable {
                0o500
            } else {
                0o400
            }))?;
        }
        file.sync_all()?;
        files.insert(name.to_owned(), digest(File::open(path)?)?);
    }
    if required(target).any(|name| !files.contains_key(name)) {
        return Err("native package is missing an executable or license document".into());
    }
    // Read through the gzip trailer so a truncated stream cannot be published.
    let mut tail = tar.into_inner();
    std::io::copy(&mut tail, &mut std::io::sink())?;
    validate_package(&package, target, version)?;
    let receipt = Receipt {
        target,
        version: version.into(),
        integrity: integrity.into(),
        files,
    };
    let mut file = File::create_new(package.join("receipt.json"))?;
    file.write_all(&serde_json::to_vec(&receipt)?)?;
    file.sync_all()?;
    drop(file);
    #[cfg(unix)]
    {
        sync_directories(&package, &receipt.files)?;
    }
    commit(&package, cache, destination, target, version, integrity)
}

/// A receipt digest supplied by the original verifier binds the complete file
/// set. The archive's integrity string alone cannot authenticate unpacked bytes.
pub(super) fn import_directory(
    source: &Path,
    receipt_sha256: &str,
    cache: &Path,
    destination: &Path,
    target: Target,
    version: &str,
) -> Result<String, HostError> {
    let mut bytes = Vec::new();
    regular_file(&source.join("receipt.json"))?.read_to_end(&mut bytes)?;
    if hex::encode(Sha256::digest(&bytes)) != receipt_sha256 {
        return Err("transferred native package receipt digest mismatch".into());
    }
    let receipt: Receipt = serde_json::from_slice(&bytes)?;
    decode_integrity(&receipt.integrity)?;
    if receipt.target != target
        || receipt.version != version
        || required(target).any(|name| !receipt.files.contains_key(name))
        || receipt.files.keys().any(|name| !allowed(target, name))
    {
        return Err("transferred native package identity or file set changed".into());
    }
    if let Some(existing) = cached(destination, target, version)? {
        let mut existing_bytes = Vec::new();
        regular_file(&destination.join("receipt.json"))?.read_to_end(&mut existing_bytes)?;
        if existing != receipt.integrity || existing_bytes != bytes {
            return Err("cached package differs from the transferred native package".into());
        }
        return Ok(existing);
    }
    let stage = tempfile::Builder::new()
        .prefix(".native-")
        .tempdir_in(cache)?;
    let package = stage.path().join("package");
    private_directory(&package)?;
    private_directory(&package.join("bin"))?;
    for (name, expected) in &receipt.files {
        let executable = target.is_executable(name);
        if expected.size == 0 {
            return Err("transferred native package member is empty".into());
        }
        let mut input = member_file(source, name)?.take(
            expected
                .size
                .checked_add(1)
                .ok_or("native member length overflow")?,
        );
        let path = package.join(name);
        fs::create_dir_all(path.parent().ok_or("native package member has no parent")?)?;
        let mut output = File::create_new(&path)?;
        std::io::copy(&mut input, &mut output)?;
        if digest(File::open(&path)?)? != *expected {
            return Err("transferred native package member digest mismatch".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            output.set_permissions(fs::Permissions::from_mode(if executable {
                0o500
            } else {
                0o400
            }))?;
        }
        output.sync_all()?;
    }
    validate_package(&package, target, version)?;
    let mut file = File::create_new(package.join("receipt.json"))?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    #[cfg(unix)]
    {
        sync_directories(&package, &receipt.files)?;
    }
    commit(
        &package,
        cache,
        destination,
        target,
        version,
        &receipt.integrity,
    )?;
    // Includes the simultaneous publisher path; compare the authenticated
    // receipt, not just an archive identifier copied from it.
    let mut published = Vec::new();
    regular_file(&destination.join("receipt.json"))?.read_to_end(&mut published)?;
    if published != bytes {
        return Err("another native package was published at this version".into());
    }
    Ok(receipt.integrity)
}

fn commit(
    package: &Path,
    _cache: &Path,
    destination: &Path,
    target: Target,
    version: &str,
    integrity: &str,
) -> Result<(), HostError> {
    match fs::rename(package, destination) {
        Ok(()) => {}
        Err(error) => {
            // A simultaneous download may have published first. Never replace
            // its files, and never accept an unverified/incomplete winner.
            match cached(destination, target, version)? {
                Some(existing) if existing == integrity => return Ok(()),
                _ => return Err(error.into()),
            }
        }
    }
    #[cfg(unix)]
    File::open(_cache)?.sync_all()?;
    Ok(())
}

fn validate_package(directory: &Path, target: Target, version: &str) -> Result<(), HostError> {
    let package: Package = serde_json::from_reader(regular_file(&directory.join("package.json"))?)?;
    if package.name != target.package_name()
        || package.version != version
        || package.os != [target.os()]
        || package.cpu != [target.cpu()]
        || if target.os() == "linux" {
            package.libc != ["glibc"]
        } else {
            !package.libc.is_empty()
        }
    {
        return Err(
            "native package manifest does not match the requested target and version".into(),
        );
    }
    target.validate_binary(
        &mut regular_file(&directory.join(target.executable()))?,
        false,
    )?;
    target.validate_binary(
        &mut regular_file(&directory.join(target.desktop_executable()))?,
        true,
    )?;
    target.validate_binary(
        &mut regular_file(&directory.join(target.python_worker()))?,
        false,
    )?;
    if let Some(service) = target.service_executable() {
        target.validate_binary(&mut regular_file(&directory.join(service))?, true)?;
    }
    Ok(())
}

fn member_file(directory: &Path, name: &str) -> Result<File, HostError> {
    let mut parent = directory.to_owned();
    if let Some(relative) = Path::new(name).parent() {
        for component in relative.components() {
            parent.push(component);
            if !parent.symlink_metadata()?.is_dir() {
                return Err("native package member parent is not a directory".into());
            }
        }
    }
    regular_file(&directory.join(name))
}

#[cfg(unix)]
fn sync_directories(directory: &Path, files: &BTreeMap<String, Member>) -> Result<(), HostError> {
    let mut parents = std::collections::BTreeSet::new();
    for name in files.keys() {
        if let Some(parent) = Path::new(name).parent() {
            parents.extend(parent.ancestors().map(|path| directory.join(path)));
        }
    }
    for parent in parents.into_iter().rev() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn digest(mut file: File) -> Result<Member, HostError> {
    let mut hash = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        size = size
            .checked_add(read as u64)
            .ok_or("native member length overflow")?;
        hash.update(&buffer[..read]);
    }
    Ok(Member {
        size,
        sha256: hex::encode(hash.finalize()),
    })
}
