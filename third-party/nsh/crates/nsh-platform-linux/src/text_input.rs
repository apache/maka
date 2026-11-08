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
    collections::VecDeque,
    rc::{Rc, Weak},
};

use gtk4::{self as gtk, glib, prelude::*};
use nsh_core::{
    AutoCapitalize, Bounds, EventKind, EventPayload, InputConfig, KeyboardType, PayloadValue,
    Points, ResolvedTextStyle, SubmitBehavior, TextAlign,
    geometry::{Point, Size, point, px, size},
    tailwind::state,
};
use rustc_hash::FxHashMap;

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
    /// Escape was pressed during a composition: cancels it before the
    /// window blurs or navigates.
    cancelling_composition: Cell<bool>,
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

    /// The text scrolled, or its size or the viewport's changed.
    fn scrolled(&self) {
        if let Some((surface, view, input)) = self.get() {
            report_scroll(&surface, &view, &input);
        }
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

    /// Owns the asynchronous paste so reload waits for its event and edit,
    /// including a clipboard owned by another process.
    fn pasting(&self, widget: &gtk::Widget) -> bool {
        let Some((surface, view, input)) = self.get() else {
            return false;
        };
        if (surface.input_paused.get() && !is_replaying(&surface))
            || !input.config.borrow().editable
        {
            return false;
        }
        let reports = view.state().events.contains(EventKind::Paste);
        let inserts = input.config.borrow().paste_behavior == nsh_core::PasteBehavior::Insert;
        if !reports && !inserts {
            return false;
        }
        let generation = surface.admit_paste();
        let weak = Rc::downgrade(&surface);
        let fallback_view = view.downgrade();
        crate::system::read_pasted(widget.clipboard(), move |paste| {
            let Some(surface) = weak.upgrade() else {
                return;
            };
            if !surface.paste_is_current(generation) {
                return;
            }
            if !queue_if_unsettled(&surface, || Held::PasteEvent(paste.clone())) {
                let target = focused_input_view(&surface).or_else(|| fallback_view.upgrade());
                if let Some(target) = target {
                    apply_paste_to_view(&surface, &target, paste);
                }
            }
            surface.finish_paste(generation);
        });
        // The callback above inserts it once; GTK must not read it again.
        false
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
            let cancelled = input.cancelling_composition.replace(false);
            self.composition_ended();
            if cancelled {
                self.flush_composition();
            }
            return;
        }
        input.cancelling_composition.set(false);
        if input.composition.borrow().as_deref() == Some(text) {
            return;
        }
        *input.composition.borrow_mut() = Some(text.to_owned());
        input.set_composing(true);
        self.send_composition(true, text);
    }

    fn cancel_composition(&self) {
        let Some(input) = self.input.upgrade() else {
            return;
        };
        input.cancelling_composition.set(false);
        if input.composition.borrow().is_none() {
            return;
        }
        let editor = input.editor.borrow().clone();
        if let Editor::Area { view, .. } = &editor {
            view.reset_im_context();
        }
        self.composition_ended();
        self.flush_composition();
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
        input.set_composing(false);
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
        enter_changing(&surface);
        self.flush_change();
        if !focused {
            input.cancelling_composition.set(false);
            // GTK resets the input method when the focus leaves.
            self.composition_ended();
        }
        crate::input::set_state(&surface, &view, state::FOCUSED, focused);
        let events_before = surface.events_sent();
        let kind = if focused {
            EventKind::Focus
        } else {
            EventKind::Blur
        };
        self.send(kind, || EventPayload::None);
        if focused {
            if wants_text(&surface) && surface.events_sent() > events_before {
                arm(&surface);
            } else if !has_pending(&surface) {
                disarm(&surface);
            }
            self.selection_changed();
        }
        leave_changing(&surface);
        if focused && !is_changing(&surface) {
            flush_pending(&surface);
        }
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
        if let Some(surface) = self.surface.upgrade() {
            arm(&surface);
        }
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
    /// The placeholder shows while there is no text, nor an input
    /// method's composition (GTK draws its preedit text outside the text).
    fn update_placeholder(&self) {
        let shown = !self.config.borrow().placeholder.is_empty()
            && self.editor.borrow().is_empty()
            && self.composition.borrow().is_none();
        self.placeholder.set_visible(shown);
    }

    /// Marks the editor composing: GTK places its caret at the start of the
    /// preedit text rather than at the input method's cursor in it, so the
    /// caret is hidden until the composition ends (`nsh-composing`, the
    /// input's style sheet), as the candidates show where typing goes.
    fn set_composing(&self, composing: bool) {
        let widget = self.editor.borrow().widget();
        if composing {
            widget.add_css_class("nsh-composing");
        } else {
            widget.remove_css_class("nsh-composing");
        }
        self.update_placeholder();
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
        cancelling_composition: Cell::new(false),
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
            let adjustment = scroller.vadjustment();
            adjustment.connect_value_changed(move |_| c.caret_moved());
            // And moves a built-in bar's thumb, as the text's size does.
            let c = cx.clone();
            adjustment.connect_value_changed(move |_| c.scrolled());
            let c = cx.clone();
            adjustment.connect_changed(move |_| c.scrolled());
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
        // (`navigation::key_pressed`), unless Escape is cancelling an active
        // input-method composition.
        if key == gtk::gdk::Key::Escape {
            if input.composition.borrow().is_some() {
                input.cancelling_composition.set(true);
                return glib::Propagation::Proceed;
            }
            if let Some(surface) = c.surface.upgrade() {
                disarm(&surface);
            }
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

    let bubble_keys = gtk::EventControllerKey::new();
    let c = cx.clone();
    bubble_keys.connect_key_pressed(move |_, key, _, _| {
        if key == gtk::gdk::Key::Escape
            && let Some(input) = c.input.upgrade()
            && input.cancelling_composition.replace(false)
        {
            c.cancel_composition();
            return glib::Propagation::Stop;
        }
        glib::Propagation::Proceed
    });
    widget.add_controller(bubble_keys);
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
pub(crate) fn config(surface: &Rc<Surface>, view: &NshView, config: &InputConfig) {
    let Some(input) = view.state().input.clone() else {
        return;
    };
    let became_readonly = input.config.borrow().editable && !config.editable;
    let multiline = matches!(&*input.editor.borrow(), Editor::Area { .. });
    if config.multiline != multiline {
        let had_auto_focus = input
            .auto_focus
            .borrow_mut()
            .take()
            .map(|(widget, handler)| widget.disconnect(handler))
            .is_some();
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
        } else if had_auto_focus {
            auto_focus(surface, &input, &editor);
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
        Editor::Area { scroller, view } => {
            // A built-in bar of the app's takes the indicator's place.
            let bar = if config.scrollbar_visible {
                gtk::PolicyType::Automatic
            } else {
                gtk::PolicyType::External
            };
            scroller.set_policy(gtk::PolicyType::Never, bar);
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
    if let Editor::Area { view, .. } = &editor {
        set_line_box(view, &config.style);
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
    if became_readonly && input.focused.get() && input.composition.borrow().is_some() {
        if let Editor::Area { view, .. } = &editor {
            view.reset_im_context();
        }
        if let Some(cx) = input.cx.get() {
            cx.composition_ended();
            cx.flush_composition();
        }
    }
    report_scroll(surface, view, &input);
    input.update_placeholder();
    place(view, &input);
    let first = !input.configured.replace(true);
    if first && config.auto_focus {
        auto_focus(surface, &input, &editor);
    }
}

/// Reports how far a multiline input's text scrolled while a built-in bar
/// takes the place of its indicator (`InputConfig::replaced`).
fn report_scroll(surface: &Surface, view: &NshView, input: &InputState) {
    if !input.config.borrow().replaced {
        return;
    }
    let Editor::Area { scroller, .. } = &*input.editor.borrow() else {
        return;
    };
    let v = scroller.vadjustment();
    let width = px(scroller.width() as f32);
    let (offset, upper, page) = (v.value() as f32, v.upper() as f32, v.page_size() as f32);
    surface.control(|c| {
        c.input_scroll(
            view.id(),
            point(Points::ZERO, px(offset)),
            size(width, px(upper.max(page))),
            size(width, px(page)),
        );
    });
}

/// `Command::ScrollTo` for a multiline input: scrolls its text (a built-in
/// bar's drags).
pub(crate) fn scroll_to(view: &NshView, y: Points) {
    let Some(input) = view.state().input.clone() else {
        return;
    };
    if let Editor::Area { scroller, .. } = &*input.editor.borrow() {
        let v = scroller.vadjustment();
        let max = (v.upper() - v.page_size()).max(v.lower());
        v.set_value((y.0 as f64).clamp(v.lower(), max));
    }
}

/// Focuses the editor once it is on screen.
fn auto_focus(surface: &Rc<Surface>, input: &Rc<InputState>, editor: &Editor) {
    let widget = editor.widget();
    if widget.is_mapped() {
        editor.focus();
        return;
    }
    register_auto_focus(surface, input);
    let weak = Rc::downgrade(input);
    let weak_surface = Rc::downgrade(surface);
    let handler = widget.connect_map(move |_| {
        let Some(input) = weak.upgrade() else { return };
        if let Some((widget, handler)) = input.auto_focus.borrow_mut().take() {
            widget.disconnect(handler);
        }
        input.editor.borrow().focus();
        if let Some(surface) = weak_surface.upgrade()
            && !is_changing(&surface)
        {
            flush_pending(&surface);
            maybe_disarm(&surface);
        }
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
            let lift = placeholder_lift(text, label, &input.config.borrow(), width);
            view.set_native(
                label,
                Bounds {
                    origin: Point::new(content.origin.x, content.origin.y + Points(lift as f32)),
                    size: Size::new(content.size.width, content.size.height.max(Points(height))),
                },
            );
            // A field that shows nothing (an editor's own text sink) may be
            // laid out smaller than a character and its line: scrolling to
            // its caret then never settles, and every input method update
            // moves the caret, and the candidates the input method places
            // at it, by a pixel. It gets room for a line of a character or
            // two (more would move its caret off the editor's), and leaves
            // the pointer to what is under it.
            let invisible = {
                let config = input.config.borrow();
                config.caret_hidden && config.style.color.0 & 0xff == 0
            };
            scroller.set_can_target(!invisible);
            let content = if invisible {
                let line = text.create_pango_layout(Some("Ag")).pixel_size().1
                    + text.pixels_above_lines()
                    + text.pixels_below_lines();
                let line = line as f32;
                Bounds {
                    size: Size::new(
                        content.size.width.max(Points(line * 2.0)),
                        content.size.height.max(Points(line + 2.0)),
                    ),
                    ..content
                }
            } else {
                content
            };
            view.set_native(scroller, content);
        }
    }
}

/// Gives a text view's lines the configured height: it ignores CSS's
/// `line-height`. The extra space goes around the text rather than in the
/// line, as the caret is as tall as the text between these pixels: half
/// above and below a line, all of it between a line's wrapped parts.
fn set_line_box(view: &gtk::TextView, style: &ResolvedTextStyle) {
    let layout = view.create_pango_layout(Some("Ag"));
    layout.set_font_description(Some(&crate::text::main_font_description(style)));
    // Rounded as the text view rounds its lines (`pixel_size` rounds up).
    let font = (layout.size().1 as f32 / gtk::pango::SCALE as f32).round() as i32;
    let (above, below) = line_box(style.line_height.0, font);
    view.set_pixels_above_lines(above);
    view.set_pixels_below_lines(below);
    view.set_pixels_inside_wrap(above + below);
}

/// How far to move a multiline placeholder for its first line to stand on
/// the first typed line's baseline. A label's line with a fallback font
/// (CJK in a Latin font) sits lower than the font's own: each run is
/// centered in the line height around its own font, and the line starts at
/// the highest of them. Measured from the config, as the label only takes
/// the style sheet's font and line height on its next frame.
fn placeholder_lift(
    text: &gtk::TextView,
    label: &gtk::Label,
    config: &InputConfig,
    width: i32,
) -> i32 {
    let font = crate::text::main_font_description(&config.style);
    let baseline = |layout: gtk::pango::Layout| {
        layout.set_font_description(Some(&font));
        layout.baseline() as f32 / gtk::pango::SCALE as f32
    };
    let typed = baseline(text.create_pango_layout(Some("Ag")));
    let layout = label.create_pango_layout(Some(&config.placeholder));
    layout.set_width(width.saturating_mul(gtk::pango::SCALE));
    layout.set_wrap(gtk::pango::WrapMode::WordChar);
    if config.style.line_height.0 > 0.0 {
        let attrs = gtk::pango::AttrList::new();
        attrs.insert(gtk::pango::AttrInt::new_line_height_absolute(
            (config.style.line_height.0 * gtk::pango::SCALE as f32) as i32,
        ));
        layout.set_attributes(Some(&attrs));
    }
    (typed + text.pixels_above_lines() as f32 - baseline(layout)).round() as i32
}

/// The whole pixels above and below a line of a font `font` high to make it
/// `line_height` high: none without a line height or if the font is taller.
fn line_box(line_height: f32, font: i32) -> (i32, i32) {
    let extra = (line_height.round() as i32 - font).max(0);
    (extra / 2, extra - extra / 2)
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
         label.nsh-placeholder {{ color: {placeholder}; opacity: 1; }}\n\
         text.nsh-composing, textview.nsh-composing, textview.nsh-composing > text {{ \
         caret-color: transparent; \
         -gtk-secondary-caret-color: transparent; }}\n"
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
            "label.nsh-placeholder {{ line-height: {}px; }}",
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
#[cfg(any(feature = "dev", test))]
pub(crate) fn current_text(view: &NshView) -> Option<String> {
    let input = view.state().input.clone()?;
    let text = input.editor.borrow().text();
    Some(text)
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

/// `focus()` on a non-input view that is a focus stop.
pub(crate) fn focus_view(view: &NshView) {
    let can_focus = {
        let s = view.state();
        s.props.focus_stop(s.events.contains(EventKind::Press))
    };
    if !can_focus {
        return;
    }
    ensure_transient_focusable(view);
    view.grab_focus();
}

/// `blur()`.
pub(crate) fn blur(view: &NshView) {
    let input = view.state().input.clone();
    if let Some(input) = input {
        unfocus(&input.editor.borrow().widget());
    }
}

/// `blur()` on a non-input view.
pub(crate) fn blur_view(view: &NshView) {
    unfocus(view.upcast_ref());
}

/// Unfocuses whatever input or focus stop of the surface has focus.
pub(crate) fn blur_all(surface: &Rc<Surface>) {
    let root = surface.root.upcast_ref::<gtk::Widget>();
    if let Some(window) = root.root()
        && let Some(focus) = window.focus()
        && (focus.is::<gtk::Text>() || focus.is::<gtk::TextView>() || focus.is::<NshView>())
        && (focus == *root || focus.is_ancestor(root))
    {
        window.set_focus(None::<&gtk::Widget>);
    }
    if !has_pending(surface) {
        disarm(surface);
    }
}

/// Reports edits GTK queued for idle before a reload's engine barrier.
pub(crate) fn flush_changes(surface: &Rc<Surface>) {
    let views: Vec<_> = surface.mounter.borrow().views.values().cloned().collect();
    for view in views {
        let input = view.state().input.clone();
        if let Some(input) = input {
            let context = Ctx {
                surface: Rc::downgrade(surface),
                view: view.downgrade(),
                input: Rc::downgrade(&input),
            };
            context.flush_change();
            let ending_composition = input.composition_idle.borrow().is_some();
            if ending_composition {
                context.flush_composition();
            }
        }
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

/// One undoable application edit of the focused input `view`, dropped unless
/// the input still matches what the app saw (`Command::ReplaceRange`).
pub(crate) fn replace_range(view: &NshView, command: &nsh_core::Command) {
    let nsh_core::Command::ReplaceRange {
        range,
        text,
        expected_text,
        expected_selection,
        count,
    } = command
    else {
        return;
    };
    let Some(input) = view.state().input.clone() else {
        return;
    };
    let editor = input.editor.borrow().clone();
    let current = editor.text();
    let (sel_start, sel_end) = editor.selection();
    let observed = char_to_utf16(&current, sel_start.max(0) as usize)
        ..char_to_utf16(&current, sel_end.max(0) as usize);
    if !input.focused.get()
        || !input.config.borrow().editable
        || view.state().props.accessibility.state.disabled
        || input.count.get() != *count
        || input.composition.borrow().is_some()
        || current != *expected_text
        || observed != *expected_selection
        || range.start > range.end
        || !splits_no_character(expected_text, range)
    {
        return;
    }
    let start_char = utf16_to_char(&current, range.start);
    let end_char = utf16_to_char(&current, range.end);
    let start_byte = current
        .char_indices()
        .nth(start_char)
        .map_or(current.len(), |(i, _)| i);
    let end_byte = current
        .char_indices()
        .nth(end_char)
        .map_or(current.len(), |(i, _)| i);
    let kept = utf16_len(&current[..start_byte]) + utf16_len(&current[end_byte..]);
    let fit = match input.config.borrow().max_length {
        Some(max) => clip_utf16(text, (max as usize).saturating_sub(kept)),
        None => text.as_str(),
    };
    if !text.is_empty() && fit.is_empty() {
        return;
    }
    if &current[start_byte..end_byte] == fit {
        let caret = (start_char + fit.chars().count()) as i32;
        editor.select(caret, caret);
        if let Some(cx) = input.cx.get() {
            cx.selection_changed();
        }
        return;
    }
    let start_char = start_char as i32;
    let end_char = end_char as i32;
    input.pasting.set(true);
    match &editor {
        Editor::Line(field) => {
            field.delete_text(start_char, end_char);
            let mut pos = start_char;
            if !fit.is_empty() {
                field.insert_text(fit, &mut pos);
            }
            field.set_position(pos);
        }
        Editor::Area { view, .. } => {
            let buffer = view.buffer();
            buffer.begin_user_action();
            let mut start_iter = buffer.iter_at_offset(start_char);
            let mut end_iter = buffer.iter_at_offset(end_char);
            buffer.delete(&mut start_iter, &mut end_iter);
            buffer.place_cursor(&start_iter);
            if !fit.is_empty() {
                buffer.insert_at_cursor(fit);
            }
            buffer.end_user_action();
        }
    }
    input.pasting.set(false);
    if let Some(cx) = input.cx.get() {
        cx.flush_change();
        cx.selection_changed();
    }
}

fn splits_no_character(text: &str, range: &std::ops::Range<u32>) -> bool {
    let mut offset = 0;
    let mut ends = 0;
    for c in text.chars() {
        ends += usize::from(offset == range.start) + usize::from(offset == range.end);
        offset += c.len_utf16() as u32;
    }
    ends += usize::from(offset == range.start) + usize::from(offset == range.end);
    ends == 2
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

// --- Focus fence & held input -----------------------------------------------

#[derive(Default)]
struct Focus {
    changing: usize,
    replaying: bool,
    armed: bool,
    after: u64,
    pending: VecDeque<Held>,
    auto_focus: Vec<Weak<InputState>>,
}

enum Held {
    GdkKey {
        key: gtk::gdk::Key,
        modifiers: gtk::gdk::ModifierType,
        event: Option<gtk::gdk::Event>,
    },
    PasteEvent(nsh_core::PasteEvent),
    #[cfg(any(feature = "dev", test))]
    Keystroke(nsh_core::keymap::Keystroke),
    #[cfg(any(feature = "dev", test))]
    Text(String),
    #[cfg(any(feature = "dev", test))]
    Enter,
    #[cfg(any(feature = "dev", test))]
    Backspace,
    #[cfg(any(feature = "dev", test))]
    SelectAll,
}

thread_local! {
    static FOCUS: RefCell<FxHashMap<u64, Focus>> = RefCell::default();
    static TRANSIENT_FOCUS: RefCell<Vec<glib::WeakRef<NshView>>> = const { RefCell::new(Vec::new()) };
}

fn ensure_transient_focusable(view: &NshView) {
    view.set_focusable(true);
    let already = TRANSIENT_FOCUS.with(|list| {
        let mut list = list.borrow_mut();
        list.retain(|w| w.upgrade().is_some());
        if list.iter().any(|w| w.upgrade().as_ref() == Some(view)) {
            true
        } else {
            list.push(view.downgrade());
            false
        }
    });
    if !already {
        let focus = gtk::EventControllerFocus::new();
        focus.connect_leave(|c| {
            if let Some(view) = c.widget().and_downcast::<NshView>()
                && !view.has_focus()
                && view.kind() == nsh_core::ViewKind::View
                && crate::selectable_view::area_of(&view).as_ref() != Some(&view)
            {
                view.set_focusable(false);
            }
        });
        view.add_controller(focus);
    }
}

/// Intercepts window-level GDK key presses while an engine event that can move
/// focus is still in flight.
pub(crate) fn install_keyboard(surface: &Rc<Surface>) {
    let weak = Rc::downgrade(surface);
    let installed = RefCell::new(glib::WeakRef::<gtk::Window>::new());
    surface.root.connect_realize(move |root| {
        let Some(window) = root.root().and_downcast::<gtk::Window>() else {
            return;
        };
        if installed.borrow().upgrade().as_ref() == Some(&window) {
            return;
        }
        installed.borrow().set(Some(&window));
        let keys = gtk::EventControllerKey::new();
        keys.set_propagation_phase(gtk::PropagationPhase::Capture);
        let pressed = weak.clone();
        keys.connect_key_pressed(move |keys, key, _, modifiers| match pressed.upgrade() {
            Some(surface) if surface.input_paused.get() => glib::Propagation::Stop,
            Some(surface) if hold_gdk_key(&surface, key, modifiers, keys.current_event()) => {
                glib::Propagation::Stop
            }
            _ => glib::Propagation::Proceed,
        });
        window.add_controller(keys);
    });
}

pub(crate) fn hold_shortcut_event(surface: &Rc<Surface>, event: &gtk::gdk::Event) -> bool {
    let Some(key_event) = event.downcast_ref::<gtk::gdk::KeyEvent>() else {
        return false;
    };
    hold_gdk_key(
        surface,
        key_event.keyval(),
        event.modifier_state(),
        Some(event.clone()),
    )
}

fn hold_gdk_key(
    surface: &Rc<Surface>,
    key: gtk::gdk::Key,
    modifiers: gtk::gdk::ModifierType,
    event: Option<gtk::gdk::Event>,
) -> bool {
    if is_modifier_key(key) {
        return false;
    }
    let mods = modifiers
        & (gtk::gdk::ModifierType::CONTROL_MASK
            | gtk::gdk::ModifierType::ALT_MASK
            | gtk::gdk::ModifierType::SHIFT_MASK
            | gtk::gdk::ModifierType::SUPER_MASK);
    if key == gtk::gdk::Key::Escape && mods.is_empty() {
        if !composing_focused(surface) {
            disarm(surface);
        }
        return false;
    }
    queue_if_unsettled(surface, || Held::GdkKey {
        key,
        modifiers,
        event,
    })
}

fn is_modifier_key(key: gtk::gdk::Key) -> bool {
    use gtk::gdk::Key as K;
    matches!(
        key,
        K::Shift_L
            | K::Shift_R
            | K::Control_L
            | K::Control_R
            | K::Alt_L
            | K::Alt_R
            | K::Meta_L
            | K::Meta_R
            | K::Super_L
            | K::Super_R
            | K::Hyper_L
            | K::Hyper_R
            | K::ISO_Level3_Shift
            | K::ISO_Level5_Shift
            | K::Caps_Lock
            | K::Shift_Lock
            | K::Num_Lock
            | K::Scroll_Lock
    )
}

fn enter_changing(surface: &Surface) {
    FOCUS.with(|f| {
        f.borrow_mut().entry(surface.key()).or_default().changing += 1;
    });
}

fn leave_changing(surface: &Surface) {
    FOCUS.with(|f| {
        if let Some(focus) = f.borrow_mut().get_mut(&surface.key()) {
            focus.changing = focus.changing.saturating_sub(1);
        }
    });
}

fn is_changing(surface: &Surface) -> bool {
    FOCUS.with(|f| {
        f.borrow()
            .get(&surface.key())
            .is_some_and(|focus| focus.changing > 0)
    })
}

pub(crate) fn is_replaying(surface: &Surface) -> bool {
    FOCUS.with(|f| {
        f.borrow()
            .get(&surface.key())
            .is_some_and(|focus| focus.replaying)
    })
}

pub(crate) fn begin_batch(surface: &Surface) {
    enter_changing(surface);
}

pub(crate) fn end_batch(surface: &Rc<Surface>) {
    leave_changing(surface);
    if is_armed(surface) && !is_changing(surface) && !behind(surface) {
        flush_pending(surface);
        maybe_disarm(surface);
    }
}

pub(crate) fn arm(surface: &Surface) {
    let after = surface.events_sent();
    FOCUS.with(|f| {
        let mut map = f.borrow_mut();
        let focus = map.entry(surface.key()).or_default();
        focus.armed = true;
        focus.after = after;
    });
}

pub(crate) fn disarm(surface: &Surface) {
    FOCUS.with(|f| {
        if let Some(focus) = f.borrow_mut().get_mut(&surface.key()) {
            focus.pending.clear();
            focus.armed = false;
        }
    });
}

fn maybe_disarm(surface: &Surface) {
    if !behind(surface)
        && !has_pending(surface)
        && !has_pending_auto_focus(surface)
        && !is_changing(surface)
    {
        disarm(surface);
    }
}

fn is_armed(surface: &Surface) -> bool {
    FOCUS.with(|f| {
        f.borrow()
            .get(&surface.key())
            .is_some_and(|focus| focus.changing > 0 || focus.armed)
    })
}

pub(crate) fn has_pending(surface: &Surface) -> bool {
    FOCUS.with(|f| {
        f.borrow()
            .get(&surface.key())
            .is_some_and(|focus| !focus.pending.is_empty())
    })
}

fn register_auto_focus(surface: &Surface, input: &Rc<InputState>) {
    FOCUS.with(|f| {
        let mut map = f.borrow_mut();
        let focus = map.entry(surface.key()).or_default();
        focus.auto_focus.retain(|w| w.upgrade().is_some());
        focus.auto_focus.push(Rc::downgrade(input));
    });
}

pub(crate) fn has_pending_auto_focus(surface: &Surface) -> bool {
    FOCUS.with(|f| {
        f.borrow().get(&surface.key()).is_some_and(|focus| {
            focus.auto_focus.iter().any(|weak| {
                weak.upgrade()
                    .is_some_and(|input| input.auto_focus.borrow().is_some())
            })
        })
    })
}

fn behind(surface: &Surface) -> bool {
    let after = FOCUS.with(|f| f.borrow().get(&surface.key()).map_or(0, |f| f.after));
    surface.events_handled() < after
}

pub(crate) fn engine_caught_up(surface: &Rc<Surface>) {
    if is_armed(surface) && !is_changing(surface) && !behind(surface) {
        flush_pending(surface);
        maybe_disarm(surface);
    }
}

pub(crate) fn stopped(surface: &Surface) {
    FOCUS.with(|f| {
        f.borrow_mut().remove(&surface.key());
    });
}

pub(crate) fn disposed(key: u64) {
    let _ = FOCUS.try_with(|f| {
        f.borrow_mut().remove(&key);
    });
}

fn cancel_auto_focus(view: &NshView) {
    let input = view.state().input.clone();
    if let Some(input) = input
        && let Some((widget, handler)) = input.auto_focus.borrow_mut().take()
    {
        widget.disconnect(handler);
    }
    for child in view.child_views() {
        cancel_auto_focus(&child);
    }
}

pub(crate) fn removing(surface: &Surface, view: &NshView) {
    cancel_auto_focus(view);
    if let Some(focused) = focused_input_view(surface)
        && (focused == *view || focused.is_ancestor(view))
    {
        enter_changing(surface);
        blur(&focused);
        arm(surface);
        leave_changing(surface);
    }
}

fn focused_input_view(surface: &Surface) -> Option<NshView> {
    let root = surface.root.upcast_ref::<gtk::Widget>();
    let mut focus = root.root()?.focus()?;
    if !(focus == *root || focus.is_ancestor(root)) {
        return None;
    }
    loop {
        if let Some(view) = focus.downcast_ref::<NshView>()
            && view.state().input.is_some()
        {
            return Some(view.clone());
        }
        if focus == *root {
            return None;
        }
        focus = focus.parent()?;
    }
}

fn wants_text(surface: &Surface) -> bool {
    focused_input_view(surface)
        .and_then(|view| view.state().input.clone())
        .is_some_and(|input| input.config.borrow().editable)
}

pub(crate) fn composing_focused(surface: &Surface) -> bool {
    focused_input_view(surface)
        .and_then(|view| view.state().input.clone())
        .is_some_and(|input| input.composition.borrow().is_some())
}

pub(crate) fn escape_composing(surface: &Surface) -> bool {
    let Some(view) = focused_input_view(surface) else {
        return false;
    };
    let Some(input) = view.state().input.clone() else {
        return false;
    };
    if input.composition.borrow().is_none() {
        return false;
    }
    if let Some(cx) = input.cx.get() {
        cx.cancel_composition();
    }
    true
}

fn queue_if_unsettled(surface: &Surface, operation: impl FnOnce() -> Held) -> bool {
    if is_replaying(surface) || !is_armed(surface) {
        return false;
    }
    if !is_changing(surface)
        && !has_pending(surface)
        && !has_pending_auto_focus(surface)
        && !behind(surface)
    {
        disarm(surface);
        return false;
    }
    FOCUS.with(|f| {
        f.borrow_mut()
            .entry(surface.key())
            .or_default()
            .pending
            .push_back(operation());
    });
    true
}

fn flush_pending(surface: &Rc<Surface>) {
    if is_replaying(surface) {
        return;
    }
    FOCUS.with(|f| {
        f.borrow_mut().entry(surface.key()).or_default().replaying = true;
    });
    loop {
        if behind(surface) || has_pending_auto_focus(surface) || is_changing(surface) {
            break;
        }
        let next = FOCUS.with(|f| {
            f.borrow_mut()
                .get_mut(&surface.key())
                .and_then(|focus| focus.pending.pop_front())
        });
        let Some(next) = next else {
            break;
        };
        let needs_editable = match &next {
            Held::PasteEvent(_) => true,
            Held::GdkKey { .. } => false,
            #[cfg(any(feature = "dev", test))]
            Held::Text(_) | Held::Enter | Held::Backspace | Held::SelectAll => true,
            #[cfg(any(feature = "dev", test))]
            Held::Keystroke(_) => false,
        };
        if needs_editable && !wants_text(surface) {
            if is_armed(surface) {
                FOCUS.with(|f| {
                    f.borrow_mut()
                        .entry(surface.key())
                        .or_default()
                        .pending
                        .push_front(next);
                });
            }
            break;
        }
        match next {
            Held::GdkKey {
                key,
                modifiers,
                event,
            } => replay_gdk_key(surface, key, modifiers, event),
            Held::PasteEvent(paste) => {
                if let Some(view) = focused_input_view(surface) {
                    apply_paste_to_view(surface, &view, paste);
                }
            }
            #[cfg(any(feature = "dev", test))]
            Held::Keystroke(stroke) => press_keystroke_now(surface, stroke),
            #[cfg(any(feature = "dev", test))]
            Held::Text(text) => type_text_now(surface, &text),
            #[cfg(any(feature = "dev", test))]
            Held::Enter => enter_now(surface),
            #[cfg(any(feature = "dev", test))]
            Held::Backspace => backspace_now(surface),
            #[cfg(any(feature = "dev", test))]
            Held::SelectAll => select_all_now(surface),
        }
    }
    FOCUS.with(|f| {
        if let Some(focus) = f.borrow_mut().get_mut(&surface.key()) {
            focus.replaying = false;
        }
    });
}

fn apply_paste_to_view(surface: &Rc<Surface>, view: &NshView, paste: nsh_core::PasteEvent) {
    let Some(input) = view.state().input.clone() else {
        return;
    };
    if !input.config.borrow().editable {
        return;
    }
    let reports = view.state().events.contains(EventKind::Paste);
    let inserts = input.config.borrow().paste_behavior == nsh_core::PasteBehavior::Insert;
    let text = inserts.then(|| paste.text.clone());
    if reports {
        surface.event(
            view.id(),
            EventKind::Paste,
            EventPayload::Paste(Box::new(paste)),
        );
    }
    if let Some(text) = text.filter(|text| !text.is_empty()) {
        input.pasting.set(true);
        let editor = input.editor.borrow().clone();
        match editor {
            Editor::Line(field) => {
                let (start, end) = field.selection_bounds().unwrap_or_else(|| {
                    let position = field.position();
                    (position, position)
                });
                field.delete_text(start, end);
                let mut position = start;
                field.insert_text(&text, &mut position);
                field.set_position(position);
            }
            Editor::Area { view, .. } => {
                let buffer = view.buffer();
                buffer.begin_user_action();
                buffer.delete_selection(true, true);
                buffer.insert_at_cursor(&text);
                buffer.end_user_action();
            }
        }
        input.pasting.set(false);
        if let Some(cx) = input.cx.get() {
            cx.flush_change();
        }
    }
}

fn replay_gdk_key(
    surface: &Rc<Surface>,
    key: gtk::gdk::Key,
    modifiers: gtk::gdk::ModifierType,
    event: Option<gtk::gdk::Event>,
) {
    if let Some(ref event) = event
        && crate::keymap::press_gdk(surface, event)
    {
        return;
    }
    if dispatch_editor_key(surface, key, modifiers) {
        return;
    }
    if crate::scroll::key_pressed(surface, key, modifiers)
        || crate::navigation::key_pressed(surface, key, modifiers)
    {
        return;
    }
    let _ = crate::keymap::unhandled(surface, event.as_ref());
}

fn dispatch_editor_key(
    surface: &Rc<Surface>,
    key: gtk::gdk::Key,
    modifiers: gtk::gdk::ModifierType,
) -> bool {
    let Some(view) = focused_input_view(surface) else {
        return false;
    };
    let Some(input) = view.state().input.clone() else {
        return false;
    };
    let Some(cx) = input.cx.get().cloned() else {
        return false;
    };
    let (editable, submit) = {
        let config = input.config.borrow();
        (config.editable, config.submit())
    };
    let m = modifiers
        & (gtk::gdk::ModifierType::CONTROL_MASK
            | gtk::gdk::ModifierType::ALT_MASK
            | gtk::gdk::ModifierType::SUPER_MASK);
    if key == gtk::gdk::Key::Escape {
        if input.composition.borrow().is_some() {
            cx.cancel_composition();
            return true;
        }
        disarm(surface);
        cx.key_press("Escape");
        return false;
    }
    if m == gtk::gdk::ModifierType::CONTROL_MASK && key.to_lower() == gtk::gdk::Key::a {
        select_all_in(&input);
        return true;
    }
    if (m == gtk::gdk::ModifierType::CONTROL_MASK && key.to_lower() == gtk::gdk::Key::v)
        || (modifiers
            & (gtk::gdk::ModifierType::CONTROL_MASK
                | gtk::gdk::ModifierType::ALT_MASK
                | gtk::gdk::ModifierType::SHIFT_MASK
                | gtk::gdk::ModifierType::SUPER_MASK)
            == gtk::gdk::ModifierType::SHIFT_MASK
            && key == gtk::gdk::Key::Insert)
    {
        let widget = input.editor.borrow().widget();
        let _ = cx.pasting(&widget);
        return true;
    }
    if !editable {
        return false;
    }
    if is_return(key) && m.is_empty() {
        enter_in(&input, &cx, submit, modifiers);
        return true;
    }
    if key == gtk::gdk::Key::BackSpace && m.is_empty() {
        backspace_in(&input, &cx);
        return true;
    }
    if matches!(key, gtk::gdk::Key::Delete | gtk::gdk::Key::KP_Delete) && m.is_empty() {
        delete_forward_in(&input);
        return true;
    }
    if types(key, modifiers)
        && let Some(ch) = key.to_unicode().filter(|c| !c.is_control())
    {
        input.key.set(Some((key, modifiers)));
        insert_typed_in(&input, &ch.to_string());
        input.key.set(None);
        return true;
    }
    false
}

fn insert_typed_in(input: &InputState, text: &str) {
    let editor = input.editor.borrow().clone();
    match editor {
        Editor::Line(t) => {
            let (start, end) = t.selection_bounds().unwrap_or_else(|| {
                let p = t.position();
                (p, p)
            });
            if start != end {
                t.delete_text(start, end);
            }
            let mut pos = start;
            t.insert_text(text, &mut pos);
            t.set_position(pos);
        }
        Editor::Area { view, .. } => {
            let b = view.buffer();
            b.delete_selection(true, true);
            b.insert_interactive_at_cursor(text, true);
        }
    }
}

fn select_all_in(input: &InputState) {
    let editor = input.editor.borrow().clone();
    match editor {
        Editor::Line(t) => t.select_region(0, -1),
        Editor::Area { view, .. } => {
            let b = view.buffer();
            b.select_range(&b.start_iter(), &b.end_iter());
        }
    }
}

fn enter_in(
    input: &InputState,
    cx: &Ctx,
    submit: SubmitBehavior,
    modifiers: gtk::gdk::ModifierType,
) {
    let editor = input.editor.borrow().clone();
    match editor {
        Editor::Line(t) => {
            t.emit_by_name::<()>("activate", &[]);
        }
        Editor::Area { view, .. } => {
            if submits(submit, modifiers) {
                cx.submitted();
            } else {
                let b = view.buffer();
                input.key.set(Some((gtk::gdk::Key::Return, modifiers)));
                b.delete_selection(true, true);
                b.insert_interactive_at_cursor("\n", true);
                input.key.set(None);
            }
        }
    }
}

fn backspace_in(input: &InputState, cx: &Ctx) {
    let editor = input.editor.borrow().clone();
    if editor.is_empty() {
        cx.key_press("Backspace");
        return;
    }
    match editor {
        Editor::Line(t) => t.emit_by_name::<()>("backspace", &[]),
        Editor::Area { view, .. } => view.emit_by_name::<()>("backspace", &[]),
    }
}

fn delete_forward_in(input: &InputState) {
    let editor = input.editor.borrow().clone();
    match editor {
        Editor::Line(t) => {
            t.emit_by_name::<()>("delete-from-cursor", &[&gtk::DeleteType::Chars, &1i32]);
        }
        Editor::Area { view, .. } => {
            view.emit_by_name::<()>("delete-from-cursor", &[&gtk::DeleteType::Chars, &1i32]);
        }
    }
}

#[cfg(any(feature = "dev", test))]
pub(crate) fn type_text_on(surface: &Rc<Surface>, text: &str) {
    let owned = text.to_owned();
    if queue_if_unsettled(surface, || Held::Text(owned)) {
        return;
    }
    type_text_now(surface, text);
}

#[cfg(any(feature = "dev", test))]
fn key_from_char(ch: char) -> gtk::gdk::Key {
    if ch == '\n' {
        return gtk::gdk::Key::Return;
    }
    let keyval = gtk::gdk::unicode_to_keyval(u32::from(ch));
    // SAFETY: `gdk::Key` is a transparent `u32` keyval wrapper (`Key(u32)`),
    // and `gdk_unicode_to_keyval` returns the GDK keyval for `ch`.
    unsafe { glib::translate::from_glib(keyval) }
}

#[cfg(any(feature = "dev", test))]
fn type_text_now(surface: &Surface, text: &str) {
    let Some(view) = focused_input_view(surface) else {
        log::warn!("test: no focused text field to type into");
        return;
    };
    let Some(input) = view.state().input.clone() else {
        return;
    };
    if !input.config.borrow().editable {
        return;
    }
    if let Some(ch) = text.chars().next() {
        input
            .key
            .set(Some((key_from_char(ch), gtk::gdk::ModifierType::empty())));
    }
    insert_typed_in(&input, text);
    input.key.set(None);
}

#[cfg(any(feature = "dev", test))]
pub(crate) fn enter_on(surface: &Rc<Surface>) {
    if queue_if_unsettled(surface, || Held::Enter) {
        return;
    }
    enter_now(surface);
}

#[cfg(any(feature = "dev", test))]
fn enter_now(surface: &Surface) {
    let Some(view) = focused_input_view(surface) else {
        log::warn!("test: no focused text field to press Return in");
        return;
    };
    let Some(input) = view.state().input.clone() else {
        return;
    };
    let (editable, submit) = {
        let config = input.config.borrow();
        (config.editable, config.submit())
    };
    if !editable {
        return;
    }
    if let Some(cx) = input.cx.get() {
        enter_in(&input, cx, submit, gtk::gdk::ModifierType::empty());
    }
}

#[cfg(any(feature = "dev", test))]
pub(crate) fn backspace_on(surface: &Rc<Surface>) {
    if queue_if_unsettled(surface, || Held::Backspace) {
        return;
    }
    backspace_now(surface);
}

#[cfg(any(feature = "dev", test))]
fn backspace_now(surface: &Surface) {
    let Some(view) = focused_input_view(surface) else {
        log::warn!("test: no focused text field to press Backspace in");
        return;
    };
    let Some(input) = view.state().input.clone() else {
        return;
    };
    if !input.config.borrow().editable {
        return;
    }
    if let Some(cx) = input.cx.get() {
        backspace_in(&input, cx);
    }
}

#[cfg(any(feature = "dev", test))]
pub(crate) fn select_all_on(surface: &Rc<Surface>) {
    if queue_if_unsettled(surface, || Held::SelectAll) {
        return;
    }
    select_all_now(surface);
}

#[cfg(any(feature = "dev", test))]
fn select_all_now(surface: &Surface) {
    let Some(view) = focused_input_view(surface) else {
        log::warn!("test: no focused text field to select in");
        return;
    };
    if let Some(input) = view.state().input.clone() {
        select_all_in(&input);
    }
}

#[cfg(any(feature = "dev", test))]
pub(crate) fn paste_into_focused(
    surface: &Rc<Surface>,
    content: nsh_core::PasteEvent,
) -> Result<(), String> {
    if queue_if_unsettled(surface, || Held::PasteEvent(content.clone())) {
        return Ok(());
    }
    let view = focused_input_view(surface).ok_or("no focused input to paste into")?;
    apply_paste_to_view(surface, &view, content);
    Ok(())
}

#[cfg(any(feature = "dev", test))]
pub(crate) fn press_keystroke(surface: &Rc<Surface>, stroke: nsh_core::keymap::Keystroke) {
    let m = stroke.modifiers;
    if stroke.key == nsh_core::keymap::Key::Escape && !(m.ctrl || m.alt || m.shift || m.cmd) {
        if !composing_focused(surface) {
            disarm(surface);
        }
        press_keystroke_now(surface, stroke);
        return;
    }
    if queue_if_unsettled(surface, || Held::Keystroke(stroke)) {
        return;
    }
    press_keystroke_now(surface, stroke);
}

#[cfg(any(feature = "dev", test))]
fn press_keystroke_now(surface: &Rc<Surface>, stroke: nsh_core::keymap::Keystroke) {
    use gtk::gdk;
    use nsh_core::keymap::Key as K;
    if crate::keymap::press(surface, stroke) {
        return;
    }
    let m = stroke.modifiers;
    let plain = !(m.ctrl || m.alt || m.cmd);
    let mut modifiers = gdk::ModifierType::empty();
    for (on, mask) in [
        (m.ctrl, gdk::ModifierType::CONTROL_MASK),
        (m.alt, gdk::ModifierType::ALT_MASK),
        (m.shift, gdk::ModifierType::SHIFT_MASK),
        (m.cmd, gdk::ModifierType::SUPER_MASK),
    ] {
        if on {
            modifiers |= mask;
        }
    }
    match stroke.key {
        K::Enter if plain && wants_text(surface) => {
            enter_now(surface);
            return;
        }
        K::Backspace if plain && wants_text(surface) => {
            backspace_now(surface);
            return;
        }
        K::Delete if plain && wants_text(surface) => {
            if let Some(view) = focused_input_view(surface)
                && let Some(input) = view.state().input.clone()
            {
                delete_forward_in(&input);
            }
            return;
        }
        K::Char('a') if m.ctrl && !m.alt && !m.cmd && focused_input_view(surface).is_some() => {
            select_all_now(surface);
            return;
        }
        K::Char(c) if plain && wants_text(surface) => {
            let c = if m.shift { shifted_us(c) } else { c };
            type_text_now(surface, &c.to_string());
            return;
        }
        K::Escape => {
            if let Some(view) = focused_input_view(surface)
                && let Some(input) = view.state().input.clone()
            {
                if input.composition.borrow().is_some() {
                    if let Some(cx) = input.cx.get() {
                        cx.cancel_composition();
                    }
                    return;
                }
                disarm(surface);
                if let Some(cx) = input.cx.get() {
                    cx.key_press("Escape");
                }
            }
            if crate::navigation::key_pressed(surface, gdk::Key::Escape, modifiers) {
                return;
            }
        }
        _ => {
            let gdk_key = match stroke.key {
                K::Up => Some(gdk::Key::Up),
                K::Down => Some(gdk::Key::Down),
                K::Left => Some(gdk::Key::Left),
                K::Right => Some(gdk::Key::Right),
                K::PageUp => Some(gdk::Key::Page_Up),
                K::PageDown => Some(gdk::Key::Page_Down),
                K::Home => Some(gdk::Key::Home),
                K::End => Some(gdk::Key::End),
                K::Char(' ') => Some(gdk::Key::space),
                _ => None,
            };
            if let Some(key) = gdk_key
                && (crate::scroll::key_pressed(surface, key, modifiers)
                    || crate::navigation::key_pressed(surface, key, modifiers))
            {
                return;
            }
        }
    }
    let _ = crate::keymap::press_fallback(surface, stroke);
}

#[cfg(any(feature = "dev", test))]
fn shifted_us(c: char) -> char {
    const PAIRS: [(char, char); 21] = [
        ('1', '!'),
        ('2', '@'),
        ('3', '#'),
        ('4', '$'),
        ('5', '%'),
        ('6', '^'),
        ('7', '&'),
        ('8', '*'),
        ('9', '('),
        ('0', ')'),
        ('-', '_'),
        ('=', '+'),
        ('[', '{'),
        (']', '}'),
        ('\\', '|'),
        (';', ':'),
        ('\'', '"'),
        (',', '<'),
        ('.', '>'),
        ('/', '?'),
        ('`', '~'),
    ];
    PAIRS
        .iter()
        .find(|(plain, _)| *plain == c)
        .map_or(c.to_ascii_uppercase(), |(_, up)| *up)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_boxes() {
        assert_eq!(line_box(24.0, 18), (3, 3));
        assert_eq!(line_box(25.0, 18), (3, 4));
        assert_eq!(line_box(0.0, 18), (0, 0));
        assert_eq!(line_box(12.0, 18), (0, 0));
    }

    /// The caret is the font's height, centered in a line of the configured
    /// height.
    #[test]
    fn a_line_height_keeps_the_caret_at_the_fonts_height() {
        crate::gtk_test::run(|| {
            let view = gtk::TextView::new();
            view.buffer().set_text("one\ntwo");
            let style = ResolvedTextStyle {
                font_size: Points(15.0),
                line_height: Points(24.0),
                ..Default::default()
            };
            // The text view's own font, as `css` gives it: the line box is
            // measured for it, and the theme's may be another height.
            let provider = gtk::CssProvider::new();
            provider.load_from_string("textview { font-size: 15px; }");
            add_provider(&view, &provider);
            set_line_box(&view, &style);
            let window = gtk::Window::new();
            window.set_child(Some(&view));
            window.present();
            crate::gtk_test::wait_until(|| view.height() > 0);
            let buffer = view.buffer();
            let (first, _) = view.cursor_locations(Some(&buffer.start_iter()));
            let (second, _) = view.cursor_locations(Some(&buffer.end_iter()));
            window.destroy();
            assert_eq!(second.y() - first.y(), 24);
            assert!(first.height() < 24, "caret {}", first.height());
            assert_eq!(first.y(), (24 - first.height()) / 2);
        });
    }

    /// Whether `view` draws something red: the caret of the test below.
    fn draws_red(window: &gtk::Window, view: &gtk::TextView) -> bool {
        let paintable = gtk::WidgetPaintable::new(Some(view));
        let snapshot = gtk::Snapshot::new();
        let (w, h) = (view.width() as f32, view.height() as f32);
        paintable.snapshot(&snapshot, f64::from(w), f64::from(h));
        let bounds = gtk::graphene::Rect::new(0.0, 0.0, w, h);
        let Some(node) = snapshot.to_node() else {
            return false;
        };
        let texture = window
            .renderer()
            .expect("a shown window has a renderer")
            .render_texture(&node, Some(&bounds));
        let mut downloader = gtk::gdk::TextureDownloader::new(&texture);
        downloader.set_format(gtk::gdk::MemoryFormat::R8g8b8a8Premultiplied);
        let (bytes, _) = downloader.download_bytes();
        bytes
            .as_chunks::<4>()
            .0
            .iter()
            .any(|p| p[0] > 160 && p[1] < 80 && p[2] < 80 && p[3] > 160)
    }

    /// GTK draws an area's caret at the start of the preedit text.
    #[test]
    fn a_composing_area_hides_its_caret() {
        crate::gtk_test::run(|| {
            let view = gtk::TextView::new();
            view.buffer().set_text("one");
            let config = InputConfig {
                caret_color: Some(nsh_core::Color(0xff0000ff)),
                ..Default::default()
            };
            let provider = gtk::CssProvider::new();
            provider.load_from_string(&css(&config));
            add_provider(&view, &provider);
            let window = gtk::Window::new();
            window.set_child(Some(&view));
            window.present();
            crate::gtk_test::wait_until(|| view.height() > 0);
            view.grab_focus();
            view.set_cursor_visible(true);
            let shown = crate::gtk_test::wait_until(|| draws_red(&window, &view));
            view.add_css_class("nsh-composing");
            // The caret blinks: it has to stay away for longer than a blink.
            let settled = std::time::Instant::now() + std::time::Duration::from_millis(200);
            crate::gtk_test::wait_until(|| std::time::Instant::now() >= settled);
            let until = std::time::Instant::now() + std::time::Duration::from_millis(2500);
            let mut hidden = true;
            crate::gtk_test::wait_until(|| {
                hidden &= !draws_red(&window, &view);
                std::time::Instant::now() >= until
            });
            window.destroy();
            assert!(shown, "the caret shows before composing");
            assert!(hidden, "the caret hides while composing");
        });
    }

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

    #[cfg(feature = "js")]
    fn start_js_app(
        source: &str,
    ) -> (
        gtk::Window,
        Rc<crate::AppView>,
        crossbeam_channel::Receiver<serde_json::Value>,
    ) {
        let (tx, rx) = crossbeam_channel::unbounded();
        let view = crate::AppView::new(crate::AppOptions::default());
        view.host().handle("log", move |mut call| {
            let _ = tx.send(call.take_data());
        });
        let mut bundle = nsh_engine::Bundle::source(source.into());
        bundle.policy.declared = Some(
            nsh_core::access::Capabilities::from_json(&serde_json::json!({ "host": true }))
                .expect("capabilities"),
        );
        let window = gtk::Window::new();
        window.set_default_size(320, 240);
        window.set_child(Some(&view.widget()));
        window.present();
        view.load(nsh_engine::App::Js(bundle));
        (window, view, rx)
    }

    #[cfg(feature = "js")]
    #[test]
    fn focus_scoped_and_fallback_keybindings() {
        crate::gtk_test::run(|| {
            use nsh_core::{keymap::Keystroke, platform::Os};
            let (window, view, rx) = start_js_app(
                r#"import { host, keymap, mount } from "nsh";
                import { append, element, prop } from "nsh:rt";
                const root = element("view");
                prop(root, "style", { width: 300, height: 220 });
                const scopeA = element("view");
                prop(scopeA, "style", { width: 280, height: 40 });
                const inputA = element("input");
                prop(inputA, "testID", "input-a");
                prop(inputA, "style", { width: 200, height: 32 });
                prop(inputA, "value", "alpha");
                prop(inputA, "autoFocus", true);
                append(scopeA, inputA);

                const scopeB = element("view");
                prop(scopeB, "style", { width: 280, height: 40 });
                const inputB = element("input");
                prop(inputB, "testID", "input-b");
                prop(inputB, "style", { width: 200, height: 32 });
                prop(inputB, "value", "b😀ta");
                prop(inputB, "maxLength", 6);
                prop(inputB, "onChange", (e) => host.post("log", `b:${e.value}`));
                append(scopeB, inputB);

                const stopScope = element("view");
                prop(stopScope, "style", { width: 280, height: 40 });
                const stop = element("view");
                prop(stop, "testID", "stop");
                prop(stop, "focusable", true);
                prop(stop, "style", { width: 120, height: 28 });
                append(stopScope, stop);

                append(root, scopeA);
                append(root, scopeB);
                append(root, stopScope);

                keymap.bind("f5", () => inputB.replaceRange({
                  start: 1,
                  end: 3,
                  text: "WXYZ",
                  expectedText: "b😀ta",
                  expectedSelection: { start: 5, end: 5 },
                }), { when: "always", within: scopeB });
                keymap.bind("f6", () => host.post("log", "root"), { when: "always" });
                keymap.bind("f6", () => host.post("log", "scope:a"), { when: "always", within: scopeA });
                keymap.bind("f6", () => host.post("log", "scope:b"), { when: "always", within: scopeB });
                keymap.bind("f7", () => inputB.focus(), { when: "always" });
                keymap.bind("f8", () => stop.focus(), { when: "always" });
                keymap.bind("d", () => host.post("log", "stop:d"), { when: "notEditing", within: stopScope });
                keymap.bind("down", () => host.post("log", "fallback:down"), { when: "always", fallback: true });
                keymap.bind("backspace", () => host.post("log", "fallback:backspace"), { when: "always", fallback: true });

                mount(() => root);
                host.post("log", "mounted");"#,
            );
            let surface = view.surface().clone();
            let mut logs = Vec::new();
            let drain_logs = |logs: &mut Vec<String>| {
                while let Ok(v) = rx.try_recv() {
                    if let Some(s) = v.as_str() {
                        logs.push(s.to_owned());
                    }
                }
            };
            assert!(crate::gtk_test::wait_until(|| {
                drain_logs(&mut logs);
                logs.iter().any(|s| s == "mounted")
                    && surface.mounter.borrow().views.len() > 1
                    && focused_input_view(&surface).is_some()
                    && surface.events_handled() >= surface.events_sent()
            }));
            logs.clear();

            let f5 = Keystroke::parse("f5", Os::Linux).unwrap();
            let f6 = Keystroke::parse("f6", Os::Linux).unwrap();
            let f7 = Keystroke::parse("f7", Os::Linux).unwrap();
            let f8 = Keystroke::parse("f8", Os::Linux).unwrap();
            let down = Keystroke::parse("down", Os::Linux).unwrap();
            let backspace = Keystroke::parse("backspace", Os::Linux).unwrap();
            let d = Keystroke::parse("d", Os::Linux).unwrap();

            press_keystroke(&surface, f6);
            assert!(crate::gtk_test::wait_until(|| {
                drain_logs(&mut logs);
                logs.iter().any(|s| s == "scope:a")
                    && surface.events_handled() >= surface.events_sent()
            }));
            logs.clear();

            // Unhandled Down in a single-line input reaches fallback; Backspace edits text instead.
            press_keystroke(&surface, down);
            assert!(crate::gtk_test::wait_until(|| {
                drain_logs(&mut logs);
                logs.iter().any(|s| s == "fallback:down")
                    && surface.events_handled() >= surface.events_sent()
            }));
            logs.clear();
            let focused_a = focused_input_view(&surface).expect("input-a focused");
            press_keystroke(&surface, backspace);
            assert!(crate::gtk_test::wait_until(|| {
                current_text(&focused_a).as_deref() == Some("alph")
                    && surface.events_handled() >= surface.events_sent()
            }));
            drain_logs(&mut logs);
            assert!(logs.is_empty());

            // Move focus to inputB and immediately press f6: scope:b wins over scope:a and root.
            press_keystroke(&surface, f7);
            press_keystroke(&surface, f6);
            assert!(crate::gtk_test::wait_until(|| {
                drain_logs(&mut logs);
                logs.iter().any(|s| s == "scope:b")
                    && focused_input_view(&surface).is_some()
                    && surface.events_handled() >= surface.events_sent()
            }));
            logs.clear();

            // Scoped replaceRange replaces UTF-16 emoji range and clips to maxLength=6 ("bWXYta").
            let focused_b = focused_input_view(&surface).expect("input-b focused");
            set_selection(&focused_b, 5, 5);
            press_keystroke(&surface, f5);
            assert!(crate::gtk_test::wait_until(|| {
                drain_logs(&mut logs);
                logs.iter().any(|s| s == "b:bWXYta")
                    && surface.events_handled() >= surface.events_sent()
            }));
            logs.clear();

            // Focus non-input focusable view via Command::Focus: notEditing within-scoped 'd' fires.
            press_keystroke(&surface, f8);
            press_keystroke(&surface, d);
            assert!(crate::gtk_test::wait_until(|| {
                drain_logs(&mut logs);
                logs.iter().any(|s| s == "stop:d")
                    && surface.events_handled() >= surface.events_sent()
            }));
            logs.clear();

            // Blurred: unscoped root f6 fires while within-scoped bindings do not.
            blur_all(&surface);
            press_keystroke(&surface, f6);
            assert!(crate::gtk_test::wait_until(|| {
                drain_logs(&mut logs);
                logs.iter().any(|s| s == "root")
                    && surface.events_handled() >= surface.events_sent()
            }));

            view.stop();
            window.destroy();
        });
    }

    #[cfg(feature = "js")]
    #[test]
    fn composing_escape_cancels_preedit_before_leaving_field_or_closing_modal() {
        crate::gtk_test::run(|| {
            use nsh_core::{keymap::Keystroke, platform::Os};
            let (window, view, rx) = start_js_app(
                r#"import { host, keymap, mount, signal } from "nsh";
                import { Dialog } from "nsh/base";
                import { append, component, cond, element, insert, prop } from "nsh:rt";
                const open = signal(true);
                const root = element("view");
                prop(root, "style", { width: 300, height: 220 });
                let unbind = () => {};
                keymap.bind("f2", () => { unbind(); unbind = () => {}; host.post("log", "unbound"); }, { when: "always" });
                insert(root, cond(() => open(), () => {
                  const box = element("view");
                  prop(box, "style", { width: 240, height: 120 });
                  const input = element("input");
                  prop(input, "autoFocus", true);
                  prop(input, "style", { width: 200, height: 32 });
                  prop(input, "onKeyPress", (e) => host.post("log", `key:${e.key}`));
                  prop(input, "onCompositionChange", (e) => host.post("log", `comp:${e.composing}:${e.text}`));
                  append(box, input);
                  unbind = keymap.bind("escape", () => host.post("log", "shortcut:escape"), { when: "always", within: box });
                  return component(Dialog, {
                    open: true,
                    animation: "none",
                    closeOnEscape: true,
                    onOpenChange: (e) => {
                      if (!e.open) {
                        open.set(false);
                        host.post("log", "modal:close");
                      }
                    },
                    children: box,
                  });
                }));
                mount(() => root);
                host.post("log", "ready");"#,
            );
            let surface = view.surface().clone();
            let mut logs = Vec::new();
            let drain_logs = |logs: &mut Vec<String>| {
                while let Ok(v) = rx.try_recv() {
                    if let Some(s) = v.as_str() {
                        logs.push(s.to_owned());
                    }
                }
            };
            assert!(crate::gtk_test::wait_until(|| {
                drain_logs(&mut logs);
                logs.iter().any(|s| s == "ready")
                    && surface.mounter.borrow().views.len() > 1
                    && focused_input_view(&surface).is_some()
                    && surface.events_handled() >= surface.events_sent()
            }));
            logs.clear();

            let escape = Keystroke::parse("escape", Os::Linux).unwrap();
            let f2 = Keystroke::parse("f2", Os::Linux).unwrap();

            // 1. With an Escape shortcut bound inside the modal, composing Escape cancels preedit only.
            let input_view = focused_input_view(&surface).expect("focused modal input");
            let input_state = input_view.state().input.clone().expect("input state");
            input_state.cx.get().unwrap().preedit_changed("ni");
            assert!(composing_focused(&surface));
            press_keystroke(&surface, escape);
            assert!(!composing_focused(&surface));
            assert!(focused_input_view(&surface).is_some());
            assert!(crate::gtk_test::wait_until(|| {
                drain_logs(&mut logs);
                logs.iter().any(|s| s == "comp:false:")
                    && surface.events_handled() >= surface.events_sent()
            }));
            assert!(
                !logs
                    .iter()
                    .any(|s| s == "shortcut:escape" || s == "key:Escape" || s == "modal:close")
            );
            logs.clear();

            // 2. Unbind the Escape shortcut to verify ordinary 3-step desktop Escape navigation:
            //    1st Escape cancels preedit, 2nd leaves the input, 3rd closes the modal.
            press_keystroke(&surface, f2);
            assert!(crate::gtk_test::wait_until(|| {
                drain_logs(&mut logs);
                logs.iter().any(|s| s == "unbound")
                    && surface.events_handled() >= surface.events_sent()
            }));
            logs.clear();

            input_state.cx.get().unwrap().preedit_changed("hao");
            assert!(composing_focused(&surface));
            press_keystroke(&surface, escape);
            assert!(!composing_focused(&surface));
            assert!(focused_input_view(&surface).is_some());
            assert!(crate::gtk_test::wait_until(|| {
                drain_logs(&mut logs);
                logs.iter().any(|s| s == "comp:false:")
                    && surface.events_handled() >= surface.events_sent()
            }));
            assert!(!logs.iter().any(|s| s == "key:Escape" || s == "modal:close"));
            logs.clear();

            press_keystroke(&surface, escape);
            assert!(focused_input_view(&surface).is_none());
            assert!(crate::gtk_test::wait_until(|| {
                drain_logs(&mut logs);
                logs.iter().any(|s| s == "key:Escape")
                    && surface.events_handled() >= surface.events_sent()
            }));
            assert!(!logs.iter().any(|s| s == "modal:close"));
            logs.clear();

            press_keystroke(&surface, escape);
            assert!(crate::gtk_test::wait_until(|| {
                drain_logs(&mut logs);
                logs.iter().any(|s| s == "modal:close")
                    && surface.events_handled() >= surface.events_sent()
            }));

            view.stop();
            window.destroy();
        });
    }

    #[cfg(feature = "js")]
    #[test]
    fn pending_focus_event_holds_keys_paste_and_pause_input_without_queued_text() {
        crate::gtk_test::run(|| {
            use nsh_core::{PasteEvent, keymap::Keystroke, platform::Os};
            let (window, view, rx) = start_js_app(
                r#"import { host, keymap, mount, signal } from "nsh";
                import { append, bindProp, each, element, insert, prop } from "nsh:rt";
                const version = signal(0);
                const text = signal("");
                const root = element("view");
                prop(root, "style", { width: 300, height: 220 });
                keymap.bind("f8", () => {
                  const next = version() + 1;
                  text.set(`seed${next}`);
                  version.set(next);
                }, { when: "always" });
                keymap.bind("f9", () => host.post("log", "noop"), { when: "always" });
                insert(root, each(() => (version() > 0 ? [version()] : []), (row) => {
                  const id = row();
                  const box = element("view");
                  prop(box, "style", { width: 260, height: 60 });
                  const input = element("input");
                  prop(input, "autoFocus", true);
                  prop(input, "style", { width: 220, height: 32 });
                  bindProp(input, "value", () => text());
                  prop(input, "onChange", (e) => { text.set(e.value); host.post("log", `text:${e.value}`); });
                  append(box, input);
                  keymap.bind("f6", () => host.post("log", `scoped:${id}`), { when: "always", within: box });
                  return box;
                }, (id) => id));
                mount(() => root);
                host.post("log", "ready");"#,
            );
            let surface = view.surface().clone();
            let mut logs = Vec::new();
            let drain_logs = |logs: &mut Vec<String>| {
                while let Ok(v) = rx.try_recv() {
                    if let Some(s) = v.as_str() {
                        logs.push(s.to_owned());
                    }
                }
            };
            assert!(crate::gtk_test::wait_until(|| {
                drain_logs(&mut logs);
                logs.iter().any(|s| s == "ready")
                    && surface.mounter.borrow().views.len() > 1
                    && surface.events_handled() >= surface.events_sent()
            }));
            logs.clear();

            let f6 = Keystroke::parse("f6", Os::Linux).unwrap();
            let f8 = Keystroke::parse("f8", Os::Linux).unwrap();
            let f9 = Keystroke::parse("f9", Os::Linux).unwrap();
            let backspace = Keystroke::parse("backspace", Os::Linux).unwrap();

            // 1. Editing key (Backspace) with NO queued text waits for f8's autoFocus input.
            press_keystroke(&surface, f8);
            press_keystroke(&surface, backspace);
            assert!(crate::gtk_test::wait_until(|| {
                drain_logs(&mut logs);
                logs.iter().any(|s| s == "text:seed")
                    && surface.events_handled() >= surface.events_sent()
            }));
            logs.clear();

            // 2. Scoped shortcut + SelectAll + Paste + pause_input all wait for in-flight focus transition.
            blur_all(&surface);
            press_keystroke(&surface, f8);
            press_keystroke(&surface, f6);
            select_all_on(&surface);
            paste_into_focused(&surface, PasteEvent::new("ok")).expect("queued paste");
            let (pause_tx, pause_rx) = crossbeam_channel::bounded(1);
            view.pause_input(move |res| {
                let _ = pause_tx.send(res);
            });
            assert!(crate::gtk_test::wait_until(|| pause_rx.len() == 1));
            assert_eq!(pause_rx.recv().unwrap(), Ok(()));
            drain_logs(&mut logs);
            assert!(logs.iter().any(|s| s == "scoped:2"), "logs: {logs:?}");
            assert!(logs.iter().any(|s| s == "text:ok"), "logs: {logs:?}");
            logs.clear();

            // 3. Stranded pending text with no editable target fails pause_input cleanly.
            view.resume_input();
            assert!(focused_input_view(&surface).is_some());
            // Unmount or blur so no editable target has focus when f9 finishes.
            blur_all(&surface);
            press_keystroke(&surface, f9);
            type_text_on(&surface, "z");
            let (err_tx, err_rx) = crossbeam_channel::bounded(1);
            view.pause_input(move |res| {
                let _ = err_tx.send(res);
            });
            assert!(crate::gtk_test::wait_until(|| err_rx.len() == 1));
            assert_eq!(
                err_rx.recv().unwrap(),
                Err("pending input has no editable focus target".into())
            );

            view.stop();
            window.destroy();
        });
    }
}
