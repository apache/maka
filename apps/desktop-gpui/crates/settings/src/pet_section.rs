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

//! The Appearance page's Custom pets section, as Maka Desktop draws it
//! (custom-pet-settings-section.tsx, custom-pet-library-model.ts, the
//! `pets:*` handlers of apps/desktop/src/main/pet-pack-import.ts): "Import
//! PetPack" at the heading's end, the Desktop pet row saying which pet is in
//! use (with Turn off pet), then each pack in the State Root's library with
//! Use and Remove. Removing asks first. Importing never chooses the pack:
//! import and use stay two choices, as in Desktop. Desktop's toasts are the
//! section's status line here.

use std::path::PathBuf;

use gpui_kit::component::{Disableable as _, WindowExt as _, h_flex};
use gpui_kit::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, PathPromptOptions, Render,
    SharedString, Styled as _, Task, Window,
};
use pet::{
    PetImportFailure, PetPackId, PetPackManifest, PetPackStore, PetPackStoreError,
    import_from_directory,
};
use shared::copy::appearance as copy;
use shared::copy::{Locale, Text};
use shared::dialog::{DialogHeader, DialogHeaderExt as _};
use shared::domain_element_id;
use shared::theme::floating_surface;
use workspace::HostSession;

use crate::app_icon_section::toast_line;
use crate::page_kit::compact_empty_state;
use crate::preferences::AppPreferences;
use crate::rows::{SettingsGroup, SettingsRow, StatusLine, settings_button};

/// What is in flight (Desktop's `PetMutation`); while anything is, every
/// action waits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mutation {
    Import,
    Select(PetPackId),
    Remove(PetPackId),
}

/// Desktop's words for an import failure (`importErrors`).
fn import_failure(reason: PetImportFailure) -> Text {
    match reason {
        PetImportFailure::InvalidDirectory => copy::PET_INVALID_DIRECTORY,
        PetImportFailure::InvalidManifest => copy::PET_INVALID_MANIFEST,
        PetImportFailure::InvalidAsset => copy::PET_INVALID_ASSET,
        PetImportFailure::AlreadyInstalled => copy::PET_ALREADY_INSTALLED,
        _ => copy::PET_READ_FAILED,
    }
}

/// `reconcileCustomPetLibrary`: one entry per id, in the library's order.
fn reconcile(manifests: Vec<PetPackManifest>) -> Vec<PetPackManifest> {
    let mut seen = std::collections::HashSet::new();
    manifests.into_iter().filter(|manifest| seen.insert(manifest.id())).collect()
}

/// Behavior and presentation owner of the Custom pets section: the
/// library as last read (the authority for what can be chosen), the
/// operation in flight, and the last failure. The choice itself is the
/// client preference [`crate::Preferences::selected_pet`], which the shell
/// hands to the companion.
pub struct PetSection {
    store: PetPackStore,
    pets: Vec<PetPackManifest>,
    loading: bool,
    mutation: Option<Mutation>,
    note: Option<SharedString>,
    /// Incremented for every read of the library.
    generation: u64,
    _read: Option<Task<()>>,
    _mutation: Option<Task<()>>,
}

impl std::fmt::Debug for PetSection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PetSection")
            .field("library", &self.store.root())
            .field("pets", &self.pets.len())
            .finish_non_exhaustive()
    }
}

impl PetSection {
    /// The section over the library of `host`'s State Root.
    pub fn new(host: &Entity<HostSession>, cx: &mut Context<Self>) -> Self {
        let store = PetPackStore::new(host.read(cx).root().to_owned());
        cx.observe(&AppPreferences::global(cx), |_, _, cx| cx.notify()).detach();
        let mut this = Self {
            store,
            pets: Vec::new(),
            loading: true,
            mutation: None,
            note: None,
            generation: 0,
            _read: None,
            _mutation: None,
        };
        this.refresh(true, cx);
        this
    }

    /// The packs listed, in the library's order.
    pub fn pets(&self) -> &[PetPackManifest] {
        &self.pets
    }

    pub fn is_loading(&self) -> bool {
        self.loading
    }

    /// The pet in use, when the library holds it.
    fn selected(&self, cx: &Context<Self>) -> Option<&PetPackManifest> {
        let selected = AppPreferences::current(cx).selected_pet?;
        self.pets.iter().find(|pet| pet.id() == selected)
    }

    /// Reads the library again. A selection naming a pack the library no
    /// longer holds is cleared (`resolveSelectedPetId`); a failed read is
    /// shown when `report` (the first read, as Desktop's `reportError`).
    fn refresh(&mut self, report: bool, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        let store = self.store.clone();
        let read = cx.background_spawn(async move { store.list() });
        self._read = Some(cx.spawn(async move |this, cx| {
            let listed = read.await;
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.loading = false;
                match listed {
                    Ok(pets) => {
                        this.pets = reconcile(pets);
                        let selected = AppPreferences::current(cx).selected_pet;
                        if selected.is_some_and(|id| this.pets.iter().all(|pet| pet.id() != id)) {
                            select_pet(None, cx);
                        }
                    }
                    Err(error) if report => this.note = Some(read_failure(&error, cx)),
                    Err(error) => log::warn!("could not read the pet library: {error}"),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// "Import PetPack": asks for a folder and installs the pack in it.
    pub fn import(&mut self, cx: &mut Context<Self>) {
        if self.loading || self.mutation.is_some() {
            return;
        }
        self.mutation = Some(Mutation::Import);
        self.note = None;
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some(shared::copy::FOLDER_CHOOSE_BUTTON.get(cx).into()),
        });
        let store = self.store.clone();
        self._mutation = Some(cx.spawn(async move |this, cx| {
            let folder: Option<PathBuf> = match paths.await {
                Ok(Ok(Some(paths))) => paths.into_iter().next(),
                Ok(Err(error)) => {
                    log::warn!("the folder dialog failed: {error:#}");
                    None
                }
                _ => None,
            };
            let imported = match folder {
                Some(folder) => Some(
                    cx.background_spawn(async move { import_from_directory(&folder, &store) })
                        .await,
                ),
                // Closing the dialog is an answer, not a failure.
                None => None,
            };
            this.update(cx, |this, cx| {
                this.mutation = None;
                if let Some(Err(reason)) = &imported {
                    let locale = Locale::current(cx);
                    let why = import_failure(*reason).in_locale(locale);
                    this.note = Some(toast_line(locale, copy::PET_IMPORT_FAILED, why));
                }
                if imported.is_some() {
                    this.refresh(false, cx);
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Uses the pack `id` (`pets:select`): it must still be in the library.
    pub fn select(&mut self, id: PetPackId, cx: &mut Context<Self>) {
        if self.loading || self.mutation.is_some() {
            return;
        }
        self.mutation = Some(Mutation::Select(id));
        self.note = None;
        let store = self.store.clone();
        let found = cx.background_spawn(async move { store.get(id) });
        self._mutation = Some(cx.spawn(async move |this, cx| {
            let found = found.await;
            this.update(cx, |this, cx| {
                this.mutation = None;
                let reason = match found {
                    Ok(Some(_)) => {
                        select_pet(Some(id), cx);
                        None
                    }
                    Ok(None) => Some(copy::PET_NOT_FOUND),
                    Err(error) => {
                        log::warn!("could not read the pet library: {error}");
                        Some(copy::PET_LIBRARY_UNREADABLE)
                    }
                };
                if let Some(reason) = reason {
                    let locale = Locale::current(cx);
                    let why = reason.in_locale(locale);
                    this.note = Some(toast_line(locale, copy::PET_SELECT_FAILED, why));
                }
                this.refresh(false, cx);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// "Turn off pet".
    pub fn disable(&mut self, cx: &mut Context<Self>) {
        if self.loading || self.mutation.is_some() {
            return;
        }
        self.note = None;
        select_pet(None, cx);
        cx.notify();
    }

    /// Asks before removing the pack `id`: an alert naming it and saying
    /// the original folder stays; Remove removes, Cancel and Escape keep it.
    pub fn confirm_remove(&mut self, id: PetPackId, window: &mut Window, cx: &mut Context<Self>) {
        if self.loading || self.mutation.is_some() || window.has_active_dialog(cx) {
            return;
        }
        let Some(pet) = self.pets.iter().find(|pet| pet.id() == id) else {
            return;
        };
        let locale = Locale::current(cx);
        let title: SharedString = copy::remove_pet_title(locale, pet.display_name()).into();
        let section = cx.weak_entity();
        window.open_alert_dialog(cx, move |alert, _, cx| {
            let section = section.clone();
            floating_surface(alert, cx)
                .with_header(DialogHeader::new(title.clone()))
                .description(shared::dialog::confirmation_text(
                    copy::PET_REMOVE_DESCRIPTION.in_locale(locale),
                ))
                .footer(shared::dialog::confirmation_answers(
                    shared::copy::CANCEL.in_locale(locale),
                    copy::PET_REMOVE.in_locale(locale),
                    true,
                    cx,
                ))
                .on_ok(move |_, _, cx| {
                    section.update(cx, |this, cx| this.remove(id, cx)).ok();
                    true
                })
        });
    }

    /// Removes the pack `id` (asked first, [`Self::confirm_remove`]) and
    /// lets go of it if it was in use.
    pub fn remove(&mut self, id: PetPackId, cx: &mut Context<Self>) {
        if self.mutation.is_some() {
            return;
        }
        self.mutation = Some(Mutation::Remove(id));
        self.note = None;
        let store = self.store.clone();
        let removed = cx.background_spawn(async move { store.remove(id) });
        self._mutation = Some(cx.spawn(async move |this, cx| {
            let removed = removed.await;
            this.update(cx, |this, cx| {
                this.mutation = None;
                match removed {
                    Ok(removed) => {
                        if removed && AppPreferences::current(cx).selected_pet == Some(id) {
                            select_pet(None, cx);
                        }
                    }
                    Err(error) => {
                        log::warn!("could not remove the pet {id}: {error}");
                        let locale = Locale::current(cx);
                        let why = copy::PET_PACK_NOT_REMOVED.in_locale(locale);
                        this.note = Some(toast_line(locale, copy::PET_REMOVE_FAILED, why));
                    }
                }
                this.refresh(false, cx);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn render_pet(&self, pet: &PetPackManifest, cx: &mut Context<Self>) -> SettingsRow {
        let id = pet.id();
        let selected = AppPreferences::current(cx).selected_pet == Some(id);
        let disabled = self.loading || self.mutation.is_some();
        // In use, its description, its id (Desktop's joined line).
        let detail: Vec<&str> =
            [selected.then(|| copy::PET_SELECTED.get(cx)), pet.description(), Some(id.as_str())]
                .into_iter()
                .flatten()
                .collect();
        let select = (!selected).then(|| {
            let label = if self.mutation == Some(Mutation::Select(id)) {
                copy::PET_SELECTING
            } else {
                copy::PET_SELECT
            };
            settings_button(domain_element_id("settings-pet-use", id.as_str()), label.get(cx), cx)
                .disabled(disabled)
                .on_click(cx.listener(move |this, _, _, cx| this.select(id, cx)))
        });
        let remove_label = if self.mutation == Some(Mutation::Remove(id)) {
            copy::PET_REMOVING
        } else {
            copy::PET_REMOVE
        };
        let remove = settings_button(
            domain_element_id("settings-pet-remove", id.as_str()),
            remove_label.get(cx),
            cx,
        )
        .disabled(disabled)
        .on_click(cx.listener(move |this, _, window, cx| this.confirm_remove(id, window, cx)));
        SettingsRow::new(format!("pet:{id}"), pet.display_name().to_owned())
            .detail(detail.join(" · "))
            .end(h_flex().gap_2().children(select).child(remove))
    }
}

/// Writes the pet in use into the preferences.
fn select_pet(pet: Option<PetPackId>, cx: &mut Context<PetSection>) {
    AppPreferences::global(cx).update(cx, |preferences, cx| preferences.set_selected_pet(pet, cx));
}

/// "Could not load custom pets", then the library's reason.
fn read_failure(error: &PetPackStoreError, cx: &Context<PetSection>) -> SharedString {
    toast_line(Locale::current(cx), copy::PET_LOAD_FAILED, &error.to_string())
}

impl Render for PetSection {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let locale = Locale::current(cx);
        let busy = self.loading || self.mutation.is_some();
        let selected = self.selected(cx).map(|pet| pet.display_name().to_owned());
        let status_detail: SharedString = if self.loading {
            copy::PET_LOADING.get(cx).into()
        } else if let Some(name) = &selected {
            copy::active_pet(locale, name).into()
        } else {
            copy::PET_DISABLED.get(cx).into()
        };
        let disable = (!self.loading && selected.is_some()).then(|| {
            settings_button("settings-pet-disable", copy::PET_DISABLE.get(cx), cx)
                .disabled(busy)
                .on_click(cx.listener(|this, _, _, cx| this.disable(cx)))
        });
        let mut status = SettingsRow::new("pet-status", copy::PET_STATUS.get(cx))
            .detail(status_detail)
            .status(self.note.clone().map(|note| StatusLine::error("pets", note)));
        if let Some(disable) = disable {
            status = status.end(disable);
        }
        // Desktop's compact `EmptyState`: the loading line alone, or the
        // title over what to import.
        let empty = (self.pets.is_empty()).then(|| {
            if self.loading {
                compact_empty_state("pets-empty", copy::PET_LOADING.get(cx), None, cx)
            } else {
                let help = SharedString::from(copy::PET_EMPTY_HELP.get(cx));
                compact_empty_state("pets-empty", copy::PET_EMPTY.get(cx), Some(help), cx)
            }
        });
        let import_label = if self.mutation == Some(Mutation::Import) {
            copy::PET_IMPORTING
        } else {
            copy::PET_IMPORT
        };
        let import = settings_button("settings-pet-import", import_label.get(cx), cx)
            .disabled(busy)
            .on_click(cx.listener(|this, _, _, cx| this.import(cx)));
        let pets: Vec<SettingsRow> = self.pets.iter().map(|pet| self.render_pet(pet, cx)).collect();
        SettingsGroup::new("pets")
            .title(copy::PETS.get(cx))
            .description(copy::PETS_HELP.get(cx))
            .action(import)
            .child(status)
            .children(empty)
            .children(pets)
    }
}
