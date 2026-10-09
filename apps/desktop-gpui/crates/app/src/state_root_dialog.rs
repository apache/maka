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

//! Choosing the State Root: the folder where Maka keeps its data.
//!
//! On first launch (no `--root`, nothing remembered) the window opens on a
//! [`StartupView`] with the dialog on top and no way to dismiss it: the
//! window has nothing to show until a folder is chosen. Host > Switch Data
//! Folder… opens the same dialog over the Workbench, with Cancel. Continue
//! checks the folder ([`workspace::check_state_root_choice`]), remembers it,
//! and replaces the window's content with a Workbench for that folder
//! ([`show_workbench`]); the old Workbench drops its Host connection, and
//! the Host it had started exits by itself once idle.

use std::path::{Path, PathBuf};
use std::rc::Rc;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, TitleBar, WindowExt as _, h_flex, v_flex,
};
use gpui_kit::{
    App, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, PathPromptOptions, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Task, TestSupportExt as _, Window, div, prelude::FluentBuilder as _, rems,
};
use shared::copy::{self, Locale};
use shared::dialog::{DialogHeader, DialogHeaderExt as _};
use workspace::{StateRootChoiceError, StateRootStore, WindowHost, check_state_root_choice};

use crate::{CHROME_HEIGHT_REMS, Workbench};
use shared::theme::{ActiveMakaPalette as _, control_button, floating_surface, quiet_button};

/// The dialog's width.
const DIALOG_WIDTH_REMS: f32 = 34.;

/// Builds the Workbench for a State Root and the Host the window talks to:
/// in the app a [`workspace::HostSession`] that connects to it (and starts
/// the local Host when that is the one) plus the window content around it.
pub type BuildWorkbench = dyn Fn(PathBuf, WindowHost, &mut Window, &mut App) -> Entity<Workbench>;

/// What choosing a State Root needs from the shell. Cheap to clone.
#[derive(Clone)]
pub struct StateRootSetup {
    store: Rc<dyn StateRootStore>,
    proposal: PathBuf,
    desktop_data: Option<PathBuf>,
    build: Rc<BuildWorkbench>,
}

impl std::fmt::Debug for StateRootSetup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StateRootSetup")
            .field("proposal", &self.proposal)
            .field("desktop_data", &self.desktop_data)
            .finish_non_exhaustive()
    }
}

impl StateRootSetup {
    /// `store` remembers the choice, `proposal` is the folder first launch
    /// offers, `desktop_data` is Maka Desktop's data directory (refused),
    /// and `build` makes the Workbench for a chosen folder.
    pub fn new(
        store: Rc<dyn StateRootStore>,
        proposal: PathBuf,
        desktop_data: Option<PathBuf>,
        build: Rc<BuildWorkbench>,
    ) -> Self {
        Self { store, proposal, desktop_data, build }
    }

    pub fn store(&self) -> &Rc<dyn StateRootStore> {
        &self.store
    }
}

/// Replaces `window`'s content with a Workbench for the State Root at
/// `root` and its local Host, focused in its composer. Call it outside any
/// update of the window's current content (from a task, or deferred).
pub fn show_workbench(
    setup: &StateRootSetup,
    root: PathBuf,
    window: &mut Window,
    cx: &mut App,
) -> Entity<Workbench> {
    show_workbench_on(setup, root, WindowHost::Local, window, cx)
}

/// [`show_workbench`] for the Host `host`: the window switches Host by
/// building its content again for the one chosen.
pub fn show_workbench_on(
    setup: &StateRootSetup,
    root: PathBuf,
    host: WindowHost,
    window: &mut Window,
    cx: &mut App,
) -> Entity<Workbench> {
    log::info!("State Root {}, Runtime Host {}", root.display(), host.profile_id());
    let workbench = (setup.build)(root, host, window, cx);
    workbench.update(cx, |workbench, _| workbench.set_state_root_setup(setup.clone()));
    window.replace_root(cx, |window, cx| crate::window_root(workbench.clone(), window, cx));
    let composer = workbench.read(cx).composer().clone();
    composer.update(cx, |composer, cx| composer.focus(window, cx));
    workbench
}

/// Opens the dialog in `window`. With `current` (the State Root in use) it
/// switches: the folder starts as `current`, and Cancel, Escape, and the
/// close button leave everything as it was. Without it, it is the first
/// launch choice and cannot be dismissed. Enter continues.
pub fn open_state_root_dialog(
    setup: StateRootSetup,
    current: Option<PathBuf>,
    window: &mut Window,
    cx: &mut App,
) -> Entity<StateRootPicker> {
    let dismissible = current.is_some();
    let picker = cx.new(|_| StateRootPicker::new(setup, current));
    let content = picker.clone();
    let width = window.rem_size() * DIALOG_WIDTH_REMS;
    window.open_dialog(cx, move |dialog, _, cx| {
        let confirm = content.clone();
        floating_surface(dialog, cx)
            .with_header(DialogHeader::new(copy::STATE_ROOT_TITLE.get(cx)).closable(dismissible))
            .w(width)
            .overlay_closable(dismissible)
            .on_ok(move |_, window, cx| {
                confirm.update(cx, |picker, cx| picker.confirm(window, cx));
                // The picker closes the dialog once the choice is saved.
                false
            })
            .on_cancel(move |_, _, _| dismissible)
            .child(content.clone())
            .child(shared::dialog::dialog_end())
    });
    picker
}

/// The dialog's content: the folder, a way to choose another, and Continue.
/// It owns the choice until Continue has remembered it.
pub struct StateRootPicker {
    setup: StateRootSetup,
    /// The State Root in use when switching.
    current: Option<PathBuf>,
    path: PathBuf,
    error: Option<SharedString>,
    saving: bool,
    _prompt: Option<Task<()>>,
    _save: Option<Task<()>>,
}

impl std::fmt::Debug for StateRootPicker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StateRootPicker")
            .field("path", &self.path)
            .field("saving", &self.saving)
            .finish_non_exhaustive()
    }
}

impl StateRootPicker {
    fn new(setup: StateRootSetup, current: Option<PathBuf>) -> Self {
        let path = current.clone().unwrap_or_else(|| setup.proposal.clone());
        Self { setup, current, path, error: None, saving: false, _prompt: None, _save: None }
    }

    /// The folder Continue would use.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Why the last Continue did not go through.
    pub fn error(&self) -> Option<&SharedString> {
        self.error.as_ref()
    }

    fn dismissible(&self) -> bool {
        self.current.is_some()
    }

    /// Asks for a folder with the platform dialog.
    pub fn choose_folder(&mut self, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some(copy::FOLDER_CHOOSE_BUTTON.get(cx).into()),
        });
        self._prompt = Some(cx.spawn(async move |this, cx| {
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
            this.update(cx, |this, cx| {
                this.path = path;
                this.error = None;
                cx.notify();
            })
            .ok();
        }));
    }

    /// Checks the folder, remembers it, closes the dialog, and opens the
    /// window on it. A folder that is already in use just closes the dialog.
    pub fn confirm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        if let Err(error) = check_state_root_choice(&self.path, self.setup.desktop_data.as_deref())
        {
            self.error = Some(match error {
                StateRootChoiceError::DesktopData(_) => {
                    copy::STATE_ROOT_DESKTOP_REFUSED.get(cx).into()
                }
                other => other.to_string().into(),
            });
            cx.notify();
            return;
        }
        if self.current.as_deref() == Some(self.path.as_path()) {
            window.close_dialog(cx);
            return;
        }
        self.saving = true;
        self.error = None;
        let path = self.path.clone();
        let remember = self.setup.store.remember(path.clone());
        self._save = Some(cx.spawn_in(window, async move |this, cx| {
            let remembered = remember.await;
            this.update_in(cx, |this, window, cx| {
                this.saving = false;
                match remembered {
                    Ok(()) => {
                        window.close_dialog(cx);
                        show_workbench(&this.setup, path, window, cx);
                    }
                    Err(error) => {
                        log::warn!("could not remember the State Root: {error}");
                        let locale = Locale::current(cx);
                        let what = copy::STATE_ROOT_SAVE_FAILED.in_locale(locale);
                        this.error = Some(copy::failure(locale, what, &error.to_string()).into());
                        cx.notify();
                    }
                }
            })
            .ok();
        }));
        cx.notify();
    }

    /// Leaves everything as it was, when switching.
    pub fn cancel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.dismissible() && !self.saving {
            window.close_dialog(cx);
        }
    }
}

impl Render for StateRootPicker {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let path: SharedString = self.path.display().to_string().into();
        let error = self.error.clone().map(|error| {
            div()
                .id("state-root-error")
                .test_support()
                .aria_label(error.clone())
                .text_sm()
                .text_color(cx.theme().danger)
                .child(error)
        });
        v_flex()
            .id("state-root-picker")
            .test_support()
            .gap_4()
            .child(
                div()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child(copy::STATE_ROOT_HINT.get(cx)),
            )
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        div()
                            .id("state-root-path")
                            .test_support()
                            .aria_label(copy::labeled(
                                Locale::current(cx),
                                copy::STATE_ROOT_FOLDER.get(cx),
                                &path,
                            ))
                            .flex_1()
                            .min_w_0()
                            .px_3()
                            .py_2()
                            .rounded(cx.theme().radius)
                            .border_1()
                            .border_color(cx.theme().border)
                            .font_family(cx.theme().mono_font_family.clone())
                            .text_sm()
                            .child(path),
                    )
                    .child(
                        quiet_button(Button::new("state-root-choose"), cx)
                            .label(copy::STATE_ROOT_CHOOSE.get(cx))
                            .disabled(self.saving)
                            .on_click(cx.listener(|this, _, _, cx| this.choose_folder(cx))),
                    ),
            )
            .children(error)
            .child(
                h_flex()
                    .justify_end()
                    .gap_2()
                    .when(self.dismissible(), |this| {
                        this.child(
                            quiet_button(Button::new("state-root-cancel"), cx)
                                .label(copy::CANCEL.get(cx))
                                .disabled(self.saving)
                                .on_click(
                                    cx.listener(|this, _, window, cx| this.cancel(window, cx)),
                                ),
                        )
                    })
                    .child(
                        control_button(Button::new("state-root-continue").primary())
                            .label(copy::CONTINUE.get(cx))
                            .loading(self.saving)
                            .on_click(cx.listener(|this, _, window, cx| this.confirm(window, cx))),
                    ),
            )
    }
}

/// The window's content until its State Root is known: the window chrome, so
/// the first-launch dialog has a window to open in (`Root` draws it above).
#[derive(Debug, Default)]
pub struct StartupView;

impl Render for StartupView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // The bare canvas the Workbench's plate will sit on, and a band that
        // moves the window.
        let maka = cx.maka();
        v_flex()
            .id("startup")
            .test_support()
            .size_full()
            .bg(maka.canvas)
            .text_color(maka.ink)
            .child(TitleBar::new().h(rems(CHROME_HEIGHT_REMS)).bg(maka.canvas).border_b_0())
    }
}
