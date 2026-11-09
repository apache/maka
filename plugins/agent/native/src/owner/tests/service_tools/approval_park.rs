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
use maka_agent_authority::permissions::Access;
use maka_agent_engine::ModelSource;
use maka_agent_facts::durable::{
    AcceptedResult, AuthorizationObligation, Fact, FactId, RunId, Terminal, ToolKey, WaitReason,
};
use maka_agent_facts::model::ModelPart;
use maka_agent_state::fold::RunView;

async fn diagnostic_state(fixture: &Fixture, session: &str) -> String {
    let events = stored_facts(fixture, session).await;
    let view = fixture
        .owner
        .durable
        .frontier(fixture.latest_run(session).await.run)
        .await;
    let interactions = fixture.owner.durable.interactions().pending(session).await;
    let runs = fixture.owner.runs.state().await;
    format!(
        "view={view:?}, facts={:?}, interactions={interactions:?}, fixture_owner_closing={}, control={:?}, preparing={}, retained_cleanup={}",
        events
            .iter()
            .take(64)
            .map(|item| (item.sequence, &item.recorded.fact))
            .collect::<Vec<_>>(),
        runs.closing,
        runs.controls.get(session).map(|control| &control.execution),
        runs.preparing.contains_key(session),
        runs.retained_cleanup.contains_key(session)
    )
}

#[derive(Debug)]
struct ApprovalWait {
    tool: ToolKey,
    request_id: String,
}

#[derive(Debug)]
struct ApprovalPark {
    view: RunView,
    pending: Vec<ApprovalWait>,
}

async fn approval_park(fixture: &Fixture, session: &str) -> Option<ApprovalPark> {
    let source = fixture.latest_run(session).await;
    let view = fixture.owner.durable.frontier(source.run).await.unwrap();
    if view.terminal.is_some() {
        return None;
    }
    let interactions = fixture.owner.durable.interactions();
    let records = interactions.pending(session).await.unwrap().records;
    let mut pending = Vec::new();
    for record in records {
        assert_eq!(record.execution, source.execution());
        let binding = interactions
            .binding(session, &record.request_id)
            .await
            .unwrap()
            .expect("canonical approval retains its original binding");
        let AuthorizationObligation::Tool { tool } = binding.target else {
            panic!("service approval must name its original tool");
        };
        if view.waits.values().any(|wait| {
            wait.satisfied.is_none()
                && wait.cancelled.is_none()
                && wait.reason
                    == (WaitReason::Approval {
                        approval: binding.approval,
                    })
        }) {
            assert_eq!(view.approvals[&binding.approval].tool, tool);
            pending.push(ApprovalWait {
                tool,
                request_id: record.request_id,
            });
        }
    }
    (!pending.is_empty()).then_some(ApprovalPark { view, pending })
}

async fn active_spec_refs(
    fixture: &Fixture,
    session: &str,
    owner: &maka_agent_facts::durable::RunOwner,
) -> Vec<maka_agent_facts::durable::ContentRef> {
    let runs = fixture
        .owner
        .durable
        .runs(session.to_owned(), None, 256)
        .await
        .unwrap();
    let mut retained = Vec::new();
    for run in runs {
        let view = fixture.owner.durable.frontier(run).await.unwrap();
        if view.spec.owner == *owner && view.terminal.is_none() {
            retained.push(view.spec_ref.expect("admitted Run retains canonical spec"));
        }
    }
    retained
}

async fn restored_model(fixture: &Fixture, view: &RunView) -> crate::model::Source {
    let maka_agent_facts::durable::BackendSpec::Model { descriptor, .. } = &view.spec.backend
    else {
        panic!("fixture has a model backend");
    };
    let bytes = fixture
        .owner
        .durable
        .content(view.run, descriptor.clone())
        .await
        .unwrap();
    let accepted = crate::model::AcceptedModel::from_backend(&view.spec.backend, &bytes).unwrap();
    crate::model::Source::restore(
        fixture.owner.configuration.clone(),
        fixture.owner.credentials.clone(),
        accepted,
        view.spec.session_id.clone(),
        fixture.owner.revision.clone(),
    )
    .unwrap()
}

async fn next_model_socket(listener: &TcpListener, fixture: &Fixture, session: &str) -> TcpStream {
    eprintln!("approval fixture: waiting next model socket session={session}");
    let store = fixture.owner.durable.clone();
    let mut commits = store.subscribe().unwrap();
    loop {
        let events = stored_facts(fixture, session).await;
        if events
            .iter()
            .any(|event| matches!(event.recorded.fact, Fact::RunTerminated { .. }))
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
    let store = fixture.owner.durable.clone();
    let mut commits = store.subscribe().unwrap();
    eprintln!("approval fixture: entering pending approval barrier session={session}");
    loop {
        if let Some(record) = store
            .interactions()
            .pending(session)
            .await
            .unwrap()
            .records
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
            .any(|event| matches!(event.recorded.fact, Fact::RunTerminated { .. }));
        let failed = {
            let runs = fixture.owner.runs.state().await;
            runs.closing || runs.retained_cleanup.contains_key(session)
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

async fn parked(fixture: &Fixture, session: &str) -> ApprovalPark {
    let store = fixture.owner.durable.clone();
    let mut commits = store.subscribe().unwrap();
    eprintln!("approval fixture: entering canonical park wait session={session}");
    loop {
        if let Some(checkpoint) = approval_park(fixture, session).await {
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
            assert!(approval_park(fixture, session).await.is_some());
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
            .any(|event| matches!(event.recorded.fact, Fact::RunTerminated { .. }));
        let failed = {
            let runs = fixture.owner.runs.state().await;
            runs.closing || runs.retained_cleanup.contains_key(session)
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
        let accepted_run = fixture.delivered_run(&accepted).await;
        let accepted_basis = fixture.latest_run(&session).await.spec;
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
            checkpoint.view.spec,
            accepted_basis,
            "persistent park must preserve the exact accepted activation basis"
        );
        assert_eq!(
            checkpoint.view.run.to_string(),
            accepted_run.to_string()
        );
        assert_eq!(checkpoint.pending.len(), 1);
        assert_eq!(checkpoint.pending[0].request_id, approval.request_id);
        let retained = active_spec_refs(&fixture, &session, &fixture.owner.run_owner()).await;
        assert!(retained.contains(checkpoint.view.spec_ref.as_ref().unwrap()));
        let mut foreign = fixture.owner.run_owner();
        foreign.namespace = id(999);
        assert!(active_spec_refs(&fixture, &session, &foreign).await.is_empty());
        let operation = checkpoint.pending[0].tool.clone();
        let before = stored_facts(&fixture, &session).await;
        assert!(
            !before
                .iter()
                .any(|event| matches!(event.recorded.fact, Fact::RunTerminated { .. }))
        );
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        assert!(!before.iter().any(|event| matches!(&event.recorded.fact,
            Fact::ToolAdmitted { tool } if tool == &operation)));
        assert_eq!(
            before
                .iter()
                .filter(|event| matches!(&event.recorded.fact,
            Fact::ModelObserved { attempt, part: ModelPart::ToolCall { call }, .. } if &(ToolKey { attempt: *attempt, call: call.id.clone() }) == &operation))
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
            fixture.owner.schedule_ready().await.unwrap();
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
        assert_eq!(events.iter().filter(|event| matches!(&event.recorded.fact,
            Fact::ToolAdmitted { tool } if tool == &operation)).count(), 1);
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event.recorded.fact, Fact::RunAdmitted { .. }))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(&event.recorded.fact,
            Fact::ModelObserved { attempt, part: ModelPart::ToolCall { call }, .. } if &(ToolKey { attempt: *attempt, call: call.id.clone() }) == &operation))
                .count(),
            1
        );
        let settlements = events
            .iter()
            .filter(|event| {
                matches!(&event.recorded.fact,
            Fact::ToolResultAccepted { tool, .. } if tool == &operation)
            })
            .collect::<Vec<_>>();
        assert_eq!(settlements.len(), 1);
        assert_eq!(
            settlements[0].recorded.run,
            checkpoint.view.run
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event.recorded.fact, Fact::RunTerminated { .. }))
                .count(),
            1
        );
        assert!(
            approval_park(&fixture, &session).await
                .is_none()
        );
        assert!(!fixture.owner.runs.state().await.busy(&session));
        assert!(
            active_spec_refs(&fixture, &session, &fixture.owner.run_owner()).await
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
        let accepted_run = fixture.delivered_run(&accepted).await;
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
            let source = restored_model(&fixture, &checkpoint.view).await;
            assert!(source.capture().await.is_err(), "fixture must withdraw model preparation");
        }
        let stopped = fixture.mutation(2, "stop", json!({"sessionId":session,
            "runId":accepted_run.to_string()}), Uuid::new_v4()).await.unwrap();
        assert_eq!(stopped, json!({"requested":true}));
        let late = fixture.mutation(2, "respond", json!({"sessionId":session,
            "requestId":approval.request_id,"answer":{"kind":"service_approval","decision":"allow"}}),
            Uuid::new_v4()).await.unwrap();
        assert_eq!(late["record"]["outcome"]["kind"], "closure");
        let store = fixture.owner.durable.clone();
        let mut commits = store.subscribe().unwrap();
        eprintln!("approval fixture: waiting canonical terminal session={session}: {}", diagnostic_state(&fixture, &session).await);
        loop {
            if facts(&fixture, &session).await.iter().any(|fact| matches!(fact, Fact::RunTerminated { .. })) { break; }
            commits.changed().await.unwrap();
            eprintln!("approval fixture: terminal progress session={session}: {}", diagnostic_state(&fixture, &session).await);
        }
        eprintln!("approval fixture: canonical terminal confirmed session={session}");
        eprintln!("approval fixture: waiting worker drain session={session}");
        fixture.drained().await;
        eprintln!("approval fixture: worker drain confirmed session={session}");
        let events = stored_facts(&fixture, &session).await;
        assert_eq!(events.iter().filter(|event| matches!(&event.recorded.fact,
            Fact::ToolResultAccepted { tool, .. } if tool == &checkpoint.pending[0].tool)).count(), 1);
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        assert_eq!(counter.entered.available_permits(), 0);
        assert!(approval_park(&fixture, &session).await.is_none());
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
        let source = restored_model(&fixture, &checkpoint.view).await;
        assert!(source.capture().await.is_err());
        fixture.mutation(2, "respond", json!({"sessionId":session,"requestId":approval.request_id,
            "answer":{"kind":"service_approval","decision":"allow"}}), Uuid::new_v4()).await.unwrap();
        eprintln!("approval fixture: waiting first physical effect session={session}");
        counter.entered.acquire().await.unwrap().forget();
        eprintln!("approval fixture: first physical effect entered session={session}");
        let store = fixture.owner.durable.clone();
        let mut commits = store.subscribe().unwrap();
        eprintln!("approval fixture: waiting canonical terminal session={session}: {}", diagnostic_state(&fixture, &session).await);
        loop {
            if facts(&fixture, &session).await.iter().any(|fact| matches!(fact, Fact::RunTerminated { .. })) { break; }
            commits.changed().await.unwrap();
            eprintln!("approval fixture: terminal progress session={session}: {}", diagnostic_state(&fixture, &session).await);
        }
        eprintln!("approval fixture: canonical terminal confirmed session={session}");
        eprintln!("approval fixture: waiting worker drain session={session}");
        fixture.drained().await;
        eprintln!("approval fixture: worker drain confirmed session={session}");
        let events = stored_facts(&fixture, &session).await;
        assert_eq!(counter.effects.load(Ordering::SeqCst), 5);
        assert_eq!(events.iter().filter(|event| matches!(&event.recorded.fact,
            Fact::ModelObserved { attempt, part: ModelPart::ToolCall { call }, .. } if &(ToolKey { attempt: *attempt, call: call.id.clone() }) == &checkpoint.pending[0].tool)).count(), 1);
        assert_eq!(events.iter().filter(|event| matches!(&event.recorded.fact,
            Fact::ToolResultAccepted { tool, outcome: AcceptedResult::Succeeded, .. }
                if tool == &checkpoint.pending[0].tool)).count(), 1);
        assert_eq!(events.iter().filter(|event| matches!(event.recorded.fact, Fact::ModelAttemptPrepared { .. })).count(), 1);
        assert!(approval_park(&fixture, &session).await.is_none());
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
        parked(&fixture, &session).await;
        eprintln!("approval fixture: physical park confirmed session={session}");
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
        assert!(fixture.query("observe", json!({"sessionId":session})).await
            .unwrap_err().contains("agent_session_unavailable"));
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
        let source = fixture.latest_run(&session).await;
        let step = facts(&fixture, &session).await.into_iter().find_map(|fact| match fact {
            Fact::ModelAttemptPrepared { step, .. } => Some(step),
            _ => None,
        }).expect("real provider request is prepared");
        let request_spec = fixture.owner.durable.request(source.run, step).await.unwrap();
        let frozen: Value = serde_json::from_slice(
            &fixture.owner.durable.content(source.run, request_spec.request).await.unwrap()
        ).unwrap();
        assert_eq!(frozen["itemAcceptance"], true,
            "the real provider must support accepted items before physical closure");
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
        assert!(approval_park(&fixture, &session).await.is_none());
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
        assert_eq!(facts(&fixture, &session).await.iter().filter(|fact| matches!(fact, Fact::RunAdmitted { .. })).count(), 1);
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
        let accepted_run = fixture.delivered_run(&accepted).await;
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
        let before_recovery = fixture.recorded_facts(&session).await;
        fixture.owner.durable.rebuild(fixture.latest_run(&session).await.run).await.unwrap();
        assert_eq!(fixture.recorded_facts(&session).await, before_recovery);
        eprintln!("approval fixture: startup recovery complete session={session}");
        let preserved = approval_park(&fixture, &session).await.unwrap();
        assert_eq!(preserved.view, checkpoint.view);
        assert_eq!(preserved.view.revision, checkpoint.view.revision);
        assert_eq!(fixture.owner.durable.interactions().read(&session, &approval.request_id).await.unwrap().unwrap().outcome, None);

        eprintln!("approval fixture: constructing fresh Host session={session}");
        let mut native = NativeRegistry::default();
        provide_all(&mut native, fixture.owner.durable.clone()).unwrap();
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
        assert_eq!(before.iter().filter(|event| matches!(event.recorded.fact, Fact::RunAdmitted { .. })).count(), 1);
        assert_eq!(before.iter().filter(|event| matches!(event.recorded.fact, Fact::ModelAttemptPrepared { .. })).count(), 1);
        assert!(!before.iter().any(|event| matches!(event.recorded.fact, Fact::RunTerminated { .. })));

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
        let store = fixture.owner.durable.clone();
        let mut commits = store.subscribe().unwrap();
        response(&mut socket).await;
        eprintln!("approval fixture: waiting original terminal session={session}: {}", diagnostic_state(&fixture, &session).await);
        eprintln!("approval fixture: waiting canonical terminal session={session}: {}", diagnostic_state(&fixture, &session).await);
        loop {
            if facts(&fixture, &session).await.iter().any(|fact| matches!(fact, Fact::RunTerminated { .. })) { break; }
            commits.changed().await.unwrap();
            eprintln!("approval fixture: terminal progress session={session}: {}", diagnostic_state(&fixture, &session).await);
        }
        eprintln!("approval fixture: canonical terminal confirmed session={session}");
        let events = stored_facts(&fixture, &session).await;
        assert_eq!(events.iter().filter(|event| matches!(event.recorded.fact, Fact::RunAdmitted { .. })).count(), 1);
        assert_eq!(events.iter().filter(|event| matches!(&event.recorded.fact,
            Fact::ModelObserved { attempt, part: ModelPart::ToolCall { call }, .. } if &(ToolKey { attempt: *attempt, call: call.id.clone() }) == &checkpoint.pending[0].tool)).count(), 1);
        let settled = events.iter().filter(|event| matches!(&event.recorded.fact,
            Fact::ToolResultAccepted { tool, .. } if tool == &checkpoint.pending[0].tool)).collect::<Vec<_>>();
        assert_eq!(settled.len(), 1);
        assert_eq!(settled[0].recorded.run, checkpoint.view.run);
        assert_eq!(settled[0].recorded.run.to_string(), accepted_run.to_string());
        assert!(matches!(settled[0].recorded.fact, Fact::ToolResultAccepted { outcome: AcceptedResult::Succeeded, .. }) != opaque_native_binding);
        assert_eq!(events.iter().filter(|event| matches!(event.recorded.fact, Fact::RunTerminated { .. })).count(), 1);
        assert!(approval_park(&fixture, &session).await.is_none());
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
    fact_id: Arc<StdMutex<Option<String>>>,
}
impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for RejectedPublication {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        #[derive(Default)]
        struct Fields {
            stage: Option<String>,
            fact_id: Option<String>,
        }
        impl tracing::field::Visit for Fields {
            fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
                match field.name() {
                    "stage" => self.stage = Some(value.into()),
                    "fact_id" => self.fact_id = Some(value.into()),
                    _ => {}
                }
            }
            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                self.record_str(field, &format!("{value:?}"));
            }
        }
        let mut fields = Fields::default();
        event.record(&mut fields);
        if fields.stage.as_deref() == Some("canonical_publication_unconfirmed") {
            *self.fact_id.lock().unwrap() = fields.fact_id;
            self.rejected.add_permits(1);
        }
    }
}

#[tokio::test]
async fn rejected_original_t2_retains_real_custody_and_retries_same_event_without_effect_replay() {
    use tracing_subscriber::prelude::*;

    tokio::time::timeout(Duration::from_secs(60), async {
        let rejected = Arc::new(Semaphore::new(0));
        let fact_id = Arc::new(StdMutex::new(None));
        let subscriber = tracing_subscriber::registry().with(RejectedPublication {
            rejected: rejected.clone(), fact_id: fact_id.clone(),
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
        raw.execute_batch("CREATE TRIGGER reject_native_t2 BEFORE INSERT ON agent_facts WHEN json_extract((SELECT payload FROM contents WHERE id=NEW.body_content_id), '$.fact.kind')='tool_result_accepted' BEGIN SELECT RAISE(ABORT, 'fixture original T2 unavailable'); END;").unwrap();
        fixture.mutation(2, "respond", json!({"sessionId":session,"requestId":approval.request_id,
            "answer":{"kind":"service_approval","decision":"allow"}}), Uuid::new_v4()).await.unwrap();
        rejected.acquire().await.unwrap().forget();
        let original_t2 = fact_id.lock().unwrap().clone().expect("failed exact original T2 identity");
        assert_eq!(counter.effects.load(Ordering::SeqCst), 3);
        assert_eq!(counter.entered.available_permits(), 1);
        let before = stored_facts(&fixture, &session).await;
        assert!(!before.iter().any(|event| matches!(event.recorded.fact, Fact::ToolResultAccepted { .. } | Fact::RunTerminated { .. })));
        {
            let runs = fixture.owner.runs.state().await;
            assert_eq!(runs.controls[&session].execution.run_id, checkpoint.view.run);
            assert!(!runs.closing);
            assert!(!runs.retained_cleanup.contains_key(&session));
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
        let settlements = events.iter().filter(|event| matches!(&event.recorded.fact,
            Fact::ToolResultAccepted { tool, .. } if tool == &checkpoint.pending[0].tool)).collect::<Vec<_>>();
        assert_eq!(settlements.len(), 1);
        assert_eq!(settlements[0].recorded.id.to_string(), original_t2);
        assert_eq!(events.iter().filter(|event| matches!(&event.recorded.fact,
            Fact::HostToolResultRecorded { tool, .. } if tool == &checkpoint.pending[0].tool)).count(), 1);
        assert_eq!(events.iter().filter(|event| matches!(&event.recorded.fact,
            Fact::ToolAdmitted { tool } if tool == &checkpoint.pending[0].tool)).count(), 1);
        assert_eq!(counter.effects.load(Ordering::SeqCst), 3);
        assert_eq!(counter.entered.available_permits(), 1);
        assert_eq!(events.iter().filter(|event| matches!(&event.recorded.fact,
            Fact::ModelObserved { attempt, part: ModelPart::ToolCall { call }, .. } if &(ToolKey { attempt: *attempt, call: call.id.clone() }) == &checkpoint.pending[0].tool)).count(), 1);
        assert_eq!(events.iter().filter(|event| matches!(event.recorded.fact, Fact::RunTerminated { .. })).count(), 1);
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
                .filter(|event| matches!(&event.recorded.fact,
            Fact::ToolResultAccepted { tool, outcome: AcceptedResult::Rejected, .. }
                if tool == &checkpoint.pending[0].tool))
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
                .filter(|event| matches!(event.recorded.fact, Fact::RunAdmitted { .. }))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event.recorded.fact,
                    Fact::RunTerminated {
                        terminal: Terminal::Completed,
                        ..
                    }
                ))
                .count(),
            1
        );
        assert!(approval_park(&fixture, &session).await.is_none());
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
        let store = fixture.owner.durable.clone();
        let mut commits = store.subscribe().unwrap();
        fixture
            .mutation(
                2,
                "respond",
                json!({"sessionId":session,"requestId":first.request_id,
            "answer":{"kind":"service_approval","decision":"allow"}}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        let remaining = loop {
            if let Some(checkpoint) = approval_park(&fixture, &session).await
                && checkpoint.view.revision != original.view.revision
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
            remaining.view.run,
            original.view.run
        );
        assert_ne!(remaining.pending[0].tool, first.tool);
        assert_eq!(counter.entered.available_permits(), 1);
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        let partial = stored_facts(&fixture, &session).await;
        assert_eq!(
            partial
                .iter()
                .filter(|event| matches!(&event.recorded.fact,
            Fact::ToolResultAccepted { tool, .. } if tool == &first.tool))
                .count(),
            1
        );
        assert_eq!(
            partial
                .iter()
                .filter(|event| matches!(event.recorded.fact, Fact::ToolResultAccepted { .. }))
                .count(),
            1
        );
        assert_eq!(
            partial
                .iter()
                .filter(|event| matches!(event.recorded.fact, Fact::ModelAttemptPrepared { .. }))
                .count(),
            1
        );
        assert!(
            !partial
                .iter()
                .any(|event| matches!(event.recorded.fact, Fact::RunTerminated { .. }))
        );
        assert!(
            store.interactions().read(&session, &remaining.pending[0].request_id)
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
                json!({"sessionId":session,"requestId":remaining.pending[0].request_id,
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
                .filter(|event| matches!(event.recorded.fact, Fact::RunAdmitted { .. }))
                .count(),
            1
        );
        for pending in &original.pending {
            assert_eq!(
                events
                    .iter()
                    .filter(|event| matches!(&event.recorded.fact,
                Fact::ModelObserved { attempt, part: ModelPart::ToolCall { call }, .. } if &(ToolKey { attempt: *attempt, call: call.id.clone() }) == &pending.tool))
                    .count(),
                1
            );
            let settled = events
                .iter()
                .filter(|event| {
                    matches!(&event.recorded.fact,
                Fact::ToolResultAccepted { tool, .. } if tool == &pending.tool)
                })
                .collect::<Vec<_>>();
            assert_eq!(settled.len(), 1);
            assert_eq!(settled[0].recorded.run, original.view.run);
        }
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event.recorded.fact, Fact::RunTerminated { .. }))
                .count(),
            1
        );
        assert!(
            approval_park(&fixture, &session).await
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
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            Some(setup),
        )
        .await;
        let session = fixture
            .create("Reject stale workspace action boundaries")
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
        let marker = fixture
            .workspace
            .join(maka_fs_tools::workspace::MARKER_FILE);
        let original_marker = std::fs::read(&marker).unwrap();
        std::fs::remove_file(&marker).unwrap();
        fixture
            .mutation(
                2,
                "respond",
                json!({"sessionId":session,"requestId":approval.request_id,
            "answer":{"kind":"service_approval","decision":"allow"}}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        let store = fixture.owner.durable.clone();
        let mut commits = store.subscribe().unwrap();
        eprintln!(
            "approval fixture: waiting canonical terminal session={session}: {}",
            diagnostic_state(&fixture, &session).await
        );
        loop {
            if facts(&fixture, &session)
                .await
                .iter()
                .any(|fact| matches!(fact, Fact::RunTerminated { .. }))
            {
                break;
            }
            commits.changed().await.unwrap();
            eprintln!(
                "approval fixture: terminal progress session={session}: {}",
                diagnostic_state(&fixture, &session).await
            );
        }
        eprintln!("approval fixture: canonical terminal confirmed session={session}");
        eprintln!("approval fixture: waiting worker drain session={session}");
        fixture.drained().await;
        eprintln!("approval fixture: worker drain confirmed session={session}");
        let events = stored_facts(&fixture, &session).await;
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        assert_eq!(counter.entered.available_permits(), 0);
        let failures = events
            .iter()
            .filter_map(|event| match &event.recorded.fact {
                Fact::ToolResultAccepted {
                    tool,
                    result,
                    outcome: AcceptedResult::Rejected,
                } if tool == &checkpoint.pending[0].tool => Some(result),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(failures.len(), 1);
        let failure = fixture
            .owner
            .durable
            .content(checkpoint.view.run, failures[0].clone())
            .await
            .unwrap();
        let maka_agent_facts::tool_output::AcceptedToolResult::Rejected { diagnostic } =
            serde_json::from_slice(&failure).unwrap()
        else {
            panic!("workspace validation must prevent the original effect");
        };
        assert!(diagnostic.contains("workspace_unavailable"));
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event.recorded.fact, Fact::ModelAttemptPrepared { .. }))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event.recorded.fact,
                    Fact::RunTerminated {
                        terminal: Terminal::Failed,
                        ..
                    }
                ))
                .count(),
            1
        );
        assert!(approval_park(&fixture, &session).await.is_none());
        std::fs::write(marker, original_marker).unwrap();
        eprintln!("approval fixture: waiting Host shutdown session={session}");
        fixture.app.shutdown().await.unwrap();
        eprintln!("approval fixture: Host shutdown complete session={session}");
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
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
        fixture.mutation(2, "respond", json!({"sessionId":session,"requestId":first.request_id,
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
        let store = fixture.owner.durable.clone();
        let remaining = approval_park(&fixture, &session).await.unwrap();
        assert_eq!(remaining.view.run, original.view.run);
        assert_eq!(remaining.pending.len(), 1);
        assert_ne!(remaining.pending[0].tool, first.tool);
        assert!(store.interactions().read(&session, &remaining.pending[0].request_id).await.unwrap().unwrap().outcome.is_none());
        let after_close = stored_facts(&fixture, &session).await;
        assert_eq!(after_close.iter().filter(|event| matches!(&event.recorded.fact,
            Fact::ToolResultAccepted { tool, .. } if tool == &first.tool)).count(), 1);
        assert_eq!(after_close.iter().filter(|event| matches!(event.recorded.fact, Fact::ModelAttemptPrepared { .. })).count(), 1);
        assert!(!after_close.iter().any(|event| matches!(event.recorded.fact, Fact::RunTerminated { .. })));
        eprintln!("approval fixture: waiting startup recovery session={session}");
        let before_recovery = fixture.recorded_facts(&session).await;
        fixture.owner.durable.rebuild(fixture.latest_run(&session).await.run).await.unwrap();
        assert_eq!(fixture.recorded_facts(&session).await, before_recovery);
        eprintln!("approval fixture: startup recovery complete session={session}");
        let recovered = approval_park(&fixture, &session).await.unwrap();
        assert_eq!(recovered.view.revision, remaining.view.revision);
        assert!(store.interactions().read(&session, &remaining.pending[0].request_id).await.unwrap().unwrap().outcome.is_none());

        eprintln!("approval fixture: constructing fresh Host session={session}");
        let mut native = NativeRegistry::default();
        provide_all(&mut native, fixture.owner.durable.clone()).unwrap();
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
        assert_eq!(pending["entries"][0]["requestId"], remaining.pending[0].request_id);
        fixture.mutation(2, "respond", json!({"sessionId":session,"requestId":remaining.pending[0].request_id,
            "answer":{"kind":"service_approval","decision":"allow"}}), Uuid::new_v4()).await.unwrap();
        let mut socket = next_model_socket(&listener, &fixture, &session).await;
        let prompt = request(&mut socket).await;
        assert_eq!(prompt["messages"].as_array().unwrap().iter().filter(|message| message["role"] == "tool").count(), 2);
        let mut commits = store.subscribe().unwrap();
        response(&mut socket).await;
        eprintln!("approval fixture: waiting original terminal session={session}: {}", diagnostic_state(&fixture, &session).await);
        eprintln!("approval fixture: waiting canonical terminal session={session}: {}", diagnostic_state(&fixture, &session).await);
        loop {
            if facts(&fixture, &session).await.iter().any(|fact| matches!(fact, Fact::RunTerminated { .. })) { break; }
            commits.changed().await.unwrap();
            eprintln!("approval fixture: terminal progress session={session}: {}", diagnostic_state(&fixture, &session).await);
        }
        eprintln!("approval fixture: canonical terminal confirmed session={session}");
        let events = stored_facts(&fixture, &session).await;
        assert_eq!(events.iter().filter(|event| matches!(event.recorded.fact, Fact::RunAdmitted { .. })).count(), 1);
        for pending in &original.pending {
            assert_eq!(events.iter().filter(|event| matches!(&event.recorded.fact,
                Fact::ModelObserved { attempt, part: ModelPart::ToolCall { call }, .. } if &(ToolKey { attempt: *attempt, call: call.id.clone() }) == &pending.tool)).count(), 1);
            let settled = events.iter().filter(|event| matches!(&event.recorded.fact,
                Fact::ToolResultAccepted { tool, .. } if tool == &pending.tool)).collect::<Vec<_>>();
            assert_eq!(settled.len(), 1);
            assert_eq!(settled[0].recorded.run, original.view.run);
        }
        let failure = events.iter().find_map(|event| match &event.recorded.fact {
            Fact::ToolResultAccepted { tool, result, outcome: AcceptedResult::Rejected }
                if tool == &remaining.pending[0].tool => Some(result.clone()),
            _ => None,
        }).expect("the stale original binding must settle as a failure");
        let failure = fixture.owner.durable.content(original.view.run, failure).await.unwrap();
        let maka_agent_facts::tool_output::AcceptedToolResult::Rejected { diagnostic } =
            serde_json::from_slice(&failure).unwrap() else {
                panic!("stale binding must prevent the original effect");
            };
        assert!(diagnostic.contains("stale"));
        assert_eq!(counter.entered.available_permits(), 0, "fresh opaque binding must not start another native call");
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        assert!(approval_park(&fixture, &session).await.is_none());
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
        let store = fixture.owner.durable.clone();
        let entered = Arc::new(Semaphore::new(0));
        let observed_stop = Arc::new(Semaphore::new(0));
        let (release, released) = std::sync::mpsc::channel::<()>();
        let (dropped, mut drop_notice) = tokio::sync::oneshot::channel();
        let preparation_shutdown = fixture.owner.stop.clone();
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
        *fixture.owner.continuation_preparation.lock().unwrap() = Some(continuation);
        fixture.mutation(2, "respond", json!({"sessionId":session,"requestId":approval.request_id,
            "answer":{"kind":"service_approval","decision":"allow"}}), Uuid::new_v4()).await.unwrap();
        entered.acquire().await.unwrap().forget();
        assert_eq!(counter.effects.load(Ordering::SeqCst), 1);
        let closing = fixture.owner.close();
        tokio::pin!(closing);
        tokio::select! {
            observed = observed_stop.acquire() => observed.unwrap().forget(),
            result = &mut closing => panic!("shutdown must retain physical preparation: {result:?}"),
        }
        assert!(matches!(drop_notice.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Empty)),
            "owner shutdown must not drop preparation while its blocking job remains physical");
        assert!(matches!(fixture.store.finish_session_retirement(&session).await,
            Err(maka_event_log::StoreError::SessionBusy)), "actual Work pin must remain until preparation joins");
        let before_release = stored_facts(&fixture, &session).await;
        assert_eq!(before_release.iter().filter(|event| matches!(event.recorded.fact, Fact::ModelAttemptPrepared { .. })).count(), 1);
        assert!(!before_release.iter().any(|event| matches!(event.recorded.fact, Fact::RunTerminated { .. })));
        release.send(()).unwrap();
        closing.await.unwrap();
        let remaining = store.frontier(checkpoint.view.run).await.unwrap();
        assert!(remaining.terminal.is_none(), "drained owner shutdown must retain the original model cursor");
        assert_eq!(remaining.run, checkpoint.view.run);
        assert!(drop_notice.try_recv().is_ok());
        assert_eq!(remaining.spec, checkpoint.view.spec);
        assert_eq!(remaining.current_attempt, checkpoint.view.current_attempt);
        assert!(store.interactions().pending(&session).await.unwrap().records.is_empty());
        let events = stored_facts(&fixture, &session).await;
        assert_eq!(events.iter().filter(|event| matches!(&event.recorded.fact,
            Fact::ToolResultAccepted { tool, .. } if tool == &checkpoint.pending[0].tool)).count(), 1);
        assert_eq!(events.iter().filter(|event| matches!(event.recorded.fact, Fact::ModelAttemptPrepared { .. })).count(), 1);
        assert!(!events.iter().any(|event| matches!(event.recorded.fact, Fact::RunTerminated { .. })));
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
        let accepted = checkpoint.view.spec.clone();
        let cancellation = CancellationToken::new();
        let current = fixture.owner.session(&session).await.unwrap();
        let scope = fixture.owner.current_work_scope(&session, &current.configuration).await.unwrap();
        let (lease, effects) = scope.accept(cancellation.clone());
        let claim = fixture.owner.durable.claim(checkpoint.view.run).await.unwrap();
        let access = fixture.owner.run_access(Arc::new(accepted.clone()), claim, &lease).unwrap();
        let original = access.live_configuration().await.unwrap();
        let (original_basis, _) = fixture.owner.restored_data(&checkpoint.view).await.unwrap();
        drop(access);
        effects.settle().await.unwrap();
        lease.finish();
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
        let current = fixture.owner.session(&session).await.unwrap();
        let scope = fixture.owner.current_work_scope(&session, &current.configuration).await.unwrap();
        let (lease, effects) = scope.accept(cancellation.clone());
        let claim = fixture.owner.durable.claim(checkpoint.view.run).await.unwrap();
        let access = fixture.owner.run_access(Arc::new(accepted.clone()), claim, &lease).unwrap();
        let resumed = access.live_configuration().await.unwrap();
        let (resumed_basis, _) = fixture.owner.restored_data(&checkpoint.view).await.unwrap();
        assert_eq!(resumed.permissions.access, WorkspaceAccess::ReadOnly);
        assert!(!resumed.permissions.request_permissions);
        assert_eq!(resumed.boundary_revision, boundary_revision);
        assert_eq!(resumed.binding, original.binding);
        assert_eq!(access.spec(), &accepted);
        assert_eq!(resumed_basis.binding, original_basis.binding);
        let floor = access.sandbox_floor(&maka_agent_facts::tool_call::ToolOrigin::Standalone).await.unwrap();
        let maka_sandbox::Sandbox::Managed { filesystem, .. } = floor else {
            panic!("read-only current ceiling must remain managed");
        };
        assert_eq!(filesystem.compile().unwrap().access(&fixture.workspace), maka_sandbox::filesystem::Access::Read);

        let mut replaced = accepted.clone();
        replaced.permission_basis.binding.id = Uuid::new_v4();
        let replaced = fixture.owner.run_access(Arc::new(replaced), access.claim().clone(), &lease).unwrap();
        assert!(matches!(replaced.live_configuration().await,
            Err(maka_agent_facts::tools::ToolError::Failed(reason)) if reason == "agent_run_spec_mismatch"));

        let mut retired = checkpoint.view.clone();
        retired.spec.trigger = maka_agent_facts::durable::Trigger::HistorySource;
        assert!(matches!(fixture.owner.restored_data(&retired).await,
            Err(error) if matches!(error.cause, RunError::InvalidInput(ref reason)
                if reason == "Historical source is not executable")));

        super::super::selection::edit(&fixture, |changes| changes.enabled = Some(false)).await;
        assert!(restored_model(&fixture, &checkpoint.view).await.capture().await.is_err());
        drop(replaced);
        drop(access);
        effects.settle().await.unwrap();
        lease.finish();
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
        let queued = fixture.send(&session).await.unwrap();
        let prime = fixture.delivered_run(&queued).await;
        let store = fixture.owner.durable.clone();
        let mut commits = store.subscribe().unwrap();
        let mut socket = next_model_socket(&listener, &fixture, &session).await;
        request(&mut socket).await;
        response(&mut socket).await;
        drop(socket);
        loop {
            if stored_facts(&fixture, &session).await.iter().any(|stored| {
                stored.recorded.run == prime
                    && matches!(stored.recorded.fact, Fact::RunTerminated { .. })
            }) {
                break;
            }
            commits.changed().await.unwrap();
        }
        fixture.drained().await;
        let held_admission = fixture.owner.runs.ordered(&session).await;
        let (invocation, request_fact_id): (RunId, FactId) =
            fixture.seed_due_model_retry(&session, prime).await;
        let seeded = store.frontier(invocation).await.unwrap();
        let seeded_request = store
            .request(invocation, seeded.current_step.unwrap())
            .await
            .unwrap();
        let seeded_provenance: Value = serde_json::from_slice(
            &store
                .content(invocation, seeded_request.provenance.clone())
                .await
                .unwrap(),
        )
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
        let preserved = store.frontier(invocation).await.unwrap();
        assert_eq!(preserved, seeded);
        assert_eq!(preserved.revision, seeded.revision);
        let before_recovery = fixture.recorded_facts(&session).await;
        store.rebuild(invocation).await.unwrap();
        assert_eq!(fixture.recorded_facts(&session).await, before_recovery);
        let recovered = store.frontier(invocation).await.unwrap();
        assert_eq!(recovered, seeded);
        assert_eq!(recovered.revision, seeded.revision);
        assert!(
            futures_util::FutureExt::now_or_never(listener.accept()).is_none(),
            "old Host must join without sending the seeded historical request"
        );

        let mut native = NativeRegistry::default();
        provide_all(&mut native, fixture.owner.durable.clone()).unwrap();
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
                !stored_facts(&fixture, &session).await.iter().any(|stored| {
                    stored.recorded.run == invocation
                        && matches!(stored.recorded.fact, Fact::RunTerminated { .. })
                }),
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
                stored.recorded.run == invocation
                    && matches!(stored.recorded.fact, Fact::RunTerminated { .. })
            }) {
                break;
            }
            commits.changed().await.unwrap();
        }
        fixture.app.shutdown().await.unwrap();
        let events: Vec<_> = stored_facts(&fixture, &session)
            .await
            .into_iter()
            .filter(|stored| stored.recorded.run == invocation)
            .collect();
        let requested: Vec<_> = events
            .iter()
            .filter(|stored| matches!(stored.recorded.fact, Fact::ModelAttemptPrepared { .. }))
            .collect();
        assert_eq!(
            requested.len(),
            2,
            "one historical request and exactly one resumed send"
        );
        assert_eq!(requested[0].recorded.id, request_fact_id);
        assert_ne!(requested[0].recorded.id, requested[1].recorded.id);
        let mut resumed = requested[1].recorded.fact.clone();
        let (original_step, resumed_step) = match (&requested[0].recorded.fact, &mut resumed) {
            (
                Fact::ModelAttemptPrepared {
                    attempt: original_attempt,
                    step: original_step,
                },
                Fact::ModelAttemptPrepared {
                    attempt: resumed_attempt,
                    step: resumed_step,
                },
            ) => {
                assert_ne!(*original_attempt, *resumed_attempt);
                assert_eq!(*original_step, *resumed_step);
                *resumed_attempt = *original_attempt;
                (*original_step, *resumed_step)
            }
            _ => unreachable!("both canonical attempts were selected above"),
        };
        let original_request = store.request(invocation, original_step).await.unwrap();
        let resumed_request = store.request(invocation, resumed_step).await.unwrap();
        let provenance: Value = serde_json::from_slice(
            &store
                .content(invocation, original_request.provenance.clone())
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(provenance["inputDigest"], seeded_provenance["inputDigest"]);
        assert_eq!(
            requested[0].recorded.fact, resumed,
            "frozen source, input and route evidence must be preserved"
        );
        assert_eq!(original_request.composition, resumed_request.composition);
        assert_eq!(original_request, seeded_request);
        assert_eq!(resumed_request, seeded_request);
        assert_eq!(events.iter().filter(|stored| matches!(
            &stored.recorded.fact,
            Fact::ModelInterrupted { attempt, .. } if Some(*attempt) == seeded.current_attempt
        )).count(), 1);
        assert_eq!(
            events
                .iter()
                .filter(|stored| matches!(
                    stored.recorded.fact,
                    Fact::ModelClosed {
                        outcome: maka_agent_facts::accounting::Outcome::Success,
                        ..
                    }
                ))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|stored| matches!(
                    stored.recorded.fact,
                    Fact::RunTerminated {
                        terminal: Terminal::Completed,
                        ..
                    }
                ))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|stored| matches!(stored.recorded.fact, Fact::RunTerminated { .. }))
                .count(),
            1
        );
        assert!(!events.iter().any(|stored| matches!(
            stored.recorded.fact,
            Fact::ModelObserved {
                part: ModelPart::ToolCall { .. },
                ..
            }
        )));
        let completed = store.frontier(invocation).await.unwrap();
        assert!(
            completed
                .waits
                .values()
                .all(|wait| { wait.satisfied.is_some() || wait.cancelled.is_some() })
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

#[tokio::test]
async fn closing_session_mcp_settles_parked_work_before_allowing_reconnect() {
    closing_session_mcp(McpClose::Reconnect).await;
}

#[tokio::test]
async fn shutdown_wakes_session_mcp_parked_wait() {
    closing_session_mcp(McpClose::Shutdown).await;
}

enum McpClose {
    Reconnect,
    Shutdown,
}

async fn closing_session_mcp(mode: McpClose) {
    tokio::time::timeout(Duration::from_secs(60), async {
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
        let shutdown = matches!(mode, McpClose::Shutdown);
        fixture
            .owner
            .mcp_shutdown_at_parked_wait
            .store(shutdown, Ordering::SeqCst);
        let session = fixture.create("Session MCP disconnect").await;
        let mut lease = fixture
            .app
            .client()
            .subscribe(
                fixture.binding(2).await,
                "sessionMcp".into(),
                json!({"sessionId":session,"servers":[]}),
                scope(&fixture.issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        assert_eq!(lease.recv().await.unwrap(), json!({"tools":[]}));
        fixture.send(&session).await.unwrap();
        let mut socket = next_model_socket(&listener, &fixture, &session).await;
        request(&mut socket).await;
        tool_response(&mut socket).await;
        let approval = pending_approval(&fixture, &session).await;
        let store = fixture.owner.durable.clone();
        let mut commits = store.subscribe().unwrap();
        let checkpoint = loop {
            if let Some(checkpoint) = approval_park(&fixture, &session).await {
                break checkpoint;
            }
            commits.changed().await.unwrap();
        };

        if shutdown {
            let closing = fixture.owner.clone();
            let (closed, ()) = tokio::join!(lease.completion(), async {
                closing.stop.cancelled().await;
                closing.close().await.unwrap();
            });
            closed.cleanup.unwrap();
            let remaining = fixture
                .owner
                .durable
                .frontier(checkpoint.view.run)
                .await
                .unwrap();
            assert!(
                !fixture.owner.mcp_projects.has_any_client(&session),
                "closing the original MCP generation must withdraw its live capability"
            );
            assert!(
                !remaining.stopped,
                "Host shutdown must not fabricate a durable Stop"
            );
            assert!(remaining.terminal.is_none());
            assert_eq!(remaining.run, checkpoint.view.run);
            let pending = store
                .interactions()
                .pending(&session)
                .await
                .unwrap()
                .records;
            assert_eq!(pending.len(), 1);
            assert_eq!(pending[0].request_id, approval.request_id);
            assert_eq!(pending[0].execution, approval.execution);
            assert!(pending[0].outcome.is_none());
            assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
            fixture.app.shutdown().await.unwrap();
            fixture.config.shutdown().await.unwrap();
            return;
        }

        lease.completion().await.cleanup.unwrap();
        let settlements = stored_facts(&fixture, &session)
            .await
            .into_iter()
            .filter(|event| {
                matches!(&event.recorded.fact, Fact::ToolResultAccepted { tool, .. }
                if tool == &checkpoint.pending[0].tool)
            })
            .count();
        assert_eq!(settlements, 1);
        assert!(approval_park(&fixture, &session).await.is_none());
        let late = fixture
            .mutation(
                2,
                "respond",
                json!({
                    "sessionId":session,"requestId":approval.request_id,
                    "answer":{"kind":"service_approval","decision":"allow"},
                }),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(late["record"]["outcome"]["kind"], "closure");
        assert_eq!(counter.effects.load(Ordering::SeqCst), 0);
        let mut replacement = fixture
            .app
            .client()
            .subscribe(
                fixture.binding(2).await,
                "sessionMcp".into(),
                json!({"sessionId":session,"servers":[]}),
                scope(&fixture.issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        assert_eq!(replacement.recv().await.unwrap(), json!({"tools":[]}));
        replacement.completion().await.cleanup.unwrap();
        fixture.drained().await;
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
