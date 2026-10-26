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

use maka_host_runtime::HostError;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(super) fn path(directory: &Path, digest: &str) -> PathBuf {
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    directory
        .join("packages")
        .join(format!("maka-{digest}{suffix}"))
}

pub(super) fn source(mode: super::Mode) -> Result<PathBuf, HostError> {
    let current = std::env::current_exe()?.canonicalize()?;
    #[cfg(windows)]
    if mode == super::Mode::Supervised && env!("CARGO_BIN_NAME") != "maka-service" {
        let service = service_companion(&current)?;
        if !service.is_file() {
            return Err("Windows services require the sibling maka-service.exe artifact".into());
        }
        return Ok(service);
    }
    #[cfg(not(windows))]
    let _ = mode;
    Ok(current)
}

pub(super) fn stage(directory: &Path, source: &Path) -> Result<(PathBuf, String), HostError> {
    let staged = stage_one(directory, source)?;
    #[cfg(windows)]
    {
        // Keep the GUI companion paired with this exact console binary, not
        // whichever Desktop version happens to configure it later. Both names
        // link immutable content-addressed code; no second mutable manifest.
        let companion = service_companion(source)?;
        if companion != source && companion.is_file() {
            crate::distribution::validate_windows_service(&companion)?;
            let (service, digest) = stage_one(directory, &companion)?;
            let alias = staged.0.with_extension("service.exe");
            match std::fs::hard_link(service, &alias) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if stage_one(directory, &alias)?.1 != digest {
                        return Err("installed Windows service companion differs".into());
                    }
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
    Ok(staged)
}

#[cfg(windows)]
fn service_companion(executable: &Path) -> Result<PathBuf, HostError> {
    let parent = executable
        .parent()
        .ok_or("executable directory is missing")?;
    if executable
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.starts_with("maka-") && name.len() == "maka-".len() + 64 + ".exe".len()
        })
    {
        Ok(executable.with_extension("service.exe"))
    } else {
        Ok(parent.join("maka-service.exe"))
    }
}

#[cfg(windows)]
pub(super) fn windowless(executable: &Path) -> Result<PathBuf, HostError> {
    if crate::distribution::validate_windows_service(executable).is_ok() {
        return Ok(executable.into());
    }
    let companion = service_companion(executable)?;
    crate::distribution::validate_windows_service(&companion)?;
    Ok(companion)
}

fn stage_one(directory: &Path, source: &Path) -> Result<(PathBuf, String), HostError> {
    let packages = directory.join("packages");
    maka_event_log::root::private_directory(&packages)?;
    let mut source = File::open(source)?;
    if !source.metadata()?.is_file() {
        return Err("Host package must be a regular executable".into());
    }
    let mut temporary = tempfile::NamedTempFile::new_in(&packages)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    let mut size = 0_u64;
    loop {
        let read = source.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        size += read as u64;
        temporary.write_all(&buffer[..read])?;
        hasher.update(&buffer[..read]);
    }
    let digest = hex::encode(hasher.finalize());
    let target = path(directory, &digest);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o500))?;
    }
    temporary.as_file().sync_all()?;
    #[cfg(unix)]
    let published = temporary
        .persist_noclobber(&target)
        .map(drop)
        .map_err(|error| error.error);
    #[cfg(windows)]
    let published =
        maka_event_log::root::windows::publish_file(&temporary.into_temp_path(), &target);
    match published {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = target.symlink_metadata()?;
            if !metadata.is_file() || metadata.len() != size {
                return Err("installed Host package was replaced".into());
            }
            let mut file = File::open(&target)?.take(size + 1);
            let mut hasher = Sha256::new();
            loop {
                let read = file.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                hasher.update(&buffer[..read]);
            }
            if hex::encode(hasher.finalize()) != digest {
                return Err("installed Host package digest changed".into());
            }
        }
        Err(error) => return Err(error.into()),
    }
    #[cfg(unix)]
    File::open(&packages)?.sync_all()?;
    Ok((target, digest))
}
