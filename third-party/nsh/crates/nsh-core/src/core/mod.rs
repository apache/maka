mod canvas_render;
mod classes;
mod components;
mod cull;
mod follow;
mod layout_scope;
mod layout_tree;
mod list;
mod list_motion;
mod measure;
mod overlay;
mod pace;
mod parent_viewport;
mod reading;
mod relations;
mod renders;
mod resize_anchor;
mod scrollbars;
mod services;
mod slots;
mod sticky;
mod terminal_layout;
#[cfg(test)]
mod tests;
mod touch;
mod views;
mod watch;
mod web_evaluation;

/// The most network image checks [`Core`] remembers for its canvases; past
/// it, it starts over.
const CANVAS_IMAGES: usize = 1024;

/// The start of a player's error when the core refuses its source; the
/// capability that would grant it follows (`network`, `fs`).
pub(crate) const SOURCE_NOT_GRANTED: &str = "the source is not granted by capabilities.";

use std::{rc::Rc, sync::Arc};

use slab::Slab;
use taffy::{AvailableSpace, NodeId as LayoutId, Overflow, Position};

pub use self::measure::{ListScrollPosition, Measurement};
use self::{
    layout_tree::LayoutTree,
    list::{ExtraKind, Follow, ListState, PendingScroll, PinTarget},
};
use crate::{
    animation::AnimationProp,
    geometry::{Bounds, Percentage, Point, Points, Size, rect, size_pt},
    mount::{
        InputConfig, ModalConfig, MountBatch, MountItem, NativeProps, ScreenConfig, ScrollBehavior,
        StickyCell, VideoProps, ViewKind,
    },
    ops::{
        CellSlot, Command, EventKind, EventMask, EventPayload, HeaderSlot, ImageProp, ImageSource,
        KeyboardDismissMode, ModalAnimation, ModalProp, NativeProp, NodeId, Op, PayloadValue, Prop,
        ROOT_ID, ResizeMode, ScreenAnimation, ScreenProp, ScrollProp, Tag,
    },
    props::{AccessibilityProp, EdgeInsets, GestureValues, LayoutAnimation, ViewProps},
    style::{Color, PaintStyle, Style, StylePatch, TextAlign, TextStyle, ViewStyle},
    tailwind::{ClassEnvironment, ClassList, ClassProps, Tailwind},
    text::{AttributedText, MeasureCache, ResolvedTextStyle, TextEngine, TextLayout},
    text_source::{SourceCollector, SourceGeometry, SourceMap},
};

/// Slab index of a node. Internal links use keys, never ids, to avoid the
/// id -> key indirection on hot paths.
type Key = u32;

/// A raw text run with no node of its own ([`Core::runs`]).
struct Run {
    text: String,
    /// The block or span holding it; `NO_KEY` when it is not in the tree.
    block: Key,
}

/// A view's built-in scroll bar (`scrollbars.rs`) and the theme of its own
/// it was made with.
/// A view's built-in bar, and the theme of the view's own it was made
/// with (`None`: the app's).
type Bar = (NodeId, Option<crate::ScrollbarSetting>);

const NO_KEY: Key = Key::MAX;

/// Rounds of binding the components' own lists per commit, at most.
const MAX_VIRTUAL_ROUNDS: u32 = 8;
/// The longest run without a line-break opportunity a multiline input's value is
/// measured with unbroken (`broken_runs`): longer than a line of any input,
/// so ordinary text measures as it is shown.
const MEASURED_RUN: usize = 1024;
/// Dirty flags, processed once per commit.
mod dirty {
    /// Emit [`crate::MountItem::ViewStyle`].
    pub(super) const VIEW: u32 = 1 << 0;
    /// Emit [`crate::MountItem::Events`].
    pub(super) const EVENTS: u32 = 1 << 1;
    /// Rebuild the attributed text of a text block.
    pub(super) const TEXT_BUILD: u32 = 1 << 2;
    /// Lay out the text block again and emit [`crate::MountItem::Text`].
    pub(super) const TEXT_MOUNT: u32 = 1 << 3;
    /// Emit [`crate::MountItem::Image`].
    pub(super) const IMAGE: u32 = 1 << 4;
    /// Emit [`crate::MountItem::ScrollConfig`].
    pub(super) const SCROLL: u32 = 1 << 5;
    /// Emit [`crate::MountItem::Refreshing`].
    pub(super) const REFRESHING: u32 = 1 << 6;
    /// Emit [`crate::MountItem::AnimationBindings`].
    pub(super) const ANIMATION: u32 = 1 << 7;
    /// Emit [`crate::MountItem::PanValues`].
    pub(super) const PAN: u32 = 1 << 8;
    /// Emit [`crate::MountItem::Input`].
    pub(super) const INPUT: u32 = 1 << 9;
    /// Emit [`crate::MountItem::InputValue`].
    pub(super) const INPUT_VALUE: u32 = 1 << 10;
    /// Emit [`crate::MountItem::ViewProps`].
    pub(super) const VIEW_PROPS: u32 = 1 << 11;
    /// Emit [`crate::MountItem::ScreenConfig`].
    pub(super) const SCREEN: u32 = 1 << 12;
    /// Emit [`crate::MountItem::ModalConfig`].
    pub(super) const MODAL: u32 = 1 << 13;
    /// Emit [`crate::MountItem::NativeProps`].
    pub(super) const NATIVE: u32 = 1 << 14;
    /// Emit [`crate::MountItem::ScrollBehavior`].
    pub(super) const SCROLL_BEHAVIOR: u32 = 1 << 15;
    /// Emit [`crate::MountItem::Canvas`].
    pub(super) const CANVAS: u32 = 1 << 16;
    /// Emit [`crate::MountItem::ComponentProps`].
    pub(super) const COMPONENT: u32 = 1 << 17;
    /// Emit [`crate::MountItem::AccessibilityLabel`] (unless
    /// [`VIEW_PROPS`] sends everything).
    pub(super) const LABEL: u32 = 1 << 18;
    /// Emit [`crate::MountItem::Shader`].
    pub(super) const SHADER: u32 = 1 << 19;
    /// Emit [`crate::MountItem::NavShader`].
    pub(super) const NAV_SHADER: u32 = 1 << 20;
}

/// A layout root other than the surface's: screens, modals and header
/// items are laid out on their own, at a size their container gives them.
#[derive(Debug, Default)]
struct RootState {
    /// Size the platform reported for the root (modals).
    reported: Option<Size<Points>>,
    /// Safe-area insets the platform reported for the root (modals).
    insets: EdgeInsets,
    /// Height of the header the platform measured above the content
    /// (screens; until then, estimated from the bar's height and the safe
    /// area).
    header: Option<f32>,
    /// The size and header height the root was last laid out with.
    laid_out: Option<(Size<Points>, f32)>,
    /// Screen options (screens).
    screen: ScreenConfig,
    /// Modal options (modals).
    modal: ModalConfig,
    /// `transitionShader` (screens and modals), as the platform gets it.
    nav_shader: Option<crate::NavShader>,
    /// Where a header item goes (header items).
    slot: HeaderSlot,
    /// A leading, trailing or title header item laid out with no width: nothing
    /// of it shows, so the screen's options leave it out of the bar.
    empty: bool,
    /// `nativeID` (input accessories).
    native_id: Option<Box<str>>,
    /// `statusBar` (screens and modals).
    status_bar: Option<crate::StatusBarSetting>,
    /// Its entry in the surface's status bars, while the node is in the
    /// tree ([`Core::sync_status_bars`]).
    status_bar_entry: Option<crate::element::status_bar::StatusBarEntry>,
    /// Placement and root view (overlays).
    overlay: Option<Box<overlay::OverlayState>>,
}

/// Paragraph settings of a text block (or input).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Paragraph {
    /// `allowFontScaling`.
    allow_font_scaling: bool,
    /// `maxFontSizeMultiplier`; 0 means no limit.
    max_font_multiplier: f32,
    /// `selectionColor` of selectable text.
    selection_color: Option<crate::Color>,
    /// `adjustsFontSizeToFit`.
    fit: bool,
    /// `minimumFontScale`.
    min_font_scale: f32,
}

impl Default for Paragraph {
    fn default() -> Self {
        Self {
            allow_font_scaling: true,
            max_font_multiplier: 0.0,
            selection_color: None,
            fit: false,
            min_font_scale: 0.0,
        }
    }
}

impl Paragraph {
    /// The factor applied to font sizes for the user's text size setting.
    fn font_multiplier(&self, font_scale: f32) -> f32 {
        if !self.allow_font_scaling {
            return 1.0;
        }
        if self.max_font_multiplier >= 1.0 {
            font_scale.min(self.max_font_multiplier)
        } else {
            font_scale
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    View,
    Text,
    RawText,
    Image,
    Scroll,
    List,
    Cell,
    Input,
    Stack,
    Screen,
    Modal,
    HeaderItem,
    InputAccessory,
    Canvas,
    WebView,
    Video,
    Native,
    Overlay,
    Shader,
}

impl Kind {
    /// Kinds whose native view hosts child views.
    fn is_container(self) -> bool {
        matches!(
            self,
            Kind::View
                | Kind::Scroll
                | Kind::List
                | Kind::Cell
                | Kind::Stack
                | Kind::Screen
                | Kind::Modal
                | Kind::HeaderItem
                | Kind::InputAccessory
                | Kind::Overlay
                | Kind::Shader
        )
    }

    /// Kinds laid out as their own root, not as part of their parent.
    fn is_root(self) -> bool {
        matches!(
            self,
            Kind::Screen | Kind::Modal | Kind::HeaderItem | Kind::InputAccessory | Kind::Overlay
        )
    }

    fn view_kind(self) -> ViewKind {
        match self {
            Kind::Text => ViewKind::Text,
            Kind::Image => ViewKind::Image,
            Kind::Scroll | Kind::List => ViewKind::Scroll,
            Kind::Input => ViewKind::Input,
            Kind::Stack => ViewKind::Stack,
            Kind::Screen => ViewKind::Screen,
            Kind::Modal => ViewKind::Modal,
            Kind::HeaderItem => ViewKind::HeaderItem,
            Kind::InputAccessory => ViewKind::InputAccessory,
            Kind::Canvas => ViewKind::Canvas,
            Kind::WebView => ViewKind::WebView,
            Kind::Video => ViewKind::Video,
            Kind::Native => ViewKind::Native,
            // A shader's view is a view the platform draws its layer in
            // (`MountItem::Shader`), under its children.
            Kind::View | Kind::Cell | Kind::RawText | Kind::Overlay | Kind::Shader => {
                ViewKind::View
            }
        }
    }

    /// Kinds whose taffy style is derived from the JS style (and must keep
    /// the JS style around to re-derive it).
    fn of(tag: Tag) -> Self {
        match tag {
            Tag::View => Kind::View,
            Tag::Text => Kind::Text,
            Tag::Image => Kind::Image,
            Tag::Scroll => Kind::Scroll,
            Tag::List => Kind::List,
            Tag::Cell => Kind::Cell,
            Tag::Input => Kind::Input,
            Tag::Stack => Kind::Stack,
            Tag::Screen => Kind::Screen,
            Tag::Modal => Kind::Modal,
            Tag::HeaderItem => Kind::HeaderItem,
            Tag::InputAccessory => Kind::InputAccessory,
            Tag::Canvas => Kind::Canvas,
            Tag::WebView => Kind::WebView,
            Tag::Video => Kind::Video,
            Tag::Native => Kind::Native,
            Tag::Overlay => Kind::Overlay,
            Tag::Shader
            | Tag::ShaderEffect
            | Tag::ShaderTransition
            | Tag::ScreenEffect
            | Tag::ScreenTransition => Kind::Shader,
        }
    }

    /// Whether its layout node's style is derived from the one JS set,
    /// which the node then keeps too ([`Node::base_layout`]).
    fn derives_layout(self) -> bool {
        matches!(
            self,
            Kind::Text
                | Kind::Input
                | Kind::Scroll
                | Kind::List
                | Kind::Cell
                | Kind::Screen
                | Kind::Modal
                | Kind::Overlay
        )
    }
}

/// The prop a native component's `accentColor` style reaches it as
/// ([`Core::sync_accent`]).
const ACCENT_PROP: &str = "accentColor";

/// A registered native component: its name and properties, as JS set them.
#[derive(Debug, Default)]
struct ComponentState {
    name: Option<Arc<str>>,
    props: Vec<(Arc<str>, crate::JsonValue)>,
    /// Properties changed since the last commit.
    changed: Vec<Arc<str>>,
    /// The names of its animated prop slots (`AnimationProp::ComponentSlot`):
    /// a name keeps its slot once given one.
    slots: Vec<Arc<str>>,
    /// The bound slots and their animation nodes. A bound prop's value in
    /// `props` is kept but not sent until it is unbound.
    bound: Vec<(u16, crate::animation::NodeId)>,
    /// `slots` changed since the platform was last told (a `Cell`: the
    /// commit clears it while it reads the node).
    slots_changed: std::cell::Cell<bool>,
}

impl ComponentState {
    fn is_bound(&self, name: &str) -> bool {
        self.bound
            .iter()
            .any(|(s, _)| &*self.slots[*s as usize] == name)
    }
}

#[derive(Debug)]
struct ScrollState {
    horizontal: bool,
    scrollbar: crate::ScrollbarSetting,
    /// Its built-in bar ([`Core::sync_scrollbars`]).
    bar: Option<Bar>,
    refreshing: bool,
    scroll_value: Option<crate::animation::NodeId>,
    pull_value: Option<crate::animation::NodeId>,
    keyboard_dismiss: KeyboardDismissMode,
    /// Last content size sent to the platform.
    content: Option<Size<Points>>,
    /// Where in the mount items the last `ScrollContent` was queued: a
    /// later size in the same batch replaces it, so a row relaid in two
    /// passes never sends the platform a transient size (which would clamp
    /// the offset before the content grows back). With the batch it is in
    /// ([`Core::batches`]).
    content_item: Option<(u64, usize)>,
    /// Extent and viewport direction before layout corrections in this batch.
    anchor_geometry: Option<(u64, f32, bool)>,
    /// Its content size laid out while it was culled
    /// ([`Core::cull_frames_in`]): the first its native view gets.
    culled_content: Option<Size<Points>>,
    behavior: ScrollBehavior,
    /// Minimum milliseconds between `onScroll` events.
    event_throttle_ms: f32,
    /// The zoom scale the platform reported.
    zoom: f32,
    /// The content offset the platform reported.
    offset: (f32, f32),
    /// Scrolls the core sent a plain scroll view since its native view was
    /// made (`ScrollBy` items and `ScrollTo` commands; lists count theirs in
    /// their state): platforms report how many they applied.
    issued: u32,
    /// Where the last `ScrollTo` sent scrolls it, with its number in
    /// `issued` (moved by the `ScrollBy`s after it), until a report shows
    /// it applied: `reveal` starts from there.
    target: Option<(u32, (f32, f32))>,
    /// The lists virtualized against this scroll view (`viewport="parent"`;
    /// empty for nearly every scroll view).
    dependents: Vec<Key>,
    /// While it has such lists: the scrolls issued that the reports do not
    /// show applied yet.
    pending: Vec<(u32, PendingScroll)>,
    /// What its lists asked of it in this commit, sent at its end.
    asked: Option<parent_viewport::Asked>,
    /// The sticky cells it was last sent: its lists' (its own too, when it
    /// is a list), its sticky views' and its built-in bar's.
    page_sticky: Vec<list::StickyRange>,
    /// The ranges of the `position: sticky` views in it.
    view_sticky: Vec<list::StickyRange>,
    /// Views in its content are culled (`cull.rs`): it is in
    /// [`Core::culling`].
    culls: bool,
}

impl Default for ScrollState {
    fn default() -> Self {
        Self {
            horizontal: false,
            // React Native shows scroll indicators by default.
            scrollbar: crate::ScrollbarSetting::Shown,
            bar: None,
            refreshing: false,
            scroll_value: None,
            pull_value: None,
            keyboard_dismiss: KeyboardDismissMode::None,
            content: None,
            content_item: None,
            anchor_geometry: None,
            culled_content: None,
            behavior: ScrollBehavior::default(),
            event_throttle_ms: 0.0,
            zoom: 1.0,
            offset: (0.0, 0.0),
            issued: 0,
            target: None,
            dependents: Vec::new(),
            pending: Vec::new(),
            asked: None,
            page_sticky: Vec::new(),
            view_sticky: Vec::new(),
            culls: false,
        }
    }
}

#[derive(Debug, Default)]
struct InputState {
    value: String,
    /// JS set `value` (or `defaultValue`) at least once.
    value_set: bool,
    /// Edits reported by the platform.
    count: u32,
    /// What the input shows while an input method composes in it: its
    /// value with the composition at the caret, as the platform reports
    /// it ([`Core::input_composing`]). Measured in place of the value, so
    /// a composition that wraps a line grows the input as the text it
    /// commits will; the value and `onChangeText` stay as they are.
    composing: Option<String>,
    /// Everything but the text style, which comes from the node's style.
    config: InputConfig,
    /// Last content box sent to the platform.
    content: Option<Bounds<Points>>,
    /// Last size `onContentSizeChange` reported.
    content_size: Option<Size<Points>>,
    /// The input is measured with its placeholder (its value is empty).
    placeholder_measured: bool,
    /// The size of an empty line in the style of the measured placeholder,
    /// by the placeholder text's `layout_hash`: what `onContentSizeChange`
    /// reports for an empty input.
    empty_line: Option<(u64, Size<Points>)>,
    /// `scrollbar`: a multiline input's bar.
    scrollbar: crate::ScrollbarSetting,
    /// Its built-in bar ([`Core::sync_scrollbars`]), beside it.
    bar: Option<Bar>,
    /// A scroll watch follows it (a bar of the app's own placed beside it,
    /// `watch_scroll`): its platform reports its scrolling as for a
    /// built-in bar ([`Core::sync_watched_inputs`]).
    watched: bool,
    /// How far the platform scrolled its text, while it has a built-in
    /// bar or a watch ([`Core::set_input_scroll`]).
    scroll: Option<InputScroll>,
}

/// A multiline input's scrolling, as its platform reports it.
#[derive(Debug, Clone, Copy, PartialEq)]
struct InputScroll {
    offset: Point<Points>,
    content: Size<Points>,
    viewport: Size<Points>,
}

/// A shader node's props and the layer they make.
#[derive(Debug, Default)]
struct ShaderNode {
    /// `source`, as JS set it.
    source: Option<Arc<str>>,
    /// The program: `source` compiled, or what Rust set.
    shader: Option<crate::shader::Shader>,
    uniforms: crate::shader::ShaderUniforms,
    paused: bool,
    /// What the layer draws: the element it is (`Shader`, `ShaderEffect`, ...).
    role: crate::shader::ShaderRole,
    /// `progress` (effects).
    progress: crate::shader::ShaderProgress,
    /// `maxSampleOffset` (effects and transitions).
    overflow: Points,
    /// `value` (transitions), and the one the transition last showed
    /// (`None` before the first: it starts no transition).
    value: Option<crate::shader::TransitionKey>,
    shown: Option<crate::shader::TransitionKey>,
    /// `duration` in milliseconds (transitions).
    duration: Option<f32>,
    /// `fallback` (transitions).
    fallback: crate::TransitionFallback,
    /// What the platform shows (`None`: nothing, as a view).
    layer: Option<Arc<crate::shader::ShaderLayer>>,
}

/// How long a shader transition runs by default.
const DEFAULT_TRANSITION_MS: f32 = 300.0;

/// How long a page's or a dialog's `transitionShader` runs by default.
const DEFAULT_NAV_SHADER_MS: f32 = 350.0;

/// The role of a shader element's layer.
fn shader_role(tag: Tag) -> Option<crate::shader::ShaderRole> {
    use crate::shader::ShaderRole as R;
    Some(match tag {
        Tag::Shader => R::Fill,
        Tag::ShaderEffect => R::Effect,
        Tag::ShaderTransition => R::Transition,
        Tag::ScreenEffect => R::Screen,
        Tag::ScreenTransition => R::ScreenTransition,
        _ => return None,
    })
}

#[derive(Debug, Default)]
struct ImageState {
    source: Option<ImageSource>,
    options: crate::mount::ImageOptions,
    /// An `svg()` the platform draws as an image: its mount item carries the
    /// text color ([`crate::mount::ImageOptions::current_color`]).
    svg_current_color: bool,
}

/// A style most nodes leave at its default: stored only once set to
/// something else, read through the shared default otherwise.
#[derive(Default)]
struct Sparse<T: 'static>(Option<Box<T>>);

trait SharedDefault: Sized + PartialEq + 'static {
    fn shared_default() -> &'static Self;
}

impl SharedDefault for ViewStyle {
    fn shared_default() -> &'static Self {
        &ViewStyle::DEFAULT
    }
}

impl SharedDefault for TextStyle {
    fn shared_default() -> &'static Self {
        &TextStyle::DEFAULT
    }
}

impl<T: SharedDefault> Sparse<T> {
    fn set(&mut self, value: T) {
        // A node restyled once keeps its box: only a node without one pays
        // for the comparison with the default.
        if let Some(b) = &mut self.0 {
            **b = value;
        } else if value != *T::shared_default() {
            self.0 = Some(Box::new(value));
        }
    }
}

impl<T: SharedDefault> std::ops::Deref for Sparse<T> {
    type Target = T;
    fn deref(&self) -> &T {
        match &self.0 {
            Some(b) => b,
            None => T::shared_default(),
        }
    }
}

impl<T: SharedDefault + std::fmt::Debug> std::fmt::Debug for Sparse<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        (**self).fmt(f)
    }
}

impl<T: SharedDefault> PartialEq<T> for Sparse<T> {
    fn eq(&self, other: &T) -> bool {
        **self == *other
    }
}

struct Node {
    id: NodeId,
    kind: Kind,
    /// Inside a text block: a nested `<text>` span or a raw text run.
    inline: bool,
    parent: Key,
    children: Vec<Key>,
    /// How many levels of views are under it, at most: what an insert
    /// under it raised it to, and what leaves it does not lower
    /// ([`Core::count_heights`] counts them when that matters). At least
    /// one more than each child's.
    height: u32,
    /// Layout node. Present exactly for nodes that render a native view.
    /// Raw text and spans have none.
    layout: Option<LayoutId>,
    /// The style JS set, for kinds whose taffy style is derived from it
    /// and views made overlays by `position: fixed`; for a span, which has
    /// no layout node, what a layout node takes when it is a block again.
    base_layout: Option<Box<taffy::Style>>,
    view_style: Sparse<ViewStyle>,
    text_style: Sparse<TextStyle>,
    /// SVG's paint properties as written on the node (inherited by the
    /// canvases inside it); `None` while it sets none.
    paint: Option<Box<PaintStyle>>,
    animated: Vec<(AnimationProp, crate::animation::NodeId)>,
    /// What a canvas draws.
    drawing: Option<Arc<crate::canvas::Drawing>>,
    /// A shader's program, uniforms and layer.
    shader: Option<Box<ShaderNode>>,
    /// The `style` prop as written, applied over the class styles.
    inline_style: StylePatch,
    /// `class` / `classList` as set.
    class_names: Option<Box<classes::ClassNames>>,
    /// Their parsed form.
    classes: Option<std::rc::Rc<ClassList>>,
    /// Node props the classes set.
    class_props: Option<Box<ClassProps>>,
    /// Interaction states (`tailwind::state` bits).
    states: u16,
    /// States the platform reports for the view.
    tracked: u16,
    /// States it shows as a part of a control (`Prop::ProjectedStates`):
    /// its classes read them with its own, nothing else does.
    projected: u16,
    /// `HOVERED` while a component's hit layer passes a pointer on to it
    /// (`ElementRef::hover_at`): its classes and the `group-hover:`
    /// classes inside it read it with its own states.
    passed_hover: bool,
    /// In a terminal, its fill as it rests, while an interaction state
    /// (hover, press, focus) styles another: the terminal's layout reads
    /// this one, so a hover's fill never moves what is around it.
    resting_fill: Option<Color>,
    /// The `data-*` attributes it shows as a part of a component
    /// (`Prop::ProjectedData`), sorted: its `data-*:` classes read them,
    /// and the `group-data-*:` classes inside it.
    data: Box<[&'static str]>,
    /// What only some nodes have: state styles, the styles of a page's
    /// header or a list's content ([`classes::NodeParts`]).
    parts: Option<Box<classes::NodeParts>>,
    /// A child's classes read their position among siblings.
    positional_children: bool,
    /// Styled with the margin its parent's `space-*` gives it.
    spaced: bool,
    /// The text color it inherits (`None`: React Native's black), CSS's
    /// `currentColor` unless it sets its own.
    inherited_color: Option<Color>,
    /// CSS's `perspective` its style gives its children.
    child_perspective: Option<Points>,
    /// The `ch` its classes were resolved with (`max-w-prose`).
    ch: f32,
    /// Its classes contain a font-relative length.
    reads_ch: bool,
    /// The inherited text color its classes were resolved with
    /// (`currentColor`), and whether it waits in `Core::color_changed`.
    color_used: Option<Color>,
    color_queued: bool,
    /// The [`crate::tailwind::position`] bits its classes were resolved
    /// with (`first:`, `odd:`…); `0` while unplaced or not positional.
    position_used: u8,
    /// Its style says `position: fixed`.
    wants_fixed: bool,
    /// A view made an overlay by `position: fixed` (`overlay.rs` `fix_view`).
    fixed_view: bool,
    /// The built-in bar of the scroll view it is in (`scrollbars.rs`): laid
    /// out on its own over the viewport, not one of the view's children
    /// for their classes.
    decoration: bool,
    /// In a terminal, the sides its layout gives a border Cell (bits: top,
    /// right, bottom, left): the others are mounted without a border, so
    /// the platform draws one exactly where the layout reserved it. `None`
    /// off a terminal: the border as styled.
    cell_border: Option<u8>,
    /// The multiline input a built-in bar is beside, at its frame and just
    /// above it (a bar of a scroll view draws above all of its children).
    beside: Key,
    /// What its view takes from the `pointer-events-*` classes around it
    /// (`classes.rs` `update_pointer_events`); an explicit prop wins.
    class_pointer: crate::props::PointerEvents,
    /// A `pointer-events-auto` is inside it, under a `pointer-events-none`
    /// (scratch of `update_pointer_events`).
    pointer_auto_inside: bool,
    /// `position: sticky`: its insets, where it sticks in the viewport of
    /// the scroll view around it ([`Core::update_sticky_views`]).
    sticky: Option<Box<taffy::Rect<taffy::LengthPercentageAuto>>>,
    /// The element its frame follows (`View::follow`, `follow.rs`).
    follow: Option<Box<follow::Following>>,
    /// `objectFit` (and the `object-*` classes): how its image or video
    /// fits its box.
    object_fit: Option<ResizeMode>,
    /// The inset padding and margin components set: added to the style's.
    insets: Option<Box<[EdgeInsets; 2]>>,
    /// Its padding's and margin's `env()` terms and the insets they came
    /// to when its style was last applied ([`Core::sync_env`]).
    env: Option<Box<(crate::style::EnvEdges, [EdgeInsets; 2])>>,
    events: EventMask,
    /// Keyboard ancestry for a portaled view: its logical parent, when the
    /// native parent it is inserted into differs (`sync_key_parents`).
    key_parent: Option<NodeId>,
    /// `zIndex`: native views are ordered by it (stable) among siblings.
    z_index: i32,
    /// `verticalAlign`: where it sits in its line as an attachment.
    vertical_align: crate::style::VerticalAlign,
    /// `copyText`: what a copy of its text gives in its place as an
    /// attachment (or as the content of a render placed there).
    copy_text: Option<Arc<str>>,
    /// Laid out right to left (the resolved `direction`).
    rtl: bool,
    /// `direction`: `None` inherits.
    direction: Option<bool>,
    /// Start / end properties, if any.
    logical: Option<Box<crate::style::Logical>>,
    /// Touch, accessibility and test properties; most views have none.
    props: Option<Box<ViewProps>>,
    /// Raw text content.
    text: String,
    /// Paragraph settings of a text block or input.
    paragraph: Paragraph,
    image: Option<Box<ImageState>>,
    scroll: Option<Box<ScrollState>>,
    list: Option<Box<ListState>>,
    input: Option<Box<InputState>>,
    /// Screens, modals and header items.
    root: Option<Box<RootState>>,
    /// Switches, sliders, activity indicators, web views and videos.
    control: Option<Box<NativeProps>>,
    /// A registered native component (`<native>`).
    component: Option<Box<ComponentState>>,
    /// Recycling slot (or role) of a list cell.
    slot: Option<CellSlot>,
    /// Animated values driven by gestures on the view.
    gestures: GestureValues,
    /// Keeps pan listeners and values while their native gesture is disabled.
    pan_enabled: bool,
    /// The native view exists.
    created: bool,
    /// Held back in a scroll view's content, out of its window: no native
    /// view, its frame computed all the same (`cull.rs`).
    culled: bool,
    /// The stand-in of an `<Each>` row not rendered yet
    /// ([`Op::Placeholder`]); `row_asked`: JS was asked to render it.
    placeholder: bool,
    row_asked: bool,
    /// Last frame sent to the platform.
    frame: Bounds<Points>,
    /// The area descendants cover outside the bounds, as last mounted
    /// (`MountItem::Overflow`).
    overflow: Option<Bounds<Points>>,
    dirty: u32,
    queued: bool,
    /// In `Core::pending_text`.
    text_queued: bool,
    /// A list cell whose subtree was laid out again this commit.
    relaid: bool,
    /// Where its layout root had the origin of the view around it (its
    /// containing block), unrounded, and the ratio frames were rounded to
    /// ([`Core::frame_ratio`]), when its frame and
    /// its subtree's were last emitted: while nothing in the subtree is laid
    /// out anew, a move of that origin by whole device pixels leaves every
    /// frame in it as it was ([`Core::emit_frames_in`]). `None` until
    /// emitted, or once they must be emitted again.
    emitted: Option<(Origin, taffy::Size<f32>)>,
    /// A view in its subtree is placed in a containing block above it (a
    /// fixed one, or an absolute one in a static parent), so a move of the
    /// subtree can move it in its parent.
    escapes: bool,
    /// A list cell without an item, until the list places it again: it
    /// still shows its last row, so it is hidden from sight, touches and
    /// assistive technology ([`Core::set_spare`]).
    spare: bool,
    /// An attachment of a text inside a hidden span (`visibility:
    /// "hidden"`): hidden with the span's characters, from sight, touches
    /// and assistive technology ([`Core::hide_attachments`]).
    hidden_in_text: bool,
    /// A list cell the render window left behind as the list scrolled: it
    /// shows a row out of the window where that row was laid out last, so
    /// it is left in sight (it is out of it, and soon reused) but hidden
    /// from assistive technology, which reads the window's rows in their
    /// order ([`Core::set_left_behind`]).
    left_behind: bool,
    /// `android={{ elevation }}`.
    elevation: Points,
    /// `ios={{ backdropMaterial }}`.
    backdrop_material: crate::BackdropMaterial,
    /// `macos={{ backdrop }}`.
    macos_backdrop: Option<crate::MacOsBackdrop>,
    /// `windows={{ backdrop }}`.
    windows_backdrop: Option<crate::WindowsBackdrop>,
    /// A text block: its attachments (inline views and images, in text
    /// order) whose native views are inside its own.
    attached: Vec<NodeId>,
    /// What the overlays have it listen to ([`overlay::watch`]): touches
    /// for an overlay's `onPressOutside`, the pointer for a hint's.
    overlay_watched: u8,
    /// Whether a child of it was ever stacked apart (`zIndex`, sticky, a
    /// bar): its native children are placed by rank, not just in order.
    ranked_children: bool,
}

impl Node {
    fn is_overlay(&self) -> bool {
        self.kind == Kind::Overlay || self.fixed_view
    }

    fn is_layout_root(&self) -> bool {
        self.kind.is_root() || self.fixed_view || self.decoration
    }

    /// Its `scrollbar`, for a view that may show a built-in bar.
    fn scrollbar_setting(&self) -> Option<&crate::ScrollbarSetting> {
        match (&self.scroll, &self.input) {
            (Some(scroll), _) => Some(&scroll.scrollbar),
            (None, Some(input)) => Some(&input.scrollbar),
            _ => None,
        }
    }

    /// Its built-in bar.
    fn bar(&self) -> Option<&Bar> {
        match (&self.scroll, &self.input) {
            (Some(scroll), _) => scroll.bar.as_ref(),
            (None, Some(input)) => input.bar.as_ref(),
            _ => None,
        }
    }

    /// Where its built-in bar is kept, for a view that may show one.
    fn bar_slot(&mut self) -> Option<&mut Option<Bar>> {
        match (&mut self.scroll, &mut self.input) {
            (Some(scroll), _) => Some(&mut scroll.bar),
            (None, Some(input)) => Some(&mut input.bar),
            _ => None,
        }
    }

    /// The listeners as platforms take them: a `disabled` view takes no
    /// presses (React Native's `Pressable` / touchables), so it shows no
    /// press feedback either, and opens no context menu: a secondary click
    /// on it goes on to the nearest enabled listener around it.
    fn mounted_events(&self) -> EventMask {
        let mut events = self.events;
        if !self.pan_enabled {
            events.set(EventKind::PanStart, false);
            events.set(EventKind::PanEnd, false);
        }
        if self.overlay_watched != 0 {
            events.set(EventKind::Touch, true);
        }
        if self.states & crate::tailwind::state::DISABLED != 0 {
            for e in DISABLED_OFF {
                events.set(e, false);
            }
        }
        // A disabled view still shows its hint, as the desktops' do.
        if self.overlay_watched & overlay::watch::HINT != 0 {
            events.set(EventKind::MouseEnter, true);
            events.set(EventKind::MouseLeave, true);
        }
        events
    }

    /// Where its native view goes among its siblings': by `zIndex`, then a
    /// sticky view above the others (as above a page's in-flow boxes),
    /// then in order; a built-in scroll bar above all of them (a list's
    /// sticky headers included), as it draws over the viewport.
    fn stack_rank(&self) -> (i32, bool) {
        if self.decoration && self.beside == NO_KEY {
            return (i32::MAX, true);
        }
        (self.z_index, self.sticky.is_some())
    }

    /// The view style as platforms take it: translations by a fraction of
    /// the size resolved with the current frame, a spare list cell hidden.
    fn mounted_view_style(&self) -> Box<ViewStyle> {
        let mut style = Box::new(self.view_style.clone());
        style.elevation = self.elevation;
        style.backdrop_material = self.backdrop_material;
        style.macos_backdrop = self.macos_backdrop;
        style.windows_backdrop = self.windows_backdrop;
        // A list in its parent's viewport is a plain view clipping its
        // cells (a scroll view clips its content).
        if self.list.as_ref().is_some_and(|l| l.parent) {
            style.overflow_hidden = true;
        }
        if self.spare || self.hidden_in_text {
            style.hidden = true;
        }
        if let Some(sides) = self.cell_border {
            let w = &mut style.borders.widths;
            for (bit, side) in [&mut w.top, &mut w.right, &mut w.bottom, &mut w.left]
                .into_iter()
                .enumerate()
            {
                if sides & (1 << bit) == 0 {
                    *side = Points::ZERO;
                }
            }
        }
        // A canvas whose drawing fills with its background shows it there
        // only (`Painter::fill_background_from_view`).
        if self.kind == Kind::Canvas && self.drawing.as_ref().is_some_and(|d| d.paints_background())
        {
            style.background_color = crate::style::Color::TRANSPARENT;
            style.clear_background_images();
        }
        if style.transform.has_fractions() {
            let size = if self.frame.size.width.is_nan() {
                Size::default()
            } else {
                self.frame.size
            };
            style.transform = style.transform.resolve_fractions(size);
        }
        style
    }

    /// The touch, accessibility and test properties as platforms take
    /// them: the `pointer-events-*` classes around it apply unless a prop
    /// says otherwise, a `disabled` view is so for screen readers too (as a
    /// Rust component's `disabled` and React Native's `Pressable`), and
    /// screen readers skip a spare list cell.
    fn mounted_props(&self) -> Box<ViewProps> {
        let mut props = self.props.clone().unwrap_or_default();
        props.overlay_anchor = self
            .root
            .as_ref()
            .and_then(|root| root.overlay.as_ref())
            .and_then(|overlay| overlay.native_anchor);
        props.tab_after = self
            .root
            .as_ref()
            .and_then(|root| root.overlay.as_ref())
            .and_then(|overlay| overlay.tab_after);
        props.key_parent = self.key_parent;
        if props.pointer_events == crate::props::PointerEvents::Auto {
            props.pointer_events = self.class_pointer;
        }
        if self.states & crate::tailwind::state::DISABLED != 0 {
            props.accessibility.state.disabled = true;
        }
        if self.spare || self.hidden_in_text || self.left_behind {
            props.accessibility.hidden = true;
        }
        if let Some(list) = self.list.as_ref().filter(|l| l.parent) {
            props.screen_order = Some(if list.horizontal {
                crate::geometry::Axis::Horizontal
            } else {
                crate::geometry::Axis::Vertical
            });
        }
        props
    }

    fn new(id: NodeId, kind: Kind) -> Self {
        Self {
            id,
            kind,
            inline: false,
            parent: NO_KEY,
            children: Vec::new(),
            height: 0,
            layout: None,
            base_layout: None,
            view_style: Sparse::default(),
            text_style: Sparse::default(),
            paint: None,
            animated: Vec::new(),
            drawing: None,
            shader: matches!(kind, Kind::Shader).then(Box::default),
            inline_style: StylePatch::default(),
            class_names: None,
            classes: None,
            class_props: None,
            states: 0,
            // An input reports its focus from the start (`update_tracking`).
            tracked: if matches!(kind, Kind::Input) {
                crate::tailwind::state::FOCUSED
            } else {
                0
            },
            projected: 0,
            passed_hover: false,
            resting_fill: None,
            data: Box::default(),
            parts: None,
            positional_children: false,
            spaced: false,
            inherited_color: None,
            child_perspective: None,
            ch: 0.0,
            reads_ch: false,
            color_used: None,
            color_queued: false,
            position_used: 0,
            wants_fixed: false,
            fixed_view: false,
            decoration: false,
            cell_border: None,
            beside: NO_KEY,
            class_pointer: crate::props::PointerEvents::Auto,
            pointer_auto_inside: false,
            sticky: None,
            follow: None,
            object_fit: None,
            insets: None,
            env: None,
            events: EventMask::default(),
            key_parent: None,
            z_index: 0,
            vertical_align: crate::style::VerticalAlign::Baseline,
            copy_text: None,
            rtl: false,
            direction: None,
            logical: None,
            props: None,
            text: String::new(),
            paragraph: Paragraph::default(),
            image: matches!(kind, Kind::Image).then(Box::default),
            scroll: matches!(kind, Kind::Scroll | Kind::List).then(Box::default),
            list: matches!(kind, Kind::List).then(|| Box::new(ListState::new())),
            input: matches!(kind, Kind::Input).then(Box::default),
            root: kind.is_root().then(Box::default),
            control: match kind {
                Kind::WebView => Some(NativeProps::WebView(Box::default())),
                Kind::Video => Some(NativeProps::Video(Box::<VideoProps>::default())),
                _ => None,
            }
            .map(Box::new),
            component: matches!(kind, Kind::Native).then(Box::default),
            slot: None,
            gestures: GestureValues::default(),
            pan_enabled: true,
            created: false,
            culled: false,
            placeholder: false,
            row_asked: false,
            frame: Bounds::UNSET,
            overflow: None,
            attached: Vec::new(),
            overlay_watched: 0,
            ranked_children: false,
            elevation: Points::ZERO,
            backdrop_material: crate::BackdropMaterial::default(),
            macos_backdrop: None,
            windows_backdrop: None,
            dirty: 0,
            queued: false,
            text_queued: false,
            relaid: false,
            emitted: None,
            escapes: false,
            spare: false,
            hidden_in_text: false,
            left_behind: false,
        }
    }
}

/// Taffy context of a text block.
struct TextContext<P> {
    text: Arc<AttributedText>,
    sources: SourceMap,
    source_geometry: Option<SourceGeometry>,
    alignments: crate::AttachmentAlignments,
    /// The UTF-16 offsets of the attachments of [`Self::text`] that are
    /// the horizontal padding of a span ([`span_padding`]), not views.
    spacers: Vec<u32>,
    /// `text.layout_hash()`, computed once per content.
    layout_hash: u64,
    /// Platform typesetting state, created on first use.
    prepared: Option<P>,
    /// Natural width of the widest UAX #14 unbreakable segment.
    min_content: Option<Points>,
    /// An input's [`FIELD_SAMPLE`] in its style: what its width comes from
    /// when nothing else gives it one.
    field: Option<Box<TextContext<P>>>,
    /// Last measurement: `(max_width, size)`.
    cache: Option<(Option<f32>, Size<Points>)>,
    /// Last first baseline asked for: `(width, baseline)`
    /// ([`TextEngine::first_baseline`]). Cleared with [`Self::cache`].
    baseline: Option<(f32, Option<Points>)>,
    /// The widths known to break its lines as the last measurement did
    /// ([`TextEngine::breaks_lines_greedily`]).
    same_lines: Option<SameLines>,
    /// Measuring ahead found a line taking another word: a long text finds
    /// one nearly every time, and would be typeset twice per width.
    no_ahead: bool,
    /// The commit of a resize that last found it near the screen
    /// ([`Core::mark_near_screen`]).
    near_screen: u32,
    /// Its size or layout waits for the resize to end.
    held: bool,
    /// In a scroll view's content far from its viewport, with no view yet
    /// (`cull.rs`): measured by an estimate, not typeset.
    deferred: bool,
    /// Its size in the layout is that estimate: measured for real once it
    /// is made.
    estimated: bool,
    /// Last final layout sent to the platform and the content box it was
    /// made for (where in the view the text goes).
    laid_out: Option<LaidText>,
    /// New test metadata must be mounted even when the glyphs are unchanged.
    metadata_changed: bool,
    /// `text-pretty`: a short last line takes words from the lines above
    /// ([`pretty_width`]), with the last width asked for and what it gave
    /// (`NAN` for none). Boxed: few texts say it.
    pretty: Option<Box<(f32, Points)>>,
}

/// A text measures `size` at every maximum width from `narrowest` to
/// `widest`: a width that holds its widest line and is not above the one
/// measured breaks the lines at the same places.
#[derive(Clone, Copy)]
struct SameLines {
    narrowest: f32,
    widest: f32,
    size: Size<Points>,
}

/// How far past a growing width a text is measured, so that the next widths
/// of a window's resize need no typesetting ([`measure_text`]).
const SAME_LINES_AHEAD: f32 = 8.0;

/// The final text can have fitted font sizes, so retain it with its layout.
struct LaidText {
    content: Bounds<Points>,
    layout: TextLayout,
    text: Arc<AttributedText>,
}

impl<P> TextContext<P> {
    fn new(text: Arc<AttributedText>) -> Self {
        Self {
            layout_hash: text.layout_hash(),
            alignments: Default::default(),
            spacers: Vec::new(),
            text,
            sources: SourceMap::default(),
            source_geometry: None,
            prepared: None,
            same_lines: None,
            no_ahead: false,
            near_screen: 0,
            held: false,
            deferred: false,
            estimated: false,
            min_content: None,
            field: None,
            cache: None,
            baseline: None,
            laid_out: None,
            metadata_changed: false,
            pretty: None,
        }
    }
    /// Remount metadata in the same box, keeping any fitted font sizes.
    fn remount_metadata(
        &mut self,
        content: Bounds<Points>,
    ) -> Option<(Arc<AttributedText>, TextLayout)> {
        if !self.metadata_changed {
            return None;
        }
        let laid = self.laid_out.as_mut().filter(|l| l.content == content)?;
        let text = if laid.text.spans == self.text.spans {
            self.text.clone()
        } else {
            // A fitted text draws its scaled spans: the new metadata goes
            // on them.
            let mut text = (*laid.text).clone();
            text.set_metadata(&self.text);
            Arc::new(text)
        };
        laid.text = text.clone();
        self.metadata_changed = false;
        Some((text, laid.layout.clone()))
    }
}

/// What an input is as wide as when nothing gives it a width, whatever it
/// holds: as CSS's `<input size="20">`, twenty digits.
const FIELD_SAMPLE: &str = "00000000000000000000";

/// Measured leaves: text blocks and images with a known natural size.
enum LeafContext<P> {
    Text(TextContext<P>),
    Image(Option<Size<Points>>),
    /// A registered native component's own size, once it reported one.
    Native(Option<Size<Points>>),
}

/// A request for the JS runtime to render list items into cells.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListBind {
    /// The list.
    pub list: NodeId,
    /// `(slot, item index)` pairs.
    pub binds: Vec<(u32, u32)>,
}

/// Takes list `list`'s binds still queued (`Core::list_binds`, a
/// component's list's that a commit's last round asked for), as its items
/// change: the runtime moves its cells with the items before they could
/// run, so they would show items at indices that are no longer theirs. The
/// list asks for its cells again ([`ListState::unrequest`]). Returns their
/// slots.
fn take_queued_binds(binds: &mut Vec<ListBind>, list: NodeId) -> Vec<u32> {
    let mut slots = Vec::new();
    binds.retain(|b| {
        if b.list != list {
            return true;
        }
        slots.extend(b.binds.iter().map(|&(slot, _)| slot));
        false
    });
    slots
}

/// How deep views nest under the root: an insert that would put a view
/// deeper is refused ([`ApplyError::TooDeep`]). Layout, mounting and the
/// walks of the tree recurse once per level, on the native stack, which
/// neither the node quota nor the interpreter's stack limit bounds: without
/// this a chain of views overflows it and aborts the process. Far deeper
/// than a UI nests, and shallow enough for the engine thread's 8 MiB stack
/// in a debug build.
pub const MAX_TREE_DEPTH: usize = 1024;

/// An op referenced a node in an impossible way. This is a renderer bug;
/// the op is skipped and the tree stays consistent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyError {
    /// The id is unknown (never created or already released).
    UnknownNode(NodeId),
    /// The id is already in use.
    DuplicateNode(NodeId),
    /// The child is not a child of the given parent.
    NotAChild(NodeId),
    /// The `before` sibling is not a child of the given parent.
    BadAnchor(NodeId),
    /// The insert would create a cycle.
    Cycle(NodeId),
    /// Creating the node would exceed the node quota ([`Core::set_max_nodes`]).
    TooManyNodes(usize),
    /// The insert would nest views deeper than the depth quota
    /// ([`MAX_TREE_DEPTH`]).
    TooDeep(usize),
    /// A new id far beyond the ids in use (ids index a table, so they must
    /// stay dense).
    IdOutOfRange(NodeId),
}

impl ApplyError {
    /// The app went over a quota or sent what no runtime sends: it should
    /// be stopped rather than continue.
    pub fn is_fatal(&self) -> bool {
        matches!(
            self,
            ApplyError::TooManyNodes(_) | ApplyError::TooDeep(_) | ApplyError::IdOutOfRange(_)
        )
    }
}

/// What [`Core::retag`] knows of the mount items of a round of renders,
/// which only grows at its end until the round is over.
#[derive(Default)]
struct Retags {
    /// The views whose `Create` is among the items looked at.
    made: rustc_hash::FxHashSet<NodeId>,
    /// The items looked at.
    seen: usize,
    /// The views that took another kind, with the number of items then:
    /// their `Create` and `Insert` before that go.
    retagged: rustc_hash::FxHashMap<NodeId, usize>,
}

/// The shadow tree of one surface.
///
/// Feed it [`Op`]s with [`Core::apply`], then call [`Core::commit`] once per
/// JS turn to get the [`MountBatch`] for the platform. Lists may then ask
/// the runtime to render more items ([`Core::take_list_binds`]); the engine
/// runs those and commits again within the same frame.
pub struct Core<M: TextEngine> {
    nodes: Slab<Node>,
    /// Node id -> key + 1 (0 = none). Ids are dense, so this is a flat vec.
    slots: crate::id_table::IdTable<Key>,
    /// The extent reached by admitted ids. JS keeps issuing new ids after a page is freed.
    admitted_id_extent: usize,
    /// Raw text runs kept without a node (#1345): a run not in the tree,
    /// or the only child of a text block or span, which shows it. Any
    /// other use makes its node ([`Core::materialize_run`]).
    runs: rustc_hash::FxHashMap<NodeId, Run>,
    /// Text block or span -> the run it holds in [`Core::runs`].
    folded: rustc_hash::FxHashMap<Key, NodeId>,
    layout: LayoutTree<LeafContext<M::Prepared>>,
    text_engine: Rc<M>,
    /// The engine for [`crate::text::TextGeometry`] (`None` for an engine
    /// that is not `'static`).
    geometry_engine: Option<Rc<dyn crate::text::GeometryEngine>>,
    /// Final layouts kept for Rust components' `on_text_layout` until
    /// their `TextLayout` events are dispatched ([`keep_geometry`]).
    geometries: rustc_hash::FxHashMap<NodeId, crate::text::TextGeometry>,
    measure_cache: MeasureCache,
    /// Counts the commits of resizes ([`Core::mark_near_screen`]).
    resizing_commit: u32,
    /// The next layout follows a change of the viewport, or the text that
    /// waited through a burst of resizes: scroll views keep their place
    /// through it (`resize_anchor`).
    resize_settling: bool,
    /// Text blocks whose final layout must be (re)made after layout.
    pending_text: Vec<Key>,
    /// Text blocks with non-empty `textSource`, for on-demand reading lookup.
    source_texts: Vec<Key>,
    /// Canonical source metadata of text nodes (sparse side table so `Node` stays within its size budget).
    text_sources: rustc_hash::FxHashMap<Key, Arc<crate::TextSource>>,
    /// Lists carrying `ListSourceRows`, for on-demand provider lookup.
    source_providers: Vec<Key>,
    #[cfg(test)]
    pub(super) source_geometry_walks: usize,
    /// Text blocks with attachments (checked for attachments laid out
    /// again).
    attachment_blocks: Vec<Key>,
    /// Live list nodes.
    lists: Vec<Key>,
    /// The lists in their parent's viewport (`viewport="parent"`), outer
    /// ones first ([`Core::resolve_outer`]).
    parent_lists: Vec<Key>,
    /// Views moved in a tree with such lists: their views are found again.
    outer_moved: bool,
    /// Such a list changed length: the commit lays the page out again.
    extent_changed: bool,
    /// Scroll views cull their content ([`Core::set_content_culling`]).
    culls_content: bool,
    /// The scroll views with culled views in their content (`cull.rs`).
    culling: Vec<Key>,
    /// One of them scrolled, or culled a view, since they were looked at.
    cull_dirty: bool,
    /// Culled views were made in this round: their styles go out in
    /// another.
    cull_made: bool,
    /// A list gave the views in a cell their frames in this round, after
    /// culling looked at the scroll views among them (`cull.rs`).
    cells_framed: bool,
    /// The walk of [`Core::sync_culled`], kept for its buffer: each view
    /// with where it is in the scroll view's content and how far the
    /// transforms around it may move it (`cull.rs`).
    cull_scratch: Vec<(Key, f32, f32, f32, f32)>,
    /// How far the animation graph's values may go: how far an animated
    /// transform may move a view culling looks at
    /// (`animation/reach.rs`).
    reach: crate::animation::Reach,
    /// Views out of sight spread over turns (`pace.rs`).
    pace: pace::Pace,
    /// Lists' rows under this turn's layout animation (`list_motion.rs`).
    list_motion: list_motion::ListMotion,
    /// The placeholders of `<Each>` rows ([`Op::Placeholder`]), with their
    /// ids (a key may be another node's by now).
    placeholders: Vec<(Key, NodeId)>,
    /// The placeholders whose rows JS is asked to render next
    /// ([`crate::element::JsEvent::Rows`]).
    asked_rows: Vec<NodeId>,
    /// Placeholders were sized again in this round: laid out again
    /// before culling looks at them.
    placeholders_resized: bool,
    /// The scroll views such lists asked to scroll in this commit.
    outer_asked: Vec<Key>,
    retracted_list_scroll: bool,
    /// The views whose lists' sticky cells changed in this commit.
    sticky_views: Vec<Key>,
    /// Views with `position: sticky` ([`Core::update_sticky_views`]).
    sticky_nodes: Vec<Key>,
    /// The scroll views their ranges were last sent to.
    sticky_scrollers: Vec<Key>,
    /// What makes the views' bars when the app draws them with the
    /// built-in one ([`Core::set_builtin_scrollbars`]).
    builtin_scrollbars: Option<(crate::element::ScrollbarSource, crate::element::AnyValue)>,
    /// Scroll views and lists whose built-in bar may come or go
    /// ([`Core::sync_scrollbars`]).
    scrollbars_pending: Vec<Key>,
    /// The multiline inputs scroll watches follow, sorted
    /// ([`Core::sync_watched_inputs`]).
    watched_inputs: Vec<NodeId>,
    /// Canvases fitting a view box into their box
    /// ([`crate::canvas::ViewPaint::Fit`]) to send once this round's
    /// layout gave them their size ([`Core::send_fitted`]).
    fitted_pending: Vec<Key>,
    /// Scroll views and lists that show a built-in bar.
    decorated: Vec<Key>,
    /// Sticky views came, went or moved: their ranges are worked out
    /// again.
    sticky_changed: bool,
    /// Views whose frame follows an element's ([`Core::place_followers`]).
    followers: Vec<Key>,
    /// Views naming other elements for assistive technologies
    /// ([`Core::sync_relations`]).
    relators: Vec<relations::Relator>,
    /// What they follow, or frames around them, changed since they were
    /// placed.
    follow_changed: bool,
    /// The warning about `bottom` / `right` sticky insets was logged.
    sticky_warned: bool,
    /// The warning about animated insets of views that are not sticky, or
    /// on the axis their scroll view does not scroll, was logged.
    inset_warned: bool,
    /// Compiled shaders by the hash of their source, with their errors
    /// (an app setting the same source again compiles it once).
    shaders: rustc_hash::FxHashMap<u64, Result<crate::shader::Shader, crate::shader::ShaderError>>,
    /// Shader transitions this commit starts ([`MountItem::ShaderTransition`]),
    /// put first in its batch.
    transition_starts: Vec<MountItem>,
    /// The shader views whose layers read pictures (`sample_content`, ...).
    pictured: rustc_hash::FxHashSet<NodeId>,
    /// The parents views left this commit, while any shader reads
    /// pictures: what is above them changed though their mount items no
    /// longer lead there ([`Core::mark_shader_inputs`]).
    unlinked_from: Vec<NodeId>,
    /// Live screens, modals and header items.
    roots: Vec<Key>,
    /// Attached input accessories by `nativeID`.
    accessories: rustc_hash::FxHashMap<Box<str>, NodeId>,
    /// Height of the native header bar of screens: normal and large title.
    header_heights: (Points, Points),
    /// Natural sizes of the platform's controls.
    /// The surface's safe-area insets (stacks at the top extend their
    /// headers under the status bar).
    safe_area: EdgeInsets,
    /// Where the root view's anchored overlays may go, in its coordinates,
    /// when the platform shows them beyond the root view
    /// ([`Core::set_overlay_area`]).
    overlay_bounds: Option<crate::geometry::Bounds<Points>>,
    list_binds: Vec<ListBind>,
    /// The lists keeping items rendered ([`Core::sync_kept`]).
    kept_lists: Vec<Key>,
    /// The nodes of the last [`Core::set_kept`].
    selection_kept: Vec<NodeId>,
    /// The native platform's current focus ancestry ([`Core::set_focus_path`]).
    native_focus_path: Vec<NodeId>,
    /// [`Core::sync_kept`]'s buffer, reused.
    kept_scratch: Vec<Key>,
    /// The runtime's lists with overscan cells waiting to bind
    /// ([`Core::take_paced_list_binds`]), in the order they asked.
    paced_lists: Vec<NodeId>,
    /// [`Core::take_paced_list_binds`]'s buffer, reused.
    paced_scratch: Vec<(u32, u32)>,
    /// The events for JS, in order (the platform's and the core's events,
    /// Rust components' events, calls' results).
    events: Vec<crate::element::JsEvent>,
    /// Reused buffer of `(item index, cell)` for list updates.
    cells_scratch: Vec<(u32, Key)>,
    /// The list cells whose content waits for the app's render functions
    /// this round (sorted; [`Core::cells_awaiting_renders`]): not measured.
    awaiting_renders: Vec<Key>,
    root: Key,
    viewport: Size<Points>,
    mount: Vec<MountItem>,
    track_tree_order: bool,
    tree_order_changed: bool,
    /// The tree changed: the shown overlays' places in the Tab order are
    /// found again ([`Core::order_overlays_for_tab`]).
    tab_places_stale: bool,
    /// A key listener or capture rule changed, or an overlay moved in:
    /// the shown overlays' `key_parent` overrides are found again
    /// ([`Core::sync_key_parents`]).
    key_ancestry_dirty: bool,
    /// Mount the states nodes show as parts of a control
    /// ([`MountItem::ProjectStates`]).
    mount_projected: bool,
    /// Batches handed out so far: tells this batch's mount indexes from
    /// earlier ones'.
    batches: u64,
    /// Component roots taking their kind in this round of renders
    /// ([`Core::retag`]).
    retags: Option<Box<Retags>>,
    /// Imperative calls, run after everything else in the batch.
    commands: Vec<(NodeId, Command)>,
    /// Where the keyboard focus goes back to in this commit, and the popup
    /// it comes back from, unless a `focus()` moves it out of that popup
    /// ([`crate::element::ElementRef::focus_back`]).
    focus_back: Option<(NodeId, Option<NodeId>)>,
    /// The focus the popups that give it back to these nodes opened
    /// with, when a pointer opened them
    /// ([`crate::element::ElementRef::focus_back_origin`]): one per
    /// trigger, its latest opening.
    focus_origins: Vec<(NodeId, Option<(Key, NodeId)>)>,
    /// Animates the layout changes of the next commit.
    layout_animation: Option<LayoutAnimation>,
    /// Nodes whose change animates the frames it moves in the next commit,
    /// or their own frame alone when true (`layout_scope.rs`).
    scoped_layout: Vec<(NodeId, crate::LayoutTransition, bool)>,
    /// Nodes that changed size while `scoped_layout` waits.
    resized: Vec<Key>,
    /// Nodes that lost a child while `scoped_layout` waits.
    restructured: Vec<Key>,
    /// The nodes whose padding or margin uses `env()` (`Node::env`).
    env_styled: rustc_hash::FxHashSet<NodeId>,
    /// Scratch of [`Core::sync_env`].
    env_scratch: Vec<NodeId>,
    /// The keyboard's height changed since the last commit: what that
    /// commit moves (an `env()` term, or a style that reads the keyboard's
    /// height) moves with the keyboard.
    keyboard_moved: bool,
    /// The screens and modals with a `statusBar`, in the order they got
    /// it: few, so attaching and detaching only flag them for the commit.
    status_bar_nodes: Vec<Key>,
    /// The tree changed with `status_bar_nodes` in it: the commit checks
    /// which are in the tree.
    status_bars_moved: bool,
    /// The pages with a `supportedOrientations` (their
    /// [`crate::ModalConfig::PORTRAIT`] bits), in the order they got it.
    orientation_pages: Vec<(Key, u8)>,
    /// What [`Command::Orientations`] last said (0: the app's own).
    orientations_shown: u8,
    /// Nodes whose classes say `pointer-events-none`: without any, moving
    /// nodes skips what CSS's inherited `pointer-events` needs.
    pointer_none_classes: u32,
    /// The tops of the `pointer-events-*` regions that views joined or
    /// left, or whose classes changed, since the last round: worked out
    /// once each, before the round's mount items
    /// ([`Self::flush_pointer_events`]). Worked out on every move, a
    /// region's whole subtree was walked for each view inserted in it (an
    /// editor's highlighted rows: 1600 spans, 2500 views, 10 ms a commit).
    pointer_pending: Vec<Key>,
    /// Views whose hit slop changed since the last round: the areas of the
    /// views around them are worked out again after the layout
    /// ([`Self::update_slop_overflow`]).
    slop_moved: Vec<Key>,
    /// The view with the keyboard focus, by key and id (keys are reused),
    /// as the platform reports it (`classes::focus_reported`).
    focus: Option<(Key, NodeId)>,
    /// The focus and the views around it, innermost first: the views in
    /// `focus-within` (`classes::update_focus_within`).
    focus_chain: Vec<(Key, NodeId)>,
    /// The chain before, reused.
    focus_scratch: Vec<(Key, NodeId)>,
    /// The focus was reported or a view of its chain moved since the
    /// chain was last worked out: the next commit round does it once,
    /// whatever order the reports came in.
    focus_moved: bool,
    /// A view reported losing the focus and none took it since: the chain
    /// waits for the next display frame before it lets go, so a move
    /// that comes as a blur then a focus in two messages, with a commit
    /// between them, is one change of `focus-within`, not a leave and a
    /// new enter.
    blur_held: bool,
    /// The chain changed since the focus watches last looked
    /// (`ElementRef::on_focus_in`).
    focus_within_changed: bool,
    /// What the user last gave the surface input with, as the platform
    /// reports it (`classes::set_input_modality`); `None` before any.
    modality: Option<crate::platform::InputModality>,
    /// The focus shows (`focus-visible:`), decided when it was reported
    /// (`classes::focus_shows`) and again when a key is typed.
    focus_visible: bool,
    /// The keyboard moved the focus, decided when it was reported
    /// (`classes::keyboard_moves_focus`) and kept until it moves again,
    /// whatever is typed meanwhile: only such a focus shows the hint of
    /// the anchor it comes to (`overlay::focus_hints`).
    focus_by_keyboard: bool,
    /// A shown modal closed; focus reports restore context until the next
    /// user action, rather than requesting another hint.
    restoring_modal_focus: bool,
    /// The view in the `FOCUS_VISIBLE` state, by key and id
    /// (`classes::update_focus_visible`).
    focus_visible_on: Option<(Key, NodeId)>,
    /// `focus_visible` changed with the focus staying where it is: the
    /// next commit round moves the state.
    focus_visible_moved: bool,
    /// The parts projected focused (`project_focused`: a tree's or a
    /// list's cursor), by key and id: they show `focus-visible:` while the
    /// focus does, restyled when it starts or stops showing
    /// (`classes::styled_states`).
    projected_focus: Vec<(Key, NodeId)>,
    /// Short completed presses whose `PRESSED` state is held until a
    /// deadline so same-turn tap-to-click gestures still render `:active`.
    pressed_impulses: Vec<(Key, NodeId, crate::time::Instant)>,
    /// The views a pointer passed on into an element is over
    /// (`ElementRef::hover_at`), by element, innermost first.
    passed_hovers: rustc_hash::FxHashMap<NodeId, Vec<NodeId>>,
    /// Nodes whose `position: fixed` changed: made overlays (or views again)
    /// as the commit starts ([`Core::sync_fixed`]).
    fixed_changed: Vec<(Key, NodeId)>,
    /// The advance of each font's `0` (CSS's `ch`), by family, size,
    /// weight and italic.
    zero_advances: rustc_hash::FxHashMap<(Option<crate::style::FontFamily>, u32, u16, bool), f32>,
    /// Nodes with lengths in `ch` styled since the last commit, perhaps
    /// before the views around them (and their fonts) were in place
    /// ([`Core::sync_ch`]).
    ch_styled: Vec<(Key, NodeId)>,
    /// Nodes reading font-relative lengths, so ordinary inserts do no extra walk.
    ch_readers: usize,
    /// Nodes whose inherited text color changed since they were styled
    /// with it (`currentColor`; [`Core::sync_colors`]).
    color_changed: Vec<(Key, NodeId)>,
    /// The user's preferred text size (1.0 is the default).
    font_scale: f32,
    /// The font text is drawn with unless it sets its own: the tokens'
    /// `font-sans` (`None`: the system's), as a page's is Tailwind's
    /// `--font-sans`.
    default_font: Option<crate::style::FontFamily>,
    queue: Vec<Key>,
    needs_layout: bool,
    /// Parsed classes and the theme.
    tailwind: Tailwind,
    /// What class variants read from the environment (`dark` as shown:
    /// [`Core::set_appearance`]).
    class_env: ClassEnvironment,
    /// The appearance the app asked for.
    appearance: crate::platform::Appearance,
    /// The platform reports dark appearance.
    system_dark: bool,
    /// [`Core::set_max_nodes`].
    max_nodes: usize,
    /// Raw text runs may go without nodes ([`Core::runs`]).
    fold_runs: bool,
    /// What the app may reach ([`Core::set_access`]).
    access: Arc<crate::access::Access>,
    /// What media sources starting with `//` resolve against
    /// ([`Core::set_base_url`]).
    base_url: Option<Arc<str>>,
    /// The roots local media files are read under
    /// ([`Core::set_media_files`]).
    media_files: Arc<crate::access::MediaFiles>,
    /// What the check answered for the network images canvases draw, by
    /// source: a canvas checks its images on every draw. Only answers that
    /// depend on nothing but the grant and the base, which clear it when
    /// they change; local files are resolved on every draw.
    canvas_images: rustc_hash::FxHashMap<Arc<str>, Option<Arc<str>>>,
    /// Denials already logged (each once).
    denied: rustc_hash::FxHashSet<String>,
    /// The windows' attribute records, by root node (the main window's is
    /// the root's): what was sent the platform and what was set since.
    windows: rustc_hash::FxHashMap<NodeId, crate::desktop::window::WindowRecord>,
    /// Live non-root nodes with `parent == NO_KEY` (detached or never linked).
    unparented_nodes: usize,
    /// Monotonic counter incremented when a commit leaves newly unparented nodes.
    unparented_seq: u64,
    /// Nodes that entered `parent == NO_KEY` since the last commit settlement.
    newly_unparented: Vec<(Key, NodeId)>,
    /// The windows of the app's own, by the app's id: their root nodes,
    /// and whether their placement is kept.
    window_ids: rustc_hash::FxHashMap<String, (NodeId, bool)>,
    /// When the app quits if its last window closes
    /// ([`DesktopCommand::SetQuitMode`]); [`crate::desktop::QuitMode::Explicit`]
    /// until the host sets one.
    quit_mode: crate::desktop::QuitMode,
    /// nsh.json's `"window"` launch defaults ([`Core::set_main_window`]):
    /// the first app window inherits them, since the host has no visible
    /// window of its own.
    main_window_options: Option<crate::desktop::MainWindowOptions>,
    /// The launch defaults were given to the first window that opened this
    /// run: a later window after every window closed is not the first.
    launch_defaults_applied: bool,
    /// The main window's placement is kept (nsh.json `window.restoreBounds`,
    /// [`Core::set_main_window`]).
    keep_main_placement: bool,
    /// The main window has been on screen, or it opens shown: its reports
    /// are where the user left it ([`Core::keep_window_placement`]).
    main_shown: bool,
    /// Serves the app's clipboard calls in place of the platform
    /// ([`Core::set_clipboard`]).
    clipboard: Option<Arc<dyn crate::clipboard::ClipboardBackend>>,
    /// Answers the app's picks in place of the platform's picker
    /// ([`Core::set_picker`]).
    picker: Option<Arc<dyn crate::picker::PickerBackend>>,
    /// Opens and applies the app's windows of its own in place of the
    /// platform ([`Core::set_window_backend`]).
    window_backend: Option<Arc<dyn crate::desktop::WindowBackend>>,
    /// Recognizes the app's speech in place of the platform
    /// ([`Core::set_speech`]).
    speech: Option<Arc<dyn crate::speech::SpeechBackend>>,
    /// Plays the app's sound in place of the platform ([`Core::set_audio`]).
    audio: Option<Arc<dyn crate::audio::AudioBackend>>,
    /// The app's login item ([`Core::set_login_item`]); without one the app
    /// has none.
    login_item: Option<crate::desktop::LoginItems>,
    /// Rust components and what they rendered.
    components: components::Components,
    /// Overlay nodes, those shown in the order they were shown (the last
    /// on top).
    overlays: Vec<Key>,
    /// What the shown overlays listen to.
    overlay_state: overlay::Overlays,
}

impl<M: TextEngine + 'static> Core<M> {
    /// Creates a core whose root view (id [`ROOT_ID`]) fills `viewport`.
    pub fn new(text_engine: M, viewport: Size<Points>) -> Self {
        let mut core = Self::with_engine(text_engine, viewport);
        core.geometry_engine = Some(core.text_engine.clone());
        // Components that run once measure text with it.
        let engine = core.text_engine.clone();
        core.components
            .runtime
            .set_measure(Rc::new(move |font, text| {
                crate::canvas::line_metrics(&*engine, font, text)
            }));
        core
    }
}

impl<M: TextEngine> Core<M> {
    fn with_engine(text_engine: M, viewport: Size<Points>) -> Self {
        let mut layout = LayoutTree::with_capacity(256);
        let root_layout = layout.new_leaf(root_style(viewport));
        let mut nodes = Slab::with_capacity(256);
        let mut root = Node::new(ROOT_ID, Kind::View);
        root.layout = Some(root_layout);
        // The platform owns the root view.
        root.created = true;
        let root = nodes.insert(root) as Key;
        layout.set_tag(root_layout, root);
        // The root's size is the viewport's, in a terminal too.
        layout.set_role(
            root_layout,
            terminal_layout::Role {
                root: true,
                ..terminal_layout::Role::default()
            },
        );
        let mut slots = crate::id_table::IdTable::new();
        slots.insert(ROOT_ID as usize, root);
        Self {
            nodes,
            admitted_id_extent: slots.extent(),
            slots,
            layout,
            text_engine: Rc::new(text_engine),
            geometry_engine: None,
            geometries: Default::default(),
            measure_cache: MeasureCache::default(),
            resizing_commit: 0,
            resize_settling: false,
            pending_text: Vec::new(),
            source_texts: Vec::new(),
            text_sources: rustc_hash::FxHashMap::default(),
            source_providers: Vec::new(),
            #[cfg(test)]
            source_geometry_walks: 0,
            attachment_blocks: Vec::new(),
            max_nodes: usize::MAX,
            fold_runs: true,
            access: Arc::default(),
            base_url: None,
            media_files: Arc::default(),
            canvas_images: Default::default(),
            denied: Default::default(),
            unparented_nodes: 0,
            unparented_seq: 0,
            newly_unparented: Vec::new(),
            windows: Default::default(),
            window_ids: Default::default(),
            runs: Default::default(),
            folded: Default::default(),
            // Until the host sets one: the app decides (the engine sets
            // nsh.json's mode, `"platform"` by default, before the app runs).
            quit_mode: crate::desktop::QuitMode::Explicit,
            main_window_options: None,
            launch_defaults_applied: false,
            keep_main_placement: false,
            main_shown: false,
            clipboard: None,
            picker: None,
            window_backend: None,
            speech: None,
            audio: None,
            login_item: None,
            components: components::Components::for_viewport(viewport),
            lists: Vec::new(),
            parent_lists: Vec::new(),
            outer_moved: false,
            extent_changed: false,
            culls_content: true,
            culling: Vec::new(),
            cull_dirty: false,
            reach: crate::animation::Reach::default(),
            cull_made: false,
            cells_framed: false,
            cull_scratch: Vec::new(),
            pace: pace::Pace::default(),
            list_motion: list_motion::ListMotion::default(),
            placeholders: Vec::new(),
            asked_rows: Vec::new(),
            placeholders_resized: false,
            outer_asked: Vec::new(),
            retracted_list_scroll: false,
            sticky_views: Vec::new(),
            sticky_nodes: Vec::new(),
            sticky_scrollers: Vec::new(),
            builtin_scrollbars: None,
            scrollbars_pending: Vec::new(),
            watched_inputs: Vec::new(),
            fitted_pending: Vec::new(),
            decorated: Vec::new(),
            sticky_changed: false,
            followers: Vec::new(),
            relators: Vec::new(),
            follow_changed: false,
            sticky_warned: false,
            inset_warned: false,
            shaders: Default::default(),
            transition_starts: Vec::new(),
            pictured: Default::default(),
            unlinked_from: Vec::new(),
            roots: Vec::new(),
            accessories: Default::default(),
            header_heights: (Points(44.0), Points(96.0)),
            safe_area: EdgeInsets::default(),
            overlay_bounds: None,
            list_binds: Vec::new(),
            kept_lists: Vec::new(),
            selection_kept: Vec::new(),
            native_focus_path: Vec::new(),
            kept_scratch: Vec::new(),
            paced_lists: Vec::new(),
            paced_scratch: Vec::new(),
            events: Vec::new(),
            cells_scratch: Vec::new(),
            awaiting_renders: Vec::new(),
            root,
            viewport,
            mount: Vec::new(),
            track_tree_order: false,
            tree_order_changed: false,
            tab_places_stale: false,
            key_ancestry_dirty: false,
            mount_projected: false,
            batches: 0,
            retags: None,
            commands: Vec::new(),
            focus_back: None,
            focus_origins: Vec::new(),
            layout_animation: None,
            scoped_layout: Vec::new(),
            resized: Vec::new(),
            restructured: Vec::new(),
            env_styled: Default::default(),
            env_scratch: Vec::new(),
            keyboard_moved: false,
            status_bar_nodes: Vec::new(),
            status_bars_moved: false,
            orientation_pages: Vec::new(),
            orientations_shown: 0,
            pointer_none_classes: 0,
            pointer_pending: Vec::new(),
            slop_moved: Vec::new(),
            focus: None,
            focus_chain: Vec::new(),
            focus_scratch: Vec::new(),
            focus_moved: false,
            blur_held: false,
            focus_within_changed: false,
            modality: None,
            focus_visible: false,
            focus_by_keyboard: false,
            restoring_modal_focus: false,
            focus_visible_on: None,
            focus_visible_moved: false,
            projected_focus: Vec::new(),
            pressed_impulses: Vec::new(),
            passed_hovers: Default::default(),
            fixed_changed: Vec::new(),
            zero_advances: Default::default(),
            ch_styled: Vec::new(),
            ch_readers: 0,
            color_changed: Vec::new(),
            font_scale: 1.0,
            default_font: None,
            queue: Vec::new(),
            needs_layout: true,
            tailwind: Tailwind::new(),
            class_env: ClassEnvironment::default(),
            appearance: crate::platform::Appearance::System,
            system_dark: false,
            overlays: Vec::new(),
            overlay_state: overlay::Overlays::default(),
        }
    }

    /// Sets the height of the platform's screen header bar, normal and with
    /// a large title (status bar excluded).
    pub fn set_header_heights(&mut self, normal: Points, large: Points) {
        if self.header_heights != (normal, large) {
            self.header_heights = (normal, large);
            self.needs_layout = true;
        }
    }

    /// Sets the surface's safe-area insets.
    pub fn set_safe_area(&mut self, insets: EdgeInsets) {
        if self.safe_area != insets {
            self.safe_area = insets;
            self.needs_layout = true;
        }
    }

    /// Where the root view's anchored overlays may be placed, in its
    /// coordinates, when the platform shows them beyond the root view: the
    /// web's `overlays: "viewport"` draws them over the browser window, so
    /// this is the window's rectangle (less its safe area) relative to the
    /// container. They are placed and flipped within it, less their
    /// `margin`, rather than within the root view's safe area. `None` (the
    /// default) keeps them to the root view. Overlays without an anchor
    /// and those of modals are laid out as before.
    pub fn set_overlay_area(&mut self, area: Option<crate::geometry::Bounds<Points>>) {
        if self.overlay_bounds == area {
            return;
        }
        self.overlay_bounds = area;
        // Their room changed: laid out and placed again. With none shown
        // the next one is placed in it as it shows.
        if self.root_overlay_shown() {
            self.needs_layout = true;
        }
    }

    /// The platform presents root `id` (a modal) at `size`, with `insets`
    /// of it covered by system UI.
    pub fn set_root_size(&mut self, id: NodeId, size: Size<Points>, insets: EdgeInsets) {
        let Ok(key) = self.key(id) else { return };
        if let Some(root) = self.nodes[key as usize].root.as_mut()
            && (root.reported != Some(size) || root.insets != insets)
        {
            root.reported = Some(size);
            root.insets = insets;
            self.needs_layout = true;
        }
    }

    /// The platform measured where the content of screen `id` starts below
    /// the header it shows (`None`: estimate it from the bar's height and
    /// the safe area). Used for screens that lay their content out below
    /// the header (not large titles or transparent headers).
    pub fn set_screen_header(&mut self, id: NodeId, height: Option<Points>) {
        let Ok(key) = self.key(id) else { return };
        let height = height.map(|h| h.0).filter(|h| h.is_finite() && *h >= 0.0);
        if let Some(root) = self.nodes[key as usize].root.as_mut()
            && root.header != height
        {
            root.header = height;
            self.needs_layout = true;
        }
    }

    /// Sets the user's preferred text size (1.0 is the default): text that
    /// allows font scaling is laid out again.
    pub fn set_font_scale(&mut self, scale: f32) {
        let scale = if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        };
        if scale == self.font_scale {
            return;
        }
        self.font_scale = scale;
        self.ch_changed(self.root);
        self.relayout_text();
    }

    /// Sets the font text is drawn with unless it sets its own (the
    /// tokens' `font-sans`): text is laid out again.
    pub(crate) fn set_default_font(&mut self, family: Option<crate::style::FontFamily>) {
        if family == self.default_font {
            return;
        }
        self.default_font = family;
        self.ch_changed(self.root);
        self.relayout_text();
    }

    /// Lays every text and input out again.
    fn relayout_text(&mut self) {
        let blocks: Vec<(Key, Kind)> = self
            .nodes
            .iter()
            .filter(|(_, n)| matches!(n.kind, Kind::Text | Kind::Input) && !n.inline)
            .map(|(k, n)| (k as Key, n.kind))
            .collect();
        for (key, kind) in blocks {
            if kind == Kind::Text {
                self.mark(key, dirty::TEXT_BUILD);
            } else {
                self.measure_input(key);
                self.mark(key, dirty::INPUT);
            }
        }
    }

    /// The pixel ratio went from `old` to `new`: the images whose variant
    /// changes are sent again (their layout does not change).
    fn repick_images(&mut self, old: f32, new: f32) {
        let changes = |s: &Option<ImageSource>| {
            s.as_ref()
                .is_some_and(|s| !s.scales.is_empty() && s.variant(old) != s.variant(new))
        };
        let images: Vec<Key> = self
            .nodes
            .iter()
            .filter(|(_, n)| {
                n.image
                    .as_ref()
                    .is_some_and(|i| changes(&i.source) || changes(&i.options.placeholder))
            })
            .map(|(k, _)| k as Key)
            .collect();
        for key in images {
            self.mark(key, dirty::IMAGE);
        }
    }

    /// Number of live nodes, including the root.
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// How many node ids the core's id table has room for: far above
    /// [`Self::node_count`] when the ids of nodes that are gone still take
    /// room (diagnostics).
    pub fn node_id_room(&self) -> usize {
        self.slots.len()
    }

    /// Sets what the app may reach: remote images, canvas images, video
    /// sources, web views and the status bar are checked against it.
    pub fn set_access(&mut self, access: Arc<crate::access::Access>) {
        // `open_window` checks windows as `Window.open` does.
        {
            let _entered = self.components.runtime.enter();
            crate::element::global::<crate::element::desktop::WindowAccess>()
                .set(crate::element::desktop::WindowAccess(Some(access.clone())));
        }
        self.access = access;
        self.canvas_images.clear();
    }

    /// Sets the URL media sources starting with `//` resolve against, whose
    /// scheme they take (the page's on the web, as `fetch`'s relative
    /// URLs). Without one such a source names no URL, and only an app
    /// without capabilities loads it ([`crate::access::Access::media_url`]).
    /// A base marks a page: with one, `/x` and relative paths are the
    /// page's, not local files, so only pages set one.
    pub fn set_base_url(&mut self, url: Option<Arc<str>>) {
        self.base_url = url;
        self.canvas_images.clear();
    }

    /// Sets the `capabilities.fs.read` roots the app's local media files
    /// (absolute paths, `file:` URLs) are read under; without them such a
    /// source of an app with capabilities loads nothing
    /// ([`crate::access::Access::media_url`]).
    pub fn set_media_files(&mut self, files: Arc<crate::access::MediaFiles>) {
        self.media_files = files;
        self.canvas_images.clear();
    }

    /// Sets what the core's own image loads (an [`crate::element::svg`]'s
    /// bytes) go through: the app's bundled files, access policy and disk
    /// cache. Without it they read inline bytes, files and `asset:/` URIs
    /// of no base only.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn set_image_context(&mut self, context: crate::image::loader::Context) {
        crate::image::loader::set_context(context);
    }

    /// Serves the app's clipboard calls from `backend` instead of the
    /// platform's clipboard (`None`: the platform's, the default).
    pub fn set_clipboard(&mut self, backend: Option<Arc<dyn crate::clipboard::ClipboardBackend>>) {
        self.clipboard = backend;
    }

    /// Answers the app's picks (`Picker.pickImages`) with `backend`, an
    /// embedding app's own picker or a test's files, instead of showing the
    /// platform's picker (`None`: the platform's, the default).
    pub fn set_picker(&mut self, backend: Option<Arc<dyn crate::picker::PickerBackend>>) {
        self.picker = backend;
    }

    /// Sets when the app quits if its last window closes (the desktops'
    /// `"platform"` mode: quit on Windows and Linux, stay on macOS).
    /// `Application.setQuitMode` sets it at run time.
    pub fn set_quit_mode(&mut self, mode: crate::desktop::QuitMode) {
        self.quit_mode = mode;
    }

    /// The main window's launch-time options (nsh.json `"window"`): its
    /// attributes go to the main window with the next commit, as
    /// `currentWindow().set()` sends them (capabilities apply); with
    /// `restoreBounds` its placement is kept from then on as the platform
    /// reports it (the environment's window state), for the next launch
    /// to open it there ([`crate::desktop::MainWindowOptions::kept_placement`]).
    /// Set it after the environment ([`Core::set_environment`]): a surface
    /// without a window, a phone's, takes no attributes.
    pub fn set_main_window(&mut self, options: &crate::desktop::MainWindowOptions) {
        self.main_window_options = Some(options.clone());
        self.keep_main_placement = options.restore_bounds;
        self.main_shown |= options.visible_at_launch();
        if let Some(state) = self.components.environment.window_state {
            self.keep_window_placement(crate::ROOT_ID, &state);
        }
        if options.attributes.is_empty() {
            return;
        }
        let _ = self.apply_op(Op::Command {
            id: crate::ROOT_ID,
            command: Command::Desktop(Box::new(crate::desktop::DesktopCommand::SetAttributes(
                Box::new(options.attributes.clone()),
            ))),
        });
    }

    /// Opens and applies the app's windows of its own with `backend`, an
    /// embedding host's windows or a test's fake, instead of the platform
    /// (`None`: the platform's, the default). The main window's commands
    /// stay with the platform.
    pub fn set_window_backend(&mut self, backend: Option<Arc<dyn crate::desktop::WindowBackend>>) {
        self.window_backend = backend;
    }

    /// Recognizes the app's speech (`Speech.start`) with `backend`, an
    /// embedding app's own recognizer or a test's fake, instead of the
    /// platform's (`None`: the platform's, the default).
    pub fn set_speech(&mut self, backend: Option<Arc<dyn crate::speech::SpeechBackend>>) {
        self.speech = backend;
    }

    /// Plays the app's sound (`Sound`, `AudioPlayer`) with `backend`, an
    /// embedding app's own audio stack or a test's fake, instead of the
    /// platform's (`None`: the platform's, the default).
    pub fn set_audio(&mut self, backend: Option<Arc<dyn crate::audio::AudioBackend>>) {
        self.audio = backend;
    }

    /// Reads and changes the app's login item (`Application.launchAtLogin`)
    /// with `backend`: the platform's, which a standalone app's runner gives,
    /// or a test's fake. `None` (the default): the app has no login item,
    /// it does not launch at login ([`crate::desktop::LoginItemBackend`]).
    pub fn set_login_item(&mut self, backend: Option<Arc<dyn crate::desktop::LoginItemBackend>>) {
        self.login_item = backend.map(crate::desktop::LoginItems::new);
    }

    /// Keeps the app's storage (`nsh/storage`) in `backend`; `None`: in
    /// memory, for the core's life.
    pub fn set_storage(&mut self, backend: Option<Arc<dyn crate::storage::StorageBackend>>) {
        self.components
            .runtime
            .set_storage(crate::storage::Store::new(backend));
    }

    /// The app's own data directory, what [`crate::element::data_dir`]
    /// gives; `None`: it has none.
    pub fn set_data_dir(&mut self, dir: Option<std::path::PathBuf>) {
        self.components.runtime.set_data_dir(dir);
    }

    /// The app as it was built, what [`crate::element::app_info`] answers
    /// (a Rust app's root's, [`crate::element::Root::app_info`]); `None`:
    /// the runner has none (a TSX app's is JS's `appInfo()`).
    pub fn set_app_info(&mut self, info: Option<crate::platform::AppInfo>) {
        self.components.runtime.set_app_info(info);
    }

    /// What Rust code checks for updates with
    /// ([`crate::runtime::prompt_for_update`]); `None`: the app does not
    /// update. A JS app's VM gets its own ([`crate::element::System`]).
    pub fn set_updater(
        &mut self,
        updater: Option<std::sync::Arc<dyn crate::runtime::UpdaterHost>>,
    ) {
        self.components.runtime.set_updater(updater);
    }

    /// Logs (once) that the app was refused `what`.
    fn deny(&mut self, what: String) {
        if self.denied.len() < 256 && self.denied.insert(what.clone()) {
            log::warn!(target: "js", "{what}");
        }
    }

    /// Caps the number of nodes (each may hold a native view, whose memory
    /// no JS heap limit covers): creating more is a fatal [`ApplyError`].
    pub fn set_max_nodes(&mut self, max: usize) {
        self.max_nodes = max.max(1);
    }

    /// A burst of resizes began (`true`) or ended. Meanwhile only text near
    /// the screen is measured and laid out at new widths: what is far from
    /// it keeps its height, and catches up in the commit after the end. A
    /// window's drag gets its frames from what the user sees; a long page
    /// has far more text than the screen shows.
    pub fn set_resizing(&mut self, resizing: bool) {
        if resizing == self.measure_cache.resizing.is_some() {
            return;
        }
        if resizing {
            self.resizing_commit = self.resizing_commit.wrapping_add(1).max(1);
            self.measure_cache.resizing = Some(self.resizing_commit);
            return;
        }
        self.measure_cache.resizing = None;
        let keys: Vec<(Key, LayoutId)> = self
            .nodes
            .iter()
            .filter_map(|(key, node)| Some((key as Key, node.layout?)))
            .collect();
        for (key, layout) in keys {
            let Some(LeafContext::Text(cx)) = self.layout.get_node_context_mut(layout) else {
                continue;
            };
            if std::mem::take(&mut cx.held) {
                self.layout.mark_dirty(layout);
                self.needs_layout = true;
                self.resize_settling = true;
                self.queue_text(key);
            }
        }
    }

    /// Marks the text within a screen's height of the screen, from where
    /// the last commit put the views, for this commit of a resize. A text
    /// it finds after waiting catches up now.
    fn mark_near_screen(&mut self) {
        self.resizing_commit = self.resizing_commit.wrapping_add(1).max(1);
        self.measure_cache.resizing = Some(self.resizing_commit);
        let (width, height) = (self.viewport.width.0, self.viewport.height.0);
        let mut stack = vec![(self.root, 0.0f32, 0.0f32)];
        while let Some((key, x, y)) = stack.pop() {
            let node = &self.nodes[key as usize];
            let frame = node.frame;
            let (mut x, mut y) = (x, y);
            // Not placed yet, or of no size around what overflows it: no
            // telling, so it counts as near.
            // (`Bounds::UNSET` is NaN.)
            if !frame.origin.x.0.is_nan() {
                x += frame.origin.x.0;
                y += frame.origin.y.0;
                let (w, h) = (frame.size.width.0, frame.size.height.0);
                let sized = w > 0.0 && h > 0.0;
                if sized
                    && (x + w < -width || x > 2.0 * width || y + h < -height || y > 2.0 * height)
                {
                    continue;
                }
            }
            if let Some(scroll) = node.scroll.as_deref() {
                x -= scroll.offset.0;
                y -= scroll.offset.1;
            }
            stack.extend(node.children.iter().map(|&child| (child, x, y)));
            if let Some(layout) = node.layout
                && let Some(LeafContext::Text(cx)) = self.layout.get_node_context_mut(layout)
            {
                cx.near_screen = self.resizing_commit;
                if std::mem::take(&mut cx.held) {
                    self.layout.mark_dirty(layout);
                    self.queue_text(key);
                }
            }
        }
    }

    /// Changes the size of the root view.
    pub fn set_viewport(&mut self, viewport: Size<Points>) {
        if viewport != self.viewport {
            self.viewport = viewport;
            self.resize_settling = true;
            let root = self.nodes[self.root as usize].layout.expect("root layout");
            self.layout.set_style(root, root_style(viewport));
            self.needs_layout = true;
            self.restyle_where(crate::tailwind::deps::WIDTH | crate::tailwind::deps::HEIGHT);
            self.components_viewport(viewport);
        }
    }

    /// The platform scrolled a scroll view or list to `(x, y)`, having
    /// applied `applied` of the scrolls the core issued to it
    /// (`MountItem::ScrollBy` and `Command::ScrollTo` of lists).
    pub fn set_scroll_offset(&mut self, id: NodeId, offset: Point<Points>, applied: u32) {
        let (x, y) = (offset.x.0, offset.y.0);
        let Ok(key) = self.key(id) else { return };
        let node = &mut self.nodes[key as usize];
        let horizontal = node.scroll.as_ref().is_some_and(|s| s.horizontal);
        let mut dependents = false;
        let mut moved = false;
        if let Some(scroll) = node.scroll.as_mut() {
            moved = scroll.offset != (x, y);
            scroll.offset = (x, y);
            if scroll.target.is_some_and(|(n, _)| n <= applied) {
                scroll.target = None;
            }
            if !scroll.dependents.is_empty() {
                scroll.pending.retain(|&(n, _)| n > applied);
                dependents = true;
            }
        }
        let reported_moved = node
            .list
            .as_mut()
            .is_some_and(|list| list.reported(if horizontal { x } else { y }, applied));
        self.cull_moved(key);
        if dependents {
            self.dependents_dirty(key);
        }
        if reported_moved && !self.source_texts.is_empty() {
            let range = {
                let node = &self.nodes[key as usize];
                node.list.as_ref().and_then(|list| {
                    let committed_len = node
                        .scroll
                        .as_ref()
                        .and_then(|s| s.content)
                        .map_or_else(|| list.content_len(), |c| c.height.0);
                    list.wants_reading_pin(false, committed_len)
                })
            };
            if let Some((start, end)) = range
                && let Some((point, y)) = self.first_visible_source(key, start, end, false)
            {
                self.nodes[key as usize]
                    .list
                    .as_mut()
                    .expect("list")
                    .set_reading_pin(point, y);
            }
        }
        // Views that follow an element in what it scrolls go with it
        // (`follow.rs`).
        self.follow_changed |= moved && !self.followers.is_empty();
        // A link's hint placed where the pointer came over it would be left
        // behind by the content (`Core::overlay_scrolled`).
        if moved && !self.overlays.is_empty() {
            self.overlay_scrolled(key);
        }
    }

    /// The user moved scroll view `id` with scroll key move `key_move`, which
    /// the platform animates to what it knows of the content. On a list of its
    /// own End queues an animated `scrollToEnd`, in order with the app's
    /// scroll commands, so the list follows its end and rows below that
    /// were never rendered, sized by their estimate, do not stop it short;
    /// a repeat while the list follows its end changes nothing. Any other
    /// key takes back an End not resolved yet and ends the target the list
    /// followed, as the user scrolling away does. Lists in their parent's
    /// viewport and inverted lists are left to the platform.
    pub fn key_scrolled(&mut self, id: NodeId, key_move: crate::scroll::KeyMove) {
        let Ok(key) = self.key(id) else { return };
        let queued = self.commands.iter().filter(|(to, _)| *to == id).count() as u32;
        let Some(list) = self.nodes[key as usize].list.as_mut() else {
            return;
        };
        if !list.follows_end_key() {
            return;
        }
        if key_move == crate::scroll::KeyMove::End {
            // A repeat: the last scroll queued or followed is the end.
            let repeat = match list.key_ends.last() {
                Some(&n) => n + 1 == queued,
                None => queued == 0 && list.follows_end(),
            };
            if !repeat {
                list.key_ends.push(queued);
                self.commands
                    .push((id, Command::ScrollToEnd { animated: true }));
            }
            return;
        }
        list.unpin();
        let ends = std::mem::take(&mut list.key_ends);
        // The latest first, so the places of the earlier ones hold.
        for &n in ends.iter().rev() {
            let at = self
                .commands
                .iter()
                .enumerate()
                .filter(|(_, (to, _))| *to == id)
                .nth(n as usize)
                .map(|(at, _)| at);
            if let Some(at) = at {
                self.commands.remove(at);
            }
        }
    }

    /// Keeps the rows of virtual lists that hold `nodes` rendered, out of
    /// the render window too, until the next call: the ends of a text
    /// selection across a list's rows, whose texts must outlive scrolling
    /// away (a recycled cell would show another row). Replaces the last
    /// call's; none releases them. The rows holding the keyboard focus or
    /// an open overlay are kept anyway ([`Core::sync_kept`]).
    pub fn set_kept(&mut self, nodes: &[NodeId]) {
        self.selection_kept.clear();
        self.selection_kept.extend_from_slice(nodes);
        self.sync_kept();
    }

    /// The native platform's current focus ancestry. Lists consume it only
    /// to keep that existing logical cell alive; the core never chooses focus.
    pub fn set_focus_path(&mut self, path: &[NodeId]) {
        self.native_focus_path.clear();
        self.native_focus_path.extend_from_slice(path);
        self.sync_kept();
    }

    /// Keeps the rows of lists rendered wherever they scroll while they
    /// hold what must outlive scrolling away: [`Core::set_kept`]'s nodes,
    /// the keyboard focus and open overlays (a row's menu or popover). A
    /// recycled cell would show another row, drop the focus and close the
    /// overlay. Each list's kept rows are all that hold one; in a list in
    /// another list's row, both rows are kept. The rows on either side of
    /// the focus's are kept with it, so that the platform's Tab and
    /// Shift+Tab, which only reach views that exist, move on to the next
    /// row in the list rather than past it, however far the window lags
    /// (the row the focus reaches then scrolls into view, which renders
    /// the rows around it).
    fn sync_kept(&mut self) {
        let mut holders = std::mem::take(&mut self.kept_scratch);
        holders.clear();
        holders.extend(
            self.selection_kept
                .iter()
                .chain(&self.native_focus_path)
                .filter_map(|&id| self.key(id).ok()),
        );
        let focus = self
            .focus
            .filter(|&(key, id)| self.nodes.get(key as usize).is_some_and(|n| n.id == id))
            .map(|(key, _)| key);
        holders.extend(focus);
        holders.extend(self.overlays.iter().copied().filter(|&key| {
            self.overlay(key)
                .is_some_and(|o| o.host.is_some() && o.config.hint.is_none())
        }));
        let mut kept: Vec<(Key, u32)> = Vec::new();
        for &holder in &holders {
            let mut key = holder;
            // Up to each cell: an ancestor whose parent is a list holding
            // it in a slot.
            loop {
                let parent = self.nodes[key as usize].parent;
                if parent == NO_KEY {
                    break;
                }
                if let Some(list) = self.nodes[parent as usize].list.as_ref()
                    && let Some(index) = list
                        .slots
                        .iter()
                        .find(|s| s.cell == key)
                        .and_then(|s| s.index)
                {
                    kept.push((parent, index));
                    if focus == Some(holder) {
                        if index > 0 {
                            kept.push((parent, index - 1));
                        }
                        if index + 1 < list.count {
                            kept.push((parent, index + 1));
                        }
                    }
                }
                key = parent;
            }
        }
        self.kept_scratch = holders;
        if kept.is_empty() && self.kept_lists.is_empty() {
            return;
        }
        let mut lists: Vec<Key> = kept.iter().map(|&(list, _)| list).collect();
        lists.sort_unstable();
        lists.dedup();
        for &list in self.kept_lists.iter().filter(|l| !lists.contains(l)) {
            if let Some(state) = self
                .nodes
                .get_mut(list as usize)
                .and_then(|n| n.list.as_mut())
            {
                state.set_kept(Vec::new());
            }
        }
        for &list in &lists {
            let items = kept
                .iter()
                .filter(|&&(l, _)| l == list)
                .map(|&(_, i)| i)
                .collect();
            if let Some(state) = self.nodes[list as usize].list.as_mut() {
                state.set_kept(items);
            }
        }
        self.kept_lists = lists;
    }

    /// The platform scrolled the text of multiline input `id` to `offset`,
    /// its text `content` large in a `viewport` (reported while a built-in
    /// bar or a scroll watch follows it, `InputConfig::report_scroll`).
    pub fn set_input_scroll(
        &mut self,
        id: NodeId,
        offset: Point<Points>,
        content: Size<Points>,
        viewport: Size<Points>,
    ) {
        let Ok(key) = self.key(id) else { return };
        if let Some(input) = self.nodes[key as usize].input.as_mut() {
            input.scroll = Some(InputScroll {
                offset,
                content,
                viewport,
            });
        }
    }

    /// The platform zoomed scroll view `id` to `scale`.
    pub fn set_zoom(&mut self, id: NodeId, scale: f32) {
        let Ok(key) = self.key(id) else { return };
        if let Some(scroll) = self.nodes[key as usize].scroll.as_mut() {
            scroll.zoom = scale;
        }
    }

    /// A registered native component reported its own size: it is laid out
    /// at it where its style leaves a dimension open.
    pub fn set_component_size(&mut self, id: NodeId, size: Size<Points>) {
        let Ok(key) = self.key(id) else { return };
        let Some(layout) = self.nodes[key as usize].layout else {
            return;
        };
        if let Some(LeafContext::Native(own)) = self.layout.get_node_context_mut(layout)
            && *own != Some(size)
        {
            *own = Some(size);
            self.layout.mark_dirty(layout);
            self.needs_layout = true;
        }
    }

    /// What `onScroll` reports for scroll view `id`, if it listens to it:
    /// the minimum milliseconds between events, the content size (zoomed),
    /// the viewport size and the zoom scale.
    pub fn scroll_listener(&self, id: NodeId) -> Option<(f32, Size<Points>, Size<Points>, f32)> {
        let node = &self.nodes[self.key(id).ok()? as usize];
        if !node.events.contains(EventKind::Scroll) {
            return None;
        }
        let scroll = node.scroll.as_ref()?;
        let frame = node.frame.size;
        let content = scroll.content.unwrap_or(frame);
        let z = scroll.zoom;
        Some((scroll.event_throttle_ms, content * z, frame, z))
    }

    /// Moves list render requests produced by the last commit into `out`:
    /// what must bind before the frame shows (cells whose item moved, cells
    /// in the viewport and just ahead of it). The rest of the overscan
    /// waits ([`Core::take_paced_list_binds`]).
    pub fn take_list_binds(&mut self, out: &mut Vec<ListBind>) {
        out.append(&mut self.list_binds);
    }

    /// Whether lists have overscan cells waiting to bind.
    pub fn has_paced_list_binds(&self) -> bool {
        !self.paced_lists.is_empty()
    }

    /// Hands out up to `cells` of the overscan cells waiting to bind, one
    /// per list in turn (a nested list is not starved by its parent), each
    /// list's nearest its leading edge first. What a list assigns now is
    /// what waits: cells it left or whose items went are never handed out.
    pub fn take_paced_list_binds(&mut self, cells: usize, out: &mut Vec<ListBind>) {
        let mut left = cells;
        let mut lists = std::mem::take(&mut self.paced_lists);
        let mut one = std::mem::take(&mut self.paced_scratch);
        let start = out.len();
        while left > 0 && !lists.is_empty() {
            lists.retain(|&id| {
                if left == 0 {
                    return true;
                }
                let Some(list) = self
                    .key(id)
                    .ok()
                    .and_then(|key| self.nodes[key as usize].list.as_mut())
                else {
                    return false;
                };
                one.clear();
                left -= list.take_paced(1, &mut one);
                if let Some((slot, index)) = one.pop() {
                    match out[start..].iter_mut().find(|b| b.list == id) {
                        Some(bind) => bind.binds.push((slot, index)),
                        None => out.push(ListBind {
                            list: id,
                            binds: vec![(slot, index)],
                        }),
                    }
                }
                list.has_paced()
            });
        }
        self.paced_lists = lists;
        self.paced_scratch = one;
    }

    /// Whether events wait for [`Core::take_events`].
    pub fn has_events(&self) -> bool {
        !self.events.is_empty()
    }

    /// Moves what the core hands JS (events it raised, such as
    /// `onLoadMore` and `onLayout`, Rust components' events, calls'
    /// results) into `out`, in order.
    pub fn take_events(&mut self, out: &mut Vec<crate::element::JsEvent>) {
        if !self.asked_rows.is_empty() {
            let rows = std::mem::take(&mut self.asked_rows);
            self.events.push(crate::element::JsEvent::Rows(rows));
        }
        out.append(&mut self.events);
        // The caller hands them to JS before the next commit: what waits for
        // the app's answer to them runs there ([`crate::element::after_answer`]).
        self.components.executor.hand_answers();
    }

    /// Moves queued events into `out` during synchronous input routing,
    /// leaving [`crate::element::after_answer`] closures waiting until the
    /// commit round has rendered the component's pending state.
    pub fn take_emitted_events(&mut self, out: &mut Vec<crate::element::JsEvent>) {
        out.append(&mut self.events);
    }

    /// Whether the next commit runs closures that waited for the app's
    /// answer to events taken already ([`crate::element::after_answer`]):
    /// the engine commits again rather than leave them for later input.
    pub fn has_due_answers(&self) -> bool {
        self.components.executor.has_due_answers()
    }

    /// Registers a custom font (TrueType, OpenType, WOFF or WOFF2 data) with
    /// the text engine. Text measured before is measured again.
    pub fn register_font(&mut self, data: &[u8]) -> Result<(), String> {
        self.text_engine
            .register_font(&crate::text::font_data(data)?)?;
        self.fonts_changed();
        Ok(())
    }

    /// The text engine's fonts changed (a font the platform loads
    /// asynchronously became usable): text measured before is measured
    /// again.
    pub fn fonts_changed(&mut self) {
        self.zero_advances.clear();
        self.ch_changed(self.root);
        self.measure_cache.clear();
        let blocks: Vec<Key> = self
            .nodes
            .iter()
            .filter(|(_, n)| {
                matches!(n.kind, Kind::Text | Kind::Input) && !n.inline && n.layout.is_some()
            })
            .map(|(k, _)| k as Key)
            .collect();
        for key in blocks {
            let layout = self.nodes[key as usize].layout.expect("text layout");
            let cx = self.text_cx(layout);
            cx.prepared = None;
            cx.min_content = None;
            cx.cache = None;
            cx.baseline = None;
            cx.same_lines = None;
            cx.no_ahead = false;
            cx.laid_out = None;
            cx.source_geometry = None;
            if let Some(field) = &mut cx.field {
                field.prepared = None;
                field.cache = None;
            }
            self.layout.mark_dirty(layout);
            self.needs_layout = true;
            if self.nodes[key as usize].kind == Kind::Text {
                self.queue_text(key);
            } else {
                // The platform resolves the input's font again.
                self.mark(key, dirty::INPUT);
            }
        }
    }

    /// The platform's views must get everything again, as new views do, and
    /// text is measured again: the unit the platform converted the values
    /// with changed (Android's density). The views stay, scrolled where they
    /// are.
    pub fn remount(&mut self) {
        self.fonts_changed();
        let keys: Vec<Key> = self
            .nodes
            .iter()
            .filter(|(_, n)| n.created)
            .map(|(k, _)| k as Key)
            .collect();
        for key in keys {
            let flags = self.mount_state(key);
            self.mark(key, flags);
            let node = &mut self.nodes[key as usize];
            if let Some(root) = node.root.as_mut() {
                root.laid_out = None;
            }
            // A scroll view keeps where it is scrolled to: its content size
            // goes again as it is, not as a first one (which would put a
            // right to left one at its right end). A new size from the
            // layout below replaces it ([`Self::set_scroll_content`]).
            let id = node.id;
            if let Some(scroll) = node.scroll.as_mut()
                && let Some(size) = scroll.content
            {
                scroll.content_item = Some((self.batches, self.mount.len()));
                self.mount.push(MountItem::ScrollContent { id, size });
            }
            if let Some(layout) = node.layout {
                // Every frame is sent again.
                self.layout.mark_dirty(layout);
            }
            // Replay pixel-based sticky state without clearing the lists'
            // bookkeeping (which would restack their existing cells).
            // If layout changes the logical ranges, its later item wins.
            let ranges = self.sticky_ranges(key);
            if !ranges.is_empty() {
                self.mount.push(MountItem::StickyCells {
                    id,
                    cells: ranges
                        .into_iter()
                        .map(|r| StickyCell {
                            cell: r.cell,
                            start: Points(r.start),
                            end: Points(r.end),
                            offset: r.offset,
                        })
                        .collect(),
                });
            }
        }
        self.needs_layout = true;
    }

    /// The user edited input `id` (before JS sees the edit): keeps the text
    /// for layout and for stale-value detection.
    pub fn input_changed(&mut self, id: NodeId, text: &str, count: u32) {
        let Ok(key) = self.key(id) else { return };
        let Some(input) = self.nodes[key as usize].input.as_mut() else {
            return;
        };
        input.count = count;
        if input.value != text {
            input.value.clear();
            input.value.push_str(text);
            self.measure_input(key);
        }
    }

    /// An input method composes in input `id`: `shown` is what the input
    /// shows meanwhile (its text with the composition at the caret), `None`
    /// once the composition ends. The input is measured with it, so it
    /// grows as the composition wraps; its value and edit count stay as
    /// they are (the platform reports the committed text as an edit).
    pub fn input_composing(&mut self, id: NodeId, shown: Option<&str>) {
        let Ok(key) = self.key(id) else { return };
        let Some(input) = self.nodes[key as usize].input.as_mut() else {
            return;
        };
        if input.composing.as_deref() == shown {
            return;
        }
        input.composing = shown.map(str::to_owned);
        self.measure_input(key);
    }

    /// Applies one op from JS.
    pub fn apply(&mut self, op: Op) -> Result<(), ApplyError> {
        let _entered = self.components.runtime.enter();
        // Ops on a component's host go to its component, calls of a UI
        // set's modules to the module; the components learn whether JS
        // listens to the back button and JS's shortcuts even before one
        // mounts, so a component's own join them rather than replace them.
        if self.components.instances.is_empty()
            && !matches!(
                op,
                Op::Command {
                    command: Command::Native { .. },
                    ..
                } | Op::Listen {
                    id: ROOT_ID,
                    event: EventKind::BackPress | EventKind::BackProgress | EventKind::KeyCommand,
                    ..
                } | Op::SetProp {
                    id: ROOT_ID,
                    prop: Prop::Keymap(_),
                }
            )
        {
            return self.apply_op(op);
        }
        match self.intercept(op)? {
            Some(op) => self.apply_op(op),
            None => Ok(()),
        }
    }

    /// Applies one op as is (also for the nodes components expand).
    fn apply_op(&mut self, op: Op) -> Result<(), ApplyError> {
        if !self.runs.is_empty()
            && let Op::Evaluate { id, .. }
            | Op::Draw { id, .. }
            | Op::SetStyle { id, .. }
            | Op::SetProp { id, .. }
            | Op::Listen { id, .. }
            | Op::Placeholder { id }
            | Op::Command { id, .. } = op
        {
            self.materialize_run(id)?;
        }
        match op {
            Op::Evaluate {
                id,
                call,
                script,
                timeout,
            } => {
                self.start_js_web_evaluation(id, call, script, timeout);
                Ok(())
            }
            Op::RenderCanvas { call, request } => {
                self.start_js_canvas_render(call, *request);
                Ok(())
            }
            Op::Rust(op) => {
                self.run_rust(op);
                Ok(())
            }
            Op::Create { id, tag } => self.create(id, tag),
            Op::CreateText { id, text } => {
                let idx = id as usize;
                if self.slots.contains(idx) || self.runs.contains_key(&id) {
                    return Err(ApplyError::DuplicateNode(id));
                }
                self.check_id_range(id)?;
                if self.fold_runs {
                    if self.nodes.len().saturating_add(self.runs.len()) >= self.max_nodes {
                        return Err(ApplyError::TooManyNodes(self.max_nodes));
                    }
                    self.runs.insert(
                        id,
                        Run {
                            text,
                            block: NO_KEY,
                        },
                    );
                    self.admitted_id_extent = self.admitted_id_extent.max(idx.saturating_add(1));
                    return Ok(());
                }
                let key = self.alloc(id, Kind::RawText)?;
                self.nodes[key as usize].text = text;
                Ok(())
            }
            Op::SetText { id, text } => {
                if let Some(run) = self.runs.get_mut(&id) {
                    if run.text != text {
                        run.text = text;
                        let block = run.block;
                        if block != NO_KEY {
                            self.mark_text_block(block);
                        }
                    }
                    return Ok(());
                }
                let key = self.key(id)?;
                let node = &mut self.nodes[key as usize];
                if node.text != text {
                    node.text = text;
                    if node.inline {
                        self.mark_text_block(key);
                    }
                }
                Ok(())
            }
            Op::SetStyle { id, style, patch } => self.set_inline_style(id, style, patch),
            Op::SetProp { id, prop } => {
                let role = matches!(
                    prop,
                    Prop::Accessibility(
                        AccessibilityProp::Role(_)
                            | AccessibilityProp::Label(_)
                            | AccessibilityProp::State(_)
                    ) | Prop::Scrollbar(_)
                        | Prop::Horizontal(_)
                );
                let result = self.set_prop(id, prop);
                if role && let Ok(key) = self.key(id) {
                    self.sync_grid_role(key);
                }
                result
            }
            Op::Listen { id, event, enabled } => {
                let key = self.key(id)?;
                let node = &mut self.nodes[key as usize];
                let before = node.events;
                node.events.set(event, enabled);
                if PRESSES.contains(&event) || HANDLED.contains(&event) {
                    self.sync_grid_role(key);
                }
                if event == EventKind::Layout && enabled && !before.contains(event) {
                    self.report_frame(key);
                }
                let node = &self.nodes[key as usize];
                let key_events = matches!(event, EventKind::KeyDown | EventKind::KeyUp);
                if node.events != before {
                    let relink = node.inline && (pressable(before) || pressable(node.events));
                    self.mark(key, dirty::EVENTS);
                    if key_events {
                        self.key_ancestry_dirty = true;
                    }
                    // Pressable spans are part of their block's text.
                    if relink {
                        self.mark_text_block(key);
                    }
                }
                // A list in its parent's viewport scrolls with the view
                // around it: its own scroll events never come.
                if enabled
                    && matches!(
                        event,
                        EventKind::Scroll
                            | EventKind::Refresh
                            | EventKind::ScrollEnd
                            | EventKind::ScrollDragStart
                            | EventKind::ScrollDragEnd
                            | EventKind::MomentumStart
                            | EventKind::MomentumEnd
                    )
                    && self.nodes[key as usize]
                        .list
                        .as_ref()
                        .is_some_and(|l| l.parent)
                {
                    self.warn_ignored(key);
                }
                Ok(())
            }
            Op::Insert {
                parent,
                child,
                before,
            } => self.insert(parent, child, before),
            Op::Remove { parent, child } => {
                let parent = self.key(parent)?;
                if let Some(run) = self.runs.get(&child) {
                    if run.block != parent {
                        return Err(ApplyError::NotAChild(child));
                    }
                    self.unfold_run(child);
                    return Ok(());
                }
                let child = self.key(child)?;
                if self.nodes[child as usize].parent != parent {
                    return Err(ApplyError::NotAChild(self.nodes[child as usize].id));
                }
                self.detach(child);
                Ok(())
            }
            Op::Release { id } => self.release(id),
            Op::Placeholder { id } => {
                let key = self.key(id)?;
                self.placeholder(key);
                Ok(())
            }
            Op::Animation(op) => {
                // A view culled for where its transform may take it may
                // reach further now (`cull.rs`).
                if self.reach.apply(&op) && !self.culling.is_empty() {
                    self.cull_dirty = true;
                }
                self.mount.push(MountItem::Animation(op));
                Ok(())
            }
            Op::Draw { id, mut drawing } => {
                let key = self.key(id)?;
                if self.nodes[key as usize].kind != Kind::Canvas {
                    return Ok(());
                }
                self.check_canvas_images(&mut drawing);
                let node = &mut self.nodes[key as usize];
                let slots_changed = node
                    .drawing
                    .as_ref()
                    .map_or(!drawing.slots.is_empty(), |d| d.slots != drawing.slots);
                if node.drawing.as_deref() == Some(&*drawing) {
                    return Ok(());
                }
                // An empty drawing on a canvas that has drawn nothing shows
                // nothing new (a component's canvas before its first layout).
                if node.drawing.is_none() && drawing.ops.is_empty() && drawing.nodes.is_empty() {
                    return Ok(());
                }
                // Whether the view draws its background (it does not where
                // the drawing fills with it).
                let background_moved = node.drawing.as_ref().is_some_and(|d| d.paints_background())
                    != drawing.paints_background();
                // A drawing fitting a view box lays its canvas out at its
                // natural size, as an image.
                let natural = drawing.fit().map(|fit| fit.size);
                if node
                    .drawing
                    .as_ref()
                    .and_then(|d| d.fit())
                    .map(|fit| fit.size)
                    != natural
                    && let Some(layout) = node.layout
                {
                    self.layout
                        .set_node_context(layout, natural.map(|n| LeafContext::Image(Some(n))));
                    self.layout.mark_dirty(layout);
                    self.needs_layout = true;
                }
                let node = &mut self.nodes[key as usize];
                node.drawing = Some(Arc::from(drawing));
                let flags = dirty::CANVAS
                    | if slots_changed { dirty::ANIMATION } else { 0 }
                    | if background_moved { dirty::VIEW } else { 0 };
                self.mark(key, flags);
                Ok(())
            }
            Op::Command {
                id: crate::ROOT_ID,
                command: Command::LayoutAnimation(animation),
            } => {
                self.layout_animation = Some(animation);
                Ok(())
            }
            // Sent to a node: the frames its change moves.
            Op::Command {
                id,
                command: Command::LayoutAnimation(animation),
            } => {
                self.key(id)?;
                if let Some(transition) = animation.update {
                    self.scope_layout_animation(id, transition);
                }
                Ok(())
            }
            Op::Command {
                id: crate::ROOT_ID,
                command: Command::SetStatusBar(patch),
            } => {
                self.components.status_bars.set_base(patch);
                Ok(())
            }
            // JS's responder blocks native scroll views as the components'
            // does: the core sends both sides' blocks.
            Op::Command {
                id,
                command: Command::SetJsResponder { block },
            } => {
                self.key(id)?;
                self.block_native(touch::Side::Js, block.then_some(id));
                Ok(())
            }
            Op::Command {
                id,
                command: Command::CancelPress,
            } => {
                self.key(id)?;
                self.cancel_press(id);
                Ok(())
            }
            Op::Command {
                command: Command::ClearJsResponder,
                ..
            } => {
                self.block_native(touch::Side::Js, None);
                Ok(())
            }
            // A released node: no layout, but the call is answered.
            Op::Command {
                id,
                command: Command::Measure { call },
            } if self.key(id).is_err() => {
                self.answer_measure(id, call);
                Ok(())
            }
            Op::Command {
                id,
                command: Command::MeasureScrollPosition { call },
            } if self.key(id).is_err() => {
                self.answer_scroll_position(id, call);
                Ok(())
            }
            // A window's attributes go into its record, sent once per
            // commit; opening one is checked and resolved here.
            Op::Command {
                id,
                command: Command::Desktop(desktop),
            } if desktop.is_core_handled() => {
                self.key(id)?;
                self.window_command(id, *desktop);
                Ok(())
            }
            Op::Command { id, command } => {
                self.key(id)?;
                self.commands.push((id, command));
                Ok(())
            }
        }
    }

    /// A command about window `id` (its root node): attributes join its
    /// record ([`Core::flush_windows`] sends what changed), opening one is
    /// checked against the capabilities and resolved, a placement is fitted
    /// on the displays there are.
    fn window_command(&mut self, id: NodeId, command: crate::desktop::DesktopCommand) {
        use crate::desktop::{
            DesktopCommand, WindowPlacement, WindowRequest,
            window::{WindowRecord, placement_key},
        };
        match command {
            // The quit mode reaches past the app's view, as quitting does:
            // a sandboxed app without `application` keeps the platform's.
            DesktopCommand::SetQuitMode(_) if !self.access.allows_application() => {
                self.deny(
                    "the application (its main window, menu, tray, global shortcuts, quitting and restarting) is not granted: add `\"application\": true` to capabilities in nsh.json".into(),
                );
            }
            DesktopCommand::SetAttributes(_) if !self.has_window() => {
                log::debug!("window attributes of view {id}: the surface has no window");
            }
            DesktopCommand::SetAttributes(mut attributes) => {
                attributes.sanitize();
                let denied = self.access.deny_window_attributes(&mut attributes);
                if !denied.is_empty() {
                    self.deny(format!(
                        "nsh/desktop: the window attributes {} are not granted by capabilities.windows: left as they are",
                        denied.join(", ")
                    ));
                }
                // Fitting the content or not lays the window's root out
                // again ([`Core::fit_window`]).
                if attributes.size_to_content.is_some()
                    && let Ok(key) = self.key(id)
                    && let Some(layout) = self.nodes[key as usize].layout
                {
                    self.layout.mark_dirty(layout);
                    self.needs_layout = true;
                }
                self.windows
                    .entry(id)
                    .or_default()
                    .pending
                    .merge(&attributes);
            }
            DesktopCommand::SetQuitMode(mode) => {
                self.quit_mode = mode;
            }
            DesktopCommand::OpenWindow(mut open) => {
                let options = &mut open.options;
                // `Window.open` checked it already and threw; this guards
                // every other way in.
                let open_now = self
                    .window_ids
                    .values()
                    .filter(|(node, _)| *node != id && self.key(*node).is_ok())
                    .count();
                // The first app window of the run inherits nsh.json's
                // `"window"` launch defaults and the host's size: the host is
                // invisible, so those defaults describe the window the app
                // shows first. A later window after every one closed opens
                // as it asked, not as the launch defaults say.
                if !self.launch_defaults_applied {
                    if let Some(defaults) = self.main_window_options.clone() {
                        if options.default_size.is_none() {
                            options.default_size = defaults.default_size;
                        }
                        if options.default_position.is_none() {
                            options.default_position = defaults.default_position;
                        }
                        if options.display.is_none() {
                            options.display = defaults.display;
                        }
                        if options.default_mode.is_none() {
                            options.default_mode = defaults.default_mode;
                        }
                        if !options.restore_bounds {
                            options.restore_bounds = defaults.restore_bounds;
                        }
                        let mut attributes = defaults.attributes;
                        attributes.merge(&options.attributes);
                        options.attributes = attributes;
                    }
                    if let Some(state) = self.components.environment.window_state {
                        if options.default_size.is_none() {
                            options.default_size = Some(state.content_bounds.size);
                        }
                        if options.default_position.is_none() {
                            options.default_position =
                                Some(crate::desktop::WindowPosition::At(state.bounds.origin));
                        }
                    }
                }
                // A released app's implicit first window is the main window
                // it always had, not one of its own: no grant to check.
                if !open.implicit
                    && let Err(message) =
                        self.access
                            .check_window(options.kind, &options.attributes, open_now)
                {
                    self.deny(format!("nsh/desktop: {message}: the window does not open"));
                    return;
                }
                // A refused first window does not consume the launch
                // defaults: the next admitted window still gets them.
                self.launch_defaults_applied = true;
                options.attributes.sanitize();
                options.attributes =
                    crate::desktop::WindowAttributes::resolve(options.kind, &options.attributes);
                // `"main"` is a window id like any other: a parent is the
                // window the registry has open under that id.
                open.parent = options
                    .parent
                    .as_deref()
                    .and_then(|parent| self.window_ids.get(parent).map(|(node, _)| *node));
                if options.restore_bounds {
                    let _entered = self.components.runtime.enter();
                    open.placement = crate::storage::Storage::get_item(&placement_key(&options.id))
                        .and_then(|json| serde_json::from_str::<WindowPlacement>(&json).ok())
                        .map(|p| self.components.runtime.fit_window_placement(p));
                }
                let size = open
                    .placement
                    .map(|p| p.bounds.size)
                    .or(options.default_size);
                self.windows
                    .insert(id, WindowRecord::opened(options.attributes.clone(), size));
                self.window_ids
                    .insert(options.id.clone(), (id, options.restore_bounds));
                self.key_ancestry_dirty = true;
                self.commands.push((
                    id,
                    Command::Desktop(Box::new(DesktopCommand::OpenWindow(open))),
                ));
            }
            // Saved placements go onto the displays there are now, whichever
            // side (Rust or JS) restores them.
            DesktopCommand::Request(WindowRequest::SetPlacement(placement)) => {
                let placement = self.components.runtime.fit_window_placement(placement);
                self.commands.push((
                    id,
                    Command::Desktop(Box::new(DesktopCommand::Request(
                        WindowRequest::SetPlacement(placement),
                    ))),
                ));
            }
            other => self.commands.push((id, Command::Desktop(Box::new(other)))),
        }
    }

    /// Sends each window's attributes that changed since the last commit,
    /// one command per window; forgets the windows whose root is gone.
    fn flush_windows(&mut self) {
        if self.windows.is_empty() {
            return;
        }
        let had_windows = !self.window_ids.is_empty();
        let gone: Vec<NodeId> = self
            .windows
            .keys()
            .copied()
            .filter(|&id| self.key(id).is_err())
            .collect();
        for id in gone {
            self.windows.remove(&id);
            self.window_ids.retain(|_, (node, _)| *node != id);
        }
        // The last window went: the quit mode decides whether that ends the
        // app. The app's own close path has run by now (its root is gone),
        // and the core's listeners had their turn (a Rust listener turning
        // the mode to `"explicit"` keeps the app running). A JS listener
        // runs in a later commit, after this decision: an app that keeps
        // running with no windows sets `quitMode: "explicit"` before the
        // last close, not from `lastWindowClosed`. A listener that opens a
        // window again does so in the next commit, which by then is not the
        // last window (with the mode `"explicit"`).
        if had_windows && self.window_ids.is_empty() {
            self.last_window_closed();
            if self.quit_mode.quits(self.components.environment.os) {
                self.commands.push((
                    ROOT_ID,
                    Command::Desktop(Box::new(crate::desktop::DesktopCommand::Quit)),
                ));
            }
        }
        let mut ids: Vec<NodeId> = self.windows.keys().copied().collect();
        ids.sort_unstable();
        for id in ids {
            let Some(diff) = self.windows.get_mut(&id).and_then(|r| r.take_diff()) else {
                continue;
            };
            // Before the commit's first request to the window, so a window
            // shown in the commit that set `activate: false` is not activated.
            let at = self
                .commands
                .iter()
                .position(|(to, c)| {
                    *to == id
                        && matches!(c, Command::Desktop(d)
                            if matches!(**d, crate::desktop::DesktopCommand::Request(_)))
                })
                .unwrap_or(self.commands.len());
            self.commands.insert(
                at,
                (
                    id,
                    Command::Desktop(Box::new(crate::desktop::DesktopCommand::SetAttributes(
                        Box::new(diff),
                    ))),
                ),
            );
        }
    }

    /// A window that fits its content (`sizeToContent`), the main one or
    /// one of the app's own: its root was laid out at its content's size on
    /// those sides; the window is sized to it when it changes. The platforms do nothing for
    /// it but carry out the request.
    fn fit_window(&mut self, key: Key, layout: LayoutId) {
        let id = self.nodes[key as usize].id;
        let Some(record) = self.windows.get_mut(&id) else {
            return;
        };
        let (width, height) = record.fits();
        if !width && !height {
            record.fitted = None;
            return;
        }
        let laid_out = self.layout.unrounded_layout(layout).size;
        let size = crate::geometry::size(
            Points(laid_out.width.ceil()),
            Points(laid_out.height.ceil()),
        );
        if record.fitted == Some(size) {
            return;
        }
        record.fitted = Some(size);
        self.commands.push((
            id,
            Command::Desktop(Box::new(crate::desktop::DesktopCommand::Request(
                crate::desktop::WindowRequest::SetContentSize {
                    width: width.then_some(size.width),
                    height: height.then_some(size.height),
                },
            ))),
        ));
    }

    /// The size of modal `key`'s root view: what the platform reported
    /// (`set_root_size`), else, for the root of a window of the app's own,
    /// the window's size as the core knows it (its content's with
    /// `sizeToContent`, the placement's or `defaultSize`), else a dialog's
    /// main window's. `None`: a window whose size only its platform knows,
    /// laid out at its content's size until the platform reports it, never
    /// at the main window's.
    pub(crate) fn root_view_size(&self, key: Key) -> Option<Size<Points>> {
        let node = &self.nodes[key as usize];
        if let Some(size) = node.root.as_ref().and_then(|r| r.reported) {
            return Some(size);
        }
        if self.window_ids.values().any(|(id, _)| *id == node.id) {
            return self.windows.get(&node.id).and_then(|r| r.fitted.or(r.size));
        }
        Some(self.viewport)
    }

    /// The window node `key` shows in: the root of the nearest window of
    /// the app's own around it, else the main window ([`ROOT_ID`]).
    pub(crate) fn window_of(&self, key: Key) -> NodeId {
        if self.window_ids.is_empty() {
            return crate::ROOT_ID;
        }
        let mut k = self.nodes[key as usize].parent;
        while k != NO_KEY {
            let n = &self.nodes[k as usize];
            if n.kind == Kind::Modal && self.window_ids.values().any(|(node, _)| *node == n.id) {
                return n.id;
            }
            k = n.parent;
        }
        crate::ROOT_ID
    }

    /// The surface is in a window whose attributes its platform applies: a
    /// desktop's (the OSes `nsh/desktop`'s `isAvailable` answers for), or
    /// a browser's page, whose title is the main window's. A mobile surface
    /// is a view in its app's screen: window attributes have nothing to
    /// apply to there, so none are kept or sent.
    fn has_window(&self) -> bool {
        let os = self.components.environment.os;
        os.is_desktop() || os == crate::platform::Os::Web
    }

    /// Keeps the placement of window `id` (its root node) a platform
    /// reported, when the app asked to restore its bounds. A main window
    /// hidden since launch (`defaultVisible: false`) is not where the user
    /// left it until it first shows: it has yet to take the mode it opens
    /// in, and GTK has yet to size it. Once it has shown, its reports are,
    /// hidden ones too: one hidden right after a move or resize reports
    /// where it was left only then. (A development host's reload starts a
    /// new core: there such a window shown before the reload counts as
    /// hidden since launch until it shows again.)
    pub(crate) fn keep_window_placement(
        &mut self,
        id: NodeId,
        state: &crate::desktop::WindowState,
    ) {
        if id == crate::ROOT_ID {
            self.main_shown |= state.visible;
            if !self.main_shown {
                return;
            }
        }
        let key = if id == crate::ROOT_ID {
            self.keep_main_placement
                .then(|| crate::desktop::window::placement_key("main"))
        } else {
            self.window_ids
                .iter()
                .find(|(_, (node, keep))| *node == id && *keep)
                .map(|(key, _)| crate::desktop::window::placement_key(key))
        };
        let Some(key) = key else {
            return;
        };
        if let Ok(json) = serde_json::to_string(&state.placement) {
            let _entered = self.components.runtime.enter();
            if crate::storage::Storage::get_item(&key).as_deref() != Some(json.as_str()) {
                let _ = crate::storage::Storage::set_item(key, json);
            }
        }
    }

    /// The bottom edge of the logical root's in-flow children, in surface points.
    ///
    /// Read after [`Self::commit`] for settled geometry, from the same frames
    /// reported to layout listeners. Detached layout roots (such as overlays
    /// and modals) and fixed or absolutely positioned children do not contribute.
    /// `None` means there is no laid-out in-flow content. This does not run an
    /// intrinsic-size pass or change the viewport.
    pub fn content_height(&self) -> Option<Points> {
        self.nodes[self.root as usize]
            .children
            .iter()
            .filter_map(|&key| {
                let node = &self.nodes[key as usize];
                let layout = node.layout?;
                if node.is_layout_root()
                    || self.layout.displays_none(layout)
                    || matches!(
                        self.layout.style(layout).position,
                        Position::Absolute | Position::Fixed
                    )
                    || node.frame.origin.y.0.is_nan()
                {
                    return None;
                }
                Some(node.frame.origin.y.0 + node.frame.size.height.0)
            })
            .reduce(f32::max)
            .map(Points)
    }

    /// Finishes a turn: rebuilds text, runs layout, updates lists and
    /// returns the mount items, or `None` when nothing changed.
    pub fn commit(&mut self) -> Option<MountBatch> {
        // The last round's events were dispatched: a geometry no one took
        // is stale (its node went).
        self.geometries.clear();
        // The downloads' file work and deadlines: their events and
        // commands go out with this commit.
        self.poll_downloads();
        // JS has handled the events taken before this commit and its ops
        // are applied: what waited for that sees the app's props, and what
        // it changes renders with them.
        if self.components.executor.has_due_answers() {
            self.run_answers();
        }
        self.pace_commit();
        self.sync_quit_requests();
        self.commit_round();
        // The components' own lists bind the cells the layout asked for
        // here, and lay out again (JS's lists ask JS, through the engine);
        // a list in its parent's viewport that changed length lays the
        // page out again, so it settles in this batch.
        // Views watching scroll views they did not make hear what this
        // round moved, and what they change goes out in this batch too.
        for _ in 0..MAX_VIRTUAL_ROUNDS {
            let watched = self.sync_watches();
            // A built-in bar asked for while this round rendered (the app
            // set its theme) is made in this batch too.
            if !self.bind_virtual_lists()
                && !std::mem::take(&mut self.extent_changed)
                && !watched
                && !std::mem::take(&mut self.cull_made)
                && !std::mem::take(&mut self.placeholders_resized)
                && self.scrollbars_pending.is_empty()
            {
                break;
            }
            self.commit_round();
        }
        if !self.outer_asked.is_empty() {
            self.send_outer_scrolls();
        }
        // What mounted in the rounds listens already.
        if self.sync_quit_requests() {
            self.commit_round();
        }
        self.split_scoped_frames();
        self.mark_shader_inputs();
        if !self.transition_starts.is_empty() {
            // Before the changes they are about: the platform pictures what
            // showed before them.
            let starts = std::mem::take(&mut self.transition_starts);
            self.mount.splice(0..0, starts);
        }
        if std::mem::take(&mut self.tab_places_stale) && !self.overlays.is_empty() {
            self.order_overlays_for_tab();
        }
        if std::mem::take(&mut self.tree_order_changed) {
            let mut order = Vec::new();
            let mut pending = vec![self.root];
            let mut cells = Vec::new();
            while let Some(key) = pending.pop() {
                let node = &self.nodes[key as usize];
                if node.created {
                    order.push(node.id);
                }
                match &node.list {
                    // A list recycles its cells, so they are not in their
                    // rows' order among its children: they go as they are
                    // on screen, along the list's axis, then across it.
                    Some(list) if node.children.len() > 1 => {
                        cells.clear();
                        cells.extend_from_slice(&node.children);
                        let start = |k: &Key| {
                            let at = self.nodes[*k as usize].frame.origin;
                            if list.horizontal {
                                (at.x.0, at.y.0)
                            } else {
                                (at.y.0, at.x.0)
                            }
                        };
                        cells.sort_by(|a, b| {
                            let (a, b) = (start(a), start(b));
                            a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1))
                        });
                        pending.extend(cells.iter().rev().copied());
                    }
                    _ => pending.extend(node.children.iter().rev().copied()),
                }
            }
            self.mount.push(MountItem::TreeOrder(order));
        }
        if std::mem::take(&mut self.retracted_list_scroll) {
            self.mount.retain(|item| {
                !matches!(item, MountItem::ScrollBy { dx, dy, .. } if dx.0 == 0.0 && dy.0 == 0.0)
            });
        }
        let out =
            if self.mount.is_empty() || matches!(self.mount[..], [MountItem::LayoutAnimation(_)]) {
                self.mount.clear();
                None
            } else {
                self.batches += 1;
                Some(MountBatch {
                    items: std::mem::take(&mut self.mount),
                })
            };
        self.settle_unparented();
        out
    }

    fn settle_unparented(&mut self) {
        if self.newly_unparented.is_empty() {
            return;
        }
        let persisted = self.newly_unparented.drain(..).any(|(key, id)| {
            self.nodes
                .get(key as usize)
                .is_some_and(|n| n.id == id && n.parent == NO_KEY)
        });
        if persisted {
            self.unparented_seq = self.unparented_seq.wrapping_add(1);
        }
    }

    /// Number of live non-root nodes currently unattached to the tree
    /// (either unlinked or never inserted).
    pub fn unparented_nodes(&self) -> usize {
        self.unparented_nodes
    }

    /// Monotonic counter advanced whenever a commit leaves newly unparented nodes.
    pub fn unparented_seq(&self) -> u64 {
        self.unparented_seq
    }

    /// Include logical document order in mount batches for a platform's focus traversal.
    /// Native sibling insertions describe paint order and can differ because of `zIndex`.
    pub fn set_tree_order_tracking(&mut self, enabled: bool) {
        self.track_tree_order = enabled;
        self.tree_order_changed = enabled;
    }

    /// Mount the states views show as parts of a control
    /// ([`MountItem::ProjectStates`]: a list's highlighted option, the
    /// code input's next cell) for a platform that marks them itself, as
    /// a terminal does: elsewhere the app's classes alone show them. Set
    /// before the first commit.
    pub fn set_projected_state_mounting(&mut self, enabled: bool) {
        self.mount_projected = enabled;
    }

    /// One round of a commit: views, layout, lists, commands, into the
    /// mount items.
    fn commit_round(&mut self) {
        // Pointers components pass on, onto the layout they were over.
        if !self.components.hovers.is_empty() {
            self.pass_hovers();
        }
        // The built-in scroll bars that come, rendered with the rest.
        if !self.scrollbars_pending.is_empty() {
            self.sync_scrollbars();
        }
        // The views' patches and the views to make first.
        self.render_components();
        self.prepare_reveals();
        // The focus reported since, after the components made and released
        // what they did: one change of the chain, the views both chains
        // share untouched.
        let visible_moved = std::mem::take(&mut self.focus_visible_moved);
        // A blur no focus followed yet waits for the frame (`blur_held`).
        let held = self.blur_held && self.focus.is_none() && !self.focus_chain.is_empty();
        if self.focus_moved && !held {
            self.update_focus_within();
            self.update_focus_visible();
            // The hints the focus came to or left.
            if !self.overlays.is_empty() {
                self.focus_hints();
            }
        } else if visible_moved {
            // A key typed with the focus where it is shows its ring, and no
            // hint: a hint shows only for a focus the keyboard moved.
            self.update_focus_visible();
        }
        self.sync_colors();
        self.sync_ch();
        self.sync_fixed();
        self.sync_overlays();
        if std::mem::take(&mut self.key_ancestry_dirty) {
            self.sync_key_parents();
            self.sync_key_contents();
        }
        // The rows holding the focus or an open overlay stay rendered,
        // before the lists update their windows.
        if self.focus.is_some()
            || !self.native_focus_path.is_empty()
            || !self.overlays.is_empty()
            || !self.kept_lists.is_empty()
        {
            self.sync_kept();
        }
        self.sync_back();
        self.sync_back_progress();
        self.sync_keys();
        // Platforms animate the frames, insertions and removals that follow
        // in the batch; ops may already have queued some.
        self.sync_env();
        if let Some(animation) = self.layout_animation.take() {
            self.note_list_motion(animation);
            self.mount.insert(0, MountItem::LayoutAnimation(animation));
        }
        self.flush_pointer_events();
        if !self.relators.is_empty() {
            self.sync_relations();
        }
        self.flush_dirty();
        let relayout = self.needs_layout;
        if relayout {
            self.needs_layout = false;
            let settling = std::mem::take(&mut self.resize_settling);
            let anchors = if settling || self.measure_cache.resizing.is_some() {
                self.resize_anchors()
            } else {
                Vec::new()
            };
            if self.measure_cache.resizing.is_some() {
                self.mark_near_screen();
            }
            // Boundaries first: what they give back may dirty what is
            // around them, laid out next.
            let relaid = self.relayout_boundaries();
            // Only walk the main tree when it was laid out again (a change
            // inside a list cell leaves it untouched).
            if self.layout_main() {
                let root = self.root;
                let children = std::mem::take(&mut self.nodes[root as usize].children);
                for &child in &children {
                    if !self.nodes[child as usize].is_layout_root() {
                        self.emit_frames(child);
                    }
                }
                self.nodes[root as usize].children = children;
            }
            // Screens and modals, then list cells (lists may live in them).
            self.layout_roots();
            self.layout_cells();
            for key in relaid {
                self.emit_frames(key);
            }
            self.keep_resize_anchors(anchors);
        }
        // Placeholders sized again are laid out again, in another round,
        // before culling looks at them.
        let sized = relayout && !self.placeholders.is_empty() && self.size_placeholders();
        if sized {
            self.cull_dirty = true;
        } else if self.cull_dirty || (relayout && !self.culling.is_empty()) {
            // The views a scroll view culls that came within its window.
            self.sync_culled();
        }
        self.update_lists(relayout);
        // A list gives the views in a cell their frames as it places the
        // cell, after culling looked: a scroll view made in a cell in this
        // round had no frame then, so what it culls waited, and nothing
        // would look at it again before the next layout or scroll (a row
        // bound as a scroll came to rest kept its scroll views empty).
        // Not while placeholders wait for their layout, as above.
        if std::mem::take(&mut self.cells_framed) && !sized && !self.culling.is_empty() {
            self.sync_culled();
        }
        if !self.slop_moved.is_empty() {
            self.update_slop_overflow();
        }
        // Views that waited for the budget, once lists placed their cells
        // (`pace.rs`).
        if !self.pace.waiting.is_empty() {
            self.sync_paced();
        }
        // After every frame of the round: what followers follow is placed.
        self.place_followers(relayout);
        if !self.decorated.is_empty() {
            self.layout_scrollbars();
        }
        if !self.overlays.is_empty() {
            self.place_overlays();
        }
        if !self.fitted_pending.is_empty() {
            self.send_fitted();
        }
        self.flush_text();
        // What this turn's status bar settings add up to, once.
        self.sync_status_bars();
        if let Some(config) = self.components.status_bars.take_changed() {
            self.commands
                .push((crate::ROOT_ID, Command::StatusBar(config)));
        }
        self.sync_orientations();
        // Each window's attributes, once per commit.
        self.flush_windows();
        // The components' measurements, with this commit's layout as JS's.
        for (id, answer) in std::mem::take(&mut self.components.measures) {
            answer.borrow_mut().deliver(self.measure(id));
        }
        for (id, answer) in std::mem::take(&mut self.components.scroll_positions) {
            answer.borrow_mut().deliver(self.list_scroll_position(id));
        }
        // And their transitions' time, with this commit's styles.
        for (id, answer) in std::mem::take(&mut self.components.transition_times) {
            answer.borrow_mut().deliver(self.transition_time(id));
        }
        // And their texts, with this commit's.
        for (id, answer) in std::mem::take(&mut self.components.text_contents) {
            answer.borrow_mut().deliver(self.text_content(id));
        }
        // Into the scroll commands of the scroll views around, in place,
        // with this commit's layout and the scrolls of the commands before.
        if self
            .commands
            .iter()
            .any(|(_, c)| matches!(c, Command::Reveal(_)))
        {
            let mut projected = Vec::new();
            for (id, command) in std::mem::take(&mut self.commands) {
                let commands = match command {
                    Command::Reveal(options) => self.reveal_scrolls(id, options, &projected),
                    command => vec![(id, command)],
                };
                for (id, command) in commands {
                    if let Some(to) = self.scrolled_to(id, &command) {
                        projected.push((id, to));
                    }
                    self.commands.push((id, command));
                }
            }
        }
        // Presses a component passes on, onto this commit's layout.
        for (id, press, answer) in std::mem::take(&mut self.components.presses) {
            let target = self.press_target(id, press.page_position);
            if let Some((node, position)) = target {
                self.events.push(crate::element::JsEvent::Event(
                    node,
                    EventKind::Press,
                    EventPayload::Press(crate::PressEvent { position, ..press }),
                ));
            }
            answer.borrow_mut().deliver(target.is_some());
        }
        // The downloads' listeners as this round's final masks leave them:
        // a web view left with neither of them cancels what it holds, and
        // the cancel commands go out with this batch.
        self.sync_download_listeners();
        // A focus given back yields to one moved out of the popup anywhere
        // in this commit (in this round, or an earlier one's items),
        // whichever came first: the app's choice outranks a popup's
        // closing. A move inside the popup (its items' keys typed ahead of
        // the choice) or to a view that is gone does not.
        if let Some((id, from)) = self.focus_back.take() {
            let origin = self
                .focus_origins
                .iter()
                .position(|&(to, _)| to == id)
                .map(|i| self.focus_origins.swap_remove(i).1);
            let from = from.and_then(|from| self.key(from).ok());
            let moved_out = |to: NodeId| {
                self.key(to)
                    .is_ok_and(|key| from.is_none_or(|from| !self.is_ancestor(from, key)))
            };
            let moved = self
                .commands
                .iter()
                .any(|(to, c)| matches!(c, Command::Focus) && moved_out(*to))
                || self.mount.iter().any(|m| {
                    matches!(
                        m,
                        MountItem::Command {
                            id: to,
                            command: Command::Focus,
                        } if moved_out(*to)
                    )
                });
            if !moved {
                match origin {
                    // Opened by the keyboard (or the app after a key): back
                    // to the trigger the keyboard opened it from.
                    None => self.commands.push((id, Command::Focus)),
                    Some(before) => self.focus_back_to_origin(before, from),
                }
            }
        }
        // On laid out views; dropped for views that were never shown.
        let mut kept = Vec::new();
        for (id, mut command) in std::mem::take(&mut self.commands) {
            // Answered here, with this commit's layout (null for views that
            // are gone or not shown).
            if let Command::Measure { call } = command {
                self.answer_measure(id, call);
                continue;
            }
            if let Command::MeasureScrollPosition { call } = command {
                self.answer_scroll_position(id, call);
                continue;
            }
            let Ok(key) = self.key(id) else {
                // A download command to a node that is gone is dropped; its
                // reply timeout settles the session without ever treating
                // silence as the writer having stopped.
                continue;
            };
            // A culled view is made for it.
            if !self.nodes[key as usize].created
                && !self.uncull(key)
                && !(matches!(
                    command,
                    Command::Focus | Command::Blur | Command::AccessibilityFocus
                ) && self.mounted_link(key))
            {
                continue;
            }
            let node = &self.nodes[key as usize];
            if id != crate::ROOT_ID
                && let Some(backend) = &self.window_backend
                && let Command::Desktop(desktop) = &command
                && desktop.is_window_command()
            {
                backend.command(id, desktop);
                continue;
            }
            // A list in its parent's viewport not placed in its view yet
            // keeps its scroll commands for the update that places it.
            if node.list.as_ref().is_some_and(|l| l.parent)
                && matches!(
                    command,
                    Command::ScrollTo { .. }
                        | Command::ScrollToIndex { .. }
                        | Command::ScrollToEnd { .. }
                )
            {
                kept.push((id, command));
                continue;
            }
            // `Image.getSize` / `prefetch` load what the check granted
            // (`Access::media_url`).
            if let Command::ImageInfo { id: request, uri } = &mut command {
                match self.media_source(uri) {
                    Some(granted) => {
                        if let Some(url) = granted {
                            *uri = url.to_string();
                        }
                    }
                    None => {
                        let message = media_not_granted(
                            "Image.getSize / prefetch of",
                            uri,
                            self.base_url.as_deref(),
                        );
                        self.answer_image_info(*request, Err(message.clone()));
                        self.deny(message);
                        continue;
                    }
                }
            }
            // Menu and tray icons load what the check granted
            // (`Access::media_url`), as an `<Image>` does.
            if let Command::Desktop(desktop) = &mut command {
                self.check_menu_icons(desktop);
            }
            // Lists resolved theirs in `update_lists`; a scroll view can
            // still scroll to its end.
            match &command {
                Command::SetClipboard(_)
                | Command::SetClipboardItem(_)
                | Command::ReadClipboard { .. }
                | Command::SetClipboardImage(_)
                | Command::ReadClipboardImage { .. }
                | Command::ReadClipboardFiles { .. }
                    if !self.access.allows_clipboard() =>
                {
                    if let Command::ReadClipboard { id: request, .. }
                    | Command::ReadClipboardImage { id: request, .. }
                    | Command::ReadClipboardFiles { id: request } = &command
                    {
                        self.answer_clipboard(*request, components::ClipboardAnswer::default());
                    }
                    if matches!(
                        command,
                        Command::SetClipboard(_) | Command::SetClipboardItem(_)
                    ) {
                        self.answer_clipboard_write(crate::element::ClipboardWrite::Failed);
                    }
                    self.deny("the clipboard is not granted: add `\"clipboard\": true` to capabilities in nsh.json".into());
                    continue;
                }
                // A clipboard of the embedder's own answers in place of
                // the platform's.
                Command::SetClipboard(_)
                | Command::SetClipboardItem(_)
                | Command::ReadClipboard { .. }
                | Command::SetClipboardImage(_)
                | Command::ReadClipboardImage { .. }
                | Command::ReadClipboardFiles { .. }
                    if self.clipboard.is_some() =>
                {
                    let clipboard = self.clipboard.clone().expect("a clipboard");
                    match &command {
                        Command::SetClipboard(text) => {
                            clipboard.set_text(Some(text.clone()));
                            self.answer_clipboard_write(crate::element::ClipboardWrite::Written);
                        }
                        Command::SetClipboardItem(item) => {
                            clipboard.set_item(Some(item.clone()));
                            self.answer_clipboard_write(crate::element::ClipboardWrite::Written);
                        }
                        Command::SetClipboardImage(_) => clipboard.set_item(None),
                        Command::ReadClipboard {
                            id: request,
                            has_only,
                        } => {
                            let text = clipboard.text();
                            let answer = components::ClipboardAnswer {
                                has: text.is_some(),
                                text: text.filter(|_| !has_only),
                                ..Default::default()
                            };
                            self.answer_clipboard(*request, answer);
                        }
                        Command::ReadClipboardImage { id: request, .. }
                        | Command::ReadClipboardFiles { id: request } => {
                            self.answer_clipboard(*request, components::ClipboardAnswer::default());
                        }
                        _ => {}
                    }
                    continue;
                }
                // A platform that cannot tell whether the system took a
                // write answers it now; the others report it.
                Command::SetClipboard(_) | Command::SetClipboardItem(_)
                    if !self.components.environment.clipboard_write_result =>
                {
                    self.answer_clipboard_write(crate::element::ClipboardWrite::Requested);
                }
                // Checked before the grants: a host may put the name in a
                // path or a URL, where `user.x/../admin` leaves `user.*`.
                Command::HostCall { name, .. } | Command::HostPost { name, .. } => {
                    if let Some(error) = crate::host_channel::refusal(&self.access, name) {
                        self.deny(error.to_string());
                        if let Command::HostCall { id: call, .. } = command {
                            self.answer_host(call, Err(error));
                        }
                        continue;
                    }
                }
                Command::SendInput(_) if !self.access.allows_web_input() => {
                    self.deny("trusted web view input is not granted: add `\"input\": true` to capabilities.webview in nsh.json".into());
                    continue;
                }
                // As a `src` the capability does not allow: the page is
                // not loaded, so its headers go nowhere.
                Command::Load(load) if !self.access.allows_webview(&load.src) => {
                    self.deny(not_granted("the web page", &load.src, "webview.hosts"));
                    continue;
                }
                Command::StatusBar(_) if !self.access.allows_status_bar() => {
                    self.deny("the status bar is not granted: add `\"statusBar\": true` to capabilities in nsh.json".into());
                    continue;
                }
                // A context menu shows in the app's own view, and the
                // windows the app opens are `capabilities.windows`'
                // (`Access::check_window`): neither needs `application`. The main
                // window, the application menu, the tray, global shortcuts
                // and quitting reach past the app's view and do.
                Command::Desktop(desktop)
                    if !self.access.allows_application()
                        && !matches!(
                            **desktop,
                            crate::desktop::DesktopCommand::PopupMenu { .. }
                                | crate::desktop::DesktopCommand::OpenWindow(_)
                        )
                        && (id == crate::ROOT_ID || !desktop.is_window_command()) =>
                {
                    self.deny("the application (its main window, menu, tray, global shortcuts, quitting and restarting) is not granted: add `\"application\": true` to capabilities in nsh.json".into());
                    continue;
                }
                _ => {}
            }
            let node = &self.nodes[key as usize];
            let id = node.id;
            match command {
                Command::ScrollToEnd { animated } => {
                    let Some(content) = node.scroll.as_ref().and_then(|s| s.content) else {
                        continue;
                    };
                    let horizontal = node.scroll.as_ref().is_some_and(|s| s.horizontal);
                    let frame = node.frame;
                    let (x, y) = if horizontal {
                        (
                            (content.width - frame.size.width).max(Points::ZERO),
                            Points::ZERO,
                        )
                    } else {
                        (
                            Points::ZERO,
                            (content.height - frame.size.height).max(Points::ZERO),
                        )
                    };
                    command = Command::ScrollTo { x, y, animated };
                }
                Command::ScrollToIndex { .. } => continue,
                _ => {}
            }
            // Platforms count the scrolls they applied; lists count theirs.
            if let Command::ScrollTo { x, y, .. } = command
                && self.nodes[key as usize].kind == Kind::Scroll
            {
                let horizontal = self.nodes[key as usize]
                    .scroll
                    .as_ref()
                    .is_some_and(|s| s.horizontal);
                let to = if horizontal { x.0 } else { y.0 };
                self.scroll_issued(key, PendingScroll::To(to));
                if let Some(scroll) = self.nodes[key as usize].scroll.as_mut() {
                    scroll.target = Some((scroll.issued, (x.0, y.0)));
                }
            }
            self.mount.push(MountItem::Command { id, command });
        }
        self.commands.append(&mut kept);
    }

    // Inline links have no native view; their containing text publishes
    // their node IDs as focus targets.
    fn mounted_link(&self, key: Key) -> bool {
        let span = &self.nodes[key as usize];
        if !span.inline || span.kind != Kind::Text {
            return false;
        }
        let mut parent = span.parent;
        while parent != NO_KEY {
            let block = &self.nodes[parent as usize];
            if !block.inline {
                return block.created
                    && block.kind == Kind::Text
                    && block
                        .layout
                        .and_then(|layout| self.layout.get_node_context(layout))
                        .is_some_and(|cx| {
                            matches!(
                                cx,
                                LeafContext::Text(cx)
                                    if cx
                                        .text
                                        .links
                                        .iter()
                                        .any(|link| link.node == span.id && link.start < link.end)
                            )
                        });
            }
            parent = block.parent;
        }
        false
    }

    #[inline]
    fn key(&self, id: NodeId) -> Result<Key, ApplyError> {
        match self.slots.get(id as usize) {
            Some(&k) => Ok(k),
            None => Err(ApplyError::UnknownNode(id)),
        }
    }

    fn check_id_range(&self, id: NodeId) -> Result<(), ApplyError> {
        if id as usize > self.admitted_id_extent.saturating_add(self.max_nodes) {
            return Err(ApplyError::IdOutOfRange(id));
        }
        Ok(())
    }

    fn insert_key(&mut self, idx: usize, key: Key) {
        self.slots.insert(idx, key);
        self.admitted_id_extent = self.admitted_id_extent.max(self.slots.extent());
    }

    fn alloc(&mut self, id: NodeId, kind: Kind) -> Result<Key, ApplyError> {
        let idx = id as usize;
        if self.nodes.len().saturating_add(self.runs.len()) >= self.max_nodes {
            return Err(ApplyError::TooManyNodes(self.max_nodes));
        }
        self.check_id_range(id)?;
        if self.slots.contains(idx) || self.runs.contains_key(&id) {
            return Err(ApplyError::DuplicateNode(id));
        }
        let key = self.nodes.insert(Node::new(id, kind)) as Key;
        self.insert_key(idx, key);
        self.unparented_nodes += 1;
        self.newly_unparented.push((key, id));
        Ok(key)
    }

    /// Makes `alias` another name of node `id`: a component whose view's
    /// root is another component makes that one on its own host, under a
    /// name of its own (the nested component's host), with no node of its
    /// own. What the core sends names the node by its own id.
    pub(super) fn alias(&mut self, alias: NodeId, id: NodeId) -> Result<(), ApplyError> {
        let key = self.key(id)?;
        let idx = alias as usize;
        self.check_id_range(alias)?;
        if self.slots.contains(idx) {
            return Err(ApplyError::DuplicateNode(alias));
        }
        self.insert_key(idx, key);
        Ok(())
    }

    /// Whether `id` is another name of a node ([`Self::alias`]).
    pub(super) fn is_alias(&self, id: NodeId) -> bool {
        self.key(id).is_ok_and(|k| self.nodes[k as usize].id != id)
    }

    /// Forgets alias `id` (its node stays).
    pub(super) fn unalias(&mut self, id: NodeId) {
        if self.is_alias(id) {
            self.slots.remove(id as usize);
        }
    }

    /// The id node `id` has natively (another for an alias).
    pub(super) fn native_id(&self, id: NodeId) -> NodeId {
        self.key(id).map_or(id, |k| self.nodes[k as usize].id)
    }

    fn create(&mut self, id: NodeId, tag: Tag) -> Result<(), ApplyError> {
        let kind = Kind::of(tag);
        let key = self.alloc(id, kind)?;
        let mut style = crate::style::unstyled_layout();
        if let Some(role) = shader_role(tag) {
            self.nodes[key as usize]
                .shader
                .as_mut()
                .expect("a shader node")
                .role = role;
            if matches!(
                role,
                crate::shader::ShaderRole::Screen | crate::shader::ShaderRole::ScreenTransition
            ) {
                // A screen's effect takes no space: the surface is its box.
                style.position = taffy::Position::Absolute;
                style.size = taffy::Size {
                    width: taffy::Dimension::length(0.0),
                    height: taffy::Dimension::length(0.0),
                };
            }
        }
        let layout = match leaf_context(kind) {
            Some(context) => self.layout.new_leaf_with_context(style.clone(), context),
            None => self.layout.new_leaf(style.clone()),
        };
        self.layout.set_tag(layout, key);
        self.nodes[key as usize].layout = Some(layout);
        self.sync_grid_role(key);
        self.became(key, style);
        if kind == Kind::WebView && !self.components.environment.web_views {
            self.web_view_unavailable(id);
        }
        Ok(())
    }

    /// A web view on a platform that shows none fails at once (`onError`
    /// with `code` `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`). Always reported:
    /// the `onError` listener is set after the node is made.
    fn web_view_unavailable(&mut self, id: NodeId) {
        self.events.push(crate::element::JsEvent::Event(
            id,
            EventKind::Error,
            EventPayload::Map(vec![
                (
                    "message",
                    PayloadValue::Str("web views are not available on this platform".into()),
                ),
                (
                    "code",
                    PayloadValue::Str(crate::element::codes::UNAVAILABLE.into()),
                ),
            ]),
        ));
    }

    /// Whether node `key` is a control: a view with a control's
    /// accessibility role, one that takes presses, or a text input. On a
    /// grid surface a control is laid out one line of its content high
    /// ([`grid`]).
    fn is_control(&self, key: Key) -> bool {
        use crate::AccessibilityRole as R;
        let node = &self.nodes[key as usize];
        node.kind == Kind::Input
            || (!node.inline && pressable(node.events))
            || node.props.as_ref().is_some_and(|p| {
                matches!(
                    p.accessibility.role,
                    R::Button
                        | R::ImageButton
                        | R::Link
                        | R::Search
                        | R::Checkbox
                        | R::Radio
                        | R::Switch
                        | R::Tab
                        | R::Menuitem
                        | R::MenuItemCheckbox
                        | R::MenuItemRadio
                        | R::Option
                        | R::Combobox
                        | R::Adjustable
                        | R::Spinbutton
                )
            })
    }

    /// What a terminal's layout takes from node `key` besides its style
    /// ([`terminal_layout::Role`]): whether it is a control
    /// ([`Self::is_control`]), a text, a scroll view, and whether a
    /// terminal leaves it out: what it cannot show at an icon's size is
    /// left out, never emulated (icon-sized videos, web views, shaders and
    /// canvases); larger, they keep their box, as images do at every size.
    fn grid_role(&self, key: Key) -> terminal_layout::Role {
        let kind = self.nodes[key as usize].kind;
        let left_out = match kind {
            // A native component draws itself where the platform
            // registered one, and is blank where it did not.
            Kind::Image => terminal_layout::LeftOut::Picture,
            Kind::Video | Kind::WebView | Kind::Shader | Kind::Canvas => {
                terminal_layout::LeftOut::IfIcon
            }
            _ => terminal_layout::LeftOut::No,
        };
        let control = self.is_control(key);
        // A control's label in columns, one per character: what it shows
        // when all its content is left out (an icon button).
        let label = control
            .then(|| self.nodes[key as usize].props.as_ref())
            .flatten()
            .map_or(0, |p| {
                // A popup's trigger (its `expanded` set) shows as one
                // chevron, `▾` or `▴`, in place of its label.
                if p.accessibility.state.expanded.is_some() {
                    return 1;
                }
                p.accessibility.label.as_deref().map_or(0, |l| {
                    l.trim().chars().count().min(u16::MAX as usize) as u16
                })
            });
        let node = &self.nodes[key as usize];
        let view = &node.view_style;
        let c = view.corner_radius;
        let radius = [c.top_left, c.top_right, c.bottom_right, c.bottom_left]
            .into_iter()
            .map(|r| r.unwrap_or(view.border_radius).0)
            .fold(0.0, f32::max);
        let w = view.borders.widths;
        let border_color = [w.top, w.right, w.bottom, w.left]
            .iter()
            .position(|&v| v > Points::ZERO)
            .map_or(crate::Color::TRANSPARENT, |i| view.borders.colors[i]);
        // A text's characters other than white space, which an absolute
        // box pinned over it would hide.
        let glyphs = kind == Kind::Text
            && node
                .layout
                .and_then(|l| self.layout.get_node_context(l))
                .is_some_and(|cx| match cx {
                    LeafContext::Text(cx) => cx.text.text.chars().any(|ch| !ch.is_whitespace()),
                    _ => false,
                });
        // A text with a letter or a digit: a word, not a mark.
        let worded = kind == Kind::Text
            && node
                .layout
                .and_then(|l| self.layout.get_node_context(l))
                .is_some_and(|cx| match cx {
                    LeafContext::Text(cx) => cx.text.text.chars().any(char::is_alphanumeric),
                    _ => false,
                });
        // A text of limited lines, cut short with `…` when it has no room.
        let clamped = kind == Kind::Text
            && node
                .layout
                .and_then(|l| self.layout.get_node_context(l))
                .is_some_and(|cx| match cx {
                    LeafContext::Text(cx) => cx.text.max_lines > 0,
                    _ => false,
                });
        let disclosure = control
            && self.nodes[key as usize].props.as_ref().is_some_and(|p| {
                p.accessibility.state.expanded.is_some() && !p.accessibility.state.has_popup
            });
        // A text that shows a disclosure's mark itself (`▸ Storage`).
        let marked = kind == Kind::Text
            && node
                .layout
                .and_then(|l| self.layout.get_node_context(l))
                .is_some_and(|cx| match cx {
                    LeafContext::Text(cx) => {
                        cx.text.text.trim_start().starts_with(['▸', '▾', '▹', '▿'])
                    }
                    _ => false,
                });
        terminal_layout::Role {
            control,
            label,
            disclosure,
            marked,
            text: matches!(kind, Kind::Text | Kind::Input),
            scroll: matches!(kind, Kind::Scroll | Kind::List),
            root: key == self.root,
            fills: matches!(kind, Kind::Screen | Kind::Modal),
            sized: matches!(
                kind,
                Kind::Native
                    | Kind::List
                    | Kind::Image
                    | Kind::Video
                    | Kind::WebView
                    | Kind::Shader
            ),
            input: kind == Kind::Input,
            glyphs,
            worded,
            clamped,
            radius,
            fill: node.resting_fill.unwrap_or(view.background_color),
            interactive: {
                let events = self.nodes[key as usize].events;
                pressable(events) || HANDLED.iter().any(|&e| events.contains(e))
            },
            animated_fill: self.nodes[key as usize]
                .animated
                .iter()
                .any(|(p, _)| matches!(p, AnimationProp::BackgroundColor)),
            border_color,
            splitter: match view.cursor {
                crate::Cursor::ColResize => terminal_layout::Splitter::Columns,
                crate::Cursor::RowResize => terminal_layout::Splitter::Rows,
                _ => terminal_layout::Splitter::No,
            },
            left_out,
            overlay: kind == Kind::Overlay,
            meter: node.props.as_ref().is_some_and(|p| {
                p.accessibility.role == crate::element::AccessibilityRole::Progressbar
            }),
            // The platform's indicator: none where the app hides it or
            // its own built-in bar takes its place.
            indicator: match node.scroll.as_deref() {
                Some(scroll)
                    if scroll.scrollbar != crate::ScrollbarSetting::Hidden
                        && scroll.bar.is_none() =>
                {
                    if scroll.horizontal {
                        terminal_layout::Indicator::Horizontal
                    } else {
                        terminal_layout::Indicator::Vertical
                    }
                }
                _ => terminal_layout::Indicator::No,
            },
        }
    }

    /// Tells the layout what its grid takes from node `key`
    /// ([`Self::grid_role`]).
    fn sync_grid_role(&mut self, key: Key) {
        if let Some(layout) = self.nodes[key as usize].layout {
            let was_hidden = self.layout.displays_none(layout);
            let role = self.grid_role(key);
            if self.layout.set_role(layout, role) {
                self.needs_layout = true;
                self.sync_layout_hidden(key, was_hidden);
            }
        }
    }

    #[inline]
    pub(super) fn sync_layout_hidden(&mut self, key: Key, was_hidden: bool) {
        let node = &self.nodes[key as usize];
        if node.created
            && node
                .layout
                .is_some_and(|l| self.layout.displays_none(l) != was_hidden)
        {
            self.mark(key, dirty::VIEW);
        }
    }

    /// What a node of its kind needs once made, its layout style `style`.
    fn became(&mut self, key: Key, style: taffy::Style) {
        let kind = self.nodes[key as usize].kind;
        let node = &mut self.nodes[key as usize];
        if kind == Kind::Text {
            node.dirty |= dirty::TEXT_BUILD;
        }
        if kind.derives_layout() {
            node.base_layout = Some(Box::new(style));
        }
        if kind == Kind::List {
            self.lists.push(key);
        }
        if matches!(kind, Kind::Scroll | Kind::List | Kind::Input)
            && self.builtin_scrollbars.is_some()
        {
            self.scrollbars_pending.push(key);
        }
        if kind.is_root() {
            self.roots.push(key);
        }
        if kind == Kind::Input {
            self.measure_input(key);
        }
        if kind == Kind::Overlay
            && let Some(layout) = self.nodes[key as usize].layout
        {
            self.overlay_made(key, layout);
        }
        self.sync_layout_style(key);
    }

    /// Node `id`, a view no child is in yet, becomes a `tag` (a component's
    /// root of another kind on its host): as if it had been made one. Only
    /// while its native view is not sent yet (it was made in this batch);
    /// whether it did.
    pub(super) fn retag(&mut self, id: NodeId, tag: Tag) -> bool {
        let Ok(key) = self.key(id) else {
            return false;
        };
        let kind = Kind::of(tag);
        let node = &self.nodes[key as usize];
        if node.kind == kind {
            return true;
        }
        let id = node.id;
        if node.kind != Kind::View || !node.children.is_empty() {
            return false;
        }
        if node.created && !self.made_in_this_batch(id) {
            return false;
        }
        let node = &self.nodes[key as usize];
        // Out of its parent, its native view never made.
        let parent = node.parent;
        let at = (parent != NO_KEY).then(|| {
            let siblings = &self.nodes[parent as usize].children;
            let i = siblings.iter().position(|&c| c == key).expect("child");
            let next = siblings.get(i + 1).map(|&c| self.nodes[c as usize].id);
            (self.nodes[parent as usize].id, next)
        });
        if parent != NO_KEY {
            self.unlink(key, false);
        }
        // Its `Create` and `Insert` so far go, with the other retagged
        // views' in one pass ([`Self::drop_retagged`]).
        let retags = self.retags.get_or_insert_default();
        retags.made.remove(&id);
        retags.retagged.insert(id, self.mount.len());
        // The kind's own state and layout.
        let fresh = Node::new(id, kind);
        let node = &mut self.nodes[key as usize];
        node.created = false;
        node.kind = kind;
        node.image = fresh.image;
        node.scroll = fresh.scroll;
        node.list = fresh.list;
        node.input = fresh.input;
        node.root = fresh.root;
        node.control = fresh.control;
        node.component = fresh.component;
        let layout = node.layout.expect("a view has a layout");
        if let Some(pos) = self.source_texts.iter().position(|&k| k == key) {
            self.source_texts.swap_remove(pos);
        }
        self.text_sources.remove(&key);
        self.layout.set_node_context(layout, leaf_context(kind));
        let style = self.layout.style(layout).clone();
        self.became(key, style);
        // A native component made in its place reads its style's accent.
        self.sync_accent(key);
        // What a terminal's layout takes from its kind (a scroll view's
        // unbounded content), as if it had been made one.
        self.sync_grid_role(key);
        if let Some((parent, before)) = at {
            let _ = self.insert(parent, id, before);
        }
        true
    }

    /// Whether made view `id`'s `Create` is still in the mount items (it was
    /// made in this batch). Each item is looked at once a round of renders,
    /// not once a view.
    fn made_in_this_batch(&mut self, id: NodeId) -> bool {
        let retags = self.retags.get_or_insert_default();
        let from = retags.seen;
        retags
            .made
            .extend(self.mount[from..].iter().filter_map(|m| match m {
                MountItem::Create { id, .. } => Some(*id),
                _ => None,
            }));
        retags.seen = self.mount.len();
        let made = retags.made.contains(&id);
        self.retagging(self.mount.len() - from);
        made
    }

    /// Drops the `Create` and `Insert` items the retagged views had before
    /// they took their kind ([`Self::retag`]), in one pass.
    pub(super) fn drop_retagged(&mut self) {
        let Some(retags) = self.retags.as_deref_mut() else {
            return;
        };
        if retags.retagged.is_empty() {
            return;
        }
        let retagged = std::mem::take(&mut retags.retagged);
        let (seen, made) = (retags.seen, &mut retags.made);
        let mut at = 0;
        self.mount.retain(|m| {
            let i = at;
            at += 1;
            let (MountItem::Create { id, .. } | MountItem::Insert { child: id, .. }) = m else {
                return true;
            };
            if retagged.get(id).is_some_and(|&then| i < then) {
                return false;
            }
            if i >= seen && matches!(m, MountItem::Create { .. }) {
                made.insert(*id);
            }
            true
        });
        retags.seen = self.mount.len();
        self.retagging(at);
    }

    /// The round of renders is over: what [`Self::retag`] did goes into
    /// the mount items, and its record of them goes (other steps insert
    /// items among them).
    pub(super) fn end_retags(&mut self) {
        self.drop_retagged();
        #[cfg(test)]
        if self.retags.is_some() {
            let rounds = &self.components.retag_rounds;
            rounds.set(rounds.get() + 1);
        }
        self.retags = None;
    }

    /// Rebuilds the text an input is measured with: what it shows while an
    /// input method composes, else its value, else its placeholder, else an
    /// empty line.
    fn measure_input(&mut self, key: Key) {
        let node = &self.nodes[key as usize];
        let (Some(input), Some(layout)) = (&node.input, node.layout) else {
            return;
        };
        let shown = input.composing.as_deref().unwrap_or(&input.value);
        let placeholder = shown.is_empty() && !input.config.placeholder.is_empty();
        let text = self.input_text(
            key,
            if placeholder {
                &input.config.placeholder
            } else {
                shown
            },
        );
        let field = self.input_text(key, FIELD_SAMPLE);
        let cx = self.text_cx(layout);
        let same = cx.text.layout_eq(&text);
        let same_field = cx.field.as_ref().is_some_and(|f| f.text.layout_eq(&field));
        let input = self.nodes[key as usize]
            .input
            .as_mut()
            .expect("input state");
        // A value that reads as the placeholder measures the same, but
        // its content size is the value's: laid out again to report it.
        if same && same_field && input.placeholder_measured == placeholder {
            return;
        }
        input.placeholder_measured = placeholder;
        let cx = self.text_cx(layout);
        if !same {
            let kept = cx.field.take();
            *cx = TextContext::new(Arc::new(text));
            cx.field = kept;
        }
        if !same_field {
            cx.field = Some(Box::new(TextContext::new(Arc::new(field))));
        }
        self.layout.mark_dirty(layout);
        self.needs_layout = true;
    }

    /// `content` in the text style of input `key`, as it is measured.
    fn input_text(&self, key: Key, content: &str) -> AttributedText {
        let node = &self.nodes[key as usize];
        let multiline = node.input.as_ref().is_some_and(|i| i.config.multiline);
        let mut text = AttributedText {
            max_lines: if multiline { 0 } else { 1 },
            ..AttributedText::default()
        };
        let style = scaled(
            self.inherited_text_style(key).inherit(&node.text_style),
            node.paragraph.font_multiplier(self.font_scale),
        );
        if multiline {
            text.push(&broken_runs(content), style);
        } else {
            text.push(content, style);
        }
        // An empty last line still takes space (a trailing line break, or no
        // text at all).
        if content.is_empty() || (multiline && content.ends_with('\n')) {
            text.push("\u{200b}", style);
        }
        text
    }

    /// `key` holds a slot's content in a Rust component's tree (JS's holder
    /// of a slot or a render, or the node a view wraps its fill in): while
    /// nothing styles its layout and it holds one node, that node is laid
    /// out in its place, as the component's own child (`layout_tree`'s
    /// "holders laid out through"). A list's holder (an `Items` slot) is a
    /// list, laid out as one.
    pub(super) fn lay_out_through(&mut self, key: Key) {
        let node = &self.nodes[key as usize];
        if node.kind == Kind::View
            && let Some(layout) = node.layout
        {
            self.layout.set_holder(layout);
            self.needs_layout = true;
        }
    }

    /// Pushes the effective taffy style of `key`: the JS style, adjusted
    /// for scroll containers and list cells.
    fn sync_layout_style(&mut self, key: Key) {
        let node = &self.nodes[key as usize];
        let (Some(layout), Some(base)) = (node.layout, node.base_layout.as_deref()) else {
            return;
        };
        let mut style = base.clone();
        let kind = node.kind;
        if let Some(root) = self.nodes[key as usize].root.as_mut() {
            // Laid out again with its size by `layout_roots`.
            root.laid_out = None;
        }
        let node = &self.nodes[key as usize];
        match kind {
            Kind::Scroll => {
                // Children may overflow along the scroll axis; a horizontal
                // scroll lays its content out in a row.
                let horizontal = node.scroll.as_ref().is_some_and(|s| s.horizontal);
                if horizontal {
                    style.flex_direction = taffy::FlexDirection::Row;
                    style.overflow.x = Overflow::Scroll;
                    if node.rtl {
                        // Laid out left to right (with the authored sides)
                        // and mirrored by `emit_frames`: right to left, a
                        // row would overflow to negative offsets.
                        std::mem::swap(&mut style.padding.left, &mut style.padding.right);
                        std::mem::swap(&mut style.border.left, &mut style.border.right);
                        style.direction = taffy::Direction::Ltr;
                    }
                } else {
                    style.overflow.y = Overflow::Scroll;
                }
            }
            Kind::List => {
                style.overflow = taffy::Point {
                    x: Overflow::Hidden,
                    y: Overflow::Hidden,
                }
            }
            Kind::Input => {
                // The native editor scrolls and clips its own text. Its
                // measured content must not extend an enclosing scroll view.
                style.overflow = taffy::Point {
                    x: Overflow::Clip,
                    y: Overflow::Clip,
                }
            }
            Kind::Cell => {
                // Cells are their own layout roots (the list gives them a
                // definite cross size to stretch, or max-content to align,
                // and positions them): a change in one row never relayouts
                // the rest of the tree.
                let horizontal = self
                    .nodes
                    .get(node.parent as usize)
                    .and_then(|p| p.scroll.as_ref())
                    .is_some_and(|s| s.horizontal);
                style.position = Position::Relative;
                if horizontal {
                    style.size.height = taffy::Dimension::percent(1.0);
                } else {
                    style.size.width = taffy::Dimension::percent(1.0);
                }
            }
            // `position: fixed` in its root view's box.
            Kind::Overlay => style.position = Position::Absolute,
            _ => {}
        }
        if node.fixed_view {
            style.position = Position::Fixed;
        }
        let was_hidden = self.layout.displays_none(layout);
        if self.layout.set_style(layout, style) {
            self.needs_layout = true;
            self.sync_layout_hidden(key, was_hidden);
        }
    }

    fn set_inline_style(
        &mut self,
        id: NodeId,
        style: Box<Style>,
        patch: StylePatch,
    ) -> Result<(), ApplyError> {
        let key = self.key(id)?;
        let node = &mut self.nodes[key as usize];
        node.inline_style = patch;
        if node.classes.is_some() || node.spaced || node.inline_style.reads_current_color() {
            self.restyle(key);
            return Ok(());
        }
        let mut props = node.class_props.as_deref().cloned().unwrap_or_default();
        style.node_props(&mut props);
        self.set_class_props(key, props);
        self.set_style(id, *style)
    }

    fn set_style(&mut self, id: NodeId, style: Style) -> Result<(), ApplyError> {
        let key = self.key(id)?;
        let node = &mut self.nodes[key as usize];
        let Style {
            mut layout,
            mut view,
            text,
            paint,
            animated,
            z_index,
            vertical_align,
            direction,
            logical,
            pending,
            perspective: child_perspective,
        } = style;
        if animated
            .iter()
            .any(|(p, _)| matches!(p, AnimationProp::BackgroundColor))
        {
            // The animated color must show: a gradient drawn over it would
            // hide it.
            view.clear_background_images();
        }
        if key != self.root {
            node.direction = direction;
        }
        node.logical = (!logical.is_empty()).then(|| Box::new(logical));
        let rtl = self.resolved_rtl(key);
        crate::style::resolve_normal_alignment(&mut layout);
        crate::style::apply_direction(&mut layout, &mut view, &logical, rtl);
        // A sticky box's insets say where it sticks, not where it is laid
        // out.
        let sticky = pending.sticky_position.then(|| Box::new(layout.inset));
        if sticky.is_some() {
            layout.inset = taffy::Rect {
                left: taffy::LengthPercentageAuto::auto(),
                right: taffy::LengthPercentageAuto::auto(),
                top: taffy::LengthPercentageAuto::auto(),
                bottom: taffy::LengthPercentageAuto::auto(),
            };
        }
        let node = &mut self.nodes[key as usize];
        if node.sticky != sticky {
            self.set_sticky(key, sticky);
        }
        let node = &mut self.nodes[key as usize];
        if node.child_perspective != child_perspective {
            node.child_perspective = child_perspective;
            // Its children's transforms compose it (their animated steps
            // move by its steps).
            let children = node.children.clone();
            for c in children {
                self.mark(c, dirty::VIEW | dirty::ANIMATION);
            }
        }
        let node = &mut self.nodes[key as usize];
        if node.object_fit != pending.object_fit {
            node.object_fit = pending.object_fit;
            if node.image.is_some() {
                self.mark(key, dirty::IMAGE);
            } else if let Some(control) = node.control.as_mut() {
                // A video is contained by default.
                let fit = pending.object_fit.unwrap_or(ResizeMode::Contain);
                apply_native(control, NativeProp::VideoResizeMode(fit));
                self.mark(key, dirty::NATIVE);
            }
        }
        let node = &mut self.nodes[key as usize];
        if node.wants_fixed != pending.fixed_position {
            // Made an overlay, or a view again: at once while it is in no
            // parent (classes are set before the node is inserted), else as
            // the commit starts.
            node.wants_fixed = pending.fixed_position;
            let id = node.id;
            if node.parent == NO_KEY {
                self.fix_or_unfix(key);
            } else {
                self.fixed_changed.push((key, id));
            }
        }
        // `env()`'s terms, on the edges their declarations name (left and
        // right are physical, right to left too).
        let env = pending.env;
        let env = (!env.is_empty()).then(|| (env, self.env_insets(key, &env)));
        let node = &mut self.nodes[key as usize];
        let id = node.id;
        match env {
            Some(env) => {
                node.env = Some(Box::new(env));
                self.env_styled.insert(id);
            }
            None => {
                if node.env.take().is_some() {
                    self.env_styled.remove(&id);
                }
            }
        }
        let node = &mut self.nodes[key as usize];
        let mut extra = node.insets.as_deref().copied();
        if let Some((_, applied)) = node.env.as_deref() {
            let sum = |a: EdgeInsets, b: EdgeInsets| EdgeInsets {
                top: a.top + b.top,
                right: a.right + b.right,
                bottom: a.bottom + b.bottom,
                left: a.left + b.left,
            };
            let [p, m] = extra.unwrap_or_default();
            extra = Some([sum(p, applied[0]), sum(m, applied[1])]);
        }
        if let Some([padding, margin]) = extra.as_ref() {
            // On top of points; percentages cannot take an addition.
            let add = |p: &mut taffy::LengthPercentage, d: f32| {
                if let taffy::style::ExpandedLengthPercentage::Length(v) = p.expand() {
                    *p = taffy::LengthPercentage::length(v + d);
                }
            };
            add(&mut layout.padding.top, padding.top.0);
            add(&mut layout.padding.right, padding.right.0);
            add(&mut layout.padding.bottom, padding.bottom.0);
            add(&mut layout.padding.left, padding.left.0);
            // `auto` margins stay automatic.
            let add = |m: &mut taffy::LengthPercentageAuto, d: f32| {
                if let taffy::style::ExpandedLengthPercentageAuto::Length(v) = m.expand() {
                    *m = taffy::LengthPercentageAuto::length(v + d);
                }
            };
            add(&mut layout.margin.top, margin.top.0);
            add(&mut layout.margin.right, margin.right.0);
            add(&mut layout.margin.bottom, margin.bottom.0);
            add(&mut layout.margin.left, margin.left.0);
        }
        let flipped = node.rtl != rtl;
        node.rtl = rtl;
        let was_hidden = node.layout.is_some_and(|l| self.layout.displays_none(l));
        // `objectPosition` is the image's (`MountItem::Image`), not the view's.
        let position_changed = node.view_style.object_position != view.object_position;
        let view_changed = if position_changed {
            node.view_style
                != ViewStyle {
                    object_position: node.view_style.object_position,
                    ..view.clone()
                }
        } else {
            node.view_style != view
        };
        // A span's background and visibility are part of its block's text.
        let span_drawing_changed = node.inline
            && node.kind == Kind::Text
            && (span_background(&node.view_style, node.id) != span_background(&view, node.id)
                || node.view_style.hidden != view.hidden);
        let text_changed = node.text_style != text || span_drawing_changed;
        // What its children inherit as `currentColor`.
        let passed_color = |node: &Node, text: &TextStyle| text.color.or(node.inherited_color);
        let color_passed = passed_color(node, &node.text_style) != passed_color(node, &text);
        let animation_changed = node.animated != animated;
        let paint = (paint != PaintStyle::default()).then(|| Box::new(paint));
        let paint_changed = node.paint != paint;
        let z_changed = node.z_index != z_index;
        // An attachment's place in its line is part of its block's text.
        let align_changed =
            node.vertical_align != vertical_align && node.inline && node.kind != Kind::Text;
        // ... and so is the content's of a render placed there.
        let content_align_changed = node.vertical_align != vertical_align && !node.inline;
        let accent_changed = node.view_style.accent_color != view.accent_color;
        node.view_style.set(view);
        node.text_style.set(text);
        node.paint = paint;
        node.animated = animated;
        node.z_index = z_index;
        node.vertical_align = vertical_align;
        // Its fill, border and corners (`terminal_layout::Role`).
        self.sync_grid_role(key);
        if align_changed {
            self.mark_text_block(key);
        } else if content_align_changed && let Some(place) = self.placed_in_text(key) {
            self.mark_text_block(place);
        }
        if z_changed {
            self.restack(key);
        }
        let node = &mut self.nodes[key as usize];
        // `overflow: "hidden"` clips in layout as well as in paint: what a box
        // clips away must not reach an enclosing scroll view's content size,
        // or a child laid out wider than its box and scaled down with a
        // transform (transforms do not affect layout) leaves the scroll view
        // scrollable across its own axis.
        // `Clip`, not `Hidden`: both stop the overflow from propagating, but
        // `Hidden` is a scroll container in CSS and would also make the box's
        // automatic minimum size as a flex or grid item 0, which clipping the
        // paint must not do. Set here rather than while parsing the style so
        // that what `overflow` sets as a style stays what it was.
        let clip = if node.view_style.overflow_hidden {
            taffy::Overflow::Clip
        } else {
            taffy::Overflow::Visible
        };
        layout.overflow = taffy::Point { x: clip, y: clip };
        if node.kind == Kind::Text && node.layout.is_none() {
            // A span: kept for when it is a block again. Its padding is
            // part of its block's text (horizontal: room in the line;
            // vertical: its background's).
            let padding = |l: &taffy::Style| l.padding;
            let padded = node.base_layout.as_deref().map(padding) != Some(padding(&layout));
            node.base_layout = Some(Box::new(layout));
            if padded && node.inline {
                self.mark_text_block(key);
            }
        } else if node.kind.derives_layout() || node.fixed_view {
            node.base_layout = Some(Box::new(layout));
            self.sync_layout_style(key);
        } else if let Some(l) = node.layout {
            // A style that only changed what is painted lays nothing out.
            if self.layout.set_style(l, layout) {
                self.needs_layout = true;
            }
        }
        let hidden_changed = self.nodes[key as usize]
            .layout
            .is_some_and(|l| self.layout.displays_none(l) != was_hidden);
        let mut flags = 0;
        if view_changed || hidden_changed {
            flags |= dirty::VIEW;
            // A drawing filling with the view's background paints the new
            // one.
            if self.nodes[key as usize]
                .drawing
                .as_ref()
                .is_some_and(|d| d.paints_background())
            {
                flags |= dirty::CANVAS;
            }
        }
        if position_changed && self.nodes[key as usize].image.is_some() {
            flags |= dirty::IMAGE;
        }
        if accent_changed {
            self.sync_accent(key);
        }
        // A sticky view's animated inset is part of its range.
        self.sticky_changed |= animation_changed && self.nodes[key as usize].sticky.is_some();
        let parent = self.nodes[key as usize].parent;
        let in_perspective =
            parent != NO_KEY && self.nodes[parent as usize].child_perspective.is_some();
        if animation_changed
            || view_changed && in_perspective && !self.nodes[key as usize].animated.is_empty()
        {
            // Its animated steps move with its parent's perspective.
            flags |= dirty::ANIMATION;
        }
        if flags != 0 {
            self.mark(key, flags);
        }
        if text_changed || flipped {
            match self.nodes[key as usize].kind {
                Kind::Text => {
                    self.mark_text_block(key);
                    // Texts inside its attachments take its color.
                    if color_passed {
                        self.mark_inheriting_text(key);
                    }
                }
                Kind::Input => {
                    self.measure_input(key);
                    self.mark(key, dirty::INPUT);
                }
                // Text inside inherits it (CSS).
                _ if text_changed => self.mark_inheriting_text(key),
                _ => {}
            }
        }
        if color_passed {
            let node = &self.nodes[key as usize];
            let color = node.text_style.color.or(node.inherited_color);
            self.inherit_color(key, color);
        }
        // A canvas painting with its view's style (`currentColor` too) sees
        // the change, and so do the ones inside it, which inherit it.
        if paint_changed || text_changed {
            self.mark_view_painted(key);
        }
        if flipped {
            self.update_children_direction(key);
            // Its own `direction` turned it: classes resolved for the other
            // direction (`pl-*`, `rtl:`) resolve again.
            if self.reads_direction(key) {
                self.restyle(key);
            }
        }
        Ok(())
    }

    /// Marks the canvases at and inside `key` that paint with their view's
    /// style ([`crate::canvas::Drawing::view_paints`]) to be sent again.
    fn mark_view_painted(&mut self, key: Key) {
        let mut stack = vec![key];
        while let Some(k) = stack.pop() {
            let node = &self.nodes[k as usize];
            match node.kind {
                Kind::Canvas => {
                    if node
                        .drawing
                        .as_ref()
                        .is_some_and(|d| !d.view_paints.is_empty())
                    {
                        self.mark(k, dirty::CANVAS);
                    }
                }
                Kind::Text | Kind::RawText | Kind::Input => {}
                // An `svg()` drawn as an image paints `currentColor` too.
                _ if node.image.as_ref().is_some_and(|i| i.svg_current_color) => {
                    self.mark(k, dirty::IMAGE);
                }
                _ => stack.extend_from_slice(&self.nodes[k as usize].children),
            }
        }
    }

    /// Canvas `key`'s `drawing` as its platform gets it: its
    /// [`crate::canvas::Drawing::view_paints`] resolved with its style and
    /// its box.
    fn mounted_drawing(
        &self,
        key: Key,
        drawing: &Arc<crate::canvas::Drawing>,
    ) -> Arc<crate::canvas::Drawing> {
        if drawing.view_paints.is_empty() {
            return drawing.clone();
        }
        let node = &self.nodes[key as usize];
        let (paint, current) = self.resolved_paint(key);
        let style = &node.view_style;
        let images = style
            .effects
            .as_deref()
            .map_or(&[][..], |e| &e.background_images[..]);
        let size = if node.frame == Bounds::UNSET {
            Size::default()
        } else {
            node.frame.size
        };
        Arc::new(drawing.painted(&paint, current, style.background_color, images, size))
    }

    /// Sends the canvases fitting a view box that changed or were given
    /// another size this round, with the size the layout gave them.
    fn send_fitted(&mut self) {
        let mut pending = std::mem::take(&mut self.fitted_pending);
        pending.sort_unstable();
        pending.dedup();
        for &key in &pending {
            let Some(node) = self.nodes.get(key as usize) else {
                continue;
            };
            if !node.created {
                continue;
            }
            let Some(drawing) = &node.drawing else {
                continue;
            };
            let (id, drawing) = (node.id, self.mounted_drawing(key, drawing));
            self.mount.push(MountItem::Canvas { id, drawing });
        }
        pending.clear();
        self.fitted_pending = pending;
    }

    /// The paint properties canvas `key` paints with (its own over those
    /// of the views around it, as CSS inherits them) and its text color,
    /// for `currentColor`.
    fn resolved_paint(&self, key: Key) -> (PaintStyle, crate::style::Color) {
        let node = &self.nodes[key as usize];
        let mut paint = node.paint.as_deref().cloned().unwrap_or_default();
        let mut k = node.parent;
        while k != NO_KEY {
            if let Some(p) = self.nodes[k as usize].paint.as_deref() {
                paint = paint.inherit(p);
            }
            k = self.nodes[k as usize].parent;
        }
        let color = node
            .text_style
            .color
            .unwrap_or_else(|| self.inherited_text_style(key).color);
        (paint, color)
    }

    /// The direction `key` lays out in: its own, else its parent's (the
    /// root's while detached).
    pub(super) fn resolved_rtl(&self, key: Key) -> bool {
        let node = &self.nodes[key as usize];
        if let Some(rtl) = node.direction {
            return rtl;
        }
        match node.parent {
            NO_KEY => key != self.root && self.nodes[self.root as usize].rtl,
            parent => self.nodes[parent as usize].rtl,
        }
    }

    /// Re-resolves the direction of `key` (moved, or its parent's changed)
    /// and of the nodes inheriting it.
    fn update_direction(&mut self, key: Key) {
        let rtl = self.resolved_rtl(key);
        if self.nodes[key as usize].rtl == rtl {
            return;
        }
        self.flip_direction(key, rtl);
        self.update_children_direction(key);
    }

    fn update_children_direction(&mut self, key: Key) {
        let children = self.nodes[key as usize].children.clone();
        for child in children {
            self.update_direction(child);
        }
    }

    /// Lays `key` out in the other direction. Its left and right properties
    /// keep their sides, as in CSS; its start / end ones move with the
    /// direction, so it is styled again when it has some.
    fn flip_direction(&mut self, key: Key, rtl: bool) {
        let direction = if rtl {
            taffy::Direction::Rtl
        } else {
            taffy::Direction::Ltr
        };
        let node = &mut self.nodes[key as usize];
        node.rtl = rtl;
        if let Some(list) = node.list.as_mut() {
            let mirrored = rtl && list.horizontal;
            list.set_mirrored(mirrored);
        }
        // A spaced child's margin is on its end side.
        let logical = node.logical.is_some() || node.spaced;
        let kind = node.kind;
        if let Some(base) = node.base_layout.as_deref_mut() {
            base.direction = direction;
            self.sync_layout_style(key);
        } else if let Some(l) = node.layout {
            let mut layout = self.layout.style(l).clone();
            layout.direction = direction;
            self.layout.set_style(l, layout);
            self.needs_layout = true;
        }
        self.mark(key, dirty::VIEW);
        if logical || self.reads_direction(key) {
            self.restyle(key);
        }
        let node = &mut self.nodes[key as usize];
        let id = node.id;
        if let Some(scroll) = node.scroll.as_mut()
            && scroll.horizontal
            && node.list.as_ref().is_none_or(|l| !l.parent)
        {
            // Back to the start side: the right end right to left (once the
            // content is known again).
            scroll.content = None;
            if !rtl {
                self.commands.push((
                    id,
                    Command::ScrollTo {
                        x: Points::ZERO,
                        y: Points::ZERO,
                        animated: false,
                    },
                ));
            }
            self.mark(key, dirty::SCROLL);
        }
        match kind {
            Kind::Text => self.mark_text_block(key),
            Kind::Input => {
                self.measure_input(key);
                self.mark(key, dirty::INPUT);
            }
            _ => {}
        }
    }

    /// Media source `uri` as the app may load it ([`crate::access::Access::media_url`]
    /// against [`Core::set_base_url`]'s URL): `Some(None)` as written,
    /// `Some(Some(url))` the URL to load in its place, `None` refused.
    fn media_source(&self, uri: &str) -> Option<Option<Arc<str>>> {
        match self
            .access
            .media_url(uri, self.base_url.as_deref(), Some(&self.media_files))?
        {
            std::borrow::Cow::Borrowed(_) => Some(None),
            std::borrow::Cow::Owned(url) => Some(Some(url.into())),
        }
    }

    /// The images `drawing` draws as the app may load them
    /// ([`crate::access::Access::media_url`] against [`Core::set_base_url`]'s
    /// URL and the `capabilities.fs.read` roots): one the check grants is
    /// rewritten to what it granted (a file's canonical path, a URL's
    /// serialization); one it refuses is dropped and reported. A network
    /// answer is remembered for the session; a file's changes with the
    /// disk and is never remembered. On-screen canvases check every
    /// drawing (`Op::Draw`); offscreen renders check the same way before
    /// the platform draws (`canvas_render.rs`).
    fn check_canvas_images(&mut self, drawing: &mut crate::canvas::Drawing) {
        if self.access.is_unrestricted() {
            return;
        }
        let access = self.access.clone();
        let base = self.base_url.clone();
        let files = self.media_files.clone();
        let mut refused = Vec::new();
        let checked = &mut self.canvas_images;
        drawing.ops.retain_mut(|op| match op {
            crate::canvas::CanvasOp::DrawImage { image, .. } => {
                let granted = match checked.get(&image.uri) {
                    Some(granted) => granted.clone(),
                    None => {
                        let granted = access
                            .media_url(&image.uri, base.as_deref(), Some(&files))
                            .map(|url| match url {
                                std::borrow::Cow::Owned(url) => Arc::from(url),
                                std::borrow::Cow::Borrowed(_) => image.uri.clone(),
                            });
                        if crate::access::media_capability(&image.uri, base.as_deref()) == "network"
                        {
                            if checked.len() >= CANVAS_IMAGES {
                                checked.clear();
                            }
                            checked.insert(image.uri.clone(), granted.clone());
                        }
                        granted
                    }
                };
                match granted {
                    Some(url) => {
                        image.uri = url;
                        true
                    }
                    None => {
                        refused.push(image.uri.clone());
                        false
                    }
                }
            }
            _ => true,
        });
        for uri in refused {
            self.deny(media_not_granted(
                "a canvas image",
                &uri,
                self.base_url.as_deref(),
            ));
        }
    }

    /// `desktop`'s menu and tray icons as the app may load them
    /// ([`Self::media_source`]): a refused icon is dropped (the item shows
    /// none) and reported.
    fn check_menu_icons(&mut self, desktop: &mut crate::desktop::DesktopCommand) {
        use crate::{
            ImageSource,
            desktop::{DesktopCommand, MenuItem},
        };
        if self.access.is_unrestricted() {
            return;
        }
        let mut check = |icon: &mut Option<ImageSource>| {
            let Some(source) = icon else { return };
            match self.media_source(&source.uri) {
                Some(Some(url)) => source.uri = url,
                Some(None) => {}
                None => {
                    let message =
                        media_not_granted("the menu icon", &source.uri, self.base_url.as_deref());
                    *icon = None;
                    self.deny(message);
                }
            }
        };
        fn each(items: &mut [MenuItem], check: &mut impl FnMut(&mut Option<ImageSource>)) {
            for item in items {
                match item {
                    MenuItem::Action(action) => check(&mut action.icon),
                    MenuItem::Submenu { items, icon, .. } => {
                        check(icon);
                        each(items, check);
                    }
                    MenuItem::Separator => {}
                }
            }
        }
        let checked = |items: &Arc<[MenuItem]>, check: &mut dyn FnMut(&mut Option<ImageSource>)| {
            let mut items = items.to_vec();
            each(&mut items, &mut |icon| check(icon));
            Arc::<[MenuItem]>::from(items)
        };
        match desktop {
            DesktopCommand::SetMenu(Some(items)) | DesktopCommand::PopupMenu { items, .. } => {
                *items = checked(items, &mut check);
            }
            DesktopCommand::SetTray(Some(tray)) => {
                check(&mut tray.icon);
                tray.menu = checked(&tray.menu, &mut check);
            }
            _ => {}
        }
    }

    /// `prop` with what the app may not reach removed: a refused image,
    /// video or web view source shows nothing and fails (`onError` with
    /// `code` `ERR_ACCESS_DENIED`).
    fn check_prop(&mut self, key: Key, prop: Prop) -> Prop {
        if self.access.is_unrestricted() {
            return prop;
        }
        let node = &self.nodes[key as usize];
        let (id, kind) = (node.id, node.kind);
        // Always reported: the `onError` listener may be set after the
        // source (JS finds the handler when the event is delivered).
        let report = |core: &mut Self, message: String| {
            core.events.push(crate::element::JsEvent::Event(
                id,
                EventKind::Error,
                EventPayload::Map(vec![
                    ("message", PayloadValue::Str(message.clone())),
                    (
                        "code",
                        PayloadValue::Str(crate::element::codes::ACCESS_DENIED.into()),
                    ),
                ]),
            ));
            core.deny(message);
        };
        let refuse = |core: &mut Self, what: &str, uri: &str, capability: &str| {
            report(core, not_granted(what, uri, capability));
        };
        let refuse_media = |core: &mut Self, what: &str, uri: &str| {
            let message = media_not_granted(what, uri, core.base_url.as_deref());
            report(core, message);
        };
        let no_webviews = |core: &mut Self| {
            report(
                core,
                "web views are not granted: add `webview` to capabilities in nsh.json".into(),
            );
        };
        match prop {
            // A loader loads what the check granted (`Access::media_url`).
            Prop::Source(Some(mut source)) => match self.media_source(&source.uri) {
                Some(granted) => {
                    source.uri = granted.unwrap_or(source.uri);
                    Prop::Source(Some(source))
                }
                None => {
                    refuse_media(self, "the image", &source.uri);
                    Prop::Source(None)
                }
            },
            Prop::Image(ImageProp::Placeholder(Some(mut source))) => {
                match self.media_source(&source.uri) {
                    Some(granted) => {
                        source.uri = granted.unwrap_or(source.uri);
                        Prop::Image(ImageProp::Placeholder(Some(source)))
                    }
                    None => {
                        refuse_media(self, "the placeholder", &source.uri);
                        Prop::Image(ImageProp::Placeholder(None))
                    }
                }
            }
            Prop::Native(NativeProp::Src(Some(url))) if kind == Kind::Video => {
                match self.media_source(&url) {
                    Some(granted) => Prop::Native(NativeProp::Src(Some(granted.unwrap_or(url)))),
                    None => {
                        refuse_media(self, "the video", &url);
                        Prop::Native(NativeProp::Src(None))
                    }
                }
            }
            Prop::Native(NativeProp::Src(Some(url)))
                if kind == Kind::WebView && !self.access.allows_webview(&url) =>
            {
                refuse(self, "the web page", &url, "webview.hosts");
                Prop::Native(NativeProp::Src(None))
            }
            Prop::Native(NativeProp::Html(Some(_)))
                if kind == Kind::WebView && !self.access.allows_webviews() =>
            {
                no_webviews(self);
                Prop::Native(NativeProp::Html(None))
            }
            Prop::Native(NativeProp::Source(crate::WebSource::Uri(uri))) if kind == Kind::Video => {
                match self.media_source(&uri) {
                    Some(granted) => Prop::Native(NativeProp::Source(crate::WebSource::Uri(
                        granted.unwrap_or(uri),
                    ))),
                    None => {
                        refuse_media(self, "the video", &uri);
                        Prop::Native(NativeProp::Source(crate::WebSource::None))
                    }
                }
            }
            Prop::Native(NativeProp::Source(crate::WebSource::Uri(uri)))
                if kind == Kind::WebView && !self.access.allows_webview(&uri) =>
            {
                refuse(self, "the web page", &uri, "webview.hosts");
                Prop::Native(NativeProp::Source(crate::WebSource::None))
            }
            Prop::Native(NativeProp::Source(crate::WebSource::Html { .. }))
                if kind == Kind::WebView && !self.access.allows_webviews() =>
            {
                no_webviews(self);
                Prop::Native(NativeProp::Source(crate::WebSource::None))
            }
            // Inline HTML with a base URL runs at that URL's origin (WebKit's
            // `loadHTMLString:baseURL:`, Android's `loadDataWithBaseURL`,
            // Windows answering the base URL's request with it): the base
            // URL takes the grant a page there would, and without it the
            // HTML loads with no base. Without web views at all, the arms
            // above refuse the HTML itself, and that is the one error.
            Prop::Native(NativeProp::BaseUrl(Some(url)))
                if kind == Kind::WebView
                    && !url.is_empty()
                    && self.access.allows_webviews()
                    && !self.access.allows_webview(&url) =>
            {
                refuse(self, "the base URL", &url, "webview.hosts");
                Prop::Native(NativeProp::BaseUrl(None))
            }
            Prop::Native(NativeProp::Source(crate::WebSource::Html {
                html,
                base_url: Some(url),
            })) if kind == Kind::WebView
                && !url.is_empty()
                && !self.access.allows_webview(&url) =>
            {
                refuse(self, "the base URL", &url, "webview.hosts");
                Prop::Native(NativeProp::Source(crate::WebSource::Html {
                    html,
                    base_url: None,
                }))
            }
            prop => prop,
        }
    }

    /// `source` compiled, once per source while the cache keeps it (its
    /// error too): views that share a source, a source set again and the
    /// pages and dialogs that come through it use the compiled shader.
    fn compile(
        &mut self,
        source: &str,
    ) -> Result<crate::shader::Shader, crate::shader::ShaderError> {
        let hash = crate::shader::source_hash(source);
        let cached = self.shaders.get(&hash).filter(|c| match c {
            Ok(shader) => shader.source() == source,
            Err(_) => true,
        });
        if let Some(compiled) = cached {
            return compiled.clone();
        }
        let compiled = crate::shader::compile_source(source);
        // Bounded: an app making sources on the fly does not keep them all.
        if self.shaders.len() >= 64 {
            self.shaders.clear();
        }
        self.shaders.insert(hash, compiled.clone());
        compiled
    }

    /// A page's or a dialog's `transitionShader`: compiled (once per source)
    /// into the layer the platform draws its coming and going through.
    fn set_nav_shader(&mut self, key: Key, spec: Option<crate::shader::NavShaderSpec>) {
        let id = self.nodes[key as usize].id;
        if self.nodes[key as usize].root.is_none() {
            log::warn!(target: "js", "`transitionShader` is a page's or a dialog's; node {id} is neither");
            return;
        }
        let shader = spec.and_then(|spec| {
            let shader = self
                .compile(&spec.source)
                .map_err(|e| log::warn!(target: "js", "the transitionShader of node {id}: {e}"))
                .ok()?;
            let mut warnings = Vec::new();
            let layer = crate::shader::ShaderLayer::new(shader, &spec.uniforms.0, &mut warnings)
                .with_role(crate::shader::ShaderRole::Transition);
            for warning in warnings {
                log::warn!(target: "js", "the transitionShader of node {id}: {warning}");
            }
            let ms = spec.duration.unwrap_or(DEFAULT_NAV_SHADER_MS).max(0.0);
            Some(crate::NavShader {
                layer: Arc::new(layer),
                duration: std::time::Duration::from_micros((f64::from(ms) * 1000.0).round() as u64),
            })
        });
        let root = self.nodes[key as usize]
            .root
            .as_mut()
            .expect("checked above");
        if root.nav_shader != shader {
            root.nav_shader = shader;
            self.mark(key, dirty::NAV_SHADER);
        }
    }

    /// Tells the platform which shaders' pictures this commit changed
    /// ([`MountItem::ShaderInput`]): the effects and transitions with a
    /// changed view in their subtree (themselves included) or one that left
    /// it; every shader that reads what is behind it once a view drawn
    /// before it changed ([`Core::draws_before`]: not the view, what it holds
    /// or what draws over it), or anything that shows everywhere (the
    /// appearance, the tree's order); and every screen effect or
    /// transition, once anything changed.
    fn mark_shader_inputs(&mut self) {
        let unlinked_from = std::mem::take(&mut self.unlinked_from);
        // A batch that is only a layout animation is dropped (`commit`):
        // nothing in it changed what the pictures show.
        if self.pictured.is_empty()
            || self
                .mount
                .iter()
                .all(|item| matches!(item, MountItem::LayoutAnimation(_)))
        {
            return;
        }
        use crate::shader::{ShaderInput as I, ShaderRole as R};
        let ids: Vec<NodeId> = self.pictured.iter().copied().collect();
        let mut marked: Vec<NodeId> = Vec::new();
        let mut subtrees: Vec<(NodeId, Key)> = Vec::new();
        let mut backdrops: Vec<(NodeId, Key)> = Vec::new();
        for id in ids {
            let Ok(key) = self.key(id) else {
                self.pictured.remove(&id);
                continue;
            };
            let Some(layer) = self.nodes[key as usize]
                .shader
                .as_ref()
                .and_then(|s| s.layer.as_ref())
            else {
                continue;
            };
            let inputs = layer.shader.inputs();
            if matches!(layer.role, R::Screen | R::ScreenTransition) {
                marked.push(id);
                continue;
            }
            if inputs.contains(I::Backdrop) {
                backdrops.push((id, key));
            }
            if matches!(layer.role, R::Effect | R::Transition) {
                subtrees.push((id, key));
            }
        }
        if !backdrops.is_empty() {
            // What changed: the views of the items, and the parents of the
            // views that left (`Remove`, `Delete`), which stand in for them.
            let mut everywhere = false;
            let mut changed: Vec<Key> = Vec::new();
            let mut seen = rustc_hash::FxHashSet::default();
            for item in &self.mount {
                match shown_by(item) {
                    Shown::Nothing => {}
                    Shown::Everywhere => {
                        everywhere = true;
                        break;
                    }
                    Shown::View(id) => {
                        if seen.insert(id)
                            && let Ok(key) = self.key(id)
                        {
                            changed.push(key);
                        }
                    }
                }
            }
            for &id in &unlinked_from {
                if seen.insert(id)
                    && let Ok(key) = self.key(id)
                {
                    changed.push(key);
                }
            }
            for &(id, key) in &backdrops {
                if everywhere || self.draws_before(&changed, key) {
                    marked.push(id);
                }
            }
        }
        if !subtrees.is_empty() {
            let mut seen = rustc_hash::FxHashSet::default();
            // A view that left (`Remove`, `Delete`) has no parent to walk
            // up from any more: its old parent stands in for it.
            let views = self.mount.iter().filter_map(MountItem::view);
            for view in views.chain(unlinked_from) {
                if !seen.insert(view) {
                    continue;
                }
                let Ok(mut key) = self.key(view) else {
                    continue;
                };
                loop {
                    if let Some(&(id, _)) = subtrees.iter().find(|(_, k)| *k == key)
                        && !marked.contains(&id)
                    {
                        marked.push(id);
                    }
                    let parent = self.nodes[key as usize].parent;
                    if parent == NO_KEY {
                        break;
                    }
                    key = parent;
                }
            }
        }
        for id in marked {
            self.mount.push(MountItem::ShaderInput { id });
        }
    }

    /// Whether one of `views` draws before `reader` (under it): an ancestor
    /// of it (its own box is behind it), or a view that comes before it in
    /// the order the views draw in, siblings by [`Node::stack_rank`] then in
    /// order. The reader, what it holds and what draws over it do not: they
    /// are not in its backdrop. A view whose way up does not meet the
    /// reader's (another root, an overlay's) is taken to draw before it.
    fn draws_before(&self, views: &[Key], reader: Key) -> bool {
        if views.is_empty() {
            return false;
        }
        // The reader's way up, the reader first: where each ancestor is on it.
        let mut up: Vec<Key> = Vec::new();
        let mut key = reader;
        while key != NO_KEY {
            up.push(key);
            key = self.nodes[key as usize].parent;
        }
        let at: rustc_hash::FxHashMap<Key, usize> =
            up.iter().enumerate().map(|(i, &k)| (k, i)).collect();
        views.iter().any(|&view| {
            let mut below = NO_KEY;
            let mut key = view;
            while key != NO_KEY {
                if let Some(&i) = at.get(&key) {
                    if i == 0 {
                        // The reader, or a view in it.
                        return false;
                    }
                    if below == NO_KEY {
                        // An ancestor of the reader.
                        return true;
                    }
                    // `key` holds both: the side of the view and the
                    // reader's.
                    return self.stacks_before(key, below, up[i - 1]);
                }
                below = key;
                key = self.nodes[key as usize].parent;
            }
            true
        })
    }

    /// Whether `parent`'s child `a` draws before (under) its child `b`.
    fn stacks_before(&self, parent: Key, a: Key, b: Key) -> bool {
        let children = &self.nodes[parent as usize].children;
        let rank = |k: Key| {
            let index = children.iter().position(|&c| c == k).unwrap_or(usize::MAX);
            (self.nodes[k as usize].stack_rank(), index)
        };
        rank(a) < rank(b)
    }

    /// A shader's `source`, program, `uniforms` or `paused`, or an effect's
    /// or transition's props: the layer is made again, and sent when it
    /// changed; a transition whose `value` changed starts.
    fn set_shader_prop(&mut self, key: Key, prop: Prop) {
        let id = self.nodes[key as usize].id;
        let Some(state) = self.nodes[key as usize].shader.as_mut() else {
            log::warn!(target: "js", "shader props are a `<Shader>`'s; node {id} is not one");
            return;
        };
        match prop {
            Prop::ShaderSource(source) => {
                if state.source == source {
                    return;
                }
                state.source = source.clone();
                state.shader = None;
                if let Some(source) = source {
                    let compiled = self.compile(&source);
                    let state = self.nodes[key as usize]
                        .shader
                        .as_mut()
                        .expect("shader node");
                    match compiled {
                        Ok(shader) => state.shader = Some(shader),
                        Err(error) => log::warn!(target: "js", "the shader of node {id}: {error}"),
                    }
                }
            }
            Prop::Shader(shader) => {
                state.source = None;
                state.shader = shader;
            }
            Prop::Uniforms(uniforms) => state.uniforms = uniforms,
            Prop::ShaderPaused(paused) => state.paused = paused,
            Prop::ShaderProgress(progress) => state.progress = progress,
            Prop::MaxSampleOffset(overflow) => state.overflow = overflow.max(Points::ZERO),
            Prop::TransitionValue(value) => state.value = value,
            Prop::TransitionDuration(duration) => state.duration = duration,
            Prop::TransitionFallback(fallback) => state.fallback = fallback,
            _ => return,
        }
        let state = self.nodes[key as usize]
            .shader
            .as_mut()
            .expect("shader node");
        use crate::shader::ShaderRole as R;
        let transition = matches!(state.role, R::Transition | R::ScreenTransition);
        // A transition without a shader of its own runs its fallback.
        let program = state.shader.clone().or_else(|| {
            (transition && state.fallback == crate::TransitionFallback::Fade)
                .then(crate::shader::crossfade)
                .flatten()
        });
        let layer = program.map(|shader| {
            let mut warnings = Vec::new();
            let (progress, animated) = match state.progress {
                crate::shader::ShaderProgress::Number(n) => (n, None),
                crate::shader::ShaderProgress::Animated(node) => (Percentage(0.0), Some(node)),
            };
            let layer = crate::shader::ShaderLayer::new(shader, &state.uniforms.0, &mut warnings)
                .with_paused(state.paused)
                .with_role(state.role)
                .with_overflow(state.overflow)
                .with_progress(progress, animated);
            for warning in warnings {
                log::warn!(target: "js", "the shader of node {id}: {warning}");
            }
            Arc::new(layer)
        });
        if transition && state.value != state.shown {
            let before = std::mem::replace(&mut state.shown, state.value.clone());
            let ms = state.duration.unwrap_or(DEFAULT_TRANSITION_MS).max(0.0);
            if before.is_some() && layer.is_some() && ms > 0.0 {
                self.transition_starts.push(MountItem::ShaderTransition {
                    id,
                    duration: std::time::Duration::from_micros(
                        (f64::from(ms) * 1000.0).round() as u64
                    ),
                });
            }
        }
        let state = self.nodes[key as usize]
            .shader
            .as_mut()
            .expect("shader node");
        if layer.as_ref().is_some_and(|l| {
            !l.shader.inputs().is_empty() || matches!(l.role, R::Screen | R::ScreenTransition)
        }) {
            self.pictured.insert(id);
        } else {
            self.pictured.remove(&id);
        }
        if layer == state.layer {
            return;
        }
        let nodes_of = |l: &Option<Arc<crate::shader::ShaderLayer>>| {
            l.as_ref().map_or(&[][..], |l| &l.nodes[..]).to_vec()
        };
        let slots_changed = nodes_of(&layer) != nodes_of(&state.layer);
        state.layer = layer;
        self.mark(
            key,
            dirty::SHADER | if slots_changed { dirty::ANIMATION } else { 0 },
        );
    }

    fn set_prop(&mut self, id: NodeId, prop: Prop) -> Result<(), ApplyError> {
        let key = self.key(id)?;
        // Rust components: `component` makes a view a host, its props
        // arrive decoded (`RustProp`; platform components keep JSON).
        let prop = match prop {
            Prop::Component(name) if self.nodes[key as usize].kind == Kind::View => {
                self.create_instance(id, name);
                return Ok(());
            }
            Prop::ComponentSlot(name) => {
                self.set_slot_name(id, name);
                self.lay_out_through(key);
                return Ok(());
            }
            Prop::ComponentRender(slot) => {
                self.set_render_holder(id, slot);
                self.lay_out_through(key);
                return Ok(());
            }
            Prop::RustProp(name, value) => {
                if !self.set_component_prop(id, name, value) {
                    log::warn!(target: "js", "a Rust component's prop on node {id}, which hosts none");
                }
                return Ok(());
            }
            Prop::Follow(target) => {
                self.set_follow_target(key, target);
                return Ok(());
            }
            Prop::FollowTransition(transition) => {
                self.set_follow_transition(key, transition);
                return Ok(());
            }
            Prop::Accessibility(AccessibilityProp::ActiveDescendant(target)) => {
                self.set_relation(key, relations::Relation::ActiveDescendant, target);
                return Ok(());
            }
            Prop::Accessibility(AccessibilityProp::Controls(target)) => {
                self.set_relation(key, relations::Relation::Controls, target);
                return Ok(());
            }
            Prop::Accessibility(AccessibilityProp::DescribedBy(target)) => {
                self.set_relation(key, relations::Relation::DescribedBy, target);
                return Ok(());
            }
            Prop::ScrollEdgeElement(target) => {
                self.set_scroll_edge(key, target);
                return Ok(());
            }
            // A described view's own description waits for the element
            // describing it to go.
            Prop::Accessibility(AccessibilityProp::Description(description))
                if !self.relators.is_empty() && self.set_own_description(key, &description) =>
            {
                return Ok(());
            }
            prop => prop,
        };
        let prop = self.check_prop(key, prop);
        if let Prop::ShaderSource(_)
        | Prop::Shader(_)
        | Prop::Uniforms(_)
        | Prop::ShaderPaused(_)
        | Prop::ShaderProgress(_)
        | Prop::MaxSampleOffset(_)
        | Prop::TransitionValue(_)
        | Prop::TransitionDuration(_)
        | Prop::TransitionFallback(_) = prop
        {
            self.set_shader_prop(key, prop);
            return Ok(());
        }
        if let Prop::TransitionShader(spec) = prop {
            self.set_nav_shader(key, spec);
            return Ok(());
        }
        if let Prop::Screen(ScreenProp::StatusBar(setting)) = prop {
            self.set_status_bar(key, setting);
            return Ok(());
        }
        if let Prop::Screen(ScreenProp::Orientations(bits)) = prop {
            self.set_page_orientations(key, bits);
            return Ok(());
        }
        if let Prop::ListViewport(mode) = prop {
            self.set_list_viewport(key, mode);
            return Ok(());
        }
        // How a list in its parent's viewport scrolls is the scroll view's
        // around it.
        if matches!(
            prop,
            Prop::Scroll(_)
                | Prop::KeyboardDismissMode(_)
                | Prop::Scrollbar(_)
                | Prop::Refreshing(_)
                | Prop::ScrollValue(_)
                | Prop::PullValue(_)
                | Prop::Native(NativeProp::Scrollable(_))
        ) && let Some(list) = self.nodes[key as usize].list.as_mut().filter(|l| l.parent)
        {
            list.ignored |= match prop {
                Prop::Scroll(ScrollProp::RefreshIndicator(None)) => 0,
                Prop::Scroll(ScrollProp::RefreshIndicator(Some(_))) | Prop::PullValue(Some(_)) => {
                    list::ignored::REFRESH
                }
                Prop::Scroll(_)
                | Prop::KeyboardDismissMode(
                    KeyboardDismissMode::OnDrag | KeyboardDismissMode::Interactive,
                )
                | Prop::Native(NativeProp::Scrollable(false)) => list::ignored::BEHAVIOR,
                Prop::Scrollbar(
                    crate::ScrollbarSetting::Hidden
                    | crate::ScrollbarSetting::Themed(_)
                    | crate::ScrollbarSetting::ThemeValue(_),
                ) => list::ignored::SCROLLBAR,
                Prop::Refreshing(true) => list::ignored::REFRESH,
                Prop::ScrollValue(Some(_)) => list::ignored::SCROLL_VALUE,
                _ => 0,
            };
            self.warn_ignored(key);
            return Ok(());
        }
        let node = &mut self.nodes[key as usize];
        let mut flags = 0;
        let mut key_ancestry = false;
        let mut rebuild_span = false;
        let mut copy_text_changed = false;
        let mut slop_moved = false;
        match prop {
            Prop::Source(source) => {
                if let Some(image) = node.image.as_mut() {
                    let size = source.as_ref().and_then(|s| s.size);
                    // A `data:` URI is decoded here, once, not by every
                    // platform at every load.
                    image.source = source.map(ImageSource::inline);
                    flags |= dirty::IMAGE;
                    let layout = node.layout.expect("image layout");
                    if let Some(LeafContext::Image(natural)) =
                        self.layout.get_node_context_mut(layout)
                        && *natural != size
                    {
                        *natural = size;
                        self.layout.mark_dirty(layout);
                        self.needs_layout = true;
                    }
                }
            }
            Prop::Image(option) => {
                if let Some(image) = node.image.as_mut() {
                    match option {
                        ImageProp::Placeholder(source) => {
                            image.options.placeholder = source.map(ImageSource::inline)
                        }
                        ImageProp::BlurRadius(r) => image.options.blur_radius = r.max(Points::ZERO),
                        ImageProp::FadeDuration(ms) => image.options.fade_ms = ms,
                        ImageProp::RetainPrevious(value) => image.options.retain_previous = value,
                        ImageProp::SvgCurrentColor(on) => image.svg_current_color = on,
                    }
                    flags |= dirty::IMAGE;
                }
            }
            Prop::Horizontal(horizontal) => {
                if self.nodes[key as usize]
                    .scroll
                    .as_ref()
                    .is_some_and(|scroll| scroll.horizontal != horizontal)
                {
                    let has_sources =
                        !self.source_texts.is_empty() || !self.source_providers.is_empty();
                    if has_sources {
                        self.mark_enclosing_reader_dirty(key, false);
                    }
                    let node = &mut self.nodes[key as usize];
                    node.scroll.as_mut().expect("scroll").horizontal = horizontal;
                    flags |= dirty::SCROLL;
                    let rtl = node.rtl;
                    if let Some(list) = node.list.as_mut() {
                        list.set_mirrored(horizontal && rtl);
                        list.set_horizontal(horizontal);
                    }
                    let children = node.children.clone();
                    self.sync_layout_style(key);
                    for child in children {
                        self.sync_layout_style(child);
                    }
                    if has_sources {
                        self.mark_enclosing_reader_dirty(key, false);
                    }
                    if self.nodes[key as usize]
                        .list
                        .as_ref()
                        .is_some_and(|l| l.parent)
                    {
                        self.sync_spacer(key, true);
                        self.outer_moved = true;
                        // Its children are read along the new axis.
                        flags |= dirty::VIEW_PROPS;
                    }
                }
            }
            Prop::Scrollbar(setting) => {
                if let Some(scroll) = node.scroll.as_mut() {
                    scroll.scrollbar = setting;
                    flags |= dirty::SCROLL;
                    self.scrollbars_pending.push(key);
                } else if let Some(input) = node.input.as_mut() {
                    input.scrollbar = setting;
                    flags |= dirty::INPUT;
                    self.scrollbars_pending.push(key);
                }
            }
            Prop::Scroll(prop) => {
                if let Some(scroll) = node.scroll.as_mut() {
                    let b = &mut scroll.behavior;
                    match prop {
                        ScrollProp::Paging(on) => b.paging = on,
                        ScrollProp::SnapInterval(v) => b.snap_interval = v.max(Points::ZERO),
                        ScrollProp::SnapOffsets(v) => b.snap_offsets = v,
                        ScrollProp::SnapAlignment(a) => b.snap_alignment = a,
                        ScrollProp::Deceleration(r) => b.deceleration = r,
                        ScrollProp::Bounces(on) => b.bounces = on,
                        ScrollProp::ScrollsToTop(on) => b.scrolls_to_top = on,
                        ScrollProp::SmoothWheel(on) => b.smooth_wheel = on,
                        ScrollProp::WheelLineHeight(h) => b.wheel_line_height = h.max(Points::ZERO),
                        ScrollProp::ContentInset(i) => b.content_inset = i,
                        ScrollProp::ScrollbarInset(i) => {
                            // Negative insets count as none.
                            b.scrollbar_inset = i.map(|v| Points(v.0.max(0.0)));
                            // A built-in bar is laid out within the insets.
                            if scroll.bar.is_some() {
                                self.needs_layout = true;
                            }
                        }
                        ScrollProp::KeyboardTaps(t) => b.keyboard_taps = t,
                        ScrollProp::DisableIntervalMomentum(on) => b.one_step = on,
                        ScrollProp::MinZoom(v) => b.min_zoom = v.max(0.01),
                        ScrollProp::MaxZoom(v) => b.max_zoom = v.max(0.01),
                        ScrollProp::BouncesZoom(on) => b.bounces_zoom = on,
                        ScrollProp::Pinch(on) => b.pinch = on,
                        ScrollProp::CenterContent(on) => b.center_content = on,
                        ScrollProp::RefreshIndicator(h) => {
                            // No height, no indicator: every release would refresh.
                            b.refresh_indicator = h.filter(|h| h.0 > 0.0);
                        }
                        ScrollProp::Zoom(scale) => {
                            // After the limits (sent with this commit's
                            // behavior) are applied.
                            let id = node.id;
                            self.commands.push((
                                id,
                                Command::ZoomTo {
                                    scale,
                                    center: None,
                                    animated: false,
                                },
                            ));
                        }
                        ScrollProp::EventThrottle(ms) => scroll.event_throttle_ms = ms.max(0.0),
                        ScrollProp::ContentOffset(offset) => {
                            // Where it starts: scrolled there after layout.
                            let id = node.id;
                            self.commands.push((
                                id,
                                Command::ScrollTo {
                                    x: offset.x,
                                    y: offset.y,
                                    animated: false,
                                },
                            ));
                        }
                    }
                    flags |= dirty::SCROLL_BEHAVIOR;
                }
            }
            Prop::Refreshing(refreshing) => {
                if let Some(scroll) = node.scroll.as_mut() {
                    scroll.refreshing = refreshing;
                    flags |= dirty::REFRESHING;
                }
            }
            Prop::ScrollValue(value) => {
                if let Some(value) = value {
                    self.reach.drive(value);
                }
                if let Some(scroll) = node.scroll.as_mut() {
                    scroll.scroll_value = value;
                    flags |= dirty::SCROLL;
                }
            }
            Prop::PullValue(value) => {
                if let Some(value) = value {
                    self.reach.drive(value);
                }
                if let Some(scroll) = node.scroll.as_mut() {
                    scroll.pull_value = value;
                    flags |= dirty::SCROLL;
                }
            }
            Prop::Count(count) => {
                if let Some(list) = node.list.as_mut()
                    && list.count != count
                {
                    list.unrequest(&take_queued_binds(&mut self.list_binds, node.id));
                    list.set_count(count);
                }
            }
            Prop::EstimatedItemSize(size) => {
                if let Some(list) = node.list.as_mut() {
                    list.set_estimated(size.0);
                }
            }
            Prop::Slot(slot) => {
                node.slot = Some(slot);
                let parent = node.parent;
                if let Some(list) = self
                    .nodes
                    .get_mut(parent as usize)
                    .and_then(|p| p.list.as_mut())
                {
                    list.add_slot_cell(slot, key);
                }
            }
            Prop::Splice(at, removed, inserted) => {
                let loads_at_start = node.events.contains(EventKind::LoadMoreAtStart);
                if let Some(list) = node.list.as_mut() {
                    list.loads_at_start = loads_at_start;
                    list.unrequest(&take_queued_binds(&mut self.list_binds, node.id));
                    list.splice(at, removed, inserted);
                }
            }
            Prop::ListDiff(diff) => {
                let loads_at_start = node.events.contains(EventKind::LoadMoreAtStart);
                if let Some(list) = node.list.as_mut() {
                    list.loads_at_start = loads_at_start;
                    list.unrequest(&take_queued_binds(&mut self.list_binds, node.id));
                    list.reorder(&diff);
                }
            }
            Prop::Columns(columns) => {
                if let Some(list) = node.list.as_mut()
                    && list.set_columns(columns)
                {
                    // Its cells are laid out again at the new width, even
                    // when nothing else in the turn lays anything out.
                    self.needs_layout = true;
                }
            }
            Prop::Inverted(inverted) => {
                if let Some(list) = node.list.as_mut() {
                    list.set_inverted(inverted);
                    if list.parent {
                        self.warn_ignored(key);
                    }
                }
            }
            Prop::FollowEnd(threshold) => {
                if let Some(list) = node.list.as_mut() {
                    list.set_follow_end(threshold.map(|t| t.0));
                    if list.parent {
                        self.warn_ignored(key);
                    }
                }
            }
            Prop::ListAlignment(alignment) => {
                if let Some(list) = node.list.as_mut() {
                    list.set_alignment(alignment);
                    if list.parent {
                        self.warn_ignored(key);
                    }
                }
            }
            Prop::StickyIndices(indices) => {
                if let Some(list) = node.list.as_mut() {
                    list.set_sticky(indices);
                    if list.parent {
                        self.warn_ignored(key);
                    }
                }
            }
            Prop::StickyOffset(offset) => {
                if let Some(list) = node.list.as_mut() {
                    list.set_sticky_node(None);
                    list.set_sticky_offset(offset.0);
                    if list.parent {
                        self.warn_ignored(key);
                    }
                }
            }
            Prop::StickyOffsetNode(node_id) => {
                if let Some(list) = node.list.as_mut() {
                    list.set_sticky_offset(0.0);
                    list.set_sticky_node(node_id);
                }
            }
            Prop::ListSourceRows(source) => {
                if let Some(list) = node.list.as_mut() {
                    let had = list.source_rows.is_some();
                    let has = source.is_some();
                    list.source_rows = source;
                    list.dirty = true;
                    if !had && has {
                        self.source_providers.push(key);
                    } else if had
                        && !has
                        && let Some(pos) = self.source_providers.iter().position(|&k| k == key)
                    {
                        self.source_providers.swap_remove(pos);
                    }
                    self.mark_enclosing_reader_dirty(key, false);
                }
            }
            Prop::ListContent(content) => {
                if let Some(list) = node.list.as_mut()
                    && list.set_content(content)
                {
                    self.needs_layout = true;
                }
            }
            Prop::Viewability(config) => {
                if let Some(list) = node.list.as_mut()
                    && list.viewability != config
                {
                    list.viewability = config;
                    list.dirty = true;
                }
            }
            Prop::LoadMoreThreshold(threshold) => {
                if let Some(list) = node.list.as_mut() {
                    list.end_threshold = threshold.max(0.0);
                }
            }
            Prop::LoadMoreAtStartThreshold(threshold) => {
                if let Some(list) = node.list.as_mut() {
                    list.start_threshold = threshold.max(0.0);
                }
            }
            Prop::CellIndex(index) => {
                let parent = node.parent;
                if let Some(list) = self
                    .nodes
                    .get_mut(parent as usize)
                    .and_then(|p| p.list.as_mut())
                {
                    list.rendered(key, index);
                }
            }
            Prop::PanValues(x, y) => {
                // A gesture drives them: no bound on where they take a view.
                for value in [x, y].into_iter().flatten() {
                    self.reach.drive(value);
                }
                (node.gestures.pan_x, node.gestures.pan_y) = (x, y);
                flags |= dirty::PAN;
            }
            Prop::PanEnabled(enabled) => {
                if node.pan_enabled != enabled {
                    node.pan_enabled = enabled;
                    flags |= dirty::PAN | dirty::EVENTS;
                }
            }
            Prop::PanScrollHandoff(value) => {
                let props = node.props.get_or_insert_default();
                if props.pan_scroll_handoff != value {
                    props.pan_scroll_handoff = value;
                    flags |= dirty::VIEW_PROPS;
                }
            }
            Prop::PinchValue(value) => {
                if let Some(value) = value {
                    self.reach.drive(value);
                }
                node.gestures.pinch = value;
                flags |= dirty::PAN;
            }
            Prop::RotationValue(value) => {
                if let Some(value) = value {
                    self.reach.drive(value);
                }
                node.gestures.rotation = value;
                flags |= dirty::PAN;
            }
            Prop::TextSource(source) => {
                if node.kind == Kind::Text && self.text_sources.get(&key).cloned() != source {
                    match source {
                        Some(s) => {
                            self.text_sources.insert(key, s);
                        }
                        None => {
                            self.text_sources.remove(&key);
                        }
                    }
                    self.mark_text_block(key);
                }
            }
            Prop::AllowFontScaling(allow) => {
                if node.paragraph.allow_font_scaling != allow {
                    node.paragraph.allow_font_scaling = allow;
                    self.font_settings_changed(key);
                }
            }
            Prop::SelectionColor(color) if node.input.is_none() => {
                if node.paragraph.selection_color != color {
                    node.paragraph.selection_color = color;
                    if node.kind == Kind::Text {
                        self.mark_text_block(key);
                    } else {
                        // A view's: the texts and inputs inside take it
                        // (`inherited_text_props`).
                        self.mark_inheriting_text(key);
                    }
                }
            }
            Prop::AdjustsFontSizeToFit(_) | Prop::MinimumFontScale(_) => {
                let before = (node.paragraph.fit, node.paragraph.min_font_scale);
                match prop {
                    Prop::AdjustsFontSizeToFit(on) => node.paragraph.fit = on,
                    Prop::MinimumFontScale(min) => node.paragraph.min_font_scale = min,
                    _ => {}
                }
                if (node.paragraph.fit, node.paragraph.min_font_scale) != before {
                    self.queue_text(key);
                    if let Some(layout) = self.nodes[key as usize].layout
                        && let Some(LeafContext::Text(cx)) =
                            self.layout.get_node_context_mut(layout)
                    {
                        cx.laid_out = None;
                        cx.source_geometry = None;
                    }
                }
            }
            Prop::MaxFontSizeMultiplier(max) => {
                if node.paragraph.max_font_multiplier != max {
                    node.paragraph.max_font_multiplier = max;
                    self.font_settings_changed(key);
                }
            }
            Prop::PointerEvents(value) => {
                let props = node.props.get_or_insert_default();
                if props.pointer_events != value {
                    props.pointer_events = value;
                    flags |= dirty::VIEW_PROPS;
                }
            }
            Prop::HitSlop(value) => {
                let props = node.props.get_or_insert_default();
                if props.hit_slop != value {
                    props.hit_slop = value;
                    flags |= dirty::VIEW_PROPS;
                    slop_moved = true;
                }
            }
            Prop::Href(value) => {
                let value = value.filter(|href| !href.is_empty());
                let props = node.props.get_or_insert_default();
                if props.href != value {
                    props.href = value;
                    flags |= dirty::VIEW_PROPS;
                }
            }
            Prop::PanActivation(value) => {
                let props = node.props.get_or_insert_default();
                if props.pan_activation != value {
                    props.pan_activation = value;
                    flags |= dirty::VIEW_PROPS;
                }
            }
            Prop::InsetPadding(insets) | Prop::InsetMargin(insets) => {
                let slot = usize::from(matches!(prop, Prop::InsetMargin(_)));
                let mut all = node.insets.as_deref().copied().unwrap_or_default();
                if all[slot] != insets {
                    all[slot] = insets;
                    node.insets = (all != <[EdgeInsets; 2]>::default()).then(|| Box::new(all));
                    self.restyle(key);
                }
                return Ok(());
            }
            Prop::Class(names) => {
                self.set_classes(key, Some(names), None);
                return Ok(());
            }
            Prop::ClassList(list) => {
                self.set_classes(key, None, Some(list));
                return Ok(());
            }
            Prop::TailwindTheme(json) => {
                self.set_tailwind_theme(&json);
                return Ok(());
            }
            Prop::UiTheme(json) => {
                self.set_ui_theme(&json);
                return Ok(());
            }
            Prop::LayoutDirection(rtl) => {
                // The surface's direction (the root's): the user's language, as
                // JS or the policy sets it.
                if key == self.root && node.direction != Some(rtl) {
                    node.direction = Some(rtl);
                    self.mount.push(MountItem::LayoutDirection { rtl });
                    self.update_direction(key);
                    self.root_direction_changed(rtl);
                }
                return Ok(());
            }
            Prop::Appearance(appearance) => {
                // The app's appearance (the root's): `nsh.json`,
                // `setColorScheme`.
                if key == self.root {
                    self.set_appearance(appearance);
                }
                return Ok(());
            }
            Prop::Keymap(keymap) => {
                // The surface's shortcuts (the root's): `nsh/keymap`.
                if key == self.root {
                    self.mount.push(MountItem::Keymap(keymap));
                }
                return Ok(());
            }
            Prop::LongPressDelay(value) => {
                let props = node.props.get_or_insert_default();
                if props.long_press_delay != value {
                    props.long_press_delay = value;
                    flags |= dirty::VIEW_PROPS;
                }
            }
            Prop::Ripple(value) => {
                let props = node.props.get_or_insert_default();
                if props.ripple != value {
                    props.ripple = value;
                    flags |= dirty::VIEW_PROPS;
                }
            }
            Prop::Elevation(value) => {
                let value = value.max(Points::ZERO);
                if node.elevation != value {
                    node.elevation = value;
                    flags |= dirty::VIEW;
                }
            }
            Prop::BackdropMaterial(value) => {
                if node.backdrop_material != value {
                    node.backdrop_material = value;
                    flags |= dirty::VIEW;
                }
            }
            Prop::MacOsBackdrop(value) => {
                if node.macos_backdrop != value {
                    node.macos_backdrop = value;
                    flags |= dirty::VIEW;
                }
            }
            Prop::WindowsBackdrop(value) => {
                if node.windows_backdrop != value {
                    node.windows_backdrop = value;
                    flags |= dirty::VIEW;
                }
            }
            Prop::ActiveStyle(patch) => {
                self.set_part_style(key, classes::Part::Active, patch);
                return Ok(());
            }
            Prop::HoverStyle(patch) => {
                self.set_part_style(key, classes::Part::Hover, patch);
                return Ok(());
            }
            Prop::FocusStyle(patch) => {
                self.set_part_style(key, classes::Part::Focus, patch);
                return Ok(());
            }
            Prop::DisabledStyle(patch) => {
                self.set_part_style(key, classes::Part::Disabled, patch);
                return Ok(());
            }
            Prop::SelectedStyle(patch) => {
                self.set_part_style(key, classes::Part::Selected, patch);
                return Ok(());
            }
            Prop::CheckedStyle(patch) => {
                self.set_part_style(key, classes::Part::Checked, patch);
                return Ok(());
            }
            Prop::IndeterminateStyle(patch) => {
                self.set_part_style(key, classes::Part::Indeterminate, patch);
                return Ok(());
            }
            Prop::PressedStyle(patch) => {
                self.set_part_style(key, classes::Part::Pressed, patch);
                return Ok(());
            }
            Prop::ExpandedStyle(patch) => {
                self.set_part_style(key, classes::Part::Expanded, patch);
                return Ok(());
            }
            Prop::FocusWithinStyle(patch) => {
                self.set_part_style(key, classes::Part::FocusWithin, patch);
                return Ok(());
            }
            Prop::FocusVisibleStyle(patch) => {
                self.set_part_style(key, classes::Part::FocusVisible, patch);
                return Ok(());
            }
            Prop::ProjectedStates(states) => {
                self.set_projected_states(key, states);
                return Ok(());
            }
            Prop::ProjectedData(data) => {
                self.set_projected_data(key, data);
                return Ok(());
            }
            Prop::ProjectedActive(group) => {
                self.set_projected_active(key, group);
                return Ok(());
            }
            Prop::HeaderStyle(patch) => {
                self.set_part_style(key, classes::Part::Header, patch);
                return Ok(());
            }
            Prop::HeaderClass(names) => {
                self.set_part_class(key, classes::Part::Header, &names);
                return Ok(());
            }
            Prop::HeaderClassList(list) => {
                self.set_part_class_list(key, classes::Part::Header, list);
                return Ok(());
            }
            Prop::ListContentClass(names) => {
                self.set_part_class(key, classes::Part::Content, &names);
                return Ok(());
            }
            Prop::TestId(value) => {
                let props = node.props.get_or_insert_default();
                if props.test_id != value {
                    props.test_id = value;
                    flags |= dirty::VIEW_PROPS;
                    // A span's id is recorded in its block's text.
                    if node.kind == Kind::Text && node.inline {
                        rebuild_span = true;
                    }
                }
            }
            Prop::CopyText(value) => {
                if node.copy_text != value {
                    node.copy_text = value;
                    // Its block's text holds it; a render's content's is
                    // its placeholder's (`Core::attachment_copy_text`).
                    copy_text_changed = true;
                }
            }
            Prop::WebElement(value) => {
                let props = node.props.get_or_insert_default();
                if props.web_element != value {
                    props.web_element = value;
                    flags |= dirty::VIEW_PROPS;
                }
            }
            Prop::WindowDrag(value) => {
                let props = node.props.get_or_insert_default();
                if props.window_drag != value {
                    props.window_drag = value;
                    flags |= dirty::VIEW_PROPS;
                }
            }
            Prop::WindowControl(value) => {
                let props = node.props.get_or_insert_default();
                if props.window_control != value {
                    props.window_control = value;
                    flags |= dirty::VIEW_PROPS;
                }
            }
            Prop::WindowResize(value) => {
                let props = node.props.get_or_insert_default();
                if props.window_resize != value {
                    props.window_resize = value;
                    flags |= dirty::VIEW_PROPS;
                }
            }
            Prop::Focusable(value) => {
                let props = node.props.get_or_insert_default();
                if props.focusable != value {
                    props.focusable = value;
                    flags |= dirty::VIEW_PROPS;
                }
            }
            Prop::KeyCapture(value) => {
                let props = node.props.get_or_insert_default();
                if props.key_capture != value {
                    props.key_capture = value;
                    flags |= dirty::VIEW_PROPS;
                    key_ancestry = true;
                }
            }
            Prop::SelectableView(value) => {
                let props = node.props.get_or_insert_default();
                if props.selectable_view != value {
                    props.selectable_view = value;
                    flags |= dirty::VIEW_PROPS;
                }
            }
            Prop::SelectionMenu(items) => {
                let items: std::sync::Arc<[crate::desktop::MenuItem]> =
                    crate::desktop::MenuItem::selection_menu(&items).into();
                let props = node.props.get_or_insert_default();
                if props.selection_menu != items {
                    props.selection_menu = items;
                    flags |= dirty::VIEW_PROPS;
                }
            }
            Prop::ContinuesText(value) => {
                let props = node.props.get_or_insert_default();
                if props.continues_text != value {
                    props.continues_text = value;
                    flags |= dirty::VIEW_PROPS;
                }
            }
            Prop::Accessibility(prop) => {
                // A label changing on mounted props goes alone: it is
                // the one that follows app state (a count, a value).
                let label_only =
                    node.props.is_some() && matches!(prop, AccessibilityProp::Label(_));
                let props = node.props.get_or_insert_default();
                let a = &mut props.accessibility;
                let before = a.clone();
                match prop {
                    AccessibilityProp::Accessible(v) => a.accessible = v,
                    AccessibilityProp::Label(v) => a.label = v,
                    AccessibilityProp::Hint(v) => a.hint = v,
                    AccessibilityProp::Description(v) => a.description = v,
                    AccessibilityProp::Role(v) => a.role = v,
                    AccessibilityProp::State(v) => a.state = v,
                    AccessibilityProp::Value(v) => a.value = v,
                    AccessibilityProp::Hidden(v) => a.hidden = v,
                    AccessibilityProp::Important(accessible, hidden) => {
                        a.accessible = accessible;
                        a.hidden = hidden;
                    }
                    AccessibilityProp::LiveRegion(v) => a.live_region = v,
                    AccessibilityProp::Actions(v) => a.actions = v,
                    AccessibilityProp::Level(v) => a.level = v,
                    AccessibilityProp::Orientation(v) => a.orientation = v,
                    // Set as relations, above.
                    AccessibilityProp::ActiveDescendant(_)
                    | AccessibilityProp::Controls(_)
                    | AccessibilityProp::DescribedBy(_) => {}
                }
                let states = classes::accessibility_states(&a.state);
                let states_changed = states != classes::accessibility_states(&before.state);
                if *a != before {
                    flags |= if label_only {
                        dirty::LABEL
                    } else {
                        dirty::VIEW_PROPS
                    };
                }
                if states_changed {
                    if flags != 0 {
                        self.mark(key, flags);
                        if self.nodes[key as usize].kind == Kind::Text {
                            self.mark_text_block(key);
                        }
                    }
                    self.set_accessibility_states(key, states);
                    return Ok(());
                }
            }
            Prop::KeyboardDismissMode(mode) => {
                if let Some(scroll) = node.scroll.as_mut() {
                    scroll.keyboard_dismiss = mode;
                    flags |= dirty::SCROLL;
                }
            }
            // `animation` on a dialog: the value pages and dialogs share.
            Prop::Screen(ScreenProp::Animation(a)) if node.kind == Kind::Modal => {
                if let Some(root) = node.root.as_mut() {
                    root.modal.animation = match a {
                        ScreenAnimation::Default => ModalAnimation::Slide,
                        ScreenAnimation::Fade => ModalAnimation::Fade,
                        ScreenAnimation::None => ModalAnimation::None,
                    };
                    flags |= dirty::MODAL;
                }
            }
            Prop::Screen(prop) => {
                if let Some(root) = node.root.as_mut() {
                    let c = &mut root.screen;
                    match prop {
                        ScreenProp::Title(v) => c.title = v,
                        ScreenProp::HeaderVisible(v) => c.header_visible = v,
                        ScreenProp::HeaderLargeTitle(v) => c.large_title = v,
                        ScreenProp::HeaderTransparent(v) => c.header_transparent = v,
                        ScreenProp::HeaderShadowVisible(v) => c.header_shadow_visible = v,
                        ScreenProp::HeaderTitleAlign(v) => c.title_align = v,
                        ScreenProp::HeaderBackgroundOnScroll(v) => {
                            c.header_background_on_scroll = v
                        }
                        ScreenProp::HidesBottomBarWhenPushed(v) => {
                            c.hides_bottom_bar_when_pushed = v
                        }
                        ScreenProp::HeaderBackTitle(v) => c.back_title = v,
                        ScreenProp::HeaderBackVisible(v) => c.back_visible = v,
                        ScreenProp::HeaderRightSystemItem(v) => c.right_system_item = v,
                        ScreenProp::HeaderRightSymbol(v) => c.right_symbol = v,
                        ScreenProp::HeaderLeftSystemItem(v) => c.left_system_item = v,
                        ScreenProp::HeaderLeftSymbol(v) => c.left_symbol = v,
                        ScreenProp::HeaderRightItems(v) => c.right_items = v,
                        ScreenProp::PopOnSwipe(v) => c.gesture_enabled = v,
                        ScreenProp::PopOnBack(v) => c.prevent_back = !v,
                        ScreenProp::Animation(v) => c.animation = v,
                        // Taken by `set_prop`.
                        ScreenProp::StatusBar(_) | ScreenProp::Orientations(_) => {}
                    }
                    // Header changes move the content.
                    root.laid_out = None;
                    self.needs_layout = true;
                    flags |= dirty::SCREEN;
                }
            }
            Prop::NativeId(name) => {
                if node.kind == Kind::InputAccessory {
                    let attached = node.parent != NO_KEY;
                    if attached {
                        self.accessory_attached(key, false);
                    }
                    if let Some(root) = self.nodes[key as usize].root.as_mut() {
                        root.native_id = name;
                    }
                    if attached {
                        self.accessory_attached(key, true);
                    }
                    return Ok(());
                }
                // Other views: the embedding app finds them by it
                // (`watchScroll`).
                let value: Option<Arc<str>> = name.as_deref().map(Into::into);
                let props = node.props.get_or_insert_default();
                if props.native_id != value {
                    props.native_id = value;
                    flags |= dirty::VIEW_PROPS;
                }
            }
            Prop::Modal(prop) => {
                if let Some(root) = node.root.as_mut() {
                    let c = &mut root.modal;
                    match prop {
                        ModalProp::Animation(v) => c.animation = v,
                        ModalProp::Presentation(v) => c.presentation = v,
                        ModalProp::StatusBarTranslucent(v) => c.status_bar_translucent = v,
                        ModalProp::Orientations(v) => c.orientations = v,
                        ModalProp::CloseOnEscape(v) => c.close_on_escape = v,
                        ModalProp::CloseOnBackdropPress(v) => c.close_on_backdrop_press = v,
                        ModalProp::CloseOnSwipe(v) => c.close_on_swipe = v,
                        ModalProp::Detents(v) => c.detents = v,
                        ModalProp::Detent(v) => c.detent = v,
                        ModalProp::DefaultDetent(v) => c.default_detent = v,
                        ModalProp::Grabber(v) => c.grabber = v,
                        ModalProp::LargestUndimmedDetent(v) => c.largest_undimmed_detent = v,
                    }
                    flags |= dirty::MODAL;
                }
            }
            Prop::Overlay(prop) => {
                use crate::OverlayProp;
                self.set_overlay_config(key, |c| match prop {
                    OverlayProp::Anchor(v) => c.anchor = v,
                    OverlayProp::Placement(v) => c.placement = v,
                    OverlayProp::Align(v) => c.align = v,
                    OverlayProp::Offset(v) => c.offset = v,
                    OverlayProp::Margin(v) => c.margin = v,
                    OverlayProp::Hint(v) => c.hint = v,
                    OverlayProp::Open(v) => c.open = v,
                    OverlayProp::Cover(v) => c.cover = v,
                });
                return Ok(());
            }
            Prop::Tooltip(content) => {
                self.set_tooltip(key, content);
                return Ok(());
            }
            Prop::HeaderSlot(slot) => {
                if let Some(root) = node.root.as_mut()
                    && root.slot != slot
                {
                    root.slot = slot;
                    let parent = node.parent;
                    if parent != NO_KEY {
                        self.mark(parent, dirty::SCREEN);
                    }
                }
            }
            // `scrollable` of scroll views and lists.
            Prop::Native(NativeProp::Scrollable(on)) if node.scroll.is_some() => {
                let changed = self.nodes[key as usize]
                    .scroll
                    .as_ref()
                    .is_some_and(|scroll| scroll.behavior.enabled != on);
                let has_sources =
                    !self.source_texts.is_empty() || !self.source_providers.is_empty();
                if changed && has_sources {
                    self.mark_enclosing_reader_dirty(key, false);
                }
                if let Some(scroll) = self.nodes[key as usize].scroll.as_mut() {
                    scroll.behavior.enabled = on;
                    flags |= dirty::SCROLL_BEHAVIOR;
                }
                if changed && has_sources {
                    self.mark_enclosing_reader_dirty(key, false);
                }
            }
            Prop::Component(name) => {
                let created = node.created;
                if let Some(component) = node.component.as_mut() {
                    match &component.name {
                        // Named after its native view was made (a Rust
                        // component whose root is `native()` takes its
                        // host's place, which is made first): the platform
                        // is told now, and gets every prop again after it.
                        None if created => {
                            component.name = Some(name.clone());
                            component.changed =
                                component.props.iter().map(|(k, _)| k.clone()).collect();
                            self.mount.push(MountItem::Component { id, name });
                            flags |= dirty::COMPONENT;
                            if !component.slots.is_empty() {
                                component.slots_changed.set(true);
                                flags |= dirty::ANIMATION;
                            }
                        }
                        None => component.name = Some(name),
                        Some(old) if *old != name => log::warn!(
                            target: "js",
                            "a native component cannot change from `{old}` to `{name}`; render a new element"
                        ),
                        Some(_) => {}
                    }
                }
            }
            Prop::ComponentPropBinding(name, value) => {
                if let Some(component) = node.component.as_mut() {
                    let slot = match component.slots.iter().position(|k| *k == name) {
                        Some(s) => Some(s as u16),
                        None if value.is_none() => None,
                        None => {
                            component.slots.push(name.clone());
                            component.slots_changed.set(true);
                            Some((component.slots.len() - 1) as u16)
                        }
                    };
                    if let Some(slot) = slot {
                        let at = component.bound.iter().position(|(s, _)| *s == slot);
                        match (at, value) {
                            (Some(i), Some(n)) => component.bound[i].1 = n,
                            (None, Some(n)) => component.bound.push((slot, n)),
                            (Some(i), None) => {
                                component.bound.remove(i);
                                // Its static value (or its removal) is sent again.
                                if !component.changed.contains(&name) {
                                    component.changed.push(name);
                                }
                                flags |= dirty::COMPONENT;
                            }
                            (None, None) => {}
                        }
                        flags |= dirty::ANIMATION;
                    }
                }
            }
            Prop::ComponentProp(name, value) => {
                if let Some(component) = node.component.as_mut() {
                    let at = component.props.iter().position(|(k, _)| *k == name);
                    match (at, value) {
                        (Some(i), Some(v)) => component.props[i].1 = v,
                        (None, Some(v)) => component.props.push((name.clone(), v)),
                        (Some(i), None) => {
                            component.props.swap_remove(i);
                        }
                        (None, None) => {}
                    }
                    if !component.changed.contains(&name) {
                        component.changed.push(name);
                    }
                    flags |= dirty::COMPONENT;
                }
            }
            Prop::Native(prop) => {
                if let NativeProp::Disabled(d) = prop {
                    // `disabled:` classes, on any element.
                    self.set_disabled(key, d);
                }
                let node = &mut self.nodes[key as usize];
                // The platforms make a web view with its website data store
                // and the URL schemes it serves, from its first props.
                if node.created
                    && let Some(NativeProps::WebView(p)) = node.control.as_deref()
                {
                    let changed = match &prop {
                        NativeProp::Incognito(on) => Some(("`incognito` is", *on != p.incognito)),
                        // A re-render builds new handlers: only a change
                        // of the schemes served is worth a warning.
                        NativeProp::UrlSchemes(schemes) => Some((
                            "URL schemes are",
                            !schemes
                                .iter()
                                .map(|s| s.scheme())
                                .eq(p.url_schemes.iter().map(|s| s.scheme())),
                        )),
                        _ => None,
                    };
                    if let Some((what, changed)) = changed {
                        if changed {
                            log::warn!(
                                target: "js",
                                "a web view's {what} read when it is made; render a new element to change it"
                            );
                        }
                        return Ok(());
                    }
                }
                if let Some(control) = node.control.as_mut() {
                    apply_native(control, prop);
                    flags |= dirty::NATIVE;
                }
            }
            Prop::Value(value) => {
                if let Some(input) = node.input.as_mut() {
                    input.value_set = true;
                    if input.value != value {
                        input.value = value;
                        flags |= dirty::INPUT_VALUE;
                        self.measure_input(key);
                    }
                }
            }
            Prop::DefaultValue(value) => {
                if let Some(input) = node.input.as_mut()
                    && !input.value_set
                {
                    input.value_set = true;
                    input.value = value;
                    flags |= dirty::INPUT_VALUE;
                    self.measure_input(key);
                }
            }
            prop => {
                let Some(input) = node.input.as_mut() else {
                    return Ok(());
                };
                let c = &mut input.config;
                let remeasure = match prop {
                    Prop::Placeholder(text) => {
                        c.placeholder = text;
                        true
                    }
                    Prop::Multiline(multiline) => {
                        c.multiline = multiline;
                        // Only a multiline input shows a built-in bar.
                        self.scrollbars_pending.push(key);
                        true
                    }
                    Prop::PlaceholderColor(color) => {
                        c.placeholder_color = color;
                        false
                    }
                    Prop::Secure(secure) => {
                        c.secure = secure;
                        false
                    }
                    Prop::KeyboardType(keyboard) => {
                        c.keyboard = keyboard;
                        false
                    }
                    Prop::KeyboardAppearance(appearance) => {
                        c.keyboard_appearance = appearance;
                        false
                    }
                    Prop::ReturnKeyType(key) => {
                        c.return_key = key;
                        false
                    }
                    Prop::AutoCapitalize(mode) => {
                        c.auto_capitalize = mode;
                        false
                    }
                    Prop::AutoCorrect(on) => {
                        c.auto_correct = on;
                        false
                    }
                    Prop::MaxLength(len) => {
                        c.max_length = len;
                        false
                    }
                    Prop::Readonly(on) => {
                        c.editable = !on;
                        false
                    }
                    Prop::SubmitBehavior(behavior) => {
                        c.submit_behavior = behavior;
                        false
                    }
                    Prop::PasteBehavior(behavior) => {
                        c.paste_behavior = behavior;
                        false
                    }
                    Prop::AutoFocus(on) => {
                        c.auto_focus = on;
                        false
                    }
                    Prop::SelectTextOnFocus(on) => {
                        c.select_text_on_focus = on;
                        false
                    }
                    Prop::Caret(on) => {
                        c.caret_hidden = !on;
                        false
                    }
                    Prop::InputAccessoryViewId(name) => {
                        c.accessory_id = name;
                        false
                    }
                    Prop::SelectionColor(color) => {
                        c.selection_color = color;
                        false
                    }
                    Prop::CaretColor(color) => {
                        c.caret_color = color;
                        false
                    }
                    Prop::AutoFill(fill) => {
                        c.auto_fill = fill;
                        false
                    }
                    Prop::Selection(start, end) => {
                        // Applied after the batch's value.
                        let id = node.id;
                        self.commands
                            .push((id, Command::SetSelection { start, end }));
                        return Ok(());
                    }
                    _ => return Ok(()),
                };
                flags |= dirty::INPUT;
                if remeasure {
                    self.measure_input(key);
                }
            }
        }
        if flags != 0 {
            self.mark(key, flags);
            if self.nodes[key as usize].kind == Kind::Text {
                // Inline texts have no native view: their interaction props
                // must travel in the containing block's TextLink metadata.
                self.mark_text_block(key);
            }
        }
        if slop_moved {
            self.slop_moved.push(key);
        }
        if rebuild_span {
            self.mark_text_block(key);
        }
        if copy_text_changed {
            if self.nodes[key as usize].inline {
                self.mark_text_block(key);
            } else if let Some(place) = self.placed_in_text(key) {
                self.mark_text_block(place);
            }
        }
        if key_ancestry {
            self.key_ancestry_dirty = true;
        }
        Ok(())
    }

    /// Puts loose run `child_id` in text block or span `parent` without a
    /// node when it is the only child there; false when it cannot.
    fn fold_run(
        &mut self,
        parent: Key,
        parent_id: NodeId,
        child_id: NodeId,
        before: Option<NodeId>,
    ) -> bool {
        let node = &self.nodes[parent as usize];
        if before.is_some()
            || node.kind != Kind::Text
            || !node.children.is_empty()
            || self.folded.contains_key(&parent)
            || self.components.slot_hosts.contains_key(&parent_id)
        {
            return false;
        }
        let Some(run) = self.runs.get_mut(&child_id) else {
            return false;
        };
        // Moved from another block (no Remove first).
        let from = std::mem::replace(&mut run.block, parent);
        if from != NO_KEY {
            self.folded.remove(&from);
            self.mark_text_block(from);
        }
        self.folded.insert(parent, child_id);
        self.mark_text_block(parent);
        true
    }

    /// Takes run `id` out of its block, keeping it without a node.
    fn unfold_run(&mut self, id: NodeId) {
        let Some(run) = self.runs.get_mut(&id) else {
            return;
        };
        let block = std::mem::replace(&mut run.block, NO_KEY);
        if block != NO_KEY {
            self.folded.remove(&block);
            self.mark_text_block(block);
        }
    }

    /// Gives run `id` its node, in its block if it is in one (for any use
    /// other than holding text as a block's only child). Remove it from
    /// `runs` during allocation so the quota counts it only once, and
    /// restore it on failure so its block keeps its text.
    pub(super) fn materialize_run(&mut self, id: NodeId) -> Result<(), ApplyError> {
        let Some(run) = self.runs.remove(&id) else {
            return Ok(());
        };
        let key = match self.alloc(id, Kind::RawText) {
            Ok(key) => key,
            Err(e) => {
                self.runs.insert(id, run);
                return Err(e);
            }
        };
        self.nodes[key as usize].text = run.text;
        if run.block != NO_KEY {
            self.folded.remove(&run.block);
            let parent = self.nodes[run.block as usize].id;
            let _ = self.insert(parent, id, None);
        }
        Ok(())
    }

    /// The text of the run text block or span `key` holds without a node.
    fn folded_text(&self, key: Key) -> Option<&str> {
        if self.folded.is_empty() {
            return None;
        }
        let id = self.folded.get(&key)?;
        self.runs.get(id).map(|r| r.text.as_str())
    }

    fn insert(
        &mut self,
        parent_id: NodeId,
        child_id: NodeId,
        before: Option<NodeId>,
    ) -> Result<(), ApplyError> {
        let parent = self.key(parent_id)?;
        if !self.runs.is_empty() || !self.folded.is_empty() {
            if self.fold_run(parent, parent_id, child_id, before) {
                return Ok(());
            }
            self.materialize_run(child_id)?;
            if let Some(b) = before {
                self.materialize_run(b)?;
            }
            if let Some(&run) = self.folded.get(&parent) {
                self.materialize_run(run)?;
            }
        }
        let child = self.key(child_id)?;
        let from = self.nodes[child as usize].parent;
        if from != NO_KEY {
            self.input_bar_moves(child);
            self.note_move(from, parent);
        }
        let mut before = before.map(|b| self.key(b)).transpose()?;
        // Appended below the built-in bar, which stays on top.
        if before.is_none()
            && let Some((bar, _)) = self.nodes[parent as usize]
                .scroll
                .as_ref()
                .and_then(|s| s.bar.as_ref())
            && let Ok(bar) = self.key(*bar)
            && bar != child
        {
            before = Some(bar);
        }
        let Some(depth) = self
            .depth_outside(child, parent)
            .filter(|_| child != self.root)
        else {
            return Err(ApplyError::Cycle(child_id));
        };
        let max = MAX_TREE_DEPTH as u32;
        if depth + self.nodes[child as usize].height > max {
            // What left the child since may have made it shallower.
            if depth + self.count_heights(child) > max {
                return Err(ApplyError::TooDeep(MAX_TREE_DEPTH));
            }
        }
        if self.nodes[parent as usize]
            .shader
            .as_ref()
            .is_some_and(|s| {
                matches!(
                    s.role,
                    crate::shader::ShaderRole::Screen | crate::shader::ShaderRole::ScreenTransition
                )
            })
        {
            // It takes no space, so a child lays out in nothing: the
            // surface is what it draws through.
            log::warn!(
                target: "js",
                "node {child_id} in screen effect {parent_id}: a screen effect or transition has no children"
            );
        }
        if let Some(b) = before
            && (b == child || self.nodes[b as usize].parent != parent)
        {
            return Err(ApplyError::BadAnchor(self.nodes[b as usize].id));
        }

        // Detach from the current position. A native view that stays visible
        // is moved by the insert below, so only emit a remove when the new
        // parent has no native view.
        let parent_created = self.nodes[parent as usize].created;
        if self.nodes[child as usize].parent != NO_KEY {
            self.unlink(child, !parent_created);
        }

        let p = &self.nodes[parent as usize];
        // Inside a block or a span (not inside an attachment: its children
        // are its own layout's).
        let inline = p.kind == Kind::Text && !self.nodes[child as usize].fixed_view;
        let pos = match before {
            Some(b) => {
                let (pos, looked) = position_from_ends(&p.children, &b).expect("anchor is a child");
                self.placing(looked);
                pos
            }
            None => p.children.len(),
        };
        self.set_inline(child, inline);
        if !inline {
            // An attachment hidden with its span leaves the text: shown
            // where it goes (in a text, its block decides again).
            self.set_hidden_in_text(child, false);
        }
        self.nodes[child as usize].parent = parent;
        self.unparented_nodes -= 1;
        if self.nodes[child as usize].kind == Kind::Overlay {
            // Its logical parent changed: find its keyboard override again.
            self.key_ancestry_dirty = true;
        }
        self.nodes[parent as usize].children.insert(pos, child);
        self.raise_heights(child);
        self.key_content_changed(parent);
        self.rank_noted(child);
        self.tree_order_changed |= self.track_tree_order;
        self.tab_places_stale = true;
        if self.nodes[child as usize].states & crate::tailwind::state::FOCUS_WITHIN != 0 {
            // The focus moved with it: the views around it now.
            self.focus_moved = true;
        }
        self.ch_changed(child);
        self.status_bars_moved |= !self.status_bar_nodes.is_empty();
        self.outer_moved |= !self.parent_lists.is_empty() && self.may_hold_page_list(child);
        self.sticky_changed |= !self.sticky_nodes.is_empty();
        self.update_direction(child);
        if self.nodes[parent as usize].child_perspective.is_some() {
            self.mark(child, dirty::VIEW | dirty::ANIMATION);
        }
        let node = &self.nodes[parent as usize];
        let color = node.text_style.color.or(node.inherited_color);
        if self.nodes[child as usize].inherited_color != color {
            self.inherit_color_from(child, color);
        }
        self.groups_changed(child, parent);
        if self.nodes[child as usize]
            .classes
            .as_ref()
            .is_some_and(|c| c.deps() & crate::tailwind::deps::POSITION != 0)
        {
            self.nodes[parent as usize].positional_children = true;
        }
        if self.nodes[parent as usize].positional_children {
            self.positions_changed(parent);
        }
        self.spacing_changed(parent, child);
        if self.pointer_none_classes > 0 {
            self.pointer_events_moved(parent);
        }

        if inline {
            if self.nodes[child as usize].placeholder {
                self.ask_row(child);
            }
            self.mark_text_block(parent);
            return Ok(());
        }
        // A cell joining a list: register its slot and derive its style
        // from the list orientation.
        if self.nodes[parent as usize].list.is_some() {
            if let Some(slot) = self.nodes[child as usize].slot {
                self.nodes[parent as usize]
                    .list
                    .as_mut()
                    .expect("list")
                    .add_slot_cell(slot, child);
            }
            self.sync_layout_style(child);
        }
        let child_kind = self.nodes[child as usize].kind;
        if child_kind == Kind::InputAccessory {
            self.accessory_attached(child, true);
        }
        if child_kind == Kind::HeaderItem {
            self.mark(parent, dirty::SCREEN);
        }
        if let Some(child_layout) = self.nodes[child as usize].layout {
            // List cells, screens, modals and header items stay independent
            // layout roots.
            if self.nodes[parent as usize].list.is_none()
                && !self.nodes[child as usize].is_layout_root()
            {
                let index = self.layout_index_at(parent, pos);
                let parent_layout = self.nodes[parent as usize]
                    .layout
                    .expect("block parent has layout");
                self.layout
                    .insert_child_at_index(parent_layout, index as usize, child_layout);
            }
            self.needs_layout = true;
            // A dialog opening in content a scroll view has not made yet
            // makes the views around it: it shows over everything.
            let parent_created = parent_created
                || (child_kind == Kind::Modal
                    && self.nodes[parent as usize].culled
                    && self.uncull(parent));
            // An overlay's native view goes to its root view
            // (`sync_overlays`).
            if parent_created
                && !self.nodes[child as usize].is_overlay()
                && !{
                    let scope = self.cull_scope(parent);
                    self.hold_back(scope, child)
                }
            {
                self.ensure_created(child);
                let before = match self.nodes[parent as usize].list.as_ref() {
                    // Below the sticky cells of a list in its parent's
                    // viewport, which stay on top.
                    Some(list) if list.parent && !list.sent_sticky.is_empty() => {
                        self.below_sticky(parent, child)
                    }
                    _ => self.native_before_at(parent, child, pos),
                };
                // By the nodes' own ids (the ops may name an alias).
                self.mount.push(MountItem::Insert {
                    parent: self.nodes[parent as usize].id,
                    child: self.nodes[child as usize].id,
                    before,
                });
            }
        }
        Ok(())
    }

    /// Detaches `key` from its parent (Remove op).
    fn detach(&mut self, key: Key) {
        self.input_bar_moves(key);
        self.unlink(key, true);
    }

    /// A multiline input with a built-in bar beside it leaves its place:
    /// the bar goes, and is made again beside it where it goes.
    fn input_bar_moves(&mut self, key: Key) {
        let node = &self.nodes[key as usize];
        if node.input.as_ref().is_some_and(|i| i.bar.is_some()) {
            self.release_scrollbar(key);
            self.scrollbars_pending.push(key);
        }
    }

    fn remove_layout(
        layout_tree: &mut layout_tree::LayoutTree<LeafContext<M::Prepared>>,
        source_texts: &mut Vec<Key>,
        key: Key,
        layout: taffy::NodeId,
    ) {
        if matches!(
            layout_tree.get_node_context(layout),
            Some(LeafContext::Text(cx)) if !cx.sources.is_empty()
        ) && let Some(pos) = source_texts.iter().position(|&k| k == key)
        {
            source_texts.swap_remove(pos);
        }
        layout_tree.remove(layout);
    }

    /// Unlinks `key` from its parent's children, layout and (optionally)
    /// native hierarchy.
    fn unlink(&mut self, key: Key, emit_remove: bool) {
        if self.nodes[key as usize].kind == Kind::Modal && self.nodes[key as usize].created {
            self.restoring_modal_focus = true;
        }
        let parent = self.nodes[key as usize].parent;
        let siblings = &mut self.nodes[parent as usize].children;
        let pos = siblings
            .iter()
            .position(|&c| c == key)
            .expect("child of parent");
        siblings.remove(pos);
        self.key_content_changed(parent);
        self.tree_order_changed |= self.track_tree_order;
        self.tab_places_stale = true;
        if !self.source_texts.is_empty() || !self.source_providers.is_empty() {
            self.mark_enclosing_reader_dirty(parent, true);
        }
        if let Some(list) = self.nodes[parent as usize].list.as_mut() {
            list.remove_cell(key);
        }
        if self.nodes[parent as usize].positional_children {
            self.positions_changed(parent);
        }
        let unlinked_id = self.nodes[key as usize].id;
        self.nodes[key as usize].parent = NO_KEY;
        self.unparented_nodes += 1;
        self.newly_unparented.push((key, unlinked_id));
        if self.nodes[key as usize].states & crate::tailwind::state::FOCUS_WITHIN != 0 {
            // The focus left the views around it with it.
            self.focus_moved = true;
        }
        if self.nodes[parent as usize].child_perspective.is_some() {
            // Without the perspective wherever it goes next.
            self.mark(key, dirty::VIEW | dirty::ANIMATION);
        }
        self.spacing_changed(parent, NO_KEY);
        if self.pointer_none_classes > 0 && self.pointer_region(parent).is_some() {
            // It no longer inherits the region's `none`.
            self.pointer_pending.push(key);
            self.pointer_events_moved(parent);
        }
        self.groups_changed(key, parent);
        self.status_bars_moved |= !self.status_bar_nodes.is_empty();
        self.outer_moved |= !self.parent_lists.is_empty() && self.may_hold_page_list(key);
        self.sticky_changed |= !self.sticky_nodes.is_empty();
        if !self.pictured.is_empty() {
            self.unlinked_from.push(self.nodes[parent as usize].id);
        }
        let node = &self.nodes[key as usize];
        let (inline, layout, created, id) = (node.inline, node.layout, node.created, node.id);
        // Replaced by its row, of another size: the scroll views keep what
        // they show in place (`resize_anchor.rs`).
        self.resize_settling |= node.row_asked;
        if inline {
            self.mark_text_block(parent);
            return;
        }
        let kind = self.nodes[key as usize].kind;
        if kind == Kind::InputAccessory {
            self.accessory_attached(key, false);
        }
        if kind == Kind::HeaderItem {
            self.mark(parent, dirty::SCREEN);
        }
        if let Some(layout) = layout {
            if self.nodes[parent as usize].list.is_none()
                && !self.nodes[key as usize].is_layout_root()
            {
                let parent_layout = self.nodes[parent as usize]
                    .layout
                    .expect("block parent has layout");
                self.layout.remove_child(parent_layout, layout);
            }
            self.needs_layout = true;
            if emit_remove
                && created
                && self.nodes[parent as usize].created
                && !self.nodes[key as usize].is_overlay()
            {
                self.mount.push(MountItem::Remove { id });
                self.note_restructured(parent);
            }
        }
    }

    /// A page's or dialog's `statusBar`: changed in place while the node
    /// is in the tree (so it keeps its place among the others); its entry
    /// is added or removed by [`Core::sync_status_bars`].
    fn set_status_bar(&mut self, key: Key, setting: Option<crate::StatusBarSetting>) {
        let Some(root) = self.nodes[key as usize].root.as_mut() else {
            return;
        };
        root.status_bar = setting;
        let entry = root.status_bar_entry;
        match (setting, entry) {
            (Some(s), Some(e)) => self.components.status_bars.set(e, s),
            (Some(_), None) => {
                if !self.status_bar_nodes.contains(&key) {
                    self.status_bar_nodes.push(key);
                }
                self.status_bars_moved = true;
            }
            (None, entry) => {
                if let Some(e) = entry {
                    self.components.status_bars.remove(e);
                    if let Some(root) = self.nodes[key as usize].root.as_mut() {
                        root.status_bar_entry = None;
                    }
                }
                self.status_bar_nodes.retain(|&k| k != key);
            }
        }
    }

    /// The `statusBar` of each screen and modal in the tree has an entry,
    /// added in the order they got their setting; the others have none
    /// (once per commit, after the tree changed).
    fn sync_status_bars(&mut self) {
        if !std::mem::take(&mut self.status_bars_moved) {
            return;
        }
        for i in 0..self.status_bar_nodes.len() {
            let key = self.status_bar_nodes[i];
            let in_tree = self.is_ancestor(self.root, key);
            let Some(root) = self.nodes[key as usize].root.as_mut() else {
                continue;
            };
            match (in_tree, root.status_bar_entry, root.status_bar) {
                (true, None, Some(setting)) => {
                    root.status_bar_entry = Some(self.components.status_bars.add(setting));
                }
                (false, Some(entry), _) => {
                    root.status_bar_entry = None;
                    self.components.status_bars.remove(entry);
                }
                _ => {}
            }
        }
    }

    fn release(&mut self, id: NodeId) -> Result<(), ApplyError> {
        if let Some(run) = self.runs.remove(&id) {
            if run.block != NO_KEY {
                self.folded.remove(&run.block);
                self.mark_text_block(run.block);
            }
            return Ok(());
        }
        let key = self.key(id)?;
        // Its run is orphaned like its children.
        if let Some(run) = self.folded.remove(&key)
            && let Some(run) = self.runs.get_mut(&run)
        {
            run.block = NO_KEY;
        }
        self.cancel_web_evaluations(id);
        self.webview_released(id);
        if key == self.root {
            return Ok(());
        }
        // What the core made for its `tooltip` goes first, out of it.
        if !self.overlay_state.tooltips.is_empty() {
            self.tooltip_released(id);
        }
        // So does its built-in bar.
        if self.nodes[key as usize].bar().is_some() {
            self.release_scrollbar(key);
        }
        if self.nodes[key as usize].parent != NO_KEY {
            // Deleting the view also detaches it natively.
            self.unlink(key, false);
        }
        // Out of the view it was virtualized against, before its key is
        // free for another node.
        if self.nodes[key as usize]
            .list
            .as_ref()
            .is_some_and(|l| l.parent)
        {
            self.forget_outer(key);
            self.parent_lists.retain(|&k| k != key);
        }
        let node = self.nodes.remove(key as usize);
        self.unparented_nodes -= 1;
        self.ch_readers -= usize::from(node.reads_ch);
        self.slots.remove(id as usize);
        if node.class_props.as_ref().and_then(|c| c.pointer_events)
            == Some(crate::props::PointerEvents::None)
        {
            self.pointer_none_classes -= 1;
        }
        if node.kind == Kind::List {
            self.lists.retain(|&k| k != key);
        }
        if node.sticky.is_some() {
            self.sticky_nodes.retain(|&k| k != key);
            self.sticky_changed = true;
        }
        if node.follow.is_some() {
            self.release_follower(key);
        }
        if !self.relators.is_empty() {
            self.release_relator(key);
        }
        if let Some(scroll) = node.scroll.as_ref() {
            if !scroll.dependents.is_empty() {
                self.outer_released(&scroll.dependents);
            }
            if scroll.asked.is_some() {
                self.outer_asked.retain(|&k| k != key);
            }
            self.sticky_views.retain(|&k| k != key);
            self.sticky_scrollers.retain(|&k| k != key);
        }
        if node.list.as_ref().is_some_and(|l| l.source_rows.is_some())
            && let Some(pos) = self.source_providers.iter().position(|&k| k == key)
        {
            self.source_providers.swap_remove(pos);
        }
        if let Some((spacer, _)) = node.list.as_ref().and_then(|l| l.spacer) {
            self.layout.remove(spacer);
        }
        if node.kind == Kind::Text {
            self.attachment_blocks.retain(|&k| k != key);
            self.text_sources.remove(&key);
        }
        if node.is_layout_root() {
            self.roots.retain(|&k| k != key);
        }
        if let Some(state) = node.root.as_ref().and_then(|r| r.overlay.as_ref()) {
            self.overlay_released(key, state.wrapper);
        }
        if let Some(root) = node.root.as_ref()
            && root.status_bar.is_some()
        {
            if let Some(entry) = root.status_bar_entry {
                self.components.status_bars.remove(entry);
            }
            self.status_bar_nodes.retain(|&k| k != key);
        }
        self.orientation_pages.retain(|&(k, _)| k != key);
        // Children are released by their own ops (the whole subtree became
        // unreachable in JS); orphan them so they never point at a dead key.
        for &c in &node.children {
            if let Some(child) = self.nodes.get_mut(c as usize) {
                child.parent = NO_KEY;
                let child_id = child.id;
                self.unparented_nodes += 1;
                self.newly_unparented.push((c, child_id));
            }
        }
        if node.states & crate::tailwind::state::FOCUS_WITHIN != 0 {
            // The focus went with it, or is inside a child no longer in
            // it.
            self.focus_moved = true;
        }
        if let Some(layout) = node.layout {
            Self::remove_layout(&mut self.layout, &mut self.source_texts, key, layout);
        }
        if node.created || (node.inline && node.kind == Kind::Text) {
            // A virtual press target still has a native lifetime. Releasing
            // and recreating the same id in one batch must cancel its old
            // captured contact and focus before the replacement text mounts.
            self.mount.push(MountItem::Delete { id });
        }
        Ok(())
    }

    /// A page's `supportedOrientations` (0: none): changed in place, so it
    /// keeps its place among the others.
    fn set_page_orientations(&mut self, key: Key, bits: u8) {
        match self.orientation_pages.iter_mut().find(|(k, _)| *k == key) {
            Some(page) if bits != 0 => page.1 = bits,
            Some(_) => self.orientation_pages.retain(|&(k, _)| k != key),
            None if bits != 0 => self.orientation_pages.push((key, bits)),
            None => {}
        }
    }

    /// Sends the orientations of the page that decides them when they
    /// changed (once per commit): the last to get its setting of those in
    /// the tree and displayed, so a page kept in a tab that is not shown
    /// (`display: none`) does not decide while another tab is. Pages with a
    /// setting are few, and the walk is up their ancestors only.
    fn sync_orientations(&mut self) {
        if self.orientation_pages.is_empty() && self.orientations_shown == 0 {
            return;
        }
        let bits = self
            .orientation_pages
            .iter()
            .rev()
            .find(|&&(key, _)| self.displayed_in_tree(key))
            .map_or(0, |&(_, bits)| bits);
        if bits != self.orientations_shown {
            self.orientations_shown = bits;
            self.commands
                .push((crate::ROOT_ID, Command::Orientations(bits)));
        }
    }

    /// Whether `key` is in the tree with no `display: none` on it or on any
    /// view above it, across layout roots (a page under a hidden tab).
    fn displayed_in_tree(&self, mut key: Key) -> bool {
        while key != NO_KEY {
            if key == self.root {
                return true;
            }
            let node = &self.nodes[key as usize];
            if node.layout.is_some_and(|l| self.layout.displays_none(l)) {
                return false;
            }
            key = node.parent;
        }
        false
    }

    /// How many views are above `key` and `key` itself (1 for a view with
    /// no parent), or `None` when `ancestor` is one of them.
    fn depth_outside(&self, ancestor: Key, mut key: Key) -> Option<u32> {
        let mut depth = 0;
        while key != NO_KEY {
            if key == ancestor {
                return None;
            }
            depth += 1;
            key = self.nodes[key as usize].parent;
        }
        Some(depth)
    }

    /// Counts how many levels of views are under each view of `key`'s
    /// subtree, keeps each count as that view's [`Node::height`] and returns
    /// `key`'s. Every view of it, not only `key`: [`Self::raise_heights`] stops at the first
    /// view already as high as what came under it, so a view left higher
    /// than it is would keep the views above it from hearing of what grows
    /// under it later.
    fn count_heights(&mut self, key: Key) -> u32 {
        // Each view after its parent: from the end, its children are
        // counted before it.
        let mut order = vec![key];
        let mut next = 0;
        while let Some(&at) = order.get(next) {
            next += 1;
            order.extend_from_slice(&self.nodes[at as usize].children);
        }
        for &at in order.iter().rev() {
            let height = self.nodes[at as usize]
                .children
                .iter()
                .map(|&c| self.nodes[c as usize].height + 1)
                .max()
                .unwrap_or(0);
            self.nodes[at as usize].height = height;
        }
        self.nodes[key as usize].height
    }

    /// `key` came under its parent: the views above it are as high as it
    /// makes them. Stops at the first that was already: a view is always at
    /// least one higher than each of its children.
    fn raise_heights(&mut self, key: Key) {
        let mut height = self.nodes[key as usize].height + 1;
        let mut at = self.nodes[key as usize].parent;
        while at != NO_KEY {
            let node = &mut self.nodes[at as usize];
            if node.height >= height {
                break;
            }
            node.height = height;
            height += 1;
            at = node.parent;
        }
    }

    /// A popup that gives the keyboard focus back to `to` opens
    /// ([`crate::element::ElementRef::focus_back_origin`]): on macOS and
    /// iOS, opened by a pointer, the focus it opened with is where the focus goes back to
    /// (the pointer's press left it there, off the trigger); opened by the
    /// keyboard (or on another platform), the trigger takes it back, as
    /// before.
    pub(super) fn note_focus_origin(&mut self, to: NodeId) {
        let mut origins = std::mem::take(&mut self.focus_origins);
        // Triggers that are gone leave no note behind (a popup closed by a
        // press outside gives nothing back, so its note stays until then).
        origins.retain(|&(id, _)| id != to && self.key(id).is_ok());
        // Only where a press gives a control no focus (macOS and iOS, as
        // AppKit and UIKit do): elsewhere a press focuses the trigger, as
        // native buttons there do, and closing gives the trigger the focus.
        let apple = matches!(
            self.components.environment.os,
            crate::platform::Os::MacOs | crate::platform::Os::Ios
        );
        if apple && self.modality == Some(crate::platform::InputModality::Pointer) {
            origins.push((to, self.focus));
        }
        self.focus_origins = origins;
    }

    /// The keyboard focus back from the popup `from` (its node, when it is
    /// still there) to `before`, the focus a pointer opened it with: there
    /// when that view is still in the tree and outside the popup, else off
    /// the popup, so its keys go to the app's shortcuts as they did before
    /// it opened.
    fn focus_back_to_origin(&mut self, before: Option<(Key, NodeId)>, from: Option<Key>) {
        let outside = |this: &Self, key: Key| from.is_none_or(|from| !this.is_ancestor(from, key));
        let alive = |this: &Self, (key, id): (Key, NodeId)| {
            this.key(id).is_ok_and(|k| k == key) && this.is_ancestor(this.root, key)
        };
        if let Some((_, id)) = before.filter(|&b| alive(self, b) && outside(self, b.0)) {
            self.commands.push((id, Command::Focus));
        } else if let Some((_, id)) = self.focus.filter(|&(key, _)| !outside(self, key)) {
            self.commands.push((id, Command::Blur));
        }
    }

    fn is_ancestor(&self, ancestor: Key, mut key: Key) -> bool {
        while key != NO_KEY {
            if key == ancestor {
                return true;
            }
            key = self.nodes[key as usize].parent;
        }
        false
    }

    /// The native sibling `child` goes below: native views are stacked by
    /// `zIndex`, then in tree order.
    fn native_before(&self, parent: Key, child: Key) -> Option<NodeId> {
        let pos = self.nodes[parent as usize]
            .children
            .iter()
            .inspect(|_| self.placing(1))
            .position(|&c| c == child)?;
        self.native_before_at(parent, child, pos)
    }

    /// [`Self::native_before`] for `child` at `pos` among its siblings.
    /// When none of them was ever stacked apart, the next made sibling.
    ///
    /// A view in its parent never goes below a sibling the platform places
    /// elsewhere (a screen, a modal, a header item, an input accessory):
    /// that sibling is not among the parent's native subviews, so the
    /// platform would add the view on top of the others instead.
    fn native_before_at(&self, parent: Key, child: Key, pos: usize) -> Option<NodeId> {
        let children = &self.nodes[parent as usize].children;
        let z = self.nodes[child as usize].stack_rank();
        let in_parent = !self.nodes[child as usize].kind.is_root();
        let anchors = |n: &Node| {
            n.created && n.layout.is_some() && !n.is_overlay() && !(in_parent && n.kind.is_root())
        };
        if !self.nodes[parent as usize].ranked_children && z == (0, false) {
            let next = children[pos + 1..].iter().find_map(|&c| {
                self.placing(1);
                let n = &self.nodes[c as usize];
                anchors(n).then_some(n.id)
            });
            return match next {
                Some(id) => Some(id),
                None if !self.overlays.is_empty() => self.first_overlay_in(parent),
                None => None,
            };
        }
        self.placing(children.len());
        let mut best: Option<((i32, bool), usize, NodeId)> = None;
        for (i, &c) in children.iter().enumerate() {
            let n = &self.nodes[c as usize];
            if c == child || !anchors(n) {
                continue;
            }
            let rank = n.stack_rank();
            if (rank, i) > (z, pos) && best.is_none_or(|b| (rank, i) < (b.0, b.1)) {
                best = Some((rank, i, n.id));
            }
        }
        // Below the overlays shown in it, when it is a root view.
        match best {
            Some(b) => Some(b.2),
            None if !self.overlays.is_empty() => self.first_overlay_in(parent),
            None => None,
        }
    }

    /// Notes on `key`'s parent that `key` is stacked apart from the
    /// others, when it is ([`Node::ranked_children`]).
    fn rank_noted(&mut self, key: Key) {
        let node = &self.nodes[key as usize];
        let parent = node.parent;
        if parent != NO_KEY && node.stack_rank() != (0, false) {
            self.nodes[parent as usize].ranked_children = true;
        }
    }

    /// `key`'s `zIndex` changed: moves its native view among its siblings.
    fn restack(&mut self, key: Key) {
        self.rank_noted(key);
        let node = &self.nodes[key as usize];
        let (parent, id) = (node.parent, node.id);
        if parent == NO_KEY
            || !node.created
            || node.layout.is_none()
            || node.inline
            || node.is_overlay()
        {
            return;
        }
        let p = &self.nodes[parent as usize];
        if !p.created || p.list.is_some() {
            return;
        }
        let before = self.native_before(parent, key);
        self.mount.push(MountItem::Insert {
            parent: p.id,
            child: id,
            before,
        });
    }

    /// `allowFontScaling` / `maxFontSizeMultiplier` changed on `key`.
    fn font_settings_changed(&mut self, key: Key) {
        match self.nodes[key as usize].kind {
            Kind::Text => self.mark_text_block(key),
            Kind::Input => {
                self.measure_input(key);
                self.mark(key, dirty::INPUT);
            }
            _ => {}
        }
    }

    /// Where the child at `pos` among `parent`'s children goes among the
    /// children of `parent`'s layout node: before the layout node of the
    /// next sibling that has one (the layout node's children are those
    /// siblings', in order), or after them all. Looks at the siblings next
    /// to it and at the layout children near `pos`, not at every sibling
    /// before it: views inserted before the one after a list's rows, or
    /// before the first of a chat's messages, look at a few of them each.
    fn layout_index_at(&self, parent: Key, pos: usize) -> u32 {
        let node = &self.nodes[parent as usize];
        let layout = node.layout.expect("block parent has layout");
        let next = node.children[pos + 1..]
            .iter()
            .inspect(|_| self.placing(1))
            .find_map(|&c| {
                let c = &self.nodes[c as usize];
                c.layout.filter(|_| !c.is_layout_root())
            });
        let index = match next {
            // As many layout children are before it as siblings with one
            // are: at most `pos`, fewer by those without one.
            Some(next) => match position_near(self.layout.children(layout), &next, pos) {
                Some((index, looked)) => {
                    self.placing(looked);
                    index
                }
                None => {
                    debug_assert!(false, "a sibling's layout node is its parent's child");
                    self.render_index(parent, pos) as usize
                }
            },
            None => self.layout.children_len(layout),
        };
        debug_assert!(
            pos + 1 != node.children.len() || index as u32 == self.rendering_before(parent, pos),
            "the layout node's children are its rendering children"
        );
        index as u32
    }

    /// The rendering siblings before `pos` among `parent`'s children,
    /// counted: what [`Self::layout_index_at`] finds without counting them.
    /// Looks at each of them ([`Components::placing_work`]).
    fn render_index(&self, parent: Key, pos: usize) -> u32 {
        self.placing(pos);
        self.rendering_before(parent, pos)
    }

    /// [`Self::render_index`] uncounted, for the check of debug builds.
    fn rendering_before(&self, parent: Key, pos: usize) -> u32 {
        self.nodes[parent as usize].children[..pos]
            .iter()
            .map(|&c| &self.nodes[c as usize])
            .filter(|c| c.layout.is_some() && !c.is_layout_root())
            .count() as u32
    }

    /// Moves `key` (and its subtree) into or out of an inline context.
    fn set_inline(&mut self, key: Key, inline: bool) {
        let node = &mut self.nodes[key as usize];
        if node.inline == inline {
            return;
        }
        node.inline = inline;
        if node.kind != Kind::Text {
            // Other elements inside text are not supported; they are ignored.
            return;
        }
        if inline {
            // Block -> span: spans have no layout node or native view; the
            // span keeps the style for when it is a block again.
            if let Some(l) = node.layout.take() {
                if node.base_layout.is_none() {
                    node.base_layout = Some(Box::new(self.layout.style(l).clone()));
                }
                Self::remove_layout(&mut self.layout, &mut self.source_texts, key, l);
            }
            if node.created {
                node.created = false;
                self.mount.push(MountItem::Delete { id: node.id });
            }
        } else {
            // A fixed text keeps its style: the layout node takes it with
            // the position it is fixed at ([`Self::sync_layout_style`]).
            let style = if node.fixed_view {
                node.base_layout.as_deref().cloned()
            } else {
                node.base_layout.take().map(|b| *b)
            }
            .unwrap_or_default();
            let cx = LeafContext::Text(TextContext::new(Arc::default()));
            let layout = self.layout.new_leaf_with_context(style, cx);
            self.layout.set_tag(layout, key);
            node.layout = Some(layout);
            self.mark(key, dirty::TEXT_BUILD);
        }
    }

    /// Creates the native views of `key`'s subtree if needed, wiring up the
    /// children in order.
    fn ensure_created(&mut self, key: Key) {
        let has_attachments = self.attachment_blocks.contains(&key);
        let node = &mut self.nodes[key as usize];
        if node.created || node.layout.is_none() {
            return;
        }
        node.created = true;
        self.pace.made += 1;
        // The frame it was given while culled, its view's first.
        let culled_frame = std::mem::take(&mut node.culled)
            .then_some(node.frame)
            .filter(|f| !f.origin.x.0.is_nan());
        self.tree_order_changed |= self.track_tree_order;
        self.tab_places_stale = true;
        if node.kind == Kind::Text {
            self.measure_for_real(key);
        }
        // A follower made after layout (it waited, culled or paced) took the
        // frame layout gave it, and no walk of `emit_frames_in` told
        // `laid_follower` of it, so `place_follower` has nothing to place:
        // lay it out again, which does.
        if culled_frame.is_some()
            && self.nodes[key as usize].follow.is_some()
            && let Some(layout) = self.nodes[key as usize].layout
        {
            self.layout.mark_dirty(layout);
            self.needs_layout = true;
        }
        let node = &mut self.nodes[key as usize];
        if let Some(scroll) = node.scroll.as_mut() {
            scroll.content = None;
            // Sticky ranges computed while culled have not reached a
            // native view yet. Send them once this view is made.
            if !scroll.view_sticky.is_empty() {
                self.sticky_views.push(key);
            }
            // The new native view counts the core's scrolls from zero.
            scroll.issued = 0;
            scroll.target = None;
            scroll.pending.clear();
        }
        // A list in its parent's viewport is a plain view clipping its
        // cells.
        let parent_list = node.list.as_ref().is_some_and(|l| l.parent);
        let id = node.id;
        let kind = node.kind;
        let mut flags = self.mount_state(key);
        let node = &mut self.nodes[key as usize];
        if kind == Kind::Text && has_attachments {
            // Its attachments' views go inside the new view.
            node.attached.clear();
            flags |= dirty::TEXT_BUILD;
        }
        self.mount.push(MountItem::Create {
            id,
            kind: if parent_list {
                ViewKind::View
            } else {
                kind.view_kind()
            },
        });
        if let Some(component) = self.nodes[key as usize].component.as_mut() {
            // Unnamed, it is named later in this commit (`set_prop`), or
            // never: the flush of its props says which.
            if let Some(name) = &component.name {
                self.mount.push(MountItem::Component {
                    id,
                    name: name.clone(),
                });
            }
        }
        if let Some(item) = self.creation_tracking(key) {
            self.mount.push(item);
        }
        if let Some(frame) = culled_frame {
            self.nodes[key as usize].frame = frame;
            self.mount.push(MountItem::Frame { id, frame });
            // And its content size, before any scroll it is made for: the
            // platform clamps a scroll to the content it knows.
            let content = self.nodes[key as usize]
                .scroll
                .as_mut()
                .and_then(|s| s.culled_content.take());
            if let Some(size) = content {
                self.set_scroll_content(key, size);
            }
            if kind == Kind::Canvas
                && self.nodes[key as usize]
                    .drawing
                    .as_ref()
                    .is_some_and(|d| d.fit().is_some())
            {
                self.fitted_pending.push(key);
            }
            // Beside its frame, an input takes its content box from the
            // layout and a scroll view its extent; made after it was laid
            // out, nothing lays it out again to send them.
            if matches!(kind, Kind::Input | Kind::Scroll) {
                self.emit_frames(key);
            }
        }
        let projected = self.nodes[key as usize].projected;
        if self.mount_projected && projected != 0 {
            self.mount.push(MountItem::ProjectStates {
                id,
                states: projected,
            });
        }
        self.mark(key, flags);
        if !kind.is_container() {
            return;
        }
        // Bottom to top: by `zIndex`, then in order.
        let mut children = std::mem::take(&mut self.nodes[key as usize].children);
        let original = children.clone();
        if children
            .iter()
            .any(|&c| self.nodes[c as usize].stack_rank() != (0, false))
        {
            children.sort_by_key(|&c| self.nodes[c as usize].stack_rank());
        }
        // Children far down a scroll view's content wait (`cull.rs`).
        let scope = self.cull_scope(key);
        for &child in &children {
            let c = &self.nodes[child as usize];
            if c.layout.is_some() && !c.is_overlay() && !self.hold_back(scope, child) {
                self.ensure_created(child);
                let child_id = self.nodes[child as usize].id;
                self.mount.push(MountItem::Insert {
                    parent: id,
                    child: child_id,
                    before: None,
                });
            }
        }
        self.nodes[key as usize].children = original;
    }

    /// Resets what `key`'s native view was last sent and returns what a new
    /// view needs: a new view has the default style and no listeners.
    fn mount_state(&mut self, key: Key) -> u32 {
        let node = &mut self.nodes[key as usize];
        let kind = node.kind;
        node.frame = Bounds::UNSET;
        node.emitted = None;
        let mut hidden_in_layout = false;
        if let Some(layout) = node.layout {
            self.layout.mark_stale(layout);
            hidden_in_layout = self.layout.displays_none(layout);
        }
        let node = &mut self.nodes[key as usize];
        // A list in its parent's viewport is a plain view clipping its
        // cells (`Node::mounted_view_style`), with no scroll view's config.
        let parent_list = node.list.as_ref().is_some_and(|l| l.parent);
        let mut flags = 0;
        if node.view_style != ViewStyle::default()
            || hidden_in_layout
            || node.elevation != Points::ZERO
            || node.backdrop_material != crate::BackdropMaterial::default()
            || node.macos_backdrop.is_some()
            || node.windows_backdrop.is_some()
            || parent_list
            || node.spare
            || node.hidden_in_text
        {
            flags |= dirty::VIEW;
        }
        if !node.events.is_empty() {
            flags |= dirty::EVENTS;
        }
        if kind == Kind::Text {
            flags |= dirty::TEXT_MOUNT;
        }
        if node.image.as_ref().is_some_and(|i| i.source.is_some()) {
            flags |= dirty::IMAGE;
        }
        if let Some(scroll) = &node.scroll
            && !parent_list
        {
            flags |= dirty::SCROLL;
            if scroll.behavior != ScrollBehavior::default() {
                flags |= dirty::SCROLL_BEHAVIOR;
            }
            if scroll.refreshing {
                flags |= dirty::REFRESHING;
            }
        }
        if !node.animated.is_empty()
            || node.drawing.as_ref().is_some_and(|d| !d.slots.is_empty())
            || node.component.as_ref().is_some_and(|c| !c.slots.is_empty())
            || node
                .shader
                .as_ref()
                .and_then(|s| s.layer.as_ref())
                .is_some_and(|l| !l.nodes.is_empty())
        {
            flags |= dirty::ANIMATION;
        }
        if node.drawing.is_some() {
            flags |= dirty::CANVAS;
        }
        if node.shader.as_ref().is_some_and(|s| s.layer.is_some()) {
            flags |= dirty::SHADER;
        }
        if !node.gestures.is_empty() {
            flags |= dirty::PAN;
        }
        // What its classes and styles say of `pointer-events` was worked out
        // before the view was there to hear it.
        if node.props.is_some()
            || node.class_pointer != crate::props::PointerEvents::Auto
            || node.spare
            || node.hidden_in_text
            || node.list.as_ref().is_some_and(|l| l.parent)
        {
            flags |= dirty::VIEW_PROPS;
        }
        match kind {
            Kind::Screen => flags |= dirty::SCREEN,
            Kind::Modal => flags |= dirty::MODAL,
            _ => {}
        }
        if node.control.is_some() {
            flags |= dirty::NATIVE;
        }
        if let Some(list) = node.list.as_mut() {
            list.dirty = true;
        }
        if let Some(input) = node.input.as_mut() {
            input.content = None;
            flags |= dirty::INPUT;
            if !input.value.is_empty() {
                flags |= dirty::INPUT_VALUE;
            }
        }
        if let Some(component) = node.component.as_mut() {
            // The new component gets every property, and its slots' names.
            component.changed = component.props.iter().map(|(k, _)| k.clone()).collect();
            component.slots_changed.set(!component.slots.is_empty());
            flags |= dirty::COMPONENT;
        }
        flags
    }

    #[inline]
    fn mark(&mut self, key: Key, flags: u32) {
        let node = &mut self.nodes[key as usize];
        node.dirty |= flags;
        // A culled view given a transform or an animated value may show
        // away from its frame now, and so may what a view with one holds
        // (`cull.rs`).
        if flags & (dirty::VIEW | dirty::ANIMATION) != 0
            && (node.culled
                || !self.culling.is_empty()
                    && (!node.animated.is_empty() || !node.view_style.transform.ops().is_empty()))
        {
            self.cull_dirty = true;
        }
        if !node.queued {
            node.queued = true;
            self.queue.push(key);
        }
    }

    /// Marks the text block containing `key` (or `key` itself) for rebuild.
    fn mark_text_block(&mut self, mut key: Key) {
        loop {
            let node = &self.nodes[key as usize];
            if !node.inline {
                if node.kind == Kind::Text {
                    self.mark(key, dirty::TEXT_BUILD);
                }
                return;
            }
            if node.parent == NO_KEY {
                // A detached span: rebuilt when it is inserted into a block.
                return;
            }
            key = node.parent;
        }
    }

    fn flush_dirty(&mut self) {
        loop {
            self.flush_dirty_once();
            // Text blocks create the views of new attachments while
            // flushing, which queues them; texts inside attachments built
            // after their block resize them, which builds the block again.
            self.check_attachments();
            if self.queue.is_empty() {
                break;
            }
        }
    }

    fn flush_dirty_once(&mut self) {
        let mut queue = std::mem::take(&mut self.queue);
        for &key in &queue {
            let Some(node) = self.nodes.get_mut(key as usize) else {
                continue;
            };
            let mut flags = std::mem::take(&mut node.dirty);
            node.queued = false;
            if flags & dirty::TEXT_BUILD != 0 && node.layout.is_some() {
                if self.rebuild_text(key) {
                    flags |= dirty::TEXT_MOUNT;
                }
                // Whether it shows characters (`terminal_layout::Role`).
                self.sync_grid_role(key);
            }
            let node = &self.nodes[key as usize];
            if !node.created {
                continue;
            }
            let id = node.id;
            if flags & dirty::VIEW != 0 {
                let style = self.mounted_view_style(key);
                self.mount.push(MountItem::ViewStyle { id, style });
            }
            if flags & dirty::EVENTS != 0 {
                self.mount.push(MountItem::Events {
                    id,
                    events: node.mounted_events(),
                });
            }
            if flags & dirty::IMAGE != 0
                && let Some(image) = &node.image
            {
                // The style's `objectFit`; an image covers its box by
                // default.
                let resize_mode = node.object_fit.unwrap_or_default();
                // Bundled assets with variants: the one for the screen.
                let ratio = self.components.environment.pixel_ratio;
                self.mount.push(MountItem::Image {
                    id,
                    source: image.source.as_ref().map(|s| s.resolved(ratio)),
                    resize_mode,
                    options: crate::mount::ImageOptions {
                        placeholder: image
                            .options
                            .placeholder
                            .as_ref()
                            .map(|s| s.resolved(ratio)),
                        blur_radius: image.options.blur_radius,
                        fade_ms: image.options.fade_ms,
                        retain_previous: image.options.retain_previous,
                        position: node.view_style.object_position,
                        current_color: image.svg_current_color.then(|| self.resolved_paint(key).1),
                    },
                });
            }
            if let Some(scroll) = &node.scroll
                && node.list.as_ref().is_none_or(|l| !l.parent)
            {
                if flags & dirty::SCROLL != 0 {
                    self.mount.push(MountItem::ScrollConfig {
                        id,
                        horizontal: scroll.horizontal,
                        // A built-in bar takes the indicator's place.
                        scrollbar_visible: scroll.scrollbar != crate::ScrollbarSetting::Hidden
                            && scroll.bar.is_none(),
                        replaced: scroll.bar.is_some(),
                        scroll_value: scroll.scroll_value,
                        pull_value: scroll.pull_value,
                        keyboard_dismiss: scroll.keyboard_dismiss,
                        mirrored: node.kind == Kind::List && scroll.horizontal && node.rtl,
                    });
                }
                if flags & dirty::SCROLL_BEHAVIOR != 0 {
                    self.mount.push(MountItem::ScrollBehavior {
                        id,
                        behavior: Box::new(scroll.behavior.clone()),
                    });
                }
                if flags & dirty::REFRESHING != 0 {
                    self.mount.push(MountItem::Refreshing {
                        id,
                        refreshing: scroll.refreshing,
                    });
                }
            }
            if flags & dirty::ANIMATION != 0 {
                let mut bindings = node.animated.clone();
                // A sticky view's animated inset is its scroll view's
                // (`sticky.rs`); other views' insets do not animate.
                if bindings
                    .iter()
                    .any(|(p, _)| matches!(p, AnimationProp::StickyTop | AnimationProp::StickyLeft))
                {
                    if node.sticky.is_none() && !self.inset_warned {
                        self.inset_warned = true;
                        log::warn!(
                            target: "js",
                            "an animated `top` / `left` only moves a `position: sticky` view's sticking point; it is ignored on view {id}"
                        );
                    }
                    bindings.retain(|(p, _)| {
                        !matches!(p, AnimationProp::StickyTop | AnimationProp::StickyLeft)
                    });
                }
                // Its transform's steps come after its parent's perspective.
                let steps = self.perspective_steps(key);
                if steps > 0 {
                    for (prop, _) in &mut bindings {
                        if let AnimationProp::Transform(i) = prop {
                            *i += steps;
                        }
                    }
                }
                if let Some(d) = &node.drawing {
                    bindings.extend(
                        d.slots
                            .iter()
                            .enumerate()
                            .map(|(i, &n)| (AnimationProp::CanvasArg(i as u16), n)),
                    );
                }
                if let Some(layer) = node.shader.as_ref().and_then(|s| s.layer.as_ref()) {
                    bindings.extend(
                        layer
                            .nodes
                            .iter()
                            .enumerate()
                            .map(|(i, &n)| (AnimationProp::CanvasArg(i as u16), n)),
                    );
                }
                if let Some(component) = &node.component {
                    bindings.extend(
                        component
                            .bound
                            .iter()
                            .map(|&(s, n)| (AnimationProp::ComponentSlot(s), n)),
                    );
                }
                if let Some(component) = &node.component
                    && component.slots_changed.replace(false)
                {
                    self.mount.push(MountItem::ComponentPropSlots {
                        id,
                        names: component.slots.clone(),
                    });
                }
                self.mount
                    .push(MountItem::AnimationBindings { id, bindings });
            }
            if flags & dirty::CANVAS != 0
                && let Some(drawing) = &node.drawing
            {
                if drawing.fit().is_some() {
                    // Its size comes with this round's layout.
                    self.fitted_pending.push(key);
                } else {
                    let drawing = self.mounted_drawing(key, drawing);
                    self.mount.push(MountItem::Canvas { id, drawing });
                }
            }
            if flags & dirty::SHADER != 0
                && let Some(shader) = &node.shader
            {
                self.mount.push(MountItem::Shader {
                    id,
                    layer: shader.layer.clone(),
                });
            }
            if flags & dirty::PAN != 0 {
                let mut values = node.gestures;
                if !node.pan_enabled {
                    values.pan_x = None;
                    values.pan_y = None;
                }
                self.mount.push(MountItem::Gestures { id, values });
            }
            if flags & dirty::VIEW_PROPS != 0 {
                self.mount.push(MountItem::ViewProps {
                    id,
                    props: node.mounted_props(),
                });
            } else if flags & dirty::LABEL != 0 {
                let label = node
                    .props
                    .as_ref()
                    .and_then(|p| p.accessibility.label.clone());
                self.mount.push(MountItem::AccessibilityLabel { id, label });
            }
            if flags & dirty::SCREEN != 0
                && let Some(config) = self.screen_config(key)
            {
                self.mount.push(MountItem::ScreenConfig {
                    id,
                    config: Box::new(config),
                });
            }
            if flags & dirty::COMPONENT != 0
                && let Some(component) = self.nodes[key as usize].component.as_ref()
                && component.name.is_none()
            {
                log::warn!(target: "js", "a <native> element without `component`");
            }
            if flags & dirty::COMPONENT != 0
                && let Some(component) = self.nodes[key as usize].component.as_mut()
                && !component.changed.is_empty()
            {
                let changed = std::mem::take(&mut component.changed);
                let props: Vec<_> = changed
                    .into_iter()
                    // A bound prop's value waits until it is unbound.
                    .filter(|name| !component.is_bound(name))
                    .map(|name| {
                        let value = component
                            .props
                            .iter()
                            .find(|(k, _)| *k == name)
                            .map(|(_, v)| v.clone());
                        (name, value)
                    })
                    .collect();
                if !props.is_empty() {
                    self.mount.push(MountItem::ComponentProps { id, props });
                }
            }
            let node = &self.nodes[key as usize];
            if flags & dirty::NATIVE != 0
                && let Some(control) = &node.control
            {
                self.mount.push(MountItem::NativeProps {
                    id,
                    props: (**control).clone(),
                });
            }
            if flags & dirty::MODAL != 0
                && let Some(root) = &node.root
            {
                let mut config = root.modal.clone();
                config.window = self.window_of(key);
                // A platform presents a dialog when it is inserted, over the
                // window its config names: a dialog inserted in this batch
                // (one that mounts in a window of the app's own already
                // open) gets its config ahead of its insertion.
                let item = MountItem::ModalConfig { id, config };
                match self
                    .mount
                    .iter()
                    .position(|m| matches!(m, MountItem::Insert { child, .. } if *child == id))
                {
                    Some(at) => self.mount.insert(at, item),
                    None => self.mount.push(item),
                }
            }
            if flags & dirty::NAV_SHADER != 0
                && let Some(root) = &node.root
            {
                let shader = root.nav_shader.clone();
                self.mount.push(MountItem::NavShader { id, shader });
            }
            if let Some(input) = &node.input {
                if flags & dirty::INPUT != 0 {
                    let mut config = input.config.clone();
                    config.accessory = config
                        .accessory_id
                        .as_deref()
                        .and_then(|name| self.accessories.get(name).copied());
                    // An explicit prop (Rust), then the style key, then
                    // the classes (`placeholder:text-*`, `caret-*`,
                    // `selection:bg-*`).
                    config.placeholder_color = config
                        .placeholder_color
                        .or(node.text_style.placeholder_color);
                    config.selection_color =
                        config.selection_color.or(node.text_style.selection_color);
                    let class = node.class_props.as_deref();
                    if let Some(c) = class {
                        config.placeholder_color = config.placeholder_color.or(c.placeholder_color);
                    }
                    config.selection_color =
                        config.selection_color.or(self.inherited_text_props(key).2);
                    config.caret_color = config
                        .caret_color
                        .or(node.text_style.caret_color)
                        .or(class.and_then(|c| c.caret_color));
                    config.style = scaled(
                        self.inherited_text_style(key).inherit(&node.text_style),
                        node.paragraph.font_multiplier(self.font_scale),
                    );
                    config.align = directed_align(
                        node.text_style.text_align.unwrap_or_default(),
                        node.rtl && !node.text_style.text_align_physical,
                    );
                    config.rtl = node.text_style.writing_direction.unwrap_or(node.rtl);
                    // A built-in bar takes the indicator's place.
                    config.scrollbar_visible =
                        input.scrollbar != crate::ScrollbarSetting::Hidden && input.bar.is_none();
                    config.report_scroll = input.bar.is_some() || input.watched;
                    self.mount.push(MountItem::Input {
                        id,
                        config: Box::new(config),
                    });
                }
                if flags & dirty::INPUT_VALUE != 0 {
                    self.mount.push(MountItem::InputValue {
                        id,
                        text: input.value.clone(),
                        count: input.count,
                    });
                }
            }
            if flags & dirty::TEXT_MOUNT != 0 {
                self.queue_text(key);
            }
        }
        queue.clear();
        // Keep the allocation (unless flushing queued more).
        if self.queue.is_empty() {
            self.queue = queue;
        }
    }

    /// `onContentSizeChange` of input `key` if the size of its value (at the
    /// content box's width when multiline) changed. An empty input reports
    /// an empty line, as React Native does, though it is measured (sized)
    /// with its placeholder.
    fn report_content_size(&mut self, key: Key, width: f32) {
        let node = &self.nodes[key as usize];
        let (Some(input), Some(layout)) = (node.input.as_ref(), node.layout) else {
            return;
        };
        let max = input.config.multiline.then_some(width);
        let (placeholder, empty_line) = (input.placeholder_measured, input.empty_line);
        let Some(LeafContext::Text(cx)) = self.layout.get_node_context_mut(layout) else {
            return;
        };
        let size = if !placeholder {
            measure_text(&self.text_engine, &mut self.measure_cache, cx, max)
        } else if let Some((hash, size)) = empty_line
            && hash == cx.layout_hash
        {
            size
        } else {
            // Measured once per placeholder and style.
            let hash = cx.layout_hash;
            let mut empty = TextContext::new(Arc::new(self.input_text(key, "")));
            let size = measure_text(&self.text_engine, &mut self.measure_cache, &mut empty, max);
            let input = self.nodes[key as usize]
                .input
                .as_mut()
                .expect("input state");
            input.empty_line = Some((hash, size));
            size
        };
        let node = &mut self.nodes[key as usize];
        let input = node.input.as_mut().expect("input state");
        if input.content_size == Some(size) {
            return;
        }
        input.content_size = Some(size);
        let id = node.id;
        self.events.push(crate::element::JsEvent::Event(
            id,
            EventKind::ContentSizeChange,
            EventPayload::Map(vec![
                ("width", PayloadValue::Number(size.width.0 as f64)),
                ("height", PayloadValue::Number(size.height.0 as f64)),
            ]),
        ));
    }

    fn text_cx(&mut self, layout: LayoutId) -> &mut TextContext<M::Prepared> {
        match self.layout.get_node_context_mut(layout) {
            Some(LeafContext::Text(cx)) => cx,
            _ => unreachable!("text block without text context"),
        }
    }

    /// The text style `key` inherits from the views around it, as CSS
    /// does: `color` / `text-white` on a container styles the text in it
    /// (React Native views ignore text styles).
    /// The style text inherits at the root: React Native's defaults with
    /// the app's font.
    fn base_text_style(&self) -> ResolvedTextStyle {
        ResolvedTextStyle {
            font_family: self.default_font,
            ..ResolvedTextStyle::default()
        }
    }

    /// A native component's `accentColor` style, passed to it as its
    /// `accentColor` prop (`#RRGGBBAA`; removed when unset): the system
    /// control shows its state in it, over the color its props give.
    fn sync_accent(&mut self, key: Key) {
        let node = &mut self.nodes[key as usize];
        let accent = node.view_style.accent_color;
        let Some(component) = node.component.as_mut() else {
            return;
        };
        let value = accent.map(|Color(c)| crate::JsonValue::from(format!("#{c:08X}")));
        let at = component
            .props
            .iter()
            .position(|(k, _)| &**k == ACCENT_PROP);
        if at.map(|i| &component.props[i].1) == value.as_ref() {
            return;
        }
        let name: Arc<str> = Arc::from(ACCENT_PROP);
        match (at, value) {
            (Some(i), Some(v)) => component.props[i].1 = v,
            (None, Some(v)) => component.props.push((name.clone(), v)),
            (Some(i), None) => {
                component.props.swap_remove(i);
            }
            (None, None) => return,
        }
        if !component.changed.contains(&name) {
            component.changed.push(name);
        }
        self.mark(key, dirty::COMPONENT);
    }

    /// Texts and spans around `key` (it is inside an attachment) pass on
    /// their color only, as `currentColor` reaches the attachment's view:
    /// the attachment takes the color of the text it sits in, while its
    /// font and line height stay its own, which size the box its line
    /// makes room for.
    fn inherited_text_style(&self, key: Key) -> ResolvedTextStyle {
        let mut chain: Vec<Key> = Vec::new();
        let mut k = self.nodes[key as usize].parent;
        while k != NO_KEY {
            let node = &self.nodes[k as usize];
            let passes = if node.kind == Kind::Text {
                node.text_style.color.is_some()
            } else {
                node.text_style != TextStyle::default()
            };
            if passes {
                chain.push(k);
            }
            k = node.parent;
        }
        chain
            .iter()
            .rev()
            .fold(self.base_text_style(), |style, &k| {
                let node = &self.nodes[k as usize];
                if node.kind == Kind::Text {
                    ResolvedTextStyle {
                        color: node.text_style.color.unwrap_or(style.color),
                        ..style
                    }
                } else {
                    style.inherit(&node.text_style)
                }
            })
    }

    /// What the classes of `key`, else of the nearest view around it that
    /// says, set for its lines' wrapping, its selection and the
    /// selection's highlight: `whitespace-*` and `select-*` inherit, as
    /// CSS's `white-space` and `user-select: auto` do, and `selection:bg-*`
    /// reaches the texts inside (Tailwind's `& *::selection`), as a view's
    /// own color does (Rust's `Element::selection_color`, over its
    /// classes'). One walk up.
    fn inherited_text_props(&self, key: Key) -> (Option<bool>, Option<bool>, Option<Color>) {
        let (no_wrap, selectable, highlight, _) = self.inherited_text_wrap(key);
        (no_wrap, selectable, highlight)
    }

    /// [`Core::inherited_text_props`] and whether its lines wrap
    /// `text-pretty`, which inherits with `white-space` (the same classes
    /// set both).
    fn inherited_text_wrap(&self, key: Key) -> (Option<bool>, Option<bool>, Option<Color>, bool) {
        let (mut no_wrap, mut selectable, mut highlight) = (None, None, None);
        let mut pretty = None;
        let mut k = key;
        while k != NO_KEY && (no_wrap.is_none() || selectable.is_none() || highlight.is_none()) {
            let node = &self.nodes[k as usize];
            if !matches!(node.kind, Kind::Text | Kind::Input) {
                highlight = highlight.or(node.paragraph.selection_color);
            }
            if let Some(c) = node.class_props.as_deref() {
                if no_wrap.is_none() && c.no_wrap.is_some() {
                    pretty = Some(c.pretty);
                }
                no_wrap = no_wrap.or(c.no_wrap);
                selectable = selectable.or(c.selectable);
                highlight = highlight.or(c.selection_color);
            }
            k = node.parent;
        }
        (no_wrap, selectable, highlight, pretty.unwrap_or(false))
    }

    /// The nearest `textAlign` set on a view around `key`.
    fn inherited_text_align(&self, key: Key) -> Option<(TextAlign, bool)> {
        let mut k = self.nodes[key as usize].parent;
        while k != NO_KEY {
            let node = &self.nodes[k as usize];
            if let Some(a) = node.text_style.text_align {
                return Some((a, node.text_style.text_align_physical));
            }
            k = node.parent;
        }
        None
    }

    /// Text blocks and inputs inside `key` inherit its new text style.
    fn mark_inheriting_text(&mut self, key: Key) {
        self.ch_changed(key);
        let mut stack: Vec<Key> = self.nodes[key as usize].children.clone();
        while let Some(k) = stack.pop() {
            match self.nodes[k as usize].kind {
                // The texts inside its attachments inherit too.
                Kind::Text => {
                    if !self.nodes[k as usize].inline {
                        self.mark_text_block(k);
                    }
                    stack.extend_from_slice(&self.nodes[k as usize].children);
                }
                Kind::Input => {
                    self.measure_input(k);
                    self.mark(k, dirty::INPUT);
                }
                Kind::RawText => {}
                _ => stack.extend_from_slice(&self.nodes[k as usize].children),
            }
        }
    }

    /// Rebuilds the attributed text of a block. Returns true if it changed.
    ///
    /// Only layout-relevant changes invalidate measurement and layout; a
    /// color change keeps both and just needs a new final layout.
    fn rebuild_text(&mut self, key: Key) -> bool {
        // Far down a scroll view's content, with no view yet: estimated
        // until it comes near (`cull.rs`).
        let deferred = !self.nodes[key as usize].created && self.cull_scope(key).is_some();
        let node = &self.nodes[key as usize];
        // Its own style's and classes' (`numberOfLines`, `textOverflow`).
        let class = node.class_props.as_deref();
        let max_lines = class.and_then(|c| c.number_of_lines).unwrap_or(0);
        let ellipsize = class.and_then(|c| c.ellipsize).unwrap_or_default();
        let inherited = self.inherited_text_style(key);
        let (no_wrap, selectable, highlight, pretty) = self.inherited_text_wrap(key);
        let (align, physical) = node
            .text_style
            .text_align
            .map(|align| (align, node.text_style.text_align_physical))
            .or_else(|| self.inherited_text_align(key))
            .unwrap_or_default();
        let mut text = AttributedText {
            align: directed_align(align, node.rtl && !physical),
            writing_direction: node.text_style.writing_direction,
            rtl: node.rtl,
            max_lines,
            ellipsize,
            // A line clamp already keeps lines from wrapping past it, and
            // must ellipsize at the box (`truncate`).
            no_wrap: max_lines == 0 && no_wrap.unwrap_or(false),
            shadow: node.text_style.shadow(),
            selectable,
            selection_color: node
                .paragraph
                .selection_color
                .or(node.text_style.selection_color)
                .or(highlight),
            ..AttributedText::default()
        };
        let base = inherited.inherit(&node.text_style);
        let multiplier = node.paragraph.font_multiplier(self.font_scale);
        let inserted = self.update_attachments(key);
        let baselines = self.attachment_baselines(key);
        let mut parts = TextAttachments {
            alignments: crate::AttachmentAlignments::default(),
            spacers: Vec::new(),
            baselines: &baselines,
            next_baseline: 0,
        };
        let mut sources = SourceCollector::default();
        self.collect_text(key, base, &mut text, &mut parts, &mut sources, None, false);
        let sources = sources.finish(&text.text);
        let TextAttachments {
            alignments,
            spacers,
            ..
        } = parts;
        self.hide_attachments(key, false);
        if multiplier != 1.0 {
            for span in &mut text.spans {
                span.style = scaled(span.style, multiplier);
            }
        }
        let layout = self.nodes[key as usize]
            .layout
            .expect("text block has layout");
        let (had_sources, sources_changed) = match self.layout.get_node_context(layout) {
            Some(LeafContext::Text(cx)) => (!cx.sources.is_empty(), cx.sources != sources),
            _ => (false, false),
        };
        if sources_changed {
            let has_sources = !sources.is_empty();
            if !had_sources && has_sources {
                self.source_texts.push(key);
            } else if had_sources
                && !has_sources
                && let Some(pos) = self.source_texts.iter().position(|&k| k == key)
            {
                self.source_texts.swap_remove(pos);
            }
            self.mark_enclosing_reader_dirty(key, false);
        }
        let colors_at_draw = self.text_engine.draws_colors_from_text();
        let cx = self.text_cx(layout);
        cx.deferred = deferred;
        if sources_changed {
            cx.sources = sources;
            cx.source_geometry = None;
        }
        cx.spacers = spacers;
        let pretty_changed = cx.pretty.is_some() != pretty;
        if pretty_changed {
            cx.pretty = pretty.then(|| Box::new((f32::NAN, Points::ZERO)));
            cx.laid_out = None;
        }
        if *cx.text == text && cx.alignments == alignments {
            if inserted {
                // New attachment views: placed with the next final layout.
                cx.laid_out = None;
            }
            return inserted || pretty_changed;
        }
        if !cx.text.metadata_eq(&text)
            && !inserted
            && cx.alignments == alignments
            && cx.text.rendering_eq(&text)
        {
            cx.text = Arc::new(text);
            cx.metadata_changed = true;
            return true;
        }
        // Only colors or hidden runs changed, and the platform draws them
        // from the text: its typesetting, measurements and final layout all
        // stand; the new text is mounted with the layout drawn (a fitted
        // text has a layout of its own text, made again).
        if !inserted
            && cx.alignments == alignments
            && colors_at_draw
            && cx
                .laid_out
                .as_ref()
                .is_none_or(|l| Arc::ptr_eq(&l.text, &cx.text))
            && cx.text.same_but_colors(&text)
        {
            let text = Arc::new(text);
            if let Some(laid) = &mut cx.laid_out {
                laid.text = text.clone();
            }
            cx.text = text;
            cx.metadata_changed = true;
            return true;
        }
        cx.metadata_changed = false;
        let same_layout = cx.text.layout_eq(&text) && cx.alignments == alignments;
        cx.alignments = alignments;
        cx.text = Arc::new(text);
        // Platform typesetting state embeds colors too (unless it draws
        // them from the text, above): rebuild it.
        cx.prepared = None;
        cx.min_content = None;
        cx.laid_out = None;
        cx.source_geometry = None;
        if let Some(p) = &mut cx.pretty {
            p.0 = f32::NAN;
        }
        if !same_layout {
            cx.layout_hash = cx.alignments.layout_hash(&cx.text);
            cx.cache = None;
            cx.baseline = None;
            cx.same_lines = None;
            cx.no_ahead = false;
            // A text that measures as before leaves every layout standing:
            // only the text is mounted again. Attachments are placed by its
            // final layout, laid out again with the rest.
            let attachments =
                !cx.alignments.is_empty() || !self.nodes[key as usize].attached.is_empty();
            let measure = leaf_measure(&self.text_engine, &mut self.measure_cache);
            // A text sized by its style never resizes its box: no need to
            // typeset it to know.
            if attachments
                || !(self.layout.sized_by_style(layout)
                    || self.layout.measures_as_before(layout, measure))
            {
                self.layout.mark_dirty(layout);
                self.needs_layout = true;
            }
        }
        true
    }

    /// The text of `key`'s children into `out`, what it learns of their
    /// attachments into `parts`; `in_press`: inside a span taking presses.
    fn collect_text(
        &self,
        key: Key,
        style: ResolvedTextStyle,
        out: &mut AttributedText,
        parts: &mut TextAttachments<'_>,
        sources: &mut SourceCollector,
        inherited_source: Option<usize>,
        in_press: bool,
    ) {
        let own_source = self
            .text_sources
            .get(&key)
            .map(|source| sources.begin(source.clone(), out.len_utf16()));
        let source = own_source.or(inherited_source);
        if let Some(text) = self.folded_text(key) {
            let start = out.len_utf16();
            out.push(text, style);
            sources.text(source, start, out.len_utf16());
        }
        for &c in &self.nodes[key as usize].children {
            let child = &self.nodes[c as usize];
            if child.is_overlay() {
                continue;
            }
            match child.kind {
                Kind::RawText => {
                    let start = out.len_utf16();
                    out.push(&child.text, style);
                    sources.text(source, start, out.len_utf16());
                }
                Kind::Text => {
                    let start = out.len_utf16();
                    let mut inner = style.inherit(&child.text_style);
                    if let Some(mut b) = span_background(&child.view_style, child.id) {
                        (b.top, b.bottom) = span_vertical_padding(child);
                        inner.background = Some(b);
                    }
                    // `visibility: "hidden"` on a span hides its characters,
                    // and those of the spans inside it, where they stand.
                    if inner.hidden || child.view_style.hidden {
                        inner = inner.hide();
                    }
                    let press = pressable(child.events);
                    let hinted = child.overlay_watched & overlay::watch::HINT != 0;
                    // Read from the classes, not `tracked`, which may be
                    // updated after this merge in the same commit.
                    let tracked = child.classes.as_ref().map_or(0, |c| c.tracked_states());
                    let hovers = tracked & crate::tailwind::state::HOVERED != 0;
                    // Horizontal padding takes room in the line, as a CSS
                    // inline box's does: an empty attachment at each end in
                    // the span's style, so its background spans it too.
                    let (first, last) = span_padding(child, out.rtl);
                    let pad = |out: &mut AttributedText, spacers: &mut Vec<u32>, w: f32| {
                        if w > 0.0 {
                            spacers.push(out.len_utf16());
                            out.push_attachment(crate::geometry::size_pt(w, 0.0), inner);
                        }
                    };
                    pad(out, &mut parts.spacers, first);
                    self.collect_text(c, inner, out, parts, sources, source, in_press || press);
                    pad(out, &mut parts.spacers, last);
                    // A link with a hint (its URL) hears the pointer come
                    // over its characters and leave them. A span that takes
                    // no presses (a `RichEditor`'s link mark: the editor's
                    // touches place the caret and open it) is one only for
                    // its hint: no press, no stop of Tab. Inside a span that
                    // takes presses it is none, so that span, the innermost
                    // link there, keeps the press of those characters.
                    // Hidden characters take no presses, as CSS's hidden
                    // elements take no pointer events. A span with
                    // `hover:` / `active:` styles hears the pointer and
                    // its presses the same way: it has no view to report
                    // its states, `Self::span_state` takes them from these.
                    if !inner.hidden && (press || ((hinted || hovers) && !in_press)) {
                        let mut events = child.events;
                        if hinted || hovers {
                            events.set(EventKind::MouseEnter, true);
                            events.set(EventKind::MouseLeave, true);
                        }
                        if press && tracked & crate::tailwind::state::PRESSED != 0 {
                            events.set(EventKind::PressDown, true);
                            events.set(EventKind::PressUp, true);
                        }
                        out.links.push(crate::text::TextLink {
                            start,
                            end: out.len_utf16(),
                            node: child.id,
                            events,
                            focus_stop: press
                                && child.props.as_ref().is_none_or(|p| p.focus_stop(true)),
                        });
                    }
                    if let Some(test_id) = child.props.as_ref().and_then(|p| p.test_id.clone()) {
                        out.test_ids.push(crate::text::SpanTestId {
                            start,
                            end: out.len_utf16(),
                            test_id,
                        });
                    }
                }
                // Placed in its root view, not in the text.
                Kind::Overlay => {}
                // An attachment, laid out by `update_attachments`.
                _ => {
                    if let Some(l) = child.layout {
                        let size = self.rounded_layout(l).size;
                        let start = out.len_utf16();
                        // The baselines are in the attachments' order: the
                        // next one is this attachment's, or a later one's.
                        if let Some(&(_, baseline)) = parts
                            .baselines
                            .get(parts.next_baseline)
                            .filter(|b| b.0 == c)
                        {
                            parts.next_baseline += 1;
                            parts
                                .alignments
                                .set_baseline(out.len_utf16(), Some(baseline));
                        }
                        if let Some(copy) = self.attachment_copy_text(c) {
                            out.copy_texts.push(crate::text::AttachmentCopyText::new(
                                out.len_utf16(),
                                copy.clone(),
                            ));
                        }
                        parts.alignments.push(
                            out,
                            crate::geometry::size_pt(size.width, size.height),
                            self.attachment_align(c),
                            style,
                        );
                        sources.text(source, start, out.len_utf16());
                    }
                }
            }
        }
        if let Some(scope) = own_source {
            sources.end(scope, out.len_utf16());
        }
    }

    /// Where attachment `key` sits in its line (`verticalAlign`). A
    /// placeholder of a render (`renderCustom`, ...) that sets none takes
    /// what its content sets: the placeholder and JS's holder around the
    /// content are not the app's views, so the app styles only the content
    /// (`<View style={{ verticalAlign: "middle" }}>` in `renderCustom`).
    fn attachment_align(&self, key: Key) -> crate::style::VerticalAlign {
        use crate::style::VerticalAlign;
        let node = &self.nodes[key as usize];
        if node.vertical_align != VerticalAlign::Baseline
            || !self.components.renders.is_place(node.id)
        {
            return node.vertical_align;
        }
        self.render_content(key)
            .map_or(VerticalAlign::Baseline, |content| {
                self.nodes[content as usize].vertical_align
            })
    }

    /// What a copy gives in place of attachment `key` (`copyText`): its
    /// own, or for a placeholder of a render (`renderCustom`, ...) that
    /// sets none its content's, as [`Self::attachment_align`] reads the
    /// content's alignment. An empty one copies as nothing, as unset.
    fn attachment_copy_text(&self, key: Key) -> Option<&Arc<str>> {
        let node = &self.nodes[key as usize];
        let copy = match &node.copy_text {
            Some(copy) => Some(copy),
            None if self.components.renders.is_place(node.id) => self
                .render_content(key)
                .and_then(|content| self.nodes[content as usize].copy_text.as_ref()),
            None => None,
        };
        copy.filter(|c| !c.is_empty())
    }

    /// The content of render placeholder `key`: the placeholder's only
    /// child is the holder; the holder's, the content.
    fn render_content(&self, key: Key) -> Option<Key> {
        let mut key = key;
        for _ in 0..2 {
            let mut children = self.nodes[key as usize]
                .children
                .iter()
                .filter(|&&c| !self.nodes[c as usize].is_overlay());
            match (children.next(), children.next()) {
                (Some(&only), None) => key = only,
                _ => return None,
            }
        }
        Some(key)
    }

    /// The attachments of text block `key` that stand on the baseline by
    /// a baseline of their own, with how far below their top it is: the
    /// first line's of the first text in each, laid out by
    /// [`Core::update_attachments`], as CSS stands an `inline-block` or
    /// `inline-flex` box on the baseline of its first line box. One with
    /// no text in it (an image, a box), or whose engine knows no
    /// baselines, stands on its bottom edge, as a replaced box.
    fn attachment_baselines(&mut self, key: Key) -> Vec<(Key, Points)> {
        let mut keys = Vec::new();
        self.attachments_of(key, &mut keys);
        keys.retain(|&a| self.attachment_align(a) == crate::style::VerticalAlign::Baseline);
        keys.into_iter()
            .filter_map(|a| Some((a, self.first_text_baseline(a, true)?)))
            .collect()
    }

    /// How far below `key`'s top the baseline of the first line of text
    /// in it is (`root`: `key` is the box asked about, else its place in
    /// its parent counts too); none without a text.
    fn first_text_baseline(&mut self, key: Key, root: bool) -> Option<Points> {
        let node = &self.nodes[key as usize];
        if node.is_overlay() {
            return None;
        }
        let layout = node.layout?;
        // Only what takes part in the box's flow has its baseline: not a
        // `display: none` subtree, which has no box (CSS Display), nor an
        // absolutely positioned one, out of the flow.
        if !root
            && (self.layout.displays_none(layout)
                || self.layout.style(layout).position == Position::Absolute)
        {
            return None;
        }
        let text = node.kind == Kind::Text;
        let l = *self.layout.unrounded_layout(layout);
        let top = if root { 0.0 } else { l.location.y };
        if text {
            let width =
                l.size.width - l.padding.left - l.padding.right - l.border.left - l.border.right;
            let engine = &self.text_engine;
            let Some(LeafContext::Text(cx)) = self.layout.get_node_context_mut(layout) else {
                return None;
            };
            let baseline = text_baseline(engine, cx, width.max(0.0))?;
            return Some(Points(top + l.border.top + l.padding.top) + baseline);
        }
        let children = self.nodes[key as usize].children.clone();
        children
            .into_iter()
            .find_map(|c| self.first_text_baseline(c, false))
            .map(|inner| Points(top) + inner)
    }

    /// The render placeholder in a text that view `key` is the content of
    /// (see [`Core::attachment_align`]), if it is one.
    fn placed_in_text(&self, key: Key) -> Option<Key> {
        let holder = self.nodes[key as usize].parent;
        if holder == NO_KEY || !self.is_render_holder(self.nodes[holder as usize].id) {
            return None;
        }
        let place = self.nodes[holder as usize].parent;
        (place != NO_KEY && self.nodes[place as usize].inline).then_some(place)
    }

    /// The attachments of text block `key` (views and images inside it,
    /// also inside its spans), in text order.
    fn attachments_of(&self, key: Key, out: &mut Vec<Key>) {
        for &c in &self.nodes[key as usize].children {
            let child = &self.nodes[c as usize];
            if child.is_overlay() {
                continue;
            }
            match child.kind {
                Kind::RawText | Kind::Overlay => {}
                Kind::Text => self.attachments_of(c, out),
                _ if child.layout.is_some() => out.push(c),
                _ => {}
            }
        }
    }

    /// The text block an attachment is in, if it is one.
    fn attachment_block(&self, key: Key) -> Option<Key> {
        let node = &self.nodes[key as usize];
        if !node.inline || node.layout.is_none() || node.kind == Kind::Text {
            return None;
        }
        let mut k = node.parent;
        while k != NO_KEY {
            let n = &self.nodes[k as usize];
            if !n.inline {
                return (n.kind == Kind::Text).then_some(k);
            }
            k = n.parent;
        }
        None
    }

    /// Lays out the attachments of text block `key` (each a layout root
    /// at its own content size) and keeps their native views inside the
    /// block's. Returns true if views were inserted (they need placing).
    fn update_attachments(&mut self, key: Key) -> bool {
        let mut keys = Vec::new();
        self.attachments_of(key, &mut keys);
        let block = &self.nodes[key as usize];
        if keys.is_empty() && block.attached.is_empty() {
            return false;
        }
        let (block_id, created) = (block.id, block.created);
        let old = std::mem::take(&mut self.nodes[key as usize].attached);
        let mut inserted = false;
        for &a in &keys {
            let id = self.nodes[a as usize].id;
            let new = !old.contains(&id);
            if created && new {
                self.ensure_created(a);
                self.mount.push(MountItem::Insert {
                    parent: block_id,
                    child: id,
                    before: None,
                });
                inserted = true;
            }
            let layout = self.nodes[a as usize].layout.expect("attachment layout");
            let dirty = self.layout.dirty(layout);
            if dirty {
                self.layout_root(
                    layout,
                    taffy::Size {
                        width: AvailableSpace::MaxContent,
                        height: AvailableSpace::MaxContent,
                    },
                );
            }
            if created && (dirty || new) {
                // Its own frame follows the text; its subtree's now.
                let children = std::mem::take(&mut self.nodes[a as usize].children);
                for &child in &children {
                    self.emit_frames(child);
                }
                self.nodes[a as usize].children = children;
            }
        }
        // Views that left the block and were not moved natively elsewhere.
        for id in old {
            let Ok(k) = self.key(id) else { continue };
            let n = &self.nodes[k as usize];
            let moved = n.parent != NO_KEY && !n.inline && self.nodes[n.parent as usize].created;
            if n.created && !moved && self.attachment_block(k).is_none() {
                self.mount.push(MountItem::Remove { id });
            }
        }
        let ids: Vec<NodeId> = keys.iter().map(|&a| self.nodes[a as usize].id).collect();
        let has = !ids.is_empty();
        self.nodes[key as usize].attached = if created { ids } else { Vec::new() };
        match (has, self.attachment_blocks.contains(&key)) {
            (true, false) => self.attachment_blocks.push(key),
            (false, true) => self.attachment_blocks.retain(|&k| k != key),
            _ => {}
        }
        inserted
    }

    /// Text blocks whose attachments' content changed are built again.
    fn check_attachments(&mut self) {
        let mut i = 0;
        while i < self.attachment_blocks.len() {
            let key = self.attachment_blocks[i];
            i += 1;
            let Some(node) = self.nodes.get(key as usize) else {
                continue;
            };
            let dirty = node.attached.iter().any(|&id| {
                self.key(id).is_ok_and(|k| {
                    self.nodes[k as usize]
                        .layout
                        .is_some_and(|l| self.layout.dirty(l))
                })
            });
            if dirty {
                self.mark(key, dirty::TEXT_BUILD);
            }
        }
    }

    /// Where the layout of the node around `layout` is in its layout root
    /// (the sum of the unrounded locations above it), as Taffy's rounding
    /// carries it down: added from the root down, in Taffy's order, so the
    /// sum is the same to the last bit of an `f32` (an edge at x.5 rounds
    /// one way or the other on it).
    fn positioning_parent(&self, layout: LayoutId) -> Option<LayoutId> {
        let mut parent = self.layout.parent(layout)?;
        match self.layout.style(layout).position {
            Position::Absolute => {
                while !self.layout.style(parent).position.is_positioned() {
                    let Some(above) = self.layout.parent(parent) else {
                        break;
                    };
                    parent = above;
                }
            }
            Position::Fixed => {
                while let Some(above) = self.layout.parent(parent) {
                    parent = above;
                }
            }
            _ => {}
        }
        Some(parent)
    }

    fn layout_origin(&self, layout: LayoutId) -> taffy::Point<f32> {
        let mut above = Vec::new();
        let mut at = self.positioning_parent(layout);
        while let Some(node) = at {
            above.push(node);
            at = self.positioning_parent(node);
        }
        above
            .iter()
            .rev()
            .fold(taffy::Point::ZERO, |origin, &node| {
                let l = self.layout.unrounded_layout(node);
                taffy::Point {
                    x: origin.x + l.location.x,
                    y: origin.y + l.location.y,
                }
            })
    }

    /// `layout`'s layout, rounded to the surface's device pixels as Taffy's
    /// rounding pass rounds to whole points ([`rounded`]); on a grid
    /// surface, to its whole Cells.
    fn rounded_layout(&self, layout: LayoutId) -> taffy::Layout {
        rounded(
            self.layout.unrounded_layout(layout),
            self.containing_origin(layout),
            self.frame_ratio(),
        )
    }

    /// The [`Origin`] of the box `layout` is placed in: the node around
    /// it, or its containing block ([`Core::positioning_parent`]).
    fn containing_origin(&self, layout: LayoutId) -> Origin {
        self.positioning_parent(layout)
            .map_or(Origin::default(), |parent| self.box_origin(parent))
    }

    /// `layout`'s own box as the [`Origin`] of the nodes placed in it.
    fn box_origin(&self, layout: LayoutId) -> Origin {
        let origin = self.layout_origin(layout);
        let l = self.layout.unrounded_layout(layout);
        Origin::of(
            taffy::Point {
                x: origin.x + l.location.x,
                y: origin.y + l.location.y,
            },
            l.size,
            self.frame_ratio(),
        )
    }

    /// What frames are rounded to, per axis, in "pixels" per point: the
    /// surface's device pixels, or on a grid surface its Cells (one Cell a
    /// pixel: [`terminal_layout::Grid::ratio`]).
    fn frame_ratio(&self) -> taffy::Size<f32> {
        match self.layout.grid() {
            Some(grid) => grid.ratio(),
            None => {
                let ratio = self.pixel_ratio();
                taffy::Size {
                    width: ratio,
                    height: ratio,
                }
            }
        }
    }

    /// The surface's Cell size is now `cell` (`None`: it is no grid):
    /// styles are put on the grid, or taken off it, and everything is laid
    /// out again ([`grid`]).
    fn cell_changed(&mut self, cell: Option<Size<Points>>, dark: bool) {
        let grid = cell
            .and_then(terminal_layout::Grid::new)
            .map(|g| g.with_page(dark));
        let cell = grid.map(|g| Size::new(Points(g.width), Points(g.height)));
        if self.measure_cache.set_cell(cell) {
            self.fonts_changed();
        }
        let toggled_grid = self.layout.grid().is_some() != grid.is_some();
        let before: Vec<(Key, bool)> = if toggled_grid {
            self.nodes
                .iter()
                .filter(|(_, n)| n.created)
                .filter_map(|(k, n)| Some((k as Key, self.layout.displays_none(n.layout?))))
                .collect()
        } else {
            Vec::new()
        };
        if self.layout.set_grid(grid) {
            self.needs_layout = true;
            for (key, was_hidden) in before {
                self.sync_layout_hidden(key, was_hidden);
            }
        }
    }

    /// The device pixels per point layouts and text measurements are rounded
    /// to: the environment's pixel ratio ([`MeasureCache::pixel_ratio`]).
    fn pixel_ratio(&self) -> f32 {
        self.measure_cache.pixel_ratio()
    }

    /// The surface's pixel ratio is now `ratio`: frames are rounded to its
    /// device pixels and text is measured in them, so a new ratio measures
    /// text again and sends every frame that moves.
    fn pixel_ratio_changed(&mut self, ratio: f32) {
        if !self.measure_cache.set_pixel_ratio(ratio) {
            return;
        }
        self.fonts_changed();
        let layouts: Vec<LayoutId> = self
            .nodes
            .iter()
            .filter(|(_, n)| n.created)
            .filter_map(|(_, n)| n.layout)
            .collect();
        for layout in layouts {
            self.layout.mark_dirty(layout);
        }
        self.needs_layout = true;
    }

    /// Lays out the main tree if it changed. Returns true if it did.
    fn layout_main(&mut self) -> bool {
        let root = self.nodes[self.root as usize].layout.expect("root layout");
        let available = taffy::Size {
            width: AvailableSpace::Definite(self.viewport.width.0),
            height: AvailableSpace::Definite(self.viewport.height.0),
        };
        // A clean root has nothing new to lay out, nor frames to emit.
        let main = self.layout.dirty(root);
        if main {
            // A main window that fits its content: laid out at its
            // content's size on those sides ([`Core::fit_window`]).
            let (fitting, fitted) = self
                .windows
                .get(&crate::ROOT_ID)
                .map_or(((false, false), false), |r| (r.fits(), r.fitted.is_some()));
            let mut available = available;
            if fitting != (false, false) || fitted {
                let mut style = root_style(self.viewport);
                if fitting.0 {
                    available.width = AvailableSpace::MaxContent;
                    style.size.width = taffy::Dimension::auto();
                }
                if fitting.1 {
                    available.height = AvailableSpace::MaxContent;
                    style.size.height = taffy::Dimension::auto();
                }
                self.layout.set_style(root, style);
            }
            self.layout_root(root, available);
            self.fit_window(self.root, root);
        }
        main
    }

    /// Lays out screens, modals and header items whose size or content
    /// changed, outer ones first (a stack may live in a modal), and emits
    /// their frames.
    fn layout_roots(&mut self) {
        if self.roots.is_empty() {
            return;
        }
        let mut order: Vec<(u32, Key)> = self
            .roots
            .iter()
            .filter(|&&k| {
                let n = &self.nodes[k as usize];
                n.created
                    && n.parent != NO_KEY
                    && (!n.is_overlay() || self.overlay(k).is_some_and(|s| s.host.is_some()))
            })
            .map(|&k| (self.root_depth(k), k))
            .collect();
        order.sort_unstable();
        for (_, key) in order {
            self.layout_detached(key);
        }
    }

    /// Input accessory `key` was attached to the tree (or detached): the
    /// inputs that name it are configured again.
    fn accessory_attached(&mut self, key: Key, attached: bool) {
        let node = &self.nodes[key as usize];
        let Some(name) = node.root.as_ref().and_then(|r| r.native_id.clone()) else {
            return;
        };
        let id = node.id;
        if attached {
            self.accessories.insert(name.clone(), id);
        } else if self.accessories.get(&name) == Some(&id) {
            self.accessories.remove(&name);
        } else {
            return;
        }
        let inputs: Vec<Key> = self
            .nodes
            .iter()
            .filter(|(_, n)| {
                n.input
                    .as_ref()
                    .is_some_and(|i| i.config.accessory_id.as_deref() == Some(&*name))
            })
            .map(|(k, _)| k as Key)
            .collect();
        for k in inputs {
            self.mark(k, dirty::INPUT);
        }
    }

    /// Number of screens / modals / header items above `key`.
    fn root_depth(&self, mut key: Key) -> u32 {
        let mut depth = 0;
        key = self.nodes[key as usize].parent;
        while key != NO_KEY {
            let n = &self.nodes[key as usize];
            if n.is_layout_root() {
                depth += 1;
            }
            key = n.parent;
        }
        depth
    }

    /// How far the system UI at the top (status bar) reaches into `key`:
    /// its root's top inset minus its offset in that root.
    fn top_overlap(&self, key: Key) -> f32 {
        let mut y = 0.0;
        let mut k = key;
        loop {
            let n = &self.nodes[k as usize];
            if k == self.root {
                return (self.safe_area.top.0 - y).max(0.0);
            }
            if n.is_layout_root() {
                let inset = match n.kind {
                    Kind::Modal => n.root.as_ref().map_or(0.0, |r| r.insets.top.0),
                    _ => 0.0,
                };
                return (inset - y).max(0.0);
            }
            if !n.frame.origin.y.0.is_nan() {
                y += n.frame.origin.y.0;
            }
            if n.parent == NO_KEY {
                return 0.0;
            }
            k = n.parent;
        }
    }

    /// The platform draws a header of its own above screens (iOS,
    /// Android); without one ([`crate::NO_NATIVE_HEADER`]) a screen's
    /// `header` slot is placed at its top.
    fn native_header(&self) -> bool {
        self.header_heights != crate::NO_NATIVE_HEADER
    }

    /// The size of screen `key`: its stack's (`None` outside a stack).
    fn screen_size(&self, key: Key) -> Option<Size<Points>> {
        let parent = self.nodes[key as usize].parent;
        let p = self.nodes.get(parent as usize)?;
        let stack_layout = p.layout.filter(|_| p.kind == Kind::Stack)?;
        let s = self.rounded_layout(stack_layout).size;
        Some(size_pt(s.width, s.height))
    }

    /// The `header` slot item of screen `key`, once created.
    fn header_slot(&self, key: Key) -> Option<Key> {
        self.nodes[key as usize]
            .children
            .iter()
            .copied()
            .find(|&c| {
                let n = &self.nodes[c as usize];
                n.kind == Kind::HeaderItem
                    && n.created
                    && n.root
                        .as_ref()
                        .is_some_and(|r| r.slot == HeaderSlot::Header)
            })
    }

    /// Without a native header: the height of screen `key`'s `header` slot,
    /// laid out first (as wide as the screen), 0 without one.
    fn drawn_header(&mut self, key: Key) -> f32 {
        let Some(item) = self.header_slot(key) else {
            return 0.0;
        };
        self.layout_detached(item);
        self.nodes[item as usize]
            .layout
            .map_or(0.0, |l| self.rounded_layout(l).size.height)
    }

    fn layout_detached(&mut self, key: Key) {
        if self.nodes[key as usize].is_overlay() {
            self.layout_overlay(key);
            return;
        }
        let native_header = self.native_header();
        let drawn_header = if !native_header && self.nodes[key as usize].kind == Kind::Screen {
            self.drawn_header(key)
        } else {
            0.0
        };
        let title_room = {
            let n = &self.nodes[key as usize];
            let title = native_header
                && n.kind == Kind::HeaderItem
                && n.root.as_ref().is_some_and(|r| r.slot == HeaderSlot::Title);
            let parent = n.parent;
            if title && parent != NO_KEY {
                self.title_room(parent).unwrap_or(0.0)
            } else {
                0.0
            }
        };
        let node = &self.nodes[key as usize];
        let (Some(layout), kind, parent) = (node.layout, node.kind, node.parent) else {
            return;
        };
        let root = node.root.as_ref().expect("root state");
        let (size, header, available) = match kind {
            Kind::Screen => {
                let Some(size) = self.screen_size(key) else {
                    return;
                };
                let c = &root.screen;
                let measured = root
                    .header
                    .filter(|_| !c.large_title && !c.header_transparent);
                let header = if !native_header {
                    drawn_header
                } else if !c.header_visible {
                    0.0
                } else if let Some(measured) = measured {
                    measured
                } else {
                    let bar = if c.large_title {
                        self.header_heights.1
                    } else {
                        self.header_heights.0
                    };
                    bar.0 + self.top_overlap(parent)
                };
                (size, header, definite(size))
            }
            // A screen's `header` without a native header: as wide as the
            // screen, as tall as its content.
            Kind::HeaderItem if !native_header && root.slot == HeaderSlot::Header => {
                let Some(screen) = self.screen_size(parent) else {
                    return;
                };
                (
                    size_pt(screen.width.0, 0.0),
                    0.0,
                    taffy::Size {
                        width: AvailableSpace::Definite(screen.width.0),
                        height: AvailableSpace::MaxContent,
                    },
                )
            }
            // A native header's title view: at its content's width, at most
            // the room the bar leaves between its items (as the toolbar's own
            // title), so a long title shrinks instead of running under them.
            Kind::HeaderItem if native_header && root.slot == HeaderSlot::Title => (
                Size::default(),
                title_room,
                taffy::Size {
                    width: AvailableSpace::MaxContent,
                    height: AvailableSpace::MaxContent,
                },
            ),
            Kind::Modal => {
                // A window whose size is not known yet: its content's.
                let known = self.root_view_size(key);
                let size = known.unwrap_or_default();
                let mut available = match known {
                    Some(size) => definite(size),
                    None => taffy::Size {
                        width: AvailableSpace::MaxContent,
                        height: AvailableSpace::MaxContent,
                    },
                };
                // A window that fits its content: laid out at its content's
                // size on those sides ([`Core::fit_window`]).
                let (width, height) = self
                    .windows
                    .get(&node.id)
                    .map_or((false, false), |r| r.fits());
                if width {
                    available.width = AvailableSpace::MaxContent;
                }
                if height {
                    available.height = AvailableSpace::MaxContent;
                }
                (size, 0.0, available)
            }
            // As wide as the window, as tall as its content.
            Kind::InputAccessory => (
                size_pt(self.viewport.width.0, 0.0),
                0.0,
                taffy::Size {
                    width: AvailableSpace::Definite(self.viewport.width.0),
                    height: AvailableSpace::MaxContent,
                },
            ),
            _ => (
                Size::default(),
                0.0,
                taffy::Size {
                    width: AvailableSpace::MaxContent,
                    height: AvailableSpace::MaxContent,
                },
            ),
        };
        let changed = root.laid_out != Some((size, header));
        if !changed && !self.layout.dirty(layout) {
            return;
        }
        if kind == Kind::HeaderItem && native_header && root.slot == HeaderSlot::Title {
            let mut style = self.layout.style(layout).clone();
            style.max_size.width = if header > 0.0 {
                taffy::LengthPercentageAuto::length(header)
            } else {
                taffy::LengthPercentageAuto::auto()
            };
            self.layout.set_style(layout, style);
        } else if kind == Kind::InputAccessory
            || (kind == Kind::HeaderItem && size.width > Points::ZERO)
        {
            let mut style = self.layout.style(layout).clone();
            style.size.width = taffy::Dimension::length(size.width.0);
            self.layout.set_style(layout, style);
        } else if kind != Kind::HeaderItem {
            let config_padding = match kind {
                // Large titles and transparent headers lay the content out
                // under the native header (scroll views inset themselves
                // natively).
                Kind::Screen
                    if native_header
                        && (root.screen.header_transparent || root.screen.large_title) =>
                {
                    0.0
                }
                _ => header,
            };
            let mut style = self.nodes[key as usize]
                .base_layout
                .as_deref()
                .cloned()
                .unwrap_or_default();
            style.size = taffy::Size {
                width: taffy::Dimension::length(size.width.0),
                height: taffy::Dimension::length(size.height.0),
            };
            if kind == Kind::Modal {
                let id = self.nodes[key as usize].id;
                let (mut width, mut height) =
                    self.windows.get(&id).map_or((false, false), |r| r.fits());
                if self.root_view_size(key).is_none() {
                    (width, height) = (true, true);
                }
                if width {
                    style.size.width = taffy::Dimension::auto();
                }
                if height {
                    style.size.height = taffy::Dimension::auto();
                }
            }
            if config_padding > 0.0 {
                let base = match style.padding.top.into_raw() {
                    raw if raw.tag() == taffy::CompactLength::LENGTH_TAG => raw.value(),
                    _ => 0.0,
                };
                style.padding.top = taffy::LengthPercentage::length(base + config_padding);
            }
            self.layout.set_style(layout, style);
        }
        let header_changed = root.laid_out.is_none_or(|(_, h)| h != header);
        self.nodes[key as usize]
            .root
            .as_mut()
            .expect("root state")
            .laid_out = Some((size, header));
        self.layout_root(layout, available);
        if kind == Kind::Modal {
            self.fit_window(key, layout);
        }
        self.emit_frames(key);
        let screen = match kind {
            Kind::Screen if header_changed => Some(key),
            Kind::HeaderItem if self.header_item_emptied(key) => Some(parent),
            _ => None,
        };
        if let Some(screen) = screen {
            let id = self.nodes[screen as usize].id;
            if let Some(config) = self.screen_config(screen) {
                self.mount.push(MountItem::ScreenConfig {
                    id,
                    config: Box::new(config),
                });
            }
        }
    }

    /// Header item `key` was laid out: records whether a leading,
    /// trailing or title one has no width (its content is gone, or shows nothing)
    /// and answers whether that changed, so its screen's options go out
    /// again with the bar's item left out or put back.
    fn header_item_emptied(&mut self, key: Key) -> bool {
        let width = self.nodes[key as usize]
            .layout
            .map_or(0.0, |l| self.rounded_layout(l).size.width);
        let root = self.nodes[key as usize].root.as_mut().expect("root state");
        if root.slot == HeaderSlot::Header {
            return false;
        }
        let empty = width <= 0.0;
        std::mem::replace(&mut root.empty, empty) != empty
    }

    /// The width a native header leaves screen `key`'s title view: the
    /// screen's, less the bar's insets, the back button and the leading and
    /// trailing items (laid out first). `None` outside a stack.
    fn title_room(&mut self, key: Key) -> Option<f32> {
        /// The bar's inset at either end, and the gap after an item.
        const INSET: f32 = 16.0;
        /// The back button's room, its inset included.
        const BACK: f32 = 56.0;
        /// The room of a native bar button.
        const BUTTON: f32 = 48.0;
        let width = self.screen_size(key)?.width.0;
        let items: Vec<(Key, HeaderSlot)> = self.nodes[key as usize]
            .children
            .iter()
            .filter_map(|&c| {
                let n = &self.nodes[c as usize];
                let slot = n.root.as_ref()?.slot;
                (n.kind == Kind::HeaderItem
                    && n.created
                    && matches!(slot, HeaderSlot::Left | HeaderSlot::Right))
                .then_some((c, slot))
            })
            .collect();
        let mut room = width - 2.0 * INSET;
        let (mut left, mut right) = (false, false);
        for (item, slot) in items {
            self.layout_detached(item);
            let w = self.nodes[item as usize]
                .layout
                .map_or(0.0, |l| self.rounded_layout(l).size.width);
            room -= w + INSET;
            match slot {
                HeaderSlot::Left => left = true,
                _ => right = true,
            }
        }
        let screen = &self.nodes[key as usize];
        let config = &screen.root.as_ref()?.screen;
        if !right && !config.right_items.is_empty() {
            room -= config.right_items.len() as f32 * BUTTON;
        }
        // Not the stack's first screen: a back button leads the bar.
        let first = self.nodes[screen.parent as usize].children.first() == Some(&key);
        if !left && config.back_visible && !first {
            room -= BACK;
        }
        Some(room.max(1.0))
    }

    /// The options of screen `key`, with its header items.
    fn screen_config(&self, key: Key) -> Option<ScreenConfig> {
        let node = &self.nodes[key as usize];
        let root = node.root.as_ref().filter(|_| node.kind == Kind::Screen)?;
        let mut config = root.screen.clone();
        config.header_height = Points(root.laid_out.map_or(0.0, |(_, h)| h));
        for &c in &node.children {
            let child = &self.nodes[c as usize];
            if child.kind != Kind::HeaderItem || !child.created {
                continue;
            }
            let slot = child.root.as_ref().map_or(HeaderSlot::Left, |r| r.slot);
            // A side's item with nothing to show leaves the bar without a
            // button there, unless the platform's own button stands in for
            // it (and presses it).
            let empty = child.root.as_ref().is_some_and(|r| r.empty);
            let system = match slot {
                HeaderSlot::Left => {
                    config.left_system_item.is_some() || config.left_symbol.is_some()
                }
                HeaderSlot::Right => {
                    config.right_system_item.is_some() || config.right_symbol.is_some()
                }
                // An empty title view gives the platform's title text back.
                HeaderSlot::Title => false,
                HeaderSlot::Header => true,
            };
            if empty && !system {
                continue;
            }
            let target = match slot {
                HeaderSlot::Left => &mut config.left,
                HeaderSlot::Right => &mut config.right,
                HeaderSlot::Title => &mut config.title_view,
                HeaderSlot::Header => &mut config.header_view,
            };
            *target = Some(child.id);
        }
        if let Some(style) = self.part_resolved(key, classes::Part::Header) {
            let background = style.view.background_color;
            config.background_color = (background.0 & 0xff != 0).then_some(background);
            config.title_color = style.text.color;
            config.tint_color = style.view.tint_color;
        }
        Some(config)
    }

    /// Lays out the list cells that changed: items at their column's
    /// width, the header, footer and empty placeholder at the content's.
    fn layout_cells(&mut self) {
        for i in 0..self.lists.len() {
            let key = self.lists[i];
            let list = &self.nodes[key as usize];
            let Some(list_layout) = list.layout else {
                continue;
            };
            let state = list.list.as_ref().expect("list");
            let horizontal = state.horizontal;
            let l = self.rounded_layout(list_layout);
            let size = l.size;
            let cross = if !state.parent {
                if horizontal { size.height } else { size.width }
            } else if horizontal {
                // In its parent's viewport: the cells fill its content box.
                (size.height - l.border.top - l.border.bottom - l.padding.top - l.padding.bottom)
                    .max(0.0)
            } else {
                (size.width - l.border.left - l.border.right - l.padding.left - l.padding.right)
                    .max(0.0)
            };
            // In a terminal its scroll bar takes a column (a row) of its own
            // once the content overflows, as a scroll view's does.
            let cross = if state.parent {
                cross
            } else {
                let main = if horizontal {
                    size.width - l.border.left - l.border.right - l.padding.left - l.padding.right
                } else {
                    size.height - l.border.top - l.border.bottom - l.padding.top - l.padding.bottom
                };
                let room = self.layout.list_bar_room(list_layout, horizontal);
                if room > 0.0 && state.content_len() > main + 0.5 {
                    (cross - room).max(0.0)
                } else {
                    cross
                }
            };
            let cell = self
                .layout
                .grid()
                .map(|g| if horizontal { g.height } else { g.width });
            let item_cross = state.column(cross, 0, cell).1;
            let extra_cross = state.full_width(cross).1;
            let stretch = state
                .content
                .align_items
                .is_none_or(|a| a == taffy::AlignItems::STRETCH);
            let available = |c: f32| {
                let cross = if stretch {
                    AvailableSpace::Definite(c)
                } else {
                    AvailableSpace::MaxContent
                };
                if horizontal {
                    taffy::Size {
                        width: AvailableSpace::MaxContent,
                        height: cross,
                    }
                } else {
                    taffy::Size {
                        width: cross,
                        height: AvailableSpace::MaxContent,
                    }
                }
            };
            // Laying out even a clean root costs a tree walk (taffy rounds the
            // whole subtree), so only dirty cells are laid out again — all
            // of them when the list's cross size or columns changed.
            let list_state = self.nodes[key as usize].list.as_mut().expect("list");
            let resized = list_state.cells_cross != cross;
            list_state.cells_cross = cross;
            let cells = std::mem::take(&mut self.nodes[key as usize].children);
            for &cell in &cells {
                let node = &self.nodes[cell as usize];
                // Its built-in bar: laid out by `layout_scrollbars`.
                let (Some(cell_layout), false) = (node.layout, node.decoration) else {
                    continue;
                };
                let c = match node.slot {
                    Some(CellSlot::Item(_)) | None => item_cross,
                    Some(_) => extra_cross,
                };
                self.layout.set_host(cell_layout, list_layout);
                if resized || self.layout.dirty(cell_layout) {
                    self.layout_root(cell_layout, available(c));
                    self.nodes[cell as usize].relaid = true;
                }
            }
            self.nodes[key as usize].children = cells;
        }
    }

    /// Lays out the tree under `root` within `available`.
    fn layout_root(&mut self, root: LayoutId, available: taffy::Size<AvailableSpace>) {
        let measure = leaf_measure(&self.text_engine, &mut self.measure_cache);
        self.layout
            .compute_layout_with_measure(root, available, measure);
    }

    /// Lays out the relayout boundaries a change inside made dirty
    /// (`LayoutTree::relayout_boundaries`), returning those laid out on
    /// their own: their subtrees' frames are new.
    fn relayout_boundaries(&mut self) -> Vec<Key> {
        let measure = leaf_measure(&self.text_engine, &mut self.measure_cache);
        self.layout.relayout_boundaries(measure)
    }

    /// Whether `key` is out of the layout: `display: none` on it or on a
    /// view it is laid out in (Taffy gives all of them no size).
    fn displays_none(&self, key: Key) -> bool {
        let mut k = key;
        while k != NO_KEY {
            let n = &self.nodes[k as usize];
            if let Some(layout) = n.layout
                && self.layout.displays_none(layout)
            {
                return true;
            }
            if n.is_layout_root() {
                return false;
            }
            k = n.parent;
        }
        false
    }

    #[inline]
    fn queue_text(&mut self, key: Key) {
        let node = &mut self.nodes[key as usize];
        if !node.text_queued {
            node.text_queued = true;
            self.pending_text.push(key);
        }
    }

    /// Makes the final layout of every queued text block whose content or
    /// box changed, and emits it.
    fn flush_text(&mut self) {
        let mut pending = std::mem::take(&mut self.pending_text);
        self.flush_texts(&pending, true);
        pending.clear();
        self.pending_text = pending;
    }

    /// Source reading can need final text geometry before a list issues its
    /// correction. The normal flush reuses this same layout and still drains
    /// the ordinary queue after frames and overlays have been placed.
    fn flush_texts(&mut self, pending: &[Key], dequeue: bool) {
        // Attachment views to place: (block, its final layout, content box).
        let mut placements: Vec<(Key, TextLayout, Bounds<Points>)> = Vec::new();
        for &key in pending {
            let Some(node) = self.nodes.get_mut(key as usize) else {
                continue;
            };
            if dequeue {
                node.text_queued = false;
            }
            let align_vertical = node.text_style.align_vertical.unwrap_or_default();
            let report_lines = node.events.contains(EventKind::TextLayout);
            // Shrinking stops at a tenth: smaller is unreadable anyway.
            let fit = node
                .paragraph
                .fit
                .then_some(node.paragraph.min_font_scale.max(0.1));
            let (id, created, Some(layout)) = (node.id, node.created, node.layout) else {
                continue;
            };
            if !created {
                continue;
            }
            if let Some(commit) = self.measure_cache.resizing
                && let Some(LeafContext::Text(cx)) = self.layout.get_node_context_mut(layout)
                && cx.near_screen != commit
                && cx
                    .laid_out
                    .as_ref()
                    .is_some_and(|l| Arc::ptr_eq(&l.text, &cx.text))
            {
                cx.held = true;
                continue;
            }
            // Whatever Taffy keeps for it (`emit_frames_in`).
            let hidden = self.displays_none(key);
            let mut content = if hidden {
                Bounds::default()
            } else {
                content_box(&self.rounded_layout(layout))
            };
            // The width Taffy measured its lines in, before its box was
            // rounded to device pixels (none on a grid, whose Cells hold
            // whole characters).
            let measured_width = (!hidden && self.layout.grid().is_none())
                .then(|| content_box(self.layout.unrounded_layout(layout)).size.width);
            let ratio = self.frame_ratio().width;
            let engine = &self.text_engine;
            let cache = &mut self.measure_cache;
            let Some(LeafContext::Text(cx)) = self.layout.get_node_context_mut(layout) else {
                continue;
            };
            let no_wrap = cx.text.no_wrap;
            let typeset = |rounded: Points| match measured_width {
                Some(measured) if !no_wrap => typeset_width(rounded, measured, ratio),
                _ => rounded,
            };
            if hidden {
                // Out of the layout (`display: none`). Its glyphs typeset
                // in its zero box would still show where a platform does
                // not clip text to its box (a browser), so it gets an
                // empty layout; the text itself stays what it is.
                if let Some((text, layout)) = cx.remount_metadata(content) {
                    cx.source_geometry = Some(SourceGeometry::default());
                    self.mount.push(MountItem::Text {
                        id,
                        text,
                        layout,
                        content,
                    });
                    continue;
                }
                if matches!(&cx.laid_out, Some(l) if l.content == content) {
                    refresh_source_geometry(engine, cx);
                    continue;
                }
                let layout =
                    engine.layout(&engine.prepare(&AttributedText::default()), content.size);
                cx.laid_out = Some(LaidText {
                    content,
                    layout: layout.clone(),
                    text: cx.text.clone(),
                });
                cx.metadata_changed = false;
                cx.source_geometry = Some(SourceGeometry::default());
                self.mount.push(MountItem::Text {
                    id,
                    text: cx.text.clone(),
                    layout,
                    content,
                });
                continue;
            }
            if cx.text.no_wrap {
                // One line at its natural width, past the box if need be.
                content.size.width = content
                    .size
                    .width
                    .max(measure_text(engine, cache, cx, None).width);
            }
            if align_vertical > Percentage(0.0) {
                // Text shorter than its box: moved down within it.
                let height =
                    measure_text(engine, cache, cx, Some(typeset(content.size.width).0)).height;
                if height < content.size.height {
                    content.origin.y += align_vertical.of(content.size.height - height);
                    content.size.height = height;
                }
            }
            if cx.pretty.is_some() && fit.is_none() {
                // Lines broken narrower than the box, where they go in it
                // as the text is aligned.
                let width = pretty_width(engine, cx, content.size.width);
                let spare = content.size.width - width;
                if spare > Points::ZERO {
                    content.origin.x += match cx.text.align {
                        TextAlign::Center => spare * 0.5,
                        TextAlign::Right => spare,
                        TextAlign::Auto if cx.text.rtl => spare,
                        _ => Points::ZERO,
                    };
                    content.size.width = width;
                }
            }
            if let Some((text, layout)) = cx.remount_metadata(content) {
                refresh_source_geometry(engine, cx);
                self.mount.push(MountItem::Text {
                    id,
                    text,
                    layout,
                    content,
                });
                continue;
            }
            let size = content.size;
            if let Some(min) = fit {
                // Shrunk to fit: its own text, laid out on its own.
                if matches!(&cx.laid_out, Some(l) if l.content == content) {
                    refresh_source_geometry(engine, cx);
                    continue;
                }
                let text = Arc::new(fitted(engine, &cx.text, &cx.alignments, size, min));
                let prepared = engine.prepare_aligned(&text, &cx.alignments);
                let text_layout = engine.layout(&prepared, size);
                cx.laid_out = Some(LaidText {
                    content,
                    layout: text_layout.clone(),
                    text: text.clone(),
                });
                cx.metadata_changed = false;
                cx.source_geometry = None;
                refresh_source_geometry(engine, cx);
                if report_lines {
                    self.events.push(crate::element::JsEvent::Event(
                        id,
                        EventKind::TextLayout,
                        text_lines(engine, &text, &text_layout),
                    ));
                    keep_geometry(
                        &self.geometry_engine,
                        &mut self.geometries,
                        id,
                        &text_layout,
                        &text,
                        &cx.spacers,
                    );
                }
                if !text.attachments.is_empty() {
                    placements.push((key, text_layout.clone(), content));
                }
                self.mount.push(MountItem::Text {
                    id,
                    text,
                    layout: text_layout,
                    content,
                });
                continue;
            }
            let text_layout = match &cx.laid_out {
                Some(l) if l.content == content => {
                    refresh_source_geometry(engine, cx);
                    continue;
                }
                // Only moved (padding, vertical alignment): the same layout.
                Some(l) if l.content.size == size => l.layout.clone(),
                // Another width with the same lines in the same places: what
                // a window's resize does to most text, typeset for nothing.
                Some(l) if keeps_lines(cx, l, size) => l.layout.clone(),
                _ => {
                    let prepared = cx
                        .prepared
                        .get_or_insert_with(|| engine.prepare_aligned(&cx.text, &cx.alignments));
                    let layout =
                        engine.layout(prepared, Size::new(typeset(size.width), size.height));
                    if report_lines {
                        self.events.push(crate::element::JsEvent::Event(
                            id,
                            EventKind::TextLayout,
                            text_lines(engine, &cx.text, &layout),
                        ));
                        keep_geometry(
                            &self.geometry_engine,
                            &mut self.geometries,
                            id,
                            &layout,
                            &cx.text,
                            &cx.spacers,
                        );
                    }
                    layout
                }
            };
            cx.laid_out = Some(LaidText {
                content,
                layout: text_layout.clone(),
                text: cx.text.clone(),
            });
            cx.metadata_changed = false;
            cx.source_geometry = None;
            refresh_source_geometry(engine, cx);
            if !cx.text.attachments.is_empty() {
                placements.push((key, text_layout.clone(), content));
            }
            self.mount.push(MountItem::Text {
                id,
                text: cx.text.clone(),
                layout: text_layout,
                content,
            });
        }
        for (key, layout, content) in placements {
            self.place_attachments(key, &layout, content);
        }
    }

    /// Moves the views of text block `key`'s attachments onto their
    /// placeholders in `layout` (content box `content`); cut off ones out
    /// of sight.
    fn place_attachments(&mut self, key: Key, layout: &TextLayout, content: Bounds<Points>) {
        let mut points = self.text_engine.attachments(layout);
        if let Some(l) = self.nodes[key as usize].layout {
            // Padding of spans is no view's.
            let cx = self.text_cx(l);
            if !cx.spacers.is_empty() {
                let mut indices = cx.text.attachments.iter().map(|a| a.index);
                points.retain(|_| indices.next().is_none_or(|i| !cx.spacers.contains(&i)));
            }
        }
        let attached = std::mem::take(&mut self.nodes[key as usize].attached);
        for (i, &id) in attached.iter().enumerate() {
            let Ok(a) = self.key(id) else { continue };
            let Some(l) = self.nodes[a as usize].layout else {
                continue;
            };
            let size = self.rounded_layout(l).size;
            let (x, y) = match points.get(i).copied().flatten() {
                Some(p) => (content.origin.x.0 + p.x.0, content.origin.y.0 + p.y.0),
                // Far away, like unbound list cells.
                None => (-100_000.0, 0.0),
            };
            self.set_frame(a, rect(x, y, size.width, size.height));
        }
        self.nodes[key as usize].attached = attached;
    }

    /// Emits the frame of `key` and its subtree (if changed).
    fn emit_frames(&mut self, key: Key) {
        let parent = self.nodes[key as usize].parent;
        let hidden = parent != NO_KEY && self.displays_none(parent);
        let origin = self.nodes[key as usize]
            .layout
            .and_then(|l| self.layout.parent(l))
            .map_or(Origin::default(), |parent| self.box_origin(parent));
        self.emit_frames_in(key, hidden, origin);
    }

    /// [`Core::emit_frames`] of `key`, `hidden` when a view around it is
    /// `display: none`. A view in such a subtree has no frame whatever
    /// Taffy keeps for it: Taffy can leave a node moved into a hidden
    /// subtree with its former layout (its dirty marking stops at the
    /// first node whose cache is empty, which hidden nodes' always are),
    /// and never rounds the absolutely positioned ones there (they are
    /// rounded through their containing block, which hidden layout does
    /// not record), so their native views would keep showing at their
    /// former size in a parent of no size.
    ///
    /// `origin` is where the layout of the view around it is in its layout
    /// root ([`Origin`]), carried down the walk.
    fn emit_frames_in(&mut self, key: Key, hidden: bool, origin: Origin) {
        let node = &self.nodes[key as usize];
        let Some(layout) = node.layout else { return };
        if !node.created {
            if node.culled {
                self.cull_frames_in(key, hidden, origin);
            }
            return;
        }
        let hidden = hidden || self.layout.displays_none(layout);
        if hidden {
            // Cells keep independent layout caches. Re-emit their descendants
            // when shown again, even if their measured size has not changed.
            if self.nodes[key as usize].kind == Kind::Cell {
                self.nodes[key as usize].relaid = true;
            }
            self.layout.emitted(layout);
            self.nodes[key as usize].emitted = None;
            if self.nodes[key as usize].follow.is_some() {
                self.laid_follower(key, None, false, (0.0, 0.0));
            }
            self.set_frame(key, Bounds::default());
            // An input's field would still show at its former content box
            // where a platform does not clip a view's children (a browser),
            // so it gets none either.
            let node = &mut self.nodes[key as usize];
            if let Some(input) = node.input.as_mut()
                && input.content.is_some_and(|c| c != Bounds::default())
            {
                input.content = Some(Bounds::default());
                self.mount.push(MountItem::InputContent {
                    id: node.id,
                    content: Bounds::default(),
                });
            }
            if self.nodes[key as usize].kind.is_container() {
                let children = std::mem::take(&mut self.nodes[key as usize].children);
                for &child in &children {
                    if !self.nodes[child as usize].is_layout_root() {
                        self.emit_frames_in(child, true, origin);
                    }
                }
                self.nodes[key as usize].children = children;
            }
            return;
        }
        let node = &self.nodes[key as usize];
        let unrounded = *self.layout.unrounded_layout(layout);
        // An absolute view in a positioned parent (React Native's default
        // `relative`) is placed in that parent, whose origin is `origin`,
        // summed in the same order as `layout_origin` sums it: only one
        // placed further up walks there (every cell of a table would walk to
        // the root, each frame the tree is laid out).
        let position = self.layout.style(layout).position;
        let escaping = position == Position::Fixed
            || (position == Position::Absolute
                && !self
                    .layout
                    .parent(layout)
                    .is_some_and(|p| self.layout.style(p).position.is_positioned()));
        let ratio = self.frame_ratio();
        // Nothing in the subtree was laid out anew and its origin moved by
        // whole device pixels (or not at all), its edges as they were: every
        // frame in it, relative to its parent, rounds as it did. A scroll
        // that moves a table's rows walks the rows' origin, not each cell.
        if !self.layout.stale(layout)
            && !node.escapes
            && !node.is_overlay()
            && !node.decoration
            && !self.nodes.get(node.parent as usize).is_some_and(|p| p.rtl)
            && node.emitted.is_some_and(|(at, r)| {
                let moved = |a: f32, b: f32, ratio: f32| {
                    let d = (a - b) * ratio;
                    d == d.round()
                };
                r == ratio
                    && at.back == origin.back
                    && moved(origin.at.x, at.at.x, ratio.width)
                    && moved(origin.at.y, at.at.y, ratio.height)
            })
        {
            self.nodes[key as usize].emitted = Some((origin, ratio));
            return;
        }
        self.layout.emitted(layout);
        let containing = if escaping {
            self.containing_origin(layout)
        } else {
            origin
        };
        let inner = Origin::of(
            taffy::Point {
                x: containing.at.x + unrounded.location.x,
                y: containing.at.y + unrounded.location.y,
            },
            unrounded.size,
            ratio,
        );
        let l = rounded(&unrounded, containing, ratio);
        let offset = origin.to(containing, ratio);
        let mut frame = rect(
            l.location.x + offset.x,
            l.location.y + offset.y,
            l.size.width,
            l.size.height,
        );
        // Children of a right-to-left horizontal scroll view: mirrored in
        // its content (not its bar, over the viewport).
        if let Some(parent) = self.nodes.get(node.parent as usize)
            && !node.decoration
            && parent.rtl
            && let Some(ScrollState {
                horizontal: true,
                content: Some(content),
                ..
            }) = parent.scroll.as_deref()
            && parent.kind == Kind::Scroll
        {
            frame.origin.x = content.width - frame.origin.x - frame.size.width;
        }
        if node.is_overlay() {
            frame.origin = self.overlay_origin(key, frame);
        }
        // A multiline input's bar: over it, laid out on its own.
        let beside = self.nodes[key as usize].beside;
        if beside != NO_KEY {
            frame.origin = self.nodes[beside as usize].frame.origin;
        } else if self.nodes[key as usize].decoration {
            // A scroll view's bar is laid out on its own, at no location:
            // `origin` is where it sits in the viewport (its
            // `scrollbar_inset`, [`Core::layout_scrollbars`]).
            let offset = Origin::default().to(origin, ratio);
            frame.origin.x.0 += offset.x;
            frame.origin.y.0 += offset.y;
        }
        if self.nodes[key as usize].follow.is_some() {
            // Its frame along the main axis is the element's it follows,
            // laid out by now or not: placed once every frame is out.
            let column = self.layout.parent(layout).is_some_and(|p| {
                let style = self.layout.style(p);
                style.display == taffy::Display::Flex
                    && matches!(
                        style.flex_direction,
                        taffy::FlexDirection::Column | taffy::FlexDirection::ColumnReverse
                    )
            });
            let m = unrounded.margin;
            let margins = if column {
                (round(m.top, ratio.height), round(m.bottom, ratio.height))
            } else {
                (round(m.left, ratio.width), round(m.right, ratio.width))
            };
            self.laid_follower(key, Some(frame), column, margins);
        } else {
            self.set_frame(key, frame);
        }
        self.sync_cell_border(key, &unrounded);
        let kind = self.nodes[key as usize].kind;
        if kind == Kind::Input {
            let content = content_box(&l);
            let node = &mut self.nodes[key as usize];
            let input = node.input.as_mut().expect("input state");
            if input.content != Some(content) {
                input.content = Some(content);
                self.mount.push(MountItem::InputContent {
                    id: node.id,
                    content,
                });
            }
            if node.events.contains(EventKind::ContentSizeChange) {
                self.report_content_size(key, content.size.width.0);
            }
        }
        if kind == Kind::Scroll {
            self.set_scroll_content(key, scroll_extent(&l));
        }
        // List cells are positioned by `update_lists`, roots by
        // `layout_roots`.
        let mut escapes = escaping;
        if kind.is_container() && kind != Kind::List {
            let children = std::mem::take(&mut self.nodes[key as usize].children);
            for &child in &children {
                if !self.nodes[child as usize].is_layout_root() {
                    self.emit_frames_in(child, false, inner);
                    escapes |= self.nodes[child as usize].escapes;
                }
            }
            self.nodes[key as usize].children = children;
            self.update_overflow(key);
        }
        let node = &mut self.nodes[key as usize];
        node.escapes = escapes;
        node.emitted = Some((origin, ratio));
    }

    /// In a terminal, mounts node `key` without the borders its layout
    /// `l` gives no Cell (`Node::cell_border`), again when that changes;
    /// off a terminal, with its borders as styled again.
    fn sync_cell_border(&mut self, key: Key, l: &taffy::Layout) {
        let w = self.nodes[key as usize].view_style.borders.widths;
        let styled = [w.top, w.right, w.bottom, w.left]
            .iter()
            .any(|&v| v > Points::ZERO);
        // Only a bordered view's style changes.
        let sides = self.layout.grid().filter(|_| styled).map(|_| {
            let b = l.border;
            [b.top, b.right, b.bottom, b.left]
                .iter()
                .enumerate()
                .fold(0u8, |m, (bit, &v)| m | (u8::from(v > 0.0) << bit))
        });
        let node = &mut self.nodes[key as usize];
        if node.cell_border == sides {
            return;
        }
        node.cell_border = sides;
        let id = node.id;
        let style = self.mounted_view_style(key);
        self.mount.push(MountItem::ViewStyle { id, style });
    }

    /// Queues node `key`'s frame for its layout listeners once it was laid
    /// out: a listener added after layout still learns the frame.
    fn report_frame(&mut self, key: Key) {
        let node = &self.nodes[key as usize];
        if !node.frame.origin.x.0.is_nan() {
            self.events.push(crate::element::JsEvent::Event(
                node.id,
                EventKind::Layout,
                EventPayload::Layout(node.frame),
            ));
        }
    }

    fn set_frame(&mut self, key: Key, frame: Bounds<Points>) {
        let node = &mut self.nodes[key as usize];
        if node.frame != frame {
            let resized = node.frame.size != frame.size;
            node.frame = frame;
            self.note_resized(key, resized);
            // What views follow may have moved.
            self.follow_changed |= !self.followers.is_empty();
            let node = &self.nodes[key as usize];
            let (id, is_text) = (node.id, node.kind == Kind::Text);
            if node.events.contains(EventKind::Layout) {
                self.events.push(crate::element::JsEvent::Event(
                    id,
                    EventKind::Layout,
                    EventPayload::Layout(frame),
                ));
            }
            if node.created {
                self.mount.push(MountItem::Frame { id, frame });
            }
            let node = &self.nodes[key as usize];
            // A list's cell moved: the logical order goes by where cells are.
            if self.track_tree_order
                && node.parent != NO_KEY
                && self.nodes[node.parent as usize].list.is_some()
            {
                self.tree_order_changed = true;
            }
            let node = &self.nodes[key as usize];
            // Translations by a fraction of the size follow it, and so does
            // the perspective of its parent, seen from the parent's center.
            let parent_perspective = self.perspective_steps(key) > 0;
            if node.created && (node.view_style.transform.has_fractions() || parent_perspective) {
                let style = self.mounted_view_style(key);
                self.mount.push(MountItem::ViewStyle { id, style });
            }
            if node.child_perspective.is_some() {
                // Its center moved for its children.
                let children = node.children.clone();
                for c in children {
                    self.mark(c, dirty::VIEW);
                }
            }
            if is_text {
                self.queue_text(key);
            }
            // A view box fits into the new size.
            let node = &self.nodes[key as usize];
            if node.kind == Kind::Canvas && node.drawing.as_ref().is_some_and(|d| d.fit().is_some())
            {
                self.fitted_pending.push(key);
            }
        }
    }

    fn set_scroll_content(&mut self, key: Key, size: Size<Points>) {
        let node = &mut self.nodes[key as usize];
        let (id, rtl, kind, viewport) = (node.id, node.rtl, node.kind, node.frame.size.width.0);
        if let Some(scroll) = node.scroll.as_mut()
            && scroll.content != Some(size)
        {
            let old = scroll.content.replace(size);
            // Items are only inserted before it since (a `ScrollBy`, the
            // layout animation), so it is at its index or later.
            let batch = self.batches;
            let queued = scroll
                .content_item
                .filter(|&(b, _)| b == batch)
                .and_then(|(_, i)| {
                    let at = self.mount.get(i..)?.iter().position(
                        |m| matches!(m, MountItem::ScrollContent { id: queued, .. } if *queued == id),
                    )?;
                    Some(i + at)
                });
            // A shrink after a scroll must keep the earlier extent until
            // that scroll has applied. Growth can replace the extent once.
            let shrunk = old.is_some_and(|old| {
                if scroll.horizontal {
                    size.width < old.width
                } else {
                    size.height < old.height
                }
            });
            let keep_earlier = shrunk
                && queued.is_some_and(|j| {
                    self.mount[j + 1..].iter().any(|item| match item {
                        MountItem::ScrollBy {
                            id: scrolled,
                            dx,
                            dy,
                        } => *scrolled == id && (dx.0 != 0.0 || dy.0 != 0.0),
                        MountItem::Command {
                            id: scrolled,
                            command: Command::ScrollTo { .. },
                        } => *scrolled == id,
                        _ => false,
                    })
                });
            if let Some(j) = queued
                && !keep_earlier
            {
                self.mount[j] = MountItem::ScrollContent { id, size };
            }
            if queued.is_none() || keep_earlier {
                scroll.content_item = Some((batch, self.mount.len()));
                self.mount.push(MountItem::ScrollContent { id, size });
            }
            // Right to left, a horizontal scroll view starts at its right
            // end and keeps its distance from it as the content changes.
            if kind == Kind::Scroll && scroll.horizontal && rtl {
                match old {
                    None => self.commands.push((
                        id,
                        Command::ScrollTo {
                            x: (size.width - Points(viewport)).max(Points::ZERO),
                            y: Points::ZERO,
                            animated: false,
                        },
                    )),
                    Some(old) if old.width != size.width => {
                        let dx = size.width - old.width;
                        self.mount.push(MountItem::ScrollBy {
                            id,
                            dx,
                            dy: Points::ZERO,
                        });
                        self.scroll_issued(key, PendingScroll::By(dx.0));
                    }
                    Some(_) => {}
                }
            }
        }
    }

    /// Merge relative corrections across list layout rounds. An explicit
    /// position command starts a new sequence of corrections.
    fn retract_list_scroll(&mut self, key: Key) -> Option<f32> {
        let node = &mut self.nodes[key as usize];
        let id = node.id;
        node.scroll
            .as_ref()?
            .anchor_geometry
            .filter(|&(batch, _, _)| batch == self.batches)?;
        let item = self.mount.iter_mut().rev().find(|item| match item {
            MountItem::ScrollBy { id: target, dx, dy } => {
                *target == id && (dx.0 != 0.0 || dy.0 != 0.0)
            }
            MountItem::Command {
                id: target,
                command: Command::ScrollTo { .. },
            } => *target == id,
            _ => false,
        })?;
        let MountItem::ScrollBy { dx, dy, .. } = item else {
            return None;
        };
        let previous = node.list.as_mut()?.retract_scroll_by()?;
        *dx = Points::ZERO;
        *dy = Points::ZERO;
        self.retracted_list_scroll = true;
        Some(previous)
    }

    /// Measures rendered cells, keeps the visible content anchored, picks
    /// the items to render and positions the cells of every list.
    fn update_lists(&mut self, relayout: bool) {
        // Source providers must already have their logical reader while its
        // own window is updated, even before a new parent list is measured.
        if self.outer_moved {
            self.resolve_outer();
        }
        // A cell measured before JS's render of its content arrives would
        // record the size of its empty placeholders.
        let mut awaiting = std::mem::take(&mut self.awaiting_renders);
        self.cells_awaiting_renders(&mut awaiting);
        self.awaiting_renders = awaiting;
        let mut settle_pins = Vec::new();
        for i in 0..self.lists.len() {
            let key = self.lists[i];
            let id = self.nodes[key as usize].id;
            let automatic = self.commands.iter().any(|(target, command)| {
                *target == id
                    && matches!(
                        command,
                        Command::ScrollToIndex {
                            automatic: true,
                            ..
                        }
                    )
            });
            if automatic
                && !self.nodes[key as usize]
                    .list
                    .as_ref()
                    .expect("list")
                    .automatic
            {
                self.nodes[key as usize]
                    .list
                    .as_mut()
                    .expect("list")
                    .automatic = true;
                // Request an initial snapshot even when styles already track these bits.
                let tracked = self.nodes[key as usize].tracked;
                self.update_tracking(key);
                if self.nodes[key as usize].created && self.nodes[key as usize].tracked == tracked {
                    self.mount.push(MountItem::TrackStates {
                        id,
                        states: self.nodes[key as usize].tracked,
                    });
                }
            }
            // Lists in their parent's viewport come after, outer ones first.
            if self.nodes[key as usize]
                .list
                .as_ref()
                .is_some_and(|l| l.parent)
            {
                continue;
            }
            if self.update_list(key, relayout, None) {
                settle_pins.push(key);
            }
        }
        if !self.parent_lists.is_empty() {
            for i in 0..self.parent_lists.len() {
                let key = self.parent_lists[i];
                if !self.nodes[key as usize].created {
                    continue;
                }
                // Out of the tree, or not placed yet.
                let Some(outer) = self.outer_input(key) else {
                    continue;
                };
                if self.update_list(key, relayout, Some(outer)) {
                    settle_pins.push(key);
                }
                if self.nodes[outer.view as usize]
                    .list
                    .as_ref()
                    .is_some_and(|l| l.can_settle_pin())
                    && !settle_pins.contains(&outer.view)
                {
                    settle_pins.push(outer.view);
                }
            }
        }
        for key in settle_pins {
            if !self.needs_layout
                && !self.extent_changed
                && self.list_viewport_settled(key)
                && let Some(list) = self.nodes[key as usize].list.as_mut()
            {
                list.unpin();
            }
        }
        if !self.sticky_nodes.is_empty()
            || !self.sticky_scrollers.is_empty()
            || !self.decorated.is_empty()
        {
            self.update_sticky_views(relayout);
        }
        if !self.sticky_views.is_empty() {
            self.send_page_sticky();
        }
    }

    /// Hides the attachments of text `key` (views and images inside it) that
    /// are inside a hidden span, `hidden` when `key` is one, and shows the
    /// others: nothing of a hidden span is drawn or takes presses.
    fn hide_attachments(&mut self, key: Key, hidden: bool) {
        let count = self.nodes[key as usize].children.len();
        for i in 0..count {
            let c = self.nodes[key as usize].children[i];
            let child = &self.nodes[c as usize];
            if child.is_overlay() {
                continue;
            }
            match child.kind {
                Kind::RawText | Kind::Overlay => {}
                Kind::Text => {
                    let hidden = hidden || child.view_style.hidden;
                    self.hide_attachments(c, hidden);
                }
                _ if child.layout.is_some() => self.set_hidden_in_text(c, hidden),
                _ => {}
            }
        }
    }

    /// Hides attachment `key` with the hidden span it is in, or shows it
    /// again; sent at once, as [`Core::set_spare`].
    fn set_hidden_in_text(&mut self, key: Key, hidden: bool) {
        let node = &mut self.nodes[key as usize];
        if node.hidden_in_text == hidden {
            return;
        }
        node.hidden_in_text = hidden;
        if !node.created {
            // Its new view gets both (`ensure_created`).
            return;
        }
        let (id, props) = (node.id, node.mounted_props());
        let style = self.mounted_view_style(key);
        self.mount.push(MountItem::ViewStyle { id, style });
        self.mount.push(MountItem::ViewProps { id, props });
    }

    /// Hides list cell `key`, which has no item but still shows its last
    /// row (`visibility: hidden` and `accessibilityElementsHidden`), or
    /// shows it again as its list places it. Sent at once: this round's
    /// dirty flags were flushed before the lists' update.
    fn set_spare(&mut self, key: Key, spare: bool) {
        let node = &mut self.nodes[key as usize];
        if node.spare == spare {
            return;
        }
        node.spare = spare;
        // A spare cell shows no row for views to follow (`follow.rs`).
        self.follow_changed |= !self.followers.is_empty();
        let node = &self.nodes[key as usize];
        if !node.created {
            // Its new view gets both (`ensure_created`).
            return;
        }
        let (id, props) = (node.id, node.mounted_props());
        let style = self.mounted_view_style(key);
        self.mount.push(MountItem::ViewStyle { id, style });
        self.mount.push(MountItem::ViewProps { id, props });
    }

    /// Hides list cell `key`, which the render window left behind, from
    /// assistive technology, or reads it again as its list places it: its
    /// frame is where its row was laid out last, which rows measured since
    /// may have moved past. Its props only: it stays drawn, out of sight.
    fn set_left_behind(&mut self, key: Key, left_behind: bool) {
        let node = &mut self.nodes[key as usize];
        if node.left_behind == left_behind {
            return;
        }
        node.left_behind = left_behind;
        if !node.created || node.spare {
            // Its new view gets them (`ensure_created`), or `set_spare`
            // sends them as it shows the cell again.
            return;
        }
        let (id, props) = (node.id, node.mounted_props());
        self.mount.push(MountItem::ViewProps { id, props });
    }

    /// [`Core::update_lists`] for list `key`; `outer`: where a list in its
    /// parent's viewport is in the view it is virtualized against.
    fn update_list(
        &mut self,
        key: Key,
        relayout: bool,
        outer: Option<parent_viewport::OuterInput>,
    ) -> bool {
        let moved = match &outer {
            Some(o) => self.nodes[key as usize]
                .list
                .as_mut()
                .expect("list")
                .set_outer(o.start, o.offset, o.viewport, o.max, o.settled),
            None => false,
        };
        let node = &self.nodes[key as usize];
        if !node.created {
            return false;
        }
        let list = node.list.as_ref().expect("list");
        if !(relayout || moved || list.dirty || self.commands.iter().any(|c| c.0 == node.id)) {
            return false;
        }
        let list_hidden = self.displays_none(key);
        let (id, events) = (node.id, node.events);
        let horizontal = list.horizontal;
        let scroll = node.scroll.as_ref().expect("list scroll");
        let zoom = scroll.zoom;
        let inset = scroll.behavior.content_inset;
        let (leading, trailing) = if horizontal {
            (inset.left.0, inset.right.0)
        } else {
            (inset.top.0, inset.bottom.0)
        };
        let l = self.rounded_layout(node.layout.expect("list layout"));
        let (main, cross) = match &outer {
            // The view's viewport, and the list's content box across.
            Some(o) => (o.viewport, o.cross),
            None if horizontal => (l.size.width, l.size.height),
            None => (l.size.height, l.size.width),
        };
        let main_of = |s: taffy::Size<f32>| if horizontal { s.width } else { s.height };

        // Sizes of cells showing their item, and of the extras.
        let mut ready = std::mem::take(&mut self.cells_scratch);
        ready.clear();
        ready.extend(
            list.slots
                .iter()
                .filter_map(|s| s.ready().map(|i| (i, s.cell))),
        );
        if outer.is_some() || !scroll.dependents.is_empty() {
            ready.sort_unstable_by_key(|&(index, _)| index);
        }
        let extras = list.extras;
        // An inverted list that loads at its start keeps its rows in
        // place when scrolled away from it (`keeps_visible_rows`).
        self.nodes[key as usize]
            .list
            .as_mut()
            .expect("list")
            .loads_at_start = events.contains(EventKind::LoadMoreAtStart);
        let mut extents_changed = false;
        let measure_extra = |core: &mut Self, kind: ExtraKind, extents_changed: &mut bool| {
            let extra = extras[kind as usize];
            if core.awaiting_renders.binary_search(&extra.cell).is_ok() {
                return 0.0;
            }
            let Some(layout) = core
                .nodes
                .get(extra.cell as usize)
                .and_then(|cell| cell.layout)
            else {
                return 0.0;
            };
            let size = main_of(core.rounded_layout(layout).size);
            *extents_changed |= extra.size != size;
            core.nodes[key as usize]
                .list
                .as_mut()
                .expect("list")
                .measured_extra(kind, size)
        };
        let mut anchor = measure_extra(self, ExtraKind::Header, &mut extents_changed);
        for &(index, cell) in &ready {
            // Waiting for JS's render: it keeps its estimate (or the size
            // measured last) until the holder arrives and lays it out
            // again. A list in a view sized by its content would otherwise
            // shrink to nothing and leave no row in its window to render.
            if self.awaiting_renders.binary_search(&cell).is_ok() {
                continue;
            }
            if let Some(cell_layout) = self.nodes.get(cell as usize).and_then(|c| c.layout) {
                let size = main_of(self.rounded_layout(cell_layout).size);
                let list = self.nodes[key as usize].list.as_mut().expect("list");
                extents_changed |= !list.source_row_matches_layout(index, size);
                anchor += list.measured(index, size);
            }
        }
        anchor += measure_extra(self, ExtraKind::Empty, &mut extents_changed);
        anchor += measure_extra(self, ExtraKind::Footer, &mut extents_changed);

        // Its own scroll view's range takes the content inset in; in its
        // parent's viewport, the view around it has the range.
        let inset = match (&outer, self.nodes[key as usize].scroll.as_deref()) {
            (None, Some(scroll)) => {
                let i = scroll.behavior.content_inset;
                if horizontal {
                    (i.left.0, i.right.0)
                } else {
                    (i.top.0, i.bottom.0)
                }
            }
            _ => (0.0, 0.0),
        };
        let list = self.nodes[key as usize].list.as_mut().expect("list");
        // Not on the first layout: there is nothing to clamp yet.
        let grew = outer.is_none() && list.viewport > 0.0 && main > list.viewport;
        list.viewport = main;
        list.inset = inset;
        list.offset += anchor;
        // A splice above the viewport already moved the offset, to keep
        // the visible rows in place: like measurements, that says nothing
        // about where the user is.
        let spliced = list.take_splice_anchor();
        anchor += spliced;
        if outer.is_none() {
            let maximum = (list.content_len() * zoom - main + trailing).max(-leading);
            list.predict_clamp(maximum);
        }
        let kept = anchor;
        // A row growing under its own layout animation (a reveal) moves
        // the end while its frames slide: a scroll to the new end would
        // land at once, ahead of them, so the list keeps its place.
        let revealing = !self.scoped_layout.is_empty() && {
            let scoped = &self.scoped_layout;
            scoped.iter().any(|&(scope, ..)| {
                self.key(scope)
                    .is_ok_and(|k| k != key && self.is_within(k, key))
            })
        };
        let list = self.nodes[key as usize].list.as_mut().expect("list");
        list.revealing = revealing;
        // Inverted lists keep their distance from the end instead;
        // `maintainVisibleContentPosition` follows the end near it.
        anchor += list.anchor_end(kept);
        let parent_cell_relaid = outer.is_some()
            && !self.source_texts.is_empty()
            && extras
                .iter()
                .filter_map(|e| (e.cell != NO_KEY).then_some(e.cell))
                .chain(ready.iter().map(|&(_, cell)| cell))
                .any(|cell| {
                    self.nodes
                        .get(cell as usize)
                        .is_some_and(|node| node.relaid)
                });
        let explicit = self.nodes[key as usize]
            .scroll
            .as_ref()
            .and_then(|scroll| scroll.asked.as_ref())
            .is_some_and(|asked| asked.to.is_some())
            || self.commands.iter().any(|(target, command)| {
                *target == id
                    && matches!(
                        command,
                        Command::ScrollTo { .. }
                            | Command::ScrollToIndex { .. }
                            | Command::ScrollToEnd { .. }
                    )
            });
        let source_position = self.nodes[key as usize]
            .list
            .as_ref()
            .and_then(|list| list.reading_point().cloned())
            .map(|point| self.reading_position(key, &point));
        let list = self.nodes[key as usize].list.as_mut().expect("list");
        anchor += list.anchor_source(explicit, anchor, source_position);
        // The last scroll command's target moves as its cells are
        // measured: the list follows it.
        let mut retarget = None;
        let (follow, mut check_settle) = self.nodes[key as usize]
            .list
            .as_mut()
            .expect("list")
            .follow_pin_step(anchor);
        match follow {
            Follow::Stay => {}
            Follow::By(delta) => anchor += delta,
            Follow::To { offset, animated } => retarget = Some((offset, animated)),
        }

        // The End key's commands, if any, are resolved below with the
        // rest (`Core::key_scrolled`).
        let list = self.nodes[key as usize].list.as_mut().expect("list");
        list.key_ends.clear();
        // Scroll commands for the list, now that sizes are known: the
        // window follows a jump in this same commit. In its parent's
        // viewport, the view around it scrolls instead.
        let mut outer_to = None;
        for (target, command) in &mut self.commands {
            if *target != id {
                continue;
            }
            let list = self.nodes[key as usize].list.as_mut().expect("list");
            let (pin, animated, automatic) = match *command {
                Command::ScrollToIndex {
                    index,
                    animated,
                    automatic,
                    view_position,
                    view_offset,
                } => (
                    Some(PinTarget::Index {
                        index,
                        view_position: view_position.0,
                        view_offset: view_offset.0,
                    }),
                    animated,
                    automatic,
                ),
                Command::ScrollToEnd { animated } => (Some(PinTarget::End), animated, false),
                Command::ScrollTo { animated, .. } => (None, animated, false),
                _ => continue,
            };
            let offset = match (pin, &*command) {
                (Some(pin), _) => list.target_offset(pin),
                (None, &Command::ScrollTo { x, y, .. }) => {
                    let offset = if horizontal { x.0 } else { y.0 };
                    if outer.is_some() {
                        list.clamped(offset)
                    } else {
                        offset
                    }
                }
                _ => continue,
            };
            if automatic && !list.idle() {
                list.wait_for_idle(pin.expect("automatic index target"), animated);
                check_settle = false;
                retarget = None;
                continue;
            }
            // An offset of the app's own ends the pin.
            list.pin(pin, offset, animated, automatic);
            check_settle = false;
            // A new command replaces the pin's retargeting.
            retarget = None;
            if !animated {
                list.jump(offset);
            }
            if let Some(o) = &outer {
                outer_to = Some((o.start + offset, animated));
                continue;
            }
            list.issue_scroll_to(offset);
            let (x, y) = if horizontal {
                (Points(offset), Points::ZERO)
            } else {
                (Points::ZERO, Points(offset))
            };
            *command = Command::ScrollTo { x, y, animated };
        }
        if outer.is_some() {
            // Sent to the view around the list instead, or kept in the
            // automatic target pin until interaction ends.
            self.commands.retain(|(target, command)| {
                *target != id
                    || !matches!(
                        command,
                        Command::ScrollTo { .. }
                            | Command::ScrollToIndex { .. }
                            | Command::ScrollToEnd { .. }
                    )
            });
        }
        if let (Some((offset, animated)), Some(o)) = (retarget, &outer) {
            outer_to = Some((o.start + offset, animated));
        } else if let Some((offset, animated)) = retarget {
            self.nodes[key as usize]
                .list
                .as_mut()
                .expect("list")
                .issue_scroll_to(offset);
            let (x, y) = if horizontal {
                (Points(offset), Points::ZERO)
            } else {
                (Points::ZERO, Points(offset))
            };
            let command = Command::ScrollTo { x, y, animated };
            self.commands.push((id, command));
        }

        // The components' own lists bind in the core, at once; the
        // runtime's pace their overscan.
        let paced = !self.components.is_virtual_list(id);
        let source_row = self.reading_row(key);
        let list = self.nodes[key as usize].list.as_mut().expect("list");
        list.paced = paced;
        let mut binds = Vec::new();
        let edges = list.update_window(&mut binds, source_row);
        if edges.end {
            self.events.push(crate::element::JsEvent::Event(
                id,
                EventKind::LoadMore,
                EventPayload::None,
            ));
        }
        if edges.start && events.contains(EventKind::LoadMoreAtStart) {
            self.events.push(crate::element::JsEvent::Event(
                id,
                EventKind::LoadMoreAtStart,
                EventPayload::None,
            ));
        }
        if !binds.is_empty() {
            self.list_binds.push(ListBind { list: id, binds });
        }
        if list.paced && list.has_paced() && !self.paced_lists.contains(&id) {
            self.paced_lists.push(id);
        }
        if events.contains(EventKind::ViewableItemsChange) {
            let viewable = list.viewable_items();
            if viewable != list.viewable {
                list.viewable = viewable;
                let (first, last) = viewable.map_or((-1.0, -1.0), |(f, l)| (f as f64, l as f64));
                self.events.push(crate::element::JsEvent::Event(
                    id,
                    EventKind::ViewableItemsChange,
                    EventPayload::Map(vec![
                        ("first", PayloadValue::Number(first)),
                        ("last", PayloadValue::Number(last)),
                    ]),
                ));
            }
        }

        let parent_offsets_changed = std::mem::take(
            &mut self.nodes[key as usize]
                .list
                .as_mut()
                .expect("list")
                .parent_offsets_changed,
        );
        if !self.source_texts.is_empty() {
            let range = {
                let list = self.nodes[key as usize].list.as_ref().expect("list");
                list.wants_reading_pin(explicit, list.content_len())
            };
            if let Some((start, end)) = range
                && let Some((point, y)) = self.first_visible_source(key, start, end, true)
            {
                self.nodes[key as usize]
                    .list
                    .as_mut()
                    .expect("list")
                    .set_reading_pin(point, y);
            }
        }

        // Position cells that show their item (the window may have
        // changed which ones). Descendant frames only change when the
        // cell was laid out again.
        let list = self.nodes[key as usize].list.as_ref().expect("list");
        let sticky = list.sticky_enabled();
        ready.clear();
        ready.extend(
            list.slots
                .iter()
                .filter_map(|s| s.ready().map(|i| (i, s.cell))),
        );
        // A cell bound just now to the row it already shows (it took it
        // back after the items changed) gets no render to lay it out
        // again, and was not ready when the list measured above: measured
        // now, the rows after it are placed after its real size.
        for &(index, cell) in &ready {
            if self.awaiting_renders.binary_search(&cell).is_ok() {
                continue;
            }
            if let Some(cell_layout) = self.nodes.get(cell as usize).and_then(|c| c.layout) {
                let size = main_of(self.rounded_layout(cell_layout).size);
                let list = self.nodes[key as usize].list.as_mut().expect("list");
                list.measured_unknown(index, size);
            }
        }
        let list = self.nodes[key as usize].list.as_ref().expect("list");
        let content_len = list.content_len();
        let blocks = list.blocks();
        // Cells left without an item, or not showing theirs yet (a paced
        // bind, or one the frame's rounds did not reach), still show their
        // last one. Those in the render window (the data changed, the list
        // jumped) would show through: move them out of sight. They, the ones
        // never placed and, once the items changed, all of them are hidden
        // until placed again ([`Core::set_spare`]); the few the window leaves
        // behind while scrolling are out of sight already and soon reused,
        // so they stay drawn, but screen readers skip them: they would read
        // rows out of the window, by frames rows measured since may have
        // passed ([`Core::set_left_behind`]).
        let (window_start, window_end) = list.render_window();
        let motion = outer.is_none() && self.list_motion.active();
        if motion {
            let cells: Vec<Key> = list
                .slots
                .iter()
                .map(|s| s.cell)
                .chain(list.extras.iter().map(|e| e.cell))
                .collect();
            self.note_cell_starts(cells);
        }
        let list = self.nodes[key as usize].list.as_ref().expect("list");
        // In its parent's viewport, the cells start inside the list's
        // border and padding.
        let inset = outer.map_or((0.0, 0.0), |o| o.inset);
        let unbound: Vec<Key> = list
            .slots
            .iter()
            .filter(|s| s.ready().is_none() && s.cell != u32::MAX)
            .map(|s| s.cell)
            .collect();
        let changed = std::mem::take(
            &mut self.nodes[key as usize]
                .list
                .as_mut()
                .expect("list")
                .items_changed,
        );
        for cell in unbound {
            if list_hidden {
                self.set_spare(cell, true);
                self.emit_frames(cell);
                continue;
            }
            let frame = self.nodes[cell as usize].frame;
            if frame.size.width.0.is_nan() {
                // Never placed: nowhere to move it from.
                self.set_spare(cell, true);
                continue;
            }
            let (start, size) = if horizontal {
                (frame.origin.x.0 - inset.0, frame.size.width.0)
            } else {
                (frame.origin.y.0 - inset.0, frame.size.height.0)
            };
            if start + size <= window_start || start >= window_end {
                if changed {
                    self.set_spare(cell, true);
                } else {
                    self.set_left_behind(cell, true);
                }
                continue;
            }
            self.set_spare(cell, true);
            let away = if horizontal {
                Bounds {
                    origin: Point::new(Points(-HIDDEN), frame.origin.y),
                    ..frame
                }
            } else {
                Bounds {
                    origin: Point::new(frame.origin.x, Points(-HIDDEN)),
                    ..frame
                }
            };
            if frame != away {
                self.set_frame(cell, away);
                self.nodes[key as usize]
                    .list
                    .as_mut()
                    .expect("list")
                    .unplace(cell);
            }
        }
        let mut sticky_cells = Vec::new();
        let place = |this: &mut Self, cell: Key, at: f32, row: f32, (x, width): (f32, f32)| {
            let cell_layout = this.nodes.get(cell as usize).and_then(|c| c.layout)?;
            let size = this.rounded_layout(cell_layout).size;
            // Keep bindings and scroll requests alive while hidden, without
            // overwriting empty frames or consuming pending descendants.
            if list_hidden {
                this.emit_frames(cell);
                return Some(main_of(size));
            }
            let list = this.nodes[key as usize].list.as_ref().expect("list");
            let mut main_at = list.to_content(at, row.max(main_of(size)));
            let mut x = x;
            if outer.is_some() {
                main_at += inset.0;
                x += inset.1;
            }
            let cell_cross = if horizontal { size.height } else { size.width };
            x = list.align_cross(x, width, cell_cross);
            let frame = if horizontal {
                rect(main_at, x, size.width, cell_cross)
            } else {
                rect(x, main_at, cell_cross, size.height)
            };
            this.set_frame(cell, frame);
            this.set_left_behind(cell, false);
            this.set_spare(cell, false);
            if std::mem::take(&mut this.nodes[cell as usize].relaid) {
                // A cell that waits to be made (`pace.rs`) made none of
                // its views: they wait with it, placed as culled views
                // are, so the ones that show are made when the cell is,
                // not behind every view that waits out of sight.
                let waits = {
                    let node = &this.nodes[cell as usize];
                    !node.created && node.culled
                };
                let children = std::mem::take(&mut this.nodes[cell as usize].children);
                for &child in &children {
                    if waits {
                        let node = &mut this.nodes[child as usize];
                        if !node.created && !node.is_layout_root() {
                            node.culled = true;
                        }
                    }
                    this.emit_frames(child);
                }
                this.nodes[cell as usize].children = children;
                this.update_overflow(cell);
                this.cells_framed = true;
            }
            Some(main_of(size))
        };
        // In a terminal the columns are whole Cells of the width the cells
        // were laid out at (`layout_cells`: without the scroll bar's
        // column).
        let unit = self
            .layout
            .grid()
            .map(|g| if horizontal { g.height } else { g.width });
        let columns_cross = {
            let laid = self.nodes[key as usize]
                .list
                .as_ref()
                .expect("list")
                .cells_cross;
            if unit.is_some() && laid.is_finite() {
                laid
            } else {
                cross
            }
        };
        let mut placed = list_motion::Placed::default();
        for &(index, cell) in &ready {
            let list = self.nodes[key as usize].list.as_ref().expect("list");
            let (at, row) = (list.item_at(index), list.row_extent(index));
            let column = list.column(columns_cross, list.column_of(index), unit);
            let Some(size) = place(self, cell, at, row, column) else {
                continue;
            };
            let list = self.nodes[key as usize].list.as_mut().expect("list");
            if list.place(index) {
                placed.new.push(cell);
            } else {
                placed.kept.push(cell);
            }
            let list = self.nodes[key as usize].list.as_ref().expect("list");
            if sticky && list.sticky.binary_search(&index).is_ok() {
                let range = list.sticky_range(index, self.nodes[cell as usize].id, size);
                sticky_cells.push(range);
            }
        }
        let full = self.nodes[key as usize]
            .list
            .as_ref()
            .expect("list")
            .full_width(columns_cross);
        for (extra, at) in extras
            .iter()
            .zip([blocks.header, blocks.footer, blocks.body])
        {
            if extra.cell != u32::MAX && place(self, extra.cell, at, 0.0, full).is_some() {
                placed.kept.push(extra.cell);
            }
        }
        self.cells_scratch = ready;

        sticky_cells.sort_by_key(|c| c.cell);
        let list = self.nodes[key as usize].list.as_mut().expect("list");
        if let Some(o) = &outer {
            // The view around the list pins them, with its other lists'.
            if sticky_cells != list.sent_sticky {
                let old = std::mem::replace(&mut list.sent_sticky, sticky_cells);
                self.page_sticky_changed(key, o.view, &old);
            }
        } else if sticky_cells != list.sent_sticky {
            // Sent at the end of the commit in one set with the other
            // views it pins (its built-in bar, its sticky views, its lists'
            // rows in its viewport): a set of its rows alone would drop the
            // others and raise its rows above its bar.
            list.sent_sticky = sticky_cells;
            self.sticky_views.push(key);
        }

        if let Some(o) = &outer {
            // The owner was indexed before these rows were measured. Opposite
            // extent changes can move its source lines without resizing the
            // spacer; reconcile that geometry in the same settling round.
            let parent = self.nodes[key as usize].parent;
            if extents_changed {
                if let Some(owner) = self.nodes[o.view as usize].list.as_mut() {
                    owner.dirty = true;
                    self.extent_changed = true;
                } else if self.mark_enclosing_reader_dirty(parent, true) {
                    self.extent_changed = true;
                }
            } else if (parent_offsets_changed || parent_cell_relaid)
                && (!self.source_texts.is_empty() || !self.source_providers.is_empty())
                && self.mark_enclosing_reader_dirty(parent, true)
            {
                self.extent_changed = true;
            }
            // The view around the list scrolls (the commit sends it at
            // its end; a scroll to an offset after the anchoring, which
            // it supersedes), and the list takes its new length in layout.
            if anchor != 0.0 {
                self.forward_outer_anchor(key, *o, anchor);
            }
            if outer_to.is_some() {
                self.ask_outer(o.view, outer_to, 0.0);
            }
            self.sync_spacer(key, false);
            return check_settle;
        }
        let content = if horizontal {
            size_pt(content_len, cross)
        } else {
            size_pt(cross, content_len)
        };
        // Platforms clamp the offset to the content: grow the content
        // before scrolling, scroll before shrinking it.
        let mut old_len = self.nodes[key as usize]
            .scroll
            .as_ref()
            .and_then(|s| s.content)
            .map_or(0.0, |c| if horizontal { c.width.0 } else { c.height.0 });
        let mut grew = grew;
        if anchor != 0.0 {
            let previous = self.retract_list_scroll(key);
            let node = &mut self.nodes[key as usize];
            let scroll = node.scroll.as_mut().expect("list scroll");
            if let (Some(previous), Some((_, extent, prior_growth))) =
                (previous, scroll.anchor_geometry)
            {
                anchor += previous;
                old_len = extent;
                grew |= prior_growth;
            }
            scroll.anchor_geometry = Some((self.batches, old_len, grew));
        }
        if anchor != 0.0 {
            self.nodes[key as usize]
                .list
                .as_mut()
                .expect("list")
                .issue_scroll_by(anchor);
        }
        let scroll_by = (anchor != 0.0).then(|| {
            let (dx, dy) = if horizontal {
                (Points(anchor), Points::ZERO)
            } else {
                (Points::ZERO, Points(anchor))
            };
            MountItem::ScrollBy { id, dx, dy }
        });
        // Platforms clamp the offset to the content and the viewport:
        // scroll before the viewport grows or the content shrinks, and
        // after the content grows (a shrinking viewport's frame comes
        // first anyway).
        let frame_at = grew
            .then(|| {
                self.mount
                    .iter()
                    .position(|m| matches!(m, MountItem::Frame { id: f, .. } if *f == id))
            })
            .flatten();
        match (scroll_by, frame_at) {
            // The viewport and the content both grow (rows arriving as a
            // placeholder beside the list goes away): the content first,
            // then the scroll, then the frame. A frame grown over the old
            // content clamps the scroll back to its start.
            (Some(item), Some(at)) if content_len > old_len => {
                self.set_scroll_content(key, content);
                match self
                    .mount
                    .iter()
                    .rposition(|m| matches!(m, MountItem::ScrollContent { id: c, .. } if *c == id))
                {
                    Some(queued) if queued > at => {
                        let grown = self.mount.remove(queued);
                        self.mount.insert(at, grown);
                        self.mount.insert(at + 1, item);
                    }
                    _ => self.mount.insert(at, item),
                }
            }
            (Some(item), Some(at)) => {
                self.mount.insert(at, item);
                self.set_scroll_content(key, content);
            }
            (Some(item), None) if content_len < old_len => {
                self.set_scroll_content(key, content);
                if let Some(at) = self.scroll_content_position(key) {
                    self.mount.insert(at, item);
                } else {
                    self.mount.push(item);
                }
            }
            (item, _) => {
                self.set_scroll_content(key, content);
                self.mount.extend(item);
            }
        }
        if motion {
            self.move_list_cells(key, id, horizontal, anchor, placed);
        }
        check_settle
    }

    fn list_cells_settled(&self, list: &ListState) -> bool {
        let Some((first, last)) = list.viewport_items() else {
            return true;
        };
        for i in first..=last {
            if !list.item_measured(i) {
                return false;
            }
            let Some(cell) = list.ready_cell(i) else {
                return false;
            };
            if self.awaiting_renders.binary_search(&cell).is_ok() {
                return false;
            }
            if self.nodes[cell as usize]
                .layout
                .is_some_and(|layout| self.layout.dirty(layout))
            {
                return false;
            }
        }
        true
    }

    fn outer_list_slot(&self, outer_key: Key, mut key: Key) -> Option<CellSlot> {
        while key != NO_KEY {
            let parent = self.nodes[key as usize].parent;
            if parent == outer_key {
                return self.nodes[key as usize].slot;
            }
            key = parent;
        }
        None
    }

    fn list_assigned_cells_settled(&self, list: &ListState) -> bool {
        for slot in &list.slots {
            let Some(i) = slot.index else {
                continue;
            };
            if slot.ready() != Some(i) || !list.item_measured(i) {
                return false;
            }
            if self.awaiting_renders.binary_search(&slot.cell).is_ok() {
                return false;
            }
            if self.nodes[slot.cell as usize]
                .layout
                .is_some_and(|layout| self.layout.dirty(layout))
            {
                return false;
            }
        }
        true
    }

    fn list_viewport_settled(&self, key: Key) -> bool {
        let Some(list) = self.nodes[key as usize].list.as_ref() else {
            return true;
        };
        if list.dirty || !self.list_cells_settled(list) {
            return false;
        }
        let Some((first, last)) = list.viewport_items() else {
            return true;
        };
        if let Some(scroll) = self.nodes[key as usize].scroll.as_ref() {
            for &dep_key in &scroll.dependents {
                let in_viewport = match self.outer_list_slot(key, dep_key) {
                    Some(CellSlot::Item(slot)) => {
                        let Some(item) = list.slots.get(slot as usize).and_then(|s| s.ready())
                        else {
                            continue;
                        };
                        if item > last {
                            continue;
                        }
                        item >= first
                    }
                    Some(CellSlot::Header) => true,
                    _ => continue,
                };
                if self.displays_none(dep_key) {
                    continue;
                }
                let dep_node = &self.nodes[dep_key as usize];
                if !dep_node.created || self.outer_input(dep_key).is_none() {
                    if in_viewport {
                        return false;
                    }
                    continue;
                }
                let Some(dep) = dep_node.list.as_ref() else {
                    continue;
                };
                if dep.dirty
                    || dep.items_changed
                    || dep.spacer.is_some_and(|(_, len)| len != dep.content_len())
                    || dep.has_paced()
                    || (dep.count > 0 && dep.viewport <= 0.0)
                    || dep.source_rows.as_ref().is_some_and(|rows| {
                        rows.provisional || rows.projection_len < rows.source_len
                    })
                {
                    return false;
                }
                if !self.list_cells_settled(dep) || !self.list_assigned_cells_settled(dep) {
                    return false;
                }
            }
        }
        true
    }

    fn scroll_content_position(&self, key: Key) -> Option<usize> {
        let node = &self.nodes[key as usize];
        let (batch, hint) = node.scroll.as_ref()?.content_item?;
        (batch == self.batches).then_some(())?;
        let offset = self.mount.get(hint..)?.iter().position(
            |item| matches!(item, MountItem::ScrollContent { id, .. } if *id == node.id),
        )?;
        Some(hint + offset)
    }
}

/// How far out of sight unbound list cells are moved.
const HIDDEN: f32 = 1.0e6;

/// Where `x` is in `items`, looked for from both ends at once, and how
/// many items were looked at: few for an item near either end.
fn position_from_ends<T: PartialEq>(items: &[T], x: &T) -> Option<(usize, usize)> {
    let (mut front, mut back) = (0, items.len());
    while front < back {
        if items[front] == *x {
            return Some((front, 2 * front + 1));
        }
        back -= 1;
        if items[back] == *x {
            return Some((back, 2 * (items.len() - back)));
        }
        front += 1;
    }
    None
}

/// Where `x` is in `items`, looked for outward from `near` (or the last
/// item, past the end), and how many items were looked at: few when it is
/// near.
fn position_near<T: PartialEq>(items: &[T], x: &T, near: usize) -> Option<(usize, usize)> {
    let near = near.min(items.len().checked_sub(1)?);
    let mut looked = 0;
    // Every item is at most `len - 1` from `near`.
    for distance in 0..items.len() {
        let below = near.checked_sub(distance);
        let above = (distance > 0)
            .then_some(near + distance)
            .filter(|&i| i < items.len());
        for i in [below, above].into_iter().flatten() {
            looked += 1;
            if items[i] == *x {
                return Some((i, looked));
            }
        }
    }
    None
}

/// The content box (inside padding and border) of a laid-out node.
/// Taffy's rounding of a coordinate, to the nearest device pixel of
/// `ratio` pixels per point rather than to whole points: on a display whose
/// ratio is not a whole number (Android's 2.625) whole points fall between
/// pixels, so the platform rounding each view's frame to pixels in its parent
/// would make a child a pixel taller than its parent (a scroll view then cuts
/// its last row of pixels off).
fn round(value: f32, ratio: f32) -> f32 {
    (pixel(value, ratio) / f64::from(ratio)) as f32
}

/// The device pixel [`round`] puts `value` on, counted from the root's
/// origin. `value` is an `f32` sum of offsets, a hair off the position it
/// stands for, and `/ ratio` is never exact at a fractional ratio: snapped
/// to a 64th of a pixel first, an edge on a half pixel (a 28 point row at
/// 2.625 is 73.5 pixels) always rounds the same way, wherever a scroll put
/// it, instead of taking one pixel or the next by that hair.
fn pixel(value: f32, ratio: f32) -> f64 {
    (snapped(value, ratio) + 0.5).floor()
}

/// `value` in device pixels, snapped to a 64th of a pixel ([`pixel`]).
fn snapped(value: f32, ratio: f32) -> f64 {
    let p = f64::from(value) * f64::from(ratio);
    (p * 64.0).round() / 64.0
}

/// The device pixels the edges of a box from `start`, `len` long, are on:
/// each edge's [`pixel`], but for a box under a pixel thick whose edges
/// both round to one pixel. It would take none (half a point at one pixel
/// per point vanished wherever it ended on a half pixel), and takes the
/// pixel on the side of that edge most of it is on instead: a rule against
/// its parent's edge stays inside the parent, and no other box's edge
/// moves, so neighbours still meet (the rule covers a pixel of one). A
/// length under a 64th of a pixel (zero but for `f32`) still takes none.
fn edges(start: f32, len: f32, ratio: f32) -> (f64, f64) {
    let end = start + len;
    let (from, to) = (pixel(start, ratio), pixel(end, ratio));
    let (a, b) = (snapped(start, ratio), snapped(end, ratio));
    if from != to || b <= a {
        (from, to)
    } else if a + b < 2.0 * from {
        (from - 1.0, from)
    } else {
        (from, from + 1.0)
    }
}

/// Where the box a node is placed in (the view around it, or its
/// containing block) is in its layout root: unrounded, as Taffy's rounding
/// carries it down ([`Core::layout_origin`]), and whether [`edges`] put a
/// leading edge on the pixel before the one that position rounds to (a box
/// under a pixel thick mostly before it). A node's frame is from those
/// edges, so the children of such a box are on it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Origin {
    at: taffy::Point<f32>,
    back: taffy::Point<bool>,
}

impl Origin {
    /// The box at `at`, `size` large, rounded to `ratio`.
    fn of(at: taffy::Point<f32>, size: taffy::Size<f32>, ratio: taffy::Size<f32>) -> Origin {
        let back =
            |start: f32, len: f32, ratio: f32| edges(start, len, ratio).0 < pixel(start, ratio);
        Origin {
            at,
            back: taffy::Point {
                x: back(at.x, size.width, ratio.width),
                y: back(at.y, size.height, ratio.height),
            },
        }
    }

    /// The device pixels its leading edges are on.
    fn lead(self, ratio: taffy::Size<f32>) -> taffy::Point<f64> {
        taffy::Point {
            x: pixel(self.at.x, ratio.width) - f64::from(u8::from(self.back.x)),
            y: pixel(self.at.y, ratio.height) - f64::from(u8::from(self.back.y)),
        }
    }

    /// The offset in points from its leading edges to `to`'s, from the
    /// whole pixels between them ([`span`]).
    fn to(self, to: Origin, ratio: taffy::Size<f32>) -> taffy::Point<f32> {
        let (from, to) = (self.lead(ratio), to.lead(ratio));
        taffy::Point {
            x: ((to.x - from.x) / f64::from(ratio.width)) as f32,
            y: ((to.y - from.y) / f64::from(ratio.height)) as f32,
        }
    }
}

/// The distance in points from `from` to `to`, each rounded to a device
/// pixel ([`round`]): computed from the whole pixels between them, so the
/// same pixels give the same `f32` wherever they are. The difference of two
/// rounded points (`round(to) - round(from)`) would differ in its last bits
/// as a scroll moves the edges, and every frame in a scrolled region would
/// be sent again unchanged.
fn span(from: f32, to: f32, ratio: f32) -> f32 {
    ((pixel(to, ratio) - pixel(from, ratio)) / f64::from(ratio)) as f32
}

/// The width a text block is typeset in: the width Taffy measured its lines
/// in (`measured`, its unrounded content box), when its box rounded to
/// device pixels (`rounded`) is within a pixel of it. A box whose edges fall
/// between pixels can round a pixel narrower than the text was measured in
/// (a list item's content 21 points in, 57.75 pixels at 2.75): typeset in
/// that, a line that fit by less than the pixel wrapped once more than its
/// box was made tall for, and its last line ran over the block after it (a
/// browser) or was cut (a platform that clips text to its view). Typeset in
/// the width it was measured in, the lines are the ones its height has; the
/// text reaches less than a pixel past its rounded box.
fn typeset_width(rounded: Points, measured: Points, ratio: f32) -> Points {
    if measured.0.is_finite() && ((measured.0 - rounded.0) * ratio).abs() < 1.0 {
        measured
    } else {
        rounded
    }
}

/// `value` rounded up to a device pixel of `ratio` pixels per point. A
/// value that is a whole pixel but for `f32` (`56.0 / 2.625 * 2.625` is
/// `56.000004`) stays that pixel; a value really over one gets the next
/// pixel even when it is over by less than the tolerance: a text measured
/// `78.000_49` points wide (a PingFang glyph's 1020 / 1028 em beside SF's
/// 1/128 point advances) wraps in a box of 78.
fn ceil_to_pixel(value: Points, ratio: f32) -> Points {
    let up = (value.0 * ratio - 1.0e-3).ceil().max(0.0) / ratio;
    Points(if up < value.0 { up + 1.0 / ratio } else { up })
}

/// A scroll view's scrollable extent from its rounded layout: the overflow
/// rectangle is measured from the padding box origin and stops at the
/// children's border boxes, so the leading border and trailing padding are
/// added.
fn scroll_extent(l: &taffy::Layout) -> Size<Points> {
    let o = l.scrollable_overflow_rect;
    size_pt(
        l.size.width.max(l.border.left + o.right + l.padding.right),
        l.size
            .height
            .max(l.border.top + o.bottom + l.padding.bottom),
    )
}

/// `layout` rounded as Taffy's rounding pass (`taffy::round_layout`) rounds
/// it, to device pixels of `ratio` pixels per point on each axis
/// ([`round`]; on a grid surface a Cell is a pixel: [`terminal_layout::Grid::ratio`]),
/// `origin` being the node around it in its layout root (its containing
/// block): edges are rounded where they are in the root, so adjacent
/// views stay adjacent, and a box under a pixel thick keeps one ([`edges`]).
/// The location is from the leading edges of the box around it as they
/// were rounded. The core rounds itself: Taffy's pass reaches the
/// absolutely positioned nodes through their containing block's list,
/// which it can leave holding removed nodes (a panic) or never fill (a
/// hidden subtree's), while here every node is reached through its parent,
/// its logical parent; out-of-flow offsets use their Taffy containing block.
fn rounded(layout: &taffy::Layout, origin: Origin, ratio: taffy::Size<f32>) -> taffy::Layout {
    let mut out = *layout;
    let (x, y) = (
        origin.at.x + layout.location.x,
        origin.at.y + layout.location.y,
    );
    let (rx, ry) = (ratio.width, ratio.height);
    let (x0, x1) = edges(x, layout.size.width, rx);
    let (y0, y1) = edges(y, layout.size.height, ry);
    let lead = origin.lead(ratio);
    let points = |pixels: f64, ratio: f32| (pixels / f64::from(ratio)) as f32;
    out.location.x = points(x0 - lead.x, rx);
    out.location.y = points(y0 - lead.y, ry);
    out.size.width = points(x1 - x0, rx);
    out.size.height = points(y1 - y0, ry);
    out.scrollbar_size.width = round(layout.scrollbar_size.width, rx);
    out.scrollbar_size.height = round(layout.scrollbar_size.height, ry);
    out.border.left = span(x, x + layout.border.left, rx);
    out.border.right = span(
        x + layout.size.width - layout.border.right,
        x + layout.size.width,
        rx,
    );
    out.border.top = span(y, y + layout.border.top, ry);
    out.border.bottom = span(
        y + layout.size.height - layout.border.bottom,
        y + layout.size.height,
        ry,
    );
    // Padding is rounded from the border's inner edge, not from the outer
    // edge as the border is: rounded each from the outer edge, a border and
    // a padding of 1.5 and 6 points at 1.1 pixels per point took 2 + 7
    // pixels where their 8.25 pixels round to 8, and a text measured to fit
    // its content box (a label as wide as its content) wrapped in the pixel
    // or two its insets took from it. Rounded at its edges, the content box
    // is as many pixels as the text was measured.
    let (left, right) = (
        x + layout.border.left,
        x + layout.size.width - layout.border.right,
    );
    let (top, bottom) = (
        y + layout.border.top,
        y + layout.size.height - layout.border.bottom,
    );
    out.padding.left = span(left, left + layout.padding.left, rx);
    out.padding.right = span(right - layout.padding.right, right, rx);
    out.padding.top = span(top, top + layout.padding.top, ry);
    out.padding.bottom = span(bottom - layout.padding.bottom, bottom, ry);
    let o = layout.scrollable_overflow_rect;
    out.scrollable_overflow_rect.left = points(pixel(x + o.left, rx) - x0, rx);
    out.scrollable_overflow_rect.right = points(pixel(x + o.right, rx) - x0, rx);
    out.scrollable_overflow_rect.top = points(pixel(y + o.top, ry) - y0, ry);
    out.scrollable_overflow_rect.bottom = points(pixel(y + o.bottom, ry) - y0, ry);
    out
}

fn content_box(l: &taffy::Layout) -> Bounds<Points> {
    rect(
        l.padding.left + l.border.left,
        l.padding.top + l.border.top,
        (l.size.width - l.padding.left - l.padding.right - l.border.left - l.border.right).max(0.0),
        (l.size.height - l.padding.top - l.padding.bottom - l.border.top - l.border.bottom)
            .max(0.0),
    )
}

fn refresh_source_geometry<M: TextEngine>(engine: &M, cx: &mut TextContext<M::Prepared>) {
    if cx.source_geometry.is_none() {
        cx.source_geometry = if cx.sources.is_empty() {
            Some(SourceGeometry::default())
        } else {
            cx.laid_out.as_ref().map(|laid| {
                cx.sources
                    .geometry(&cx.text.text, engine.lines(&laid.layout))
            })
        };
    }
}

/// Size of an image with a known natural size: fill a known dimension and
/// keep the aspect ratio for the other.
fn image_size(natural: Size<Points>, w: Option<f32>, h: Option<f32>) -> taffy::Size<f32> {
    let ratio = if natural.height > Points::ZERO {
        natural.width / natural.height
    } else {
        1.0
    };
    let (width, height) = match (w, h) {
        (Some(w), None) => (w, w / ratio),
        (None, Some(h)) => (h * ratio, h),
        (Some(w), Some(h)) => (w, h),
        (None, None) => (natural.width.0, natural.height.0),
    };
    taffy::Size { width, height }
}

/// Measures a text block: per-node cache, then the shared content-addressed
/// cache, then the platform engine.
/// Keeps a Rust component's text block's final layout for its
/// [`crate::Text::on_text_layout`] listener, which hears it with the
/// block's `TextLayout` event ([`Core::component_event`]). Only the core's
/// nodes (odd ids, the components'): JS hears the lines.
fn keep_geometry(
    engine: &Option<Rc<dyn crate::text::GeometryEngine>>,
    geometries: &mut rustc_hash::FxHashMap<NodeId, crate::text::TextGeometry>,
    id: NodeId,
    layout: &TextLayout,
    text: &Arc<AttributedText>,
    spacers: &[u32],
) {
    if let Some(engine) = engine.as_ref().filter(|_| id % 2 == 1) {
        geometries.insert(
            id,
            crate::text::TextGeometry::new(engine.clone(), layout.clone(), text.clone(), spacers),
        );
    }
}

/// The lines of `layout` with their characters.
fn text_lines<M: TextEngine>(
    engine: &M,
    text: &AttributedText,
    layout: &TextLayout,
) -> EventPayload {
    let units: Vec<u16> = text.text.encode_utf16().collect();
    let mut lines = engine.lines(layout);
    for line in &mut lines {
        let (start, end) = (line.start as usize, (line.end as usize).min(units.len()));
        if start < end {
            line.text = String::from_utf16_lossy(&units[start..end]);
        }
    }
    EventPayload::TextLayout(lines)
}

/// `text` with its fonts scaled down (to at least `min`) until it fits
/// `size` within its line limit: the largest scale that fits, by
/// bisection.
fn fitted<M: TextEngine>(
    engine: &M,
    text: &AttributedText,
    alignments: &crate::AttachmentAlignments,
    size: Size<Points>,
    min: f32,
) -> AttributedText {
    let scaled = |scale: f32| {
        let mut t = text.clone();
        for span in &mut t.spans {
            span.style.font_size *= scale;
            span.style.line_height *= scale;
            span.style.letter_spacing *= scale;
        }
        t
    };
    let fits = |t: &AttributedText| {
        // Untruncated, the text must be no taller than its truncated self
        // (nothing cut) and than the box.
        let all = AttributedText {
            max_lines: 0,
            ..t.clone()
        };
        let full = engine.measure(&engine.prepare_aligned(&all, alignments), Some(size.width));
        let limited = if t.max_lines > 0 {
            engine
                .measure(&engine.prepare_aligned(t, alignments), Some(size.width))
                .height
        } else {
            Points(f32::INFINITY)
        };
        full.height <= size.height.min(limited) + Points(0.5)
            && full.width <= size.width + Points(0.5)
    };
    if fits(text) {
        return text.clone();
    }
    let (mut lo, mut hi) = (min, 1.0f32);
    if !fits(&scaled(lo)) {
        return scaled(lo);
    }
    for _ in 0..7 {
        let mid = (lo + hi) / 2.0;
        if fits(&scaled(mid)) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    scaled(lo)
}

/// Min-content keeps every unbreakable segment intact. Measure the styled
/// segments with the platform engine rather than estimating glyph advances.
/// The size a text far from the screen is laid out at until it is
/// measured (`cull.rs`): its characters at an average advance of its
/// largest font, broken into lines at `max_width`, each line as high as
/// its line height.
fn estimate_text(text: &AttributedText, max_width: Option<f32>) -> Size<Points> {
    let (_, line) = text_metrics(text);
    let mut width = 0.0f32;
    let mut lines = 0u32;
    for paragraph in text.text.split('\n') {
        let w = estimate_line(text, paragraph).0;
        width = width.max(match max_width {
            Some(max) => w.min(max),
            None => w,
        });
        lines += match max_width {
            Some(max) if max > 0.0 && !text.no_wrap => (w / max).ceil().max(1.0) as u32,
            _ => 1,
        };
    }
    if text.max_lines > 0 {
        lines = lines.min(text.max_lines);
    }
    Size::new(Points(width.ceil()), Points((lines as f32 * line).ceil()))
}

/// The estimated advance of `run`, in `text`'s largest font: wide
/// characters (CJK, emoji) a font size each, others a little over half.
fn estimate_line(text: &AttributedText, run: &str) -> Points {
    let (size, _) = text_metrics(text);
    Points(
        run.chars()
            .map(|c| {
                if c as u32 >= 0x2e80 {
                    size
                } else {
                    size * 0.55
                }
            })
            .sum(),
    )
}

/// `text`'s largest font size and the line height it gives (the style's,
/// or 1.2 of the font size).
fn text_metrics(text: &AttributedText) -> (f32, f32) {
    let (font, line) = text.approx_metrics();
    (font.0, line.0)
}

fn min_content_width<M: TextEngine>(
    engine: &M,
    cache: &mut MeasureCache,
    cx: &mut TextContext<M::Prepared>,
) -> Points {
    if let Some(width) = cx.min_content {
        return width;
    }
    if cx.deferred {
        // Its longest word, estimated (not kept: measured once it is made).
        return cx
            .text
            .text
            .split_whitespace()
            .map(|word| estimate_line(&cx.text, word))
            .fold(Points::ZERO, Points::max);
    }
    let text = &cx.text;
    let mut offsets = Vec::with_capacity(text.text.chars().count() + 1);
    let mut utf16 = 0u32;
    for (byte, ch) in text.text.char_indices() {
        offsets.push((utf16, byte));
        utf16 += ch.len_utf16() as u32;
    }
    offsets.push((utf16, text.text.len()));
    let byte_at = |offset: u32| {
        offsets[offsets
            .binary_search_by_key(&offset, |&(at, _)| at)
            .unwrap()]
        .1
    };
    let mut start = 0usize;
    let mut width = Points::ZERO;
    for (end, _) in unicode_linebreak::linebreaks(&text.text) {
        let word = text.text[start..end].trim_end_matches([' ', '\t', '\n', '\r', '\u{000c}']);
        let from = offsets[offsets
            .binary_search_by_key(&start, |&(_, byte)| byte)
            .unwrap()]
        .0;
        let to = from + word.encode_utf16().count() as u32;
        if from < to {
            let mut part = AttributedText {
                no_wrap: true,
                rtl: text.rtl,
                writing_direction: text.writing_direction,
                ..Default::default()
            };
            for span in &text.spans {
                let (lo, hi) = (from.max(span.start), to.min(span.end));
                if lo < hi {
                    part.push(&text.text[byte_at(lo)..byte_at(hi)], span.style);
                }
            }
            for attachment in &text.attachments {
                if (from..to).contains(&attachment.index) {
                    let mut attachment = *attachment;
                    attachment.index -= from;
                    part.attachments.push(attachment);
                }
            }
            let hash = part.layout_hash();
            let measured = cache.get(hash, None).unwrap_or_else(|| {
                let measured = engine.measure(&engine.prepare(&part), None);
                cache.insert(hash, None, measured);
                measured
            });
            width = width.max(measured.width);
        }
        start = end;
    }
    cx.min_content = Some(width);
    width
}

/// What measures the leaves in every layout pass ([`measure_leaf`]): one
/// closure type for all of them, so Taffy's algorithms, generic over it,
/// are made once.
fn leaf_measure<'a, M: TextEngine>(
    engine: &'a M,
    cache: &'a mut MeasureCache,
) -> impl FnMut(
    taffy::LayoutInput,
    LayoutId,
    Option<&mut LeafContext<M::Prepared>>,
    &taffy::Style,
    layout_tree::Aligned,
) -> taffy::LayoutOutput
+ 'a {
    move |input, _, cx, style, aligned| measure_leaf(engine, cache, input, cx, style, aligned)
}

/// A leaf's layout (`taffy::compute_leaf_layout`): Taffy resolves its
/// style's sizes, padding, border, minimums, maximums and aspect ratio;
/// only its content (a text, an image's natural size, a native
/// component's own size) is measured here. A text aligned by baseline gives
/// its first line's baseline too ([`text_baseline`]): Taffy aligns a flex
/// row's items by baseline (`align-items: baseline`) with it, and by their
/// bottom edges without it.
fn measure_leaf<M: TextEngine>(
    engine: &M,
    cache: &mut MeasureCache,
    input: taffy::LayoutInput,
    mut cx: Option<&mut LeafContext<M::Prepared>>,
    style: &taffy::Style,
    aligned: layout_tree::Aligned,
) -> taffy::LayoutOutput {
    let mut output = measure_leaf_size(engine, cache, input, cx.as_deref_mut(), style);
    // Taffy asks for baselines by laying the items out (its baseline pass),
    // so measuring alone typesets nothing more.
    if aligned == layout_tree::Aligned::Baseline
        && input.run_mode == taffy::RunMode::PerformLayout
        && let Some(LeafContext::Text(cx)) = cx
    {
        use taffy::util::ResolveOrZero;
        let resolve = |_: *const (), _: f32| 0.0;
        let padding = style
            .padding
            .resolve_or_zero(input.parent_size.width, resolve);
        let border = style
            .border
            .resolve_or_zero(input.parent_size.width, resolve);
        let width = output.size.width - padding.left - padding.right - border.left - border.right;
        if let Some(baseline) = text_baseline(engine, cx, width.max(0.0)) {
            output.baselines.first = Some(padding.top + border.top + baseline.0);
        }
    }
    output
}

/// How far below the top of `cx`'s text its first line's baseline is, laid
/// out `width` wide ([`TextEngine::first_baseline`]); none for a text
/// measured by an estimate (`cull.rs`), which is not typeset.
fn text_baseline<M: TextEngine>(
    engine: &M,
    cx: &mut TextContext<M::Prepared>,
    width: f32,
) -> Option<Points> {
    if cx.deferred {
        return None;
    }
    if let Some((w, baseline)) = cx.baseline
        && w == width
    {
        return baseline;
    }
    let prepared = cx
        .prepared
        .get_or_insert_with(|| engine.prepare_aligned(&cx.text, &cx.alignments));
    let baseline = engine.first_baseline(prepared, Points(width));
    cx.baseline = Some((width, baseline));
    baseline
}

/// A leaf's size ([`measure_leaf`]).
fn measure_leaf_size<M: TextEngine>(
    engine: &M,
    cache: &mut MeasureCache,
    input: taffy::LayoutInput,
    cx: Option<&mut LeafContext<M::Prepared>>,
    style: &taffy::Style,
) -> taffy::LayoutOutput {
    use taffy::{MaybeResolve as _, ResolveOrZero as _};
    // An input's text scrolls within its maximum height: its content is
    // never taller than its content box can be. Taffy leaves the maximum out
    // of the content size it asks for a flex basis (`SizingMode::ContentSize`)
    // and a column container sizes itself from the flex bases, so without
    // this a long value grew the input's parent past the input.
    let input_max_height = match &cx {
        Some(LeafContext::Text(cx)) if cx.field.is_some() => {
            let parent = input.parent_size;
            let max: Option<f32> = style
                .max_size
                .height
                .maybe_resolve(parent.height, |_, _| 0.0);
            max.map(|max| {
                let inset = (style.padding.resolve_or_zero(parent.width, |_, _| 0.0)
                    + style.border.resolve_or_zero(parent.width, |_, _| 0.0))
                .vertical_axis_sum();
                match style.box_sizing {
                    taffy::BoxSizing::BorderBox => (max - inset).max(0.0),
                    taffy::BoxSizing::ContentBox => max,
                }
            })
        }
        _ => None,
    };
    // Taffy hands a size it asks for (`RunMode::ComputeSize`) the known
    // sizes of the border box, as a stretched item's width is, and the
    // available space of the content box. What is measured fits the
    // content box: a text measured as wide as its border box wraps fewer
    // lines than it is laid out in, and the platforms cut the rest.
    let inset = {
        let parent = input.parent_size.width;
        let mut inset = (style.padding.resolve_or_zero(parent, |_, _| 0.0)
            + style.border.resolve_or_zero(parent, |_, _| 0.0))
        .sum_axes();
        // Scroll bars' gutters, as Taffy reserves them.
        if style.overflow.y == taffy::Overflow::Scroll {
            inset.width += style.scrollbar_width;
        }
        if style.overflow.x == taffy::Overflow::Scroll {
            inset.height += style.scrollbar_width;
        }
        inset
    };
    taffy::compute_leaf_layout(
        input,
        style,
        |_, _| 0.0,
        |known, available| {
            let known = taffy::Size {
                width: known.width.map(|w| (w - inset.width).max(0.0)),
                height: known.height.map(|h| (h - inset.height).max(0.0)),
            };
            measure_content(engine, cache, cx, known, available, input_max_height)
        },
    )
}

/// The size of a leaf's content: `known` and `available` are its content
/// box's ([`measure_leaf_size`]).
fn measure_content<M: TextEngine>(
    engine: &M,
    cache: &mut MeasureCache,
    cx: Option<&mut LeafContext<M::Prepared>>,
    known: taffy::Size<Option<f32>>,
    available: taffy::Size<AvailableSpace>,
    input_max_height: Option<f32>,
) -> taffy::Size<f32> {
    match cx {
        Some(LeafContext::Text(cx)) => {
            // An input's text scrolls in it (or wraps at its width):
            // the input's width does not come from the text.
            let field = cx
                .field
                .as_deref_mut()
                .map(|field| measure_text(engine, cache, field, None));
            let field_width = field.map(|size| size.width.0);
            let max_width = if cx.text.no_wrap {
                None
            } else {
                known.width.or(match (available.width, field_width) {
                    (AvailableSpace::Definite(w), Some(field)) => Some(field.min(w)),
                    (AvailableSpace::Definite(w), None) => Some(w),
                    (_, Some(field)) => Some(field),
                    (AvailableSpace::MinContent, None) => {
                        Some(min_content_width(engine, cache, cx).0)
                    }
                    (AvailableSpace::MaxContent, None) => None,
                })
            };
            let width = known.width.or(field_width.and(max_width));
            // A single-line input uses the field sample's width. When its font
            // determines the line height too, shaping the edited value would
            // change neither dimension.
            let measured = match field {
                Some(sample)
                    if width.is_some()
                        && cx.text.max_lines == 1
                        && engine.uniform_input_line_height() =>
                {
                    sample
                }
                _ => measure_text(engine, cache, cx, max_width),
            };
            taffy::Size {
                width: width.unwrap_or(measured.width.0),
                height: known.height.unwrap_or(match input_max_height {
                    Some(max) => measured.height.0.min(max),
                    None => measured.height.0,
                }),
            }
        }
        Some(LeafContext::Image(Some(natural))) => image_size(*natural, known.width, known.height),
        Some(LeafContext::Native(Some(own))) => taffy::Size {
            width: known.width.unwrap_or(own.width.0),
            height: known.height.unwrap_or(own.height.0),
        },
        _ => taffy::Size::ZERO,
    }
}

fn measure_text<M: TextEngine>(
    engine: &M,
    cache: &mut MeasureCache,
    cx: &mut TextContext<M::Prepared>,
    max_width: Option<f32>,
) -> Size<Points> {
    if let Some((w, size)) = cx.cache
        && w == max_width
    {
        return size;
    }
    let typed = max_width.map(Points);
    // Far from the screen with no view: estimated, unless the size is
    // known (`cull.rs`).
    if cx.deferred {
        let size = cache.get(cx.layout_hash, typed).unwrap_or_else(|| {
            cx.estimated = true;
            estimate_text(&cx.text, max_width)
        });
        cx.cache = Some((max_width, size));
        return size;
    }
    if let (Some(width), Some(same)) = (max_width, cx.same_lines)
        && (same.narrowest..=same.widest).contains(&width)
    {
        cx.cache = Some((max_width, same.size));
        return same.size;
    }
    // A limit on lines cuts the last one to the width.
    let greedy = engine.breaks_lines_greedily() && cx.text.max_lines == 0;
    let size = match cache.get(cx.layout_hash, typed) {
        Some(size) => size,
        None => {
            // Far from the screen during a resize: it keeps its height for
            // now ([`Core::set_resizing`]).
            if let (Some(commit), Some((_, last))) = (cache.resizing, cx.cache)
                && cx.near_screen != commit
            {
                cx.held = true;
                return Size::new(
                    max_width.map_or(last.width, |w| last.width.min(Points(w))),
                    last.height,
                );
            }
            let prepared = cx
                .prepared
                .get_or_insert_with(|| engine.prepare_aligned(&cx.text, &cx.alignments));
            // Round up so rendering never truncates the last glyph, to a
            // device pixel: to a whole point the box grows past the text by
            // up to a point, all of it below the last line.
            let ratio = cache.pixel_ratio();
            let on_pixels = |size: Size<Points>| {
                cache
                    .on_cells(size)
                    .unwrap_or_else(|| size.map(|v| ceil_to_pixel(v, ratio)))
            };
            // Growing: measured a little wider, the next widths are known
            // too, unless a line takes another word by then.
            let ahead = max_width.filter(|width| {
                greedy && !cx.no_ahead && cx.same_lines.is_some_and(|same| *width > same.widest)
            });
            let ahead = ahead.and_then(|width| {
                let wider = Points(width + SAME_LINES_AHEAD);
                let size = on_pixels(engine.measure(prepared, Some(wider)));
                cx.no_ahead = size.width.0 > width;
                (size.width.0 <= width).then_some((wider.0, size))
            });
            let (measured, size) = match ahead {
                Some(found) => found,
                None => (
                    max_width.unwrap_or(f32::INFINITY),
                    on_pixels(engine.measure(prepared, typed)),
                ),
            };
            cache.insert(cx.layout_hash, typed, size);
            if greedy && size.width.0 <= measured {
                cx.same_lines = Some(SameLines {
                    narrowest: size.width.0,
                    widest: measured,
                    size,
                });
            }
            size
        }
    };
    cx.cache = Some((max_width, size));
    size
}

/// Whether `laid`, the layout of `cx`'s text, stands for a box of `size`:
/// both widths break its lines the same ([`SameLines`]) and its lines start
/// at the box's left, wherever its right is.
/// The width `text-pretty` breaks a text's lines at in a box `width` wide:
/// narrower when its last line would hold less than a quarter of it (a
/// word or two left alone below a paragraph), as narrow as it takes for
/// that line to hold a quarter of the width without adding a line. The
/// platform's own line breaking decides where the lines break at it; a
/// text that cannot do better keeps the box's width.
fn pretty_width<M: TextEngine>(
    engine: &M,
    cx: &mut TextContext<M::Prepared>,
    width: Points,
) -> Points {
    if let Some(&(w, out)) = cx.pretty.as_deref()
        && w == width.0
    {
        return out;
    }
    let out = narrower_lines(engine, cx, width).unwrap_or(width);
    if let Some(p) = &mut cx.pretty {
        **p = (width.0, out);
    }
    out
}

/// How short a last line `text-pretty` leaves alone: a quarter of the box.
const PRETTY_LAST_LINE: f32 = 0.25;

fn narrower_lines<M: TextEngine>(
    engine: &M,
    cx: &mut TextContext<M::Prepared>,
    width: Points,
) -> Option<Points> {
    let text = &cx.text;
    if text.no_wrap || text.max_lines > 0 || width <= Points::ZERO || text.text.contains('\n') {
        return None;
    }
    let prepared = cx
        .prepared
        .get_or_insert_with(|| engine.prepare_aligned(&cx.text, &cx.alignments));
    let height = engine.measure(prepared, Some(width)).height;
    // How short the last line is at `w`, `None` past a line more.
    let short = |w: Points| -> Option<bool> {
        let size = engine.measure(prepared, Some(w));
        if size.height > height {
            return None;
        }
        let lines = engine.lines(&engine.layout(prepared, Size { width: w, height }));
        let last = lines.last()?;
        Some(lines.len() > 1 && last.width < w * PRETTY_LAST_LINE)
    };
    if short(width) != Some(true) {
        return None;
    }
    // Narrowing moves words down to the last line: find the widest width
    // whose last line is no longer short, between the box and the
    // narrowest width with as many lines.
    let lines = engine
        .lines(&engine.layout(prepared, Size { width, height }))
        .len();
    let (mut lo, mut hi) = (width * ((lines - 1) as f32 / lines as f32), width);
    let mut found = None;
    for _ in 0..8 {
        let mid = (lo + hi) * 0.5;
        match short(mid) {
            Some(false) => {
                found = Some(mid);
                lo = mid;
            }
            Some(true) => hi = mid,
            None => lo = mid,
        }
        if hi - lo < Points(1.0) {
            break;
        }
    }
    found
}

fn keeps_lines<P>(cx: &TextContext<P>, laid: &LaidText, size: Size<Points>) -> bool {
    let Some(same) = cx.same_lines else {
        return false;
    };
    let widths = same.narrowest..=same.widest;
    laid.content.size.height == size.height
        && widths.contains(&laid.content.size.width.0)
        && widths.contains(&size.width.0)
        && Arc::ptr_eq(&laid.text, &cx.text)
        && lines_start_left(&cx.text)
}

/// Whether every line of `text` starts at the left of its box. A paragraph's
/// direction may come from its first strong character, so `auto` alignment
/// with a character of a right-to-left script does not count.
fn lines_start_left(text: &AttributedText) -> bool {
    match text.align {
        TextAlign::Left => !text.text.chars().any(is_right_to_left),
        TextAlign::Auto => {
            !text.rtl
                && text.writing_direction != Some(true)
                && !text.text.chars().any(is_right_to_left)
        }
        TextAlign::Center | TextAlign::Right | TextAlign::Justify => false,
    }
}

/// Whether `c` is in a block of a right-to-left script.
fn is_right_to_left(c: char) -> bool {
    matches!(
        c as u32,
        0x0590..=0x08FF | 0xFB1D..=0xFDFF | 0xFE70..=0xFEFF | 0x10800..=0x10FFF | 0x1E800..=0x1EFFF
    )
}

fn definite(size: Size<Points>) -> taffy::Size<AvailableSpace> {
    taffy::Size {
        width: AvailableSpace::Definite(size.width.0),
        height: AvailableSpace::Definite(size.height.0),
    }
}

/// The message for a refused URL.
fn not_granted(what: &str, uri: &str, capability: &str) -> String {
    let advice = crate::access::grant_advice(uri, capability);
    format!("{what} {uri} is not granted: {advice}")
}

/// The message for a refused media source, read against `base` as
/// `Access::media_url` reads it.
fn media_not_granted(what: &str, uri: &str, base: Option<&str>) -> String {
    let advice = crate::access::media_grant_advice(uri, base);
    format!("{what} {uri} is not granted: {advice}")
}

/// A page with nothing to load and no scripts: what a web view whose manual
/// Applies one property to a control.
fn apply_native(control: &mut NativeProps, prop: NativeProp) {
    use NativeProp as P;
    match (control, prop) {
        (NativeProps::WebView(p), P::Source(v)) => p.source = v,
        // `src`, `html` and `baseUrl` make one source: `html` shows over
        // `src`, with the base URL set before or after it.
        (NativeProps::WebView(p), P::Src(Some(url))) => {
            if !matches!(p.source, crate::WebSource::Html { .. }) {
                p.source = crate::WebSource::Uri(url.clone());
            }
            p.src = Some(url);
        }
        (NativeProps::WebView(p), P::Src(None)) => {
            p.src = None;
            if matches!(p.source, crate::WebSource::Uri(_)) {
                p.source = crate::WebSource::None;
            }
        }
        (NativeProps::WebView(p), P::Html(Some(html))) => {
            p.source = crate::WebSource::Html {
                html,
                base_url: p.base_url.clone(),
            };
        }
        (NativeProps::WebView(p), P::Html(None)) => {
            if matches!(p.source, crate::WebSource::Html { .. }) {
                p.source = match &p.src {
                    Some(url) => crate::WebSource::Uri(url.clone()),
                    None => crate::WebSource::None,
                };
            }
        }
        (NativeProps::WebView(p), P::BaseUrl(url)) => {
            if let crate::WebSource::Html { base_url, .. } = &mut p.source {
                base_url.clone_from(&url);
            }
            p.base_url = url;
        }
        (NativeProps::WebView(p), P::InjectedJavaScript(v)) => p.injected_js = v,
        (NativeProps::WebView(p), P::InjectedJavaScriptBefore(v)) => p.injected_js_before = v,
        (NativeProps::WebView(p), P::UserAgent(v)) => p.user_agent = v,
        (NativeProps::WebView(p), P::Scrollable(v)) => p.scrollable = v,
        (NativeProps::WebView(p), P::JavaScriptEnabled(v)) => p.javascript_enabled = v,
        (NativeProps::WebView(p), P::BackForwardGestures(v)) => p.back_forward_gestures = v,
        (NativeProps::WebView(p), P::Incognito(v)) => p.incognito = v,
        (NativeProps::WebView(p), P::UrlSchemes(v)) => p.url_schemes = v,
        (NativeProps::WebView(p), P::DeferDownloads(v)) => p.defer_downloads = v,
        (NativeProps::Video(p), P::Source(v)) => {
            p.source = match v {
                crate::WebSource::Uri(uri) => Some(uri),
                _ => None,
            }
        }
        (NativeProps::Video(p), P::Src(v)) => p.source = v,
        (NativeProps::Video(p), P::Paused(v)) => p.paused = v,
        (NativeProps::Video(p), P::Muted(v)) => p.muted = v,
        (NativeProps::Video(p), P::Volume(v)) => p.volume = v.clamp(0.0, 1.0),
        (NativeProps::Video(p), P::Rate(v)) => p.rate = v.max(0.0),
        (NativeProps::Video(p), P::Repeat(v)) => p.repeat = v,
        (NativeProps::Video(p), P::VideoResizeMode(v)) => p.resize_mode = v,
        (NativeProps::Video(p), P::Controls(v)) => p.controls = v,
        (NativeProps::Video(p), P::ProgressInterval(v)) => p.progress_interval_ms = v.max(16.0),
        (NativeProps::Video(p), P::AudioSession(v)) => p.audio_session = v,
        _ => {}
    }
}

/// `style` with its font metrics multiplied for the user's text size.
fn scaled(mut style: ResolvedTextStyle, multiplier: f32) -> ResolvedTextStyle {
    if multiplier != 1.0 {
        style.font_size *= multiplier;
        style.line_height *= multiplier;
    }
    style
}

fn root_style(viewport: Size<Points>) -> taffy::Style {
    let mut style = taffy::Style {
        size: taffy::Size {
            width: taffy::Dimension::length(viewport.width.0),
            height: taffy::Dimension::length(viewport.height.0),
        },
        ..Style::default().layout
    };
    crate::style::resolve_normal_alignment(&mut style);
    style
}

/// `align` in a layout of direction `rtl`: left and right trade places
/// right to left, as all left / right properties do.
fn directed_align(align: TextAlign, rtl: bool) -> TextAlign {
    match (align, rtl) {
        (TextAlign::Left, true) => TextAlign::Right,
        (TextAlign::Right, true) => TextAlign::Left,
        (align, _) => align,
    }
}

/// The press events.
/// The gestures and touches a view handles besides presses: one with a
/// handler of them is something the user moves (a draggable ball), which a
/// terminal keeps (`terminal_layout::Role::interactive`).
const HANDLED: [EventKind; 7] = [
    EventKind::PanStart,
    EventKind::PanEnd,
    EventKind::PinchStart,
    EventKind::PinchEnd,
    EventKind::RotationStart,
    EventKind::RotationEnd,
    EventKind::Touch,
];

const PRESSES: [EventKind; 4] = [
    EventKind::Press,
    EventKind::LongPress,
    EventKind::PressDown,
    EventKind::PressUp,
];

/// The events a `disabled` view does not mount ([`Node::mounted_events`]).
const DISABLED_OFF: [EventKind; 8] = [
    EventKind::Press,
    EventKind::LongPress,
    EventKind::PressDown,
    EventKind::PressUp,
    EventKind::ContextMenu,
    EventKind::FileDragEnter,
    EventKind::FileDragLeave,
    EventKind::FileDrop,
];

/// Whether `disabled` changes what a view with `events` mounts.
fn disabling_changes(events: EventMask) -> bool {
    DISABLED_OFF.iter().any(|&e| events.contains(e))
}

/// A span's horizontal padding at its first and last character, in
/// points (its block is right to left when `rtl`). Percentages, of no box
/// a span has, count as none.
fn span_padding(node: &Node, rtl: bool) -> (f32, f32) {
    let Some(style) = node.base_layout.as_deref() else {
        return (0.0, 0.0);
    };
    let len = |p: taffy::LengthPercentage| match p.into_raw().tag() {
        taffy::CompactLength::LENGTH_TAG => p.into_raw().value().max(0.0),
        _ => 0.0,
    };
    let (left, right) = (len(style.padding.left), len(style.padding.right));
    if rtl { (right, left) } else { (left, right) }
}

/// A span's top and bottom padding, which only its background takes (as
/// a CSS inline box's): the line keeps its height. Percentages count as
/// none.
fn span_vertical_padding(node: &Node) -> (Points, Points) {
    let Some(style) = node.base_layout.as_deref() else {
        return (Points::ZERO, Points::ZERO);
    };
    let len = |p: taffy::LengthPercentage| match p.into_raw().tag() {
        taffy::CompactLength::LENGTH_TAG => Points(p.into_raw().value().max(0.0)),
        _ => Points::ZERO,
    };
    (len(style.padding.top), len(style.padding.bottom))
}

/// The background a nested text's view style gives its characters.
fn span_background(style: &ViewStyle, node: NodeId) -> Option<crate::text::TextBackground> {
    (style.background_color.0 & 0xff != 0).then_some(crate::text::TextBackground {
        color: style.background_color,
        radius: style.border_radius.max(Points::ZERO),
        node,
        top: Points::ZERO,
        bottom: Points::ZERO,
    })
}

/// Whether a span with `events` takes presses (a link in its text block).
fn pressable(events: EventMask) -> bool {
    PRESSES.iter().any(|&e| events.contains(e))
}

/// `content` with a line break after every [`MEASURED_RUN`] characters of
/// a run without a line-break opportunity, as a multiline input's value is measured.
///
/// Line breakers search back over the whole run for a break opportunity
/// at the end of every line they lay out (CoreText through ICU), so one
/// long run (minified JSON, Base64) costs time quadratic in its length:
/// 13 s to measure a 474 KB minified JSON on an Apple silicon Mac, on the
/// engine thread, at every edit. Broken into runs of 1024 it takes 47 ms. The
/// input shows and reports its own text; the measured height can only
/// grow by a line per break, and text without such runs is measured as is.
fn broken_runs(content: &str) -> std::borrow::Cow<'_, str> {
    let mut broken: Option<String> = None;
    let (mut start, mut from) = (0, 0);
    for (end, _) in unicode_linebreak::linebreaks(content) {
        let mut run = 0;
        for (offset, c) in content[start..end].char_indices() {
            let i = start + offset;
            // The final character may itself provide the break (space or
            // newline). Do not introduce another line immediately before it.
            if run == MEASURED_RUN && i + c.len_utf8() < end {
                let broken = broken.get_or_insert_with(|| {
                    String::with_capacity(content.len() + content.len() / MEASURED_RUN)
                });
                broken.push_str(&content[from..i]);
                broken.push('\n');
                (run, from) = (0, i);
            }
            run += 1;
        }
        start = end;
    }
    match broken {
        Some(mut broken) => {
            broken.push_str(&content[from..]);
            broken.into()
        }
        None => content.into(),
    }
}

/// What a leaf of `kind` measures with, if anything: texts and inputs (an
/// input measures like a text block holding its text or placeholder) their
/// text, images their image, native components the size they report.
fn leaf_context<P>(kind: Kind) -> Option<LeafContext<P>> {
    match kind {
        Kind::Text | Kind::Input => Some(LeafContext::Text(TextContext::new(Arc::default()))),
        Kind::Image => Some(LeafContext::Image(None)),
        Kind::Native => Some(LeafContext::Native(None)),
        _ => None,
    }
}

/// What a mount item changed of what shows, for the shaders that read what
/// is behind them ([`Core::mark_shader_inputs`]).
enum Shown {
    /// Nothing that shows: input, accessibility, the pictures' own marks,
    /// animated values (they reach the views on the UI thread, whose
    /// platform pictures the backdrops again), views leaving (their old
    /// parents stand in for them: `unlinked_from`).
    Nothing,
    /// What a view shows, or where.
    View(NodeId),
    /// Anything, anywhere: the appearance, the order of the tree, a
    /// transition. An item not known here is one, to be safe.
    Everywhere,
}

fn shown_by(item: &MountItem) -> Shown {
    use MountItem as M;
    match item {
        M::Events { .. }
        | M::Keymap(_)
        | M::Gestures { .. }
        | M::AccessibilityLabel { .. }
        | M::ShaderInput { .. }
        | M::LayoutAnimation(_)
        | M::Animation(_)
        | M::ComponentPropSlots { .. }
        | M::TrackStates { .. }
        | M::InputContent { .. }
        | M::Remove { .. }
        | M::Delete { .. } => Shown::Nothing,
        M::Insert { child, .. } => Shown::View(*child),
        M::ProjectStates { id, .. }
        | M::ScrollConfig { id, .. }
        | M::ScrollBy { id, .. }
        | M::StickyCells { id, .. }
        | M::ScrollBehavior { id, .. }
        | M::Refreshing { id, .. }
        | M::AnimationBindings { id, .. }
        | M::ScreenConfig { id, .. }
        | M::ModalConfig { id, .. } => Shown::View(*id),
        M::Command { id, command } => {
            use crate::ops::Command as C;
            match command {
                // Outside the window's content: the system's, the app's,
                // another program's.
                C::ExitApp
                | C::PostMessage { .. }
                | C::SendInput { .. }
                | C::SetJsResponder { .. }
                | C::ClearJsResponder
                | C::Announce { .. }
                | C::ImageInfo { .. }
                | C::AccessibilityFocus
                | C::Measure { .. }
                | C::MeasureScrollPosition { .. }
                | C::SetClipboard { .. }
                | C::SetClipboardItem(_)
                | C::ReadClipboard { .. }
                | C::SetClipboardImage { .. }
                | C::ReadClipboardImage { .. }
                | C::ReadClipboardFiles { .. }
                | C::PickImages { .. }
                | C::PickFiles { .. }
                | C::OpenUrl { .. }
                | C::OpenAppSettings { .. }
                | C::PickScreenColor { .. }
                | C::Share { .. }
                | C::RenderCanvas { .. }
                | C::FileRequest { .. }
                | C::Speech { .. }
                | C::Audio { .. }
                | C::Notification { .. }
                | C::Desktop { .. }
                | C::HostCall { .. }
                | C::HostPost { .. } => Shown::Nothing,
                // The design tokens: every view's colors.
                C::Tokens { .. } => Shown::Everywhere,
                _ => Shown::View(*id),
            }
        }
        item => item.view().map_or(Shown::Everywhere, Shown::View),
    }
}

/// What collecting a text block's text gathers about its attachments, and
/// what it places them by.
struct TextAttachments<'a> {
    /// Where each sits in its line.
    alignments: crate::AttachmentAlignments,
    /// The empty attachments standing for spans' horizontal padding.
    spacers: Vec<u32>,
    /// The baselines of their own the views holding text stand by
    /// ([`Core::attachment_baselines`]).
    baselines: &'a [(Key, Points)],
    /// The first of `baselines` not met yet: they are in the attachments'
    /// order ([`Core::attachments_of`]).
    next_baseline: usize,
}
