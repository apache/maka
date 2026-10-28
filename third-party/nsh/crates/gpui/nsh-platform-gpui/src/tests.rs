//! Tests in windows of GPUI's test platform (`TestAppContext`; feature
//! `shot`, which turns on GPUI's test support): a surface drawn by GPUI
//! and given GPUI's input, with the engine running on its own thread.

use std::{
    rc::Rc,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use gpui::{
    AnyElement, App as GpuiApp, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement,
    Styled, TestAppContext, VisualTestContext, Window, div,
};

use crate::{App, AppOptions, AppView, Bundle, NativeComponent, Root};

/// Host functions supplied through the embedding configuration.
#[nsh_core::element::module]
pub(crate) struct EmbeddingHost;

#[nsh_core::element::module]
impl EmbeddingHost {
    /// Identifies the registry supplied with the engine configuration.
    pub(crate) fn label() -> String {
        "configured host".to_owned()
    }
}

struct ImageAssets {
    png: Vec<u8>,
    reads: Mutex<Vec<String>>,
}

impl ImageAssets {
    fn new(width: u32, height: u32) -> Self {
        use image::{ExtendedColorType, ImageEncoder, codecs::png::PngEncoder};
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(
                &vec![255; (width * height * 4) as usize],
                width,
                height,
                ExtendedColorType::Rgba8,
            )
            .unwrap();
        Self {
            png,
            reads: Mutex::default(),
        }
    }
}

impl nsh_engine::Assets for ImageAssets {
    fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
        self.reads.lock().unwrap().push(uri.to_owned());
        if uri == "asset:/same-preview.png" {
            Ok(self.png.clone())
        } else {
            Err(format!("unexpected asset: {uri}"))
        }
    }
}

const CONFIGURED_IMAGE: &str = r#"
import { mount, signal, View } from "nsh";
import { Input } from "nsh/base";
import { windowSize } from "nsh";
import { Image } from "nsh";
import { nativeModule } from "nsh";

const { EmbeddingHost } = nativeModule<{ EmbeddingHost: { label(): string } }>("test/embedding");
const label = EmbeddingHost.label();
const policy = eval("'development policy'");
function App() {
  const loaded = signal("waiting");
  return (
    <View style={{ flex: 1, padding: 8 }}>
      <Image
        src="asset:/same-preview.png"
        onLoad={(e) => loaded.set(`${label}|${policy}|${e.width}x${e.height}`)}
        onError={(e) => loaded.set(e.message)}
        style={{ width: 32, height: 32 }}
      />
      <Input
        autoFocus
        value={`${loaded()}|${windowSize().width}x${windowSize().height}`}
        style={{ height: 30 }}
      />
    </View>
  );
}
mount(App);
"#;

const SCOPED_BUTTONS: &str = r#"
import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { Button, Dialog, Popover } from "nsh/base";
import { colorScheme } from "nsh";
import { keymap } from "nsh";
import { nativeComponent } from "nsh";

const FocusSquare = nativeComponent<{}, {}>("test.focus-square", { props: [], events: [] });

function App() {
  const log = signal<string[]>([]);
  const open = signal(false);
  const popup = signal(false);
  const record = (event: string) => log.set([...log(), event]);
  let scope, a, b, native;
  keymap.bind("f6", () => record(`global:${keymap.focusedWithin(scope)}:${keymap.focusedWithin(a)}:${keymap.focusedWithin(b)}`), { when: "always" });
  keymap.bind("f10", () => popup.set(true), { when: "always" });
  keymap.bind("f9", () => {
    record("request-native");
    popup.set(false);
    native.focus();
    record("requested-native");
  }, { when: "always" });
  return (
    <View style={{ flex: 1, gap: 8 }}>
      <Input testID="report" autoFocus value={`${log().join("|")}@${colorScheme()}`}
        onChange={() => record("unexpected edit")} style={{ height: 30 }} />
      <Button disabled onPress={() => record("disabled")}><Text>Disabled</Text></Button>
      <Button style={{ display: "none" }} onPress={() => record("hidden")}><Text>Hidden</Text></Button>
      <Button focusable={false} onPress={() => record("not tabbable")}><Text>No Tab stop</Text></Button>
      <View ref={(node) => {
        scope = node;
        keymap.bind("f6", () => record(`scope:${keymap.focusedWithin(scope)}:${keymap.focusedWithin(a)}:${keymap.focusedWithin(b)}`),
          { when: "always", within: node });
      }}>
        <Button testID="a" ref={(node) => a = node} onPress={() => record("A")}><Text>A</Text></Button>
      </View>
      <FocusSquare testID="native" ref={(node) => native = node} style={{ width: 40, height: 24 }} />
      <Button testID="b" ref={(node) => b = node} onPress={() => record("B")}><Text>B</Text></Button>
      <Button testID="opener" onPress={() => { record("open"); open.set(true); }}><Text>Open dialog</Text></Button>
      <Dialog open={open()} animation="none" onOpen={() => record("shown")}
        onClose={() => record("closed")} onOpenChange={(next) => open.set(next)}>
        <Button testID="modal" onPress={() => record("modal")}><Text>Modal action</Text></Button>
      </Dialog>
      <Popover open={popup()} onOpenChange={(next) => popup.set(next)}>
        <Button testID="popup-action" onPress={() => {}}><Text>Popup action</Text></Button>
      </Popover>
    </View>
  );
}
mount(App);
"#;

const NATIVE_KEYBOARD: &str = r#"
import { effect, mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { keymap } from "nsh";

function App() {
  const owner = signal(0), thinking = signal(0), focused = signal("");
  const submitted = signal(""), escapes = signal(0), moves = signal(0);
  const revision = signal(0), hit = signal("");
  let editor, next;
  keymap.bind("f7", () => thinking.set(thinking() + 1), { when: "always" });
  keymap.bind("f8", () => owner.set(owner() + 1), { when: "always" });
  keymap.bind("f10", () => revision.set(revision() + 1), { when: "always" });
  keymap.bind("f9", () => {
    moves.set(moves() + 1);
    (focused() === "next" ? editor : next).focus();
  }, { when: "always" });
  return <View style={{ flex: 1 }}>
    <Input testID="report" readonly focusable={false}
      value={`${owner()}|${thinking()}|${focused()}|${submitted()}|${escapes()}|${moves()}|${revision()}|${hit()}`}
      style={{ height: 30 }} />
    <Text>Thinking {thinking()}</Text>
    <Each of={[owner()]} key={(id) => id}>{(row) => {
      const id = row();
      return <View ref={(node) => {
        keymap.bind("escape", () => escapes.set(escapes() + 1), { when: "always", within: node });
        effect(() => {
          const version = revision();
          return keymap.bind("f6", () => hit.set(`${id}:${version}`), { when: "always", within: node });
        });
      }}>
        <Input testID="editor" ref={(node) => editor = node} autoFocus multiline
          submitBehavior="submit" defaultValue=""
          onFocus={() => focused.set(`editor:${id}`)}
          onSubmit={(event) => submitted.set(`${id}:${event.text}`)}
          style={{ height: 40 }} />
      </View>;
    }}</Each>
    <Input testID="next" ref={(node) => next = node} defaultValue="next"
      onFocus={() => focused.set("next")} style={{ height: 30 }} />
    <Input testID="plain" defaultValue="abcdef" style={{ width: 160, height: 30 }} />
  </View>;
}
mount(App);
"#;

struct FocusSquare {
    focus: Option<FocusHandle>,
}

impl NativeComponent for FocusSquare {
    fn render(&mut self, _: &mut Window, cx: &mut GpuiApp) -> Option<AnyElement> {
        let focus = self.focus.get_or_insert_with(|| cx.focus_handle()).clone();
        Some(
            div()
                .id("focus-square")
                .track_focus(&focus)
                .size_full()
                .into_any_element(),
        )
    }

    fn focus_handle(&self) -> Option<FocusHandle> {
        self.focus.clone()
    }

    fn set_prop(
        &mut self,
        _: &str,
        _: Option<&serde_json::Value>,
        _: &mut Window,
        _: &mut GpuiApp,
    ) {
    }
}

/// A native component that only draws a box.
struct Square;

impl NativeComponent for Square {
    fn render(&mut self, _: &mut Window, _: &mut GpuiApp) -> Option<AnyElement> {
        Some(div().size_full().into_any_element())
    }

    fn set_prop(
        &mut self,
        _: &str,
        _: Option<&serde_json::Value>,
        _: &mut Window,
        _: &mut GpuiApp,
    ) {
    }
}

/// A component and, after it, a focused field.
const FIELD_AFTER_COMPONENT: &str = r#"
import { mount, signal, View } from "nsh";
import { Input } from "nsh/base";
import { nativeComponent } from "nsh";

const Square = nativeComponent<{}, {}>("test.square", { props: [], events: [] });

function App() {
  const text = signal("abcd");
  return (
    <View style={{ flex: 1, padding: 8, gap: 8 }}>
      <Square style={{ width: 40, height: 20 }} />
      <Input autoFocus value={text()} onChange={(t) => text.set(t)} style={{ height: 30 }} />
    </View>
  );
}
mount(App);
"#;

/// A focused field that logs its input method's compositions and sets
/// values while they are in progress: "held" on "ni" (applied once the
/// composition is cancelled), "stale" on "hao" (dropped, as "好" is
/// committed after it); the log becomes the text when "hao" ends.
const COMPOSING_FIELD: &str = r#"
import { mount, signal, View } from "nsh";
import { Input } from "nsh/base";

function App() {
  const text = signal("abcd");
  const log: string[] = [];
  return (
    <View style={{ flex: 1, padding: 8 }}>
      <Input
        autoFocus
        value={text()}
        onChange={(t) => {
          log.push("change " + t);
          text.set(t);
        }}
        onCompositionChange={(e) => {
          log.push(e.composing ? "compose " + e.text : "end");
          if (e.text === "ni") text.set("held");
          if (e.text === "hao") text.set("stale");
          if (!e.composing && log.length > 2) text.set(log.join("|"));
        }}
        style={{ height: 30 }}
      />
    </View>
  );
}
mount(App);
"#;

/// A host view around a surface that holds the window's focus itself,
/// as an embedding app's own widgets do.
struct Host {
    view: Entity<AppView>,
    focus: gpui::FocusHandle,
}

impl gpui::Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut gpui::Context<Self>) -> impl IntoElement {
        use gpui::{InteractiveElement as _, ParentElement as _};
        div()
            .size_full()
            .track_focus(&self.focus)
            .child(self.view.clone())
    }
}

/// The focused field's text.
fn field_text(view: &Entity<AppView>, cx: &mut VisualTestContext) -> Option<String> {
    view.read_with(cx, |view, _| {
        crate::text_input::focused(view.surface())
            .and_then(|field| crate::text_input::accessible_value(&field))
            .map(|value| value.text)
    })
}

/// The value the focused field holds until its composition ends.
fn field_pending(view: &Entity<AppView>, cx: &mut VisualTestContext) -> Option<String> {
    view.read_with(cx, |view, _| {
        crate::text_input::focused(view.surface())
            .and_then(|field| crate::text_input::pending_value(&field))
    })
}

/// Runs the window until the focused field holds `text` for after its
/// composition.
fn wait_for_pending(view: &Entity<AppView>, cx: &mut VisualTestContext, text: &str) {
    let start = Instant::now();
    loop {
        cx.run_until_parked();
        let now = field_pending(view, cx);
        if now.as_deref() == Some(text) {
            return;
        }
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "the field holds {now:?}, not {text:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// An input method's step on the focused field.
fn ime(
    view: &Entity<AppView>,
    cx: &mut VisualTestContext,
    f: impl FnOnce(&Rc<crate::surface::Surface>),
) {
    view.update(cx, |view, _| f(view.surface()));
}

/// Runs the window (and waits for the engine's thread) until the focused
/// field reads `text`.
fn wait_for(view: &Entity<AppView>, cx: &mut VisualTestContext, text: &str) {
    let start = Instant::now();
    loop {
        cx.run_until_parked();
        let now = field_text(view, cx);
        if now.as_deref() == Some(text) {
            return;
        }
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "the field reads {now:?}, not {text:?}: {}",
            view.read_with(cx, |view, _| focus_diagnostic(view.surface()))
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// The tests in windows, one after the other in one app: the main
/// thread's queue (`crate::rt`) is made once per process, for the first
/// app, so every window's engine must post to that app.
#[gpui::test]
fn windows(cx: &mut TestAppContext) {
    // The engine (and the settings portal) run on threads of their own.
    cx.executor().allow_parking();
    text_typed_ahead_of_enter_or_a_binding_lands_in_the_next_field(cx);
    keys_reach_the_fields_of_a_surface_showing_a_native_component(cx);
    #[cfg(feature = "dev")]
    synthetic_keys_type_printable_characters_after_shortcuts(cx);
    compositions_are_reported_and_hold_values_until_they_end(cx);
    menu_shortcuts_leave_a_focused_field_the_keys_it_uses(cx);
    presses_carry_where_the_pointer_was(cx);
    files_dropped_from_outside_reach_the_view_under_them(cx);
    presses_carry_the_modifier_keys_and_click_count(cx);
    an_embedded_surface_takes_the_keyboard_when_its_app_focuses_a_field(cx);
    the_app_s_shortcuts_reach_it_while_a_native_component_has_the_keyboard(cx);
    configured_assets_stay_with_their_original_load(cx);
    buttons_keep_native_focus_and_live_key_scopes(cx);
    native_keys_keep_their_owner_across_redraws(cx);
    multiline_fields_keep_file_bytes_and_enter_line_endings(cx);
    js_and_rust_view_shortcuts_fire_together_in_either_order(cx);
    each_view_s_functions_read_the_context_its_options_gave_its_engine(cx);
    an_embedded_view_that_owns_its_window_sets_its_title_and_menu(cx);
    quit_and_close_requests_go_to_the_handler_instead_of_acting(cx);
    an_auto_hidden_menu_bar_shows_on_alt_alone_and_while_a_menu_is_open(cx);
    asset_uris_resolve_in_the_first_directory_that_has_the_file(cx);
    releasing_shift_before_alt_keeps_the_auto_hidden_menu_bar_hidden(cx);
}

fn multiline_fields_keep_file_bytes_and_enter_line_endings(cx: &mut TestAppContext) {
    let source = r#"
import { mount, signal, View } from "nsh";
import { Input } from "nsh/base";
import { keymap } from "nsh";
const value = signal("  A\t中\r\nB\rC\n\n");
const behavior = signal("insert");
const readonly = signal(false);
const pastes = signal<string[]>([]);
keymap.bind("f4", () => behavior.set("report"), { when: "always" });
keymap.bind("f5", () => readonly.set(true), { when: "always" });
mount(() => <View>
  <Input autoFocus multiline submitBehavior="newline" value={value()}
    pasteBehavior={behavior()} readonly={readonly()}
    onFileDrop={() => {}}
    onPaste={(event) => pastes.set([...pastes(), event.uris.length ? event.uris.join(";") : event.text])}
    onChange={(text) => value.set(text)} style={{ height: 160 }} />
  <Input testID="report" readonly value={`${behavior()}|${readonly()}|${pastes().join(",")}`}
    style={{ height: 30 }} />
</View>);
"#;
    let code = nsh_bundler::compile_module("App.tsx", source, &[]).unwrap();
    let (view, cx) =
        cx.add_window_view(|window, cx| AppView::new(AppOptions::default(), window, cx));
    view.update(cx, |view, _| view.load(App::Js(Bundle::source(code))));
    cx.update(|window, cx| {
        window.focus(&view.focus_handle(cx), cx);
        window.activate_window();
    });
    wait_for(&view, cx, "  A\t中\r\nB\rC\n\n");
    let pasted = "\tP\r\nQ\rR\n \n";
    ime(&view, cx, |surface| {
        let field = crate::text_input::focused(surface).unwrap();
        assert!(crate::text_input::set_accessible_value(
            surface, &field, pasted
        ));
    });
    wait_for(&view, cx, pasted);
    cx.simulate_keystrokes("enter");
    wait_for(&view, cx, "\tP\r\nQ\rR\n \n\r\n");
    wait_for_report(&view, cx, "insert|false|");
    view.update(cx, |view, _| {
        assert!(view.paste(nsh_core::PasteEvent::new("one")));
        assert!(view.paste(nsh_core::PasteEvent::new("two")));
    });
    wait_for(&view, cx, "\tP\r\nQ\rR\n \n\r\nonetwo");
    wait_for_report(&view, cx, "insert|false|one,two");
    view.update(cx, |view, _| {
        assert!(view.paste(nsh_core::PasteEvent::new("'/tmp/a b.png' /tmp/c.txt")));
    });
    wait_for_report(
        &view,
        cx,
        "insert|false|one,two,file:///tmp/a%20b.png;file:///tmp/c.txt",
    );
    assert_eq!(
        field_text(&view, cx).as_deref(),
        Some("\tP\r\nQ\rR\n \n\r\nonetwo")
    );
    cx.simulate_keystrokes("f4");
    wait_for_report(
        &view,
        cx,
        "report|false|one,two,file:///tmp/a%20b.png;file:///tmp/c.txt",
    );
    view.update(cx, |view, _| {
        assert!(view.paste(nsh_core::PasteEvent::new("three")));
    });
    wait_for_report(
        &view,
        cx,
        "report|false|one,two,file:///tmp/a%20b.png;file:///tmp/c.txt,three",
    );
    assert_eq!(
        field_text(&view, cx).as_deref(),
        Some("\tP\r\nQ\rR\n \n\r\nonetwo")
    );
    cx.simulate_keystrokes("f5");
    wait_for_report(
        &view,
        cx,
        "report|true|one,two,file:///tmp/a%20b.png;file:///tmp/c.txt,three",
    );
    view.update(cx, |view, _| {
        assert!(!view.paste(nsh_core::PasteEvent::new("ignored")));
    });
    assert_eq!(
        field_text(&view, cx).as_deref(),
        Some("\tP\r\nQ\rR\n \n\r\nonetwo")
    );
    view.update(cx, |view, _| view.stop());
}

fn find_test_view(view: &crate::view::NshView, id: &str) -> Option<crate::view::NshView> {
    if view.state().props.test_id.as_deref() == Some(id) {
        return Some(view.clone());
    }
    view.with_children(|children| children.iter().find_map(|child| find_test_view(child, id)))
}

fn wait_for_report(view: &Entity<AppView>, cx: &mut VisualTestContext, expected: &str) {
    let start = Instant::now();
    loop {
        cx.run_until_parked();
        let current = view.read_with(cx, |view, _| {
            find_test_view(&view.surface().root, "report")
                .and_then(|view| crate::text_input::accessible_value(&view))
                .map(|value| value.text)
        });
        if current.as_deref() == Some(expected) {
            return;
        }
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "report {current:?}, expected {expected:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn wait_for_button(view: &Entity<AppView>, cx: &mut VisualTestContext, id: &str) {
    let start = Instant::now();
    loop {
        cx.run_until_parked();
        let focused = view.read_with(cx, |view, _| {
            let surface = view.surface();
            let generic = crate::text_input::focused_target(surface);
            let native = crate::native::focused_component(surface).and_then(|id| surface.view(id));
            let owns = if id == "native" {
                generic.is_none()
                    && native.is_some_and(|view| view.state().props.test_id.as_deref() == Some(id))
            } else {
                native.is_none()
                    && generic.is_some_and(|target| match target.link() {
                        Some(link) => link.props.test_id.as_deref() == Some(id),
                        None => target.view().state().props.test_id.as_deref() == Some(id),
                    })
            };
            owns && crate::text_input::focused(surface).is_none()
                && !crate::text_input::wants_text(surface)
        });
        if focused {
            return;
        }
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "button {id} did not take native focus: {}",
            view.read_with(cx, |view, _| focus_diagnostic(view.surface()))
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn focus_diagnostic(surface: &crate::surface::Surface) -> String {
    fn nodes(view: &crate::view::NshView, out: &mut Vec<String>) {
        let s = view.state();
        out.push(format!(
            "{}:{:?}:test={:?}:disabled={}:hidden={}:focusable={:?}:press={}:input={}:value={:?}",
            s.id,
            s.kind,
            s.props.test_id,
            s.props.accessibility.state.disabled,
            s.style.hidden || s.concealed,
            s.props.focusable,
            s.events.contains(nsh_core::EventKind::Press),
            s.input.is_some(),
            crate::text_input::accessible_value(view).map(|value| value.text),
        ));
        drop(s);
        view.with_children(|children| {
            for child in children {
                nodes(child, out);
            }
        });
    }
    let generic = crate::text_input::focused_target(surface).map(|target| target.id());
    let native = crate::native::focused_component(surface);
    let mut tree = Vec::new();
    nodes(&surface.root, &mut tree);
    format!(
        "generic={generic:?} native={native:?} path={:?} tree={tree:?}",
        surface.focus_path()
    )
}

fn buttons_keep_native_focus_and_live_key_scopes(cx: &mut TestAppContext) {
    let code =
        nsh_bundler::compile_module("App.tsx", SCOPED_BUTTONS, &[nsh_base::registry().into()])
            .unwrap();
    let (view, cx) =
        cx.add_window_view(|window, cx| AppView::new(AppOptions::default(), window, cx));
    view.update(cx, |view, cx| {
        view.register_component(
            "test.focus-square",
            Rc::new(|_| Box::new(FocusSquare { focus: None })),
        );
        view.set_appearance(nsh_core::platform::Appearance::Light, cx);
        view.on_app_error(|error| panic!("{error}"));
        view.load(App::Js(Bundle::source(code.clone())));
    });
    cx.update(|window, cx| window.focus(&view.focus_handle(cx), cx));
    wait_for(&view, cx, "@light");
    cx.simulate_keystrokes("tab");
    wait_for_button(&view, cx, "a");
    cx.simulate_keystrokes("x enter space f6");
    wait_for_report(&view, cx, "A|A|scope:true:true:false@light");
    cx.simulate_keystrokes("tab");
    wait_for_button(&view, cx, "native");
    cx.simulate_keystrokes("tab");
    wait_for_button(&view, cx, "b");
    cx.simulate_keystrokes("enter f6");
    wait_for_report(
        &view,
        cx,
        "A|A|scope:true:true:false|B|global:false:false:true@light",
    );
    cx.simulate_keystrokes("tab");
    wait_for_button(&view, cx, "opener");
    cx.simulate_keystrokes("enter");
    let mut report = "A|A|scope:true:true:false|B|global:false:false:true|open|shown".to_owned();
    wait_for_report(&view, cx, &format!("{report}@light"));
    wait_for_button(&view, cx, "modal");
    cx.simulate_keystrokes("tab");
    wait_for_button(&view, cx, "modal");
    cx.simulate_keystrokes("enter escape");
    report.push_str("|modal|closed");
    wait_for_report(&view, cx, &format!("{report}@light"));
    wait_for_button(&view, cx, "opener");
    cx.simulate_keystrokes("enter");
    report.push_str("|open|shown");
    wait_for_report(&view, cx, &format!("{report}@light"));
    wait_for_button(&view, cx, "modal");
    cx.simulate_keystrokes("escape");
    report.push_str("|closed");
    wait_for_report(&view, cx, &format!("{report}@light"));
    view.update(cx, |view, cx| {
        view.set_appearance(nsh_core::platform::Appearance::Dark, cx)
    });
    wait_for_report(&view, cx, &format!("{report}@dark"));
    cx.simulate_keystrokes("f6");
    report.push_str("|global:false:false:false");
    wait_for_report(&view, cx, &format!("{report}@dark"));
    view.update(cx, |view, _| view.load(App::Js(Bundle::source(code))));
    wait_for(&view, cx, "@dark");
    cx.simulate_keystrokes("tab f6");
    wait_for_report(&view, cx, "scope:true:true:false@dark");
    // The component receives actual window focus after the close batch.
    // Restoring the popup opener must not overwrite that queued intent.
    cx.simulate_keystrokes("f10");
    wait_for_button(&view, cx, "popup-action");
    cx.simulate_keystrokes("f9");
    wait_for_button(&view, cx, "native");
    // Native controls own their keys; Tab returns to a surface control.
    cx.simulate_keystrokes("tab");
    wait_for_button(&view, cx, "b");
    cx.simulate_keystrokes("f10");
    wait_for_button(&view, cx, "popup-action");
    cx.simulate_keystrokes("f9");
    wait_for_button(&view, cx, "native");
    // The same native owner traverses real inline ranges, including wrapped
    // CJK text. A span is not a separate view or a button beside the sentence.
    let links = r#"
import { mount, signal, Scroll, Text, View } from "nsh";
import { Input } from "nsh/base";
import { keymap } from "nsh";
const events = signal("ready");
const shown = signal(true);
const record = (event) => events.set(`${events()}|${event}`);
let first, second, reader;
keymap.bind("f4", () => first.focus(), { when: "always" });
keymap.bind("f5", () => second.focus(), { when: "always" });
keymap.bind("f6", () => record(`${keymap.focusedWithin(first)}:${keymap.focusedWithin(second)}`), { when: "always" });
keymap.bind("f8", () => reader.focus(), { when: "always" });
keymap.bind("f7", () => { shown.set(false); record("removed"); }, { when: "always" });
mount(() => <View>
  <Input testID="report" autoFocus readonly value={events()} style={{height: 30}} />
  <Scroll ref={(node) => reader = node} testID="reader" style={{width: 90, height: 200}} onScrollIntent={({intent}) => record(`intent:${intent}`)} onScrollDragStart={() => record("drag-start")} onScrollDragEnd={() => record("drag-end")}>
    <Text testID="sentence" style={{fontSize: 20, userSelect: "text"}}>
      <If when={shown()}><Text ref={(node) => first = node} testID="first-link" role="link" accessibilityLabel="First document" focusable onPress={() => record("first")}>
        打开<Text style={{fontWeight: "bold"}}>跨行中文</Text>文档
      </Text></If>
      {" plain "}<Text ref={(node) => second = node} testID="second-link" role="link" accessibilityLabel="Second document" focusable onPress={() => record("second")}>second</Text>
    </Text>
  </Scroll>
  <View testID="after" focusable onPress={() => record("after")}><Text>After links</Text></View>
</View>);
"#;
    let code = nsh_bundler::compile_module("App.tsx", links, &[]).unwrap();
    view.update(cx, |view, _| view.load(App::Js(Bundle::source(code))));
    wait_for_report(&view, cx, "ready");
    cx.simulate_keystrokes("f4");
    wait_for_button(&view, cx, "first-link");
    cx.simulate_keystrokes("enter tab space shift-tab enter f6");
    wait_for_report(&view, cx, "ready|first|second|first|true:false");
    // TestWindow sends only key downs. Release this first F6 so the
    // post-drag press is a new key, not a correctly suppressed repeat.
    cx.simulate_event(gpui::KeyUpEvent {
        keystroke: gpui::Keystroke::parse("f6").unwrap(),
    });
    // A real native pointer drag through the wrapped label selects text
    // without firing its application link action.
    let (start, end) = view.read_with(cx, |view, _| {
        let surface = view.surface();
        let sentence = find_test_view(&surface.root, "sentence").unwrap();
        let state = sentence.state();
        let text = &state.text.as_ref().unwrap().text;
        let link = text
            .links
            .iter()
            .find(|link| link.props.test_id.as_deref() == Some("first-link"))
            .unwrap();
        let first = crate::text::range_rect(&state, link.start, link.start + 1).unwrap();
        let last = crate::text::range_rect(&state, link.end - 1, link.end).unwrap();
        assert!(
            last.1 > first.1,
            "the CJK link must wrap at the native content width"
        );
        let matrix = sentence.to_root().unwrap();
        let (ox, oy) = surface.origin.get();
        let at = |x, y| {
            let (x, y) = matrix.map(x, y).unwrap();
            gpui::point(gpui::px(ox + x), gpui::px(oy + y))
        };
        (
            at(first.0, first.1 + first.3 / 2.0),
            at(last.0 + last.2, last.1 + last.3 / 2.0),
        )
    });
    for event in [
        gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {
            button: gpui::MouseButton::Left,
            position: start,
            click_count: 1,
            ..Default::default()
        }),
        gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
            position: end,
            pressed_button: Some(gpui::MouseButton::Left),
            ..Default::default()
        }),
        gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
            button: gpui::MouseButton::Left,
            position: end,
            click_count: 1,
            ..Default::default()
        }),
    ] {
        cx.update(|window, cx| {
            window.dispatch_event(event, cx);
        });
    }
    cx.simulate_keystrokes("f6");
    wait_for_report(&view, cx, "ready|first|second|first|true:false|true:false");
    let copy = if cfg!(target_os = "macos") {
        "cmd-c"
    } else {
        "ctrl-c"
    };
    cx.simulate_keystrokes(copy);
    cx.run_until_parked();
    cx.update(|_, cx| {
        assert_eq!(
            cx.read_from_clipboard().and_then(|item| item.text()),
            Some("打开跨行中文文档".into())
        )
    });
    cx.simulate_keystrokes("f7");
    wait_for_report(
        &view,
        cx,
        "ready|first|second|first|true:false|true:false|removed",
    );
    view.read_with(cx, |view, _| {
        assert_eq!(
            crate::text_input::focused_target(view.surface()).map(|target| target.id()),
            None
        )
    });
    cx.simulate_keystrokes("enter f5");
    wait_for_button(&view, cx, "second-link");
    cx.simulate_keystrokes("enter f6");
    wait_for_report(
        &view,
        cx,
        "ready|first|second|first|true:false|true:false|removed|second|false:true",
    );
    cx.simulate_keystrokes("f8");
    wait_for_button(&view, cx, "reader");
    cx.simulate_keystrokes("home end pageup");
    wait_for_report(
        &view,
        cx,
        "ready|first|second|first|true:false|true:false|removed|second|false:true|intent:start|intent:end|intent:scroll",
    );
    // A touchpad attempt at a reader boundary reports intent without
    // inventing a drag lifecycle or changing its native scroll offset.
    ime(&view, cx, |surface| {
        let reader = find_test_view(&surface.root, "reader").unwrap();
        let (x, y) = reader.to_root().unwrap().map(20.0, 20.0).unwrap();
        let event = crate::input::WheelEvent {
            x,
            y,
            dx: 0.0,
            dy: 32.0,
            precise: true,
            time: surface.clock(),
            modifiers: crate::input::Modifiers::default(),
        };
        crate::input::touchpad(surface, event, crate::input::GesturePhase::Began);
        crate::input::touchpad(
            surface,
            crate::input::WheelEvent { dy: 0.0, ..event },
            crate::input::GesturePhase::Ended,
        );
        assert_eq!(reader.state().scroll.as_ref().unwrap().y.0, 0.0);
    });
    wait_for_report(
        &view,
        cx,
        "ready|first|second|first|true:false|true:false|removed|second|false:true|intent:start|intent:end|intent:scroll|intent:scroll",
    );
    view.update(cx, |view, _| view.stop());
}

fn native_keys_keep_their_owner_across_redraws(cx: &mut TestAppContext) {
    let code = nsh_bundler::compile_module("App.tsx", NATIVE_KEYBOARD, &[]).unwrap();
    let (view, cx) =
        cx.add_window_view(|window, cx| AppView::new(AppOptions::default(), window, cx));
    view.update(cx, |view, _| view.load(App::Js(Bundle::source(code))));
    cx.update(|window, cx| {
        window.focus(&view.focus_handle(cx), cx);
        // A TestWindow starts inactive even after a field receives native focus.
        window.activate_window();
    });
    wait_for_report(&view, cx, "0|0|editor:0||0|0|0|");

    let key = |name: &str, down: bool| {
        let keystroke = gpui::Keystroke::parse(name).unwrap();
        if down {
            gpui::PlatformInput::KeyDown(gpui::KeyDownEvent {
                keystroke,
                is_held: false,
                prefer_character_input: false,
            })
        } else {
            gpui::PlatformInput::KeyUp(gpui::KeyUpEvent { keystroke })
        }
    };
    let dispatch = |cx: &mut VisualTestContext, event| {
        cx.update(|window, cx| window.dispatch_event(event, cx));
    };
    let press = |cx: &mut VisualTestContext, name| {
        dispatch(cx, key(name, true));
        dispatch(cx, key(name, false));
    };
    ime(&view, cx, |surface| {
        crate::text_input::ime::replace_text_in_range(surface, None, "a");
    });
    press(cx, "enter");
    wait_for_report(&view, cx, "0|0|editor:0|0:a|0|0|0|");

    press(cx, "f7");
    wait_for_report(&view, cx, "0|1|editor:0|0:a|0|0|0|");
    press(cx, "escape");
    wait_for_report(&view, cx, "0|1|editor:0|0:a|1|0|0|");
    press(cx, "tab");
    wait_for_report(&view, cx, "0|1|next|0:a|1|0|0|");

    // A shortcut may transfer focus before its release arrives. The release
    // still has to end its held-key state, so the next press can fire.
    dispatch(cx, key("f9", true));
    wait_for_report(&view, cx, "0|1|editor:0|0:a|1|1|0|");
    dispatch(cx, key("f9", false));
    // An explicit repeat remains held even after a discrete stroke's release.
    let mut repeat = key("f9", true);
    let gpui::PlatformInput::KeyDown(event) = &mut repeat else {
        unreachable!();
    };
    event.is_held = true;
    dispatch(cx, repeat);
    dispatch(cx, key("f9", false));
    press(cx, "f7");
    wait_for_report(&view, cx, "0|2|editor:0|0:a|1|1|0|");
    press(cx, "f9");
    wait_for_report(&view, cx, "0|2|next|0:a|1|2|0|");

    press(cx, "shift-tab");
    wait_for_report(&view, cx, "0|2|editor:0|0:a|1|2|0|");
    press(cx, "f10");
    wait_for_report(&view, cx, "0|2|editor:0|0:a|1|2|1|");
    press(cx, "f6");
    wait_for_report(&view, cx, "0|2|editor:0|0:a|1|2|1|0:1");

    press(cx, "f8");
    wait_for_report(&view, cx, "1|2|editor:1|0:a|1|2|1|0:1");
    press(cx, "f6");
    wait_for_report(&view, cx, "1|2|editor:1|0:a|1|2|1|1:1");

    // A plain Input can acquire native focus from its current geometry even
    // when an unrelated thinking update has already redrawn the surface.
    let (plain, start, outside) = view.read_with(cx, |view, _| {
        let surface = view.surface();
        let plain = find_test_view(&surface.root, "plain").unwrap();
        let matrix = plain.to_root().unwrap();
        let size = plain.state().frame.size;
        let position = |x| {
            let (x, y) = matrix.map(x, size.height.0 / 2.0).unwrap();
            let (ox, oy) = surface.origin.get();
            gpui::point(gpui::px(x + ox), gpui::px(y + oy))
        };
        (plain, position(0.0), position(size.width.0 + 20.0))
    });
    let down = gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {
        button: gpui::MouseButton::Left,
        position: start,
        click_count: 1,
        ..Default::default()
    });
    let drag = gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
        position: outside,
        pressed_button: Some(gpui::MouseButton::Left),
        ..Default::default()
    });
    let up = gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
        button: gpui::MouseButton::Left,
        position: outside,
        click_count: 1,
        ..Default::default()
    });
    press(cx, "f7");
    wait_for_report(&view, cx, "1|3|editor:1|0:a|1|2|1|1:1");
    dispatch(cx, down.clone());
    ime(&view, cx, |surface| {
        assert_eq!(crate::text_input::focused(surface), Some(plain.clone()));
        assert_eq!(
            crate::text_input::ime::selected_text_range(surface).map(|selection| selection.range),
            Some(0..0)
        );
    });
    press(cx, "f7");
    wait_for_report(&view, cx, "1|4|editor:1|0:a|1|2|1|1:1");
    dispatch(cx, drag.clone());
    press(cx, "f7");
    wait_for_report(&view, cx, "1|5|editor:1|0:a|1|2|1|1:1");
    dispatch(cx, up);
    ime(&view, cx, |surface| {
        assert_eq!(crate::text_input::focused(surface), Some(plain.clone()));
        assert_eq!(
            crate::text_input::ime::selected_text_range(surface).map(|selection| selection.range),
            Some(0..6)
        );
        crate::text_input::ime::replace_and_mark_text_in_range(surface, None, "ni", None);
        crate::text_input::ime::replace_text_in_range(surface, None, "你好");
    });
    assert_eq!(field_text(&view, cx).as_deref(), Some("你好"));

    dispatch(cx, down.clone());
    view.update(cx, |view, _| view.cancel_pointer());
    dispatch(cx, drag);
    ime(&view, cx, |surface| {
        // A later move reaching the editor must not revive the cancelled drag.
        assert!(!crate::text_input::pointer(
            surface,
            &plain,
            &crate::view::ItemPointer {
                kind: crate::input::PointerKind::Move,
                x: 180.0,
                y: 15.0,
                clicks: 0,
                modifiers: crate::input::Modifiers::default(),
            }
        ));
        assert_eq!(
            crate::text_input::ime::selected_text_range(surface).map(|selection| selection.range),
            Some(0..0)
        );
        crate::text_input::ime::replace_text_in_range(surface, None, "世界");
    });
    assert_eq!(field_text(&view, cx).as_deref(), Some("世界你好"));

    ime(&view, cx, crate::text_input::blur_all);
    cx.update(|window, cx| {
        use gpui::InputHandler;

        // Paint once with body focus, then exercise this adapter's live focus
        // without drawing or dispatching keys (GPUI draws before key events).
        // Platform registration of the adapter is tested by the terminal host.
        window.draw(cx).clear(cx);
        let bounds = gpui::Bounds::new(gpui::Point::default(), window.viewport_size());
        let mut handler = gpui::ElementInputHandler::new(bounds, view.clone());
        assert!(!handler.accepts_text_input(window, cx));
        handler.replace_text_in_range(None, "ignored", window, cx);
        handler.paste(
            gpui::ClipboardItem::new_string("ignored".into()),
            window,
            cx,
        );
        assert_eq!(
            crate::text_input::accessible_value(&plain).unwrap().text,
            "世界你好"
        );

        window.dispatch_event(down, cx);
        window.dispatch_event(
            gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
                button: gpui::MouseButton::Left,
                position: start,
                click_count: 1,
                ..Default::default()
            }),
            cx,
        );
        assert!(handler.accepts_text_input(window, cx));
        handler.replace_text_in_range(None, "再", window, cx);
        handler.paste(gpui::ClipboardItem::new_string("见".into()), window, cx);
        assert_eq!(
            crate::text_input::accessible_value(&plain).unwrap().text,
            "再见世界你好"
        );
    });
    view.update(cx, |view, _| view.stop());
}

fn configured_assets_stay_with_their_original_load(cx: &mut TestAppContext) {
    let code = nsh_bundler::compile_module("App.tsx", CONFIGURED_IMAGE, &[]).unwrap();
    let (view, cx) =
        cx.add_window_view(|window, cx| AppView::new(AppOptions::default(), window, cx));
    let first = Arc::new(ImageAssets::new(2, 3));
    let second = Arc::new(ImageAssets::new(7, 5));
    for (assets, status) in [
        (Some(&first), "configured host|development policy|2x3"),
        (Some(&second), "configured host|development policy|7x5"),
        (None, "asset:/same-preview.png: no asset reader configured"),
    ] {
        let mut registry = nsh_core::element::Registry::ui_set("test/embedding");
        registry.module::<EmbeddingHost>();
        let mut config = nsh_engine::EngineConfig::new(App::Js(
            Bundle::source(code.clone()).with_policy(nsh_engine::Policy::development()),
        ));
        config.assets = assets
            .cloned()
            .map(|assets| -> Arc<dyn nsh_engine::Assets> { assets });
        config.ui_sets = vec![registry];
        config.viewport = nsh_core::Size::new(nsh_core::Points(1.0), nsh_core::Points(1.0));
        config.environment.window = config.viewport;
        view.update(cx, |view, _| view.load_with_config(config));
        cx.update(|window, cx| window.focus(&view.focus_handle(cx), cx));
        let start = Instant::now();
        loop {
            cx.run_until_parked();
            let (width, height) = view.read_with(cx, |view, _| view.surface().size());
            let expected = format!("{status}|{width}x{height}");
            let now = field_text(&view, cx);
            if width > 1.0 && height > 1.0 && now.as_deref() == Some(expected.as_str()) {
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "the image reports {now:?}, not {expected:?} on the actual GPUI surface"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    for assets in [&first, &second] {
        assert_eq!(
            *assets.reads.lock().unwrap(),
            ["asset:/same-preview.png"],
            "each provider is read once; the load with no reader must use neither old provider",
        );
    }
    view.update(cx, |view, _| view.stop());
}

fn keys_reach_the_fields_of_a_surface_showing_a_native_component(cx: &mut TestAppContext) {
    let code = nsh_bundler::compile_module("App.tsx", FIELD_AFTER_COMPONENT, &[]).unwrap();
    let (view, cx) =
        cx.add_window_view(|window, cx| AppView::new(AppOptions::default(), window, cx));
    view.update(cx, |view, _| {
        view.register_component("test.square", Rc::new(|_| Box::new(Square)));
        view.load(App::Js(Bundle::source(code)));
    });
    cx.update(|window, cx| window.focus(&view.focus_handle(cx), cx));
    wait_for(&view, cx, "abcd");
    // Painting the component's element must not take the surface's key
    // listeners with it: deletions and moves come as key events.
    cx.simulate_keystrokes("end backspace");
    wait_for(&view, cx, "abc");
    cx.simulate_keystrokes("home delete");
    wait_for(&view, cx, "bc");
    cx.simulate_keystrokes("right shift-right backspace");
    wait_for(&view, cx, "b");
}

/// The test agent's synthetic path must translate keys only after shortcuts.
#[cfg(feature = "dev")]
fn synthetic_keys_type_printable_characters_after_shortcuts(cx: &mut TestAppContext) {
    let source = r#"
import { mount, signal } from "nsh";
import { Input } from "nsh/base";
import { keymap } from "nsh";
function App() {
  const text = signal("");
  keymap.bind("shift+=", () => text.set("shortcut"), { when: "always" });
  return <Input autoFocus value={text()} onChange={(t) => text.set(t)} style={{ height: 30 }} />;
}
mount(App);
"#;
    let code = nsh_bundler::compile_module("App.tsx", source, &[]).unwrap();
    let (view, cx) =
        cx.add_window_view(|window, cx| AppView::new(AppOptions::default(), window, cx));
    view.update(cx, |view, _| view.load(App::Js(Bundle::source(code))));
    cx.update(|window, cx| window.focus(&view.focus_handle(cx), cx));
    wait_for(&view, cx, "");
    for (vk, shift, expected) in [
        (0xBF, false, "/"),
        (0xBF, true, "/?"),
        (0x31, true, "/?!"),
        (0xBB, false, "/?!="),
    ] {
        view.update(cx, |view, _| {
            crate::synth::press(
                view.surface(),
                vk,
                crate::input::Modifiers {
                    shift,
                    ..Default::default()
                },
            );
        });
        wait_for(&view, cx, expected);
    }
    view.update(cx, |view, _| {
        crate::synth::press(
            view.surface(),
            0xBB,
            crate::input::Modifiers {
                shift: true,
                ..Default::default()
            },
        );
    });
    // The shortcut is asynchronous, but an accidental '+' insertion is immediate.
    assert_eq!(field_text(&view, cx).as_deref(), Some("/?!="));
    wait_for(&view, cx, "shortcut");
    view.update(cx, |view, _| view.stop());
}

fn compositions_are_reported_and_hold_values_until_they_end(cx: &mut TestAppContext) {
    let code = nsh_bundler::compile_module("App.tsx", COMPOSING_FIELD, &[]).unwrap();
    let (view, cx) =
        cx.add_window_view(|window, cx| AppView::new(AppOptions::default(), window, cx));
    view.update(cx, |view, _| view.load(App::Js(Bundle::source(code))));
    cx.update(|window, cx| window.focus(&view.focus_handle(cx), cx));
    wait_for(&view, cx, "abcd");
    cx.simulate_keystrokes("end");
    // The same composition twice is reported once; the value JS sets
    // meanwhile waits, the text keeps what the input method composes in.
    ime(&view, cx, |s| crate::text_input::mark(s, "ni"));
    ime(&view, cx, |s| crate::text_input::mark(s, "ni"));
    wait_for_pending(&view, cx, "held");
    assert_eq!(field_text(&view, cx).as_deref(), Some("abcd"));
    // Cancelled: the value held is applied as the composition ends.
    ime(&view, cx, |s| crate::text_input::mark(s, ""));
    assert_eq!(field_text(&view, cx).as_deref(), Some("held"));
    assert_eq!(field_pending(&view, cx), None);
    // Committed: the commit's `onChange` comes before the end, and the
    // value set before the commit is stale.
    ime(&view, cx, |s| crate::text_input::mark(s, "hao"));
    wait_for_pending(&view, cx, "stale");
    ime(&view, cx, |s| crate::text_input::char_input(s, "好"));
    assert_eq!(field_text(&view, cx).as_deref(), Some("held好"));
    wait_for(&view, cx, "compose ni|end|compose hao|change held好|end");
}

fn an_embedded_surface_takes_the_keyboard_when_its_app_focuses_a_field(cx: &mut TestAppContext) {
    let code = nsh_bundler::compile_module("App.tsx", FIELD_AFTER_COMPONENT, &[]).unwrap();
    use gpui::AppContext as _;
    let (host, cx) = cx.add_window_view(|window, cx| {
        let view = cx.new(|cx| AppView::new(AppOptions::default(), window, cx));
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        Host { view, focus }
    });
    let view = host.read_with(cx, |host, _| host.view.clone());
    view.update(cx, |view, _| {
        view.register_component("test.square", Rc::new(|_| Box::new(Square)));
        view.load(App::Js(Bundle::source(code)));
    });
    // The app's autoFocus field. The window's focus stays on the host's
    // own element until the surface takes it.
    wait_for(&view, cx, "abcd");
    cx.simulate_keystrokes("end backspace");
    wait_for(&view, cx, "abc");
    // The host can take the keyboard while the surface keeps its focused field.
    let host_focus = host.read_with(cx, |host, _| host.focus.clone());
    cx.update(|window, cx| window.focus(&host_focus, cx));
    cx.run_until_parked();
    view.update(cx, |view, _| {
        let field = crate::text_input::focused(view.surface()).unwrap();
        crate::text_input::focus(&field);
    });
    cx.run_until_parked();
    cx.update(|window, _| {
        assert!(
            !host_focus.is_focused(window),
            "focus() left the keyboard on the embedding host"
        );
    });
    cx.simulate_keystrokes("end backspace");
    wait_for(&view, cx, "ab");
}

/// Two fields. Enter in the first, and Ctrl+N (Command+N on macOS), both
/// focus the second. Text typed before the engine has handled that key
/// belongs to the second field.
const TWO_FIELDS: &str = r#"
import { keymap, mount, signal, View, type YNode } from "nsh";
import { Input } from "nsh/base";

function App() {
  const first = signal("A");
  const second = signal("");
  let next!: YNode, outside!: YNode;
  const go = () => next.focus();
  keymap.bind("mod+n", go, { when: "always" });
  keymap.bind("mod+k", () => second.set(second() + "!"), { when: "always" });
  keymap.bind("mod+b", () => outside.focus(), { when: "always" });
  return (
    <View style={{ flex: 1, padding: 8, gap: 8 }}>
      <Input
        autoFocus
        value={first()}
        onChange={(t) => first.set(t)}
        onSubmit={go}
        submitBehavior="submit"
        style={{ height: 30 }}
      />
      <Input ref={next} value={second()} onChange={(t) => second.set(t)} style={{ height: 30 }} />
      <Input testID="report" readonly focusable={false} value={second()} style={{ height: 30 }} />
      <View ref={outside} testID="outside" focusable style={{ height: 30 }} />
    </View>
  );
}
mount(App);
"#;

fn down(vk: u16, modifiers: crate::input::Modifiers) -> crate::input::KeyEvent {
    crate::input::KeyEvent {
        vk,
        down: true,
        repeat: false,
        modifiers,
    }
}

/// `x`, then Backspace, then `y`, before the engine applies `key`. The
/// focused field must still read "A", and then "y" once the next field
/// has the keyboard.
fn typed_ahead(cx: &mut TestAppContext, key: crate::input::KeyEvent) {
    let code = nsh_bundler::compile_module("App.tsx", TWO_FIELDS, &[]).unwrap();
    let (view, cx) =
        cx.add_window_view(|window, cx| AppView::new(AppOptions::default(), window, cx));
    view.update(cx, |view, _| view.load(App::Js(Bundle::source(code))));
    cx.update(|window, cx| window.focus(&view.focus_handle(cx), cx));
    wait_for(&view, cx, "A");
    view.update(cx, |view, _| {
        let surface = view.surface().clone();
        assert!(crate::input::key(&surface, key), "the key was not handled");
        crate::text_input::char_input(&surface, "x");
        assert!(crate::input::key(
            &surface,
            down(crate::keys::VK_BACK, crate::input::Modifiers::default())
        ));
        crate::text_input::char_input(&surface, "y");
        let now = crate::text_input::focused(view.surface())
            .and_then(|field| crate::text_input::accessible_value(&field))
            .map(|value| value.text);
        assert!(
            matches!(now.as_deref(), None | Some("A")),
            "typed ahead into the field that still has the keyboard: {now:?}"
        );
    });
    wait_for(&view, cx, "y");
}

fn text_typed_ahead_of_enter_or_a_binding_lands_in_the_next_field(cx: &mut TestAppContext) {
    typed_ahead(
        cx,
        down(crate::keys::VK_RETURN, crate::input::Modifiers::default()),
    );
    let modifiers = if cfg!(target_os = "macos") {
        crate::input::Modifiers {
            meta: true,
            ..crate::input::Modifiers::default()
        }
    } else {
        crate::input::Modifiers {
            ctrl: true,
            ..crate::input::Modifiers::default()
        }
    };
    typed_ahead(cx, down(0x4E, modifiers));
    composed_ahead(cx, modifiers);
    bindings_ahead(cx, modifiers);
    paused_ahead(cx, modifiers);
}

fn composed_ahead(cx: &mut TestAppContext, modifiers: crate::input::Modifiers) {
    use crate::text_input::ime;
    let code = nsh_bundler::compile_module("App.tsx", TWO_FIELDS, &[]).unwrap();
    let (view, cx) =
        cx.add_window_view(|window, cx| AppView::new(AppOptions::default(), window, cx));
    view.update(cx, |view, _| view.load(App::Js(Bundle::source(code))));
    cx.update(|window, cx| window.focus(&view.focus_handle(cx), cx));
    wait_for(&view, cx, "A");
    view.update(cx, |view, _| {
        let s = view.surface();
        assert!(crate::input::key(
            s,
            down(crate::keys::VK_RETURN, Default::default())
        ));
        ime::replace_and_mark_text_in_range(s, None, "n", Some(1..1));
        ime::replace_and_mark_text_in_range(s, None, "ni😀", Some(2..2));
    });
    let start = Instant::now();
    loop {
        cx.run_until_parked();
        if view.read_with(cx, |view, _| ime::marked_text_range(view.surface())) == Some(0..4) {
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "preedit did not arrive"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(field_text(&view, cx).as_deref(), Some(""));
    view.update(cx, |view, _| {
        let s = view.surface();
        assert_eq!(ime::marked_text_range(s), Some(0..4));
        assert_eq!(ime::selected_text_range(s).unwrap().range, 2..2);
        assert_eq!(
            ime::text_for_range(s, 0..4, &mut None).as_deref(),
            Some("ni😀")
        );
        ime::replace_text_in_range(s, None, "你");
    });
    wait_for(&view, cx, "你");
    view.update(cx, |view, _| {
        let s = view.surface();
        assert!(crate::input::key(s, down(0x4E, modifiers)));
        ime::replace_and_mark_text_in_range(s, None, "discard", None);
        ime::replace_and_mark_text_in_range(s, None, "", None);
        ime::replace_text_in_range(s, None, "x");
        let mut released = down(0x4E, Default::default());
        released.down = false;
        crate::input::key(s, released);
    });
    wait_for(&view, cx, "你x");
    view.update(cx, |view, _| {
        let s = view.surface();
        assert_eq!(ime::marked_text_range(s), None);
        assert!(crate::input::key(s, down(0x4E, modifiers)));
        ime::replace_and_mark_text_in_range(s, None, "😀", Some(2..2));
        ime::unmark_text(s);
        ime::replace_text_in_range(s, Some(0..1), "好");
    });
    wait_for(&view, cx, "好x😀");
}

fn bindings_ahead(cx: &mut TestAppContext, modifiers: crate::input::Modifiers) {
    let code = nsh_bundler::compile_module("App.tsx", TWO_FIELDS, &[]).unwrap();
    let (view, cx) =
        cx.add_window_view(|window, cx| AppView::new(AppOptions::default(), window, cx));
    view.update(cx, |view, _| view.load(App::Js(Bundle::source(code))));
    cx.update(|window, cx| window.focus(&view.focus_handle(cx), cx));
    wait_for(&view, cx, "A");
    view.update(cx, |view, _| {
        let s = view.surface();
        assert!(crate::input::key(
            s,
            down(crate::keys::VK_RETURN, Default::default())
        ));
        crate::text_input::char_input(s, "x");
        for _ in 0..2 {
            assert!(crate::input::key(s, down(0x4B, modifiers)));
            let mut released = down(0x4B, Default::default());
            released.down = false;
            crate::input::key(s, released);
        }
    });
    wait_for(&view, cx, "x!!");
}

fn paused_ahead(cx: &mut TestAppContext, modifiers: crate::input::Modifiers) {
    let code = nsh_bundler::compile_module("App.tsx", TWO_FIELDS, &[]).unwrap();
    let (view, cx) =
        cx.add_window_view(|window, cx| AppView::new(AppOptions::default(), window, cx));
    view.update(cx, |view, _| view.load(App::Js(Bundle::source(code))));
    cx.update(|window, cx| window.focus(&view.focus_handle(cx), cx));
    wait_for(&view, cx, "A");
    let result = Arc::new(Mutex::new(None));
    for editing in [true, false] {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                if !editing {
                    view.resume_input(window, cx);
                }
                let s = view.surface();
                if editing {
                    assert!(crate::input::key(
                        s,
                        down(crate::keys::VK_RETURN, Default::default())
                    ));
                    crate::text_input::char_input(s, "你");
                    assert!(crate::input::key(s, down(0x4E, modifiers)));
                    let mut released = down(0x4E, Default::default());
                    released.down = false;
                    crate::input::key(s, released);
                    crate::text_input::char_input(s, "好");
                } else {
                    assert!(crate::input::key(s, down(0x42, modifiers)));
                    crate::text_input::ime::replace_text_in_range(s, None, "");
                    crate::text_input::ime::replace_and_mark_text_in_range(s, None, "", None);
                }
                let result = result.clone();
                view.pause_input(window, cx, move |done| *result.lock().unwrap() = Some(done));
            });
        });
        let start = Instant::now();
        loop {
            cx.run_until_parked();
            if let Some(done) = result.lock().unwrap().take() {
                done.unwrap();
                view.update(cx, |view, _| view.surface().drain());
                assert_eq!(field_text(&view, cx).as_deref(), editing.then_some("你好"));
                assert_eq!(
                    view.read_with(cx, |view, _| {
                        find_test_view(&view.surface().root, "report")
                            .and_then(|view| crate::text_input::accessible_value(&view))
                            .map(|value| value.text)
                    })
                    .as_deref(),
                    Some("你好")
                );
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "input pause did not finish"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

struct KeyLog {
    keys: Rc<std::cell::RefCell<Vec<String>>>,
    focus: Rc<std::cell::RefCell<Option<gpui::FocusHandle>>>,
}

impl NativeComponent for KeyLog {
    fn render(&mut self, _: &mut Window, cx: &mut GpuiApp) -> Option<AnyElement> {
        use gpui::InteractiveElement as _;
        let focus = self
            .focus
            .borrow_mut()
            .get_or_insert_with(|| cx.focus_handle())
            .clone();
        let keys = self.keys.clone();
        Some(
            div()
                .size_full()
                .track_focus(&focus)
                .on_key_down(move |e, _, _| keys.borrow_mut().push(e.keystroke.unparse()))
                .into_any_element(),
        )
    }

    fn focus_handle(&self) -> Option<gpui::FocusHandle> {
        self.focus.borrow().clone()
    }

    fn set_prop(
        &mut self,
        _: &str,
        _: Option<&serde_json::Value>,
        _: &mut Window,
        _: &mut GpuiApp,
    ) {
    }
}

/// A field showing which of the app's shortcuts fired, above a component
/// that takes the keyboard. `mod+k` fires while text is edited. `j` does
/// not. The menu's `mod+z` and `mod+shift+n` still choose their items.
const SHORTCUTS_OVER_COMPONENT: &str = r#"
import { mount, signal, View } from "nsh";
import { Input } from "nsh/base";
import { Menu } from "nsh/desktop";
import { keymap } from "nsh";
import { nativeComponent } from "nsh";

const KeyLog = nativeComponent<{}, {}>("test.keylog", { props: [], events: [] });

function App() {
  const fired = signal("fired");
  const fire = (name: string) => () => fired.set(`${fired()} ${name}`);
  keymap.bind("mod+k", fire("bound"), { when: "always" });
  keymap.bind("j", fire("j"));
  Menu.setApplicationMenu([
    {
      label: "Edit",
      submenu: [
        { label: "Revert", shortcut: "mod+z", onSelect: fire("revert") },
        { label: "New", shortcut: "mod+shift+n", onSelect: fire("new") },
      ],
    },
  ]);
  return (
    <View style={{ flex: 1 }}>
      <Input value={fired()} style={{ height: 30 }} />
      <KeyLog style={{ height: 40 }} />
    </View>
  );
}
mount(App);
"#;

fn the_app_s_shortcuts_reach_it_while_a_native_component_has_the_keyboard(cx: &mut TestAppContext) {
    use std::cell::RefCell;
    let code = nsh_bundler::compile_module("App.tsx", SHORTCUTS_OVER_COMPONENT, &[]).unwrap();
    let keys = Rc::new(RefCell::new(Vec::new()));
    let focus = Rc::new(RefCell::new(None));
    let (component_keys, component_focus) = (keys.clone(), focus.clone());
    let (view, cx) = cx.add_window_view(|window, cx| {
        let view = AppView::new(AppOptions::default(), window, cx);
        let title = window.window_title();
        crate::chrome::set_standalone(view.surface(), &title, window.window_handle());
        view
    });
    view.update(cx, |view, _| {
        view.register_component(
            "test.keylog",
            Rc::new(move |_| {
                Box::new(KeyLog {
                    keys: component_keys.clone(),
                    focus: component_focus.clone(),
                })
            }),
        );
        view.load(App::Js(Bundle::source(code)));
    });
    let start = Instant::now();
    let handle = loop {
        cx.run_until_parked();
        if let Some(handle) = focus.borrow().clone() {
            break handle;
        }
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "the component is not drawn"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    cx.update(|window, cx| window.focus(&handle, cx));
    cx.run_until_parked();
    let primary = if cfg!(target_os = "macos") {
        "cmd"
    } else {
        "ctrl"
    };
    cx.simulate_keystrokes(&format!("a j {primary}-z {primary}-k"));
    // GPUI's test window sends no releases. K's release reaches the keymap
    // while the component has the focus, so the next Ctrl+K is not a repeat.
    cx.simulate_event(gpui::KeyUpEvent {
        keystroke: gpui::Keystroke::parse(&format!("{primary}-k")).unwrap(),
    });
    cx.simulate_keystrokes(&format!("{primary}-k shift-{primary}-n"));
    assert_eq!(
        keys.borrow()[..4],
        ["a", "j", &format!("{primary}-z"), &format!("{primary}-k")],
    );
    cx.update(|window, _| assert!(handle.is_focused(window), "the component lost the focus"));
    // The surface starts below the platform's title and menu bars.
    let (x, y) = view.read_with(cx, |view, _| view.surface().origin.get());
    cx.simulate_click(
        gpui::point(gpui::px(x + 20.0), gpui::px(y + 15.0)),
        gpui::Modifiers::default(),
    );
    wait_for(&view, cx, "fired revert bound bound new");
}
/// The part of the embedding app a view reaches: its engine's context.
struct Desk(&'static str);

/// Which desk the engine running the call was given.
#[nsh_core::element::module]
struct Whose;

#[nsh_core::element::module]
impl Whose {
    /// In the JS call.
    pub(crate) fn now() -> String {
        desk()
    }

    /// As a task, after it waited.
    pub(crate) async fn later() -> String {
        nsh_core::prelude::timer(Duration::from_millis(5)).await;
        desk()
    }
}

fn desk() -> String {
    nsh_core::element::engine_context::<Desk>()
        .map_or_else(|| "none".to_owned(), |desk| desk.0.to_owned())
}

/// A field showing which desk `Whose` names, in the call and in a task.
const WHOSE: &str = r#"
import { mount, signal, View } from "nsh";
import { Input } from "nsh/base";
import { nativeModule } from "nsh";

interface WhoseApi {
  now(): string;
  later(): Promise<string>;
}
const { Whose } = nativeModule<{ Whose: WhoseApi }>("test/context");

function App() {
  const text = signal("waiting");
  setTimeout(async () => text.set(`${Whose.now()} ${await Whose.later()}`), 0);
  return (
    <View style={{ flex: 1 }}>
      <Input autoFocus value={text()} onChange={(t) => text.set(t)} style={{ height: 30 }} />
    </View>
  );
}
mount(App);
"#;

/// Two surfaces side by side in one window.
struct Pair {
    a: Entity<AppView>,
    b: Entity<AppView>,
}

impl gpui::Render for Pair {
    fn render(&mut self, _: &mut Window, _: &mut gpui::Context<Self>) -> impl IntoElement {
        use gpui::ParentElement as _;
        div()
            .size_full()
            .flex()
            .child(div().flex_1().child(self.a.clone()))
            .child(div().flex_1().child(self.b.clone()))
    }
}

fn each_view_s_functions_read_the_context_its_options_gave_its_engine(cx: &mut TestAppContext) {
    let mut context = nsh_core::element::Registry::ui_set("test/context");
    context.module::<Whose>();
    crate::set_ui_sets(vec![nsh_base::registry(), context]);
    let code = nsh_bundler::compile_module("App.tsx", WHOSE, &[]).unwrap();
    use gpui::AppContext as _;
    let (pair, cx) = cx.add_window_view(|window, cx| {
        let view = |desk: &'static str, window: &mut Window, cx: &mut gpui::Context<Pair>| {
            let options = AppOptions {
                context: nsh_engine::EngineContext::default().with(Desk(desk)),
                ..AppOptions::default()
            };
            cx.new(|cx| AppView::new(options, window, cx))
        };
        Pair {
            a: view("A", window, cx),
            b: view("B", window, cx),
        }
    });
    let (a, b) = pair.read_with(cx, |pair, _| (pair.a.clone(), pair.b.clone()));
    for view in [&a, &b] {
        view.update(cx, |view, _| {
            view.load(App::Js(Bundle::source(code.clone())))
        });
    }
    wait_for(&a, cx, "A A");
    wait_for(&b, cx, "B B");
}

/// A Rust view (`test/keys`) that binds a keystroke of its own.
mod rust_keys {
    use nsh_core::{element::Registry, prelude::*};

    /// The set the app imports `Shortcut` from.
    pub(super) fn registry() -> Registry {
        let mut registry = Registry::ui_set("test/keys");
        registry.register::<Shortcut>();
        registry
    }

    #[derive(Debug, Clone, PartialEq, Props)]
    pub(super) struct ShortcutProps {
        /// The keystroke, as `on_key` takes it.
        pub(super) keys: Prop<SharedString>,
    }

    #[derive(Debug, Clone, PartialEq, Event)]
    pub(super) enum ShortcutEvent {
        /// The keystroke was pressed.
        Fired,
    }

    /// Binds `keys` (in text fields too) and reports each press.
    #[component]
    pub(super) fn Shortcut(props: ShortcutProps, cx: Scope<ShortcutEvent>) -> impl IntoElement {
        let options = KeyOptions {
            when: nsh_core::keymap::When::Always,
            ..KeyOptions::default()
        };
        on_key_with(&props.keys.get(), options, move |_| {
            cx.emit(ShortcutEvent::Fired)
        });
        view()
    }
}

/// A field logging Escape (JS's binding), Shift+Enter (a Rust view's) and
/// Mod+T (JS's, which shows and hides the view). `view_first` shows the
/// view from the start and binds Escape once it mounted. Otherwise Escape
/// is bound before any Rust view exists.
fn js_and_rust_view(view_first: bool) -> String {
    format!(
        r#"
import {{ mount, signal, View }} from "nsh";
import {{ Input }} from "nsh/base";
import {{ keymap }} from "nsh";
import {{ Shortcut }} from "test/keys";

const VIEW_FIRST = {view_first};

function App() {{
  const fired = signal("fired");
  const shown = signal(VIEW_FIRST);
  const fire = (name: string) => fired.set(`${{fired()}} ${{name}}`);
  const escape = () => keymap.bind("escape", () => fire("escape"), {{ when: "always" }});
  keymap.bind("mod+t", () => {{ shown.set(!shown()); fire(shown() ? "shown" : "hidden"); }}, {{ when: "always" }});
  if (VIEW_FIRST) setTimeout(() => {{ escape(); fire("bound"); }}, 0); else escape();
  return (
    <View style={{{{ flex: 1 }}}}>
      <Input autoFocus value={{fired()}} style={{{{ height: 30 }}}} />
      <If when={{shown()}}>
        <Shortcut keys="shift+enter" onFired={{() => fire("shift")}} style={{{{ height: 10 }}}} />
      </If>
    </View>
  );
}}
mount(App);
"#
    )
}

fn js_and_rust_view_shortcuts_fire_together_in_either_order(cx: &mut TestAppContext) {
    crate::set_ui_sets(vec![nsh_base::registry(), rust_keys::registry()]);
    let primary = if cfg!(target_os = "macos") {
        "cmd"
    } else {
        "ctrl"
    };
    let sets = [rust_keys::registry().into()];

    let code = nsh_bundler::compile_module("App.tsx", &js_and_rust_view(false), &sets).unwrap();
    let (view, window) =
        cx.add_window_view(|window, cx| AppView::new(AppOptions::default(), window, cx));
    view.update(window, |view, _| view.load(App::Js(Bundle::source(code))));
    window.update(|w, cx| w.focus(&view.focus_handle(cx), cx));
    wait_for(&view, window, "fired");
    window.simulate_keystrokes(&format!("{primary}-t"));
    wait_for(&view, window, "fired shown");
    window.simulate_keystrokes("escape shift-enter");
    wait_for(&view, window, "fired shown escape shift");
    // The view goes, and only its binding with it.
    window.simulate_keystrokes(&format!("{primary}-t"));
    wait_for(&view, window, "fired shown escape shift hidden");
    window.simulate_keystrokes("escape");
    wait_for(&view, window, "fired shown escape shift hidden escape");

    let code = nsh_bundler::compile_module("App.tsx", &js_and_rust_view(true), &sets).unwrap();
    let (view, window) =
        cx.add_window_view(|window, cx| AppView::new(AppOptions::default(), window, cx));
    view.update(window, |view, _| view.load(App::Js(Bundle::source(code))));
    window.update(|w, cx| w.focus(&view.focus_handle(cx), cx));
    wait_for(&view, window, "fired bound");
    window.simulate_keystrokes("escape shift-enter");
    wait_for(&view, window, "fired bound escape shift");
    window.simulate_keystrokes(&format!("{primary}-t"));
    wait_for(&view, window, "fired bound escape shift hidden");
    window.simulate_keystrokes("escape");
    wait_for(&view, window, "fired bound escape shift hidden escape");
}

/// A pad inside 8 points of padding. A press writes where it was in the
/// pad and in the window.
mod press_point {
    use nsh_base::input;
    use nsh_core::prelude::*;

    #[component]
    pub(super) fn PressPoint() -> impl IntoElement {
        let report = signal(String::from("none"));
        view()
            .p(px(8.0))
            .child(
                view()
                    .w(px(80.0))
                    .h(px(40.0))
                    .on(EventKind::Press, move |p: &EventPayload| {
                        let EventPayload::Press(e) = p else {
                            report.set("no position".into());
                            return;
                        };
                        report.set(format!(
                            "at {:.0} {:.0} in {:.0} {:.0}",
                            e.position.x.0,
                            e.position.y.0,
                            e.page_position.x.0,
                            e.page_position.y.0
                        ));
                    }),
            )
            .child(
                input()
                    .test_id("report")
                    .auto_focus(true)
                    .value(move || report.get())
                    .h(px(30.0)),
            )
    }
}

fn files_dropped_from_outside_reach_the_view_under_them(cx: &mut TestAppContext) {
    let source = r#"
import { mount, signal, View } from "nsh";
import { Input } from "nsh/base";
const log = signal<string[]>([]);
const add = (entry: string) => log.set([...log(), entry]);
mount(() => <View style={{ flex: 1 }}>
  <View
    onFileDragEnter={() => add("enter outer")}
    onFileDragLeave={() => add("leave outer")}
    onFileDrop={(e) => add("drop outer " + e.uris.join(";"))}
    style={{ height: 100 }}
  >
    <View
      onFileDragEnter={() => add("enter inner")}
      onFileDragLeave={() => add("leave inner")}
      onFileDrop={(e) => add("drop inner " + e.uris.join(";"))}
      style={{ height: 40 }}
    />
  </View>
  <View style={{ height: 100 }} />
  <Input autoFocus readonly value={log().join(", ") || "none"} style={{ height: 30 }} />
</View>);
"#;
    let code = nsh_bundler::compile_module("App.tsx", source, &[]).unwrap();
    let (view, cx) =
        cx.add_window_view(|window, cx| AppView::new(AppOptions::default(), window, cx));
    view.update(cx, |view, _| {
        view.load(App::Js(Bundle::source(code.clone())))
    });
    cx.update(|window, cx| window.focus(&view.focus_handle(cx), cx));
    wait_for(&view, cx, "none");
    let origin = view.read_with(cx, |view, _| view.surface().origin.get());
    let at = |y: f32| gpui::point(gpui::px(origin.0 + 10.0), gpui::px(origin.1 + y));
    let send = |cx: &mut VisualTestContext, event: gpui::FileDropEvent| {
        cx.update(|window, cx| {
            window.dispatch_event(gpui::PlatformInput::FileDrop(event), cx);
        });
        cx.run_until_parked();
    };
    let enter = |cx: &mut VisualTestContext, y: f32, paths: &[&str]| {
        let paths = gpui::ExternalPaths(paths.iter().map(std::path::PathBuf::from).collect());
        send(
            cx,
            gpui::FileDropEvent::Entered {
                position: at(y),
                paths,
            },
        );
        // The platform's next report, once the drag's frame has laid the
        // drop layer over the surface.
        send(cx, gpui::FileDropEvent::Pending { position: at(y) });
    };
    // The innermost listener under the drag is the destination; moving
    // leaves it for the next one, and the drop goes there, without the
    // relative path.
    enter(cx, 20.0, &["/tmp/a b.txt", "b.txt"]);
    wait_for(&view, cx, "enter inner");
    send(cx, gpui::FileDropEvent::Pending { position: at(70.0) });
    wait_for(&view, cx, "enter inner, leave inner, enter outer");
    send(cx, gpui::FileDropEvent::Submit { position: at(70.0) });
    wait_for(
        &view,
        cx,
        "enter inner, leave inner, enter outer, drop outer file:///tmp/a%20b.txt, leave outer",
    );
    // Leaving the window leaves the destination.
    enter(cx, 20.0, &["/tmp/c.txt"]);
    send(cx, gpui::FileDropEvent::Exited);
    wait_for(
        &view,
        cx,
        "enter inner, leave inner, enter outer, drop outer file:///tmp/a%20b.txt, leave outer, \
         enter inner, leave inner",
    );
    // Where no view listens, the drop goes nowhere.
    enter(cx, 150.0, &["/tmp/d.txt"]);
    send(
        cx,
        gpui::FileDropEvent::Submit {
            position: at(150.0),
        },
    );
    wait_for(
        &view,
        cx,
        "enter inner, leave inner, enter outer, drop outer file:///tmp/a%20b.txt, leave outer, \
         enter inner, leave inner",
    );
    // The same bundle reuses its node ids, but a new load owns its own drag events.
    enter(cx, 20.0, &["/tmp/reloaded.txt"]);
    wait_for(
        &view,
        cx,
        "enter inner, leave inner, enter outer, drop outer file:///tmp/a%20b.txt, leave outer, \
         enter inner, leave inner, enter inner",
    );
    view.update(cx, |view, _| view.load(App::Js(Bundle::source(code))));
    wait_for(&view, cx, "none");
    send(cx, gpui::FileDropEvent::Pending { position: at(20.0) });
    wait_for(&view, cx, "enter inner");
    send(cx, gpui::FileDropEvent::Submit { position: at(20.0) });
    wait_for(
        &view,
        cx,
        "enter inner, drop inner file:///tmp/reloaded.txt, leave inner",
    );
    enter(cx, 20.0, &["/tmp/cancelled.txt"]);
    send(cx, gpui::FileDropEvent::Exited);
    wait_for(
        &view,
        cx,
        "enter inner, drop inner file:///tmp/reloaded.txt, leave inner, enter inner, leave inner",
    );
    view.update(cx, |view, _| view.stop());
}

fn presses_carry_where_the_pointer_was(cx: &mut TestAppContext) {
    let (view, cx) =
        cx.add_window_view(|window, cx| AppView::new(AppOptions::default(), window, cx));
    view.update(cx, |view, _| {
        view.load(App::Rust(Root::of::<press_point::PressPoint>()))
    });
    cx.update(|window, cx| window.focus(&view.focus_handle(cx), cx));
    wait_for(&view, cx, "none");
    cx.simulate_click(
        gpui::point(gpui::px(18.0), gpui::px(20.0)),
        gpui::Modifiers::default(),
    );
    // Pressable views own native focus, so read the report independently of it.
    wait_for_report(&view, cx, "at 10 12 in 18 20");
}

/// Runs the window until the focused field's text satisfies `done`, and
/// returns it.
fn wait_until(
    view: &Entity<AppView>,
    cx: &mut VisualTestContext,
    done: impl Fn(&str) -> bool,
) -> String {
    let start = Instant::now();
    loop {
        cx.run_until_parked();
        let now = field_text(view, cx).unwrap_or_default();
        if done(&now) {
            return now;
        }
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "the field reads {now:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// A view the window's root holds, as an embedding app's frame does.
struct Framed(Entity<AppView>);

impl gpui::Render for Framed {
    fn render(&mut self, _: &mut Window, _: &mut gpui::Context<Self>) -> impl IntoElement {
        use gpui::ParentElement as _;
        div().size_full().child(self.0.clone())
    }
}

/// Opens a window whose root holds an [`AppView`] that owns the window,
/// running `code`, with the keyboard in the view.
fn owned_view(
    cx: &mut TestAppContext,
    options: AppOptions,
    code: String,
    setup: impl FnOnce(&AppView),
) -> (Entity<AppView>, &mut VisualTestContext) {
    use gpui::AppContext as _;
    let (framed, cx) = cx.add_window_view(|window, cx| {
        window.set_window_title(&options.title);
        let view = cx.new(|cx| {
            let view = AppView::new(options, window, cx);
            view.own_window(window, cx);
            view
        });
        Framed(view)
    });
    let view = framed.read_with(cx, |framed, _| framed.0.clone());
    view.update(cx, |view, _| {
        setup(view);
        view.load(App::Js(Bundle::source(code)));
    });
    cx.update(|window, cx| window.focus(&view.focus_handle(cx), cx));
    (view, cx)
}

/// Runs the window until `done` holds.
fn wait_until_window(
    cx: &mut VisualTestContext,
    what: &str,
    done: impl Fn(&mut VisualTestContext) -> bool,
) {
    let start = Instant::now();
    loop {
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(start.elapsed() < Duration::from_secs(10), "never: {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// The height available below the title bar, before the menu bar.
fn height_below_title_bar(cx: &mut VisualTestContext) -> f32 {
    let full = cx.update(|window, _| f32::from(window.viewport_size().height));
    // Windows draws a 32-point caption inside the viewport; Linux's
    // window manager draws its decorations outside it.
    full - if cfg!(windows) { 32.0 } else { 0.0 }
}

/// A field that reads the app's height (`h <points>`, the window less the
/// chrome around the app) and ` new` once New was chosen, under a title
/// and an application menu: File with New, Quit (the `quit` role, with a
/// shortcut of its own) and Close (the `close` role).
const OWNED_WINDOW: &str = r#"
import { mount, signal, View } from "nsh";
import { Input } from "nsh/base";
import { Menu, Window } from "nsh/desktop";

function App() {
  const height = signal(-1);
  const chosen = signal("");
  Window.setTitle("Owned");
  Menu.setApplicationMenu([
    {
      label: "File",
      submenu: [
        { label: "New", shortcut: "mod+shift+n", onSelect: () => chosen.set(" new") },
        { label: "Quit", role: "quit", shortcut: "mod+shift+q" },
        { label: "Close", role: "close", shortcut: "mod+shift+w" },
      ],
    },
  ]);
  return (
    <View style={{ flex: 1 }} onLayout={(e) => height.set(Math.round(e.size.height))}>
      <Input autoFocus value={`h ${height()}${chosen()}`} style={{ height: 30 }} />
    </View>
  );
}
mount(App);
"#;

/// The app's height the field reads.
fn app_height(view: &Entity<AppView>, cx: &mut VisualTestContext) -> f32 {
    let text = wait_until(view, cx, |t| t.starts_with("h ") && !t.starts_with("h -1"));
    text.split(' ').nth(1).and_then(|h| h.parse().ok()).unwrap()
}

fn an_embedded_view_that_owns_its_window_sets_its_title_and_menu(cx: &mut TestAppContext) {
    use nsh_core::platform::{Appearance, ColorScheme};

    let source = format!(
        r#"{OWNED_WINDOW}
import {{ keymap, setColorScheme }} from "nsh";
keymap.bind("mod+t", () => {{
  Window.setTitleBar("hidden", 48);
  Window.setMenuBar("autoHide");
  setColorScheme("dark");
  void Menu.popup([{{ label: "Retired popup", onSelect: () => {{}} }}]);
}}, {{ when: "always" }});
"#
    );
    let code = nsh_bundler::compile_module("App.tsx", &source, &[]).unwrap();
    let asked = Rc::new(std::cell::RefCell::new(Vec::new()));
    let log = asked.clone();
    let (view, cx) = owned_view(
        cx,
        AppOptions {
            title: "Embedding host".to_owned(),
            appearance: Appearance::Light,
            ..Default::default()
        },
        code,
        move |view| view.on_close_request(move |request, _, _| log.borrow_mut().push(request)),
    );
    wait_until_window(cx, "the app's title on the window", |cx| {
        cx.window_title().as_deref() == Some("Owned")
    });
    #[cfg(target_os = "macos")]
    let retired_action = cx.update(|_, cx| {
        let mut menu = cx.get_menus().unwrap().remove(0);
        let gpui::OwnedMenuItem::Action { action, .. } = menu.items.remove(0) else {
            panic!("the old app's first menu item is not an action");
        };
        action
    });
    if cfg!(target_os = "linux") {
        // The menu bar is drawn above the app, 28 points tall.
        let window = height_below_title_bar(cx);
        wait_until(&view, cx, |t| t == format!("h {}", window - 28.0));
    }
    view.update(cx, |view, cx| view.set_appearance(Appearance::Dark, cx));
    let primary = if cfg!(target_os = "macos") {
        "cmd"
    } else {
        "ctrl"
    };
    cx.simulate_keystrokes(&format!("{primary}-t"));
    wait_until_window(cx, "the old app's open popup and dark appearance", |cx| {
        view.read_with(cx, |view, _| {
            crate::chrome::menu_open(view.surface())
                && view.surface().appearance.get() == Appearance::Dark
        })
    });
    let replacement = r#"
import { mount, signal, View, keymap } from "nsh";
import { Input } from "nsh/base";
import { Menu } from "nsh/desktop";
function App() {
  const chosen = signal(0);
  const acknowledged = signal(0);
  keymap.bind("mod+k", () => {
    void Menu.popup([{ label: "Current action", onSelect: () => chosen.set(chosen() + 1) }]);
  }, { when: "always" });
  keymap.bind("mod+j", () => acknowledged.set(acknowledged() + 1), { when: "always" });
  keymap.bind("f8", () => Menu.setApplicationMenu([
    { label: "Current", submenu: [
      { label: "Current action", onSelect: () => chosen.set(chosen() + 1) },
    ] },
  ]), { when: "always" });
  return <View style={{ flex: 1 }}>
    <Input autoFocus value={`replacement ${chosen()} ${acknowledged()}`} style={{ height: 30 }} />
  </View>;
}
mount(App);
"#;
    let code = nsh_bundler::compile_module("App.tsx", replacement, &[]).unwrap();
    view.update(cx, |view, _| {
        view.stop();
        view.load(App::Js(Bundle::source(code)));
    });
    wait_for(&view, cx, "replacement 0 0");
    wait_until_window(cx, "the embedding window's restored title", |cx| {
        cx.window_title().as_deref() == Some("Embedding host")
    });
    view.read_with(cx, |view, _| {
        let surface = view.surface();
        assert!(!crate::chrome::menu_open(surface));
        assert_eq!(surface.environment.get().title_bar, Default::default());
        assert_eq!(surface.appearance.get(), Appearance::Light);
        assert_eq!(surface.host_dark.get(), Some(true));
        assert_eq!(surface.environment.get().color_scheme, ColorScheme::Light);
    });
    // The replacement's first popup reuses the old application menu's id 1.
    cx.simulate_keystrokes(&format!("{primary}-k"));
    wait_until_window(cx, "the replacement's first popup", |cx| {
        view.read_with(cx, |view, _| crate::chrome::menu_open(view.surface()))
    });
    cx.simulate_keystrokes("escape");
    wait_until_window(cx, "the replacement's popup closed", |cx| {
        view.read_with(cx, |view, _| !crate::chrome::menu_open(view.surface()))
    });
    cx.simulate_keystrokes(&format!("shift-{primary}-n"));
    cx.simulate_keystrokes(&format!("{primary}-j"));
    wait_for(&view, cx, "replacement 0 1");
    cx.simulate_keystrokes(&format!("{primary}-k"));
    wait_until_window(cx, "the replacement's popup reopened", |cx| {
        view.read_with(cx, |view, _| crate::chrome::menu_open(view.surface()))
    });
    cx.simulate_keystrokes("down");
    cx.simulate_keystrokes("enter");
    wait_for(&view, cx, "replacement 1 1");
    #[cfg(target_os = "macos")]
    {
        cx.simulate_keystrokes("f8");
        wait_until_window(cx, "the replacement's native menu", |cx| {
            cx.update(|_, cx| {
                cx.get_menus()
                    .is_some_and(|menus| menus.first().is_some_and(|menu| menu.name == "Current"))
            })
        });
        cx.update(|_, cx| {
            let mut menu = cx.get_menus().unwrap().remove(0);
            let gpui::OwnedMenuItem::Action { action, .. } = menu.items.remove(0) else {
                panic!("the replacement's first menu item is not an action");
            };
            cx.dispatch_action(retired_action.as_ref());
            cx.dispatch_action(action.as_ref());
        });
        wait_for(&view, cx, "replacement 2 1");
    }
    assert!(
        !cx.simulate_close(),
        "reload lost the embedding close handler"
    );
    wait_until_window(cx, "the embedding app's close request after reload", |_| {
        *asked.borrow() == [crate::CloseRequest::Close]
    });
    cx.simulate_keystrokes(&format!("{primary}-q"));
    wait_until_window(cx, "the owned window's quit request after reload", |_| {
        *asked.borrow() == [crate::CloseRequest::Close, crate::CloseRequest::Quit]
    });
}

fn quit_and_close_requests_go_to_the_handler_instead_of_acting(cx: &mut TestAppContext) {
    use crate::CloseRequest::{Close, Quit};
    let code = nsh_bundler::compile_module("App.tsx", OWNED_WINDOW, &[]).unwrap();
    let asked = Rc::new(std::cell::RefCell::new(Vec::new()));
    let log = asked.clone();
    let (view, cx) = owned_view(cx, AppOptions::default(), code, move |view| {
        view.on_close_request(move |request, _, _| log.borrow_mut().push(request))
    });
    app_height(&view, cx);
    let primary = if cfg!(target_os = "macos") {
        "cmd"
    } else {
        "ctrl"
    };
    let mut expected = Vec::new();
    for (keys, request) in [
        // The reserved quit key, Ctrl+W, and the menu's roles by their
        // shortcuts.
        (format!("{primary}-q"), Quit),
        (format!("{primary}-w"), Close),
        (format!("shift-{primary}-q"), Quit),
        (format!("shift-{primary}-w"), Close),
    ] {
        cx.simulate_keystrokes(&keys);
        expected.push(request);
        wait_until_window(cx, &format!("{keys} asks {request:?}"), |_| {
            *asked.borrow() == expected
        });
    }
    // The window's close button: the window stays.
    assert!(!cx.simulate_close(), "the close button closed the window");
    expected.push(Close);
    wait_until_window(cx, "the close button asks Close", |_| {
        *asked.borrow() == expected
    });
    // Still open, still running: the menu's other items work.
    let height = app_height(&view, cx);
    cx.simulate_keystrokes(&format!("shift-{primary}-n"));
    wait_for(&view, cx, &format!("h {height} new"));
}

/// The app's height under an auto-hidden menu bar (and ` new` once File
/// > New was chosen).
const AUTO_HIDDEN_BAR: &str = r#"
import { mount, signal, View } from "nsh";
import { Input } from "nsh/base";
import { Menu, Window } from "nsh/desktop";

function App() {
  const height = signal(-1);
  const chosen = signal("");
  Window.setMenuBar("autoHide");
  Menu.setApplicationMenu([
    { label: "File", submenu: [{ label: "New", onSelect: () => chosen.set(" new") }] },
  ]);
  return (
    <View style={{ flex: 1 }} onLayout={(e) => height.set(Math.round(e.size.height))}>
      <Input autoFocus value={`h ${height()}${chosen()}`} style={{ height: 30 }} />
    </View>
  );
}
mount(App);
"#;

fn an_auto_hidden_menu_bar_shows_on_alt_alone_and_while_a_menu_is_open(cx: &mut TestAppContext) {
    // macOS's menu bar is the system's.
    if !cfg!(target_os = "linux") && !cfg!(windows) {
        return;
    }
    let code = nsh_bundler::compile_module("App.tsx", AUTO_HIDDEN_BAR, &[]).unwrap();
    let (view, cx) = owned_view(cx, AppOptions::default(), code, |_| {});
    let full = height_below_title_bar(cx);
    let (hidden, shown) = (format!("h {full}"), format!("h {}", full - 28.0));
    wait_for(&view, cx, &hidden);
    let alt_alone = |cx: &mut VisualTestContext| {
        cx.simulate_modifiers_change(gpui::Modifiers::alt());
        cx.simulate_modifiers_change(gpui::Modifiers::none());
    };
    alt_alone(cx);
    wait_for(&view, cx, &shown);
    alt_alone(cx);
    wait_for(&view, cx, &hidden);
    // Alt with a key or another modifier is a shortcut: Alt + F opens File
    // (the bar shows while it is open), and the bar hides again as it
    // closes.
    cx.simulate_modifiers_change(gpui::Modifiers::alt());
    cx.simulate_keystrokes("alt-f");
    cx.simulate_modifiers_change(gpui::Modifiers::none());
    wait_for(&view, cx, &shown);
    cx.simulate_keystrokes("escape");
    wait_for(&view, cx, &hidden);
    cx.simulate_modifiers_change(gpui::Modifiers::alt());
    cx.simulate_modifiers_change(gpui::Modifiers {
        alt: true,
        shift: true,
        ..Default::default()
    });
    cx.simulate_modifiers_change(gpui::Modifiers::none());
    cx.run_until_parked();
    assert_eq!(
        field_text(&view, cx),
        Some(hidden.clone()),
        "Alt + Shift showed the bar"
    );
    // F10 opens the first menu; Return chooses its first item, and the bar
    // hides again.
    cx.simulate_keystrokes("f10");
    wait_for(&view, cx, &shown);
    cx.simulate_keystrokes("enter");
    wait_for(&view, cx, &format!("{hidden} new"));
}

/// Two images from two asset directories: each reports its size, or why
/// it did not load.
const TWO_ASSET_ROOTS: &str = r#"
import { mount, signal, View } from "nsh";
import { Input } from "nsh/base";
import { Image } from "nsh";

function App() {
  const text = signal("waiting");
  const seen: string[] = [];
  const report = (name: string, what: string) => {
    seen.push(`${name} ${what}`);
    if (seen.length === 2) text.set(seen.sort().join("|"));
  };
  return (
    <View style={{ flex: 1 }}>
      <Image
        src="asset:/app.png"
        onLoad={(e) => report("app", `${e.width}x${e.height}`)}
        onError={(e) => report("app", e.message)}
        style={{ width: 10, height: 10 }}
      />
      <Image
        src="asset:/bytes/cover.png"
        onLoad={(e) => report("cover", `${e.width}x${e.height}`)}
        onError={(e) => report("cover", e.message)}
        style={{ width: 10, height: 10 }}
      />
      <Input autoFocus value={text()} onChange={(t) => text.set(t)} style={{ height: 30 }} />
    </View>
  );
}
mount(App);
"#;

fn asset_uris_resolve_in_the_first_directory_that_has_the_file(cx: &mut TestAppContext) {
    let root = std::env::temp_dir().join(format!("nsh-asset-roots-{}", std::process::id()));
    let (app, archive) = (root.join("app"), root.join("archive"));
    std::fs::create_dir_all(archive.join("bytes")).unwrap();
    std::fs::create_dir_all(&app).unwrap();
    let png = |path: std::path::PathBuf, w: u32, h: u32| {
        image::RgbaImage::new(w, h).save(path).unwrap();
    };
    png(app.join("app.png"), 2, 3);
    png(archive.join("bytes/cover.png"), 4, 5);
    // The archive's own `app.png` is not the one shown: the app's comes
    // first.
    png(archive.join("app.png"), 7, 7);
    let code = nsh_bundler::compile_module("App.tsx", TWO_ASSET_ROOTS, &[]).unwrap();
    let (view, cx) =
        cx.add_window_view(|window, cx| AppView::new(AppOptions::default(), window, cx));
    view.update(cx, |view, _| {
        view.set_asset_base(Some(crate::AssetBase::Directories(vec![app, archive])));
        view.load(App::Js(Bundle::source(code)));
    });
    cx.update(|window, cx| window.focus(&view.focus_handle(cx), cx));
    let report = wait_until(&view, cx, |t| t.contains('|'));
    let _ = std::fs::remove_dir_all(&root);
    assert_eq!(report, "app 2x3|cover 4x5");
}

fn releasing_shift_before_alt_keeps_the_auto_hidden_menu_bar_hidden(cx: &mut TestAppContext) {
    if !cfg!(target_os = "linux") && !cfg!(windows) {
        return;
    }
    let code = nsh_bundler::compile_module("App.tsx", AUTO_HIDDEN_BAR, &[]).unwrap();
    let (view, cx) = owned_view(cx, AppOptions::default(), code, |_| {});
    let full = height_below_title_bar(cx);
    wait_for(&view, cx, &format!("h {full}"));
    for shift_first in [false, true] {
        cx.simulate_modifiers_change(if shift_first {
            gpui::Modifiers {
                shift: true,
                ..Default::default()
            }
        } else {
            gpui::Modifiers::alt()
        });
        cx.simulate_modifiers_change(gpui::Modifiers {
            alt: true,
            shift: true,
            ..Default::default()
        });
        cx.simulate_modifiers_change(gpui::Modifiers::alt());
        cx.simulate_modifiers_change(gpui::Modifiers::none());
        cx.run_until_parked();
        let height = view.read_with(cx, |view, _| view.surface().size().1);
        assert_eq!(
            height, full,
            "Alt+Shift showed the bar after Shift was released first (shift_first={shift_first})"
        );
    }
}

const MENU_OVER_FIELD: &str = r#"
import { mount, signal, View } from "nsh";
import { Input } from "nsh/base";
import { Menu } from "nsh/desktop";

function App() {
  const text = signal("abcd");
  const chose = (name: string) => () => text.set(`${text()} ${name}`);
  Menu.setApplicationMenu([
    {
      label: "Edit",
      submenu: [
        { label: "Revert", shortcut: "mod+z", when: "auto", onSelect: chose("revert") },
        { label: "Redo app", shortcut: "mod+y", when: "auto", onSelect: chose("app-redo") },
        { label: "Remove", shortcut: "delete", when: "auto", onSelect: chose("remove") },
        { label: "Send", shortcut: "mod+enter", when: "auto", onSelect: chose("send") },
        { label: "Purge", shortcut: "shift+delete", onSelect: chose("purge") },
      ],
    },
  ]);
  return (
    <View style={{ flex: 1 }}>
      <Input
        autoFocus
        submitBehavior="submit"
        value={text()}
        onChange={(t) => text.set(t)}
        style={{ height: 30 }}
      />
    </View>
  );
}
mount(App);
"#;

fn menu_shortcuts_leave_a_focused_field_the_keys_it_uses(cx: &mut TestAppContext) {
    let code = nsh_bundler::compile_module("App.tsx", MENU_OVER_FIELD, &[]).unwrap();
    let (view, cx) = cx.add_window_view(|window, cx| {
        let view = AppView::new(AppOptions::default(), window, cx);
        let title = window.window_title();
        crate::chrome::set_standalone(view.surface(), &title, window.window_handle());
        crate::system::own_window(view.surface());
        view
    });
    view.update(cx, |view, _| view.load(App::Js(Bundle::source(code))));
    cx.update(|window, cx| window.focus(&view.focus_handle(cx), cx));
    let primary = if cfg!(target_os = "macos") {
        "cmd"
    } else {
        "ctrl"
    };
    wait_for(&view, cx, "abcd");
    cx.simulate_keystrokes("end");
    cx.simulate_input("e");
    wait_for(&view, cx, "abcde");
    cx.simulate_keystrokes(&format!("{primary}-z"));
    wait_for(&view, cx, "abcd");
    cx.simulate_keystrokes(&format!("{primary}-y"));
    wait_for(&view, cx, "abcde");
    cx.simulate_keystrokes(&format!("{primary}-z"));
    wait_for(&view, cx, "abcd");
    cx.simulate_keystrokes("home delete");
    wait_for(&view, cx, "bcd");
    cx.simulate_keystrokes(&format!("{primary}-enter"));
    cx.run_until_parked();
    cx.simulate_keystrokes("shift-delete");
    wait_for(&view, cx, "bcd purge");
    cx.simulate_keystrokes("escape");
    wait_until_blurred(&view, cx);
    cx.simulate_keystrokes(&format!("{primary}-z {primary}-y delete {primary}-enter"));
    cx.run_until_parked();
    let (x, y) = view.read_with(cx, |view, _| view.surface().origin.get());
    cx.simulate_click(
        gpui::point(gpui::px(x + 20.0), gpui::px(y + 15.0)),
        gpui::Modifiers::default(),
    );
    wait_for(&view, cx, "bcd purge revert app-redo remove send");
}

fn wait_until_blurred(view: &Entity<AppView>, cx: &mut VisualTestContext) {
    let start = Instant::now();
    loop {
        cx.run_until_parked();
        if field_text(view, cx).is_none() {
            return;
        }
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "the field still has focus"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// A pressable strip whose report field shows the modifier keys and click
/// count of the last press.
const PRESS_MODIFIERS: &str = r#"
import { mount, signal, View } from "nsh";
import { Input } from "nsh/base";

function App() {
  const text = signal("none");
  return (
    <View style={{ flex: 1 }}>
      <View
        focusable={false}
        onPress={(e) =>
          text.set(
            e
              ? `ctrl ${e.modifiers.control} shift ${e.modifiers.shift} alt ${e.modifiers.alt} meta ${e.modifiers.platform} clicks ${e.clickCount}`
              : "no event",
          )
        }
        style={{ height: 40 }}
      />
      <Input testID="report" autoFocus value={text()} onChange={(t) => text.set(t)} style={{ height: 30 }} />
    </View>
  );
}
mount(App);
"#;

fn presses_carry_the_modifier_keys_and_click_count(cx: &mut TestAppContext) {
    let code = nsh_bundler::compile_module("App.tsx", PRESS_MODIFIERS, &[]).unwrap();
    let (view, cx) =
        cx.add_window_view(|window, cx| AppView::new(AppOptions::default(), window, cx));
    view.update(cx, |view, _| view.load(App::Js(Bundle::source(code))));
    cx.update(|window, cx| window.focus(&view.focus_handle(cx), cx));
    wait_for(&view, cx, "none");
    let strip = gpui::point(gpui::px(20.0), gpui::px(20.0));
    cx.simulate_click(strip, gpui::Modifiers::control());
    wait_for_report(
        &view,
        cx,
        "ctrl true shift false alt false meta false clicks 1",
    );
    // A double click is two presses, the second counted as such.
    click(cx, strip, 1);
    click(cx, strip, 2);
    wait_for_report(
        &view,
        cx,
        "ctrl false shift false alt false meta false clicks 2",
    );
}

/// A left click at `position` that is click `count` of a series.
fn click(cx: &mut VisualTestContext, position: gpui::Point<gpui::Pixels>, count: usize) {
    let (button, modifiers) = (gpui::MouseButton::Left, gpui::Modifiers::default());
    cx.simulate_event(gpui::MouseDownEvent {
        position,
        button,
        modifiers,
        click_count: count,
        first_mouse: false,
    });
    cx.simulate_event(gpui::MouseUpEvent {
        position,
        button,
        modifiers,
        click_count: count,
    });
}
