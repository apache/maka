mod classes;
mod components;
mod layout_tree;
mod list;
mod measure;
mod overlay;
mod parent_viewport;
mod reading;
mod renders;
mod services;
mod sticky;
#[cfg(test)]
mod tests;
mod touch;
mod views;

use std::{cell::Cell, rc::Rc, sync::Arc};

use slab::Slab;
use taffy::{AvailableSpace, NodeId as LayoutId, Overflow, Position};

pub use self::measure::Measurement;
use self::{
    layout_tree::LayoutTree,
    list::{ExtraKind, Follow, ListState, PendingScroll, PinTarget, StickyRange},
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
    style::{Color, EllipsizeMode, PaintStyle, Style, StylePatch, TextAlign, TextStyle, ViewStyle},
    tailwind::{ClassEnvironment, ClassList, ClassProps, Tailwind},
    text::{AttributedText, MeasureCache, ResolvedTextStyle, TextEngine, TextLayout},
    text_source::{SourceCollector, SourceGeometry, SourceMap},
};

/// Slab index of a node. Internal links use keys, never ids, to avoid the
/// id -> key indirection on hot paths.
type Key = u32;

const NO_KEY: Key = Key::MAX;

/// Rounds of binding the components' own lists per commit, at most.
const MAX_VIRTUAL_ROUNDS: u32 = 8;
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
    /// Where a header item goes (header items).
    slot: HeaderSlot,
    /// `nativeID` (input accessories).
    native_id: Option<Box<str>>,
    /// `statusBar` (screens and modals).
    status_bar: Option<crate::StatusBarSetting>,
    /// Its entry in the surface's status bars, while the node is in the
    /// tree ([`Core::sync_status_bars`]).
    status_bar_entry: Option<crate::ui::status_bar::StatusBarEntry>,
    /// Placement and root view (overlays).
    overlay: Option<Box<overlay::OverlayState>>,
}

/// Paragraph settings of a text block (or input).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Paragraph {
    /// `numberOfLines`; 0 means no limit.
    lines: u32,
    /// `ellipsizeMode`.
    ellipsize: EllipsizeMode,
    /// `allowFontScaling`.
    allow_font_scaling: bool,
    /// `maxFontSizeMultiplier`; 0 means no limit.
    max_font_multiplier: f32,
    /// `ellipsizeMode` was set (it then wins over classes).
    ellipsize_set: bool,
    /// `selectable` as set (it wins over `select-*` classes).
    selectable: Option<bool>,
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
            lines: 0,
            ellipsize: EllipsizeMode::Tail,
            allow_font_scaling: true,
            max_font_multiplier: 0.0,
            ellipsize_set: false,
            selectable: None,
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
            Kind::View | Kind::Cell | Kind::RawText | Kind::Overlay => ViewKind::View,
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
        }
    }

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

/// A registered native component: its name and properties, as JS set them.
#[derive(Debug, Default)]
struct ComponentState {
    name: Option<Arc<str>>,
    props: Vec<(Arc<str>, crate::JsonValue)>,
    /// Properties changed since the last commit.
    changed: Vec<Arc<str>>,
}

#[derive(Debug)]
struct ScrollState {
    horizontal: bool,
    scrollbar_visible: bool,
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
    /// The lists virtualized against this scroll view (`viewport="parent"`;
    /// empty for nearly every scroll view).
    dependents: Vec<Key>,
    /// While it has such lists: the scrolls issued that the reports do not
    /// show applied yet.
    pending: Vec<(u32, PendingScroll)>,
    /// What its lists asked of it in this commit, sent at its end.
    asked: Option<parent_viewport::Asked>,
    /// The sticky cells it was last sent with its lists' (its own too, when
    /// it is a list), while its lists have any.
    page_sticky: Vec<list::StickyRange>,
    /// The ranges of the `position: sticky` views in it.
    view_sticky: Vec<list::StickyRange>,
}

impl Default for ScrollState {
    fn default() -> Self {
        Self {
            horizontal: false,
            // React Native shows scroll indicators by default.
            scrollbar_visible: true,
            refreshing: false,
            scroll_value: None,
            pull_value: None,
            keyboard_dismiss: KeyboardDismissMode::None,
            content: None,
            content_item: None,
            behavior: ScrollBehavior::default(),
            event_throttle_ms: 0.0,
            zoom: 1.0,
            offset: (0.0, 0.0),
            issued: 0,
            dependents: Vec::new(),
            pending: Vec::new(),
            asked: None,
            page_sticky: Vec::new(),
            view_sticky: Vec::new(),
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
}

#[derive(Debug, Default)]
struct ImageState {
    source: Option<ImageSource>,
    resize_mode: ResizeMode,
    options: crate::mount::ImageOptions,
}

struct Node {
    id: NodeId,
    kind: Kind,
    /// Inside a text block: a nested `<text>` span or a raw text run.
    inline: bool,
    parent: Key,
    children: Vec<Key>,
    /// Layout node. Present exactly for nodes that render a native view.
    /// Raw text and spans have none.
    layout: Option<LayoutId>,
    /// The style JS set, for kinds whose taffy style is derived from it.
    base_layout: Option<Box<taffy::Style>>,
    view_style: ViewStyle,
    text_style: TextStyle,
    /// SVG's paint properties as written on the node (inherited by the
    /// canvases inside it); `None` while it sets none.
    paint: Option<Box<PaintStyle>>,
    animated: Vec<(AnimationProp, crate::animation::NodeId)>,
    /// What a canvas draws.
    drawing: Option<Arc<crate::canvas::Drawing>>,
    /// The `style` prop as written, applied over the class styles.
    inline_style: StylePatch,
    /// `class` / `classList` as set.
    class_names: Option<Box<classes::ClassNames>>,
    /// Their parsed form.
    classes: Option<Arc<ClassList>>,
    /// Node props the classes set.
    class_props: Option<Box<ClassProps>>,
    /// Interaction states (`tailwind::state` bits).
    states: u8,
    /// States the platform reports for the view.
    tracked: u8,
    /// States it shows as a part of a control (`Prop::ProjectedStates`):
    /// its classes read them with its own, nothing else does.
    projected: u8,
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
    /// Its style says `position: fixed`.
    wants_fixed: bool,
    /// A view made an overlay by `position: fixed` (`overlay.rs` `fix_view`).
    fixed_view: bool,
    /// What its view takes from the `pointer-events-*` classes around it
    /// (`classes.rs` `update_pointer_events`); an explicit prop wins.
    class_pointer: crate::props::PointerEvents,
    /// A `pointer-events-auto` is inside it, under a `pointer-events-none`
    /// (scratch of `update_pointer_events`).
    pointer_auto_inside: bool,
    /// `position: sticky`: its insets, where it sticks in the viewport of
    /// the scroll view around it ([`Core::update_sticky_views`]).
    sticky: Option<Box<taffy::Rect<taffy::LengthPercentageAuto>>>,
    /// The inset padding and margin components set: added to the style's.
    insets: Option<Box<[EdgeInsets; 2]>>,
    events: EventMask,
    /// `zIndex`: native views are ordered by it (stable) among siblings.
    z_index: i32,
    /// `verticalAlign`: where it sits in its line as an attachment.
    vertical_align: crate::style::VerticalAlign,
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
    /// Canonical source metadata of this block or inline span.
    text_source: Option<Arc<crate::TextSource>>,
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
    /// A promoted layout root has a native projection. This is separate
    /// from creation: parking keeps its native object and logical intent.
    native_root_projected: bool,
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
    /// A list cell without an item, until the list places it again: it
    /// still shows its last row, so it is hidden from sight, touches and
    /// assistive technology ([`Core::set_spare`]).
    spare: bool,
    /// `android={{ elevation }}`.
    elevation: Points,
    /// `ios={{ backdropMaterial }}`.
    backdrop_material: crate::BackdropMaterial,
    /// A text block: its attachments (inline views and images, in text
    /// order) whose native views are inside its own.
    attached: Vec<NodeId>,
    /// What the overlays have it listen to ([`overlay::watch`]): touches
    /// for an overlay's `onPressOutside`, the pointer for a hint's.
    overlay_watched: u8,
}

impl Node {
    fn is_overlay(&self) -> bool {
        self.kind == Kind::Overlay || self.fixed_view
    }

    fn is_layout_root(&self) -> bool {
        self.kind.is_root() || self.fixed_view
    }

    /// The listeners as platforms take them: a `disabled` view takes no
    /// presses (React Native's `Pressable` / touchables), so it shows no
    /// press feedback either, and opens no context menu: a secondary click
    /// on it goes on to the nearest enabled listener around it.
    fn mounted_events(&self, hint_watch: Option<crate::overlay::HintWatchToken>) -> EventMask {
        let mut events = self.events;
        if !self.pan_enabled {
            events.set(EventKind::PanStart, false);
            events.set(EventKind::PanEnd, false);
        }
        let passive_hint =
            self.overlay_watched & overlay::watch::HINT_CALLBACK == 0 && hint_watch.is_some();
        if self.overlay_watched & overlay::watch::PRESS != 0
            || (self.overlay_watched & overlay::watch::HINT != 0 && !passive_hint)
        {
            events.set(EventKind::Touch, true);
        } else if self.overlay_watched & overlay::watch::HINT != 0 {
            events.observe(
                EventKind::Touch,
                hint_watch.expect("the passive hint watch"),
            );
        }
        if self.states & crate::tailwind::state::DISABLED != 0 {
            for e in DISABLED_OFF {
                events.set(e, false);
            }
        }
        // A disabled view still shows its hint, as the desktops' do.
        if self.overlay_watched & overlay::watch::HINT != 0 {
            for event in [EventKind::HoverIn, EventKind::HoverOut] {
                if passive_hint {
                    events.observe(event, hint_watch.expect("the passive hint watch"));
                } else {
                    events.set(event, true);
                }
            }
        }
        events
    }

    /// Where its native view goes among its siblings': by `zIndex`, then a
    /// sticky view above the others (as above a page's in-flow boxes),
    /// then in order.
    fn stack_rank(&self) -> (i32, bool) {
        (self.z_index, self.sticky.is_some())
    }

    /// The view style as platforms take it: translations by a fraction of
    /// the size resolved with the current frame, a spare list cell hidden.
    fn mounted_view_style(&self) -> Box<ViewStyle> {
        let mut style = Box::new(self.view_style.clone());
        style.elevation = self.elevation;
        style.backdrop_material = self.backdrop_material;
        // A list in its parent's viewport is a plain view clipping its
        // cells (a scroll view clips its content).
        if self.list.as_ref().is_some_and(|l| l.parent) {
            style.overflow_hidden = true;
        }
        if self.spare {
            style.hidden = true;
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
        if props.pointer_events == crate::props::PointerEvents::Auto {
            props.pointer_events = self.class_pointer;
        }
        if self.states & crate::tailwind::state::DISABLED != 0 {
            props.accessibility.state.disabled = true;
        }
        if self.spare {
            props.accessibility.hidden = true;
        }
        props
    }

    fn new(id: NodeId, kind: Kind, retirement_requests: Rc<Cell<u64>>) -> Self {
        Self {
            id,
            kind,
            inline: false,
            parent: NO_KEY,
            children: Vec::new(),
            layout: None,
            base_layout: None,
            view_style: ViewStyle::default(),
            text_style: TextStyle::default(),
            paint: None,
            animated: Vec::new(),
            drawing: None,
            inline_style: StylePatch::default(),
            class_names: None,
            classes: None,
            class_props: None,
            states: 0,
            tracked: 0,
            projected: 0,
            parts: None,
            positional_children: false,
            spaced: false,
            inherited_color: None,
            child_perspective: None,
            ch: 0.0,
            reads_ch: false,
            color_used: None,
            color_queued: false,
            wants_fixed: false,
            fixed_view: false,
            class_pointer: crate::props::PointerEvents::Auto,
            pointer_auto_inside: false,
            sticky: None,
            insets: None,
            events: EventMask::default(),
            z_index: 0,
            vertical_align: crate::style::VerticalAlign::Baseline,
            rtl: false,
            direction: None,
            logical: None,
            props: None,
            text: String::new(),
            text_source: None,
            paragraph: Paragraph::default(),
            image: matches!(kind, Kind::Image).then(Box::default),
            scroll: matches!(kind, Kind::Scroll | Kind::List).then(Box::default),
            list: matches!(kind, Kind::List).then(|| Box::new(ListState::new(retirement_requests))),
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
            native_root_projected: false,
            frame: Bounds::UNSET,
            overflow: None,
            attached: Vec::new(),
            overlay_watched: 0,
            elevation: Points::ZERO,
            backdrop_material: crate::BackdropMaterial::default(),
            dirty: 0,
            queued: false,
            text_queued: false,
            relaid: false,
            spare: false,
        }
    }
}

/// Taffy context of a text block.
struct TextContext<P> {
    text: Arc<AttributedText>,
    sources: SourceMap,
    source_geometry: Option<SourceGeometry>,
    alignments: crate::AttachmentAlignments,
    /// `text.layout_hash()`, computed once per content.
    layout_hash: u64,
    /// Platform typesetting state, created on first use.
    prepared: Option<P>,
    /// Natural width of the widest UAX #14 unbreakable segment.
    min_content: Option<Points>,
    /// Last measurement: `(max_width, size)`.
    cache: Option<(Option<f32>, Size<Points>)>,
    /// Last final layout sent to the platform and the content box it was
    /// made for (where in the view the text goes).
    laid_out: Option<LaidText>,
    /// New test metadata must be mounted even when the glyphs are unchanged.
    metadata_changed: bool,
}

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
            text,
            sources: SourceMap::default(),
            source_geometry: None,
            prepared: None,
            min_content: None,
            cache: None,
            laid_out: None,
            metadata_changed: false,
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
            let mut text = (*laid.text).clone();
            text.test_ids = self.text.test_ids.clone();
            Arc::new(text)
        };
        laid.text = text.clone();
        self.metadata_changed = false;
        Some((text, laid.layout.clone()))
    }
}

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
            ApplyError::TooManyNodes(_) | ApplyError::IdOutOfRange(_)
        )
    }
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
    slots: Vec<u32>,
    layout: LayoutTree<LeafContext<M::Prepared>>,
    text_engine: Rc<M>,
    measure_cache: MeasureCache,
    /// Text blocks whose final layout must be (re)made after layout.
    pending_text: Vec<Key>,
    /// Text source membership changed, independently of shaping and layout.
    reading_dirty: bool,
    /// Text blocks with attachments (checked for attachments laid out
    /// again).
    attachment_blocks: Vec<Key>,
    /// Live list nodes.
    lists: Vec<Key>,
    /// Request correlation stays unique across list rebuilds and reparented
    /// cells for this core. Native focus remains the only focus authority.
    retirement_requests: Rc<Cell<u64>>,
    /// The lists in their parent's viewport (`viewport="parent"`), outer
    /// ones first ([`Core::resolve_outer`]).
    parent_lists: Vec<Key>,
    /// Views moved in a tree with such lists: their views are found again.
    outer_moved: bool,
    /// Such a list changed length: the commit lays the page out again.
    extent_changed: bool,
    /// The scroll views such lists asked to scroll in this commit.
    outer_asked: Vec<Key>,
    /// The views whose lists' sticky cells changed in this commit.
    sticky_views: Vec<Key>,
    /// Views with `position: sticky` ([`Core::update_sticky_views`]).
    sticky_nodes: Vec<Key>,
    /// The scroll views their ranges were last sent to.
    sticky_scrollers: Vec<Key>,
    /// Sticky views came, went or moved: their ranges are worked out
    /// again.
    sticky_changed: bool,
    /// The warning about `bottom` / `right` sticky insets was logged.
    sticky_warned: bool,
    /// The warning about animated insets of views that are not sticky, or
    /// on the axis their scroll view does not scroll, was logged.
    inset_warned: bool,
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
    list_binds: Vec<ListBind>,
    /// The runtime's lists with overscan cells waiting to bind
    /// ([`Core::take_paced_list_binds`]), in the order they asked.
    paced_lists: Vec<NodeId>,
    /// [`Core::take_paced_list_binds`]'s buffer, reused.
    paced_scratch: Vec<(u32, u32)>,
    /// The events for JS, in order (the platform's and the core's events,
    /// Rust components' events, calls' results).
    events: Vec<crate::ui::JsEvent>,
    /// Reused buffer of `(item index, cell)` for list updates.
    cells_scratch: Vec<(u32, Key)>,
    root: Key,
    viewport: Size<Points>,
    mount: Vec<MountItem>,
    /// Batches handed out so far: tells this batch's mount indexes from
    /// earlier ones'.
    batches: u64,
    /// Imperative calls, run after everything else in the batch.
    commands: Vec<(NodeId, Command)>,
    /// Animates the layout changes of the next commit.
    layout_animation: Option<LayoutAnimation>,
    /// The screens and modals with a `statusBar`, in the order they got
    /// it: few, so attaching and detaching only flag them for the commit.
    status_bar_nodes: Vec<Key>,
    /// The tree changed with `status_bar_nodes` in it: the commit checks
    /// which are in the tree.
    status_bars_moved: bool,
    /// Nodes whose classes say `pointer-events-none`: without any, moving
    /// nodes skips what CSS's inherited `pointer-events` needs.
    pointer_none_classes: u32,
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
    /// What the app may reach ([`Core::set_access`]).
    access: Arc<crate::access::Access>,
    /// Denials already logged (each once).
    denied: rustc_hash::FxHashSet<String>,
    /// Serves the app's clipboard calls in place of the platform
    /// ([`Core::set_clipboard`]).
    clipboard: Option<Arc<dyn crate::clipboard::ClipboardBackend>>,
    /// Answers the app's picks in place of the platform's picker
    /// ([`Core::set_picker`]).
    picker: Option<Arc<dyn crate::picker::PickerBackend>>,
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
        let core = Self::with_engine(text_engine, viewport);
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
        let retirement_requests = Rc::default();
        let mut root = Node::new(ROOT_ID, Kind::View, Rc::clone(&retirement_requests));
        root.layout = Some(root_layout);
        // The platform owns the root view.
        root.created = true;
        let root = nodes.insert(root) as Key;
        layout.set_tag(root_layout, root);
        let mut slots = vec![0; 256];
        slots[ROOT_ID as usize] = root + 1;
        Self {
            nodes,
            slots,
            layout,
            text_engine: Rc::new(text_engine),
            measure_cache: MeasureCache::default(),
            pending_text: Vec::new(),
            reading_dirty: false,
            attachment_blocks: Vec::new(),
            max_nodes: usize::MAX,
            access: Arc::default(),
            denied: Default::default(),
            clipboard: None,
            picker: None,
            components: components::Components::for_viewport(viewport),
            lists: Vec::new(),
            retirement_requests,
            parent_lists: Vec::new(),
            outer_moved: false,
            extent_changed: false,
            outer_asked: Vec::new(),
            sticky_views: Vec::new(),
            sticky_nodes: Vec::new(),
            sticky_scrollers: Vec::new(),
            sticky_changed: false,
            sticky_warned: false,
            inset_warned: false,
            roots: Vec::new(),
            accessories: Default::default(),
            header_heights: (Points(44.0), Points(96.0)),
            safe_area: EdgeInsets::default(),
            list_binds: Vec::new(),
            paced_lists: Vec::new(),
            paced_scratch: Vec::new(),
            events: Vec::new(),
            cells_scratch: Vec::new(),
            root,
            viewport,
            mount: Vec::new(),
            batches: 0,
            commands: Vec::new(),
            layout_animation: None,
            status_bar_nodes: Vec::new(),
            status_bars_moved: false,
            pointer_none_classes: 0,
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

    /// Sets what the app may reach: remote images, canvas images, video
    /// sources, web views and the status bar are checked against it.
    pub fn set_access(&mut self, access: Arc<crate::access::Access>) {
        self.access = access;
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

    /// Keeps the app's storage (`nsh/storage`) in `backend`; `None`: in
    /// memory, for the core's life.
    pub fn set_storage(&mut self, backend: Option<Arc<dyn crate::storage::StorageBackend>>) {
        self.components
            .runtime
            .set_storage(crate::storage::Store::new(backend));
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

    /// Changes the size of the root view.
    pub fn set_viewport(&mut self, viewport: Size<Points>) {
        if viewport != self.viewport {
            self.viewport = viewport;
            let root = self.nodes[self.root as usize].layout.expect("root layout");
            self.layout.set_style(root, root_style(viewport));
            self.needs_layout = true;
            self.restyle_where(crate::tailwind::deps::WIDTH | crate::tailwind::deps::HEIGHT);
            self.components_viewport(viewport);
        }
    }

    /// The native platform's current focus ancestry. Lists consume it only
    /// to keep that existing logical cell alive; the core never chooses focus.
    pub fn set_focus_path(&mut self, path: &[NodeId]) {
        for &list in &self.lists {
            let cell = path.iter().find_map(|&id| {
                let mut cell = self.key(id).ok()?;
                loop {
                    let node = &self.nodes[cell as usize];
                    if node.parent == list && matches!(node.slot, Some(CellSlot::Item(_))) {
                        return Some(cell);
                    }
                    if node.parent == NO_KEY {
                        return None;
                    }
                    cell = node.parent;
                }
            });
            if let Some(state) = self.nodes[list as usize].list.as_mut() {
                state.focus_cell(cell);
            }
        }
    }

    /// Confirms a native list-cell retirement in the input FIFO. Replies to
    /// cancelled requests and to cells removed by their source are inert.
    pub fn retire_list_cell(&mut self, id: NodeId, request: u64, retired: bool) {
        let Ok(cell) = self.key(id) else { return };
        let roots = retired.then(|| self.owned_native_roots(cell));
        let parent = self.nodes[cell as usize].parent;
        let Some(list) = self
            .nodes
            .get_mut(parent as usize)
            .and_then(|node| node.list.as_mut())
        else {
            return;
        };
        if list.retire_cell(cell, request, retired) {
            list.mounted_cells.retain(|&mounted| mounted != id);
            let roots = roots.expect("accepted retirement");
            for &id in &roots {
                if let Ok(key) = self.key(id) {
                    self.nodes[key as usize].native_root_projected = false;
                }
            }
            self.mount.push(MountItem::ListCellRetired { roots });
        }
    }

    /// Core owns logical ancestry even when native presents a descendant
    /// in a modal window, a header or an overlay host outside the cell.
    fn owned_native_roots(&self, cell: Key) -> Vec<NodeId> {
        let mut roots = vec![self.nodes[cell as usize].id];
        // Ordinary row content can be large; only promoted layout roots
        // need independent native parking, not every node below the cell.
        let mut promoted: Vec<_> = self
            .roots
            .iter()
            .filter_map(|&key| {
                let node = &self.nodes[key as usize];
                (key != cell
                    && node.created
                    && self.is_ancestor(cell, key)
                    && (!node.is_overlay()
                        || self.overlay(key).is_some_and(|state| state.host.is_some())))
                .then(|| (self.root_depth(key), key))
            })
            .collect();
        promoted.sort_unstable_by_key(|&(depth, _)| depth);
        for (_, key) in promoted {
            roots.push(self.nodes[key as usize].id);
        }
        roots
    }

    fn has_promoted_roots(&self, owner: Key) -> bool {
        self.roots
            .iter()
            .any(|&key| self.nodes[key as usize].created && self.is_ancestor(owner, key))
    }

    /// Logical ownership changes invalidate the native snapshot on both
    /// sides of a move, before a root can leave or join a retiring cell.
    fn cancel_retiring_ancestors(&mut self, mut key: Key) {
        loop {
            let parent = self.nodes[key as usize].parent;
            if parent == NO_KEY {
                break;
            }
            if let Some(list) = self.nodes[parent as usize].list.as_mut() {
                list.cancel_retirement(key);
            }
            key = parent;
        }
    }

    fn promoted_root_visible(&self, mut key: Key) -> bool {
        loop {
            let node = &self.nodes[key as usize];
            // A nested Text span has no native view; its surrounding text
            // block and every actual native ancestor still own visibility.
            if (!node.created && !(node.inline && node.kind == Kind::Text))
                || node
                    .layout
                    .is_some_and(|layout| self.layout.style(layout).display == taffy::Display::None)
                || (node.is_overlay() && self.overlay(key).is_none_or(|state| state.host.is_none()))
            {
                return false;
            }
            let parent = node.parent;
            if parent == NO_KEY {
                return key == self.root;
            }
            if self.nodes[parent as usize]
                .list
                .as_ref()
                .is_some_and(|list| list.native_visible(key) == Some(false))
            {
                return false;
            }
            key = parent;
        }
    }

    fn native_following(&self, parent: Key, child: Key) -> Vec<NodeId> {
        let parent_id = self.nodes[parent as usize].id;
        if self.nodes[child as usize].is_overlay() {
            return self
                .overlays
                .iter()
                .skip_while(|&&key| key != child)
                .skip(1)
                .filter_map(|&key| {
                    (self.overlay(key)?.host == Some(parent_id))
                        .then_some(self.nodes[key as usize].id)
                })
                .collect();
        }
        let children = &self.nodes[parent as usize].children;
        let Some(position) = children.iter().position(|&key| key == child) else {
            return Vec::new();
        };
        let rank = self.nodes[child as usize].stack_rank();
        let mut following: Vec<_> = children
            .iter()
            .enumerate()
            .filter_map(|(at, &key)| {
                let node = &self.nodes[key as usize];
                (node.created
                    && node.layout.is_some()
                    && !node.is_overlay()
                    && (node.stack_rank(), at) > (rank, position))
                    .then_some((node.stack_rank(), at, node.id))
            })
            .collect();
        following.sort_unstable_by_key(|&(rank, at, _)| (rank, at));
        let mut ids: Vec<_> = following.into_iter().map(|(_, _, id)| id).collect();
        ids.extend(self.overlays.iter().filter_map(|&key| {
            (self.overlay(key)?.host == Some(parent_id)).then_some(self.nodes[key as usize].id)
        }));
        ids
    }

    /// The sole native insertion boundary for promoted roots. The native
    /// consumer selects an actually attached anchor from the core order.
    fn project_root(&mut self, parent: NodeId, key: Key, following: Vec<NodeId>, force: bool) {
        self.cancel_retiring_ancestors(key);
        if self.nodes[key as usize].is_layout_root() {
            if !self.promoted_root_visible(key) {
                if self.nodes[key as usize].native_root_projected {
                    self.remove_owned_roots(key);
                }
                return;
            }
            if !force && self.nodes[key as usize].native_root_projected {
                return;
            }
            self.nodes[key as usize].native_root_projected = true;
        }
        self.mount.push(MountItem::ProjectRoot {
            parent,
            id: self.nodes[key as usize].id,
            following,
        });
    }

    fn emit_insert(&mut self, parent: NodeId, child: NodeId, before: Option<NodeId>) {
        let Ok(key) = self.key(child) else { return };
        if self.nodes[key as usize].is_layout_root() {
            let Ok(host) = self.key(parent) else { return };
            self.project_root(parent, key, self.native_following(host, key), true);
            self.reproject_roots(key, false);
        } else {
            let carries_roots = self.has_promoted_roots(key);
            if carries_roots {
                self.cancel_retiring_ancestors(key);
            }
            self.mount.push(MountItem::Insert {
                parent,
                child,
                before,
            });
            if carries_roots {
                self.reproject_roots(key, false);
            }
        }
    }

    fn reproject_roots(&mut self, owner: Key, force: bool) {
        let skip_owner = usize::from(!self.nodes[owner as usize].is_layout_root());
        for id in self.owned_native_roots(owner).into_iter().skip(skip_owner) {
            let Ok(key) = self.key(id) else { continue };
            let node = &self.nodes[key as usize];
            let parent = if node.is_overlay() {
                self.overlay(key).and_then(|state| state.host)
            } else {
                let parent = node.parent;
                (parent != NO_KEY && self.nodes[parent as usize].created)
                    .then(|| self.nodes[parent as usize].id)
            };
            if let Some(parent) = parent {
                let host = self.key(parent).expect("native host");
                self.project_root(parent, key, self.native_following(host, key), force);
            } else if self.nodes[key as usize].native_root_projected {
                self.remove_owned_roots(key);
            }
        }
    }

    fn emit_remove(&mut self, id: NodeId) {
        if let Ok(key) = self.key(id) {
            self.nodes[key as usize].native_root_projected = false;
        }
        self.mount.push(MountItem::Remove { id });
    }

    fn remove_owned_roots(&mut self, cell: Key) {
        for id in self.owned_native_roots(cell).into_iter().rev() {
            self.emit_remove(id);
        }
    }

    /// A bind may have waited across a source change or native input. Never
    /// let a queued request replace a different or still-native cell owner.
    pub fn current_list_bind(&self, id: NodeId, slot: u32, index: u32) -> bool {
        self.key(id)
            .ok()
            .and_then(|key| self.nodes[key as usize].list.as_ref())
            .is_some_and(|list| list.current_bind(slot, index))
    }

    /// Whether native input still addresses an item in the current source.
    /// A deleted assignment stays quarantined until native has removed its
    /// old projection; input arriving before that removal cannot run it.
    pub fn accepts_native_input(&self, id: NodeId) -> bool {
        let Ok(mut key) = self.key(id) else {
            return true;
        };
        loop {
            let node = &self.nodes[key as usize];
            let parent = node.parent;
            if parent == NO_KEY {
                return true;
            }
            if matches!(node.slot, Some(CellSlot::Item(_)))
                && self.nodes[parent as usize]
                    .list
                    .as_ref()
                    .is_some_and(|list| list.source_live(key) != Some(true))
            {
                return false;
            }
            key = parent;
        }
    }

    fn revoke_list_source(&mut self, list: Key, cells: Vec<Key>) {
        for cell in cells {
            let id = self.nodes[cell as usize].id;
            // Source deletion is unconditional, including native focus.
            // The existing retirement acknowledgement then releases reuse.
            self.remove_owned_roots(cell);
            let state = self.nodes[list as usize].list.as_mut().expect("list");
            state.mounted_cells.retain(|&mounted| mounted != id);
            let Some(request) = state.retirement_request(cell) else {
                continue;
            };
            self.mount.push(MountItem::RetireListCell {
                id,
                request,
                roots: self.owned_native_roots(cell),
            });
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
        if let Some(scroll) = node.scroll.as_mut() {
            scroll.offset = (x, y);
            if !scroll.dependents.is_empty() {
                scroll.pending.retain(|&(n, _)| n > applied);
                dependents = true;
            }
        }
        if let Some(list) = node.list.as_mut() {
            list.reported(if horizontal { x } else { y }, applied);
        }
        if dependents {
            self.dependents_dirty(key);
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

    /// Moves what the core hands JS (events it raised, such as
    /// `onLoadMore` and `onLayout`, Rust components' events, calls'
    /// results) into `out`, in order.
    pub fn take_events(&mut self, out: &mut Vec<crate::ui::JsEvent>) {
        out.append(&mut self.events);
    }

    /// Registers a custom font (TrueType / OpenType data) with the text
    /// engine. Text measured before is measured again.
    pub fn register_font(&mut self, data: &[u8]) -> Result<(), String> {
        self.text_engine.register_font(data)?;
        self.fonts_changed();
        Ok(())
    }

    /// The text engine's fonts changed (a font the platform loads
    /// asynchronously became usable): text measured before is measured
    /// again.
    pub fn fonts_changed(&mut self) {
        self.zero_advances.clear();
        self.ch_changed(self.root);
        self.measure_cache = MeasureCache::default();
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
            cx.laid_out = None;
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
                    event: EventKind::BackPress | EventKind::KeyCommand,
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
        match op {
            Op::Rust(op) => {
                self.run_rust(op);
                Ok(())
            }
            Op::Create { id, tag } => self.create(id, tag),
            Op::CreateText { id, text } => {
                let key = self.alloc(id, Kind::RawText)?;
                self.nodes[key as usize].text = text;
                Ok(())
            }
            Op::SetText { id, text } => {
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
            Op::SetProp { id, prop } => self.set_prop(id, prop),
            Op::Listen { id, event, enabled } => {
                let key = self.key(id)?;
                let node = &mut self.nodes[key as usize];
                let before = node.events;
                node.events.set(event, enabled);
                // A listener added after layout still learns the frame.
                if event == EventKind::Layout && enabled && !before.contains(event) {
                    let f = node.frame;
                    if !f.origin.x.0.is_nan() {
                        self.events.push(crate::ui::JsEvent::Event(
                            id,
                            event,
                            EventPayload::Layout(f),
                        ));
                    }
                }
                if node.events != before {
                    let relink = node.inline && (pressable(before) || pressable(node.events));
                    self.mark(key, dirty::EVENTS);
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
                let child = self.key(child)?;
                if self.nodes[child as usize].parent != parent {
                    return Err(ApplyError::NotAChild(self.nodes[child as usize].id));
                }
                self.detach(child);
                Ok(())
            }
            Op::Release { id } => self.release(id),
            Op::Animation(op) => {
                self.mount.push(MountItem::Animation(op));
                Ok(())
            }
            Op::Draw { id, mut drawing } => {
                let key = self.key(id)?;
                if self.nodes[key as usize].kind != Kind::Canvas {
                    return Ok(());
                }
                if !self.access.is_unrestricted() {
                    let access = self.access.clone();
                    let mut refused = Vec::new();
                    drawing.ops.retain(|op| match op {
                        crate::canvas::CanvasOp::DrawImage { image, .. }
                            if !access.allows_media(&image.uri) =>
                        {
                            refused.push(image.uri.clone());
                            false
                        }
                        _ => true,
                    });
                    for uri in refused {
                        self.deny(not_granted("a canvas image", &uri, "network"));
                    }
                }
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
                node.drawing = Some(Arc::from(drawing));
                let flags = dirty::CANVAS | if slots_changed { dirty::ANIMATION } else { 0 };
                self.mark(key, flags);
                Ok(())
            }
            Op::Command {
                command: Command::LayoutAnimation(animation),
                ..
            } => {
                self.layout_animation = Some(animation);
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
            Op::Command { id, mut command } => {
                let key = self.key(id)?;
                if let Command::ReplaceRange { count, .. } = &mut command {
                    let Some(input) = self.nodes[key as usize].input.as_ref() else {
                        return Ok(());
                    };
                    *count = input.count;
                }
                if matches!(command, Command::ScrollToEnd { .. }) {
                    log::debug!(target: "nsh::scroll", "core_scroll_to_end_received node={id} created={} list={}", self.nodes[key as usize].created, self.nodes[key as usize].list.is_some());
                }
                self.commands.push((id, command));
                Ok(())
            }
        }
    }

    /// Finishes a turn: rebuilds text, runs layout, updates lists and
    /// returns the mount items, or `None` when nothing changed.
    pub fn commit(&mut self) -> Option<MountBatch> {
        self.commit_round();
        // The components' own lists bind the cells the layout asked for
        // here, and lay out again (JS's lists ask JS, through the engine);
        // a list in its parent's viewport that changed length lays the
        // page out again, so it settles in this batch.
        for _ in 0..MAX_VIRTUAL_ROUNDS {
            if !self.bind_virtual_lists() && !std::mem::take(&mut self.extent_changed) {
                break;
            }
            self.commit_round();
        }
        if !self.outer_asked.is_empty() {
            self.send_outer_scrolls();
        }
        if self.mount.is_empty() || matches!(self.mount[..], [MountItem::LayoutAnimation(_)]) {
            self.mount.clear();
            None
        } else {
            self.batches += 1;
            Some(MountBatch {
                items: std::mem::take(&mut self.mount),
            })
        }
    }

    /// One round of a commit: views, layout, lists, commands, into the
    /// mount items.
    fn commit_round(&mut self) {
        // The views' patches and the views to make first.
        self.render_components();
        self.sync_colors();
        self.sync_ch();
        self.sync_fixed();
        self.sync_overlays();
        self.sync_back();
        self.sync_keys();
        // Platforms animate the frames, insertions and removals that follow
        // in the batch; ops may already have queued some.
        if let Some(animation) = self.layout_animation.take() {
            self.mount.insert(0, MountItem::LayoutAnimation(animation));
        }
        self.flush_dirty();
        let relayout = self.needs_layout;
        if relayout {
            self.needs_layout = false;
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
        }
        self.update_lists(relayout);
        self.reading_dirty = false;
        if !self.overlays.is_empty() {
            self.place_overlays();
        }
        self.flush_text();
        // What this turn's status bar settings add up to, once.
        self.sync_status_bars();
        if let Some(config) = self.components.status_bars.take_changed() {
            self.commands
                .push((crate::ROOT_ID, Command::StatusBar(config)));
        }
        // The components' measurements, with this commit's layout as JS's.
        for (id, answer) in std::mem::take(&mut self.components.measures) {
            answer.borrow_mut().deliver(self.measure(id));
        }
        // On native views, or a published text link for focus commands;
        // dropped for targets that were never shown.
        let mut kept = Vec::new();
        for (id, mut command) in std::mem::take(&mut self.commands) {
            // Answered here, with this commit's layout (null for views that
            // are gone or not shown).
            if let Command::Measure { call } = command {
                self.answer_measure(id, call);
                continue;
            }
            let Ok(key) = self.key(id) else { continue };
            let node = &self.nodes[key as usize];
            if !node.created
                && !(matches!(
                    command,
                    Command::Focus | Command::Blur | Command::AccessibilityFocus
                ) && self.mounted_link(key))
            {
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
            // Lists resolved theirs in `update_lists`; a scroll view can
            // still scroll to its end.
            match &command {
                Command::ImageInfo { id: request, uri } if !self.access.allows_media(uri) => {
                    let message = not_granted("Image.getSize / prefetch of", uri, "network");
                    self.answer_image_info(*request, Err(message.clone()));
                    self.deny(message);
                    continue;
                }
                Command::SetClipboard(_)
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
                    self.deny("the clipboard is not granted: add `\"clipboard\": true` to capabilities in nsh.json".into());
                    continue;
                }
                // A clipboard of the embedder's own answers in place of
                // the platform's.
                Command::SetClipboard(_)
                | Command::ReadClipboard { .. }
                | Command::SetClipboardImage(_)
                | Command::ReadClipboardImage { .. }
                | Command::ReadClipboardFiles { .. }
                    if self.clipboard.is_some() =>
                {
                    let clipboard = self.clipboard.clone().expect("a clipboard");
                    match &command {
                        Command::SetClipboard(text) => clipboard.set_text(Some(text.clone())),
                        Command::SetClipboardImage(_) => clipboard.set_text(None),
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
                // Checked before the grants: a host may put the name in a
                // path or a URL, where `user.x/../admin` leaves `user.*`.
                Command::HostCall { id: call, name, .. }
                    if !crate::access::valid_host_name(name) =>
                {
                    let message = format!(
                        "nsh/host: invalid function name {name:?} ({})",
                        crate::access::HOST_NAME_CHARS
                    );
                    self.answer_host(*call, Err(message.clone()));
                    self.deny(message);
                    continue;
                }
                Command::HostCall { id: call, name, .. } if !self.access.allows_host(name) => {
                    let message = format!(
                        "nsh/host: `{name}` is not granted: add it to capabilities.host in nsh.json"
                    );
                    self.answer_host(*call, Err(message.clone()));
                    self.deny(message);
                    continue;
                }
                Command::StatusBar(_) if !self.access.allows_status_bar() => {
                    self.deny("the status bar is not granted: add `\"statusBar\": true` to capabilities in nsh.json".into());
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
            }
            self.mount.push(MountItem::Command { id, command });
        }
        self.commands.append(&mut kept);
    }

    /// A span's focus commands use its published link under a native text block.
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
                        .is_some_and(|cx| matches!(cx, LeafContext::Text(cx)
                            if cx.text.links.iter().any(|link| link.node == span.id && link.start < link.end)));
            }
            parent = block.parent;
        }
        false
    }

    #[inline]
    fn key(&self, id: NodeId) -> Result<Key, ApplyError> {
        match self.slots.get(id as usize) {
            Some(&k) if k != 0 => Ok(k - 1),
            _ => Err(ApplyError::UnknownNode(id)),
        }
    }

    fn alloc(&mut self, id: NodeId, kind: Kind) -> Result<Key, ApplyError> {
        let idx = id as usize;
        if self.nodes.len() >= self.max_nodes {
            return Err(ApplyError::TooManyNodes(self.max_nodes));
        }
        if idx > self.slots.len().saturating_add(self.max_nodes) {
            return Err(ApplyError::IdOutOfRange(id));
        }
        if idx >= self.slots.len() {
            self.slots.resize((idx + 1).next_power_of_two(), 0);
        } else if self.slots[idx] != 0 {
            return Err(ApplyError::DuplicateNode(id));
        }
        let key = self
            .nodes
            .insert(Node::new(id, kind, Rc::clone(&self.retirement_requests)))
            as Key;
        self.slots[idx] = key + 1;
        Ok(key)
    }

    /// Makes `alias` another name of node `id`: a component whose view's
    /// root is another component makes that one on its own host, under a
    /// name of its own (the nested component's host), with no node of its
    /// own. What the core sends names the node by its own id.
    pub(super) fn alias(&mut self, alias: NodeId, id: NodeId) -> Result<(), ApplyError> {
        let key = self.key(id)?;
        let idx = alias as usize;
        if idx > self.slots.len().saturating_add(self.max_nodes) {
            return Err(ApplyError::IdOutOfRange(alias));
        }
        if idx >= self.slots.len() {
            self.slots.resize((idx + 1).next_power_of_two(), 0);
        } else if self.slots[idx] != 0 {
            return Err(ApplyError::DuplicateNode(alias));
        }
        self.slots[idx] = key + 1;
        Ok(())
    }

    /// Whether `id` is another name of a node ([`Self::alias`]).
    pub(super) fn is_alias(&self, id: NodeId) -> bool {
        self.key(id).is_ok_and(|k| self.nodes[k as usize].id != id)
    }

    /// Forgets alias `id` (its node stays).
    pub(super) fn unalias(&mut self, id: NodeId) {
        if self.is_alias(id) {
            self.slots[id as usize] = 0;
        }
    }

    /// The id node `id` has natively (another for an alias).
    pub(super) fn native_id(&self, id: NodeId) -> NodeId {
        self.key(id).map_or(id, |k| self.nodes[k as usize].id)
    }

    fn create(&mut self, id: NodeId, tag: Tag) -> Result<(), ApplyError> {
        let kind = Kind::of(tag);
        let key = self.alloc(id, kind)?;
        let mut style = Style::default().layout;
        crate::style::resolve_normal_alignment(&mut style);
        let layout = match leaf_context(kind) {
            Some(context) => self.layout.new_leaf_with_context(style.clone(), context),
            None => self.layout.new_leaf(style.clone()),
        };
        self.layout.set_tag(layout, key);
        self.nodes[key as usize].layout = Some(layout);
        self.became(key, style);
        Ok(())
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
        let unsent = self
            .mount
            .iter()
            .any(|m| matches!(m, MountItem::Create { id: c, .. } if *c == id));
        if node.kind != Kind::View || !node.children.is_empty() || (node.created && !unsent) {
            return false;
        }
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
        self.mount.retain(|m| {
            !matches!(m, MountItem::Create { id: c, .. } | MountItem::Insert { child: c, .. } if *c == id)
        });
        // The kind's own state and layout.
        let fresh = Node::new(id, kind, Rc::clone(&self.retirement_requests));
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
        self.layout.set_node_context(layout, leaf_context(kind));
        let style = self.layout.style(layout).clone();
        self.became(key, style);
        if let Some((parent, before)) = at {
            let _ = self.insert(parent, id, before);
        }
        true
    }

    /// Rebuilds the text an input is measured with: its value, else its
    /// placeholder, else an empty line.
    fn measure_input(&mut self, key: Key) {
        let node = &self.nodes[key as usize];
        let (Some(input), Some(layout)) = (&node.input, node.layout) else {
            return;
        };
        let placeholder = input.value.is_empty() && !input.config.placeholder.is_empty();
        let text = self.input_text(
            key,
            if placeholder {
                &input.config.placeholder
            } else {
                &input.value
            },
        );
        let cx = self.text_cx(layout);
        let same = cx.text.layout_eq(&text);
        let input = self.nodes[key as usize]
            .input
            .as_mut()
            .expect("input state");
        // A value that reads as the placeholder measures the same, but
        // its content size is the value's: laid out again to report it.
        if same && input.placeholder_measured == placeholder {
            return;
        }
        input.placeholder_measured = placeholder;
        if !same {
            *self.text_cx(layout) = TextContext::new(Arc::new(text));
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
        text.push(content, style);
        // An empty last line still takes space (a trailing line break, or no
        // text at all).
        if content.is_empty() || (multiline && content.ends_with('\n')) {
            text.push("\u{200b}", style);
        }
        text
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
                // Cells are their own layout roots (laid out at the list's
                // cross size, positioned by the list): a change in one row
                // never relayouts the rest of the tree.
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
        self.layout.set_style(layout, style);
        self.needs_layout = true;
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
        if node.classes.is_some() || node.spaced {
            self.restyle(key);
            return Ok(());
        }
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
        let node = &mut self.nodes[key as usize];
        if let Some([padding, margin]) = node.insets.as_deref() {
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
        let display_changed = node.layout.is_some_and(|id| {
            (self.layout.style(id).display == taffy::Display::None)
                != (layout.display == taffy::Display::None)
        });
        // `objectPosition` is the image's (`MountItem::Image`), not the view's.
        let position_changed = node.view_style.object_position != view.object_position;
        let view_changed = display_changed
            || if position_changed {
                node.view_style
                    != ViewStyle {
                        object_position: node.view_style.object_position,
                        ..view.clone()
                    }
            } else {
                node.view_style != view
            };
        // A span's background is part of its block's text.
        let span_background_changed = node.inline
            && node.kind == Kind::Text
            && span_background(&node.view_style, node.id) != span_background(&view, node.id);
        let text_changed = node.text_style != text || span_background_changed;
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
        node.view_style = view;
        node.text_style = text;
        node.paint = paint;
        node.animated = animated;
        node.z_index = z_index;
        node.vertical_align = vertical_align;
        if align_changed {
            self.mark_text_block(key);
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
        if node.kind.derives_layout() || node.fixed_view {
            node.base_layout = Some(Box::new(layout));
            self.sync_layout_style(key);
        } else if let Some(l) = node.layout {
            self.layout.set_style(l, layout);
            self.needs_layout = true;
        }
        let mut flags = 0;
        if view_changed {
            flags |= dirty::VIEW;
        }
        if position_changed && self.nodes[key as usize].image.is_some() {
            flags |= dirty::IMAGE;
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
                Kind::Text => self.mark_text_block(key),
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
        if display_changed && self.has_promoted_roots(key) {
            self.reproject_roots(key, false);
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
                _ => stack.extend_from_slice(&self.nodes[k as usize].children),
            }
        }
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

    /// Lays `key` out in the other direction: its left and right properties
    /// trade places (their start / end ones with them).
    fn flip_direction(&mut self, key: Key, rtl: bool) {
        let direction = if rtl {
            taffy::Direction::Rtl
        } else {
            taffy::Direction::Ltr
        };
        let node = &mut self.nodes[key as usize];
        node.rtl = rtl;
        let mut view = node.view_style.clone();
        let kind = node.kind;
        if let Some(base) = node.base_layout.as_deref_mut() {
            crate::style::swap_sides(base, &mut view);
            base.direction = direction;
            node.view_style = view;
            self.sync_layout_style(key);
        } else if let Some(l) = node.layout {
            let mut layout = self.layout.style(l).clone();
            crate::style::swap_sides(&mut layout, &mut view);
            layout.direction = direction;
            self.nodes[key as usize].view_style = view;
            self.layout.set_style(l, layout);
            self.needs_layout = true;
        }
        self.mark(key, dirty::VIEW);
        if self.reads_direction(key) {
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

    /// `prop` with what the app may not reach removed: a refused image
    /// fails (`onError`), a refused video or web view source shows nothing.
    fn check_prop(&mut self, key: Key, prop: Prop) -> Prop {
        if self.access.is_unrestricted() {
            return prop;
        }
        let node = &self.nodes[key as usize];
        let (id, kind) = (node.id, node.kind);
        // Always reported: the `onError` listener may be set after the
        // source (JS finds the handler when the event is delivered).
        let refuse = |core: &mut Self, what: &str, uri: &str, capability: &str| {
            let message = not_granted(what, uri, capability);
            core.events.push(crate::ui::JsEvent::Event(
                id,
                EventKind::Error,
                EventPayload::Error {
                    message: message.clone(),
                },
            ));
            core.deny(message);
        };
        match prop {
            Prop::Source(Some(source)) if !self.access.allows_media(&source.uri) => {
                refuse(self, "the image", &source.uri, "network");
                Prop::Source(None)
            }
            Prop::Image(ImageProp::Placeholder(Some(source)))
                if !self.access.allows_media(&source.uri) =>
            {
                refuse(self, "the placeholder", &source.uri, "network");
                Prop::Image(ImageProp::Placeholder(None))
            }
            Prop::Native(NativeProp::Src(Some(url)))
                if kind == Kind::Video && !self.access.allows_media(&url) =>
            {
                refuse(self, "the video", &url, "network");
                Prop::Native(NativeProp::Src(None))
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
                self.deny(
                    "web views are not granted: add `webview` to capabilities in nsh.json".into(),
                );
                Prop::Native(NativeProp::Html(None))
            }
            Prop::Native(NativeProp::Source(crate::WebSource::Uri(uri)))
                if kind == Kind::Video && !self.access.allows_media(&uri) =>
            {
                refuse(self, "the video", &uri, "network");
                Prop::Native(NativeProp::Source(crate::WebSource::None))
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
                self.deny(
                    "web views are not granted: add `webview` to capabilities in nsh.json".into(),
                );
                Prop::Native(NativeProp::Source(crate::WebSource::None))
            }
            prop => prop,
        }
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
                return Ok(());
            }
            Prop::ComponentRender(slot) => {
                self.set_render_holder(id, slot);
                return Ok(());
            }
            Prop::RustProp(name, value) => {
                if !self.set_component_prop(id, name, value) {
                    log::warn!(target: "js", "a Rust component's prop on node {id}, which hosts none");
                }
                return Ok(());
            }
            prop => prop,
        };
        let prop = self.check_prop(key, prop);
        if let Prop::Screen(ScreenProp::StatusBar(setting)) = prop {
            self.set_status_bar(key, setting);
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
                Prop::Scrollbar(false) => list::ignored::SCROLLBAR,
                Prop::Refreshing(true) => list::ignored::REFRESH,
                Prop::ScrollValue(Some(_)) => list::ignored::SCROLL_VALUE,
                _ => 0,
            };
            self.warn_ignored(key);
            return Ok(());
        }
        let node = &mut self.nodes[key as usize];
        let mut flags = 0;
        let mut rebuild_span = false;
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
                    }
                    flags |= dirty::IMAGE;
                }
            }
            Prop::ResizeMode(mode) => {
                if let Some(image) = node.image.as_mut() {
                    image.resize_mode = mode;
                    flags |= dirty::IMAGE;
                } else if let Some(control) = node.control.as_mut() {
                    apply_native(control, NativeProp::VideoResizeMode(mode));
                    flags |= dirty::NATIVE;
                }
            }
            Prop::Horizontal(horizontal) => {
                if let Some(scroll) = node.scroll.as_mut()
                    && scroll.horizontal != horizontal
                {
                    scroll.horizontal = horizontal;
                    self.reading_dirty = true;
                    flags |= dirty::SCROLL;
                    if let Some(list) = node.list.as_mut() {
                        list.set_horizontal(horizontal);
                    }
                    let children = node.children.clone();
                    self.sync_layout_style(key);
                    for child in children {
                        self.sync_layout_style(child);
                    }
                    if self.nodes[key as usize]
                        .list
                        .as_ref()
                        .is_some_and(|l| l.parent)
                    {
                        self.sync_spacer(key, true);
                        self.outer_moved = true;
                    }
                }
            }
            Prop::Scrollbar(shows) => {
                if let Some(scroll) = node.scroll.as_mut() {
                    scroll.scrollbar_visible = shows;
                    flags |= dirty::SCROLL;
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
                        ScrollProp::ContentInset(i) => b.content_inset = i,
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
                if let Some(scroll) = node.scroll.as_mut() {
                    scroll.scroll_value = value;
                    flags |= dirty::SCROLL;
                }
            }
            Prop::PullValue(value) => {
                if let Some(scroll) = node.scroll.as_mut() {
                    scroll.pull_value = value;
                    flags |= dirty::SCROLL;
                }
            }
            Prop::Count(count) => {
                let revoked = node
                    .list
                    .as_mut()
                    .map(|list| list.set_count(count))
                    .unwrap_or_default();
                self.revoke_list_source(key, revoked);
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
                let revoked = if let Some(list) = node.list.as_mut() {
                    list.loads_at_start = loads_at_start;
                    list.splice(at, removed, inserted)
                } else {
                    Vec::new()
                };
                self.revoke_list_source(key, revoked);
            }
            Prop::Columns(columns) => {
                if let Some(list) = node.list.as_mut() {
                    list.set_columns(columns);
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
                    list.source_rows = source;
                    list.source_dirty = true;
                    list.dirty = true;
                    self.reading_dirty = true;
                }
            }
            Prop::ListContent(content) => {
                if let Some(list) = node.list.as_mut() {
                    list.set_content(content);
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
                    // Parent cells contribute to the outer reader's source index.
                    self.reading_dirty |= list.parent;
                }
            }
            Prop::PanValues(x, y) => {
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
                node.gestures.pinch = value;
                flags |= dirty::PAN;
            }
            Prop::RotationValue(value) => {
                node.gestures.rotation = value;
                flags |= dirty::PAN;
            }
            Prop::NumberOfLines(lines) => {
                if node.paragraph.lines != lines {
                    node.paragraph.lines = lines;
                    self.mark_text_block(key);
                }
            }
            Prop::TextSource(source) => {
                if node.kind == Kind::Text && node.text_source != source {
                    node.text_source = source;
                    self.mark_text_block(key);
                }
            }
            Prop::EllipsizeMode(mode) => {
                node.paragraph.ellipsize_set = true;
                if node.paragraph.ellipsize != mode {
                    node.paragraph.ellipsize = mode;
                    self.mark_text_block(key);
                }
            }
            Prop::AllowFontScaling(allow) => {
                if node.paragraph.allow_font_scaling != allow {
                    node.paragraph.allow_font_scaling = allow;
                    self.font_settings_changed(key);
                }
            }
            Prop::Selectable(on) => {
                if node.paragraph.selectable != on {
                    node.paragraph.selectable = on;
                    self.mark_text_block(key);
                }
            }
            Prop::SelectionColor(color) if node.input.is_none() => {
                if node.paragraph.selection_color != color {
                    node.paragraph.selection_color = color;
                    self.mark_text_block(key);
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
            Prop::ProjectedStates(states) => {
                self.set_projected_states(key, states);
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
            Prop::WindowDrag(value) => {
                let props = node.props.get_or_insert_default();
                if props.window_drag != value {
                    props.window_drag = value;
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
            Prop::SelectionArea(value) => {
                let props = node.props.get_or_insert_default();
                if props.selection_area != value {
                    props.selection_area = value;
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
                }
                let selected =
                    (a.state.selected != before.state.selected).then_some(a.state.selected);
                let is_checked =
                    |s: &crate::AccessibilityState| s.checked == Some(crate::Checked::True);
                let checked = (is_checked(&a.state) != is_checked(&before.state))
                    .then(|| is_checked(&a.state));
                let is_mixed =
                    |s: &crate::AccessibilityState| s.checked == Some(crate::Checked::Mixed);
                let indeterminate =
                    (is_mixed(&a.state) != is_mixed(&before.state)).then(|| is_mixed(&a.state));
                if *a != before {
                    flags |= if label_only {
                        dirty::LABEL
                    } else {
                        dirty::VIEW_PROPS
                    };
                }
                if selected.is_some() || checked.is_some() || indeterminate.is_some() {
                    if flags != 0 {
                        self.mark(key, flags);
                        if self.nodes[key as usize].kind == Kind::Text {
                            self.mark_text_block(key);
                        }
                    }
                    if let Some(selected) = selected {
                        self.set_selected(key, selected);
                    }
                    if let Some(checked) = checked {
                        self.set_checked(key, checked);
                    }
                    if let Some(indeterminate) = indeterminate {
                        self.set_indeterminate(key, indeterminate);
                    }
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
                        ScreenProp::HeaderBackTitle(v) => c.back_title = v,
                        ScreenProp::HeaderBackVisible(v) => c.back_visible = v,
                        ScreenProp::HeaderRightSystemItem(v) => c.right_system_item = v,
                        ScreenProp::PopOnSwipe(v) => c.gesture_enabled = v,
                        ScreenProp::PopOnBack(v) => c.prevent_back = !v,
                        ScreenProp::Animation(v) => c.animation = v,
                        // Taken by `set_prop`.
                        ScreenProp::StatusBar(_) => {}
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
                }
                return Ok(());
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
                    OverlayProp::FocusReturn(v) => c.focus_return = v,
                    OverlayProp::Hint(v) => c.hint = v,
                    OverlayProp::HintOnFocus(v) => c.hint_on_focus = v,
                    OverlayProp::Open(v) => c.open = v,
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
                if let Some(scroll) = node.scroll.as_mut() {
                    self.reading_dirty |= scroll.behavior.enabled != on;
                    scroll.behavior.enabled = on;
                    flags |= dirty::SCROLL_BEHAVIOR;
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
                        true
                    }
                    Prop::InputTokens(tokens) => {
                        c.tokens = tokens;
                        false
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
        if rebuild_span {
            self.mark_text_block(key);
        }
        Ok(())
    }

    fn insert(
        &mut self,
        parent_id: NodeId,
        child_id: NodeId,
        before: Option<NodeId>,
    ) -> Result<(), ApplyError> {
        let parent = self.key(parent_id)?;
        let child = self.key(child_id)?;
        let before = before.map(|b| self.key(b)).transpose()?;
        if child == self.root || self.is_ancestor(child, parent) {
            return Err(ApplyError::Cycle(child_id));
        }
        if let Some(b) = before
            && (b == child || self.nodes[b as usize].parent != parent)
        {
            return Err(ApplyError::BadAnchor(self.nodes[b as usize].id));
        }

        let previous_parent = self.nodes[child as usize].parent;
        let carries_roots = self.has_promoted_roots(child);

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
            Some(b) => p
                .children
                .iter()
                .position(|&c| c == b)
                .expect("anchor is a child"),
            None => p.children.len(),
        };
        self.set_inline(child, inline);
        self.nodes[child as usize].parent = parent;
        self.nodes[parent as usize].children.insert(pos, child);
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
                let index = self.render_index(parent, pos);
                let parent_layout = self.nodes[parent as usize]
                    .layout
                    .expect("block parent has layout");
                self.layout
                    .insert_child_at_index(parent_layout, index as usize, child_layout);
            }
            self.needs_layout = true;
            // An overlay's native view goes to its root view
            // (`sync_overlays`).
            if parent_created && !self.nodes[child as usize].is_overlay() {
                self.ensure_created(child);
                // Lists attach confirmed cells in item order, independently
                // of the runtime's stable recycling-slot ownership.
                if self.nodes[parent as usize].list.is_none() {
                    let before = self.native_before(parent, child);
                    // By the nodes' own ids (the ops may name an alias).
                    self.emit_insert(
                        self.nodes[parent as usize].id,
                        self.nodes[child as usize].id,
                        before,
                    );
                }
            }
        }
        if carries_roots && previous_parent != NO_KEY && previous_parent != parent {
            self.reproject_roots(child, true);
        }
        Ok(())
    }

    /// Detaches `key` from its parent (Remove op).
    fn detach(&mut self, key: Key) {
        self.unlink(key, true);
    }

    /// Unlinks `key` from its parent's children, layout and (optionally)
    /// native hierarchy.
    fn unlink(&mut self, key: Key, emit_remove: bool) {
        if self.has_promoted_roots(key) {
            self.cancel_retiring_ancestors(key);
        }
        let parent = self.nodes[key as usize].parent;
        let siblings = &mut self.nodes[parent as usize].children;
        let pos = siblings
            .iter()
            .position(|&c| c == key)
            .expect("child of parent");
        siblings.remove(pos);
        if let Some(list) = self.nodes[parent as usize].list.as_mut() {
            list.remove_cell(key);
        }
        if self.nodes[parent as usize].positional_children {
            self.positions_changed(parent);
        }
        self.nodes[key as usize].parent = NO_KEY;
        if self.nodes[parent as usize].child_perspective.is_some() {
            // Without the perspective wherever it goes next.
            self.mark(key, dirty::VIEW | dirty::ANIMATION);
        }
        self.spacing_changed(parent, NO_KEY);
        if self.pointer_none_classes > 0 && self.pointer_region(parent).is_some() {
            // It no longer inherits the region's `none`.
            self.update_pointer_events(key);
            self.pointer_events_moved(parent);
        }
        self.groups_changed(key, parent);
        self.status_bars_moved |= !self.status_bar_nodes.is_empty();
        self.outer_moved |= !self.parent_lists.is_empty() && self.may_hold_page_list(key);
        self.sticky_changed |= !self.sticky_nodes.is_empty();
        let node = &self.nodes[key as usize];
        let (inline, layout, created) = (node.inline, node.layout, node.created);
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
                self.remove_owned_roots(key);
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
        let key = self.key(id)?;
        if key == self.root {
            return Ok(());
        }
        // What the core made for its `tooltip` goes first, out of it.
        if !self.overlay_state.tooltips.is_empty() {
            self.tooltip_released(id);
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
        self.ch_readers -= usize::from(node.reads_ch);
        self.slots[id as usize] = 0;
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
        if let Some((spacer, _)) = node.list.as_ref().and_then(|l| l.spacer) {
            self.layout.remove(spacer);
        }
        if node.kind == Kind::Text {
            self.attachment_blocks.retain(|&k| k != key);
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
        // Children are released by their own ops (the whole subtree became
        // unreachable in JS); orphan them so they never point at a dead key.
        for &c in &node.children {
            if let Some(child) = self.nodes.get_mut(c as usize) {
                child.parent = NO_KEY;
            }
        }
        if let Some(layout) = node.layout {
            self.layout.remove(layout);
        }
        if node.created || (node.inline && node.kind == Kind::Text) {
            // A virtual press target still has a native lifetime. Releasing
            // and recreating the same id in one batch must cancel its old
            // captured contact and focus before the replacement text mounts.
            self.mount.push(MountItem::Delete { id });
        }
        Ok(())
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
        let children = &self.nodes[parent as usize].children;
        let z = self.nodes[child as usize].stack_rank();
        let pos = children.iter().position(|&c| c == child)?;
        let mut best: Option<((i32, bool), usize, NodeId)> = None;
        for (i, &c) in children.iter().enumerate() {
            let n = &self.nodes[c as usize];
            if c == child || !n.created || n.layout.is_none() {
                continue;
            }
            if n.is_overlay() {
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

    /// `key`'s `zIndex` changed: moves its native view among its siblings.
    fn restack(&mut self, key: Key) {
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
        self.emit_insert(p.id, id, before);
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

    /// Index among rendering (layout-backed) children of `parent` for a
    /// child at `pos` in the full children list.
    fn render_index(&self, parent: Key, pos: usize) -> u32 {
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
            // Block -> span: spans have no layout node or native view.
            if let Some(l) = node.layout.take() {
                self.layout.remove(l);
            }
            if node.created {
                node.created = false;
                self.mount.push(MountItem::Delete { id: node.id });
            }
        } else {
            let style = node.base_layout.as_deref().cloned().unwrap_or_default();
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
        node.frame = Bounds::UNSET;
        if let Some(scroll) = node.scroll.as_mut() {
            scroll.content = None;
            // The new native view counts the core's scrolls from zero.
            scroll.issued = 0;
            scroll.pending.clear();
        }
        // A list in its parent's viewport is a plain view clipping its
        // cells.
        let parent_list = node.list.as_ref().is_some_and(|l| l.parent);
        let id = node.id;
        let kind = node.kind;
        // A new native view already has the default style and no listeners.
        let mut flags = 0;
        if node.view_style != ViewStyle::default()
            || node.elevation != Points::ZERO
            || self
                .layout
                .style(node.layout.expect("native layout"))
                .display
                == taffy::Display::None
            || node.backdrop_material != crate::BackdropMaterial::default()
            || parent_list
            || node.spare
        {
            flags |= dirty::VIEW;
        }
        if !node.events.is_empty() {
            flags |= dirty::EVENTS;
        }
        if kind == Kind::Text {
            flags |= dirty::TEXT_MOUNT;
            if has_attachments {
                // Its attachments' views go inside the new view.
                node.attached.clear();
                flags |= dirty::TEXT_BUILD;
            }
        }
        if node.image.as_ref().is_some_and(|i| i.source.is_some()) {
            flags |= dirty::IMAGE;
        }
        if let Some(scroll) = &node.scroll
            && !parent_list
        {
            flags |= dirty::SCROLL;
            if scroll.refreshing {
                flags |= dirty::REFRESHING;
            }
        }
        if !node.animated.is_empty() || node.drawing.as_ref().is_some_and(|d| !d.slots.is_empty()) {
            flags |= dirty::ANIMATION;
        }
        if node.drawing.is_some() {
            flags |= dirty::CANVAS;
        }
        if !node.gestures.is_empty() {
            flags |= dirty::PAN;
        }
        if node.props.is_some() || node.spare {
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
            list.mounted_cells.clear();
        }
        if let Some(input) = node.input.as_mut() {
            input.content = None;
            flags |= dirty::INPUT;
            if !input.value.is_empty() {
                flags |= dirty::INPUT_VALUE;
            }
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
            // The new component gets every property.
            component.changed = component.props.iter().map(|(k, _)| k.clone()).collect();
            flags |= dirty::COMPONENT;
        }
        if let Some(item) = self.creation_tracking(key) {
            self.mount.push(item);
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
        for &child in &children {
            let c = &self.nodes[child as usize];
            if c.layout.is_some() && !c.is_overlay() {
                self.ensure_created(child);
                if self.nodes[key as usize].list.is_none() {
                    let child_id = self.nodes[child as usize].id;
                    self.emit_insert(id, child_id, None);
                }
            }
        }
        self.nodes[key as usize].children = original;
    }

    #[inline]
    fn mark(&mut self, key: Key, flags: u32) {
        let node = &mut self.nodes[key as usize];
        node.dirty |= flags;
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
            if flags & dirty::TEXT_BUILD != 0 && node.layout.is_some() && self.rebuild_text(key) {
                flags |= dirty::TEXT_MOUNT;
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
                    events: node.mounted_events(
                        self.overlay_state
                            .hinting
                            .iter()
                            .find(|watch| watch.key == key)
                            .and_then(|watch| watch.token),
                    ),
                });
            }
            if flags & dirty::IMAGE != 0
                && let Some(image) = &node.image
            {
                // An explicit `resizeMode` wins over `object-*` classes.
                let resize_mode = match node.class_props.as_ref().and_then(|c| c.resize_mode) {
                    Some(m) if image.resize_mode == ResizeMode::default() => m,
                    _ => image.resize_mode,
                };
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
                        position: node.view_style.object_position,
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
                        scrollbar_visible: scroll.scrollbar_visible,
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
                self.mount
                    .push(MountItem::AnimationBindings { id, bindings });
            }
            if flags & dirty::CANVAS != 0
                && let Some(drawing) = &node.drawing
            {
                let drawing = if drawing.view_paints.is_empty() {
                    drawing.clone()
                } else {
                    let (paint, current) = self.resolved_paint(key);
                    Arc::new(drawing.painted(&paint, current))
                };
                self.mount.push(MountItem::Canvas { id, drawing });
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
                let props = node.mounted_props();
                self.mount.push(MountItem::ViewProps { id, props });
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
                let props = std::mem::take(&mut component.changed)
                    .into_iter()
                    .map(|name| {
                        let value = component
                            .props
                            .iter()
                            .find(|(k, _)| *k == name)
                            .map(|(_, v)| v.clone());
                        (name, value)
                    })
                    .collect();
                self.mount.push(MountItem::ComponentProps { id, props });
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
                let config = root.modal;
                self.mount.push(MountItem::ModalConfig { id, config });
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
                    config.selection_color = config
                        .selection_color
                        .or(self.inherited_text_props(key).2)
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
        self.events.push(crate::ui::JsEvent::Event(
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

    fn inherited_text_style(&self, key: Key) -> ResolvedTextStyle {
        let mut chain: Vec<Key> = Vec::new();
        let mut k = self.nodes[key as usize].parent;
        while k != NO_KEY {
            let node = &self.nodes[k as usize];
            if node.kind != Kind::Text && node.text_style != TextStyle::default() {
                chain.push(k);
            }
            k = node.parent;
        }
        chain
            .iter()
            .rev()
            .fold(self.base_text_style(), |style, &k| {
                style.inherit(&self.nodes[k as usize].text_style)
            })
    }

    /// What the classes of `key`, else of the nearest view around it that
    /// says, set for its lines' wrapping, its selection and the
    /// selection's highlight: `whitespace-*` and `select-*` inherit, as
    /// CSS's `white-space` and `user-select: auto` do, and `selection:bg-*`
    /// reaches the texts inside (Tailwind's `& *::selection`). One walk up.
    fn inherited_text_props(&self, key: Key) -> (Option<bool>, Option<bool>, Option<Color>) {
        let (mut no_wrap, mut selectable, mut highlight) = (None, None, None);
        let mut k = key;
        while k != NO_KEY && (no_wrap.is_none() || selectable.is_none() || highlight.is_none()) {
            let node = &self.nodes[k as usize];
            if let Some(c) = node.class_props.as_deref() {
                no_wrap = no_wrap.or(c.no_wrap);
                selectable = selectable.or(c.selectable);
                highlight = highlight.or(c.selection_color);
            }
            k = node.parent;
        }
        (no_wrap, selectable, highlight)
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
                Kind::Text => self.mark_text_block(k),
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
        let node = &self.nodes[key as usize];
        let class = node.class_props.as_deref();
        // Explicit props win over classes (`numberOfLines` over
        // `line-clamp-*`).
        let max_lines = match (node.paragraph.lines, class.and_then(|c| c.number_of_lines)) {
            (0, Some(n)) => n,
            (n, _) => n,
        };
        let ellipsize = match class.and_then(|c| c.ellipsize) {
            Some(m) if !node.paragraph.ellipsize_set => m,
            _ => node.paragraph.ellipsize,
        };
        let inherited = self.inherited_text_style(key);
        let (no_wrap, selectable, highlight) = self.inherited_text_props(key);
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
            selectable: node.paragraph.selectable.or(selectable),
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
        let mut alignments = crate::AttachmentAlignments::default();
        let mut sources = SourceCollector::default();
        self.collect_text(key, base, &mut text, &mut alignments, &mut sources, None);
        let sources = sources.finish(&text.text);
        if multiplier != 1.0 {
            for span in &mut text.spans {
                span.style = scaled(span.style, multiplier);
            }
        }
        let layout = self.nodes[key as usize]
            .layout
            .expect("text block has layout");
        let sources_changed = matches!(self.layout.get_node_context(layout), Some(LeafContext::Text(cx)) if cx.sources != sources);
        self.reading_dirty |= sources_changed;
        let cx = self.text_cx(layout);
        if sources_changed {
            cx.sources = sources;
            cx.source_geometry = None;
        }
        if *cx.text == text && cx.alignments == alignments {
            if inserted {
                // New attachment views: placed with the next final layout.
                cx.laid_out = None;
            }
            return inserted;
        }
        if cx.text.test_ids != text.test_ids
            && !inserted
            && cx.alignments == alignments
            && cx.text.rendering_eq(&text)
        {
            cx.text = Arc::new(text);
            cx.metadata_changed = true;
            return true;
        }
        cx.metadata_changed = false;
        let same_layout = cx.text.layout_eq(&text) && cx.alignments == alignments;
        cx.alignments = alignments;
        cx.text = Arc::new(text);
        // Platform typesetting state embeds colors too: always rebuild it.
        cx.prepared = None;
        cx.min_content = None;
        cx.laid_out = None;
        cx.source_geometry = None;
        if !same_layout {
            cx.layout_hash = cx.alignments.layout_hash(&cx.text);
            cx.cache = None;
            // A text that measures as before leaves every layout standing:
            // only the text is mounted again. Attachments are placed by its
            // final layout, laid out again with the rest.
            let attachments =
                !cx.alignments.is_empty() || !self.nodes[key as usize].attached.is_empty();
            let engine = &self.text_engine;
            let cache = &mut self.measure_cache;
            if attachments
                || !self
                    .layout
                    .measures_as_before(layout, |input, _, cx, style| {
                        measure_leaf(engine, cache, input, cx, style)
                    })
            {
                self.layout.mark_dirty(layout);
                self.needs_layout = true;
            }
        }
        true
    }

    fn collect_text(
        &self,
        key: Key,
        style: ResolvedTextStyle,
        out: &mut AttributedText,
        alignments: &mut crate::AttachmentAlignments,
        sources: &mut SourceCollector,
        inherited_source: Option<usize>,
    ) {
        let own_source = self.nodes[key as usize]
            .text_source
            .as_ref()
            .map(|source| sources.begin(source.clone(), out.len_utf16()));
        let source = own_source.or(inherited_source);
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
                    if let Some(b) = span_background(&child.view_style, child.id) {
                        inner.background = Some(b);
                    }
                    self.collect_text(c, inner, out, alignments, sources, source);
                    if pressable(child.events) {
                        out.links.push(crate::text::TextLink {
                            start,
                            end: out.len_utf16(),
                            node: child.id,
                            events: child.events,
                            props: Arc::new(child.props.as_deref().cloned().unwrap_or_default()),
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
                        alignments.push(
                            out,
                            crate::geometry::size_pt(size.width, size.height),
                            child.vertical_align,
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
                self.emit_insert(block_id, id, None);
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
                self.remove_owned_roots(k);
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

    /// `layout`'s layout, rounded to whole points as Taffy's rounding pass
    /// does ([`rounded`]).
    fn rounded_layout(&self, layout: LayoutId) -> taffy::Layout {
        rounded(
            self.layout.unrounded_layout(layout),
            self.layout_origin(layout),
        )
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
            self.layout_root(root, available);
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
            Kind::Modal => {
                let size = root.reported.unwrap_or(self.viewport);
                (size, 0.0, definite(size))
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
        if kind == Kind::InputAccessory || (kind == Kind::HeaderItem && size.width > Points::ZERO) {
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
        self.emit_frames(key);
        if kind == Kind::Screen && header_changed {
            let id = self.nodes[key as usize].id;
            if let Some(config) = self.screen_config(key) {
                self.mount.push(MountItem::ScreenConfig {
                    id,
                    config: Box::new(config),
                });
            }
        }
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
            let item_cross = state.column(cross, 0).1;
            let extra_cross = state.full_width(cross).1;
            let available = |c: f32| {
                if horizontal {
                    taffy::Size {
                        width: AvailableSpace::MaxContent,
                        height: AvailableSpace::Definite(c),
                    }
                } else {
                    taffy::Size {
                        width: AvailableSpace::Definite(c),
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
                let Some(cell_layout) = node.layout else {
                    continue;
                };
                let c = match node.slot {
                    Some(CellSlot::Item(_)) | None => item_cross,
                    Some(_) => extra_cross,
                };
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
        let engine = &self.text_engine;
        let cache = &mut self.measure_cache;
        self.layout
            .compute_layout_with_measure(root, available, |input, _, cx, style| {
                measure_leaf(engine, cache, input, cx, style)
            });
    }

    /// Lays out the relayout boundaries a change inside made dirty
    /// (`LayoutTree::relayout_boundaries`), returning those laid out on
    /// their own: their subtrees' frames are new.
    fn relayout_boundaries(&mut self) -> Vec<Key> {
        let engine = &self.text_engine;
        let cache = &mut self.measure_cache;
        self.layout.relayout_boundaries(|input, _, cx, style| {
            measure_leaf(engine, cache, input, cx, style)
        })
    }

    /// Whether `key` is out of the layout: `display: none` on it or on a
    /// view it is laid out in (Taffy gives all of them no size).
    fn displays_none(&self, key: Key) -> bool {
        let mut k = key;
        while k != NO_KEY {
            let n = &self.nodes[k as usize];
            if let Some(layout) = n.layout
                && self.layout.style(layout).display == taffy::Display::None
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
            // Whatever Taffy keeps for it (`emit_frames_in`).
            let hidden = self.displays_none(key);
            let mut content = if hidden {
                Bounds::default()
            } else {
                content_box(&self.rounded_layout(layout))
            };
            let engine = &self.text_engine;
            let cache = &mut self.measure_cache;
            let Some(LeafContext::Text(cx)) = self.layout.get_node_context_mut(layout) else {
                continue;
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
                let height = measure_text(engine, cache, cx, Some(content.size.width.0)).height;
                if height < content.size.height {
                    content.origin.y += align_vertical.of(content.size.height - height);
                    content.size.height = height;
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
                    self.events.push(crate::ui::JsEvent::Event(
                        id,
                        EventKind::TextLayout,
                        text_lines(engine, &text, &text_layout),
                    ));
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
                _ => {
                    let prepared = cx
                        .prepared
                        .get_or_insert_with(|| engine.prepare_aligned(&cx.text, &cx.alignments));
                    let layout = engine.layout(prepared, size);
                    if report_lines {
                        self.events.push(crate::ui::JsEvent::Event(
                            id,
                            EventKind::TextLayout,
                            text_lines(engine, &cx.text, &layout),
                        ));
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
        let points = self.text_engine.attachments(layout);
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
            .map_or(taffy::Point::ZERO, |parent| {
                let origin = self.layout_origin(parent);
                let location = self.layout.unrounded_layout(parent).location;
                taffy::Point {
                    x: origin.x + location.x,
                    y: origin.y + location.y,
                }
            });
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
    /// root, unrounded ([`Core::layout_origin`]), carried down the walk.
    fn emit_frames_in(&mut self, key: Key, hidden: bool, origin: taffy::Point<f32>) {
        let node = &self.nodes[key as usize];
        let Some(layout) = node.layout else { return };
        if !node.created {
            return;
        }
        let hidden = hidden || self.layout.style(layout).display == taffy::Display::None;
        if hidden {
            // Cells keep independent layout caches. Re-emit their descendants
            // when shown again, even if their measured size has not changed.
            if self.nodes[key as usize].kind == Kind::Cell {
                self.nodes[key as usize].relaid = true;
            }
            self.set_frame(key, Bounds::default());
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
        let unrounded = self.layout.unrounded_layout(layout);
        let containing = if self.layout.style(layout).position.is_out_of_flow() {
            self.layout_origin(layout)
        } else {
            origin
        };
        let inner = taffy::Point {
            x: containing.x + unrounded.location.x,
            y: containing.y + unrounded.location.y,
        };
        let l = rounded(unrounded, containing);
        let mut frame = rect(
            l.location.x + round(containing.x) - round(origin.x),
            l.location.y + round(containing.y) - round(origin.y),
            l.size.width,
            l.size.height,
        );
        // Children of a right-to-left horizontal scroll view: mirrored in
        // its content.
        if let Some(parent) = self.nodes.get(node.parent as usize)
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
        self.set_frame(key, frame);
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
            // Scrollable extent: the overflow rectangle is measured from the
            // padding box origin and stops at the children's border boxes, so
            // add the leading border and trailing padding.
            let o = l.scrollable_overflow_rect;
            let size = size_pt(
                l.size.width.max(l.border.left + o.right + l.padding.right),
                l.size
                    .height
                    .max(l.border.top + o.bottom + l.padding.bottom),
            );
            self.set_scroll_content(key, size);
        }
        // List cells are positioned by `update_lists`, roots by
        // `layout_roots`.
        if kind.is_container() && kind != Kind::List {
            let children = std::mem::take(&mut self.nodes[key as usize].children);
            for &child in &children {
                if !self.nodes[child as usize].is_layout_root() {
                    self.emit_frames_in(child, false, inner);
                }
            }
            self.nodes[key as usize].children = children;
            self.update_overflow(key);
        }
    }

    fn set_frame(&mut self, key: Key, frame: Bounds<Points>) {
        let node = &mut self.nodes[key as usize];
        if node.frame != frame {
            node.frame = frame;
            let (id, is_text) = (node.id, node.kind == Kind::Text);
            if node.events.contains(EventKind::Layout) {
                self.events.push(crate::ui::JsEvent::Event(
                    id,
                    EventKind::Layout,
                    EventPayload::Layout(frame),
                ));
            }
            self.mount.push(MountItem::Frame { id, frame });
            let node = &self.nodes[key as usize];
            // Translations by a fraction of the size follow it, and so does
            // the perspective of its parent, seen from the parent's center.
            let parent_perspective = self.perspective_steps(key) > 0;
            if node.view_style.transform.has_fractions() || parent_perspective {
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
            if let Some(j) = queued {
                self.mount[j] = MountItem::ScrollContent { id, size };
            }
            // A scroll queued after it must still come before the new size.
            let scrolled_since = queued.is_some_and(|j| {
                self.mount[j + 1..]
                    .iter()
                    .any(|m| matches!(m, MountItem::ScrollBy { id: s, .. } if *s == id))
            });
            if queued.is_none() || scrolled_since {
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

    /// Project confirmed cells to the native tree in content order. A cell
    /// keeps its JS owner and node id while moving between recycling slots;
    /// an unbound cell stays alive but cannot retain a native keyboard stop.
    fn mount_list_cells(&mut self, key: Key, mut cells: Vec<NodeId>, sticky: &[StickyRange]) {
        let list = self.nodes[key as usize].list.as_mut().expect("list");
        // Parent-mode cells belong to a plain view, so the core keeps
        // sticky cells on top while preserving the other cells' order.
        if list.parent && !sticky.is_empty() {
            cells.sort_by_key(|id| sticky.iter().any(|range| range.cell == *id));
        }
        if list.mounted_cells == cells {
            return;
        }
        let mut current = std::mem::take(&mut list.mounted_cells);
        current.retain(|&id| {
            // Runtime removal may already have moved or released this cell.
            // Do not detach its new parent or a recycled shadow-tree key.
            if !self
                .key(id)
                .is_ok_and(|cell| self.nodes[cell as usize].parent == key)
            {
                return false;
            }
            if cells.contains(&id) {
                true
            } else {
                let cell = self.key(id).expect("live cell");
                self.remove_owned_roots(cell);
                false
            }
        });
        let parent = self.nodes[key as usize].id;
        let mut before = None;
        for (index, &id) in cells.iter().enumerate().rev() {
            let at = current.iter().position(|&cell| cell == id);
            let in_place = at.is_some_and(|at| current.get(at + 1).copied() == before);
            if !in_place {
                let cell = self.key(id).expect("live cell");
                self.mount.push(MountItem::ProjectRoot {
                    parent,
                    id,
                    following: cells[index + 1..].to_vec(),
                });
                if let Some(at) = at {
                    current.remove(at);
                }
                let at = before
                    .and_then(|before| current.iter().position(|&cell| cell == before))
                    .unwrap_or(current.len());
                current.insert(at, id);
                self.nodes[key as usize]
                    .list
                    .as_mut()
                    .expect("list")
                    .projected(cell);
                self.reproject_roots(cell, true);
            }
            before = Some(id);
        }
        self.nodes[key as usize]
            .list
            .as_mut()
            .expect("list")
            .mounted_cells = current;
    }

    /// Measures rendered cells, keeps the visible content anchored, picks
    /// the items to render and positions the cells of every list.
    fn update_lists(&mut self, relayout: bool) {
        // Source providers must already have their logical reader while its
        // own window is updated, even before a new parent list is measured.
        if self.outer_moved {
            self.resolve_outer();
        }
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
            self.update_list(key, relayout, None);
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
                self.update_list(key, relayout, Some(outer));
            }
        }
        if !self.sticky_nodes.is_empty() || !self.sticky_scrollers.is_empty() {
            self.update_sticky_views(relayout);
        }
        if !self.sticky_views.is_empty() {
            self.send_page_sticky();
        }
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
        if !node.created {
            // Its new view gets both (`ensure_created`).
            return;
        }
        let (id, props) = (node.id, node.mounted_props());
        let style = self.mounted_view_style(key);
        self.mount.push(MountItem::ViewStyle { id, style });
        self.mount.push(MountItem::ViewProps { id, props });
    }

    /// [`Core::update_lists`] for list `key`; `outer`: where a list in its
    /// parent's viewport is in the view it is virtualized against.
    fn update_list(
        &mut self,
        key: Key,
        relayout: bool,
        outer: Option<parent_viewport::OuterInput>,
    ) {
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
            return;
        }
        let list = node.list.as_ref().expect("list");
        if !(relayout
            || moved
            || list.dirty
            || self.reading_dirty
            || self.commands.iter().any(|c| c.0 == node.id))
        {
            return;
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
        let extras = list.extras;
        // An inverted list that loads at its start keeps its rows in
        // place when scrolled away from it (`keeps_visible_rows`).
        self.nodes[key as usize]
            .list
            .as_mut()
            .expect("list")
            .loads_at_start = events.contains(EventKind::LoadMoreAtStart);
        let mut anchor = 0.0;
        let mut extents_changed = false;
        for &(index, cell) in &ready {
            if let Some(cell_layout) = self.nodes.get(cell as usize).and_then(|c| c.layout) {
                let size = main_of(self.rounded_layout(cell_layout).size);
                let list = self.nodes[key as usize].list.as_mut().expect("list");
                extents_changed |= !list.source_row_matches_layout(index, size);
                anchor += list.measured(index, size);
            }
        }
        for (kind, extra) in [ExtraKind::Header, ExtraKind::Footer, ExtraKind::Empty]
            .into_iter()
            .zip(extras)
        {
            if let Some(cell_layout) = self.nodes.get(extra.cell as usize).and_then(|c| c.layout) {
                let size = main_of(self.rounded_layout(cell_layout).size);
                let list = self.nodes[key as usize].list.as_mut().expect("list");
                extents_changed |= list.extras[kind as usize].size != size;
                anchor += list.measured_extra(kind, size);
            }
        }

        let list = self.nodes[key as usize].list.as_mut().expect("list");
        // Not on the first layout: there is nothing to clamp yet.
        let grew = outer.is_none() && list.viewport > 0.0 && main > list.viewport;
        list.viewport = main;
        list.compensate_layout_offset(anchor);
        // A splice above the viewport already moved the offset.
        anchor += list.take_splice_anchor();
        if outer.is_none() {
            let maximum = (list.content_len() * zoom - main + trailing).max(-leading);
            list.predict_clamp(maximum);
        }
        // Inverted lists keep their distance from the end instead;
        // `maintainVisibleContentPosition` follows the end near it.
        anchor += list.anchor_end();
        let rebuild_sources = self.reading_dirty || list.source_dirty || relayout;
        if rebuild_sources {
            let geometry = self.list_source_geometry(key);
            let list = self.nodes[key as usize].list.as_mut().expect("list");
            list.source_geometry = geometry;
            list.source_dirty = false;
        }
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
        match list.follow_pin(anchor) {
            Follow::Stay => {}
            Follow::By(delta) => anchor += delta,
            Follow::To { offset, animated } => retarget = Some((offset, animated)),
        }

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
            if matches!(command, Command::ScrollToEnd { .. }) {
                log::debug!(target: "nsh::scroll", "core_scroll_to_end list={id} old={} target={offset} viewport={} content={} outer={} animated={animated}", list.offset, list.viewport, list.content_len(), outer.is_some());
            }
            if automatic && !list.idle() {
                list.wait_for_idle(pin.expect("automatic index target"), animated);
                retarget = None;
                continue;
            }
            // An offset of the app's own ends the pin.
            list.pin(pin, offset, animated, automatic);
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
            self.events.push(crate::ui::JsEvent::Event(
                id,
                EventKind::LoadMore,
                EventPayload::None,
            ));
        }
        if edges.start && events.contains(EventKind::LoadMoreAtStart) {
            self.events.push(crate::ui::JsEvent::Event(
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
        let native_ops = std::mem::take(&mut list.native_ops);
        for op in native_ops {
            match op {
                list::NativeCellOp::Retire { cell, request } => {
                    let list = self.nodes[key as usize].list.as_ref().expect("list");
                    if list.current_retirement(cell, request) {
                        self.mount.push(MountItem::RetireListCell {
                            id: self.nodes[cell as usize].id,
                            request,
                            roots: self.owned_native_roots(cell),
                        });
                    }
                }
                list::NativeCellOp::Attach { cell } => {
                    if !self.nodes[key as usize]
                        .list
                        .as_ref()
                        .expect("list")
                        .current_attachment(cell)
                    {
                        continue;
                    }
                    let id = self.nodes[cell as usize].id;
                    // Native may have consumed the earlier retirement already.
                    // Emit an Insert even if our last projection still lists it.
                    self.nodes[key as usize]
                        .list
                        .as_mut()
                        .expect("list")
                        .mounted_cells
                        .retain(|&mounted| mounted != id);
                }
            }
        }
        let list = self.nodes[key as usize].list.as_mut().expect("list");
        if events.contains(EventKind::ViewableItemsChange) {
            let viewable = list.viewable_items();
            if viewable != list.viewable {
                list.viewable = viewable;
                let (first, last) = viewable.map_or((-1.0, -1.0), |(f, l)| (f as f64, l as f64));
                self.events.push(crate::ui::JsEvent::Event(
                    id,
                    EventKind::ViewableItemsChange,
                    EventPayload::Map(vec![
                        ("first", PayloadValue::Number(first)),
                        ("last", PayloadValue::Number(last)),
                    ]),
                ));
            }
        }

        // Position cells that show their item (the window may have
        // changed which ones). Descendant frames only change when the
        // cell was laid out again.
        let list = self.nodes[key as usize].list.as_ref().expect("list");
        let content_len = list.content_len();
        let blocks = list.blocks();
        let sticky = list.sticky_enabled();
        ready.clear();
        ready.extend(
            list.slots
                .iter()
                .filter_map(|s| s.ready().map(|i| (i, s.cell))),
        );
        ready.sort_unstable_by_key(|&(index, _)| index);
        let mut cells = Vec::with_capacity(ready.len() + 3);
        if extras[0].cell != u32::MAX {
            cells.push(self.nodes[extras[0].cell as usize].id);
        }
        cells.extend(ready.iter().map(|&(_, cell)| self.nodes[cell as usize].id));
        if list.count == 0 && extras[2].cell != u32::MAX {
            cells.push(self.nodes[extras[2].cell as usize].id);
        }
        if extras[1].cell != u32::MAX {
            cells.push(self.nodes[extras[1].cell as usize].id);
        }
        // Cells left without an item, or not showing theirs yet (a paced
        // bind, or one the frame's rounds did not reach), still show their
        // last one. Those in the render window (the data changed, the list
        // jumped) would show through: move them out of sight. They, the ones
        // never placed and, once the items changed, all of them are hidden
        // until placed again ([`Core::set_spare`]); the few the window leaves
        // behind while scrolling are out of sight already and soon reused.
        let (window_start, window_end) = list.render_window();
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
            let frame = if horizontal {
                rect(main_at, x, size.width, width)
            } else {
                rect(x, main_at, width, size.height)
            };
            this.set_frame(cell, frame);
            this.set_spare(cell, false);
            if std::mem::take(&mut this.nodes[cell as usize].relaid) {
                let children = std::mem::take(&mut this.nodes[cell as usize].children);
                for &child in &children {
                    this.emit_frames(child);
                }
                this.nodes[cell as usize].children = children;
                this.update_overflow(cell);
            }
            Some(main_of(size))
        };
        for &(index, cell) in &ready {
            let list = self.nodes[key as usize].list.as_ref().expect("list");
            let (at, row) = (list.item_at(index), list.row_extent(index));
            let column = list.column(cross, list.column_of(index));
            let Some(size) = place(self, cell, at, row, column) else {
                continue;
            };
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
            .full_width(cross);
        for (extra, at) in extras
            .iter()
            .zip([blocks.header, blocks.footer, blocks.body])
        {
            if extra.cell != u32::MAX {
                place(self, extra.cell, at, 0.0, full);
            }
        }
        self.cells_scratch = ready;

        sticky_cells.sort_by_key(|c| c.cell);
        self.mount_list_cells(key, cells, &sticky_cells);
        let list = self.nodes[key as usize].list.as_mut().expect("list");
        if let Some(o) = &outer {
            // The view around the list pins them, with its other lists'.
            if sticky_cells != list.sent_sticky {
                list.sent_sticky = sticky_cells;
                self.sticky_views.push(o.view);
            }
        } else if sticky_cells != list.sent_sticky {
            let cells = sticky_cells
                .iter()
                .map(|r| StickyCell {
                    cell: r.cell,
                    start: Points(r.start),
                    end: Points(r.end),
                    offset: r.offset,
                })
                .collect();
            list.sent_sticky = sticky_cells;
            self.mount.push(MountItem::StickyCells { id, cells });
            // Its lists in its viewport pin theirs with its own.
            let scroll = self.nodes[key as usize].scroll.as_ref();
            if scroll.is_some_and(|s| !s.page_sticky.is_empty()) {
                self.sticky_views.push(key);
            }
        }

        if let Some(o) = &outer {
            // The owner was indexed before these rows were measured. Opposite
            // extent changes can move its source lines without resizing the
            // spacer; reconcile that geometry in the same settling round.
            if extents_changed && let Some(owner) = self.nodes[o.view as usize].list.as_mut() {
                owner.source_dirty = true;
                owner.dirty = true;
                self.extent_changed = true;
            }
            // The view around the list scrolls (the commit sends it at
            // its end; a scroll to an offset after the anchoring, which
            // it supersedes), and the list takes its new length in layout.
            if anchor != 0.0 {
                self.ask_outer(o.view, None, anchor);
            }
            if outer_to.is_some() {
                self.ask_outer(o.view, outer_to, 0.0);
            }
            self.sync_spacer(key, false);
            return;
        }
        let content = if horizontal {
            size_pt(content_len, cross)
        } else {
            size_pt(cross, content_len)
        };
        // Platforms clamp the offset to the content: grow the content
        // before scrolling, scroll before shrinking it.
        let old_len = self.nodes[key as usize]
            .scroll
            .as_ref()
            .and_then(|s| s.content)
            .map_or(0.0, |c| if horizontal { c.width.0 } else { c.height.0 });
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
            (Some(item), Some(at)) => {
                self.mount.insert(at, item);
                self.set_scroll_content(key, content);
            }
            (Some(item), None) if content_len < old_len => {
                self.mount.push(item);
                self.set_scroll_content(key, content);
            }
            (item, _) => {
                self.set_scroll_content(key, content);
                self.mount.extend(item);
            }
        }
    }
}

/// How far out of sight unbound list cells are moved.
const HIDDEN: f32 = 1.0e6;

/// The content box (inside padding and border) of a laid-out node.
/// Taffy's rounding of a coordinate.
fn round(value: f32) -> f32 {
    (value + 0.5).floor()
}

/// `layout` rounded as Taffy's rounding pass (`taffy::round_layout`) rounds
/// it, `origin` being the unrounded position of the node around it in its
/// layout root: edges are rounded where they are in the root, so adjacent
/// views stay adjacent. The core rounds itself: Taffy's pass reaches the
/// absolutely positioned nodes through their containing block's list,
/// which it can leave holding removed nodes (a panic) or never fill (a
/// hidden subtree's), while here every node is reached through its parent,
/// its logical parent; out-of-flow offsets use their Taffy containing block.
fn rounded(layout: &taffy::Layout, origin: taffy::Point<f32>) -> taffy::Layout {
    let mut out = *layout;
    let (x, y) = (origin.x + layout.location.x, origin.y + layout.location.y);
    out.location.x = round(x) - round(origin.x);
    out.location.y = round(y) - round(origin.y);
    out.size.width = round(x + layout.size.width) - round(x);
    out.size.height = round(y + layout.size.height) - round(y);
    out.scrollbar_size.width = round(layout.scrollbar_size.width);
    out.scrollbar_size.height = round(layout.scrollbar_size.height);
    out.border.left = round(x + layout.border.left) - round(x);
    out.border.right =
        round(x + layout.size.width) - round(x + layout.size.width - layout.border.right);
    out.border.top = round(y + layout.border.top) - round(y);
    out.border.bottom =
        round(y + layout.size.height) - round(y + layout.size.height - layout.border.bottom);
    out.padding.left = round(x + layout.padding.left) - round(x);
    out.padding.right =
        round(x + layout.size.width) - round(x + layout.size.width - layout.padding.right);
    out.padding.top = round(y + layout.padding.top) - round(y);
    out.padding.bottom =
        round(y + layout.size.height) - round(y + layout.size.height - layout.padding.bottom);
    let o = layout.scrollable_overflow_rect;
    out.scrollable_overflow_rect.left = round(x + o.left) - round(x);
    out.scrollable_overflow_rect.right = round(x + o.right) - round(x);
    out.scrollable_overflow_rect.top = round(y + o.top) - round(y);
    out.scrollable_overflow_rect.bottom = round(y + o.bottom) - round(y);
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
fn min_content_width<M: TextEngine>(
    engine: &M,
    cache: &mut MeasureCache,
    cx: &mut TextContext<M::Prepared>,
) -> Points {
    if let Some(width) = cx.min_content {
        return width;
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

/// A leaf's layout (`taffy::compute_leaf_layout`): Taffy resolves its
/// style's sizes, padding, border, minimums, maximums and aspect ratio;
/// only its content (a text, an image's natural size, a native
/// component's own size) is measured here.
fn measure_leaf<M: TextEngine>(
    engine: &M,
    cache: &mut MeasureCache,
    input: taffy::LayoutInput,
    cx: Option<&mut LeafContext<M::Prepared>>,
    style: &taffy::Style,
) -> taffy::LayoutOutput {
    taffy::compute_leaf_layout(
        input,
        style,
        |_, _| 0.0,
        |known, available| match cx {
            Some(LeafContext::Text(cx)) => {
                let max_width = if cx.text.no_wrap {
                    None
                } else {
                    known.width.or(match available.width {
                        AvailableSpace::Definite(w) => Some(w),
                        AvailableSpace::MinContent => Some(min_content_width(engine, cache, cx).0),
                        AvailableSpace::MaxContent => None,
                    })
                };
                let measured = measure_text(engine, cache, cx, max_width);
                taffy::Size {
                    width: known.width.unwrap_or(measured.width.0),
                    height: known.height.unwrap_or(measured.height.0),
                }
            }
            Some(LeafContext::Image(Some(natural))) => {
                image_size(*natural, known.width, known.height)
            }
            Some(LeafContext::Native(Some(own))) => taffy::Size {
                width: known.width.unwrap_or(own.width.0),
                height: known.height.unwrap_or(own.height.0),
            },
            _ => taffy::Size::ZERO,
        },
    )
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
    let size = match cache.get(cx.layout_hash, typed) {
        Some(size) => size,
        None => {
            let prepared = cx
                .prepared
                .get_or_insert_with(|| engine.prepare_aligned(&cx.text, &cx.alignments));
            let size = engine.measure(prepared, typed);
            // Round up so rendering never truncates the last glyph.
            let size = size.map(Points::ceil);
            cache.insert(cx.layout_hash, typed, size);
            size
        }
    };
    cx.cache = Some((max_width, size));
    size
}

fn definite(size: Size<Points>) -> taffy::Size<AvailableSpace> {
    taffy::Size {
        width: AvailableSpace::Definite(size.width.0),
        height: AvailableSpace::Definite(size.height.0),
    }
}

/// The message for a refused URL.
fn not_granted(what: &str, uri: &str, capability: &str) -> String {
    let host = crate::access::parse_url(uri).map_or_else(|| uri.to_owned(), |u| u.host);
    format!("{what} {uri} is not granted: add `{host}` to capabilities.{capability} in nsh.json")
}

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

/// The background a nested text's view style gives its characters.
fn span_background(style: &ViewStyle, node: NodeId) -> Option<crate::text::TextBackground> {
    (style.background_color.0 & 0xff != 0).then_some(crate::text::TextBackground {
        color: style.background_color,
        radius: style.border_radius.max(Points::ZERO),
        node,
    })
}

/// Whether a span with `events` takes presses (a link in its text block).
fn pressable(events: EventMask) -> bool {
    PRESSES.iter().any(|&e| events.contains(e))
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
