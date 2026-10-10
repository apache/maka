/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! One file filling the Files face: its content read from the Host and
//! drawn by kind.
//!
//! - A text file (`file`, `diff`, `html`) is asked for whole with
//!   `read_text`; past 32 KiB the Host answers `too_large` and the first
//!   chunk is read instead, then Show more reads the next and Show all
//!   reads on to the end, up to [`TEXT_PREVIEW_CEILING`]. An HTML page of
//!   at most [`HTML_RENDER_MAX_BYTES`] is read on to its end at once: it
//!   renders only whole. The chunks are decoded as one UTF-8 text
//!   ([`Utf8Pieces`]): a chunk may end inside a character. The source shows
//!   in the kit's editor, readonly, with line numbers and the language the
//!   name or media type says; a diff in the kit's Diff, in the changes
//!   panel's inset box.
//! - A Markdown file and an HTML page ([`is_html`]) show rendered by the
//!   kit's text view, with a Rendered / Source toggle, Rendered at first.
//!   A page is parsed by the kit's HTML reader into the text view's blocks
//!   (headings, paragraphs, lists, tables, quotes, inline code, links,
//!   images, `<mark>`), its `<script>` and `<style>` left out, no CSS
//!   beyond image sizes: nothing runs in the window. A page past
//!   [`HTML_RENDER_MAX_BYTES`] (Desktop's bound) shows as source, the
//!   toggle off and a line saying why beside Open in Default App, where a
//!   browser runs it.
//! - In rendered text an image from a `data:` URL is decoded and drawn;
//!   any other address (a relative path, `file:`, the web) goes to GPUI's
//!   loader, which fetches over HTTP only, through the app's HTTP client,
//!   and the app has none: the image draws nothing (no height on a line of
//!   its own, a blank square of three-quarters of a line inside text) and
//!   nothing is read from the disk. A link opens only when it is a web or
//!   mail address ([`shared::links::external_link`], Desktop's rule); a `#fragment` does
//!   nothing, as the kit keeps no anchors to scroll to.
//! - An image is asked for with `read_binary` (most are past 32 KiB, and
//!   then read in chunks), its format told from its bytes, and drawn fitted
//!   to the face; a click shows it at its actual size, scrolling, and
//!   another fits it again.
//! - A PDF is not read: it opens in the default app or is saved.

use std::sync::Arc;

use gpui_kit::assets::IconName as AssetIcon;
use gpui_kit::component::button::Button;
use gpui_kit::component::diff::{Diff, DiffFile, DiffHunkSeparator, DiffState};
use gpui_kit::component::input::{Editor, EditorState};
use gpui_kit::component::scroll::Scrollbar;
use gpui_kit::component::text::{TextView, TextViewState};
use gpui_kit::component::{Disableable as _, Icon, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Image,
    ImageFormat, ImageSource, InteractiveElement as _, IntoElement, ObjectFit, ParentElement as _,
    Render, Role, ScrollHandle, SharedString, StatefulInteractiveElement as _, Styled as _,
    StyledImage as _, Task, TestSupportExt as _, Window, div, img, prelude::FluentBuilder as _,
    rems,
};
use host_protocol::{ArtifactKind, ArtifactProjection, ArtifactReadFailureReason};
use shared::copy::conversation::file_size;
use shared::copy::{Locale, files as copy};
use shared::links::follow_link;
use shared::rows::StatusLine;
use shared::theme::{
    ActiveMakaPalette as _, CODE_TEXT_REMS, RADIUS_SURFACE, quiet_button, segment, segmented_track,
};
use workspace::HostSession;

use crate::policy::{
    HTML_RENDER_MAX_BYTES, IMAGE_PREVIEW_MAX_BYTES, ImageType, TEXT_PREVIEW_CEILING, Utf8Pieces,
    is_html, is_markdown, is_office_document, looks_binary, renderable_html, source_language,
};
use crate::read::{self, ReadFailure};
use crate::{IMAGE_CONTEXT, ToggleImageSize};

/// What the preview asks its owner to do: the actions its own lines
/// offer, which the owner runs as its menu does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum PreviewEvent {
    SaveAs,
    OpenInDefaultApp,
}

/// What the preview shows.
#[non_exhaustive]
pub enum Body {
    Loading,
    Text(Box<TextBody>),
    Image(ImageBody),
    /// A PDF: no preview, its actions.
    Pdf,
    /// A `file` whose bytes are not text.
    NotText,
    /// A kind this client does not know.
    UnknownKind,
    Failed(ReadFailure),
}

/// A text file, read whole or in part.
pub struct TextBody {
    pieces: Utf8Pieces,
    /// The decoded text, shared with the editor and the text view.
    text: SharedString,
    total: u64,
    /// Where the next chunk starts; `None` once the whole file is read.
    next: Option<u64>,
    reading: bool,
    /// Why the last Show more or Show all stopped.
    more_failure: Option<ReadFailure>,
    editor: Entity<EditorState>,
    /// The diff's files, when the text parses as one.
    diff: Option<Entity<DiffState>>,
    /// What the text renders as, when it is a kind that renders.
    format: Option<RichFormat>,
    /// The text parsed for the kit's text view, while it renders: a
    /// Markdown file always, an HTML page when it is whole and at most
    /// [`HTML_RENDER_MAX_BYTES`].
    rich: Option<Entity<TextViewState>>,
    /// Whether Rendered is chosen; it starts so where the text renders.
    rendered: bool,
}

/// How a text file renders.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RichFormat {
    Markdown,
    Html,
}

impl RichFormat {
    /// An HTML page renders as one (whatever its name says), a Markdown
    /// file as Markdown.
    fn of(artifact: &ArtifactProjection) -> Option<Self> {
        if is_html(artifact) {
            Some(Self::Html)
        } else if is_markdown(artifact) {
            Some(Self::Markdown)
        } else {
            None
        }
    }

    /// Whether a text of `total` bytes renders: Markdown as far as it is
    /// read, an HTML page only whole and at most [`HTML_RENDER_MAX_BYTES`].
    fn renders(self, complete: bool, total: u64) -> bool {
        match self {
            Self::Markdown => true,
            Self::Html => complete && total <= HTML_RENDER_MAX_BYTES,
        }
    }
}

impl std::fmt::Debug for Body {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Loading => f.write_str("Loading"),
            Self::Text(text) => f.debug_tuple("Text").field(text).finish(),
            Self::Image(image) => f.debug_tuple("Image").field(image).finish(),
            Self::Pdf => f.write_str("Pdf"),
            Self::NotText => f.write_str("NotText"),
            Self::UnknownKind => f.write_str("UnknownKind"),
            Self::Failed(failure) => f.debug_tuple("Failed").field(failure).finish(),
        }
    }
}

impl std::fmt::Debug for TextBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TextBody")
            .field("read", &self.pieces.byte_count())
            .field("total", &self.total)
            .field("next", &self.next)
            .field("reading", &self.reading)
            .field("more_failure", &self.more_failure)
            .field("diff", &self.diff.is_some())
            .field("format", &self.format)
            .field("rendered", &self.is_rendered())
            .finish_non_exhaustive()
    }
}

impl TextBody {
    pub fn text(&self) -> &SharedString {
        &self.text
    }

    /// Whether the whole file is read.
    pub fn is_complete(&self) -> bool {
        self.next.is_none()
    }

    pub fn is_rendered(&self) -> bool {
        self.rich.is_some() && self.rendered
    }

    /// Whether the text can show rendered: the Rendered / Source toggle is
    /// enabled.
    pub fn is_renderable(&self) -> bool {
        self.rich.is_some()
    }

    /// The text the rendered view draws, as of its last parse; `None` where
    /// the text does not render.
    pub fn rendered_text(&self, cx: &App) -> Option<String> {
        self.rich.as_ref().map(|rich| rich.read(cx).rendered_text().as_str().to_owned())
    }

    pub fn has_diff(&self) -> bool {
        self.diff.is_some()
    }

    /// The bytes read so far.
    pub fn read_bytes(&self) -> u64 {
        self.pieces.byte_count()
    }

    pub fn editor(&self) -> &Entity<EditorState> {
        &self.editor
    }

    fn at_ceiling(&self) -> bool {
        self.next.is_some() && self.pieces.byte_count() >= TEXT_PREVIEW_CEILING
    }
}

/// An image's bytes and how it shows.
pub struct ImageBody {
    bytes: Arc<[u8]>,
    kind: Option<ImageType>,
    image: Option<Arc<Image>>,
    actual_size: bool,
}

impl std::fmt::Debug for ImageBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImageBody")
            .field("bytes", &self.bytes.len())
            .field("kind", &self.kind)
            .field("actual_size", &self.actual_size)
            .finish_non_exhaustive()
    }
}

impl ImageBody {
    pub fn kind(&self) -> Option<ImageType> {
        self.kind
    }

    pub fn bytes(&self) -> &Arc<[u8]> {
        &self.bytes
    }

    pub fn is_actual_size(&self) -> bool {
        self.actual_size
    }
}

/// One file's preview. Behavior owner for reading the file and for the
/// view each kind takes; its owner ([`crate::FilesView`]) draws the header
/// and runs the actions.
pub struct ArtifactPreview {
    host: Entity<HostSession>,
    artifact: ArtifactProjection,
    body: Body,
    /// The body's region: a Tab stop, and where focus goes as the preview
    /// opens.
    focus: FocusHandle,
    scroll: ScrollHandle,
    _read: Option<Task<()>>,
}

impl EventEmitter<PreviewEvent> for ArtifactPreview {}

impl std::fmt::Debug for ArtifactPreview {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ArtifactPreview")
            .field("artifact", &self.artifact.id)
            .finish_non_exhaustive()
    }
}

impl ArtifactPreview {
    pub fn new(
        host: Entity<HostSession>,
        artifact: ArtifactProjection,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut this = Self {
            host,
            artifact,
            body: Body::Loading,
            focus: cx.focus_handle().tab_stop(true),
            scroll: ScrollHandle::new(),
            _read: None,
        };
        this.read(window, cx);
        this
    }

    pub fn artifact(&self) -> &ArtifactProjection {
        &self.artifact
    }

    pub fn body(&self) -> &Body {
        &self.body
    }

    pub fn focus_handle(&self) -> &FocusHandle {
        &self.focus
    }

    /// The whole text, when it is read and is text.
    pub fn complete_text(&self) -> Option<SharedString> {
        match &self.body {
            Body::Text(text) if text.is_complete() => Some(text.text.clone()),
            _ => None,
        }
    }

    /// The image's bytes and format, once read.
    pub fn image(&self) -> Option<(Arc<[u8]>, Option<ImageType>)> {
        match &self.body {
            Body::Image(image) => Some((image.bytes.clone(), image.kind)),
            _ => None,
        }
    }

    /// Reads the file again from its start.
    pub fn retry(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.read(window, cx);
    }

    fn read(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let artifact = &self.artifact;
        match artifact.kind {
            ArtifactKind::Pdf => {
                self.body = Body::Pdf;
                cx.notify();
                return;
            }
            ArtifactKind::File if is_office_document(&artifact.name) => {
                self.body = Body::NotText;
                cx.notify();
                return;
            }
            ArtifactKind::File | ArtifactKind::Diff | ArtifactKind::Html | ArtifactKind::Image => {}
            _ => {
                self.body = Body::UnknownKind;
                cx.notify();
                return;
            }
        }
        self.body = Body::Loading;
        cx.notify();
        let requester = self.host.read(cx).requester();
        let (session, id) = (artifact.session_id.clone(), artifact.id.clone());
        let page = is_html(artifact);
        if artifact.kind == ArtifactKind::Image {
            if artifact.size_bytes > IMAGE_PREVIEW_MAX_BYTES {
                self.body =
                    Body::Failed(ReadFailure::Unavailable(ArtifactReadFailureReason::TooLarge));
                cx.notify();
                return;
            }
            self._read = Some(cx.spawn(async move |this, cx| {
                let bytes = match read::binary(&requester, &session, &id).await {
                    Err(ReadFailure::Unavailable(ArtifactReadFailureReason::TooLarge)) => {
                        read::all(&requester, &session, &id, Some(IMAGE_PREVIEW_MAX_BYTES)).await
                    }
                    other => other,
                };
                this.update(cx, |this, cx| this.show_image(bytes, cx)).ok();
            }));
            return;
        }
        self._read = Some(cx.spawn_in(window, async move |this, cx| {
            let start = match read::text(&requester, &session, &id).await {
                Ok(text) => Ok(Start::Whole(text)),
                Err(ReadFailure::Unavailable(ArtifactReadFailureReason::TooLarge)) => {
                    match read::chunk(&requester, &session, &id, 0).await {
                        // A page that renders renders whole, so it is read
                        // whole: by the size the Host gives now, not the
                        // list's.
                        Ok(first) if page && first.total <= HTML_RENDER_MAX_BYTES => {
                            read::rest(&requester, &session, &id, first).await.map(Start::Chunk)
                        }
                        first => first.map(Start::Chunk),
                    }
                }
                Err(failure) => Err(failure),
            };
            this.update_in(cx, |this, window, cx| this.show_text(start, window, cx)).ok();
        }));
    }

    fn show_image(&mut self, bytes: Result<Vec<u8>, ReadFailure>, cx: &mut Context<Self>) {
        self._read = None;
        self.body = match bytes {
            Ok(bytes) => {
                let kind = ImageType::sniff(&bytes);
                let image = kind
                    .and_then(gpui_format)
                    .map(|format| Arc::new(Image::from_bytes(format, bytes.clone())));
                Body::Image(ImageBody { bytes: bytes.into(), kind, image, actual_size: false })
            }
            Err(failure) => Body::Failed(failure),
        };
        cx.notify();
    }

    fn show_text(
        &mut self,
        start: Result<Start, ReadFailure>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self._read = None;
        let (pieces, total, next) = match start {
            Ok(Start::Whole(text)) => {
                let total = text.len() as u64;
                (Utf8Pieces::whole(text), total, None)
            }
            Ok(Start::Chunk(chunk)) => {
                let mut pieces = Utf8Pieces::new();
                pieces.push(&chunk.bytes);
                if chunk.next.is_none() {
                    pieces.finish();
                }
                (pieces, chunk.total, chunk.next)
            }
            Err(failure) => {
                self.body = Body::Failed(failure);
                cx.notify();
                return;
            }
        };
        if self.artifact.kind == ArtifactKind::File && looks_binary(pieces.text()) {
            self.body = Body::NotText;
            cx.notify();
            return;
        }
        let text: SharedString = pieces.text().to_owned().into();
        let language = source_language(&self.artifact);
        let editor = cx.new(|cx| {
            let mut editor = EditorState::new(window, cx)
                .language(language.unwrap_or("text"))
                .default_value(text.clone());
            editor.set_readonly(true, cx);
            editor
        });
        let format = RichFormat::of(&self.artifact);
        let rich = format
            .filter(|format| format.renders(next.is_none(), total))
            .map(|format| rich_state(format, &text, cx));
        let mut body = TextBody {
            pieces,
            text,
            total,
            next,
            reading: false,
            more_failure: None,
            editor,
            diff: None,
            format,
            rendered: rich.is_some(),
            rich,
        };
        if self.artifact.kind == ArtifactKind::Diff {
            body.diff = parse_diff(&body.text, body.next.is_none(), cx);
        }
        self.body = Body::Text(Box::new(body));
        cx.notify();
    }

    /// Reads the next chunk of a text file read in part.
    pub fn show_more(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.read_more(false, window, cx);
    }

    /// Reads a text file read in part on to its end (or the preview's
    /// ceiling).
    pub fn show_all(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.read_more(true, window, cx);
    }

    fn read_more(&mut self, to_end: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Body::Text(body) = &mut self.body else { return };
        let Some(offset) = body.next else { return };
        if body.reading || body.at_ceiling() {
            return;
        }
        body.reading = true;
        body.more_failure = None;
        let total = body.total;
        let mut budget = TEXT_PREVIEW_CEILING.saturating_sub(body.pieces.byte_count());
        let requester = self.host.read(cx).requester();
        let (session, id) = (self.artifact.session_id.clone(), self.artifact.id.clone());
        self._read = Some(cx.spawn_in(window, async move |this, cx| {
            let mut bytes = Vec::new();
            let mut next = Some(offset);
            let mut failure = None;
            while let Some(at) = next {
                match read::chunk(&requester, &session, &id, at).await {
                    Ok(chunk) if chunk.total != total => {
                        failure = Some(ReadFailure::Changed);
                        break;
                    }
                    Ok(chunk) => {
                        budget = budget.saturating_sub(chunk.bytes.len() as u64);
                        bytes.extend_from_slice(&chunk.bytes);
                        next = chunk.next;
                        if !to_end || budget == 0 {
                            break;
                        }
                    }
                    Err(error) => {
                        failure = Some(error);
                        break;
                    }
                }
            }
            this.update_in(cx, |this, window, cx| {
                this.append(bytes, next, failure, window, cx);
            })
            .ok();
        }));
        cx.notify();
    }

    fn append(
        &mut self,
        bytes: Vec<u8>,
        next: Option<u64>,
        failure: Option<ReadFailure>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self._read = None;
        let Body::Text(body) = &mut self.body else { return };
        body.reading = false;
        body.more_failure = failure;
        if !bytes.is_empty() {
            body.pieces.push(&bytes);
            body.next = next;
            if next.is_none() {
                body.pieces.finish();
            }
            body.text = body.pieces.text().to_owned().into();
            let text = body.text.clone();
            if let Some(rich) = &body.rich {
                rich.update(cx, |rich, cx| rich.set_text(&text, cx));
            }
            body.editor.update(cx, |editor, cx| {
                // The person keeps their place in what they were reading.
                let offset = editor.scroll_offset();
                editor.set_value(text, window, cx);
                editor.set_scroll_offset(offset, cx);
            });
            if self.artifact.kind == ArtifactKind::Diff {
                let complete = body.next.is_none();
                let text = body.text.clone();
                body.diff = parse_diff(&text, complete, cx);
            }
        }
        cx.notify();
    }

    /// Shows a Markdown file or an HTML page rendered or as its source; a
    /// text that does not render stays source.
    pub fn set_rendered(&mut self, rendered: bool, cx: &mut Context<Self>) {
        if let Body::Text(body) = &mut self.body
            && body.rich.is_some()
            && body.rendered != rendered
        {
            body.rendered = rendered;
            cx.notify();
        }
    }

    /// Shows the image at its actual size, or fitted to the face again.
    pub fn toggle_image_size(&mut self, cx: &mut Context<Self>) {
        if let Body::Image(image) = &mut self.body {
            image.actual_size = !image.actual_size;
            cx.notify();
        }
    }

    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        self.focus.focus(window, cx);
    }

    // Rendering.

    fn render_text(&self, body: &TextBody, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let rendered = body.rich.as_ref().filter(|_| body.rendered).zip(body.format);
        let content = if let Some((rich, format)) = rendered {
            self.render_rich(format, rich, cx)
        } else if let Some(diff) = &body.diff {
            code_box(
                Diff::new(diff)
                    .soft_wrap(true)
                    .line_number(true)
                    .hunk_separator(DiffHunkSeparator::Simple)
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .border_0()
                    .bg(cx.maka().code)
                    .into_any_element(),
                cx,
            )
        } else {
            code_box(
                Editor::new(&body.editor)
                    .readonly(true)
                    .appearance(false)
                    .bordered(false)
                    .aria_label(copy::preview_named(locale, &self.artifact.name))
                    .size_full()
                    .text_size(rems(CODE_TEXT_REMS))
                    .into_any_element(),
                cx,
            )
        };
        v_flex()
            .id("files-text")
            .test_support()
            .track_focus(&self.focus)
            .size_full()
            .min_h_0()
            .when(body.format.is_some(), |this| this.child(self.render_mode_switch(body, cx)))
            .child(div().flex_1().min_h_0().w_full().child(content))
            .children(self.render_more(body, cx))
            .into_any_element()
    }

    /// A Markdown file or an HTML page rendered: one text view, its style
    /// the theme's (palette roles; a Markdown code block in syntax colours),
    /// on the face's 16 px line, scrolling in the preview.
    fn render_rich(
        &self,
        format: RichFormat,
        rich: &Entity<TextViewState>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let region = match format {
            RichFormat::Markdown => "files-markdown",
            RichFormat::Html => "files-html",
        };
        div()
            .relative()
            .size_full()
            .child(
                div()
                    .id(region)
                    .test_support()
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .px_4()
                    .py_3()
                    .child(
                        TextView::new(rich)
                            .selectable(true)
                            .on_link_click(|href, event, _, cx| follow_link(href, event, cx))
                            .w_full()
                            .text_sm()
                            .text_color(cx.maka().ink),
                    ),
            )
            .child(Scrollbar::vertical(&self.scroll))
            .into_any_element()
    }

    /// The Rendered / Source toggle over a Markdown file or an HTML page.
    /// Over a page too large to render it is off, Source chosen, with the
    /// line that says why and the way to see the page rendered.
    fn render_mode_switch(&self, body: &TextBody, cx: &mut Context<Self>) -> AnyElement {
        let renderable = body.is_renderable();
        let rendered = body.is_rendered();
        let side =
            |id: &'static str, label: &str, chosen: bool, to: bool, cx: &mut Context<Self>| {
                segment(
                    Button::new(id)
                        .disabled(!renderable)
                        .on_click(cx.listener(move |this, _, _, cx| this.set_rendered(to, cx))),
                    label,
                    chosen,
                    cx,
                )
            };
        let too_large = body.format == Some(RichFormat::Html) && body.total > HTML_RENDER_MAX_BYTES;
        let limit = too_large.then(|| {
            let locale = Locale::current(cx);
            let size = file_size(locale, HTML_RENDER_MAX_BYTES);
            let open = quiet_button(Button::new("files-render-open"), cx)
                .label(copy::OPEN_DEFAULT.get(cx))
                .on_click(cx.listener(|_, _, _, cx| cx.emit(PreviewEvent::OpenInDefaultApp)));
            StatusLine::info("files-render-limit", copy::render_limit(locale, &size)).action(open)
        });
        v_flex()
            .flex_none()
            .px_4()
            .pt_2()
            .pb_1()
            .gap_2()
            .child(
                h_flex().child(
                    segmented_track(cx)
                        .id("files-view-mode")
                        .test_support()
                        .role(Role::Group)
                        .aria_label(copy::VIEW_MODE.get(cx))
                        .w(rems(12.))
                        .child(side("files-rendered", copy::RENDERED.get(cx), rendered, true, cx))
                        .child(side("files-source", copy::SOURCE.get(cx), !rendered, false, cx)),
                ),
            )
            .children(limit)
            .into_any_element()
    }

    /// Under a text read in part: how much shows, Show more and Show all;
    /// at the ceiling, Save As; after a failed read, why and Retry.
    fn render_more(&self, body: &TextBody, cx: &mut Context<Self>) -> Option<AnyElement> {
        let locale = Locale::current(cx);
        if let Some(failure) = &body.more_failure {
            let retry = quiet_button(Button::new("files-more-retry"), cx)
                .label(copy::RETRY.get(cx))
                .on_click(cx.listener(|this, _, window, cx| this.show_more(window, cx)));
            return Some(
                div()
                    .flex_none()
                    .px_4()
                    .py_2()
                    .child(
                        StatusLine::error("files-more-failure", why(failure, locale)).action(retry),
                    )
                    .into_any_element(),
            );
        }
        if body.at_ceiling() {
            let size = file_size(locale, TEXT_PREVIEW_CEILING);
            let save = quiet_button(Button::new("files-ceiling-save"), cx)
                .label(copy::SAVE_AS.get(cx))
                .on_click(cx.listener(|_, _, _, cx| cx.emit(PreviewEvent::SaveAs)));
            return Some(
                div()
                    .flex_none()
                    .px_4()
                    .py_2()
                    .child(
                        StatusLine::info("files-ceiling", copy::preview_ceiling(locale, &size))
                            .action(save),
                    )
                    .into_any_element(),
            );
        }
        body.next?;
        let shown = copy::shown_of(
            locale,
            &file_size(locale, body.pieces.byte_count()),
            &file_size(locale, body.total),
        );
        let button = |id: &'static str, label: &str, cx: &mut Context<Self>| {
            quiet_button(Button::new(id), cx)
                .label(label.to_owned())
                .loading(body.reading)
                .disabled(body.reading)
        };
        let more = button("files-show-more", copy::SHOW_MORE.get(cx), cx)
            .on_click(cx.listener(|this, _, window, cx| this.show_more(window, cx)));
        let all = button("files-show-all", copy::SHOW_ALL.get(cx), cx)
            .on_click(cx.listener(|this, _, window, cx| this.show_all(window, cx)));
        Some(
            h_flex()
                .id("files-partial")
                .test_support()
                .flex_none()
                .px_4()
                .py_2()
                .gap_2()
                .border_t_1()
                .border_color(cx.maka().border_soft)
                .child(
                    div()
                        .id("files-shown")
                        .test_support()
                        .aria_label(shown.clone())
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_xs()
                        .text_color(cx.maka().ink_muted)
                        .child(shown),
                )
                .child(more)
                .child(all)
                .into_any_element(),
        )
    }

    fn render_image(&self, image: &ImageBody, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let Some(source) =
            image.image.clone().filter(|_| image.kind.is_some_and(ImageType::is_drawable))
        else {
            return self.render_line(copy::WHY_UNSUPPORTED, true, self.image_openable(image), cx);
        };
        let label = if image.actual_size { copy::IMAGE_ACTUAL } else { copy::IMAGE_FIT };
        let not_drawn: SharedString = copy::WHY_NOT_DRAWN.in_locale(locale).into();
        let fallback = move || {
            div()
                .p_4()
                .child(StatusLine::error("files-not-drawn", not_drawn.clone()))
                .into_any_element()
        };
        let picture = img(ImageSource::Image(source)).with_fallback(fallback);
        let area = div()
            .id("files-image")
            .test_support()
            .role(Role::Image)
            .aria_label(label.get(cx))
            .track_focus(&self.focus)
            .key_context(IMAGE_CONTEXT)
            .on_action(cx.listener(|this, _: &ToggleImageSize, _, cx| this.toggle_image_size(cx)))
            .on_click(cx.listener(|this, _, _, cx| this.toggle_image_size(cx)))
            .size_full();
        if image.actual_size {
            div()
                .relative()
                .size_full()
                .child(
                    area.overflow_scroll()
                        .track_scroll(&self.scroll)
                        .p_4()
                        .child(picture.flex_none()),
                )
                .child(Scrollbar::new(&self.scroll))
                .into_any_element()
        } else {
            area.p_4()
                .flex()
                .items_center()
                .justify_center()
                .child(picture.size_full().object_fit(ObjectFit::ScaleDown))
                .into_any_element()
        }
    }

    fn image_openable(&self, image: &ImageBody) -> bool {
        image.kind.is_some_and(ImageType::is_openable)
    }

    /// A line that says why nothing shows, with the actions that help.
    fn render_line(
        &self,
        text: shared::copy::Text,
        save: bool,
        open: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.render_why(text.get(cx).into(), None, save, open, cx)
    }

    fn render_why(
        &self,
        text: SharedString,
        failure: Option<&ReadFailure>,
        save: bool,
        open: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let retry = failure.is_some_and(retryable);
        let line = if failure.is_some() {
            StatusLine::error("files-why", text)
        } else {
            StatusLine::info("files-why", text)
        };
        v_flex()
            .id("files-body-line")
            .test_support()
            .track_focus(&self.focus)
            .w_full()
            .px_4()
            .py_6()
            .gap_3()
            .items_center()
            .child(line.centred())
            .child(
                h_flex()
                    .gap_2()
                    .when(retry, |this| {
                        this.child(
                            quiet_button(Button::new("files-retry"), cx)
                                .label(copy::RETRY.get(cx))
                                .on_click(
                                    cx.listener(|this, _, window, cx| this.retry(window, cx)),
                                ),
                        )
                    })
                    .when(open, |this| {
                        this.child(
                            quiet_button(Button::new("files-body-open"), cx)
                                .label(copy::OPEN_DEFAULT.get(cx))
                                .on_click(cx.listener(|_, _, _, cx| {
                                    cx.emit(PreviewEvent::OpenInDefaultApp)
                                })),
                        )
                    })
                    .when(save, |this| {
                        this.child(
                            quiet_button(Button::new("files-body-save"), cx)
                                .label(copy::SAVE_AS.get(cx))
                                .on_click(cx.listener(|_, _, _, cx| cx.emit(PreviewEvent::SaveAs))),
                        )
                    }),
            )
            .into_any_element()
    }
}

/// The text parsed for the kit's text view as `format`. Its parse runs on
/// the view's background parser.
fn rich_state(format: RichFormat, text: &str, cx: &mut App) -> Entity<TextViewState> {
    cx.new(|cx| match format {
        RichFormat::Markdown => TextViewState::markdown(text, cx),
        RichFormat::Html => TextViewState::html(&renderable_html(text), cx),
    })
}

/// How a text read began.
enum Start {
    Whole(String),
    Chunk(read::Chunk),
}

/// The kit's format for an image this window can draw.
fn gpui_format(kind: ImageType) -> Option<ImageFormat> {
    Some(match kind {
        ImageType::Png => ImageFormat::Png,
        ImageType::Jpeg => ImageFormat::Jpeg,
        ImageType::Gif => ImageFormat::Gif,
        ImageType::Webp => ImageFormat::Webp,
        ImageType::Bmp => ImageFormat::Bmp,
        ImageType::Tiff => ImageFormat::Tiff,
        ImageType::Ico => ImageFormat::Ico,
        ImageType::Svg => ImageFormat::Svg,
        ImageType::Avif | ImageType::Heic => return None,
    })
}

/// The diff's files, or `None` when the text is no diff the kit parses (it
/// then shows as source). A diff read in part ends inside a hunk: its
/// complete lines are cut once more at their own count, which re-heads the
/// last hunk to the lines it has (`shared::diff::bounded` cuts only a diff
/// longer than its budget, hence the line added before the cut).
fn parse_diff(text: &str, complete: bool, cx: &mut App) -> Option<Entity<DiffState>> {
    let parsed = if complete {
        DiffFile::parse(text)
    } else {
        let whole = text.rfind('\n').map_or("", |end| &text[..=end]);
        let lines = whole.lines().count();
        let cut = shared::diff::bounded(&format!("{whole}\n"), lines);
        DiffFile::parse(&cut.text)
    };
    let files = parsed.ok().filter(|files| !files.is_empty())?;
    Some(cx.new(|cx| DiffState::new(files, cx).with_context_lines(None)))
}

/// The changes panel's inset box (F31): the code fill, rounded, its
/// content 8 px in at the sides and the radius in above and below, 8 px in
/// from the face.
fn code_box(content: AnyElement, cx: &App) -> AnyElement {
    div()
        .size_full()
        .min_h_0()
        .p_2()
        .child(
            v_flex()
                .id("files-code-box")
                .test_support()
                .size_full()
                .min_w_0()
                .min_h_0()
                .rounded(RADIUS_SURFACE)
                .bg(cx.maka().code)
                .px_2()
                .py(RADIUS_SURFACE)
                .child(content),
        )
        .into_any_element()
}

/// Whether trying again could help.
pub(crate) fn retryable(failure: &ReadFailure) -> bool {
    !matches!(
        failure,
        ReadFailure::Unavailable(
            ArtifactReadFailureReason::NotFound
                | ArtifactReadFailureReason::NotAllowed
                | ArtifactReadFailureReason::TooLarge
                | ArtifactReadFailureReason::UnsupportedMime
        ) | ReadFailure::TooLarge
            | ReadFailure::Operation { code: host_protocol::HostOperationErrorCode::NotFound, .. }
    )
}

/// Whether a copy saved elsewhere is the way to the file.
fn saving_helps(failure: &ReadFailure) -> bool {
    matches!(
        failure,
        ReadFailure::Unavailable(
            ArtifactReadFailureReason::TooLarge | ArtifactReadFailureReason::UnsupportedMime
        ) | ReadFailure::TooLarge
    )
}

/// What a failure says to a person: what happened and what they can do.
pub(crate) fn why(failure: &ReadFailure, locale: Locale) -> String {
    use host_protocol::HostOperationErrorCode as Code;
    let text = match failure {
        ReadFailure::Unavailable(reason) => match reason {
            ArtifactReadFailureReason::NotFound => copy::WHY_NOT_FOUND,
            ArtifactReadFailureReason::TooLarge => copy::WHY_TOO_LARGE,
            ArtifactReadFailureReason::ReadFailed => copy::WHY_READ_FAILED,
            ArtifactReadFailureReason::NotAllowed => copy::WHY_NOT_ALLOWED,
            ArtifactReadFailureReason::UnsupportedMime => copy::WHY_UNSUPPORTED,
            _ => copy::WHY_UNEXPECTED,
        },
        ReadFailure::Operation { code, message } => match code {
            Code::NotFound => copy::WHY_NOT_FOUND,
            // An offset past the end: the file shrank under the read.
            Code::InvalidRequest => copy::WHY_CHANGED,
            Code::PersistenceFailed => copy::WHY_READ_FAILED,
            Code::OperationConflict => copy::WHY_PROTECTED,
            Code::HostNotReady | Code::HostDraining => copy::WHY_DISCONNECTED,
            _ => return copy::why_host(locale, message),
        },
        ReadFailure::NotConnected | ReadFailure::Transport(_) => copy::WHY_DISCONNECTED,
        ReadFailure::Unexpected => copy::WHY_UNEXPECTED,
        ReadFailure::Changed => copy::WHY_CHANGED,
        ReadFailure::TooLarge => copy::WHY_TOO_LARGE,
    };
    text.in_locale(locale).to_owned()
}

impl Render for ArtifactPreview {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let locale = Locale::current(cx);
        let content = match &self.body {
            Body::Loading => v_flex()
                .id("files-preview-loading")
                .test_support()
                .track_focus(&self.focus)
                .px_4()
                .py_6()
                .items_center()
                .child(StatusLine::info("files-loading", copy::LOADING.get(cx)).centred())
                .into_any_element(),
            Body::Text(body) => self.render_text(body, cx),
            Body::Image(image) => self.render_image(image, cx),
            Body::Pdf => self.render_line(copy::WHY_PDF, true, true, cx),
            Body::NotText => self.render_line(copy::WHY_NOT_TEXT, true, false, cx),
            Body::UnknownKind => self.render_line(copy::WHY_UNKNOWN_KIND, true, false, cx),
            Body::Failed(failure) => {
                let text = why(failure, locale).into();
                self.render_why(text, Some(failure), saving_helps(failure), false, cx)
            }
        };
        let body_icon = matches!(self.body, Body::Pdf | Body::NotText | Body::UnknownKind)
            || matches!(&self.body, Body::Image(image) if image.image.is_none());
        v_flex()
            .id("files-preview")
            .test_support()
            .role(Role::Region)
            .aria_label(copy::preview_named(locale, &self.artifact.name))
            .size_full()
            .min_h_0()
            .when(body_icon, |this| {
                this.child(
                    div()
                        .flex()
                        .justify_center()
                        .pt_6()
                        .child(Icon::new(AssetIcon::File).size_6().text_color(cx.maka().ink_muted)),
                )
            })
            .child(content)
    }
}
