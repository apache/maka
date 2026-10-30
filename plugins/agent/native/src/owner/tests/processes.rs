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
