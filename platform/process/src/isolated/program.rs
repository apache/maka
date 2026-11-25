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

use super::{BoundCommand, BoundTarget, Error, TaskOwner};
use crate::Command;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::Path,
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

/// A held installer file and its digest from the trusted release receipt.
pub struct ProgramFile {
    pub name: &'static str,
    pub source: File,
    pub sha256: [u8; 32],
}

/// Native-only dispatch input. Neither the command JSON nor a recovery record
/// can supply a handle or ask the Host to open a private pathname.
pub struct InstalledProgram {
    pub executable: ProgramFile,
    pub helper: ProgramFile,
    pub helper_env: &'static str,
}

impl ProgramFile {
    fn deliver(&self, directory: &Path, stop: &CancellationToken) -> Result<(), Error> {
        if Path::new(self.name).file_name() != Some(std::ffi::OsStr::new(self.name)) {
            return Err(io::Error::other("runtime filename must be a basename").into());
        }
        let path = directory.join(self.name);
        let mut output = File::create_new(&path)?;
        let mut input = (&self.source).take(self.source.metadata()?.len());
        let mut digest = Sha256::new();
        let mut buffer = [0; 65536];
        loop {
            if stop.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count])?;
            digest.update(&buffer[..count]);
        }
        if digest.finalize()[..] != self.sha256 {
            return Err(Error::IsolationUnavailable(
                "installed runtime differs from its receipt".into(),
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            output.set_permissions(fs::Permissions::from_mode(0o500))?;
        }
        Ok(())
    }
}

impl InstalledProgram {
    pub(super) fn deliver(
        &self,
        owner: &Path,
        runtime: &Path,
        stop: &CancellationToken,
    ) -> Result<(), Error> {
        // Publish the pair together, after verifying exactly the bytes written.
        let staging = tempfile::tempdir_in(owner)?;
        self.executable.deliver(staging.path(), stop)?;
        self.helper.deliver(staging.path(), stop)?;
        fs::rename(staging.path(), runtime)?;
        #[cfg(windows)]
        for path in [
            runtime.to_path_buf(),
            runtime.join(self.executable.name),
            runtime.join(self.helper.name),
        ] {
            reset_inherited_dacl(&path)?;
        }
        Ok(())
    }
}

#[cfg(windows)]
fn reset_inherited_dacl(path: &Path) -> io::Result<()> {
    use std::os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    };
    use windows_sys::Win32::{
        Foundation::ERROR_SUCCESS,
        Security::{
            ACL, ACL_REVISION_DS,
            Authorization::{SE_FILE_OBJECT, SetSecurityInfo},
            DACL_SECURITY_INFORMATION, InitializeAcl, UNPROTECTED_DACL_SECURITY_INFORMATION,
        },
        Storage::FileSystem::{
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, READ_CONTROL, WRITE_DAC,
        },
    };

    let file = fs::OpenOptions::new()
        .access_mode(READ_CONTROL | WRITE_DAC)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "installed runtime path is a reparse point",
        ));
    }
    let mut storage = [0u32; size_of::<ACL>().div_ceil(4)];
    let acl = storage.as_mut_ptr().cast::<ACL>();
    // SAFETY: DWORD-aligned storage has at least size_of::<ACL>() bytes.
    if unsafe { InitializeAcl(acl, size_of_val(&storage) as u32, ACL_REVISION_DS) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // Same-volume rename from owner/ preserves ACEs inherited from owner/ (such as a
    // prior Account slot's Deny ACE) as explicit entries. Clearing explicit ACEs and
    // unprotecting inheritance makes the published runtime inherit purely from inputs/.
    // SAFETY: live handle with READ_CONTROL | WRITE_DAC and initialized empty ACL.
    let status = unsafe {
        SetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            acl,
            std::ptr::null_mut(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    Ok(())
}

impl TaskOwner {
    pub async fn bind_installed_program(
        &mut self,
        command: &mut Command,
        program: Arc<InstalledProgram>,
    ) -> Result<(), Error> {
        if self.bound_command.is_some() || self.snapshot.is_none() {
            return Err(Error::IsolationUnavailable(
                "installed program requires an unbound isolated task".into(),
            ));
        }
        let helper = self.inputs().join("runtime").join(program.helper.name);
        command.env(program.helper_env, helper);
        let identity = command.selection.get_or_init(|| Arc::new(())).clone();
        self.bound_command = Some(BoundCommand {
            identity,
            target: BoundTarget::Installed(program),
        });
        Ok(())
    }
}

/// Reclaim staged per-task runtime binaries after closure or aborted launch.
/// Replay and publication only read `owner/`, `baseline/`, `workspace/`, and `home/`.
pub(super) fn remove_runtime(resource: &Path) -> io::Result<()> {
    let _resource = super::evidence::open_resource(resource)?;
    let runtime = resource.join("inputs").join("runtime");
    match fs::symlink_metadata(&runtime) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "installed runtime path is not an owned directory",
                ));
            }
            fs::remove_dir_all(&runtime)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_delivery_never_publishes_a_partial_runtime() {
        let root = tempfile::tempdir().unwrap();
        let owner = root.path().join("owner");
        let inputs = root.path().join("inputs");
        let runtime = inputs.join("runtime");
        fs::create_dir(&owner).unwrap();
        fs::create_dir(&inputs).unwrap();
        let source = |name| root.path().join(name);
        let file = |name| ProgramFile {
            name,
            source: File::open(source(name)).unwrap(),
            sha256: Sha256::digest(b"original").into(),
        };
        let program = || InstalledProgram {
            executable: file("server"),
            helper: file("helper"),
            helper_env: "HARNESS",
        };
        let stop = CancellationToken::new();
        for tampered in ["server", "helper"] {
            for name in ["server", "helper"] {
                fs::write(source(name), b"original").unwrap();
            }
            let held = program();
            fs::write(source(tampered), b"modified").unwrap();
            assert!(matches!(
                held.deliver(&owner, &runtime, &stop),
                Err(Error::IsolationUnavailable(_))
            ));
            assert!(!runtime.exists());
            assert_eq!(owner.read_dir().unwrap().count(), 0);
        }

        fs::write(source("helper"), b"original").unwrap();
        fs::create_dir(&runtime).unwrap();
        fs::write(runtime.join("sentinel"), b"existing runtime").unwrap();
        assert!(program().deliver(&owner, &runtime, &stop).is_err());
        assert_eq!(
            fs::read(runtime.join("sentinel")).unwrap(),
            b"existing runtime"
        );
        assert_eq!(runtime.read_dir().unwrap().count(), 1);
        assert_eq!(owner.read_dir().unwrap().count(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn delivered_runtime_clears_owner_deny_aces_and_inherits_inputs_grants() {
        use maka_sandbox::{
            filesystem::Scope,
            windows::acl::{self, Permission, Target},
        };

        // Builtin Guests is a real well-known SID with no initial access to PrivateSecurity dirs.
        const ACCOUNT_SID: &str = "S-1-5-32-546";

        let root = tempfile::tempdir().unwrap();
        let namespace = root.path().join("ns");
        let resource = super::super::fs::create_resource(&namespace).unwrap();
        let owner = resource.join("owner");
        let inputs = resource.join("inputs");
        let runtime = inputs.join("runtime");

        let (_, owner_handle) = Target::capture(&owner).unwrap();
        acl::set(
            &owner_handle,
            ACCOUNT_SID,
            Scope::Subtree,
            Some(Permission::Deny),
        )
        .unwrap();

        let source_dir = root.path().join("source");
        fs::create_dir(&source_dir).unwrap();
        let make_file = |name: &'static str| {
            let path = source_dir.join(name);
            fs::write(&path, b"binary").unwrap();
            ProgramFile {
                name,
                source: File::open(&path).unwrap(),
                sha256: Sha256::digest(b"binary").into(),
            }
        };
        let program = InstalledProgram {
            executable: make_file("server.exe"),
            helper: make_file("helper.exe"),
            helper_env: "HARNESS",
        };
        program
            .deliver(&owner, &runtime, &CancellationToken::new())
            .unwrap();

        let targets = [
            runtime.clone(),
            runtime.join("server.exe"),
            runtime.join("helper.exe"),
        ];
        for path in &targets {
            let (_, handle) = Target::capture(path).unwrap();
            assert!(
                !acl::allows_any_read(&handle, ACCOUNT_SID).unwrap(),
                "delivered runtime must remain private before inputs/ is granted: {}",
                path.display()
            );
        }

        let (_, inputs_handle) = Target::capture(&inputs).unwrap();
        acl::set(
            &inputs_handle,
            ACCOUNT_SID,
            Scope::Subtree,
            Some(Permission::Read),
        )
        .unwrap();

        for path in &targets {
            let (_, handle) = Target::capture(path).unwrap();
            assert!(
                acl::allows_read(&handle, ACCOUNT_SID).unwrap(),
                "delivered runtime must inherit inputs/ Read+Execute without stale owner/ Deny: {}",
                path.display()
            );
        }
    }
}
