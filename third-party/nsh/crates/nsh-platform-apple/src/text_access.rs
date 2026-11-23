//! How drawn text splits for VoiceOver on macOS and iOS: each pressable inline
//! link is an element of its own, the plain stretches between links read in
//! document order, and inline views keep their own elements between them.

use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Range,
};

use nsh_core::{AttributedText, EventKind, NodeId};

/// Whether `text` has an inline link that takes presses: the spans screen
/// readers reach on their own.
pub fn has_pressable_links(text: &AttributedText) -> bool {
    text.links
        .iter()
        .any(|link| link.events.contains(EventKind::Press))
}

/// Disjoint stretches of `text` in document order, each with the innermost
/// pressable link it is in (the same priority as pointer input), or `None` for
/// plain text. Shown attachments (any width) end a stretch and are left out:
/// their views are elements of their own. Boundaries are UTF-16 offsets, as
/// [`nsh_core::TextLink`], AppKit and UIKit use.
pub fn stretches(text: &AttributedText) -> Vec<(Range<u32>, Option<NodeId>)> {
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

/// A piece of drawn text read as an element of its own: a pressable link
/// (`node`) or a plain stretch between links and inline views.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct SpokenPart {
    /// Its UTF-16 range in the text.
    pub range: Range<u32>,
    /// The link's span, or `None` for plain text.
    pub node: Option<NodeId>,
    /// What it reads: its characters without hidden runs and placeholders.
    pub label: String,
}

/// The parts of `text` a touch screen reader moves through one by one
/// ([`stretches`] with their labels): pieces that read nothing, and plain
/// pieces of only spaces (between a link and an inline view, where swiping
/// would stop on silence), are left out.
pub fn spoken_parts(text: &AttributedText) -> Vec<SpokenPart> {
    stretches(text)
        .into_iter()
        .filter_map(|(range, node)| {
            let label = text.text_without_attachments(range.clone());
            let silent = if node.is_some() {
                label.is_empty()
            } else {
                label.trim().is_empty()
            };
            (!silent).then_some(SpokenPart { range, node, label })
        })
        .collect()
}

/// `parts` (by the offset each starts at) and `inline` views (by the offset
/// of their placeholder, or of the caret next to it) in document order. An
/// inline view comes first on a tie: its caret may be the one after its
/// placeholder, where the next part starts.
pub fn reading_order<T>(parts: Vec<(u32, T)>, inline: Vec<(u32, T)>) -> Vec<T> {
    let mut all: Vec<(u32, bool, T)> = inline
        .into_iter()
        .map(|(at, item)| (at, false, item))
        .chain(parts.into_iter().map(|(at, item)| (at, true, item)))
        .collect();
    all.sort_by_key(|(at, part, _)| (*at, *part));
    all.into_iter().map(|(.., item)| item).collect()
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
            .map(|(range, node)| (text.text_without_attachments(range), node))
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
            .map(|(range, _)| text.text_without_attachments(range))
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
        assert_eq!(text.text_without_attachments(0..7), "before");
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
        assert_eq!(text.text_without_attachments(0..8), "before ");
    }

    #[test]
    fn an_inline_view_splits_the_text_around_its_placeholder() {
        let mut text = AttributedText::default();
        text.push("See ", ResolvedTextStyle::default());
        text.push_attachment(
            nsh_core::Size::new(nsh_core::Points(12.0), nsh_core::Points(12.0)),
            ResolvedTextStyle::default(),
        );
        text.push(" and docs.", ResolvedTextStyle::default());
        text.links = vec![link(10, 14, 2)];
        assert_eq!(
            stretches(&text),
            [
                (0..4, None),
                (5..10, None),
                (10..14, Some(2)),
                (14..15, None)
            ]
        );
    }

    #[test]
    fn blank_plain_parts_between_a_link_and_an_inline_view_are_skipped() {
        let mut text = AttributedText::default();
        text.push("Read docs ", ResolvedTextStyle::default());
        text.push_attachment(
            nsh_core::Size::new(nsh_core::Points(12.0), nsh_core::Points(12.0)),
            ResolvedTextStyle::default(),
        );
        text.push(" now", ResolvedTextStyle::default());
        text.links = vec![link(5, 9, 2)];
        let parts: Vec<_> = spoken_parts(&text)
            .into_iter()
            .map(|p| (p.range, p.node, p.label))
            .collect();
        assert_eq!(
            parts,
            [
                (0..5, None, "Read ".into()),
                (5..9, Some(2), "docs".into()),
                (11..15, None, " now".into()),
            ]
        );
    }

    #[test]
    fn inline_views_read_between_the_parts_around_them() {
        // "See " 0..4, a view at 4, " and docs" 5..14 with a link at 10..14,
        // then a view at 14.
        let parts = vec![(0, "see"), (5, "and"), (10, "docs")];
        // The first view's caret is the one after it (5): still before " and".
        let inline = vec![(15, "end view"), (5, "view")];
        assert_eq!(
            reading_order(parts, inline),
            ["see", "view", "and", "docs", "end view"]
        );
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
        assert!(has_pressable_links(&text));
        text.links.remove(0);
        assert!(!has_pressable_links(&text));
    }
}
