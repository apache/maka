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

fn finish(cursor: &mut Cursor) -> usize {
    let mut work = 0;
    for _ in 0..100_000 {
        let progress = cursor.advance(256.max(cursor.minimum_work())).unwrap();
        assert!(progress.work <= 256.max(cursor.minimum_work()));
        work += progress.work;
        if progress.complete {
            return work;
        }
        assert!(progress.work > 0);
    }
    panic!("cursor did not complete");
}
fn oracle(document: Document, expected: Layout, width: u16) {
    assert_eq!(document.text(), expected.text, "semantic width {width}");
    let mut cursor = document.cursor(width, 0..3);
    for start in (0..expected.lines.len()).step_by(3) {
        cursor.request(start..start + 3);
        finish(&mut cursor);
        assert_eq!(cursor.total_rows(), Some(expected.lines.len()));
        assert_eq!(
            cursor.lines(),
            &expected.lines[start..(start + 3).min(expected.lines.len())],
            "window {start} width {width}"
        );
    }
}
#[test]
fn windows_match_eager_styles_source_and_logical_ranges() {
    let colors = crate::theme::Palette::default();
    let cases = [
        "",
        "one two three\n\nnext",
        "# 标题\n\n- **中文🦀** then `` `x\ny` `` &amp; &#x1F980;\n\n[link][target]\n\n[target]: https://example.test/中文\n",
        "> quote\n> continuation\n\n1. first\n2. second\n\n---\n\nlast",
        "before\n\n```rust\nfn main() {\n  let s = \"中文é👩‍💻\";\n}\n```\n\nafter",
        "start\n\n```\n```\n\nend",
        "start\n\n```rust\n```\n\nend",
        "- code\n\n  ```python\n  def greet():\n      return '中文'\n  ```\n\n  continued\n",
        "```rust\r\n/* 中文\r\n * comment */\r\nlet x = [1, 2];\r\n```\r\n",
    ];
    for source in cases {
        for ascii in [false, true] {
            let document = Document::markdown(source, ascii, colors).unwrap();
            for width in [1, 5, 7, 24, 80] {
                oracle(
                    document.clone(),
                    markdown(source, width, ascii).unwrap(),
                    width,
                );
            }
        }
    }
    for source in [
        "one two three",
        "é\t中文\nnext",
        "abc \n\ndef",
        "\n\n",
        "a\u{1b}[31m",
    ] {
        for width in [1, 5, 24] {
            oracle(
                Document::plain(source).unwrap(),
                plain(source, width).unwrap(),
                width,
            );
        }
    }
}
#[test]
fn prepared_stream_prefixes_preserve_late_references_and_open_fences() {
    let source =
        "- **中文é👩‍💻** [link][later]\n\n```rust\r\nlet x = 1;\r\n```\r\n\n[later]: /path\n";
    for end in source
        .char_indices()
        .map(|(at, _)| at)
        .chain([source.len()])
    {
        let source = &source[..end];
        let document = Document::markdown(source, false, crate::theme::Palette::default()).unwrap();
        for width in [5, 24] {
            oracle(
                document.clone(),
                markdown(source, width, false).unwrap(),
                width,
            );
        }
    }
}
#[test]
fn diff_windows_keep_gutters_tint_and_source_mapping() {
    let text = "Requested replacement\n-old 中文🦀é\n+new\t👩‍💻\nResult\n";
    let start = text.find("-old").unwrap();
    let middle = text.find("+new").unwrap();
    let end = text.find("Result").unwrap();
    let rows = [
        diff::Row {
            source: start..middle,
            kind: diff::Kind::Removed,
            language: Some("Rust"),
        },
        diff::Row {
            source: middle..end,
            kind: diff::Kind::Added,
            language: Some("Rust"),
        },
    ];
    for ascii in [false, true] {
        let document =
            Document::diff(text, &rows, ascii, crate::theme::Palette::default()).unwrap();
        for width in [1, 4, 8, 80] {
            oracle(
                document.clone(),
                diff::render(text, &rows, width, ascii).unwrap(),
                width,
            );
        }
    }
}
#[test]
fn giant_word_measurement_is_sliced_and_scroll_reuses_checkpoints() {
    let text = format!("lead {}", "x".repeat(200_000));
    let document = Document::plain(&text).unwrap();
    let mut cursor = document.cursor(40, 0..8);
    let first = cursor.advance(256).unwrap();
    assert!(first.work <= 256 && first.bytes <= 256 && !first.complete);
    assert!(cursor.lines().len() <= 8);
    let cold = first.work + finish(&mut cursor);
    let total = cursor.total_rows().unwrap();
    assert!(total > 4_000);
    assert!(cursor.retained_bytes() < 512 * 1024);
    cursor.request(total - 8..total);
    let replay = finish(&mut cursor);
    assert!(
        replay < cold / 4,
        "tail seek must reuse measured checkpoints"
    );
    assert_eq!(cursor.lines().len(), 8);
    assert!(cursor.retained_bytes() < 512 * 1024);
    assert_eq!(cursor.document().text(), text);
    let resized = document.cursor(17, 0..8);
    assert_eq!(resized.document().text(), text);
    assert!(resized.total_rows().is_none());
}
#[test]
fn overflow_space_never_changes_semantic_paragraph_separator() {
    let source = "abc \n\ndef";
    assert_eq!(
        plain(source, 3).unwrap().text,
        plain(source, 80).unwrap().text
    );
    let source = "[x](url ) \n\nnext";
    assert_eq!(
        markdown(source, 4, false).unwrap().text,
        markdown(source, 80, false).unwrap().text
    );
}
#[test]
fn table_windows_match_grid_stacked_headers_and_semantic_cell_order() {
    let cases = [
        "| Name | Count | Center |\n| :--- | ---: | :---: |\n| **中文🦀** | 7 | ok |\n| long description wraps here | 123 | z |\n\nafter",
        "before\n\n| A | B |\n|---|---|\n| | [link][later] |\n| é👩‍💻 | `x` &amp; |\n\n[later]: https://example.test/path\n",
        "| Header | Empty |\n|---|---|\n",
        "- table\n\n  | A | B |\n  |---|---|\n  | one | two |\n\n  after",
    ];
    for source in cases {
        for ascii in [false, true] {
            let document =
                Document::markdown(source, ascii, crate::theme::Palette::default()).unwrap();
            for width in [1, 5, 12, 24, 64] {
                oracle(
                    document.clone(),
                    markdown(source, width, ascii).unwrap(),
                    width,
                );
            }
        }
    }
}
#[test]
fn tall_table_cells_measure_in_slices_and_reuse_cell_checkpoints() {
    let source = format!(
        "| A | B |\n|---|---|\n| {} | value |\n",
        "longword ".repeat(10_000)
    );
    let document = Document::markdown(&source, false, crate::theme::Palette::default()).unwrap();
    let mut cursor = document.cursor(40, 0..8);
    let first = cursor.advance(256).unwrap();
    assert!(first.work <= 256 && !first.complete);
    assert!(cursor.lines().len() <= 8);
    let cold = first.work + finish(&mut cursor);
    let total = cursor.total_rows().unwrap();
    assert!(total > 1000);
    cursor.request(total - 8..total);
    let replay = finish(&mut cursor);
    assert!(replay < cold / 4);
    assert_eq!(cursor.lines().len(), 8);
    assert!(cursor.retained_bytes() < 10 * 1024 * 1024);
    let eager = markdown(&source, 40, false).unwrap();
    assert_eq!(cursor.lines(), &eager.lines[total - 8..]);
    assert_eq!(document.text(), eager.text);
}

fn seek(cursor: &mut Cursor) {
    for _ in 0..100_000 {
        match cursor.seek_status() {
            SeekStatus::Ready { .. } | SeekStatus::Missing => return,
            SeekStatus::Pending => {
                let progress = cursor.advance(256.max(cursor.minimum_work())).unwrap();
                assert!(progress.work <= 256.max(cursor.minimum_work()));
                assert!(progress.work > 0 || !matches!(cursor.seek_status(), SeekStatus::Pending));
            }
            SeekStatus::Idle => panic!("no pending seek"),
        }
    }
    panic!("seek did not finish");
}
#[test]
fn source_logical_and_tail_seeks_resolve_exact_windows_including_tables() {
    for source in [
        "**start** [first][r]\n\nlong paragraph words 中文 é👩‍💻\n\n[r]: https://example.test/path\n",
        "before\n\n| A | B |\n|---|---|\n| long long cell words | [same][r] |\n| [again][r] | 中文 |\n\n[r]: /destination\n",
    ] {
        let document = Document::markdown(source, false, crate::theme::Palette::default()).unwrap();
        for width in [5, 24] {
            let eager = markdown(source, width, false).unwrap();
            let mut cursor = document.cursor(width, 0..3);
            cursor.request_tail(3);
            seek(&mut cursor);
            assert_eq!(cursor.total_rows(), Some(eager.lines.len()));
            assert_eq!(cursor.origin(), eager.lines.len().saturating_sub(3));
            assert_eq!(cursor.lines(), &eager.lines[cursor.origin()..]);
            let total = cursor.total_rows();
            cursor.request(0..3);
            assert_eq!(
                cursor.total_rows(),
                total,
                "window changes preserve known height"
            );
            let position = source
                .find("/destination")
                .or_else(|| source.find("https://"))
                .unwrap();
            cursor.request_source(position..position + 1, 1, 3);
            seek(&mut cursor);
            let row = eager
                .lines
                .iter()
                .position(|line| {
                    line.mapping
                        .iter()
                        .any(|span| span.source.contains(&position))
                })
                .unwrap();
            assert_eq!(cursor.seek_status(), SeekStatus::Ready { row });
            assert_eq!(
                cursor.lines(),
                &eager.lines[cursor.origin()..(cursor.origin() + 3).min(eager.lines.len())]
            );
            for logical in eager
                .lines
                .iter()
                .flat_map(|line| &line.mapping)
                .map(|span| span.logical.start)
                .step_by(5)
            {
                cursor.request_logical(logical, 1, 3);
                seek(&mut cursor);
                let row = eager
                    .lines
                    .iter()
                    .position(|line| {
                        line.mapping
                            .iter()
                            .any(|span| span.logical.contains(&logical))
                    })
                    .unwrap();
                assert_eq!(
                    cursor.seek_status(),
                    SeekStatus::Ready { row },
                    "logical {logical} width {width}"
                );
            }
            cursor.request_source(0..2, 0, 3);
            seek(&mut cursor);
            assert_eq!(cursor.seek_status(), SeekStatus::Ready { row: 0 });
            cursor.request_logical(document.text().len() + 1, 0, 3);
            assert_eq!(cursor.seek_status(), SeekStatus::Missing);
        }
    }
}
#[test]
fn empty_documents_and_unmapped_newlines_do_not_leave_seek_pending() {
    for text in ["", "\n\n", "abc \n\ndef"] {
        let document = Document::plain(text).unwrap();
        let mut cursor = document.cursor(3, 0..2);
        for offset in 0..=document.text().len() {
            cursor.request_logical(offset, 0, 2);
            seek(&mut cursor);
            assert!(
                matches!(cursor.seek_status(), SeekStatus::Ready { .. }),
                "offset {offset} in {text:?}"
            );
        }
        cursor.request_source(0..1, 0, 2);
        seek(&mut cursor);
        assert!(matches!(cursor.seek_status(), SeekStatus::Ready { .. }));
    }
}

mod budget;
