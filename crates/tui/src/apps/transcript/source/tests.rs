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

pub(super) fn block(id: &str, revision: &str, text: &str) -> Block {
    Block {
        key: Key {
            turn: id.into(),
            message: id.into(),
            part: wire::Part::Text,
        },
        revision: revision.into(),
        kind: wire::Kind::Assistant,
        state: None,
        content: wire::Content {
            text: text.into(),
            ..Default::default()
        },
        timestamp_ms: None,
        affinity: None,
    }
}

pub(super) fn page(blocks: Vec<Block>, older: Option<&str>, newer: Option<&str>) -> wire::Page {
    wire::Page {
        fence: 10,
        records: blocks
            .into_iter()
            .map(|block| wire::Record::Block { block })
            .collect(),
        timings: vec![],
        older: older.map(str::to_owned),
        newer: newer.map(str::to_owned),
        continuation: None,
    }
}

pub(super) fn source(blocks: Vec<Block>) -> Source {
    let mut source = Source::default();
    source.ready(10).unwrap();
    source
        .page(Direction::Tail, page(blocks, Some("older-1"), None))
        .unwrap();
    source
}

pub(super) fn replace(base: u64, value: Block, append: bool) -> wire::Event {
    wire::Event::Replace {
        base,
        revision: base + 1,
        append,
        record: wire::Record::Block { block: value },
    }
}

fn append(base: u64, id: &str, from: &str, to: &str, offset: usize, text: &str) -> wire::Event {
    wire::Event::Append {
        base,
        revision: base + 1,
        key: block(id, from, "").key,
        block_base: from.into(),
        block_revision: to.into(),
        offset,
        text: text.into(),
    }
}

pub(super) fn fragments(value: &Block) -> Vec<wire::Record> {
    let json = serde_json::to_string(value).unwrap();
    let split = json.len() / 2;
    let split = (split..json.len())
        .find(|index| json.is_char_boundary(*index))
        .unwrap();
    [(0, &json[..split]), (split, &json[split..])]
        .into_iter()
        .map(|(offset, json_part)| wire::Record::Fragment {
            key: value.key.clone(),
            revision: value.revision.clone(),
            offset,
            total: json.len(),
            json: json_part.into(),
        })
        .collect()
}

#[test]
fn historical_pages_replay_offscreen_appends_replacements_and_removals() {
    let mut source = source(vec![block("tail", "r1", "tail")]);
    source
        .event(append(10, "older", "r1", "r2", 3, " ✓"), false)
        .unwrap();
    source
        .event(replace(11, block("replace", "r2", "updated"), false), false)
        .unwrap();
    source
        .event(
            wire::Event::Remove {
                base: 12,
                revision: 13,
                key: block("deleted", "r1", "").key,
            },
            false,
        )
        .unwrap();
    assert_eq!(source.blocks().len(), 1);
    source
        .page(
            Direction::Older,
            page(
                vec![
                    block("older", "r1", "old"),
                    block("replace", "r1", "stale"),
                    block("deleted", "r1", "gone"),
                ],
                None,
                Some("newer-1"),
            ),
        )
        .unwrap();
    assert_eq!(
        source
            .blocks()
            .iter()
            .map(|value| value.content.text.as_str())
            .collect::<Vec<_>>(),
        ["old ✓", "updated"]
    );
    assert_eq!(source.fence(), Some(10));
    assert_eq!(source.revision(), Some(13));
    assert_eq!(source.newer(), Some("newer-1"));
}

#[test]
fn page_chain_and_stream_fragments_commit_atomically() {
    let original = block("tail", "r1", "original");
    let mut source = source(vec![original.clone()]);
    let historical = block("older", "r1", "old 中文");
    let mut parts = fragments(&historical).into_iter();
    let mut first = page(vec![], None, None);
    first.records.push(parts.next().unwrap());
    first.continuation = Some("continue-1".into());
    assert!(!source.page(Direction::Older, first).unwrap().changed);
    assert!(
        !source
            .event(replace(10, block("tail", "r2", "changed"), false), false)
            .unwrap()
    );
    assert_eq!(source.blocks().front(), Some(&original));
    let mut last = page(vec![], None, Some("newer-1"));
    last.records.push(parts.next().unwrap());
    source.page(Direction::Older, last).unwrap();
    assert_eq!(source.blocks().front(), Some(&historical));
    let updated = block("older", "r2", "new 中文");
    let mut records = fragments(&updated).into_iter();
    for (index, record) in records.by_ref().enumerate() {
        let changed = source
            .event(
                wire::Event::Replace {
                    base: 11,
                    revision: 12,
                    append: false,
                    record,
                },
                false,
            )
            .unwrap();
        assert_eq!(changed, index == 1);
        assert_eq!(source.revision(), Some(if index == 0 { 11 } else { 12 }));
    }
    assert_eq!(source.blocks().front(), Some(&updated));
}

#[test]
fn following_does_not_insert_offscreen_updates_or_chase_history() {
    let mut source = source(vec![block("tail", "r1", "tail")]);
    source
        .event(replace(10, block("older", "r2", "updated"), false), true)
        .unwrap();
    source
        .event(replace(11, block("new", "r1", "unseen"), true), false)
        .unwrap();
    assert_eq!(source.blocks().len(), 1);
    assert_eq!(source.unseen(), 1);
    source
        .event(
            replace(12, block("another", "r1", "also unseen"), true),
            true,
        )
        .unwrap();
    assert_eq!(source.blocks().len(), 1);
    assert_eq!(source.unseen(), 2);
    source
        .page(
            Direction::Older,
            page(vec![block("older", "r1", "old")], None, Some("newer-1")),
        )
        .unwrap();
    assert_eq!(source.blocks().len(), 1);
    assert_eq!(source.blocks()[0].content.text, "updated");
    source
        .page(
            Direction::Tail,
            page(vec![block("tail", "r1", "tail")], Some("older-1"), None),
        )
        .unwrap();
    assert_eq!(source.blocks().back().unwrap().key.message, "another");
    assert_eq!(source.blocks()[1].key.message, "new");
    assert_eq!(source.unseen(), 0);
}

#[test]
fn malformed_update_and_revision_gap_preserve_last_good_view() {
    for event in [
        append(10, "a", "r1", "r2", usize::MAX, "x"),
        append(11, "a", "r1", "r2", 2, "x"),
    ] {
        let original = block("a", "r1", "ok");
        let mut source = source(vec![original.clone()]);
        assert!(source.event(event, true).is_err());
        assert_eq!(source.blocks().front(), Some(&original));
        assert_eq!(source.revision(), Some(10));
        assert_eq!(source.phase(), Phase::RefreshRequired);
        assert!(source.error().is_some());
    }
}

#[test]
fn live_overflow_requires_refresh_instead_of_skipping_history() {
    let blocks = (0..wire::MAX_RECORDS)
        .map(|index| block(&format!("m-{index}"), "r1", "x"))
        .collect();
    let mut source = source(blocks);
    assert_eq!(
        source.event(replace(10, block("overflow", "r1", "x"), true), true),
        Err(Error::ResourceLimit)
    );
    assert_eq!(source.blocks().len(), wire::MAX_RECORDS);
    assert_eq!(source.blocks().front().unwrap().key.message, "m-0");
    assert_eq!(source.revision(), Some(10));
}

#[test]
fn later_timing_wins_even_when_it_precedes_the_new_record() {
    let mut source = source(vec![]);
    let timing = Timing {
        turn: "new".into(),
        start_ms: 1,
        end: None,
        active: true,
    };
    source
        .event(
            wire::Event::Timing {
                base: 10,
                revision: 11,
                timing: timing.clone(),
            },
            false,
        )
        .unwrap();
    source
        .event(replace(11, block("new", "r1", "new"), true), true)
        .unwrap();
    assert_eq!(source.timings(), std::slice::from_ref(&timing));
    source
        .page(Direction::Tail, page(vec![], None, None))
        .unwrap();
    assert_eq!(source.timings(), &[timing]);
}
