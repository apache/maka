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

//! `TextView.text_style({...})`, end to end: what a script records, what it
//! is refused, and what the style it sets does to the document on screen.
//!
//! The parsing and folding are tested beside them, in
//! `materialize::text_view::style`; these tests go through the VM and a
//! drawn window.

use std::ops::Deref as _;

use gpui::{
    AppContext as _, Entity, InteractiveElement as _, IntoElement, ParentElement as _, Render,
    Styled as _, TestAppContext, VisualTestContext, div, px,
};

use crate::{ScriptView, ShellRuntime};

/// A document with one of everything `text_style` reaches.
const DOCUMENT: &str = "# Heading\n\nFirst paragraph with a [link](https://example.com) and \
                        `code`.\n\nSecond paragraph.\n\n```\nlet x = 1;\n```\n\n| a | b |\n| - | \
                        - |\n| 1 | 2 |\n";

fn source(text_style: &str) -> String {
    let document = serde_json::to_string(DOCUMENT).unwrap();
    format!(
        r#"
import {{ View }} from "gpui-kit";
import {{ TextView }} from "gpui-base";
export default class Document extends View {{
  render() {{ return TextView.markdown("document", {document}){text_style}; }}
}}
"#
    )
}

fn runtime(cx: &mut TestAppContext) -> std::rc::Rc<ShellRuntime> {
    cx.update(crate::init);
    let runtime = ShellRuntime::new_isolated().expect("runtime");
    cx.update(|cx| runtime.set_global(cx));
    runtime
}

/// Renders `source` once and returns the description, or the message it
/// failed with.
fn render(cx: &mut TestAppContext, source: &str) -> Result<String, String> {
    let runtime = runtime(cx);
    let view_type = runtime.load_source("text-style.js", source).expect("load");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let object = context
        .update(|window, cx| runtime.instantiate(&view_type, window, cx))
        .expect("instantiate");
    context
        .update(|window, cx| runtime.render_to_spec(&object, None, window, cx))
        .map_err(|error| error.to_string())
}

#[gpui::test]
fn text_style_records_one_pair_per_value(cx: &mut TestAppContext) {
    let tree = render(
        cx,
        &source(
            r##".text_style({ headings: { 1: { text_size: 20 }, default: { font_weight: 700 } }, link: "#3366ff", code_block: {}, table_head: undefined })"##,
        ),
    )
    .expect("render");
    assert!(
        tree.contains(
            ":text_style(headings.1.text_size=20, headings.default.font_weight=700, \
             link=\"#3366ff\", code_block={})"
        ),
        "{tree}"
    );
}

#[gpui::test]
fn text_style_refuses_what_it_cannot_apply(cx: &mut TestAppContext) {
    for (style, expected) in [
        (r##"{ colour: "#ffffff" }"##, "unknown key `colour`"),
        (r##"{ colour: {} }"##, "unknown key `colour`"),
        (
            r##"{ code_block: { padding: 4 } }"##,
            "unknown key `code_block.padding`",
        ),
        (
            r##"{ headings: { 7: { text_size: 4 } } }"##,
            "unknown key `headings.7`",
        ),
        (r##"{ link: 5 }"##, "`link`"),
        (r##"{ link: "blue" }"##, "`link`"),
        (r##"{ link: null }"##, "leave the key out"),
        (r##"{ paragraph_gap: -4 }"##, "non-negative"),
        (r##"{ code_block: "#000000" }"##, "takes an object with"),
        (
            r##"{ link: { light: "#000000" } }"##,
            "takes a color, not an object",
        ),
        (r##"{ headings: [] }"##, "`headings` is an array"),
        (r##"{ code_font_family: () => "Menlo" }"##, "is a function"),
        (r##"{ "code_block.px": 4 }"##, "nest an object"),
        (r##""#ffffff""##, "expects an object"),
        (r##"[]"##, "expects an object"),
        (r##"null"##, "expects an object"),
    ] {
        let message = render(cx, &source(&format!(".text_style({style})"))).expect_err(style);
        assert!(message.contains(expected), "{style}: {message}");
    }
}

#[gpui::test]
fn text_style_on_anything_but_a_text_view_is_accepted_and_ignored(cx: &mut TestAppContext) {
    let source = r##"
import { View, div } from "gpui-kit";
export default class Plain extends View {
  render() { return div().text_style({ link: "#3366ff" }).child("plain"); }
}
"##;
    let tree = render(cx, source).expect("render");
    assert!(tree.contains(":text_style(link=\"#3366ff\")"), "{tree}");
}

/// The script view under a 320 px wide marker the test can measure.
struct Measured(Entity<ScriptView>);

impl Render for Measured {
    fn render(&mut self, _: &mut gpui::Window, _: &mut gpui::Context<Self>) -> impl IntoElement {
        div().flex().items_start().child(
            div()
                .w(px(320.))
                .debug_selector(|| "document".into())
                .child(self.0.clone()),
        )
    }
}

/// The drawn height of `DOCUMENT` with `text_style` chained onto it.
fn document_height(cx: &mut TestAppContext, text_style: &str) -> gpui::Pixels {
    let runtime = runtime(cx);
    let view_type = runtime
        .load_source("text-style.js", &source(text_style))
        .expect("load");
    let window = cx.add_window(|_, _| Empty);
    let mut context = VisualTestContext::from_window(*window.deref(), cx);
    let view = context.update(|window, cx| {
        let object = runtime
            .instantiate(&view_type, window, cx)
            .expect("instantiate");
        cx.new(|_| ScriptView::new(runtime.clone(), object))
    });
    context.update(|window, cx| window.replace_root(cx, |_, _| Measured(view)));
    // The document is parsed off the main thread; draw until it has landed.
    for _ in 0..4 {
        context.update(|window, cx| window.draw(cx).clear(cx));
        context.run_until_parked();
    }
    context
        .debug_bounds("document")
        .expect("the document was drawn")
        .size
        .height
}

/// Modeled on Base's `heading_refinement_changes_rendered_heading_geometry`:
/// the same document, drawn with and without each setting, and measured.
#[gpui::test]
fn text_style_changes_the_rendered_document(cx: &mut TestAppContext) {
    let default = document_height(cx, "");
    assert!(default > px(0.), "the document has height");

    for (text_style, change) in [
        (
            ".text_style({ headings: { 1: { text_size: 48 } } })",
            "a larger first-level heading",
        ),
        (
            ".text_style({ headings: { default: { text_size: 48 } } })",
            "a larger default heading",
        ),
        (
            ".text_style({ paragraph_gap: 40 })",
            "a wider gap between blocks",
        ),
        (
            ".text_style({ code_block: { py: 40 } })",
            "more padding in a code block",
        ),
        (".text_style({ code_font_size: 30 })", "larger code"),
        (
            ".text_style({ table_cell: { py: 20 } })",
            "more padding in a table cell",
        ),
    ] {
        let height = document_height(cx, text_style);
        assert!(
            height > default,
            "{change} must make the document taller: {height:?} against {default:?}"
        );
    }

    for (text_style, change) in [
        (
            ".text_style({ headings: { 2: { text_size: 48 } } })",
            "a level the document does not use",
        ),
        (
            r##".text_style({ link: "#ff0000", foreground: "#101010", border: "#00ff00", code_background: "#000000", table_head: { bg: "#eeeeee" } })"##,
            "colors",
        ),
        (".text_style({ code_block: {} })", "an empty object"),
    ] {
        assert_eq!(
            document_height(cx, text_style),
            default,
            "{change} must leave the document's geometry alone"
        );
    }
}

struct Empty;

impl Render for Empty {
    fn render(&mut self, _: &mut gpui::Window, _: &mut gpui::Context<Self>) -> impl IntoElement {
        div()
    }
}
