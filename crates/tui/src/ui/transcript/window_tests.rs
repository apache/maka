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
use ratatui::{Terminal, backend::TestBackend};
use std::time::{Duration, Instant};

fn frame(view: &mut Transcript, width: u16, height: u16) {
    Terminal::new(TestBackend::new(width, height))
        .unwrap()
        .draw(|frame| {
            view.draw(frame, frame.area(), false).unwrap();
        })
        .unwrap();
}
fn settle(view: &mut Transcript, width: u16, height: u16) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        frame(view, width, height);
        if view.motion_wait().is_none() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "requested transcript window must make progress"
        );
        std::thread::yield_now();
    }
}
fn key(name: &str) -> MessageKey {
    MessageKey::new("windows", name, Part::Text)
}
fn put(view: &mut Transcript, name: &str, source: &str) {
    view.upsert(key(name), Revision::Durable(1), Kind::Assistant, || {
        source.to_owned().into()
    });
}
#[test]
fn distant_search_and_initial_tail_keep_their_pending_owner_alive() {
    let large = (0..1200)
        .map(|index| {
            format!(
                "row {index:04} 中文🦀
"
            )
        })
        .collect::<String>();
    let mut view = Transcript::default();
    view.begin();
    put(
        &mut view,
        "first",
        &format!(
            "needle-at-first

{large}"
        ),
    );
    for index in 0..200 {
        put(&mut view, &format!("short-{index}"), "short record");
    }
    put(&mut view, "last", &large);
    view.finish([], &tests::locale());
    frame(&mut view, 48, 8);
    assert!(
        view.blocks[&key("last")].large.is_some(),
        "the first tail request survives an old top of zero"
    );
    settle(&mut view, 48, 8);
    assert_eq!(view.first_visible(), Some(key("last")));
    assert!(view.blocks[&key("last")].visual_lines().len() <= 32);
    view.search_command(search::Command::Open);
    view.search
        .as_mut()
        .unwrap()
        .editor
        .insert("needle-at-first");
    view.refresh_search(true);
    frame(&mut view, 48, 8);
    assert!(
        view.blocks[&key("first")].large.is_some(),
        "the offscreen search target keeps its preparation"
    );
    settle(&mut view, 48, 8);
    assert_eq!(view.first_visible(), Some(key("first")));
    assert!(
        view.blocks[&key("first")]
            .visual_lines()
            .iter()
            .any(|line| line.line.to_string().contains("needle-at-first"))
    );
}
#[test]
fn large_windows_scroll_by_rows_reflow_and_replace_without_stale_semantics() {
    let source = (0..1200)
        .map(|index| {
            format!(
                "row {index:04} 中文🦀
"
            )
        })
        .collect::<String>();
    let mut view = Transcript::default();
    view.begin();
    view.upsert(key("plain"), Revision::Durable(1), Kind::User, || {
        source.clone().into()
    });
    view.finish([], &tests::locale());
    view.blocks.get_mut(&key("plain")).unwrap().folded = false;
    settle(&mut view, 48, 16);
    assert_eq!(
        view.copy_text(selection::CopyMode::Message, false).unwrap(),
        source.trim_end_matches('\n')
    );
    view.scroll(true, 600);
    let top = view.top;
    settle(&mut view, 48, 16);
    assert_eq!(
        view.top, top,
        "an uncached page keeps its requested row until it can acquire a source bookmark"
    );
    let anchor = view.anchor.clone().unwrap();
    settle(&mut view, 16, 16);
    assert_eq!(view.anchor.as_ref().unwrap().source, anchor.source);
    assert!(view.blocks[&key("plain")].visual_lines().len() <= 64);
    view.begin();
    view.upsert(key("plain"), Revision::Durable(2), Kind::User, || {
        "replacement 中文".to_owned().into()
    });
    view.finish([], &tests::locale());
    settle(&mut view, 48, 16);
    assert!(view.blocks[&key("plain")].large.is_none());
    assert_eq!(
        view.copy_text(selection::CopyMode::Message, false).unwrap(),
        "replacement 中文"
    );
}
#[test]
fn readers_share_one_frame_work_allowance_and_retained_semantics_are_charged_by_identity() {
    let source = "word 中文🦀 ".repeat(1600);
    let document = layout::prepared::Document::plain(&source).unwrap();
    let mut views: Vec<_> = (0..24)
        .map(|_| {
            let mut view = Transcript::default();
            view.begin();
            put(&mut view, "large", &source);
            view.finish([], &tests::locale());
            view.blocks.get_mut(&key("large")).unwrap().large =
                Some(large::State::prepared(document.clone(), false, view.colors));
            view
        })
        .collect();
    {
        let _work = frame_work::begin();
        for view in &mut views {
            frame(view, 48, 8);
        }
    }
    let progressed = views
        .iter()
        .filter(|view| {
            view.blocks[&key("large")]
                .large
                .as_ref()
                .unwrap()
                .measured()
                > 0
        })
        .count();
    assert!(
        progressed > 0 && progressed < views.len(),
        "independent readers cannot each take a complete frame allowance"
    );
    let colors = views[0].colors;
    let block = views[0].blocks.get_mut(&key("large")).unwrap();
    block.layout = None;
    block.markdown = Default::default();
    let state = block.large.as_ref().unwrap();
    block.semantic = state.shared_text();
    assert_eq!(
        block.geometry_bytes(),
        block.large.as_ref().unwrap().bytes()
    );
    block.semantic = Some(std::sync::Arc::from("previous independent semantic text"));
    assert_eq!(
        block.geometry_bytes(),
        block.large.as_ref().unwrap().bytes() + block.semantic.as_ref().unwrap().len()
    );
    block.large = Some(large::State::new(false, colors));
    assert_eq!(
        views[0].blocks[&key("large")].geometry_bytes(),
        "previous independent semantic text".len()
    );
}

#[test]
fn large_appends_keep_the_display_and_rebase_selected_text_on_the_preparation_lane() {
    use crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
    let source = (0..1200)
        .map(|index| format!("line {index:04} 中文🦀\n"))
        .collect::<String>();
    let mut view = Transcript::default();
    view.begin();
    put(&mut view, "stream", &source);
    view.finish([], &tests::locale());
    settle(&mut view, 48, 8);
    let row = view.text_selection.rows.last().unwrap();
    let visual = view.blocks[&key("stream")].visual_line(row.index).unwrap();
    let start = (row.area.x, row.area.y);
    let end = (row.area.x + visual.line.width() as u16 - 1, row.area.y);
    for (kind, (column, row)) in [
        (MouseEventKind::Down(MouseButton::Left), start),
        (MouseEventKind::Drag(MouseButton::Left), end),
        (MouseEventKind::Up(MouseButton::Left), end),
    ] {
        view.text_mouse(
            MouseEvent {
                kind,
                column,
                row,
                modifiers: KeyModifiers::NONE,
            },
            None,
        );
    }
    let selected = view
        .copy_text(selection::CopyMode::Selection, false)
        .unwrap();
    let mut next = source.clone();
    next.push_str("appended body 中文🦀");
    view.begin_stream();
    view.upsert(key("stream"), Revision::Live(2), Kind::Assistant, || {
        next.clone().into()
    });
    view.finish([], &tests::locale());
    assert!(view.blocks[&key("stream")].previous_frame.is_some());
    assert!(
        !view.blocks[&key("stream")].visual_current(),
        "retained pixels cannot own new-revision hit or selection geometry"
    );
    assert!(!view.blocks[&key("stream")].visual_lines().is_empty());
    settle(&mut view, 48, 8);
    assert!(view.blocks[&key("stream")].previous_frame.is_none());
    assert_eq!(
        view.copy_text(selection::CopyMode::Selection, false)
            .unwrap(),
        selected
    );
    // A prefix insertion requires a suffix mapping, not merely stable byte offsets.
    let changed = format!("new preface\n\n{next}");
    view.begin();
    view.upsert(key("stream"), Revision::Durable(3), Kind::Assistant, || {
        changed.clone().into()
    });
    view.finish([], &tests::locale());
    settle(&mut view, 48, 8);
    assert_eq!(
        view.copy_text(selection::CopyMode::Selection, false)
            .unwrap(),
        selected
    );
    assert_eq!(
        view.copy_text(selection::CopyMode::Source, false).unwrap(),
        changed
    );
}

mod board;
