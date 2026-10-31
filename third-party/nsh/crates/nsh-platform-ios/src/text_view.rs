use std::{cell::RefCell, sync::Arc};

use nsh_core::{
    AttributedText, Bounds, Points, TextLayout, TextLink,
    transition::{Recolor, TextColor},
};
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, ProtocolObject, Sel},
    sel,
};
use objc2_core_foundation::{
    CFArray, CFDictionary, CFIndex, CFNumber, CFRange, CFString, CFType, CGAffineTransform,
    CGFloat, CGPoint, CGRect, CGSize,
};
use objc2_core_graphics::{CGColor, CGContext};
use objc2_core_text::{CTFont, CTRun, kCTFontAttributeName};
use objc2_foundation::{
    NSArray, NSAttributedStringKey, NSComparisonResult, NSDictionary, NSInteger, NSObject,
    NSObjectProtocol, NSRange, NSString,
};
use objc2_ui_kit::{
    NSWritingDirection, UIAccessibilityTraitStaticText, UIAccessibilityTraits, UIColor,
    UIGraphicsGetCurrentContext, UIKeyInput, UIResponder, UITextInput, UITextInputDelegate,
    UITextInputTokenizer, UITextInputTraits, UITextLayoutDirection, UITextPosition, UITextRange,
    UITextSelectionRect, UITextStorageDirection, UIView,
};

use crate::{
    native_view::NshView,
    text::{CoreTextLayout, LaidLine, decoration_key, strikethrough_key, underline_key},
    text_selection::{self, Selection},
};

/// Draws the decoration lines CoreText does not: strikethroughs, and
/// underlines with a style, thickness or offset (y-up text space).
fn draw_decorations(cx: &CGContext, line: &LaidLine) {
    // SAFETY: the line's own run array (of CTRuns) and their attribute
    // dictionaries, whose values have the types set by the text engine.
    unsafe {
        let runs = line.line.glyph_runs();
        for i in 0..runs.count() {
            let run = &*runs.value_at_index(i).cast::<CTRun>();
            let attributes = run.attributes();
            let attributes: &CFDictionary<CFString, CFType> = attributes.cast_unchecked();
            let strike = attributes
                .get(strikethrough_key())
                .and_then(|c| c.downcast::<CGColor>().ok());
            let under = attributes
                .get(underline_key())
                .and_then(|c| c.downcast::<CGColor>().ok());
            if strike.is_none() && under.is_none() {
                continue;
            }
            let Some(font) = attributes
                .get(kCTFontAttributeName)
                .and_then(|f| f.downcast::<CTFont>().ok())
            else {
                continue;
            };
            let (mut style, mut thickness, mut offset) = (0, 0.0, CGFloat::NAN);
            if let Some(d) = attributes
                .get(decoration_key())
                .and_then(|d| d.downcast::<CFArray>().ok())
            {
                let n = |i: CFIndex| {
                    (*d.value_at_index(i).cast::<CFNumber>())
                        .as_cgfloat()
                        .unwrap_or(0.0)
                };
                style = n(0) as i32;
                thickness = n(1);
                offset = n(2);
            }
            if thickness <= 0.0 {
                thickness = font.underline_thickness().max(1.0);
            }
            let range = run.string_range();
            let x = line.origin.x
                + line
                    .line
                    .offset_for_string_index(range.location, std::ptr::null_mut());
            let width = run.typographic_bounds(
                CFRange {
                    location: 0,
                    length: 0,
                },
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            if let Some(color) = strike {
                let y = line.origin.y + font.x_height() / 2.0;
                stroke_decoration(cx, &color, style, x, y, width, thickness);
            }
            if let Some(color) = under {
                // Below the baseline: the font's position, or the offset.
                let below = if offset.is_nan() {
                    -font.underline_position()
                } else {
                    offset + thickness / 2.0
                };
                stroke_decoration(
                    cx,
                    &color,
                    style,
                    x,
                    line.origin.y - below,
                    width,
                    thickness,
                );
            }
        }
    }
}

/// One decoration line centered on `y` (y-up), `style` as encoded by the
/// text engine: solid, double, dotted, dashed, wavy.
fn stroke_decoration(
    cx: &CGContext,
    color: &CGColor,
    style: i32,
    x: CGFloat,
    y: CGFloat,
    width: CGFloat,
    thickness: CGFloat,
) {
    let c = Some(cx);
    CGContext::save_g_state(c);
    CGContext::set_stroke_color_with_color(c, Some(color));
    CGContext::set_line_width(c, thickness);
    let line = |y: CGFloat| {
        CGContext::move_to_point(c, x, y);
        CGContext::add_line_to_point(c, x + width, y);
    };
    match style {
        1 => {
            // Two lines a thickness apart.
            line(y + thickness);
            line(y - thickness);
        }
        2 => {
            let pattern = [0.0, thickness * 2.0];
            // SAFETY: a two-element pattern.
            unsafe { CGContext::set_line_dash(c, 0.0, pattern.as_ptr(), 2) };
            CGContext::set_line_cap(c, objc2_core_graphics::CGLineCap::Round);
            line(y);
        }
        3 => {
            let pattern = [thickness * 3.0, thickness * 2.0];
            // SAFETY: a two-element pattern.
            unsafe { CGContext::set_line_dash(c, 0.0, pattern.as_ptr(), 2) };
            line(y);
        }
        4 => {
            // A sine wave, one period per four thicknesses.
            let amplitude = thickness * 1.5;
            let period = (thickness * 4.0).max(4.0);
            let steps = ((width / period) * 8.0).ceil().max(2.0) as usize;
            CGContext::move_to_point(c, x, y);
            for i in 1..=steps {
                let t = width * i as CGFloat / steps as CGFloat;
                let phase = t / period * std::f64::consts::TAU;
                CGContext::add_line_to_point(c, x + t, y + amplitude * phase.sin());
            }
        }
        _ => line(y),
    }
    CGContext::stroke_path(c);
    CGContext::restore_g_state(c);
}

#[derive(Default)]
pub(crate) struct TextViewIvars {
    pub(crate) layout: RefCell<Option<(TextLayout, Bounds<Points>)>>,
    /// The content, for accessibility and the block's shadow.
    pub(crate) text: RefCell<Option<Arc<AttributedText>>>,
    /// `selectable`: the range selection (`text_selection.rs`).
    pub(crate) selection: Selection,
    /// An animated `color` (`0xRRGGBBAA`): the whole text is drawn in it.
    color: std::cell::Cell<Option<u32>>,
    /// A transition of the text's color (`transition-colors`): while it
    /// runs, the whole text is drawn in its color (under an animated one).
    transition: RefCell<TextColor>,
    /// The part a selectable view selected (UTF-16 offsets) and its
    /// highlight (`selectable_view.rs`).
    area_highlight: std::cell::Cell<Option<((usize, usize), nsh_core::Color)>>,
}

define_class!(
    /// Draws a `CTFrame` laid out on the engine thread. No text layout
    /// happens on the main thread.
    #[unsafe(super(NshView, UIView, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = TextViewIvars]
    pub(crate) struct TextView;

    impl TextView {
        #[unsafe(method(isAccessibilityElement))]
        fn is_accessibility_element(&self) -> bool {
            // SAFETY: calling the superclass implementation.
            let explicit: bool = unsafe { msg_send![super(self), isAccessibilityElement] };
            explicit || (!self.hidden_from_accessibility() && self.has_text())
        }

        #[unsafe(method_id(accessibilityLabel))]
        fn accessibility_label(&self) -> Option<Retained<NSString>> {
            // SAFETY: calling the superclass implementation (the explicit label).
            let explicit: Option<Retained<NSString>> = unsafe { msg_send![super(self), accessibilityLabel] };
            explicit.or_else(|| {
                self.ivars().text.borrow().as_ref().map(|t| NSString::from_str(&t.text))
            })
        }

        #[unsafe(method(accessibilityTraits))]
        fn accessibility_traits(&self) -> UIAccessibilityTraits {
            // SAFETY: calling the superclass implementation; an immutable constant.
            let traits: UIAccessibilityTraits = unsafe { msg_send![super(self), accessibilityTraits] };
            traits | unsafe { UIAccessibilityTraitStaticText }
        }

        #[unsafe(method(canBecomeFirstResponder))]
        fn can_become_first_responder(&self) -> bool {
            self.selectable()
        }

        #[unsafe(method(didMoveToWindow))]
        fn did_move_to_window(&self) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), didMoveToWindow] };
            // Into or out of a selectable view, which selects instead.
            self.update_own_selection();
        }

        #[unsafe(method(canPerformAction:withSender:))]
        fn can_perform_action(&self, action: Sel, sender: Option<&AnyObject>) -> bool {
            // (No early returns: the method's result is converted to BOOL.)
            let editing = [
                sel!(cut:),
                sel!(paste:),
                sel!(delete:),
                sel!(toggleBoldface:),
                sel!(toggleItalics:),
                sel!(toggleUnderline:),
            ];
            if !self.selectable() || editing.contains(&action) {
                // Nothing edits the text.
                false
            } else if action == sel!(copy:) {
                self.has_selection()
            } else if action == sel!(selectAll:) {
                !self.all_selected() && self.text_length() > 0
            } else {
                // The system's own (Look Up, Translate, Share) where it offers them.
                // SAFETY: calling the superclass implementation.
                let can: bool =
                    unsafe { msg_send![super(self), canPerformAction: action, withSender: sender] };
                can
            }
        }

        #[unsafe(method(copy:))]
        fn copy(&self, _sender: Option<&AnyObject>) {
            if let Some(text) = self.selected_string() {
                crate::system::set_clipboard(&text);
            }
        }

        #[unsafe(method(selectAll:))]
        fn select_all(&self, _sender: Option<&AnyObject>) {
            let len = self.text_length();
            if len > 0 {
                self.change_selection(Some((0, len)));
            }
        }

        #[unsafe(method(resignFirstResponder))]
        fn resign_first_responder(&self) -> bool {
            // SAFETY: calling the superclass implementation.
            let resigned: bool = unsafe { msg_send![super(self), resignFirstResponder] };
            if resigned {
                self.end_selection();
            }
            resigned
        }

        #[unsafe(method_id(inputView))]
        fn input_view(&self) -> Option<Retained<UIView>> {
            Some(self.sel_input_view())
        }

        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty: CGRect) {
            let layout = self.ivars().layout.borrow();
            let Some((layout, content)) = layout.as_ref() else { return };
            let Some(text) = layout.downcast::<CoreTextLayout>() else { return };
            let Some(cx) = UIGraphicsGetCurrentContext() else { return };
            let c = Some(&*cx);
            CGContext::save_g_state(c);
            if let Some(t) = self.ivars().text.borrow().as_ref().filter(|t| t.has_backgrounds()) {
                crate::text::draw_backgrounds(&cx, t, text, *content);
            }
            if let Some(((a, b), color)) = self.ivars().area_highlight.get() {
                CGContext::set_fill_color_with_color(c, crate::decor::cg_color(color).as_deref());
                for (rect, ..) in self.range_rects(a, b) {
                    CGContext::fill_rect(c, rect);
                }
            }
            // CoreText draws in a y-up space with the origin at the bottom of
            // the box.
            CGContext::set_text_matrix(c, CGAffineTransform { a: 1.0, b: 0.0, c: 0.0, d: 1.0, tx: 0.0, ty: 0.0 });
            CGContext::translate_ctm(c, content.origin.x.0 as CGFloat, (content.origin.y.0 + content.size.height.0) as CGFloat);
            CGContext::scale_ctm(c, 1.0, -1.0);
            if let Some(shadow) = self.ivars().text.borrow().as_ref().and_then(|t| t.shadow) {
                let (r, g, b, a) = shadow.color.to_f64();
                let color = UIColor::colorWithRed_green_blue_alpha(r, g, b, a);
                // The context is flipped: a positive offset must still go down.
                CGContext::set_shadow_with_color(
                    c,
                    CGSize::new(shadow.offset_x.0 as CGFloat, -shadow.offset_y.0 as CGFloat),
                    shadow.radius.0 as CGFloat,
                    // SAFETY: a plain getter.
                    Some(&*unsafe { color.CGColor() }),
                );
            }
            // An animated color, or a transition of the text's color: the
            // text (decorations too) drawn as is into a layer, then painted
            // over in the color where it drew, so its antialiasing stays;
            // the layer casts the shadow.
            let color = self
                .ivars()
                .color
                .get()
                .or_else(|| Some(self.ivars().transition.borrow().value()?.0));
            if color.is_some() {
                // SAFETY: no auxiliary info.
                unsafe { CGContext::begin_transparency_layer(c, None) };
            }
            for line in &text.lines {
                CGContext::set_text_position(c, line.origin.x, line.origin.y);
                // SAFETY: a valid line and context.
                unsafe { line.line.draw(&cx) };
                if text.strikethrough {
                    draw_decorations(&cx, line);
                }
            }
            if let Some(color) = color {
                CGContext::set_blend_mode(c, objc2_core_graphics::CGBlendMode::SourceIn);
                CGContext::set_fill_color_with_color(
                    c,
                    crate::decor::cg_color(nsh_core::Color(color)).as_deref(),
                );
                // Wherever the text drew (glyphs may reach past the box);
                // the clip bounds the rest.
                CGContext::fill_rect(c, CGContext::clip_bounding_box(c));
                CGContext::end_transparency_layer(c);
            }
            CGContext::restore_g_state(c);
        }
    }

    unsafe impl NSObjectProtocol for TextView {}

    unsafe impl UITextInputTraits for TextView {}

    // Not editable: the input methods do nothing.
    unsafe impl UIKeyInput for TextView {
        #[unsafe(method(hasText))]
        fn key_has_text(&self) -> bool {
            self.has_text()
        }

        #[unsafe(method(insertText:))]
        fn insert_text(&self, _text: &NSString) {}

        #[unsafe(method(deleteBackward))]
        fn delete_backward(&self) {}
    }

    unsafe impl UITextInput for TextView {
        #[unsafe(method_id(textInRange:))]
        fn text_in_range(&self, range: &UITextRange) -> Option<Retained<NSString>> {
            self.sel_text_in(range)
        }

        #[unsafe(method(replaceRange:withText:))]
        fn replace_range(&self, _range: &UITextRange, _text: &NSString) {}

        #[unsafe(method_id(selectedTextRange))]
        fn selected_text_range(&self) -> Option<Retained<UITextRange>> {
            self.sel_selected_range()
        }

        #[unsafe(method(setSelectedTextRange:))]
        fn set_selected_text_range(&self, range: Option<&UITextRange>) {
            self.sel_set_selected_range(range);
        }

        #[unsafe(method_id(markedTextRange))]
        fn marked_text_range(&self) -> Option<Retained<UITextRange>> {
            None
        }

        #[unsafe(method_id(markedTextStyle))]
        fn marked_text_style(&self) -> Option<Retained<NSDictionary<NSAttributedStringKey, AnyObject>>> {
            None
        }

        #[unsafe(method(setMarkedTextStyle:))]
        fn set_marked_text_style(&self, _style: Option<&NSDictionary<NSAttributedStringKey, AnyObject>>) {}

        #[unsafe(method(setMarkedText:selectedRange:))]
        fn set_marked_text(&self, _text: Option<&NSString>, _range: NSRange) {}

        #[unsafe(method(unmarkText))]
        fn unmark_text(&self) {}

        #[unsafe(method_id(beginningOfDocument))]
        fn beginning_of_document(&self) -> Retained<UITextPosition> {
            self.sel_position(0)
        }

        #[unsafe(method_id(endOfDocument))]
        fn end_of_document(&self) -> Retained<UITextPosition> {
            self.sel_position(self.text_length())
        }

        #[unsafe(method_id(textRangeFromPosition:toPosition:))]
        fn text_range(&self, from: &UITextPosition, to: &UITextPosition) -> Option<Retained<UITextRange>> {
            Some(self.sel_range(from, to))
        }

        #[unsafe(method_id(positionFromPosition:offset:))]
        fn position_offset(&self, position: &UITextPosition, offset: NSInteger) -> Option<Retained<UITextPosition>> {
            self.sel_moved(position, offset)
        }

        #[unsafe(method_id(positionFromPosition:inDirection:offset:))]
        fn position_direction(
            &self,
            position: &UITextPosition,
            direction: UITextLayoutDirection,
            offset: NSInteger,
        ) -> Option<Retained<UITextPosition>> {
            self.sel_moved_in(position, direction, offset)
        }

        #[unsafe(method(comparePosition:toPosition:))]
        fn compare_position(&self, position: &UITextPosition, other: &UITextPosition) -> NSComparisonResult {
            match text_selection::offset(position).cmp(&text_selection::offset(other)) {
                std::cmp::Ordering::Less => NSComparisonResult::Ascending,
                std::cmp::Ordering::Equal => NSComparisonResult::Same,
                std::cmp::Ordering::Greater => NSComparisonResult::Descending,
            }
        }

        #[unsafe(method(offsetFromPosition:toPosition:))]
        fn offset_from(&self, from: &UITextPosition, to: &UITextPosition) -> NSInteger {
            text_selection::offset(to) as NSInteger - text_selection::offset(from) as NSInteger
        }

        #[unsafe(method_id(inputDelegate))]
        fn input_delegate(&self) -> Option<Retained<ProtocolObject<dyn UITextInputDelegate>>> {
            self.sel_delegate()
        }

        #[unsafe(method(setInputDelegate:))]
        fn set_input_delegate(&self, delegate: Option<&ProtocolObject<dyn UITextInputDelegate>>) {
            self.sel_set_delegate(delegate);
        }

        #[unsafe(method_id(tokenizer))]
        fn tokenizer(&self) -> Retained<ProtocolObject<dyn UITextInputTokenizer>> {
            self.sel_tokenizer()
        }

        #[unsafe(method_id(positionWithinRange:farthestInDirection:))]
        fn farthest(&self, range: &UITextRange, direction: UITextLayoutDirection) -> Option<Retained<UITextPosition>> {
            Some(self.sel_farthest(range, direction))
        }

        #[unsafe(method_id(characterRangeByExtendingPosition:inDirection:))]
        fn extending(&self, position: &UITextPosition, direction: UITextLayoutDirection) -> Option<Retained<UITextRange>> {
            Some(self.sel_extend(position, direction))
        }

        #[unsafe(method(baseWritingDirectionForPosition:inDirection:))]
        fn writing_direction(&self, _position: &UITextPosition, _direction: UITextStorageDirection) -> NSWritingDirection {
            self.sel_direction()
        }

        #[unsafe(method(setBaseWritingDirection:forRange:))]
        fn set_writing_direction(&self, _direction: NSWritingDirection, _range: &UITextRange) {}

        #[unsafe(method(firstRectForRange:))]
        fn first_rect(&self, range: &UITextRange) -> CGRect {
            self.sel_first_rect(range)
        }

        #[unsafe(method(caretRectForPosition:))]
        fn caret_rect(&self, position: &UITextPosition) -> CGRect {
            self.sel_caret(position)
        }

        #[unsafe(method_id(selectionRectsForRange:))]
        fn selection_rects(&self, range: &UITextRange) -> Retained<NSArray<UITextSelectionRect>> {
            self.sel_rects(range)
        }

        #[unsafe(method_id(closestPositionToPoint:))]
        fn closest(&self, point: CGPoint) -> Option<Retained<UITextPosition>> {
            self.sel_closest(point, None)
        }

        #[unsafe(method_id(closestPositionToPoint:withinRange:))]
        fn closest_within(&self, point: CGPoint, range: &UITextRange) -> Option<Retained<UITextPosition>> {
            self.sel_closest(point, Some(range))
        }

        #[unsafe(method_id(characterRangeAtPoint:))]
        fn character_at(&self, point: CGPoint) -> Option<Retained<UITextRange>> {
            self.sel_character_at(point)
        }

        #[unsafe(method(isEditable))]
        fn is_editable(&self) -> bool {
            false
        }

        #[unsafe(method_id(textInputView))]
        fn text_input_view(&self) -> Retained<UIView> {
            self.retain().into_super().into_super()
        }
    }

);

impl TextView {
    pub(crate) fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(TextViewIvars::default());
        // SAFETY: NshView's `initWithFrame:` initializes its ivars, then UIView.
        let view: Retained<Self> = unsafe {
            msg_send![super(this), initWithFrame: CGRect::new(CGPoint::ZERO, CGSize::ZERO)]
        };
        view.setOpaque(false);
        // Text can arrive before the view's frame (a list cell laid out
        // before it is placed): draw again when the size changes.
        view.setContentMode(objc2_ui_kit::UIViewContentMode::Redraw);
        view
    }

    /// Draws the whole text in `color` (an animated `color`), or in its
    /// own colors.
    pub(crate) fn set_color(&self, color: Option<nsh_core::Color>) {
        let color = color.map(|c| c.0);
        if self.ivars().color.replace(color) != color {
            self.setNeedsDisplay();
        }
    }

    /// The content shown.
    pub(crate) fn text(&self) -> Option<Arc<AttributedText>> {
        self.ivars().text.borrow().clone()
    }

    /// Starts, keeps or stops the transition of the text's color, as
    /// `transition::recolor` found for its new content. True while it
    /// runs: something steps it ([`TextView::step_color`]).
    pub(crate) fn recolor(&self, recolor: Recolor) -> bool {
        let mut transition = self.ivars().transition.borrow_mut();
        let shown = transition.value();
        transition.recolor(recolor);
        if transition.value() != shown {
            self.setNeedsDisplay();
        }
        transition.running()
    }

    /// One frame of the text's color transition at `now` (ms): draws the
    /// text again in its next color, from the lines already laid out.
    /// True while it runs.
    pub(crate) fn step_color(&self, now: f64) -> bool {
        let mut transition = self.ivars().transition.borrow_mut();
        if transition.step(now) {
            self.setNeedsDisplay();
        }
        transition.running()
    }

    pub(crate) fn set_layout(
        &self,
        text: Arc<AttributedText>,
        layout: TextLayout,
        content: Bounds<Points>,
    ) {
        let (selectable, color) = (
            text.is_selectable() && !self.in_selectable_view(),
            text.selection_color,
        );
        let changed = self
            .ivars()
            .text
            .borrow()
            .as_ref()
            .is_none_or(|t| t.text != text.text);
        *self.ivars().layout.borrow_mut() = Some((layout, content));
        *self.ivars().text.borrow_mut() = Some(text);
        if selectable || self.ivars().selection.is_on() {
            self.set_selectable(selectable, color, changed);
        }
        self.setNeedsDisplay();
    }

    fn selectable(&self) -> bool {
        self.ivars()
            .text
            .borrow()
            .as_ref()
            .is_some_and(|t| t.is_selectable())
            && !self.in_selectable_view()
    }

    /// Whether a view above is a selectable view: the area selects this
    /// text with the others, so the text has no selection of its own.
    pub(crate) fn in_selectable_view(&self) -> bool {
        let mut view = self.superview();
        while let Some(v) = view {
            if v.downcast_ref::<NshView>()
                .is_some_and(NshView::is_selectable_view)
            {
                return true;
            }
            view = v.superview();
        }
        false
    }

    /// Turns the text's own selection on or off after it moved into or
    /// out of a selectable view (or one appeared or went above it).
    pub(crate) fn update_own_selection(&self) {
        let Some((selectable, color)) = self
            .ivars()
            .text
            .borrow()
            .as_ref()
            .map(|t| (t.is_selectable(), t.selection_color))
        else {
            return;
        };
        if !selectable && !self.ivars().selection.is_on() {
            return;
        }
        let on = selectable && !self.in_selectable_view();
        if on != self.ivars().selection.is_on() {
            self.set_selectable(on, color, false);
        }
    }

    /// Highlights a UTF-16 range in a color (the text's part of a
    /// selectable view's selection), or nothing.
    pub(crate) fn set_area_highlight(&self, highlight: Option<((usize, usize), nsh_core::Color)>) {
        if self.ivars().area_highlight.replace(highlight) != highlight {
            self.setNeedsDisplay();
        }
    }

    /// The text's content.
    pub(crate) fn attributed(&self) -> Option<Arc<AttributedText>> {
        self.ivars().text.borrow().clone()
    }

    /// Whether the text has pressable spans.
    pub(crate) fn has_links(&self) -> bool {
        self.ivars()
            .text
            .borrow()
            .as_ref()
            .is_some_and(|t| !t.links.is_empty())
    }

    /// Whether a pressable span listens to long presses.
    pub(crate) fn links_long_press(&self) -> bool {
        self.ivars().text.borrow().as_ref().is_some_and(|t| {
            t.links
                .iter()
                .any(|l| l.events.contains(nsh_core::EventKind::LongPress))
        })
    }

    /// The pressable span under `point` (view coordinates).
    pub(crate) fn link_at(&self, point: CGPoint) -> Option<TextLink> {
        let text = self.ivars().text.borrow();
        let text = text.as_ref().filter(|t| !t.links.is_empty())?;
        let layout = self.ivars().layout.borrow();
        let (layout, content) = layout.as_ref()?;
        let layout = layout.downcast::<CoreTextLayout>()?;
        let index = layout.char_at(CGPoint::new(
            point.x - content.origin.x.0 as CGFloat,
            point.y - content.origin.y.0 as CGFloat,
        ))?;
        text.link_at(u32::try_from(index).ok()?).cloned()
    }

    fn has_text(&self) -> bool {
        self.ivars()
            .text
            .borrow()
            .as_ref()
            .is_some_and(|t| !t.text.is_empty())
    }

    fn hidden_from_accessibility(&self) -> bool {
        // SAFETY: a plain getter.
        unsafe { msg_send![self, accessibilityElementsHidden] }
    }
}
