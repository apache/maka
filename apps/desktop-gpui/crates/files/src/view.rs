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

//! The workbar's Files face: the selected task's files in a list with a
//! filter, and one file's preview filling the face, with its actions.
//!
//! The list is one Tab stop: Up and Down move the selection (wrapping),
//! Home and End jump to the ends, Enter or Space open the selected file,
//! Escape hands the panel back (Desktop's `artifact-list-keyboard.ts`). In
//! the filter, Enter opens the first match. In a preview, Escape and the
//! back button return to the list; the "⋯" menu holds Copy (text kinds
//! only: a binary never goes to the clipboard as base64, Desktop's gate 5),
//! Save As…, Open in Default App and Delete… (only what the Host lets a
//! person delete). Open in Default App takes PDFs, raster images and HTML
//! pages: a page goes to the browser on purpose, for the scripts and styles
//! the window leaves out, which the browser then runs as Desktop's frame
//! would, from a copy holding the page's bytes alone. Any other `file`, and
//! an SVG (an image whose default app may be a browser that runs it), could
//! run code it does not announce. There is no Show in Finder: the protocol
//! gives no path.

use std::rc::Rc;
use std::sync::Arc;

use gpui_kit::assets::IconName as AssetIcon;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::notification::Notification;
use gpui_kit::component::scroll::Scrollbar;
use gpui_kit::component::{
    Icon, Selectable as _, Sizable as _, StyledExt as _, ThemeStyled as _, VirtualListScrollHandle,
    WindowExt as _, h_flex, v_flex, v_virtual_list,
};
use gpui_kit::{
    AnyElement, App, AppContext as _, ClickEvent, ClipboardItem, Context, Entity, EventEmitter,
    FocusHandle, InteractiveElement as _, IntoElement, MouseButton, MouseDownEvent,
    ParentElement as _, Pixels, Render, Role, ScrollStrategy, SharedString, Size,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, TestSupportExt as _, Window,
    div, prelude::FluentBuilder as _, px, rems, size,
};
use host_protocol::{ArtifactKind, ArtifactProjection, HostOperationErrorCode};
use shared::copy::conversation::file_size;
use shared::copy::{self as shell_copy, Locale, files as copy};
use shared::dialog::{DialogHeader, DialogHeaderExt as _};
use shared::domain_element_id;
use shared::icons::MakaIcon;
use shared::menu::{MenuEntry, MenuItem, MenuPlacement, MenuSlot};
use shared::rows::StatusLine;
use shared::theme::{
    ActiveMakaPalette as _, FieldFill as _, RADIUS_CONTROL, floating_surface, quiet_button,
    row_icon_button, selectable_row,
};
use workspace::HostSession;

use crate::desk::{Desk, write_saved_copy, write_temp_copy};
use crate::list::{ArtifactList, ArtifactListEvent, ListLoad};
use crate::policy::{
    COPY_MAX_BYTES, ImageType, ListAction, ListKey, is_html, is_pdf, is_user_deletable,
    list_action, matches_filter, row_summary, safe_file_name,
};
use crate::preview::{ArtifactPreview, Body, PreviewEvent, why};
use crate::read::{self, ReadFailure};
use crate::{
    Back, FILES_CONTEXT, LIST_CONTEXT, OpenSelected, SelectFirst, SelectLast, SelectNext,
    SelectPrevious,
};

/// A row with a summary: two lines (14/20 and 12/20) and 6 px above and
/// below them; a row without one keeps the name's line.
const ROW_PADDING_REMS: f32 = 0.375;
const ROW_LINE_REMS: f32 = 1.25;
/// The "⋯" menu's least width.
const MENU_WIDTH_REMS: f32 = 13.;

/// Emitted by [`FilesView`].
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum FilesViewEvent {
    /// Escape in the list: the panel gives the conversation its place.
    Dismiss,
}

/// What an action ended with, as the toast said it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Notice {
    pub ok: bool,
    pub title: String,
    pub detail: Option<String>,
}

/// An action on the previewed file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileAction {
    Copy,
    Save,
    Open,
    Delete,
}

/// The rows the list draws: the visible files the filter keeps, by their
/// index among the visible ones, and the rows' sizes.
struct Rows {
    /// What the rows were worked out from: the visible files (by their
    /// list's version), the filter, and the rem.
    key: (u64, String, Pixels),
    indices: Rc<[usize]>,
    sizes: Rc<Vec<Size<Pixels>>>,
}

/// The Files face. Behavior owner for the list's selection, the filter,
/// the preview shown and the actions; [`ArtifactList`] owns the files and
/// their freshness, [`ArtifactPreview`] one file's content.
pub struct FilesView {
    list: Entity<ArtifactList>,
    filter: Entity<InputState>,
    list_focus: FocusHandle,
    /// The selected file, by id.
    selected: Option<SharedString>,
    scroll: VirtualListScrollHandle,
    rows: Option<Rows>,
    preview: Option<(Entity<ArtifactPreview>, Subscription)>,
    menu: MenuSlot,
    desk: Desk,
    /// The action under way; one at a time.
    action: Option<(FileAction, Task<()>)>,
    notice: Option<Notice>,
    /// The wall clock, read when the list changes, never in `render`.
    clock: Rc<dyn Fn() -> u64>,
    listed_at: (u64, i32),
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<FilesViewEvent> for FilesView {}

impl std::fmt::Debug for FilesView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FilesView")
            .field("selected", &self.selected)
            .field("previewing", &self.preview.is_some())
            .finish_non_exhaustive()
    }
}

impl FilesView {
    pub fn new(host: Entity<HostSession>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let list = cx.new(|cx| ArtifactList::new(host, cx));
        let locale = Locale::current(cx);
        let filter =
            cx.new(|cx| InputState::new(window, cx).placeholder(copy::FILTER.in_locale(locale)));
        let subscriptions =
            vec![
                cx.subscribe_in(&list, window, |this, _, _: &ArtifactListEvent, window, cx| {
                    this.follow_list(window, cx);
                }),
                cx.observe(&list, |_, _, cx| cx.notify()),
                cx.subscribe_in(&filter, window, |this, _, event: &InputEvent, window, cx| {
                    match event {
                        InputEvent::Change => {
                            this.keep_selection_in_filter(cx);
                            cx.notify();
                        }
                        InputEvent::PressEnter { .. } => {
                            if let Some(id) = this.shown_ids(cx).first().cloned() {
                                this.open_preview(&id, window, cx);
                            }
                        }
                        _ => {}
                    }
                }),
                cx.observe_global_in::<Locale>(window, |this, window, cx| {
                    let placeholder = copy::FILTER.get(cx).to_owned();
                    this.filter
                        .update(cx, |filter, cx| filter.set_placeholder(placeholder, window, cx));
                }),
            ];
        let clock: Rc<dyn Fn() -> u64> = Rc::new(now_ms);
        let listed_at = (clock(), shared::time::local_utc_offset());
        Self {
            list,
            filter,
            list_focus: cx.focus_handle().tab_stop(true),
            selected: None,
            scroll: VirtualListScrollHandle::new(),
            rows: None,
            preview: None,
            menu: MenuSlot::new(MenuPlacement::BelowEnd),
            desk: Desk::system(),
            action: None,
            notice: None,
            clock,
            listed_at,
            _subscriptions: subscriptions,
        }
    }

    // What the window tells it.

    /// Follows task `session_id`: another task's files, the list shown.
    pub fn set_session(&mut self, session_id: Option<SharedString>, cx: &mut Context<Self>) {
        if self.list.read(cx).session_id() == session_id.as_ref() {
            return;
        }
        self.preview = None;
        self.menu = MenuSlot::new(MenuPlacement::BelowEnd);
        self.selected = None;
        self.action = None;
        self.list.update(cx, |list, cx| list.set_session(session_id, cx));
        cx.notify();
    }

    /// Whether the face shows: its list is read and polled while it does.
    pub fn set_shown(&mut self, shown: bool, cx: &mut Context<Self>) {
        self.list.update(cx, |list, cx| list.set_shown(shown, cx));
    }

    /// Whether the window is active: polling pauses while it is not.
    pub fn set_window_active(&mut self, active: bool, cx: &mut Context<Self>) {
        self.list.update(cx, |list, cx| list.set_window_active(active, cx));
    }

    /// Reads the list again while the face shows: a turn settled, or a
    /// subagent wrote files back.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        self.list.update(cx, |list, cx| list.refresh(cx));
    }

    /// Saves and opens through `desk` instead of the platform (tests).
    pub fn set_desk(&mut self, desk: Desk) {
        self.desk = desk;
    }

    /// Reads the wall clock with `clock` (tests).
    pub fn set_clock(&mut self, clock: impl Fn() -> u64 + 'static) {
        self.clock = Rc::new(clock);
        self.listed_at.0 = (self.clock)();
    }

    // What it shows.

    pub fn list(&self) -> &Entity<ArtifactList> {
        &self.list
    }

    pub fn filter(&self) -> &Entity<InputState> {
        &self.filter
    }

    pub fn selected(&self) -> Option<&SharedString> {
        self.selected.as_ref()
    }

    /// The file previewed.
    pub fn preview(&self) -> Option<&Entity<ArtifactPreview>> {
        self.preview.as_ref().map(|(preview, _)| preview)
    }

    /// What the last action ended with.
    pub fn notice(&self) -> Option<&Notice> {
        self.notice.as_ref()
    }

    /// Whether an action on the previewed file is under way.
    pub fn is_busy(&self) -> bool {
        self.action.is_some()
    }

    /// The ids of the rows the list shows, in order.
    pub fn shown_ids(&self, cx: &App) -> Vec<SharedString> {
        let query = self.filter.read(cx).value();
        self.list
            .read(cx)
            .visible()
            .iter()
            .filter(|artifact| matches_filter(&artifact.name, &query))
            .map(|artifact| artifact.id.clone().into())
            .collect()
    }

    /// Gives the face the focus: the preview's body, else the list.
    pub fn focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let handle = match self.preview() {
            Some(preview) => preview.read(cx).focus_handle().clone(),
            None => self.list_focus.clone(),
        };
        handle.focus(window, cx);
    }

    // The list.

    fn find(&self, id: &str, cx: &App) -> Option<ArtifactProjection> {
        self.list.read(cx).visible().iter().find(|artifact| artifact.id == id).cloned()
    }

    /// The list moved on: the clock is read again, the selection stays on
    /// its file or goes to the first, and a preview whose file is gone
    /// closes.
    fn follow_list(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.listed_at = ((self.clock)(), shared::time::local_utc_offset());
        if let Some((preview, _)) = &self.preview {
            let id = preview.read(cx).artifact().id.clone();
            if self.find(&id, cx).is_none() {
                self.back(window, cx);
            }
        }
        self.keep_selection_in_filter(cx);
        cx.notify();
    }

    fn keep_selection_in_filter(&mut self, cx: &mut Context<Self>) {
        let ids = self.shown_ids(cx);
        let kept = self.selected.as_ref().is_some_and(|selected| ids.contains(selected));
        if !kept {
            self.selected = ids.first().cloned();
        }
    }

    fn press(&mut self, key: ListKey, window: &mut Window, cx: &mut Context<Self>) {
        let ids = self.shown_ids(cx);
        let refs: Vec<&str> = ids.iter().map(SharedString::as_ref).collect();
        match list_action(self.selected.as_deref(), &refs, key) {
            ListAction::Select(id) => {
                let id: SharedString = id.to_owned().into();
                if let Some(ix) = ids.iter().position(|candidate| *candidate == id) {
                    self.scroll.scroll_to_item(ix, ScrollStrategy::Nearest);
                }
                self.selected = Some(id);
                cx.notify();
            }
            ListAction::Activate(id) => {
                let id = id.to_owned();
                self.open_preview(&id, window, cx);
            }
            ListAction::Dismiss => cx.emit(FilesViewEvent::Dismiss),
            ListAction::None => {}
        }
    }

    /// Opens file `id` in the preview, which takes the focus.
    pub fn open_preview(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(artifact) = self.find(id, cx) else { return };
        self.selected = Some(id.to_owned().into());
        let host = self.list.read(cx).host().clone();
        let preview = cx.new(|cx| ArtifactPreview::new(host, artifact, window, cx));
        let subscription =
            cx.subscribe_in(&preview, window, |this, _, event: &PreviewEvent, window, cx| {
                match event {
                    PreviewEvent::SaveAs => this.save_as(window, cx),
                    PreviewEvent::OpenInDefaultApp => this.open_in_default_app(window, cx),
                }
            });
        preview.read(cx).focus_handle().clone().focus(window, cx);
        self.preview = Some((preview, subscription));
        self.menu = MenuSlot::new(MenuPlacement::BelowEnd);
        cx.notify();
    }

    /// Back to the list, which takes the focus.
    pub fn back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.preview.take().is_none() {
            return;
        }
        self.menu = MenuSlot::new(MenuPlacement::BelowEnd);
        self.list_focus.focus(window, cx);
        cx.notify();
    }

    fn escape(&mut self, _: &Back, window: &mut Window, cx: &mut Context<Self>) {
        if self.preview.is_some() {
            self.back(window, cx);
        } else {
            cx.emit(FilesViewEvent::Dismiss);
        }
    }

    // The actions.

    fn previewed(&self, cx: &App) -> Option<ArtifactProjection> {
        self.preview().map(|preview| preview.read(cx).artifact().clone())
    }

    /// Whether the previewed file offers `action`.
    fn offers(&self, action: FileAction, cx: &App) -> bool {
        let Some(preview) = self.preview() else { return false };
        let preview = preview.read(cx);
        let artifact = preview.artifact();
        match action {
            FileAction::Copy => match artifact.kind {
                ArtifactKind::Diff | ArtifactKind::Html => true,
                ArtifactKind::File => {
                    !matches!(preview.body(), Body::NotText)
                        && !crate::policy::is_office_document(&artifact.name)
                }
                _ => false,
            },
            FileAction::Save => true,
            FileAction::Open => match artifact.kind {
                ArtifactKind::Pdf => true,
                ArtifactKind::Image => {
                    preview.image().is_none_or(|(_, kind)| kind.is_some_and(ImageType::is_openable))
                }
                _ => is_html(artifact),
            },
            FileAction::Delete => is_user_deletable(artifact),
        }
    }

    fn start(
        &mut self,
        action: FileAction,
        task: impl FnOnce(&mut Self, &mut Window, &mut Context<Self>) -> Option<Task<()>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.action.is_some() || !self.offers(action, cx) {
            return;
        }
        if let Some(task) = task(self, window, cx) {
            self.action = Some((action, task));
            cx.notify();
        }
    }

    fn say(&mut self, notice: Notice, window: &mut Window, cx: &mut Context<Self>) {
        let toast = match (&notice.detail, notice.ok) {
            (Some(detail), true) => {
                Notification::success(detail.clone()).title(notice.title.clone())
            }
            (Some(detail), false) => {
                Notification::error(detail.clone()).title(notice.title.clone())
            }
            (None, true) => Notification::success(notice.title.clone()),
            (None, false) => Notification::error(notice.title.clone()),
        };
        window.push_notification(toast, cx);
        self.notice = Some(notice);
        cx.notify();
    }

    fn finish(&mut self, notice: Notice, window: &mut Window, cx: &mut Context<Self>) {
        self.action = None;
        self.say(notice, window, cx);
    }

    /// Copies the file's text: what the preview holds when it is whole,
    /// else read from the Host, up to [`COPY_MAX_BYTES`].
    pub fn copy(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.start(
            FileAction::Copy,
            |this, window, cx| {
                let artifact = this.previewed(cx)?;
                let locale = Locale::current(cx);
                let name = artifact.name.clone();
                let whole = this.preview().and_then(|preview| preview.read(cx).complete_text());
                let requester = this.list.read(cx).host().read(cx).requester();
                Some(cx.spawn_in(window, async move |this, cx| {
                    let text = match whole {
                        Some(text) => Ok(text.to_string()),
                        None => read::all(
                            &requester,
                            &artifact.session_id,
                            &artifact.id,
                            Some(COPY_MAX_BYTES),
                        )
                        .await
                        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned()),
                    };
                    this.update_in(cx, |this, window, cx| {
                        let notice = match text {
                            Ok(text) => {
                                cx.write_to_clipboard(ClipboardItem::new_string(text));
                                Notice {
                                    ok: true,
                                    title: copy::about(copy::COPIED, locale, &name),
                                    detail: None,
                                }
                            }
                            Err(failure) => {
                                let detail = match failure {
                                    ReadFailure::TooLarge => {
                                        copy::WHY_COPY_TOO_LARGE.in_locale(locale).to_owned()
                                    }
                                    failure => why(&failure, locale),
                                };
                                Notice {
                                    ok: false,
                                    title: copy::about(copy::COPY_FAILED, locale, &name),
                                    detail: Some(detail),
                                }
                            }
                        };
                        this.finish(notice, window, cx);
                    })
                    .ok();
                }))
            },
            window,
            cx,
        );
    }

    /// Asks where to save a copy, then writes the file's bytes there, read
    /// from the Host chunk by chunk.
    pub fn save_as(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.start(
            FileAction::Save,
            |this, window, cx| {
                let artifact = this.previewed(cx)?;
                let locale = Locale::current(cx);
                let suggested = safe_file_name(&artifact.name);
                let chosen = this.desk.choose_save_path(&suggested, cx);
                let requester = this.list.read(cx).host().read(cx).requester();
                Some(cx.spawn_in(window, async move |this, cx| {
                    let Some(target) = chosen.await else {
                        this.update(cx, |this, cx| {
                            this.action = None;
                            cx.notify();
                        })
                        .ok();
                        return;
                    };
                    let name = artifact.name.clone();
                    let outcome =
                        match read::all(&requester, &artifact.session_id, &artifact.id, None).await
                        {
                            Ok(bytes) => {
                                let write = cx
                                    .background_executor()
                                    .spawn(async move { write_saved_copy(&target, &bytes) })
                                    .await;
                                write.map_err(|error| {
                                    copy::why_write_failed(locale, &error.to_string())
                                })
                            }
                            Err(failure) => Err(why(&failure, locale)),
                        };
                    this.update_in(cx, |this, window, cx| {
                        let notice = match outcome {
                            Ok(()) => Notice {
                                ok: true,
                                title: copy::about(copy::SAVED, locale, &name),
                                detail: None,
                            },
                            Err(detail) => Notice {
                                ok: false,
                                title: copy::about(copy::SAVE_FAILED, locale, &name),
                                detail: Some(detail),
                            },
                        };
                        this.finish(notice, window, cx);
                    })
                    .ok();
                }))
            },
            window,
            cx,
        );
    }

    /// Writes a copy of a PDF, a raster image or an HTML page under the
    /// app's cache and hands it to the default app. A PDF's or an image's
    /// extension comes from its bytes, a page's is `html` whatever its name.
    pub fn open_in_default_app(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.start(
            FileAction::Open,
            |this, window, cx| {
                let artifact = this.previewed(cx)?;
                let locale = Locale::current(cx);
                let held = this
                    .preview()
                    .and_then(|preview| preview.read(cx).image())
                    .map(|(bytes, _)| bytes);
                let requester = this.list.read(cx).host().read(cx).requester();
                let temp_dir = this.desk.temp_dir(cx);
                Some(cx.spawn_in(window, async move |this, cx| {
                    let name = artifact.name.clone();
                    let bytes: Result<Arc<[u8]>, String> = match held {
                        Some(bytes) => Ok(bytes),
                        None => read::all(&requester, &artifact.session_id, &artifact.id, None)
                            .await
                            .map(Arc::from)
                            .map_err(|failure| why(&failure, locale)),
                    };
                    let opened = match (bytes, temp_dir) {
                        (Err(detail), _) => Err(detail),
                        (Ok(_), None) => Err(copy::WHY_NO_TEMP.in_locale(locale).to_owned()),
                        (Ok(bytes), Some(temp_dir)) => {
                            match openable_extension(&artifact, &bytes) {
                                None => Err(copy::WHY_UNKNOWN_KIND.in_locale(locale).to_owned()),
                                Some(extension) => {
                                    let (session, id) =
                                        (artifact.session_id.clone(), artifact.id.clone());
                                    cx.background_executor()
                                        .spawn(async move {
                                            write_temp_copy(
                                                &temp_dir, &session, &id, extension, &bytes,
                                            )
                                        })
                                        .await
                                        .map_err(|error| {
                                            copy::why_write_failed(locale, &error.to_string())
                                        })
                                }
                            }
                        }
                    };
                    this.update_in(cx, |this, window, cx| match opened {
                        Ok(path) => {
                            this.desk.open(&path, cx);
                            this.action = None;
                            cx.notify();
                        }
                        Err(detail) => {
                            let title = copy::about(copy::OPEN_FAILED, locale, &name);
                            this.finish(
                                Notice { ok: false, title, detail: Some(detail) },
                                window,
                                cx,
                            );
                        }
                    })
                    .ok();
                }))
            },
            window,
            cx,
        );
    }

    /// Asks before deleting the previewed file, naming it.
    pub fn ask_delete(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.action.is_some() || !self.offers(FileAction::Delete, cx) {
            return;
        }
        let Some(artifact) = self.previewed(cx) else { return };
        let locale = Locale::current(cx);
        let title = copy::delete_title(locale, &artifact.name);
        let body: SharedString = copy::DELETE_BODY.in_locale(locale).into();
        let view = cx.entity().downgrade();
        let id = artifact.id.clone();
        window.open_alert_dialog(cx, move |alert, _, cx| {
            let (view, id) = (view.clone(), id.clone());
            floating_surface(alert, cx)
                .with_header(DialogHeader::new(title.clone()))
                .description(shared::dialog::confirmation_text(body.clone()))
                .footer(shared::dialog::confirmation_answers(
                    copy::CANCEL.in_locale(locale),
                    copy::DELETE.in_locale(locale),
                    true,
                    cx,
                ))
                .on_ok(move |_, window, cx| {
                    view.update(cx, |view, cx| view.delete(&id, window, cx)).ok();
                    true
                })
        });
    }

    /// Deletes file `id`, confirmed: back to the list, read again.
    fn delete(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.previewed(cx).is_none_or(|artifact| artifact.id != id) {
            return;
        }
        self.start(
            FileAction::Delete,
            |this, window, cx| {
                let artifact = this.previewed(cx)?;
                let locale = Locale::current(cx);
                let requester = this.list.read(cx).host().read(cx).requester();
                Some(cx.spawn_in(window, async move |this, cx| {
                    let result = read::delete(&requester, &artifact.session_id, &artifact.id).await;
                    this.update_in(cx, |this, window, cx| {
                        this.action = None;
                        let name = artifact.name.as_str();
                        let failure = |detail: String| Notice {
                            ok: false,
                            title: copy::about(copy::DELETE_FAILED, locale, name),
                            detail: Some(detail),
                        };
                        match result {
                            Ok(()) => {
                                this.back(window, cx);
                                this.list.update(cx, |list, cx| list.retry(cx));
                            }
                            Err(ReadFailure::Operation {
                                code: HostOperationErrorCode::NotFound,
                                ..
                            }) => {
                                this.back(window, cx);
                                this.list.update(cx, |list, cx| list.retry(cx));
                                let title = copy::WHY_ALREADY_DELETED.in_locale(locale).to_owned();
                                this.say(Notice { ok: true, title, detail: None }, window, cx);
                            }
                            Err(other) => this.say(failure(why(&other, locale)), window, cx),
                        }
                        cx.notify();
                    })
                    .ok();
                }))
            },
            window,
            cx,
        );
    }

    fn menu_entries(&self, cx: &mut Context<Self>) -> Vec<MenuEntry> {
        let view = cx.entity().downgrade();
        let busy = self.action.is_some();
        let item = |key: &'static str,
                    label: &str,
                    icon: Icon,
                    run: fn(&mut Self, &mut Window, &mut Context<Self>)| {
            let view = view.clone();
            MenuEntry::from(
                MenuItem::new(key, label.to_owned()).icon(icon).disabled(busy).on_select(
                    move |window, cx| {
                        view.update(cx, |view, cx| run(view, window, cx)).ok();
                    },
                ),
            )
        };
        let mut entries = Vec::new();
        if self.offers(FileAction::Copy, cx) {
            entries.push(item(
                "files-copy",
                copy::COPY.get(cx),
                Icon::new(MakaIcon::Copy),
                Self::copy,
            ));
        }
        entries.push(item(
            "files-save",
            copy::SAVE_AS.get(cx),
            Icon::new(AssetIcon::Download),
            Self::save_as,
        ));
        if self.offers(FileAction::Open, cx) {
            entries.push(item(
                "files-open",
                copy::OPEN_DEFAULT.get(cx),
                Icon::new(AssetIcon::ExternalLink),
                Self::open_in_default_app,
            ));
        }
        if self.offers(FileAction::Delete, cx) {
            entries.push(MenuEntry::Separator);
            entries.push(item(
                "files-delete",
                copy::DELETE_ITEM.get(cx),
                Icon::new(AssetIcon::Trash),
                Self::ask_delete,
            ));
        }
        entries
    }

    // Rendering.

    /// The filtered rows and their sizes, worked out again only when the
    /// files, the filter or the rem changed.
    fn sync_rows(&mut self, window: &Window, cx: &App) {
        let list = self.list.read(cx);
        let visible = list.visible().clone();
        let query = self.filter.read(cx).value().to_string();
        let key = (list.version(), query.clone(), window.rem_size());
        if self.rows.as_ref().is_some_and(|rows| rows.key == key) {
            return;
        }
        let rem = window.rem_size();
        let indices: Vec<usize> = visible
            .iter()
            .enumerate()
            .filter(|(_, artifact)| matches_filter(&artifact.name, &query))
            .map(|(ix, _)| ix)
            .collect();
        let sizes = indices
            .iter()
            .map(|ix| size(px(0.), rems(row_height(&visible[*ix])).to_pixels(rem)))
            .collect();
        self.rows = Some(Rows { key, indices: indices.into(), sizes: Rc::new(sizes) });
    }

    fn render_toolbar(&self, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let query = self.filter.read(cx).value();
        let total = self.list.read(cx).visible().len();
        let count = self.rows.as_ref().map_or(0, |rows| rows.indices.len());
        let summary = (!query.trim().is_empty()).then(|| copy::filter_count(locale, count, total));
        h_flex()
            .flex_none()
            .w_full()
            .px_4()
            .py_2()
            .gap_2()
            .child(
                Input::new(&self.filter)
                    .field_fill(cx)
                    .small()
                    .flex_1()
                    .aria_label(copy::FILTER.get(cx))
                    .prefix(Icon::new(MakaIcon::Search).small())
                    .cleanable(true),
            )
            .when_some(summary, |this, summary| {
                this.child(
                    div()
                        .id("files-filter-count")
                        .test_support()
                        .aria_label(summary.clone())
                        .flex_none()
                        .text_xs()
                        .text_color(cx.maka().ink_muted)
                        .child(summary),
                )
            })
            .into_any_element()
    }

    fn render_list(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let list = self.list.read(cx);
        let load = list.load().clone();
        let total = list.visible().len();
        let failure = match &load {
            ListLoad::Failed(failure) => Some(failure.clone()),
            _ => None,
        };
        let failure_line = failure.map(|failure| {
            let text =
                shell_copy::failure(locale, copy::LIST_FAILED.get(cx), &why(&failure, locale));
            div()
                .flex_none()
                .px_4()
                .pb_2()
                .child(
                    StatusLine::error("files-list-failure", text).action(
                        quiet_button(Button::new("files-list-retry"), cx)
                            .label(copy::RETRY.get(cx))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.list.update(cx, |list, cx| list.retry(cx));
                            })),
                    ),
                )
                .into_any_element()
        });
        let rows = self.rows.as_ref();
        let shown = rows.map_or(0, |rows| rows.indices.len());
        let content: AnyElement = if total == 0 {
            match load {
                ListLoad::Loading => line("files-loading", copy::LOADING.get(cx).into(), cx),
                ListLoad::Failed(_) => div().into_any_element(),
                _ => empty_state(cx),
            }
        } else if shown == 0 {
            line("files-no-matches", copy::NO_MATCHES.get(cx).into(), cx)
        } else {
            let keyboard = self.list_focus.is_focused(window) && window.last_input_was_keyboard();
            let sizes = rows.map_or_else(Rc::default, |rows| rows.sizes.clone());
            div()
                .size_full()
                .child(
                    v_virtual_list(
                        cx.entity(),
                        "files-rows",
                        sizes,
                        move |this, range, window, cx| {
                            range
                                .map(|ix| this.render_row(ix, keyboard, window, cx))
                                .collect::<Vec<_>>()
                        },
                    )
                    .track_scroll(&self.scroll)
                    // The rows' fills 8 px in from the plate's sides, their
                    // text on its 16 px line.
                    .px_2()
                    .pb_2(),
                )
                .child(Scrollbar::vertical(&self.scroll))
                .into_any_element()
        };
        // The list's region holds the focus whatever it shows, so its keys
        // (Escape among them) work while it is empty or loading too.
        let body = div()
            .id("files-list")
            .test_support()
            .role(Role::ListBox)
            .aria_label(copy::LIST.get(cx))
            .track_focus(&self.list_focus)
            .key_context(LIST_CONTEXT)
            .on_action(cx.listener(|this, _: &SelectPrevious, window, cx| {
                this.press(ListKey::Up, window, cx);
            }))
            .on_action(cx.listener(|this, _: &SelectNext, window, cx| {
                this.press(ListKey::Down, window, cx);
            }))
            .on_action(cx.listener(|this, _: &SelectFirst, window, cx| {
                this.press(ListKey::Home, window, cx);
            }))
            .on_action(cx.listener(|this, _: &SelectLast, window, cx| {
                this.press(ListKey::End, window, cx);
            }))
            .on_action(cx.listener(|this, _: &OpenSelected, window, cx| {
                this.press(ListKey::Activate, window, cx);
            }))
            .relative()
            .flex_1()
            .min_h_0()
            .w_full()
            .child(content);
        v_flex()
            .size_full()
            .min_h_0()
            .child(self.render_toolbar(cx))
            .children(failure_line)
            .child(body)
            .into_any_element()
    }

    /// Row `ix` of the filtered rows: the kind's icon, the name, its size
    /// and age, and the summary under them when it has one. A click opens
    /// the file; pressing it keeps focus on the list, the one Tab stop.
    fn render_row(
        &self,
        ix: usize,
        keyboard: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(rows) = self.rows.as_ref() else { return div().into_any_element() };
        let visible = self.list.read(cx).visible().clone();
        let Some(artifact) = rows.indices.get(ix).and_then(|ix| visible.get(*ix)) else {
            return div().into_any_element();
        };
        let maka = cx.maka();
        let locale = Locale::current(cx);
        let id = artifact.id.clone();
        let selected = self.selected.as_deref() == Some(id.as_str());
        let size = file_size(locale, artifact.size_bytes);
        let (now, offset) = self.listed_at;
        let when = shared::time::compact_timestamp(locale, artifact.created_at, now, offset);
        let meta = format!("{size} · {when}");
        let summary = row_summary(artifact).map(str::to_owned);
        let mut spoken = vec![artifact.name.as_str(), &size, &when];
        spoken.extend(summary.as_deref());
        let label = shell_copy::parts(locale, &spoken);
        let focus = self.list_focus.clone();
        let open_id = id.clone();
        h_flex()
            .id(domain_element_id("files-row", &id))
            .test_support()
            .role(Role::ListBoxOption)
            .aria_label(label)
            .aria_selected(selected)
            .w_full()
            .h(rems(row_height(artifact)))
            .px_2()
            .py(rems(ROW_PADDING_REMS))
            .gap_2()
            .items_start()
            .rounded(RADIUS_CONTROL)
            .map(|this| selectable_row(this, selected, cx))
            .when(keyboard && selected, |this| this.focus_ring_style(window, cx))
            .on_mouse_down(MouseButton::Left, move |_: &MouseDownEvent, window, cx| {
                window.prevent_default();
                focus.focus(window, cx);
            })
            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                this.open_preview(&open_id, window, cx);
            }))
            .child(
                div()
                    .flex_none()
                    .h(rems(ROW_LINE_REMS))
                    .flex()
                    .items_center()
                    .child(kind_icon(&artifact.kind).size_4().text_color(maka.ink_muted)),
            )
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(
                        h_flex()
                            .w_full()
                            .h(rems(ROW_LINE_REMS))
                            .gap_2()
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .truncate()
                                    .text_sm()
                                    .text_color(maka.ink)
                                    .when(selected, |this| this.font_medium())
                                    .child(artifact.name.clone()),
                            )
                            .child(
                                div()
                                    .flex_none()
                                    .text_xs()
                                    .text_color(maka.ink_muted)
                                    .font_features(shared::theme::tabular_nums())
                                    .child(meta),
                            ),
                    )
                    .when_some(summary, |this, summary| {
                        this.child(
                            div()
                                .w_full()
                                .h(rems(ROW_LINE_REMS))
                                .truncate()
                                .text_xs()
                                .line_height(rems(ROW_LINE_REMS))
                                .text_color(maka.ink_muted)
                                .child(summary),
                        )
                    }),
            )
            .into_any_element()
    }

    /// The preview's header: back, the file's name over its kind, size and
    /// age, and the "⋯" menu of its actions.
    fn render_preview(
        &self,
        preview: &Entity<ArtifactPreview>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let maka = cx.maka();
        let locale = Locale::current(cx);
        let artifact = preview.read(cx).artifact().clone();
        let kind = match artifact.kind {
            ArtifactKind::File => copy::KIND_FILE.get(cx),
            ArtifactKind::Diff => copy::KIND_DIFF.get(cx),
            ArtifactKind::Html => copy::KIND_HTML.get(cx),
            ArtifactKind::Image => copy::KIND_IMAGE.get(cx),
            ArtifactKind::Pdf => copy::KIND_PDF.get(cx),
            _ => copy::KIND_FILE.get(cx),
        };
        let (now, offset) = self.listed_at;
        let size = file_size(locale, artifact.size_bytes);
        let when = shared::time::compact_timestamp(locale, artifact.created_at, now, offset);
        let meta = format!("{kind} · {size} · {when}");
        let spoken = shell_copy::parts(locale, &[kind, &size, &when]);
        let menu_open = self.menu.is_open();
        let back = copy::BACK.get(cx);
        let more = copy::more_actions(locale, &artifact.name);
        let header = h_flex()
            .id("files-preview-header")
            .test_support()
            .flex_none()
            .w_full()
            .pl_2()
            .pr_2()
            .py_2()
            .gap_2()
            .border_b_1()
            .border_color(maka.border_soft)
            .child(
                Button::new("files-back")
                    .ghost()
                    .small()
                    .size_7()
                    .flex_shrink_0()
                    .icon(Icon::new(MakaIcon::ChevronLeft).size_4().text_color(maka.ink_muted))
                    .accessibility_label(back)
                    .tooltip(back)
                    .on_click(cx.listener(|this, _, window, cx| this.back(window, cx))),
            )
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .id("files-preview-name")
                            .test_support()
                            .aria_label(artifact.name.clone())
                            .w_full()
                            .truncate()
                            .text_sm()
                            .font_medium()
                            .text_color(maka.ink)
                            .child(artifact.name.clone()),
                    )
                    .child(
                        div()
                            .id("files-preview-meta")
                            .test_support()
                            .aria_label(spoken)
                            .w_full()
                            .truncate()
                            .text_xs()
                            .text_color(maka.ink_muted)
                            .child(meta),
                    ),
            )
            .child(
                div()
                    .relative()
                    .flex_shrink_0()
                    .child(
                        row_icon_button(Button::new("files-more"), cx)
                            .small()
                            .size_7()
                            .icon(Icon::new(MakaIcon::More).size_4())
                            .accessibility_label(more.clone())
                            .tooltip(more)
                            .loading(self.action.is_some())
                            .selected(menu_open)
                            .on_click(cx.listener(|this, event: &ClickEvent, window, cx| {
                                let width = window.rem_size() * MENU_WIDTH_REMS;
                                MenuSlot::toggle(
                                    this,
                                    |this| &mut this.menu,
                                    event,
                                    |this, cx| this.menu_entries(cx),
                                    width,
                                    window,
                                    cx,
                                );
                            })),
                    )
                    .children(self.menu.layer()),
            );
        v_flex()
            .size_full()
            .min_h_0()
            .child(header)
            .child(div().flex_1().min_h_0().w_full().child(preview.clone()))
            .into_any_element()
    }
}

/// A row's height in rems: one line, or two with a summary.
fn row_height(artifact: &ArtifactProjection) -> f32 {
    let lines = if row_summary(artifact).is_some() { 2. } else { 1. };
    ROW_PADDING_REMS * 2. + ROW_LINE_REMS * lines
}

/// The kind's glyph: Maka's diff glyph, and the kit's file glyphs the
/// attachments' chips draw for the rest.
fn kind_icon(kind: &ArtifactKind) -> Icon {
    match kind {
        ArtifactKind::File => Icon::new(AssetIcon::FileText),
        ArtifactKind::Diff => Icon::new(MakaIcon::FileDiff),
        ArtifactKind::Html => Icon::new(AssetIcon::FileCode),
        ArtifactKind::Image => Icon::new(AssetIcon::FileImage),
        ArtifactKind::Pdf => Icon::new(AssetIcon::FileType),
        _ => Icon::new(AssetIcon::File),
    }
}

/// The extension a copy for the default app takes: from its bytes, `pdf`
/// for a PDF, a raster image's own; `html` for an HTML page, so the
/// browser opens it whatever its name; `None` for anything else.
fn openable_extension(artifact: &ArtifactProjection, bytes: &[u8]) -> Option<&'static str> {
    match artifact.kind {
        ArtifactKind::Pdf => is_pdf(bytes).then_some("pdf"),
        ArtifactKind::Image => {
            ImageType::sniff(bytes).filter(|kind| kind.is_openable()).map(ImageType::extension)
        }
        _ => is_html(artifact).then_some("html"),
    }
}

/// One line of muted text where the list's rows would be.
fn line(id: &'static str, text: SharedString, cx: &App) -> AnyElement {
    div()
        .id(id)
        .test_support()
        .aria_label(text.clone())
        .px_4()
        .py_2()
        .text_sm()
        .text_color(cx.maka().ink_muted)
        .child(text)
        .into_any_element()
}

/// The list with nothing in it: the tool's glyph and the line that says
/// what will be here.
fn empty_state(cx: &App) -> AnyElement {
    let maka = cx.maka();
    let text = copy::EMPTY.get(cx);
    v_flex()
        .id("files-empty")
        .test_support()
        .aria_label(text)
        .w_full()
        .items_center()
        .py_8()
        .px_4()
        .gap_2()
        .child(Icon::new(MakaIcon::Folder).size_6().text_color(maka.ink_muted))
        .child(
            div().max_w(rems(20.)).text_center().text_sm().text_color(maka.ink_muted).child(text),
        )
        .into_any_element()
}

/// The wall clock, in Unix milliseconds.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

impl Render for FilesView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_rows(window, cx);
        let content = match self.preview().cloned() {
            Some(preview) => self.render_preview(&preview, cx),
            None => self.render_list(window, cx),
        };
        v_flex()
            .id("files-face")
            .test_support()
            .role(Role::Region)
            .aria_label(copy::FILES.get(cx))
            .key_context(FILES_CONTEXT)
            .on_action(cx.listener(Self::escape))
            .size_full()
            .min_w_0()
            .min_h_0()
            .text_color(cx.maka().ink)
            .child(content)
    }
}
