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

//! The panel's geometry: one rounded plate whose corners nothing reaches
//! at any scroll, its rows' fills 8 px in from the plate's sides with
//! their content on its 16 px line, the bar's glyphs' ink on the same
//! line, the diff in its box, and the diff's sticky header.

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{Bounds, Pixels, Role, ScrollDelta, TestAppContext, point, px, size};
use shared::domain_element_id;
use shared::icons::ink;
use shared::theme::RADIUS_MODAL;

use super::{Harness, added, changed, repository};
use crate::git_tests::modified;

/// The part of `bounds` inside `clip`, if any.
fn painted(bounds: Bounds<Pixels>, clip: Bounds<Pixels>) -> Option<Bounds<Pixels>> {
    let part = bounds.intersect(&clip);
    (part.size.width > px(0.) && part.size.height > px(0.)).then_some(part)
}

/// The squares of the plate's radius at its four corners.
fn corners(plate: Bounds<Pixels>) -> [Bounds<Pixels>; 4] {
    let side = size(RADIUS_MODAL, RADIUS_MODAL);
    let (left, right) = (plate.left(), plate.right() - RADIUS_MODAL);
    let (top, bottom) = (plate.top(), plate.bottom() - RADIUS_MODAL);
    [
        Bounds::new(point(left, top), side),
        Bounds::new(point(right, top), side),
        Bounds::new(point(left, bottom), side),
        Bounds::new(point(right, bottom), side),
    ]
}

impl Harness {
    /// Asserts that nothing the panel scrolls paints into a corner square
    /// of its plate: every tree row, scope row and diff row as far as its
    /// list's clip shows it, the lists' clips themselves, the diff's
    /// viewport, and the sticky header.
    fn assert_clear_of_corners(&self, when: &str, cx: &mut TestAppContext) {
        let plate = self.bounds("review-panel", cx);
        let corners = corners(plate);
        let mut painted_parts: Vec<(String, Bounds<Pixels>)> = Vec::new();
        self.with_window(cx, |window, _| {
            let mut add = |name: String, bounds: Bounds<Pixels>, clip: Bounds<Pixels>| {
                if let Some(part) = painted(bounds, clip) {
                    painted_parts.push((name, part));
                }
            };
            for (list, role) in
                [("review-files", Role::TreeItem), ("review-scopes", Role::ListItem)]
            {
                let Some(clip) = window.try_find(list).map(|list| list.bounds()) else {
                    continue;
                };
                add(list.to_owned(), clip, plate);
                for row in window.within(list).find_all_by_role(role) {
                    add(format!("{list} row {:?}", row.label()), row.bounds(), clip);
                }
            }
            if let Some(viewport) = window.try_find("review-diff").map(|diff| diff.bounds()) {
                add("the diff's viewport".to_owned(), viewport, plate);
                for line in window.find_all("source") {
                    add(format!("diff line {:?}", line.label()), line.bounds(), viewport);
                }
                if let Some(sticky) = window.try_find("review-sticky-header") {
                    add("the sticky header".to_owned(), sticky.bounds(), viewport);
                }
            }
        });
        assert!(!painted_parts.is_empty(), "{when}: something drawn");
        for (name, part) in painted_parts {
            for corner in &corners {
                assert!(
                    painted(part, *corner).is_none(),
                    "{when}: {name} at {part:?} reaches the corner {corner:?} of {plate:?}"
                );
            }
        }
    }

    /// Turns the wheel over `id` `times` times, `step` px down each.
    fn wheel(&self, id: &'static str, times: usize, step: f32, cx: &mut TestAppContext) {
        for _ in 0..times {
            self.with_window(cx, |window, cx| {
                window.scroll(id, ScrollDelta::Pixels(point(px(0.), px(-step))), cx);
            });
        }
        self.settle(cx);
    }

    /// The sticky header's file, while it shows.
    fn sticky_file(&self, cx: &mut TestAppContext) -> Option<String> {
        self.with_window(cx, |window, _| {
            window.try_find("review-sticky-file").and_then(|file| file.label().map(str::to_owned))
        })
    }
}

/// Forty-five changed files, two hundred commits: every list scrolls.
fn long_lists() -> crate::git_tests::FakeGit {
    let git = changed(45);
    let log: String = (0..200)
        .map(|n| format!("{n:040x}\u{1f}{n:07x}\u{1f}Ann\u{1f}1700000000\u{1f}Commit {n}\0"))
        .collect();
    git.answer(crate::git_tests::LOG, &log);
    git
}

/// In the wide layout and the narrow one, with the tree and without it,
/// at the top of every list, part way down and at the end, nothing the
/// panel scrolls reaches into its plate's rounded corners.
#[gpui_kit::test]
fn nothing_reaches_the_plates_corners_at_any_scroll(cx: &mut TestAppContext) {
    let harness = Harness::open(long_lists(), 1000., cx);
    harness.show_changes(cx);
    let lists = ["review-files", "review-scopes", "diff-body"];
    for (width, layout) in [(1000., "wide"), (600., "narrow")] {
        harness.resize(width, cx);
        for list in lists {
            harness.wheel(list, 12, -1000., cx);
        }
        harness.assert_clear_of_corners(&format!("{layout}, at the top"), cx);
        for (steps, step, place) in [(4, 100., "part way down"), (12, 1000., "at the end")] {
            for list in lists {
                harness.wheel(list, steps, step, cx);
            }
            harness.assert_clear_of_corners(&format!("{layout}, {place}"), cx);
        }
    }
    harness.click("review-tree-toggle", cx);
    harness.assert_clear_of_corners("the tree hidden, at the end", cx);
    harness.wheel("diff-body", 12, -1000., cx);
    harness.assert_clear_of_corners("the tree hidden, at the top", cx);
}

/// The rows' fills sit 8 px in from the plate's sides and their content on
/// its 16 px line, a level further in 16 px more; the counts end on the
/// line at the far side. The bar's glyphs put their ink on the line; the
/// diff's box sits 8 px in from the plate and the tree's column, its
/// rows 8 px in from its sides and its radius in from its top and bottom.
#[gpui_kit::test]
fn rows_controls_and_the_diff_sit_on_the_plates_lines(cx: &mut TestAppContext) {
    let files = [added("src/app/a.rs", 3), added("src/app/b.rs", 2), modified("README.md")];
    let harness = Harness::open(repository(&files), 600., cx);
    harness.show_changes(cx);
    let plate = harness.bounds("review-panel", cx);
    let (left, right) = (plate.left(), plate.right());

    let folder = harness.bounds(domain_element_id("review-folder", "src/app"), cx);
    let file = harness.bounds(domain_element_id("review-file", "src/app/a.rs"), cx);
    let top_file = harness.bounds(domain_element_id("review-file", "README.md"), cx);
    for row in [folder, file, top_file] {
        assert_eq!((row.left(), row.right()), (left + px(8.), right - px(8.)), "{row:?}");
    }
    let glyph = |id, cx: &mut TestAppContext| harness.bounds(id, cx).left();
    assert_eq!(glyph(domain_element_id("review-folder-glyph", "src/app"), cx), left + px(16.));
    assert_eq!(glyph(domain_element_id("review-file-glyph", "README.md"), cx), left + px(16.));
    assert_eq!(
        glyph(domain_element_id("review-file-glyph", "src/app/a.rs"), cx),
        left + px(32.),
        "a level in"
    );
    let counts = harness.bounds(domain_element_id("review-file-counts", "README.md"), cx);
    assert_eq!(counts.right(), right - px(16.));
    let all = harness.bounds(domain_element_id("review-scope", "all"), cx);
    assert_eq!((all.left(), all.right()), (left + px(8.), right - px(8.)), "a scope's card");
    let heading = harness.bounds("review-commits-heading", cx);
    assert_eq!(heading.left(), left + px(8.), "its text 8 px further in");

    // The bar: the tree's toggle and the "⋯" button (the workbar's strip
    // holds maximize and close), 28 px squares with 16 px glyphs centred,
    // their glyphs' ink on the line.
    let toggle = harness.bounds("review-tree-toggle", cx);
    let more = harness.bounds("review-more", cx);
    assert_eq!(toggle.size, size(px(28.), px(28.)));
    let ink_start = toggle.center().x - px(8.) + px(16. * ink::LIST_TREE_LEADING);
    let ink_end = more.center().x + px(8.) - px(16. * ink::MORE);
    assert!((ink_start - (left + px(16.))).abs() < px(0.5), "{ink_start:?}");
    assert!((right - px(16.) - ink_end).abs() < px(0.5), "{ink_end:?}");

    // The narrow layout's box: under the tree's column, 8 px in.
    let column = harness.bounds("review-left", cx);
    let diff_box = harness.bounds("review-diff-box", cx);
    let diff = harness.bounds("review-diff", cx);
    assert_eq!(diff_box.top(), column.bottom() + px(8.));
    assert_eq!((diff_box.left(), diff_box.right()), (left + px(8.), right - px(8.)));
    assert_eq!(diff_box.bottom(), plate.bottom() - px(8.));
    assert_eq!((diff.left(), diff.right()), (left + px(16.), right - px(16.)), "on the line");
    assert_eq!(
        (diff.top(), diff.bottom()),
        (diff_box.top() + px(10.), diff_box.bottom() - px(10.))
    );

    // The wide layout's: beside the column, 8 px from it, under the bar.
    harness.resize(1000., cx);
    let plate = harness.bounds("review-panel", cx);
    let bar = harness.bounds("review-bar", cx);
    let column = harness.bounds("review-left", cx);
    let diff_box = harness.bounds("review-diff-box", cx);
    assert!(diff_box.left() >= column.right() + px(8.), "{diff_box:?} beside {column:?}");
    assert!(diff_box.left() <= column.right() + px(9.), "{diff_box:?} beside {column:?}");
    assert_eq!(diff_box.right(), plate.right() - px(8.));
    assert_eq!(
        (diff_box.top(), diff_box.bottom()),
        (bar.bottom() + px(8.), plate.bottom() - px(8.))
    );
    let row = harness.bounds(domain_element_id("review-folder", "src/app"), cx);
    assert_eq!(row.left(), plate.left() + px(8.));
    assert_eq!(row.top(), diff_box.top(), "the tree's first row level with the box");
}

/// The width of the counts of file `a.txt` among `files`.
fn counts_width(files: &[(String, String)], cx: &mut TestAppContext) -> Pixels {
    let harness = Harness::open(repository(files), 600., cx);
    harness.show_changes(cx);
    harness.bounds(domain_element_id("review-file-counts", "a.txt"), cx).size.width
}

/// No file deletes lines: the tree has no deletions' lane, so the counts
/// end on the line.
#[gpui_kit::test]
fn a_tree_that_only_adds_has_no_deletions_lane(cx: &mut TestAppContext) {
    assert_eq!(counts_width(&[added("a.txt", 3), added("b.txt", 2)], cx), px(36.), "one lane");
}

/// A file that deletes lines gives every row the deletions' lane.
#[gpui_kit::test]
fn a_file_that_deletes_gives_every_row_the_deletions_lane(cx: &mut TestAppContext) {
    let width = counts_width(&[added("a.txt", 3), modified("b.txt")], cx);
    assert_eq!(width, px(76.), "both lanes, the first file's deletions' empty");
}

/// The diff's sticky header: none while the file at the top shows its
/// own header; the file's copy while that header is above the top, at the
/// diff's top, never over another file's header as it comes up; a tree
/// click lands on the header with no copy; the copy's chevron folds the
/// file, its header then at the top.
#[gpui_kit::test]
fn the_sticky_header_names_the_file_at_the_top(cx: &mut TestAppContext) {
    let files: Vec<(String, String)> = (0..6).map(|ix| added(&format!("f{ix:03}"), 40)).collect();
    let harness = Harness::open(repository(&files), 600., cx);
    harness.show_changes(cx);
    assert_eq!(harness.sticky_file(cx), None, "the first header shows");

    harness.wheel("diff-body", 3, 100., cx);
    assert_eq!(harness.sticky_file(cx).as_deref(), Some("f000"));
    let (diff, sticky) =
        (harness.bounds("review-diff", cx), harness.bounds("review-sticky-header", cx));
    assert_eq!(sticky.top(), diff.top(), "at the diff's top");
    assert!(harness.header_offset("f000", cx).is_none(), "its own header out of view");
    harness.assert_clear_of_corners("with the sticky header", cx);

    // Down through the next files 9 px at a time: the copy shows exactly
    // while the file at the top has its header above the top, and never
    // covers another header.
    let mut seen = Vec::new();
    let mut pushed = 0;
    for _ in 0..240 {
        harness.with_window(cx, |window, cx| {
            window.scroll("diff-body", ScrollDelta::Pixels(point(px(0.), px(-9.))), cx);
        });
        // A frame for the copy of the file the scroll brought to the top.
        harness.with_window(cx, |_, _| {});
        let (diff, headers, sticky, file) = harness.with_window(cx, |window, _| {
            let diff = window.find("review-diff").bounds();
            let headers: Vec<(String, Bounds<Pixels>)> = (0..6)
                .filter_map(|ix| {
                    let path = format!("f{ix:03}");
                    let id = domain_element_id("review-file-header", &path);
                    let content = window.try_find(id)?.bounds();
                    // The kit's header row: 4 px of padding and a hairline
                    // above and below the content.
                    let row = Bounds::from_corners(
                        content.origin - point(px(0.), px(5.)),
                        content.bottom_right() + point(px(0.), px(5.)),
                    );
                    painted(row, diff).map(|bounds| (path, bounds))
                })
                .collect();
            let sticky = window.try_find("review-sticky-header").map(|sticky| sticky.bounds());
            let file = window
                .try_find("review-sticky-file")
                .and_then(|file| file.label().map(str::to_owned));
            (diff, headers, sticky, file)
        });
        if let Some(file) = &file {
            assert!(
                !headers.iter().any(|(path, _)| path == file),
                "{file}'s copy while its own header shows: {headers:?}"
            );
            if !seen.contains(file) {
                seen.push(file.clone());
            }
        }
        if headers.is_empty() {
            assert!(file.is_some(), "inside a file: its copy shows");
        }
        if let Some(whole) = sticky {
            let sticky = painted(whole, diff).expect("drawn only where it shows");
            assert_eq!(sticky.top(), diff.top(), "at the top, or pushed up past it");
            if whole.top() < diff.top() {
                pushed += 1;
            }
            for (path, header) in &headers {
                assert!(
                    sticky.bottom() <= header.top(),
                    "the copy {sticky:?} over {path}'s header {header:?}"
                );
            }
        }
    }
    assert!(pushed > 0, "the next header pushed the copy up");
    assert!(seen.len() >= 3, "the copy followed the files: {seen:?}");

    harness.click(domain_element_id("review-file", "f003"), cx);
    let offset = harness.header_offset("f003", cx).expect("its header shows");
    assert!(offset >= px(0.) && offset < px(12.), "at the diff's top: {offset:?}");
    assert_eq!(harness.sticky_file(cx), None, "no copy over it");

    harness.wheel("diff-body", 2, 100., cx);
    assert_eq!(harness.sticky_file(cx).as_deref(), Some("f003"));
    harness.click("review-sticky-fold", cx);
    let folded =
        harness.panel.read_with(cx, |panel, cx| panel.diff().read(cx).is_file_collapsed("f003"));
    assert!(folded, "the copy's chevron folds its file");
    let offset = harness.header_offset("f003", cx).expect("its header shows");
    assert!(offset >= px(0.) && offset < px(12.), "at the diff's top: {offset:?}");
    assert_eq!(harness.sticky_file(cx), None);
}
