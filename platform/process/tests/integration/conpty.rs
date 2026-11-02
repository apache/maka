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

use maka_agent_facts::terminal::TerminalSize;
use maka_process::pty::{self, PtyCommand, PtyIo};
use std::{
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::PathBuf,
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
};

#[tokio::test]
async fn conpty_console_unicode_resize_exit_259_and_final_output_drain() {
    let cwd = tempfile::tempdir().unwrap();
    let mut command = command(cwd.path().to_path_buf());
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-Command",
        r#"
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
        if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { exit 1 }
        [Console]::WriteLine('ready')
        $line = [Console]::ReadLine()
        [Console]::WriteLine('received:' + $line)
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        while (([Console]::WindowWidth -ne 101 -or [Console]::WindowHeight -ne 37) -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 10
        }
        [Console]::WriteLine('size:' + [Console]::WindowWidth + 'x' + [Console]::WindowHeight)
        [Console]::WriteLine('final-frame')
        exit 259
    "#,
    ]);
    let (mut child, io) = pty::spawn(command, TerminalSize::new(80, 24).unwrap())
        .await
        .unwrap();
    let mut screen = maka_process::terminal::Screen::new(TerminalSize::new(80, 24).unwrap());
    screen.write(&until(&io, "ready").await).unwrap();
    child
        .resize(TerminalSize::new(101, 37).unwrap())
        .await
        .unwrap();
    screen.resize(TerminalSize::new(101, 37).unwrap()).unwrap();
    write(&io, "中文😀\r".as_bytes()).await;
    let (status, output) = tokio::time::timeout(Duration::from_secs(15), async {
        tokio::join!(
            async {
                let status = child.wait().await.unwrap();
                child.close().await.unwrap();
                status
            },
            drain(&io)
        )
    })
    .await
    .unwrap();
    assert_eq!(status.code(), Some(259));
    let output = String::from_utf8(output).unwrap();
    assert!(output.contains("received:中文😀"), "{output:?}");
    assert!(output.contains("size:101x37"), "{output:?}");
    assert!(output.contains("final-frame"), "{output:?}");
    screen.write(&output).unwrap();
    let snapshot = screen.preview(50 * 1024).unwrap();
    assert!(snapshot.screen.contains("received:中文😀"), "{snapshot:?}");
    assert!(snapshot.screen.contains("size:101x37"), "{snapshot:?}");
    assert!(snapshot.screen.contains("final-frame"), "{snapshot:?}");
    child.close().await.unwrap();
    assert!(
        child
            .resize(TerminalSize::new(80, 24).unwrap())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn conpty_cmd_verbatim_source_preserves_embedded_quotes_and_exit_code() {
    let cwd = tempfile::tempdir().unwrap();
    let system = std::env::var_os("SystemRoot").unwrap();
    let mut command = PtyCommand::new(PathBuf::from(system).join("System32/cmd.exe"), cwd.path());
    command.raw_arg(r#"/d /s /c "echo "quoted & data" & exit /b 23""#);
    let (mut child, io) = pty::spawn(command, TerminalSize::new(80, 24).unwrap())
        .await
        .unwrap();
    let (status, output) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(
            async {
                let status = child.wait().await.unwrap();
                child.close().await.unwrap();
                status
            },
            drain(&io)
        )
    })
    .await
    .unwrap();
    assert_eq!(status.code(), Some(23));
    let output = String::from_utf8(output).unwrap();
    assert!(output.contains("\"quoted & data\""), "{output:?}");
}

#[tokio::test]
async fn conpty_explicit_termination_and_drop_kill_the_owned_job() {
    for explicit in [true, false] {
        let cwd = tempfile::tempdir().unwrap();
        let mut command = command(cwd.path().to_path_buf());
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-Command",
            r#"
            $start = [Diagnostics.ProcessStartInfo]::new()
            $start.FileName = $env:ComSpec
            $start.Arguments = '/d /c ping -n 30 127.0.0.1 >NUL'
            $start.UseShellExecute = $false
            $start.CreateNoWindow = $true
            $descendant = [Diagnostics.Process]::Start($start)
            [Console]::WriteLine('desc:' + $descendant.Id + ':end')
            Start-Sleep -Seconds 30
        "#,
        ]);
        let (mut child, io) = pty::spawn(command, TerminalSize::new(80, 24).unwrap())
            .await
            .unwrap();
        let output = until(&io, ":end").await;
        let pid: u32 = output
            .split("desc:")
            .nth(1)
            .unwrap()
            .split(':')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        assert!(!handle.is_null(), "{}", std::io::Error::last_os_error());
        let descendant = unsafe { OwnedHandle::from_raw_handle(handle) };
        assert_eq!(
            unsafe { WaitForSingleObject(descendant.as_raw_handle(), 0) },
            WAIT_TIMEOUT
        );
        if explicit {
            child.terminate().unwrap();
            tokio::time::timeout(Duration::from_secs(10), async {
                tokio::join!(
                    async {
                        child.wait().await.unwrap();
                        child.close().await.unwrap();
                    },
                    drain(&io)
                )
            })
            .await
            .unwrap();
        }
        drop(child);
        tokio::time::timeout(Duration::from_secs(10), async {
            while unsafe { WaitForSingleObject(descendant.as_raw_handle(), 0) } != WAIT_OBJECT_0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
}

fn command(cwd: PathBuf) -> PtyCommand {
    let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap());
    PtyCommand::new(
        system.join(r"System32\WindowsPowerShell\v1.0\powershell.exe"),
        cwd,
    )
}

async fn write(io: &PtyIo, mut bytes: &[u8]) {
    tokio::time::timeout(Duration::from_secs(10), async {
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
    tokio::time::timeout(Duration::from_secs(15), async {
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
