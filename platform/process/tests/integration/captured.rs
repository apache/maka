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
use maka_process::{ShellExecutor, pipe, pty};
use maka_sandbox::{
    Network, Sandbox,
    filesystem::{Access, Policy, Rule},
};
use std::{fs, time::Duration};
use tokio::io::AsyncReadExt;

#[tokio::test]
async fn pathname_replacement_never_redirects_the_captured_working_directory() {
    for managed in [false, true] {
        for terminal in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().canonicalize().unwrap();
            let original = root.join("workspace");
            let moved = root.join("original");
            fs::create_dir(&original).unwrap();
            fs::write(original.join("identity"), "admitted").unwrap();
            let policy = if managed {
                Sandbox::Managed {
                    filesystem: Policy {
                        default: Access::Read,
                        rules: vec![Rule::subtree(&root, Access::Write)],
                        deny_globs: vec![],
                    },
                    network: Network::Denied,
                }
            } else {
                Sandbox::Disabled
            };
            let executor = ShellExecutor::from_directory(
                original.clone(),
                fs::File::open(&original).unwrap(),
                policy,
            )
            .unwrap()
            .with_login_shell(false);
            let plan = if terminal {
                executor.command_pty("cat identity")
            } else {
                executor.command_pipes("cat identity")
            }
            .unwrap();
            fs::rename(&original, &moved).unwrap();
            fs::create_dir(&original).unwrap();
            fs::write(original.join("identity"), "replacement").unwrap();
            let output = tokio::time::timeout(Duration::from_secs(5), async {
                if terminal {
                    let (mut child, io) =
                        pty::spawn(plan, TerminalSize::new(80, 24).unwrap()).await?;
                    let read = async {
                        let mut output = Vec::new();
                        let mut bytes = [0; 4096];
                        loop {
                            let n = io.read(&mut bytes).await.unwrap();
                            if n == 0 {
                                return output;
                            }
                            output.extend_from_slice(&bytes[..n]);
                        }
                    };
                    let (status, output) = tokio::join!(child.wait(), read);
                    assert!(status.unwrap().success());
                    child.close().await.unwrap();
                    Ok::<_, maka_agent_facts::tools::ToolError>(output)
                } else {
                    let mut child = pipe::spawn(plan).await?;
                    drop(child.stdin);
                    let mut output = Vec::new();
                    let (status, read) =
                        tokio::join!(child.child.wait(), child.stdout.read_to_end(&mut output));
                    assert!(status.unwrap().success());
                    read.unwrap();
                    Ok(output)
                }
            })
            .await
            .unwrap();
            // Linux's mount capture rejects a changed namespace before spawn.
            // macOS and direct launches enter the original directory by fd.
            if cfg!(target_os = "linux") && managed {
                assert!(
                    matches!(output, Err(maka_agent_facts::tools::ToolError::Failed(message)) if message.contains("captured cwd identity changed"))
                );
            } else {
                assert_eq!(
                    String::from_utf8(output.unwrap()).unwrap().trim(),
                    "admitted"
                );
            }
        }
    }
}
