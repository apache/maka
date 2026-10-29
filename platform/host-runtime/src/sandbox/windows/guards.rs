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

use super::store;
use maka_event_log::root::{
    FileLease,
    windows::{account_home, create_private_file, open_nofollow, publish_file, validate_private},
};
use maka_sandbox::{
    filesystem::{Access, Compiled, Rule, Scope},
    windows::{
        acl::{Removal, Target},
        ensure_drained,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io,
    os::windows::io::AsRawHandle,
    path::{Path, PathBuf},
};
use uuid::Uuid;
use windows_sys::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, VOLUME_NAME_GUID};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    source: PathBuf,
    destination: PathBuf,
    directory: bool,
}

/// Shared across installations belonging to this OS account. Each consumer
/// records its actual native Job before launch: a crashed Host's closed handles
/// alone do not prove that all of its descendants have stopped.
pub(super) struct Guards {
    root: PathBuf,
    id: Uuid,
    lease: FileLease,
    pins: Vec<File>,
}

pub(super) fn registry_root() -> io::Result<PathBuf> {
    account_home().map(|home| home.join(".maka-sandbox-guards"))
}

pub(super) fn recover() -> io::Result<()> {
    let root = registry_root()?;
    if !root.try_exists()? {
        return Ok(());
    }
    let _gate = store::admission(&root)?;
    collect(&root)
}
impl Guards {
    pub fn prepare(policy: &Compiled) -> io::Result<Self> {
        if policy.policy().default != Access::Read || !policy.policy().deny_globs.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Windows account sandbox requires a read-default path snapshot",
            ));
        }
        Self::prepare_rules(
            policy,
            policy
                .policy()
                .rules
                .iter()
                .filter(|rule| rule.access != Access::Write)
                .collect(),
            false,
        )
    }

    /// PSEC ignores missing grants and does not prevent renaming a writable
    /// ancestor around a read-only carveout. Materialize only those boundaries;
    /// native deny paths remain with the native enforcement owner.
    pub fn prepare_native(policy: &Compiled) -> io::Result<Self> {
        if !policy.policy().deny_globs.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "native filesystem guards require a process policy snapshot",
            ));
        }
        let rules = policy
            .policy()
            .rules
            .iter()
            .filter(|rule| {
                rule.access == Access::Read && policy.inherited_access(rule) == Access::Write
            })
            .collect::<Vec<_>>();
        Self::prepare_rules(policy, rules, true)
    }

    fn prepare_rules(policy: &Compiled, rules: Vec<&Rule>, native: bool) -> io::Result<Self> {
        // Resolve through the account token, not USERPROFILE or a particular
        // State Root. Separate Hosts must coordinate on the same namespace.
        let root = registry_root()?;
        maka_event_log::root::private_directory(&root)?;
        store::lease_file(&root.join("admission.lock"))?;
        let _gate = store::admission(&root)?;
        collect(&root)?;
        let id = Uuid::new_v4();
        let name = format!("lease-{id}");
        store::lease_file(&root.join(format!("{name}.lock")))?;
        let lease = FileLease::acquire(&root.join(format!("{name}.lock")))?;
        let mut pins = Vec::new();
        let mut targets = Vec::new();
        let result = (|| {
            let (target, pin) = Target::pin_read(&root)?;
            preflight(&pin, &rules)?;
            targets.push(target);
            pins.push(pin);
            if native {
                // Native deny paths do not pin their writable ancestors. The
                // registry namespace must stay stable for every native tree,
                // including policies with no read-only carveouts.
                pin_writable_ancestors(policy, &root, &mut targets, &mut pins)?;
            }
            for rule in rules {
                materialize(&root, &rule.path, rule.scope == Scope::Subtree, native)?;
                let (target, pin) = if native {
                    Target::pin_read(&rule.path)?
                } else {
                    Target::pin(&rule.path)?
                };
                if !targets.contains(&target) {
                    targets.push(target);
                    pins.push(pin);
                }
                if native {
                    pin_writable_ancestors(policy, &rule.path, &mut targets, &mut pins)?;
                }
            }
            store::publish(&root, &format!("{name}.json"), &targets)
        })();
        if let Err(error) = result {
            drop(pins);
            drop(lease);
            return match collect(&root) {
                Ok(()) => Err(error),
                Err(cleanup) => Err(io::Error::other(
                    maka_agent_facts::tools::ToolError::CleanupUnconfirmed(cleanup.to_string()),
                )),
            };
        }
        Ok(Self {
            root,
            id,
            lease,
            pins,
        })
    }

    /// Persist before the first native process is created.
    pub fn bind(&self, execution: Uuid) -> io::Result<()> {
        let _gate = store::admission(&self.root)?;
        store::publish(
            &self.root,
            &format!("lease-{}.job.json", self.id),
            &execution,
        )
    }

    pub fn finish(self) -> io::Result<()> {
        let Self {
            root, lease, pins, ..
        } = self;
        drop(pins);
        drop(lease);
        let _gate = store::admission(&root)?;
        collect(&root)
    }
}

fn materialize(root: &Path, path: &Path, directory: bool, native: bool) -> io::Result<()> {
    match path.symlink_metadata() {
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("guard has no parent"))?;
    materialize(root, parent, true, native)?;
    let (_identity, _parent) = if native {
        Target::pin_read(parent)?
    } else {
        Target::pin(parent)?
    };
    let id = Uuid::new_v4();
    let name = format!("guard-{id}");
    let pending = Pending {
        source: root.join(format!(".maka-guard-{id}")),
        destination: path.to_owned(),
        directory,
    };
    // Native peers share the Host's OS account, so their PSEC policy denies the
    // entire registry. Account-backed peers are excluded by the private DACL.
    // After publication recovery follows only the durable object identity.
    store::publish(root, &format!("{name}.pending.json"), &pending)?;
    if directory {
        maka_event_log::root::private_directory(&pending.source)?;
    } else {
        create_private_file(&pending.source)?.sync_all()?;
    }
    let (target, file) = Target::capture(&pending.source)?;
    store::publish(root, &format!("{name}.json"), &target)?;
    drop(file);
    publish_file(&pending.source, path)
}

fn pin_writable_ancestors(
    policy: &Compiled,
    path: &Path,
    targets: &mut Vec<Target>,
    pins: &mut Vec<File>,
) -> io::Result<()> {
    for ancestor in path.ancestors().skip(1) {
        if policy.access(ancestor) == Access::Write {
            let (target, pin) = Target::pin_read(ancestor)?;
            if !targets.contains(&target) {
                targets.push(target);
                pins.push(pin);
            }
        }
    }
    Ok(())
}

/// Publishing a placeholder is an atomic, no-replace rename. Check the actual
/// volume identity of every missing boundary's existing parent before creating
/// any staging objects, rather than relying on drive letters or copy fallback.
fn preflight(registry: &File, rules: &[&Rule]) -> io::Result<()> {
    let registry_volume = volume_identity(registry)?;
    for rule in rules {
        match rule.path.symlink_metadata() {
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        for parent in rule.path.ancestors().skip(1) {
            match parent.symlink_metadata() {
                Ok(metadata) => {
                    if !metadata.is_dir() {
                        return Err(io::Error::new(
                            io::ErrorKind::NotADirectory,
                            "guard parent is not a directory",
                        ));
                    }
                    let (_, file) = Target::pin_read(parent)?;
                    if volume_identity(&file)? != registry_volume {
                        return Err(io::Error::new(
                            io::ErrorKind::Unsupported,
                            "missing filesystem boundaries require atomic publication from the guard registry on the same volume",
                        ));
                    }
                    break;
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
    }
    Ok(())
}

fn volume_identity(file: &File) -> io::Result<Uuid> {
    // SAFETY: the first call only queries the required UTF-16 buffer length.
    let capacity = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            std::ptr::null_mut(),
            0,
            VOLUME_NAME_GUID,
        )
    };
    if capacity == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = vec![0u16; capacity as usize];
    // SAFETY: valid held file and an output buffer with the reported capacity.
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            capacity,
            VOLUME_NAME_GUID,
        )
    };
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    if length >= capacity {
        return Err(io::Error::other(
            "guard volume namespace changed during preparation",
        ));
    }
    let name = String::from_utf16(&buffer[..length as usize]).map_err(io::Error::other)?;
    name.strip_prefix(r"\\?\Volume{")
        .and_then(|name| name.split_once(r"}\"))
        .and_then(|(id, _)| id.parse().ok())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::Unsupported,
                "guard publication requires a local volume identity",
            )
        })
}

fn active_targets(root: &Path) -> io::Result<Vec<Target>> {
    let mut active = Vec::new();
    for entry in fs::read_dir(root)? {
        let filename = entry?.file_name();
        let Some(name) = filename
            .to_str()
            .and_then(|name| name.strip_suffix(".lock"))
            .filter(|name| name.starts_with("lease-"))
        else {
            continue;
        };
        let lock = root.join(format!("{name}.lock"));
        let lease = match FileLease::acquire(&lock) {
            Ok(lease) => Some(lease),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => None,
            Err(error) => return Err(error),
        };
        let job: Option<Uuid> = store::read(&root.join(format!("{name}.job.json")))?;
        let mut running = lease.is_none();
        if let Some(job) = job {
            match ensure_drained(job) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => running = true,
                Err(error) => return Err(error),
            }
        }
        if running {
            active.extend(store::required::<Vec<Target>>(
                &root.join(format!("{name}.json")),
            )?);
        } else {
            for suffix in ["job.json", "json"] {
                store::remove(&root.join(format!("{name}.{suffix}")))?;
            }
            drop(lease);
            // Unique execution identities are never reused; unlinking this
            // inactive lease cannot split future lifecycle ownership.
            store::remove(&lock)?;
        }
    }
    Ok(active)
}

fn collect(root: &Path) -> io::Result<()> {
    let active = active_targets(root)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(root)? {
        let filename = entry?.file_name();
        let Some(name) = filename
            .to_str()
            .and_then(|name| name.strip_suffix(".pending.json"))
            .filter(|name| name.starts_with("guard-"))
        else {
            continue;
        };
        let pending: Pending = store::required(&root.join(format!("{name}.pending.json")))?;
        let target = store::read::<Target>(&root.join(format!("{name}.json")))?;
        entries.push((name.to_owned(), pending, target));
    }
    let active_paths: Vec<_> = entries
        .iter()
        .filter(|(_, _, target)| {
            target
                .as_ref()
                .is_some_and(|target| active.contains(target))
        })
        .map(|(_, pending, _)| pending.destination.clone())
        .collect();
    // Children precede synthetic parents. Parents of live guards must remain
    // recorded, rather than being mistaken for user-populated directories.
    entries
        .sort_by_key(|(_, pending, _)| std::cmp::Reverse(pending.destination.components().count()));
    for (name, pending, target) in entries {
        if active_paths
            .iter()
            .any(|path| path.starts_with(&pending.destination))
        {
            continue;
        }
        if let Some(target) = target {
            match target.remove_empty()? {
                Removal::InUse => continue,
                Removal::Removed | Removal::Preserved => remove_record(root, &name)?,
            }
        } else {
            // Publication cannot precede the durable identity record. The only
            // possible orphan is the private staging name from this intent.
            match open_nofollow(&pending.source, false) {
                Ok(file) => {
                    validate_private(&file)?;
                    drop(file);
                    let (target, file) = Target::capture(&pending.source)?;
                    drop(file);
                    match target.remove_empty()? {
                        Removal::InUse => continue,
                        Removal::Removed | Removal::Preserved => {}
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            remove_record(root, &name)?;
        }
    }
    Ok(())
}

fn remove_record(root: &Path, name: &str) -> io::Result<()> {
    // The object was removed or preserved as user data before either record
    // disappears. An interrupted removal of the second record is harmless.
    store::remove(&root.join(format!("{name}.json")))?;
    store::remove(&root.join(format!("{name}.pending.json")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_sandbox::{
        filesystem::{Policy, Rule},
        windows::ExecutionJob,
    };
    use std::os::windows::io::AsHandle;

    #[test]
    fn protection_outlives_peer_settlement_and_a_lost_host_until_its_native_tree_exits() {
        protection_lifetime(Guards::prepare);
    }

    #[test]
    fn native_protection_outlives_peer_settlement_and_a_lost_host_until_its_tree_exits() {
        protection_lifetime(Guards::prepare_native);
    }

    fn protection_lifetime(prepare: fn(&Compiled) -> io::Result<Guards>) {
        let directory = tempfile::tempdir().unwrap();
        let canonical = directory.path().canonicalize().unwrap();
        let root =
            std::path::Path::new(maka_fs_tools::workspace::project::host_path(&canonical).unwrap());
        let boundary = root.join("missing/protected");
        let policy = Policy {
            default: Access::Read,
            rules: vec![
                Rule::subtree(root, Access::Write),
                Rule::subtree(&boundary, Access::Read),
            ],
            deny_globs: vec![],
        }
        .compile()
        .unwrap();
        let first = prepare(&policy).unwrap();
        let survivor = prepare(&policy).unwrap();
        first.finish().unwrap();
        assert!(
            boundary.is_dir(),
            "one consumer must not revoke its peer's protection"
        );

        let id = Uuid::new_v4();
        let job = ExecutionJob::create(id).unwrap();
        let executable = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        let mut child = std::process::Command::new(executable)
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        job.assign(child.as_handle()).unwrap();
        survivor.bind(id).unwrap();
        drop(survivor); // Lost Host handles do not prove the Job has drained.
        let result = recover();
        let retained = boundary.is_dir();
        drop(job);
        child.wait().unwrap();
        result.unwrap();
        assert!(
            retained,
            "recovery must observe the native execution, not only file leases"
        );
        recover().unwrap();
        assert!(
            !root.join("missing").exists(),
            "last settlement must collect empty synthetic parents"
        );
    }
}
