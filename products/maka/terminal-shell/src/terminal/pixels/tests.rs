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

mod rail;

use gpui::{
    AppContext, Application, Bounds, Focusable, PlatformInput, WindowBounds, WindowOptions, point,
    px, size,
};
use nsh_engine::{App, Bundle, EngineConfig};
use nsh_gpui_terminal::{CandidateFrame, TerminalPlatform};
use nsh_platform_gpui::{AppOptions, AppView};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

#[test]
fn native_editor_focus_and_text_do_not_wait_for_another_pixel_frame() {
    const APP: &str = r#"
        import { mount, signal } from 'nsh';
        import { Clipboard } from 'nsh';
        import { keymap } from 'nsh';
        import { element, prop, bindProp, append } from 'nsh:rt';
        const value = signal('');
        const second = signal('B');
        const pastes = signal([]);
        keymap.bind('mod+k', () => value.set(keymap.label('mod+k')), { when: 'always' });
        keymap.bind('mod+j', () => Clipboard.writeText(value()), { when: 'always' });
        keymap.bind('mod+h', () => Clipboard.writeText('paste-events:' + pastes().join('|')), { when: 'always' });
        mount(() => {
            const root = element('view');
            prop(root, 'style', {flex: 1, padding: 16, backgroundColor: '#111111'});
            const input = element('input');
            prop(input, 'style', {width: 240, height: 48, backgroundColor: '#204060', color: '#ffffff'});
            bindProp(input, 'value', value);
            prop(input, 'onFileDrop', () => {});
            prop(input, 'onPaste', event => {
                pastes.set([...pastes(), event.uris.length ? event.uris.join(';') : event.text]);
            });
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
    let platform = TerminalPlatform::new(
        Box::new(gpui_wgpu::WgpuHeadlessRenderer::new().unwrap()),
        Box::new(move |frame| {
            submitted.set(submitted.get() + 1);
            let rendered_frame = std::thread::spawn(move || frame.submit()?.complete())
                .join()
                .expect("GPU rendering panicked")
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
    let errors = Rc::new(RefCell::new(None));
    let failed = errors.clone();
    let window = Rc::new(RefCell::new(None));
    let opened = window.clone();
    let application = Application::with_platform(platform.clone()).run_embedded(move |cx| {
        *opened.borrow_mut() = Some(
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        point(px(0.0), px(0.0)),
                        size(px(320.0), px(160.0)),
                    ))),
                    inactive_frame_interval: None,
                    ..Default::default()
                },
                move |window, cx| {
                    cx.new(|cx| {
                        let view = AppView::new(
                            AppOptions {
                                terminal_keyboard: true,
                                ..Default::default()
                            },
                            window,
                            cx,
                        );
                        view.on_error(move |message| {
                            *failed.borrow_mut() = Some(message.to_owned())
                        });
                        view.load_with_config(EngineConfig {
                            ui_sets: vec![nsh_base::registry()],
                            ..EngineConfig::new(App::Js(Bundle::source(APP.into())))
                        });
                        window.focus(&view.focus_handle(cx), cx);
                        view
                    })
                },
            )
            .unwrap(),
        );
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        platform.pump();
        assert!(
            errors.borrow().is_none(),
            "real Input failed to load: {:?}",
            errors.borrow()
        );
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
    let paste = |text: &str| {
        application.update(|cx| {
            window
                .borrow()
                .as_ref()
                .unwrap()
                .update(cx, |view, window, cx| {
                    let accepted = view.paste(nsh_core::PasteEvent::new(text));
                    window.refresh();
                    cx.notify();
                    accepted
                })
                .unwrap()
        })
    };
    let click_at = |x, y| {
        let position = point(px(x), px(y));
        platform
            .dispatch_input(PlatformInput::MouseDown(gpui::MouseDownEvent {
                position,
                button: gpui::MouseButton::Left,
                click_count: 1,
                ..Default::default()
            }))
            .unwrap();
        platform
            .dispatch_input(PlatformInput::MouseUp(gpui::MouseUpEvent {
                position,
                button: gpui::MouseButton::Left,
                click_count: 1,
                ..Default::default()
            }))
            .unwrap();
    };
    let click = |y| click_at(32.0, y);
    let stroke = |key: &str, text: Option<&str>, control| {
        let keystroke = gpui::Keystroke {
            key: key.into(),
            key_char: text.map(str::to_owned),
            modifiers: gpui::Modifiers {
                control,
                ..Default::default()
            },
        };
        platform
            .dispatch_input(PlatformInput::KeyDown(gpui::KeyDownEvent {
                keystroke: keystroke.clone(),
                is_held: false,
                prefer_character_input: false,
            }))
            .unwrap();
        platform
            .dispatch_input(PlatformInput::KeyUp(gpui::KeyUpEvent { keystroke }))
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
            if let Some(text) = platform.take_clipboard_write().and_then(|item| item.text()) {
                return text;
            }
            assert!(
                errors.borrow().is_none(),
                "native input error: {:?}",
                errors.borrow()
            );
            assert!(
                Instant::now() < deadline,
                "native copy did not complete at stage {stage}"
            );
        }
    };
    // The terminal owns the GPUI keyboard before any pointer click. A global
    // Control-based command must already reach the app through that focus.
    stroke("k", None, true);
    click(32.0);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if copied() == "Ctrl+K" {
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
    platform.paste("你好😀").unwrap();
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

    // The same registered handler must consult live focus: clicking another
    // native press target stops paste without a paint to unregister it.
    click(96.0);
    assert!(platform.input_caret_bounds().is_none());
    assert!(platform.input_candidate_bounds().is_none());
    platform.paste("must not enter the old editor").unwrap();
    assert!(!paste("must not enter the old editor"));
    click(32.0);
    assert_eq!(copied(), "a你好😀");

    // Losing terminal activation must also revoke text acceptance immediately;
    // native field focus can remain ready to resume when activation returns.
    platform.set_active(false).unwrap();
    platform.pump_with_draw(false);
    assert!(platform.input_caret_bounds().is_none());
    assert!(platform.input_candidate_bounds().is_none());
    platform.paste("must not enter an inactive editor").unwrap();
    assert!(!paste("must not enter an inactive editor"));
    platform.set_active(true).unwrap();
    platform.pump_with_draw(false);
    assert_eq!(copied(), "a你好😀");
    platform.paste("恢复 active").unwrap();
    assert_eq!(copied(), "恢复 active");
    // Terminal editing remains Control-based on macOS as well as Linux:
    // Home/End are line edges; Control+arrows advance by words.
    platform.paste("one two three").unwrap();
    stroke("home", None, false);
    stroke("right", None, true);
    platform.paste("|").unwrap();
    assert_eq!(copied(), "one |two three");
    platform.paste("one two three").unwrap();
    stroke("end", None, false);
    stroke("left", None, true);
    platform.paste("|").unwrap();
    assert_eq!(copied(), "one two |three");
    platform.paste("one two").unwrap();
    stroke("home", None, true);
    platform.paste("<").unwrap();
    stroke("end", None, true);
    platform.paste(">").unwrap();
    assert_eq!(copied(), "<one two>");
    stroke("k", None, true);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if copied() == "Ctrl+K" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Control-based mod binding did not reach the engine"
        );
    }
    assert_eq!(count.get(), initial_count.get());
    assert!(paste("first"));
    assert!(paste("second"));
    stroke("a", None, true);
    assert!(paste("'/tmp/a b.png' /tmp/c.txt"));
    stroke("h", None, true);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        platform.pump_with_draw(false);
        if let Some(text) = platform.take_clipboard_write().and_then(|item| item.text())
            && text.starts_with("paste-events:")
        {
            assert_eq!(
                text,
                "paste-events:first|second|file:///tmp/a%20b.png;file:///tmp/c.txt"
            );
            break;
        }
        assert!(
            errors.borrow().is_none(),
            "paste failed: {:?}",
            errors.borrow()
        );
        assert!(
            Instant::now() < deadline,
            "native paste events were not reported"
        );
    }
    assert_eq!(
        copied(),
        "firstsecond",
        "file paste must preserve the selected text"
    );
    assert_eq!(count.get(), initial_count.get());
    // Composition enters the same native editor and WGPU painter. The app's
    // committed value stays observable while the preedit has visible glyphs.
    stroke("a", None, true);
    platform.paste("BASE").unwrap();
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
            platform.pump();
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
    stroke("j", None, true);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        platform.pump_with_draw(false);
        if let Some(text) = platform.take_clipboard_write().and_then(|item| item.text()) {
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
        if let Some(text) = platform.take_clipboard_write().and_then(|item| item.text()) {
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
            size(gpui::DevicePixels(700), gpui::DevicePixels(350)),
            2.1875,
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        platform.pump();
        let ready = frames.borrow_mut().drain(..).any(|frame| {
            frame.size() == size(gpui::DevicePixels(700), gpui::DevicePixels(350))
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
    application.update(|cx| {
        window
            .borrow()
            .as_ref()
            .unwrap()
            .update(cx, |_, window, _| {
                assert_eq!(window.viewport_size(), size(px(320.0), px(160.0)));
                assert_eq!(window.scale_factor(), 2.1875);
            })
            .unwrap();
    });
    let scaled_count = count.get();
    initial_count.set(scaled_count);
    click(32.0);
    stroke("a", None, true);
    platform.paste("scaled 你好😀").unwrap();
    assert_eq!(copied(), "scaled 你好😀");
    assert_eq!(
        count.get(),
        scaled_count,
        "scaled input must not wait for another image"
    );
    application.update(|cx| {
        window
            .borrow()
            .as_ref()
            .unwrap()
            .update(cx, |view, _, _| {
                view.load_with_config(EngineConfig {
                    ui_sets: vec![nsh_base::registry()],
                    ..EngineConfig::new(App::Js(Bundle::source(
                        r#"
                        import { mount } from 'nsh';
                        import { Clipboard } from 'nsh';
                        import { keymap } from 'nsh';
                        import { element, prop, append } from 'nsh:rt';
                        let fallbackCopies = 0;
                        keymap.bind('ctrl+c', () => fallbackCopies++,
                            { when: 'always', fallback: true });
                        keymap.bind('f7', () => Clipboard.writeText(String(fallbackCopies)),
                            { when: 'always' });
                        mount(() => {
                            const root = element('view');
                            prop(root, 'style', {flex: 1, paddingTop: 64, paddingLeft: 16});
                            const scroll = element('scroll');
                            prop(scroll, 'style', {width: 240, height: 48});
                            const input = element('input');
                            prop(input, 'style', {width: 240, height: 48, backgroundColor: '#204060'});
                            const tail = element('view');
                            prop(tail, 'style', {height: 96});
                            append(scroll, input);
                            append(scroll, tail);
                            append(root, scroll);
                            return root;
                        });
                        "#
                        .into(),
                    )))
                });
            })
            .unwrap();
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        platform.pump();
        let ready = frames
            .borrow_mut()
            .drain(..)
            .any(|frame| frame.pixels()[(160 * 700 + 52) * 4..][..4] == [32, 64, 96, 255]);
        if ready {
            break;
        }
        assert!(Instant::now() < deadline, "scrolling input did not paint");
    }
    initial_count.set(count.get());
    click(80.0);
    let visible = platform.input_caret_bounds().unwrap();
    assert!(visible.origin.y > px(64.0) && visible.bottom() <= px(112.0));
    let wheel = |dy| {
        platform
            .dispatch_input(PlatformInput::ScrollWheel(gpui::ScrollWheelEvent {
                position: point(px(32.0), px(80.0)),
                delta: gpui::ScrollDelta::Pixels(point(px(0.0), px(dy))),
                touch_phase: gpui::TouchPhase::Moved,
                ..Default::default()
            }))
            .unwrap();
        platform.pump_with_draw(false);
    };
    wheel(-24.0);
    let partial = platform.input_caret_bounds().unwrap();
    assert_eq!(partial.origin.y, px(64.0));
    assert!(partial.size.height < visible.size.height);
    wheel(-24.0);
    // Focus is retained while the field's caret is above this Scroll, yet
    // still inside the window. Native text acceptance must remain independent
    // of the absent candidate-window anchor and of another GPU frame.
    assert!(platform.input_caret_bounds().is_none());
    platform.paste("hidden 你好😀").unwrap();
    assert!(platform.input_caret_bounds().is_none());
    wheel(48.0);
    let restored = platform.input_caret_bounds().unwrap();
    assert!(restored.origin.y > px(64.0) && restored.bottom() <= px(112.0));
    assert_eq!(copied(), "hidden 你好😀");
    assert_eq!(count.get(), initial_count.get());
    let fallback_count = || {
        stroke("f7", None, false);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            platform.pump_with_draw(false);
            if let Some(text) = platform.take_clipboard_write().and_then(|item| item.text()) {
                return text;
            }
            assert!(Instant::now() < deadline, "fallback count was not reported");
        }
    };
    assert_eq!(
        fallback_count(),
        "0",
        "native selection copy takes priority"
    );
    stroke("end", None, false);
    stroke("c", None, true);
    assert!(platform.take_clipboard_write().is_none());
    assert_eq!(fallback_count(), "1", "empty copy reaches the fallback");
    stroke("c", None, true);
    stroke("c", None, true);
    assert_eq!(fallback_count(), "3", "each physical press is independent");
    let control_c = gpui::Keystroke {
        key: "c".into(),
        modifiers: gpui::Modifiers {
            control: true,
            ..Default::default()
        },
        ..Default::default()
    };
    for is_held in [false, true, false] {
        platform
            .dispatch_input(PlatformInput::KeyDown(gpui::KeyDownEvent {
                keystroke: control_c.clone(),
                is_held,
                prefer_character_input: false,
            }))
            .unwrap();
    }
    platform
        .dispatch_input(PlatformInput::KeyUp(gpui::KeyUpEvent {
            keystroke: control_c,
        }))
        .unwrap();
    assert_eq!(
        fallback_count(),
        "4",
        "held keys must not repeat the fallback"
    );
    assert_eq!(count.get(), initial_count.get());
    application.update(|cx| {
        window
            .borrow()
            .as_ref()
            .unwrap()
            .update(cx, |view, _, _| view.stop())
            .unwrap();
    });
    drop(application);
    platform.shutdown();
}
