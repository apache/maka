use std::sync::Arc;

use nsh_macros::PropEnum;

use crate::{
    animation::{AnimationOp, AnimationProp},
    geometry::{Bounds, Points, Size},
    ops::{
        AutoCapitalize, Command, EventMask, ImageSource, KeyboardAppearance, KeyboardDismissMode,
        KeyboardTaps, KeyboardType, ModalAnimation, ModalPresentation, NodeId, PasteBehavior,
        ResizeMode, ReturnKeyType, ScreenAnimation, SnapAlignment, SubmitBehavior, WebSource,
    },
    props::{EdgeInsets, GestureValues, LayoutAnimation, ViewProps},
    style::{Color, TextAlign, ViewStyle},
    text::{AttributedText, ResolvedTextStyle, TextLayout},
};

/// Kind of native view to create.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewKind {
    /// A plain container view.
    View,
    /// A text label.
    Text,
    /// An image.
    Image,
    /// A scroll view (also used by lists).
    Scroll,
    /// A text input.
    Input,
    /// A navigation stack: its children are screens, pushed and popped
    /// natively.
    Stack,
    /// A screen of a stack (its root view; the platform also makes its
    /// header).
    Screen,
    /// The root view of a modal: inserting it presents the modal, removing
    /// it dismisses it.
    Modal,
    /// A view shown in a screen's header (its slot is in the screen's
    /// [`ScreenConfig`]).
    HeaderItem,
    /// A bar over the keyboard ([`InputConfig::accessory`]); its frame's
    /// size is its own, the platform places it.
    InputAccessory,
    /// A canvas ([`MountItem::Canvas`]).
    Canvas,
    /// A web view.
    WebView,
    /// The container of a registered native component: the platform
    /// creates the component in it ([`MountItem::Component`]) and fills it
    /// with the component's view; decoration and frames are the
    /// container's.
    Native,
    /// A video player.
    Video,
}

/// A web view.
#[derive(Debug, Clone, PartialEq)]
pub struct WebProps {
    /// What it shows.
    pub source: WebSource,
    /// The `src` prop, which [`Self::source`] loads unless `html` is set.
    pub src: Option<Arc<str>>,
    /// The `baseUrl` prop, which [`Self::source`] holds while `html` is
    /// set.
    pub base_url: Option<Arc<str>>,
    /// Script run after each page loads.
    pub injected_js: Option<Arc<str>>,
    /// Script run before each page's own scripts.
    pub injected_js_before: Option<Arc<str>>,
    /// User agent; the platform's when `None`.
    pub user_agent: Option<Arc<str>>,
    /// The page scrolls.
    pub scrollable: bool,
    /// The page may run JavaScript.
    pub javascript_enabled: bool,
    /// Swipes go back and forward (iOS).
    pub back_forward_gestures: bool,
}

impl Default for WebProps {
    fn default() -> Self {
        Self {
            source: WebSource::None,
            src: None,
            base_url: None,
            injected_js: None,
            injected_js_before: None,
            user_agent: None,
            scrollable: true,
            javascript_enabled: true,
            back_forward_gestures: false,
        }
    }
}

/// What a video's sound does to the rest of the device's audio while it
/// plays: whether it plays in silent mode, whether other apps' audio pauses,
/// and whether the system treats it as speech. iOS sets the shared
/// `AVAudioSession` while such a video plays and restores it after; Android
/// marks the sound as speech and holds audio focus for `Playback`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum AudioSession {
    /// The app's audio settings (the platform's for video unless the app, or
    /// the app embedding NSH, set others): nothing is changed.
    #[default]
    Default,
    /// Plays speech: audible in silent mode, other apps' audio pauses while
    /// it plays (Apple's `playback` category, `spokenAudio` mode; Android's
    /// speech content type with transient audio focus).
    Playback,
    /// Plays speech over other apps' audio, which keeps playing
    /// (Apple's `playback` category with `mixWithOthers`; Android's speech
    /// content type without audio focus).
    MixWithOthers,
}

/// A video player.
#[derive(Debug, Clone, PartialEq)]
pub struct VideoProps {
    /// The video's URL (or `asset:/` URI).
    pub source: Option<Arc<str>>,
    /// What its sound does to the rest of the device's audio.
    pub audio_session: AudioSession,
    /// Paused.
    pub paused: bool,
    /// Muted.
    pub muted: bool,
    /// Volume, 0..1.
    pub volume: f32,
    /// Playback rate.
    pub rate: f32,
    /// Loop.
    pub repeat: bool,
    /// How the picture fits the view.
    pub resize_mode: ResizeMode,
    /// Show the platform's playback controls.
    pub controls: bool,
    /// Milliseconds between `onProgress` events.
    pub progress_interval_ms: f32,
}

impl Default for VideoProps {
    fn default() -> Self {
        Self {
            source: None,
            audio_session: AudioSession::default(),
            paused: false,
            muted: false,
            volume: 1.0,
            rate: 1.0,
            repeat: false,
            resize_mode: ResizeMode::Contain,
            controls: false,
            progress_interval_ms: 250.0,
        }
    }
}

/// The properties of a native control.
#[derive(Debug, Clone, PartialEq)]
pub enum NativeProps {
    /// A web view.
    WebView(Box<WebProps>),
    /// A video player.
    Video(Box<VideoProps>),
}

/// How a scroll view scrolls (React Native's ScrollView props).
#[derive(Debug, Clone, PartialEq)]
pub struct ScrollBehavior {
    /// Stops at multiples of the viewport.
    pub paging: bool,
    /// Stops at multiples of this length (0: off).
    pub snap_interval: Points,
    /// Stops at these offsets.
    pub snap_offsets: Vec<Points>,
    /// Which point of a snap page aligns with the viewport.
    pub snap_alignment: SnapAlignment,
    /// Velocity kept per millisecond after a fling (0: platform default).
    pub deceleration: f32,
    /// The user can scroll it.
    pub enabled: bool,
    /// It overscrolls past its edges.
    pub bounces: bool,
    /// Room around the content.
    pub content_inset: EdgeInsets,
    /// Whether taps dismiss the keyboard.
    pub keyboard_taps: KeyboardTaps,
    /// A fling moves one snap point at most (`disableIntervalMomentum`).
    pub one_step: bool,
    /// `minimumZoomScale`.
    pub min_zoom: f32,
    /// `maximumZoomScale`: pinching zooms the content when above
    /// `min_zoom` (`<scroll>` only, not lists).
    pub max_zoom: f32,
    /// `bouncesZoom`: pinching may go past the limits and springs back.
    pub bounces_zoom: bool,
    /// `zoomable`: the user can pinch to zoom.
    pub pinch: bool,
    /// `centerContent`: content smaller than the viewport is centered.
    pub center_content: bool,
    /// `refreshIndicator`: the height of the app's own pull-to-refresh
    /// indicator, which replaces the platform's spinner; `None` for the
    /// platform's.
    pub refresh_indicator: Option<Points>,
}

/// How far past the top a released pull refreshes with the platform's
/// spinner.
const REFRESH_PULL: Points = Points(64.0);
/// The room the platform's spinner keeps above the content while
/// refreshing.
const REFRESH_SPACE: Points = Points(56.0);

impl Default for ScrollBehavior {
    fn default() -> Self {
        Self {
            paging: false,
            snap_interval: Points::ZERO,
            snap_offsets: Vec::new(),
            snap_alignment: SnapAlignment::Start,
            deceleration: 0.0,
            enabled: true,
            bounces: true,
            content_inset: EdgeInsets::default(),
            keyboard_taps: KeyboardTaps::Never,
            one_step: false,
            min_zoom: 1.0,
            max_zoom: 1.0,
            bounces_zoom: true,
            pinch: true,
            center_content: false,
            refresh_indicator: None,
        }
    }
}

impl ScrollBehavior {
    /// Whether the content zooms (scrolling both ways while zoomed in).
    pub fn zooms(&self) -> bool {
        self.max_zoom > self.min_zoom
    }

    /// Whether a vertical scroll view dragged to `offset` (negative: pulled
    /// past its top) refreshes when the finger lifts, if it listens to
    /// `onRefresh` and is not refreshing yet.
    pub fn refreshes(&self, offset: Points) -> bool {
        offset.0 <= -self.refresh_threshold().0
    }

    /// How far past the top a released pull refreshes: the app's
    /// indicator's height, or the platform spinner's distance.
    pub fn refresh_threshold(&self) -> Points {
        self.refresh_indicator.unwrap_or(REFRESH_PULL)
    }

    /// The room kept above the content while it refreshes: the app's
    /// indicator's height, or the platform spinner's.
    pub fn refresh_inset(&self) -> Points {
        self.refresh_indicator.unwrap_or(REFRESH_SPACE)
    }

    /// Whether flings end at snap points.
    pub fn snaps(&self) -> bool {
        self.snap_interval.0 > 0.0 || !self.snap_offsets.is_empty()
    }

    /// The snap point a fling ends at, as in React Native: `offset` is
    /// where the drag ended, `projected` where the fling would glide to
    /// (both along the main axis, points) and `velocity` its speed (points
    /// per millisecond), for a viewport of `viewport` and content of
    /// `content` points. Pages (and `one_step`) move one snap point; other
    /// snapping rounds the projected offset in the fling's direction.
    /// `None` without snapping.
    pub fn snap_target(
        &self,
        offset: Points,
        projected: Points,
        velocity: f32,
        viewport: Points,
        content: Points,
    ) -> Option<Points> {
        let (offset, projected, viewport) = (offset.0, projected.0, viewport.0);
        let max = (content.0 - viewport).max(0.0);
        let points: Vec<f32> = if self.snap_interval.0 > 0.0 {
            let interval = self.snap_interval.0;
            // Aligns the item at `k * interval` with the viewport.
            let shift = match self.snap_alignment {
                SnapAlignment::Start => 0.0,
                SnapAlignment::Center => (viewport - interval) / 2.0,
                SnapAlignment::End => viewport - interval,
            };
            let n = ((max + shift) / interval).ceil().max(0.0) as usize;
            (0..=n)
                .map(|i| (i as f32 * interval - shift).clamp(0.0, max))
                .collect()
        } else if !self.snap_offsets.is_empty() {
            self.snap_offsets
                .iter()
                .map(|o| o.0.clamp(0.0, max))
                .collect()
        } else if self.paging {
            let page = viewport.max(1.0);
            (0..=(max / page).ceil() as usize)
                .map(|i| (i as f32 * page).min(max))
                .collect()
        } else {
            return None;
        };
        // Slower releases (points per ms) settle at the nearest point.
        const SLOW: f32 = 0.3;
        let step = self.one_step || (self.paging && !self.snaps());
        let target = if step {
            if velocity > SLOW {
                points.iter().copied().find(|&p| p > offset + 0.5)
            } else if velocity < -SLOW {
                points.iter().rev().copied().find(|&p| p < offset - 0.5)
            } else {
                nearest(&points, offset)
            }
        } else if velocity > SLOW {
            points.iter().copied().find(|&p| p >= projected - 0.5)
        } else if velocity < -SLOW {
            points.iter().rev().copied().find(|&p| p <= projected + 0.5)
        } else {
            nearest(&points, projected)
        };
        Some(Points(target.unwrap_or(if velocity > 0.0 {
            max
        } else {
            0.0
        })))
    }
}

fn nearest(points: &[f32], to: f32) -> Option<f32> {
    points
        .iter()
        .copied()
        .min_by(|a, b| (a - to).abs().total_cmp(&(b - to).abs()))
}

/// A list cell that sticks to the start of the viewport (or the list's
/// sticky offset from it): at scroll offset `offset` (along the main axis)
/// it shows `clamp(offset - start, 0, end - start)` past where it is laid
/// out.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
#[non_exhaustive]
pub struct StickyCell {
    /// The cell.
    pub cell: NodeId,
    /// The scroll offset from which it moves with the scroll: its position
    /// in the content less the list's sticky offset.
    pub start: Points,
    /// The scroll offset at which the next sticky cell pushes it out (may be
    /// infinite).
    pub end: Points,
    /// An animated value added to the scroll offset: it sticks that much
    /// further from the viewport's start (below a header that moves), at
    /// `clamp(offset + value - start, 0, end - start)`. The platforms read
    /// it from the animation graph whenever they pin, and pin again on the
    /// graph's frames.
    pub offset: Option<crate::animation::NodeId>,
}

/// The header heights a platform without a native header gives the core
/// ([`crate::Core::set_header_heights`]; the desktops, the web): NSH draws
/// no header there. A page's `header` slot ([`ScreenConfig::header_view`])
/// is placed at its top instead, as wide as the page and as tall as it lays
/// out, and the content starts below it; the native header's options
/// (`title`, `headerLeft`, `headerStyle`, ...) are ignored.
pub const NO_NATIVE_HEADER: (Points, Points) = (Points::ZERO, Points::ZERO);

/// Options of a screen: its header and transitions.
///
/// The header options are the native header's (iOS, Android); a platform
/// without one ([`NO_NATIVE_HEADER`]) reads only `header_view`,
/// `header_height`, `prevent_back`, `gesture_enabled` and `animation`.
#[derive(Debug, Clone, PartialEq)]
pub struct ScreenConfig {
    /// Title in the header.
    pub title: Option<Arc<str>>,
    /// Show the native header.
    pub header_visible: bool,
    /// Large title (iOS; the content scrolls under the header).
    pub large_title: bool,
    /// The content extends under the header.
    pub header_transparent: bool,
    /// Color of the back button and bar buttons.
    pub tint_color: Option<Color>,
    /// Header background.
    pub background_color: Option<Color>,
    /// Title color.
    pub title_color: Option<Color>,
    /// Label of the back button leading back to this screen.
    pub back_title: Option<Arc<str>>,
    /// Show the back button.
    pub back_visible: bool,
    /// The interactive back gesture (iOS swipe back, Android predictive back
    /// following the finger) is on; the back button pops either way
    /// (`popOnSwipe`).
    pub gesture_enabled: bool,
    /// The user cannot leave the screen (`popOnBack` false: no swipe, the
    /// back buttons do not pop): answered by the platform when the system
    /// asks, without JS. Every back press sends
    /// [`crate::EventKind::BackRequest`] either way.
    pub prevent_back: bool,
    /// Push / pop transition.
    pub animation: ScreenAnimation,
    /// Leading header item view.
    pub left: Option<NodeId>,
    /// Trailing header item view.
    pub right: Option<NodeId>,
    /// UIKit's own bar button in the trailing slot instead of `right`'s
    /// view (iOS); a press on it presses `right`'s first pressable view.
    pub right_system_item: Option<crate::HeaderSystemItem>,
    /// Custom title view.
    pub title_view: Option<NodeId>,
    /// The app's header (`header`): on a platform without a native header
    /// ([`NO_NATIVE_HEADER`]), a view at the top of the screen whose frame
    /// the core sets (as wide as the screen, as tall as it lays out),
    /// above the content.
    pub header_view: Option<NodeId>,
    /// Height of the header area at the top of the screen, as the core laid
    /// the content out below it: the native header's (status bar included),
    /// or the `header` view's without a native header.
    pub header_height: Points,
}

impl Default for ScreenConfig {
    fn default() -> Self {
        Self {
            title: None,
            header_visible: true,
            large_title: false,
            header_transparent: false,
            tint_color: None,
            background_color: None,
            title_color: None,
            back_title: None,
            back_visible: true,
            gesture_enabled: true,
            prevent_back: false,
            animation: ScreenAnimation::Default,
            left: None,
            right: None,
            right_system_item: None,
            title_view: None,
            header_view: None,
            header_height: Points::ZERO,
        }
    }
}

/// Options of a modal (`Dialog`).
///
/// The modal itself has no look: on the desktops and the web it is a
/// transparent layer over the whole window (no card, scrim, shadow or
/// background; `presentation` is ignored), and what shows is the app's
/// popup and backdrop, which the runtime renders inside it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModalConfig {
    /// How it appears.
    pub animation: ModalAnimation,
    /// How it covers the screen (iOS).
    pub presentation: ModalPresentation,
    /// Android: the content reaches under the status bar.
    pub status_bar_translucent: bool,
    /// iOS: the orientations it allows ([`ModalConfig::PORTRAIT`], ...);
    /// 0 keeps the presenter's.
    pub orientations: u8,
    /// Escape and the Android back button close it natively
    /// (`closeOnEscape`); either way they report
    /// [`crate::EventKind::RequestClose`] (reason `"cancel"`), and
    /// [`crate::EventKind::Dismiss`] after closing.
    pub close_on_escape: bool,
    /// A press on the backdrop closes it (`closeOnBackdropPress`): the
    /// runtime handles presses on the app's backdrop part; a platform
    /// reads it only for a backdrop of its own (a native sheet's).
    pub close_on_backdrop_press: bool,
    /// Swiping a sheet down closes it natively (`closeOnSwipe`).
    pub close_on_swipe: bool,
}

impl Default for ModalConfig {
    fn default() -> Self {
        Self {
            animation: ModalAnimation::default(),
            presentation: ModalPresentation::default(),
            status_bar_translucent: false,
            orientations: 0,
            close_on_escape: true,
            close_on_backdrop_press: true,
            close_on_swipe: true,
        }
    }
}

impl ModalConfig {
    /// `portrait`.
    pub const PORTRAIT: u8 = 1;
    /// `portrait-upside-down`.
    pub const PORTRAIT_UPSIDE_DOWN: u8 = 2;
    /// `landscape-left`.
    pub const LANDSCAPE_LEFT: u8 = 4;
    /// `landscape-right`.
    pub const LANDSCAPE_RIGHT: u8 = 8;
}

/// Everything about a text input except its text.
#[derive(Debug, Clone, PartialEq)]
pub struct InputConfig {
    /// Font and color of the text.
    pub style: ResolvedTextStyle,
    /// Alignment of the text.
    pub align: TextAlign,
    /// Shown while the text is empty.
    pub placeholder: String,
    /// Placeholder color; the platform's default when `None`.
    pub placeholder_color: Option<Color>,
    /// Hide the characters (passwords).
    pub secure: bool,
    /// Keyboard layout.
    pub keyboard: KeyboardType,
    /// The keyboard's look (iOS).
    pub keyboard_appearance: KeyboardAppearance,
    /// Label of the return key.
    pub return_key: ReturnKeyType,
    /// Automatic capitalization.
    pub auto_capitalize: AutoCapitalize,
    /// Autocorrection.
    pub auto_correct: bool,
    /// Several lines (return inserts a line break).
    pub multiline: bool,
    /// Styled and optionally atomic source ranges, matched natively.
    pub tokens: Vec<crate::input_tokens::InputTokenRule>,
    /// Maximum length in UTF-16 units.
    pub max_length: Option<u32>,
    /// The user can edit the text.
    pub editable: bool,
    /// Return unfocuses a single-line input without a `submitBehavior`
    /// (always true from TS); [`InputConfig::submit`] resolves it.
    pub blur_on_submit: bool,
    /// `submitBehavior` as set; [`InputConfig::submit`] resolves it.
    pub submit_behavior: Option<SubmitBehavior>,
    /// What a paste does (`pasteBehavior`).
    pub paste_behavior: PasteBehavior,
    /// Focus once on screen.
    pub auto_focus: bool,
    /// Caret and selection color.
    pub selection_color: Option<Color>,
    /// What the input holds, for autofill.
    pub auto_fill: crate::ops::AutoFill,
    /// The text runs right to left.
    pub rtl: bool,
    /// No caret is drawn (`caret={false}`).
    pub caret_hidden: bool,
    /// `inputAccessoryViewID` as set.
    pub accessory_id: Option<Box<str>>,
    /// The input accessory it names, if one is mounted.
    pub accessory: Option<NodeId>,
}

impl InputConfig {
    /// What return does, as `submitBehavior` and `multiline` say
    /// together: the set behavior (a single line never takes line breaks),
    /// else a line break in a multiline input, else a submit that
    /// unfocuses unless [`InputConfig::blur_on_submit`] is false (Rust).
    pub fn submit(&self) -> SubmitBehavior {
        match self.submit_behavior {
            Some(SubmitBehavior::Newline) if !self.multiline => SubmitBehavior::BlurAndSubmit,
            Some(behavior) => behavior,
            None if self.multiline => SubmitBehavior::Newline,
            None if self.blur_on_submit => SubmitBehavior::BlurAndSubmit,
            None => SubmitBehavior::Submit,
        }
    }
}

impl Default for InputConfig {
    fn default() -> Self {
        Self {
            style: ResolvedTextStyle::default(),
            align: TextAlign::Auto,
            placeholder: String::new(),
            placeholder_color: None,
            secure: false,
            keyboard: KeyboardType::Default,
            keyboard_appearance: KeyboardAppearance::Default,
            return_key: ReturnKeyType::Default,
            auto_capitalize: AutoCapitalize::Sentences,
            auto_correct: true,
            multiline: false,
            tokens: Vec::new(),
            max_length: None,
            editable: true,
            blur_on_submit: true,
            submit_behavior: None,
            paste_behavior: PasteBehavior::Insert,
            auto_focus: false,
            selection_color: None,
            auto_fill: crate::ops::AutoFill::Default,
            rtl: false,
            caret_hidden: false,
            accessory_id: None,
            accessory: None,
        }
    }
}

/// How an image is shown, besides its source.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ImageOptions {
    /// `placeholder`: shown until the image loads (and if it fails).
    pub placeholder: Option<ImageSource>,
    /// `blurRadius` in points (0: sharp).
    pub blur_radius: Points,
    /// `fadeDuration` in milliseconds; the platform's default when `None`
    /// (React Native: 300 on Android, none on iOS).
    pub fade_ms: Option<f32>,
    /// `objectPosition`: where the image sits in its box once the resize
    /// mode has sized it ([`crate::ResizeMode::fit`]).
    pub position: crate::style::ObjectPosition,
}

/// One instruction for the platform backend.
///
/// Items must be applied in order: [`MountItem::Insert`] refers to views
/// created by the preceding items.
#[derive(Debug, Clone)]
pub enum MountItem {
    /// Create a native view. It starts detached and invisible.
    Create {
        /// Node id, used to address the view in later items.
        id: NodeId,
        /// View kind.
        kind: ViewKind,
    },
    /// Report the view's interaction states named by these bits
    /// (`tailwind::state`: pressed, hovered, focused, focus within) with
    /// `EngineControl::set_states`; 0 stops reporting. The states no
    /// longer tracked are forgotten on both sides (the core and the
    /// platform keep `states & tracked`), so the two never disagree about
    /// a state the platform stopped reporting.
    TrackStates {
        /// View id.
        id: NodeId,
        /// The states.
        states: u8,
    },
    /// Insert (or move) `child` into `parent`, below sibling `before` (or
    /// on top when `None`). Siblings rather than indices, so platform-owned
    /// subviews (refresh controls, scroll indicators) cannot shift positions.
    Insert {
        /// Parent view.
        parent: NodeId,
        /// Child view.
        child: NodeId,
        /// The app sibling to insert below.
        before: Option<NodeId>,
    },
    /// Projects an independent native root. A following root may still be
    /// parked by an earlier retirement, or kept by native focus. Insert
    /// below the first candidate actually attached to the same native host.
    /// SDK-owned modal/route hosts retain their existing presentation order;
    /// logical row siblings do not specify a global window stacking order.
    ProjectRoot {
        /// The root's native projection parent.
        parent: NodeId,
        /// The cell or promoted layout root to project.
        id: NodeId,
        /// Following siblings in core order, nearest first.
        following: Vec<NodeId>,
    },
    /// Remove a view from its superview, keeping it alive.
    Remove {
        /// View to detach.
        id: NodeId,
    },
    /// Retire a recycling cell only after native input can no longer target
    /// its current owner. A focused descendant refuses retirement: publish
    /// its native focus path before confirming `false`. Otherwise detach the
    /// cell immediately, then confirm `true` through the engine's input FIFO.
    /// This must be consumed by every platform, never silently ignored.
    RetireListCell {
        /// Cell to detach, keeping its current content alive until confirmed.
        id: NodeId,
        /// Correlates this request; cancelled and superseded replies are inert.
        request: u64,
        /// Native roots owned by this cell in the core's logical tree:
        /// the cell itself and its promoted layout roots. Check focus for
        /// the whole group before parking any root, then acknowledge once.
        roots: Vec<NodeId>,
    },
    /// Confirms native roots have been parked by a list-cell retirement.
    /// Native input is already excluded. A platform may collect the old
    /// native presentation resources, isolated from any new projection;
    /// otherwise it does nothing. Scene observers detach these roots.
    ListCellRetired {
        /// The retired cell and its promoted native roots.
        roots: Vec<NodeId>,
    },
    /// Destroy a view.
    Delete {
        /// View to destroy.
        id: NodeId,
    },
    /// Set the frame of a view, relative to its superview.
    Frame {
        /// View.
        id: NodeId,
        /// New frame.
        frame: Bounds<Points>,
    },
    /// The area the view's descendants cover outside its bounds, in its
    /// own coordinates (it contains the bounds), while overflow is visible;
    /// `None` when they stay inside. UIKit and Android only look for the
    /// target of a touch inside a view's bounds: platforms look in the
    /// descendants of views with an area too, so children placed outside
    /// their parent (a dropdown under its field) can be touched. Sent only
    /// when it changes; from layout frames (transforms are not included).
    Overflow {
        /// View.
        id: NodeId,
        /// The area, or `None`.
        extent: Option<Bounds<Points>>,
    },
    /// Set the visual style of a view.
    ViewStyle {
        /// View.
        id: NodeId,
        /// New style.
        style: Box<ViewStyle>,
    },
    /// Set the content of a text view.
    Text {
        /// Text view.
        id: NodeId,
        /// Content (for accessibility and debugging); shared, never copied.
        text: Arc<AttributedText>,
        /// The final layout, ready to draw.
        layout: TextLayout,
        /// Where `layout` goes inside the view (inside padding and border).
        content: Bounds<Points>,
    },
    /// Set which events the view must report.
    Events {
        /// View.
        id: NodeId,
        /// Event set.
        events: EventMask,
    },
    /// Set the source of an image view.
    Image {
        /// Image view.
        id: NodeId,
        /// Source; `None` clears the image.
        source: Option<ImageSource>,
        /// Fit mode.
        resize_mode: ResizeMode,
        /// How it is shown: placeholder, blur, fade.
        options: ImageOptions,
    },
    /// Configure a scroll view.
    ScrollConfig {
        /// Scroll view.
        id: NodeId,
        /// Scrolls horizontally.
        horizontal: bool,
        /// Shows the scroll indicator.
        scrollbar_visible: bool,
        /// Native animation value fed with the main-axis offset.
        scroll_value: Option<crate::animation::NodeId>,
        /// Native animation value fed with how far it is pulled past its
        /// top (vertical views).
        pull_value: Option<crate::animation::NodeId>,
        /// When dragging dismisses the keyboard.
        keyboard_dismiss: KeyboardDismissMode,
        /// A horizontal list laid out right to left: the platform mirrors
        /// the scroll view and each of its cells (so the list's offsets
        /// stay left to right).
        mirrored: bool,
    },
    /// Set the scrollable content size.
    ScrollContent {
        /// Scroll view.
        id: NodeId,
        /// Content size.
        size: Size<Points>,
    },
    /// Shift the scroll position, keeping visible content in place when
    /// items above the viewport change size.
    ScrollBy {
        /// Scroll view.
        id: NodeId,
        /// Horizontal shift.
        dx: Points,
        /// Vertical shift.
        dy: Points,
    },
    /// The surface lays out right to left (or no longer): native controls
    /// mirror.
    LayoutDirection {
        /// Right to left.
        rtl: bool,
    },
    /// The app's appearance changed ([`crate::Core::set_appearance`]):
    /// native controls (alerts, the status bar's default style, system
    /// views) show it instead of the system's.
    Appearance {
        /// What the app asks for.
        appearance: crate::platform::Appearance,
    },
    /// The surface's keyboard shortcuts (replaces the previous table;
    /// empty: none). The platform matches every key it gets against it on
    /// the spot ([`crate::keymap::Keymap::find`]), consumes the keys that
    /// fire a binding and reports them with
    /// [`crate::EventKind::KeyCommand`] on the root.
    Keymap(std::sync::Arc<crate::keymap::Keymap>),
    /// The sticky cells of a list (replaces the previous set): each one
    /// is translated along the main axis by `clamp(offset - start, 0,
    /// end - start)` on every scroll, natively.
    StickyCells {
        /// The list.
        id: NodeId,
        /// Cells and their travel.
        cells: Vec<StickyCell>,
    },
    /// Set how a scroll view or list scrolls.
    ScrollBehavior {
        /// Scroll view.
        id: NodeId,
        /// The behavior.
        behavior: Box<ScrollBehavior>,
    },
    /// Show or hide the pull-to-refresh spinner.
    Refreshing {
        /// Scroll view.
        id: NodeId,
        /// Spinner state.
        refreshing: bool,
    },
    /// What a canvas draws; its animated values come as
    /// [`crate::animation::AnimationProp::CanvasArg`] bindings.
    Canvas {
        /// The canvas.
        id: NodeId,
        /// The drawing.
        drawing: Arc<crate::canvas::Drawing>,
    },
    /// Bind visual properties to native animation nodes.
    AnimationBindings {
        /// View.
        id: NodeId,
        /// Property bindings (replaces the previous set).
        bindings: Vec<(AnimationProp, crate::animation::NodeId)>,
    },
    /// Drive native animation values from gestures on the view.
    Gestures {
        /// View.
        id: NodeId,
        /// The driven values.
        values: GestureValues,
    },
    /// Set touch, accessibility and test properties.
    ViewProps {
        /// View.
        id: NodeId,
        /// The properties (replace the previous ones).
        props: Box<ViewProps>,
    },
    /// Change the accessibility label of a view whose [`ViewProps`] were
    /// mounted before, and nothing else: a label following app state
    /// changes alone, so the rest is not sent again.
    AccessibilityLabel {
        /// View.
        id: NodeId,
        /// `accessibilityLabel` (`None`: none).
        label: Option<Arc<str>>,
    },
    /// Animate the frame changes, insertions and removals that follow in
    /// this batch.
    LayoutAnimation(LayoutAnimation),
    /// An animation graph change, in order with the other items.
    Animation(AnimationOp),
    /// Configure a text input.
    Input {
        /// Input view.
        id: NodeId,
        /// The configuration; boxed because it is large.
        config: Box<InputConfig>,
    },
    /// Set the text of an input (from JS).
    InputValue {
        /// Input view.
        id: NodeId,
        /// The text.
        text: String,
        /// The input's edit count this value is based on: the platform drops
        /// it if the user typed since (see [`crate::EventPayload::Text`]).
        count: u32,
    },
    /// Where the text of an input goes (inside padding and border).
    InputContent {
        /// Input view.
        id: NodeId,
        /// Content box relative to the view.
        content: Bounds<Points>,
    },
    /// Configure a screen (sent before the screen is inserted into its
    /// stack, and on every change).
    ScreenConfig {
        /// Screen.
        id: NodeId,
        /// The options.
        config: Box<ScreenConfig>,
    },
    /// Configure a native control (web view, video).
    NativeProps {
        /// The control.
        id: NodeId,
        /// All its properties.
        props: NativeProps,
    },
    /// Configure a modal (sent before it is presented, and on changes).
    ModalConfig {
        /// Modal root view.
        id: NodeId,
        /// The options.
        config: ModalConfig,
    },
    /// Create the registered component `name` in a [`ViewKind::Native`]
    /// container (right after its `Create`). Unknown names leave the
    /// container empty.
    Component {
        /// The container.
        id: NodeId,
        /// The name it was registered by (`com.example.map`).
        name: Arc<str>,
    },
    /// Properties of a registered native component that changed (all of
    /// them after [`MountItem::Component`]); `None` removes one.
    ComponentProps {
        /// The container.
        id: NodeId,
        /// Name and value.
        props: Vec<(Arc<str>, Option<crate::JsonValue>)>,
    },
    /// An imperative call (`focus()`, `scrollTo()`...).
    Command {
        /// View; [`crate::ROOT_ID`] for surface-wide calls.
        id: NodeId,
        /// The call.
        command: Command,
    },
}

/// All mount items produced by one commit.
#[derive(Debug, Default)]
pub struct MountBatch {
    /// Items, to be applied in order within one UI frame.
    pub items: Vec<MountItem>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::px;

    #[test]
    fn snap_targets() {
        let paging = ScrollBehavior {
            paging: true,
            ..Default::default()
        };
        // Pages of 300 in 1000 points of content (the last page is short):
        // one page per fling, wherever the fling would glide.
        assert_eq!(
            paging.snap_target(px(100.0), px(100.0), 0.0, px(300.0), px(1000.0)),
            Some(px(0.0))
        );
        assert_eq!(
            paging.snap_target(px(100.0), px(900.0), 1.0, px(300.0), px(1000.0)),
            Some(px(300.0))
        );
        assert_eq!(
            paging.snap_target(px(650.0), px(900.0), 1.0, px(300.0), px(1000.0)),
            Some(px(700.0))
        );
        assert_eq!(
            paging.snap_target(px(250.0), px(0.0), -1.0, px(300.0), px(1000.0)),
            Some(px(0.0))
        );
        let interval = ScrollBehavior {
            snap_interval: px(120.0),
            snap_alignment: SnapAlignment::Center,
            ..Default::default()
        };
        // Items of 120 centered in a 300 viewport: k * 120 - 90.
        assert_eq!(
            interval.snap_target(px(200.0), px(200.0), 0.0, px(300.0), px(2000.0)),
            Some(px(150.0))
        );
        // A fast fling glides past several items, rounded forward.
        assert_eq!(
            interval.snap_target(px(200.0), px(700.0), 2.0, px(300.0), px(2000.0)),
            Some(px(750.0))
        );
        let one = ScrollBehavior {
            one_step: true,
            ..interval.clone()
        };
        assert_eq!(
            one.snap_target(px(200.0), px(700.0), 2.0, px(300.0), px(2000.0)),
            Some(px(270.0))
        );
        let offsets = ScrollBehavior {
            snap_offsets: vec![px(0.0), px(500.0), px(900.0)],
            ..Default::default()
        };
        assert_eq!(
            offsets.snap_target(px(520.0), px(600.0), 2.0, px(300.0), px(2000.0)),
            Some(px(900.0))
        );
        assert_eq!(
            offsets.snap_target(px(520.0), px(520.0), 0.0, px(300.0), px(2000.0)),
            Some(px(500.0))
        );
        assert_eq!(
            ScrollBehavior::default().snap_target(px(10.0), px(10.0), 1.0, px(300.0), px(2000.0)),
            None
        );
    }
}
