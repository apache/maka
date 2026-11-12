//! The painter: the retained view tree drawn in the terminal's own look, as
//! a well-made terminal app draws, never the GUI copied Cell by Cell.
//!
//! Frames are in points; a view's Cells are its frame divided by the
//! [`CellSize`] (the core lays out on the grid in the terminal idiom, so
//! frames arrive in whole Cells and every border owns its Cells). Views
//! paint in tree order (the core orders siblings by `zIndex`), modals after
//! the root, system dialogs ([`crate::dialog`]) over everything.
//!
//! - **Colors** are the terminal's theme ([`crate::palette`]): the body
//!   keeps the terminal's default foreground and background
//!   (`Color::Reset`); app colors become the default foreground, DIM or a
//!   named accent. Fills, radii, shadows, gradients, outlines, opacity
//!   tints and filters are the GUI's and draw nothing; an opaque fill only
//!   decides what the colors drawn on it are read against. A gradient
//!   over no fill of its own is a fill of its first stop.
//! - **Borders** are single-line box drawing in the dim default color (an
//!   accent when the app colored them), rounded `╭╮╰╯` where a corner has a
//!   radius, on the sides the layout gave a Cell: the core sends a border
//!   width only for those (a card's), never on a control, a box of text or
//!   a small box.
//! - **Text** keeps its weight (bold from 600), slant, underline and
//!   strike-through; a run whose background is an accent is a reversed
//!   band of that accent (a highlight).
//! - **State** is drawn from what views are, never from how the app drew
//!   them: a selected or current item (`selected`, `current`, a checked
//!   menu item, an on toggle button) is a reversed band over its Cells; a
//!   focused control is reversed over its text (a text field: its text
//!   underlined, the terminal cursor its caret; a large container: its
//!   border bold, or its text bold and underlined); a hovered pressable
//!   view is a faint band ([`Bands`]), a pressed one a stronger band
//!   (reversed text at 16 colors); a disabled view is dim and never bold.
//!   A control whose own fill stands out from what it is on (a primary
//!   button) has bold text in the fill's accent.
//! - **Overlays**: what is behind a modal dims; the boxes of a modal or an
//!   anchored overlay (a border or an opaque fill) are cleared over what is
//!   behind them, and an overlay's outermost box without a border of its
//!   own gets a rounded dim one, its title the overlay's accessibility
//!   label.
//! - **Scroll bars** ([`crate::scrollbar`]): a dim track `│` with a thumb
//!   `┃` in the default color over the inner right (bottom) edge, only when
//!   the content overflows.
//! - **Unsupported** content is left out: images, video, web views,
//!   native components without a terminal rendering and icon-sized
//!   canvases take no Cells in the layout (the mounter logs each content
//!   kind once). A control whose content is all left out (an icon button)
//!   draws its accessibility label as its label.
//! - **Clipping**: a text draws inside its own view's box; a view that
//!   clips, scrolls or has a border keeps its children inside its content
//!   box (the border excluded), anchored overlays stand inside the
//!   surface; a one-line text cut at its right edge ends in `…`.
//!
//! Drawing the same tree twice changes no Cell.

use std::collections::HashMap;

use nsh_core::{
    AccessibilityRole, BorderStyle, Bounds, Checked, CornerRadii, NodeId, Point, PointerEvents,
    Points, ROOT_ID, TransformKind, ViewKind, tailwind::state,
};
use ratatui_core::{
    buffer::Buffer,
    layout::{Position, Rect},
    style::{Color, Modifier},
};

use crate::{
    CellSize, dialog,
    geometry::CellBounds,
    mount::Mounter,
    palette::{self, Bands, Ground, HOVER, Ramp, SELECT, Surface, Tone, ink, stands_out},
    scrollbar::ScrollBar,
    text::CellLayout,
    view::NshView,
};

/// Below this opacity, multiplied through its ancestors, a view draws
/// nothing; above it opacity is ignored (the terminal has no translucency).
const INVISIBLE_OPACITY: f32 = 0.03;
/// From this many rows inside its border a focused view is a container,
/// shown by its border (or bold, underlined text) instead of a reversed
/// label.
const CONTAINER_ROWS: u16 = 3;

pub(crate) struct Hit {
    pub(crate) node: NodeId,
    pub(crate) area: Rect,
    pub(crate) target: Option<NodeId>,
    pub(crate) origin: Point<Points>,
    pub(crate) node_origin: Point<Points>,
}

#[derive(Clone, Copy)]
pub(crate) struct Geometry {
    pub(crate) id: NodeId,
    pub(crate) bounds: CellBounds,
    pub(crate) visible: Rect,
    pub(crate) frame: Bounds<Points>,
    pub(crate) text_frame: Option<Bounds<Points>>,
    pub(crate) scroll_origin: Point<Points>,
}

/// How a frame is drawn: the size of a Cell, the app's appearance at the
/// terminal's depth (`page`) and the bands that show hover and press.
pub(crate) struct Look {
    pub(crate) cells: CellSize,
    pub(crate) page: Ground,
    pub(crate) bands: Bands,
}

/// Draws the tree into `area` of `buffer` in `look` (colors read against its
/// `page`, hover and press shown with its `bands`), and records what input
/// needs:
/// the views that take the pointer (`hits`, topmost last; none while a
/// system dialog is shown), every view's Cells (`geometry`) and the scroll
/// bars (`tree.scroll_bars`).
pub(crate) fn draw(
    tree: &mut Mounter,
    images: &mut crate::image::ImageStore,
    sink: &crate::surface::Sink,
    buffer: &mut Buffer,
    area: Rect,
    look: Look,
    hits: &mut Vec<Hit>,
    geometry: &mut Vec<Geometry>,
) {
    let Look { cells, page, bands } = look;
    hits.clear();
    geometry.clear();
    let mut bars = std::mem::take(&mut tree.scroll_bars);
    bars.clear();
    let clip = area.intersection(buffer.area);
    let mut tree_spans = std::mem::take(&mut tree.spans);
    tree_spans.clear();
    let mut text_cells = std::mem::take(&mut tree.text_cells);
    text_cells.clear();
    text_cells.resize(buffer.content.len(), false);
    let mut links = std::mem::take(&mut tree.links);
    links.clear();
    let mut painter = Painter {
        buffer,
        tree,
        images,
        hits,
        geometry,
        bars,
        area,
        cells,
        bands,
        screen: clip,
        text_cells,
        links,
        link: None,
        focus: Focus::None,
        popup: false,
        pane: None,
        page: page.rgb,
        spans: std::mem::take(&mut tree_spans),
        hues: palette::Hues::default(),
        dividers: Vec::new(),
        sixels: Vec::new(),
    };
    painter.pane = focus_pane(painter.tree);
    let root = Layer::default();
    painter.view(ROOT_ID, Point::default(), clip, 1.0, page, root, true, None);
    join_lines(painter.buffer, &painter.dividers);
    let mut index = 0;
    while let Some(&modal) = painter.tree.modals.get(index) {
        index += 1;
        if crate::navigation::modal_visible(painter.tree, modal) {
            // The page behind the modal is drawn as it is (a terminal shows
            // no scrim) and holds no text the modal's own can cut short: no
            // `…` lands on the modal's frame where its text starts beside a
            // page's words.
            painter.text_cells.fill(false);
            let layer = Layer {
                overlay: true,
                modal: true,
                in_modal: true,
                boxed: false,
                title: None,
                viewport: None,
                disabled: false,
                pane: false,
                right_line: None,
                field_group: false,
                lined_group: false,
                handle: false,
                rule: false,
                track: false,
                frame: None,
                parent: None,
            };
            let joined = painter.dividers.len();
            painter.view(modal, Point::default(), clip, 1.0, page, layer, true, None);
            // Its own dividers join its own lines, drawn over the page.
            join_lines(painter.buffer, &painter.dividers[joined..]);
        }
    }
    painter.tree.scroll_bars = painter.bars;
    painter.tree.text_cells = std::mem::take(&mut painter.text_cells);
    painter.tree.links = std::mem::take(&mut painter.links);
    painter.tree.spans = std::mem::take(&mut painter.spans);
    if painter.tree.menus.is_open() {
        painter.hits.clear();
        painter
            .tree
            .menus
            .draw(painter.buffer, clip, cells, page.ramp);
    }
    if painter.tree.dialogs.is_shown() {
        painter.hits.clear();
        painter.tree.dialogs.draw(painter.buffer, clip, page.ramp);
    }
    if !painter.tree.menus.is_open() && !painter.tree.dialogs.is_shown() {
        for candidate in painter.sixels {
            let covered = painter.hits[candidate.hit_index..]
                .iter()
                .any(|hit| !hit.area.intersection(candidate.region).is_empty());
            if !covered {
                painter.images.finish_sixel(candidate, sink, painter.buffer);
            }
        }
    }
}

/// Where a view is painted: inside an overlay (a modal or an anchored
/// popup), and whether its box is already framed.
#[derive(Clone, Default)]
struct Layer {
    /// In a modal or an anchored overlay: boxes clear what is behind them.
    overlay: bool,
    /// In a modal (else an anchored overlay, when `overlay`): its box is
    /// the terminal's background, an anchored one's a raised surface.
    modal: bool,
    /// Anywhere inside a modal, an anchored overlay of it included.
    in_modal: bool,
    /// An outer box of the overlay is drawn: inner ones get no frame.
    boxed: bool,
    /// The overlay's accessibility label, its frame's title.
    title: Option<std::sync::Arc<str>>,
    /// The visible part of the innermost scroll view's viewport around
    /// the view: text cut at its edge scrolls into view, so it ends in no
    /// `…`, whatever boxes stand between them.
    viewport: Option<Rect>,
    /// Inside a disabled view: drawn faint (dim) whatever the view's own
    /// frame, as its content may stand outside it.
    disabled: bool,
    /// Inside the innermost box with a line around the focused view (a
    /// pane): its selected rows are where the keys go, an accent band.
    pane: bool,
    /// The parent's right line, when it has one: the column right of its
    /// content (`inner.right`) and the parent's visible Cells. A scroll
    /// view that reaches it draws its bar on that line, as lazygit does.
    right_line: Option<(i32, Rect)>,
    /// Inside an input group's band ([`input_group`]): its field is
    /// raised with it, not a step of its own.
    field_group: bool,
    /// Inside an input group that draws its line (a box three rows tall):
    /// its field shows its extent by that box, with no underline of its own.
    lined_group: bool,
    /// Inside an adjustable view (a resize handle): a column of `│` in
    /// it is a divider's line ([`rule_axis`]).
    handle: bool,
    /// Inside a divider's box ([`holds_rule`]): a column of `│` in it is
    /// its line, as a handle's.
    rule: bool,
    /// Among texts of a row that draws more than lines (a slider's track
    /// beside its thumb, a progress bar's track beside its fill): a run of
    /// `─` there is part of that control, no divider of the box.
    track: bool,
    /// The Cells of the innermost box around the view that draws lines
    /// (its sides, or a frame around it): a divider's ends join only the
    /// lines of that box, never a neighbor's beyond it.
    frame: Option<Rect>,
    /// The parent's visible Cells: where no box around draws lines, a
    /// divider's ends join only lines inside its parent.
    parent: Option<Rect>,
}

struct Painter<'a> {
    buffer: &'a mut Buffer,
    tree: &'a mut Mounter,
    images: &'a mut crate::image::ImageStore,
    hits: &'a mut Vec<Hit>,
    geometry: &'a mut Vec<Geometry>,
    bars: Vec<ScrollBar>,
    area: Rect,
    cells: CellSize,
    bands: Bands,
    /// The surface's Cells: what anchored overlays are clipped to.
    screen: Rect,
    /// Which Cells of the buffer hold text drawn this frame.
    text_cells: Vec<bool>,
    /// The Cells drawn this frame that hold a linked glyph.
    links: crate::link::Painted,
    /// The opening sequence of the hyperlink of the innermost view with an
    /// `href` around the view being drawn (`crate::link`).
    link: Option<std::sync::Arc<str>>,
    /// Where the focus is in the subtree being marked.
    focus: Focus,
    /// A popup (an anchored overlay's box) is drawn: only boxes inside an
    /// overlay show the focus in the accent.
    popup: bool,
    /// The innermost box with a line around the focused view (`Layer::pane`).
    pane: Option<NodeId>,
    /// The page's color: until a view fills the whole screen with the app's
    /// own page color, the terminal's background stands for it.
    page: palette::Rgb,
    /// The links that are stops of Tab, as their texts are drawn.
    spans: HashMap<NodeId, crate::keyboard::Span>,
    /// The canvas colors drawn this frame, kept apart at 16 colors.
    hues: palette::Hues,
    /// The Cells of the dividers drawn this frame (a resize handle's line,
    /// a menu's separator) and whether each runs down: where they meet
    /// another line they are joined with it ([`join_lines`]).
    dividers: Vec<Divider>,
    sixels: Vec<crate::image::SixelCandidate>,
}

/// How far from a framed box's right line a scroll view's right edge may
/// stop (its padding Cell) and still draw its bar on the line.
const LINE_GAP: i32 = 1;

/// A view's borders: which sides draw and each one's style.
struct Edges {
    /// The sides that have a width: they own a line of Cells (top, right,
    /// bottom, left).
    widths: [bool; 4],
    /// The sides that draw.
    sides: [bool; 4],
    colors: [(Color, Modifier); 4],
    style: BorderStyle,
}

impl Edges {
    fn any(&self) -> bool {
        self.sides.iter().any(|&side| side)
    }
}

impl Painter<'_> {
    /// Draws view `id`, whose parent's content starts at `origin` (points
    /// from the area's top left), inside the `clip` Cells; the text inside
    /// a view with an `href` (a `Link`'s) is linked to it.
    #[allow(clippy::too_many_arguments)]
    fn view(
        &mut self,
        id: NodeId,
        origin: Point<Points>,
        clip: Rect,
        opacity: f32,
        ground: Ground,
        layer: Layer,
        pointer: bool,
        press: Option<(NodeId, Point<Points>)>,
    ) {
        let open = self
            .tree
            .get(id)
            .and_then(|view| view.props.href.as_deref())
            .and_then(|href| crate::link::open(id, href));
        let outer = match open {
            Some(open) => self.link.replace(open),
            None => self.link.clone(),
        };
        self.view_content(id, origin, clip, opacity, ground, layer, pointer, press);
        self.link = outer;
    }

    /// Draws view `id` as [`Self::view`] does, within the link around it.
    #[allow(clippy::too_many_arguments)]
    fn view_content(
        &mut self,
        id: NodeId,
        origin: Point<Points>,
        clip: Rect,
        opacity: f32,
        ground: Ground,
        layer: Layer,
        pointer: bool,
        press: Option<(NodeId, Point<Points>)>,
    ) {
        let cells = self.cells;
        let area = self.area;
        let focused_span = self.tree.focused_span;
        let has_images = self.images.protocol().is_some();
        let icon = self
            .tree
            .get(id)
            .and_then(|view| icon_label(self.tree, view, has_images))
            .map(str::to_owned);
        // Only an overlay's box takes a title, so only there is it asked
        // whether its label is already its text.
        let label_shown = self.tree.get(id).is_some_and(|view| {
            let boxes = view.props.overlay_anchor.is_some()
                || view.kind == ViewKind::Modal
                || (layer.overlay && !layer.boxed);
            boxes
                && view
                    .props
                    .accessibility
                    .label
                    .as_deref()
                    .is_some_and(|label| shown(self.tree, id, label))
        });
        // A popup holding a list (a select's, a combobox's, a menu) with
        // no box of the app's is a surface all the same, framed around its
        // own box: the layout keeps that frame's Cells (`Core::framed_box`).
        let list_popup = self
            .tree
            .get(id)
            .is_some_and(|view| view.props.overlay_anchor.is_some())
            && !has_box(self.tree, id)
            && holds_list(self.tree, id, 3);
        // Such a popup whose content the app filled (a menu's panel inside
        // its list) where the terminal paints fills: that panel is the
        // popup's box, its fill its surface.
        let list_popup = list_popup && !(ground.ramp.is_some() && filled_within(self.tree, id, 4));
        // Only a one-row box of an opaque fill is looked into.
        let holds_field = !layer.field_group
            && self.tree.get(id).is_some_and(|view| {
                view.input.is_none()
                    && view.style.background_color.0 & 255 == 255
                    && view.frame.size.height <= self.cells.height()
            })
            && input_group(self.tree, id);
        // Any input group, which a line of its own may frame.
        let field_box = input_group(self.tree, id);
        // Such a group whose field has the keys shows it on its band.
        let group_focused = holds_field && focused_field_in(self.tree, id, 3);
        let rule_box = holds_rule(self.tree, id, 3);
        // A row of lines among marks (a slider's track), and anything in a
        // progress bar (its track, empty at 0): part of the control, no
        // divider of the box around it.
        let track = layer.track
            || lines_with_marks(self.tree, id)
            || self.tree.get(id).is_some_and(|view| {
                view.props.accessibility.role == AccessibilityRole::Progressbar
            });
        // An overlay's scrim (a translucent fill with no text in it that
        // the keys never reach, the app's backdrop, whatever it covers: a
        // sheet's leaves the panel out) is left out with its marks: a
        // terminal shows the page behind a modal as it is. It still takes
        // its presses.
        let scrim = self.tree.get(id).is_some_and(|view| {
            (layer.in_modal || layer.overlay || view.props.overlay_anchor.is_some())
                && view.props.pointer_events != PointerEvents::None
                && view.props.focusable != Some(true)
                && view.states & state::FOCUSED == 0
                && {
                    let own = view
                        .animated
                        .background
                        .unwrap_or(view.style.background_color);
                    (1..255).contains(&(own.0 & 255)) && !holds_text(self.tree, view)
                }
        });
        let Some(view) = self
            .tree
            .views
            .get_mut(id as usize)
            .and_then(Option::as_mut)
        else {
            return;
        };
        let opacity = opacity
            * view
                .animated
                .opacity
                .unwrap_or(view.style.opacity)
                .clamp(0.0, 1.0);
        if view.concealed || view.style.hidden || opacity < INVISIBLE_OPACITY {
            return;
        }
        let at = origin + view.frame.origin + translation(view);
        let frame = Bounds::new(at, view.frame.size);
        // A box with nothing in it shows its scale (a progress fill's
        // `scaleX`): its Cells are the scaled box's, rounded to whole ones.
        // A box with children keeps its frame, so its content stays put.
        let bounds = if view.children.is_empty() {
            CellBounds::new(scaled(view, frame), cells, area)
        } else {
            CellBounds::new(frame, cells, area)
        };
        let visible = bounds.clipped(clip);
        let cell_origin = bounds.origin(cells, area);

        let pointer = pointer && view.props.pointer_events != PointerEvents::None;
        let press = if pointer
            && view.props.pointer_events != PointerEvents::BoxNone
            && !view.props.accessibility.state.disabled
            && nsh_core::input::has_press(view.events)
        {
            Some((id, cell_origin))
        } else {
            press
        };
        if pointer && view.props.pointer_events != PointerEvents::BoxNone && !visible.is_empty() {
            self.hits.push(Hit {
                node: id,
                area: visible,
                target: press.map(|p| p.0),
                origin: press.map_or(cell_origin, |p| p.1),
                node_origin: cell_origin,
            });
        }
        let children_pointer = pointer && view.props.pointer_events != PointerEvents::BoxOnly;

        // What a terminal cannot show (an image without an image protocol,
        // a video, a web view) keeps its box blank: its fill would read as a
        // band of content.
        let blank = matches!(view.kind, ViewKind::Video | ViewKind::WebView)
            || (view.kind == ViewKind::Image && !has_images);
        // A divider's box (a menu's separator, its fill the app's line
        // color) is its line of `─` alone: a line is no band.
        let fill = if blank || rule_box || scrim {
            nsh_core::Color::TRANSPARENT
        } else {
            let color = view
                .animated
                .background
                .unwrap_or(view.style.background_color);
            // A terminal draws one color per Cell: a gradient over no
            // fill of its own fills with its first stop.
            match view.style.effects.as_deref() {
                Some(effects) if color.0 & 255 == 0 => effects
                    .background_images
                    .first()
                    .and_then(|gradient| gradient.stops.first())
                    .map_or(color, |stop| stop.color),
                _ => color,
            }
        };
        let control = control(view);
        let hidden = hidden_input(view);
        let emphasis = if control {
            stands_out(fill, ground)
        } else {
            None
        };
        let parent = ground;
        let mut ground = ground.under(fill);
        // On a terminal with surfaces a fill is a step of its ramp: raised
        // or sunken from the parent's, or an accent tinted into it.
        // The app's page color (an opaque fill over the whole screen with
        // nothing filled above it) is the terminal's background: never a
        // band, and the ground every step below it is taken from.
        let page = parent.rgb == self.page
            && parent.level == 0
            && !layer.overlay
            && fill.0 & 255 == 255
            && visible == self.screen;
        // A dot (a presence dot: a round box of a hued fill the layout
        // pins to one Cell) is `●` in its color over what is under it,
        // not a band.
        let dot = dot(view, bounds, fill);
        let filled = match parent.ramp {
            Some(_) if !page && !dot => palette::surface(fill, parent),
            _ => Surface::None,
        };
        if let Some(ramp) = parent.ramp {
            ground.level = palette::step_apart(filled, parent);
            if matches!(filled, Surface::Raised | Surface::Sunken) {
                ground.around = parent.level;
            }
            // A mark over the page (a drop preview) keeps its hue.
            let marking = view.props.overlay_anchor.is_some()
                && view.props.pointer_events == PointerEvents::None
                && fill.0 & 255 != 255;
            ground.surface = match filled {
                Surface::None => parent.surface,
                Surface::Accent(rgb) if marking => ramp.wash(rgb, parent.level, fill.0 as u8),
                Surface::Accent(rgb) if !control => {
                    ramp.tint_alpha(rgb, parent.level, fill.0 as u8)
                }
                Surface::Accent(rgb) => ramp.tint(rgb, parent.level),
                Surface::Raised | Surface::Sunken => ramp.level(ground.level),
            };
        }
        // The step a hover band rises from: the view at rest. A `hover:`
        // fill of the app's own (a wash over a tab or a tree row) already
        // lifts the view a step; the band over that as well would be two
        // steps up, the select band's, and a hovered row would look chosen.
        let hover_level = if parent.ramp.is_some()
            && !page
            && !dot
            && view.tracked & state::HOVERED != 0
            && view.states & state::HOVERED != 0
        {
            palette::step_apart(palette::surface(view.rest_fill, parent), parent)
        } else {
            ground.level
        };
        // A view in the image role is a picture, which keeps its colors:
        // its fill is its own color at the terminal's depth, not a step of
        // the ramp (a color picker's swatches and track Cells).
        // A leaf box (no children, no text: a palette's color block) of a
        // pale tint keeps its own color too: as a step of the ramp it would
        // be the same gray as every other light fill and lose its hue. Only
        // a box that holds content is a surface of the ramp.
        let pale_leaf = !page
            && !dot
            && !control
            && view.children.is_empty()
            && view.text.is_none()
            && palette::pale_tint(fill);
        let swatch = (view.props.accessibility.role == AccessibilityRole::Image || pale_leaf)
            .then(|| palette::swatch(fill, parent))
            .flatten();
        if filled != Surface::None {
            ground.swatch = false;
        }
        if let Some((rgb, color)) = swatch {
            ground.rgb = rgb;
            ground.level = parent.level;
            ground.surface = color;
            ground.swatch = true;
        }
        // The layout decides where a border is: the core sends a width
        // only for the sides it gave a Cell (a card's, a framed filled
        // cell's), none on controls, boxes of text or small boxes, so a
        // side with a width draws, on a filled surface too.
        let mut edges = edges(view, parent);
        // A one-row text field without a line or a fill of its own is a
        // raised band, as terminal search fields are; an input group (the
        // app's field box holding it with its prefix, chips, clear button
        // or chevron) is that band as a whole, the field raised with it.
        let group = parent.ramp.is_some()
            && !layer.field_group
            && view.input.is_none()
            && !page
            && bounds.bottom - bounds.top == 1
            && fill.0 & 255 == 255
            && holds_field;
        if let Some(ramp) = parent.ramp
            && (view.input.is_some() && !layer.field_group || group)
            && filled == Surface::None
            && !edges.any()
            && !hidden
        {
            ground.level = Ramp::above(parent.level, palette::RAISED);
            ground.surface = ramp.level(ground.level);
        }
        // A field the keys go to (or the group holding it) is its band a
        // step brighter with the accent mixed in, its focus mark in the
        // focus's hue: no line under it, no ring. One
        // with a line of its own (no band: a face is a line or a fill)
        // brightens its line instead.
        let field_focused = match view.input {
            Some(_) => {
                !layer.field_group
                    && (view.states | view.projected) & state::FOCUSED != 0
                    && !view.props.accessibility.state.disabled
            }
            None => group && group_focused,
        };
        if let Some(ramp) = parent.ramp
            && field_focused
            && !edges.any()
            && !hidden
        {
            let level = ground.level;
            ground.level = Ramp::above(level, level + 1);
            ground.surface = ramp.focus_band(level);
        }
        let [top, right, bottom, left] = edges.widths.map(i32::from);
        let inner = CellBounds {
            left: bounds.left + left,
            top: bounds.top + top,
            right: (bounds.right - right).max(bounds.left + left),
            bottom: (bounds.bottom - bottom).max(bounds.top + top),
        };
        let text_bounds = view.text.as_ref().map(|(_, content)| {
            CellBounds::new(Bounds::new(at + content.origin, content.size), cells, area)
                .fitted(inner)
        });
        let scroll_origin = view
            .scroll
            .as_ref()
            .map_or_else(Point::default, |scroll| scroll.origin());
        self.geometry.push(Geometry {
            id,
            bounds,
            visible,
            frame: Bounds::new(cell_origin, frame.size),
            text_frame: text_bounds.map(|text| text.points(cells, area)),
            scroll_origin,
        });
        // A text's links that are stops of Tab stand after it, each where
        // its characters are drawn.
        if let (Some(content), Some((layout, _)), Some(text_bounds)) =
            (&view.text_content, &view.text, text_bounds)
            && !view.props.accessibility.state.disabled
            && let Some(layout) = layout.downcast::<CellLayout>()
            && content.links.iter().any(|link| link.focus_stop)
        {
            let text_frame = text_bounds.points(cells, area);
            let mut links: Vec<_> = content.links.iter().filter(|l| l.focus_stop).collect();
            // In text order, a link inside another after the one around it.
            links.sort_by_key(|l| (l.start, std::cmp::Reverse(l.end)));
            for (index, link) in links.into_iter().enumerate() {
                let Some(frame) = layout
                    .glyphs
                    .iter()
                    .filter(|(_, range)| range.start < link.end && link.start < range.end)
                    .map(|(bounds, _)| *bounds)
                    .reduce(|a, b| a.union(&b))
                else {
                    continue;
                };
                let frame = Bounds::new(text_frame.origin + frame.origin, frame.size);
                let link_bounds = CellBounds::new(frame, cells, area).fitted(text_bounds);
                self.geometry.push(Geometry {
                    id: link.node,
                    bounds: link_bounds,
                    visible: link_bounds.clipped(visible),
                    frame,
                    text_frame: None,
                    scroll_origin: Point::default(),
                });
                self.spans.insert(
                    link.node,
                    crate::keyboard::Span {
                        view: id,
                        index,
                        events: link.events,
                        range: link.start..link.end,
                    },
                );
            }
        }
        let inner_visible = inner.clipped(clip);
        // A view that clips, scrolls or stands framed holds its children
        // inside its content box; otherwise a child placed outside it (a
        // badge, an absolute label below a row) shows, as in CSS. Every
        // view's own text stays inside its own frame either way.
        let holds = view.style.overflow_hidden
            || edges.any()
            || filled != Surface::None
            || matches!(
                view.kind,
                ViewKind::Scroll | ViewKind::Stack | ViewKind::Screen | ViewKind::Modal
            );
        let children_clip = if holds { inner_visible } else { clip };
        let radii = view.style.radii().fit(frame.size);

        // An overlay's boxes stand on their own over what is behind them.
        let mut layer = layer;
        // An overlay the pointer passes through with no opaque fill (a
        // dock's drop preview) marks what is under it: lines, and the band
        // of its translucent fill, over the page, which stays whole under
        // it (its text still reads) and beside it; its lines keep the
        // app's colors.
        let marks = view.props.overlay_anchor.is_some()
            && view.props.pointer_events == PointerEvents::None
            && fill.0 & 255 != 255
            && visible.width > 0
            && visible.height > 0
            && (edges.any() || fill.0 & 255 != 0);
        if (view.props.overlay_anchor.is_some() || view.kind == ViewKind::Modal) && !marks {
            layer.overlay = true;
            layer.modal = view.kind == ViewKind::Modal;
            layer.boxed = false;
            // A label the overlay already shows as its text (a toast's,
            // made of its lines) is no title: the frame would repeat it.
            layer.title = view
                .props
                .accessibility
                .label
                .clone()
                .filter(|_| !label_shown);
        }
        // An anchored list is a surface in a terminal whether or not the
        // app filled it (`nsh-base`'s lists carry no look of their own): a
        // list over the page without a frame does not read as one.
        let surface = edges.any() || fill.0 & 255 == 255 || filled != Surface::None || list_popup;
        // Without surfaces (16 colors, or a background the terminal does
        // not tell) a small box the layout made a surface (a fill, no line,
        // under `CONTAINER_ROWS`: a chip, a tag, a filled button) still
        // shows its edge: its fill in the standard colors
        // (`palette::bandless_fill`), or reversed without colors. A panel
        // or card stays unfilled, set apart by its space: one gray across a
        // sidebar would put each muted label on a patch of its own. An
        // overlay's own box is its frame instead, and a field keeps its
        // underline. A swatch is its color at any size.
        let small = bounds.bottom - bounds.top < i32::from(CONTAINER_ROWS);
        let bandless = parent.ramp.is_none()
            && (small || swatch.is_some())
            && !page
            && !dot
            && !hidden
            && view.input.is_none()
            && !edges.any()
            && !(layer.overlay && !layer.boxed);
        let bandless_fill = bandless
            .then(|| palette::bandless_fill(fill, parent))
            .flatten();
        let bandless_reversed = bandless
            && small
            && parent.depth == crate::ColorDepth::Monochrome
            && palette::surface(fill, parent) != Surface::None;
        let mut framed = None;
        // The line a frame drawn around the box puts on its right: the
        // Cell after its last column.
        let mut around_line = None;
        let mut frame_look = None;
        // Where the overlay's title is: an accent chip while the focus is
        // inside. A terminal draws no shadow under a popup.
        let mut title_at = None;
        // An overlay box clears what is behind it up to and with its
        // lines: its frame is the box's edge, on its own ground, never on
        // the page's colors under it.
        // A status line (the overlay `nsh/base`'s status line marks as
        // the app's summary) is one row of text on its ground: no frame
        // around it and nothing of the rows above it cut.
        let docked = layer.overlay
            && !layer.boxed
            && view.props.accessibility.role == AccessibilityRole::Summary;
        if layer.overlay && surface && !visible.is_empty() {
            dialog::clear(self.buffer, visible);
            // A word behind it that the box cuts at its sides (or the
            // frame drawn a Cell around it) is left out whole: no half of
            // it is glued to the frame. A longer run (a URL, a path) would
            // leave nothing of itself: it keeps what shows, ending in `…`
            // by the frame. Only the overlay's outer box meets the page:
            // a surface inside it (a tooltip's avatar chip) stands on the
            // overlay's own content, which it never cuts.
            let outer = !layer.boxed;
            let area = self.buffer.area;
            let (left, right) = (i32::from(visible.x), i32::from(visible.right()));
            // A frame drawn around the box takes the rows above and below
            // it; a box with lines of its own meets the page at its rows.
            let around = u16::from(!edges.any() && !docked);
            let rows = visible.y.saturating_sub(around)
                ..visible.bottom().saturating_add(around).min(area.bottom());
            // A line drawn in glyphs (a rule, a split's `─`) is no word:
            // the box covers it where it lies and leaves the rest whole.
            let word = |buffer: &Buffer, text_cells: &[bool], column: i32, y: u16| {
                column >= i32::from(area.x) && column < i32::from(area.right()) && {
                    let at = buffer.index_of(column as u16, y);
                    let symbol = buffer.content[at].symbol();
                    text_cells[at]
                        && symbol.chars().any(|c| !c.is_whitespace())
                        && !symbol
                            .chars()
                            .all(|c| ('\u{2500}'..='\u{259f}').contains(&c))
                }
            };
            for y in rows.filter(|_| outer) {
                // The frame's Cell, else the one beyond it (a word touching
                // the frame).
                for (frame, step) in [(left - 1, -1), (right, 1)] {
                    let start = match word(self.buffer, &self.text_cells, frame, y) {
                        true => frame,
                        false => frame + step,
                    };
                    let mut end = start;
                    while word(self.buffer, &self.text_cells, end, y) {
                        end += step;
                    }
                    let length = (end - start).unsigned_abs();
                    if length > CUT_WORD_CELLS {
                        if start == frame {
                            let at = self.buffer.index_of(frame as u16, y);
                            self.buffer.content[at].set_symbol(" ");
                            self.text_cells[at] = false;
                        }
                        let next = (frame + step) as u16;
                        let at = self.buffer.index_of(next, y);
                        self.buffer.content[at].set_symbol("…");
                        continue;
                    }
                    let mut column = start;
                    while column != end {
                        let at = self.buffer.index_of(column as u16, y);
                        self.buffer.content[at].set_symbol(" ");
                        self.text_cells[at] = false;
                        column += step;
                    }
                    // A fill the box cuts (a badge, a chip: one row of a
                    // band of its own, short, ending in another ground)
                    // goes whole with its words: no sliver of it by the
                    // frame. A taller band (a panel's) goes on past it.
                    let inside = |column: i32| {
                        column >= i32::from(area.x) && column < i32::from(area.right())
                    };
                    if around == 0 || !inside(frame) {
                        continue;
                    }
                    let band = self.buffer[(frame as u16, y)].bg;
                    let first = frame + step;
                    let mut column = first;
                    while inside(column) && self.buffer[(column as u16, y)].bg == band {
                        column += step;
                    }
                    let run = (column - first).unsigned_abs();
                    let ground = match inside(column) {
                        true => self.buffer[(column as u16, y)].bg,
                        false => Color::Reset,
                    };
                    let row_of_its_own = inside(first)
                        && [y.checked_sub(1), y.checked_add(1)].into_iter().all(|row| {
                            row.filter(|&row| row >= area.y && row < area.bottom())
                                .is_none_or(|row| self.buffer[(first as u16, row)].bg != band)
                        });
                    if band != Color::Reset
                        && row_of_its_own
                        && run > 0
                        && run <= CUT_WORD_CELLS
                        && ground != band
                    {
                        let mut column_at = first;
                        while column_at != column {
                            let at = self.buffer.index_of(column_at as u16, y);
                            let cell = &mut self.buffer.content[at];
                            cell.set_symbol(" ");
                            cell.bg = ground;
                            self.text_cells[at] = false;
                            column_at += step;
                        }
                    }
                }
            }
            // What was behind holds no text any more, under the box or its
            // frame a Cell around it: text drawn next to it is not cut
            // short by it (no `…` on the frame).
            let ring = Rect::new(
                visible.x.saturating_sub(around),
                visible.y.saturating_sub(around),
                visible.width + 2 * around,
                visible.height + 2 * around,
            )
            .intersection(if outer { area } else { Rect::default() });
            for y in ring.y..ring.bottom() {
                for x in ring.x..ring.right() {
                    let at = self.buffer.index_of(x, y);
                    self.text_cells[at] = false;
                }
            }
            if !layer.boxed {
                layer.boxed = true;
                // An overlay's box (a modal's, an anchored popup's) is its
                // line alone, whatever the app filled it with: a box is its
                // line or its fill, and in a terminal a popup is a frame
                // over the page's background (ratatui's `Clear` and
                // `Block`), the same at every depth.
                if let Some(ramp) = parent.ramp {
                    ground.level = 0;
                    ground.surface = ramp.level(0);
                    frame_look = Some((ramp.border(), ground.surface));
                    if !layer.modal {
                        self.popup = true;
                    }
                }
                let title = view
                    .props
                    .accessibility
                    .label
                    .clone()
                    .filter(|_| !label_shown)
                    .or_else(|| layer.title.take())
                    .unwrap_or_default();
                if edges.any() {
                    framed = (!docked).then_some(title);
                } else if !docked {
                    title_at = frame_around(self.buffer, visible, clip, &title, frame_look);
                    let line = Rect {
                        width: visible.width + 1,
                        ..visible
                    };
                    around_line = Some((bounds.right, line.intersection(clip)));
                }
            }
        }

        if !visible.is_empty() {
            // An opaque fill covers what was drawn under it before: a card
            // over a canvas's dots shows the card, not the dots through it.
            if fill.0 & 255 == 255 && !page && !dot {
                clear_symbols(self.buffer, visible);
                for y in visible.y..visible.bottom() {
                    for x in visible.x..visible.right() {
                        let at = self.buffer.index_of(x, y);
                        self.text_cells[at] = false;
                    }
                }
            }
            if parent.ramp.is_some() && ground.surface != parent.surface {
                self::fill(self.buffer, visible, ground.surface);
            }
            if let Some(color) = bandless_fill {
                self::fill(self.buffer, visible, color);
            }
            if let Some(centre) = gradient(self.buffer, view, bounds, visible, cells, parent) {
                ground.rgb = centre;
                ground.surface = palette::convert(centre, parent.depth);
                ground.swatch = true;
            }
            if let Some((line, _)) = frame_look {
                edges.colors = [(line, Modifier::empty()); 4];
            }
            lines(self.buffer, bounds, visible, &edges, radii);
            // A lone line across (a search field's rule under it, a
            // footer's over it) is a divider: its ends join the lines they
            // reach (`├───┤` in a popup's frame).
            let row = match edges.sides {
                [true, false, false, false] => Some(bounds.top),
                [false, false, true, false] => Some(bounds.bottom - 1),
                _ => None,
            };
            if let Some(y) = row.and_then(|y| u16::try_from(y).ok())
                && (visible.y..visible.bottom()).contains(&y)
                && !visible.is_empty()
            {
                let inside = |x: i32| {
                    layer.frame.or(layer.parent).is_none_or(|frame| {
                        (i32::from(frame.x)..i32::from(frame.right())).contains(&x)
                    })
                };
                if inside(i32::from(visible.x) - 1) {
                    self.dividers.push((visible.x, y, false, layer.overlay));
                }
                if inside(i32::from(visible.right())) {
                    self.dividers
                        .push((visible.right() - 1, y, false, layer.overlay));
                }
            }
            // Where the terminal has surfaces the title is set off by the
            // line on both sides: `╭─ Title ─`.
            let offset = 1 + u16::from(frame_look.is_some());
            if let Some(title) = framed.filter(|title| !title.is_empty())
                && edges.sides[0]
                && visible.y == u16::try_from(bounds.top).unwrap_or(u16::MAX)
                && visible.width > 4 + 2 * offset
            {
                let drawn = dialog::put(
                    self.buffer,
                    visible.x + offset,
                    visible.y,
                    &format!(" {title} "),
                    visible.width - 2 * offset,
                    Color::Reset,
                    Modifier::BOLD,
                );
                title_at = Some(Rect::new(visible.x + offset, visible.y, drawn, 1));
            }
            if dot {
                let cell = &mut self.buffer[(visible.x, visible.y)];
                cell.set_symbol("●");
                cell.fg = palette::ink(fill, parent).fg.unwrap_or(Color::Reset);
            }
            if let Some((layout, _)) = &view.text
                && let Some(layout) = layout.downcast::<CellLayout>()
                && let Some(text_bounds) = text_bounds
            {
                let place = TextPlace {
                    layout,
                    bounds: text_bounds,
                    visible,
                    viewport: layer.viewport,
                    focused: focused_span
                        .and_then(|span| self.spans.get(&span))
                        .filter(|span| span.view == id)
                        .map(|span| span.range.clone()),
                };
                let rule = rule_axis(layout, view, ground, layer.handle || layer.rule)
                    .filter(|_| !layer.track);
                let cells = TextCells {
                    text: &mut self.text_cells,
                    links: &mut self.links,
                    link: self.link.as_ref(),
                };
                text(self.buffer, cells, place, view, ground);
                if let Some(down) = rule {
                    let drawn = text_bounds.clipped(visible);
                    let glyph = if down { "│" } else { "─" };
                    for y in drawn.y..drawn.bottom() {
                        for x in drawn.x..drawn.right() {
                            let cell = &mut self.buffer[(x, y)];
                            if cell.symbol() != glyph {
                                continue;
                            }
                            // A divider is a line of the box it splits: in
                            // the frame's color, whatever tone it was given.
                            // On a surface raised far (a band's step) the
                            // frame's step is near the surface's own:
                            // there the line is a popup's brighter one.
                            if let Some(ramp) = ground.ramp {
                                cell.fg = if ground.level >= palette::SELECT {
                                    ramp.popover_line()
                                } else {
                                    ramp.border()
                                };
                                cell.modifier = Modifier::empty();
                            }
                            self.dividers.push((x, y, down, layer.overlay));
                        }
                    }
                }
            }
            if let (Some(field), Some(config)) = (&mut view.field, &view.input)
                && !hidden
            {
                let content = CellBounds::new(
                    Bounds::new(at + field.content.origin, field.content.size),
                    cells,
                    area,
                )
                .fitted(inner);
                field.draw(
                    config,
                    content,
                    inner_visible,
                    self.buffer,
                    view.animated.color,
                    ground,
                );
            }
            if let Some(mount) = &view.image
                && !inner_visible.is_empty()
                && let Some(candidate) = self.images.draw_halfblocks(
                    id,
                    mount,
                    &view.style,
                    view.animated.background,
                    view.animated.opacity,
                    frame.size,
                    inner,
                    inner_visible,
                    self.hits.len(),
                    ground.depth,
                    self.buffer,
                )
            {
                self.sixels.push(candidate);
            }
            if let Some(canvas) = &view.canvas
                && !inner_visible.is_empty()
            {
                crate::canvas::draw(
                    canvas,
                    self.buffer,
                    &self.text_cells,
                    bounds,
                    inner_visible,
                    cells,
                    ground,
                    &mut self.hues,
                );
            }
            if let Some(component) = &mut view.component {
                component.render(inner_visible, self.buffer);
            }
            if control && let Some(label) = &icon {
                let (x, y) = (inner_visible.x, inner_visible.y);
                let room = (inner.right - inner.left).max(0);
                // An icon-only popup trigger (a split button's chevron, a
                // menu's) shows which way its popup opens, set apart from
                // a label beside it, and an icon-only disclosure whether
                // it is open; its name stays its accessible name.
                let state = view.props.accessibility.state;
                let arrow = state.expanded.is_some();
                let label = match (state.expanded, state.has_popup) {
                    (Some(true), true) => "▴",
                    (Some(false), true) | (Some(true), false) => "▾",
                    (Some(false), false) => "▸",
                    (None, _) => label.as_str(),
                };
                // A label of a name and its detail (`Photo 1: Front`) too
                // wide for its box (a thumbnail) shows its name.
                let label = match label.split_once(": ") {
                    Some((name, _))
                        if unicode_width::UnicodeWidthStr::width(label) > room as usize =>
                    {
                        name
                    }
                    _ => label,
                };
                if i32::from(x) == inner.left && i32::from(y) == inner.top {
                    // An arrow stands in the middle of its box: a trigger
                    // padded each side (a split button's) keeps it off
                    // the edge beside the main action.
                    let x = if arrow {
                        let width = unicode_width::UnicodeWidthStr::width(label) as i32;
                        let shift = ((room - width) / 2).max(0);
                        x + shift.min(i32::from(inner_visible.width) - 1).max(0) as u16
                    } else {
                        x
                    };
                    let drawn = dialog::put(
                        self.buffer,
                        x,
                        y,
                        label,
                        inner_visible.right() - x,
                        Color::Reset,
                        Modifier::empty(),
                    );
                    // A row short of room shrinks an icon button below its
                    // label: the label is cut, its last Cell `…`.
                    if drawn > 0 && unicode_width::UnicodeWidthStr::width(label) > room as usize {
                        self.buffer[(x + drawn - 1, y)].set_symbol("…");
                    }
                    let width = usize::from(self.buffer.area.width);
                    let start = usize::from(y) * width + usize::from(x);
                    for cell in &mut self.text_cells[start..start + usize::from(drawn)] {
                        *cell = true;
                    }
                }
            }
        }

        let sticky: Vec<(NodeId, Point<Points>)> = view
            .scroll
            .as_ref()
            .filter(|scroll| !scroll.sticky.is_empty())
            .map(|scroll| scroll.sticky_shifts().collect())
            .unwrap_or_default();
        let content_origin = at - scroll_origin;
        let outer_focus = std::mem::take(&mut self.focus);
        let own_disabled =
            view.props.accessibility.state.disabled || view.states & state::DISABLED != 0;
        let mut child_layer = layer.clone();
        child_layer.disabled |= own_disabled;
        if view.kind == ViewKind::Scroll {
            child_layer.viewport = Some(children_clip);
        }
        if self.pane == Some(id) {
            child_layer.pane = true;
        }
        // A box inside a framed one that runs to its line (or to the
        // padding Cell before it) passes the line on: a scroll view deep
        // in a framed popup still reaches it.
        child_layer.right_line = if edges.sides[1] {
            Some((inner.right, visible))
        } else if around_line.is_some() {
            around_line
        } else {
            layer
                .right_line
                .filter(|&(right, _)| (0..=LINE_GAP).contains(&(right - bounds.right)))
        };
        child_layer.field_group |= group;
        child_layer.lined_group |= edges.any() && bounds.bottom - bounds.top >= 3 && field_box;
        child_layer.handle |= view.props.accessibility.role == AccessibilityRole::Adjustable;
        child_layer.rule |= rule_box;
        child_layer.track = track;
        child_layer.parent = Some(visible);
        if edges.any() {
            child_layer.frame = Some(visible);
        } else if around_line.is_some() {
            child_layer.frame = Some(Rect {
                x: visible.x.saturating_sub(1),
                y: visible.y.saturating_sub(1),
                width: visible.width + 2,
                height: visible.height + 2,
            });
        }
        let mut index = 0;
        while let Some(child) = self
            .tree
            .get(id)
            .and_then(|view| view.children.get(index).copied())
        {
            index += 1;
            if self
                .tree
                .get(child)
                .is_some_and(|view| view.kind == ViewKind::Modal)
            {
                continue;
            }
            // An anchored overlay stands over everything, wherever its
            // owner is.
            let child_clip = if self
                .tree
                .get(child)
                .is_some_and(|view| view.props.overlay_anchor.is_some())
            {
                self.screen
            } else {
                children_clip
            };
            let shift = sticky
                .iter()
                .find(|(cell, _)| *cell == child)
                .map_or_else(Point::default, |(_, shift)| *shift);
            self.view(
                child,
                content_origin + shift,
                child_clip,
                opacity,
                ground,
                child_layer.clone(),
                children_pointer,
                press,
            );
        }

        let Some(view) = self.tree.get(id) else {
            return;
        };
        // A scroll view filling its framed box's content up to its right
        // line (or the padding Cell before it) draws its vertical bar on
        // that line, taking no column of its own.
        let on_line = view
            .scroll
            .as_ref()
            .filter(|scroll| !scroll.horizontal && !edges.sides[1])
            .and(layer.right_line)
            .filter(|&(right, _)| (0..=LINE_GAP).contains(&(right - bounds.right)));
        let (bar_inner, bar_clip) = match on_line {
            Some((right, parent)) => {
                let widened = Rect {
                    width: if inner_visible.is_empty() {
                        0
                    } else {
                        u16::try_from(right + 1 - i32::from(inner_visible.x)).unwrap_or(0)
                    },
                    ..inner_visible
                };
                (
                    CellBounds {
                        right: right + 1,
                        ..inner
                    },
                    widened.intersection(parent),
                )
            }
            None => (inner, inner_visible),
        };
        if let Some(scroll) = &view.scroll
            && let Some(bar) =
                crate::scrollbar::bar(id, scroll, view.frame.size, bar_inner, bar_clip)
            && (on_line.is_some() || !covers_content(self.buffer, bar.track))
        {
            scroll_bar(
                self.buffer,
                bar,
                ground.ramp,
                view.states & state::FOCUSED != 0,
            );
            self.bars.push(bar);
        }
        // At 16 colors or none, a small box of a tone (a price tag, a
        // meter's filled segment) is drawn as a progress bar's fill is,
        // reversed in its color: left out with the other fills, it would
        // vanish, and its text in the fill's contrast color with it. Text
        // of a hue of its own reads without the fill, and keeps its color.
        let mut toned = false;
        let hued_text = || {
            (visible.y..visible.bottom()).any(|y| {
                (visible.x..visible.right()).any(|x| {
                    let cell = &self.buffer[(x, y)];
                    cell.symbol() != " " && palette::standard_hue(cell.fg)
                })
            })
        };
        if parent.ramp.is_none()
            && matches!(
                parent.depth,
                crate::ColorDepth::Ansi16 | crate::ColorDepth::Monochrome
            )
            && !page
            && !dot
            && !control
            && !layer.disabled
            && bounds.bottom - bounds.top < i32::from(CONTAINER_ROWS)
            && let Some(color) = palette::tone_fill(fill, parent.depth)
            && !hued_text()
        {
            toned = true;
            for y in visible.y..visible.bottom() {
                for x in visible.x..visible.right() {
                    let cell = &mut self.buffer[(x, y)];
                    cell.modifier = (cell.modifier | Modifier::REVERSED) - Modifier::DIM;
                    cell.fg = color;
                    cell.bg = Color::Reset;
                }
            }
        }
        let popup_item = layer.overlay && !layer.modal;
        // Content of a disabled view drawn outside its frame is disabled too.
        if layer.disabled && !visible.is_empty() {
            match ground.ramp {
                Some(ramp) => drawn(self.buffer, visible, |cell| {
                    cell.fg = ramp.disabled(cell.fg);
                    cell.modifier -= Modifier::BOLD;
                }),
                None => {
                    for y in visible.y..visible.bottom() {
                        for x in visible.x..visible.right() {
                            let cell = &mut self.buffer[(x, y)];
                            if cell.symbol() != " " {
                                cell.modifier = (cell.modifier | Modifier::DIM) - Modifier::BOLD;
                            }
                        }
                    }
                }
            }
        }
        // A disclosure (it expands in place, no popup) says which way it
        // goes before its label, as the terminal's own disclosures do.
        if let Some(open) = disclosure(view)
            && !inner_visible.is_empty()
        {
            let focused = view.states & state::FOCUSED != 0;
            let look = match (focused, ground.ramp) {
                (true, _) => (ACCENT, Modifier::empty()),
                (false, Some(ramp)) => (ramp.muted(), Modifier::empty()),
                (false, None) => (Color::Reset, Modifier::DIM),
            };
            mark_disclosure(self.buffer, inner_visible, open, look);
        }
        if !visible.is_empty() && !hidden && !scrim {
            let marks = Marks {
                bands: self.bands,
                emphasis,
                mono: ground.depth == crate::ColorDepth::Monochrome,
                few: matches!(
                    ground.depth,
                    crate::ColorDepth::Ansi16 | crate::ColorDepth::Monochrome
                ),
                popup: popup_item,
                lined_group: layer.lined_group,
            };
            match ground.ramp {
                Some(ramp) => mark_surface(
                    self.buffer,
                    view,
                    bounds,
                    visible,
                    inner_visible,
                    &edges,
                    emphasis,
                    (ramp, ground.level, ground.surface),
                    hover_level,
                    popup_item,
                    layer.modal,
                    layer.pane,
                ),
                None => mark_state(
                    self.buffer,
                    view,
                    bounds,
                    visible,
                    inner_visible,
                    &edges,
                    marks,
                ),
            }
        }
        // A bandless surface's content reads on its fill: a glyph in the
        // fill's own color (a muted text's gray, a primary button's
        // accent label) takes the default foreground, not dim. Without
        // colors a small one is reversed.
        if let Some(color) = bandless_fill {
            for y in visible.y..visible.bottom() {
                for x in visible.x..visible.right() {
                    let cell = &mut self.buffer[(x, y)];
                    if cell.bg != color {
                        continue;
                    }
                    if cell.fg == color {
                        cell.fg = Color::Reset;
                        cell.modifier -= Modifier::DIM;
                    }
                }
            }
        } else if bandless_reversed && !toned {
            // A box of text (a chip, a button's label), with nothing in it
            // already shown reversed (a tone's segment, a focused row):
            // a track of no glyphs keeps its marks as they are.
            let cells = || {
                (visible.y..visible.bottom())
                    .flat_map(move |y| (visible.x..visible.right()).map(move |x| (x, y)))
            };
            let text = cells().any(|at| self.buffer[at].symbol().trim() != "");
            let marked = cells().any(|at| self.buffer[at].modifier.contains(Modifier::REVERSED));
            if text && !marked {
                for at in cells() {
                    let cell = &mut self.buffer[at];
                    cell.modifier = (cell.modifier | Modifier::REVERSED) - Modifier::DIM;
                }
            }
        }
        // The innermost box with a line around the focus holds it (only a
        // popup's while one is open): its line keeps its color, the accent
        // being the focused stop's own (a code's cell, a framed field), and
        // a focused overlay's title is an accent chip.
        if let Some(ramp) = ground.ramp {
            if self.focus == Focus::Within
                && edges.any()
                && (!self.popup || layer.overlay)
                && !visible.is_empty()
                && has_line(self.buffer, bounds, visible, &edges)
            {
                // A pane (a box of a list, a scroll or a selection, as
                // lazygit's) lights its line: the keys go to its rows. A
                // card around buttons or a menu bar keeps its line.
                if self.pane == Some(id) && holds_rows(self.tree, id) {
                    recolor_border(self.buffer, bounds, visible, &edges, ACCENT);
                }
                self.focus = Focus::Shown;
            }
            let chip = self.focus != Focus::None && title_at.is_some();
            if frame_look.is_some() && self.focus == Focus::Within {
                // An overlay's own frame holds the focus: nothing outside
                // it shows it.
                self.focus = Focus::Shown;
            }
            if chip && let Some(title) = title_at {
                for x in title.x..title.right() {
                    let cell = &mut self.buffer[(x, title.y)];
                    cell.bg = ACCENT;
                    cell.fg = ramp.base();
                }
            }
        }
        if self.focus == Focus::None && view.states & state::FOCUSED != 0 {
            self.focus = Focus::Within;
        }
        self.focus = self.focus.max(outer_focus);
    }
}

/// The innermost view with a border line around the focused view (or the
/// overlay holding it): the pane the keys go to.
/// Whether every word of `label` is in the text drawn under `id`: an
/// overlay's label that only gathers its lines for a screen reader.
fn shown(tree: &Mounter, id: NodeId, label: &str) -> bool {
    fn gather(tree: &Mounter, id: NodeId, into: &mut String, depth: usize) {
        let Some(view) = tree.get(id) else { return };
        if let Some(content) = &view.text_content {
            into.push_str(&content.text);
            into.push(' ');
        }
        if depth < 32 {
            for &child in &view.children {
                gather(tree, child, into, depth + 1);
            }
        }
    }
    let mut drawn = String::new();
    gather(tree, id, &mut drawn, 0);
    let words: Vec<&str> = drawn.split_whitespace().collect();
    let mut label_words = label
        .split(|c: char| c.is_whitespace())
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()))
        .filter(|w| !w.is_empty())
        .peekable();
    label_words.peek().is_some()
        && label_words.all(|word| {
            words
                .iter()
                .any(|drawn| drawn.trim_matches(|c: char| !c.is_alphanumeric()) == word)
        })
}

/// Whether `c` is a braille pattern: a canvas's or a chart's dots.
fn is_braille(c: char) -> bool {
    ('\u{2800}'..='\u{28FF}').contains(&c)
}

fn focus_pane(tree: &Mounter) -> Option<NodeId> {
    let focused = tree.views.iter().position(|view| {
        view.as_ref()
            .is_some_and(|view| view.states & state::FOCUSED != 0)
    })?;
    let mut at = tree.get(focused as NodeId)?.parent;
    while let Some(id) = at {
        let view = tree.get(id)?;
        let lined = view
            .style
            .borders
            .widths
            .to_array()
            .iter()
            .any(|&w| w > Points::ZERO);
        if lined || view.props.overlay_anchor.is_some() || view.kind == ViewKind::Modal {
            return Some(id);
        }
        at = view.parent;
    }
    None
}

/// Whether the box `pane` holds rows the keys move through: a scroll view
/// (a list) or a selected item, in its own content (not inside a framed
/// box within it, a pane of its own).
fn holds_rows(tree: &Mounter, pane: NodeId) -> bool {
    let mut stack: Vec<NodeId> = tree
        .get(pane)
        .map_or_else(Vec::new, |view| view.children.clone());
    while let Some(id) = stack.pop() {
        let Some(view) = tree.get(id) else {
            continue;
        };
        if view.kind == ViewKind::Scroll || view.props.accessibility.state.selected {
            return true;
        }
        let lined = view
            .style
            .borders
            .widths
            .to_array()
            .iter()
            .any(|&w| w > Points::ZERO);
        if !lined {
            stack.extend(view.children.iter().copied());
        }
    }
    false
}

/// Whether `view` is a dot: laid out in one Cell, round, filled and
/// holding no text (a presence dot, a status dot, a toggle's dot that is
/// off). The layout keeps a neutral dot only where it reads apart from
/// its backdrop (a gray key before its label), so it is a `●` in its gray
/// as a hued one is in its color, never a band Cell.
fn dot(view: &NshView, bounds: CellBounds, fill: nsh_core::Color) -> bool {
    let size = view.frame.size;
    let radii = view.style.radii().fit(size);
    let half = size.width.min(size.height) * 0.5;
    bounds.right - bounds.left == 1
        && bounds.bottom - bounds.top == 1
        && view.text.is_none()
        && view.children.is_empty()
        && fill.0 & 255 > 8
        && half > Points::ZERO
        && radii.to_array().iter().all(|&r| r >= half * ROUND_SHARE)
}

/// How much of a one-Cell view's half side its corners' radii take for it
/// to be round: its frame is the Cell (8 by 16 points), so a 6pt dot's 3pt
/// radius is three quarters of the Cell's half width, a box's small
/// corners (2pt) half of it.
const ROUND_SHARE: f32 = 0.74;

/// The accent the focus shows in: a box's line around it, an overlay's
/// title, a popup's highlighted item.
/// The widest word an overlay leaves out whole where it cuts it, in
/// Cells: a longer run (a URL, a path) keeps the part that shows, ending
/// in `…` by the overlay.
const CUT_WORD_CELLS: u32 = 12;

/// The accent of what the keys act on: the terminal palette's blue.
pub(crate) const ACCENT: Color = Color::Blue;

/// What a focused swatch shows in its middle (a chosen one shows `✓`).
const FOCUS_MARK: &str = "◆";

/// Where the focus is, as the views around it are marked (their children
/// first): nowhere in the subtree, inside it with no box showing it yet,
/// or shown by an inner box's line.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
enum Focus {
    #[default]
    None,
    Within,
    Shown,
}

/// The label an icon button shows: its accessibility label, trimmed, when
/// all its content is left out (every child laid out empty or hidden), as
/// the layout then gives it a row as wide as that label.
fn icon_label<'a>(tree: &Mounter, view: &'a NshView, has_images: bool) -> Option<&'a str> {
    if view.text.is_some()
        || view.field.is_some()
        || view.canvas.is_some()
        || (has_images
            && view
                .image
                .as_ref()
                .and_then(|m| m.source.as_ref())
                .is_some_and(|s| !s.uri.is_empty()))
    {
        return None;
    }
    let label = view.props.accessibility.label.as_deref()?.trim();
    let empty = !view
        .children
        .iter()
        .any(|&child| draws(tree, child, has_images));
    (empty && !label.is_empty()).then_some(label)
}

/// Whether `id` or a view inside it draws anything of its own in the
/// terminal: a text, a field, a canvas, a native component or a fill (a
/// carousel's pagination bar); a wrapper of an icon the terminal leaves
/// out draws nothing, and so does a picture without an image protocol.
fn draws(tree: &Mounter, id: NodeId, has_images: bool) -> bool {
    tree.get(id).is_some_and(|view| {
        view.frame.size.width > Points::ZERO
            && view.frame.size.height > Points::ZERO
            && (view.text.is_some()
                || view.field.is_some()
                || view.canvas.is_some()
                || view.component.is_some()
                || (has_images
                    && view
                        .image
                        .as_ref()
                        .and_then(|m| m.source.as_ref())
                        .is_some_and(|s| !s.uri.is_empty()))
                || (!matches!(
                    view.kind,
                    ViewKind::Image | ViewKind::Video | ViewKind::WebView
                ) && !view
                    .animated
                    .background
                    .unwrap_or(view.style.background_color)
                    .is_transparent())
                || view
                    .children
                    .iter()
                    .any(|&child| draws(tree, child, has_images)))
    })
}

/// Whether `view` or a view inside it shows a text, a field or a canvas:
/// a translucent box around one is a band of content, not a scrim.
fn holds_text(tree: &Mounter, view: &NshView) -> bool {
    view.text.is_some()
        || view.field.is_some()
        || view.canvas.is_some()
        || view
            .children
            .iter()
            .any(|&child| tree.get(child).is_some_and(|child| holds_text(tree, child)))
}

/// The view's translation, which moves it by whole Cells; scales and
/// rotations are left out (glyphs stay on the grid).
fn translation(view: &NshView) -> Point<Points> {
    let mut offset = Point::default();
    for (index, step) in view.style.transform.ops().iter().enumerate() {
        let value = view
            .animated
            .transform
            .get(index)
            .copied()
            .flatten()
            .unwrap_or(step.value);
        match step.kind {
            TransformKind::TranslateX => offset.x += Points(value),
            TransformKind::TranslateY => offset.y += Points(value),
            _ => {}
        }
    }
    offset
}

/// `frame` scaled by the view's `scale` / `scaleX` / `scaleY` around its
/// transform origin; other steps of its transform are left out.
fn scaled(view: &NshView, frame: Bounds<Points>) -> Bounds<Points> {
    let (mut sx, mut sy) = (1.0f32, 1.0f32);
    for (index, step) in view.style.transform.ops().iter().enumerate() {
        let value = view
            .animated
            .transform
            .get(index)
            .copied()
            .flatten()
            .unwrap_or(step.value);
        match step.kind {
            TransformKind::Scale => {
                sx *= value;
                sy *= value;
            }
            TransformKind::ScaleX => sx *= value,
            TransformKind::ScaleY => sy *= value,
            _ => {}
        }
    }
    if (sx - 1.0).abs() < 1e-4 && (sy - 1.0).abs() < 1e-4 {
        return frame;
    }
    let (sx, sy) = (sx.max(0.0), sy.max(0.0));
    let size = frame.size;
    let (offset, _) = view.style.transform_origin.offset(size);
    // The origin, from the frame's top left.
    let ox = size.width / 2.0 + offset.x;
    let oy = size.height / 2.0 + offset.y;
    Bounds::new(
        frame.origin + Point::new(ox - ox * sx, oy - oy * sy),
        nsh_core::Size::new(size.width * sx, size.height * sy),
    )
}

/// The view's borders, read on `ground`: a neutral color is dim, an accent
/// stays the accent.
fn edges(view: &NshView, ground: Ground) -> Edges {
    let borders = &view.style.borders;
    let widths = borders.widths.to_array().map(|width| width > Points::ZERO);
    let none = (Color::Reset, Modifier::empty());
    // Most views have no border: nothing to read.
    if widths == [false; 4] {
        return Edges {
            widths,
            sides: [false; 4],
            colors: [none; 4],
            style: borders.style,
        };
    }
    let colors = view
        .animated
        .border_color
        .map_or(borders.colors, |color| [color; 4]);
    let sides = std::array::from_fn(|side| widths[side] && !colors[side].is_transparent());
    // Each color read once: the sides of a box share theirs.
    let mut read: [Option<(nsh_core::Color, (Color, Modifier))>; 4] = [None; 4];
    Edges {
        widths,
        sides,
        colors: std::array::from_fn(|side| {
            if !sides[side] {
                return none;
            }
            let color = colors[side];
            if let Some((_, look)) = read.iter().flatten().find(|(seen, _)| *seen == color) {
                return *look;
            }
            let look = border_look(color, ground);
            read[side] = Some((color, look));
            look
        }),
        style: borders.style,
    }
}

/// How a border of `color` is drawn on `ground`.
fn border_look(color: nsh_core::Color, ground: Ground) -> (Color, Modifier) {
    // Lines are the ramp's border step; an accent stays its accent.
    if let Some(ramp) = ground.ramp {
        return match palette::tone(color, ground) {
            Tone::Accent(accent) => (accent, Modifier::empty()),
            _ => (ramp.border(), Modifier::empty()),
        };
    }
    let fg = ink(color, ground).fg.unwrap_or(Color::Reset);
    let modifier = if fg == Color::Reset {
        Modifier::DIM
    } else {
        Modifier::empty()
    };
    (fg, modifier)
}

/// Draws the sides of `edges` on the edge Cells of `bounds` that are in
/// `visible`.
fn lines(
    buffer: &mut Buffer,
    bounds: CellBounds,
    visible: Rect,
    edges: &Edges,
    radii: CornerRadii,
) {
    if !edges.any() {
        return;
    }
    let [top, right, bottom, left] = edges.sides;
    let (horizontal, vertical) = match edges.style {
        BorderStyle::Solid => ("─", "│"),
        BorderStyle::Dashed => ("╌", "╎"),
        BorderStyle::Dotted => ("┈", "┊"),
    };
    let rounded = |radius: Points, round: &'static str, square: &'static str| {
        if radius > Points::ZERO { round } else { square }
    };
    for y in visible.y..visible.bottom() {
        let cy = i32::from(y);
        let on_top = top && cy == bounds.top;
        let on_bottom = bottom && cy == bounds.bottom - 1;
        for x in visible.x..visible.right() {
            let cx = i32::from(x);
            let on_left = left && cx == bounds.left;
            let on_right = right && cx == bounds.right - 1;
            let (symbol, side) = match (on_top, on_bottom, on_left, on_right) {
                (true, _, true, _) => (rounded(radii.top_left, "╭", "┌"), 0),
                (true, _, _, true) => (rounded(radii.top_right, "╮", "┐"), 0),
                (false, true, true, _) => (rounded(radii.bottom_left, "╰", "└"), 2),
                (false, true, _, true) => (rounded(radii.bottom_right, "╯", "┘"), 2),
                (true, _, _, _) => (horizontal, 0),
                (false, true, _, _) => (horizontal, 2),
                (false, false, true, _) => (vertical, 3),
                (false, false, false, true) => (vertical, 1),
                _ => continue,
            };
            let (fg, modifier) = edges.colors[side];
            let cell = &mut buffer[(x, y)];
            cell.set_symbol(symbol);
            cell.fg = fg;
            cell.modifier = modifier;
        }
    }
}

/// Where a text view's rows go: its `layout` at `bounds`, drawn inside
/// `visible`, and the visible part of the scroll view's viewport around
/// it (`viewport`).
struct TextPlace<'a> {
    layout: &'a CellLayout,
    bounds: CellBounds,
    visible: Rect,
    viewport: Option<Rect>,
    /// The characters of the link that has the keyboard focus.
    focused: Option<std::ops::Range<u32>>,
}

/// What the text painter records of the Cells it draws.
struct TextCells<'a> {
    /// Which Cells hold text.
    text: &'a mut [bool],
    /// Which hold a linked glyph.
    links: &'a mut crate::link::Painted,
    /// The opening sequence of the link around the text, if any.
    link: Option<&'a std::sync::Arc<str>>,
}

/// Draws a text view's rows, as laid out, inside the place's `visible`,
/// colors read on `ground`.
fn text(
    buffer: &mut Buffer,
    cells: TextCells<'_>,
    place: TextPlace<'_>,
    view: &NshView,
    ground: Ground,
) {
    let TextCells {
        text: text_cells,
        links,
        link,
    } = cells;
    let TextPlace {
        layout,
        bounds,
        visible,
        viewport,
        focused,
    } = place;
    let visible = bounds.clipped(visible);
    // Where the scroll view's viewport, not the text's own box or a box
    // that clips it, cuts the text: what is cut there scrolls into view.
    let viewport_cuts_right = viewport
        .is_some_and(|v| i32::from(visible.right()) < bounds.right && visible.right() >= v.right());
    let viewport_cuts_bottom = viewport.is_some_and(|v| {
        i32::from(visible.bottom()) < bounds.bottom && visible.bottom() >= v.bottom()
    });
    let single = layout.rows.len() == 1;
    // A text on a fill of its own in a color beyond it (a code block's
    // language, ` ts ` in the page's color on the line color) is a label
    // in reverse: drawn as one, never as a fade on a faint band.
    let own_fill =
        view.kind == ViewKind::Text && !control(view) && view.style.background_color.0 & 255 != 0;
    // The end of the last row drawn: where a text cut below ends in `…`.
    let mut last_row = None;
    for (row_index, row) in layout.rows.iter().enumerate() {
        let y = bounds.top + row_index as i32;
        if y < i32::from(visible.y) {
            continue;
        }
        if y >= i32::from(visible.bottom()) {
            break;
        }
        let y = y as u16;
        // A row of text stands on its own over a drawing behind it (a
        // page's canvas backdrop): the braille dots across its box are
        // cleared with a Cell each side, as a canvas's own text clears
        // them, so a word never touches a dot.
        if !row.glyphs.is_empty() {
            let area = buffer.area;
            let from = visible.x.saturating_sub(1).max(area.x);
            let to = visible.right().saturating_add(1).min(area.right());
            for column in from..to {
                let cell = &mut buffer[(column, y)];
                if cell.symbol().chars().next().is_some_and(is_braille) {
                    cell.set_symbol(" ");
                }
            }
        }
        let mut x = bounds.left + row.indent as i32;
        let mut cut = None;
        let mut first = true;
        for glyph in &row.glyphs {
            let width = glyph.width as i32;
            let (start, end) = (x, x + width);
            x = end;
            if end > i32::from(visible.right()) && !glyph.text.trim().is_empty() {
                cut = Some(glyph);
            }
            if glyph.is_attachment()
                || width == 0
                || start < i32::from(visible.x)
                || end > i32::from(visible.right())
            {
                continue;
            }
            let (mut fg, mut modifier) = match view.animated.color.or(glyph.color()) {
                Some(color) => {
                    let style = ink(color, ground);
                    (style.fg.unwrap_or(Color::Reset), style.add_modifier)
                }
                None if ground.swatch => (palette::swatch_text(ground), Modifier::empty()),
                None => (Color::Reset, Modifier::empty()),
            };
            modifier |= glyph.modifiers();
            let mut bg = None;
            if own_fill
                && let Some(color) = view.animated.color.or(glyph.color())
                && palette::inverted(color, ground)
            {
                match ground.ramp {
                    Some(ramp) => {
                        fg = ramp.base();
                        bg = Some(ramp.muted());
                        modifier -= Modifier::DIM;
                    }
                    None => {
                        fg = Color::Reset;
                        modifier = (modifier | Modifier::REVERSED) - Modifier::DIM;
                    }
                }
            }
            // The focused link's characters are reversed, as a focused
            // control's label is.
            if let Some(focused) = &focused
                && glyph.range().start < focused.end
                && focused.start < glyph.range().end
            {
                modifier = (modifier | Modifier::REVERSED) - Modifier::DIM;
            }
            // An underline of its own color (an editor's diagnostic) keeps
            // it, as the terminal draws a colored underline under any text.
            let underline = glyph
                .decoration()
                .and_then(|color| ink(color, ground).fg)
                .filter(|&color| color != Color::Reset);
            // A run on its own background is a band: a step of the ramp, an
            // accent tinted into it, or reverse video without surfaces.
            if let Some(background) = glyph.background()
                && let Some(ramp) = ground.ramp
            {
                bg = match palette::surface(background, ground) {
                    Surface::None => None,
                    Surface::Accent(rgb) => {
                        if let Tone::Accent(accent) = palette::tone(background, ground) {
                            fg = accent;
                        }
                        Some(ramp.tint(rgb, ground.level))
                    }
                    kind => Some(ramp.level(palette::step(kind, ground.level))),
                };
            } else if let Some(background) = glyph.background()
                && let Some(accent) = ink(background, ground).fg
                && accent != Color::Reset
                && !background.is_transparent()
            {
                fg = accent;
                modifier = (modifier | Modifier::REVERSED) - Modifier::DIM;
            }
            // Text drawn over an earlier text's Cells wins them whole; the
            // earlier one reads as cut short rather than mixed in. Only
            // words read cut: a run of glyphs (a slider's track under its
            // thumb) is only covered.
            if std::mem::take(&mut first) && !glyph.text.trim().is_empty() {
                let at = buffer.index_of(start as u16, y);
                if text_cells[at] && start > i32::from(buffer.area.x) {
                    let before = buffer.index_of(start as u16 - 1, y);
                    if text_cells[before]
                        && buffer.content[before]
                            .symbol()
                            .chars()
                            .any(char::is_alphanumeric)
                    {
                        buffer.content[before].set_symbol("…");
                    }
                }
            }
            for (offset, cx) in (start..end).enumerate() {
                let at = buffer.index_of(cx as u16, y);
                text_cells[at] = true;
                // The Cell that holds the glyph carries its link; text
                // drawn over a linked Cell takes it away.
                match link {
                    Some(open) if offset == 0 => {
                        links.insert(at, (open.clone(), glyph.text.clone()));
                    }
                    _ => {
                        links.remove(&at);
                    }
                }
                let cell = &mut buffer[(cx as u16, y)];
                cell.set_symbol(if offset == 0 { &glyph.text } else { " " });
                // A glyph in the color of the band it lands on (a trigger's
                // accent arrow over its focus band) takes the band's
                // contrast, as the band's own text does.
                cell.fg = if bg.is_none() && fg != Color::Reset && fg == cell.bg {
                    ground
                        .ramp
                        .map_or_else(|| palette::mark_on(fg), |ramp| ramp.base())
                } else {
                    fg
                };
                cell.modifier = modifier;
                if let Some(underline) = underline {
                    cell.underline_color = underline;
                }
                if let Some(bg) = bg {
                    cell.bg = bg;
                }
            }
        }
        let words = row
            .glyphs
            .iter()
            .any(|glyph| glyph.text.chars().any(char::is_alphanumeric));
        let drawn_end = x.min(i32::from(visible.right()));
        if words {
            let row_start = bounds.left + row.indent as i32;
            clear_dots(buffer, text_cells, row_start - 1, y);
            clear_dots(buffer, text_cells, drawn_end, y);
        }
        last_row = Some((y, drawn_end, row_index, words));
        // A line cut at the box's right edge ends in an ellipsis; one a
        // scroll view's viewport cuts is only cut (it scrolls into view),
        // and a run of glyphs only (a slider's track) is never words cut.
        if single
            && words
            && cut.is_some()
            && !visible.is_empty()
            && i32::from(visible.right()) <= bounds.right
            && !viewport_cuts_right
        {
            let last = visible.right() - 1;
            buffer[(last, y)].set_symbol("…");
        }
    }
    // Rows past the bottom of the text's own box, or of a box that clips
    // it inside the viewport: the last one shown ends in `…`.
    if let Some((y, end, index, true)) = last_row
        && !viewport_cuts_bottom
        && index + 1 < layout.rows.len()
        && !visible.is_empty()
    {
        let x = if end < i32::from(visible.right()) {
            end
        } else {
            i32::from(visible.right()) - 1
        };
        if x >= i32::from(visible.x) {
            buffer[(x as u16, y)].set_symbol("…");
            text_cells[buffer.index_of(x as u16, y)] = true;
        }
    }
}

/// Frames an overlay's box `rect` one Cell outside it, rounded and dim,
/// `title` on its top line, clearing the Cells under the frame; a side
/// past `clip` (the box at the screen's edge) is left out, never drawn
/// over the box.
///
/// With `look` (the terminal's surfaces: the line's color and the box's
/// background) the frame is drawn in that color on that background and
/// the title is set off by the line: `╭─ Title ─`.
fn frame_around(
    buffer: &mut Buffer,
    rect: Rect,
    clip: Rect,
    title: &str,
    look: Option<(Color, Color)>,
) -> Option<Rect> {
    let (left, top) = (i32::from(rect.x) - 1, i32::from(rect.y) - 1);
    let (right, bottom) = (i32::from(rect.right()), i32::from(rect.bottom()));
    let clip = clip.intersection(buffer.area);
    let inside = |x: i32, y: i32| {
        x >= i32::from(clip.x)
            && x < i32::from(clip.right())
            && y >= i32::from(clip.y)
            && y < i32::from(clip.bottom())
    };
    let mut put = |x: i32, y: i32, symbol: &str| {
        if inside(x, y) {
            // `inside` keeps both within the buffer's u16 area.
            // The frame is the box's edge: its Cells are cleared as the
            // box's are (the terminal's background), never the page's
            // band or fill under it showing through beside the line.
            let cell = &mut buffer[(x as u16, y as u16)];
            cell.reset();
            cell.set_symbol(symbol);
            match look {
                Some((line, _)) => cell.fg = line,
                None => cell.modifier = Modifier::DIM,
            }
        }
    };
    for x in left..=right {
        let (first, last) = (x == left, x == right);
        put(
            x,
            top,
            if first {
                "╭"
            } else if last {
                "╮"
            } else {
                "─"
            },
        );
        put(
            x,
            bottom,
            if first {
                "╰"
            } else if last {
                "╯"
            } else {
                "─"
            },
        );
    }
    for y in rect.y..rect.bottom() {
        put(left, i32::from(y), "│");
        put(right, i32::from(y), "│");
    }
    let x = rect.x + u16::from(look.is_some());
    if !title.is_empty() && rect.width > 6 && inside(i32::from(x), top) {
        let drawn = dialog::put(
            buffer,
            x,
            top as u16,
            &format!(" {title} "),
            rect.width.min(clip.right().saturating_sub(x)),
            Color::Reset,
            Modifier::BOLD,
        );
        if let Some((_, background)) = look {
            for at in x..x + drawn {
                buffer[(at, top as u16)].bg = background;
            }
        }
        return Some(Rect::new(x, top as u16, drawn, 1));
    }
    None
}

/// Whether a text is a divider's line, and whether it runs down: a row of
/// `─` alone (a menu's separator, a resize handle between panes one above
/// the other), or a column of `│` alone inside a resize handle (`handle`;
/// elsewhere a quote's bar), in no accent (a handle lit while held keeps
/// its accent).
fn rule_axis(layout: &CellLayout, view: &NshView, ground: Ground, handle: bool) -> Option<bool> {
    let mut glyphs = layout.rows.iter().flat_map(|row| &row.glyphs);
    let first = glyphs.next()?;
    let down = match &*first.text {
        "─" if layout.rows.len() == 1 => false,
        "│" if handle && layout.rows.iter().all(|row| row.glyphs.len() == 1) => true,
        _ => return None,
    };
    let accent = |glyph: &crate::text::Glyph| {
        view.animated
            .color
            .or(glyph.color())
            .is_some_and(|color| matches!(palette::tone(color, ground), Tone::Accent(_)))
    };
    let same = std::iter::once(first)
        .chain(glyphs)
        .all(|glyph| *glyph.text == *first.text && !accent(glyph));
    same.then_some(down)
}

/// Whether `id`'s children are texts of lines beside texts of other
/// marks, no words (a slider's `━`, `●` and `─`): one control drawn in
/// parts.
fn lines_with_marks(tree: &Mounter, id: NodeId) -> bool {
    let Some(view) = tree.get(id) else {
        return false;
    };
    let (mut lines, mut marks) = (false, false);
    for &child in &view.children {
        let Some((layout, _)) = tree.get(child).and_then(|child| child.text.as_ref()) else {
            continue;
        };
        let Some(layout) = layout.downcast::<CellLayout>() else {
            continue;
        };
        // Each part is a run of one glyph: its first tells it.
        match layout.rows.first().and_then(|row| row.glyphs.first()) {
            Some(glyph) if matches!(&*glyph.text, "─" | "│") => lines = true,
            // A label beside a rule (a titled divider) is no mark.
            Some(glyph)
                if !glyph.text.trim().is_empty()
                    && !glyph.text.chars().any(char::is_alphanumeric) =>
            {
                marks = true
            }
            _ => {}
        }
        if lines && marks {
            return true;
        }
    }
    false
}

/// Whether `id` is a divider's box: filled, no text of its own, its views
/// holding blank texts and at least one row of `─` alone or a column of
/// `│` ([`rule_axis`]), within `depth` levels.
fn holds_rule(tree: &Mounter, id: NodeId, depth: usize) -> bool {
    fn walk(tree: &Mounter, id: NodeId, depth: usize, found: &mut bool) -> bool {
        let Some(view) = tree.get(id) else {
            return false;
        };
        if let Some((layout, _)) = &view.text {
            let Some(layout) = layout.downcast::<CellLayout>() else {
                return false;
            };
            let mut glyphs = layout.rows.iter().flat_map(|row| &row.glyphs);
            if glyphs.clone().all(|glyph| glyph.text.trim().is_empty()) {
                return view.children.is_empty();
            }
            let rule = (layout.rows.len() == 1 && glyphs.all(|glyph| &*glyph.text == "─"))
                || layout
                    .rows
                    .iter()
                    .all(|row| row.glyphs.len() == 1 && &*row.glyphs[0].text == "│");
            *found |= rule;
            return rule && view.children.is_empty();
        }
        depth > 0
            && !view.children.is_empty()
            && view
                .children
                .iter()
                .all(|&child| walk(tree, child, depth - 1, found))
    }
    let mut found = false;
    // Only a filled box is looked into: its fill is what is left out.
    tree.get(id)
        .is_some_and(|view| view.text.is_none() && view.style.background_color.0 & 255 != 0)
        && walk(tree, id, depth, &mut found)
        && found
}

/// The arms of a line's glyph: up, right, down, left.
const ARMS: [(&str, [bool; 4]); 15] = [
    ("─", [false, true, false, true]),
    ("│", [true, false, true, false]),
    ("┌", [false, true, true, false]),
    ("╭", [false, true, true, false]),
    ("┐", [false, false, true, true]),
    ("╮", [false, false, true, true]),
    ("└", [true, true, false, false]),
    ("╰", [true, true, false, false]),
    ("┘", [true, false, false, true]),
    ("╯", [true, false, false, true]),
    ("├", [true, true, true, false]),
    ("┤", [true, false, true, true]),
    ("┬", [false, true, true, true]),
    ("┴", [true, true, false, true]),
    ("┼", [true, true, true, true]),
];

/// A divider's Cell: its column and row, whether it runs down (else
/// across), and whether it may bridge a blank Cell to reach a frame (in an
/// overlay).
type Divider = (u16, u16, bool, bool);

/// Joins each divider's ends with the lines they reach: a divider running
/// across that ends on a line running down (a frame's side, another
/// divider) turns it into `├` / `┤` (`┼` across it), one running down that
/// ends on a line across turns it into `┬` / `┴`, as a box drawn in lines
/// joins its own.
fn join_lines(buffer: &mut Buffer, dividers: &[Divider]) {
    let arms = |symbol: &str| {
        ARMS.iter()
            .find(|(glyph, _)| *glyph == symbol)
            .map(|(_, arms)| *arms)
    };
    let area = buffer.area;
    for &(x, y, down, bridge) in dividers {
        let expected = if down { "│" } else { "─" };
        if buffer[(x, y)].symbol() != expected {
            // Covered since (an overlay drawn over it).
            continue;
        }
        // Its two ends' neighbors along its own line, and the arm each
        // takes toward it (up, right, down, left).
        let ends = if down {
            [
                (i32::from(x), i32::from(y) - 1, 2),
                (i32::from(x), i32::from(y) + 1, 0),
            ]
        } else {
            [
                (i32::from(x) - 1, i32::from(y), 1),
                (i32::from(x) + 1, i32::from(y), 3),
            ]
        };
        let within = |x: i32, y: i32| {
            x >= i32::from(area.x)
                && y >= i32::from(area.y)
                && x < i32::from(area.right())
                && y < i32::from(area.bottom())
        };
        for (mut nx, ny, arm) in ends {
            if !within(nx, ny) {
                continue;
            }
            // A row across a popup's content stops at its padding: a
            // blank Cell, then the frame's side, is bridged (a menu's
            // separator reaches its frame). On the page a rule joins only
            // the line it touches: one inside a card (a heading's) is the
            // card's content, not a divider of it.
            let beyond = nx + (nx - i32::from(x));
            if !down
                && bridge
                && buffer[(nx as u16, ny as u16)].symbol() == " "
                && within(beyond, ny)
                && arms(buffer[(beyond as u16, ny as u16)].symbol())
                    .is_some_and(|arms| arms[0] && arms[2])
            {
                let style = buffer[(x, y)].style();
                let gap = &mut buffer[(nx as u16, ny as u16)];
                gap.set_symbol("─");
                gap.set_style(style);
                nx = beyond;
            }
            let cell = &mut buffer[(nx as u16, ny as u16)];
            let Some(mut joined) = arms(cell.symbol()) else {
                continue;
            };
            if joined[arm] {
                continue;
            }
            joined[arm] = true;
            if let Some((glyph, _)) = ARMS
                .iter()
                .skip(2)
                .find(|(glyph, arms)| *arms == joined && !matches!(*glyph, "╭" | "╮" | "╰" | "╯"))
            {
                cell.set_symbol(glyph);
            }
        }
    }
}

/// Whether content drew a glyph where a scroll bar's `track` would go: the
/// layout keeps no column (or row) for the bar, so it then draws none
/// rather than cover what scrolls.
fn covers_content(buffer: &Buffer, track: Rect) -> bool {
    let track = track.intersection(buffer.area);
    (track.y..track.bottom())
        .any(|y| (track.x..track.right()).any(|x| buffer[(x, y)].symbol() != " "))
}

/// A track with its thumb: dim and the default color, or the ramp's border
/// and muted steps where the terminal has surfaces.
/// A focused scroll view (keys scroll it) shows its thumb in the accent:
/// the view itself keeps its look, as a focused box's line does.
fn scroll_bar(buffer: &mut Buffer, bar: ScrollBar, ramp: Option<Ramp>, focused: bool) {
    let (track, thumb) = if bar.vertical {
        ("│", "┃")
    } else {
        ("─", "━")
    };
    let rect = bar.track;
    for y in rect.y..rect.bottom() {
        for x in rect.x..rect.right() {
            let on_thumb = bar.thumb.contains(Position::new(x, y));
            let cell = &mut buffer[(x, y)];
            // The surface under the bar stays.
            let bg = cell.bg;
            cell.reset();
            if ramp.is_some() {
                cell.bg = bg;
            }
            match (on_thumb, ramp) {
                (true, ramp) => {
                    cell.set_symbol(thumb);
                    match ramp {
                        _ if focused => cell.fg = ACCENT,
                        Some(ramp) => cell.fg = ramp.muted(),
                        None => {}
                    }
                }
                (false, Some(ramp)) => {
                    cell.set_symbol(track);
                    cell.fg = ramp.border();
                }
                (false, None) => {
                    cell.set_symbol(track);
                    cell.modifier = Modifier::DIM;
                }
            }
        }
    }
}

/// Whether the view shows as a selected or current item: a band over its
/// Cells. Checkboxes, radios and switches show their state themselves.
fn banded(view: &NshView) -> bool {
    let accessibility = &view.props.accessibility;
    let state = &accessibility.state;
    match accessibility.role {
        AccessibilityRole::Checkbox | AccessibilityRole::Radio | AccessibilityRole::Switch => false,
        AccessibilityRole::MenuItemCheckbox | AccessibilityRole::MenuItemRadio => {
            state.selected || state.checked == Some(Checked::True)
        }
        _ => state.selected || state.current.is_some() || state.pressed == Some(Checked::True),
    }
}

/// Whether a press or hover on the view acts on it.
fn pressable(view: &NshView) -> bool {
    matches!(
        view.props.accessibility.role,
        AccessibilityRole::Button
            | AccessibilityRole::ImageButton
            | AccessibilityRole::Link
            | AccessibilityRole::Menuitem
            | AccessibilityRole::MenuItemCheckbox
            | AccessibilityRole::MenuItemRadio
            | AccessibilityRole::Option
            | AccessibilityRole::Tab
    ) || nsh_core::input::has_press(view.events)
}

/// Whether the view is a text input drawn by others: no fill and text in
/// a transparent color (a one-time code's field under its cells, which
/// show what it holds). It draws nothing: no band, no text, no state.
fn hidden_input(view: &NshView) -> bool {
    view.input.as_ref().is_some_and(|config| {
        view.animated
            .color
            .unwrap_or(config.style.color)
            .is_transparent()
            && view
                .animated
                .background
                .unwrap_or(view.style.background_color)
                .is_transparent()
    })
}

/// Whether the view is a control: something the user presses, chooses or
/// types in, drawn as its label row.
fn control(view: &NshView) -> bool {
    view.input.is_some()
        || pressable(view)
        || matches!(
            view.props.accessibility.role,
            AccessibilityRole::Checkbox
                | AccessibilityRole::Radio
                | AccessibilityRole::Switch
                | AccessibilityRole::Adjustable
                | AccessibilityRole::Combobox
                | AccessibilityRole::Spinbutton
        )
}

/// Whether the view is an input group: a text field among the views it
/// holds (a prefix, chips, a clear button, a chevron), within a few
/// levels, with something beside the field.
fn input_group(tree: &Mounter, id: NodeId) -> bool {
    fn field_in(tree: &Mounter, id: NodeId, depth: usize) -> bool {
        tree.get(id).is_some_and(|view| {
            view.input.is_some()
                || depth > 0
                    && view
                        .children
                        .iter()
                        .any(|&child| field_in(tree, child, depth - 1))
        })
    }
    tree.get(id).is_some_and(|view| {
        view.children.len() > 1 && view.children.iter().any(|&child| field_in(tree, child, 3))
    })
}

/// Whether a text field down to `depth` levels below `id` has the keys.
fn focused_field_in(tree: &Mounter, id: NodeId, depth: usize) -> bool {
    tree.get(id).is_some_and(|view| {
        (view.input.is_some() && view.states & state::FOCUSED != 0)
            || depth > 0
                && view
                    .children
                    .iter()
                    .any(|&child| focused_field_in(tree, child, depth - 1))
    })
}

/// What state marks draw with besides modifiers.
#[derive(Clone, Copy)]
struct Marks {
    /// The hover and press bands.
    bands: Bands,
    /// The color of a control whose fill stands out (a primary button):
    /// its accent, or the default foreground.
    emphasis: Option<Color>,
    /// The terminal shows no colors (`NO_COLOR`): focus is reversed and
    /// underlined, set apart from a selection's plain reverse video by the
    /// line rather than by the accent.
    mono: bool,
    /// The terminal has no grays between dim and full text (16 colors or
    /// none): a disabled control's label is struck through as well as dim,
    /// so it is not taken for a muted one.
    few: bool,
    /// The view is an item of a popup (a list's option, a menu's item):
    /// its focus spans its row, as a selected item's reverse does.
    popup: bool,
    /// The view is inside an input group that draws its line
    /// ([`Layer::lined_group`]).
    lined_group: bool,
}

/// Draws the view's state over its drawn Cells (its subtree's included):
/// selection, focus, press, hover, then disabled.
fn mark_state(
    buffer: &mut Buffer,
    view: &NshView,
    bounds: CellBounds,
    visible: Rect,
    inner: Rect,
    edges: &Edges,
    marks: Marks,
) {
    // A part shows its control's states as its own (a list's highlighted
    // option is focused while the keys stay in the search field).
    let flags = view.states | view.projected;
    let disabled = view.props.accessibility.state.disabled || flags & state::DISABLED != 0;
    let selected = banded(view);
    let field = view.input.is_some();
    let adjustable = view.props.accessibility.role == AccessibilityRole::Adjustable;
    if flags & state::FOCUSED != 0 && !disabled && adjustable {
        // A focused slider's thumb is reversed, as with surfaces.
        for y in visible.y..visible.bottom() {
            for x in visible.x..visible.right() {
                let cell = &mut buffer[(x, y)];
                if cell.symbol() == "●" {
                    cell.modifier.insert(Modifier::REVERSED | Modifier::BOLD);
                }
            }
        }
    }
    let focused = flags & state::FOCUSED != 0 && !disabled && !adjustable;
    let pressed = flags & state::PRESSED != 0 && !disabled;
    let hovered = flags & state::HOVERED != 0 && !disabled && pressable(view);
    // As with surfaces: lines and marks alone show states on themselves,
    // the focus reversed and bold where no accent may show.
    if !disabled && !selected && mark_only(buffer, view, visible, Color::Reset) {
        let focus = flags & state::FOCUSED != 0;
        mark_glyphs(buffer, visible, focus, hovered || pressed, focus);
        return;
    }
    // A disabled view's own content (its text, when the view is the text)
    // is dim; what it holds was dimmed as it was drawn (`Layer::disabled`).
    if disabled {
        for y in visible.y..visible.bottom() {
            for x in visible.x..visible.right() {
                let cell = &mut buffer[(x, y)];
                if cell.symbol() != " " {
                    cell.modifier =
                        (cell.modifier | Modifier::DIM) - Modifier::BOLD - Modifier::REVERSED;
                }
            }
        }
        if marks.few && control(view) && inner.height < CONTAINER_ROWS {
            strike(buffer, inner.intersection(visible));
        }
        return;
    }
    // As with surfaces: a pressable container's text keeps its weights.
    if let Some(accent) = marks.emphasis.filter(|_| inner.height < CONTAINER_ROWS) {
        for y in inner.y..inner.bottom() {
            for x in inner.x..inner.right() {
                let cell = &mut buffer[(x, y)];
                if cell.symbol() != " " {
                    if accent != Color::Reset {
                        cell.fg = accent;
                    }
                    cell.modifier = (cell.modifier | Modifier::BOLD) - Modifier::DIM;
                }
            }
        }
    }
    // A tab the app underlines keeps its underline alone, as with colors.
    let tab = view.props.accessibility.role == AccessibilityRole::Tab;
    if selected && !inner.is_empty() && !(tab && underlined(buffer, inner)) {
        for y in inner.y..inner.bottom() {
            for x in inner.x..inner.right() {
                buffer[(x, y)].modifier.insert(Modifier::REVERSED);
            }
        }
    }
    // A field shows its extent with no fill to show it (its fill is a
    // ramp's step, which a bandless terminal has not): an underline along
    // its last row, unless its line is drawn (a box three rows tall).
    let lined = edges.any() && bounds.bottom - bounds.top >= 3 || marks.lined_group;
    let row = (!inner.is_empty())
        .then(|| Rect::new(inner.x, inner.bottom() - 1, inner.width, 1).intersection(visible))
        .filter(|row| !row.is_empty());
    if field
        && !lined
        && let Some(row) = row
    {
        underline(buffer, row);
    }
    if focused && field {
        // Its whole row, the caret's blank Cells included, as the accent
        // band of surfaces: reversed in the accent (reversed and
        // underlined without colors), so the field the keys go to is not
        // mistaken for a selected item.
        label(buffer, inner, Modifier::UNDERLINED);
        if let Some(row) = row {
            focus_reverse(buffer, row, marks.mono, false);
        }
    } else if focused {
        if selected && inner.height < CONTAINER_ROWS {
            // Chosen and focused (a selected tab the keys are on): the
            // accent's reverse across it, not the selection's plain one, so
            // the focus reads apart from the choice.
            label(buffer, inner, Modifier::BOLD);
            focus_reverse(buffer, inner.intersection(visible), marks.mono, false);
        } else if selected {
            label(buffer, inner, Modifier::BOLD | Modifier::UNDERLINED);
        } else if inner.height >= CONTAINER_ROWS && edges.any() {
            emphasize_border(buffer, bounds, visible);
        } else if inner.height >= CONTAINER_ROWS {
            label(buffer, inner, Modifier::BOLD | Modifier::UNDERLINED);
        } else if view.kind == ViewKind::Scroll && !marks.mono {
            // A scroll view's bar says it has the focus, its thumb in the
            // accent; its track keeps its look.
            label(buffer, inner, Modifier::REVERSED);
        } else {
            // Reversed in the accent: a selection is plain reverse video.
            // A popup's item takes its whole row, as its selected
            // neighbors do; a control elsewhere only its label.
            let row = marks.popup && inner.height < CONTAINER_ROWS;
            focus_reverse(buffer, inner, marks.mono, !row);
        }
    } else if pressed && !selected {
        match marks.bands.press {
            Some(band) => fill(buffer, visible, band),
            None => label(buffer, inner, Modifier::REVERSED),
        }
    } else if hovered
        && !selected
        && let Some(band) = marks.bands.hover
        // The standard colors' gray is no faint step: it marks a control
        // (a button, a row), never a whole pressable panel (a table).
        && (band != Color::DarkGray || inner.height < CONTAINER_ROWS)
    {
        fill(buffer, visible, band);
        // Dim text on that gray would barely read.
        if band == Color::DarkGray {
            drawn(buffer, visible, |_| {});
        }
    }
    if disabled {
        for y in visible.y..visible.bottom() {
            for x in visible.x..visible.right() {
                let cell = &mut buffer[(x, y)];
                if cell.symbol() != " " {
                    cell.modifier = (cell.modifier | Modifier::DIM) - Modifier::BOLD;
                }
            }
        }
    }
}

/// Draws the view's state on a terminal with surfaces (`ramp`, and the
/// view's own step and background): bands of the ramp and bold, after
/// grok-build's look. Selected items take the select band, focused ones
/// the accent band, hovered ones the hover band (a step over the view at
/// rest, `hover_level`, so a `hover:` fill of the app's own is not
/// lifted twice), pressed ones the select band; a focused
/// field brightens its line (one on a band is drawn on a brighter band);
/// tabs are bold when chosen and on
/// the select band unless the app underlines them, muted otherwise;
/// disabled views are faint, with no band.
#[allow(clippy::too_many_arguments)]
fn mark_surface(
    buffer: &mut Buffer,
    view: &NshView,
    bounds: CellBounds,
    visible: Rect,
    inner: Rect,
    edges: &Edges,
    emphasis: Option<Color>,
    (ramp, level, own): (Ramp, usize, Color),
    hover_level: usize,
    popup: bool,
    dialog: bool,
    pane: bool,
) {
    // A part shows its control's states as its own (a list's highlighted
    // option is focused while the keys stay in the search field).
    let flags = view.states | view.projected;
    let disabled = view.props.accessibility.state.disabled || flags & state::DISABLED != 0;
    let selected = banded(view);
    let field = view.input.is_some();
    let tab = view.props.accessibility.role == AccessibilityRole::Tab;
    let focused = flags & state::FOCUSED != 0 && !disabled;
    let pressed = flags & state::PRESSED != 0 && !disabled;
    let hovered = flags & state::HOVERED != 0 && !disabled && pressable(view);
    let step = |target: usize| ramp.band(own, level, target);
    // A chosen control whose every glyph is in a hue of the app's (a
    // pagination's current dot in the accent) already tells itself from
    // the others: no select band under it. Read before an emphasis
    // recolors its label.
    let hued_label = {
        let mut glyphs = (inner.y..inner.bottom())
            .flat_map(|y| (inner.x..inner.right()).map(move |x| (x, y)))
            .map(|at| &buffer[at])
            .filter(|cell| cell.symbol() != " ")
            .peekable();
        glyphs.peek().is_some() && glyphs.all(|cell| palette::standard_hue(cell.fg))
    };
    // A control's own fill that stands out makes its label bold (a
    // primary button's); a pressable container (a card, a gauge) holds
    // text of its own weights, which it leaves as they are.
    let emphasis = emphasis.filter(|_| inner.height < CONTAINER_ROWS);
    if let Some(accent) = emphasis {
        drawn(buffer, inner, |cell| {
            if accent != Color::Reset {
                cell.fg = accent;
            }
            cell.modifier.insert(Modifier::BOLD);
        });
    }
    if disabled {
        drawn(buffer, visible, |cell| {
            cell.fg = ramp.disabled(cell.fg);
            cell.modifier -= Modifier::BOLD;
        });
        return;
    }
    if field {
        // A field with a line of its own (and so no band: a face is a line
        // or a fill) brightens its line; one on a band was drawn on the
        // accent-tinted focus band ([`Ramp::focus_band`]).
        if focused {
            recolor_border(buffer, bounds, visible, edges, ramp.focus_line());
        }
        return;
    }
    // A view of lines and marks alone (a resize handle, a field's `×`)
    // shows its states on its glyphs: no band, whatever the state.
    if !selected && !popup && mark_only(buffer, view, visible, own) {
        mark_glyphs(buffer, visible, focused, hovered || pressed, false);
        return;
    }
    // The highlighted item of a menu, list or palette in a popup (the
    // keyboard's or the pointer's) is an accent band; its text, shortcuts
    // included, is in the terminal's background color.
    // A focusable view showing focus its own way (a resize handle's line,
    // a slider's track) takes no marks for focus.
    let adjustable = view.props.accessibility.role == AccessibilityRole::Adjustable;
    if focused && adjustable {
        // A focused slider's (a color channel's) thumb stands on the
        // focus's accent, and a color area's picked Cell (`◆`): the track
        // or the grid already shows the value, the mark shows the keys go
        // here.
        drawn(buffer, visible, |cell| {
            if matches!(cell.symbol(), "●" | "◆") {
                cell.bg = ACCENT;
                cell.fg = ramp.base();
                cell.modifier.insert(Modifier::BOLD);
            }
        });
    }
    let focused = focused && !adjustable;
    // The same for the item a list highlights for the keys (a command's
    // inline list, a palette in a dialog) where the keys go: in a dialog or
    // the pane holding the focus, so two lists never band at once; and for
    // the selected row of a list in that pane (lazygit's): elsewhere
    // selection is the gray select band. A pressable control that is on
    // (a toolbar's toggle) is no row: it keeps the gray band, the accent
    // being the focus's.
    // Only a list's item: a one-time code's next cell, focused the same
    // way, shows focus its own way.
    let item = matches!(
        view.props.accessibility.role,
        AccessibilityRole::Option
            | AccessibilityRole::Menuitem
            | AccessibilityRole::MenuItemCheckbox
            | AccessibilityRole::MenuItemRadio
            | AccessibilityRole::Row
            | AccessibilityRole::TreeItem
    );
    let highlighted = view.projected & state::FOCUSED != 0 && item;
    // The accent marks the view's own focus: a focus it only shows for
    // its control (a command's highlighted item while its field has no
    // focus yet) is a gray step; where the keys do go (the focused pane,
    // a dialog), `highlighted` bands it in the accent above.
    let keys = view.states & state::FOCUSED != 0;
    // A control whose Cells are all its children's fills (a swatch's
    // color, a chip's raised fill, a pagination's bar) leaves a band
    // nowhere to show: the selected one keeps its fill, not the accent.
    let covered = !(visible.y..visible.bottom())
        .any(|y| (visible.x..visible.right()).any(|x| buffer[(x, y)].bg == own));
    let active = (popup && (focused || hovered || pressed) && pressable(view))
        || ((dialog || pane) && !popup && highlighted)
        || (pane && !popup && selected && !tab && !covered && (item || !pressable(view)));
    if active {
        accent_band(buffer, visible, inner, ramp, selected);
        return;
    }
    // A trigger whose popup or menu is open stands raised.
    if !popup
        && pressable(view)
        && view.props.accessibility.state.has_popup
        && view.props.accessibility.state.expanded == Some(true)
    {
        band(buffer, visible, step(palette::RAISED), own);
    }
    if tab {
        // The selected tab of a segmented list stands on the select band;
        // one whose app marks it with an underline (an underlined tab
        // strip) keeps that mark alone.
        if selected && !underlined(buffer, inner) {
            band(buffer, visible, step(SELECT), own);
        }
        if selected || focused {
            drawn(buffer, inner, |cell| cell.modifier.insert(Modifier::BOLD));
            if selected && focused && !keys {
                drawn(buffer, inner, |cell| {
                    cell.modifier.insert(Modifier::UNDERLINED)
                });
            }
        } else {
            drawn(buffer, inner, |cell| {
                if cell.fg == Color::Reset {
                    cell.fg = ramp.muted();
                }
            });
        }
        if focused && keys {
            accent_band(buffer, visible, inner, ramp, selected);
        } else if focused || pressed {
            band(buffer, visible, step(SELECT), own);
        } else if hovered {
            band(buffer, visible, ramp.band(own, hover_level, HOVER), own);
        }
        return;
    }
    let container = inner.height >= CONTAINER_ROWS;
    // A framed box that is the focused stop, or the part showing its
    // control's focus (a one-time code's next cell, its input hidden),
    // shows it with its line in the accent, bold (what shows without
    // colors), whatever its size and over the app's own line color (a
    // code's cell after a wrong code): nothing is filled over its frame.
    // A box that only holds the focus (a card) keeps its line. A box whose
    // row has no room for its line (a button's focus ring) is banded.
    let framed = focused && recolor_border(buffer, bounds, visible, edges, ACCENT);
    // A covered control, and one with no glyph no label to underline:
    // its focus is the focus band under its glyphs, or, with none (a
    // swatch, all fill), an underline under its Cells. A swatch may be the
    // accent's own color: its underline is in the color that reads on the
    // fill, as its check is.
    let glyphs = (inner.y..inner.bottom())
        .any(|y| (inner.x..inner.right()).any(|x| buffer[(x, y)].symbol() != " "));
    let marked = focused && !framed && !container && (covered || !glyphs);
    if marked && glyphs {
        // A control all of whose Cells are its parts' bands (a select's
        // trigger around its value) shows focus on those bands: the
        // accent-tinted focus band, a field's, no line under it.
        let focus = ramp.focus_band(Ramp::above(level, palette::RAISED));
        for y in visible.y..visible.bottom() {
            for x in visible.x..visible.right() {
                buffer[(x, y)].bg = focus;
            }
        }
    } else if marked && covered && !selected {
        // A swatch (all fill, no glyph) has no band to tint: a mark in its
        // middle, as a chosen one's check, in the color that reads on it.
        let shown = inner.intersection(visible);
        if !shown.is_empty() {
            let cell = &mut buffer[(
                shown.x + (shown.width - 1) / 2,
                shown.y + (shown.height - 1) / 2,
            )];
            cell.fg = match palette::mark_on(cell.bg) {
                Color::Reset => ACCENT,
                color => color,
            };
            cell.set_symbol(FOCUS_MARK);
            cell.modifier.insert(Modifier::BOLD);
        }
    } else if marked {
        focus_underline(buffer, visible, covered);
    }
    if selected {
        if !hued_label {
            band(buffer, visible, step(SELECT), own);
        }
        drawn(buffer, inner, |cell| cell.modifier.insert(Modifier::BOLD));
        // A chosen control all of whose Cells are its fill (a swatch) has
        // no band or label to show it: a check sits in its middle, in
        // the color that reads on the fill.
        let shown = inner.intersection(visible);
        if covered && !glyphs && !shown.is_empty() {
            let cell = &mut buffer[(
                shown.x + (shown.width - 1) / 2,
                shown.y + (shown.height - 1) / 2,
            )];
            let fg = palette::mark_on(cell.bg);
            cell.set_symbol("✓");
            cell.fg = fg;
            cell.modifier.insert(Modifier::BOLD);
        }
        // Focused as well as chosen (the page of a pagination, a
        // segment, a carousel's current thumbnail, which as a container
        // takes no focus band): the label is underlined, as the band
        // alone is the selection's.
        // The accent band below says it alone.
        let accented = keys && !covered && !container && !framed;
        if focused && !marked && !accented {
            drawn(buffer, inner, |cell| {
                cell.modifier.insert(Modifier::UNDERLINED)
            });
        }
    }
    if framed {
        // The line shows it.
    } else if focused && container {
        // A step up alone reads as one more raised surface: an accent
        // rail down its leading column marks it, as a focused pane's
        // line does, or its label without a free column for one.
        if !selected {
            band(buffer, visible, step(HOVER), own);
        }
        if !focus_rail(buffer, visible, inner) {
            drawn(buffer, inner, |cell| {
                cell.modifier.insert(Modifier::BOLD | Modifier::UNDERLINED)
            });
        }
    } else if focused && !covered && keys {
        accent_band(buffer, visible, inner, ramp, selected);
    } else if focused && !covered {
        band(buffer, visible, step(SELECT), own);
        drawn(buffer, inner, |cell| cell.modifier.insert(Modifier::BOLD));
    } else if focused {
        drawn(buffer, inner, |cell| cell.modifier.insert(Modifier::BOLD));
    } else if pressed && !selected {
        band(buffer, visible, step(SELECT), own);
    } else if hovered && !selected {
        band(buffer, visible, ramp.band(own, hover_level, HOVER), own);
    }
}

/// Marks a focused container with no line of its own: `▎` in the accent
/// on the blank Cells of its leading column (its padding), on the rows of
/// `inner` in sight. Whether it found any.
fn focus_rail(buffer: &mut Buffer, visible: Rect, inner: Rect) -> bool {
    let rows = inner.intersection(visible);
    if rows.is_empty() {
        return false;
    }
    let x = visible.x;
    let mut any = false;
    for y in rows.y..rows.bottom() {
        let cell = &mut buffer[(x, y)];
        if cell.symbol() == " " {
            cell.set_symbol("▎");
            cell.fg = ACCENT;
            cell.modifier -= Modifier::DIM;
            any = true;
        }
    }
    any
}

/// The accent band of what the keys act on (a focused control, the
/// highlighted item of a list): its text turns the terminal's background
/// color, so the band is under all of it, over the whole row: a child's
/// fill (a shortcut's key chip, today's circle in a calendar) takes the
/// row's band, no fill of its own beside it. Bold only when it is also
/// selected (a toggle that is on), so on and off still differ.
fn accent_band(buffer: &mut Buffer, visible: Rect, inner: Rect, ramp: Ramp, selected: bool) {
    for y in visible.y..visible.bottom() {
        for x in visible.x..visible.right() {
            buffer[(x, y)].bg = ACCENT;
        }
    }
    drawn(buffer, visible, |cell| {
        cell.fg = ramp.base();
        cell.modifier -= Modifier::BOLD;
    });
    if selected {
        drawn(buffer, inner, |cell| cell.modifier.insert(Modifier::BOLD));
    }
}

/// Whether `id` or a view down its first children has a fill or a border:
/// the box a terminal frames in an overlay, as the layout finds it. An
/// option ends the search: a list's first option's fill (a highlighted
/// row) is not the popup's box, the app's panel around the options (a
/// menu's, inside its list) is.
fn has_box(tree: &Mounter, id: NodeId) -> bool {
    let mut at = id;
    loop {
        let Some(view) = tree.get(at) else {
            return false;
        };
        if matches!(
            view.props.accessibility.role,
            AccessibilityRole::Option
                | AccessibilityRole::Menuitem
                | AccessibilityRole::MenuItemCheckbox
                | AccessibilityRole::MenuItemRadio
                | AccessibilityRole::Row
                | AccessibilityRole::TreeItem
        ) {
            return false;
        }
        let widths = view.style.borders.widths.to_array();
        if widths.iter().any(|w| *w > nsh_core::Points::ZERO)
            || view.style.background_color.0 & 255 != 0
        {
            return true;
        }
        let Some(&first) = view.children.first() else {
            return false;
        };
        at = first;
    }
}

/// Whether a view down `id`'s first children, `depth` levels at most, has
/// a fill (a translucent one too: a floating panel's).
fn filled_within(tree: &Mounter, id: NodeId, depth: usize) -> bool {
    let Some(view) = tree.get(id) else {
        return false;
    };
    view.style.background_color.0 & 255 != 0
        || (depth > 0
            && view
                .children
                .first()
                .is_some_and(|&child| filled_within(tree, child, depth - 1)))
}

/// Whether `id` or a view `depth` levels below it is a list of options or
/// a menu.
fn holds_list(tree: &Mounter, id: NodeId, depth: usize) -> bool {
    let Some(view) = tree.get(id) else {
        return false;
    };
    matches!(
        view.props.accessibility.role,
        AccessibilityRole::Listbox | AccessibilityRole::Menu
    ) || (depth > 0
        && view
            .children
            .iter()
            .any(|&child| holds_list(tree, child, depth - 1)))
}

/// The accent underline under every Cell of `rect`: the focus of a
/// control a band cannot show. On a `fill` (a swatch's color) the
/// underline is in the color that reads on it (`palette::mark_on`).
fn focus_underline(buffer: &mut Buffer, rect: Rect, fill: bool) {
    for y in rect.y..rect.bottom() {
        for x in rect.x..rect.right() {
            let cell = &mut buffer[(x, y)];
            cell.modifier.insert(Modifier::UNDERLINED);
            cell.underline_color = match fill.then(|| palette::mark_on(cell.bg)) {
                Some(color) if color != Color::Reset => color,
                _ => ACCENT,
            };
        }
    }
}

/// Whether `view` is a disclosure, and open: a pressable view whose
/// `expanded` is set that opens no popup (a collapsible's or an
/// accordion's trigger).
fn disclosure(view: &NshView) -> Option<bool> {
    let state = view.props.accessibility.state;
    state
        .expanded
        .filter(|_| !state.has_popup && pressable(view))
}

/// The glyphs a disclosure starts with: a trigger that draws one of its
/// own (`nsh-base`'s accordion and tree rows) gets no second.
const DISCLOSURE_GLYPHS: [&str; 6] = ["▸", "▾", "▴", "▶", "▼", "▲"];

/// Marks a disclosure: `▾` open, `▸` closed, in `look`, two Cells before
/// the first glyph of its first drawn row (one when only one is free), in
/// `rect`'s blank Cells; nothing when there is no room or the label
/// already starts with a disclosure.
fn mark_disclosure(buffer: &mut Buffer, rect: Rect, open: bool, (fg, modifier): (Color, Modifier)) {
    let Some((first, y)) = (rect.y..rect.bottom()).find_map(|y| {
        (rect.x..rect.right())
            .find(|&x| buffer[(x, y)].symbol() != " ")
            .map(|x| (x, y))
    }) else {
        return;
    };
    if DISCLOSURE_GLYPHS.contains(&buffer[(first, y)].symbol()) {
        return;
    }
    let free = first - rect.x;
    let x = match free {
        0 => return,
        1 => first - 1,
        _ => first - 2,
    };
    let cell = &mut buffer[(x, y)];
    cell.set_symbol(if open { "▾" } else { "▸" });
    cell.fg = fg;
    cell.modifier = (cell.modifier | modifier) - Modifier::BOLD - Modifier::REVERSED;
}

/// Clears a canvas's dot at Cell (`x`, `y`) beside a text over the canvas
/// (a chart's value on its bar): the label stands apart from the marks, as
/// a canvas's own text does.
fn clear_dots(buffer: &mut Buffer, text_cells: &[bool], x: i32, y: u16) {
    let area = buffer.area;
    if x < i32::from(area.x) || x >= i32::from(area.right()) {
        return;
    }
    let at = buffer.index_of(x as u16, y);
    let cell = &mut buffer.content[at];
    let braille = cell
        .symbol()
        .chars()
        .next()
        .is_some_and(|c| ('\u{2801}'..='\u{28ff}').contains(&c));
    if braille && !text_cells[at] {
        cell.set_symbol(" ");
    }
}

/// Whether a glyph of `rect` is underlined: the app marks the view itself.
fn underlined(buffer: &Buffer, rect: Rect) -> bool {
    (rect.y..rect.bottom()).any(|y| {
        (rect.x..rect.right()).any(|x| {
            let cell = &buffer[(x, y)];
            cell.symbol() != " " && cell.modifier.contains(Modifier::UNDERLINED)
        })
    })
}

/// Changes each Cell of `rect` that shows a glyph.
fn drawn(buffer: &mut Buffer, rect: Rect, mut change: impl FnMut(&mut ratatui_core::buffer::Cell)) {
    for y in rect.y..rect.bottom() {
        for x in rect.x..rect.right() {
            let cell = &mut buffer[(x, y)];
            if cell.symbol() != " " {
                change(cell);
                cell.modifier -= Modifier::DIM;
            }
        }
    }
}

/// Whether `view` draws only lines and marks, no letter or digit, on no
/// fill of its own or its children's (every glyph on `ground`): a line
/// across or down (a resize handle's), or a mark of a slot of at most
/// [`MARK_SLOT`] Cells (a field's `×`, a trigger's `▾`, a stepper's `+`).
/// Its states recolor those glyphs and lay no band under them.
fn mark_only(buffer: &Buffer, view: &NshView, visible: Rect, ground: Color) -> bool {
    let own = view
        .animated
        .background
        .unwrap_or(view.style.background_color);
    if own.0 & 255 != 0 || view.input.is_some() || visible.is_empty() {
        return false;
    }
    let line = visible.width == 1 || visible.height == 1;
    let slot = visible.height == 1 && visible.width <= MARK_SLOT;
    if !line {
        return false;
    }
    let mut glyphs = (visible.y..visible.bottom())
        .flat_map(|y| (visible.x..visible.right()).map(move |x| (x, y)))
        .map(|at| &buffer[at])
        .filter(|cell| cell.symbol() != " ")
        .peekable();
    glyphs.peek().is_some()
        && glyphs.all(|cell| {
            let mut chars = cell.symbol().chars();
            cell.bg == ground
                && chars.clone().all(|c| !c.is_alphanumeric())
                && (slot || chars.all(|c| ('\u{2500}'..='\u{257f}').contains(&c)))
        })
}

/// The Cells a slot holding a single mark takes: the mark and a blank
/// Cell either side.
const MARK_SLOT: u16 = 3;

/// A mark-only view's state ([`mark_only`]): its glyphs in the accent; a
/// slot's mark bold where the keys are, a line (a resize handle's) never
/// heavier, as it is the same line lit. Without colors (`reverse`) the
/// focused glyphs are reversed, so the focus still shows.
fn mark_glyphs(buffer: &mut Buffer, visible: Rect, focused: bool, lit: bool, reverse: bool) {
    if !focused && !lit {
        return;
    }
    let slot = visible.height == 1 && visible.width <= MARK_SLOT;
    drawn(buffer, visible, |cell| {
        cell.fg = ACCENT;
        if focused && slot {
            cell.modifier.insert(Modifier::BOLD);
        }
        if focused && reverse {
            cell.modifier.insert(Modifier::REVERSED);
        }
    });
}

/// A band of `color` behind the Cells of `rect` on the view's own
/// background `own`: what its children fill with their own steps stays.
fn band(buffer: &mut Buffer, rect: Rect, color: Color, own: Color) {
    for y in rect.y..rect.bottom() {
        for x in rect.x..rect.right() {
            let cell = &mut buffer[(x, y)];
            if cell.bg == own {
                cell.bg = color;
            }
        }
    }
}

/// A focused box's line in `color`: the line glyphs on the sides that
/// draw one, never a text the box's row holds (a one-row bar with only a
/// bottom line, a button whose ring the row has no room for). Whether
/// there was a line to recolor.
fn recolor_border(
    buffer: &mut Buffer,
    bounds: CellBounds,
    visible: Rect,
    edges: &Edges,
    color: Color,
) -> bool {
    let [top, right, bottom, left] = edges.sides;
    let mut any = false;
    for y in visible.y..visible.bottom() {
        for x in visible.x..visible.right() {
            let (cx, cy) = (i32::from(x), i32::from(y));
            if (top && cy == bounds.top)
                || (right && cx == bounds.right - 1)
                || (bottom && cy == bounds.bottom - 1)
                || (left && cx == bounds.left)
            {
                let cell = &mut buffer[(x, y)];
                if cell
                    .symbol()
                    .chars()
                    .next()
                    .is_some_and(|c| ('\u{2500}'..='\u{257f}').contains(&c))
                {
                    cell.fg = color;
                    cell.modifier -= Modifier::DIM;
                    if color == ACCENT {
                        cell.modifier.insert(Modifier::BOLD);
                    }
                    any = true;
                }
            }
        }
    }
    any
}

/// Whether a box draws a line on a side it has one: [`recolor_border`]'s
/// Cells, read and left as they are.
fn has_line(buffer: &Buffer, bounds: CellBounds, visible: Rect, edges: &Edges) -> bool {
    let [top, right, bottom, left] = edges.sides;
    (visible.y..visible.bottom()).any(|y| {
        (visible.x..visible.right()).any(|x| {
            let (cx, cy) = (i32::from(x), i32::from(y));
            ((top && cy == bounds.top)
                || (right && cx == bounds.right - 1)
                || (bottom && cy == bounds.bottom - 1)
                || (left && cx == bounds.left))
                && buffer[(x, y)]
                    .symbol()
                    .chars()
                    .next()
                    .is_some_and(|c| ('\u{2500}'..='\u{257f}').contains(&c))
        })
    })
}

/// A band of `color` behind every Cell of `rect`, modifiers untouched.
/// Paints `view`'s gradients (`backgroundImage`) over its fill in its
/// `visible` Cells, each Cell the color at its center, at the terminal's
/// depth; returns the color at the box's center, what its content reads
/// against. Nothing where the terminal paints no fills (the bandless look)
/// or the view has no gradient.
fn gradient(
    buffer: &mut Buffer,
    view: &NshView,
    bounds: CellBounds,
    visible: Rect,
    cells: CellSize,
    parent: Ground,
) -> Option<palette::Rgb> {
    let effects = view.style.effects.as_deref()?;
    if effects.background_images.is_empty()
        || parent.ramp.is_none()
        || visible.is_empty()
        || matches!(
            view.kind,
            ViewKind::Image | ViewKind::Video | ViewKind::WebView
        )
        || !effects.background_images.iter().any(crate::gradient::shows)
    {
        return None;
    }
    let fill = view
        .animated
        .background
        .unwrap_or(view.style.background_color);
    // A gradient over an opaque fill of the view's own is its finish (a
    // button's top-lit sheen): the fill is the surface, a step of the ramp.
    if fill.0 & 255 == 255 {
        return None;
    }
    let (cw, ch) = (cells.width().0, cells.height().0);
    let size = nsh_core::Size::new(
        Points((bounds.right - bounds.left) as f32 * cw),
        Points((bounds.bottom - bounds.top) as f32 * ch),
    );
    // CSS lists the top layer first.
    let layers: Vec<crate::gradient::Sampler> = effects
        .background_images
        .iter()
        .rev()
        .filter_map(|g| crate::gradient::Sampler::new(g, size))
        .collect();
    if layers.is_empty() {
        return None;
    }
    let [red, green, blue, alpha] = fill.0.to_be_bytes();
    let alpha = f32::from(alpha) / 255.0;
    let under: palette::Rgb = std::array::from_fn(|i| {
        let top = f32::from([red, green, blue][i]);
        (top * alpha + f32::from(parent.rgb[i]) * (1.0 - alpha)).round() as u8
    });
    let color_at =
        |point: (f32, f32)| crate::gradient::over(under, layers.iter().map(|l| l.at(point)));
    for y in visible.y..visible.bottom() {
        let py = (i32::from(y) - bounds.top) as f32 * ch + ch / 2.0;
        for x in visible.x..visible.right() {
            let px = (i32::from(x) - bounds.left) as f32 * cw + cw / 2.0;
            buffer[(x, y)].bg = palette::convert(color_at((px, py)), parent.depth);
        }
    }
    Some(color_at((size.width.0 / 2.0, size.height.0 / 2.0)))
}

/// Blanks the symbols in `rect`, keeping each Cell's background.
fn clear_symbols(buffer: &mut Buffer, rect: Rect) {
    for y in rect.y..rect.bottom() {
        for x in rect.x..rect.right() {
            let cell = &mut buffer[(x, y)];
            if cell.symbol() != " " {
                let bg = cell.bg;
                cell.reset();
                cell.bg = bg;
            }
        }
    }
}

fn fill(buffer: &mut Buffer, rect: Rect, color: Color) {
    for y in rect.y..rect.bottom() {
        for x in rect.x..rect.right() {
            buffer[(x, y)].bg = color;
        }
    }
}

/// Adds `modifier` to each row's text in `rect`: from its first drawn Cell
/// to its last.
fn label(buffer: &mut Buffer, rect: Rect, modifier: Modifier) {
    for y in rect.y..rect.bottom() {
        let drawn = |x: u16| buffer[(x, y)].symbol() != " ";
        let Some(first) = (rect.x..rect.right()).find(|&x| drawn(x)) else {
            continue;
        };
        let last = (rect.x..rect.right())
            .rev()
            .find(|&x| drawn(x))
            .unwrap_or(first);
        for x in first..=last {
            buffer[(x, y)].modifier.insert(modifier);
        }
    }
}

/// Strikes the words of `rect` through: its glyphs and the single spaces
/// between them, never the runs of blank Cells between a label and what
/// is beside it (a radio's note).
fn strike(buffer: &mut Buffer, rect: Rect) {
    for y in rect.y..rect.bottom() {
        let glyph = |buffer: &Buffer, x: u16| buffer[(x, y)].symbol() != " ";
        for x in rect.x..rect.right() {
            let word = glyph(buffer, x)
                || (x > rect.x
                    && x + 1 < rect.right()
                    && glyph(buffer, x - 1)
                    && glyph(buffer, x + 1));
            if word {
                buffer[(x, y)].modifier.insert(Modifier::CROSSED_OUT);
            }
        }
    }
}

/// Underlines every Cell of `rect`.
fn underline(buffer: &mut Buffer, rect: Rect) {
    for y in rect.y..rect.bottom() {
        for x in rect.x..rect.right() {
            buffer[(x, y)].modifier.insert(Modifier::UNDERLINED);
        }
    }
}

/// The bandless focus of a control: its Cells reversed in the accent (the
/// accent behind, its text in the terminal's background), or reversed and
/// underlined on a terminal without colors. Only the label's span (its first
/// glyph to its last) when `label`, else every Cell of `rect`.
fn focus_reverse(buffer: &mut Buffer, rect: Rect, mono: bool, label: bool) {
    let modifier = if mono {
        Modifier::REVERSED | Modifier::UNDERLINED
    } else {
        Modifier::REVERSED
    };
    for y in rect.y..rect.bottom() {
        let drawn = |x: u16| buffer[(x, y)].symbol() != " ";
        let (first, last) = if label {
            let Some(first) = (rect.x..rect.right()).find(|&x| drawn(x)) else {
                continue;
            };
            let last = (rect.x..rect.right())
                .rev()
                .find(|&x| drawn(x))
                .unwrap_or(first);
            (first, last)
        } else {
            (rect.x, rect.right() - 1)
        };
        for x in first..=last {
            let cell = &mut buffer[(x, y)];
            cell.modifier = (cell.modifier | modifier) - Modifier::DIM;
            if !mono {
                cell.fg = ACCENT;
            }
        }
    }
}

/// A focused container's border: bold, no longer dim.
fn emphasize_border(buffer: &mut Buffer, bounds: CellBounds, visible: Rect) {
    for y in visible.y..visible.bottom() {
        for x in visible.x..visible.right() {
            let (cx, cy) = (i32::from(x), i32::from(y));
            let edge = cx == bounds.left
                || cx == bounds.right - 1
                || cy == bounds.top
                || cy == bounds.bottom - 1;
            if edge {
                let cell = &mut buffer[(x, y)];
                cell.modifier = (cell.modifier | Modifier::BOLD) - Modifier::DIM;
            }
        }
    }
}
