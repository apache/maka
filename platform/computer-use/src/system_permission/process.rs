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

use super::application_identity;
use crate::{
    desktop::worker::{MacRole, macos_finite},
    macos::tcc::{self, Grant},
};
use maka_agent_facts::interaction::SystemPermissionGrant;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Subject {
    responsible_pid: libc::pid_t,
    executable_path: PathBuf,
    application: Option<ApplicationIdentity>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplicationIdentity {
    path: PathBuf,
    identifier: String,
}

impl Subject {
    pub(crate) fn current() -> Result<Self, String> {
        Self::for_process(std::process::id() as libc::pid_t)
    }

    fn for_process(pid: libc::pid_t) -> Result<Self, String> {
        let (responsible_pid, executable) = tcc::responsible_process(pid)?;
        Self::from_executable(responsible_pid, executable)
    }

    fn from_executable(responsible_pid: libc::pid_t, executable: PathBuf) -> Result<Self, String> {
        let executable_path = executable
            .canonicalize()
            .map_err(|error| format!("Cannot resolve responsible executable: {error}"))?;
        let application = tcc::application_bundle(&executable_path)
            .map(|path| {
                Ok::<_, String>(ApplicationIdentity {
                    path: path.to_owned(),
                    identifier: application_identity::identifier(path)?,
                })
            })
            .transpose()?;
        Ok(Self {
            responsible_pid,
            executable_path,
            application,
        })
    }

    pub(crate) fn require_application(&self) -> Result<(), String> {
        if self.application.is_none() {
            return Err(
                "System permission prompts require a responsible application bundle".into(),
            );
        }
        Ok(())
    }

    fn finite_child() -> Result<Self, String> {
        // SAFETY: getppid only observes the immediate process owner.
        let parent_pid = unsafe { libc::getppid() };
        if parent_pid <= 1 {
            return Err("System permission finite process has lost its parent".into());
        }
        let expected = Self::for_process(parent_pid)?;
        let actual = Self::current()?;
        same_subject(&expected, &actual)?;
        Ok(actual)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Grants {
    accessibility: bool,
    screen_recording: bool,
}

impl Grants {
    fn read() -> Self {
        Self {
            accessibility: tcc::raw_present(Grant::Accessibility),
            screen_recording: tcc::raw_present(Grant::ScreenRecording),
        }
    }

    fn present(&self, grant: SystemPermissionGrant) -> bool {
        match grant {
            SystemPermissionGrant::Accessibility => self.accessibility,
            SystemPermissionGrant::ScreenRecording => self.screen_recording,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    subject: Subject,
    grants: Grants,
}

fn same_subject(expected: &Subject, actual: &Subject) -> Result<(), String> {
    if expected != actual {
        return Err(format!(
            "System permission responsible subject mismatch: expected {expected:?}, observed {actual:?}"
        ));
    }
    Ok(())
}

fn decode(value: Value, expected: &Subject) -> Result<Snapshot, String> {
    let observed: Snapshot = serde_json::from_value(value)
        .map_err(|error| format!("Invalid system permission finite-process result: {error}"))?;
    same_subject(expected, &observed.subject)?;
    Ok(observed)
}

pub(super) fn missing(
    required: &[SystemPermissionGrant],
) -> Result<Vec<SystemPermissionGrant>, String> {
    if required.is_empty() {
        return Ok(Vec::new());
    }
    let expected = Subject::current()?;
    let value =
        macos_finite(MacRole::PermissionStatus, &|| false).map_err(|error| error.to_string())?;
    let observed = decode(value, &expected)?;
    missing_from_snapshot(required, &observed, |grant| tcc::raw_present(grant.into()))
}

fn missing_from_snapshot(
    required: &[SystemPermissionGrant],
    observed: &Snapshot,
    mut main_present: impl FnMut(SystemPermissionGrant) -> bool,
) -> Result<Vec<SystemPermissionGrant>, String> {
    let mut missing = Vec::new();
    for &grant in required {
        if !observed.grants.present(grant) {
            missing.push(grant);
        } else if !main_present(grant) {
            return Err(format!(
                "system_permission_state_disagreement: {} is granted to a fresh process but not effective in Host PID {}",
                Grant::from(grant).code(),
                std::process::id()
            ));
        }
    }
    Ok(missing)
}

pub(crate) fn request(
    subject: &Subject,
    grant: SystemPermissionGrant,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<(), String> {
    let value = macos_finite(MacRole::PermissionRequest(grant), cancelled)
        .map_err(|error| error.to_string())?;
    decode(value, subject)?;
    Ok(())
}

pub(crate) fn finite_status() -> Result<Value, String> {
    let subject = Subject::finite_child()?;
    serde_json::to_value(Snapshot {
        subject,
        grants: Grants::read(),
    })
    .map_err(|error| error.to_string())
}

pub(crate) fn finite_request(grant: SystemPermissionGrant) -> Result<Value, String> {
    let subject = Subject::finite_child()?;
    subject.require_application()?;
    if !tcc::raw_present(grant.into()) {
        Grant::from(grant).request();
    }
    serde_json::to_value(Snapshot {
        subject,
        grants: Grants::read(),
    })
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use SystemPermissionGrant::{Accessibility, ScreenRecording};

    #[test]
    fn fresh_grants_require_host_confirmation_without_probing_denied_grants() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("host");
        std::fs::write(&executable, "fixture executable").unwrap();
        let subject = Subject::from_executable(41, executable.clone()).unwrap();
        assert_eq!(subject.executable_path, executable.canonicalize().unwrap());
        assert!(subject.application.is_none());
        assert_eq!(
            subject.require_application().unwrap_err(),
            "System permission prompts require a responsible application bundle"
        );
        let mut observed = Snapshot {
            subject,
            grants: Grants {
                accessibility: false,
                screen_recording: false,
            },
        };
        let missing = missing_from_snapshot(&[Accessibility, ScreenRecording], &observed, |_| {
            panic!("A fresh denial must not poison the Host's native state");
        })
        .unwrap();
        assert_eq!(missing, [Accessibility, ScreenRecording]);

        observed.grants.accessibility = true;
        let missing =
            missing_from_snapshot(&[Accessibility, ScreenRecording], &observed, |grant| {
                assert_eq!(
                    grant, Accessibility,
                    "Never probe a fresh denial in the Host"
                );
                true
            })
            .unwrap();
        assert_eq!(missing, [ScreenRecording]);
        let error = missing_from_snapshot(&[Accessibility], &observed, |_| false).unwrap_err();
        assert!(error.contains("system_permission_state_disagreement: accessibility"));
    }
}
