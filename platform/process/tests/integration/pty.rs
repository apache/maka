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

use maka_agent_facts::terminal::TerminalSize;
use maka_process::pty::{self, PtyIo};
use std::time::Duration;

#[tokio::test]
async fn native_pty_has_controlling_terminal_unicode_resize_and_drained_exit() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().canonicalize().unwrap();
    for policy in policies(&cwd) {
        let mut command = pty::PtyCommand::new("/bin/sh", &cwd);
        command.args([
            "-c",
            r#"
        test -t 0 && test -t 1 && test -t 2 || exit 1
        test -r /dev/tty || exit 2
        test "$TERM" = xterm-256color && test "$COLORTERM" = truecolor || exit 3
        stty -echo
        stty size
        printf 'ready\n'
        IFS= read -r line
        printf 'received:%s\n' "$line"
        stty size
        exit 42
    "#,
        ]);
        command.env_clear().env("PATH", "/usr/bin:/bin");
        let command = command.sandbox(&policy).unwrap();
        let (mut child, io) = pty::spawn(command, TerminalSize::new(80, 24).unwrap())
            .await
            .unwrap();
        let output = until(&io, "ready\r\n").await;
        assert!(output.contains("24 80\r\n"), "{output:?}");
        child
            .resize(TerminalSize::new(101, 37).unwrap())
            .await
            .unwrap();
        write(&io, "中文😀\n".as_bytes()).await;
        let (status, output) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(child.wait(), drain(&io))
        })
        .await
        .unwrap();
        assert_eq!(status.unwrap().code(), Some(42));
        assert!(!cwd.join(".git").exists());
        let output = String::from_utf8(output).unwrap();
        assert!(output.contains("received:中文😀\r\n"), "{output:?}");
        assert!(output.contains("37 101\r\n"), "{output:?}");
        assert_eq!(
            child.wait().await.unwrap().code(),
            Some(42),
            "wait is stable"
        );
    }
}

#[tokio::test]
async fn native_pty_routes_ctrl_c_to_foreground_job_and_termination_reaps_root() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().canonicalize().unwrap();
    for policy in policies(&cwd) {
        let mut command = pty::PtyCommand::new("/bin/sh", &cwd);
        command.arg("-i");
        command
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("PS1", "");
        let command = command.sandbox(&policy).unwrap();
        let (mut child, io) = pty::spawn(command, TerminalSize::new(80, 24).unwrap())
            .await
            .unwrap();
        write(&io, b"stty -echo; printf 'configured\\n'\n").await;
        until(&io, "configured\r\n").await;
        write(&io, b"sh -c 'printf job-ready\\\\n; exec sleep 30'\n").await;
        until(&io, "job-ready").await;
        write(&io, b"\x03").await;
        write(&io, b"printf 'after-interrupt\\n'\n").await;
        until(&io, "after-interrupt\r\n").await;
        // The shell puts this job in a separate foreground process group. It
        // ignores hangup, so killing only the root cannot make the PTY reach EOF.
        write(
            &io,
            b"sh -c 'trap \"\" HUP; printf terminating-ready; exec sleep 30'\n",
        )
        .await;
        until(&io, "terminating-ready").await;
        child.terminate().unwrap();
        let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(!status.success());
        assert!(!cwd.join(".git").exists());
        tokio::time::timeout(Duration::from_secs(5), drain(&io))
            .await
            .unwrap();
    }
}

fn policies(cwd: &std::path::Path) -> Vec<maka_sandbox::Sandbox> {
    use maka_sandbox::filesystem::{Access, Policy, Rule};
    vec![
        maka_sandbox::Sandbox::Disabled,
        maka_sandbox::Sandbox::Managed {
            filesystem: Policy {
                default: Access::Read,
                rules: vec![
                    Rule::subtree(cwd, Access::Write),
                    Rule::subtree(cwd.join(".git"), Access::Read),
                ],
                deny_globs: Vec::new(),
            },
            network: maka_sandbox::Network::Denied,
        },
    ]
}

async fn write(io: &PtyIo, mut bytes: &[u8]) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !bytes.is_empty() {
            let count = io.write(bytes).await.unwrap();
            assert!(count > 0);
            bytes = &bytes[count..];
        }
    })
    .await
    .unwrap();
}

async fn until(io: &PtyIo, marker: &str) -> String {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut output = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            let count = io.read(&mut buffer).await.unwrap();
            assert!(
                count > 0,
                "early EOF: {:?}",
                String::from_utf8_lossy(&output)
            );
            output.extend_from_slice(&buffer[..count]);
            assert!(output.len() < 65536);
            if String::from_utf8_lossy(&output).contains(marker) {
                return String::from_utf8(output).unwrap();
            }
        }
    })
    .await
    .unwrap()
}

async fn drain(io: &PtyIo) -> Vec<u8> {
    let mut output = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let count = io.read(&mut buffer).await.unwrap();
        if count == 0 {
            return output;
        }
        output.extend_from_slice(&buffer[..count]);
        assert!(output.len() < 65536);
    }
}
