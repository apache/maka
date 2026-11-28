//! Text inputs: a `UITextField` (one line) or `UITextView` (`multiline`)
//! inside a container view that carries the decoration (background,
//! border, corners, shadow) like any other view. A field fills the
//! container and insets its text by the padding; a text view sits at the
//! content box, so its scrolled text is clipped there, and takes touches
//! on the padding too.

use std::{
    cell::{Cell, RefCell},
    ffi::CStr,
};

use nsh_core::{
    AutoCapitalize, AutoFill, Bounds, Color, EditAction, EventKind, EventPayload, InputConfig,
    KeyboardAppearance, KeyboardType, NodeId, PayloadValue, Points, ReturnKeyType, SubmitBehavior,
    TextAlign,
    element::PropEnum,
    geometry::{point, px, size},
    text_edit::clip_chars,
};
use nsh_engine::EngineControl;
use objc2::{
    AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::{Allocated, Retained, Weak},
    runtime::{AnyClass, AnyObject, Bool, ProtocolObject, Sel},
    sel,
};
use objc2_core_foundation::{CGFloat, CGPoint, CGRect, CGSize};
use objc2_foundation::{
    NSArray, NSAttributedString, NSAttributedStringKey, NSDictionary, NSObject, NSRange, NSSet,
    NSString,
};
use objc2_ui_kit::{
    NSFontAttributeName, NSForegroundColorAttributeName, NSTextAlignment, UIColor, UIControl,
    UIControlEvents, UIEdgeInsets, UIKeyboardAppearance, UIKeyboardType, UILabel, UIPress,
    UIPressesEvent, UIResponder, UIReturnKeyType, UITextAutocapitalizationType,
    UITextAutocorrectionType, UITextField, UITextSmartDashesType, UITextSmartQuotesType,
    UITextView, UIView, UIViewAutoresizing,
};

use crate::{target::EventTarget, text};

/// Limits shared by both input classes, read synchronously by delegate
/// callbacks (which cannot wait for the mounter).
pub(crate) struct InputIvars {
    /// The input's padding and border around the content box: a field
    /// insets its text by them; a text area, at the content box, takes
    /// touches on them too.
    insets: Cell<UIEdgeInsets>,
    /// Maximum length in UTF-16 units.
    max_length: Cell<Option<u32>>,
    /// No caret is drawn (`caret={false}`).
    caret_hidden: Cell<bool>,
    /// The input is another view's sink ([`is_sink`]).
    sink: Cell<bool>,
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
    /// The largest pasted file read (`pasteMaxSize`; `None`: all).
    paste_max_size: Cell<Option<u64>>,
    /// A bar of the app's follows the text area (its built-in bar, or one
    /// that watches it; `InputConfig::report_scroll`): its scrolling is
    /// reported.
    scroll_reports: Cell<bool>,
    /// The scrolling last reported (offset y, content width and height,
    /// viewport width and height): only changes are reported again.
    scroll_reported: Cell<Option<[CGFloat; 5]>>,
    /// The event target the input reports to, which is also its delegate.
    /// Kept here, not read back from `delegate`: a host may wrap the
    /// delegate (BlocksKit puts an `NSProxy` there that answers
    /// `isKindOfClass:` for the object it wraps), and a downcast of that
    /// proxy would read its memory as the target's.
    target: RefCell<Weak<EventTarget>>,
    /// The edit menu a component that draws its own selection opened on
    /// the input (`Command::OpenEditMenu`): what it offers and what it
    /// points at, in the input. While set, the edit actions are the
    /// component's.
    edit_menu: RefCell<Option<(Vec<EditAction>, CGRect)>>,
    /// `UIEditMenuInteraction` (iOS 16), made on first use.
    edit_interaction: RefCell<Option<Retained<AnyObject>>>,
    /// The whole text is selected when the input takes the focus
    /// (`selectTextOnFocus`).
    select_on_focus: Cell<bool>,
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
            sink: Cell::new(false),
            submit: Cell::new(SubmitBehavior::Newline),
            line_break: Cell::new(false),
            caret: Cell::new(Bounds::default()),
            paste_listens: Cell::new(false),
            paste_inserts: Cell::new(true),
            paste_max_size: Cell::new(None),
            scroll_reports: Cell::new(false),
            scroll_reported: Cell::new(None),
            target: RefCell::default(),
            edit_menu: RefCell::new(None),
            edit_interaction: RefCell::new(None),
            select_on_focus: Cell::new(false),
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
        fn caret_rect(&self, position: Option<&objc2::runtime::AnyObject>) -> CGRect {
            if self.ivars().caret_hidden.get() {
                return CGRect::ZERO;
            }
            // SAFETY: calling the superclass implementation.
            unsafe { msg_send![super(self), caretRectForPosition: position] }
        }

        /// Where the caret is, drawn or not (`caret()`).
        #[unsafe(method(nshCaretRectForPosition:))]
        fn shown_caret_rect(&self, position: Option<&objc2::runtime::AnyObject>) -> CGRect {
            // SAFETY: calling the superclass implementation.
            unsafe { msg_send![super(self), caretRectForPosition: position] }
        }

        /// A sink ([`is_sink`]: an editor's, which holds the text itself)
        /// is often empty: it says it has text, as UIKit repeats a held
        /// Delete only while the input has text.
        #[unsafe(method(hasText))]
        fn has_text(&self) -> Bool {
            if self.ivars().sink.get() {
                return Bool::YES;
            }
            // SAFETY: calling the superclass implementation.
            unsafe { msg_send![super(self), hasText] }
        }

        /// A paste (the edit menu, Command+V): reported, and its text
        /// inserted as `pasteBehavior` says, within `maxLength`.
        #[unsafe(method(paste:))]
        fn paste(&self, sender: Option<&AnyObject>) {
            if pasting(self.as_ref(), self.ivars()) {
                if self.ivars().max_length.get().is_some() {
                    paste_text(self.as_ref(), &objc2_ui_kit::UIPasteboard::generalPasteboard());
                } else {
                    // SAFETY: calling the superclass implementation.
                    let _: () = unsafe { msg_send![super(self), paste: sender] };
                }
            }
        }

        /// Paste is offered for images and files too while the app listens;
        /// a component's edit menu offers what it asked for.
        #[unsafe(method(canPerformAction:withSender:))]
        fn can_perform(&self, action: Sel, sender: Option<&AnyObject>) -> Bool {
            if let Some(offers) = edit_menu_offers(self.ivars(), action) {
                return Bool::new(offers);
            }
            if action == sel!(paste:) && can_paste_more(self.as_ref(), self.ivars()) {
                return Bool::YES;
            }
            // SAFETY: calling the superclass implementation.
            unsafe { msg_send![super(self), canPerformAction: action, withSender: sender] }
        }

        #[unsafe(method(cut:))]
        fn cut(&self, sender: Option<&AnyObject>) {
            if !edit_menu_chose(self.as_ref(), self.ivars(), EditAction::Cut) {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), cut: sender] };
            }
        }

        #[unsafe(method(copy:))]
        fn copy(&self, sender: Option<&AnyObject>) {
            if !edit_menu_chose(self.as_ref(), self.ivars(), EditAction::Copy) {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), copy: sender] };
            }
        }

        #[unsafe(method(selectAll:))]
        fn select_all(&self, sender: Option<&AnyObject>) {
            if !edit_menu_chose(self.as_ref(), self.ivars(), EditAction::SelectAll) {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), selectAll: sender] };
            }
        }

        /// `UIEditMenuInteractionDelegate`: the menu keeps clear of what
        /// the component selected.
        #[unsafe(method(editMenuInteraction:targetRectForConfiguration:))]
        fn edit_menu_target_rect(&self, _interaction: &AnyObject, _configuration: &AnyObject) -> CGRect {
            self.ivars()
                .edit_menu
                .borrow()
                .as_ref()
                .map_or(CGRect::ZERO, |(_, rect)| *rect)
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
        fn presses_began(&self, presses: &NSSet<UIPress>, event: Option<&UIPressesEvent>) {
            if !crate::keymap::input_began(self.as_ref(), presses) {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), pressesBegan: presses, withEvent: event] };
            }
        }

        #[unsafe(method(pressesEnded:withEvent:))]
        fn presses_ended(&self, presses: &NSSet<UIPress>, event: Option<&UIPressesEvent>) {
            if !crate::keymap::input_ended(self.as_ref(), presses) {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), pressesEnded: presses, withEvent: event] };
            }
        }

        #[unsafe(method(pressesCancelled:withEvent:))]
        fn presses_cancelled(&self, presses: &NSSet<UIPress>, event: Option<&UIPressesEvent>) {
            if !crate::keymap::input_ended(self.as_ref(), presses) {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), pressesCancelled: presses, withEvent: event] };
            }
        }
    }
);

impl Area {
    /// Reports the scrolling through the delegate, the event target, which
    /// holds the engine's control.
    fn scroll_changed(&self) {
        if !self.ivars().scroll_reports.get() {
            return;
        }
        if let Some(target) = self.ivars().target.borrow().load() {
            target.input_scrolled(self.as_ref());
        }
    }

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
        /// A touch on the input's padding, outside the text view at the
        /// content box, edits at the nearest point, as one on the text.
        #[unsafe(method(pointInside:withEvent:))]
        fn point_inside(&self, point: CGPoint, _event: Option<&AnyObject>) -> Bool {
            let pad = self.ivars().insets.get();
            let outset = UIEdgeInsets {
                top: -pad.top,
                left: -pad.left,
                bottom: -pad.bottom,
                right: -pad.right,
            };
            let r = inset(self.bounds(), outset);
            Bool::new(
                point.x >= r.origin.x
                    && point.y >= r.origin.y
                    && point.x < r.origin.x + r.size.width
                    && point.y < r.origin.y + r.size.height,
            )
        }

        #[unsafe(method(caretRectForPosition:))]
        fn caret_rect(&self, position: Option<&objc2::runtime::AnyObject>) -> CGRect {
            if self.ivars().caret_hidden.get() {
                return CGRect::ZERO;
            }
            // SAFETY: calling the superclass implementation.
            unsafe { msg_send![super(self), caretRectForPosition: position] }
        }

        /// Where the caret is, drawn or not (`caret()`).
        #[unsafe(method(nshCaretRectForPosition:))]
        fn shown_caret_rect(&self, position: Option<&objc2::runtime::AnyObject>) -> CGRect {
            // SAFETY: calling the superclass implementation.
            unsafe { msg_send![super(self), caretRectForPosition: position] }
        }

        /// A sink ([`is_sink`]: an editor's, which holds the text itself)
        /// is often empty: it says it has text, as UIKit repeats a held
        /// Delete only while the input has text.
        #[unsafe(method(hasText))]
        fn has_text(&self) -> Bool {
            if self.ivars().sink.get() {
                return Bool::YES;
            }
            // SAFETY: calling the superclass implementation.
            unsafe { msg_send![super(self), hasText] }
        }

        /// A paste (the edit menu, Command+V): reported, and its text
        /// inserted as `pasteBehavior` says, within `maxLength`.
        #[unsafe(method(paste:))]
        fn paste(&self, sender: Option<&AnyObject>) {
            if pasting(self.as_ref(), self.ivars()) {
                if self.ivars().max_length.get().is_some() {
                    paste_text(self.as_ref(), &objc2_ui_kit::UIPasteboard::generalPasteboard());
                } else {
                    // SAFETY: calling the superclass implementation.
                    let _: () = unsafe { msg_send![super(self), paste: sender] };
                }
            }
        }

        /// Paste is offered for images and files too while the app listens;
        /// a component's edit menu offers what it asked for.
        #[unsafe(method(canPerformAction:withSender:))]
        fn can_perform(&self, action: Sel, sender: Option<&AnyObject>) -> Bool {
            if let Some(offers) = edit_menu_offers(self.ivars(), action) {
                return Bool::new(offers);
            }
            if action == sel!(paste:) && can_paste_more(self.as_ref(), self.ivars()) {
                return Bool::YES;
            }
            // SAFETY: calling the superclass implementation.
            unsafe { msg_send![super(self), canPerformAction: action, withSender: sender] }
        }

        #[unsafe(method(cut:))]
        fn cut(&self, sender: Option<&AnyObject>) {
            if !edit_menu_chose(self.as_ref(), self.ivars(), EditAction::Cut) {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), cut: sender] };
            }
        }

        #[unsafe(method(copy:))]
        fn copy(&self, sender: Option<&AnyObject>) {
            if !edit_menu_chose(self.as_ref(), self.ivars(), EditAction::Copy) {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), copy: sender] };
            }
        }

        #[unsafe(method(selectAll:))]
        fn select_all(&self, sender: Option<&AnyObject>) {
            if !edit_menu_chose(self.as_ref(), self.ivars(), EditAction::SelectAll) {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), selectAll: sender] };
            }
        }

        /// `UIEditMenuInteractionDelegate`: the menu keeps clear of what
        /// the component selected.
        #[unsafe(method(editMenuInteraction:targetRectForConfiguration:))]
        fn edit_menu_target_rect(&self, _interaction: &AnyObject, _configuration: &AnyObject) -> CGRect {
            self.ivars()
                .edit_menu
                .borrow()
                .as_ref()
                .map_or(CGRect::ZERO, |(_, rect)| *rect)
        }

        /// The text's size changes after edits and layout without a
        /// scroll: a built-in bar's thumb follows it.
        #[unsafe(method(setContentSize:))]
        fn set_content_size(&self, size: CGSize) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), setContentSize: size] };
            self.scroll_changed();
        }

        /// The viewport's size changes in layout.
        #[unsafe(method(layoutSubviews))]
        fn layout_subviews(&self) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), layoutSubviews] };
            self.scroll_changed();
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
        fn presses_began(&self, presses: &NSSet<UIPress>, event: Option<&UIPressesEvent>) {
            if !crate::keymap::input_began(self.as_ref(), presses) {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), pressesBegan: presses, withEvent: event] };
            }
        }

        #[unsafe(method(pressesEnded:withEvent:))]
        fn presses_ended(&self, presses: &NSSet<UIPress>, event: Option<&UIPressesEvent>) {
            if !crate::keymap::input_ended(self.as_ref(), presses) {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), pressesEnded: presses, withEvent: event] };
            }
        }

        #[unsafe(method(pressesCancelled:withEvent:))]
        fn presses_cancelled(&self, presses: &NSSet<UIPress>, event: Option<&UIPressesEvent>) {
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
        let paste = crate::system::pasted(board, ivars.paste_max_size.get());
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
    if content
        .files
        .iter()
        .any(|file| image_type(&file.mime).is_none())
    {
        // Other files carry their names, as Files copies a document: as
        // item providers.
        set_providers(&board, content);
    } else {
        set_items(&board, content);
    }
    if pasting_from(view, ivars, &board) {
        paste_text(view, &board);
    }
    // SAFETY: a plain getter; the test's pasteboard is not used again.
    objc2_ui_kit::UIPasteboard::removePasteboardWithName(&*unsafe { board.name() });
    Ok(())
}

/// The input of the app that has the keyboard focus, if one has it
/// (`nsh test --target ios`): typing or a paste into it needs no tap, which
/// would move its caret or, on a word, select it.
#[cfg(feature = "dev")]
pub(crate) fn test_focused(window: &objc2_ui_kit::UIWindow) -> Option<NodeId> {
    let responder = crate::synth::first_responder(window)?;
    let view: &UIView = match responder.downcast_ref::<Field>() {
        Some(field) => field.as_ref(),
        None => responder.downcast_ref::<Area>()?.as_ref(),
    };
    Some(view.tag() as NodeId)
}

/// The pasteboard type of an image of MIME type `mime` that a test pastes.
#[cfg(feature = "dev")]
fn image_type(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("public.png"),
        "image/jpeg" => Some("public.jpeg"),
        "image/gif" => Some("com.compuserve.gif"),
        _ => None,
    }
}

/// A test's paste of `content` as pasteboard items (type to value).
#[cfg(feature = "dev")]
fn set_items(board: &objc2_ui_kit::UIPasteboard, content: &nsh_core::PasteEvent) {
    let mut items: Vec<Retained<NSDictionary<NSString, AnyObject>>> = Vec::new();
    let item = |kind: &str, value: &AnyObject| {
        NSDictionary::from_slices(&[&*NSString::from_str(kind)], &[value])
    };
    // Text and its HTML are one item, as a browser copies them.
    let mut kinds = Vec::new();
    let mut values: Vec<Retained<AnyObject>> = Vec::new();
    if !content.text.is_empty() {
        kinds.push(NSString::from_str("public.utf8-plain-text"));
        values.push(NSString::from_str(&content.text).into());
    }
    if !content.html.is_empty() {
        kinds.push(NSString::from_str("public.html"));
        values.push(NSString::from_str(&content.html).into());
    }
    if !kinds.is_empty() {
        let kinds: Vec<&NSString> = kinds.iter().map(|k| &**k).collect();
        let values: Vec<&AnyObject> = values.iter().map(|v| &**v).collect();
        items.push(NSDictionary::from_slices(&kinds, &values));
    }
    for file in &content.files {
        let kind = image_type(&file.mime).unwrap_or("public.data");
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
    let _: () = unsafe { msg_send![board, setItems: &*NSArray::from_retained_slice(&items)] };
}

/// A test's paste of `content` as item providers, one an item: its text,
/// its HTML, each file under the type of its name (else of its MIME type)
/// with its name suggested, and each `file:` URL.
#[cfg(feature = "dev")]
fn set_providers(board: &objc2_ui_kit::UIPasteboard, content: &nsh_core::PasteEvent) {
    let Some(class) = AnyClass::get(c"NSItemProvider") else {
        return;
    };
    let provider = |item: &AnyObject, kind: &str| -> Retained<AnyObject> {
        let kind = NSString::from_str(kind);
        // SAFETY: NSItemProvider's documented initializer (iOS 8); the item
        // (a string, data or URL) is secure coding.
        unsafe {
            let alloc: Allocated<AnyObject> = msg_send![class, alloc];
            msg_send![alloc, initWithItem: item, typeIdentifier: &*kind]
        }
    };
    let mut providers = Vec::new();
    if !content.text.is_empty() {
        providers.push(provider(
            &NSString::from_str(&content.text),
            "public.utf8-plain-text",
        ));
    }
    if !content.html.is_empty() {
        providers.push(provider(&NSString::from_str(&content.html), "public.html"));
    }
    for file in &content.files {
        let kind = image_type(&file.mime).map_or_else(
            || crate::file_drop::type_of_file(&file.name, &file.mime),
            str::to_owned,
        );
        let item = provider(&objc2_foundation::NSData::with_bytes(&file.data), &kind);
        let name = NSString::from_str(&file.name);
        // SAFETY: NSItemProvider's `suggestedName` setter (iOS 11).
        let _: () = unsafe { msg_send![&item, setSuggestedName: &*name] };
        providers.push(item);
    }
    for uri in &content.uris {
        if let Some(url) = objc2_foundation::NSURL::URLWithString(&NSString::from_str(uri)) {
            providers.push(provider(&url, "public.file-url"));
        }
    }
    // SAFETY: UIPasteboard's setter of item providers (iOS 11).
    let _: () =
        unsafe { msg_send![board, setItemProviders: &*NSArray::from_retained_slice(&providers)] };
}

/// Pastes `board`'s text into input `view`, cut to what `maxLength` leaves
/// room for between user-perceived characters ([`clip_chars`]), as a
/// browser's `maxlength`. Not UIKit's `paste:`: a paste of it the delegate
/// refuses leaves an undo step that crashes the app.
fn paste_text(view: &UIView, board: &objc2_ui_kit::UIPasteboard) {
    // SAFETY: a plain getter, read on the user's paste.
    let (Some(text), Some((start, end))) = (unsafe { board.string() }, selection(view)) else {
        return;
    };
    let range = NSRange::new(start as usize, (end - start) as usize);
    let text = clipped_paste(view, range, text);
    if text.length() == 0 {
        return;
    }
    let Some(target) = target_of(view) else {
        return;
    };
    // `insertText:` skips the delegate, so it is asked first, as for any edit.
    // SAFETY: the event target implements both delegates' methods.
    let allows: Bool = unsafe {
        if view.downcast_ref::<Field>().is_some() {
            msg_send![&*target, textField: view, shouldChangeCharactersInRange: range, replacementString: &*text]
        } else {
            msg_send![&*target, textView: view, shouldChangeTextInRange: range, replacementText: &*text]
        }
    };
    if allows.as_bool() {
        // SAFETY: UIKeyInput's method, which both input classes implement.
        let _: () = unsafe { msg_send![view, insertText: &*text] };
    }
}

/// The part of a paste that fits after replacing the native UTF-16 selection.
fn clipped_paste(view: &UIView, range: NSRange, text: Retained<NSString>) -> Retained<NSString> {
    let current = view
        .downcast_ref::<Field>()
        .and_then(|f| f.text())
        .or_else(|| view.downcast_ref::<Area>().map(|a| a.text()))
        .unwrap_or_default();
    let room = max_length(view).map_or(usize::MAX, |max| {
        (max as usize).saturating_sub(kept_chars(&current, range))
    });
    // A text of no more UTF-16 units than there is room for characters
    // fits as it is.
    if room < text.length() {
        let units = utf16(&text, NSRange::new(0, text.length()));
        NSString::from_str(clip_chars(&String::from_utf16_lossy(&units), room))
    } else {
        text
    }
}

/// The ivars of input view `view` (a field or a text area).
fn ivars_of(view: &UIView) -> Option<&InputIvars> {
    view.downcast_ref::<Field>()
        .map(|f| f.ivars())
        .or_else(|| view.downcast_ref::<Area>().map(|a| a.ivars()))
}

/// What a component's edit menu offers of `action`, while it has one open
/// on the input: only what it asked for (Paste with something to paste),
/// so UIKit's other actions for the input's own text stay out.
fn edit_menu_offers(ivars: &InputIvars, action: Sel) -> Option<bool> {
    let menu = ivars.edit_menu.borrow();
    let (actions, _) = menu.as_ref()?;
    let offers = |a: EditAction| actions.contains(&a);
    let board = || objc2_ui_kit::UIPasteboard::generalPasteboard();
    Some(if action == sel!(cut:) {
        offers(EditAction::Cut)
    } else if action == sel!(copy:) {
        offers(EditAction::Copy)
    } else if action == sel!(paste:) {
        // SAFETY: plain getters, which show no paste notice.
        offers(EditAction::Paste)
            && unsafe { board().hasStrings() || board().hasImages() || board().hasURLs() }
    } else if action == sel!(selectAll:) {
        offers(EditAction::SelectAll)
    } else {
        false
    })
}

/// Reports `action` chosen from a component's edit menu (`onEditAction`),
/// if one is open on input `view`; whether it did.
fn edit_menu_chose(view: &UIView, ivars: &InputIvars, action: EditAction) -> bool {
    if ivars.edit_menu.borrow().is_none() {
        return false;
    }
    if let Some(target) = target_of(view) {
        target.dispatch(
            view.tag() as NodeId,
            EventKind::EditAction,
            EventPayload::Map(vec![("action", PayloadValue::Str(action.js_name().into()))]),
        );
    }
    true
}

/// Opens the system's edit menu on input `view` over `rect` (in the
/// input), offering `actions` (`Command::OpenEditMenu`).
// `UIMenuController` before iOS 16.
#[allow(deprecated)]
pub(crate) fn open_edit_menu(view: &UIView, rect: CGRect, actions: Vec<EditAction>) {
    let Some(ivars) = ivars_of(view) else { return };
    ivars.edit_menu.replace(Some((actions, rect)));
    if !view.isFirstResponder() && !view.becomeFirstResponder() {
        return;
    }
    let interaction = AnyClass::get(c"UIEditMenuInteraction").map(|class| {
        ivars
            .edit_interaction
            .borrow_mut()
            .get_or_insert_with(|| {
                // SAFETY: `initWithDelegate:` is the interaction's
                // initializer; the input implements the delegate method it
                // answers and outlives the interaction (its view).
                let interaction: Retained<AnyObject> = unsafe {
                    let alloc: Allocated<AnyObject> = msg_send![class, alloc];
                    msg_send![alloc, initWithDelegate: view]
                };
                // SAFETY: UIView's `addInteraction:` with a UIInteraction.
                let _: () = unsafe { msg_send![view, addInteraction: &*interaction] };
                interaction
            })
            .clone()
    });
    match (interaction, AnyClass::get(c"UIEditMenuConfiguration")) {
        (Some(menu), Some(configuration)) => {
            let source = CGPoint::new(rect.origin.x + rect.size.width / 2.0, rect.origin.y);
            // SAFETY: UIEditMenuConfiguration's factory (a nil identifier)
            // and the interaction's `presentEditMenuWithConfiguration:`.
            unsafe {
                let config: Retained<AnyObject> = msg_send![
                    configuration,
                    configurationWithIdentifier: Option::<&AnyObject>::None,
                    sourcePoint: source
                ];
                // Above the selection where it fits, as a text view's menu
                // (`UIEditMenuArrowDirectionDown`); the system picks
                // another side where it does not.
                let _: () = msg_send![&*config, setPreferredArrowDirection: 2isize];
                let _: () = msg_send![&*menu, presentEditMenuWithConfiguration: &*config];
            }
        }
        _ => {
            let mtm = MainThreadMarker::from(view);
            objc2_ui_kit::UIMenuController::sharedMenuController(mtm)
                .showMenuFromView_rect(view, rect);
        }
    }
}

/// Closes the edit menu [`open_edit_menu`] opened on input `view`; the
/// edit actions are the input's own again.
#[allow(deprecated)]
pub(crate) fn close_edit_menu(view: &UIView) {
    let Some(ivars) = ivars_of(view) else { return };
    if ivars.edit_menu.take().is_none() {
        return;
    }
    if let Some(menu) = ivars.edit_interaction.borrow().as_ref() {
        // SAFETY: UIEditMenuInteraction's `dismissMenu`.
        let _: () = unsafe { msg_send![&**menu, dismissMenu] };
    } else if AnyClass::get(c"UIEditMenuInteraction").is_none() {
        let mtm = MainThreadMarker::from(view);
        objc2_ui_kit::UIMenuController::sharedMenuController(mtm).hideMenuFromView(view);
    }
}

/// Whether input `view` offers Paste for what UIKit's own paste would not:
/// images and files, while the app listens to pastes.
fn can_paste_more(view: &UIView, ivars: &InputIvars) -> bool {
    let board = objc2_ui_kit::UIPasteboard::generalPasteboard();
    // SAFETY: plain getters, which show no paste notice.
    // An item that is no text, image or link is a file held as data
    // (a document copied in Files), which the paste reports.
    ivars.paste_listens.get()
        && view.isFirstResponder()
        && unsafe {
            board.hasImages()
                || board.hasURLs()
                || (board.numberOfItems() > 0 && !board.hasStrings())
        }
}

/// Reports `paste` to the app (`onPaste`), through the input's delegate,
/// the event target.
pub(crate) fn report_paste(view: &UIView, paste: nsh_core::PasteEvent) {
    if let Some(target) = target_of(view) {
        target.pasted(view.tag() as NodeId, paste);
    }
}

/// Reports how far text area `view` scrolled (`EngineControl::input_scroll`)
/// while a bar of the app's follows it, if the offset, the text's size or
/// the viewport changed since the last report.
pub(crate) fn report_scroll(view: &UIView, control: &EngineControl) {
    let Some(area) = view.downcast_ref::<Area>() else {
        return;
    };
    let ivars = area.ivars();
    if !ivars.scroll_reports.get() {
        return;
    }
    let offset = area.contentOffset();
    let content = area.contentSize();
    let viewport = area.bounds().size;
    // A short text still fills the viewport, so the bar has no room to move.
    let height = content.height.max(viewport.height);
    let width = content.width.max(viewport.width);
    let now = [offset.y, width, height, viewport.width, viewport.height];
    if ivars.scroll_reported.replace(Some(now)) == Some(now) {
        return;
    }
    control.input_scroll(
        view.tag() as NodeId,
        point(Points::ZERO, px(offset.y as f32)),
        size(px(width as f32), px(height as f32)),
        size(px(viewport.width as f32), px(viewport.height as f32)),
    );
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
    if let Some(target) = target_of(view) {
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
/// coordinates (its container), drawn or not.
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

/// The event target of input view `view`, set when it was attached.
pub(crate) fn target_of(view: &UIView) -> Option<Retained<EventTarget>> {
    let ivars = view
        .downcast_ref::<Field>()
        .map(|f| f.ivars())
        .or_else(|| view.downcast_ref::<Area>().map(|a| a.ivars()))?;
    ivars.target.borrow().load()
}

/// Input `view` took the focus (its delegate's did-begin-editing): with
/// `selectTextOnFocus` its whole text is selected, however the focus came.
///
/// UIKit calls did-begin-editing from `becomeFirstResponder`, before the tap
/// that focused the input places its caret, so the text is selected on the
/// next main-queue turn. A selection the focusing gesture made by then (a
/// drag, a Shift-click) is the user's and stays.
pub(crate) fn began_editing(view: &UIView) {
    if !ivars_of(view).is_some_and(|i| i.select_on_focus.get()) {
        return;
    }
    let began = selection(view);
    let mtm = MainThreadMarker::from(view);
    let weak = dispatch2::MainThreadBound::new(Weak::from(view), mtm);
    dispatch2::DispatchQueue::main().exec_async(move || {
        let mtm = MainThreadMarker::new().expect("main queue");
        let Some(view) = weak.into_inner(mtm).load() else {
            return;
        };
        // Blurred meanwhile, or the prop was turned off.
        if !view.isFirstResponder() || !ivars_of(&view).is_some_and(|i| i.select_on_focus.get()) {
            return;
        }
        let now = selection(&view);
        if now != began && now.is_some_and(|(start, end)| start != end) {
            return;
        }
        // Reported as any other selection change, by the delegate.
        set_selection(&view, 0, u32::MAX);
    });
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
/// text within `max` characters (`maxLength`'s unit, Unicode scalar
/// values: an emoji is one, though UIKit's lengths count two UTF-16 units
/// for it).
pub(crate) fn fits(
    current: &NSString,
    range: NSRange,
    replacement: &NSString,
    max: Option<u32>,
) -> bool {
    let Some(max) = max else { return true };
    if replacement.length() == 0 {
        return true;
    }
    let len =
        kept_chars(current, range) + char_count(replacement, NSRange::new(0, replacement.length()));
    len <= max as usize
}

/// The characters of `string` outside `range`, which an edit of `range`
/// keeps.
fn kept_chars(string: &NSString, range: NSRange) -> usize {
    let all = string.length();
    let start = range.location.min(all);
    let end = range.location.saturating_add(range.length).min(all);
    char_count(string, NSRange::new(0, start)) + char_count(string, NSRange::new(end, all - end))
}

/// The characters (Unicode scalar values) in UTF-16 `range` of `string`;
/// an unpaired surrogate an input method left counts as one.
fn char_count(string: &NSString, range: NSRange) -> usize {
    char::decode_utf16(utf16(string, range)).count()
}

/// The UTF-16 units in `range` of `string`, which must be within it. Not
/// through UTF-8: NSString's conversion is null for a string with an
/// unpaired surrogate, which input methods can leave.
fn utf16(string: &NSString, range: NSRange) -> Vec<u16> {
    let mut units = vec![0_u16; range.length];
    // SAFETY: `range` is within the string, and the buffer has room for
    // each of its units; its pointer is non-null when empty too.
    unsafe {
        string.getCharacters_range(std::ptr::NonNull::new(units.as_mut_ptr()).unwrap(), range);
    }
    units
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

    /// Applies an app-accepted paste through UITextInput's selected range.
    pub(crate) fn insert_text(&self, text: &str) {
        let view = self.editor_view();
        let Some(config) = &self.config else { return };
        if !config.editable || marked_text(view).is_some() {
            return;
        }
        let Some((start, end)) = selection(view) else {
            return;
        };
        let text = nsh_core::text_edit::pasted(text, config.multiline);
        let range = NSRange::new(start as usize, (end - start) as usize);
        let text = clipped_paste(view, range, NSString::from_str(&text));
        // UITextInput's replacement applies one edit without interpreting a
        // pasted newline as the Return key. Both editor classes adopt it.
        unsafe {
            let selected: Option<Retained<AnyObject>> = msg_send![view, selectedTextRange];
            if let Some(selected) = selected {
                let _: () = msg_send![view, replaceRange: &*selected, withText: &*text];
            }
        }
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
                *field.ivars().target.borrow_mut() = Weak::new(target);
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
                *view.ivars().target.borrow_mut() = Weak::new(target);
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
        // UIKit tints the caret and the selection with one color. It also
        // draws an input method's marked range and a caret of its own in
        // the tint while composing, whatever `caretRectForPosition:` says:
        // on a sink they would show over the editor's own drawing.
        let tint = match is_sink(&config) {
            true => Some(UIColor::clearColor()),
            false => config.caret_color.or(config.selection_color).map(ui_color),
        };
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
                field.ivars().sink.set(is_sink(&config));
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
                view.ivars().sink.set(is_sink(&config));
                view.ivars().submit.set(config.submit());
                // A built-in bar of the app's takes the indicator's place;
                // the text still scrolls.
                view.setShowsVerticalScrollIndicator(config.scrollbar_visible);
                view.ivars().scroll_reports.set(config.report_scroll);
                // Reported again once the configuration is applied.
                view.ivars().scroll_reported.set(None);
            }
        }
        if let Some(ivars) = ivars_of(self.editor_view()) {
            ivars.select_on_focus.set(config.select_text_on_focus);
            ivars.paste_max_size.set(config.paste_max_size);
        }
        crate::mount::mirror(self.editor_view(), config.rtl);
        set_paste(
            self.editor_view(),
            self.paste_listens,
            config.paste_behavior == nsh_core::PasteBehavior::Insert,
        );
        let first = self.config.is_none();
        let auto_focus = config.auto_focus;
        let reports = config.report_scroll;
        self.config = Some(config);
        self.update_placeholder();
        if reports {
            target.input_scrolled(self.editor_view());
        }
        if first && auto_focus {
            self.editor_view().becomeFirstResponder();
        }
    }

    /// Scrolls a text area's text to `y` (`Command::ScrollTo`, a built-in
    /// bar's drags), clamped to what it can scroll.
    pub(crate) fn scroll_to(&self, y: Points, animated: bool) {
        let Editor::Area { view, .. } = &self.editor else {
            return;
        };
        let inset = view.adjustedContentInset();
        let max =
            (view.contentSize().height + inset.bottom - view.bounds().size.height).max(-inset.top);
        let offset = CGPoint::new(
            view.contentOffset().x,
            (y.0 as CGFloat).clamp(-inset.top, max),
        );
        view.setContentOffset_animated(offset, animated);
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
                // At the content box, as every platform's editor is: the
                // scroll view clips its text there, so text scrolled past
                // it never shows in the padding or under the border. Its
                // autoresizing keeps the padding as the input resizes.
                view.ivars().insets.set(insets);
                view.setFrame(CGRect::new(
                    CGPoint::new(content.origin.x.0 as CGFloat, content.origin.y.0 as CGFloat),
                    CGSize::new(
                        content.size.width.0 as CGFloat,
                        content.size.height.0 as CGFloat,
                    ),
                ));
                view.setTextContainerInset(UIEdgeInsets {
                    top: 0.0,
                    left: 0.0,
                    bottom: 0.0,
                    right: 0.0,
                });
                let width = content.size.width.0 as CGFloat;
                placeholder.setFrame(CGRect::new(
                    CGPoint::new(0.0, 0.0),
                    CGSize::new(width, content.size.height.0 as CGFloat),
                ));
                placeholder.sizeToFit();
                let size = placeholder.frame().size;
                placeholder.setFrame(CGRect::new(
                    CGPoint::new(0.0, 0.0),
                    CGSize::new(width, size.height),
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
        KeyboardType::Default if config.visible_password() => UIKeyboardType::ASCIICapable,
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
    // A visible password is typed as it is: never capitalized or corrected.
    let password = config.visible_password();
    let capitalize = match config.auto_capitalize {
        _ if password => UITextAutocapitalizationType::None,
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
    let correct = if config.auto_correct && !password {
        UITextAutocorrectionType::Default
    } else {
        UITextAutocorrectionType::No
    };
    // Smart quotes and dashes are corrections too: off with `autoCorrect`.
    let smart = if config.auto_correct && !password {
        (
            UITextSmartQuotesType::Default.0,
            UITextSmartDashesType::Default.0,
        )
    } else {
        (UITextSmartQuotesType::No.0, UITextSmartDashesType::No.0)
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
        send(view, sel!(setSmartQuotesType:), smart.0);
        send(view, sel!(setSmartDashesType:), smart.1);
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
            AutoFill::CreditCardExpiration => {
                ios17_content_type(c"UITextContentTypeCreditCardExpiration")?
            }
            AutoFill::CreditCardSecurityCode => {
                ios17_content_type(c"UITextContentTypeCreditCardSecurityCode")?
            }
            AutoFill::CreditCardName => ios17_content_type(c"UITextContentTypeCreditCardName")?,
            AutoFill::Url => UITextContentTypeURL,
            AutoFill::Birthdate => ios17_content_type(c"UITextContentTypeBirthdate")?,
        })
    }
}

/// The UIKit constant `name`, which exists from iOS 17 on; `None` before.
///
/// Looked up at run time: naming the `objc2_ui_kit` static is a strong import,
/// and dyld then refuses to start the app on iOS 15 and 16, whether or not an
/// input uses it. See `docs/dev/pitfalls.md`.
fn ios17_content_type(name: &CStr) -> Option<&'static NSString> {
    // SAFETY: the symbol, when present, is UIKit's immutable
    // `NSString *const`, set for the life of the process.
    unsafe {
        let symbol = libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr());
        (symbol as *const *const NSString)
            .as_ref()
            .and_then(|constant| constant.as_ref())
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

/// Whether an input draws no caret and no text: another view's sink for
/// typed text and input methods (an editor's), which draws them itself.
fn is_sink(config: &InputConfig) -> bool {
    config.caret_hidden && config.style.color.is_transparent()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// On iOS 17 and later, the kinds looked up at run time are UIKit's own
    /// constants, as if named directly.
    #[test]
    fn ios_17_content_types_resolve_to_uikits_constants() {
        use objc2_ui_kit::{
            UITextContentTypeBirthdate, UITextContentTypeCreditCardExpiration,
            UITextContentTypeCreditCardName, UITextContentTypeCreditCardSecurityCode,
        };

        // SAFETY: immutable UIKit constants.
        let expected = unsafe {
            [
                (
                    AutoFill::CreditCardExpiration,
                    UITextContentTypeCreditCardExpiration,
                ),
                (
                    AutoFill::CreditCardSecurityCode,
                    UITextContentTypeCreditCardSecurityCode,
                ),
                (AutoFill::CreditCardName, UITextContentTypeCreditCardName),
                (AutoFill::Birthdate, UITextContentTypeBirthdate),
            ]
        };
        for (fill, constant) in expected {
            let found = content_type(fill).unwrap_or_else(|| panic!("{fill:?} has no type"));
            assert!(std::ptr::eq(found, constant), "{fill:?}");
        }
    }

    /// A constant the running system does not have leaves the type unset.
    #[test]
    fn a_missing_content_type_is_none() {
        assert!(ios17_content_type(c"UITextContentTypeThatDoesNotExist").is_none());
    }

    /// Only an input without a caret and with transparent text is a sink:
    /// an app's `caret={false}` input keeps its selection's tint.
    #[test]
    // InputConfig is non-exhaustive outside nsh-core.
    #[allow(clippy::field_reassign_with_default)]
    fn only_an_input_without_caret_or_text_is_a_sink() {
        let mut c = InputConfig::default();
        c.caret_hidden = true;
        c.style.color = Color::TRANSPARENT;
        assert!(is_sink(&c));
        c.style.color = Color::BLACK;
        assert!(!is_sink(&c));
        c.style.color = Color::TRANSPARENT;
        c.caret_hidden = false;
        assert!(!is_sink(&c));
    }
}
