//! Text inputs: a `UITextField` (one line) or `UITextView` (`multiline`)
//! inside a container view that carries the decoration (background,
//! border, corners, shadow) like any other view.

use std::cell::Cell;

use nsh_core::{
    AutoCapitalize, AutoFill, Bounds, Color, InputConfig, KeyboardAppearance, KeyboardType, NodeId,
    Points, ReturnKeyType, SubmitBehavior, TextAlign, geometry::px,
};
use objc2::{
    AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Bool, ProtocolObject, Sel},
    sel,
};
use objc2_core_foundation::{CGFloat, CGPoint, CGRect, CGSize};
use objc2_foundation::{
    NSArray, NSAttributedString, NSAttributedStringKey, NSDictionary, NSObject, NSRange, NSString,
};
use objc2_ui_kit::{
    NSFontAttributeName, NSForegroundColorAttributeName, NSTextAlignment, UIColor, UIControl,
    UIControlEvents, UIEdgeInsets, UIKeyboardAppearance, UIKeyboardType, UILabel, UIResponder,
    UIReturnKeyType, UITextAutocapitalizationType, UITextAutocorrectionType, UITextField,
    UITextView, UIView, UIViewAutoresizing,
};

use crate::{target::EventTarget, text};

/// Limits shared by both input classes, read synchronously by delegate
/// callbacks (which cannot wait for the mounter).
pub(crate) struct InputIvars {
    insets: Cell<UIEdgeInsets>,
    /// Maximum length in UTF-16 units.
    max_length: Cell<Option<u32>>,
    /// No caret is drawn (`caret={false}`).
    caret_hidden: Cell<bool>,
    /// What return does (`InputConfig::submit`).
    submit: Cell<SubmitBehavior>,
    /// A line break typed with a modifier (Shift / Option+Return) is being
    /// inserted: it never submits.
    line_break: Cell<bool>,
    /// The caret as last reported (`onCaretMove`), in the input.
    caret: Cell<Bounds<Points>>,
    /// The app listens to pastes (`onPaste`).
    paste_listens: Cell<bool>,
    /// A paste inserts its text (`pasteBehavior`).
    paste_inserts: Cell<bool>,
}

impl Default for InputIvars {
    fn default() -> Self {
        Self {
            insets: Cell::new(UIEdgeInsets {
                top: 0.0,
                left: 0.0,
                bottom: 0.0,
                right: 0.0,
            }),
            max_length: Cell::new(None),
            caret_hidden: Cell::new(false),
            submit: Cell::new(SubmitBehavior::Newline),
            line_break: Cell::new(false),
            caret: Cell::new(Bounds::default()),
            paste_listens: Cell::new(false),
            paste_inserts: Cell::new(true),
        }
    }
}

define_class!(
    /// A one-line field whose text sits inside the node's padding.
    #[unsafe(super(UITextField, UIControl, UIView, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = InputIvars]
    pub(crate) struct Field;

    impl Field {
        #[unsafe(method(textRectForBounds:))]
        fn text_rect(&self, bounds: CGRect) -> CGRect {
            inset(bounds, self.ivars().insets.get())
        }

        #[unsafe(method(editingRectForBounds:))]
        fn editing_rect(&self, bounds: CGRect) -> CGRect {
            inset(bounds, self.ivars().insets.get())
        }

        #[unsafe(method(placeholderRectForBounds:))]
        fn placeholder_rect(&self, bounds: CGRect) -> CGRect {
            inset(bounds, self.ivars().insets.get())
        }

        #[unsafe(method(caretRectForPosition:))]
        fn caret_rect(&self, position: &objc2::runtime::AnyObject) -> CGRect {
            if self.ivars().caret_hidden.get() {
                return CGRect::ZERO;
            }
            // SAFETY: calling the superclass implementation.
            unsafe { msg_send![super(self), caretRectForPosition: position] }
        }

        /// Where the caret is, drawn or not (`caret()`).
        #[unsafe(method(nshCaretRectForPosition:))]
        fn shown_caret_rect(&self, position: &objc2::runtime::AnyObject) -> CGRect {
            // SAFETY: calling the superclass implementation.
            unsafe { msg_send![super(self), caretRectForPosition: position] }
        }

        /// A paste (the edit menu, Command+V): reported, and its text
        /// inserted as `pasteBehavior` says.
        #[unsafe(method(paste:))]
        fn paste(&self, sender: Option<&AnyObject>) {
            if pasting(self.as_ref(), self.ivars()) {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), paste: sender] };
            }
        }

        /// Paste is offered for images and files too while the app listens.
        #[unsafe(method(canPerformAction:withSender:))]
        fn can_perform(&self, action: Sel, sender: Option<&AnyObject>) -> Bool {
            if action == sel!(paste:) && can_paste_more(self.as_ref(), self.ivars()) {
                return Bool::YES;
            }
            // SAFETY: calling the superclass implementation.
            unsafe { msg_send![super(self), canPerformAction: action, withSender: sender] }
        }

        #[unsafe(method(deleteBackward))]
        fn delete_backward(&self) {
            let empty = self.text().is_none_or(|t| t.length() == 0);
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), deleteBackward] };
            // Deleting in an empty field changes nothing, so no delegate
            // call reports it.
            if empty {
                backspace_on_empty(self.as_ref());
            }
        }

        /// A hardware keyboard's keys go to the app's shortcuts first
        /// (`nsh/keymap`): a key a binding takes never reaches the input.
        #[unsafe(method(pressesBegan:withEvent:))]
        fn presses_began(&self, presses: &AnyObject, event: Option<&AnyObject>) {
            if !crate::keymap::input_began(self.as_ref(), presses) {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), pressesBegan: presses, withEvent: event] };
            }
        }

        #[unsafe(method(pressesEnded:withEvent:))]
        fn presses_ended(&self, presses: &AnyObject, event: Option<&AnyObject>) {
            if !crate::keymap::input_ended(self.as_ref(), presses) {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), pressesEnded: presses, withEvent: event] };
            }
        }

        #[unsafe(method(pressesCancelled:withEvent:))]
        fn presses_cancelled(&self, presses: &AnyObject, event: Option<&AnyObject>) {
            if !crate::keymap::input_ended(self.as_ref(), presses) {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), pressesCancelled: presses, withEvent: event] };
            }
        }
    }
);

impl Area {
    /// Adds the line break commands to `inherited` while return submits.
    fn with_line_breaks(
        &self,
        inherited: Option<Retained<NSArray<AnyObject>>>,
    ) -> Option<Retained<NSArray<AnyObject>>> {
        if self.ivars().submit.get() == SubmitBehavior::Newline {
            return inherited;
        }
        let mut commands = inherited.map(|a| a.to_vec()).unwrap_or_default();
        commands.extend(line_break_commands());
        Some(NSArray::from_retained_slice(&commands))
    }
}

/// `UIKeyCommand`s for Shift+Return and Option+Return that call
/// `nshInsertLineBreak:`, ahead of the text view's own handling of return.
fn line_break_commands() -> Vec<Retained<AnyObject>> {
    // UIKeyModifierShift, UIKeyModifierAlternate.
    const MODIFIERS: [isize; 2] = [1 << 17, 1 << 19];
    let class = AnyClass::get(c"UIKeyCommand").expect("UIKeyCommand");
    let input = NSString::from_str("\r");
    MODIFIERS
        .iter()
        .map(|&modifiers| {
            // SAFETY: UIKeyCommand's documented factory and its iOS 15
            // `wantsPriorityOverSystemBehavior` (the deployment target).
            unsafe {
                let command: Retained<AnyObject> = msg_send![
                    class,
                    keyCommandWithInput: &*input,
                    modifierFlags: modifiers,
                    action: sel!(nshInsertLineBreak:)
                ];
                let _: () = msg_send![&command, setWantsPriorityOverSystemBehavior: true];
                command
            }
        })
        .collect()
}

/// What return does in the text area behind a delegate callback, or
/// `None` when the line break comes from a modifier key (it never submits)
/// or ends an input method's composition.
pub(crate) fn area_submit(view: &UITextView) -> Option<SubmitBehavior> {
    let area = view.downcast_ref::<Area>()?;
    // SAFETY: UITextView adopts UITextInput.
    let marked: Option<Retained<AnyObject>> = unsafe { msg_send![view, markedTextRange] };
    (!area.ivars().line_break.get() && marked.is_none()).then(|| area.ivars().submit.get())
}

define_class!(
    /// A multi-line text area.
    #[unsafe(super(UITextView, UIView, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = InputIvars]
    pub(crate) struct Area;

    impl Area {
        #[unsafe(method(caretRectForPosition:))]
        fn caret_rect(&self, position: &objc2::runtime::AnyObject) -> CGRect {
            if self.ivars().caret_hidden.get() {
                return CGRect::ZERO;
            }
            // SAFETY: calling the superclass implementation.
            unsafe { msg_send![super(self), caretRectForPosition: position] }
        }

        /// Where the caret is, drawn or not (`caret()`).
        #[unsafe(method(nshCaretRectForPosition:))]
        fn shown_caret_rect(&self, position: &objc2::runtime::AnyObject) -> CGRect {
            // SAFETY: calling the superclass implementation.
            unsafe { msg_send![super(self), caretRectForPosition: position] }
        }

        /// A paste (the edit menu, Command+V): reported, and its text
        /// inserted as `pasteBehavior` says.
        #[unsafe(method(paste:))]
        fn paste(&self, sender: Option<&AnyObject>) {
            if pasting(self.as_ref(), self.ivars()) {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), paste: sender] };
            }
        }

        /// Paste is offered for images and files too while the app listens.
        #[unsafe(method(canPerformAction:withSender:))]
        fn can_perform(&self, action: Sel, sender: Option<&AnyObject>) -> Bool {
            if action == sel!(paste:) && can_paste_more(self.as_ref(), self.ivars()) {
                return Bool::YES;
            }
            // SAFETY: calling the superclass implementation.
            unsafe { msg_send![super(self), canPerformAction: action, withSender: sender] }
        }

        #[unsafe(method(deleteBackward))]
        fn delete_backward(&self) {
            let empty = self.text().length() == 0;
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), deleteBackward] };
            if empty {
                backspace_on_empty(self.as_ref());
            }
        }

        /// Shift+Return and Option+Return on a hardware keyboard insert a
        /// line break in a text area whose return submits, as in chat
        /// apps on desktops.
        #[unsafe(method_id(keyCommands))]
        fn key_commands(&self) -> Option<Retained<NSArray<AnyObject>>> {
            // SAFETY: calling the superclass implementation.
            let inherited: Option<Retained<NSArray<AnyObject>>> =
                unsafe { msg_send![super(self), keyCommands] };
            self.with_line_breaks(inherited)
        }

        #[unsafe(method(nshInsertLineBreak:))]
        fn insert_line_break(&self, _sender: Option<&AnyObject>) {
            self.ivars().line_break.set(true);
            // SAFETY: UITextView adopts UIKeyInput.
            let _: () = unsafe { msg_send![self, insertText: &*NSString::from_str("\n")] };
            self.ivars().line_break.set(false);
        }

        /// A hardware keyboard's keys go to the app's shortcuts first
        /// (`nsh/keymap`): a key a binding takes never reaches the input.
        #[unsafe(method(pressesBegan:withEvent:))]
        fn presses_began(&self, presses: &AnyObject, event: Option<&AnyObject>) {
            if !crate::keymap::input_began(self.as_ref(), presses) {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), pressesBegan: presses, withEvent: event] };
            }
        }

        #[unsafe(method(pressesEnded:withEvent:))]
        fn presses_ended(&self, presses: &AnyObject, event: Option<&AnyObject>) {
            if !crate::keymap::input_ended(self.as_ref(), presses) {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), pressesEnded: presses, withEvent: event] };
            }
        }

        #[unsafe(method(pressesCancelled:withEvent:))]
        fn presses_cancelled(&self, presses: &AnyObject, event: Option<&AnyObject>) {
            if !crate::keymap::input_ended(self.as_ref(), presses) {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), pressesCancelled: presses, withEvent: event] };
            }
        }
    }
);

/// A paste into input `view`: reports what the general pasteboard holds
/// (`onPaste`) if the app listens; whether the input then inserts its text
/// (the superclass's `paste:`). The pasteboard is read only here, on the
/// user's paste.
fn pasting(view: &UIView, ivars: &InputIvars) -> bool {
    pasting_from(
        view,
        ivars,
        &objc2_ui_kit::UIPasteboard::generalPasteboard(),
    )
}

/// [`pasting`] from `board`.
fn pasting_from(view: &UIView, ivars: &InputIvars, board: &objc2_ui_kit::UIPasteboard) -> bool {
    if ivars.paste_listens.get() {
        let paste = crate::system::pasted(board);
        report_paste(view, paste);
    }
    // SAFETY: a plain getter (no paste notice).
    ivars.paste_inserts.get() && unsafe { board.hasStrings() }
}

/// A test's paste (`nsh test --target ios`): `content` on a pasteboard of
/// its own (the device's clipboard stays as it was), pasted into the
/// focused input as the user's paste is: reported, then its text inserted
/// as `pasteBehavior` says.
#[cfg(feature = "dev")]
pub(crate) fn test_paste(
    window: &objc2_ui_kit::UIWindow,
    content: &nsh_core::PasteEvent,
) -> Result<(), String> {
    let responder = crate::synth::first_responder(window).ok_or("no input has the focus")?;
    let (view, ivars): (&UIView, &InputIvars) =
        if let Some(field) = responder.downcast_ref::<Field>() {
            (field.as_ref(), field.ivars())
        } else if let Some(area) = responder.downcast_ref::<Area>() {
            (area.as_ref(), area.ivars())
        } else {
            return Err("no input of the app has the focus".into());
        };
    let board = objc2_ui_kit::UIPasteboard::pasteboardWithUniqueName();
    let mut items: Vec<Retained<NSDictionary<NSString, AnyObject>>> = Vec::new();
    let item = |kind: &str, value: &AnyObject| {
        NSDictionary::from_slices(&[&*NSString::from_str(kind)], &[value])
    };
    if !content.text.is_empty() {
        items.push(item(
            "public.utf8-plain-text",
            &NSString::from_str(&content.text),
        ));
    }
    for file in &content.files {
        let kind = match file.mime.as_str() {
            "image/png" => "public.png",
            "image/jpeg" => "public.jpeg",
            "image/gif" => "com.compuserve.gif",
            _ => "public.data",
        };
        items.push(item(
            kind,
            &objc2_foundation::NSData::with_bytes(&file.data),
        ));
    }
    for uri in &content.uris {
        if let Some(url) = objc2_foundation::NSURL::URLWithString(&NSString::from_str(uri)) {
            items.push(item("public.file-url", &url));
        }
    }
    // SAFETY: UIPasteboard's setter of items (type to value).
    let _: () = unsafe { msg_send![&board, setItems: &*NSArray::from_retained_slice(&items)] };
    let inserts = pasting_from(view, ivars, &board);
    // SAFETY: plain getters of the test's pasteboard.
    if inserts && let Some(text) = unsafe { board.string() } {
        // SAFETY: UIKeyInput's method, which both input classes implement.
        let _: () = unsafe { msg_send![view, insertText: &*text] };
    }
    // SAFETY: a plain getter; the test's pasteboard is not used again.
    objc2_ui_kit::UIPasteboard::removePasteboardWithName(&*unsafe { board.name() });
    Ok(())
}

/// Whether input `view` offers Paste for what UIKit's own paste would not:
/// images and files, while the app listens to pastes.
fn can_paste_more(view: &UIView, ivars: &InputIvars) -> bool {
    let board = objc2_ui_kit::UIPasteboard::generalPasteboard();
    // SAFETY: plain getters, which show no paste notice.
    ivars.paste_listens.get()
        && view.isFirstResponder()
        && unsafe { board.hasImages() || board.hasURLs() }
}

/// Reports `paste` to the app (`onPaste`), through the input's delegate,
/// the event target.
pub(crate) fn report_paste(view: &UIView, paste: nsh_core::PasteEvent) {
    // SAFETY: both input classes have a `delegate`, set to the target.
    let delegate: Option<Retained<AnyObject>> = unsafe { msg_send![view, delegate] };
    if let Some(target) = delegate
        .as_deref()
        .and_then(|d| d.downcast_ref::<EventTarget>())
    {
        target.pasted(view.tag() as NodeId, paste);
    }
}

/// The paste settings of input view `view` (`onPaste` listened,
/// `pasteBehavior` inserts).
fn set_paste(view: &UIView, listens: bool, inserts: bool) {
    let ivars = view
        .downcast_ref::<Field>()
        .map(|f| f.ivars())
        .or_else(|| view.downcast_ref::<Area>().map(|a| a.ivars()));
    if let Some(ivars) = ivars {
        ivars.paste_listens.set(listens);
        ivars.paste_inserts.set(inserts);
    }
}

/// Reports `Backspace` for a delete in an empty input (to its delegate,
/// the event target).
fn backspace_on_empty(view: &UIView) {
    // SAFETY: both input classes have a `delegate`, set to the target.
    let delegate: Option<Retained<AnyObject>> = unsafe { msg_send![view, delegate] };
    if let Some(target) = delegate
        .as_deref()
        .and_then(|d| d.downcast_ref::<EventTarget>())
    {
        target.key_press(view.tag() as NodeId, "Backspace".to_owned());
    }
}

/// The text an input method is composing in an input view (its marked
/// text), or `None` while no composition is in progress.
pub(crate) fn marked_text(view: &UIView) -> Option<String> {
    // SAFETY: UITextField and UITextView adopt UITextInput.
    unsafe {
        let range: Option<Retained<AnyObject>> = msg_send![view, markedTextRange];
        let range = range?;
        let text: Option<Retained<NSString>> = msg_send![view, textInRange: &*range];
        // An empty marked range composes nothing: input methods unmark
        // with it.
        text.map(|t| t.to_string()).filter(|t| !t.is_empty())
    }
}

/// The selection of an input view, in UTF-16 units.
pub(crate) fn selection(view: &UIView) -> Option<(u32, u32)> {
    // SAFETY: UITextField and UITextView adopt UITextInput.
    unsafe {
        let range: Option<Retained<AnyObject>> = msg_send![view, selectedTextRange];
        let range = range?;
        let begin: Retained<AnyObject> = msg_send![view, beginningOfDocument];
        let start: Retained<AnyObject> = msg_send![&range, start];
        let end: Retained<AnyObject> = msg_send![&range, end];
        let a: isize = msg_send![view, offsetFromPosition: &*begin, toPosition: &*start];
        let b: isize = msg_send![view, offsetFromPosition: &*begin, toPosition: &*end];
        Some((a.max(0) as u32, b.max(0) as u32))
    }
}

/// The caret at the end of the selection of an input view, in the input's
/// coordinates (its container, which the editor fills), drawn or not.
pub(crate) fn caret(view: &UIView) -> Option<Bounds<Points>> {
    // SAFETY: UITextField and UITextView adopt UITextInput; both input
    // classes answer `nshCaretRectForPosition:`.
    let rect: CGRect = unsafe {
        let range: Option<Retained<AnyObject>> = msg_send![view, selectedTextRange];
        let end: Retained<AnyObject> = msg_send![&range?, end];
        msg_send![view, nshCaretRectForPosition: &*end]
    };
    let rect = match view.superview() {
        Some(container) => view.convertRect_toView(rect, Some(&container)),
        None => rect,
    };
    Some(Bounds {
        origin: nsh_core::geometry::point(px(rect.origin.x as f32), px(rect.origin.y as f32)),
        size: nsh_core::geometry::size(px(rect.size.width as f32), px(rect.size.height as f32)),
    })
}

/// Records `caret` as the one reported for input view `view`; false when
/// it was already.
pub(crate) fn caret_changed(view: &UIView, caret: Bounds<Points>) -> bool {
    let ivars = view
        .downcast_ref::<Field>()
        .map(|f| f.ivars())
        .or_else(|| view.downcast_ref::<Area>().map(|a| a.ivars()));
    ivars.is_none_or(|i| i.caret.replace(caret) != caret)
}

/// Selects `start..end` (UTF-16 units, clamped to the text).
fn set_selection(view: &UIView, start: u32, end: u32) {
    // SAFETY: UITextField and UITextView adopt UITextInput.
    unsafe {
        let begin: Retained<AnyObject> = msg_send![view, beginningOfDocument];
        let end_doc: Retained<AnyObject> = msg_send![view, endOfDocument];
        let length: isize = msg_send![view, offsetFromPosition: &*begin, toPosition: &*end_doc];
        let (a, b) = (
            (start as isize).min(length),
            (end.max(start) as isize).min(length),
        );
        let from: Option<Retained<AnyObject>> =
            msg_send![view, positionFromPosition: &*begin, offset: a];
        let to: Option<Retained<AnyObject>> =
            msg_send![view, positionFromPosition: &*begin, offset: b];
        let (Some(from), Some(to)) = (from, to) else {
            return;
        };
        let range: Option<Retained<AnyObject>> =
            msg_send![view, textRangeFromPosition: &*from, toPosition: &*to];
        let _: () = msg_send![view, setSelectedTextRange: range.as_deref()];
    }
}

/// The key a change of the text reports (`onKeyPress`): `Backspace` for a
/// deletion, `Enter` for a line break, else the typed text.
pub(crate) fn key_of(range: NSRange, replacement: &NSString) -> Option<String> {
    let text = replacement.to_string();
    if text.is_empty() {
        (range.length > 0).then(|| "Backspace".to_owned())
    } else if text == "\n" {
        Some("Enter".to_owned())
    } else {
        Some(text)
    }
}

impl Field {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(InputIvars::default());
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

impl Area {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(InputIvars::default());
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

fn inset(r: CGRect, i: UIEdgeInsets) -> CGRect {
    CGRect::new(
        CGPoint::new(r.origin.x + i.left, r.origin.y + i.top),
        CGSize::new(
            (r.size.width - i.left - i.right).max(0.0),
            (r.size.height - i.top - i.bottom).max(0.0),
        ),
    )
}

/// True if replacing `range` of `current` with `replacement` keeps the
/// text within `max` UTF-16 units (pasting may still be cut by the platform).
pub(crate) fn fits(
    current: &NSString,
    range: NSRange,
    replacement: &NSString,
    max: Option<u32>,
) -> bool {
    let Some(max) = max else { return true };
    let len = current.length() - range.length.min(current.length()) + replacement.length();
    len <= max as usize || replacement.length() == 0
}

/// Reads the limits of the input behind a delegate callback.
pub(crate) fn max_length(view: &UIView) -> Option<u32> {
    if let Some(field) = view.downcast_ref::<Field>() {
        return field.ivars().max_length.get();
    }
    view.downcast_ref::<Area>()
        .and_then(|area| area.ivars().max_length.get())
}

enum Editor {
    Line(Retained<Field>),
    Area {
        view: Retained<Area>,
        /// UITextView has no placeholder of its own.
        placeholder: Retained<UILabel>,
    },
}

/// The native side of an `<input>`.
pub(crate) struct Input {
    container: Retained<UIView>,
    editor: Editor,
    id: NodeId,
    /// Edits reported to the engine.
    pub(crate) count: u32,
    /// The text the engine knows the input has: the last one reported
    /// (`onChangeText`) or set from JS. A UIKit callback that sees another
    /// text comes before the one reporting it.
    pub(crate) known: String,
    /// The text an input method is composing, while a composition is in
    /// progress.
    composition: Option<String>,
    /// The value JS wrote (text, count) while a composition was in
    /// progress: setting it then would end the input method's session and
    /// commit what it composes, so it waits for the composition to end.
    pending: Option<(String, u32)>,
    config: Option<InputConfig>,
    content: Bounds<Points>,
    /// The app listens to pastes (`onPaste`).
    paste_listens: bool,
}

impl Input {
    pub(crate) fn new(mtm: MainThreadMarker, id: NodeId, target: &EventTarget) -> Self {
        let container = UIView::new(mtm);
        container.setTag(id as isize);
        let editor = Editor::Line(Field::new(mtm));
        let input = Self {
            container,
            editor,
            id,
            count: 0,
            known: String::new(),
            composition: None,
            pending: None,
            config: None,
            content: Bounds::default(),
            paste_listens: false,
        };
        input.attach(target);
        input
    }

    pub(crate) fn view(&self) -> &UIView {
        &self.container
    }

    /// The view that edits (first responder).
    pub(crate) fn editor_view(&self) -> &UIView {
        match &self.editor {
            Editor::Line(f) => f,
            Editor::Area { view, .. } => view,
        }
    }

    pub(crate) fn text(&self) -> String {
        match &self.editor {
            Editor::Line(f) => f.text().map(|t| t.to_string()).unwrap_or_default(),
            Editor::Area { view, .. } => view.text().to_string(),
        }
    }

    fn attach(&self, target: &EventTarget) {
        let view = self.editor_view();
        view.setTag(self.id as isize);
        view.setFrame(self.container.bounds());
        view.setAutoresizingMask(
            UIViewAutoresizing::FlexibleWidth | UIViewAutoresizing::FlexibleHeight,
        );
        view.setBackgroundColor(None);
        match &self.editor {
            Editor::Line(field) => {
                // SAFETY: the target implements the delegate protocol and
                // `handleEditingChanged:`, and outlives the field (both are
                // owned by the mounter).
                unsafe {
                    field.setDelegate(Some(ProtocolObject::from_ref(target)));
                    field.addTarget_action_forControlEvents(
                        Some(target),
                        sel!(handleEditingChanged:),
                        UIControlEvents::EditingChanged,
                    );
                }
            }
            Editor::Area { view, placeholder } => {
                // SAFETY: as above.
                unsafe { view.setDelegate(Some(ProtocolObject::from_ref(target))) };
                view.textContainer().setLineFragmentPadding(0.0);
                view.addSubview(placeholder);
            }
        }
        self.container.addSubview(view);
    }

    /// Whether the app listens to pastes (`onPaste`): Paste is offered for
    /// images and files then, and what is pasted is read and reported.
    pub(crate) fn set_paste_listens(&mut self, listens: bool) {
        self.paste_listens = listens;
        let inserts = self
            .config
            .as_ref()
            .is_none_or(|c| c.paste_behavior == nsh_core::PasteBehavior::Insert);
        set_paste(self.editor_view(), listens, inserts);
    }

    /// Selects `start..end` of the text.
    pub(crate) fn select(&self, start: u32, end: u32) {
        set_selection(self.editor_view(), start, end);
    }

    /// Applies a configuration; switching `multiline` swaps the editor.
    pub(crate) fn configure(
        &mut self,
        config: InputConfig,
        target: &EventTarget,
        mtm: MainThreadMarker,
    ) {
        let multiline = matches!(self.editor, Editor::Area { .. });
        if config.multiline != multiline {
            let text = self.text();
            let focused = self.editor_view().isFirstResponder();
            self.editor_view().removeFromSuperview();
            self.editor = if config.multiline {
                Editor::Area {
                    view: Area::new(mtm),
                    placeholder: UILabel::new(mtm),
                }
            } else {
                Editor::Line(Field::new(mtm))
            };
            self.attach(target);
            self.set_text(&text);
            self.set_content(self.content);
            if focused {
                self.editor_view().becomeFirstResponder();
            }
        }
        let font = text::ui_font(&config.style);
        let color = ui_color(config.style.color);
        let align = match config.align {
            // Natural follows the editor's (mirrored) direction.
            TextAlign::Auto => NSTextAlignment::Natural,
            TextAlign::Left | TextAlign::Justify => NSTextAlignment::Left,
            TextAlign::Center => NSTextAlignment::Center,
            TextAlign::Right => NSTextAlignment::Right,
        };
        let tint = config.selection_color.map(ui_color);
        match &self.editor {
            Editor::Line(field) => {
                field.setFont(Some(&font));
                field.setTextColor(Some(&color));
                field.setTextAlignment(align);
                field.setEnabled(config.editable);
                // SAFETY: a plain setter; `None` restores the default.
                unsafe { field.setTintColor(tint.as_deref()) };
                field.setAttributedPlaceholder(Some(&placeholder(&config, &font)));
                traits(field.as_ref(), &config);
                field.ivars().max_length.set(config.max_length);
                field.ivars().caret_hidden.set(config.caret_hidden);
            }
            Editor::Area { view, placeholder } => {
                view.setFont(Some(&font));
                view.setTextColor(Some(&color));
                view.setTextAlignment(align);
                view.setEditable(config.editable);
                // SAFETY: plain setters (`None` restores the default tint).
                unsafe {
                    view.setTintColor(tint.as_deref());
                    placeholder.setFont(Some(&font));
                    placeholder.setTextColor(Some(
                        &config
                            .placeholder_color
                            .map(ui_color)
                            .unwrap_or_else(UIColor::placeholderTextColor),
                    ));
                }
                placeholder.setTextAlignment(align);
                placeholder.setNumberOfLines(0);
                placeholder.setText(Some(&NSString::from_str(&config.placeholder)));
                traits(view.as_ref(), &config);
                view.ivars().max_length.set(config.max_length);
                view.ivars().caret_hidden.set(config.caret_hidden);
                view.ivars().submit.set(config.submit());
            }
        }
        crate::mount::mirror(self.editor_view(), config.rtl);
        set_paste(
            self.editor_view(),
            self.paste_listens,
            config.paste_behavior == nsh_core::PasteBehavior::Insert,
        );
        let first = self.config.is_none();
        let auto_focus = config.auto_focus;
        self.config = Some(config);
        self.update_placeholder();
        if first && auto_focus {
            self.editor_view().becomeFirstResponder();
        }
    }

    /// The input accessory view this input names, if mounted.
    pub(crate) fn accessory(&self) -> Option<NodeId> {
        self.config.as_ref().and_then(|c| c.accessory)
    }

    /// Shows `view` over the keyboard while this input has focus
    /// (`inputAccessoryViewID`); `reload` refreshes a shown keyboard (a new
    /// view or height).
    pub(crate) fn set_accessory(&self, view: Option<&UIView>, reload: bool) {
        let editor = self.editor_view();
        // SAFETY: UITextField and UITextView redeclare `inputAccessoryView`
        // read-write.
        let current: Option<Retained<UIView>> = unsafe { msg_send![editor, inputAccessoryView] };
        let same = match (&current, view) {
            (Some(a), Some(b)) => std::ptr::eq(&**a, b),
            (None, None) => true,
            _ => false,
        };
        if !same {
            // SAFETY: as above.
            let _: () = unsafe { msg_send![editor, setInputAccessoryView: view] };
        }
        if (!same || reload) && editor.isFirstResponder() {
            editor.reloadInputViews();
        }
    }

    /// Sets the text from JS unless the user typed since JS saw `count`;
    /// during a composition the value waits for it to end.
    pub(crate) fn set_value(&mut self, text: &str, count: u32) {
        // The marked text is read too: the callback reporting a composition
        // that just started may still be queued behind this batch.
        if self.composition.is_some() || marked_text(self.editor_view()).is_some() {
            self.pending = Some((text.to_owned(), count));
            return;
        }
        self.pending = None;
        self.apply_value(text, count);
    }

    fn apply_value(&mut self, text: &str, count: u32) {
        if count != self.count || self.text() == text {
            return;
        }
        self.set_text(text);
    }

    /// Records the composition `marked` (the marked text, `None` once it
    /// ended); returns the change to report (`composing`, text), if it
    /// changed. The end applies the value JS wrote meanwhile, if JS saw
    /// every edit (a commit that changed the text was reported first).
    pub(crate) fn compose(&mut self, marked: Option<String>) -> Option<(bool, String)> {
        if self.composition == marked {
            return None;
        }
        self.composition.clone_from(&marked);
        if let Some(text) = marked {
            return Some((true, text));
        }
        if let Some((text, count)) = self.pending.take()
            && self.text() == self.known
        {
            self.apply_value(&text, count);
        }
        Some((false, String::new()))
    }

    fn set_text(&mut self, text: &str) {
        self.known = text.to_owned();
        let text = NSString::from_str(text);
        match &self.editor {
            Editor::Line(field) => field.setText(Some(&text)),
            Editor::Area { view, .. } => view.setText(Some(&text)),
        }
        self.update_placeholder();
    }

    /// Where the text goes, relative to the container.
    pub(crate) fn set_content(&mut self, content: Bounds<Points>) {
        self.content = content;
        let bounds = self.container.bounds().size;
        let insets = UIEdgeInsets {
            top: content.origin.y.0 as CGFloat,
            left: content.origin.x.0 as CGFloat,
            bottom: (bounds.height - (content.origin.y.0 + content.size.height.0) as CGFloat)
                .max(0.0),
            right: (bounds.width - (content.origin.x.0 + content.size.width.0) as CGFloat).max(0.0),
        };
        match &self.editor {
            Editor::Line(field) => {
                field.ivars().insets.set(insets);
                field.setNeedsLayout();
            }
            Editor::Area { view, placeholder } => {
                view.setTextContainerInset(insets);
                placeholder.setFrame(CGRect::new(
                    CGPoint::new(content.origin.x.0 as CGFloat, content.origin.y.0 as CGFloat),
                    CGSize::new(
                        content.size.width.0 as CGFloat,
                        content.size.height.0 as CGFloat,
                    ),
                ));
                placeholder.sizeToFit();
                let size = placeholder.frame().size;
                placeholder.setFrame(CGRect::new(
                    CGPoint::new(content.origin.x.0 as CGFloat, content.origin.y.0 as CGFloat),
                    CGSize::new(content.size.width.0 as CGFloat, size.height),
                ));
            }
        }
    }

    /// Shows the text area's placeholder while it is empty.
    pub(crate) fn update_placeholder(&self) {
        if let Editor::Area { view, placeholder } = &self.editor {
            placeholder.setHidden(view.text().length() > 0);
        }
    }

    /// What return does (`submitBehavior`, resolved by the core).
    pub(crate) fn submit(&self) -> SubmitBehavior {
        self.config
            .as_ref()
            .map_or(SubmitBehavior::BlurAndSubmit, InputConfig::submit)
    }
}

/// Sends a one-argument setter without objc2's debug-build signature check:
/// UIKit implements the `UITextInputTraits` setters of text fields by
/// message forwarding, so the check cannot find them on the class.
///
/// # Safety
///
/// `view` must respond to `sel`, which takes one argument of type `A`.
unsafe fn send<A: Copy>(view: &AnyObject, sel: Sel, value: A) {
    // SAFETY: `objc_msgSend` called with the selector's real signature
    // (guaranteed by the caller).
    unsafe {
        let send: unsafe extern "C-unwind" fn(&AnyObject, Sel, A) =
            std::mem::transmute(objc2::ffi::objc_msgSend as unsafe extern "C-unwind" fn());
        send(view, sel, value);
    }
}

fn traits(view: &AnyObject, config: &InputConfig) {
    let keyboard = match config.keyboard {
        KeyboardType::Default => UIKeyboardType::Default,
        KeyboardType::Number => UIKeyboardType::NumberPad,
        // React Native's `numeric`: digits and a decimal separator.
        KeyboardType::Decimal | KeyboardType::Numeric => UIKeyboardType::DecimalPad,
        KeyboardType::NumbersAndPunctuation => UIKeyboardType::NumbersAndPunctuation,
        KeyboardType::Email => UIKeyboardType::EmailAddress,
        KeyboardType::Phone => UIKeyboardType::PhonePad,
        KeyboardType::Url => UIKeyboardType::URL,
    };
    let return_key = match config.return_key {
        ReturnKeyType::Default => UIReturnKeyType::Default,
        ReturnKeyType::Done => UIReturnKeyType::Done,
        ReturnKeyType::Go => UIReturnKeyType::Go,
        ReturnKeyType::Next => UIReturnKeyType::Next,
        ReturnKeyType::Search => UIReturnKeyType::Search,
        ReturnKeyType::Send => UIReturnKeyType::Send,
    };
    let capitalize = match config.auto_capitalize {
        AutoCapitalize::None => UITextAutocapitalizationType::None,
        AutoCapitalize::Sentences => UITextAutocapitalizationType::Sentences,
        AutoCapitalize::Words => UITextAutocapitalizationType::Words,
        AutoCapitalize::Characters => UITextAutocapitalizationType::AllCharacters,
    };
    let appearance = match config.keyboard_appearance {
        KeyboardAppearance::Default => UIKeyboardAppearance::Default,
        KeyboardAppearance::Light => UIKeyboardAppearance::Light,
        KeyboardAppearance::Dark => UIKeyboardAppearance::Dark,
    };
    let correct = if config.auto_correct {
        UITextAutocorrectionType::Default
    } else {
        UITextAutocorrectionType::No
    };
    // SAFETY: UITextField and UITextView adopt UITextInputTraits; each
    // setter takes the NSInteger-backed enum (BOOL, or string) passed here.
    unsafe {
        send(view, sel!(setSecureTextEntry:), Bool::new(config.secure));
        send(view, sel!(setKeyboardType:), keyboard.0);
        send(view, sel!(setKeyboardAppearance:), appearance.0);
        send(view, sel!(setReturnKeyType:), return_key.0);
        send(view, sel!(setAutocapitalizationType:), capitalize.0);
        send(view, sel!(setAutocorrectionType:), correct.0);
        let content_type =
            content_type(config.auto_fill).map_or(std::ptr::null(), |t| t as *const NSString);
        send(view, sel!(setTextContentType:), content_type);
    }
}

/// The `textContentType` for `fill`.
fn content_type(fill: AutoFill) -> Option<&'static NSString> {
    use objc2_ui_kit::*;
    // SAFETY: immutable UIKit constants.
    unsafe {
        Some(match fill {
            // An empty type turns autofill off.
            AutoFill::Default => return None,
            AutoFill::Off => return Some(objc2_foundation::ns_string!("")),
            AutoFill::Username => UITextContentTypeUsername,
            AutoFill::Password => UITextContentTypePassword,
            AutoFill::NewPassword => UITextContentTypeNewPassword,
            AutoFill::OneTimeCode => UITextContentTypeOneTimeCode,
            AutoFill::Email => UITextContentTypeEmailAddress,
            AutoFill::Tel => UITextContentTypeTelephoneNumber,
            AutoFill::Name => UITextContentTypeName,
            AutoFill::GivenName => UITextContentTypeGivenName,
            AutoFill::FamilyName => UITextContentTypeFamilyName,
            AutoFill::MiddleName => UITextContentTypeMiddleName,
            AutoFill::Nickname => UITextContentTypeNickname,
            AutoFill::Organization => UITextContentTypeOrganizationName,
            AutoFill::StreetAddress => UITextContentTypeFullStreetAddress,
            AutoFill::AddressLine1 => UITextContentTypeStreetAddressLine1,
            AutoFill::AddressLine2 => UITextContentTypeStreetAddressLine2,
            AutoFill::City => UITextContentTypeAddressCity,
            AutoFill::Region => UITextContentTypeAddressState,
            AutoFill::PostalCode => UITextContentTypePostalCode,
            AutoFill::Country => UITextContentTypeCountryName,
            AutoFill::CreditCardNumber => UITextContentTypeCreditCardNumber,
            AutoFill::CreditCardExpiration => UITextContentTypeCreditCardExpiration,
            AutoFill::CreditCardSecurityCode => UITextContentTypeCreditCardSecurityCode,
            AutoFill::CreditCardName => UITextContentTypeCreditCardName,
            AutoFill::Url => UITextContentTypeURL,
            AutoFill::Birthdate => UITextContentTypeBirthdate,
        })
    }
}

fn placeholder(config: &InputConfig, font: &objc2_ui_kit::UIFont) -> Retained<NSAttributedString> {
    let color = config
        .placeholder_color
        .map(ui_color)
        .unwrap_or_else(UIColor::placeholderTextColor);
    // SAFETY: immutable UIKit attribute keys with values of their documented
    // types (UIFont, UIColor).
    let keys: [&NSAttributedStringKey; 2] =
        unsafe { [NSFontAttributeName, NSForegroundColorAttributeName] };
    let values: [&objc2::runtime::AnyObject; 2] = [font.as_ref(), color.as_ref()];
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

fn ui_color(color: Color) -> Retained<UIColor> {
    let (r, g, b, a) = color.to_f64();
    UIColor::colorWithRed_green_blue_alpha(r, g, b, a)
}
