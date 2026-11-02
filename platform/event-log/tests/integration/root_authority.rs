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

use maka_event_log::root::{ROOT_MARKER, RUST_ROOT_MARKER, RootNamespaces, RootOwner};
use std::{fs, path::Path};

fn namespaces(base: &Path) -> RootNamespaces {
    RootNamespaces {
        ownership: base.join("owners"),
        control: base.join("control"),
    }
}

#[test]
#[cfg(unix)]
fn identity_and_lease_survive_reopen_and_symlink_alias() {
    let temp = tempfile::tempdir().unwrap();
    let ns = namespaces(temp.path());
    let path = temp.path().join("root");
    assert!(maka_event_log::root::resolve(&path).is_err());
    assert!(
        !path.exists(),
        "read-only resolution must not create a root"
    );
    let owner = RootOwner::create(&path, &ns).unwrap();
    let id = owner.root_id().to_owned();
    assert_eq!(id.len(), 64);
    let marker: serde_json::Value =
        serde_json::from_slice(&fs::read(path.join(ROOT_MARKER)).unwrap()).unwrap();
    assert_eq!(marker["schemaVersion"], 1);
    assert_eq!(marker["kind"], "interactive");
    assert_eq!(marker["rootId"], id);
    let alias = temp.path().join("alias");
    std::os::unix::fs::symlink(&path, &alias).unwrap();
    let location = maka_event_log::root::resolve(&alias).unwrap();
    assert_eq!(location.root_id(), id);
    assert_eq!(location.canonical_path(), owner.canonical_path());
    assert!(RootOwner::open(&alias, &ns).is_err());
    owner.validate_current().unwrap();
    drop(owner);
    assert_eq!(RootOwner::open(&alias, &ns).unwrap().root_id(), id);
}

#[test]
fn configuration_rollback_journal_preserves_root_resolution_and_lease() {
    let temp = tempfile::tempdir().unwrap();
    let ns = namespaces(temp.path());
    let path = temp.path().join("root");
    let owner = RootOwner::create(&path, &ns).unwrap();
    let database = rusqlite::Connection::open(path.join("configuration-rust.sqlite")).unwrap();
    assert_eq!(
        database
            .pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
            .unwrap(),
        "delete"
    );
    database
        .execute_batch(
            "CREATE TABLE original(value INTEGER);
             BEGIN IMMEDIATE;
             INSERT INTO original VALUES(1);",
        )
        .unwrap();
    let journal = path.join("configuration-rust.sqlite-journal");
    assert!(
        journal.is_file(),
        "the actual SQLite writer must own a rollback journal"
    );
    assert_eq!(
        maka_event_log::root::resolve(&path).unwrap().root_id(),
        owner.root_id()
    );
    assert!(RootOwner::open(&path, &ns).is_err());
    database.execute_batch("ROLLBACK").unwrap();
    assert!(!journal.exists());
    drop(database);
    let id = owner.root_id().to_owned();
    drop(owner);
    assert_eq!(RootOwner::open(&path, &ns).unwrap().root_id(), id);
}

#[test]
fn copied_marker_and_rebound_path_cannot_reuse_identity() {
    let temp = tempfile::tempdir().unwrap();
    let ns = namespaces(temp.path());
    let path = temp.path().join("root");
    let owner = RootOwner::create(&path, &ns).unwrap();
    let copy = temp.path().join("copy");
    maka_event_log::root::repair_after_remount(&path, owner.root_id(), &ns).unwrap();
    assert!(maka_event_log::root::repair_after_remount(&path, &"0".repeat(64), &ns).is_err());
    fs::create_dir(&copy).unwrap();
    for name in [ROOT_MARKER, RUST_ROOT_MARKER] {
        fs::copy(path.join(name), copy.join(name)).unwrap();
    }
    assert!(RootOwner::open(&copy, &ns).is_err());
    assert!(maka_event_log::root::resolve(&copy).is_err());
    assert!(maka_event_log::root::repair_after_remount(&copy, owner.root_id(), &ns).is_err());
    fs::rename(&path, temp.path().join("moved")).unwrap();
    fs::rename(&copy, &path).unwrap();
    assert!(owner.validate_current().is_err());
}

#[test]
#[cfg(target_os = "linux")]
fn explicit_remount_preserves_authority_and_recovers_only_its_staging_file() {
    use maka_event_log::root::{repair_after_remount, resolve};
    let temp = tempfile::tempdir().unwrap();
    let ns = namespaces(temp.path());
    let path = temp.path().join("root");
    let owner = RootOwner::create(&path, &ns).unwrap();
    let id = owner.root_id().to_owned();
    let marker = path.join(ROOT_MARKER);
    let original: serde_json::Value = serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
    let mut stale = original.clone();
    stale["rootIdentity"]["dev"] = serde_json::json!("0");
    fs::write(&marker, serde_json::to_vec(&stale).unwrap()).unwrap();
    assert!(resolve(&path).is_err());
    assert!(
        repair_after_remount(&path, &id, &ns).is_err(),
        "repair bypassed the live owner lease"
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&fs::read(&marker).unwrap()).unwrap(),
        stale
    );
    drop(owner);
    let staging = path.join(".maka-storage-root.next");
    fs::write(&staging, b"abandoned partial write").unwrap();
    repair_after_remount(&path, &id, &ns).unwrap();
    assert!(!staging.exists());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&fs::read(&marker).unwrap()).unwrap(),
        original
    );
    let owner = RootOwner::open(&path, &ns).unwrap();
    fs::write(&staging, b"never promote this").unwrap();
    repair_after_remount(&path, &id, &ns).unwrap();
    assert!(
        staging.exists(),
        "no-op must not acquire leases just to clean staging"
    );
    owner.validate_current().unwrap();
    drop(owner);
    stale["rootIdentity"]["ino"] = serde_json::json!("0");
    fs::write(&marker, serde_json::to_vec(&stale).unwrap()).unwrap();
    assert!(repair_after_remount(&path, &id, &ns).is_err());
    assert_eq!(fs::read(staging).unwrap(), b"never promote this");
}

#[test]
#[cfg(unix)]
fn captured_directory_must_match_the_owner_even_after_the_path_is_restored() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("root");
    let retained = temp.path().join("retained");
    let owner = RootOwner::create(&path, &namespaces(temp.path())).unwrap();
    let original = fs::File::open(&path).unwrap();
    owner.validate_directory_handle(&original).unwrap();
    assert!(
        owner
            .validate_directory_handle(&fs::File::open(path.join(ROOT_MARKER)).unwrap())
            .is_err()
    );
    // Capture a replacement between path checks, then restore the original.
    fs::rename(&path, &retained).unwrap();
    fs::create_dir(&path).unwrap();
    let replacement = fs::File::open(&path).unwrap();
    fs::remove_dir(&path).unwrap();
    fs::rename(&retained, &path).unwrap();
    owner.validate_current().unwrap();
    assert!(owner.validate_directory_handle(&replacement).is_err());
    owner.validate_directory_handle(&original).unwrap();
    // The original inode alone cannot revive a fenced owner either.
    fs::rename(&path, &retained).unwrap();
    assert!(owner.validate_directory_handle(&original).is_err());
}
