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

#[path = "tests/rail.rs"]
mod rail;

pub(super) fn cases() -> [(&'static str, fn()); 2] {
    [
        (
            "native_editor_focus_and_text_do_not_wait_for_another_pixel_frame",
            native_editor_focus_and_text_do_not_wait_for_another_pixel_frame,
        ),
        (
            "every_visible_turn_mark_can_be_clicked_with_cell_coordinates",
            rail::every_visible_turn_mark_can_be_clicked_with_cell_coordinates,
        ),
    ]
}

use nsh_engine::{App, Bundle, EngineConfig};
#[cfg(target_os = "macos")]
use nsh_platform_macos::TerminalSurface;
#[cfg(target_os = "windows")]
use nsh_platform_windows::terminal::TerminalSurface;
use nsh_terminal::{CandidateFrame, NativeSurface, PlatformInput, point, px, size};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

fn native_editor_focus_and_text_do_not_wait_for_another_pixel_frame() {
    const APP: &str = r#"
        import { host, mount, signal } from 'nsh';
        import { Clipboard } from 'nsh';
        import { keymap } from 'nsh';
        import { element, prop, bindProp, append } from 'nsh:rt';
        const value = signal('');
        const second = signal('B');
        keymap.bind('mod+k', () => value.set(keymap.label('mod+k')), { when: 'always' });
        host.on('report-value', () => Clipboard.writeText(value()));
        mount(() => {
            const root = element('view');
            prop(root, 'style', {flex: 1, padding: 16, backgroundColor: '#111111'});
            const input = element('input');
            prop(input, 'style', {width: 240, height: 48, backgroundColor: '#204060', color: '#ffffff'});
            bindProp(input, 'value', value);
            prop(input, 'onFileDrop', () => {});
            prop(input, 'onPaste', () => {});
            prop(input, 'onChange', ({ value: text }) => {
                value.set(text);
                if (text.endsWith('|ABA')) {
                    other.focus();
                    input.focus();
                    Clipboard.writeText('ABA-done');
                }
            });
            append(root, input);
            const body = element('view');
            prop(body, 'selectable', true);
            prop(body, 'onPress', () => {});
            prop(body, 'style', {width: 240, height: 64, backgroundColor: '#406020'});
            append(root, body);
            const other = element('input');
            prop(other, 'style', {position: 'absolute', left: 264, top: 16, width: 48, height: 48,
                backgroundColor: '#302040', color: '#ffffff'});
            bindProp(other, 'value', second);
            prop(other, 'onChange', ({ value: text }) => second.set(text));
            append(root, other);
            return root;
        });
    "#;
    let frames = Rc::new(RefCell::new(Vec::<CandidateFrame>::new()));
    let received = frames.clone();
    let count = Rc::new(Cell::new(0usize));
    let submitted = count.clone();
    let owner = std::thread::current().id();
    let wakes = Arc::new(AtomicUsize::new(0));
    let wake = wakes.clone();
    let mut config = EngineConfig::new(App::Js(Bundle::source(APP.into())));
    config.ui_sets = vec![nsh_base::registry()];
    let host = config.host.clone();
    let platform = TerminalSurface::new(
        config,
        size(
            nsh_terminal::DevicePixels(320),
            nsh_terminal::DevicePixels(160),
        ),
        1.0,
        Box::new(move |frame| {
            submitted.set(submitted.get() + 1);
            let rendered_frame = std::thread::spawn(move || frame.submit()?.complete())
                .join()
                .expect("native snapshot transfer panicked")
                .unwrap();
            received.borrow_mut().push(rendered_frame);
        }),
        Arc::new(move || {
            if std::thread::current().id() == owner {
                wake.fetch_add(1, Ordering::SeqCst);
            }
        }),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        platform.pump_with_draw(true);
        {
            let error = platform.take_error();
            assert!(error.is_none(), "real Input failed to load: {:?}", error);
        }
        let ready = frames.borrow_mut().drain(..).any(|frame| {
            // The fixture's actual input fill proves that native mount and its
            // initial paint completed; a blank startup frame is insufficient.
            frame.pixels()[(24 * 320 + 24) * 4..][..4] == [32, 64, 96, 255]
        });
        if ready {
            break;
        }
        assert!(Instant::now() < deadline, "real Input did not load");
    }
    assert!(platform.input_caret_bounds().is_none());
    assert!(platform.input_candidate_bounds().is_none());
    let initial_count = Cell::new(count.get());
    let paste = |text: &str| platform.paste(nsh_core::PasteEvent::new(text));
    let insert = |text: &str| {
        if let Some(target) = platform.text_input_target() {
            platform
                .apply_composition(&target, text, "", None, false)
                .unwrap();
        }
    };
    let click_at = |x, y| {
        let position = point(px(x), px(y));
        platform
            .dispatch_input(PlatformInput::MouseDown({
                let mut value = nsh_terminal::MouseDownEvent::default();
                value.position = position;
                value.button = nsh_terminal::MouseButton::Left;
                value.click_count = 1;
                value
            }))
            .unwrap();
        platform
            .dispatch_input(PlatformInput::MouseUp({
                let mut value = nsh_terminal::MouseUpEvent::default();
                value.position = position;
                value.button = nsh_terminal::MouseButton::Left;
                value.click_count = 1;
                value
            }))
            .unwrap();
    };
    let click = |y| click_at(32.0, y);
    let stroke = |key: &str, text: Option<&str>, control| {
        let keystroke = {
            let mut value = nsh_terminal::Keystroke::default();
            value.key = key.into();
            value.key_char = text.map(str::to_owned);
            value.modifiers = {
                let mut value = nsh_terminal::Modifiers::default();
                value.control = control;
                value
            };
            value
        };
        platform
            .dispatch_input(PlatformInput::KeyDown({
                let mut value = nsh_terminal::KeyDownEvent::default();
                value.keystroke = keystroke.clone();
                value.is_held = false;
                value.prefer_character_input = false;
                value
            }))
            .unwrap();
        platform
            .dispatch_input(PlatformInput::KeyUp({
                let mut value = nsh_terminal::KeyUpEvent::default();
                value.keystroke = keystroke;
                value
            }))
            .unwrap();
    };
    let copy_stage = Cell::new(0);
    let copied = || {
        let stage = copy_stage.get() + 1;
        copy_stage.set(stage);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            // Engine callbacks can commit a new value between native events.
            // Retry the observable copy while keeping drawing deferred.
            stroke("a", None, true);
            stroke("c", None, true);
            platform.pump_with_draw(false);
            assert_eq!(
                count.get(),
                initial_count.get(),
                "text/focus must not force pixel output"
            );
            if let Some(text) = platform.take_clipboard_write() {
                return text;
            }
            {
                let error = platform.take_error();
                assert!(error.is_none(), "native input error: {:?}", error);
            }
            assert!(
                Instant::now() < deadline,
                "native copy did not complete at stage {stage}"
            );
        }
    };
    // The terminal owns the native keyboard before any pointer click. A global
    // Control-based command must already reach the app through that focus.
    stroke("k", None, true);
    click(32.0);
    let expected_shortcut = if cfg!(target_os = "macos") {
        "⌃K"
    } else {
        "Ctrl+K"
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if copied() == expected_shortcut {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "initial terminal shortcut lost its focus"
        );
    }
    stroke("backspace", None, false);
    // Initial paint had no focused editor. Registration must already exist so
    // the physical click can focus it and accept text before another paint.
    click(32.0);
    stroke("a", Some("a"), false);
    insert("你好😀");
    assert_eq!(copied(), "a你好😀");
    stroke("home", None, false);
    let start = platform.input_caret_bounds().unwrap();
    assert_eq!(start.origin.x, px(16.0));
    assert!(start.origin.y >= px(16.0) && start.bottom() <= px(64.0));
    assert_eq!(platform.input_candidate_bounds(), Some(start));
    stroke("end", None, false);
    let end = platform.input_caret_bounds().unwrap();
    assert!(end.origin.x > start.origin.x);
    assert_eq!(end.origin.y, start.origin.y);
    assert_eq!(count.get(), initial_count.get());
    // Reading the live IME anchor must not keep waking the owner for a frame
    // already pending behind deferred pixel output. Background engine work
    // retains its independent wake and is not counted as an owner self-wake.
    assert!(platform.has_pending());
    let before_queries = wakes.load(Ordering::SeqCst);
    for _ in 0..3 {
        assert_eq!(platform.input_caret_bounds().unwrap(), end);
    }
    assert_eq!(wakes.load(Ordering::SeqCst), before_queries);
    assert_eq!(count.get(), initial_count.get());

    // The same registered handler must consult live focus: clicking a selectable
    // target outside the editor stops paste without a paint to unregister it.
    click(96.0);
    assert!(platform.input_caret_bounds().is_none());
    assert!(platform.input_candidate_bounds().is_none());
    insert("must not enter the old editor");
    assert!(!paste("must not enter the old editor"));
    click(32.0);
    assert_eq!(copied(), "a你好😀");

    // Losing terminal activation must also revoke text acceptance immediately;
    // native field focus can remain ready to resume when activation returns.
    platform.set_active(false).unwrap();
    platform.pump_with_draw(false);
    assert!(platform.input_caret_bounds().is_none());
    assert!(platform.input_candidate_bounds().is_none());
    insert("must not enter an inactive editor");
    assert!(!paste("must not enter an inactive editor"));
    platform.set_active(true).unwrap();
    platform.pump_with_draw(false);
    assert_eq!(copied(), "a你好😀");
    insert("恢复 active");
    assert_eq!(copied(), "恢复 active");
    // Composition enters the same native editor and platform painter. The app's
    // committed value stays observable while the preedit has visible glyphs.
    stroke("a", None, true);
    insert("BASE");
    assert_eq!(copied(), "BASE");
    stroke("end", None, false);
    let target = platform.text_input_target().unwrap();
    assert!(
        platform
            .apply_composition(&target, "", "😀", Some(3..3), true)
            .is_err(),
        "one emoji occupies two UTF-16 units"
    );
    let caret = platform.input_caret_bounds().unwrap();
    let painted = || {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            platform.pump_with_draw(true);
            let pixels = frames
                .borrow_mut()
                .drain(..)
                .next_back()
                .map(|frame| frame.pixels().to_vec());
            if let Some(pixels) = pixels {
                initial_count.set(count.get());
                return pixels;
            }
            assert!(Instant::now() < deadline, "composition did not paint");
        }
    };
    // Exclude the unchanged caret column and the underline below the glyphs.
    let has_preedit_glyphs = |pixels: &[u8]| {
        (f32::from(caret.origin.y).ceil() as usize..f32::from(caret.bottom()).floor() as usize - 2)
            .any(|y| {
                (f32::from(caret.origin.x).ceil() as usize + 3..240).any(|x| {
                    let color = &pixels[(y * 320 + x) * 4..][..3];
                    color.iter().all(|channel| *channel > 200)
                })
            })
    };
    assert!(!has_preedit_glyphs(&painted()));
    assert!(
        platform
            .apply_composition(&target, "", "ni😀", Some(0..0), true)
            .unwrap()
    );
    assert!(has_preedit_glyphs(&painted()));
    let marked_start = platform.input_caret_bounds().unwrap();
    assert!(
        platform
            .apply_composition(&target, "", "ni😀", Some(4..4), true)
            .unwrap()
    );
    let candidate = platform.input_candidate_bounds().unwrap();
    let composing_caret = platform.input_caret_bounds().unwrap();
    assert_eq!(candidate, marked_start);
    assert!(composing_caret.origin.x > candidate.origin.x);
    assert_eq!(candidate.origin.y, composing_caret.origin.y);
    assert_eq!(candidate.size.height, composing_caret.size.height);
    assert!(candidate.size.height > px(0.0));
    host.send("report-value", serde_json::Value::Null).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        platform.pump_with_draw(false);
        if let Some(text) = platform.take_clipboard_write() {
            assert_eq!(text, "BASE", "preedit must not change the app's value");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "committed value was not reported"
        );
    }
    assert!(
        platform
            .apply_composition(&target, "", "", Some(0..0), false)
            .unwrap()
    );
    assert!(!has_preedit_glyphs(&painted()));
    assert_eq!(
        platform.input_candidate_bounds(),
        platform.input_caret_bounds()
    );
    assert_eq!(copied(), "BASE");
    stroke("end", None, false);
    assert!(
        platform
            .apply_composition(&target, "", "old", Some(0..0), true)
            .unwrap()
    );
    assert!(
        platform
            .apply_composition(&target, "😀", "ni", Some(2..2), true)
            .unwrap()
    );
    assert!(
        platform
            .apply_composition(&target, "你", "", None, false)
            .unwrap()
    );
    assert_eq!(copied(), "BASE😀你");
    stroke("end", None, false);
    assert!(
        platform
            .apply_composition(&target, "", "cancel on blur", None, true)
            .unwrap()
    );
    click_at(280.0, 32.0);
    let other = platform.text_input_target().unwrap();
    assert_ne!(other, target);
    assert!(
        !platform
            .apply_composition(&target, "STALE", "wrong field", None, true)
            .unwrap()
    );
    assert_eq!(copied(), "B");
    assert!(
        platform
            .apply_composition(&other, "B2", "", None, false)
            .unwrap()
    );
    assert_eq!(copied(), "B2");
    click(32.0);
    assert_eq!(copied(), "BASE😀你", "blur cancels the old preedit");
    stroke("end", None, false);
    let before_aba = platform.text_input_target().unwrap();
    assert!(
        platform
            .apply_composition(&before_aba, "|ABA", "cancelled by ABA", None, true)
            .unwrap()
    );
    // The real asynchronous change callback focuses B then A in order, and
    // publishes this clipboard marker after those native focus commands.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        platform.pump_with_draw(false);
        if let Some(text) = platform.take_clipboard_write() {
            assert_eq!(text, "ABA-done");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "commit callback did not finish ABA"
        );
    }
    assert_ne!(platform.text_input_target().unwrap(), before_aba);
    assert!(
        !platform
            .apply_composition(&before_aba, "", "must not restore", None, true)
            .unwrap()
    );
    assert_eq!(
        copied(),
        "BASE😀你|ABA",
        "the prefix is committed exactly once"
    );
    // Change density within this same application, as moving the terminal to
    // another screen does. Preserve logical layout and rasterize at full size.
    platform
        .set_viewport(
            size(
                nsh_terminal::DevicePixels(700),
                nsh_terminal::DevicePixels(350),
            ),
            2.1875,
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        platform.pump_with_draw(true);
        let ready = frames.borrow_mut().drain(..).any(|frame| {
            frame.size()
                == size(
                    nsh_terminal::DevicePixels(700),
                    nsh_terminal::DevicePixels(350),
                )
                && frame.pixels()[(120 * 700 + 525) * 4..][..4] == [32, 64, 96, 255]
        });
        if ready {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "scaled native input did not paint at device resolution"
        );
    }
    assert_eq!(
        platform.viewport_size(),
        size(
            nsh_terminal::DevicePixels(700),
            nsh_terminal::DevicePixels(350)
        )
    );
    let physical = platform.viewport_size();
    let logical = size(
        px(physical.width.0 as f32 / platform.scale_factor()),
        px(physical.height.0 as f32 / platform.scale_factor()),
    );
    assert_eq!(logical, size(px(320.0), px(160.0)));
    assert_eq!(platform.scale_factor(), 2.1875);
    let scaled_count = count.get();
    initial_count.set(scaled_count);
    click(32.0);
    stroke("a", None, true);
    insert("scaled 你好😀");
    assert_eq!(copied(), "scaled 你好😀");
    assert_eq!(
        count.get(),
        scaled_count,
        "scaled input must not wait for another image"
    );
    platform.shutdown();
}
