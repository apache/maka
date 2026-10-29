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
//! its own through NSH's GPUI backend. `maka desktop` starts it for the Host
//! it admitted, named by `MAKA_HOST_ROOT`, `MAKA_HOST_ENDPOINT` and
//! `MAKA_HOST_EPOCH`. Closing the window detaches this client; the Host keeps
//! the work it accepted. If that Host stops while the window is open, the
//! window connects to the Root's next Host, which the launcher named by
//! `MAKA_LAUNCHER` starts, and loads the workbench again.

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
mod host;
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
mod placement;
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
mod window;
#[cfg(all(windows, feature = "direct2d-experiment"))]
mod direct2d_folder;

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

/// The Host `maka desktop` admitted: its Root, its endpoint and the epoch the
/// connection must find there, and the launcher that starts the Root's Host.
#[derive(Debug, PartialEq)]
struct Target {
    root: PathBuf,
    endpoint: PathBuf,
    epoch: uuid::Uuid,
    launcher: PathBuf,
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
        let endpoint = PathBuf::from(read(ENDPOINT)?);
        let epoch = read(EPOCH)?;
        let epoch = epoch
            .to_str()
            .and_then(|epoch| epoch.parse().ok())
            .ok_or_else(|| format!("{EPOCH} is not a UUID: {}", epoch.to_string_lossy()))?;
        Ok(Self {
            root,
            endpoint,
            epoch,
            launcher: absolute(LAUNCHER)?,
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
                "{version}\n\nStarted by `maka desktop --root PATH`, which names the Host in \
                 {ROOT}, {ENDPOINT} and {EPOCH}, and itself in {LAUNCHER}."
            ));
        }
        if argument == "--version" || argument == "-V" {
            answer = Some(version.clone());
        }
    }
    answer
}

fn main() -> ExitCode {
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
    use maka_host_runtime::application::host::Client as HostClient;

    let target = Target::from(|name| std::env::var_os(name))?;
    let root = host::Root::find(target.root, target.launcher)?;
    let runtime = tokio::runtime::Runtime::new().map_err(|error| error.to_string())?;
    let first = runtime.block_on(async {
        let host = HostClient::connect(&target.endpoint, Some(target.epoch)).await?;
        let handle = tokio::runtime::Handle::current();
        host::Connection::admit(host, target.endpoint, root.path(), handle).await
    })?;
    #[cfg(all(windows, feature = "direct2d-experiment"))]
    {
        let host::Connection { bindings, mut config, .. } = first;
        let (_active, foreground) = tokio::sync::watch::channel(true);
        config.context = config.context.with(maka_workbench::Foreground(foreground));
        config.host.handle("workspace.chooseFolder", move |call| {
            std::thread::spawn(move || match direct2d_folder::choose() {
                Ok(Some(path)) => call.resolve(nsh_engine::JsonValue::from(path)),
                Ok(None) => call.resolve(nsh_engine::JsonValue::Null),
                Err(error) => call.reject(error),
            });
        });
        let result = nsh_platform_windows::run_app(
            nsh_platform_windows::AppSource::Config(config),
            nsh_platform_windows::AppOptions {
                app_id: "org.apache.maka.desktop".into(),
                title: "Maka Direct2D experiment".into(),
                size: (1280, 820),
                ..Default::default()
            },
        );
        runtime.block_on(bindings.close()).map_err(|error| error.to_string())?;
        if result == ExitCode::SUCCESS { Ok(()) } else { Err("Direct2D experiment failed".into()) }
    }
    #[cfg(not(all(windows, feature = "direct2d-experiment")))]
    window::run(first, root, runtime)
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
                endpoint: "/run/maka/host.sock".into(),
                epoch: epoch.parse().unwrap(),
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
}
