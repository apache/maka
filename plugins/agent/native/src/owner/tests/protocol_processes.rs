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

// Actual Seatbelt processes; other platforms use their native acceptance runners.
#![cfg(target_os = "macos")]
use super::*;
use maka_agent_facts::event::Invocation;
use maka_host_runtime::application::Mutation;

async fn fixture() -> (TcpListener, Fixture, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fixture::with_services(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
        None,
        Some(service_tools::Setup::protocol()),
    )
    .await;
    let session = f.create("Protocol process").await;
    (listener, f, session)
}
async fn turn(listener: &TcpListener, f: &Fixture, session: &str) -> (TcpStream, Invocation) {
    f.send(session).await.unwrap();
    let (mut socket, _) = listener.accept().await.unwrap();
    request(&mut socket).await;
    let invocation = f
        .session(session)
        .await
        .session_projection::<StoredSessionConfiguration>(session)
        .await
        .unwrap()
        .unwrap()
        .root_turn
        .unwrap()
        .invocation;
    (socket, invocation)
}
async fn authority(
    f: &Fixture,
    invocation: &Invocation,
) -> (Scope, maka_event_log::root_store::SessionExecutionScope) {
    let session = &invocation.session_id;
    let execution = f
        .session(session)
        .await
        .execution_scope(Some(
            f.owner
                .session(session)
                .await
                .unwrap()
                .configuration
                .permission_basis(),
        ))
        .await
        .unwrap();
    let scope = f
        .issuer
        .issue_with_execution(
            Identity::Agent {
                invocation: invocation.clone(),
                operation_id: Some("protocol-fixture".into()),
            },
            true,
            CancellationToken::new(),
            execution.store().execution_custody().unwrap(),
        )
        .unwrap();
    (scope, execution)
}

async fn begin(
    f: &Fixture,
    consumer: u128,
    scope: Scope,
    method: &str,
    input: Value,
    operation: Uuid,
) -> Mutation {
    let client = f.app.client();
    let binding = client
        .bind(client.activation(&id(consumer)).unwrap(), "protocol".into())
        .await
        .unwrap()
        .remove(0);
    let prepared = client
        .prepare_mutation(
            binding,
            method.into(),
            input,
            scope,
            operation,
            Attachments::new().into(),
        )
        .await
        .unwrap();
    let intent = f
        .store
        .record_application_intent(
            prepared.reference().source.clone(),
            prepared.consumer().instance().clone(),
            prepared.reference().clone(),
            Value::Null,
        )
        .await
        .unwrap();
    client.mutate(prepared, intent).await.unwrap()
}
fn returned(reply: maka_plugin_core::operation::OperationReply) -> Value {
    match reply.receipt {
        Receipt::Recorded {
            outcome: OperationOutcome::Returned { value },
            ..
        } => value,
        other => panic!("unexpected protocol receipt: {other:?}"),
    }
}
async fn input(
    f: &Fixture,
    invocation: &Invocation,
    process: &Value,
    bytes: Option<Vec<u8>>,
    operation: Uuid,
) -> Value {
    let (scope, execution) = authority(f, invocation).await;
    let result = begin(
        f,
        2,
        scope.clone(),
        "input",
        json!({"id":process,"bytes":bytes}),
        operation,
    )
    .await
    .completion()
    .await;
    result.cleanup.unwrap();
    scope.finish().await.unwrap();
    drop(execution);
    returned(result.reply)
}
async fn run(
    f: &Fixture,
    invocation: &Invocation,
    executable: &str,
    args: Vec<String>,
) -> (
    Scope,
    maka_event_log::root_store::SessionExecutionScope,
    Mutation,
    Value,
) {
    let (scope, execution) = authority(f, invocation).await;
    let mut mutation = begin(
        f,
        2,
        scope.clone(),
        "run",
        json!({"executable":executable,"args":args,"env":{}}),
        Uuid::new_v4(),
    )
    .await;
    let started = mutation.recv().await.unwrap();
    assert_eq!(started["kind"], "started", "{started}");
    (scope, execution, mutation, started["id"].clone())
}
async fn drain(mut mutation: Mutation) -> (Vec<u8>, Vec<u8>, Value) {
    let (mut stdout, mut stderr) = (vec![], vec![]);
    while let Some(item) = mutation.recv().await {
        let progress: maka_workspace_api::protocol::Progress =
            serde_json::from_value(item).unwrap();
        match progress {
            maka_workspace_api::protocol::Progress::Output { stream, bytes } => match stream {
                maka_workspace_api::protocol::Stream::Stdout => stdout.extend(bytes),
                maka_workspace_api::protocol::Stream::Stderr => stderr.extend(bytes),
            },
            _ => panic!("unexpected duplicate startup"),
        }
    }
    let result = mutation.completion().await;
    result.cleanup.unwrap();
    (stdout, stderr, returned(result.reply))
}
async fn end_turn(f: &Fixture, socket: &mut TcpStream) {
    response(socket).await;
    f.drained().await;
}

#[tokio::test]
async fn protocol_exact_bytes_replay_and_same_process_across_turns() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let (listener, f, session) = fixture().await;
        let (mut socket, first) = turn(&listener, &f, &session).await;
        let (scope, execution, mutation, process) = run(&f, &first, "/bin/cat", vec![]).await;
        let drained = tokio::spawn(drain(mutation));
        let mut expected = vec![];
        let bytes: Vec<u8> = (0..8192).map(|n| n as u8).collect();
        for _ in 0..24 {
            let operation = Uuid::new_v4();
            let written = input(&f, &first, &process, Some(bytes.clone()), operation).await;
            assert_eq!(written, json!({"bytes":8192,"closed":false}));
            assert_eq!(
                input(&f, &first, &process, Some(bytes.clone()), operation).await,
                written
            );
            expected.extend_from_slice(&bytes);
        }
        end_turn(&f, &mut socket).await;
        // The original process call is still owned while this Session has no active Turn.
        assert!(!drained.is_finished());
        let (stale_scope, stale_execution) = authority(&f, &first).await;
        let mut stale = begin(
            &f,
            2,
            stale_scope.clone(),
            "run",
            json!({"executable":"/bin/cat","args":[],"env":{}}),
            Uuid::new_v4(),
        )
        .await;
        assert!(
            stale.recv().await.is_none(),
            "ended invocation cannot launch another process"
        );
        let stale = stale.completion().await;
        stale.cleanup.unwrap();
        assert!(matches!(
            stale.reply.receipt,
            Receipt::Recorded {
                outcome: OperationOutcome::Unknown { .. },
                ..
            }
        ));
        stale_scope.finish().await.unwrap();
        drop(stale_execution);
        let (mut socket, second) = turn(&listener, &f, &session).await;
        assert_ne!(first.invocation_id, second.invocation_id);
        input(
            &f,
            &second,
            &process,
            Some(b"next turn\n".to_vec()),
            Uuid::new_v4(),
        )
        .await;
        expected.extend_from_slice(b"next turn\n");
        input(&f, &second, &process, None, Uuid::new_v4()).await;
        let (stdout, stderr, result) = drained.await.unwrap();
        assert_eq!(stdout, expected);
        assert!(stderr.is_empty());
        assert_eq!(result["success"], true, "{result}");
        scope.finish().await.unwrap();
        drop(execution);
        end_turn(&f, &mut socket).await;
        processes::close(&f).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn protocol_ownership_revocation_and_actual_cancellation_cleanup() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let (listener, f, session) = fixture().await;
        let (mut socket, invocation) = turn(&listener, &f, &session).await;
        let (scope, execution, mutation, process) = run(&f, &invocation, "/bin/cat", vec![]).await;
        // Same real Session and grant cannot take another activation's process.
        let (foreign_scope, foreign_execution) = authority(&f, &invocation).await;
        let foreign = begin(
            &f,
            3,
            foreign_scope.clone(),
            "input",
            json!({"id":process,"bytes":[1]}),
            Uuid::new_v4(),
        )
        .await
        .completion()
        .await;
        foreign.cleanup.unwrap();
        assert!(matches!(
            foreign.reply.receipt,
            Receipt::Recorded {
                outcome: OperationOutcome::Unknown { .. },
                ..
            }
        ));
        foreign_scope.finish().await.unwrap();
        drop(foreign_execution);
        // No new input is necessary for a permission change to stop an idle process.
        files::change(&f, &session, "read_only", false, true).await;
        let (stdout, _, result) = drain(mutation).await;
        assert!(stdout.is_empty());
        assert_eq!(result["stopped"], true, "{result}");
        assert_eq!(result["error"], "Protocol process permissions changed");
        scope.finish().await.unwrap();
        drop(execution);
        files::change(&f, &session, "workspace_write", true, false).await;
        let (scope, execution, mutation, _) = run(
            &f,
            &invocation,
            "/bin/sh",
            vec!["-c".into(), "echo $$; exec /bin/cat".into()],
        )
        .await;
        let mut mutation = mutation;
        let mut pid = vec![];
        while !pid.contains(&b'\n') {
            let item = mutation.recv().await.unwrap();
            let maka_workspace_api::protocol::Progress::Output { bytes, .. } =
                serde_json::from_value(item).unwrap()
            else {
                panic!("process PID output required")
            };
            pid.extend(bytes);
        }
        let pid = String::from_utf8(pid).unwrap();
        assert!(pid.trim().parse::<u32>().is_ok());
        scope.cancellation.cancel();
        let (_, _, result) = drain(mutation).await;
        assert_eq!(result["stopped"], true, "{result}");
        scope.finish().await.unwrap();
        drop(execution);
        let status = std::process::Command::new("/bin/kill")
            .args(["-0", pid.trim()])
            .output()
            .unwrap();
        assert!(
            !status.status.success(),
            "process must be reaped before cleanup is complete"
        );
        end_turn(&f, &mut socket).await;
        processes::close(&f).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn protocol_argv_private_root_stdin_close_and_session_retirement() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let (listener, f, session) = fixture().await;
        let (mut socket, invocation) = turn(&listener, &f, &session).await;
        let literal = "$(touch shell-injection); $HOME; 'quoted'";
        let (scope, execution, mutation, _) = run(
            &f,
            &invocation,
            "/usr/bin/printf",
            vec!["%s".into(), literal.into()],
        )
        .await;
        let (stdout, _, result) = drain(mutation).await;
        assert_eq!(stdout, literal.as_bytes());
        assert_eq!(result["success"], true);
        assert!(!f.workspace.join("shell-injection").exists());
        scope.finish().await.unwrap();
        drop(execution);
        std::fs::write(f.root.join("secret"), "private secret").unwrap();
        let (scope, execution, mutation, _) = run(
            &f,
            &invocation,
            "/bin/cat",
            vec![f.root.join("secret").to_str().unwrap().into()],
        )
        .await;
        let (stdout, _, result) = drain(mutation).await;
        assert!(stdout.is_empty());
        assert_eq!(result["success"], false);
        scope.finish().await.unwrap();
        drop(execution);
        // EOF must reject subsequent writes even while the child remains alive.
        let (scope, execution, mut mutation, process) = run(
            &f,
            &invocation,
            "/bin/sh",
            vec!["-c".into(), "cat; printf eof; exec /bin/sleep 60".into()],
        )
        .await;
        input(&f, &invocation, &process, None, Uuid::new_v4()).await;
        let observed = mutation.recv().await.unwrap();
        assert_eq!(
            observed["bytes"],
            json!([101, 111, 102]),
            "child must observe EOF before completing input"
        );
        let (after_scope, after_execution) = authority(&f, &invocation).await;
        let after = begin(
            &f,
            2,
            after_scope.clone(),
            "input",
            json!({"id":process,"bytes":[1]}),
            Uuid::new_v4(),
        )
        .await
        .completion()
        .await;
        after.cleanup.unwrap();
        after_scope.finish().await.unwrap();
        drop(after_execution);
        assert!(matches!(
            after.reply.receipt,
            Receipt::Recorded {
                outcome: OperationOutcome::Unknown { .. },
                ..
            }
        ));
        end_turn(&f, &mut socket).await;
        let current = f
            .session(&session)
            .await
            .get_session::<StoredSessionConfiguration>(&session)
            .await
            .unwrap()
            .unwrap();
        f.store
            .begin_session_removal(&session, current.revision)
            .await
            .unwrap();
        let (_, _, result) = drain(mutation).await;
        assert_eq!(result["stopped"], true, "{result}");
        scope.finish().await.unwrap();
        drop(execution);
        assert!(f.store.session_retirement_ready(&session).await.unwrap());
        processes::close(&f).await;
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn protocol_native_requests_require_explicit_grants_and_own_cleanup() {
    tokio::time::timeout(Duration::from_secs(90), async {
        for granted in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let setup = service_tools::Setup::protocol();
            let setup = if granted {
                setup
            } else {
                setup.without_grant()
            };
            let f = Fixture::with_services(
                &format!("http://{}/v1", listener.local_addr().unwrap()),
                None,
                None,
                Some(setup),
            )
            .await;
            let session = f.create("Native protocol").await;
            let (mut socket, invocation) = turn(&listener, &f, &session).await;
            let execution_scope = f
                .session(&session)
                .await
                .execution_scope(Some(
                    f.owner
                        .session(&session)
                        .await
                        .unwrap()
                        .configuration
                        .permission_basis(),
                ))
                .await
                .unwrap();
            let execution = execution_scope.store().execution_custody().unwrap();
            let request = f
                .services
                .request_with_execution(
                    Identity::Agent {
                        invocation: invocation.clone(),
                        operation_id: Some("native-protocol".into()),
                    },
                    CancellationToken::new(),
                    execution.clone(),
                )
                .unwrap();
            let started = request
                .begin_mutation(
                    "service",
                    0,
                    "run".into(),
                    json!({"executable":"/bin/cat","args":[],"env":{}}),
                    Uuid::new_v4(),
                    Attachments::new(),
                )
                .unwrap()
                .await;
            if !granted {
                assert!(started.is_err());
                request.finish().await.unwrap();
                drop(execution_scope);
            } else {
                let mut mutation = started.unwrap();
                let process = mutation.recv().await.unwrap()["id"].clone();
                let reply = request
                    .mutate(
                        "service",
                        0,
                        "input".into(),
                        json!({"id":process,"bytes":[65,0,255]}),
                        Uuid::new_v4(),
                        Attachments::new(),
                    )
                    .unwrap()
                    .await
                    .unwrap();
                assert_eq!(returned(reply)["bytes"], 3);
                let reader = tokio::spawn(drain(mutation));
                request
                    .mutate(
                        "service",
                        0,
                        "input".into(),
                        json!({"id":process,"bytes":null}),
                        Uuid::new_v4(),
                        Attachments::new(),
                    )
                    .unwrap()
                    .await
                    .unwrap();
                let (stdout, _, completion) = reader.await.unwrap();
                assert_eq!(stdout, [65, 0, 255]);
                assert_eq!(completion["success"], true);
                request.finish().await.unwrap();
                let request = f
                    .services
                    .request_with_execution(
                        Identity::Agent {
                            invocation,
                            operation_id: Some("shutdown-protocol".into()),
                        },
                        CancellationToken::new(),
                        execution.clone(),
                    )
                    .unwrap();
                let mut mutation = request
                    .begin_mutation(
                        "service",
                        0,
                        "run".into(),
                        json!({"executable":"/bin/cat","args":[],"env":{}}),
                        Uuid::new_v4(),
                        Attachments::new(),
                    )
                    .unwrap()
                    .await
                    .unwrap();
                assert_eq!(mutation.recv().await.unwrap()["kind"], "started");
                // Retirement retains accepted native work. The native caller
                // must finish its request before application cleanup can finish.
                let finish = async {
                    while !f.app.client().snapshot().closing {
                        tokio::task::yield_now().await;
                    }
                    assert!(!f.app.client().snapshot().closed);
                    request.finish().await.unwrap();
                    drop(execution_scope);
                };
                let (closed, (), (_, _, completion)) =
                    tokio::join!(f.app.shutdown(), finish, drain(mutation));
                closed.unwrap();
                assert_eq!(completion["stopped"], true);
                f.config.shutdown().await.unwrap();
            }
            if !granted {
                end_turn(&f, &mut socket).await;
                processes::close(&f).await;
            }
        }
    })
    .await
    .unwrap();
}
