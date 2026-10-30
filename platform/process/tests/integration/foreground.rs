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

use maka_agent_facts::tools::ToolError;
use maka_agent_facts::tools::ToolExecutor;
use maka_process::{SHELL_NAME, ShellExecutor};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio_util::sync::CancellationToken;

async fn invoke(cwd: &Path, input: Value, token: CancellationToken) -> Result<Value, ToolError> {
    executor(cwd)?.invoke(SHELL_NAME.into(), input, token).await
}

fn executor(cwd: &Path) -> Result<ShellExecutor, ToolError> {
    #[cfg(target_os = "macos")]
    let policy = maka_sandbox::Sandbox::Managed {
        filesystem: maka_sandbox::filesystem::Policy {
            default: maka_sandbox::filesystem::Access::Read,
            rules: vec![maka_sandbox::filesystem::Rule::subtree(
                cwd.canonicalize().unwrap(),
                maka_sandbox::filesystem::Access::Write,
            )],
            deny_globs: Vec::new(),
        },
        network: maka_sandbox::Network::Denied,
    };
    #[cfg(not(target_os = "macos"))]
    let policy = maka_sandbox::Sandbox::Disabled;
    ShellExecutor::new(cwd, policy)
}

#[tokio::test]
async fn terminal_shape_nonzero_and_unicode_tail() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let result = invoke(
        &cwd,
        json!({"command":"printf hello; printf error >&2; exit 7"}),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(
        result,
        json!({"kind":"terminal","cwd":cwd,"cmd":"printf hello; printf error >&2; exit 7",
        "status":"failed","exitCode":7,"failureMessage":"Command exited with code 7",
        "output":{"mode":"pipes","stdout":"hello","stderr":"error","stdoutTruncated":false,
        "stderrTruncated":false,"redacted":false}})
    );
    let result = invoke(&cwd, json!({"command":"i=0; while [ $i -lt 24000 ]; do printf '界'; i=$((i+1)); done; printf 尾", "login":false}), CancellationToken::new()).await.unwrap();
    let text = result["output"]["stdout"].as_str().unwrap();
    assert!(text.len() <= 65536 && text.ends_with('尾') && !text.contains('�'));
    assert_eq!(result["status"], "completed");
    assert_eq!(result["exitCode"], 0);
    assert_eq!(result["output"]["stdoutTruncated"], true);
}

#[tokio::test]
async fn rejects_invalid_arguments_and_pre_spawn_cancellation() {
    let dir = tempfile::tempdir().unwrap();
    for input in [
        json!({"command":""}),
        json!({"command":"true","timeout_ms":null}),
        json!({"command":"true","timeout_ms":0}),
        json!({"command":"true","timeout_ms":1.5}),
        json!({"command":"true","run_in_background":true}),
    ] {
        assert!(matches!(
            invoke(dir.path(), input, CancellationToken::new()).await,
            Err(ToolError::Failed(_))
        ));
    }
    let complete_deadline = invoke(
        dir.path(),
        json!({"command":"true","timeout_ms":600001}),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(complete_deadline["status"], "completed");
    assert_eq!(complete_deadline["exitCode"], 0);
    let token = CancellationToken::new();
    token.cancel();
    assert!(matches!(
        invoke(dir.path(), json!({"command":"touch effect"}), token).await,
        Err(ToolError::Failed(_))
    ));
    assert!(!dir.path().join("effect").exists());
}

async fn read_pid(path: &Path) -> i32 {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Ok(text) = std::fs::read_to_string(path)
                && let Ok(pid) = text.trim().parse()
            {
                break pid;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("process started")
}

async fn assert_stopped(pid: i32) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let output = tokio::process::Command::new("/bin/ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
                .await
                .unwrap();
            let state = String::from_utf8_lossy(&output.stdout);
            if state.trim().is_empty() || state.trim().starts_with('Z') {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("process terminated");
}

#[tokio::test]
async fn timeout_cancel_and_dropped_caller_clean_process_group() {
    for mode in ["timeout", "cancel", "drop", "early-root"] {
        let dir = tempfile::tempdir().unwrap();
        let executor = executor(dir.path()).unwrap();
        let token = CancellationToken::new();
        // The descendant always needs KILL; one case lets the root exit on
        // TERM first, retaining its unreaped PID through the grace period.
        let root_trap = if mode == "early-root" {
            "trap 'exit 0' TERM"
        } else {
            "trap '' TERM"
        };
        let command = format!(
            r#"{root_trap}; /bin/sh -c 'trap "" TERM; echo $$ > child; while :; do sleep 1; done' & echo $$ > root; wait"#
        );
        let task = tokio::spawn(executor.invoke(
            SHELL_NAME.into(),
            json!({
                "command":command,
                "timeout_ms": if mode == "timeout" { 500 } else { 10000 }
            }),
            token.clone(),
        ));
        let root = read_pid(&dir.path().join("root")).await;
        let child = read_pid(&dir.path().join("child")).await;
        match mode {
            "cancel" | "early-root" => token.cancel(),
            "drop" => task.abort(),
            _ => {}
        }
        if mode != "drop" {
            let result = tokio::time::timeout(Duration::from_secs(6), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(
                result["status"],
                if mode == "timeout" {
                    "timed_out"
                } else {
                    "cancelled"
                }
            );
            assert_eq!(
                result["exitCode"],
                if mode == "timeout" { 124 } else { 130 }
            );
        } else {
            assert!(task.await.unwrap_err().is_cancelled());
        }
        assert_stopped(root).await;
        assert_stopped(child).await;
    }
}

#[tokio::test]
async fn normal_root_exit_drains_descendants_and_their_inherited_output() {
    for terminal in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let command = "sh -c 'trap \"\" HUP; echo $$ > child; exec sleep 30' & while ! test -s child; do sleep 0.01; done; printf done";
        let command = format!("exec /bin/sh -c '{}'", command.replace('\'', "'\\''"));
        tokio::time::timeout(Duration::from_millis(3500), async {
            if terminal {
                let plan = executor(dir.path())
                    .unwrap()
                    .with_login_shell(false)
                    .command_pty(&command)
                    .unwrap();
                let (mut child, io) = maka_process::pty::spawn(
                    plan,
                    maka_agent_facts::terminal::TerminalSize::new(80, 24).unwrap(),
                )
                .await
                .unwrap();
                let drain = async {
                    let mut output = Vec::new();
                    let mut bytes = [0; 4096];
                    loop {
                        let count = io.read(&mut bytes).await.unwrap();
                        if count == 0 {
                            break;
                        }
                        output.extend_from_slice(&bytes[..count]);
                    }
                    output
                };
                let (status, output) = tokio::join!(child.wait(), drain);
                assert!(status.unwrap().success());
                child.close().await.unwrap();
                assert_eq!(String::from_utf8(output).unwrap(), "done");
            } else {
                let result = invoke(
                    dir.path(),
                    json!({"command":command, "login": false}),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
                assert_eq!(result["status"], "completed");
                assert_eq!(result["output"]["stdout"], "done");
                assert_eq!(result["output"]["stdoutTruncated"], false);
            }
        })
        .await
        .unwrap();
        assert_stopped(read_pid(&dir.path().join("child")).await).await;
    }
}
