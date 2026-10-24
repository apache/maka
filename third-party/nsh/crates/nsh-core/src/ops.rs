use std::sync::Arc;

use crate::{
    animation::AnimationOp,
    geometry::{Bounds, DevicePixels, Percentage, Point, Points, Size},
    js::host::HostProps,
    overlay::{Align, HintWatchToken, OverlayAnchor, Placement, TooltipContent},
    props::{AccessibilityProp, EdgeInsets, LayoutAnimation, PointerEvents},
    style::{Color, EllipsizeMode, Style, StylePatch},
    ui::PropEnum,
};

/// Identifier of a node, assigned by the JS renderer.
///
/// Ids are small, dense and increasing, so the core indexes them directly.
pub type NodeId = u32;

/// Id of the surface root view. It exists before any JS runs.
pub const ROOT_ID: NodeId = 1;

/// Element tag of a host node.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tag {
    /// A container view (`<view>`).
    View,
    /// A text block, or a span when nested in another text (`<text>`).
    Text,
    /// An image (`<image>`).
    Image,
    /// A scrolling container (`<scroll>`).
    Scroll,
    /// A virtualized list (`<list>`, created by the runtime's `List`).
    List,
    /// A recycled list cell (created by the runtime's `List`).
    Cell,
    /// A text field, or a text area when `multiline` (`<input>`).
    Input,
    /// A native navigation stack (`<stack>`); its children are screens.
    Stack,
    /// One screen of a stack (`<screen>`), laid out at the stack's size.
    Screen,
    /// A modal presented over everything (`<modal>`), laid out at the size
    /// the platform presents it at.
    Modal,
    /// A view placed in a screen's native header (`<headeritem slot>`),
    /// sized to its content.
    HeaderItem,
    /// A bar over the keyboard of the inputs naming its `nativeID`
    /// (`<inputaccessory>`, iOS), as wide as the window and as tall as its
    /// content.
    InputAccessory,
    /// A 2D drawing (`<canvas>`, filled by [`Op::Draw`]).
    Canvas,
    /// A web page (`<webview>`).
    WebView,
    /// A video player (`<video>`).
    Video,
    /// A component the embedding app registered (`<native component>`,
    /// created by `nsh/native`'s `nativeComponent`).
    Native,
    /// A view shown on top of the root view it is in (`<overlay>`, TS:
    /// `Overlay` of `nsh`), outside its parent's layout and clipping, laid
    /// out on its own and placed by the core ([`crate::overlay`]).
    Overlay,
}

impl Tag {
    /// Parses a host element's name (what `nsh:rt`'s `element` takes).
    #[inline]
    pub fn from_name(name: &str) -> Option<Tag> {
        Some(match name {
            "view" => Tag::View,
            "text" => Tag::Text,
            "image" => Tag::Image,
            "scroll" => Tag::Scroll,
            "list" => Tag::List,
            "cell" => Tag::Cell,
            "input" => Tag::Input,
            "stack" => Tag::Stack,
            "screen" => Tag::Screen,
            "modal" => Tag::Modal,
            "headeritem" => Tag::HeaderItem,
            "inputaccessory" => Tag::InputAccessory,
            "canvas" => Tag::Canvas,
            "webview" => Tag::WebView,
            "video" => Tag::Video,
            "native" => Tag::Native,
            "overlay" => Tag::Overlay,
            _ => return None,
        })
    }
}

macro_rules! events {
    ($($variant:ident = $prop:literal $(as $js:literal)?: $doc:literal,)*) => {
        /// An event a node can listen to.
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        #[repr(u8)]
        pub enum EventKind {
            $(#[doc = $doc] $variant,)*
        }

        impl EventKind {
            /// Every kind, in discriminant order (`ALL[k as usize] == k`).
            pub const ALL: &'static [EventKind] = &[$(EventKind::$variant,)*];

            /// Parses an event's protocol name such as `onPress` (what
            /// platforms send and log; [`EventKind::prop_name`]).
            #[inline]
            pub fn from_prop(name: &str) -> Option<EventKind> {
                match name {
                    $($prop => Some(EventKind::$variant),)*
                    _ => None,
                }
            }

            /// The protocol name of this event (platforms send and log it;
            /// apps name handlers with [`EventKind::handler_name`]).
            #[inline]
            pub const fn prop_name(self) -> &'static str {
                match self {
                    $(EventKind::$variant => $prop,)*
                }
            }

            /// The handler prop apps set for this event (`onChange` for
            /// [`EventKind::ChangeText`]); empty for the events only the
            /// runtime listens to (a dialog's dismissal, the root's back
            /// button), which no prop name sets.
            #[inline]
            pub const fn handler_name(self) -> &'static str {
                match self {
                    $(EventKind::$variant => events!(@js $prop $($js)?),)*
                }
            }

            /// Parses a handler prop name such as `onPress`
            /// ([`EventKind::handler_name`]).
            #[inline]
            pub fn from_handler(name: &str) -> Option<EventKind> {
                if name.is_empty() {
                    return None;
                }
                #[allow(unreachable_patterns)]
                match name {
                    $(events!(@js $prop $($js)?) => Some(EventKind::$variant),)*
                    _ => None,
                }
            }
        }
    };
    (@js $prop:literal) => { $prop };
    (@js $prop:literal $js:literal) => { $js };
}

// The order is part of the platform protocols (`encode.rs`, `Native.java`):
// append new kinds at the end.
events! {
    Press = "onPress": "A tap / click (payload: [`EventPayload::Press`] where the backend knows the pointer, else none).",
    LongPress = "onLongPress": "A press held for about half a second (payload as `Press`).",
    PanStart = "onPanStart": "A drag started (payload: [`EventPayload::Pan`]).",
    PanEnd = "onPanEnd": "A drag ended (payload: [`EventPayload::Pan`] with velocity).",
    Refresh = "onRefresh": "Pull-to-refresh was triggered on a scroll or list.",
    LoadMore = "onLoadMore": "A list was scrolled close to its end.",
    ScrollEnd = "onScrollEnd": "Scrolling came to rest (payload: [`EventPayload::Scroll`]).",
    Load = "onLoad": "An image loaded (payload: [`EventPayload::Image`]).",
    Error = "onError": "An image failed to load (payload: [`EventPayload::Error`]).",
    ChangeText = "onChangeText" as "onChange": "The user edited an input (payload: [`EventPayload::Text`]).",
    SubmitEditing = "onSubmitEditing" as "onSubmit": "The return key was pressed in an input (payload: [`EventPayload::Text`]).",
    Focus = "onFocus": "An input, scroll view or list became focused.",
    Blur = "onBlur": "An input, scroll view or list lost focus.",
    PressDown = "onPressIn" as "onPressDown": "A press went down on a pressable view (a finger, a pen or a mouse button; payload as `Press`).",
    PressUp = "onPressOut" as "onPressUp": "The press ended: released, moved away or cancelled (payload as `Press`).",
    Layout = "onLayout": "The frame changed (payload: [`EventPayload::Layout`], relative to the parent).",
    PinchStart = "onPinchStart": "A pinch started (payload: `scale`, `velocity`).",
    PinchEnd = "onPinchEnd": "A pinch ended (payload: `scale`, `velocity`).",
    RotationStart = "onRotationStart": "A two-finger rotation started (payload: `rotation`, `velocity`).",
    RotationEnd = "onRotationEnd": "A two-finger rotation ended (payload: `rotation`, `velocity`).",
    AccessibilityAction = "onAccessibilityAction": "An assistive technology performed an action (payload: `actionName`).",
    Dismiss = "onDismiss" as "": "A screen was popped or a modal dismissed by the user or the system (`NavPage`'s `onDismiss`, `Dialog`'s `onClose`).",
    RequestClose = "onRequestClose" as "": "The user tried to close a modal natively (Escape or the back button, a sheet swiped down; payload: `reason`: `\"cancel\"` or `\"swipe\"`, `\"cancel\"` when none); `Dialog`'s `onCancel` and `onOpenChange` (a press on its backdrop part is handled in JS).",
    Show = "onShow" as "": "A modal finished appearing (`Dialog`'s `onOpen`).",
    Insets = "onInsets": "The insets of a screen or modal changed (payload: `top`, `right`, `bottom`, `left`).",
    LoadStart = "onLoadStart": "A web view, video or image started loading.",
    Message = "onMessage": "A web page posted a message (payload: `data`).",
    NavigationStateChange = "onNavigationStateChange": "A web view navigated (payload: `url`, `title`, `loading`, `canGoBack`, `canGoForward`).",
    Progress = "onProgress": "Video playback progressed (payload: `currentTime`, `duration`).",
    End = "onEnd": "A video played to its end.",
    Buffer = "onBuffer": "A video started or stopped buffering (payload: `isBuffering`).",
    ViewableItemsChange = "onViewableItemsChange": "The range of visible list items changed (payload: `first`, `last`).",
    BackPress = "onBackPress" as "": "The Android back button was pressed and nothing native handled it (root only).",
    Scroll = "onScroll": "A scroll view moved, at most once per frame (payload: `x`, `y`, `contentWidth`, `contentHeight`, `width`, `height`).",
    ScrollDragStart = "onScrollDragStart": "The user started dragging a scroll view (payload: [`EventPayload::Scroll`]).",
    ScrollDragEnd = "onScrollDragEnd": "The user let go of a scroll view (payload: [`EventPayload::Scroll`]).",
    MomentumStart = "onMomentumStart": "A scroll view started gliding after a fling (payload: [`EventPayload::Scroll`]).",
    MomentumEnd = "onMomentumEnd": "A scroll view stopped gliding (payload: [`EventPayload::Scroll`]).",
    Dialog = "onDialog": "An alert or action sheet closed (root only; payload: `id`, `index`, -1 when dismissed).",
    Touch = "onTouch": "Touches on the view or inside it, for the JS touch and responder handlers (payload: [`EventPayload::Touch`]).",
    SelectionChange = "onSelectionChange": "The selection (or caret) of an input moved (payload: `start`, `end` in UTF-16 units).",
    KeyPress = "onKeyPress": "A key was pressed in an input (payload: `key`: the character, `Backspace` or `Enter`).",
    LoadEnd = "onLoadEnd": "An image finished loading, or failed.",
    ImageInfo = "onImageInfo": "An `Image.getSize` / `Image.prefetch` request finished (root only; payload: `id`, `width` and `height` in pixels, or `error`).",
    TextLayout = "onTextLayout": "A text block was laid out (payload: [`EventPayload::TextLayout`]).",
    ContentSizeChange = "onContentSizeChange": "The size of an input's text changed (payload: `width`, `height`; raised by the core).",
    BackRequest = "onBackRequest" as "onBackPress": "The user pressed back on a screen (the header's back button, Android back, the desktops' back keys and mouse button, the browser's back), whether or not `popOnBack` let it pop.",
    NativeEvent = "onNativeEvent": "A registered native component emitted an event (payload: [`EventPayload::Native`]).",
    Clipboard = "onClipboard": "A clipboard read finished (root only; payload: `id`, `has`: whether it holds what was asked; for text `text`, unless only `has` was asked; for an image `uri` (a `data:` URI), `width` and `height`, unless only `has` was asked; for files `files`, their `file:` URLs one per line).",
    KeyCommand = "onKeyCommand": "A key matched a binding of `nsh/keymap` (root only; payload: the binding's id, [`crate::keymap::KeyBinding::id`]).",
    Menu = "onMenu": "A menu item was chosen: the application menu's or a context menu's (root only; desktops; payload: `id`), or a context menu closed (`closed`: true, after its item).",
    HoverIn = "onHoverIn": "The mouse came over the view or a view inside it (never on touches).",
    HoverOut = "onHoverOut": "The mouse left the view and the views inside it, or the window.",
    FileDragEnter = "onFileDragEnter": "A local file drag entered an eligible desktop drop destination.",
    FileDragLeave = "onFileDragLeave": "A local file drag left its desktop drop destination.",
    FileDrop = "onFileDrop": "Local files were dropped (payload: [`EventPayload::FileDrop`]).",
    HoverMove = "onHoverMove": "The mouse moved over a hovered view, with no button down (payload: [`EventPayload::Hover`]; at most one per frame).",
    ContextMenu = "onContextMenu": "The secondary button was pressed over the view (payload: [`EventPayload::ContextMenu`]): the nearest listener around the view under the pointer hears it, unless a text input or selectable text is nearer.",
    CompositionChange = "onCompositionChange": "An input method's composition in an input started, changed or ended (payload: `composing`, `text`: the text being composed, empty once it ends; after the `onChangeText` of the committed text).",
    PressOutside = "onPressOutside": "A press went down outside an overlay, its anchor and the overlays inside it (payload: `pageX`, `pageY`; raised by the core).",
    Cancel = "onCancel": "Escape or the Android back button was pressed while the overlay was the top one listening to it (raised by the core).",
    Position = "onPosition": "The core placed an overlay (payload: `placement`, the side it went on, `x`, `y`, `width`, `height` in the root view, `availableWidth`, `availableHeight`: the room on that side).",
    MouseMove = "onMouseMove": "The mouse moved inside the view, including with a button down (desktops and web; local coordinates `x`, `y`; at most once per frame).",
    ScrollIntent = "onScrollIntent": "The user requested scrolling, before the offset changes, including at a boundary (payload: `intent`: `\"start\"`, `\"end\"` or `\"scroll\"`; once when a drag starts, before `onScrollDragStart`; programmatic scrolling does not emit it).",
    Host = "onHost": "The embedding host answered a [`Command::HostCall`] or sent an event to `nsh/host`'s listeners (root only; payload: [`EventPayload::Json`], `{ type: \"reply\", id, ok, value?, error? }` or `{ type: \"event\", event, payload }`).",
    Pick = "onPick": "A picker closed (root only; payload: [`EventPayload::Picked`], no files when cancelled).",
    LoadMoreAtStart = "onLoadMoreAtStart": "A list was scrolled close to its start after the user or a scroll command moved it (raised by the core).",
    OpenUrl = "onOpenUrl": "A [`Command::OpenUrl`] request finished (root only; payload: `id`, `opened`: whether the platform opened the URL).",
    CaretMove = "onCaretMove": "An input's caret moved: with its selection, or as its text scrolled or wrapped again (payload: `bounds`, the caret in the input; the core adds `pageBounds`, in the root view).",
    Paste = "onPaste": "The user pasted into an input (payload: [`EventPayload::Paste`]: the text, files with their bytes such as a screenshot, local files' URLs), before the `onChangeText` of the text it inserts.",

}

/// What an input holds, for the system's autofill and suggestions
/// (`autoComplete`, `textContentType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AutoFill {
    /// The platform decides.
    #[default]
    Default,
    /// No autofill.
    Off,
    /// Account name.
    Username,
    /// Existing password.
    Password,
    /// A password being chosen.
    NewPassword,
    /// A code from a text message or e-mail.
    OneTimeCode,
    /// E-mail address.
    Email,
    /// Phone number.
    Tel,
    /// Full name.
    Name,
    /// First name.
    GivenName,
    /// Last name.
    FamilyName,
    /// Middle name.
    MiddleName,
    /// Nickname.
    Nickname,
    /// Company.
    Organization,
    /// Street address, all lines.
    StreetAddress,
    /// First address line.
    AddressLine1,
    /// Second address line.
    AddressLine2,
    /// City.
    City,
    /// State or region.
    Region,
    /// Postal code.
    PostalCode,
    /// Country.
    Country,
    /// Credit card number.
    CreditCardNumber,
    /// Credit card expiry date.
    CreditCardExpiration,
    /// Credit card security code.
    CreditCardSecurityCode,
    /// Name on the credit card.
    CreditCardName,
    /// Web address.
    Url,
    /// Birth date.
    Birthdate,
}

impl AutoFill {
    /// Parses React Native's `autoComplete` values and iOS's
    /// `textContentType` names.
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "off" | "none" => Self::Off,
            "username" | "username-new" => Self::Username,
            "password" | "current-password" => Self::Password,
            "new-password" | "newPassword" | "password-new" => Self::NewPassword,
            "one-time-code" | "oneTimeCode" | "sms-otp" => Self::OneTimeCode,
            "email" | "emailAddress" => Self::Email,
            "tel" | "telephoneNumber" | "tel-national" | "tel-device" | "tel-country-code" => {
                Self::Tel
            }
            "name" | "name-full" => Self::Name,
            "given-name" | "givenName" | "name-given" => Self::GivenName,
            "family-name" | "familyName" | "name-family" => Self::FamilyName,
            "additional-name" | "middleName" | "name-middle" => Self::MiddleName,
            "nickname" => Self::Nickname,
            "organization" | "organizationName" => Self::Organization,
            "street-address" | "fullStreetAddress" | "postal-address" => Self::StreetAddress,
            "address-line1" | "streetAddressLine1" => Self::AddressLine1,
            "address-line2" | "streetAddressLine2" => Self::AddressLine2,
            "address-level2" | "addressCity" | "postal-address-locality" => Self::City,
            "address-level1" | "addressState" | "postal-address-region" => Self::Region,
            "postal-code" | "postalCode" => Self::PostalCode,
            "country" | "countryName" | "postal-address-country" => Self::Country,
            "cc-number" | "creditCardNumber" => Self::CreditCardNumber,
            "cc-exp" | "creditCardExpiration" | "cc-exp-month" | "cc-exp-year" => {
                Self::CreditCardExpiration
            }
            "cc-csc" | "creditCardSecurityCode" => Self::CreditCardSecurityCode,
            "cc-name" | "creditCardName" => Self::CreditCardName,
            "url" | "URL" => Self::Url,
            "birthdate-full" | "birthdate" | "birthdate-day" | "birthdate-month"
            | "birthdate-year" => Self::Birthdate,
            _ => return None,
        })
    }
}

/// The phase of a [`TouchEvent`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TouchPhase {
    /// Fingers went down (the changed points).
    Start,
    /// Fingers moved.
    Move,
    /// Fingers lifted (the changed points).
    End,
    /// The system or a native gesture took the touches over.
    Cancel,
}

/// One finger of a [`TouchEvent`], in points.
#[derive(Debug, Clone, PartialEq)]
pub struct TouchPoint {
    /// Identifies the finger while it is down.
    pub id: u32,
    /// The view under the finger when it went down.
    pub target: NodeId,
    /// The views around `target` (it included) that listen to touches,
    /// innermost first.
    pub path: Vec<NodeId>,
    /// Position in the surface.
    pub page: Point<Points>,
    /// Position in `target`.
    pub location: Point<Points>,
    /// This finger is one the event is about (it went down, moved or
    /// lifted).
    pub changed: bool,
}

/// Where the mouse is over a hovered view ([`EventKind::HoverMove`]), in
/// points.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct HoverEvent {
    /// Position in the view, its transforms undone.
    pub position: Point<Points>,
    /// Position in the root view the view is in (the surface, or its
    /// modal), as touches' `page`.
    pub page_position: Point<Points>,
    /// The modifier keys held.
    pub modifiers: crate::keymap::Modifiers,
}

/// Where the pointer was at a press ([`EventKind::Press`],
/// [`EventKind::LongPress`], [`EventKind::PressDown`],
/// [`EventKind::PressUp`]), with the modifier keys and the click count, on
/// backends that know it, in points.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct PressEvent {
    /// Position in the pressed view, its transforms undone (for a pressed
    /// span of a text, in that text's view).
    pub position: Point<Points>,
    /// Position in the root view the view is in (the surface, or its
    /// modal), as touches' `page`.
    pub page_position: Point<Points>,
    /// The modifier keys held when the press began.
    pub modifiers: crate::keymap::Modifiers,
    /// Consecutive clicks at the same place: 1 for a click, 2 for a
    /// double click, ...
    pub clicks: u32,
}

/// Where a context menu was asked for ([`EventKind::ContextMenu`]), in
/// points.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ContextMenuEvent {
    /// Position in the view, its transforms undone.
    pub position: Point<Points>,
    /// Position in the root view the view is in (the surface, or its
    /// modal): where `Menu.popup` opens a menu.
    pub page_position: Point<Points>,
    /// The modifier keys held.
    pub modifiers: crate::keymap::Modifiers,
}

/// Touches for the JS responder system.
#[derive(Debug, Clone, PartialEq)]
pub struct TouchEvent {
    /// What happened.
    pub phase: TouchPhase,
    /// Milliseconds since an arbitrary origin.
    pub timestamp: f64,
    /// The fingers down during the event (with those that lifted).
    pub points: Vec<TouchPoint>,
    /// A view around the fingers whose `panActivation` the platform
    /// activated with this event: it becomes the responder.
    pub activated: Option<NodeId>,
}

/// What the user pasted into an input ([`EventKind::Paste`]): what the
/// clipboard held when the user pasted, which the platform read then (the
/// app never reads the clipboard for it).
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct PasteEvent {
    /// The plain text, empty when it held none.
    pub text: String,
    /// Files with their bytes: images (a screenshot, an image copied from a
    /// page or an app), in the platform's order.
    pub files: Vec<PastedFile>,
    /// Absolute `file:` URLs of local files copied in a file manager, in the
    /// platform's order (as [`EventPayload::FileDrop`]'s).
    pub uris: Vec<String>,
}

impl EventPayload {
    /// An `onPaste` payload of fields (`text`; a reported paste with no
    /// payload is an empty one) made a [`EventPayload::Paste`], as handlers
    /// read it (`files` and `uris` always there).
    pub fn into_paste(self) -> EventPayload {
        match self {
            EventPayload::Map(fields) => {
                let text = fields.into_iter().find_map(|(k, v)| match (k, v) {
                    ("text", PayloadValue::Str(text)) => Some(text),
                    _ => None,
                });
                EventPayload::Paste(Box::new(PasteEvent::new(text.unwrap_or_default())))
            }
            EventPayload::None => EventPayload::Paste(Box::default()),
            payload => payload,
        }
    }
}

impl PasteEvent {
    /// A paste of `text`, with no files.
    pub fn new(text: impl Into<String>) -> PasteEvent {
        PasteEvent {
            text: text.into(),
            ..PasteEvent::default()
        }
    }

    /// Whether it holds nothing.
    pub fn is_empty(&self) -> bool {
        self.text.is_empty() && self.files.is_empty() && self.uris.is_empty()
    }
}

/// A file pasted with its bytes ([`PasteEvent::files`]): JS gets a `File`.
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct PastedFile {
    /// Its name (`image.png` for an image without one).
    pub name: String,
    /// Its MIME type (`image/png`).
    pub mime: String,
    /// Its bytes.
    pub data: Vec<u8>,
}

impl PastedFile {
    /// A file named `name` of type `mime` holding `data`.
    pub fn new(name: impl Into<String>, mime: impl Into<String>, data: Vec<u8>) -> PastedFile {
        PastedFile {
            name: name.into(),
            mime: mime.into(),
            data,
        }
    }

    /// An image of encoded `data` (PNG, JPEG, GIF, WebP, HEIC, TIFF, BMP;
    /// PNG when unknown), named `image.<extension>`.
    pub fn image(data: Vec<u8>) -> PastedFile {
        let (mime, extension) = image_type(&data);
        PastedFile::new(format!("image.{extension}"), mime, data)
    }
}

/// The MIME type and file extension of encoded image `data`.
fn image_type(data: &[u8]) -> (&'static str, &'static str) {
    match data {
        [0xFF, 0xD8, 0xFF, ..] => ("image/jpeg", "jpg"),
        [b'G', b'I', b'F', b'8', ..] => ("image/gif", "gif"),
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => ("image/webp", "webp"),
        [
            _,
            _,
            _,
            _,
            b'f',
            b't',
            b'y',
            b'p',
            b'h',
            b'e',
            b'i',
            b'c' | b'x',
            ..,
        ] => ("image/heic", "heic"),
        [b'I', b'I', 42, 0, ..] | [b'M', b'M', 0, 42, ..] => ("image/tiff", "tiff"),
        [b'B', b'M', ..] => ("image/bmp", "bmp"),
        _ => ("image/png", "png"),
    }
}

// Every kind has a bit of [`EventMask`].
const _: () = assert!(EventKind::ALL.len() <= 128, "EventMask has 128 bits");

/// Events a view reports, retaining which subscriptions can call a listener.
/// Each subscription set has room for 128 kinds, stored as two words rather
/// than a `u128`: Objective-C ivars take no 16-byte alignment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EventMask {
    listeners: [u64; 2],
    observations: [u64; 2],
    hint_watch: Option<HintWatchToken>,
}

impl std::ops::BitOr for EventMask {
    type Output = EventMask;

    #[inline]
    fn bitor(self, other: EventMask) -> EventMask {
        let conflicted = (self.observations != [0; 2] && self.hint_watch.is_none())
            || (other.observations != [0; 2] && other.hint_watch.is_none());
        EventMask {
            listeners: [
                self.listeners[0] | other.listeners[0],
                self.listeners[1] | other.listeners[1],
            ],
            observations: [
                self.observations[0] | other.observations[0],
                self.observations[1] | other.observations[1],
            ],
            hint_watch: match (self.hint_watch, other.hint_watch) {
                _ if conflicted => None,
                (Some(left), Some(right)) if left != right => None,
                (left, right) => left.or(right),
            },
        }
    }
}

impl EventMask {
    /// Returns true if `event` is in the set.
    #[inline]
    pub const fn contains(self, event: EventKind) -> bool {
        let k = event as usize;
        (self.listeners[k / 64] | self.observations[k / 64]) & (1 << (k % 64)) != 0
    }

    /// Whether reporting `event` can invoke a listener, rather than only
    /// update native presentation such as a callback-free tooltip.
    #[inline]
    pub const fn contains_listener(self, event: EventKind) -> bool {
        let k = event as usize;
        self.listeners[k / 64] & (1 << (k % 64)) != 0
    }

    /// The native hint watch paired with these observations, if any.
    #[inline]
    pub const fn hint_watch(self) -> Option<HintWatchToken> {
        self.hint_watch
    }

    /// The raw bit set, indexed by `EventKind as u8`.
    #[inline]
    pub const fn bits(self) -> u128 {
        (self.listeners[0] | self.observations[0]) as u128
            | ((self.listeners[1] | self.observations[1]) as u128) << 64
    }

    /// Adds or removes `event`.
    #[inline]
    pub fn set(&mut self, event: EventKind, enabled: bool) {
        let k = event as usize;
        if enabled {
            self.listeners[k / 64] |= 1 << (k % 64);
        } else {
            self.listeners[k / 64] &= !(1 << (k % 64));
            self.observations[k / 64] &= !(1 << (k % 64));
            if self.observations == [0; 2] {
                self.hint_watch = None;
            }
        }
    }

    /// Reports `event` for native presentation without adding a listener.
    /// An existing listener of the same event retains its authority.
    #[inline]
    pub(crate) fn observe(&mut self, event: EventKind, watch: HintWatchToken) {
        if self.observations == [0; 2] {
            self.hint_watch = Some(watch);
        } else if self.hint_watch != Some(watch) {
            self.hint_watch = None;
        }
        let k = event as usize;
        self.observations[k / 64] |= 1 << (k % 64);
    }

    /// Returns true if no event is set.
    #[inline]
    pub const fn is_empty(self) -> bool {
        self.bits() == 0
    }
}

/// A value in an event payload.
#[derive(Debug, Clone, PartialEq)]
pub enum PayloadValue {
    /// A number.
    Number(f64),
    /// A boolean.
    Bool(bool),
    /// A string.
    Str(String),
    /// `null`.
    Null,
    /// A position (`{ x, y }`).
    Point(Point<Points>),
    /// An extent (`{ width, height }`).
    Size(Size<Points>),
    /// A position and an extent (`{ origin, size }`).
    Bounds(Bounds<Points>),
}

/// Data delivered with an event.
#[derive(Debug, Clone, PartialEq)]
pub enum EventPayload {
    /// No data.
    None,
    /// A single value handed to the handler as is (`onValueChange(value)`).
    Value(PayloadValue),
    /// An object with named fields.
    Map(Vec<(&'static str, PayloadValue)>),
    /// A frame relative to the parent (`onLayout`).
    Layout(Bounds<Points>),
    /// A drag: translation since the start and velocity (points / second).
    Pan {
        /// The translation.
        translation: Point<Points>,
        /// Horizontal velocity.
        velocity_x: f32,
        /// Vertical velocity.
        velocity_y: f32,
        /// The `pan.x` value now (`None` without one).
        value_x: Option<Points>,
        /// The `pan.y` value now.
        value_y: Option<Points>,
    },
    /// A system-cancelled drag, with the same last values as `Pan`.
    PanCancelled {
        /// The translation.
        translation: Point<Points>,
        /// Horizontal velocity.
        velocity_x: f32,
        /// Vertical velocity.
        velocity_y: f32,
        /// The `pan.x` value now (`None` without one).
        value_x: Option<Points>,
        /// The `pan.y` value now.
        value_y: Option<Points>,
    },
    /// A scroll position: the content offset.
    Scroll(Point<Points>),
    /// A loaded image's source size in pixels (before downsampling).
    Image(Size<DevicePixels>),
    /// An error message.
    Error {
        /// The message.
        message: String,
    },
    /// The text of an input after an edit.
    Text {
        /// The whole text.
        text: String,
        /// Number of edits the input has reported so far. A value set by JS
        /// based on an older edit is stale and must not overwrite newer
        /// typing.
        count: u32,
    },
    /// Touches (`onTouch`).
    Touch(Box<TouchEvent>),
    /// The mouse over a hovered view (`onHoverMove`).
    Hover(HoverEvent),
    /// A context menu asked for over a view (`onContextMenu`).
    ContextMenu(ContextMenuEvent),
    /// Where the pointer was at a press (`onPress`, `onLongPress`,
    /// `onPressDown`, `onPressUp`), with the modifier keys and the click
    /// count, on backends that know it.
    Press(PressEvent),
    /// Local file URLs dropped by the user, in the platform's order.
    FileDrop(Vec<String>),
    /// What the user pasted into an input.
    Paste(Box<PasteEvent>),
    /// The lines of a text block.
    TextLayout(Vec<crate::text::TextLine>),
    /// The files the user picked ([`EventKind::Pick`]), with their bytes.
    Picked {
        /// The request ([`Command::PickImages`]).
        id: u32,
        /// The files, in the order picked; none when cancelled.
        files: Vec<crate::picker::PickedFile>,
    },
    /// An event of a registered native component: its name and data (any
    /// JSON value), handed to JS as `{ name, data }`.
    Native {
        /// The event (`regionChange`).
        name: Arc<str>,
        /// Its data.
        data: crate::JsonValue,
    },
    /// A JSON value handed to JS as it is ([`EventKind::Host`]).
    Json(crate::JsonValue),
}

impl EventPayload {
    /// An input's `onCaretMove`: the caret's `bounds` in the input's
    /// coordinates (its border box, the input's own scrolling applied), as
    /// the platforms report it. The core adds `pageBounds`
    /// ([`crate::Core::locate_caret`]).
    pub fn caret(bounds: Bounds<Points>) -> EventPayload {
        EventPayload::Map(vec![("bounds", PayloadValue::Bounds(bounds))])
    }
}

impl TouchEvent {
    /// Folds a later move into this pending one: the later positions,
    /// changed if either moved them, and either's activated pan.
    pub fn merge_move(&mut self, later: TouchEvent) {
        let mut later = later;
        for p in &mut later.points {
            if let Some(old) = self.points.iter().find(|o| o.id == p.id) {
                p.changed |= old.changed;
            }
        }
        later.activated = later.activated.or(self.activated);
        *self = later;
    }
}

/// How an image fits its box.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum ResizeMode {
    /// Fill the box, cropping (default).
    #[default]
    Cover,
    /// Fit inside the box, letterboxing.
    Contain,
    /// Stretch to the box.
    Stretch,
    /// Center at natural size, cropped where larger than the box (CSS's
    /// `object-fit: none`).
    Center,
    /// Center at natural size, shrunk to fit the box where larger (CSS's
    /// `object-fit: scale-down`, React Native's `center`).
    #[prop(rename = "scale-down")]
    ScaleDown,
}

impl ResizeMode {
    /// Where content of `natural` size goes in a box of `size`: scaled as
    /// the mode scales it (`Center` keeps the natural size, as CSS's
    /// `none`; `ScaleDown` shrinks content larger than the box, as CSS's
    /// `scale-down`), then placed at `position`. The rectangle
    /// may reach outside the box (a covering image), which crops it.
    /// Content without a size fills the box.
    pub fn fit(
        self,
        natural: Size<Points>,
        size: Size<Points>,
        position: crate::style::ObjectPosition,
    ) -> Bounds<Points> {
        let (nw, nh) = (natural.width.0, natural.height.0);
        if nw <= 0.0 || nh <= 0.0 || self == ResizeMode::Stretch {
            return Bounds {
                origin: Point::default(),
                size,
            };
        }
        let contain = (size.width.0 / nw).min(size.height.0 / nh);
        let scale = match self {
            ResizeMode::Cover => (size.width.0 / nw).max(size.height.0 / nh),
            ResizeMode::Contain => contain,
            ResizeMode::Center => 1.0,
            ResizeMode::ScaleDown => contain.min(1.0),
            ResizeMode::Stretch => 1.0,
        };
        let content = Size {
            width: Points(nw * scale),
            height: Points(nh * scale),
        };
        Bounds {
            origin: position.place(size, content),
            size: content,
        }
    }
}

/// An image source.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ImageSource {
    /// `https://…`, `asset:/path` (bundled file), a file path, a `data:` URI
    /// or a `blob:` URL (`URL.createObjectURL`). A source with [`Self::data`]
    /// goes by a short key instead of a `data:` URI ([`crate::image`]).
    pub uri: Arc<str>,
    /// Natural size in points, when known up front (bundled assets): used
    /// as the intrinsic layout size.
    pub size: Option<Size<Points>>,
    /// The pixel densities a bundled asset ships in (`a.png`,
    /// `a@2x.png`, ...): the core mounts the one for the screen's pixel
    /// ratio. Empty for a single file.
    pub scales: ImageScales,
    /// The image's bytes when they are in memory (a `data:` URI's, the
    /// blob of a `blob:` URL): the platforms decode these instead of
    /// loading [`Self::uri`], which stays the cache key.
    pub data: Option<crate::image::ImageData>,
}

impl ImageSource {
    /// This source with its bytes in hand when its URI holds them: a
    /// `data:` URI decoded (once, when the source is set) and named by a
    /// short key. Other sources stay as they are. A `data:` URI that does
    /// not decode becomes an empty one (the platforms then report the
    /// error): left as it is, an app could write another image's key
    /// (`data:<type>;nsh-key=<digest>`, which has no comma) and ask the
    /// process-wide caches whether some surface shows those bytes.
    #[must_use]
    pub fn inline(self) -> ImageSource {
        if self.data.is_some() || !self.uri.starts_with("data:") {
            return self;
        }
        match crate::image::decode_data_uri(&self.uri) {
            Ok((mime, bytes)) => {
                let mime = mime.to_owned();
                self.with_bytes(&mime, bytes.into())
            }
            Err(_) => ImageSource {
                uri: "data:,".into(),
                ..self
            },
        }
    }

    /// This source showing `data`, of media type `mime` (a blob's bytes),
    /// named by a digest of the bytes: equal images share their loads and
    /// cache entries, whatever URL named them.
    #[must_use]
    pub fn with_bytes(self, mime: &str, data: crate::image::ImageData) -> ImageSource {
        ImageSource {
            uri: crate::image::data_key(mime, &data).into(),
            data: Some(data),
            ..self
        }
    }

    /// The URI to load at `pixel_ratio` device pixels per point: the
    /// variant [`ImageScales::pick`] chooses (`asset:/a.png` at 2 →
    /// `asset:/a@2x.png`), or [`Self::uri`] itself when there are no
    /// scales, the pick is the 1x file or the URI is not a plain
    /// `asset:/` path.
    pub(crate) fn uri_for(&self, pixel_ratio: f32) -> Arc<str> {
        match self.variant(pixel_ratio) {
            Some(scale) => variant_uri(&self.uri, scale).into(),
            None => self.uri.clone(),
        }
    }

    /// The scale of the variant loaded at `pixel_ratio`, when it is not
    /// [`Self::uri`] itself. A query or a fragment is no part of a file
    /// name the bundler wrote, so such a URI is loaded as it is.
    pub(crate) fn variant(&self, pixel_ratio: f32) -> Option<f32> {
        if self.scales.is_empty()
            || !self.uri.starts_with("asset:/")
            || self.uri.contains(['?', '#'])
        {
            return None;
        }
        self.scales.pick(pixel_ratio).filter(|s| *s != 1.0)
    }

    /// This source as the platform loads it at `pixel_ratio`: the chosen
    /// variant's URI, the same size in points and no scales.
    pub(crate) fn resolved(&self, pixel_ratio: f32) -> ImageSource {
        ImageSource {
            uri: self.uri_for(pixel_ratio),
            size: self.size,
            scales: ImageScales::NONE,
            data: self.data.clone(),
        }
    }
}

/// `asset:/dir/a.png` at 2 → `asset:/dir/a@2x.png` (`@1.5x` at 1.5).
fn variant_uri(uri: &str, scale: f32) -> String {
    let name = uri.rfind('/').map_or(0, |i| i + 1);
    let (stem, ext) = match uri[name..].rfind('.') {
        Some(dot) if dot > 0 => uri.split_at(name + dot),
        _ => (uri, ""),
    };
    format!("{stem}@{scale}x{ext}")
}

/// The pixel densities an image asset can ship in, as the file name
/// suffix says (`@1.5x` ... `@4x`; the file without a suffix is 1x). The
/// bundler looks for these siblings of an imported image.
pub const IMAGE_SCALES: [f32; 5] = [1.0, 1.5, 2.0, 3.0, 4.0];

/// How many entries of a JS `scales` list are read: more than an asset
/// lists (one per scale of [`IMAGE_SCALES`]), and few enough that a sparse
/// array of a huge length costs nothing.
pub(crate) const SCALES_READ: usize = 8;

/// A set of [`IMAGE_SCALES`]: the variants an image asset has. Collected
/// from scales (`[1.0, 2.0].into_iter().collect()`), it keeps those of
/// [`IMAGE_SCALES`] and leaves any other value (NaN, negative, `2.5`)
/// out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub struct ImageScales(u8);

impl ImageScales {
    /// No variants: the URI is the only file.
    pub const NONE: ImageScales = ImageScales(0);

    /// This set with `scale` added, when it is one of [`IMAGE_SCALES`].
    #[must_use]
    pub(crate) fn with(self, scale: f32) -> ImageScales {
        match IMAGE_SCALES.iter().position(|s| *s == scale) {
            Some(i) => ImageScales(self.0 | 1 << i),
            None => self,
        }
    }

    /// Whether the set has no scale.
    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// The scales in the set, smallest first.
    pub fn iter(self) -> impl Iterator<Item = f32> {
        IMAGE_SCALES
            .into_iter()
            .enumerate()
            .filter(move |(i, _)| self.0 & 1 << i != 0)
            .map(|(_, s)| s)
    }

    /// The scale to load at `pixel_ratio`, as React Native picks: the
    /// smallest that is at least the ratio, otherwise the largest. `None`
    /// for an empty set.
    pub(crate) fn pick(self, pixel_ratio: f32) -> Option<f32> {
        self.iter()
            .find(|s| *s >= pixel_ratio)
            .or_else(|| self.iter().last())
    }
}

impl FromIterator<f32> for ImageScales {
    fn from_iter<I: IntoIterator<Item = f32>>(values: I) -> ImageScales {
        values.into_iter().fold(Self::NONE, ImageScales::with)
    }
}

/// Keyboard layout of an input (`keyboardType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum KeyboardType {
    /// Full keyboard.
    #[default]
    Default,
    /// Digits only (`number-pad`): no sign, no decimal separator.
    #[prop(rename = "number-pad")]
    Number,
    /// Digits and a decimal separator (`decimal-pad`).
    #[prop(rename = "decimal-pad")]
    Decimal,
    /// Numbers (`numeric`, React Native's): iOS's decimal pad, Android's
    /// number keyboard with a sign and a decimal separator.
    Numeric,
    /// Digits, a sign and punctuation (`numbers-and-punctuation`): iOS's
    /// numbers and punctuation keyboard, Android's signed decimal number
    /// keyboard (the closest it has).
    #[prop(rename = "numbers-and-punctuation")]
    NumbersAndPunctuation,
    /// E-mail addresses (`email-address`).
    #[prop(rename = "email-address")]
    Email,
    /// Phone numbers (`phone-pad`).
    #[prop(rename = "phone-pad")]
    Phone,
    /// URLs (`url`).
    Url,
}

/// The keyboard's look (`keyboardAppearance`, iOS).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum KeyboardAppearance {
    /// The system's: follows the app's appearance (default).
    #[default]
    Default,
    /// Light.
    Light,
    /// Dark.
    Dark,
}

/// Label of the return key (`returnKeyType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum ReturnKeyType {
    /// Return / new line.
    #[default]
    Default,
    /// Done.
    Done,
    /// Go.
    Go,
    /// Next.
    Next,
    /// Search.
    Search,
    /// Send.
    Send,
}

/// What an input does with what the user pastes (`pasteBehavior`); it
/// reports it either way (`onPaste`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum PasteBehavior {
    /// Inserts the pasted text (default). Images and files are never
    /// inserted: a text input holds text.
    #[default]
    Insert,
    /// Inserts nothing: the app does what it wants with `onPaste`'s text,
    /// images and files.
    Report,
}

/// A bar button UIKit draws itself, with the system's look, symbol or
/// label (`ios={{ headerRightSystemItem }}`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum HeaderSystemItem {
    /// A plus (`UIBarButtonSystemItemAdd`).
    #[default]
    Add,
    /// The system's "Done" (`UIBarButtonSystemItemDone`).
    Done,
    /// A close mark (`UIBarButtonSystemItemClose`).
    Close,
    /// The system's "Edit" (`UIBarButtonSystemItemEdit`).
    Edit,
    /// A compose symbol (`UIBarButtonSystemItemCompose`).
    Compose,
    /// A magnifying glass (`UIBarButtonSystemItemSearch`).
    Search,
    /// The share symbol (`UIBarButtonSystemItemAction`).
    Share,
    /// A trash can (`UIBarButtonSystemItemTrash`).
    Trash,
    /// The system's "Save" (`UIBarButtonSystemItemSave`).
    Save,
    /// The system's "Cancel" (`UIBarButtonSystemItemCancel`).
    Cancel,
}

/// What return does in an input (`submitBehavior`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum SubmitBehavior {
    /// Reports `onSubmit` and keeps the focus.
    Submit,
    /// Reports `onSubmit` and unfocuses the input.
    #[default]
    BlurAndSubmit,
    /// Inserts a line break (multiline inputs; a single line submits).
    Newline,
}

/// Automatic capitalization (`autoCapitalize`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum AutoCapitalize {
    /// Never.
    None,
    /// First letter of each sentence (default).
    #[default]
    Sentences,
    /// First letter of each word.
    Words,
    /// Every letter.
    Characters,
}

/// When a scroll view dismisses the keyboard (`keyboardDismissMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum KeyboardDismissMode {
    /// Never (default).
    #[default]
    None,
    /// As soon as a drag starts.
    #[prop(rename = "on-drag")]
    OnDrag,
    /// Follows the finger while dragging down (iOS).
    Interactive,
}

/// Which point of a page a snapping scroll view aligns to its start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum SnapAlignment {
    /// The snap point at the viewport's start.
    #[default]
    Start,
    /// At its center.
    Center,
    /// At its end.
    End,
}

/// Whether a tap in a scroll view dismisses the keyboard
/// (`keyboardShouldPersistTaps`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum KeyboardTaps {
    /// The tap dismisses the keyboard and reaches nothing else (default).
    #[default]
    Never,
    /// Taps never dismiss the keyboard.
    Always,
    /// Taps that nothing handles dismiss the keyboard.
    Handled,
}

/// How an `<image>` is shown, besides its source.
#[derive(Debug, Clone, PartialEq, HostProps)]
pub enum ImageProp {
    /// `placeholder`: shown until `src` has loaded (best a local asset).
    #[prop(js = "placeholder", on = IMAGE, shared)]
    Placeholder(Option<ImageSource>),
    /// `blurRadius`: blurs the image by this radius in points (decoded once, off
    /// the main thread).
    #[prop(js = "blurRadius", on = IMAGE)]
    BlurRadius(Points),
    /// `fadeDuration`: how long a loaded image fades in, in milliseconds
    /// (default: the platform's, 0 on iOS and 300 on Android, like React
    /// Native).
    #[prop(js = "fadeDuration", min = 0, on = IMAGE)]
    FadeDuration(Option<f32>),
}

/// A behavior property of a scroll view or list.
#[derive(Debug, Clone, PartialEq, HostProps)]
pub enum ScrollProp {
    /// `pagingEnabled`: stops at multiples of the viewport.
    #[prop(js = "pagingEnabled", on = SCROLLING)]
    Paging(bool),
    /// `snapToInterval`: stops at multiples of this length (0: off).
    #[prop(js = "snapToInterval", on = SCROLLING)]
    SnapInterval(Points),
    /// `snapToOffsets`: stops at these offsets.
    #[prop(js = "snapToOffsets", on = SCROLLING)]
    SnapOffsets(Vec<Points>),
    /// `snapToAlignment`: which point of an item aligns with the viewport with
    /// `snapToInterval`.
    #[prop(js = "snapToAlignment", on = SCROLLING)]
    SnapAlignment(SnapAlignment),
    /// `decelerationRate`: how fast a fling slows down: `"normal"`, `"fast"`, or
    /// the velocity kept per millisecond (0.998 / 0.99; 0 is the platform's
    /// default).
    #[prop(js = "decelerationRate", with = crate::js::host_values::deceleration, reset = ScrollProp::Deceleration(0.0), ts = "\"normal\" | \"fast\" | number", on = SCROLLING)]
    Deceleration(f32),
    /// `bounces`: overscroll past the edges (default true).
    #[prop(js = "bounces", default = true, on = SCROLLING)]
    Bounces(bool),
    /// `contentInset`: room around the content.
    #[prop(js = "contentInset", on = SCROLLING)]
    ContentInset(EdgeInsets),
    /// `contentOffset`: where it starts.
    #[prop(js = "contentOffset", with = crate::js::host_values::content_offset, once, ts = "Partial<Point>", on = SCROLLING)]
    ContentOffset(Point<Points>),
    /// `keyboardShouldPersistTaps`: whether a tap dismisses the keyboard: `"never"`
    /// (default: the tap only dismisses it), `"always"` (never dismisses),
    /// `"handled"` (unless something handles the tap).
    #[prop(js = "keyboardShouldPersistTaps", with = crate::js::host_values::keyboard_taps, reset = ScrollProp::KeyboardTaps(KeyboardTaps::Never), ts = "\"never\" | \"always\" | \"handled\" | boolean", on = SCROLLING)]
    KeyboardTaps(KeyboardTaps),
    /// `scrollEventThrottle`: minimum milliseconds between `onScroll` events (at
    /// most one per frame anyway).
    #[prop(js = "scrollEventThrottle", on = SCROLLING)]
    EventThrottle(f32),
    /// `disableIntervalMomentum`: a fling moves one snap point at most.
    #[prop(js = "disableIntervalMomentum", on = SCROLLING)]
    DisableIntervalMomentum(bool),
    /// `minimumZoomScale`: the smallest zoom (default 1).
    #[prop(js = "minimumZoomScale", default = 1.0, on = SCROLL)]
    MinZoom(f32),
    /// `maximumZoomScale`: pinching zooms the content when it is above
    /// `minimumZoomScale` (default 1 both); zoomed in, it scrolls both ways.
    #[prop(js = "maximumZoomScale", default = 1.0, on = SCROLL)]
    MaxZoom(f32),
    /// `zoomScale`: zooms to this scale when it changes (the user's zoom is kept
    /// otherwise).
    #[prop(js = "zoomScale", default = 1.0, on = SCROLL)]
    Zoom(f32),
    /// `bouncesZoom`: pinching may go past the limits and springs back (default
    /// true).
    #[prop(js = "bouncesZoom", default = true, on = SCROLL)]
    BouncesZoom(bool),
    /// `zoomable`: the user can pinch to zoom (default true).
    #[prop(js = "zoomable", default = true, on = SCROLL)]
    Pinch(bool),
    /// `centerContent`: content smaller than the viewport (zoomed out) is centered.
    #[prop(js = "centerContent", on = SCROLL)]
    CenterContent(bool),
}

/// What a list cell holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellSlot {
    /// A recycled item cell in this slot.
    Item(u32),
    /// `header`.
    Header,
    /// `footer`.
    Footer,
    /// `empty` (shown while there are no items).
    Empty,
}

/// A list's `contentStyle` (or `contentClass`): padding around the content and gaps
/// between rows and columns.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ListContentStyle {
    /// Padding around the content.
    pub padding: EdgeInsets,
    /// Gap between rows (vertical lists) / columns (horizontal lists).
    pub row_gap: Points,
    /// Gap between columns (`numColumns`) of vertical lists.
    pub column_gap: Points,
}

/// What a list scrolls in (`viewport`), fixed when the list is made.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
#[non_exhaustive]
pub enum ListViewport {
    /// A scroll view of its own (default).
    #[default]
    Own,
    /// The scroll view around it: the list lies in its parent's layout at
    /// its full length and renders the rows near that scroll view's
    /// viewport, so headers above it and other lists scroll with it as
    /// one page.
    Parent,
}

/// When list items count as viewable (React Native's `viewabilityConfig`).
/// Without thresholds, any visible pixel does.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Viewability {
    /// Percent of the viewport an item must cover.
    pub view_area_percent: Option<f32>,
    /// Percent of an item that must be visible.
    pub item_visible_percent: Option<f32>,
}

/// Where a header item goes (`<headeritem slot>`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum HeaderSlot {
    /// Leading, after the back button.
    #[default]
    Left,
    /// Trailing.
    Right,
    /// Replaces the title.
    Title,
    /// Replaces the whole bar (`header`), where the platform draws it.
    Header,
}

/// How a screen enters and leaves (`animation`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum ScreenAnimation {
    /// The platform's push / pop transition (`"slide"` too: a
    /// dialog's default, which shares the prop).
    #[default]
    #[prop(alias = "slide")]
    Default,
    /// Cross-fade.
    Fade,
    /// No animation.
    None,
}

/// A screen option (`<NavPage title headerVisible ...>`).
#[derive(Debug, Clone, PartialEq, HostProps)]
pub enum ScreenProp {
    /// `title`: the header's title (iOS and Android: the system header;
    /// ignored on the desktops and the web, which show the app's `header`).
    #[prop(js = "title", on = SCREEN)]
    Title(Option<Arc<str>>),
    /// `headerVisible`: the system header shows (default true; iOS and
    /// Android).
    #[prop(js = "headerVisible", default = true, on = SCREEN)]
    HeaderVisible(bool),
    /// `headerLargeTitle` (iOS: the system header; ignored elsewhere): a
    /// large title; the content scrolls under the header.
    #[prop(js = "headerLargeTitle", on = SCREEN)]
    HeaderLargeTitle(bool),
    /// `headerTransparent`: the content extends under the system header
    /// (iOS and Android).
    #[prop(js = "headerTransparent", on = SCREEN)]
    HeaderTransparent(bool),
    /// `headerBackTitle` (iOS: the system header; ignored elsewhere): the
    /// label of the back button leading back to this page.
    #[prop(js = "headerBackTitle", on = SCREEN)]
    HeaderBackTitle(Option<Arc<str>>),
    /// `ios={{ headerRightSystemItem }}`: UIKit's own bar button in the
    /// system header's trailing slot, in place of the view of
    /// `headerRight`; a press on it is a press on the first pressable view
    /// of `headerRight`. Without a `headerRight`, nothing is drawn there.
    #[prop(ios = "headerRightSystemItem", on = SCREEN)]
    HeaderRightSystemItem(Option<HeaderSystemItem>),
    /// `headerBackVisible`: the system header's back button shows (default
    /// true; iOS and Android).
    #[prop(js = "headerBackVisible", default = true, on = SCREEN)]
    HeaderBackVisible(bool),
    /// `popOnSwipe`: the interactive back gesture pops (iOS swipe back,
    /// Android predictive back following the finger); the back buttons pop
    /// either way (default true).
    #[prop(js = "popOnSwipe", default = true, on = SCREEN)]
    PopOnSwipe(bool),
    /// `popOnBack`: the user leaves the page with the back buttons (header,
    /// Android back, the desktops' back keys and mouse button, the
    /// browser's back) and the swipe back (default true). False keeps it,
    /// e.g. to confirm discarding changes in `onBackPress` (called on every
    /// back press) and then `pop()`. Decided natively when the system asks,
    /// so set it before the user acts.
    #[prop(js = "popOnBack", default = true, on = SCREEN)]
    PopOnBack(bool),
    /// `animation`: how the page enters and leaves.
    #[prop(js = "animation", on = SCREEN)]
    Animation(ScreenAnimation),
    /// `statusBar`: what the status bar shows while the page or dialog is
    /// up (iOS and Android; ignored on the desktops and the web), as a view
    /// controller's `preferredStatusBarStyle` decides it on iOS. The most
    /// recently shown page or dialog wins, field by field, over the pages
    /// below it and over the app's default (`nsh.json` `statusBar`). Pages
    /// and dialogs share it.
    #[prop(js = "statusBar", on = SCREEN | MODAL)]
    StatusBar(Option<StatusBarSetting>),
}

/// How a modal appears (`animation`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum ModalAnimation {
    /// Slides up from the bottom (default).
    #[default]
    Slide,
    /// Fades in.
    Fade,
    /// Appears at once.
    None,
}

/// How a modal covers the screen (`presentation`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum ModalPresentation {
    /// Covers the whole screen (default).
    #[default]
    FullScreen,
    /// A sheet that leaves the presenting content visible behind it.
    PageSheet,
    /// A smaller centered sheet on large screens.
    FormSheet,
}

/// A modal option (`<Dialog …>`).
#[derive(Debug, Clone, Copy, PartialEq, HostProps)]
pub enum ModalProp {
    /// `animation`: how the dialog appears. Pages and dialogs share the
    /// name, so JS's value arrives as [`ScreenProp::Animation`], which the
    /// core takes for this on a dialog.
    Animation(ModalAnimation),
    /// `presentation`: `"pageSheet"` / `"formSheet"` keep what is behind
    /// visible (iOS; ignored on Android, the desktops and the web, where a
    /// dialog is a transparent layer over the window and the app's popup
    /// and backdrop are all it shows).
    #[prop(js = "presentation", on = MODAL)]
    Presentation(ModalPresentation),
    /// `statusBarTranslucent` (Android): the content reaches under the status bar
    /// (default: it starts below).
    #[prop(android = "statusBarTranslucent", on = MODAL)]
    StatusBarTranslucent(bool),
    /// `supportedOrientations` (iOS): the orientations it allows (default: the
    /// presenter's).
    ///
    /// [`crate::ModalConfig::PORTRAIT`] bits.
    #[prop(ios = "supportedOrientations", with = crate::js::host_values::orientations, reset = ModalProp::Orientations(0), ts = "(\"portrait\" | \"portrait-upside-down\" | \"landscape\" | \"landscape-left\" | \"landscape-right\")[]", on = MODAL)]
    Orientations(u8),
    /// `closeOnEscape`: Escape and the Android back button close it natively
    /// (default true); either way they call `onCancel`.
    #[prop(js = "closeOnEscape", default = true, on = MODAL)]
    CloseOnEscape(bool),
    /// `closeOnBackdropPress`: a press on the backdrop part
    /// (`backdropClass` / `backdropStyle`, rendered by the runtime) closes
    /// it (default true); either way it calls `onCancel`.
    #[prop(js = "closeOnBackdropPress", default = true, on = MODAL)]
    CloseOnBackdropPress(bool),
    /// `closeOnSwipe`: swiping a sheet down (iOS, phone browsers) closes it
    /// natively (default true); either way it calls `onCancel`.
    #[prop(js = "closeOnSwipe", default = true, on = MODAL)]
    CloseOnSwipe(bool),
}

/// An overlay option (`<Overlay …>`, [`crate::overlay`]).
#[derive(Debug, Clone, Copy, PartialEq, HostProps)]
pub enum OverlayProp {
    /// `anchor`: the view (a ref), the point (`{ x, y }` in the root view,
    /// as touches' `pageX` / `pageY`) or the box (`{ origin, size }` in the
    /// root view, as an input's caret `pageBounds`) it is placed against,
    /// following a view as it moves; without one it is laid out as a
    /// `position: fixed` box of its root view.
    #[prop(js = "anchor", with = crate::js::host_values::overlay_anchor, reset = OverlayProp::Anchor(OverlayAnchor::None), ts = "YNode | Point | Bounds | null", on = OVERLAY)]
    Anchor(OverlayAnchor),
    /// `placement`: the side of the anchor it goes on (default `"bottom"`);
    /// the other side when only that one has room.
    #[prop(js = "placement", on = OVERLAY)]
    Placement(Placement),
    /// `align`: how it lines up with the anchor along that side (default
    /// `"center"`; `"start"` / `"end"` follow the layout direction above and
    /// below).
    #[prop(js = "align", on = OVERLAY)]
    Align(Align),
    /// `offset`: the gap between the anchor and the overlay (default 0).
    #[prop(js = "offset", on = OVERLAY)]
    Offset(Points),
    /// `margin`: the distance it keeps from the edges of the root view's
    /// safe area (default 0).
    #[prop(js = "margin", on = OVERLAY)]
    Margin(Points),
    /// A native popup focus-return scope (terminal and GPUI); set by
    /// components such as `nsh-base`'s `Popover`.
    #[prop(reset = OverlayProp::FocusReturn(false))]
    FocusReturn(bool),
    /// A hint (a tooltip) shown after the pointer rested on the anchor this
    /// long ([`crate::overlay::OverlayConfig::hint`]); set by components
    /// (`nsh-base`'s `Tooltip`).
    #[prop(js = "hintDelay", with = crate::js::host_values::hint_delay, reset = OverlayProp::Hint(None), ts = "number", on = OVERLAY)]
    Hint(Option<std::time::Duration>),
    /// Show the hint while its native anchor has keyboard focus too.
    #[prop(js = "hintOnFocus", on = OVERLAY)]
    HintOnFocus(bool),
    /// A hint shown or hidden whatever the pointer does
    /// ([`crate::overlay::OverlayConfig::open`]); set by components.
    #[prop(reset = OverlayProp::Open(None))]
    Open(Option<bool>),
}

/// An imperative call on a native view (`ref.focus()` and the like).
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    /// Focus an input (show the keyboard).
    Focus,
    /// Unfocus an input; on the root view, unfocus whatever is focused.
    Blur,
    /// Scroll a scroll view to an offset.
    ScrollTo {
        /// Horizontal offset.
        x: Points,
        /// Vertical offset.
        y: Points,
        /// Animate the change.
        animated: bool,
    },
    /// Animate the layout changes of the next commit (on the root).
    LayoutAnimation(LayoutAnimation),
    /// Leave the app (Android back handling; on the root).
    ExitApp,
    /// What the back button does when none of the app's listeners took
    /// it: the innermost stack pops (or asks, with `popOnBack` false); with
    /// none, the app leaves on Android (on the root).
    Back,
    /// Reload a web view.
    Reload,
    /// Go back in a web view's history.
    GoBack,
    /// Go forward in a web view's history.
    GoForward,
    /// Stop loading a web view.
    StopLoading,
    /// Run JavaScript in a web view's page.
    InjectJavaScript(String),
    /// Send a message to a web view's page (`window.onmessage` data).
    PostMessage(String),
    /// Seek a video to a time in seconds.
    Seek(f64),
    /// Scroll a list to an item (resolved by the core into `ScrollTo`).
    ScrollToIndex {
        /// The item.
        index: u32,
        /// Animate the change.
        animated: bool,
        /// Wait while the list is hovered or contains keyboard focus; keep only
        /// the latest automatic target and resume when it becomes idle.
        automatic: bool,
        /// Where the item ends up: 0 at the start of the viewport, 1 at the
        /// end, 0.5 in the middle.
        view_position: Percentage,
        /// Extra distance from that position.
        view_offset: Points,
    },
    /// Zoom a zoomable scroll view to `scale`, with the content point
    /// (`x`, `y`) (points, unzoomed) in the middle of the viewport, or
    /// around the viewport's middle.
    ZoomTo {
        /// The zoom scale (clamped to the view's limits).
        scale: f32,
        /// The content point to center.
        center: Option<Point<Points>>,
        /// Animate the change.
        animated: bool,
    },
    /// Scroll a list to the end of its content.
    ScrollToEnd {
        /// Animate the change.
        animated: bool,
    },
    /// Set the status bar (on the root): what the platform shows.
    StatusBar(StatusBarConfig),
    /// Change what functions set for the status bar (on the root): the
    /// core merges it under the settings components render and sends
    /// [`Command::StatusBar`] when the result changes.
    SetStatusBar(StatusBarSetting),
    /// Show an alert or action sheet (on the root); the answer comes back
    /// as [`EventKind::Dialog`].
    Dialog(Box<Dialog>),
    /// A JS responder took the touches on this view: `block` keeps native
    /// scroll views around it from taking them over.
    SetJsResponder {
        /// Block native scrolling.
        block: bool,
    },
    /// The JS responder let go (on the root).
    ClearJsResponder,
    /// Select a range of an input (UTF-16 units; equal for a caret).
    SetSelection {
        /// Start.
        start: u32,
        /// End.
        end: u32,
    },
    /// Replace an input range as one undoable native edit, provided the
    /// original text, selection and native edit generation still match.
    ReplaceRange {
        /// UTF-16 range to replace, on exact character boundaries.
        range: std::ops::Range<u32>,
        /// Literal replacement text.
        text: String,
        /// Text observed when the replacement was chosen.
        expected_text: String,
        /// UTF-16 selection observed when the replacement was chosen.
        expected_selection: std::ops::Range<u32>,
        /// The core fills in the input's latest observed native edit count.
        count: u32,
    },
    /// Show a short message (Android toast; on the root).
    Toast {
        /// The message.
        text: String,
        /// Show it longer.
        long: bool,
    },
    /// Have the screen reader read a message (on the root).
    Announce(String),
    /// Load the image at `uri` (keeping its bytes for views that show it
    /// next) and report its pixel size as [`EventKind::ImageInfo`] `id`
    /// (on the root).
    ImageInfo {
        /// The request.
        id: u32,
        /// URL or `asset:/` URI.
        uri: String,
    },
    /// Move the screen reader's focus to this view.
    AccessibilityFocus,
    /// Measure the view with this commit's layout (`ref.measure()`):
    /// answered by the core in its events for promise `call`
    /// ([`crate::ui::JsEvent::Reply`]: a [`crate::Measurement`], or null
    /// when the view is not laid out); never mounted.
    Measure {
        /// The call to answer.
        call: u32,
    },
    /// Put `text` on the system clipboard (on the root; `Clipboard.writeText`).
    SetClipboard(String),
    /// Read the system clipboard and report it as [`EventKind::Clipboard`]
    /// `id` (on the root): `has` and, unless `has_only`, `text`. Asking
    /// only whether it holds text does not read it (no iOS paste notice).
    ReadClipboard {
        /// The request.
        id: u32,
        /// Only whether it holds text (`Clipboard.hasText`).
        has_only: bool,
    },
    /// Put the image of a `data:` URI on the system clipboard, replacing
    /// what it holds (on the root; `Clipboard.writeImage`).
    SetClipboardImage(String),
    /// Read the image on the system clipboard and report it as
    /// [`EventKind::Clipboard`] `id` (on the root): `has` and, unless
    /// `has_only`, the image as a `data:` URI (`uri`) and its size in
    /// pixels (`width`, `height`).
    ReadClipboardImage {
        /// The request.
        id: u32,
        /// Only whether it holds an image (`Clipboard.hasImage`).
        has_only: bool,
    },
    /// Read the local files on the system clipboard (files copied in a
    /// file manager) and report them as [`EventKind::Clipboard`] `id` (on
    /// the root): `has` and `files`, their `file:` URLs one per line.
    ReadClipboardFiles {
        /// The request.
        id: u32,
    },
    /// Show the system's picker for images (on the root;
    /// `Picker.pickImages`), prepare the picked ones as `request` says
    /// ([`crate::picker`]) and report them as [`EventKind::Pick`]
    /// ([`EventPayload::Picked`] `id`; no files when cancelled).
    PickImages {
        /// The request.
        id: u32,
        /// What to show and how to prepare the images.
        request: crate::picker::PickRequest,
    },
    /// Open `url` outside the app (on the root; `openUrl` of `nsh/device`,
    /// [`crate::open_url`]): the browser, the mail or phone app, the app
    /// that registered its scheme. Report whether it opened as
    /// [`EventKind::OpenUrl`] `id`. The core sends it once the URL was
    /// checked and the embedding app did not take it.
    OpenUrl {
        /// The request.
        id: u32,
        /// The URL ([`crate::open_url::check_url`] passed it).
        url: String,
    },
    /// A desktop command (on the root; `nsh/desktop`): the window, its
    /// title bar, menus. Mobile platforms ignore it.
    Desktop(Box<crate::desktop::DesktopCommand>),
    /// Call function `name` of the app embedding NSH (on the root;
    /// `nsh/host`'s `host.call`): the platform answers with
    /// [`EventKind::Host`] `{ type: "reply", id, .. }`. Sent only on
    /// platforms whose [`crate::platform::Environment::host`] is set, for
    /// functions the app's `capabilities.host` grants.
    HostCall {
        /// The call, echoed by the reply.
        id: u64,
        /// The host's function.
        name: String,
        /// Its argument (any JSON value; `null` without one).
        args: crate::JsonValue,
    },
    /// A call on a registered native component (`ref.command(name, args)`).
    Native {
        /// The command.
        name: Arc<str>,
        /// Its arguments (any JSON value).
        args: crate::JsonValue,
    },
}

/// The status bar's look.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StatusBarStyle {
    /// The platform's default for the appearance.
    #[default]
    Default,
    /// Light content (for dark backgrounds).
    Light,
    /// Dark content (for light backgrounds).
    Dark,
}

impl StatusBarStyle {
    /// The style of a TS `StatusBarForeground` (`"auto"`, `"light"`,
    /// `"dark"`).
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "auto" => Some(Self::Default),
            "light" => Some(Self::Light),
            "dark" => Some(Self::Dark),
            _ => None,
        }
    }
}

/// What the status bar shows.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct StatusBarConfig {
    /// Content color.
    pub style: StatusBarStyle,
    /// Hidden.
    pub hidden: bool,
    /// Animate the change.
    pub animated: bool,
}

/// A status bar setting: what it sets; the fields it leaves out keep the
/// settings below it.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct StatusBarSetting {
    /// Content color.
    pub style: Option<StatusBarStyle>,
    /// Hidden.
    pub hidden: Option<bool>,
    /// Animate the change.
    pub animated: Option<bool>,
}

/// The setting of the content's color alone (`.status_bar(StatusBarStyle::Light)`).
impl From<StatusBarStyle> for StatusBarSetting {
    fn from(style: StatusBarStyle) -> Self {
        Self::default().foreground(style)
    }
}

impl StatusBarSetting {
    /// Sets the content's color.
    pub const fn foreground(mut self, style: StatusBarStyle) -> Self {
        self.style = Some(style);
        self
    }

    /// Hides or shows the bar.
    pub const fn hidden(mut self, hidden: bool) -> Self {
        self.hidden = Some(hidden);
        self
    }

    /// Animates the change to this setting.
    pub const fn animated(mut self, animated: bool) -> Self {
        self.animated = Some(animated);
        self
    }

    /// The app's default (`nsh.json` `"statusBar"`): `{ "foreground":
    /// "auto" | "light" | "dark", "hidden": bool }`, both optional. The
    /// error says what is wrong, for `nsh.json: statusBar: …`.
    pub fn from_json(value: &crate::JsonValue) -> Result<Self, String> {
        let Some(object) = value.as_object() else {
            return Err(format!(
                "expected an object ({{ \"foreground\": \"light\", \"hidden\": false }}), got {value}"
            ));
        };
        let mut setting = Self::default();
        for (key, v) in object {
            match key.as_str() {
                "foreground" => {
                    let style = v.as_str().and_then(StatusBarStyle::from_name);
                    setting.style = Some(style.ok_or_else(|| {
                        format!("foreground: {v} is not \"auto\", \"light\" or \"dark\"")
                    })?);
                }
                "hidden" => {
                    setting.hidden = Some(
                        v.as_bool()
                            .ok_or_else(|| format!("hidden: {v} is not true or false"))?,
                    );
                }
                other => {
                    return Err(format!(
                        "unknown key {other:?} (\"foreground\" and \"hidden\" are known)"
                    ));
                }
            }
        }
        Ok(setting)
    }

    /// This setting over `below`.
    pub fn over(self, below: Self) -> Self {
        Self {
            style: self.style.or(below.style),
            hidden: self.hidden.or(below.hidden),
            animated: self.animated.or(below.animated),
        }
    }
}

/// How a dialog button looks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DialogButtonStyle {
    /// A regular button.
    #[default]
    Default,
    /// The cancel button.
    Cancel,
    /// A destructive action.
    Destructive,
}

/// A dialog button.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DialogButton {
    /// Label.
    pub text: String,
    /// Look.
    pub style: DialogButtonStyle,
}

/// An alert, or with `sheet` an action sheet.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Dialog {
    /// Echoed in the answer.
    pub id: u32,
    /// Title.
    pub title: Option<String>,
    /// Message.
    pub message: Option<String>,
    /// Buttons, or the sheet's options.
    pub buttons: Vec<DialogButton>,
    /// Tapping outside (or the back button) dismisses it.
    pub cancelable: bool,
    /// An action sheet rather than an alert.
    pub sheet: bool,
}

/// A non-style property of a host node.
#[derive(Debug, Clone, PartialEq, HostProps)]
pub enum Prop {
    /// `component`: which registered native component a `<native>`
    /// element is (set once, before it is mounted).
    #[prop(js = "component", internal)]
    Component(Arc<str>),
    /// `componentSlot`: this view holds the JSX a Rust component's host got
    /// for slot `name` (created by the generated glue).
    #[prop(js = "componentSlot", internal)]
    ComponentSlot(Arc<str>),
    /// `componentRender`: this view holds what the app's function of a
    /// Rust component's render prop rendered for a key (the prop, U+001F,
    /// the key; made by the generated glue on `JsEvent::Render`).
    #[prop(js = "componentRender", internal)]
    ComponentRender(Arc<str>),
    /// A property of a registered native component (`$name` from JS):
    /// any JSON value, `None` to remove it.
    ComponentProp(Arc<str>, Option<crate::JsonValue>),
    /// A prop of a Rust component's host, decoded in the JS call into the
    /// prop's Rust type ([`crate::ui::PropSpec::decode`]); `None` resets it
    /// to its default.
    RustProp(&'static str, Option<crate::ui::AnyValue>),
    /// `src`: a URL, `asset:/path`, or an imported asset.
    #[prop(js = "src", on = IMAGE, shared)]
    Source(Option<ImageSource>),
    /// `resizeMode`: how an image (or a video) fits its box.
    #[prop(js = "resizeMode", on = IMAGE | VIDEO)]
    ResizeMode(ResizeMode),
    /// `horizontal`: scrolls sideways.
    #[prop(js = "horizontal", on = SCROLL | LIST)]
    Horizontal(bool),
    /// Scrolling behavior of a scroll view or list.
    #[prop(nested)]
    Scroll(ScrollProp),
    /// `scrollbar`: the scroll indicator shows (default true). On the
    /// desktop a horizontal view keeps it: it is the mouse's scroll bar.
    #[prop(js = "scrollbar", default = true, on = SCROLL | LIST)]
    Scrollbar(bool),
    /// `refreshing`: the pull-to-refresh spinner shows.
    #[prop(js = "refreshing", on = SCROLL | LIST)]
    Refreshing(bool),
    /// Number of items of a list.
    #[prop(js = "count", internal)]
    Count(u32),
    /// `estimatedItemSize`: the size of items not measured yet, in points (default
    /// 50).
    #[prop(js = "estimatedItemSize", default = Points(50.0), on = LIST)]
    EstimatedItemSize(Points),
    /// The recycling slot (or the role) of a list cell, set once by the
    /// runtime.
    #[prop(js = "slot", with = crate::js::host_values::slot, internal)]
    Slot(CellSlot),
    /// `numColumns`: items per row (vertical lists).
    #[prop(js = "numColumns", default = 1, min = 1, on = LIST)]
    Columns(u32),
    /// The items of a list changed: `removed` at `at` became `inserted`
    /// (precedes the new `Count`).
    #[prop(js = "splice", with = crate::js::host_values::splice, internal)]
    Splice(u32, u32, u32),
    /// `inverted`: laid out from the end, item 0 last (chat style); starts scrolled
    /// to the end and keeps its distance from the end as content changes.
    #[prop(js = "inverted", on = LIST)]
    Inverted(bool),
    /// `maintainVisibleContentPosition`: with `autoscrollToBottomThreshold`, a list
    /// (not inverted) at the end of its content, or within that many points of it,
    /// stays at the end as the content grows or the viewport shrinks (a reply
    /// streaming into its last item); scrolled further up, it keeps the visible
    /// content where it is. Items inserted above the visible ones never move them.
    #[prop(js = "maintainVisibleContentPosition", with = crate::js::host_values::visible_content, reset = Prop::FollowEnd(None), ts = "{ autoscrollToBottomThreshold?: number }", on = LIST)]
    FollowEnd(Option<Points>),
    /// `stickyHeaderIndices`: items that stick to the start while scrolled past
    /// (one column, not inverted).
    #[prop(js = "stickyHeaderIndices", with = crate::js::host_values::sticky, reset = Prop::StickyIndices(Vec::new()), on = LIST)]
    StickyIndices(Vec<u32>),
    /// `stickyHeaderOffset`: how far from the start of the viewport sticky
    /// items stick, as CSS `position: sticky`'s `top` (negative: partly out
    /// of view); the content scrolls under the space before them.
    #[prop(js = "stickyHeaderOffset", with = crate::js::host_values::sticky_offset, reset = Prop::StickyOffset(Points(0.0)), ts = "number | AnimatedNode", on = LIST)]
    StickyOffset(Points),
    /// `stickyHeaderOffset` as an animated value: sticky items stick that
    /// far from the start of the viewport, following the value (below a
    /// header that moves); the platforms read it as they pin.
    StickyOffsetNode(Option<crate::animation::NodeId>),
    /// `viewport`: `"parent"` lays the list out at its full length in its
    /// parent and renders the rows near the viewport of the scroll view
    /// around it, which scrolls it (a page of headers and lists); `"own"`
    /// (default) scrolls it in a scroll view of its own. Fixed when the
    /// list is made.
    #[prop(js = "viewport", on = LIST)]
    ListViewport(ListViewport),
    /// Canonical row coverage of a native virtual list's source projection.
    ListSourceRows(Option<Arc<crate::ListSourceRows>>),
    /// `contentStyle`: padding and gaps of the content.
    #[prop(js = "contentStyle", on = LIST)]
    ListContent(ListContentStyle),
    /// `contentClass`: padding and gaps of the content as classes (`p-*`,
    /// `gap-*`); `contentStyle` wins over them (set by the runtime).
    ListContentClass(Box<str>),
    /// `viewabilityConfig`: when items count as viewable.
    #[prop(js = "viewabilityConfig", on = LIST)]
    Viewability(Viewability),
    /// How close to the end `onLoadMore` fires, in viewports.
    #[prop(js = "loadMoreThreshold", default = 1.0, internal)]
    LoadMoreThreshold(f32),
    /// How close to the start `onLoadMoreAtStart` fires, in viewports.
    #[prop(js = "loadMoreAtStartThreshold", default = 1.0, internal)]
    LoadMoreAtStartThreshold(f32),
    /// The item index a list cell now renders (set by the runtime after
    /// each bind, in the same batch as the cell's new content).
    #[prop(js = "cellIndex", internal)]
    CellIndex(u32),
    /// `scrollValue`: an animated value fed with the scroll offset (main axis), for
    /// scroll-linked effects.
    #[prop(js = "scrollValue", with = crate::js::host_values::scroll_value, reset = Prop::ScrollValue(None), ts = "AnimatedValue", on = SCROLL | LIST)]
    ScrollValue(Option<crate::animation::NodeId>),
    /// `pan`: drags drive these animated values (points) on the UI thread.
    #[prop(js = "pan", with = crate::js::host_values::pan, reset = Prop::PanValues(None, None), ts = "{ x?: AnimatedValue; y?: AnimatedValue }")]
    PanValues(
        Option<crate::animation::NodeId>,
        Option<crate::animation::NodeId>,
    ),
    /// `numberOfLines`: the most lines shown; 0 (default) is unlimited.
    #[prop(js = "numberOfLines", on = TEXT)]
    NumberOfLines(u32),
    /// `ellipsizeMode`: where text that does not fit `numberOfLines` is cut.
    #[prop(js = "ellipsizeMode", on = TEXT)]
    EllipsizeMode(EllipsizeMode),
    /// `value`: the text, controlled by JS.
    #[prop(js = "value", on = INPUT)]
    Value(String),
    /// `defaultValue`: the initial text.
    #[prop(js = "defaultValue", once, on = INPUT)]
    DefaultValue(String),
    /// `placeholder`: shown while the input is empty.
    #[prop(js = "placeholder", on = INPUT, shared)]
    Placeholder(String),
    /// The placeholder's color (Rust components; TS sets the
    /// `placeholderColor` style key or `placeholder:text-*`).
    PlaceholderColor(Option<Color>),
    /// `masked`: the text is hidden (passwords).
    #[prop(js = "masked", on = INPUT)]
    Secure(bool),
    /// `keyboardType`: the keyboard layout.
    #[prop(js = "keyboardType", on = INPUT)]
    KeyboardType(KeyboardType),
    /// `keyboardAppearance` (iOS): the keyboard's light or dark look;
    /// Android's keyboards follow the system's theme.
    #[prop(ios = "keyboardAppearance", on = INPUT)]
    KeyboardAppearance(KeyboardAppearance),
    /// `returnKeyType`: the label of the return key.
    #[prop(js = "returnKeyType", on = INPUT)]
    ReturnKeyType(ReturnKeyType),
    /// `autoCapitalize`: automatic capitalization (default `"sentences"`).
    #[prop(js = "autoCapitalize", on = INPUT)]
    AutoCapitalize(AutoCapitalize),
    /// `autoCorrect`: the system's corrections (default true).
    #[prop(js = "autoCorrect", default = true, on = INPUT)]
    AutoCorrect(bool),
    /// `multiline`: several lines; return inserts a line break.
    #[prop(js = "multiline", on = INPUT)]
    Multiline(bool),
    /// `maxLength`: the most characters the user can enter.
    #[prop(js = "maxLength", on = INPUT)]
    MaxLength(Option<u32>),
    /// `readonly`: the user can select and copy the text but not change it.
    #[prop(js = "readonly", on = INPUT)]
    Readonly(bool),
    /// `submitBehavior`: what return does: `"submit"` (reports
    /// `onSubmit`, keeps the focus), `"blurAndSubmit"` (also
    /// unfocuses), `"newline"` (inserts a line break; multiline inputs
    /// only). Default: `"blurAndSubmit"` for one line, `"newline"` for
    /// several. A multiline input that submits still takes line breaks
    /// from Shift+Return or Option / Alt+Return on desktops.
    #[prop(js = "submitBehavior", on = INPUT)]
    SubmitBehavior(Option<SubmitBehavior>),
    /// `pasteBehavior`: what a paste does: `"insert"` (default) inserts its
    /// text, `"report"` inserts nothing; `onPaste` reports what was pasted
    /// either way. Decided natively when the user pastes.
    #[prop(js = "pasteBehavior", on = INPUT)]
    PasteBehavior(PasteBehavior),
    /// `autoFocus`: focused when it appears.
    #[prop(js = "autoFocus", on = INPUT)]
    AutoFocus(bool),
    /// `caret`: the caret is drawn (default true; `false` hides it).
    #[prop(js = "caret", default = true, on = INPUT)]
    Caret(bool),
    /// `inputAccessoryViewID`: the `nativeID` of an `InputAccessoryView`
    /// (`nsh/ios`) shown over the keyboard while the input has focus.
    #[prop(ios = "inputAccessoryViewID", on = INPUT)]
    InputAccessoryViewId(Option<Box<str>>),
    /// `nativeID`: names the view for others (an input accessory's for
    /// `inputAccessoryViewID`).
    #[prop(js = "nativeID")]
    NativeId(Option<Box<str>>),
    /// An input's caret and selection, the highlight of a `selectable`
    /// text's selection (Rust components; TS sets the `selectionColor`
    /// style key or `selection:bg-*`).
    SelectionColor(Option<Color>),
    /// `autoComplete` (iOS: also `textContentType`): what an input holds, for
    /// autofill (React Native's values, e.g. "username", "current-password",
    /// "new-password", "one-time-code", "email", "tel", "postal-code", "cc-number",
    /// "off").
    #[prop(js = "autoComplete", ios = "textContentType", on = INPUT)]
    AutoFill(AutoFill),
    /// `selectedRange`: the controlled selection (UTF-16 units; `end` defaults to
    /// `start`, a caret).
    #[prop(js = "selectedRange", with = crate::js::host_values::selection, once, ts = "{ start: number; end?: number }", on = INPUT)]
    Selection(u32, u32),
    /// `keyboardDismissMode`: whether dragging dismisses the keyboard.
    #[prop(js = "keyboardDismissMode", on = SCROLL | LIST)]
    KeyboardDismissMode(KeyboardDismissMode),
    /// `pointerEvents`: touch handling of the view and its children (React Native
    /// semantics).
    #[prop(js = "pointerEvents")]
    PointerEvents(PointerEvents),
    /// `hitSlop`: extends the touch area beyond the bounds.
    #[prop(js = "hitSlop", with = crate::js::host_values::hit_slop, reset = Prop::HitSlop(EdgeInsets::default()), ts = "number | Partial<Edges>")]
    HitSlop(EdgeInsets),
    /// `panActivation`: the view's touch responder waits for a pan that the
    /// platform activates past an offset on one axis (and fails past one on
    /// the other), deciding on the main thread so the scroll views around
    /// it keep the touches until then.
    #[prop(js = "panActivation")]
    PanActivation(Option<crate::props::PanActivation>),
    /// Whether native pans may start or update their bound values. Rust
    /// components use this to retain gesture state across permission changes.
    PanEnabled(bool),
    /// A vertical pan cooperates with descendant scroll views on iOS:
    /// scrolling consumes the drag until its top, then the pan follows.
    PanScrollHandoff(bool),
    /// `activeStyle`: the style while pressed (and not disabled), over the
    /// view's style; applied natively, no JS round trip.
    ActiveStyle(Option<Arc<StylePatch>>),
    /// `hoverStyle`: the style while a pointer is over the view (and it is
    /// not disabled).
    HoverStyle(Option<Arc<StylePatch>>),
    /// `focusStyle`: the style while the view has focus (and is not
    /// disabled).
    FocusStyle(Option<Arc<StylePatch>>),
    /// `disabledStyle`: the style while `disabled`, over every other state's.
    DisabledStyle(Option<Arc<StylePatch>>),
    /// `selectedStyle`: the style while `accessibilityState.selected` (a
    /// `Button`'s `selected`), and not disabled.
    SelectedStyle(Option<Arc<StylePatch>>),
    /// `checkedStyle`: the style while `accessibilityState.checked` (true,
    /// not mixed: a checkbox's, a switch's, a radio's), and not disabled.
    CheckedStyle(Option<Arc<StylePatch>>),
    /// `indeterminateStyle`: the style while `accessibilityState.checked`
    /// is mixed (a checkbox's `indeterminate`), and not disabled.
    IndeterminateStyle(Option<Arc<StylePatch>>),
    /// The states a part of a control shows its classes and state styles
    /// as its control has them ([`crate::tailwind::state`] bits: `checked`,
    /// `indeterminate`, `disabled`): a switch's thumb styled `checked:`
    /// while the switch is on. They tell screen readers nothing and take no
    /// presses away: the control announces and handles them. Set by
    /// components (`Interactive::project_checked`, `project_indeterminate`,
    /// `project_disabled`), never by JS.
    ProjectedStates(u8),
    /// `headerStyle` of a page: `backgroundColor`, `color` (the title's) and
    /// `tintColor` (the buttons') of its header.
    HeaderStyle(Option<Arc<StylePatch>>),
    /// `headerClass` of a page: the header's colors as classes (`bg-*`,
    /// `text-*`, `tint-*`); `headerStyle` wins over them.
    HeaderClass(Box<str>),
    /// A page header's colors as typed styles lowered as classes are (Rust:
    /// `Screen::header_style_with`), in place of `headerClass`;
    /// `headerStyle` wins over them. Set by components, never by JS.
    HeaderClassList(Option<Arc<crate::tailwind::ClassList>>),
    /// The surface lays out right to left (on the root, from the user's
    /// language).
    #[prop(js = "layoutDirectionRtl", internal)]
    LayoutDirection(bool),
    /// The app's appearance (on the root, from `nsh.json` and
    /// `setColorScheme`).
    #[prop(js = "appearance", internal)]
    Appearance(crate::platform::Appearance),
    /// The surface's keyboard shortcuts (on the root, from `nsh/keymap`):
    /// the whole table, mounted as [`crate::MountItem::Keymap`].
    Keymap(std::sync::Arc<crate::keymap::Keymap>),
    /// Padding added to the style's own (safe areas, the keyboard), in
    /// points on the physical edges; set by components
    /// (`Element::inset_padding`), never by JS.
    InsetPadding(EdgeInsets),
    /// Margin added to the style's own (`KeyboardAvoidingView`'s
    /// `height` behavior), in points on the physical edges; set by
    /// components.
    InsetMargin(EdgeInsets),
    /// `class`: Tailwind CSS classes (`"flex-row gap-2 p-4 bg-white
    /// dark:bg-zinc-900"`), resolved natively. Later classes win over earlier ones;
    /// `style` wins over both.
    #[prop(js = "class")]
    Class(Box<str>),
    /// `classList`: classes applied while their value is truthy (`{ "opacity-50":
    /// busy() }`).
    #[prop(js = "classList", with = crate::js::host_values::class_list, reset = Prop::ClassList(Vec::new()), ts = "Record<string, boolean | null | undefined>")]
    ClassList(Vec<Box<str>>),
    /// The app's Tailwind theme (JSON, on the root).
    #[prop(js = "tailwindTheme", with = crate::js::host_values::tailwind_theme, internal)]
    TailwindTheme(Box<str>),
    /// The theme of Rust components (`nsh.json` `theme`, JSON), on the
    /// root.
    #[prop(js = "uiTheme", with = crate::js::host_values::ui_theme, internal)]
    UiTheme(Box<str>),
    /// An image option.
    #[prop(nested)]
    Image(ImageProp),
    /// `delayLongPress`: milliseconds before a press becomes a long press (default
    /// 500).
    #[prop(js = "delayLongPress", min = 0)]
    LongPressDelay(Option<f32>),
    /// `ripple` (Android): the material ripple while pressed.
    #[prop(android = "ripple")]
    Ripple(Option<crate::props::Ripple>),
    /// `elevation` (Android): the material shadow (points), from the view's shape.
    #[prop(android = "elevation")]
    Elevation(Points),
    /// The system material of a backdrop blur (iOS, default `ultraThin`).
    #[prop(ios = "backdropMaterial")]
    BackdropMaterial(crate::BackdropMaterial),
    /// An accessibility property.
    #[prop(nested)]
    Accessibility(AccessibilityProp),
    /// `testID`: an identifier for UI tests.
    #[prop(js = "testID")]
    TestId(Option<Arc<str>>),
    /// `windowDrag` (desktops): pressing the view drags the window, as its
    /// title bar would (double-clicking maximizes it); `false` keeps a part
    /// of a draggable view clickable. The nearest view that sets it
    /// decides; text fields and views with press or touch handlers inside
    /// a draggable view stay clickable without it.
    #[prop(desktop = "windowDrag")]
    WindowDrag(Option<bool>),
    /// `tooltip`: a hint about the view, shown above it on the desktops
    /// while the pointer rests on it (after half a second) until the
    /// pointer leaves or presses it, never on touch screens; it never takes
    /// the pointer. A string shows in a minimal bubble drawn with the
    /// theme's `popover` tokens; an element is shown as it is (style it, or
    /// use `Tooltip` of `nsh/base` for its placement, delay and events).
    #[prop(js = "tooltip", with = crate::js::host_values::tooltip, reset = Prop::Tooltip(TooltipContent::None), ts = "JSX.Element")]
    Tooltip(TooltipContent),
    /// `focusable`: whether a view that takes presses is a stop of the
    /// keyboard focus (Tab, on the platforms that move it between
    /// pressables); `false` leaves it to the pointer (a backdrop that
    /// closes a popover). Default true.
    #[prop(js = "focusable")]
    Focusable(Option<bool>),
    /// The view is a selection area (`SelectionArea` of `nsh/base`): the
    /// texts in it share one selection ([`crate::selection`]); set by
    /// components (`Element::selection_area`).
    #[prop(js = "selectionArea", internal)]
    SelectionArea(bool),
    /// `allowFontScaling`: follow the system text size (default true).
    #[prop(js = "allowFontScaling", default = true, on = TEXT | INPUT)]
    AllowFontScaling(bool),
    /// `maxFontSizeMultiplier`: the upper bound of the system scale (0 is none).
    #[prop(js = "maxFontSizeMultiplier", min = 0, on = TEXT | INPUT)]
    MaxFontSizeMultiplier(f32),
    /// `selectable`: a long press offers to copy the text; `false` also
    /// keeps it from being selected where text is by default (desktop
    /// browsers), unset leaves it to the platform.
    #[prop(js = "selectable", on = TEXT)]
    Selectable(Option<bool>),
    /// `textSource`: the original source of this text. Local segment ranges are
    /// UTF-16 offsets; source offsets are absolute UTF-8 byte offsets. The core
    /// validates ranges against the flattened text before using them.
    #[prop(js = "textSource", with = crate::js::host_values::text_source, reset = Prop::TextSource(None), ts = "{ id: string; offset: number; segments?: never } | { id: string; offset?: never; segments: { start: number; end: number; sourceStart: number; sourceEnd: number; kind: \"literal\" | \"replacement\" }[] }", on = TEXT)]
    TextSource(Option<Arc<crate::TextSource>>),
    /// `adjustsFontSizeToFit`: shrink the font until the text fits its lines
    /// (`numberOfLines`) and box.
    #[prop(js = "adjustsFontSizeToFit", on = TEXT)]
    AdjustsFontSizeToFit(bool),
    /// `minimumFontScale`: how far `adjustsFontSizeToFit` shrinks at most (0..1).
    #[prop(js = "minimumFontScale", min = 0, max = 1, on = TEXT)]
    MinimumFontScale(f32),
    /// `pinch`: two-finger pinches drive `scale` natively.
    #[prop(js = "pinch", with = crate::js::host_values::pinch, reset = Prop::PinchValue(None), ts = "{ scale?: AnimatedValue }")]
    PinchValue(Option<crate::animation::NodeId>),
    /// `rotation`: two-finger rotations drive `angle` (degrees) natively.
    #[prop(js = "rotation", with = crate::js::host_values::rotation, reset = Prop::RotationValue(None), ts = "{ angle?: AnimatedValue }")]
    RotationValue(Option<crate::animation::NodeId>),
    /// A screen option.
    #[prop(nested)]
    Screen(ScreenProp),
    /// A modal option.
    #[prop(nested)]
    Modal(ModalProp),
    /// An overlay option.
    #[prop(nested)]
    Overlay(OverlayProp),
    /// `<headeritem slot>`.
    #[prop(js = "headerSlot", internal)]
    HeaderSlot(HeaderSlot),
    /// A property of a native control (web view, video), or `disabled`.
    #[prop(nested)]
    Native(NativeProp),
}

/// Where a web view loads from.
#[derive(Debug, Clone, PartialEq)]
pub enum WebSource {
    /// Nothing.
    None,
    /// A URL (`src`).
    Uri(Arc<str>),
    /// HTML, with the URL relative links resolve against.
    Html {
        /// The page.
        html: Arc<str>,
        /// Base URL.
        base_url: Option<Arc<str>>,
    },
}

/// A property of a native control.
#[derive(Debug, Clone, PartialEq, HostProps)]
pub enum NativeProp {
    /// `disabled` (any element): ignores presses (no press feedback either),
    /// applies `disabled:` classes, disables controls, and screen readers
    /// say it is disabled (its accessibility state).
    #[prop(js = "disabled")]
    Disabled(bool),
    /// What a web view or video loads, as Rust sets it (TS sets `src`,
    /// `html` and `baseUrl`).
    Source(WebSource),
    /// `src` of a web view or video: the URL it loads.
    #[prop(js = "src", on = WEBVIEW | VIDEO, shared)]
    Src(Option<Arc<str>>),
    /// `html` (web views): the page to show instead of loading `src`.
    #[prop(js = "html", on = WEBVIEW)]
    Html(Option<Arc<str>>),
    /// `baseUrl` (web views): the URL the relative links of `html`
    /// resolve against.
    #[prop(js = "baseUrl", on = WEBVIEW)]
    BaseUrl(Option<Arc<str>>),
    /// `injectedJavaScript` (web views): runs after each page loads.
    #[prop(js = "injectedJavaScript", on = WEBVIEW)]
    InjectedJavaScript(Option<Arc<str>>),
    /// `injectedJavaScriptBeforeContentLoaded` (web views): runs before each page's
    /// own scripts.
    #[prop(js = "injectedJavaScriptBeforeContentLoaded", on = WEBVIEW)]
    InjectedJavaScriptBefore(Option<Arc<str>>),
    /// `userAgent` (web views): the browser's user agent string.
    #[prop(js = "userAgent", on = WEBVIEW)]
    UserAgent(Option<Arc<str>>),
    /// `scrollable`: the user can scroll it (default true).
    #[prop(js = "scrollable", default = true, on = WEBVIEW | SCROLLING)]
    Scrollable(bool),
    /// `javaScriptEnabled` (web views): pages run scripts (default true).
    #[prop(js = "javaScriptEnabled", default = true, on = WEBVIEW)]
    JavaScriptEnabled(bool),
    /// `allowsBackForwardNavigationGestures` (iOS web views; desktop ones on
    /// macOS, with two-finger trackpad swipes): swipe back and forward.
    #[prop(
        ios = "allowsBackForwardNavigationGestures",
        desktop = "allowsBackForwardNavigationGestures",
        on = WEBVIEW
    )]
    BackForwardGestures(bool),
    /// `paused` (videos): playback is paused.
    #[prop(js = "paused", on = VIDEO)]
    Paused(bool),
    /// `muted` (videos): no sound.
    #[prop(js = "muted", on = VIDEO)]
    Muted(bool),
    /// `volume` (videos): 0..1.
    #[prop(js = "volume", default = 1.0, on = VIDEO)]
    Volume(f32),
    /// `rate` (videos): the playback speed.
    #[prop(js = "rate", default = 1.0, on = VIDEO)]
    Rate(f32),
    /// `repeat` (videos): plays again from the start at the end.
    #[prop(js = "repeat", on = VIDEO)]
    Repeat(bool),
    /// Video `resizeMode`.
    #[prop(reset = NativeProp::VideoResizeMode(ResizeMode::Contain))]
    VideoResizeMode(ResizeMode),
    /// `controls` (videos): the platform's playback controls.
    #[prop(js = "controls", on = VIDEO)]
    Controls(bool),
    /// `progressUpdateInterval` (videos): milliseconds between `onProgress` events
    /// (250 by default).
    #[prop(js = "progressUpdateInterval", default = 250.0, on = VIDEO)]
    ProgressInterval(f32),
    /// `audioSession` (videos): what the sound does to the rest of the
    /// device's audio while it plays (`"default"` when unset: the app's
    /// audio settings).
    #[prop(
        js = "audioSession",
        reset = NativeProp::AudioSession(crate::AudioSession::Default),
        on = VIDEO
    )]
    AudioSession(crate::AudioSession),
}

/// A mutation produced by the JS renderer.
#[derive(Debug)]
pub enum Op {
    /// What a canvas draws (replaces the previous drawing).
    Draw {
        /// The canvas.
        id: NodeId,
        /// The recorded operations.
        drawing: Box<crate::canvas::Drawing>,
    },
    /// Creates a detached element node.
    Create {
        /// New node id.
        id: NodeId,
        /// Element tag.
        tag: Tag,
    },
    /// Creates a detached raw text node.
    CreateText {
        /// New node id.
        id: NodeId,
        /// Text content.
        text: String,
    },
    /// Replaces the content of a raw text node.
    SetText {
        /// Text node id.
        id: NodeId,
        /// New content.
        text: String,
    },
    /// Replaces the whole style of a node.
    SetStyle {
        /// Node id.
        id: NodeId,
        /// The new style; boxed because layout styles are large.
        style: Box<Style>,
        /// The declarations `style` was built from, applied again over the
        /// node's class styles.
        patch: StylePatch,
    },
    /// Sets a non-style property.
    SetProp {
        /// Node id.
        id: NodeId,
        /// The property.
        prop: Prop,
    },
    /// Enables or disables an event listener on a node.
    Listen {
        /// Node id.
        id: NodeId,
        /// Event kind.
        event: EventKind,
        /// Whether a handler is attached.
        enabled: bool,
    },
    /// Inserts (or moves) `child` into `parent` before `before`, or appends.
    Insert {
        /// Parent node id.
        parent: NodeId,
        /// Child node id.
        child: NodeId,
        /// Sibling to insert before; `None` appends.
        before: Option<NodeId>,
    },
    /// Detaches `child` from `parent`. The child stays alive until released.
    Remove {
        /// Parent node id.
        parent: NodeId,
        /// Child node id.
        child: NodeId,
    },
    /// The JS node was garbage collected: free the node and its native view.
    Release {
        /// Node id.
        id: NodeId,
    },
    /// An animation graph change, forwarded to the platform in order.
    Animation(AnimationOp),
    /// An imperative call on a node's native view.
    Command {
        /// Node id.
        id: NodeId,
        /// The call.
        command: Command,
    },
    /// A call JS made into Rust that runs in order with the UI's ops: a
    /// module function with a context, the start of an `async` function or
    /// member, a method of a component's ref, or the place of a JS call
    /// posted during a synchronous call ([`crate::ui::RustCall`]). Never
    /// reaches a platform.
    Rust(crate::ui::RustOp),
}

#[cfg(test)]
mod event_mask_tests {
    use super::*;

    #[test]
    fn every_event_keeps_listeners_separate_from_observations() {
        let watch = HintWatchToken::new(1, 1);
        for &event in EventKind::ALL {
            let mut mask = EventMask::default();
            mask.observe(event, watch);
            assert!(mask.contains(event));
            assert!(!mask.contains_listener(event));
            assert!(!mask.is_empty());
            assert_eq!(mask.bits(), 1u128 << event as u8);
            assert_eq!(mask.hint_watch(), Some(watch));
            mask.set(event, true);
            assert!(mask.contains_listener(event));
            assert_eq!(mask.hint_watch(), Some(watch));
            mask.set(event, false);
            assert!(!mask.contains(event));
            assert!(!mask.contains_listener(event));
            assert!(mask.is_empty());
            assert_eq!(mask.hint_watch(), None);
        }
    }

    #[test]
    fn union_preserves_both_words_without_granting_listener_authority() {
        let watch = HintWatchToken::new(1, 1);
        // Exercise bits beyond the currently declared kinds without making
        // invalid EventKind values. Future kinds also run through the test above.
        let listeners = EventMask {
            listeners: [1, 1],
            ..Default::default()
        };
        let observations = EventMask {
            observations: [2, 1 << 63],
            hint_watch: Some(watch),
            ..Default::default()
        };
        let mask = listeners | observations;
        assert_eq!(mask.listeners, [1, 1]);
        assert_eq!(mask.observations, [2, 1 << 63]);
        assert_eq!(mask.bits(), 3 | (1u128 << 64) | (1u128 << 127));
        assert_eq!(mask.hint_watch(), Some(watch));
        assert_eq!(mask, observations | listeners);
        assert!(mask.contains_listener(EventKind::Press));
        assert!(mask.contains(EventKind::LongPress));
        assert!(!mask.contains_listener(EventKind::LongPress));
        assert_eq!(
            std::mem::align_of::<EventMask>(),
            std::mem::align_of::<u64>()
        );
    }

    #[test]
    fn upper_word_observations_keep_their_watch_when_a_lower_event_is_removed() {
        let watch = HintWatchToken::new(1, 1);
        let mut mask = EventMask {
            observations: [0, 1],
            hint_watch: Some(watch),
            ..Default::default()
        };
        mask.observe(EventKind::HoverIn, watch);
        mask.set(EventKind::HoverIn, true);
        mask.set(EventKind::HoverIn, false);
        assert!(!mask.is_empty());
        assert_eq!(mask.bits(), 1u128 << 64);
        assert_eq!(mask.listeners, [0; 2]);
        assert_eq!(mask.hint_watch(), Some(watch));
    }

    #[test]
    fn upper_word_watch_conflicts_cannot_be_reauthorized_by_a_union_or_observation() {
        let first = HintWatchToken::new(1, 1);
        let second = HintWatchToken::new(1, 2);
        let upper = EventMask {
            observations: [0, 1 << 63],
            hint_watch: Some(first),
            ..Default::default()
        };
        let mut lower = EventMask::default();
        lower.observe(EventKind::HoverIn, second);
        let mut conflicted = upper | lower;
        assert_eq!(conflicted.hint_watch(), None);
        assert_eq!((conflicted | upper).hint_watch(), None);
        assert_eq!((upper | conflicted).hint_watch(), None);
        conflicted.set(EventKind::HoverIn, false);
        assert_eq!(conflicted.bits(), 1u128 << 127);
        assert_eq!(conflicted.hint_watch(), None);
        assert_eq!((conflicted | upper).hint_watch(), None);
        assert_eq!((upper | conflicted).hint_watch(), None);
        conflicted.observe(EventKind::HoverOut, first);
        assert_eq!(conflicted.hint_watch(), None);
        assert_eq!(conflicted.listeners, [0; 2]);
        let mut observed = upper;
        observed.observe(EventKind::HoverIn, second);
        assert_eq!(observed.hint_watch(), None);
        assert_eq!(observed, upper | lower);
    }

    #[test]
    fn same_watch_unites_observations_across_both_words() {
        let watch = HintWatchToken::new(1, 1);
        let upper = EventMask {
            observations: [0, 1],
            hint_watch: Some(watch),
            ..Default::default()
        };
        let mut lower = EventMask::default();
        lower.observe(EventKind::HoverIn, watch);
        assert_eq!((upper | lower).hint_watch(), Some(watch));
        assert_eq!((lower | upper).hint_watch(), Some(watch));
        assert_eq!((upper | EventMask::default()).hint_watch(), Some(watch));
        assert_eq!((EventMask::default() | upper).hint_watch(), Some(watch));
    }
}
