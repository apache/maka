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
    host: HostClient,
    root: &Path,
    shell: &str,
) -> Result<(Client, PathBuf), String> {
    let location = root::resolve(root)
        .map(|location| {
            (
                location.root_id().to_owned(),
                location.canonical_path().join("clients"),
            )
        })
        .map_err(|error| error.to_string());
    admit_at(host, location, shell).await
}

/// Admit a Host with a separately resolved Root identity and client data directory.
pub async fn admit_in(
    host: HostClient,
    root_id: &str,
    directory: PathBuf,
    shell: &str,
) -> Result<(Client, PathBuf), String> {
    admit_at(host, Ok((root_id.into(), directory)), shell).await
}

async fn admit_at(
    mut host: HostClient,
    location: Result<(String, PathBuf), String>,
    shell: &str,
) -> Result<(Client, PathBuf), String> {
    let prepare = async {
        let (root_id, directory) = location?;
        if root_id.trim().is_empty() {
            return Err("expected Root id must not be empty".into());
        }
        if host.source().state_domain != root_id {
            return Err(format!(
                "application Host changed during {shell} startup admission"
            ));
        }
        if host.catalogue().describe("receipts")?.contract != receipt_reader_contract() {
            return Err("Host receipts endpoint has a different contract".into());
        }
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

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn migrate_legacy_storage(directory: &Path) -> io::Result<()> {
    let legacy_dir = directory.join("default");
    let dir_metadata = match fs::symlink_metadata(&legacy_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !dir_metadata.is_dir() || is_reparse_point(&dir_metadata) {
        return Ok(());
    }
    let legacy = legacy_dir.join("storage.json");
    let metadata = match fs::symlink_metadata(&legacy) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() || is_reparse_point(&metadata) {
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
                let Ok(current_meta) = fs::symlink_metadata(&current) else {
                    return Ok(());
                };
                if !current_meta.is_file() || is_reparse_point(&current_meta) {
                    return Ok(());
                }
                let Ok(current_bytes) = fs::read(&current) else {
                    return Ok(());
                };
                match serde_json::from_slice::<BTreeMap<String, String>>(&current_bytes) {
                    Ok(mut merged) => {
                        let mut changed = false;
                        for (key, value) in legacy_entries {
                            if let std::collections::btree_map::Entry::Vacant(entry) =
                                merged.entry(key)
                            {
                                entry.insert(value);
                                changed = true;
                            }
                        }
                        if changed {
                            write_storage_file(directory, &current, &merged, true)?;
                        }
                    }
                    Err(_) => {
                        let aside = current.with_extension("json.corrupt");
                        if fs::rename(&current, &aside).is_err() {
                            return Ok(());
                        }
                        write_storage_file(directory, &current, &legacy_entries, false)?;
                    }
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

    #[test]
    fn sets_aside_corrupt_current_storage_and_migrates_legacy() {
        let dir = tempfile::tempdir().unwrap();
        let legacy_dir = dir.path().join("default");
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(
            legacy_dir.join("storage.json"),
            r#"{"appearance-tray-icon":"line"}"#,
        )
        .unwrap();
        fs::write(dir.path().join("storage.json"), "not-json").unwrap();

        migrate_legacy_storage(dir.path()).unwrap();

        let migrated: BTreeMap<String, String> =
            serde_json::from_slice(&fs::read(dir.path().join("storage.json")).unwrap()).unwrap();
        assert_eq!(
            migrated.get("appearance-tray-icon").map(String::as_str),
            Some("line")
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("storage.json.corrupt")).unwrap(),
            "not-json"
        );
        assert!(!legacy_dir.join("storage.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn ignores_symlinked_legacy_file_directory_and_destination() {
        let dir = tempfile::tempdir().unwrap();

        let outside_file = dir.path().join("outside-file.json");
        fs::write(&outside_file, r#"{"k":"v"}"#).unwrap();
        let clients_file = dir.path().join("clients-file");
        fs::create_dir_all(clients_file.join("default")).unwrap();
        std::os::unix::fs::symlink(&outside_file, clients_file.join("default/storage.json"))
            .unwrap();
        migrate_legacy_storage(&clients_file).unwrap();
        assert!(!clients_file.join("storage.json").exists());
        assert!(outside_file.exists());

        let outside_dir = dir.path().join("outside-dir");
        fs::create_dir_all(&outside_dir).unwrap();
        fs::write(outside_dir.join("storage.json"), r#"{"k":"v"}"#).unwrap();
        let clients_dir = dir.path().join("clients-dir");
        fs::create_dir_all(&clients_dir).unwrap();
        std::os::unix::fs::symlink(&outside_dir, clients_dir.join("default")).unwrap();
        migrate_legacy_storage(&clients_dir).unwrap();
        assert!(!clients_dir.join("storage.json").exists());
        assert!(outside_dir.join("storage.json").exists());

        let external_current = dir.path().join("external-current.json");
        fs::write(&external_current, r#"{"existing":"1"}"#).unwrap();
        let clients_dest = dir.path().join("clients-dest");
        fs::create_dir_all(clients_dest.join("default")).unwrap();
        fs::write(clients_dest.join("default/storage.json"), r#"{"k":"v"}"#).unwrap();
        std::os::unix::fs::symlink(&external_current, clients_dest.join("storage.json")).unwrap();
        migrate_legacy_storage(&clients_dest).unwrap();
        assert!(
            clients_dest
                .join("storage.json")
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            fs::read_to_string(&external_current).unwrap(),
            r#"{"existing":"1"}"#
        );
        assert!(clients_dest.join("default/storage.json").exists());
    }

    async fn mock_host_client(
        state_domain: &str,
        receipts_contract: maka_plugin_core::contract::Contract,
    ) -> (HostClient, std::sync::Arc<std::sync::atomic::AtomicBool>) {
        use maka_host_runtime::application::{
            host::OpenChannel,
            transport::{Catalogue, Description, wire},
        };
        use maka_plugin_core::{composition::InstanceId, deployment::DeploymentRef};
        use serde_json::{Value, json};
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        use uuid::Uuid;

        let epoch = Uuid::from_u128(0x1111);
        let session = Uuid::from_u128(0x2222);
        let provider = InstanceId(vec![Uuid::from_u128(0x4444)]);
        let state_domain = state_domain.to_owned();
        let closed = Arc::new(AtomicBool::new(false));
        let closed_for_server = closed.clone();

        let description = Description {
            provider: provider.clone(),
            export: "receipts".into(),
            contract: receipts_contract,
            registration_epoch: Some(Uuid::from_u128(0x3333)),
        };
        let catalogue: Catalogue = serde_json::from_value(json!({
            "endpoints": {
                "receipts": description
            }
        }))
        .unwrap();

        let open: OpenChannel = Arc::new(move || {
            let state_domain = state_domain.clone();
            let catalogue = catalogue.clone();
            let provider = provider.clone();
            let closed_for_server = closed_for_server.clone();
            Box::pin(async move {
                let (client_io, mut server_io) = tokio::io::duplex(64 * 1024);
                tokio::spawn(async move {
                    let mut reader = wire::Reader::new(&mut server_io);
                    let _opening: Value = match reader.read().await {
                        Ok(value) => value,
                        Err(_) => return,
                    };
                    let source = DeploymentRef {
                        state_domain,
                        deployment: Uuid::from_u128(2),
                        revision: 1,
                    };
                    let response = json!({
                        "kind": "connected",
                        "value": {
                            "version": 1,
                            "epoch": epoch,
                            "session": session,
                            "source": source,
                            "consumers": {
                                "receipts": provider
                            },
                            "catalogue": catalogue,
                            "ui": null
                        }
                    });
                    if wire::write(&mut reader.inner, &response).await.is_err() {
                        return;
                    }
                    if let Ok(control) = reader.read::<Value>().await
                        && control["kind"] == "close"
                    {
                        closed_for_server.store(true, Ordering::SeqCst);
                        let _ = wire::write(&mut reader.inner, &json!({ "kind": "closed" })).await;
                    }
                });
                Ok(Box::new(client_io) as _)
            })
        });

        let client = HostClient::connect_on(open, Some(epoch), Some(Arc::from("ios-test")))
            .await
            .unwrap();
        (client, closed)
    }

    #[tokio::test]
    async fn admit_in_opens_journal_in_client_data_dir_when_root_and_contract_match() {
        use std::sync::atomic::Ordering;
        let temp = tempfile::TempDir::new().unwrap();
        let root_alpha = "a".repeat(64);
        let data_dir = temp.path().join("remote-host-a");
        let (host, closed) = mock_host_client(&root_alpha, receipt_reader_contract()).await;

        let (client, directory) = admit_in(host, &root_alpha, data_dir.clone(), "ios")
            .await
            .expect("remote admission should succeed");
        assert_eq!(directory, data_dir);
        assert!(data_dir.join("ios.sqlite").is_file());
        assert!(!closed.load(Ordering::SeqCst));

        client.close().await.unwrap();
        assert!(closed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn admit_in_rejects_mismatched_or_empty_root_id_and_closes_host() {
        use std::sync::atomic::Ordering;
        let temp = tempfile::TempDir::new().unwrap();
        let root_alpha = "a".repeat(64);
        let root_beta = "b".repeat(64);
        let (host_empty, closed_empty) =
            mock_host_client(&root_alpha, receipt_reader_contract()).await;
        let err_empty = match admit_in(host_empty, "   ", temp.path().to_path_buf(), "ios").await {
            Ok(_) => panic!("empty root id must fail"),
            Err(err) => err,
        };
        assert_eq!(err_empty, "expected Root id must not be empty");
        assert!(closed_empty.load(Ordering::SeqCst));

        let (host_mismatch, closed_mismatch) =
            mock_host_client(&root_alpha, receipt_reader_contract()).await;
        let err_mismatch =
            match admit_in(host_mismatch, &root_beta, temp.path().to_path_buf(), "ios").await {
                Ok(_) => panic!("mismatched root id must fail"),
                Err(err) => err,
            };
        assert_eq!(
            err_mismatch,
            "application Host changed during ios startup admission"
        );
        assert!(closed_mismatch.load(Ordering::SeqCst));
        assert!(!temp.path().join("ios.sqlite").exists());
    }
}
