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
    pub(crate) bundle_path: PathBuf,
    identifier: String,
}

impl Subject {
    pub(crate) fn current() -> Result<Self, String> {
        Self::for_process(std::process::id() as libc::pid_t)
    }

    fn for_process(pid: libc::pid_t) -> Result<Self, String> {
        let (responsible_pid, executable) = tcc::responsible_process(pid)?;
        let bundle_path = tcc::application_bundle(&executable)
            .ok_or_else(|| {
                format!("Responsible process PID {responsible_pid} has no application bundle")
            })?
            .canonicalize()
            .map_err(|error| format!("Cannot resolve responsible application bundle: {error}"))?;
        let identifier = application_identity::identifier(&bundle_path)?;
        Ok(Self {
            responsible_pid,
            bundle_path,
            identifier,
        })
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
    application_identity::validate(&subject.bundle_path)?;
    if !tcc::raw_present(grant.into()) {
        tcc::request_raw(grant.into());
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

    fn snapshot(accessibility: bool, screen_recording: bool) -> Snapshot {
        Snapshot {
            subject: Subject {
                responsible_pid: 41,
                bundle_path: "/installed/Host.app".into(),
                identifier: "test.host".into(),
            },
            grants: Grants {
                accessibility,
                screen_recording,
            },
        }
    }

    #[test]
    fn fresh_denial_never_calls_main_native_checks() {
        let observed = snapshot(false, false);
        let missing = missing_from_snapshot(&[Accessibility, ScreenRecording], &observed, |_| {
            panic!("A fresh denial must not poison the Host's native state");
        })
        .unwrap();
        assert_eq!(missing, [Accessibility, ScreenRecording]);
    }

    #[test]
    fn each_fresh_grant_requires_actual_main_confirmation() {
        let observed = snapshot(true, false);
        let mut checked = Vec::new();
        assert_eq!(
            missing_from_snapshot(&[ScreenRecording, Accessibility], &observed, |grant| {
                checked.push(grant);
                true
            })
            .unwrap(),
            [ScreenRecording]
        );
        assert_eq!(checked, [Accessibility]);
        let observed = snapshot(true, true);
        let error = missing_from_snapshot(&[ScreenRecording], &observed, |_| false).unwrap_err();
        assert!(error.contains("system_permission_state_disagreement: screen_recording"));
    }

    #[test]
    fn finite_results_require_the_same_complete_responsible_subject() {
        let expected = snapshot(false, false).subject;
        for field in ["responsiblePid", "bundlePath", "identifier"] {
            let mut value = serde_json::to_value(snapshot(false, false)).unwrap();
            value["subject"][field] = match field {
                "responsiblePid" => serde_json::json!(42),
                "bundlePath" => serde_json::json!("/another/Host.app"),
                _ => serde_json::json!("another.host"),
            };
            assert!(
                decode(value, &expected)
                    .err()
                    .unwrap()
                    .contains("responsible subject mismatch")
            );
        }
        let mut value = serde_json::to_value(snapshot(false, false)).unwrap();
        value["grants"]
            .as_object_mut()
            .unwrap()
            .remove("screenRecording");
        assert!(
            decode(value, &expected)
                .err()
                .unwrap()
                .contains("Invalid system permission")
        );
    }
}
