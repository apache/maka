//! Non-style view properties: touch handling, accessibility, gesture values
//! and layout animations.

use std::sync::Arc;

use crate::{
    element::PropEnum,
    geometry::{Edges, Point, Points, px},
    js::host::HostProps,
};

/// Edge insets in points.
pub type EdgeInsets = Edges<Points>;

/// Which touches a view and its children receive (`pointerEvents`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum PointerEvents {
    /// The view and its children receive touches (default).
    #[default]
    Auto,
    /// Neither the view nor its children receive touches.
    None,
    /// Only the children receive touches; the view itself is transparent to them.
    #[prop(rename = "box-none")]
    BoxNone,
    /// Only the view receives touches, never its children.
    #[prop(rename = "box-only")]
    BoxOnly,
}

/// What an element is, for assistive technologies (`role`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum AccessibilityRole {
    /// No particular role.
    #[default]
    None,
    /// A button.
    Button,
    /// A link.
    Link,
    /// A search field.
    Search,
    /// An image.
    Image,
    /// An image that acts as a button.
    #[prop(rename = "imagebutton")]
    ImageButton,
    /// A key of a keyboard.
    #[prop(rename = "keyboardkey")]
    KeyboardKey,
    /// Static text.
    Text,
    /// A value that can be adjusted (slider).
    Adjustable,
    /// A section header.
    Header,
    /// A summary of the app's state.
    Summary,
    /// An alert.
    Alert,
    /// A checkbox.
    Checkbox,
    /// A combo box.
    Combobox,
    /// A menu.
    Menu,
    /// A menu bar.
    Menubar,
    /// An item of a menu.
    Menuitem,
    /// A progress bar.
    Progressbar,
    /// A radio button.
    Radio,
    /// A group of radio buttons.
    Radiogroup,
    /// A scroll bar.
    Scrollbar,
    /// A spin button.
    Spinbutton,
    /// A switch.
    Switch,
    /// A tab.
    Tab,
    /// A list of tabs.
    Tablist,
    /// A timer.
    Timer,
    /// A toolbar.
    Toolbar,
    /// A list.
    List,
    /// A grid.
    Grid,
    /// A table: rows of cells under column headers.
    Table,
    /// A row of a table.
    Row,
    /// A cell of a table's row.
    Cell,
    /// A column's header cell.
    #[prop(rename = "columnheader")]
    ColumnHeader,
    /// A group of a table's rows: its header, body or footer.
    #[prop(rename = "rowgroup")]
    RowGroup,
    /// A list of options to choose from: a select's or combo box's popup.
    Listbox,
    /// An option of a listbox; `accessibilityState.selected` marks the chosen
    /// one.
    Option,
    /// A group of related elements that is no landmark: an accordion, the
    /// controls of a toolbar that belong together.
    Group,
    /// A section of the page a user may want to reach (a landmark): an
    /// accordion's panel, labelled by its header.
    Region,
    /// A landmark of links or controls that move around the app: a
    /// pagination, a breadcrumb.
    Navigation,
    /// A tree of items that expand and collapse (`treeitem`s).
    Tree,
    /// An item of a tree; `accessibilityState.expanded` tells whether its
    /// children show, `accessibilityLevel` its depth (1 at the top).
    #[prop(rename = "treeitem")]
    TreeItem,
    /// An item of a menu that is checked or not
    /// (`accessibilityState.checked`).
    #[prop(rename = "menuitemcheckbox")]
    MenuItemCheckbox,
    /// An item of a menu that is one choice of a group of them
    /// (`accessibilityState.checked`).
    #[prop(rename = "menuitemradio")]
    MenuItemRadio,
    /// A dialog over the rest of the app, named by its `label` (its
    /// title): what `nsh_base::dialog` is unless the app gives it another
    /// role.
    Dialog,
    /// A dialog that asks the user to confirm something or tells them
    /// something urgent (a destructive action's confirmation), named by
    /// its `label`.
    #[prop(rename = "alertdialog")]
    AlertDialog,
}

impl AccessibilityRole {
    /// Whether the role is a control the pointer presses (a button, link,
    /// tab, menu item…): text inside one shows the control's pointer, not
    /// the I-beam of a selectable area around it, as a browser's
    /// `<button>` text does.
    pub fn is_control(self) -> bool {
        matches!(
            self,
            Self::Button
                | Self::Link
                | Self::ImageButton
                | Self::KeyboardKey
                | Self::Checkbox
                | Self::Combobox
                | Self::Menuitem
                | Self::MenuItemCheckbox
                | Self::MenuItemRadio
                | Self::Radio
                | Self::Switch
                | Self::Tab
                | Self::Option
                | Self::TreeItem
                | Self::Adjustable
                | Self::Spinbutton
                | Self::Scrollbar
        )
    }
}

/// Whether a checkable element is checked (`accessibilityState.checked`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Checked {
    /// Not checked.
    False,
    /// Checked.
    True,
    /// Partially checked.
    Mixed,
}

/// Which item of a set an element is the current one of
/// (`accessibilityState.current`, ARIA's `aria-current`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessibilityCurrent {
    /// The current item of a set, of no particular kind (`true`).
    True,
    /// The current page: a pagination's, a breadcrumb's last link.
    Page,
    /// The current step of a process.
    Step,
    /// The current location: a place in a map or a flow chart.
    Location,
    /// The current date of a calendar.
    Date,
    /// The current time of a timetable.
    Time,
}

/// Dynamic state of an element (`accessibilityState`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AccessibilityState {
    /// Disabled.
    pub disabled: bool,
    /// Selected.
    pub selected: bool,
    /// Checked state of checkable elements.
    pub checked: Option<Checked>,
    /// Busy (loading).
    pub busy: bool,
    /// Expanded or collapsed, for expandable elements.
    pub expanded: Option<bool>,
    /// Pressed state of a toggle button (ARIA's `aria-pressed`): `Some`
    /// makes a button one that stays on or off; `Mixed` is partly
    /// pressed.
    pub pressed: Option<Checked>,
    /// The current item of a set (ARIA's `aria-current`): a pagination's
    /// page, a wizard's step.
    pub current: Option<AccessibilityCurrent>,
    /// Opens a popup (ARIA's `aria-haspopup`): a menu's, a popover's or a
    /// select's trigger, whose `expanded` says whether the popup is open;
    /// an `expanded` element without it is a disclosure, which shows its
    /// content in place (a collapsible's or an accordion's trigger).
    pub has_popup: bool,
    /// The content does not pass the app's checks (ARIA's
    /// `aria-invalid`): a field whose text was rejected, a select left
    /// empty that must not be.
    pub invalid: bool,
}

/// The value of a range or textual element (`accessibilityValue`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AccessibilityValue {
    /// Minimum of the range.
    pub min: Option<f32>,
    /// Maximum of the range.
    pub max: Option<f32>,
    /// Current value in the range.
    pub now: Option<f32>,
    /// A textual description of the value; wins over the range.
    pub text: Option<Arc<str>>,
}

/// How changes of an element are announced (Android `accessibilityLiveRegion`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum LiveRegion {
    /// Not announced.
    #[default]
    None,
    /// Announced when the user is idle.
    Polite,
    /// Announced right away.
    Assertive,
}

/// A custom action offered to assistive technologies.
#[derive(Debug, Clone, PartialEq)]
pub struct AccessibilityActionDef {
    /// Name reported back in `onAccessibilityAction` (`activate`,
    /// `increment`, `decrement` and `longpress` are standard actions).
    pub name: Arc<str>,
    /// Label shown to the user; required for custom actions.
    pub label: Option<Arc<str>>,
}

crate::static_reactive!(Vec<AccessibilityActionDef>: Vec<AccessibilityActionDef>);

/// Accessibility of one view.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Accessibility {
    /// `accessible`: the view is one element for assistive technologies
    /// (its children are not exposed separately). `None` keeps the
    /// platform default: views with text or touch handlers are elements.
    pub accessible: Option<bool>,
    /// `accessibilityLabel`.
    pub label: Option<Arc<str>>,
    /// `accessibilityHint`.
    pub hint: Option<Arc<str>>,
    /// `accessibilityDescription`: more about the element than its name
    /// (ARIA's `aria-description`): a dialog's message, what a field
    /// expects. While `accessibilityDescribedBy` names a rendered element
    /// with text, that text, which the core keeps current (ARIA's
    /// `aria-describedby` wins over `aria-description` alike).
    pub description: Option<Arc<str>>,
    /// `role`.
    pub role: AccessibilityRole,
    /// `accessibilityState`.
    pub state: AccessibilityState,
    /// `accessibilityValue`.
    pub value: Option<AccessibilityValue>,
    /// `accessibilityElementsHidden` / `importantForAccessibility:
    /// "no-hide-descendants"`: hide the view and its subtree.
    pub hidden: bool,
    /// `accessibilityLiveRegion`.
    pub live_region: LiveRegion,
    /// `accessibilityActions`.
    pub actions: Vec<AccessibilityActionDef>,
    /// `accessibilityLevel`: the level of a heading (1 the top), the depth
    /// of a tree item (1 at the top); `None` has none.
    pub level: Option<u32>,
    /// `accessibilityActiveDescendant`: the view (its native id) that is
    /// the active one inside this focused view, which keeps the keyboard
    /// focus (ARIA's `aria-activedescendant`): a combo box's highlighted
    /// option, a list's cursor row. Resolved by the core from the element
    /// the app names; `None` when it names none or that element is gone.
    pub active_descendant: Option<crate::NodeId>,
    /// `accessibilityControls`: the view (its native id) whose content
    /// this one controls (ARIA's `aria-controls`): a combo box's listbox,
    /// a tab's panel. Resolved as [`Accessibility::active_descendant`].
    pub controls: Option<crate::NodeId>,
    /// `accessibilityDescribedBy`: the view (its native id) whose text
    /// describes this one (ARIA's `aria-describedby`): a field's error
    /// line. Resolved as [`Accessibility::active_descendant`]; its text is
    /// [`Accessibility::description`], so a platform without such a
    /// relation reads it all the same.
    pub described_by: Option<crate::NodeId>,
    /// The list's orientation (ARIA's `aria-orientation`, reported on the
    /// web): `"horizontal"` or `"vertical"`, for a tab list or toolbar laid
    /// out along that axis; `None` has none.
    pub orientation: Option<crate::geometry::Axis>,
}

impl Accessibility {
    /// True if nothing is set.
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }

    /// What a platform with one place for everything read after the name
    /// (AT-SPI's and AccessKit's description, AppKit's help, UIKit's
    /// hint) gets: `value_text` (a value it reads nowhere else), the
    /// description and the hint, in that order, each a sentence of its
    /// own (". " between them, or only a space after a part that already
    /// ends with `.`, `!`, `?` or `…`, nothing after a full-width `。`,
    /// `！` or `？`); `None` when there is none of them.
    pub fn help_text(&self, value_text: Option<&str>) -> Option<String> {
        let mut parts = [
            value_text,
            self.description.as_deref(),
            self.hint.as_deref(),
        ]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty());
        let first = parts.next()?;
        let mut out = first.to_owned();
        for part in parts {
            // A part that already ends its sentence keeps its own mark: a
            // full-width one needs no space after it, a Latin one a space.
            match out.chars().last() {
                Some('。' | '！' | '？') => {}
                Some('.' | '!' | '?' | '…') => out.push(' '),
                _ => out.push_str(". "),
            }
            out.push_str(part);
        }
        Some(out)
    }
}

/// One accessibility property, as set from JS.
#[derive(Debug, Clone, PartialEq, HostProps)]
pub enum AccessibilityProp {
    /// `accessible`: the view is one element for assistive technologies (its
    /// children are not exposed separately).
    #[prop(js = "accessible")]
    Accessible(Option<bool>),
    /// `accessibilityLabel`: what screen readers read.
    #[prop(js = "accessibilityLabel")]
    Label(Option<Arc<str>>),
    /// `accessibilityHint`: what activating the element does.
    #[prop(js = "accessibilityHint")]
    Hint(Option<Arc<str>>),
    /// `accessibilityDescription`: more about the element than its name,
    /// read after it: a dialog's message, what a field expects.
    #[prop(js = "accessibilityDescription")]
    Description(Option<Arc<str>>),
    /// `role`: what the element is.
    #[prop(js = "role", with = crate::js::host_values::role, reset = AccessibilityProp::Role(AccessibilityRole::None))]
    Role(AccessibilityRole),
    /// `accessibilityState`.
    #[prop(js = "accessibilityState")]
    State(AccessibilityState),
    /// `accessibilityValue`: the value of a range or textual element.
    #[prop(js = "accessibilityValue")]
    Value(Option<AccessibilityValue>),
    /// `accessibilityElementsHidden`: hides the view and its subtree from assistive
    /// technologies.
    #[prop(js = "accessibilityElementsHidden")]
    Hidden(bool),
    /// `importantForAccessibility`: `"auto"`, `"yes"`, `"no"` or
    /// `"no-hide-descendants"`.
    #[prop(js = "importantForAccessibility", with = crate::js::host_values::important, reset = AccessibilityProp::Important(None, false), ts = "\"auto\" | \"yes\" | \"no\" | \"no-hide-descendants\"")]
    Important(Option<bool>, bool),
    /// `accessibilityLiveRegion`: how changes of the view are announced by the
    /// screen reader — TalkBack on Android, VoiceOver on macOS, UIA's live
    /// setting and notification on Windows (`"polite"` when the user is idle,
    /// `"assertive"` right away).
    #[prop(android = "accessibilityLiveRegion")]
    #[prop(
        js = "accessibilityLiveRegion",
        ts = "\"none\" | \"polite\" | \"assertive\""
    )]
    LiveRegion(LiveRegion),
    /// `accessibilityActions`: custom actions offered to assistive technologies
    /// (`onAccessibilityAction` reports them).
    #[prop(js = "accessibilityActions")]
    Actions(Vec<AccessibilityActionDef>),
    /// `accessibilityLevel`: the level of a heading (`role="header"`, 1
    /// the top) or the depth of a tree item (`role="treeitem"`, 1 at the
    /// top); others than whole numbers from 1 are none.
    #[prop(js = "accessibilityLevel", with = crate::js::host_values::accessibility_level, reset = AccessibilityProp::Level(None), ts = "number")]
    Level(Option<u32>),
    /// `accessibilityActiveDescendant`: the element that is the active one
    /// while this element keeps the keyboard focus (ARIA's
    /// `aria-activedescendant`): a combo box's highlighted option, a
    /// list's cursor row. Screen readers read it as it changes.
    #[prop(js = "accessibilityActiveDescendant", with = crate::js::host_values::active_descendant, reset = AccessibilityProp::ActiveDescendant(None), ts = "ViewRef | null")]
    ActiveDescendant(Option<crate::element::ElementTarget>),
    /// `accessibilityControls`: the element whose content this one
    /// controls (ARIA's `aria-controls`): a combo box's listbox.
    #[prop(js = "accessibilityControls", with = crate::js::host_values::accessibility_controls, reset = AccessibilityProp::Controls(None), ts = "ViewRef | null")]
    Controls(Option<crate::element::ElementTarget>),
    /// `accessibilityDescribedBy`: the element whose text describes this
    /// one (ARIA's `aria-describedby`): a field's error or help line,
    /// placed apart from it. Screen readers read that text after the
    /// name, in the place of `accessibilityDescription` while it names a
    /// rendered element with text.
    #[prop(js = "accessibilityDescribedBy", with = crate::js::host_values::accessibility_described_by, reset = AccessibilityProp::DescribedBy(None), ts = "ViewRef | null")]
    DescribedBy(Option<crate::element::ElementTarget>),
    /// `aria-orientation` (web): set by a component from its own
    /// orientation (a `Tabs`'s), never from JS.
    Orientation(Option<crate::geometry::Axis>),
}

/// Android's press ripple (`android={{ ripple }}`).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Ripple {
    /// Ripple color; the theme's when `None`.
    pub color: Option<crate::style::Color>,
    /// The ripple is not clipped to the view.
    pub borderless: bool,
    /// Radius in points; the platform's when `None`.
    pub radius: Option<Points>,
    /// Drawn over the view's content (else behind it).
    pub foreground: bool,
}

/// Non-style properties of a view that only the platform needs.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ViewProps {
    /// Resolved overlay placement for native grid projection; ordinary views have none.
    pub overlay_anchor: Option<crate::overlay::PlacedAnchor>,
    /// A shown overlay's place in the Tab order: right after this view
    /// and before its children, where the app put the overlay (a popover's
    /// content follows its trigger), not at the end of the root view its
    /// native view is in. Set by the core; platforms that order Tab
    /// themselves walk with [`crate::input::tab_order`].
    pub tab_after: Option<crate::NodeId>,
    /// Tab and screen readers go through the view's children as they are
    /// on screen, along this axis and then across it, instead of in tree
    /// order. The core sets it on a list in its parent's viewport: a list
    /// recycles its cells, so in the tree they are not in their rows'
    /// order. Scroll views read their content so without it.
    pub screen_order: Option<crate::geometry::Axis>,
    /// Which touches the view and its subtree receive.
    pub pointer_events: PointerEvents,
    /// Extends the touch area beyond the view's bounds.
    pub hit_slop: EdgeInsets,
    /// Milliseconds before a press becomes a long press (platform default
    /// when `None`).
    pub long_press_delay: Option<f32>,
    /// Ripple while pressed (Android).
    pub ripple: Option<Ripple>,
    /// Accessibility.
    pub accessibility: Accessibility,
    /// `testID`: an identifier for UI tests.
    pub test_id: Option<Arc<str>>,
    /// `nativeID`: names the view for the embedding app's native code (a
    /// watched scroll view, `watchScroll`), apart from `testID`, which is
    /// for tests.
    pub native_id: Option<Arc<str>>,
    /// `web={{ element }}`: the HTML element the web draws the view as.
    pub web_element: Option<crate::WebElement>,
    /// Where the view goes as a link (`Link`'s `href`): data for the
    /// platform, never shown or read to accessibility clients. A terminal
    /// draws the text inside the view as an OSC 8 hyperlink to it.
    pub href: Option<Arc<str>>,
    /// `panActivation`: the view's touch responder waits for a pan the
    /// platform recognizes.
    pub pan_activation: Option<PanActivation>,
    /// A vertical pan cooperates with descendant scroll views on iOS.
    pub pan_scroll_handoff: bool,
    /// `windowDrag` (desktops): pressing the view drags the window; `None`
    /// leaves it to the views around it.
    pub window_drag: Option<bool>,
    /// `windowControl` (desktops): the system window button the view acts
    /// as.
    pub window_control: Option<crate::desktop::WindowControl>,
    /// `windowResize` (desktops): the edge or corner of a frameless window
    /// pressing the view resizes it by.
    pub window_resize: Option<crate::desktop::ResizeEdge>,
    /// `focusable`: whether the view is a stop of the keyboard focus (Tab):
    /// `Some(true)` makes any view one, whether or not it takes presses (a
    /// chart, a slider, a list that moves its selection with the arrow
    /// keys); `Some(false)` keeps a view that takes presses out; `None`, the
    /// default, leaves it to the presses ([`ViewProps::focus_stop`]).
    pub focusable: Option<bool>,
    /// Keys consumed by this view or a focused descendant before native
    /// defaults run. Backends decide from the mounted rules without
    /// waiting for a listener (`Interactive::capture_keys`).
    pub key_capture: crate::KeyCapture,
    /// Where keyboard ancestry continues for a portaled view (an overlay
    /// whose native parent is its root view while its logical parent is
    /// the view it is in): the logical parent's node id. Internal routing
    /// only; native layout, focus and hit testing keep their parent. `None`
    /// for ordinary views and for portals with no key listener or capture
    /// rule on their logical ancestry.
    pub key_parent: Option<crate::NodeId>,
    /// The app's content view where unfocused keys start in this native
    /// window. Mounted by the core so keyboard routing follows logical
    /// order even when the backend stacks the children differently. Only
    /// sent when that path has a key listener or capture rule.
    #[doc(hidden)]
    pub key_content: Option<crate::NodeId>,
    /// The view is a selectable view (`View`'s `selectable`): the
    /// texts in its subtree that are not `selectable={false}` share one
    /// selection, from text to text ([`crate::selection`]); an area inside
    /// another is part of the outer one. Texts outside areas select alone.
    pub selectable_view: bool,
    /// The app's items of a selectable view's selection menu, after the
    /// system's (`selectionMenu`): plain items and separators, each
    /// action's `id` reported as the root's `Menu` event when chosen. The
    /// selection's menu takes the items of the outermost selectable view
    /// around it ([`crate::desktop::MenuItem::selection_menu`]).
    pub selection_menu: Arc<[crate::desktop::MenuItem]>,
    /// The text continues the text before it in document order, as a long
    /// line's next wrapped part (`Element::continues_text`): in a
    /// selectable view a copy joins the two with nothing between them,
    /// and a double or triple click selects across them
    /// ([`crate::selection::SelectionTexts::continues`]).
    pub continues_text: bool,
    /// `ios={{ scrollEdgeElement }}`: the scroll view the view floats
    /// over and the edge of it the view sits at. Resolved by the core from
    /// the element the app names; `None` when it names none or that element
    /// is gone.
    pub scroll_edge_element: Option<ScrollEdgeElement>,
}

/// The edge of a scroll view a view floating over it sits at
/// (`ios={{ scrollEdgeElement }}`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
#[non_exhaustive]
pub enum ScrollEdge {
    /// The top edge.
    Top,
    /// The bottom edge (default).
    #[default]
    Bottom,
}

/// A view floating over an edge of a scroll view, as the platform gets it
/// ([`ViewProps::scroll_edge_element`]): on iOS 26 and later the scroll
/// edge effect of that scroll view takes its shape from the view, as it
/// does from a bar, so the content scrolled under the view fades out
/// around what the view shows instead of being cut by it. Elsewhere a
/// fade the app draws under the view gives the same separation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct ScrollEdgeElement {
    /// The scroll view (its native id).
    pub scroll_view: crate::NodeId,
    /// The edge of it the view sits at.
    pub edge: ScrollEdge,
}

impl ViewProps {
    /// Whether a view with these props is a stop of the keyboard focus
    /// (Tab and Shift+Tab reach it; it hears `onFocus` / `onBlur` and takes
    /// the `focus:` styles), given whether it `takes_presses` (listens for
    /// `onPress`): `focusable` decides when it is set, else taking presses
    /// does; a disabled view is never one.
    ///
    /// Focus and presses are separate: a stop that takes no presses is not
    /// pressed by Return or Space (its keys reach it through the app's
    /// keymap while it has the focus), and a view needs no press handler to
    /// be focusable, which would take the presses of a pressable around it
    /// (a chart in a card that opens a page). Backends use this decision
    /// for view focus stops; inputs that edit are stops by their own rule,
    /// and each platform adds what it knows of visibility.
    pub fn focus_stop(&self, takes_presses: bool) -> bool {
        self.focusable.unwrap_or(takes_presses) && !self.accessibility.state.disabled
    }
}

/// The way a finger moves (`PanActivation::direction`): toward the left
/// edge, the right edge, the top or the bottom.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
#[non_exhaustive]
pub enum PanDirection {
    /// Toward the left edge.
    Left,
    /// Toward the right edge.
    Right,
    /// Toward the top.
    Up,
    /// Toward the bottom.
    Down,
}

/// An edge of the screen, or of the window on desktops and the page on
/// the web, that a pan starts at (`PanActivation::edge`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
#[non_exhaustive]
pub enum PanEdge {
    /// The left edge: the pan moves right.
    Left,
    /// The right edge: the pan moves left.
    Right,
    /// The top edge: the pan moves down.
    Top,
    /// The bottom edge: the pan moves up.
    Bottom,
}

impl PanEdge {
    /// The way a pan from this edge moves: away from it.
    pub(crate) fn direction(self) -> PanDirection {
        match self {
            PanEdge::Left => PanDirection::Right,
            PanEdge::Right => PanDirection::Left,
            PanEdge::Top => PanDirection::Down,
            PanEdge::Bottom => PanDirection::Up,
        }
    }
}

/// When the pans on a view activate (`panActivation`; react-native-gesture-
/// handler's `activeOffsetX` / `failOffsetY`), decided by the platform on
/// the main thread as the fingers move: once the finger has moved further
/// than an active offset from where it went down, the pan activates (the
/// view becomes the touch responder and the scroll views around it can no
/// longer take these touches); once it has moved further than a fail offset
/// first, the pan fails and the scroll views keep the touches. Offsets are
/// distances in points along one axis, either direction. Without active
/// offsets, the pan activates after [`PanActivation::MIN_DISTANCE`] in any
/// direction. The view's native pan (`pan` values, `on_pan_start`) starts
/// when it activates too.
///
/// A [`direction`](Self::direction) keeps the pan to one way: a drag the
/// other way, or mostly across it, fails it and stays with the views
/// around. An [`edge`](Self::edge) keeps it to fingers that go down at
/// that edge of the screen, moving away from it.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct PanActivation {
    /// Activates once the finger moved further than this horizontally.
    pub active_offset_x: Option<Points>,
    /// Activates once the finger moved further than this vertically.
    pub active_offset_y: Option<Points>,
    /// Fails once the finger moved further than this horizontally first.
    pub fail_offset_x: Option<Points>,
    /// Fails once the finger moved further than this vertically first.
    pub fail_offset_y: Option<Points>,
    /// The one way the pan activates in: once the finger moved that way
    /// further than the active offset along its axis
    /// ([`PanActivation::MIN_DISTANCE`] without one), and more along it
    /// than across. A move as far the other way fails the pan, and so does
    /// one mostly across it, unless a fail offset across is given, which
    /// decides that instead. The active offset across is not used.
    pub direction: Option<PanDirection>,
    /// The edge of the screen the pan starts at (of the window on desktops,
    /// of the page on the web): only a finger that goes down within
    /// [`PanActivation::EDGE_WIDTH`] of it starts the pan, which then moves
    /// away from it (that is its direction; `direction` is not used). iOS
    /// recognizes the native pan with its own screen-edge gesture, whose
    /// edge is the system's, and a navigation stack that can go back keeps
    /// its swipe back. On Android, the system's back gesture keeps the left
    /// and right edges under gesture navigation.
    pub edge: Option<PanEdge>,
}

impl PanActivation {
    /// How far the finger moves before a pan without active offsets
    /// activates, in points.
    pub const MIN_DISTANCE: Points = px(10.0);

    /// How far from its edge a finger goes down to start an edge pan
    /// ([`PanActivation::edge`]), in points.
    pub const EDGE_WIDTH: Points = px(20.0);

    /// Sets [`PanActivation::active_offset_x`].
    pub fn active_offset_x(mut self, offset: Points) -> Self {
        self.active_offset_x = Some(offset);
        self
    }

    /// Sets [`PanActivation::active_offset_y`].
    pub fn active_offset_y(mut self, offset: Points) -> Self {
        self.active_offset_y = Some(offset);
        self
    }

    /// Sets [`PanActivation::fail_offset_x`].
    pub fn fail_offset_x(mut self, offset: Points) -> Self {
        self.fail_offset_x = Some(offset);
        self
    }

    /// Sets [`PanActivation::fail_offset_y`].
    pub fn fail_offset_y(mut self, offset: Points) -> Self {
        self.fail_offset_y = Some(offset);
        self
    }

    /// Sets [`PanActivation::direction`]: a drawer opened by a drag to
    /// the right over its content, `PanActivation::default()
    /// .direction(PanDirection::Right)`, leaves the drags to the left to
    /// the content.
    pub fn direction(mut self, direction: PanDirection) -> Self {
        self.direction = Some(direction);
        self
    }

    /// Sets [`PanActivation::edge`]: a drawer opened from the left edge,
    /// `PanActivation::default().edge(PanEdge::Left)`.
    pub fn edge(mut self, edge: PanEdge) -> Self {
        self.edge = Some(edge);
        self
    }

    /// The way the pan activates in, if it has one: away from its edge, or
    /// its direction. For the backends.
    #[doc(hidden)]
    pub fn way(&self) -> Option<PanDirection> {
        self.edge.map(PanEdge::direction).or(self.direction)
    }

    /// Whether a finger going down at `at` may start the pan, in an area
    /// (the screen, the window or the page) of `size` with `at` measured
    /// from its top left corner: anywhere without an
    /// [`edge`](Self::edge), else within [`PanActivation::EDGE_WIDTH`] of
    /// it. For the backends.
    #[doc(hidden)]
    pub fn starts_at(&self, at: Point<Points>, size: crate::Size<Points>) -> bool {
        let w = Self::EDGE_WIDTH.0;
        match self.edge {
            None => true,
            Some(PanEdge::Left) => at.x.0 <= w,
            Some(PanEdge::Right) => at.x.0 >= size.width.0 - w,
            Some(PanEdge::Top) => at.y.0 <= w,
            Some(PanEdge::Bottom) => at.y.0 >= size.height.0 - w,
        }
    }

    /// A pan that activates horizontally past `active` and fails when it
    /// moves vertically past `fail` first (a scrubber in a vertical scroll
    /// view).
    pub const fn horizontal(active: Points, fail: Points) -> Self {
        Self {
            active_offset_x: Some(active),
            active_offset_y: None,
            fail_offset_x: None,
            fail_offset_y: Some(fail),
            direction: None,
            edge: None,
        }
    }

    /// A pan that activates vertically past `active` and fails when it
    /// moves horizontally past `fail` first.
    pub const fn vertical(active: Points, fail: Points) -> Self {
        Self {
            active_offset_x: None,
            active_offset_y: Some(active),
            fail_offset_x: Some(fail),
            fail_offset_y: None,
            direction: None,
            edge: None,
        }
    }

    /// The one axis this pan is for, when its way or its offsets name one:
    /// `Some(true)` horizontal (a way left or right, an active offset along
    /// x, or a fail offset along y), `Some(false)` vertical, `None` either.
    /// A view listening to `onWheel` with a pan along one axis takes only
    /// the wheels along it ([`crate::input::wheel_along`]).
    pub fn axis(&self) -> Option<bool> {
        if let Some(way) = self.way() {
            return Some(matches!(way, PanDirection::Left | PanDirection::Right));
        }
        let x = self.active_offset_x.is_some() || self.fail_offset_y.is_some();
        let y = self.active_offset_y.is_some() || self.fail_offset_x.is_some();
        match (x, y) {
            (true, false) => Some(true),
            (false, true) => Some(false),
            _ => None,
        }
    }

    /// The decision once the finger moved by (`dx`, `dy`) since it went
    /// down: `Some(true)` activates, `Some(false)` fails (a fail offset
    /// passed wins over an active one passed by the same move), `None`
    /// waits. The platforms ask it on every move until it decides.
    pub fn decide(&self, dx: Points, dy: Points) -> Option<bool> {
        let (dx, dy) = (dx.0, dy.0);
        let past = |limit: Option<Points>, d: f32| limit.is_some_and(|l| d.abs() > l.0);
        if past(self.fail_offset_x, dx) || past(self.fail_offset_y, dy) {
            return Some(false);
        }
        if let Some(way) = self.way() {
            // How far it moved that way and across, the offset along it, and
            // whether a fail offset across decides the moves across.
            let (along, across, active, fail_across) = match way {
                PanDirection::Right => (dx, dy, self.active_offset_x, self.fail_offset_y),
                PanDirection::Left => (-dx, dy, self.active_offset_x, self.fail_offset_y),
                PanDirection::Down => (dy, dx, self.active_offset_y, self.fail_offset_x),
                PanDirection::Up => (-dy, dx, self.active_offset_y, self.fail_offset_x),
            };
            let limit = active.unwrap_or(Self::MIN_DISTANCE).0;
            let across = across.abs();
            if along > limit && along >= across {
                return Some(true);
            }
            let across_fails = fail_across.is_none() && across > limit && across > along;
            return (-along > limit || across_fails).then_some(false);
        }
        let activates = if self.active_offset_x.is_some() || self.active_offset_y.is_some() {
            past(self.active_offset_x, dx) || past(self.active_offset_y, dy)
        } else {
            dx.hypot(dy) > Self::MIN_DISTANCE.0
        };
        activates.then_some(true)
    }

    /// [`PanActivation::decide`] on a move of the finger from offset `from`
    /// to offset `to` (both from where it went down), judged along the
    /// straight line between them a point at a time: the offset the finger
    /// passed first decides, even when the move passes both. Moves arrive
    /// several points apart, and a diagonal 1.5 across for 1 down passes
    /// `activeOffsetX: 10` and `failOffsetY: 10` within one 10-point move.
    /// The platforms ask it with the previous move's offset as `from`.
    pub fn decide_move(&self, from: Point<Points>, to: Point<Points>) -> Option<bool> {
        let (mx, my) = (to.x.0 - from.x.0, to.y.0 - from.y.0);
        let steps = mx.hypot(my).ceil().max(1.0) as u32;
        (1..=steps).find_map(|i| {
            let t = i as f32 / steps as f32;
            self.decide(Points(from.x.0 + mx * t), Points(from.y.0 + my * t))
        })
    }
}

/// Native animation values driven by gestures on a view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct GestureValues {
    /// Horizontal drag translation (`pan={{ x }}`).
    pub pan_x: Option<crate::animation::NodeId>,
    /// Vertical drag translation (`pan={{ y }}`).
    pub pan_y: Option<crate::animation::NodeId>,
    /// Pinch scale (`pinch={{ scale }}`), multiplied from its value when the
    /// pinch starts.
    pub pinch: Option<crate::animation::NodeId>,
    /// Two-finger rotation in degrees (`rotation={{ angle }}`), added to its
    /// value when the rotation starts.
    pub rotation: Option<crate::animation::NodeId>,
}

impl GestureValues {
    /// True if no value is driven.
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// Timing curve of a layout animation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LayoutCurve {
    /// Constant speed.
    Linear,
    /// Accelerates.
    EaseIn,
    /// Decelerates.
    EaseOut,
    /// Accelerates, then decelerates.
    EaseInEaseOut,
    /// A spring's physics ([`LayoutTransition::spring`]): it times itself,
    /// lasting until it settles ([`Spring::settle_ms`]), and moves the same
    /// on every platform. The transition's `duration_ms` is not used. Its
    /// `velocity` and `frame_rate` are not either: a layout moves from rest
    /// at the screen's rate. JS names it with a `type: "spring"` phase's
    /// `stiffness`, `damping` or `mass`.
    ///
    /// [`Spring::settle_ms`]: crate::element::Spring::settle_ms
    Spring(crate::element::Spring),
    /// A spring of this damping ratio fitted into the transition's
    /// duration, which each platform draws with its own spring: the JS
    /// `LayoutAnimation`'s `type: "spring"` (`springDamping`) without a
    /// stiffness, damping or mass. Rust prefers
    /// [`LayoutCurve::Spring`].
    FittedSpring {
        /// Damping ratio (0..1): 1 does not overshoot.
        damping_ratio: f32,
    },
    /// The software keyboard's motion (`type: "keyboard"`): the curve the
    /// system moves its keyboard with, timed from when the keyboard
    /// started to move, so that what makes room for it moves with it (the
    /// duration is the keyboard's, `keyboard_duration`). Where there is no
    /// software keyboard, or nothing moved it, it eases in and out.
    Keyboard,
    /// A cubic Bézier `[x1, y1, x2, y2]` over the transition's duration,
    /// as CSS `cubic-bezier()` (`type: "bezier"` with `bezier` in JS):
    /// the curve an app's design names. The `x` of each control point is
    /// clamped to 0..1.
    Bezier([f32; 4]),
}

impl LayoutCurve {
    /// A cubic Bézier `[x1, y1, x2, y2]` ([`LayoutCurve::Bezier`]), each
    /// control point's `x` clamped to 0..1.
    pub fn bezier(x1: f32, y1: f32, x2: f32, y2: f32) -> Self {
        Self::Bezier([x1.clamp(0.0, 1.0), y1, x2.clamp(0.0, 1.0), y2])
    }
}

/// The property animated when views appear or disappear.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayoutProperty {
    /// Fade in / out.
    Opacity,
    /// Grow / shrink from the center.
    Scale,
}

/// How one kind of change animates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayoutTransition {
    /// Curve.
    pub curve: LayoutCurve,
    /// Animated property of appearing / disappearing views.
    pub property: LayoutProperty,
    /// Duration in milliseconds.
    pub duration_ms: f32,
    /// Delay in milliseconds.
    pub delay_ms: f32,
}

/// Animates the layout changes of the next commit
/// (`LayoutAnimation.configureNext`).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct LayoutAnimation {
    /// Views inserted by the commit.
    pub create: Option<LayoutTransition>,
    /// Views whose frame changes.
    pub update: Option<LayoutTransition>,
    /// Views removed by the commit.
    pub delete: Option<LayoutTransition>,
}

impl LayoutTransition {
    /// `curve` over `duration_ms`, appearing views fading.
    pub const fn new(curve: LayoutCurve, duration_ms: f32) -> Self {
        Self {
            curve,
            property: LayoutProperty::Opacity,
            duration_ms,
            delay_ms: 0.0,
        }
    }

    /// On `spring`'s physics ([`LayoutCurve::Spring`]), lasting until it
    /// settles, appearing views fading.
    pub fn spring(spring: crate::element::Spring) -> Self {
        Self::new(LayoutCurve::Spring(spring), spring.settle_ms())
    }

    /// How long it runs, in milliseconds: its `duration_ms`, or the time
    /// its spring settles in ([`LayoutCurve::Spring`] times itself). What
    /// the platforms animate over.
    pub fn run_ms(&self) -> f32 {
        match self.curve {
            LayoutCurve::Spring(spring) => spring.settle_ms(),
            _ => self.duration_ms,
        }
    }
}

impl LayoutAnimation {
    /// `transition` for every kind of change.
    pub const fn all(transition: LayoutTransition) -> Self {
        Self {
            create: Some(transition),
            update: Some(transition),
            delete: Some(transition),
        }
    }

    /// React Native's `LayoutAnimation.Presets.easeInEaseOut`: 300 ms,
    /// views fading in and out.
    pub const EASE_IN_EASE_OUT: Self =
        Self::all(LayoutTransition::new(LayoutCurve::EaseInEaseOut, 300.0));

    /// `Presets.linear`: 500 ms at constant speed.
    pub const LINEAR: Self = Self::all(LayoutTransition::new(LayoutCurve::Linear, 500.0));

    /// `Presets.spring`: frames spring (damping 0.4) over 700 ms, views
    /// fade linearly.
    pub const SPRING: Self = Self {
        create: Some(LayoutTransition::new(LayoutCurve::Linear, 700.0)),
        update: Some(LayoutTransition::new(
            LayoutCurve::FittedSpring { damping_ratio: 0.4 },
            700.0,
        )),
        delete: Some(LayoutTransition::new(LayoutCurve::Linear, 700.0)),
    };
}
