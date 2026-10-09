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

//! Checks that an assistant reply wraps inside its column, with the
//! platform's real text system, and exits non-zero when it does not.
//!
//! ```sh
//! cargo run -p conversation --example wrap_check [-- <min-px> <max-px>]
//! ```
//!
//! For each column width from `min-px` to `max-px` (300 to 720 by default,
//! 720 being the reading column's widest) it draws a reply in a fresh
//! headless window, as the transcript draws assistant text, and reads every
//! glyph the frame paints. A glyph that ends more than 1 px past the column,
//! or past the clip it is painted in, is a failure. The reply is the one in
//! which a list item's line ended in a half-cut character: a paragraph with
//! inline code and CJK punctuation, which gpui-base before 0.7.1 wrapped by
//! adding up each character's width measured alone (a lone CJK punctuation
//! mark measures half the width it takes in a line).
//!
//! It opens no window on screen: the platform is asked only for its text
//! system (CoreText on macOS), and the frames go to an in-memory renderer.
//! The results depend on the system fonts, so run it on macOS.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use gpui_kit::component::Root;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AppContext as _, Bounds, Context, DevicePixels, HeadlessAppContext, HeadlessAtlas,
    InteractiveElement as _, IntoElement, ParentElement as _, Pixels, PlatformAtlas,
    PlatformHeadlessRenderer, PlatformTextSystem, Render, ScaledPixels, Scene, Size, Styled as _,
    TestSupportExt as _, Window, div, px, size,
};

/// A real reply whose first list item, at the 720 px column, ended its
/// first line in a half-cut "新" before the fix.
const REPLY: &str = "**生效方式**\n\n\
- Maka 的 Session 在启动时绑定 MCP 配置（工具列表会冻结），当前这个会话是在 `mcp.json` 创建前开的，所以需要**新开一个 Maka 会话**（或重启当前对话）才能看到 opencli-mcp 的工具（`js`、`sites_search`、`doctor` 等）\n\
- 浏览器服务本身已在运行：Chrome 扩展已连上 host（端口 19991），新会话绑定后即可直接操作你已登录的 Chrome 标签页\n\n\
之后如果想给其他工作区也启用，把同样的 `mcp.json` 复制到对应工作区根目录即可；想全局禁用时把 `enabled` 改为 `false` 或删除该文件。\n";

/// How far a glyph's painted bounds may pass an edge: antialiasing.
const TOLERANCE: f32 = 1.;

const COLUMN: &str = "wrap-check-column";

/// A painted glyph: its bounds and the clip it is painted in.
#[derive(Clone, Copy)]
struct Glyph {
    bounds: Bounds<ScaledPixels>,
    clip: Bounds<ScaledPixels>,
}

/// Keeps the glyphs of the last frame drawn to an image.
struct GlyphRecorder {
    atlas: Arc<HeadlessAtlas>,
    glyphs: Rc<RefCell<Vec<Glyph>>>,
}

impl PlatformHeadlessRenderer for GlyphRecorder {
    fn render_scene_to_image(
        &mut self,
        scene: &Scene,
        _: Size<DevicePixels>,
    ) -> gpui_kit::Result<image::RgbaImage> {
        let monochrome = scene
            .monochrome_sprites
            .iter()
            .map(|sprite| Glyph { bounds: sprite.bounds, clip: sprite.content_mask.bounds });
        let subpixel = scene
            .subpixel_sprites
            .iter()
            .map(|sprite| Glyph { bounds: sprite.bounds, clip: sprite.content_mask.bounds });
        *self.glyphs.borrow_mut() = monochrome.chain(subpixel).collect();
        Ok(image::RgbaImage::new(1, 1))
    }

    fn render_scene(&mut self, _: &Scene, _: Size<DevicePixels>) -> gpui_kit::Result<()> {
        Ok(())
    }

    fn sprite_atlas(&self) -> Arc<dyn PlatformAtlas> {
        self.atlas.clone()
    }
}

/// The reply in a column of the given width.
struct Column {
    width: Pixels,
}

impl Render for Column {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(
            div().id(COLUMN).test_support().w(self.width).child(conversation::assistant_text(
                "wrap-check-reply",
                REPLY,
                window,
                cx,
            )),
        )
    }
}

/// Draws the reply at `width` and describes the glyphs that pass the
/// column's right edge or their clip.
fn overflows(text_system: Arc<dyn PlatformTextSystem>, width: f32) -> Vec<String> {
    let glyphs: Rc<RefCell<Vec<Glyph>>> = Rc::default();
    let recorded = glyphs.clone();
    let mut cx = HeadlessAppContext::with_platform(text_system, Arc::new(()), move || {
        Ok(Some(Box::new(GlyphRecorder {
            atlas: Arc::new(HeadlessAtlas::default()),
            glyphs: recorded.clone(),
        }) as Box<dyn PlatformHeadlessRenderer>))
    });
    cx.update(|cx| {
        gpui_kit::init(cx);
        conversation::init(cx);
    });
    let window = cx
        .open_window(size(px(width + 200.), px(1200.)), |window, cx| {
            let column = cx.new(|_| Column { width: px(width) });
            cx.new(|cx| Root::new(column, window, cx))
        })
        .expect("open a headless window");
    let (column, scale) = cx
        .update_window(window.into(), |_, window, cx| {
            window.render_frame(cx);
            window.render_to_image().expect("draw the frame");
            (window.find(COLUMN).bounds(), window.scale_factor())
        })
        .expect("update the window");
    let column_right = f32::from(column.right());
    let glyphs = glyphs.borrow().clone();
    glyphs
        .iter()
        .filter_map(|glyph| {
            let right = (glyph.bounds.origin.x + glyph.bounds.size.width).0 / scale;
            let clip_right = (glyph.clip.origin.x + glyph.clip.size.width).0 / scale;
            let top = glyph.bounds.origin.y.0 / scale;
            let past_column = right - column_right;
            let past_clip = right - clip_right;
            (past_column > TOLERANCE || past_clip > TOLERANCE).then(|| {
                format!(
                    "glyph at y {top:.1} ends at {right:.1} px: {past_column:.1} px past the \
                     column, {past_clip:.1} px past its clip"
                )
            })
        })
        .collect()
}

fn width_arg(args: &[String], ix: usize, default: u32) -> u32 {
    args.get(ix).map_or(default, |arg| arg.parse().expect("a width in whole pixels"))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let min = width_arg(&args, 1, 300);
    let max = width_arg(&args, 2, 720);
    let text_system = gpui_kit::platform::current_platform(true).text_system();
    let mut failed = 0;
    for width in min..=max {
        let overflows = overflows(text_system.clone(), width as f32);
        if overflows.is_empty() {
            continue;
        }
        failed += 1;
        for overflow in overflows {
            println!("{width} px: {overflow}");
        }
    }
    println!(
        "{} widths from {min} to {max} px, {failed} with a glyph past its column",
        max - min + 1
    );
    if failed > 0 {
        std::process::exit(1);
    }
}
