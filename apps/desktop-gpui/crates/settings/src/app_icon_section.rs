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

//! The Appearance page's App icon section, as Maka Desktop draws it
//! (appearance-settings-page.tsx): "Import icon…" at the heading's end,
//! the switch for a separate dark-mode icon (with Light / Dark for the slot
//! the grid edits while it is on), then the shipped icons in Desktop's
//! groups and the imported ones after them, each a card with its 48px
//! thumbnail, its name, and its line; an imported one also has Remove.
//! Desktop's toasts are the section's status line here.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use gpui_kit::component::button::Button;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{Disableable as _, StyledExt as _, h_flex, v_flex};
use gpui_kit::{
    App, AppContext as _, Context, InteractiveElement as _, IntoElement, ParentElement as _,
    PathPromptOptions, Pixels, Render, RenderImage, Role, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Task, TestSupportExt as _, Window, div, img,
    point, px, rems,
};
use shared::copy::appearance as copy;
use shared::copy::{Locale, Text, phrases};
use shared::domain_element_id;
use shared::theme::FadedSwitch;
use shared::theme::{ActiveMakaPalette as _, quiet_button, segment, segmented_track};

use crate::app_icon::{
    APP_ICON_GROUPS, AppIcon, AppIconChoice, AppIconTarget, CustomIconId, CustomIcons,
    DEFAULT_APP_ICON_DARK, custom_icons,
};
use crate::page_kit::selectable_card;
use crate::preferences::AppPreferences;
use crate::rows::{SettingsGroup, SettingsRow, StatusLine, settings_button};

/// Desktop's card grid (`columns={{ minWidth: 180 }}`) at the page's width.
const COLUMNS: u16 = 4;
/// The card's thumbnail: Desktop's 48px.
const THUMBNAIL_REMS: f32 = 3.;
/// The icon's body inside a shipped thumbnail, after Apple's icon grid:
/// 12 of its 128 px clear on each side, the corners about 23% of the
/// body's edge (measured on `assets/app-icons/thumbnails`).
const BODY_INSET: f32 = 12. / 128.;
const BODY_RADIUS: f32 = 0.23;

/// The slot the grid edits while the two appearances have their own icons.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Slot {
    Light,
    Dark,
}

/// What is in flight; while anything is, every tile, the switch, and
/// Import wait (Desktop fences the whole set, so a click cannot land
/// between a removal resetting the choice and deleting the art).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Busy {
    Import,
    Select,
    Remove,
}

/// Behavior and presentation owner of the App icon section: the slot being
/// edited, the imported icons and their thumbnails, and the operation in
/// flight. The choice itself lives in [`AppPreferences`], and the Dock
/// follows it there.
pub struct AppIconSection {
    slot: Slot,
    /// Where imported icons live; `None` when the shell installed none,
    /// and then only the shipped set is offered.
    icons: Option<CustomIcons>,
    imported: Vec<(CustomIconId, Arc<RenderImage>)>,
    busy: Option<Busy>,
    note: Option<SharedString>,
    /// Incremented for every read of the imported icons.
    generation: u64,
    /// The page's scroll and the window-space top of each group of icons
    /// as last laid out, so the page can scroll toward the last group for
    /// screenshots (`appearance:app-icon-end`).
    page_scroll: Option<ScrollHandle>,
    group_tops: Rc<RefCell<Vec<Pixels>>>,
    _read: Option<Task<()>>,
    _operation: Option<Task<()>>,
}

impl std::fmt::Debug for AppIconSection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppIconSection")
            .field("slot", &self.slot)
            .field("imported", &self.imported.len())
            .finish_non_exhaustive()
    }
}

impl AppIconSection {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let preferences = AppPreferences::global(cx);
        cx.observe(&preferences, |_, _, cx| cx.notify()).detach();
        let mut this = Self {
            slot: Slot::Light,
            icons: custom_icons(cx),
            imported: Vec::new(),
            busy: None,
            note: None,
            generation: 0,
            page_scroll: None,
            group_tops: Rc::default(),
            _read: None,
            _operation: None,
        };
        this.read_imported(cx);
        this
    }

    /// Lets [`Self::scroll_to_end`] scroll the page `page_scroll` scrolls.
    pub(crate) fn with_page_scroll(mut self, page_scroll: ScrollHandle) -> Self {
        self.page_scroll = Some(page_scroll);
        self
    }

    /// Scrolls the page as far toward the last group of icons as a group's
    /// header can still sit first under the page's top edge. The page's
    /// end stops the scroll short of the last group, so scrolling to that
    /// group cut through the one above it (review round 16).
    pub(crate) fn scroll_to_end(&self) {
        let Some(scroll) = &self.page_scroll else {
            return;
        };
        let (viewport, offset, max) = (scroll.bounds(), scroll.offset(), scroll.max_offset());
        let tops = self.group_tops.borrow();
        // Each group's top in the page's content, unscrolled; the deepest
        // the scroll reaches.
        let reachable = tops
            .iter()
            .rev()
            .map(|top| *top - viewport.top() - offset.y)
            .find(|top| *top <= max.y + px(0.5));
        if let Some(top) = reachable {
            scroll.set_offset(point(offset.x, -top));
        }
    }

    /// The icons imported, oldest first.
    pub fn imported(&self) -> Vec<CustomIconId> {
        self.imported.iter().map(|(id, _)| *id).collect()
    }

    /// Whether an import, a removal, or a check of a selection is in flight.
    pub fn is_busy(&self) -> bool {
        self.busy.is_some()
    }

    /// Reads the imported icons and their thumbnails in the background.
    fn read_imported(&mut self, cx: &mut Context<Self>) {
        let Some(icons) = self.icons.clone() else {
            return;
        };
        self.generation += 1;
        let generation = self.generation;
        let read = cx.background_spawn(async move {
            icons.list().into_iter().filter_map(|id| Some((id, icons.thumbnail(id)?))).collect()
        });
        self._read = Some(cx.spawn(async move |this, cx| {
            let imported: Vec<(CustomIconId, Arc<RenderImage>)> = read.await;
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                let old = std::mem::replace(&mut this.imported, imported);
                for (_, thumbnail) in old {
                    cx.drop_image(thumbnail, None);
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Where a choice goes: one icon everywhere, or the slot being edited.
    fn target(&self, cx: &Context<Self>) -> AppIconTarget {
        if AppPreferences::current(cx).app_icon_dark.is_none() {
            return AppIconTarget::Both;
        }
        match self.slot {
            Slot::Light => AppIconTarget::Light,
            Slot::Dark => AppIconTarget::Dark,
        }
    }

    /// The icon the grid shows as chosen: the edited slot's.
    fn edited(&self, cx: &Context<Self>) -> AppIconChoice {
        let preferences = AppPreferences::current(cx);
        match (self.slot, preferences.app_icon_dark) {
            (Slot::Dark, Some(dark)) => dark,
            _ => preferences.app_icon,
        }
    }

    /// Chooses `icon` for the edited slot. An imported one must still be
    /// there (Desktop's `missing_artwork`).
    pub fn select(&mut self, icon: AppIconChoice, cx: &mut Context<Self>) {
        if self.busy.is_some() {
            return;
        }
        self.note = None;
        let target = self.target(cx);
        let (AppIconChoice::Custom(id), Some(icons)) = (icon, self.icons.clone()) else {
            write_icon(icon, target, cx);
            cx.notify();
            return;
        };
        self.busy = Some(Busy::Select);
        let present = cx.background_spawn(async move { icons.list().contains(&id) });
        self._operation = Some(cx.spawn(async move |this, cx| {
            let present = present.await;
            this.update(cx, |this, cx| {
                this.busy = None;
                if present {
                    write_icon(icon, target, cx);
                } else {
                    this.note = Some(copy::APP_ICON_SELECT_FAILED.get(cx).into());
                    this.read_imported(cx);
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Turns the separate dark-mode icon on (the dark slot starts on
    /// Desktop's dark recommendation, and the grid edits it) or off (one
    /// icon everywhere, the light one).
    pub fn set_split(&mut self, on: bool, cx: &mut Context<Self>) {
        if self.busy.is_some() {
            return;
        }
        let light = AppPreferences::current(cx).app_icon;
        if on {
            self.slot = Slot::Dark;
            write_icon(DEFAULT_APP_ICON_DARK.into(), AppIconTarget::Dark, cx);
        } else {
            self.slot = Slot::Light;
            write_icon(light, AppIconTarget::Both, cx);
        }
        cx.notify();
    }

    /// Which slot the grid edits while the split is on.
    pub(crate) fn edit_slot(&mut self, slot: Slot, cx: &mut Context<Self>) {
        self.slot = slot;
        cx.notify();
    }

    /// "Import icon…": asks for a PNG or JPEG, imports it, and chooses it
    /// for the edited slot, as clicking its tile would. Closing the dialog
    /// is an answer, not a failure.
    pub fn import(&mut self, cx: &mut Context<Self>) {
        let Some(icons) = self.icons.clone() else {
            return;
        };
        if self.busy.is_some() {
            return;
        }
        self.busy = Some(Busy::Import);
        self.note = None;
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(shared::copy::FOLDER_CHOOSE_BUTTON.get(cx).into()),
        });
        self._operation = Some(cx.spawn(async move |this, cx| {
            let path = match paths.await {
                Ok(Ok(Some(paths))) => paths.into_iter().next(),
                Ok(Err(error)) => {
                    log::warn!("the icon dialog failed: {error:#}");
                    None
                }
                _ => None,
            };
            let Some(path) = path else {
                this.update(cx, |this, cx| {
                    this.busy = None;
                    cx.notify();
                })
                .ok();
                return;
            };
            let imported = cx.background_spawn(async move { icons.import(&path) }).await;
            this.update(cx, |this, cx| {
                this.busy = None;
                match imported {
                    Ok(id) => {
                        let target = this.target(cx);
                        write_icon(AppIconChoice::Custom(id), target, cx);
                        this.read_imported(cx);
                    }
                    Err(reason) => {
                        let locale = Locale::current(cx);
                        let why = reason.text().in_locale(locale);
                        this.note = Some(toast_line(locale, copy::APP_ICON_IMPORT_ERROR, why));
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Removes an imported icon: the choice lets go of it first, then its
    /// art is deleted.
    pub fn remove(&mut self, id: CustomIconId, cx: &mut Context<Self>) {
        let Some(icons) = self.icons.clone() else {
            return;
        };
        if self.busy.is_some() {
            return;
        }
        self.busy = Some(Busy::Remove);
        self.note = None;
        AppPreferences::global(cx).update(cx, |preferences, cx| {
            preferences.forget_app_icon(AppIconChoice::Custom(id), cx)
        });
        let removed = cx.background_spawn(async move { icons.remove(id) });
        self._operation = Some(cx.spawn(async move |this, cx| {
            let removed = removed.await;
            this.update(cx, |this, cx| {
                this.busy = None;
                if let Err(error) = removed {
                    log::warn!("could not remove an imported icon: {error}");
                    this.note = Some(copy::APP_ICON_REMOVE_FAILED.get(cx).into());
                }
                this.read_imported(cx);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn render_card(
        &self,
        choice: AppIconChoice,
        thumbnail: gpui_kit::ImageSource,
        selected: bool,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Div {
        let maka = cx.maka();
        let (label, line) = match choice {
            AppIconChoice::Shipped(icon) => {
                let (label, line) = icon.copy();
                (label.get(cx), line.get(cx))
            }
            AppIconChoice::Custom(_) => {
                (copy::APP_ICON_CUSTOM.get(cx), copy::APP_ICON_CUSTOM_HELP.get(cx))
            }
        };
        let busy = self.busy.is_some();
        let remove = match choice {
            AppIconChoice::Custom(id) => Some(
                quiet_button(
                    Button::new(domain_element_id("settings-app-icon-remove", &id.hex())),
                    cx,
                )
                .flex_shrink_0()
                .label(copy::APP_ICON_REMOVE.get(cx))
                .disabled(busy)
                .on_click(cx.listener(move |this, _, _, cx| {
                    // The tile is a radio; removing is not choosing it.
                    cx.stop_propagation();
                    this.remove(id, cx);
                })),
            ),
            AppIconChoice::Shipped(_) => None,
        };
        let button = Button::new(domain_element_id("settings-app-icon", &choice.key()))
            .p_2()
            .justify_start()
            .accessibility_label(label)
            .toggled(selected)
            .disabled(busy)
            .on_click(cx.listener(move |this, _, _, cx| this.select(choice, cx)))
            .child(
                // Desktop's card: the thumbnail and the two lines centred
                // on the card (`HStack align="center"`); every line fits
                // two lines at the page's width.
                h_flex()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .items_center()
                    .gap_2()
                    .whitespace_normal()
                    .child(thumbnail_tile(
                        thumbnail,
                        matches!(choice, AppIconChoice::Custom(_)),
                        cx,
                    ))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .items_start()
                            .gap_0p5()
                            .child(div().text_sm().font_medium().text_color(maka.ink).child(label))
                            .child(
                                div()
                                    .text_xs()
                                    .line_height(rems(1.25))
                                    .text_color(maka.ink_muted)
                                    .child(line),
                            ),
                    )
                    .children(remove),
            );
        selectable_card(button, selected, cx)
    }

    fn render_group(
        &self,
        key: &'static str,
        label: SharedString,
        cards: Vec<gpui_kit::Div>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        v_flex()
            .gap_1p5()
            .child(
                div()
                    .id(domain_element_id("settings-app-icon-group", key))
                    .test_support()
                    .aria_label(label.clone())
                    .text_xs()
                    .font_medium()
                    .text_color(cx.maka().ink_muted)
                    .child(label),
            )
            .child(
                div()
                    .id(domain_element_id("settings-app-icons", key))
                    .test_support()
                    .role(Role::RadioGroup)
                    .w_full()
                    .grid()
                    .grid_cols(COLUMNS)
                    .gap_2()
                    .children(cards),
            )
    }

    fn render_split(&self, cx: &mut Context<Self>) -> SettingsRow {
        let split = AppPreferences::current(cx).app_icon_dark.is_some();
        let busy = self.busy.is_some();
        let title = copy::APP_ICON_SPLIT.get(cx);
        // Which slot the grid edits: one control rather than a second grid
        // (Desktop's reason: 43 tiles twice over is a wall).
        let slots = split.then(|| {
            segmented_track(cx)
                .id("settings-app-icon-slot")
                .aria_label(title)
                .flex_shrink_0()
                .children(
                    [
                        (Slot::Light, copy::APP_ICON_TARGET_LIGHT),
                        (Slot::Dark, copy::APP_ICON_TARGET_DARK),
                    ]
                    .map(|(slot, label)| {
                        let key = if slot == Slot::Light { "light" } else { "dark" };
                        let button = Button::new(domain_element_id("settings-app-icon-slot", key));
                        segment(button, label.get(cx), self.slot == slot, cx)
                            .flex_none()
                            .px_3()
                            .on_click(cx.listener(move |this, _, _, cx| this.edit_slot(slot, cx)))
                    }),
                )
        });
        let switch = {
            let (checked, disabled) = (split, busy);
            FadedSwitch::new(
                Switch::new("settings-toggle:app-icon-split")
                    .checked(checked)
                    .disabled(disabled)
                    .accessibility_label(title)
                    .on_change(cx.listener(|this, on: &bool, _, cx| this.set_split(*on, cx))),
                checked,
                disabled,
            )
        };
        SettingsRow::new("app-icon-split", title)
            .detail(copy::APP_ICON_SPLIT_HELP.get(cx))
            .end(h_flex().gap_3().children(slots).child(switch))
    }
}

/// A Desktop toast as a status line: its title, then its description as a
/// sentence of its own.
pub(crate) fn toast_line(locale: Locale, title: Text, description: &str) -> SharedString {
    let ended = description.ends_with(['.', '!', '?', '。', '！', '？']);
    let period = if locale == Locale::English { "." } else { "。" };
    let description = if ended { description.to_owned() } else { format!("{description}{period}") };
    phrases(locale, title.in_locale(locale), &description).into()
}

/// Writes `icon` for `target` into the preferences.
fn write_icon(icon: AppIconChoice, target: AppIconTarget, cx: &mut Context<AppIconSection>) {
    AppPreferences::global(cx)
        .update(cx, |preferences, cx| preferences.set_app_icon(icon, target, cx));
}

impl Render for AppIconSection {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let edited = self.edited(cx);
        let mut groups: Vec<gpui_kit::AnyElement> = APP_ICON_GROUPS
            .iter()
            .map(|(key, label, icons)| {
                let cards = icons
                    .iter()
                    .map(|icon| {
                        let choice = AppIconChoice::Shipped(*icon);
                        self.render_card(choice, icon.thumbnail().into(), edited == choice, cx)
                    })
                    .collect();
                self.render_group(key, label.get(cx).into(), cards, cx).into_any_element()
            })
            .collect();
        if !self.imported.is_empty() {
            let cards = self
                .imported
                .iter()
                .map(|(id, thumbnail)| {
                    let choice = AppIconChoice::Custom(*id);
                    self.render_card(choice, thumbnail.clone().into(), edited == choice, cx)
                })
                .collect();
            groups.push(
                self.render_group("custom", copy::GROUP_CUSTOM.get(cx).into(), cards, cx)
                    .into_any_element(),
            );
        }
        let import = self.icons.is_some().then(|| {
            let label = if self.busy == Some(Busy::Import) {
                copy::APP_ICON_IMPORTING
            } else {
                copy::APP_ICON_IMPORT
            };
            settings_button("settings-app-icon-import", label.get(cx), cx)
                .disabled(self.busy.is_some())
                .on_click(cx.listener(|this, _, _, cx| this.import(cx)))
        });
        let status = self.note.clone().map(|note| StatusLine::error("app-icon", note));
        let mut group = SettingsGroup::new("app-icon")
            .title(copy::APP_ICON.get(cx))
            .description(copy::APP_ICON_HELP.get(cx))
            .bare();
        if let Some(import) = import {
            group = group.action(import);
        }
        // What an import takes closes the section, 12 under the last group
        // of icons, as Desktop's `appIconImportHelp` does.
        let import_help = self.icons.is_some().then(|| {
            div()
                .id("settings-app-icon-import-help")
                .test_support()
                .aria_label(copy::APP_ICON_IMPORT_HELP.get(cx))
                .text_xs()
                .line_height(rems(1.25))
                .text_color(cx.maka().ink_muted)
                .child(copy::APP_ICON_IMPORT_HELP.get(cx))
        });
        let tops = self.group_tops.clone();
        group.child(
            v_flex()
                .gap_3()
                .child(self.render_split(cx))
                .children(status)
                .child(v_flex().gap_3().children(groups).on_children_prepainted(
                    move |bounds, _, _| {
                        *tops.borrow_mut() = bounds.iter().map(|group| group.top()).collect();
                    },
                ))
                .children(import_help),
        )
    }
}

/// A thumbnail on its card: the icon with a `border_soft` ring on its
/// body's edge, so a white icon (纸白, 单色·黑) still has one on the white
/// card. An imported icon is a full square: it is drawn in the body's
/// place and rounding, as the shipped ones are.
fn thumbnail_tile(thumbnail: gpui_kit::ImageSource, custom: bool, cx: &App) -> impl IntoElement {
    let inset = rems(THUMBNAIL_REMS * BODY_INSET);
    let body = THUMBNAIL_REMS * (1. - 2. * BODY_INSET);
    let radius = rems(body * BODY_RADIUS);
    let art = if custom {
        img(thumbnail).absolute().top(inset).left(inset).size(rems(body)).rounded(radius)
    } else {
        img(thumbnail).absolute().size_full()
    };
    // The art's visible edge, not the tile's transparent margin, sits on
    // the card's 8px padding and 8px from the text (Desktop's 8 and 8).
    div().relative().flex_shrink_0().size(rems(THUMBNAIL_REMS)).m(-inset).child(art).child(
        div()
            .absolute()
            .top(inset)
            .left(inset)
            .size(rems(body))
            .rounded(radius)
            .border_1()
            .border_color(cx.maka().border_soft),
    )
}

impl AppIcon {
    /// The card's element id in the picker.
    #[cfg(test)]
    pub(crate) fn card(self) -> gpui_kit::ElementId {
        domain_element_id("settings-app-icon", self.id())
    }
}
