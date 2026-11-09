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
    let queued = f.send(session).await.unwrap();
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
    queued
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
#[tokio::test]
async fn native_process_missing_read_reaches_the_next_main_as_an_error() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let (listener, f, session) = fixture().await;
        let reference = format!("maka://runtime/background-tasks/{}", Uuid::new_v4());
        assert!(maka_host_runtime::shell::request::parse_ref(&reference).is_some());
        let queued = call(&listener, &f, &session, "ReadProcess", json!({"ref":reference})).await;
        let run = f.delivered_run(&queued).await;
        let expected = json!({"kind":"failed","message":"Process resource not found in this Session and provider"});
        {
            let (mut socket, _) = listener.accept().await.unwrap();
            let sent = request(&mut socket).await;
            let results: Vec<Value> = sent["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|message| message["role"] == "tool")
                .map(|message| serde_json::from_str(message["content"].as_str().unwrap()).unwrap())
                .collect();
            assert_eq!(results.as_slice(), std::slice::from_ref(&expected));
            service_tools::named_tool_response(&mut socket, "ReadProcess", json!({"ref":reference})).await;
        }
        let result = finish(&listener, &f).await;
        assert_eq!(result, expected);
        let frontier = f.owner.durable.frontier(run).await.unwrap();
        let through = frontier.revision;
        let facts = f.owner.durable.history(run, 0, 256).await.unwrap();
        let mut view = maka_agent_state::fold::RunView::admitted(run, frontier.spec).unwrap();
        for fact in facts.iter().take_while(|fact| fact.revision <= through) {
            view.apply(fact).unwrap();
        }
        assert_eq!(view.revision, through, "complete canonical run history");
        assert_eq!(view.tools.len(), 2);
        let tools: Vec<_> = view.tools.values().collect();
        assert_ne!(tools[0].key.attempt, tools[1].key.attempt);
        // ProcessResult::Failed is a returned service value, not a failed tool dispatch.
        for tool in tools {
            assert_eq!(tool.call.name, "ReadProcess");
            assert!(tool.admitted);
            assert!(matches!(
                tool.accepted.as_ref().map(|accepted| &accepted.outcome),
                Some(maka_agent_facts::durable::AcceptedResult::Succeeded)
            ));
        }
        assert_eq!(
            view.terminal,
            Some(maka_agent_facts::durable::Terminal::Completed),
            "revision={} stopped={} current={:?} blockers={:?} attempts={:?}",
            view.revision,
            view.stopped,
            view.current_attempt,
            view.blockers.iter().map(|(id, blocker)| (
                id,
                &blocker.reason,
                blocker.decision.is_some(),
                blocker.resolved_by,
            )).collect::<Vec<_>>(),
            view.attempts.iter().map(|(id, attempt)| (
                id,
                attempt.admission.is_some(),
                attempt.closed.as_ref().map(|closed| &closed.outcome),
                attempt.cleanup == maka_plugin_core::operation::OperationCleanup::Confirmed,
                attempt.interrupted.is_some(),
                attempt.has_tools,
            )).collect::<Vec<_>>(),
        );
        close(&f).await;
    }).await.expect("missing Process read must return its error to the next Main");
}

async fn partial(f: &Fixture, record: &InteractionRecord) {
    let InteractionRequest::Permissions { request, .. } = &record.request else {
        unreachable!()
    };
    let mut granted = request.permissions.clone();
    granted.filesystem.truncate(1);
    f.mutation(2, "respond", json!({"sessionId":record.execution.session_id,"requestId":record.request_id,
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
        let run=f.latest_run(&session).await.run;
        let frontier = f.owner.durable.frontier(run).await.unwrap();
        let through = frontier.revision;
        let facts = f.owner.durable.history(run, 0, 256).await.unwrap();
        let mut view = maka_agent_state::fold::RunView::admitted(run, frontier.spec).unwrap();
        for fact in facts.iter().take_while(|fact| fact.revision <= through) {
            view.apply(fact).unwrap();
        }
        assert_eq!(view.revision, through, "complete canonical run history");
        assert!(view.tools.values().any(|tool|tool.call.name=="Execute" && tool.admitted
            && tool.decision.as_ref().is_some_and(|decision|decision.display().presentation.as_deref()==Some("maka.workspace.Processes@1/execute"))));
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
        assert!(f.owner.durable.interactions().pending(&session).await.unwrap().records.is_empty());
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
                    json!({"sessionId":session,"runId":f.delivered_run(&started).await}),
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
                f.owner
                    .durable
                    .interactions()
                    .read(&request.execution.session_id, &request.request_id)
                    .await
                    .unwrap()
                    .unwrap()
                    .outcome
                    .is_some()
            );
            assert!(
                f.owner
                    .durable
                    .interactions()
                    .pending(&session)
                    .await
                    .unwrap()
                    .records
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
