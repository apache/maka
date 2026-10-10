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

//! Code in the palette's syntax colours. A reply's code block reaches the
//! code block highlighter every text view without its own uses (the one
//! `shared::theme::apply_kit_theme` has gpui-kit install) with its fence's
//! language, and an untagged block with none, which the kit's highlighter
//! leaves in the ink. A block growing while the reply streams is
//! highlighted again once per commit, the blocks before it not at all, and
//! nothing is highlighted on a frame with no new text. A tool card's diff
//! of a Python file is in Python, coloured over its added and removed
//! tints.
//!
//! The headless window shapes no glyphs, so nothing reads colours off the
//! painted frame: the tests stop where the view hands code to the kit. The
//! highlighter they install records each block it is asked for and answers
//! as the kit's does, with the kit's highlighter under the app's highlight
//! theme.

use std::ops::Range;

use gpui_kit::base::TextViewDefaults;
use gpui_kit::component::ActiveTheme as _;
use gpui_kit::{HighlightStyle, Hsla};
use shared::theme::{ActiveMakaPalette as _, SyntaxPalette, apply_kit_theme};

use super::*;

/// One block the code block highlighter was asked for: its language, its
/// code and the styles it was given.
#[derive(Debug, Clone)]
struct Asked {
    lang: Option<String>,
    code: String,
    styles: Vec<(Range<usize>, HighlightStyle)>,
}

type Record = Arc<Mutex<Vec<Asked>>>;

/// Applies the app's theme, then installs a code block highlighter that
/// records each block and answers as gpui-kit's does: nothing without a
/// language, else what the kit's highlighter gives the code under the
/// app's highlight theme.
fn record_code_blocks(cx: &mut TestAppContext) -> Record {
    let record = Record::default();
    cx.update(|cx| {
        apply_kit_theme(cx);
        let theme = cx.theme().highlight_theme.clone();
        let asked = record.clone();
        TextViewDefaults::global(cx)
            .with_code_block_highlighter(move |block| {
                let lang = block.lang().map(|lang| lang.to_string());
                let code = block.code().to_string();
                let styles = lang
                    .as_deref()
                    .map(|lang| shared::syntax::highlight(lang, &code, &theme))
                    .unwrap_or_default();
                asked.lock().expect("record").push(Asked { lang, code, styles: styles.clone() });
                styles
            })
            .install(cx);
    });
    record
}

fn asked(record: &Record) -> Vec<Asked> {
    record.lock().expect("record").clone()
}

/// The colour `styles` give the first `needle` in `code`.
fn color_of(styles: &[(Range<usize>, HighlightStyle)], code: &str, needle: &str) -> Option<Hsla> {
    let start = code.find(needle).unwrap_or_else(|| panic!("{needle} in {code}"));
    styles
        .iter()
        .find(|(span, _)| span.start <= start && span.end >= start + needle.len())
        .and_then(|(_, style)| style.color)
}

fn syntax(cx: &mut TestAppContext) -> SyntaxPalette {
    cx.update(|cx| cx.syntax_palette())
}

const REPLY: &str = "Three blocks.\n\n\
    ```rust\n// one more\nfn label() -> String { \"inc\".into() }\n```\n\n\
    ```ts\n// greet\nconst hi: string = \"hey\";\n```\n\n\
    ```\nplain words, if x then y\n```\n";

#[gpui_kit::test]
fn tagged_code_blocks_take_the_palette_colours_and_an_untagged_one_stays_plain(
    cx: &mut TestAppContext,
) {
    let (harness, mut frames) = start_turn(cx);
    let record = record_code_blocks(cx);
    harness.push(frames.delta("m1", 0, REPLY), cx);
    settle(cx);
    harness.with_window(cx, |_, _| {});
    let syntax = syntax(cx);
    let blocks = asked(&record);
    let block = |lang: Option<&str>| {
        blocks
            .iter()
            .find(|asked| asked.lang.as_deref() == lang)
            .unwrap_or_else(|| panic!("a {lang:?} block in {blocks:?}"))
    };

    let rust = block(Some("rust"));
    for (word, color) in [
        ("// one more", syntax.comment),
        ("fn", syntax.keyword),
        ("label", syntax.function),
        ("String", syntax.type_name),
        ("\"inc\"", syntax.string),
    ] {
        assert_eq!(color_of(&rust.styles, &rust.code, word), Some(color), "rust: {word}");
    }
    let ts = block(Some("ts"));
    for (word, color) in
        [("// greet", syntax.comment), ("const", syntax.keyword), ("\"hey\"", syntax.string)]
    {
        assert_eq!(color_of(&ts.styles, &ts.code, word), Some(color), "ts: {word}");
    }
    let plain = block(None);
    assert_eq!(plain.code.trim_end(), "plain words, if x then y");
    assert!(plain.styles.is_empty(), "an untagged block keeps the ink");
    assert_eq!(blocks.len(), 3, "each block once: {blocks:?}");
}

#[gpui_kit::test]
fn a_code_block_streaming_in_is_highlighted_once_per_commit_and_not_per_frame(
    cx: &mut TestAppContext,
) {
    let (harness, mut frames) = start_turn(cx);
    let record = record_code_blocks(cx);
    let start = "Two blocks.\n\n```rust\nfn first() {}\n```\n\n```rust\nfn second() {\n";
    harness.push(frames.delta("m1", 0, start), cx);
    settle(cx);
    harness.with_window(cx, |_, _| {});
    let first = asked(&record);
    assert_eq!(first.len(), 2, "both blocks, once each: {first:?}");
    assert!(first[1].code.starts_with("fn second() {"), "{first:?}");

    // Frames with no new text ask for nothing.
    for _ in 0..3 {
        harness.with_window(cx, |_, _| {});
    }
    assert_eq!(asked(&record).len(), 2, "no highlighting on a frame without new text");

    // The first commit after the row appeared moves the text view from its
    // synchronous first parse to its background parser's copy of the
    // blocks, which the highlighter has not seen: each block once more.
    let mut offset = start.len();
    let mut grow = |offset: &mut usize, more: &str, cx: &mut TestAppContext| {
        let before = asked(&record).len();
        harness.push(frames.delta("m1", *offset as u64, more), cx);
        *offset += more.len();
        settle(cx);
        harness.with_window(cx, |_, _| {});
        harness.with_window(cx, |_, _| {});
        asked(&record)[before..].to_vec()
    };
    let new = grow(&mut offset, "    let x = 1;\n", cx);
    assert!(new.len() <= 2 && new.last().is_some_and(|last| last.code.contains("let x")));

    // From then on a commit grows the open block, and it alone is
    // highlighted again; the block before it keeps its colours.
    for more in ["    x + 1;\n", "    // done\n"] {
        let new = grow(&mut offset, more, cx);
        assert_eq!(new.len(), 1, "the growing block only: {new:?}");
        assert!(new[0].code.starts_with("fn second() {") && new[0].code.contains(more.trim()));
        assert!(new[0].styles.iter().any(|(_, style)| style.color == Some(syntax(cx).keyword)));
    }
}

/// Two lines of `app/main.py`: one replaced.
const PYTHON_DIFF: &str = "--- a/app/main.py\n+++ b/app/main.py\n@@ -1,3 +1,3 @@\n \
    def run():\n-    return 1\n+    return \"ok\"  # done\n print(run())";

#[gpui_kit::test]
fn a_python_file_s_diff_is_coloured_over_its_added_and_removed_tints(cx: &mut TestAppContext) {
    let harness = open_file_diff(PYTHON_DIFF, cx);
    cx.update(apply_kit_theme);
    harness.with_window(cx, |_, _| {});
    let key = format!("{TURN}/c1");
    let state = harness.view.read_with(cx, |view, _| view.card_diff(&key)).expect("a Diff");
    let language = state.read_with(cx, |state, _| {
        let [file] = state.files() else { panic!("one file") };
        assert_eq!((file.additions(), file.deletions()), (1, 1));
        file.language()
    });
    assert_eq!(language.as_ref(), "python", "by the file's extension");
    assert!(card_shows(&harness, "c1", "tool-diff", cx));

    let (styles, syntax, tints) = cx.update(|cx| {
        let line = "    return \"ok\"  # done";
        let maka = cx.maka();
        let theme = cx.theme();
        (
            shared::syntax::highlight(&language, line, &theme.highlight_theme),
            cx.syntax_palette(),
            ((theme.success, theme.danger), (maka.success, maka.destructive)),
        )
    });
    let line = "    return \"ok\"  # done";
    assert_eq!(color_of(&styles, line, "return"), Some(syntax.keyword));
    assert_eq!(color_of(&styles, line, "\"ok\""), Some(syntax.string));
    assert_eq!(color_of(&styles, line, "# done"), Some(syntax.comment));
    // The syntax colours carry no fill, so the row's tint (the theme's
    // success and danger, the palette's) shows under them.
    assert!(styles.iter().all(|(_, style)| style.background_color.is_none()));
    assert_eq!(tints.0, tints.1);
}
