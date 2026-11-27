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
            for arg in std::env::args().skip(1) { println!("{arg}"); }
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
    for (args, expected) in [
        (vec!["--root", "会话 with spaces"], "会话 with spaces"),
        (vec![], "restart root"),
    ] {
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
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            String::from_utf8(output.stdout)
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            ["desktop", "--root", expected]
        );
    }
}
