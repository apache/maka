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

#![cfg(unix)]

use std::{
    os::unix::fs::PermissionsExt,
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

#[test]
fn a_shell_opened_without_the_launcher_runs_maka_desktop_beside_it() {
    let directory = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("desktop-open-directly-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);
    let shell = directory.join(if cfg!(target_os = "macos") {
        "Maka.app/Contents/MacOS/maka-desktop-shell"
    } else {
        "maka-desktop-shell"
    });
    std::fs::create_dir_all(shell.parent().unwrap()).unwrap();
    std::fs::hard_link(env!("CARGO_BIN_EXE_maka-desktop-shell"), &shell).unwrap();
    let launcher = directory.join("maka");
    let arguments = directory.join("arguments");
    std::fs::write(
        &launcher,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n",
            arguments.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700)).unwrap();

    let status = Command::new(&shell)
        .env_remove("MAKA_HOST_ROOT")
        .env_remove("MAKA_HOST_ENDPOINT")
        .env_remove("MAKA_HOST_EPOCH")
        .env_remove("MAKA_LAUNCHER")
        .status()
        .unwrap();
    assert!(status.success(), "{status}");
    let started = Instant::now();
    let recorded = loop {
        match std::fs::read_to_string(&arguments) {
            Ok(text) if !text.is_empty() => break text,
            _ if started.elapsed() < Duration::from_secs(10) => {
                std::thread::sleep(Duration::from_millis(20))
            }
            other => panic!("the launcher beside the shell did not run: {other:?}"),
        }
    };
    assert_eq!(recorded, "desktop\n");
    std::fs::remove_dir_all(&directory).unwrap();
}
