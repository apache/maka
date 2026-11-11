//! An app's windows (TS `nsh/desktop`'s `Window`, `WindowRef` and
//! `currentWindow()`; Rust [`crate::element::desktop::window`]).
//!
//! Every window of an app renders from the app's one engine: the main
//! window is the root, every other window a dialog root (a `modal` node)
//! the platform shows in a window of its own. A window's kind
//! ([`WindowKind`]) is a set of defaults for its attributes
//! ([`WindowAttributes::for_kind`]); the core resolves them, keeps one
//! record of each window's attributes and sends the platform what changed
//! once per commit ([`DesktopCommand::SetAttributes`](super::DesktopCommand)).
//! What the user also changes (the bounds, the mode, being open) starts
//! from the options ([`WindowOptions`]), changes through requests
//! ([`WindowRequest`]) and comes back as events ([`WindowEvent`]).

use super::{DisplayId, TitleBarStyle, WindowLevel, WindowPlacement, WindowState};
use crate::{
    NodeId,
    element::{JsHost, JsIn, JsKind, JsObject, JsOwned, JsValue, PropEnum, PropError, TsTypes},
    geometry::{Edges, Percentage, Point, Points, Size},
};

/// What a window is for: a set of defaults its attributes start from
/// ([`WindowAttributes::for_kind`]); any attribute set overrides its kind's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, PropEnum)]
pub enum WindowKind {
    /// The main window and document windows: in the taskbar, activates
    /// when it opens, resizable, minimizable and maximizable.
    #[default]
    Normal,
    /// Settings, an about box, a confirmation: owned by the window that
    /// opened it and centered on it, neither minimizable nor maximizable,
    /// closed by Escape, not in the taskbar.
    Dialog,
    /// An inspector, a palette, a tool window: floats over its parent, not
    /// in the taskbar.
    Panel,
    /// A launcher, a tray popover, a command palette: no frame, floats on
    /// every workspace, closed by Escape and when it loses the focus, not
    /// in the taskbar.
    Popup,
    /// A HUD, captions, annotations: transparent, lets the pointer through,
    /// never takes the focus, above everything on every workspace. Needs
    /// the `windows` capability's `overlay`.
    Overlay,
}

/// A window's mode (TS `WindowMode`). Minimized is apart from it: a
/// maximized window that is minimized comes back maximized.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, Default, PropEnum, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "camelCase")]
pub enum WindowMode {
    /// A window of its own size.
    #[default]
    Normal,
    /// Maximized (zoomed on macOS).
    Maximized,
    /// In full screen.
    FullScreen,
}

/// How the user asked to close a window (`closePress`'s `reason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, PropEnum)]
pub enum CloseReason {
    /// The window's close button (the system's or a view marked
    /// `windowControl: "close"`).
    #[default]
    CloseButton,
    /// The platform's close key (Command-W, Alt-F4).
    Shortcut,
    /// A menu's close item (the window menu, the Dock's or the taskbar's).
    Menu,
    /// The taskbar's or the window switcher's close action.
    Taskbar,
    /// The system: logging out, shutting down.
    System,
}

/// Why a window of the app's own closed (`<Window>`'s `onOpenChange`'s
/// `reason`): one of the platform's ([`WindowEvent::Closed`]), or the
/// app's `close()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, PropEnum)]
pub enum WindowCloseCause {
    /// The user closed it ([`CloseReason`]) and `closeOnPress` let it close.
    #[default]
    ClosePress,
    /// Escape, with `closeOnEscape`.
    Escape,
    /// It lost the focus, with `closeOnBlur`.
    Blur,
    /// Its parent closed.
    ParentClose,
    /// The app closed it (`WindowRef.close()`): `<Window>` reports it too,
    /// so the app's `open` state follows. Never from the platform.
    Close,
}

/// On which workspaces (macOS Spaces, virtual desktops) a window shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, PropEnum)]
pub enum Workspaces {
    /// The one it opened on.
    #[default]
    Current,
    /// Every one.
    All,
}

/// Whether a window takes the pointer (CSS's `pointer-events` names).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, PropEnum)]
pub enum WindowPointerEvents {
    /// It takes the pointer.
    #[default]
    Auto,
    /// Presses and the pointer go through it to what is below. Needs the
    /// `windows` capability's `overlay`.
    None,
}

/// The system material behind a window's content, named for what it is
/// for; each platform maps it to its own (macOS's visual effect materials,
/// Windows 11's Mica, Mica Alt and Acrylic).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, PropEnum)]
pub enum Backdrop {
    /// No material: the window's own background.
    #[default]
    None,
    /// A window's background material.
    Window,
    /// A sidebar's.
    Sidebar,
    /// A popover's.
    Popover,
    /// A heads-up display's.
    Hud,
}

/// The state of a window's progress on the taskbar or the Dock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, PropEnum)]
pub enum ProgressState {
    /// Running.
    #[default]
    Normal,
    /// Running, without a known share done.
    Indeterminate,
    /// Paused.
    Paused,
    /// Failed.
    Error,
}

/// A window's progress, shown on its taskbar button or the Dock's icon.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Default, JsObject)]
pub struct WindowProgress {
    /// The share done, from 0 to 1.
    pub value: Option<Percentage>,
    /// Its state.
    #[prop(default)]
    pub state: ProgressState,
}

/// The title bar a window has (`titleBar`).
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Default, JsObject)]
pub struct TitleBarOptions {
    /// `Default`: the system's title bar; `Hidden`: the app draws its own,
    /// filling the window up to its top edge.
    #[prop(default)]
    pub style: TitleBarStyle,
    /// The app's bar's height in points, the system's window controls
    /// centered in it; the platform's own without it.
    pub height: Option<Points>,
    /// Where the system's window controls go in a hidden title bar, from the
    /// window's top left corner (macOS's traffic lights).
    pub controls_offset: Option<Point<Points>>,
}

/// How a window follows its content's laid-out size (`sizeToContent`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum SizeToContent {
    /// It keeps the size it is given.
    #[default]
    Off,
    /// Its width and height follow the content's.
    Both,
    /// Its width follows the content's.
    Width,
    /// Its height follows the content's.
    Height,
}

/// TS: `boolean | "width" | "height"`.
impl JsValue for SizeToContent {
    fn ts_type(_types: &mut TsTypes) -> String {
        "boolean | \"width\" | \"height\"".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if let Some(on) = value.as_bool() {
            return Ok(if on {
                SizeToContent::Both
            } else {
                SizeToContent::Off
            });
        }
        match value.as_string().as_deref() {
            Some("width") => Ok(SizeToContent::Width),
            Some("height") => Ok(SizeToContent::Height),
            _ => Err(value.expected("a boolean, \"width\" or \"height\"")),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            SizeToContent::Off => false.to_js(host),
            SizeToContent::Both => true.to_js(host),
            SizeToContent::Width => "width".to_owned().to_js(host),
            SizeToContent::Height => "height".to_owned().to_js(host),
        }
    }
}

/// Where a window opens (`defaultPosition`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WindowPosition {
    /// Its top left corner at this point, in screen coordinates.
    At(Point<Points>),
    /// Centered on its display.
    Center,
    /// Centered on its parent.
    ParentCenter,
}

/// TS: `Point | "center" | "parentCenter"`.
impl JsValue for WindowPosition {
    fn ts_type(_types: &mut TsTypes) -> String {
        "Point | \"center\" | \"parentCenter\"".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        match value.as_string().as_deref() {
            Some("center") => Ok(WindowPosition::Center),
            Some("parentCenter") => Ok(WindowPosition::ParentCenter),
            Some(_) => Err(value.expected("a point, \"center\" or \"parentCenter\"")),
            None => Point::<Points>::from_js(value).map(WindowPosition::At),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            WindowPosition::At(point) => point.to_js(host),
            WindowPosition::Center => "center".to_owned().to_js(host),
            WindowPosition::ParentCenter => "parentCenter".to_owned().to_js(host),
        }
    }
}

/// A view of a title bar the app draws that acts as one of the system's
/// window buttons (`desktop={{ windowControl }}`): the platform hit-tests it
/// as that button (Windows 11's snap layouts show over a maximize button)
/// and carries out its press; assistive technologies see the button.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PropEnum)]
pub enum WindowControl {
    /// Minimizes the window.
    Minimize,
    /// Maximizes the window, or restores it.
    Maximize,
    /// Closes the window, as its close button (`closeOnPress` applies).
    Close,
}

/// An edge or a corner of a frameless window that a view resizes it by
/// (`desktop={{ windowResize }}`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PropEnum)]
pub enum ResizeEdge {
    /// The top edge.
    Top,
    /// The bottom edge.
    Bottom,
    /// The left edge.
    Left,
    /// The right edge.
    Right,
    /// The top left corner.
    TopLeft,
    /// The top right corner.
    TopRight,
    /// The bottom left corner.
    BottomLeft,
    /// The bottom right corner.
    BottomRight,
}

/// Declares [`WindowAttributes`] with its fields' JS names, and its
/// merging, diffing and conversions. A field is an `Option`: set or not
/// (a partial, a diff); a nullable attribute is an `Option<Option<_>>`,
/// `Some(None)` clearing it (`null` in JS).
macro_rules! attributes {
    (
        $(
            $(#[doc = $doc:literal])*
            $field:ident: $ty:ty = $js:literal, $nullable:tt;
        )*
    ) => {
        /// What only the app changes of a window (TS `WindowAttributes`):
        /// `<Window>`'s reactive props, `WindowRef.set()`'s argument, and
        /// the diff the core sends the platform. Every field is optional:
        /// one left out is not changed. A window's kind gives every
        /// attribute a default ([`WindowAttributes::for_kind`]).
        #[non_exhaustive]
        #[derive(Debug, Clone, PartialEq, Default)]
        pub struct WindowAttributes {
            $(
                $(#[doc = $doc])*
                pub $field: Option<$ty>,
            )*
        }

        impl WindowAttributes {
            /// The JS names of the attributes, in declaration order.
            pub const NAMES: &'static [&'static str] = &[$($js),*];

            /// Sets the fields `other` sets.
            pub fn merge(&mut self, other: &WindowAttributes) {
                $(
                    if let Some(v) = &other.$field {
                        self.$field = Some(v.clone());
                    }
                )*
            }

            /// The fields of `next` that differ from `self` (what was sent):
            /// `None` when nothing does.
            pub fn diff(&self, next: &WindowAttributes) -> Option<WindowAttributes> {
                let mut out = WindowAttributes::default();
                let mut any = false;
                $(
                    if next.$field.is_some() && next.$field != self.$field {
                        out.$field = next.$field.clone();
                        any = true;
                    }
                )*
                any.then_some(out)
            }

            /// No field is set.
            pub fn is_empty(&self) -> bool {
                true $(&& self.$field.is_none())*
            }

            /// Declares TS `WindowAttributes` in `types`, each attribute
            /// with its doc.
            pub(crate) fn declare(types: &mut TsTypes) -> String {
                types.declare("WindowAttributes", |types| {
                    let mut out = String::from(
                        "/** What only the app changes of a window: `<Window>`'s props and\n \
                         * `WindowRef.set()`'s argument. Its kind gives every attribute a\n \
                         * default. */\nexport interface WindowAttributes {\n",
                    );
                    $(
                        out.push_str("  /**");
                        let docs: &[&str] = &[$($doc),*];
                        for (i, line) in docs.iter().enumerate() {
                            if i > 0 {
                                out.push_str("\n   *");
                            }
                            out.push_str(line);
                        }
                        out.push_str(" */\n");
                        out.push_str(&format!(
                            "  {}: {};\n",
                            $js,
                            <$ty as JsValue>::ts_type(types)
                        ));
                    )*
                    out.push('}');
                    out
                })
            }

            /// The JS names of the fields set.
            pub fn names(&self) -> Vec<&'static str> {
                let mut out = Vec::new();
                $(
                    if self.$field.is_some() {
                        out.push($js);
                    }
                )*
                out
            }
        }

        /// TS: `WindowAttributes` (declared by `nsh/desktop`), a partial
        /// one: left-out keys are unchanged, `null` clears a nullable one.
        impl JsValue for WindowAttributes {
            fn ts_type(_types: &mut TsTypes) -> String {
                "Partial<WindowAttributes>".into()
            }

            fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
                if value.kind() != JsKind::Object {
                    return Err(value.expected("an object of window attributes"));
                }
                let mut out = WindowAttributes::default();
                $(
                    out.$field = attributes!(@read $nullable value, $js, $ty)?;
                )*
                Ok(out)
            }

            fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
                let owned = JsOwned::new(host, host.new_object()?);
                let object = owned.get().raw();
                $(
                    if let Some(v) = &self.$field {
                        host.set_field(object, $js, v.to_js(host)?.into_raw())?;
                    }
                )*
                Ok(owned)
            }
        }
    };
    (@read plain $value:ident, $js:literal, $ty:ty) => {{
        let v = $value.field($js)?;
        let v = v.get();
        if v.kind() == JsKind::Undefined {
            Ok(None)
        } else {
            <$ty>::from_js(v)
                .map(Some)
                .map_err(|e| PropError(format!("`{}`: {e}", $js)))
        }
    }};
    (@read nullable $value:ident, $js:literal, $ty:ty) => {{
        let v = $value.field($js)?;
        let v = v.get();
        if v.kind() == JsKind::Undefined {
            Ok(None)
        } else {
            <$ty>::from_js(v)
                .map(Some)
                .map_err(|e| PropError(format!("`{}`: {e}", $js)))
        }
    }};
}

attributes! {
    /// Shown in the title bar, the taskbar, the window switcher and to
    /// assistive technologies.
    title: String = "title", plain;
    /// The title bar: the system's, or hidden for one the app draws.
    title_bar: TitleBarOptions = "titleBar", plain;
    /// The system's frame (title bar and border), or none.
    frame: super::WindowFrameStyle = "frame", plain;
    /// The least size the user may give it (content size, points).
    min_size: Option<Size<Points>> = "minSize", nullable;
    /// The largest size the user may give it (content size, points).
    max_size: Option<Size<Points>> = "maxSize", nullable;
    /// The window follows its content's laid-out size.
    size_to_content: SizeToContent = "sizeToContent", plain;
    /// The user may resize it.
    resizable: bool = "resizable", plain;
    /// The user may move it.
    movable: bool = "movable", plain;
    /// The user may minimize it.
    minimizable: bool = "minimizable", plain;
    /// The user may maximize it.
    maximizable: bool = "maximizable", plain;
    /// The user may close it.
    closable: bool = "closable", plain;
    /// It takes the keyboard focus.
    focusable: bool = "focusable", plain;
    /// It activates (and takes the focus) when it opens or shows.
    activate: bool = "activate", plain;
    /// A press of its close button (or the close key) closes it at once;
    /// `false`: the app hears `closePress` and closes it when it decides.
    close_on_press: bool = "closeOnPress", plain;
    /// Escape closes it.
    close_on_escape: bool = "closeOnEscape", plain;
    /// Losing the focus closes it.
    close_on_blur: bool = "closeOnBlur", plain;
    /// How high it floats.
    level: WindowLevel = "level", plain;
    /// It shows in the taskbar.
    taskbar: bool = "taskbar", plain;
    /// The workspaces it shows on.
    workspaces: Workspaces = "workspaces", plain;
    /// Whether it takes the pointer.
    pointer_events: WindowPointerEvents = "pointerEvents", plain;
    /// Its background is transparent.
    transparent: bool = "transparent", plain;
    /// The system material behind its content.
    backdrop: Backdrop = "backdrop", plain;
    /// The system's shadow around it.
    shadow: bool = "shadow", plain;
    /// Progress on its taskbar button or the Dock's icon.
    progress: Option<WindowProgress> = "progress", nullable;
}

// `window().attributes(WindowAttributes { .. })`: a static value.
crate::static_reactive!(WindowAttributes: WindowAttributes);

impl WindowAttributes {
    /// Every attribute's default for a window of `kind`: what a window
    /// opened with no attributes of its own has.
    pub fn for_kind(kind: WindowKind) -> WindowAttributes {
        let normal = WindowAttributes {
            title: Some(String::new()),
            title_bar: Some(TitleBarOptions::default()),
            frame: Some(super::WindowFrameStyle::Default),
            min_size: Some(None),
            max_size: Some(None),
            size_to_content: Some(SizeToContent::Off),
            resizable: Some(true),
            movable: Some(true),
            minimizable: Some(true),
            maximizable: Some(true),
            closable: Some(true),
            focusable: Some(true),
            activate: Some(true),
            close_on_press: Some(true),
            close_on_escape: Some(false),
            close_on_blur: Some(false),
            level: Some(WindowLevel::Normal),
            taskbar: Some(true),
            workspaces: Some(Workspaces::Current),
            pointer_events: Some(WindowPointerEvents::Auto),
            transparent: Some(false),
            backdrop: Some(Backdrop::None),
            shadow: Some(true),
            progress: Some(None),
        };
        match kind {
            WindowKind::Normal => normal,
            WindowKind::Dialog => WindowAttributes {
                minimizable: Some(false),
                maximizable: Some(false),
                close_on_escape: Some(true),
                taskbar: Some(false),
                ..normal
            },
            WindowKind::Panel => WindowAttributes {
                minimizable: Some(false),
                maximizable: Some(false),
                level: Some(WindowLevel::Floating),
                taskbar: Some(false),
                activate: Some(false),
                ..normal
            },
            WindowKind::Popup => WindowAttributes {
                frame: Some(super::WindowFrameStyle::None),
                resizable: Some(false),
                minimizable: Some(false),
                maximizable: Some(false),
                close_on_escape: Some(true),
                close_on_blur: Some(true),
                level: Some(WindowLevel::Floating),
                taskbar: Some(false),
                workspaces: Some(Workspaces::All),
                ..normal
            },
            WindowKind::Overlay => WindowAttributes {
                frame: Some(super::WindowFrameStyle::None),
                resizable: Some(false),
                movable: Some(false),
                minimizable: Some(false),
                maximizable: Some(false),
                closable: Some(false),
                focusable: Some(false),
                activate: Some(false),
                level: Some(WindowLevel::AboveDock),
                taskbar: Some(false),
                workspaces: Some(Workspaces::All),
                pointer_events: Some(WindowPointerEvents::None),
                transparent: Some(true),
                shadow: Some(false),
                ..normal
            },
        }
    }

    /// The attributes of a window of `kind` given `own`: the kind's
    /// defaults with `own`'s fields over them.
    pub fn resolve(kind: WindowKind, own: &WindowAttributes) -> WindowAttributes {
        let mut out = WindowAttributes::for_kind(kind);
        out.merge(own);
        out
    }

    /// Whether these make the window an overlay's: click-through
    /// (`pointerEvents: "none"`), which the `windows` capability's
    /// `overlay` grants.
    pub fn passes_pointer(&self) -> bool {
        self.pointer_events == Some(WindowPointerEvents::None)
    }

    /// Keeps the values in their ranges: a size not finite and positive and
    /// a progress out of 0 to 1 are left out (with `false`), the title bar's height capped as
    /// [`super::title_bar_height`] does.
    pub fn sanitize(&mut self) -> bool {
        let mut fine = true;
        let size_ok = |s: &Size<Points>| {
            s.width.0.is_finite() && s.height.0.is_finite() && s.width.0 > 0.0 && s.height.0 > 0.0
        };
        for size in [&mut self.min_size, &mut self.max_size] {
            if let Some(Some(s)) = size
                && !size_ok(s)
            {
                *size = None;
                fine = false;
            }
        }
        if let Some(Some(p)) = &mut self.progress
            && let Some(v) = p.value
        {
            if !v.0.is_finite() {
                p.value = None;
                fine = false;
            } else {
                p.value = Some(Percentage(v.0.clamp(0.0, 1.0)));
            }
        }
        if let Some(t) = &mut self.title_bar {
            t.height = super::title_bar_height(t.height);
        }
        fine
    }
}

/// A window to open (TS `WindowOptions`): its identity, kind and
/// relations, the starting values of what the user also changes, and its
/// attributes ([`WindowAttributes`]).
#[non_exhaustive]
#[derive(Debug, Clone, PartialEq, Default)]
pub struct WindowOptions {
    /// The app's id for it: one window per id (`"main"` is the main
    /// window's), and the key its bounds are kept under
    /// ([`Self::restore_bounds`]).
    pub id: String,
    /// What it is for: its attributes' defaults.
    pub kind: WindowKind,
    /// The id of the window that owns it: it stays above it, and minimizes
    /// and closes with it. Dialogs and panels default to the window that
    /// opened them.
    pub parent: Option<String>,
    /// The parent takes no input while it is open (dialogs).
    pub modal: bool,
    /// Its content size when it opens, in points.
    pub default_size: Option<Size<Points>>,
    /// Where it opens; dialogs default to their parent's center, other
    /// windows to where the system places them.
    pub default_position: Option<WindowPosition>,
    /// The display it opens on.
    pub display: Option<DisplayId>,
    /// The mode it opens in.
    pub default_mode: Option<WindowMode>,
    /// Opens where the user left it: the core keeps its placement under its
    /// id in the app's data, and fits it on the displays there are when it
    /// opens again.
    pub restore_bounds: bool,
    /// Its attributes (over its kind's defaults).
    pub attributes: WindowAttributes,
}

impl WindowOptions {
    /// Options of a window with `id`.
    pub fn new(id: impl Into<String>) -> WindowOptions {
        WindowOptions {
            id: id.into(),
            ..WindowOptions::default()
        }
    }
}

/// The main window's launch-time options: nsh.json `"window"`, which the
/// command line writes into the app's `app.json` (and the dev server's
/// app info) and the runners read before any JS runs, so the first frame
/// shows the window as the app wants it. The same keys as `WindowOptions`
/// without `id`, `kind`, `parent` and `modal`: every attribute,
/// `defaultSize`, `defaultPosition`, `display`, `defaultMode` and
/// `restoreBounds`; and `defaultVisible`, which only the main window takes
/// (the app opens its other windows when it wants them). At run time the
/// app changes it with `currentWindow().set()`; the engine also sends its
/// attributes to the main window with the first frame
/// ([`crate::Core::set_main_window`]), so a window made before the app was
/// known (a development host's) follows them too.
///
/// Only standalone builds read it (their `app.json`). Signed packages
/// (`.nshpkg`) carry none: they run in host apps, which own the main
/// window.
#[non_exhaustive]
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MainWindowOptions {
    /// Its content size when it opens.
    pub default_size: Option<Size<Points>>,
    /// Where it opens.
    pub default_position: Option<WindowPosition>,
    /// The display it opens on (the system's choice when it is not there).
    pub display: Option<DisplayId>,
    /// The mode it opens in.
    pub default_mode: Option<WindowMode>,
    /// Whether it shows when the app starts (`None`: it does). With `false`
    /// the window is made and the app runs in it, unseen and unfocused,
    /// until the app shows it (`show()`, `focus()`), a link of one of its
    /// URL schemes opens it, or the user opens it again on macOS (its Dock
    /// icon, the Finder): a tray app starts with only its tray icon. Read
    /// at launch only.
    pub default_visible: Option<bool>,
    /// Opens where the user left it (the runner keeps its placement).
    pub restore_bounds: bool,
    /// The attributes the app sets (the platform's main window keeps its
    /// own for the rest: the app's name as its title, ...).
    pub attributes: WindowAttributes,
}

impl MainWindowOptions {
    /// Where to open the main window with `restoreBounds`: the placement
    /// the app's last run kept in `storage` (the app's own, as the engine
    /// is given it), fitted on `displays`, the ones there are now. `None`
    /// without `restoreBounds`, or with nothing kept: the window opens by
    /// `defaultSize`, `defaultPosition`, `display` and `defaultMode`. For
    /// the runners, before they make the window; the engine keeps the
    /// placement as the window changes ([`crate::Core::set_main_window`]).
    pub fn kept_placement(
        &self,
        storage: &dyn crate::storage::StorageBackend,
        displays: &[super::Display],
    ) -> Option<WindowPlacement> {
        if !self.restore_bounds {
            return None;
        }
        let entries = storage
            .load()
            .map_err(|e| log::warn!("nsh: the main window's placement could not be read: {e}"))
            .ok()?;
        let json = entries.get(&placement_key("main"))?;
        let placement = serde_json::from_str::<WindowPlacement>(json).ok()?;
        Some(placement.fit_on_displays(displays))
    }

    /// Whether the main window shows when the app starts: unless
    /// `defaultVisible` is `false`. For the runners, as they launch the app.
    #[doc(hidden)]
    pub fn visible_at_launch(&self) -> bool {
        self.default_visible != Some(false)
    }

    /// The keys `"window"` takes besides the attributes.
    const KEYS: &'static [&'static str] = &[
        "defaultSize",
        "defaultPosition",
        "display",
        "defaultMode",
        "defaultVisible",
        "restoreBounds",
    ];

    /// Reads nsh.json's (or `app.json`'s) `"window"`: an unknown key or a
    /// wrong value is an error, as in the rest of nsh.json.
    pub fn from_json(json: &crate::JsonValue) -> Result<MainWindowOptions, String> {
        let object = json
            .as_object()
            .ok_or_else(|| "\"window\" is an object".to_owned())?;
        for key in object.keys() {
            if !WindowAttributes::NAMES.contains(&key.as_str())
                && !Self::KEYS.contains(&key.as_str())
            {
                return Err(format!("\"window\": unknown key {key:?}"));
            }
        }
        let read =
            |key: &str| -> Option<&crate::JsonValue> { object.get(key).filter(|v| !v.is_null()) };
        fn typed<T: JsValue>(key: &str, v: Option<&crate::JsonValue>) -> Result<Option<T>, String> {
            v.map(|v| {
                crate::element::from_json::<T>(v).map_err(|e| format!("\"window.{key}\": {e}"))
            })
            .transpose()
        }
        let mut own = crate::element::from_json::<WindowAttributes>(json)
            .map_err(|e| format!("\"window\": {e}"))?;
        own.sanitize();
        let options = MainWindowOptions {
            default_size: typed("defaultSize", read("defaultSize"))?,
            default_position: typed("defaultPosition", read("defaultPosition"))?,
            display: typed("display", read("display"))?,
            default_mode: typed("defaultMode", read("defaultMode"))?,
            default_visible: typed("defaultVisible", read("defaultVisible"))?,
            restore_bounds: typed("restoreBounds", read("restoreBounds"))?.unwrap_or(false),
            attributes: own,
        };
        if let Some(size) = options.default_size
            && !(size.width.0.is_finite()
                && size.height.0.is_finite()
                && size.width.0 > 0.0
                && size.height.0 > 0.0)
        {
            return Err("\"window.defaultSize\": a positive width and height".into());
        }
        Ok(options)
    }
}

/// Opens and applies the app's windows of its own in place of the
/// platform's built-in one. Every desktop backend opens these windows
/// itself (`<Window>` and `Window.open` work wherever NSH runs on a desktop,
/// embedded or standalone); a host that wants them as its own windows (a
/// GPUI app's), or a test's fake, sets this instead. The core hands it every command addressed to a window of the
/// app's own (opening it, its attributes' diffs, the requests); the main
/// window's stay with the platform. It reports what happens to a window
/// back as the platform would: [`WindowEvent`]s on the window's root node
/// (`EngineControl::dispatch_event` with `EventKind::Window`).
pub trait WindowBackend: Send + Sync {
    /// Carries out `command` for the window whose root node is `window`.
    fn command(&self, window: crate::NodeId, command: &super::DesktopCommand);
}

/// The TypeScript declarations of `nsh/desktop`'s window types, generated
/// from the Rust types: the attributes, the options, the placement, the
/// displays and the names of their enumerations. `nsh-js` declares the
/// window handle and the component around them.
#[doc(hidden)]
pub fn declarations() -> String {
    use std::fmt::Write as _;
    let mut types = TsTypes::default();
    let mut out = String::new();
    // The enumerations declare themselves (with their own docs) as their
    // types are asked for; only a type that has no declaration of its own
    // gets an alias here.
    WindowKind::ts_type(&mut types);
    WindowMode::ts_type(&mut types);
    CloseReason::ts_type(&mut types);
    WindowCloseCause::ts_type(&mut types);
    WindowControl::ts_type(&mut types);
    ResizeEdge::ts_type(&mut types);
    let _ = write!(
        out,
        "/** A display, the same in the app's next launch (sixteen hexadecimal digits). */\n\
         export type DisplayId = {};\n\n",
        DisplayId::ts_type(&mut types)
    );
    WindowAttributes::declare(&mut types);
    WindowPlacement::ts_type(&mut types);
    super::Display::ts_type(&mut types);
    let options = format!(
        "/** A window to open (`<Window>`'s props, `Window.open`'s options): its\n \
         * identity, kind and relations, the starting values of what the user\n \
         * also changes, and its attributes. */\n\
         export interface WindowOptions extends Partial<WindowAttributes> {{\n  \
         /** The app's id for it: one window per id, the key its bounds are kept\n   \
         * under (`restoreBounds`). `\"main\"` is the main window's. */\n  \
         id: string;\n  \
         /** What it is for: its attributes' defaults (`\"normal\"`). */\n  \
         kind?: WindowKind;\n  \
         /** The window that owns it (a `WindowRef` or an id): it stays above\n   \
         * it and closes with it. */\n  \
         parent?: WindowRef | string;\n  \
         /** Its parent takes no input while it is open (dialogs). */\n  \
         modal?: boolean;\n  \
         /** Its content size when it opens, in points. */\n  \
         defaultSize?: {size};\n  \
         /** Where it opens: a point on the screen, the display's center or\n   \
         * its parent's. */\n  \
         defaultPosition?: {position};\n  \
         /** The display it opens on. */\n  \
         display?: DisplayId;\n  \
         /** The mode it opens in. */\n  \
         defaultMode?: WindowMode;\n  \
         /** Opens where the user left it: its placement is kept under its id\n   \
         * and fitted on the displays there are when it opens again. */\n  \
         restoreBounds?: boolean;\n}}\n",
        size = Size::<Points>::ts_type(&mut types),
        position = WindowPosition::ts_type(&mut types),
    );
    out.push_str(&options);
    for declaration in types.declarations() {
        let _ = write!(out, "\n{declaration}\n");
    }
    out
}

/// TS: `WindowOptions` (declared by `nsh/desktop`): `id`, `kind`,
/// `parent` (an id; `nsh-js` also takes a `WindowRef`), the creation-time
/// fields, and every attribute.
impl JsValue for WindowOptions {
    fn ts_type(_types: &mut TsTypes) -> String {
        "WindowOptions".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if value.kind() != JsKind::Object {
            return Err(value.expected("window options"));
        }
        fn get<T: JsValue>(object: JsIn<'_>, key: &str) -> Result<Option<T>, PropError> {
            let v = object.field(key)?;
            let v = v.get();
            if v.is_nullish() {
                return Ok(None);
            }
            T::from_js(v)
                .map(Some)
                .map_err(|e| PropError(format!("`{key}`: {e}")))
        }
        let mut options = WindowOptions {
            id: get::<String>(value, "id")?.ok_or_else(|| PropError("`id`: a string".into()))?,
            kind: get(value, "kind")?.unwrap_or_default(),
            modal: get(value, "modal")?.unwrap_or(false),
            default_size: get(value, "defaultSize")?,
            default_position: get(value, "defaultPosition")?,
            display: get(value, "display")?,
            default_mode: get(value, "defaultMode")?,
            restore_bounds: get(value, "restoreBounds")?.unwrap_or(false),
            attributes: WindowAttributes::from_js(value)?,
            ..WindowOptions::default()
        };
        // A `WindowRef` (an object with an `id`) or an id.
        let parent = value.field("parent")?;
        let parent = parent.get();
        options.parent = match parent.kind() {
            JsKind::Undefined | JsKind::Null => None,
            JsKind::String => parent.as_string(),
            JsKind::Object => get::<String>(parent, "id")?,
            _ => return Err(PropError("`parent`: a WindowRef or a window id".into())),
        };
        if let Some(size) = options.default_size
            && !(size.width.0.is_finite()
                && size.height.0.is_finite()
                && size.width.0 > 0.0
                && size.height.0 > 0.0)
        {
            return Err(PropError(
                "`defaultSize`: a positive width and height".into(),
            ));
        }
        Ok(options)
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let owned = self.attributes.to_js(host)?;
        let object = owned.get().raw();
        host.set_field(object, "id", self.id.to_js(host)?.into_raw())?;
        host.set_field(object, "kind", self.kind.to_js(host)?.into_raw())?;
        if let Some(parent) = &self.parent {
            host.set_field(object, "parent", parent.to_js(host)?.into_raw())?;
        }
        host.set_field(object, "modal", self.modal.to_js(host)?.into_raw())?;
        if let Some(v) = self.default_size {
            host.set_field(object, "defaultSize", v.to_js(host)?.into_raw())?;
        }
        if let Some(v) = self.default_position {
            host.set_field(object, "defaultPosition", v.to_js(host)?.into_raw())?;
        }
        if let Some(v) = self.display {
            host.set_field(object, "display", v.to_js(host)?.into_raw())?;
        }
        if let Some(v) = self.default_mode {
            host.set_field(object, "defaultMode", v.to_js(host)?.into_raw())?;
        }
        host.set_field(
            object,
            "restoreBounds",
            self.restore_bounds.to_js(host)?.into_raw(),
        )?;
        Ok(owned)
    }
}

/// What the platform gets to open a window
/// ([`DesktopCommand::OpenWindow`](super::DesktopCommand::OpenWindow)): the
/// options with their attributes resolved (every field set: the kind's
/// defaults with the app's over them), the parent's root node and the
/// placement kept from an earlier launch.
#[non_exhaustive]
#[derive(Debug, Clone, PartialEq, Default)]
pub struct OpenWindow {
    /// The options, [`WindowOptions::attributes`] resolved.
    pub options: WindowOptions,
    /// The root node of the parent window ([`crate::ROOT_ID`] for the main
    /// window), if it has one.
    pub parent: Option<NodeId>,
    /// The placement kept for its id ([`WindowOptions::restore_bounds`]),
    /// fitted on the displays there are now: it wins over the default size,
    /// position and mode.
    pub placement: Option<WindowPlacement>,
}

/// What the app asks of a window
/// ([`DesktopCommand::Request`](super::DesktopCommand::Request)). Requests
/// are not results: the platform may decline or adjust one (a window
/// manager that does not let windows place themselves), and the window's
/// state ([`WindowState`]) says what happened.
#[derive(Debug, Clone, PartialEq)]
pub enum WindowRequest {
    /// Shows it, restoring it when minimized.
    Show,
    /// Hides it.
    Hide,
    /// Shows it, brings it to the front of its level and focuses it (the
    /// app activates).
    Focus,
    /// Closes it, whatever `closeOnPress` says (the main window: as the
    /// user closing it, the app ends with its last window).
    Close,
    /// Minimizes it.
    Minimize,
    /// Brings it back from being minimized, in the mode it had.
    Restore,
    /// Puts it in this mode (doing it again changes nothing).
    SetMode(WindowMode),
    /// Moves and sizes it (screen coordinates, points; a field left out
    /// keeps its value).
    SetBounds(super::WindowFrame),
    /// Sizes its content area (what its root view fills) to these, a side
    /// left out keeping its size; its top left corner stays. What the core
    /// sends for `sizeToContent`, having measured the content.
    SetContentSize {
        /// The content's width.
        width: Option<Points>,
        /// The content's height.
        height: Option<Points>,
    },
    /// Puts it in a mode with its normal bounds: restored to the bounds,
    /// then maximized or in full screen when the mode says so; the core has
    /// fitted the bounds on the displays there are.
    SetPlacement(WindowPlacement),
    /// Centers it on a display (its own without one).
    Center {
        /// The display.
        display: Option<DisplayId>,
    },
    /// Asks for the user's attention: the Dock's icon bounces, the taskbar
    /// button flashes.
    RequestAttention {
        /// Until the user activates the app (else once).
        critical: bool,
    },
}

/// What a platform reports about a window of the app's own, on its root
/// node ([`crate::EventKind::Window`]). The main window reports its state
/// in the environment ([`crate::platform::Environment::window_state`]).
#[derive(Debug, Clone, PartialEq)]
pub enum WindowEvent {
    /// Its state changed; a move or a resize is reported once it settles.
    State(Box<WindowState>),
    /// The area of its title bar while the app hides it
    /// ([`TitleBarStyle::Hidden`]), as the environment's
    /// [`crate::platform::Environment::title_bar`] is the main window's:
    /// `top` the bar's height, `left` and `right` the widths its window
    /// controls take; all 0 while the system shows its title bar. Reported
    /// before the window's first state and whenever it changes (a change of
    /// style, of mode, of display).
    TitleBar(Edges<Points>),
    /// The user asked to close it: reported whether or not `closeOnPress`
    /// let the platform close it (then [`WindowEvent::Closed`] follows).
    ClosePress {
        /// How they asked.
        reason: CloseReason,
    },
    /// The platform closed it by itself (a policy the app set: its root
    /// stays until the app removes it, hidden).
    Closed {
        /// Which policy.
        cause: WindowCloseCause,
    },
}

/// The record the core keeps of one window's attributes: what it last sent
/// the platform, and what was set since.
#[derive(Debug, Clone, Default)]
pub(crate) struct WindowRecord {
    /// What the platform has.
    pub(crate) sent: WindowAttributes,
    /// Set since the last commit (merged over `sent`).
    pub(crate) pending: WindowAttributes,
    /// The content size last sent for `sizeToContent`.
    pub(crate) fitted: Option<Size<Points>>,
    /// The size it opened at, its content's until the platform reports
    /// it (`Core::set_root_size`).
    pub(crate) size: Option<Size<Points>>,
}

impl WindowRecord {
    /// A window the platform opened with `attributes`, at `size`.
    pub(crate) fn opened(attributes: WindowAttributes, size: Option<Size<Points>>) -> WindowRecord {
        WindowRecord {
            sent: attributes,
            pending: WindowAttributes::default(),
            fitted: None,
            size,
        }
    }

    /// Which of its sides follow its content (`sizeToContent`): (width,
    /// height).
    pub(crate) fn fits(&self) -> (bool, bool) {
        match self.pending.size_to_content.or(self.sent.size_to_content) {
            None | Some(SizeToContent::Off) => (false, false),
            Some(SizeToContent::Both) => (true, true),
            Some(SizeToContent::Width) => (true, false),
            Some(SizeToContent::Height) => (false, true),
        }
    }

    /// What to send this commit: the pending fields that differ from what
    /// was sent, now counted as sent.
    pub(crate) fn take_diff(&mut self) -> Option<WindowAttributes> {
        let pending = std::mem::take(&mut self.pending);
        let diff = self.sent.diff(&pending)?;
        self.sent.merge(&diff);
        Some(diff)
    }
}

/// The key the core keeps a window's placement under in the app's storage
/// ([`WindowOptions::restore_bounds`]).
pub(crate) fn placement_key(id: &str) -> String {
    format!("nsh.window:{id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{px, size};

    #[test]
    fn kinds_give_every_attribute_a_default() {
        for kind in [
            WindowKind::Normal,
            WindowKind::Dialog,
            WindowKind::Panel,
            WindowKind::Popup,
            WindowKind::Overlay,
        ] {
            let a = WindowAttributes::for_kind(kind);
            assert_eq!(
                a.names().len(),
                WindowAttributes::NAMES.len(),
                "{kind:?} leaves an attribute out"
            );
        }
        let dialog = WindowAttributes::for_kind(WindowKind::Dialog);
        assert_eq!(dialog.close_on_escape, Some(true));
        assert_eq!(dialog.taskbar, Some(false));
        assert_eq!(dialog.maximizable, Some(false));
        let popup = WindowAttributes::for_kind(WindowKind::Popup);
        assert_eq!(popup.close_on_blur, Some(true));
        assert_eq!(popup.frame, Some(super::super::WindowFrameStyle::None));
        let overlay = WindowAttributes::for_kind(WindowKind::Overlay);
        assert!(overlay.passes_pointer());
        assert_eq!(overlay.focusable, Some(false));
        assert!(!WindowAttributes::for_kind(WindowKind::Normal).passes_pointer());
    }

    #[test]
    fn the_apps_attributes_override_the_kinds() {
        let own = WindowAttributes {
            taskbar: Some(true),
            title: Some("Settings".into()),
            ..WindowAttributes::default()
        };
        let a = WindowAttributes::resolve(WindowKind::Dialog, &own);
        assert_eq!(a.taskbar, Some(true));
        assert_eq!(a.title.as_deref(), Some("Settings"));
        assert_eq!(a.close_on_escape, Some(true));
    }

    #[test]
    fn main_windows_open_where_they_were_kept() {
        use crate::{
            desktop::{Display, DisplayId, WindowMode},
            geometry::{Bounds, point, px, size},
            storage::{StorageBackend, StorageChange},
        };
        struct Kept(String);
        impl StorageBackend for Kept {
            fn load(&self) -> Result<std::collections::BTreeMap<String, String>, String> {
                Ok([("nsh.window:main".to_owned(), self.0.clone())].into())
            }
            fn write(&self, _: StorageChange) {}
        }
        let display = Display::new(
            DisplayId(1),
            Bounds::new(point(px(0.0), px(0.0)), size(px(1440.0), px(900.0))),
            Bounds::new(point(px(0.0), px(25.0)), size(px(1440.0), px(875.0))),
            true,
        );
        let kept = Kept(
            r#"{"mode":"maximized","bounds":{"origin":{"x":-3000,"y":0},"size":{"width":800,"height":600}}}"#
                .into(),
        );
        let mut options = MainWindowOptions::default();
        assert_eq!(
            options.kept_placement(&kept, std::slice::from_ref(&display)),
            None
        );
        options.restore_bounds = true;
        // On a display that is gone: centered on the one there is.
        assert_eq!(
            options.kept_placement(&kept, &[display]),
            Some(WindowPlacement::new(
                WindowMode::Maximized,
                Bounds::new(point(px(320.0), px(162.5)), size(px(800.0), px(600.0)))
            ))
        );
    }

    #[test]
    fn the_main_window_may_start_hidden() {
        let read = |json: &str| {
            MainWindowOptions::from_json(&serde_json::from_str::<crate::JsonValue>(json).unwrap())
        };
        // Shown unless the app says otherwise.
        assert!(MainWindowOptions::default().visible_at_launch());
        let shown = read(r#"{"title":"Mail"}"#).unwrap();
        assert_eq!(shown.default_visible, None);
        assert!(shown.visible_at_launch());
        assert!(
            read(r#"{"defaultVisible":true}"#)
                .unwrap()
                .visible_at_launch()
        );
        let hidden = read(r#"{"defaultVisible":false,"title":"Mail"}"#).unwrap();
        assert_eq!(hidden.default_visible, Some(false));
        assert!(!hidden.visible_at_launch());
        assert_eq!(hidden.attributes.title.as_deref(), Some("Mail"));
        // A value of another form is an error, as every key's.
        assert!(read(r#"{"defaultVisible":"no"}"#).is_err());
    }

    #[test]
    fn diffs_send_only_what_changed() {
        let mut record = WindowRecord::opened(
            WindowAttributes::resolve(WindowKind::Normal, &Default::default()),
            None,
        );
        // Setting what it has sends nothing.
        record.pending.title = Some(String::new());
        assert_eq!(record.take_diff(), None);
        // Two sets in one commit: one diff with the last values.
        record.pending.merge(&WindowAttributes {
            title: Some("A".into()),
            ..Default::default()
        });
        record.pending.merge(&WindowAttributes {
            title: Some("B".into()),
            level: Some(WindowLevel::Floating),
            ..Default::default()
        });
        let diff = record.take_diff().unwrap();
        assert_eq!(diff.names(), ["title", "level"]);
        assert_eq!(diff.title.as_deref(), Some("B"));
        assert_eq!(record.take_diff(), None);
        // Clearing a nullable attribute is a change.
        record.pending.min_size = Some(Some(size(px(10.0), px(10.0))));
        assert!(record.take_diff().is_some());
        record.pending.min_size = Some(None);
        assert_eq!(record.take_diff().unwrap().min_size, Some(None));
    }

    #[test]
    fn the_main_windows_record_sends_every_first_set() {
        // The main window's record starts empty: the runner applied its
        // launch attributes, which the core does not know.
        let mut record = WindowRecord::default();
        record.pending.title = Some(String::new());
        assert_eq!(record.take_diff().unwrap().title.as_deref(), Some(""));
    }

    #[test]
    fn values_out_of_range_are_left_out() {
        let mut a = WindowAttributes {
            min_size: Some(Some(size(px(-1.0), px(10.0)))),
            progress: Some(Some(WindowProgress {
                value: Some(Percentage(2.0)),
                state: ProgressState::Normal,
            })),
            ..Default::default()
        };
        assert!(!a.sanitize());
        assert_eq!(a.min_size, None);
        assert_eq!(a.progress.unwrap().unwrap().value, Some(Percentage(1.0)));
    }
}
