//! Range selection of `selectable` text. [`TextView`] draws CoreText lines
//! itself, so it adopts `UITextInput` (non-editable) and lets a
//! `UITextInteraction` do the rest, as UIKit's own text views do: the long
//! press that selects a word, the loupe, the handles, the highlight (in the
//! view's tint: `selectionColor`) and the edit menu (Copy, Select All, Look
//! Up, Translate, Share). Positions are UTF-16 offsets into the block's text,
//! the indices CoreText's lines use.
//!
//! Only selectable text has the interaction; other text never becomes first
//! responder, so it never sees any of this.

use std::cell::{Cell, RefCell};

use nsh_core::{ATTACHMENT_CHAR, Affinity, TextPosition};
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::{Retained, Weak},
    runtime::ProtocolObject,
};
use objc2_core_foundation::{CGFloat, CGPoint, CGRect, CGSize};
use objc2_foundation::{NSArray, NSObject, NSRange, NSString};
use objc2_ui_kit::{
    NSWritingDirection, UITextInput, UITextInputDelegate, UITextInputStringTokenizer,
    UITextInteraction, UITextInteractionMode, UITextLayoutDirection, UITextPosition, UITextRange,
    UITextSelectionRect, UIView,
};

use crate::{
    text::{CoreTextLayout, line_of},
    text_view::TextView,
};

define_class!(
    /// A position in the text (UTF-16 offset).
    #[unsafe(super(UITextPosition, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = usize]
    pub(crate) struct Position;
);

impl Position {
    fn make(mtm: MainThreadMarker, offset: usize) -> Retained<UITextPosition> {
        let this = Self::alloc(mtm).set_ivars(offset);
        // SAFETY: NSObject's `init`.
        let this: Retained<Self> = unsafe { msg_send![super(this), init] };
        Retained::into_super(this)
    }
}

define_class!(
    /// A range of the text (UTF-16 offsets, `start <= end`).
    #[unsafe(super(UITextRange, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = (usize, usize)]
    pub(crate) struct Range;

    impl Range {
        #[unsafe(method(isEmpty))]
        fn is_empty(&self) -> bool {
            let (start, end) = *self.ivars();
            start == end
        }

        #[unsafe(method_id(start))]
        fn start(&self) -> Retained<UITextPosition> {
            Position::make(self.mtm(), self.ivars().0)
        }

        #[unsafe(method_id(end))]
        fn end(&self) -> Retained<UITextPosition> {
            Position::make(self.mtm(), self.ivars().1)
        }
    }
);

impl Range {
    fn make(mtm: MainThreadMarker, a: usize, b: usize) -> Retained<UITextRange> {
        let this = Self::alloc(mtm).set_ivars((a.min(b), a.max(b)));
        // SAFETY: NSObject's `init`.
        let this: Retained<Self> = unsafe { msg_send![super(this), init] };
        Retained::into_super(this)
    }
}

define_class!(
    /// One line's part of a selection, for UIKit's highlight and handles.
    #[unsafe(super(UITextSelectionRect, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = SelectionRectIvars]
    pub(crate) struct SelectionRect;

    impl SelectionRect {
        #[unsafe(method(rect))]
        fn rect(&self) -> CGRect {
            self.ivars().rect
        }

        #[unsafe(method(writingDirection))]
        fn writing_direction(&self) -> NSWritingDirection {
            self.ivars().direction
        }

        #[unsafe(method(containsStart))]
        fn contains_start(&self) -> bool {
            self.ivars().start
        }

        #[unsafe(method(containsEnd))]
        fn contains_end(&self) -> bool {
            self.ivars().end
        }

        #[unsafe(method(isVertical))]
        fn is_vertical(&self) -> bool {
            false
        }
    }
);

pub(crate) struct SelectionRectIvars {
    rect: CGRect,
    direction: NSWritingDirection,
    start: bool,
    end: bool,
}

impl SelectionRect {
    fn make(mtm: MainThreadMarker, ivars: SelectionRectIvars) -> Retained<UITextSelectionRect> {
        let this = Self::alloc(mtm).set_ivars(ivars);
        // SAFETY: NSObject's `init`.
        let this: Retained<Self> = unsafe { msg_send![super(this), init] };
        Retained::into_super(this)
    }
}

/// The offset of a position UIKit got from the view (0 for any other).
pub(crate) fn offset(position: &UITextPosition) -> usize {
    position
        .downcast_ref::<Position>()
        .map_or(0, |p| *p.ivars())
}

/// The offsets of a range UIKit got from the view.
pub(crate) fn bounds(range: &UITextRange) -> (usize, usize) {
    range.downcast_ref::<Range>().map_or((0, 0), |r| *r.ivars())
}

/// A text view's selection state.
#[derive(Default)]
pub(crate) struct Selection {
    /// The selected range, while there is one.
    range: Cell<Option<(usize, usize)>>,
    interaction: RefCell<Option<Retained<UITextInteraction>>>,
    /// UIKit's observer of the selection, while the view is first responder.
    delegate: RefCell<Option<Weak<ProtocolObject<dyn UITextInputDelegate>>>>,
    /// The text as UIKit reads it (made on first use).
    text: RefCell<Option<Retained<NSString>>>,
    tokenizer: RefCell<Option<Retained<UITextInputStringTokenizer>>>,
}

impl Selection {
    /// Selection is on (the interaction is attached).
    pub(crate) fn is_on(&self) -> bool {
        self.interaction.borrow().is_some()
    }
}

impl TextView {
    /// Turns selection on or off and gives it `color` (the view's tint;
    /// the inherited one when `None`). Called with every new text.
    pub(crate) fn set_selectable(
        &self,
        selectable: bool,
        color: Option<nsh_core::Color>,
        text_changed: bool,
    ) {
        let state = &self.ivars().selection;
        if text_changed {
            *state.text.borrow_mut() = None;
            if state.range.get().is_some() {
                // Offsets into the old text mean nothing in the new one.
                self.resignFirstResponder();
            }
        }
        let has = state.interaction.borrow().is_some();
        match (has, selectable) {
            (false, true) => {
                let interaction = UITextInteraction::textInteractionForMode(
                    UITextInteractionMode::NonEditable,
                    self.mtm(),
                );
                // SAFETY: the view adopts UITextInput; the interaction keeps
                // it weakly.
                unsafe { interaction.setTextInput(Some(self)) };
                self.addInteraction(ProtocolObject::from_ref(&*interaction));
                self.setUserInteractionEnabled(true);
                *state.interaction.borrow_mut() = Some(interaction);
            }
            (true, false) => {
                self.resignFirstResponder();
                if let Some(interaction) = state.interaction.borrow_mut().take() {
                    self.removeInteraction(ProtocolObject::from_ref(&*interaction));
                }
            }
            _ => {}
        }
        if selectable {
            let tint = color.map(|c| {
                let (r, g, b, a) = c.to_f64();
                objc2_ui_kit::UIColor::colorWithRed_green_blue_alpha(r, g, b, a)
            });
            // SAFETY: a plain setter.
            unsafe { self.setTintColor(tint.as_deref()) };
        }
    }

    /// The text has a selection.
    pub(crate) fn has_selection(&self) -> bool {
        self.ivars()
            .selection
            .range
            .get()
            .is_some_and(|(a, b)| a < b)
    }

    /// The whole text is selected.
    pub(crate) fn all_selected(&self) -> bool {
        self.ivars().selection.range.get() == Some((0, self.text_length()))
    }

    /// The selected text, without the placeholders of attachments.
    pub(crate) fn selected_string(&self) -> Option<String> {
        let (a, b) = self.ivars().selection.range.get().filter(|(a, b)| a < b)?;
        let text = self.ns_text().substringWithRange(NSRange::new(a, b - a));
        Some(text.to_string().replace(ATTACHMENT_CHAR, ""))
    }

    /// Changes the selection from code (not UIKit), telling UIKit's
    /// observer.
    pub(crate) fn change_selection(&self, range: Option<(usize, usize)>) {
        let state = &self.ivars().selection;
        if state.range.get() == range {
            return;
        }
        let delegate = state.delegate.borrow().as_ref().and_then(Weak::load);
        let input = ProtocolObject::<dyn UITextInput>::from_ref(self);
        if let Some(d) = &delegate {
            d.selectionWillChange(Some(input));
        }
        state.range.set(range);
        if let Some(d) = &delegate {
            d.selectionDidChange(Some(input));
        }
    }

    /// The view stopped being first responder: no selection, and no
    /// tokenizer (it may hold the view) until UIKit asks again.
    pub(crate) fn end_selection(&self) {
        self.change_selection(None);
        *self.ivars().selection.tokenizer.borrow_mut() = None;
    }

    pub(crate) fn sel_selected_range(&self) -> Option<Retained<UITextRange>> {
        let (a, b) = self.ivars().selection.range.get()?;
        Some(Range::make(self.mtm(), a, b))
    }

    pub(crate) fn sel_set_selected_range(&self, range: Option<&UITextRange>) {
        let range = range.map(bounds).filter(|(a, b)| a < b);
        let len = self.text_length();
        self.ivars()
            .selection
            .range
            .set(range.map(|(a, b)| (a.min(len), b.min(len))));
    }

    pub(crate) fn sel_delegate(&self) -> Option<Retained<ProtocolObject<dyn UITextInputDelegate>>> {
        self.ivars()
            .selection
            .delegate
            .borrow()
            .as_ref()
            .and_then(Weak::load)
    }

    pub(crate) fn sel_set_delegate(
        &self,
        delegate: Option<&ProtocolObject<dyn UITextInputDelegate>>,
    ) {
        *self.ivars().selection.delegate.borrow_mut() = delegate.map(Weak::from);
    }

    pub(crate) fn sel_tokenizer(
        &self,
    ) -> Retained<ProtocolObject<dyn objc2_ui_kit::UITextInputTokenizer>> {
        let mut tokenizer = self.ivars().selection.tokenizer.borrow_mut();
        let tokenizer = tokenizer.get_or_insert_with(|| {
            // SAFETY: the view adopts UITextInput.
            unsafe {
                UITextInputStringTokenizer::initWithTextInput(
                    UITextInputStringTokenizer::alloc(self.mtm()),
                    self,
                )
            }
        });
        ProtocolObject::from_retained(tokenizer.clone())
    }

    /// The text as an NSString (UTF-16, as UIKit counts).
    pub(crate) fn ns_text(&self) -> Retained<NSString> {
        let mut cached = self.ivars().selection.text.borrow_mut();
        cached
            .get_or_insert_with(|| {
                let text = self.ivars().text.borrow();
                NSString::from_str(text.as_ref().map_or("", |t| &t.text))
            })
            .clone()
    }

    pub(crate) fn text_length(&self) -> usize {
        self.ns_text().length()
    }

    pub(crate) fn sel_text_in(&self, range: &UITextRange) -> Option<Retained<NSString>> {
        let len = self.text_length();
        let (a, b) = bounds(range);
        let (a, b) = (a.min(len), b.min(len));
        Some(self.ns_text().substringWithRange(NSRange::new(a, b - a)))
    }

    pub(crate) fn sel_position(&self, offset: usize) -> Retained<UITextPosition> {
        Position::make(self.mtm(), offset)
    }

    pub(crate) fn sel_range(
        &self,
        a: &UITextPosition,
        b: &UITextPosition,
    ) -> Retained<UITextRange> {
        Range::make(self.mtm(), offset(a), offset(b))
    }

    /// `offset` moved by `by`, if it stays in the text.
    pub(crate) fn sel_moved(
        &self,
        position: &UITextPosition,
        by: isize,
    ) -> Option<Retained<UITextPosition>> {
        let to = offset(position).checked_add_signed(by)?;
        (to <= self.text_length()).then(|| Position::make(self.mtm(), to))
    }

    /// `position` moved `by` in `direction`: characters left and right,
    /// lines up and down (keeping the x).
    pub(crate) fn sel_moved_in(
        &self,
        position: &UITextPosition,
        direction: UITextLayoutDirection,
        by: isize,
    ) -> Option<Retained<UITextPosition>> {
        let rtl = self.ivars().text.borrow().as_ref().is_some_and(|t| t.rtl);
        let forward = if rtl {
            UITextLayoutDirection::Left
        } else {
            UITextLayoutDirection::Right
        };
        let backward = if rtl {
            UITextLayoutDirection::Right
        } else {
            UITextLayoutDirection::Left
        };
        if direction == forward {
            return self.sel_moved(position, by);
        }
        if direction == backward {
            return self.sel_moved(position, -by);
        }
        let at = offset(position);
        let len = self.text_length();
        let to = self
            .with_text(|text, _| {
                let lines = text.boxes();
                let line = line_of(&lines, at, Affinity::Downstream)?;
                let target = if direction == UITextLayoutDirection::Up {
                    line as isize - by
                } else {
                    line as isize + by
                };
                Some(match usize::try_from(target) {
                    Err(_) => 0,
                    Ok(t) if t >= lines.len() => len,
                    Ok(t) => lines.get(t)?.index_at(lines.get(line)?.x_of(at)),
                })
            })
            .flatten()?;
        Some(Position::make(self.mtm(), to))
    }

    /// The end of `range` farthest in `direction`.
    pub(crate) fn sel_farthest(
        &self,
        range: &UITextRange,
        direction: UITextLayoutDirection,
    ) -> Retained<UITextPosition> {
        let (a, b) = bounds(range);
        let start =
            direction == UITextLayoutDirection::Left || direction == UITextLayoutDirection::Up;
        Position::make(self.mtm(), if start { a } else { b })
    }

    /// The character next to `position` in `direction`.
    pub(crate) fn sel_extend(
        &self,
        position: &UITextPosition,
        direction: UITextLayoutDirection,
    ) -> Retained<UITextRange> {
        let at = offset(position);
        let back =
            direction == UITextLayoutDirection::Left || direction == UITextLayoutDirection::Up;
        let other = if back {
            at.saturating_sub(1)
        } else {
            (at + 1).min(self.text_length())
        };
        Range::make(self.mtm(), at, other)
    }

    pub(crate) fn sel_direction(&self) -> NSWritingDirection {
        if self.ivars().text.borrow().as_ref().is_some_and(|t| t.rtl) {
            NSWritingDirection::RightToLeft
        } else {
            NSWritingDirection::LeftToRight
        }
    }

    /// Runs `f` with the laid out text and the origin of its content box
    /// (the view coordinates of the layout's content coordinates). `None`
    /// without a layout.
    fn with_text<R>(&self, f: impl FnOnce(&CoreTextLayout, CGPoint) -> R) -> Option<R> {
        let layout = self.ivars().layout.borrow();
        let (layout, content) = layout.as_ref()?;
        let text = layout.downcast::<CoreTextLayout>()?;
        let origin = CGPoint::new(content.origin.x.0 as CGFloat, content.origin.y.0 as CGFloat);
        Some(f(text, origin))
    }

    /// The caret position nearest to `point` (view coordinates), within
    /// `range` if given.
    pub(crate) fn sel_closest(
        &self,
        point: CGPoint,
        range: Option<&UITextRange>,
    ) -> Option<Retained<UITextPosition>> {
        let mut at = self.closest_offset(point);
        if let Some(range) = range {
            let (a, b) = bounds(range);
            at = at.clamp(a, b);
        }
        Some(Position::make(self.mtm(), at.min(self.text_length())))
    }

    /// The caret offset nearest to `point` (view coordinates).
    pub(crate) fn closest_offset(&self, point: CGPoint) -> usize {
        self.with_text(|text, o| {
            text.position_at(CGPoint::new(point.x - o.x, point.y - o.y))
                .offset as usize
        })
        .unwrap_or(0)
    }

    /// The character under `point`.
    pub(crate) fn sel_character_at(&self, point: CGPoint) -> Option<Retained<UITextRange>> {
        let at = offset(&*self.sel_closest(point, None)?);
        Some(Range::make(
            self.mtm(),
            at,
            (at + 1).min(self.text_length()),
        ))
    }

    /// The caret's rect before character `position`.
    pub(crate) fn sel_caret(&self, position: &UITextPosition) -> CGRect {
        self.caret_rect_at(offset(position), false)
    }

    /// The caret's rect at offset `at` (view coordinates); `trailing`
    /// puts an offset where a line wraps at the end of the line before
    /// (where a selection that ends there ends) rather than at the start
    /// of the next.
    pub(crate) fn caret_rect_at(&self, at: usize, trailing: bool) -> CGRect {
        let affinity = if trailing {
            Affinity::Upstream
        } else {
            Affinity::Downstream
        };
        let position = TextPosition::new(u32::try_from(at).unwrap_or(u32::MAX), affinity);
        // UIKit's caret is a 2 point wide bar; the layout's is zero wide.
        self.with_text(|text, o| {
            let rect = text.caret_box(position)?;
            Some(CGRect::new(
                CGPoint::new(rect.origin.x + o.x, rect.origin.y + o.y),
                CGSize::new(2.0, rect.size.height),
            ))
        })
        .flatten()
        .unwrap_or_else(|| {
            let content = self
                .content_box()
                .unwrap_or(CGRect::new(CGPoint::ZERO, CGSize::ZERO));
            CGRect::new(content.origin, CGSize::new(2.0, content.size.height))
        })
    }

    /// The box the text is laid out in (view coordinates).
    pub(crate) fn content_box(&self) -> Option<CGRect> {
        let layout = self.ivars().layout.borrow();
        let (_, c) = layout.as_ref()?;
        Some(CGRect::new(
            CGPoint::new(c.origin.x.0 as CGFloat, c.origin.y.0 as CGFloat),
            CGSize::new(c.size.width.0 as CGFloat, c.size.height.0 as CGFloat),
        ))
    }

    /// The rects of `range` on each line it covers.
    fn rects(&self, range: &UITextRange) -> Vec<(CGRect, bool, bool)> {
        let (a, b) = bounds(range);
        self.range_rects(a, b)
    }

    /// The rects of the UTF-16 range `a..b` on each line it covers (view
    /// coordinates), with whether each holds its start and its end.
    pub(crate) fn range_rects(&self, a: usize, b: usize) -> Vec<(CGRect, bool, bool)> {
        self.with_text(|text, o| {
            let mut boxes = text.range_boxes(a, b);
            for (rect, ..) in &mut boxes {
                rect.origin.x += o.x;
                rect.origin.y += o.y;
            }
            boxes
        })
        .unwrap_or_default()
    }

    pub(crate) fn sel_first_rect(&self, range: &UITextRange) -> CGRect {
        self.rects(range)
            .first()
            .map_or(CGRect::new(CGPoint::ZERO, CGSize::ZERO), |r| r.0)
    }

    pub(crate) fn sel_rects(&self, range: &UITextRange) -> Retained<NSArray<UITextSelectionRect>> {
        let direction = self.sel_direction();
        let rects: Vec<_> = self
            .rects(range)
            .into_iter()
            .map(|(rect, start, end)| {
                SelectionRect::make(
                    self.mtm(),
                    SelectionRectIvars {
                        rect,
                        direction,
                        start,
                        end,
                    },
                )
            })
            .collect();
        NSArray::from_retained_slice(&rects)
    }

    /// No keyboard comes up for a text that is only selected.
    pub(crate) fn sel_input_view(&self) -> Retained<UIView> {
        UIView::initWithFrame(
            UIView::alloc(self.mtm()),
            CGRect::new(CGPoint::ZERO, CGSize::ZERO),
        )
    }
}

#[cfg(test)]
mod tests {
    use objc2::{ClassType, ProtocolType};

    use super::*;

    /// The classes register: their methods' types match UIKit's protocols
    /// and superclasses (objc2 checks them in debug builds).
    #[test]
    fn classes_register() {
        let _ = Position::class();
        let _ = Range::class();
        let _ = SelectionRect::class();
        let class = TextView::class();
        assert!(class.conforms_to(<dyn UITextInput>::protocol().expect("UITextInput")));
    }

    /// A type encoding without its frame offsets (`@24@0:8` → `@@:`).
    fn shape(types: &std::ffi::CStr) -> String {
        types
            .to_string_lossy()
            .chars()
            .filter(|c| !c.is_ascii_digit())
            .collect()
    }

    /// The methods each class defines have the types UIKit declares for
    /// them (objc2 does not check protocols': a wrong one would crash
    /// when UIKit calls it), and every required one of UITextInput is
    /// there.
    #[test]
    fn methods_match_uikit() {
        use objc2::{ffi, runtime::AnyClass};
        let protocols = [
            <dyn UITextInput>::protocol().expect("UITextInput"),
            <dyn objc2_ui_kit::UIKeyInput>::protocol().expect("UIKeyInput"),
        ];
        let check = |class: &AnyClass, superclass: &AnyClass| {
            let mut checked = 0;
            for method in class.instance_methods().iter() {
                let sel = method.name();
                // SAFETY: a method of the class.
                let ours = shape(unsafe {
                    std::ffi::CStr::from_ptr(ffi::method_getTypeEncoding(*method))
                });
                let mut declared = None;
                for protocol in protocols {
                    for required in [true, false] {
                        // SAFETY: a protocol and a selector.
                        let d = unsafe {
                            ffi::protocol_getMethodDescription(
                                protocol,
                                sel,
                                objc2::runtime::Bool::new(required),
                                objc2::runtime::Bool::YES,
                            )
                        };
                        if d.name.is_some() && !d.types.is_null() {
                            // SAFETY: the runtime's C string.
                            declared = Some(shape(unsafe { std::ffi::CStr::from_ptr(d.types) }));
                        }
                    }
                }
                if declared.is_none()
                    && let Some(inherited) = superclass.instance_method(sel)
                {
                    // SAFETY: a method of the superclass.
                    declared = Some(shape(unsafe {
                        std::ffi::CStr::from_ptr(ffi::method_getTypeEncoding(inherited))
                    }));
                }
                if let Some(declared) = declared {
                    assert_eq!(ours, declared, "{sel}");
                    checked += 1;
                }
            }
            checked
        };
        assert!(check(TextView::class(), UIView::class()) >= 30);
        assert_eq!(check(Range::class(), UITextRange::class()), 3);
        assert_eq!(
            check(SelectionRect::class(), UITextSelectionRect::class()),
            5
        );
        for protocol in protocols {
            let mut count = 0;
            // SAFETY: a protocol; the list is freed below.
            let list = unsafe {
                ffi::protocol_copyMethodDescriptionList(
                    protocol,
                    objc2::runtime::Bool::YES,
                    objc2::runtime::Bool::YES,
                    &mut count,
                )
            };
            for i in 0..count as usize {
                // SAFETY: `count` descriptions.
                let sel = unsafe { (*list.add(i)).name }.expect("name");
                assert!(
                    TextView::class().instance_method(sel).is_some(),
                    "{sel} is missing"
                );
            }
            // SAFETY: the runtime's allocation.
            unsafe { ffi::free(list.cast()) };
        }
    }
}
