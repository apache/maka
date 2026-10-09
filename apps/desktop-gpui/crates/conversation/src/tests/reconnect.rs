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

//! Reconnects and reopens: a new connection always needs a new subscription,
//! and what the transcript knew before must not outlive it.

use super::*;

/// The open result of `subscription` from the Host `host_epoch`, whose root
/// Turn is `root`.
fn reopened(subscription: &str, host_epoch: &str, root: Value) -> Value {
    let mut open = open_result(subscription);
    open["hostEpoch"] = json!(host_epoch);
    open["snapshot"]["rootTurn"] = root;
    open["snapshot"]["queue"]["hostEpoch"] = json!(host_epoch);
    open
}

fn feed(harness: &Harness, event: ConnectionEvent, cx: &mut TestAppContext) {
    harness.host.update(cx, |host, cx| host.handle_host_event(HostEvent::Connection(event), cx));
    settle(cx);
}

/// A frame of `subscription` from the Host `host_epoch` with `sequence`.
fn frame_of(
    subscription: &str,
    host_epoch: &str,
    sequence: u64,
    kind: &str,
    body: Value,
) -> PushFrame {
    let mut value = json!({
        "kind": kind, "hostEpoch": host_epoch, "subscriptionId": subscription,
        "sequence": sequence
    });
    for (key, field) in body.as_object().expect("object") {
        value[key] = field.clone();
    }
    frame(value)
}

/// Adversarial review 2026-09-26: a connection lost mid-turn and replaced by
/// one to a restarted Host (a new epoch) reopens the subscription on the new
/// connection and sends `ready` for it; a frame of the old subscription that
/// is still queued when the new one is live changes nothing, and the new
/// subscription's frames apply.
#[gpui_kit::test]
fn a_new_host_epoch_reopens_and_the_old_subscriptions_frames_are_ignored(cx: &mut TestAppContext) {
    let (harness, mut frames) = start_turn(cx);
    feed(&harness, ConnectionEvent::Disconnected { reason: "closed".into() }, cx);
    assert_eq!(harness.phase(cx), ConversationPhase::WaitingForHost);
    assert!(
        harness.transport.requests("subscription.close").is_empty(),
        "nothing to close on a connection that is gone"
    );
    assert!(!harness.rows(cx).is_empty(), "the last transcript stays visible");

    harness.transport.reply("subscription.open", Ok(reopened("sub-2", "epoch-2", root("running"))));
    feed(
        &harness,
        ConnectionEvent::HostEpochChanged { previous: EPOCH.into(), current: "epoch-2".into() },
        cx,
    );
    feed(&harness, ConnectionEvent::Connected { accepted: accepted("epoch-2") }, cx);
    assert_eq!(harness.phase(cx), ConversationPhase::Live);
    assert_eq!(harness.transport.requests("subscription.open").len(), 2);
    assert_eq!(
        harness.transport.requests("subscription.ready").last(),
        Some(&json!({"subscriptionId": "sub-2"}))
    );

    // A frame the old connection delivered late, in sequence for the old
    // subscription.
    harness.push(frames.projection(root("cancelled"), vec![]), cx);
    settle(cx);
    assert_eq!(harness.transport.requests("subscription.open").len(), 2, "no reopen");
    harness.state.read_with(cx, |state, _| {
        assert_eq!(state.transcript().map(|t| t.subscription_id()), Some("sub-2"));
        assert_eq!(state.turn_activity(), TurnActivity::Running, "the old frame is ignored");
    });

    let mut cancelled = snapshot(2, root("cancelled"), vec![]);
    cancelled["queue"]["hostEpoch"] = json!("epoch-2");
    harness.push(
        frame_of(
            "sub-2",
            "epoch-2",
            1,
            "subscription.session_projection",
            json!({"snapshot": cancelled}),
        ),
        cx,
    );
    settle(cx);
    harness.state.read_with(cx, |state, _| {
        assert_eq!(
            state.turn_activity(),
            TurnActivity::Idle,
            "the new subscription's frame applies"
        );
    });
}

/// Adversarial review 2026-09-26: a message that started turn `t1` keeps the
/// session `Starting` until a root Turn named `t1` shows up
/// (`forget_seen_turn`). When the connection drops before any frame shows
/// `t1`, and by the reopen the Host's root Turn has moved on (the follow-up
/// queued behind `t1` ran as `t2`), no root Turn ever names `t1` again: on
/// an idle session the round button stays busy and disabled and the model
/// picker stays locked until another message starts a turn or the session is
/// switched. A reopen now clears the started turn when the root Turn is a
/// newer one or the session is idle.
#[gpui_kit::test]
fn a_started_turn_the_reopen_never_shows_does_not_leave_the_session_starting(
    cx: &mut TestAppContext,
) {
    let harness = open_composer(cx);
    harness.transport.reply(
        "turn.message.submit",
        Ok(json!({"disposition": "turn_started", "turnId": TURN,
                  "skillInvocation": {"loaded": [], "failed": [], "receipts": []}})),
    );
    let sent = harness.state.update(cx, |state, cx| {
        state.send_message(SESSION, MessageContent::text("first"), MessagePlacement::NextTurn, cx)
    });
    assert_eq!(cx.foreground_executor().block_test(sent), Ok(SendOutcome::Started));
    harness
        .state
        .read_with(cx, |state, _| assert_eq!(state.turn_activity(), TurnActivity::Starting));

    // The connection drops before a frame shows `t1`; `t1` and then the
    // follow-up `t2` run to the end meanwhile.
    feed(&harness, ConnectionEvent::Disconnected { reason: "closed".into() }, cx);
    let mut later = root("completed");
    later["turnId"] = json!("t2");
    later["runId"] = json!("run-2");
    harness.transport.reply("subscription.open", Ok(reopened("sub-2", EPOCH, later)));
    feed(&harness, ConnectionEvent::Connected { accepted: accepted(EPOCH) }, cx);
    assert_eq!(harness.phase(cx), ConversationPhase::Live);

    harness.state.read_with(cx, |state, _| {
        assert_eq!(state.turn_activity(), TurnActivity::Idle, "nothing runs on the Host");
    });
    assert_eq!(
        harness.action(cx),
        ComposerAction::Send { enabled: false, busy: false, queues: false }
    );
    assert!(harness.composer().read_with(cx, |composer, cx| composer.model_switchable(cx)));
}

/// A session showing a finished turn `t0` whose message starts `t2`.
fn started_after_a_finished_turn(cx: &mut TestAppContext) -> Harness {
    let transport = Arc::new(ScriptedHost::default());
    let mut finished = root("completed");
    finished["turnId"] = json!("t0");
    transport.reply("subscription.open", Ok(reopened(SUBSCRIPTION, EPOCH, finished)));
    let harness = Harness::open(transport, EPOCH, cx);
    harness.select(SESSION, cx);
    harness.transport.reply(
        "turn.message.submit",
        Ok(json!({"disposition": "turn_started", "turnId": "t2",
                  "skillInvocation": {"loaded": [], "failed": [], "receipts": []}})),
    );
    harness
}

fn finished_t0() -> Value {
    let mut finished = root("completed");
    finished["turnId"] = json!("t0");
    finished
}

/// A reopen issued after the start whose snapshot shows the session idle,
/// with the same finished root Turn as before the start (the started turn
/// ended without ever becoming the root, as far as this client saw), leaves
/// the session idle rather than Starting.
#[gpui_kit::test]
fn a_reopen_issued_after_the_start_that_shows_the_session_idle_clears_the_started_turn(
    cx: &mut TestAppContext,
) {
    let harness = started_after_a_finished_turn(cx);
    let sent = harness.state.update(cx, |state, cx| {
        state.send_message(SESSION, MessageContent::text("next"), MessagePlacement::NextTurn, cx)
    });
    assert_eq!(cx.foreground_executor().block_test(sent), Ok(SendOutcome::Started));
    harness
        .state
        .read_with(cx, |state, _| assert_eq!(state.turn_activity(), TurnActivity::Starting));

    feed(&harness, ConnectionEvent::Disconnected { reason: "closed".into() }, cx);
    harness.transport.reply("subscription.open", Ok(reopened("sub-2", EPOCH, finished_t0())));
    feed(&harness, ConnectionEvent::Connected { accepted: accepted(EPOCH) }, cx);
    assert_eq!(harness.phase(cx), ConversationPhase::Live);
    harness.state.read_with(cx, |state, _| assert_eq!(state.turn_activity(), TurnActivity::Idle));
}

/// An open already in flight when the start is recorded may carry a
/// snapshot from before the start: its idle root Turn says nothing about the
/// started turn, which stays Starting until a frame shows it.
#[gpui_kit::test]
fn an_open_issued_before_the_start_does_not_clear_the_started_turn(cx: &mut TestAppContext) {
    let harness = started_after_a_finished_turn(cx);
    let submit = {
        // Replace the scripted answer with one the test releases.
        harness.transport.replies.lock().expect("replies").remove("turn.message.submit");
        harness.transport.hold("turn.message.submit")
    };
    let sent = harness.state.update(cx, |state, cx| {
        state.send_message(SESSION, MessageContent::text("next"), MessagePlacement::NextTurn, cx)
    });
    // A gap reopens while the submit is in flight.
    let open = harness.transport.hold("subscription.open");
    harness.push(
        frame_of(
            SUBSCRIPTION,
            EPOCH,
            5,
            "subscription.session_projection",
            json!({
                "snapshot": snapshot(2, finished_t0(), vec![])
            }),
        ),
        cx,
    );
    settle(cx);
    assert_eq!(harness.phase(cx), ConversationPhase::Opening);
    submit
        .try_send(Ok(json!({"disposition": "turn_started", "turnId": "t2",
                            "skillInvocation": {"loaded": [], "failed": [], "receipts": []}})))
        .expect("release the submit");
    assert_eq!(cx.foreground_executor().block_test(sent), Ok(SendOutcome::Started));
    open.try_send(Ok(reopened("sub-2", EPOCH, finished_t0()))).expect("release the open");
    settle(cx);
    assert_eq!(harness.phase(cx), ConversationPhase::Live);
    harness
        .state
        .read_with(cx, |state, _| assert_eq!(state.turn_activity(), TurnActivity::Starting));

    let mut started = root("running");
    started["turnId"] = json!("t2");
    harness.push(
        frame_of(
            "sub-2",
            EPOCH,
            1,
            "subscription.session_projection",
            json!({
                "snapshot": snapshot(2, started, vec![])
            }),
        ),
        cx,
    );
    settle(cx);
    harness
        .state
        .read_with(cx, |state, _| assert_eq!(state.turn_activity(), TurnActivity::Running));
}

/// Adversarial review 2026-09-26: every `Change::NeedsReopen` reopens at
/// once, whatever its reason. After `ready` the Host resends an open
/// assistant stream from offset 0, so a delta this client cannot decode fails
/// again on every new subscription, and the conversation reopens in a loop
/// with no delay between opens and no point at which it gives up. The Desktop
/// re-establishes only after `sequence_gap`, `projection_revision_invalid`,
/// and `slow_consumer` (`isRecoverableSubscriptionFailure` in
/// apps/desktop/src/main/runtime-host-session-subscription-owner.ts) and
/// treats a malformed frame as terminal. Reopens now back off, and stop
/// after a limit (see the next test).
#[gpui_kit::test]
fn a_failure_that_recurs_after_every_reopen_does_not_reopen_in_a_tight_loop(
    cx: &mut TestAppContext,
) {
    const ROUNDS: usize = 5;
    let transport = Arc::new(ScriptedHost::default());
    for n in 0..=ROUNDS {
        transport.reply("subscription.open", Ok(open_result(&format!("sub-{n}"))));
    }
    let harness = Harness::open(transport, EPOCH, cx);
    harness.select(SESSION, cx);
    for n in 0..ROUNDS {
        // The open stream, resent from offset 0 after `ready`, in a delta
        // this client cannot decode.
        harness.push(
            frame_of(
                &format!("sub-{n}"),
                EPOCH,
                1,
                "subscription.session_delta",
                json!({"sessionId": SESSION, "delta": {
                    "kind": "text", "turnId": TURN, "runId": RUN, "messageId": "m1",
                    "startOffset": "zero", "text": "Hello"
                }}),
            ),
            cx,
        );
    }
    // No time has passed on the executor's clock.
    let opens = harness.transport.requests("subscription.open").len();
    assert!(
        opens <= 2,
        "{opens} subscription.open requests in no time for one failure that keeps recurring \
         (phase {:?})",
        harness.phase(cx)
    );
}

/// Adversarial review 2026-09-26: once the Host has closed a subscription
/// (`slow_consumer`, the likeliest while this client lags), a
/// `session.transcript.page` read for it answers `not_found`
/// (`#readTranscriptPage` in
/// packages/runtime-host/src/server/session-continuity-coordinator.ts). The
/// read's answer takes the direct request path while the `subscription.closed`
/// frame queued before it takes the push path, so the answer is usually
/// applied first. `finish_page` fails the conversation on it, and the closed
/// frame that follows is dropped because the phase is no longer `Live`: the
/// person must press Retry. The Desktop re-establishes on exactly this error
/// (`isRecoverableSubscriptionFailure`), and older history here reopens on
/// it too (`finish_older`). It now reopens, and the closed frame is dropped.
#[gpui_kit::test]
fn a_catch_up_read_of_a_subscription_the_host_closed_reopens(cx: &mut TestAppContext) {
    let (harness, mut frames) = start_turn(cx);
    harness.transport.reply(
        "session.transcript.page",
        Err(HostRequestError::Operation {
            operation: "session.transcript.page",
            code: host_protocol::HostOperationErrorCode::NotFound,
            message: "Session subscription was not found".into(),
        }),
    );
    harness.transport.reply("subscription.open", Ok(open_result("sub-2")));
    harness.push(frames.advanced(40), cx);
    harness.push(frames.next("subscription.closed", json!({"reason": "slow_consumer"})), cx);
    settle(cx);
    assert_eq!(harness.phase(cx), ConversationPhase::Live, "reopened, not failed");
    harness.state.read_with(cx, |state, _| {
        assert_eq!(state.transcript().map(|t| t.subscription_id()), Some("sub-2"));
    });
    cx.executor().advance_clock(Duration::from_secs(10));
    settle(cx);
    assert_eq!(
        harness.transport.requests("subscription.open").len(),
        2,
        "the closed frame that followed the answer reopens nothing more"
    );
    assert_eq!(
        harness.transport.requests("subscription.close"),
        [json!({"subscriptionId": SUBSCRIPTION})]
    );
}

/// A delta of `subscription` this client cannot decode.
fn undecodable_delta(subscription: &str, sequence: u64) -> PushFrame {
    frame_of(
        subscription,
        EPOCH,
        sequence,
        "subscription.session_delta",
        json!({"sessionId": SESSION, "delta": {
            "kind": "text", "turnId": TURN, "runId": RUN, "messageId": "m1",
            "startOffset": "zero", "text": "Hello"
        }}),
    )
}

/// Consecutive failures reopen after 250 ms, doubling up to 5 s; a frame
/// applied in between starts the count over; the eighth consecutive failure
/// stops reopening and offers Retry, which opens at once.
#[gpui_kit::test]
fn reopens_back_off_start_over_after_a_good_frame_and_stop_at_the_limit(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    for n in 0..12 {
        transport.reply("subscription.open", Ok(open_result(&format!("sub-{n}"))));
    }
    let harness = Harness::open(transport, EPOCH, cx);
    harness.select(SESSION, cx);
    let opens = |cx: &mut TestAppContext| {
        cx.run_until_parked();
        harness.transport.requests("subscription.open").len()
    };
    let millis = Duration::from_millis;
    // Fails the current subscription `sub-{n}` at `sequence`, then checks
    // that the reopen waits exactly `delay`.
    let fail_and_wait = |n: usize, sequence: u64, delay: Duration, cx: &mut TestAppContext| {
        let before = opens(cx);
        harness.push(undecodable_delta(&format!("sub-{n}"), sequence), cx);
        assert_eq!(harness.phase(cx), ConversationPhase::Opening);
        cx.executor().advance_clock(delay - millis(1));
        assert_eq!(opens(cx), before, "no reopen before {delay:?}");
        cx.executor().advance_clock(millis(1));
        assert_eq!(opens(cx), before + 1, "a reopen after {delay:?}");
        assert_eq!(harness.phase(cx), ConversationPhase::Live);
    };
    assert_eq!(opens(cx), 1);

    fail_and_wait(0, 1, millis(250), cx);
    fail_and_wait(1, 1, millis(500), cx);
    // A frame of sub-2 applies: the next failure is a first one again.
    harness.push(
        frame_of(
            "sub-2",
            EPOCH,
            1,
            "subscription.session_projection",
            json!({
                "snapshot": snapshot(2, root("running"), vec![])
            }),
        ),
        cx,
    );
    fail_and_wait(2, 2, millis(250), cx);
    for (n, delay) in [(3, 500), (4, 1000), (5, 2000), (6, 4000), (7, 5000), (8, 5000)] {
        fail_and_wait(n, 1, millis(delay), cx);
    }
    // sub-2 through sub-8 failed seven times in a row; the eighth gives up.
    let before = opens(cx);
    harness.push(undecodable_delta("sub-9", 1), cx);
    let ConversationPhase::Failed(message) = harness.phase(cx) else {
        panic!("failed with Retry, not {:?}", harness.phase(cx));
    };
    assert!(message.starts_with(copy::OPEN_FAILED.en()), "{message}");
    cx.executor().advance_clock(Duration::from_secs(60));
    assert_eq!(opens(cx), before, "no reopen after giving up");

    harness.state.update(cx, |state, cx| state.retry(cx));
    assert_eq!(opens(cx), before + 1, "Retry opens at once");
    assert_eq!(harness.phase(cx), ConversationPhase::Live);
    fail_and_wait(10, 1, millis(250), cx);
}

/// The other order: the `subscription.closed` frame arrives before the
/// catch-up read answers. The frame reopens, and the answer, which belongs
/// to the closed subscription, changes nothing.
#[gpui_kit::test]
fn a_closed_frame_before_the_catch_up_answer_reopens_once(cx: &mut TestAppContext) {
    let (harness, mut frames) = start_turn(cx);
    let page = harness.transport.hold("session.transcript.page");
    harness.transport.reply("subscription.open", Ok(open_result("sub-2")));
    harness.push(frames.advanced(40), cx);
    harness.push(frames.next("subscription.closed", json!({"reason": "slow_consumer"})), cx);
    page.try_send(Err(HostRequestError::Operation {
        operation: "session.transcript.page",
        code: host_protocol::HostOperationErrorCode::NotFound,
        message: "Session subscription was not found".into(),
    }))
    .ok();
    settle(cx);
    cx.executor().advance_clock(Duration::from_secs(10));
    settle(cx);
    assert_eq!(harness.phase(cx), ConversationPhase::Live);
    assert_eq!(harness.transport.requests("subscription.open").len(), 2);
    harness.state.read_with(cx, |state, _| {
        assert_eq!(state.transcript().map(|t| t.subscription_id()), Some("sub-2"));
    });
}

#[gpui_kit::test]
fn offline_with_no_task_the_composer_keeps_its_controls_disabled(cx: &mut TestAppContext) {
    let disabled_controls = |harness: &Harness, model: &str, cx: &mut TestAppContext| {
        harness.with_window(cx, |window, cx| {
            for id in ["composer-attach", "composer-model", "composer-permission-mode"] {
                assert!(window.find(id).visible(), "{id}");
            }
            assert_eq!(window.find("composer-model").label(), Some(model));
            assert_eq!(
                window.find("composer-permission-mode").label(),
                Some("Permission mode: Auto"),
                "the mode a new task starts in"
            );
            // Both pickers are disabled: neither opens its menu.
            window.click("composer-model", cx);
            window.click("composer-permission-mode", cx);
        });
        harness.with_window(cx, |window, _| assert!(window.try_find("popup-menu").is_none()));
    };

    // No task has shown a model yet: the chip says "Model".
    let transport = Arc::new(ScriptedHost::default());
    let harness = Harness::open_with_composer(transport, EPOCH, cx);
    feed(&harness, ConnectionEvent::Disconnected { reason: "closed".into() }, cx);
    disabled_controls(&harness, copy::MODEL.en(), cx);

    // After a task, the chip keeps the model it last showed.
    let harness = open_composer(cx);
    harness.state.update(cx, |state, cx| state.select_session(None, cx));
    feed(&harness, ConnectionEvent::Disconnected { reason: "closed".into() }, cx);
    disabled_controls(&harness, "Model: glm-5.3", cx);
}
