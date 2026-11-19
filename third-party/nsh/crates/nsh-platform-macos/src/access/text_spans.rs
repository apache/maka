//! Drawn text's inline links as native accessibility elements. Plain stretches
//! stay between links in document order; a press targets the span's core node.

use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Range,
    rc::Rc,
    sync::Arc,
};

use nsh_core::{AttributedText, EventKind, NodeId};
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
        && state.text.as_ref().is_some_and(|text| {
            text.text
                .links
                .iter()
                .any(|link| link.events.contains(EventKind::Press))
        })
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
    let before = text.copied_text(label.start..start).encode_utf16().count();
    let selected = text.copied_text(start..end);
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

/// Disjoint stretches, using the same innermost-link priority as pointer input.
/// Boundaries are UTF-16 offsets, as TextLink and AppKit use.
fn stretches(text: &AttributedText) -> Vec<(Range<u32>, Option<NodeId>)> {
    let length = text.text.encode_utf16().count() as u32;
    let mut edges = BTreeMap::<u32, Vec<(usize, bool)>>::new();
    edges.entry(0).or_default();
    edges.entry(length).or_default();
    for (index, link) in text.links.iter().enumerate() {
        if link.events.contains(EventKind::Press) && link.start < link.end && link.end <= length {
            edges.entry(link.start).or_default().push((index, true));
            edges.entry(link.end).or_default().push((index, false));
        }
    }
    let attachments: BTreeSet<_> = text
        .attachments
        .iter()
        .filter(|attachment| attachment.width.0 > 0.0)
        .map(|a| a.index)
        .collect();
    for &at in &attachments {
        edges.entry(at).or_default();
        edges.entry((at + 1).min(length)).or_default();
    }
    let mut active = BTreeSet::new();
    let mut output: Vec<(Range<u32>, Option<NodeId>)> = Vec::new();
    let mut edges = edges.into_iter().peekable();
    while let Some((start, changes)) = edges.next() {
        for (index, added) in changes {
            let link = &text.links[index];
            let priority = (link.end - link.start, index);
            if added {
                active.insert(priority);
            } else {
                active.remove(&priority);
            }
        }
        let Some(&(end, _)) = edges.peek() else {
            break;
        };
        if attachments.contains(&start) && end == start + 1 {
            continue;
        }
        let node = active.first().map(|(_, index)| text.links[*index].node);
        if let Some((range, last)) = output.last_mut()
            && *last == node
            && (range.end == start || node.is_some())
        {
            range.end = end;
        } else {
            output.push((start..end, node));
        }
    }
    output
}

fn snapshot(view: &NshView) -> Option<Rc<Snapshot>> {
    let mut state = view.try_state_mut()?;
    if super::is_pressable(state.events) {
        return None;
    }
    let text = state.text.as_ref()?.text.clone();
    if !text
        .links
        .iter()
        .any(|link| link.events.contains(EventKind::Press))
    {
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
            let shown = text.copied_text(range.clone());
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
    use nsh_core::{EventMask, ResolvedTextStyle, TextLink};

    use super::*;

    fn link(start: u32, end: u32, node: NodeId) -> TextLink {
        let mut events = EventMask::default();
        events.set(EventKind::Press, true);
        TextLink {
            start,
            end,
            node,
            events,
            focus_stop: true,
        }
    }

    #[test]
    fn nested_links_read_once_in_utf16_document_order() {
        let mut text = AttributedText::default();
        text.push("前😀日本語後", ResolvedTextStyle::default());
        text.links = vec![link(1, 6, 2), link(3, 5, 3), link(6, 99, 4), link(2, 2, 5)];
        let pieces: Vec<_> = stretches(&text)
            .into_iter()
            .map(|(range, node)| (text.copied_text(range), node))
            .collect();
        assert_eq!(
            pieces,
            [
                ("前".into(), None),
                ("😀".into(), Some(2)),
                ("日本".into(), Some(3)),
                ("語".into(), Some(2)),
                ("後".into(), None)
            ]
        );
    }

    #[test]
    fn hidden_runs_and_attachment_placeholders_are_omitted_from_names() {
        let mut text = AttributedText::default();
        text.push("Read ", ResolvedTextStyle::default());
        text.push(
            "secret",
            ResolvedTextStyle {
                hidden: true,
                ..Default::default()
            },
        );
        text.push(" guide\u{fffc}", ResolvedTextStyle::default());
        text.links = vec![link(5, 18, 2)];
        let labels: Vec<_> = stretches(&text)
            .into_iter()
            .map(|(range, _)| text.copied_text(range))
            .filter(|s| !s.is_empty())
            .collect();
        assert_eq!(labels, ["Read ", " guide"]);
    }

    #[test]
    fn a_link_stays_one_element_across_an_inline_reveal_anchor() {
        let mut text = AttributedText::default();
        text.push("be", ResolvedTextStyle::default());
        text.push_attachment(
            nsh_core::Size::new(nsh_core::Points::ZERO, nsh_core::Points(1.0)),
            ResolvedTextStyle::default(),
        );
        text.push("fore", ResolvedTextStyle::default());
        text.links = vec![link(0, 7, 2)];
        assert_eq!(stretches(&text), [(0..7, Some(2))]);
        assert_eq!(text.copied_text(0..7), "before");
    }

    #[test]
    fn a_plain_word_stays_whole_across_a_zero_width_anchor() {
        let mut text = AttributedText::default();
        text.push("be", ResolvedTextStyle::default());
        text.push_attachment(
            nsh_core::Size::new(nsh_core::Points::ZERO, nsh_core::Points(1.0)),
            ResolvedTextStyle::default(),
        );
        text.push("fore Guide", ResolvedTextStyle::default());
        text.links = vec![link(8, 13, 2)];
        assert_eq!(stretches(&text), [(0..8, None), (8..13, Some(2))]);
        assert_eq!(text.copied_text(0..8), "before ");
    }

    #[test]
    fn selecting_a_label_skips_the_attachment_and_snaps_surrogates() {
        let mut text = AttributedText::default();
        text.push("before\u{fffc} 😀hello after", ResolvedTextStyle::default());
        assert_eq!(copied_range(&text, 6..15, NSRange::new(1, 2)), 8..10);
    }

    #[test]
    fn hover_only_spans_do_not_hide_an_outer_link() {
        let mut text = AttributedText::default();
        text.push("outer inner", ResolvedTextStyle::default());
        let mut hover = link(6, 11, 3);
        hover.events.set(EventKind::Press, false);
        hover.events.set(EventKind::MouseEnter, true);
        text.links = vec![link(0, 11, 2), hover];
        assert_eq!(stretches(&text), [(0..11, Some(2))]);
    }
}
