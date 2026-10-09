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

//! The message queue: messages sent while a turn runs go through
//! `turn.message.submit`, and the queued ones show above the composer with
//! their `queue.*` commands.

use super::*;

use crate::queue_entry_element_id;

fn entry(id: &str, text: &str, placement: &str, state: &str) -> Value {
    json!({"entryId": id, "messageId": format!("m-{id}"), "content": {"text": text},
           "placement": placement, "state": state})
}

/// A projection of the running turn with `steering` and `followup` queued at
/// queue revision `revision`.
fn queued(
    frames: &mut Frames,
    revision: u64,
    steering: Vec<Value>,
    followup: Vec<Value>,
) -> PushFrame {
    frames.revision += 1;
    let mut snapshot = snapshot(frames.revision, root("running"), vec![]);
    snapshot["queue"] = json!({"hostEpoch": EPOCH, "queueRevision": revision,
                               "steering": steering, "followup": followup});
    frames.next("subscription.session_projection", json!({"snapshot": snapshot}))
}

/// The composer over a running turn.
fn running(cx: &mut TestAppContext) -> (Harness, Frames) {
    let harness = open_composer(cx);
    let frames = run_turn(&harness, Frames::new(), cx);
    (harness, frames)
}

fn mutation(revision: u64) -> Reply {
    Ok(json!({"queueRevision": revision}))
}

#[gpui_kit::test]
fn a_message_sent_mid_turn_is_queued_and_cmd_enter_steers(cx: &mut TestAppContext) {
    let (harness, _) = running(cx);
    let skills = json!({"loaded": [], "failed": [], "receipts": []});
    harness.transport.reply(
        "turn.message.submit",
        Ok(json!({"disposition": "followup", "queueRevision": 1, "skillInvocation": skills})),
    );
    harness.transport.reply(
        "turn.message.submit",
        Ok(json!({"disposition": "steering", "queueRevision": 2, "skillInvocation": skills})),
    );
    fill(&harness, "after this", cx);
    assert_eq!(
        harness.action(cx),
        ComposerAction::Send { enabled: true, busy: false, queues: true }
    );
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find("send-message").label(), Some(copy::SEND_QUEUED.en()));
        window.press("enter", cx);
    });
    settle(cx);
    fill(&harness, "change course", cx);
    harness.with_window(cx, |window, cx| window.press("secondary-enter", cx));
    settle(cx);
    let placements: Vec<(Value, Value)> = harness
        .transport
        .requests("turn.message.submit")
        .into_iter()
        .map(|input| (input["content"]["text"].clone(), input["placement"].clone()))
        .collect();
    assert_eq!(
        placements,
        [
            (json!("after this"), json!("next_turn")),
            (json!("change course"), json!("current_turn"))
        ]
    );
    harness.composer().read_with(cx, |composer, cx| {
        assert_eq!(composer.draft().read(cx).value().as_ref(), "", "both were accepted");
    });
}

#[gpui_kit::test]
fn queued_messages_show_above_the_composer_with_their_commands(cx: &mut TestAppContext) {
    let (harness, mut frames) = running(cx);
    harness.with_window(cx, |window, _| {
        assert!(window.try_find(queue_entry_element_id("q1")).is_none(), "an empty queue hides");
    });
    harness.push(
        queued(
            &mut frames,
            4,
            vec![entry("q0", "Look at the tests too", "current_turn", "in_flight")],
            vec![
                entry("q1", "Then write the summary", "next_turn", "queued"),
                entry("q2", "And open a PR", "next_turn", "queued"),
            ],
        ),
        cx,
    );
    settle(cx);
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("message-queue").label(), Some("3 queued messages"));
        let taken = window.within(queue_entry_element_id("q0"));
        assert!(taken.try_find("queue-edit").is_none(), "a steering message on its way is fixed");
        assert_eq!(
            window.find(queue_entry_element_id("q1")).label(),
            Some("Then write the summary")
        );
    });

    // Send now: the follow-up steers the running turn.
    harness.transport.reply("queue.entry.promote", mutation(5));
    harness.with_window(cx, |window, cx| {
        window.within(queue_entry_element_id("q1")).click("queue-promote", cx);
    });
    settle(cx);
    let promote = &harness.transport.requests("queue.entry.promote")[0];
    assert_eq!((&promote["entryId"], &promote["originHostEpoch"]), (&json!("q1"), &json!(EPOCH)));
    assert_eq!(promote["sessionId"], SESSION);

    // Edit in place: Enter saves at the revision the edit started from.
    harness.transport.reply("queue.entry.update", mutation(6));
    harness.with_window(cx, |window, cx| {
        window.within(queue_entry_element_id("q2")).click("queue-edit", cx);
    });
    harness.with_window(cx, |window, cx| {
        window.press("secondary-a", cx);
        window.input("And open a draft PR", cx);
        window.press("enter", cx);
    });
    settle(cx);
    let update = &harness.transport.requests("queue.entry.update")[0];
    assert_eq!(
        (&update["entryId"], &update["expectedQueueRevision"], &update["text"]),
        (&json!("q2"), &json!(4), &json!("And open a draft PR"))
    );
    harness.with_window(cx, |window, _| {
        assert!(
            window.within(queue_entry_element_id("q2")).try_find("queue-save").is_none(),
            "the field closed once saved"
        );
    });

    // Escape leaves an edit without saving.
    harness.with_window(cx, |window, cx| {
        window.within(queue_entry_element_id("q2")).click("queue-edit", cx);
    });
    harness.with_window(cx, |window, cx| window.press("escape", cx));
    assert_eq!(harness.transport.requests("queue.entry.update").len(), 1);

    // Remove takes it back; a refusal shows under the list.
    harness.transport.reply(
        "queue.entry.retract",
        Err(HostRequestError::Transport("the Host went away".into())),
    );
    harness.with_window(cx, |window, cx| {
        window.within(queue_entry_element_id("q2")).click("queue-remove", cx);
    });
    settle(cx);
    assert_eq!(harness.transport.requests("queue.entry.retract")[0]["entryId"], "q2");
    harness.with_window(cx, |window, _| {
        assert_eq!(
            window.find("queue-error").label(),
            Some("Couldn’t remove the message from the queue. The Host went away.")
        );
    });

    // The Host's next projection is the only order shown.
    harness.push(queued(&mut frames, 7, vec![], vec![]), cx);
    settle(cx);
    harness.with_window(cx, |window, _| {
        assert!(window.try_find(queue_entry_element_id("q2")).is_none());
    });
}

/// Adversarial review 2026-09-26: an edit remembers the queue revision it
/// started from, and the Host refuses `queue.entry.update` with
/// `operation_conflict` ("Message queue changed since editing began",
/// `HostMessageCoordinator` in packages/runtime-host/src/server/message-coordinator.ts)
/// once the queue has moved, which it does whenever the running turn takes
/// steering or another message is queued. The refusal leaves the field open
/// with the stale revision, so every later Save sends that revision again and
/// is refused again; only cancelling and reopening the edit, which drops the
/// typed text, gets out. A refusal is now sent once more at the latest
/// revision, and a later save names the latest revision.
#[gpui_kit::test]
fn a_queue_edit_refused_as_stale_is_not_retried_at_the_same_revision(cx: &mut TestAppContext) {
    let (harness, mut frames) = running(cx);
    harness.push(
        queued(
            &mut frames,
            4,
            vec![],
            vec![entry("q1", "Then write the summary", "next_turn", "queued")],
        ),
        cx,
    );
    settle(cx);
    harness.with_window(cx, |window, cx| {
        window.within(queue_entry_element_id("q1")).click("queue-edit", cx);
    });
    harness.with_window(cx, |window, cx| {
        window.press("secondary-a", cx);
        window.input("Then write a short summary", cx);
    });
    // Meanwhile another message is queued: the queue moves to revision 5.
    harness.push(
        queued(
            &mut frames,
            5,
            vec![],
            vec![
                entry("q1", "Then write the summary", "next_turn", "queued"),
                entry("q2", "And open a PR", "next_turn", "queued"),
            ],
        ),
        cx,
    );
    settle(cx);
    let conflict = || {
        Err(HostRequestError::Operation {
            operation: "queue.entry.update",
            code: host_protocol::HostOperationErrorCode::OperationConflict,
            message: "Message queue changed since editing began".into(),
        })
    };
    harness.transport.reply("queue.entry.update", conflict());
    harness.transport.reply("queue.entry.update", conflict());
    for _ in 0..2 {
        // A field a fix closes after the refusal takes no second save.
        harness.with_window(cx, |window, cx| {
            let mut entry = window.within(queue_entry_element_id("q1"));
            if entry.try_find("queue-save").is_some() {
                entry.click("queue-save", cx);
            }
        });
        settle(cx);
    }
    let stale: Vec<_> = harness
        .transport
        .requests("queue.entry.update")
        .into_iter()
        .filter(|update| update["expectedQueueRevision"] == json!(4))
        .collect();
    assert!(stale.len() <= 1, "the stale revision is sent again after the refusal: {stale:?}");
}

const TYPED: &str = "Then write a short summary";

fn conflict() -> Reply {
    Err(HostRequestError::Operation {
        operation: "queue.entry.update",
        code: host_protocol::HostOperationErrorCode::OperationConflict,
        message: "Message queue changed since editing began".into(),
    })
}

/// An edit of `q1` started at queue revision 4 with `TYPED` typed, after
/// which the queue moved to revision 5, where `q1` reads `q1_text`.
fn editing_behind_the_queue(q1_text: &str, cx: &mut TestAppContext) -> Harness {
    let (harness, mut frames) = running(cx);
    let q1 = |text: &str| entry("q1", text, "next_turn", "queued");
    harness.push(queued(&mut frames, 4, vec![], vec![q1("Then write the summary")]), cx);
    settle(cx);
    harness.with_window(cx, |window, cx| {
        window.within(queue_entry_element_id("q1")).click("queue-edit", cx);
    });
    harness.with_window(cx, |window, cx| {
        window.press("secondary-a", cx);
        window.input(TYPED, cx);
    });
    let q2 = entry("q2", "And open a PR", "next_turn", "queued");
    harness.push(queued(&mut frames, 5, vec![], vec![q1(q1_text), q2]), cx);
    settle(cx);
    harness
}

fn save(harness: &Harness, cx: &mut TestAppContext) {
    harness.with_window(cx, |window, cx| {
        window.within(queue_entry_element_id("q1")).click("queue-save", cx);
    });
    settle(cx);
}

/// The revisions and texts of the `queue.entry.update` requests so far.
fn updates(harness: &Harness) -> Vec<(Value, Value)> {
    let requests = harness.transport.requests("queue.entry.update");
    requests.iter().map(|u| (u["expectedQueueRevision"].clone(), u["text"].clone())).collect()
}

fn edit_open(harness: &Harness, cx: &mut TestAppContext) -> bool {
    harness.with_window(cx, |window, _| {
        window.within(queue_entry_element_id("q1")).try_find("queue-save").is_some()
    })
}

#[gpui_kit::test]
fn a_queue_edit_refused_as_stale_is_sent_again_at_the_latest_revision(cx: &mut TestAppContext) {
    let harness = editing_behind_the_queue("Then write the summary", cx);
    harness.transport.reply("queue.entry.update", conflict());
    harness.transport.reply("queue.entry.update", mutation(6));
    save(&harness, cx);
    assert_eq!(updates(&harness), [(json!(4), json!(TYPED)), (json!(5), json!(TYPED))]);
    let ids: Vec<_> = harness
        .transport
        .requests("queue.entry.update")
        .iter()
        .map(|update| update["updateId"].clone())
        .collect();
    assert_ne!(ids[0], ids[1], "the second update is a new command");
    assert!(!edit_open(&harness, cx), "the field closed once saved");
}

#[gpui_kit::test]
fn a_second_refusal_keeps_the_typed_text_editable(cx: &mut TestAppContext) {
    let harness = editing_behind_the_queue("Then write the summary", cx);
    harness.transport.reply("queue.entry.update", conflict());
    harness.transport.reply("queue.entry.update", conflict());
    harness.transport.reply("queue.entry.update", mutation(7));
    save(&harness, cx);
    assert_eq!(updates(&harness).len(), 2, "one retry, not a loop");
    assert!(edit_open(&harness, cx), "the field stays open");
    harness.with_window(cx, |window, _| {
        let error = window.find("queue-error").label().map(str::to_owned).unwrap_or_default();
        assert!(error.starts_with(copy::QUEUE_EDIT_FAILED.en()), "{error}");
    });
    // Saving again sends the typed text at the latest revision.
    save(&harness, cx);
    assert_eq!(updates(&harness)[2], (json!(5), json!(TYPED)));
    assert!(!edit_open(&harness, cx));
}

#[gpui_kit::test]
fn a_refused_edit_of_an_entry_someone_else_changed_is_not_sent_again(cx: &mut TestAppContext) {
    let harness = editing_behind_the_queue("Then write the report", cx);
    harness.transport.reply("queue.entry.update", conflict());
    save(&harness, cx);
    assert_eq!(updates(&harness), [(json!(4), json!(TYPED))]);
    assert!(edit_open(&harness, cx), "the typed text stays editable");
}
