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

//! Read-only observations of a particular kernel process lifetime.
//!
//! Serialized identities are observation data, not grants or evidence that a
//! process has exited. Only a fresh same-origin probe can issue a gone proof.
//! A proof says nothing about descendants, pending effects, or root ownership.

use serde::{Deserialize, Serialize};
use std::io;

#[cfg(target_os = "linux")]
#[path = "lifetime/linux.rs"]
mod native;
#[cfg(target_os = "macos")]
#[path = "lifetime/macos.rs"]
mod native;
#[cfg(windows)]
#[path = "lifetime/windows.rs"]
mod native;
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
#[path = "lifetime/unsupported.rs"]
mod native;

/// A PID, its kernel start identity, and the kernel origin of that observation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessIdentity {
    pid: u32,
    instance: Instance,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "platform", rename_all = "camelCase", deny_unknown_fields)]
enum Instance {
    Linux {
        origin: LinuxOrigin,
        start_ticks: u64,
    },
    MacOs {
        boot_session_uuid: String,
        start_seconds: u64,
        start_microseconds: u64,
    },
    Windows {
        boot_identifier: [u8; 16],
        creation_time: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LinuxOrigin {
    boot_id: String,
    pid_namespace_device: u64,
    pid_namespace_inode: u64,
}

impl ProcessIdentity {
    pub fn current() -> io::Result<Self> {
        Self::capture(std::process::id())
    }

    /// Query an existing process. Does not spawn, signal, or take ownership of it.
    /// These synchronous kernel reads belong off an async executor's hot path.
    pub fn capture(pid: u32) -> io::Result<Self> {
        validate_pid(pid)?;
        native::capture(pid)
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }
}

#[derive(Debug)]
pub enum ProcessObservation {
    Alive,
    Gone(ProcessGoneProof),
    Unobservable { diagnostic: String },
}

/// Fresh kernel evidence for this identity only. Cannot be deserialized or
/// constructed by consumers. Domain code must compare the complete identity.
#[derive(Debug)]
pub struct ProcessGoneProof {
    identity: ProcessIdentity,
}

impl ProcessGoneProof {
    pub fn identity(&self) -> &ProcessIdentity {
        &self.identity
    }
}

pub fn observe(identity: &ProcessIdentity) -> io::Result<ProcessObservation> {
    validate_pid(identity.pid)?;
    Ok(match native::observe(identity) {
        Ok(Status::Alive) => ProcessObservation::Alive,
        Ok(Status::Gone) => ProcessObservation::Gone(ProcessGoneProof {
            identity: identity.clone(),
        }),
        Err(error) => ProcessObservation::Unobservable {
            diagnostic: error.to_string(),
        },
    })
}

enum Status {
    Alive,
    Gone,
}

fn validate_pid(pid: u32) -> io::Result<()> {
    if pid == 0 || (cfg!(unix) && pid > i32::MAX as u32) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid process ID",
        ));
    }
    Ok(())
}

fn unobservable(message: &str) -> io::Error {
    io::Error::other(message)
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;
    use std::process::{Child, Command};

    struct ChildGuard(Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn child() -> ChildGuard {
        ChildGuard(Command::new("/bin/sleep").arg("60").spawn().unwrap())
    }

    #[test]
    fn restored_identity_observes_the_original_live_process() {
        let original = ProcessIdentity::current().unwrap();
        assert_eq!(original.pid(), std::process::id());
        let restored: ProcessIdentity =
            serde_json::from_slice(&serde_json::to_vec(&original).unwrap()).unwrap();
        assert_eq!(restored, original);
        assert!(matches!(
            observe(&restored).unwrap(),
            ProcessObservation::Alive
        ));
    }

    #[test]
    fn sigkilled_child_produces_a_proof_for_its_persisted_identity() {
        let mut child = child();
        let identity = ProcessIdentity::capture(child.0.id()).unwrap();
        let persisted = serde_json::to_vec(&identity).unwrap();
        assert!(matches!(
            observe(&identity).unwrap(),
            ProcessObservation::Alive
        ));
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        let restored = serde_json::from_slice(&persisted).unwrap();
        let ProcessObservation::Gone(proof) = observe(&restored).unwrap() else {
            panic!("reaped SIGKILL child was not proven gone");
        };
        assert_eq!(proof.identity(), &identity);
    }

    #[test]
    fn a_different_start_identity_is_not_the_original_process() {
        let mut identity = ProcessIdentity::current().unwrap();
        match &mut identity.instance {
            Instance::MacOs {
                start_microseconds, ..
            } => *start_microseconds ^= 1,
            Instance::Linux { start_ticks, .. } => *start_ticks ^= 1,
            Instance::Windows { .. } => unreachable!(),
        }
        assert!(matches!(
            observe(&identity).unwrap(),
            ProcessObservation::Gone(_)
        ));
    }

    #[test]
    fn another_origin_never_proves_an_absent_process_gone() {
        let mut child = child();
        let mut identity = ProcessIdentity::capture(child.0.id()).unwrap();
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        match &mut identity.instance {
            Instance::MacOs {
                boot_session_uuid, ..
            } => *boot_session_uuid = "another-boot".into(),
            Instance::Linux { origin, .. } => origin.pid_namespace_inode ^= 1,
            Instance::Windows { .. } => unreachable!(),
        }
        assert!(matches!(
            observe(&identity).unwrap(),
            ProcessObservation::Unobservable { .. }
        ));
    }
}
