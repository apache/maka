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

use chrono::{DateTime, Utc};
use serde::Deserialize;
use std::{error::Error, fs, path::Path};

pub type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Running,
    Paused,
    Stopped,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Control {
    pub state: State,
    pub resume_at: Option<DateTime<Utc>>,
    pub revision: Option<String>,
}

impl Control {
    pub fn load(home: &Path) -> Result<Self> {
        let path = home.join("control.json");
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self {
                state: State::Running,
                resume_at: None,
                revision: None,
            }),
            Err(error) => Err(error.into()),
            Ok(metadata) => {
                if !metadata.is_file() || metadata.len() > 4096 || is_link(&metadata) {
                    return Err("invalid_control".into());
                }
                Ok(serde_json::from_slice(&crate::model::read_regular(
                    &path, 4096,
                )?)?)
            }
        }
    }

    pub fn paused(&self, now: DateTime<Utc>) -> bool {
        self.state == State::Paused && self.resume_at.is_none_or(|until| until > now)
    }
}

pub fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.is_symlink()
    }
}

pub fn validate_home(home: &Path) -> Result<()> {
    if !home.is_absolute() {
        return Err("history_home_must_be_absolute".into());
    }
    #[cfg(windows)]
    validate_local_drive(&windows_drive_root(home)?)?;
    // Check every existing ancestor so a junction cannot redirect private output.
    for ancestor in home.ancestors() {
        let metadata = fs::symlink_metadata(ancestor)?;
        if !metadata.is_dir() || is_link(&metadata) {
            return Err("history_home_must_be_a_real_directory".into());
        }
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn windows_drive_root(home: &Path) -> Result<std::path::PathBuf> {
    use std::{
        os::windows::ffi::OsStrExt,
        path::{Component, Prefix},
    };

    let mut components = home.components();
    let drive = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive,
            _ => return Err("history_home_must_be_a_local_drive_path".into()),
        },
        _ => return Err("history_home_must_be_a_local_drive_path".into()),
    };
    if !matches!(components.next(), Some(Component::RootDir)) {
        return Err("history_home_must_be_absolute".into());
    }
    // Reject navigation, NUL truncation and alternate streams before any Win32 access.
    for component in components {
        match component {
            Component::Normal(name)
                if !name
                    .encode_wide()
                    .any(|unit| unit == 0 || unit == u16::from(b':')) => {}
            _ => return Err("history_home_must_be_a_local_drive_path".into()),
        }
    }
    Ok(format!("{}:\\", char::from(drive.to_ascii_uppercase())).into())
}

#[cfg(windows)]
pub(crate) fn validate_local_drive(root: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{Win32::Storage::FileSystem::GetDriveTypeW, core::PCWSTR};

    // Callers supply a parsed drive root or a handle-derived volume GUID root.
    let root: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
    // DRIVE_REMOVABLE, DRIVE_FIXED and DRIVE_RAMDISK; NTFS alone also admits SMB.
    if !matches!(unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) }, 2 | 3 | 6) {
        return Err("history_requires_local_ntfs".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_control_and_deadlines_do_not_resume() {
        for value in [
            r#"{"state":"other"}"#,
            r#"{"state":"paused","resumeAt":"not-a-date"}"#,
            r#"{"state":"running","revision":1}"#,
        ] {
            assert!(serde_json::from_str::<Control>(value).is_err());
        }
    }

    #[test]
    fn explicit_pause_survives_restart_and_expires_at_exact_deadline() {
        let now = DateTime::parse_from_rfc3339("2026-09-15T01:00:00Z")
            .unwrap()
            .to_utc();
        let control: Control = serde_json::from_str(
            r#"{"state":"paused","resumeAt":"2026-09-15T01:00:00Z","revision":"one"}"#,
        )
        .unwrap();
        assert!(control.paused(now - chrono::Duration::milliseconds(1)));
        assert!(!control.paused(now));
        assert_eq!(control.revision.as_deref(), Some("one"));
        let indefinite: Control = serde_json::from_str(r#"{"state":"paused"}"#).unwrap();
        assert!(indefinite.paused(now));
    }

    #[test]
    fn control_load_defaults_only_when_missing_and_rejects_invalid_files() {
        let home = crate::model::tests::Home::new();
        assert_eq!(Control::load(&home.0).unwrap().state, State::Running);
        let path = home.0.join("control.json");
        fs::write(&path, br#"{"state":"paused","revision":"one"}"#).unwrap();
        let paused = Control::load(&home.0).unwrap();
        assert_eq!(paused.state, State::Paused);
        assert_eq!(paused.revision.as_deref(), Some("one"));
        fs::write(&path, vec![b' '; 4097]).unwrap();
        assert_eq!(
            Control::load(&home.0).unwrap_err().to_string(),
            "invalid_control"
        );
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert_eq!(
            Control::load(&home.0).unwrap_err().to_string(),
            "invalid_control"
        );
    }

    #[cfg(windows)]
    #[test]
    fn network_and_device_namespaces_are_rejected_before_access() {
        for home in [
            r"\\invalid.example\share\history",
            r"\\?\UNC\invalid.example\share\history",
            r"//invalid.example/share/history",
            r"\\.\C:\history",
            r"\\.\pipe\history",
            r"\\?\GLOBALROOT\Device\Mup\invalid.example\share\history",
            r"\\?\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\history",
        ] {
            assert_eq!(
                validate_home(Path::new(home)).unwrap_err().to_string(),
                "history_home_must_be_a_local_drive_path",
                "{home}",
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn drive_roots_require_absolute_unambiguous_components() {
        for home in [
            r"C:\history",
            r"\\?\C:\history",
            "c:/history",
            r"\\?\c:\history",
        ] {
            assert_eq!(
                windows_drive_root(Path::new(home)).unwrap(),
                Path::new(r"C:\")
            );
        }
        for home in [
            r"C:history",
            r"\history",
            r"C:\history\..\other",
            r"\\?\C:\history\..\other",
            r"C:\history:stream",
            "C:\\history\0\\other",
        ] {
            assert!(windows_drive_root(Path::new(home)).is_err(), "{home:?}");
        }
    }
}
