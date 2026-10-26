//! The platform's services for components, modules and tasks beyond
//! dialogs and the keyboard: screen reader announcements, the
//! clipboard, image information, display frames and the layout direction
//! ([`super::ambient`]'s functions, [`super::ModuleCx`]). Each is an
//! [`Action`] the core applies in order with the component's other changes.

use std::{
    future::Future,
    pin::Pin,
    task::{Context as TaskContext, Poll},
};

use super::{
    Answer, ImageSize,
    task::{Action, AnswerSlot, ClipboardImage, ClipboardRead},
};
use crate::{
    Command, ROOT_ID,
    platform::{HttpHead, HttpRequest},
    time::Instant,
};

/// Whether an image loaded ahead ([`super::ambient::prefetch_image`]): true
/// once its bytes are in memory.
#[must_use = "an answer does nothing unless awaited"]
#[derive(Debug)]
pub struct Prefetch(Answer<Result<ImageSize, String>>);

impl Future for Prefetch {
    type Output = bool;

    fn poll(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<bool> {
        Pin::new(&mut self.0).poll(cx).map(|size| size.is_ok())
    }
}

/// The response to a [`super::ambient::fetch`]: its status line, headers
/// and whole body.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HttpResponse {
    /// The status, final URL and headers.
    pub head: HttpHead,
    /// The body.
    pub body: Vec<u8>,
}

impl HttpResponse {
    /// The status code.
    pub fn status(&self) -> u16 {
        self.head.status
    }

    /// Whether the status is a success (200–299).
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.head.status)
    }

    /// The first header named `name` (case-insensitively).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.head
            .headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// The body as text (UTF-8; invalid sequences become U+FFFD).
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// A request in flight ([`super::ambient::fetch`]): awaited, its response,
/// or why there is none (the network failed, or the app's capabilities do
/// not grant the host).
#[must_use = "a request does nothing unless awaited"]
#[derive(Debug)]
pub struct Fetch(pub(crate) Answer<Result<HttpResponse, String>>);

impl Future for Fetch {
    type Output = Result<HttpResponse, String>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.0).poll(cx)
    }
}

/// Makes `request` through the engine's network stack.
pub(crate) fn fetch(request: HttpRequest) -> (Fetch, Action) {
    let (answer, slot) = Answer::new();
    (Fetch(answer), Action::Fetch(Box::new(request), slot))
}

/// The screen reader reads `message`.
pub(crate) fn announce(message: String) -> Action {
    Action::Command(ROOT_ID, Command::Announce(message))
}

/// Puts `text` on the system clipboard.
pub(crate) fn set_clipboard(text: String) -> Action {
    Action::Command(ROOT_ID, Command::SetClipboard(text))
}

/// The text on the system clipboard (`""` when it holds none).
pub(crate) fn clipboard_string() -> (Answer<String>, Action) {
    let (answer, slot) = Answer::new();
    (answer, Action::ReadClipboard(ClipboardRead::Text(slot)))
}

/// Whether the system clipboard holds text (without reading it).
pub(crate) fn clipboard_has_string() -> (Answer<bool>, Action) {
    let (answer, slot) = Answer::new();
    (answer, Action::ReadClipboard(ClipboardRead::Has(slot)))
}

/// Puts the image of the `data:` URI `uri` on the system clipboard.
pub(crate) fn set_clipboard_image(uri: String) -> Action {
    Action::Command(ROOT_ID, Command::SetClipboardImage(uri))
}

/// The image on the system clipboard (`None` when it holds none).
pub(crate) fn clipboard_image() -> (Answer<Option<ClipboardImage>>, Action) {
    let (answer, slot) = Answer::new();
    (answer, Action::ReadClipboard(ClipboardRead::Image(slot)))
}

/// Whether the system clipboard holds an image (without reading it).
pub(crate) fn clipboard_has_image() -> (Answer<bool>, Action) {
    let (answer, slot) = Answer::new();
    (answer, Action::ReadClipboard(ClipboardRead::HasImage(slot)))
}

/// The `file:` URLs of the local files on the system clipboard.
pub(crate) fn clipboard_files() -> (Answer<Vec<String>>, Action) {
    let (answer, slot) = Answer::new();
    (answer, Action::ReadClipboard(ClipboardRead::Files(slot)))
}

/// The images the user picks in the system's picker (none when cancelled).
pub(crate) fn pick_images(
    request: crate::picker::PickRequest,
) -> (Answer<Vec<crate::picker::PickedFile>>, Action) {
    let (answer, slot) = Answer::new();
    (answer, Action::PickImages(request, slot))
}

/// Calls function `name` of the embedding app with `args` (`nsh/host`).
pub(crate) fn host_call(
    name: String,
    args: crate::JsonValue,
) -> (Answer<Result<crate::JsonValue, String>>, Action) {
    let (answer, slot) = Answer::new();
    (
        answer,
        Action::HostCall {
            name,
            args,
            answer: slot,
        },
    )
}

/// Opens `url` outside the app; the answer is whether it opened.
pub(crate) fn open_url(url: String) -> (Answer<bool>, Action) {
    let (answer, slot) = Answer::new();
    (answer, Action::OpenUrl(url, slot))
}

/// The size of the image at `uri`, its bytes loaded.
pub(crate) fn image_size(uri: String) -> (Answer<Result<ImageSize, String>>, Action) {
    let (answer, slot) = Answer::new();
    (answer, Action::ImageInfo(uri, slot))
}

/// Loads the image at `uri` ahead.
pub(crate) fn prefetch(uri: String) -> (Prefetch, Action) {
    let (answer, action) = image_size(uri);
    (Prefetch(answer), action)
}

/// The start of the next display frame.
pub(crate) fn frame() -> (Answer<Instant>, Action) {
    let (answer, slot): (_, AnswerSlot<Instant>) = Answer::new();
    (answer, Action::Frame(slot))
}
