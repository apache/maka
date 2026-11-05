//! `Treemap`: the plot's rows as a hierarchy of nested rectangles, each
//! leaf's area its value (d3's `treemap` over `stratify`, squarified).

mod label;
mod layout;
mod pose;

use std::{collections::HashMap, fmt, rc::Rc, sync::Arc};

use nsh_core::{
    SvgPaint,
    canvas::{CanvasOp, Num, PathOp},
    element::{
        Arg, Callback, JsHost, JsIn, JsKind, JsOwned, JsValue, PropError, RowAccessor, RowRef,
        RowText, Rows, Style, TextPartStyle, TsTypes,
    },
    geometry::Percentage,
    prelude::*,
};

use self::{
    layout::{Input, Layout, Options, Problem, Tree, at_level},
    pose::{Spot, TreemapPose},
};
use super::{
    PlotContext, STROKE_ROOM,
    bar::{BarCornerRadii, grown},
    class::{RowClass, row_classes},
    layer, mark_canvas,
    moves::Moves,
    pie::Var,
    series,
};

/// The order a [`Treemap`]'s siblings are tiled in, from its top left
/// corner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum TreemapSort {
    /// By value, largest first (d3's `hierarchy.sort((a, b) => b.value -
    /// a.value)`), equal values in the rows' order: the largest nodes at
    /// the top left, the tiles nearest to square.
    #[default]
    Value,
    /// In the rows' order: the nodes keep their places as their values
    /// change (a market map over another period), at the cost of less
    /// square tiles.
    Data,
}

/// Where a [`Treemap`]'s labels go in their leaves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum TreemapLabelPlacement {
    /// At the leaf's top left (its top right in a right-to-left layout):
    /// lines read down the leaf.
    #[default]
    Start,
    /// In the leaf's middle, the lines centered: a market map's tickers.
    Center,
}

/// A [`Treemap`]'s padding by level (TS `number | number[]`): the same
/// at every level, or the levels' own from the top one down, the last for
/// those below; in points, 0 for none.
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct TreemapPadding(pub Vec<Points>);

impl TreemapPadding {
    fn levels(&self) -> Vec<f32> {
        self.0.iter().map(|p| p.0).collect()
    }
}

impl From<Points> for TreemapPadding {
    fn from(padding: Points) -> Self {
        Self(vec![padding])
    }
}

impl From<Vec<Points>> for TreemapPadding {
    fn from(levels: Vec<Points>) -> Self {
        Self(levels)
    }
}

impl<const N: usize> From<[Points; N]> for TreemapPadding {
    fn from(levels: [Points; N]) -> Self {
        Self(levels.to_vec())
    }
}

impl JsValue for TreemapPadding {
    fn ts_type(_types: &mut TsTypes) -> String {
        "number | number[]".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        let numbers = match value.kind() {
            JsKind::Number => vec![<f64 as JsValue>::from_js(value)?],
            JsKind::Array => <Vec<f64> as JsValue>::from_js(value)?,
            _ => return Err(value.expected("a number of points, or one per level")),
        };
        match numbers.iter().all(|n| n.is_finite() && *n >= 0.0) {
            true => Ok(Self(
                numbers.into_iter().map(|n| Points(n as f32)).collect(),
            )),
            false => Err(value.expected("numbers of 0 or more")),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self.0.as_slice() {
            [one] => f64::from(one.0).to_js(host),
            levels => levels
                .iter()
                .map(|p| f64::from(p.0))
                .collect::<Vec<_>>()
                .to_js(host),
        }
    }
}

/// A [`Treemap`] node's value text (TS `(d: T, value: number, index:
/// number) => string`): the app's function of the node's row and its
/// value (a group's is its leaves' sum, which its row does not hold),
/// called once per row when the rows or the function change, in the next
/// JS turn.
#[derive(Clone)]
pub enum TreemapValueLabel {
    /// The app's JS function of a row, its value and its index.
    Js(Callback<(RowRef, f64, u32), SharedString>),
    /// A Rust function of a row's index and its value.
    Rust(Rc<dyn Fn(usize, f64) -> SharedString>),
}

impl TreemapValueLabel {
    /// The text `f` gives the node of each row and value (Rust).
    pub fn from_fn(f: impl Fn(usize, f64) -> SharedString + 'static) -> Self {
        TreemapValueLabel::Rust(Rc::new(f))
    }
}

impl fmt::Debug for TreemapValueLabel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TreemapValueLabel::Js(_) => f.write_str("Js"),
            TreemapValueLabel::Rust(_) => f.write_str("Rust"),
        }
    }
}

/// The same Rust function; the app's functions are told apart by the texts
/// they give, so one set again is called again.
impl PartialEq for TreemapValueLabel {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (TreemapValueLabel::Rust(a), TreemapValueLabel::Rust(b)) => Rc::ptr_eq(a, b),
            _ => false,
        }
    }
}

impl JsValue for TreemapValueLabel {
    fn ts_type(_types: &mut TsTypes) -> String {
        "(d: T, value: number, index: number) => string".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        match value.kind() {
            JsKind::Function => <Callback<(RowRef, f64, u32), SharedString> as Arg>::from_js(value)
                .map(TreemapValueLabel::Js),
            _ => Err(value.expected("a function of a row and its value")),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        // A function stays the app's: it is not handed back.
        Ok(JsOwned::new(host, host.undefined()))
    }
}

/// The props of [`Treemap`].
#[derive(Debug, Clone, PartialEq, Props)]
#[props(generic)]
pub struct TreemapProps {
    /// The id of each row's node (d3's `stratify().id`): a field name (its
    /// text, a number as JS writes it) or a function of the row and its
    /// index; without one, the row's index. What `parent` names, and what
    /// a node is known by when the rows change, so it moves to its new
    /// place rather than leaving and coming in again.
    pub id: Prop<Option<RowText>>,
    /// The id of each row's parent (d3's `stratify().parentId`), as `id`:
    /// a row whose parent is empty, or names no row, is a top-level node;
    /// without one, every row is. Rows that other rows name are groups,
    /// the others leaves; a row that is its own ancestor is left out.
    pub parent: Prop<Option<RowText>>,
    /// The size of each leaf (d3's `hierarchy.sum`): a field name or a
    /// function of the row and its index. A leaf's area is in proportion
    /// to it, a group's value is the sum of its children's (whatever its
    /// own row holds). A leaf whose value is 0, below 0 or not a number
    /// takes no area: it is not drawn, has no label and is not found by
    /// the pointer, and neither is a group whose leaves all are.
    pub value: Prop<Option<RowAccessor>>,
    /// The order siblings are tiled in: `"value"` (the default), largest
    /// first at the top left; or `"data"`, the rows' order.
    #[prop(default)]
    pub sort: Prop<TreemapSort>,
    /// The aspect ratio the tiles approach (d3's `treemapSquarify.ratio`,
    /// at least 1); the golden ratio by default.
    #[prop(default = std::f64::consts::GOLDEN_RATIO)]
    pub ratio: Prop<f64>,
    /// The gap between siblings, in points (d3's `paddingInner`): along
    /// no outer edge of their parent; a number for every level, or one per
    /// level from the top one down (`[2, 1]`: 2 between the top-level
    /// nodes, 1 below them). 0 by default.
    #[prop(default)]
    pub padding_inner: Prop<TreemapPadding>,
    /// The room inside each group around its children, in points (d3's
    /// `paddingOuter`), by level as `paddingInner`; 0 by default.
    #[prop(default)]
    pub padding_outer: Prop<TreemapPadding>,
    /// The band at the top of each group, in points (d3's `paddingTop`),
    /// its `groupLabel` written in it, by level as `paddingInner`; 0 by
    /// default. A level's band goes on all the siblings of a parent or
    /// none of them, left off where one is too small for it, so the groups
    /// of a level read alike.
    #[prop(default)]
    pub padding_top: Prop<TreemapPadding>,
    /// The radius of each corner of its rectangles (as `Bar`'s
    /// `cornerRadii`): a number for all four, or the corners named; square
    /// by default.
    #[prop(default)]
    pub corner_radii: Prop<BarCornerRadii>,
    /// The category of each node, which the plot's `colorScale` gives a
    /// color when it is `ordinal` (as `Bar`'s `color`): a field name or a
    /// function of the row and its index (`"parent"`: a group's leaves in
    /// its color). That color is the node's `fill` where nothing sets one,
    /// in place of `currentColor`, so the app's `fill-*` classes and
    /// `fill` styles win.
    pub color: Prop<Option<RowText>>,
    /// The number of each node, which the plot's `colorScale` makes its
    /// color when it is a ramp (`sequential`, `diverging`; a market map's
    /// change of the day): a field name or a function of the row and its
    /// index, over the extent of the rows' values without a `domain`. A
    /// row without one takes the scale's `unknown`, else no color of it.
    pub color_value: Prop<Option<RowAccessor>>,
    /// The Tailwind classes of each leaf, the `leaf` part: its `fill-*`,
    /// `stroke-*` and stroke width; the same on every leaf, or a function
    /// of the leaf's row and its index that gives each its own.
    pub leaf_class: Prop<Option<RowClass>>,
    /// The style of every leaf, over its classes.
    #[prop(default)]
    pub leaf_style: Prop<Style>,
    /// The Tailwind classes of each group, the `group` part: a rectangle
    /// under its children, showing in the gaps, its padding and its band;
    /// as `leafClass`. Drawn only with a class or a style.
    pub group_class: Prop<Option<RowClass>>,
    /// The style of every group, over its classes.
    #[prop(default)]
    pub group_style: Prop<Style>,
    /// The opacity of the nodes away from the one under the pointer (or
    /// the keys), and of their labels, faded in and out with the hover: a
    /// leaf keeps its own and its groups', a group its own and what is
    /// under it. None by default.
    pub inactive_opacity: Prop<Option<Percentage>>,
    /// The name in each leaf, the first line of its `label` part: a field
    /// name or a function of the row and its index, on one line, cut with
    /// an ellipsis where the leaf is narrower.
    pub label: Prop<Option<RowText>>,
    /// The value in each leaf, the line under its name (as `Sankey`'s
    /// `valueLabel`): the app's function of the leaf's row, its value and
    /// its index; shown only where it fits whole.
    pub value_label: Prop<Option<TreemapValueLabel>>,
    /// Where the labels go in their leaves: `"start"` (the default), at
    /// the top left; `"center"`, in the middle.
    #[prop(default)]
    pub label_placement: Prop<TreemapLabelPlacement>,
    /// The Tailwind classes of each leaf's label, the `label` part: a box
    /// as big as the leaf holding its lines, its padding (the room from
    /// the leaf's edges) and text styles the lines'. A label is shown only
    /// where its first line fits inside the box's padding. A label whose
    /// leaf's color (of the plot's `colorScale`) is dark has the attribute
    /// `data-dark`, so `data-dark:text-white` turns it light there.
    pub label_class: Prop<Option<SharedString>>,
    /// The style of each leaf's label, over `labelClass`.
    #[prop(default)]
    pub label_style: Prop<TextPartStyle>,
    /// The Tailwind classes of the value line, the `valueLabel` part, over
    /// the label's text styles.
    pub value_label_class: Prop<Option<SharedString>>,
    /// The style of the value line, over `valueLabelClass`.
    #[prop(default)]
    pub value_label_style: Prop<TextPartStyle>,
    /// The name of each group, written in its band (`paddingTop`), the
    /// `groupLabel` part: a field name or a function of the row and its
    /// index, on one line, cut with an ellipsis.
    pub group_label: Prop<Option<RowText>>,
    /// The Tailwind classes of each group's label: a box as big as the
    /// band, its padding and text styles the line's; with `data-dark` as
    /// `labelClass`, of the group's color.
    pub group_label_class: Prop<Option<SharedString>>,
    /// The style of each group's label, over `groupLabelClass`.
    #[prop(default)]
    pub group_label_style: Prop<TextPartStyle>,
    /// How its top-level nodes appear one after another (as `Bar`'s
    /// `stagger`, 0 to 0.95): the share of the plot's appear over which
    /// they start, in their tiling order, each growing from its middle with
    /// what is under it; 0 (the default) grows them together.
    #[prop(default)]
    pub stagger: Prop<Percentage>,
    /// The Tailwind classes of its hover box, the `hover` part: a view as
    /// big as the node under the pointer (or the keys), over it, its
    /// corners, border and outline the app's (`rounded-sm outline-2
    /// outline-foreground`); none without a class or style.
    pub hover_class: Prop<Option<SharedString>>,
    /// The style of its hover box, over `hoverClass`.
    #[prop(default)]
    pub hover_style: Prop<Style>,
}

/// The value texts `label` gives the nodes of `rows` of values `values`,
/// once known: in the next JS turn for the app's function.
fn value_texts(
    rows: impl Fn() -> Rows + 'static,
    values: Memo<Option<Arc<[f64]>>>,
    label: impl Fn() -> Option<TreemapValueLabel> + 'static,
) -> Signal<Option<Arc<[SharedString]>>> {
    let out = signal(None::<Arc<[SharedString]>>);
    // A newer run wins over the answers of an older one.
    let generation = stored(0u64);
    effect(move || {
        let (rows, values, label) = (rows(), values.get(), label());
        let run = generation.get() + 1;
        generation.replace(run);
        let value = |i: usize| {
            values
                .as_ref()
                .and_then(|v| v.get(i).copied())
                .unwrap_or(0.0)
        };
        match label {
            None => out.set(None),
            Some(TreemapValueLabel::Rust(f)) => {
                out.set(Some((0..rows.len()).map(|i| f(i, value(i))).collect()))
            }
            Some(TreemapValueLabel::Js(f)) => {
                let answers: Vec<_> = (0..rows.len())
                    .filter_map(|i| {
                        rows.row(i)
                            .map(|row| f.call_async((row, value(i), i as u32)))
                    })
                    .collect();
                spawn(async move {
                    let mut texts = Vec::with_capacity(answers.len());
                    for answer in answers {
                        texts.push(answer.await.unwrap_or_default());
                    }
                    if generation.get() == run {
                        out.set(Some(texts.into()));
                    }
                });
            }
        }
    });
    out
}

/// A canvas's key: a part (groups or leaves), a level and classes.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Layer {
    group: bool,
    depth: usize,
    class: SharedString,
}

/// The canvases `to` and `from` need: one per part, level and classes.
fn layers(to: &TreemapPose, from: Option<&TreemapPose>, groups: bool) -> Vec<Layer> {
    let mut out: Vec<Layer> = Vec::new();
    for s in to.0.iter().chain(from.into_iter().flat_map(|f| f.0.iter())) {
        if s.group && !groups {
            continue;
        }
        let layer = s.layer();
        if !out.contains(&layer) {
            out.push(layer);
        }
    }
    // Groups under leaves.
    out.sort_by_key(|l| (!l.group, l.depth));
    out
}

/// The warnings `problems` make, once each while they stay.
fn warn(problems: &[Problem]) {
    for problem in problems {
        match problem {
            Problem::DuplicateId(row, id) => log::warn!(
                "`Treemap`: row {row}'s id {id:?} is an earlier row's; nothing names it as a parent"
            ),
            Problem::UnknownParent(row, id) => log::warn!(
                "`Treemap`: row {row}'s parent {id:?} is no row's id; it is a top-level node"
            ),
            Problem::Cycle(row) => log::warn!(
                "`Treemap`: row {row} is its own ancestor; it and what is under it are not drawn"
            ),
        }
    }
}

/// A treemap of a [`Plot`](super::Plot)'s rows (d3's `treemap` of a
/// `stratify` hierarchy, Observable Plot's and Vega's treemaps): one
/// rectangle per node, its rows made a tree by their `id` and `parent`
/// fields, each leaf's area in proportion to its `value` and each group
/// the box of what is under it, squarified in order of value, with the
/// gaps of `paddingInner`, the room of `paddingOuter` and the band of
/// `paddingTop` per level. A node's color
/// is its row's of the plot's `colorScale`: of its `colorValue` along a
/// ramp (`sequential`, `diverging`), of its `color` category
/// (`ordinal`), or its `fill` where the app sets one. Labels write each
/// leaf's name and value (`label`, `valueLabel`) and each group's name in
/// its band (`groupLabel`), where they fit. The pointer finds the leaf
/// under it (across a gap, the nearest; in a band or padding, the group),
/// which the plot reports (`onHoverChange`) and marks with the `hover`
/// part, the other nodes fading to `inactiveOpacity`; the arrows step to
/// the leaf beside on the screen, Home and End to the first and last, and
/// screen readers through the rows in order. The plot's x and y scales
/// are not used. With the plot's appear, the top-level nodes grow from
/// their middles (one after another with `stagger`); with
/// `motion.update`, the nodes glide to their new boxes and colors, known
/// by their ids, new ones grow from their middles and those that are gone
/// shrink to theirs, on the platform's animator.
#[component]
pub fn Treemap(props: TreemapProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let Some(plot) = PlotContext::of("Treemap") else {
        return layer();
    };
    let rows = move || plot.rows.get();
    let (id, parent, value) = (props.id, props.parent, props.value);
    let ids = series::texts(rows, move || id.get());
    let parents = series::texts(rows, move || parent.get());
    let values = series::values(rows, move || value.get());

    // The tree, once its values are known.
    let warned = stored(Vec::<Problem>::new());
    let tree = computed(move || -> Option<Arc<Tree>> {
        let len = plot.rows.with(Rows::len);
        let ids = match (id.with(Option::is_some), ids.get()) {
            (true, None) => return None,
            (_, Some(ids)) => ids,
            (false, None) => (0..len)
                .map(|i| SharedString::from(i.to_string()))
                .collect(),
        };
        let parents = match (parent.with(Option::is_some), parents.get()) {
            (true, None) => return None,
            (_, Some(parents)) => parents,
            (false, None) => vec![SharedString::default(); len].into(),
        };
        let values = values.get()?;
        let tree = Tree::new(&Input {
            ids: &ids,
            parents: &parents,
            values: &values,
        });
        if warned.with(|w| *w != tree.problems) {
            warn(&tree.problems);
            warned.replace(tree.problems.clone());
        }
        Some(Arc::new(tree))
    });
    // The nodes' values, a group's its sum: what `valueLabel` gets.
    let sums = computed(move || tree.with(|t| Some(Arc::<[f64]>::from(t.as_ref()?.value.clone()))));

    let (sort, ratio) = (props.sort, props.ratio);
    let (inner, outer, top) = (props.padding_inner, props.padding_outer, props.padding_top);
    let laid = computed(move || -> Option<Arc<Layout>> {
        if !plot.is_sized() {
            return None;
        }
        let size = plot.size.get();
        let options = Options {
            width: size.width.0,
            height: size.height.0,
            ratio: ratio.get(),
            sort: sort.get(),
            padding_inner: inner.with(TreemapPadding::levels),
            padding_outer: outer.with(TreemapPadding::levels),
            padding_top: top.with(TreemapPadding::levels),
        };
        tree.with(|t| Some(Arc::new(layout::layout(t.as_ref()?, &options))))
    });

    // Each row's color: its category's of an ordinal scale, or its
    // number's of a ramp.
    let categories = series::colors(plot, rows, props.color);
    let color_value = props.color_value;
    let numbers = series::values(rows, move || color_value.get());
    let shades = computed(move || {
        numbers.with(|v| {
            let v = v.as_deref()?;
            let extent = super::scale::extent(v.iter().copied().filter(|n| n.is_finite()));
            plot.shades_over(v, extent)
        })
    });
    let leaf_class = props.leaf_class;
    let group_class = props.group_class;
    let leaf_classes = row_classes(rows, move || leaf_class.get());
    let group_classes = row_classes(rows, move || group_class.get());

    let pose = computed(move || -> Option<TreemapPose> {
        let laid = laid.get()?;
        let ids = ids.get();
        let (categories, shades) = (categories.get(), shades.get());
        let (leaves, groups) = (leaf_classes.get(), group_classes.get());
        let at = |c: &Option<Arc<[Option<Hsla>]>>, row: usize| {
            c.as_ref().and_then(|c| c.get(row).copied().flatten())
        };
        let class = |c: &Option<Arc<[SharedString]>>, row: usize| {
            c.as_ref()
                .and_then(|c| c.get(row).cloned())
                .unwrap_or_default()
        };
        let mut root = 0;
        let spots = laid.nodes.iter().enumerate().map(|(place, n)| {
            if n.depth == 0 {
                root = laid.roots.iter().position(|&r| r == place).unwrap_or(0);
            }
            Spot {
                id: match &ids {
                    Some(ids) => ids.get(n.row).cloned().unwrap_or_default(),
                    None => SharedString::from(n.row.to_string()),
                },
                row: n.row,
                rect: [n.x0, n.y0, n.x1, n.y1],
                color: at(&categories, n.row).or_else(|| at(&shades, n.row)),
                class: match n.group {
                    true => class(&groups, n.row),
                    false => class(&leaves, n.row),
                },
                group: n.group,
                depth: n.depth,
                root,
                first: n.first,
                last: n.last,
                header: n.header,
            }
        });
        Some(TreemapPose(spots.collect()))
    });
    let moves = Moves::new(plot, pose);
    let root_count = computed(move || laid.with(|l| l.as_ref().map_or(0, |l| l.roots.len())));

    // The pointer finds the node under it; the keys step across the
    // leaves on the screen.
    let reach = move || at_level(&inner.with_untracked(TreemapPadding::levels), 0) + 1.0;
    plot.add_hit_with(
        move |at| {
            laid.with_untracked(|l| l.as_ref()?.at(at.x.0, at.y.0, reach()))
                .map(|row| row as u32)
        },
        move |row| {
            laid.with_untracked(|l| {
                let (x, y) = l.as_ref()?.of(row as usize)?.center();
                Some(point(px(x), px(y)))
            })
        },
        Some(Rc::new(move |from, step| {
            laid.with_untracked(|l| layout::step(l.as_ref()?, from.map(|r| r as usize), step))
                .map(|row| row as u32)
        })),
    );

    // The hovered node's place in the layout, on the animator: the nodes
    // it holds or that hold it stay, the others fade.
    let span = (animated_value(-2.0), animated_value(-2.0));
    effect(move || {
        let Some(row) = plot.hovered.get() else {
            return;
        };
        let node = laid.with(|l| l.as_ref()?.of(row as usize).copied());
        match node {
            Some(n) => {
                span.0.set(n.first as f32);
                span.1.set(n.last as f32);
            }
            None => {
                span.0.set(-2.0);
                span.1.set(-2.0);
            }
        }
    });
    let inactive = props.inactive_opacity;
    let dim = move || {
        inactive
            .get()
            .map(|o| 1.0 - o.0.clamp(0.0, 1.0))
            .filter(|d| *d > 0.0 && plot.interactive.get())
    };
    // The opacity of the node at `first` to `last` while one is hovered.
    let shown = move |first: usize, last: usize, dim: f32| {
        let (f, l) = (first as f32, last as f32);
        let before = span.1.interpolate(&[f - 1.0, f], &[0.0, 1.0]);
        let after = span.0.interpolate(&[l, l + 1.0], &[1.0, 0.0]);
        nested_opacity(plot, before.mul(&after), dim)
    };
    let stagger = props.stagger;

    let radii = props.corner_radii;
    let (leaf_style, group_style) = (props.leaf_style, props.group_style);
    let has_groups =
        move || group_class.with(Option::is_some) || group_style.with(|s| *s != Style::default());
    let canvases = computed(move || -> Vec<Layer> {
        match moves.shown() {
            Some((to, from)) => layers(&to, from.as_ref().map(|f| &f.0), has_groups()),
            None => Vec::new(),
        }
    });
    let canvas_of = move |layer: Layer| {
        let class = layer.class.clone();
        let style = match layer.group {
            true => group_style,
            false => leaf_style,
        };
        mark_canvas(
            Some(plot),
            || STROKE_ROOM,
            move |p, _| {
                let Some((to, from)) = moves.shown() else {
                    return p;
                };
                let p = p
                    .stroke_style_from_view(SvgPaint::None)
                    .line_width_from_view()
                    .line_dash_from_view();
                draw(
                    p,
                    Draw {
                        layer: &layer,
                        to: &to,
                        from: from.as_ref(),
                        corners: radii.get().corners().map(|r| Num::Const(r.0.max(0.0))),
                        appearing: plot
                            .appearing
                            .get()
                            .then(|| (root_count.get(), stagger.get())),
                        dim: dim(),
                    },
                    &|root, count, stagger| grown(plot, root, count, stagger),
                    &shown,
                )
            },
        )
        .app_class(move || Some(class.clone()).filter(|c| !c.is_empty()))
        .inline_style(style)
    };

    let labels = label::Labels {
        moves,
        names: label::texts(rows, props.label),
        values: value_texts(rows, sums, {
            let label = props.value_label;
            move || label.get()
        }),
        group_names: label::texts(rows, props.group_label),
        placement: props.label_placement,
        class: props.label_class,
        style: props.label_style,
        value_class: props.value_label_class,
        style_value: props.value_label_style,
        group_class: props.group_label_class,
        group_style: props.group_label_style,
        grown: Rc::new(move |root| {
            plot.appearing.get_untracked().then(|| {
                grown(
                    plot,
                    root,
                    root_count.get_untracked(),
                    stagger.get_untracked(),
                )
            })
        }),
        dimmed: Rc::new(move |first, last| {
            let dim = untracked(dim)?;
            let before = span.1.sub(first).interpolate(&[-1.0, 0.0], &[0.0, 1.0]);
            let after = last.sub(&span.0).interpolate(&[-1.0, 0.0], &[0.0, 1.0]);
            Some(nested_opacity(plot, before.mul(&after), dim))
        }),
    };
    let hover = label::HoverBox {
        class: props.hover_class,
        style: props.hover_style,
    };

    layer()
        .child(each(
            move || canvases.get(),
            |layer| layer.clone(),
            move |layer, _| canvas_of(layer.get_untracked()),
        ))
        .child(label::labels(labels))
        .child(label::hover_box(plot, laid, hover))
}

/// The opacity of a node `nested` (1) with the hovered one or not (0).
fn nested_opacity(plot: PlotContext, nested: AnimatedNode, dim: f32) -> AnimatedNode {
    nested
        .mul(-1.0)
        .add(1.0)
        .mul(dim)
        .mul(&plot.fade)
        .mul(-1.0)
        .add(1.0)
}

/// What one canvas draws.
struct Draw<'a> {
    layer: &'a Layer,
    to: &'a TreemapPose,
    from: Option<&'a (TreemapPose, AnimatedValue)>,
    corners: [Num; 4],
    /// While the plot appears: its top-level nodes and the stagger.
    appearing: Option<(usize, Percentage)>,
    dim: Option<f32>,
}

/// Draws the nodes of `d.layer` of the pose shown, moving to their boxes
/// and colors now, grown with the plot's appear and faded away from the
/// hovered node.
fn draw(
    mut p: Painter,
    d: Draw,
    grown: &dyn Fn(usize, usize, Percentage) -> AnimatedNode,
    shown: &dyn Fn(usize, usize, f32) -> AnimatedNode,
) -> Painter {
    let mine = |s: &Spot| s.layer() == *d.layer;
    let before: HashMap<&str, &Spot> = match d.from {
        Some((from, _)) => from.0.iter().map(|s| (&*s.id, s)).collect(),
        None => HashMap::new(),
    };
    let progress = d.from.map(|(_, q)| Var::Node(*q.node()));
    let square = d.corners.iter().all(|r| *r == Num::Const(0.0));
    let paint = |c: Option<Hsla>| series::paint_of(c, SvgPaint::CurrentColor);
    let path = |p: Painter, rect: [Var; 4]| {
        let mut p = p;
        let rect = rect.map(|v| p.num(&v));
        let op = match square {
            true => PathOp::Rect(rect),
            false => PathOp::RoundRect(rect, d.corners),
        };
        p.begin_path().op(CanvasOp::Path(op))
    };
    // The nodes now, then those that are gone, shrinking away.
    let gone = d.from.into_iter().flat_map(|(from, _)| {
        from.0
            .iter()
            .filter(|s| !d.to.0.iter().any(|t| t.id == s.id))
            .map(|s| (s.clone(), true))
    });
    let now = d.to.0.iter().map(|s| (s.clone(), false));
    for (spot, is_gone) in now.chain(gone.collect::<Vec<_>>()) {
        if !mine(&spot) {
            continue;
        }
        let (a, b) = match (&progress, is_gone) {
            (None, _) => (spot.rect, spot.rect),
            (Some(_), true) => (spot.rect, spot.scaled(0.0).rect),
            (Some(_), false) => match before.get(&*spot.id) {
                Some(was) => (was.rect, spot.rect),
                None => (spot.scaled(0.0).rect, spot.rect),
            },
        };
        let rect = |q: &Option<Var>| -> [Var; 4] {
            let [x0, y0, x1, y1] = std::array::from_fn(|i| match q {
                Some(q) if a[i] != b[i] => Var::Const(b[i] - a[i]).mul(q).add(&Var::Const(a[i])),
                _ => Var::Const(b[i]),
            });
            [x0, y0, x1.sub(&x0), y1.sub(&y0)]
        };
        let mut rect = rect(&progress);
        if let (Some((count, stagger)), false) = (d.appearing, is_gone) {
            let g = Var::Node(grown(spot.root, count, stagger));
            let [x, y, w, h] = rect;
            let left = g.mul(&Var::Const(-0.5)).add(&Var::Const(0.5));
            rect = [
                x.add(&w.mul(&left)),
                y.add(&h.mul(&left)),
                w.mul(&g),
                h.mul(&g),
            ];
        }
        let alpha = match (d.dim, is_gone) {
            (Some(dim), false) => Some(shown(spot.first, spot.last, dim)),
            _ => None,
        };
        // A color that changes fades to the new one.
        let old = match (&progress, is_gone) {
            (Some(q), false) => before
                .get(&*spot.id)
                .map(|was| was.color)
                .filter(|c| *c != spot.color)
                .map(|c| (c, *q)),
            _ => None,
        };
        if let Some((color, _)) = &old {
            p = match &alpha {
                Some(a) => p.global_alpha(a),
                None => p.global_alpha(1.0),
            };
            p = path(p.fill_style_from_view(paint(*color)), rect).fill();
        }
        let over = match (&alpha, old.map(|(_, q)| q)) {
            (Some(a), Some(q)) => Some(Var::Node(*a).mul(&q)),
            (Some(a), None) => Some(Var::Node(*a)),
            (None, Some(q)) => Some(q),
            (None, None) => None,
        };
        p = match &over {
            Some(a) => p.global_alpha(a),
            None => p.global_alpha(1.0),
        };
        p = path(p.fill_style_from_view(paint(spot.color)), rect)
            .fill()
            .stroke();
    }
    p
}
