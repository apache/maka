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
use maka_host_runtime::application::Mutation;
use maka_plugin_core::operation::{OperationCleanup, OperationResult};
use tokio::io::{AsyncBufReadExt, BufReader};

async fn begin(f: &Fixture, action: Value) -> (Scope, Mutation) {
    let scope = scope(&f.issuer, true);
    let client = f.app.client();
    let prepared = client
        .prepare_mutation(
            f.binding(2).await,
            "executorSetup".into(),
            json!({"executor":"external","action":action}),
            scope.clone(),
            Uuid::new_v4(),
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
    (scope, client.mutate(prepared, intent).await.unwrap())
}
async fn process(control: &TcpListener, _protocol: u8) -> (BufReader<TcpStream>, String) {
    let (socket, _) = control.accept().await.unwrap();
    let mut socket = BufReader::new(socket);
    let mut pid = String::new();
    socket.read_line(&mut pid).await.unwrap();
    assert!(pid.trim().parse::<u32>().is_ok());
    (socket, pid)
}
async fn traces(f: &Fixture, trace: &std::path::Path) -> Vec<Value> {
    use maka_plugin_core::storage::{Namespace, Scan};
    let namespace = Namespace::new(
        maka_workspace_api::protocol::IMPLEMENTATION,
        maka_plugin_core::scope::Scope::Profile,
    )
    .unwrap();
    let mut scan = Scan::default();
    let mut calls = vec![];
    loop {
        let page = f
            .store
            .plugin_data_scan(&namespace, scan.clone())
            .await
            .unwrap();
        for entry in page.entries {
            let Some(value) = entry.record.data.value() else {
                continue;
            };
            if value["source"]["kind"] != "setup" {
                continue;
            }
            let path = std::path::Path::new(value["resourceRef"].as_str().unwrap())
                .join("tmp")
                .join(trace.file_name().unwrap());
            if path.exists() {
                calls.extend(
                    std::fs::read_to_string(path)
                        .unwrap()
                        .lines()
                        .map(|line| serde_json::from_str::<Value>(line).unwrap()),
                );
            }
        }
        match page.next_after {
            Some(after) => scan.after = Some(after),
            None => return calls,
        }
    }
}

fn reaped(pid: &str) {
    assert!(
        !std::process::Command::new("/bin/kill")
            .args(["-0", pid.trim()])
            .output()
            .unwrap()
            .status
            .success(),
        "setup must reap its process before returning confirmed cleanup"
    );
}
async fn result(f: &Fixture, authority: Scope, mut mutation: Mutation) -> Value {
    assert!(mutation.recv().await.is_none(), "unexpected setup progress");
    let completed = mutation.completion().await;
    completed.cleanup.unwrap();
    let reference = completed.reply.reference.clone();
    let Receipt::Recorded {
        outcome:
            OperationOutcome::Returned {
                result: OperationResult::Success { value },
            },
        cleanup: OperationCleanup::Confirmed,
    } = completed.reply.receipt
    else {
        panic!("setup must return its business outcome and confirmed cleanup")
    };
    authority.finish().await.unwrap();
    let recovered = f
        .app
        .client()
        .recover(
            f.app.client().activation(&id(2)).unwrap(),
            reference,
            scope(&f.issuer, true),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        recovered.outcome,
        OperationOutcome::Returned {
            result: OperationResult::Success {
                value: value.clone()
            }
        }
    );
    assert_eq!(recovered.cleanup, OperationCleanup::Confirmed);
    value
}
#[tokio::test]
async fn application_setup_v1_and_v2_checks_authenticates_cancels_and_recovers() {
    tokio::time::timeout(Duration::from_secs(90), async {
        for protocol in [1, 2] {
            let (mut f, control, trace, configuration) = setup(protocol).await;
            activate_backend(&mut f, true, None, true, Some(configuration), &[]).await;
            eprintln!("setup v{protocol}: activated");
            let listed = f.query("executors", json!({})).await.unwrap();
            assert_eq!(listed["setup"], json!(["external"]));
            let (scope, mutation) = begin(&f, json!({"kind":"check"})).await;
            let (_socket, pid) = process(&control, protocol).await;
            eprintln!("setup v{protocol}: check process {pid:?} started");
            let checked = result(&f, scope, mutation).await;
            assert_eq!(checked["kind"], "checked");
            assert_eq!(checked["methods"][0]["id"], "login");
            assert_eq!(checked["methods"][0]["supported"], true);
            reaped(&pid);
            eprintln!("setup v{protocol}: check returned");
            for cancel in [false, true] {
                let (scope, mut mutation) = begin(&f, json!({"kind":"authenticate","methodId":"login"})).await;
                let (mut socket, pid) = process(&control, protocol).await;
                assert_eq!(mutation.recv().await.unwrap(), json!({"kind":"authorization_url","url":"https://login.example.invalid/authorize?state=fixture"}));
                eprintln!("setup v{protocol}: auth URL delivered");
                if cancel { scope.cancellation.cancel(); }
                else { socket.get_mut().write_all(b"continue\n").await.unwrap(); }
                eprintln!("setup v{protocol}: awaiting final outcome");
                let value = result(&f, scope, mutation).await;
                assert_eq!(value["kind"], if cancel { "unresolved" } else { "authenticated" });
                reaped(&pid);
            }
            let calls=traces(&f,&trace).await;
            assert_eq!(calls.iter().filter(|entry|entry["method"]=="self_exit" && entry["phase"]=="authentication").count(),1,"successful Auth ACK is flushed before the fixture immediately exits");
            let session=f.create("Private profile runtime").await;
            super::super::super::files::change(&f,&session,"danger_full_access",false,false).await;
            let accepted=execute(&f,&session,"require-login").await;
            let (_runtime,_)=control.accept().await.unwrap();f.drained().await;
            let mut changes = f.owner.durable.subscribe().unwrap();
            let observed = loop {
                changes.borrow_and_update();
                let observed = work(&f, &session, &accepted).await;
                if !matches!(observed["execution"]["state"]["kind"].as_str(), Some("admitted" | "running" | "waiting")) { break observed; }
                changes.changed().await.unwrap();
            };
            assert_eq!(observed["execution"]["state"]["kind"],"completed","{observed}");
            let (_, _, answer) = external_result(&f, &session, &accepted).await;
            assert_eq!(answer,"answer require-login");
            let runtime=trace_text(&f,&session,&trace).await;
            let runtime:Vec<Value>=runtime.lines().map(|line|serde_json::from_str(line).unwrap()).collect();
            assert_eq!(runtime.iter().filter(|entry|entry["method"]=="self_exit" && entry["phase"]=="prompt").count(),1,"runtime also exits immediately after its real terminal response");
            let seeded=runtime.iter().find(|entry|entry["method"]=="profile_seed_read").expect("the new runtime actually reads the persisted private credential");
            assert_eq!(seeded["authenticated"],true);
            let setup_homes:Vec<_>=calls.iter().filter(|entry|entry["method"]=="spawn").map(|entry|&entry["home"]).collect();
            assert!(setup_homes.iter().all(|home|**home!=seeded["home"]),"runtime gets a fresh HOME, not the old authenticated process state");
            assert_eq!(setup_homes.len(),3);
            assert!(!f.workspace.join(".acp-fixture-token").exists());
            assert_eq!(calls.iter().filter(|v| v["method"] == "spawn").count(), 3);
            assert_eq!(calls.iter().filter(|v| v["method"] == "authenticate" || v["method"] == "auth/login").count(), 2);
            assert!(!calls.iter().any(|v| v["method"].as_str().is_some_and(|m| m.starts_with("session/"))), "setup must not create an Agent conversation");
            f.app.shutdown().await.unwrap();
            f.config.shutdown().await.unwrap();
        }
    }).await.unwrap();
}
#[tokio::test]
async fn application_setup_requires_both_setup_and_original_process_run_grants() {
    tokio::time::timeout(Duration::from_secs(60), async {
        for denied in ["setup", "run"] {
            let (mut f, _control, trace, configuration) = setup(2).await;
            activate_backend(&mut f, true, None, true, Some(configuration), &[denied]).await;
            let (scope, mut mutation) = begin(&f, json!({"kind":"check"})).await;
            assert!(mutation.recv().await.is_none());
            let completed = mutation.completion().await;
            completed.cleanup.unwrap();
            assert!(!matches!(completed.reply.receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { result:OperationResult::Success {ref value} }, .. } if value["kind"] == "checked"));
            scope.finish().await.unwrap();
            assert!(traces(&f,&trace).await.is_empty(),"denied setup must not spawn a process");
            f.app.shutdown().await.unwrap();
            f.config.shutdown().await.unwrap();
        }
    }).await.unwrap();
}

fn returned(reply: maka_plugin_core::operation::OperationReply) -> Value {
    match reply.receipt {
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Success { value },
                },
            cleanup: OperationCleanup::Confirmed,
        } => value,
        other => panic!("unexpected setup process receipt: {other:?}"),
    }
}
async fn captured(f: &Fixture, probe: &Probe) -> (Scope, Mutation, Arc<Context>) {
    let (scope, mutation) = begin(f, json!({"kind":"check"})).await;
    probe.entered.acquire().await.unwrap().forget();
    let context = probe.contexts.lock().unwrap().pop_front().unwrap();
    assert!(
        context
            .native_context::<maka_agent_authority::setup::ActualSetupContext>()
            .is_some()
    );
    assert!(context.work_custody().is_none());
    (scope, mutation, context)
}
async fn protocol(
    probe: &Probe,
    context: &Context,
    method: &str,
    input: Value,
) -> (maka_host_runtime::application::NativeRequest, Mutation) {
    let actual = context
        .native_context::<maka_agent_authority::setup::ActualSetupContext>()
        .unwrap();
    let request = probe
        .services
        .get()
        .unwrap()
        .request_with_context(
            context.scope().identity.clone(),
            context.scope().cancellation.clone(),
            actual,
        )
        .unwrap()
        .with_sandbox_floor(context.scope().sandbox_floor())
        .unwrap();
    let resources = maka_host_runtime::application::CallResources::default();
    let descriptors = resources.descriptors().unwrap();
    let recovery = json!({"kind":"setup_process_test","method":method,"input":input,"resources":{"descriptors":descriptors,"reacquisition":{"kind":"none"}}});
    let mutation = request
        .begin_mutation(
            "processes",
            0,
            method.into(),
            input,
            Uuid::new_v4(),
            recovery,
            resources,
        )
        .unwrap()
        .await
        .unwrap();
    (request, mutation)
}
#[tokio::test]
async fn application_process_input_is_request_bound_and_private_root_remains_denied() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let mut f = Fixture::new("http://127.0.0.1:9/v1", None).await;
        let probe = Probe::new(Behavior::SetupProtocol);
        activate_backend(&mut f, true, Some(probe.clone()), true, None, &[]).await;
        let (scope, setup, original) = captured(&f, &probe).await;
        let (request, mut process) = protocol(
            &probe,
            &original,
            "run",
            json!({"executable":"/bin/cat","args":[],"env":{}}),
        )
        .await;
        let started = process.recv().await.unwrap();
        assert_eq!(started["kind"], "started");
        let id = started["id"].clone();
        let (foreign_scope, foreign_setup, foreign) = captured(&f, &probe).await;
        let (foreign_request, denied) =
            protocol(&probe, &foreign, "input", json!({"id":id,"bytes":[88]})).await;
        let denied = denied.completion().await;
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
        foreign_request.finish().await.unwrap();
        let (input, written) = protocol(
            &probe,
            &original,
            "input",
            json!({"id":id,"bytes":[65,0,255]}),
        )
        .await;
        let written = written.completion().await;
        written.cleanup.unwrap();
        assert_eq!(returned(written.reply), json!({"bytes":3,"closed":false}));
        input.finish().await.unwrap();
        let mut output = vec![];
        while output.len() < 3 {
            let item = process.recv().await.unwrap();
            if item["stream"] == "stdout" {
                output.extend(serde_json::from_value::<Vec<u8>>(item["bytes"].clone()).unwrap());
            }
        }
        let (closing, closed) = protocol(&probe, &original, "close", json!({"id":id})).await;
        let closed = closed.completion().await;
        closed.cleanup.unwrap();
        assert_eq!(returned(closed.reply), json!({"bytes":0,"closed":false}));
        closing.finish().await.unwrap();
        while let Some(item) = process.recv().await {
            if item["stream"] == "stdout" {
                output.extend(serde_json::from_value::<Vec<u8>>(item["bytes"].clone()).unwrap());
            }
        }
        let finished = process.completion().await;
        finished.cleanup.unwrap();
        assert_eq!(returned(finished.reply)["kind"], "exited");
        request.finish().await.unwrap();
        assert_eq!(
            output,
            [65, 0, 255],
            "foreign role never writes to the original pipe"
        );
        let secret = f.root.join("setup-private-fixture.txt");
        std::fs::write(&secret, "protected-host-data").unwrap();
        let (request, mut process) = protocol(
            &probe,
            &foreign,
            "run",
            json!({"executable":"/bin/cat","args":[secret],"env":{}}),
        )
        .await;
        assert_eq!(process.recv().await.unwrap()["kind"], "started");
        let mut output = vec![];
        while let Some(item) = process.recv().await {
            if item["stream"] == "stdout" {
                output.extend(serde_json::from_value::<Vec<u8>>(item["bytes"].clone()).unwrap());
            }
        }
        let finished = process.completion().await;
        finished.cleanup.unwrap();
        let value = returned(finished.reply);
        request.finish().await.unwrap();
        assert!(
            output.is_empty(),
            "actual Setup floor cannot expose the Host private Root"
        );
        assert_eq!(value["success"], false);
        probe.release.add_permits(2);
        let checked = result(&f, scope, setup).await;
        assert_eq!(checked["kind"], "checked");
        let checked = result(&f, foreign_scope, foreign_setup).await;
        assert_eq!(checked["kind"], "checked");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
