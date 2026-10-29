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

//! Optional default reads belong to the installation, not an execution slot.
//! A disposable helper owns propagation. Foreground preparation quiesces it
//! before editing ACLs; interrupted roots retain an intent and are retried.
//! This preserves the global ACL merge lock without putting a recursive read
//! grant on the command's startup or shutdown path.
use super::{Configured, Installation, SetupRequest, store};
use maka_sandbox::{
    filesystem::Scope,
    windows::{
        ExecutionJob,
        acl::{self, Permission, Target},
    },
};
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    os::windows::io::BorrowedHandle,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use uuid::Uuid;

pub const READ_PREPARATION: &str = "--sandbox-prepare-reads";

const EXCLUDED: &[&str] = &[
    ".ssh",
    ".tsh",
    ".brev",
    ".gnupg",
    ".aws",
    ".azure",
    ".kube",
    ".docker",
    ".config",
    ".npm",
    ".pki",
    ".terraform.d",
    ".maka",
    ".codex",
];

/// The same OS user's installations share one preparation lane. An empty Job
/// reserves it for foreground work; only a read helper assigns its own process.
/// A foreground caller may stop that helper, never an accepted command.
pub(super) struct Foreground {
    _job: ExecutionJob,
}
impl Foreground {
    pub(super) fn acquire() -> io::Result<Self> {
        let id = preparation_id()?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            maka_sandbox::windows::stop_preparation(id)?;
            match preparation_job(id) {
                Ok(job) => return Ok(Self { _job: job }),
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                result => return result.map(|job| Self { _job: job }),
            }
        }
    }
}

fn preparation_id() -> io::Result<Uuid> {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(b"Maka default read preparation\0");
    hash.update(maka_event_log::root::windows::account_sid()?.as_bytes());
    Ok(Uuid::from_bytes(
        hash.finalize()[..16].try_into().expect("SHA-256 prefix"),
    ))
}

fn preparation_job(id: Uuid) -> io::Result<ExecutionJob> {
    ExecutionJob::preparation(id, &maka_event_log::root::windows::account_sid()?)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Grant {
    group: String,
    scope: Scope,
    target: Target,
}

/// Spawn no elevated or long-lived service. Only the private installation
/// selects the identities and roots; command arguments carry no credentials.
pub(super) fn start(state_root: &Path, helper: &Path) {
    let result = state_root
        .to_str()
        .ok_or_else(|| io::Error::other("sandbox state root must be UTF-8"))
        .and_then(|root| maka_process::bootstrap::background(helper, &[READ_PREPARATION, root]));
    if let Err(error) = result {
        eprintln!("Windows default read preparation could not start: {error}");
    }
}

/// Entrypoint for the disposable, ordinary-user helper. Call only in its own
/// process: its Job is deliberately retained until process exit.
pub fn prepare_default_reads(state_root: &Path) -> io::Result<()> {
    let job = match preparation_job(preparation_id()?) {
        Ok(job) => job,
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
        Err(error) => return Err(error),
    };
    // SAFETY: the pseudo-handle is borrowed only for this native call.
    job.assign(unsafe {
        BorrowedHandle::borrow_raw(windows_sys::Win32::System::Threading::GetCurrentProcess())
    })?;
    // Closing a kill-on-close Job containing ourselves would terminate this
    // process before ordinary cleanup. Process exit closes this sole owner.
    std::mem::forget(job);
    // Native recursive ACL work is not cooperatively cancellable. A bounded
    // helper lifetime leaves the current intent pending rather than keeping an
    // application shutdown or a lost observer alive indefinitely.
    std::thread::Builder::new()
        .name("read-preparation-deadline".into())
        .spawn(|| {
            std::thread::sleep(Duration::from_secs(30));
            std::process::exit(1);
        })?;
    let installation = Installation::new(state_root);
    let _lifecycle = store::shared_lease(&installation.root.join("lifecycle.lock"))?;
    if installation.root.join("removing").try_exists()? {
        return Ok(());
    }
    let request: SetupRequest = store::required(&installation.root.join("installation.json"))?;
    request.validate_owner()?;
    let configured: Configured = store::required(&installation.root.join("ready.json"))?;
    request.validate(&configured)?;
    if request.read_group()?.resolve()?.as_deref() != Some(configured.read_group_sid.as_str()) {
        return Err(super::setup_required());
    }
    let _admission = store::admission(&installation.root)?;
    let owner = maka_event_log::root::windows::account_sid()?;
    for path in roots()? {
        let (target, file) = match Target::capture(&path) {
            Ok(target) => target,
            // Default reads never take ownership of protected/system objects.
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::PermissionDenied | io::ErrorKind::NotFound
                ) =>
            {
                continue;
            }
            Err(error) => {
                eprintln!(
                    "default read target {} unavailable: {error}",
                    path.display()
                );
                continue;
            }
        };
        if !acl::manageable_by(&file, &owner)? {
            continue;
        }
        let mut public = false;
        for identity in ["S-1-5-32-545", "S-1-5-11", "S-1-1-0"] {
            if acl::allows_read(&file, identity)? {
                public = true;
                break;
            }
        }
        if public {
            continue;
        }
        let scope = if file.metadata()?.is_dir() {
            Scope::Subtree
        } else {
            Scope::Exact
        };
        Grant {
            group: configured.read_group_sid.clone(),
            scope,
            target,
        }
        .apply(&installation.root, &file)?;
    }
    Ok(())
}

impl Grant {
    fn apply(&self, root: &Path, file: &fs::File) -> io::Result<()> {
        let name = grant_name(&self.target)?;
        let ready = root.join(format!("{name}.ready"));
        if store::read::<bool>(&ready)? == Some(true) && acl::allows_read(file, &self.group)? {
            return Ok(());
        }
        // Identity is durable before the first ACL edit. Ready is published
        // only after recursive propagation, never inferred from the root ACE.
        store::publish(root, &format!("{name}.json"), self)?;
        store::remove(&ready)?;
        store::remove(&root.join(format!("{name}.error")))?;
        match acl::set(file, &self.group, self.scope, Some(Permission::Read)) {
            Ok(()) => store::publish(root, &format!("{name}.ready"), &true)?,
            Err(error) => {
                store::publish(root, &format!("{name}.error"), &error.to_string())?;
            }
        }
        Ok(())
    }
}

fn grant_name(target: &Target) -> io::Result<String> {
    use sha2::{Digest, Sha256};
    let bytes = serde_json::to_vec(target).map_err(io::Error::other)?;
    Ok(format!("read-{}", hex::encode(Sha256::digest(bytes))))
}

fn roots() -> io::Result<Vec<PathBuf>> {
    // Use the account profile, not an overridable USERPROFILE environment value.
    let home = maka_event_log::root::windows::account_home()?;
    let mut roots = Vec::new();
    for entry in fs::read_dir(home)? {
        let entry = entry?;
        if !EXCLUDED.iter().any(|name| {
            entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(name)
        }) {
            roots.push(entry.path());
        }
    }
    // System directories already readable by standard users need no extra ACE;
    // do not request WRITE_DAC or recurse through them just to confirm that.
    roots.sort();
    Ok(roots)
}

/// Exclusive lifecycle ownership, after stopping the helper and draining work.
pub(super) fn recover(root: &Path) -> io::Result<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let filename = entry.file_name();
        if filename
            .to_str()
            .is_some_and(|name| name.starts_with(".read-") && name.ends_with(".pending"))
        {
            // An interrupted publication cannot have authorized a native edit.
            // Validate the private file before discarding its staging bytes.
            store::remove(&entry.path())?;
            continue;
        }
        let Some(name) = filename
            .to_str()
            .and_then(|name| name.strip_suffix(".json"))
            .filter(|name| name.starts_with("read-"))
        else {
            continue;
        };
        let grant: Grant = store::required(&entry.path())?;
        store::remove(&root.join(format!("{name}.ready")))?;
        if let Some(file) = grant.target.reopen()? {
            acl::set(&file, &grant.group, grant.scope, None)?;
        }
        store::remove(&root.join(format!("{name}.error")))?;
        store::remove(&entry.path())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_read_propagation_is_retried_and_recovery_tracks_the_original_object() {
        let directory = tempfile::tempdir().unwrap();
        let journal = directory.path().join("journal");
        maka_event_log::root::private_directory(&journal).unwrap();
        let tree = directory.path().join("tree");
        fs::create_dir(&tree).unwrap();
        let leaf = tree.join("leaf");
        fs::write(&leaf, "private").unwrap();
        let (target, file) = Target::capture(&tree).unwrap();
        let (_, leaf_file) = Target::capture(&leaf).unwrap();
        let identity = maka_sandbox::windows::WriteCapability::new(Uuid::new_v4());
        let grant = Grant {
            group: identity.sid().into(),
            scope: Scope::Subtree,
            target,
        };
        let name = grant_name(&grant.target).unwrap();
        store::publish(&journal, &format!("{name}.json"), &grant).unwrap();
        // Simulate a process dying after editing the root, before descendants.
        acl::set(&file, identity.sid(), Scope::Exact, Some(Permission::Read)).unwrap();
        assert!(acl::allows_read(&file, identity.sid()).unwrap());
        assert!(!acl::allows_read(&leaf_file, identity.sid()).unwrap());
        grant.apply(&journal, &file).unwrap();
        assert!(acl::allows_read(&leaf_file, identity.sid()).unwrap());
        assert_eq!(
            store::read::<bool>(&journal.join(format!("{name}.ready"))).unwrap(),
            Some(true)
        );
        grant.apply(&journal, &file).unwrap();
        drop(leaf_file);
        fs::rename(&tree, directory.path().join("moved")).unwrap();
        fs::create_dir(&tree).unwrap();
        recover(&journal).unwrap();
        let (_, leaf_file) = Target::capture(&directory.path().join("moved/leaf")).unwrap();
        assert!(!acl::allows_read(&file, identity.sid()).unwrap());
        assert!(!acl::allows_read(&leaf_file, identity.sid()).unwrap());
        assert!(tree.is_dir(), "cleanup must not adopt the replacement path");
        assert_eq!(fs::read_dir(&journal).unwrap().count(), 0);
    }
}
