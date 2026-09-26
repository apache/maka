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
use crate::i18n::{Locale, LocalePreference};
use crossterm::event::{KeyCode, KeyModifiers};
use ratatui::{Terminal, backend::TestBackend};
use serde_json::json;

fn locale() -> I18n {
    I18n::new(LocalePreference::Explicit(Locale::En), Locale::En)
}
fn frame(view: &mut Transcript) {
    Terminal::new(TestBackend::new(48, 8))
        .unwrap()
        .draw(|frame| {
            view.draw(frame, frame.area(), false).unwrap();
        })
        .unwrap();
}
pub(super) fn settle(view: &mut Transcript) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        frame(view);
        if view.motion_wait().is_none() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "selection preparation must make progress"
        );
        std::thread::yield_now();
    }
}

#[test]
fn bounded_resolution_never_copies_partial_text_and_replays_owned_keys_in_order() {
    let rows: BTreeMap<_, _> = (0..600)
        .map(|index| {
            (
                index,
                json!({
                    "id":format!("m{index}"), "turnId":"t", "type":"assistant",
                    "text":format!("part {index:03} 中文🦀")
                }),
            )
        })
        .collect();
    let mut view = Transcript::default();
    view.sync(&rows, &[], 0, &locale(), false);
    frame(&mut view);
    let first = MessageKey::durable(&rows[&0]);
    let last = MessageKey::durable(&rows[&599]);
    view.select_extent(Extent {
        anchor: Caret {
            key: first,
            offset: 0,
            trailing: false,
        },
        head: Caret {
            key: last,
            offset: rows[&599]["text"].as_str().unwrap().len(),
            trailing: true,
        },
        column: None,
    });
    assert!(view.text_selection.active());
    assert_eq!(
        view.copy_text(CopyMode::Selection, false),
        Err("chat-copy-pending")
    );
    for key in [KeyCode::Left, KeyCode::Left, KeyCode::Right] {
        assert_eq!(view.selection_key(key), Some(true));
    }
    settle(&mut view);
    let mut expected = rows
        .values()
        .map(|row| row["text"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n\n");
    expected.truncate(expected.len() - '🦀'.len_utf8());
    assert_eq!(
        view.copy_text(CopyMode::Selection, false).unwrap(),
        expected
    );
    assert!(view.text_selection.keys.is_empty());
    assert!(
        view.blocks
            .values()
            .filter(|block| block.layout.is_some())
            .count()
            < 30
    );
}

#[test]
fn a_large_tail_window_maps_mouse_and_keyboard_to_absolute_semantic_offsets() {
    let source = (0..1500)
        .map(|index| format!("row {index:04} 中文🦀\n"))
        .collect::<String>();
    let rows = BTreeMap::from([(
        0,
        json!({
            "id":"large", "turnId":"t", "type":"user", "text":source
        }),
    )]);
    let key = MessageKey::durable(&rows[&0]);
    let mut view = Transcript::default();
    view.sync(&rows, &[], 0, &locale(), false);
    view.blocks.get_mut(&key).unwrap().folded = false;
    settle(&mut view);
    assert!(view.blocks[&key].visual_origin() > 0);
    let row = view.text_selection.rows.first().unwrap();
    let visual = view.blocks[&key].visual_line(row.index).unwrap();
    let start = (row.area.x, row.area.y);
    let end = (row.area.x + visual.line.width() as u16 - 1, row.area.y);
    let range =
        visual.mapping.first().unwrap().logical.start..visual.mapping.last().unwrap().logical.end;
    let expected = view.blocks[&key].selection_text().unwrap()[range].to_owned();
    for (kind, (column, row)) in [
        (MouseEventKind::Down(MouseButton::Left), start),
        (MouseEventKind::Drag(MouseButton::Left), end),
        (MouseEventKind::Up(MouseButton::Left), end),
    ] {
        assert_eq!(
            view.text_mouse(
                MouseEvent {
                    kind,
                    column,
                    row,
                    modifiers: KeyModifiers::NONE
                },
                None
            ),
            Some(None)
        );
    }
    assert_eq!(
        view.copy_text(CopyMode::Selection, false).unwrap(),
        expected
    );
    assert!(view.selection_key(KeyCode::Home).is_some());
    settle(&mut view);
    assert_eq!(
        view.copy_text(CopyMode::Selection, false),
        Err("chat-copy-empty")
    );
    assert!(view.selection_key(KeyCode::End).is_some());
    settle(&mut view);
    assert_eq!(
        view.copy_text(CopyMode::Selection, false).unwrap(),
        expected
    );
}

#[test]
fn reading_switch_restores_a_large_selection_with_bounded_semantic_work() {
    let rows: BTreeMap<_, _> = (0..600).map(|index| (index, json!({
        "id":format!("m{index}"), "turnId":"a", "type":"assistant",
        "text":format!("part {index:03} 中文🦀\n\n[unused]: https://example.test/{}\n", "x".repeat(6000))
    }))).collect();
    let mut first = Transcript::default();
    first.sync(&rows, &[], 0, &locale(), false);
    frame(&mut first);
    let first_key = MessageKey::durable(&rows[&0]);
    let last_key = MessageKey::durable(&rows[&599]);
    first.select_extent(Extent {
        anchor: Caret {
            key: first_key,
            offset: 0,
            trailing: false,
        },
        head: Caret {
            key: last_key,
            offset: "part 599 中文🦀".len(),
            trailing: true,
        },
        column: None,
    });
    settle(&mut first);
    let expected = (0..600)
        .map(|index| format!("part {index:03} 中文🦀"))
        .collect::<Vec<_>>()
        .join("\n\n");
    assert_eq!(
        first.copy_text(CopyMode::Selection, false).unwrap(),
        expected
    );
    let saved = first.take_reading();
    let mut other = Transcript::default();
    other.sync(
        &BTreeMap::from([(
            0,
            json!({
                "id":"other", "turnId":"b", "type":"assistant", "text":"Other reader"
            }),
        )]),
        &[],
        0,
        &locale(),
        false,
    );
    frame(&mut other);
    assert_eq!(
        other.copy_text(CopyMode::Message, false).unwrap(),
        "Other reader"
    );
    let mut resumed = Transcript::resume(saved);
    resumed.sync(&rows, &[], 0, &locale(), false);
    assert_eq!(
        resumed.copy_text(CopyMode::Selection, false),
        Err("chat-copy-pending")
    );
    frame(&mut resumed);
    assert_eq!(
        resumed.copy_text(CopyMode::Selection, false),
        Err("chat-copy-pending")
    );
    let ready = resumed
        .blocks
        .values()
        .filter(|block| block.selection_text().is_some())
        .count();
    // Source text is about 6 KiB even though each semantic result is very short.
    // This bound includes the visible tail in addition to validation progress.
    assert!(
        ready > 0 && ready < 20,
        "first resume frame prepared {ready} records"
    );
    settle(&mut resumed);
    assert_eq!(
        resumed.copy_text(CopyMode::Selection, false).unwrap(),
        expected
    );
    assert!(
        resumed
            .blocks
            .values()
            .filter(|block| block.layout.is_some())
            .count()
            < 30
    );
}
