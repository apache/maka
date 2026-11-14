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

//! Migrates the removed GPUI window tests' native focus/scoped-binding invariants.
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use nsh_engine::{App, Bundle, EngineConfig};
use nsh_platform_macos::TerminalSurface;
use nsh_terminal::{
    DevicePixels, KeyDownEvent, KeyUpEvent, Keystroke, MouseMoveEvent, NativeSurface,
    PlatformInput, size,
};

const APP: &str = r#"
import { mount, signal, View, keymap, Clipboard } from "nsh";
import { Dialog, Input } from "nsh/base";
function App() {
  const owner = signal(0), revision = signal(0), popup = signal(false);
  keymap.bind("f7", () => { revision.set(revision() + 1); Clipboard.writeText("updated"); }, { when: "always" });
  keymap.bind("f8", () => owner.set(owner() + 1), { when: "always" });
  keymap.bind("f9", () => popup.set(true), { when: "always" });
  return <View style={{flex: 1}}>
    <View style={{height: revision() % 2 + 1}} />
    <Each of={[owner()]} key={(id) => id}>{(row) => {
      const id = row();
      return <View ref={(node) => keymap.bind("f6", () => Clipboard.writeText(`scope:${id}`), { when: "always", within: node })}>
        <Input autoFocus defaultValue={`editor:${id}`} style={{height: 40}} />
      </View>;
    }}</Each>
    <Dialog open={popup()} animation="none" closeOnEscape onOpenChange={({open}) => popup.set(open)}>
      <Input autoFocus defaultValue="popup" style={{width: 160, height: 40}} />
    </Dialog>
  </View>;
}
mount(App);
"#;

fn pump_until(surface: &TerminalSurface, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        surface.pump_with_draw(false);
        assert_eq!(surface.take_error(), None);
        if done() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "native app did not settle before deadline"
        );
        std::thread::yield_now();
    }
}
fn key(surface: &TerminalSurface, name: &str) {
    let mut key = Keystroke::default();
    key.key = name.into();
    let mut down = KeyDownEvent::default();
    down.keystroke = key.clone();
    let mut up = KeyUpEvent::default();
    up.keystroke = key;
    surface
        .dispatch_input(PlatformInput::KeyDown(down))
        .unwrap();
    surface.dispatch_input(PlatformInput::KeyUp(up)).unwrap();
}
fn clipboard(surface: &TerminalSurface, expected: &str) {
    pump_until(surface, || {
        surface.take_clipboard_write().as_deref() == Some(expected)
    });
}

pub(super) fn scrolling_dismisses_hover_tooltip() {
    let source = r#"
import { Clipboard, Scroll, Text, View, keymap, mount } from "nsh";
import { Button, Tooltip } from "nsh/base";
function App() {
  let scroll;
  keymap.bind("f7", () => scroll.scrollTo({y: 16, animated: false}), {when: "always"});
  return <Scroll ref={ref => scroll = ref} style={{height: 180}}>
    <View style={{height: 40, flexShrink: 0}} />
    <Button accessibilityLabel="Tool row" style={{height: 100, flexShrink: 0}} tooltip={
      <Tooltip delay={300} onOpen={() => Clipboard.writeText("tip shown")}
        onClose={() => Clipboard.writeText("tip dismissed")}><Text>Tool details</Text></Tooltip>
    }><Text>Tool row</Text></Button>
    <View style={{height: 240, flexShrink: 0}} />
  </Scroll>;
}
mount(App);
"#;
    let code = nsh_bundler::compile_module("TooltipScroll.tsx", source, &[]).unwrap();
    let mut config = EngineConfig::new(App::Js(Bundle::source(code)));
    config.ui_sets = vec![nsh_base::registry()];
    let surface = TerminalSurface::new(
        config,
        size(DevicePixels(320), DevicePixels(240)),
        1.0,
        Box::new(|_| panic!("tooltip lifecycle must not require drawing a frame")),
        Arc::new(|| {}),
    )
    .unwrap();
    pump_until(&surface, || surface.pressable_bounds("Tool row").len() == 1);
    let row = surface.pressable_bounds("Tool row")[0];
    let mut hover = MouseMoveEvent::default();
    hover.position = row.center();
    surface
        .dispatch_input(PlatformInput::MouseMove(hover))
        .unwrap();
    clipboard(&surface, "tip shown");

    key(&surface, "f7");
    pump_until(&surface, || {
        surface.pressable_bounds("Tool row")[0].top() < row.top()
    });
    let moved = surface.pressable_bounds("Tool row")[0];
    assert!(moved.bottom() > row.center().y);
    clipboard(&surface, "tip dismissed");
    clipboard(&surface, "tip shown");
    surface.shutdown();
}

pub(super) fn focus_admission() {
    let code = nsh_bundler::compile_module("Focus.tsx", APP, &[]).unwrap();
    let mut config = EngineConfig::new(App::Js(Bundle::source(code)));
    config.ui_sets = vec![nsh_base::registry()];
    let surface = TerminalSurface::new(
        config,
        size(DevicePixels(320), DevicePixels(240)),
        1.0,
        Box::new(|_| panic!("focus must not require drawing a frame")),
        Arc::new(|| {}),
    )
    .unwrap();
    pump_until(&surface, || {
        surface.editor_text().as_deref() == Some("editor:0")
    });
    let first = surface.text_input_target().unwrap();
    // Unknown key names must neither type their names nor fail the session.
    // Exercise both key-down and key-up, then ordinary native editing.
    for unsupported in ["f21", "f35", "f255", "unsupported"] {
        key(&surface, unsupported);
        assert_eq!(surface.editor_text().as_deref(), Some("editor:0"));
        assert_eq!(surface.take_error(), None);
        assert_eq!(surface.text_input_target(), Some(first.clone()));
    }
    surface.set_selected_text_range(8..8).unwrap();
    key(&surface, "q");
    pump_until(&surface, || {
        surface.editor_text().as_deref() == Some("editor:0q")
    });
    key(&surface, "backspace");
    pump_until(&surface, || {
        surface.editor_text().as_deref() == Some("editor:0")
    });
    key(&surface, "f6");
    clipboard(&surface, "scope:0");
    key(&surface, "f7");
    clipboard(&surface, "updated");
    assert_eq!(
        surface.text_input_target(),
        Some(first.clone()),
        "unrelated layout revoked a live editor"
    );

    key(&surface, "f8");
    pump_until(&surface, || {
        surface.editor_text().as_deref() == Some("editor:1")
    });
    let replacement = surface.text_input_target().unwrap();
    assert_ne!(
        first, replacement,
        "removed editor kept its composition authority"
    );
    assert!(
        !surface
            .apply_composition(&first, "stale", "", None, false)
            .unwrap()
    );
    assert_eq!(surface.editor_text().as_deref(), Some("editor:1"));
    key(&surface, "f6");
    clipboard(&surface, "scope:1");

    key(&surface, "f9");
    pump_until(&surface, || {
        surface.editor_text().as_deref() == Some("popup")
    });
    assert!(
        !surface
            .apply_composition(&replacement, "under-modal", "", None, false)
            .unwrap()
    );
    key(&surface, "escape");
    pump_until(&surface, || surface.text_input_target().is_none());
    key(&surface, "escape");
    pump_until(&surface, || {
        surface.editor_text().as_deref() == Some("editor:1")
    });
    assert_ne!(
        surface.text_input_target(),
        Some(replacement),
        "focus away and back reused an admission"
    );
    key(&surface, "f6");
    clipboard(&surface, "scope:1");
    surface.shutdown();
}

#[derive(Default)]
struct DelayedImage {
    released: std::sync::Mutex<bool>,
    changed: std::sync::Condvar,
    requested: std::sync::atomic::AtomicBool,
}
impl DelayedImage {
    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.changed.notify_all();
    }
}
impl nsh_engine::Assets for DelayedImage {
    fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
        if uri != "asset:/terminal-delayed-capture.png" {
            return Err(format!("unexpected asset {uri}"));
        }
        self.requested
            .store(true, std::sync::atomic::Ordering::Release);
        let mut released = self.released.lock().unwrap();
        while !*released {
            released = self.changed.wait(released).unwrap();
        }
        Ok(vec![
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
            8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 207,
            192, 240, 31, 0, 5, 0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66,
            96, 130,
        ])
    }
}
struct ReleaseImage(Arc<DelayedImage>);
impl Drop for ReleaseImage {
    fn drop(&mut self) {
        self.0.release();
    }
}

pub(super) fn delayed_image() {
    use std::{cell::Cell, rc::Rc, sync::atomic::Ordering};
    const IMAGE: &str = r##"
        import { mount } from "nsh";
        import { element, prop, append } from "nsh:rt";
        mount(() => {
            const root = element("view");
            prop(root, "style", { flex: 1, backgroundColor: "#000000" });
            const image = element("image");
            prop(image, "src", "asset:/terminal-delayed-capture.png");
            prop(image, "fadeDuration", 0);
            prop(image, "style", { width: 32, height: 32 });
            append(root, image);
            return root;
        });
    "##;
    let assets = Arc::new(DelayedImage::default());
    let mut config = EngineConfig::new(App::Js(Bundle::source(IMAGE.into())));
    config.assets = Some(assets.clone());
    let count = Rc::new(Cell::new(0));
    let pixel = Rc::new(Cell::new([0u8; 4]));
    let (frames, observed) = (count.clone(), pixel.clone());
    let surface = TerminalSurface::new(
        config,
        size(DevicePixels(64), DevicePixels(64)),
        1.0,
        Box::new(move |frame| {
            let frame = frame.submit().unwrap().complete().unwrap();
            observed.set(
                frame.pixels()[(16 * 64 + 16) * 4..][..4]
                    .try_into()
                    .unwrap(),
            );
            frames.set(frames.get() + 1);
        }),
        Arc::new(|| {}),
    )
    .unwrap();
    // Release the loader before surface teardown even if an assertion panics.
    let release = ReleaseImage(assets.clone());
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        surface.pump_with_draw(true);
        assert_eq!(surface.take_error(), None);
        if assets.requested.load(Ordering::Acquire) && pixel.get() == [0, 0, 0, 255] {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "initial frame/image request missing"
        );
    }
    // The mount has settled; the asset is the only source of future visible work.
    let deadline = Instant::now() + Duration::from_secs(5);
    while surface.has_pending() {
        surface.pump_with_draw(true);
        assert!(
            Instant::now() < deadline,
            "initial native scene never became idle"
        );
    }
    let before = count.get();
    drop(release);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        surface.pump_with_draw(true);
        assert_eq!(surface.take_error(), None);
        if pixel.get() == [255, 0, 0, 255] {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "loaded native image did not invalidate idle capture"
        );
    }
    assert!(count.get() > before);
    let deadline = Instant::now() + Duration::from_secs(5);
    while surface.has_pending() {
        surface.pump_with_draw(true);
        assert!(
            Instant::now() < deadline,
            "capture invalidates itself indefinitely"
        );
    }
    let settled = count.get();
    for _ in 0..3 {
        surface.pump_with_draw(true);
    }
    assert_eq!(
        count.get(),
        settled,
        "reading pixels scheduled another capture"
    );
    surface.shutdown();
}

pub(super) fn focus_fence_without_queued_text() {
    use std::{cell::RefCell, rc::Rc};

    let code = nsh_bundler::compile_module("Fence.tsx", APP, &[]).unwrap();
    let mut config = EngineConfig::new(App::Js(Bundle::source(code)));
    config.ui_sets = vec![nsh_base::registry()];
    let surface = TerminalSurface::new(
        config,
        size(DevicePixels(320), DevicePixels(240)),
        1.0,
        Box::new(|_| {}),
        Arc::new(|| {}),
    )
    .unwrap();
    pump_until(&surface, || {
        surface.editor_text().as_deref() == Some("editor:0")
    });

    // 1. Immediate editing key (Backspace) after a focus-replacing shortcut (`f8`),
    //    with zero text queued ahead of it, waits for `editor:1` to mount and focus.
    key(&surface, "f8");
    key(&surface, "backspace");
    pump_until(&surface, || {
        surface.editor_text().as_deref() == Some("editor:")
    });

    // 2. Immediate shortcut chord (`cmd+a`) + editing key (`backspace`) after `f8`
    //    waits for `editor:2` to mount and clears `editor:2` rather than `editor:1`.
    key(&surface, "f8");
    let mut select_all = Keystroke::default();
    select_all.key = "a".into();
    select_all.modifiers.platform = true;
    let mut down = KeyDownEvent::default();
    down.keystroke = select_all.clone();
    let mut up = KeyUpEvent::default();
    up.keystroke = select_all;
    surface
        .dispatch_input(PlatformInput::KeyDown(down))
        .unwrap();
    surface.dispatch_input(PlatformInput::KeyUp(up)).unwrap();
    key(&surface, "backspace");
    pump_until(&surface, || surface.editor_text().as_deref() == Some(""));

    // 3. Immediate paste after `f8` waits for `editor:3` to mount.
    key(&surface, "f8");
    assert!(surface.paste(nsh_core::PasteEvent::new("!")));
    pump_until(&surface, || {
        surface.editor_text().as_deref() == Some("editor:3!")
    });

    // 4. `pause_input` drains an in-flight focus transition and queued input before completing.
    key(&surface, "f8");
    key(&surface, "z");
    let fenced: Rc<RefCell<Option<Result<(), String>>>> = Rc::new(RefCell::new(None));
    let slot = fenced.clone();
    surface.pause_input(Box::new(move |res| {
        *slot.borrow_mut() = Some(res);
    }));
    pump_until(&surface, || fenced.borrow().is_some());
    assert_eq!(*fenced.borrow(), Some(Ok(())));
    surface.resume_input();
    assert_eq!(surface.editor_text().as_deref(), Some("editor:4z"));

    // 5. Composing Escape under an `escape` keybinding does not fire the binding.
    let target = surface.text_input_target().unwrap();
    assert!(
        surface
            .apply_composition(&target, "", "ni", Some(2..2), true)
            .unwrap()
    );
    key(&surface, "escape");
    assert_eq!(surface.editor_text().as_deref(), Some("editor:4zni"));
    assert!(
        surface
            .apply_composition(&target, "", "", Some(0..0), false)
            .unwrap()
    );
    assert_eq!(surface.editor_text().as_deref(), Some("editor:4z"));

    // 6. Stranded printable input after a non-focusing shortcut while blurred fails `pause_input`.
    key(&surface, "escape");
    pump_until(&surface, || surface.text_input_target().is_none());
    key(&surface, "f7");
    key(&surface, "x");
    let stranded: Rc<RefCell<Option<Result<(), String>>>> = Rc::new(RefCell::new(None));
    let slot = stranded.clone();
    surface.pause_input(Box::new(move |res| {
        *slot.borrow_mut() = Some(res);
    }));
    pump_until(&surface, || stranded.borrow().is_some());
    assert_eq!(
        *stranded.borrow(),
        Some(Err("pending input has no editable focus target".into()))
    );
    surface.shutdown();
}

pub(super) fn desktop_composing_escape() {
    use std::sync::Mutex;

    use nsh_platform_macos::{
        AppOptions, AppView,
        objc2::{MainThreadMarker, MainThreadOnly, msg_send, rc::Retained},
        objc2_app_kit::{
            NSApplication, NSBackingStoreType, NSEvent, NSEventMask, NSEventModifierFlags,
            NSEventType, NSTextInputClient, NSTextView, NSWindow, NSWindowStyleMask,
        },
        objc2_foundation::{
            NSDate, NSDefaultRunLoopMode, NSPoint, NSRange, NSRect, NSSize, NSString,
        },
    };

    const DESKTOP_APP: &str = r#"
import { host, keymap, mount, signal, View } from "nsh";
import { Dialog, Input } from "nsh/base";

function App() {
  const open = signal(true);
  const value = signal("base");
  let unbind = keymap.bind("escape", () => host.post("log", "keymap-escape"), { when: "always" });
  keymap.bind("f2", () => {
    unbind();
    unbind = () => {};
    value.set("ready");
  }, { when: "always" });
  return <View style={{flex: 1}}>
    <Dialog
      open={open()}
      animation="none"
      closeOnEscape
      onOpenChange={({open: next}) => {
        open.set(next);
        if (!next) host.post("log", "modal-closed");
      }}
    >
      <Input
        autoFocus
        value={value()}
        onChange={({value: next}) => value.set(next)}
        onKeyPress={({key}) => host.post("log", `key:${key}`)}
        onCompositionChange={({composing, text}) => host.post("log", `comp:${composing}:${text}`)}
        style={{width: 160, height: 40}}
      />
    </Dialog>
  </View>;
}
mount(App);
"#;

    let mtm = MainThreadMarker::new().expect("main thread");
    let app = NSApplication::sharedApplication(mtm);
    let mut options = AppOptions::default();
    options.size = (320, 240);
    let view = AppView::new(mtm, options);
    let events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let log = events.clone();
    view.host().handle("log", move |call| {
        if let Some(s) = call.data().as_str() {
            log.lock().unwrap().push(s.to_owned());
        }
    });

    let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(320.0, 240.0));
    // SAFETY: created and closed on the main thread; Rust retains ownership.
    let window: Retained<NSWindow> = unsafe {
        let w = NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            rect,
            NSWindowStyleMask::Borderless,
            NSBackingStoreType::Buffered,
            false,
        );
        w.setReleasedWhenClosed(false);
        w
    };
    window.setContentView(Some(&view.view()));

    let code = nsh_bundler::compile_module("DesktopEscape.tsx", DESKTOP_APP, &[]).unwrap();
    let mut policy = nsh_engine::Policy::default();
    policy
        .declared
        .get_or_insert_default()
        .host
        .push("log".into());
    let mut config = EngineConfig::new(App::Js(Bundle::source(code).with_policy(policy)));
    config.ui_sets = vec![nsh_base::registry()];
    config.host = view.host();
    view.load_with_config(config);

    let pump = |done: &mut dyn FnMut() -> bool| {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            for _ in 0..32 {
                // SAFETY: Foundation's default run-loop mode on the main thread.
                let ev = unsafe {
                    app.nextEventMatchingMask_untilDate_inMode_dequeue(
                        NSEventMask::Any,
                        Some(&NSDate::dateWithTimeIntervalSinceNow(0.001)),
                        NSDefaultRunLoopMode,
                        true,
                    )
                };
                let Some(ev) = ev else { break };
                app.sendEvent(&ev);
            }
            if done() {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "desktop AppKit surface did not settle before deadline"
            );
            std::thread::yield_now();
        }
    };

    pump(&mut || {
        window
            .firstResponder()
            .and_then(|r| r.downcast::<NSTextView>().ok())
            .is_some_and(|tv| tv.string().to_string() == "base")
    });

    let editor = window
        .firstResponder()
        .unwrap()
        .downcast::<NSTextView>()
        .unwrap();
    let set_marked = |text: &str| {
        let marked = NSString::from_str(text);
        let len = marked.length();
        let replacement = NSRange::new(isize::MAX as usize, 0);
        // SAFETY: NSTextInputClient marked-text update on the focused NSTextView.
        let _: () = unsafe {
            msg_send![
                &*editor,
                setMarkedText: &*marked,
                selectedRange: NSRange::new(len, 0),
                replacementRange: replacement
            ]
        };
        assert!(editor.hasMarkedText());
    };
    let send_key = |chars: &str, key_code: u16, to_window: bool| {
        let s = NSString::from_str(chars);
        let uptime = objc2_foundation::NSProcessInfo::processInfo().systemUptime();
        for kind in [NSEventType::KeyDown, NSEventType::KeyUp] {
            let ev = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                kind,
                NSPoint::new(0.0, 0.0),
                NSEventModifierFlags::empty(),
                uptime,
                window.windowNumber(),
                None,
                &s,
                &s,
                false,
                key_code,
            )
            .unwrap();
            app.sendEvent(&ev);
            if to_window && !window.isKeyWindow() {
                window.sendEvent(&ev);
            }
        }
    };

    // 1. With an `escape` shortcut bound, composing Escape cancels marked text
    //    without firing the shortcut, blurring, or closing the Dialog.
    set_marked("ni");
    send_key("\u{1b}", 53, true);
    pump(&mut || {
        events
            .lock()
            .unwrap()
            .iter()
            .any(|entry| entry == "comp:false:")
    });
    assert!(!editor.hasMarkedText());
    assert_eq!(editor.string().to_string(), "base");
    assert!(
        window
            .firstResponder()
            .and_then(|r| r.downcast::<NSTextView>().ok())
            .is_some(),
        "composing Escape must keep focus inside the editor"
    );
    {
        let recorded = events.lock().unwrap();
        assert!(!recorded.iter().any(|e| e == "key:Escape"));
        assert!(!recorded.iter().any(|e| e == "modal-closed"));
        assert!(!recorded.iter().any(|e| e == "keymap-escape"));
    }

    // 2. Unbind the `escape` shortcut via `f2` through NSApplication's local key monitor,
    //    then verify ordinary 3-step desktop Escape navigation (cancel preedit -> blur -> dismiss).
    send_key("\u{f705}", 120, false);
    pump(&mut || editor.string().to_string() == "ready");
    events.lock().unwrap().clear();

    set_marked("hao");
    send_key("\u{1b}", 53, true);
    pump(&mut || {
        events
            .lock()
            .unwrap()
            .iter()
            .any(|entry| entry == "comp:false:")
    });
    assert!(!editor.hasMarkedText());
    assert_eq!(editor.string().to_string(), "ready");
    assert!(
        window
            .firstResponder()
            .and_then(|r| r.downcast::<NSTextView>().ok())
            .is_some(),
        "composing Escape must keep focus inside the editor"
    );
    {
        let recorded = events.lock().unwrap();
        assert!(!recorded.iter().any(|e| e == "key:Escape"));
        assert!(!recorded.iter().any(|e| e == "modal-closed"));
    }
    events.lock().unwrap().clear();

    send_key("\u{1b}", 53, true);
    pump(&mut || {
        events
            .lock()
            .unwrap()
            .iter()
            .any(|entry| entry == "key:Escape")
    });
    assert!(
        window
            .firstResponder()
            .and_then(|r| r.downcast::<NSTextView>().ok())
            .is_none(),
        "non-composing Escape must leave the editor"
    );
    assert!(!events.lock().unwrap().iter().any(|e| e == "modal-closed"));

    send_key("\u{1b}", 53, true);
    pump(&mut || {
        events
            .lock()
            .unwrap()
            .iter()
            .any(|entry| entry == "modal-closed")
    });

    view.stop();
    window.close();
}

pub(super) fn subtree_reachability() {
    use std::{cell::RefCell, rc::Rc};

    use nsh_terminal::{MouseButton, MouseDownEvent, MouseUpEvent, Point, Points, point, px};

    const REACHABILITY_APP: &str = r#"
import { Clipboard, keymap, mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

function App() {
  const hideEditor = signal(false);
  const blockEditor = signal(false);
  keymap.bind("f6", () => {
    const next = !hideEditor();
    hideEditor.set(next);
    Clipboard.writeText(next ? "editor-hidden" : "editor-shown");
  }, { when: "always" });
  keymap.bind("f7", () => {
    const next = !blockEditor();
    blockEditor.set(next);
    Clipboard.writeText(next ? "editor-blocked" : "editor-unblocked");
  }, { when: "always" });
  return <View style={{ flex: 1 }}>
    <View
      accessibilityLabel="Chat"
      focusable={false}
      onPress={() => Clipboard.writeText("visible-chat")}
      style={{
        width: 80,
        height: 32,
        transform: [{ translateX: 20 }, { translateY: 12 }],
      }}
    />
    <View
      focusable={false}
      onPress={() => Clipboard.writeText("retry-clicked")}
      style={{ width: 72, height: 28 }}
    >
      <Text>Retry</Text>
    </View>
    <View style={{ display: "none" }}>
      <View accessibilityLabel="Chat" onPress={() => Clipboard.writeText("hidden-chat")} style={{ width: 80, height: 32 }} />
      <Input autoFocus defaultValue="hidden-auto" style={{ width: 120, height: 32 }} />
    </View>
    <View style={{ pointerEvents: "none" }}>
      <View accessibilityLabel="Chat" onPress={() => Clipboard.writeText("pe-none-chat")} style={{ width: 80, height: 32 }} />
      <Input defaultValue="pe-none-input" style={{ width: 120, height: 32 }} />
    </View>
    <View style={{ pointerEvents: "box-only", width: 80, height: 32 }}>
      <View accessibilityLabel="Chat" onPress={() => Clipboard.writeText("box-only-chat")} style={{ width: 80, height: 32 }} />
      <Input defaultValue="box-only-input" style={{ width: 120, height: 32 }} />
    </View>
    <View accessibilityElementsHidden>
      <View accessibilityLabel="Chat" focusable={false} onPress={() => Clipboard.writeText("ax-hidden-chat")} style={{ width: 80, height: 32 }} />
    </View>
    <View style={{ overflow: "hidden", width: 80, height: 0 }}>
      <View accessibilityLabel="Chat" focusable={false} onPress={() => Clipboard.writeText("clipped-chat")} style={{ width: 80, height: 32 }} />
    </View>
    <View style={{ display: hideEditor() ? "none" : "flex", pointerEvents: blockEditor() ? "none" : "auto" }}>
      <Input defaultValue="live-editor" style={{ width: 140, height: 36 }} />
    </View>
    <Input defaultValue="second-editor" style={{ width: 140, height: 36 }} />
  </View>;
}
mount(App);
"#;

    let code = nsh_bundler::compile_module("Reachability.tsx", REACHABILITY_APP, &[]).unwrap();
    let mut config = EngineConfig::new(App::Js(Bundle::source(code)));
    config.ui_sets = vec![nsh_base::registry()];
    let surface = TerminalSurface::new(
        config,
        size(DevicePixels(360), DevicePixels(320)),
        1.0,
        Box::new(|_| {}),
        Arc::new(|| {}),
    )
    .unwrap();
    pump_until(&surface, || !surface.pressable_bounds("Chat").is_empty());

    let fenced: Rc<RefCell<Option<Result<(), String>>>> = Rc::new(RefCell::new(None));
    let slot = fenced.clone();
    surface.pause_input(Box::new(move |res| {
        *slot.borrow_mut() = Some(res);
    }));
    pump_until(&surface, || fenced.borrow().is_some());
    assert_eq!(*fenced.borrow(), Some(Ok(())));
    surface.resume_input();
    assert_eq!(surface.text_input_target(), None);

    let chat = surface.pressable_bounds("Chat");
    assert_eq!(chat.len(), 1);
    assert_eq!(
        (
            chat[0].origin.x.0,
            chat[0].origin.y.0,
            chat[0].size.width.0,
            chat[0].size.height.0
        ),
        (20.0, 12.0, 80.0, 32.0)
    );

    let click = |at: Point<Points>| {
        let mut down = MouseDownEvent::default();
        down.button = MouseButton::Left;
        down.position = at;
        down.click_count = 1;
        let mut up = MouseUpEvent::default();
        up.button = MouseButton::Left;
        up.position = at;
        up.click_count = 1;
        surface
            .dispatch_input(PlatformInput::MouseDown(down))
            .unwrap();
        surface.dispatch_input(PlatformInput::MouseUp(up)).unwrap();
    };

    // Hit inside the CSS-translated rect [20..100, 12..44], outside untransformed [0..80, 0..32].
    click(point(px(90.0), px(28.0)));
    clipboard(&surface, "visible-chat");

    let retry = surface.pressable_bounds("Retry");
    assert_eq!(retry.len(), 1);
    click(retry[0].center());
    clipboard(&surface, "retry-clicked");

    // Tab skips hidden, pointerEvents:none, and pointerEvents:box-only inputs.
    key(&surface, "tab");
    pump_until(&surface, || {
        surface.editor_text().as_deref() == Some("live-editor")
    });
    key(&surface, "tab");
    pump_until(&surface, || {
        surface.editor_text().as_deref() == Some("second-editor")
    });
    let mut back_tab = Keystroke::default();
    back_tab.key = "tab".into();
    back_tab.modifiers.shift = true;
    let mut down = KeyDownEvent::default();
    down.keystroke = back_tab.clone();
    let mut up = KeyUpEvent::default();
    up.keystroke = back_tab;
    surface
        .dispatch_input(PlatformInput::KeyDown(down))
        .unwrap();
    surface.dispatch_input(PlatformInput::KeyUp(up)).unwrap();
    pump_until(&surface, || {
        surface.editor_text().as_deref() == Some("live-editor")
    });

    let target_a = surface.text_input_target().unwrap();
    key(&surface, "f6");
    clipboard(&surface, "editor-hidden");
    assert_eq!(surface.text_input_target(), None);
    assert_eq!(surface.editor_text(), None);
    assert!(
        !surface
            .apply_composition(&target_a, "ghost", "", None, false)
            .unwrap()
    );

    key(&surface, "f6");
    clipboard(&surface, "editor-shown");
    key(&surface, "tab");
    pump_until(&surface, || {
        surface.editor_text().as_deref() == Some("live-editor")
    });
    let target_b = surface.text_input_target().unwrap();
    assert_ne!(target_a, target_b);

    key(&surface, "f7");
    clipboard(&surface, "editor-blocked");
    assert_eq!(surface.text_input_target(), None);
    assert_eq!(surface.editor_text(), None);
    assert!(
        !surface
            .apply_composition(&target_b, "ghost", "", None, false)
            .unwrap()
    );

    surface.shutdown();
}

pub(super) fn box_none_input_focus() {
    for pointer_events in ["box-none", "none"] {
        let sink_app = format!(
            r#"
import {{ mount, View }} from "nsh";
import {{ Input }} from "nsh/base";

function App() {{
  return <View style={{{{ flex: 1 }}}}>
    <Input autoFocus defaultValue="sink" style={{{{ width: 1, height: 20, pointerEvents: "{pointer_events}" }}}} />
  </View>;
}}
mount(App);
"#
        );

        let code = nsh_bundler::compile_module("Sink.tsx", &sink_app, &[]).unwrap();
        let mut config = EngineConfig::new(App::Js(Bundle::source(code)));
        config.ui_sets = vec![nsh_base::registry()];
        let surface = TerminalSurface::new(
            config,
            size(DevicePixels(200), DevicePixels(120)),
            1.0,
            Box::new(|_| {}),
            Arc::new(|| {}),
        )
        .unwrap();
        pump_until(&surface, || {
            surface.editor_text().as_deref() == Some("sink")
        });
        surface.set_selected_text_range(4..4).unwrap();
        key(&surface, "q");
        pump_until(&surface, || {
            surface.editor_text().as_deref() == Some("sinkq")
        });

        surface.shutdown();
    }
}

pub(super) fn native_input_clipboard_and_undo() {
    use std::{cell::RefCell, rc::Rc};

    const INPUT_APP: &str = r#"
import { Clipboard, keymap, mount, signal, View } from "nsh";
import { Input } from "nsh/base";

function App() {
  const line = signal("seed");
  const area = signal("");
  let secret = null;
  keymap.bind("f6", () => {
    secret?.focus();
    Clipboard.writeText("secret-focused");
  }, { when: "always" });
  return <View style={{ flex: 1 }}>
    <Input
      autoFocus
      value={line()}
      onChange={({ value }) => line.set(value)}
      onSubmit={({ text }) => Clipboard.writeText(`submitted:${text}`)}
      style={{ width: 220, height: 32 }}
    />
    <Input
      multiline
      value={area()}
      onChange={({ value }) => area.set(value)}
      style={{ width: 220, height: 64 }}
    />
    <Input
      ref={(node) => { secret = node; }}
      masked
      defaultValue="secret-token"
      style={{ width: 220, height: 32 }}
    />
  </View>;
}
mount(App);
"#;

    let make = || {
        let code = nsh_bundler::compile_module("InputClipboard.tsx", INPUT_APP, &[]).unwrap();
        let mut config = EngineConfig::new(App::Js(Bundle::source(code)));
        config.ui_sets = vec![nsh_base::registry()];
        TerminalSurface::new(
            config,
            size(DevicePixels(320), DevicePixels(240)),
            1.0,
            Box::new(|_| {}),
            Arc::new(|| {}),
        )
        .unwrap()
    };
    let chord = |surface: &TerminalSurface, name: &str, shift: bool| {
        let mut stroke = Keystroke::default();
        stroke.key = name.into();
        stroke.modifiers.control = true;
        stroke.modifiers.shift = shift;
        let mut down = KeyDownEvent::default();
        down.keystroke = stroke.clone();
        let mut up = KeyUpEvent::default();
        up.keystroke = stroke;
        surface
            .dispatch_input(PlatformInput::KeyDown(down))
            .unwrap();
        surface.dispatch_input(PlatformInput::KeyUp(up)).unwrap();
    };
    let fence = |surface: &TerminalSurface| {
        let done: Rc<RefCell<Option<Result<(), String>>>> = Rc::new(RefCell::new(None));
        let slot = done.clone();
        surface.pause_input(Box::new(move |res| {
            *slot.borrow_mut() = Some(res);
        }));
        pump_until(surface, || done.borrow().is_some());
        assert_eq!(*done.borrow(), Some(Ok(())));
        surface.resume_input();
    };

    let first = make();
    let second = make();
    pump_until(&first, || first.editor_text().as_deref() == Some("seed"));
    pump_until(&second, || second.editor_text().as_deref() == Some("seed"));

    second.set_clipboard_text("other-surface");
    assert_eq!(second.take_clipboard_write(), None);

    let attached = "/private/var/folders/test/selected.png";
    chord(&first, "a", false);
    assert!(first.paste(nsh_core::PasteEvent::new(attached)));
    pump_until(&first, || first.editor_text().as_deref() == Some(attached));
    chord(&first, "a", false);
    chord(&first, "c", false);
    assert_eq!(first.take_clipboard_write().as_deref(), Some(attached));
    assert_eq!(first.take_clipboard_write(), None);
    assert_eq!(second.take_clipboard_write(), None);

    chord(&second, "a", false);
    chord(&second, "v", false);
    pump_until(&second, || {
        second.editor_text().as_deref() == Some("other-surface")
    });

    chord(&first, "a", false);
    chord(&first, "x", false);
    assert_eq!(first.take_clipboard_write().as_deref(), Some(attached));
    pump_until(&first, || first.editor_text().as_deref() == Some(""));

    chord(&first, "z", false);
    pump_until(&first, || first.editor_text().as_deref() == Some(attached));
    chord(&first, "z", true);
    pump_until(&first, || first.editor_text().as_deref() == Some(""));

    first.set_clipboard_text("Read the project\nFix it");
    assert_eq!(first.take_clipboard_write(), None);
    chord(&first, "v", false);
    pump_until(&first, || {
        first.editor_text().as_deref() == Some("Read the project Fix it")
    });

    key(&first, "tab");
    pump_until(&first, || first.editor_text().as_deref() == Some(""));
    chord(&first, "v", false);
    pump_until(&first, || {
        first.editor_text().as_deref() == Some("Read the project\nFix it")
    });

    let mut back_tab = Keystroke::default();
    back_tab.key = "tab".into();
    back_tab.modifiers.shift = true;
    let mut down = KeyDownEvent::default();
    down.keystroke = back_tab.clone();
    let mut up = KeyUpEvent::default();
    up.keystroke = back_tab;
    first.dispatch_input(PlatformInput::KeyDown(down)).unwrap();
    first.dispatch_input(PlatformInput::KeyUp(up)).unwrap();
    pump_until(&first, || {
        first.editor_text().as_deref() == Some("Read the project Fix it")
    });

    key(&first, "enter");
    clipboard(&first, "submitted:Read the project Fix it");

    key(&first, "f6");
    clipboard(&first, "secret-focused");
    pump_until(&first, || {
        first.text_input_target().is_some() && first.editor_text().is_none()
    });
    chord(&first, "a", false);
    chord(&first, "c", false);
    chord(&first, "x", false);
    fence(&first);
    assert_eq!(first.take_clipboard_write(), None);

    first.shutdown();
    second.shutdown();
}

pub(super) fn rich_editor_to_box_none_input_focus_transition() {
    const TRANSITION_APP: &str = r#"
import { Clipboard, keymap, mount, signal, View } from "nsh";
import { createRichEditor, defineExtension, Input, RichEditor, RichEditorPlugin, StarterKit } from "nsh/base";

function App() {
  const attaching = signal(false);
  const path = signal("");
  const toggle = () => attaching.update((open) => !open);
  const keys = new RichEditorPlugin("attachKey");
  keys.captureKeys(["Mod-u"], toggle);
  keys.capturing = true;
  const attachKey = defineExtension({
    name: "attachKey",
    priority: 200,
    addProseMirrorPlugins: () => [keys],
  });
  const session = createRichEditor({ extensions: [StarterKit, attachKey] });
  let editor = null;
  keymap.bind("mod+u", toggle, { when: "always" });
  return <View style={{ flex: 1 }}>
    <RichEditor
      editor={session}
      ref={(node) => { editor = node; }}
      autoFocus
      style={{ flex: 1, height: 120 }}
    />
    {() => attaching() ? (
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, pointerEvents: "box-none" }}>
        <View style={{ height: 40 }}>
          <Input
            accessibilityLabel="Attachment path"
            autoFocus
            value={path()}
            onChange={({ value }) => path.set(value)}
            onSubmit={({ text }) => {
              Clipboard.writeText(`attached:${text}`);
              path.set("");
              attaching.set(false);
              editor?.focus();
            }}
            style={{ width: 260, height: 32 }}
          />
        </View>
      </View>
    ) : null}
  </View>;
}
mount(App);
"#;

    let code = nsh_bundler::compile_module("RichEditorAttach.tsx", TRANSITION_APP, &[]).unwrap();
    let mut config = EngineConfig::new(App::Js(Bundle::source(code)));
    config.ui_sets = vec![nsh_base::registry()];
    let surface = TerminalSurface::new(
        config,
        size(DevicePixels(320), DevicePixels(240)),
        1.0,
        Box::new(|_| {}),
        Arc::new(|| {}),
    )
    .unwrap();
    let chord = |name: &str| {
        let mut stroke = Keystroke::default();
        stroke.key = name.into();
        stroke.modifiers.control = true;
        let mut down = KeyDownEvent::default();
        down.keystroke = stroke.clone();
        let mut up = KeyUpEvent::default();
        up.keystroke = stroke;
        surface
            .dispatch_input(PlatformInput::KeyDown(down))
            .unwrap();
        surface.dispatch_input(PlatformInput::KeyUp(up)).unwrap();
    };
    let copy_focused = || {
        let _ = surface.take_clipboard_write();
        chord("a");
        chord("c");
        let mut copied = None;
        pump_until(&surface, || {
            if copied.is_none() {
                copied = surface.take_clipboard_write();
            }
            copied.is_some()
        });
        copied.unwrap()
    };

    pump_until(&surface, || surface.text_input_target().is_some());
    let editor_target = surface.text_input_target();

    // Open the attachment field via Ctrl+U and wait only for the native responder swap
    // (without calling `pause_input`), matching `Desktop::attach` -> `type_text` -> `copy_input`.
    chord("u");
    pump_until(&surface, || {
        let current = surface.text_input_target();
        current.is_some() && current != editor_target
    });
    let picker_target = surface.text_input_target();

    let attached = "/private/var/folders/test/selected.png";
    chord("a");
    assert!(surface.paste(nsh_core::PasteEvent::new(attached)));
    assert_eq!(copy_focused(), attached);

    key(&surface, "enter");
    clipboard(&surface, &format!("attached:{attached}"));
    pump_until(&surface, || {
        let current = surface.text_input_target();
        current.is_some() && current != picker_target
    });

    let draft = "FIRST_DESKTOP_MESSAGE";
    chord("a");
    assert!(surface.paste(nsh_core::PasteEvent::new(draft)));
    assert_eq!(copy_focused(), draft);
    surface.shutdown();
}

pub(super) fn unfocused_readonly_input_preserves_focused_target() {
    const SIDE_DRAFT_APP: &str = r#"
import { Clipboard, host, keymap, mount, signal, View } from "nsh";
import { Input } from "nsh/base";

function App() {
  const main = signal("MAIN_DRAFT");
  const side = signal("");
  const sideMounted = signal(false);
  const sideReady = signal(false);
  let sideRef = null;
  host.on("mount-side", () => {
    sideMounted.set(true);
    Clipboard.writeText("side-mounted");
  });
  host.on("ready-side", () => {
    sideReady.set(true);
    Clipboard.writeText("side-ready");
  });
  keymap.bind("f8", () => {
    sideRef?.focus();
    Clipboard.writeText("side-focused");
  }, { when: "always" });
  keymap.bind("f9", () => {
    Clipboard.writeText(`${main()}|${side()}`);
  }, { when: "always" });
  return <View style={{ flex: 1 }}>
    <Input
      accessibilityLabel="Main composer"
      autoFocus
      value={main()}
      onChange={({ value }) => main.set(value)}
      style={{ width: 260, height: 32 }}
    />
    {() => sideMounted() ? (
      <Input
        accessibilityLabel="Side composer"
        ref={(node) => { sideRef = node; }}
        readonly={!sideReady()}
        value={side()}
        onChange={({ value }) => side.set(value)}
        style={{ width: 260, height: 32 }}
      />
    ) : null}
  </View>;
}
mount(App);
"#;

    let code = nsh_bundler::compile_module("SideDraft.tsx", SIDE_DRAFT_APP, &[]).unwrap();
    let mut config = EngineConfig::new(App::Js(Bundle::source(code)));
    config.ui_sets = vec![nsh_base::registry()];
    let host = config.host.clone();
    let surface = TerminalSurface::new(
        config,
        size(DevicePixels(320), DevicePixels(240)),
        1.0,
        Box::new(|_| {}),
        Arc::new(|| {}),
    )
    .unwrap();
    pump_until(&surface, || {
        surface.editor_text().as_deref() == Some("MAIN_DRAFT")
    });
    let main_target = surface.text_input_target().unwrap();
    assert!(
        surface
            .apply_composition(&main_target, "", "ni", Some(2..2), true)
            .unwrap()
    );

    // Mounting a read-only background input and flipping it editable while unfocused
    // must not advance or revoke the focused main editor's target or preedit.
    host.send("mount-side", serde_json::Value::Null).unwrap();
    clipboard(&surface, "side-mounted");
    assert_eq!(surface.text_input_target().as_ref(), Some(&main_target));

    host.send("ready-side", serde_json::Value::Null).unwrap();
    clipboard(&surface, "side-ready");
    assert_eq!(surface.text_input_target().as_ref(), Some(&main_target));
    assert!(
        surface
            .apply_composition(&main_target, "", "", None, false)
            .unwrap()
    );
    assert_eq!(surface.editor_text().as_deref(), Some("MAIN_DRAFT"));

    // Focusing the side input advances `text_input_target()` only once focus actually moves.
    key(&surface, "f8");
    clipboard(&surface, "side-focused");
    pump_until(&surface, || {
        surface
            .text_input_target()
            .as_ref()
            .is_some_and(|target| target != &main_target)
    });
    assert!(surface.paste(nsh_core::PasteEvent::new("SIDE_DRAFT")));
    pump_until(&surface, || {
        surface.editor_text().as_deref() == Some("SIDE_DRAFT")
    });

    key(&surface, "f9");
    clipboard(&surface, "MAIN_DRAFT|SIDE_DRAFT");
    surface.shutdown();
}

pub(super) fn rich_editor_composition_commit_matches_preedit() {
    use std::{cell::RefCell, rc::Rc};

    const IME_EDITOR_APP: &str = r#"
import { mount, signal, View } from "nsh";
import { createRichEditor, RichEditor, StarterKit } from "nsh/base";

function App() {
  const session = createRichEditor({ extensions: [StarterKit] });
  const composing = signal(false);
  return <View style={{ flex: 1 }}>
    <View
      onPress={() => {}}
      accessibilityLabel={composing() ? "Composing" : "Idle"}
      style={{ width: 20, height: 20 }}
    />
    <RichEditor
      editor={session}
      autoFocus
      onCompositionChange={({ composing: next }) => composing.set(next)}
      style={{ flex: 1, height: 120 }}
    />
  </View>;
}
mount(App);
"#;

    let code = nsh_bundler::compile_module("ImeEditor.tsx", IME_EDITOR_APP, &[]).unwrap();
    let mut config = EngineConfig::new(App::Js(Bundle::source(code)));
    config.ui_sets = vec![nsh_base::registry()];
    let surface = TerminalSurface::new(
        config,
        size(DevicePixels(320), DevicePixels(240)),
        1.0,
        Box::new(|_| {}),
        Arc::new(|| {}),
    )
    .unwrap();
    let chord = |name: &str| {
        let mut stroke = Keystroke::default();
        stroke.key = name.into();
        stroke.modifiers.control = true;
        let mut down = KeyDownEvent::default();
        down.keystroke = stroke.clone();
        let mut up = KeyUpEvent::default();
        up.keystroke = stroke;
        surface
            .dispatch_input(PlatformInput::KeyDown(down))
            .unwrap();
        surface.dispatch_input(PlatformInput::KeyUp(up)).unwrap();
    };
    let fence = || {
        let done: Rc<RefCell<Option<Result<(), String>>>> = Rc::new(RefCell::new(None));
        let slot = done.clone();
        surface.pause_input(Box::new(move |res| {
            *slot.borrow_mut() = Some(res);
        }));
        pump_until(&surface, || done.borrow().is_some());
        assert_eq!(*done.borrow(), Some(Ok(())));
        surface.resume_input();
    };
    let copy_focused = || {
        let _ = surface.take_clipboard_write();
        chord("a");
        chord("c");
        let mut copied = None;
        pump_until(&surface, || {
            if copied.is_none() {
                copied = surface.take_clipboard_write();
            }
            copied.is_some()
        });
        copied.unwrap()
    };

    // 1. Unsettled autoFocus fence: queued composition survives Enter + Escape before commit.
    pump_until(&surface, || surface.text_input_target().is_some());
    let target = surface.text_input_target().unwrap();
    assert!(
        surface
            .apply_composition(&target, "", "方向", Some(2..2), true)
            .unwrap()
    );
    key(&surface, "enter");
    key(&surface, "escape");
    assert!(
        surface
            .apply_composition(&target, "方向", "", None, false)
            .unwrap()
    );
    assert_eq!(copy_focused(), "方向");

    // 2. Settled empty editor: live NSTextView marked text where `commit == preedit` still commits
    //    and exits RichEditor's composing state cleanly.
    chord("a");
    key(&surface, "backspace");
    fence();
    assert_eq!(surface.editor_text().as_deref(), Some(""));
    let target = surface.text_input_target().unwrap();
    assert!(
        surface
            .apply_composition(&target, "", "再试", Some(2..2), true)
            .unwrap()
    );
    pump_until(&surface, || {
        !surface.pressable_bounds("Composing").is_empty()
    });
    key(&surface, "enter");
    key(&surface, "escape");
    assert!(
        surface
            .apply_composition(&target, "再试", "", None, false)
            .unwrap()
    );
    pump_until(&surface, || !surface.pressable_bounds("Idle").is_empty());
    assert_eq!(copy_focused(), "再试");

    let next = "Check keyboard focus too.";
    chord("a");
    assert!(surface.paste(nsh_core::PasteEvent::new(next)));
    assert_eq!(copy_focused(), next);
    surface.shutdown();
}

pub(super) fn focused_rich_editor_yields_copy_to_selected_output() {
    use nsh_terminal::{MouseButton, MouseDownEvent, MouseUpEvent, point, px};

    const PAGE_COPY_APP: &str = r#"
import { keymap, mount, signal, Text, View } from "nsh";
import { createRichEditor, RichEditor, StarterKit } from "nsh/base";

function App() {
  const session = createRichEditor({ extensions: [StarterKit], content: "draft text" });
  const focused = signal(false);
  let editor = null;
  keymap.bind("f6", () => editor?.focus(), { when: "always" });
  return <View style={{ flex: 1 }}>
    <View selectable style={{ height: 32 }}>
      <Text>Model output</Text>
    </View>
    <View
      onPress={() => {}}
      accessibilityLabel={focused() ? "EditorFocused" : "EditorBlurred"}
      style={{ width: 20, height: 20 }}
    />
    <RichEditor
      editor={session}
      ref={(node) => { editor = node; }}
      autoFocus
      onFocus={() => focused.set(true)}
      onBlur={() => focused.set(false)}
      style={{ flex: 1, height: 120 }}
    />
  </View>;
}
mount(App);
"#;

    let code = nsh_bundler::compile_module("PageCopy.tsx", PAGE_COPY_APP, &[]).unwrap();
    let mut config = EngineConfig::new(App::Js(Bundle::source(code)));
    config.ui_sets = vec![nsh_base::registry()];
    let surface = TerminalSurface::new(
        config,
        size(DevicePixels(320), DevicePixels(240)),
        1.0,
        Box::new(|_| {}),
        Arc::new(|| {}),
    )
    .unwrap();
    let chord = |name: &str| {
        let mut stroke = Keystroke::default();
        stroke.key = name.into();
        stroke.modifiers.control = true;
        let mut down = KeyDownEvent::default();
        down.keystroke = stroke.clone();
        let mut up = KeyUpEvent::default();
        up.keystroke = stroke;
        surface
            .dispatch_input(PlatformInput::KeyDown(down))
            .unwrap();
        surface.dispatch_input(PlatformInput::KeyUp(up)).unwrap();
    };
    let expect_copied = |expected: &str| {
        let mut copied = None;
        pump_until(&surface, || {
            if copied.is_none() {
                copied = surface.take_clipboard_write();
            }
            copied.is_some()
        });
        assert_eq!(copied.as_deref(), Some(expected));
    };

    pump_until(&surface, || {
        !surface.pressable_bounds("EditorFocused").is_empty()
    });

    // Double-click "Model" in the selectable output (blurring RichEditor), then
    // refocus RichEditor programmatically so the output selection remains active.
    let at = point(px(12.0), px(12.0));
    let mut down = MouseDownEvent::default();
    down.button = MouseButton::Left;
    down.position = at;
    down.click_count = 2;
    let mut up = MouseUpEvent::default();
    up.button = MouseButton::Left;
    up.position = at;
    up.click_count = 2;
    surface
        .dispatch_input(PlatformInput::MouseDown(down))
        .unwrap();
    surface.dispatch_input(PlatformInput::MouseUp(up)).unwrap();
    pump_until(&surface, || {
        !surface.pressable_bounds("EditorBlurred").is_empty()
    });

    key(&surface, "f6");
    pump_until(&surface, || {
        !surface.pressable_bounds("EditorFocused").is_empty()
    });

    let _ = surface.take_clipboard_write();
    chord("c");
    expect_copied("Model");

    let _ = surface.take_clipboard_write();
    chord("a");
    chord("c");
    expect_copied("draft text");
    surface.shutdown();
}

pub(super) fn retained_image() {
    use std::{
        cell::Cell,
        rc::Rc,
        sync::{Condvar, Mutex},
    };
    #[derive(Default)]
    struct Frames {
        released: Mutex<usize>,
        changed: Condvar,
        requested: Mutex<usize>,
    }
    impl Frames {
        fn release(&self, frame: usize) {
            *self.released.lock().unwrap() = frame;
            self.changed.notify_all();
        }
    }
    impl nsh_engine::Assets for Frames {
        fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
            let frame: usize = uri
                .rsplit_once('-')
                .unwrap()
                .1
                .strip_suffix(".svg")
                .unwrap()
                .parse()
                .unwrap();
            *self.requested.lock().unwrap() = frame;
            let mut released = self.released.lock().unwrap();
            while frame > *released {
                released = self.changed.wait(released).unwrap();
            }
            if frame == 4 {
                return Ok(b"invalid image".to_vec());
            }
            let color = match frame {
                0 => "red",
                3 => "blue",
                _ => "lime",
            };
            Ok(format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="{color}"/></svg>"#).into_bytes())
        }
    }
    struct Release(Arc<Frames>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.release(usize::MAX);
        }
    }
    for retain in [false, true] {
        let script = r##"
            import { mount, signal, keymap } from "nsh";
            import { element, prop, insert } from "nsh:rt";
            mount(() => {
                const root = element("view"), picture = element("image"), shown = signal(true);
                prop(root, "style", { flex: 1, backgroundColor: "#000" });
                prop(picture, "style", { width: 32, height: 32 });
                prop(picture, "fadeDuration", 0);
                prop(picture, "retainPrevious", RETAIN);
                prop(picture, "src", "asset:/retain-0.svg");
                insert(root, () => shown() ? picture : null);
                for (const n of [1,2,3,4,7]) keymap.bind("f" + n, () => prop(picture, "src", "asset:/retain-" + n + ".svg"), {when:"always"});
                keymap.bind("f5", () => prop(picture, "src", ""), {when:"always"});
                keymap.bind("f6", () => shown.set(false), {when:"always"});
                return root;
            });
        "##.replace("RETAIN", if retain { "true" } else { "false" });
        let assets = Arc::new(Frames::default());
        let mut config = EngineConfig::new(App::Js(Bundle::source(script)));
        config.assets = Some(assets.clone());
        let pixel = Rc::new(Cell::new([0u8; 4]));
        let observed = pixel.clone();
        let phase = Rc::new(Cell::new(0));
        let observed_phase = phase.clone();
        let surface = TerminalSurface::new(
            config,
            size(DevicePixels(64), DevicePixels(64)),
            1.0,
            Box::new(move |frame| {
                let frame = frame.submit().unwrap().complete().unwrap();
                let rgba: [u8; 4] = frame.pixels()[(16 * 64 + 16) * 4..][..4]
                    .try_into()
                    .unwrap();
                match observed_phase.get() {
                    1 => assert!(
                        rgba == [255, 0, 0, 255] || rgba == [0, 255, 0, 255],
                        "replacement flashed: {rgba:?}"
                    ),
                    2 => assert!(
                        rgba == [0, 0, 0, 255] || rgba == [0, 0, 255, 255],
                        "cleared decode resurrected: {rgba:?}"
                    ),
                    3 => assert_eq!(rgba, [0, 0, 0, 255], "unmounted decode resurrected"),
                    _ => {}
                }
                observed.set(
                    frame.pixels()[(16 * 64 + 16) * 4..][..4]
                        .try_into()
                        .unwrap(),
                );
            }),
            Arc::new(|| {}),
        )
        .unwrap();
        let _release = Release(assets.clone());
        let pump = |done: &dyn Fn() -> bool| {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                surface.pump_with_draw(true);
                assert_eq!(surface.take_error(), None);
                if done() {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "pixel {:?}, retain {retain}",
                    pixel.get()
                );
            }
        };
        pump(&|| pixel.get() == [255, 0, 0, 255]);
        if retain {
            phase.set(1);
        }
        key(&surface, "f1");
        pump(&|| *assets.requested.lock().unwrap() == 1);
        assert_eq!(
            pixel.get(),
            if retain {
                [255, 0, 0, 255]
            } else {
                [0, 0, 0, 255]
            },
            "replacement decode must retain only when opted in"
        );
        assets.release(1);
        pump(&|| pixel.get() == [0, 255, 0, 255]);
        // A pending replacement cannot resurrect after explicit clear.
        key(&surface, "f2");
        pump(&|| *assets.requested.lock().unwrap() == 2);
        phase.set(0);
        key(&surface, "f5");
        pump(&|| pixel.get() == [0, 0, 0, 255]);
        phase.set(2);
        assets.release(2);
        key(&surface, "f3");
        assets.release(3);
        pump(&|| pixel.get() == [0, 0, 255, 255]);
        phase.set(0);
        key(&surface, "f4");
        pump(&|| *assets.requested.lock().unwrap() == 4);
        assets.release(4);
        pump(&|| pixel.get() == [0, 0, 0, 255]);
        key(&surface, "f7");
        pump(&|| *assets.requested.lock().unwrap() == 7);
        key(&surface, "f6");
        // Black predates removal; fence the input before releasing the decode.
        let removed = Rc::new(Cell::new(false));
        let done = removed.clone();
        surface.pause_input(Box::new(move |result| {
            result.expect("remove input fence");
            done.set(true);
        }));
        pump(&|| removed.get());
        surface.resume_input();
        pump(&|| pixel.get() == [0, 0, 0, 255]);
        phase.set(3);
        assets.release(7);
        let until = Instant::now() + Duration::from_millis(100);
        while Instant::now() < until {
            surface.pump_with_draw(true);
            assert_eq!(surface.take_error(), None);
            assert_eq!(pixel.get(), [0, 0, 0, 255]);
        }
        surface.shutdown();
    }
}
