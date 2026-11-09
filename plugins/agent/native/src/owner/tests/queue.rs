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
use maka_agent_state::queue::{MessageResolution, Placement as QueuePlacement};

fn returned(receipt: Receipt) -> Value {
    let Receipt::Recorded {
        outcome:
            OperationOutcome::Returned {
                result: OperationResult::Success { value },
            },
        ..
    } = receipt
    else {
        panic!("{receipt:?}")
    };
    value
}

#[tokio::test]
async fn queued_followup_uses_one_physical_worker_and_a_new_run() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let fixture = Fixture::new(&base, None).await;
        let session = fixture.create("Queued followup").await;
        let first = fixture.send(&session).await.unwrap();
        assert_eq!(first["kind"], "queued");
        let first_run = fixture.delivered_run(&first).await;
        let (mut first_socket, _) = listener.accept().await.unwrap();
        request(&mut first_socket).await;
        let next = fixture.mutation(2, "send", json!({"sessionId":session,"message":"original followup","delivery":"queue","backend":model_backend(&fixture.selection().await)}), Uuid::new_v4()).await.unwrap();
        assert_eq!(next["kind"], "queued");
        assert_eq!(fixture.query("work",json!({"sessionId":session,"target":{"kind":"message","messageId":next["messageId"]}})).await.unwrap(),json!({"kind":"pending"}));
        assert_eq!(fixture.query("work",json!({"sessionId":session,"target":{"kind":"message","messageId":"absent_message"}})).await.unwrap(),json!({"kind":"missing"}));
        let other = fixture.create("Other message owner").await;
        assert_eq!(fixture.query("work",json!({"sessionId":other,"target":{"kind":"message","messageId":next["messageId"]}})).await.unwrap(),json!({"kind":"missing"}));
        assert!(fixture.query("work",json!({"sessionId":"foreign_session","target":{"kind":"message","messageId":next["messageId"]}})).await.is_err());
        let state = &fixture.owner.durable;
        let pending = state.queue().read(session.clone()).await.unwrap();
        assert_eq!(pending.entries.len(), 1);
        assert_eq!(pending.entries[0].request.message_id, next["messageId"].as_str().unwrap());
        assert_eq!(pending.entries[0].request.spec.owner, fixture.owner.run_owner());
        assert!(matches!(pending.entries[0].placement, QueuePlacement::Followup));
        {
            let runs = fixture.owner.runs.state().await;
            assert_eq!(runs.controls.len(), 1);
            assert_eq!(runs.controls[&session].execution.run_id, first_run);
        }
        response(&mut first_socket).await;
        let (mut second_socket, _) = listener.accept().await.unwrap();
        let second = request(&mut second_socket).await;
        assert_eq!(second["model"], "fixture-model");
        assert!(second["messages"].as_array().unwrap().iter().any(|message| message["content"] == "original followup"));
        let second_run = fixture.delivered_run(&next).await;
        assert_ne!(second_run, first_run);
        assert!(state.queue().read(session.clone()).await.unwrap().entries.is_empty());
        assert_ne!(state.frontier(first_run).await.unwrap().spec.turn_id, state.frontier(second_run).await.unwrap().spec.turn_id);
        // Keep the original lifecycle control after canonical completion, then
        // lose its observation token. This is not a persisted Stop fence.
        let client = fixture.app.client();
        let tail_input = json!({"sessionId":session,"message":"tail followup","delivery":"queue","backend":model_backend(&fixture.selection().await)});
        let prepared = client.prepare_mutation(fixture.binding(2).await, "send".into(), tail_input.clone(), scope(&fixture.issuer, true), Uuid::new_v4(), Attachments::new().into()).await.unwrap();
        let gate = fixture.owner.runs.lock().await;
        assert_eq!(gate.controls.len(), 1);
        assert_eq!(gate.controls[&session].execution.run_id, second_run);
        let completed = gate.controls[&session].cancellation.clone();
        let submitted = client.mutate_owned(prepared, tail_input).await.unwrap();
        let mut tail = Box::pin(submitted.result());
        assert!(futures_util::poll!(tail.as_mut()).is_pending());
        let mut changed = state.subscribe().unwrap();
        response(&mut second_socket).await;
        loop {
            changed.borrow_and_update();
            if state.frontier(second_run).await.unwrap().terminal == Some(maka_agent_facts::durable::Terminal::Completed) { break; }
            changed.changed().await.unwrap();
        }
        completed.cancel();
        drop(gate);
        let tail = returned(tail.await.receipt);
        assert_eq!(tail["kind"], "queued");
        let (mut third_socket, _) = listener.accept().await.unwrap();
        let third = request(&mut third_socket).await;
        assert!(third["messages"].as_array().unwrap().iter().any(|message| message["content"] == "tail followup"));
        let third_run = fixture.delivered_run(&tail).await;
        assert_ne!(third_run, second_run);
        assert_eq!(fixture.owner.runs.state().await.controls.len(), 1);
        response(&mut third_socket).await;
        fixture.drained().await;
        assert!(fixture.owner.runs.state().await.controls.is_empty());
        assert!(!state.frontier(second_run).await.unwrap().stopped);
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn stopping_original_run_retracts_queue_and_fences_tail_admission() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::new(&format!("http://{}/v1", listener.local_addr().unwrap()), None).await;
        let session = fixture.create("Stop queue").await;
        let first = fixture.send(&session).await.unwrap();
        let first_run = fixture.delivered_run(&first).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        let queued = fixture.send(&session).await.unwrap();
        assert_eq!(queued["kind"], "queued");
        let state = &fixture.owner.durable;
        let selected = state.queue().read(session.clone()).await.unwrap().entries.remove(0);
        assert_eq!(selected.request.message_id, queued["messageId"].as_str().unwrap());
        let client = fixture.app.client();
        let stop_input = json!({"sessionId":session,"runId":first_run});
        let stop_operation = Uuid::new_v4();
        let stop = client.prepare_mutation(fixture.binding(2).await, "stop".into(), stop_input.clone(), scope(&fixture.issuer, true), stop_operation, Attachments::new().into()).await.unwrap();
        let tail_input = json!({"sessionId":session,"message":"after stop","delivery":"queue","backend":model_backend(&fixture.selection().await)});
        let tail = client.prepare_mutation(fixture.binding(2).await, "send".into(), tail_input.clone(), scope(&fixture.issuer, true), Uuid::new_v4(), Attachments::new().into()).await.unwrap();
        let gate = fixture.owner.runs.lock().await;
        assert_eq!(gate.controls[&session].execution.run_id, first_run);
        let stopped = returned(client.mutate_owned(stop, stop_input.clone()).await.unwrap().result().await.receipt);
        assert_eq!(stopped, json!({"requested":true}));
        assert!(state.frontier(first_run).await.unwrap().stopped);
        let submitted = client.mutate_owned(tail, tail_input).await.unwrap();
        let mut tail = Box::pin(submitted.result());
        assert!(futures_util::poll!(tail.as_mut()).is_pending());
        drop(gate);
        let receipt = tail.await.receipt;
        assert!(matches!(receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { result: OperationResult::Failure { ref diagnostic } }, .. } if diagnostic == "agent_admission_failed"), "stopped physical Run admitted its stale tail: {receipt:?}");
        fixture.drained().await;
        assert!(state.queue().entry(session.clone(), selected.request.id).await.unwrap().is_none());
        fixture.owner.schedule_ready().await.unwrap();
        assert!(state.queue().read(session.clone()).await.unwrap().entries.is_empty());
        assert_eq!(state.queue().resolve_message(session.clone(), queued["messageId"].as_str().unwrap().into()).await.unwrap(), MessageResolution::Cancelled);
        assert_eq!(fixture.query("work",json!({"sessionId":session,"target":{"kind":"message","messageId":queued["messageId"]}})).await.unwrap(),json!({"kind":"cancelled"}));
        assert_eq!(fixture.mutation(2,"stop",stop_input,stop_operation).await.unwrap(),stopped);
        assert_eq!(fixture.recorded_facts(&session).await.into_iter().filter(|recorded| matches!(recorded.fact, Fact::StopRequested { .. })).count(), 1);
        let stale=fixture.mutation(2,"send",json!({"sessionId":session,"message":"stale original","delivery":"queue","expectedRunId":first_run,"backend":model_backend(&fixture.selection().await)}),Uuid::new_v4()).await.unwrap();
        assert_eq!(stale["kind"],"rejected");
        assert_eq!(stale["reason"],"turn_stopped");
        // Stop fences the original physical execution, not this Session forever.
        let fresh=fixture.send(&session).await.unwrap();
        assert_eq!(fresh["kind"],"queued");
        let (mut fresh_socket,_)=listener.accept().await.unwrap();
        request(&mut fresh_socket).await;
        assert_ne!(fixture.delivered_run(&fresh).await,first_run);
        response(&mut fresh_socket).await;
        fixture.drained().await;
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn activation_recovers_all_pending_sessions_without_new_sends() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::new(&format!("http://{}/v1", listener.local_addr().unwrap()), None).await;
        use maka_agent_facts::execution::ThinkingLevel::{Off, Low, High};
        selection::thinking(&fixture, vec![Off, Low, High], High).await;
        let deployment = fixture.app.source().unwrap().deployment;
        let database = rusqlite::Connection::open(fixture.session_database("")).unwrap();
        database.execute_batch("CREATE TRIGGER hold_opening BEFORE INSERT ON agent_session_history WHEN NEW.kind='run_admitted' BEGIN SELECT RAISE(ABORT, 'fixture opening failure'); END;").unwrap();
        let mut sessions = Vec::new();
        let mut requests = Vec::new();
        for (index, level) in [Some(Off), Some(Low), None].into_iter().enumerate() {
            let session = fixture.create(&format!("Recovery {index}")).await;
            let queued = fixture.mutation(2, "send", json!({"sessionId":session,"message":"restored thinking","delivery":"queue","backend":{"kind":"model","connectionId":fixture.selection().await.connection_id,"modelId":"fixture-model","thinkingLevel":level}}), Uuid::new_v4()).await.unwrap();
            assert_eq!(queued["kind"], "queued");
            fixture.owner.schedule_ready().await.unwrap();
            fixture.drained().await;
            let pending = fixture.owner.durable.queue().read(session.clone()).await.unwrap();
            assert_eq!(pending.entries.len(), 1);
            assert_eq!(pending.entries[0].request.message_id, queued["messageId"].as_str().unwrap());
            assert!(fixture.owner.durable.latest_run(session.clone()).await.unwrap().is_none());
            requests.push(queued);
            sessions.push(session);
        }
        fixture.app.shutdown().await.unwrap();
        database.execute_batch("DROP TRIGGER hold_opening").unwrap();
        drop(database);
        let mut native = NativeRegistry::default();
        crate::owner::tests::provide_all(&mut native, fixture.owner.durable.clone()).unwrap();
        maka_settings_native::provide(&mut native, crate::owner::tests::bundled_catalog()).unwrap();
        let app = Application::start_from_store(fixture.store.clone(), deployment, native, fixture.issuer.clone(), Arc::new(Grant(fixture.issuer.clone(), None)), Some(maka_host_js::factory(maka_js_runtime::plugin::Limits::default()))).await.unwrap();
        app.ready().await.unwrap();
        let mut efforts = Vec::new();
        for _ in 0..3 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let body = request(&mut socket).await;
            assert_eq!(body["model"], "fixture-model");
            assert!(body["messages"].as_array().unwrap().iter().any(|message| message["content"] == "restored thinking"));
            efforts.push(body["reasoning_effort"].as_str().unwrap().to_owned());
            response(&mut socket).await;
        }
        efforts.sort();
        assert_eq!(efforts, ["high", "low", "none"]);
        for (session, queued) in sessions.into_iter().zip(requests) {
            let run = fixture.delivered_run(&queued).await;
            assert_eq!(fixture.owner.durable.frontier(run).await.unwrap().spec.session_id, session);
            assert!(fixture.owner.durable.queue().read(session).await.unwrap().entries.is_empty());
        }
        app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn queue_controls_are_revisioned_and_observed_without_transcript_progress() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let fixture = Fixture::new(&base, None).await;
        let session = fixture.create("Queue controls").await;
        let queued = fixture.send(&session).await.unwrap();
        let run = fixture.delivered_run(&queued).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        let selection = fixture.selection().await;
        let mut ids = Vec::new();
        for _ in 0..3 {
            let result = fixture.mutation(2, "send", json!({"sessionId":session,"message":"🦀\"\n".repeat(80),"delivery":"queue","backend":model_backend(&selection)}), Uuid::new_v4()).await.unwrap();
            ids.push(result["messageId"].as_str().unwrap().to_owned());
        }
        let queue = fixture.query("queue", json!({"sessionId":session})).await.unwrap();
        assert_eq!(queue["entries"].as_array().unwrap().len(), 3);
        assert!(!queue.to_string().contains("private-fixture-key"));
        assert!(!queue.to_string().contains("execution"));
        let through = fixture.query("observe", json!({"sessionId":session})).await.unwrap()["through"].as_u64().unwrap();
        let mut watch = fixture.app.client().subscribe(fixture.binding(2).await, "watch".into(), json!({"sessionId":session,"after":through}), scope(&fixture.issuer, true), Attachments::new().into()).await.unwrap();
        let first = watch.recv().await.unwrap();
        assert_eq!(first["kind"], "queue");
        assert_eq!(first["queue"], queue);
        let interactions = watch.recv().await.unwrap();
        assert_eq!(interactions["kind"], "interactions");
        assert_eq!(interactions["pending"]["entries"], json!([]));
        let apps = watch.recv().await.unwrap();
        assert_eq!(apps, json!({"kind":"computer_apps","apps":{"entries":[]}}));
        let events = watch.recv().await.unwrap();
        assert_eq!(events["kind"], "events");
        assert_eq!(events["events"], json!([]));
        let message = "x".repeat(96 * 1024);
        let update = json!({"sessionId":session,"expectedRevision":queue["revision"],"edit":{"kind":"update","messageId":ids[0],"message":message}});
        let operation = Uuid::new_v4();
        let changed = fixture.mutation(2, "editQueue", update.clone(), operation).await.unwrap();
        assert_eq!(changed["kind"], "committed");
        assert_eq!(fixture.mutation(2, "editQueue", update.clone(), operation).await.unwrap(), changed);
        assert_eq!(fixture.mutation(2, "editQueue", update, Uuid::new_v4()).await.unwrap()["kind"], "revision_conflict");
        let notice = loop {
            let update = watch.recv().await.unwrap();
            match update["kind"].as_str() {
                Some("queue") => break update,
                Some("interactions") => assert_eq!(update, interactions),
                Some("computer_apps") => assert_eq!(update, apps),
                Some("events") => {
                    assert_eq!(update["through"], through);
                    assert_eq!(update["events"], json!([]));
                }
                Some("preview") => {
                    let contract::DeliveryPage::Preview { page } = serde_json::from_value(update)
                        .expect("queue watch preview must satisfy the public delivery contract")
                    else { unreachable!() };
                    match page {
                        contract::PreviewPage::Empty { host_epoch } => {
                            assert_eq!(host_epoch, fixture.owner.preview_epoch());
                        }
                        contract::PreviewPage::Cut { host_epoch, run_id, depends_on, parts, .. } => {
                            assert_eq!(host_epoch, fixture.owner.preview_epoch());
                            assert_eq!(run_id, run);
                            assert!(depends_on <= through);
                            assert!(parts.is_empty(), "the held provider has emitted no model content");
                        }
                    }
                }
                _ => panic!("unexpected queue watch delivery: {update}"),
            }
        };
        assert_eq!(notice["queue"]["revision"], changed["revision"]);
        assert_eq!(notice["queue"]["entries"][0]["preview"], "x".repeat(80));
        assert_eq!(fixture.query("observe", json!({"sessionId":session})).await.unwrap()["through"], through);
        let read = fixture.query("queueMessage", json!({"sessionId":session,"messageId":ids[0],"expectedRevision":changed["revision"]})).await.unwrap();
        assert_eq!(read, json!({"kind":"ready","revision":changed["revision"],"message":message,"hasAttachments":false}));
        assert_eq!(fixture.query("queueMessage", json!({"sessionId":session,"messageId":ids[0],"expectedRevision":queue["revision"]})).await.unwrap()["kind"], "revision_conflict");
        ids.reverse();
        let reordered = fixture.mutation(2, "editQueue", json!({"sessionId":session,"expectedRevision":changed["revision"],"edit":{"kind":"reorder","messageIds":ids}}), Uuid::new_v4()).await.unwrap();
        assert_eq!(reordered["kind"], "committed");
        assert_eq!(fixture.query("queue", json!({"sessionId":session})).await.unwrap()["entries"][0]["messageId"], ids[0]);
        let retracted = fixture.mutation(2, "editQueue", json!({"sessionId":session,"expectedRevision":reordered["revision"],"edit":{"kind":"retract","messageId":ids[0]}}), Uuid::new_v4()).await.unwrap();
        assert_eq!(retracted["kind"], "committed");
        assert_eq!(fixture.owner.durable.queue().resolve_message(session.clone(), ids[0].clone()).await.unwrap(), MessageResolution::Cancelled);
        assert_eq!(fixture.query("queueMessage", json!({"sessionId":session,"messageId":ids[0],"expectedRevision":retracted["revision"]})).await.unwrap()["kind"], "missing");
        assert!(fixture.query("queue", json!({"sessionId":"foreign_session"})).await.is_err());
        drop(watch);
        fixture.mutation(2, "stop", json!({"sessionId":session,"runId":run}), Uuid::new_v4()).await.unwrap();
        fixture.drained().await;
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn queue_preparation_does_not_hold_the_global_lifecycle_and_close_waits_for_original_sql() {
    use sqlx::{Connection, Executor};
    tokio::time::timeout(Duration::from_secs(30),async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture=Fixture::new(&format!("http://{}/v1",listener.local_addr().unwrap()),None).await;
        let session=fixture.create("Recovered queue preparation").await;
        let other=fixture.create("Independent Session").await;
        let path=fixture.session_database(&session);
        let database=rusqlite::Connection::open(&path).unwrap();
        database.execute_batch("CREATE TRIGGER hold_opening BEFORE INSERT ON agent_session_history WHEN NEW.kind='run_admitted' BEGIN SELECT RAISE(ABORT,'opening failure'); END;").unwrap();
        let queued=fixture.send(&session).await.unwrap();
        assert_eq!(queued["kind"],"queued");
        fixture.owner.schedule_ready().await.unwrap();
        fixture.drained().await;
        assert_eq!(fixture.owner.durable.queue().read(session.clone()).await.unwrap().entries.len(),1);
        assert!(fixture.owner.durable.latest_run(session.clone()).await.unwrap().is_none());
        database.execute_batch("DROP TRIGGER hold_opening").unwrap();drop(database);
        let current=fixture.owner.session(&session).await.unwrap();
        let directory=workspace::open_workspace(&fixture.owner.workspace_roots,&current.configuration.workspace,&fixture.owner.managed_worktrees).await.unwrap();
        let physical=fixture.store.workspace(directory).await.unwrap();
        let mut writer=sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(&path)).await.unwrap();
        writer.execute("BEGIN IMMEDIATE").await.unwrap();
        fixture.owner.schedule_ready().await.unwrap();
        loop {
            match fixture.store.fence_workspace(&physical).await {
                Err(maka_event_log::StoreError::SessionBusy) => break,
                Ok(fence) => drop(fence),
                Err(error) => panic!("unexpected physical admission failure: {error}"),
            }
            tokio::task::yield_now().await;
        }
        // Queue admission owns the real Session order while its Root SQL job
        // awaits the writer. It has not yet minted a Run or physical driver.
        let mut same_session=Box::pin(fixture.owner.runs.session(&session));
        assert!(futures_util::poll!(same_session.as_mut()).is_pending());
        drop(fixture.owner.runs.session(&other).await);
        drop(same_session);
        let mut close=fixture.owner.close();
        assert!(futures_util::poll!(close.as_mut()).is_pending());
        assert!(fixture.owner.stop.is_cancelled());
        let mut original_job=Box::pin(fixture.owner.workers.wait());
        assert!(futures_util::poll!(original_job.as_mut()).is_pending());
        assert!(matches!(fixture.store.fence_workspace(&physical).await,Err(maka_event_log::StoreError::SessionBusy)),"observer cancellation released original physical work before SQL settled");
        writer.execute("ROLLBACK").await.unwrap();writer.close().await.unwrap();
        original_job.await;
        close.await.unwrap();
        fixture.app.shutdown().await.unwrap();
    }).await.unwrap();
}
