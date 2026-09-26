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
fn oversized_graphemes_are_rejected_during_preparation_including_fence_labels() {
    let allowed = format!("e{}", "\u{301}".repeat((MAX_GRAPHEME_BYTES - 1) / 2));
    let document = Document::plain(&allowed).unwrap();
    let mut cursor = document.cursor(10, 0..2);
    assert!(cursor.minimum_work() <= 32_768);
    finish(&mut cursor);
    assert_eq!(cursor.lines()[0].line.to_string(), allowed);
    let mixed = Document::plain(&format!("{}{allowed}", "a".repeat(80_000))).unwrap();
    let mut mixed = mixed.cursor(40, 0..3);
    let progress = mixed.advance(mixed.minimum_work()).unwrap();
    assert!(
        progress.bytes > 10_000,
        "one large later cluster must not reduce ordinary text to one grapheme per frame"
    );
    assert!(progress.work <= 32_768);
    let oversized = format!("{allowed}\u{301}");
    let error = Some("Transcript grapheme exceeds 16 KiB local capacity");
    assert_eq!(Document::plain(&oversized).err(), error);
    assert_eq!(
        Document::markdown(
            &format!("```{oversized}\n```"),
            false,
            crate::theme::Palette::default()
        )
        .err(),
        error
    );
    assert_eq!(
        Document::markdown(
            &format!("```\n{oversized}\n```"),
            false,
            crate::theme::Palette::default()
        )
        .err(),
        error
    );
    let entities = format!("e{}", "&#x301;".repeat(MAX_GRAPHEME_BYTES / 2));
    assert_eq!(
        Document::markdown(&entities, false, crate::theme::Palette::default()).err(),
        error
    );
    let rows = [diff::Row {
        source: 0..oversized.len(),
        kind: diff::Kind::Added,
        language: None,
    }];
    assert_eq!(
        Document::diff(&oversized, &rows, false, crate::theme::Palette::default()).err(),
        error
    );
}
#[test]
fn combining_word_lookahead_yields_by_bytes_without_changing_wraps() {
    let cluster = format!("e{}", "\u{301}".repeat(400));
    let source = format!("lead {} end", cluster.repeat(200));
    let document = Document::plain(&source).unwrap();
    let eager = plain(&source, 40).unwrap();
    let mut cursor = document.cursor(40, 0..eager.lines.len());
    let budget = cursor.minimum_work();
    let mut slices = 0;
    let mut inspected = 0;
    loop {
        let progress = cursor.advance(budget).unwrap();
        assert!(progress.work <= budget);
        assert!(progress.bytes <= progress.work);
        inspected += progress.work;
        slices += 1;
        if progress.complete {
            break;
        }
        assert!(progress.work > 0);
    }
    assert!(slices >= source.len() / budget);
    assert!(inspected >= source.len());
    assert_eq!(cursor.lines(), eager.lines);
    assert_eq!(document.text(), eager.text);
}

#[test]
fn maximum_terminal_width_advances_with_a_small_byte_budget() {
    let source = format!("lead {}", "x".repeat(70_000));
    let document = Document::plain(&source).unwrap();
    let eager = plain(&source, u16::MAX).unwrap();
    let mut cursor = document.cursor(u16::MAX, 0..3);
    assert_eq!(cursor.minimum_work(), 2);
    for _ in 0..20_000 {
        let step = cursor.advance(17).unwrap();
        assert!(step.work <= 17);
        if step.complete {
            break;
        }
        assert!(step.work > 0);
    }
    assert_eq!(cursor.total_rows(), Some(eager.lines.len()));
    assert_eq!(cursor.lines(), eager.lines);
    let source = "| A | B |\n|---|---|\n| x | y |";
    let document = Document::markdown(source, false, crate::theme::Palette::default()).unwrap();
    let mut cursor = document.cursor(u16::MAX, 0..3);
    for _ in 0..100 {
        let step = cursor.advance(17).unwrap();
        assert!(step.work <= 17);
        if step.complete {
            break;
        }
        assert!(step.work > 0);
    }
    assert_eq!(
        cursor.lines(),
        markdown(source, u16::MAX, false).unwrap().lines
    );
    assert!(cursor.total_rows().is_some());
}
