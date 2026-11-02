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

// Actual native Seatbelt/PTY execution; other OS acceptance uses their runners.
#![cfg(target_os = "macos")]
use super::*;
use maka_host_runtime::application::{Caller, Subscription};

fn caller() -> Caller {
    Caller::new(
        Arc::new(()),
        maka_plugin_core::deployment::DeploymentRef {
            state_domain: "a".repeat(64),
            deployment: Uuid::new_v4(),
            revision: 1,
        },
        id(2),
        Uuid::new_v4(),
    )
}
fn caller_scope(f: &Fixture, caller: &Caller) -> Scope {
    f.issuer
        .issue_with(
            Identity::Remote {
                request_id: Uuid::new_v4(),
            },
            CallerGrant(caller.clone()),
            CancellationToken::new(),
        )
        .unwrap()
}
async fn binding(f: &Fixture) -> Binding {
    let client = f.app.client();
    client
        .bind(client.activation(&id(2)).unwrap(), "terminal".into())
        .await
        .unwrap()
        .remove(0)
}
async fn begin(
    f: &Fixture,
    caller: &Caller,
    method: &str,
    input: Value,
    operation: Uuid,
) -> maka_host_runtime::application::Mutation {
    let client = f.app.client();
    let prepared = client
        .prepare_mutation(
            binding(f).await,
            method.into(),
            input,
            caller_scope(f, caller),
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
            serde_json::Value::Null,
        )
        .await
        .unwrap();
    client.mutate(prepared, intent).await.unwrap()
}
async fn mutation(
    f: &Fixture,
    caller: &Caller,
    method: &str,
    input: Value,
    operation: Uuid,
) -> Value {
    let completion = begin(f, caller, method, input, operation)
        .await
        .completion()
        .await;
    completion.cleanup.unwrap();
    outcome(completion.reply)
}
fn outcome(reply: maka_plugin_core::operation::OperationReply) -> Value {
    match reply.receipt {
        Receipt::Recorded {
            outcome: OperationOutcome::Returned { value },
            ..
        } => value,
        other => panic!("Unexpected terminal receipt {other:?}"),
    }
}
async fn query(f: &Fixture, method: &str, input: Value) -> Value {
    f.app
        .client()
        .start(
            binding(f).await,
            method.into(),
            input,
            scope(&f.issuer, true),
            Attachments::new().into(),
        )
        .await
        .unwrap()
        .result()
        .await
        .unwrap()
}
async fn subscribe(f: &Fixture, caller: &Caller, method: &str, input: Value) -> Subscription {
    f.app
        .client()
        .subscribe(
            binding(f).await,
            method.into(),
            input,
            caller_scope(f, caller),
            Attachments::new().into(),
        )
        .await
        .unwrap()
}
async fn start(f: &Fixture, caller: &Caller, session: &str) -> Value {
    let result = mutation(
        f,
        caller,
        "start",
        json!({"sessionId":session, "size":{"cols":80,"rows":24}}),
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(result["kind"], "completed", "{result}");
    assert_eq!(result["value"]["result"]["mode"], "pty");
    json!({"sessionId":session,"ref":result["value"]["result"]["ref"]})
}
async fn acquire(f: &Fixture, caller: &Caller, target: &Value) -> (Subscription, Value) {
    let mut stream = subscribe(f, caller, "acquire", target.clone()).await;
    let first = stream.recv().await.unwrap();
    assert_eq!(first["kind"], "completed", "{first}");
    assert_eq!(first["value"]["held"], true);
    assert_eq!(first["value"]["nextSequence"], 1);
    let controller = json!({"target":target,"controllerId":first["value"]["controllerId"]});
    (stream, controller)
}
fn command(controller: &Value, sequence: u64, source: &str) -> Value {
    json!({"controller":controller,"sequence":sequence,"actions":[{"type":"text","text":source},{"type":"key","key":"enter"}]})
}
async fn wait_file(f: &Fixture, name: &str, text: &str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if std::fs::read_to_string(f.workspace.join(name)).is_ok_and(|s| s == text) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn terminal_watch_uses_canonical_snapshots_and_user_base_sandbox() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let (_, f, session) = processes::fixture().await;
        let owner = caller();
        let mut list=subscribe(&f,&owner,"watchList",json!({"sessionId":session})).await;
        assert_eq!(list.recv().await.unwrap()["value"]["total"],0);
        std::fs::write(f.root.join("terminal-private.txt"),"terminal-private-secret").unwrap();
        let started=mutation(&f,&owner,"start",json!({"sessionId":session,
            "command":"printf ready; while [ ! -f watch-output ]; do sleep 0.02; done; printf live-pipe; while [ ! -f watch-release ]; do sleep 0.02; done; printf done; cat ../root/terminal-private.txt"}),Uuid::new_v4()).await;
        assert_eq!(started["kind"],"completed","{started}");
        let target=json!({"sessionId":session,"ref":started["value"]["result"]["ref"]});
        let listed=list.recv().await.unwrap();
        assert_eq!(listed["value"]["total"],1);
        assert!(listed["value"]["resources"][0]["result"]["output"].is_null());
        let mut watch=subscribe(&f,&owner,"watch",target.clone()).await;
        loop {
            let value=watch.recv().await.unwrap();
            assert_eq!(value["kind"],"completed","{value}");
            if value["value"]["result"]["output"]["stdout"].as_str().is_some_and(|s|s.contains("ready")) { break; }
        }
        let id=maka_host_runtime::shell::request::parse_ref(target["ref"].as_str().unwrap()).unwrap();
        let durable=f.session(&session).await.read_shell_run(&session,id).await.unwrap().unwrap();
        let catalog=query(&f,"list",json!({"sessionId":session})).await;
        let changes=f.session(&session).await.subscribe_commits().unwrap();
        std::fs::write(f.workspace.join("watch-output"),"emit").unwrap();
        loop {
            let value=watch.recv().await.unwrap();
            assert_eq!(value["kind"],"completed","{value}");
            if value["value"]["result"]["output"]["stdout"].as_str().is_some_and(|s|s.contains("readylive-pipe")) {
                assert_eq!(value["value"]["result"]["revision"],durable.revision);
                assert_eq!(value["value"]["result"]["updatedAt"],durable.updated_at);
                break;
            }
        }
        assert_eq!(query(&f,"read",target.clone()).await["value"]["result"]["output"]["stdout"],"readylive-pipe");
        assert_eq!(f.session(&session).await.read_shell_run(&session,id).await.unwrap().unwrap(),durable);
        assert_eq!(query(&f,"list",json!({"sessionId":session})).await,catalog);
        assert!(!changes.has_changed().unwrap());
        std::fs::write(f.workspace.join("watch-release"),"finish").unwrap();
        loop {
            let value=watch.recv().await.unwrap();
            if value["value"]["result"]["status"]=="failed" {
                assert!(value["value"]["result"]["output"]["stdout"].as_str().unwrap().contains("readylive-pipedone"));
                assert!(!value.to_string().contains("terminal-private-secret"));
                break;
            }
        }
        let final_record=f.session(&session).await.read_shell_run(&session,id).await.unwrap().unwrap();
        assert!(changes.has_changed().unwrap(), "durable terminal outcome must notify the selected Session");
        assert!(!final_record.state.active());
        let maka_agent_facts::shell_run::ShellOutput::Pipes { stdout, .. }=&final_record.output else {panic!("pipes")};
        assert!(stdout.contains("readylive-pipedone"));
        watch.cancel();
        let completion=watch.completion().await;
        assert_eq!(completion.result.unwrap()["kind"],"completed");
        completion.cleanup.unwrap();
        list.cancel(); list.completion().await.cleanup.unwrap();
        assert_eq!(query(&f,"read",target).await["kind"],"completed");
        processes::close(&f).await;
    }).await.unwrap();
}

#[tokio::test]
async fn workhub_terminal_selects_coordinator_namespace_and_rejects_original_agent_session() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let (_, mut f, ordinary_session) = processes::fixture().await;
        workhub::activate(&mut f, true).await;
        let resolved = workhub::resolve(&f, workhub::selection(&f).await, Uuid::new_v4()).await;
        let coordinator = resolved["session"]["id"].as_str().unwrap();
        assert!(coordinator.starts_with("wh_"));
        let denied = query(&f, "list", json!({"sessionId": ordinary_session})).await;
        assert_eq!(denied["kind"], "failed", "{denied}");
        let listed = query(&f, "list", json!({"sessionId": coordinator})).await;
        assert_eq!(listed["kind"], "completed", "{listed}");
        let owner = caller();
        let started = mutation(&f, &owner, "start", json!({"sessionId": coordinator, "command": "printf coordinator > coordinator-terminal.txt"}), Uuid::new_v4()).await;
        assert_eq!(started["kind"], "completed", "{started}");
        wait_file(&f, "coordinator-terminal.txt", "coordinator").await;
        processes::close(&f).await;
    }).await.unwrap();
}

fn output_request(target: &Value, after: u64) -> Value {
    json!({"target":target,"after":after})
}
fn output_event(value: Value) -> Value {
    assert_eq!(value["kind"], "completed", "{value}");
    value["value"].clone()
}
async fn output_read(f: &Fixture, target: &Value, after: u64) -> Value {
    output_event(query(f, "readOutput", output_request(target, after)).await)
}
fn output_data(event: &Value, after: &mut u64, size: &Value) -> Vec<u8> {
    use base64::Engine;
    assert_eq!(event["kind"], "data", "{event}");
    let sequence = event["sequence"].as_u64().unwrap();
    assert!(
        sequence > *after,
        "raw events must advance in original order: {event}"
    );
    assert_eq!(&event["size"], size);
    *after = sequence;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(event["dataBase64"].as_str().unwrap())
        .unwrap();
    assert!(!bytes.is_empty());
    bytes
}
async fn output_through(
    watch: &mut Subscription,
    after: &mut u64,
    bytes: &mut Vec<u8>,
    needle: &[u8],
    size: &Value,
) {
    while !bytes.windows(needle.len()).any(|window| window == needle) {
        let event = output_event(
            watch
                .recv()
                .await
                .expect("raw output ended before its ACK fence"),
        );
        match event["kind"].as_str().unwrap() {
            "pending" => assert_eq!(event["after"], *after),
            "data" => bytes.extend(output_data(&event, after, size)),
            _ => panic!("unexpected event before raw byte fence: {event}"),
        }
    }
}

#[tokio::test]
async fn terminal_raw_bytes_full_resize_replay_and_observer_cancellation_preserve_native_owner() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let (_, f, session) = processes::fixture().await;
        files::change(&f, &session, "danger_full_access", false, true).await;
        let owner = caller();
        let target = start(&f, &owner, &session).await;
        let (lease, controller) = acquire(&f, &owner, &target).await;
        let denied = f.app.client().start(binding(&f).await, "readOutput".into(), output_request(&target, 0), scope(&f.issuer, false), Attachments::new().into()).await;
        assert_eq!(denied.err().unwrap(), "denied", "raw queries require the original application grant");
        let denied = f.app.client().subscribe(binding(&f).await, "watchOutput".into(), output_request(&target, 0), scope(&f.issuer, false), Attachments::new().into()).await;
        assert_eq!(denied.err().unwrap(), "denied", "raw subscriptions require the original application grant");
        let original_size = json!({"cols":80,"rows":24});
        let resized = json!({"cols":100,"rows":40});

        // Only the pre-script interactive prompt is intentionally discarded.
        let mut after = 0;
        loop {
            let event = output_read(&f, &target, after).await;
            match event["kind"].as_str().unwrap() {
                "data" | "resize" => after = event["sequence"].as_u64().unwrap(),
                "pending" => break,
                _ => panic!("interactive PTY unexpectedly unavailable: {event}"),
            }
        }
        let mut watch = subscribe(&f, &owner, "watchOutput", output_request(&target, after)).await;
        // The marker is absent from the entered command, so shell echo/prompt
        // cannot satisfy this fence. Raw discipline removes echo and ONLCR.
        std::fs::write(f.workspace.join("raw-fixture.sh"), r#"stty raw -echo
printf '\036RAW_BEGIN\037\377\000\033[31m\344'
dd bs=1 count=1 of=/dev/null 2>/dev/null
printf '\270\255\033[0m'
stty size
printf '\036SECOND\037'
dd bs=1 count=1 of=/dev/null 2>/dev/null
dd if=/dev/zero bs=65536 count=32 2>/dev/null
printf '\036BACKLOG_END\037'
dd bs=1 count=1 of=/dev/null 2>/dev/null
printf '\342\202'
"#).unwrap();
        let launched = mutation(&f, &owner, "control", command(&controller, 1, "exec /bin/sh ./raw-fixture.sh"), Uuid::new_v4()).await;
        assert_eq!(launched["kind"], "completed", "{launched}");
        let marker = b"\x1eRAW_BEGIN\x1f";
        let prefix = b"\xff\0\x1b[31m\xe4";
        let mut head = marker.to_vec();
        head.extend_from_slice(prefix);
        let mut initial = Vec::new();
        output_through(&mut watch, &mut after, &mut initial, &head, &original_size).await;
        let at = initial.windows(marker.len()).position(|part| part == marker).unwrap() + marker.len();
        let mut actual = initial[at..].to_vec();
        assert_eq!(actual, prefix, "the first split UTF8 byte must already be observable");
        let before_resize = after;
        let receipt = mutation(&f, &owner, "control", json!({"controller":controller,"sequence":2,"size":resized}), Uuid::new_v4()).await;
        assert_eq!(receipt["kind"], "completed", "{receipt}");
        assert_eq!(receipt["value"]["acceptedBytes"], 0);
        assert_eq!(receipt["value"]["resizeChanged"], true);
        let resize = loop {
            let event = output_event(watch.recv().await.unwrap());
            if event["kind"] == "pending" { continue; }
            break event;
        };
        assert_eq!(resize["kind"], "resize", "{resize}");
        assert_eq!(resize["size"], resized);
        assert_eq!(resize["sequence"], after + 1);
        assert_eq!(output_read(&f, &target, before_resize).await, resize);
        after = resize["sequence"].as_u64().unwrap();
        let future = query(&f, "readOutput", output_request(&target, 9_007_199_254_740_991)).await;
        assert_eq!(future["kind"], "failed", "known live streams must reject a future sequence: {future}");
        let ack = mutation(&f, &owner, "control", json!({"controller":controller,"sequence":3,"actions":[{"type":"text","text":"x"}]}), Uuid::new_v4()).await;
        assert_eq!(ack["kind"], "completed", "{ack}");
        let middle = b"\xb8\xad\x1b[0m40 100\n\x1eSECOND\x1f";
        let mut following = Vec::new();
        output_through(&mut watch, &mut after, &mut following, middle, &resized).await;
        assert_eq!(following, middle, "stty must witness the actual native resize");
        actual.extend_from_slice(&following);
        watch.cancel();
        watch.completion().await.cleanup.unwrap();
        assert_eq!(query(&f, "read", target.clone()).await["value"]["result"]["status"], "running");

        // Resize receipts, not timed writes, force nine distinct ordered events
        // while the real script remains gated on its second ACK.
        let before_resizes = after;
        for index in 0..9u64 {
            let receipt = mutation(&f, &owner, "control", json!({"controller":controller,"sequence":4+index,"size":{"cols":101+index,"rows":40}}), Uuid::new_v4()).await;
            assert_eq!(receipt["kind"], "completed", "observer cancellation must leave its independent controller usable: {receipt}");
            assert_eq!(receipt["value"]["resizeChanged"], true);
        }
        let mut replay = subscribe(&f, &owner, "watchOutput", output_request(&target, before_resizes)).await;
        for col in 101..=109 {
            let event = output_event(replay.recv().await.unwrap());
            assert_eq!(event["kind"], "resize", "{event}");
            assert_eq!(event["sequence"], after + 1);
            assert_eq!(event["size"], json!({"cols":col,"rows":40}));
            assert_eq!(event["initialSize"], original_size);
            assert_eq!(output_read(&f, &target, after).await, event);
            after += 1;
        }
        replay.cancel();
        replay.completion().await.cleanup.unwrap();
        let final_size = json!({"cols":109,"rows":40});
        assert_eq!(output_read(&f, &target, after).await, json!({"kind":"pending","after":after,"size":final_size,"initialSize":original_size}));
        let mut resumed = subscribe(&f, &owner, "watchOutput", output_request(&target, after)).await;
        assert_eq!(output_event(resumed.recv().await.unwrap()), json!({"kind":"pending","after":after,"size":final_size,"initialSize":original_size}), "the final observer must be attached before releasing the child");
        let ack = mutation(&f, &owner, "control", json!({"controller":controller,"sequence":13,"actions":[{"type":"text","text":"y"}]}), Uuid::new_v4()).await;
        assert_eq!(ack["kind"], "completed", "{ack}");
        let backlog_start = after;
        let mut backlog = Vec::new();
        output_through(&mut resumed, &mut after, &mut backlog, b"\x1eBACKLOG_END\x1f", &final_size).await;
        let mut expected_backlog = vec![0; 2 * 1024 * 1024];
        expected_backlog.extend_from_slice(b"\x1eBACKLOG_END\x1f");
        assert_eq!(backlog, expected_backlog);
        // The shell is now waiting for ACK: this public query sees a fixed
        // backlog and must deliver beyond the old 16 KiB service cut.
        let mut replay_after = backlog_start;
        let batch = output_read(&f, &target, replay_after).await;
        let first_batch = output_data(&batch, &mut replay_after, &final_size);
        assert!(first_batch.len() > 16 * 1024);
        assert_eq!(first_batch, expected_backlog[..first_batch.len()]);
        let mut replayed = first_batch;
        while replay_after < after {
            let batch = output_read(&f, &target, replay_after).await;
            replayed.extend(output_data(&batch, &mut replay_after, &final_size));
        }
        assert_eq!(replay_after, after);
        assert_eq!(replayed, expected_backlog);
        actual.extend_from_slice(&backlog);
        let ack = mutation(&f, &owner, "control", json!({"controller":controller,"sequence":14,"actions":[{"type":"text","text":"z"}]}), Uuid::new_v4()).await;
        assert_eq!(ack["kind"], "completed", "{ack}");
        loop {
            let event = output_event(resumed.recv().await.unwrap());
            match event["kind"].as_str().unwrap() {
                "pending" => assert_eq!(event["after"], after),
                "data" => actual.extend(output_data(&event, &mut after, &final_size)),
                "closed" => {
                    assert_eq!(event["after"], after);
                    assert_eq!(event["size"], final_size);
                    break;
                },
                _ => panic!("unexpected resumed event: {event}"),
            }
        }
        resumed.completion().await.cleanup.unwrap();
        let mut expected = prefix.to_vec();
        expected.extend_from_slice(middle);
        expected.extend_from_slice(&expected_backlog);
        expected.extend_from_slice(b"\xe2\x82");
        assert_eq!(actual, expected, "raw bytes must retain ff, NUL, ANSI and both split and incomplete UTF8");
        let mut screen = subscribe(&f, &owner, "watch", target.clone()).await;
        loop {
            let snapshot = screen.recv().await.unwrap();
            let status = snapshot["value"]["result"]["status"].as_str().unwrap();
            if !matches!(status, "starting" | "running") {
                assert_eq!(status, "completed", "{snapshot}");
                break;
            }
        }
        screen.cancel();
        screen.completion().await.cleanup.unwrap();
        // Existing stop waits for the real worker's drained fence; it cannot
        // signal this already completed script or turn raw EOF into exit proof.
        let stopped = mutation(&f, &owner, "stop", target.clone(), Uuid::new_v4()).await;
        assert_eq!(stopped["kind"], "completed", "{stopped}");
        assert_eq!(stopped["value"]["applied"], false);
        lease.completion().await.cleanup.unwrap();
        assert_eq!(output_read(&f, &target, after).await, json!({"kind":"unavailable","reason":"not_retained"}));
        let historical = query(&f, "read", target).await;
        assert_eq!(historical["kind"], "completed");
        assert_eq!(historical["value"]["result"]["status"], "completed");
        assert!(historical["value"]["result"]["output"]["screen"].as_str().unwrap().contains("40 100"));
        processes::close(&f).await;
    }).await.unwrap();
}
