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

#![cfg_attr(windows, windows_subsystem = "windows")]

//! The Maka desktop: runs the workbench (`maka-workbench`) in a window of
//! its own through NSH's AppKit backend on macOS, its Direct2D backend on
//! Windows and GTK on Linux.
//! `maka desktop` hands it a Root and launcher (`MAKA_HOST_ROOT`,
//! `MAKA_LAUNCHER`, plus optional `MAKA_HOST_ENDPOINT` / `MAKA_HOST_EPOCH`
//! when a caller already admitted a Host). Closing the window hides it behind
//! the tray; Quit detaches this client, and the Host keeps the work it
//! accepted. Opened directly from Finder, the Dock, a shortcut, or a file
//! manager, it connects through `maka host ensure` directly without keeping a
//! `maka desktop` launcher resident.

#[cfg(target_os = "macos")]
mod appkit;
#[cfg(target_os = "macos")]
mod cli;
#[cfg(windows)]
mod direct2d;
#[cfg(target_os = "macos")]
mod permission_application;
#[cfg(target_os = "macos")]
mod permission_window;
#[cfg(target_os = "macos")]
mod screenshot;
#[cfg(windows)]
mod screenshot_windows;
#[cfg(windows)]
use direct2d as backend;
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
mod host;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(unix)]
mod login_path;
#[cfg(target_os = "linux")]
mod placement;
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
mod shell;
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
mod updater;
#[cfg(windows)]
mod wsl_stdio;
#[cfg(target_os = "macos")]
use appkit as backend;
#[cfg(target_os = "linux")]
use linux as backend;

use std::{path::PathBuf, process::ExitCode};

const ROOT: &str = "MAKA_HOST_ROOT";
const ENDPOINT: &str = "MAKA_HOST_ENDPOINT";
const EPOCH: &str = "MAKA_HOST_EPOCH";
const LAUNCHER: &str = "MAKA_LAUNCHER";

#[cfg(all(test, windows))]
mod windows_icon_test {
    use std::ffi::c_void;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetModuleHandleW(name: *const u16) -> *mut c_void;
        fn FindResourceW(module: *mut c_void, name: *const u16, kind: *const u16) -> *mut c_void;
    }

    #[test]
    fn executable_contains_application_icon() {
        // SAFETY: null selects the current module; MAKEINTRESOURCE values 1
        // and 14 select the application icon group without dereferencing them.
        let icon = unsafe {
            FindResourceW(
                GetModuleHandleW(std::ptr::null()),
                1usize as _,
                14usize as _,
            )
        };
        assert!(
            !icon.is_null(),
            "desktop executable has no application icon"
        );
    }
}

/// How the desktop connects to the initial Host for its Root.
#[derive(Debug, PartialEq)]
pub(crate) enum TargetHost {
    Connected {
        endpoint: PathBuf,
        epoch: uuid::Uuid,
    },
    Ensure,
}

/// The Root and launcher the desktop runs against, plus an optional already-admitted Host.
#[derive(Debug, PartialEq)]
pub(crate) struct Target {
    pub(crate) root: PathBuf,
    pub(crate) host: TargetHost,
    pub(crate) launcher: PathBuf,
}

impl Target {
    fn from(var: impl Fn(&str) -> Option<std::ffi::OsString>) -> Result<Self, String> {
        let read = |name: &str| {
            var(name)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| format!("{name} is not set; start the desktop with `maka desktop`"))
        };
        let absolute = |name: &str| {
            let path = PathBuf::from(read(name)?);
            if path.is_absolute() {
                Ok(path)
            } else {
                Err(format!("{name} is not an absolute path"))
            }
        };
        let root = absolute(ROOT)?;
        let launcher = absolute(LAUNCHER)?;
        let endpoint = var(ENDPOINT).filter(|value| !value.is_empty());
        let epoch = var(EPOCH).filter(|value| !value.is_empty());
        let host = match (endpoint, epoch) {
            (None, None) => TargetHost::Ensure,
            (Some(endpoint), Some(epoch)) => {
                let epoch = epoch
                    .to_str()
                    .and_then(|epoch| epoch.parse().ok())
                    .ok_or_else(|| format!("{EPOCH} is not a UUID: {}", epoch.to_string_lossy()))?;
                TargetHost::Connected {
                    endpoint: PathBuf::from(endpoint),
                    epoch,
                }
            }
            (Some(_), None) => {
                return Err(format!(
                    "{EPOCH} is not set; start the desktop with `maka desktop`"
                ));
            }
            (None, Some(_)) => {
                return Err(format!(
                    "{ENDPOINT} is not set; start the desktop with `maka desktop`"
                ));
            }
        };
        Ok(Self {
            root,
            host,
            launcher,
        })
    }
}

/// What `--help` or `--version` prints, answered before anything can fail;
/// `None` starts the desktop.
fn answer(arguments: impl IntoIterator<Item = std::ffi::OsString>) -> Option<String> {
    let version = format!("maka-desktop-shell {}", env!("CARGO_PKG_VERSION"));
    let mut answer = None;
    for argument in arguments {
        if argument == "--help" || argument == "-h" {
            return Some(format!(
                "{version}\n\nStarted by `maka desktop --root PATH`, which names the Root and \
                 launcher in {ROOT} and {LAUNCHER} (optionally with {ENDPOINT} and {EPOCH}). \
                 Opened without them, it connects directly via `maka host ensure`.{}",
                if cfg!(windows) {
                    " Windows shortcuts can pass desktop options such as --root PATH directly."
                } else {
                    ""
                }
            ));
        }
        if argument == "--version" || argument == "-V" {
            answer = Some(version.clone());
        }
    }
    answer
}

fn main() -> ExitCode {
    #[cfg(target_os = "macos")]
    if let Some(exit) = cli::dispatch() {
        return exit;
    }
    if let Some(text) = answer(std::env::args_os().skip(1)) {
        println!("{text}");
        return ExitCode::SUCCESS;
    }
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("maka-desktop-shell: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
fn run() -> Result<(), String> {
    wait_for_restarting_pid();
    #[cfg(windows)]
    if let Some(distro) = std::env::var_os("MAKA_DESKTOP_WSL_DISTRO") {
        return wsl_stdio::Target::from_env(distro)?.run();
    }
    if [ROOT, ENDPOINT, EPOCH, LAUNCHER]
        .iter()
        .all(|name| std::env::var_os(name).is_none())
    {
        #[cfg(windows)]
        {
            let args: Vec<_> = std::env::args_os().skip(1).collect();
            return match direct_root_arg(&args) {
                Some(root) => run_direct(root),
                None => launch(&args),
            };
        }
        #[cfg(not(windows))]
        return run_direct(None);
    }
    let target = Target::from(|name| std::env::var_os(name))?;
    backend::start(target)
}

#[cfg(windows)]
fn wait_for_restarting_pid() {
    use std::ffi::c_void;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const WAIT_MS: u32 = 15_000;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn WaitForSingleObject(handle: *mut c_void, millis: u32) -> u32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    let Some(raw) = std::env::var_os(maka_updater::RESTART_WAIT_PID_ENV) else {
        return;
    };
    if let Ok(pid) = raw.to_string_lossy().trim().parse::<u32>() {
        // SAFETY: OpenProcess/WaitForSingleObject/CloseHandle operate on an OS
        // handle checked for null before waiting and closed immediately after.
        unsafe {
            let handle = OpenProcess(SYNCHRONIZE, 0, pid);
            if !handle.is_null() {
                WaitForSingleObject(handle, WAIT_MS);
                CloseHandle(handle);
            }
        }
    }
}

#[cfg(all(unix, any(target_os = "linux", target_os = "macos")))]
fn wait_for_restarting_pid() {}

/// Resolves `maka` beside `shell`.
/// On macOS, a self-contained `Maka.app` places `maka` right beside
/// `maka-desktop-shell` inside `Contents/MacOS/`; dev/npm layouts place
/// `maka` beside `Maka.app` (4 ancestors up).
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
fn launcher_path(shell: &std::path::Path) -> Result<PathBuf, String> {
    let binary = if cfg!(windows) { "maka.exe" } else { "maka" };
    if cfg!(target_os = "macos") {
        let bundled = shell.with_file_name(binary);
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    let levels = if cfg!(target_os = "macos") { 4 } else { 1 };
    shell
        .ancestors()
        .nth(levels)
        .ok_or_else(|| format!("{} is not in a Maka installation", shell.display()))
        .map(|dir| dir.join(binary))
}

/// Parses direct-launch arguments when they only select `--root` (or pass no
/// options); returns `None` for options like `--wsl` that still forward to
/// `maka desktop`.
#[cfg(any(windows, test))]
fn direct_root_arg(args: &[std::ffi::OsString]) -> Option<Option<PathBuf>> {
    match args {
        [] => Some(None),
        [flag, value] if flag == "--root" && !value.is_empty() => Some(Some(PathBuf::from(value))),
        [single] => {
            let value = single.to_str()?.strip_prefix("--root=")?;
            (!value.is_empty()).then(|| Some(PathBuf::from(value)))
        }
        _ => None,
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
fn default_root() -> Result<PathBuf, String> {
    #[cfg(unix)]
    let home = std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "home directory unavailable; select --root".to_owned())?;
    #[cfg(windows)]
    let home = maka_sandbox::account_home().map_err(|error| error.to_string())?;
    Ok(home.join(".maka/application/host"))
}

/// Connects directly through `maka host ensure` without keeping a `maka desktop`
/// launcher resident.
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
fn run_direct(explicit_root: Option<PathBuf>) -> Result<(), String> {
    let shell = std::env::current_exe()
        .and_then(|shell| shell.canonicalize())
        .map_err(|error| error.to_string())?;
    let launcher = launcher_path(&shell)?;
    let root = match explicit_root {
        Some(root) => root,
        None => {
            match std::env::var_os(maka_updater::RESTART_ROOT_ENV).filter(|root| !root.is_empty()) {
                Some(root) => PathBuf::from(root),
                None => default_root()?,
            }
        }
    };
    let root = std::path::absolute(&root).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    let login_path = login_path::resolve();
    // SAFETY: still single-threaded before Tokio or UI backend startup, and
    // login_path::resolve joins its reader thread before returning.
    unsafe {
        std::env::remove_var(maka_updater::RESTART_ROOT_ENV);
        std::env::remove_var(maka_updater::RESTART_WAIT_PID_ENV);
        #[cfg(unix)]
        if let Some(path) = login_path {
            std::env::set_var("PATH", path);
        }
    }
    backend::start(Target {
        root,
        host: TargetHost::Ensure,
        launcher,
    })
}

/// Forwards Windows shortcut options (such as `--wsl`) to `maka.exe desktop`.
#[cfg(windows)]
fn launch(args: &[std::ffi::OsString]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let shell = std::env::current_exe()
        .and_then(|shell| shell.canonicalize())
        .map_err(|error| error.to_string())?;
    let launcher = launcher_path(&shell)?;
    let mut command = std::process::Command::new(&launcher);
    command
        .arg("desktop")
        .args(args)
        .env_remove(maka_updater::RESTART_ROOT_ENV)
        .env_remove(maka_updater::RESTART_WAIT_PID_ENV)
        .creation_flags(CREATE_NO_WINDOW);
    command
        .spawn()
        .map(drop)
        .map_err(|error| format!("{}: {error}", launcher.display()))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn run() -> Result<(), String> {
    Err("the desktop runs on macOS, Windows and Linux".into())
}

// Unix paths: on Windows an absolute Root also names a drive.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{collections::HashMap, ffi::OsString};

    #[test]
    fn help_and_version_answer_without_a_host() {
        let answer = |arguments: &[&str]| answer(arguments.iter().map(OsString::from));
        let version = format!("maka-desktop-shell {}", env!("CARGO_PKG_VERSION"));
        assert_eq!(answer(&["--version"]), Some(version.clone()));
        assert_eq!(answer(&["-V"]), Some(version.clone()));
        let help = answer(&["--version", "-h"]).unwrap();
        assert!(help.starts_with(&format!("{version}\n\n")), "{help}");
        assert!(help.contains("maka desktop --root PATH"), "{help}");
        assert_eq!(answer(&[]), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn launcher_path_prefers_self_contained_bundle_and_falls_back_to_sibling_layout() {
        let dir = std::env::temp_dir().join(format!("maka-launcher-path-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let macos = dir.join("Maka.app/Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        let shell = macos.join("maka-desktop-shell");
        std::fs::write(&shell, b"shell").unwrap();

        // Sibling layout (dev / npm): Maka.app beside maka.
        assert_eq!(launcher_path(&shell).unwrap(), dir.join("maka"));

        // Self-contained bundle: maka sits right beside maka-desktop-shell inside Contents/MacOS.
        let bundled = macos.join("maka");
        std::fs::write(&bundled, b"cli").unwrap();
        assert_eq!(launcher_path(&shell).unwrap(), bundled);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn target(vars: &[(&str, &str)]) -> Result<Target, String> {
        let vars: HashMap<_, _> = vars
            .iter()
            .map(|(name, value)| (name.to_string(), OsString::from(value)))
            .collect();
        Target::from(|name| vars.get(name).cloned())
    }

    #[test]
    fn the_target_is_the_root_endpoint_and_epoch_the_launcher_names() {
        let epoch = "8f1d3c0e-2a4b-4c6d-8e0f-1a2b3c4d5e6f";
        let complete = [
            (ROOT, "/hosts/main"),
            (ENDPOINT, "/run/maka/host.sock"),
            (EPOCH, epoch),
            (LAUNCHER, "/opt/maka/maka"),
        ];
        assert_eq!(
            target(&complete),
            Ok(Target {
                root: "/hosts/main".into(),
                host: TargetHost::Connected {
                    endpoint: "/run/maka/host.sock".into(),
                    epoch: epoch.parse().unwrap(),
                },
                launcher: "/opt/maka/maka".into(),
            })
        );
        assert_eq!(
            target(&[(ROOT, "/hosts/main"), (LAUNCHER, "/opt/maka/maka")]),
            Ok(Target {
                root: "/hosts/main".into(),
                host: TargetHost::Ensure,
                launcher: "/opt/maka/maka".into(),
            })
        );
        for missing in [ROOT, ENDPOINT, EPOCH, LAUNCHER] {
            let vars: Vec<_> = complete
                .iter()
                .copied()
                .filter(|(name, _)| *name != missing)
                .collect();
            let error = target(&vars).unwrap_err();
            assert!(
                error.starts_with(&format!("{missing} is not set")),
                "{error}"
            );
        }
        for relative in [ROOT, LAUNCHER] {
            let vars: Vec<_> = complete
                .iter()
                .map(|&(name, value)| (name, if name == relative { "maka" } else { value }))
                .collect();
            assert_eq!(
                target(&vars),
                Err(format!("{relative} is not an absolute path"))
            );
        }
        let latest = [
            (ROOT, "/hosts/main"),
            (ENDPOINT, "/sock"),
            (EPOCH, "latest"),
            (LAUNCHER, "/opt/maka/maka"),
        ];
        assert_eq!(
            target(&latest),
            Err(format!("{EPOCH} is not a UUID: latest"))
        );
    }

    #[test]
    fn direct_root_arg_handles_default_root_and_forwards_other_flags() {
        let args = |values: &[&str]| values.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(direct_root_arg(&args(&[])), Some(None));
        assert_eq!(
            direct_root_arg(&args(&["--root", "会话 with spaces"])),
            Some(Some(PathBuf::from("会话 with spaces")))
        );
        assert_eq!(
            direct_root_arg(&args(&["--root=/hosts/main"])),
            Some(Some(PathBuf::from("/hosts/main")))
        );
        assert_eq!(direct_root_arg(&args(&["--wsl", "Ubuntu"])), None);
        assert_eq!(direct_root_arg(&args(&["--root"])), None);
    }
}
