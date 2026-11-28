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

#[cfg(unix)]
include!("open_directly/unix.rs");

#[cfg(windows)]
#[test]
fn direct_windows_launch_forwards_the_root_without_a_console() {
    use std::{fs, path::PathBuf, process::Command};

    let directory = tempfile::tempdir().unwrap();
    let source = std::env::var_os("CARGO_BIN_EXE_maka-desktop-shell")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_maka-desktop-shell")));
    let shell = directory.path().join("maka-desktop-shell.exe");
    fs::copy(source, &shell).unwrap();
    let probe = directory.path().join("probe.rs");
    fs::write(
        &probe,
        r#"
        #[link(name = "kernel32")]
        unsafe extern "system" { fn GetConsoleWindow() -> *mut std::ffi::c_void; }
        fn main() {
            assert!(unsafe { GetConsoleWindow() }.is_null());
            assert!(std::env::var_os("MAKA_RESTART_ROOT").is_none());
            assert!(std::env::var_os("MAKA_RESTART_WAIT_PID").is_none());
            let target = std::env::var_os("MAKA_TEST_RECORDED").unwrap();
            let args: Vec<_> = std::env::args().skip(1).collect();
            std::fs::write(target, args.join("
")).unwrap();
        }
    "#,
    )
    .unwrap();
    let built = Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
        .arg(probe)
        .arg("-o")
        .arg(directory.path().join("maka.exe"))
        .output()
        .unwrap();
    assert!(built.status.success(), "{built:?}");
    for (index, (args, expected)) in [
        (vec!["--root", "会话 with spaces"], "会话 with spaces"),
        (vec![], "restart root"),
    ]
    .into_iter()
    .enumerate()
    {
        let recorded = directory.path().join(format!("recorded-{index}"));
        let mut command = Command::new(&shell);
        for key in [
            "MAKA_HOST_ROOT",
            "MAKA_HOST_ENDPOINT",
            "MAKA_HOST_EPOCH",
            "MAKA_LAUNCHER",
            "MAKA_DESKTOP_WSL_DISTRO",
            maka_updater::RESTART_WAIT_PID_ENV,
        ] {
            command.env_remove(key);
        }
        let output = command
            .args(args)
            .env(maka_updater::RESTART_ROOT_ENV, "restart root")
            .env("MAKA_TEST_RECORDED", &recorded)
            .output()
            .unwrap();
        let expected_abs = std::path::absolute(expected).unwrap();
        let text = fs::read_to_string(&recorded)
            .unwrap_or_else(|error| panic!("maka.exe did not run: {error}; {output:?}"));
        assert_eq!(
            text.lines().collect::<Vec<_>>(),
            ["host", "ensure", "--root", &expected_abs.to_string_lossy()]
        );
    }
}
