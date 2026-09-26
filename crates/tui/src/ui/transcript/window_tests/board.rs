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

#[test]
fn a_large_report_between_history_and_live_records_can_reveal_both_ends() {
    let source = format!(
        "# Board report — 看板记录\n\n{}Board report end — 完整记录。",
        "Unicode **progress**: 卡片已核对，下一步继续。 🚀\n\n".repeat(1800)
    );
    let mut view = Transcript::default();
    view.begin();
    for index in 0..252 {
        put(
            &mut view,
            &format!("history-{index}"),
            &format!("Board history {index:03}"),
        );
    }
    put(&mut view, "report", &source);
    view.upsert(key("tool"), Revision::Durable(1), Kind::Other, || {
        "Read × 2".to_owned().into()
    });
    put(&mut view, "live", "Live activity — ready.");
    view.finish([], &tests::locale());
    settle(&mut view, 120, 31);
    for query in ["Board report — 看板记录", "Board report end — 完整记录。"] {
        view.search_command(search::Command::Open);
        view.search.as_mut().unwrap().editor.insert(query);
        view.refresh_search(true);
        assert_eq!(view.search.as_ref().unwrap().count(), "1/1");
        frame(&mut view, 120, 30);
        view.search = None;
        settle(&mut view, 120, 31);
        let visible = view.blocks[&key("report")].visual_lines();
        assert!(
            visible
                .iter()
                .any(|line| line.line.to_string().contains(query)),
            "the source target must be rendered, even when bottom clamping needs neighboring records"
        );
    }
    use crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
    use unicode_width::UnicodeWidthStr;
    let (row, visual) = view
        .text_selection
        .rows
        .iter()
        .filter(|row| row.key == key("report"))
        .find_map(|row| {
            let visual = view.blocks[&row.key].visual_line(row.index)?;
            visual
                .line
                .to_string()
                .contains("完整记录")
                .then_some((row, visual))
        })
        .unwrap();
    let rendered = visual.line.to_string();
    let start = row.area.x + rendered[..rendered.find("完整记录").unwrap()].width() as u16;
    let end = start + "完整记录".width() as u16 - 1;
    let y = row.area.y;
    for (kind, column) in [
        (MouseEventKind::Down(MouseButton::Left), start),
        (MouseEventKind::Drag(MouseButton::Left), end),
        (MouseEventKind::Up(MouseButton::Left), end),
    ] {
        view.text_mouse(
            MouseEvent {
                kind,
                column,
                row: y,
                modifiers: KeyModifiers::NONE,
            },
            None,
        );
        frame(&mut view, 120, 31);
    }
    assert_eq!(
        view.copy_text(selection::CopyMode::Selection, false)
            .unwrap(),
        "完整记录"
    );
}

#[test]
fn append_preview_keeps_a_source_anchor_when_a_late_definition_reflows_the_prefix() {
    let source = "[label][later] and more words 中文。\n\n".repeat(1000);
    let mut view = Transcript::default();
    view.begin();
    put(&mut view, "references", &source);
    view.finish([], &tests::locale());
    settle(&mut view, 48, 8);
    let next = format!("{source}\n[later]: https://example.test/a-long-destination\n");
    view.begin_stream();
    view.upsert(
        key("references"),
        Revision::Live(2),
        Kind::Assistant,
        || next.clone().into(),
    );
    view.finish([], &tests::locale());
    {
        let _work = frame_work::begin();
        frame_work::charge(32_768);
        frame(&mut view, 48, 8);
        view.scroll(true, 3);
    }
    let source_anchor = view.anchor.clone().unwrap();
    assert!(
        view.row_request.is_none(),
        "old pixels cannot supply a new-source numeric row request"
    );
    assert!(
        view.anchor_row.is_none(),
        "previous-revision pixels are not exact current-revision rows"
    );
    settle(&mut view, 48, 8);
    assert_eq!(view.anchor.as_ref().unwrap().source, source_anchor.source);
    let block = &view.blocks[&key("references")];
    let row = view
        .top
        .saturating_sub(view.starts.start(view.indexes[&key("references")]))
        + source_anchor.screen_row;
    let source_row = block.source_row(source_anchor.source);
    assert_eq!(
        row, source_row,
        "the late reference must relocate by source rather than its old row"
    );
}
