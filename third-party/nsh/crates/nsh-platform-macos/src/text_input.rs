//! Text inputs: an `NSTextField` (single line; `NSSecureTextField` for
//! `secureTextEntry`) or an `NSTextView` in an `NSScrollView`
//! (`multiline`) at the content box the core laid out (inside padding and
//! border), in a view that fills the input's ([`InputPad`]): a click
//! anywhere in the input, its padding too, edits at the nearest point.
//!
//! The view draws the decoration (background, border, corners) from the
//! core's style like any other view, so the editors draw only text: they
//! are borderless, without a background or focus ring, with the config's
//! font, colors and alignment. A single-line field shows its own
//! placeholder (an attributed one); a text view has none, so a label under
//! it shows the placeholder while the text is empty, an input method's
//! composition counting as text. Single-line text and placeholders share
//! the field editor's natural font metrics; multiline paragraphs use the
//! configured line height, its extra space split above and below the text
//! ([`LineBox`]), as the caret is as tall as a line fragment.
//!
//! The fields are subclasses ([`define_field!`]) only to hear what AppKit
//! tells a field's delegate's delegate: AppKit edits a field with the
//! window's shared field editor, whose delegate is the field, so the
//! field sees each change before it happens (`maxLength`, `onKeyPress`),
//! selection changes and the end of editing; it also learns when it takes
//! the focus. Text views are subclassed for their focus; the rest comes to
//! an [`InputDelegate`] (`NSTextFieldDelegate` / `NSTextViewDelegate`):
//! changes, return, Escape and Tab.
//!
//! Every user edit increments the input's edit count and reports
//! `onChangeText` with it (always, as the engine keeps the text); a value
//! from JS based on an older count is stale and dropped, so fast typing is
//! never overwritten. Programmatic changes (JS values, swapping editors)
//! report nothing. Offsets and lengths are UTF-16 units, as `NSString`'s.
//!
//! An input method's composition (the editor's marked text) is followed
//! natively and reported as `onCompositionChange`: as it starts and
//! changes (AppKit tells only of the selection then: marking text sends no
//! `textDidChange:`), and as it ends, after the `onChangeText` of the
//! committed text. Meanwhile the core measures the input with what it
//! shows, the composition included (`EngineControl::input_composing`). A value from JS that comes during a composition waits for its
//! end: setting the text then would end the input method's session and
//! commit what it composes. Leaving the input commits the composition, as
//! a browser's blur does ([`commit_marked`]): what was composed stays and
//! is reported before the composition ends.
//!
//! Focus follows desktop habits: Tab moves between fields (the window
//! recalculates its key view loop), Escape leaves the field, and clicking
//! a field places the caret there; `focus()` puts the caret at the end
//! rather than selecting everything as AppKit does.
//!
//! Input accessory views (`inputAccessoryViewID`) belong over a software
//! keyboard and have no meaning on the desktop: they are never shown.

use std::{
    cell::{Cell, OnceCell, RefCell},
    collections::VecDeque,
    rc::{Rc, Weak},
};

use nsh_core::{
    Bounds, Color, EventKind, EventPayload, InputConfig, PayloadValue, Points, SubmitBehavior,
    TextAlign,
    geometry::{Point, Size, px},
    platform::Os,
    tailwind::state,
};
use objc2::{
    AnyThread, ClassType, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, ProtocolObject, Sel},
    sel,
};
use objc2_app_kit::{
    NSApplication, NSBorderType, NSColor, NSControl, NSControlTextEditingDelegate, NSDragOperation,
    NSDraggingInfo, NSEvent, NSEventModifierFlags, NSEventType, NSFocusRingType,
    NSFontAttributeName, NSForegroundColorAttributeName, NSLineBreakMode, NSMutableParagraphStyle,
    NSParagraphStyleAttributeName, NSPasteboard, NSResponder, NSScrollView, NSSecureTextField,
    NSText, NSTextAlignment, NSTextDelegate, NSTextField, NSTextFieldDelegate, NSTextInputClient,
    NSTextStorage, NSTextView, NSTextViewDelegate, NSValidatedUserInterfaceItem, NSView,
    NSWritingDirection,
};
use objc2_core_foundation::{CGFloat, CGSize};
use objc2_foundation::{
    NSArray, NSAttributedString, NSDictionary, NSNotification, NSObject, NSObjectProtocol, NSPoint,
    NSRange, NSRect, NSString, NSUndoManager,
};
use rustc_hash::FxHashMap;

use crate::{
    surface::Surface,
    view::{NshView, ns_rect},
};

/// The view that edits.
#[derive(Clone)]
enum Editor {
    /// Single line (`secure`: an `NSSecureTextField`).
    Line {
        field: Retained<NSTextField>,
        secure: bool,
    },
    /// Several lines: a text view scrolled by its scroll view.
    Area {
        scroller: Retained<NSScrollView>,
        view: Retained<NSTextView>,
        /// Retained because `NSTextView.textStorage` is an assign property.
        storage: Retained<NSTextStorage>,
    },
}

impl Editor {
    /// Clears this editor's undo records without changing another input's history.
    fn clear_undo(
        &self,
        fallback: Option<&Retained<NSUndoManager>>,
    ) -> Option<Retained<NSUndoManager>> {
        let Editor::Area { view, storage, .. } = self else {
            return None;
        };
        let manager = view.undoManager().or_else(|| fallback.cloned())?;
        // SAFETY: AppKit registers text undo operations with the text storage as target.
        unsafe { manager.removeAllActionsWithTarget(storage) };
        Some(manager)
    }

    /// The view hosted in the input's view.
    fn host(&self) -> Retained<NSView> {
        match self {
            Editor::Line { field, .. } => Retained::from(&***field as &NSView),
            Editor::Area { scroller, .. } => Retained::from(&**scroller as &NSView),
        }
    }

    /// The view that takes the focus.
    fn responder(&self) -> Retained<NSView> {
        match self {
            Editor::Line { field, .. } => Retained::from(&***field as &NSView),
            Editor::Area { view, .. } => Retained::from(&***view as &NSView),
        }
    }

    /// The text view that edits now: the field editor while a field is
    /// edited, the text view of an area.
    fn editing(&self) -> Option<Retained<NSText>> {
        match self {
            Editor::Line { field, .. } => field.currentEditor(),
            Editor::Area { view, .. } => Some(Retained::from(&***view as &NSText)),
        }
    }

    fn ns_text(&self) -> Retained<NSString> {
        match self {
            // While a field is edited, its text is the field editor's.
            Editor::Line { field, .. } => match field.currentEditor() {
                Some(editor) => editor.string(),
                None => field.stringValue(),
            },
            Editor::Area { view, .. } => view.string(),
        }
    }

    fn text(&self) -> String {
        self.ns_text().to_string()
    }

    /// The text an input method is composing in the editor (its marked
    /// text), while a composition is in progress.
    fn marked_text(&self) -> Option<String> {
        let editing = self.editing()?;
        let view = editing.downcast_ref::<NSTextView>()?;
        if !view.hasMarkedText() {
            return None;
        }
        let range = view.markedRange();
        let string = view.string();
        // An empty marked range composes nothing (marking an empty string
        // unmarks).
        if range.length == 0
            || range
                .location
                .checked_add(range.length)
                .is_none_or(|end| end > string.length())
        {
            return None;
        }
        Some(string.substringWithRange(range).to_string())
    }

    fn is_empty(&self) -> bool {
        self.ns_text().length() == 0
    }

    /// The selection (UTF-16), if the editor has one: a field only has one
    /// while it is edited.
    fn selection(&self) -> Option<(u32, u32)> {
        let r = self.editing()?.selectedRange();
        Some((r.location as u32, (r.location + r.length) as u32))
    }

    /// The caret at the selection's end in `target`'s coordinates, while
    /// the editor edits: where the text system draws its insertion point.
    fn caret(&self, target: &NSView) -> Option<Bounds<Points>> {
        let editing = self.editing()?;
        let text_view = editing.downcast_ref::<NSTextView>()?;
        let window = text_view.window()?;
        let range = text_view.selectedRange();
        let at = NSRange::new(range.location + range.length, 0);
        // SAFETY: no actual range is asked for (null).
        let screen =
            unsafe { text_view.firstRectForCharacterRange_actualRange(at, std::ptr::null_mut()) };
        let rect = target.convertRect_fromView(window.convertRectFromScreen(screen), None);
        Some(Bounds {
            origin: Point::new(px(rect.origin.x as f32), px(rect.origin.y as f32)),
            // An empty range's rect has no width; the insertion point is
            // one point wide.
            size: Size::new(
                px((rect.size.width as f32).max(1.0)),
                px(rect.size.height as f32),
            ),
        })
    }

    /// Selects `start..end` (UTF-16, clamped to the text).
    fn select(&self, start: u32, end: u32) -> bool {
        let Some(editor) = self.editing() else {
            return false;
        };
        let len = editor.string().length();
        let start = (start as usize).min(len);
        let end = (end as usize).clamp(start, len);
        editor.setSelectedRange(NSRange::new(start, end - start));
        true
    }

    fn set_text(&self, text: &str) {
        let text = NSString::from_str(text);
        match self {
            Editor::Line { field, .. } => match field.currentEditor() {
                // The field takes the editor's text when editing ends. A
                // new string loses the editor's font and color.
                Some(editor) => {
                    editor.setString(&text);
                    editor.setFont(field.font().as_deref());
                    editor.setTextColor(field.textColor().as_deref());
                }
                None => field.setStringValue(&text),
            },
            Editor::Area { view, .. } => view.setString(&text),
        }
    }

    /// Whether it has the window's focus.
    fn focused(&self) -> bool {
        match self {
            Editor::Line { field, .. } => field.currentEditor().is_some(),
            Editor::Area { view, .. } => view.window().is_some_and(|w| {
                w.firstResponder()
                    .is_some_and(|r| std::ptr::eq(&*r, &***view as &NSResponder))
            }),
        }
    }
}

/// The native side of an input view ([`crate::view::ViewState::input`]).
pub(crate) struct InputState {
    editor: RefCell<Editor>,
    /// Retains a manager when available for cleanup after editor detachment.
    undo_manager: RefCell<Option<Retained<NSUndoManager>>>,
    /// Hears the editors (their `delegate` is weak).
    delegate: Retained<InputDelegate>,
    /// Fills the view and holds the editor ([`InputPad`]).
    pad: Retained<NSView>,
    /// A text view's placeholder, under it while its text is empty.
    placeholder: Retained<NSTextField>,
    config: RefCell<InputConfig>,
    /// A configuration was applied (auto focus happens on the first).
    configured: Cell<bool>,
    /// The first configuration's native autofocus callback is still live.
    focus_pending: Cell<bool>,
    /// Content box; the whole view until the core sends one.
    content: Cell<Option<Bounds<Points>>>,
    /// User edits reported to the engine.
    count: Cell<u32>,
    /// A change made here, not by the user, is being applied.
    applying: Cell<bool>,
    /// A clipped insertion (`maxLength`) is being applied.
    clipping: Cell<bool>,
    /// Focus as last reported.
    focused: Cell<bool>,
    /// Selection as last reported (UTF-16).
    selection: Cell<(u32, u32)>,
    /// The caret as last reported, in the input view.
    caret: Cell<Bounds<Points>>,
    /// A selection set while the field was not edited, applied when it is.
    pending_selection: Cell<Option<(u32, u32)>>,
    /// The text the engine knows the input has: the last one reported
    /// (`onChangeText`) or set from JS. A callback that sees another text
    /// comes before the change that reports it.
    known: RefCell<String>,
    /// The text an input method is composing, while a composition is in
    /// progress.
    composition: RefCell<Option<String>>,
    #[cfg(feature = "terminal")]
    terminal_original: RefCell<Option<NSRange>>,
    /// A value from JS (text, count) that came during a composition,
    /// applied when it ends.
    pending_value: RefCell<Option<(String, u32)>>,
    /// A user edit was allowed and is not reported yet.
    editing: Cell<bool>,
    /// A field is taking the focus.
    focusing: Cell<bool>,
    /// The modifiers of the key a text view is handling (its commands do
    /// not say which were held).
    key_mods: Cell<NSEventModifierFlags>,
    /// The animated text color applied.
    anim_color: Cell<Option<Color>>,
    cx: Ctx,
}

/// What the editors' callbacks need, without keeping anything alive.
#[derive(Clone)]
struct Ctx {
    surface: Weak<Surface>,
    view: objc2::rc::Weak<NSView>,
    input: Weak<InputState>,
}

impl Ctx {
    fn get(&self) -> Option<(Rc<Surface>, NshView, Rc<InputState>)> {
        let view: Retained<NSView> = self.view.load()?;
        let view = NshView::from_ns(&view)?;
        Some((self.surface.upgrade()?, view, self.input.upgrade()?))
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

    /// A text view's text scrolled, or its size or the viewport's changed.
    fn scrolled(&self) {
        if let Some((surface, view, input)) = self.get() {
            report_scroll(&surface, &view, &input);
        }
    }

    fn key_press(&self, key: &str) {
        self.send(EventKind::KeyPress, || {
            EventPayload::Map(vec![("key", PayloadValue::Str(key.to_owned()))])
        });
    }

    /// The text changed.
    fn changed(&self) {
        let Some((surface, view, input)) = self.get() else {
            return;
        };
        input.update_placeholder();
        input.editing.set(false);
        if input.applying.get() {
            return;
        }
        #[cfg(feature = "terminal")]
        if input.terminal_original.borrow().is_some() {
            self.composition_changed();
            return;
        }
        let count = input.count.get() + 1;
        input.count.set(count);
        input.remember_undo_manager();
        let text = input.editor.borrow().text();
        input.known.borrow_mut().clone_from(&text);
        // A composition that starts or changes is reported before the text
        // holding it, one that ends after the text it committed, as
        // browsers order them.
        let marked = input.editor.borrow().marked_text();
        let composing = marked.is_some();
        if composing {
            self.compose(&input, marked);
        }
        // Always reported: the engine keeps the text for layout and for
        // dropping stale values, whether JS listens or not.
        surface.event(
            view.id(),
            EventKind::ChangeText,
            EventPayload::Text { text, count },
        );
        if !composing {
            self.composition_changed();
        }
        self.selection_changed();
    }

    /// The editor's composition may have started, changed or ended
    /// (unmarking leaves the text as it is: the selection or the commands
    /// that unmark come here too).
    fn composition_changed(&self) {
        let Some(input) = self.input.upgrade() else {
            return;
        };
        // Marked text is in the editor's text, though no change is told.
        input.update_placeholder();
        if input.applying.get() {
            return;
        }
        let editor = input.editor.borrow().clone();
        let marked = editor.marked_text();
        let reported = *input.known.borrow() == editor.text();
        // Marking text, or dropping it, is an edit `changed` never hears of.
        if marked.is_some() || (reported && input.composition.borrow().is_some()) {
            input.editing.set(false);
        }
        // An edit not reported yet: `changed` reports it, then comes here.
        if input.editing.get() || (marked.is_none() && !reported) {
            return;
        }
        self.compose(&input, marked);
    }

    /// Records the composition `marked` (`None`: none) and reports it if
    /// it changed; its end applies a value JS wrote meanwhile.
    fn compose(&self, input: &InputState, marked: Option<String>) {
        if *input.composition.borrow() == marked {
            return;
        }
        let text = marked.clone().unwrap_or_default();
        let composing = marked.is_some();
        *input.composition.borrow_mut() = marked;
        if !composing && let Some((value, count)) = input.pending_value.take() {
            // Only if JS saw every edit (a commit that changed the text was
            // reported before).
            let seen = input.editor.borrow().text() == *input.known.borrow();
            if seen {
                input.apply_value(&value, count);
            }
        }
        // The core measures what the input shows meanwhile (the marked text
        // is in the editor's text), so a composition that wraps a line
        // grows the input before it commits.
        if let Some((surface, view, _)) = self.get() {
            let shown = composing.then(|| input.editor.borrow().text());
            let id = view.id();
            surface.control(|c| c.input_composing(id, shown));
        }
        self.send(EventKind::CompositionChange, || {
            EventPayload::Map(vec![
                ("composing", PayloadValue::Bool(composing)),
                ("text", PayloadValue::Str(text)),
            ])
        });
    }

    /// The caret or selection may have moved.
    fn selection_changed(&self) {
        let Some((_, view, input)) = self.get() else {
            return;
        };
        // A programmatic change is reported once, where it ends.
        if input.applying.get() || input.focusing.get() {
            return;
        }
        let editor = input.editor.borrow().clone();
        // A field's editor selects its text as editing ends: no change of
        // the user's.
        if let Editor::Line { field, .. } = &editor
            && !field.currentEditor().is_some_and(|e| {
                e.window()
                    .and_then(|w| w.firstResponder())
                    .is_some_and(|r| std::ptr::eq(&*r, &**e as &NSResponder))
            })
        {
            return;
        }
        if view.state().events.contains(EventKind::SelectionChange)
            && let Some(range) = editor.selection()
            && input.selection.replace(range) != range
        {
            self.send(EventKind::SelectionChange, || {
                EventPayload::Map(vec![
                    ("start", PayloadValue::Number(range.0 as f64)),
                    ("end", PayloadValue::Number(range.1 as f64)),
                ])
            });
        }
        self.caret_moved();
    }

    /// `onCaretMove` if the caret moved: with the selection, or as the text
    /// view scrolled or the input was laid out again. Only an editor that
    /// edits has a caret.
    fn caret_moved(&self) {
        let Some((_, view, input)) = self.get() else {
            return;
        };
        if !view.state().events.contains(EventKind::CaretMove) {
            return;
        }
        let editor = input.editor.borrow().clone();
        let Some(caret) = editor.caret(view.ns()) else {
            return;
        };
        if input.caret.replace(caret) != caret {
            self.send(EventKind::CaretMove, || EventPayload::caret(caret));
        }
    }

    /// A paste into the editor: reports what `pasteboard` holds
    /// (`onPaste`) if the app listens; whether the editor then pastes its
    /// text itself (`pasteBehavior`). The pasteboard is read only here, on
    /// the user's paste.
    fn pasting(&self, pasteboard: &NSPasteboard) -> bool {
        let Some((surface, view, input)) = self.get() else {
            return true;
        };
        let (id, listens) = {
            let s = view.state();
            (s.id, s.events.contains(EventKind::Paste))
        };
        if listens {
            let paste = crate::system::pasted(pasteboard);
            surface.event(id, EventKind::Paste, EventPayload::Paste(Box::new(paste)));
        }
        input.config.borrow().paste_behavior == nsh_core::PasteBehavior::Insert
    }

    /// Whether the editor offers Paste for what a text view's own paste
    /// leaves out (images, files), while the app listens to pastes.
    fn pastes_more(&self) -> bool {
        self.get().is_some_and(|(_, view, _)| {
            view.state().events.contains(EventKind::Paste)
                && crate::system::has_pasted_files(&NSPasteboard::generalPasteboard())
        })
    }

    /// Focus entered or left the editor.
    fn focus_changed(&self, focused: bool) {
        let Some((surface, view, input)) = self.get() else {
            return;
        };
        if focused {
            input.style_editor();
            if let Some((start, end)) = input.pending_selection.take() {
                input.editor.borrow().select(start, end);
            }
        }
        if !focused {
            #[cfg(feature = "terminal")]
            terminal_cancel_input(&input);
            // Leaving the input ends its composition.
            input.editing.set(false);
            self.compose(&input, None);
        }
        if input.focused.replace(focused) == focused {
            return;
        }
        surface
            .focus_generation
            .set(surface.focus_generation.get().wrapping_add(1));
        enter_changing(&surface);
        set_focused(&surface, &view, focused);
        if focused {
            // The scroll views around show the field, as on phones.
            crate::scroll::reveal(&surface, &view);
        }
        let kind = if focused {
            EventKind::Focus
        } else {
            EventKind::Blur
        };
        self.send(kind, || EventPayload::None);
        if focused {
            self.selection_changed();
        }
        leave_changing(&surface);
        if focused {
            if wants_text(&surface) && surface.events_handled() < surface.events_sent() {
                arm(&surface);
            } else {
                maybe_disarm(&surface);
            }
            if !is_changing(&surface) {
                flush_pending(&surface);
            }
        }
    }

    /// Return submitted the input (`blur`: and unfocuses it).
    fn submitted(&self, blur: bool) {
        let Some((surface, _, input)) = self.get() else {
            return;
        };
        self.key_press("Enter");
        let text = input.editor.borrow().text();
        let count = input.count.get();
        self.send(EventKind::SubmitEditing, || EventPayload::Text {
            text,
            count,
        });
        arm(&surface);
        if blur {
            self.unfocus();
        }
    }

    /// What return (`insertNewline:`) does in the editor: true if it was
    /// handled here, false to let the editor insert its line break.
    fn return_key(&self, input: &InputState, text_view: &NSTextView, multiline: bool) -> bool {
        let behavior = input.config.borrow().submit();
        if text_view.hasMarkedText() {
            // A return that commits a composition (CJK input methods) is
            // the input method's and never gets here; one that comes
            // anyway only commits it, as theirs does.
            text_view.unmarkText();
            self.composition_changed();
            return true;
        }
        // Shift+Return still breaks the line of a multiline input that
        // submits on return (Option+Return and Control+Return are
        // commands of their own: see `command`).
        let shift = input.key_mods.get().contains(NSEventModifierFlags::Shift);
        match behavior {
            SubmitBehavior::Newline => false,
            _ if multiline && shift => false,
            SubmitBehavior::Submit => {
                self.submitted(false);
                true
            }
            SubmitBehavior::BlurAndSubmit => {
                self.submitted(true);
                true
            }
        }
    }

    /// Takes the focus from the editor, to the surface's root (which
    /// handles keys while no field has the focus).
    fn unfocus(&self) {
        let Some(input) = self.input.upgrade() else {
            return;
        };
        let editor = input.editor.borrow().clone();
        if !editor.focused() {
            return;
        }
        let Some(window) = editor.responder().window() else {
            return;
        };
        match self.surface.upgrade() {
            Some(surface) => to_root(&window, &surface),
            None => {
                window.makeFirstResponder(None);
            }
        }
    }

    /// The editor `text_view` is about to replace `range` with
    /// `replacement`: reports the key, keeps line breaks out of a single
    /// line and clips the insertion to `maxLength`; false if it must not
    /// happen as it is.
    fn should_change(
        &self,
        text_view: &NSTextView,
        range: NSRange,
        replacement: Option<&NSString>,
    ) -> bool {
        let Some(input) = self.user_edit() else {
            return true;
        };
        let Some(replacement) = replacement else {
            // Attribute changes only.
            return true;
        };
        // Until `changed` reports the edit, the composition it changes is
        // not looked at (the editor may unmark before it replaces).
        input.editing.set(true);
        let mut text = replacement.to_string();
        if text.is_empty() {
            if range.length > 0 {
                self.key_press("Backspace");
            }
            return true;
        }
        // A single line never holds a line break: pasted ones become
        // spaces here, at once (the field editor would replace them in a
        // second edit, reported twice).
        let flattened = !input.config.borrow().multiline && text.contains(['\n', '\r']);
        if flattened {
            text = text.replace("\r\n", " ").replace(['\n', '\r'], " ");
        }
        let max = input.config.borrow().max_length;
        let fit = match max {
            Some(max) => {
                let kept = text_view.string().length().saturating_sub(range.length);
                clip_utf16(&text, (max as usize).saturating_sub(kept))
            }
            None => &text[..],
        };
        if !fit.is_empty() {
            self.key_press(key_of(fit));
        }
        if fit.len() == text.len() && !flattened {
            return true;
        }
        // The edit as asked never happens (a clipped one, made here, is
        // reported as it is made).
        input.editing.set(false);
        if !fit.is_empty() {
            // The clipped (or flattened) insertion, as a user edit (undo,
            // change notifications), but not checked again.
            let fit = NSString::from_str(fit);
            input.clipping.set(true);
            if text_view.shouldChangeTextInRange_replacementString(range, Some(&fit)) {
                text_view.replaceCharactersInRange_withString(range, &fit);
                text_view.didChangeText();
            }
            input.clipping.set(false);
        }
        false
    }

    /// A command of the editor's key bindings: return, Escape, Tab,
    /// backspace. True if it was handled here.
    fn command(&self, text_view: &NSTextView, command: Sel, multiline: bool) -> bool {
        let Some(input) = self.input.upgrade() else {
            return false;
        };
        if command == sel!(insertNewline:) {
            return self.return_key(&input, text_view, multiline);
        }
        // The key bindings have no use for this key: an app's fallback may.
        if command == sel!(noop:) {
            return !text_view.hasMarkedText()
                && self
                    .surface
                    .upgrade()
                    .is_some_and(|surface| crate::keymap::unhandled_key(&surface));
        }
        // Option+Return (`insertNewlineIgnoringFieldEditor:`) and
        // Control+Return (`insertLineBreak:`): a line break in a multiline
        // input whatever return does, a plain `\n` (a text view's
        // `insertLineBreak:` inserts U+2028); nothing in a single line,
        // which never holds one (a field editor would insert it).
        if command == sel!(insertNewlineIgnoringFieldEditor:) || command == sel!(insertLineBreak:) {
            if text_view.hasMarkedText() {
                text_view.unmarkText();
                self.composition_changed();
            } else if multiline {
                // SAFETY: NSTextView's action; in a text view that is not a
                // field editor it inserts a newline character.
                let _: () = unsafe {
                    msg_send![text_view, insertNewlineIgnoringFieldEditor: None::<&AnyObject>]
                };
            }
            return true;
        }
        if command == sel!(cancelOperation:) {
            #[cfg(feature = "terminal")]
            if input.terminal_original.borrow().is_some() {
                terminal_cancel_input(&input);
                self.composition_changed();
                return true;
            }
            if text_view.hasMarkedText() || input.composition.borrow().is_some() {
                if text_view.hasMarkedText() {
                    let empty = NSString::new();
                    let replacement = NSRange::new(isize::MAX as usize, 0);
                    // SAFETY: NSTextInputClient::setMarkedText with an empty NSString clears the marked range.
                    let _: () = unsafe {
                        msg_send![text_view, setMarkedText: &*empty, selectedRange: NSRange::new(0, 0), replacementRange: replacement]
                    };
                    text_view.unmarkText();
                }
                if input.editor.borrow().text() != *input.known.borrow() {
                    self.changed();
                } else {
                    self.composition_changed();
                }
                return true;
            }
            // Escape leaves the field (navigation leaves Escape alone while
            // a field has the focus).
            if let Some(surface) = self.surface.upgrade() {
                disarm(&surface);
            }
            self.key_press("Escape");
            self.unfocus();
            return true;
        }
        // A tab character only goes into a multiline input, with
        // Option+Tab (AppKit's binding).
        if command == sel!(insertTabIgnoringFieldEditor:) {
            return !multiline;
        }
        let backward = command == sel!(insertBacktab:) || command == sel!(selectPreviousKeyView:);
        if backward || command == sel!(insertTab:) || command == sel!(selectNextKeyView:) {
            // Tab and Control+Tab move the focus (in a text view too, as
            // in a single-line field), within the newest modal.
            let from: Retained<NSView> = match &*input.editor.borrow() {
                Editor::Line { field, .. } => Retained::from(&***field as &NSView),
                Editor::Area { view, .. } => Retained::from(&***view as &NSView),
            };
            if let Some(surface) = self.surface.upgrade() {
                tab(&surface, &from, backward);
            }
            return true;
        }
        // Backspace in an empty input deletes nothing, so no change
        // reports it.
        if command == sel!(deleteBackward:)
            && input.config.borrow().editable
            && text_view.string().length() == 0
        {
            self.key_press("Backspace");
        }
        false
    }
}

/// Moves the keyboard focus from `from` to the next (or previous) view of
/// the window's key view loop inside the focus scope
/// ([`crate::navigation::focus_scope`]): the window's loop holds every
/// field, those under a modal too. Wraps around; stays when there is no
/// other.
pub(crate) fn tab(surface: &Surface, from: &NSView, backward: bool) -> bool {
    let Some(window) = from.window() else {
        return false;
    };
    let scope = crate::navigation::focus_scope_of(surface, &window);
    // A window that recalculates its loop does so only in its own
    // `selectNextKeyView:`: the views' links are empty until then.
    window.recalculateKeyViewLoop();
    let mut at: Retained<NSView> = Retained::from(from);
    // Bounded: a loop always comes back, but a broken one must not hang.
    for _ in 0..512 {
        // SAFETY: plain getters of the key view loop, on the main thread.
        let next = unsafe {
            if backward {
                at.previousValidKeyView()
            } else {
                at.nextValidKeyView()
            }
        };
        let Some(next) = next else {
            return false;
        };
        if &*next == from {
            return false;
        }
        // A text view's clip view comes right before it in the loop and
        // gives the focus back to it: skip the views around `from`.
        if next.isDescendantOf(&scope)
            && if crate::view::is_ours(&next) {
                NshView::from_ns(&next).is_some_and(|view| crate::input::is_key_stop(&view))
            } else {
                crate::view::enclosing(&next).is_some_and(|owner| owner.can_reach())
            }
            && !from.isDescendantOf(&next)
        {
            return window.makeFirstResponder(Some(&next));
        }
        at = next;
    }
    false
}

/// Defines a field class: `NSTextField` or `NSSecureTextField` that tells
/// [`Ctx`] what its field editor does.
macro_rules! define_field {
    ($name:ident, $objc:literal, $($super:ident),+) => {
        define_field!(@ $name, $objc, {}, $($super),+);
    };
    ($name:ident, $objc:literal, cell = $cell:ident, $($super:ident),+) => {
        define_field!(@ $name, $objc, {
            /// Its cells' field editor reports pastes.
            #[unsafe(method(cellClass))]
            fn cell_class() -> &'static objc2::runtime::AnyClass {
                $cell::class()
            }
        }, $($super),+);
    };
    (@ $name:ident, $objc:literal, { $($extra:tt)* }, $($super:ident),+) => {
        define_class!(
            /// A field of an input (see the module docs).
            #[unsafe(super($($super),+))]
            #[thread_kind = MainThreadOnly]
            #[ivars = OnceCell<Ctx>]
            #[name = $objc]
            struct $name;

            unsafe impl NSObjectProtocol for $name {}

            impl $name {
                $($extra)*

                #[unsafe(method(acceptsFirstResponder))]
                fn accepts_first_responder(&self) -> bool {
                    // SAFETY: NSResponder's method, on the field.
                    let ok: bool = unsafe { msg_send![super(self), acceptsFirstResponder] };
                    ok && self
                        .ivars()
                        .get()
                        .and_then(|cx| cx.get())
                        .is_none_or(|(_, view, _)| view.can_reach())
                }

                // A combo box's field is the combo box, as WebKit's is: the
                // element VoiceOver is on while the list is open, named and
                // expanded as the input, its selected child the input's
                // active descendant, its linked element the list
                // ([`crate::access::combobox_field`]).
                #[unsafe(method_id(accessibilityRole))]
                fn accessibility_role(&self) -> Option<Retained<NSString>> {
                    match self.combobox() {
                        Some(_) => Some(NSString::from_str("AXComboBox")),
                        // SAFETY: NSTextField's own role.
                        None => unsafe { msg_send![super(self), accessibilityRole] },
                    }
                }

                #[unsafe(method_id(accessibilityLabel))]
                fn accessibility_label(&self) -> Option<Retained<NSString>> {
                    match self.combobox() {
                        Some(field) => field.label.map(|l| NSString::from_str(&l)),
                        // SAFETY: NSTextField's own label.
                        None => unsafe { msg_send![super(self), accessibilityLabel] },
                    }
                }

                #[unsafe(method(isAccessibilityExpanded))]
                fn is_accessibility_expanded(&self) -> bool {
                    match self.combobox() {
                        Some(field) => field.expanded,
                        // SAFETY: NSTextField's own state.
                        None => unsafe { msg_send![super(self), isAccessibilityExpanded] },
                    }
                }

                #[unsafe(method_id(accessibilitySelectedChildren))]
                fn accessibility_selected_children(&self) -> Option<Retained<NSArray>> {
                    match self.combobox().and_then(|f| f.active) {
                        Some(active) => Some(NSArray::from_retained_slice(&[active])),
                        // SAFETY: NSTextField's own answer.
                        None => unsafe { msg_send![super(self), accessibilitySelectedChildren] },
                    }
                }

                #[unsafe(method_id(accessibilityLinkedUIElements))]
                fn accessibility_linked_ui_elements(&self) -> Option<Retained<NSArray>> {
                    match self.combobox().and_then(|f| f.controls) {
                        Some(list) => Some(NSArray::from_retained_slice(&[list])),
                        // SAFETY: NSTextField's own answer.
                        None => unsafe { msg_send![super(self), accessibilityLinkedUIElements] },
                    }
                }

                #[unsafe(method(becomeFirstResponder))]
                fn become_first_responder(&self) -> bool {
                    // AppKit selects the whole text as the field takes the
                    // focus: a step, reported (if it stays) with the focus.
                    let input = self.ivars().get().and_then(|cx| cx.input.upgrade());
                    if let Some(input) = &input {
                        input.focusing.set(true);
                    }
                    // SAFETY: NSResponder's method, on the field.
                    let ok: bool = unsafe { msg_send![super(self), becomeFirstResponder] };
                    if let Some(input) = &input {
                        input.focusing.set(false);
                    }
                    if ok && let Some(cx) = self.ivars().get() {
                        cx.focus_changed(true);
                    }
                    ok
                }

                /// Its field editor is about to end editing: what an input
                /// method composes there is committed first.
                #[unsafe(method(textShouldEndEditing:))]
                fn text_should_end_editing(&self, text: &NSText) -> bool {
                    if let Some(editor) = text.downcast_ref::<NSTextView>() {
                        commit_marked(editor);
                    }
                    // SAFETY: NSTextField's own handling (it implements
                    // NSTextDelegate).
                    unsafe { msg_send![super(self), textShouldEndEditing: text] }
                }

                #[unsafe(method(textDidEndEditing:))]
                fn text_did_end_editing(&self, notification: &NSNotification) {
                    #[cfg(feature = "terminal")]
                    if let Some(cx) = self.ivars().get()
                        && let Some(input) = cx.input.upgrade()
                    {
                        terminal_cancel_input(&input);
                    }
                    // SAFETY: NSTextField's own handling of its field
                    // editor's end (it implements NSTextDelegate).
                    let _: () = unsafe { msg_send![super(self), textDidEndEditing: notification] };
                    if let Some(cx) = self.ivars().get() {
                        cx.focus_changed(false);
                    }
                }

                #[unsafe(method(textView:shouldChangeTextInRange:replacementString:))]
                fn should_change(
                    &self,
                    text_view: &NSTextView,
                    range: NSRange,
                    replacement: Option<&NSString>,
                ) -> bool {
                    let sel = sel!(textView:shouldChangeTextInRange:replacementString:);
                    // SAFETY: the superclass implements the delegate method
                    // with this signature when it responds to it.
                    let ok: bool = !<$name as ClassType>::Super::class().responds_to(sel)
                        || unsafe {
                            msg_send![
                                super(self),
                                textView: text_view,
                                shouldChangeTextInRange: range,
                                replacementString: replacement
                            ]
                        };
                    ok && self
                        .ivars()
                        .get()
                        .is_none_or(|cx| cx.should_change(text_view, range, replacement))
                }

                #[unsafe(method(textViewDidChangeSelection:))]
                fn did_change_selection(&self, notification: &NSNotification) {
                    let sel = sel!(textViewDidChangeSelection:);
                    if <$name as ClassType>::Super::class().responds_to(sel) {
                        // SAFETY: the superclass implements the delegate
                        // method with this signature.
                        let _: () = unsafe {
                            msg_send![super(self), textViewDidChangeSelection: notification]
                        };
                    }
                    if let Some(cx) = self.ivars().get() {
                        cx.composition_changed();
                        cx.selection_changed();
                    }
                }
            }
        );

        impl $name {
            fn create(mtm: MainThreadMarker, cx: Ctx) -> Retained<NSTextField> {
                let cell = OnceCell::new();
                let _ = cell.set(cx);
                let this = Self::alloc(mtm).set_ivars(cell);
                // SAFETY: NSTextField's designated initializer.
                let this: Retained<Self> =
                    unsafe { msg_send![super(this), initWithFrame: ns_rect(0.0, 0.0, 0.0, 0.0)] };
                // SAFETY: the class is a subclass of NSTextField.
                unsafe { Retained::cast_unchecked(this) }
            }
        }
    };
}

/// What a field of an input answers for its view.
trait FieldOf {
    /// The input view's combo box, when the field is one.
    fn combobox(&self) -> Option<crate::access::ComboboxField>;
}

impl<T: objc2::DefinedClass<Ivars = OnceCell<Ctx>>> FieldOf for T {
    fn combobox(&self) -> Option<crate::access::ComboboxField> {
        let (_, view, _) = self.ivars().get()?.get()?;
        crate::access::combobox_field(&view)
    }
}

define_field!(
    TextField,
    "NshTextField",
    cell = FieldCell,
    NSTextField,
    NSControl,
    NSView,
    NSResponder,
    NSObject
);
define_field!(
    SecureField,
    "NshSecureTextField",
    NSSecureTextField,
    NSTextField,
    NSControl,
    NSView,
    NSResponder,
    NSObject
);

/// Defines a direct subclass of `NSTextView` that an input edits with, as
/// `define_class!` does, with its file drags appended to its methods:
/// files dragged over the text go to the file drop target around the input
/// ([`crate::file_drop::text_entered`]); `surface` names the function that
/// gives the surface of a view of the class.
macro_rules! define_text_view {
    (
        $(#[$($attr:tt)*])*
        struct $name:ident;
        surface = $surface:path;

        unsafe impl NSObjectProtocol for $protocol_for:ident {}

        impl $impl_for:ident {
            $($methods:tt)*
        }
    ) => {
        define_class!(
            $(#[$($attr)*])*
            struct $name;

            unsafe impl NSObjectProtocol for $name {}

            impl $name {
                $($methods)*

                /// The Edit menu's Copy (Cmd+C): the editor's own selection,
                /// else the text selected around the input while it keeps
                /// the focus (a chat's messages above its composer).
                #[unsafe(method(copy:))]
                fn copy(&self, sender: Option<&AnyObject>) {
                    if !copies_selection_around(self, $surface(self)) {
                        // SAFETY: NSTextView's own method.
                        let _: () = unsafe { msg_send![super(self), copy: sender] };
                    }
                }

                #[unsafe(method(draggingEntered:))]
                fn dragging_entered(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> NSDragOperation {
                    $surface(self)
                        .and_then(|surface| crate::file_drop::text_entered(&surface, sender))
                        // SAFETY: NSTextView's own method.
                        .unwrap_or_else(|| unsafe { msg_send![super(self), draggingEntered: sender] })
                }

                #[unsafe(method(draggingUpdated:))]
                fn dragging_updated(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> NSDragOperation {
                    $surface(self)
                        .and_then(|surface| crate::file_drop::text_updated(&surface, sender))
                        // SAFETY: NSTextView's own method.
                        .unwrap_or_else(|| unsafe { msg_send![super(self), draggingUpdated: sender] })
                }

                #[unsafe(method(draggingExited:))]
                fn dragging_exited(&self, sender: Option<&ProtocolObject<dyn NSDraggingInfo>>) {
                    if let Some(surface) = $surface(self) {
                        crate::file_drop::clear(&surface);
                    }
                    // SAFETY: NSTextView's own method.
                    let _: () = unsafe { msg_send![super(self), draggingExited: sender] };
                }

                #[unsafe(method(prepareForDragOperation:))]
                fn prepare_drag(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> bool {
                    $surface(self)
                        .and_then(|surface| crate::file_drop::text_updated(&surface, sender))
                        .is_some()
                        // SAFETY: NSTextView's own method.
                        || unsafe { msg_send![super(self), prepareForDragOperation: sender] }
                }

                #[unsafe(method(performDragOperation:))]
                fn perform_drag(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) -> bool {
                    $surface(self)
                        .and_then(|surface| crate::file_drop::text_performed(&surface, sender))
                        // SAFETY: NSTextView's own method.
                        .unwrap_or_else(|| unsafe { msg_send![super(self), performDragOperation: sender] })
                }

                #[unsafe(method(draggingEnded:))]
                fn dragging_ended(&self, sender: &ProtocolObject<dyn NSDraggingInfo>) {
                    if let Some(surface) = $surface(self) {
                        crate::file_drop::clear(&surface);
                    }
                    if NSTextView::class().responds_to(sel!(draggingEnded:)) {
                        // SAFETY: NSTextView's own method, when it has one.
                        let _: () = unsafe { msg_send![super(self), draggingEnded: sender] };
                    }
                }
            }
        );
    };
}

define_text_view!(
    /// The text view of a multiline input: tells [`Ctx`] when it takes and
    /// loses the focus, and which modifiers its keys hold.
    #[unsafe(super(NSTextView, NSText, NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = OnceCell<Ctx>]
    #[name = "NshTextView"]
    struct TextArea;
    surface = area_surface;

    unsafe impl NSObjectProtocol for TextArea {}

    impl TextArea {
        /// A rich editor places a narrow native input at its document caret.
        /// TextKit can return no rectangle once its buffer wraps out of view.
        #[unsafe(method(firstRectForCharacterRange:actualRange:))]
        unsafe fn first_rect(&self, range: NSRange, actual_range: *mut NSRange) -> NSRect {
            // SAFETY: the caller supplies a writable range pointer or null.
            let rect: NSRect = unsafe {
                msg_send![super(self), firstRectForCharacterRange: range, actualRange: actual_range]
            };
            let length = self.string().length();
            if rect.size.height != 0.0
                || range.location > length
                || range.length > length - range.location
            {
                return rect;
            }
            let visible = self.visibleRect();
            let Some(window) = self.window() else { return rect };
            if visible.size.width <= 0.0 || visible.size.height <= 0.0 {
                return rect;
            }
            if !actual_range.is_null() {
                // SAFETY: the caller supplies a writable range pointer or null.
                unsafe { actual_range.write(range) };
            }
            window.convertRectToScreen(self.convertRect_toView(visible, None))
        }

        /// A click in an inactive window edits at once, as everywhere in
        /// the surface (the root accepts first clicks too).
        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&objc2_app_kit::NSEvent>) -> bool {
            true
        }

        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) {
            let input = self.ivars().get().and_then(|cx| cx.input.upgrade());
            if let Some(input) = &input {
                input.key_mods.set(event.modifierFlags());
            }
            // SAFETY: NSTextView's own method.
            let _: () = unsafe { msg_send![super(self), keyDown: event] };
            if let Some(input) = &input {
                input.key_mods.set(NSEventModifierFlags::empty());
            }
        }

        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool {
            // SAFETY: NSTextView's own method.
            let ok: bool = unsafe { msg_send![super(self), acceptsFirstResponder] };
            ok && self
                .ivars()
                .get()
                .and_then(|cx| cx.get())
                .is_none_or(|(_, view, _)| view.can_reach())
        }

        #[unsafe(method(becomeFirstResponder))]
        fn become_first_responder(&self) -> bool {
            // SAFETY: NSTextView's own method.
            let ok: bool = unsafe { msg_send![super(self), becomeFirstResponder] };
            if ok && let Some(cx) = self.ivars().get() {
                cx.focus_changed(true);
            }
            ok
        }

        #[unsafe(method(resignFirstResponder))]
        fn resign_first_responder(&self) -> bool {
            commit_marked(self);
            // SAFETY: NSTextView's own method.
            let ok: bool = unsafe { msg_send![super(self), resignFirstResponder] };
            if ok && let Some(cx) = self.ivars().get() {
                cx.focus_changed(false);
            }
            ok
        }

        /// An input method that accepts its marked text as it is changes
        /// neither the text nor always the selection.
        #[unsafe(method(unmarkText))]
        fn unmark_text(&self) {
            // SAFETY: NSTextView's own method (NSTextInputClient).
            let _: () = unsafe { msg_send![super(self), unmarkText] };
            if let Some(cx) = self.ivars().get() {
                cx.composition_changed();
            }
        }

        /// A paste (Edit > Paste, Command+V, the context menu): reported,
        /// and its text pasted as `pasteBehavior` says.
        #[unsafe(method(paste:))]
        fn paste(&self, sender: Option<&AnyObject>) {
            if self.ivars().get().is_some_and(|cx| hold_menu_paste(cx, false)) {
                return;
            }
            if text_area_pasting(self, &NSPasteboard::generalPasteboard()) {
                // SAFETY: NSTextView's own method.
                let _: () = unsafe { msg_send![super(self), paste: sender] };
            }
        }

        #[unsafe(method(pasteAsPlainText:))]
        fn paste_as_plain_text(&self, sender: Option<&AnyObject>) {
            if self.ivars().get().is_some_and(|cx| hold_menu_paste(cx, true)) {
                return;
            }
            if text_area_pasting(self, &NSPasteboard::generalPasteboard()) {
                // SAFETY: NSTextView's own method.
                let _: () = unsafe { msg_send![super(self), pasteAsPlainText: sender] };
            }
        }

        /// Paste is offered for images and files too while the app
        /// listens; Copy for text selected around the input.
        #[unsafe(method(validateUserInterfaceItem:))]
        fn validate(&self, item: &ProtocolObject<dyn NSValidatedUserInterfaceItem>,
        ) -> objc2::runtime::Bool {
            if item.action() == Some(sel!(paste:)) && self.ivars().get().is_some_and(Ctx::pastes_more) {
                return objc2::runtime::Bool::YES;
            }
            if item.action() == Some(sel!(copy:))
                && copy_falls_through(self, area_surface(self).as_deref())
            {
                return objc2::runtime::Bool::YES;
            }
            // SAFETY: NSTextView's own method.
            unsafe { msg_send![super(self), validateUserInterfaceItem: item] }
        }
    }
);

/// The surface of text area `area`, for its drags.
fn area_surface(area: &TextArea) -> Option<Rc<Surface>> {
    area.ivars().get()?.surface.upgrade()
}

/// Whether a copy in `text_view` takes the text selected in `surface`
/// instead: the editor has nothing of its own selected, and the surface
/// has a selection (an input keeps the focus while text around it is
/// selected).
fn copy_falls_through(text_view: &NSTextView, surface: Option<&Surface>) -> bool {
    text_view.selectedRange().length == 0 && surface.is_some_and(crate::text::can_copy)
}

/// A copy in `text_view` (an input's editor): copies the text selected
/// around it, if [`copy_falls_through`]. False if the editor copies its
/// own.
fn copies_selection_around(text_view: &NSTextView, surface: Option<Rc<Surface>>) -> bool {
    let surface = surface.as_deref();
    copy_falls_through(text_view, surface) && surface.is_some_and(crate::text::copy)
}

/// An in-process paste that waits for any unsettled focus-triggering engine
/// event on `surface` before targeting the focused input.
#[cfg(any(feature = "dev", feature = "terminal"))]
pub(crate) fn paste_or_hold(
    surface: &Rc<Surface>,
    window: &objc2_app_kit::NSWindow,
    content: &nsh_core::PasteEvent,
) -> Result<(), String> {
    if queue_if_unsettled(surface, || Held::Paste {
        window: Retained::from(window),
        content: content.clone(),
    }) {
        return Ok(());
    }
    paste(window, content)
}

/// An in-process paste: `content` on a pasteboard of
/// its own (the machine's clipboard stays as it was), pasted into the
/// focused input as the user's paste is: reported, then its text read
/// from that pasteboard as `pasteBehavior` says.
#[cfg(any(feature = "dev", feature = "terminal"))]
pub(crate) fn paste(
    window: &objc2_app_kit::NSWindow,
    content: &nsh_core::PasteEvent,
) -> Result<(), String> {
    with_focused(window, |text_view, cx| paste_from(text_view, &cx, content))?
}

/// Runs `f` with the text view that edits the focused input and its
/// context: an error when no input of the app has the focus.
#[cfg(any(feature = "dev", feature = "terminal"))]
fn with_focused<R>(
    window: &objc2_app_kit::NSWindow,
    f: impl FnOnce(&NSTextView, Ctx) -> R,
) -> Result<R, String> {
    let responder = window.firstResponder().ok_or("no input has the focus")?;
    let object: &AnyObject = &responder;
    let (text_view, cx): (&NSTextView, Option<Ctx>) =
        if let Some(area) = object.downcast_ref::<TextArea>() {
            (area, area.ivars().get().cloned())
        } else if let Some(editor) = object.downcast_ref::<FieldEditor>() {
            (editor, field_ctx(editor))
        } else if let Some(editor) = object.downcast_ref::<NSTextView>() {
            let cx = editor.delegate().and_then(|delegate| {
                let object: &AnyObject = ProtocolObject::as_ref(&*delegate);
                object
                    .downcast_ref::<SecureField>()
                    .and_then(|field| field.ivars().get().cloned())
            });
            (editor, cx)
        } else {
            return Err("no input of the app has the focus".into());
        };
    Ok(f(text_view, cx.ok_or("the focused input is gone")?))
}

/// The input that has the keyboard focus, if one of the app's has it.
#[cfg(feature = "dev")]
pub(crate) fn test_focused(window: &objc2_app_kit::NSWindow) -> Option<nsh_core::NodeId> {
    with_focused(window, |_, cx| cx.get().map(|(_, view, _)| view.id()))
        .ok()
        .flatten()
}

/// A test's input method (`nsh test --target macos`): composes `text` in
/// the focused input as one does, marked text at the caret in place of
/// what it composed; an empty `text` ends the composition with nothing
/// committed.
#[cfg(feature = "dev")]
pub(crate) fn test_compose(window: &objc2_app_kit::NSWindow, text: &str) -> Result<(), String> {
    with_focused(window, |text_view, _| {
        let marked = NSString::from_str(text);
        let caret = NSRange::new(marked.length(), 0);
        let replace = NSRange::new(objc2_foundation::NSNotFound as usize, 0);
        // SAFETY: NSTextInputClient's methods, which NSTextView implements,
        // with a string and ranges inside it.
        unsafe {
            let _: () = msg_send![
                text_view,
                setMarkedText: &*marked,
                selectedRange: caret,
                replacementRange: replace
            ];
            if text.is_empty() {
                let _: () = msg_send![text_view, unmarkText];
            }
        }
    })
}

/// [`test_paste`]'s paste into `text_view`, the editor of `cx`.
#[cfg(any(feature = "dev", feature = "terminal"))]
fn paste_from(
    text_view: &NSTextView,
    cx: &Ctx,
    content: &nsh_core::PasteEvent,
) -> Result<(), String> {
    use objc2_app_kit::{NSPasteboardItem, NSPasteboardTypeString, NSPasteboardWriting};
    let board = NSPasteboard::pasteboardWithUniqueName();
    board.clearContents();
    let mut items: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = Vec::new();
    let item = || NSPasteboardItem::new();
    // Text and its HTML are one item, as a browser copies them.
    if !content.text.is_empty() || !content.html.is_empty() {
        let text = item();
        if !content.text.is_empty() {
            // SAFETY: an immutable AppKit constant.
            text.setString_forType(&NSString::from_str(&content.text), unsafe {
                NSPasteboardTypeString
            });
        }
        if !content.html.is_empty() {
            text.setString_forType(
                &NSString::from_str(&content.html),
                &NSString::from_str("public.html"),
            );
        }
        items.push(ProtocolObject::from_retained(text));
    }
    for file in &content.files {
        let kind = match file.mime.as_str() {
            "image/png" => "public.png",
            "image/jpeg" => "public.jpeg",
            "image/gif" => "com.compuserve.gif",
            "image/webp" => "org.webmproject.webp",
            "image/tiff" => "public.tiff",
            _ => "public.data",
        };
        let data = item();
        data.setData_forType(
            &objc2_foundation::NSData::with_bytes(&file.data),
            &NSString::from_str(kind),
        );
        items.push(ProtocolObject::from_retained(data));
    }
    for uri in &content.uris {
        let url = item();
        url.setString_forType(
            &NSString::from_str(uri),
            &NSString::from_str("public.file-url"),
        );
        items.push(ProtocolObject::from_retained(url));
    }
    board.writeObjects(&objc2_foundation::NSArray::from_retained_slice(&items));
    if cx.pasting(&board) {
        text_view.readSelectionFromPasteboard(&board);
    }
    // SAFETY: NSPasteboard's method; the test's pasteboard is not used again.
    let _: () = unsafe { msg_send![&board, releaseGlobally] };
    Ok(())
}

/// A paste into text area `area`: [`Ctx::pasting`].
fn text_area_pasting(area: &TextArea, pasteboard: &NSPasteboard) -> bool {
    area.ivars().get().is_none_or(|cx| cx.pasting(pasteboard))
}

define_text_view!(
    /// The field editor of a single-line input ([`FieldCell`]): AppKit's
    /// shared one, but for pastes, which an input reports (`onPaste`).
    #[unsafe(super(NSTextView, NSText, NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "NshFieldEditor"]
    struct FieldEditor;
    surface = editor_surface;

    unsafe impl NSObjectProtocol for FieldEditor {}

    impl FieldEditor {
        /// A paste (Edit > Paste, Command+V, the context menu): reported,
        /// and its text pasted as `pasteBehavior` says.
        #[unsafe(method(paste:))]
        fn paste(&self, sender: Option<&AnyObject>) {
            if field_ctx(self).is_some_and(|cx| hold_menu_paste(&cx, false)) {
                return;
            }
            if field_editor_pasting(self, &NSPasteboard::generalPasteboard()) {
                // SAFETY: NSTextView's own method.
                let _: () = unsafe { msg_send![super(self), paste: sender] };
            }
        }

        #[unsafe(method(pasteAsPlainText:))]
        fn paste_as_plain_text(&self, sender: Option<&AnyObject>) {
            if field_ctx(self).is_some_and(|cx| hold_menu_paste(&cx, true)) {
                return;
            }
            if field_editor_pasting(self, &NSPasteboard::generalPasteboard()) {
                // SAFETY: NSTextView's own method.
                let _: () = unsafe { msg_send![super(self), pasteAsPlainText: sender] };
            }
        }

        /// Paste is offered for images and files too while the app
        /// listens; Copy for text selected around the input.
        #[unsafe(method(validateUserInterfaceItem:))]
        fn validate(&self, item: &ProtocolObject<dyn NSValidatedUserInterfaceItem>,
        ) -> objc2::runtime::Bool {
            if item.action() == Some(sel!(paste:)) && field_ctx(self).is_some_and(|cx| cx.pastes_more()) {
                return objc2::runtime::Bool::YES;
            }
            if item.action() == Some(sel!(copy:))
                && copy_falls_through(self, editor_surface(self).as_deref())
            {
                return objc2::runtime::Bool::YES;
            }
            // SAFETY: NSTextView's own method.
            unsafe { msg_send![super(self), validateUserInterfaceItem: item] }
        }
    }
);

/// The surface of the input field `editor` edits, for its drags.
fn editor_surface(editor: &FieldEditor) -> Option<Rc<Surface>> {
    field_ctx(editor)?.surface.upgrade()
}

/// The input of the field `editor` edits (its delegate, while it edits).
fn field_ctx(editor: &FieldEditor) -> Option<Ctx> {
    let delegate = editor.delegate()?;
    let object: &AnyObject = ProtocolObject::as_ref(&*delegate);
    object
        .downcast_ref::<TextField>()
        .and_then(|field| field.ivars().get().cloned())
}

/// A paste into the field `editor` edits: [`Ctx::pasting`].
fn field_editor_pasting(editor: &FieldEditor, pasteboard: &NSPasteboard) -> bool {
    field_ctx(editor).is_none_or(|cx| cx.pasting(pasteboard))
}

define_class!(
    /// The cell of a single-line input's field: its field editor is NSH's
    /// ([`FieldEditor`]), one per window as AppKit's own, which reports
    /// pastes. AppKit makes the cells (`cellClass`): no ivars.
    #[unsafe(super(objc2_app_kit::NSTextFieldCell, objc2_app_kit::NSActionCell, objc2_app_kit::NSCell, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "NshFieldCell"]
    struct FieldCell;

    unsafe impl NSObjectProtocol for FieldCell {}

    impl FieldCell {
        #[unsafe(method_id(fieldEditorForView:))]
        fn field_editor_for_view(&self, view: &NSView) -> Option<Retained<NSTextView>> {
            let mtm = MainThreadMarker::from(self);
            view.window().map(|window| field_editor(mtm, &window))
        }
    }
);

thread_local! {
    /// The field editors of the windows, by window.
    static FIELD_EDITORS: RefCell<Vec<(objc2::rc::Weak<objc2_app_kit::NSWindow>, Retained<NSTextView>)>> =
        const { RefCell::new(Vec::new()) };
}

/// `window`'s field editor for inputs (made the first time).
fn field_editor(mtm: MainThreadMarker, window: &objc2_app_kit::NSWindow) -> Retained<NSTextView> {
    FIELD_EDITORS.with_borrow_mut(|editors| {
        // The editors of closed windows go.
        editors.retain(|(w, _)| w.load().is_some());
        if let Some((_, editor)) = editors
            .iter()
            .find(|(w, _)| w.load().is_some_and(|w| std::ptr::eq(&*w, window)))
        {
            return editor.clone();
        }
        let this = FieldEditor::alloc(mtm).set_ivars(());
        // SAFETY: NSTextView's initializer (it makes its own text system).
        let editor: Retained<FieldEditor> =
            unsafe { msg_send![super(this), initWithFrame: ns_rect(0.0, 0.0, 0.0, 0.0)] };
        // SAFETY: the class is a subclass of NSTextView.
        let editor: Retained<NSTextView> = unsafe { Retained::cast_unchecked(editor) };
        editor.setFieldEditor(true);
        editor.setRichText(false);
        editor.setImportsGraphics(false);
        editor.setAllowsUndo(true);
        editors.push((objc2::rc::Weak::from(window), editor.clone()));
        editor
    })
}

define_class!(
    /// Fills an input's view and holds its editor (and placeholder), so a
    /// click anywhere in the input edits, its padding and the space around
    /// a field's line too, as on iOS: the click goes to the editor at the
    /// nearest point inside it.
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = Cell<bool>]
    #[name = "NshInputPad"]
    struct InputPad;

    unsafe impl NSObjectProtocol for InputPad {}

    impl InputPad {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
            true
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            // An editor that passes the press on (up the responder chain)
            // brings it back here: it ends here then.
            if !self.ivars().replace(true) {
                self.forward(event);
                self.ivars().set(false);
            }
        }
    }
);

impl InputPad {
    fn create(mtm: MainThreadMarker) -> Retained<NSView> {
        let this = Self::alloc(mtm).set_ivars(Cell::new(false));
        // SAFETY: NSView's designated initializer.
        let this: Retained<Self> =
            unsafe { msg_send![super(this), initWithFrame: ns_rect(0.0, 0.0, 0.0, 0.0)] };
        Retained::into_super(this)
    }

    /// Sends a press beside the editor to the editor, moved to the nearest
    /// point inside it (the caret goes there, a drag selects from there).
    fn forward(&self, event: &NSEvent) {
        // The editor is the topmost subview (the placeholder is below it).
        let (Some(editor), Some(window), Some(outer)) = (
            self.subviews().lastObject(),
            self.window(),
            crate::view::superview(self),
        ) else {
            return;
        };
        let p = self.convertPoint_fromView(event.locationInWindow(), None);
        let f = editor.frame();
        if f.size.width < 2.0 || f.size.height < 2.0 {
            return;
        }
        let inside = NSPoint::new(
            p.x.clamp(f.origin.x + 1.0, f.origin.x + f.size.width - 1.0),
            p.y.clamp(f.origin.y + 1.0, f.origin.y + f.size.height - 1.0),
        );
        // `hitTest:` takes a point in the superview's coordinates.
        let at = self.convertPoint_toView(inside, Some(&outer));
        let me: &NSView = self;
        let Some(target) = self.hitTest(at).filter(|t| &**t != me) else {
            return;
        };
        // The window gives the focus to what a press hits before it sends
        // the press, and a field only edits a press once it has the focus
        // (its field editor then takes the press, so hit again).
        if target.acceptsFirstResponder() && !window.makeFirstResponder(Some(&target)) {
            return;
        }
        let Some(target) = self.hitTest(at).filter(|t| &**t != me) else {
            return;
        };
        let moved = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            event.r#type(),
            self.convertPoint_toView(inside, None),
            event.modifierFlags(),
            event.timestamp(),
            event.windowNumber(),
            None,
            event.eventNumber(),
            event.clickCount(),
            event.pressure(),
        );
        let Some(moved) = moved else { return };
        target.mouseDown(&moved);
        // The editor tracked the press to the release at its real point,
        // beside the text, so a click selected from the caret to the
        // text's start or end: a click without a drag puts the caret at
        // the moved point.
        let Some(text) = target.downcast_ref::<NSTextView>() else {
            return;
        };
        let released = NSApplication::sharedApplication(self.mtm())
            .currentEvent()
            .filter(|e| e.r#type() == NSEventType::LeftMouseUp)
            .map(|e| e.locationInWindow());
        let start = event.locationInWindow();
        if event.clickCount() == 1
            && released.is_some_and(|r| (r.x - start.x).abs() < 3.0 && (r.y - start.y).abs() < 3.0)
        {
            let at = text.convertPoint_fromView(inside, Some(self));
            let index = text.characterIndexForInsertionAtPoint(at);
            text.setSelectedRange(NSRange::new(index, 0));
        }
    }
}

define_class!(
    /// The delegate of an input's editors: text changes and key binding
    /// commands.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = Ctx]
    #[name = "NshInputDelegate"]
    struct InputDelegate;

    unsafe impl NSObjectProtocol for InputDelegate {}

    impl InputDelegate {
        /// A text view's clip view scrolled.
        #[unsafe(method(clipBoundsChanged:))]
        fn clip_bounds_changed(&self, _notification: &NSNotification) {
            self.ivars().caret_moved();
            self.ivars().scrolled();
        }

        /// A text view or its clip view changed size: the content or the
        /// viewport a built-in bar shows.
        #[unsafe(method(textFrameChanged:))]
        fn text_frame_changed(&self, _notification: &NSNotification) {
            self.ivars().scrolled();
        }
    }

    unsafe impl NSControlTextEditingDelegate for InputDelegate {
        #[unsafe(method(controlTextDidChange:))]
        fn control_text_did_change(&self, _notification: &NSNotification) {
            self.ivars().changed();
        }

        #[unsafe(method(control:textView:doCommandBySelector:))]
        fn control_command(
            &self,
            _control: &NSControl,
            text_view: &NSTextView,
            command: Sel,
        ) -> bool {
            self.ivars().command(text_view, command, false)
        }
    }

    unsafe impl NSTextFieldDelegate for InputDelegate {}

    unsafe impl NSTextDelegate for InputDelegate {
        #[unsafe(method(textDidChange:))]
        fn text_did_change(&self, _notification: &NSNotification) {
            self.ivars().changed();
        }
    }

    unsafe impl NSTextViewDelegate for InputDelegate {
        #[unsafe(method(textView:shouldChangeTextInRange:replacementString:))]
        fn should_change(
            &self,
            text_view: &NSTextView,
            range: NSRange,
            replacement: Option<&NSString>,
        ) -> bool {
            self.ivars().should_change(text_view, range, replacement)
        }

        #[unsafe(method(textViewDidChangeSelection:))]
        fn did_change_selection(&self, _notification: &NSNotification) {
            self.ivars().composition_changed();
            self.ivars().selection_changed();
        }

        #[unsafe(method(textView:doCommandBySelector:))]
        fn command(&self, text_view: &NSTextView, command: Sel) -> bool {
            self.ivars().command(text_view, command, true)
        }
    }
);

impl InputState {
    fn clear_undo(&self, editor: &Editor) {
        let fallback = self.undo_manager.borrow().clone();
        if let Some(manager) = editor.clear_undo(fallback.as_ref()) {
            *self.undo_manager.borrow_mut() = Some(manager);
        }
    }

    fn remember_undo_manager(&self) {
        let editor = self.editor.borrow();
        let Editor::Area { view, .. } = &*editor else {
            return;
        };
        if let Some(manager) = view.undoManager() {
            *self.undo_manager.borrow_mut() = Some(manager);
        }
    }

    fn update_placeholder(&self) {
        let editor = self.editor.borrow();
        let shown = matches!(&*editor, Editor::Area { .. })
            && !self.config.borrow().placeholder.is_empty()
            && editor.is_empty();
        self.placeholder.setHidden(!shown);
    }

    /// Sets the text without reporting it, keeping the caret where it was
    /// (at the end if it was there).
    fn replace_text(&self, text: &str) {
        *self.known.borrow_mut() = text.to_owned();
        let editor = self.editor.borrow().clone();
        let old_len = editor.ns_text().length() as u32;
        let caret = editor.selection().map(|(_, end)| end);
        self.applying.set(true);
        self.clear_undo(&editor);
        editor.set_text(text);
        if let Some(caret) = caret {
            let len = utf16_len(text) as u32;
            let caret = if caret >= old_len {
                len
            } else {
                caret.min(len)
            };
            editor.select(caret, caret);
        }
        self.applying.set(false);
        self.update_placeholder();
        self.cx.selection_changed();
    }

    /// JS's text, unless the user typed since JS saw `count`.
    fn apply_value(&self, text: &str, count: u32) {
        if count < self.count.get() || self.editor.borrow().text() == text {
            return;
        }
        self.replace_text(text);
    }

    /// The text color: an animated one over the config's.
    fn text_color(&self) -> Retained<NSColor> {
        ns_color(
            self.anim_color
                .get()
                .unwrap_or(self.config.borrow().style.color),
        )
    }

    /// Caret and selection colors of the view that edits now (the window's
    /// field editor is shared, so a field sets them when it takes the
    /// focus).
    fn style_editor(&self) {
        let Some(editor) = self.editor.borrow().editing() else {
            return;
        };
        let Ok(view) = editor.downcast::<NSTextView>() else {
            return;
        };
        let config = self.config.borrow();
        let caret = if config.caret_hidden {
            NSColor::clearColor()
        } else {
            config
                .caret_color
                .map_or_else(|| self.text_color(), ns_color)
        };
        view.setInsertionPointColor(Some(&caret));
        let selection = config
            .selection_color
            .map_or_else(NSColor::selectedTextBackgroundColor, |c| {
                ns_color(c.with_alpha(0.3))
            });
        // SAFETY: an immutable AppKit attribute key with a color value.
        let key = unsafe { objc2_app_kit::NSBackgroundColorAttributeName };
        let attributes =
            NSDictionary::from_slices(&[key], &[AsRef::<AnyObject>::as_ref(&*selection)]);
        // SAFETY: valid text attributes.
        unsafe { view.setSelectedTextAttributes(&attributes) };
    }

    /// Focuses the input's editor with the caret at the end (unless an
    /// explicit selection is pending), holding `changing` across AppKit's
    /// responder swap so queued edits wait until the caret is placed.
    fn focus_editor(&self, surface: Option<&Rc<Surface>>) {
        let editor = self.editor.borrow().clone();
        let responder = editor.responder();
        let Some(window) = responder.window() else {
            return;
        };
        if editor.focused()
            || self.cx.get().is_none_or(|(_, view, _)| !view.can_reach())
            || surface
                .is_some_and(|surface| !crate::navigation::in_focus_scope(surface, &responder))
        {
            return;
        }
        let had_pending_selection = self.pending_selection.get().is_some();
        if let Some(surface) = surface {
            enter_changing(surface);
        }
        window.makeFirstResponder(Some(&responder));
        if !had_pending_selection
            && let Editor::Line { field, .. } = &editor
            && let Some(editing) = field.currentEditor()
        {
            editing.setSelectedRange(NSRange::new(editing.string().length(), 0));
        }
        if let Some(surface) = surface {
            leave_changing(surface);
            if !is_changing(surface) {
                flush_pending(surface);
                maybe_disarm(surface);
            }
        }
    }
}

/// Sets up an input view.
pub(crate) fn create(surface: &Rc<Surface>, view: &NshView) {
    let mtm = surface.mtm;
    let input = Rc::new_cyclic(|weak| {
        let cx = Ctx {
            surface: Rc::downgrade(surface),
            view: objc2::rc::Weak::new(view.ns()),
            input: weak.clone(),
        };
        let delegate = InputDelegate::alloc(mtm).set_ivars(cx.clone());
        // SAFETY: NSObject's initializer.
        let delegate: Retained<InputDelegate> = unsafe { msg_send![super(delegate), init] };
        let placeholder = NSTextField::labelWithString(&NSString::new(), mtm);
        placeholder.setHidden(true);
        placeholder.setSelectable(false);
        if let Some(cell) = placeholder.cell() {
            cell.setWraps(true);
            cell.setLineBreakMode(NSLineBreakMode::ByWordWrapping);
        }
        InputState {
            editor: RefCell::new(new_editor(mtm, &cx, &delegate, false, false)),
            undo_manager: RefCell::new(None),
            delegate,
            pad: InputPad::create(mtm),
            placeholder,
            config: RefCell::new(InputConfig::default()),
            configured: Cell::new(false),
            focus_pending: Cell::new(false),
            content: Cell::new(None),
            count: Cell::new(0),
            applying: Cell::new(false),
            clipping: Cell::new(false),
            focused: Cell::new(false),
            selection: Cell::new((0, 0)),
            caret: Cell::new(Bounds::default()),
            pending_selection: Cell::new(None),
            known: RefCell::new(String::new()),
            composition: RefCell::new(None),
            #[cfg(feature = "terminal")]
            terminal_original: RefCell::new(None),
            pending_value: RefCell::new(None),
            editing: Cell::new(false),
            focusing: Cell::new(false),
            key_mods: Cell::new(NSEventModifierFlags::empty()),
            anim_color: Cell::new(None),
            cx,
        }
    });
    view.state_mut().input = Some(input);
}

/// A new editor, hooked to `delegate`.
fn new_editor(
    mtm: MainThreadMarker,
    cx: &Ctx,
    delegate: &InputDelegate,
    multiline: bool,
    secure: bool,
) -> Editor {
    if multiline {
        let scroller =
            NSScrollView::initWithFrame(NSScrollView::alloc(mtm), ns_rect(0.0, 0.0, 100.0, 40.0));
        scroller.setBorderType(NSBorderType::NoBorder);
        scroller.setDrawsBackground(false);
        scroller.setHasVerticalScroller(true);
        scroller.setHasHorizontalScroller(false);
        scroller.setAutohidesScrollers(true);
        let size = scroller.contentSize();
        let cell = OnceCell::new();
        let _ = cell.set(cx.clone());
        let this = TextArea::alloc(mtm).set_ivars(cell);
        // SAFETY: NSTextView's initializer (it makes its own text system).
        let area: Retained<TextArea> = unsafe {
            msg_send![super(this), initWithFrame: ns_rect(0.0, 0.0, size.width as f32, size.height as f32)]
        };
        // SAFETY: the class is a subclass of NSTextView.
        let view: Retained<NSTextView> = unsafe { Retained::cast_unchecked(area) };
        // SAFETY: initWithFrame creates a text system; retaining its storage
        // here keeps the target alive through undo cleanup.
        let storage = unsafe { view.textStorage() }
            .expect("NSTextView's frame initializer creates a text storage");
        view.setMinSize(CGSize::new(0.0, size.height));
        view.setMaxSize(CGSize::new(CGFloat::MAX, CGFloat::MAX));
        view.setVerticallyResizable(true);
        view.setHorizontallyResizable(false);
        view.setAutoresizingMask(objc2_app_kit::NSAutoresizingMaskOptions::ViewWidthSizable);
        view.setDrawsBackground(false);
        view.setRichText(false);
        view.setImportsGraphics(false);
        view.setAllowsUndo(true);
        view.setTextContainerInset(CGSize::new(0.0, 0.0));
        // SAFETY: the text view's own container.
        if let Some(container) = unsafe { view.textContainer() } {
            container.setLineFragmentPadding(0.0);
            container.setWidthTracksTextView(true);
            container.setContainerSize(CGSize::new(size.width, CGFloat::MAX));
        }
        view.setDelegate(Some(ProtocolObject::from_ref(delegate)));
        scroller.setDocumentView(Some(&view));
        // Scrolling the text moves the caret (`onSelectionChange`).
        // SAFETY: a scroll view's clip view (an `NSView`), always present.
        let clip: Retained<NSView> = unsafe { msg_send![&scroller, contentView] };
        clip.setPostsBoundsChangedNotifications(true);
        // SAFETY: the delegate answers the selector (`clipBoundsChanged:`);
        // a selector-based observer goes away with it.
        unsafe {
            objc2_foundation::NSNotificationCenter::defaultCenter()
                .addObserver_selector_name_object(
                    delegate,
                    sel!(clipBoundsChanged:),
                    Some(objc2_app_kit::NSViewBoundsDidChangeNotification),
                    Some(&clip),
                );
        }
        // A built-in bar also follows the text's height and the viewport's
        // (`InputConfig::replaced`).
        view.setPostsFrameChangedNotifications(true);
        clip.setPostsFrameChangedNotifications(true);
        for object in [&***view as &NSView, &*clip] {
            // SAFETY: the delegate answers the selector (`textFrameChanged:`);
            // a selector-based observer goes away with it.
            unsafe {
                objc2_foundation::NSNotificationCenter::defaultCenter()
                    .addObserver_selector_name_object(
                        delegate,
                        sel!(textFrameChanged:),
                        Some(objc2_app_kit::NSViewFrameDidChangeNotification),
                        Some(object),
                    );
            }
        }
        Editor::Area {
            scroller,
            view,
            storage,
        }
    } else {
        let field = if secure {
            SecureField::create(mtm, cx.clone())
        } else {
            TextField::create(mtm, cx.clone())
        };
        field.setBezeled(false);
        field.setBordered(false);
        field.setDrawsBackground(false);
        field.setFocusRingType(NSFocusRingType::None);
        field.setSelectable(true);
        field.setAllowsEditingTextAttributes(false);
        if let Some(cell) = field.cell() {
            cell.setScrollable(true);
            cell.setWraps(false);
            cell.setAllowsUndo(true);
            // Not single-line mode: it replaces pasted line breaks in a
            // second edit, which `Ctx::should_change` does at once.
            cell.setLineBreakMode(NSLineBreakMode::ByClipping);
        }
        // SAFETY: the delegate lives as long as the input that holds it.
        unsafe { field.setDelegate(Some(ProtocolObject::from_ref(delegate))) };
        Editor::Line { field, secure }
    }
}

impl Drop for InputState {
    fn drop(&mut self) {
        let fallback = self.undo_manager.get_mut().clone();
        self.editor.get_mut().clear_undo(fallback.as_ref());
    }
}

/// `Input`.
pub(crate) fn config(surface: &Rc<Surface>, view: &NshView, config: &InputConfig) {
    let Some(input) = view.state().input.clone() else {
        return;
    };
    let became_readonly = input.config.borrow().editable && !config.editable;
    let became_editable = !input.config.borrow().editable && config.editable;
    let swap = match &*input.editor.borrow() {
        Editor::Line { secure, .. } => config.multiline || *secure != config.secure,
        Editor::Area { .. } => !config.multiline,
    };
    if swap {
        let old = input.editor.borrow().clone();
        let text = old.text();
        input.clear_undo(&old);
        let focused = input.focused.get();
        if focused {
            input.cx.unfocus();
        }
        old.host().removeFromSuperview();
        if let Editor::Area { .. } = old {
            input.placeholder.removeFromSuperview();
        }
        let editor = new_editor(
            surface.mtm,
            &input.cx,
            &input.delegate,
            config.multiline,
            config.secure,
        );
        *input.editor.borrow_mut() = editor.clone();
        input.replace_text(&text);
        *input.config.borrow_mut() = config.clone();
        place(view, &input);
        if focused {
            input.focus_editor(Some(surface));
        }
    }

    let editor = input.editor.borrow().clone();
    let font = crate::text::ns_font(&config.style);
    let color = ns_color(input.anim_color.get().unwrap_or(config.style.color));
    let align = alignment(config.align);
    let direction = if config.rtl {
        NSWritingDirection::RightToLeft
    } else {
        NSWritingDirection::Natural
    };
    match &editor {
        Editor::Line { field, .. } => {
            field.setFont(Some(&font));
            field.setTextColor(Some(&color));
            field.setAlignment(align);
            field.setBaseWritingDirection(direction);
            field.setEditable(config.editable);
            field.setSelectable(true);
            field.setPlaceholderAttributedString(Some(&placeholder(config, &font, align)));
            if let Some(editor) = field.currentEditor() {
                editor.setFont(Some(&font));
                editor.setTextColor(Some(&color));
                editor.setAlignment(align);
                editor.setEditable(config.editable);
                editor.setSelectable(true);
            }
        }
        Editor::Area {
            scroller,
            view: text,
            ..
        } => {
            // A built-in bar of the app's takes the indicator's place; the
            // text still scrolls with the wheel, the keys and the caret.
            scroller.setHasVerticalScroller(config.scrollbar_visible);
            text.setFont(Some(&font));
            text.setTextColor(Some(&color));
            text.setAlignment(align);
            text.setBaseWritingDirection(direction);
            text.setEditable(config.editable);
            text.setSelectable(true);
            text.setContinuousSpellCheckingEnabled(config.auto_correct);
            text.setAutomaticSpellingCorrectionEnabled(config.auto_correct);
            let line = LineBox::new(config.style.line_height.0 as CGFloat, natural_height(&font));
            text.setDefaultParagraphStyle(Some(&paragraph(line, align)));
            // The space above the first line and below the last.
            text.setTextContainerInset(CGSize::new(0.0, line.inset));
            let label = &input.placeholder;
            label.setFont(Some(&font));
            label.setTextColor(Some(&placeholder_color(config)));
            label.setAlignment(align);
            label.setBaseWritingDirection(direction);
            label.setStringValue(&NSString::from_str(&config.placeholder));
        }
    }
    *input.config.borrow_mut() = config.clone();
    if became_readonly && input.focused.get() {
        surface
            .focus_generation
            .set(surface.focus_generation.get().wrapping_add(1));
        #[cfg(feature = "terminal")]
        terminal_cancel_input(&input);
        if let Some(text) = editor
            .editing()
            .and_then(|text| text.downcast::<NSTextView>().ok())
            && text.hasMarkedText()
        {
            text.unmarkText();
        }
        input.editing.set(false);
        input.cx.compose(&input, None);
    }
    if became_editable && input.focused.get() {
        surface
            .focus_generation
            .set(surface.focus_generation.get().wrapping_add(1));
    }
    if editor.focused() {
        input.style_editor();
    }
    input.update_placeholder();
    let first = !input.configured.replace(true);
    if first && config.auto_focus {
        auto_focus(surface, &input);
    }
    place(view, &input);
    report_scroll(surface, view, &input);
    if became_editable && input.focused.get() {
        flush_pending(surface);
    }
}

/// Clears text undo records before a deleted input's editor can be released.
pub(crate) fn deleted(view: &NshView) {
    let Some(input) = view.state().input.clone() else {
        return;
    };
    let editor = input.editor.borrow().clone();
    input.clear_undo(&editor);
}

/// Reports how far a multiline input's text scrolled while a built-in bar
/// takes the place of its indicator (`InputConfig::replaced`).
fn report_scroll(surface: &Surface, view: &NshView, input: &InputState) {
    if !input.config.borrow().replaced {
        return;
    }
    let Editor::Area {
        scroller,
        view: text,
        ..
    } = &*input.editor.borrow()
    else {
        return;
    };
    // SAFETY: a scroll view's clip view (an `NSView`), always present.
    let clip: Retained<NSView> = unsafe { msg_send![&**scroller, contentView] };
    // The clip view is flipped as the text view is: its bounds origin is
    // the offset from the top.
    let bounds = clip.bounds();
    let width = bounds.size.width as f32;
    let page = bounds.size.height as f32;
    let height = (text.frame().size.height as f32).max(page);
    let id = view.state().id;
    surface.control(|c| {
        c.input_scroll(
            id,
            Point {
                x: Points(0.0),
                y: px(bounds.origin.y as f32),
            },
            Size {
                width: px(width),
                height: px(height),
            },
            Size {
                width: px(width),
                height: px(page),
            },
        );
    });
}

/// `Command::ScrollTo` for a multiline input: scrolls its text (a built-in
/// bar's drags).
pub(crate) fn scroll_to(view: &NshView, y: Points, animated: bool) {
    let Some(input) = view.state().input.clone() else {
        return;
    };
    let Editor::Area {
        scroller,
        view: text,
        ..
    } = &*input.editor.borrow()
    else {
        return;
    };
    // SAFETY: a scroll view's clip view (an `NSView`), always present.
    let clip: Retained<NSView> = unsafe { msg_send![&**scroller, contentView] };
    let bounds = clip.bounds();
    let max = (text.frame().size.height - bounds.size.height).max(0.0);
    let origin = NSPoint::new(bounds.origin.x, (y.0 as CGFloat).clamp(0.0, max));
    if animated {
        // SAFETY: every view has an animator proxy, which answers the
        // view's setters with an animation.
        unsafe {
            let animator: Retained<AnyObject> = msg_send![&clip, animator];
            let _: () = msg_send![&animator, setBoundsOrigin: origin];
        }
    } else {
        clip.setBoundsOrigin(origin);
    }
    // SAFETY: the scroll view's own clip view.
    let _: () = unsafe { msg_send![&**scroller, reflectScrolledClipView: &*clip] };
}

/// The horizontal alignment of the text; natural follows the writing
/// direction.
fn alignment(align: TextAlign) -> NSTextAlignment {
    match align {
        TextAlign::Auto => NSTextAlignment::Natural,
        TextAlign::Left => NSTextAlignment::Left,
        TextAlign::Center => NSTextAlignment::Center,
        TextAlign::Right => NSTextAlignment::Right,
        TextAlign::Justify => NSTextAlignment::Justified,
    }
}

/// The height the text system gives a line of `font`.
fn natural_height(font: &objc2_app_kit::NSFont) -> CGFloat {
    objc2_app_kit::NSLayoutManager::new().defaultLineHeightForFont(font)
}

/// How a text view's lines take a configured line height. AppKit's caret
/// is as tall as a line fragment, and a fragment with a minimum line height
/// holds its extra space above the text: a caret that reaches well above
/// the text, and text low in its line. So a fragment holds only the text
/// (`fragment`), the next line starts `spacing` below it, and the text
/// container's `inset` puts half of that above the first line and below the
/// last, which AppKit leaves out: lines of the configured height with their
/// text in the middle, as CSS's half-leading and the core's measure have it.
#[derive(Debug, Clone, Copy, PartialEq)]
struct LineBox {
    /// A line fragment's height (0: the font's).
    fragment: CGFloat,
    /// The space between line fragments.
    spacing: CGFloat,
    /// The space above the first line and below the last.
    inset: CGFloat,
}

impl LineBox {
    /// Lines of `line_height` (0: the font's) in a font whose lines are
    /// `natural` tall. A line height below the font's clips the fragment.
    fn new(line_height: CGFloat, natural: CGFloat) -> LineBox {
        if line_height <= 0.0 {
            return LineBox {
                fragment: 0.0,
                spacing: 0.0,
                inset: 0.0,
            };
        }
        let fragment = line_height.min(natural);
        let spacing = line_height - fragment;
        LineBox {
            fragment,
            spacing,
            inset: spacing / 2.0,
        }
    }
}

/// A text view's paragraph style: alignment and lines.
fn paragraph(line: LineBox, align: NSTextAlignment) -> Retained<NSMutableParagraphStyle> {
    let style = NSMutableParagraphStyle::new();
    style.setAlignment(align);
    if line.fragment > 0.0 {
        style.setMinimumLineHeight(line.fragment);
        style.setMaximumLineHeight(line.fragment);
        style.setLineSpacing(line.spacing);
    }
    style
}

/// The placeholder's color: the config's, else the text color at half its
/// opacity.
fn placeholder_color(config: &InputConfig) -> Retained<NSColor> {
    let c = config.style.color;
    ns_color(config.placeholder_color.unwrap_or(c.with_alpha(0.5)))
}

/// A field's placeholder, in the field's font.
fn placeholder(
    config: &InputConfig,
    font: &objc2_app_kit::NSFont,
    align: NSTextAlignment,
) -> Retained<NSAttributedString> {
    let color = placeholder_color(config);
    // AppKit's single-line field editor uses the font's natural line
    // height. A fixed paragraph height here would move only the
    // placeholder's baseline, away from the text and caret.
    let paragraph = NSMutableParagraphStyle::new();
    paragraph.setAlignment(align);
    // SAFETY: immutable AppKit attribute keys with values of their
    // documented types (NSFont, NSColor, NSParagraphStyle).
    let keys = unsafe {
        [
            NSFontAttributeName,
            NSForegroundColorAttributeName,
            NSParagraphStyleAttributeName,
        ]
    };
    let values: [&AnyObject; 3] = [font.as_ref(), color.as_ref(), paragraph.as_ref()];
    let attributes = NSDictionary::from_slices(&keys, &values);
    // SAFETY: a string and a dictionary of valid attributes.
    unsafe {
        NSAttributedString::initWithString_attributes(
            NSAttributedString::alloc(),
            &NSString::from_str(&config.placeholder),
            Some(&attributes),
        )
    }
}

/// Focuses the input once it is in a window (`autoFocus`): the view is
/// configured before it is inserted.
fn auto_focus(surface: &Rc<Surface>, input: &Rc<InputState>) {
    input.focus_pending.set(true);
    let weak = Rc::downgrade(input);
    FOCUS.with(|f| {
        f.borrow_mut()
            .entry(surface.key())
            .or_default()
            .auto_focus
            .push(weak.clone());
    });
    let mut frames = 0;
    surface.add_draw_callback(move |surface, _| {
        frames += 1;
        let Some(input) = weak.upgrade() else {
            return false;
        };
        if !input.focus_pending.get() {
            return false;
        }
        let blocked = input
            .cx
            .get()
            .is_some_and(|(_, view, _)| view.ns().window().is_some() && !view.can_reach());
        if blocked {
            input.focus_pending.set(false);
            return false;
        }
        let editor = input.editor.borrow().clone();
        if editor.responder().window().is_none() {
            // Not on screen yet; an input never shown stops trying.
            if frames >= 120 {
                input.focus_pending.set(false);
                return false;
            }
            return true;
        }
        input.focus_pending.set(false);
        input.focus_editor(Some(surface));
        false
    });
}

/// Focuses any `autoFocus` inputs inserted during the batch as soon as the
/// batch finishes, before queued engine events catch up.
pub(crate) fn end_batch(surface: &Rc<Surface>) {
    let candidates = FOCUS.with(|f| {
        f.borrow_mut()
            .get_mut(&surface.key())
            .map(|focus| std::mem::take(&mut focus.auto_focus))
            .unwrap_or_default()
    });
    if candidates.is_empty() {
        return;
    }
    let mut keep = Vec::new();
    for weak in candidates {
        let Some(input) = weak.upgrade() else {
            continue;
        };
        if !input.focus_pending.get() {
            continue;
        }
        let blocked = input
            .cx
            .get()
            .is_some_and(|(_, view, _)| view.ns().window().is_some() && !view.can_reach());
        let editor = input.editor.borrow().clone();
        if blocked {
            input.focus_pending.set(false);
        } else if editor.responder().window().is_some() {
            input.focus_pending.set(false);
            input.focus_editor(Some(surface));
        } else {
            keep.push(weak);
        }
    }
    if !keep.is_empty() {
        FOCUS.with(|f| {
            f.borrow_mut()
                .entry(surface.key())
                .or_default()
                .auto_focus
                .extend(keep);
        });
    }
}

/// A pending autofocus must not steal focus after a virtual row's native
/// subtree has detached but its input owner has not been deleted yet.
pub(crate) fn cancel_auto_focus(view: &NshView) {
    if let Some(input) = view.state().input.as_ref() {
        input.focus_pending.set(false);
    }
    for child in view.child_views() {
        cancel_auto_focus(&child);
    }
}

/// The input view's frame changed (`crate::view::NshView::place`): places
/// the editor again, or hides it while the view has no area.
pub(crate) fn resized(view: &NshView) {
    let Some(input) = view.state().input.clone() else {
        return;
    };
    place(view, &input);
}

/// Places the pad over the whole view and the editor (and a text view's
/// placeholder) in it at the content box (`crate::native::resized` keeps
/// the pad at the view's size). While the view or its content box has no
/// area (a `display: none` subtree lays its views out at a zero frame) the
/// pad is hidden: it does not clip, so the editor would keep drawing at its
/// last frame.
fn place(view: &NshView, input: &InputState) {
    let frame = view.state().frame;
    let bounds = Bounds {
        origin: Point {
            x: Points(0.0),
            y: Points(0.0),
        },
        size: Size {
            width: frame.size.width,
            height: frame.size.height,
        },
    };
    let content = input.content.get().unwrap_or(bounds);
    let empty = |r: Bounds<Points>| r.size.width.0 <= 0.0 || r.size.height.0 <= 0.0;
    let hidden = empty(bounds) || empty(content);
    if input.pad.isHidden() != hidden {
        input.pad.setHidden(hidden);
    }
    if hidden {
        return;
    }
    view.set_native(&input.pad, bounds);
    let pad = &input.pad;
    let host = |sub: &NSView, r: Bounds<Points>| {
        if crate::view::superview(sub).as_deref() != Some(&**pad) {
            pad.addSubview(sub);
        }
        sub.setFrame(ns_rect(
            r.origin.x.0,
            r.origin.y.0,
            r.size.width.0,
            r.size.height.0,
        ));
    };
    if let Some(window) = view.ns().window()
        && !window.autorecalculatesKeyViewLoop()
    {
        // Tab goes through the fields in their order on screen, however
        // they were added.
        window.setAutorecalculatesKeyViewLoop(true);
    }
    match &*input.editor.borrow() {
        Editor::Line { field, .. } => {
            // One line, centered in the box as UIKit centers it; a box
            // shorter than the line grows around its center. The cell
            // insets its text by the field editor's line padding: the
            // field reaches past the box by as much, so the text starts at
            // the content box.
            let pad = FIELD_PADDING;
            let height = field.intrinsicContentSize().height as f32;
            let rect = Bounds {
                origin: Point {
                    x: Points(content.origin.x.0 - pad),
                    y: Points(content.origin.y.0 + (content.size.height.0 - height) / 2.0),
                },
                size: Size {
                    width: Points(content.size.width.0 + 2.0 * pad),
                    height: Points(height),
                },
            };
            host(field, rect);
        }
        Editor::Area { scroller, view, .. } => {
            // The placeholder goes first: hosted views stack in order. A
            // label insets its text as a field does; it starts where the
            // editor's first line of text does.
            let top = px(view.textContainerInset().height as f32);
            let label = Bounds {
                origin: Point::new(content.origin.x - px(FIELD_PADDING), content.origin.y + top),
                size: Size::new(
                    content.size.width + px(2.0 * FIELD_PADDING),
                    content.size.height - top,
                ),
            };
            host(&input.placeholder, label);
            host(scroller, content);
        }
    }
}

/// How far a borderless field's cell insets its text horizontally.
const FIELD_PADDING: f32 = 2.0;

/// The text input `view` holds now (`None`: it is no input).
#[cfg(feature = "dev")]
pub(crate) fn current_text(view: &NshView) -> Option<String> {
    let input = view.state().input.clone()?;
    let text = input.editor.borrow().text();
    Some(text)
}

/// `InputValue`: JS's text, unless the user typed since JS saw `count`;
/// during a composition it waits for the composition to end.
pub(crate) fn value(view: &NshView, text: &str, count: u32) {
    let Some(input) = view.state().input.clone() else {
        return;
    };
    let editor = input.editor.borrow().clone();
    if input.composition.borrow().is_some() || editor.marked_text().is_some() {
        *input.pending_value.borrow_mut() = Some((text.to_owned(), count));
        return;
    }
    *input.pending_value.borrow_mut() = None;
    input.apply_value(text, count);
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
    let color = input.text_color();
    match &*input.editor.borrow() {
        Editor::Line { field, .. } => {
            field.setTextColor(Some(&color));
            if let Some(editor) = field.currentEditor() {
                editor.setTextColor(Some(&color));
            }
        }
        Editor::Area { view, .. } => view.setTextColor(Some(&color)),
    }
}

/// `InputContent`.
pub(crate) fn content(view: &NshView, content: Bounds<Points>) {
    let Some(input) = view.state().input.clone() else {
        return;
    };
    input.content.set(Some(content));
    place(view, &input);
    input.cx.caret_moved();
}

/// An input accessory inserted into `parent`. There is no software
/// keyboard to show it over on the desktop, so it stays unmounted.
pub(crate) fn accessory(_surface: &Rc<Surface>, _parent: &NshView, child: &NshView) {
    log::debug!("input accessory {} is not shown on macOS", child.id());
}

/// The element VoiceOver is on while `view` has the keyboard focus: an
/// input's editor (its field, or its text view), else the view.
pub(crate) fn accessibility_element(view: &NshView) -> Retained<NSView> {
    let editor = view
        .state()
        .input
        .as_ref()
        .map(|i| i.editor.borrow().clone());
    match editor {
        Some(Editor::Line { field, .. }) => Retained::into_super(Retained::into_super(field)),
        Some(Editor::Area { view, .. }) => Retained::into_super(Retained::into_super(view)),
        None => objc2::Message::retain(view.ns()),
    }
}

/// `focus()`.
pub(crate) fn focus(view: &NshView) {
    let input = view.state().input.clone();
    if let Some(input) = input {
        let surface = input.cx.surface.upgrade();
        input.focus_editor(surface.as_ref());
    }
}

/// `blur()`.
pub(crate) fn blur(view: &NshView) {
    let input = view.state().input.clone();
    if let Some(input) = input {
        input.cx.unfocus();
    }
}

/// Unfocuses whatever input of the surface has focus, in any of its
/// windows (the main one and the app's own).
pub(crate) fn blur_all(surface: &Rc<Surface>) {
    let roots = std::iter::once(surface.root.clone()).chain(crate::window::roots(surface));
    for root in roots {
        if let Some(window) = root.ns().window()
            && editing_in(&root)
        {
            to_root(&window, surface);
        }
    }
    if !has_pending(surface) {
        disarm(surface);
    }
}

/// Commits what an input method composes in `view` (its marked text) as
/// the editor loses the focus, as a browser's blur does: the input method
/// drops its session and the composed text is inserted as its commit
/// inserts it, so the input reports the text before the composition's end.
/// AppKit would unmark it in place, which the input hears of as a
/// selection change while the text is being replaced, and so ended the
/// composition first.
fn commit_marked(view: &NSTextView) {
    if !view.hasMarkedText() {
        return;
    }
    let range = view.markedRange();
    let composed = view.string().substringWithRange(range);
    if let Some(context) = view.inputContext() {
        context.discardMarkedText();
    }
    // SAFETY: an NSString over the marked range, which is in the text.
    unsafe { view.insertText_replacementRange(&composed, range) };
}

/// Ends editing and gives the keyboard focus to the root `window` shows.
/// The window takes it first: the root refuses it while a field edits
/// during a click (a click elsewhere leaves the focus in the field).
pub(crate) fn to_root(window: &objc2_app_kit::NSWindow, surface: &Surface) {
    window.makeFirstResponder(None);
    window.makeFirstResponder(Some(crate::input::root_in(surface, window).ns()));
}

/// Whether one of the surface's inputs has the keyboard focus in the window
/// of the event being handled (a click elsewhere leaves it there, as
/// desktops do).
pub(crate) fn editing(surface: &Surface) -> bool {
    editing_in(&crate::input::event_root(surface))
}

/// Whether an input under `root` has its window's keyboard focus.
pub(crate) fn editing_in(root: &NshView) -> bool {
    let root = root.ns();
    let Some(responder) = root.window().and_then(|w| w.firstResponder()) else {
        return false;
    };
    responder
        .downcast_ref::<NSTextView>()
        .is_some_and(|text| text.isDescendantOf(root))
}

/// `setSelection` (UTF-16 offsets).
pub(crate) fn set_selection(view: &NshView, start: u32, end: u32) {
    let Some(input) = view.state().input.clone() else {
        return;
    };
    let selected = input.editor.borrow().select(start, end);
    if !selected {
        // A field only has a selection while it is edited.
        input.pending_selection.set(Some((start, end)));
    }
}

/// Sets the `focused` interaction state of `view`, which the core hears
/// whatever the view tracks (`nsh_core::input::reported_states`).
fn set_focused(surface: &Surface, view: &NshView, on: bool) {
    let (id, next) = {
        let mut s = view.state_mut();
        let Some(next) = nsh_core::input::next_states(s.tracked, s.states, state::FOCUSED, on)
        else {
            return;
        };
        s.states = next;
        (s.id, next)
    };
    surface.control(|c| c.set_states(id, next));
}

/// `color` in sRGB.
fn ns_color(color: Color) -> Retained<NSColor> {
    let (r, g, b, a) = color.to_f64();
    NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, a)
}

/// The key an insertion reports (`onKeyPress`).
fn key_of(text: &str) -> &str {
    if text == "\n" || text == "\r" {
        "Enter"
    } else {
        text
    }
}

/// Length of `s` in UTF-16 units.
fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
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

/// The focused input of `surface` and the `NSTextView` currently editing it.
fn focused_editor(surface: &Surface) -> Option<(NshView, Rc<InputState>, Retained<NSTextView>)> {
    let window = crate::window::key_root(surface).ns().window()?;
    let responder = window.firstResponder()?;
    let object: &AnyObject = &responder;
    let cx = if let Some(area) = object.downcast_ref::<TextArea>() {
        area.ivars().get().cloned()
    } else if let Some(editor) = object.downcast_ref::<FieldEditor>() {
        field_ctx(editor)
    } else if let Some(editor) = object.downcast_ref::<NSTextView>() {
        let delegate = editor.delegate()?;
        let object: &AnyObject = ProtocolObject::as_ref(&*delegate);
        object
            .downcast_ref::<SecureField>()
            .and_then(|field| field.ivars().get().cloned())
    } else {
        None
    }?;
    let (owner_surface, view, input) = cx.get()?;
    if owner_surface.key() != surface.key()
        || !input.focused.get()
        || !view.can_reach()
        || !view
            .ns()
            .isDescendantOf(&crate::navigation::focus_scope_of(surface, &window))
    {
        return None;
    }
    let editor = input
        .editor
        .borrow()
        .editing()?
        .downcast::<NSTextView>()
        .ok()?;
    Some((view, input, editor))
}

/// Whether `surface`'s focused input is currently composing marked text.
pub(crate) fn composing_focused(surface: &Surface) -> bool {
    focused_editor(surface).is_some_and(|(view, input, editor)| {
        #[cfg(not(feature = "terminal"))]
        let _ = view;
        #[cfg(feature = "terminal")]
        if !is_replaying(surface) {
            let expected = (view.state().id, surface.focus_generation.get());
            if let Some(active) = FOCUS.with(|f| {
                f.borrow().get(&surface.key()).and_then(|focus| {
                    focus.pending.iter().rev().find_map(|held| match held {
                        Held::TerminalComposition {
                            expected: item_expected,
                            active,
                            ..
                        } if *item_expected == expected => Some(*active),
                        _ => None,
                    })
                })
            }) {
                return active;
            }
        }
        #[cfg(feature = "terminal")]
        if input.terminal_original.borrow().is_some() {
            return true;
        }
        editor.hasMarkedText() || input.composition.borrow().is_some()
    })
}

/// Whether `surface` has an editable focused input ready to accept text.
pub(crate) fn wants_text(surface: &Surface) -> bool {
    focused_editor(surface)
        .is_some_and(|(_, input, editor)| input.config.borrow().editable && editor.isEditable())
}

// --- Focus fence -------------------------------------------------------------

enum Held {
    NsKey {
        event: Retained<NSEvent>,
        needs_editable: bool,
    },
    MenuPaste {
        plain: bool,
    },
    #[cfg(any(feature = "dev", feature = "terminal"))]
    Paste {
        window: Retained<objc2_app_kit::NSWindow>,
        content: nsh_core::PasteEvent,
    },
    #[cfg(feature = "terminal")]
    TerminalKey {
        window: Retained<objc2_app_kit::NSWindow>,
        key: nsh_terminal::Keystroke,
        down: bool,
        repeat: bool,
        needs_editable: bool,
    },
    #[cfg(feature = "terminal")]
    TerminalComposition {
        expected: (u32, u64),
        commit: String,
        preedit: String,
        selection: NSRange,
        active: bool,
    },
}

#[derive(Default)]
struct Focus {
    auto_focus: Vec<Weak<InputState>>,
    pending: VecDeque<Held>,
    armed: bool,
    after: u64,
    changing: u32,
    replaying: bool,
}

thread_local! {
    static FOCUS: RefCell<FxHashMap<u64, Focus>> = RefCell::default();
}

pub(crate) fn stopped(surface: &Surface) {
    FOCUS.with(|f| {
        if let Some(focus) = f.borrow_mut().get_mut(&surface.key()) {
            focus.auto_focus.clear();
            focus.pending.clear();
            focus.armed = false;
            focus.after = 0;
            focus.changing = 0;
            focus.replaying = false;
        }
    });
}

pub(crate) fn disposed(key: u64) {
    let _ = FOCUS.try_with(|f| f.borrow_mut().remove(&key));
}

fn enter_changing(surface: &Surface) {
    FOCUS.with(|f| {
        let mut map = f.borrow_mut();
        let focus = map.entry(surface.key()).or_default();
        focus.changing = focus.changing.saturating_add(1);
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

fn with_replaying(surface: &Surface, run: impl FnOnce()) {
    let prev = FOCUS.with(|f| {
        let mut map = f.borrow_mut();
        let focus = map.entry(surface.key()).or_default();
        std::mem::replace(&mut focus.replaying, true)
    });
    run();
    FOCUS.with(|f| {
        if let Some(focus) = f.borrow_mut().get_mut(&surface.key()) {
            focus.replaying = prev;
        }
    });
}

pub(crate) fn arm(surface: &Surface) {
    let after = surface.events_sent();
    FOCUS.with(|f| {
        let mut map = f.borrow_mut();
        let focus = map.entry(surface.key()).or_default();
        focus.armed = true;
        focus.after = after;
    });
    if !surface.terminal.get() {
        crate::keymap::ensure_monitor(surface);
    }
}

pub(crate) fn disarm(surface: &Surface) {
    FOCUS.with(|f| {
        if let Some(focus) = f.borrow_mut().get_mut(&surface.key()) {
            focus.pending.clear();
            focus.armed = false;
        }
    });
    crate::keymap::sync_monitor(surface);
}

pub(crate) fn maybe_disarm(surface: &Surface) {
    if !behind(surface)
        && !has_pending(surface)
        && !has_pending_auto_focus(surface)
        && !is_changing(surface)
    {
        disarm(surface);
    }
}

pub(crate) fn is_armed(surface: &Surface) -> bool {
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

pub(crate) fn has_pending_auto_focus(surface: &Surface) -> bool {
    FOCUS.with(|f| {
        f.borrow().get(&surface.key()).is_some_and(|focus| {
            focus.auto_focus.iter().any(|weak| {
                weak.upgrade()
                    .is_some_and(|input| input.focus_pending.get())
            })
        })
    })
}

fn behind(surface: &Surface) -> bool {
    let after = FOCUS.with(|f| f.borrow().get(&surface.key()).map_or(0, |f| f.after));
    surface.events_handled() < after
}

pub(crate) fn engine_caught_up(surface: &Rc<Surface>) {
    if is_armed(surface) && !behind(surface) {
        flush_pending(surface);
        maybe_disarm(surface);
    }
}

pub(crate) fn removing(surface: &Surface, view: &NshView) {
    cancel_auto_focus(view);
    if let Some((focused, _, _)) = focused_editor(surface)
        && (focused.id() == view.id() || focused.ns().isDescendantOf(view.ns()))
    {
        arm(surface);
    }
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

fn hold_menu_paste(cx: &Ctx, plain: bool) -> bool {
    let Some((surface, _, _)) = cx.get() else {
        return false;
    };
    queue_if_unsettled(&surface, || Held::MenuPaste { plain })
}

fn replay_menu_paste(surface: &Surface, plain: bool) {
    let Some((_, _, editor)) = focused_editor(surface) else {
        return;
    };
    with_replaying(surface, || {
        // SAFETY: standard NSText paste actions accept a nil sender.
        unsafe {
            if plain {
                let _: () = msg_send![&*editor, pasteAsPlainText: None::<&AnyObject>];
            } else {
                editor.paste(None);
            }
        }
    });
}

pub(crate) fn hold_nsevent(surface: &Rc<Surface>, event: &NSEvent) -> bool {
    if is_replaying(surface) || event.r#type() != NSEventType::KeyDown {
        return false;
    }
    if cfg!(feature = "dev")
        && crate::keymap::keystroke(event).is_some_and(|keystroke| keystroke.reloads(Os::MacOs))
    {
        return false;
    }
    let flags = event.modifierFlags();
    let mods = NSEventModifierFlags::Command
        | NSEventModifierFlags::Control
        | NSEventModifierFlags::Option;
    let code = event.keyCode();
    if code == 53 && !flags.intersects(mods | NSEventModifierFlags::Shift) {
        if !composing_focused(surface) {
            disarm(surface);
        }
        return false;
    }
    let edits = matches!(
        code,
        36 | 76 | 51 | 117 | 48 | 123 | 124 | 125 | 126 | 115 | 119 | 116 | 121
    );
    let function = crate::keymap::function_key(code).is_some();
    let chord = flags.intersects(mods) && !matches!(code, 54..=63);
    let printable = !edits
        && !function
        && !chord
        && code != 53
        && event.characters().is_some_and(|chars| {
            let text = chars.to_string();
            !text.is_empty() && !text.chars().all(char::is_control)
        });
    if !(edits || function || chord || printable) {
        return false;
    }
    let needs_editable = printable;
    queue_if_unsettled(surface, || Held::NsKey {
        event: Retained::from(event),
        needs_editable,
    })
}

fn replay_nsevent(surface: &Rc<Surface>, event: &NSEvent) {
    let Some(window) = surface.root.ns().window() else {
        return;
    };
    with_replaying(surface, || {
        if crate::keymap::fires_now(surface, event) {
            return;
        }
        let flags = event.modifierFlags();
        if flags.contains(NSEventModifierFlags::Command) {
            if window.performKeyEquivalent(event) {
                return;
            }
            let app = NSApplication::sharedApplication(surface.mtm);
            if window.isKeyWindow()
                && app
                    .mainMenu()
                    .is_some_and(|menu| menu.performKeyEquivalent(event))
            {
                return;
            }
            if !flags.intersects(NSEventModifierFlags::Control | NSEventModifierFlags::Option)
                && let Some((_, input, editor)) = focused_editor(surface)
                && let Some(chars) = event.charactersIgnoringModifiers()
            {
                let key = chars.to_string();
                let secure = input.config.borrow().secure;
                // SAFETY: standard NSText / NSUndoManager actions accept a nil sender.
                unsafe {
                    match key.as_str() {
                        "a" => {
                            editor.selectAll(None);
                            return;
                        }
                        "c" if !secure => {
                            editor.copy(None);
                            return;
                        }
                        "x" if !secure => {
                            editor.cut(None);
                            return;
                        }
                        "v" => {
                            editor.paste(None);
                            return;
                        }
                        "z" => {
                            if let Some(undo) = editor.undoManager() {
                                if flags.contains(NSEventModifierFlags::Shift) {
                                    undo.redo();
                                } else {
                                    undo.undo();
                                }
                            }
                            return;
                        }
                        _ => {}
                    }
                }
            }
        }
        window.sendEvent(event);
    });
}

#[cfg(feature = "terminal")]
pub(crate) fn hold_terminal_key(
    surface: &Rc<Surface>,
    window: &objc2_app_kit::NSWindow,
    key: &nsh_terminal::Keystroke,
    down: bool,
    repeat: bool,
) -> bool {
    if is_replaying(surface) || !is_armed(surface) {
        return false;
    }
    let m = key.modifiers;
    if down && key.key == "escape" && !m.control && !m.alt && !m.shift && !m.platform {
        if !composing_focused(surface) {
            disarm(surface);
        }
        return false;
    }
    let edits = matches!(
        key.key.as_str(),
        "enter"
            | "return"
            | "backspace"
            | "delete"
            | "tab"
            | "left"
            | "right"
            | "up"
            | "down"
            | "home"
            | "end"
            | "pageup"
            | "pagedown"
    );
    let function = key
        .key
        .strip_prefix('f')
        .and_then(|n| n.parse::<usize>().ok())
        .is_some_and(|n| (1..=20).contains(&n));
    let chord = m.control || m.alt || m.platform;
    let printable = !edits
        && !function
        && !chord
        && key.key != "escape"
        && (key
            .key_char
            .as_deref()
            .is_some_and(|s| !s.is_empty() && !s.chars().all(char::is_control))
            || key.key == "space"
            || (key.key.chars().count() == 1 && !key.key.chars().all(char::is_control)));
    if down && !(edits || function || chord || printable) {
        return false;
    }
    let waiting_for_engine =
        behind(surface) || has_pending_auto_focus(surface) || is_changing(surface);
    FOCUS.with(|f| {
        let mut map = f.borrow_mut();
        let Some(focus) = map.get_mut(&surface.key()) else {
            return false;
        };
        if focus.pending.is_empty() && !waiting_for_engine {
            return false;
        }
        if !down
            && !focus
                .pending
                .iter()
                .rev()
                .find_map(|held| match held {
                    Held::TerminalKey {
                        key: prev,
                        down: prev_down,
                        ..
                    } if prev.key == key.key => Some(*prev_down),
                    _ => None,
                })
                .unwrap_or(false)
        {
            return false;
        }
        focus.pending.push_back(Held::TerminalKey {
            window: Retained::from(window),
            key: key.clone(),
            down,
            repeat,
            needs_editable: down && printable,
        });
        true
    })
}

fn flush_pending(surface: &Rc<Surface>) {
    if !is_armed(surface) && !wants_text(surface) {
        disarm(surface);
    }
    let mut taken = false;
    loop {
        if behind(surface) || is_changing(surface) {
            return;
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
            Held::NsKey { needs_editable, .. } => *needs_editable,
            Held::MenuPaste { .. } => true,
            #[cfg(any(feature = "dev", feature = "terminal"))]
            Held::Paste { .. } => true,
            #[cfg(feature = "terminal")]
            Held::TerminalKey { needs_editable, .. } => *needs_editable,
            #[cfg(feature = "terminal")]
            Held::TerminalComposition { .. } => true,
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
            return;
        }
        match next {
            Held::NsKey { event, .. } => replay_nsevent(surface, &event),
            Held::MenuPaste { plain } => replay_menu_paste(surface, plain),
            #[cfg(any(feature = "dev", feature = "terminal"))]
            Held::Paste { window, content } => {
                with_replaying(surface, || {
                    let _ = paste(&window, &content);
                });
            }
            #[cfg(feature = "terminal")]
            Held::TerminalKey {
                window,
                key,
                down,
                repeat,
                ..
            } => {
                with_replaying(surface, || {
                    let _ = crate::terminal::dispatch_terminal_key(
                        surface, &window, &key, down, repeat,
                    );
                });
            }
            #[cfg(feature = "terminal")]
            Held::TerminalComposition {
                expected,
                commit,
                preedit,
                selection,
                active,
            } => {
                if terminal_editor(surface).map(|(id, _)| id) == Some(expected.0)
                    && surface.focus_generation.get() == expected.1
                {
                    with_replaying(surface, || {
                        let _ = terminal_compose(surface, &commit, &preedit, selection, active);
                    });
                }
            }
        }
        taken = true;
    }
    if taken && !behind(surface) && !has_pending_auto_focus(surface) && !is_changing(surface) {
        disarm(surface);
    }
}

/// The focused native editor and its owning node, including window field editors.
#[cfg(feature = "terminal")]
pub(crate) fn terminal_editor(surface: &Surface) -> Option<(u32, Retained<NSTextView>)> {
    let (view, input, editor) = focused_editor(surface)?;
    if !input.config.borrow().editable || !editor.isEditable() {
        return None;
    }
    Some((view.state().id, editor))
}

#[cfg(feature = "terminal")]
pub(crate) fn terminal_caret(surface: &Surface) -> Option<Bounds<Points>> {
    let (id, _) = terminal_editor(surface)?;
    let mounter = surface.mounter.borrow();
    let view = mounter.views.get(&id)?;
    let input = view.state().input.clone()?;
    input.editor.borrow().caret(surface.root.ns())
}

/// Reads a focused editor without exposing secure input content.
#[cfg(feature = "terminal")]
pub(crate) fn terminal_text(surface: &Surface) -> Option<String> {
    let (id, editor) = terminal_editor(surface)?;
    let mounter = surface.mounter.borrow();
    let view = mounter.views.get(&id)?;
    let input = view.state().input.clone()?;
    if input.config.borrow().secure {
        return None;
    }
    Some(editor.string().to_string())
}

#[cfg(feature = "terminal")]
pub(crate) fn terminal_focused_editor(
    surface: &Surface,
) -> Option<(Retained<NSTextView>, bool, bool)> {
    let (_, input, editor) = focused_editor(surface)?;
    let config = input.config.borrow();
    let editable = config.editable && editor.isEditable();
    Some((editor, editable, config.secure))
}

#[cfg(feature = "terminal")]
fn terminal_cancel_input(input: &InputState) {
    let original = input.terminal_original.borrow_mut().take();
    let Some(range) = original else {
        return;
    };
    input.applying.set(true);
    let editor = input.editor.borrow().clone();
    if let Some(text) = editor
        .editing()
        .and_then(|text| text.downcast::<NSTextView>().ok())
    {
        text.unmarkText();
    }
    input.clear_undo(&editor);
    editor.set_text(&input.known.borrow());
    if !editor.select(
        range.location as u32,
        (range.location + range.length) as u32,
    ) {
        input.pending_selection.set(Some((
            range.location as u32,
            (range.location + range.length) as u32,
        )));
    }
    input.applying.set(false);
    input.update_placeholder();
}

#[cfg(feature = "terminal")]
pub(crate) fn terminal_compose_admitted(
    surface: &Rc<Surface>,
    commit: &str,
    preedit: &str,
    selection: NSRange,
    active: bool,
) -> bool {
    let Some((id, _)) = terminal_editor(surface) else {
        return false;
    };
    if commit.is_empty() && preedit.is_empty() && !active && !has_pending(surface) {
        return terminal_compose(surface, commit, preedit, selection, active);
    }
    let expected = (id, surface.focus_generation.get());
    if queue_if_unsettled(surface, || Held::TerminalComposition {
        expected,
        commit: commit.to_owned(),
        preedit: preedit.to_owned(),
        selection,
        active,
    }) {
        return true;
    }
    terminal_compose(surface, commit, preedit, selection, active)
}

#[cfg(feature = "terminal")]
pub(crate) fn terminal_compose(
    surface: &Surface,
    commit: &str,
    preedit: &str,
    selection: NSRange,
    active: bool,
) -> bool {
    let Some((id, editor)) = terminal_editor(surface) else {
        return false;
    };
    let input = {
        let mounter = surface.mounter.borrow();
        let Some(view) = mounter.views.get(&id) else {
            return false;
        };
        let Some(input) = view.state().input.clone() else {
            return false;
        };
        input
    };
    let events_before = surface.events_sent();
    let replacement = NSRange::new(isize::MAX as usize, 0);
    if !commit.is_empty() {
        terminal_cancel_input(&input);
        // SAFETY: NSString is a valid NSTextInputClient insertion; NSNotFound replaces the mark/selection.
        let _: () = unsafe {
            msg_send![&*editor, insertText: &*NSString::from_str(commit), replacementRange: replacement]
        };
    }
    if active {
        if input.terminal_original.borrow().is_none() {
            *input.terminal_original.borrow_mut() = Some(editor.selectedRange());
        }
        // Preedit is native visual/editing state, not committed application text.
        input.applying.set(true);
        // SAFETY: the caller validated the UTF-16 range in preedit; NSString conforms to the text input contract.
        let _: () = unsafe {
            msg_send![&*editor, setMarkedText: &*NSString::from_str(preedit), selectedRange: selection, replacementRange: replacement]
        };
        input.applying.set(false);
        input.cx.composition_changed();
    } else {
        if commit.is_empty() {
            terminal_cancel_input(&input);
        }
        editor.unmarkText();
        input.cx.composition_changed();
        if surface.events_sent() > events_before {
            arm(surface);
        }
    }
    true
}

#[cfg(feature = "terminal")]
pub(crate) fn terminal_candidate(surface: &Surface) -> Option<Bounds<Points>> {
    let (_, editor) = terminal_editor(surface)?;
    if !editor.hasMarkedText() {
        return terminal_caret(surface);
    }
    let window = editor.window()?;
    let at = NSRange::new(editor.markedRange().location, 0);
    // SAFETY: no actual range is requested from AppKit.
    let screen = unsafe { editor.firstRectForCharacterRange_actualRange(at, std::ptr::null_mut()) };
    let rect = surface
        .root
        .ns()
        .convertRect_fromView(window.convertRectFromScreen(screen), None);
    Some(Bounds::new(
        Point::new(px(rect.origin.x as f32), px(rect.origin.y as f32)),
        Size::new(
            px((rect.size.width as f32).max(1.0)),
            px(rect.size.height as f32),
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_line_placeholder_matches_native_editor_metrics() {
        let font = objc2_app_kit::NSFont::systemFontOfSize(16.0);
        for line_height in [0.0, 16.0, 24.0, 32.0] {
            let mut config = InputConfig::default();
            config.placeholder.push_str("Placeholder");
            config.style.line_height = px(line_height);
            for align in [
                NSTextAlignment::Left,
                NSTextAlignment::Center,
                NSTextAlignment::Right,
            ] {
                let text = placeholder(&config, &font, align);
                // SAFETY: index zero is in the nonempty attributed string;
                // no effective range is requested.
                let style = unsafe {
                    text.attribute_atIndex_effectiveRange(
                        NSParagraphStyleAttributeName,
                        0,
                        std::ptr::null_mut(),
                    )
                }
                .unwrap()
                .downcast::<objc2_app_kit::NSParagraphStyle>()
                .unwrap();
                assert_eq!(style.alignment(), align);
                assert_eq!(style.minimumLineHeight(), 0.0);
                assert_eq!(style.maximumLineHeight(), 0.0);
            }
        }
    }

    #[test]
    fn a_line_height_above_the_fonts_goes_around_the_text() {
        let line = LineBox::new(24.0, 18.0);
        assert_eq!(
            line,
            LineBox {
                fragment: 18.0,
                spacing: 6.0,
                inset: 3.0,
            }
        );
        let style = paragraph(line, NSTextAlignment::Left);
        assert_eq!(style.minimumLineHeight(), 18.0);
        assert_eq!(style.maximumLineHeight(), 18.0);
        assert_eq!(style.lineSpacing(), 6.0);
    }

    #[test]
    fn a_line_height_below_the_fonts_clips_the_lines() {
        let line = LineBox::new(16.0, 18.0);
        assert_eq!(line.fragment, 16.0);
        assert_eq!(line.spacing, 0.0);
        assert_eq!(line.inset, 0.0);
    }

    #[test]
    fn no_line_height_leaves_the_fonts_lines() {
        let style = paragraph(LineBox::new(0.0, 18.0), NSTextAlignment::Left);
        assert_eq!(style.minimumLineHeight(), 0.0);
        assert_eq!(style.maximumLineHeight(), 0.0);
        assert_eq!(style.lineSpacing(), 0.0);
    }

    #[test]
    fn max_length_clipping() {
        assert_eq!(clip_utf16("hello", 3), "hel");
        assert_eq!(clip_utf16("hello", 9), "hello");
        assert_eq!(clip_utf16("hello", 0), "");
        // A pair is never split.
        assert_eq!(clip_utf16("a😀", 2), "a");
        assert_eq!(clip_utf16("a😀", 3), "a😀");
        assert_eq!(utf16_len("a😀"), 3);
    }

    #[test]
    fn keys() {
        assert_eq!(key_of("\n"), "Enter");
        assert_eq!(key_of("x"), "x");
    }
}
