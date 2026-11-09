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
use executor::{Behavior, Probe};
use maka_agent_authority::executor::ExecutorCallContext;
use maka_host_runtime::application::{Context, Mutation, NativeRequest};
use maka_plugin_core::operation::{OperationCleanup, OperationResult};

pub(super) struct Original {
    pub(super) context: Arc<Context>,
    pub(super) authority: Arc<ExecutorCallContext>,
}
pub(super) async fn fixture() -> (Fixture, Arc<Probe>, String) {
    let mut f = Fixture::new("http://127.0.0.1:9/v1", None).await;
    let probe = Probe::new(Behavior::Protocol);
    executor::activate_backend(&mut f, true, Some(probe.clone()), true, None, &[]).await;
    let session = f.create("Protocol process").await;
    (f, probe, session)
}
pub(super) async fn task(f: &Fixture, probe: &Probe, session: &str) -> (Value, Original) {
    let accepted = f.mutation(2,"send",json!({"sessionId":session,"message":"protocol harness","backend":{"kind":"executor","selection":{"executor":"external","settings":{}}}}),Uuid::new_v4()).await.unwrap();
    probe.entered.acquire().await.unwrap().forget();
    let context = probe
        .contexts
        .lock()
        .unwrap()
        .pop_front()
        .expect("actual selected provider context");
    let authority = context
        .native_context::<ExecutorCallContext>()
        .expect("original native executor capability");
    assert_eq!(authority.0.execution(), &f.execution(&accepted).await);
    (accepted, Original { context, authority })
}
pub(super) async fn begin(
    probe: &Probe,
    original: &Original,
    method: &str,
    input: Value,
    operation: Uuid,
) -> Result<(NativeRequest, Mutation), String> {
    let context = &original.context;
    if method != "close" {
        let current = context
            .native_context::<ExecutorCallContext>()
            .ok_or("original observer is closed")?;
        if !Arc::ptr_eq(&current, &original.authority) {
            return Err("original capability changed".into());
        }
    }
    let request = probe
        .services
        .get()
        .expect("actual provider services")
        .request_with_work_and_context(
            context.scope().identity.clone(),
            CancellationToken::new(),
            context
                .work_custody()
                .expect("original Root custody")
                .clone(),
            original.authority.clone(),
        )?
        .with_sandbox_floor(context.scope().sandbox_floor())?;
    let resources = maka_host_runtime::application::CallResources::default();
    let recovery = json!({"kind":"protocol_test","version":2,"correlation":{"source":context.scope().identity,"caller":request.scope().identity},"target":{"kind":"import","name":"processes","member":0},"method":method,"input":input,"resources":{"descriptors":resources.descriptors()?,"reacquisition":{"kind":"none"}}});
    let mutation = request
        .begin_mutation(
            "processes",
            0,
            method.into(),
            input,
            operation,
            recovery,
            resources,
        )?
        .await?;
    Ok((request, mutation))
}
pub(super) fn returned(reply: maka_plugin_core::operation::OperationReply) -> Value {
    match reply.receipt {
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Success { value },
                },
            cleanup: OperationCleanup::Confirmed,
        } => value,
        other => panic!("unexpected protocol receipt: {other:?}"),
    }
}
pub(super) async fn input(
    probe: &Probe,
    original: &Original,
    process: &Value,
    bytes: Option<Vec<u8>>,
    operation: Uuid,
) -> Value {
    let (request, mutation) = begin(
        probe,
        original,
        "input",
        json!({"id":process,"bytes":bytes}),
        operation,
    )
    .await
    .unwrap();
    let result = mutation.completion().await;
    result.cleanup.unwrap();
    request.finish().await.unwrap();
    returned(result.reply)
}
pub(super) async fn run(
    probe: &Probe,
    original: &Original,
    executable: &str,
    args: Vec<String>,
) -> (NativeRequest, Mutation, Value) {
    let (request, mut mutation) = begin(
        probe,
        original,
        "run",
        json!({"executable":executable,"args":args,"env":{}}),
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    let started = mutation.recv().await.unwrap();
    assert_eq!(started["kind"], "started", "{started}");
    assert!(std::path::Path::new(started["resourceRef"].as_str().unwrap()).is_absolute());
    (request, mutation, started["id"].clone())
}
pub(super) async fn close(probe: &Probe, original: &Original, process: &Value) {
    let (request, mutation) = begin(
        probe,
        original,
        "close",
        json!({"id":process}),
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    let result = mutation.completion().await;
    result.cleanup.unwrap();
    let ack = returned(result.reply);
    assert_eq!(
        ack,
        json!({"bytes":0,"closed":false}),
        "control acknowledgement is not group closure"
    );
    request.finish().await.unwrap();
}
async fn drain(
    mut mutation: Mutation,
    count: tokio::sync::watch::Sender<usize>,
) -> (
    Vec<u8>,
    Vec<u8>,
    maka_host_runtime::application::MutationCompletion,
) {
    let (mut stdout, mut stderr) = (vec![], vec![]);
    while let Some(item) = mutation.recv().await {
        match serde_json::from_value::<maka_workspace_api::protocol::Progress>(item).unwrap() {
            maka_workspace_api::protocol::Progress::Output { stream, bytes } => match stream {
                maka_workspace_api::protocol::Stream::Stdout => {
                    stdout.extend(bytes);
                    count.send_replace(stdout.len());
                }
                maka_workspace_api::protocol::Stream::Stderr => stderr.extend(bytes),
            },
            _ => panic!("unexpected duplicate startup"),
        }
    }
    (stdout, stderr, mutation.completion().await)
}

#[tokio::test]
async fn protocol_exact_bytes_replay_and_new_private_task_across_turns() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let (f, probe, session) = fixture().await;
        let (first, original) = task(&f, &probe, &session).await;
        let (request, mutation, process) = run(&probe, &original, "/bin/cat", vec![]).await;
        let (count, mut observed) = tokio::sync::watch::channel(0);
        let drained = tokio::spawn(drain(mutation, count));
        let mut expected = vec![];
        let bytes: Vec<u8> = (0..8192).map(|n| n as u8).collect();
        for _ in 0..24 {
            let operation = Uuid::new_v4();
            let written = input(&probe, &original, &process, Some(bytes.clone()), operation).await;
            assert_eq!(written, json!({"bytes":8192,"closed":false}));
            assert_eq!(
                input(&probe, &original, &process, Some(bytes.clone()), operation).await,
                written
            );
            expected.extend_from_slice(&bytes);
        }
        while *observed.borrow_and_update() < expected.len() {
            observed.changed().await.unwrap();
        }
        close(&probe, &original, &process).await;
        let (stdout, stderr, completion) = drained.await.unwrap();
        completion.cleanup.unwrap();
        assert_eq!(stdout, expected);
        assert!(stderr.is_empty());
        assert_eq!(returned(completion.reply)["kind"], "exited");
        request.finish().await.unwrap();
        probe.release.add_permits(1);
        f.drained().await;
        assert!(
            begin(
                &probe,
                &original,
                "run",
                json!({"executable":"/bin/cat","args":[],"env":{}}),
                Uuid::new_v4()
            )
            .await
            .is_err(),
            "closed caller cannot start another task"
        );
        let (second, next) = task(&f, &probe, &session).await;
        assert_ne!(first["runId"], second["runId"]);
        assert_ne!(original.authority.0.task_id(), next.authority.0.task_id());
        let (foreign, mutation) = begin(
            &probe,
            &next,
            "input",
            json!({"id":process,"bytes":[1]}),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        let denied = mutation.completion().await;
        denied.cleanup.unwrap();
        assert!(
            !matches!(
                denied.reply.receipt,
                Receipt::Recorded {
                    outcome: OperationOutcome::Returned {
                        result: OperationResult::Success { .. }
                    },
                    ..
                }
            ),
            "new task cannot borrow the old process"
        );
        foreign.finish().await.unwrap();
        let (request, mutation, new_process) = run(&probe, &next, "/bin/cat", vec![]).await;
        assert_ne!(new_process, process);
        let (count, mut observed) = tokio::sync::watch::channel(0);
        let drained = tokio::spawn(drain(mutation, count));
        input(
            &probe,
            &next,
            &new_process,
            Some(b"next turn\n".to_vec()),
            Uuid::new_v4(),
        )
        .await;
        while *observed.borrow_and_update() < 10 {
            observed.changed().await.unwrap();
        }
        close(&probe, &next, &new_process).await;
        let (stdout, stderr, completion) = drained.await.unwrap();
        completion.cleanup.unwrap();
        assert_eq!(stdout, b"next turn\n");
        assert!(stderr.is_empty());
        assert_eq!(returned(completion.reply)["kind"], "exited");
        request.finish().await.unwrap();
        probe.release.add_permits(1);
        f.drained().await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn protocol_ownership_revocation_and_observer_detachment_preserve_private_job() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let (f, probe, session) = fixture().await;
        let (accepted, original) = task(&f, &probe, &session).await;
        let (request, mut mutation, process) = run(
            &probe,
            &original,
            "/bin/sh",
            vec!["-c".into(), "echo $$; exec /bin/cat".into()],
        )
        .await;
        let mut pid = vec![];
        while !pid.contains(&b'\n') {
            let maka_workspace_api::protocol::Progress::Output { bytes, .. } =
                serde_json::from_value(mutation.recv().await.unwrap()).unwrap()
            else {
                panic!("original PID required")
            };
            pid.extend(bytes);
        }
        let pid = String::from_utf8(pid).unwrap();
        assert!(pid.trim().parse::<u32>().is_ok());
        let other_session = f.create("Other protocol task").await;
        let (_, other) = task(&f, &probe, &other_session).await;
        let (foreign, mutation_foreign) = begin(
            &probe,
            &other,
            "input",
            json!({"id":process,"bytes":[1]}),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        let denied = mutation_foreign.completion().await;
        denied.cleanup.unwrap();
        assert!(!matches!(
            denied.reply.receipt,
            Receipt::Recorded {
                outcome: OperationOutcome::Returned {
                    result: OperationResult::Success { .. }
                },
                ..
            }
        ));
        foreign.finish().await.unwrap();
        files::change(&f, &session, "read_only", false, true).await;
        match begin(
            &probe,
            &original,
            "input",
            json!({"id":process,"bytes":[2]}),
            Uuid::new_v4(),
        )
        .await
        {
            Err(_) => {}
            Ok((denied_request, denied)) => {
                let result = denied.completion().await;
                result.cleanup.unwrap();
                assert!(
                    !matches!(
                        result.reply.receipt,
                        Receipt::Recorded {
                            outcome: OperationOutcome::Returned {
                                result: OperationResult::Success { .. }
                            },
                            ..
                        }
                    ),
                    "permission epoch change rejects original task input"
                );
                denied_request.finish().await.unwrap();
            }
        }
        request.scope().cancellation.cancel();
        let (count, _) = tokio::sync::watch::channel(0);
        let (stdout, _, completion) = drain(mutation, count).await;
        completion.cleanup.unwrap();
        assert!(stdout.is_empty());
        assert!(
            !matches!(
                completion.reply.receipt,
                Receipt::Recorded {
                    outcome: OperationOutcome::Returned {
                        result: OperationResult::Success { .. }
                    },
                    ..
                }
            ),
            "detachment does not prove process exit"
        );
        request.finish().await.unwrap();
        assert!(
            std::process::Command::new("/bin/kill")
                .args(["-0", pid.trim()])
                .status()
                .unwrap()
                .success(),
            "Root observer loss must not kill original private process"
        );
        // Test operator cleanup is explicit, not a production permission grant.
        assert!(
            std::process::Command::new("/bin/kill")
                .args(["-TERM", pid.trim()])
                .status()
                .unwrap()
                .success()
        );
        f.mutation(
            2,
            "stop",
            json!({"sessionId":session,"runId":accepted["runId"]}),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        probe.release.add_permits(2);
        f.drained().await;
        files::change(&f, &session, "workspace_write", false, false).await;
        let (_, fresh) = task(&f, &probe, &session).await;
        assert_ne!(fresh.authority.0.task_id(), original.authority.0.task_id());
        let (fresh_request, fresh_mutation, fresh_process) =
            run(&probe, &fresh, "/bin/cat", vec![]).await;
        let (count, mut observed) = tokio::sync::watch::channel(0);
        let drained = tokio::spawn(drain(fresh_mutation, count));
        input(
            &probe,
            &fresh,
            &fresh_process,
            Some(b"restored\n".to_vec()),
            Uuid::new_v4(),
        )
        .await;
        while *observed.borrow_and_update() < 9 {
            observed.changed().await.unwrap();
        }
        close(&probe, &fresh, &fresh_process).await;
        let (stdout, stderr, result) = drained.await.unwrap();
        result.cleanup.unwrap();
        assert_eq!(stdout, b"restored\n");
        assert!(stderr.is_empty());
        assert_eq!(returned(result.reply)["kind"], "exited");
        fresh_request.finish().await.unwrap();
        probe.release.add_permits(1);
        f.drained().await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
