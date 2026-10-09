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

//! Adding a project on a remote Host: the folders the Host offers, browsed
//! one level at a time, after Desktop's `RemoteProjectDirectoryDialog`
//! (apps/desktop/src/renderer/remote-project-directory-dialog.tsx). A
//! remote owner cannot name a folder by its path, so the Host lists its
//! directory roots (`directory_roots`) and their subfolders
//! (`directory_list_start`), and "Add this folder" registers the one shown
//! (`register_directory`), which the project list then chooses.
//!
//! The breadcrumbs lead back up (the root, or a menu of roots when the Host
//! offers several), hidden folders show on request, and a failed read says
//! so with Retry.

use gpui_kit::assets::IconName as AssetIcon;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::dialog::Dialog;
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::scroll::Scrollbar;
use gpui_kit::component::{
    Disableable as _, Icon, Sizable as _, VirtualListScrollHandle, WindowExt as _, h_flex, v_flex,
    v_virtual_list,
};
use gpui_kit::{
    Anchor, App, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled as _, Task,
    TestSupportExt as _, Window, div, px, rems, size,
};
use host_protocol::{ProjectDirectoryEntry, ProjectDirectoryRoot};
use shared::copy::remote_hosts as copy;
use shared::copy::{self as shared_copy, Locale};
use shared::dialog::{DialogHeader, DialogHeaderExt as _};
use shared::domain_element_id;
use shared::icons::MakaIcon;
use shared::theme::{ActiveMakaPalette as _, control_button};
use workspace::{HostRequestError, ProjectSelection, list_directory, list_directory_roots};

use crate::rows::StatusLine;

/// A folder row: 32px, the sidebar's row.
const ENTRY_HEIGHT_REMS: f32 = 2.;

/// The list's height: about ten rows.
const LIST_HEIGHT_REMS: f32 = 20.;

/// What the dialog shows below the breadcrumbs.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Phase {
    Loading,
    Loaded,
    /// The Host offers no folder at all.
    NoRoots,
    ReadFailed,
    Registering,
    RegisterFailed,
}

/// Behavior and presentation owner of the directory browser: the root and
/// the folder shown, their subfolders, and adding the folder as a project.
pub struct RemoteDirectoryDialog {
    projects: Entity<ProjectSelection>,
    roots: Vec<ProjectDirectoryRoot>,
    root: Option<ProjectDirectoryRoot>,
    segments: Vec<String>,
    entries: Vec<ProjectDirectoryEntry>,
    show_hidden: bool,
    phase: Phase,
    /// Guards against a slow read answering after a newer one started.
    generation: u64,
    scroll: VirtualListScrollHandle,
    _load: Option<Task<()>>,
}

impl std::fmt::Debug for RemoteDirectoryDialog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteDirectoryDialog")
            .field("root", &self.root)
            .field("segments", &self.segments)
            .field("phase", &self.phase)
            .finish_non_exhaustive()
    }
}

impl RemoteDirectoryDialog {
    /// The browser on the first root the Host offers.
    pub fn new(projects: Entity<ProjectSelection>, cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            projects,
            roots: Vec::new(),
            root: None,
            segments: Vec::new(),
            entries: Vec::new(),
            show_hidden: false,
            phase: Phase::Loading,
            generation: 0,
            scroll: VirtualListScrollHandle::new(),
            _load: None,
        };
        this.load_roots(cx);
        this
    }

    /// Opens the browser for `projects`' Host, named `host`, in `window`.
    pub fn open(
        projects: Entity<ProjectSelection>,
        host: SharedString,
        window: &mut Window,
        cx: &mut App,
    ) -> Entity<Self> {
        let browser = cx.new(|cx| Self::new(projects, cx));
        let content = browser.clone();
        let width = window.rem_size() * 35.;
        window.open_dialog(cx, move |dialog, _, cx| {
            let dialog = shared::theme::floating_surface(dialog, cx).w(width);
            content.update(cx, |browser, cx| browser.dialog(dialog, host.clone(), cx))
        });
        browser
    }

    /// The folder shown: its root and the path under it.
    pub fn location(&self) -> (Option<&ProjectDirectoryRoot>, &[String]) {
        (self.root.as_ref(), &self.segments)
    }

    /// The subfolders shown (hidden ones only when asked for).
    pub fn visible_entries(&self) -> Vec<&ProjectDirectoryEntry> {
        self.entries
            .iter()
            .filter(|entry| self.show_hidden || !entry.name.starts_with('.'))
            .collect()
    }

    fn busy(&self) -> bool {
        matches!(self.phase, Phase::Loading | Phase::Registering)
    }

    fn load_roots(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        self.phase = Phase::Loading;
        let requester = self.projects.read(cx).host().read(cx).requester();
        self._load = Some(cx.spawn(async move |this, cx| {
            let roots = list_directory_roots(&requester).await;
            let first = roots.as_ref().ok().and_then(|roots| roots.first().cloned());
            let listed = match &first {
                Some(root) => Some(list_directory(&requester, &root.id, Vec::new()).await),
                None => None,
            };
            this.update(cx, |this, cx| {
                if generation != this.generation {
                    return;
                }
                match (roots, first, listed) {
                    (Ok(roots), Some(root), Some(Ok(entries))) => {
                        this.roots = roots;
                        this.root = Some(root);
                        this.segments = Vec::new();
                        this.entries = entries;
                        this.phase = Phase::Loaded;
                    }
                    (Ok(_), None, _) => this.phase = Phase::NoRoots,
                    (roots, _, listed) => {
                        let error = roots.err().or(listed.and_then(Result::err));
                        log::warn!("project directory roots: {error:?}");
                        this.phase = Phase::ReadFailed;
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Shows the folder `segments` under `root`.
    pub fn navigate(
        &mut self,
        root: ProjectDirectoryRoot,
        segments: Vec<String>,
        cx: &mut Context<Self>,
    ) {
        if self.busy() && self.phase != Phase::Loading {
            return;
        }
        self.generation += 1;
        let generation = self.generation;
        self.phase = Phase::Loading;
        let requester = self.projects.read(cx).host().read(cx).requester();
        let read = list_directory(&requester, &root.id, segments.clone());
        self._load = Some(cx.spawn(async move |this, cx| {
            let listed: Result<Vec<ProjectDirectoryEntry>, HostRequestError> = read.await;
            this.update(cx, |this, cx| {
                if generation != this.generation {
                    return;
                }
                match listed {
                    Ok(entries) => {
                        this.root = Some(root);
                        this.segments = segments;
                        this.entries = entries;
                        this.phase = Phase::Loaded;
                        this.scroll.scroll_to_item(0, gpui_kit::ScrollStrategy::Top);
                    }
                    Err(error) => {
                        log::warn!("project directory list: {error}");
                        this.phase = Phase::ReadFailed;
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Opens the subfolder `name` of the folder shown.
    pub fn open_folder(&mut self, name: &str, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        let mut segments = self.segments.clone();
        segments.push(name.to_owned());
        self.navigate(root, segments, cx);
    }

    /// Reads the folder shown again, or the roots when none has shown yet.
    pub fn retry(&mut self, cx: &mut Context<Self>) {
        match self.root.clone() {
            Some(root) => self.navigate(root, self.segments.clone(), cx),
            None => self.load_roots(cx),
        }
    }

    pub fn toggle_hidden(&mut self, cx: &mut Context<Self>) {
        self.show_hidden = !self.show_hidden;
        cx.notify();
    }

    /// Adds the folder shown as a project; the dialog closes once the Host
    /// has registered it.
    pub fn register(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        if self.busy() {
            return;
        }
        self.phase = Phase::Registering;
        let registered = self.projects.update(cx, |projects, cx| {
            projects.register_directory(&root.id, self.segments.clone(), cx)
        });
        self._load = Some(cx.spawn_in(window, async move |this, cx| {
            let id = registered.await;
            this.update_in(cx, |this, window, cx| {
                if id.is_some() {
                    window.close_dialog(cx);
                } else {
                    this.phase = Phase::RegisterFailed;
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// The dialog around the browser: its title, and the hidden-folders
    /// toggle, Cancel, and Add this folder.
    pub(crate) fn dialog(
        &mut self,
        dialog: Dialog,
        host: SharedString,
        cx: &mut Context<Self>,
    ) -> Dialog {
        let locale = Locale::current(cx);
        let busy = self.busy();
        let hidden_label = if self.show_hidden {
            copy::REMOTE_DIRECTORY_HIDE_HIDDEN
        } else {
            copy::REMOTE_DIRECTORY_SHOW_HIDDEN
        };
        let footer = h_flex()
            .w_full()
            .justify_between()
            .gap_2()
            .child(
                control_button(Button::new("remote-directory-hidden").ghost())
                    .icon(Icon::new(if self.show_hidden {
                        AssetIcon::Eye
                    } else {
                        AssetIcon::EyeOff
                    }))
                    .accessibility_label(hidden_label.get(cx))
                    .tooltip(hidden_label.get(cx))
                    .disabled(self.phase == Phase::Registering)
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_hidden(cx))),
            )
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        control_button(Button::new("remote-directory-cancel").ghost())
                            .label(shared_copy::CANCEL.get(cx))
                            .on_click(|_, window, cx| window.close_dialog(cx)),
                    )
                    .child(
                        control_button(Button::new("remote-directory-select").primary())
                            .label(copy::REMOTE_DIRECTORY_SELECT.get(cx))
                            .loading(self.phase == Phase::Registering)
                            .disabled(busy || self.root.is_none())
                            .on_click(cx.listener(|this, _, window, cx| this.register(window, cx))),
                    ),
            );
        dialog
            .with_header(DialogHeader::new(copy::remote_directory_title(locale, &host)))
            .child(cx.entity())
            .with_footer(footer)
    }

    /// The root (a menu of roots when the Host offers several) and the
    /// folders down to the one shown, each a way back to it.
    fn render_breadcrumbs(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let busy = self.busy();
        let root_label: SharedString = self
            .root
            .as_ref()
            .map(|root| root.label.clone().into())
            .unwrap_or_else(|| copy::REMOTE_DIRECTORY_HOME.get(cx).into());
        let root_button = control_button(Button::new("remote-directory-root").ghost())
            .label(root_label)
            .disabled(busy);
        let root_button = if self.roots.len() > 1 {
            let (browser, roots, current) =
                (cx.weak_entity(), self.roots.clone(), self.root.as_ref().map(|r| r.id.clone()));
            root_button
                .dropdown_caret(true)
                .dropdown_menu_with_anchor(Anchor::TopLeft, move |mut menu, _, _| {
                    for root in &roots {
                        let (browser, chosen) = (browser.clone(), root.clone());
                        menu = menu.item(
                            PopupMenuItem::new(root.label.clone())
                                .checked(current.as_ref() == Some(&root.id))
                                .on_click(move |_, _, cx| {
                                    browser
                                        .update(cx, |this, cx| {
                                            this.navigate(chosen.clone(), Vec::new(), cx)
                                        })
                                        .ok();
                                }),
                        );
                    }
                    menu
                })
                .into_any_element()
        } else {
            root_button
                .on_click(cx.listener(|this, _, _, cx| {
                    if let Some(root) = this.root.clone() {
                        this.navigate(root, Vec::new(), cx);
                    }
                }))
                .into_any_element()
        };
        let crumbs = self.segments.iter().enumerate().map(|(ix, segment)| {
            let upto = self.segments[..=ix].to_vec();
            control_button(
                Button::new(domain_element_id("remote-directory-crumb", &ix.to_string())).ghost(),
            )
            .label(segment.clone())
            .disabled(busy)
            .on_click(cx.listener(move |this, _, _, cx| {
                if let Some(root) = this.root.clone() {
                    this.navigate(root, upto.clone(), cx);
                }
            }))
        });
        h_flex()
            .id("remote-directory-breadcrumbs")
            .test_support()
            .aria_label(copy::REMOTE_DIRECTORY_BREADCRUMBS.get(cx))
            .w_full()
            .flex_wrap()
            .gap_0p5()
            .child(root_button)
            .children(crumbs)
    }
}

impl Render for RemoteDirectoryDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let maka = cx.maka();
        let message = |text: shared_copy::Text, cx: &App| {
            div().py_4().text_sm().text_color(cx.maka().ink_muted).child(text.get(cx))
        };
        let body = match self.phase {
            Phase::Loading => message(copy::REMOTE_DIRECTORY_LOADING, cx).into_any_element(),
            Phase::NoRoots => message(copy::REMOTE_DIRECTORY_NONE, cx).into_any_element(),
            Phase::ReadFailed => v_flex()
                .gap_2()
                .items_start()
                .child(StatusLine::error(
                    "remote-directory-error",
                    copy::REMOTE_DIRECTORY_READ_FAILED.get(cx),
                ))
                .child(
                    control_button(Button::new("remote-directory-retry").ghost())
                        .label(shared_copy::settings::RETRY.get(cx))
                        .on_click(cx.listener(|this, _, _, cx| this.retry(cx))),
                )
                .into_any_element(),
            _ => {
                let visible: Vec<SharedString> =
                    self.visible_entries().iter().map(|entry| entry.name.clone().into()).collect();
                if visible.is_empty() {
                    message(copy::REMOTE_DIRECTORY_EMPTY, cx).into_any_element()
                } else {
                    let rem = window.rem_size();
                    let height = rems(ENTRY_HEIGHT_REMS).to_pixels(rem);
                    let sizes = std::rc::Rc::new(
                        visible.iter().map(|_| size(px(0.), height)).collect::<Vec<_>>(),
                    );
                    let registering = self.phase == Phase::Registering;
                    div()
                        .relative()
                        .w_full()
                        .h(rems(LIST_HEIGHT_REMS))
                        .child(
                            v_virtual_list(
                                cx.entity(),
                                "remote-directory-entries",
                                sizes,
                                move |_, range, _, cx| {
                                    range
                                        .filter_map(|ix| visible.get(ix).cloned())
                                        .map(|name| {
                                            let opened = name.clone();
                                            Button::new(domain_element_id(
                                                "remote-directory-entry",
                                                &name,
                                            ))
                                            .ghost()
                                            .small()
                                            .w_full()
                                            .h(rems(ENTRY_HEIGHT_REMS))
                                            .justify_start()
                                            .disabled(registering)
                                            .accessibility_label(name.clone())
                                            .child(
                                                h_flex()
                                                    .gap_2()
                                                    .min_w_0()
                                                    .child(
                                                        Icon::new(MakaIcon::Folder)
                                                            .size_4()
                                                            .text_color(cx.maka().ink_muted),
                                                    )
                                                    .child(
                                                        div()
                                                            .truncate()
                                                            .text_sm()
                                                            .child(name.clone()),
                                                    ),
                                            )
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.open_folder(&opened, cx)
                                            }))
                                            .into_any_element()
                                        })
                                        .collect()
                                },
                            )
                            .track_scroll(&self.scroll),
                        )
                        .child(Scrollbar::vertical(&self.scroll))
                        .into_any_element()
                }
            }
        };
        let failed = (self.phase == Phase::RegisterFailed).then(|| {
            StatusLine::error(
                "remote-directory-error",
                copy::REMOTE_DIRECTORY_REGISTER_FAILED.get(cx),
            )
        });
        v_flex()
            .id("remote-directory")
            .test_support()
            .w_full()
            .gap_2()
            .text_color(maka.ink)
            .child(self.render_breadcrumbs(cx))
            .child(div().h_px().w_full().bg(maka.border_soft))
            .child(body)
            .children(failed)
    }
}
