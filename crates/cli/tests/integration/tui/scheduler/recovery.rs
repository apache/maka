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

use super::*;

#[test]
fn terminal_creation_reopens_queries_and_retries_without_duplicating_or_resurrecting_tasks() {
    for accepted in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let mut host =
            super::super::super::candidate::CandidateFixture::new(directory.path().join("root"));
        host.child = Some(
            Command::new(env!("CARGO_BIN_EXE_maka"))
                .args(["host", "serve", "--root"])
                .arg(&host.root)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        host.wait_for_registration();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let client = support::model_client(&host.root, &format!("http://{}/v1", listener.local_addr().unwrap())).await;
            let binding = RemoteBinding::Package { package_id: "maka.scheduler".into(), method: "terminal".into(), session_id: None };
            let RemoteResult::Bound { target, .. } = client.plugin_remote(RemoteRequest::Bind { binding: binding.clone() }).await.unwrap() else { panic!("terminal") };
            let grant = client.request(Operation::PluginAuthorization, json!({"binding":binding,"target":target,"command":{
                "kind":"approve","request":{"operationId":uuid::Uuid::new_v4(),"title":"Recovery fixture","target":{"kind":"profile"},"capabilities":["notifications"]}
            }})).await.unwrap();
            remote(&client, "request", json!({"kind":"remember_grant","id":grant["grant"]["id"]})).await;
            let proxy = super::super::recovery::LostReply::terminal_submit(&host.root, directory.path(), accepted).await;
            let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
            tui.wait_for("No sessions yet"); // Plugin commands require the live Host.
            tui.filter_command("Plugin pages");
            tui.click_text("Plugin pages");
            tui.wait_for("Scheduled tasks");
            tui.click_text("Scheduled tasks");
            tui.wait_for("New reminder");
            tui.click_text("New reminder");
            tui.wait_for("Once");
            tui.click_text("Once");
            tui.wait_for("Content");
            tui.click_text("Title");
            tui.send(b"\x1b[200~Saved original reminder\x1b[201~");
            tui.click_text("Content");
            tui.send(b"\x1b[200~Original recovery content\x1b[201~");
            tui.click_text("Create reminder");
            tui.wait_for("result is unconfirmed");
            tui.wait_for("connection failed");
            assert_eq!(proxy.requests().len(), 1);
            // Crash without a final flush: the pre-dispatch checkpoint is sufficient.
            assert!(!tui.terminate().unwrap().success());
            drop(tui);
            let original = proxy.requests()[0]["input"].clone();
            let operation = original["revision"].as_str().unwrap();
            let receipt = remote(&client, "terminal", json!({"kind":"recover","route":{"operation":operation},"locale":"en"})).await;
            if accepted {
                assert_eq!(receipt["kind"], "applied");
                remote(&client, "request", json!({"kind":"mutate","mutation":{"kind":"delete","taskId":receipt["route"]["task"]}})).await;
            } else {
                assert_eq!(receipt["kind"], "unrecorded");
            }
            let mut reopened = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
            reopened.wait_for("Original recovery content");
            reopened.wait_for("Check original submission");
            // A restored form is painted before the connection is ready. Do not
            // click its deliberately disabled recovery controls during startup.
            reopened.wait_until(|screen| screen.contains("Original recovery content")
                && !screen.contains("connecting") && !screen.contains("not connected")
                && !screen.contains("connection failed"));
            assert_eq!(proxy.requests().len(), 1, "restore must not replay");
            reopened.click_text("Check original submission");
            if accepted {
                reopened.wait_for("Task no longer exists");
                assert_eq!(proxy.requests().len(), 1, "known receipt needs no resubmission");
            } else {
                reopened.wait_for("No committed receipt found yet");
                reopened.wait_for("Retry original submission");
                assert_eq!(proxy.requests().len(), 1, "query does not replay");
                reopened.click_text("Retry original submission");
                reopened.wait_for("Pause");
                assert_eq!(proxy.requests().len(), 2);
                assert_eq!(proxy.requests()[1]["input"], original);
            }
            let tasks = remote(&client, "request", json!({"kind":"query","query":{"kind":"list"}})).await;
            assert_eq!(tasks["tasks"].as_array().unwrap().len(), usize::from(!accepted));
            reopened.close_terminal();
            reopened.finish();
            for task in tasks["tasks"].as_array().unwrap() {
                assert_eq!(task["title"], "Saved original reminder");
                remote(&client, "request", json!({"kind":"mutate","mutation":{"kind":"delete","taskId":task["id"]}})).await;
            }
            assert!(tokio::time::timeout(Duration::from_millis(50), listener.accept()).await.is_err());
            client.disconnect();
            drop(proxy);
        });
        host.retire_registered();
        assert!(host.wait_for_exit().success());
    }
}
