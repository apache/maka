//! The view's elements: a scroll view of the content box, which holds,
//! from back to front, the selection's boxes, the blocks, the placeholder,
//! the caret and the composition; and the sink, the invisible native input
//! that takes keys, text and input methods, at the caret.
//!
//! Each block is a view keyed by its id ([`super::controller::Tree`]), so
//! a change renders again only the blocks it changed: a container's
//! children in a view of their own, a textblock's content as a text whose
//! spans are its texts with their marks' parts (atoms and widgets are
//! attachments in it), a node view's element where the app renders nodes
//! of a type itself.

use std::{cell::Cell, rc::Rc, sync::Arc};

use nsh_core::{
    PropertyValue, StyleDecl, StyleKey,
    element::{EventKind, EventPayload, Style},
    prelude::*,
};
use serde_json::Value;

use super::{
    controller::{BlockItem, Rv, slot_id},
    geometry::{DOC, InlineMap, Run},
    node_view::{MarkView, NodeView, NodeViewCx},
    parts::{self, Part},
    table,
};
use crate::{
    input,
    rich_editor::{
        model::{Mark, Node, utf16_len},
        state::{Decoration, DecorationKind},
        tables::{CellSelection, TableRole, table_role},
    },
    theme,
};

/// The caret's width.
const CARET_WIDTH: f32 = 1.5;
/// The height of the sink, the native input that takes typed text.
const SINK_HEIGHT: f32 = 16.0;

/// The gap cursor's width (prosemirror-gapcursor's).
const GAP_WIDTH: f32 = 20.0;

/// `el` with part `part`'s classes and style.
pub(crate) fn part<E: Element>(el: E, rv: &Rv, part: Part) -> E {
    let props = rv.props;
    el.app_class(move || props.classes.with(|c| c.part(part).cloned()))
        .inline_style(move || {
            props
                .styles
                .with(|s| s.part(part).cloned().unwrap_or_default())
        })
}

/// A box of the content, absolutely placed.
fn rect(b: Bounds<Points>) -> View {
    view()
        .absolute()
        .left(Length::from(b.origin.x))
        .top(Length::from(b.origin.y))
        .w(Length::from(b.size.width))
        .h(Length::from(b.size.height))
        .pointer_events(PointerEvents::None)
}

/// The editor.
pub(crate) fn render(rv: Rv) -> impl IntoElement {
    let (scroll_rv, layout_rv) = (rv.clone(), rv.clone());
    let root = part(
        view()
            .relative()
            .overflow_hidden()
            .text_color(move || theme().foreground),
        &rv,
        Part::Root,
    );
    root.child(
        scroll()
            .element_ref(&rv.scroll)
            .flex_1()
            .on_scroll(move |e: &ScrollEvent| {
                scroll_rv.scroll_y.set(e.offset.y);
                scroll_rv.scrolled.set(e.offset.y);
                scroll_rv.viewport.set(e.size);
            })
            .on_layout(move |b: &Bounds<Points>| layout_rv.viewport.set(b.size))
            .child(content(rv.clone())),
    )
    .child(sink(rv))
}

/// The content box: what presses and drags select in.
fn content(rv: Rv) -> impl IntoElement {
    let desktop = is_desktop();
    let (down, tap, mov, up, end) = (rv.clone(), rv.clone(), rv.clone(), rv.clone(), rv.clone());
    let over = rv.clone();
    let placed = rv.clone();
    let height = rv.content_height;
    part(
        view()
            .element_ref(&rv.content)
            .on_layout(move |b: &Bounds<Points>| {
                height.set(b.size.height);
                placed.place();
            })
            .relative()
            .cursor(Cursor::Text),
        &rv,
        Part::Content,
    )
    .on(EventKind::PressDown, move |p: &EventPayload| {
        if let (true, EventPayload::Press(e)) = (desktop, p) {
            down.press(e.position, e.page_position, e.modifiers, e.clicks.max(1));
        }
    })
    // Where the pointer is, for drags the app starts from a page point.
    .on(EventKind::MouseMove, move |p: &EventPayload| {
        if let EventPayload::Mouse(e) = p {
            over.note_pointer(e.position, e.page_position);
        }
    })
    .on(EventKind::Press, move |p: &EventPayload| {
        if desktop {
            return;
        }
        if let EventPayload::Press(e) = p {
            tap.press(e.position, e.page_position, e.modifiers, e.clicks.max(1));
        }
    })
    // The mouse selects as it drags (a finger scrolls).
    .claim_touches(TouchClaim::on_start().ask(move |request: &ClaimRequest| {
        if desktop {
            request.claim();
        }
    }))
    .keep_touches(desktop)
    .on_responder_move(move |e: &ResponderEvent| mov.drag_to(e.page))
    .on_responder_release(move |_: &ResponderEvent| up.release())
    .on_responder_terminate(move |_: &ResponderEvent| end.release())
    .child(selection_rects(rv.clone()))
    .child(blocks(rv.clone(), DOC))
    .child(table::controls(rv.clone()))
    .child(gap_cursor(rv.clone()))
    .child(drop_cursor(rv.clone()))
    .child(caret(rv.clone()))
    .children(bubble_menu(rv))
}

/// The app's bubble menu: an overlay against an empty box over the
/// selection, which scrolls with the text, so the menu follows it.
fn bubble_menu(rv: Rv) -> [AnyElement; 2] {
    let anchor = element_ref();
    let props = rv.props;
    let place = move || {
        rv.sel_rev.get();
        rv.layout_rev.get();
        rv.doc_rev.get();
        let b = rv.selection_box().unwrap_or_default();
        let at = |key: StyleKey, value: Points| {
            let value = key.number_value(value.0);
            (key, value.unwrap_or(PropertyValue::Default))
        };
        Style::from_decls(
            [
                at(StyleKey::Left, b.origin.x),
                at(StyleKey::Top, b.origin.y),
                at(StyleKey::Width, b.size.width),
                at(StyleKey::Height, b.size.height),
            ]
            .map(|(key, value)| StyleDecl::Set(key, value)),
        )
    };
    let box_ = view()
        .element_ref(&anchor)
        .absolute()
        .pointer_events(PointerEvents::None)
        .inline_style(place);
    let menu = when(
        move || props.bubble_menu.get().is_some(),
        move || {
            overlay()
                .anchor_content(&anchor)
                .placement(props.bubble_menu_placement)
                .align(Align::Center)
                .offset(props.bubble_menu_offset)
                .child(props.bubble_menu.place(|slot| slot))
        },
    );
    [box_.into_element(), menu.into_element()]
}

/// The blocks of container `parent`, by id.
fn blocks(rv: Rv, parent: u64) -> AnyElement {
    let list_rv = rv.clone();
    let list = computed(move || {
        list_rv.doc_rev.get();
        list_rv
            .tree
            .borrow()
            .children
            .get(&parent)
            .cloned()
            .unwrap_or_default()
    });
    each(
        list,
        |b: &BlockItem| b.id,
        move |item, _| block(rv.clone(), item),
    )
}

/// What the block's view is.
enum Kind {
    View(Arc<dyn NodeView>),
    Text,
    Image,
    Atom,
    Container,
}

/// A block: its node's part, and its content.
fn block(rv: Rv, item: ReadSignal<BlockItem>) -> AnyElement {
    let first = item.get_untracked();
    let (id, parent) = (first.id, first.parent);
    let kind = match rv.node_view(first.node.ty().name()) {
        Some(v) => Kind::View(v),
        None if first.node.is_textblock() => Kind::Text,
        None if (first.node.is_leaf() || first.node.is_atom())
            && render_kind(&first.node) == Some("image") =>
        {
            Kind::Image
        }
        None if first.node.is_leaf() || first.node.is_atom() => Kind::Atom,
        None => Kind::Container,
    };
    let props = rv.props;
    let (class_rv, style_rv, layout_rv) = (rv.clone(), rv.clone(), rv.clone());
    let wrapper = view()
        .on_layout(move |b: &Bounds<Points>| layout_rv.set_frame(id, Some(parent), *b))
        .app_class(move || {
            let it = item.get();
            class_rv.deco_rev.get();
            let selected = node_selected(&class_rv, &it);
            let focused = node_focused(&class_rv, &it);
            let decorations = node_decoration_classes(&class_rv, &it);
            props.classes.with(|c| {
                let mut list = parts::node_classes(c, &it.node);
                list.extend(decorations);
                if selected && let Some(s) = c.part(Part::SelectedNode) {
                    list.push(s.to_string());
                }
                if focused && let Some(s) = c.part(Part::FocusedNode) {
                    list.push(s.to_string());
                }
                parts::join(list)
            })
        })
        .inline_style(move || {
            let it = item.get();
            let selected = node_selected(&style_rv, &it);
            let focused = node_focused(&style_rv, &it);
            props.styles.with(|s| {
                let mut list = parts::node_styles(s, &it.node);
                if selected && let Some(style) = s.part(Part::SelectedNode) {
                    list.push(style.clone());
                }
                if focused && let Some(style) = s.part(Part::FocusedNode) {
                    list.push(style.clone());
                }
                parts::merge(&list)
            })
        });
    // A list's item carries its marker, placed in the indent before it.
    let wrapper = match list_marker(&rv, &first) {
        Some(_) => wrapper.relative().child(marker(rv.clone(), item)),
        None => wrapper,
    };
    // Tables are grids of their cells (`table.rs`).
    let wrapper = match (table_role(first.node.ty()), &kind) {
        (_, Kind::View(_)) => wrapper,
        (Some(TableRole::Table), _) => table::grid(wrapper, &rv, item),
        (Some(TableRole::Cell | TableRole::HeaderCell), _) => table::cell(wrapper, &rv, item),
        _ => wrapper,
    };
    let task = render_kind(&first.node) == Some("task");
    let content = match kind {
        Kind::View(view) => Some(node_view_block(rv.clone(), item, view).into_element()),
        Kind::Text => Some(text_block(rv.clone(), item, id).into_element()),
        Kind::Image => Some(dynamic(move || image_of(&item.get().node)).into_element()),
        Kind::Atom => None,
        Kind::Container => Some(blocks(rv.clone(), id).into_element()),
    };
    // A task item is a row: its checkbox, then its content (Tiptap's
    // `<label><input></label><div>`), so the checkbox is inside the item
    // and takes presses.
    if task {
        return wrapper
            .flex_row()
            .child(task_checkbox(rv, item))
            .child(view().flex_1().min_w(px(0.0)).children(content))
            .into_element();
    }
    wrapper.children(content).into_element()
}

/// How the view renders a node without a node view: its spec's
/// `extra.render` (`"image"`: an `Image` of its `src`; `"task"`: a task
/// item with a checkbox of its `checked`).
fn render_kind(node: &Node) -> Option<&str> {
    node.ty().spec().extra.get("render")?.as_str()
}

/// An image node's `Image`: its `src`, `alt` (what screen readers say)
/// and, when set, its `width` and `height` in points.
fn image_of(node: &Node) -> AnyElement {
    let attrs = node.attrs();
    let src = attrs.get("src").and_then(Value::as_str).unwrap_or_default();
    let mut el = image(src.to_owned());
    if let Some(alt) = attrs.get("alt").and_then(Value::as_str) {
        el = el.label(alt.to_owned());
    }
    let number = |key: &str| {
        attrs.get(key).and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
    };
    if let Some(w) = number("width") {
        el = el.w(px(w as f32));
    }
    if let Some(h) = number("height") {
        el = el.h(px(h as f32));
    }
    el.into_element()
}

/// A task item's checkbox, before the item's content: unstyled
/// (`taskCheckbox` part); a press sets the item's `checked` (an
/// `AttrStep`), disabled while the document cannot be edited.
fn task_checkbox(rv: Rv, item: ReadSignal<BlockItem>) -> impl IntoElement {
    let props = rv.props;
    let checked = move || {
        item.get()
            .node
            .attrs()
            .get("checked")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    let press_rv = rv.clone();
    // The part is the checkbox's box; the checkbox fills it. The box
    // follows the item's state, so the app's `checked:` classes show it.
    view()
        .project_checked(checked)
        .app_class(move || props.classes.with(|c| c.part(Part::TaskCheckbox).cloned()))
        .inline_style(move || {
            props
                .styles
                .with(|s| s.part(Part::TaskCheckbox).cloned().unwrap_or_default())
        })
        .child(
            crate::checkbox()
                .checked(checked)
                .disabled(move || !props.editable.get())
                .on_change(move |next: &bool| press_rv.set_checked(item.get_untracked().pos, *next))
                .size_full(),
        )
}

/// Whether the block takes the `focusedNode` part: the editor has the
/// focus and the selection is in the block, as `focusMode` picks
/// (Tiptap's focus extension).
fn node_focused(rv: &Rv, it: &BlockItem) -> bool {
    if !rv.focused.get() || !rv.props.editable.get() {
        return false;
    }
    rv.sel_rev.get();
    let mode = rv.props.focus_mode.get();
    let state = rv.st.borrow();
    let sel = state.selection();
    let (from, to) = (sel.from(), sel.to());
    let end = it.pos + it.node.node_size();
    let inside = if from == to {
        it.pos < from && end > from
    } else {
        it.pos < to && end > from
    };
    if !inside {
        return false;
    }
    let depth = |pos: usize| state.doc().resolve(pos).map(|r| r.depth).unwrap_or(0);
    match mode.as_deref() {
        Some("shallowest") => depth(it.pos) == 0,
        Some("deepest") => depth(it.pos) + 1 == depth(from).max(1),
        _ => true,
    }
}

/// What marks the children of a node whose spec's `extra.listMarker` is
/// `"bullet"` or `"ordered"`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ListMarker {
    Bullet,
    Ordered,
}

/// The marker kind of `it`'s parent, if it marks its children.
fn list_marker(rv: &Rv, it: &BlockItem) -> Option<ListMarker> {
    let state = rv.st.borrow();
    let at = state.doc().resolve(it.pos).ok()?;
    marker_kind(at.parent())
}

fn marker_kind(node: &Node) -> Option<ListMarker> {
    match node.ty().spec().extra.get("listMarker")?.as_str()? {
        "bullet" => Some(ListMarker::Bullet),
        "ordered" => Some(ListMarker::Ordered),
        _ => None,
    }
}

/// The text of `it`'s marker: a bullet by its depth among bulleted lists
/// (disc, circle, square, around again deeper), or its number from
/// the list's start (`extra.listMarkerStart` names that attribute,
/// `order` by default; 1., a., i. by depth).
fn marker_text(rv: &Rv, it: &BlockItem) -> Option<String> {
    let state = rv.st.borrow();
    let at = state.doc().resolve(it.pos).ok()?;
    let list = at.parent();
    match marker_kind(list)? {
        ListMarker::Ordered => {
            let attr = list
                .ty()
                .spec()
                .extra
                .get("listMarkerStart")
                .and_then(Value::as_str)
                .unwrap_or("start");
            let start = list.attrs().get(attr).and_then(Value::as_i64).unwrap_or(1);
            let n = start + at.index(at.depth) as i64;
            // Nested numbered lists count 1., a., i. in turn, as Google Docs
            // and Notion do, so each level reads apart.
            let depth = (0..at.depth)
                .filter(|&d| marker_kind(at.node(d)) == Some(ListMarker::Ordered))
                .count();
            let label = match (depth % 3, n) {
                (1, 1..) => alpha(n as u64),
                (2, 1..) => roman(n as u64),
                _ => n.to_string(),
            };
            Some(format!("{label}."))
        }
        ListMarker::Bullet => {
            let depth = (0..at.depth)
                .filter(|&d| marker_kind(at.node(d)) == Some(ListMarker::Bullet))
                .count();
            // Disc, circle, square, and around again deeper down.
            Some(["•", "◦", "▪"][depth % 3].to_owned())
        }
    }
}

/// `n` in lower-case letters: a … z, aa, ab, ….
fn alpha(mut n: u64) -> String {
    let mut out = Vec::new();
    while n > 0 {
        n -= 1;
        out.push(b'a' + (n % 26) as u8);
        n /= 26;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// `n` in lower-case Roman numerals.
fn roman(mut n: u64) -> String {
    const DIGITS: [(u64, &str); 13] = [
        (1000, "m"),
        (900, "cm"),
        (500, "d"),
        (400, "cd"),
        (100, "c"),
        (90, "xc"),
        (50, "l"),
        (40, "xl"),
        (10, "x"),
        (9, "ix"),
        (5, "v"),
        (4, "iv"),
        (1, "i"),
    ];
    let mut out = String::new();
    for (value, digits) in DIGITS {
        while n >= value {
            out.push_str(digits);
            n -= value;
        }
    }
    out
}

/// A list item's marker: in the indent before its content, its end
/// against it, as a browser places it (the app's classes give the item
/// its indent). The view draws it; the document has no marker.
fn marker(rv: Rv, item: ReadSignal<BlockItem>) -> impl IntoElement {
    dynamic(move || {
        rv.doc_rev.get();
        let it = item.get();
        let label = marker_text(&rv, &it)?;
        // The first line's typography (and the space above it), so the
        // marker sits on that line's baseline as a browser's does; the
        // marker's part comes after it.
        let first = it.node.first_child().cloned();
        let props = rv.props;
        let typography = move || {
            props.classes.with(|c| {
                let mut list: Vec<String> = first
                    .as_ref()
                    .map(|n| parts::node_classes(c, n))
                    .unwrap_or_default()
                    .iter()
                    .flat_map(|class| class.split_whitespace())
                    .filter(|t| first_line_class(t))
                    .map(str::to_owned)
                    .collect();
                list.extend(c.part(Part::ListMarker).cloned().map(|s| s.to_string()));
                parts::join(list)
            })
        };
        Some(
            text(label)
                .app_class(typography)
                .absolute()
                .top(px(0.0))
                .right(relative(1.0))
                // A box wide enough for numbers, the marker at its end, as
                // TextView places its markers.
                .w(px(32.0))
                .pe(px(6.0))
                .text_right()
                .pointer_events(PointerEvents::None)
                .inline_style(move || {
                    props
                        .styles
                        .with(|s| s.part(Part::ListMarker).cloned().unwrap_or_default())
                }),
        )
    })
}

/// Whether a class of an item's first block sets how its first line sits:
/// its font, size, line height and the space above it (not its box: a code
/// block's background stays its own).
fn first_line_class(class: &str) -> bool {
    let utility = class.rsplit(':').next().unwrap_or(class);
    [
        "text-",
        "leading-",
        "font-",
        "tracking-",
        "pt-",
        "py-",
        "p-",
        "mt-",
        "my-",
    ]
    .iter()
    .any(|p| utility.starts_with(p))
        && !matches!(
            utility,
            "text-left" | "text-center" | "text-right" | "text-justify" | "text-start" | "text-end"
        )
        || matches!(utility, "italic" | "not-italic")
}

/// Whether a node selection holds the block (subscribes to the
/// selection).
fn node_selected(rv: &Rv, it: &BlockItem) -> bool {
    rv.sel_rev.get();
    let state = rv.st.borrow();
    state.selection().as_node().is_some() && state.selection().from() == it.pos
}

/// The classes node decorations give the block (`class` of their
/// attributes).
fn node_decoration_classes(rv: &Rv, it: &BlockItem) -> Vec<String> {
    let end = it.pos + it.node.node_size();
    rv.decorations
        .borrow()
        .iter()
        .filter(|d| d.from == it.pos && d.to == end)
        .filter_map(|d| match &d.kind {
            DecorationKind::Node { attrs } => class_of(attrs),
            _ => None,
        })
        .collect()
}

fn class_of(attrs: &std::collections::BTreeMap<String, Value>) -> Option<String> {
    attrs
        .get("class")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// A piece of a textblock's text.
#[derive(Debug, Clone, PartialEq)]
enum Piece {
    /// Text with its marks and its inline decorations' classes.
    Text {
        text: String,
        marks: Vec<Mark>,
        classes: Vec<String>,
    },
    /// An inline leaf node at `offset` of the content, drawn as `text`
    /// where it has one ([`Rv::leaf_text`]).
    Leaf {
        node: Node,
        offset: usize,
        text: Option<String>,
    },
    /// A widget decoration (its `class`).
    Widget { class: Option<String> },
    /// What an input method is composing at the caret, before the
    /// document holds it: drawn in the line, in its block's typography.
    Composition { text: String },
    /// What keeps an empty textblock a line high.
    Filler,
}

/// A textblock's content as pieces, and the map of its positions.
#[derive(Debug, Clone, PartialEq, Default)]
struct Inline {
    pieces: Vec<Piece>,
    map: InlineMap,
}

/// The pieces of textblock `node` whose content starts at `start`, under
/// `decorations`, with `composition` (its position and text) where it is
/// in the block; `leaf_text` is the text an inline leaf is drawn as.
fn inline_of(
    node: &Node,
    start: usize,
    decorations: &[Decoration],
    composition: Option<(usize, &str)>,
    leaf_text: impl Fn(&Node) -> Option<String>,
) -> Inline {
    let size = node.content().size();
    let end = start + size;
    // Where inline decorations start and end, and widgets sit.
    let mut cuts: Vec<usize> = Vec::new();
    let mut inline: Vec<(usize, usize, Option<String>)> = Vec::new();
    // A widget's class, or the composition's text.
    let mut widgets: Vec<(usize, i32, Result<Option<String>, String>)> = Vec::new();
    for d in decorations {
        match &d.kind {
            DecorationKind::Inline { attrs, .. }
                if d.from < end && d.to > start && d.from < d.to =>
            {
                let (a, b) = (d.from.max(start) - start, d.to.min(end) - start);
                cuts.extend([a, b]);
                inline.push((a, b, class_of(attrs)));
            }
            DecorationKind::Widget { side, .. } if d.from >= start && d.from <= end => {
                let at = d.from - start;
                cuts.push(at);
                widgets.push((
                    at,
                    *side,
                    Ok(d.spec
                        .get("class")
                        .and_then(Value::as_str)
                        .map(str::to_owned)),
                ));
            }
            _ => {}
        }
    }
    // After the caret's position, so the caret (and the input method's
    // candidates at it) stays at the composition's start.
    if let Some((pos, text)) = composition
        && pos >= start
        && pos <= end
        && !text.is_empty()
    {
        cuts.push(pos - start);
        widgets.push((pos - start, i32::MAX, Err(text.to_owned())));
    }
    crate::sort::sort_by_key(&mut widgets, |w| (w.0, w.1));
    let mut out = Inline::default();
    let mut text_at = 0u32;
    let mut emitted = 0usize;
    let mut emit_widgets = |out: &mut Inline, text_at: &mut u32, upto: usize, inclusive: bool| {
        while emitted < widgets.len()
            && (widgets[emitted].0 < upto || (inclusive && widgets[emitted].0 == upto))
        {
            let (at, side, kind) = widgets[emitted].clone();
            let len = match &kind {
                Ok(_) => 1,
                Err(text) => utf16_len(text) as u32,
            };
            out.pieces.push(match kind {
                Ok(class) => Piece::Widget { class },
                Err(text) => Piece::Composition { text },
            });
            out.map.runs.push(Run {
                doc: at,
                doc_len: 0,
                text: *text_at,
                text_len: len,
                side,
            });
            *text_at += len;
            emitted += 1;
        }
    };
    let mut offset = 0usize;
    for child in node.content().iter() {
        let len = child.node_size();
        match child.text() {
            Some(text) => {
                // Split at the cuts inside it.
                let mut points: Vec<usize> = cuts
                    .iter()
                    .copied()
                    .filter(|c| *c > offset && *c < offset + len)
                    .collect();
                points.sort_unstable();
                points.dedup();
                let mut from = offset;
                for to in points.into_iter().chain([offset + len]) {
                    emit_widgets(&mut out, &mut text_at, from, true);
                    let piece = utf16_slice(text, from - offset, to - offset);
                    let classes = inline
                        .iter()
                        .filter(|(a, b, _)| *a <= from && *b >= to)
                        .filter_map(|(_, _, c)| c.clone())
                        .collect();
                    let n = (to - from) as u32;
                    out.map.runs.push(Run {
                        doc: from,
                        doc_len: to - from,
                        text: text_at,
                        text_len: n,
                        side: 0,
                    });
                    text_at += n;
                    out.pieces.push(Piece::Text {
                        text: piece,
                        marks: child.marks().to_vec(),
                        classes,
                    });
                    from = to;
                }
            }
            None => {
                emit_widgets(&mut out, &mut text_at, offset, true);
                let text = leaf_text(child);
                let units = text.as_deref().map_or(len, utf16_len) as u32;
                out.map.runs.push(Run {
                    doc: offset,
                    doc_len: len,
                    text: text_at,
                    text_len: units,
                    side: 0,
                });
                text_at += units;
                out.pieces.push(Piece::Leaf {
                    node: child.clone(),
                    offset,
                    text,
                });
            }
        }
        offset += len;
    }
    emit_widgets(&mut out, &mut text_at, size, true);
    if text_at == 0 {
        out.pieces.push(Piece::Filler);
        out.map.runs.push(Run {
            doc: 0,
            doc_len: 0,
            text: 0,
            text_len: 1,
            side: -1,
        });
        text_at = 1;
    }
    out.map.size = size;
    out.map.len = text_at;
    out
}

/// Code units `from..to` of `text`.
fn utf16_slice(text: &str, from: usize, to: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    String::from_utf16_lossy(&units[from.min(units.len())..to.min(units.len())])
}

/// A textblock's text, its lines and frame reported to the geometry
/// (`owner`: the box its frame is in).
fn text_block(rv: Rv, item: ReadSignal<BlockItem>, owner: u64) -> impl IntoElement {
    let id = item.get_untracked().id;
    let inline_rv = rv.clone();
    let content = computed(move || {
        inline_rv.deco_rev.get();
        let it = item.get();
        let start = it.pos + 1;
        let decorations = inline_rv.decorations_in(start, start + it.node.content().size());
        let composition = inline_rv.composition.get();
        let head = composition
            .as_ref()
            .map(|_| inline_rv.st.borrow().selection().head());
        let inline = inline_of(
            &it.node,
            start,
            &decorations,
            head.zip(composition.as_deref()),
            |n| inline_rv.leaf_text(n),
        );
        if let Some(geo) = inline_rv.geo.borrow_mut().texts.get_mut(&id) {
            geo.map = inline.map.clone();
        }
        inline
    });
    let ph_rv = rv.clone();
    let placeholder = computed(move || {
        let it = item.get();
        placeholder_text(&ph_rv, &it)
    });
    let (frame_rv, lines_rv, spans_rv) = (rv.clone(), rv.clone(), rv);
    text("")
        .on_layout(move |b: &Bounds<Points>| frame_rv.set_text_frame(id, owner, *b))
        .on(EventKind::TextLayout, move |p: &EventPayload| {
            if let EventPayload::TextLayout(lines) = p {
                lines_rv.set_lines(id, lines.clone());
            }
        })
        .child(dynamic(move || {
            let inline = content.get();
            let start = item.get_untracked().pos + 1;
            let mut list = spans(&spans_rv, inline.pieces.clone(), start);
            if inline.pieces == [Piece::Filler]
                && let Some(label) = placeholder.get()
            {
                list.push(
                    part(
                        text(label).text_color(move || theme().muted_foreground),
                        &spans_rv,
                        Part::Placeholder,
                    )
                    .into_element(),
                );
            }
            list
        }))
}

/// The placeholder of an empty textblock that shows one (Tiptap's
/// placeholder extension: `placeholders` by type, else `placeholder`;
/// while editable, in the anchor's block, at the top level, unless the
/// flags say otherwise). The block an input method composes in shows
/// none: the composition, drawn at the caret before the document holds
/// it, would sit over it (a native input hides its placeholder once it
/// has marked text).
fn placeholder_text(rv: &Rv, it: &BlockItem) -> Option<String> {
    let props = rv.props;
    if !it.node.is_textblock() || it.node.content().size() != 0 {
        return None;
    }
    if props.show_only_when_editable.get() && !props.editable.get() {
        return None;
    }
    let by_type = props
        .placeholders
        .with(|m| m.as_ref().and_then(|m| m.get(it.node.ty().name()).cloned()));
    let general = by_type.is_none();
    let label = by_type.or_else(|| props.placeholder.get().map(|s| s.to_string()))?;
    let include_children = props.include_children.get();
    let only_current = props.show_only_current.get();
    let composing = rv.composition.with(Option::is_some);
    if only_current || composing {
        rv.sel_rev.get();
    }
    if general {
        rv.doc_rev.get();
    }
    let state = rv.st.borrow();
    // `placeholder` is the empty document's: an empty line in a document
    // with content (text or an inline node) stays blank.
    if general {
        let mut content = false;
        state.doc().descendants(&mut |n, _, _, _| {
            content |= n.is_inline();
            !content
        });
        if content {
            return None;
        }
    }
    if !include_children && state.doc().resolve(it.pos).ok()?.depth != 0 {
        return None;
    }
    let inside = |pos: usize| pos >= it.pos && pos <= it.pos + it.node.node_size();
    if only_current && !inside(state.selection().anchor()) {
        return None;
    }
    if composing && inside(state.selection().head()) {
        return None;
    }
    Some(label)
}

/// The spans of a textblock's pieces.
fn spans(rv: &Rv, pieces: Vec<Piece>, start: usize) -> Vec<AnyElement> {
    let props = rv.props;
    pieces
        .into_iter()
        .map(|piece| match piece {
            Piece::Text {
                text: t,
                marks,
                classes,
            } => {
                if let Some((mark, view)) = marks
                    .iter()
                    .find_map(|m| rv.mark_view(m.ty().name()).map(|v| (m, v)))
                {
                    return view.create(mark, &t);
                }
                let style_marks = marks.clone();
                text(t)
                    .app_class(move || {
                        props.classes.with(|c| {
                            let mut list: Vec<String> = marks
                                .iter()
                                .flat_map(|m| parts::mark_classes(c, m))
                                .collect();
                            list.extend(classes.iter().cloned());
                            parts::join(list)
                        })
                    })
                    .inline_style(move || {
                        props.styles.with(|s| {
                            let list: Vec<Style> = style_marks
                                .iter()
                                .flat_map(|m| parts::mark_styles(s, m))
                                .collect();
                            parts::merge(&list)
                        })
                    })
                    .into_element()
            }
            Piece::Leaf { node, offset, text } => leaf(rv, node, start + offset, text),
            Piece::Widget { class } => view()
                .app_class(class.map(SharedString::from))
                .into_element(),
            Piece::Composition { text: t } => {
                part(text(t).underline(), rv, Part::Composition).into_element()
            }
            Piece::Filler => text("\u{200B}").into_element(),
        })
        .collect()
}

/// An inline leaf: its one-character text (a line break), its node view,
/// the text it is drawn as (`drawn`, [`Rv::leaf_text`]), else a box of its
/// part.
fn leaf(rv: &Rv, node: Node, pos: usize, drawn: Option<String>) -> AnyElement {
    let props = rv.props;
    let classes_node = node.clone();
    let styled = move |el: View| {
        let style_node = classes_node.clone();
        let class_node = classes_node.clone();
        el.app_class(move || {
            props
                .classes
                .with(|c| parts::join(parts::node_classes(c, &class_node)))
        })
        .inline_style(move || {
            props
                .styles
                .with(|s| parts::merge(&parts::node_styles(s, &style_node)))
        })
    };
    if let Some(view) = rv.node_view(node.ty().name()) {
        let get_pos: Rc<dyn Fn() -> Option<usize>> = Rc::new(move || Some(pos));
        let cx = NodeViewCx::new(
            rv.session.clone(),
            get_pos,
            signal(node.clone()).read_only(),
            signal(false).read_only(),
            signal(Vec::new()).read_only(),
            None,
        );
        let el = view.create(&cx, &node);
        cleanup(move || view.destroy());
        return styled(view_box()).child(el).into_element();
    }
    if render_kind(&node) == Some("image") {
        return styled(view_box()).child(image_of(&node)).into_element();
    }
    if let Some(drawn) = drawn {
        let (class_node, style_node) = (node.clone(), node);
        return text(drawn)
            .app_class(move || {
                props
                    .classes
                    .with(|c| parts::join(parts::node_classes(c, &class_node)))
            })
            .inline_style(move || {
                props
                    .styles
                    .with(|s| parts::merge(&parts::node_styles(s, &style_node)))
            })
            .into_element();
    }
    match node.ty().spec().leaf_text.as_deref() {
        Some(t) if utf16_len(t) == 1 => {
            let class_node = node.clone();
            text(t.to_owned())
                .app_class(move || {
                    props
                        .classes
                        .with(|c| parts::join(parts::node_classes(c, &class_node)))
                })
                .into_element()
        }
        _ => styled(view_box()).into_element(),
    }
}

fn view_box() -> View {
    view()
}

/// A node view's element for a block, made again when the view's
/// `update` refuses a new node.
fn node_view_block(rv: Rv, item: ReadSignal<BlockItem>, view: Arc<dyn NodeView>) -> AnyElement {
    let first = item.get_untracked();
    let id = first.id;
    let node = signal(first.node.clone());
    let selected = signal(false);
    let decorations = signal(Vec::<Decoration>::new());
    let generation = signal(0u64);
    let pos = Rc::new(Cell::new(Some(first.pos)));
    {
        let (rv, view, pos) = (rv.clone(), view.clone(), pos.clone());
        effect(move || {
            let it = item.get();
            rv.deco_rev.get();
            pos.set(Some(it.pos));
            let list = rv.decorations_in(it.pos, it.pos + it.node.node_size());
            let current = node.get_untracked();
            if !it.node.ptr_eq(&current) {
                if !untracked(|| view.update(&it.node, &list)) {
                    generation.update(|g| *g += 1);
                }
                node.set(it.node.clone());
            }
            decorations.set(list);
        });
    }
    {
        let rv = rv.clone();
        effect(move || {
            let it = item.get();
            selected.set(node_selected(&rv, &it));
        });
    }
    {
        let pos = pos.clone();
        cleanup(move || pos.set(None));
    }
    dynamic(move || {
        generation.get();
        let rv = rv.clone();
        let view = view.clone();
        let pos = pos.clone();
        untracked(move || {
            let current = node.get_untracked();
            let content = view
                .editable_content_slot()
                .then(|| slot(rv.clone(), item, id, &current));
            let get_pos: Rc<dyn Fn() -> Option<usize>> = Rc::new(move || pos.get());
            let cx = NodeViewCx::new(
                rv.session.clone(),
                get_pos,
                node.read_only(),
                selected.read_only(),
                decorations.read_only(),
                content,
            );
            let el = view.create(&cx, &current);
            let destroyed = view.clone();
            cleanup(move || destroyed.destroy());
            el
        })
    })
}

/// The editable content of a node view's node: measured in the content
/// box, since the view's element is the app's.
fn slot(rv: Rv, item: ReadSignal<BlockItem>, id: u64, node: &Node) -> AnyElement {
    let sid = slot_id(id);
    let r = element_ref();
    let measure_rv = rv.clone();
    let inner = if node.is_textblock() {
        text_block(rv, item, sid).into_element()
    } else {
        blocks(rv, id)
    };
    view()
        .element_ref(&r)
        .on_layout(move |_: &Bounds<Points>| {
            let rv = measure_rv.clone();
            spawn(async move {
                let (Some(slot), Some(content)) = (r.measure().await, rv.content.measure().await)
                else {
                    return;
                };
                let origin = Point::new(slot.page.x - content.page.x, slot.page.y - content.page.y);
                rv.set_frame(sid, None, Bounds::new(origin, slot.frame.size));
            });
        })
        .child(inner)
        .into_element()
}

/// The selection's boxes.
fn selection_rects(rv: Rv) -> impl IntoElement {
    dynamic(move || {
        rv.sel_rev.get();
        rv.layout_rev.get();
        rv.doc_rev.get();
        let (from, to, text) = {
            let state = rv.st.borrow();
            let s = state.selection();
            // Selected cells are painted in the cells (`selectedCell`).
            let cells = s.as_custom::<CellSelection>().is_some();
            (s.from(), s.to(), s.as_node().is_none() && !cells)
        };
        if from == to || !text {
            return Vec::new();
        }
        let rects = rv.geo.borrow().range_rects(from, to);
        rects
            .into_iter()
            .map(|b| {
                part(
                    rect(b).bg(move || theme().selection()),
                    &rv,
                    Part::Selection,
                )
            })
            .collect::<Vec<_>>()
    })
}

/// The gap cursor: a horizontal caret at the gap, blinking as the caret.
fn gap_cursor(rv: Rv) -> impl IntoElement {
    let (blink, focused) = (rv.blink, rv.focused);
    dynamic(move || {
        rv.sel_rev.get();
        rv.layout_rev.get();
        rv.doc_rev.get();
        let pos = {
            let state = rv.st.borrow();
            let sel = state.selection();
            sel.is_gap_cursor().then(|| sel.head())?
        };
        let line = rv.block_edge_rect(pos)?;
        Some(part(
            rect(Bounds::new(
                Point::new(line.origin.x, line.origin.y - px(CARET_WIDTH / 2.0)),
                Size::new(px(GAP_WIDTH), px(CARET_WIDTH)),
            ))
            .bg(move || theme().foreground)
            .opacity(move || {
                if focused.get() && blink.get() {
                    1.0_f32
                } else {
                    0.0
                }
            }),
            &rv,
            Part::GapCursor,
        ))
    })
}

/// The drop cursor, while a drag moves the selection: a caret where the
/// drop lands in text, else a line between the blocks there.
fn drop_cursor(rv: Rv) -> impl IntoElement {
    dynamic(move || {
        let pos = rv.drop_at.get()?;
        rv.layout_rev.get();
        let in_text = {
            let state = rv.st.borrow();
            state
                .doc()
                .resolve(pos)
                .is_ok_and(|r| r.parent().inline_content())
        };
        let b = if in_text {
            let c = rv.geo.borrow().caret_rect(pos, Default::default())?;
            Bounds::new(
                Point::new(c.origin.x - px(CARET_WIDTH / 2.0), c.origin.y),
                Size::new(px(CARET_WIDTH), c.size.height),
            )
        } else {
            let line = rv.block_edge_rect(pos)?;
            Bounds::new(
                Point::new(line.origin.x, line.origin.y - px(CARET_WIDTH / 2.0)),
                Size::new(line.size.width, px(CARET_WIDTH)),
            )
        };
        // Tests find the line mid-drag by its id (`nsh/test`'s `dragAndHold`).
        Some(part(
            rect(b)
                .test_id("rich-editor-drop-cursor")
                .bg(move || theme().foreground),
            &rv,
            Part::DropCursor,
        ))
    })
}

/// The caret, blinking while the editor has the focus.
fn caret(rv: Rv) -> impl IntoElement {
    let (blink, focused) = (rv.blink, rv.focused);
    dynamic(move || {
        rv.sel_rev.get();
        rv.layout_rev.get();
        rv.doc_rev.get();
        if rv.composition.get().is_some() || !rv.props.editable.get() {
            return None;
        }
        let empty_text = {
            let state = rv.st.borrow();
            state.selection().empty() && state.selection().as_text().is_some()
        };
        if !empty_text {
            return None;
        }
        let b = rv.caret_glyph_rect()?;
        // On whole device pixels: a caret between pixels is drawn smeared
        // over two, wider or narrower as it moves (gpui-kit's fix).
        let snap = nsh_core::element::round_to_nearest_pixel;
        let width = snap(px(CARET_WIDTH)).max(px(1.0 / nsh_core::element::pixel_ratio().max(1.0)));
        Some(part(
            rect(Bounds::new(
                Point::new(snap(b.origin.x - width * 0.5), snap(b.origin.y)),
                Size::new(width, snap(b.size.height)),
            ))
            .bg(move || theme().foreground)
            .opacity(move || {
                if focused.get() && blink.get() {
                    1.0_f32
                } else {
                    0.0
                }
            }),
            &rv,
            Part::Caret,
        ))
    })
}

/// The native input that takes typed text and input methods, kept at the
/// caret (where the input method's candidates open), invisible. It lies
/// over the scroll view, not in it: the platforms scroll a focused field
/// into view, which the editor does itself for its caret.
fn sink(rv: Rv) -> impl IntoElement {
    let at = {
        let rv = rv.clone();
        computed(move || {
            rv.sel_rev.get();
            rv.layout_rev.get();
            let caret = rv.caret_rect().unwrap_or_default();
            let size = rv.viewport.get();
            // At the bottom of the caret's line: input methods open their
            // candidates under the field's line, which would cover the
            // lower part of a taller line (a heading's).
            let y = caret.origin.y + (caret.size.height - px(SINK_HEIGHT)).max(px(0.0))
                - rv.scroll_y.get();
            Point::new(
                caret.origin.x.min(size.width - px(1.0)).max(px(0.0)),
                y.min(size.height - px(1.0)).max(px(0.0)),
            )
        })
    };
    let props = rv.props;
    let (change, composition, key, paste, focus, blur) = (
        rv.clone(),
        rv.clone(),
        rv.clone(),
        rv.clone(),
        rv.clone(),
        rv.clone(),
    );
    let value = rv.sink_value;
    input()
        .element_ref(&rv.input)
        .absolute()
        .left(move || Length::from(at.get().x))
        .top(move || Length::from(at.get().y))
        .w(px(1.0))
        .h(px(SINK_HEIGHT))
        .pointer_events(if is_terminal() {
            PointerEvents::BoxNone
        } else {
            PointerEvents::None
        })
        .p_0()
        .border(px(0.0))
        .bg(AdaptiveColor::TRANSPARENT)
        .text_color(AdaptiveColor::TRANSPARENT)
        .caret(false)
        .multiline(true)
        // The terminal applies native autofocus after the sink is attached.
        .auto_focus(move || is_terminal() && props.auto_focus.get())
        // The app's scroll bars (`Scrollbar.setTheme`) are for what people
        // see: a thumb here would show at the caret once the text it
        // holds overflows.
        .scrollbar(false)
        .auto_correct(false)
        .auto_capitalize(AutoCapitalize::None)
        .paste_behavior(PasteBehavior::Report)
        .value(move || value.get())
        .label(move || props.accessibility_label.get().unwrap_or_default())
        .on_change(move |text: &str| change.sink_changed(text))
        .on_composition_change(move |c: &Composition| {
            composition.composition_changed(c.composing, &c.text)
        })
        .on_key_press(move |k: &str| key.sink_key(k))
        .on_paste(move |p: &PasteEvent| paste.paste_event(p))
        .on_focus(move || focus.focus_changed(true))
        .on_blur(move || blur.focus_changed(false))
}

impl Rv {
    /// The text inline leaf `node` is drawn as: its type's `render_text` (a
    /// mention's `@name`), unless its node view, an image or a
    /// one-character `leaf_text` draws it. It stays one position, however
    /// many characters it shows.
    fn leaf_text(&self, node: &Node) -> Option<String> {
        let spec = node.ty().spec();
        if self.node_view(node.ty().name()).is_some()
            || render_kind(node) == Some("image")
            || spec.leaf_text.as_deref().is_some_and(|t| utf16_len(t) == 1)
        {
            return None;
        }
        spec.render_text
            .as_ref()
            .map(|render| render.text(node))
            .filter(|t| !t.is_empty())
    }

    /// Block (or slot) `id`'s frame in box `parent` (`None`: the content
    /// box).
    pub(crate) fn set_frame(&self, id: u64, parent: Option<u64>, frame: Bounds<Points>) {
        let mut geo = self.geo.borrow_mut();
        if geo.frames.get(&id) == Some(&(parent, frame)) {
            return;
        }
        geo.frames.insert(id, (parent, frame));
        drop(geo);
        self.layout_rev.update(|r| *r += 1);
    }

    /// Textblock `id`'s text frame, in box `owner`.
    fn set_text_frame(&self, id: u64, owner: u64, frame: Bounds<Points>) {
        let mut geo = self.geo.borrow_mut();
        let Some(text) = geo.texts.get_mut(&id) else {
            return;
        };
        if text.frame == frame && text.owner == Some(owner) {
            return;
        }
        text.frame = frame;
        text.owner = Some(owner);
        drop(geo);
        self.layout_rev.update(|r| *r += 1);
    }

    /// Sets the `checked` attribute of the task item at `pos`.
    fn set_checked(&self, pos: usize, checked: bool) {
        if !self.editable() {
            return;
        }
        let state = self.session.state();
        if state.doc().node_at(pos).is_none() {
            return;
        }
        let mut tr = state.tr();
        if tr
            .set_node_attribute(pos, "checked", Value::Bool(checked))
            .is_ok()
        {
            tr.set_origin(crate::rich_editor::state::TransactionOrigin::User);
            if let Err(e) = self.session.dispatch(tr) {
                log::warn!("RichEditor: a transaction was refused: {e}");
            }
        }
    }

    /// The mark view of type `name`: a plugin's.
    fn mark_view(&self, name: &str) -> Option<Arc<dyn MarkView>> {
        let state = self.st.borrow();
        for plugin in state.plugins() {
            for (n, factory) in plugin.mark_views() {
                if n == name
                    && let Some(view) = factory.downcast_ref::<Arc<dyn MarkView>>()
                {
                    return Some(view.clone());
                }
            }
        }
        None
    }

    /// Textblock `id`'s lines.
    fn set_lines(&self, id: u64, lines: Vec<nsh_core::TextLine>) {
        if let Some(text) = self.geo.borrow_mut().texts.get_mut(&id) {
            text.lines = lines;
        }
        self.layout_rev.update(|r| *r += 1);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::rich_editor::extensions::starter;

    #[test]
    fn decorations_split_text_and_widgets_take_a_unit() {
        let schema = starter::schema();
        let doc = schema
            .node_from_json(&json!({"type": "doc", "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "hello"}]}
            ]}))
            .unwrap();
        let p = doc.child(0).clone();
        let mut attrs = std::collections::BTreeMap::new();
        attrs.insert("class".into(), json!("hl"));
        let decorations = vec![
            Decoration::inline(2, 4, attrs),
            Decoration::widget(4, "w", -1),
        ];
        let inline = inline_of(&p, 1, &decorations, None, |_| None);
        let texts: Vec<_> = inline
            .pieces
            .iter()
            .map(|p| match p {
                Piece::Text { text, classes, .. } => format!("{text}{classes:?}"),
                Piece::Widget { .. } => "W".into(),
                other => format!("{other:?}"),
            })
            .collect();
        assert_eq!(texts, ["h[]", "el[\"hl\"]", "W", "lo[]"]);
        // Position 4 (offset 3) is after the widget that sticks before it.
        assert_eq!(inline.map.to_text(3), 4);
        assert_eq!(inline.map.len, 6);
    }

    #[test]
    fn an_empty_textblock_has_a_filler() {
        let schema = starter::schema();
        let p = schema
            .node("paragraph", None, Default::default(), vec![])
            .unwrap();
        let inline = inline_of(&p, 1, &[], None, |_| None);
        assert_eq!(inline.pieces, [Piece::Filler]);
        assert_eq!(inline.map.to_text(0), 1);
    }
}

#[cfg(test)]
mod marker_tests {
    use super::{alpha, roman};

    #[test]
    fn nested_numbers_count_in_letters_and_roman_numerals() {
        assert_eq!(alpha(1), "a");
        assert_eq!(alpha(26), "z");
        assert_eq!(alpha(28), "ab");
        assert_eq!(roman(4), "iv");
        assert_eq!(roman(14), "xiv");
    }
}
