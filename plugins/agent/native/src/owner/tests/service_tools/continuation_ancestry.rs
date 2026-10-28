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
    continuation::RunBoundary,
    event::{InvocationInput, InvocationOutcome, ModelInterruption, StoredEvent},
};

async fn events_since(fixture: &Fixture, session: &str, mut after: u64) -> Vec<StoredEvent> {
    let through = fixture.through(session).await;
    let mut events = Vec::new();
    while after < through {
        let page = fixture
            .session(session)
            .await
            .session_events(session, after, through, 512, 1024 * 1024)
            .await
            .unwrap();
        events.extend(page.events);
        match page.next_after {
            Some(next) => after = next,
            None => break,
        }
    }
    events
}

fn settled_result(prompt: &Value) -> Value {
    assert!(serde_json::to_vec(prompt).unwrap().len() < 128 * 1024);
    let tools: Vec<_> = prompt["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "tool")
        .collect();
    assert_eq!(tools.len(), 1);
    let result: Value = serde_json::from_str(tools[0]["content"].as_str().unwrap()).unwrap();
    assert_eq!(result["effects"], 1);
    result
}

async fn unchanged_sources(fixture: &Fixture, session: &str, sources: &[RunBoundary]) {
    for source in sources {
        let unchanged = fixture
            .session(session)
            .await
            .run_source(session, &source.invocation.run_id, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            unchanged.boundary, *source,
            "sealed source bytes and positions changed"
        );
    }
}

#[tokio::test]
async fn resume_repeated_cancellations_preserves_settled_effects() {
    tokio::time::timeout(Duration::from_secs(180), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let counter = Counter::new(Behavior::Returned);
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()), None, None,
            Some(Setup::native(counter.clone(), true)),
        ).await;
        selection::edit(&fixture, |changes| {
            changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride {
                code_mode: Some(true), apply_patch: Some(true), ..Default::default()
            })]));
        }).await;
        let session = fixture.create("Resume repeatedly cancelled settled work").await;
        let model = fixture.selection().await;
        let sent = fixture.send(&session).await.unwrap();
        let mut source_id = sent["invocationId"].as_str().unwrap().to_owned();
        let (mut first, _) = listener.accept().await.unwrap();
        request(&mut first).await;
        tool_response(&mut first).await;
        drop(first);
        let (mut pending, _) = listener.accept().await.unwrap();
        let prompt = request(&mut pending).await;
        let original_result = settled_result(&prompt);
        let original_user_content = prompt["messages"].as_array().unwrap().iter()
            .find(|message| message["role"] == "user").unwrap()["content"].clone();
        let mut pending_prompt_bytes = serde_json::to_vec(&prompt).unwrap().len();
        assert_eq!(counter.effects.load(Ordering::SeqCst), 1);
        fixture.mutation(2, "stop", json!({"sessionId":session,"invocationId":source_id}),
            Uuid::new_v4()).await.unwrap();
        drop(pending);
        fixture.drained().await;
        let initial = events_since(&fixture, &session, 0).await;
        assert_eq!(initial.iter().filter(|stored| matches!(stored.event.fact,
            Fact::ToolDispatched { .. })).count(), 1);
        assert_eq!(initial.iter().filter(|stored| matches!(stored.event.fact,
            Fact::ToolSettled { outcome: ToolOutcome::Succeeded { .. }, .. })).count(), 1);
        let (root, _) = fixture.session(&session).await.invocation_boundary(&session, &source_id).await.unwrap().unwrap();
        let frozen_configuration = fixture.session(&(root.invocation).session_id).await.invocation_configuration(&root.invocation)
            .await.unwrap().unwrap();
        let mut sources = Vec::new();
        for ordinal in 1..=66 {
            let execution = fixture.query("execution", json!({
                "sessionId":session,"invocationId":source_id
            })).await.unwrap();
            assert_eq!(execution["execution"]["state"], "cancelled");
            let (physical, high_water) = fixture.session(&session).await.invocation_boundary(&session, &source_id)
                .await.unwrap().unwrap();
            let source = fixture.session(&session).await.run_source(&session, &physical.invocation.run_id, None)
                .await.unwrap().unwrap();
            assert_eq!(source.boundary.invocation, physical.invocation);
            assert_eq!(source.boundary.invocation.invocation_id, source_id);
            assert_eq!(source.boundary.high_water, high_water);
            assert_eq!(execution["execution"]["highWater"], high_water);
            assert!(matches!(source.last.event.fact,
                Fact::InvocationEnded { outcome: InvocationOutcome::Cancelled { .. } }));
            assert_eq!(fixture.session(&(source.boundary.invocation).session_id).await.invocation_configuration(&source.boundary.invocation)
                .await.unwrap().unwrap(), frozen_configuration);
            sources.push(source.boundary.clone());
            // A stricter public read proves replay fits well below production's
            // allowance, without reproducing private byte-accounting logic.
            let context = fixture.session(&(source.boundary).invocation.session_id).await.capture_lineage_context(&source.boundary, 1_000, 1024 * 1024)
                .await.unwrap();
            assert!(context.baseline.is_none());
            let context_events = context.tail.len();
            assert!(context_events < 1_000);
            assert!(pending_prompt_bytes < 128 * 1024);
            let resumed = fixture.mutation(2, "resume", json!({
                "sessionId":session,"sourceInvocationId":source_id,
                "sourceHighWater":high_water,"model":model
            }), Uuid::new_v4()).await;
            let started = resumed.as_ref().is_ok_and(|reply| reply["kind"] == "started");
            let mut witness = json!({"ordinal":ordinal,
                "resume":match &resumed { Ok(reply) => reply.clone(), Err(error) => json!({"error":error}) },
                "context_events":context_events,"context_read_event_allowance":1000,
                "context_read_byte_allowance":1024*1024,"source_pending_prompt_bytes":pending_prompt_bytes,
                "effects":counter.effects.load(Ordering::SeqCst)});
            if !started {
                unchanged_sources(&fixture, &session, &sources).await;
                assert!(fixture.session(&(source.boundary).invocation.session_id).await.continuation_for_source(&source.boundary).await.unwrap().is_none());
                let after = events_since(&fixture, &session, source.last.sequence).await;
                assert!(!after.iter().any(|stored| matches!(stored.event.fact,
                    Fact::InvocationOpened { .. } | Fact::ModelRequested { .. } | Fact::ToolDispatched { .. }
                )), "failed resume published successor work");
                assert_eq!(counter.effects.load(Ordering::SeqCst), 1);
                witness["owner_shutdown"] = json!(format!("{:?}", fixture.app.shutdown().await));
                witness["config_shutdown"] = json!(format!("{:?}", fixture.config.shutdown().await));
                eprintln!("{witness}");
                assert!(started, "resume {ordinal} must start: {resumed:?}");
                return;
            }
            let resumed = resumed.unwrap();
            let next_id = resumed["execution"]["invocationId"].as_str().unwrap().to_owned();
            let next_run = resumed["execution"]["runId"].as_str().unwrap();
            assert_ne!(next_id, source_id);
            assert_ne!(next_run, source.boundary.invocation.run_id);
            assert_ne!(resumed["execution"]["turnId"], source.boundary.invocation.turn_id);
            let (mut pending, _) = listener.accept().await.unwrap();
            let prompt = request(&mut pending).await;
            assert_eq!(settled_result(&prompt), original_result);
            assert!(prompt["messages"].as_array().unwrap().iter().any(|message|
                message["role"] == "user" && message["content"] == original_user_content
            ), "resume lost the original user input");
            pending_prompt_bytes = serde_json::to_vec(&prompt).unwrap().len();
            witness["replay_prompt_bytes"] = json!(pending_prompt_bytes);
            if ordinal == 66 {
                response(&mut pending).await;
            } else {
                // No provider response bytes or new tool calls precede cancellation.
                fixture.mutation(2, "stop", json!({"sessionId":session,"invocationId":next_id}),
                    Uuid::new_v4()).await.unwrap();
            }
            drop(pending);
            fixture.drained().await;
            let execution = fixture.query("execution", json!({
                "sessionId":session,"invocationId":next_id
            })).await.unwrap();
            assert_eq!(execution["execution"]["state"],
                if ordinal == 66 { "completed" } else { "cancelled" });
            let next = fixture.session(&session).await.run_source(&session, next_run, None).await.unwrap().unwrap();
            assert_eq!(next.boundary.invocation.invocation_id, next_id);
            assert_eq!(execution["execution"]["highWater"], next.boundary.high_water);
            assert_eq!(fixture.session(&(next.boundary.invocation).session_id).await.invocation_configuration(&next.boundary.invocation)
                .await.unwrap().unwrap(), frozen_configuration);
            let Fact::InvocationOpened { input: InvocationInput::Continuation { claim, .. }, .. }
                = &next.opening.event.fact else { panic!("resume did not acquire a Continuation"); };
            assert_eq!(claim.source, source.boundary);
            let claimed = fixture.session(&(source.boundary).invocation.session_id).await.continuation_for_source(&source.boundary).await.unwrap().unwrap();
            assert_eq!(claimed.event, next.opening.event);
            let after = events_since(&fixture, &session, source.last.sequence).await;
            assert!(after.iter().all(|stored| stored.event.invocation == next.boundary.invocation));
            assert_eq!(after.len() as u64, next.boundary.high_water);
            assert!(!after.iter().any(|stored| matches!(stored.event.fact,
                Fact::ToolDispatched { .. } | Fact::ToolSettled { .. })));
            if ordinal != 66 {
                assert!(!after.iter().any(|stored| matches!(stored.event.fact,
                    Fact::ModelObserved { .. } | Fact::ModelCompleted { .. })));
                assert_eq!(after.iter().filter(|stored| matches!(stored.event.fact,
                    Fact::ModelRequested { .. })).count(), 1);
                assert_eq!(after.iter().filter(|stored| matches!(stored.event.fact,
                    Fact::ModelInterrupted { status: ModelInterruption::Cancelled, .. })).count(), 1);
            } else {
                assert!(matches!(next.last.event.fact,
                    Fact::InvocationEnded { outcome: InvocationOutcome::Completed }));
            }
            let unchanged = fixture.session(&session).await.run_source(&session, &source.boundary.invocation.run_id, None)
                .await.unwrap().unwrap();
            assert_eq!(unchanged.boundary, source.boundary);
            assert_eq!(counter.effects.load(Ordering::SeqCst), 1);
            eprintln!("{witness}");
            source_id = next_id;
        }
        unchanged_sources(&fixture, &session, &sources).await;
        assert_eq!(counter.effects.load(Ordering::SeqCst), 1);
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}
