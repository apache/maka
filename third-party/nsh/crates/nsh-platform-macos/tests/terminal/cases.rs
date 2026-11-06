//! Migrates the removed GPUI window tests' native focus/scoped-binding invariants.
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use nsh_engine::{App, Bundle, EngineConfig};
use nsh_platform_macos::TerminalSurface;
use nsh_terminal::{
    DevicePixels, KeyDownEvent, KeyUpEvent, Keystroke, NativeSurface, PlatformInput, size,
};

const APP: &str = r#"
import { mount, signal, View, keymap, Clipboard } from "nsh";
import { Input, Popover } from "nsh/base";
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
    <Popover open={popup()} onOpenChange={({open}) => popup.set(open)}>
      <Input autoFocus defaultValue="popup" style={{width: 160, height: 40}} />
    </Popover>
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
