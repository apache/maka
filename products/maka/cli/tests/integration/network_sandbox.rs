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

use maka_agent_facts::tools::ToolExecutor;
use maka_process::{SHELL_NAME, ShellExecutor};
use maka_sandbox::{
    Destination, Network, Sandbox,
    filesystem::{Access, Policy},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn private_namespace_routes_pipes_and_ptys_only_through_the_owned_gateway() {
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let root = tempfile::tempdir().unwrap();
        let origin = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let denied = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = origin.local_addr().unwrap();
        let denied_address = denied.local_addr().unwrap();
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
        let sandbox = Sandbox::Managed {
            filesystem: Policy {
                default: Access::Read,
                rules: vec![],
                deny_globs: vec![],
            },
            network: Network::destination(Destination::new("127.0.0.1", address.port()).unwrap()),
        };
        let executor = ShellExecutor::new(root.path(), sandbox)
            .unwrap()
            .with_network_helper(env!("CARGO_BIN_EXE_maka").into());
        let command = format!(
            r#"
            /usr/bin/curl -fsS --max-time 3 http://{address} || exit 10
            if /usr/bin/curl -fsS --max-time 3 http://{denied_address}; then exit 11; fi
            if /usr/bin/curl --noproxy '*' -fsS --max-time 3 http://{address}; then exit 12; fi
            for fd in /proc/self/fd/*; do
                case "$(readlink "$fd")" in socket:*) exit 13;; esac
            done
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
        assert_eq!(output["output"]["stdout"], "OK", "{output}");
        let (mut child, terminal) = maka_process::pty::spawn(
            executor.command_pty(&command).unwrap(),
            maka_agent_facts::terminal::TerminalSize::new(80, 24).unwrap(),
        )
        .await
        .unwrap();
        let mut output = Vec::new();
        let (status, ()) = tokio::join!(child.wait(), async {
            let mut buffer = [0; 4096];
            loop {
                let count = terminal.read(&mut buffer).await.unwrap();
                if count == 0 {
                    break;
                }
                output.extend_from_slice(&buffer[..count]);
            }
        });
        assert!(
            status.unwrap().success(),
            "{}",
            String::from_utf8_lossy(&output)
        );
        child.close().await.unwrap();
        server.await.unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(30), denied.accept())
                .await
                .is_err()
        );
    })
    .await
    .unwrap();
}
