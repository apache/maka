//! `nsh/keymap`: app-level keyboard shortcuts.
//!
//! `keymap.bind("mod+k", handler)` parses the keystroke natively
//! (`nsh_core::keymap`), keeps the handler and sends the surface's whole
//! table to the platform (`Prop::Keymap` on the root). The platform
//! decides on the spot whether a key fires a binding and consumes it, then
//! reports the binding's id with the root's `KeyCommand` event, which runs
//! the handler here: the main thread never waits for JS.
//!
//! A binding made while a component renders (or an effect runs) is undone
//! with it; one made by a module's top-level code is undone when hot
//! module replacement runs that module again (`hot::undo_on_rerun`).

use std::{
    cell::{Cell, RefCell},
    sync::Arc,
};

use nsh_core::{
    EventKind, NodeId, Op, Prop, ROOT_ID,
    keymap::{KeyBinding, Keystroke, When, apple_keys},
    platform::{Os, Renderer},
};
use rquickjs::qjs;

use crate::{
    modules::{Export, Item, Ts},
    web::js::{self, Args, Ctx, R, Raw, UNDEFINED, V, closure, native, type_error},
};

struct Binding {
    id: u32,
    /// The keystroke as the app wrote it (what the handler gets).
    text: String,
    keystroke: Keystroke,
    when: When,
    repeat: bool,
    fallback: bool,
    within: Option<NodeId>,
    handler: V,
}

/// A context's bindings, oldest first.
#[derive(Default)]
pub(crate) struct Keymap {
    bindings: RefCell<Vec<Binding>>,
    next: Cell<u32>,
    /// Latest native focus path, not a reactive signal.
    focus_path: RefCell<Vec<NodeId>>,
}

impl Keymap {
    /// Frees the handlers (the state is unregistered).
    pub(crate) fn free_all(&self) {
        self.bindings.borrow_mut().clear();
    }
}

fn keymap<'a>(cx: Ctx) -> &'a Keymap {
    // SAFETY: a projection of the state's field, by shared reference.
    unsafe { &(*crate::state::state(cx)).keymap }
}

/// Replaces the host projection without entering application code.
pub(crate) fn set_focus_path(cx: Ctx, path: &[NodeId]) {
    let mut current = keymap(cx).focus_path.borrow_mut();
    current.clear();
    current.extend_from_slice(path);
}

fn scoped_node(cx: Ctx, value: Raw, operation: &str) -> R<NodeId> {
    let environment = crate::env::current(cx);
    if !environment.native_focus_scopes && environment.renderer != Renderer::Terminal {
        return Err(type_error(
            cx,
            &format!("{operation}: requires native focus scopes"),
        ));
    }
    crate::dom::node_id(cx, value)
        .ok_or_else(|| type_error(cx, &format!("{operation}: expected a ViewRef")))
}

fn os(cx: Ctx) -> nsh_core::platform::Os {
    // SAFETY: the state's renderer, by shared reference.
    unsafe { &(*crate::state::state(cx)).dom }.os()
}

/// Whether shortcuts follow Apple's conventions here (`mod` is Command):
/// the app's OS, or for a browser the platform it runs on. Terminals use Control.
fn apple(cx: Ctx) -> bool {
    let environment = crate::env::current(cx);
    !environment.uses_terminal_keyboard() && apple_keys(os(cx), environment.apple_keyboard)
}

/// The `keymap` object.
fn make(cx: Ctx) -> Raw {
    let made = (|| -> R<V> {
        let obj = js::new_object(cx)?;
        let bind = js::function(cx, c"bind", bind, 3)?;
        js::define(cx, obj.raw(), "bind", bind, true)?;
        let label = js::function(cx, c"label", label, 1)?;
        js::define(cx, obj.raw(), "label", label, true)?;
        let focused = js::function(cx, c"focusedWithin", focused_within, 1)?;
        js::define(cx, obj.raw(), "focusedWithin", focused, true)?;
        Ok(obj)
    })();
    made.map_or(qjs::JS_EXCEPTION, V::take)
}

/// The options: `when` (`undefined`, `"always"` or `"notEditing"`) and
/// `repeat`, a supported fallback phase and a native focus scope.
fn parse_options(cx: Ctx, options: Raw) -> R<(When, bool, bool, Option<NodeId>)> {
    if js::is_nullish(options) {
        return Ok((When::Auto, false, false, None));
    }
    if !js::is_object(options) {
        return Err(type_error(cx, "keymap.bind: options must be an object"));
    }
    let repeat = js::to_bool(cx, js::get(cx, options, "repeat")?.raw());
    let fallback = js::to_bool(cx, js::get(cx, options, "fallback")?.raw());
    let environment = crate::env::current(cx);
    if fallback && !environment.fallback_key_bindings && environment.renderer != Renderer::Terminal
    {
        return Err(type_error(
            cx,
            "keymap.bind fallback: requires native fallback keyboard shortcuts",
        ));
    }
    let node = js::get(cx, options, "within")?;
    let within = (!node.is_undefined())
        .then(|| scoped_node(cx, node.raw(), "keymap.bind within"))
        .transpose()?;
    let value = js::get(cx, options, "when")?;
    if value.is_undefined() {
        return Ok((When::Auto, repeat, fallback, within));
    }
    let when = match js::to_string(cx, value.raw())?.as_str() {
        "always" => When::Always,
        "notEditing" => When::NotEditing,
        other => {
            return Err(type_error(
                cx,
                &format!("keymap.bind: when must be \"always\" or \"notEditing\", not {other:?}"),
            ));
        }
    };
    Ok((when, repeat, fallback, within))
}

native! {
    /// Reads the last native focus path without tracking a dependency.
    fn focused_within(cx, _this, args) {
        let node = scoped_node(cx, args.get(0), "keymap.focusedWithin")?;
        Ok(V::bool(keymap(cx).focus_path.borrow().contains(&node)))
    }
}

native! {
    /// `label(keystroke)`: the keystroke as hints show it here (`⇧⌘L`,
    /// `Ctrl+Shift+L`).
    fn label(cx, _this, args) {
        let text = js::to_string(cx, args.get(0))?;
        let keystroke = Keystroke::parse_with(&text, apple(cx))
            .map_err(|e| type_error(cx, &format!("keymap.label: {e}")))?;
        js::string(cx, &keystroke.label(os(cx), apple(cx)))
    }
}

native! {
    /// `bind(keystroke, handler, options?)` or `bind({ keystroke: handler },
    /// options?)`: returns a function that removes the bindings.
    fn bind(cx, _this, args) {
        let first = args.get(0);
        let (pairs, options) = if js::is_object(first) && !js::is_function(cx, first) {
            (js::record(cx, first)?, args.get(1))
        } else {
            let text = match js::opt_string(cx, first)? {
                Some(text) if !js::is_nullish(first) => text,
                _ => {
                    return Err(type_error(
                        cx,
                        "keymap.bind: expected a keystroke (\"mod+k\") or an object of keystrokes and handlers",
                    ));
                }
            };
            (vec![(text, V::dup(cx, args.get(1)))], args.get(2))
        };
        let (when, repeat, fallback, within) = parse_options(cx, options)?;
        let (os, apple) = (os(cx), apple(cx));
        // A terminal uses the Control-based host shortcuts on every OS.
        let reserved_os = if crate::env::current(cx).uses_terminal_keyboard() {
            Os::Linux
        } else {
            os
        };
        // Every binding is checked before any is made.
        let mut parsed = Vec::with_capacity(pairs.len());
        for (text, handler) in pairs {
            let keystroke = Keystroke::parse_with(&text, apple)
                .map_err(|e| type_error(cx, &format!("keymap.bind: {e}")))?;
            if let Some(why) = keystroke.reserved(reserved_os) {
                return Err(type_error(
                    cx,
                    &format!("keymap.bind: {text:?} cannot be bound: {why}"),
                ));
            }
            if !js::is_function(cx, handler.raw()) {
                return Err(type_error(
                    cx,
                    &format!("keymap.bind: the handler of {text:?} is not a function"),
                ));
            }
            parsed.push((text, keystroke, handler));
        }
        let k = keymap(cx);
        let first_id = k.next.get() + 1;
        let count = parsed.len() as u32;
        k.next.set(first_id + count);
        let was_empty = k.bindings.borrow().is_empty();
        k.bindings.borrow_mut().extend(parsed.into_iter().enumerate().map(
            |(i, (text, keystroke, handler))| Binding {
                id: first_id + i as u32,
                text,
                keystroke,
                when,
                repeat,
                fallback,
                within,
                handler,
            },
        ));
        if was_empty && count > 0 {
            let on = js::function(cx, c"onKeyCommand", on_key_command, 1)?;
            crate::dom::set_handler(cx, ROOT_ID, EventKind::KeyCommand, on.raw())
                .map_err(|_| js::Throw)?;
        }
        send(cx)?;
        let unbind = closure(cx, Vec::new(), move |cx, _, _| {
            unbind(cx, first_id..first_id + count)?;
            Ok(V::undefined())
        })?;
        undo_with_owner(cx, &unbind);
        Ok(unbind)
    }
}

/// Removes the bindings with ids in `ids` (once: later calls find none).
fn unbind(cx: Ctx, ids: std::ops::Range<u32>) -> R<()> {
    let k = keymap(cx);
    let (gone, empty) = {
        let mut bindings = k.bindings.borrow_mut();
        let gone: Vec<Binding> = bindings.extract_if(.., |b| ids.contains(&b.id)).collect();
        (gone, bindings.is_empty())
    };
    if gone.is_empty() {
        return Ok(());
    }
    // The handlers are freed with no borrow held.
    drop(gone);
    if empty {
        crate::dom::set_handler(cx, ROOT_ID, EventKind::KeyCommand, UNDEFINED)
            .map_err(|_| js::Throw)?;
    }
    send(cx)
}

/// The function undoing a binding runs when the current owner (a
/// component, an effect) goes, or, at a module's top level, when hot
/// module replacement runs the module again.
pub(crate) fn undo_with_owner(cx: Ctx, unbind: &V) {
    if crate::reactive::has_owner(cx) {
        let mut f = unbind.raw();
        // SAFETY: one borrowed argument; the result is a new reference.
        let r = unsafe { crate::reactive::on_cleanup(cx, UNDEFINED, 1, &mut f) };
        drop(V::own(cx, r));
    } else {
        crate::hot::undo_on_rerun(cx, unbind.clone_ref());
    }
}

/// Sends the table to the platform.
fn send(cx: Ctx) -> R<()> {
    let table = keymap(cx)
        .bindings
        .borrow()
        .iter()
        .map(|b| {
            let mut binding = KeyBinding::new(b.id, b.keystroke, b.when, b.repeat);
            binding.fallback = b.fallback;
            binding.within = b.within;
            binding
        })
        .collect();
    let op = Op::SetProp {
        id: ROOT_ID,
        prop: Prop::Keymap(Arc::new(nsh_core::keymap::Keymap::new(table))),
    };
    crate::dom::push_op(cx, op).map_err(|_| js::Throw)
}

/// The root's `onKeyCommand(id)`: runs the binding's handler with
/// `{ keystroke }` (as written; one object, as every event).
unsafe extern "C" fn on_key_command(
    cx: Ctx,
    _this: Raw,
    argc: std::ffi::c_int,
    argv: *mut Raw,
) -> Raw {
    // SAFETY: QuickJS passes `argc` live arguments.
    let args = unsafe { Args::new(argc, argv) };
    let run = || -> R<V> {
        let id = js::to_number(cx, args.get(0))? as u32;
        let found = keymap(cx)
            .bindings
            .borrow()
            .iter()
            .find(|b| b.id == id)
            .map(|b| (b.handler.clone_ref(), b.text.clone()));
        // A binding removed since the platform matched it.
        let Some((handler, text)) = found else {
            return Ok(V::undefined());
        };
        let event = js::new_object(cx)?;
        js::define(cx, event.raw(), "keystroke", js::string(cx, &text)?, true)?;
        js::call(cx, handler.raw(), UNDEFINED, &[event.raw()])
    };
    run().map_or(qjs::JS_EXCEPTION, V::take)
}

/// `nsh/keymap`'s exports.
pub(crate) const EXPORTS: &[Item] = &[(
    "keymap",
    Export::Value(make),
    Ts::value(
        "The app's keyboard shortcuts: `keymap.bind(\"mod+k\", openSearch)`.",
        "Keymap",
    ),
)];

/// `nsh/keymap`'s types.
pub(crate) const TYPES: &str = r#"export interface KeyBindingOptions {
  /** When the binding fires while a text input (or a web view) has the
   * keyboard focus. By default it does unless the input uses the keystroke
   * itself: keys that type, move the caret or delete, and select all, cut,
   * copy, paste, undo, redo. `"always"`: in text inputs too.
   * `"notEditing"`: never while one has the focus. */
  when?: "always" | "notEditing";
  /** Fire again on the auto-repeats of a held key (default false: once until
   * the key is released). */
  repeat?: boolean;
  /** Run only after native controls, editing, selection and navigation leave
   * the key unhandled. Regular bindings keep their earlier priority.
   * Supported by terminal and GPUI backends; throws without host support. */
  fallback?: boolean;
  /** Fires while native keyboard focus is on this node or a descendant.
   * A nonmatching scope leaves older bindings and native defaults eligible.
   * Throws when the host does not support native focus scopes. */
  within?: ViewRef;
}

/** The app's keyboard shortcuts: on desktop and terminal backends, the web,
 * and iOS and Android with a hardware keyboard. A keystroke is modifiers and a key joined by
 * `+`, in any case (lowercase is the recommended style; a capital letter is
 * the same key, not Shift): `"mod+k"`, `"ctrl+shift+p"`, `"alt+enter"`, `"escape"`,
 * `"f5"`, `"mod+plus"`. Modifiers: `mod` (`cmdorctrl`): Command on Apple
 * graphical platforms (and in a browser on one), Control in terminals and elsewhere, for the app's own shortcuts; `cmd`
 * (`command`, `meta`, `super`, `win`), `ctrl` (`control`), `alt` (`option`,
 * `opt`), `shift`. Keys: the character a key types on the US layout without
 * Shift (`k`, `1`, `/`, `[`; `"shift+/"` for `?`), `plus` (`=`), `minus`
 * (`-`), `space`, `enter`, `escape`, `tab`, `backspace`, `delete`, `insert`,
 * `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `f1` to
 * `f24`; they match on any keyboard layout, and menu shortcuts
 * (`nsh/desktop`) take the same. The platform consumes a key that fires a
 * binding; when several bindings have its keystroke, the newest that may
 * fire runs. */
export interface Keymap {
  /** Runs `handler` when `keystroke` is pressed (it gets `{ keystroke }`,
   * the keystroke as written, in its case); returns a function that removes the binding. A binding made while a component renders is removed
   * with the component. Throws on an invalid keystroke, or one the platform
   * keeps (Command+Q, Command+H, Command+M, Control+Command+F on Apple
   * platforms; Control+Q, Alt+F4, F11 elsewhere). */
  bind(keystroke: string, handler: (e: { keystroke: string }) => void, options?: KeyBindingOptions): () => void;
  /** Binds each keystroke of `bindings` to its handler, which gets
   * `{ keystroke }` as written; returns a function that removes them all. */
  bind(bindings: Record<string, (e: { keystroke: string }) => void>, options?: KeyBindingOptions): () => void;
  /** `keystroke` as menus and hints show it where the app runs: `"⇧⌘L"` on
   * Apple platforms (and in a browser on one), `"Ctrl+Shift+L"` elsewhere,
   * for `"mod+shift+l"`. Throws on an invalid keystroke. */
  label(keystroke: string): string;
  /** Reads the latest host-reported native focus path.
   * Includes the node itself and its descendants; false with no focus.
   * This read is not reactive and does not subscribe to focus changes.
   * Throws without host support or for a value other than ViewRef. */
  focusedWithin(node: ViewRef): boolean;
}
"#;
