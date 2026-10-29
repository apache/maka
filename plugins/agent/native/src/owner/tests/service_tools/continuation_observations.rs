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
    event::{InvocationOutcome, StoredEvent},
    model::{ModelPart, TextKind},
};
use maka_event_log::root_store::SessionStore;

// Read each committed Session interval once, including page boundaries.
async fn catch_up(
    store: &SessionStore,
    session: &str,
    after: &mut u64,
    through: u64,
) -> Vec<StoredEvent> {
    let mut events = Vec::new();
    while *after < through {
        let page = store
            .session_events(session, *after, through, 512, 8 * 1024 * 1024)
            .await
            .unwrap();
        events.extend(page.events);
        match page.next_after {
            Some(next) => *after = next,
            None => *after = through,
        }
    }
    events
}

fn settled_prompt(prompt: &Value, assembled: &str) -> Value {
    assert!(serde_json::to_vec(prompt).unwrap().len() < 256 * 1024);
    let messages = prompt["messages"].as_array().unwrap();
    assert!(
        messages.iter().any(|message| message["role"] == "assistant"
            && message["content"].as_str() == Some(assembled))
    );
    let result = messages
        .iter()
        .find(|message| message["role"] == "tool")
        .unwrap();
    let result: Value = serde_json::from_str(result["content"].as_str().unwrap()).unwrap();
    assert_eq!(result["effects"], 1);
    result
}

#[tokio::test]
async fn resume_many_provider_emissions_preserves_full_body_and_settled_effects() {
    tokio::time::timeout(Duration::from_secs(120), async {
        let assembled = "x".repeat(10_050);
        for observations in [16usize, 10_050] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let counter = Counter::new(Behavior::Returned);
            let fixture = Fixture::with_services(
                &format!("http://{}/v1", listener.local_addr().unwrap()),
                None,
                None,
                Some(Setup::native(counter.clone(), true)),
            )
            .await;
            selection::edit(&fixture, |changes| {
                changes.model_overrides = Patch::Set(BTreeMap::from([(
                    "fixture-model".into(),
                    ModelOverride {
                        code_mode: Some(true),
                        apply_patch: Some(true),
                        ..Default::default()
                    },
                )]));
            })
            .await;
            let session = fixture.create("Resume provider emissions").await;
            let mut commits = fixture.session(&session).await.subscribe_commits().unwrap();
            let sent = fixture.send(&session).await.unwrap();
            let source_id = sent["invocationId"].as_str().unwrap();
            let mut watch = fixture.app.client().subscribe(
                fixture.binding(2).await, "watch".into(), json!({"sessionId":session,"after":0}),
                scope(&fixture.issuer, true), Attachments::new().into(),
            ).await.unwrap();
            let (mut first, _) = listener.accept().await.unwrap();
            first.set_nodelay(true).unwrap();
            request(&mut first).await;
            let mut after = 0;
            let through = *commits.borrow_and_update();
            let initial = catch_up(&fixture.session(&session).await, &session, &mut after, through).await;
            let steps: Vec<_> = initial
                .iter()
                .filter_map(|stored| match &stored.event.fact {
                    Fact::ModelRequested { step_id, .. }
                        if stored.event.invocation.invocation_id == source_id => Some(step_id.clone()),
                    _ => None,
                })
                .collect();
            let [step] = steps.as_slice() else {
                panic!("the first provider request must have one committed source step");
            };
            let delta = |text: &str| format!("data: {}\n\n", json!({
                "id":"tool-model", "choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]
            }));
            let tool = json!({"id":"tool-model","choices":[{"index":0,"delta":{"tool_calls":[{
                "index":0,"id":"counter-call","type":"function",
                "function":{"name":"Counter","arguments":json!({"amount":1}).to_string()}
            }]},"finish_reason":null}]});
            let tail = format!(
                "data: {tool}\n\ndata: {{\"id\":\"tool-model\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n"
            );
            first.write_all(format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                observations * delta("").len() + assembled.len() + tail.len(),
            ).as_bytes()).await.unwrap();
            for index in 1..=observations {
                let text = &assembled[(index - 1) * assembled.len() / observations
                    ..index * assembled.len() / observations];
                first.write_all(delta(text).as_bytes()).await.unwrap();
            }
            let mut visible = String::new();
            while visible.len() < assembled.len() {
                let page = watch.recv().await.expect("preview must remain observable");
                if page["kind"] != "preview" || page["page"]["kind"] != "cut" { continue; }
                let page = &page["page"];
                if page["invocationId"] != source_id || page["stepId"] != *step { continue; }
                for part in page["parts"].as_array().unwrap() {
                    if part["field"]["kind"] != "text" || part["field"]["textKind"] != "text" { continue; }
                    assert_eq!(part["offset"], visible.len());
                    visible.push_str(part["text"].as_str().unwrap());
                }
            }
            assert_eq!(visible, assembled);
            drop(watch);
            first.write_all(tail.as_bytes()).await.unwrap();
            drop(first);
            let (mut next, _) = listener.accept().await.unwrap();
            let pending_prompt = request(&mut next).await;
            let original_result = settled_prompt(&pending_prompt, &assembled);
            assert_eq!(counter.effects.load(Ordering::SeqCst), 1);
            fixture.mutation(2, "stop", json!({
                "sessionId":session,"invocationId":source_id
            }), Uuid::new_v4()).await.unwrap();
            drop(next);
            fixture.drained().await;
            let execution = fixture.query("execution", json!({
                "sessionId":session,"invocationId":source_id
            })).await.unwrap();
            assert_eq!(execution["execution"]["state"], "cancelled");
            let (boundary, high_water) = fixture.session(&session).await.invocation_boundary(&session, source_id)
                .await.unwrap().unwrap();
            assert_eq!(execution["execution"]["highWater"], high_water);
            let source = fixture.session(&session).await.run_source(
                &session, &boundary.invocation.run_id, None,
            ).await.unwrap().unwrap();
            assert_eq!(source.boundary.invocation, boundary.invocation);
            assert_eq!(source.boundary.high_water, high_water);
            let mut source_after = 0;
            let source_events: Vec<_> = catch_up(
                &fixture.session(&session).await, &session, &mut source_after, source.last.sequence,
            ).await.into_iter().filter(|stored| stored.event.invocation == source.boundary.invocation).collect();
            assert_eq!(source_events.len() as u64, high_water);
            let mut recorded_parts = CanonicalModelParts::default();
            for stored in &source_events { recorded_parts.observe(stored); }
            let completed = source_events.iter().find_map(|stored| match &stored.event.fact {
                Fact::ModelCompleted { step_id, output } if step_id == step => Some(output),
                _ => None,
            }).expect("the original completed step remains canonical");
            let complete: String = recorded_parts.parts(completed).filter_map(|part| match part {
                ModelPart::Text { text_kind: TextKind::Text, text, .. } => Some(text),
                _ => None,
            }).flat_map(|text| text.chunks()).collect();
            assert_eq!(complete, assembled);
            assert_eq!(source_events.iter().filter(|stored| matches!(stored.event.fact,
                Fact::InvocationEnded { outcome: InvocationOutcome::Cancelled { .. } }
            )).count(), 1);
            assert_eq!(source_events.iter().filter(|stored| matches!(stored.event.fact,
                Fact::ToolDispatched { .. }
            )).count(), 1);
            assert_eq!(source_events.iter().filter(|stored| matches!(stored.event.fact,
                Fact::ToolSettled { outcome: ToolOutcome::Succeeded { .. }, .. }
            )).count(), 1);
            let bytes: usize = source_events.iter()
                .map(|stored| serde_json::to_vec(&stored.event).unwrap().len()).sum();
            assert!(bytes < 8 * 1024 * 1024);
            let context = fixture.session(&session).await.capture_model_context(&session, None, 1_000, 1024 * 1024)
                .await.unwrap();
            let prompt_bytes = serde_json::to_vec(&pending_prompt).unwrap().len();
            assert!(context.tail.len() < 32);
            assert!(prompt_bytes < 128 * 1024);
            let source_through = source.last.sequence;
            let resumed = fixture.mutation(2, "resume", json!({
                "sessionId":session,"sourceInvocationId":source_id,
                "sourceHighWater":high_water,"model":fixture.selection().await
            }), Uuid::new_v4()).await.unwrap();
            eprintln!("{}", json!({"observations":observations,"assembled_bytes":assembled.len(),"raw_events":high_water,
                "serialized_event_bytes":bytes,"context_events":context.tail.len(),
                "prompt_bytes":prompt_bytes,"resume":resumed}));
            assert_eq!(resumed["kind"], "started", "{observations} provider emissions: {resumed}");
            let (mut replay, _) = listener.accept().await.unwrap();
            let prompt = request(&mut replay).await;
            assert_eq!(settled_prompt(&prompt, &assembled), original_result);
            response(&mut replay).await;
            fixture.drained().await;
            let replayed = fixture.query("execution", json!({
                "sessionId":session,"invocationId":resumed["execution"]["invocationId"]
            })).await.unwrap();
            assert_eq!(replayed["execution"]["state"], "completed");
            let unchanged = fixture.session(&session).await.run_source(
                &session, &source.boundary.invocation.run_id, None,
            ).await.unwrap().unwrap();
            assert_eq!(unchanged.boundary, source.boundary, "resume must preserve exact source bytes and positions");
            let through = *commits.borrow_and_update();
            let mut after_source = source_through;
            let continuation = catch_up(&fixture.session(&session).await, &session, &mut after_source, through).await;
            assert!(!continuation.iter().any(|stored| matches!(stored.event.fact, Fact::ToolDispatched { .. })));
            assert_eq!(counter.effects.load(Ordering::SeqCst), 1, "resume must not redispatch a settled effect");
            fixture.app.shutdown().await.unwrap();
            fixture.config.shutdown().await.unwrap();
        }
    }).await.unwrap();
}
