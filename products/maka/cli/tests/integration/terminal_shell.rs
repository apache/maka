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

use std::process::Command;

#[test]
fn terminal_shell_help_runs_from_the_cli_without_a_sibling_shell() {
    let directory = crate::executable_tempdir();
    let executable = directory
        .path()
        .join(if cfg!(windows) { "maka.exe" } else { "maka" });
    std::fs::hard_link(crate::maka_executable(), &executable).unwrap();
    for arguments in [vec!["--help"], vec!["terminal-shell", "--help"]] {
        let output = Command::new(&executable)
            .args(arguments)
            .current_dir(directory.path())
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        assert!(output.stderr.is_empty(), "{output:?}");
        let help = String::from_utf8(output.stdout).unwrap();
        assert!(help.contains("--root"), "{help}");
        assert!(help.contains("--session"), "{help}");
        assert!(!help.contains("<ARGS>"), "{help}");
    }
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[test]
fn default_and_explicit_terminal_entries_reject_redirected_stdio_before_host_startup() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("absent-host");
    for arguments in [
        vec![],
        vec!["--root", root.to_str().unwrap()],
        vec!["terminal-shell"],
        vec!["terminal-shell", "--root", root.to_str().unwrap()],
    ] {
        let output = Command::new(crate::maka_executable())
            .args(&arguments)
            .current_dir(directory.path())
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1), "{arguments:?}: {output:?}");
        assert!(output.stdout.is_empty(), "{arguments:?}: {output:?}");
        assert_eq!(
            String::from_utf8(output.stderr).unwrap(),
            "maka terminal-shell: the terminal shell requires a terminal on stdin and stdout\n",
            "{arguments:?}"
        );
        assert!(!root.exists(), "{arguments:?} must not initialize a Host");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }
}

#[cfg(target_os = "macos")]
#[test]
fn build_ui_execs_the_matching_shell_in_each_macos_layout() {
    use std::{fs, os::unix::fs::PermissionsExt, process::Stdio};

    let directory = crate::executable_tempdir();
    let bin = directory.path().canonicalize().unwrap();
    let bundled = bin.join("Maka.app/Contents/MacOS");
    fs::create_dir_all(&bundled).unwrap();
    for folder in [&bin, &bundled] {
        fs::hard_link(crate::maka_executable(), folder.join("maka")).unwrap();
    }
    let sibling = bin.join("maka-desktop-shell");
    let staged = bundled.join("maka-desktop-shell");
    for shell in [&sibling, &staged] {
        fs::write(
            shell,
            "#!/bin/sh\nprintf '%s\\n' \"$$\" \"$0\" \"$MAKA_LAUNCHER\" \"$@\"\nexit 23\n",
        )
        .unwrap();
        fs::set_permissions(shell, fs::Permissions::from_mode(0o755)).unwrap();
    }

    let check = |launcher: &std::path::Path, expected: &std::path::Path| {
        let child = Command::new(launcher)
            .args([
                "application",
                "build-ui",
                "--entry=-app.tsx",
                "--output",
                "build dir",
                "--asset-root",
                ".",
            ])
            .env("MAKA_LAUNCHER", "stale-launcher")
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let pid = child.id();
        let output = child.wait_with_output().unwrap();
        assert_eq!(output.status.code(), Some(23));
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!(
                "{pid}\n{}\n{}\n__maka-build-ui\n--entry=-app.tsx\n--output=build dir\n--asset-root=.\n",
                expected.display(),
                launcher.display()
            )
        );
    };
    check(&bin.join("maka"), &staged);
    check(&bundled.join("maka"), &staged);
    fs::remove_file(&staged).unwrap();
    check(&bin.join("maka"), &sibling);
}
