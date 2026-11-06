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

use maka_agent_facts::terminal::TerminalSize;
use maka_agent_facts::tools::ToolExecutor;
use maka_process::{SHELL_NAME, ShellExecutor};
use maka_sandbox::{
    Destination, Network, Sandbox,
    filesystem::{Access, Policy},
};
use std::{path::Path, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_util::sync::CancellationToken;

pub(super) async fn verify(state: &Path, work: &Path) {
    tokio::time::timeout(Duration::from_secs(30), async {
        let origin = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let denied = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = origin.local_addr().unwrap();
        let denied_address = denied.local_addr().unwrap();
        let network = Network::destination(Destination::new("127.0.0.1", address.port()).unwrap());
        let installation = maka_host_runtime::sandbox::windows::Installation::new(state);
        let allowed_account = installation.execution(network.clone(), &[], &[]).unwrap();
        let denied_account = installation.execution(Network::Denied, &[], &[]).unwrap();
        assert_ne!(
            allowed_account.account.sid(),
            denied_account.account.sid(),
            "network authority participates in account reuse"
        );
        installation.settle(allowed_account.id).unwrap();
        installation.settle(denied_account.id).unwrap();
        drop((allowed_account, denied_account));
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = origin.accept().await.unwrap();
                let mut headers = Vec::new();
                while !headers.ends_with(b"\r\n\r\n") {
                    headers.push(socket.read_u8().await.unwrap());
                }
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK",
                    )
                    .await
                    .unwrap();
            }
        });
        let filesystem = Policy {
            default: Access::Read,
            rules: vec![],
            deny_globs: vec![],
        };
        let backend = Arc::new(maka_host_runtime::sandbox::windows::Backend::new(
            state,
            &crate::maka_executable(),
        ));
        let executor = ShellExecutor::new(
            work,
            Sandbox::Managed {
                filesystem: filesystem.clone(),
                network,
            },
        )
        .unwrap()
        .with_backend(backend.clone());
        let command = format!(
            r#"
            Write-Output '只读 😀'
            '管道 😀' | & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command '$input'
            & "$env:SystemRoot\System32\curl.exe" -fsS --max-time 3 http://{address}
            if ($LASTEXITCODE -ne 0) {{ exit 10 }}
            & "$env:SystemRoot\System32\curl.exe" -fsS --max-time 3 http://{denied_address}
            if ($LASTEXITCODE -eq 0) {{ exit 11 }}
            & "$env:SystemRoot\System32\curl.exe" --noproxy '*' -fsS --max-time 3 http://{address}
            if ($LASTEXITCODE -eq 0) {{ exit 12 }}
            exit 0
        "#
        );
        let output = executor
            .invoke(
                SHELL_NAME.into(),
                serde_json::json!({"command":command}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(output["exitCode"], 0, "{output}");
        // Windows PowerShell's built-in UTF-8 encoder may emit a BOM into a
        // native pipeline in ConstrainedLanguage; the text must not be lossy.
        let text = output["output"]["stdout"].as_str().unwrap().replace("\r\n\u{feff}", "\r\n");
        assert_eq!(text, "只读 😀\r\n管道 😀\r\nOK", "{output}");
        let (mut child, terminal) = maka_process::pty::spawn(
            executor.command_pty(&command).unwrap(),
            TerminalSize::new(80, 24).unwrap(),
        )
        .await
        .unwrap();
        let mut output = Vec::new();
        let (status, ()) = tokio::join!(
            async {
                let status = child.wait().await.unwrap();
                child.close().await.unwrap();
                status
            },
            async {
                let mut buffer = [0; 4096];
                loop {
                    let count = terminal.read(&mut buffer).await.unwrap();
                    if count == 0 {
                        break;
                    }
                    output.extend_from_slice(&buffer[..count]);
                }
            }
        );
        assert!(status.success(), "{}", String::from_utf8_lossy(&output));
        assert!(String::from_utf8_lossy(&output).contains("只读 😀"), "{}", String::from_utf8_lossy(&output));
        assert!(String::from_utf8_lossy(&output).contains("管道 😀"), "{}", String::from_utf8_lossy(&output));
        drop((child, terminal));
        server.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(30), denied.accept())
                .await
                .is_err()
        );
        // Once no gateway is listening, an online sandbox account still cannot
        // impersonate one. The ordinary Host can bind the same reserved port.
        let intent: serde_json::Value = serde_json::from_slice(
            &std::fs::read(state.join("windows-sandbox/installation.json")).unwrap(),
        )
        .unwrap();
        let port = intent["proxy_ports"][0].as_u64().unwrap() as u16;
        drop(TcpListener::bind(("127.0.0.1", port)).await.unwrap());
        let mut filesystem = filesystem;
        filesystem
            .rules
            .push(maka_sandbox::filesystem::Rule::subtree(work, Access::Write));
        let online = ShellExecutor::new(
            work,
            Sandbox::Managed {
                filesystem,
                network: Network::Allowed,
            },
        )
        .unwrap()
        .with_backend(backend);
        let command = format!(
            r#"
            $ErrorActionPreference='Stop'
            if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {{ exit 90 }}
            $l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
            $l.Start(); $l.Stop()
            try {{
                $l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,{port})
                $l.Start(); $l.Stop(); exit 91
            }} catch {{
                if ($_.Exception.InnerException.NativeErrorCode -eq 10013) {{ exit 0 }}
                throw
            }}
        "#
        );
        let mut command = online.command_pty(&command).unwrap();
        command.env("TEMP", work).env("TMP", work);
        let mut child = maka_process::pipe::spawn(command).await.unwrap();
        drop(child.stdin);
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let (status, _, _) = tokio::join!(
            async { child.child.wait().await.unwrap() },
            child.stdout.read_to_end(&mut stdout),
            child.stderr.read_to_end(&mut stderr),
        );
        assert!(
            status.success(),
            "stdout={} stderr={}",
            String::from_utf8_lossy(&stdout),
            String::from_utf8_lossy(&stderr)
        );
    })
    .await
    .unwrap();
}
