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
use maka_agent_engine::ModelSource;

async fn diagnostic_state(fixture: &Fixture, session: &str) -> String {
    let events = stored_facts(fixture, session).await;
    let count = |kind| {
        events
            .iter()
            .filter(|event| event.event.fact.kind() == kind)
            .count()
    };
    let terminal = events.iter().find_map(|event| match &event.event.fact {
        Fact::InvocationEnded { outcome } => Some(outcome),
        _ => None,
    });
    let checkpoint = fixture
        .session(session)
        .await
        .native_approval_checkpoint(session)
        .await
        .map(|checkpoint| {
            checkpoint.map(|checkpoint| {
                (
                    checkpoint.checkpoint.id,
                    checkpoint.revoked,
                    checkpoint.stop_requested,
                    checkpoint
                        .pending
                        .iter()
                        .map(|pending| {
                            (pending.operation_id.clone(), pending.interaction_id.clone())
                        })
                        .collect::<Vec<_>>(),
                )
            })
        });
    let kinds = events
        .iter()
        .take(64)
        .map(|event| (event.sequence, event.event.fact.kind()))
        .collect::<Vec<_>>();
    let rejected = events
        .iter()
        .filter_map(|event| match &event.event.fact {
            Fact::ToolRejected {
                operation_id,
                name,
                reason,
                ..
            } => Some((operation_id, name, reason)),
            _ => None,
        })
        .take(16)
        .collect::<Vec<_>>();
    let interactions = fixture
        .session(session)
        .await
        .pending_interactions(session)
        .await
        .map(|records| {
            records
                .into_iter()
                .take(16)
                .map(|record| {
                    let kind = match record.request {
                        maka_agent_facts::interaction::InteractionRequest::ServiceApproval {
                            ..
                        } => "service_approval",
                        maka_agent_facts::interaction::InteractionRequest::Permissions {
                            ..
                        } => "permissions",
                        maka_agent_facts::interaction::InteractionRequest::Question { .. } => {
                            "question"
                        }
                        maka_agent_facts::interaction::InteractionRequest::Form { .. } => "form",
                        maka_agent_facts::interaction::InteractionRequest::ClientCapability {
                            ..
                        } => "client_capability",
                        maka_agent_facts::interaction::InteractionRequest::ComputerApp {
                            ..
                        } => "computer_app",
                    };
                    (record.request_id, kind)
                })
                .collect::<Vec<_>>()
        });
    let runs = fixture.owner.runs.state().await;
    format!(
        "terminal={terminal:?}, opened={}, T1={}, T2={}, requested={}, completed={}, interrupted={}, kinds={kinds:?}, rejected={rejected:?}, interactions={interactions:?}, checkpoint={checkpoint:?}, fixture_owner_closing={}, control={:?}, preparing={}, quarantined={}",
        count("invocation_opened"),
        count("tool_dispatched"),
        count("tool_settled"),
        count("model_requested"),
        count("model_completed"),
        count("model_interrupted"),
        runs.closing,
        runs.controls
            .get(session)
            .map(|control| (&control.invocation, control.failure)),
        runs.preparing.contains_key(session),
        runs.quarantined.contains(session)
    )
}

async fn next_model_socket(listener: &TcpListener, fixture: &Fixture, session: &str) -> TcpStream {
    eprintln!("approval fixture: waiting next model socket session={session}");
    let store = fixture.session(session).await;
    let mut commits = store.subscribe_commits().unwrap();
    loop {
        let events = stored_facts(fixture, session).await;
        if events
            .iter()
            .any(|event| matches!(event.event.fact, Fact::InvocationEnded { .. }))
        {
            panic!(
                "invocation ended before next model request: {}",
                diagnostic_state(fixture, session).await
            );
        }
        tokio::select! {
            socket = listener.accept() => {
                eprintln!("approval fixture: next model socket accepted session={session}");
                return socket.unwrap().0;
            },
            changed = commits.changed() => changed.unwrap(),
        }
    }
}

async fn responses_http_socket(
    listener: &TcpListener,
    fixture: &Fixture,
    session: &str,
) -> TcpStream {
    loop {
        let mut socket = next_model_socket(listener, fixture, session).await;
        let mut first = [0u8];
        assert_eq!(socket.peek(&mut first).await.unwrap(), 1);
        if first[0] == b'P' {
            return socket;
        }
        assert_eq!(first[0], b'G');
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            head.push(socket.read_u8().await.unwrap());
            assert!(head.len() < 64 * 1024);
        }
        assert!(head.starts_with(b"GET /v1/responses "));
        socket.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
    }
}

fn responses_events(events: &[Value]) -> String {
    events
        .iter()
        .map(|event| {
            format!(
                "event: {}\ndata: {event}\n\n",
                event["type"].as_str().unwrap()
            )
        })
        .collect()
}

async fn metadata_wake(fixture: &Fixture, session: &str) {
    loop {
        let current = fixture.owner.session(session).await.unwrap();
        let result = fixture
            .mutation(
                2,
                "metadata",
                json!({"sessionId":session,
            "expectedRevision":current.revision,"title":"Wake original settlement","labels":[]}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        match result["kind"].as_str().unwrap() {
            "committed" => return,
            "revision_conflict" => {}
            _ => panic!("unexpected metadata wake rejection: {result}"),
        }
    }
}

async fn two_counter_calls(socket: &mut TcpStream) {
    let delta = json!({"id":"two-approvals","choices":[{"index":0,"delta":{"tool_calls":[
        {"index":0,"id":"counter-first","type":"function","function":{"name":"Counter","arguments":"{\"amount\":1}"}},
        {"index":1,"id":"counter-second","type":"function","function":{"name":"Counter","arguments":"{\"amount\":1}"}}
    ]},"finish_reason":null}]});
    let body = format!(
        "data: {delta}\n\ndata: {}\n\ndata: [DONE]\n\n",
        json!({"id":"two-approvals","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]})
    );
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}

async fn pending_approval(
    fixture: &Fixture,
    session: &str,
) -> maka_agent_facts::interaction::InteractionRecord {
    let store = fixture.session(session).await;
    let mut commits = store.subscribe_commits().unwrap();
    eprintln!("approval fixture: entering pending approval barrier session={session}");
    loop {
        if let Some(record) = store
            .pending_interactions(session)
            .await
            .unwrap()
            .into_iter()
            .next()
        {
            assert!(matches!(
                record.request,
                maka_agent_facts::interaction::InteractionRequest::ServiceApproval { .. }
            ));
            return record;
        }
        let ended = stored_facts(fixture, session)
            .await
            .iter()
            .any(|event| matches!(event.event.fact, Fact::InvocationEnded { .. }));
        let failed = {
            let runs = fixture.owner.runs.state().await;
            runs.closing
                || runs.quarantined.contains(session)
                || runs
                    .controls
                    .get(session)
                    .is_some_and(|control| control.failure.is_some())
        };
        let observed = diagnostic_state(fixture, session).await;
        assert!(
            !ended && !failed,
            "original activation failed before establishing approval: {observed}"
        );
        eprintln!("approval fixture: pending approval progress session={session}: {observed}");
        commits.changed().await.unwrap();
    }
}

async fn parked(
    fixture: &Fixture,
    session: &str,
) -> maka_event_log::native_approvals::NativeApprovalCheckpoint {
    let store = fixture.session(session).await;
    let mut commits = store.subscribe_commits().unwrap();
    eprintln!("approval fixture: entering canonical park wait session={session}");
    loop {
        if let Some(checkpoint) = store.native_approval_checkpoint(session).await.unwrap() {
            eprintln!("approval fixture: waiting worker drain session={session}");
            fixture.drained().await;
            eprintln!("approval fixture: worker drain confirmed session={session}");
            assert!(
                !fixture
                    .owner
                    .runs
                    .state()
                    .await
                    .controls
                    .contains_key(session)
            );
            assert!(
                store
                    .native_approval_checkpoint(session)
                    .await
                    .unwrap()
                    .is_some()
            );
            let observed = fixture
                .query("observe", json!({"sessionId":session}))
                .await
                .unwrap();
            assert_eq!(observed["run"]["state"], "waiting_for_user");
            let archive = fixture
                .mutation(
                    2,
                    "changeSession",
                    json!({"sessionId":session,
                "expectedRevision":observed["session"]["revision"],"action":"archive"}),
                    Uuid::new_v4(),
                )
                .await
                .unwrap();
            assert_eq!(archive, json!({"kind":"rejected","reason":"busy"}));
            return checkpoint;
        }
        let ended = stored_facts(fixture, session)
            .await
            .iter()
            .any(|event| matches!(event.event.fact, Fact::InvocationEnded { .. }));
        let failed = {
            let runs = fixture.owner.runs.state().await;
            runs.closing
                || runs.quarantined.contains(session)
                || runs
                    .controls
                    .get(session)
                    .is_some_and(|control| control.failure.is_some())
        };
        let observed = diagnostic_state(fixture, session).await;
        assert!(
            !ended && !failed,
            "original activation failed before parking: {observed}"
        );
        eprintln!("approval fixture: canonical park progress session={session}: {observed}");
        commits.changed().await.unwrap();
    }
}

#[tokio::test]
async fn native_approval_releases_worker_and_resumes_original_operation_once() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let counter = Counter::new(Behavior::Returned);
        let mut setup = Setup::native(counter.clone(), true);
        setup.confirmation = contract::ToolConfirmation::Required;
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            Some(setup),
        )
        .await;
        let session = fixture.create("Park original native approval").await;
        let accepted = fixture.send(&session).await.unwrap();
        let accepted_basis = fixture
            .owner
            .runs
            .state()
            .await
            .controls
            .get(&session)
            .expect("accepted invocation owns its immutable basis")
            .basis
            .clone();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        tool_response_input(&mut socket, json!({"amount":7})).await;
        eprintln!("approval fixture: waiting pending interaction session={session}");
        let approval = pending_approval(&fixture, &session).await;
        eprintln!("approval fixture: pending interaction established session={session}");
        eprintln!("approval fixture: waiting physical park session={session}");
        let checkpoint = parked(&fixture, &session).await;
        eprintln!("approval fixture: physical park confirmed session={session}");
        assert_eq!(
            checkpoint.checkpoint.native_basis,
            serde_json::to_value(accepted_basis.as_ref()).unwrap(),
            "persistent park must preserve the exact accepted activation basis"
        );
        assert_eq!(
            checkpoint.checkpoint.invocation.invocation_id,
            accepted["invocationId"]
        );
        assert_eq!(checkpoint.pending.len(), 1);
        assert_eq!(checkpoint.pending[0].interaction_id, approval.request_id);
        let retained = fixture
            .store
            .accepted_execution_references(&fixture.owner.prefix, "fingerprint")
            .await
            .unwrap();
        assert!(
            retained.contains(
                checkpoint.checkpoint.native_basis["fingerprint"]
                    .as_str()
                    .unwrap()
            )
        );
        assert!(
            fixture
                .store
                .accepted_execution_references("foreign-owner", "fingerprint")
                .await
                .unwrap()
                .is_empty()
        );
        let operation = checkpoint.pending[0].operation_id.clone();
        let before = stored_facts(&fixture, &session).await;
        assert!(
            !before
                .iter()
                .any(|event| matches!(event.event.fact, Fact::InvocationEnded { .. }))
        );
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        assert_eq!(
            before
                .iter()
                .filter(|event| matches!(&event.event.fact,
            Fact::ToolDispatched { operation_id, .. } if operation_id == &operation))
                .count(),
            1
        );

        let held_admission = fixture.owner.runs.ordered(&session).await;
        let answer = json!({"sessionId":session,"requestId":approval.request_id,
            "answer":{"kind":"service_approval","decision":"allow"}});
        eprintln!("approval fixture: recording duplicate answers session={session}");
        for _ in 0..2 {
            fixture
                .mutation(2, "respond", answer.clone(), Uuid::new_v4())
                .await
                .unwrap();
        }
        for _ in 0..2 {
            fixture.owner.schedule_activations(now()).await.unwrap();
        }
        assert!(
            fixture
                .owner
                .runs
                .state()
                .await
                .preparing
                .contains_key(&session),
            "ready activation must retain its waiter while ordinary admission holds the gate"
        );
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        drop(held_admission);
        let mut socket = next_model_socket(&listener, &fixture, &session).await;
        let next = request(&mut socket).await;
        assert!(
            next["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| message["role"] == "tool")
        );
        response(&mut socket).await;
        eprintln!("approval fixture: waiting worker drain session={session}");
        fixture.drained().await;
        eprintln!("approval fixture: worker drain confirmed session={session}");
        let events = stored_facts(&fixture, &session).await;
        assert_eq!(counter.effects.load(Ordering::SeqCst), 7);
        assert_eq!(counter.entered.available_permits(), 1);
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event.event.fact, Fact::InvocationOpened { .. }))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(&event.event.fact,
            Fact::ToolDispatched { operation_id, .. } if operation_id == &operation))
                .count(),
            1
        );
        let settlements = events
            .iter()
            .filter(|event| {
                matches!(&event.event.fact,
            Fact::ToolSettled { operation_id, .. } if operation_id == &operation)
            })
            .collect::<Vec<_>>();
        assert_eq!(settlements.len(), 1);
        assert_eq!(
            settlements[0].event.invocation,
            checkpoint.checkpoint.invocation
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event.event.fact, Fact::InvocationEnded { .. }))
                .count(),
            1
        );
        assert!(
            fixture
                .session(&session)
                .await
                .native_approval_checkpoint(&session)
                .await
                .unwrap()
                .is_none()
        );
        assert!(!fixture.owner.runs.state().await.busy(&session));
        assert!(
            fixture
                .store
                .accepted_execution_references(&fixture.owner.prefix, "fingerprint")
                .await
                .unwrap()
                .is_empty()
        );
        eprintln!("approval fixture: waiting Host shutdown session={session}");
        fixture.app.shutdown().await.unwrap();
        eprintln!("approval fixture: Host shutdown complete session={session}");
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

async fn stopped_parked_approval(disable_model: bool) {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let counter = Counter::new(Behavior::Returned);
        let mut setup = Setup::native(counter.clone(), true);
        setup.confirmation = contract::ToolConfirmation::Required;
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()), None, None, Some(setup),
        ).await;
        let session = fixture.create("Stop parked native approval").await;
        let accepted = fixture.send(&session).await.unwrap();
        let mut socket = next_model_socket(&listener, &fixture, &session).await;
        request(&mut socket).await;
        tool_response(&mut socket).await;
        eprintln!("approval fixture: waiting pending interaction session={session}");
        let approval = pending_approval(&fixture, &session).await;
        eprintln!("approval fixture: pending interaction established session={session}");
        eprintln!("approval fixture: waiting physical park session={session}");
        let checkpoint = parked(&fixture, &session).await;
        eprintln!("approval fixture: physical park confirmed session={session}");
        if disable_model {
            super::super::selection::edit(&fixture, |changes| changes.enabled = Some(false)).await;
            let basis: MessageBasis = serde_json::from_value(checkpoint.checkpoint.native_basis.clone()).unwrap();
            let source = crate::model::Source::restore(
                fixture.owner.configuration.clone(), fixture.owner.credentials.clone(),
                basis.model.unwrap(), session.clone(), fixture.owner.revision.clone(),
            ).unwrap();
            assert!(source.capture().await.is_err(), "fixture must withdraw model preparation");
        }
        let stopped = fixture.mutation(2, "stop", json!({"sessionId":session,
            "invocationId":accepted["invocationId"]}), Uuid::new_v4()).await.unwrap();
        assert_eq!(stopped, json!({"requested":true}));
        let late = fixture.mutation(2, "respond", json!({"sessionId":session,
            "requestId":approval.request_id,"answer":{"kind":"service_approval","decision":"allow"}}),
            Uuid::new_v4()).await.unwrap();
        assert_eq!(late["record"]["outcome"]["kind"], "closure");
        let store = fixture.session(&session).await;
        let mut commits = store.subscribe_commits().unwrap();
        eprintln!("approval fixture: waiting canonical terminal session={session}: {}", diagnostic_state(&fixture, &session).await);
        loop {
            if facts(&fixture, &session).await.iter().any(|fact| matches!(fact, Fact::InvocationEnded { .. })) { break; }
            commits.changed().await.unwrap();
            eprintln!("approval fixture: terminal progress session={session}: {}", diagnostic_state(&fixture, &session).await);
        }
        eprintln!("approval fixture: canonical terminal confirmed session={session}");
        eprintln!("approval fixture: waiting worker drain session={session}");
        fixture.drained().await;
        eprintln!("approval fixture: worker drain confirmed session={session}");
        let events = stored_facts(&fixture, &session).await;
        assert_eq!(events.iter().filter(|event| matches!(&event.event.fact,
            Fact::ToolSettled { operation_id, .. } if operation_id == &checkpoint.pending[0].operation_id)).count(), 1);
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        assert_eq!(counter.entered.available_permits(), 0);
        assert!(store.native_approval_checkpoint(&session).await.unwrap().is_none());
        eprintln!("approval fixture: waiting Host shutdown session={session}");
        fixture.app.shutdown().await.unwrap();
        eprintln!("approval fixture: Host shutdown complete session={session}");
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn stop_finds_parked_native_approval_and_never_executes_late_allow() {
    stopped_parked_approval(false).await;
}

#[tokio::test]
async fn stop_settles_parked_original_operation_after_model_is_withdrawn() {
    stopped_parked_approval(true).await;
}

#[tokio::test]
async fn approved_original_native_effect_settles_even_when_next_model_is_unavailable() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let counter = Counter::new(Behavior::Returned);
        let mut setup = Setup::native(counter.clone(), true);
        setup.confirmation = contract::ToolConfirmation::Required;
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()), None, None, Some(setup),
        ).await;
        let session = fixture.create("Settle native operation before restoring model").await;
        fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        tool_response_input(&mut socket, json!({"amount":5})).await;
        eprintln!("approval fixture: waiting pending interaction session={session}");
        let approval = pending_approval(&fixture, &session).await;
        eprintln!("approval fixture: pending interaction established session={session}");
        eprintln!("approval fixture: waiting physical park session={session}");
        let checkpoint = parked(&fixture, &session).await;
        eprintln!("approval fixture: physical park confirmed session={session}");
        super::super::selection::edit(&fixture, |changes| changes.enabled = Some(false)).await;
        let basis: MessageBasis = serde_json::from_value(checkpoint.checkpoint.native_basis.clone()).unwrap();
        let source = crate::model::Source::restore(
            fixture.owner.configuration.clone(), fixture.owner.credentials.clone(),
            basis.model.unwrap(), session.clone(), fixture.owner.revision.clone(),
        ).unwrap();
        assert!(source.capture().await.is_err());
        fixture.mutation(2, "respond", json!({"sessionId":session,"requestId":approval.request_id,
            "answer":{"kind":"service_approval","decision":"allow"}}), Uuid::new_v4()).await.unwrap();
        eprintln!("approval fixture: waiting first physical effect session={session}");
        counter.entered.acquire().await.unwrap().forget();
        eprintln!("approval fixture: first physical effect entered session={session}");
        let store = fixture.session(&session).await;
        let mut commits = store.subscribe_commits().unwrap();
        eprintln!("approval fixture: waiting canonical terminal session={session}: {}", diagnostic_state(&fixture, &session).await);
        loop {
            if facts(&fixture, &session).await.iter().any(|fact| matches!(fact, Fact::InvocationEnded { .. })) { break; }
            commits.changed().await.unwrap();
            eprintln!("approval fixture: terminal progress session={session}: {}", diagnostic_state(&fixture, &session).await);
        }
        eprintln!("approval fixture: canonical terminal confirmed session={session}");
        eprintln!("approval fixture: waiting worker drain session={session}");
        fixture.drained().await;
        eprintln!("approval fixture: worker drain confirmed session={session}");
        let events = stored_facts(&fixture, &session).await;
        assert_eq!(counter.effects.load(Ordering::SeqCst), 5);
        assert_eq!(events.iter().filter(|event| matches!(&event.event.fact,
            Fact::ToolDispatched { operation_id, .. } if operation_id == &checkpoint.pending[0].operation_id)).count(), 1);
        assert_eq!(events.iter().filter(|event| matches!(&event.event.fact,
            Fact::ToolSettled { operation_id, outcome: ToolOutcome::Succeeded { .. }, .. }
                if operation_id == &checkpoint.pending[0].operation_id)).count(), 1);
        assert_eq!(events.iter().filter(|event| matches!(event.event.fact, Fact::ModelRequested { .. })).count(), 1);
        assert!(store.native_approval_checkpoint(&session).await.unwrap().is_none());
        eprintln!("approval fixture: waiting Host shutdown session={session}");
        fixture.app.shutdown().await.unwrap();
        eprintln!("approval fixture: Host shutdown complete session={session}");
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn exclusive_session_retirement_settles_parked_work_without_a_new_activation() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let counter = Counter::new(Behavior::Returned);
        let mut setup = Setup::native(counter.clone(), true);
        setup.confirmation = contract::ToolConfirmation::Required;
        eprintln!("approval fixture: constructing initial Host test=exclusive_session_retirement_settles_parked_work_without_a_new_activation");
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()), None, None, Some(setup),
        ).await;
        eprintln!("approval fixture: initial Host ready, creating session test=exclusive_session_retirement_settles_parked_work_without_a_new_activation");
        let session = fixture.create("Retire physically parked original operation").await;
        eprintln!("approval fixture: sending original message session={session}");
        fixture.send(&session).await.unwrap();
        eprintln!("approval fixture: original message accepted, waiting initial socket session={session}");
        let (mut socket, _) = listener.accept().await.unwrap();
        eprintln!("approval fixture: initial socket accepted, reading original request session={session}");
        request(&mut socket).await;
        eprintln!("approval fixture: original request read, sending tool response session={session}");
        tool_response(&mut socket).await;
        eprintln!("approval fixture: provider body sent, waiting pending approval session={session}");
        pending_approval(&fixture, &session).await;
        eprintln!("approval fixture: pending approval established session={session}");
        eprintln!("approval fixture: waiting physical park session={session}");
        let checkpoint = parked(&fixture, &session).await;
        eprintln!("approval fixture: physical park confirmed session={session}");
        let store = fixture.session(&session).await;
        let revision = fixture.owner.session(&session).await.unwrap().revision;
        assert!(matches!(fixture.store.remove_session_family(&session, revision,
            maka_event_log::sessions::RemovalAuthority::Unmanaged).await.unwrap(),
            maka_event_log::sessions::RemoveFamilyResult::Accepted(_)));
        assert_eq!(fixture.store.finish_session_retirement(&session).await.unwrap(),
            maka_event_log::sessions::SessionRetirement::Removed);
        eprintln!("approval fixture: waiting worker drain session={session}");
        fixture.drained().await;
        eprintln!("approval fixture: worker drain confirmed session={session}");
        assert!(!fixture.owner.runs.state().await.controls.contains_key(&session));
        assert!(!fixture.owner.runs.state().await.closing);
        assert!(store.native_approval_checkpoint(&session).await.unwrap().is_none());
        let events = store.scoped_prefix(maka_agent_facts::event::LogScope::Session { id:session.clone() },
            256, 4*1024*1024).await.unwrap().events;
        assert_eq!(events.iter().filter(|event| matches!(&event.event.fact,
            Fact::ToolSettled { operation_id, .. } if operation_id == &checkpoint.pending[0].operation_id)).count(), 1);
        assert_eq!(events.iter().filter(|event| matches!(event.event.fact, Fact::InvocationEnded {
            outcome: maka_agent_facts::event::InvocationOutcome::Cancelled { .. } })).count(), 1);
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        assert_eq!(counter.entered.available_permits(), 0);
        eprintln!("approval fixture: waiting Host shutdown session={session}");
        fixture.app.shutdown().await.unwrap();
        eprintln!("approval fixture: Host shutdown complete session={session}");
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn answered_native_approval_starts_while_original_provider_is_still_open() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let counter = Counter::new(Behavior::Returned);
        let mut setup = Setup::native(counter.clone(), true);
        setup.confirmation = contract::ToolConfirmation::Required;
        let fixture = Fixture::configured_provider(
            &format!("http://{}/v1", listener.local_addr().unwrap()), None, None, Some(setup),
            |_| {}, "openai-responses-compatible",
        ).await;
        let session = fixture.create("Approve before physical model closure").await;
        fixture.send(&session).await.unwrap();
        let mut socket = responses_http_socket(&listener, &fixture, &session).await;
        request(&mut socket).await;
        assert!(facts(&fixture, &session).await.iter().any(|fact| matches!(fact,
            Fact::ModelRequested { item_acceptance: true, .. })), "the real provider must support accepted items before physical closure");
        let call = json!({"type":"function_call","id":"item_counter","call_id":"counter-call",
            "name":"Counter","arguments":json!({"amount":3}).to_string()});
        let first = responses_events(&[
            json!({"type":"response.created","response":{"id":"resp_open","created_at":1,"model":"fixture-model"}}),
            json!({"type":"response.output_item.added","output_index":0,"item":{
                "type":"function_call","id":"item_counter","call_id":"counter-call","name":"Counter","arguments":""}}),
            json!({"type":"response.function_call_arguments.delta","item_id":"item_counter","output_index":0,"delta":json!({"amount":3}).to_string()}),
            json!({"type":"response.output_item.done","output_index":0,"item":call}),
        ]);
        let tail = responses_events(&[json!({"type":"response.completed","response":{
            "id":"resp_open","output":[],"usage":{"input_tokens":2,"output_tokens":3}}})]);
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{first}", first.len()+tail.len()).as_bytes()).await.unwrap();
        eprintln!("approval fixture: waiting pending interaction session={session}");
        let approval = pending_approval(&fixture, &session).await;
        eprintln!("approval fixture: pending interaction established session={session}");
        fixture.mutation(2, "respond", json!({"sessionId":session,"requestId":approval.request_id,
            "answer":{"kind":"service_approval","decision":"allow"}}), Uuid::new_v4()).await.unwrap();
        eprintln!("approval fixture: waiting first physical effect session={session}");
        counter.entered.acquire().await.unwrap().forget();
        eprintln!("approval fixture: first physical effect entered session={session}");
        assert_eq!(counter.effects.load(Ordering::SeqCst), 3);
        assert!(fixture.session(&session).await.native_approval_checkpoint(&session).await.unwrap().is_none());
        eprintln!("approval fixture: releasing provider body tail session={session}");
        socket.write_all(tail.as_bytes()).await.unwrap();
        eprintln!("approval fixture: provider body tail released session={session}");
        let mut socket = responses_http_socket(&listener, &fixture, &session).await;
        request(&mut socket).await;
        let body = responses_events(&[
            json!({"type":"response.created","response":{"id":"resp_final","created_at":2,"model":"fixture-model"}}),
            json!({"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_final","role":"assistant","content":[]}}),
            json!({"type":"response.output_text.delta","item_id":"msg_final","output_index":0,"content_index":0,"delta":"Elegant response"}),
            json!({"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_final","role":"assistant","content":[{"type":"output_text","text":"Elegant response","annotations":[]}]}}),
            json!({"type":"response.completed","response":{"id":"resp_final","output":[],"usage":{"input_tokens":2,"output_tokens":5}}}),
        ]);
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        eprintln!("approval fixture: waiting worker drain session={session}");
        fixture.drained().await;
        eprintln!("approval fixture: worker drain confirmed session={session}");
        assert_eq!(facts(&fixture, &session).await.iter().filter(|fact| matches!(fact, Fact::InvocationOpened { .. })).count(), 1);
        eprintln!("approval fixture: waiting Host shutdown session={session}");
        fixture.app.shutdown().await.unwrap();
        eprintln!("approval fixture: Host shutdown complete session={session}");
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

async fn restarted_approval(opaque_native_binding: bool) {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let counter = Counter::new(Behavior::Returned);
        let mut setup = if opaque_native_binding {
            Setup::native(counter.clone(), true)
        } else {
            Setup::javascript()
        };
        setup.confirmation = contract::ToolConfirmation::Required;
        let policy = setup.policy();
        let mut fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()), None, None, Some(setup),
        ).await;
        let session = fixture.create("Restore original parked native approval").await;
        let accepted = fixture.send(&session).await.unwrap();
        let mut socket = next_model_socket(&listener, &fixture, &session).await;
        request(&mut socket).await;
        tool_response_input(&mut socket, json!({"amount":7})).await;
        eprintln!("approval fixture: waiting pending interaction session={session}");
        let approval = pending_approval(&fixture, &session).await;
        eprintln!("approval fixture: pending interaction established session={session}");
        eprintln!("approval fixture: waiting physical park session={session}");
        let checkpoint = parked(&fixture, &session).await;
        eprintln!("approval fixture: physical park confirmed session={session}");
        let deployment = fixture.app.client().snapshot().effective.unwrap().deployment;
        eprintln!("approval fixture: waiting Host shutdown session={session}");
        fixture.app.shutdown().await.unwrap();
        eprintln!("approval fixture: Host shutdown complete session={session}");
        // Use the real exclusive startup recovery, before creating the new Host.
        eprintln!("approval fixture: waiting startup recovery session={session}");
        assert_eq!(fixture.store.recover_invocations().await.unwrap(), 0);
        eprintln!("approval fixture: startup recovery complete session={session}");
        let preserved = fixture.session(&session).await.native_approval_checkpoint(&session).await.unwrap().unwrap();
        assert_eq!(preserved.checkpoint, checkpoint.checkpoint);
        assert_eq!(preserved.receipt, checkpoint.receipt);
        assert_eq!(fixture.session(&session).await.interaction(&approval.request_id).await.unwrap().unwrap().outcome, None);

        eprintln!("approval fixture: constructing fresh Host session={session}");
        let mut native = NativeRegistry::default();
        provide_all(&mut native).unwrap();
        maka_settings_native::provide(&mut native, bundled_catalog()).unwrap();
        if opaque_native_binding {
            Setup::native(counter.clone(), true).provide(&mut native);
        }
        fixture.app = Application::start_from_store(
            fixture.store.clone(), deployment, native, fixture.issuer.clone(),
            Arc::new(Grant(fixture.issuer.clone(), Some(policy))),
            Some(maka_host_js::factory(Default::default())),
        ).await.unwrap();
        eprintln!("approval fixture: waiting fresh Host ready session={session}");
        fixture.app.ready().await.unwrap();
        eprintln!("approval fixture: fresh Host ready session={session}");
        let pending = fixture.query("pendingInteractions", json!({"sessionId":session})).await.unwrap();
        assert_eq!(pending["entries"].as_array().unwrap().len(), 1);
        assert_eq!(pending["entries"][0]["requestId"], approval.request_id);
        let before = stored_facts(&fixture, &session).await;
        assert_eq!(before.iter().filter(|event| matches!(event.event.fact, Fact::InvocationOpened { .. })).count(), 1);
        assert_eq!(before.iter().filter(|event| matches!(event.event.fact, Fact::ModelRequested { .. })).count(), 1);
        assert!(!before.iter().any(|event| matches!(event.event.fact, Fact::InvocationEnded { .. })));

        let answer = json!({"sessionId":session,"requestId":approval.request_id,
            "answer":{"kind":"service_approval","decision":"allow"}});
        eprintln!("approval fixture: recording duplicate answers session={session}");
        for _ in 0..2 {
            fixture.mutation(2, "respond", answer.clone(), Uuid::new_v4()).await.unwrap();
        }
        let mut socket = next_model_socket(&listener, &fixture, &session).await;
        let prompt = request(&mut socket).await;
        let tool_result = prompt["messages"].as_array().unwrap().iter()
            .find(|message| message["role"] == "tool").unwrap()["content"].as_str().unwrap();
        if opaque_native_binding {
            assert!(tool_result.contains("stale") || tool_result.contains("unavailable"), "{tool_result}");
            assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        } else {
            assert_eq!(serde_json::from_str::<Value>(tool_result).unwrap(), json!({"effects":7}));
        }
        let store = fixture.session(&session).await;
        let mut commits = store.subscribe_commits().unwrap();
        response(&mut socket).await;
        eprintln!("approval fixture: waiting original terminal session={session}: {}", diagnostic_state(&fixture, &session).await);
        eprintln!("approval fixture: waiting canonical terminal session={session}: {}", diagnostic_state(&fixture, &session).await);
        loop {
            if facts(&fixture, &session).await.iter().any(|fact| matches!(fact, Fact::InvocationEnded { .. })) { break; }
            commits.changed().await.unwrap();
            eprintln!("approval fixture: terminal progress session={session}: {}", diagnostic_state(&fixture, &session).await);
        }
        eprintln!("approval fixture: canonical terminal confirmed session={session}");
        let events = stored_facts(&fixture, &session).await;
        assert_eq!(events.iter().filter(|event| matches!(event.event.fact, Fact::InvocationOpened { .. })).count(), 1);
        assert_eq!(events.iter().filter(|event| matches!(&event.event.fact,
            Fact::ToolDispatched { operation_id, .. } if operation_id == &checkpoint.pending[0].operation_id)).count(), 1);
        let settled = events.iter().filter(|event| matches!(&event.event.fact,
            Fact::ToolSettled { operation_id, .. } if operation_id == &checkpoint.pending[0].operation_id)).collect::<Vec<_>>();
        assert_eq!(settled.len(), 1);
        assert_eq!(settled[0].event.invocation, checkpoint.checkpoint.invocation);
        assert_eq!(settled[0].event.invocation.invocation_id, accepted["invocationId"]);
        assert!(matches!(settled[0].event.fact, Fact::ToolSettled { outcome: ToolOutcome::Succeeded { .. }, .. }) != opaque_native_binding);
        assert_eq!(events.iter().filter(|event| matches!(event.event.fact, Fact::InvocationEnded { .. })).count(), 1);
        assert!(store.native_approval_checkpoint(&session).await.unwrap().is_none());
        eprintln!("approval fixture: waiting Host shutdown session={session}");
        fixture.app.shutdown().await.unwrap();
        eprintln!("approval fixture: Host shutdown complete session={session}");
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn actual_host_restart_preserves_approval_and_fresh_equal_binding_settles_original_once() {
    restarted_approval(false).await;
}

#[tokio::test]
async fn actual_host_restart_rejects_opaque_stale_binding_without_original_effect() {
    restarted_approval(true).await;
}

struct RejectedPublication {
    rejected: Arc<Semaphore>,
    event_id: Arc<StdMutex<Option<String>>>,
}
impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for RejectedPublication {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        #[derive(Default)]
        struct Fields {
            stage: Option<String>,
            event_id: Option<String>,
        }
        impl tracing::field::Visit for Fields {
            fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
                match field.name() {
                    "stage" => self.stage = Some(value.into()),
                    "event_id" => self.event_id = Some(value.into()),
                    _ => {}
                }
            }
            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                self.record_str(field, &format!("{value:?}"));
            }
        }
        let mut fields = Fields::default();
        event.record(&mut fields);
        if fields.stage.as_deref() == Some("native_approval_t2_unconfirmed") {
            *self.event_id.lock().unwrap() = fields.event_id;
            self.rejected.add_permits(1);
        }
    }
}

#[tokio::test]
async fn rejected_original_t2_retains_real_custody_and_retries_same_event_without_effect_replay() {
    use tracing_subscriber::prelude::*;

    tokio::time::timeout(Duration::from_secs(60), async {
        let rejected = Arc::new(Semaphore::new(0));
        let event_id = Arc::new(StdMutex::new(None));
        let subscriber = tracing_subscriber::registry().with(RejectedPublication {
            rejected: rejected.clone(), event_id: event_id.clone(),
        });
        // Tokio's current-thread test keeps the actual worker under this dispatcher.
        let _capture = tracing::subscriber::set_default(subscriber);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let counter = Counter::new(Behavior::Returned);
        let mut setup = Setup::native(counter.clone(), true);
        setup.confirmation = contract::ToolConfirmation::Required;
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()), None, None, Some(setup),
        ).await;
        let session = fixture.create("Retain original native settlement until receipt").await;
        fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        tool_response_input(&mut socket, json!({"amount":3})).await;
        eprintln!("approval fixture: waiting pending interaction session={session}");
        let approval = pending_approval(&fixture, &session).await;
        eprintln!("approval fixture: pending interaction established session={session}");
        eprintln!("approval fixture: waiting physical park session={session}");
        let checkpoint = parked(&fixture, &session).await;
        eprintln!("approval fixture: physical park confirmed session={session}");
        let raw = rusqlite::Connection::open(fixture.session_database(&session)).unwrap();
        raw.execute_batch("CREATE TRIGGER reject_native_t2 BEFORE INSERT ON event_log WHEN NEW.kind='tool_settled' BEGIN SELECT RAISE(ABORT, 'fixture original T2 unavailable'); END;").unwrap();
        fixture.mutation(2, "respond", json!({"sessionId":session,"requestId":approval.request_id,
            "answer":{"kind":"service_approval","decision":"allow"}}), Uuid::new_v4()).await.unwrap();
        rejected.acquire().await.unwrap().forget();
        let original_t2 = event_id.lock().unwrap().clone().expect("failed exact original T2 identity");
        assert_eq!(counter.effects.load(Ordering::SeqCst), 3);
        assert_eq!(counter.entered.available_permits(), 1);
        let before = stored_facts(&fixture, &session).await;
        assert!(!before.iter().any(|event| matches!(event.event.fact, Fact::ToolSettled { .. } | Fact::InvocationEnded { .. })));
        {
            let runs = fixture.owner.runs.state().await;
            assert_eq!(runs.controls[&session].invocation, checkpoint.checkpoint.invocation);
            assert!(!runs.closing);
            assert!(!runs.quarantined.contains(&session));
        }
        assert!(matches!(fixture.store.finish_session_retirement(&session).await,
            Err(maka_event_log::StoreError::SessionBusy)), "actual exclusive Work gate must reject retirement while original T2 is retained");
        raw.execute_batch("DROP TRIGGER reject_native_t2").unwrap();
        drop(raw);
        metadata_wake(&fixture, &session).await;
        let mut socket = next_model_socket(&listener, &fixture, &session).await;
        request(&mut socket).await;
        response(&mut socket).await;
        eprintln!("approval fixture: waiting worker drain session={session}");
        fixture.drained().await;
        eprintln!("approval fixture: worker drain confirmed session={session}");
        let events = stored_facts(&fixture, &session).await;
        let settlements = events.iter().filter(|event| matches!(&event.event.fact,
            Fact::ToolSettled { operation_id, .. } if operation_id == &checkpoint.pending[0].operation_id)).collect::<Vec<_>>();
        assert_eq!(settlements.len(), 1);
        assert_eq!(settlements[0].event.id, original_t2);
        assert_eq!(counter.effects.load(Ordering::SeqCst), 3);
        assert_eq!(counter.entered.available_permits(), 1);
        assert_eq!(events.iter().filter(|event| matches!(&event.event.fact,
            Fact::ToolDispatched { operation_id, .. } if operation_id == &checkpoint.pending[0].operation_id)).count(), 1);
        assert_eq!(events.iter().filter(|event| matches!(event.event.fact, Fact::InvocationEnded { .. })).count(), 1);
        eprintln!("approval fixture: waiting Host shutdown session={session}");
        fixture.app.shutdown().await.unwrap();
        eprintln!("approval fixture: Host shutdown complete session={session}");
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn permission_revocation_after_park_fences_late_allow_and_settles_original_failure() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let counter = Counter::new(Behavior::Returned);
        let mut setup = Setup::native(counter.clone(), true);
        setup.confirmation = contract::ToolConfirmation::Required;
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            Some(setup),
        )
        .await;
        let session = fixture
            .create("Revoke parked native permission boundary")
            .await;
        fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        tool_response(&mut socket).await;
        eprintln!("approval fixture: waiting pending interaction session={session}");
        let approval = pending_approval(&fixture, &session).await;
        eprintln!("approval fixture: pending interaction established session={session}");
        eprintln!("approval fixture: waiting physical park session={session}");
        let checkpoint = parked(&fixture, &session).await;
        eprintln!("approval fixture: physical park confirmed session={session}");
        let changed =
            super::super::files::change(&fixture, &session, "read_only", false, true).await;
        assert_eq!(changed["kind"], "committed");
        let late = fixture
            .mutation(
                2,
                "respond",
                json!({"sessionId":session,"requestId":approval.request_id,
            "answer":{"kind":"service_approval","decision":"allow"}}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(late["record"]["outcome"]["kind"], "closure");
        let mut socket = next_model_socket(&listener, &fixture, &session).await;
        let prompt = request(&mut socket).await;
        assert!(
            prompt["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| message["role"] == "tool")
        );
        let observed = stored_facts(&fixture, &session).await;
        assert_eq!(
            observed
                .iter()
                .filter(|event| matches!(&event.event.fact,
            Fact::ToolSettled { operation_id, outcome: ToolOutcome::Failed { .. } }
                if operation_id == &checkpoint.pending[0].operation_id))
                .count(),
            1
        );
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        assert_eq!(counter.entered.available_permits(), 0);
        response(&mut socket).await;
        eprintln!("approval fixture: waiting worker drain session={session}");
        fixture.drained().await;
        eprintln!("approval fixture: worker drain confirmed session={session}");
        let events = stored_facts(&fixture, &session).await;
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event.event.fact, Fact::InvocationOpened { .. }))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event.event.fact,
                    Fact::InvocationEnded {
                        outcome: maka_agent_facts::event::InvocationOutcome::Completed
                    }
                ))
                .count(),
            1
        );
        assert!(
            fixture
                .session(&session)
                .await
                .native_approval_checkpoint(&session)
                .await
                .unwrap()
                .is_none()
        );
        eprintln!("approval fixture: waiting Host shutdown session={session}");
        fixture.app.shutdown().await.unwrap();
        eprintln!("approval fixture: Host shutdown complete session={session}");
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn partial_approval_batch_executes_ready_original_call_and_reparks_remaining_wait() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let counter = Counter::new(Behavior::Returned);
        let mut setup = Setup::native(counter.clone(), true);
        setup = setup.with_query(true);
        setup.confirmation = contract::ToolConfirmation::Required;
        eprintln!("approval fixture: constructing initial Host test=partial_approval_batch_executes_ready_original_call_and_reparks_remaining_wait");
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            Some(setup),
        )
        .await;
        eprintln!("approval fixture: initial Host ready, creating session test=partial_approval_batch_executes_ready_original_call_and_reparks_remaining_wait");
        let session = fixture
            .create("Resume independent answers before the whole batch")
            .await;
        eprintln!("approval fixture: sending original message session={session}");
        fixture.send(&session).await.unwrap();
        eprintln!("approval fixture: original message accepted, waiting initial socket session={session}");
        let (mut socket, _) = listener.accept().await.unwrap();
        eprintln!("approval fixture: initial socket accepted, reading original request session={session}");
        request(&mut socket).await;
        eprintln!("approval fixture: original request read, sending tool response session={session}");
        two_counter_calls(&mut socket).await;
        eprintln!("approval fixture: two-call provider body sent, entering park barrier session={session}");
        let original = parked(&fixture, &session).await;
        assert_eq!(original.pending.len(), 2);
        assert_eq!(counter.entered.available_permits(), 0);
        let first = &original.pending[0];
        let store = fixture.session(&session).await;
        let mut commits = store.subscribe_commits().unwrap();
        fixture
            .mutation(
                2,
                "respond",
                json!({"sessionId":session,"requestId":first.interaction_id,
            "answer":{"kind":"service_approval","decision":"allow"}}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        let remaining = loop {
            if let Some(checkpoint) = store.native_approval_checkpoint(&session).await.unwrap()
                && checkpoint.receipt != original.receipt
                && checkpoint.pending.len() == 1
            {
                break checkpoint;
            }
            commits.changed().await.unwrap();
        };
        eprintln!("approval fixture: waiting worker drain session={session}");
        fixture.drained().await;
        eprintln!("approval fixture: worker drain confirmed session={session}");
        assert!(
            !fixture
                .owner
                .runs
                .state()
                .await
                .controls
                .contains_key(&session)
        );
        assert_eq!(
            remaining.checkpoint.invocation,
            original.checkpoint.invocation
        );
        assert_ne!(remaining.pending[0].operation_id, first.operation_id);
        assert_eq!(counter.entered.available_permits(), 1);
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        let partial = stored_facts(&fixture, &session).await;
        assert_eq!(
            partial
                .iter()
                .filter(|event| matches!(&event.event.fact,
            Fact::ToolSettled { operation_id, .. } if operation_id == &first.operation_id))
                .count(),
            1
        );
        assert_eq!(
            partial
                .iter()
                .filter(|event| matches!(event.event.fact, Fact::ToolSettled { .. }))
                .count(),
            1
        );
        assert_eq!(
            partial
                .iter()
                .filter(|event| matches!(event.event.fact, Fact::ModelRequested { .. }))
                .count(),
            1
        );
        assert!(
            !partial
                .iter()
                .any(|event| matches!(event.event.fact, Fact::InvocationEnded { .. }))
        );
        assert!(
            store
                .interaction(&remaining.pending[0].interaction_id)
                .await
                .unwrap()
                .unwrap()
                .outcome
                .is_none()
        );

        fixture
            .mutation(
                2,
                "respond",
                json!({"sessionId":session,"requestId":remaining.pending[0].interaction_id,
            "answer":{"kind":"service_approval","decision":"allow"}}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        let mut socket = next_model_socket(&listener, &fixture, &session).await;
        let prompt = request(&mut socket).await;
        assert_eq!(
            prompt["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|message| message["role"] == "tool")
                .count(),
            2
        );
        response(&mut socket).await;
        eprintln!("approval fixture: waiting worker drain session={session}");
        fixture.drained().await;
        eprintln!("approval fixture: worker drain confirmed session={session}");
        let events = stored_facts(&fixture, &session).await;
        assert_eq!(counter.entered.available_permits(), 2);
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event.event.fact, Fact::InvocationOpened { .. }))
                .count(),
            1
        );
        for pending in &original.pending {
            assert_eq!(
                events
                    .iter()
                    .filter(|event| matches!(&event.event.fact,
                Fact::ToolDispatched { operation_id, .. } if operation_id == &pending.operation_id))
                    .count(),
                1
            );
            let settled = events
                .iter()
                .filter(|event| {
                    matches!(&event.event.fact,
                Fact::ToolSettled { operation_id, .. } if operation_id == &pending.operation_id)
                })
                .collect::<Vec<_>>();
            assert_eq!(settled.len(), 1);
            assert_eq!(settled[0].event.invocation, original.checkpoint.invocation);
        }
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event.event.fact, Fact::InvocationEnded { .. }))
                .count(),
            1
        );
        assert!(
            store
                .native_approval_checkpoint(&session)
                .await
                .unwrap()
                .is_none()
        );
        eprintln!("approval fixture: waiting Host shutdown session={session}");
        fixture.app.shutdown().await.unwrap();
        eprintln!("approval fixture: Host shutdown complete session={session}");
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn missing_workspace_marker_after_park_settles_failure_before_effect_or_next_model() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let counter = Counter::new(Behavior::Returned);
        let mut setup = Setup::native(counter.clone(), true);
        setup.confirmation = contract::ToolConfirmation::Required;
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()), None, None, Some(setup),
        ).await;
        let session = fixture.create("Reject stale workspace action boundaries").await;
        fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        tool_response(&mut socket).await;
        eprintln!("approval fixture: waiting pending interaction session={session}");
        let approval = pending_approval(&fixture, &session).await;
        eprintln!("approval fixture: pending interaction established session={session}");
        eprintln!("approval fixture: waiting physical park session={session}");
        let checkpoint = parked(&fixture, &session).await;
        eprintln!("approval fixture: physical park confirmed session={session}");
        let marker = fixture.workspace.join(maka_fs_tools::workspace::MARKER_FILE);
        let original_marker = std::fs::read(&marker).unwrap();
        std::fs::remove_file(&marker).unwrap();
        fixture.mutation(2, "respond", json!({"sessionId":session,"requestId":approval.request_id,
            "answer":{"kind":"service_approval","decision":"allow"}}), Uuid::new_v4()).await.unwrap();
        let store = fixture.session(&session).await;
        let mut commits = store.subscribe_commits().unwrap();
        eprintln!("approval fixture: waiting canonical terminal session={session}: {}", diagnostic_state(&fixture, &session).await);
        loop {
            if facts(&fixture, &session).await.iter().any(|fact| matches!(fact, Fact::InvocationEnded { .. })) { break; }
            commits.changed().await.unwrap();
            eprintln!("approval fixture: terminal progress session={session}: {}", diagnostic_state(&fixture, &session).await);
        }
        eprintln!("approval fixture: canonical terminal confirmed session={session}");
        eprintln!("approval fixture: waiting worker drain session={session}");
        fixture.drained().await;
        eprintln!("approval fixture: worker drain confirmed session={session}");
        let events = stored_facts(&fixture, &session).await;
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        assert_eq!(counter.entered.available_permits(), 0);
        assert_eq!(events.iter().filter(|event| matches!(&event.event.fact,
            Fact::ToolSettled { operation_id, outcome: ToolOutcome::Failed { message } }
                if operation_id == &checkpoint.pending[0].operation_id && message.contains("workspace_unavailable"))).count(), 1);
        assert_eq!(events.iter().filter(|event| matches!(event.event.fact, Fact::ModelRequested { .. })).count(), 1);
        assert_eq!(events.iter().filter(|event| matches!(event.event.fact, Fact::InvocationEnded {
            outcome: maka_agent_facts::event::InvocationOutcome::Failed { .. } })).count(), 1);
        assert!(store.native_approval_checkpoint(&session).await.unwrap().is_none());
        std::fs::write(marker, original_marker).unwrap();
        eprintln!("approval fixture: waiting Host shutdown session={session}");
        fixture.app.shutdown().await.unwrap();
        eprintln!("approval fixture: Host shutdown complete session={session}");
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn host_shutdown_drains_resumed_effect_and_preserves_unanswered_original_for_restart() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let counter = Counter::new(Behavior::Blocked);
        let mut setup = Setup::native(counter.clone(), true);
        setup = setup.with_query(true);
        setup.confirmation = contract::ToolConfirmation::Required;
        let policy = setup.policy();
        eprintln!("approval fixture: constructing initial Host test=host_shutdown_drains_resumed_effect_and_preserves_unanswered_original_for_restart");
        let mut fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()), None, None, Some(setup),
        ).await;
        eprintln!("approval fixture: initial Host ready, creating session test=host_shutdown_drains_resumed_effect_and_preserves_unanswered_original_for_restart");
        let session = fixture.create("Host closure preserves logical native approval work").await;
        eprintln!("approval fixture: sending original message session={session}");
        fixture.send(&session).await.unwrap();
        eprintln!("approval fixture: original message accepted, waiting initial socket session={session}");
        let (mut socket, _) = listener.accept().await.unwrap();
        eprintln!("approval fixture: initial socket accepted, reading original request session={session}");
        request(&mut socket).await;
        eprintln!("approval fixture: original request read, sending tool response session={session}");
        two_counter_calls(&mut socket).await;
        eprintln!("approval fixture: two-call provider body sent, entering park barrier session={session}");
        let original = parked(&fixture, &session).await;
        assert_eq!(original.pending.len(), 2);
        let first = &original.pending[0];
        fixture.mutation(2, "respond", json!({"sessionId":session,"requestId":first.interaction_id,
            "answer":{"kind":"service_approval","decision":"allow"}}), Uuid::new_v4()).await.unwrap();
        eprintln!("approval fixture: waiting first physical effect session={session}");
        counter.entered.acquire().await.unwrap().forget();
        eprintln!("approval fixture: first physical effect entered session={session}");
        let deployment = fixture.app.client().snapshot().effective.unwrap().deployment;
        {
            let shutdown = fixture.app.shutdown();
            tokio::pin!(shutdown);
            tokio::select! {
                cancelled = counter.cancelled.acquire() => cancelled.unwrap().forget(),
                completed = &mut shutdown => panic!("Host must retain the physically blocked original effect: {completed:?}"),
            }
            counter.release.add_permits(1);
            shutdown.await.unwrap();
        }
        let store = fixture.session(&session).await;
        let remaining = store.native_approval_checkpoint(&session).await.unwrap().unwrap();
        assert_eq!(remaining.checkpoint.invocation, original.checkpoint.invocation);
        assert_eq!(remaining.pending.len(), 1);
        assert_ne!(remaining.pending[0].operation_id, first.operation_id);
        assert!(store.interaction(&remaining.pending[0].interaction_id).await.unwrap().unwrap().outcome.is_none());
        let after_close = stored_facts(&fixture, &session).await;
        assert_eq!(after_close.iter().filter(|event| matches!(&event.event.fact,
            Fact::ToolSettled { operation_id, .. } if operation_id == &first.operation_id)).count(), 1);
        assert_eq!(after_close.iter().filter(|event| matches!(event.event.fact, Fact::ModelRequested { .. })).count(), 1);
        assert!(!after_close.iter().any(|event| matches!(event.event.fact, Fact::InvocationEnded { .. })));
        eprintln!("approval fixture: waiting startup recovery session={session}");
        assert_eq!(fixture.store.recover_invocations().await.unwrap(), 0);
        eprintln!("approval fixture: startup recovery complete session={session}");
        let recovered = store.native_approval_checkpoint(&session).await.unwrap().unwrap();
        assert_eq!(recovered.receipt, remaining.receipt);
        assert!(store.interaction(&remaining.pending[0].interaction_id).await.unwrap().unwrap().outcome.is_none());

        eprintln!("approval fixture: constructing fresh Host session={session}");
        let mut native = NativeRegistry::default();
        provide_all(&mut native).unwrap();
        maka_settings_native::provide(&mut native, bundled_catalog()).unwrap();
        let mut restored_setup = Setup::native(counter.clone(), true);
        restored_setup = restored_setup.with_query(true);
        restored_setup.provide(&mut native);
        fixture.app = Application::start_from_store(
            fixture.store.clone(), deployment, native, fixture.issuer.clone(),
            Arc::new(Grant(fixture.issuer.clone(), Some(policy))),
            Some(maka_host_js::factory(Default::default())),
        ).await.unwrap();
        eprintln!("approval fixture: waiting fresh Host ready session={session}");
        fixture.app.ready().await.unwrap();
        eprintln!("approval fixture: fresh Host ready session={session}");
        let pending = fixture.query("pendingInteractions", json!({"sessionId":session})).await.unwrap();
        assert_eq!(pending["entries"].as_array().unwrap().len(), 1);
        assert_eq!(pending["entries"][0]["requestId"], remaining.pending[0].interaction_id);
        fixture.mutation(2, "respond", json!({"sessionId":session,"requestId":remaining.pending[0].interaction_id,
            "answer":{"kind":"service_approval","decision":"allow"}}), Uuid::new_v4()).await.unwrap();
        let mut socket = next_model_socket(&listener, &fixture, &session).await;
        let prompt = request(&mut socket).await;
        assert_eq!(prompt["messages"].as_array().unwrap().iter().filter(|message| message["role"] == "tool").count(), 2);
        let mut commits = store.subscribe_commits().unwrap();
        response(&mut socket).await;
        eprintln!("approval fixture: waiting original terminal session={session}: {}", diagnostic_state(&fixture, &session).await);
        eprintln!("approval fixture: waiting canonical terminal session={session}: {}", diagnostic_state(&fixture, &session).await);
        loop {
            if facts(&fixture, &session).await.iter().any(|fact| matches!(fact, Fact::InvocationEnded { .. })) { break; }
            commits.changed().await.unwrap();
            eprintln!("approval fixture: terminal progress session={session}: {}", diagnostic_state(&fixture, &session).await);
        }
        eprintln!("approval fixture: canonical terminal confirmed session={session}");
        let events = stored_facts(&fixture, &session).await;
        assert_eq!(events.iter().filter(|event| matches!(event.event.fact, Fact::InvocationOpened { .. })).count(), 1);
        for pending in &original.pending {
            assert_eq!(events.iter().filter(|event| matches!(&event.event.fact,
                Fact::ToolDispatched { operation_id, .. } if operation_id == &pending.operation_id)).count(), 1);
            let settled = events.iter().filter(|event| matches!(&event.event.fact,
                Fact::ToolSettled { operation_id, .. } if operation_id == &pending.operation_id)).collect::<Vec<_>>();
            assert_eq!(settled.len(), 1);
            assert_eq!(settled[0].event.invocation, original.checkpoint.invocation);
        }
        assert!(events.iter().any(|event| matches!(&event.event.fact,
            Fact::ToolSettled { operation_id, outcome: ToolOutcome::Failed { message } }
                if operation_id == &remaining.pending[0].operation_id && message.contains("stale"))));
        assert_eq!(counter.entered.available_permits(), 0, "fresh opaque binding must not start another native call");
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        assert!(store.native_approval_checkpoint(&session).await.unwrap().is_none());
        eprintln!("approval fixture: waiting Host shutdown session={session}");
        fixture.app.shutdown().await.unwrap();
        eprintln!("approval fixture: Host shutdown complete session={session}");
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

struct PreparationDrop(Option<tokio::sync::oneshot::Sender<()>>);
impl Drop for PreparationDrop {
    fn drop(&mut self) {
        if let Some(dropped) = self.0.take() {
            let _ = dropped.send(());
        }
    }
}

#[tokio::test]
async fn owner_shutdown_retains_blocking_continuation_preparation_and_real_work_until_join() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let counter = Counter::new(Behavior::Returned);
        let mut setup = Setup::native(counter.clone(), true);
        setup.confirmation = contract::ToolConfirmation::Required;
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()), None, None, Some(setup),
        ).await;
        let session = fixture.create("Drain actual owned continuation preparation").await;
        fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        tool_response(&mut socket).await;
        eprintln!("approval fixture: waiting pending interaction session={session}");
        let approval = pending_approval(&fixture, &session).await;
        eprintln!("approval fixture: pending interaction established session={session}");
        eprintln!("approval fixture: waiting physical park session={session}");
        let checkpoint = parked(&fixture, &session).await;
        eprintln!("approval fixture: physical park confirmed session={session}");
        // Retire the queue observer before this test admits the same canonical
        // checkpoint through the real Engine, rather than a fabricated message.
        fixture.owner.stop.cancel();
        fixture.owner.producers.close();
        fixture.owner.producers.wait().await;
        let store = fixture.session(&session).await;
        store.commit_interaction_outcome(&approval.request_id,
            maka_agent_facts::interaction::InteractionAnswer::ServiceApproval {
                decision: maka_agent_facts::interaction::Decision::Allow,
            }.into_outcome(now())).await.unwrap();
        let configuration = store.invocation_configuration(&checkpoint.checkpoint.invocation)
            .await.unwrap().unwrap();
        let entered = Arc::new(Semaphore::new(0));
        let observed_stop = Arc::new(Semaphore::new(0));
        let (release, released) = std::sync::mpsc::channel::<()>();
        let (dropped, mut drop_notice) = tokio::sync::oneshot::channel();
        let shutdown = CancellationToken::new();
        let preparation_shutdown = shutdown.clone();
        let preparation_entered = entered.clone();
        let preparation_observed_stop = observed_stop.clone();
        let continuation = Box::pin(async move {
            let _owned = PreparationDrop(Some(dropped));
            let job = tokio::task::spawn_blocking(move || {
                preparation_entered.add_permits(1);
                released.recv().expect("physical preparation release");
            });
            preparation_shutdown.cancelled().await;
            preparation_observed_stop.add_permits(1);
            job.await.map_err(|error| RunError::Internal(error.to_string()))?;
            Err(RunError::Cancelled)
        });
        let running = fixture.owner.engine.start_resume(store.clone(), maka_agent_engine::ResumeInput {
            configuration,
            checkpoint: checkpoint.clone(),
            executor: fixture.owner.clone(),
            host_epoch: fixture.owner.revision.activation.clone(),
            owner_shutdown: shutdown.clone(),
            continuation,
            tool_names: fixture.owner.tools.names().into_iter().collect(),
        }, CancellationToken::new()).await.unwrap();
        entered.acquire().await.unwrap().forget();
        assert_eq!(counter.effects.load(Ordering::SeqCst), 1);
        shutdown.cancel();
        observed_stop.acquire().await.unwrap().forget();
        assert!(matches!(drop_notice.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Empty)),
            "owner shutdown must not drop preparation while its blocking job remains physical");
        assert!(matches!(fixture.store.finish_session_retirement(&session).await,
            Err(maka_event_log::StoreError::SessionBusy)), "actual Work pin must remain until preparation joins");
        let before_release = stored_facts(&fixture, &session).await;
        assert_eq!(before_release.iter().filter(|event| matches!(event.event.fact, Fact::ModelRequested { .. })).count(), 1);
        assert!(!before_release.iter().any(|event| matches!(event.event.fact, Fact::InvocationEnded { .. })));
        release.send(()).unwrap();
        let completion = running.completion().await;
        assert!(completion.cleanup.is_ok());
        let maka_agent_engine::ActivationExit::Parked(receipt) = completion.result.unwrap() else {
            panic!("drained owner shutdown must retain the original model cursor");
        };
        assert_eq!(receipt, checkpoint.receipt);
        assert!(drop_notice.try_recv().is_ok());
        let remaining = store.native_approval_checkpoint(&session).await.unwrap().unwrap();
        assert_eq!(remaining.receipt, checkpoint.receipt);
        assert!(remaining.pending.is_empty());
        let events = stored_facts(&fixture, &session).await;
        assert_eq!(events.iter().filter(|event| matches!(&event.event.fact,
            Fact::ToolSettled { operation_id, .. } if operation_id == &checkpoint.pending[0].operation_id)).count(), 1);
        assert_eq!(events.iter().filter(|event| matches!(event.event.fact, Fact::ModelRequested { .. })).count(), 1);
        assert!(!events.iter().any(|event| matches!(event.event.fact, Fact::InvocationEnded { .. })));
        assert_eq!(counter.effects.load(Ordering::SeqCst), 1);
        eprintln!("approval fixture: waiting Host shutdown session={session}");
        fixture.app.shutdown().await.unwrap();
        eprintln!("approval fixture: Host shutdown complete session={session}");
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn frozen_retry_preparation_reacquires_current_ceiling_and_rejects_changed_bindings() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let counter = Counter::new(Behavior::Returned);
        let mut setup = Setup::native(counter.clone(), true);
        setup.confirmation = contract::ToolConfirmation::Required;
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            Some(setup),
        )
        .await;
        let session = fixture.create("Frozen retry accepted capabilities").await;
        fixture.send(&session).await.unwrap();
        let mut socket = next_model_socket(&listener, &fixture, &session).await;
        request(&mut socket).await;
        tool_response(&mut socket).await;
        pending_approval(&fixture, &session).await;
        let checkpoint = parked(&fixture, &session).await;
        let invocation = &checkpoint.checkpoint.invocation;
        let accepted = &checkpoint.checkpoint.native_basis;
        let accepted_basis =
            Arc::new(serde_json::from_value::<MessageBasis>(accepted.clone()).unwrap());
        let cancellation = CancellationToken::new();
        let original = fixture
            .owner
            .prepare_frozen_retry(invocation, accepted_basis.clone(), &cancellation)
            .await
            .unwrap();
        let current = fixture.owner.session(&session).await.unwrap();
        let boundary_revision = current.configuration.boundary_revision + 1;
        let changed = fixture
            .session(&session)
            .await
            .update_session_metadata(
                &session,
                current.revision,
                move |configuration: &mut StoredSessionConfiguration| {
                    configuration.permissions = WorkspacePermissions {
                        access: WorkspaceAccess::ReadOnly,
                        request_permissions: false,
                    };
                    configuration.boundary_revision = boundary_revision;
                    Ok(())
                },
            )
            .await
            .unwrap();
        assert!(matches!(
            changed,
            maka_event_log::sessions::SessionMutation::Committed(_)
        ));
        let resumed = fixture
            .owner
            .prepare_frozen_retry(invocation, accepted_basis.clone(), &cancellation)
            .await
            .unwrap();
        assert_eq!(
            resumed.settings.configuration.sandbox_mode,
            SandboxMode::ReadOnly
        );
        assert_eq!(
            resumed.settings.configuration.approval_policy,
            ApprovalPolicy::Never
        );
        assert_eq!(
            resumed.settings.configuration.boundary_revision,
            boundary_revision
        );
        assert_eq!(
            resumed.settings.configuration.workspace_binding,
            original.settings.configuration.workspace_binding
        );
        assert_eq!(
            resumed
                .settings
                .native_activation_basis
                .as_ref()
                .unwrap()
                .checkpoint_value()
                .unwrap(),
            *accepted
        );

        let mut replaced: MessageBasis = serde_json::from_value(accepted.clone()).unwrap();
        replaced.binding.id = Uuid::new_v4();
        let replaced = Arc::new(replaced);
        assert!(
            matches!(fixture.owner.prepare_frozen_retry(invocation, replaced, &cancellation).await,
            Err(RunError::InvalidInput(reason)) if reason == "agent_session_configuration_changed")
        );

        super::super::selection::edit(&fixture, |changes| changes.enabled = Some(false)).await;
        assert!(
            fixture
                .owner
                .prepare_frozen_retry(invocation, accepted_basis.clone(), &cancellation)
                .await
                .is_err()
        );
        assert_eq!(
            counter.effects.load(Ordering::SeqCst),
            0,
            "reacquiring capabilities must not execute an old accepted tool call"
        );
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn actual_host_startup_resumes_due_model_retry_once() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let setup = Setup::javascript();
        let policy = setup.policy();
        let mut fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            Some(setup),
        )
        .await;
        let session = fixture
            .create("Restart due model retry through Native dispatcher")
            .await;
        fixture.send(&session).await.unwrap();
        let (prime, basis) = {
            let runs = fixture.owner.runs.state().await;
            let control = runs.controls.get(&session).unwrap();
            (control.invocation.clone(), control.basis.clone())
        };
        let store = fixture.session(&session).await;
        let mut commits = store.subscribe_commits().unwrap();
        let mut socket = next_model_socket(&listener, &fixture, &session).await;
        request(&mut socket).await;
        response(&mut socket).await;
        drop(socket);
        loop {
            if stored_facts(&fixture, &session).await.iter().any(|stored| {
                stored.event.invocation == prime
                    && matches!(stored.event.fact, Fact::InvocationEnded { .. })
            }) {
                break;
            }
            commits.changed().await.unwrap();
        }
        fixture.drained().await;
        let configuration = store
            .invocation_configuration(&prime)
            .await
            .unwrap()
            .unwrap();
        let held_admission = fixture.owner.runs.ordered(&session).await;
        let identity = Uuid::new_v4();
        let invocation = maka_agent_facts::event::Invocation {
            session_id: session.clone(),
            turn_id: format!("retry-turn-{identity}"),
            run_id: format!("retry-run-{identity}"),
            invocation_id: format!("retry-invocation-{identity}"),
        };
        let source = crate::model::Source::restore(
            fixture.owner.configuration.clone(),
            fixture.owner.credentials.clone(),
            basis.model.clone().unwrap(),
            session.clone(),
            fixture.owner.revision.clone(),
        )
        .unwrap();
        let prepared = source.capture().await.unwrap();
        let tools = fixture
            .owner
            .selected_tools(
                &basis,
                configuration.tool_discovery,
                configuration.editing_tools,
            )
            .unwrap();
        let input = maka_agent_engine::RunInput {
            invocation: invocation.clone(),
            model_source: Some(Arc::new(source)),
            model_revision: Some(prepared.revision),
            provider_id: prepared.provider_id,
            context: prepared.context,
            provider: prepared.provider,
            provider_options: prepared.options,
            main_output_limit: prepared.main_output_limit,
            supports_vision: prepared.supports_vision,
            request_fingerprint: Some(basis.fingerprint.clone()),
            native_activation_basis: Some(basis),
            configuration,
            work: maka_agent_engine::RunWork::Message {
                message: "Hello".into(),
                source_messages: vec![],
                tools,
                allow_prior_unknown: false,
            },
        };
        let seeded = maka_agent_engine::retry_fixture::seed_due_model_retry(
            &fixture.owner.engine,
            store.clone(),
            input,
        )
        .await
        .unwrap();
        let deployment = fixture
            .app
            .client()
            .snapshot()
            .effective
            .unwrap()
            .deployment;
        fixture.app.shutdown().await.unwrap();
        drop(held_admission);
        let preserved = store
            .activation_checkpoint(&session)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(preserved.checkpoint, seeded.checkpoint.checkpoint);
        assert_eq!(preserved.receipt, seeded.checkpoint.receipt);
        assert_eq!(fixture.store.recover_invocations().await.unwrap(), 0);
        let recovered = store
            .activation_checkpoint(&session)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered.checkpoint, seeded.checkpoint.checkpoint);
        assert_eq!(recovered.receipt, seeded.checkpoint.receipt);
        assert!(
            futures_util::FutureExt::now_or_never(listener.accept()).is_none(),
            "old Host must join without sending the seeded historical request"
        );

        let mut native = NativeRegistry::default();
        provide_all(&mut native).unwrap();
        maka_settings_native::provide(&mut native, bundled_catalog()).unwrap();
        fixture.app = Application::start_from_store(
            fixture.store.clone(),
            deployment,
            native,
            fixture.issuer.clone(),
            Arc::new(Grant(fixture.issuer.clone(), Some(policy))),
            Some(maka_host_js::factory(Default::default())),
        )
        .await
        .unwrap();
        fixture.app.ready().await.unwrap();
        let mut socket = loop {
            assert!(
                !stored_facts(&fixture, &session)
                    .await
                    .iter()
                    .any(|stored| stored.event.invocation == invocation
                        && matches!(stored.event.fact, Fact::InvocationEnded { .. })),
                "retry terminated before its actual transport send"
            );
            tokio::select! {
                socket = listener.accept() => break socket.unwrap().0,
                changed = commits.changed() => changed.unwrap(),
            }
        };
        let sent = request(&mut socket).await;
        assert_eq!(sent["model"], "fixture-model");
        response(&mut socket).await;
        drop(socket);
        loop {
            if stored_facts(&fixture, &session).await.iter().any(|stored| {
                stored.event.invocation == invocation
                    && matches!(stored.event.fact, Fact::InvocationEnded { .. })
            }) {
                break;
            }
            commits.changed().await.unwrap();
        }
        fixture.app.shutdown().await.unwrap();
        let events: Vec<_> = stored_facts(&fixture, &session)
            .await
            .into_iter()
            .filter(|stored| stored.event.invocation == invocation)
            .collect();
        let requested: Vec<_> = events
            .iter()
            .filter(|stored| matches!(stored.event.fact, Fact::ModelRequested { .. }))
            .collect();
        assert_eq!(
            requested.len(),
            2,
            "one historical request and exactly one resumed send"
        );
        assert_eq!(requested[0].event.id, seeded.request_event_id);
        assert_ne!(requested[0].event.id, requested[1].event.id);
        let mut resumed = requested[1].event.fact.clone();
        match (&requested[0].event.fact, &mut resumed) {
            (
                Fact::ModelRequested {
                    step_id: original_step,
                    input_digest,
                    ..
                },
                Fact::ModelRequested {
                    step_id: resumed_step,
                    ..
                },
            ) => {
                assert_ne!(original_step.as_str(), resumed_step.as_str());
                assert_eq!(input_digest, &seeded.input_digest);
                *resumed_step = original_step.clone();
            }
            _ => unreachable!("both canonical requests were selected above"),
        }
        assert_eq!(
            requested[0].event.fact, resumed,
            "frozen source, input and route evidence must be preserved"
        );
        assert_eq!(
            store
                .request_composition(&session, &requested[0].event.id)
                .await
                .unwrap()
                .unwrap(),
            store
                .request_composition(&session, &requested[1].event.id)
                .await
                .unwrap()
                .unwrap()
        );
        assert_eq!(
            events
                .iter()
                .filter(|stored| matches!(
                    stored.event.fact,
                    Fact::ModelInterrupted {
                        status: maka_agent_facts::event::ModelInterruption::RetryableFailure,
                        ..
                    }
                ))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|stored| matches!(stored.event.fact, Fact::ModelCompleted { .. }))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|stored| matches!(
                    stored.event.fact,
                    Fact::InvocationEnded {
                        outcome: maka_agent_facts::event::InvocationOutcome::Completed
                    }
                ))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|stored| matches!(stored.event.fact, Fact::InvocationEnded { .. }))
                .count(),
            1
        );
        assert!(
            !events
                .iter()
                .any(|stored| matches!(stored.event.fact, Fact::ToolDispatched { .. }))
        );
        assert!(
            store
                .activation_checkpoint(&session)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            futures_util::FutureExt::now_or_never(listener.accept()).is_none(),
            "joined Host must not have produced an additional transport send"
        );
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
