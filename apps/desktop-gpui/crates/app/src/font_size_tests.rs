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

//! The UI font size (Settings › Appearance) scales the whole window through
//! the kit's rem: the sidebar, a transcript recorded from a real Host, the
//! footer menu and settings, measured by the sizes the window lays its text
//! out at, and laid out at the smallest size without clipping.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_lite::future::Boxed;
use gpui_kit::component::Root;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AppContext as _, Bounds, DevicePixels, Font, FontId, FontMetrics, FontRun, GlyphId,
    InputEvent as _, KeyUpEvent, Keystroke, LineLayout, NoopTextSystem, Pixels, PlatformTextSystem,
    RenderGlyphParams, Size, TestAppContext, TestDispatcher, TextRenderingMode, px, size,
};
use host_client::{ConnectionEvent, HostEvent};
use host_protocol::HostAccepted;
use serde_json::{Value, json};
use shared::domain_element_id;
use workspace::{HostRequestError, HostSession, HostTransport, UnavailableProjectCatalog};

use crate::Workbench;

const OPEN_RESULT: &str =
    include_str!("../../host-protocol/fixtures/subscription_open.response.json");

/// The recorded session, and a second task beside it in the sidebar.
const RECORDED: &str = "fixture-0c5d82e0c9ec4aa3b61ad19214992554";

/// The test platform's text system, recording the size of every line laid
/// out: what the window draws its text at.
struct Recording {
    inner: NoopTextSystem,
    lines: Mutex<Vec<(String, Pixels)>>,
}

impl Recording {
    fn new() -> Self {
        Self { inner: NoopTextSystem::new(), lines: Mutex::new(Vec::new()) }
    }

    fn lines(&self) -> Vec<(String, Pixels)> {
        self.lines.lock().expect("lines").clone()
    }
}

impl PlatformTextSystem for Recording {
    fn add_fonts(&self, fonts: Vec<Cow<'static, [u8]>>) -> gpui_kit::Result<()> {
        self.inner.add_fonts(fonts)
    }

    fn all_font_names(&self) -> Vec<String> {
        self.inner.all_font_names()
    }

    fn font_id(&self, descriptor: &Font) -> gpui_kit::Result<FontId> {
        self.inner.font_id(descriptor)
    }

    fn font_metrics(&self, font_id: FontId) -> FontMetrics {
        self.inner.font_metrics(font_id)
    }

    fn typographic_bounds(&self, font_id: FontId, glyph: GlyphId) -> gpui_kit::Result<Bounds<f32>> {
        self.inner.typographic_bounds(font_id, glyph)
    }

    fn advance(&self, font_id: FontId, glyph: GlyphId) -> gpui_kit::Result<Size<f32>> {
        self.inner.advance(font_id, glyph)
    }

    fn glyph_for_char(&self, font_id: FontId, ch: char) -> Option<GlyphId> {
        self.inner.glyph_for_char(font_id, ch)
    }

    fn glyph_raster_bounds(
        &self,
        params: &RenderGlyphParams,
    ) -> gpui_kit::Result<Bounds<DevicePixels>> {
        self.inner.glyph_raster_bounds(params)
    }

    fn rasterize_glyph(
        &self,
        params: &RenderGlyphParams,
        raster_bounds: Bounds<DevicePixels>,
    ) -> gpui_kit::Result<(Size<DevicePixels>, Vec<u8>)> {
        self.inner.rasterize_glyph(params, raster_bounds)
    }

    fn layout_line(&self, text: &str, font_size: Pixels, runs: &[FontRun]) -> LineLayout {
        self.lines.lock().expect("lines").push((text.to_owned(), font_size));
        self.inner.layout_line(text, font_size, runs)
    }

    fn recommended_rendering_mode(&self, font_id: FontId, font_size: Pixels) -> TextRenderingMode {
        self.inner.recommended_rendering_mode(font_id, font_size)
    }
}

/// Lists two tasks, the recorded one with its transcript.
struct Host;

impl HostTransport for Host {
    fn request(
        &self,
        operation: &'static str,
        input: Value,
        _: Duration,
    ) -> Boxed<Result<Value, HostRequestError>> {
        let result = match operation {
            "session.catalog.query" => Ok(json!({
                "kind": "page",
                "revision": format!("sha256:{}", "0".repeat(64)),
                "sessions": [session(RECORDED, "Summarize the repository"), session("s2", "Alpha")],
                "nextCursor": null
            })),
            "subscription.open" => {
                let fixture: Value = serde_json::from_str(OPEN_RESULT).expect("fixture");
                Ok(fixture["result"].clone())
            }
            "subscription.ready" | "subscription.close" => {
                Ok(json!({"subscriptionId": input["subscriptionId"]}))
            }
            other => Err(HostRequestError::Transport(format!("unscripted {other}").into())),
        };
        Box::pin(async move { result })
    }
}

fn session(id: &str, name: &str) -> Value {
    json!({
        "id": id, "revision": 1,
        "workspace": {"target": {"kind": "host_path", "path": "/work/demo"}, "hostCwd": "/work/demo"},
        "createdAt": 1, "activityAt": 2, "name": name, "isFlagged": false, "isArchived": false,
        "labels": [], "labelsTruncated": false, "hasUnread": false, "status": "active",
        "backend": "ai-sdk", "llmConnectionId": null, "llmConnectionSlug": "env",
        "connectionLocked": false, "model": "m", "permissionMode": "ask",
        "collaborationMode": "agent", "orchestrationMode": "default"
    })
}

fn accepted() -> HostAccepted {
    let fixture: Value = serde_json::from_str(OPEN_RESULT).expect("fixture");
    serde_json::from_value(json!({
        "kind": "accepted", "rootId": "r", "hostEpoch": fixture["result"]["hostEpoch"],
        "connectionId": "c", "selectedProtocol": 0, "compatibilityEpoch": 197,
        "compositionId": "maka.interactive", "compositionRevision": "3", "state": "ready"
    }))
    .expect("accepted")
}

fn settle(cx: &mut TestAppContext) {
    cx.run_until_parked();
    cx.executor().advance_clock(conversation::COMMIT_INTERVAL * 2);
    cx.run_until_parked();
}

/// What the window draws at a UI font size.
struct Drawn {
    /// Every line of text laid out, with its size.
    lines: Vec<(String, Pixels)>,
    /// Every observed element drawn outside the nearest observed element
    /// around it, by its path.
    overflows: BTreeSet<String>,
}

/// The observed elements of the last frame that stick out of the nearest
/// observed element around them.
fn overflows(window: &gpui_kit::Window) -> BTreeSet<String> {
    let all = gpui_kit::base::test_support::snapshots(window);
    let tolerance = px(0.5);
    all.iter()
        .filter(|element| element.visible())
        .filter(|element| {
            let path = element.path();
            let around = all
                .iter()
                .filter(|outer| outer.path().len() < path.len() && path.starts_with(outer.path()))
                .max_by_key(|outer| outer.path().len());
            around.is_some_and(|outer| {
                let (inner, outer) = (element.bounds(), outer.bounds());
                inner.left() < outer.left() - tolerance
                    || inner.top() < outer.top() - tolerance
                    || inner.right() > outer.right() + tolerance
                    || inner.bottom() > outer.bottom() + tolerance
            })
        })
        .map(|element| format!("{:?}", element.path()))
        .collect()
}

/// What the window draws at the UI font size `ui_font_size`: the sidebar
/// with two tasks, the recorded task's transcript and the composer, the
/// footer menu with its Language submenu, and settings at Appearance.
fn drawn_at(ui_font_size: u8) -> Drawn {
    let recording = Arc::new(Recording::new());
    let mut cx =
        TestAppContext::build_with_text_system(TestDispatcher::new(0), None, recording.clone());
    let cx = &mut cx;
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::init(cx);
        cx.set_reduce_motion(true);
        settings::choose_ui_font_size(ui_font_size, cx);
    });
    let host =
        cx.new(|_| HostSession::with_transport(PathBuf::from("/tmp/.dev-root"), Arc::new(Host)));
    let mut workbench = None;
    // Wide enough for the sidebar beside the composer at the largest size
    // (65rem), so the sidebar's text is drawn at every size.
    let window = cx.open_window(size(px(1680.), px(885.)), |window, cx| {
        let view = cx
            .new(|cx| Workbench::new(host.clone(), Rc::new(UnavailableProjectCatalog), window, cx));
        workbench = Some(view.clone());
        Root::new(view, window, cx)
    });
    let workbench = workbench.expect("workbench");
    host.update(cx, |host, cx| {
        host.handle_host_event(
            HostEvent::Connection(ConnectionEvent::Connected { accepted: accepted() }),
            cx,
        )
    });
    settle(cx);
    let found = RefCell::new(BTreeSet::new());
    let in_window = |cx: &mut TestAppContext,
                     f: &dyn Fn(&mut gpui_kit::Window, &mut gpui_kit::App)| {
        cx.update_window(window.into(), |_, window, cx| {
            window.render_frame(cx);
            f(window, cx);
        })
        .expect("window");
        settle(cx);
        cx.update_window(window.into(), |_, window, cx| {
            window.render_frame(cx);
            found.borrow_mut().extend(overflows(window));
        })
        .expect("window");
    };
    in_window(cx, &|window, cx| window.click(domain_element_id("session-row", RECORDED), cx));
    in_window(cx, &|window, cx| {
        // The footer menu from the keyboard, then its Language submenu.
        window.click(domain_element_id("session-row", RECORDED), cx);
        window.press("tab", cx);
        window.press("enter", cx);
        let keystroke = Keystroke::parse("enter").expect("keystroke");
        window.dispatch_event(KeyUpEvent { keystroke }.to_platform_input(), cx);
    });
    in_window(cx, &|window, cx| {
        // Settings…, then Language.
        window.press("down", cx);
        window.press("down", cx);
        window.press("right", cx);
    });
    in_window(cx, &|window, cx| {
        window.press("escape", cx);
        window.press("escape", cx);
        workbench.update(cx, |workbench, cx| {
            workbench.show_settings(settings::SettingsSection::Appearance, |_, _, _| {}, window, cx)
        });
    });
    in_window(cx, &|_, _| {});
    drop(workbench);
    cx.run_until_parked();
    cx.update(|cx| cx.quit());
    cx.run_until_parked();
    Drawn { lines: recording.lines(), overflows: found.into_inner() }
}

/// The laid-out size of the first line reading `text`.
fn size_of(lines: &[(String, Pixels)], text: &str) -> Option<Pixels> {
    lines.iter().find(|(line, _)| line == text).map(|(_, size)| *size)
}

#[test]
fn every_text_scales_with_the_ui_font_size_from_the_12px_floor() {
    let default = drawn_at(shared::theme::DEFAULT_UI_FONT_SIZE).lines;
    // The sidebar's task titles, a transcript row, and the menus drew.
    assert!(size_of(&default, "Alpha").is_some(), "the sidebar");
    assert!(size_of(&default, shared::copy::SETTINGS_ITEM.en()).is_some(), "the footer menu");
    assert!(size_of(&default, "简体中文").is_some(), "its Language submenu");
    // The recorded message and its reply both end with this sentence; no
    // other text in the window does.
    let transcript =
        default.iter().filter(|(line, _)| line.contains("Hello from the fixture.")).count();
    assert!(transcript > 1, "the transcript's message and reply, not only one of them");
    let smallest_line = |lines: &[(String, Pixels)]| {
        lines
            .iter()
            .filter(|(line, _)| !line.trim().is_empty())
            .min_by(|a, b| a.1.partial_cmp(&b.1).expect("sizes"))
            .cloned()
            .expect("lines")
    };
    // At the default nothing is drawn below the type scale's floor.
    let floor = smallest_line(&default);
    assert!(floor.1 >= px(12.), "{floor:?} is below 12px");
    // Desktop's smallest size scales all of it down, the floor with it.
    let smallest = *settings::UI_FONT_SIZES.start();
    let lines = drawn_at(smallest).lines;
    let scale = f32::from(smallest) / f32::from(shared::theme::DEFAULT_UI_FONT_SIZE);
    assert_eq!(size_of(&lines, "Alpha"), Some(px(f32::from(smallest))));
    let item = shared::copy::SETTINGS_ITEM.en();
    assert_eq!(size_of(&lines, item), size_of(&default, item).map(|size| size * scale));
    let least = smallest_line(&lines);
    assert!((least.1 - floor.1 * scale).abs() < px(0.01), "{least:?} against {floor:?}");
}

#[test]
fn nothing_is_clipped_at_the_smallest_ui_font_size() {
    // The sidebar's rows, the transcript, the composer, the menus and the
    // settings rows lay out at 11px as at the default: no control sticks
    // out of what holds it there unless it does at the default too (a page
    // under its scroller's fold, a menu beside its trigger).
    let default = drawn_at(shared::theme::DEFAULT_UI_FONT_SIZE).overflows;
    let smallest = drawn_at(*settings::UI_FONT_SIZES.start()).overflows;
    let clipped: Vec<_> = smallest.difference(&default).collect();
    assert!(clipped.is_empty(), "outside what holds them at 11px only: {clipped:#?}");
}

#[test]
fn a_larger_ui_font_size_scales_every_text_with_it() {
    let default = drawn_at(shared::theme::DEFAULT_UI_FONT_SIZE).lines;
    let largest = drawn_at(*settings::UI_FONT_SIZES.end()).lines;
    // Body text is the UI font size; supporting text keeps its ratio.
    assert_eq!(size_of(&default, "Alpha"), Some(px(14.)));
    assert_eq!(size_of(&largest, "Alpha"), Some(px(22.)));
    let item = shared::copy::SETTINGS_ITEM.en();
    let (small, large) = (size_of(&default, item), size_of(&largest, item));
    assert_eq!(small.zip(large).map(|(small, large)| large / small), Some(22. / 14.));
}
