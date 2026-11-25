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

use maka_process::{
    Command,
    isolated::{self, EvidenceInterest, EvidenceWatch, SandboxRuntime, TaskOwner},
};
use maka_sandbox::{
    Network, Sandbox,
    filesystem::{Access, Policy},
};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

#[path = "../../../support/windows_sandbox.rs"]
mod windows_sandbox;
use windows_sandbox::WindowsSandboxGuard;

#[tokio::test]
async fn isolated_task_keeps_native_output_and_private_files()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let state = temp.path().join("root");
    let source = temp.path().join("source");
    fs::create_dir(&state)?;
    fs::create_dir(&source)?;
    fs::write(state.join("secret"), b"hidden")?;
    fs::write(source.join("original"), b"original")?;
    let sandbox_guard = WindowsSandboxGuard::setup(&state).await?;
    let outcome: Result<(), Box<dyn std::error::Error>> = async {
        let exe = crate::maka_executable();
        let backend = maka_host_runtime::sandbox::windows::Backend::new(&state, &exe);
        let runtime = SandboxRuntime::default().with_backend(Arc::new(backend));
        let sandbox = Sandbox::Managed {
            filesystem: Policy::uniform(Access::Read),
            network: Network::Denied,
        };
        let mut task = TaskOwner::prepare(
            &source,
            &state,
            &exe,
            &sandbox,
            &Policy::uniform(Access::Read),
            &runtime,
            CancellationToken::new(),
        )
        .await?;
        let home = task.home_capture().unwrap().clone();
        let candidate = task.candidate_capture()?;
        let descriptor = task.descriptor();
        let shell =
            PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join(r"System32\cmd.exe");
        let mxc_active = maka_sandbox::windows::mxc::is_available();
        let mut command = Command::private_task(&shell);
        command.env("TEST_SECRET", state.join("secret"));
        if mxc_active {
            command.raw_arg(r#"/d /s /c "(type "%TEST_SECRET%" >nul 2>nul && exit /b 17) & (echo changed>original) && (echo config>"%HOME%\.config\settings") && (mkdir "%APPDATA%\app" && echo roaming>"%APPDATA%\app\roaming.txt") && echo LOCALAPPDATA=%LOCALAPPDATA% && echo last-frame""#);
        } else {
            command.raw_arg(r#"/d /s /c "(type "%TEST_SECRET%" >nul 2>nul && exit /b 17) & (echo changed>original) && (echo config>"%HOME%\.config\settings") && (mkdir "%APPDATA%\app" && echo roaming>"%APPDATA%\app\roaming.txt") && (mkdir "%LOCALAPPDATA%\app" && echo local>"%LOCALAPPDATA%\app\local.txt") && echo last-frame""#);
        }
        task.bind_command(&command, &sandbox).await?;
        let mut watch = EvidenceWatch::open(&descriptor, EvidenceInterest::Cleanup).await?;
        let mut process = task.spawn_pipe(command).await?;
        assert_eq!(
            process.child.interrupt_group().await.unwrap_err().kind(),
            std::io::ErrorKind::Unsupported
        );
        let mut errors = Vec::new();
        let mut output = Vec::new();
        let (status, err, out) = tokio::time::timeout(Duration::from_secs(45), async {
            tokio::join!(
                process.child.wait(),
                process.stderr.read_to_end(&mut errors),
                process.stdout.read_to_end(&mut output)
            )
        })
        .await?;
        err?;
        out?;
        assert!(
            status
                .map_err(|e| format!("{e}: {}", String::from_utf8_lossy(&errors)))?
                .success(),
            "{}",
            String::from_utf8_lossy(&errors)
        );
        assert!(output.ends_with(b"last-frame\r\n"), "{output:?}");
        if mxc_active {
            // Windows PSEC redirects LOCALAPPDATA to its own isolated
            // per-container profile rather than exposing Host AppData\Local.
            let stdout_text = String::from_utf8_lossy(&output);
            let local = stdout_text
                .lines()
                .find_map(|line| line.strip_prefix("LOCALAPPDATA="))
                .map(str::trim)
                .expect("missing LOCALAPPDATA line");
            let host_local = std::env::var("LOCALAPPDATA")?;
            assert!(
                !local.is_empty() && !local.eq_ignore_ascii_case(&host_local),
                "MXC task must not expose Host LOCALAPPDATA directly: {local:?}"
            );
        }
        tokio::time::timeout(Duration::from_secs(5), watch.wait()).await??;
        watch.close().await?;
        let mut proof = isolated::closed_evidence(&descriptor).await?.unwrap();
        let mut recorded = Vec::new();
        proof.stdout.read_to_end(&mut recorded)?;
        assert_eq!(recorded, output);
        let frozen = candidate.freeze().await?;
        let isolated::BaselineEntry::File { mut file, .. } =
            frozen.open_entry(Path::new("original"))?
        else {
            panic!("missing candidate")
        };
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        assert_eq!(bytes, b"changed\r\n");
        assert_eq!(fs::read(source.join("original"))?, b"original");
        let captured = home.freeze().await?;
        assert!(home.owns(&captured));
        let entries = captured.entries()?.collect::<Result<Vec<_>, _>>()?;
        assert!(
            entries
                .iter()
                .any(|entry| entry.relative_path == Path::new(".config/settings"))
        );
        assert!(
            entries
                .iter()
                .any(|entry| entry.relative_path == Path::new("AppData/Roaming/app/roaming.txt"))
        );
        if !mxc_active {
            assert!(
                entries
                    .iter()
                    .any(|entry| entry.relative_path == Path::new("AppData/Local/app/local.txt"))
            );
        }
        drop(entries);

        // Seed the captured private HOME into a second isolated task and verify
        // private AppData persists across isolated tasks.
        let mut seeded_task = TaskOwner::prepare(
            &source,
            &state,
            &exe,
            &sandbox,
            &Policy::uniform(Access::Read),
            &runtime,
            CancellationToken::new(),
        )
        .await?;
        let seeded_descriptor = seeded_task.descriptor();
        seeded_task.seed_home(captured.entries()?)?;
        let mut verify = Command::private_task(&shell);
        if mxc_active {
            verify.raw_arg(r#"/d /s /c "type "%APPDATA%\app\roaming.txt"""#);
        } else {
            verify.raw_arg(
                r#"/d /s /c "type "%APPDATA%\app\roaming.txt" && type "%LOCALAPPDATA%\app\local.txt"""#,
            );
        }
        seeded_task.bind_command(&verify, &sandbox).await?;
        let mut seeded_watch =
            EvidenceWatch::open(&seeded_descriptor, EvidenceInterest::Cleanup).await?;
        let mut seeded_process = seeded_task.spawn_pipe(verify).await?;
        let mut seeded_errors = Vec::new();
        let mut seeded_output = Vec::new();
        let (seeded_status, seeded_err, seeded_out) =
            tokio::time::timeout(Duration::from_secs(45), async {
                tokio::join!(
                    seeded_process.child.wait(),
                    seeded_process.stderr.read_to_end(&mut seeded_errors),
                    seeded_process.stdout.read_to_end(&mut seeded_output)
                )
            })
            .await?;
        seeded_err?;
        seeded_out?;
        assert!(
            seeded_status
                .map_err(|e| format!("{e}: {}", String::from_utf8_lossy(&seeded_errors)))?
                .success(),
            "{}",
            String::from_utf8_lossy(&seeded_errors)
        );
        let expected_seeded: &[u8] = if mxc_active {
            b"roaming\r\n"
        } else {
            b"roaming\r\nlocal\r\n"
        };
        assert_eq!(seeded_output, expected_seeded);
        tokio::time::timeout(Duration::from_secs(5), seeded_watch.wait()).await??;
        seeded_watch.close().await?;

        drop((
            seeded_process,
            captured,
            frozen,
            home,
            candidate,
            file,
            process,
            proof,
        ));
        fs::remove_dir_all(seeded_descriptor.resource_ref)?;
        fs::remove_dir_all(descriptor.resource_ref)?;
        Ok(())
    }
    .await;
    sandbox_guard.teardown().await?;
    outcome
}

#[tokio::test]
async fn unconfigured_state_root_uses_mxc_or_requires_windows_sandbox_setup()
-> Result<(), Box<dyn std::error::Error>> {
    use maka_host_runtime::sandbox::windows::{Installation, Status};
    let temp = tempfile::tempdir()?;
    let state = temp.path().join("root");
    let source = temp.path().join("source");
    fs::create_dir(&state)?;
    fs::create_dir(&source)?;
    fs::write(source.join("original"), b"original")?;
    let exe = crate::maka_executable();
    let backend = maka_host_runtime::sandbox::windows::Backend::new(&state, &exe);
    let runtime = SandboxRuntime::default().with_backend(Arc::new(backend));
    let sandbox = Sandbox::Managed {
        filesystem: Policy::uniform(Access::Read),
        network: Network::Denied,
    };
    let prepared = TaskOwner::prepare(
        &source,
        &state,
        &exe,
        &sandbox,
        &Policy::uniform(Access::Read),
        &runtime,
        CancellationToken::new(),
    )
    .await;
    if maka_sandbox::windows::mxc::is_available() {
        let task = prepared?;
        assert_eq!(Installation::new(&state).status()?, Status::NotConfigured);
        assert!(!state.join("windows-sandbox").exists());
        let descriptor = task.descriptor();
        task.into_no_launch_seal().record().await?;
        fs::remove_dir_all(descriptor.resource_ref)?;
    } else {
        let error = match prepared {
            Ok(_) => panic!("unconfigured non-PSEC root must not prepare an isolated task"),
            Err(error) => error,
        };
        assert!(
            error
                .to_string()
                .contains("Windows sandbox setup is required"),
            "expected fail-closed Windows sandbox setup error, got: {error}"
        );
        assert_eq!(Installation::new(&state).status()?, Status::NotConfigured);
        assert!(!state.join("windows-sandbox").exists());
    }
    Ok(())
}

#[tokio::test]
async fn live_terminal_delivers_interrupt_and_settles_descendant_before_closure()
-> Result<(), Box<dyn std::error::Error>> {
    use maka_plugin_core::terminal::TerminalSize;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };

    let temp = tempfile::tempdir()?;
    let state = temp.path().join("state");
    fs::create_dir(&state)?;
    let owner = TaskOwner::prepare_live(
        temp.path(),
        &state,
        &crate::maka_executable(),
        CancellationToken::new(),
    )
    .await?;
    let descriptor = owner.descriptor();
    let shell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let mut command = Command::new(&shell, temp.path());
    command.args(["-NoLogo", "-NoProfile", "-Command", r#"
        $ErrorActionPreference = 'Stop'
        [Console]::TreatControlCAsInput = $true
        $child = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList '-NoProfile -Command Start-Sleep -Seconds 90' -WindowStyle Hidden -PassThru
        [IO.File]::WriteAllText((Join-Path $pwd 'descendant.pid'), [string]$child.Id)
        [Console]::WriteLine('input-ready')
        if ([int][Console]::ReadKey($true).KeyChar -ne 3) { exit 19 }
        [Console]::WriteLine('last-frame')
    "#]);
    let mut process = owner
        .spawn_pty(command, TerminalSize::new(100, 30)?)
        .await?;
    let mut output = Vec::new();
    let mut errors = Vec::new();
    tokio::time::timeout(Duration::from_secs(40), async {
        while !output.windows(11).any(|w| w == b"input-ready") {
            let mut buffer = [0; 4096];
            let n = process.stdout.read(&mut buffer).await?;
            if n == 0 {
                process.stderr.read_to_end(&mut errors).await?;
                return Err(std::io::Error::other(format!(
                    "terminal closed before input: {} {}",
                    String::from_utf8_lossy(&output),
                    String::from_utf8_lossy(&errors)
                )));
            }
            output.extend_from_slice(&buffer[..n]);
        }
        Ok(())
    })
    .await??;
    let pid = fs::read_to_string(temp.path().join("descendant.pid"))?.parse()?;
    // SAFETY: the successful open transfers one synchronization handle for this PID.
    let descendant = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if descendant.is_null() {
        return Err(std::io::Error::last_os_error().into());
    }
    let descendant = unsafe { OwnedHandle::from_raw_handle(descendant) };
    let descendant_state = || unsafe { WaitForSingleObject(descendant.as_raw_handle(), 0) };
    assert_eq!(descendant_state(), WAIT_TIMEOUT);
    assert!(process.child.interrupt_group().await?);
    let (status, _, _) = tokio::time::timeout(Duration::from_secs(30), async {
        tokio::try_join!(
            process.child.wait(),
            process.stdout.read_to_end(&mut output),
            process.stderr.read_to_end(&mut errors),
        )
    })
    .await??;
    assert_eq!(
        status.code(),
        Some(0),
        "{} {}",
        String::from_utf8_lossy(&output),
        String::from_utf8_lossy(&errors)
    );
    assert!(output.windows(10).any(|w| w == b"last-frame"));
    assert_eq!(descendant_state(), WAIT_OBJECT_0);
    let mut proof = isolated::closed_evidence(&descriptor).await?.unwrap();
    assert_eq!(proof.exit_code, Some(0));
    let mut spool = Vec::new();
    proof.stdout.read_to_end(&mut spool)?;
    assert_eq!(spool, output);
    drop(proof);
    fs::remove_dir_all(descriptor.resource_ref)?;
    Ok(())
}
