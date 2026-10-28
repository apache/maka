//! Typed native events: what the `on_*` methods of elements hand their
//! listeners, decoded from the platform's [`EventPayload`].

use std::{borrow::Cow, sync::Arc};

use super::builder::Listener;
use crate::{
    Bounds, ContextMenuEvent, EventPayload, JsonValue, MouseEvent, PayloadValue, Point, Points,
    Size, TouchEvent,
    geometry::{DevicePixels, Radians},
};

/// Local files or directories dropped on an element (`on_file_drop`).
#[derive(Debug, Clone, PartialEq, Default)]
#[non_exhaustive]
pub struct FileDropEvent {
    /// Absolute `file:` URLs in platform order; encoded filenames are preserved.
    pub uris: Vec<String>,
    /// Where the files were let go, in the window's coordinates (TS:
    /// `pagePosition`), on backends that know it (Linux).
    pub page_position: Option<Point<Points>>,
}

/// A scroll view moved (`on_scroll`): the offset, and the sizes it moves in.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScrollEvent {
    /// The content offset (TS: `contentOffset`).
    pub offset: Point<Points>,
    /// The content's size (TS: `contentSize`).
    pub content_size: Size<Points>,
    /// The scroll view's size (TS: `layoutMeasurement`).
    pub size: Size<Points>,
    /// How far a zooming scroll view is zoomed (1: not zoomed; the content
    /// sizes are the zoomed ones).
    pub zoom_scale: f32,
}

impl Default for ScrollEvent {
    fn default() -> Self {
        Self {
            offset: Point::default(),
            content_size: Size::default(),
            size: Size::default(),
            zoom_scale: 1.0,
        }
    }
}

/// User scrolling requested before the offset changes (`on_scroll_intent`),
/// including when the scroll view is already at a boundary.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ScrollIntent {
    /// Move to the start (Home).
    Start,
    /// Move to the end (End).
    End,
    /// Other scrolling, or the start of a drag.
    #[default]
    Scroll,
}

/// A drag (`on_pan_start` / `on_pan_end`): translation since it started and
/// velocity, in points (per second).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct PanEvent {
    /// The system cancelled the drag rather than releasing it.
    pub cancelled: bool,
    /// The translation.
    pub translation: Point<Points>,
    /// Horizontal velocity.
    pub velocity_x: f32,
    /// Vertical velocity.
    pub velocity_y: f32,
    /// The bound horizontal animated value now (`Interactive::pan`; the
    /// values an app binds are of any quantity).
    pub value_x: Option<f32>,
    /// The bound vertical animated value now.
    pub value_y: Option<f32>,
}

/// A pinch or a rotation: its amount and velocity. A pinch's amount is
/// its scale (`GestureEvent<f32>`), a rotation's an angle
/// (`GestureEvent<Radians>`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct GestureEvent<T = f32> {
    /// The scale (pinches) or the rotation (rotations).
    pub value: T,
    /// Per second.
    pub velocity: f32,
}

/// An input's selection (UTF-16 units; equal for a caret).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Selection {
    /// Start.
    pub start: u32,
    /// End.
    pub end: u32,
}

/// Where an input's caret is (`on_caret_move`): what opens at it (an `@`
/// mention's suggestions) is placed with it.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
#[non_exhaustive]
pub struct CaretEvent {
    /// The caret in the input's coordinates (its border box), its own
    /// scrolling applied: as wide as the platform draws it, as tall as its
    /// line. Empty when the platform could not place it.
    pub bounds: Bounds<Points>,
    /// The caret in its root view's coordinates (the surface, or the dialog
    /// around the input), as of the event:
    /// [`crate::overlay::OverlayAnchor::Bounds`] places an overlay against it.
    pub page_bounds: Bounds<Points>,
}

/// An input method's composition in an input (`on_composition_change`):
/// the text being composed (pinyin before a character is chosen, kana
/// before conversion), not yet the input's text.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct Composition {
    /// A composition is in progress.
    pub composing: bool,
    /// The text being composed, empty once the composition ends.
    pub text: String,
}

/// Where a web view is (`on_navigation_state_change`, `on_load`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WebNavigation {
    /// The page's URL.
    pub url: String,
    /// Its title.
    pub title: String,
    /// Still loading.
    pub loading: bool,
    /// `go_back` would do something.
    pub can_go_back: bool,
    /// `go_forward` would do something.
    pub can_go_forward: bool,
}

/// A video loaded (`on_load`): its length in seconds and size in pixels.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct VideoInfo {
    /// Seconds.
    pub duration: f32,
    /// Its frames' size in pixels, as decoded (GPUI's images' sizes are
    /// [`DevicePixels`] too).
    pub size: Size<DevicePixels>,
}

/// A video played on (`on_progress`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct VideoProgress {
    /// Seconds played.
    pub current_time: f32,
    /// Seconds in all.
    pub duration: f32,
}

/// An image's download went on (`Image::on_progress`): bytes so far and in
/// all (0 when the server does not say).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ImageProgress {
    /// Bytes loaded.
    pub loaded: f64,
    /// Bytes in all, 0 when unknown.
    pub total: f64,
}

/// An event of a registered native component (`on_native_event`).
#[derive(Debug, Clone, PartialEq)]
pub struct NativeEvent {
    /// Its name (`regionChange`).
    pub name: Arc<str>,
    /// Its data.
    pub data: JsonValue,
}

/// Where the core placed an overlay (`Overlay::on_position`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct OverlayPosition {
    /// The side of the anchor it went on.
    pub placement: crate::overlay::Placement,
    /// Its frame in the root view.
    pub bounds: Bounds<Points>,
    /// The room on that side, inside the safe area less the margin.
    pub available: Size<Points>,
}

/// A field of a map payload.
fn field<'a>(payload: &'a EventPayload, key: &str) -> Option<&'a PayloadValue> {
    match payload {
        EventPayload::Map(entries) => entries.iter().find(|(k, _)| *k == key).map(|(_, v)| v),
        _ => None,
    }
}

fn number(payload: &EventPayload, key: &str) -> f32 {
    match field(payload, key) {
        Some(PayloadValue::Number(n)) => *n as f32,
        _ => 0.0,
    }
}

fn flag(payload: &EventPayload, key: &str) -> bool {
    matches!(field(payload, key), Some(PayloadValue::Bool(true)))
}

fn string<'a>(payload: &'a EventPayload, key: &str) -> Option<&'a str> {
    match field(payload, key) {
        Some(PayloadValue::Str(s)) => Some(s),
        _ => None,
    }
}

fn point_field(payload: &EventPayload, key: &str) -> Point<Points> {
    match field(payload, key) {
        Some(PayloadValue::Point(p)) => *p,
        _ => Point::default(),
    }
}

fn size_field(payload: &EventPayload, key: &str) -> Size<Points> {
    match field(payload, key) {
        Some(PayloadValue::Size(s)) => *s,
        _ => Size::default(),
    }
}

fn bounds_field(payload: &EventPayload, key: &str) -> Bounds<Points> {
    match field(payload, key) {
        Some(PayloadValue::Bounds(b)) => *b,
        _ => Bounds::default(),
    }
}

/// How a typed event comes out of a payload (`None`: not this event's).
pub(crate) type Decode<T> = for<'a> fn(&'a EventPayload) -> Option<Cow<'a, T>>;

/// `listener` as a listener of raw payloads: it runs with what `decode`
/// makes of each payload.
pub(crate) fn typed<T: ?Sized + ToOwned + 'static>(
    listener: Listener<T>,
    decode: Decode<T>,
) -> Listener<EventPayload> {
    listener.wrap(move |inner, payload: &EventPayload| {
        if let Some(value) = decode(payload) {
            inner(&value);
        }
    })
}

/// Events without data.
pub(crate) fn unit(_: &EventPayload) -> Option<Cow<'_, ()>> {
    Some(Cow::Owned(()))
}

pub(crate) fn overlay_position(p: &EventPayload) -> Option<Cow<'_, OverlayPosition>> {
    use crate::overlay::Placement;
    let placement = match string(p, "placement")? {
        "top" => Placement::Top,
        "left" => Placement::Left,
        "right" => Placement::Right,
        _ => Placement::Bottom,
    };
    Some(Cow::Owned(OverlayPosition {
        placement,
        bounds: bounds_field(p, "bounds"),
        available: size_field(p, "available"),
    }))
}

/// Where a press went down, in the root view (`Overlay::on_press_outside`).
pub(crate) fn page_point(p: &EventPayload) -> Option<Cow<'_, Point<Points>>> {
    Some(Cow::Owned(point_field(p, "pagePosition")))
}

pub(crate) fn layout(p: &EventPayload) -> Option<Cow<'_, Bounds<Points>>> {
    match *p {
        EventPayload::Layout(frame) => Some(Cow::Owned(frame)),
        _ => None,
    }
}

pub(crate) fn text(p: &EventPayload) -> Option<Cow<'_, str>> {
    match p {
        EventPayload::Text { text, .. } => Some(Cow::Borrowed(text)),
        _ => None,
    }
}

pub(crate) fn key(p: &EventPayload) -> Option<Cow<'_, str>> {
    string(p, "key").map(Cow::Borrowed)
}

pub(crate) fn action(p: &EventPayload) -> Option<Cow<'_, str>> {
    string(p, "actionName").map(Cow::Borrowed)
}

pub(crate) fn message(p: &EventPayload) -> Option<Cow<'_, str>> {
    match p {
        EventPayload::Error { message } => Some(Cow::Borrowed(message)),
        _ => string(p, "message").map(Cow::Borrowed),
    }
}

pub(crate) fn data(p: &EventPayload) -> Option<Cow<'_, str>> {
    string(p, "data").map(Cow::Borrowed)
}

pub(crate) fn selection(p: &EventPayload) -> Option<Cow<'_, Selection>> {
    Some(Cow::Owned(Selection {
        start: number(p, "start") as u32,
        end: number(p, "end") as u32,
    }))
}

pub(crate) fn paste(p: &EventPayload) -> Option<Cow<'_, crate::PasteEvent>> {
    match p {
        EventPayload::Paste(paste) => Some(Cow::Borrowed(paste)),
        _ => None,
    }
}

pub(crate) fn caret(p: &EventPayload) -> Option<Cow<'_, CaretEvent>> {
    Some(Cow::Owned(CaretEvent {
        bounds: bounds_field(p, "bounds"),
        page_bounds: bounds_field(p, "pageBounds"),
    }))
}

pub(crate) fn composition(p: &EventPayload) -> Option<Cow<'_, Composition>> {
    Some(Cow::Owned(Composition {
        composing: flag(p, "composing"),
        text: string(p, "text").unwrap_or_default().to_owned(),
    }))
}

pub(crate) fn size(p: &EventPayload) -> Option<Cow<'_, Size<Points>>> {
    Some(Cow::Owned(crate::geometry::size_pt(
        number(p, "width"),
        number(p, "height"),
    )))
}

/// An image's own size, in pixels.
pub(crate) fn pixel_size(p: &EventPayload) -> Option<Cow<'_, Size<DevicePixels>>> {
    Some(Cow::Owned(match *p {
        EventPayload::Image(size) => size,
        _ => Size::new(
            DevicePixels(number(p, "width").round() as i32),
            DevicePixels(number(p, "height").round() as i32),
        ),
    }))
}

pub(crate) fn scroll(p: &EventPayload) -> Option<Cow<'_, ScrollEvent>> {
    Some(Cow::Owned(match *p {
        EventPayload::Scroll(offset) => ScrollEvent {
            offset,
            ..ScrollEvent::default()
        },
        _ => ScrollEvent {
            offset: point_field(p, "offset"),
            content_size: size_field(p, "contentSize"),
            size: size_field(p, "size"),
            zoom_scale: match field(p, "zoomScale") {
                Some(PayloadValue::Number(n)) => *n as f32,
                _ => 1.0,
            },
        },
    }))
}

pub(crate) fn scroll_intent(p: &EventPayload) -> Option<Cow<'_, ScrollIntent>> {
    Some(Cow::Owned(match string(p, "intent")? {
        "start" => ScrollIntent::Start,
        "end" => ScrollIntent::End,
        "scroll" => ScrollIntent::Scroll,
        _ => return None,
    }))
}

pub(crate) fn offset(p: &EventPayload) -> Option<Cow<'_, Point<Points>>> {
    Some(Cow::Owned(match *p {
        EventPayload::Scroll(offset) => offset,
        _ => point_field(p, "offset"),
    }))
}

pub(crate) fn pan(p: &EventPayload) -> Option<Cow<'_, PanEvent>> {
    match *p {
        EventPayload::Pan {
            translation,
            velocity_x,
            velocity_y,
            value_x,
            value_y,
        }
        | EventPayload::PanCancelled {
            translation,
            velocity_x,
            velocity_y,
            value_x,
            value_y,
        } => Some(Cow::Owned(PanEvent {
            cancelled: matches!(p, EventPayload::PanCancelled { .. }),
            translation,
            velocity_x,
            velocity_y,
            value_x: value_x.map(|v| v.0),
            value_y: value_y.map(|v| v.0),
        })),
        _ => None,
    }
}

pub(crate) fn pinch(p: &EventPayload) -> Option<Cow<'_, GestureEvent>> {
    Some(Cow::Owned(GestureEvent {
        value: number(p, "scale"),
        velocity: number(p, "velocity"),
    }))
}

pub(crate) fn rotation(p: &EventPayload) -> Option<Cow<'_, GestureEvent<Radians>>> {
    Some(Cow::Owned(GestureEvent {
        value: Radians(number(p, "rotation")),
        velocity: number(p, "velocity"),
    }))
}

pub(crate) fn touch(p: &EventPayload) -> Option<Cow<'_, TouchEvent>> {
    match p {
        EventPayload::Touch(touch) => Some(Cow::Borrowed(touch)),
        _ => None,
    }
}

pub(crate) fn navigation(p: &EventPayload) -> Option<Cow<'_, WebNavigation>> {
    Some(Cow::Owned(WebNavigation {
        url: string(p, "url").unwrap_or_default().to_owned(),
        title: string(p, "title").unwrap_or_default().to_owned(),
        loading: flag(p, "loading"),
        can_go_back: flag(p, "canGoBack"),
        can_go_forward: flag(p, "canGoForward"),
    }))
}

pub(crate) fn video(p: &EventPayload) -> Option<Cow<'_, VideoInfo>> {
    Some(Cow::Owned(VideoInfo {
        duration: number(p, "duration"),
        size: Size::new(
            DevicePixels(number(p, "width").round() as i32),
            DevicePixels(number(p, "height").round() as i32),
        ),
    }))
}

pub(crate) fn progress(p: &EventPayload) -> Option<Cow<'_, VideoProgress>> {
    Some(Cow::Owned(VideoProgress {
        current_time: number(p, "currentTime"),
        duration: number(p, "duration"),
    }))
}

pub(crate) fn image_progress(p: &EventPayload) -> Option<Cow<'_, ImageProgress>> {
    let number = |key| match field(p, key) {
        Some(PayloadValue::Number(n)) => *n,
        _ => 0.0,
    };
    Some(Cow::Owned(ImageProgress {
        loaded: number("loaded"),
        total: number("total"),
    }))
}

pub(crate) fn buffering(p: &EventPayload) -> Option<Cow<'_, bool>> {
    Some(Cow::Owned(flag(p, "isBuffering")))
}

pub(crate) fn native(p: &EventPayload) -> Option<Cow<'_, NativeEvent>> {
    match p {
        EventPayload::Native { name, data } => Some(Cow::Owned(NativeEvent {
            name: name.clone(),
            data: data.clone(),
        })),
        _ => None,
    }
}

/// `onMouseEnter`, `onMouseMove` and `onMouseLeave`'s payload; an event
/// sent without one (an embedder's, a script's) still reaches the
/// listener, at no known position.
pub(crate) fn mouse(p: &EventPayload) -> Option<Cow<'_, MouseEvent>> {
    match p {
        EventPayload::Mouse(e) => Some(Cow::Borrowed(e)),
        _ => Some(Cow::Owned(MouseEvent::default())),
    }
}

pub(crate) fn context_menu(p: &EventPayload) -> Option<Cow<'_, ContextMenuEvent>> {
    match p {
        EventPayload::ContextMenu(e) => Some(Cow::Borrowed(e)),
        _ => None,
    }
}

pub(crate) fn file_drop(p: &EventPayload) -> Option<Cow<'_, FileDropEvent>> {
    match p {
        EventPayload::FileDrop(uris) => Some(Cow::Owned(FileDropEvent {
            uris: uris.clone(),
            page_position: None,
        })),
        EventPayload::FileDropAt {
            uris,
            page_position,
        } => Some(Cow::Owned(FileDropEvent {
            uris: uris.clone(),
            page_position: Some(*page_position),
        })),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_cancelled_pan_preserves_its_final_values() {
        use crate::{EventPayload, Points, geometry::point};
        let payload = EventPayload::PanCancelled {
            translation: point(Points(4.0), Points(150.0)),
            velocity_x: 0.0,
            velocity_y: 900.0,
            value_x: None,
            value_y: Some(Points(150.0)),
        };
        let event = super::pan(&payload).unwrap();
        assert!(event.cancelled);
        assert_eq!(event.translation, point(Points(4.0), Points(150.0)));
        assert_eq!(event.value_y, Some(150.0));
        assert_eq!(event.velocity_y, 900.0);
    }

    #[test]
    fn file_drop_requires_the_file_payload() {
        assert!(super::file_drop(&crate::EventPayload::None).is_none());
        let uris = vec!["file:///tmp/a%20b".into(), "file:///tmp/empty/".into()];
        assert_eq!(
            super::file_drop(&crate::EventPayload::FileDrop(uris.clone()))
                .unwrap()
                .uris,
            uris
        );
    }

    #[test]
    fn composition_reads_its_state_and_text() {
        use crate::{EventPayload, PayloadValue};
        let composing = EventPayload::Map(vec![
            ("composing", PayloadValue::Bool(true)),
            ("text", PayloadValue::Str("teng".into())),
        ]);
        let c = super::composition(&composing).unwrap();
        assert!(c.composing);
        assert_eq!(c.text, "teng");
        let ended = EventPayload::Map(vec![
            ("composing", PayloadValue::Bool(false)),
            ("text", PayloadValue::Str(String::new())),
        ]);
        assert_eq!(
            super::composition(&ended).unwrap().into_owned(),
            super::Composition::default()
        );
    }
}
