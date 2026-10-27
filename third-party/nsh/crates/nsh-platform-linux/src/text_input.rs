//! Text inputs: a `gtk::Text` (single line) or a `gtk::TextView` in a
//! `gtk::ScrolledWindow` (`multiline`), hosted in the input's view at the
//! content box the core laid out (inside padding and border).
//!
//! The view draws the decoration (background, border, corners) from the
//! core's style like any other view, so the editors draw only text: a
//! style provider of their own (one per input, on the editors' style
//! contexts) clears GTK's background, padding and frame and sets the
//! font, colors and caret. The placeholder is a `gtk::Label` under the
//! editor for both kinds, shown while the text is empty, so it follows
//! the same provider (GTK's own placeholder of `gtk::Text` is a widget
//! the provider of its parent does not reach).
//!
//! Every user edit increments the input's edit count and reports
//! `onChangeText` with it (always, as the engine keeps the text); a value
//! from JS based on an older count is stale and dropped, so fast typing
//! is never overwritten. The report waits until the main loop is idle (or
//! the input submits or loses the focus), so an edit GTK makes in steps
//! reports its result once: a text view replaces a selection (a paste,
//! undo, redo) by a deletion and an insertion, each a `changed` signal. Programmatic changes (JS values, swapping
//! editors) report nothing. Lengths and offsets JS sees are UTF-16 units;
//! GTK counts characters.
//!
//! Return follows the config's `submit()`: a single line `gtk::Text`
//! reports it from its `activate` signal; in a multiline one whose return
//! submits, a plain return (or Ctrl+Return) submits before the text view
//! sees it, while Shift+Return and Alt+Return still insert a line break.
//! The input method sees that return first
//! (`gtk_text_view_im_context_filter_keypress`), so one that commits a
//! composition (CJK input methods) submits nothing.
//!
//! `onKeyPress` reports what typing inserts and deletes, as UIKit does
//! (nothing for pasted or undone text, no Backspace for a selection typed
//! over), and Escape, as on macOS.
//!
//! Input accessory views (`inputAccessoryViewID`) belong over a software
//! keyboard and have no meaning on the desktop: they are never shown.

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
};

use gtk4::{self as gtk, glib, prelude::*};
use nsh_core::{
    AutoCapitalize, Bounds, EventKind, EventPayload, InputConfig, KeyboardType, PayloadValue,
    Points, SubmitBehavior, TextAlign,
    geometry::{Point, Size},
    tailwind::state,
};

use crate::{surface::Surface, view::NshView};

/// The widget that edits.
#[derive(Clone)]
enum Editor {
    /// Single line.
    Line(gtk::Text),
    /// Several lines; GTK's text view does not scroll by itself.
    Area {
        scroller: gtk::ScrolledWindow,
        view: gtk::TextView,
    },
}

impl Editor {
    /// The widget that takes focus.
    fn widget(&self) -> gtk::Widget {
        match self {
            Editor::Line(t) => t.clone().upcast(),
            Editor::Area { view, .. } => view.clone().upcast(),
        }
    }

    /// The widget hosted in the view.
    fn host(&self) -> gtk::Widget {
        match self {
            Editor::Line(t) => t.clone().upcast(),
            Editor::Area { scroller, .. } => scroller.clone().upcast(),
        }
    }

    fn text(&self) -> String {
        match self {
            Editor::Line(t) => t.text().into(),
            Editor::Area { view, .. } => {
                let b = view.buffer();
                b.text(&b.start_iter(), &b.end_iter(), false).into()
            }
        }
    }

    /// The selection in characters (`start <= end`).
    fn selection(&self) -> (i32, i32) {
        match self {
            Editor::Line(t) => t.selection_bounds().unwrap_or_else(|| {
                let p = t.position();
                (p, p)
            }),
            Editor::Area { view, .. } => {
                let b = view.buffer();
                let insert = b.iter_at_mark(&b.get_insert()).offset();
                let bound = b.iter_at_mark(&b.selection_bound()).offset();
                (insert.min(bound), insert.max(bound))
            }
        }
    }

    /// The caret's bounds in `target`'s coordinates (`onCaretMove`'s
    /// `bounds`): where the editor draws it, its scrolling applied.
    fn caret_bounds(&self, target: &gtk::Widget) -> Option<Bounds<Points>> {
        let (widget, x, y, width, height): (gtk::Widget, f32, f32, f32, f32) = match self {
            Editor::Line(t) => {
                let (strong, _) = t.compute_cursor_extents(t.position().max(0) as usize);
                let w = t.clone().upcast();
                (w, strong.x(), strong.y(), strong.width(), strong.height())
            }
            Editor::Area { view, .. } => {
                let b = view.buffer();
                let (strong, _) = view.cursor_locations(Some(&b.iter_at_mark(&b.get_insert())));
                let (x, y) = view.buffer_to_window_coords(
                    gtk::TextWindowType::Widget,
                    strong.x(),
                    strong.y(),
                );
                let w = view.clone().upcast();
                (
                    w,
                    x as f32,
                    y as f32,
                    strong.width() as f32,
                    strong.height() as f32,
                )
            }
        };
        let origin = widget.compute_point(target, &gtk::graphene::Point::new(x, y))?;
        Some(Bounds {
            origin: Point::new(Points(origin.x()), Points(origin.y())),
            // GTK reports an empty width; its caret is a line one pixel wide.
            size: Size::new(Points(width.max(1.0)), Points(height)),
        })
    }

    /// The caret in characters.
    fn caret(&self) -> i32 {
        match self {
            Editor::Line(t) => t.position(),
            Editor::Area { view, .. } => {
                let b = view.buffer();
                b.iter_at_mark(&b.get_insert()).offset()
            }
        }
    }

    fn select(&self, start: i32, end: i32) {
        match self {
            Editor::Line(t) => t.select_region(start, end),
            Editor::Area { view, .. } => {
                let b = view.buffer();
                b.select_range(&b.iter_at_offset(end), &b.iter_at_offset(start));
            }
        }
    }

    fn set_text(&self, text: &str) {
        match self {
            Editor::Line(t) => t.set_text(text),
            Editor::Area { view, .. } => view.buffer().set_text(text),
        }
    }

    fn is_empty(&self) -> bool {
        match self {
            Editor::Line(t) => t.text_length() == 0,
            Editor::Area { view, .. } => view.buffer().char_count() == 0,
        }
    }

    fn focus(&self) {
        match self {
            // Selecting everything on focus is GtkEntry's habit, not an
            // app's.
            Editor::Line(t) => {
                t.grab_focus_without_selecting();
            }
            Editor::Area { view, .. } => {
                view.grab_focus();
            }
        }
    }
}

/// The native side of an input view ([`crate::view::ViewState::input`]).
pub(crate) struct InputState {
    editor: RefCell<Editor>,
    /// Shown while the text is empty, under the editor.
    placeholder: gtk::Label,
    /// The input's own styles, on its editor and placeholder.
    provider: gtk::CssProvider,
    /// The CSS `provider` holds, to skip reloading an unchanged one.
    css: RefCell<String>,
    /// The animated text color over `provider`'s: a sheet of its own, so
    /// frames of a color animation reload one rule, not the whole sheet.
    color_provider: gtk::CssProvider,
    /// The animated color `color_provider` holds.
    anim_color: Cell<Option<nsh_core::Color>>,
    config: RefCell<InputConfig>,
    /// A configuration was applied (auto focus happens on the first).
    configured: Cell<bool>,
    /// Content box; the whole view until the core sends one.
    content: Cell<Option<Bounds<Points>>>,
    /// User edits reported to the engine.
    count: Cell<u32>,
    /// A change made here, not by the user, is being applied.
    applying: Cell<bool>,
    /// A clipped insertion (`maxLength`) is being applied.
    clipping: Cell<bool>,
    /// The key press being handled, until the main loop is idle again.
    key: Cell<Option<(gtk::gdk::Key, gtk::gdk::ModifierType)>>,
    /// A user edit's `onChangeText` (and the selection after it) waits for
    /// the main loop to be idle.
    pending: Cell<bool>,
    /// The idle task that reports that edit, cancelled by an earlier flush.
    change_idle: RefCell<Option<glib::SourceId>>,
    /// The pending composition-end report, after its committed edit.
    composition_idle: RefCell<Option<glib::SourceId>>,
    /// A paste was asked for: its insertion (and the deletion of the
    /// selection it replaces) types no key.
    pasting: Cell<bool>,
    /// Focus as last reported.
    focused: Cell<bool>,
    /// Selection as last reported (UTF-16).
    selection: Cell<(u32, u32)>,
    /// The caret as last reported, in the view.
    caret: Cell<Bounds<Points>>,
    /// The input method's composition (its preedit text) while one is in
    /// progress: GTK shows it in the editor, outside the text.
    composition: RefCell<Option<String>>,
    /// JS's value set during a composition, with its count: setting the
    /// text then would reset the input method, so it is applied when the
    /// composition ends.
    held: RefCell<Option<(String, u32)>>,
    /// The handlers' context, for reports after programmatic changes.
    cx: std::cell::OnceCell<Ctx>,
    /// The window whose focus widget is watched, and the handler.
    window: RefCell<Option<(glib::WeakRef<gtk::Window>, glib::SignalHandlerId)>>,
    /// The handler that focuses the editor once it is shown (`autoFocus`).
    auto_focus: RefCell<Option<(gtk::Widget, glib::SignalHandlerId)>>,
}

/// What a signal handler needs, without keeping anything alive.
#[derive(Clone)]
struct Ctx {
    surface: Weak<Surface>,
    view: glib::WeakRef<NshView>,
    input: Weak<InputState>,
}

impl Ctx {
    fn get(&self) -> Option<(Rc<Surface>, NshView, Rc<InputState>)> {
        Some((
            self.surface.upgrade()?,
            self.view.upgrade()?,
            self.input.upgrade()?,
        ))
    }

    /// The input, if the user (not this module) changes its text.
    fn user_edit(&self) -> Option<Rc<InputState>> {
        self.input
            .upgrade()
            .filter(|input| !input.applying.get() && !input.clipping.get())
    }

    /// Sends `kind` if JS listens to it.
    fn send(&self, kind: EventKind, payload: impl FnOnce() -> EventPayload) {
        let Some((surface, view, _)) = self.get() else {
            return;
        };
        let (id, listens) = {
            let s = view.state();
            (s.id, s.events.contains(kind))
        };
        if listens {
            surface.event(id, kind, payload());
        }
    }

    /// An insertion: reports the key that typed it, unless it was pasted
    /// (or undone).
    fn inserted(&self, input: &InputState, text: &str) {
        let undo = input
            .key
            .get()
            .is_some_and(|(key, modifiers)| undoes(key, modifiers));
        if !input.pasting.replace(false) && !undo {
            self.key_press(key_of(text));
        }
    }

    /// A deletion: reports Backspace, unless typing (or pasting) replaces
    /// the selection, or it is undone.
    fn deleted(&self, input: &InputState) {
        let quiet = input
            .key
            .get()
            .is_some_and(|(key, modifiers)| types(key, modifiers) || undoes(key, modifiers));
        if !quiet && !input.pasting.get() {
            self.key_press("Backspace");
        }
    }

    fn key_press(&self, key: &str) {
        self.send(EventKind::KeyPress, || {
            EventPayload::Map(vec![("key", PayloadValue::Str(key.to_owned()))])
        });
    }

    /// The text changed.
    fn changed(&self) {
        let Some((_, view, input)) = self.get() else {
            return;
        };
        input.update_placeholder();
        // The field's text paints outside its bounds: see `NshView::changed`.
        view.changed();
        if input.applying.get() {
            return;
        }
        // Counted now, so JS values based on the text before it are stale.
        input.count.set(input.count.get() + 1);
        if !input.pending.replace(true) {
            let c = self.clone();
            let source = glib::idle_add_local_once(move || {
                if let Some(input) = c.input.upgrade() {
                    input.change_idle.borrow_mut().take();
                }
                c.flush_change();
            });
            *input.change_idle.borrow_mut() = Some(source);
        }
    }

    /// Reports the user's edits not reported yet, and the selection after
    /// them.
    fn flush_change(&self) {
        let Some((surface, view, input)) = self.get() else {
            return;
        };
        if let Some(source) = input.change_idle.borrow_mut().take() {
            source.remove();
        }
        if !input.pending.replace(false) {
            return;
        }
        let text = input.editor.borrow().text();
        // Always reported: the engine keeps the text for layout and for
        // dropping stale values, whether JS listens or not.
        surface.event(
            view.id(),
            EventKind::ChangeText,
            EventPayload::Text {
                text,
                count: input.count.get(),
            },
        );
        self.selection_changed();
    }

    /// A paste (Ctrl+V, Shift+Insert, the context menu) into the editor
    /// `widget`: reports what the clipboard holds (`onPaste`) if the app
    /// listens, read now, on the user's paste (GTK reads it asynchronously:
    /// the report may come after the text it inserts); whether the editor
    /// pastes its text (`pasteBehavior`).
    fn pasting(&self, widget: &gtk::Widget) -> bool {
        let Some((surface, view, input)) = self.get() else {
            return true;
        };
        if view.state().events.contains(EventKind::Paste) {
            let id = view.id();
            let surface = Rc::downgrade(&surface);
            crate::system::read_pasted(widget.clipboard(), move |paste| {
                if let Some(surface) = surface.upgrade() {
                    surface.event(id, EventKind::Paste, EventPayload::Paste(Box::new(paste)));
                }
            });
        }
        let inserts = input.config.borrow().paste_behavior == nsh_core::PasteBehavior::Insert;
        // Its insertion (and the deletion of the selection it replaces)
        // types no key.
        input.pasting.set(inserts);
        inserts
    }

    /// The caret or selection may have moved.
    fn selection_changed(&self) {
        let Some((_, view, input)) = self.get() else {
            return;
        };
        // A programmatic change moves the caret in steps; it is reported
        // once, where it ends. After a user edit, with its change.
        if input.applying.get() || input.pending.get() {
            return;
        }
        let editor = input.editor.borrow().clone();
        if view.state().events.contains(EventKind::SelectionChange) {
            let (start, end) = editor.selection();
            let text = editor.text();
            let range = (
                char_to_utf16(&text, start as usize),
                char_to_utf16(&text, end as usize),
            );
            if input.selection.replace(range) != range {
                self.send(EventKind::SelectionChange, || {
                    EventPayload::Map(vec![
                        ("start", PayloadValue::Number(range.0 as f64)),
                        ("end", PayloadValue::Number(range.1 as f64)),
                    ])
                });
            }
        }
        self.caret_moved();
    }

    /// `onCaretMove` while the input edits, if its caret moved: with the
    /// selection, or as the text view scrolled or the input was laid out
    /// again.
    fn caret_moved(&self) {
        let Some((_, view, input)) = self.get() else {
            return;
        };
        if !input.focused.get()
            || input.applying.get()
            || input.pending.get()
            || !view.state().events.contains(EventKind::CaretMove)
        {
            return;
        }
        let editor = input.editor.borrow().clone();
        let caret = editor.caret_bounds(view.upcast_ref()).unwrap_or_default();
        if input.caret.replace(caret) != caret {
            self.send(EventKind::CaretMove, || EventPayload::caret(caret));
        }
    }

    /// Follows the focus of the window the editor `widget` is shown in.
    fn watch_window(&self, widget: &gtk::Widget) {
        let Some(input) = self.input.upgrade() else {
            return;
        };
        let Some(window) = widget.root().and_then(|r| r.downcast::<gtk::Window>().ok()) else {
            return;
        };
        let mut watched = input.window.borrow_mut();
        if watched
            .as_ref()
            .is_some_and(|(w, _)| w.upgrade().as_ref() == Some(&window))
        {
            return;
        }
        if let Some((old, handler)) = watched.take()
            && let Some(old) = old.upgrade()
        {
            old.disconnect(handler);
        }
        let c = self.clone();
        let handler = window.connect_focus_widget_notify(move |_| c.focus_changed());
        *watched = Some((window.downgrade(), handler));
        drop(watched);
        self.focus_changed();
    }

    /// The input method's preedit text changed: empty when its
    /// composition ends (committed or cancelled).
    fn preedit_changed(&self, text: &str) {
        let Some(input) = self.input.upgrade() else {
            return;
        };
        if text.is_empty() {
            self.composition_ended();
            return;
        }
        if input.composition.borrow().as_deref() == Some(text) {
            return;
        }
        *input.composition.borrow_mut() = Some(text.to_owned());
        self.send_composition(true, text);
    }

    /// The composition ended. The text it committed is inserted around the
    /// same time, so its end is reported once idle, after that text's
    /// `onChangeText`; then the value JS set meanwhile applies.
    fn composition_ended(&self) {
        let Some(input) = self.input.upgrade() else {
            return;
        };
        if input.composition.borrow_mut().take().is_none() {
            return;
        }
        if input.composition_idle.borrow().is_some() {
            return;
        }
        let c = self.clone();
        let source = glib::idle_add_local_once(move || {
            if let Some(input) = c.input.upgrade() {
                input.composition_idle.borrow_mut().take();
            }
            c.flush_composition();
        });
        *input.composition_idle.borrow_mut() = Some(source);
    }

    /// Reports the composition's end after its admitted text edits.
    fn flush_composition(&self) {
        let Some((_, view, input)) = self.get() else {
            return;
        };
        if let Some(source) = input.composition_idle.borrow_mut().take() {
            source.remove();
        }
        if input.composition.borrow().is_some() {
            // Another composition started: this one's value waits for it.
            return;
        }
        self.flush_change();
        self.send_composition(false, "");
        let held = input.held.borrow_mut().take();
        if let Some((text, count)) = held {
            value(&view, &text, count);
        }
    }

    fn send_composition(&self, composing: bool, text: &str) {
        self.send(EventKind::CompositionChange, || {
            EventPayload::Map(vec![
                ("composing", PayloadValue::Bool(composing)),
                ("text", PayloadValue::Str(text.to_owned())),
            ])
        });
    }

    /// Focus entered or left the editor.
    fn focus_changed(&self) {
        let Some((surface, view, input)) = self.get() else {
            return;
        };
        // The window's focus widget, not `has-focus`: an inactive window
        // keeps its focused field, as an app in the background does.
        let widget = input.editor.borrow().widget();
        let focused = widget
            .root()
            .and_then(|r| r.focus())
            .is_some_and(|f| f == widget || f.is_ancestor(&widget));
        if input.focused.replace(focused) == focused {
            return;
        }
        self.flush_change();
        if !focused {
            // GTK resets the input method when the focus leaves.
            self.composition_ended();
        }
        crate::input::set_state(&surface, &view, state::FOCUSED, focused);
        let kind = if focused {
            EventKind::Focus
        } else {
            EventKind::Blur
        };
        self.send(kind, || EventPayload::None);
    }

    /// Return submitted the input (`submitBehavior` `submit` or
    /// `blurAndSubmit`).
    fn submitted(&self) {
        let Some(input) = self.input.upgrade() else {
            return;
        };
        self.key_press("Enter");
        self.flush_change();
        let text = input.editor.borrow().text();
        let count = input.count.get();
        self.send(EventKind::SubmitEditing, || EventPayload::Text {
            text,
            count,
        });
        if input.config.borrow().submit() == SubmitBehavior::BlurAndSubmit {
            unfocus(&input.editor.borrow().widget());
        }
    }

    /// The part of `text` an insertion into `current` may add
    /// (`maxLength`).
    fn allowed<'a>(&self, current: impl FnOnce() -> String, text: &'a str) -> &'a str {
        let max = self
            .input
            .upgrade()
            .and_then(|input| input.config.borrow().max_length);
        match max {
            Some(max) => clip_utf16(text, (max as usize).saturating_sub(utf16_len(&current()))),
            None => text,
        }
    }
}

impl Drop for InputState {
    fn drop(&mut self) {
        if let Some((window, handler)) = self.window.take()
            && let Some(window) = window.upgrade()
        {
            window.disconnect(handler);
        }
    }
}

impl InputState {
    fn update_placeholder(&self) {
        let shown = !self.config.borrow().placeholder.is_empty() && self.editor.borrow().is_empty();
        self.placeholder.set_visible(shown);
    }

    /// Sets the text without reporting it, keeping the caret where it
    /// was (at the end if it was there).
    fn replace_text(&self, text: &str) {
        let editor = self.editor.borrow().clone();
        let old = editor.text();
        let caret = editor.caret() as usize;
        let at_end = caret >= old.chars().count();
        self.applying.set(true);
        editor.set_text(text);
        let len = text.chars().count();
        let caret = if at_end { len } else { caret.min(len) } as i32;
        editor.select(caret, caret);
        self.applying.set(false);
        self.update_placeholder();
        if let Some(cx) = self.cx.get() {
            cx.selection_changed();
        }
    }
}

/// Takes the focus from `widget` if it has it.
fn unfocus(widget: &gtk::Widget) {
    if let Some(root) = widget.root()
        && root
            .focus()
            .is_some_and(|f| &f == widget || f.is_ancestor(widget))
    {
        root.set_focus(None::<&gtk::Widget>);
    }
}

/// Sets up an input view.
pub(crate) fn create(surface: &Rc<Surface>, view: &NshView) {
    let placeholder = gtk::Label::new(None);
    placeholder.set_can_target(false);
    placeholder.set_visible(false);
    placeholder.add_css_class("nsh-placeholder");
    let input = Rc::new(InputState {
        editor: RefCell::new(new_editor(false)),
        placeholder,
        provider: gtk::CssProvider::new(),
        color_provider: gtk::CssProvider::new(),
        anim_color: Cell::new(None),
        css: RefCell::new(String::new()),
        config: RefCell::new(InputConfig::default()),
        configured: Cell::new(false),
        content: Cell::new(None),
        count: Cell::new(0),
        applying: Cell::new(false),
        clipping: Cell::new(false),
        key: Cell::new(None),
        pasting: Cell::new(false),
        pending: Cell::new(false),
        change_idle: RefCell::new(None),
        composition_idle: RefCell::new(None),
        focused: Cell::new(false),
        selection: Cell::new((0, 0)),
        caret: Cell::new(Bounds::default()),
        composition: RefCell::new(None),
        held: RefCell::new(None),
        cx: std::cell::OnceCell::new(),
        window: RefCell::new(None),
        auto_focus: RefCell::new(None),
    });
    add_provider(&input.placeholder, &input.provider);
    let cx = Ctx {
        surface: Rc::downgrade(surface),
        view: view.downgrade(),
        input: Rc::downgrade(&input),
    };
    attach(&cx, &input.editor.borrow(), &input);
    let _ = input.cx.set(cx);
    view.state_mut().input = Some(input);
}

/// Adds the input's provider to `widget` (and so to its CSS subnodes,
/// though not to child widgets).
#[allow(deprecated)] // Widget-scoped providers have no replacement.
fn add_provider(widget: &impl IsA<gtk::Widget>, provider: &gtk::CssProvider) {
    widget
        .style_context()
        .add_provider(provider, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION + 1);
}

/// Adds the input's style sheets to an editor widget: its own, then the
/// animated color over it.
#[allow(deprecated)] // Widget-scoped providers have no replacement.
fn add_providers(widget: &impl IsA<gtk::Widget>, input: &InputState) {
    add_provider(widget, &input.provider);
    widget.style_context().add_provider(
        &input.color_provider,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION + 2,
    );
}

/// Connects an editor's signals.
fn attach(cx: &Ctx, editor: &Editor, input: &InputState) {
    let widget = editor.widget();
    match editor {
        Editor::Line(t) => {
            add_providers(t, input);
            let c = cx.clone();
            t.connect_insert_text(move |t, text, pos| {
                let Some(input) = c.user_edit() else { return };
                let fit = c.allowed(|| t.text().into(), text);
                if !fit.is_empty() {
                    c.inserted(&input, fit);
                }
                if fit.len() < text.len() {
                    t.stop_signal_emission_by_name("insert-text");
                    if !fit.is_empty() {
                        input.clipping.set(true);
                        t.insert_text(fit, pos);
                        input.clipping.set(false);
                    }
                }
            });
            let c = cx.clone();
            t.connect_delete_text(move |_, start, end| {
                if start != end
                    && let Some(input) = c.user_edit()
                {
                    c.deleted(&input);
                }
            });
            let c = cx.clone();
            t.connect_paste_clipboard(move |t| {
                if !c.pasting(t.upcast_ref()) {
                    t.stop_signal_emission_by_name("paste-clipboard");
                }
            });
            let c = cx.clone();
            t.connect_changed(move |_| c.changed());
            let c = cx.clone();
            t.connect_preedit_changed(move |_, text| c.preedit_changed(text));
            let c = cx.clone();
            t.connect_local("activate", false, move |_| {
                c.submitted();
                None
            });
            for property in ["cursor-position", "selection-bound"] {
                let c = cx.clone();
                t.connect_notify_local(Some(property), move |_, _| c.selection_changed());
            }
        }
        Editor::Area { scroller, view } => {
            add_providers(scroller, input);
            add_providers(view, input);
            let buffer = view.buffer();
            let c = cx.clone();
            buffer.connect_insert_text(move |b, iter, text| {
                let Some(input) = c.user_edit() else { return };
                let fit = c.allowed(
                    || b.text(&b.start_iter(), &b.end_iter(), false).into(),
                    text,
                );
                if !fit.is_empty() {
                    c.inserted(&input, fit);
                }
                if fit.len() < text.len() {
                    b.stop_signal_emission_by_name("insert-text");
                    if !fit.is_empty() {
                        input.clipping.set(true);
                        // Inserting revalidates `iter` for the caller.
                        b.insert(iter, fit);
                        input.clipping.set(false);
                    }
                }
            });
            let c = cx.clone();
            buffer.connect_delete_range(move |_, start, end| {
                if start != end
                    && let Some(input) = c.user_edit()
                {
                    c.deleted(&input);
                }
            });
            let c = cx.clone();
            view.connect_paste_clipboard(move |view| {
                if !c.pasting(view.upcast_ref()) {
                    view.stop_signal_emission_by_name("paste-clipboard");
                }
            });
            let c = cx.clone();
            buffer.connect_changed(move |_| c.changed());
            let c = cx.clone();
            view.connect_preedit_changed(move |_, text| c.preedit_changed(text));
            let c = cx.clone();
            buffer.connect_mark_set(move |b, _, mark| {
                if *mark == b.get_insert() || *mark == b.selection_bound() {
                    c.selection_changed();
                }
            });
            let c = cx.clone();
            buffer.connect_cursor_position_notify(move |_| c.selection_changed());
            // Scrolling the text moves the caret.
            let c = cx.clone();
            scroller
                .vadjustment()
                .connect_value_changed(move |_| c.caret_moved());
        }
    }

    // Focus is followed on the window: focus controllers only hear of it
    // while the window is active.
    let c = cx.clone();
    widget.connect_map(move |w| c.watch_window(w));

    // Backspace in an empty input deletes nothing, so no deletion reports
    // it. A return that submits a multiline input is taken here, before the
    // text view inserts a line break.
    let keys = gtk::EventControllerKey::new();
    keys.set_propagation_phase(gtk::PropagationPhase::Capture);
    let c = cx.clone();
    let area = match editor {
        Editor::Area { view, .. } => Some(view.downgrade()),
        Editor::Line(_) => None,
    };
    keys.connect_key_pressed(move |keys, key, _, modifiers| {
        let Some(input) = c.input.upgrade() else {
            return glib::Propagation::Proceed;
        };
        // A paste that inserted nothing (an empty clipboard) ends here.
        input.pasting.set(false);
        if input.key.replace(Some((key, modifiers))).is_none() {
            let weak = c.input.clone();
            glib::idle_add_local_once(move || {
                if let Some(input) = weak.upgrade() {
                    input.key.set(None);
                }
            });
        }
        let (editable, submit) = {
            let config = input.config.borrow();
            (config.editable, config.submit())
        };
        if key == gtk::gdk::Key::BackSpace && editable && input.editor.borrow().is_empty() {
            c.key_press("Backspace");
        }
        // Reported as on macOS; the window's keys then leave the field
        // (`navigation::key_pressed`).
        if key == gtk::gdk::Key::Escape {
            c.key_press("Escape");
        }
        if editable
            && is_return(key)
            && submits(submit, modifiers)
            && let Some(view) = area.as_ref().and_then(|v| v.upgrade())
            && let Some(event) = keys.current_event()
        {
            // A return that commits a composition belongs to the input
            // method, which has now seen it (the view must not again).
            if !view.im_context_filter_keypress(&event) {
                c.submitted();
            }
            return glib::Propagation::Stop;
        }
        glib::Propagation::Proceed
    });
    widget.add_controller(keys);
}

fn new_editor(multiline: bool) -> Editor {
    if multiline {
        let view = gtk::TextView::new();
        view.set_wrap_mode(gtk::WrapMode::WordChar);
        view.set_accepts_tab(false);
        let scroller = gtk::ScrolledWindow::new();
        scroller.set_has_frame(false);
        scroller.set_policy(gtk::PolicyType::Never, gtk::PolicyType::Automatic);
        scroller.set_child(Some(&view));
        Editor::Area { scroller, view }
    } else {
        Editor::Line(gtk::Text::new())
    }
}

/// `Input`.
pub(crate) fn config(_surface: &Rc<Surface>, view: &NshView, config: &InputConfig) {
    let Some(input) = view.state().input.clone() else {
        return;
    };
    let multiline = matches!(&*input.editor.borrow(), Editor::Area { .. });
    if config.multiline != multiline {
        let old = input.editor.borrow().clone();
        let text = old.text();
        let focused = input.focused.get();
        view.remove_native(&old.host());
        let editor = new_editor(config.multiline);
        if let Some(cx) = input.cx.get() {
            attach(cx, &editor, &input);
        }
        *input.editor.borrow_mut() = editor.clone();
        input.replace_text(&text);
        place(view, &input);
        if focused {
            editor.focus();
        }
    }

    let editor = input.editor.borrow().clone();
    let direction = if config.rtl {
        gtk::TextDirection::Rtl
    } else {
        gtk::TextDirection::Ltr
    };
    let xalign = xalign(config.align, config.rtl);
    let (purpose, hints) = purpose(config);
    match &editor {
        Editor::Line(t) => {
            t.set_visibility(!config.secure);
            // UIKit's and Android's bullet: GTK's default (●) is twice as large.
            t.set_invisible_char('•');
            t.set_editable(config.editable);
            t.set_alignment(xalign);
            t.set_input_purpose(purpose);
            t.set_input_hints(hints);
            t.set_direction(direction);
        }
        Editor::Area { view, .. } => {
            view.set_editable(config.editable);
            view.set_cursor_visible(config.editable && !config.caret_hidden);
            view.set_justification(match config.align {
                TextAlign::Center => gtk::Justification::Center,
                TextAlign::Justify => gtk::Justification::Fill,
                _ if xalign > 0.5 => gtk::Justification::Right,
                _ => gtk::Justification::Left,
            });
            view.set_input_purpose(purpose);
            view.set_input_hints(hints);
            view.set_direction(direction);
        }
    }
    let label = &input.placeholder;
    label.set_label(&config.placeholder);
    label.set_xalign(xalign);
    label.set_direction(direction);
    if config.multiline {
        label.set_yalign(0.0);
        label.set_wrap(true);
        label.set_wrap_mode(gtk::pango::WrapMode::WordChar);
        label.set_ellipsize(gtk::pango::EllipsizeMode::None);
    } else {
        label.set_yalign(0.5);
        label.set_wrap(false);
        label.set_ellipsize(gtk::pango::EllipsizeMode::End);
    }

    let css = css(config);
    if *input.css.borrow() != css {
        input.provider.load_from_string(&css);
        *input.css.borrow_mut() = css;
    }
    *input.config.borrow_mut() = config.clone();
    input.update_placeholder();
    let first = !input.configured.replace(true);
    if first && config.auto_focus {
        auto_focus(&input, &editor);
    }
    place(view, &input);
}

/// Focuses the editor once it is on screen.
fn auto_focus(input: &Rc<InputState>, editor: &Editor) {
    let widget = editor.widget();
    if widget.is_mapped() {
        editor.focus();
        return;
    }
    let weak = Rc::downgrade(input);
    let handler = widget.connect_map(move |_| {
        let Some(input) = weak.upgrade() else { return };
        if let Some((widget, handler)) = input.auto_focus.borrow_mut().take() {
            widget.disconnect(handler);
        }
        input.editor.borrow().focus();
    });
    *input.auto_focus.borrow_mut() = Some((widget, handler));
}

/// Flushes admitted edits and cancels delayed work when a subtree leaves.
pub(crate) fn retire_cell(view: &NshView) {
    let input = view.state().input.clone();
    if let Some(input) = input {
        if let Some((widget, handler)) = input.auto_focus.borrow_mut().take() {
            widget.disconnect(handler);
        }
        if let Some(cx) = input.cx.get() {
            cx.focus_changed();
            cx.flush_change();
            if input.composition_idle.borrow().is_some() {
                cx.flush_composition();
            }
        }
    }
    for child in view.child_views() {
        retire_cell(&child);
    }
}

/// Places the editor and the placeholder at the content box.
fn place(view: &NshView, input: &InputState) {
    let content = input.content.get().unwrap_or_else(|| {
        let f = view.state().frame;
        Bounds {
            origin: Point {
                x: Points(0.0),
                y: Points(0.0),
            },
            size: Size {
                width: f.size.width,
                height: f.size.height,
            },
        }
    });
    if content.size.width.0 <= 0.0 || content.size.height.0 <= 0.0 {
        return;
    }
    let label = &input.placeholder;
    // The placeholder goes first: hosted widgets are drawn in order.
    match &*input.editor.borrow() {
        Editor::Line(t) => {
            // GTK centers one line in the field's height, as UIKit does;
            // a box shorter than the line grows around its center.
            let min = |w: &gtk::Widget| w.measure(gtk::Orientation::Vertical, -1).0 as f32;
            let height = content
                .size
                .height
                .0
                .max(min(t.upcast_ref()))
                .max(min(label.upcast_ref()));
            let rect = Bounds {
                origin: Point::new(
                    content.origin.x,
                    content.origin.y + (content.size.height - Points(height)) / 2.0,
                ),
                size: Size::new(content.size.width, Points(height)),
            };
            view.set_native(label, rect);
            view.set_native(t, rect);
        }
        Editor::Area {
            scroller,
            view: text,
        } => {
            // GTK's text view leaves its adjustment as it is while it
            // animates a scroll to the caret, and a new line starts one
            // just before the core grows the box for it: the scroll would
            // end a line down, at the old height, with a scroll bar.
            // Ending it lets the allocation coming for the new height set
            // the adjustment up again (and back to the top if everything
            // fits).
            if scroller.height() as f32 != content.size.height.0
                && let Some(adjustment) = text.vadjustment()
            {
                adjustment.set_value(adjustment.value());
            }
            let width = content.size.width.0.max(0.0) as i32;
            let height = label.measure(gtk::Orientation::Vertical, width).0 as f32;
            view.set_native(
                label,
                Bounds {
                    size: Size::new(content.size.width, content.size.height.max(Points(height))),
                    ..content
                },
            );
            view.set_native(scroller, content);
        }
    }
}

/// The horizontal alignment of the text (0: left, 1: right).
fn xalign(align: TextAlign, rtl: bool) -> f32 {
    match align {
        TextAlign::Center => 0.5,
        TextAlign::Right => 1.0,
        TextAlign::Left | TextAlign::Justify => 0.0,
        TextAlign::Auto if rtl => 1.0,
        TextAlign::Auto => 0.0,
    }
}

/// What the input method is told about the field.
fn purpose(config: &InputConfig) -> (gtk::InputPurpose, gtk::InputHints) {
    let purpose = match (config.secure, config.keyboard) {
        (true, KeyboardType::Number) => gtk::InputPurpose::Pin,
        (true, _) => gtk::InputPurpose::Password,
        (false, KeyboardType::Default) => gtk::InputPurpose::FreeForm,
        (false, KeyboardType::Number) => gtk::InputPurpose::Digits,
        (false, KeyboardType::Decimal | KeyboardType::Numeric) => gtk::InputPurpose::Number,
        (false, KeyboardType::NumbersAndPunctuation) => gtk::InputPurpose::FreeForm,
        (false, KeyboardType::Email) => gtk::InputPurpose::Email,
        (false, KeyboardType::Phone) => gtk::InputPurpose::Phone,
        (false, KeyboardType::Url) => gtk::InputPurpose::Url,
    };
    let mut hints = match config.auto_capitalize {
        AutoCapitalize::None => gtk::InputHints::NONE,
        AutoCapitalize::Sentences => gtk::InputHints::UPPERCASE_SENTENCES,
        AutoCapitalize::Words => gtk::InputHints::UPPERCASE_WORDS,
        AutoCapitalize::Characters => gtk::InputHints::UPPERCASE_CHARS,
    };
    hints |= if config.auto_correct {
        gtk::InputHints::SPELLCHECK | gtk::InputHints::WORD_COMPLETION
    } else {
        gtk::InputHints::NO_SPELLCHECK
    };
    if config.secure {
        hints |= gtk::InputHints::PRIVATE;
    }
    (purpose, hints)
}

/// The input's style sheet: GTK's decoration off (the view draws the
/// node's), the font and colors of the config on.
fn css(config: &InputConfig) -> String {
    use std::fmt::Write;
    let s = &config.style;
    let css_color = |c| crate::decor::rgba(c).to_str().to_string();
    let color = css_color(s.color);
    let mut font = String::new();
    if let Some(families) = s.font_family.and_then(|f| css_families(&f.name())) {
        let _ = write!(font, "font-family: {families}; ");
    }
    let _ = write!(
        font,
        "font-size: {}px; font-weight: {}; font-style: {}; letter-spacing: {}px;",
        s.font_size.0,
        s.font_weight,
        if s.italic { "italic" } else { "normal" },
        s.letter_spacing.0,
    );
    let caret = if config.caret_hidden {
        "transparent".to_owned()
    } else {
        config.caret_color.map_or_else(|| color.clone(), css_color)
    };
    let placeholder = config
        .placeholder_color
        .map_or_else(|| format!("alpha({color}, 0.5)"), css_color);
    let mut css = format!(
        "text, textview, textview > text, scrolledwindow, label.nsh-placeholder {{ \
         background: none; border: none; box-shadow: none; outline: none; padding: 0; \
         margin: 0; min-height: 0; min-width: 0; color: {color}; caret-color: {caret}; \
         -gtk-secondary-caret-color: {caret}; {font} }}\n\
         label.nsh-placeholder {{ color: {placeholder}; opacity: 1; }}\n"
    );
    // Always set: GTK themes draw the selection with the background this
    // sheet clears, and hide it while the window is in the backdrop. iOS
    // tints it with the system blue when there is no `selectionColor`.
    let selection = config
        .selection_color
        .map_or_else(|| "#007aff".to_owned(), css_color);
    let _ = writeln!(
        css,
        "text > selection, textview > text > selection, \
         text > selection:backdrop, textview > text > selection:backdrop {{ \
         background-color: alpha({selection}, 0.3); color: {color}; }}"
    );
    if s.line_height.0 > 0.0 {
        let _ = writeln!(
            css,
            "textview > text, label.nsh-placeholder {{ line-height: {}px; }}",
            s.line_height.0
        );
    }
    css
}

/// A `fontFamily` as a CSS family list, with the names [`crate::text`]
/// maps; `None` for the desktop's UI font, which GTK widgets use without
/// one (`gtk-font-name`).
fn css_families(name: &str) -> Option<String> {
    let families: Vec<String> = name
        .split(',')
        .map(|f| f.trim().trim_matches(['"', '\'']))
        .filter(|f| !f.is_empty())
        .filter_map(|f| match f {
            "system-ui" | "sans-serif" | "ui-sans-serif" => None,
            "ui-monospace" | "monospace" => Some("monospace".to_owned()),
            "ui-serif" | "serif" => Some("serif".to_owned()),
            f => Some(format!("\"{}\"", f.replace(['"', '\\'], ""))),
        })
        .collect();
    (!families.is_empty()).then(|| families.join(", "))
}

/// The text input `view` holds now (`None`: it is no input).
#[cfg(feature = "dev")]
pub(crate) fn current_text(view: &NshView) -> Option<String> {
    let input = view.state().input.clone()?;
    let text = input.editor.borrow().text();
    Some(text)
}

/// Whether the input `view` inserts what is pasted (`pasteBehavior`).
#[cfg(feature = "dev")]
pub(crate) fn pastes_text(view: &NshView) -> bool {
    view.state().input.clone().is_some_and(|input| {
        input.config.borrow().paste_behavior == nsh_core::PasteBehavior::Insert
    })
}

/// `InputValue`: JS's text, unless the user typed since JS saw `count`.
pub(crate) fn value(view: &NshView, text: &str, count: u32) {
    let Some(input) = view.state().input.clone() else {
        return;
    };
    if count < input.count.get() || input.editor.borrow().text() == text {
        return;
    }
    if input.composition.borrow().is_some() {
        *input.held.borrow_mut() = Some((text.to_owned(), count));
        return;
    }
    input.replace_text(text);
}

/// The view's animated values changed (a frame of a native animation):
/// applies an animated text color to the editor.
pub(crate) fn animated(view: &NshView) {
    let (input, color) = {
        let s = view.state();
        let Some(input) = s.input.clone() else { return };
        (input, s.anim.color)
    };
    if input.anim_color.replace(color) == color {
        return;
    }
    let css = color.map_or_else(String::new, |c| {
        let c = crate::decor::rgba(c).to_str();
        format!("text, textview, textview > text {{ color: {c}; }}")
    });
    input.color_provider.load_from_string(&css);
}

/// `InputContent`.
pub(crate) fn content(view: &NshView, content: Bounds<Points>) {
    let Some(input) = view.state().input.clone() else {
        return;
    };
    input.content.set(Some(content));
    place(view, &input);
    // The text wraps again once GTK lays the editor out at its new size
    // (before idle callbacks run).
    if let Some(cx) = input.cx.get() {
        let c = cx.clone();
        glib::idle_add_local_once(move || c.caret_moved());
    }
}

/// An input accessory inserted into `parent`. There is no software
/// keyboard to show it over on the desktop, so it stays unmounted.
pub(crate) fn accessory(_surface: &Rc<Surface>, _parent: &NshView, child: &NshView) {
    log::debug!("input accessory {} is not shown on Linux", child.id());
}

/// `focus()`.
pub(crate) fn focus(view: &NshView) {
    let input = view.state().input.clone();
    if let Some(input) = input {
        input.editor.borrow().focus();
    }
}

/// `blur()`.
pub(crate) fn blur(view: &NshView) {
    let input = view.state().input.clone();
    if let Some(input) = input {
        unfocus(&input.editor.borrow().widget());
    }
}

/// Unfocuses whatever input of the surface has focus.
pub(crate) fn blur_all(surface: &Rc<Surface>) {
    let root = surface.root.upcast_ref::<gtk::Widget>();
    if let Some(window) = root.root()
        && let Some(focus) = window.focus()
        && (focus.is::<gtk::Text>() || focus.is::<gtk::TextView>())
        && focus.is_ancestor(root)
    {
        window.set_focus(None::<&gtk::Widget>);
    }
}

/// `setSelection` (UTF-16 offsets).
pub(crate) fn set_selection(view: &NshView, start: u32, end: u32) {
    let Some(input) = view.state().input.clone() else {
        return;
    };
    let editor = input.editor.borrow().clone();
    let text = editor.text();
    editor.select(
        utf16_to_char(&text, start) as i32,
        utf16_to_char(&text, end) as i32,
    );
}

/// Return or Enter.
fn is_return(key: gtk::gdk::Key) -> bool {
    use gtk::gdk::Key;
    matches!(key, Key::Return | Key::KP_Enter | Key::ISO_Enter)
}

/// Whether a return with `modifiers` submits a multiline input whose
/// return does `behavior`: Shift+Return and Alt+Return insert a line break
/// all the same, as in desktop chat apps.
fn submits(behavior: SubmitBehavior, modifiers: gtk::gdk::ModifierType) -> bool {
    use gtk::gdk::ModifierType as M;
    behavior != SubmitBehavior::Newline && !modifiers.intersects(M::SHIFT_MASK | M::ALT_MASK)
}

/// Whether `key` types (a character, or a line break), replacing the
/// selection rather than deleting it.
fn types(key: gtk::gdk::Key, modifiers: gtk::gdk::ModifierType) -> bool {
    use gtk::gdk::ModifierType as M;
    let shortcut = modifiers.intersects(M::CONTROL_MASK | M::ALT_MASK | M::SUPER_MASK);
    !shortcut && (is_return(key) || key.to_unicode().is_some_and(|c| !c.is_control()))
}

/// Whether `key` is Undo or Redo (Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y), whose
/// edits type no key.
fn undoes(key: gtk::gdk::Key, modifiers: gtk::gdk::ModifierType) -> bool {
    use gtk::gdk::{Key, ModifierType as M};
    modifiers.contains(M::CONTROL_MASK) && matches!(key.to_lower(), Key::z | Key::y)
}

/// The key an insertion reports (`onKeyPress`).
fn key_of(text: &str) -> &str {
    if text == "\n" { "Enter" } else { text }
}

/// Length of `s` in UTF-16 units.
fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// The UTF-16 offset of character `chars` of `s` (clamped to its end).
fn char_to_utf16(s: &str, chars: usize) -> u32 {
    s.chars().take(chars).map(char::len_utf16).sum::<usize>() as u32
}

/// The character offset of UTF-16 offset `units` of `s`: an offset inside
/// a surrogate pair moves past the pair; one past the end clamps.
fn utf16_to_char(s: &str, units: u32) -> usize {
    let mut at = 0;
    for (i, c) in s.chars().enumerate() {
        if at >= units as usize {
            return i;
        }
        at += c.len_utf16();
    }
    s.chars().count()
}

/// The longest prefix of `s` that fits in `max` UTF-16 units, cut between
/// characters.
fn clip_utf16(s: &str, max: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &s[..i];
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_offsets() {
        let s = "a😀b";
        assert_eq!(utf16_len(s), 4);
        assert_eq!(char_to_utf16(s, 0), 0);
        assert_eq!(char_to_utf16(s, 1), 1);
        assert_eq!(char_to_utf16(s, 2), 3);
        assert_eq!(char_to_utf16(s, 3), 4);
        assert_eq!(char_to_utf16(s, 9), 4);
        assert_eq!(utf16_to_char(s, 0), 0);
        assert_eq!(utf16_to_char(s, 1), 1);
        assert_eq!(utf16_to_char(s, 2), 2);
        assert_eq!(utf16_to_char(s, 3), 2);
        assert_eq!(utf16_to_char(s, 4), 3);
        assert_eq!(utf16_to_char(s, 99), 3);
    }

    #[test]
    fn max_length_clipping() {
        assert_eq!(clip_utf16("hello", 3), "hel");
        assert_eq!(clip_utf16("hello", 9), "hello");
        assert_eq!(clip_utf16("hello", 0), "");
        // A pair is never split.
        assert_eq!(clip_utf16("a😀", 2), "a");
        assert_eq!(clip_utf16("a😀", 3), "a😀");
        assert_eq!(clip_utf16("中文", 1), "中");
    }

    #[test]
    fn keys() {
        assert_eq!(key_of("\n"), "Enter");
        assert_eq!(key_of("x"), "x");
    }

    #[test]
    fn typing_keys() {
        use gtk::gdk::{Key, ModifierType as M};
        assert!(types(Key::a, M::empty()));
        assert!(types(Key::A, M::SHIFT_MASK));
        assert!(types(Key::Return, M::empty()));
        assert!(!types(Key::BackSpace, M::empty()));
        assert!(!types(Key::Delete, M::empty()));
        assert!(!types(Key::x, M::CONTROL_MASK));
        assert!(undoes(Key::z, M::CONTROL_MASK));
        assert!(undoes(Key::Z, M::CONTROL_MASK | M::SHIFT_MASK));
        assert!(!undoes(Key::z, M::empty()));
    }

    #[test]
    fn returns_that_submit() {
        use gtk::gdk::ModifierType as M;
        assert!(submits(SubmitBehavior::Submit, M::empty()));
        assert!(submits(SubmitBehavior::BlurAndSubmit, M::CONTROL_MASK));
        assert!(!submits(SubmitBehavior::Submit, M::SHIFT_MASK));
        assert!(!submits(SubmitBehavior::BlurAndSubmit, M::ALT_MASK));
        assert!(!submits(SubmitBehavior::Newline, M::empty()));
    }

    #[test]
    fn families() {
        assert_eq!(css_families("system-ui"), None);
        assert_eq!(css_families("ui-monospace").as_deref(), Some("monospace"));
        assert_eq!(
            css_families("Inter, 'Noto Sans', serif").as_deref(),
            Some("\"Inter\", \"Noto Sans\", serif")
        );
    }

    #[test]
    fn alignment() {
        assert_eq!(xalign(TextAlign::Auto, false), 0.0);
        assert_eq!(xalign(TextAlign::Auto, true), 1.0);
        assert_eq!(xalign(TextAlign::Center, true), 0.5);
    }
}
