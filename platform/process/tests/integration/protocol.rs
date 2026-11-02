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

use maka_process::{Command, pipe};
use std::{
    io::{BufRead, Write},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

#[tokio::test]
async fn protocol_pipes_roundtrip_and_close_descendants_on_exit_or_cancel() {
    const MODE: &str = "MAKA_PROTOCOL_PIPE_TEST_CHILD";
    const TEST: &str = "protocol::protocol_pipes_roundtrip_and_close_descendants_on_exit_or_cancel";
    if let Ok(mode) = std::env::var(MODE) {
        if mode == "descendant" {
            loop {
                std::thread::sleep(Duration::from_secs(60));
            }
        }
        // A real descendant that outlives its protocol root unless the owner
        // closes the group/Job. Do not inherit pipes into the test harness.
        #[expect(
            clippy::zombie_processes,
            reason = "exercise owner cleanup of a descendant after its parent exits"
        )]
        let _descendant = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture"])
            .env(MODE, "descendant")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        println!("protocol-ready");
        std::io::stdout().flush().unwrap();
        if mode == "cancel" {
            loop {
                std::thread::sleep(Duration::from_secs(60));
            }
        }
        let mut input = String::new();
        std::io::stdin().lock().read_line(&mut input).unwrap();
        print!("protocol-echo:{input}");
        eprintln!("protocol-stderr");
        return;
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        let cwd = tempfile::tempdir().unwrap();
        for mode in ["exit", "cancel"] {
            let mut plan = Command::new(
                std::env::current_exe().unwrap(),
                cwd.path().canonicalize().unwrap(),
            );
            plan.args(["--exact", TEST, "--nocapture"]).env(MODE, mode);
            let mut process = pipe::spawn(plan).await.unwrap();
            let mut stdout = BufReader::new(process.stdout);
            loop {
                let mut line = String::new();
                assert_ne!(
                    stdout.read_line(&mut line).await.unwrap(),
                    0,
                    "protocol process exited before ready"
                );
                if line.trim() == "protocol-ready" {
                    break;
                }
            }
            if mode == "exit" {
                process
                    .stdin
                    .write_all("hello 🌍\n".as_bytes())
                    .await
                    .unwrap();
                process.stdin.flush().await.unwrap();
            } else {
                process.child.terminate().unwrap();
            }
            drop(process.stdin);
            let (mut out, mut err) = (String::new(), String::new());
            let (status, out_result, err_result) = tokio::join!(
                process.child.wait(),
                stdout.read_to_string(&mut out),
                process.stderr.read_to_string(&mut err)
            );
            let status = status.unwrap();
            out_result.unwrap();
            err_result.unwrap();
            assert_eq!(status.success(), mode == "exit");
            if mode == "exit" {
                assert!(out.contains("protocol-echo:hello 🌍"));
                assert!(err.contains("protocol-stderr"));
            }
            assert_eq!(
                process.child.wait().await.unwrap(),
                status,
                "confirmed cleanup is idempotent"
            );
        }
    })
    .await
    .expect("process cleanup must be bounded");
}
