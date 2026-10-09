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

//! The Workspace page's projects: the Host's registered projects,
//! with rename, archive and restore, relink for a project whose folder is
//! gone, and "Add project…".
//!
//! On a remote Host this client cannot name folders by path (a remote
//! owner's credential has no Host paths): "Add project…" opens the Host's
//! own folders ([`RemoteDirectoryDialog`], Desktop's remote directory
//! browser), relinking is not offered, and no folder is shown.

use gpui_kit::assets::IconName as AssetIcon;
use gpui_kit::component::button::Button;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Icon, Sizable as _, WindowExt as _, h_flex, v_flex,
};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, FocusHandle, InteractiveElement as _,
    IntoElement, KeyBinding, ParentElement as _, PathPromptOptions, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, TestSupportExt as _, Window,
    div, prelude::FluentBuilder as _,
};
use shared::copy::settings as copy;
use shared::domain_element_id;
use shared::theme::FieldFill as _;
use shared::theme::{ActiveMakaPalette as _, badge, quiet_button};
use workspace::{ProjectEntry, ProjectSelection};

use crate::remote_directory_dialog::RemoteDirectoryDialog;
use crate::rows::{EmptyRow, row_rule, settings_button};

/// Key context of the field that renames a project in place.
pub const PROJECT_RENAME_CONTEXT: &str = "ProjectRename";

gpui_kit::actions!(
    projects_pane,
    [
        /// Leave the project rename field without changing the name.
        CancelProjectRename,
    ]
);

/// Binds the rename field's Escape. Called by [`crate::init`].
pub(crate) fn bind_keys(cx: &mut App) {
    cx.bind_keys([KeyBinding::new("escape", CancelProjectRename, Some(PROJECT_RENAME_CONTEXT))]);
}

/// A project being renamed in place.
struct Renaming {
    project: SharedString,
    input: Entity<InputState>,
    _events: Subscription,
}

/// What a folder chosen in the platform dialog is for.
#[derive(Debug, Clone)]
enum FolderPurpose {
    /// Register it as a new project.
    Add,
    /// Point this project at it.
    Relink(SharedString),
}

/// Behavior and presentation owner of the Projects section. It reads and
/// changes [`ProjectSelection`], the window's project catalog: every
/// project with its folder, marked Archived or Folder missing, and per row
/// Rename (the name becomes a field: Enter commits, Escape cancels),
/// Archive or Restore, and Relink… when the folder is missing. "Add
/// project…" registers a folder chosen in the platform dialog. One command
/// runs at a time; while it does the buttons are disabled and "Back to
/// app" waits for it.
pub struct ProjectsPane {
    projects: Entity<ProjectSelection>,
    /// Tracked on the list (not a Tab stop), to hold focus when a rename
    /// field closes.
    list_focus: FocusHandle,
    renaming: Option<Renaming>,
    _folder_prompt: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for ProjectsPane {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProjectsPane").finish_non_exhaustive()
    }
}

impl ProjectsPane {
    pub fn new(projects: Entity<ProjectSelection>, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![cx.observe(&projects, |_, _, cx| cx.notify())];
        Self {
            projects,
            list_focus: cx.focus_handle(),
            renaming: None,
            _folder_prompt: None,
            _subscriptions: subscriptions,
        }
    }

    /// Whether a command it sent is unanswered.
    pub fn is_busy(&self, cx: &App) -> bool {
        self.projects.read(cx).pending_command().is_some()
    }

    /// The project being renamed.
    pub fn renaming(&self) -> Option<&SharedString> {
        self.renaming.as_ref().map(|renaming| &renaming.project)
    }

    /// Turns project `id`'s name into a field, focused with the text
    /// selected.
    pub fn start_rename(&mut self, id: &SharedString, window: &mut Window, cx: &mut Context<Self>) {
        let Some(project) = self.projects.read(cx).project(id) else {
            return;
        };
        let name = project.label();
        let input = cx.new(|cx| InputState::new(window, cx).default_value(name));
        let events = cx.subscribe_in(&input, window, |this, _, event: &InputEvent, window, cx| {
            if matches!(event, InputEvent::PressEnter { .. }) {
                this.finish_rename(true, window, cx);
            }
        });
        input.update(cx, |input, cx| {
            input.focus(window, cx);
            input.select_all(window, cx);
        });
        self.renaming = Some(Renaming { project: id.clone(), input, _events: events });
        cx.notify();
    }

    fn cancel_rename(
        &mut self,
        _: &CancelProjectRename,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.finish_rename(false, window, cx);
    }

    /// Leaves the rename field, sending the name when `commit`, and gives
    /// focus back to the list.
    fn finish_rename(&mut self, commit: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(renaming) = self.renaming.take() else {
            return;
        };
        if commit {
            let name = renaming.input.read(cx).value();
            self.projects
                .update(cx, |projects, cx| projects.rename_project(&renaming.project, &name, cx));
        }
        // The field goes away; the list keeps focus inside the page, and
        // Tab continues from it.
        self.list_focus.focus(window, cx);
        cx.notify();
    }

    /// Asks for a folder with the platform dialog, to add as a project or
    /// to relink a project to.
    fn choose_folder(&mut self, purpose: FolderPurpose, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some(shared::copy::FOLDER_CHOOSE_BUTTON.get(cx).into()),
        });
        self._folder_prompt = Some(cx.spawn(async move |this, cx| {
            let path = match paths.await {
                Ok(Ok(Some(paths))) => paths.into_iter().next(),
                Ok(Err(error)) => {
                    log::warn!("the folder dialog failed: {error:#}");
                    None
                }
                _ => None,
            };
            let Some(path) = path else {
                return;
            };
            let path = path.to_string_lossy().into_owned();
            this.update(cx, |this, cx| {
                this.projects.update(cx, |projects, cx| match purpose {
                    FolderPurpose::Add => projects.register_folder(path, cx).detach(),
                    FolderPurpose::Relink(id) => projects.relink_project(&id, &path, cx),
                })
            })
            .ok();
        }));
    }

    /// Opens the remote Host's folders to add a project from. `false`
    /// (and nothing opens) when the window talks to the local Host, whose
    /// folders the platform dialog chooses.
    pub fn open_remote_directory(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.projects.read(cx).can_use_host_paths(cx) || window.has_active_dialog(cx) {
            return false;
        }
        let host = self.projects.read(cx).host().read(cx).remote_name().unwrap_or_default();
        RemoteDirectoryDialog::open(self.projects.clone(), host, window, cx);
        true
    }

    /// "Add project…", at the end of the page's group heading: the
    /// platform's folder dialog for the local Host, the Host's own folders
    /// for a remote one.
    pub(crate) fn render_actions(&self, cx: &mut Context<Self>) -> AnyElement {
        let projects = self.projects.read(cx);
        quiet_button(Button::new("settings-add-project"), cx)
            .label(copy::ADD_PROJECT.get(cx))
            .disabled(projects.pending_command().is_some() || !projects.has_catalog())
            .on_click(cx.listener(|this, _, window, cx| {
                if !this.open_remote_directory(window, cx) {
                    this.choose_folder(FolderPurpose::Add, cx)
                }
            }))
            .into_any_element()
    }

    fn render_row(&self, project: &ProjectEntry, busy: bool, cx: &mut Context<Self>) -> AnyElement {
        let id = project.id.clone();
        // A remote Host's projects have no folder here, and none can be
        // chosen for them.
        let host_paths = self.projects.read(cx).can_use_host_paths(cx);
        let renaming = self.renaming.as_ref().filter(|renaming| renaming.project == id);
        let mut states = Vec::new();
        if project.archived {
            states.push(copy::PROJECT_ARCHIVED.get(cx));
        }
        if !project.available {
            states.push(copy::PROJECT_MISSING.get(cx));
        }
        let name = match renaming {
            Some(renaming) => div()
                .id(domain_element_id("project-rename-field", &id))
                .test_support()
                .key_context(PROJECT_RENAME_CONTEXT)
                .on_action(cx.listener(Self::cancel_rename))
                .child(
                    Input::new(&renaming.input)
                        .field_fill(cx)
                        .small()
                        .aria_label(copy::PROJECT_NAME.get(cx)),
                )
                .into_any_element(),
            None => h_flex()
                .gap_2()
                .min_w_0()
                .child(
                    div()
                        .truncate()
                        .text_sm()
                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                        .child(project.label()),
                )
                // A missing folder is a problem to fix: the warning ink; being
                // archived is a fact: a neutral badge.
                .children(states.iter().map(|state| {
                    let badge = badge(*state, cx);
                    if *state == copy::PROJECT_MISSING.get(cx) {
                        badge.text_color(cx.maka().warning)
                    } else {
                        badge
                    }
                }))
                .into_any_element(),
        };
        let (archive_label, archived) = if project.archived {
            (copy::PROJECT_RESTORE.get(cx), false)
        } else {
            (copy::PROJECT_ARCHIVE.get(cx), true)
        };
        let spoken = std::iter::once(project.label().to_string())
            .chain((!project.path.is_empty()).then(|| project.path.to_string()))
            .chain(states.iter().map(|state| state.to_string()))
            .collect::<Vec<_>>()
            .join(", ");
        h_flex()
            .id(domain_element_id("project-row", &id))
            .test_support()
            .aria_label(spoken)
            .py_3()
            .gap_3()
            // Desktop's `startContent`: the bare 16px FolderOpen.
            .child(
                Icon::new(gpui_kit::assets::IconName::FolderOpen)
                    .size_4()
                    .flex_shrink_0()
                    .text_color(cx.maka().ink_muted),
            )
            .child(v_flex().flex_1().min_w_0().gap_0p5().child(name).when(host_paths, |this| {
                this.child(
                    // A path is machine text: compact mono, 12/20.
                    div()
                        .truncate()
                        .font_family(cx.theme().mono_font_family.clone())
                        .text_xs()
                        .line_height(gpui_kit::rems(1.25))
                        .text_color(cx.theme().muted_foreground)
                        .child(project.path.clone()),
                )
            }))
            .when(renaming.is_none(), |this| {
                this.child(
                    h_flex()
                        .flex_shrink_0()
                        .gap_2()
                        .when(!project.available && host_paths, |this| {
                            let relink = id.clone();
                            this.child(
                                quiet_button(
                                    Button::new(domain_element_id("project-relink", &id)),
                                    cx,
                                )
                                .icon(Icon::new(AssetIcon::Link2))
                                .label(copy::PROJECT_RELINK.get(cx))
                                .disabled(busy)
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        this.choose_folder(
                                            FolderPurpose::Relink(relink.clone()),
                                            cx,
                                        )
                                    },
                                )),
                            )
                        })
                        .child({
                            let renamed = id.clone();
                            quiet_button(Button::new(domain_element_id("project-rename", &id)), cx)
                                .label(copy::PROJECT_RENAME.get(cx))
                                .disabled(busy)
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.start_rename(&renamed, window, cx)
                                }))
                        })
                        .child({
                            let archive = id.clone();
                            quiet_button(Button::new(domain_element_id("project-archive", &id)), cx)
                                .label(archive_label)
                                .disabled(busy)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.projects.update(cx, |projects, cx| {
                                        projects.set_project_archived(&archive, archived, cx)
                                    })
                                }))
                        }),
                )
            })
            .into_any_element()
    }
}

impl Render for ProjectsPane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let projects = self.projects.read(cx);
        let busy = projects.pending_command().is_some();
        let error = projects.command_error().cloned();
        let listed: Vec<ProjectEntry> = projects.projects().map(<[_]>::to_vec).unwrap_or_default();
        let note: Option<AnyElement> = if !projects.has_catalog() {
            Some(div().child(copy::PROJECTS_UNAVAILABLE.get(cx)).into_any_element())
        } else if let Some(message) =
            projects.load_error().filter(|_| projects.projects().is_none())
        {
            Some(
                v_flex()
                    .gap_2()
                    .items_start()
                    .child(
                        div()
                            .text_color(cx.theme().danger)
                            .child(copy::PROJECTS_LOAD_FAILED.get(cx)),
                    )
                    .child(div().text_xs().child(message.clone()))
                    .child(settings_button("projects-retry", copy::RETRY.get(cx), cx).on_click(
                        cx.listener(|this, _, _, cx| {
                            this.projects.update(cx, |projects, cx| projects.reload(cx));
                        }),
                    ))
                    .into_any_element(),
            )
        } else if projects.projects().is_none() {
            Some(
                h_flex()
                    .gap_2()
                    .child(Spinner::new().small())
                    .child(copy::PROJECTS_LOADING.get(cx))
                    .into_any_element(),
            )
        } else {
            None
        };
        let empty = (note.is_none() && listed.is_empty())
            .then(|| EmptyRow::new("projects-empty", copy::PROJECTS_EMPTY.get(cx)));
        let mut rows = Vec::with_capacity(listed.len() * 2);
        for (ix, project) in listed.iter().enumerate() {
            if ix > 0 {
                rows.push(row_rule(cx));
            }
            rows.push(self.render_row(project, busy, cx));
        }
        v_flex()
            .id("projects-pane")
            .test_support()
            .gap_4()
            .when_some(error, |this, error| {
                this.child(
                    div()
                        .id("projects-error")
                        .test_support()
                        .aria_label(error.clone())
                        .text_sm()
                        .text_color(cx.theme().danger)
                        .child(error),
                )
            })
            .when_some(note, |this, note| {
                this.child(
                    div()
                        .id("projects-note")
                        .test_support()
                        .py_4()
                        .text_sm()
                        .text_color(cx.theme().muted_foreground)
                        .child(note),
                )
            })
            .children(empty)
            .child(v_flex().id("projects-list").track_focus(&self.list_focus).children(rows))
    }
}
