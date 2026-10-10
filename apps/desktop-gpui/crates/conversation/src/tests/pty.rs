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

//! The terminal seam: PTY interest on the session's subscription, and the
//! frames the terminal owner receives instead of the transcript.

use std::cell::RefCell;
use std::rc::Rc;

use host_client::ConnectionEvent;

use super::*;
use crate::SessionPtyEvent;

/// What the state emitted for terminals, in order, as short labels.
fn record(harness: &Harness, cx: &mut TestAppContext) -> Rc<RefCell<Vec<String>>> {
    let events = Rc::new(RefCell::new(Vec::new()));
    let sink = events.clone();
    cx.update(|cx| {
        cx.subscribe(&harness.state, move |_, event: &SessionPtyEvent, _| {
            sink.borrow_mut().push(match event {
                SessionPtyEvent::InterestSet { subscription_id, refs, .. } => {
                    format!("set {subscription_id} {}", refs.join(","))
                }
                SessionPtyEvent::InterestLost { session_id } => format!("lost {session_id}"),
                SessionPtyEvent::InterestFailed { message, .. } => format!("failed {message}"),
                SessionPtyEvent::Data(frame) => {
                    format!("data {} {} {:?}", frame.resource_ref, frame.pty_sequence, frame.data)
                }
                SessionPtyEvent::ResourcesChanged { changes, .. } => format!(
                    "changed {}",
                    changes
                        .iter()
                        .map(|change| change.resource_ref.as_str())
                        .collect::<Vec<_>>()
                        .join(",")
                ),
            });
        })
        .detach();
    });
    events
}

/// A transport whose `subscription.pty_interest.set` succeeds.
fn transport() -> Arc<ScriptedHost> {
    let transport = Arc::new(ScriptedHost::default());
    transport.respond_with(|operation, input| {
        (operation == "subscription.pty_interest.set")
            .then(|| Ok(json!({"subscriptionId": input["subscriptionId"]})))
    });
    transport
}

fn pty_data(subscription: &str, sequence: u64, data: &str) -> PushFrame {
    frame(json!({
        "kind": "subscription.runtime_resource_pty_data", "hostEpoch": EPOCH,
        "subscriptionId": subscription, "sessionId": SESSION, "ref": "r1",
        "ptySequence": sequence, "data": data
    }))
}

#[gpui_kit::test]
fn interest_waits_for_ready_and_is_set_again_after_every_open(cx: &mut TestAppContext) {
    let transport = transport();
    let ready = transport.hold("subscription.ready");
    transport.reply("subscription.open", Ok(open_result(SUBSCRIPTION)));
    transport.reply("subscription.open", Ok(open_result("sub-2")));
    let harness = Harness::open(transport.clone(), EPOCH, cx);
    let events = record(&harness, cx);
    harness.select(SESSION, cx);
    harness.state.update(cx, |state, cx| state.set_pty_interest(vec!["r1".into()], cx));
    settle(cx);
    assert!(transport.requests("subscription.pty_interest.set").is_empty(), "not before ready");

    ready.try_send(Ok(json!({"subscriptionId": SUBSCRIPTION}))).expect("ready");
    settle(cx);
    assert_eq!(
        transport.requests("subscription.pty_interest.set"),
        [json!({"subscriptionId": SUBSCRIPTION, "refs": ["r1"]})]
    );
    assert_eq!(*events.borrow(), ["set sub-1 r1"]);

    // A new connection: the old subscription and its interest are gone, and
    // the new one gets the same set once it is ready.
    harness.host.update(cx, |host, cx| {
        host.handle_host_event(
            HostEvent::Connection(ConnectionEvent::Connected { accepted: accepted(EPOCH) }),
            cx,
        )
    });
    settle(cx);
    assert_eq!(
        transport.requests("subscription.pty_interest.set").last(),
        Some(&json!({"subscriptionId": "sub-2", "refs": ["r1"]}))
    );
    assert_eq!(*events.borrow(), ["set sub-1 r1", "lost s1", "set sub-2 r1"]);

    // An empty set stops the output; the same set again sends nothing.
    harness.state.update(cx, |state, cx| state.set_pty_interest(Vec::new(), cx));
    harness.state.update(cx, |state, cx| state.set_pty_interest(Vec::new(), cx));
    settle(cx);
    assert_eq!(transport.requests("subscription.pty_interest.set").len(), 3);
    assert_eq!(events.borrow().last().map(String::as_str), Some("set sub-2 "));
}

#[gpui_kit::test]
fn terminal_frames_reach_the_owner_and_domain_changes_keep_their_sequence(cx: &mut TestAppContext) {
    let transport = transport();
    transport.reply("subscription.open", Ok(open_result(SUBSCRIPTION)));
    let harness = Harness::open(transport.clone(), EPOCH, cx);
    let events = record(&harness, cx);
    harness.select(SESSION, cx);

    harness.push(pty_data(SUBSCRIPTION, 1, "hi\r\n"), cx);
    // Output of a subscription that is not the current one is not handed on.
    harness.push(pty_data("sub-old", 2, "stale"), cx);
    harness.push(
        frame(json!({
            "kind": "subscription.session_domain_changed", "hostEpoch": EPOCH,
            "subscriptionId": SUBSCRIPTION, "sequence": 1, "sessionId": SESSION,
            "domain": "runtime_resource",
            "resources": [{"sourceSessionId": SESSION, "ref": "r1"},
                          {"sourceSessionId": "other", "ref": "r9"}]
        })),
        cx,
    );
    // The transcript counted the domain change: the next sequence applies.
    harness.push(
        frame(json!({
            "kind": "subscription.session_domain_changed", "hostEpoch": EPOCH,
            "subscriptionId": SUBSCRIPTION, "sequence": 2, "sessionId": SESSION,
            "domain": "usage"
        })),
        cx,
    );
    settle(cx);
    assert_eq!(*events.borrow(), ["data r1 1 \"hi\\r\\n\"", "changed r1,r9"]);
    assert_eq!(transport.requests("subscription.open").len(), 1, "no reopen");
    assert_eq!(harness.phase(cx), ConversationPhase::Live);
}

#[gpui_kit::test]
fn another_session_starts_without_the_previous_interest(cx: &mut TestAppContext) {
    let transport = transport();
    transport.reply("subscription.open", Ok(open_result(SUBSCRIPTION)));
    transport.reply("subscription.open", Ok(open_result_for("s2", "sub-2")));
    let harness = Harness::open(transport.clone(), EPOCH, cx);
    let events = record(&harness, cx);
    harness.select(SESSION, cx);
    harness.state.update(cx, |state, cx| state.set_pty_interest(vec!["r1".into()], cx));
    settle(cx);
    harness.select("s2", cx);
    settle(cx);
    assert_eq!(transport.requests("subscription.pty_interest.set").len(), 1);
    assert_eq!(*events.borrow(), ["set sub-1 r1", "lost s1"]);
}
