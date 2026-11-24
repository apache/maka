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

use super::{BoundCommand, Error, TaskOwner};
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
    fn deliver(&self, owner: &Path, runtime: &Path, stop: &CancellationToken) -> Result<(), Error> {
        // Publish the pair together, after verifying exactly the bytes written.
        let staging = tempfile::tempdir_in(owner)?;
        self.executable.deliver(staging.path(), stop)?;
        self.helper.deliver(staging.path(), stop)?;
        fs::rename(staging.path(), runtime)?;
        Ok(())
    }
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
        let directory = self.inputs().join("runtime");
        let private = self.resource.join("owner");
        let stop = self.cancellation.clone();
        let helper_env = program.helper_env;
        let (executable, file, helper) = tokio::task::spawn_blocking(move || {
            program.deliver(&private, &directory, &stop)?;
            let executable = directory.join(program.executable.name);
            let file = File::open(&executable)?;
            Ok::<_, Error>((executable, file, directory.join(program.helper.name)))
        })
        .await
        .map_err(io::Error::other)??;
        command.env(helper_env, helper);
        let identity = command.selection.get_or_init(|| Arc::new(())).clone();
        self.bound_command = Some(BoundCommand {
            identity,
            executable,
            _file: file,
        });
        Ok(())
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
}
