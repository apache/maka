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
use maka_agent_facts::{
    event::{Fact, InvocationInput, LogScope},
    input::MessageInput,
};

#[tokio::test]
async fn public_send_preserves_six_hundred_kib_through_durable_admission_and_main() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut f = Fixture::new(&format!("http://{}/v1", listener.local_addr().unwrap()), None).await;
        // This is the declared capacity of our controlled HTTP model, not an
        // external provider claim or a bypass of normal context admission.
        selection::edit(&f, |changes| {
            changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride {
                context_window: Some(1_000_000), input_limit: Some(900_000), ..Default::default()
            })]));
        }).await;
        let session = f.create("Exact large public message").await;
        let other = f.create("Foreign large-message reader").await;
        let mut bytes: Vec<u8> = (0..600 * 1024).map(|index| b'a' + (index % 26) as u8).collect();
        for (at, marker) in [(0, &b"K69_HEAD"[..]), (300 * 1024, &b"K69_MIDDLE"[..]), (600 * 1024 - 8, &b"K69_TAIL"[..])] {
            bytes[at..at + marker.len()].copy_from_slice(marker);
        }
        let message = String::from_utf8(bytes).unwrap();
        let submitted = MessageInput::from(message.clone());
        let expected_digest = submitted.content_digest().unwrap();
        let input = json!({"sessionId":session,"message":message,"model":f.selection().await});
        let encoded_bytes = serde_json::to_vec(&input).unwrap().len();
        let client = f.app.client();
        let operation = Uuid::new_v4();
        let prepared = client.prepare_mutation(
            f.binding(2).await, "send".into(), input, scope(&f.issuer, true), operation,
            Attachments::new().into(),
        ).await;
        let mut stage = "prepare_mutation";
        let mut failure = None;
        let mut reference = None;
        let mut receipt = None;
        let mut mutation_cleanup = None;
        let mut started = None;
        match prepared {
            Err(error) => failure = Some(error),
            Ok(prepared) => {
                reference = Some(prepared.reference().clone());
                stage = "mutate_owned";
                match client.mutate_owned(prepared).await {
                    Err(error) => failure = Some(error),
                    Ok(running) => {
                        stage = "recorded_receipt";
                        let completion = running.completion().await;
                        mutation_cleanup = Some(completion.cleanup);
                        match &completion.reply.receipt {
                            Receipt::Recorded { outcome: OperationOutcome::Returned { value }, .. }
                                if value["kind"] == "started" => started = Some(value.clone()),
                            Receipt::Recorded { outcome: OperationOutcome::Unknown { diagnostic }, .. }
                                | Receipt::Unavailable { diagnostic } => failure = Some(diagnostic.clone()),
                            other => failure = Some(format!("unexpected send receipt: {other:?}")),
                        }
                        receipt = Some(completion.reply);
                    }
                }
            }
        }
        // Recover the exact public mutation's durable observation even on the
        // rejecting path; do not mistake a generic failed call for this defect.
        let recovered = if let Some(reference) = reference {
            Some(client.recover(client.activation(&id(2)).unwrap(), reference, scope(&f.issuer, true)).await)
        } else { None };
        let mut main_matches = false;
        let mut history_text = String::new();
        let mut history_offsets_match = true;
        let mut root_proof = None;
        let mut work = Vec::new();
        let mut first = None;
        let mut latest = None;
        let mut editable = None;
        let mut foreign_source = None;
        let mut source_text = String::new();
        if let Some(started) = &started {
            let (mut socket, _) = listener.accept().await.unwrap();
            let sent = request(&mut socket).await;
            main_matches = sent["messages"].as_array().unwrap().iter().any(|entry|
                entry["role"] == "user" && entry["content"].as_str().is_some_and(|text| text.as_bytes() == message.as_bytes()));
            response(&mut socket).await;
            f.drained().await;
            root_proof = Some(f.session(&session).await.root_message(&session, started["messageId"].as_str().unwrap()).await);
            first = Some(f.session(&session).await.first_message_opening(&session).await);
            latest = Some(f.session(&session).await.latest_message_opening(&session).await);
            if let Some(Ok(Some(proof))) = &root_proof {
                editable = Some(f.session(&session).await.editable_message(&session, &proof.opening().event.invocation.turn_id, started["messageId"].as_str().unwrap()).await);
                foreign_source = Some(f.session(&other).await.editable_message(&other, &proof.opening().event.invocation.turn_id, started["messageId"].as_str().unwrap()).await);
            }
            for target in [json!({"kind":"message","messageId":started["messageId"]}), json!({"kind":"invocation","invocationId":started["invocationId"]})] {
                work.push(f.query("work", json!({"sessionId":session,"target":target})).await);
                work.push(f.query("work", json!({"sessionId":other,"target":target})).await);
            }
            let mut source_position = None;
            let mut history = json!({"sessionId":session,"position":{"kind":"start"}});
            loop {
                let page = f.query("history", history.clone()).await.unwrap();
                assert_eq!(page["kind"], "ready");
                history["through"] = page["through"].clone();
                for chunk in page["chunks"].as_array().unwrap().iter().filter(|chunk| chunk["role"] == "user") {
                    if source_position.is_none() { source_position = Some(chunk["position"].clone()); }
                    history_offsets_match &= chunk["offset"] == history_text.len() && chunk["totalBytes"] == message.len();
                    history_text.push_str(chunk["text"].as_str().unwrap());
                }
                if page["after"].is_null() { break; }
                history["position"] = json!({"kind":"after","cursor":page["after"]});
            }
            if let Some(position) = source_position {
                loop {
                    let page = f.query("source", json!({"sessionId":session,"through":history["through"],
                        "source":{"kind":"row","position":position},"field":"body",
                        "position":{"kind":"after","offset":source_text.len()}})).await.unwrap();
                    let fragment = &page["source"];
                    source_text.push_str(fragment["text"].as_str().unwrap());
                    if source_text.len() as u64 == fragment["totalBytes"].as_u64().unwrap() { break; }
                }
            }
        }
        let pending = f.session(&session).await.pending_messages(&session).await;
        let canonical = f.session(&(session)).await.scoped_prefix(LogScope::Session { id: session.clone() }, 128, 8 * 1024 * 1024).await;
        let app_cleanup = f.app.shutdown().await;
        let mut reopened_text = String::new();
        let mut reopened_source = None;
        let mut reopened_facts = None;
        if let Some(started) = &started {
            // shutdown acknowledges actual SQLite closure even while the
            // retired fixture owner still holds its old Arc. Reopen under the
            // exact original RootOwner; no database copying or replacement.
            let deployment = f.app.source().unwrap().deployment;
            let root_owner = f.store.owned_root().unwrap();
            f.store.shutdown().await.unwrap();
            f.store = Arc::new(RootStore::open(root_owner).await.unwrap());
            let mut native = NativeRegistry::default();
            maka_settings_native::provide(&mut native, crate::owner::tests::bundled_catalog()).unwrap();
            provide_all(&mut native).unwrap();
            f.app = Application::start_from_store(
                f.store.clone(), deployment, native, f.issuer.clone(),
                Arc::new(Grant(f.issuer.clone(), None)),
                Some(maka_host_js::factory(Default::default())),
            ).await.unwrap();
            f.app.ready().await.unwrap();
            let mut history = json!({"sessionId":session,"position":{"kind":"start"}});
            loop {
                let page = f.query("history", history.clone()).await.unwrap();
                assert_eq!(page["kind"], "ready");
                history["through"] = page["through"].clone();
                for chunk in page["chunks"].as_array().unwrap().iter().filter(|chunk| chunk["role"] == "user") {
                    reopened_text.push_str(chunk["text"].as_str().unwrap());
                }
                if page["after"].is_null() { break; }
                history["position"] = json!({"kind":"after","cursor":page["after"]});
            }
            reopened_source = Some(f.session(&session).await.root_message(&session, started["messageId"].as_str().unwrap()).await);
            reopened_facts = Some(f.session(&(session)).await.scoped_prefix(LogScope::Session { id: session.clone() }, 128, 8 * 1024 * 1024).await);
            f.app.shutdown().await.unwrap();
            f.store.shutdown().await.unwrap();
        }
        let config_cleanup = f.config.shutdown().await;

        app_cleanup.unwrap();
        config_cleanup.unwrap();
        let canonical = canonical.unwrap();
        let openings: Vec<_> = canonical.events.iter().filter(|entry| matches!(entry.event.fact, Fact::InvocationOpened { .. })).collect();
        let pending = pending.unwrap();
        assert_eq!(message.len(), 614_400);
        assert!(encoded_bytes < 1024 * 1024, "serialized public request must fit its unchanged Host envelope: {encoded_bytes}");
        if let Some(cleanup) = &mutation_cleanup {
            assert!(cleanup.is_ok(), "original mutation cleanup failed: {cleanup:?}");
        }
        if let (Some(original), Some(Ok(Some(observed)))) = (&receipt, &recovered)
            && let Receipt::Recorded { outcome, cleanup } = &original.receipt {
            assert_eq!(&observed.outcome, outcome);
            assert_eq!(&observed.cleanup, cleanup);
        }
        if started.is_none() {
            assert!(pending.is_empty(), "rejected send left {} pending admissions", pending.len());
            assert!(openings.is_empty(), "rejected send left {} canonical openings", openings.len());
            assert_eq!(failure.as_deref(), Some("agent_admission_failed"), "unexpected rejecting stage={stage}, receipt={receipt:?}, recovered={recovered:?}");
        }
        assert!(started.is_some(), "600KiB public send was rejected: stage={stage}, error={failure:?}, inputBytes={encoded_bytes}, receipt={receipt:?}, recovered={recovered:?}, openings={}, pending={}", openings.len(), pending.len());
        mutation_cleanup.unwrap().unwrap();
        let original_receipt = receipt.unwrap();
        let observation = recovered.unwrap().unwrap().unwrap();
        let Receipt::Recorded { outcome, cleanup } = original_receipt.receipt else { panic!("recorded send receipt") };
        assert_eq!(observation.outcome, outcome);
        assert_eq!(observation.cleanup, cleanup);
        assert!(pending.is_empty());
        assert_eq!(openings.len(), 1);
        assert!(main_matches, "Main must receive every original byte, not a size surrogate or summary");
        let Fact::InvocationOpened { input: InvocationInput::Message { content, source_messages, .. }, .. } = &openings[0].event.fact else { panic!("canonical message opening") };
        assert!(content.text.as_bytes() == message.as_bytes(), "canonical aggregate changed original input");
        assert_eq!(source_messages.len(), 1);
        let source = &source_messages[0];
        assert!(source.message.content.text.as_bytes() == message.as_bytes(), "prepared source changed original input");
        assert!(source.unprepared_content.text.as_bytes() == message.as_bytes(), "unprepared source changed original input");
        assert_eq!(source.message.submitted_content_digest, expected_digest);
        let proof = root_proof.unwrap().unwrap().unwrap();
        assert_eq!(proof.opening().event.id, openings[0].event.id);
        assert!(proof.source().unprepared_content.text.as_bytes() == message.as_bytes(), "exact root-message proof lost bytes");
        assert!(history_offsets_match, "history fragments changed original byte offsets/total");
        assert!(history_text.as_bytes() == message.as_bytes(), "public history changed original bytes");
        assert!(source_text.as_bytes() == message.as_bytes(), "public source fragments changed original bytes");
        assert!(reopened_text.as_bytes() == message.as_bytes(), "same-Root reopen changed public history bytes");
        assert_eq!(first.unwrap().unwrap().unwrap().event.id, openings[0].event.id);
        assert_eq!(latest.unwrap().unwrap().unwrap().event.id, openings[0].event.id);
        assert!(editable.unwrap().unwrap().unwrap().content.text.as_bytes() == message.as_bytes());
        assert!(foreign_source.unwrap().unwrap().is_none());
        for (index, observed) in work.into_iter().enumerate() {
            let observed = observed.unwrap();
            if index % 2 == 1 { assert_eq!(observed, json!({"kind":"missing"})); continue; }
            assert_eq!(observed["kind"], "delivered");
            assert_eq!(observed["execution"]["invocationId"], started.as_ref().unwrap()["invocationId"]);
            assert_eq!(observed["execution"]["state"], "completed");
            assert_eq!(observed["answer"]["text"], "Elegant response");
        }
        let reopened = reopened_source.unwrap().unwrap().unwrap();
        assert_eq!(reopened.opening().event.id, proof.opening().event.id);
        assert!(reopened.source().message.content.text.as_bytes() == message.as_bytes());
        let reopened = reopened_facts.unwrap().unwrap();
        assert_eq!(canonical.high_water, reopened.high_water);
        assert_eq!(canonical.digest, reopened.digest, "reopening SQLite changed the raw canonical prefix digest");
        let raw_before: Vec<_> = canonical.events.iter().map(|entry| (entry.sequence, serde_json::to_vec(&entry.event).unwrap())).collect();
        let raw_after: Vec<_> = reopened.events.iter().map(|entry| (entry.sequence, serde_json::to_vec(&entry.event).unwrap())).collect();
        assert!(raw_before == raw_after, "reopen changed canonical event identities/bytes");
    }).await.unwrap();
}

#[tokio::test]
async fn public_large_queue_edit_and_promotion_preserve_original_identity_and_exact_steering_bytes()
{
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()), None, None,
            Some(service_tools::Setup::files("readText").named("Read")),
        ).await;
        selection::edit(&f, |changes| {
            changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride {
                context_window: Some(1_000_000), input_limit: Some(900_000), ..Default::default()
            })]));
        }).await;
        std::fs::write(f.workspace.join("steering-gate.txt"), "Original native read gate").unwrap();
        let session = f.create("Large editable steering source").await;
        let other = f.create("Separate queue authority").await;
        let started = f.send(&session).await.unwrap();
        let (mut held, _) = listener.accept().await.unwrap();
        request(&mut held).await;
        let original = "q".repeat(600 * 1024);
        // JSON escaping expands NUL/quotes/slashes/newlines independently of
        // UTF-8 bytes. This still fits the actual public request envelope.
        let edited = "中文😀\"\0\\\n".repeat(36_000);
        let submitted_digest = MessageInput::from(original.clone()).content_digest().unwrap();
        let selection = f.selection().await;
        let send_input = json!({"sessionId":session,"message":original,"model":selection});
        let send_bytes = serde_json::to_vec(&send_input).unwrap().len();
        let send_operation = Uuid::new_v4();
        let queued = f.mutation(2, "send", send_input.clone(), send_operation).await.unwrap();
        let queued_retry = f.mutation(2, "send", send_input, send_operation).await.unwrap();
        let read_before = f.query("queueMessage", json!({"sessionId":session,"messageId":queued["messageId"],"expectedRevision":queued["revision"]})).await.unwrap();
        let pending_before = f.session(&session).await.pending_messages(&session).await.unwrap();
        let other_queue = f.query("queue", json!({"sessionId":other})).await.unwrap();
        let foreign_read = f.query("queueMessage", json!({"sessionId":other,"messageId":queued["messageId"],"expectedRevision":other_queue["revision"]})).await.unwrap();
        let foreign_update = f.mutation(2, "editQueue", json!({"sessionId":other,"expectedRevision":other_queue["revision"],"edit":{"kind":"update","messageId":queued["messageId"],"message":"foreign replacement"}}), Uuid::new_v4()).await.unwrap();
        let update_input = json!({"sessionId":session,"expectedRevision":queued["revision"],"edit":{"kind":"update","messageId":queued["messageId"],"message":edited}});
        let update_bytes = serde_json::to_vec(&update_input).unwrap().len();
        let update_operation = Uuid::new_v4();
        let changed = f.mutation(2, "editQueue", update_input.clone(), update_operation).await.unwrap();
        let changed_retry = f.mutation(2, "editQueue", update_input.clone(), update_operation).await.unwrap();
        let stale = f.mutation(2, "editQueue", update_input, Uuid::new_v4()).await.unwrap();
        let read_after = f.query("queueMessage", json!({"sessionId":session,"messageId":queued["messageId"],"expectedRevision":changed["revision"]})).await.unwrap();
        let pending_after = f.session(&session).await.pending_messages(&session).await.unwrap();
        let promotion_input = json!({"sessionId":session,"expectedRevision":changed["revision"],"edit":{"kind":"promote","messageId":queued["messageId"]}});
        let promotion_operation = Uuid::new_v4();
        let promoted = f.mutation(2, "editQueue", promotion_input.clone(), promotion_operation).await.unwrap();
        let promoted_retry = f.mutation(2, "editQueue", promotion_input, promotion_operation).await.unwrap();
        let promoted_queue = f.query("queue", json!({"sessionId":session})).await.unwrap();
        // A real admitted native read finishes the original model step. This
        // existing settled-tool boundary consumes steering without a successor.
        service_tools::named_tool_response(&mut held, "Read", json!({"path":"steering-gate.txt"})).await;
        let (mut next, _) = listener.accept().await.unwrap();
        let main = request(&mut next).await;
        let expected_main = format!("The user sent a message while you were working:\n<user_query>\n{edited}\n</user_query>");
        let main_matches = main["messages"].as_array().unwrap().iter().any(|entry|
            entry["role"] == "user" && entry["content"].as_str().is_some_and(|text| text.as_bytes() == expected_main.as_bytes()));
        let current = f.query("observe", json!({"sessionId":session})).await.unwrap();
        response(&mut next).await;
        f.drained().await;
        let pending = f.session(&session).await.pending_messages(&session).await.unwrap();
        let work = f.query("work", json!({"sessionId":session,"target":{"kind":"message","messageId":queued["messageId"]}})).await;
        let source = f.session(&session).await.root_message(&session, queued["messageId"].as_str().unwrap()).await;
        let canonical = f.session(&(session)).await.scoped_prefix(LogScope::Session { id: session.clone() }, 128, 8 * 1024 * 1024).await.unwrap();
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();

        assert!(send_bytes < 1024 * 1024 && update_bytes < 1024 * 1024,
            "public send/edit envelopes must fit: send={send_bytes}, update={update_bytes}");
        assert_eq!(queued["kind"], "queued");
        assert_eq!(queued_retry, queued);
        assert_eq!(read_before["kind"], "ready");
        assert!(read_before["message"].as_str().unwrap().as_bytes() == original.as_bytes());
        assert_eq!(read_before["hasAttachments"], false);
        assert_eq!(pending_before.len(), 1);
        assert!(serde_json::to_vec(&pending_before[0]).unwrap().len() > 1024 * 1024);
        assert_eq!(foreign_read, json!({"kind":"missing"}));
        assert_eq!(foreign_update, json!({"kind":"rejected","reason":"missing"}));
        assert_eq!(changed["kind"], "committed");
        assert_eq!(changed_retry, changed);
        assert_eq!(stale, json!({"kind":"revision_conflict","expected":queued["revision"],"actual":changed["revision"]}));
        assert_eq!(read_after["kind"], "ready");
        assert!(read_after["message"].as_str().unwrap().as_bytes() == edited.as_bytes());
        assert_eq!(pending_after.len(), 1);
        assert!(pending_after[0].source.unprepared_content.text.as_bytes() == edited.as_bytes());
        assert_eq!(pending_after[0].source.message.submitted_content_digest, submitted_digest);
        assert_eq!(promoted["kind"], "committed");
        assert_eq!(promoted_retry, promoted);
        assert_eq!(promoted_queue["entries"].as_array().unwrap().len(), 1);
        assert_eq!(promoted_queue["entries"][0]["kind"], "steering");
        assert!(main_matches, "Main changed the edited Unicode/escaped/NUL steering text");
        assert_eq!(current["run"]["invocationId"], started["invocationId"]);
        assert!(pending.is_empty());
        let work = work.unwrap();
        assert_eq!(work["kind"], "delivered");
        assert_eq!(work["shared"], true);
        assert_eq!(work["execution"]["invocationId"], started["invocationId"]);
        assert_eq!(work["answer"]["text"], "Elegant response");
        assert_eq!(canonical.events.iter().filter(|entry| matches!(entry.event.fact, Fact::InvocationOpened { .. })).count(), 1);
        let steering: Vec<_> = canonical.events.iter().filter(|entry| matches!(entry.event.fact, Fact::MessageSteered { .. })).collect();
        assert_eq!(steering.len(), 1);
        assert_eq!(steering[0].event.invocation.invocation_id, started["invocationId"]);
        assert!(serde_json::to_vec(&steering[0].event).unwrap().len() > 1024 * 1024);
        let Fact::MessageSteered { message, source: steered } = &steering[0].event.fact else { panic!("steering retains original source") };
        assert_eq!(message.message_id, queued["messageId"]);
        assert!(message.content.text.as_bytes() == edited.as_bytes());
        assert!(steered.message.content.text.as_bytes() == edited.as_bytes());
        assert!(steered.unprepared_content.text.as_bytes() == edited.as_bytes());
        assert_eq!(message.submitted_content_digest, submitted_digest);
        assert_eq!(steered.message.submitted_content_digest, submitted_digest);
        let source = source.unwrap().unwrap();
        assert_eq!(source.opening().event.id, steering[0].event.id);
        assert!(source.source().unprepared_content.text.as_bytes() == edited.as_bytes());
    }).await.unwrap();
}
