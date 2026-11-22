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

use maka_event_log::root::windows::{
    create_private_file, file_identity, open_nofollow, publish_file, validate_private,
};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::Path,
};

// A bounded deny subtree can contain many more native identities than the
// input policy has rules. The serialized journal also has this byte ceiling.

pub(super) fn lease_file(path: &Path) -> io::Result<()> {
    match create_private_file(path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let file = open_nofollow(path, false)?;
            validate_private(&file)
        }
        Err(error) => Err(error),
    }
}

/// Short native mutation lane, not a queue behind running sandbox processes.
/// Human consent and process execution never retain this lock.
pub(super) fn admission(root: &Path) -> io::Result<maka_event_log::root::FileLease> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match maka_event_log::root::FileLease::acquire(&root.join("admission.lock")) {
            Err(error)
                if error.kind() == io::ErrorKind::WouldBlock
                    && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            result => return result,
        }
    }
}

pub(super) fn read<T: DeserializeOwned>(path: &Path) -> io::Result<Option<T>> {
    let mut file = match open_nofollow(path, false) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    validate_private(&file)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("invalid sandbox installation document"));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(io::Error::other)
}

pub(super) fn required<T: DeserializeOwned>(path: &Path) -> io::Result<T> {
    read(path)?.ok_or_else(super::setup_required)
}

/// Documents are immutable within an installation. No whole-state
/// overwrite is needed, and an interrupted rename can be resolved by rereading.
pub(super) fn publish(root: &Path, name: &str, value: &impl Serialize) -> io::Result<()> {
    let target = root.join(name);
    let value = serde_json::to_value(value).map_err(io::Error::other)?;
    let bytes = serde_json::to_vec(&value).map_err(io::Error::other)?;
    if let Some(previous) = read::<serde_json::Value>(&target)? {
        return if previous == value {
            Ok(())
        } else {
            Err(io::Error::other(
                "sandbox installation identity cannot be overwritten",
            ))
        };
    }
    let staging = root.join(format!(".{name}.pending"));
    if staging.try_exists()? {
        let stale = open_nofollow(&staging, false)?;
        validate_private(&stale)?;
        if !stale.metadata()?.is_file() {
            return Err(io::Error::other(
                "invalid sandbox installation staging entry",
            ));
        }
        fs::remove_file(&staging)?;
    }
    let mut file = create_private_file(&staging)?;
    let result = (|| {
        file.write_all(&bytes)?;
        file.flush()?;
        file.sync_all()?;
        publish_file(&staging, &target)
    })();
    // If publication fails after the durable rename, a future setup rereads
    // target. Never overwrite an ambiguous commit with an older in-memory value.
    if result.is_err() {
        let _ = fs::remove_file(staging);
    }
    result
}

pub(super) fn shared_lease(path: &Path) -> io::Result<File> {
    let file = open_nofollow(path, false)?;
    validate_private(&file)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("invalid sandbox lease"));
    }
    file.try_lock_shared().map_err(io::Error::from)?;
    let named = open_nofollow(path, false)?;
    let current = file_identity(&named)?;
    let opened = file_identity(&file)?;
    if (current.volume, current.index) != (opened.volume, opened.index) {
        return Err(io::Error::other("sandbox lifecycle lease was replaced"));
    }
    Ok(file)
}

pub(super) fn remove(path: &Path) -> io::Result<()> {
    let file = match open_nofollow(path, false) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    validate_private(&file)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("invalid sandbox installation entry"));
    }
    fs::remove_file(path)
}
