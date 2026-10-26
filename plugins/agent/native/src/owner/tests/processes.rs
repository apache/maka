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

// Actual Seatbelt execution. Linux/Windows native runtime acceptance belongs to their OS runners.
#![cfg(target_os = "macos")]
use super::*;
use maka_agent_facts::interaction::InteractionRecord;
use maka_agent_facts::interaction::InteractionRequest;

pub(super) async fn fixture() -> (TcpListener, Fixture, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fixture::with_services(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
        None,
        Some(service_tools::Setup::processes()),
    )
    .await;
    let session = f.create("Native processes").await;
    (listener, f, session)
}
pub(super) async fn call(
    listener: &TcpListener,
    f: &Fixture,
    session: &str,
    name: &str,
    input: Value,
) -> Value {
    let started = f.send(session).await.unwrap();
    let (mut socket, _) = listener.accept().await.unwrap();
    let sent = request(&mut socket).await;
    assert!(
        sent["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["function"]["name"] == name)
    );
    let delta = json!({"id":"process-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"process-call","type":"function","function":{"name":name,"arguments":input.to_string()}}]},"finish_reason":null}]});
    let body = format!(
        "data: {delta}\n\ndata: {{\"id\":\"process-model\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n"
    );
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    started
}
pub(super) async fn finish(listener: &TcpListener, f: &Fixture) -> Value {
    let (mut socket, _) = listener.accept().await.unwrap();
    let sent = request(&mut socket).await;
    let tool = sent["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|m| m["role"] == "tool")
        .unwrap();
    let result = serde_json::from_str(tool["content"].as_str().unwrap())
        .unwrap_or_else(|e| panic!("{e}: {tool}"));
    response(&mut socket).await;
    f.drained().await;
    result
}
pub(super) async fn roundtrip(
    listener: &TcpListener,
    f: &Fixture,
    session: &str,
    name: &str,
    input: Value,
) -> Value {
    call(listener, f, session, name, input).await;
    finish(listener, f).await
}
pub(super) async fn close(f: &Fixture) {
    f.app.shutdown().await.unwrap();
    f.config.shutdown().await.unwrap();
}
fn execute(command: &str) -> Value {
    json!({"command":command,"login":false,"timeout_ms":5000})
}
#[tokio::test]
async fn shell_titles_preserve_model_history_and_change_only_future_request_schemas() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let (listener, f, session) = fixture().await;
        f.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let schema = |sent: &Value| {
            sent["tools"]
                .as_array()
                .unwrap()
                .iter()
                .find(|tool| tool["function"]["name"] == "Execute")
                .unwrap()["function"]["parameters"]
                .clone()
        };
        assert_eq!(schema(&sent)["properties"]["title"]["type"], "string");
        assert!(
            !schema(&sent)["required"]
                .as_array()
                .unwrap()
                .contains(&json!("title"))
        );
        // A request already sent to the model keeps its advertised input contract.
        let policy = f.config.runtime_policy().await.unwrap();
        f.config
            .set_shell_titles(policy.revision, false)
            .await
            .unwrap();
        let mut input = execute("printf actual");
        input["title"] = json!("  检查\n输出  ");
        service_tools::named_tool_response(&mut socket, "Execute", input.clone()).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(schema(&sent)["properties"].get("title").is_none());
        let messages = sent["messages"].as_array().unwrap();
        let model_call = messages
            .iter()
            .flat_map(|m| m["tool_calls"].as_array().into_iter().flatten())
            .find(|call| call["function"]["name"] == "Execute")
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(model_call["function"]["arguments"].as_str().unwrap())
                .unwrap(),
            input
        );
        let result: Value = serde_json::from_str(
            messages.iter().rev().find(|m| m["role"] == "tool").unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(result["value"]["output"]["stdout"], "actual", "{result}");
        response(&mut socket).await;
        f.drained().await;
        let recorded = service_tools::facts(&f, &session).await;
        assert!(recorded.iter().any(
            |fact| matches!(fact, maka_agent_facts::event::Fact::ToolDispatched {
            title: Some(title), input: recorded, ..
        } if title.fallback == "检查 输出" && recorded == &input)
        ));
        let mut invalid = execute("printf forbidden > disabled-title");
        invalid["title"] = json!("Must reject");
        call(&listener, &f, &session, "Execute", invalid).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let rejected = sent["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|m| m["role"] == "tool")
            .unwrap();
        assert_eq!(
            rejected["content"],
            "invalid tool input: arguments do not match the declared schema"
        );
        assert!(!f.workspace.join("disabled-title").exists());
        response(&mut socket).await;
        f.drained().await;
        let result = roundtrip(
            &listener,
            &f,
            &session,
            "Execute",
            execute("printf fallback"),
        )
        .await;
        assert_eq!(result["value"]["output"]["stdout"], "fallback");
        let recorded = service_tools::facts(&f, &session).await;
        assert!(recorded.iter().any(
            |fact| matches!(fact, maka_agent_facts::event::Fact::ToolDispatched {
            title: Some(title), ..
        } if title.fallback == "printf fallback")
        ));
        close(&f).await;
    })
    .await
    .unwrap();
}
fn permissions(f: &Fixture) -> Value {
    json!({"filesystem":[
        {"path":f.workspace.join("first.txt"),"scope":"exact","access":"write"},
        {"path":f.workspace.join("second.txt"),"scope":"exact","access":"write"}],"network":"denied"})
}
async fn partial(f: &Fixture, record: &InteractionRecord) {
    let InteractionRequest::Permissions { request, .. } = &record.request else {
        unreachable!()
    };
    let mut granted = request.permissions.clone();
    granted.filesystem.truncate(1);
    f.mutation(2, "respond", json!({"sessionId":record.session_id,"requestId":record.request_id,
        "answer":{"kind":"permissions","decision":{"decision":"allow","scope":"once","permissions":granted}}}), Uuid::new_v4()).await.unwrap();
}
#[tokio::test]
async fn native_process_foreground_enforces_workspace_and_protected_boundaries() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let (listener, f, session) = fixture().await;
        let result = roundtrip(
            &listener,
            &f,
            &session,
            "Execute",
            execute("printf native > actual.txt; cat actual.txt"),
        )
        .await;
        assert_eq!(result["value"]["status"], "completed", "{result}");
        assert_eq!(result["value"]["output"]["stdout"], "native");
        let facts = service_tools::facts(&f, &session).await;
        assert!(facts.iter().any(|fact| matches!(fact, maka_agent_facts::event::Fact::ToolDispatched {presentation:Some(key), ..} if key == "maka.workspace.Processes@1/execute")));
        let through = f.through(&session).await;

        let mut position = json!({"kind":"start"});
        let mut result_row = None;
        for _ in 0..32 {
            let page=f.query("history",json!({"sessionId":session,"through":through,"position":position})).await.unwrap();
            assert_eq!(page["kind"], "ready");
            if let Some(row)=page["chunks"].as_array().unwrap().iter().find(|row| row["role"]=="tool_result") {
                result_row=Some(row.clone()); break;
            }
            assert!(!page["after"].is_null(), "process result missing from complete history: {page}");
            position=json!({"kind":"after","cursor":page["after"]});
        }
        let row=result_row.expect("bounded process history");
        assert_eq!(row["tool"]["call"]["presentation"], "maka.workspace.Processes@1/execute");
        for (path, expected) in [(json!(["value","output","stdout"]),"native"),(json!(["value","exitCode"]),"0")] {
            let source=f.query("source",json!({"sessionId":session,"through":through,"source":{"kind":"row","position":row["position"]},"field":"result","path":path,"position":{"kind":"start"}})).await.unwrap();
            assert_eq!(source["source"]["text"], expected);
            assert_eq!(source["source"]["tool"]["call"]["presentation"], "maka.workspace.Processes@1/execute");
            assert!(source["filePath"].is_null());
        }

        assert_eq!(
            std::fs::read_to_string(f.workspace.join("actual.txt")).unwrap(),
            "native"
        );
        std::fs::write(f.root.join("private.txt"), "private-root-secret").unwrap();
        let result = roundtrip(&listener, &f, &session, "Execute", execute("cat ../root/private.txt")).await;
        assert_eq!(result["value"]["status"], "failed", "{result}");
        assert!(!result.to_string().contains("private-root-secret"));
        let mut forbidden = execute("cat ../root/private.txt");
        forbidden["additional_permissions"] = json!({"filesystem":[{"path":f.root.join("private.txt"),"scope":"exact","access":"read"}],"network":"denied"});
        forbidden["justification"] = json!("Read private state.");
        let result = roundtrip(&listener,&f,&session,"Execute",forbidden).await;
        assert_eq!(result["kind"], "failed", "{result}");
        assert!(f.session(&session).await.pending_interactions(&session).await.unwrap().is_empty());
        files::change(&f, &session, "read_only", false, false).await;
        let result = roundtrip(
            &listener,
            &f,
            &session,
            "Execute",
            execute("printf denied > forbidden.txt"),
        )
        .await;
        assert_eq!(result["value"]["status"], "failed", "{result}");
        assert!(!f.workspace.join("forbidden.txt").exists());
        files::change(&f, &session, "workspace_write", true, false).await;
        std::fs::create_dir_all(f.workspace.join(".agents")).unwrap();
        let result = roundtrip(
            &listener,
            &f,
            &session,
            "Execute",
            execute("printf denied > .agents/forbidden.txt"),
        )
        .await;
        assert_eq!(result["value"]["status"], "failed", "{result}");
        assert!(!f.workspace.join(".agents/forbidden.txt").exists());
        close(&f).await;
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn native_process_partial_permission_never_launches_and_full_once_grant_does() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let (listener, f, session) = fixture().await;
        files::change(&f, &session, "read_only", true, false).await;
        let mut input = execute("printf first > first.txt; printf second > second.txt");
        input["additional_permissions"] = permissions(&f);
        input["justification"] = json!("Write both command outputs.");
        call(&listener, &f, &session, "Execute", input.clone()).await;
        let record = files::pending(&f, &session).await;
        assert!(!f.workspace.join("first.txt").exists());
        partial(&f, &record).await;
        let result = finish(&listener, &f).await;
        assert_eq!(result["kind"], "failed", "{result}");
        assert!(!f.workspace.join("first.txt").exists());
        assert!(!f.workspace.join("second.txt").exists());
        call(&listener, &f, &session, "Execute", input).await;
        let record = files::pending(&f, &session).await;
        files::answer(&f, &record, Some("once")).await;
        let result = finish(&listener, &f).await;
        assert_eq!(result["value"]["status"], "completed", "{result}");
        assert_eq!(
            std::fs::read_to_string(f.workspace.join("first.txt")).unwrap(),
            "first"
        );
        assert_eq!(
            std::fs::read_to_string(f.workspace.join("second.txt")).unwrap(),
            "second"
        );
        close(&f).await;
    })
    .await
    .unwrap();
}
async fn wait_pid(path: &std::path::Path) -> u32 {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(value) = std::fs::read_to_string(path)
                && let Ok(pid) = value.trim().parse()
            {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
fn alive(pid: u32) -> bool {
    std::process::Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success()
}
#[tokio::test]
async fn native_process_pty_controls_require_session_and_revision_but_stop_survives_revoke() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let (listener,f,session) = fixture().await;
        let input = json!({"command":"exec /bin/sh -c 'echo $$ > worker.pid; while read line; do echo received:$line; done'","login":false,"run_in_background":true,"pty":true,"timeout_ms":30000});
        let result = roundtrip(&listener,&f,&session,"Execute",input).await;
        assert_eq!(result["kind"], "completed", "{result}");
        let reference = result["value"]["ref"].clone();
        assert!(reference.is_string(),"{result}");
        let pid = wait_pid(&f.workspace.join("worker.pid")).await;
        assert!(alive(pid));
        let other = f.create("Other session").await;
        let result = roundtrip(&listener,&f,&other,"WriteStdin",json!({"ref":reference,"input":"foreign\n"})).await;
        assert_eq!(result["kind"], "failed", "{result}");
        let result = roundtrip(&listener,&f,&session,"WriteStdin",json!({"ref":reference,"input":"native\n","size":{"cols":90,"rows":28}})).await;
        assert_eq!(result["value"]["operation"]["acceptedBytes"],7,"{result}");
        assert_eq!(result["value"]["operation"]["resized"],true,"{result}");
        files::change(&f,&session,"workspace_write",true,true).await;
        let result = roundtrip(&listener,&f,&session,"WriteStdin",json!({"ref":reference,"input":"revoked\n"})).await;
        assert_eq!(result["kind"], "failed", "{result}");
        let result = roundtrip(&listener,&f,&session,"ReadProcess",json!({"ref":reference})).await;
        assert_eq!(result["kind"], "completed", "{result}");
        assert!(result.to_string().contains("received:native"),"{result}");
        assert!(!result.to_string().contains("foreign"),"{result}");
        assert!(!result.to_string().contains("revoked"),"{result}");
        let result = roundtrip(&listener,&f,&session,"StopProcess",json!({"ref":reference})).await;
        assert_eq!(result["value"]["operation"]["applied"],true,"{result}");
        assert!(!alive(pid));
        let result = roundtrip(&listener,&f,&session,"StopProcess",json!({"ref":reference})).await;
        assert_eq!(result["value"]["operation"]["applied"],false,"{result}");
        close(&f).await;
    }).await.unwrap();
}
#[tokio::test]
async fn native_process_provider_retirement_drains_background_pipes_and_ptys() {
    tokio::time::timeout(Duration::from_secs(90), async {
        for pty in [false,true] {
            let (listener,f,session) = fixture().await;
            let result = roundtrip(&listener,&f,&session,"Execute",json!({"command":"exec /bin/sh -c 'echo $$ > worker.pid; while :; do sleep 1; done'","login":false,"run_in_background":true,"pty":pty})).await;
            assert_eq!(result["kind"], "completed", "{result}");
            let pid = wait_pid(&f.workspace.join("worker.pid")).await;
            assert!(alive(pid));
            close(&f).await;
            assert!(!alive(pid));
        }
    }).await.unwrap();
}

#[tokio::test]
async fn native_process_revocation_or_stop_withdraws_permission_without_launch() {
    tokio::time::timeout(Duration::from_secs(90), async {
        for stop in [false, true] {
            let (listener, f, session) = fixture().await;
            files::change(&f, &session, "read_only", true, false).await;
            let mut input = execute("printf first > first.txt; printf second > second.txt");
            input["additional_permissions"] = permissions(&f);
            input["justification"] = json!("Write both command outputs.");
            let started = call(&listener, &f, &session, "Execute", input).await;
            let request = files::pending(&f, &session).await;
            if stop {
                f.mutation(
                    2,
                    "stop",
                    json!({"sessionId":session,"invocationId":started["invocationId"]}),
                    Uuid::new_v4(),
                )
                .await
                .unwrap();
                f.drained().await;
            } else {
                files::change(&f, &session, "read_only", true, true).await;
                let result = finish(&listener, &f).await;
                assert_eq!(result["kind"], "failed", "{result}");
            }
            assert!(
                f.session(&request.session_id)
                    .await
                    .interaction(&request.request_id)
                    .await
                    .unwrap()
                    .unwrap()
                    .outcome
                    .is_some()
            );
            assert!(
                f.session(&session)
                    .await
                    .pending_interactions(&session)
                    .await
                    .unwrap()
                    .is_empty()
            );
            assert!(!f.workspace.join("first.txt").exists());
            assert!(!f.workspace.join("second.txt").exists());
            close(&f).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_process_network_stays_denied_until_approval_and_once_grants_expire() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let (listener, f, session) = fixture().await;
        files::change(&f, &session, "workspace_write", true, false).await;
        let network = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", network.local_addr().unwrap());
        let input = execute(&format!(
            "/usr/bin/curl --noproxy '*' -fsS --max-time 3 '{url}'"
        ));
        let result = roundtrip(&listener, &f, &session, "Execute", input.clone()).await;
        assert_eq!(result["value"]["status"], "failed", "{result}");

        let mut requested = input.clone();
        requested["additional_permissions"] = json!({"filesystem":[],"network":"allowed"});
        requested["justification"] = json!("Read the local test endpoint.");
        call(&listener, &f, &session, "Execute", requested.clone()).await;
        let record = files::pending(&f, &session).await;
        files::answer(&f, &record, None).await;
        let result = finish(&listener, &f).await;
        assert_eq!(result["kind"], "failed", "{result}");
        assert!(
            tokio::time::timeout(Duration::from_millis(25), network.accept())
                .await
                .is_err(),
            "unapproved commands must not reach the endpoint"
        );

        call(&listener, &f, &session, "Execute", requested).await;
        let record = files::pending(&f, &session).await;
        let server = tokio::spawn(async move {
            let (mut socket, _) = network.accept().await.unwrap();
            let mut buffer = [0; 4096];
            assert!(socket.read(&mut buffer).await.unwrap() > 0);
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nnetwork",
                )
                .await
                .unwrap();
            // Keep the same live endpoint available for the next unapproved call.
            network
        });
        files::answer(&f, &record, Some("once")).await;
        let result = finish(&listener, &f).await;
        assert_eq!(result["value"]["status"], "completed", "{result}");
        assert_eq!(result["value"]["output"]["stdout"], "network", "{result}");
        let network = server.await.unwrap();
        let result = roundtrip(&listener, &f, &session, "Execute", input).await;
        assert_eq!(result["value"]["status"], "failed", "{result}");
        assert!(
            tokio::time::timeout(Duration::from_millis(25), network.accept())
                .await
                .is_err(),
            "a once grant must not authorize a later command"
        );
        close(&f).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn sandbox_off_removes_process_filesystem_and_network_isolation() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let (listener, f, session) = fixture().await;
        let external = files::external_directory();
        let outside = external
            .path()
            .canonicalize()
            .unwrap()
            .join("outside-process.txt");
        let command = format!("printf external > '{}'", outside.display());
        for (mode, allowed) in [
            ("workspace_write", false),
            ("danger_full_access", true),
            ("read_only", false),
        ] {
            files::change(&f, &session, mode, false, true).await;
            let result = roundtrip(&listener, &f, &session, "Execute", execute(&command)).await;
            assert_eq!(
                result["value"]["status"],
                if allowed { "completed" } else { "failed" },
                "{mode}: {result}"
            );
            if allowed {
                assert_eq!(std::fs::read_to_string(&outside).unwrap(), "external");
                std::fs::remove_file(&outside).unwrap();
            } else {
                assert!(!outside.exists());
            }
        }
        files::change(&f, &session, "danger_full_access", false, true).await;
        let network = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", network.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = network.accept().await.unwrap();
            let mut buffer = [0; 4096];
            assert!(socket.read(&mut buffer).await.unwrap() > 0);
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nnetwork",
                )
                .await
                .unwrap();
        });
        let result = roundtrip(
            &listener,
            &f,
            &session,
            "Execute",
            execute(&format!(
                "/usr/bin/curl --noproxy '*' -fsS --max-time 3 '{url}'"
            )),
        )
        .await;
        assert_eq!(result["value"]["output"]["stdout"], "network", "{result}");
        server.await.unwrap();
        close(&f).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_process_external_write_requires_approval_and_temp_is_writable() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let (listener, f, session) = fixture().await;
        let external = files::external_directory();
        let outside = external.path().canonicalize().unwrap().join("approved.txt");
        let command = format!("printf approved > '{}'", outside.display());
        let result = roundtrip(&listener, &f, &session, "Execute", execute(&command)).await;
        assert_eq!(result["value"]["status"], "failed", "{result}");
        assert!(!outside.exists());
        let mut input = execute(&command);
        input["additional_permissions"] = json!({"filesystem":[{"path":outside,"scope":"exact","access":"write"}],"network":"denied"});
        input["justification"] = json!("Write the external test file.");
        for scope in [None, Some("once")] {
            call(&listener, &f, &session, "Execute", input.clone()).await;
            let record = files::pending(&f, &session).await;
            assert!(!outside.exists());
            files::answer(&f, &record, scope).await;
            let result = finish(&listener, &f).await;
            if scope.is_some() {
                assert_eq!(result["value"]["status"], "completed", "{result}");
                assert_eq!(std::fs::read_to_string(&outside).unwrap(), "approved");
                std::fs::remove_file(&outside).unwrap();
            } else {
                assert_eq!(result["kind"], "failed", "{result}");
                assert!(!outside.exists());
            }
        }
        let result = roundtrip(&listener, &f, &session, "Execute", execute(&command)).await;
        assert_eq!(result["value"]["status"], "failed", "{result}");
        assert!(!outside.exists());
        for directory in [std::env::temp_dir(), std::path::PathBuf::from("/tmp")] {
            let temporary = tempfile::tempdir_in(directory).unwrap();
            let target = temporary.path().join("output");
            let command = format!("printf temporary > '{}'", target.display());
            let result = roundtrip(&listener, &f, &session, "Execute", execute(&command)).await;
            assert_eq!(result["value"]["status"], "completed", "{result}");
            assert_eq!(std::fs::read_to_string(target).unwrap(), "temporary");
        }
        close(&f).await;
    }).await.unwrap();
}
