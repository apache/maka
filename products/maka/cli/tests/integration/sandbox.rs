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

use maka_sandbox::Sandbox;
use std::{
    path::Path,
    process::{Output, Stdio},
    time::Duration,
};
use tokio::io::AsyncReadExt;

async fn run(cwd: &Path, policy: &Sandbox, command: &str, timeout: u64) -> Output {
    let path = cwd.join("policy.json");
    std::fs::write(&path, serde_json::to_vec(policy).unwrap()).unwrap();
    tokio::time::timeout(
        Duration::from_secs(15),
        tokio::process::Command::new(crate::maka_executable())
            .arg("sandbox")
            .arg("run")
            .arg("--policy")
            .arg(path)
            .arg("--cwd")
            .arg(cwd)
            .arg("--timeout-ms")
            .arg(timeout.to_string())
            .arg("--command")
            .arg(command)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .unwrap()
    .unwrap()
}

#[tokio::test]
async fn shell_diagnostics_preserve_output_exit_and_enforce_policy_before_effects() {
    let directory = tempfile::tempdir().unwrap();
    let cwd = directory.path();
    #[cfg(unix)]
    let command = "printf 'hello 界'; printf failure >&2; exit 7";
    #[cfg(windows)]
    let command = "[Console]::Out.Write('hello 界'); [Console]::Error.Write('failure'); exit 7";
    let output = run(cwd, &Sandbox::Disabled, command, 3000).await;
    assert_eq!(output.status.code(), Some(7), "{output:?}");
    assert_eq!(output.stdout, "hello 界".as_bytes());
    assert_eq!(output.stderr, b"failure");
    #[cfg(unix)]
    let command = "sleep 30";
    #[cfg(windows)]
    let command = "Start-Sleep -Seconds 30";
    let output = run(cwd, &Sandbox::Disabled, command, 100).await;
    assert_eq!(output.status.code(), Some(124), "{output:?}");
    // Keep stdout open but stop reading after observing actual output. Neither
    // process cancellation nor Tokio shutdown may wait for this consumer.
    #[cfg(unix)]
    let command = "head -c 16777216 /dev/zero";
    #[cfg(windows)]
    let command =
        "$b = [byte[]]::new(16777216); [Console]::OpenStandardOutput().Write($b, 0, $b.Length)";
    let mut blocked = tokio::process::Command::new(crate::maka_executable())
        .args(["sandbox", "run", "--policy"])
        .arg(cwd.join("policy.json"))
        .arg("--cwd")
        .arg(cwd)
        .args(["--timeout-ms", "2000", "--command", command])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        blocked
            .stdout
            .as_mut()
            .unwrap()
            .read_exact(&mut [0])
            .await
            .unwrap();
        assert_eq!(blocked.wait().await.unwrap().code(), Some(124));
    })
    .await
    .expect("blocked stdout prevented sandbox timeout or CLI shutdown");
    let output = run(
        cwd,
        &Sandbox::External {
            network: maka_sandbox::Network::Denied,
        },
        "echo should-not-run",
        3000,
    )
    .await;
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("external isolation"));
    #[cfg(target_os = "macos")]
    {
        use maka_sandbox::filesystem::{Access, Policy, Rule};
        let output = run(
            cwd,
            &Sandbox::Managed {
                filesystem: Policy::uniform(Access::Read),
                network: maka_sandbox::Network::Denied,
            },
            "printf forbidden > result",
            3000,
        )
        .await;
        assert!(!output.status.success(), "{output:?}");
        assert!(!cwd.join("result").exists());
        let mut filesystem = Policy::uniform(Access::Read);
        filesystem
            .rules
            .push(Rule::subtree(cwd.canonicalize().unwrap(), Access::Write));
        let output = run(
            cwd,
            &Sandbox::Managed {
                filesystem,
                network: maka_sandbox::Network::Denied,
            },
            "printf allowed > result",
            3000,
        )
        .await;
        assert!(output.status.success(), "{output:?}");
        assert_eq!(std::fs::read(cwd.join("result")).unwrap(), b"allowed");
    }
}
