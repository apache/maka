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

//! Replays frame sequences recorded from a real Runtime Host
//! (`crates/host-protocol/fixtures/sequences/`, written by
//! `scripts/capture-fixtures.sh --sequences`) and asserts the final
//! transcript and every change the replay reported.

use std::collections::HashMap;

use host_protocol::{
    HostFrame, InteractionSnapshot, Outcome, PushFrame, RequestFrame, SessionTranscriptPage,
    SessionTranscriptPageInput, SubscriptionOpenResult, TranscriptDirection,
};
use serde_json::Value;
use transcript_model::{Change, ItemKey, Transcript, TurnItem, TurnViewStatus};

/// The outcome of replaying one sequence.
struct Replay {
    transcript: Transcript,
    changes: Vec<Change>,
    turn_id: String,
    prompt: String,
}

fn replay(text: &str) -> Replay {
    let mut transcript: Option<Transcript> = None;
    let mut changes = Vec::new();
    let mut requests: HashMap<String, RequestFrame> = HashMap::new();
    let mut turn_id = String::new();
    let mut prompt = String::new();
    for line in text.lines() {
        let value: Value = serde_json::from_str(line).expect("line is JSON");
        if value.get("input").is_some() {
            let request: RequestFrame = serde_json::from_value(value).expect("request");
            match request.operation.as_str() {
                "turn.start" => {
                    turn_id = request.input["turnId"].as_str().expect("turnId").to_owned();
                    prompt = request.input["content"]["text"].as_str().expect("text").to_owned();
                }
                "session.transcript.page" => {
                    // The transcript asks for exactly the read the recorder
                    // issued (which follows the Desktop replica). Older pages
                    // are the reader's choice of size.
                    let recorded: SessionTranscriptPageInput =
                        serde_json::from_value(request.input.clone()).expect("page input");
                    let transcript = transcript.as_ref().expect("open first");
                    let asked = match recorded.direction {
                        TranscriptDirection::Older => transcript.older_request(recorded.max_bytes),
                        _ => transcript.transcript_request(),
                    };
                    assert_eq!(asked.as_ref(), Some(&recorded), "the page read differs");
                }
                _ => {}
            }
            requests.insert(request.request_id.clone(), request);
            continue;
        }
        match HostFrame::decode(value).expect("host frame") {
            HostFrame::Response(response) => {
                let Outcome::Ok(result) = response.outcome else { panic!("recorded failure") };
                match response.operation.as_str() {
                    "subscription.open" => {
                        let open: SubscriptionOpenResult =
                            serde_json::from_value(result).expect("open result");
                        transcript = Some(Transcript::bootstrap(&open).expect("bootstrap"));
                    }
                    "session.transcript.page" => {
                        let page: SessionTranscriptPage =
                            serde_json::from_value(result).expect("page");
                        let transcript = transcript.as_mut().expect("open first");
                        changes.extend(transcript.apply_transcript_page(&page));
                    }
                    "interaction.answer" => {
                        let snapshot: InteractionSnapshot =
                            serde_json::from_value(result).expect("interaction");
                        let transcript = transcript.as_mut().expect("open first");
                        changes.extend(transcript.apply_interaction(&snapshot));
                    }
                    _ => {}
                }
            }
            HostFrame::Push(PushFrame::Subscription(frame)) => {
                let transcript = transcript.as_mut().expect("open first");
                changes.extend(transcript.apply_frame(&frame));
            }
            HostFrame::Push(_) => {}
            HostFrame::Handshake(_) => panic!("handshake inside a sequence"),
        }
    }
    let transcript = transcript.expect("the sequence opened a subscription");
    assert!(transcript.needs_reopen().is_none(), "{:?}", transcript.needs_reopen());
    assert_eq!(transcript.transcript_request(), None, "the replay read the whole transcript");
    Replay { transcript, changes, turn_id, prompt }
}

#[test]
fn stop_after_start() {
    let Replay { transcript, changes, turn_id, prompt } =
        replay(include_str!("../../host-protocol/fixtures/sequences/stop_after_start.jsonl"));
    let turn = || turn_id.clone();
    assert_eq!(
        changes,
        [
            // seq 1: admitted. No Turn yet: no durable row, no live content.
            Change::SessionStateChanged,
            // seq 2: the prompt row is durable.
            Change::TranscriptBehind { through_sequence: 23 },
            // seq 3: running.
            Change::SessionStateChanged,
            // The page with the prompt row.
            Change::TurnAdded { turn_id: turn(), index: 0 },
            // seq 4: the stop's queue revision.
            Change::SessionStateChanged,
            // seq 5: the terminal row is durable.
            Change::TranscriptBehind { through_sequence: 31 },
            // seq 6: cancelled. The page that follows changes nothing visible.
            Change::SessionStateChanged,
            Change::TurnFinished { turn_id: turn(), status: TurnViewStatus::Cancelled },
            // seq 7: the queue settles.
            Change::SessionStateChanged,
        ]
    );

    let [turn] = transcript.turns() else { panic!("one turn") };
    assert_eq!(turn.turn_id, turn_id);
    assert_eq!(turn.status, TurnViewStatus::Cancelled);
    assert_eq!(turn.failure, None);
    let [TurnItem::User(user)] = turn.items.as_slice() else { panic!("only the prompt") };
    assert_eq!(user.message_id, turn_id, "turn.start writes the prompt under the turn id");
    assert_eq!(user.text(), prompt);
    let root = transcript.root_turn().expect("root turn");
    assert_eq!(root.abort_source.as_deref(), Some("renderer.stop_button"));
    assert!(transcript.pending_interactions().is_empty());
}

#[test]
fn failed_turn() {
    let Replay { transcript, changes, turn_id, prompt } =
        replay(include_str!("../../host-protocol/fixtures/sequences/failed_turn.jsonl"));
    let turn = || turn_id.clone();
    assert_eq!(
        changes,
        [
            Change::SessionStateChanged,
            Change::TranscriptBehind { through_sequence: 23 },
            Change::SessionStateChanged,
            Change::TurnAdded { turn_id: turn(), index: 0 },
            // seq 4 is a usage domain change: nothing to render.
            Change::TranscriptBehind { through_sequence: 31 },
            // The terminal row lands before the terminal projection; the live
            // root status (running) still wins, so the page changes nothing.
            Change::SessionStateChanged,
            Change::TurnFinished { turn_id: turn(), status: TurnViewStatus::Failed },
        ]
    );

    let [turn] = transcript.turns() else { panic!("one turn") };
    assert_eq!(turn.status, TurnViewStatus::Failed);
    let failure = turn.failure.as_ref().expect("failure");
    assert_eq!(failure.class, "auth");
    assert!(failure.message.as_deref().is_some_and(|message| message.contains("[redacted]")));
    let [TurnItem::User(user)] = turn.items.as_slice() else { panic!("only the prompt") };
    assert_eq!(user.text(), prompt);
    assert!(turn.item(&ItemKey::User(turn_id.clone())).is_some());
}

/// A Session longer than the 16 KiB tail, reopened and paged back with 4 KiB
/// older pages, so the prompt rows (about 6.5 KiB each) split across pages.
#[test]
fn long_history_pages_back_to_the_first_row() {
    let text = include_str!("../../host-protocol/fixtures/sequences/long_history.jsonl");
    // What the tail alone holds: the last Turns (how many depends on the
    // recorded replies' length), and older history.
    let open = text
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("line is JSON"))
        .find(|value| value["operation"] == "subscription.open" && value.get("result").is_some())
        .expect("the open answer");
    let open: SubscriptionOpenResult =
        serde_json::from_value(open["result"].clone()).expect("open result");
    let tail = Transcript::bootstrap(&open).expect("bootstrap");
    let in_tail = tail.turns().len();
    assert!((1..5).contains(&in_tail), "the tail holds some of the five Turns: {in_tail}");
    assert!(tail.has_older_history() && !tail.reached_first_row());
    assert!(!tail.older_read_incomplete(), "the tail ends at a Turn boundary");

    let Replay { transcript, changes, .. } = replay(text);
    // Each Turn arrives whole: the page that ends inside a Turn holds its
    // rows back until the next page reaches the Turn's prompt row, and every
    // older Turn goes in front of the ones already shown.
    let turn_ids: Vec<String> = transcript.turns().iter().map(|t| t.turn_id.clone()).collect();
    assert_eq!(
        changes,
        turn_ids[..5 - in_tail]
            .iter()
            .rev()
            .map(|turn_id| Change::TurnAdded { turn_id: turn_id.clone(), index: 0 })
            .collect::<Vec<_>>()
    );
    assert_eq!(transcript.turns().len(), 5);
    for (part, turn) in transcript.turns().iter().enumerate() {
        let TurnItem::User(user) = &turn.items[0] else { panic!("a Turn opens with its prompt") };
        assert!(
            user.text().starts_with(&format!("These are the notes of part {}.", part + 1)),
            "Turns stay in order: {}",
            &user.text()[..40]
        );
        assert!(user.text().contains(&format!("{}.64. Part {} note 64", part + 1, part + 1)));
        assert_eq!(turn.status, TurnViewStatus::Completed);
        assert!(turn.items.iter().any(|item| matches!(item, TurnItem::Text(_))));
    }
    assert!(!transcript.has_older_history());
    assert!(transcript.reached_first_row());
    assert!(!transcript.older_read_incomplete());
    assert_eq!(transcript.older_request(4096), None);
}

/// A reply from a model that streams reasoning (`qwen3:0.6b` on Ollama):
/// `thinking` deltas, then text deltas of the same message, then the durable
/// row whose `thinking` field carries the whole reasoning.
#[test]
fn reasoning_streams_as_its_own_item() {
    let Replay { transcript, changes, turn_id, .. } =
        replay(include_str!("../../host-protocol/fixtures/sequences/reasoning.jsonl"));
    let [turn] = transcript.turns() else { panic!("one turn") };
    assert_eq!(turn.status, TurnViewStatus::Completed);
    let [TurnItem::User(_), TurnItem::Thinking(thinking), TurnItem::Text(text)] =
        turn.items.as_slice()
    else {
        panic!(
            "prompt, reasoning, reply: {:?}",
            turn.items.iter().map(TurnItem::key).collect::<Vec<_>>()
        )
    };
    assert_eq!(thinking.message_id, text.message_id, "one assistant step");
    assert!(!thinking.streaming && !thinking.truncated);
    assert!(thinking.text.starts_with("Okay, so the user is asking if 391 is a prime number"));
    assert!(!text.streaming);
    assert!(text.text.starts_with("391 is"));
    assert!(!text.text.contains("Okay, so the user"), "reasoning never enters the reply");
    // The reasoning showed (and streamed) before the reply's text.
    let added: Vec<&ItemKey> = changes
        .iter()
        .filter_map(|change| match change {
            Change::ItemAdded { turn_id: id, key, .. } if *id == turn_id => Some(key),
            _ => None,
        })
        .collect();
    assert_eq!(
        added,
        [&ItemKey::Thinking(thinking.message_id.clone()), &ItemKey::Text(text.message_id.clone())]
    );
    assert!(changes.iter().any(|change| matches!(
        change,
        Change::ItemTextAppended { key: ItemKey::Thinking(_), .. }
    )));
}

/// Messages submitted with `turn.message.submit`: the first opens a Turn,
/// one queued follow-up is promoted to steering and lands inside that Turn,
/// and another runs as the next Turn once the first ends.
#[test]
fn submitted_messages_open_turns_and_steer_them() {
    let text = include_str!("../../host-protocol/fixtures/sequences/message_queue.jsonl");
    let Replay { transcript, .. } = replay(text);
    let submitted: Vec<(String, String)> = text
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("line is JSON"))
        .filter(|line| line["operation"] == "turn.message.submit" && line.get("input").is_some())
        .map(|line| {
            let input = &line["input"];
            (
                input["messageId"].as_str().expect("id").to_owned(),
                input["content"]["text"].as_str().expect("text").to_owned(),
            )
        })
        .collect();
    let [first, second, third, _fourth] = submitted.as_slice() else { panic!("four messages") };
    let [opened, followup] = transcript.turns() else { panic!("two turns") };
    // The durable user rows take the submitted message ids: the prompt
    // first, the steering message later in the same Turn, among the
    // prompt's tool calls and reply.
    let users: Vec<&transcript_model::UserItem> = opened
        .items
        .iter()
        .filter_map(|item| match item {
            TurnItem::User(user) => Some(user),
            _ => None,
        })
        .collect();
    let ids: Vec<&str> = users.iter().map(|user| user.message_id.as_str()).collect();
    assert_eq!(ids, [first.0.as_str(), third.0.as_str()]);
    assert!(matches!(&opened.items[0], TurnItem::User(user) if user.message_id == first.0));
    let steering = users[1];
    assert_eq!(steering.text(), "Reply with the single word: third (edited).", "the edit held");
    assert_eq!(opened.status, TurnViewStatus::Completed);
    let TurnItem::User(user) = &followup.items[0] else { panic!("the follow-up") };
    assert_eq!((user.message_id.as_str(), user.text()), (second.0.as_str(), second.1.as_str()));
    assert!(
        followup
            .items
            .iter()
            .any(|item| matches!(item, TurnItem::Text(text) if text.text.contains("second")))
    );
    assert_eq!(followup.status, TurnViewStatus::Completed);
    assert_eq!(transcript.snapshot().queue.entries().count(), 0);
}
