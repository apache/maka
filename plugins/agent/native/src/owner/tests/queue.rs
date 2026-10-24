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

// Keep the provider request held until Stop. Record behavioral failures before
// cleanup so the old admission refusal cannot leave a live worker behind.
async fn unrestricted_queue_regression(count: usize, large: bool) {
    tokio::time::timeout(Duration::from_secs(180), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::new(&format!("http://{}/v1", listener.local_addr().unwrap()), None).await;
        let session = fixture.create("Unrestricted pending queue").await;
        let started = fixture.send(&session).await.unwrap();
        let (mut held, _) = listener.accept().await.unwrap();
        request(&mut held).await;
        let selection = fixture.selection().await;
        let token = fixture.owner.runs.lock().await.controls[&session].cancellation.clone();
        let mut originals = Vec::<(String, String)>::new();
        let observed: Result<(), String> = async {
            for index in 0..count {
                let message = if large {
                    char::from(b'a' + index as u8).to_string().repeat(600 * 1024)
                } else {
                    format!("{}-{index}", "🦀".repeat(80))
                };
                let value = fixture.mutation(2, "send", json!({"sessionId":session,"message":message,"model":selection}), Uuid::new_v4()).await?;
                if value["kind"] != "queued" { return Err(format!("send {} did not queue: {value}", index + 1)); }
                let id = value["messageId"].as_str().ok_or("missing queued message ID")?.to_owned();
                originals.push((id, message));
            }
            let queue = fixture.query("queue", json!({"sessionId":session})).await?;
            let ids: Vec<_> = originals.iter().map(|(id, _)| id.clone()).collect();
            let actual: Vec<_> = queue["entries"].as_array().ok_or("missing entries")?.iter().map(|row| row["messageId"].clone()).collect();
            if actual != ids.iter().map(|id| json!(id)).collect::<Vec<_>>() { return Err("queue omitted or reordered accepted inputs".into()); }
            for (id, message) in [&originals[0], &originals[count - 1]] {
                let read = fixture.query("queueMessage", json!({"sessionId":session,"messageId":id,"expectedRevision":queue["revision"]})).await?;
                if read != json!({"kind":"ready","revision":queue["revision"],"message":message,"hasAttachments":false}) { return Err(format!("original body changed for {id}")); }
            }
            let durable = fixture.session(&session).await.message_queue(&session).await.map_err(|e| e.to_string())?;
            if large && durable.entries.iter().map(|entry| serde_json::to_vec(entry).unwrap().len()).sum::<usize>() <= 8 * 1024 * 1024 { return Err("workload did not cross the former aggregate byte limit".into()); }
            for (entry, (id, message)) in durable.entries.iter().zip(&originals) {
                if entry.source.message.message_id != *id || entry.source.unprepared_content.text != *message || entry.source.message.content.text != *message { return Err("durable original input changed".into()); }
            }
            let through = fixture.query("observe", json!({"sessionId":session})).await?["through"].clone();
            let mut watch = fixture.app.client().subscribe(fixture.binding(2).await, "watch".into(), json!({"sessionId":session,"after":through}), scope(&fixture.issuer, true), Attachments::new().into()).await.map_err(|e| e.to_string())?;
            let first = watch.recv().await.ok_or("watch closed without delivering the queue")?;
            if first != json!({"kind":"queue","queue":queue}) { return Err("watch did not deliver the complete queue".into()); }
            if !large && serde_json::to_vec(&first).unwrap().len() <= 64 * 1024 { return Err("watch workload did not cross the former delivery byte limit".into()); }
            drop(watch);
            let replacement = if large { "z".repeat(600 * 1024) } else { "edited original input".into() };
            let update = json!({"sessionId":session,"expectedRevision":queue["revision"],"edit":{"kind":"update","messageId":ids[0],"message":replacement}});
            let operation = Uuid::new_v4();
            let changed = fixture.mutation(2, "editQueue", update.clone(), operation).await?;
            if changed["kind"] != "committed" || fixture.mutation(2, "editQueue", update.clone(), operation).await? != changed { return Err("update did not commit idempotently".into()); }
            if fixture.mutation(2, "editQueue", update, Uuid::new_v4()).await?["kind"] != "revision_conflict" { return Err("stale edit crossed its revision fence".into()); }
            let read = fixture.query("queueMessage", json!({"sessionId":session,"messageId":ids[0],"expectedRevision":changed["revision"]})).await?;
            if read != json!({"kind":"ready","revision":changed["revision"],"message":replacement,"hasAttachments":false}) { return Err("edited body was truncated or changed".into()); }
            let foreign = fixture.create("Other queue owner").await;
            let foreign_queue = fixture.query("queue", json!({"sessionId":foreign})).await?;
            if fixture.query("queueMessage", json!({"sessionId":foreign,"messageId":ids[0],"expectedRevision":foreign_queue["revision"]})).await? != json!({"kind":"missing"}) { return Err("queue body crossed Session ownership".into()); }
            let reversed: Vec<_> = ids.iter().rev().cloned().collect();
            let reordered = fixture.mutation(2, "editQueue", json!({"sessionId":session,"expectedRevision":changed["revision"],"edit":{"kind":"reorder","messageIds":reversed}}), Uuid::new_v4()).await?;
            if reordered["kind"] != "committed" { return Err(format!("full lane reorder rejected: {reordered}")); }
            let queue = fixture.query("queue", json!({"sessionId":session})).await?;
            let actual: Vec<_> = queue["entries"].as_array().ok_or("missing reordered entries")?.iter().map(|row| row["messageId"].clone()).collect();
            if actual != reversed.iter().map(|id| json!(id)).collect::<Vec<_>>() { return Err("full lane reorder lost identities or order".into()); }
            let retracted = fixture.mutation(2, "editQueue", json!({"sessionId":session,"expectedRevision":reordered["revision"],"edit":{"kind":"retract","messageId":reversed[0]}}), Uuid::new_v4()).await?;
            if retracted["kind"] != "committed" || fixture.query("queueMessage", json!({"sessionId":session,"messageId":reversed[0],"expectedRevision":retracted["revision"]})).await? != json!({"kind":"missing"}) { return Err("retraction did not remove its target".into()); }
            if large {
                // Restore seven large bodies so Stop and its recovered receipt
                // also cross the former aggregate limit after retraction.
                let message = "replacement".repeat(600 * 1024 / "replacement".len());
                let value = fixture.mutation(2, "send", json!({"sessionId":session,"message":message,"model":selection}), Uuid::new_v4()).await?;
                if value["kind"] != "queued" { return Err("replacement did not queue".into()); }
                originals.push((value["messageId"].as_str().ok_or("missing replacement ID")?.to_owned(), message));
            }
            Ok(())
        }.await;
        let before_stop_revision = fixture.session(&session).await.message_queue(&session).await.unwrap().revision;
        let stop_input = json!({"sessionId":session,"invocationId":started["invocationId"]});
        let operation = Uuid::new_v4();
        let stopped = fixture.mutation(2, "stop", stop_input.clone(), operation).await;
        let replayed = fixture.mutation(2, "stop", stop_input.clone(), operation).await;
        let cancelled_by_stop = token.is_cancelled();
        if stopped.is_err() {
            // Baseline cleanup uses individual public retractions, whose receipts
            // contain no queue-sized payload, then a fresh Stop operation.
            for (id, _) in &originals {
                let queue = fixture.query("queue", json!({"sessionId":session})).await.unwrap();
                fixture.mutation(2, "editQueue", json!({"sessionId":session,"expectedRevision":queue["revision"],"edit":{"kind":"retract","messageId":id}}), Uuid::new_v4()).await.unwrap();
            }
            fixture.mutation(2, "stop", stop_input, Uuid::new_v4()).await.unwrap();
        }
        fixture.drained().await;
        let remaining = fixture.session(&session).await.message_queue(&session).await.unwrap();
        let mut cancelled = Vec::new();
        let mut canonical = Vec::new();
        for (id, _) in &originals {
            cancelled.push(fixture.session(&session).await.message_cancelled(&session, id).await.unwrap());
            canonical.push(fixture.session(&session).await.root_message(&session, id).await.unwrap().is_none());
        }
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
        assert!(observed.is_ok(), "{observed:?}");
        let admitted = count + usize::from(large);
        assert_eq!(originals.len(), admitted);
        assert_eq!(stopped, Ok(json!({"requested":true})));
        assert_eq!(replayed, stopped);
        assert!(cancelled_by_stop);
        assert_eq!(remaining.revision, before_stop_revision + 1);
        assert!(remaining.entries.is_empty());
        assert_eq!(cancelled, vec![true; admitted]);
        assert_eq!(canonical, vec![true; admitted]);
    }).await.unwrap();
}

#[tokio::test]
async fn queue_accepts_more_than_sixty_four_and_delivers_a_complete_large_watch() {
    unrestricted_queue_regression(256, false).await;
}

#[tokio::test]
async fn queue_accepts_more_than_eight_mib_and_preserves_full_original_messages() {
    unrestricted_queue_regression(7, true).await;
}

#[tokio::test]
async fn queued_followup_uses_original_worker_and_a_new_invocation() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let fixture = Fixture::new(&base, None).await;
        let session = fixture.create("Queued followup").await;
        let first = fixture.send(&session).await.unwrap();
        assert_eq!(first["kind"], "started");
        let catalog = fixture.owner.mcp_projects.catalog(None).unwrap();
        {
            let runs = fixture.owner.runs.lock().await;
            let basis = &runs.controls[&session].basis;
            assert!(Arc::ptr_eq(&basis.internal_tools, &catalog.definitions));
            assert!(Arc::ptr_eq(&basis.internal_bindings, &catalog.bindings));
            assert!(Arc::ptr_eq(&basis.tools, &fixture.owner.tool_basis));
            // Durable admission still uses the original array/object representation.
            let wire = serde_json::to_value(basis).unwrap();
            let restored: MessageBasis = serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(serde_json::to_value(restored).unwrap(), wire);
            assert!(wire["tools"].is_array());
        }
        let (mut first_socket, _) = listener.accept().await.unwrap();
        request(&mut first_socket).await;
        let next = fixture.mutation(2, "send", json!({"sessionId":session,"message":"original followup","model":fixture.selection().await}), Uuid::new_v4()).await.unwrap();
        assert_eq!(next["kind"], "queued");
        assert_eq!(fixture.query("work",json!({"sessionId":session,"target":{"kind":"message","messageId":next["messageId"]}})).await.unwrap(),json!({"kind":"pending"}));
        assert_eq!(fixture.query("work",json!({"sessionId":session,"target":{"kind":"message","messageId":"absent_message"}})).await.unwrap(),json!({"kind":"missing"}));
        let other = fixture.create("Other message owner").await;
        assert_eq!(fixture.query("work",json!({"sessionId":other,"target":{"kind":"message","messageId":next["messageId"]}})).await.unwrap(),json!({"kind":"missing"}));
        assert!(fixture.query("work",json!({"sessionId":"foreign_session","target":{"kind":"message","messageId":next["messageId"]}})).await.is_err());
        assert_eq!(fixture.owner.runs.lock().await.controls.len(), 1);
        let pending = fixture.session(&session).await.pending_messages(&session).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].invocation.invocation_id, first["invocationId"]);
        response(&mut first_socket).await;
        let (mut second_socket, _) = listener.accept().await.unwrap();
        let second = request(&mut second_socket).await;
        assert_eq!(second["model"], "fixture-model");
        assert!(second["messages"].as_array().unwrap().iter().any(|message| message["content"] == "original followup"));
        let current = fixture.query("observe", json!({"sessionId":session})).await.unwrap();
        assert_ne!(current["run"]["invocationId"], first["invocationId"]);
        assert!(fixture.session(&session).await.pending_messages(&session).await.unwrap().is_empty());
        {
            // A queued admission was decoded from durable JSON. Validation must
            // reattach shared descriptors before the successor remains running.
            let runs = fixture.owner.runs.lock().await;
            let basis = &runs.controls[&session].basis;
            assert!(Arc::ptr_eq(&basis.internal_tools, &catalog.definitions));
            assert!(Arc::ptr_eq(&basis.internal_bindings, &catalog.bindings));
            assert!(Arc::ptr_eq(&basis.tools, &fixture.owner.tool_basis));
        }
        // Put a real send at the gate before the completed successor worker.
        // Its Running handle drops while we hold the gate, cancelling that
        // handle's token; this is not a user stop or a SQL interrupt fence.
        let selection = fixture.selection().await;
        let client = fixture.app.client();
        let prepared = client.prepare_mutation(fixture.binding(2).await, "send".into(), json!({"sessionId":session,"message":"tail followup","model":selection}), scope(&fixture.issuer, true), Uuid::new_v4(), Attachments::new().into()).await.unwrap();
        let reference = prepared.reference().clone();
        drop(prepared);
        let gate = fixture.owner.runs.lock().await;
        let completed = gate.controls[&session].cancellation.clone();
        let parent = scope(&fixture.issuer, true);
        let mut tail = Box::pin(fixture.owner.send(Send { session_id: session.clone(), message: "tail followup".into(), model: selection, thinking_level: None, attachments: vec![] }, &reference, &parent));
        assert!(futures_util::poll!(tail.as_mut()).is_pending());
        response(&mut second_socket).await;
        completed.cancelled().await;
        drop(gate);
        assert!(matches!(tail.await.unwrap(), SendResult::Queued { .. }));
        let (mut third_socket, _) = listener.accept().await.unwrap();
        let third = request(&mut third_socket).await;
        assert!(third["messages"].as_array().unwrap().iter().any(|message| message["content"] == "tail followup"));
        response(&mut third_socket).await;
        fixture.drained().await;
        assert!(fixture.owner.runs.lock().await.controls.is_empty());
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn stopping_original_run_retracts_queue_and_fences_tail_admission() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let fixture = Fixture::new(&base, None).await;
        let session = fixture.create("Stop queue").await;
        let first = fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        let queued = fixture.send(&session).await.unwrap();
        assert_eq!(queued["kind"], "queued");
        let selection = fixture.selection().await;
        let client = fixture.app.client();
        let stop = client
            .prepare_mutation(
                fixture.binding(2).await,
                "stop".into(),
                json!({"sessionId":session,"invocationId":first["invocationId"]}),
                scope(&fixture.issuer, true),
                Uuid::new_v4(),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        let tail = client
            .prepare_mutation(
                fixture.binding(2).await,
                "send".into(),
                json!({"sessionId":session,"message":"after stop","model":selection}),
                scope(&fixture.issuer, true),
                Uuid::new_v4(),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        let stop_reference = stop.reference().clone();
        let tail_reference = tail.reference().clone();
        drop((stop, tail));
        assert!(
            fixture
                .owner
                .stop_run(
                    &session,
                    first["invocationId"].as_str().unwrap(),
                    &stop_reference
                )
                .await
                .unwrap()
        );
        // This current-thread executor has not polled the cancelled worker
        // since stop returned. Retain its gate and queue the tail send before
        // yielding, so only the durable interrupt fence can reject admission.
        let gate = fixture.owner.runs.lock().await;
        assert_eq!(
            gate.controls[&session].invocation.invocation_id,
            first["invocationId"]
        );
        let parent = scope(&fixture.issuer, true);
        let mut tail = Box::pin(fixture.owner.send(
            Send {
                session_id: session.clone(),
                message: "after stop".into(),
                model: selection,
                thinking_level: None,
                attachments: vec![],
            },
            &tail_reference,
            &parent,
        ));
        assert!(futures_util::poll!(tail.as_mut()).is_pending());
        drop(gate);
        assert_eq!(tail.await.err().unwrap(), "agent_admission_failed");
        fixture.drained().await;
        assert!(
            fixture.session(&session).await.pending_messages(&session)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            fixture.session(&session).await.message_cancelled(&session, queued["messageId"].as_str().unwrap())
                .await
                .unwrap()
        );
        assert_eq!(
            fixture
                .query(
                    "work",
                    json!({"sessionId":session,"target":{"kind":"message","messageId":queued["messageId"]}})
                )
                .await
                .unwrap(),
            json!({"kind":"cancelled"})
        );
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn activation_recovers_all_pending_sessions_without_new_sends() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let fixture = Fixture::new(&base, None).await;
        use maka_agent_facts::execution::ThinkingLevel::Off;
use maka_agent_facts::execution::ThinkingLevel::Low;
use maka_agent_facts::execution::ThinkingLevel::High;
        selection::thinking(&fixture, vec![Off, Low, High], High).await;
        let deployment = fixture.app.client().snapshot().effective.unwrap().deployment;
        let mut sessions = Vec::new();
        let raw: Vec<_> = std::fs::read_dir(fixture.root.join("runtime-partitions")).unwrap()
            .map(|entry| entry.unwrap().path()).filter(|path| path.extension().is_some_and(|extension| extension == "sqlite"))
            .map(|path| rusqlite::Connection::open(path).unwrap()).collect();
        for database in &raw { database.execute_batch("CREATE TRIGGER hold_opening BEFORE INSERT ON event_log WHEN NEW.kind='invocation_opened' BEGIN SELECT RAISE(ABORT, 'fixture opening failure'); END;").unwrap(); }
        for (index, level) in [Some(Off), Some(Low), None].into_iter().enumerate() {
            let session = fixture.create(&format!("Recovery {index}")).await;
            assert!(fixture.mutation(2, "send", json!({"sessionId":session,"message":"restored thinking","model":fixture.selection().await,"thinkingLevel":level}), Uuid::new_v4()).await.is_err());
            assert_eq!(fixture.session(&session).await.pending_messages(&session).await.unwrap().len(), 1);
            sessions.push(session);
        }
        fixture.app.shutdown().await.unwrap();
        for database in &raw { database.execute_batch("DROP TRIGGER hold_opening").unwrap(); }
        drop(raw);
        let mut native = NativeRegistry::default();
        crate::owner::tests::provide_all(&mut native).unwrap();
        maka_settings_native::provide(&mut native, crate::owner::tests::bundled_catalog()).unwrap();
        let app = Application::start_from_store(fixture.store.clone(), deployment, native, fixture.issuer.clone(), Arc::new(Grant(fixture.issuer.clone(), None)), Some(maka_host_js::factory(maka_js_runtime::plugin::Limits::default()))).await.unwrap();
        app.ready().await.unwrap();
        let mut efforts = Vec::new();
        for _ in 0..3 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let body = request(&mut socket).await;
            assert_eq!(body["model"], "fixture-model");
            efforts.push(body["reasoning_effort"].as_str().unwrap().to_owned());
            response(&mut socket).await;
        }
        efforts.sort();
        assert_eq!(efforts, ["high", "low", "none"]);
        for session in sessions {
            while !fixture.session(&session).await.pending_messages(&session).await.unwrap().is_empty() { tokio::task::yield_now().await; }
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
        let started = fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        let selection = fixture.selection().await;
        let mut ids = Vec::new();
        for _ in 0..3 {
            let result = fixture.mutation(2, "send", json!({"sessionId":session,"message":"🦀\"\n".repeat(80),"model":selection}), Uuid::new_v4()).await.unwrap();
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
            if update["kind"] == "queue" { break update; }
            if update["kind"] == "interactions" { continue; }
            assert_eq!(update["through"], through);
            assert_eq!(update["events"], json!([]));
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
        assert!(fixture.session(&session).await.message_cancelled(&session, &ids[0]).await.unwrap());
        assert_eq!(fixture.query("queueMessage", json!({"sessionId":session,"messageId":ids[0],"expectedRevision":retracted["revision"]})).await.unwrap()["kind"], "missing");
        assert!(fixture.query("queue", json!({"sessionId":"foreign_session"})).await.is_err());
        drop(watch);
        fixture.mutation(2, "stop", json!({"sessionId":session,"invocationId":started["invocationId"]}), Uuid::new_v4()).await.unwrap();
        fixture.drained().await;
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}
