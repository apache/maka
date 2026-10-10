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

//! UI integration tests of the Files face in a headless window, against
//! the scripted Host of [`crate::tests`]: the list, its filter and its
//! keys; each kind's preview; each failure's line; the actions, Copy only
//! for text, Delete after its confirmation, Save As assembling chunks
//! (through a stubbed dialog) and Open in Default App (through a stubbed
//! opener: nothing opens on the machine running the tests).

#![allow(clippy::disallowed_methods)] // Tests read their scratch files.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use gpui_kit::component::Root;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    App, AppContext as _, ElementId, Entity, TestAppContext, Window, WindowHandle, point, px, size,
};
use host_protocol::{ARTIFACT_READ_CHUNK_MAX_BYTES, HostOperationErrorCode};
use serde_json::{Value, json};
use shared::copy::{Locale, Text, files as copy};
use shared::domain_element_id;
use workspace::HostRequestError;

use crate::tests::{ScriptedHost, artifact, five_files, host_session};
use crate::{Body, Desk, FilesView, FilesViewEvent};

/// Unix milliseconds the tests' clock reads: 2026-10-10.
const NOW: u64 = 1_791_590_400_000;

/// A 1×1 PNG.
const PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
];

/// The face in a window, and what it asked the desktop and the window.
struct Face {
    host: Arc<ScriptedHost>,
    view: Entity<FilesView>,
    window: WindowHandle<Root>,
    events: Rc<RefCell<Vec<FilesViewEvent>>>,
    /// The names the save dialog was asked to suggest.
    suggested: Rc<RefCell<Vec<String>>>,
    /// Where the stubbed save dialog answers to save.
    save_to: Rc<RefCell<Option<PathBuf>>>,
    /// What was handed to the default app.
    opened: Rc<RefCell<Vec<PathBuf>>>,
    scratch: PathBuf,
}

impl Drop for Face {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.scratch).ok();
    }
}

impl Face {
    fn open(host: Arc<ScriptedHost>, cx: &mut TestAppContext) -> Self {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init(cx);
            cx.set_reduce_motion(true);
        });
        let scratch =
            std::env::temp_dir().join(format!("maka-files-view-{}", uuid::Uuid::new_v4().simple()));
        let session = host_session(&host, cx);
        let events = Rc::new(RefCell::new(Vec::new()));
        let suggested = Rc::new(RefCell::new(Vec::new()));
        let save_to = Rc::new(RefCell::new(None));
        let opened = Rc::new(RefCell::new(Vec::new()));
        let desk = {
            let (suggested, save_to, opened) = (suggested.clone(), save_to.clone(), opened.clone());
            Desk::new(
                Rc::new(move |name: &str, cx: &mut App| {
                    suggested.borrow_mut().push(name.to_owned());
                    let answer = save_to.borrow().clone();
                    cx.spawn(async move |_| answer)
                }),
                Rc::new(move |path: &std::path::Path, _: &mut App| {
                    opened.borrow_mut().push(path.to_owned());
                }),
                Some(scratch.join("copies")),
            )
        };
        let mut view = None;
        let recorded = events.clone();
        let window = cx.open_window(size(px(640.), px(720.)), |window, cx| {
            let face = cx.new(|cx| {
                let mut face = FilesView::new(session.clone(), window, cx);
                face.set_desk(desk);
                face.set_clock(|| NOW);
                face
            });
            cx.subscribe(&face, move |_, _, event: &FilesViewEvent, _| {
                recorded.borrow_mut().push(event.clone());
            })
            .detach();
            view = Some(face.clone());
            Root::new(face, window, cx)
        });
        let face = Self {
            host,
            view: view.expect("view"),
            window,
            events,
            suggested,
            save_to,
            opened,
            scratch,
        };
        face.view.update(cx, |view, cx| {
            view.set_session(Some(crate::tests::SESSION.into()), cx);
            view.set_shown(true, cx);
        });
        face.frame(cx);
        face
    }

    fn with_window<R>(
        &self,
        cx: &mut TestAppContext,
        f: impl FnOnce(&mut Window, &mut App) -> R,
    ) -> R {
        let result = cx
            .update_window(self.window.into(), |_, window, cx| {
                window.render_frame(cx);
                f(window, cx)
            })
            .expect("window");
        cx.run_until_parked();
        cx.update_window(self.window.into(), |_, window, cx| window.render_frame(cx))
            .expect("window");
        cx.run_until_parked();
        result
    }

    fn frame(&self, cx: &mut TestAppContext) {
        self.with_window(cx, |_, _| {});
    }

    fn click(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) {
        let id = id.into();
        self.with_window(cx, |window, cx| window.click(id, cx));
    }

    fn press(&self, keys: &str, cx: &mut TestAppContext) {
        for key in keys.split(' ') {
            self.with_window(cx, |window, cx| window.press(key, cx));
        }
    }

    fn exists(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) -> bool {
        let id = id.into();
        self.with_window(cx, |window, _| window.try_find(id).is_some())
    }

    fn label(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) -> Option<String> {
        let id = id.into();
        self.with_window(cx, |window, _| {
            window.try_find(id).and_then(|element| element.label().map(str::to_owned))
        })
    }

    fn focus(&self, cx: &mut TestAppContext) {
        let view = self.view.clone();
        self.with_window(cx, |window, cx| view.update(cx, |view, cx| view.focus(window, cx)));
    }

    fn selected(&self, cx: &mut TestAppContext) -> Option<String> {
        self.view.read_with(cx, |view, _| view.selected().map(ToString::to_string))
    }

    /// The previewed file's id.
    fn previewing(&self, cx: &mut TestAppContext) -> Option<String> {
        self.view.read_with(cx, |view, cx| {
            view.preview().map(|preview| preview.read(cx).artifact().id.clone())
        })
    }

    fn open_preview(&self, id: &str, cx: &mut TestAppContext) {
        self.click(domain_element_id("files-row", id), cx);
        assert_eq!(self.previewing(cx).as_deref(), Some(id));
    }

    fn body<R>(&self, cx: &mut TestAppContext, f: impl FnOnce(&Body, &App) -> R) -> R {
        self.view.read_with(cx, |view, cx| {
            let preview = view.preview().expect("a preview").read(cx);
            f(preview.body(), cx)
        })
    }

    /// The text the preview holds and whether it is whole.
    fn text(&self, cx: &mut TestAppContext) -> (String, bool) {
        self.body(cx, |body, _| match body {
            Body::Text(text) => (text.text().to_string(), text.is_complete()),
            other => panic!("not text: {other:?}"),
        })
    }

    /// The text the rendered view draws, where the text renders.
    fn rendered(&self, cx: &mut TestAppContext) -> Option<String> {
        self.body(cx, |body, cx| match body {
            Body::Text(text) => text.rendered_text(cx),
            other => panic!("not text: {other:?}"),
        })
    }

    /// The editor's text and language.
    fn editor(&self, cx: &mut TestAppContext) -> (String, String) {
        self.body(cx, |body, cx| match body {
            Body::Text(text) => {
                let editor = text.editor().read(cx);
                (editor.value().to_string(), editor.language_name().to_string())
            }
            other => panic!("not text: {other:?}"),
        })
    }

    /// The line that says why nothing shows.
    fn why(&self, cx: &mut TestAppContext) -> Option<String> {
        self.label(domain_element_id("settings-status", "files-why"), cx)
    }

    fn menu_items(&self, cx: &mut TestAppContext) -> Vec<&'static str> {
        self.click("files-more", cx);
        let items: Vec<&'static str> = ["files-copy", "files-save", "files-open", "files-delete"]
            .into_iter()
            .filter(|key| self.exists(menu_item(key), cx))
            .collect();
        self.press("escape", cx);
        items
    }

    fn notice(&self, cx: &mut TestAppContext) -> Option<(bool, String, Option<String>)> {
        self.view.read_with(cx, |view, _| {
            view.notice().map(|notice| (notice.ok, notice.title.clone(), notice.detail.clone()))
        })
    }
}

fn menu_item(key: &str) -> ElementId {
    domain_element_id("menu-item", key)
}

fn en(text: Text) -> String {
    text.in_locale(Locale::English).to_owned()
}

fn with_summary(mut artifact: Value, summary: &str) -> Value {
    artifact["summary"] = json!(summary);
    artifact
}

#[gpui_kit::test]
fn the_list_shows_what_a_person_sees_newest_first(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    five_files(&host);
    host.add(
        with_summary(artifact("a0", "notes.md", "file", "subagent_writeback", 2048), "The plan"),
        b"x",
    );
    let face = Face::open(host, cx);
    let ids = face.view.read_with(cx, |view, cx| view.shown_ids(cx));
    assert_eq!(ids, ["a0", "a1", "a2", "a4"], "no upload, no ordinary tool result");
    for hidden in ["a3", "a5"] {
        assert!(!face.exists(domain_element_id("files-row", hidden), cx));
    }
    let row = face.label(domain_element_id("files-row", "a0"), cx).expect("row");
    assert!(row.starts_with("notes.md, 2 KB, ") && row.ends_with(", The plan"), "{row}");
    // The first file is selected; a row with a summary is two lines tall.
    assert_eq!(face.selected(cx).as_deref(), Some("a0"));
    let (two, one) = face.with_window(cx, |window, _| {
        let height =
            |id: &str| window.find(domain_element_id("files-row", id)).bounds().size.height;
        (height("a0"), height("a1"))
    });
    assert!(two > one, "{two:?} > {one:?}");
}

#[gpui_kit::test]
fn the_list_keys_move_open_and_hand_the_panel_back(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    five_files(&host);
    let face = Face::open(host, cx);
    face.focus(cx);
    assert_eq!(face.selected(cx).as_deref(), Some("a1"));
    face.press("down", cx);
    assert_eq!(face.selected(cx).as_deref(), Some("a2"));
    face.press("end", cx);
    assert_eq!(face.selected(cx).as_deref(), Some("a4"));
    face.press("down", cx);
    assert_eq!(face.selected(cx).as_deref(), Some("a1"), "Down wraps");
    face.press("up", cx);
    assert_eq!(face.selected(cx).as_deref(), Some("a4"), "Up wraps");
    face.press("home", cx);
    assert_eq!(face.selected(cx).as_deref(), Some("a1"));
    assert!(face.with_window(cx, |window, _| window.find("files-list").focused() == Some(true)));

    face.press("down enter", cx);
    assert_eq!(face.previewing(cx).as_deref(), Some("a2"));
    face.press("escape", cx);
    assert_eq!(face.previewing(cx), None, "Escape goes back to the list");
    assert!(face.with_window(cx, |window, _| window.find("files-list").focused() == Some(true)));
    face.press("space", cx);
    assert_eq!(face.previewing(cx).as_deref(), Some("a2"), "Space opens too");
    face.click("files-back", cx);
    assert_eq!(face.previewing(cx), None);
    assert!(face.events.borrow().is_empty());
    face.focus(cx);
    face.press("escape", cx);
    assert_eq!(*face.events.borrow(), [FilesViewEvent::Dismiss], "Escape in the list");
}

#[gpui_kit::test]
fn the_filter_narrows_the_list_and_counts_its_matches(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    five_files(&host);
    let face = Face::open(host, cx);
    let filter = face.view.read_with(cx, |view, _| view.filter().clone());
    let field = ("input", filter.entity_id());
    face.click(field, cx);
    face.with_window(cx, |window, cx| window.input("MD", cx));
    let ids = face.view.read_with(cx, |view, cx| view.shown_ids(cx));
    assert_eq!(ids, ["a1", "a4"]);
    assert_eq!(face.label("files-filter-count", cx).as_deref(), Some("2 of 3"));
    assert!(!face.exists(domain_element_id("files-row", "a2"), cx));
    // Enter in the filter opens the first match.
    face.press("enter", cx);
    assert_eq!(face.previewing(cx).as_deref(), Some("a1"));
    face.press("escape", cx);
    face.click(field, cx);
    face.with_window(cx, |window, cx| window.input("zzz", cx));
    assert!(face.exists("files-no-matches", cx));
}

#[gpui_kit::test]
fn an_empty_task_says_where_files_will_appear(cx: &mut TestAppContext) {
    let face = Face::open(ScriptedHost::new(), cx);
    assert_eq!(face.label("files-empty", cx), Some(en(copy::EMPTY)));
    // The empty list still takes the focus and its keys.
    face.focus(cx);
    face.press("down enter escape", cx);
    assert_eq!(*face.events.borrow(), [FilesViewEvent::Dismiss]);
}

#[gpui_kit::test]
fn a_failed_list_says_why_and_retries(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    host.reply(
        "artifact.query:list_start",
        Err(HostRequestError::Transport("connection reset".into())),
    );
    host.add(artifact("a1", "brief.md", "file", "deep_research", 3), b"abc");
    let face = Face::open(host, cx);
    let line = face.label(domain_element_id("settings-status", "files-list-failure"), cx);
    assert_eq!(line, Some(format!("{} {}", en(copy::LIST_FAILED), en(copy::WHY_DISCONNECTED))));
    face.click("files-list-retry", cx);
    assert!(face.exists(domain_element_id("files-row", "a1"), cx));
}

#[gpui_kit::test]
fn a_small_text_file_shows_whole_in_the_editor(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    host.add(artifact("a1", "main.rs", "file", "subagent_writeback", 12), b"fn main() {}");
    let face = Face::open(host, cx);
    face.open_preview("a1", cx);
    assert_eq!(face.text(cx), ("fn main() {}".to_owned(), true));
    assert_eq!(face.editor(cx), ("fn main() {}".to_owned(), "rust".to_owned()));
    assert_eq!(face.label("files-preview-name", cx).as_deref(), Some("main.rs"));
    let meta = face.label("files-preview-meta", cx).expect("meta");
    assert!(meta.starts_with("File, 12 bytes, "), "{meta}");
    assert!(face.exists("files-code-box", cx));
    assert!(!face.exists("files-partial", cx), "nothing more to read");
    assert!(face.host.requests("artifact.query:read_chunk").is_empty());
}

/// A JSON file shows in the editor as JSON, by its extension or, without
/// one, its media type, and the kit's highlighter colours it from the
/// palette's syntax roles, the palette chosen now: the editor reads the
/// highlight theme as it paints. (The headless window shapes no glyphs, so
/// the colours are what the highlighter gives the editor's text under that
/// theme.)
#[gpui_kit::test]
fn a_json_file_shows_as_json_in_the_palette_s_syntax_colours(cx: &mut TestAppContext) {
    use gpui_kit::component::ActiveTheme as _;
    use shared::palette::ThemePalette;
    use shared::theme::{ActiveMakaPalette as _, apply_kit_theme, set_theme_palette};

    let host = ScriptedHost::new();
    let json = br#"{"name": "maka", "count": 3, "ok": true}"#;
    host.add(artifact("a1", "report.json", "file", "subagent_writeback", json.len()), json);
    let mut typed = artifact("a2", "report", "file", "deep_research", json.len());
    typed["mimeType"] = json!("application/json; charset=utf-8");
    host.add(typed, json);
    let face = Face::open(host, cx);
    cx.update(apply_kit_theme);
    for id in ["a1", "a2"] {
        face.open_preview(id, cx);
        let (text, language) = face.editor(cx);
        assert_eq!(language, "json", "{id}");
        for palette in [ThemePalette::Default, ThemePalette::Sand] {
            cx.update(|cx| set_theme_palette(palette, cx));
            face.frame(cx);
            let (styles, syntax) = cx.update(|cx| {
                let theme = cx.theme().highlight_theme.clone();
                (shared::syntax::highlight(&language, &text, &theme), cx.syntax_palette())
            });
            let color_of = |needle: &str| {
                let start = text.find(needle).expect("needle");
                styles
                    .iter()
                    .find(|(range, _)| range.start <= start && range.end >= start + needle.len())
                    .and_then(|(_, style)| style.color)
            };
            assert_eq!(color_of("\"maka\""), Some(syntax.string), "{id} {palette:?}");
            assert_eq!(color_of("3"), Some(syntax.constant));
            assert_eq!(color_of("true"), Some(syntax.constant));
            assert_eq!(color_of("{"), Some(syntax.punctuation));
        }
        face.press("escape", cx);
    }
}

#[gpui_kit::test]
fn a_large_text_is_read_in_chunks_with_show_more_and_show_all(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    // Three-byte characters whose chunks split them.
    let text = "中文ab\n".repeat(12_000);
    host.add(artifact("a1", "notes.txt", "file", "deep_research", text.len()), text.as_bytes());
    let face = Face::open(host, cx);
    face.open_preview("a1", cx);
    assert_eq!(face.host.requests("artifact.query:read_text").len(), 1);
    let (shown, whole) = face.text(cx);
    assert!(!whole && text.starts_with(&shown), "the first chunk, cut at a character");
    assert_eq!(face.label("files-shown", cx).as_deref(), Some("Showing 32 KB of 105 KB"));
    face.click("files-show-more", cx);
    assert_eq!(face.host.requests("artifact.query:read_chunk").len(), 2);
    assert_eq!(face.label("files-shown", cx).as_deref(), Some("Showing 64 KB of 105 KB"));
    face.click("files-show-all", cx);
    assert_eq!(face.text(cx), (text.clone(), true));
    assert_eq!(face.editor(cx).0, text);
    assert!(!face.exists("files-partial", cx), "nothing more to show");
    let offsets: Vec<u64> = face
        .host
        .requests("artifact.query:read_chunk")
        .iter()
        .map(|input| input["offset"].as_u64().expect("offset"))
        .collect();
    let chunk = ARTIFACT_READ_CHUNK_MAX_BYTES as u64;
    assert_eq!(offsets, [0, chunk, 2 * chunk, 3 * chunk]);
}

#[gpui_kit::test]
fn a_markdown_file_shows_rendered_or_as_source(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    host.add(artifact("a1", "plan.md", "file", "subagent_writeback", 9), b"# Plan\n\nGo");
    let face = Face::open(host, cx);
    face.open_preview("a1", cx);
    assert!(face.exists("files-markdown", cx), "rendered at first");
    assert!(!face.exists("files-code-box", cx));
    face.click("files-source", cx);
    assert!(face.exists("files-code-box", cx));
    assert_eq!(face.editor(cx).1, "markdown");
    face.click("files-rendered", cx);
    assert!(face.exists("files-markdown", cx));
}

/// Clicks the first line of the rendered text in `region` and says what
/// the platform was asked to open (the last address since the face opened).
fn click_first_line(face: &Face, region: &str, cx: &mut TestAppContext) -> Option<String> {
    // Inside the region's 16 px side and 12 px top inset, on the first line.
    let region = region.to_owned();
    face.with_window(cx, |window, cx| window.click_at(region, point(px(40.), px(20.)), cx));
    cx.opened_url()
}

/// A link clicked in rendered Markdown or a rendered page opens only a
/// web or mail address (Desktop's rule): a `javascript:` link, a relative
/// path, a fragment and a `file:` address do nothing; a web address opens
/// through the platform, which also shows the click reaches the link.
#[gpui_kit::test]
fn a_rendered_link_opens_only_a_web_or_mail_address(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    let hrefs = [
        "javascript:alert(1)",
        "notes/other",
        "#plan",
        "file:///etc/hosts",
        "https://example.com/report",
    ];
    let mut files = Vec::new();
    for (n, href) in hrefs.iter().enumerate() {
        let markdown = format!("[Follow this link to the page]({href})");
        let page = format!("<p><a href=\"{href}\">Follow this link to the page</a></p>");
        for (kind, name, region, text) in
            [("file", "md", "files-markdown", markdown), ("html", "html", "files-html", page)]
        {
            let id = format!("{name}{n}");
            let listed =
                artifact(&id, &format!("{id}.{name}"), kind, "subagent_writeback", text.len());
            host.add(listed, text.as_bytes());
            files.push((id, region, *href));
        }
    }
    let face = Face::open(host, cx);
    for (id, region, href) in files {
        face.open_preview(&id, cx);
        let opened = click_first_line(&face, region, cx);
        let expected = href.starts_with("https:").then(|| href.to_owned());
        assert_eq!(opened, expected, "{id}: {href}");
        face.press("escape", cx);
    }
}

#[gpui_kit::test]
fn a_diff_shows_in_the_kits_diff(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    let diff = "--- a/x.rs\n+++ b/x.rs\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n";
    host.add(
        artifact("a1", "change.diff", "diff", "subagent_writeback", diff.len()),
        diff.as_bytes(),
    );
    let face = Face::open(host, cx);
    face.open_preview("a1", cx);
    assert!(face.body(cx, |body, _| matches!(body, Body::Text(text) if text.has_diff())));
    assert!(face.exists("files-code-box", cx));
    assert!(!face.exists("files-view-mode", cx), "a diff does not render");
}

/// A page with a style and a script in its head, padded with a comment
/// past `read_text`'s 32 KiB: read whole in chunks, it opens Rendered, the
/// view holding its heading and table and nothing of its scripts or
/// styles. Source shows its markup.
#[gpui_kit::test]
fn an_html_page_opens_rendered_without_its_scripts_or_styles(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    let padding = "x".repeat(ARTIFACT_READ_CHUNK_MAX_BYTES);
    let page = format!(
        "<!doctype html><html><head><style>body {{ color: red }}</style>\
         <script>alert('from the head')</script></head><body>\
         <h1>Quarterly report</h1><p>Revenue by region.</p>\
         <table><thead><tr><th>Region</th><th>Revenue</th></tr></thead>\
         <tbody><tr><td>North</td><td>42</td></tr></tbody></table>\
         <!-- {padding} --><script>document.write('from the body')</script></body></html>"
    );
    host.add(artifact("a1", "report.html", "html", "tool_result", page.len()), page.as_bytes());
    let face = Face::open(host, cx);
    face.open_preview("a1", cx);
    assert_eq!(face.text(cx), (page.clone(), true), "read whole");
    assert_eq!(face.host.requests("artifact.query:read_chunk").len(), 2);
    assert!(face.exists("files-html", cx), "rendered at first");
    assert!(!face.exists("files-code-box", cx));
    let shown = face.rendered(cx).expect("rendered");
    for text in ["Quarterly report", "Revenue by region.", "Region", "Revenue", "North", "42"] {
        assert!(shown.contains(text), "{text:?} in {shown:?}");
    }
    for text in ["alert", "color", "document.write", "from the", "xxxx"] {
        assert!(!shown.contains(text), "{text:?} in {shown:?}");
    }
    assert!(face.label("files-preview-meta", cx).expect("meta").starts_with("HTML, "));
    assert!(!face.exists(domain_element_id("settings-status", "files-render-limit"), cx));

    face.click("files-source", cx);
    assert!(face.exists("files-code-box", cx) && !face.exists("files-html", cx));
    assert_eq!(face.editor(cx), (page, "html".to_owned()), "its markup");
    face.click("files-rendered", cx);
    assert!(face.exists("files-html", cx));
}

/// A page past 256 KB (Desktop's bound) shows as source: only its first
/// chunk is read, the toggle is off and a line says why. Read whole with
/// Show all, it stays source; a page of exactly 256 KB renders.
#[gpui_kit::test]
fn an_html_page_past_256_kb_shows_as_source_with_the_toggle_off(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    let limit = usize::try_from(crate::policy::HTML_RENDER_MAX_BYTES).expect("limit");
    let padded = |size: usize| {
        let mut page = "<h1>Log</h1><!-- ".to_owned();
        page.push_str(&"x".repeat(size - page.len() - 4));
        page.push_str(" -->");
        page
    };
    let big = padded(limit + 1);
    host.add(artifact("a1", "log.html", "html", "tool_result", big.len()), big.as_bytes());
    let edge = padded(limit);
    host.add(artifact("a2", "edge.html", "html", "tool_result", edge.len()), edge.as_bytes());
    let face = Face::open(host, cx);
    face.open_preview("a1", cx);
    assert_eq!(face.host.requests("artifact.query:read_chunk").len(), 1, "not read whole");
    assert!(face.exists("files-code-box", cx) && !face.exists("files-html", cx));
    assert!(face.body(cx, |body, _| matches!(body, Body::Text(text) if !text.is_renderable())));
    face.click("files-rendered", cx);
    assert!(!face.exists("files-html", cx), "Rendered does nothing");
    let line = face.label(domain_element_id("settings-status", "files-render-limit"), cx);
    assert_eq!(line, Some(copy::render_limit(Locale::English, "256 KB")));
    face.click("files-show-all", cx);
    assert_eq!(face.text(cx), (big.clone(), true));
    assert!(!face.exists("files-html", cx), "whole, still past the bound");
    // The line's Open in Default App hands the browser a copy of the page.
    face.click("files-render-open", cx);
    let path = face.scratch.join("copies").join("s1").join("a1.html");
    assert_eq!(*face.opened.borrow(), std::slice::from_ref(&path));
    assert_eq!(std::fs::read(&path).expect("copy"), big.as_bytes());
    face.press("escape", cx);

    face.open_preview("a2", cx);
    assert!(face.exists("files-html", cx), "exactly 256 KB renders");
    assert_eq!(face.rendered(cx).as_deref().map(str::trim), Some("Log"));
}

/// A `file` whose name or media type says HTML is a page too.
#[gpui_kit::test]
fn an_html_file_renders_as_a_page(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    let page = "<h2>Findings</h2><ul><li>First</li></ul><script>alert(1)</script>";
    let named = artifact("a1", "findings.html", "file", "subagent_writeback", page.len());
    host.add(named, page.as_bytes());
    let mut typed = artifact("a2", "findings", "file", "deep_research", page.len());
    typed["mimeType"] = json!("text/html; charset=utf-8");
    host.add(typed, page.as_bytes());
    let face = Face::open(host, cx);
    for id in ["a1", "a2"] {
        face.open_preview(id, cx);
        assert!(face.exists("files-html", cx), "{id}");
        let shown = face.rendered(cx).expect("rendered");
        assert!(shown.contains("Findings") && shown.contains("First"), "{id}: {shown:?}");
        assert!(!shown.contains("alert"), "{id}: {shown:?}");
        assert_eq!(face.editor(cx).1, "html", "{id}");
        assert_eq!(face.menu_items(cx), ["files-copy", "files-save", "files-open"], "{id}");
        face.press("escape", cx);
    }
}

/// Open in Default App hands the browser a page as a `.html` copy under
/// the launch's directory, named by its ids whatever its own name, holding
/// the page's bytes alone.
#[gpui_kit::test]
fn open_in_default_app_writes_an_html_copy_of_the_page(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    let page = b"<h1>Chart</h1><canvas id='c'></canvas><script src='chart.js'></script>";
    host.add(artifact("a1", "../chart.command", "html", "tool_result", page.len()), page);
    let mut typed = artifact("a2", "chart", "file", "subagent_writeback", page.len());
    typed["mimeType"] = json!("text/html");
    host.add(typed, page);
    let face = Face::open(host, cx);
    for id in ["a1", "a2"] {
        face.open_preview(id, cx);
        face.click("files-more", cx);
        face.click(menu_item("files-open"), cx);
        let path = face.scratch.join("copies").join("s1").join(format!("{id}.html"));
        assert_eq!(face.opened.borrow().last(), Some(&path), "{id}");
        assert_eq!(std::fs::read(&path).expect("copy"), page, "{id}");
        let siblings = std::fs::read_dir(path.parent().expect("dir")).expect("dir").count();
        assert_eq!(siblings, face.opened.borrow().len(), "{id}: the page alone");
        face.press("escape", cx);
    }
}

#[gpui_kit::test]
fn an_image_fits_the_face_and_a_click_shows_its_actual_size(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    host.add(artifact("a1", "dot.png", "image", "subagent_writeback", PNG.len()), PNG);
    let face = Face::open(host, cx);
    face.open_preview("a1", cx);
    let actual = |face: &Face, cx: &mut TestAppContext| {
        face.body(cx, |body, _| match body {
            Body::Image(image) => image.is_actual_size(),
            other => panic!("not an image: {other:?}"),
        })
    };
    assert!(!actual(&face, cx));
    assert_eq!(face.label("files-image", cx), Some(en(copy::IMAGE_FIT)));
    face.click("files-image", cx);
    assert!(actual(&face, cx));
    assert_eq!(face.label("files-image", cx), Some(en(copy::IMAGE_ACTUAL)));
    face.focus(cx);
    face.press("space", cx);
    assert!(!actual(&face, cx), "Space fits it again");
}

#[gpui_kit::test]
fn an_image_past_32_kib_is_read_in_chunks_and_its_format_told_by_its_bytes(
    cx: &mut TestAppContext,
) {
    let host = ScriptedHost::new();
    // A PNG with padding after its end: past `read_binary`'s 32 KiB.
    let mut big = PNG.to_vec();
    big.resize(ARTIFACT_READ_CHUNK_MAX_BYTES * 2 + 10, 0);
    let mut listed = artifact("a1", "big", "image", "subagent_writeback", big.len());
    listed["mimeType"] = json!("application/octet-stream");
    host.add(listed, &big);
    let face = Face::open(host, cx);
    face.open_preview("a1", cx);
    assert_eq!(face.host.requests("artifact.query:read_binary").len(), 1);
    assert_eq!(face.host.requests("artifact.query:read_chunk").len(), 3);
    face.body(cx, |body, _| match body {
        Body::Image(image) => {
            assert_eq!(image.bytes().len(), big.len());
            assert_eq!(image.kind(), Some(crate::policy::ImageType::Png), "not its media type");
        }
        other => panic!("not an image: {other:?}"),
    });
}

#[gpui_kit::test]
fn a_pdf_offers_the_default_app_and_save_as_without_reading(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    host.add(artifact("a1", "report.pdf", "pdf", "deep_research", 9), b"%PDF-1.7\n");
    let face = Face::open(host, cx);
    face.open_preview("a1", cx);
    assert_eq!(face.why(cx), Some(en(copy::WHY_PDF)));
    assert!(face.exists("files-body-open", cx) && face.exists("files-body-save", cx));
    let reads = ["read_text", "read_binary", "read_chunk"]
        .iter()
        .map(|kind| face.host.requests(&format!("artifact.query:{kind}")).len())
        .sum::<usize>();
    assert_eq!(reads, 0);
    // Opening reads it now and hands a copy, named by its ids, to the
    // stubbed opener.
    face.click("files-body-open", cx);
    let opened = face.opened.borrow().clone();
    assert_eq!(opened, [face.scratch.join("copies").join("s1").join("a1.pdf")]);
    assert_eq!(std::fs::read(&opened[0]).expect("copy"), b"%PDF-1.7\n");
}

/// Each preview failure's line, and whether it offers Retry or Save As.
#[gpui_kit::test]
fn every_failure_says_what_a_person_can_do(cx: &mut TestAppContext) {
    let unavailable = |reason: &str| {
        Ok(json!({"kind": "text", "sessionId": "s1", "artifactId": "a1",
                  "preview": {"ok": false, "reason": reason}}))
    };
    let cases: Vec<(&str, Result<Value, HostRequestError>, Text, bool, bool)> = vec![
        ("not_found", unavailable("not_found"), copy::WHY_NOT_FOUND, false, false),
        ("read_failed", unavailable("read_failed"), copy::WHY_READ_FAILED, true, false),
        ("not_allowed", unavailable("not_allowed"), copy::WHY_NOT_ALLOWED, false, false),
        ("unknown", unavailable("quota_exceeded"), copy::WHY_UNEXPECTED, true, false),
        (
            "transport",
            Err(HostRequestError::Transport("broken pipe".into())),
            copy::WHY_DISCONNECTED,
            true,
            false,
        ),
        (
            "host",
            Err(HostRequestError::Operation {
                operation: "artifact.query",
                code: HostOperationErrorCode::Unauthorized,
                message: "This connection may not read files".into(),
            }),
            copy::WHY_HOST,
            true,
            false,
        ),
        ("future result", Ok(json!({"kind": "thumbnail"})), copy::WHY_UNEXPECTED, true, false),
    ];
    for (case, reply, text, retry, save) in cases {
        let host = ScriptedHost::new();
        host.add(artifact("a1", "notes.txt", "file", "deep_research", 3), b"abc");
        host.reply("artifact.query:read_text", reply);
        let face = Face::open(host, cx);
        face.open_preview("a1", cx);
        let expected = if text == copy::WHY_HOST {
            copy::why_host(Locale::English, "This connection may not read files")
        } else {
            en(text)
        };
        assert_eq!(face.why(cx), Some(expected), "{case}");
        assert_eq!(face.exists("files-retry", cx), retry, "{case}: Retry");
        assert_eq!(face.exists("files-body-save", cx), save, "{case}: Save As");
        if retry {
            face.click("files-retry", cx);
            assert_eq!(face.text(cx).0, "abc", "{case}: Retry reads it again");
        }
    }
}

#[gpui_kit::test]
fn images_that_cannot_show_say_so_and_offer_a_copy(cx: &mut TestAppContext) {
    // Unsupported by the Host's sniff.
    let host = ScriptedHost::new();
    host.add(artifact("a1", "notes.img", "image", "subagent_writeback", 5), b"hello");
    let face = Face::open(host, cx);
    face.open_preview("a1", cx);
    assert_eq!(face.why(cx), Some(en(copy::WHY_UNSUPPORTED)));
    assert!(face.exists("files-body-save", cx) && !face.exists("files-retry", cx));
    drop(face);

    // Past the preview's 2 MB.
    let host = ScriptedHost::new();
    host.add(artifact("a1", "huge.png", "image", "subagent_writeback", 3 << 20), PNG);
    let face = Face::open(host, cx);
    face.open_preview("a1", cx);
    assert_eq!(face.why(cx), Some(en(copy::WHY_TOO_LARGE)));
    assert!(face.exists("files-body-save", cx));
    assert!(face.host.requests("artifact.query:read_binary").is_empty(), "not read");
    drop(face);

    // AVIF, which the window cannot draw: read in chunks, told by its
    // bytes, shown as a line with Save As and Open in Default App.
    let host = ScriptedHost::new();
    let mut avif = b"\0\0\0\x1cftypavif".to_vec();
    avif.resize(ARTIFACT_READ_CHUNK_MAX_BYTES + 5, 0);
    host.add(artifact("a1", "photo.avif", "image", "subagent_writeback", avif.len()), &avif);
    let face = Face::open(host, cx);
    face.open_preview("a1", cx);
    assert_eq!(face.why(cx), Some(en(copy::WHY_UNSUPPORTED)));
    assert!(face.exists("files-body-open", cx) && face.exists("files-body-save", cx));
    assert_eq!(face.menu_items(cx), ["files-save", "files-open"]);
}

#[gpui_kit::test]
fn a_failed_show_more_says_why_and_retries(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    let text = "x".repeat(ARTIFACT_READ_CHUNK_MAX_BYTES * 2);
    host.add(artifact("a1", "big.txt", "file", "deep_research", text.len()), text.as_bytes());
    let face = Face::open(host, cx);
    face.open_preview("a1", cx);
    face.host.reply(
        "artifact.query:read_chunk",
        Err(HostRequestError::Operation {
            operation: "artifact.query",
            code: HostOperationErrorCode::InvalidRequest,
            message: "Artifact chunk offset is invalid".into(),
        }),
    );
    face.click("files-show-more", cx);
    let line = face.label(domain_element_id("settings-status", "files-more-failure"), cx);
    assert_eq!(line, Some(en(copy::WHY_CHANGED)));
    face.click("files-more-retry", cx);
    assert_eq!(face.text(cx), (text, true));
}

#[gpui_kit::test]
fn a_binary_file_is_not_shown_as_text(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    host.add(artifact("a1", "archive.bin", "file", "subagent_writeback", 6), b"PK\x03\x04\0\0");
    host.add(artifact("a2", "deck.pptx", "file", "subagent_writeback", 3), b"abc");
    let face = Face::open(host, cx);
    face.open_preview("a1", cx);
    assert_eq!(face.why(cx), Some(en(copy::WHY_NOT_TEXT)));
    assert_eq!(face.menu_items(cx), ["files-save"], "no Copy for bytes that are not text");
    face.press("escape", cx);
    face.open_preview("a2", cx);
    assert_eq!(face.why(cx), Some(en(copy::WHY_NOT_TEXT)));
    assert!(
        face.host.requests("artifact.query:read_text").len() == 1,
        "an Office file is not read"
    );
}

#[gpui_kit::test]
fn copy_is_offered_for_text_kinds_only_and_copies_the_text(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    host.add(artifact("f", "a.txt", "file", "deep_research", 5), b"hello");
    host.add(artifact("d", "a.diff", "diff", "deep_research", 3), b"abc");
    host.add(artifact("h", "a.html", "html", "tool_result", 3), b"<p>");
    host.add(artifact("i", "a.png", "image", "deep_research", PNG.len()), PNG);
    host.add(artifact("p", "a.pdf", "pdf", "deep_research", 5), b"%PDF-");
    let face = Face::open(host, cx);
    for (id, items) in [
        ("f", vec!["files-copy", "files-save"]),
        ("d", vec!["files-copy", "files-save"]),
        ("h", vec!["files-copy", "files-save", "files-open", "files-delete"]),
        ("i", vec!["files-save", "files-open"]),
        ("p", vec!["files-save", "files-open"]),
    ] {
        face.open_preview(id, cx);
        assert_eq!(face.menu_items(cx), items, "{id}");
        face.press("escape", cx);
    }
    face.open_preview("f", cx);
    face.click("files-more", cx);
    face.click(menu_item("files-copy"), cx);
    let copied =
        face.with_window(cx, |_, cx| cx.read_from_clipboard().and_then(|item| item.text()));
    assert_eq!(copied.as_deref(), Some("hello"));
    assert_eq!(face.notice(cx), Some((true, "Copied a.txt".to_owned(), None)));
}

#[gpui_kit::test]
fn delete_asks_by_name_then_returns_to_the_list(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    host.add(artifact("a1", "brief.md", "file", "deep_research", 3), b"abc");
    host.add(artifact("a2", "report.html", "html", "tool_result", 3), b"<p>");
    let face = Face::open(host, cx);
    face.open_preview("a2", cx);
    face.click("files-more", cx);
    face.click(menu_item("files-delete"), cx);
    assert_eq!(face.label("dialog-title", cx).as_deref(), Some("Delete “report.html”?"));
    assert!(face.host.requests("artifact.delete").is_empty(), "nothing before the answer");
    // Cancel keeps it.
    face.click("cancel", cx);
    assert_eq!(face.previewing(cx).as_deref(), Some("a2"));
    face.click("files-more", cx);
    face.click(menu_item("files-delete"), cx);
    face.click("ok", cx);
    assert_eq!(
        face.host.requests("artifact.delete"),
        [json!({"sessionId": "s1", "artifactId": "a2"})]
    );
    assert_eq!(face.previewing(cx), None, "back to the list");
    let ids = face.view.read_with(cx, |view, cx| view.shown_ids(cx));
    assert_eq!(ids, ["a1"], "read again without it");
}

#[gpui_kit::test]
fn a_refused_delete_says_why(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    host.add(artifact("a1", "report.html", "html", "tool_result", 3), b"<p>");
    host.reply(
        "artifact.delete",
        Err(HostRequestError::Operation {
            operation: "artifact.delete",
            code: HostOperationErrorCode::OperationConflict,
            message: "Runtime-owned evidence cannot be deleted".into(),
        }),
    );
    host.reply(
        "artifact.delete",
        Err(HostRequestError::Operation {
            operation: "artifact.delete",
            code: HostOperationErrorCode::NotFound,
            message: "Artifact was not found".into(),
        }),
    );
    let face = Face::open(host, cx);
    face.open_preview("a1", cx);
    face.click("files-more", cx);
    face.click(menu_item("files-delete"), cx);
    face.click("ok", cx);
    assert_eq!(
        face.notice(cx),
        Some((false, "Couldn’t delete report.html.".to_owned(), Some(en(copy::WHY_PROTECTED))))
    );
    assert_eq!(face.previewing(cx).as_deref(), Some("a1"), "it stays");
    face.click("files-more", cx);
    face.click(menu_item("files-delete"), cx);
    face.click("ok", cx);
    assert_eq!(face.notice(cx), Some((true, en(copy::WHY_ALREADY_DELETED), None)));
    assert_eq!(face.previewing(cx), None);
}

#[gpui_kit::test]
fn save_as_asks_where_then_writes_every_chunk_there(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    let bytes: Vec<u8> =
        (0..ARTIFACT_READ_CHUNK_MAX_BYTES * 3 + 7).map(|n| (n % 253) as u8).collect();
    host.add(artifact("a1", "../../evil/report.pdf", "pdf", "deep_research", bytes.len()), &bytes);
    let face = Face::open(host, cx);
    face.open_preview("a1", cx);
    // Cancelled: nothing is read.
    face.click("files-body-save", cx);
    assert_eq!(*face.suggested.borrow(), ["report.pdf"], "the name's last part, made safe");
    assert!(face.host.requests("artifact.query:read_chunk").is_empty());
    assert!(!face.view.read_with(cx, |view, _| view.is_busy()));

    std::fs::create_dir_all(&face.scratch).expect("scratch");
    let target = face.scratch.join("saved.pdf");
    *face.save_to.borrow_mut() = Some(target.clone());
    face.click("files-more", cx);
    face.click(menu_item("files-save"), cx);
    assert_eq!(face.host.requests("artifact.query:read_chunk").len(), 4);
    assert_eq!(std::fs::read(&target).expect("saved"), bytes);
    assert_eq!(face.notice(cx), Some((true, "Saved ../../evil/report.pdf".to_owned(), None)));
    assert!(face.opened.borrow().is_empty(), "saving opens nothing");
}

#[gpui_kit::test]
fn open_in_default_app_writes_a_raster_copy_named_by_ids(cx: &mut TestAppContext) {
    let host = ScriptedHost::new();
    host.add(artifact("a1", "../dot.command", "image", "subagent_writeback", PNG.len()), PNG);
    let svg = b"<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>";
    host.add(artifact("a2", "logo.svg", "image", "subagent_writeback", svg.len()), svg);
    let face = Face::open(host, cx);
    face.open_preview("a1", cx);
    face.click("files-more", cx);
    face.click(menu_item("files-open"), cx);
    let path = face.scratch.join("copies").join("s1").join("a1.png");
    assert_eq!(
        *face.opened.borrow(),
        std::slice::from_ref(&path),
        "by its ids and bytes, not its name"
    );
    assert_eq!(std::fs::read(&path).expect("copy"), PNG);
    face.press("escape", cx);
    // An SVG would run its scripts in a browser: Save As only.
    face.open_preview("a2", cx);
    assert_eq!(face.menu_items(cx), ["files-save"]);
}
