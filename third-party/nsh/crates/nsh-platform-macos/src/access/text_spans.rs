//! Drawn text's inline links as native accessibility elements. Plain stretches
//! stay between links in document order; a press targets the span's core node.

use std::{collections::BTreeMap, ops::Range, rc::Rc, sync::Arc};

use nsh_core::{AttributedText, NodeId};
use nsh_platform_apple::text_access::{has_pressable_links, stretches};
use objc2::{
    DefinedClass, MainThreadOnly, define_class, msg_send,
    rc::{Retained, Weak},
    runtime::{AnyObject, Sel},
    sel,
};
use objc2_app_kit::{
    NSAccessibility, NSAccessibilityElement, NSAccessibilityLinkRole,
    NSAccessibilityStaticTextRole, NSView,
};
use objc2_foundation::{NSArray, NSRange, NSRect, NSString};

use crate::view::NshView;

#[derive(Debug)]
struct SpanState {
    view: Weak<NSView>,
    identity: (Option<NodeId>, usize),
}

define_class!(
    #[unsafe(super(NSAccessibilityElement))]
    #[thread_kind = MainThreadOnly]
    #[ivars = SpanState]
    #[name = "NshAccessibilityTextSpan"]
    #[derive(Debug)]
    struct TextSpan;

    impl TextSpan {
        #[unsafe(method_id(accessibilityParent))]
        fn parent(&self) -> Option<Retained<AnyObject>> {
            self.ivars().view.load().and_then(|view| {
                // SAFETY: the owner is an NSView implementing NSAccessibility.
                unsafe { objc2_app_kit::NSAccessibilityUnignoredAncestor(&view) }
            })
        }

        #[unsafe(method_id(accessibilityLabel))]
        fn label(&self) -> Option<Retained<NSString>> {
            self.resolve().and_then(|(_, snapshot, index)|
                self.ivars().identity.0.map(|_| NSString::from_str(&snapshot.spans[index].1)))
        }

        #[unsafe(method_id(accessibilityValue))]
        fn value(&self) -> Option<Retained<AnyObject>> {
            self.resolve().map(|(_, snapshot, index)| NSString::from_str(&snapshot.spans[index].1).into_super().into_super())
        }

        #[unsafe(method(setAccessibilitySelectedTextRange:))]
        fn select_range(&self, selected: NSRange) {
            let Some((view, snapshot, index)) = self.resolve() else { return; };
            select(&view, snapshot.spans[index].0.clone(), selected);
        }

        #[unsafe(method(accessibilitySelectedTextRange))]
        fn selected_range(&self) -> NSRange {
            self.resolve().and_then(|(view, snapshot, index)| selection(&view, snapshot.spans[index].0.clone()))
                .map_or(NSRange::new(objc2_foundation::NSNotFound as usize, 0), |(range, _)| range)
        }

        #[unsafe(method_id(accessibilitySelectedText))]
        fn selected_text(&self) -> Option<Retained<NSString>> {
            self.resolve().and_then(|(view, snapshot, index)| selection(&view, snapshot.spans[index].0.clone()))
                .map(|(_, text)| NSString::from_str(&text))
        }

        #[unsafe(method(isAccessibilityEnabled))]
        fn enabled(&self) -> bool {
            if self.ivars().identity.0.is_some() { self.press_events().is_some() } else { self.resolve().is_some() }
        }

        #[unsafe(method(accessibilityFrame))]
        fn frame(&self) -> NSRect {
            let Some((view, snapshot, index)) = self.resolve() else { return NSRect::ZERO; };
            let range = &snapshot.spans[index].0;
            let rects = crate::text::range_rects(&view.state(), range.start, range.end);
            let Some(first) = rects.first() else { return NSRect::ZERO; };
            let (mut left, mut top) = (first.origin.x, first.origin.y);
            let (mut right, mut bottom) = (left + first.size.width, top + first.size.height);
            for rect in &rects[1..] {
                left = left.min(rect.origin.x); top = top.min(rect.origin.y);
                right = right.max(rect.origin.x + rect.size.width);
                bottom = bottom.max(rect.origin.y + rect.size.height);
            }
            let rect = NSRect::new(objc2_foundation::NSPoint::new(left, top), objc2_foundation::NSSize::new(right-left, bottom-top));
            super::frame_of(view.ns(), rect).unwrap_or(NSRect::ZERO)
        }

        #[unsafe(method(accessibilityPerformPress))]
        fn press(&self) -> bool {
            self.ivars().identity.0.zip(self.resolve()).is_some_and(|(node, (view, _, _))|
                view.surface().is_some_and(|surface| crate::input::accessibility_span_press(&surface, &view, node)))
        }

        #[unsafe(method(isAccessibilitySelectorAllowed:))]
        fn allowed(&self, selector: Sel) -> bool {
            if selector == sel!(accessibilityPerformPress) {
                self.press_events().is_some()
            } else if selection_selector(selector) {
                self.resolve().is_some_and(|(view, _, _)| selectable(&view))
            } else {
                // SAFETY: NSAccessibilityElement's own answer.
                unsafe { msg_send![super(self), isAccessibilitySelectorAllowed: selector] }
            }
        }
    }
);

impl TextSpan {
    // Resolve by the logical span, so a retained AX element survives streaming,
    // syntax recoloring and relayout without holding its native view alive.
    fn resolve(&self) -> Option<(NshView, Rc<Snapshot>, usize)> {
        let native = self.ivars().view.load()?;
        let view = NshView::from_ns(&native)?;
        let snapshot = snapshot(&view)?;
        let index = *snapshot.identities.get(&self.ivars().identity)?;
        Some((view, snapshot, index))
    }

    fn press_events(&self) -> Option<nsh_core::EventMask> {
        let node = self.ivars().identity.0?;
        let (view, _, _) = self.resolve()?;
        let surface = view.surface()?;
        crate::input::accessibility_span_events(&surface, &view, node)
    }
}

/// Lazily built once per attributed text, shared by AX getters. The native
/// elements hold weak owners and logical identities, never this snapshot.
#[derive(Debug)]
pub(crate) struct Snapshot {
    text: Arc<AttributedText>,
    separate_text: bool,
    spans: Vec<(Range<u32>, String)>,
    identities: BTreeMap<(Option<NodeId>, usize), usize>,
    elements: Retained<NSArray>,
}

fn selection_selector(selector: Sel) -> bool {
    selector == sel!(setAccessibilitySelectedTextRange:)
        || selector == sel!(accessibilitySelectedTextRange)
        || selector == sel!(accessibilitySelectedText)
}

fn selectable(view: &NshView) -> bool {
    view.try_state().is_some_and(|state| state.text.is_some())
        && crate::selectable_view::target(view).is_some()
}

pub(crate) fn allows_selection(view: &NshView, selector: Sel) -> Option<bool> {
    selection_selector(selector).then(|| {
        let drawn_value = view.try_state().is_some_and(|state| {
            let a = &state.props.accessibility;
            a.label.is_none() && a.value.is_none() && a.description.is_none()
        });
        drawn_value && selectable(view)
    })
}

/// Unlabelled body text is read as interleaved stretches. Semantic headings
/// and app-labelled text keep their own name and expose only their links.
pub(crate) fn separate_text(state: &crate::view::ViewState) -> bool {
    let a = &state.props.accessibility;
    a.role == nsh_core::AccessibilityRole::None
        && a.label.is_none()
        && a.value.is_none()
        && a.hint.is_none()
        && a.description.is_none()
        && !super::is_pressable(state.events)
        && state
            .text
            .as_ref()
            .is_some_and(|text| has_pressable_links(&text.text))
}

/// An AX range is in the displayed value, whose hidden runs and attachments
/// are omitted. The enclosing area owns selection; root keyboard focus lets
/// Copy act on it, as after a pointer selection.
pub(crate) fn select(view: &NshView, label: Range<u32>, selected: NSRange) {
    let Some(surface) = view.surface() else {
        return;
    };
    if !view.can_target()
        || !view
            .ns()
            .isDescendantOf(&crate::navigation::focus_scope(&surface))
    {
        return;
    }
    let text = view
        .try_state()
        .and_then(|s| s.text.as_ref().map(|t| t.text.clone()));
    let Some(text) = text else {
        return;
    };
    let range = copied_range(&text, label, selected);
    if crate::selectable_view::select_range(&surface, view, range)
        && let Some(window) = view.ns().window()
    {
        let root = crate::input::root_in(&surface, &window);
        if crate::text_input::editing_in(&root) {
            window.makeFirstResponder(None);
        }
        window.makeFirstResponder(Some(root.ns()));
    }
}

pub(crate) fn selection(view: &NshView, label: Range<u32>) -> Option<(NSRange, String)> {
    let selected = crate::text::selected_range(view)?;
    let start = selected.start.max(label.start);
    let end = selected.end.min(label.end);
    if start >= end {
        return None;
    }
    let state = view.try_state()?;
    let text = &state.text.as_ref()?.text;
    let before = text
        .text_without_attachments(label.start..start)
        .encode_utf16()
        .count();
    let selected = text.text_without_attachments(start..end);
    Some((
        NSRange::new(before, selected.encode_utf16().count()),
        selected,
    ))
}

/// Map AX's offsets in the displayed label back into its attributed text.
fn copied_range(text: &AttributedText, range: Range<u32>, selected: NSRange) -> Range<u32> {
    let end = selected.location.saturating_add(selected.length);
    let (mut raw, mut shown) = (0u32, 0usize);
    let (mut start, mut finish) = (range.end, range.end);
    for character in text.text.chars() {
        let at = raw;
        raw += character.len_utf16() as u32;
        if at < range.start {
            continue;
        }
        if at >= range.end {
            break;
        }
        if character == nsh_core::ATTACHMENT_CHAR
            || text.span_at(at).is_some_and(|s| s.style.hidden)
        {
            continue;
        }
        if shown <= selected.location {
            start = at;
        }
        if shown <= end {
            finish = at;
        }
        shown += character.len_utf16();
        if shown <= selected.location {
            start = raw;
        }
        if shown <= end {
            finish = raw;
        }
    }
    start..finish.max(start)
}

fn snapshot(view: &NshView) -> Option<Rc<Snapshot>> {
    let mut state = view.try_state_mut()?;
    if super::is_pressable(state.events) {
        return None;
    }
    let text = state.text.as_ref()?.text.clone();
    if !has_pressable_links(&text) {
        return None;
    }
    let separate_text = separate_text(&state);
    if let Some(snapshot) = &state.access.text_spans
        && Arc::ptr_eq(&text, &snapshot.text)
        && snapshot.separate_text == separate_text
    {
        return Some(snapshot.clone());
    }
    let mut spans = Vec::new();
    let mut identities = BTreeMap::new();
    let mut ordinals = BTreeMap::<Option<NodeId>, usize>::new();
    let elements: Vec<Retained<AnyObject>> = stretches(&text)
        .into_iter()
        .filter_map(|(range, node)| {
            if node.is_none() && !separate_text {
                return None;
            }
            let shown = text.text_without_attachments(range.clone());
            if shown.is_empty() {
                return None;
            }
            let ordinal = ordinals.entry(node).or_default();
            let identity = (node, *ordinal);
            *ordinal += 1;
            identities.insert(identity, spans.len());
            spans.push((range, shown));
            let element = TextSpan::alloc(view.ns().mtm()).set_ivars(SpanState {
                view: Weak::new(view.ns()),
                identity,
            });
            // SAFETY: initializing the NSAccessibilityElement superclass.
            let element: Retained<TextSpan> = unsafe { msg_send![super(element), init] };
            element.setAccessibilityElement(true);
            // SAFETY: immutable AppKit role constants.
            unsafe {
                element.setAccessibilityRole(Some(if node.is_some() {
                    NSAccessibilityLinkRole
                } else {
                    NSAccessibilityStaticTextRole
                }));
            }
            Some(element.into_super().into_super().into_super())
        })
        .collect();
    let snapshot = Rc::new(Snapshot {
        text,
        separate_text,
        spans,
        identities,
        elements: NSArray::from_retained_slice(&elements),
    });
    state.access.text_spans = Some(snapshot.clone());
    Some(snapshot)
}

pub(crate) fn children(
    view: &NshView,
    native: Option<Retained<NSArray>>,
) -> Option<Retained<NSArray>> {
    let Some(snapshot) = snapshot(view) else {
        return native;
    };
    let mut ordered: Vec<_> = snapshot
        .elements
        .iter()
        .enumerate()
        .map(|(index, element)| (snapshot.spans[index].0.start, element))
        .collect();
    // Inline images and hosted controls keep their own native AX elements.
    // Their direct child's location identifies their placeholder in the text.
    let container = view.container();
    for element in native.iter().flat_map(|array| array.iter()) {
        let at = element
            .downcast_ref::<NSView>()
            .and_then(|child| super::child_origin(&container, child))
            .map(|origin| crate::text::caret_at(&view.state(), origin.x.0, origin.y.0))
            .unwrap_or(u32::MAX);
        ordered.push((at, element));
    }
    ordered.sort_by_key(|(at, _)| *at);
    let elements: Vec<_> = ordered.into_iter().map(|(_, element)| element).collect();
    Some(NSArray::from_retained_slice(&elements))
}

pub(crate) fn is_static(element: &AnyObject) -> bool {
    element
        .downcast_ref::<TextSpan>()
        .is_some_and(|span| span.ivars().identity.0.is_none())
}

/// The real view containing an inline AX element, for list reading order.
pub(crate) fn owner(element: &AnyObject) -> Option<Retained<NSView>> {
    element.downcast_ref::<TextSpan>()?.ivars().view.load()
}

#[cfg(test)]
mod tests {
    use nsh_core::ResolvedTextStyle;

    use super::*;

    #[test]
    fn selecting_a_label_skips_the_attachment_and_snaps_surrogates() {
        let mut text = AttributedText::default();
        text.push("before\u{fffc} 😀hello after", ResolvedTextStyle::default());
        assert_eq!(copied_range(&text, 6..15, NSRange::new(1, 2)), 8..10);
    }
}
