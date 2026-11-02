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

#![cfg(windows)]

use maka_agent_facts::tools::ToolError;
use maka_agent_facts::tools::ToolExecutor;
use maka_process::{SHELL_NAME, ShellExecutor};
use serde_json::{Value, json};
use std::{
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::Path,
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use windows_sys::Win32::{
    Foundation::WAIT_OBJECT_0,
    System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
    },
};

const CHILD: &str = "$fixtureCode = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('Set-Content child $PID; Start-Sleep -Seconds 300')); Start-Process -NoNewWindow -FilePath (Get-Process -Id $PID).Path -ArgumentList '-NoProfile', '-EncodedCommand', $fixtureCode";

async fn invoke(executor: &ShellExecutor, command: &str) -> Value {
    executor
        .invoke(
            SHELL_NAME.into(),
            json!({"command":command}),
            CancellationToken::new(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn powershell_preserves_unicode_script_boundaries_exit_codes_and_bounded_tails() {
    let dir = tempfile::tempdir().unwrap();
    let executor = ShellExecutor::new(dir.path(), maka_sandbox::Sandbox::Disabled).unwrap();
    assert!(
        executor.description().contains("PowerShell"),
        "Windows installation must provide its standard PowerShell"
    );
    let command = "using namespace System\n[Console]::Write('你好 😀 \"quote\"'); [Console]::Error.Write('error'); exit 7";
    let result = invoke(&executor, command).await;
    assert_eq!(result["status"], "failed");
    assert_eq!(result["exitCode"], 7, "{result}");
    assert_eq!(result["output"]["stdout"], "你好 😀 \"quote\"");
    assert_eq!(result["output"]["stderr"], "error");
    assert_eq!(result["output"]["stdoutTruncated"], false);
    assert_eq!(result["cmd"], command);
    assert_eq!(
        Path::new(result["cwd"].as_str().unwrap()),
        dunce::canonicalize(dir.path()).unwrap()
    );
    assert_eq!(
        invoke(&executor, "exit 259").await["exitCode"],
        259,
        "STILL_ACTIVE is also a valid final exit code"
    );
    assert_eq!(invoke(&executor, "cmd /d /c exit 42").await["exitCode"], 42);
    let result = invoke(
        &executor,
        "cmd /d /c exit 42; [Console]::Write('recovered')",
    )
    .await;
    assert_eq!(result["exitCode"], 0);
    assert_eq!(result["output"]["stdout"], "recovered");
    assert_eq!(invoke(&executor, "[Console]::Write([Environment]::GetEnvironmentVariable('__MAKA_RUNTIME_POWERSHELL_COMMAND'))").await["output"]["stdout"], "");
    let result = invoke(&executor, "[Console]::Write(('界' * 24000) + '尾')").await;
    let text = result["output"]["stdout"].as_str().unwrap();
    assert!(text.len() <= 65536 && text.ends_with('尾') && !text.contains('�'));
    assert_eq!(result["output"]["stdoutTruncated"], true);
    let token = CancellationToken::new();
    token.cancel();
    assert!(matches!(
        executor
            .invoke(
                SHELL_NAME.into(),
                json!({"command":"Set-Content effect bad"}),
                token
            )
            .await,
        Err(ToolError::Failed(_))
    ));
    assert!(!dir.path().join("effect").exists());
}

struct LiveProcess(OwnedHandle);
impl LiveProcess {
    async fn read(path: &Path) -> Self {
        let pid: u32 = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Ok(value) = std::fs::read_to_string(path)
                    && let Ok(pid) = value.trim().parse()
                {
                    break pid;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|error| {
            panic!(
                "{error}: {} bytes={:?}",
                path.display(),
                std::fs::read(path)
            )
        });
        // SAFETY: pin the live fixture process before cancelling; no later PID lookup.
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, pid) };
        assert!(!handle.is_null(), "{}", std::io::Error::last_os_error());
        Self(unsafe { OwnedHandle::from_raw_handle(handle) })
    }
    fn stopped(&self) -> bool {
        // SAFETY: live owned process handle.
        unsafe { WaitForSingleObject(self.0.as_raw_handle(), 0) == WAIT_OBJECT_0 }
    }
    async fn wait(&self) {
        tokio::time::timeout(Duration::from_secs(4), async {
            while !self.stopped() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("owned process exited");
    }
}
impl Drop for LiveProcess {
    fn drop(&mut self) {
        // Cleanup remains active even if an assertion fails.
        if !self.stopped() {
            unsafe {
                TerminateProcess(self.0.as_raw_handle(), 130);
                WaitForSingleObject(self.0.as_raw_handle(), 2000);
            }
        }
    }
}

#[tokio::test]
async fn cancellation_timeout_and_dropped_caller_terminate_the_owned_job() {
    for mode in ["cancel", "timeout", "drop"] {
        let dir = tempfile::tempdir().unwrap();
        let executor = ShellExecutor::new(dir.path(), maka_sandbox::Sandbox::Disabled).unwrap();
        let token = CancellationToken::new();
        let task = tokio::spawn(executor.invoke(
            SHELL_NAME.into(),
            json!({
                "command":format!("{CHILD}; Set-Content root $PID; Start-Sleep -Seconds 300"),
                "timeout_ms": if mode == "timeout" { 5000 } else { 30000 }
            }),
            token.clone(),
        ));
        let root = LiveProcess::read(&dir.path().join("root")).await;
        let child = LiveProcess::read(&dir.path().join("child")).await;
        if mode == "drop" {
            task.abort();
        } else if mode == "cancel" {
            token.cancel();
        }
        let result = tokio::time::timeout(Duration::from_secs(9), task)
            .await
            .unwrap();
        if mode == "drop" {
            assert!(result.unwrap_err().is_cancelled());
        } else {
            let result = result.unwrap().unwrap();
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
        }
        root.wait().await;
        child.wait().await;
    }
}

#[tokio::test]
async fn normal_shell_exit_preserves_background_descendants_but_bounds_pipe_drain() {
    let dir = tempfile::tempdir().unwrap();
    let executor = ShellExecutor::new(dir.path(), maka_sandbox::Sandbox::Disabled).unwrap();
    let task = tokio::spawn(executor.invoke(
        SHELL_NAME.into(),
        json!({
            "command":format!("{CHILD}; [Console]::Write('done')")
        }),
        CancellationToken::new(),
    ));
    let result = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(dir.path().join("child").exists(), "{result}");
    let child = LiveProcess::read(&dir.path().join("child")).await;
    assert_eq!(result["status"], "completed");
    assert_eq!(result["output"]["stdout"], "done");
    assert_eq!(result["output"]["stdoutTruncated"], true);
    assert!(!child.stopped());
    // LiveProcess Drop terminates only this deliberately preserved fixture.
}
