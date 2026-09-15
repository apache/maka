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

mod ownership;
mod recorder;
mod snapshot;

use crate::control::{Control, Result, is_link, validate_home};
use chrono::{Duration, Local, TimeZone, Utc};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use windows::Win32::{
    Foundation::HANDLE,
    System::StationsAndDesktops::{
        CloseDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, GetUserObjectInformationW,
        OpenInputDesktop, UOI_NAME,
    },
    UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId},
};

pub fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let home = PathBuf::from(
        std::env::var_os("OPEN_COMPUTER_HISTORY_HOME").ok_or("history_home_required")?,
    );
    validate_home(&home)?;
    match args.first().map(String::as_str) {
        Some("permissions") if args.len() == 2 && args[1] == "--no-prompt" => {
            print_status(&home, false)?;
        }
        Some("status") if args.len() == 1 => print_status(&home, true)?,
        Some("validate-home") if args.len() == 1 => {
            ownership::validate_storage(&home)?;
            println!("history-home-valid");
        }
        Some("record") => {
            let parent = ownership::Parent::open(parent_argument(&args)?)?;
            if args.len() != 4 || args[1] != "--no-prompt" || args[2] != "--parent-pid" {
                return Err("invalid_record_arguments".into());
            }
            recorder::record(&home, parent)?;
        }
        Some("snapshot") => {
            if args.len() != 9
                || args[1] != "--parent-pid"
                || args[3] != "--window"
                || args[5] != "--pid"
                || args[7] != "--source"
            {
                return Err("invalid_snapshot_arguments".into());
            }
            let parent = ownership::Parent::open(parent_argument(&args)?)?;
            require_consent(&home)?;
            let control = Control::load(&home)?;
            if !parent.alive()
                || control.state == crate::control::State::Stopped
                || control.paused(Utc::now())
                || !interactive_desktop()
            {
                return Err("capture_not_admitted".into());
            }
            let expected_parent = parent_argument(&args)?;
            let watched_home = home.clone();
            // UIA providers may stop responding inside COM. This process has
            // no writes; terminate it even if its supervisor dies during a call.
            std::thread::spawn(move || {
                let Ok(owner) = ownership::Parent::open(expected_parent) else {
                    std::process::exit(1);
                };
                let started = std::time::Instant::now();
                loop {
                    if !owner.alive()
                        || started.elapsed() >= std::time::Duration::from_secs(2)
                        || require_consent(&watched_home).is_err()
                        || !Control::load(&watched_home).is_ok_and(|value| {
                            value.state != crate::control::State::Stopped
                                && !value.paused(Utc::now())
                        })
                    {
                        std::process::exit(1);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            });
            let value =
                snapshot::capture(&home, args[4].parse()?, args[6].parse()?, args[8].clone())?;
            require_consent(&home)?;
            if !parent.alive() || !same_control(&control, &Control::load(&home)?) {
                return Err("capture_cancelled".into());
            }
            println!("{}", serde_json::to_string(&value)?);
        }
        Some("pause") => {
            let resume = match args.as_slice() {
                [_] => None,
                [_, flag, duration] if flag == "--for" => Some(match duration.as_str() {
                    "30m" => Utc::now() + Duration::minutes(30),
                    "1h" => Utc::now() + Duration::hours(1),
                    "tomorrow" => {
                        let date = Local::now().date_naive().succ_opt().ok_or("invalid_date")?;
                        Local
                            .from_local_datetime(&date.and_hms_opt(0, 0, 0).ok_or("invalid_date")?)
                            .earliest()
                            .ok_or("invalid_local_midnight")?
                            .to_utc()
                    }
                    _ => return Err("invalid_pause_duration".into()),
                }),
                _ => return Err("invalid_pause_arguments".into()),
            };
            write_json(
                &home.join("control.json"),
                &json!({
                    "state": "paused", "updatedAt": Utc::now(), "resumeAt": resume,
                    "revision": uuid::Uuid::new_v4().to_string()
                }),
            )?;
        }
        Some("resume") if args.len() == 1 => write_json(
            &home.join("control.json"),
            &json!({
                "state": "running", "updatedAt": Utc::now(),
                "revision": uuid::Uuid::new_v4().to_string()
            }),
        )?,
        _ => return Err("expected_status_permissions_record_pause_or_resume".into()),
    }
    Ok(())
}

fn parent_argument(args: &[String]) -> Result<u32> {
    let index = args
        .iter()
        .position(|arg| arg == "--parent-pid")
        .ok_or("parent_pid_required")?;
    Ok(args.get(index + 1).ok_or("parent_pid_required")?.parse()?)
}

pub(super) fn foreground() -> Option<(usize, u32)> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return None;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        (pid != 0).then_some((hwnd.0 as usize, pid))
    }
}

pub(super) fn interactive_desktop() -> bool {
    unsafe {
        let Ok(desktop) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
        else {
            return false;
        };
        let mut name = [0u16; 64];
        let result = GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            std::mem::size_of_val(&name) as u32,
            None,
        );
        let _ = CloseDesktop(desktop);
        let length = name
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(name.len());
        result.is_ok() && String::from_utf16_lossy(&name[..length]).eq_ignore_ascii_case("default")
    }
}

fn print_status(home: &Path, include_recorder: bool) -> Result<()> {
    let available = interactive_desktop();
    let mut status = json!({
        // Legacy transport names represent readiness, not macOS TCC grants on Windows.
        "accessibility": available, "inputMonitoring": available,
        "permissionModel": "interactive-session",
        "textCapture": "uia", "typedTextCapture": false,
    });
    if include_recorder {
        let active = ownership::active(home)?;
        let control = Control::load(home)?;
        status["recorderActive"] = json!(active);
        status["state"] = json!(if control.paused(Utc::now()) {
            "paused"
        } else if active {
            "running"
        } else {
            "stopped"
        });
        if active && !control.paused(Utc::now()) && crate::health::capture_failed(home, Utc::now())
        {
            status["captureError"] = json!("windows_capture_failed");
        }
    }
    println!("{status}");
    Ok(())
}

pub(super) fn require_consent(home: &Path) -> Result<()> {
    let path = home.join("maka-settings.json");
    let settings: Value = serde_json::from_slice(&crate::model::read_regular(&path, 64 * 1024)?)?;
    if settings["enabled"] != true {
        return Err("recording_disabled".into());
    }
    Ok(())
}

pub(super) fn same_control(before: &Control, after: &Control) -> bool {
    before.state == after.state
        && before.revision == after.revision
        && before.resume_at == after.resume_at
        && !after.paused(Utc::now())
        && after.state != crate::control::State::Stopped
}

pub(super) fn write_json(path: &Path, value: &Value) -> Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(path)
        && (!metadata.is_file() || is_link(&metadata))
    {
        return Err("invalid_history_file".into());
    }
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(&serde_json::to_vec(value)?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
