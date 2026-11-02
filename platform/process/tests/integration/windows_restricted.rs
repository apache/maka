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
use maka_process::{Command, ProcessOutcome, pipe, pty};
use maka_sandbox::{
    filesystem::Scope,
    windows::{
        WriteCapability, WriteToken,
        acl::{self, Permission},
    },
};
use std::{
    fs::OpenOptions, os::windows::fs::OpenOptionsExt, path::PathBuf, sync::Arc, time::Duration,
};
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_BACKUP_SEMANTICS, READ_CONTROL, WRITE_DAC,
};

// This exercises the token at the real native launch boundary. It deliberately
// does not claim to validate dedicated-account or network provisioning.
#[tokio::test]
async fn write_restriction_is_present_at_foreground_pipe_and_conpty_startup() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let root = tempfile::tempdir().unwrap();
        let work = root.path().join("work");
        std::fs::create_dir(&work).unwrap();
        std::fs::write(root.path().join("outside"), "unchanged").unwrap();
        let capability = WriteCapability::new(uuid::Uuid::new_v4());
        let directory = OpenOptions::new()
            .access_mode(READ_CONTROL | WRITE_DAC)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(&work).unwrap();
        acl::set(&directory, capability.sid(), Scope::Subtree, Some(Permission::Write)).unwrap();
        let token = Arc::new(WriteToken::current(std::slice::from_ref(&capability)).unwrap());
        let executable = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        let command = |terminal| {
            let mut plan = Command::new(&executable, &work).with_write_token(token.clone());
            // PowerShell performs its system-policy probe in TEMP. An unwritable
            // inherited profile temp directory incorrectly forces constrained
            // language mode. Give this execution its explicitly writable scratch.
            plan.env("TEMP", &work).env("TMP", &work);
            plan.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
            plan.arg(format!(r#"
                $ErrorActionPreference='Stop'
                if ([Console]::IsOutputRedirected -eq [bool]::Parse('{terminal}')) {{ exit 71 }}
                [IO.File]::WriteAllText((Join-Path $pwd 'allowed'), 'written')
                try {{ [IO.File]::WriteAllText((Join-Path $pwd '..\outside'), 'escaped'); exit 72 }}
                catch {{ if (($_.Exception.GetBaseException().HResult -band 65535) -ne 5) {{ exit 73 }} }}
                $child = Start-Process -FilePath $env:ComSpec -ArgumentList '/d /c "echo escaped > ..\outside"' -NoNewWindow -PassThru -Wait
                if ($child.ExitCode -eq 0) {{ exit 74 }}
                [Console]::WriteLine('token-io')
                exit 17
            "#));
            plan
        };
        let observed = command(false).observe(Some(10_000), CancellationToken::new()).unwrap();
        let captured = observed.completion.await.unwrap();
        assert!(matches!(captured.outcome, ProcessOutcome::Exited(exit) if exit.code() == Some(17)), "{captured:?}");
        assert!(captured.stdout.contains("token-io"), "{captured:?}");

        let mut child = pipe::spawn(command(false)).await.unwrap();
        drop(child.stdin);
        let (mut out, mut err) = (String::new(), Vec::new());
        let (status, output, errors) = tokio::join!(child.child.wait(), child.stdout.read_to_string(&mut out), child.stderr.read_to_end(&mut err));
        output.unwrap();
        errors.unwrap();
        assert_eq!(status.unwrap().code(), Some(17), "{out}\n{err:?}");
        assert!(out.contains("token-io"));

        let (mut child, io) = pty::spawn(command(true), TerminalSize::new(80, 24).unwrap()).await.unwrap();
        let (status, output) = tokio::join!(async {
            let status = child.wait().await.unwrap();
            child.close().await.unwrap();
            status
        }, async {
            let mut output = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let count = io.read(&mut buffer).await.unwrap();
                if count == 0 { break; }
                output.extend_from_slice(&buffer[..count]);
                assert!(output.len() < 65536);
            }
            String::from_utf8(output).unwrap()
        });
        assert_eq!(status.code(), Some(17), "{output}");
        assert!(output.contains("token-io"));
        assert_eq!(std::fs::read_to_string(root.path().join("outside")).unwrap(), "unchanged");
        assert_eq!(std::fs::read_to_string(work.join("allowed")).unwrap(), "written");
        acl::set(&directory, capability.sid(), Scope::Subtree, None).unwrap();
    }).await.expect("restricted native I/O and cleanup must be bounded");
}
