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

//! Admits a shell's connection to its Host.

use maka_app_client::{Client, Journal};
use maka_event_log::root;
use maka_host_runtime::application::host::Client as HostClient;
use maka_plugin_core::operation::receipt_reader_contract;
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

/// Checks that `host` serves the Root at `root` and the receipts contract the
/// workbench reads, and opens the shell's journal, `<root>/clients/<shell>.sqlite`.
/// Returns the workbench's client and the clients directory, where the shell
/// keeps its data. `host` is closed when admission fails.
pub async fn admit(
    mut host: HostClient,
    root: &Path,
    shell: &str,
) -> Result<(Client, PathBuf), String> {
    let prepare = async {
        let location = root::resolve(root).map_err(|error| error.to_string())?;
        if host.source().state_domain != location.root_id() {
            return Err(format!(
                "application Host changed during {shell} startup admission"
            ));
        }
        if host.catalogue().describe("receipts")?.contract != receipt_reader_contract() {
            return Err("Host receipts endpoint has a different contract".into());
        }
        let directory = location.canonical_path().join("clients");
        root::private_directory(&directory).map_err(|error| error.to_string())?;
        let _ = migrate_legacy_storage(&directory);
        let journal = Journal::open(&directory.join(format!("{shell}.sqlite"))).await?;
        Ok((journal, directory))
    }
    .await;
    match prepare {
        Ok((journal, directory)) => Ok((Client::new(host, journal, "receipts".into())?, directory)),
        Err(error) => match host.close().await {
            Ok(()) => Err(error),
            Err(cleanup) => Err(format!("{error}; {shell} Host cleanup: {cleanup}")),
        },
    }
}

fn migrate_legacy_storage(directory: &Path) -> io::Result<()> {
    let legacy_dir = directory.join("default");
    let legacy = legacy_dir.join("storage.json");
    let metadata = match fs::symlink_metadata(&legacy) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() {
        return Ok(());
    }
    let legacy_entries: BTreeMap<String, String> = match fs::read(&legacy)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    {
        Some(entries) => entries,
        None => return Ok(()),
    };
    let current = directory.join("storage.json");
    if !legacy_entries.is_empty() {
        match write_storage_file(directory, &current, &legacy_entries, false) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let Ok(current_bytes) = fs::read(&current) else {
                    return Ok(());
                };
                let Ok(mut merged) =
                    serde_json::from_slice::<BTreeMap<String, String>>(&current_bytes)
                else {
                    return Ok(());
                };
                let mut changed = false;
                for (key, value) in legacy_entries {
                    if let std::collections::btree_map::Entry::Vacant(entry) = merged.entry(key) {
                        entry.insert(value);
                        changed = true;
                    }
                }
                if changed {
                    write_storage_file(directory, &current, &merged, true)?;
                }
            }
            Err(error) => return Err(error),
        }
    }
    match fs::remove_file(&legacy) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let _ = fs::remove_dir(&legacy_dir);
    Ok(())
}

fn write_storage_file(
    directory: &Path,
    target: &Path,
    entries: &BTreeMap<String, String>,
    replace: bool,
) -> io::Result<()> {
    let mut staging = tempfile::NamedTempFile::new_in(directory)?;
    serde_json::to_writer(&mut staging, entries)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    staging.flush()?;
    staging.as_file().sync_all()?;
    if replace {
        staging.persist(target).map_err(|error| error.error)?;
    } else {
        staging
            .persist_noclobber(target)
            .map_err(|error| error.error)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_legacy_storage_when_current_is_absent() {
        let dir = tempfile::tempdir().unwrap();
        let legacy_dir = dir.path().join("default");
        fs::create_dir_all(&legacy_dir).unwrap();
        let payload =
            r#"{"appearance-tray-icon":"line","composer-toolbar":"{\"usageLimits\":true}"}"#;
        fs::write(legacy_dir.join("storage.json"), payload).unwrap();

        migrate_legacy_storage(dir.path()).unwrap();

        let migrated: BTreeMap<String, String> =
            serde_json::from_slice(&fs::read(dir.path().join("storage.json")).unwrap()).unwrap();
        assert_eq!(
            migrated.get("appearance-tray-icon").map(String::as_str),
            Some("line")
        );
        assert_eq!(
            migrated.get("composer-toolbar").map(String::as_str),
            Some(r#"{"usageLimits":true}"#)
        );
        assert!(!legacy_dir.join("storage.json").exists());
        assert!(!legacy_dir.exists());
    }

    #[test]
    fn merges_missing_legacy_keys_without_overwriting_current() {
        let dir = tempfile::tempdir().unwrap();
        let legacy_dir = dir.path().join("default");
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(
            legacy_dir.join("storage.json"),
            r#"{"appearance-tray-icon":"line","composer-toolbar":"{\"usageLimits\":true}"}"#,
        )
        .unwrap();
        fs::write(
            dir.path().join("storage.json"),
            r#"{"appearance-tray-icon":"tile","ui-scale":"1.1"}"#,
        )
        .unwrap();

        migrate_legacy_storage(dir.path()).unwrap();

        let merged: BTreeMap<String, String> =
            serde_json::from_slice(&fs::read(dir.path().join("storage.json")).unwrap()).unwrap();
        assert_eq!(
            merged.get("appearance-tray-icon").map(String::as_str),
            Some("tile")
        );
        assert_eq!(merged.get("ui-scale").map(String::as_str), Some("1.1"));
        assert_eq!(
            merged.get("composer-toolbar").map(String::as_str),
            Some(r#"{"usageLimits":true}"#)
        );
        assert!(!legacy_dir.join("storage.json").exists());
    }

    #[test]
    fn keeps_invalid_legacy_storage_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let legacy_dir = dir.path().join("default");
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(legacy_dir.join("storage.json"), "not-json").unwrap();

        migrate_legacy_storage(dir.path()).unwrap();

        assert!(!dir.path().join("storage.json").exists());
        assert_eq!(
            fs::read_to_string(legacy_dir.join("storage.json")).unwrap(),
            "not-json"
        );
    }

    #[cfg(unix)]
    #[test]
    fn ignores_symlinked_legacy_storage() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside.json");
        fs::write(&outside, r#"{"k":"v"}"#).unwrap();
        let clients = dir.path().join("clients");
        let legacy_dir = clients.join("default");
        fs::create_dir_all(&legacy_dir).unwrap();
        std::os::unix::fs::symlink(&outside, legacy_dir.join("storage.json")).unwrap();

        migrate_legacy_storage(&clients).unwrap();

        assert!(!clients.join("storage.json").exists());
        assert!(
            legacy_dir
                .join("storage.json")
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }
}
